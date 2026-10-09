# Frontend Changelog & Action Items

> **Maqsad.** Backend audit/hardening jarayonida frontend'ga taalluqli har bir
> o'zgarishni shu yerda yozib boramiz: yangi/o'zgargan endpointlar, kontrakt
> (request/response) o'zgarishlari, va frontend bajarishi kerak bo'lgan ishlar.
>
> To'liq integratsiya qo'llanmasi: [`FRONTEND_INTEGRATION_GUIDE.md`](./FRONTEND_INTEGRATION_GUIDE.md).
> Qoplama holati: [`COVERAGE_REPORT.md`](./COVERAGE_REPORT.md).
> Backend tomon jurnali: [`../audit/AUDIT_LOG.md`](../audit/AUDIT_LOG.md).
>
> **Action item turi:** 🆕 yangi endpoint · ✏️ kontrakt o'zgardi · ⚠️ breaking change ·
> 🔧 frontend tuzatishi kerak · 🟢 info (o'zgarish shart emas, faqat xabardorlik uchun).

---

## Format

Har yozuv: `[sana] [tur] [servis] — tavsif → frontendda nima qilish kerak`.

---

## Yozuvlar

<!-- Yangi yozuvlar shu yerga (eng yangisi tepada) -->

### 2026-10-08 — 7-oktabr muddatli kartalar (analitika, RBAC, filtrlar, integratsiya)

- [2026-10-08] ✏️ [analytics] — `GET /analytics/revenue`: `data` endi MASSIV
  (bandlar), `summary {totalRevenue, totalOrders, avgRevenue}` qaytadi; raqamli
  kalitlar (`"0"`, `"1"`…) yo'q (faAfgvW1). `chart` o'zgarmagan →
  `FinancialAnalysis.tsx` dagi `Object.values(revenuePayload)` hack'i endi
  kerak emas, `data`/`chart` o'qilsin. `GET /analytics/kpi` `averageOrderValue`
  endi 0 emas (tVAWnl9O) — "Yo'qotilgan daromad" ham to'g'ri chiqadi.
- [2026-10-08] ✏️ [analytics] — `GET /analytics/reports/finance`:
  `totalIncome/totalOutcome/net` va `monthlyDynamics` BUTUN oraliq bo'yicha
  (limitga bog'liq emas); `limit` yuqori chegarasi 100 (QGxC7v1E).
- [2026-10-08] ⚠️ [analytics] — `GET /analytics/dashboard` endi `RolesGuard` bilan:
  investor va customer → 403 (ukulko6O, EgizXSKW).
- [2026-10-08] ✏️ [order] — `GET /orders`: SA/admin uchun `status=cancelled`
  oddiy filtr (hamma bekor qilinganlar, `cancelled (sent)` qayta yozilmaydi).
  Inventar rejimi (qo'ldagi, qaytarish pochtasiga biriktirilmagan) —
  `cancelled_inventory=true`. Filial xodimi/HQ registratori uchun parametrsiz
  avvalgidek inventar → 🔧 menejer «Bekor» tabi `cancelled_inventory=true`
  yuborsin (onzwA7CQ). `market_operator` boshqa `market_id` so'rasa → 400 (WWbdu8ya).
- [2026-10-08] 🟢 [identity] — `GET /users`: superadmin/admin uchun kuryerlar
  filial bo'yicha yashirilmaydi (o5jS4rUS).
- [2026-10-08] 🟢 [branch] — `GET /branches/:id` (va filial/transfer-batch
  `:id` yo'llari): raqam bo'lmagan id → 400 (avval 500) (RghzFldr).
- [2026-10-08] ✏️ [partner] — `POST /admin/partners/:id/webhook-test`:
  `target: 'main' | 'sandbox'`; javobda `target` va `secret_used`. Berilmasa
  sandbox yoqiq va manzili bo'lsa sandbox (jeU3eztP).

### 2026-10-08 — Prod testidan keyingi tuzatishlar (6-oktabr kartalari)

- [2026-10-08] ✏️ [order] — `POST /orders/sell/{id}`: `paidAmount: 0` yana qabul
  qilinadi (eskirgan, faqat 0); 0 dan boshqa qiymat 400 (ZsPLevZZ). Avval maydon
  butunlay olib tashlangani uchun `paidAmount: 0` yuboradigan klientlar ham 400
  olardi → frontendda o'zgarish shart emas (UI sotishda bu maydonni yubormaydi).
- [2026-10-08] 🟢 [gateway] — `receive_by_scan_total{outcome="ok|partial|none"}`
  Prometheus hisoblagichi (`/metrics`); `none` = hech narsa qabul qilinmadi —
  alert shunga quriladi (n9o0KYd5). Javob kontrakti o'zgarmagan.
- [2026-10-08] 🟢 [integration] — webhook payload'ini maskasiz ko'rish va qayta
  ishlash audit yozuvlarida `user_id`/`user_role` endi to'ldiriladi (Activity
  log ekranida ijrochi ko'rinadi) (Xd88lHGq).
- [2026-10-08] 🟢 [identity] — `POST /partner/markets` prodda doim 502 qaytarardi
  (`users.created_by` bigint, partner so'rovchisi `partner:N`); tuzatildi.
- [2026-10-08] 🟢 [partner] — telefon xatosi matni: `customer.phone noto'g'ri …`
  (avval `customer.customer.phone` deb takrorlanardi) (zfPNDCCr).

### 2026-10-07 — Andijon E2E va integratsiya kartalari (6-oktabr muddatli)

> Backend avval deploy qilinadi; hozirgi UI buzilmaydi (pastdagi har yozuvda
> "eski UI" xulqi aytilgan). `openapi.json` qayta generatsiya qilindi.

- ✏️ [order] **`POST /orders/cancel/:id` — bekor qilish sababi** (PUvKXWVw). Yangi `reason`
  (yopiq ro'yxat): `CUSTOMER_NO_ANSWER` | `CUSTOMER_REFUSED` | `WRONG_ADDRESS` |
  `DEFECTIVE_PRODUCT` | `PRICE_DISPUTE` | `OTHER`. `OTHER` bo'lsa `comment` majburiy. Sabab ham,
  izoh ham bo'lmasa — **400**. `reason` yuborilmasa-yu izoh bo'lsa — `OTHER` deb yoziladi (eski
  UI shunday ishlayveradi). Kod `return_reason` ga yoziladi. → **Frontendda:** 🔧 CancelModal'ga
  sabab `<select>` qo'shing, sabab tanlanmaguncha tugma disabled; `OTHER` da izoh majburiy.
- ✏️ [order] **`paidAmount`** (ZsPLevZZ, T0UGh8bL): `POST /orders/sell/:id` — maydon **olib
  tashlandi** (whitelist 400; u buyurtmani "to'landi" qilardi, kassaga hech narsa yozilmasdi).
  `POST /orders/cancel/:id` — faqat `0` qabul qilinadi (eski UI shuni yuboradi), boshqa qiymat 400.
  → **Frontendda:** 🔧 CancelModal'dan "To'langan summa" maydonini olib tashlang; SellModal'ga
  qo'shmang — marketga to'lov `/finance/cashbox/payment/market` orqali.
- ✏️ [order] **`POST /orders/partly-sell/:id`** (UlhtEpsI): hamma qator 0 bo'lsa **400** ("kamida
  bitta mahsulot sotilishi kerak") — ilgari faqat frontendda (`canDecreaseItem`) edi. 🟢
- ✏️ [order] **`POST /orders/external/receive-by-scan`** (n9o0KYd5): HTTP **200** (201 emas), tana
  bilan bir xil. `data.ok` (`false` — hech narsa qabul qilinmadi) va `data.partial` qo'shildi. 🟢
- 🟢 [order] Bekor qilingan buyurtmada `to_be_paid` endi **0** (pLmAsEsj; eski qatorlar migratsiya
  bilan tozalanadi). Skanerlab qabulda `last_handover_at/by` va ushlovchi yoziladi (rTzcjrdo).
- 🆕 [order] **`GET /orders/cancel-reasons/stats`** (SA/admin; market — o'zinikini, menejer — o'z
  filialini): `?startDate&endDate&market_id&branch_id&group_by=market|region|courier` →
  `{ total, by_reason[], rows[]? }`. Sana — bekor qilingan vaqt bo'yicha.
- ✏️ [identity] **`POST /couriers`** (wUHQrZko): `branch_id` so'rovchining filialiga (SA/admin —
  HQ) mos kelmasa **400** — ilgari jimgina e'tiborsiz qolardi. Menejer UI'si o'z filialini
  yuboradi — o'zgarish shart emas. 🟢
- ✏️ [finance] **`GET /finance/cashbox/financial-balanse`** (03avx8hG): `data.branches.cashExceedingPayable[]`
  — kassasi "berilishi kerak"dan ko'p filiallar (`branch_id, cashbox_balance, payable, excess`).
  Holat formulasi o'zgarmadi. → **Frontendda:** nazorat ro'yxati sifatida ko'rsatish mumkin.
- 🆕 [integration] **Ish rejimi** (DOZ6dtJn): ulanishda `webhook_enabled`, `reconcile_enabled`
  (`PATCH /integrations/:id` orqali, ikkalasi ham sukut `true`) va `last_reconcile_at`.
  `POST /integrations/:id/reconcile-now` — "Hoziroq tenglashtirish" (`{ checked, applied,
  unchanged, unmapped, failed, skipped, last_reconcile_at }`; master o'chiq yoki boshqa
  solishtiruv ishlayotgan bo'lsa 409). Webhook o'chiq bo'lsa jurnalda yangi holat
  `skipped_disabled`. Tashuvchidan holat so'rash uchun `status_sync_config.status_query =
  { endpoint, method, status_path, ... }` sozlanadi. → **Frontendda:** 🔧 ConnectionControl
  qator-ro'yxati (karta tavsifiga qarang).
- 🆕 [integration] **Webhook payload ko'rgichi** (Xd88lHGq): `GET /integrations/webhook-logs/:logId`
  — maskalangan `payload` (telefon `***7434`, ism bosh harflar, manzil shahar darajasi),
  `payload_note` (tana JSON bo'lmasa), `can_reprocess` + `reprocess_blocked_reason`,
  `signature_note`. `?unmasked=true` — faqat superadmin (admin 403), ko'rish jurnalga yoziladi.
  `POST /integrations/webhook-logs/:logId/reprocess` — 409 sababi bilan. Xom `raw_body` hech qachon
  qaytmaydi. → **Frontendda:** 🔧 ConnectionLog'ga Eye (Modal) va RotateCw tugmalari.
- 🆕 [partner] `PATCH /partner/shipments/:id`, `POST /partner/shipments/status` (100 tagacha),
  idempotent `POST /partner/shipments` javobida `cod_amount`, `total_price`, `mismatched_fields`;
  `customer.phone` `+998XXXXXXXXX` ga normallashtiriladi. Tafsilot: `docs/public/MARKETPLACE_API.md` §5.

### 2026-10-01 — ishga tushirish kuni: fix3 tuzatishlari

> Backend audit tuzatishlari (fix3 + fix3b) va ularga mos Elchi-Frontend o'zgarishlari.
> **Deploy tartibi: avval backend (barcha servislar), keyin frontend.** "✅ FE: qilindi" —
> o'zgarish Elchi-Frontend'da allaqachon bor. `openapi.json` qayta generatsiya qilinadi.

- ⚠️ **breaking** [logistics] **`PATCH /post/:id` (pochtani jo'natish) va `PATCH /post/reassign/:id`
  endi hamma uchun 410 Gone** (CODE-12): ular buyurtma custody'sini tekshiruvsiz o'zgartirardi.
  → **Frontendda:** chaqirmang — filialga `POST /branches/posts/:postId/dispatch`, kuryerga
  `POST /orders/assign-to-courier` yoki skan. ✅ FE: bu route'lar chaqirilmaydi (`useSendPost`,
  `reassignPost` ishlatilmaydi).
- ⚠️ **breaking** [order] **`PATCH /orders/:id` va `/:id/full` qoidalari** (M11, CODE-03): `status`,
  `market_id`, `to_be_paid`, `paid_amount` — hamma uchun (superadmin ham) **400** (holat faqat
  sotish/bekor/qaytarish/rollback orqali); `post_id`, `customer_id`, `qr_code_token`, `source` —
  faqat superadmin (aks holda 403); registrator — faqat o'z filiali doirasidagi buyurtma
  (`branch_id`/`holder_branch_id`/`home_branch_id`, aks holda 403). Ichkarida alohida
  `order.update_from_api` pattern. → **Frontendda:** bu maydonlarni yubormang. ✅ FE: qilindi —
  `new_orderUpdate`da mijoz tahriri faqat superadmin/admin, manzil va buyurtma/mahsulot
  popuplari faqat superadmin/admin/registrator.
- ⚠️ **breaking** [order] **Buyurtma yaratishda maydonlar jimgina olib tashlanadi** (`POST /orders`,
  `/orders/external`; RBAC-01/05, LC-07, LC-14): superadmin/admin'dan boshqa har kim uchun
  `status`, `post_id`, `courier_id`, `current_batch_id`, `assigned_at`, `return_reason` — buyurtma
  doim `new`, kuryersiz, pochtasiz. Market uchun `branch_id`/`source` ham tashlanadi (buyurtma HQ
  da); filial xodimiga o'z filiali majburan qo'yiladi. `customer_id` faqat superadmin/admin'dan —
  boshqalar `customer` obyektini yuboradi (faqat `customer_id` → 400). Bot buyurtmasi `new` bilan
  boshlanadi. → **Frontendda:** ✅ FE: yaratish formasi faqat `customer` obyektini yuboradi —
  o'zgarish shart emas.
- ⚠️ **breaking** [order] **`GET /orders/:id` va `/:id/tracking` endi haqiqatan doira bo'yicha
  tekshiriladi.** Tekshiruv ilgari `response.data` ni o'qirdi (order-service o'ramsiz qator
  qaytaradi) va hech qachon ishlamasdi. Endi: market — o'zinikini, market_operator — o'z
  marketinikini, customer — o'zinikini, kuryer — o'ziga biriktirilgan/qo'lidagini (tracking —
  faqat posilka qo'lida bo'lsa), filial xodimi — o'z filialinikini (HQ xodimi HQ qo'lidagini ham),
  operator/investor — 403. → **Frontendda:** 403 "Bu buyurtmani ko'rishga ruxsat yo'q" xabarini
  ko'rsating (masalan header qidiruvidan boshqa doiradagi buyurtma ochilganda); deploydan keyin
  kuryer, market va filial rollarida buyurtma detalini tekshiring.
- ⚠️ **breaking** [order] **Ro'yxat va settlement doiralari** (CODE-04, RBAC-03): `GET /orders` —
  operator/investor 403, customer o'zinikini, market_operator o'z marketinikini;
  `GET /orders/market/:marketId` — faqat superadmin/admin/market (o'zi);
  `GET /orders/markets/new`, `/markets/:id/new` — superadmin/admin/registrator/manager/branch/market
  (market — faqat o'z qatori); QR (`/orders/qr-code/:token`, `/scan/:token`) — market faqat o'z
  posilkasini; `GET /orders/:id/settlement` — manager/registrator faqat o'z filiali doirasida (403).
  → **Frontendda:** shu rollarda bu endpointlarni chaqirmang, 403 ni ko'rsating.
- ⚠️ **breaking** [branch] **Pochtani filialga jo'natish qoidalari** (`POST /branches/posts/:postId/dispatch`;
  LC-09, CODE-11, LC-13): manzil filial pochtaning hududida bo'lishi shart — boshqa hudud → **400**;
  manzil SENT pochtasi manba pochta hududi bo'yicha. `order_ids` majburiy; pochtada yo'q id → 409
  (id'lar xabarda); `new` buyurtma jo'natilmaydi → 400 ("avval HQ qabul qilsin"); manba filialga
  tegishli bo'lmaganlar → 400 "Ularni tanlovdan olib tashlang"; hududsiz buyurtma → 400; manzilda
  faol menejer bo'lishi shart. Har birida hech narsa ko'chmaydi. → **Frontendda:** backend
  xabarini ko'rsating. ✅ FE: qilindi — manzillar pochtaning o'z `region_id`si bo'yicha
  yuklanadi (`mails/detail/lib/dispatchRegion.ts`).
- ⚠️ **breaking** [order] **HQ qabuli (`POST /orders/receive`) filial qo'lidagi buyurtmani rad
  etadi** — 400 "Bu buyurtma filialda turibdi — uni o'sha filial qabul qiladi (#id)", butun so'rov
  bajarilmaydi (ilgari HQ registratori 403 olardi). → **Frontendda:** backend xabarini ko'rsating.
- ⚠️ **breaking** [notification] **Telegram guruhni ulash — faqat maxfiy token, ulanish qayta
  yozilmaydi** (CODE-02): `text` = marketning maxfiy `market_tg_token`i (`group_token-<32 hex>`,
  ixtiyoriy `-create`/`-cancel`); eski `group_token-<marketId>` rad etiladi. Ulashdan keyin token
  **almashtirilmaydi**. Mavjud (market, guruh turi) ulanishi bot/token orqali **hech qachon**
  almashtirilmaydi ("Bu market uchun bu turdagi guruh allaqachon ulangan — admin orqali
  o'zgartiring") — qayta ulash faqat admin `PATCH/DELETE /notifications/:id`. Guruhda `/id` →
  `Group ID: <chat.id>`. `POST /notifications/connect-by-token` tanasi `{ text, group_id }` (ikkalasi
  majburiy). Token faqat superadmin/admin'ga `GET /users/:id` da (market qatorida). →
  **Frontendda:** ✅ FE: qilindi — market sahifasida superadmin/admin uchun yashirin token kartasi
  (Ko'rsatish/Nusxalash); `{ token }` yuboradigan "Token orqali ulash" bo'limi olib tashlandi;
  `useConnectNotificationByToken` `{ text, group_id }` ga o'tkazildi. To'liq oqim:
  Elchi-Frontend `docs/telegram-notification-bot.md`.
- ⚠️ **breaking** [order] **Rollback qoidalari** (M6, RBAC-20, LC-05, RBAC-05): kuryer — faqat
  SOLD/CANCELLED, bekor buyurtmani esa faqat posilka hali o'zida bo'lsa; menejer — faqat
  SOLD/CANCELLED (o'z filiali). Kuryer pulni filialga topshirgan (`courier_settled`) buyurtmani
  kuryer/menejer qaytara olmaydi — 400 "Tuzatishni faqat superadmin qila oladi"; **superadmin**
  qaytara oladi, topshirilgan summa kuryerning keyingi topshirig'iga kredit bo'ladi. Pul HQ ga
  yetgan bo'lsa — hech kim. `sold_at`siz "sotilgan" buyurtma — 400. → **Frontendda:** qolgan
  holatlarda backend xabarini ko'rsating. ✅ FE: qilindi — kuryer ro'yxatida "Tiklash" faqat ruxsat
  bo'lganda ko'rinadi.
- ⚠️ **breaking** [order] **Sotuv qoidalari** (LC-04, M10, M15): menejer kuryer qo'lidagi buyurtmani
  sota/qisman sota olmaydi — 400 (bekor qilish mumkin); qisman sotuv summasi `total_price` dan
  oshsa — 400; menejer sotuvida filial kassasi topilmasa — 404. → ✅ FE: qilindi — menejerga
  kuryer qo'lidagi qatorda "Sotish" yashirin, SellModal summani buyurtma summasi bilan cheklaydi.
- ⚠️ **breaking** [finance] **Menejer kassasi faqat o'z filiali** (C3, M4, M12, CODE-08): menejer
  faqat o'z filiali kuryeridan pul qabul qiladi (403 "Bu kuryer sizning filialingizga tegishli
  emas"); `click_to_market` menejerga 403 (faqat HQ kassasi); filial kassasidan qo'lda chiqim
  (`PATCH /finance/cashbox/spend`) qoldiqdan oshmaydi (400). Registrator `GET /finance/history`,
  `/history/:id` da faqat o'z filiali BRANCH kassasini ko'radi. → ✅ FE: qilindi — menejerga
  "Marketga o'tkazma" va "Marketga to'lov" yashirildi, kuryer "O'tkazma"sidagi karta egasi tanlovi
  olib tashlandi (`source_user_id` hech bir to'lov DTO'sida yo'q).
- ✏️ **kontrakt** [finance] **`Idempotency-Key` endi `payment/market` va `payment/branch-to-main` da
  ham** (C1, M2; avval faqat `payment/courier`). Takror kalit → `{statusCode:200, data:{idempotent:true}}`.
  Kalitsiz zaxira barmoq izida `payment_date`/`comment` yo'q (30 s oyna). Market to'lovi
  commit'dan keyin darhol javob beradi (per-order PAID sinxroni fonda). → ✅ FE: qilindi
  (`paymentIdempotency.ts`; 502/503/504 da kalit saqlanadi, "natija noma'lum" ogohlantirishi va
  qayta yuklash).
- ✏️ **kontrakt** [finance] **Sanalar** (C2): `GET /finance/cashbox/user/:id` endi `fromDate`/`toDate`
  qabul qiladi (ilgari 400); financial-balance history/analytics/top-impacts `YYYY-MM-DD` ni butun
  Toshkent kuni deb oladi. → ✅ FE: qilindi — oddiy `YYYY-MM-DD` (MyCashboxPage, HistoryTab,
  AnalysisTab).
- ✏️ **kontrakt** [identity] **`GET /markets` maydonlari rolga qarab** (CODE-08): superadmin/admin —
  to'liq qator + kassa; manager/registrator/branch — `{id, name, phone_number, status}`; kuryer va
  boshqalar — `{id, name, status}`. → **Frontendda:** superadmin/admin'dan boshqa rolda market
  balansini bu ro'yxatdan o'qimang.
- ✏️ **kontrakt** [analytics] **Dashboard doirasi** (RBAC-02, CODE-08): market dashboard `markets` —
  faqat o'z qatori (`{id,name}`); boshqa dashboard market/kuryer qatorlari `{id,name}`;
  `GET /analytics/reports/couriers` manager/registrator/branch uchun faqat o'z filiali kuryerlari.
  → 🟢 FE normalizer faqat id/name o'qiydi — o'zgarish shart emas.
- ✏️ **kontrakt** [catalog/logistics/printer/excel] **Rol cheklovlari:** `GET /product`, `/product/:id`
  — superadmin/admin/registrator/manager/branch/market (market — faqat o'zinikini);
  `PATCH /district/:id` — faqat superadmin/admin; `GET /region/stats/all` — market yo'q,
  `/region/stats/:id` — market va kuryer yo'q; `POST /printer/*` — faqat superadmin/admin, ≤200
  `order_ids`; `GET /export/orders.xlsx` — manager/registrator/branch o'z filialiga majburlanadi,
  `from_date`/`to_date`/`courier_id` endi ishlaydi. → ✅ FE: "Mahsulot yaratish" faqat
  superadmin/admin/market'ga ko'rinadi (qilindi).
- ✏️ **kontrakt** [auth] **Throttle: login 30/daqiqa/IP, refresh 60/daqiqa/IP — alohida hisoblagich**
  (RBAC-11). Bitta akkaunt — bitta sessiya: yangi kirish eski qurilmani keyingi refresh'da 401
  qiladi (yangisi qoladi); parol yoki login-telefon almashsa sessiya bekor bo'ladi. Admin o'z
  ism/telefon/parolini `PATCH /auth/my-profile` orqali o'zgartira oladi. → ✅ FE: qilindi —
  refresh 429/5xx/tarmoq xatosida chiqarib yubormaydi, 1/3/7 s (+jitter) bilan ko'pi bilan 3 marta
  qayta uriniladi; o'z parolini almashtirgan foydalanuvchi darhol chiqadi va "Parol o'zgardi —
  qayta kiring" ko'radi.
- ✏️ **kontrakt** [logistics] **`PATCH /post/receive/:id` javobiga top-level `not_received_order_ids`
  va `failures` qo'shildi** (`data` o'zgarmagan); yo'lda buyurtma qolsa pochta `sent` bo'lib qoladi
  (LC-11). → ✅ FE: qilindi — qabul qilinmaganlar yashirilmaydi, ogohlantirish chiqadi.
- ✏️ **kontrakt** [order] **Kuryer skani — tranzit buyurtma** (CODE-11): filial paketidagi boshqa
  hudud buyurtmasi skanerlansa u filialga `new` bo'lib qabul qilinadi va kuryerga
  **biriktirilmaydi** — 400 "Bu buyurtma boshqa hudud uchun (tranzit) …" (ilgari "Boshqa filial
  orderi"). → **Frontendda:** backend xabarini ko'rsating.
- ✏️ **kontrakt** [order] **Rollback javobi** (CODE-14): kuryerning `cancelled_sent` rollbackida
  qaytarish pochtasi yaratilmasa javob 200, `data.cancel_post_created=false` + `data.warning`.
  → ✅ FE: kuryer sahifasida ogohlantirish sifatida ko'rsatiladi (hozir hech bir FE oqimi bu
  targetni yubormaydi).
- ✏️ **kontrakt** [order] **Qo'shimcha xarajat tasdig'i** (M3): boshqacha yangi so'rov (amal/summa)
  eski kutilayotgan tasdiqni yopadi; 202 javobi **yangi** tasdiqning `action`/`amount`ini olib
  keladi. → ✅ FE: qilindi — kuryer va market tomonida so'ralgan amal ko'rsatiladi.
- ✏️ **kontrakt** [order] **HQ registratori bekor qilinganlarni ko'radi** (LC-10, RBAC-21):
  `GET /orders/markets/cancelled`, `/markets/:id/cancelled` va `GET /orders?status=cancelled` HQ
  registratoriga HQ qo'lidagilarni qaytaradi (superadmin/admin kabi). → ✅ FE: qilindi —
  topshirish (QR) UI HQ registratoriga ko'rinadi.
- ✏️ **kontrakt** [branch] **Filial paneli `stats_unavailable`** (CODE-23): statistika kelmasa `true`
  (nol shakli saqlanadi). Filialni tahrirlashda odamlar "osilib" qolsa 409 (CODE-20). Xato
  matnlari o'zbekcha, 4xx endi 500 bo'lib ketmaydi (CODE-13). → ✅ FE: "Statistika vaqtincha
  mavjud emas" ko'rsatiladi (qilindi); boshqalarda backend xabarini ko'rsating.
- 🟢 **info** [finance] **Filial puli HQ ga faqat superadmin/admin "To'lovlar → Qabul qilinishi
  kerak" orqali o'tadi** (biznes qarori #7). Menejerning o'z "HQga o'tkazish" ekrani fix3 dan
  oldingi holatida qoldirilgan — bu qo'llab-quvvatlanadigan oqim emas, menejer → HQ topshirishni
  yoqmang. `Idempotency-Key` superadmin qabulini himoya qiladi.
- 🟢 **info** [finance] **Smena** — backend o'zgarmagan; ✅ FE superadmin/admin uchun "Smenani
  ochish/yopish"ni uladi: `GET /finance/shift?status=open&opened_by=<o'zi>&limit=1` →
  `POST /finance/shift/open {opened_by}` / `POST /finance/shift/close {closed_by, shift_id, comment?}`,
  so'ng Excel; menejerga ko'rinmaydi. ⚠️ 2026-09-14 yozuvidagi `cashbox_user_id` gateway
  `OpenShiftRequestDto`sida **yo'q** (yuborilsa 400). "Maosh to'lash" yashirildi — backendda maosh
  sozlamasi bor, to'lash buyrug'i yo'q.
- 🟢 **info** [order] **Boshqa backend tuzatishlari (FE ish yo'q):** `GET /branches/new-orders` endi
  ishlaydi (`GET /branches/:id` uni tutib olardi — CODE-21); HQ marketga qisman to'laganda
  buyurtma `partly_paid` bo'ladi (`sold → partly_paid`); hamkor prepaid (`paid_online_amount`)
  saqlanadi — kuryer faqat COD qismini yig'adi; hamkor posilkasida `region_id` bo'lmasa tumandan
  olinadi; kuryerni filialdan chiqarish/o'tkazishda sof-nol PENDING qatorlar o'z-o'zidan yopiladi
  (C8; `GET couriers/:id/transfer-check` esa faqat o'qiydi — sababni ko'rsatishda davom etadi);
  menejer/registrator o'chirilsa filial xodimi qatori ham olib tashlanadi; pul outbox hodisalari
  endi hech qachon "failed" bo'lmaydi (M8).
- 🟢 **info** [notification] Order-bot `/status` faqat token bilan bog'langan marketning o'z
  buyurtmasiga javob beradi (mavjud bo'lmagan va boshqa market buyurtmasi — bir xil "topilmadi").
  Bog'langan guruhlarga **avtomatik** buyurtma xabari hozircha yo'q. Prod'da
  `VITE_TELEGRAM_NOTIFICATION_BOT_USERNAME` sozlanmagan; `TELEGRAM_BOT_TOKEN` hali placeholder,
  `ORDER_BOT_TOKEN` qo'yilmagan — ops haqiqiy tokenlarni qo'ymaguncha ikkala bot ham ishlamaydi.

### 2026-09-14 — pul/sig'im/xavfsizlik auditi tuzatishlari

- ✏️ **kontrakt** [finance] **`GET .../financial-balance` javobi to'ldirildi.** Formula
  `main + chain_receivable + provider_receivable − market_payable` bo'ldi. Yangi bandlar:
  `chain: { chainReceivable, branchReceivable, hqReceivable, providerReceivable }`,
  `branches.branchCashboxTotal`. `formula` matni ham o'zgardi.
  → **Frontendda:** eski `branches.branchReceivable` saqlanib qoldi, ya'ni buzilmaydi;
  lekin "kompaniya holati" ekranida endi kuryerlar/kargo qismini ham ko'rsatish tavsiya
  etiladi. `couriers.couriersTotalBalanse` ilgari **doim 0** edi — endi haqiqiy yig'indi
  qaytaradi, ya'ni "0" deb qotirilgan joy bo'lsa olib tashlansin.
- ✏️ **kontrakt** [finance] **Manager paneli (`berilishi_kerak`) endi ledgerdan keladi.**
  Ilgari u "sotilgan buyurtmalar yig'indisi − davrda to'langan" edi va 5 000 qatordan
  keyin jimgina qirqilardi. Endi `order_settlement` dan olinadi va HQ'ga topshirilgani
  o'z-o'zidan chiqib ketadi. `hq_ga_tollangan` ma'lumot uchun qoladi.
  → **Frontendda:** o'zgarish shart emas; raqam kattaroq/aniqroq bo'lishi mumkin.
- 🟢 **info** [order] **Sotuvda filial kassasiga oyoq yozilmaydi.** BRANCH kassa qoldig'i endi
  "filial jismonan ushlab turgan naqd" ma'nosini beradi (kuryerdan qabul qilinganda
  ko'payadi, HQ'ga topshirilganda kamayadi). "Filial HQ'ga qancha qarz" degan raqam
  manager panelidan olinadi.
- ⚠️ **breaking** [order] **Tarif qo'riqchisi.** Market tarifi kuryer (+ hamkor filial)
  ulushini qoplamasa, sotuv **400** bilan rad etiladi va xabar yetishmagan summani
  ko'rsatadi. → **Frontendda:** bu xatoni kuryerga tushunarli ko'rsatish kerak
  (tarifni to'g'rilash kerakligi aytilsin).
- ⚠️ **breaking** [file] **Maxfiy fayl (proof-/expense-/cod-/receipt-) endi egasi bo'yicha
  tekshiriladi.** `market`/`market_operator`/`courier` rollari faqat O'Z buyurtmasining
  dalilini ocha oladi (ilgari o'sha roldagi har kim har qanday faylni ochardi).
  → **Frontendda:** 403 holatini ko'rsatish; boshqa marketning fayliga havola bo'lsa
  ishlamaydi.
- 🟢 **info** [finance] **Marketga ortiqcha to'lov endi 400 qaytaradi** (qarzdan ko'p summa).
- 🟢 **info** [finance] **Smena yopilishi** endi faqat o'z kassasi bo'yicha hisoblaydi;
  `POST .../shift/open` ixtiyoriy `cashbox_user_id` qabul qiladi (berilmasa MAIN).


### 2026-06-06 — identity-service auditi

- 🟢 **info** [identity] **Manager cashbox = `FOR_COURIER` (tasdiqlandi).** Manager (menejer)
  roli kuryer kabi pul yig'adi, shuning uchun uning cashbox'i `Cashbox_type = couriers`
  (`FOR_COURIER`) bo'ladi — alohida "manager" cashbox turi **yo'q**. Finance/cashbox UI'da
  manager cashbox'larini kuryer turi ostida ko'rsatish **to'g'ri**. Kontrakt o'zgarmadi.
- 🟢 **info** [identity] **RBAC mustahkamlandi (defense-in-depth).** courier/manager/market
  yaratishda backend endi service-darajasida ham rol tekshiradi. Frontend xatti-harakati
  **o'zgarmaydi** — gateway allaqachon bir xil `@Roles` bilan 403 qaytarardi. Yangi/o'zgargan
  endpoint yo'q.

### 2026-06-07 — order update RBAC (⚠️ BREAKING)

- ⚠️ **breaking / 🔧 frontend** [order] **`PATCH /orders/:id` va `/orders/:id/full` endi faqat
  SUPERADMIN + ADMIN + REGISTRATOR.** Boshqa rollar (courier/market/manager/customer) **403**
  oladi. (Audit: avval har qanday login qilgan user istalgan order'ning total_price/status/
  paid_amount'ini o'zgartira olardi — P0.)
  - **Frontendda qilish kerak:** order "to'liq tahrirlash" formasini/tugmasini faqat
    admin/superadmin/registrator rollarga ko'rsating; boshqa rollar uchun 403'ni handle qiling.
  - **Eslatma:** kuryer/market o'z amallarini boshqa endpointlar orqali qiladi (sell, cancel,
    scan, assign) — ular o'zgarmadi. Faqat generic "order update" cheklandi.

---

### 2026-06-07 — analytics-service auditi (⚠️ BREAKING)

- ⚠️ **breaking / 🔧 frontend** [analytics] **Moliyaviy hisobotlar endi faqat SUPERADMIN+ADMIN.**
  `GET /analytics/revenue`, `GET /analytics/kpi`, `GET /analytics/reports/orders`,
  `GET /analytics/reports/finance` endi `@Roles(SUPERADMIN, ADMIN)` bilan himoyalangan —
  boshqa rollar (courier/market/manager/registrator/customer) **403** oladi. (Audit: avval
  bu endpointlar har qanday login qilgan userga to'liq kompaniya moliyasini ko'rsatardi — P0 leak.)
  - **Frontendda qilish kerak:** bu 4 sahifani/komponentni faqat admin/superadmin rollarga
    ko'rsating; boshqa rollar uchun menyudan yashiring yoki 403'ni to'g'ri handle qiling.
  - `GET /analytics/dashboard` va `GET /analytics/reports/couriers` o'zgarmadi (ichida
    role-filter qiladi, hamma rollar uchun ochiq).
- 🟢 **info** [analytics] Dashboard/hisobotlar endi resilient — bitta downstream servis
  ishlamasa ham qisman ma'lumot qaytaradi (butun sahifa yiqilmaydi).

---

### 2026-06-07 — logistics-service auditi

- 🟢 **info** [logistics] **`post_total_price` endi `numeric(14,2)` (backend).** Post (kuryer
  to'plami) jami narxi float→numeric'ga o'tkazildi. API'da hali ham `number` — kontrakt o'zgarmadi.

---

### 2026-06-07 — finance-service auditi

- 🟢 **info** [finance] **Cashbox balanslari va P&L ledger endi `numeric(14,2)` (backend).**
  cashbox, cashbox_history, financial_balance_history, shift pul ustunlari float→numeric'ga
  o'tkazildi (moliyaviy aniqlik, drift yo'q). **API kontrakti o'zgarmadi** — `balance`,
  `balance_cash`, `balance_card`, `amount` va h.k. hali ham JSON'da `number`. Frontendda
  hech narsa qilish shart emas.

---

### 2026-06-07 — order-service auditi

- 🟢 **info** [order] **`total_price` va tariflar endi `numeric(14,2)` (backend).** Order pul
  ustunlari float→numeric(14,2) ga o'tkazildi (moliyaviy aniqlik). **API kontrakti
  o'zgarmadi** — `total_price`, `market_tariff`, `courier_tariff` hali ham JSON'da `number`
  qaytadi. Frontendda hech narsa qilish shart emas.

---

_(Audit davom etmoqda — keyingi yozuvlar tepaga qo'shiladi.)_
