#!/usr/bin/env bash
#
# Telegram bot alert (card zDUUxyH2). Host cron, every 5 min, user in the docker group:
#   */5 * * * * ELCHI_APP_DIR=/home/<user>/apps/backend /home/<user>/elchi-ops/bot-alert.sh
#
# Checks (read-only):
#   token      getMe (TELEGRAM_BOT_TOKEN from .env.production). Telegram unreachable
#              (curl error / 5xx) is reported separately from a broken token (401/404).
#   webhook    getWebhookInfo — only when the bot runs in webhook mode (resolved like
#              notification-service resolveBotConfig): url == TELEGRAM_WEBHOOK_URL when
#              set (else ends with /telegram/webhook/<TELEGRAM_BOT_SLUG|elchi>), no
#              last_error in the last BOT_ALERT_WEBHOOK_ERROR_MIN (15) min,
#              pending_update_count < BOT_ALERT_PENDING_UPDATES_MAX (100)
#   outbox     telegram_outbox (BEGIN READ ONLY, statement_timeout 10s): oldest overdue
#              `pending` < BOT_ALERT_OUTBOX_PENDING_MIN (10) min; `dead` in the last hour
#              <= BOT_ALERT_OUTBOX_DEAD_MAX (20); `sending` stuck > BOT_ALERT_OUTBOX_PENDING_MIN
#   service    exactly one notification-service container (compose project + oneoff=False)
#              running AND healthy; RestartCount must not grow (crash-loop); health
#              `starting` accepted only within BOT_ALERT_NS_START_GRACE_S (90) of StartedAt
# Debounce: a check is reported when it fails on this run and on one of the 2 previous runs
# (so a flapping check is caught too); a crash-loop (>= 2 restarts within
# BOT_ALERT_RESTART_WINDOW_MIN, 30) is reported at once. "tiklandi" is sent only after 2
# consecutive fully clean runs; until then the problem state is held (no message).
#
# Sends (only what is configured; nothing configured = log line only). The channel does
# NOT depend on the main bot: if the bot token is broken the alert must still arrive.
#   Webhook   BOT_ALERT_WEBHOOK_URL — plain-text POST (ntfy topic, Slack/Discord-compatible relay)
#   Telegram  BOT_ALERT_TELEGRAM_CHAT_ID + BOT_ALERT_TELEGRAM_BOT_TOKEN — a SEPARATE bot;
#             refused when it equals the main TELEGRAM_BOT_TOKEN
#   Heartbeat BOT_ALERT_HEARTBEAT_URL — GET on every healthy run, GET <url>/fail on a problem
# De-duplicated by check codes (not by free text): a message on OK->PROBLEM, when the set
# of failing checks changes, every BOT_ALERT_REPEAT_HOURS (6) while it lasts, and one
# "tiklandi" on recovery. If no channel accepted the message the state is NOT advanced,
# so the next run retries. Secrets never reach argv/ps or the log (curl -K -).
#
# Config: $ELCHI_OPS_DIR/bot-alert.env (KEY=VALUE lines, parsed — never sourced; comments
#         on their own line) or the same keys in .env.production. Environment variables of the
#         same name override BOT_ALERT_CMD_TIMEOUT / BOT_ALERT_HOST_LABEL / BOT_ALERT_TELEGRAM_API.
# Usage:  bot-alert.sh [--dry-run] [--test]
#   --dry-run  evaluate + print the message, send nothing, do not change the state
#   --test     send one test message to the configured channels (and ping the heartbeat)
set -uo pipefail
umask 077

APP_DIR="${ELCHI_APP_DIR:-$HOME/apps/backend}"
OPS_DIR="${ELCHI_OPS_DIR:-$HOME/elchi-ops}"
CONF="$OPS_DIR/bot-alert.env"
STATE_DIR="$OPS_DIR/state"
STATE="$STATE_DIR/bot-alert.state"
LOG="$OPS_DIR/logs/bot-alert.log"
NOW="${BOT_ALERT_NOW:-$(date +%s)}"

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
# One run at a time: a hung docker/DB must not pile up processes every 5 minutes.
if command -v flock > /dev/null 2>&1; then
  exec 9> "$STATE_DIR/bot-alert.lock"
  if ! flock -n 9; then
    # cron: another run is in progress — stay silent. Manual --dry-run/--test: say so.
    [ "$MODE" = run ] && exit 0
    echo "bot-alert: boshqa nusxa ishlayapti (lock band) — keyinroq urinib ko'ring" >&2
    exit 3
  fi
fi
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(ts) $*" >> "$LOG"; [ "$MODE" = run ] || echo "$*"; }
# Bounded external command (docker / psql may hang).
bounded() {
  if command -v timeout > /dev/null 2>&1; then
    timeout -k 5 "$CMD_TIMEOUT" "$@" 9>&-
  else
    "$@" 9>&-
  fi
}

# KEY from the alert config, else from .env.production. Never printed. Strips CR, a trailing
# ` # comment`, surrounding blanks and one pair of surrounding quotes.
cfg() {
  local v=""
  [ -f "$CONF" ] && v="$(grep -E "^$1=" "$CONF" | tail -n 1 | cut -d= -f2-)"
  [ -z "$v" ] && [ -f "$APP_DIR/.env.production" ] &&
    v="$(grep -E "^$1=" "$APP_DIR/.env.production" | tail -n 1 | cut -d= -f2-)"
  v="${v//$'\r'/}"
  v="$(printf '%s' "$v" | sed -E 's/^[[:space:]]+//')"
  case "$v" in
    # Quoted value: everything up to the closing quote (a ' #' inside is data).
    \"*) v="$(printf '%s' "${v#\"}" | sed -E 's/".*$//')" ;;
    \'*) v="$(printf '%s' "${v#\'}" | sed -E "s/'.*$//")" ;;
    *) v="$(printf '%s' "$v" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//')" ;;
  esac
  printf '%s' "$v"
}
num() { case "$1" in '' | *[!0-9]*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

HOST_LABEL="${BOT_ALERT_HOST_LABEL:-$(cfg BOT_ALERT_HOST_LABEL)}"
HOST_LABEL="${HOST_LABEL:-$(hostname 2>/dev/null || echo server)}"
TG_API="${BOT_ALERT_TELEGRAM_API:-$(cfg BOT_ALERT_TELEGRAM_API)}"
TG_API="${TG_API:-https://api.telegram.org}"
CMD_TIMEOUT="$(num "${BOT_ALERT_CMD_TIMEOUT:-$(cfg BOT_ALERT_CMD_TIMEOUT)}" 30)"
RESTART_WINDOW_S=$(($(num "$(cfg BOT_ALERT_RESTART_WINDOW_MIN)" 30) * 60))

PENDING_UPDATES_MAX="$(num "$(cfg BOT_ALERT_PENDING_UPDATES_MAX)" 100)"
WEBHOOK_ERROR_MIN="$(num "$(cfg BOT_ALERT_WEBHOOK_ERROR_MIN)" 15)"
OUTBOX_PENDING_MIN="$(num "$(cfg BOT_ALERT_OUTBOX_PENDING_MIN)" 10)"
OUTBOX_DEAD_MAX="$(num "$(cfg BOT_ALERT_OUTBOX_DEAD_MAX)" 20)"
NS_START_GRACE_S="$(num "$(cfg BOT_ALERT_NS_START_GRACE_S)" 90)"
REPEAT_H="$(num "$(cfg BOT_ALERT_REPEAT_HOURS)" 6)"
BOT_TOKEN="$(cfg TELEGRAM_BOT_TOKEN)"
BOT_SLUG="$(lower "$(cfg TELEGRAM_BOT_SLUG)")"
printf '%s' "$BOT_SLUG" | grep -Eq '^[a-z0-9_-]{1,32}$' || BOT_SLUG=elchi
WEBHOOK_URL_EXPECTED="$(cfg TELEGRAM_WEBHOOK_URL)"

# notification-service isUsableBotToken: has ':' and is not a placeholder.
usable_token() {
  case "$1" in *:*) ;; *) return 1 ;; esac
  ! printf '%s' "$1" | grep -Eiq 'replace|change|placeholder|your[_-]?token|example|xxx'
}

# Same decision as notification-service resolveBotConfig: is the webhook expected?
bot_mode() {
  local requested secret leader
  usable_token "$BOT_TOKEN" || { echo off; return; }
  requested="$(lower "$(cfg TELEGRAM_BOT_MODE)")"
  requested="${requested:-auto}"
  secret="$(cfg TELEGRAM_WEBHOOK_SECRET)"
  printf '%s' "$secret" | grep -Eq '^[A-Za-z0-9_-]{16,256}$' || secret=""
  leader="$(lower "$(cfg BOT_POLLING_LEADER)")"
  case "$requested" in
    off) echo off ;;
    webhook) if [ -n "$secret" ]; then echo webhook; else echo off; fi ;;
    auto)
      if [ -n "$secret" ]; then echo webhook
      elif [ "$leader" = true ] || [ "$leader" = 1 ] || [ "$leader" = yes ]; then echo polling
      else echo off; fi
      ;;
    polling)
      if [ "$leader" = true ] || [ "$leader" = 1 ] || [ "$leader" = yes ]; then echo polling; else echo off; fi
      ;;
    *) echo off ;;
  esac
}
BOT_MODE="$(bot_mode)"

# Telegram Bot API GET (token only via curl -K -). Sets TG_BODY and TG_STATUS
# (HTTP code; 000 = no answer: DNS, timeout, connection refused).
TG_BODY=""
TG_STATUS=000
tg_get() {
  local out
  out="$(printf 'url = "%s/bot%s/%s"\n' "$TG_API" "$BOT_TOKEN" "$1" |
    curl -sS --max-time 15 -w '\n%{http_code}' -K - 2>/dev/null)" || out="$out"$'\n000'
  TG_STATUS="$(printf '%s' "$out" | tail -n 1 | grep -Eo '^[0-9]{3}$' || echo 000)"
  TG_BODY="$(printf '%s' "$out" | sed '$d')"
}
json_str() { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -n 1 | sed -E "s/^\"$2\":\"(.*)\"$/\\1/"; }
json_num() { printf '%s' "$1" | grep -o "\"$2\":[0-9]*" | head -n 1 | sed -E "s/^\"$2\"://"; }

# ---- checks: each problem = code (dedupe / debounce key) + human text -------------
CODES=()
TEXTS=()
problem() { CODES+=("$1"); TEXTS+=("$2"); }

# a) token
TG_REACHABLE=true
if [ -z "$BOT_TOKEN" ]; then
  problem token_missing "Token: TELEGRAM_BOT_TOKEN topilmadi"
else
  tg_get getMe
  case "$TG_STATUS" in
    200) printf '%s' "$TG_BODY" | grep -q '"ok":true' ||
      problem token_invalid "Token: getMe ok emas" ;;
    401 | 404) problem token_invalid "Token: getMe $TG_STATUS (token buzuq yoki almashtirilgan)" ;;
    *)
      TG_REACHABLE=false
      problem tg_unreachable "Telegram API javob bermadi (HTTP $TG_STATUS)"
      ;;
  esac
fi

# b) webhook
if [ "$BOT_MODE" = webhook ] && [ "$TG_REACHABLE" = true ] && [ -n "$BOT_TOKEN" ]; then
  tg_get getWebhookInfo
  if [ "$TG_STATUS" != 200 ] || ! printf '%s' "$TG_BODY" | grep -q '"ok":true'; then
    problem webhook_info "Webhook: getWebhookInfo javob bermadi (HTTP $TG_STATUS)"
  else
    url="$(json_str "$TG_BODY" url)"
    if [ -z "$url" ]; then
      problem webhook_url "Webhook: o'rnatilmagan (url bo'sh)"
    elif [ -n "$WEBHOOK_URL_EXPECTED" ]; then
      [ "$url" = "$WEBHOOK_URL_EXPECTED" ] ||
        problem webhook_url "Webhook: boshqa manzil (TELEGRAM_WEBHOOK_URL kutilgan)"
    else
      case "$url" in
        https://*/telegram/webhook/"$BOT_SLUG") ;;
        *) problem webhook_url "Webhook: boshqa manzil (…/telegram/webhook/$BOT_SLUG kutilgan)" ;;
      esac
    fi
    pend="$(num "$(json_num "$TG_BODY" pending_update_count)" 0)"
    [ "$pend" -lt "$PENDING_UPDATES_MAX" ] ||
      problem webhook_pending "Webhook: navbatda $pend ta update (chegara $PENDING_UPDATES_MAX)"
    led="$(num "$(json_num "$TG_BODY" last_error_date)" 0)"
    if [ "$led" -gt 0 ] && [ $((NOW - led)) -lt $((WEBHOOK_ERROR_MIN * 60)) ]; then
      problem webhook_error "Webhook: Telegram yetkaza olmadi ($(json_str "$TG_BODY" last_error_message | cut -c1-120))"
    fi
  fi
fi

# c) outbox — read-only SQL in the postgres container (local socket, no password),
#    statement/lock timeouts so a stuck DB cannot hang the run.
PG_CONTAINER="$(cfg BOT_ALERT_PG_CONTAINER)"
PG_CONTAINER="${PG_CONTAINER:-elchi-postgres}"
PG_USER="$(cfg POSTGRES_USER)"
PG_DB="$(cfg POSTGRES_DB)"
SQL="SELECT COALESCE(EXTRACT(EPOCH FROM now() - MIN(next_attempt_at))::bigint, 0) FROM notification_schema.telegram_outbox WHERE status = 'pending' AND next_attempt_at <= now(); SELECT COUNT(*) FROM notification_schema.telegram_outbox WHERE status = 'dead' AND updated_at > now() - interval '1 hour'; SELECT COUNT(*) FROM notification_schema.telegram_outbox WHERE status = 'sending' AND updated_at < now() - interval '$OUTBOX_PENDING_MIN minutes';"
if out="$(bounded docker exec -i -e PGOPTIONS='-c statement_timeout=10s -c lock_timeout=5s' \
  "$PG_CONTAINER" psql -X -q -t -A -v ON_ERROR_STOP=1 \
  -U "${PG_USER:-postgres}" -d "${PG_DB:-postgres}" -c "BEGIN READ ONLY; $SQL COMMIT;" 2>/dev/null)"; then
  nums="$(printf '%s\n' "$out" | grep -E '^[0-9]+$')"
  age="$(num "$(printf '%s\n' "$nums" | sed -n 1p)" 0)"
  dead="$(num "$(printf '%s\n' "$nums" | sed -n 2p)" 0)"
  stuck="$(num "$(printf '%s\n' "$nums" | sed -n 3p)" 0)"
  [ "$age" -lt $((OUTBOX_PENDING_MIN * 60)) ] ||
    problem outbox_pending "Outbox: eng eski kutilayotgan xabar $((age / 60)) daq (chegara $OUTBOX_PENDING_MIN)"
  [ "$dead" -le "$OUTBOX_DEAD_MAX" ] ||
    problem outbox_dead "Outbox: oxirgi soatda $dead ta dead (chegara $OUTBOX_DEAD_MAX)"
  [ "$stuck" -eq 0 ] ||
    problem outbox_sending "Outbox: $stuck ta xabar 'sending' holatida qotgan (> $OUTBOX_PENDING_MIN daq)"
else
  problem outbox_unchecked "Outbox: tekshirib bo'lmadi ($PG_CONTAINER: so'rov bajarilmadi yoki timeout)"
fi

# d) notification-service container: exactly one (this compose project, not a one-off run)
NS_ID="$(cfg BOT_ALERT_NS_CONTAINER)"
NS_RESTARTS=""
if [ -z "$NS_ID" ]; then
  project="$(cfg BOT_ALERT_COMPOSE_PROJECT)"
  [ -n "$project" ] || project="$(cfg COMPOSE_PROJECT_NAME)"
  filters=(--filter label=com.docker.compose.service=notification-service --filter label=com.docker.compose.oneoff=False)
  [ -n "$project" ] && filters+=(--filter "label=com.docker.compose.project=$project")
  if ids="$(bounded docker ps -a -q "${filters[@]}" 2>/dev/null)"; then
    n="$(printf '%s\n' "$ids" | grep -c . || true)"
    if [ "$n" -eq 1 ]; then
      NS_ID="$ids"
    elif [ "$n" -eq 0 ]; then
      problem ns_missing "notification-service: konteyner topilmadi"
    else
      problem ns_ambiguous "notification-service: $n ta konteyner mos keldi (BOT_ALERT_COMPOSE_PROJECT yoki BOT_ALERT_NS_CONTAINER bering)"
    fi
  else
    problem ns_unchecked "notification-service: tekshirib bo'lmadi (docker javob bermadi)"
  fi
fi
if [ -n "$NS_ID" ]; then
  inspect_err="$STATE_DIR/.inspect.err"
  st="$(bounded docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}} {{.RestartCount}} {{.State.StartedAt}}' "$NS_ID" 2> "$inspect_err")"
  inspect_rc=$?
  if [ "$inspect_rc" -eq 0 ] && [ -n "$st" ]; then
    read -r ns_status ns_health ns_restarts ns_started <<< "$st"
    NS_RESTARTS="$(num "${ns_restarts:-}" 0)"
    started_s="$(date -d "${ns_started:-}" +%s 2>/dev/null || echo 0)"
    case "$ns_status $ns_health" in
      "running healthy" | "running no-healthcheck") ;;
      "running starting")
        if [ "$started_s" -le 0 ] || [ $((NOW - started_s)) -gt "$NS_START_GRACE_S" ]; then
          problem ns_unhealthy "notification-service: healthcheck ${NS_START_GRACE_S}s dan beri 'starting'"
        fi
        ;;
      *) problem ns_unhealthy "notification-service: $ns_status $ns_health" ;;
    esac
  elif grep -qi 'no such object\|no such container' "$inspect_err" 2> /dev/null; then
    problem ns_missing "notification-service: konteyner topilmadi ($NS_ID)"
  else
    problem ns_unchecked "notification-service: tekshirib bo'lmadi (docker inspect: kod $inspect_rc)"
  fi
  rm -f "$inspect_err"
fi

# ---- previous state ------------------------------------------------------------
sget() { [ -f "$STATE" ] && sed -n "s/^$1=//p" "$STATE" | head -n 1; }
PREV="$(sget state)"
PREV_SIG="$(sget sig)"
LAST_SENT="$(num "$(sget last_sent)" "")"
SINCE="$(sget since)"
PREV_NS_ID="$(sget ns_id)"
PREV_NS_RESTARTS="$(num "$(sget ns_restarts)" "")"
PREV_OK_STREAK="$(num "$(sget ok_streak)" 0)"
RESTART_TIMES="$(sget restart_times)"

# Crash-loop: count RestartCount increases of the same container inside the window;
# >= 2 increases → ns_restart, confirmed at once (a slow loop never fails 2 runs in a row).
if [ -n "$NS_RESTARTS" ] && [ "$NS_ID" = "$PREV_NS_ID" ] &&
  [ -n "$PREV_NS_RESTARTS" ] && [ "$NS_RESTARTS" -gt "$PREV_NS_RESTARTS" ]; then
  RESTART_TIMES="${RESTART_TIMES:+$RESTART_TIMES,}$NOW"
fi
[ "$NS_ID" = "$PREV_NS_ID" ] || RESTART_TIMES=""
kept=""
for t in ${RESTART_TIMES//,/ }; do
  t="$(num "$t" 0)"
  [ $((NOW - t)) -lt "$RESTART_WINDOW_S" ] && kept="${kept:+$kept,}$t"
done
RESTART_TIMES="$kept"
restarts_in_window="$(printf '%s' "$RESTART_TIMES" | tr ',' '\n' | grep -c . || true)"
if [ "$restarts_in_window" -ge 2 ]; then
  problem ns_restart "notification-service: qayta ishga tushmoqda (${restarts_in_window} marta $((RESTART_WINDOW_S / 60)) daq ichida, RestartCount $NS_RESTARTS)"
fi

RAW="$(printf '%s\n' "${CODES[@]:-}" | grep . | sort -u | tr '\n' ',' | sed 's/,$//')"
if [ ! -f "$STATE" ] || grep -q '^raw=' "$STATE"; then
  PREV_RAW="$(sget raw)"
  PREV_RAW2="$(sget raw2)"
else
  # State from an older version (no raw=): take the current checks as history so the
  # upgrade neither fakes a recovery nor re-alerts.
  PREV_RAW="$RAW"
  PREV_RAW2=""
fi

# Debounce: a failing check is confirmed when it also failed on one of the 2 previous
# runs (catches flapping too); ns_restart is confirmed at once.
CONF_TEXTS=()
CONF_CODES=()
for i in "${!CODES[@]}"; do
  case "${CODES[$i]}" in
    ns_restart) ;;
    *)
      case ",$PREV_RAW,$PREV_RAW2," in *",${CODES[$i]},"*) ;; *) continue ;; esac
      ;;
  esac
  CONF_CODES+=("${CODES[$i]}")
  CONF_TEXTS+=("${TEXTS[$i]}")
done

if [ -z "$RAW" ]; then OK_STREAK=$((PREV_OK_STREAK + 1)); else OK_STREAK=0; fi

HOLD=false
if [ "${#CONF_CODES[@]}" -gt 0 ]; then
  CUR=problem
  SIG="$(printf '%s\n' "${CONF_CODES[@]}" | sort -u | tr '\n' ',' | sed 's/,$//')"
elif [ "$PREV" = problem ] && [ "$OK_STREAK" -lt 2 ]; then
  # Not confirmed now, but not clean twice either: keep the alert state, send nothing
  # (no false "tiklandi" when the failing set changes or a container is still starting).
  CUR=problem
  SIG="${PREV_SIG:-ok}"
  HOLD=true
else
  CUR=ok
  SIG=ok
fi
[ "$PREV" = "$CUR" ] || SINCE="$NOW"

SEND=""
if [ "$MODE" = test ]; then
  SEND=test
elif [ "$CUR" = problem ] && [ "$HOLD" = false ]; then
  if [ "$PREV" != problem ] || [ "$PREV_SIG" != "$SIG" ] ||
    [ -z "$LAST_SENT" ] || [ $((NOW - LAST_SENT)) -ge $((REPEAT_H * 3600)) ]; then
    SEND=problem
  fi
elif [ "$CUR" = ok ] && [ "$PREV" = problem ]; then
  SEND=recovered
fi

case "$SEND" in
  problem) MSG="⚠️ Elchi bot NOSOG'LOM ($HOST_LABEL, $(ts))"$'\n'"$(printf -- '- %s\n' "${CONF_TEXTS[@]}")"$'\n'"Runbook: docs/ops/telegram-bot.md «Kuzatuv»" ;;
  recovered) MSG="✅ Elchi bot tiklandi ($HOST_LABEL, $(ts)) — hamma tekshiruv ok" ;;
  test) MSG="ℹ️ Elchi bot alert — test xabar ($HOST_LABEL, $(ts)). Hozirgi holat: ${#CODES[@]} muammo${RAW:+ ($RAW)}" ;;
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
  if printf 'url = "%s%s"\n' "$hb" "$1" | curl -sS -o /dev/null --fail --max-time 15 -K - 2>/dev/null; then
    return 0
  fi
  log "WARN: heartbeat ping yuborilmadi"
  return 1
}

if [ "$MODE" = dry ]; then
  echo "state=$CUR prev=${PREV:-none} send=${SEND:-none} raw=${RAW:-none}"
  [ -n "$MSG" ] && printf '%s\n' "$MSG"
  exit 0
fi

if [ "$MODE" = test ]; then
  send_all "$MSG" || true
  heartbeat "" && log "test: heartbeat ok"
  log "test yuborildi (sent_any=$sent_any)"
  exit 0
fi

if [ -n "$SEND" ]; then
  send_all "$MSG" || true
  if [ "$sent_any" = true ]; then
    log "$SEND yuborildi: ${CONF_CODES[*]:-ok}"
    LAST_SENT="$NOW"
  else
    log "ALERT ($SEND) — kanal sozlanmagan yoki yuborilmadi: ${CONF_CODES[*]:-ok}"
  fi
fi

if [ "$CUR" = ok ]; then heartbeat "" || true; else heartbeat "/fail" || true; fi
[ "$CUR" = problem ] && [ -z "$SEND" ] && log "problem davom etmoqda (xabar ${REPEAT_H}h da qayta): ${CONF_CODES[*]:-$SIG}"
[ "$CUR" = ok ] && [ "$PREV" != ok ] && log "ok"

# A message that no channel accepted is retried on the next run: keep the previous
# alert state (state/sig/last_sent), but always record raw checks and restart count.
if [ -n "$SEND" ] && [ "$sent_any" != true ] && [ -n "$(cfg BOT_ALERT_WEBHOOK_URL)$(cfg BOT_ALERT_TELEGRAM_CHAT_ID)" ]; then
  CUR="${PREV:-ok}"
  SIG="${PREV_SIG:-ok}"
  LAST_SENT="$(num "$(sget last_sent)" "")"
  SINCE="$(sget since)"
fi

{
  echo "state=$CUR"
  echo "sig=$SIG"
  echo "raw=$RAW"
  echo "raw2=$PREV_RAW"
  echo "ok_streak=$OK_STREAK"
  echo "since=$SINCE"
  echo "last_sent=${LAST_SENT:-}"
  echo "checked_at=$NOW"
  echo "ns_id=$NS_ID"
  echo "ns_restarts=$NS_RESTARTS"
  echo "restart_times=$RESTART_TIMES"
} > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"

tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG"
[ "${#CODES[@]}" -eq 0 ]
