#!/usr/bin/env bash
#
# Telegram bot alert (card zDUUxyH2). Host cron, every 5 min, user in the docker group:
#   */5 * * * * /home/<user>/elchi-ops/bot-alert.sh
#
# Checks (read-only):
#   token      getMe ok (TELEGRAM_BOT_TOKEN from .env.production)
#   webhook    getWebhookInfo: url ends with /telegram/webhook/<TELEGRAM_BOT_SLUG|elchi>,
#              no last_error in the last BOT_ALERT_WEBHOOK_ERROR_MIN (15) minutes,
#              pending_update_count < BOT_ALERT_PENDING_UPDATES_MAX (100)
#              (skipped when TELEGRAM_BOT_MODE=polling)
#   outbox     telegram_outbox: oldest overdue `pending` < BOT_ALERT_OUTBOX_PENDING_MIN (10) min,
#              `dead` in the last hour <= BOT_ALERT_OUTBOX_DEAD_MAX (20)  — SELECT only
#   service    notification-service container running AND (healthy)
#
# Sends (only what is configured; nothing configured = log line only). The channel does
# NOT depend on the main bot: if the bot token is broken the alert must still arrive.
#   Webhook   BOT_ALERT_WEBHOOK_URL — plain-text POST (ntfy topic, Slack/Discord-compatible relay)
#   Telegram  BOT_ALERT_TELEGRAM_CHAT_ID + BOT_ALERT_TELEGRAM_BOT_TOKEN — a SEPARATE bot;
#             refused when it equals the main TELEGRAM_BOT_TOKEN
#   Heartbeat BOT_ALERT_HEARTBEAT_URL — GET on every healthy run, GET <url>/fail on a problem
#             (dead-man switch: fires when the server is down and this script cannot run)
# De-duplicated: a message on OK->PROBLEM, when the problem set changes, every
# BOT_ALERT_REPEAT_HOURS (6) while it lasts, and one "tiklandi" on recovery.
# Secrets (tokens, URLs, DB password) never reach argv/ps or the log: curl reads them via -K -.
#
# Config: $ELCHI_OPS_DIR/bot-alert.env (KEY=VALUE lines, parsed — never sourced)
#         or the same keys in .env.production.
# Usage:  bot-alert.sh [--dry-run] [--test]
#   --dry-run  evaluate + print the message, send nothing, do not change the state
#   --test     send one test message to the configured channels
set -uo pipefail
umask 077

APP_DIR="${ELCHI_APP_DIR:-/home/shodiyor/apps/backend}"
OPS_DIR="${ELCHI_OPS_DIR:-$HOME/elchi-ops}"
CONF="$OPS_DIR/bot-alert.env"
STATE_DIR="$OPS_DIR/state"
STATE="$STATE_DIR/bot-alert.state"
LOG="$OPS_DIR/logs/bot-alert.log"
HOST_LABEL="${BOT_ALERT_HOST_LABEL:-$(hostname 2>/dev/null || echo server)}"
NOW="${BOT_ALERT_NOW:-$(date +%s)}"
TG_API="${BOT_ALERT_TELEGRAM_API:-https://api.telegram.org}"

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
num() { case "$1" in '' | *[!0-9]*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac; }

PENDING_UPDATES_MAX="$(num "$(cfg BOT_ALERT_PENDING_UPDATES_MAX)" 100)"
WEBHOOK_ERROR_MIN="$(num "$(cfg BOT_ALERT_WEBHOOK_ERROR_MIN)" 15)"
OUTBOX_PENDING_MIN="$(num "$(cfg BOT_ALERT_OUTBOX_PENDING_MIN)" 10)"
OUTBOX_DEAD_MAX="$(num "$(cfg BOT_ALERT_OUTBOX_DEAD_MAX)" 20)"
REPEAT_H="$(num "$(cfg BOT_ALERT_REPEAT_HOURS)" 6)"
BOT_TOKEN="$(cfg TELEGRAM_BOT_TOKEN)"
BOT_SLUG="$(cfg TELEGRAM_BOT_SLUG)"
BOT_SLUG="${BOT_SLUG:-elchi}"
BOT_MODE="$(cfg TELEGRAM_BOT_MODE)"

# Telegram Bot API GET (token only via curl -K -). Prints the JSON body.
tg_get() {
  printf 'url = "%s/bot%s/%s"\n' "$TG_API" "$BOT_TOKEN" "$1" |
    curl -sS --max-time 15 -K - 2>/dev/null
}
json_str() { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -n 1 | sed -E "s/^\"$2\":\"(.*)\"$/\\1/"; }
json_num() { printf '%s' "$1" | grep -o "\"$2\":[0-9]*" | head -n 1 | sed -E "s/^\"$2\"://"; }

# ---- checks ---------------------------------------------------------------------
PROBLEMS=()

# a) token
if [ -z "$BOT_TOKEN" ]; then
  PROBLEMS+=("Token: TELEGRAM_BOT_TOKEN topilmadi")
else
  me="$(tg_get getMe)"
  if ! printf '%s' "$me" | grep -q '"ok":true'; then
    PROBLEMS+=("Token: getMe xato ($(json_str "$me" description | cut -c1-120))")
  fi
fi

# b) webhook
if [ -n "$BOT_TOKEN" ] && [ "$BOT_MODE" != polling ]; then
  wh="$(tg_get getWebhookInfo)"
  if ! printf '%s' "$wh" | grep -q '"ok":true'; then
    PROBLEMS+=("Webhook: getWebhookInfo javob bermadi")
  else
    url="$(json_str "$wh" url)"
    case "$url" in
      */telegram/webhook/"$BOT_SLUG") ;;
      '') PROBLEMS+=("Webhook: o'rnatilmagan (url bo'sh)") ;;
      *) PROBLEMS+=("Webhook: boshqa manzil (…/telegram/webhook/$BOT_SLUG kutilgan)") ;;
    esac
    pend="$(num "$(json_num "$wh" pending_update_count)" 0)"
    [ "$pend" -lt "$PENDING_UPDATES_MAX" ] ||
      PROBLEMS+=("Webhook: navbatda $pend ta update (chegara $PENDING_UPDATES_MAX)")
    led="$(num "$(json_num "$wh" last_error_date)" 0)"
    if [ "$led" -gt 0 ] && [ $((NOW - led)) -lt $((WEBHOOK_ERROR_MIN * 60)) ]; then
      PROBLEMS+=("Webhook: Telegram yetkaza olmadi ($(json_str "$wh" last_error_message | cut -c1-120))")
    fi
  fi
fi

# c) outbox (read-only SQL inside the postgres container; password not needed — local socket)
PG_CONTAINER="$(cfg BOT_ALERT_PG_CONTAINER)"
PG_CONTAINER="${PG_CONTAINER:-elchi-postgres}"
PG_USER="$(cfg POSTGRES_USER)"
PG_DB="$(cfg POSTGRES_DB)"
SQL="SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(next_attempt_at))::bigint, 0) FROM notification_schema.telegram_outbox WHERE status = 'pending' AND next_attempt_at <= now(); SELECT COUNT(*) FROM notification_schema.telegram_outbox WHERE status = 'dead' AND updated_at > now() - interval '1 hour';"
if out="$(docker exec -i "$PG_CONTAINER" psql -X -q -t -A -v ON_ERROR_STOP=1 \
  -U "${PG_USER:-postgres}" -d "${PG_DB:-postgres}" -c "BEGIN READ ONLY; $SQL COMMIT;" 2>/dev/null)"; then
  age="$(num "$(printf '%s\n' "$out" | grep -E '^[0-9]+$' | sed -n 1p)" 0)"
  dead="$(num "$(printf '%s\n' "$out" | grep -E '^[0-9]+$' | sed -n 2p)" 0)"
  [ "$age" -lt $((OUTBOX_PENDING_MIN * 60)) ] ||
    PROBLEMS+=("Outbox: eng eski kutilayotgan xabar $((age / 60)) daq (chegara $OUTBOX_PENDING_MIN)")
  [ "$dead" -le "$OUTBOX_DEAD_MAX" ] ||
    PROBLEMS+=("Outbox: oxirgi soatda $dead ta dead (chegara $OUTBOX_DEAD_MAX)")
else
  PROBLEMS+=("Outbox: so'rov bajarilmadi ($PG_CONTAINER)")
fi

# d) notification-service container
NS_CONTAINER="$(cfg BOT_ALERT_NS_CONTAINER)"
if [ -z "$NS_CONTAINER" ]; then
  NS_CONTAINER="$(docker ps -a -q --filter label=com.docker.compose.service=notification-service 2>/dev/null | head -n 1)"
fi
st="missing"
[ -n "$NS_CONTAINER" ] &&
  st="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$NS_CONTAINER" 2>/dev/null)" || true
[ -n "$st" ] || st="missing"
case "$st" in
  "running healthy" | "running starting" | "running no-healthcheck") ;;
  *) PROBLEMS+=("notification-service: $st") ;;
esac

if [ "${#PROBLEMS[@]}" -eq 0 ]; then
  CUR=ok
  SIG=ok
else
  CUR=problem
  SIG="$(printf '%s\n' "${PROBLEMS[@]}" | sed -E 's/[0-9]+/N/g' | sha256sum | cut -c1-16)"
fi

# ---- previous state ------------------------------------------------------------
sget() { [ -f "$STATE" ] && sed -n "s/^$1=//p" "$STATE" | head -n 1; }
PREV="$(sget state)"
PREV_SIG="$(sget sig)"
LAST_SENT="$(sget last_sent)"
SINCE="$(sget since)"
[ "$PREV" = "$CUR" ] || SINCE="$NOW"

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
  problem) MSG="⚠️ Elchi bot NOSOG'LOM ($HOST_LABEL, $(ts))"$'\n'"$(printf -- '- %s\n' "${PROBLEMS[@]}")"$'\n'"Runbook: docs/ops/telegram-bot.md «Kuzatuv»" ;;
  recovered) MSG="✅ Elchi bot tiklandi ($HOST_LABEL, $(ts)) — hamma tekshiruv ok" ;;
  test) MSG="ℹ️ Elchi bot alert — test xabar ($HOST_LABEL, $(ts)). Hozirgi holat: $CUR${PROBLEMS:+ (${#PROBLEMS[@]} muammo)}" ;;
  *) MSG="" ;;
esac

# ---- channels (secrets only via curl -K -) ----------------------------------------
sent_any=false
send_all() {
  local text="$1" chat token hook ok=true
  chat="$(cfg BOT_ALERT_TELEGRAM_CHAT_ID)"
  if [ -n "$chat" ]; then
    token="$(cfg BOT_ALERT_TELEGRAM_BOT_TOKEN)"
    if [ -z "$token" ]; then
      ok=false
      log "WARN: BOT_ALERT_TELEGRAM_BOT_TOKEN yo'q — Telegram kanali o'tkazildi"
    elif [ "$token" = "$BOT_TOKEN" ]; then
      ok=false
      log "WARN: alert boti asosiy bot bilan bir xil — rad etildi (alohida bot kerak)"
    elif printf 'url = "%s/bot%s/sendMessage"\n' "$TG_API" "$token" |
      curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -K - \
        --data-urlencode "chat_id=$chat" --data-urlencode "text=$text" 2>/dev/null | grep -q '^200$'; then
      sent_any=true
    else
      ok=false
      log "WARN: Telegram yuborilmadi (token_len=${#token})"
    fi
  fi
  hook="$(cfg BOT_ALERT_WEBHOOK_URL)"
  if [ -n "$hook" ]; then
    if printf 'url = "%s"\n' "$hook" |
      curl -sS -o /dev/null --fail --max-time 20 -K - -H 'Title: Elchi bot' --data-binary "$text" 2>/dev/null; then
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
  hb="$(cfg BOT_ALERT_HEARTBEAT_URL)"
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
