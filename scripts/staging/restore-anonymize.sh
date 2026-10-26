#!/usr/bin/env bash
# ============================================================================
# STAGING: prod pg_dump → staging Postgres → anonimizatsiya (+ tekshiruv)
#
#   STAGING_DATABASE_URL=postgresql://user:pass@host:5432/elchi_staging \
#   STAGING_DEFAULT_PASSWORD='…kamida 10 belgi…' \
#   bash scripts/staging/restore-anonymize.sh --dump /path/elchi_2026-10-26.sql.gz --yes
#
# Bosqichlar:
#   1. Xavfsizlik: --yes shart; prod xosti (5.189.141.169) rad etiladi; bazada
#      bizdan boshqa ulanish bo'lsa (staging servislari ishlayapti) — to'xtaydi
#      (servislar prod nusxasi bilan SMS/Telegram yubormasin; --force bilan o'tkazish).
#   2. 12 ta app sxemasi DROP … CASCADE, keyin dump tiklanadi:
#        *.sql.gz  → gunzip | psql (prod backup-db.sh formati: --clean --if-exists)
#        *.sql     → psql
#        custom    → pg_restore --no-owner --no-privileges --clean --if-exists
#   3. anonymize.sql + verify.sql — BITTA tranzaksiyada (`--single-transaction`).
#      Tekshiruv 0 bo'lmasa yoki biror qadam yiqilsa: ROLLBACK va tiklangan
#      (anonimlanmagan) ma'lumot DARHOL o'chiriladi (sxemalar DROP) — prod
#      nusxasi staging'da qolib ketmaydi.
#
# Parol: STAGING_DEFAULT_PASSWORD dan bcrypt (bcryptjs, 12) xeshi ISHGA
# TUSHGANDA node bilan olinadi; parol argv/faylga yozilmaydi, bazaga faqat xesh
# ketadi (env orqali `\getenv`). HAMMA akkaunt (TEST 1/25/26/37/53 ham) shu
# parol bilan; login telefonlari oxirida chop etiladi (+99877 + id).
#
# Ixtiyoriy env:
#   STAGING_KEEP_USER_IDS   — hisobotda ko'rsatiladigan TEST akkauntlar (sukut 1,25,26,37,53)
#   PSQL / PG_RESTORE       — boshqa binar (masalan konteyner ichidagi versiya)
# Flaglar: --dump <fayl> | --skip-restore (faqat anonimizatsiya) | --yes | --force
#
# ⚠️ Staging servislari bu skript TUGAGUNCHA to'xtatilgan bo'lsin; ular APP_ENV=staging
# va STAGING_*_ALLOWLIST bilan ishga tushiriladi (libs/common/src/staging).
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PSQL="${PSQL:-psql}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"
KEEP_IDS="${STAGING_KEEP_USER_IDS:-1,25,26,37,53}"
APP_SCHEMAS="identity_schema order_schema catalog_schema logistics_schema finance_schema notification_schema integration_schema branch_schema investor_schema c2c_schema search_schema ai_schema"
PROD_HOSTS_RE='(^|[@/])(5\.189\.141\.169)([:/]|$)'

DUMP=""
SKIP_RESTORE=0
YES=0
FORCE=0

die() { echo "XATO: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dump) DUMP="${2:-}"; shift 2 ;;
    --skip-restore) SKIP_RESTORE=1; shift ;;
    --yes) YES=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,36p' "$0"; exit 0 ;;
    *) die "noma'lum argument: $1" ;;
  esac
done

DB_URL="${STAGING_DATABASE_URL:-}"
[ -n "$DB_URL" ] || die "STAGING_DATABASE_URL berilmagan"
[ -n "${STAGING_DEFAULT_PASSWORD:-}" ] || die "STAGING_DEFAULT_PASSWORD berilmagan"
[ "${#STAGING_DEFAULT_PASSWORD}" -ge 10 ] || die "STAGING_DEFAULT_PASSWORD kamida 10 belgi"
[[ "$KEEP_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "STAGING_KEEP_USER_IDS formati: 1,25,26"
if [[ "$DB_URL" =~ $PROD_HOSTS_RE ]]; then
  die "maqsad PROD xosti — rad etildi"
fi
if [ "$SKIP_RESTORE" -eq 0 ]; then
  [ -n "$DUMP" ] || die "--dump <fayl> kerak (yoki --skip-restore)"
  [ -r "$DUMP" ] || die "dump o'qilmaydi: $DUMP"
fi

# Parol ko'rsatilmaydi: faqat xost/baza.
SAFE_TARGET="$(printf '%s' "$DB_URL" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#')"
echo "Maqsad: $SAFE_TARGET"
[ "$YES" -eq 1 ] || die "bu buyruq maqsad bazadagi ${APP_SCHEMAS// /, } sxemalarini O'CHIRADI — tasdiq uchun --yes"

q() { "$PSQL" "$DB_URL" -X -v ON_ERROR_STOP=1 -qAt -c "$1"; }

# 1. Boshqa ulanishlar (ishlab turgan staging servislari) — to'xtaymiz.
OTHERS="$(q "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'")"
if [ "$OTHERS" != "0" ] && [ "$FORCE" -ne 1 ]; then
  die "bazada yana $OTHERS ta ulanish bor — staging servislarini to'xtating (yoki --force)"
fi

# 2. Staging paroli xeshi (bcryptjs, 12) — parol faqat env orqali node'ga.
command -v node >/dev/null || die "node topilmadi (bcrypt xeshi uchun kerak)"
STG_PW_HASH="$(cd "$ROOT" && node -e '
  const bcrypt = require("bcryptjs");
  process.stdout.write(bcrypt.hashSync(process.env.STAGING_DEFAULT_PASSWORD, 12));
')" || die "bcryptjs bilan xesh olinmadi (repo ildizida npm ci qilinganmi?)"
export STG_PW_HASH

wipe_schemas() {
  local sql=""
  for s in $APP_SCHEMAS; do sql="$sql DROP SCHEMA IF EXISTS \"$s\" CASCADE;"; done
  q "$sql" >/dev/null
}

RESTORED=0
on_exit() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$RESTORED" -eq 1 ]; then
    echo "!!! Anonimizatsiya yiqildi (kod $code) — tiklangan prod nusxasi O'CHIRILMOQDA" >&2
    wipe_schemas || echo "!!! sxemalarni o'chirib bo'lmadi — QO'LDA o'chiring: $APP_SCHEMAS" >&2
  fi
}
trap on_exit EXIT

# 3. Tiklash.
if [ "$SKIP_RESTORE" -eq 0 ]; then
  echo "=== Eski staging sxemalari o'chirilmoqda ==="
  wipe_schemas
  echo "=== Dump tiklanmoqda: $(basename "$DUMP") ==="
  RESTORED=1
  if [ "$(head -c 5 "$DUMP")" = "PGDMP" ]; then
    "$PG_RESTORE" --no-owner --no-privileges --clean --if-exists --exit-on-error \
      -d "$DB_URL" "$DUMP"
  elif [[ "$DUMP" == *.gz ]]; then
    gunzip -c "$DUMP" | "$PSQL" "$DB_URL" -X -q -v ON_ERROR_STOP=1 >/dev/null
  else
    "$PSQL" "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$DUMP" >/dev/null
  fi
else
  # Faqat anonimizatsiya: yiqilsa ham bazadagi ma'lumot avvalgidek qoladi.
  RESTORED=0
fi

# 4. Anonimizatsiya + tekshiruv — bitta tranzaksiya.
echo "=== Anonimizatsiya (bitta tranzaksiya) ==="
"$PSQL" "$DB_URL" -X -v ON_ERROR_STOP=1 --single-transaction \
  -v keep_user_ids="$KEEP_IDS" \
  -c '\getenv stg_pw_hash STG_PW_HASH' \
  -f "$HERE/anonymize.sql" \
  -f "$HERE/verify.sql"

RESTORED=0
echo "=== TAYYOR: staging bazasi anonimlashtirildi va tekshirildi ==="
