-- Empirik reproduksiya: dashboard successRate > 100%
-- Hech narsa saqlanmaydi -- oxirida ROLLBACK.
BEGIN;

CREATE SCHEMA repro;
SET search_path TO repro;

CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  status text,
  sold_at bigint,
  "createdAt" timestamptz,
  assigned_at timestamptz,
  parent_order_id bigint,
  "isDeleted" boolean DEFAULT false
);

CREATE TABLE order_tracking (
  id bigserial PRIMARY KEY,
  order_id bigint,
  to_status text,
  action text,
  created_at timestamptz
);

-- Oyna (window): 2026-07-01 .. 2026-07-31
-- epoch ms: 2026-07-01 = 1782950400000, 2026-07-31 = 1785542400000 (taxminiy, faqat ichki izchillik uchun)

-- (A) 6 ta buyurtma: iyulda filialga qabul qilingan VA iyulda sotilgan  -> ikkalasida ham
INSERT INTO orders (status, sold_at, "createdAt", assigned_at)
SELECT 'SOLD', 1783000000000, '2026-07-02', '2026-07-02' FROM generate_series(1,6);
INSERT INTO order_tracking (order_id, to_status, action, created_at)
SELECT id, 'RECEIVED', 'branch_batch_received', '2026-07-02' FROM orders WHERE sold_at = 1783000000000;

-- (B) 2 ta buyurtma: iyulda qabul qilingan, LEKIN hali sotilmagan -> faqat maxrajda
INSERT INTO orders (status, sold_at, "createdAt", assigned_at)
SELECT 'ON_THE_ROAD', NULL, '2026-07-05', '2026-07-05' FROM generate_series(1,2);
INSERT INTO order_tracking (order_id, to_status, action, created_at)
SELECT id, 'RECEIVED', 'branch_batch_received', '2026-07-05' FROM orders WHERE status = 'ON_THE_ROAD';

-- (C) SABAB #1: iyun oyida qabul qilingan, iyulda sotilgan 7 ta -> faqat suratda
INSERT INTO orders (status, sold_at, "createdAt", assigned_at)
SELECT 'PAID', 1783200000000, '2026-06-20', '2026-06-20' FROM generate_series(1,7);
INSERT INTO order_tracking (order_id, to_status, action, created_at)
SELECT id, 'RECEIVED', 'branch_batch_received', '2026-06-20' FROM orders WHERE sold_at = 1783200000000;

-- (D) SABAB #2: parent/child dedup asimmetriyasi.
--     1 ta parent 3 ta child'ga bo'lingan, hammasi iyulda qabul + iyulda sotilgan.
--     accepted: COUNT(DISTINCT COALESCE(parent_order_id,id)) -> 1 ta
--     sold:     COUNT(*)                                     -> 3 ta
INSERT INTO orders (id, status, sold_at, "createdAt") VALUES (9000, 'CLOSED', NULL, '2026-07-10');
INSERT INTO orders (status, sold_at, "createdAt", parent_order_id)
SELECT 'SOLD', 1783300000000, '2026-07-10', 9000 FROM generate_series(1,3);
INSERT INTO order_tracking (order_id, to_status, action, created_at)
SELECT id, 'RECEIVED', 'branch_batch_received', '2026-07-10' FROM orders WHERE parent_order_id = 9000;

-- (E) SABAB #3: filial batch'idan o'tmagan (markazdan to'g'ridan-to'g'ri) 2 ta sotuv
--     -> hech qachon accepted'ga tushmaydi, lekin sold'da bor
INSERT INTO orders (status, sold_at, "createdAt")
SELECT 'PARTLY_PAID', 1783400000000, '2026-07-12' FROM generate_series(1,2);

-- ============ getOverviewStats() ning AYNAN o'sha ikki so'rovi ============
WITH accepted AS (
  -- countBranchBatchAcceptedOrders()  order-analytics.service.ts:266-288
  SELECT COUNT(DISTINCT COALESCE(o.parent_order_id, o.id))::int AS c
  FROM order_tracking t
  INNER JOIN orders o ON o.id = t.order_id
  WHERE o."isDeleted" = false
    AND t.action = 'branch_batch_received'
    AND t.to_status = 'RECEIVED'
    AND t.created_at BETWEEN '2026-07-01' AND '2026-07-31'
),
sold AS (
  -- soldOrdersQuery  order-analytics.service.ts:589-616
  SELECT COUNT(*)::int AS c
  FROM orders o
  WHERE o."isDeleted" = false
    AND o.status IN ('SOLD','PAID','PARTLY_PAID')
    AND o.sold_at BETWEEN 1782950400000 AND 1785542400000
)
SELECT
  accepted.c                                        AS "acceptedCount (maxraj)",
  sold.c                                            AS "soldAndPaid (surat)",
  ROUND(sold.c * 100.0 / accepted.c, 1)             AS "successRate %",
  accepted.c - sold.c                               AS "inProgress = accepted-sold-cancelled"
FROM accepted, sold;

ROLLBACK;
