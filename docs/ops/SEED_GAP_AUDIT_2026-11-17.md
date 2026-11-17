# Seed-gap auditi — 2026-11-17

Prod bazasi tozalangandan keyin qaysi majburiy (seed / ma'lumotnoma) qatorlar qaytib kelmagan bo'lishi
mumkinligi, nima buzilishi va nima qilish kerakligi. Tekshiruv skripti:
[`scripts/ops/seed-gap-report.sql`](../../scripts/ops/seed-gap-report.sql) (faqat o'qiydi).

## Nima bo'ldi

2026-11-11..14 da prod bazasi tozalandi (biznes va test ma'lumoti o'chirildi). `order_schema.migrations`
jadvali esa barcha migratsiyalarni «bajarilgan» deb biladi. Shuning uchun migratsiya yozgan seed qatorlar
qaytib kelmaydi, servis ishga tushishida yaratiladiganlari esa faqat servis qayta ishga tushganda qaytadi.

Ikki holat allaqachon tasdiqlangan va tuzatilgan:

| Jadval | Belgi | Tuzatish |
|---|---|---|
| `finance_schema.cashbox_expense_categories` | «xarajat kategoriyasi chiqmayapti» | migratsiya `1716000000230-RestoreDefaultExpenseCategories` (dev va main'da) |
| `logistics_schema.delivery_pricing_settings` | «Hisob qoidalarini yuklab bo'lmadi … migratsiya 1716000000142 yurgizilmagan?» | migratsiya `1716000000231-RestoreDeliveryPricingSettings` (PR #692, dev'da; **main'ga hali chiqmagan**) |

Foydalanuvchilar, viloyat/tumanlar va tariflar prod'da hozir bor (qayta yaratilgan yoki saqlanib qolgan).
Qaysi jadvallar aniq tozalanganini bilmaymiz. Shuning uchun kodni (origin/dev) to'liq ko'rib chiqdik va
prod'da bir martada yuradigan hisobot tayyorladik.

## Qisqa xulosa

**Yangi restore migratsiya kerak** (kritik yoki yuqori; o'zi tiklanmaydi; UI'dan tuzatib bo'lmaydi; 230/231
qoplamaydi):

1. `logistics_schema.regions.is_city_zone` — Toshkent shahri (SOATO 1726). Xato chiqmaydi, lekin Toshkent
   ichidagi narx jimgina noto'g'ri (hisobotda 07).
2. `branch_schema.branches` — HQ qatorining `region_id`. Bo'sh bo'lsa HQ kuryeriga biriktirish va skan
   400 beradi, Toshkent buyurtmalari to'xtaydi (04).
3. `finance_schema.cashboxes` — kuryer (`couriers`) va market (`markets`) kassalari. Yo'q bo'lsa sotish,
   rollback va to'lovlar 404 beradi (05).

**Darhol:** 231 ni main'ga chiqarish (03).

**Hisobot natijasiga qarab** (MISSING chiqsa — qo'lda yoki alohida PR): 01 (migratsiyalar hisobi — bo'sh
bo'lsa deploy'ni to'xtatish kerak), 09 (yetim viloyat/tuman id'lari), 12 (Telegram guruhlari), 13 (pochta
tarixi), 14 (qidiruv indeksi), 15 (env'dagi id'lar).

Qolganlari o'zi tiklanadi (servis qayta ishga tushganda yoki birinchi ochilishda), UI'dan tuzatiladi yoki
umuman seed emas.

Migratsiyalar idempotent va himoyali (to_regclass, «hech qanday seed belgisi yo'q bo'lsa»), shuning uchun
OK holatda ham zarar qilmaydi. Lekin avval hisobot natijasini ko'ramiz, keyin PR'larni ochamiz.

## Hisobotni ishga tushirish

Skript faqat `SELECT` qiladi, hammasi `BEGIN READ ONLY … ROLLBACK` ichida. `statement_timeout = 120 s`,
`lock_timeout = 5 s`. Jadval yo'q bo'lsa xato emas, `NO_TABLE` chiqadi. Bitta tekshiruv xato bersa ham
qolganlari yuradi (`ON_ERROR_ROLLBACK on`). Odatda bir soniyadan kam vaqt oladi.

Prod serverda, repo ildizida (`<user>` va `<db>` — `.env.production` dagi `POSTGRES_USER` va `POSTGRES_DB`):

```bash
docker exec -i elchi-postgres psql -X -U <user> -d <db> -f - \
  < scripts/ops/seed-gap-report.sql > seed-gap-report.txt 2>&1
```

PR hali merge bo'lmagan bo'lsa, faylni branch'dan to'g'ridan-to'g'ri olish mumkin:

```bash
git fetch origin chore/seed-gap-report
git show FETCH_HEAD:scripts/ops/seed-gap-report.sql \
  | docker exec -i elchi-postgres psql -X -U <user> -d <db> -f - > seed-gap-report.txt 2>&1
```

`-v ON_ERROR_STOP=1` **bermang**: bitta tekshiruv xatosi qolganlarini to'xtatib qo'yadi.

Lokal tekshiruv (2026-11-17, PostgreSQL 15): bo'sh bazada 32/32 `NO_TABLE`, xatosiz
(`-v ON_ERROR_STOP=1` bilan); 227 migratsiyasi yurgan yangi bazada migratsiya seed'lari `OK`, runtime
qatorlar (HQ, viloyatlar, superadmin, MAIN kassa) `MISSING`; tozalangandan keyingi holatni taqlid qiluvchi
fixture'da barcha MISSING/WARN tarmoqlari; main sxemasiga o'xshash variant (227/228 ustun va jadvallarisiz)
va lokal dev bazasi (haqiqiy ma'lumot) — xatosiz.

## Nimani qaytarish kerak

1. `seed-gap-report.txt` ni **to'liq** (ERROR qatorlari bo'lsa, ular ham). Shaxsiy ma'lumot yo'q: faqat
   sonlar, id'lar, kodlar va sozlama kalitlari.
2. 15-band WARN bo'lsa: `.env.production` dagi `SALE_PRICING_ENGINE`, `SALE_PRICING_ENGINE_MARKET_IDS`,
   `SMS_ALERT_RECIPIENT_IDS`, `AI_CONFIG_WRITER_IDS`, `AI_CONFIG_UI_ENABLED`, `SMS_ENABLED` qiymatlari
   (bular sir emas; parol va kalitlarni yubormang).
3. Egadan javoblar:
   - SMS prod'da yoqilganmi (11)?
   - Market Telegram guruhlari tozalashdan oldin ulanganmi (12)?
   - «Kun tartibi»da chegara (masalan 10:00 / 16:00) sozlanganmi (21)? Smena/chek sozlamalari
     o'zgartirilganmi (23)?
   - Tozalashdan oldingi backup bormi (`backups/pre-deploy`, `backups/daily`)? 09 va 01 uchun kerak.

## `holat` qiymatlari

| holat | Ma'nosi |
|---|---|
| `OK` | Joyida, yoki qator yo'qligi zararsiz (kod o'z sukutini oladi) |
| `MISSING` | Kerakli qator yo'q yoki noto'g'ri — nimadir buziladi. `nima_qilish` ustuniga qarang |
| `NO_TABLE` | Jadvalning o'zi yo'q (migratsiya yurmagan yoki sxema o'chgan) |
| `WARN` | Qatorlar bor, lekin nomuvofiqlik (dublikat, yetim id, eskirgan nusxa) — qo'lda ko'rib chiqish |

## Audit jadvali

«O'zi tiklanadi» — servis qayta ishga tushganda yoki birinchi foydalanishda kod qatorni yaratadimi.
«UI» — ilova ekranidan tuzatib bo'ladimi. «Tiklash» — 230/231 yoki boshqa narsa qoplaydimi.

| № | Jadval | Daraja | Belgi (nima buziladi) | O'zi tiklanadi | UI | Tiklash | Tavsiya |
|---|---|---|---|---|---|---|---|
| 00 | 13 servis sxemasi | yo'q | Tozalash sxemaga tegmaydi; sxema o'chsa shu servisning hamma so'rovi 500 | ha (db-prepare `CREATE SCHEMA IF NOT EXISTS`) | yo'q | kerak emas | MISSING bo'lsa — bu DROP SCHEMA, dump'dan tiklash |
| 01 | `order_schema.migrations` | **kritik** | Hozir hech narsa. Bo'sh yoki teshik bo'lsa keyingi migratsiyali deploy 227 migratsiyani jonli sxemada qayta yurgizadi: HYBRID filiallar jimgina PICKUP, menejer kassalari qayta ko'chiriladi, 068 da yiqiladi, rollback bazani qaytarmaydi | yo'q | yo'q | yo'q (migratsiya o'z hisobini tiklay olmaydi) | MISSING: deploy'ni to'xtatib, bookkeeping qatorlarini backup'dan tiklash. Alohida PR: `db-prepare.ts` «jadvallar bor, migrations bo'sh» holatini rad etsin |
| 02 | `finance_schema.cashbox_expense_categories` | **kritik** | «Kassadan xarajat»da kategoriya ro'yxati bo'sh, chiqim saqlanmaydi (400 «Xarajat kategoriyasini tanlang») | yo'q | qisman (superadmin qo'lda qo'shadi, `ledger_category` bo'sh) | **230** (dev+main) | 230 yurganini tekshirish. Qayta tozalansa 230 qayta yurmaydi — qayta yuriladigan restore kerak bo'ladi |
| 03 | `logistics_schema.delivery_pricing_settings` | **kritik** | «Hisob qoidalari» 409; narx kalkulyatori, mahsulot/buyurtma «Taxminiy narx», pickup tashrifi va sayt tariflari 409 | yo'q | yo'q (PATCH ham 409) | **231** (PR #692, dev'da, main'da yo'q) | 231 ni main'ga chiqarish; keyin admin «Hisob qoidalari» qiymatlarini ko'rib chiqadi |
| 04 | `branch_schema.branches` (HQ qatori, `region_id`) | **kritik** | HQ kuryeriga biriktirish va skan 400 «HQ filialiga viloyat biriktirilmagan»; qator butunlay yo'q bo'lsa filialsiz buyurtma 500, kuryer yaratish 404, pochta jo'natish 400. O'chirilgan qator `HQ-TSHKNT` kodini band qilsa branch-service ishga tushmaydi | qator: ha (`ensureHqBranch`, lekin viloyatsiz); `region_id`: **yo'q** | yo'q (tahrir oynasida viloyat yo'q) | qoplanmagan | **Yangi migratsiya** `RestoreHqBranchRegion` + `ensureHqBranch` NULL viloyatni to'ldirsin |
| 05 | `finance_schema.cashboxes` (`couriers`, `markets`) | **kritik** | Sotish, qisman sotish, rollback, xarajatli bekor, qo'shimcha xarajat tasdig'i, kuryerdan pul qabul, marketga to'lov, pickup tashrifi 404 «Market/Kuryer kassasi topilmadi» | qisman (faqat egasi o'z kassa sahifasini ochganda) | yo'q (faqat Swagger `POST /finance/cashbox`) | qoplanmagan | **Yangi migratsiya** `RestoreUserCashboxes` (0 qoldiq) + order-service kassani o'zi yaratsin |
| 06 | `logistics_schema.regions` (14 seed, `logist_id`) | yuqori | Bo'sh bo'lsa viloyat ro'yxatlari bo'sh, kalkulyator 400. Qayta yaratilganda `logist_id` yo'q — logist hech narsa ko'rmaydi | qatorlar: ha (logistics-service `onModuleInit`); `logist_id`: yo'q | logist: ha (`/regions/logist-assignment`) | kerak emas | logistics-service ni qayta ishga tushirish; logistlarni qayta biriktirish |
| 07 | `logistics_schema.regions.is_city_zone` | **yuqori** | Xato yo'q, narx jimgina noto'g'ri: Toshkent ichida «city» (35 000) o'rniga center/address (40 000 / 60 000). Sayt kalkulyatori, `POST /delivery/quote`, `/partner/tariff`, `SALE_PRICING_ENGINE=on` bo'lsa sotuv | **yo'q** (faqat migratsiya 142 yozgan) | yo'q (DTO'da maydon yo'q) | qoplanmagan | **Yangi migratsiya** `RestoreTashkentCityZone` + seed'ga flag (faqat yaratishda) |
| 08 | `logistics_schema.districts` (206 seed) | yuqori | Bo'sh bo'lsa buyurtma yaratish 400 «Tuman bo'yicha viloyat aniqlanmadi», foydalanuvchi tahriri 400 «Tuman topilmadi», tashqi import 404 | ha (`onModuleInit`) | ha (`POST /district`) | kerak emas | Servisni qayta ishga tushirish; viloyatlararo biriktirishlarni `/regions/districts` da qayta qilish |
| 09 | yetim `region_id` / `district_id` (filial, foydalanuvchi, `courier_regions`, buyurtma, pochta) | yuqori | Viloyat/tuman qayta yaratilsa id'lar yangi: buyurtmalar filialga tushmaydi, HQ kuryeri 403, kuryer viloyati yo'qoladi | yo'q | qisman (har yozuvni tahrirda qayta tanlash) | qoplanmagan | Avtomatik emas: backup'dan eski id → SOATO → yangi id xaritasi, ko'rib chiqilgan bir martalik skript |
| 10 | `logistics_schema.delivery_tariffs` | o'rta | Tarif yo'q bo'lsa jadvalda «—», `POST /delivery/quote` 409, sayt kalkulyatori 409; buyurtma va sotish to'xtamaydi | yo'q | ha (`/delivery-tariffs`) | kerak emas (231 ataylab tegmaydi; adminlar 15.11/17.11 da qayta kiritgan) | Admin kiritadi, narxni ega tasdiqlaydi |
| 11 | `notification_schema.sms_provider_accounts` (+ `sms_templates`) | o'rta | Vaqtinchalik parol SMS'i ketmaydi (`password_sms` failed «SMS provayder sozlanmagan»), OTP kelmaydi, kampaniya SMS'lari yiqiladi | yo'q | ha (`/notifications/sms` → «Sozlamalar») | kerak emas (maxfiy, migratsiyaga yozilmaydi) | SMS ishlatilgan bo'lsa superadmin akkauntni qayta kiritadi. `sms_templates` yo'qligi zararsiz (kod bir xil matn) |
| 12 | `notification_schema.telegram_markets`, `telegram_chats` (+ `telegram_blocked_chats`) | o'rta | Market guruhlariga yangi buyurtma, bekor va smena xabarlari kelmaydi (xato chiqmaydi). Faqat `telegram_markets` TRUNCATE qilinsa — kartalar uzilgan guruhga ketaveradi (PII) | yo'q (`telegram_blocked_chats` o'zi to'ladi) | ha (bir martalik havola bilan qayta ulash) | qoplanmagan | Market/admin qayta ulaydi; yetim oyna bo'lsa ega roziligi bilan bir martalik tuzatish (pastda) |
| 13 | `order_schema.post_order_memberships` | o'rta | Qabul qilingan eski pochtada (`/mails/:id`, Excel, chek) chiqib ketgan buyurtmalar ko'rinmaydi, ba'zi menejerga 403. Jadval yo'q, trigger bor bo'lsa pochtaga qo'shish 42P01 bilan yiqiladi | yo'q | yo'q | qoplanmagan | MISSING: ochiq qatorlarni qayta seed (pastda), keyin backfill skripti |
| 14 | `search_schema.search_documents` | o'rta | Ctrl K global qidiruv «Natija topilmadi» (bo'lim ro'yxatlaridagi qidiruv ishlaydi) | faqat obyekt qayta saqlanganda | yo'q (ommaviy yo'l yo'q) | qoplanmagan | Servislar bo'yicha qayta indekslash vositasi (alohida PR), migratsiya emas |
| 15 | `.env.production` dagi foydalanuvchi id'lari | o'rta | Jim: narx dvigateli begona marketda yoqiladi yoki hech qayerda; AI kalitini egasi yoza olmaydi; SMS ogohlantirish begonaga | yo'q | yo'q (env) | qoplanmagan | Id'larni solishtirib env'ni yangilash, servislarni qayta yaratish |
| 16 | `identity_schema.admins` (superadmin) | past | Superadmin kira olmaydi (401), superadmin amallari ishlamaydi | ha (identity-service `onModuleInit`, `SUPERADMIN_*`) | yo'q | kerak emas | Qayta ishga tushirish; nofaol bo'lsa qo'lda faollashtirish |
| 17 | `finance_schema.cashboxes` (`branch`) | past | Birinchi teginishgacha HQ «Pul qabul qilish», filial kartalari va menejer chiqimi 404 | ha (sotuv, kuryer to'lovi, «Kassa» sahifasi) | ha (sahifani ochish) | kerak emas (ixtiyoriy migratsiya) | — |
| 18 | `finance_schema.cashbox_cards` («Asosiy karta») | past | Deyarli yo'q. Nomli kartalar yo'qolsa puli «Asosiy karta»da ko'rinadi. Sukut yo'q, lekin «Asosiy karta» nomli oddiy karta bor bo'lsa 500 «Asosiy karta yaratilmadi» | ha | ha | kerak emas | Faqat nom band bo'lsa qo'lda (pastda) |
| 19 | `logistics_schema.district_coverage_exemptions` | past | Qoidadan (2026-11-06) oldingi eski buyurtmalarni HQ kuryeriga berish 403 | yo'q | yo'q | kerak emas (biznes surati, 211 ni qayta yurgizish qoidani kengaytiradi) | MISSING bo'lsa ops roziligi bilan bir martalik INSERT |
| 20 | `finance_schema.finance_daily_snapshots`, `finance_cashbox_daily` | past | Bo'sh bo'lsa ~1-11 daqiqa «Balans dinamikasi» ko'rinmaydi; tarix tozalanib snapshot qolsa — eskirgan qoldiqlar | ha (job tarixdan quradi) | yo'q | kerak emas | WARN bo'lsa ikkala jadvalni birga tozalash (pastda) |
| 21 | `order_schema.order_settings` | past | Xato yo'q; avvalgi yaratish/qabul chegaralari jimgina yo'qolgan | yo'q (bo'sh = cheklovsiz) | ha (`/ops` → «Kun tartibi») | kerak emas | Egadan so'rab qayta kiritish |
| 22 | `finance_schema.cashboxes` (MAIN, `user_id 0`) | yo'q | Qayta ishga tushguncha to'ldirish, chiqim, kartalar 404 | ha (finance-service `onModuleInit`) | ha («Asosiy kassa») | kerak emas | Dublikat bo'lsa qo'lda birlashtirish; partial unique indeks — alohida PR |
| 23 | `finance_schema.finance_settings` | yo'q | Xato yo'q: kod sukuti = 215 seed | — | ha («Smena sozlamalari», «Kun tartibi») | kerak emas | Avvalgi sozlamalar bo'lsa qayta qo'yish |
| 24 | `identity_schema.app_settings` (kontaktlar) | yo'q | Xato yo'q (seed qiymatlari bo'sh edi) | ha (upsert) | yo'q (faqat API) | kerak emas | Yaroqsiz sukut mas'ul bo'lsa `PATCH /settings/contacts` |
| 25 | `order_schema.orders` / `order_items` / `order_settlement` (SEED-, yetim) | yo'q | Xato yo'q. Yetim settlement «Moliyaviy balans»ni soxta oshiradi | — | yo'q | kerak emas | WARN bo'lsa backup va moliya ko'rigidan keyin qo'lda |
| 26 | `integration_schema` (ulanish, hamkor, carrier, ref'lar) | yo'q | Jonli ulanish bo'lgan bo'lsa o'sha kanal to'xtaydi (401 «API kalit yaroqsiz», webhook 401) | yo'q | ha (konsol, yangi kalit) | kerak emas (seed yo'q) | Backup'dan tiklash yoki qayta yaratish |
| 27 | `ai_schema` (provider_keys, runtime/advisor settings, spend_counter, rule_state, assistant_access) | yo'q | Xato yo'q: kod sukuti yoki upsert; UI kaliti yo'qolsa env kalitiga tushadi | ha | ha | kerak emas | — |
| 28 | `catalog_schema.warehouse_stock` | yo'q | Xato yo'q: buyurtmalar HQ orqali ketadi | ha (kirim, inventarizatsiya) | ha | kerak emas | WARN bo'lsa jurnaldan ko'rib chiqilgan tiklash |
| 29 | `logistics_schema.posts` | yo'q | Xato yo'q: pochta talab bo'yicha yaratiladi | ha | ha | kerak emas | — |
| 30 | `branch_configs`, `file_objects`, `user_salaries`, `notification_templates`, `cashbox_receipts` | yo'q | Xato yo'q (seed yo'q). `file_objects` jadvali yo'q va `FILE_OWNERSHIP_ENFORCE=on` bo'lsa dalil fayllari 503 | — | — | kerak emas | Valyuta tuzatishi kutilsa `scripts/finance/fix-receipt-foreign-currency.sql` |
| 31 | `admins` / `orders` `is_deleted` ustuni (eski `scripts/migration-soft-delete.sql`) | yo'q | Xato yo'q. Skriptni hozir yurgizish `admins.is_deleted` ni qayta nomlaydi va kirish 500 bo'ladi | — | — | kerak emas | Skriptni arxivlash yoki «yurgizmang» belgisi |

`telegram_link_tokens` (10 daqiqalik bir martalik kodlar) tekshirilmaydi: bo'sh bo'lishi normal.

## Taklif qilinadigan restore migratsiyalar

Alohida PR'larda (bu PR'da migratsiya yo'q). Raqamlar taxminiy — PR ochilganda bo'sh raqam olinadi.
Har biri `to_regclass` bilan himoyalangan, qayta yurganda hech narsa o'zgartirmaydi, `down()` bo'sh.

### 07 — `1716000000232-RestoreTashkentCityZone`

```sql
-- faqat hech bir viloyat city zone bo'lmasa (UI flag'ni o'chira olmaydi, demak bu egasining qarori emas)
UPDATE logistics_schema.regions
   SET is_city_zone = true, "updatedAt" = now()
 WHERE is_deleted = false
   AND (sato_code = '1726'
        OR (sato_code IS NULL
            AND NOT EXISTS (SELECT 1 FROM logistics_schema.regions x WHERE x.sato_code = '1726')
            AND lower(btrim(name)) IN ('toshkent shahri', 'toshkent sh.', 'toshkent sh')))
   AND NOT EXISTS (SELECT 1 FROM logistics_schema.regions z WHERE z.is_city_zone = true AND z.is_deleted = false);
```

`Toshkent%` prefiksi ishlatilmaydi: prod'dagi Toshkent **viloyati** (1727) qatori «Toshkent» deb nomlangan.
Kodda ham: `regions-districts.data.ts` dagi «Toshkent shahri» ga `is_city_zone: true`, `onModuleInit` faqat
yangi qator yaratishda o'qiydi (mavjud qatorni hech qachon o'zgartirmaydi).

### 04 — `1716000000233-RestoreHqBranchRegion`

```sql
-- 204 ning mantig'i + mavjud bo'lmagan viloyatga ishora; tirik, NULL bo'lmagan viloyatga tegmaydi
UPDATE branch_schema.branches b
   SET region_id = t.id
  FROM (SELECT id FROM logistics_schema.regions
         WHERE sato_code = '1726' AND is_deleted = false ORDER BY id LIMIT 1) t
 WHERE b.type::text = 'HQ' AND b.is_deleted = false
   AND (b.region_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM logistics_schema.regions r WHERE r.id = b.region_id AND r.is_deleted = false));
```

HQ qatorini yaratmaydi va o'chirilganini tiklamaydi (bu `ensureHqBranch` ishi). Kodda: `ensureHqBranch` HQ
yaratganda yoki `region_id IS NULL` topganda `BRANCH_HQ_REGION_SATO` (sukut `1726`) bo'yicha viloyatni
to'ldirsin; o'chirilgan `HQ-TSHKNT` qatori kodni band qilgan bo'lsa yangi INSERT o'rniga uni tiklasin.
HQ qayta yaratilsa order-service, catalog-service va api-gateway ni qayta ishga tushirish kerak (HQ id keshi).

### 05 — `1716000000234-RestoreUserCashboxes`

```sql
LOCK TABLE finance_schema.cashboxes IN SHARE ROW EXCLUSIVE MODE;  -- (user_id, cashbox_type) unique emas
INSERT INTO finance_schema.cashboxes (balance, balance_cash, balance_card, cashbox_type, user_id, is_deleted)
SELECT 0, 0, 0,
       (CASE u.role::text WHEN 'courier' THEN 'couriers' ELSE 'markets' END)::finance_schema.cashboxes_cashbox_type_enum,
       u.id, false
  FROM identity_schema.admins u
 WHERE u.role::text IN ('courier', 'market') AND u.is_deleted = false
   AND NOT EXISTS (SELECT 1 FROM finance_schema.cashboxes c
                    WHERE c.user_id = u.id
                      AND c.cashbox_type::text = CASE u.role::text WHEN 'courier' THEN 'couriers' ELSE 'markets' END);
```

`NOT EXISTS` `is_deleted` ga qaramaydi: qo'lda o'chirilgan kassa qayta tiklanmaydi. Kod kuryer/market
kassasini hech qachon o'chirmaydi, demak tirik kuryer/market kassasiz bo'lsa — bu faqat ma'lumot yo'qolishi.
Qoldiq 0: `cashbox_history` kassa bilan birga (`ON DELETE CASCADE`) o'chgan. Saqlanib qolgan eski sotilgan
buyurtmalar bo'yicha qarzlar qo'lda solishtiriladi. Kodda: order-service `sellOrder`, `partlySellOrder`,
`cancelOrder`, `rollbackOrderToWaiting`, `approveDeferredExtraCost` dan oldin market/kuryer kassasini
`finance.cashbox.create` (idempotent) bilan yaratsin — `ensureBranchCashbox` kabi.

## Qo'lda tuzatishlar (faqat hisobot ko'rsatsa, backup va ega roziligidan keyin)

**01 — migratsiyalar hisobi bo'sh yoki teshik.** Migratsiyali deploy'ni to'xtating. Oxirgi backup'dan
`order_schema.migrations` qatorlarini (`"timestamp"`, `name`) bitta ko'rib chiqilgan tranzaksiyada qaytaring:
faqat sxema obyektlari haqiqatan bor migratsiyalarni, `WHERE NOT EXISTS (… m.name = s.name)` bilan. Seed
qatorlarni qayta yurgizish uchun jadvalni hech qachon bo'shatmang.

**12 — ulanishi yo'q faol `telegram_chats` oynasi (PII xavfi):**

```sql
UPDATE notification_schema.telegram_chats c SET is_active = false, updated_at = now()
 WHERE c.owner_type = 'market' AND c.is_active
   AND NOT EXISTS (SELECT 1 FROM notification_schema.telegram_markets m
                    WHERE m.id = c.source_market_row_id AND NOT m.is_deleted AND m.is_active
                      AND m.group_id = c.chat_id AND m.market_id = c.owner_id);
```

**13 — pochta tarixida ochiq qatorlar yo'q** (201 seed'i bilan bir xil; `seed_current` belgisi backfill
skripti uchun kerak):

```sql
INSERT INTO order_schema.post_order_memberships (order_id, post_id, kind, joined_at, source)
SELECT o.id, o.post_id, 'DELIVERY', now(), 'seed_current' FROM order_schema.orders o
 WHERE o.post_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM order_schema.post_order_memberships m
                    WHERE m.order_id = o.id AND m.kind = 'DELIVERY' AND m.left_at IS NULL)
ON CONFLICT DO NOTHING;
-- xuddi shunday canceled_post_id va 'CANCELED' uchun
```

Keyin ixtiyoriy: `scripts/backfill-post-order-memberships.ts` — avval dry-run, hisobotni ko'rib, keyin
`--apply`. Jadval yo'q, trigger bor bo'lsa — darhol migratsiya 201 ni qayta qo'llovchi migratsiya.

**18 — «Asosiy karta» nomi band.** O'sha kassaning kartalarini ko'rib chiqib, oddiy «Asosiy karta» kartasini
qayta nomlang («Asosiy karta (eski)») yoki `balance = 0` bilan sukut qiling (faqat o'sha kassada tirik sukut
karta bo'lmasa). `is_deleted = true` qatorlarni tiklamang.

**20 — eskirgan snapshot'lar (WARN).** Backup'dan keyin ikkala jadvalni **birga** tozalang — job ~10 daqiqada
tarixdan qayta quradi:

```sql
DELETE FROM finance_schema.finance_daily_snapshots;
DELETE FROM finance_schema.finance_cashbox_daily;
```

**19, 25, 26, 28, 29** — biznes ma'lumoti: avtomatik tiklanmaydi, faqat hisobot raqamlari bilan alohida
ko'rib chiqiladi.

## Keyingi qadamlar

1. Ega hisobotni prod'da yurgizib, `seed-gap-report.txt` ni yuboradi.
2. 231 ni main'ga chiqarish (03).
3. 07, 04, 05 bo'yicha restore migratsiya PR'lari (natija MISSING bo'lsa — darhol; OK bo'lsa ham kelajakdagi
   tozalash uchun kod self-heal'lari).
4. 01 MISSING bo'lsa — hamma narsadan oldin.
5. Qolgan MISSING/WARN bandlar — `nima_qilish` ustuni bo'yicha.
