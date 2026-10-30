#!/usr/bin/env bash
#
# ZfI9nERJ: external uptime check, from GitHub Actions (uptime-monitor.yml), so it
# still fires when the whole server is gone. Each URL must answer HTTP 200 with
# "status":"ok" (a Cloudflare 502 / 530 page does not count), within
# UPTIME_ATTEMPTS tries (3), UPTIME_RETRY_SECONDS (15) apart, so one lost request
# stays quiet.
#
# Down -> one Telegram message (scripts/ci-telegram-alert.sh) and exit 1. Missing
# Telegram secrets -> warning only: the job goes red for a real outage, not every
# 5 minutes until the secrets are added.
#
# Usage: bash scripts/uptime-check.sh <url>...
set -uo pipefail

ATTEMPTS="${UPTIME_ATTEMPTS:-3}"
RETRY="${UPTIME_RETRY_SECONDS:-15}"
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

# Sets CODE to the HTTP status of the last try.
probe() {
  local i
  for i in $(seq 1 "$ATTEMPTS"); do
    CODE="$(curl -sS -o "$BODY" -w '%{http_code}' --max-time 15 "$1" 2> /dev/null || true)"
    if [ "$CODE" = 200 ] && grep -q '"status":"ok"' "$BODY"; then return 0; fi
    [ "$i" -lt "$ATTEMPTS" ] && sleep "$RETRY"
  done
  return 1
}

DOWN=()
for url in "$@"; do
  if probe "$url"; then
    echo "up: $url"
  else
    echo "::error::DOWN: $url (HTTP ${CODE:-none})"
    DOWN+=("$url (HTTP ${CODE:-none})")
  fi
done

if [ "${#DOWN[@]}" -gt 0 ]; then
  bash "$(dirname "$0")/ci-telegram-alert.sh" \
    "🔴 Elchi API yiqildi ($(date -u +%H:%M) UTC): ${DOWN[*]}" || true
  exit 1
fi
if [ -z "${BACKUP_ALERT_TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${BACKUP_ALERT_TELEGRAM_CHAT_ID:-}" ]; then
  echo "::warning::BACKUP_ALERT_TELEGRAM_BOT_TOKEN / BACKUP_ALERT_TELEGRAM_CHAT_ID secret is not set — this monitor cannot alert."
fi
