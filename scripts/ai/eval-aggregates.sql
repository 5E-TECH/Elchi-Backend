-- AI buyurtma ekstraksiyasi — prod aniqligi AGREGATLARI (FAQAT O'QISH).
--
-- Yo'riqnoma: docs/ai/PROD_EVAL_EXPORT.md. Natijada shaxsiy ma'lumot YO'Q:
-- faqat sanoqlar, ulushlar, model/prompt nomlari va tuman NOMLARI/ID'lari.
--
--   psql "$POSTGRES_URI" -v days=30 -X -q -P pager=off \
--     -f scripts/ai/eval-aggregates.sql -o /root/ai-eval/aggregates.txt
--
-- Faqat sessiyaga xos TEMP VIEW yaratiladi (doimiy jadvalga tegmaydi), so'ng
-- hamma SELECT bitta READ ONLY tranzaksiyada — tasodifan yozish imkonsiz.

\set ON_ERROR_STOP on
\if :{?days}
\else
  \set days 30
\endif

-- Oyna: oxirgi :days kun ichida TASDIQLANGAN (draft_item yaratilgan) buyurtmalar.
CREATE TEMP VIEW ai_eval_items AS
SELECT i.id,
       i.draft_id,
       i.order_id,
       i.created_at,
       COALESCE(i.edited_fields, '[]'::jsonb) AS edited,
       i.field_corrections AS fc,
       d.model,
       d.prompt_version,
       d.source_kind,
       d.created_at AS draft_created_at
FROM ai_schema.ai_order_draft_item i
JOIN ai_schema.ai_order_draft d ON d.id = i.draft_id
WHERE i.created_at >= now() - (:days::int * interval '1 day');

BEGIN TRANSACTION READ ONLY;

\echo '=== 1. Maydon bo''yicha tuzatilgan / AI bo''sh qoldirgan ulushi (model × prompt_version) ==='
\echo '    edited_pct — operator o''zgartirgan; ai_null_pct — AI qiymat bermagan, operator to''ldirgan'
SELECT e.model,
       e.prompt_version,
       f.field,
       COUNT(*) AS confirmed,
       COUNT(*) FILTER (WHERE e.edited ? f.field) AS edited,
       ROUND(100.0 * COUNT(*) FILTER (WHERE e.edited ? f.field) / COUNT(*), 2) AS edited_pct,
       COUNT(*) FILTER (
         WHERE e.edited ? f.field
           AND e.fc ? f.field
           AND jsonb_typeof(e.fc -> f.field -> 'ai') IN ('null')
       ) AS ai_null,
       ROUND(100.0 * COUNT(*) FILTER (
         WHERE e.edited ? f.field
           AND e.fc ? f.field
           AND jsonb_typeof(e.fc -> f.field -> 'ai') IN ('null')
       ) / COUNT(*), 2) AS ai_null_pct
FROM ai_eval_items e
CROSS JOIN unnest(ARRAY[
  'customer_name', 'phone_number', 'extra_number', 'region_id', 'district_id',
  'address', 'total_price', 'where_deliver', 'comment', 'operator', 'items'
]) AS f(field)
GROUP BY 1, 2, 3
ORDER BY 1, 2, edited_pct DESC;

\echo '=== 2. Tuman chalkashlik juftlari (AI → operator), same_region bilan ==='
SELECT e.fc -> 'district_id' ->> 'ai' AS ai_district_id,
       da.name AS ai_district,
       e.fc -> 'district_id' ->> 'final' AS final_district_id,
       df.name AS final_district,
       (da.region_id IS NOT NULL AND da.region_id = df.region_id) AS same_region,
       COUNT(*) AS n
FROM ai_eval_items e
LEFT JOIN logistics_schema.districts da
  ON da.id::text = e.fc -> 'district_id' ->> 'ai'
LEFT JOIN logistics_schema.districts df
  ON df.id::text = e.fc -> 'district_id' ->> 'final'
WHERE e.fc ? 'district_id'
GROUP BY 1, 2, 3, 4, 5
ORDER BY n DESC
LIMIT 100;

\echo '=== 2b. Tuman: same_region / boshqa viloyat / AI bo''sh — jami ==='
SELECT CASE
         WHEN e.fc -> 'district_id' ->> 'ai' IS NULL THEN 'ai_null'
         WHEN da.region_id = df.region_id THEN 'same_region'
         ELSE 'other_region'
       END AS kind,
       COUNT(*) AS n
FROM ai_eval_items e
LEFT JOIN logistics_schema.districts da
  ON da.id::text = e.fc -> 'district_id' ->> 'ai'
LEFT JOIN logistics_schema.districts df
  ON df.id::text = e.fc -> 'district_id' ->> 'final'
WHERE e.fc ? 'district_id'
GROUP BY 1
ORDER BY n DESC;

\echo '=== 3. Narx tuzatishlari sinflari ==='
WITH p AS (
  SELECT e.model,
         CASE WHEN jsonb_typeof(e.fc -> 'total_price' -> 'ai') = 'number'
              THEN (e.fc -> 'total_price' ->> 'ai')::numeric END AS ai,
         CASE WHEN jsonb_typeof(e.fc -> 'total_price' -> 'final') = 'number'
              THEN (e.fc -> 'total_price' ->> 'final')::numeric END AS fin
  FROM ai_eval_items e
  WHERE e.fc ? 'total_price'
)
SELECT model,
       CASE
         WHEN ai IS NULL THEN 'ai_null'
         WHEN fin IS NULL THEN 'final_null'
         WHEN ai > 0 AND fin = ai * 1000 THEN 'x1000 (ming tushib qolgan)'
         WHEN ai > 0 AND ai = fin * 1000 THEN '/1000'
         WHEN ai > 0 AND (fin = ai * 10 OR fin = ai * 100) THEN 'x10/x100 (nol yo''qolgan)'
         WHEN ai > 0 AND (ai = fin * 10 OR ai = fin * 100) THEN '/10 yoki /100'
         WHEN abs(fin - ai) <= 60000 THEN '|farq| <= 60k (dostavka?)'
         WHEN ai > 0 AND fin > ai AND mod(fin, ai) = 0 THEN 'final = ai × N (miqdor?)'
         WHEN fin > 0 AND ai > fin AND mod(ai, fin) = 0 THEN 'ai = final × N (dona narxi × son?)'
         ELSE 'boshqa'
       END AS class,
       COUNT(*) AS n,
       ROUND(AVG(abs(fin - ai))) AS avg_abs_diff
FROM p
GROUP BY 1, 2
ORDER BY 1, n DESC;

\echo '=== 4. Tashlab ketilgan draftlar (AI preview berdi, birorta ham tasdiq yo''q, 1 kundan eski) ==='
SELECT d.model,
       d.prompt_version,
       d.outcome,
       COUNT(*) AS drafts,
       SUM(d.preview_count) AS previews,
       COUNT(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM ai_schema.ai_order_draft_item i WHERE i.draft_id = d.id
       )) AS abandoned,
       ROUND(100.0 * COUNT(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM ai_schema.ai_order_draft_item i WHERE i.draft_id = d.id
       )) / NULLIF(COUNT(*), 0), 2) AS abandoned_pct
FROM ai_schema.ai_order_draft d
WHERE d.created_at >= now() - (:days::int * interval '1 day')
  AND d.created_at < now() - interval '1 day'
GROUP BY 1, 2, 3
ORDER BY drafts DESC;

\echo '=== 5. Tasdiqdan keyingi drift: orders dagi joriy qiymat ≠ tasdiqlangan qiymat ==='
\echo '    (tasdiqlangan = field_corrections.final; tahrirlanmagan maydon tekshirilmaydi)'
SELECT COUNT(*) FILTER (WHERE e.fc ? 'district_id') AS district_checked,
       COUNT(*) FILTER (
         WHERE e.fc ? 'district_id'
           AND o.district_id::text IS DISTINCT FROM (e.fc -> 'district_id' ->> 'final')
       ) AS district_drift,
       COUNT(*) FILTER (
         WHERE jsonb_typeof(e.fc -> 'total_price' -> 'final') = 'number'
       ) AS price_checked,
       COUNT(*) FILTER (
         WHERE jsonb_typeof(e.fc -> 'total_price' -> 'final') = 'number'
           AND o.total_price::numeric <> (e.fc -> 'total_price' ->> 'final')::numeric
       ) AS price_drift,
       COUNT(*) FILTER (WHERE o.id IS NULL) AS order_missing,
       COUNT(*) FILTER (WHERE o.is_deleted) AS order_deleted
FROM ai_eval_items e
LEFT JOIN order_schema.orders o ON o.id = e.order_id;

\echo '=== 6. Kunlik model va outcome aralashmasi (draftlar) ==='
SELECT date_trunc('day', d.created_at AT TIME ZONE 'Asia/Tashkent')::date AS day,
       d.model,
       d.outcome,
       COUNT(*) AS drafts
FROM ai_schema.ai_order_draft d
WHERE d.created_at >= now() - (:days::int * interval '1 day')
GROUP BY 1, 2, 3
ORDER BY 1 DESC, drafts DESC;

\echo '=== 6b. Funksiya bo''yicha chaqiruvlar: outcome, stop_reason, keshdan ulush ==='
SELECT u.feature,
       u.model,
       u.outcome,
       u.stop_reason,
       COUNT(*) AS calls,
       ROUND(100.0 * SUM(u.cache_read_tokens)
             / NULLIF(SUM(u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens), 0), 1)
         AS cache_read_pct,
       ROUND(SUM(u.cost_usd)::numeric, 4) AS cost_usd
FROM ai_schema.ai_usage_log u
WHERE u."createdAt" >= now() - (:days::int * interval '1 day')
  AND u.is_deleted = false
GROUP BY 1, 2, 3, 4
ORDER BY 1, calls DESC;

ROLLBACK;
