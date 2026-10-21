#!/usr/bin/env bash
#
# In-container DAILY backup scheduler for the single-host production deploy
# (Audit P0: "single Postgres SPOF with no automated backup schedule").
# Wired as the `db-backup` service in docker-compose.prod.yml; deploy.yml
# starts it on every deploy.
#
# Talab (Elchi Pochta, "Avtomatik backup tizimi"): har kuni soat 05:00 da
# (Asia/Tashkent) backup olinadi, oxirgi 7 kunlik nusxa saqlanadi, eskilari
# avtomatik o'chiriladi.
#
#   - Sleeps until the next BACKUP_DAILY_AT in BACKUP_TZ (05:00 Asia/Tashkent
#     by default — the server itself runs Europe/Berlin, so the time zone is
#     always explicit), then runs scripts/backup-db.sh into $BACKUP_DIR
#     (/backups/daily) with prefix `elchi-daily`.
#   - Keeps the newest BACKUP_DAILY_KEEP (7) daily dumps — one per day, so the
#     last 7 days. Retention is by COUNT, not age: after an outage the last 7
#     good dumps survive instead of everything "older than 7 days" being wiped.
#   - Catch-up: if the most recent 05:00 slot has no dump yet (first start,
#     container down at 05:00, failed run), a dump is taken right away.
#   - A failed run is logged, deletes nothing, and is retried every
#     BACKUP_RETRY_SECONDS until it succeeds.
#   - Sleeps at most BACKUP_MAX_SLEEP_SECONDS at a time and re-checks, so a
#     clock jump or a suspended host can't push the run far off schedule.
#
# Env (override in .env.production; defaults are the product requirement):
#   BACKUP_DAILY_AT            HH:MM local run time          (default 05:00)
#   BACKUP_TZ                  IANA zone of BACKUP_DAILY_AT  (default Asia/Tashkent)
#   BACKUP_DAILY_KEEP          daily dumps to keep           (default 7)
#   BACKUP_RETRY_SECONDS       retry delay after a failure   (default 900 = 15 min)
#   BACKUP_MAX_SLEEP_SECONDS   longest single sleep          (default 3600)
#   BACKUP_HEALTH_MAX_AGE_SECONDS  `--check`: newest dump must be younger (default 93600 = 26h)
#   BACKUP_DIR                 output dir (compose pins /backups/daily)
#   POSTGRES_URI | POSTGRES_HOST/PORT/USER/PASSWORD/DB   connection (from .env.production)
#   BACKUP_S3_TARGET           optional off-box target (see backup-db.sh)
#   BACKUP_NOW                 tests only: epoch seconds used instead of the clock
#   BACKUP_CRON_MAX_CYCLES     tests only: stop after N loop cycles
#
# Usage:
#   backup-cron.sh            run the scheduler loop (container entrypoint)
#   backup-cron.sh --next     print the next run time and exit
#   backup-cron.sh --check    exit 0 if the newest daily dump is fresh (healthcheck)
#
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LC_ALL=C
export BACKUP_DIR="${BACKUP_DIR:-/backups/daily}"
BACKUP_DAILY_PREFIX="elchi-daily"

backup_log() { echo "[db-backup] $*"; }
backup_warn() { echo "[db-backup] WARNING: $*" >&2; }

backup_now() { echo "${BACKUP_NOW:-$(date +%s)}"; }

# Positive-integer env with a default; a bad value warns and falls back so a
# typo in .env.production never stops the backups.
backup_int() {
  local name="$1" def="$2" val
  val="${!name:-}"
  if [ -z "$val" ]; then
    echo "$def"
  elif [[ "$val" =~ ^[1-9][0-9]*$ ]]; then
    echo "$val"
  else
    backup_warn "$name='$val' is not a positive integer — using $def"
    echo "$def"
  fi
}

# BACKUP_TZ, verified. glibc silently treats an unknown zone as UTC (that
# would move the run to 10:00 Tashkent), so the zone file must exist. A POSIX
# TZ string (e.g. '<+05>-5') is accepted as-is. If even the default zone is
# missing (no tzdata), fall back to fixed UTC+05:00 — Asia/Tashkent has had no
# DST since 1992, so that is exact for the default.
backup_tz() {
  local tz="${BACKUP_TZ:-Asia/Tashkent}" zdir="${TZDIR:-/usr/share/zoneinfo}"
  case "$tz" in
    UTC | Etc/UTC) echo "$tz"; return 0 ;;
  esac
  if [ -f "$zdir/$tz" ]; then echo "$tz"; return 0; fi
  if [[ "$tz" != */* && "$tz" == *[0-9]* ]]; then echo "$tz"; return 0; fi
  if [ "$tz" != "Asia/Tashkent" ] && [ -f "$zdir/Asia/Tashkent" ]; then
    backup_warn "time zone '$tz' not found in $zdir — using Asia/Tashkent"
    echo "Asia/Tashkent"
    return 0
  fi
  backup_warn "time zone '$tz' not found in $zdir — using fixed UTC+05:00 (Asia/Tashkent, no DST)"
  echo "<+05>-5"
}

# BACKUP_DAILY_AT as zero-padded HH:MM (invalid -> warning + 05:00).
backup_at() {
  local at="${BACKUP_DAILY_AT:-05:00}" h m
  if [[ "$at" =~ ^([0-9]{1,2}):([0-9]{2})$ ]]; then
    h=$((10#${BASH_REMATCH[1]}))
    m=$((10#${BASH_REMATCH[2]}))
    if [ "$h" -le 23 ] && [ "$m" -le 59 ]; then
      printf '%02d:%02d\n' "$h" "$m"
      return 0
    fi
  fi
  backup_warn "BACKUP_DAILY_AT='$at' is not HH:MM — using 05:00"
  echo "05:00"
}

# Local calendar day (YYYY-MM-DD in BACKUP_TZ) of an epoch.
backup_local_day() { TZ="$BACKUP_TZ_RESOLVED" date -d "@$1" +%F; }

# Neighbouring local day. Steps from local NOON, which is always inside the
# right day even on a 23h/25h DST day (no "+1 day" string parsing pitfalls).
backup_shift_day() {
  local noon
  noon="$(TZ="$BACKUP_TZ_RESOLVED" date -d "$1 12:00" +%s)"
  TZ="$BACKUP_TZ_RESOLVED" date -d "@$((noon + $2 * 86400))" +%F
}

# Epoch of BACKUP_DAILY_AT on local day $1. A local time that does not exist
# (DST spring-forward gap) is approximated from local noon instead of failing.
backup_slot_epoch() {
  local h m noon
  if TZ="$BACKUP_TZ_RESOLVED" date -d "$1 $BACKUP_AT_RESOLVED" +%s 2>/dev/null; then
    return 0
  fi
  h=$((10#${BACKUP_AT_RESOLVED%%:*}))
  m=$((10#${BACKUP_AT_RESOLVED##*:}))
  noon="$(TZ="$BACKUP_TZ_RESOLVED" date -d "$1 12:00" +%s)"
  echo $((noon - 12 * 3600 + h * 3600 + m * 60))
}

# First slot strictly AFTER epoch $1 (a container started after 05:00 waits
# for tomorrow's 05:00; started before, for today's).
backup_next_run_epoch() {
  local day slot
  day="$(backup_local_day "$1")"
  slot="$(backup_slot_epoch "$day")"
  if [ "$slot" -le "$1" ]; then
    slot="$(backup_slot_epoch "$(backup_shift_day "$day" 1)")"
  fi
  echo "$slot"
}

# Latest slot AT OR BEFORE epoch $1 — the run that should already exist.
backup_last_slot_epoch() {
  local day slot
  day="$(backup_local_day "$1")"
  slot="$(backup_slot_epoch "$day")"
  if [ "$slot" -gt "$1" ]; then
    slot="$(backup_slot_epoch "$(backup_shift_day "$day" -1)")"
  fi
  echo "$slot"
}

# UTC epoch encoded in the newest daily dump's name (empty if there is none).
backup_newest_epoch() {
  local files newest ts
  shopt -s nullglob
  files=("$BACKUP_DIR/$BACKUP_DAILY_PREFIX"-*.sql.gz)
  shopt -u nullglob
  [ "${#files[@]}" -gt 0 ] || return 0
  newest="$(basename "${files[$((${#files[@]} - 1))]}")"
  ts="${newest#"$BACKUP_DAILY_PREFIX"-}"
  ts="${ts:0:16}"
  if [[ "$ts" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$ ]]; then
    date -u -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}" +%s
  fi
}

# Due when the most recent slot has no dump taken at/after it.
backup_is_due() {
  local newest
  newest="$(backup_newest_epoch)"
  [ -z "$newest" ] || [ "$newest" -lt "$(backup_last_slot_epoch "$1")" ]
}

backup_fmt() {
  echo "$(TZ="$BACKUP_TZ_RESOLVED" date -d "@$1" '+%Y-%m-%d %H:%M:%S %Z') ($(date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ))"
}

backup_resolve_config() {
  BACKUP_TZ_RESOLVED="$(backup_tz)"
  BACKUP_AT_RESOLVED="$(backup_at)"
  BACKUP_KEEP_RESOLVED="$(backup_int BACKUP_DAILY_KEEP 7)"
  BACKUP_RETRY_RESOLVED="$(backup_int BACKUP_RETRY_SECONDS 900)"
  BACKUP_MAX_SLEEP_RESOLVED="$(backup_int BACKUP_MAX_SLEEP_SECONDS 3600)"
}

backup_check() {
  local newest age max
  max="$(backup_int BACKUP_HEALTH_MAX_AGE_SECONDS 93600)"
  newest="$(backup_newest_epoch)"
  if [ -z "$newest" ]; then
    echo "[db-backup] UNHEALTHY: no daily dump in $BACKUP_DIR" >&2
    return 1
  fi
  age=$(($(backup_now) - newest))
  if [ "$age" -gt "$max" ]; then
    echo "[db-backup] UNHEALTHY: newest daily dump is ${age}s old (> ${max}s)" >&2
    return 1
  fi
  echo "[db-backup] healthy: newest daily dump is ${age}s old"
}

backup_cron_main() {
  local cycles=0 max_cycles now next wait announced=""
  backup_resolve_config
  max_cycles="$(backup_int BACKUP_CRON_MAX_CYCLES 0 2>/dev/null)"

  backup_log "daily scheduler starting: at ${BACKUP_AT_RESOLVED} ${BACKUP_TZ_RESOLVED}, keep ${BACKUP_KEEP_RESOLVED}, dir ${BACKUP_DIR}"

  while :; do
    now="$(backup_now)"
    if backup_is_due "$now"; then
      backup_log "daily backup due (slot $(backup_fmt "$(backup_last_slot_epoch "$now")"))"
      if BACKUP_RETENTION="$BACKUP_KEEP_RESOLVED" BACKUP_PREFIX="$BACKUP_DAILY_PREFIX" \
        bash "${SCRIPT_DIR}/backup-db.sh"; then
        backup_log "daily backup ok @ $(date -u +%Y-%m-%dT%H:%M:%SZ)"
        now="$(backup_now)"
      elif backup_is_due "$now"; then
        echo "[db-backup] ERROR: daily backup FAILED — older dumps kept; retrying in ${BACKUP_RETRY_RESOLVED}s" >&2
        sleep "$BACKUP_RETRY_RESOLVED"
        cycles=$((cycles + 1))
        if [ "$max_cycles" -gt 0 ] && [ "$cycles" -ge "$max_cycles" ]; then return 0; fi
        continue
      else
        # The verified dump is on disk; only a later step (off-box upload) failed.
        echo "[db-backup] ERROR: daily backup finished with an error (local dump kept) — see above" >&2
        now="$(backup_now)"
      fi
    fi

    next="$(backup_next_run_epoch "$now")"
    if [ "$next" != "$announced" ]; then
      backup_log "next daily backup at $(backup_fmt "$next")"
      announced="$next"
    fi
    wait=$((next - now))
    [ "$wait" -ge 1 ] || wait=1
    [ "$wait" -le "$BACKUP_MAX_SLEEP_RESOLVED" ] || wait="$BACKUP_MAX_SLEEP_RESOLVED"
    sleep "$wait"

    cycles=$((cycles + 1))
    if [ "$max_cycles" -gt 0 ] && [ "$cycles" -ge "$max_cycles" ]; then return 0; fi
  done
}

# Run only when executed (tests `source` this file to call the functions).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    --next)
      backup_resolve_config
      backup_log "next daily backup at $(backup_fmt "$(backup_next_run_epoch "$(backup_now)")")"
      ;;
    --check) backup_check ;;
    "") backup_cron_main ;;
    *)
      echo "usage: $0 [--next|--check]" >&2
      exit 2
      ;;
  esac
fi
