#!/usr/bin/env bash
#
# One Telegram message from a GitHub Actions job (restore-drill.yml,
# uptime-monitor.yml). Same names as scripts/backup-alert.sh:
#   BACKUP_ALERT_TELEGRAM_BOT_TOKEN, BACKUP_ALERT_TELEGRAM_CHAT_ID
# A missing secret or a failed send exits 1, so the job goes red instead of
# staying silent. The token reaches curl on stdin (-K -), never argv.
#
# Usage: bash scripts/ci-telegram-alert.sh "<text>"
set -uo pipefail

TEXT="${1:?usage: ci-telegram-alert.sh <text>}"
TOKEN="${BACKUP_ALERT_TELEGRAM_BOT_TOKEN:-}"
CHAT="${BACKUP_ALERT_TELEGRAM_CHAT_ID:-}"

if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
  echo "::error::BACKUP_ALERT_TELEGRAM_BOT_TOKEN / BACKUP_ALERT_TELEGRAM_CHAT_ID secret is not set — no alert was sent."
  exit 1
fi

code="$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TOKEN" |
  curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -K - \
    --data-urlencode "chat_id=$CHAT" --data-urlencode "text=$TEXT" || true)"
if [ "$code" != 200 ]; then
  echo "::error::Telegram did not accept the alert (HTTP ${code:-none})."
  exit 1
fi
