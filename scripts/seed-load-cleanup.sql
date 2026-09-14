-- =====================================================================
--  YUK TESTI MA'LUMOTLARINI O'CHIRISH
-- =====================================================================
--
--  `seed-load-data.sql` yaratgan qatorlarni — VA FAQAT ULARNI — o'chiradi.
--  Belgisi: `orders.external_id LIKE 'SEED-%'`.
--
--  ⚠️ NEGA BU FAYL MAJBURIY. Test tizimi ertaga haqiqiy ishga o'tadi.
--  Soxta buyurtmalar qolib ketsa, ular hisobotlarga, analitikaga va
--  moliyaviy balansga qo'shilib ketadi — ya'ni raqamlar jimgina noto'g'ri
--  bo'ladi. Aynan audit topgan xatolar turi.
--
--  ISHLATISH (serverda):
--    docker exec -i elchi-postgres psql -U <user> -d <db> \
--      -f - < scripts/seed-load-cleanup.sql
--
--  `order_items` CASCADE bilan o'chadi (FK ON DELETE CASCADE), hisob-kitob
--  qatorlari esa ataylab ALOHIDA o'chiriladi: ularda `orders` ga FK yo'q.
-- =====================================================================

\set ON_ERROR_STOP on
\timing on

\echo ''
\echo '  O''chirishdan OLDINGI holat:'
SELECT
  (SELECT count(*) FROM order_schema.orders)           AS buyurtmalar,
  (SELECT count(*) FROM order_schema.orders
     WHERE external_id LIKE 'SEED-%')                  AS seed_buyurtmalar,
  (SELECT count(*) FROM order_schema.order_settlement) AS hisob_kitob;

\echo '  Hisob-kitob qatorlari o''chirilmoqda...'
DELETE FROM order_schema.order_settlement s
WHERE EXISTS (
  SELECT 1 FROM order_schema.orders o
  WHERE o.id = s.order_id
    AND o.external_id LIKE 'SEED-%'
);

\echo '  Buyurtmalar o''chirilmoqda (mahsulotlar CASCADE bilan)...'
DELETE FROM order_schema.orders WHERE external_id LIKE 'SEED-%';

\echo '  ANALYZE...'
ANALYZE order_schema.orders;
ANALYZE order_schema.order_items;
ANALYZE order_schema.order_settlement;

\echo ''
\echo '  O''chirishdan KEYINGI holat:'
SELECT
  (SELECT count(*) FROM order_schema.orders)           AS buyurtmalar,
  (SELECT count(*) FROM order_schema.orders
     WHERE external_id LIKE 'SEED-%')                  AS seed_qoldiq,
  (SELECT count(*) FROM order_schema.order_items)      AS mahsulotlar,
  (SELECT count(*) FROM order_schema.order_settlement) AS hisob_kitob,
  pg_size_pretty(pg_database_size(current_database())) AS baza_hajmi;
