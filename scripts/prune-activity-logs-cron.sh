#!/usr/bin/env sh
#
# Scheduled activity-log retention prune (audit devops: activity_logs grew
# without bound). Periodically runs `db:prune-activity-logs`, which deletes rows
# older than ACTIVITY_LOG_RETENTION_DAYS from every schema's activity_logs table
# in bounded batches. Wired as the `activity-log-prune` service in
# docker-compose.prod.yml.
#
# Env:
#   ACTIVITY_LOG_PRUNE_INTERVAL_SECONDS  seconds between runs (default 86400 = 1d)
#   ACTIVITY_LOG_RETENTION_DAYS          retention window (default 365, see script)
#   POSTGRES_URI                         connection (from .env.production)
#
set -eu

INTERVAL="${ACTIVITY_LOG_PRUNE_INTERVAL_SECONDS:-86400}"
echo "[activity-log-prune] loop starting; interval=${INTERVAL}s"

while true; do
  if npm run db:prune-activity-logs; then
    echo "[activity-log-prune] ok @ $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    echo "[activity-log-prune] FAILED @ $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
  fi
  sleep "${INTERVAL}"
done
