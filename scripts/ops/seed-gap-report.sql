-- =============================================================================
-- scripts/ops/seed-gap-report.sql — seed-gap hisoboti (FAQAT O'QISH)
-- =============================================================================
-- Nima uchun:
--   2026-11-11..14 da prod bazasi tozalandi (biznes va test ma'lumoti o'chirildi),
--   lekin order_schema.migrations jadvali barcha migratsiyalarni «bajarilgan» deb
--   biladi. Shuning uchun migratsiya yoki servis ishga tushishida yoziladigan
--   majburiy (seed / ma'lumotnoma) qatorlar qaytib kelmagan bo'lishi mumkin.
--   Ikki holat allaqachon tasdiqlangan va tuzatilgan: xarajat kategoriyalari
--   (migratsiya 1716000000230) va «Hisob qoidalari» (migratsiya 1716000000231,
--   PR #692). Bu skript qolgan HAMMA shubhali jadvalni bir yo'la tekshiradi.
--   Batafsil: docs/ops/SEED_GAP_AUDIT_2026-11-17.md
--
-- Natija — har tekshiruv uchun BITTA yozuv (expanded ko'rinishda):
--   n            tekshiruv raqami (hujjatdagi jadval bilan bir xil)
--   daraja       kritik / yuqori / o'rta / past / yo'q (audit bahosi)
--   tekshiruv    nima tekshirildi
--   jadval       schema.jadval
--   holat        OK | MISSING | NO_TABLE | WARN
--                  OK       joyida, yoki qator yo'qligi zararsiz (kod o'z sukutini oladi)
--                  MISSING  kerakli qator yo'q yoki noto'g'ri — nimadir buziladi
--                  NO_TABLE jadvalning o'zi yo'q (migratsiya yurmagan / sxema o'chgan)
--                  WARN     qatorlar bor, lekin nomuvofiqlik (dublikat, yetim id,
--                           eskirgan nusxa) — qo'lda ko'rib chiqish kerak
--   tafsilot     sonlar va dalillar
--   nima_qilish  keyingi qadam (UI, servisni qayta ishga tushirish yoki yangi migratsiya)
--
-- Xavfsizlik:
--   * Faqat SELECT. Hammasi BEGIN READ ONLY ... ROLLBACK ichida: INSERT, UPDATE,
--     DELETE yoki DDL yo'q, bazada hech narsa o'zgarmaydi.
--   * statement_timeout = 120 s, lock_timeout = 5 s: prod'ni uzoq ushlab turmaydi.
--   * Har jadval to_regclass bilan tekshiriladi, ichki so'rov faqat jadval bor
--     bo'lsa query_to_xml orqali yuradi: jadval yo'q bo'lsa xato emas, NO_TABLE.
--   * ON_ERROR_ROLLBACK on: biror tekshiruv xato bersa ham qolganlari yuradi.
--   * Shaxsiy ma'lumot chiqmaydi: faqat sonlar, id'lar, kodlar, sozlama kalitlari.
--
-- Ishga tushirish (prod serverda, repo ildizida):
--   docker exec -i elchi-postgres psql -X -U <user> -d <db> -f - \
--     < scripts/ops/seed-gap-report.sql > seed-gap-report.txt 2>&1
--   <user> va <db> — .env.production dagi POSTGRES_USER va POSTGRES_DB.
--   -v ON_ERROR_STOP=1 BERMANG: bitta tekshiruv xatosi qolganlarini to'xtatadi.
--   Davomiyligi: odatda bir necha soniya.
--
-- Natijani qaytarish: seed-gap-report.txt ni TO'LIQ yuboring (ERROR qatorlari ham).
-- =============================================================================

\set QUIET on
\set ON_ERROR_ROLLBACK on
\pset pager off
\pset null '-'
\x on

BEGIN READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';

\echo '=== Elchi seed-gap hisoboti (faqat o''qish) ==='
SELECT now() AS vaqt, current_database() AS baza, version() AS postgres;

-- -----------------------------------------------------------------------------
-- 00 — baza to'g'rimi: 13 servis sxemasi
-- -----------------------------------------------------------------------------
\echo '--- 00'
SELECT '00' AS n, 'yo''q' AS daraja,
       '13 ta servis sxemasi (to''g''ri bazaga ulandikmi)' AS tekshiruv,
       'pg_namespace' AS jadval,
       CASE WHEN count(n.nspname) = 13 THEN 'OK'
            WHEN count(n.nspname) = 0 THEN 'NO_TABLE'
            ELSE 'MISSING' END AS holat,
       CASE WHEN count(n.nspname) = 13 THEN '13/13 sxema bor'
            ELSE count(n.nspname) || '/13 bor; yo''q: '
                 || string_agg(e.s, ', ' ORDER BY e.s) FILTER (WHERE n.nspname IS NULL) END AS tafsilot,
       CASE WHEN count(n.nspname) = 13 THEN 'Hech narsa qilish shart emas.'
            WHEN count(n.nspname) = 0 THEN 'Bu Elchi bazasi emas yoki -d noto''g''ri: .env.production dagi POSTGRES_DB ni tekshirib qayta yurgizing.'
            ELSE 'Sxema o''chirilgan (DROP SCHEMA) — bu oddiy tozalash emas. Avtomatik tiklamang: ichidagi jadvallar ham yo''q, migrations esa ularni bajarilgan deb biladi. Dump''dan tiklash kerak.' END AS nima_qilish
FROM (VALUES ('identity_schema'), ('order_schema'), ('catalog_schema'), ('logistics_schema'),
             ('finance_schema'), ('notification_schema'), ('integration_schema'), ('branch_schema'),
             ('investor_schema'), ('c2c_schema'), ('search_schema'), ('ai_schema'), ('file_schema')) AS e(s)
LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = e.s;

-- =============================================================================
-- KRITIK
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 01 — migratsiyalar hisobi (TypeORM bookkeeping, 13 sxema uchun bitta jadval)
--   main ro'yxati: origin/main dagi 224 fayl; dev ro'yxati: faqat dev'dagilar (227, 228, 231).
--   Ro'yxatlar 2026-11-17 holati: keyin qo'shilgan migratsiyalar hisobga olinmaydi (xato bermaydi).
--   «teshik» = main'dagi, eng oxirgi yozilgandan eski, lekin yozilmagan migratsiya.
-- -----------------------------------------------------------------------------
\echo '--- 01'
SELECT '01' AS n, 'kritik' AS daraja,
       'Migratsiyalar hisobi: bo''sh yoki teshik bo''lsa keyingi deploy eski migratsiyalarni qayta yurgizadi' AS tekshiruv,
       'order_schema.migrations' AS jadval,
       coalesce(r.holat, 'XATO') AS holat,
       r.tafsilot
         || CASE WHEN to_regclass('public.migrations') IS NOT NULL
                 THEN '; DIQQAT: public.migrations ham bor (DB_SCHEMA=order_schema siz qo''lda migration:run?)'
                 ELSE '' END AS tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'XAVFLI (yangi bo''sh bazada esa normal): migratsiyali deploy''ni to''xtating. db:prepare bazani «yangi» deb hisoblab 227 migratsiyani jonli sxemada qayta yurgizadi (HYBRID filiallar jimgina PICKUP bo''ladi, 068 da yiqiladi, rollback bazani qaytarmaydi). Bookkeeping qatorlarini oxirgi backup''dan (backups/pre-deploy) tiklang — hujjatning 01-bandi.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'order_schema.migrations jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('order_schema.migrations') IS NOT NULL THEN query_to_xml($q$
    WITH main_exp AS (
      SELECT u.ts, count(*) AS c
        FROM unnest(string_to_array('1712400000000,1712515200000,1712601600000,1712700000000,1712800000000,1712900000000,1713000000000,1713100000000,1713200000000,1713201000000,1713203000000,1713204000000,1713205000000,1713206000000,1713207000000,1713208000000,1713300000000,1713400000000,1713500000000,1713600000000,1713700000000,1713800000000,1713900000000,1714000000000,1714100000000,1714300000000,1714400000000,1714500000000,1714600000000,1714700000000,1714800000000,1714900000000,1715000000000,1715000000000,1715100000000,1715200000000,1715300000000,1715400000000,1715500000000,1715600000000,1715700000000,1715800000000,1715900000000,1716000000000,1716000000001,1716000000002,1716000000003,1716000000004,1716000000005,1716000000006,1716000000007,1716000000008,1716000000008,1716000000009,1716000000009,1716000000010,1716000000011,1716000000012,1716000000013,1716000000014,1716000000015,1716000000016,1716000000017,1716000000018,1716000000019,1716000000020,1716000000021,1716000000023,1716000000024,1716000000025,1716000000026,1716000000027,1716000000028,1716000000029,1716000000030,1716000000031,1716000000032,1716000000033,1716000000034,1716000000035,1716000000036,1716000000037,1716000000038,1716000000039,1716000000040,1716000000041,1716000000042,1716000000043,1716000000044,1716000000045,1716000000046,1716000000047,1716000000048,1716000000049,1716000000050,1716000000051,1716000000052,1716000000053,1716000000054,1716000000055,1716000000056,1716000000057,1716000000058,1716000000059,1716000000060,1716000000061,1716000000062,1716000000064,1716000000065,1716000000066,1716000000068,1716000000069,1716000000071,1716000000075,1716000000076,1716000000077,1716000000078,1716000000079,1716000000080,1716000000081,1716000000084,1716000000085,1716000000086,1716000000087,1716000000089,1716000000092,1716000000098,1716000000099,1716000000100,1716000000101,1716000000104,1716000000105,1716000000106,1716000000107,1716000000108,1716000000111,1716000000113,1716000000114,1716000000116,1716000000117,1716000000118,1716000000119,1716000000120,1716000000121,1716000000122,1716000000123,1716000000124,1716000000125,1716000000126,1716000000127,1716000000128,1716000000129,1716000000130,1716000000140,1716000000141,1716000000142,1716000000143,1716000000150,1716000000151,1716000000152,1716000000153,1716000000154,1716000000155,1716000000156,1716000000157,1716000000160,1716000000161,1716000000163,1716000000164,1716000000165,1716000000166,1716000000167,1716000000170,1716000000171,1716000000172,1716000000174,1716000000176,1716000000182,1716000000183,1716000000184,1716000000185,1716000000186,1716000000187,1716000000188,1716000000189,1716000000190,1716000000191,1716000000192,1716000000193,1716000000194,1716000000195,1716000000196,1716000000197,1716000000198,1716000000199,1716000000200,1716000000201,1716000000202,1716000000203,1716000000204,1716000000205,1716000000206,1716000000207,1716000000208,1716000000209,1716000000210,1716000000211,1716000000212,1716000000213,1716000000214,1716000000215,1716000000216,1716000000217,1716000000218,1716000000219,1716000000220,1716000000221,1716000000222,1716000000223,1716000000224,1716000000225,1716000000226,1716000000229,1716000000230', ',')::bigint[]) AS u(ts) GROUP BY u.ts
    ), dev_exp AS (
      SELECT u.ts, count(*) AS c
        FROM unnest(string_to_array('1716000000227,1716000000228,1716000000231', ',')::bigint[]) AS u(ts) GROUP BY u.ts
    ), rec AS (
      SELECT "timestamp" AS ts, count(*) AS c FROM order_schema.migrations GROUP BY 1
    ), mx AS (
      SELECT count(*) AS total, max("timestamp") AS m FROM order_schema.migrations
    ), gaps AS (
      SELECT e.ts FROM main_exp e CROSS JOIN mx LEFT JOIN rec r ON r.ts = e.ts
       WHERE coalesce(r.c, 0) < e.c AND e.ts <= mx.m
    ), main_pending AS (
      SELECT e.ts FROM main_exp e CROSS JOIN mx LEFT JOIN rec r ON r.ts = e.ts
       WHERE coalesce(r.c, 0) < e.c AND e.ts > mx.m
    ), dev_pending AS (
      SELECT e.ts FROM dev_exp e LEFT JOIN rec r ON r.ts = e.ts WHERE coalesce(r.c, 0) < e.c
    )
    SELECT CASE WHEN mx.total = 0 THEN 'MISSING'
                WHEN (SELECT count(*) FROM gaps) > 0 THEN 'MISSING'
                ELSE 'OK' END AS holat,
           'qatorlar=' || mx.total
           || '; oxirgisi=' || coalesce((SELECT name FROM order_schema.migrations ORDER BY "timestamp" DESC, id DESC LIMIT 1), '-')
           || '; main''dagi, lekin yozilmagan eski migratsiyalar=' || (SELECT count(*) FROM gaps)
           || coalesce(' [' || (SELECT string_agg(ts::text, ',' ORDER BY ts) FROM (SELECT ts FROM gaps ORDER BY ts LIMIT 10) s) || ']', '')
           || '; main''dagi yangi (kutilmoqda)=' || (SELECT count(*) FROM main_pending)
           || '; dev''da, prod''ga hali chiqmagan (normal)=' || (SELECT count(*) FROM dev_pending)
           || coalesce(' [' || (SELECT string_agg(ts::text, ',' ORDER BY ts) FROM dev_pending) || ']', '')
           || '; 230=' || CASE WHEN EXISTS (SELECT 1 FROM rec WHERE ts = 1716000000230) THEN 'yozilgan' ELSE 'yo''q' END
           || '; 231=' || CASE WHEN EXISTS (SELECT 1 FROM rec WHERE ts = 1716000000231) THEN 'yozilgan' ELSE 'yo''q' END AS tafsilot,
           CASE WHEN mx.total > 0 AND (SELECT count(*) FROM gaps) > 0
                THEN 'main''dagi eski migratsiya(lar) yozilmagan: keyingi deploy ularni qayta yurgizadi. Deploy''dan oldin qo''lda tekshiring (ularning sxema obyektlari bormi); bor bo''lsa yozuvni backup''dan tiklang, yo''q bo''lsa qoldiring.' END AS nima
      FROM mx
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 02 — xarajat kategoriyalari: 17 ta standart (migratsiya 129/197/214, restore 230)
-- -----------------------------------------------------------------------------
\echo '--- 02'
SELECT '02' AS n, 'kritik' AS daraja,
       'Xarajat kategoriyalari: 17 ta standart qator (bo''sh bo''lsa kassadan chiqim saqlanmaydi)' AS tekshiruv,
       'finance_schema.cashbox_expense_categories' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q: migratsiya 129 yurmagan — migration-runner loglarini tekshiring.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'finance_schema.cashbox_expense_categories jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('finance_schema.cashbox_expense_categories') IS NOT NULL THEN query_to_xml($q$
    WITH c AS (
      SELECT c.is_deleted,
             (c.created_by IS NULL OR coalesce((to_jsonb(c) ->> 'is_default')::boolean, false)) AS is_seed,
             (to_jsonb(c) ->> 'ledger_category') IS NOT NULL AS has_ledger
        FROM finance_schema.cashbox_expense_categories c
    ), s AS (
      SELECT count(*) FILTER (WHERE NOT is_deleted) AS active_total,
             count(*) FILTER (WHERE is_seed) AS seed_any,
             count(*) FILTER (WHERE is_seed AND NOT is_deleted) AS seed_active,
             count(*) FILTER (WHERE is_seed AND NOT is_deleted AND has_ledger) AS seed_ledger,
             CASE WHEN to_regclass('order_schema.migrations') IS NULL THEN 'migrations jadvali yo''q'
                  WHEN (xpath('/row/n/text()', query_to_xml($s$SELECT count(*) AS n FROM order_schema.migrations WHERE "timestamp" = 1716000000230$s$, false, true, '')))[1]::text::int > 0
                  THEN 'yozilgan' ELSE 'yozilmagan' END AS mig230
        FROM c
    )
    SELECT CASE WHEN active_total = 0 OR seed_active < 17 THEN 'MISSING' ELSE 'OK' END AS holat,
           'faol kategoriyalar=' || active_total || '; standart (seed) jami=' || seed_any
           || ', faol=' || seed_active || '/17; ledger_category bor=' || seed_ledger || '/15'
           || '; migratsiya 230=' || mig230 AS tafsilot,
           CASE WHEN active_total = 0 OR seed_active < 17 THEN
             CASE WHEN mig230 = 'yozilmagan'
                  THEN 'Migratsiya 1716000000230 hali yurmagan: dev → main deploy qiling (migration-runner uni yurgizadi, 17 qatorni tiklaydi).'
                  WHEN seed_any > 0
                  THEN '230 yurgan, lekin standart qatorlar qisman: 230 qayta yozmaydi (seed bor deb hisoblaydi). /ops → «Xarajat kategoriyalari»da nom to''qnashuvi yoki o''chirilganini tekshiring; kerak bo''lsa nom bo''yicha yangi restore migratsiya.'
                  ELSE '230 yurgan, lekin undan keyin yana tozalangan: 230 qayta yurmaydi. Superadmin /ops → «Xarajat kategoriyalari»da qo''lda qo''shishi mumkin (ledger_category bo''sh qoladi) yoki yangi restore migratsiya kerak.' END
           END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 03 — «Hisob qoidalari»: delivery_pricing_settings faol qatori (seed 142, restore 231)
-- -----------------------------------------------------------------------------
\echo '--- 03'
SELECT '03' AS n, 'kritik' AS daraja,
       'Yetkazish narxi sozlamasi: faol qator (yo''q bo''lsa narx hisobi, pickup tashrifi va «Hisob qoidalari» 409)' AS tekshiruv,
       'logistics_schema.delivery_pricing_settings' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q: migratsiya 142 yurmagan — migration-runner loglarini tekshiring.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'logistics_schema.delivery_pricing_settings jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('logistics_schema.delivery_pricing_settings') IS NOT NULL THEN query_to_xml($q$
    WITH s AS (
      SELECT count(*) FILTER (WHERE is_active AND NOT is_deleted) AS active_cnt,
             count(*) FILTER (WHERE NOT is_deleted) AS live_cnt,
             count(*) AS total_cnt,
             max(id) FILTER (WHERE is_active AND NOT is_deleted) AS active_id,
             CASE WHEN to_regclass('order_schema.migrations') IS NULL THEN 'migrations jadvali yo''q'
                  WHEN (xpath('/row/n/text()', query_to_xml($s$SELECT count(*) AS n FROM order_schema.migrations WHERE "timestamp" = 1716000000231$s$, false, true, '')))[1]::text::int > 0
                  THEN 'yozilgan' ELSE 'yozilmagan' END AS mig231
        FROM logistics_schema.delivery_pricing_settings
    ), a AS (
      SELECT d.created_by, d.first_kg_included, d.pickup_fee
        FROM logistics_schema.delivery_pricing_settings d JOIN s ON d.id = s.active_id
    )
    SELECT CASE WHEN s.active_cnt >= 1 THEN 'OK' ELSE 'MISSING' END AS holat,
           'faol=' || s.active_cnt || '; o''chirilmagan=' || s.live_cnt || '; jami=' || s.total_cnt
           || coalesce('; faol id=' || s.active_id || ', muallif=' || coalesce(a.created_by::text, 'NULL (seed/restore)')
                       || ', first_kg_included=' || a.first_kg_included || ', pickup_fee=' || a.pickup_fee, '')
           || '; migratsiya 231=' || s.mig231 AS tafsilot,
           CASE WHEN s.active_cnt >= 1 THEN NULL
                WHEN s.mig231 = 'yozilmagan'
                THEN 'Migratsiya 1716000000231 (PR #692, dev''da) main''ga chiqib deploy bo''lishi kerak — UI''dan tuzatib bo''lmaydi (PATCH ham 409). Deploy''dan keyin admin «Hisob qoidalari» qiymatlarini ko''rib chiqsin.'
                ELSE '231 yurgan, lekin faol qator yana yo''q (qayta tozalangan): 231 qayta yurmaydi — yangi restore migratsiya kerak.' END AS nima
      FROM s LEFT JOIN a ON true
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 04 — HQ filial qatori: type HQ, kod HQ-TSHKNT, faol, viloyati Toshkent shahri (1726)
-- -----------------------------------------------------------------------------
\echo '--- 04'
SELECT '04' AS n, 'kritik' AS daraja,
       'HQ filial: qator, kod HQ-TSHKNT va region_id (bo''sh bo''lsa HQ kuryeriga biriktirish/skan 400)' AS tekshiruv,
       'branch_schema.branches (HQ)' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q: branch migratsiyalari yurmagan.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'branch_schema.branches jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('branch_schema.branches') IS NOT NULL THEN query_to_xml(format($q$
    WITH hq AS (
      SELECT b.id, b.code, b.region_id, b.status::text AS st, b."createdAt" AS created
        FROM branch_schema.branches b
       WHERE b.type::text = 'HQ' AND b.is_deleted = false
       ORDER BY (b.code = 'HQ-TSHKNT') DESC, b.id LIMIT 1
    ), c AS (
      SELECT count(*) FILTER (WHERE NOT is_deleted) AS n,
             count(*) FILTER (WHERE is_deleted) AS d,
             (SELECT count(*) FROM branch_schema.branches x WHERE x.code = 'HQ-TSHKNT' AND x.is_deleted) AS dc
        FROM branch_schema.branches WHERE type::text = 'HQ'
    ), reg AS (
      SELECT r.id, r.sato_code FROM hq JOIN %1$s r ON r.id = hq.region_id AND r.is_deleted = false
    ), tsh AS (
      SELECT r.id FROM %1$s r WHERE r.sato_code = '1726' AND r.is_deleted = false ORDER BY r.id LIMIT 1
    ), v AS (
      SELECT c.n, c.d, c.dc, hq.id, hq.code, hq.region_id, hq.st, hq.created,
             (SELECT sato_code FROM reg) AS reg_sato, EXISTS (SELECT 1 FROM reg) AS reg_live,
             (SELECT id FROM tsh) AS tsh_id, %2$s AS has_regions
        FROM c LEFT JOIN hq ON true
    )
    SELECT CASE WHEN n = 0 THEN 'MISSING'
                WHEN region_id IS NULL THEN 'MISSING'
                WHEN has_regions AND NOT reg_live THEN 'MISSING'
                WHEN code IS DISTINCT FROM 'HQ-TSHKNT' OR st <> 'active' OR n > 1 THEN 'WARN'
                ELSE 'OK' END AS holat,
           'tirik HQ=' || n || '; o''chirilgan HQ=' || d || '; HQ-TSHKNT kodli o''chirilgan qator=' || dc
           || coalesce('; id=' || id || ', kod=' || coalesce(code, 'NULL') || ', status=' || st
                       || ', region_id=' || coalesce(region_id::text, 'NULL')
                       || ', viloyat SOATO=' || CASE WHEN NOT has_regions THEN 'regions jadvali yo''q'
                                                     WHEN region_id IS NULL THEN '-'
                                                     WHEN reg_live THEN coalesce(reg_sato, '?')
                                                     ELSE 'YO''Q (id mavjud emas yoki o''chirilgan)' END
                       || ', yaratilgan=' || to_char(created AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD'), '')
           || '; Toshkent shahri (1726) id=' || coalesce(tsh_id::text, 'yo''q') AS tafsilot,
           CASE WHEN n = 0 AND dc > 0
                THEN 'Tirik HQ yo''q va o''chirilgan qator HQ-TSHKNT kodini band qilgan: ensureHqBranch INSERT unique indeksga uriladi, branch-service ishga tushmaydi. Ega roziligi bilan o''sha qatorni tiklang (is_deleted=false, status=active) yoki kodini o''zgartiring, keyin branch-service ni qayta ishga tushiring.'
                WHEN n = 0
                THEN 'branch-service ni qayta ishga tushiring (ensureHqBranch HQ ni yaratadi), keyin order-service, catalog-service va api-gateway ni ham (HQ id keshi muddatsiz). So''ng qayta tekshiring: yangi HQ viloyatsiz bo''ladi.'
                WHEN region_id IS NULL
                THEN 'HQ viloyati bo''sh: HQ kuryeriga biriktirish va skan 400 branch_region_missing, Toshkent buyurtmalari to''xtaydi. UI''da tuzatib bo''lmaydi. Yangi restore migratsiya kerak (RestoreHqBranchRegion: faqat region_id IS NULL bo''lsa SOATO 1726 id ni yozadi). Toshkent shahri id=' || coalesce(tsh_id::text, 'yo''q — avval viloyatlar (06)') || '.'
                WHEN has_regions AND NOT reg_live
                THEN 'HQ region_id mavjud bo''lmagan viloyatga ishora qiladi (viloyatlar qayta yaratilgan): har HQ kuryeri buyurtmasi 403. Qo''lda tekshirib, Toshkent shahri (1726) id ga o''rnating (hujjatdagi 04-band).'
                WHEN code IS DISTINCT FROM 'HQ-TSHKNT'
                THEN 'HQ kodi HQ-TSHKNT emas: pochta jo''natish (branch-gateway) 400 «HQ filial topilmadi (code=HQ-TSHKNT)». Kodni qaytaring.'
                WHEN st <> 'active' THEN 'HQ status faol emas: tekshiring.'
                WHEN n > 1 THEN 'Bir nechta tirik HQ: tizim bittasini kutadi, qo''lda ko''rib chiqing.'
                WHEN created >= timestamptz '2026-11-11 00:00+05'
                THEN 'HQ tozalashdan keyin qayta yaratilgan (yangi id): eski HQ id ga bog''langan branch_users, buyurtmalar va keshlarni tekshiring.' END AS nima
      FROM v
  $q$,
    CASE WHEN to_regclass('logistics_schema.regions') IS NOT NULL THEN 'logistics_schema.regions'
         ELSE '(SELECT NULL::bigint AS id, NULL::varchar AS sato_code, NULL::boolean AS is_deleted WHERE false)' END,
    CASE WHEN to_regclass('logistics_schema.regions') IS NOT NULL THEN 'true' ELSE 'false' END
  ), false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 05 — kuryer va market kassalari: har tirik kuryer/market uchun bitta kassa
-- -----------------------------------------------------------------------------
\echo '--- 05'
SELECT '05' AS n, 'kritik' AS daraja,
       'Kuryer (couriers) va market (markets) kassalari: yo''q bo''lsa sotish, rollback, to''lovlar 404' AS tekshiruv,
       'finance_schema.cashboxes (couriers, markets)' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'finance_schema.cashboxes yoki identity_schema.admins jadvali yo''q.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'jadval yo''q: cashboxes=' || coalesce(to_regclass('finance_schema.cashboxes')::text, 'YO''Q')
                                    || ', admins=' || coalesce(to_regclass('identity_schema.admins')::text, 'YO''Q')
              ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('finance_schema.cashboxes') IS NOT NULL
                     AND to_regclass('identity_schema.admins') IS NOT NULL THEN query_to_xml($q$
    WITH u AS (
      SELECT a.id, a.role::text AS role,
             CASE a.role::text WHEN 'courier' THEN 'couriers' ELSE 'markets' END AS cb_type
        FROM identity_schema.admins a
       WHERE a.role::text IN ('courier', 'market') AND a.is_deleted = false
    ), m AS (
      SELECT u.* FROM u
       WHERE NOT EXISTS (SELECT 1 FROM finance_schema.cashboxes c
                          WHERE c.user_id = u.id AND c.cashbox_type::text = u.cb_type AND c.is_deleted = false)
    ), s AS (
      SELECT (SELECT count(*) FROM u WHERE role = 'courier') AS couriers,
             (SELECT count(*) FROM u WHERE role = 'market') AS markets,
             (SELECT count(*) FROM m WHERE role = 'courier') AS couriers_missing,
             (SELECT count(*) FROM m WHERE role = 'market') AS markets_missing,
             (SELECT count(*) FROM m m2 WHERE EXISTS (SELECT 1 FROM finance_schema.cashboxes c
                 WHERE c.user_id = m2.id AND c.cashbox_type::text = m2.cb_type AND c.is_deleted)) AS soft_deleted_only,
             (SELECT count(*) FROM (SELECT 1 FROM finance_schema.cashboxes c
                 WHERE c.cashbox_type::text IN ('couriers', 'markets') AND c.is_deleted = false
                 GROUP BY c.user_id, c.cashbox_type HAVING count(*) > 1) d) AS duplicate_pairs,
             (SELECT string_agg(id::text, ',' ORDER BY id) FROM (SELECT id FROM m ORDER BY id LIMIT 20) z) AS sample_ids
    )
    SELECT CASE WHEN couriers_missing + markets_missing > 0 THEN 'MISSING'
                WHEN duplicate_pairs > 0 THEN 'WARN' ELSE 'OK' END AS holat,
           'kassasiz kuryer=' || couriers_missing || '/' || couriers
           || '; kassasiz market=' || markets_missing || '/' || markets
           || '; ulardan faqat o''chirilgan kassasi borlar=' || soft_deleted_only
           || '; dublikat (user, tur) juftlari=' || duplicate_pairs
           || '; birinchi kassasiz user id''lari=' || coalesce(sample_ids, '-') AS tafsilot,
           CASE WHEN couriers_missing + markets_missing > 0
                THEN 'Kassasiz kuryer/market: sotish, qisman sotish, rollback, xarajatli bekor, kuryerdan pul qabul va marketga to''lov 404 «... kassasi topilmadi». Tezkor chora: kuryer bosh sahifani, market «Kassa» (/cash-box) sahifasini ochsin (myCashbox 0 qoldiq bilan yaratadi) yoki admin Swagger orqali POST /finance/cashbox {user_id, cashbox_type}. Doimiy yechim: yangi restore migratsiya (RestoreUserCashboxes, 0 qoldiq, o''chirilgan kassasi borlarni o''tkazib yuboradi).'
                WHEN duplicate_pairs > 0
                THEN 'Dublikat kassalar: unique indeks yo''q, findOne ixtiyoriy qatorni oladi va pul bo''linadi. Qo''lda birlashtiring (avtomatik emas).' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- =============================================================================
-- YUQORI
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 06 — viloyatlar: 14 ta seed (logistics-service onModuleInit qaytaradi) + logist
-- -----------------------------------------------------------------------------
\echo '--- 06'
SELECT '06' AS n, 'yuqori' AS daraja,
       'Viloyatlar: 14 ta SOATO seed qatori va logist biriktirilishi' AS tekshiruv,
       'logistics_schema.regions' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q: logistics migratsiyalari yurmagan.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'logistics_schema.regions jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('logistics_schema.regions') IS NOT NULL THEN query_to_xml($q$
    WITH r AS (
      SELECT r.id, r.sato_code, r.is_deleted, r."createdAt", (to_jsonb(r) ->> 'logist_id') AS logist_id
        FROM logistics_schema.regions r
    ), s AS (
      SELECT count(*) FILTER (WHERE NOT is_deleted) AS live,
             count(DISTINCT sato_code) FILTER (WHERE NOT is_deleted AND sato_code IN
               ('1703','1706','1708','1710','1712','1714','1718','1722','1724','1726','1727','1730','1733','1735')) AS seed_regions,
             count(*) FILTER (WHERE NOT is_deleted AND (sato_code IS NULL OR sato_code LIKE 'REG-%')) AS bad_sato,
             count(*) FILTER (WHERE NOT is_deleted AND logist_id IS NOT NULL) AS with_logist,
             to_char(min("createdAt") AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS first_created,
             CASE WHEN to_regclass('identity_schema.admins') IS NULL THEN NULL
                  ELSE (xpath('/row/n/text()', query_to_xml($s$SELECT count(*) AS n FROM identity_schema.admins
                         WHERE role::text = 'logist' AND is_deleted = false AND status::text = 'active'$s$, false, true, '')))[1]::text::int END AS logists
        FROM r
    )
    SELECT CASE WHEN live = 0 OR seed_regions < 14 THEN 'MISSING'
                WHEN with_logist = 0 AND coalesce(logists, 0) > 0 THEN 'WARN'
                ELSE 'OK' END AS holat,
           'tirik viloyat=' || live || '; seed SOATO=' || seed_regions || '/14; SOATO yo''q yoki REG-=' || bad_sato
           || '; logist biriktirilgan viloyat=' || with_logist || ' (faol logistlar=' || coalesce(logists::text, 'n/a') || ')'
           || '; birinchi createdAt=' || coalesce(first_created, '-')
           || CASE WHEN first_created >= '2026-11-11' THEN ' (TOZALASHDAN KEYIN qayta yaratilgan: id''lar yangi, is_city_zone va logist_id yo''qolgan)' ELSE '' END AS tafsilot,
           CASE WHEN live = 0 OR seed_regions < 14
                THEN 'logistics-service ni qayta ishga tushiring: onModuleInit 14 viloyatni haqiqiy SOATO bilan qaytaradi. Keyin 07 (is_city_zone), 08 (tumanlar) va 09 (yetim id''lar) ni qayta tekshiring.'
                WHEN with_logist = 0 AND coalesce(logists, 0) > 0
                THEN 'Viloyatlar joyida, lekin hech biriga logist biriktirilmagan: logistlar buyurtma/paket/kuryerlarni ko''rmaydi. /regions/logist-assignment da qayta biriktiring.' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 07 — Toshkent shahri is_city_zone (faqat migratsiya 142 yozgan; UI/API yo'q)
-- -----------------------------------------------------------------------------
\echo '--- 07'
SELECT '07' AS n, 'yuqori' AS daraja,
       'Toshkent shahri (SOATO 1726) is_city_zone=true: aks holda «city» tarifi hech qachon tanlanmaydi' AS tekshiruv,
       'logistics_schema.regions.is_city_zone' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q: logistics migratsiyalari yurmagan.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'logistics_schema.regions jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('logistics_schema.regions') IS NOT NULL THEN query_to_xml($q$
    WITH r AS (
      SELECT r.id, r.name, r.sato_code, r.is_deleted, r."createdAt",
             (to_jsonb(r) ->> 'is_city_zone')::boolean AS cz
        FROM logistics_schema.regions r
    ), col AS (
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'logistics_schema' AND table_name = 'regions'
                        AND column_name = 'is_city_zone') AS has_cz
    ), s AS (
      SELECT count(*) FILTER (WHERE NOT is_deleted) AS live,
             count(*) FILTER (WHERE NOT is_deleted AND cz) AS cz_rows,
             string_agg(name, ', ' ORDER BY id) FILTER (WHERE NOT is_deleted AND cz) AS cz_names,
             (SELECT 'id ' || t.id || ', is_city_zone=' || coalesce(t.cz::text, '-')
                     || ', yaratilgan ' || to_char(t."createdAt" AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD')
                FROM r t WHERE NOT t.is_deleted AND t.sato_code = '1726' ORDER BY t.id LIMIT 1) AS tsh
        FROM r
    )
    SELECT CASE WHEN NOT col.has_cz OR s.live = 0 OR s.cz_rows = 0 THEN 'MISSING' ELSE 'OK' END AS holat,
           CASE WHEN NOT col.has_cz THEN 'is_city_zone ustuni yo''q (migratsiya 142 yurmagan)'
                ELSE 'city zone viloyatlar=' || s.cz_rows || ' (' || coalesce(s.cz_names, '-') || ')'
                     || '; Toshkent shahri (1726): ' || coalesce(s.tsh, 'yo''q') || '; tirik viloyat=' || s.live END AS tafsilot,
           CASE WHEN s.live = 0
                THEN 'Avval viloyatlar tiklansin (06: logistics-service ni qayta ishga tushirish), keyin bu tekshiruvni qayta yurgizing — qayta yaratilgan qatorda flag false bo''ladi.'
                WHEN NOT col.has_cz OR s.cz_rows = 0
                THEN 'Xato chiqmaydi, narx jimgina noto''g''ri: Toshkent ichida «city» o''rniga center/address tarifi (sayt kalkulyatori, POST /delivery/quote, /partner/tariff, SALE_PRICING_ENGINE=on bo''lsa sotuv). UI/API bilan tuzatib bo''lmaydi. Yangi restore migratsiya kerak (RestoreTashkentCityZone: hech bir city zone yo''q bo''lsa SOATO 1726 qatoriga true) va seed''ga is_city_zone qo''shish. Hujjatdagi 07-band.' END AS nima
      FROM col, s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 08 — tumanlar: 206 ta seed (onModuleInit qaytaradi), D1 tasdiq belgilari
-- -----------------------------------------------------------------------------
\echo '--- 08'
SELECT '08' AS n, 'yuqori' AS daraja,
       'Tumanlar: 206 ta SOATO seed qatori (bo''sh bo''lsa buyurtma yaratib bo''lmaydi)' AS tekshiruv,
       'logistics_schema.districts' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q: logistics migratsiyalari yurmagan.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'logistics_schema.districts jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('logistics_schema.districts') IS NOT NULL THEN query_to_xml($q$
    WITH d AS (
      SELECT d.id, d.name, d.sato_code, d.region_id, d.is_deleted, d."createdAt",
             (to_jsonb(d) ->> 'assignment_review_required')::boolean AS review,
             (to_jsonb(d) ->> 'assignment_confirmed_at') AS confirmed_at
        FROM logistics_schema.districts d
    ), s AS (
      SELECT count(*) FILTER (WHERE NOT is_deleted) AS live,
             count(*) FILTER (WHERE is_deleted) AS soft,
             count(DISTINCT sato_code) FILTER (WHERE NOT is_deleted AND sato_code ~ '^17[0-9]{5}$') AS coded,
             count(*) FILTER (WHERE NOT is_deleted AND (sato_code IS NULL OR btrim(sato_code) = '' OR sato_code LIKE 'REG-%')) AS no_sato,
             count(*) FILTER (WHERE NOT is_deleted AND btrim(name) IN ('Khojaobod', 'Akaltyn')) AS legacy,
             count(*) FILTER (WHERE NOT is_deleted AND "createdAt" >= timestamptz '2026-11-11 00:00+05') AS since_cleanup,
             count(*) FILTER (WHERE NOT is_deleted AND review AND confirmed_at IS NULL) AS review_open,
             EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'logistics_schema' AND table_name = 'districts'
                        AND column_name = 'assignment_review_required') AS has_review,
             CASE WHEN to_regclass('logistics_schema.regions') IS NULL THEN NULL
                  ELSE (xpath('/row/n/text()', query_to_xml($s$
                    SELECT count(*) AS n FROM logistics_schema.regions r
                     WHERE NOT r.is_deleted
                       AND r.sato_code IN ('1703','1706','1708','1710','1712','1714','1718','1722','1724','1726','1727','1730','1733','1735')
                       AND NOT EXISTS (SELECT 1 FROM logistics_schema.districts x WHERE x.region_id = r.id AND NOT x.is_deleted)
                  $s$, false, true, '')))[1]::text::int END AS seed_regions_empty
        FROM d
    )
    SELECT CASE WHEN live = 0 OR live + soft < 206 OR coalesce(seed_regions_empty, 0) > 0 THEN 'MISSING'
                WHEN no_sato > 0 OR legacy > 0 OR (has_review AND review_open > 100) THEN 'WARN'
                ELSE 'OK' END AS holat,
           'tirik=' || live || ', o''chirilgan=' || soft || ' (seed kutadi: jami 206 dan kam emas)'
           || '; rasmiy 7 xonali SOATO=' || coded || '/206'
           || '; SOATO yo''q yoki REG-=' || no_sato || '; eski dublikat (Khojaobod/Akaltyn)=' || legacy
           || '; tumansiz seed viloyat=' || coalesce(seed_regions_empty::text, 'n/a')
           || '; 2026-11-11 dan keyin yaratilgan=' || since_cleanup
           || '; D1 tasdiqlanmagan=' || CASE WHEN has_review THEN review_open::text ELSE 'n/a (227 yo''q)' END AS tafsilot,
           CASE WHEN live = 0 OR live + soft < 206 OR coalesce(seed_regions_empty, 0) > 0
                THEN 'logistics-service ni qayta ishga tushiring: onModuleInit 206 tumanni haqiqiy SOATO bilan qaytaradi. Keyin 09 (yetim id''lar) ni tekshiring — eski tuman id''lari qaytmaydi.'
                WHEN has_review AND review_open > 100
                THEN 'Viloyatlar qolgan, tumanlar qayta yaratilgan: qo''lda qilingan viloyatlararo biriktirishlar yo''qolgan. «Hududlar → Tumanlar» (/regions/districts) da qayta biriktiring va tasdiqlang.'
                WHEN no_sato > 0 OR legacy > 0
                THEN 'SOATO''siz yoki eski dublikat tumanlar bor: /regions/districts da birlashtiring (POST /district/:id/merge).'
                WHEN since_cleanup > 100
                THEN 'Tumanlarning ko''pi tozalashdan keyin yaratilgan (yangi id): 09 ni albatta tekshiring.' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 09 — yetim viloyat/tuman id'lari (viloyat/tuman qayta yaratilgan, ishora qiluvchilar qolgan)
-- -----------------------------------------------------------------------------
\echo '--- 09'
SELECT '09' AS n, 'yuqori' AS daraja,
       'Yetim region_id/district_id: filial, foydalanuvchi, kuryer viloyati, buyurtma va pochta mavjud bo''lmagan id ga ishora qiladi' AS tekshiruv,
       'logistics_schema.regions/districts ← branches, admins, courier_regions, orders, posts' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'regions yoki districts jadvali yo''q.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'jadval yo''q: regions=' || coalesce(to_regclass('logistics_schema.regions')::text, 'YO''Q')
                                    || ', districts=' || coalesce(to_regclass('logistics_schema.districts')::text, 'YO''Q')
              ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('logistics_schema.regions') IS NOT NULL
                     AND to_regclass('logistics_schema.districts') IS NOT NULL THEN query_to_xml($q$
    WITH c AS (
      SELECT
        CASE WHEN to_regclass('branch_schema.branches') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM branch_schema.branches b
           WHERE b.is_deleted = false
             AND ((b.region_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM logistics_schema.regions r WHERE r.id = b.region_id))
               OR (b.district_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM logistics_schema.districts d WHERE d.id = b.district_id)))
        $s$, false, true, '')))[1]::text::bigint END AS branches,
        CASE WHEN to_regclass('identity_schema.admins') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM identity_schema.admins a
           WHERE a.is_deleted = false
             AND ((a.region_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM logistics_schema.regions r WHERE r.id = a.region_id))
               OR (a.district_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM logistics_schema.districts d WHERE d.id = a.district_id)))
        $s$, false, true, '')))[1]::text::bigint END AS users,
        CASE WHEN to_regclass('identity_schema.courier_regions') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM identity_schema.courier_regions cr
           WHERE NOT EXISTS (SELECT 1 FROM logistics_schema.regions r WHERE r.id = cr.region_id)
        $s$, false, true, '')))[1]::text::bigint END AS courier_regions,
        CASE WHEN to_regclass('order_schema.orders') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM order_schema.orders o
           WHERE o.is_deleted = false AND o.deleted_at IS NULL
             AND ((o.district_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM logistics_schema.districts d WHERE d.id = o.district_id))
               OR (o.region_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM logistics_schema.regions r WHERE r.id = o.region_id)))
        $s$, false, true, '')))[1]::text::bigint END AS orders,
        CASE WHEN to_regclass('order_schema.orders') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM order_schema.orders o
           WHERE o.is_deleted = false AND o.deleted_at IS NULL
             AND o.status::text NOT IN ('sold', 'paid', 'partly_paid', 'closed', 'cancelled (sent)', 'returned_to_market')
             AND ((o.district_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM logistics_schema.districts d WHERE d.id = o.district_id))
               OR (o.region_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM logistics_schema.regions r WHERE r.id = o.region_id)))
        $s$, false, true, '')))[1]::text::bigint END AS orders_open,
        CASE WHEN to_regclass('logistics_schema.posts') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM logistics_schema.posts p
           WHERE p.is_deleted = false AND p.status::text IN ('new', 'sent') AND p.region_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM logistics_schema.regions r WHERE r.id = p.region_id)
        $s$, false, true, '')))[1]::text::bigint END AS posts
    )
    SELECT CASE WHEN coalesce(branches, 0) + coalesce(users, 0) + coalesce(courier_regions, 0)
                   + coalesce(orders, 0) + coalesce(posts, 0) > 0 THEN 'MISSING' ELSE 'OK' END AS holat,
           'yetim: filial=' || coalesce(branches::text, 'n/a') || '; foydalanuvchi=' || coalesce(users::text, 'n/a')
           || '; kuryer viloyati (courier_regions)=' || coalesce(courier_regions::text, 'n/a')
           || '; buyurtma=' || coalesce(orders::text, 'n/a') || ' (yakunlanmagan=' || coalesce(orders_open::text, 'n/a') || ')'
           || '; pochta (new/sent)=' || coalesce(posts::text, 'n/a') AS tafsilot,
           CASE WHEN coalesce(branches, 0) + coalesce(users, 0) + coalesce(courier_regions, 0)
                   + coalesce(orders, 0) + coalesce(posts, 0) > 0
                THEN 'Viloyat/tuman id''lari o''zgargan (qayta seed), ishora qiluvchilar eski id''da: buyurtmalar filialga tushmaydi. Avtomatik moslamang. Tozalashdan oldingi backup''dan eski id → SOATO → yangi id xaritasini tuzing; ko''rib chiqilgan bir martalik skript bilan yoki UI''da (filial, foydalanuvchi, kuryer tahriri) qayta tanlang. Avval 06/08 OK bo''lsin.' END AS nima
      FROM c
  $q$, false, true, '') END AS x) g
) r;

-- =============================================================================
-- O'RTA
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 10 — yetkazish tariflari: city / center / address joriy versiyasi (seed 142)
-- -----------------------------------------------------------------------------
\echo '--- 10'
SELECT '10' AS n, 'o''rta' AS daraja,
       'Yetkazish tariflari: city, center, address uchun joriy versiya' AS tekshiruv,
       'logistics_schema.delivery_tariffs' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q: migratsiya 142 yurmagan.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'logistics_schema.delivery_tariffs jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('logistics_schema.delivery_tariffs') IS NOT NULL THEN query_to_xml($q$
    WITH t(id) AS (VALUES ('address'), ('center'), ('city')),
    cur AS (
      SELECT t.id,
             (SELECT d.base_price::text || '+' || d.extra_per_kg::text || '/kg, ' || d.days_min || '-' || d.days_max || ' kun, '
                     || to_char(d.valid_from AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD')
                     || CASE WHEN d.created_by IS NULL THEN ', seed' ELSE ', admin ' || d.created_by END
                FROM logistics_schema.delivery_tariffs d
               WHERE d.tariff_id = t.id AND d.is_active = true AND d.is_deleted = false AND d.valid_from <= now()
               ORDER BY d.valid_from DESC, d.id DESC LIMIT 1) AS cur,
             (SELECT count(*) FROM logistics_schema.delivery_tariffs d WHERE d.tariff_id = t.id) AS total
        FROM t
    )
    SELECT CASE WHEN bool_and(cur IS NOT NULL) THEN 'OK' ELSE 'MISSING' END AS holat,
           string_agg(id || '=' || coalesce(cur, 'YO''Q') || ' (qatorlar ' || total || ')', '; ' ORDER BY id) AS tafsilot,
           CASE WHEN bool_and(cur IS NOT NULL) THEN NULL
                ELSE 'Admin «Hududlar → Yetkazish tariflari» (/delivery-tariffs) da yetishmayotgan tarifni «O''zgartirish» orqali kiritsin, narxni ega tasdiqlasin. Migratsiya kerak emas (POST /delivery/tariffs mavjud qatorni talab qilmaydi). Buyurtma va sotish to''xtamaydi.'
                     || CASE WHEN bool_or(cur IS NULL AND total > 0) THEN ' Diqqat: qatorlar bor, lekin joriy versiya yo''q (kelajak sanali yoki nofaol) — qo''lda tekshiring.' ELSE '' END END AS nima
      FROM cur
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 11 — SMS provayder akkauntlari (maxfiy, seed emas) + vaqtinchalik parol shabloni
-- -----------------------------------------------------------------------------
\echo '--- 11'
SELECT '11' AS n, 'o''rta' AS daraja,
       'SMS provayder akkaunti (default/otp): yo''q bo''lsa vaqtinchalik parol SMS''i ketmaydi' AS tekshiruv,
       'notification_schema.sms_provider_accounts (+ sms_templates)' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q: migratsiya 055 yurmagan.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'notification_schema.sms_provider_accounts jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('notification_schema.sms_provider_accounts') IS NOT NULL THEN query_to_xml($q$
    WITH s AS (
      SELECT count(*) AS total,
             count(*) FILTER (WHERE is_active AND sender_profile = 'default') AS active_default,
             count(*) FILTER (WHERE is_active AND sender_profile = 'otp') AS active_otp,
             coalesce(string_agg(provider || '/' || sender_profile || CASE WHEN is_active THEN '' ELSE '(nofaol)' END,
                                 ', ' ORDER BY provider, sender_profile), 'yo''q') AS rows_list,
             CASE WHEN to_regclass('notification_schema.sms_templates') IS NULL THEN 'jadval yo''q'
                  ELSE (xpath('/row/n/text()', query_to_xml($s$SELECT count(*) AS n FROM notification_schema.sms_templates
                         WHERE code = 'user.temp_password' AND lang = 'uz' AND is_active$s$, false, true, '')))[1]::text END AS tpl
        FROM notification_schema.sms_provider_accounts
    )
    SELECT CASE WHEN active_default = 0 THEN 'MISSING' ELSE 'OK' END AS holat,
           'akkauntlar=' || total || ' [' || rows_list || ']; faol default=' || active_default || ', faol otp=' || active_otp
           || '; user.temp_password (uz) shabloni=' || tpl || ' (0 zararsiz: kod bir xil sukut matnini oladi)'
           || '; provider env SMS_PROVIDER bilan bir xil bo''lishi kerak' AS tafsilot,
           CASE WHEN active_default = 0
                THEN 'Agar prod''da SMS ishlatilgan bo''lsa (SMS_ENABLED=true): superadmin /notifications/sms → «Sozlamalar» → «Provayder akkauntlari» da login, parol va sender''ni qayta kiritsin (notification-service da SMS_CREDENTIAL_SECRET kerak). Migratsiya bilan tiklab bo''lmaydi (maxfiy). SMS umuman yoqilmagan bo''lsa — e''tibor bermang.' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 12 — market Telegram guruhlari: telegram_markets (ulanish) va telegram_chats (oyna)
-- -----------------------------------------------------------------------------
\echo '--- 12'
SELECT '12' AS n, 'o''rta' AS daraja,
       'Market Telegram guruhlari: ulanishlar va telegram_chats oynasi (trigger bilan sinxron)' AS tekshiruv,
       'notification_schema.telegram_markets, telegram_chats' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q: notification migratsiyalari yurmagan.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'jadval yo''q: telegram_markets=' || coalesce(to_regclass('notification_schema.telegram_markets')::text, 'YO''Q')
                                    || ', telegram_chats=' || coalesce(to_regclass('notification_schema.telegram_chats')::text, 'YO''Q')
              ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('notification_schema.telegram_markets') IS NOT NULL
                     AND to_regclass('notification_schema.telegram_chats') IS NOT NULL THEN query_to_xml(format($q$
    WITH s AS (
      SELECT
        (SELECT count(*) FROM notification_schema.telegram_markets) AS tm_total,
        (SELECT count(*) FROM notification_schema.telegram_markets WHERE is_deleted = false AND is_active = true) AS tm_active,
        (SELECT count(*) FROM notification_schema.telegram_chats
          WHERE is_active AND owner_type = 'market' AND scope = 'create' AND chat_type IN ('group', 'channel')) AS tc_active_create,
        (SELECT count(*) FROM notification_schema.telegram_markets m
          WHERE m.is_deleted = false AND m.is_active = true
            AND NOT EXISTS (SELECT 1 FROM notification_schema.telegram_chats c
                             WHERE c.source_market_row_id = m.id AND c.is_active = true
                               AND c.chat_id = m.group_id AND c.owner_id = m.market_id)) AS mirror_missing,
        (SELECT count(*) FROM notification_schema.telegram_chats c
          WHERE c.owner_type = 'market' AND c.is_active = true
            AND NOT EXISTS (SELECT 1 FROM notification_schema.telegram_markets m
                             WHERE m.id = c.source_market_row_id AND m.is_deleted = false AND m.is_active = true
                               AND m.group_id = c.chat_id AND m.market_id = c.owner_id)) AS mirror_orphan,
        (SELECT count(*) FROM %1$s a WHERE a.role::text = 'market' AND a.is_deleted = false) AS markets,
        (SELECT count(*) FROM notification_schema.telegram_markets m
          WHERE %2$s AND m.is_deleted = false AND m.is_active = true
            AND NOT EXISTS (SELECT 1 FROM %1$s a
                             WHERE a.id = m.market_id AND a.role::text = 'market'
                               AND a.is_deleted = false AND a."createdAt" <= m."createdAt")) AS binding_bad_market,
        EXISTS (SELECT 1 FROM pg_trigger tg
                 WHERE tg.tgrelid = to_regclass('notification_schema.telegram_markets')
                   AND tg.tgname = 'TRG_TELEGRAM_MARKETS_SYNC_CHATS' AND tg.tgenabled <> 'D') AS trigger_ok,
        %2$s AS has_admins
    )
    SELECT CASE WHEN NOT trigger_ok OR mirror_missing > 0 OR (tm_total = 0 AND markets > 0) THEN 'MISSING'
                WHEN mirror_orphan > 0 OR binding_bad_market > 0 THEN 'WARN'
                ELSE 'OK' END AS holat,
           'faol ulanish=' || tm_active || ' (jami qator ' || tm_total || '); telegram_chats faol create guruhi=' || tc_active_create
           || '; tirik market=' || CASE WHEN has_admins THEN markets::text ELSE 'n/a' END
           || '; oynasiz faol ulanish=' || mirror_missing || '; ulanishsiz faol oyna (PII xavfi)=' || mirror_orphan
           || '; market yo''q yoki ulanishdan keyin yaratilgan=' || CASE WHEN has_admins THEN binding_bad_market::text ELSE 'n/a' END
           || '; sinxron trigger=' || CASE WHEN trigger_ok THEN 'bor' ELSE 'YO''Q/o''chiq' END AS tafsilot,
           nullif(concat_ws(' ',
             CASE WHEN NOT trigger_ok
                  THEN 'TRG_TELEGRAM_MARKETS_SYNC_CHATS yo''q yoki o''chiq: panel va buyurtma kartalari ajralib ketadi. Migratsiya 189 funksiyasi va triggerini qayta yaratuvchi yangi migratsiya kerak.' END,
             CASE WHEN mirror_missing > 0
                  THEN 'Faol ulanishning telegram_chats oynasi yo''q: o''sha guruhlarga buyurtma kartalari ketmaydi. Oynani telegram_markets dan qayta sinxronlovchi migratsiya (hujjatdagi 12-band) yoki /notifications da ulanishni nofaol/faol qilish.' END,
             CASE WHEN tm_total = 0 AND markets > 0
                  THEN 'Ulanishlar butunlay yo''q: guruhlarga buyurtma/bekor xabarlari kelmaydi (xato chiqmaydi). Avtomatik tiklamang (chat_id lar va PII xavfi). Har market egasi yoki admin /notifications → «Qo''shish» (bir martalik havola) bilan create va cancel guruhlarini qayta ulasin. Agar oldin hech kim ulamagan bo''lsa — e''tibor bermang.' END,
             CASE WHEN mirror_orphan > 0
                  THEN 'DIQQAT: ulanishi yo''q faol telegram_chats qatorlari bor — kartalar (mijoz ismi/telefoni bilan) uzilgan guruhga ketishi mumkin, UI''dan tuzatib bo''lmaydi. Ega roziligi bilan ularni is_active=false qiluvchi bir martalik tuzatish (hujjatdagi 12-band).' END,
             CASE WHEN binding_bad_market > 0
                  THEN 'Ba''zi ulanishlar mavjud bo''lmagan yoki keyin yaratilgan (id qayta ishlatilgan?) marketga bog''langan: admin /notifications da tekshirib nofaol qilsin yoki o''chirsin.' END
           ), '') AS nima
      FROM s
  $q$,
    CASE WHEN to_regclass('identity_schema.admins') IS NOT NULL THEN 'identity_schema.admins'
         ELSE '(SELECT NULL::bigint AS id, NULL::text AS role, NULL::boolean AS is_deleted, NULL::timestamptz AS "createdAt" WHERE false)' END,
    CASE WHEN to_regclass('identity_schema.admins') IS NOT NULL THEN 'true' ELSE 'false' END
  ), false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 13 — pochta tarixi: post_order_memberships (trigger + har joriy ko'rsatkichga ochiq qator)
-- -----------------------------------------------------------------------------
\echo '--- 13'
SELECT '13' AS n, 'o''rta' AS daraja,
       'Pochta tarixi: trigger va har orders.post_id / canceled_post_id uchun ochiq qator' AS tekshiruv,
       'order_schema.post_order_memberships' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN to_regclass('order_schema.orders') IS NULL THEN 'NO_TABLE'
              WHEN g.x IS NULL THEN CASE WHEN g.trg THEN 'MISSING' ELSE 'NO_TABLE' END
              ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN to_regclass('order_schema.orders') IS NULL THEN 'order_schema.orders jadvali yo''q'
              WHEN g.x IS NULL THEN 'post_order_memberships jadvali yo''q; trigger=' || CASE WHEN g.trg THEN 'BOR' ELSE 'yo''q' END
              ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         CASE WHEN to_regclass('order_schema.orders') IS NOT NULL AND g.x IS NULL AND g.trg
              THEN 'KRITIK: jadval yo''q, lekin trigger bor — orders.post_id o''zgarishi 42P01 bilan yiqiladi (pochtaga qo''shish, jo''natish, qabul to''xtaydi). Migratsiya 201 ni qayta qo''llovchi yangi migratsiya darhol kerak.'
              WHEN to_regclass('order_schema.orders') IS NOT NULL AND g.x IS NULL
              THEN 'Jadval va trigger yo''q: eski pochtalar tarixi bo''sh. Migratsiya 201 ni qayta qo''llovchi yangi migratsiya kerak.'
              ELSE (xpath('/row/nima/text()', g.x))[1]::text END AS nima
  FROM (SELECT EXISTS (SELECT 1 FROM pg_trigger t
                        WHERE t.tgname = 'TRG_ORDERS_TRACK_POST_MEMBERSHIP'
                          AND t.tgrelid = to_regclass('order_schema.orders')) AS trg,
               CASE WHEN to_regclass('order_schema.post_order_memberships') IS NOT NULL
                     AND to_regclass('order_schema.orders') IS NOT NULL THEN query_to_xml($q$
    WITH s AS (
      SELECT
        (SELECT count(*) FROM order_schema.post_order_memberships) AS rows_total,
        (SELECT count(*) FROM order_schema.post_order_memberships WHERE source = 'seed_current') AS seed_rows,
        (SELECT count(*) FROM order_schema.orders o WHERE o.post_id IS NOT NULL OR o.canceled_post_id IS NOT NULL) AS pointer_orders,
        (SELECT count(*) FROM order_schema.orders o
          WHERE o.post_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM order_schema.post_order_memberships m
                             WHERE m.order_id = o.id AND m.kind = 'DELIVERY' AND m.left_at IS NULL)) AS miss_delivery,
        (SELECT count(*) FROM order_schema.orders o
          WHERE o.canceled_post_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM order_schema.post_order_memberships m
                             WHERE m.order_id = o.id AND m.kind = 'CANCELED' AND m.left_at IS NULL)) AS miss_canceled,
        (SELECT count(*) FROM order_schema.post_order_memberships m JOIN order_schema.orders o ON o.id = m.order_id
          WHERE m.left_at IS NULL
            AND m.post_id IS DISTINCT FROM CASE m.kind WHEN 'DELIVERY' THEN o.post_id ELSE o.canceled_post_id END) AS open_mismatch,
        CASE WHEN to_regclass('logistics_schema.posts') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM order_schema.post_order_memberships m JOIN logistics_schema.posts p ON p.id = m.post_id
           WHERE m.joined_at < p."createdAt" - interval '1 minute'
        $s$, false, true, '')))[1]::text::bigint END AS reused,
        CASE WHEN to_regclass('logistics_schema.posts') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM logistics_schema.posts p
           WHERE p.status::text IN ('received', 'canceled_received')
             AND NOT EXISTS (SELECT 1 FROM order_schema.post_order_memberships m WHERE m.post_id = p.id)
        $s$, false, true, '')))[1]::text::bigint END AS received_no_history,
        EXISTS (SELECT 1 FROM pg_trigger t
                 WHERE t.tgname = 'TRG_ORDERS_TRACK_POST_MEMBERSHIP'
                   AND t.tgrelid = to_regclass('order_schema.orders') AND t.tgenabled <> 'D') AS trg_on,
        to_regprocedure('order_schema.track_post_membership()') IS NOT NULL AS fn_ok
    )
    SELECT CASE WHEN NOT trg_on OR NOT fn_ok THEN 'MISSING'
                WHEN miss_delivery + miss_canceled > 0 THEN 'MISSING'
                WHEN coalesce(reused, 0) > 0 OR open_mismatch > 0 THEN 'WARN'
                ELSE 'OK' END AS holat,
           'qatorlar=' || rows_total || ' (seed_current=' || seed_rows || '); ko''rsatkichli buyurtma=' || pointer_orders
           || '; ochiq qatorsiz: DELIVERY=' || miss_delivery || ', CANCELED=' || miss_canceled
           || '; ochiq qator boshqa pochtada=' || open_mismatch
           || '; tarixsiz qabul qilingan pochta=' || coalesce(received_no_history::text, 'n/a')
           || '; pochta id qayta ishlatilgan (?)=' || coalesce(reused::text, 'n/a')
           || '; trigger=' || CASE WHEN trg_on THEN 'yoqiq' ELSE 'YO''Q/o''chiq' END
           || '; funksiya=' || CASE WHEN fn_ok THEN 'bor' ELSE 'YO''Q' END AS tafsilot,
           CASE WHEN NOT trg_on OR NOT fn_ok
                THEN 'Trigger yoki funksiya yo''q: yangi ko''chishlar yozilmaydi. Migratsiya 201 ni qayta qo''llovchi yangi migratsiya kerak.'
                WHEN miss_delivery + miss_canceled > 0
                THEN 'Joriy ko''rsatkichlar uchun ochiq qatorlar yo''q: pochtadan keyin chiqqan buyurtmalar eski pochta tarixidan jimgina yo''qoladi. Ochiq qatorlarni qayta seed qiling (201 seed SQL''i, source=seed_current, ON CONFLICT DO NOTHING — hujjatdagi 13-band), keyin ixtiyoriy scripts/backfill-post-order-memberships.ts (avval dry-run).'
                WHEN coalesce(reused, 0) > 0
                THEN 'Tarix qatori pochtadan oldin: pochta id ketma-ketligi qayta boshlangan bo''lishi mumkin. Avtomatik o''chirmang, qo''lda tekshiring.'
                WHEN open_mismatch > 0
                THEN 'Ochiq qator joriy pochtaga mos emas: qo''lda tekshiring (avtomatik tuzatmang).' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 14 — global qidiruv indeksi (Ctrl K): tirik obyektlarning hujjatlari
-- -----------------------------------------------------------------------------
\echo '--- 14'
SELECT '14' AS n, 'o''rta' AS daraja,
       'Global qidiruv (Ctrl K) indeksi: har tirik foydalanuvchi, viloyat, tuman, pochta, mahsulot, buyurtma uchun hujjat' AS tekshiruv,
       'search_schema.search_documents' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q: baseline migratsiya yurmagan.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'search_schema.search_documents jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('search_schema.search_documents') IS NOT NULL THEN query_to_xml($q$
    WITH c AS (
      SELECT
        (SELECT count(*) FROM search_schema.search_documents WHERE is_deleted = false) AS docs_live,
        CASE WHEN to_regclass('identity_schema.admins') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM identity_schema.admins s WHERE s.is_deleted = false
             AND NOT EXISTS (SELECT 1 FROM search_schema.search_documents x WHERE x.source = 'identity' AND x."sourceId" = s.id::text)
        $s$, false, true, '')))[1]::text::bigint END AS m_users,
        CASE WHEN to_regclass('logistics_schema.regions') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM logistics_schema.regions s WHERE s.is_deleted = false
             AND NOT EXISTS (SELECT 1 FROM search_schema.search_documents x WHERE x.source = 'logistics' AND x.type = 'region' AND x."sourceId" = s.id::text)
        $s$, false, true, '')))[1]::text::bigint END AS m_regions,
        CASE WHEN to_regclass('logistics_schema.districts') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM logistics_schema.districts s WHERE s.is_deleted = false
             AND NOT EXISTS (SELECT 1 FROM search_schema.search_documents x WHERE x.source = 'logistics' AND x.type = 'district' AND x."sourceId" = s.id::text)
        $s$, false, true, '')))[1]::text::bigint END AS m_districts,
        CASE WHEN to_regclass('logistics_schema.posts') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM logistics_schema.posts s WHERE s.is_deleted = false
             AND NOT EXISTS (SELECT 1 FROM search_schema.search_documents x WHERE x.source = 'logistics' AND x.type = 'post' AND x."sourceId" = s.id::text)
        $s$, false, true, '')))[1]::text::bigint END AS m_posts,
        CASE WHEN to_regclass('catalog_schema.products') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM catalog_schema.products s WHERE s.is_deleted = false
             AND NOT EXISTS (SELECT 1 FROM search_schema.search_documents x WHERE x.source = 'catalog' AND x.type = 'product' AND x."sourceId" = s.id::text)
        $s$, false, true, '')))[1]::text::bigint END AS m_products,
        CASE WHEN to_regclass('order_schema.orders') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM order_schema.orders s WHERE s.is_deleted = false
             AND NOT EXISTS (SELECT 1 FROM search_schema.search_documents x WHERE x.source = 'order' AND x.type = 'order' AND x."sourceId" = s.id::text)
        $s$, false, true, '')))[1]::text::bigint END AS m_orders,
        CASE WHEN to_regclass('order_schema.orders') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM search_schema.search_documents x WHERE x.is_deleted = false AND x.source = 'order'
             AND NOT EXISTS (SELECT 1 FROM order_schema.orders s WHERE s.id::text = x."sourceId" AND s.is_deleted = false)
        $s$, false, true, '')))[1]::text::bigint END AS stale_orders,
        CASE WHEN to_regclass('identity_schema.admins') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM search_schema.search_documents x WHERE x.is_deleted = false AND x.source = 'identity'
             AND NOT EXISTS (SELECT 1 FROM identity_schema.admins s WHERE s.id::text = x."sourceId" AND s.is_deleted = false)
        $s$, false, true, '')))[1]::text::bigint END AS stale_users
    ), v AS (
      SELECT c.*, coalesce(m_users, 0) + coalesce(m_regions, 0) + coalesce(m_districts, 0)
                  + coalesce(m_posts, 0) + coalesce(m_products, 0) + coalesce(m_orders, 0) AS missing_total,
             coalesce(stale_orders, 0) + coalesce(stale_users, 0) AS stale_total
        FROM c
    )
    SELECT CASE WHEN missing_total > 0 THEN 'MISSING' WHEN stale_total > 0 THEN 'WARN' ELSE 'OK' END AS holat,
           'tirik hujjatlar=' || docs_live || '; hujjatsiz tirik obyektlar: foydalanuvchi=' || coalesce(m_users::text, 'n/a')
           || ', viloyat=' || coalesce(m_regions::text, 'n/a') || ', tuman=' || coalesce(m_districts::text, 'n/a')
           || ', pochta=' || coalesce(m_posts::text, 'n/a') || ', mahsulot=' || coalesce(m_products::text, 'n/a')
           || ', buyurtma=' || coalesce(m_orders::text, 'n/a')
           || '; obyekti yo''q eski hujjatlar: buyurtma=' || coalesce(stale_orders::text, 'n/a')
           || ', foydalanuvchi=' || coalesce(stale_users::text, 'n/a') AS tafsilot,
           CASE WHEN missing_total > 0
                THEN 'Ctrl K qidiruvi bu obyektlarni topmaydi (xato chiqmaydi; bo''lim ro''yxatlaridagi qidiruv ishlaydi). Migratsiya bilan tiklamang (metadata = kirish doirasi). Har servis o''z syncXToSearch kodi bilan qayta indekslashi kerak (alohida PR). Bitta obyektni qayta saqlash uni indekslaydi.'
                WHEN stale_total > 0
                THEN 'Obyekti o''chgan hujjatlar natijada chiqadi va ochilganda «topilmadi». Qayta indekslash vositasida search.index.remove (yumshoq) bilan tozalang.' END AS nima
      FROM v
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 15 — .env.production dagi foydalanuvchi id'lari (SALE_PRICING_ENGINE_MARKET_IDS,
--      SMS_ALERT_RECIPIENT_IDS, AI_CONFIG_WRITER_IDS): id'lar qayta berilganmi
-- -----------------------------------------------------------------------------
\echo '--- 15'
SELECT '15' AS n, 'o''rta' AS daraja,
       'Env''dagi foydalanuvchi id''lari eskirganmi (foydalanuvchilar qayta yaratilgan bo''lsa)' AS tekshiruv,
       'identity_schema.admins ↔ .env.production' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'NO_TABLE' THEN 'identity_schema.admins jadvali yo''q.'
         ELSE 'Serverda .env.production dagi SALE_PRICING_ENGINE_MARKET_IDS, SMS_ALERT_RECIPIENT_IDS, AI_CONFIG_WRITER_IDS id''larini SELECT id, role FROM identity_schema.admins WHERE id IN (...) bilan bir marta solishtiring.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'identity_schema.admins jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('identity_schema.admins') IS NOT NULL THEN query_to_xml($q$
    WITH s AS (
      SELECT count(*) FILTER (WHERE NOT is_deleted) AS alive,
             count(*) FILTER (WHERE "createdAt" < timestamptz '2026-11-11 00:00+05') AS pre,
             coalesce(min(id)::text, '-') AS min_id, coalesce(max(id)::text, '-') AS max_id,
             (SELECT coalesce(string_agg(k.id || ':' || k.role::text || CASE WHEN k.is_deleted THEN ':o''chirilgan' ELSE '' END
                                        || ':' || to_char(k."createdAt" AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD'), ', ' ORDER BY k.id), 'yo''q')
                FROM identity_schema.admins k WHERE k.id IN (1, 25, 26, 37, 53)) AS keep_ids,
             EXISTS (SELECT 1 FROM identity_schema.admins m
                      WHERE m.id = 37 AND (m.role::text <> 'market' OR m.is_deleted
                                           OR m."createdAt" >= timestamptz '2026-11-11 00:00+05')) AS id37_suspect,
             EXISTS (SELECT 1 FROM identity_schema.admins m
                      WHERE m.id = 37 AND m.role::text = 'market' AND NOT m.is_deleted
                        AND (m.name ILIKE '%test%' OR m.name ILIKE '%тест%' OR coalesce(m.username, '') ILIKE '%test%')) AS id37_test,
             (SELECT coalesce(last_value::text, '?') FROM pg_sequences
               WHERE schemaname = 'identity_schema' AND sequencename = 'admins_id_seq') AS seq_last
        FROM identity_schema.admins
    )
    SELECT CASE WHEN alive = 0 OR pre = 0 OR id37_suspect THEN 'WARN' ELSE 'OK' END AS holat,
           'tirik=' || alive || '; 2026-11-11 dan oldin yaratilgan qatorlar=' || pre
           || CASE WHEN pre = 0 AND alive > 0 THEN ' (HAMMA id tozalashdan keyin berilgan: env id''lari eskirgan)' ELSE '' END
           || '; id oralig''i=' || min_id || '..' || max_id || ', ketma-ketlik=' || coalesce(seq_last, '?')
           || '; ma''lum TEST id''lar (1,25,26,37,53): ' || keep_ids
           || '; id 37 (narx dvigateli kanareykasi): ' || CASE WHEN id37_suspect THEN 'SHUBHALI (market emas, o''chirilgan yoki tozalashdan keyin yaratilgan)'
                                                              WHEN id37_test THEN 'TEST nomli market'
                                                              ELSE 'market, nomida test yo''q yoki id yo''q' END AS tafsilot,
           CASE WHEN alive = 0 THEN 'Foydalanuvchi yo''q: avval 16 (superadmin).'
                WHEN pre = 0 OR id37_suspect
                THEN 'id''lar qayta berilgan bo''lishi mumkin: SALE_PRICING_ENGINE_MARKET_IDS (kanareyka 37) begona marketda narx dvigatelini yoqishi, AI_CONFIG_WRITER_IDS egasini bloklashi, SMS_ALERT_RECIPIENT_IDS begonaga yozishi mumkin. .env.production dagi id''larni SELECT id, role FROM identity_schema.admins WHERE id IN (...) bilan solishtirib, yangilang va tegishli servislarni (order-service + api-gateway, ai-service, notification-service) qayta yarating.' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- =============================================================================
-- PAST
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 16 — faol superadmin (identity-service onModuleInit SUPERADMIN_* dan qayta yaratadi)
-- -----------------------------------------------------------------------------
\echo '--- 16'
SELECT '16' AS n, 'past' AS daraja,
       'Faol superadmin (yo''q bo''lsa superadmin amallari ishlamaydi, kirish 401)' AS tekshiruv,
       'identity_schema.admins (superadmin)' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'identity_schema.admins jadvali yo''q.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'identity_schema.admins jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('identity_schema.admins') IS NOT NULL THEN query_to_xml($q$
    WITH s AS (
      SELECT count(*) FILTER (WHERE role::text = 'superadmin' AND NOT is_deleted AND status::text = 'active') AS sa_active,
             count(*) FILTER (WHERE role::text = 'superadmin' AND NOT is_deleted AND status::text <> 'active') AS sa_inactive,
             count(*) FILTER (WHERE role::text = 'superadmin' AND is_deleted) AS sa_deleted,
             count(*) FILTER (WHERE role::text = 'superadmin' AND is_deleted AND phone_number NOT LIKE '%-d%') AS sa_deleted_plain,
             string_agg(id::text, ',' ORDER BY id) FILTER (WHERE role::text = 'superadmin' AND NOT is_deleted) AS sa_ids,
             to_char(min("createdAt") FILTER (WHERE role::text = 'superadmin' AND NOT is_deleted) AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS sa_created,
             count(*) FILTER (WHERE NOT is_deleted) AS users_live
        FROM identity_schema.admins
    )
    SELECT CASE WHEN sa_active > 0 THEN 'OK' ELSE 'MISSING' END AS holat,
           'faol superadmin=' || sa_active || ' (id: ' || coalesce(sa_ids, '-') || ', birinchisi yaratilgan ' || coalesce(sa_created, '-') || ')'
           || '; nofaol=' || sa_inactive || '; o''chirilgan=' || sa_deleted
           || '; o''chirilgan, telefoni bo''shatilmagan=' || sa_deleted_plain
           || '; tirik foydalanuvchilar=' || users_live AS tafsilot,
           CASE WHEN sa_active > 0 AND sa_created >= '2026-11-11'
                THEN 'Superadmin tozalashdan keyin qayta yaratilgan (yangi id): .env.production dagi AI_CONFIG_WRITER_IDS va SMS_ALERT_RECIPIENT_IDS ni yangi id bilan solishtiring (15).'
                WHEN sa_active > 0 THEN NULL
                WHEN sa_inactive > 0
                THEN 'Superadmin bor, lekin nofaol: identity-service qayta ishga tushsa ham yangisi yaratilmaydi. Ega roziligi bilan o''sha id ni status=active qiling.'
                WHEN sa_deleted_plain > 0
                THEN 'Avval o''chirilgan superadmin telefonini bo''shating (aks holda qayta yaratishda UQ_admins_phone_number xatosi, identity-service ishga tushmaydi), keyin identity-service ni qayta ishga tushiring.'
                ELSE 'identity-service ni qayta ishga tushiring: onModuleInit superadminni .env dagi SUPERADMIN_* dan yaratadi. SUPERADMIN_PHONE_NUMBER boshqa foydalanuvchida bo''lsa, avval uni bo''shating.' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 17 — filial kassalari: menejerli har non-HQ filialga bitta 'branch' kassa
-- -----------------------------------------------------------------------------
\echo '--- 17'
SELECT '17' AS n, 'past' AS daraja,
       'Filial kassalari: menejeri bor har non-HQ filial uchun branch kassa (o''zi tiklanadi)' AS tekshiruv,
       'finance_schema.cashboxes (branch)' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'cashboxes, branches yoki branch_users jadvali yo''q.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'jadval yo''q: cashboxes=' || coalesce(to_regclass('finance_schema.cashboxes')::text, 'YO''Q')
                                    || ', branches=' || coalesce(to_regclass('branch_schema.branches')::text, 'YO''Q')
                                    || ', branch_users=' || coalesce(to_regclass('branch_schema.branch_users')::text, 'YO''Q')
              ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('finance_schema.cashboxes') IS NOT NULL
                     AND to_regclass('branch_schema.branches') IS NOT NULL
                     AND to_regclass('branch_schema.branch_users') IS NOT NULL THEN query_to_xml($q$
    WITH managed AS (
      SELECT DISTINCT bu.branch_id
        FROM branch_schema.branch_users bu
        JOIN branch_schema.branches b ON b.id = bu.branch_id AND b.is_deleted = false AND b.type::text <> 'HQ'
       WHERE bu.role::text = 'MANAGER' AND bu.is_deleted = false
    ), st AS (
      SELECT m.branch_id,
             EXISTS (SELECT 1 FROM finance_schema.cashboxes c WHERE c.user_id = m.branch_id AND c.cashbox_type::text = 'branch' AND c.is_deleted = false) AS has_active,
             EXISTS (SELECT 1 FROM finance_schema.cashboxes c WHERE c.user_id = m.branch_id AND c.cashbox_type::text = 'branch' AND c.is_deleted = true) AS has_deleted
        FROM managed m
    ), s AS (
      SELECT (SELECT count(*) FROM st) AS managed,
             (SELECT count(*) FROM st WHERE NOT has_active) AS missing,
             (SELECT count(*) FROM st WHERE NOT has_active AND has_deleted) AS soft_only,
             (SELECT count(*) FROM finance_schema.cashboxes WHERE cashbox_type::text = 'branch' AND is_deleted = false) AS active_total,
             (SELECT string_agg(branch_id::text, ',' ORDER BY branch_id) FROM (SELECT branch_id FROM st WHERE NOT has_active ORDER BY branch_id LIMIT 30) z) AS missing_ids,
             CASE WHEN to_regclass('order_schema.order_settlement') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
               SELECT count(DISTINCT s.branch_id) AS n FROM order_schema.order_settlement s
                 JOIN branch_schema.branches b ON b.id = s.branch_id AND b.type::text <> 'HQ'
                WHERE s.is_deleted = false AND s.status::text IN ('pending', 'courier_settled')
                  AND NOT EXISTS (SELECT 1 FROM finance_schema.cashboxes c
                                   WHERE c.user_id = s.branch_id AND c.cashbox_type::text = 'branch' AND c.is_deleted = false)
             $s$, false, true, '')))[1]::text::bigint END AS open_settl_missing
    )
    SELECT CASE WHEN missing > 0 THEN 'MISSING' WHEN coalesce(open_settl_missing, 0) > 0 THEN 'WARN' ELSE 'OK' END AS holat,
           'menejerli non-HQ filial=' || managed || '; kassasiz=' || missing || ' [' || coalesce(missing_ids, '-') || ']'
           || '; faqat o''chirilgan kassasi bor=' || soft_only || '; faol branch kassalar=' || active_total
           || '; ochiq settlement bor, kassasi yo''q filial=' || coalesce(open_settl_missing::text, 'n/a') AS tafsilot,
           CASE WHEN missing > 0
                THEN 'Birinchi teginishgacha HQ «Pul qabul qilish», filial kartalari va menejer chiqimi 404 beradi. Tezkor: menejer «Kassa» sahifasini yoki superadmin filial kassasi tafsilotini ochsin — 0 qoldiq bilan o''zi yaratiladi. Migratsiya ixtiyoriy (hujjatdagi 17-band).'
                WHEN coalesce(open_settl_missing, 0) > 0
                THEN 'Ochiq settlement bor, lekin filial kassasi yo''q (pul yo''qolgan): «Pul qabul qilish» 400 beradi. Buxgalteriya qarori kerak — balans o''ylab topilmaydi.' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 18 — kassa kartalari: «Asosiy karta» (o'zi tiklanadi), yetim va nomos kartalar
-- -----------------------------------------------------------------------------
\echo '--- 18'
SELECT '18' AS n, 'past' AS daraja,
       'Kassa kartalari: «Asosiy karta» (o''zi yaratiladi) va kartalar nomuvofiqligi' AS tekshiruv,
       'finance_schema.cashbox_cards' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas («Asosiy karta» birinchi ochilishda o''zi yaratiladi).'
         ELSE 'cashbox_cards yoki cashboxes jadvali yo''q.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'jadval yo''q: cashbox_cards=' || coalesce(to_regclass('finance_schema.cashbox_cards')::text, 'YO''Q')
                                    || ', cashboxes=' || coalesce(to_regclass('finance_schema.cashboxes')::text, 'YO''Q')
              ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('finance_schema.cashbox_cards') IS NOT NULL
                     AND to_regclass('finance_schema.cashboxes') IS NOT NULL THEN query_to_xml($q$
    WITH cb AS (
      SELECT id, cashbox_type::text AS t, balance_card FROM finance_schema.cashboxes
       WHERE is_deleted = false AND cashbox_type::text IN ('main', 'branch')
    ), s AS (
      SELECT
        (SELECT count(*) FROM cb WHERE t = 'main') AS main_boxes,
        (SELECT count(*) FROM cb WHERE t = 'main' AND NOT EXISTS (SELECT 1 FROM finance_schema.cashbox_cards c
            WHERE c.cashbox_id = cb.id AND c.is_default AND NOT c.is_deleted)) AS main_no_default,
        (SELECT count(*) FROM cb WHERE t = 'branch' AND NOT EXISTS (SELECT 1 FROM finance_schema.cashbox_cards c
            WHERE c.cashbox_id = cb.id AND c.is_default AND NOT c.is_deleted)) AS branch_no_default,
        (SELECT count(*) FROM finance_schema.cashbox_cards WHERE NOT is_deleted AND NOT is_default) AS named_live,
        (SELECT count(*) FROM cb WHERE NOT EXISTS (SELECT 1 FROM finance_schema.cashbox_cards c
            WHERE c.cashbox_id = cb.id AND c.is_default AND NOT c.is_deleted)
            AND EXISTS (SELECT 1 FROM finance_schema.cashbox_cards c
            WHERE c.cashbox_id = cb.id AND NOT c.is_deleted AND lower(c.name) = lower('Asosiy karta'))) AS name_blocked,
        (SELECT count(*) FROM finance_schema.cashbox_cards c WHERE NOT c.is_deleted
            AND NOT EXISTS (SELECT 1 FROM finance_schema.cashboxes x WHERE x.id = c.cashbox_id AND NOT x.is_deleted)) AS orphan_cards,
        (SELECT count(*) FROM cb WHERE cb.balance_card < (SELECT coalesce(sum(c.balance), 0) FROM finance_schema.cashbox_cards c
            WHERE c.cashbox_id = cb.id AND NOT c.is_default AND NOT c.is_deleted)) AS out_of_sync,
        CASE WHEN to_regclass('finance_schema.cashbox_history') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM finance_schema.cashbox_history h
           WHERE h.card_id IS NOT NULL AND h.is_deleted = false
             AND NOT EXISTS (SELECT 1 FROM finance_schema.cashbox_cards c WHERE c.id = h.card_id)
        $s$, false, true, '')))[1]::text::bigint END AS history_dangling
    )
    SELECT CASE WHEN name_blocked > 0 THEN 'MISSING'
                WHEN orphan_cards > 0 OR out_of_sync > 0 OR coalesce(history_dangling, 0) > 0 THEN 'WARN'
                ELSE 'OK' END AS holat,
           'MAIN kassa=' || main_boxes || '; «Asosiy karta»siz: MAIN=' || main_no_default || ', filial=' || branch_no_default
           || ' (o''zi yaratiladi); nomli kartalar=' || named_live
           || '; «Asosiy karta» nomi band (500)=' || name_blocked || '; yetim karta=' || orphan_cards
           || '; nomli kartalar yig''indisi balance_card dan katta=' || out_of_sync
           || '; tarixda mavjud bo''lmagan card_id=' || coalesce(history_dangling::text, 'n/a') AS tafsilot,
           CASE WHEN name_blocked > 0
                THEN 'Sukut kartasi yo''q, lekin oddiy «Asosiy karta» nomli karta bor: kartalar ro''yxati va karta qo''shish 500 «Asosiy karta yaratilmadi». Ko''rib chiqib o''sha kartani qayta nomlang yoki (balance=0 bilan) sukut qiling — hujjatdagi 18-band.'
                WHEN orphan_cards > 0 OR out_of_sync > 0 OR coalesce(history_dangling, 0) > 0
                THEN 'Qisman tozalash izlari (yetim karta, nomos qoldiq yoki tarixda o''chgan karta): to''lovni tuzatish 409 berishi mumkin. Ega bilan qo''lda ko''rib chiqing; nomli kartalarni admin qayta qo''shsin va «Kartalararo o''tkazma» bilan pulni joylasin.' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 19 — HQ viloyat qoidasidan oldingi buyurtmalar istisnolari (migratsiya 211 surati)
-- -----------------------------------------------------------------------------
\echo '--- 19'
SELECT '19' AS n, 'past' AS daraja,
       'HQ kuryeri qamrov istisnolari (211): qoidadan oldingi eski buyurtmalar uchun' AS tekshiruv,
       'logistics_schema.district_coverage_exemptions' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q (migratsiya 203): viloyatdan tashqari kuryerga berish 403 o''rniga 503 qaytaradi. 203 DDL''ini qayta qo''llovchi migratsiya kerak.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'logistics_schema.district_coverage_exemptions jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('logistics_schema.district_coverage_exemptions') IS NOT NULL THEN query_to_xml($q$
    WITH c AS (
      SELECT count(*) AS total,
             count(*) FILTER (WHERE source = 'hq_region_rule_deploy') AS deploy_rows,
             count(*) FILTER (WHERE revoked_at IS NULL) AS active,
             (to_regclass('logistics_schema.districts') IS NOT NULL AND to_regclass('order_schema.orders') IS NOT NULL
              AND to_regclass('order_schema.branch_transfer_batches') IS NOT NULL AND to_regclass('branch_schema.branches') IS NOT NULL) AS has_deps
        FROM logistics_schema.district_coverage_exemptions
    ), d AS (
      SELECT CASE WHEN c.has_deps THEN query_to_xml($s$
        WITH e AS (SELECT * FROM logistics_schema.district_coverage_exemptions),
        cut AS (
          SELECT coalesce(min(created_at) FILTER (WHERE source = 'hq_region_rule_deploy'),
                          timestamptz '2026-11-07 00:00:00+00') AS t FROM e
        ), cand AS (
          SELECT o.id, hq.id AS hq_id, o."createdAt" AS created
            FROM order_schema.orders o
            LEFT JOIN order_schema.branch_transfer_batches b
              ON b.id = o.current_batch_id AND b.status::text = 'SENT'
            JOIN branch_schema.branches hq
              ON hq.id = coalesce(NULLIF(b.destination_branch_id, 0),
                                  CASE WHEN upper(o.holder_type::text) IN ('BRANCH', 'COURIER') THEN NULLIF(o.holder_branch_id, 0) END,
                                  NULLIF(o.branch_id, 0))
             AND upper(hq.type::text) = 'HQ' AND hq.is_deleted = false
            LEFT JOIN logistics_schema.districts dd ON dd.id = o.district_id
           WHERE o.is_deleted = false AND o.deleted_at IS NULL
             AND o.status::text IN ('on the road', 'waiting', 'waiting_customer', 'cancelled', 'sold')
             AND upper(coalesce(o.holder_type::text, '')) <> 'MARKET'
             AND (hq.region_id IS NULL
                  OR CASE WHEN dd.id IS NOT NULL THEN coalesce(dd.assigned_region, dd.region_id) ELSE o.region_id END
                     IS DISTINCT FROM hq.region_id)
        )
        SELECT
          (SELECT count(*) FROM cand, cut WHERE cand.created < cut.t
             AND NOT EXISTS (SELECT 1 FROM e WHERE e.order_id = cand.id AND e.branch_id = cand.hq_id)) AS missing_pre_rule,
          (SELECT count(*) FROM e LEFT JOIN order_schema.orders o ON o.id = e.order_id WHERE o.id IS NULL) AS orphan_rows,
          (SELECT count(*) FROM e JOIN order_schema.orders o ON o.id = e.order_id
            WHERE e.revoked_at IS NULL AND o."createdAt" > e.created_at) AS id_reuse_rows,
          (SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') FROM cut) AS cutoff_utc
      $s$, false, true, '') END AS dx
        FROM c
    ), v AS (
      SELECT c.*,
             (xpath('/row/missing_pre_rule/text()', d.dx))[1]::text::bigint AS missing_pre_rule,
             (xpath('/row/orphan_rows/text()', d.dx))[1]::text::bigint AS orphan_rows,
             (xpath('/row/id_reuse_rows/text()', d.dx))[1]::text::bigint AS id_reuse_rows,
             (xpath('/row/cutoff_utc/text()', d.dx))[1]::text AS cutoff_utc
        FROM c, d
    )
    SELECT CASE WHEN coalesce(missing_pre_rule, 0) > 0 THEN 'MISSING'
                WHEN coalesce(id_reuse_rows, 0) > 0 THEN 'WARN' ELSE 'OK' END AS holat,
           'qatorlar=' || total || ' (deploy=' || deploy_rows || ', faol=' || active || ')'
           || CASE WHEN NOT has_deps THEN '; orders/branches/districts jadvali yo''q, nomzod tekshiruvi o''tkazildi'
                   ELSE '; qoidadan (' || coalesce(cutoff_utc, '-') || ' UTC) oldingi, istisnosiz qolgan nomzod buyurtmalar=' || coalesce(missing_pre_rule::text, '-')
                        || '; buyurtmasi yo''q qatorlar=' || coalesce(orphan_rows::text, '-')
                        || '; yangi buyurtmaga tushgan eski qatorlar (id qayta ishlatilgan)=' || coalesce(id_reuse_rows::text, '-') END AS tafsilot,
           CASE WHEN coalesce(missing_pre_rule, 0) > 0
                THEN 'Qoidadan oldingi eski buyurtmalar istisnosiz: ularni HQ kuryeriga berish 403. 211 ni qayta yurgizmang (qoidani kengaytiradi). Ops roziligi bilan bir martalik, ko''rib chiqilgan INSERT (createdAt filtri bilan, ON CONFLICT DO NOTHING) — hujjatdagi 19-band.'
                WHEN coalesce(id_reuse_rows, 0) > 0
                THEN 'Eski istisno qatorlari yangi buyurtmalarga tushmoqda (orders id qayta boshlangan): ops roziligi bilan revoked_at = now() qiling (o''chirmang).' END AS nima
      FROM v
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 20 — moliya kunlik snapshot'lari (job tarixdan o'zi quradi; eskirgan qoldiq xavfi)
-- -----------------------------------------------------------------------------
\echo '--- 20'
SELECT '20' AS n, 'past' AS daraja,
       'Moliya kunlik snapshot''lari: bo''sh bo''lsa o''zi to''ladi; tarix tozalanib snapshot qolgan bo''lsa — eskirgan' AS tekshiruv,
       'finance_schema.finance_daily_snapshots, finance_cashbox_daily' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q (migratsiya 176 yoki cashboxes/cashbox_history).' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'jadval yo''q: snapshots=' || coalesce(to_regclass('finance_schema.finance_daily_snapshots')::text, 'YO''Q')
                                    || ', cashbox_daily=' || coalesce(to_regclass('finance_schema.finance_cashbox_daily')::text, 'YO''Q')
              ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('finance_schema.finance_daily_snapshots') IS NOT NULL
                     AND to_regclass('finance_schema.finance_cashbox_daily') IS NOT NULL
                     AND to_regclass('finance_schema.cashbox_history') IS NOT NULL
                     AND to_regclass('finance_schema.cashboxes') IS NOT NULL THEN query_to_xml($q$
    WITH p AS (SELECT (now() AT TIME ZONE 'Asia/Tashkent')::date AS today),
    snap AS (SELECT count(*) AS n, min(snapshot_date) AS first_day, max(snapshot_date) AS last_day
               FROM finance_schema.finance_daily_snapshots),
    dly AS (SELECT count(*) AS n, min(d.snapshot_date) AS first_day,
                   count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM finance_schema.cashboxes c WHERE c.id = d.cashbox_id)) AS orphans
              FROM finance_schema.finance_cashbox_daily d),
    hist AS (SELECT count(*) AS n, (min(h."createdAt") AT TIME ZONE 'Asia/Tashkent')::date AS first_day
               FROM finance_schema.cashbox_history h WHERE h.is_deleted = false),
    drift AS (
      SELECT count(*) AS n
        FROM finance_schema.cashboxes c CROSS JOIN snap
        LEFT JOIN LATERAL (
          SELECT h.balance_after FROM finance_schema.cashbox_history h
           WHERE h.cashbox_id = c.id AND h.is_deleted = false
             AND h."createdAt" < ((snap.last_day + 1)::timestamp AT TIME ZONE 'Asia/Tashkent')
           ORDER BY h."createdAt" DESC, h.id DESC LIMIT 1) lh ON true
        LEFT JOIN finance_schema.finance_cashbox_daily d ON d.cashbox_id = c.id AND d.snapshot_date = snap.last_day
       WHERE snap.last_day IS NOT NULL AND c.is_deleted = false
         AND coalesce(lh.balance_after, 0) <> coalesce(d.closing_balance, 0)
    ), v AS (
      SELECT p.today, snap.n AS snap_n, snap.first_day AS snap_first, snap.last_day AS snap_last,
             dly.n AS dly_n, dly.orphans, hist.n AS hist_n, hist.first_day AS hist_first, drift.n AS drift_n,
             (snap.n > 0 AND (hist.first_day IS NULL OR snap.first_day < hist.first_day))
               OR (dly.n > 0 AND (hist.first_day IS NULL OR dly.first_day < hist.first_day)) AS leftovers
        FROM p, snap, dly, hist, drift
    )
    SELECT CASE WHEN drift_n > 0 OR orphans > 0 OR leftovers THEN 'WARN'
                WHEN snap_last IS NULL AND hist_first IS NOT NULL AND hist_first <= today - 1 THEN 'MISSING'
                WHEN snap_last IS NOT NULL AND snap_last < today - 2 THEN 'WARN'
                ELSE 'OK' END AS holat,
           'snapshot kunlari=' || snap_n || ' (' || coalesce(snap_first::text, '-') || '..' || coalesce(snap_last::text, '-') || ')'
           || '; cashbox_daily=' || dly_n || '; kassasi yo''q daily=' || orphans
           || '; tarix qatorlari=' || hist_n || ', birinchi kun=' || coalesce(hist_first::text, '-')
           || '; oxirgi kunda tarixga mos kelmagan kassalar=' || drift_n
           || '; tarixdan oldingi snapshot=' || CASE WHEN leftovers THEN 'HA' ELSE 'yo''q' END
           || '; bugun=' || today AS tafsilot,
           CASE WHEN drift_n > 0 OR orphans > 0 OR leftovers
                THEN 'Snapshot''lar tozalangan tarixdan qolgan: «Balans dinamikasi» va kun boshi/oxiri qoldiqlari eskirgan. Backup''dan keyin, ega roziligi bilan IKKALA jadvalni birga tozalang (DELETE FROM finance_schema.finance_daily_snapshots; DELETE FROM finance_schema.finance_cashbox_daily;) — job ~10 daqiqada qayta quradi.'
                WHEN snap_last IS NULL AND hist_first IS NOT NULL AND hist_first <= today - 1
                THEN 'finance-service ishlayotganini va FINANCE_DAILY_SNAPSHOT_DISABLED=false ekanini tekshiring: job ishga tushgach ~1-11 daqiqada o''zi to''ldiradi.'
                WHEN snap_last IS NOT NULL AND snap_last < today - 2
                THEN 'Snapshot job orqada qolgan: finance-service loglarini tekshiring.' END AS nima
      FROM v
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 21 — «Kun tartibi» (buyurtma yaratish/qabul chegaralari): bo'sh = cheklovsiz
-- -----------------------------------------------------------------------------
\echo '--- 21'
SELECT '21' AS n, 'past' AS daraja,
       '«Kun tartibi» sozlamalari (bo''sh = chegara yo''q, kun 00:00 da almashadi)' AS tekshiruv,
       'order_schema.order_settings' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'NO_TABLE' THEN 'Jadval yo''q (213): GET/PATCH /orders/intake-settings 5xx, yaratish/qabul ochiq. 213 DDL''ini (IF NOT EXISTS) qayta qo''llovchi migratsiya kerak.'
         ELSE 'Hech narsa qilish shart emas. Tozalashdan oldin «Kun tartibi» sozlangan bo''lsa (chegara 10:00, 16:00 kabi), superadmin /ops → «Kun tartibi» da qayta kiritsin.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'order_schema.order_settings jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('order_schema.order_settings') IS NOT NULL THEN query_to_xml($q$
    WITH s AS (
      SELECT count(*) FILTER (WHERE NOT is_deleted) AS active_rows,
             count(*) FILTER (WHERE is_deleted AND key IN ('intake.cutoff', 'intake.receive_cutoff', 'intake.day_change_time')) AS soft_deleted,
             coalesce(max(value ->> 'time') FILTER (WHERE key = 'intake.day_change_time' AND NOT is_deleted), 'sukut 00:00') AS day_change,
             coalesce(max(value ->> 'cutoff_time') FILTER (WHERE key = 'intake.cutoff' AND NOT is_deleted), 'yo''q') AS create_cutoff,
             coalesce(max(value ->> 'cutoff_time') FILTER (WHERE key = 'intake.receive_cutoff' AND NOT is_deleted), 'yo''q') AS receive_cutoff,
             coalesce(to_char(max("updatedAt") AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI'), '-') AS last_update
        FROM order_schema.order_settings
    )
    SELECT CASE WHEN soft_deleted > 0 THEN 'WARN' ELSE 'OK' END AS holat,
           'faol qatorlar=' || active_rows || '; kun almashishi=' || day_change || '; yaratish chegarasi=' || create_cutoff
           || '; qabul chegarasi=' || receive_cutoff || '; oxirgi o''zgarish=' || last_update
           || '; o''chirilgan (is_deleted) intake qatorlari=' || soft_deleted AS tafsilot,
           CASE WHEN soft_deleted > 0
                THEN 'is_deleted=true intake qatorlari bor: PATCH upsert is_deleted ni tiklamaydi, UI''dagi o''zgarish jimgina ta''sir qilmaydi. Ega roziligi bilan o''sha kalitlarni qo''lda o''chiring yoki kodda orUpdate ga is_deleted qo''shing.' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- =============================================================================
-- YO'Q (ma'lumot uchun; anomaliya bo'lsa WARN)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 22 — Asosiy kassa (MAIN, user_id 0): finance-service har ishga tushishda yaratadi
-- -----------------------------------------------------------------------------
\echo '--- 22'
SELECT '22' AS n, 'yo''q' AS daraja,
       'Asosiy kassa (MAIN, user_id 0): bitta tirik qator, qoldiq tarixga mos' AS tekshiruv,
       'finance_schema.cashboxes (main)' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'finance_schema.cashboxes jadvali yo''q.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'finance_schema.cashboxes jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('finance_schema.cashboxes') IS NOT NULL THEN query_to_xml($q$
    WITH m0 AS (
      SELECT count(*) FILTER (WHERE NOT is_deleted AND user_id = 0) AS live,
             count(*) FILTER (WHERE is_deleted) AS deleted,
             count(*) FILTER (WHERE NOT is_deleted AND user_id <> 0) AS foreign_owner,
             min(id) FILTER (WHERE NOT is_deleted AND user_id = 0) AS main_id,
             string_agg(id || ':' || balance, ', ' ORDER BY id) FILTER (WHERE NOT is_deleted AND user_id = 0) AS all_live
        FROM finance_schema.cashboxes WHERE cashbox_type::text = 'main'
    ), m AS (
      SELECT m0.*, (SELECT c.balance FROM finance_schema.cashboxes c WHERE c.id = m0.main_id) AS balance FROM m0
    ), h AS (
      SELECT CASE WHEN to_regclass('finance_schema.cashbox_history') IS NULL OR m.main_id IS NULL THEN NULL
                  ELSE (xpath('/row/v/text()', query_to_xml(
                    'SELECT coalesce(sum(CASE WHEN operation_type::text = ''income'' THEN amount '
                    || 'WHEN operation_type::text = ''expense'' THEN -amount ELSE 0 END), 0) AS v '
                    || 'FROM finance_schema.cashbox_history WHERE is_deleted = false AND cashbox_id = ' || m.main_id,
                    false, true, '')))[1]::text::numeric END AS hist_sum
        FROM m
    )
    SELECT CASE WHEN m.live = 0 THEN 'MISSING'
                WHEN m.live > 1 THEN 'WARN'
                WHEN h.hist_sum IS NOT NULL AND abs(m.balance - h.hist_sum) > 0.01 THEN 'WARN'
                ELSE 'OK' END AS holat,
           'tirik MAIN=' || m.live || coalesce(' (id ' || m.main_id || ', qoldiq ' || m.balance || ', tarix yig''indisi ' || coalesce(h.hist_sum::text, 'n/a') || ')', '')
           || CASE WHEN m.live > 1 THEN '; hammasi id:qoldiq = ' || m.all_live ELSE '' END
           || '; o''chirilgan MAIN=' || m.deleted || '; user_id 0 bo''lmagan tirik MAIN=' || m.foreign_owner AS tafsilot,
           CASE WHEN m.live = 0
                THEN 'finance-service ni qayta ishga tushiring yoki superadmin «Asosiy kassa» sahifasini ochsin — qator 0 qoldiq bilan yaratiladi. Qoldiqni avtomatik tiklamang: naqd pulni sanab «To''ldirish» orqali kiriting.'
                WHEN m.live > 1
                THEN 'Bir nechta MAIN kassa: unique indeks yo''q, findOne ixtiyoriy qatorni oladi va pul bo''linadi. Qo''lda birlashtiring (avtomatik emas).'
                WHEN h.hist_sum IS NOT NULL AND abs(m.balance - h.hist_sum) > 0.01
                THEN 'Qoldiq kassa tarixi yig''indisiga teng emas (tarix tozalangan, kassa qolgan): ega bilan qo''lda solishtiring, avtomatik tuzatmang.' END AS nima
      FROM m, h
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 23 — moliya sozlamalari (smena tekshiruvi seed 215; kod sukuti seed bilan bir xil)
-- -----------------------------------------------------------------------------
\echo '--- 23'
SELECT '23' AS n, 'yo''q' AS daraja,
       'Moliya sozlamalari: smena tekshiruvi (215), chek, to''lovni tuzatish, avto-yopish' AS tekshiruv,
       'finance_schema.finance_settings' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'NO_TABLE' THEN 'Jadval yo''q (166): smena yopish / chek / to''lovni tuzatish sozlamalari o''qilmaydi. Migratsiya loglarini tekshiring.'
         ELSE 'Hech narsa qilish shart emas.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'finance_schema.finance_settings jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('finance_schema.finance_settings') IS NOT NULL THEN query_to_xml($q$
    WITH s AS (
      SELECT count(*) FILTER (WHERE NOT is_deleted AND key IN ('shift.account_check.enabled', 'shift.photo.required',
                                                              'shift.ai_check.enabled', 'shift.account_check.branch_enabled')) AS seed_keys,
             count(*) FILTER (WHERE NOT is_deleted) AS active_rows,
             count(*) FILTER (WHERE NOT is_deleted AND updated_by IS NOT NULL) AS admin_rows,
             count(*) FILTER (WHERE is_deleted) AS soft_deleted,
             coalesce(string_agg(key || '=' || value::text, ', ' ORDER BY key) FILTER (WHERE NOT is_deleted), '-') AS keys
        FROM finance_schema.finance_settings
    )
    SELECT CASE WHEN soft_deleted > 0 THEN 'WARN' ELSE 'OK' END AS holat,
           'seed kalitlari=' || seed_keys || '/4 (yo''qligi zararsiz: kod sukuti = seed); faol qatorlar=' || active_rows
           || '; superadmin o''zgartirgan=' || admin_rows || '; o''chirilgan (is_deleted)=' || soft_deleted
           || '; kalitlar: ' || keys AS tafsilot,
           CASE WHEN soft_deleted > 0
                THEN 'is_deleted=true qatorlar bor: PATCH upsert is_deleted ni tiklamaydi, UI''dagi o''zgarish jimgina ta''sir qilmaydi. Ega roziligi bilan qo''lda tozalang.'
                WHEN seed_keys < 4 OR admin_rows = 0
                THEN 'Zararsiz. Agar tozalashdan oldin superadmin smena/chek/avto-yopish sozlamalarini o''zgartirgan bo''lsa, «Smena sozlamalari» va /ops → «Kun tartibi» da qayta qo''ysin (upsert, mavjud qator kerak emas).' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 24 — kontakt sozlamalari (zaxira raqamlar, sukut market mas'uli): seed bo'sh qiymat
-- -----------------------------------------------------------------------------
\echo '--- 24'
SELECT '24' AS n, 'yo''q' AS daraja,
       'Kontakt sozlamalari: zaxira raqamlar va sukut market mas''uli' AS tekshiruv,
       'identity_schema.app_settings' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'NO_TABLE' THEN 'Jadval yo''q (185): /settings/contacts va chek kontaktlari xato beradi. Migratsiya loglarini tekshiring.'
         ELSE 'Hech narsa qilish shart emas (kalit yo''qligi = bo''sh qiymat). Tozalashdan oldin zaxira raqamlar kiritilgan bo''lsa, superadmin/admin PATCH /settings/contacts (hozircha faqat API) bilan qayta kiritsin.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'identity_schema.app_settings jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('identity_schema.app_settings') IS NOT NULL THEN query_to_xml($q$
    WITH sp AS (SELECT value FROM identity_schema.app_settings WHERE key = 'contacts.support_phones'),
    dr AS (SELECT value #>> '{}' AS raw FROM identity_schema.app_settings WHERE key = 'contacts.default_market_responsible_id'),
    v AS (
      SELECT (SELECT count(*) FROM identity_schema.app_settings) AS total,
             EXISTS (SELECT 1 FROM sp) AS sp_row,
             coalesce((SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN jsonb_array_length(value) END FROM sp), 0) AS sp_count,
             EXISTS (SELECT 1 FROM dr) AS dr_row,
             (SELECT raw FROM dr) AS dr_raw,
             CASE WHEN coalesce((SELECT raw FROM dr), '') !~ '^[0-9]{1,18}$' THEN NULL
                  WHEN to_regclass('identity_schema.admins') IS NULL THEN NULL
                  ELSE (xpath('/row/v/text()', query_to_xml(
                    'SELECT EXISTS (SELECT 1 FROM identity_schema.admins a WHERE a.id = ' || (SELECT raw FROM dr)
                    || ' AND a.is_deleted = false AND a.status::text = ''active'''
                    || ' AND a.role::text IN (''superadmin'', ''admin'', ''registrator'', ''logist'')) AS v',
                    false, true, '')))[1]::text::boolean END AS dr_valid
    )
    SELECT CASE WHEN dr_valid IS FALSE THEN 'WARN' ELSE 'OK' END AS holat,
           'qatorlar=' || total || '; contacts.support_phones=' || CASE WHEN sp_row THEN sp_count || ' ta raqam' ELSE 'qator yo''q' END
           || '; contacts.default_market_responsible_id=' || CASE WHEN dr_row THEN coalesce(dr_raw, 'null') ELSE 'qator yo''q' END
           || CASE WHEN dr_valid IS FALSE THEN ' (YAROQSIZ: faol superadmin/admin/registrator/logist emas)'
                   WHEN dr_valid THEN ' (yaroqli)' ELSE '' END AS tafsilot,
           CASE WHEN dr_valid IS FALSE
                THEN 'Sukut mas''ul id si yaroqsiz (id qayta berilgan?). Avtomatik null qilmang: superadmin/admin PATCH /settings/contacts {default_market_responsible_id} bilan to''g''rilasin.' END AS nima
      FROM v
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 25 — order_settlement qoldiqlari: SEED- yuklama testi va buyurtmasi yo'q settlement'lar
-- -----------------------------------------------------------------------------
\echo '--- 25'
SELECT '25' AS n, 'yo''q' AS daraja,
       'Buyurtma/settlement qoldiqlari: SEED- test buyurtmalari va buyurtmasi yo''q settlement (soxta summa xavfi)' AS tekshiruv,
       'order_schema.orders / order_items / order_settlement' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas (bo''sh jadvallar — yangi bazaning normal holati).'
         ELSE 'orders, order_items yoki order_settlement jadvali yo''q.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'jadval yo''q: orders=' || coalesce(to_regclass('order_schema.orders')::text, 'YO''Q')
                                    || ', order_items=' || coalesce(to_regclass('order_schema.order_items')::text, 'YO''Q')
                                    || ', order_settlement=' || coalesce(to_regclass('order_schema.order_settlement')::text, 'YO''Q')
              ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('order_schema.orders') IS NOT NULL
                     AND to_regclass('order_schema.order_items') IS NOT NULL
                     AND to_regclass('order_schema.order_settlement') IS NOT NULL THEN query_to_xml($q$
    WITH s AS (
      SELECT (SELECT count(*) FROM order_schema.orders) AS orders_total,
             (SELECT count(*) FROM order_schema.orders WHERE external_id LIKE 'SEED-%') AS seed_orders,
             (SELECT count(*) FROM order_schema.order_settlement s
               WHERE NOT EXISTS (SELECT 1 FROM order_schema.orders o WHERE o.id = s.order_id)) AS orphan_settl,
             (SELECT coalesce(sum(s.market_amount), 0) FROM order_schema.order_settlement s
               WHERE s.is_deleted = false AND s.status::text IN ('pending', 'courier_settled', 'branch_settled')
                 AND NOT EXISTS (SELECT 1 FROM order_schema.orders o WHERE o.id = s.order_id)) AS orphan_open_market,
             (SELECT count(*) FROM order_schema.order_items i
               WHERE NOT EXISTS (SELECT 1 FROM order_schema.orders o WHERE o.id = i.order_id)) AS orphan_items
    )
    SELECT CASE WHEN seed_orders > 0 OR orphan_settl > 0 OR orphan_items > 0 THEN 'WARN' ELSE 'OK' END AS holat,
           'buyurtmalar=' || orders_total || '; SEED- qoldiq=' || seed_orders
           || '; buyurtmasi yo''q settlement=' || orphan_settl || ' (ochiq market_amount ' || orphan_open_market || ')'
           || '; buyurtmasi yo''q order_items=' || orphan_items AS tafsilot,
           CASE WHEN seed_orders > 0
                THEN 'Yuklama testi qoldiqlari: backup''dan keyin scripts/seed-load-cleanup.sql ni qo''lda yurgizing.'
                WHEN orphan_settl > 0
                THEN 'Buyurtmasi o''chgan settlement qatorlari «Moliyaviy balans» va filial qarzini soxta oshiradi (seed-load-cleanup ularni ushlamaydi). Backup va moliya ko''rigidan keyin qo''lda o''chiring — migratsiya bilan emas.'
                WHEN orphan_items > 0 THEN 'Yetim order_items: FK CASCADE bo''lishi kerak edi, qo''lda tekshiring.' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 26 — integratsiyalar (hamkorlar, ulanishlar, carrier): seed yo'q, yetim bog'lanishlar
-- -----------------------------------------------------------------------------
\echo '--- 26'
SELECT '26' AS n, 'yo''q' AS daraja,
       'Integratsiyalar: ulanish, hamkor, carrier (seed yo''q) va yetim bog''lanishlar' AS tekshiruv,
       'integration_schema.external_integrations, partners, partner_*_refs, carrier_accounts' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas (bo''sh jadval — to''g''ri holat; jonli ulanish bo''lgan bo''lsa admin «Integratsiyalar» konsolida qayta yaratadi, kalitlar yangidan beriladi).'
         ELSE 'integration_schema jadvali yo''q.' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'integration_schema jadvallaridan biri yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('integration_schema.external_integrations') IS NOT NULL
                     AND to_regclass('integration_schema.partners') IS NOT NULL
                     AND to_regclass('integration_schema.partner_market_refs') IS NOT NULL
                     AND to_regclass('integration_schema.partner_shipment_refs') IS NOT NULL
                     AND to_regclass('integration_schema.carrier_accounts') IS NOT NULL THEN query_to_xml($q$
    WITH s AS (
      SELECT
        (SELECT count(*) FROM integration_schema.external_integrations WHERE is_deleted = false AND is_active = true) AS ei_active,
        (SELECT count(*) FROM integration_schema.partners WHERE is_deleted = false AND is_active = true) AS partners_active,
        (SELECT count(*) FROM integration_schema.carrier_accounts WHERE is_deleted = false AND is_active = true) AS carriers_active,
        (SELECT count(*) FROM integration_schema.partner_market_refs WHERE is_deleted = false) AS market_refs,
        (SELECT count(*) FROM integration_schema.partner_market_refs m WHERE m.is_deleted = false
            AND NOT EXISTS (SELECT 1 FROM integration_schema.partners p WHERE p.id = m.partner_id AND p.is_deleted = false))
        + (SELECT count(*) FROM integration_schema.partner_shipment_refs x WHERE x.is_deleted = false
            AND NOT EXISTS (SELECT 1 FROM integration_schema.partners p WHERE p.id = x.partner_id AND p.is_deleted = false)) AS refs_without_partner,
        CASE WHEN to_regclass('order_schema.orders') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM order_schema.orders o
           WHERE o.is_deleted = false AND o.operator LIKE 'external\_%'
             AND NOT EXISTS (SELECT 1 FROM integration_schema.external_integrations e
                              WHERE e.is_deleted = false AND 'external_' || e.slug = o.operator)
        $s$, false, true, '')))[1]::text::bigint END AS orders_without_connection,
        CASE WHEN to_regclass('order_schema.orders') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM order_schema.orders o
           WHERE o.is_deleted = false AND o.source::text = 'external' AND o.external_id IS NOT NULL
             AND coalesce(o.operator, '') NOT LIKE 'external\_%'
             AND o.external_id NOT LIKE 'SEED-%'
             AND NOT EXISTS (SELECT 1 FROM integration_schema.partner_shipment_refs x WHERE x.is_deleted = false AND x.order_id = o.id)
        $s$, false, true, '')))[1]::text::bigint END AS partner_orders_without_ref
    )
    SELECT CASE WHEN refs_without_partner + coalesce(orders_without_connection, 0) + coalesce(partner_orders_without_ref, 0) > 0
                THEN 'WARN' ELSE 'OK' END AS holat,
           'faol ulanish=' || ei_active || '; faol hamkor=' || partners_active || '; faol carrier=' || carriers_active
           || '; hamkor market bog''lanishi=' || market_refs
           || '; yetim: hamkorsiz ref=' || refs_without_partner
           || ', ulanishsiz external_ buyurtma=' || coalesce(orders_without_connection::text, 'n/a')
           || ', ref''siz hamkor buyurtmasi=' || coalesce(partner_orders_without_ref::text, 'n/a') AS tafsilot,
           CASE WHEN refs_without_partner + coalesce(orders_without_connection, 0) + coalesce(partner_orders_without_ref, 0) > 0
                THEN 'Jonli buyurtmalar/ref''lar o''chgan ulanish yoki hamkorga ishora qiladi: haqiqiy ulanish ma''lumoti yo''qolgan. Seed yo''q, avtomatik tiklab bo''lmaydi: integration_schema ni tozalashdan oldingi backup''dan tiklang (id va slug mos bo''lishi kerak) yoki admin UI''da qayta yaratib, hamkorlarga yangi kalit bersin.' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 27 — AI sxemasi: maslahatchi/runtime sozlamalari, xarajat hisoblagichi, UI kalitlari, ruxsatlar
-- -----------------------------------------------------------------------------
\echo '--- 27'
SELECT '27' AS n, 'yo''q' AS daraja,
       'AI sozlamalari: seed yo''q, hammasi kod sukuti yoki upsert; faqat UI kaliti tarixi o''chganini tekshiradi' AS tekshiruv,
       'ai_schema.ai_provider_keys, ai_runtime_settings, ai_advisor_settings, ai_spend_counter, ai_advisor_rule_state, ai_assistant_access' AS jadval,
       v.holat, v.tafsilot, v.nima_qilish
FROM (
  SELECT CASE WHEN NOT (t.pk OR t.rt OR t.adv OR t.sc OR t.rs OR t.aa) THEN 'NO_TABLE'
              WHEN t.pk AND c.keys_total = 0 AND (coalesce(c.keys_version, 0) > 1 OR coalesce(c.ui_usage, 0) > 0) THEN 'MISSING'
              ELSE 'OK' END AS holat,
         concat_ws('; ',
           'ai_provider_keys=' || CASE WHEN t.pk THEN c.keys_total || ' qator (faol ' || c.keys_active || ')' ELSE 'jadval yo''q (228 prod''da hali yo''q — normal)' END,
           'runtime keys.version=' || CASE WHEN t.rt THEN coalesce(c.keys_version::text, 'qator yo''q (=1)') ELSE 'jadval yo''q' END,
           'UI kaliti bilan chaqiruvlar=' || coalesce(c.ui_usage::text, 'n/a'),
           'maslahatchi rules qatori=' || CASE WHEN t.adv THEN c.adv_rules::text ELSE 'jadval yo''q' END || ' (0 = kod sukuti)',
           'spend_counter=' || CASE WHEN t.sc THEN c.spend_rows::text ELSE 'jadval yo''q' END,
           'rule_state=' || CASE WHEN t.rs THEN c.rule_states::text ELSE 'jadval yo''q' END,
           'yordamchi ruxsatlari (enabled)=' || CASE WHEN t.aa THEN c.assistant_grants::text ELSE 'jadval yo''q' END) AS tafsilot,
         CASE WHEN NOT (t.pk OR t.rt OR t.adv OR t.sc OR t.rs OR t.aa) THEN 'ai_schema jadvallari yo''q: AI migratsiyalari yurmagan.'
              WHEN t.pk AND c.keys_total = 0 AND (coalesce(c.keys_version, 0) > 1 OR coalesce(c.ui_usage, 0) > 0)
              THEN 'UI''dan qo''shilgan Anthropic kaliti tarixi o''chgan: AI_CONFIG_UI_ENABLED=true va env kaliti yo''q bo''lsa AI o''chiq. Superadmin «AI kalit va modellar» ekranida kalitni qayta qo''shsin (PUT /ai/config/key) yoki AI_CONFIG_UI_ENABLED=false qoldirib env ANTHROPIC_API_KEY ishlatilsin. Migratsiya bilan tiklab bo''lmaydi (maxfiy).'
              ELSE 'Hech narsa qilish shart emas. Maslahatchi chegaralari avval sozlangan bo''lsa — superadmin AI maslahatchi sozlamalarida qayta kiritsin.' END AS nima_qilish
  FROM (SELECT to_regclass('ai_schema.ai_provider_keys') IS NOT NULL AS pk,
               to_regclass('ai_schema.ai_runtime_settings') IS NOT NULL AS rt,
               to_regclass('ai_schema.ai_advisor_settings') IS NOT NULL AS adv,
               to_regclass('ai_schema.ai_spend_counter') IS NOT NULL AS sc,
               to_regclass('ai_schema.ai_advisor_rule_state') IS NOT NULL AS rs,
               to_regclass('ai_schema.ai_assistant_access') IS NOT NULL AS aa,
               to_regclass('ai_schema.ai_usage_log') IS NOT NULL AS ul) t
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN t.pk THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM ai_schema.ai_provider_keys$q$, false, true, '')))[1]::text::bigint END AS keys_total,
      CASE WHEN t.pk THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM ai_schema.ai_provider_keys
                                WHERE provider = 'anthropic' AND status = 'active' AND is_deleted = false$q$, false, true, '')))[1]::text::bigint END AS keys_active,
      CASE WHEN t.rt THEN (xpath('/row/n/text()', query_to_xml($q$SELECT max(version) AS n FROM ai_schema.ai_runtime_settings WHERE key = 'keys'$q$, false, true, '')))[1]::text::bigint END AS keys_version,
      CASE WHEN t.pk AND t.ul THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM ai_schema.ai_usage_log WHERE key_source = 'ui'$q$, false, true, '')))[1]::text::bigint END AS ui_usage,
      CASE WHEN t.adv THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM ai_schema.ai_advisor_settings WHERE key = 'rules' AND is_deleted = false$q$, false, true, '')))[1]::text::bigint END AS adv_rules,
      CASE WHEN t.sc THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM ai_schema.ai_spend_counter$q$, false, true, '')))[1]::text::bigint END AS spend_rows,
      CASE WHEN t.rs THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM ai_schema.ai_advisor_rule_state$q$, false, true, '')))[1]::text::bigint END AS rule_states,
      CASE WHEN t.aa THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM ai_schema.ai_assistant_access WHERE enabled AND is_deleted = false$q$, false, true, '')))[1]::text::bigint END AS assistant_grants
  ) c
) v;

-- -----------------------------------------------------------------------------
-- 28 — ombor qoldiqlari (seed yo'q): yetim bron va jurnal bo'yicha yo'qolgan qatorlar
-- -----------------------------------------------------------------------------
\echo '--- 28'
SELECT '28' AS n, 'yo''q' AS daraja,
       'Ombor qoldiqlari: seed yo''q; yetim bron (outbox tiqiladi) va jurnalga ko''ra yo''qolgan qatorlar' AS tekshiruv,
       'catalog_schema.warehouse_stock' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas (bo''sh jadval to''g''ri: buyurtmalar HQ orqali ketadi).'
         ELSE 'Jadval yo''q (migratsiya 143).' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'catalog_schema.warehouse_stock jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('catalog_schema.warehouse_stock') IS NOT NULL THEN query_to_xml($q$
    WITH s AS (
      SELECT (SELECT count(*) FROM catalog_schema.warehouse_stock) AS stock_rows,
        CASE WHEN to_regclass('catalog_schema.warehouses') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM catalog_schema.warehouses WHERE is_deleted = false
        $s$, false, true, '')))[1]::text::bigint END AS warehouses,
        CASE WHEN to_regclass('catalog_schema.stock_reservations') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM catalog_schema.stock_reservations r
           WHERE r.status = 'RESERVED' AND NOT EXISTS (SELECT 1 FROM catalog_schema.warehouse_stock s
                 WHERE s.warehouse_id = r.warehouse_id AND s.product_id = r.product_id)
        $s$, false, true, '')))[1]::text::bigint END AS orphan_reserved,
        CASE WHEN to_regclass('catalog_schema.stock_movements') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM (
            SELECT DISTINCT ON (m.warehouse_id, m.product_id) m.warehouse_id, m.product_id, m.on_hand_after
              FROM catalog_schema.stock_movements m
             ORDER BY m.warehouse_id, m.product_id, m.id DESC) last
           WHERE last.on_hand_after > 0 AND NOT EXISTS (SELECT 1 FROM catalog_schema.warehouse_stock s
                 WHERE s.warehouse_id = last.warehouse_id AND s.product_id = last.product_id)
        $s$, false, true, '')))[1]::text::bigint END AS lost_rows
    )
    SELECT CASE WHEN coalesce(orphan_reserved, 0) > 0 OR coalesce(lost_rows, 0) > 0 THEN 'WARN' ELSE 'OK' END AS holat,
           'qoldiq qatorlari=' || stock_rows || '; faol omborlar=' || coalesce(warehouses::text, 'n/a')
           || '; qatori yo''q RESERVED bron=' || coalesce(orphan_reserved::text, 'n/a')
           || '; jurnalda qoldiq bor, qatori yo''q=' || coalesce(lost_rows::text, 'n/a') AS tafsilot,
           CASE WHEN coalesce(orphan_reserved, 0) > 0 OR coalesce(lost_rows, 0) > 0
                THEN 'Qisman tozalash: catalog.warehouse.out/release outbox''i tiqilishi mumkin. Avtomatik emas: jurnaldan (stock_movements) ko''rib chiqilgan bir martalik tiklash (hujjatdagi 28-band), keyin ombor xodimlari inventarizatsiya qilsin.' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 29 — pochtalar (seed yo'q, talab bo'yicha yaratiladi): mavjud bo'lmagan pochtaga ishora
-- -----------------------------------------------------------------------------
\echo '--- 29'
SELECT '29' AS n, 'yo''q' AS daraja,
       'Pochtalar: seed yo''q (o''zi yaratiladi); mavjud bo''lmagan pochtaga ishora qiluvchi buyurtmalar' AS tekshiruv,
       'logistics_schema.posts' AS jadval,
       coalesce(r.holat, 'XATO') AS holat, r.tafsilot,
       coalesce(r.nima, CASE r.holat
         WHEN 'OK' THEN 'Hech narsa qilish shart emas.'
         ELSE 'Jadval yo''q (baseline).' END) AS nima_qilish
FROM (
  SELECT CASE WHEN g.x IS NULL THEN 'NO_TABLE' ELSE (xpath('/row/holat/text()', g.x))[1]::text END AS holat,
         CASE WHEN g.x IS NULL THEN 'logistics_schema.posts jadvali yo''q' ELSE (xpath('/row/tafsilot/text()', g.x))[1]::text END AS tafsilot,
         (xpath('/row/nima/text()', g.x))[1]::text AS nima
  FROM (SELECT CASE WHEN to_regclass('logistics_schema.posts') IS NOT NULL THEN query_to_xml($q$
    WITH s AS (
      SELECT (SELECT count(*) FROM logistics_schema.posts) AS posts_total,
             (SELECT count(*) FROM logistics_schema.posts WHERE status::text = 'new' AND NOT is_deleted) AS new_posts,
             (SELECT count(*) FROM (SELECT region_id FROM logistics_schema.posts
                                     WHERE status::text = 'new' AND branch_id IS NULL AND NOT is_deleted
                                     GROUP BY region_id HAVING count(*) > 1) d) AS dup_new_hq,
        CASE WHEN to_regclass('order_schema.orders') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM order_schema.orders o
           WHERE NOT o.is_deleted AND o.post_id IS NOT NULL AND o.status::text = 'received'
             AND NOT EXISTS (SELECT 1 FROM logistics_schema.posts p WHERE p.id = o.post_id)
        $s$, false, true, '')))[1]::text::bigint END AS orphan_received,
        CASE WHEN to_regclass('order_schema.orders') IS NULL THEN NULL ELSE (xpath('/row/n/text()', query_to_xml($s$
          SELECT count(*) AS n FROM order_schema.orders o
           WHERE NOT o.is_deleted AND o.post_id IS NOT NULL AND o.status::text <> 'received'
             AND NOT EXISTS (SELECT 1 FROM logistics_schema.posts p WHERE p.id = o.post_id)
        $s$, false, true, '')))[1]::text::bigint END AS orphan_other
    )
    SELECT CASE WHEN coalesce(orphan_other, 0) > 0 OR dup_new_hq > 0 THEN 'WARN' ELSE 'OK' END AS holat,
           'pochtalar=' || posts_total || '; yangi (new)=' || new_posts || '; bir viloyatda bir nechta yangi HQ pochta=' || dup_new_hq
           || '; o''chgan pochtadagi buyurtma: received=' || coalesce(orphan_received::text, 'n/a')
           || ' (keyingi GET /post/new da o''zi ko''chadi), boshqa holat=' || coalesce(orphan_other::text, 'n/a') AS tafsilot,
           CASE WHEN coalesce(orphan_other, 0) > 0
                THEN 'Yo''lda/kutishda/bekordagi buyurtmalarning pochtasi o''chgan — biznes tarixi yo''qolgan, seed bilan tiklanmaydi. Ma''lumotni tuzatish ishi sifatida qo''lda ko''rib chiqing.'
                WHEN dup_new_hq > 0 THEN 'Dublikat yangi HQ pochtalar: collapseDuplicateNewPosts birlashtiradi, qo''lda tekshiring.' END AS nima
      FROM s
  $q$, false, true, '') END AS x) g
) r;

-- -----------------------------------------------------------------------------
-- 30 — seed'siz kichik jadvallar (filial sozlamasi, fayl reestri, maosh, bildirishnoma
--      shablonlari, kassa cheklari): faqat sonlar; bo'sh = normal
-- -----------------------------------------------------------------------------
\echo '--- 30'
SELECT '30' AS n, 'yo''q' AS daraja,
       'Seed''siz kichik jadvallar: bo''sh bo''lishi normal; chek valyuta tuzatishi kutilyaptimi' AS tekshiruv,
       'branch_configs, file_objects, user_salaries, notification_templates, cashbox_receipts' AS jadval,
       v.holat, v.tafsilot, v.nima_qilish
FROM (
  SELECT CASE WHEN NOT (t.bc OR t.fo OR t.us OR t.nt OR t.cr) THEN 'NO_TABLE'
              WHEN coalesce(c.fx_pending, 0) > 0 THEN 'WARN'
              ELSE 'OK' END AS holat,
         concat_ws('; ',
           'branch_configs=' || coalesce(c.bc_n::text, 'jadval yo''q'),
           'file_objects=' || coalesce(c.fo_n::text, 'JADVAL YO''Q (FILE_OWNERSHIP_ENFORCE=on bo''lsa dalil fayllari 503)'),
           'user_salaries=' || coalesce(c.us_n::text, 'jadval yo''q'),
           'notification_templates (faol)=' || coalesce(c.nt_n::text, 'jadval yo''q'),
           'cashbox_receipts=' || coalesce(c.cr_n::text, 'jadval yo''q'),
           'valyuta tuzatishi kutayotgan chek=' || coalesce(c.fx_pending::text, 'n/a')) AS tafsilot,
         CASE WHEN NOT (t.bc OR t.fo OR t.us OR t.nt OR t.cr) THEN 'Jadvallar yo''q: migratsiyalar yurmagan.'
              WHEN coalesce(c.fx_pending, 0) > 0
              THEN 'Valyutasi UZS bo''lmagan eski «mismatch» cheklar: scripts/finance/fix-receipt-foreign-currency.sql ni bir marta qo''lda yurgizing (RETURNING natijasini saqlang).'
              ELSE 'Hech narsa qilish shart emas: bu jadvallarda seed yo''q, qatorlar foydalanuvchi amallaridan keladi.' END AS nima_qilish
  FROM (SELECT to_regclass('branch_schema.branch_configs') IS NOT NULL AS bc,
               to_regclass('file_schema.file_objects') IS NOT NULL AS fo,
               to_regclass('finance_schema.user_salaries') IS NOT NULL AS us,
               to_regclass('notification_schema.notification_templates') IS NOT NULL AS nt,
               to_regclass('finance_schema.cashbox_receipts') IS NOT NULL AS cr) t
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN t.bc THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM branch_schema.branch_configs WHERE is_deleted = false$q$, false, true, '')))[1]::text::bigint END AS bc_n,
      CASE WHEN t.fo THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM file_schema.file_objects$q$, false, true, '')))[1]::text::bigint END AS fo_n,
      CASE WHEN t.us THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM finance_schema.user_salaries WHERE is_deleted = false$q$, false, true, '')))[1]::text::bigint END AS us_n,
      CASE WHEN t.nt THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM notification_schema.notification_templates WHERE is_active AND is_deleted = false$q$, false, true, '')))[1]::text::bigint END AS nt_n,
      CASE WHEN t.cr THEN (xpath('/row/n/text()', query_to_xml($q$SELECT count(*) AS n FROM finance_schema.cashbox_receipts WHERE is_deleted = false$q$, false, true, '')))[1]::text::bigint END AS cr_n,
      CASE WHEN t.cr THEN (xpath('/row/n/text()', query_to_xml($q$
        SELECT count(*) AS n FROM finance_schema.cashbox_receipts r
         WHERE r.ai_currency IS NOT NULL AND btrim(r.ai_currency) <> ''
           AND upper(btrim(r.ai_currency)) NOT IN ('UZS', 'UZB', 'SUM', 'SOM', 'SO''M', 'СУМ', 'СЎМ')
           AND r.ai_status = 'mismatch'
           AND (r.ai_difference IS NOT NULL OR r.ai_error_reason IS DISTINCT FROM 'currency_not_uzs')
      $q$, false, true, '')))[1]::text::bigint END AS fx_pending
  ) c
) v;

-- -----------------------------------------------------------------------------
-- 31 — eski skript scripts/migration-soft-delete.sql qo'llanmaganmi (is_deleted ustuni nomi)
-- -----------------------------------------------------------------------------
\echo '--- 31'
SELECT '31' AS n, 'yo''q' AS daraja,
       'Soft-delete ustuni nomi: admins/orders da is_deleted (eski migration-soft-delete.sql qo''llanmagan)' AS tekshiruv,
       'identity_schema.admins, order_schema.orders' AS jadval,
       CASE WHEN to_regclass('identity_schema.admins') IS NULL OR to_regclass('order_schema.orders') IS NULL THEN 'NO_TABLE'
            WHEN c.admins_legacy OR c.orders_legacy OR NOT c.admins_ok OR NOT c.orders_ok THEN 'MISSING'
            ELSE 'OK' END AS holat,
       'admins.is_deleted=' || c.admins_ok || ', admins."isDeleted"=' || c.admins_legacy
       || '; orders.is_deleted=' || c.orders_ok || ', orders eski deleted/"isDeleted"=' || c.orders_legacy AS tafsilot,
       CASE WHEN to_regclass('identity_schema.admins') IS NULL OR to_regclass('order_schema.orders') IS NULL THEN 'Jadval yo''q.'
            WHEN c.admins_legacy OR c.orders_legacy OR NOT c.admins_ok OR NOT c.orders_ok
            THEN 'Ustun nomi kod bilan mos emas: foydalanuvchi/buyurtma so''rovlari 42703 bilan yiqiladi. Ustunni is_deleted ga qaytaring (ega roziligi bilan). scripts/migration-soft-delete.sql ni HECH QACHON yurgizmang.'
            ELSE 'Hech narsa qilish shart emas. scripts/migration-soft-delete.sql eskirgan — uni prod''da yurgizmang.' END AS nima_qilish
FROM (
  SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'identity_schema' AND table_name = 'admins' AND column_name = 'is_deleted') AS admins_ok,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'identity_schema' AND table_name = 'admins' AND column_name = 'isDeleted') AS admins_legacy,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'order_schema' AND table_name = 'orders' AND column_name = 'is_deleted') AS orders_ok,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'order_schema' AND table_name = 'orders' AND column_name IN ('isDeleted', 'deleted')) AS orders_legacy
) c;

ROLLBACK;

\x off
\echo ''
\echo '=== Tugadi. Hech narsa o''zgartirilmadi (ROLLBACK). ==='
\echo 'MISSING / WARN / NO_TABLE qatorlarining nima_qilish ustuniga qarang.'
\echo 'Batafsil: docs/ops/SEED_GAP_AUDIT_2026-11-17.md. Faylni to''liq (ERROR qatorlari bilan) yuboring.'
