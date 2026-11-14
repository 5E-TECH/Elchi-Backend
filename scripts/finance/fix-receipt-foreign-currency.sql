-- F1 bir martalik tuzatish: so'mda BO'LMAGAN cheklar uchun AI "farqi" null.
--
-- Ilgari valyuta UZS bo'lmasa ham difference = o'qilgan − kiritilgan yozilardi
-- (100 USD chek ~1,25 mln so'm "farq") va bu chek tekshiruvi jamiga hamda
-- top-15 ga kirardi. Yangi kod (receipt.rules.ts) bunday chekda
-- difference = null, error_reason = 'currency_not_uzs', status 'mismatch'.
-- Bu skript ESKI qatorlarni shu holatga keltiradi. Idempotent.
--
-- Ishga tushirish (deploydan KEYIN, serverda):
--   docker exec -i elchi-postgres sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -f -' \
--     < scripts/finance/fix-receipt-foreign-currency.sql
--
-- Avval faqat 1-qadamni (SELECT) ko'rish uchun oxiridagi COMMIT'ni ROLLBACK
-- ga almashtirib yurgizing.

BEGIN;

-- 1. Nechta qator tuzatiladi (valyuta bo'yicha).
SELECT upper(btrim("ai_currency")) AS currency,
       "ai_status",
       COUNT(*) AS rows,
       COALESCE(SUM(abs("ai_difference")), 0) AS inflated_abs_difference
FROM "finance_schema"."cashbox_receipts"
WHERE "ai_currency" IS NOT NULL
  AND btrim("ai_currency") <> ''
  AND upper(btrim("ai_currency")) <> 'UZS'
  AND "ai_status" IN ('match', 'mismatch')
  AND ("ai_difference" IS NOT NULL OR "ai_error_reason" IS DISTINCT FROM 'currency_not_uzs')
GROUP BY 1, 2
ORDER BY rows DESC;

-- 2. Tuzatish.
UPDATE "finance_schema"."cashbox_receipts"
SET "ai_status" = 'mismatch',
    "ai_difference" = NULL,
    "ai_error_reason" = 'currency_not_uzs',
    "updatedAt" = now()
WHERE "ai_currency" IS NOT NULL
  AND btrim("ai_currency") <> ''
  AND upper(btrim("ai_currency")) <> 'UZS'
  AND "ai_status" IN ('match', 'mismatch')
  AND ("ai_difference" IS NOT NULL OR "ai_error_reason" IS DISTINCT FROM 'currency_not_uzs');

COMMIT;
