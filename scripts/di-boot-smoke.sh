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
export MINIO_ENDPOINT=127.0.0.1 MINIO_ACCESS_KEY=smoke-access-7c1e5b9d3a MINIO_SECRET_KEY=3e8b1d6a0f4c9e2b7d5a1f8c3e6b0d4a9f2c7e1b5d8a3f6c
export INTEGRATION_CREDENTIAL_SECRET=7f3c9a1e5b8d2f6a4c0e9b3d7a1f5c8e2b6d0a4f8c3e7b1d5a9f2c6e0b4d8a3f
export SUPERADMIN_NAME=smoke SUPERADMIN_PHONE_NUMBER=+998900000000
export SUPERADMIN_PASSWORD='Smoke!Pass-9f3c2a7e1b'
export ACCESS_TOKEN_KEY=9c2e7a1f5b3d8c0e4a6f2b9d1c7e3a5f8b0d4c6e2a9f1b3d7c5e0a8f4b2d6c1e
export REFRESH_TOKEN_KEY=4b8d2f6a0c3e7b1d5a9f2c6e0b4d8a3f7c1e5b9d3a7f0c4e8b2d6a1f5c9e3b7d
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
