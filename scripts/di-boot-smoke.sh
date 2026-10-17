#!/usr/bin/env bash
# DI boot smoke: build qilingan har servis bundle'ini DB/RabbitMQ'siz qisqa
# ishga tushirib, Nest DI xatosini ushlaydi (aylanma import → konstruktor
# parametri `undefined` → "Nest can't resolve dependencies …").
#
# NEGA: 2026-10-17 prod deployda notification-service aynan shu sabab
# ko'tarilmadi. Unit testlar DI konteynerini qurmaydi, ts-jest esa dekorator
# metadatasini webpack bundle'idan boshqacha chiqaradi — xatoni faqat haqiqiy
# bundle ko'rsatadi. DI ulanishdan OLDIN hal bo'ladi, shuning uchun soxta
# (ishlamaydigan) DB/RMQ manzillari yetarli.
#
#   bash scripts/di-boot-smoke.sh                 # hamma servis
#   bash scripts/di-boot-smoke.sh notification-service order-service
set -u
cd "$(dirname "$0")/.." || exit 1

if [ "$#" -gt 0 ]; then
  SERVICES=("$@")
else
  mapfile -t SERVICES < <(ls apps)
fi

# Joi sxemalari talab qiladigan kalitlar — soxta, lekin formatga mos qiymatlar.
export NODE_ENV=production
export POSTGRES_URI=postgres://smoke:smoke@127.0.0.1:1/smoke
export RABBITMQ_URI=amqp://smoke:smoke@127.0.0.1:1
for q in ANALYTICS BRANCH C2C CATALOG FILE FINANCE IDENTITY INTEGRATION INVESTOR \
  LOGISTICS NOTIFICATION ORDER SEARCH AI GATEWAY; do
  export "RABBITMQ_${q}_QUEUE=smoke_${q,,}_queue"
done
# Sekret o'xshash qiymatlar HAR ISHGA TUSHISHDA tasodifiy generatsiya qilinadi:
# repoda literal sekret bo'lmasin (gitleaks secret-scan) va "zaif sekret"
# tekshiruvlaridan o'tsin.
rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
export MINIO_ENDPOINT=127.0.0.1
export MINIO_ACCESS_KEY="smoke-$(rand_hex 6)"
export MINIO_SECRET_KEY="$(rand_hex 24)"
export INTEGRATION_CREDENTIAL_SECRET="$(rand_hex 32)"
export SUPERADMIN_NAME=smoke SUPERADMIN_PHONE_NUMBER=+998900000000
export SUPERADMIN_PASSWORD="Sm-$(rand_hex 12)!"
export ACCESS_TOKEN_KEY="$(rand_hex 32)"
export REFRESH_TOKEN_KEY="$(rand_hex 32)"
export PORT=0

DI_ERROR="can't resolve dependencies|UnknownDependenciesException|UndefinedDependencyException|UndefinedModuleException|Config validation error"
failed=0
for svc in "${SERVICES[@]}"; do
  bundle="dist/apps/${svc}/main.js"
  if [ ! -f "$bundle" ]; then
    npx nest build "$svc" >/dev/null 2>&1 || { echo "❌ $svc: build yiqildi"; failed=1; continue; }
  fi
  out=$(timeout "${SMOKE_SECONDS:-12}" node "$bundle" 2>&1)
  if grep -qE "$DI_ERROR" <<<"$out"; then
    echo "❌ $svc:"
    grep -E "$DI_ERROR" <<<"$out" | head -3
    failed=1
  else
    echo "✅ $svc: DI hal bo'ldi"
  fi
done
exit "$failed"
