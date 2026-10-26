#!/usr/bin/env bash
#
# Pre-deploy safety dump — taken on EVERY deploy by .github/workflows/deploy.yml,
# before any image is pulled, any container is (re)built or any migration runs.
#
# Talab (Elchi Pochta, "Avtomatik backup tizimi"): har bir deploydan oldin
# avtomatik backup olinadi; oxirgi 5 tasi saqlanadi, eskilari avtomatik
# o'chiriladi.
#
# Runs on the HOST (repo root), so it dumps through the running postgres
# container — `docker compose exec -T postgres pg_dump` with that container's
# own POSTGRES_USER/POSTGRES_DB, the same path deploy.yml always used for its
# pre-migration dump. The dump is ALSO the restore point for this deploy's
# migrations (no second dump).
#
# Usage:  scripts/pre-deploy-backup.sh [OLD_SHA] [NEW_SHA]
#   stdout: the dump's path (empty line when skipped on a first install)
#   stderr: progress / errors
#   exit 0: verified dump written (or nothing to back up yet);
#   non-zero: NO trustworthy dump — the caller must abort the deploy.
#
# Env:
#   BACKUP_PRE_DEPLOY_KEEP   pre-deploy dumps to keep   (default 5)
#   PRE_DEPLOY_BACKUP_DIR    output dir                 (default ./backups/pre-deploy)
#   BACKUP_COMPOSE_FILE      compose file(s)            (default docker-compose.prod.yml)
#                            several files joined with ':' like COMPOSE_FILE —
#                            staging: docker-compose.prod.yml:docker-compose.staging.yml
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${BACKUP_COMPOSE_FILE:-docker-compose.prod.yml}"
# `-f a -f b …` — the staging override changes the project name, so a lookup
# with the base file alone would never find (and never dump) staging's postgres.
COMPOSE_ARGS=()
IFS=':' read -r -a _compose_files <<< "$COMPOSE_FILE"
for _f in "${_compose_files[@]}"; do COMPOSE_ARGS+=(-f "$_f"); done
DIR="${PRE_DEPLOY_BACKUP_DIR:-./backups/pre-deploy}"
KEEP="${BACKUP_PRE_DEPLOY_KEEP:-5}"

log() { echo "[pre-deploy] $*" >&2; }

# Is there a database to protect? `ps` errors are fatal: an unreadable compose
# file must not be mistaken for "no database yet".
if ! PG_CID="$(docker compose "${COMPOSE_ARGS[@]}" ps --all --quiet postgres)"; then
  log "ERROR: could not query the postgres container (docker compose ps failed)"
  exit 1
fi
if [ -z "$PG_CID" ]; then
  log "no postgres container exists yet (first install) — nothing to back up, skipping"
  echo ""
  exit 0
fi
if [ "$(docker inspect -f '{{.State.Running}}' "$PG_CID" 2>/dev/null || true)" != true ]; then
  log "ERROR: the postgres container exists but is NOT running, so no backup can be taken."
  log "       Start it (docker compose ${COMPOSE_ARGS[*]} up -d postgres), check the data, then re-run the deploy."
  exit 1
fi

SUFFIX=""
if [ -n "${1:-}" ]; then SUFFIX="${1:0:7}"; fi
if [ -n "${2:-}" ]; then SUFFIX="${SUFFIX:+${SUFFIX}-to-}${2:0:7}"; fi

RESULT="$(mktemp)"
trap 'rm -f -- "$RESULT"' EXIT

log "taking the pre-deploy DB backup into $DIR (keep $KEEP)"
# The gate is about the LOCAL restore point: an inherited BACKUP_S3_TARGET must
# not fail a deploy over an upload (off-box copies are the daily dumps' job).
BACKUP_S3_TARGET="" \
BACKUP_DIR="$DIR" \
BACKUP_RETENTION="$KEEP" \
BACKUP_PREFIX="pre-deploy" \
BACKUP_SUFFIX="$SUFFIX" \
BACKUP_COMPOSE_FILE="$COMPOSE_FILE" \
BACKUP_RESULT_FILE="$RESULT" \
  bash "$SCRIPT_DIR/backup-db.sh" >&2

OUT="$(cat "$RESULT")"
if [ -z "$OUT" ] || [ ! -s "$OUT" ]; then
  log "ERROR: backup-db.sh reported success but wrote no dump"
  exit 1
fi
# Absolute, so rollback/restore messages point at the file from any directory.
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
log "pre-deploy backup ok: $OUT"
echo "$OUT"
