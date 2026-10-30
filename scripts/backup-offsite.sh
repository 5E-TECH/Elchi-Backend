#!/bin/sh
#
# Off-site copies of the DB dumps -> Cloudflare R2 (the `backup-offsite`
# service in docker-compose.prod.yml). The daily / pre-deploy dumps live on the
# same VPS as the database, so a lost disk or a dead box (Contabo outages) takes
# them with it; this keeps a copy outside the VPS.
#
# POSIX sh: runs in the pinned rclone/rclone image (Alpine busybox ash, no bash).
#
# Every OFFSITE_INTERVAL_SECONDS (1 h) one run:
#   1. for each of /backups/{daily,pre-deploy,pre-migration} (bind mount, READ
#      ONLY) list the local `*.sql.gz` dumps younger than OFFSITE_RETENTION_DAYS
#      and the objects already in r2:$R2_BUCKET/<subdir>/; upload only the names
#      R2 does not have yet (`rclone copy --ignore-existing --immutable`: an
#      existing object is NEVER overwritten), then `rclone check` those new
#      objects against the local files (size + MD5). Hidden `.…partial.<pid>`
#      files of a dump in progress never match `*.sql.gz`.
#   2. only if every upload succeeded AND r2:…/daily/ still holds a copy younger
#      than the retention: delete objects older than OFFSITE_RETENTION_DAYS
#      (`rclone delete --min-age`; age = the dump file's mtime, which rclone
#      stores with every object) in those three prefixes — nothing else in the
#      bucket is touched. When daily dumps have stopped (no fresh copy) nothing
#      is pruned, so the last off-site copies survive.
#   3. one log line, and a key=value status file ($OFFSITE_STATE_DIR/status,
#      inside the container) that the healthcheck reads.
#
# Without R2 credentials it logs «R2 sozlanmagan — off-site nusxa o'chiq» every
# interval, marks the status `disabled`, and keeps running (no crash loop); the
# healthcheck reports healthy in that case. A failed run deletes nothing and is
# retried on the next interval.
#
# rclone is configured ONLY through environment variables (RCLONE_CONFIG_R2_*,
# derived from R2_* below; RCLONE_CONFIG="" = no config file) — no file with
# secrets on disk. Secrets are never printed.
#
# Client-side encryption (6RaEn5cN, OFF by default): with OFFSITE_ENCRYPTION_KEY
# set the dumps go through an rclone `crypt` remote to
# r2:$R2_BUCKET/encrypted/<subdir>/<name>.bin (content encrypted, names readable),
# verified with `rclone cryptcheck`. Without the key nothing below changes. A bad
# key never falls back to plaintext: the run fails and uploads nothing. Plaintext
# copies already in R2 are left alone and age out with the same retention, once a
# fresh encrypted daily copy exists. The key must also live OFF the VPS
# (password manager): without it the copies cannot be read.
#
# Env (.env.production; runbook docs/ops/db-backups.md):
#   R2_ACCOUNT_ID             Cloudflare account id (endpoint https://<id>.r2.cloudflarestorage.com)
#   R2_ACCESS_KEY_ID          R2 API token: Access Key ID   (Object Read & Write, this bucket only)
#   R2_SECRET_ACCESS_KEY      R2 API token: Secret Access Key
#   R2_BUCKET                 bucket                          (default elchi-db-backups)
#   R2_ENDPOINT               optional endpoint override (e.g. an EU-jurisdiction bucket)
#   OFFSITE_INTERVAL_SECONDS  seconds between runs            (default 3600, min 60)
#   OFFSITE_RETENTION_DAYS    keep R2 copies this many days   (default 30)
#   OFFSITE_ENCRYPTION_KEY    >= 32 chars (openssl rand -hex 32); empty = no client-side encryption
#   OFFSITE_HEALTH_MAX_AGE_SECONDS  `--check`: last success must be younger (default 93600 = 26h)
#   OFFSITE_SRC_ROOT          local dumps root (default /backups — the read-only mount)
#   OFFSITE_STATE_DIR         status dir       (default /tmp/backup-offsite, in the container)
#   OFFSITE_NOW               tests only: epoch seconds used instead of the clock
#   OFFSITE_MAX_CYCLES        tests only: stop after N loop cycles
#
# Usage:
#   backup-offsite.sh                sync loop (container entrypoint)
#   backup-offsite.sh --check        exit 0 if disabled or the last sync is fresh (healthcheck)
#   backup-offsite.sh --status       print the status file
#   backup-offsite.sh rclone ARGS…   run rclone with the `r2:` remote configured, e.g.
#                                    `… rclone lsl r2:elchi-db-backups/daily`
#
set -u
umask 077
export LC_ALL=C

OFFSITE_SRC_ROOT="${OFFSITE_SRC_ROOT:-/backups}"
OFFSITE_STATE_DIR="${OFFSITE_STATE_DIR:-/tmp/backup-offsite}"
OFFSITE_STATUS="$OFFSITE_STATE_DIR/status"
OFFSITE_SUBDIRS="daily pre-deploy pre-migration"
OFFSITE_PATTERN='*.sql.gz'

offsite_log() { echo "[backup-offsite] $*"; }
offsite_warn() { echo "[backup-offsite] WARNING: $*" >&2; }
offsite_err() { echo "[backup-offsite] ERROR: $*" >&2; }

offsite_now() { echo "${OFFSITE_NOW:-$(date +%s)}"; }
offsite_iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "@$1"; }

# Positive-integer env with a default (and optional minimum); a bad value warns
# and falls back, so a typo in .env.production never stops the copies.
offsite_int() {
  eval "_oi_val=\${$1:-}"
  case "$_oi_val" in
    '') echo "$2" ;;
    *[!0-9]* | 0*)
      offsite_warn "$1='$_oi_val' is not a positive integer — using $2"
      echo "$2"
      ;;
    *)
      if [ -n "${3:-}" ] && [ "$_oi_val" -lt "$3" ]; then
        offsite_warn "$1=$_oi_val is below the minimum $3 — using $3"
        echo "$3"
      else
        echo "$_oi_val"
      fi
      ;;
  esac
}

# Empty or a template placeholder (`__REPLACE_WITH_…__`, `REPLACE_…`) = not set.
offsite_unset() {
  case "${1:-}" in
    '' | __REPLACE* | REPLACE_* | changeme) return 0 ;;
  esac
  return 1
}

# Names (never values) of the required R2_* variables that are missing.
offsite_missing() {
  _om=""
  if offsite_unset "${R2_ACCOUNT_ID:-}" && offsite_unset "${R2_ENDPOINT:-}"; then
    _om="$_om R2_ACCOUNT_ID"
  fi
  offsite_unset "${R2_ACCESS_KEY_ID:-}" && _om="$_om R2_ACCESS_KEY_ID"
  offsite_unset "${R2_SECRET_ACCESS_KEY:-}" && _om="$_om R2_SECRET_ACCESS_KEY"
  echo "${_om# }"
}

offsite_configured() { [ -z "$(offsite_missing)" ]; }

# 6RaEn5cN: shablon qiymati shifrlash hisoblanmaydi (offsite_unset kabi).
offsite_encrypted() { ! offsite_unset "${OFFSITE_ENCRYPTION_KEY:-}"; }

# Values that end up in a URL / remote path must be plain tokens.
offsite_validate() {
  case "$OFFSITE_BUCKET" in
    '' | *[!a-z0-9-]* | -* | *-)
      echo "R2_BUCKET='$OFFSITE_BUCKET' is not a valid bucket name (a-z, 0-9, -)"
      return 1
      ;;
  esac
  if offsite_unset "${R2_ENDPOINT:-}"; then
    case "${R2_ACCOUNT_ID:-}" in
      *[!0-9A-Za-z]*)
        echo "R2_ACCOUNT_ID is not a Cloudflare account id (letters/digits only)"
        return 1
        ;;
    esac
  fi
  if offsite_encrypted && [ "${#OFFSITE_ENCRYPTION_KEY}" -lt 32 ]; then
    echo "OFFSITE_ENCRYPTION_KEY is shorter than 32 characters (openssl rand -hex 32)"
    return 1
  fi
  return 0
}

# The `r2:` remote, from env only. RCLONE_CONFIG="" = no config file at all.
offsite_rclone_env() {
  if offsite_unset "${R2_ENDPOINT:-}"; then
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
  # An Object Read & Write token cannot create buckets: never try.
  RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
  RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
  export RCLONE_CONFIG RCLONE_CONFIG_R2_TYPE RCLONE_CONFIG_R2_PROVIDER \
    RCLONE_CONFIG_R2_ENDPOINT RCLONE_CONFIG_R2_REGION RCLONE_CONFIG_R2_ACL \
    RCLONE_CONFIG_R2_ENV_AUTH RCLONE_CONFIG_R2_NO_CHECK_BUCKET \
    RCLONE_CONFIG_R2_ACCESS_KEY_ID RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
  offsite_encrypted || return 0

  # `r2crypt:` over `r2:<bucket>`. The key reaches rclone on stdin only.
  RCLONE_CONFIG_R2CRYPT_TYPE=crypt
  RCLONE_CONFIG_R2CRYPT_REMOTE="r2:$OFFSITE_BUCKET"
  RCLONE_CONFIG_R2CRYPT_FILENAME_ENCRYPTION=off
  RCLONE_CONFIG_R2CRYPT_DIRECTORY_NAME_ENCRYPTION=false
  RCLONE_CONFIG_R2CRYPT_PASSWORD="$(printf '%s\n' "$OFFSITE_ENCRYPTION_KEY" | rclone obscure -)" || return 1
  [ -n "$RCLONE_CONFIG_R2CRYPT_PASSWORD" ] || return 1
  export RCLONE_CONFIG_R2CRYPT_TYPE RCLONE_CONFIG_R2CRYPT_REMOTE \
    RCLONE_CONFIG_R2CRYPT_FILENAME_ENCRYPTION RCLONE_CONFIG_R2CRYPT_DIRECTORY_NAME_ENCRYPTION \
    RCLONE_CONFIG_R2CRYPT_PASSWORD
}

offsite_resolve_config() {
  OFFSITE_BUCKET="${R2_BUCKET:-elchi-db-backups}"
  OFFSITE_INTERVAL="$(offsite_int OFFSITE_INTERVAL_SECONDS 3600 60)"
  OFFSITE_RETENTION="$(offsite_int OFFSITE_RETENTION_DAYS 30)"
  OFFSITE_PLAIN_REMOTE="r2:$OFFSITE_BUCKET"
  OFFSITE_REMOTE="$OFFSITE_PLAIN_REMOTE"
  OFFSITE_PRUNE_ROOTS="$OFFSITE_REMOTE"
  if offsite_encrypted; then
    OFFSITE_REMOTE="r2crypt:encrypted"
    OFFSITE_PRUNE_ROOTS="$OFFSITE_REMOTE $OFFSITE_PLAIN_REMOTE"
  fi
}

# ---- status file (key=value lines; read with sed, never sourced) -------------
offsite_status_get() {
  [ -f "$OFFSITE_STATUS" ] || return 0
  sed -n "s/^$1=//p" "$OFFSITE_STATUS" | head -n 1
}

# offsite_status_write STATE MESSAGE
offsite_status_write() {
  mkdir -p "$OFFSITE_STATE_DIR" || return 0
  _sw_tmp="$OFFSITE_STATE_DIR/.status.$$"
  {
    echo "state=$1"
    echo "updated_at=$(offsite_now)"
    echo "started_at=${OFFSITE_STARTED_AT:-}"
    echo "last_run_at=${OFFSITE_LAST_RUN_AT:-}"
    echo "last_success_at=${OFFSITE_LAST_SUCCESS_AT:-}"
    echo "last_uploaded=${OFFSITE_LAST_UPLOADED:-}"
    echo "last_pruned=${OFFSITE_LAST_PRUNED:-}"
    echo "uploaded_since_start=${OFFSITE_UPLOADED_TOTAL:-0}"
    echo "remote=${OFFSITE_REMOTE:-}"
    echo "message=$(printf '%s' "$2" | tr '\n' ' ')"
  } > "$_sw_tmp" && mv -f "$_sw_tmp" "$OFFSITE_STATUS"
}

# ---- one run ------------------------------------------------------------------
# rclone lsf of one directory into file $2. Exit 3 ("directory not found": a
# missing local dir, or a prefix/bucket R2 reports as absent) counts as empty —
# a really missing bucket then fails loudly at the upload step.
offsite_lsf() {
  _lsf_dir="$1"
  _lsf_out="$2"
  shift 2
  rclone lsf "$_lsf_dir" --files-only --max-depth 1 --include "$OFFSITE_PATTERN" "$@" \
    > "$_lsf_out" 2>> "$OFFSITE_RUN_ERR"
  _lsf_rc=$?
  if [ "$_lsf_rc" -eq 3 ]; then
    : > "$_lsf_out"
    return 0
  fi
  return "$_lsf_rc"
}

# size + MD5 of the new objects. Through crypt the stored bytes differ from the
# local file by design: cryptcheck encrypts the local file with the object's own
# nonce and compares that hash.
offsite_verify() {
  if offsite_encrypted; then
    rclone cryptcheck "$1" "$2" --one-way --files-from-raw "$3"
  else
    rclone check "$1" "$2" --one-way --files-from-raw "$3"
  fi
}

# Upload the new dumps of one subdir. Sets OFFSITE_DIR_UPLOADED; on failure
# sets OFFSITE_DIR_STEP and returns 1.
offsite_sync_dir() {
  _sd_src="$OFFSITE_SRC_ROOT/$1"
  _sd_dst="$OFFSITE_REMOTE/$1"
  _sd_local="$OFFSITE_RUN_DIR/$1.local"
  _sd_remote="$OFFSITE_RUN_DIR/$1.remote"
  _sd_new="$OFFSITE_RUN_DIR/$1.new"
  OFFSITE_DIR_UPLOADED=0
  OFFSITE_DIR_STEP=""
  [ -d "$_sd_src" ] || return 0

  # Older than the retention would be pruned right away (and re-uploaded next run).
  offsite_lsf "$_sd_src" "$_sd_local" --max-age "${OFFSITE_RETENTION}d" || {
    OFFSITE_DIR_STEP="list local"
    return 1
  }
  [ -s "$_sd_local" ] || return 0
  offsite_lsf "$_sd_dst" "$_sd_remote" || {
    OFFSITE_DIR_STEP="list R2"
    return 1
  }
  # Names R2 does not have yet. awk, not `grep -Fxv -f`: busybox grep treats
  # an EMPTY pattern file as "match every line", so the first run (nothing in
  # R2 yet) would upload nothing.
  awk -v rf="$_sd_remote" 'FILENAME == rf { have[$0] = 1; next } !($0 in have)' \
    "$_sd_remote" "$_sd_local" > "$_sd_new" || {
    OFFSITE_DIR_STEP="diff"
    return 1
  }
  [ -s "$_sd_new" ] || return 0

  rclone copy "$_sd_src" "$_sd_dst" --files-from-raw "$_sd_new" --no-traverse \
    --ignore-existing --immutable --transfers 2 --stats 0 \
    2>> "$OFFSITE_RUN_ERR" || {
    OFFSITE_DIR_STEP="upload"
    return 1
  }
  # Explicit verification of what was just uploaded: size + MD5 vs the local file.
  offsite_verify "$_sd_src" "$_sd_dst" "$_sd_new" \
    2>> "$OFFSITE_RUN_ERR" || {
    OFFSITE_DIR_STEP="verify (size+md5)"
    return 1
  }
  OFFSITE_DIR_UPLOADED="$(wc -l < "$_sd_new" | tr -d ' ')"
  return 0
}

# Delete R2 copies older than the retention. Sets OFFSITE_PRUNED / OFFSITE_PRUNE_NOTE.
offsite_prune() {
  OFFSITE_PRUNED=0
  OFFSITE_PRUNE_NOTE=""
  _pr_fresh="$OFFSITE_RUN_DIR/daily.fresh"
  offsite_lsf "$OFFSITE_REMOTE/daily" "$_pr_fresh" \
    --max-age "${OFFSITE_RETENTION}d" || return 1
  if [ ! -s "$_pr_fresh" ]; then
    OFFSITE_PRUNE_NOTE="prune skipped: no daily copy younger than ${OFFSITE_RETENTION}d in R2"
    offsite_warn "R2 da ${OFFSITE_RETENTION} kundan yangi kunlik nusxa yo'q — eski nusxalar O'CHIRILMADI (kunlik backup ishlayaptimi?)"
    return 0
  fi
  for _pr_root in $OFFSITE_PRUNE_ROOTS; do
    for _pr_sub in $OFFSITE_SUBDIRS; do
      _pr_old="$OFFSITE_RUN_DIR/$_pr_sub.old"
      offsite_lsf "$_pr_root/$_pr_sub" "$_pr_old" \
        --min-age "${OFFSITE_RETENTION}d" || return 1
      [ -s "$_pr_old" ] || continue
      rclone delete "$_pr_root/$_pr_sub" --max-depth 1 --include "$OFFSITE_PATTERN" \
        --min-age "${OFFSITE_RETENTION}d" \
        2>> "$OFFSITE_RUN_ERR" || return 1
      OFFSITE_PRUNED=$((OFFSITE_PRUNED + $(wc -l < "$_pr_old")))
    done
  done
  return 0
}

# The last rclone error lines of this run (rclone never logs credentials).
offsite_run_errors() {
  grep -E 'ERROR|Failed|NOTICE' "$OFFSITE_RUN_ERR" 2>/dev/null | tail -n 3 | cut -c 1-300 |
    sed 's/^/[backup-offsite]   rclone: /' >&2
}

offsite_run() {
  OFFSITE_RUN_DIR="$OFFSITE_STATE_DIR/offsite-run"
  OFFSITE_RUN_ERR="$OFFSITE_RUN_DIR/rclone.err"
  rm -rf "$OFFSITE_RUN_DIR"
  mkdir -p "$OFFSITE_RUN_DIR" || {
    offsite_err "cannot create $OFFSITE_RUN_DIR"
    return 1
  }
  : > "$OFFSITE_RUN_ERR"
  OFFSITE_LAST_RUN_AT="$(offsite_now)"

  _r_why="$(offsite_validate)" || {
    offsite_err "$_r_why — off-site copy NOT done"
    offsite_status_write error "$_r_why"
    return 1
  }
  offsite_rclone_env || {
    _r_why="could not derive the rclone crypt password"
    offsite_err "$_r_why — off-site copy NOT done"
    offsite_status_write error "$_r_why"
    return 1
  }

  _r_up=0
  _r_detail=""
  _r_failed=""
  for _r_sub in $OFFSITE_SUBDIRS; do
    if offsite_sync_dir "$_r_sub"; then
      _r_up=$((_r_up + OFFSITE_DIR_UPLOADED))
      _r_detail="$_r_detail $_r_sub=$OFFSITE_DIR_UPLOADED"
    else
      _r_failed="$_r_failed $_r_sub: $OFFSITE_DIR_STEP;"
      _r_detail="$_r_detail $_r_sub=FAILED"
    fi
  done
  OFFSITE_UPLOADED_TOTAL=$((${OFFSITE_UPLOADED_TOTAL:-0} + _r_up))

  if [ -n "$_r_failed" ]; then
    _r_msg="sync failed (${_r_failed# }) — uploaded ${_r_up} (${_r_detail# }), nothing pruned; retry in ${OFFSITE_INTERVAL}s"
    offsite_err "$_r_msg"
    offsite_run_errors
    OFFSITE_LAST_UPLOADED="$_r_up"
    offsite_status_write error "$_r_msg"
    return 1
  fi

  if ! offsite_prune; then
    _r_msg="uploaded ${_r_up} (${_r_detail# }) but the retention prune failed; retry in ${OFFSITE_INTERVAL}s"
    offsite_err "$_r_msg"
    offsite_run_errors
    OFFSITE_LAST_UPLOADED="$_r_up"
    offsite_status_write error "$_r_msg"
    return 1
  fi

  OFFSITE_LAST_SUCCESS_AT="$(offsite_now)"
  OFFSITE_LAST_UPLOADED="$_r_up"
  OFFSITE_LAST_PRUNED="$OFFSITE_PRUNED"
  _r_msg="uploaded ${_r_up} (${_r_detail# }), pruned ${OFFSITE_PRUNED} older than ${OFFSITE_RETENTION}d -> ${OFFSITE_REMOTE}${OFFSITE_PRUNE_NOTE:+ ($OFFSITE_PRUNE_NOTE)}"
  offsite_log "ok @ $(offsite_iso "$OFFSITE_LAST_SUCCESS_AT"): $_r_msg"
  offsite_status_write ok "$_r_msg"
  return 0
}

# ---- loop / healthcheck ---------------------------------------------------------
offsite_main() {
  offsite_resolve_config
  _m_max="$(offsite_int OFFSITE_MAX_CYCLES 0 2>/dev/null)"
  _m_cycles=0
  OFFSITE_STARTED_AT="$(offsite_now)"
  # A container restart keeps its /tmp: carry the last success over.
  OFFSITE_LAST_SUCCESS_AT="$(offsite_status_get last_success_at)"
  OFFSITE_LAST_UPLOADED="$(offsite_status_get last_uploaded)"
  OFFSITE_LAST_PRUNED="$(offsite_status_get last_pruned)"
  OFFSITE_UPLOADED_TOTAL=0
  # PID 1 in the container: without a trap `docker stop` waits 10s for SIGKILL.
  # The sleep runs in the background so `wait` returns as soon as TERM arrives.
  trap 'offsite_log "stopping"; exit 0' TERM INT

  if offsite_configured; then
    offsite_log "starting: every ${OFFSITE_INTERVAL}s, ${OFFSITE_SRC_ROOT}/{daily,pre-deploy,pre-migration}/${OFFSITE_PATTERN} -> ${OFFSITE_REMOTE}/, keep ${OFFSITE_RETENTION}d"
    offsite_status_write starting "first sync in progress"
  fi

  while :; do
    _m_missing="$(offsite_missing)"
    if [ -n "$_m_missing" ]; then
      offsite_warn "R2 sozlanmagan — off-site nusxa o'chiq (.env.production da yo'q: ${_m_missing}); qayta tekshiruv ${OFFSITE_INTERVAL}s dan keyin"
      offsite_status_write disabled "R2 sozlanmagan: ${_m_missing}"
    else
      offsite_run || true
    fi

    _m_cycles=$((_m_cycles + 1))
    if [ "$_m_max" -gt 0 ] && [ "$_m_cycles" -ge "$_m_max" ]; then return 0; fi
    sleep "$OFFSITE_INTERVAL" &
    wait $!
  done
}

offsite_check() {
  _c_max="$(offsite_int OFFSITE_HEALTH_MAX_AGE_SECONDS 93600)"
  _c_now="$(offsite_now)"
  if ! offsite_configured; then
    echo "[backup-offsite] healthy: disabled by config (R2 sozlanmagan: $(offsite_missing))"
    return 0
  fi
  if [ ! -f "$OFFSITE_STATUS" ]; then
    echo "[backup-offsite] UNHEALTHY: no status file yet ($OFFSITE_STATUS)" >&2
    return 1
  fi
  _c_last="$(offsite_status_get last_success_at)"
  _c_state="$(offsite_status_get state)"
  if [ -n "$_c_last" ]; then
    _c_age=$((_c_now - _c_last))
    if [ "$_c_age" -le "$_c_max" ]; then
      echo "[backup-offsite] healthy: last successful sync ${_c_age}s ago (state=${_c_state})"
      return 0
    fi
    echo "[backup-offsite] UNHEALTHY: last successful sync ${_c_age}s ago (> ${_c_max}s), state=${_c_state}: $(offsite_status_get message)" >&2
    return 1
  fi
  _c_started="$(offsite_status_get started_at)"
  if [ "$_c_state" = starting ] && [ -n "$_c_started" ] && [ $((_c_now - _c_started)) -le "$_c_max" ]; then
    echo "[backup-offsite] healthy: first sync in progress"
    return 0
  fi
  echo "[backup-offsite] UNHEALTHY: no successful sync yet (state=${_c_state:-unknown}): $(offsite_status_get message)" >&2
  return 1
}

case "${1:-}" in
  '') offsite_main ;;
  --check) offsite_check ;;
  --status)
    if [ -f "$OFFSITE_STATUS" ]; then cat "$OFFSITE_STATUS"; else echo "no status file yet ($OFFSITE_STATUS)"; fi
    ;;
  rclone)
    shift
    if ! offsite_configured; then
      offsite_err "R2 sozlanmagan (.env.production da yo'q: $(offsite_missing))"
      exit 1
    fi
    offsite_resolve_config
    offsite_rclone_env || {
      offsite_err "could not derive the rclone crypt password"
      exit 1
    }
    exec rclone "$@"
    ;;
  *)
    echo "usage: $0 [--check|--status|rclone ARGS...]" >&2
    exit 2
    ;;
esac
