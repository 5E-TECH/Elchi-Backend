#!/usr/bin/env bash
#
# «AI kalit va modellar» — ops Telegram xabari (be-brief v0.2 §10, D15). Host cron, har daqiqa,
# docker guruhidagi foydalanuvchi:
#   * * * * * ELCHI_APP_DIR=/home/<user>/apps/backend /home/<user>/elchi-ops/ai-config-alert.sh
#   (staging: ELCHI_ENV_FILE=/opt/elchi-staging/.env.staging, BOT_ALERT_HOST_LABEL=staging)
#
# Manba — ai_schema.activity_logs (audit qatori o'zgarish bilan BITTA tranzaksiyada yoziladi,
# ya'ni qator bor = o'zgarish bor). Faqat o'qiladi (BEGIN READ ONLY, statement_timeout 10s):
#   - har `ai.key.*` (`ai.key.verify` dan tashqari), `ai.models.*`, `ai.config.stale` — alohida
#     qator xabarda (bir yugurishda ko'pi bilan 20 ta, qolgani keyingi daqiqada);
#   - `ai.key.attempt_rejected` — yig'ma: oxirgi 1 soatda ≥ 3 bo'lsa, soatiga bitta xabar.
# Kursor ($ELCHI_OPS_DIR/state/ai-config-alert.cursor) — oxirgi yuborilgan qator id'si; FAQAT
# kanal xabarni qabul qilgandan keyin suriladi. Birinchi yugurish: kursor joriy MAX(id) ga
# qo'yiladi, eski qatorlar yuborilmaydi.
#
# Xabar: oddiy matn (parse_mode yo'q), host belgisi, amal (o'zbekcha), aktyor, kalit ko'rinishi
# (sk-ant-…XXXX), iz, IP, vaqt. Nom/aktyor boshqaruv belgilaridan tozalanadi va kesiladi; har
# ehtimolga qarshi `sk-ant-…` qiymat [REDACTED] bo'ladi. Kalit QIYMATI audit qatorida yo'q.
#
# Konfiguratsiya (bot-alert.sh bilan BIR XIL, UI'dan o'zgartirilmaydi):
#   $ELCHI_OPS_DIR/bot-alert.env — BOT_ALERT_TELEGRAM_BOT_TOKEN, BOT_ALERT_TELEGRAM_CHAT_ID,
#   BOT_ALERT_WEBHOOK_URL (ixtiyoriy), BOT_ALERT_HOST_LABEL, BOT_ALERT_PG_CONTAINER.
#   POSTGRES_USER / POSTGRES_DB — $ELCHI_ENV_FILE (sukut $ELCHI_APP_DIR/.env.production).
#   Sirlar argv/ps va logga tushmaydi (curl -K -).
# Usage:  ai-config-alert.sh [--dry-run] [--test]
set -uo pipefail
umask 077

APP_DIR="${ELCHI_APP_DIR:-$HOME/apps/backend}"
OPS_DIR="${ELCHI_OPS_DIR:-$HOME/elchi-ops}"
ENV_FILE="${ELCHI_ENV_FILE:-$APP_DIR/.env.production}"
CONF="$OPS_DIR/bot-alert.env"
STATE_DIR="$OPS_DIR/state"
CURSOR="$STATE_DIR/ai-config-alert.cursor"
AGG_STATE="$STATE_DIR/ai-config-alert.attempts"
LOG="$OPS_DIR/logs/ai-config-alert.log"
NOW="${AI_CONFIG_ALERT_NOW:-$(date +%s)}"
MAX_ROWS=20
ATTEMPT_THRESHOLD=3

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
if command -v flock > /dev/null 2>&1; then
  exec 9> "$STATE_DIR/ai-config-alert.lock"
  if ! flock -n 9; then
    [ "$MODE" = run ] && exit 0
    echo "ai-config-alert: boshqa nusxa ishlayapti (lock band)" >&2
    exit 3
  fi
fi
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(ts) $*" >> "$LOG"; [ "$MODE" = run ] || echo "$*"; }
bounded() {
  if command -v timeout > /dev/null 2>&1; then
    timeout -k 5 30 "$@" 9>&-
  else
    "$@" 9>&-
  fi
}

# KEY: alert konfiguratsiyasidan, bo'lmasa env faylidan. Hech qachon chop etilmaydi.
cfg() {
  local v=""
  [ -f "$CONF" ] && v="$(grep -E "^$1=" "$CONF" | tail -n 1 | cut -d= -f2-)"
  [ -z "$v" ] && [ -f "$ENV_FILE" ] && v="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"
  v="${v//$'\r'/}"
  v="$(printf '%s' "$v" | sed -E 's/^[[:space:]]+//')"
  case "$v" in
    \"*) v="$(printf '%s' "${v#\"}" | sed -E 's/".*$//')" ;;
    \'*) v="$(printf '%s' "${v#\'}" | sed -E "s/'.*$//")" ;;
    *) v="$(printf '%s' "$v" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//')" ;;
  esac
  printf '%s' "$v"
}

HOST_LABEL="${BOT_ALERT_HOST_LABEL:-$(cfg BOT_ALERT_HOST_LABEL)}"
HOST_LABEL="${HOST_LABEL:-$(hostname 2> /dev/null || echo server)}"
TG_API="${BOT_ALERT_TELEGRAM_API:-$(cfg BOT_ALERT_TELEGRAM_API)}"
TG_API="${TG_API:-https://api.telegram.org}"
PG_CONTAINER="$(cfg BOT_ALERT_PG_CONTAINER)"
PG_CONTAINER="${PG_CONTAINER:-elchi-postgres}"
PG_USER="$(cfg POSTGRES_USER)"
PG_DB="$(cfg POSTGRES_DB)"

# Matnni xavfsiz qilish: boshqaruv belgilari → bo'sh joy, sk-ant- qiymat → [REDACTED], kesish.
clean() {
  printf '%s' "$1" | tr '\000-\037\177' ' ' |
    sed -E 's/sk-ant-[A-Za-z0-9_-]+/sk-ant-[REDACTED]/g' | cut -c1-"${2:-60}"
}

action_uz() {
  case "$1" in
    ai.key.add) echo "AI kaliti qo'shildi" ;;
    ai.key.replace) echo "AI kaliti almashtirildi" ;;
    ai.key.restore) echo "Oldingi AI kalitiga qaytarildi" ;;
    ai.key.deactivate) echo "AI kaliti o'chirildi" ;;
    ai.key.forget) echo "Oldingi AI kaliti o'chirib tashlandi" ;;
    ai.key.runtime_failure) echo "AI kaliti ishlamay qoldi — AI to'xtagan" ;;
    ai.key.unreadable) echo "Saqlangan AI kalitini ochib bo'lmadi — AI to'xtagan" ;;
    ai.key.reencrypt) echo "AI kaliti qayta shifrlandi" ;;
    ai.models.update) echo "AI modeli o'zgartirildi" ;;
    ai.models.auto_revert) echo "AI modeli avtomatik qaytarildi" ;;
    ai.models.unavailable) echo "AI modeli mavjud emas" ;;
    ai.config.stale) echo "AI sozlamasi o'qilmadi (oxirgi ma'lum holat)" ;;
    *) clean "$1" 40 ;;
  esac
}

# Faqat o'qish. Natija: maydonlar \x1f bilan, qatorlar \x1e bilan (matnda yangi qator bo'lsa ham).
psql_ro() {
  bounded docker exec -i -e PGOPTIONS='-c statement_timeout=10s -c lock_timeout=5s' \
    "$PG_CONTAINER" psql -X -q -t -A -v ON_ERROR_STOP=1 -F $'\x1f' -R $'\x1e' \
    -U "${PG_USER:-postgres}" -d "${PG_DB:-postgres}" -c "BEGIN READ ONLY; $1 COMMIT;" 2> /dev/null
}

send_all() {
  local text="$1" chat token hook ok=true sent=false
  chat="$(cfg BOT_ALERT_TELEGRAM_CHAT_ID)"
  if [ -n "$chat" ]; then
    token="$(cfg BOT_ALERT_TELEGRAM_BOT_TOKEN)"
    if [ -z "$token" ]; then
      ok=false
      log "WARN: BOT_ALERT_TELEGRAM_BOT_TOKEN yo'q — Telegram kanali o'tkazildi"
    elif printf 'url = "%s/bot%s/sendMessage"\n' "$TG_API" "$token" |
      curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -K - \
        --data-urlencode "chat_id=$chat" --data-urlencode "text=$text" 2> /dev/null | grep -q '^200$'; then
      sent=true
    else
      ok=false
      log "WARN: Telegram yuborilmadi"
    fi
  fi
  hook="$(cfg BOT_ALERT_WEBHOOK_URL)"
  if [ -n "$hook" ]; then
    if printf 'url = "%s"\n' "$hook" |
      curl -sS -o /dev/null --fail --max-time 20 -K - -H 'Title: Elchi AI' --data-binary "$text" 2> /dev/null; then
      sent=true
    else
      ok=false
      log "WARN: webhook yuborilmadi"
    fi
  fi
  [ -z "$chat" ] && [ -z "$hook" ] && log "WARN: kanal sozlanmagan (BOT_ALERT_TELEGRAM_CHAT_ID / BOT_ALERT_WEBHOOK_URL)"
  $ok || log "WARN: kanallarning bir qismi qabul qilmadi"
  # Kamida bitta kanal qabul qilgan bo'lsa — yuborildi (kursor suriladi).
  $sent
}

if [ "$MODE" = test ]; then
  if send_all "ℹ️ Elchi AI sozlamasi — test xabar ($HOST_LABEL, $(ts))"; then
    log "test xabar yuborildi"
    exit 0
  fi
  exit 1
fi

# ---- kursor ---------------------------------------------------------------------
last_id="$(cat "$CURSOR" 2> /dev/null | tr -cd '0-9')"
if [ -z "$last_id" ]; then
  if ! max="$(psql_ro "SELECT COALESCE(MAX(id), 0) FROM ai_schema.activity_logs;")"; then
    log "ERROR: $PG_CONTAINER: so'rov bajarilmadi (kursor boshlanmadi)"
    exit 1
  fi
  max="$(printf '%s' "$max" | tr -cd '0-9')"
  [ "$MODE" = run ] && printf '%s\n' "${max:-0}" > "$CURSOR"
  log "kursor boshlandi: ${max:-0} (eski qatorlar yuborilmaydi)"
  exit 0
fi

ACTIONS="(a.action LIKE 'ai.key.%' AND a.action NOT IN ('ai.key.verify','ai.key.attempt_rejected'))
  OR a.action LIKE 'ai.models.%' OR a.action = 'ai.config.stale'"
SQL="SELECT a.id, a.action, to_char(a.created_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI'),
  COALESCE(a.user_name, ''),
  COALESCE(a.metadata->'key_to'->>'hint', a.metadata->'key_from'->>'hint', ''),
  COALESCE(a.metadata->'key_to'->>'fingerprint', a.metadata->'key_from'->>'fingerprint', ''),
  COALESCE(a.metadata->'key_to'->>'label', a.metadata->'key_from'->>'label', ''),
  COALESCE(a.metadata->>'ip', ''),
  COALESCE(a.metadata->>'error_code', a.metadata->>'verify_state', ''),
  COALESCE(a.metadata->>'slot', '')
  FROM ai_schema.activity_logs a
  WHERE a.id > $last_id AND ($ACTIONS)
  ORDER BY a.id LIMIT $MAX_ROWS;"
if ! rows="$(psql_ro "$SQL")"; then
  log "ERROR: $PG_CONTAINER: so'rov bajarilmadi"
  exit 1
fi

lines=()
new_last="$last_id"
while IFS=$'\x1f' read -r -d $'\x1e' id action at actor hint fp label ip code slot; do
  id="$(printf '%s' "$id" | tr -cd '0-9')"
  [ -n "$id" ] || continue
  line="- $(action_uz "$action")"
  [ -n "$actor" ] && line="$line — $(clean "$actor" 60)"
  [ -n "$hint" ] && line="$line; kalit $(clean "$hint" 20)"
  [ -n "$fp" ] && line="$line (iz $(clean "$fp" 16))"
  [ -n "$label" ] && line="$line «$(clean "$label" 60)»"
  [ -n "$slot" ] && line="$line; vazifa $(clean "$slot" 20)"
  [ -n "$code" ] && line="$line; $(clean "$code" 40)"
  [ -n "$ip" ] && line="$line; IP $(clean "$ip" 45)"
  line="$line; $(clean "$at" 20)"
  lines+=("$line")
  new_last="$id"
done < <(
  printf '%s' "$rows"
  printf '\x1e'
)

# ---- rad etilgan urinishlar (yig'ma, soatiga bitta) -------------------------------
attempt_line=""
last_agg="$(cat "$AGG_STATE" 2> /dev/null | tr -cd '0-9')"
if [ -z "$last_agg" ] || [ $((NOW - last_agg)) -ge 3600 ]; then
  if cnt="$(psql_ro "SELECT count(*) FROM ai_schema.activity_logs WHERE action = 'ai.key.attempt_rejected' AND created_at > now() - interval '1 hour';")"; then
    cnt="$(printf '%s' "$cnt" | tr -cd '0-9')"
    if [ "${cnt:-0}" -ge "$ATTEMPT_THRESHOLD" ]; then
      attempt_line="- Oxirgi 1 soatda AI kalitini qo'shishga ${cnt} ta rad etilgan urinish"
    fi
  fi
fi

if [ "${#lines[@]}" -eq 0 ] && [ -z "$attempt_line" ]; then
  [ "$MODE" = dry ] && echo "yangi hodisa yo'q (kursor $last_id)"
  exit 0
fi

MSG="🔐 Elchi AI sozlamasi ($HOST_LABEL, $(ts))"
[ "${#lines[@]}" -gt 0 ] && MSG="$MSG"$'\n'"$(printf '%s\n' "${lines[@]}")"
[ -n "$attempt_line" ] && MSG="$MSG"$'\n'"$attempt_line"
MSG="$MSG"$'\n'"Runbook: docs/ops/ai-config.md"

if [ "$MODE" = dry ]; then
  printf '%s\n' "$MSG"
  exit 0
fi

if send_all "$MSG"; then
  printf '%s\n' "$new_last" > "$CURSOR"
  [ -n "$attempt_line" ] && printf '%s\n' "$NOW" > "$AGG_STATE"
  log "yuborildi: ${#lines[@]} hodisa (kursor $last_id → $new_last)${attempt_line:+ + urinishlar}"
  exit 0
fi
log "WARN: hech bir kanal qabul qilmadi — kursor surilmadi ($last_id)"
exit 1
