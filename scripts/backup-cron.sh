#!/usr/bin/env bash
#
# In-container scheduled backup loop for the single-host production deploy
# (Audit P0: "single Postgres SPOF with no automated backup schedule").
#
# Runs scripts/backup-db.sh every BACKUP_INTERVAL_SECONDS, writing rotated,
# compressed pg_dump files to $BACKUP_DIR (a host bind-mount) and — when
# BACKUP_S3_TARGET is set — pushing each dump off-box. Wired as the `db-backup`
# service in docker-compose.prod.yml so a bad migration, disk failure, or
# accidental volume removal is always recoverable.
#
# Env:
#   BACKUP_INTERVAL_SECONDS  seconds between backups (default 21600 = 6h)
#   BACKUP_DIR               output dir inside the container (default /backups)
#   BACKUP_RETENTION         how many local dumps to keep (default 28)
#   POSTGRES_URI | POSTGRES_HOST/PORT/USER/PASSWORD/DB   connection (from .env.production)
#   BACKUP_S3_TARGET         optional off-box target (s3://... or an `mc` alias path)
#
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-21600}"
export BACKUP_DIR="${BACKUP_DIR:-/backups}"

echo "[db-backup] loop starting; interval=${INTERVAL}s dir=${BACKUP_DIR} retention=${BACKUP_RETENTION:-28}"

# Take one immediately on boot so a fresh deploy is protected from minute zero,
# then settle into the schedule. A failure is logged but never kills the loop.
while true; do
  if "${SCRIPT_DIR}/backup-db.sh"; then
    echo "[db-backup] cycle ok @ $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    echo "[db-backup] WARNING: backup cycle failed; retrying next interval" >&2
  fi
  sleep "${INTERVAL}"
done
