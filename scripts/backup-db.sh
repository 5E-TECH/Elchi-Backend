#!/usr/bin/env bash
#
# Automated PostgreSQL logical backup for Elchi (Audit P0-8).
#
# All 11 service schemas live in one database; without a backup a bad
# migration, disk failure, or accidental volume removal is UNRECOVERABLE money
# loss. This script takes ONE compressed pg_dump, verifies it, rotates the local
# copies of the same kind, and (optionally) pushes the dump off-box to S3/MinIO.
#
# Callers (see docs/ops/db-backups.md):
#   - scripts/backup-cron.sh      daily 05:00 Asia/Tashkent  -> /backups/daily      (db-backup sidecar)
#   - scripts/pre-deploy-backup.sh every deploy (deploy.yml) -> ./backups/pre-deploy (host)
#   - scripts/pre-migration-backup.sh / `npm run db:backup`  ad-hoc / local dev
#
# Usage:
#   scripts/backup-db.sh                 # ad-hoc backup
#   BACKUP_DIR=/var/backups/elchi scripts/backup-db.sh
#
# Safety guarantees (a failed run never makes things worse):
#   - the dump is written to a hidden `.<name>.partial.<pid>` file and only
#     renamed to `<name>.sql.gz` (atomic, same directory) after it passed every
#     check: pg_dump exited 0, the gzip stream is intact, it is at least
#     BACKUP_MIN_BYTES, and it ends with pg_dump's "dump complete" trailer.
#     A half-written file therefore never looks like a backup;
#   - rotation runs ONLY after a good dump, so a failed run deletes nothing,
#     and the dump just written is never rotated out.
#
# Env:
#   BACKUP_DIR           output dir (default ./backups)
#   BACKUP_RETENTION     keep this many `<prefix>-*.sql.gz` dumps in BACKUP_DIR (default 14)
#   BACKUP_PREFIX        file name prefix (default `elchi-<db>`). Files are named
#                        <prefix>-YYYYMMDDTHHMMSSZ[-<suffix>].sql.gz — UTC, so
#                        name order == time order (rotation sorts by name).
#   BACKUP_SUFFIX        optional tag appended after the timestamp (e.g. commit SHAs)
#   BACKUP_MIN_BYTES     smallest acceptable compressed dump (default 1024)
#   BACKUP_COMPOSE_FILE  host mode: dump through `docker compose -f <file> exec -T
#                        postgres` with the postgres container's own
#                        POSTGRES_USER/POSTGRES_DB (what deploy.yml always used).
#                        Several files joined with ':' (like COMPOSE_FILE) become
#                        `-f a -f b` (staging: docker-compose.prod.yml:docker-compose.staging.yml).
#                        Unset: a local pg_dump (the db-backup container) with
#                        POSTGRES_URI, or POSTGRES_HOST/PORT/USER/PASSWORD/DB.
#   BACKUP_RESULT_FILE   optional: on success the dump's path is written here
#   BACKUP_S3_TARGET     optional off-box target (s3://bucket/elchi or an `mc`
#                        alias path like minio/elchi-backups) — `aws s3 cp` / `mc cp`
#   BACKUP_NOW           tests only: epoch seconds used instead of the clock
#
# Exit: 0 = a verified dump was written (and uploaded, if configured);
#       non-zero = see the `[backup-db] ERROR:` line; older dumps are untouched
#       (an upload failure keeps the verified local dump).
#
set -euo pipefail
# Dumps hold PII/money data: owner-only files and directories.
umask 077
# Byte-order globbing/sorting so name order == timestamp order on every host.
export LC_ALL=C

log() { echo "[backup-db] $*"; }
fail() {
  echo "[backup-db] ERROR: $*" >&2
  exit 1
}

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION="${BACKUP_RETENTION:-14}"   # keep this many local dumps
BACKUP_MIN_BYTES="${BACKUP_MIN_BYTES:-1024}"
if ! [[ "${BACKUP_RETENTION}" =~ ^[1-9][0-9]*$ ]]; then
  echo "[backup-db] WARNING: BACKUP_RETENTION='${BACKUP_RETENTION}' is not a positive integer — using 14" >&2
  BACKUP_RETENTION=14
fi
if ! [[ "${BACKUP_MIN_BYTES}" =~ ^[0-9]+$ ]]; then
  echo "[backup-db] WARNING: BACKUP_MIN_BYTES='${BACKUP_MIN_BYTES}' is not a number — using 1024" >&2
  BACKUP_MIN_BYTES=1024
fi

NOW="${BACKUP_NOW:-$(date +%s)}"
TIMESTAMP="$(date -u -d "@${NOW}" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -r "${NOW}" +%Y%m%dT%H%M%SZ)"

# Resolve connection. Prefer POSTGRES_URI; pg_dump accepts it directly.
if [[ -n "${BACKUP_COMPOSE_FILE:-}" ]]; then
  DB_LABEL="${POSTGRES_DB:-db}"
elif [[ -n "${POSTGRES_URI:-}" ]]; then
  CONN=("${POSTGRES_URI}")
  DB_LABEL="$(echo "$POSTGRES_URI" | sed -E 's#.*/([^/?]+).*#\1#')"
else
  : "${POSTGRES_HOST:?set POSTGRES_URI or POSTGRES_HOST}"
  : "${POSTGRES_DB:?set POSTGRES_URI or POSTGRES_DB}"
  export PGPASSWORD="${POSTGRES_PASSWORD:-}"
  CONN=(--host "${POSTGRES_HOST}" --port "${POSTGRES_PORT:-5432}" \
        --username "${POSTGRES_USER:-postgres}" "${POSTGRES_DB}")
  DB_LABEL="${POSTGRES_DB}"
fi

PREFIX="${BACKUP_PREFIX:-elchi-${DB_LABEL}}"
SUFFIX="$(printf '%s' "${BACKUP_SUFFIX:-}" | tr -c 'A-Za-z0-9._-' '_')"
NAME="${PREFIX}-${TIMESTAMP}${SUFFIX:+-${SUFFIX}}.sql.gz"
OUT="${BACKUP_DIR}/${NAME}"
TMP="${BACKUP_DIR}/.${NAME}.partial.$$"

mkdir -p "$BACKUP_DIR" || fail "cannot create ${BACKUP_DIR}"
trap 'rm -f -- "$TMP"' EXIT

# Leftovers of a run that was killed mid-dump (container stop, OOM) are never
# backups; drop them once they are clearly stale (another run may be writing).
find "$BACKUP_DIR" -maxdepth 1 -type f -name '.*.partial.*' -mmin +60 -delete 2>/dev/null || true

COMPOSE_ARGS=()
if [[ -n "${BACKUP_COMPOSE_FILE:-}" ]]; then
  IFS=':' read -r -a _compose_files <<< "${BACKUP_COMPOSE_FILE}"
  for _f in "${_compose_files[@]}"; do COMPOSE_ARGS+=(-f "$_f"); done
fi

run_pg_dump() {
  # --clean --if-exists makes the dump restorable onto an existing DB.
  if [[ -n "${BACKUP_COMPOSE_FILE:-}" ]]; then
    docker compose "${COMPOSE_ARGS[@]}" exec -T postgres \
      sh -c 'pg_dump --no-owner --no-privileges --clean --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB"'
  else
    pg_dump --no-owner --no-privileges --clean --if-exists "${CONN[@]}"
  fi
}

log "dumping ${DB_LABEL} -> ${OUT}"
if ! run_pg_dump | gzip -9 > "$TMP"; then
  fail "pg_dump failed (see the error above) — no backup written, older dumps kept"
fi

# The gzip stream must decode end to end (CRC) …
if ! TRAILER="$(gzip -dc -- "$TMP" | tail -n 20)"; then
  fail "dump is not a valid gzip stream — no backup written, older dumps kept"
fi
# … be non-trivial (an auth error / wrong DB produces an almost empty file) …
SIZE="$(stat -c%s "$TMP" 2>/dev/null || stat -f%z "$TMP")"
if [[ "${SIZE}" -lt "${BACKUP_MIN_BYTES}" ]]; then
  fail "dump is only ${SIZE} bytes (< ${BACKUP_MIN_BYTES}) — treating as failure, older dumps kept"
fi
# … and be complete: pg_dump writes this trailer only after the last object.
if [[ "${TRAILER}" != *"PostgreSQL database dump complete"* ]]; then
  fail "dump has no 'PostgreSQL database dump complete' trailer (cut short) — older dumps kept"
fi

mv -f -- "$TMP" "$OUT"
log "ok: ${SIZE} bytes -> ${OUT}"
if [[ -n "${BACKUP_RESULT_FILE:-}" ]]; then
  printf '%s\n' "$OUT" > "${BACKUP_RESULT_FILE}"
fi

# Rotate local dumps of THIS kind (same dir + prefix): keep the newest
# $BACKUP_RETENTION by name (= by UTC timestamp). Other files are never touched.
shopt -s nullglob
DUMPS=("${BACKUP_DIR}/${PREFIX}"-*.sql.gz)
EXCESS=$(( ${#DUMPS[@]} - BACKUP_RETENTION ))
for (( i = 0; i < EXCESS; i++ )); do
  old="${DUMPS[$i]}"
  [[ "$old" == "$OUT" ]] && continue
  log "rotating out ${old}"
  rm -f -- "$old"
done

# Off-box copy (the part that actually protects against disk/volume loss).
if [[ -n "${BACKUP_S3_TARGET:-}" ]]; then
  if command -v aws >/dev/null 2>&1 && [[ "${BACKUP_S3_TARGET}" == s3://* ]]; then
    log "uploading to ${BACKUP_S3_TARGET}"
    aws s3 cp "${OUT}" "${BACKUP_S3_TARGET%/}/" || fail "off-box upload failed — the local dump ${OUT} is fine"
  elif command -v mc >/dev/null 2>&1; then
    log "uploading to ${BACKUP_S3_TARGET} (mc)"
    mc cp "${OUT}" "${BACKUP_S3_TARGET%/}/" || fail "off-box upload failed — the local dump ${OUT} is fine"
  else
    echo "[backup-db] WARNING: BACKUP_S3_TARGET set but neither aws nor mc found — local-only" >&2
  fi
fi

log "done"
