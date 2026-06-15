#!/usr/bin/env bash
#
# Automated PostgreSQL logical backup for Elchi (Audit P0-8).
#
# All 11 service schemas live in one database; without an off-box backup a bad
# migration, disk failure, or accidental volume removal is UNRECOVERABLE money
# loss. This script takes a compressed pg_dump, rotates local copies, and
# (optionally) pushes the dump off-box to S3/MinIO.
#
# Usage:
#   scripts/backup-db.sh                 # ad-hoc backup
#   BACKUP_DIR=/var/backups/elchi scripts/backup-db.sh
#
# Schedule it (cron / systemd timer), e.g. every 6h:
#   0 */6 * * *  cd /opt/elchi && scripts/backup-db.sh >> /var/log/elchi-backup.log 2>&1
#
# Connection: set POSTGRES_URI, or POSTGRES_HOST/PORT/USER/PASSWORD/DB.
# Off-box upload (optional): set BACKUP_S3_TARGET (e.g. s3://bucket/elchi or an
#   `mc` alias path like minio/elchi-backups) — uploaded with `aws s3 cp` or `mc cp`.
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION="${BACKUP_RETENTION:-14}"   # keep this many local dumps
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

# Resolve connection. Prefer POSTGRES_URI; pg_dump accepts it directly.
if [[ -n "${POSTGRES_URI:-}" ]]; then
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

OUT="${BACKUP_DIR}/elchi-${DB_LABEL}-${TIMESTAMP}.sql.gz"

echo "[backup-db] dumping ${DB_LABEL} -> ${OUT}"
# --clean --if-exists makes the dump restorable onto an existing DB.
pg_dump --no-owner --no-privileges --clean --if-exists "${CONN[@]}" | gzip -9 > "${OUT}"

# Fail if the dump is suspiciously small (e.g. auth error produced an empty file).
SIZE="$(stat -c%s "${OUT}" 2>/dev/null || stat -f%z "${OUT}")"
if [[ "${SIZE}" -lt 1024 ]]; then
  echo "[backup-db] ERROR: dump is only ${SIZE} bytes — treating as failure" >&2
  exit 1
fi
echo "[backup-db] ok: ${SIZE} bytes"

# Off-box copy (the part that actually protects against disk/volume loss).
if [[ -n "${BACKUP_S3_TARGET:-}" ]]; then
  if command -v aws >/dev/null 2>&1 && [[ "${BACKUP_S3_TARGET}" == s3://* ]]; then
    echo "[backup-db] uploading to ${BACKUP_S3_TARGET}"
    aws s3 cp "${OUT}" "${BACKUP_S3_TARGET%/}/"
  elif command -v mc >/dev/null 2>&1; then
    echo "[backup-db] uploading to ${BACKUP_S3_TARGET} (mc)"
    mc cp "${OUT}" "${BACKUP_S3_TARGET%/}/"
  else
    echo "[backup-db] WARNING: BACKUP_S3_TARGET set but neither aws nor mc found — local-only" >&2
  fi
fi

# Rotate local dumps (keep newest $BACKUP_RETENTION).
ls -1t "${BACKUP_DIR}"/elchi-*.sql.gz 2>/dev/null | tail -n +"$((BACKUP_RETENTION + 1))" | while read -r old; do
  echo "[backup-db] rotating out ${old}"
  rm -f "${old}"
done

echo "[backup-db] done"
