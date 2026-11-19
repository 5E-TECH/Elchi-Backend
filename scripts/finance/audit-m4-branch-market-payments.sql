-- 63HO6cBU (P0, PR-C) — FAQAT O'QIYDIGAN audit (hech narsa yozmaydi).
-- Prod'da avtomatik yurgizilmaydi: DBA qo'lda, read-only sessiyada:
--   BEGIN TRANSACTION READ ONLY;  \i scripts/finance/audit-m4-branch-market-payments.sql;  ROLLBACK;
--
-- Maqsad: audit M4 (2026-11-11) dan beri menejer filial kassasidan marketga
-- to'laganda (cashbox_history: BRANCH kassasi, market_payment, expense) daftar
-- ikki mustaqil FIFO bilan yopilgan edi:
--   • branch_to_hq  (filial bo'yicha)  — X ning HAR market qatorini;
--   • hq_to_market  (market bo'yicha)  — M ning HAR filial / HQ qatorini.
-- Bu so'rov o'sha to'lov vaqtiga (±5 daqiqa, outbox kechikishi) to'g'ri
-- kelgan va to'lovchi juftligiga (X, M) MOS KELMAGAN yopilishlarni topadi.
-- Natija TAXMINIY (vaqt oynasi bo'yicha) — har qatorni buxgalter tekshiradi.
-- Tarixiy yozuvlar qayta yozilmaydi.

WITH branch_market_payments AS (
  SELECT h."id"               AS history_id,
         h."createdAt"        AS paid_at,
         h."amount"           AS amount,
         h."created_by"       AS paid_by,
         cb."user_id"         AS branch_id,
         h."source_user_id"   AS market_id
    FROM "finance_schema"."cashbox_history" h
    JOIN "finance_schema"."cashboxes" cb ON cb."id" = h."cashbox_id"
   WHERE cb."cashbox_type" = 'branch'
     AND h."source_type" = 'market_payment'
     AND h."operation_type" = 'expense'
     AND h."is_deleted" = false
     AND h."createdAt" >= TIMESTAMPTZ '2026-11-11 00:00:00+05'
)
-- 1) hq_to_market shu to'lov paytida M ning BOSHQA filial / HQ qatorini yopgan.
SELECT 'hq_to_market: boshqa filial/HQ qatori' AS finding,
       p.history_id, p.paid_at, p.branch_id AS payer_branch_id, p.market_id,
       p.amount AS payment_amount,
       s."order_id", s."branch_id" AS row_branch_id, s."market_id" AS row_market_id,
       s."market_amount", s."hq_to_market_at" AS closed_at
  FROM branch_market_payments p
  JOIN "order_schema"."order_settlement" s
    ON s."market_id" = p.market_id
   AND s."hq_to_market_at" BETWEEN p.paid_at - INTERVAL '5 minutes'
                               AND p.paid_at + INTERVAL '5 minutes'
   AND s."is_deleted" = false
 WHERE s."branch_id" IS DISTINCT FROM p.branch_id
UNION ALL
-- 2) branch_to_hq shu to'lov paytida X ning BOSHQA market qatorini yopgan.
SELECT 'branch_to_hq: boshqa market qatori' AS finding,
       p.history_id, p.paid_at, p.branch_id, p.market_id,
       p.amount,
       s."order_id", s."branch_id", s."market_id",
       s."market_amount", s."branch_to_hq_at" AS closed_at
  FROM branch_market_payments p
  JOIN "order_schema"."order_settlement" s
    ON s."branch_id" = p.branch_id
   AND s."branch_to_hq_at" BETWEEN p.paid_at - INTERVAL '5 minutes'
                               AND p.paid_at + INTERVAL '5 minutes'
   AND s."is_deleted" = false
 WHERE s."market_id" IS DISTINCT FROM p.market_id
ORDER BY 3, 2;
