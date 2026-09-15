#!/usr/bin/env bash
# ELCHI LOKAL SINOV STEKI — hamkor (Partner API) oqimini sinash uchun.
#
# ⚠️ FAQAT 7 SERVIS ishga tushadi, 14 emas. Hamkor yo'li aynan shularga
# tegadi; qolganlari (analytics, investor, c2c, search, file, branch,
# notification) bu oqimda qatnashmaydi va ularsiz stek yengilroq ishlaydi.
#
# Ishlatilishi:
#   bash scripts/local/start-test-stack.sh          # ishga tushirish
#   bash scripts/local/start-test-stack.sh stop     # to'xtatish
#   bash scripts/local/start-test-stack.sh status   # holat
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT/.local-logs"
PID_DIR="$ROOT/.local-pids"
SERVICES="api-gateway identity-service order-service catalog-service logistics-service finance-service integration-service"
GATEWAY_PORT="${PORT:-3004}"

mkdir -p "$LOG_DIR" "$PID_DIR"

stop_all() {
  for s in $SERVICES; do
    f="$PID_DIR/$s.pid"
    if [ -f "$f" ]; then
      pid="$(cat "$f")"
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null
        printf '  to.xtatildi %-22s (pid %s)\n' "$s" "$pid"
      fi
      rm -f "$f"
    fi
  done
}

status_all() {
  for s in $SERVICES; do
    f="$PID_DIR/$s.pid"
    if [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; then
      printf '  ISHLAYDI  %-22s pid %s\n' "$s" "$(cat "$f")"
    else
      printf '  ochiq     %-22s\n' "$s"
    fi
  done
  printf '\n  gateway: '
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://localhost:$GATEWAY_PORT/health" 2>/dev/null)"
  if [ "$code" = "200" ]; then echo "http://localhost:$GATEWAY_PORT (200 OK)"; else echo "javob bermaydi ($code)"; fi
}

case "${1:-start}" in
  stop) stop_all; exit 0 ;;
  status) status_all; exit 0 ;;
esac

# --- Oldindan tekshiruv: bog'liqliklar ---
echo "=== Oldindan tekshiruv ==="
fail=0
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':5672'; then
  echo "  OK   RabbitMQ 5672"
else
  echo "  XATO RabbitMQ 5672 tinglamaydi — servislar navbatga ulanmaydi"; fail=1
fi
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':5432'; then
  echo "  OK   Postgres 5432"
else
  echo "  XATO Postgres 5432 tinglamaydi"; fail=1
fi
if [ ! -f "$ROOT/dist/apps/api-gateway/main.js" ]; then
  echo "  XATO dist yo.q — avval: npm run build:all"; fail=1
else
  echo "  OK   dist tayyor"
fi
[ "$fail" -eq 0 ] || { echo; echo "Bog.liqliklar tayyor emas, to.xtatildi."; exit 1; }

stop_all
echo
echo "=== Ishga tushirish ==="
for s in $SERVICES; do
  node "$ROOT/dist/apps/$s/main.js" > "$LOG_DIR/$s.log" 2>&1 &
  echo $! > "$PID_DIR/$s.pid"
  printf '  boshlandi %-22s pid %s\n' "$s" "$!"
done

echo
echo "=== Gateway tayyorligini kutish (maks 90s) ==="
for i in $(seq 1 45); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:$GATEWAY_PORT/health" 2>/dev/null)"
  if [ "$code" = "200" ]; then
    echo "  TAYYOR: http://localhost:$GATEWAY_PORT (${i}x2s dan keyin)"
    echo
    echo "Loglar: $LOG_DIR/*.log"
    echo "To.xtatish: bash scripts/local/start-test-stack.sh stop"
    exit 0
  fi
  sleep 2
done

echo "  XATO gateway 90s ichida javob bermadi. Loglarni ko.ring:"
for s in $SERVICES; do
  echo "  --- $s (oxirgi 3 qator) ---"
  tail -3 "$LOG_DIR/$s.log" 2>/dev/null | sed 's/^/      /'
done
exit 1
