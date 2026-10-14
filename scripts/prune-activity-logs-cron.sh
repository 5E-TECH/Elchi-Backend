#!/usr/bin/env sh
#
# Scheduled activity-log retention prune (audit devops: activity_logs grew
# without bound). Periodically runs `db:prune-activity-logs`, which applies the
# per-verb retention policy (i6Nyedea) to every schema's activity_logs table in
# bounded batches — row deletion ONLY when ACTIVITY_LOG_PRUNE_ENABLED=true,
# otherwise dry-run (counts). Wired as the `activity-log-prune` service in
# docker-compose.prod.yml.
#
# Env:
#   ACTIVITY_LOG_PRUNE_INTERVAL_SECONDS  seconds between runs (default 86400 = 1d)
#   ACTIVITY_LOG_PRUNE_ENABLED           `true` to delete (default off = dry-run)
#   ACTIVITY_LOG_RETENTION_AUTH_DAYS     login/logout/auth_failure window (default 90)
#   ACTIVITY_LOG_RETENTION_DEFAULT_DAYS  all other verbs window (default 1095)
#   ACTIVITY_LOG_DEVICE_RETENTION_DAYS   ip/device metadata window (default 30, f2Ud5tju)
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
