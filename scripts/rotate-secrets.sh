#!/usr/bin/env bash
#
# Secret-rotation helper (audit P0 — see docs/audit/SECRET_ROTATION_RUNBOOK.md).
#
# What it does (LOCAL, non-destructive):
#   1. Backs up the current .env.production to .env.production.bak.<timestamp>.
#   2. Writes a NEW file .env.production.new with fresh random values for every
#      openssl-generatable secret (JWT keys, DB/MinIO/Swagger passwords, and the
#      password embedded in POSTGRES_URI / RABBITMQ_URI).
#   3. Leaves the secrets that CANNOT be auto-generated (bot tokens, tunnel
#      token, superadmin password) untouched and prints them as manual TODOs.
#
# It does NOT touch the live .env.production, does NOT restart anything, and does
# NOT print any secret value — the new values only ever land in .env.production.new
# (git-ignored). Review that file, then rename it over .env.production yourself and
# apply the datastore-side changes (§1 of the runbook).
#
# Usage:  bash scripts/rotate-secrets.sh
set -euo pipefail

SRC=".env.production"
NEW=".env.production.new"
TS="$(date -u +%Y%m%d-%H%M%S)"
BAK=".env.production.bak.${TS}"

[ -f "$SRC" ] || { echo "❌ $SRC not found (run from the repo root on the server)."; exit 1; }

cp "$SRC" "$BAK"
cp "$SRC" "$NEW"
echo "🔒 Backed up $SRC -> $BAK"

# --- helpers ------------------------------------------------------------------
# Replace KEY=<anything-to-eol> with KEY=<value> in $NEW, only if the key exists.
set_key() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$NEW"; then
    # value is hex (no /,&,| specials) so a simple sed is safe; use | as delim.
    sed -i -E "s|^(${key}=).*$|\1${val}|" "$NEW"
    echo "  ✓ rotated ${key}"
  fi
}
# Replace the password component of a URI value: scheme://user:PASS@host...
set_uri_password() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$NEW"; then
    sed -i -E "s|^(${key}=[a-zA-Z0-9+.-]+://[^:@/]+:)[^@]*(@)|\1${val}\2|" "$NEW"
    echo "  ✓ rotated ${key} (embedded password)"
  fi
}

echo "🎲 Generating fresh random secrets into $NEW ..."
# One password per datastore, reused in both the standalone key and its URI.
PG_PASS="$(openssl rand -hex 24)"
MQ_PASS="$(openssl rand -hex 16)"

set_key ACCESS_TOKEN_KEY            "$(openssl rand -hex 32)"
set_key REFRESH_TOKEN_KEY           "$(openssl rand -hex 32)"
set_key INTEGRATION_CREDENTIAL_SECRET "$(openssl rand -hex 32)"
set_key POSTGRES_PASSWORD           "$PG_PASS"
set_uri_password POSTGRES_URI       "$PG_PASS"
set_uri_password RABBITMQ_URI       "$MQ_PASS"
set_key MINIO_ACCESS_KEY            "$(openssl rand -hex 16)"
set_key MINIO_SECRET_KEY            "$(openssl rand -hex 24)"
set_key SWAGGER_PASSWORD            "$(openssl rand -hex 16)"

echo ""
echo "✋ MANUAL rotation still required (these can't be openssl-generated):"
echo "   - TELEGRAM_BOT_TOKEN / ORDER_BOT_TOKEN : @BotFather -> /revoke each, paste new token into $NEW"
echo "   - TUNNEL_TOKEN                         : Cloudflare Zero-Trust dashboard -> revoke + reissue"
echo "   - SUPERADMIN_PASSWORD                  : choose a strong, unique value (NOT the old one)"
echo "   - RABBITMQ user (if URI still uses guest): create a real user; the new password above is ready"
echo ""
echo "Next:"
echo "   1. Fill the MANUAL values into $NEW."
echo "   2. Apply the datastore-side changes (Postgres ALTER USER, MinIO, RabbitMQ, Cloudflare, BotFather)"
echo "      using the NEW values — see docs/audit/SECRET_ROTATION_RUNBOOK.md §1."
echo "   3. mv $NEW $SRC   (review the diff first: diff $BAK $NEW)"
echo "   4. docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo ""
echo "⚠️  $NEW and $BAK are git-ignored — never commit them. Delete backups once verified."
