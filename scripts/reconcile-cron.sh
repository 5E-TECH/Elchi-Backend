#!/usr/bin/env sh
#
# Scheduled cashbox reconciliation loop (Audit money P1: the invariant check was
# written but never run on a schedule). Periodically runs the money-conservation
# check in MONITORED-CRON mode (`db:reconcile` = check-cashbox-invariant.ts
# --reconcile-strict), which reports any cashbox drift or settlement mismatch to
# Sentry. Wired as the `db-reconcile` service in docker-compose.prod.yml.
#
# Env:
#   RECONCILE_INTERVAL_SECONDS  seconds between runs (default 3600 = 1h)
#   POSTGRES_URI | POSTGRES_HOST/...   connection (from .env.production)
#
set -eu

INTERVAL="${RECONCILE_INTERVAL_SECONDS:-3600}"
echo "[db-reconcile] loop starting; interval=${INTERVAL}s"

while true; do
  # db:reconcile exits non-zero on drift; the `|| echo` keeps the loop alive so
  # the next cycle still runs (the drift itself is reported to Sentry inside).
  if npm run db:reconcile; then
    echo "[db-reconcile] ok (no drift) @ $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    echo "[db-reconcile] DRIFT or failure reported (see Sentry) @ $(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
  fi
  sleep "${INTERVAL}"
done
