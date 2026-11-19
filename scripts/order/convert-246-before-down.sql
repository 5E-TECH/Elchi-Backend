-- 63HO6cBU (PR-C, C2) — migratsiya 246 down() / PR-C kodini orqaga
-- qaytarishdan OLDIN: filial → market to'lov holatini eski kod tushunadigan
-- `order_settlement_carry` qoldiqlariga o'tkazadi.
--
--   • har filial X: COURIER_SETTLED qatorlarda filial to'lagan Σ qism
--     + (X, ·) qoldig'i → branch_to_hq(X) qoldig'i (filial bu pulni HQ
--     nomidan marketga bergan — HQ'ga qarzi shuncha kam);
--   • har market M: COURIER_SETTLED / BRANCH_SETTLED qatorlarda filial
--     to'lagan Σ qism + (·, M) qoldig'i → hq_to_market(M) qoldig'i (market
--     bu pulni olgan — HQ'ning qarzi shuncha kam);
--   • so'ng filial to'lagan ustunlar 0 / NULL, (X, M) qoldiqlari 0.
--
-- MARKET_SETTLED qatorlar tegilmaydi (to'liq yopilgan). Bitta tranzaksiya;
-- qayta yurgizish xavfsiz (ikkinchi marta o'tkaziladigan summa 0).
-- Keyin: MIGRATION_246_DOWN_CONVERTED=1 npm run migration:revert.

BEGIN;

LOCK TABLE "order_schema"."order_settlement",
           "order_schema"."order_settlement_carry",
           "order_schema"."order_settlement_branch_market_carry"
  IN SHARE ROW EXCLUSIVE MODE;

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
