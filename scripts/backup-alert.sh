#!/usr/bin/env bash
#
# Unhealthy-backup alert (card 6RaEn5cN, "nosog'lom backup alerti"). Host cron,
# every 15 min, user in the docker group:
#   */15 * * * * /home/<user>/elchi-ops/backup-alert.sh
#
# Checks:
#   db-backup       container elchi-db-backup running AND (healthy)   — daily dump ≤ 26h
#   backup-offsite  container elchi-backup-offsite running AND (healthy) — R2 DB copy ≤ 26h
#   minio-offsite   backup-minio-offsite.sh --check on the host status file — R2 MinIO copy ≤ 26h
#
# Sends (only what is configured; nothing configured = log line only):
#   Telegram  BACKUP_ALERT_TELEGRAM_CHAT_ID (+ the bot token: BACKUP_ALERT_TELEGRAM_BOT_TOKEN,
#             else TELEGRAM_BOT_TOKEN read from .env.production at send time, so a
#             BotFather rotation needs no change here)
#   Webhook   BACKUP_ALERT_WEBHOOK_URL — plain-text POST (ntfy.sh topic, Slack/Discord-compatible relays)
#   Heartbeat BACKUP_ALERT_HEARTBEAT_URL — GET on every healthy run, GET <url>/fail on a
#             problem (healthchecks.io-style dead-man switch: it also fires when the
#             whole server is down and this script cannot run at all)
# De-duplicated: a message on OK->PROBLEM, when the problem set changes, every
# BACKUP_ALERT_REPEAT_HOURS (6) while it lasts, and one "tiklandi" on recovery.
# Secrets (bot token, URLs) never reach argv/ps or the log: curl reads them via -K -.
#
# Config: $ELCHI_OPS_DIR/backup-alert.env (KEY=VALUE lines, parsed — never sourced)
#         or the same keys in .env.production.
# Usage:  backup-alert.sh [--dry-run] [--test]
#   --dry-run  evaluate + print the message, send nothing, do not change the state
#   --test     send one test message to the configured channels
set -uo pipefail
umask 077

APP_DIR="${ELCHI_APP_DIR:-/home/shodiyor/apps/backend}"
OPS_DIR="${ELCHI_OPS_DIR:-$HOME/elchi-ops}"
CONF="$OPS_DIR/backup-alert.env"
STATE_DIR="$OPS_DIR/state"
STATE="$STATE_DIR/backup-alert.state"
LOG="$OPS_DIR/logs/backup-alert.log"
MINIO_CHECK="${MINIO_OFFSITE_SCRIPT:-$OPS_DIR/backup-minio-offsite.sh}"
MINIO_STATE="${MINIO_OFFSITE_STATE_DIR:-$OPS_DIR/state/minio-offsite}"
HOST_LABEL="${BACKUP_ALERT_HOST_LABEL:-$(hostname 2>/dev/null || echo server)}"
NOW="${BACKUP_ALERT_NOW:-$(date +%s)}"

MODE=run
case "${1:-}" in
  --dry-run) MODE=dry ;;
  --test) MODE=test ;;
  '') ;;
  *)
    echo "usage: $0 [--dry-run|--test]" >&2
    exit 2
    ;;
esac

mkdir -p "$STATE_DIR" "$(dirname "$LOG")"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(ts) $*" >> "$LOG"; [ "$MODE" = run ] || echo "$*"; }

# KEY from the alert config, else from .env.production. Never printed.
cfg() {
  local v=""
  [ -f "$CONF" ] && v="$(grep -E "^$1=" "$CONF" | tail -n 1 | cut -d= -f2-)"
  [ -z "$v" ] && [ -f "$APP_DIR/.env.production" ] &&
    v="$(grep -E "^$1=" "$APP_DIR/.env.production" | tail -n 1 | cut -d= -f2-)"
  printf '%s' "$v"
}

# ---- checks ---------------------------------------------------------------------
PROBLEMS=()
check_container() {
  local name="$1" label="$2" st
  st="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$name" 2>/dev/null)" || st="missing"
  case "$st" in
    "running healthy") ;;
    "running starting") ;; # just (re)created by a deploy — the next run decides
    *) PROBLEMS+=("$label: $name = $st") ;;
  esac
}
check_container elchi-db-backup "DB kunlik backup"
check_container elchi-backup-offsite "DB off-site (R2)"
if [ -f "$MINIO_CHECK" ]; then
  if ! out="$(MINIO_OFFSITE_STATE_DIR="$MINIO_STATE" MINIO_OFFSITE_NOW="$NOW" sh "$MINIO_CHECK" --check 2>&1)"; then
    PROBLEMS+=("MinIO off-site (R2): ${out#\[minio-offsite\] }")
  fi
else
  PROBLEMS+=("MinIO off-site (R2): $MINIO_CHECK yo'q")
fi

if [ "${#PROBLEMS[@]}" -eq 0 ]; then
  CUR=ok
  SIG=ok
else
  CUR=problem
  SIG="$(printf '%s\n' "${PROBLEMS[@]}" | sed -E 's/[0-9]+s ago/Ns ago/g' | sha256sum | cut -c1-16)"
fi

# ---- previous state ------------------------------------------------------------
sget() { [ -f "$STATE" ] && sed -n "s/^$1=//p" "$STATE" | head -n 1; }
PREV="$(sget state)"
PREV_SIG="$(sget sig)"
LAST_SENT="$(sget last_sent)"
SINCE="$(sget since)"
[ "$PREV" = "$CUR" ] || SINCE="$NOW"
REPEAT_H="$(cfg BACKUP_ALERT_REPEAT_HOURS)"
case "$REPEAT_H" in '' | *[!0-9]*) REPEAT_H=6 ;; esac

SEND=""
if [ "$MODE" = test ]; then
  SEND=test
elif [ "$CUR" = problem ]; then
  if [ "$PREV" != problem ] || [ "$PREV_SIG" != "$SIG" ] ||
    [ -z "$LAST_SENT" ] || [ $((NOW - LAST_SENT)) -ge $((REPEAT_H * 3600)) ]; then
    SEND=problem
  fi
elif [ "$PREV" = problem ]; then
  SEND=recovered
fi

case "$SEND" in
  problem) MSG="⚠️ Elchi backup NOSOG'LOM ($HOST_LABEL, $(ts))"$'\n'"$(printf -- '- %s\n' "${PROBLEMS[@]}")"$'\n'"Runbook: docs/ops/backup-rpo-rto.md §4" ;;
  recovered) MSG="✅ Elchi backup tiklandi ($HOST_LABEL, $(ts)) — hamma tekshiruv healthy" ;;
  test) MSG="ℹ️ Elchi backup alert — test xabar ($HOST_LABEL, $(ts)). Hozirgi holat: $CUR${PROBLEMS:+ (${#PROBLEMS[@]} muammo)}" ;;
  *) MSG="" ;;
esac

# ---- channels (secrets only via curl -K -) ----------------------------------------
sent_any=false
send_all() {
  local text="$1" chat token hook ok=true
  chat="$(cfg BACKUP_ALERT_TELEGRAM_CHAT_ID)"
  if [ -n "$chat" ]; then
    token="$(cfg BACKUP_ALERT_TELEGRAM_BOT_TOKEN)"
    [ -n "$token" ] || token="$(cfg TELEGRAM_BOT_TOKEN)"
    if [ -n "$token" ] && printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
      curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -K - \
        --data-urlencode "chat_id=$chat" --data-urlencode "text=$text" 2>/dev/null | grep -q '^200$'; then
      sent_any=true
    else
      ok=false
      log "WARN: Telegram yuborilmadi (token_len=${#token})"
    fi
  fi
  hook="$(cfg BACKUP_ALERT_WEBHOOK_URL)"
  if [ -n "$hook" ]; then
    if printf 'url = "%s"\n' "$hook" |
      curl -sS -o /dev/null --fail --max-time 20 -K - -H 'Title: Elchi backup' --data-binary "$text" 2>/dev/null; then
      sent_any=true
    else
      ok=false
      log "WARN: webhook yuborilmadi"
    fi
  fi
  $ok
}

heartbeat() {
  local hb
  hb="$(cfg BACKUP_ALERT_HEARTBEAT_URL)"
  [ -n "$hb" ] || return 0
  printf 'url = "%s%s"\n' "$hb" "$1" | curl -sS -o /dev/null --max-time 15 -K - 2>/dev/null ||
    log "WARN: heartbeat ping yuborilmadi"
}

if [ "$MODE" = dry ]; then
  echo "state=$CUR prev=${PREV:-none} send=${SEND:-none}"
  [ -n "$MSG" ] && printf '%s\n' "$MSG"
  exit 0
fi

if [ -n "$SEND" ]; then
  send_all "$MSG" || true
  if [ "$sent_any" = true ]; then
    log "$SEND yuborildi: ${PROBLEMS[*]:-ok}"
    [ "$SEND" = test ] || LAST_SENT="$NOW"
  else
    log "ALERT ($SEND) — kanal sozlanmagan yoki yuborilmadi: ${PROBLEMS[*]:-ok}"
  fi
fi
[ "$MODE" = test ] && exit 0

if [ "$CUR" = ok ]; then heartbeat ""; else heartbeat "/fail"; fi
[ "$CUR" = problem ] && [ -z "$SEND" ] && log "problem davom etmoqda (xabar ${REPEAT_H}h da qayta): ${PROBLEMS[*]}"
[ "$CUR" = ok ] && [ "$PREV" != ok ] && log "ok"

{
  echo "state=$CUR"
  echo "sig=$SIG"
  echo "since=$SINCE"
  echo "last_sent=${LAST_SENT:-}"
  echo "checked_at=$NOW"
} > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"

tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG"
[ "$CUR" = ok ]
