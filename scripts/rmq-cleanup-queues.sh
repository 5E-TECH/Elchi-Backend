#!/usr/bin/env bash
# Eski (DLQ-siz argumentlarsiz) queue'larni o'chirish uchun bir martalik
# migration script. Mavjud queue'ning argumentlarini RabbitMQ qayta ozgartirib bo'lmaydi —
# shuning uchun yangi DLX/x-dead-letter-exchange args qo'shish uchun queue'ni avval
# o'chirish kerak. Servislarni qayta ishga tushirsangiz, ular yangi argumentlar bilan
# qayta yaratadi va DLQ topology'ni assert qiladi.
#
# DIQQAT: bu skript ishlash davrida queue'dagi xabarlarni yo'qotadi. Maintenance window'da ishlating.
#
# Foydalanish:
#   bash scripts/rmq-cleanup-queues.sh
#
# RABBITMQ_API_URL ni o'zgartiring agar production uchun ishlatsangiz.

set -euo pipefail

RABBITMQ_API_URL="${RABBITMQ_API_URL:-http://localhost:15672/api}"
RABBITMQ_USER="${RABBITMQ_USER:-guest}"
RABBITMQ_PASS="${RABBITMQ_PASS:-guest}"
RABBITMQ_VHOST="${RABBITMQ_VHOST:-%2F}"

QUEUES=(
  identity_queue
  order_queue
  catalog_queue
  logistics_queue
  finance_queue
  notification_queue
  integration_queue
  analytics_queue
  branch_queue
  investor_queue
  file_queue
  c2c_queue
  search_queue
)

for q in "${QUEUES[@]}"; do
  echo "Deleting ${q}..."
  curl -sS -u "${RABBITMQ_USER}:${RABBITMQ_PASS}" \
    -X DELETE \
    "${RABBITMQ_API_URL}/queues/${RABBITMQ_VHOST}/${q}" \
    -w "  HTTP %{http_code}\n" \
    -o /dev/null || true
done

echo "Done. Endi servislarni qayta ishga tushiring — ular yangi DLQ args bilan queue'larni qayta yaratadi."
