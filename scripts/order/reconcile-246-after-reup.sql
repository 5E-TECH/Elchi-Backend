-- 63HO6cBU (PR-C, X737-3) — FIX-FORWARD: migratsiya 246 orqaga qaytarilgan
-- (convert-246-before-down.sql + down()) va endi PR-C qayta yoqilmoqda.
-- Konvertatsiya izidan (`order_schema.order_settlement_246_conversion`)
-- filial → market to'lov holatini AYNAN tiklaydi:
--   • `settlement_row` — qatorning `market_paid_by_branch_amount/_at/_by` i;
--   • `carry_moved`    — `order_settlement_carry` (branch_to_hq / hq_to_market)
--                         qoldiqlaridan ko'chirilgan summa AYIRILADI;
--   • `branch_market_carry` — (X, M) qoldiqlari qayta yoziladi;
--   • so'ng iz o'chiriladi.
--
-- TARTIB:
--   1) order-service / finance-service to'xtatilgan (eski kod ishlamaydi);
--   2) psql -v ON_ERROR_STOP=1 -f scripts/order/reconcile-246-after-reup.sql
--      — skript 246 ning ustun / jadval / indekslarini o'zi qo'shadi
--      (IF NOT EXISTS, migratsiya bilan AYNAN), chunki iz bor ekan 246 up()
--      rad etadi;
--   3) migration:run — 246 up() endi iz yo'q, sxema bor — faqat yozib qo'yadi;
--   4) PR-C kodini ishga tushirish.
--
-- FAIL-CLOSED: konvertatsiyadan keyin daftar o'zgargan bo'lsa (eski kod
-- qoldiqni ishlatgan yoki qator holati o'zgargan) — ABORT, hech narsa
-- o'zgarmaydi: avtomatik tiklash ikki marta hisoblardi, qo'lda solishtirish
-- kerak. Bitta tranzaksiya; lock_timeout 5 s.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('"order_schema"."order_settlement_246_conversion"') IS NULL THEN
    RAISE EXCEPTION 'reconcile-246: konvertatsiya izi jadvali yo''q — tiklanadigan narsa yo''q';
  END IF;
END $$;

LOCK TABLE "order_schema"."order_settlement",
           "order_schema"."order_settlement_carry",
           "order_schema"."order_settlement_246_conversion"
  IN SHARE ROW EXCLUSIVE MODE;

-- 246 sxemasi (migratsiya bilan AYNAN, IF NOT EXISTS).
ALTER TABLE "order_schema"."order_settlement"
  ADD COLUMN IF NOT EXISTS "market_paid_by_branch_at" timestamptz NULL,
  ADD COLUMN IF NOT EXISTS "market_paid_by_branch_by" bigint NULL,
  ADD COLUMN IF NOT EXISTS "market_paid_by_branch_amount" numeric(14,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "order_schema"."order_settlement_branch_market_carry" (
  "id" BIGSERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "is_deleted" boolean NOT NULL DEFAULT false,
  "branch_id" bigint NOT NULL,
  "market_id" bigint NOT NULL,
  "amount" numeric(14,2) NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_settlement_branch_market_carry"
  ON "order_schema"."order_settlement_branch_market_carry" ("branch_id", "market_id");
CREATE INDEX IF NOT EXISTS "IDX_order_settlement_branch_market_open"
  ON "order_schema"."order_settlement" ("branch_id", "market_id", "createdAt", "id")
  WHERE "status" = 'courier_settled'
    AND "market_paid_by_branch_at" IS NULL
    AND "is_deleted" = false;

DO $$
DECLARE
  traces integer;
  moved_rows integer;
  consumed integer;
  already integer;
BEGIN
  SELECT count(*) INTO traces FROM "order_schema"."order_settlement_246_conversion";
  IF traces = 0 THEN
    RAISE EXCEPTION 'reconcile-246: iz bo''sh — tiklanadigan narsa yo''q';
  END IF;

  -- Qator konvertatsiyadan keyin o'zgargan (o'chirilgan / holati boshqa)?
  SELECT count(*) INTO moved_rows
    FROM "order_schema"."order_settlement_246_conversion" t
    LEFT JOIN "order_schema"."order_settlement" s ON s."id" = t."settlement_id"
   WHERE t."kind" = 'settlement_row'
     AND (s."id" IS NULL OR s."is_deleted" OR s."status"::text IS DISTINCT FROM t."status");
  IF moved_rows > 0 THEN
    RAISE EXCEPTION 'reconcile-246: % ta qator konvertatsiyadan keyin o''zgargan (holat / o''chirilgan) — qo''lda solishtiring', moved_rows;
  END IF;

  -- Qator allaqachon «filial to'lagan» belgisiga ega (ikkinchi marta yurgizish)?
  SELECT count(*) INTO already
    FROM "order_schema"."order_settlement_246_conversion" t
    JOIN "order_schema"."order_settlement" s ON s."id" = t."settlement_id"
   WHERE t."kind" = 'settlement_row'
     AND (s."market_paid_by_branch_amount" <> 0 OR s."market_paid_by_branch_at" IS NOT NULL);
  IF already > 0 THEN
    RAISE EXCEPTION 'reconcile-246: % ta qatorda filial to''lagan belgisi allaqachon bor — qo''lda solishtiring', already;
  END IF;

  -- Ko'chirilgan qoldiq eski kod tomonidan ishlatilgan (joriy < ko'chirilgan)?
  SELECT count(*) INTO consumed
    FROM (
      SELECT t."level", t."party_id", SUM(t."amount") AS moved
        FROM "order_schema"."order_settlement_246_conversion" t
       WHERE t."kind" = 'carry_moved'
       GROUP BY t."level", t."party_id"
    ) m
    LEFT JOIN "order_schema"."order_settlement_carry" c
      ON c."level" = m."level" AND c."party_id" = m."party_id"
   WHERE COALESCE(c."amount", 0) < m.moved;
  IF consumed > 0 THEN
    RAISE EXCEPTION 'reconcile-246: % ta qoldiq konvertatsiyadan keyin ishlatilgan — avtomatik tiklash ikki marta hisoblardi, qo''lda solishtiring', consumed;
  END IF;
END $$;

-- 1) Qatorlar: filial to'lagan holat.
UPDATE "order_schema"."order_settlement" s
   SET "market_paid_by_branch_amount" = t."amount",
       "market_paid_by_branch_at" = t."paid_at",
       "market_paid_by_branch_by" = t."paid_by"
  FROM "order_schema"."order_settlement_246_conversion" t
 WHERE t."kind" = 'settlement_row'
   AND s."id" = t."settlement_id";

-- 2) Qoldiqlar: ko'chirilgan summa ayiriladi.
UPDATE "order_schema"."order_settlement_carry" c
   SET "amount" = c."amount" - m.moved,
       "updatedAt" = now()
  FROM (
    SELECT t."level", t."party_id", SUM(t."amount") AS moved
      FROM "order_schema"."order_settlement_246_conversion" t
     WHERE t."kind" = 'carry_moved'
     GROUP BY t."level", t."party_id"
  ) m
 WHERE c."level" = m."level" AND c."party_id" = m."party_id";

-- 3) (X, M) qoldiqlari.
INSERT INTO "order_schema"."order_settlement_branch_market_carry" ("branch_id", "market_id", "amount")
SELECT t."branch_id", t."market_id", SUM(t."amount")
  FROM "order_schema"."order_settlement_246_conversion" t
 WHERE t."kind" = 'branch_market_carry'
 GROUP BY t."branch_id", t."market_id"
ON CONFLICT ("branch_id", "market_id")
DO UPDATE SET "amount" = "order_schema"."order_settlement_branch_market_carry"."amount" + EXCLUDED."amount",
              "updatedAt" = now();

-- 4) Iz o'chiriladi — 246 up() endi o'tadi.
DELETE FROM "order_schema"."order_settlement_246_conversion";

COMMIT;
