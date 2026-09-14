-- =====================================================================
--  YUK TESTI UCHUN MA'LUMOT GENERATORI
-- =====================================================================
--
--  ⚠️ FAQAT TEST MUHITI UCHUN. Haqiqiy ma'lumotli bazada YURGIZILMAYDI.
--
--  NEGA KERAK. Sig'im savoliga ("kuniga nechta buyurtma?") bo'sh bazada
--  o'lchangan raqam javob bera olmaydi: 121 ta buyurtmada barcha so'rovlar
--  tez, chunki o'qiladigan narsa yo'q. Bizni qiziqtiradigan narsa — hajm
--  o'sishi bilan qaysi so'rov qanday sekinlashishi. Buning uchun real
--  taqsimotdagi ma'lumot kerak.
--
--  NIMA YARATILADI (har biri mavjud ma'lumotnomalardan tanlanadi —
--  marketlar, mijozlar, kuryerlar, filiallar, pochtalar, tumanlar):
--    • buyurtmalar — oxirgi 180 kunga taqsimlangan, real status nisbati
--      bilan (60% sotilgan/to'langan, 10% bekor, 5% qaytgan, 25% jarayonda)
--    • sotilgan buyurtmalarda PUL SNAPSHOTLARI (market_tariff,
--      courier_share, branch_share, sold_at, to_be_paid) — analitika
--      aynan shu ustunlardan foyda hisoblaydi
--    • har buyurtmaga 1–3 mahsulot qatori
--    • sotilganlar uchun `order_settlement` qatori — moliyaviy balans
--      so'rovi shu jadvalni skanerlaydi
--
--  BELGILANISHI VA O'CHIRILISHI. Har bir qator `external_id = 'SEED-<n>'`
--  bilan belgilanadi, ya'ni `scripts/seed-load-cleanup.sql` ularni
--  boshqalariga tegmasdan o'chiradi. Bu majburiy shart: test tizimi
--  ertaga haqiqiy ishga o'tadi va soxta buyurtmalar qolib ketmasligi kerak.
--
--  ISHLATISH (serverda):
--    docker exec -i elchi-postgres psql -U <user> -d <db> \
--      -v count=50000 -f - < scripts/seed-load-data.sql
--
--  Bosqichma-bosqich chaqirish mumkin: har chaqiruv MAVJUDLARI USTIGA
--  qo'shadi (50k → 200k → 500k), shunda sekinlashish egri chizig'i
--  ko'rinadi.
-- =====================================================================

\set ON_ERROR_STOP on
\timing on

\echo ''
\echo '  Ma''lumotnomalar tekshirilmoqda...'

DO $$
DECLARE
  markets   bigint[];
  customers bigint[];
BEGIN
  SELECT array_agg(id) INTO markets
    FROM identity_schema.admins WHERE role = 'market' AND is_deleted = false;
  SELECT array_agg(id) INTO customers
    FROM identity_schema.admins WHERE role = 'customer' AND is_deleted = false;

  IF markets IS NULL OR customers IS NULL THEN
    RAISE EXCEPTION
      'Ma''lumotnoma bo''sh: market yoki mijoz topilmadi. Seed to''xtatildi.';
  END IF;
END $$;

-- ---------------------------------------------------------------------
--  BUYURTMALAR
-- ---------------------------------------------------------------------
--  Taqsimot ATAYLAB deterministik (`g % N`), tasodifiy emas: shunda
--  qayta yurgizilganda ham bir xil shakl chiqadi va o'lchovlarni
--  solishtirib bo'ladi.
-- ---------------------------------------------------------------------
\echo '  Buyurtmalar yaratilmoqda...'

WITH ref AS (
  SELECT
    (SELECT array_agg(id) FROM identity_schema.admins
       WHERE role = 'market' AND is_deleted = false)   AS markets,
    (SELECT array_agg(id) FROM identity_schema.admins
       WHERE role = 'customer' AND is_deleted = false) AS customers,
    (SELECT array_agg(id) FROM identity_schema.admins
       WHERE role = 'courier' AND is_deleted = false)  AS couriers,
    (SELECT array_agg(id) FROM branch_schema.branches
       WHERE is_deleted = false)                       AS branches,
    (SELECT array_agg(id) FROM logistics_schema.posts
       WHERE is_deleted = false)                       AS posts,
    (SELECT array_agg(id) FROM logistics_schema.regions)   AS regions,
    (SELECT array_agg(id) FROM logistics_schema.districts) AS districts,
    (SELECT COALESCE(MAX(id), 0) FROM order_schema.orders)  AS max_order_id
),
gen AS (
  SELECT
    g,
    g % 20                                   AS bucket,
    -- 180 kunga yoyish + kun ichida tarqatish
    now()
      - ((g % 180) || ' days')::interval
      - ((g * 37 % 86400) || ' seconds')::interval AS created_at,
    -- Narx 50 000 … 1 025 000 oralig'ida
    (50000 + (g % 40) * 25000)::numeric      AS total_price,
    CASE WHEN g % 3 = 0 THEN 'center' ELSE 'address' END AS deliver_kind
  FROM generate_series(1, :count) g
),
rows AS (
  SELECT
    gen.*,
    ref.markets[1 + (gen.g % array_length(ref.markets, 1))]     AS market_id,
    ref.customers[1 + (gen.g % array_length(ref.customers, 1))] AS customer_id,
    ref.couriers[1 + (gen.g % array_length(ref.couriers, 1))]   AS courier_id,
    ref.branches[1 + (gen.g % array_length(ref.branches, 1))]   AS branch_id,
    ref.posts[1 + (gen.g % array_length(ref.posts, 1))]         AS post_id,
    ref.regions[1 + (gen.g % array_length(ref.regions, 1))]     AS region_id,
    ref.districts[1 + (gen.g % array_length(ref.districts, 1))] AS district_id,
    ref.max_order_id,
    CASE
      WHEN gen.bucket < 8  THEN 'sold'
      WHEN gen.bucket < 12 THEN 'paid'
      WHEN gen.bucket < 14 THEN 'cancelled'
      WHEN gen.bucket < 15 THEN 'returned_to_market'
      WHEN gen.bucket < 16 THEN 'new'
      WHEN gen.bucket < 17 THEN 'received'
      WHEN gen.bucket < 18 THEN 'on the road'
      WHEN gen.bucket < 19 THEN 'waiting'
      ELSE 'waiting_customer'
    END AS status_text,
    -- Tarif yetkazish turiga bog'liq (markazga arzonroq)
    CASE WHEN gen.deliver_kind = 'center' THEN 20000 ELSE 25000 END::numeric
      AS market_tariff,
    -- Kuryerlarning ~15% i oylikda ishlaydi → ulushi 0
    CASE
      WHEN gen.g % 7 = 0 THEN 0
      WHEN gen.deliver_kind = 'center' THEN 18000
      ELSE 22000
    END::numeric AS courier_share
  FROM gen CROSS JOIN ref
)
INSERT INTO order_schema.orders (
  "createdAt", "updatedAt", is_deleted,
  market_id, customer_id, product_quantity, where_deliver, total_price,
  to_be_paid, paid_amount, status, comment, external_id, source,
  market_tariff, courier_tariff, courier_share, branch_share,
  branch_cashbox_amount, sold_at, region_id, district_id,
  branch_id, home_branch_id, holder_branch_id, courier_id, post_id,
  holder_type, extra_cost, paid_online_amount, return_requested
)
SELECT
  created_at,
  created_at,
  false,
  market_id,
  customer_id,
  1 + (g % 3),
  deliver_kind::order_schema.orders_where_deliver_enum,
  total_price,
  -- Marketga qoladigan summa (ustun `integer` — shu bois yaxlitlanadi)
  CASE WHEN status_text IN ('sold', 'paid')
       THEN (total_price - market_tariff)::int ELSE 0 END,
  CASE WHEN status_text = 'paid'
       THEN (total_price - market_tariff)::int ELSE 0 END,
  status_text::order_schema.orders_status_enum,
  '[SEED] yuk testi uchun',
  'SEED-' || (max_order_id + g),
  'internal'::order_schema.orders_source_enum,
  CASE WHEN status_text IN ('sold', 'paid') THEN market_tariff END,
  CASE WHEN status_text IN ('sold', 'paid') THEN courier_share END,
  CASE WHEN status_text IN ('sold', 'paid') THEN courier_share END,
  CASE WHEN status_text IN ('sold', 'paid') THEN 0::numeric END,
  CASE WHEN status_text IN ('sold', 'paid') THEN 0::numeric END,
  -- `sold_at` — epoch millisekund (bigint), sotuv yaratilishdan ~1 kun keyin
  CASE WHEN status_text IN ('sold', 'paid')
       THEN (extract(epoch FROM created_at + interval '1 day') * 1000)::bigint
  END,
  region_id,
  district_id,
  branch_id,
  branch_id,
  branch_id,
  courier_id,
  post_id,
  'BRANCH'::order_schema.orders_holder_type_enum,
  0,
  0,
  false
FROM rows;

-- ---------------------------------------------------------------------
--  MAHSULOT QATORLARI (buyurtmaga 1–3 ta)
-- ---------------------------------------------------------------------
\echo '  Mahsulot qatorlari yaratilmoqda...'

INSERT INTO order_schema.order_items (
  "createdAt", "updatedAt", is_deleted, order_id, quantity, product_name
)
SELECT
  o."createdAt",
  o."createdAt",
  false,
  o.id,
  1 + (o.id % 3),
  'Seed mahsulot ' || ((o.id % 25) + 1)
FROM order_schema.orders o
WHERE o.external_id LIKE 'SEED-%'
  AND NOT EXISTS (
    SELECT 1 FROM order_schema.order_items i WHERE i.order_id = o.id
  );

-- ---------------------------------------------------------------------
--  HISOB-KITOB QATORLARI (sotilganlar uchun)
-- ---------------------------------------------------------------------
--  Moliyaviy balans va manager paneli aynan shu jadvaldan yig'indi oladi,
--  shuning uchun uni ham real hajmga chiqarish shart — aks holda o'sha
--  so'rovlar sun'iy ravishda tez ko'rinadi.
-- ---------------------------------------------------------------------
\echo '  Hisob-kitob qatorlari yaratilmoqda...'

INSERT INTO order_schema.order_settlement (
  "createdAt", "updatedAt", is_deleted,
  order_id, courier_id, branch_id, market_id,
  courier_amount, branch_amount, market_amount, status
)
SELECT
  o."createdAt",
  o."createdAt",
  false,
  o.id,
  o.courier_id,
  o.branch_id,
  o.market_id,
  o.total_price - COALESCE(o.courier_share, 0),
  o.total_price - COALESCE(o.courier_share, 0) - COALESCE(o.branch_share, 0),
  o.total_price - COALESCE(o.market_tariff, 0),
  -- Yo'ldagi pul taqsimoti: uchdan biri kuryerda, uchdan biri filialda,
  -- qolgani HQ'ga yetib kelgan va marketga to'langan.
  (CASE o.id % 4
     WHEN 0 THEN 'pending'
     WHEN 1 THEN 'courier_settled'
     WHEN 2 THEN 'branch_settled'
     ELSE 'market_settled'
   END)::order_schema.order_settlement_status_enum
FROM order_schema.orders o
WHERE o.external_id LIKE 'SEED-%'
  AND o.status IN ('sold', 'paid')
  AND NOT EXISTS (
    SELECT 1 FROM order_schema.order_settlement s WHERE s.order_id = o.id
  );

-- ---------------------------------------------------------------------
--  Planner statistikasi — busiz Postgres eski (bo'sh jadval) rejasidan
--  foydalanib, o'lchovni buzib ko'rsatadi.
-- ---------------------------------------------------------------------
\echo '  ANALYZE...'
ANALYZE order_schema.orders;
ANALYZE order_schema.order_items;
ANALYZE order_schema.order_settlement;

\echo ''
\echo '  ─── HOLAT ───────────────────────────────'
SELECT
  (SELECT count(*) FROM order_schema.orders)            AS buyurtmalar,
  (SELECT count(*) FROM order_schema.orders
     WHERE external_id LIKE 'SEED-%')                   AS seed_buyurtmalar,
  (SELECT count(*) FROM order_schema.order_items)       AS mahsulotlar,
  (SELECT count(*) FROM order_schema.order_settlement)  AS hisob_kitob,
  pg_size_pretty(pg_database_size(current_database()))  AS baza_hajmi;
