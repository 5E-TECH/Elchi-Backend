-- 63HO6cBU (PR-C, C2 / Y-3) — migratsiya 246 down() / PR-C kodini orqaga
-- qaytarishdan OLDIN: filial → market to'lov holatini eski kod tushunadigan
-- `order_settlement_carry` qoldiqlariga o'tkazadi.
--
-- TARTIB (runbook, buzilsa pul ikki marta to'lanadi):
--   1) menejerning market to'lovlarini o'chirish (gateway / FE);
--   2) finance outbox'da yetkazilmagan `branch_to_market` advance = 0 ni
--      kutish (skript buni o'zi ham tekshiradi va bo'lsa ABORT qiladi);
--   3) order-service va finance-service'ni to'xtatish (PR-C kodi ishlab
--      tursa, konvertatsiyadan keyin ulush qayta tiklanib, menejer yana
--      to'lay oladi);
--   4) shu skript: psql -v ON_ERROR_STOP=1 -f scripts/order/convert-246-before-down.sql
--   5) migratsiya 246 down() (`npm run migration:revert`) — konvertatsiyadan
--      keyin o'z tekshiruvidan o'zi o'tadi (bypass yo'q);
--   6) eski kodni ishga tushirish.
--
--   • har filial X: COURIER_SETTLED qatorlarda filial to'lagan Σ qism
--     + (X, ·) qoldig'i → branch_to_hq(X) qoldig'i (filial bu pulni HQ
--     nomidan marketga bergan — HQ'ga qarzi shuncha kam);
--   • har market M: COURIER_SETTLED / BRANCH_SETTLED qatorlarda filial
--     to'lagan Σ qism + (·, M) qoldig'i → hq_to_market(M) qoldig'i (market
--     bu pulni olgan — HQ'ning qarzi shuncha kam);
--   • ko'chirilgan har summa va har qatorning avvalgi holati
--     `order_schema.order_settlement_246_conversion` ga yoziladi (izi). Shu
--     jadvalda qator bo'lsa migratsiya 246 up() RAD etadi — qayta up() ulushni
--     qayta tiriltirmasin; avval qayta solishtiring, so'ng jadvalni tozalang;
--   • so'ng filial to'lagan ustunlar 0 / NULL, (X, M) qoldiqlari 0.
--
-- MARKET_SETTLED qatorlar tegilmaydi (to'liq yopilgan). Bitta tranzaksiya;
-- qayta yurgizish xavfsiz (ikkinchi marta o'tkaziladigan summa 0).

BEGIN;

-- Y-3a — yetkazilmagan filial → market advance qolmagan bo'lsin (aks holda u
-- konvertatsiyaga kirmaydi, eski kod esa uni abadiy 400 bilan ushlab, market
-- yana qarzdor bo'lib qoladi). Jadval qulflanadi — tekshiruvdan keyin yangi
-- hodisa qo'shilmaydi.
LOCK TABLE "finance_schema"."outbox_events" IN SHARE MODE;

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM "finance_schema"."outbox_events"
   WHERE "status" IN ('pending', 'failed')
     AND "pattern" = 'order.settlement.advance'
     AND "payload"->>'level' = 'branch_to_market';
  IF n > 0 THEN
    RAISE EXCEPTION 'convert-246: finance outbox''da % ta yetkazilmagan branch_to_market advance bor — menejer to''lovlarini o''chiring, ular yetkazilishini kuting, servislarni to''xtating va qayta yurgizing', n;
  END IF;
END $$;

LOCK TABLE "order_schema"."order_settlement",
           "order_schema"."order_settlement_carry",
           "order_schema"."order_settlement_branch_market_carry"
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS "order_schema"."order_settlement_246_conversion" (
  "id" BIGSERIAL PRIMARY KEY,
  "converted_at" timestamptz NOT NULL DEFAULT now(),
  "kind" varchar(32) NOT NULL,
  "level" varchar(32),
  "party_id" bigint,
  "settlement_id" bigint,
  "branch_id" bigint,
  "market_id" bigint,
  "status" varchar(32),
  "amount" numeric(14,2) NOT NULL DEFAULT 0,
  "paid_at" timestamptz,
  "paid_by" bigint
);

-- Izi: har qatorning avvalgi holati va (X, M) qoldiqlari.
INSERT INTO "order_schema"."order_settlement_246_conversion"
  ("kind", "settlement_id", "branch_id", "market_id", "status", "amount", "paid_at", "paid_by")
SELECT 'settlement_row', s."id", s."branch_id", s."market_id", s."status"::text,
       s."market_paid_by_branch_amount", s."market_paid_by_branch_at", s."market_paid_by_branch_by"
  FROM "order_schema"."order_settlement" s
 WHERE s."market_paid_by_branch_amount" <> 0
    OR s."market_paid_by_branch_at" IS NOT NULL;

INSERT INTO "order_schema"."order_settlement_246_conversion"
  ("kind", "branch_id", "market_id", "amount")
SELECT 'branch_market_carry', c."branch_id", c."market_id", c."amount"
  FROM "order_schema"."order_settlement_branch_market_carry" c
 WHERE c."amount" <> 0;

WITH branch_part AS (
  SELECT x.branch_id, SUM(x.amount) AS amount
    FROM (
      SELECT s."branch_id", s."market_paid_by_branch_amount" AS amount
        FROM "order_schema"."order_settlement" s
       WHERE s."is_deleted" = false
         AND s."status" = 'courier_settled'
         AND s."market_paid_by_branch_amount" <> 0
      UNION ALL
      SELECT c."branch_id", c."amount"
        FROM "order_schema"."order_settlement_branch_market_carry" c
       WHERE c."amount" <> 0
    ) x
   GROUP BY x.branch_id
  HAVING SUM(x.amount) <> 0
), logged AS (
  INSERT INTO "order_schema"."order_settlement_246_conversion" ("kind", "level", "party_id", "amount")
  SELECT 'carry_moved', 'branch_to_hq', b.branch_id, b.amount FROM branch_part b
)
INSERT INTO "order_schema"."order_settlement_carry" ("level", "party_id", "amount")
SELECT 'branch_to_hq', b.branch_id, b.amount FROM branch_part b
ON CONFLICT ("level", "party_id")
DO UPDATE SET "amount" = "order_schema"."order_settlement_carry"."amount" + EXCLUDED."amount",
              "updatedAt" = now();

WITH market_part AS (
  SELECT x.market_id, SUM(x.amount) AS amount
    FROM (
      SELECT s."market_id", s."market_paid_by_branch_amount" AS amount
        FROM "order_schema"."order_settlement" s
       WHERE s."is_deleted" = false
         AND s."status" IN ('courier_settled', 'branch_settled')
         AND s."market_paid_by_branch_amount" <> 0
      UNION ALL
      SELECT c."market_id", c."amount"
        FROM "order_schema"."order_settlement_branch_market_carry" c
       WHERE c."amount" <> 0
    ) x
   GROUP BY x.market_id
  HAVING SUM(x.amount) <> 0
), logged AS (
  INSERT INTO "order_schema"."order_settlement_246_conversion" ("kind", "level", "party_id", "amount")
  SELECT 'carry_moved', 'hq_to_market', m.market_id, m.amount FROM market_part m
)
INSERT INTO "order_schema"."order_settlement_carry" ("level", "party_id", "amount")
SELECT 'hq_to_market', m.market_id, m.amount FROM market_part m
ON CONFLICT ("level", "party_id")
DO UPDATE SET "amount" = "order_schema"."order_settlement_carry"."amount" + EXCLUDED."amount",
              "updatedAt" = now();

UPDATE "order_schema"."order_settlement"
   SET "market_paid_by_branch_amount" = 0,
       "market_paid_by_branch_at" = NULL,
       "market_paid_by_branch_by" = NULL
 WHERE "market_paid_by_branch_amount" <> 0
    OR "market_paid_by_branch_at" IS NOT NULL;

UPDATE "order_schema"."order_settlement_branch_market_carry"
   SET "amount" = 0, "updatedAt" = now()
 WHERE "amount" <> 0;

COMMIT;
