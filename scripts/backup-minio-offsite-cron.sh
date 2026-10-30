#!/usr/bin/env bash
#
# Host cron wrapper for scripts/backup-minio-offsite.sh (card 6RaEn5cN): one
# MinIO -> R2 run in a throwaway, pinned rclone container on the compose
# network. Needs only the docker group — no service restart, no compose change,
# MinIO is read with its own READ-ONLY user.
#
#   crontab (user in the docker group):
#   35 * * * * /home/<user>/elchi-ops/backup-minio-offsite-cron.sh
#
# Env passed to the container (docker reads the files itself — values never
# appear in argv, ps or the log):
#   * from $ELCHI_APP_DIR/.env.production ONLY R2_*, MINIO_ENDPOINT/PORT/USE_SSL,
#     MINIO_BUCKET, MINIO_OFFSITE_* / MINIO_BACKUP_* and OFFSITE_ENCRYPTION_KEY
#     lines (not the DB/JWT keys);
#   * $ELCHI_OPS_DIR/minio-backup.env (0600): MINIO_BACKUP_ACCESS_KEY /
#     MINIO_BACKUP_SECRET_KEY of the read-only MinIO user — until they are moved
#     into .env.production (then this file may be absent).
#
# State/log on the host: $ELCHI_OPS_DIR/state/minio-offsite/status (read by
# `backup-minio-offsite.sh --check` and scripts/backup-alert.sh),
# $ELCHI_OPS_DIR/logs/minio-offsite.log (kept to the last 2000 lines).
set -uo pipefail
umask 077

APP_DIR="${ELCHI_APP_DIR:-/home/shodiyor/apps/backend}"
OPS_DIR="${ELCHI_OPS_DIR:-$HOME/elchi-ops}"
NET="${ELCHI_DOCKER_NETWORK:-backend_default}"
IMG="${MINIO_OFFSITE_IMAGE:-rclone/rclone:1.68.2}"
SCRIPT="${MINIO_OFFSITE_SCRIPT:-$OPS_DIR/backup-minio-offsite.sh}"
CREDS="$OPS_DIR/minio-backup.env"
STATE="$OPS_DIR/state/minio-offsite"
LOG="$OPS_DIR/logs/minio-offsite.log"

mkdir -p "$STATE" "$OPS_DIR/logs"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

exec 9> "$STATE/.lock"
if ! flock -n 9; then
  echo "$(ts) skipped: previous run still active" >> "$LOG"
  exit 0
fi

# The process substitution must sit on the docker command line itself (its
# /dev/fd/N only lives for that one command). A missing creds file = /dev/null.
[ -f "$CREDS" ] || CREDS=/dev/null

echo "$(ts) run start" >> "$LOG"
docker run --rm --name "elchi-minio-offsite-$$" --network "$NET" \
  --memory 256m --pids-limit 64 --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e MINIO_OFFSITE_STATE_DIR=/state \
  --env-file <(grep -E '^(R2_[A-Z_]+|MINIO_ENDPOINT|MINIO_PORT|MINIO_USE_SSL|MINIO_BUCKET|MINIO_OFFSITE_[A-Z_]+|MINIO_BACKUP_[A-Z_]+|OFFSITE_ENCRYPTION_KEY)=' "$APP_DIR/.env.production") \
  --env-file "$CREDS" \
  -v "$SCRIPT:/scripts/backup-minio-offsite.sh:ro" -v "$STATE:/state" \
  --entrypoint sh "$IMG" /scripts/backup-minio-offsite.sh >> "$LOG" 2>&1
rc=$?
echo "$(ts) run end rc=$rc" >> "$LOG"

tail -n 2000 "$LOG" > "$LOG.tmp" && mv -f "$LOG.tmp" "$LOG"
exit "$rc"
