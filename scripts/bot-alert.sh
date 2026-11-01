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
# Alerted set is sticky per check code: a check joins when it fails on this run and on one
# of the 2 previous runs (flapping included); a crash-loop (>= 2 restarts within
# BOT_ALERT_RESTART_WINDOW_MIN, 30, dated by State.StartedAt, + one cron interval of slack)
# joins at once and stays while a restart is still in the window; when 3 of the last 4 runs
# fail with >= 3 different not-yet-alerted checks (or all 4 fail), an `unstable` entry joins.
# A check leaves only after 2 consecutive clean runs (4 when the incident started within
# BOT_ALERT_FLAP_WINDOW_MIN, 60, of the previous "tiklandi"); "tiklandi" only when nothing is
# alerted AND the last 2 (4) runs were fully clean — otherwise the incident is held silently.
#
# Sends (only what is configured; nothing configured = log line only). The channel does
# NOT depend on the main bot: if the bot token is broken the alert must still arrive.
#   Webhook   BOT_ALERT_WEBHOOK_URL — plain-text POST (ntfy topic, Slack/Discord-compatible relay)
#   Telegram  BOT_ALERT_TELEGRAM_CHAT_ID + BOT_ALERT_TELEGRAM_BOT_TOKEN — a SEPARATE bot;
#             refused when it equals the main TELEGRAM_BOT_TOKEN
#   Heartbeat BOT_ALERT_HEARTBEAT_URL — GET on every healthy run, GET <url>/fail on a problem
# De-duplicated by check codes (not by free text): a message on OK->PROBLEM, when a check
# not yet alerted in this incident joins (ns_restart and ns_unhealthy count as one),
# every BOT_ALERT_REPEAT_HOURS (6) while it lasts, and one
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
# Decimal integer or the default ("08" is 8, not an octal error under set -u). Leading zeros
# are dropped first; more than 15 significant digits is capped (bash arithmetic would wrap).
num() {
  local v
  case "$1" in
    '' | *[!0-9]*) printf '%s' "$2" ;;
    *)
      v="${1#"${1%%[!0]*}"}"
      v="${v:-0}"
      if [ "${#v}" -gt 15 ]; then printf '999999999999999'; else printf '%s' "$v"; fi
      ;;
  esac
}
# Integer config knob: knob NAME DEFAULT MIN MAX [RAW [SOURCE]]. Unset/empty → DEFAULT
# silently; not a decimal integer or outside MIN..MAX → WARN with the raw value (other than
# printable ASCII shown as '?', so a rejected value never looks valid; 40 chars, plus its source when not the config file; to stderr, so the $(...)
# capture stays clean) and DEFAULT.
knob() {
  local raw v src=""
  if [ "$#" -ge 5 ]; then raw="$5"; else raw="$(cfg "$1")"; fi
  [ -n "${6:-}" ] && src=" ($6)"
  [ -n "$raw" ] || { printf '%s' "$2"; return; }
  v="$(num "$raw" "")"
  if [ -z "$v" ] || [ "$v" -lt "$3" ] || [ "$v" -gt "$4" ]; then
    log "WARN: $1=$(printf '%s' "$raw" | LC_ALL=C tr -c '[:print:]' '?' | cut -c1-40)$src rad etildi ($3..$4) — $2 ishlatiladi" >&2
    printf '%s' "$2"
    return
  fi
  printf '%s' "$v"
}
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

HOST_LABEL="${BOT_ALERT_HOST_LABEL:-$(cfg BOT_ALERT_HOST_LABEL)}"
HOST_LABEL="${HOST_LABEL:-$(hostname 2>/dev/null || echo server)}"
TG_API="${BOT_ALERT_TELEGRAM_API:-$(cfg BOT_ALERT_TELEGRAM_API)}"
TG_API="${TG_API:-https://api.telegram.org}"
# Bounded: 0 or a huge value would disable the hang protection (a hung docker keeps the lock
# and every later cron run exits silently).
if [ -n "${BOT_ALERT_CMD_TIMEOUT:-}" ]; then
  CMD_TIMEOUT="$(knob BOT_ALERT_CMD_TIMEOUT 30 1 600 "$BOT_ALERT_CMD_TIMEOUT" env)"
else
  CMD_TIMEOUT="$(knob BOT_ALERT_CMD_TIMEOUT 30 1 600)"
fi
# 0 would silently disable crash-loop detection; a huge value overflows the arithmetic.
RESTART_WINDOW_MIN="$(knob BOT_ALERT_RESTART_WINDOW_MIN 30 1 10080)"
RESTART_WINDOW_S=$((RESTART_WINDOW_MIN * 60))
# One cron interval: a restart is dated by StartedAt but seen only on the next run, so a loop
# with a period equal to the window is still caught.
CRON_SLACK_S=300
# A new incident is usually confirmed 2 runs (600 s) after "tiklandi" and the check is strict
# (<): 10 would apply only when a crash-loop (ns_restart, joins at once) returns right away.
# 11 is a policy choice so the window always covers a debounced re-failure.
FLAP_WINDOW_MIN="$(knob BOT_ALERT_FLAP_WINDOW_MIN 60 11 10080)"
FLAP_WINDOW_S=$((FLAP_WINDOW_MIN * 60))

# 0 would alert on a healthy system (pending/updates) or disable the check (webhook error).
PENDING_UPDATES_MAX="$(knob BOT_ALERT_PENDING_UPDATES_MAX 100 1 100000000)"
WEBHOOK_ERROR_MIN="$(knob BOT_ALERT_WEBHOOK_ERROR_MIN 15 1 10080)"
OUTBOX_PENDING_MIN="$(knob BOT_ALERT_OUTBOX_PENDING_MIN 10 1 10080)"
OUTBOX_DEAD_MAX="$(knob BOT_ALERT_OUTBOX_DEAD_MAX 20 0 100000000)"
NS_START_GRACE_S="$(knob BOT_ALERT_NS_START_GRACE_S 90 0 86400)"
# 0 would repeat the message every run (spam).
REPEAT_H="$(knob BOT_ALERT_REPEAT_HOURS 6 1 720)"
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
    401 | 404)
      TG_REACHABLE=false
      problem token_invalid "Token: getMe $TG_STATUS (token buzuq yoki almashtirilgan)"
      ;;
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
NS_PS_FAILED=false
started_s=0
ns_status=""
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
    NS_PS_FAILED=true
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
  else
    # Inspect failed: keep the last known RestartCount of this container so the next
    # increase is not lost.
    [ "$NS_ID" = "$(sed -n 's/^ns_id=//p' "$STATE" 2> /dev/null | head -n 1)" ] &&
      NS_RESTARTS="$(sed -n 's/^ns_restarts=//p' "$STATE" 2> /dev/null | head -n 1)"
  fi
  if [ "$inspect_rc" -eq 0 ] && [ -n "$st" ]; then
    :
  elif grep -qi 'no such object\|no such container' "$inspect_err" 2> /dev/null; then
    problem ns_missing "notification-service: konteyner topilmadi ($NS_ID)"
  else
    problem ns_unchecked "notification-service: tekshirib bo'lmadi (docker inspect: kod $inspect_rc)"
  fi
  rm -f "$inspect_err"
fi

# ---- previous state ------------------------------------------------------------
sget() { [ -f "$STATE" ] && sed -n "s/^$1=//p" "$STATE" | head -n 1; }
has() { case ",$1," in *",$2,"*) return 0 ;; *) return 1 ;; esac; }
# CSV $1 without the codes listed in CSV $2.
minus() {
  local out="" c
  for c in ${1//,/ }; do has "$2" "$c" || out="${out:+$out,}$c"; done
  printf '%s' "$out"
}
csv_sort() { tr ',' '\n' | grep . | sort -u | tr '\n' ',' | sed 's/,$//'; }
PREV="$(sget state)"
PREV_SIG="$(sget sig)"
LAST_SENT="$(num "$(sget last_sent)" "")"
SINCE="$(sget since)"
PREV_NS_ID="$(sget ns_id)"
PREV_NS_RESTARTS="$(num "$(sget ns_restarts)" "")"
RESTART_TIMES="$(sget restart_times)"
PREV_ALERTED="$(sget alerted)"
PREV_FLAP="$(sget flap)"
PREV_RECOVERED_AT="$(num "$(sget recovered_at)" "")"

# docker ps failed: nothing is known about the container on this run — carry the last
# known id / RestartCount / restart times forward (a single ps error must not wipe an
# ongoing crash-loop).
if [ "$NS_PS_FAILED" = true ]; then
  NS_ID="$PREV_NS_ID"
  NS_RESTARTS="$PREV_NS_RESTARTS"
fi

# Crash-loop: RestartCount increases of the same container, dated by State.StartedAt
# (when the restart happened, not when this run saw it).
if [ -n "$NS_RESTARTS" ] && [ "$NS_ID" = "$PREV_NS_ID" ] && [ -n "$PREV_NS_RESTARTS" ]; then
  grown=$(($(num "$NS_RESTARTS" 0) - PREV_NS_RESTARTS))
  if [ "$grown" -gt 0 ]; then
    # Running: StartedAt is this restart. Not running (restarting/exited): StartedAt is the
    # previous start — the restart is happening now.
    t_restart="$NOW"
    [ "$ns_status" = running ] && [ "$started_s" -gt 0 ] && [ "$started_s" -le "$NOW" ] &&
      t_restart="$started_s"
    [ "$grown" -gt 3 ] && grown=3
    while [ "$grown" -gt 0 ]; do
      RESTART_TIMES="${RESTART_TIMES:+$RESTART_TIMES,}$t_restart"
      grown=$((grown - 1))
    done
  fi
fi
[ "$NS_ID" = "$PREV_NS_ID" ] || RESTART_TIMES=""
kept=""
future=0
for t in ${RESTART_TIMES//,/ }; do
  # No subshell per entry (a long crash-loop with a 7-day window has thousands).
  # Junk, 16+ digits, or dated in the future (broken state / clock went back) is dropped.
  case "$t" in '' | *[!0-9]* | ????????????????*) continue ;; esac
  if [ $((10#$t)) -gt $((NOW + CRON_SLACK_S)) ]; then
    future=$((future + 1))
    continue
  fi
  [ $((NOW - 10#$t)) -lt $((RESTART_WINDOW_S + CRON_SLACK_S)) ] && kept="${kept:+$kept,}$t"
done
[ "$future" -gt 0 ] && log "WARN: restart_times: $future ta kelajak yozuvi tashlandi (soat orqaga ketdimi?)"
restarts_in_window="$(printf '%s' "$kept" | tr ',' '\n' | grep -c . || true)"
# Only ">= 2" / ">= 1" matters: keep the newest 100 entries so the state stays small (the
# message then says "100+": the real count is no longer known).
RESTART_TIMES="$(printf '%s' "$kept" | tr ',' '\n' | tail -n 100 | tr '\n' ',' | sed 's/,$//')"
restarts_label="$restarts_in_window"
[ "$restarts_in_window" -ge 100 ] && restarts_label="100+"
# >= 2 restarts in the window → crash-loop; while it is active, >= 1 keeps it (hysteresis,
# so a loop with a period close to the window does not flap alert/"tiklandi").
if [ "$restarts_in_window" -ge 2 ] || { has "$PREV_SIG" ns_restart && [ "$restarts_in_window" -ge 1 ]; }; then
  problem ns_restart "notification-service: qayta ishga tushmoqda (${restarts_label} marta $((RESTART_WINDOW_S / 60)) daq ichida, RestartCount ${NS_RESTARTS:-?})"
fi

RAW="$(printf '%s\n' "${CODES[@]:-}" | grep . | sort -u | tr '\n' ',' | sed 's/,$//')"
LEGACY_HOLD=false
if [ -f "$STATE" ] && ! grep -q '^raw=' "$STATE"; then
  # State written by an older version (no raw=, sig was a hash): no history.
  #  - was ok: start clean (a blip on the upgrade run is not confirmed yet);
  #  - was problem with failing checks now: adopt them as history and as the alerted set
  #    (no duplicate alert, no false "tiklandi");
  #  - was problem, clean now: hold — "tiklandi" after the 2nd clean run.
  R1=""
  R2=""
  R3=""
  if [ "$PREV" = problem ]; then
    if [ -n "$RAW" ]; then
      R1="$RAW"
      R2="$RAW"
      PREV_SIG="$RAW"
    else
      PREV_SIG=ok
      LEGACY_HOLD=true
    fi
  fi
else
  R1="$(sget raw)"
  R2="$(sget raw2)"
  R3="$(sget raw3)"
fi
# Codes already alerted in this incident (state from before alerted= existed: the sig).
if [ "$PREV" = problem ]; then
  if [ -f "$STATE" ] && grep -q '^alerted=' "$STATE"; then
    ALERTED="$PREV_ALERTED"
  else
    ALERTED="$(minus "$PREV_SIG" ok)"
  fi
else
  ALERTED=""
fi
# Flapping incident (started soon after the previous "tiklandi"): leave/recover needs 4
# clean runs instead of 2.
FLAP=""
[ "$PREV" = problem ] && FLAP="$PREV_FLAP"

# A code is "recent" while it failed within the leave window (this + previous run; with
# FLAP the last 4 runs).
recent() {
  has "$RAW" "$1" || has "$R1" "$1" ||
    { [ "$FLAP" = 1 ] && { has "$R2" "$1" || has "$R3" "$1"; }; }
}
recent_any() {
  [ -n "$RAW" ] || [ -n "$R1" ] || { [ "$FLAP" = 1 ] && { [ -n "$R2" ] || [ -n "$R3" ]; }; }
}

# ACTIVE (= the alerted set, SIG) is sticky per check code:
#  - a code JOINS when it fails now and failed on one of the 2 previous runs
#    (debounce; catches flapping), ns_restart joins at once;
#  - when nothing is alerted but the last 4 runs keep failing with rotating checks (>= 3
#    runs with >= 3 different checks, or all 4 runs) one `unstable` entry joins (listing
#    them) and stays until the runs are fully clean — rotation does not re-alert. Codes of
#    this incident are not counted (a recovery tail is not "unstable");
#  - a code LEAVES only when it is no longer recent — ns_restart: while the window still
#    holds a restart.
ACTIVE=()
add_active() { has "$(IFS=,; echo "${ACTIVE[*]:-}")" "$1" || ACTIVE+=("$1"); }
for c in ${PREV_SIG//,/ }; do
  [ "$c" = ok ] && continue
  if [ "$c" = unstable ]; then
    recent_any && add_active unstable
  elif recent "$c" && has "$ALERTED" "$c" && { has "$R1" "$c" || has "$R2" "$c" || has "$R3" "$c"; }; then
    # Not sticky any more when it failed now after >= 3 clean runs, or when it already left
    # ALERTED (HOLD keeps a long-clean code in SIG for display only): its next failure goes
    # through the join rule (debounce) below and is a new alert.
    add_active "$c"
  fi
done
for c in ${RAW//,/ }; do
  if [ "$c" = ns_restart ] || has "$R1" "$c" || has "$R2" "$c"; then add_active "$c"; fi
done
SEEN="$PREV_SIG,$ALERTED"
U0="$(minus "$RAW" "$SEEN")"
U1="$(minus "$R1" "$SEEN")"
U2="$(minus "$R2" "$SEEN")"
U3="$(minus "$R3" "$SEEN")"
nonempty=0
for r in "$U0" "$U1" "$U2" "$U3"; do [ -n "$r" ] && nonempty=$((nonempty + 1)); done
UNION="$(printf '%s,%s,%s,%s' "$U0" "$U1" "$U2" "$U3" | csv_sort)"
distinct="$(printf '%s' "$UNION" | tr ',' '\n' | grep -c . || true)"
if [ "${#ACTIVE[@]}" -eq 0 ] &&
  { [ "$nonempty" -eq 4 ] || { [ "$nonempty" -ge 3 ] && [ "$distinct" -ge 3 ]; }; }; then
  add_active unstable
fi

# Nothing alerted any more, but checks still fail (not confirmed yet): no false
# "tiklandi" — hold the incident silently with the previous set.
HOLD=false
# The decision uses the 2-run rule even in FLAP mode: the alerted codes have already left
# under the 4-run rule, so a rare unconfirmed blip must not keep the incident open for hours.
if [ "${#ACTIVE[@]}" -eq 0 ] && [ "$PREV" = problem ] &&
  { [ -n "$RAW" ] || [ -n "$R1" ] || [ "$LEGACY_HOLD" = true ]; }; then
  HOLD=true
  for c in ${PREV_SIG//,/ }; do [ "$c" = ok ] || add_active "$c"; done
fi

if [ "${#ACTIVE[@]}" -gt 0 ]; then
  CUR=problem
  SIG="$(printf '%s\n' "${ACTIVE[@]}" | sort -u | tr '\n' ',' | sed 's/,$//')"
elif [ "$HOLD" = true ]; then
  CUR=problem
  SIG="${PREV_SIG:-ok}"
else
  CUR=ok
  SIG=ok
fi
[ "$PREV" = "$CUR" ] || SINCE="$NOW"

# Message lines: the current text of each active check; an active check that passed on
# this run is still listed (it has not been clean twice yet).
CONF_TEXTS=()
CONF_CODES=("${ACTIVE[@]:-}")
for c in "${ACTIVE[@]:-}"; do
  [ -n "$c" ] || continue
  line=""
  for i in "${!CODES[@]}"; do [ "${CODES[$i]}" = "$c" ] && line="${TEXTS[$i]}"; done
  [ "$c" = unstable ] && line="Bir nechta tekshiruv navbatma-navbat yiqilmoqda (so'nggi 4 yugurish): ${UNION:-$(printf '%s,%s,%s,%s' "$RAW" "$R1" "$R2" "$R3" | csv_sort)}"
  if [ -z "$line" ] && [ "$HOLD" = true ]; then
    line="$c: tiklangan, boshqa tekshiruvlar hali beqaror"
  fi
  [ -n "$line" ] || line="$c: oxirgi tekshiruvda o'tdi, lekin hali barqaror emas"
  CONF_TEXTS+=("$line")
done
[ "$HOLD" = true ] && [ -n "$RAW" ] && CONF_TEXTS+=("Hali tasdiqlanmagan: $RAW")

# New codes (not alerted in this incident) → message now; ns_restart and ns_unhealthy
# are one root cause (a crash-looping container is also unhealthy). Only removals →
# wait for full recovery.
# A check that has been clean for 4 runs leaves ALERTED (its next failure is a new problem
# even if the incident stayed open because of other checks / HOLD / FLAP); `unstable`
# leaves ALERTED when it leaves the alerted set.
prune_alerted() {
  local c kept=""
  for c in ${ALERTED//,/ }; do
    if [ "$c" = unstable ]; then
      has "$SIG" unstable || continue
    elif ! has "$RAW" "$c" && ! has "$R1" "$c" && ! has "$R2" "$c" && ! has "$R3" "$c"; then
      continue
    fi
    kept="${kept:+$kept,}$c"
  done
  ALERTED="$kept"
}
prune_alerted
is_new() {
  has "$ALERTED" "$1" && return 1
  case "$1" in
    ns_restart) has "$ALERTED" ns_unhealthy && return 1 ;;
    ns_unhealthy) has "$ALERTED" ns_restart && return 1 ;;
  esac
  return 0
}
NEW_CODES=""
for c in "${ACTIVE[@]:-}"; do
  [ -n "$c" ] && is_new "$c" && NEW_CODES="${NEW_CODES:+$NEW_CODES,}$c"
done

repeat_due() { [ -z "$LAST_SENT" ] || [ $((NOW - LAST_SENT)) -ge $((REPEAT_H * 3600)) ]; }
SEND=""
if [ "$MODE" = test ]; then
  SEND=test
elif [ "$HOLD" = true ]; then
  # Held incident: only the periodic reminder (nothing new is confirmed).
  [ "${#CONF_TEXTS[@]}" -gt 0 ] && [ -n "$LAST_SENT" ] && repeat_due && SEND=problem
elif [ "$CUR" = problem ]; then
  if [ "$PREV" != problem ] || [ -n "$NEW_CODES" ] || repeat_due; then
    SEND=problem
  fi
elif [ "$PREV" = problem ]; then
  SEND=recovered
fi

# Incident bookkeeping for the next run (ALERTED_IN/FLAP_IN: restored when no channel
# accepted the message).
ALERTED_IN="$ALERTED"
FLAP_IN="$FLAP"
if [ "$CUR" = problem ]; then
  # HOLD only re-shows the previous set: it must not re-arm codes that already left ALERTED.
  [ "$HOLD" = true ] || ALERTED="$(printf '%s,%s' "$ALERTED" "$(minus "$SIG" ok)" | csv_sort)"
  if [ "$PREV" != problem ]; then
    FLAP=""
    [ -n "$PREV_RECOVERED_AT" ] && [ $((NOW - PREV_RECOVERED_AT)) -lt "$FLAP_WINDOW_S" ] && FLAP=1
  fi
  RECOVERED_AT="$PREV_RECOVERED_AT"
else
  ALERTED=""
  FLAP=""
  RECOVERED_AT="$PREV_RECOVERED_AT"
  [ "$PREV" = problem ] && RECOVERED_AT="$NOW"
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
[ "$CUR" = problem ] && [ -z "$SEND" ] && log "problem davom etmoqda (xabar ${REPEAT_H}h da qayta): faol=$SIG joriy=${RAW:-none}"
[ "$CUR" = ok ] && [ "$PREV" != ok ] && log "ok"
[ "$CUR" = ok ] && [ -n "$RAW" ] && log "kuzatilmoqda (hali tasdiqlanmagan): $RAW"

# A message that no channel accepted is retried on the next run: keep the previous
# alert state (state/sig/last_sent), but always record raw checks and restart count.
if [ -n "$SEND" ] && [ "$sent_any" != true ] && [ -n "$(cfg BOT_ALERT_WEBHOOK_URL)$(cfg BOT_ALERT_TELEGRAM_CHAT_ID)" ]; then
  CUR="${PREV:-ok}"
  SIG="${PREV_SIG:-ok}"
  LAST_SENT="$(num "$(sget last_sent)" "")"
  SINCE="$(sget since)"
  ALERTED="$ALERTED_IN"
  FLAP="$FLAP_IN"
  RECOVERED_AT="$PREV_RECOVERED_AT"
fi

{
  echo "state=$CUR"
  echo "sig=$SIG"
  echo "raw=$RAW"
  echo "raw2=$R1"
  echo "raw3=$R2"
  echo "since=$SINCE"
  echo "last_sent=${LAST_SENT:-}"
  echo "checked_at=$NOW"
  echo "ns_id=$NS_ID"
  echo "ns_restarts=$NS_RESTARTS"
  echo "restart_times=$RESTART_TIMES"
  echo "alerted=$ALERTED"
  echo "flap=$FLAP"
  echo "recovered_at=${RECOVERED_AT:-}"
} > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"

tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG"
[ "${#CODES[@]}" -eq 0 ]
