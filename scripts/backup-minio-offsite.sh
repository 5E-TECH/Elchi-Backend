#!/bin/sh
#
# Off-site, versioned copy of the MinIO object store (COD / expense evidence,
# photos — bucket `elchi-files`) -> Cloudflare R2, the same bucket / token as
# the DB dumps (scripts/backup-offsite.sh). Card 6RaEn5cN.
#
# POSIX sh: runs in the pinned rclone/rclone image (busybox ash) — started from
# host cron by scripts/backup-minio-offsite-cron.sh (`docker run --rm` on the
# compose network, so `minio:9000` resolves). ONE run per invocation:
#
#   1. per source bucket: count objects in MinIO and in the R2 copy. MinIO
#      empty while R2 still holds objects -> refuse (nothing moved): an empty
#      listing is far more likely a broken MinIO than a real wipe.
#   2. `rclone sync minio:<b> r2:<R2_BUCKET>/minio/<b>/current
#        --backup-dir r2:<R2_BUCKET>/minio/<b>/versions/<UTC run ts>`
#      `current/` mirrors MinIO; an object that was overwritten or deleted in
#      MinIO is MOVED (server side) into `versions/<ts>/` instead of being
#      dropped — that is the versioning (R2 has no object versioning).
#      --checksum (MD5 from the listings), --max-delete caps how many objects
#      one run may move out of current/ (default 50; above it the run fails).
#   3. `rclone check` source vs current/ (size + MD5) — differences fail the run.
#   4. only if 1-3 passed: purge `versions/<ts>/` folders whose timestamp is
#      older than MINIO_OFFSITE_VERSIONS_DAYS (90). Age comes from the folder
#      NAME (the run that moved the object there), never from object mtimes.
#   5. one log line + key=value status file ($MINIO_OFFSITE_STATE_DIR/status)
#      that `--check` (host alert, scripts/backup-alert.sh) reads.
#
# Temporary AI-parse images (`ai-tmp/` at the bucket root — customer photos
# kept at most 1 h, deleted as soon as ai-service reads them; WHMAIqyo) are
# NEVER copied off-site: every count / sync / check / size runs with
# `--exclude '/ai-tmp/**'` (MO_EXCLUDE).
#
# MinIO is read with a dedicated READ-ONLY MinIO user (policy: ListBucket +
# GetObject + GetBucketLocation on the source bucket) — MINIO_BACKUP_ACCESS_KEY
# / MINIO_BACKUP_SECRET_KEY — never the root or the app (readwrite) key.
# Encryption: TLS to R2 + R2 at-rest encryption (same as the DB dump copies);
# the R2 token is "Object Read & Write" on this one bucket only.
#
# rclone is configured ONLY through environment variables (RCLONE_CONFIG="",
# RCLONE_CONFIG_R2_* / RCLONE_CONFIG_MINIO_*). Secrets are never printed.
#
# Env:
#   R2_ACCOUNT_ID / R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
#                                  same keys as backup-offsite (.env.production)
#   MINIO_BACKUP_ACCESS_KEY        read-only MinIO user (access key)
#   MINIO_BACKUP_SECRET_KEY        read-only MinIO user (secret)
#   MINIO_ENDPOINT / MINIO_PORT / MINIO_USE_SSL   MinIO address (default minio:9000, http)
#   MINIO_OFFSITE_BUCKETS          source buckets, space separated (default $MINIO_BUCKET or elchi-files)
#   MINIO_OFFSITE_PREFIX           R2 prefix (default minio)
#   MINIO_OFFSITE_VERSIONS_DAYS    keep versions/<ts>/ this many days (default 90)
#   MINIO_OFFSITE_MAX_DELETE       max objects one run may move out of current/ (default 50)
#   MINIO_OFFSITE_HEALTH_MAX_AGE_SECONDS  `--check`: last success must be younger (default 93600 = 26h)
#   MINIO_OFFSITE_STATE_DIR        status dir (default /state)
#   MINIO_OFFSITE_NOW              tests only: epoch seconds used instead of the clock
#
# Usage:
#   backup-minio-offsite.sh              one sync run (exit 0 ok, 1 failed/disabled)
#   backup-minio-offsite.sh --check      exit 0 if the last successful run is fresh
#   backup-minio-offsite.sh --status     print the status file
#   backup-minio-offsite.sh rclone ARGS  rclone with `r2:` and `minio:` configured,
#                                        e.g. `… rclone lsf r2:<bucket>/minio/elchi-files/versions`
#
set -u
umask 077
export LC_ALL=C

MO_STATE_DIR="${MINIO_OFFSITE_STATE_DIR:-/state}"
MO_STATUS="$MO_STATE_DIR/status"

# Bucket-root prefixes that never leave MinIO (see header). Leading `/` = only
# at the root of the listed remote path (bucket root / current/).
MO_EXCLUDE='/ai-tmp/**'

mo_log() { echo "[minio-offsite] $*"; }
mo_warn() { echo "[minio-offsite] WARNING: $*" >&2; }
mo_err() { echo "[minio-offsite] ERROR: $*" >&2; }

mo_now() { echo "${MINIO_OFFSITE_NOW:-$(date +%s)}"; }
mo_iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "@$1"; }
mo_stamp() { date -u -d "@$1" +%Y%m%dT%H%M%SZ; }

# Positive-integer env with a default; a bad value warns and falls back.
mo_int() {
  eval "_mi_val=\${$1:-}"
  case "$_mi_val" in
    '') echo "$2" ;;
    *[!0-9]* | 0*)
      mo_warn "$1='$_mi_val' is not a positive integer — using $2"
      echo "$2"
      ;;
    *) echo "$_mi_val" ;;
  esac
}

# Empty or a template placeholder = not set.
mo_unset() {
  case "${1:-}" in
    '' | __REPLACE* | REPLACE_* | changeme) return 0 ;;
  esac
  return 1
}

# Names (never values) of the missing required variables.
mo_missing() {
  _mm=""
  if mo_unset "${R2_ACCOUNT_ID:-}" && mo_unset "${R2_ENDPOINT:-}"; then _mm="$_mm R2_ACCOUNT_ID"; fi
  mo_unset "${R2_ACCESS_KEY_ID:-}" && _mm="$_mm R2_ACCESS_KEY_ID"
  mo_unset "${R2_SECRET_ACCESS_KEY:-}" && _mm="$_mm R2_SECRET_ACCESS_KEY"
  mo_unset "${MINIO_BACKUP_ACCESS_KEY:-}" && _mm="$_mm MINIO_BACKUP_ACCESS_KEY"
  mo_unset "${MINIO_BACKUP_SECRET_KEY:-}" && _mm="$_mm MINIO_BACKUP_SECRET_KEY"
  echo "${_mm# }"
}

mo_resolve_config() {
  MO_R2_BUCKET="${R2_BUCKET:-elchi-db-backups}"
  MO_SRC_BUCKETS="${MINIO_OFFSITE_BUCKETS:-${MINIO_BUCKET:-elchi-files}}"
  MO_PREFIX="${MINIO_OFFSITE_PREFIX:-minio}"
  MO_VERSIONS_DAYS="$(mo_int MINIO_OFFSITE_VERSIONS_DAYS 90)"
  MO_MAX_DELETE="$(mo_int MINIO_OFFSITE_MAX_DELETE 50)"
  case "${MINIO_USE_SSL:-false}" in
    true | 1 | yes) _mr_scheme=https ;;
    *) _mr_scheme=http ;;
  esac
  MO_MINIO_URL="${_mr_scheme}://${MINIO_ENDPOINT:-minio}:${MINIO_PORT:-9000}"
  MO_DEST_ROOT="r2:$MO_R2_BUCKET/$MO_PREFIX"
}

# Values that end up in remote paths / URLs must be plain tokens.
mo_validate() {
  case "$MO_R2_BUCKET" in
    '' | *[!a-z0-9-]* | -* | *-)
      echo "R2_BUCKET='$MO_R2_BUCKET' is not a valid bucket name (a-z, 0-9, -)"
      return 1
      ;;
  esac
  case "$MO_PREFIX" in
    '' | *[!a-z0-9-]*)
      echo "MINIO_OFFSITE_PREFIX='$MO_PREFIX' must be a-z, 0-9, -"
      return 1
      ;;
  esac
  [ -n "$MO_SRC_BUCKETS" ] || {
    echo "no source bucket (MINIO_OFFSITE_BUCKETS / MINIO_BUCKET)"
    return 1
  }
  for _mv_b in $MO_SRC_BUCKETS; do
    case "$_mv_b" in
      *[!a-z0-9.-]* | -* | .*)
        echo "source bucket '$_mv_b' is not a valid bucket name"
        return 1
        ;;
    esac
  done
  case "${MINIO_ENDPOINT:-minio}:${MINIO_PORT:-9000}" in
    *[!A-Za-z0-9.:-]*)
      echo "MINIO_ENDPOINT/MINIO_PORT must be a plain host and port"
      return 1
      ;;
  esac
  if mo_unset "${R2_ENDPOINT:-}"; then
    case "${R2_ACCOUNT_ID:-}" in
      *[!0-9A-Za-z]*)
        echo "R2_ACCOUNT_ID is not a Cloudflare account id (letters/digits only)"
        return 1
        ;;
    esac
  fi
  return 0
}

mo_rclone_env() {
  if mo_unset "${R2_ENDPOINT:-}"; then
    RCLONE_CONFIG_R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  else
    RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
  fi
  RCLONE_CONFIG=""
  RCLONE_CONFIG_R2_TYPE=s3
  RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  RCLONE_CONFIG_R2_REGION=auto
  RCLONE_CONFIG_R2_ACL=private
  RCLONE_CONFIG_R2_ENV_AUTH=false
  RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
  RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
  RCLONE_CONFIG_MINIO_TYPE=s3
  RCLONE_CONFIG_MINIO_PROVIDER=Minio
  RCLONE_CONFIG_MINIO_ENDPOINT="$MO_MINIO_URL"
  RCLONE_CONFIG_MINIO_REGION=us-east-1
  RCLONE_CONFIG_MINIO_ENV_AUTH=false
  RCLONE_CONFIG_MINIO_NO_CHECK_BUCKET=true
  RCLONE_CONFIG_MINIO_FORCE_PATH_STYLE=true
  RCLONE_CONFIG_MINIO_ACCESS_KEY_ID="${MINIO_BACKUP_ACCESS_KEY:-}"
  RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY="${MINIO_BACKUP_SECRET_KEY:-}"
  export RCLONE_CONFIG RCLONE_CONFIG_R2_TYPE RCLONE_CONFIG_R2_PROVIDER \
    RCLONE_CONFIG_R2_ENDPOINT RCLONE_CONFIG_R2_REGION RCLONE_CONFIG_R2_ACL \
    RCLONE_CONFIG_R2_ENV_AUTH RCLONE_CONFIG_R2_NO_CHECK_BUCKET \
    RCLONE_CONFIG_R2_ACCESS_KEY_ID RCLONE_CONFIG_R2_SECRET_ACCESS_KEY \
    RCLONE_CONFIG_MINIO_TYPE RCLONE_CONFIG_MINIO_PROVIDER RCLONE_CONFIG_MINIO_ENDPOINT \
    RCLONE_CONFIG_MINIO_REGION RCLONE_CONFIG_MINIO_ENV_AUTH RCLONE_CONFIG_MINIO_NO_CHECK_BUCKET \
    RCLONE_CONFIG_MINIO_FORCE_PATH_STYLE RCLONE_CONFIG_MINIO_ACCESS_KEY_ID \
    RCLONE_CONFIG_MINIO_SECRET_ACCESS_KEY
}

# ---- status file (key=value; read with sed, never sourced) --------------------
mo_status_get() {
  [ -f "$MO_STATUS" ] || return 0
  sed -n "s/^$1=//p" "$MO_STATUS" | head -n 1
}

# mo_status_write STATE MESSAGE
mo_status_write() {
  mkdir -p "$MO_STATE_DIR" || return 0
  _sw_tmp="$MO_STATE_DIR/.status.$$"
  {
    echo "state=$1"
    echo "updated_at=$(mo_now)"
    echo "last_run_at=${MO_LAST_RUN_AT:-}"
    echo "last_success_at=${MO_LAST_SUCCESS_AT:-}"
    echo "objects=${MO_OBJECTS:-}"
    echo "bytes=${MO_BYTES:-}"
    echo "copied=${MO_COPIED:-}"
    echo "versioned=${MO_VERSIONED:-}"
    echo "pruned_versions=${MO_PRUNED:-}"
    echo "remote=${MO_DEST_ROOT:-}"
    echo "message=$(printf '%s' "$2" | tr '\n' ' ')"
  } > "$_sw_tmp" && mv -f "$_sw_tmp" "$MO_STATUS"
}

# Count of objects under a remote path; "directory not found" (exit 3) = 0.
mo_count() {
  _mc_out="$MO_RUN_DIR/count.$$"
  rclone lsf "$1" -R --files-only --fast-list --exclude "$MO_EXCLUDE" > "$_mc_out" 2>> "$MO_RUN_ERR"
  _mc_rc=$?
  if [ "$_mc_rc" -eq 3 ]; then
    echo 0
    return 0
  fi
  [ "$_mc_rc" -eq 0 ] || return "$_mc_rc"
  wc -l < "$_mc_out" | tr -d ' '
}

# Sync one bucket. Sets MO_B_* ; on failure MO_B_STEP and returns 1.
mo_sync_bucket() {
  _sb_src="minio:$1"
  _sb_cur="$MO_DEST_ROOT/$1/current"
  _sb_ver="$MO_DEST_ROOT/$1/versions/$MO_RUN_STAMP"
  _sb_log="$MO_RUN_DIR/$1.sync.log"
  MO_B_OBJECTS=0
  MO_B_BYTES=0
  MO_B_COPIED=0
  MO_B_VERSIONED=0
  MO_B_STEP=""

  _sb_nsrc="$(mo_count "$_sb_src")" || {
    MO_B_STEP="list MinIO"
    return 1
  }
  _sb_ndst="$(mo_count "$_sb_cur")" || {
    MO_B_STEP="list R2"
    return 1
  }
  if [ "$_sb_nsrc" -eq 0 ] && [ "$_sb_ndst" -gt 0 ]; then
    MO_B_STEP="MinIO bucket $1 is EMPTY while the R2 copy holds $_sb_ndst objects — refused, nothing moved"
    return 1
  fi

  rclone sync "$_sb_src" "$_sb_cur" --backup-dir "$_sb_ver" --checksum --fast-list \
    --exclude "$MO_EXCLUDE" \
    --max-delete "$MO_MAX_DELETE" --transfers 4 --checkers 8 --stats 0 -v \
    > "$_sb_log" 2>&1
  _sb_rc=$?
  cat "$_sb_log" >> "$MO_RUN_ERR"
  # "Copied (new)" / "Copied (replaced existing)" = uploaded; "Moved" into
  # --backup-dir = an old version kept (overwritten or deleted in MinIO).
  MO_B_COPIED="$(grep -c -E 'Copied \((new|replaced existing)\)' "$_sb_log" 2>/dev/null || true)"
  MO_B_VERSIONED="$(grep -c 'Moved' "$_sb_log" 2>/dev/null || true)"
  if [ "$_sb_rc" -ne 0 ]; then
    MO_B_STEP="sync (rclone exit $_sb_rc; --max-delete $MO_MAX_DELETE?)"
    return 1
  fi

  rclone check "$_sb_src" "$_sb_cur" --one-way --fast-list --exclude "$MO_EXCLUDE" 2>> "$MO_RUN_ERR" || {
    MO_B_STEP="verify (size+md5)"
    return 1
  }
  # {"count":117,"bytes":24722429,"sizeless":0}
  _sb_size="$(rclone size "$_sb_cur" --fast-list --json --exclude "$MO_EXCLUDE" 2>> "$MO_RUN_ERR")" || {
    MO_B_STEP="size R2"
    return 1
  }
  MO_B_OBJECTS="$(echo "$_sb_size" | sed -n 's/.*"count": *\([0-9]*\).*/\1/p' | head -n 1)"
  MO_B_BYTES="$(echo "$_sb_size" | sed -n 's/.*"bytes": *\([0-9]*\).*/\1/p' | head -n 1)"
  return 0
}

# Purge versions/<ts>/ folders older than the retention (by folder name).
mo_prune_bucket() {
  MO_B_PRUNED=0
  _pb_root="$MO_DEST_ROOT/$1/versions"
  _pb_list="$MO_RUN_DIR/$1.versions"
  rclone lsf "$_pb_root" --dirs-only --max-depth 1 > "$_pb_list" 2>> "$MO_RUN_ERR"
  _pb_rc=$?
  [ "$_pb_rc" -eq 3 ] && return 0
  [ "$_pb_rc" -eq 0 ] || return 1
  _pb_cut="$(mo_stamp $(($(mo_now) - MO_VERSIONS_DAYS * 86400)))" || return 1
  while IFS= read -r _pb_d; do
    _pb_d="${_pb_d%/}"
    case "$_pb_d" in
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
      *) continue ;; # never touch anything that is not a run folder
    esac
    # Same fixed-width format: string order == time order.
    if [ "$(printf '%s\n%s\n' "$_pb_d" "$_pb_cut" | sort | head -n 1)" = "$_pb_d" ] && [ "$_pb_d" != "$_pb_cut" ]; then
      rclone purge "$_pb_root/$_pb_d" 2>> "$MO_RUN_ERR" || return 1
      MO_B_PRUNED=$((MO_B_PRUNED + 1))
    fi
  done < "$_pb_list"
  return 0
}

mo_run_errors() {
  grep -E 'ERROR|Failed|NOTICE|denied|Denied' "$MO_RUN_ERR" 2>/dev/null | tail -n 3 | cut -c 1-300 |
    sed 's/^/[minio-offsite]   rclone: /' >&2
}

mo_run() {
  mo_resolve_config
  MO_LAST_SUCCESS_AT="$(mo_status_get last_success_at)"
  MO_LAST_RUN_AT="$(mo_now)"
  MO_RUN_STAMP="$(mo_stamp "$MO_LAST_RUN_AT")"

  _r_missing="$(mo_missing)"
  if [ -n "$_r_missing" ]; then
    mo_err "sozlanmagan — MinIO off-site nusxa o'chiq (yo'q: ${_r_missing})"
    mo_status_write disabled "not configured: ${_r_missing}"
    return 1
  fi
  _r_why="$(mo_validate)" || {
    mo_err "$_r_why — MinIO off-site copy NOT done"
    mo_status_write error "$_r_why"
    return 1
  }

  MO_RUN_DIR="$MO_STATE_DIR/run"
  MO_RUN_ERR="$MO_RUN_DIR/rclone.err"
  rm -rf "$MO_RUN_DIR"
  mkdir -p "$MO_RUN_DIR" || {
    mo_err "cannot create $MO_RUN_DIR"
    return 1
  }
  : > "$MO_RUN_ERR"
  mo_rclone_env

  MO_OBJECTS=0
  MO_BYTES=0
  MO_COPIED=0
  MO_VERSIONED=0
  MO_PRUNED=0
  _r_detail=""
  _r_failed=""
  for _r_b in $MO_SRC_BUCKETS; do
    if mo_sync_bucket "$_r_b"; then
      if mo_prune_bucket "$_r_b"; then
        MO_PRUNED=$((MO_PRUNED + MO_B_PRUNED))
      else
        _r_failed="$_r_failed $_r_b: prune versions;"
      fi
      _r_detail="$_r_detail $_r_b=${MO_B_OBJECTS}obj/${MO_B_COPIED}new/${MO_B_VERSIONED}ver"
      case "$MO_B_OBJECTS" in *[!0-9]* | '') ;; *) MO_OBJECTS=$((MO_OBJECTS + MO_B_OBJECTS)) ;; esac
      case "$MO_B_BYTES" in *[!0-9]* | '') ;; *) MO_BYTES=$((MO_BYTES + MO_B_BYTES)) ;; esac
    else
      _r_failed="$_r_failed $_r_b: $MO_B_STEP;"
      _r_detail="$_r_detail $_r_b=FAILED"
    fi
    MO_COPIED=$((MO_COPIED + MO_B_COPIED))
    MO_VERSIONED=$((MO_VERSIONED + MO_B_VERSIONED))
  done

  if [ -n "$_r_failed" ]; then
    _r_msg="run failed (${_r_failed# }) — ${_r_detail# }; next cron run retries"
    mo_err "$_r_msg"
    mo_run_errors
    mo_status_write error "$_r_msg"
    return 1
  fi
  MO_LAST_SUCCESS_AT="$(mo_now)"
  _r_msg="${_r_detail# }, ${MO_BYTES} B, pruned ${MO_PRUNED} version folder(s) older than ${MO_VERSIONS_DAYS}d -> ${MO_DEST_ROOT}"
  mo_log "ok @ $(mo_iso "$MO_LAST_SUCCESS_AT"): $_r_msg"
  mo_status_write ok "$_r_msg"
  return 0
}

mo_check() {
  _c_max="$(mo_int MINIO_OFFSITE_HEALTH_MAX_AGE_SECONDS 93600)"
  _c_now="$(mo_now)"
  if [ ! -f "$MO_STATUS" ]; then
    echo "[minio-offsite] UNHEALTHY: no status file yet ($MO_STATUS)" >&2
    return 1
  fi
  _c_state="$(mo_status_get state)"
  _c_last="$(mo_status_get last_success_at)"
  if [ "$_c_state" = disabled ]; then
    echo "[minio-offsite] UNHEALTHY: disabled — $(mo_status_get message)" >&2
    return 1
  fi
  if [ -n "$_c_last" ]; then
    _c_age=$((_c_now - _c_last))
    if [ "$_c_age" -le "$_c_max" ]; then
      echo "[minio-offsite] healthy: last successful run ${_c_age}s ago (state=${_c_state})"
      return 0
    fi
    echo "[minio-offsite] UNHEALTHY: last successful run ${_c_age}s ago (> ${_c_max}s), state=${_c_state}: $(mo_status_get message)" >&2
    return 1
  fi
  echo "[minio-offsite] UNHEALTHY: no successful run yet (state=${_c_state:-unknown}): $(mo_status_get message)" >&2
  return 1
}

case "${1:-}" in
  '') mo_run ;;
  --check) mo_check ;;
  --status)
    if [ -f "$MO_STATUS" ]; then cat "$MO_STATUS"; else echo "no status file yet ($MO_STATUS)"; fi
    ;;
  rclone)
    shift
    _x_missing="$(mo_missing)"
    if [ -n "$_x_missing" ]; then
      mo_err "sozlanmagan (yo'q: ${_x_missing})"
      exit 1
    fi
    mo_resolve_config
    mo_rclone_env
    exec rclone "$@"
    ;;
  *)
    echo "usage: $0 [--check|--status|rclone ARGS...]" >&2
    exit 2
    ;;
esac
