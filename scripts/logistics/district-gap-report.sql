-- D1: rasmiy SOATO'da bor, seed'da (regions-districts.data.ts) YO'Q 25 birlik
-- va bazada yalang'och shahar nomi bilan TUMAN qatorida turgan 9 juft —
-- prod holati (FAQAT O'QISH, shaxsiy ma'lumotsiz). Qaror hujjati:
-- docs/ai/DISTRICT_GAP_D1.md.
--
--   docker exec -i elchi-postgres sh -c \
--     'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -P pager=off -f -' \
--     < scripts/logistics/district-gap-report.sql > /root/district-gap-$(date +%F).txt
--
-- Natijani (sanoqlar va tuman/filial ID'lari) backend sessiyaga yuborish mumkin.

\set ON_ERROR_STOP on
-- Faqat sessiyaga xos TEMP jadval (doimiy jadvalga tegmaydi); so'ng hamma
-- SELECT bitta READ ONLY tranzaksiyada.
CREATE TEMP TABLE d1_gap (sato_code text, region_sato text, official_name text, base_name text);
INSERT INTO d1_gap VALUES
  ('1708212','1708','Sharof Rashidov tumani','Sharof Rashidov'),
  ('1708218','1708','Zomin tumani','Zomin'),
  ('1710245','1710','Shahrisabz tumani','Shahrisabz'),
  ('1712412','1712','G''ozg''on shahri','G''ozg''on'),
  ('1712244','1712','Tomdi tumani','Tomdi'),
  ('1712248','1712','Uchquduq tumani','Uchquduq'),
  ('1714401','1714','Namangan shahri','Namangan'),
  ('1714229','1714','Uychi tumani','Uychi'),
  ('1722401','1722','Termiz shahri','Termiz'),
  ('1724401','1724','Guliston shahri','Guliston'),
  ('1727413','1727','Bekobod shahri','Bekobod'),
  ('1727415','1727','Ohangaron shahri','Ohangaron'),
  ('1727424','1727','Yangiyo''l shahri','Yangiyo''l'),
  ('1727253','1727','O''rtachirchiq tumani','O''rtachirchiq'),
  ('1730401','1730','Farg''ona shahri','Farg''ona'),
  ('1730408','1730','Quvasoy shahri','Quvasoy'),
  ('1730206','1730','Qo''shtepa tumani','Qo''shtepa'),
  ('1730230','1730','O''zbekiston tumani','O''zbekiston'),
  ('1733401','1733','Urganch shahri','Urganch'),
  ('1733406','1733','Xiva shahri','Xiva'),
  ('1733221','1733','Tuproqqal''a tumani','Tuproqqal''a'),
  ('1733223','1733','Xonqa tumani','Xonqa'),
  ('1735401','1735','Nukus shahri','Nukus'),
  ('1735209','1735','Bo''zatov tumani','Bo''zatov'),
  ('1735228','1735','Taxiatosh tumani','Taxiatosh');

BEGIN TRANSACTION READ ONLY;

\echo '=== 1. Har birlik: prod''da shu SOATO bilan qator bormi; bo''lmasa shu viloyatda o''xshash nomli qatorlar ==='
\echo '    (seed fayldan tashqari qo''lda qo''shilgan bo''lishi mumkin)'
SELECT g.sato_code AS official_code,
       g.official_name,
       d.id AS district_id,
       d.name AS db_name,
       d.sato_code AS db_sato,
       d.is_deleted,
       d.serving_branch_id,
       d.assigned_region,
       (d.sato_code = g.sato_code) AS exact_code
FROM d1_gap g
LEFT JOIN logistics_schema.regions r ON r.sato_code = g.region_sato
LEFT JOIN logistics_schema.districts d
  ON d.sato_code = g.sato_code
  OR (d.region_id = r.id
      AND lower(replace(replace(d.name, '‘', ''''), '’', ''''))
          LIKE lower(g.base_name) || '%')
ORDER BY g.region_sato, g.sato_code, d.id;

\echo '=== 2. O''xshash qatorlar ishlatilishi: oxirgi 90 kun buyurtmalar, filiallar, foydalanuvchilar ==='
WITH cand AS (
  SELECT DISTINCT d.id, d.name, d.sato_code, g.official_name
  FROM d1_gap g
  JOIN logistics_schema.regions r ON r.sato_code = g.region_sato
  JOIN logistics_schema.districts d
    ON d.region_id = r.id
   AND lower(replace(replace(d.name, '‘', ''''), '’', ''''))
       LIKE lower(g.base_name) || '%'
)
SELECT c.official_name AS for_official,
       c.id AS district_id,
       c.name AS db_name,
       c.sato_code AS db_sato,
       (SELECT COUNT(*) FROM order_schema.orders o
         WHERE o.district_id = c.id AND o.is_deleted = false
           AND o."createdAt" >= now() - interval '90 days') AS orders_90d,
       (SELECT COUNT(*) FROM branch_schema.branches b
         WHERE b.district_id = c.id AND b.is_deleted = false) AS branches,
       (SELECT COUNT(*) FROM identity_schema.admins u
         WHERE u.district_id = c.id AND u.is_deleted = false) AS users
FROM cand c
ORDER BY c.official_name, c.id;

\echo '=== 3. Seed''dagi yalang''och shahar nomlari (tuman SOATO''si bilan) — 9 juft ==='
SELECT d.id, r.name AS region, d.name, d.sato_code, d.serving_branch_id
FROM logistics_schema.districts d
JOIN logistics_schema.regions r ON r.id = d.region_id
WHERE d.sato_code IN ('1714212','1722220','1724220','1727220','1727212',
                      '1727259','1730233','1733217','1735225','1710405')
ORDER BY d.sato_code;

ROLLBACK;
