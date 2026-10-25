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

### 2026-10-25 — Kassa smenasi: `last_closed`, smena ro'yxati filtri/saralashi, xodim ismlari, sanalgan naqd majburiy (8OYPuz7J)

Deploy: api-gateway, finance-service. Migratsiya yo'q.

- [2026-10-25] ✏️ [finance/shift] — **`GET /finance/shift/current`** javobiga `data.last_closed` (QO'SHIMCHA kalit):
  shu kassaning (superadmin/admin — MAIN, menejer — o'z filiali) eng oxirgi YOPILGAN smenasi (`closed_at` DESC) —
  to'liq smena qatori (`id, opened_at, closed_at, opened_by, closed_by, opening_balance_*, total_income_*,
  total_expense_*, expected_balance_*, closing_balance_*, discrepancy_*, comment` …) yoki `null` (hali yopilmagan).
  🔧 FE (kfdfYDik): «Smena yopildi · Bugun, 18:00 · Yopgan xodim: … · Naqd ortiqchasi: … · Natija» bloki va
  ochish oynasidagi «Oxirgi smena … bilan yopilgan» endi sahifa qayta yuklangandan keyin ham `last_closed` dan
  chiziladi (`useCashboxShift.ts`, `ShiftResultDialog.tsx`, `OpenShiftDialog.tsx` izohlari).
- [2026-10-25] ✏️ [finance/shift] — smena qatorlarida (`shift/current` → `shift` va `last_closed`, `GET /finance/shift`
  → `items[]`) **`opened_by_name` / `closed_by_name`** (matn yoki `null` — identity'da topilmasa). Identity'ga bitta
  batch so'rov. 🔧 FE: har smena uchun `GET users/:id` endi shart emas.
- [2026-10-25] ✏️ [finance/shift] — **`GET /finance/shift`**: yangi query `cashbox_user_id` (`'0'` — asosiy MAIN kassa,
  aks holda filial ID si), `sort_by=opened_at|closed_at` (sukut `opened_at`), `sort_dir=asc|desc` (sukut `desc`).
  `closed_at` bo'yicha ochiq smenalar har doim oxirida. Noto'g'ri qiymat — 400. MAIN ning oxirgi yopilgan smenasi:
  `?cashbox_user_id=0&status=closed&sort_by=closed_at&limit=1`. 🔧 FE: MAIN smenasini 20 talik sahifadan klientda
  qidirish o'rniga shu filtrdan foydalaning.
- [2026-10-25] ✏️ [finance/shift] — **`GET /finance/shift` — MENEJER ham** (avval faqat superadmin/admin/registrator):
  doira JWT'dan majburlanadi (o'z filiali kassasi smenalari); boshqa `cashbox_user_id` (`0` yoki boshqa filial) —
  403 «Siz faqat o'z filialingiz kassasi smenalarini ko'ra olasiz»; filiali topilmagan menejer — 403.
- [2026-10-25] ⚠️ [finance/shift] — **`POST /finance/shift/close` — `closing_balance_cash` (sanalgan naqd) MAJBURIY**
  (ega S5). Yuborilmasa yoki `null` — 400 «Sanalgan naqd summani kiriting (closing_balance_cash majburiy)».
  `closing_balance_card` ixtiyoriy (yuborilmasa `discrepancy_card: null` — «Sanalmadi»). 🟢 FE yopish oynasi
  `closing_balance_cash` ni allaqachon yuboradi (`CloseShiftRequest`) — o'zgarish shart emas.

### 2026-10-25 — AI idempotentlik qoldiqlari (Cp2v3ZJ7) va kampaniya yuklamasi (xHPdpj0W)

Deploy: faqat notification-service (bot matni). Migratsiya yo'q. API kontrakti o'zgarmagan.

- [2026-10-25] 🟢 [notification/bot] — Telegram'da tozalangan (>48 soat) yoki tanilmagan tugma bosilganda toast endi
  «⌛ Bu tugma eskirgan — endi ishlamaydi. Menyuni qayta oching: /start» (avval «Bu tugma endi ishlamaydi…»).
  AI preview kartasining eski tugmasi: 24–48 soatda «⏳ Bu ro'yxat eskirgan — matnni qayta yuboring.», yaratilgan /
  bekor qilingan karta — o'z holati matni; eski karta hech qachon boshqa kartaning mazmunini yaratmaydi (har tugma
  o'z qoralamasiga bog'langan). Frontend o'zgarishi shart emas.
- [2026-10-25] 🟢 [order/ai] — `POST /orders/ai-confirm` kontrakti o'zgarmagan. Ayni `draft_id` + `ai_item_index`
  ikki marta yuborilsa ikkinchisi `idempotent_replay: true` va narx (pul) qaydi bir marta. 🔧 FE (Cp2v3ZJ7 qolgan
  TC'lari, v2 AI paneli): har buyurtmaga `draft_id` + `ai_item_index` yuborish va `idempotent_replay: true` ni
  «Yaratildi (N)» ro'yxatida ko'rsatish (xato emas) — frontend ishi.
- [2026-10-25] 🟢 [notification/campaign] — kontrakt o'zgarmagan; kampaniya paytida bot polling va
  `GET /notifications/inbox` (p95 < 500 ms) uchun yuklama spec'i qo'shildi.

### 2026-10-25 — Skaner: paket QR qabul qiluvchi filialda, pochta QR `POST-…`, skan javoblarida mazmun (j8hdXE1o, X4RzXk1H, dwJX3NjT)

Deploy: api-gateway, branch-service, logistics-service (umumiy `libs/common` ga yangi helper qo'shildi — boshqa
servislarga ta'sir yo'q). Migratsiya yo'q. order-service o'zgarmagan (mavjud `order.summary_by_ids` ishlatiladi).

- [2026-10-25] ✏️ [gateway/branch] — **Paket QR (`BTB-…`/`BTR-…`) — `GET /scan/:token`** (j8hdXE1o): ruxsat endi
  `GET /transfer-batches/:id` bilan AYNI — jo'natuvchi **YOKI qabul qiluvchi** filialni o'qiy oladigan foydalanuvchi
  (menejer, registrator, kuryer). Ilgari faqat jo'natuvchi tekshirilardi: qabul qiluvchi filial xodimi o'ziga kelgan
  paketni skanerlasa 403 olardi va «Qabul qilish» tugmasigacha yetmasdi. Begona filial va market — 403 (avvalgidek).
- [2026-10-25] ✏️ [gateway/branch] — **Paket skani mazmuni** (dwJX3NjT S1, QO'SHIMCHA kalitlar; paket qatorining eski
  maydonlari va `{ type: "batch", data }` konverti o'zgarmagan):
  - `data.source_branch` / `data.destination_branch` — `{ id, name }`;
  - `data.region` — maqsad viloyat `{ id, name }` (topilmasa `null`);
  - `data.items[].order` — buyurtma XULOSASI `{ id, order_number, status, total_price, region, district,
    customer: { name, phone_number } | null }` (`region`/`district` — nom, matn). Xulosa xizmati javob bermasa
    `order: null` — skan baribir javob beradi. To'liq buyurtma (tariflar) EMAS — kuryer ham shu javobni oladi.
  🟢 FE: `buildScanPackageView` bu kalitlarni allaqachon o'qiydi (`source_branch.name`, `region.name`,
  `items[].order.customer.name/phone_number`, `.status`, `.total_price`) — kuryerda ham filial/viloyat nomi va
  buyurtmalar chiqadi. Xodim uchun qo'shimcha `GET transfer-batches/:id` endi ixtiyoriy (olib tashlash mumkin).
- [2026-10-25] ⚠️ [gateway/logistics] — **Pochta QR — `GET /scan/:token`** (X4RzXk1H): resolver haqiqiy pochta
  tokenini (`POST-<base36>-<rand>`, logistics `generateToken()`) taniydi — ilgari faqat `PST-` ni kutardi va `POST-…`
  buyurtma tarmog'iga tushib 404 berardi. `PST-` ham qoladi (moslik). Javob `{ type: "post", data }`, `data` —
  `GET /post/scan/:token` bilan bir xil (pastda).
- [2026-10-25] ⚠️ [gateway/logistics] — **Pochta skani ruxsati** (X4RzXk1H; `GET /scan/:token` `POST-…` va
  `GET /post/scan/:token`): rol — superadmin, admin, branch, manager, registrator, courier; **market, mijoz, operator,
  investor, logist — 403** (ilgari `/scan` da market ham pochta qatorini to'liq olardi). Doira — `GET /post/orders/:id`
  bilan AYNI: filial xodimi — o'z filiali pochtasi (yoki buyurtmalari to'liq o'z filialida turgan pochta), kuryer —
  o'z pochtasi; boshqasi 403 «Siz bu branch pochtasidagi orderlarni ko'ra olmaysiz». Skan pochtani o'zgartirmaydi
  (sahifa ochilganda bo'ladigan filial o'tkazmasi `branch_id` tuzatishi skanda yozilmaydi).
- [2026-10-25] ✏️ [logistics] — **Pochta skani mazmuni** (dwJX3NjT S2, `GET /post/scan/:token` va `/scan` `POST-…`;
  pochta qatorining eski maydonlari o'zgarmagan, QO'SHIMCHA kalitlar): `region` `{ id, name }`, `courier`
  `{ id, name, phone_number }` (kuryersiz — `null`), `orders[]` — `GET /post/orders/:id` dagi AYNI ro'yxat (kuryerga
  SENT pochtada faqat yo'ldagilar) xulosa shaklida: `{ id, order_number, status, total_price, where_deliver, region,
  district, customer: { name, phone_number } | null }`. 🟢 FE: `buildScanPostView` `orders`, `region.name`,
  `courier.name` ni allaqachon o'qiydi — ro'yxat, viloyat va kuryer karta/qatorda chiqadi. 🔧 FE (ixtiyoriy):
  `POST-` tokenini vaqtincha `GET post/scan/:token` ga yo'naltirish shart emas — `GET scan/:token` ham ishlaydi
  (ikkalasining `data` si bir xil).

### 2026-10-25 — Realtime: smena yopildi / avtomatik yopildi va kassa kartasi hodisalari (rWdLuoP3)

Deploy: **finance-service + api-gateway** (ikkalasi). Migratsiya yo'q (`outbox_events` jadvali finance'da bor).
Env: yangi kalit yo'q — `.env.production` dagi mavjud `RABBITMQ_GATEWAY_QUEUE` finance-service'ga ham kerak (bo'sh
bo'lsa finance hodisa yozmaydi).

- [2026-10-25] 🆕 [finance/realtime] — socket `/realtime` hodisalari (frontend `FINANCE_SHIFT_EVENTS` nomlari bilan
  bir xil). Smena yopilish tranzaksiyasi bilan BIRGA outbox'ga yoziladi → ~1 s ichida socketga (lokal o'lchov:
  0,9–1,0 s). Payload'da pul summasi yo'q — sahifa qiymatlarni REST'dan qayta o'qiydi.
  - `finance.shift.closed` — `POST /finance/shift/close` (qo'lda);
  - `finance.shift.auto_closed` — avtomatik yopish (y8Tqm9Ap rejalashtiruvchisi; nom va payload tayyor, jadval
    kartasi qilingach keladi);

  ```json
  { "shift_id": "31", "cashbox_user_id": "0", "cashbox_type": "main", "branch_id": null, "status": "closed",
    "close_reason": "manual", "closed_at": "2026-10-25T13:00:00.000Z", "closed_by": "2", "opened_by": "3" }
  ```
  (`close_reason`: `manual` | `auto`; avtomatikda `closed_by: null`; `closed_at` — ISO UTC, toast «HH:MM» shundan.)
  - `finance.shift.account_checked` — karta qoldig'i AI tekshiruvi tugadi (kiZgTybn; nom/payload tayyor, AI
    tekshiruvi qilingach keladi): `{ shift_id, cashbox_user_id, cashbox_type, branch_id, card_id, ai_status,
    checked_at }`.
  - `finance.cashbox.card_changed` — **YANGI nom**: asosiy kassa kartasi yaratildi / nomi / holati o'zgardi,
    kartalararo o'tkazma, karta↔naqd konvertatsiya: `{ action: "created" | "renamed" | "activated" | "archived" |
    "transfer" | "card_to_cash" | "cash_to_card", cashbox_type: "main", card_ids: ["3","4"], movement_id, at }`.

  **Kim oladi** (kassa doirasi — `GET finance/shift/current` bilan bir xil, boshqa filial ma'lumoti chiqmaydi):
  MAIN kassa smenasi — superadmin, admin, registrator; filial kassasi smenasi — FAQAT o'sha filial menejerlari
  (superadmin/admin olmaydi — ularning «Smena» holati MAIN); ikkalasida smenani ochgan/yopgan xodimning o'zi ham;
  `card_changed` — superadmin, admin. Bir nechta xonadagi socket hodisani BIR MARTA oladi.
  🔧 FE (`realtimeFinance.ts`): `FINANCE_SHIFT_EVENTS` ga `finance.cashbox.card_changed` ni qo'shing (handler
  o'zgarmaydi — smena va kassa/karta so'rovlari yangilanadi). Qolgan uchta nom — o'zgarishsiz.
- [2026-10-25] 🟢 [gateway/realtime] — socket JWT'da `branch_id` bo'lsa qo'shimcha `branch:<branch_id>:role:<rol>`
  xonasiga kiradi (filial doirasidagi hodisalar uchun). `realtime.notify` RMQ xabari `targets`
  (`[{ user_id } | { role } | { role, branch_id }]`) qabul qiladi. Gateway realtime iste'molchisi endi `noAck: false`
  — ilgari har realtime xabardan keyin RMQ kanali yopilib (~5 s), ketma-ket kelgan hodisa (masalan bildirishnomadan
  keyingi smena hodisasi) ~5 s kechikardi; endi ~1 s. Frontend o'zgarishi shart emas.

### 2026-10-25 — Buyurtmalar Excel eksporti: «Holati» = ekrandagi nom (9Bp7VtVj)

Deploy: faqat api-gateway. Migratsiya yo'q. Kontrakt (endpoint, query, sarlavhalar, ustunlar) o'zgarmagan.

- [2026-10-25] ✏️ [gateway] — `GET /orders/export/excel` faylidagi «Holati» ustuni endi FE dizayn v2 yorliqlari bilan
  AYNAN (`ORDER_STATUS_REGISTRY` + `src/locales/uz/status.json` → `order.*`; eski `orders.json` emas):
  created «Yaratilgan» (avval «Qabul qilingan»), waiting_customer «Mijoz kutilmoqda» («Kutilmoqda»), partly_paid
  «Qisman to'langan» («Qisman to'landi»), cancelled (sent) «Bekor — jo'natilgan» («Bekor qilingan»; ro'yxat qatoridagi
  `cancelled` + `transport_status: 'cancelled (sent)'` ham), returned_to_market «Marketga topshirildi» («Marketga
  qaytarildi»), closed «Yopilgan» («Yopildi»). Noma'lum holat — o'qiladigan xom qiymat, bo'sh — «Noma'lum». Eksport
  faqat o'zbekcha (til parametri yo'q). 🟢 FE o'zgarishi shart emas; `status.json` (uz) `order.*` yorlig'i
  o'zgarsa — backend'da `orders-xlsx.export.ts` `ORDER_EXPORT_STATUS_LABELS` ham yangilansin (spec uni qulflaydi).

### 2026-10-25 — Market operatori: viloyat tumanlari va tuman tafsiloti (MO-7, OfRSoRUX / N11)

Deploy: faqat api-gateway. Migratsiya yo'q.

- [2026-10-25] ✏️ [gateway/logistics] — `GET /region/:id` (viloyat + tumanlari) va `GET /district/:id` endi
  **market_operator** ga ham ochiq (faqat o'qish; MARKET rolida avvaldan ochiq). Sabab: operator buyurtmani qo'lda
  yaratganda tuman ro'yxati 403 qaytarardi, mijoz taklifidagi tuman nomi chiqmasdi. Yozish yo'llari
  (POST/PATCH/DELETE region/district) operatorga yopiq qoladi. Frontend o'zgarishi shart emas
  (FE `feat/operator-manual-create` shu yo'llarni ishlatadi).

### 2026-10-25 — Filial puli HQ'ga faqat HQ qabul qilganda (IjqTYQks, ega qarori #7)

Deploy: faqat api-gateway. Migratsiya yo'q.

- [2026-10-25] ⚠️ [gateway/finance] — `POST /finance/cashbox/payment/branch-to-main` endi faqat **superadmin va
  admin** (HQ «Pul qabul qilish» → filialni tanlash). MANAGER — 403 (avval o'z filiali bilan ruxsat edi). Xabar:
  «Filial pulini HQ (superadmin yoki admin) o'zi qabul qiladi — menejer HQ'ga pul o'tkazmaydi».
  🔧 FE: menejerda «HQ'ga o'tkazish» tugmasi va formasi yo'q (FE `fix/manager-no-hq-transfer`); menejer HQ kassasi
  sahifasini faqat ko'radi (`GET cashbox/manager/settlement`, `payable-to-hq`, `all-info` — o'zgarmagan).

### 2026-10-25 — Buyurtmalar qidiruvi: «EL-…» faqat ID, qo'shimcha telefon, mijoz doirasi (FoCaUF10, rwAy8Qyk)

Deploy: faqat order-service (+ api-gateway — faqat Swagger tavsifi). Migratsiya yo'q.

- [2026-10-25] ✏️ [order] — `GET /orders?search=` (ega qarori 2026-10-25):
  - **«EL-N»** (ko'rinadigan raqam; `#EL-N`, `№EL-N`, `el N`, harf farqsiz) — FAQAT buyurtma `id = N − 100000`,
    mijoz ismi/telefoni bo'yicha qidirilmaydi. Id chiqmaydigan «EL-» raqami (`EL-100000`, `EL-12`) — bo'sh ro'yxat.
  - **Boshqa matn** — mijoz ismi, asosiy VA qo'shimcha telefoni (`extra_number`, 9444UAa8 dagi normallashtirish bilan)
    va matn sof raqam bo'lsa buyurtma id'si: ichki id (N), 6–8 xonali raqam bo'lsa ko'rinadigan raqam ham (N − 100000)
    — OR. 9+ xonali raqam (telefon) faqat ichki id sifatida.
  - 🔧 FE: qidiruvga ko'rinadigan raqamni o'zgartirmay yuboring (`EL-100081`; oldidagi `#`/`№` va bo'shliqni olib
    tashlash ixtiyoriy). Avval FE «EL-100081» ni «81» ga aylantirardi — endi kerak emas (aks holda «81» telefon bo'yicha
    ham qidiriladi).
- [2026-10-25] 🟢 [order] — **Xavfsizlik:** `customer_id` filtri (mijoz roli doirasi) qidiruv bilan ham AND. Ilgari
  `search` berilsa tushib qolardi. Frontend o'zgarishi shart emas.

### 2026-10-25 — Frontend xatolari jurnali (QKCeGZ3N, 4-band)

Deploy: faqat api-gateway. Migratsiya yo'q.

- [2026-10-25] 🆕 [gateway] — `POST /client-errors` (har qanday kirgan foydalanuvchi; IP bo'yicha 10 / daqiqa) →
  `204`. Tana: `{ code: "ERR-XXXX", message (≤500), path (≤300), stack? (≤4000), component_stack? (≤4000),
  release? (≤64), scope?: "page" | "section" | "app" }`; boshqa maydon — 400. Bazaga yozilmaydi: gateway jurnaliga
  bitta `client_error` qatori (foydalanuvchi id va roli, user-agent bilan) — `docker logs api-gateway | grep client_error`.
  🔧 FE: ilova xato chegarasi sahifa yiqilganda xato kodini jim yuboradi (bir kod — sessiyada bir marta, xato
  bo'lsa e'tiborsiz).

### 2026-10-25 — Buyurtma bildirishnomasi havolasi `/orders/edit/{id}` (OA16fdSq)

Deploy: order-service (migratsiya yo'q).

- [2026-10-25] ✏️ [notification/order] — `order.created`, `order.accepted`, `order.on_way`, `order.sold`,
  `order.cancelled`, `order.returned`, `order.not_accepted` va `order.assigned_to_courier` bildirishnomalarining
  `link` i endi `/orders/edit/{id}` («Buyurtma tafsiloti» marshruti; avval `/orders/{id}` — bunday marshrut yo'q,
  bosilganda 404 edi). Qo'ng'iroqcha, «Bildirishnomalar qutisi» va push (`sw.js` `notificationclick`) shu
  qiymatni ochadi. 🟢 FE: o'zgarish shart emas — eski qatorlardagi `/orders/{id}` uchun `routes.tsx` dagi
  `/orders/:orderId` → `/orders/edit/:orderId` yo'naltirishi (uRkw6lk0) qoladi.
- [2026-10-25] 🟢 [notification/telegram] — `order.cancelled` market «cancel» guruhi matni `parse_mode: HTML`; mijoz
  ismi, manzil, izoh, mahsulot nomlari HTML-escape qilinadi (`<`, `&`, `*` xabarni buzmaydi), uzun qiymat emoji
  yarmida kesilmaydi. FE ta'siri yo'q.

### 2026-10-25 — CSP hisobot manzili `POST /csp-report` (KwodkKWY)

Deploy: faqat api-gateway (env/migratsiya yo'q).

- [2026-10-25] 🆕 [gateway] — `POST /csp-report` — brauzerning CSP buzilish hisobotlari (Report-Only kuzatuvi).
  Autentifikatsiyasiz (`@Public`), per-IP 30/daqiqa (ortig'i 429). Qabul qilinadi:
  `Content-Type: application/csp-report` (eski `report-uri`, `{ "csp-report": { … } }`) va
  `application/reports+json` (Reporting API, `[{ "type": "csp-violation", "body": { … } }]`; boshqa turlar
  e'tiborsiz). Tana ≤ 32 KB (413), boshqa Content-Type yoki gzip — 415, buzuq JSON — 400. Javob doim BO'SH 204 —
  kiritilgan ma'lumot qaytmaydi. Buzilishlar faqat gateway logiga yoziladi (`event: "csp_violation"`, URL'lar
  query'siz, `original-policy` yozilmaydi); RMQ/DB'ga hech narsa ketmaydi. 🔧 FE: `public/_headers` dagi
  `Content-Security-Policy-Report-Only` oxiriga `; report-uri https://api.elchipochta.uz/csp-report` qo'shing
  (ixtiyoriy: `Reporting-Endpoints: csp="https://api.elchipochta.uz/csp-report"` + `; report-to csp` — preflight
  `OPTIONS` uchun sahifa origin'i gateway `CORS_ORIGINS` da bo'lishi kerak, prod'da bor).

### 2026-10-25 — Tuman birlashtirish xatosida qaytarilgan sonlar (Z1c1sNPT, DM-2)

Deploy: logistics-service (gateway filtri o'zgarmagan — yangi maydonlar tekis, `publicErrorData` ularni o'tkazadi).

- [2026-10-25] ✏️ [logistics] — `POST /district/:id/merge` 409/503 javobida `data.details` ga TEKIS sonlar qo'shildi:
  `rolled_back_orders`, `rolled_back_users`, `rolled_back_branches` — A tumanga qaytarilgan buyurtma/foydalanuvchi/filial
  soni (uchala maydon doim bor; boshlanmagan qadam — `0`; jami, o'chirilganlar bilan). Ildizdagi `data.rolled_back`
  (ichma-ich obyekt) avvalgidek FE'ga yetmaydi. `manual_fix: true` da qo'shimcha `details.stranded_order_ids` —
  A ga QAYTMAGAN buyurtmalarning birinchi ≤10 ta ID'si (to'liq ro'yxat — activity log
  `district.merge_compensation_failed`; ID'lar noma'lum bo'lsa maydon yo'q). 🔧 FE (DM-2): maket
  `regions-districts-merge-error` / `-error-unavailable` dagi «… tumaniga qaytarildi: buyurtmalar N · foydalanuvchilar N ·
  filiallar N» ro'yxatini shu maydonlardan chizing; `-error-manual` dagi «№7001 …» — `stranded_order_ids`.

### 2026-10-25 — Ombor ↔ buyurtma oqimi (6kHnNH9j, kontrakt `warehouse_v2_contract.md` B)

Deploy: `migration:run` (1716000000153 — `order_schema.orders.fulfillment_source` sukut `HQ`, `warehouse_id`) →
catalog-service, order-service, api-gateway. Eski buyurtmalar — `HQ`. Tarif va pul hisobi o'zgarmagan.

- [2026-10-25] ✏️ [gateway/order] — **Yaratishda manba:** `POST /orders` tanasida ixtiyoriy
  `fulfillment: "auto" | "hq"` (sukut `auto`; boshqa qiymat — 400). `POST /orders/ai-confirm` — so'rov darajasida
  `fulfillment` (partiyaga) va/yoki `orders[i].fulfillment` (ustun), sukut `auto`.
  - `auto` — buyurtma tumani filialida FAOL ombor bo'lsa va HAMMA mahsulot yetarli bo'lsa → ombor (band bilan),
    aks holda butun buyurtma HQ'dan (bo'linmaydi). `hq` — har doim HQ.
  - Ombordan faqat SUPERADMIN, ADMIN, REGISTRATOR va «Ombordan buyurtma yaratish» kaliti yoqilgan MARKET (va uning
    operatori). Boshqa yaratuvchi (menejer, filial), katalogda yo'q mahsulot (`product_name`), tumansiz buyurtma,
    Telegram bot yo'li — doim HQ.
  - Band bo'lmasa (orada qoldiq tugadi, ombor to'xtatildi, catalog javob bermadi) — xato EMAS: buyurtma HQ bilan
    yaratiladi. 🔧 FE: natijani javobdagi `fulfillment_source` dan ko'rsating (preview — `POST /warehouses/resolve-source`).
- [2026-10-25] ✏️ [order] — **Ombor buyurtmasi yo'li:** `fulfillment_source: "WAREHOUSE"` buyurtma darhol
  `status: "received"`, `branch_id` = ombor filiali (holder BRANCH, pochtasiz, HQ qabulisiz) — filial uni odatdagidek
  kuryerga beradi (`POST /orders/assign-to-courier` yoki kuryer skani; skaner majburiy emas). Kuryerga berish →
  omborda chiqim; kuryer bekor qilib bekor pochta bilan filialga qaytarganda, filial qabul qilishi bilan mahsulot
  o'sha omborga qaytadi va buyurtma `status: "returned_to_market"`, `holder_type: "MARKET"` bilan yopiladi (HQ'ga
  qaytarish va marketga topshirish YO'Q; tracking `action: "warehouse_returned"`). 🔧 FE: WAREHOUSE buyurtmada
  `returned_to_market` ni «Omborga qaytdi» deb ko'rsating. Kuryerga berilmagan ombor buyurtmasini o'chirish
  (SUPERADMIN, `received`) — band bo'shaydi. Qisman sotuvda sotilmagan qism (bola buyurtma) ham qaytganda omborga.
- [2026-10-25] ✏️ [order] — **Javob (ro'yxat va detal):** har buyurtmada `fulfillment_source: "HQ" | "WAREHOUSE"` va
  `warehouse: { id, name, branch_id } | null` (`GET /orders`, `GET /orders/:id`; catalog javob bermasa nom/filial
  `null`). `POST /orders` javobida `fulfillment_source` va `warehouse_id`.
- [2026-10-25] 🆕 [gateway/order] — **Filtr:** `GET /orders?fulfillment_source=WAREHOUSE` (yoki `HQ`; katta-kichik harf
  farqsiz; boshqa qiymat — 400). `GET /orders/export/excel` ham shu filtrni qabul qiladi.

### 2026-10-24 — Ombor ruxsatlari (XtcEyQjb, kontrakt `warehouse_v2_contract.md` A)

Deploy: `migration:run` (1716000000152 — `identity_schema.admins.can_view_warehouse_stock`, sukut `false`) →
identity-service, catalog-service, api-gateway. Yozish ruxsatlari o'zgarmagan (kirim, inventarizatsiya, ombor
ochish/tahrir, chegara, pauza — faqat SUPERADMIN/ADMIN).

- [2026-10-24] ✏️ [gateway] — **O'qish rollari** (`GET /warehouses`, `/warehouses/:id`, `/:id/stock`, `/:id/movements`,
  `/:id/export`): SUPERADMIN, ADMIN, **REGISTRATOR** — hamma omborlar (filial doirasisiz); filial xodimlari —
  MANAGER, BRANCH va filialga biriktirilgan **OPERATOR**, **LOGIST** — faqat o'z filiali ombori (begona — 404,
  filialga biriktirilmagan — 403). COURIER, MARKET, MARKET_OPERATOR, CUSTOMER, INVESTOR — 403 (market o'z qoldig'ini
  `/market/warehouse-stock` da ko'radi). 🔧 FE: «Omborlar» menyusi — shu rollar.
- [2026-10-24] 🆕 [gateway/identity] — **Market operatoriga «Ombordagi qoldiq»**:
  - `PATCH /market-operators/:id/warehouse-access` `{ "can_view_warehouse_stock": boolean }` — faqat MARKET, faqat
    o'z operatori (begona/yo'q — 404; boolean emas yoki ortiqcha maydon — 400; boshqa rol — 403) → 200
    `{ statusCode, message, data: { id, name, phone_number, role, status, market_id, commission_type,
    commission_value, can_view_warehouse_stock, createdAt, updatedAt } }`. Jurnal:
    `identity.market_operator_warehouse_access_changed` (old/new qiymat; o'zgarmasa yozilmaydi).
  - ✏️ `GET /market-operators` — har qatorda `can_view_warehouse_stock: boolean` (sukut `false`).
  - ✏️ `GET /auth/my-profile` — MARKET_OPERATOR uchun `data.can_view_warehouse_stock: boolean` (menyu shu bilan).
  - ⚠️ `GET /market/warehouse-stock` — MARKET_OPERATOR faqat kalit yoqilgan bo'lsa (faqat o'z marketi); aks holda
    403 `{ statusCode: 403, message, code: "WAREHOUSE_STOCK_FORBIDDEN" }`. MARKET va SUPERADMIN/ADMIN — avvalgidek.
    Buyurtma formasidagi `resolve-source` / `availability` — kalitga bog'liq EMAS.
- [2026-10-24] ⚠️ [catalog] — **To'xtatilgan omborga kirim yo'q:** `POST /warehouses/:id/stock-in` PAUSED omborda →
  409 `{ statusCode: 409, message, code: "WAREHOUSE_PAUSED" }`, hech narsa yozilmaydi. Shu `Idempotency-Key` bilan
  pauzadan OLDIN yozilgan AYNI kirim — avvalgi natija (`replayed: true`). Inventarizatsiya va o'qish — ruxsat.
  🔧 FE: to'xtatilgan omborda «Kirim» tugmasini o'chiring / xabarni `code` bo'yicha ko'rsating.
- [2026-10-24] ✏️ [catalog] — **Mas'ul xodim avtomatik:** `POST /warehouses` da `manager_user_id` berilmasa (yoki
  `null`) va `PATCH /warehouses/:id { "manager_user_id": null }` da — filialning birinchi FAOL menejeri
  (foydalanuvchi id bo'yicha eng kichigi); menejer yo'q — `null`. Aniq id — avvalgidek (shu filial menejeri, aks holda
  400). 🟢 `null` endi «olib tashlash» emas, «avtomatik tanlash».
- [2026-10-24] 🟢 [gateway] — xato konvertida `code` endi `WAREHOUSE_PAUSED` va `WAREHOUSE_STOCK_FORBIDDEN` uchun ham
  chiqadi (`libs/common/src/filters/public-error-fields.ts`).

### 2026-10-24 — Ombor moduli (hY7uacJu, frontend kartasi yXC91RRx)

Hammasi YANGI (additive). Deploy: `migration:run` (1716000000143) → catalog-service, identity-service,
api-gateway. Qoldiq faqat dona; `available = on_hand − reserved`; `level`: `ok` Yetarli / `low` Kam qoldi /
`out` Tugagan. Buyurtma bilan bog'lanish (band/chiqim/qaytish) — keyingi order-service PR'i; hozircha
harakatlarda faqat Kirim/Tuzatish yoziladi.

- [2026-10-24] 🆕 [gateway/catalog] — **Omborlar** (`superadmin--warehouse-list`, `-detail`, `manager--warehouse-detail`):
  - `GET /warehouses?status=&region_id=&search=&page=&limit=` (SUPERADMIN, ADMIN; MANAGER/BRANCH — faqat o'z
    filiali) → `{ data: Warehouse[], total, page, limit, counts: {all, active, paused}, summary: {warehouses,
    active, paused, positions, on_hand, reserved, available, reserved_orders, low_count, out_count} }`.
    `Warehouse`: `id, name, status (ACTIVE|PAUSED), branch_id, branch {id,name,type,status,address}, region {id,name},
    manager {id,name,phone_number}, address, effective_address, low_stock_default, note, paused_at, created_at
    («Ochilgan»), summary {positions, markets, on_hand, reserved, available, reserved_orders, low_count, out_count},
    last_movement {type, qty, ref_type, ref_id, created_at}`. «Kam qolgan N ta · M tasi tugagan» = `low_count +
    out_count` / `out_count`. To'xtatilgan omborda «Oxirgi harakat» o'rniga `paused_at`.
  - `GET /warehouses/:id` → `Warehouse` + `movements_count` («Harakatlar» tab soni). Begona filial — 404.
  - `POST /warehouses` (SUPERADMIN, ADMIN) `{ branch_id, name?, manager_user_id?, address?, low_stock_default?, note? }`
    → 201 `Warehouse`. Faqat FAOL REGIONAL/HYBRID filial (aks holda 400); filialda ombor bor — 409; nom berilmasa
    «<filial> ombori»; `manager_user_id` — shu filial MANAGER'i (aks holda 400). 🔧 FE: «Filial» ro'yxati =
    `GET /branches/dispatch-destinations` (yoki filiallar) minus `GET /warehouses` dagi `branch_id`lar.
  - `PATCH /warehouses/:id` (SUPERADMIN, ADMIN) — name/manager_user_id/address/low_stock_default/note (`null` —
    tozalash); filial o'zgarmaydi.
  - `POST /warehouses/:id/pause` / `POST /warehouses/:id/resume` (SUPERADMIN, ADMIN) `{ note? }` → `Warehouse` +
    `changed`. To'xtatilganda qoldiq ko'rinadi, yangi buyurtma tushmaydi.
- [2026-10-24] 🆕 [gateway/catalog] — **Qoldiq va harakatlar**:
  - `GET /warehouses/:id/stock?market_id=&level=ok,low,out&search=&page=&limit=` (o'qish rollari) →
    `{ warehouse, data: [{ stock_id, product, market {id,name}, on_hand, reserved, available, low_stock_threshold,
    threshold, level, last_movement_at }], total, page, limit, facets: { levels {all,ok,low,out}, markets [{id,name,
    positions}] } }`. `product`: `id, name, market_id, sku_code, barcode, image_url, is_deleted, code {value, kind:
    barcode|sku, format: EAN-13|EAN-8|GTIN-14|TEXT|ELC}, weight_kg, length_cm, width_cm, height_cm,
    volumetric_enabled, chargeable_weight_kg («Hisob vazni»), volumetric_weight_kg, chargeable_basis
    (volumetric → «hajm bo'yicha»), measure_missing («O'lchov yo'q»)`. Saralash: qoldiq o'sishi bo'yicha.
  - `GET /warehouses/:id/movements?type=IN,ADJUST,RESERVE,RELEASE,OUT,RETURN&product_id=&market_id=&ref_type=&ref_id=&from=&to=&page=&limit=`
    → `{ warehouse, data: [{ id, type, qty (ishorali), on_hand_after, reserved_after, ref_type, ref_id, order_id
    («Buyurtma №»), note (izoh/sabab), created_at, product {id,name,sku_code,barcode}, market {id,name}, actor {id,name,
    role} }], total, page, limit }`. Yorliqlar: IN Kirim, RESERVE Band, OUT Chiqim, RELEASE/RETURN Qaytdi (bekor),
    ADJUST Tuzatish («Inventarizatsiya: on_hand_after − qty → on_hand_after»).
  - `GET /warehouses/:id/export?market_id=&level=&search=` (o'qish rollari) → `.xlsx` («Excelga yuklash»).
  - `PATCH /warehouses/:id/stock/:productId` (SUPERADMIN, ADMIN) `{ low_stock_threshold: number | null }` («Chegara»;
    `null` — ombor sukuti).
- [2026-10-24] 🆕 [gateway/catalog] — **Kirim va inventarizatsiya** (`superadmin--warehouse-stock-in-dialog`), faqat
  SUPERADMIN/ADMIN, sarlavha **`Idempotency-Key`** MAJBURIY (8–128 `[A-Za-z0-9._:-]`; dialog ochilganda bitta UUID,
  qayta yuborishda o'sha kalit):
  - `GET /warehouses/:id/lookup?code=&market_id=` → `{ warehouse, code, matched_by: sku_code|barcode|null, data:
    [{ product, market, stock: {on_hand, reserved, available, threshold, level} | null }] }`. `data: []` — topilmadi
    (zavod kodi bo'lsa «Mahsulotga bog'lash» = `PATCH /product/:id { barcode }`, keyin kirim); `stock: null` —
    «0 · yangi». Bir kod bir nechta marketda — «Market» tanlansin (`market_id`).
  - `POST /warehouses/:id/stock-in` `{ lines: [{ product_id | code, qty }], market_id?, note? }` → 201 `{ warehouse_id,
    warehouse_name, replayed, positions, total_qty, lines: [{ product_id, product_name, market_id, sku_code, barcode,
    qty, on_hand, reserved, available, movement_id }] }`. Bir mahsulot qatorlari qo'shiladi; biror qator hal
    qilinmasa — 400 (xabarda kodlar), hech narsa yozilmaydi. Takror (shu kalit, shu tarkib) — `replayed: true`;
    shu kalit boshqa tarkib — 409. 🔧 FE: «2 ta skan hal qilinmagan — qo'shilmaydi» qatorlarini yubormang.
  - `POST /warehouses/:id/inventory` `{ lines: [{ product_id | code, counted }], reason, market_id? }` → 201 `{ replayed,
    reason, changed, unchanged, lines: [{ product_id, product_name, counted, before, after, delta, reserved, available,
    movement_id }] }`. `counted` — haqiqiy son; band qilingandan kam — 409.
- [2026-10-24] 🆕 [gateway/catalog] — **Market «Ombordagi qoldiq»** (`market--products-warehouse-stock`):
  `GET /market/warehouse-stock?search=&low_only=true&page=&limit=` (MARKET — faqat o'zi, boshqa `market_id` 403;
  MARKET_OPERATOR — biriktirilgan marketi; SUPERADMIN/ADMIN — `market_id` majburiy) → `{ market_id, warehouses: [{id,
  name, status, branch, region}] (jadval ustunlari), data: [{ product, cells: [{warehouse_id, warehouse_status,
  on_hand, reserved, available, threshold, level}], total_available (faqat FAOL omborlar), total_on_hand, has_low }],
  total, page, limit, summary: { products_total, products_in_warehouses, total_available, warehouses_total,
  warehouses_active, warehouses_paused, active_warehouses_with_stock, low_positions, out_positions } }`. Katak yo'q — «—».
- [2026-10-24] 🆕 [gateway/catalog] — **Buyurtma formasi** (`superadmin--neworders-create-manual-source`), rollar
  SUPERADMIN, ADMIN, REGISTRATOR, MARKET, MARKET_OPERATOR (market — faqat o'z marketi):
  - `GET /warehouses/availability?district_id=|region_id=&market_id=|product_ids=1,2` → `{ region_id, warehouse:
    {id,name,status,branch_id,branch_name,region_id,region_name} | null, items: [{product_id, on_hand, reserved,
    available}] }` — «Omborda: N» (qatori yo'q — «Omborda yo'q»; PAUSED — `items: []`).
  - `POST /warehouses/resolve-source` `{ district_id | region_id, market_id?, items: [{product_id, quantity}] }` →
    200 `{ source: WAREHOUSE|HQ, reason, region_id, warehouse, items: [{product_id, name, required, available,
    enough}], shortages: [{product_id, name, required, available}] }`. `reason`: OK, NO_ITEMS, NO_REGION,
    NO_WAREHOUSE, WAREHOUSE_PAUSED («Tuman ombori to'xtatilgan»), INSUFFICIENT_STOCK («Omborda yetmaydi — butun
    buyurtma HQ'dan»: «kerak 2, bor 1»), MARKET_NOT_ALLOWED, PRODUCT_INVALID. Faqat hisoblaydi — band order-service
    PR'idan keyin buyurtma yaratishda bo'ladi. 🟢 «HQ'ga o'zgartirish» tanlovi va `fulfillment_source` buyurtma
    DTO'siga keyingi PR'da qo'shiladi.
- [2026-10-24] 🆕 [gateway/identity] — **Market «Ombordan buyurtma yaratish»** (`superadmin--users-edit-market-warehouse`):
  `can_order_from_warehouse` (sukut false) market javoblarida (`GET /markets/:id`, `/users/:id` …). O'zgartirish —
  faqat SUPERADMIN/ADMIN: `PATCH /markets/:id/warehouse-order { can_order_from_warehouse }` yoki tahrirlash
  formasidagi `PATCH /users/:id { can_order_from_warehouse }` (boshqa rol / market bo'lmagan — 403/400).

### [2026-10-24] 🆕 ✏️ [logistics / gateway] — Tariflar tarixida «kim o'zgartirdi» ismi + sozlamalar tarixi (47WFHzlx)

- ✏️ `GET /delivery/tariffs` — `data.versions[]` va `data.current.*` qatorlariga `created_by_name` (ism yoki `null`) qo'shildi. Identity javob bermasa ism `null`, javob baribir qaytadi.
- 🆕 `GET /delivery/pricing-settings/history?limit=` (superadmin, admin) — `data.versions[]`: formula sozlamalarining barcha versiyalari (faoli ham, `is_active`), yangisi tepada, har biri to'liq nusxa + `created_by_name`. Nima o'zgargani (masalan `first_kg_included` 1 → 2) qo'shni versiyalarni solishtirib topiladi.
- 🔧 Frontend: «O'zgarishlar tarixi» kartasida muallif ismini ko'rsating va hisob qoidalari o'zgarishlarini ham shu ro'yxatga qo'shing.

### 2026-10-24 — Dashboard paketi (batch D)

Hammasi qo'shimcha (additive) maydonlar — eski FE buzilmaydi.

- [2026-10-24] 🆕 [gateway/analytics] — **`GET /analytics/dashboard?branch_id=`** (6CYRjoZG). Faqat
  SUPERADMIN/ADMIN uchun; boshqa rollarda `branch_id` e'tiborsiz (filial xodimi — doim o'z filiali,
  kuryer/market — o'z kesimi). Noto'g'ri id (raqam emas) — 400. Berilganda `orders`, `markets`, `couriers`,
  `topMarkets`, `topBranches` tanlangan filial kesimida va javobga qo'shiladi:
  `branch_id`, `dailyRevenue: { data: [{ period, label, ordersCount, revenue, profit }], summary } | null`,
  `statusDistribution: { distribution: { <status>: n }, total } | null`,
  `topCouriers: [{ courier_id, courier_name, total_orders, successful_orders, success_rate }] | null` +
  `topCouriersMeta`, `branchDashboard` (filial paneli, `branch.dashboard`). Bo'lak olinmasa — `null` va
  `failed_parts` (`dailyRevenue` / `statusDistribution` / `topCouriers` / `branchDashboard`).
  🔧 FE: `/branches/:id` «Filial ko'rsatkichlari» (KPI 4, muvaffaqiyat, kunlik daromad, holat donut,
  kuryerlar reytingi) shu bitta so'rovdan chiziladi.
- [2026-10-24] ✏️ [gateway/analytics] — **`GET /analytics/kpi?all=true`** va **`GET /analytics/revenue?all=true`**
  («Barchasi», XdKajqLe). Oyna dashboard `all=true` bilan AYNI: butun tarix so'raladi, lekin order-service
  eng so'nggi 366 kunga qisqartiradi (audit C3) — javobda `clamped`, `effective_from`, `effective_to`,
  `max_span_days` (KPI xabari `KPI stats (oxirgi 366 kun)`). KPI ning barcha bo'laklari (kuryerlar, top
  marketlar, yetkazish) shu oynada. 🔧 FE: «Barchasi» da «Yetkazish sifati», «Moliyaviy tahlil», «Kassa»
  yashirilmasin — `all=true` bilan so'ralsin, `clamped=true` da «oxirgi 366 kun» izohi.
- [2026-10-24] ✏️ [analytics] — **KPI `deliveryCount`** (yrLt5oMi): davrda yetkazilgan buyurtmalar soni
  (`onTimeRate`/`averageFulfillmentHours` maxraji). Minimal variant: `onTimeRate` raqamligicha qoladi (0).
  🔧 FE: `deliveryCount === 0` bo'lsa SLA kartasida «0% · past» emas, «O'lchanmagan».
- [2026-10-24] ✏️ [analytics/order] — **«Yo'qotilgan daromad», «Sof foyda» trendi, maqsad** (l9NNdsCH):
  - dashboard `orders.lostRevenue` — davrda bekor qilingan buyurtmalar `total_price` yig'indisi (`cancelled`
    bilan AYNI to'plam, buyurtma bo'yicha bir marta). Registratorda yashirin (profit/tushum kabi).
  - `GET /analytics/revenue` — har bandda `profit`, `summary.totalProfit`, `chart.profitValues`
    (overview `profit` bilan AYNI formula: market tarifi − kuryer ulushi − filial ulushi).
  - dashboard `targets: { successRate: 80 }` — muvaffaqiyat ulushi maqsadi (%) (minimal variant: qotirilgan
    qiymat, sozlama yo'q). 🔧 FE: «Yo'qotilgan daromad» kartasi, «Moliyaviy tahlil» trendida «Sof foyda»,
    «Yaxshi chegarasi · 70%» o'rniga `targets.successRate`.
- [2026-10-24] ✏️ [analytics/order] — **oldingi davr va 14 kunlik seriya** (DwrMygfo), bitta qo'shimcha
  RPC (`order.analytics.trend`), ikkinchi og'ir so'rov kerak emas:
  - dashboard (admin/filial kesimi): `previous: { from, to, acceptedCount, soldAndPaid, cancelled,
    totalRevenue, profit, lostRevenue } | null` — joriy oynadan OLDINGI teng uzunlikdagi oyna («Bugun» →
    kecha, 7 kun → oldingi 7 kun); `series: [{ date: 'YYYY-MM-DD', …shu maydonlar }]` — joriy oyna oxiri
    bilan tugaydigan 14 Toshkent kuni (bo'sh kun 0). Registratorda moliyaviy maydonlarsiz. «Barchasi» da
    `previous: null`. Market/kuryer dashboardida yo'q.
  - `GET /analytics/kpi`: `previous: { from, to, averageOrderValue, averageFulfillmentHours, onTimeRate,
    deliveryCount, cancellationRate } | null` va `series: [{ date, …shu KPI }]` (14 kun). `courierEfficiency`
    uchun oldingi qiymat/seriya yo'q (minimal variant).
  - Bo'lak olinmasa — `previous: null`, `series: null`, `failed_parts: ['trend']`.
  🔧 FE: delta = joriy − `previous`, sparkline — `series`; ikkinchi `analytics/dashboard` so'rovi olib tashlansin.

### 2026-10-24 — Hududlar va pochta paketi (batch E) (tf324cXN, vsmpTweI, ILq3WNL1, tveJKICY, 3HKvAyhm)

- [2026-10-24] ✏️ [logistics] — **`POST /district/:id/merge` xatosida mashina
  o'qiydigan sabab** (tf324cXN). 409/503 javobiga `data` qo'shildi (gateway
  `publicErrorData` orqali; xabar matni o'zgarmadi):

  ```json
  {
    "statusCode": 409,
    "message": "Birlashtirish bekor qilindi: tekshiruv mos kelmadi — …",
    "data": {
      "reason": "count_mismatch",
      "details": {
        "reason": "count_mismatch",
        "kind": "orders",
        "mismatches": [
          { "kind": "orders", "district": "target", "expected": 1254, "actual": 1255 }
        ],
        "from_district_id": "173",
        "to_district_id": "28",
        "manual_fix": false
      }
    }
  }
  ```

  - `reason` (`data.reason` = `data.details.reason`): `count_mismatch` |
    `remote_refused` (servis rad etdi / ulanib bo'lmadi) | `timeout` |
    `invalid_response` | `delete_failed` (tumanni o'chirish/qayta sanash);
  - `details.kind` — qadam: `orders` | `users` | `branches` (`delete_failed`
    da `null`; `count_mismatch` da — birinchi nomuvofiqlik turi);
  - `details.mismatches[]` — faqat `count_mismatch`: `district: 'source'` —
    A tumanda qoldiq (`expected: 0`), `'target'` — B jami ≠ eski B +
    ko'chirilgan; sonlar JAMI (tirik + o'chirilgan);
  - `details.timeout_ms` — faqat `timeout` (15000);
  - `details.manual_fix` — `true` bo'lsa kompensatsiya chala (qo'lda
    tuzatish oynasi), `details.stranded: [{ kind, district_id, count }]`
    (`count: null` — ID'lar noma'lum). To'liq ID ro'yxati faqat activity
    log'da.

  Gateway filtri (`AF0fvJbw`) kengaydi: `details` obyekti ichida bir daraja
  tekis ro'yxat (`mismatches`, `stranded`) ham o'tadi; chuqurrog'i baribir
  tashlanadi. 🔧 FE: «Sabab» qatorini matndan emas, `data.reason` +
  `data.details` dan quring (masalan «Sonlar mos kelmadi — buyurtmalar
  1 255 ta, kutilgan 1 254 ta», «Foydalanuvchilar ko'chirilmadi — servis 15
  soniya ichida javob bermadi»). HTTP kodini ko'rsatmang.

- [2026-10-24] ✏️ [logistics] — **birlashtirish natijasida `moved_live`**
  (vsmpTweI). `200` javobi `data`: `moved` (jami, o'chirilganlar bilan —
  avvalgidek) + yangi `moved_live: { orders, users, branches }` — faqat
  TIRIK yozuvlar, ko'chirish qadamining o'zi sanaydi (B oldin/keyin farqidan
  emas). 🔧 FE: natija oynasidagi «Ko'chirildi» ro'yxati `moved_live` dan
  (izoh «O'chirilgan yozuvlar sanalmaydi»), `target_after − target_before`
  hisobi kerak emas.

- [2026-10-24] ✏️ [activity-log] — **jurnal: `district.merge`** (ILq3WNL1).
  Muvaffaqiyatli birlashtirish endi `action: 'district.merge'` (label
  «Tuman birlashtirildi», kategoriya `logistics`, ton `green`), tavsif
  «Tuman birlashtirildi: <A> (#173) → <B> (#28)»; `old_value` — A snapshot,
  `new_value: { merged_into }`, `metadata: { moved, moved_live,
  source_before, target_before, target_after }`. `district.merge_compensation_failed`
  label'i → «Tuman birlashtirish chala qoldi» (tavsif «Tuman birlashtirish
  chala qoldi: #A → #B», `metadata.reason_code` — yuqoridagi kod). Ikkalasi
  ham `GET /activity-logs/actions` reyestrida (jurnal filtri). Eski
  `deleted` + `merged_into` yozuvlari migratsiyasiz qoladi. 🔧 FE i18n:
  ru «Район объединён» / «Объединение района не завершено», en «District
  merged» / «District merge incomplete».

- [2026-10-24] ✏️ [logistics] — **`GET /post` va `GET
  /post/courier/old-posts`: `orders_total`, `amount_total`** (tveJKICY).
  Sahifa javobiga (`data`, `total`, `page`, … yonida) ikki son qo'shildi —
  JORIY FILTR bo'yicha, barcha sahifalar: `orders_total` — pochtalardagi
  buyurtmalar (`order_quantity`) jami, `amount_total` — pochta summalari
  (`post_total_price`) jami, so'm. Imkonsiz filtr — `0`. Boshqa ro'yxatlar
  (masalan kuryerning barcha pochtalari) o'zgarmadi. 🔧 FE: `/mails/old`
  xulosa qatori (`oldMails.tsx`) — «N ta pochta · M ta buyurtma · S so'm».

- [2026-10-24] ✏️ [branch] — **`GET /transfer-batches/:id`: filial nomlari**
  (3HKvAyhm). Javobga `source_branch` va `destination_branch` — `{ id, name }`
  (`null` — filial topilmadi) qo'shildi; barcha ruxsat etilgan rollar
  (MANAGER/REGISTRATOR/BRANCH ham) ko'radi. 🔧 FE: nom uchun `GET
  branches/:id` (faqat SA/admin) chaqirmang.
- [2026-10-24] 🆕 [branch] — **`GET /transfer-batches/:id/history`**
  (3HKvAyhm; rollar `GET /transfer-batches/:id` bilan bir xil, kirish ham:
  jo'natuvchi yoki qabul qiluvchi filial). Javob `data: [{ id, batch_id,
  user_id, action, action_label, notes, created_at, user: { id, name } |
  null }]`, xronologik (eng eskisi birinchi). `action`: `CREATED` |
  `SENT` | `RECEIVED` | `CANCELLED`, `action_label` — «Yaratildi» /
  «Jo'natildi» / «Qabul qilindi» / «Bekor qilindi». 🔧 FE: «Tarix» kartasi
  shu endpointdan.

### 2026-10-24 — Bildirishnoma paketi (batch F)

- [2026-10-24] ✏️ [notification] **G085w5Qr** — Telegram guruhi nofaol sababi.
  `GET /notifications` (`data.items[]`), `GET /notifications/:id` va `PATCH /notifications/:id`
  javobida yangi maydonlar: `inactive_reason` (`'kicked' | 'left' | 'blocked_on_send' |
  'chat_not_found' | 'manual' | null`) va `inactive_at` (ISO | null). Bot guruhdan chiqarilsa/
  topilmasa sababni bot yozadi; admin `PATCH { is_active: false }` → `'manual'`;
  `PATCH { is_active: true }` → ikkalasi `null`. Migratsiyadan oldingi nofaol qatorlarda `null`.
  🔧 FE: jadval satri va «Shu tur ulangan, lekin nofaol» oynasida sabab matni
  (`kicked`/`left` — «Bot guruhdan chiqarilgan — qayta qo'shing va faollashtiring»,
  `chat_not_found` — «Guruh topilmadi — ulanishni o'chirib, qayta ulang», `manual` — «Qo'lda
  nofaol qilingan», `null` + nofaol — «Sabab noma'lum»).
- [2026-10-24] 🆕 [notification] **KJNHAlGW** — `GET /notifications/me/telegram-groups`
  (rollar: `market`, `market_operator`; `market_id` faqat tokendan — query'dagisi e'tiborsiz,
  boshqa rollar 403, biriktirilmagan operator 403). Javob `data` — har doim 2 element:
  `[{ group_type: 'create'|'cancel', linked, is_active: boolean|null, linked_at: ISO|null,
  inactive_reason: string|null }]`. `group_id`/`bot_slug` qaytmaydi.
  🔧 FE: market kabineti «Telegram guruhi» kartasi («Ulangan · since» / «Ulanmagan») va ulash
  oynasining «Guruh ulanishi kutilmoqda…» holati shu endpointni 3–5 soniyada so'raydi.
- [2026-10-24] ⚠️ [notification] **qXlFQp8Q** — guruh ID'sini qo'lda kiritish yo'li yopildi.
  `POST /notifications` → **410 Gone** (frontend iste'molchisi yo'q edi). `PATCH /notifications/:id`
  endi FAQAT `{ is_active: boolean }` (majburiy) qabul qiladi; `group_id`, `market_id`,
  `group_type`, `id` yuborilsa — 400. Guruh faqat bot havolasi orqali ulanadi
  (`POST /telegram/link-code { purpose: 'market_group' }`). 🟢 FE: hozirgi `useToggleNotification`
  (`{ is_active }`) o'zgarishsiz ishlaydi; «Tahrirlash» (guruh ID) formasi bo'lsa — olib tashlang.
- [2026-10-24] ✏️ [notification] **NwlmrcMf** — `GET /notifications/sent` har qatorida `audience`
  (tafsilot bilan bir xil shakl): `{ recipient_ids?: <son>, roles?: string[], broadcast?: true,
  include_customers?: true, segment?: {...}, recipient?: { id, name, role } }` yoki `null`.
  `recipient` — faqat bitta odamga yuborilganda. 🔧 FE: «Kimga» ustuni (`roles` → «Rol: Kuryer,
  Market», `broadcast` → «Hamma», `recipient_ids` → «Tanlangan ro'yxat», `recipient` → «Ism · Rol»),
  ostida `recipients` soni.
- [2026-10-24] ✏️ [notification] **fb4qy6bd** — kampaniya: `GET /notifications/campaigns`
  (`data.items[]`) va `GET /notifications/campaigns/:id` da `requested_at` (admin so'ragan lahza:
  belgilangan vaqt yoki darhol bo'lsa yaratilgan lahza; eski kampaniyalarda `null`),
  `requested_at_tashkent` va `quiet_hours_shifted` (boolean, eski kampaniyalarda `false`).
  `POST /notifications/campaigns` javobiga ham `requested_at` qo'shildi.
  🔧 FE (KM-8): `quiet_hours_shifted` bo'lsa «So'ralgan: `requested_at_tashkent` → tungi taqiq
  sababli `scheduled_at_tashkent` ga surildi».
- [2026-10-24] ✏️ [notification] **lkQiuyQu** — `GET /notifications/campaigns/:id/undelivered`
  (va CSV eksport): bildirishnoma kampaniyasida ham `phone` endi MASKALANGAN (`***7434`; avval
  `null`). Har `failures[]` elementida yangi `reason_code` (push: `no_subscription`,
  `push_disabled`, `subscription_expired`, `payload_too_large`, `rate_limited`, `push_rejected`,
  `push_service_error`, `network_error`, `push_failed`, `online`, `quiet_hours`, `muted`;
  boshqa kanallar — `<kanal>_reason` kodi yoki `null`). `reason` (xom matn) o'zgarmadi.
  🔧 FE (KM-7): sabab matnini `reason_code` dan tanlang (`failureReasonKey` ga yangi push kodlari).

### 2026-10-24 — Uchala tarif bo'yicha taxminiy narx (6FLyjO6j uchun)

- [2026-10-24] 🟢 [logistics] — yangi `POST /delivery/quote/by-tariff` (rollar `POST /delivery/quote` bilan bir xil):
  body `{ items: [{ product_id } | { weight_kg, length_cm, width_cm, height_cm, volumetric_enabled }], express? }`,
  javob `{ quotes: { city, center, address }, unmeasured_product_ids }` — har biri `POST /delivery/quote` natijasi
  shaklida (`total`, `billableKg`, `volumetricKg`, `extraKg`, `tariff`…), faol versiyasi yo'q tarif — `null`.
  🔧 FE: mahsulot formasidagi «Taxminiy yetkazish narxi» bloki (hudud hali ma'lum emas) shu endpointdan oladi.

### 2026-10-24 — Yetkazish narxi dvigateli: `POST /delivery/quote` + admin tariflar/sozlamalar (DAqXPeSy)

- [2026-10-24] 🆕 [gateway/logistics] — yetkazish narxi endi FORMULA bilan
  hisoblanadi (elchipochta.uz kalkulyatori bilan AYNI: hajmli vazn
  U×K×B/5000, 0.1 kg qadam bilan yuqoriga, birinchi kg bazada, har qo'shimcha
  kg, express × 1.4, jami 500 ga karrali). ⚠️ Hali SOTUV oqimiga ulanmagan —
  buyurtmaning `market_tariff` i avvalgidek market profilidan (KmWO9gTA).

  **`POST /delivery/quote`** — FAQAT hisoblaydi, hech narsa yozmaydi.
  Rollar: superadmin, admin, manager, registrator, operator, logist, branch,
  market (market — faqat O'Z mahsulotlari; begonasi 404). HTTP 200.

  ```json
  {
    "items": [
      { "product_id": "42", "quantity": 2 },
      { "weight_kg": 1.2, "length_cm": 30, "width_cm": 22, "height_cm": 15 }
    ],
    "from_region_id": "1",
    "to_district_id": "77",
    "where_deliver": "center",
    "express": false,
    "pickup_count": 0
  }
  ```

  - `items[]` — BITTA jo'natma (og'irlik va hajmlar qo'shiladi, baza bir
    marta). Har element YO `product_id` (o'lchov catalog'dan; o'lchov
    maydonlari bilan birga — 400), YO `weight_kg` (majburiy) + ixtiyoriy
    L/W/H (uchalasi birga) + `volumetric_enabled`. `quantity` sukut 1. 1–200 element.
  - `from_*` / `to_*` — `region_id` yoki `district_id` (kamida bittasi har
    tomonda; ikkalasi berilsa mos bo'lishi shart). Ikkala uchi ham shahar
    zonasida (Toshkent SHAHRI; Toshkent viloyati — yo'q) → `city` tarifi,
    `where_deliver` e'tiborsiz; aks holda `center` / `address`.
  - Javob `data`: `tariffId`, `base`, `perExtraKg`, `daysMin`, `daysMax`,
    `actualKg`, `volumetricKg`, `billableKg`, `basis` (`weight`|`volume`|null),
    `extraKg`, `extra`, `subtotal`, `expressFee`, `pickupFee`, **`total`**
    (500 ga karrali — UI qayta YAXLITLAMAYDI; pickup KIRMAYDI),
    `totalWithPickup` (kalkulyator jami), `unmeasuredItems`,
    `missingDimensionItems`, `estimated`, `unmeasured_product_ids`,
    `missing_dimension_product_ids`, `route`, `tariff` (versiya), `settings_id`.
  - O'lchovsiz mahsulot narxni jimgina 0 qilmaydi: `estimated: true` va
    ro'yxatlar — formada «N ta mahsulotda o'lchov yo'q, narx taxminiy»
    ogohlantirishi shundan (6NYcXvGy). Narx buyurtma payload'iga
    YUBORILMAYDI (order DTO uni qabul qilmaydi).
  - Xatolar: 400 (validatsiya), 404 (viloyat/tuman/mahsulot), 409 (faol
    tarif/sozlama yo'q), 503 (catalog javob bermadi), 504.

  **Admin (faqat superadmin, admin; boshqa rol — 403):**
  - `GET /delivery/tariffs?tariff_id=&limit=` → `data.current`
    (`{ city, center, address }` — hozir amaldagi versiya) + `data.versions`
    (yangisi tepada; `is_current`, `is_scheduled`).
  - `POST /delivery/tariffs` `{ tariff_id, base_price, extra_per_kg,
    days_min, days_max, valid_from? }` → 201. Narx o'zgarishi — YANGI
    versiya (eski o'chirilmaydi); `valid_from` kelajakda — rejalashtirilgan,
    o'tmishda — 400. Jurnal: `logistics.delivery_tariff_created`.
  - `GET /delivery/pricing-settings` / `PATCH /delivery/pricing-settings`
    (qisman: `volumetric_divisor`, `first_kg_included`, `min_billable_kg`,
    `billable_step_kg`, `round_to`, `pickup_fee`, `pickup_free_from_count`
    (null — hech qachon tekin emas), `express_multiplier`). PATCH yangi
    versiya yozadi; hech narsa o'zgarmasa — versiya ham, jurnal ham yo'q.
    Jurnal: `logistics.delivery_pricing_settings_updated` (eski/yangi qiymat).
  - Boshlang'ich qiymatlar: city 35 000 + 4 000/kg (1 kun), center
    40 000 + 4 000/kg (1–2 kun), address 60 000 + 5 000/kg (2–3 kun);
    pickup 20 000, 10+ posilka tekin (saytdagi 8 000 — eski, GiR4WoBl).
  - Viloyat qatorida yangi maydon `is_city_zone` (`GET /region`, `GET /region/:id`).

  → Frontend: superadmin «Yetkazish tariflari» sahifasi (jadval + yangi
  versiya formasi + sozlamalar), buyurtma formasidagi «Yetkazish narxi
  (taxminiy)» bloki (6NYcXvGy) — `POST /delivery/quote`, debounce bilan.
### 2026-10-24 — Foydalanuvchilar paketi (batch A)

- [2026-10-24] ✏️ [gateway/identity] **kGIjOciz** — `GET /users` har
  qatorida va `GET /users/:id` javobida filial obyektidan tashqari
  `branch_id: string | null` ham (`branch: { id, name } | null` — 2026-10-23
  dan, YEThmZBn). Qiymat `branch.id` bilan bir xil; filialsiz rol,
  biriktirilmagan yoki filial xizmati javob bermasa — `null`.
  🔧 FE: /all-users «Filial» ustuni va SA/admin detal sarlavhasi
  `branch?.name` dan; filtr/solishtirish uchun `branch_id`.

- [2026-10-24] ✏️ [gateway/identity] **2CBnPAeg** — menejerning
  `GET /users` ro'yxati: filial ko'lami (kuryer va filial roli faqat menejer
  filialiga biriktirilganlar; boshqa rollar to'liq) endi identity
  so'rovida. `meta.total`, `meta.totalPages`, `meta.totalUsers` va
  `meta.countsByRole` butun ko'lam bo'yicha, sahifalashdan OLDIN (ilgari
  sahifadan keyin filtrlanib, `total` sahifada qolgan qatorlar soniga teng
  edi va `countsByRole` ko'lamsiz edi). `?role=courier` tabi soni
  `countsByRole.courier` bilan bir xil; `?role=branch` ham endi ko'lamda.
  Superadmin/admin uchun o'zgarish yo'q.
  🔧 FE: menejerda tab sonlarini yashirish shart emas — `countsByRole` dan
  chizing.

- [2026-10-24] 🆕 [gateway/identity] **yA31z7Rr** — `GET /users` yangi
  query `telegram_linked=true|false` (katta-kichik harf farqsiz): `true` —
  Telegram boti ulangan, `false` — ulanmagan (qatordagi `telegram_linked`
  bilan aynan bir xil qoida). Boshqa filtrlar (`role`, `status`, `search`,
  `region_id`, menejer ko'lami) bilan AND; `meta.total` / `countsByRole`
  filtrdan keyin, sahifalash server tomonda. Bo'sh qiymat — filtr yo'q;
  boshqa qiymat — **400** `"telegram_linked faqat true yoki false bo'lishi mumkin"`.
  Ixtiyoriy `meta.telegram_linked_counts` qo'shilmadi (chip sonlari kerak
  bo'lsa — alohida so'rov `?telegram_linked=…&limit=1` → `meta.total`).
  🔧 FE: «Barchasi · Ulangan · Ulanmagan» chiplari shu parametrni yuborsin
  (joriy sahifani frontendda filtrlamang).

- [2026-10-24] ✏️ [identity] **x6IO746K** — market operatori marketi:
  - `GET /users` qatorlari va `GET /users/:id`: `role = market_operator`
    bo'lsa `market: { id, name } | null` (market o'chirilgan / topilmagan /
    biriktirilmagan — `null`). Boshqa rollarda `market` kaliti YO'Q. Faqat
    `id` va `name` — token, tariflar yo'q (GvL6ZFAd). Sahifa uchun bitta
    so'rov (N+1 yo'q).
  - `GET /auth/my-profile` (N13): operatorga `market: { id, name,
    add_order } | null`.
  🔧 FE: /all-users operator qatorida «Filial» o'rnida `market.name`
  (telefon kartasida «· Baraka Shop»); operator kabinetida market nomi va
  `add_order` — `my-profile.market` dan.

- [2026-10-24] ✏️ [gateway/identity] **DtKKY0V8** — kuryer `district_id`:
  - `POST /couriers` (`CreateCourierRequestDto`) — yangi ixtiyoriy
    `district_id: string | null` (raqamli satr). Tuman mavjud va kuryer
    viloyatiga (filial viloyati) tegishli bo'lishi kerak; viloyati yo'q (HQ)
    kuryerda — faqat mavjudligi. Xatolar: **400** `"district_id raqamli ID
    bo'lishi kerak"`, **400** `"Tuman topilmadi"`, **400** `"Tuman
    foydalanuvchining viloyatiga tegishli emas"`, **503** logistika javob
    bermasa — kuryer yaratilmaydi. Berilmasa / `null` — tumansiz.
  - `PATCH /users/:id` (`UpdateAdminRequestDto` / identity `UpdateUserDto`)
    — `district_id` 2026-10-23 dan bor (YEThmZBn), qoida bir xil;
    o'zgarish yo'q.
  🔧 FE (FY-5): kuryer yaratish formasida tuman tanlovi `district_id` bilan
  yuborilsin.

- [2026-10-24] ✏️ [gateway/identity] **9444UAa8** — `GET /customers/suggest`
  endi qo'shimcha raqam (`extra_number`) bo'yicha ham topadi (asosiy
  telefondagi kabi normallashtirilgan raqamlar; eski formatdagi yozuvlar ham).
  Har taklifda yangi maydon `matched_by: "phone" | "extra_number" | "name"`
  (ustuvorlik: asosiy telefon). Qo'shimcha raqam bo'yicha topilgan mijoz ham
  market doirasidan o'tadi — shu marketda buyurtmasi bo'lmasa taklif
  qilinmaydi (admin — doirasiz). Ichki `identity.customer.search` RPC'ga
  ixtiyoriy `match_extra_number: true` qo'shildi; buyurtmalar ro'yxati
  qidiruvi uni yubormaydi — natijasi o'zgarmagan.
  🔧 FE (hiqRNhkI): `matched_by === "extra_number"` bo'lsa qatorda
  «Qo'shimcha raqam: {extra_number}» belgisi (desktop ro'yxati va telefon
  varaqasi); taxmin qilmang.

### 2026-10-24 — «Buyurtmalar paketi (batch B)»: extra-cost so'rovchi/raqam, market operatori ruxsatlari, SA/admin biriktirish, transfer-batches jami

- [2026-10-24] ✏️ [order] — `GET /orders/extra-cost-approvals` (va
  `POST /orders/extra-cost-approvals/:id/approve|reject` javobidagi
  `data.approval`) — har bir so'rovga YANGI maydonlar (0Ngp09FG):

  ```json
  {
    "order_id": "76",
    "order_number": "EL-100076",
    "requested_by_user_id": "301",
    "requested_by_role": "courier",
    "requested_by": { "id": "301", "name": "Ali Kuryer" }
  }
  ```

  `order_number` — mijozga ko'rinadigan raqam (ichki `order_id` emas).
  `requested_by.name` — identity'dan; javob bermasa yoki foydalanuvchi
  o'chirilgan bo'lsa `null` (ro'yxat baribir qaytadi). Kuryerning o'z 202
  javobida (`approval_required`) `requested_by.name` doim `null`. Eski
  maydonlar o'zgarmagan.
  🔧 FE (`ExtraCostApprovals.tsx`): `№{order_id}` → `order_number`,
  «rol · #user_id» → `requested_by.name ?? requested_by_role · #id`.

- [2026-10-24] ✏️ [order] — `GET /orders/extra-cost-approvals`
  MARKET_OPERATOR uchun ochildi, FAQAT o'qish (6QLF7nst): faqat o'zi
  biriktirilgan market (identity `user.market_id`) so'rovlari; marketga
  biriktirilmagan operator — 403 «Operator hech qaysi marketga
  biriktirilmagan». `approve` / `reject` operatorga avvalgidek 403.
  🔧 FE (MO-8): operator kabinetida ro'yxatni ko'rsating, «Tasdiqlash /
  Rad etish» tugmalarini yashiring.

- [2026-10-24] ✏️ [order] — `GET /orders/markets/:marketId/new`
  MARKET_OPERATOR ga ochildi (nCAFnqIe, tanlov: backend yo'li —
  `GET /orders?status=new` ga o'tish shart emas): `:marketId` operator
  marketi bo'lishi shart; boshqa market — 403 «market_operator role cannot
  query other market_id», biriktirilmagan — 403. Javob market roli bilan bir
  xil (filial `source='branch'` buyurtmalarisiz, kuryer tarifi/ulushi va
  filial ulushisiz).

- [2026-10-24] ✏️ [order] — `POST /orders` MARKET_OPERATOR ga ochildi
  (OfRSoRUX, ega qarori MO-S3 — qo'lda yaratish): market server tomonda
  (operator marketi); tanadagi `market_id` E'TIBORSIZ (400 emas — jimgina
  ustidan yoziladi, market roli bilan bir xil); marketga biriktirilmagan
  operator — 400. `operator` bo'sh bo'lsa server operator ismini yozadi,
  `operator_id` — operatorning o'zi (komissiya AI yo'li bilan bir xil).
  `Idempotency-Key` ishlaydi. Javob — market proyeksiyasi. Market
  `add_order: false` bo'lsa — 400. Qo'shimcha (N11): `GET /region`,
  `GET /district` ham MARKET_OPERATOR ga ochildi (forma uchun).
  🔧 FE (MO-7): operatorga «Qo'lda» tugmasini oching; `market_id`
  yubormang (yuborilsa e'tiborsiz).

- [2026-10-24] ✏️ [order/logistics] — `POST /orders/assign-to-courier`
  SUPERADMIN/ADMIN ga ochildi (1gxmqLj5, (a) yo'l). Body'ga ixtiyoriy
  `branch_id` (satr) qo'shildi:

  ```json
  { "order_ids": ["201", "202"], "courier_id": "55", "branch_id": "20" }
  ```

  SA/admin uchun qoidalar: barcha orderlar BITTA filialda (aks holda 400
  «aralash filialdan»); kuryer AYNAN shu filialning COURIER a'zosi (aks
  holda 400 «Courier ushbu filialga COURIER sifatida biriktirilmagan»);
  `branch_id` berilsa — orderlar filialiga mos bo'lishi kerak (400
  «Tanlangan filial …»). Holat/kuryer/tashqi posilka qoidalari menejerniki
  bilan bir xil. Menejer/registrator xulqi o'zgarmagan (`branch_id` ularga
  e'tiborsiz).
  🔧 FE (`/dispatch`): SA/admin uchun «Biriktirish» ni qayta oching; filial
  tanlansa `branch_id` ni yuboring, kuryerlar ro'yxatini shu filialdan oling.

- [2026-10-24] 🔧 [branch/order] — `GET /transfer-batches` statussiz yoki
  `status=PENDING`: `meta.total` / `meta.totalPages` endi HAQIQIY jami
  (15N7AHkp). Bir yo'nalishdagi (manba, manzil, yo'nalish, hudud) PENDING
  partiyalardan faqat eng yangisi qaytadi — yig'ish SQL'da, sahifalar
  orasida takror yo'q. Tartib: `createdAt DESC, id DESC`. Javob shakli
  o'zgarmagan.
  🔧 FE: /returns «jami N ta paket» va sahifalash, /batches «Yangi» /
  «Qaytarilgan» tab sonlari `total`/`totalPages` dan to'g'ri ishlaydi;
  `fetchAllTransferBatches` dagi «bo'sh sahifagacha yurish» aylanmasini
  `totalPages` ga qaytarsa bo'ladi.

### 2026-10-24 — Moliya va boshqalar paketi (batch C) (guzrGySp, su4IYGCN, Is1zvHN7, yiFTzkzH, AF0fvJbw, ISeuwhfr, R6R8BLGA)

- [2026-10-24] ✏️ [gateway] — **xato javobida ixtiyoriy `data`** (AF0fvJbw).
  Servis xatoni sabab/son bilan tashlasa, konvertga `data` qo'shiladi — FAQAT
  uch kalit, tozalangan holda:

  ```json
  {
    "statusCode": 400,
    "message": "Bu tumanda 5 ta buyurtma, 1 ta filial bor, shuning uchun uni o'chirib bo'lmaydi. …",
    "data": {
      "reason": "district_in_use",
      "usage": { "orders": 5, "users": 0, "branches": 1, "transfer_batches": 0 }
    },
    "trace_id": "…"
  }
  ```

  - `reason` — mashina kodi (`^[a-z][a-z0-9_]{0,63}$`; matnni emas, shuni
    tekshiring). Hozir yuboriladiganlari: `district_in_use`
    (`DELETE /district/:id`), `region_has_districts`, `region_in_use`
    (`DELETE /region/:id`; `usage` da `posts` ham bor);
  - `usage` — `{ kalit: son }` (bog'langan yozuvlar soni);
  - `details` — tekis obyekt yoki tekis obyektlar ro'yxati (≤ 50), qiymatlar
    faqat satr/son/boolean/null.

  Boshqa kalitlar (masalan `hint`, `post_id`, `blocked`), stack va ichki
  xabarlar CHIQMAYDI; hech biri qolmasa `data` umuman yo'q — konvert
  avvalgidek `{ statusCode, message, code?, trace_id? }`. 🔧 FE: `data`
  ixtiyoriy deb o'qing (`error.response.data.data?.reason`); o'chirish
  oynasida sonlarni matndan emas, `data.usage` dan oling.
- [2026-10-24] 🆕 [logistics] — `GET /district/:id/usage` (ADMIN, SUPERADMIN)
  → `data: { orders, users, branches }` (Is1zvHN7) — tumanga bog'langan
  O'CHIRILMAGAN buyurtma/foydalanuvchi (mijoz/kuryer/market)/filial soni;
  `DELETE /district/:id` 400 javobidagi `data.usage` bilan AYNI sanoq.
  Hammasi 0 → o'chirsa bo'ladi. 400 — `id` raqam emas; 404 — tuman yo'q;
  503 — order/identity/branch servislaridan biri javob bermadi (sonlar
  taxmin qilinmaydi, "0" ko'rsatmang). 🔧 FE: o'chirish/birlashtirish
  oynasini ochishda shu bilan oldindan ko'rsating.
- [2026-10-24] ✏️ [finance] — `GET /finance/financial-balance/top-impacts`
  `data.items[]` qatorlarida `created_by_user: { id, name, role } | null`
  (guzrGySp) — `financial-balance/history` bilan bir xil (avtomatik yozuvda
  `null`). 🔧 FE: Balans → Tahlil «Kiritgan» ustunida `#id` o'rniga
  `created_by_user.name`.
- [2026-10-24] ✏️ [investor] — `GET /investors/me/investments`
  `data.summary.range_amount: number` (su4IYGCN) — `from_date`/`to_date`
  oralig'idagi investitsiyalar yig'indisi (ro'yxat filtri bilan bir xil
  chegaralar, sahifadan qat'i nazar; oraliq berilmasa `total_amount` ga
  teng; oraliqda yozuv yo'q — `0`). `total_amount` avvalgidek butun davr.
  Xuddi shu maydon admin ro'yxatlarida ham bor (`GET /investments`,
  `GET /investors/:investor_id/investments`) — o'sha umumiy hisob.
- [2026-10-24] ✏️ [markets] — `GET /markets` MANAGER/REGISTRATOR/BRANCH
  ko'rinishi: `{ id, name, status, phone_number, tariff_home, tariff_center,
  default_tariff }` (yiFTzkzH; tarif yo'q bo'lsa `null`). Login, kassa,
  sozlamalar avvalgidek yo'q; COURIER — `{ id, name, status }` (o'zgarmagan).
  🔧 FE (CS-E): buyurtma yaratishda uyga/markazga narxni shu maydonlardan
  ko'rsating.
- [2026-10-24] ✏️ [search] — `GET /search` market operatori uchun (ISeuwhfr):
  buyurtma hujjatlari endi BIRIKTIRILGAN MARKETI bo'yicha (ilgari operator
  hech qaysi buyurtmani topmasdi). Market identity `user.market_id` dan
  olinadi (so'rov parametri yo'q); biriktirilmagan bo'lsa buyurtma chiqmaydi,
  boshqa natijalar (mahsulot, pochta, hudud) avvalgidek. Javob shakli
  o'zgarmagan.
- [2026-10-24] 🟢 [gateway] — skaner route'lari rate limiti (R6R8BLGA):
  `GET /scan/:token`, `POST /orders/receive`, `POST /orders/scan-assign` —
  per-IP limit 60 → **300/daqiqa** (`SCAN_THROTTLE_LIMIT`, global
  `THROTTLE_LIMIT` dan past emas). Hisoblagich avvalgidek IP + route bo'yicha
  (filial bitta IP ortida bir nechta telefon skanerlasa 429 olmasin). Boshqa
  route'lar o'zgarmagan. FE o'zgarishi shart emas.

### 2026-10-24 — «Sessiyalar»: chiqarilgan qurilma SHU ZAHOTI login sahifasiga (socket `auth:session_revoked`) (Notion «Elchi Pochta» #3)

- [2026-10-24] 🆕 [gateway/realtime] — sessiya yopilganda o'sha qurilmaning
  ochiq socketlari darhol xabar oladi va server tomonidan uziladi. Ilgari
  qurilma faqat keyingi HTTP so'rovida (401 → refresh 401 → login) bilardi;
  socket ulangan bo'sh tab bir necha daqiqa ekranda qolardi.

  **Hodisa** (namespace `/realtime`, faqat `sid` li token bilan ulangan
  socketlarga — login/refresh tokenlari; Telegram Mini App / bot tokenida
  `sid` yo'q):

  ```json
  // event: "auth:session_revoked"
  { "session_id": "3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d", "reason": "revoked_by_owner" }
  ```

  `reason`:
  - `revoked_by_owner` — egasi boshqa qurilmadan «Chiqarish» yoki «Boshqa
    barcha qurilmalardan chiqish» (`DELETE /auth/sessions/:id`,
    `POST /auth/sessions/revoke-others`);
  - `password_changed` — parol almashtirildi: o'zi (`PATCH /auth/my-profile`
    — joriy qurilmadan BOSHQA hammasi) yoki admin tikladi (`PATCH /users/:id`
    — o'sha foydalanuvchining HAMMA qurilmasi);
  - `logout` — shu sessiya «Chiqish» qildi (`POST /auth/logout`): AYNI
    sessiyaning boshqa tablari ham chiqadi; «Chiqish» bosgan tabning o'ziga
    ham keladi — u allaqachon chiqyapti, e'tiborsiz qoldirsa bo'ladi;
  - `security_reset` — server yopdi (parol / telefon / rol almashgan,
    bloklangan yoki o'chirilgan akkaunt — soatlik tozalashda yoki shu
    qurilma refresh qilganda).

  **Uzish:** hodisadan ~250 ms keyin server socketni uzadi —
  socket.io-client `disconnect` hodisasi `reason = "io server disconnect"`
  bilan keladi va mijoz O'ZI QAYTA ULANMAYDI (qo'lda `socket.connect()`
  chaqirmang). Hodisa har doim uzishdan OLDIN keladi. Boshqa qurilmalar va
  boshqa sessiyalar socketlariga tegilmaydi.

  **Ulanishni rad etish:** yopilgan sessiya tokeni bilan ulanish (masalan,
  kick paytida tarmoq uzilgan bo'lsa va keyin qayta ulansa) HTTP bilan bir
  xil qoida bo'yicha tekshiriladi va rad etiladi — avval `error` hodisasi,
  keyin server uzadi:

  ```json
  // event: "error"
  { "message": "Session revoked", "code": "SESSION_REVOKED" }
  ```

  Soxta / muddati o'tgan token — avvalgidek `error`, endi `code` bilan:
  `{ "message": "Unauthorized", "code": "UNAUTHORIZED" }` (`message`
  o'zgarmagan). `connected` hodisasiga yangi maydon: `{ user_id, roles,
  session_id }` (`sid` siz tokenda `session_id: null`).

  🔧 FE (`shared/lib/realtime.ts`):
  1. `socket.on('auth:session_revoked', ({ session_id, reason }) => …)` —
     `session_id` joriy tokenning `sid` i bo'lsa (yoki tekshirmasdan — server
     faqat shu sessiyaga yuboradi): access tokenni va auth holatini tozalang,
     refresh QILMANG, login sahifasiga o'ting va
     «Sessiyangiz boshqa qurilmadan yopildi» deb ko'rsating
     (`reason: 'logout'` — xabarsiz chiqish; `password_changed` — «Parol
     o'zgartirildi, qayta kiring» deyish mumkin);
  2. `socket.on('error', e => e?.code === 'SESSION_REVOKED' && …)` — xuddi
     shu chiqish oqimi; `UNAUTHORIZED` — avvalgidek (token yangilab qayta
     ulanish);
  3. `disconnect` `reason === 'io server disconnect'` dan keyin avtomatik
     qayta ulanishni yoqmang (1-banddagi chiqish allaqachon ishlagan).

  HTTP xulqi o'zgarmagan: yopilgan sessiya tokeni keyingi so'rovda 401
  «Session revoked», refresh ham 401 — socket ulanmagan tab avvalgidek shu
  yo'l bilan chiqadi.


### 2026-10-24 — Mahsulot o'lchovi (MH-3, 9fHyFp3y) + shtrix kod / Elchi kodi (hY7uacJu)

- [2026-10-24] ⚠️ [catalog] — `POST /product` (multipart) endi o'lchovni
  MAJBURIY qiladi (MH-S1): `weight_kg` (kg, ko'pi bilan 3 kasr, `1,5` ham
  qabul qilinadi), `length_cm`, `width_cm`, `height_cm` (sm, butun son).
  Chegaralar: 0.001..1000 kg, 1..1000 sm (ega tasdiqlaguncha). Bittasi
  yo'q, bo'sh, `null` yoki noto'g'ri (`ikki`, `-5`, `30.5`, `1e2`) — 400.
  Ixtiyoriy: `volumetric_enabled` (`true`/`false`, `1/0`, `on/off`;
  berilmasa — `true`), `barcode`. **Lockstep deploy:** hozirgi forma faqat
  `name` + `image` yuboradi — backend 6FLyjO6j (forma) bilan BIRGA chiqmasa,
  UI'dan mahsulot yaratish 400 bilan sinadi; teskarisi ham (eski backend
  yangi maydonlarni `forbidNonWhitelisted` bilan 400 qiladi). 🔧 FE: 6FLyjO6j
  formasi — to'rtta maydon majburiy, raqamlar satr bo'lib ketishi mumkin.
- [2026-10-24] ✏️ [catalog] — `PATCH /product/:id` va `PATCH /product/my/:id`
  shu maydonlarni ixtiyoriy qabul qiladi (market / operator ham o'z
  mahsulotining o'lchovi va kodini tuzata oladi). O'lchov FAQAT yangi qiymat
  bilan almashtiriladi: `weight_kg` / `length_cm` / ... uchun `null` yoki
  `''` — 400. 🔧 FE: o'zgarmagan yoki bo'sh o'lchov maydonini PATCH'da
  UMUMAN yubormang. Uzunlik/kenglik/balandlik — uchalasi yoki hech biri
  (o'lchovsiz eski mahsulotga faqat bittasini yuborish — 400).
- [2026-10-24] ✏️ [catalog] — mahsulot javoblarida (`GET /product`,
  `/product/:id`, `/product/my-products`, `/product/market/:id`, create /
  update) yangi maydonlar: `weight_kg` (son | null), `length_cm`,
  `width_cm`, `height_cm` (butun | null), `volumetric_enabled` (bool),
  `barcode` (satr | null), `sku_code` (`ELC-P-000123`, avtomatik,
  o'zgarmas; body'da yuborilsa — 400). Eski va hamkor yaratgan mahsulotlarda
  o'lchov `null` («o'lchov kutilmoqda»).
- [2026-10-24] 🟢 [catalog] — `barcode`: EAN/UPC/GTIN nazorat raqami
  tekshiriladi (noto'g'ri — 400), market ichida yagona (409, xabarda band
  qilgan mahsulot nomi), `''` / `null` — kodsiz (PATCH'da tozalash). GTIN
  **kanonik** shaklda saqlanadi va javobda shunday qaytadi: UPC-A (12 xona)
  va GTIN-14 → 13 xonali EAN shakli (`036000291452` → `0036000291452`),
  UPC-E (8 xona, 0/1 bilan) → kengaytirilgan UPC-A ning shu shakli
  (`04963406` → `0049000006346`; skaner UPC-E ni 8 xona yoki UPC-A qilib
  yuborsa ham bitta mahsulot topiladi), GTIN-8 → 8 xona; GS1 DataMatrix
  («Asl belgisi») / GS1 QR'dan GTIN
  ajratiladi; zavod QR matni aynan saqlanadi; `ELC-P-…` bu maydonga
  yozilmaydi. Raqamni SATR sifatida yuboring (JSON raqami — 400).
- [2026-10-24] 🆕 [catalog] — `GET /product/by-code/:code` (skaner): `ELC-P-…`
  (registrga befarq, nolsiz ham) — `sku_code`; boshqasi — `barcode`
  (8/12/13/14 xonali skan, jumladan UPC-E, va DataMatrix ham kanonik
  qiymatni topadi). Javob
  `{ data: Product[], total, matched_by: 'sku_code' | 'barcode' | null }`;
  topilmasa 200 + `data: []` (404 emas). Rollar — `GET /product/:id` bilan
  bir xil; market — faqat o'zi (boshqa `market_id` — 403), market operatori —
  biriktirilgan marketi (biriktirilmagan — 400), xodim — ixtiyoriy
  `?market_id=`. Kod 1..512 belgi; `encodeURIComponent` bilan yuboring (QR
  matnida `/` bo'lishi mumkin). Kartada `/products/by-code` deb yozilgan —
  haqiqiy yo'l `/product/by-code/:code`. 🔧 FE: openapi qayta generatsiya
  (`CatalogGatewayController_findByCode`, x-roles).
- [2026-10-24] 🟢 [catalog] — `GET /product?search=` endi aniq `ELC-P-…` va
  shtrix kod (kanonik) bo'yicha ham topadi; global qidiruv (`/search`)
  kodlarni teg sifatida OLMAYDI (faqat nom).
### 2026-10-23 — «Sessiyalar»: yangi qurilma 48 soat boshqalarni chiqara olmaydi; parol almashtirish boshqa qurilmalarni darhol chiqaradi (Notion «Elchi Pochta» #3)

- [2026-10-23] ⚠️ [auth] — "Telegram'dagidek" 48 soatlik qulf: joriy
  sessiya shu qurilmadan BIRINCHI kirilganiga (`first_logged_in_at`; shu
  qurilma qayta kirsa o'zgarmaydi) 48 soat to'lmagan bo'lsa u BOSHQA
  sessiyalarni yopa olmaydi — eskisini ham, yangisini ham. Barcha rollar
  uchun. `DELETE /auth/sessions/:id` va `POST /auth/sessions/revoke-others`
  → **403**, hech narsa yopilmaydi:

  ```json
  {
    "statusCode": 403,
    "message": "Xavfsizlik uchun yangi qurilmadan boshqa sessiyalarni chiqarib bo'lmaydi — 25.10.2026 12:00 (Toshkent) dan keyin mumkin",
    "code": "SESSION_TOO_NEW",
    "available_at": "2026-10-25T07:00:00.000Z",
    "trace_id": "7d0c2a4e-1b2f-4c3d-9e8f-0a1b2c3d4e5f"
  }
  ```

  `code` — mashina o'qiydigan kod (matnni emas, shuni tekshiring);
  `available_at` — qachondan mumkin (ISO, UTC; = `first_logged_in_at` + 48
  soat; matndagi vaqt Toshkent bo'yicha, daqiqa yuqoriga yaxlitlangan).
  Boshqa xatolarning konverti o'zgarmagan (`{ statusCode, message,
  trace_id? }`). ESKI sessiya (≥ 48 soat) yangisini chiqara oladi — o'g'ri
  yangi qurilmadan egani chiqara olmaydi, ega esa uni chiqaradi. «Chiqish»
  (`POST /auth/logout`, o'z sessiyasi) qulfsiz. Yangi: qulf yoqilganda `sid`
  siz token (Telegram Mini App) bilan `DELETE /auth/sessions/:id` → 400
  «Joriy sessiya aniqlanmadi — qayta kiring» (revoke-others avvaldan shunday).
  Muddat serverda sozlanadi (`SESSION_REVOKE_LOCK_HOURS`, sukut 48; `0` —
  o'chiq) — FE raqamni qattiq yozmasin, `available_at` dan foydalansin.
- [2026-10-23] ✏️ [auth] — `GET /auth/sessions` `data` ga ikki yangi
  maydon (eskilari joyida):
  - `can_revoke_others: boolean` — joriy sessiya hozir boshqalarni yopa
    oladimi;
  - `revoke_available_at: string | null` — qachondan (ISO); hozir mumkin
    bo'lsa yoki joriy sessiya aniqlanmasa (`sid` siz token) — `null`.

  ```json
  {
    "statusCode": 200,
    "message": "success",
    "data": {
      "active_count": 2,
      "can_revoke_others": false,
      "revoke_available_at": "2026-10-25T07:00:00.000Z",
      "sessions": [
        { "id": "3f2b8c1e-…", "status": "active", "first_logged_in_at": "2026-10-23T07:00:00.000Z", "current": true, "…": "…" },
        { "id": "9a1c2b3d-…", "status": "active", "first_logged_in_at": "2026-09-01T05:00:00.000Z", "current": false, "…": "…" }
      ]
    }
  }
  ```

  🔧 «Sessiyalar» bo'limi: `can_revoke_others === false` bo'lsa
  «Chiqarish» va «Boshqa sessiyalardan chiqish» tugmalarini o'chirib (disabled)
  izoh ko'rsating: «Xavfsizlik uchun yangi qurilmadan boshqa sessiyalarni
  {revoke_available_at → Toshkent vaqti} dan keyin chiqarish mumkin. Shoshilinch
  bo'lsa — parolni almashtiring». Baribir 403 `SESSION_TOO_NEW` kelsa (masalan,
  sahifa eskirgan) — `available_at` bilan xuddi shu izoh, ro'yxatni yangilang.
- [2026-10-23] ⚠️ [auth/identity] — parol almashtirish boshqa qurilmalarni
  DARHOL chiqaradi (yangi qurilma egasi uchun «qochish yo'li» — 48 soatlik
  qulfga bog'liq emas):
  - `PATCH /auth/my-profile` `{ password }` (o'zi): joriy sessiyadan BOSHQA
    barcha sessiyalar shu zahoti yopiladi — ularning access tokeni keyingi
    so'rovdayoq 401 «Session revoked», refresh ham 401. JORIY qurilma
    ishlashda davom etadi, refresh ham ishlaydi (ilgari o'z parolini
    almashtirgan qurilma ham ~1 soatdan keyin login sahifasiga chiqardi).
    `sid` siz token (Telegram Mini App) bilan — hammasi yopiladi;
  - `PATCH /users/:id` `{ password }` (superadmin / admin / menejer boshqa
    foydalanuvchi parolini tiklaydi): o'sha foydalanuvchining BARCHA
    sessiyalari darhol yopiladi (ilgari ular ~1 soatgacha ishlab turardi).
    `:id` — o'zi bo'lsa, `my-profile` dagidek joriy sessiya qoladi;
  - parol bilan birga login telefoni ham almashsa — avvalgidek hammasi,
    joriy ham.

  Javob shakli avvalgidek (`{ statusCode: 200, message: 'User yangilandi',
  data: <user> }`), parol almashganda qo'shimcha `sessions_revoked: <n>` —
  nechta sessiya yopildi. Parol almashtirish uchun eski parol so'ralmaydi
  (avvalgidek). 🔧 FE: o'z parolini almashtirgandan keyin qayta login
  talab qilmang (sessiya saqlanadi); muvaffaqiyat xabarida «Boshqa
  qurilmalardan chiqildi: {sessions_revoked} ta» deyish mumkin, keyin
  «Sessiyalar» ro'yxatini yangilang. OTP / «parolni unutdim» oqimi yo'q
  (OTP faqat `login` va `phone_verify`).

### 2026-10-23 — Rollback «Bekor qilish» sotilgan buyurtmadan (y2RarzlT); kuryer filiali va tumani (YEThmZBn)

- [2026-10-23] ✏️ [identity] — `GET /users/:id` javobida yangi maydon
  `branch: { id, name } | null` — kuryer / menejer / registrator / filial
  xodimi biriktirilgan filial (`branch_users`). Biriktirilmagan, filial
  o'chirilgan yoki filial xizmati javob bermasa — `null` (javob baribir 200);
  boshqa rollarda doim `null`. `region` avvalgidek. 🔧 FE: kuryer tafsilotida
  sarlavha «Kuryer · {branch.name}» va «Profil ma'lumotlari → Filial» shu
  maydondan (hozir menejer ko'rinishida ko'ruvchining O'Z filiali
  ko'rsatiladi).
- [2026-10-23] ✏️ [identity] — `GET /users` ro'yxatining HAR qatorida ham
  `branch: { id, name } | null` (`/users/:id` dagi bilan bir xil qoida:
  kuryer / menejer / registrator / filial xodimining eng so'nggi faol
  biriktiruvi; filial o'chirilgan yoki biriktirilmagan — `null`; boshqa
  rollar — `null`). Filial sahifadagi qatorlar uchun BITTA so'rov bilan
  olinadi. Filial xizmati javob bermasa (≈3 s) yoki xato bersa ro'yxat
  baribir 200 — hamma qatorda `branch: null` (ro'yxat yiqilmaydi). `meta`,
  filtrlar va sahifalash o'zgarmagan. 🔧 FE: superadmin ro'yxatidagi
  «Filial» ustuni va telefonda «telefon · filial» — `row.branch?.name`
  (`null` → «—»).
- [2026-10-23] ✏️ [identity] — `PATCH /users/:id` endi `district_id` qabul
  qiladi (raqamli satr, masalan `"41"`, yoki `null` — tozalash); ilgari 400
  (forbidNonWhitelisted). Tuman mavjud va foydalanuvchining viloyatiga
  (`region_id`) tegishli bo'lishi kerak: yo'q tuman — 400 «Tuman topilmadi»;
  boshqa viloyat tumani — 400 «Tuman foydalanuvchining viloyatiga tegishli
  emas»; raqamli satr emas — 400; logistika javob bermasa — 503 (saqlanmaydi).
  Viloyati yo'q foydalanuvchida (mijoz) — faqat mavjudligi tekshiriladi.
  Viloyat bu maydon bilan O'ZGARMAYDI (kuryer hududi — faqat «Boshqa filialga
  o'tkazish»; o'tkazishda tuman tozalanadi). Javobda `data.district_id`.
  `PATCH /auth/my-profile` (o'zini tahrirlash) da oddiy foydalanuvchi uchun
  `district_id` e'tiborsiz (tarif kabi). 🔧 FE: tuman tanlovi —
  `GET /district?region_id=<user.region_id>`; joriy qiymat `user.district_id`.

- [2026-10-23] ✏️ [order] — `POST /orders/rollback/:id` + `{ target_status:
  'cancelled' }` (va kuryerning `'cancelled_sent'`) endi sotilgan / to'langan
  / qisman to'langan / yopilgan (`sold` / `paid` / `partly_paid` / `closed`)
  buyurtmada ham ishlaydi → 200 `message: 'Order CANCELLED holatiga
  qaytarildi'` (`cancelled_sent`: avvalgidek pochta javobi). Ilgari 400
  «Invalid status transition: sold -> cancelled» edi. Pul `'waiting'` ga
  qaytarishdagi bilan AYNAN bir xil qaytariladi: sotuv kassa oyoqlari
  (market / kuryer / filial), qo'shimcha xarajat, sotuvda marketga berilgan
  summa va sotuv foydasi (P&L CORRECTION); settlement qatori tozalanadi.
  Buyurtma: `status: 'cancelled'`, `sold_at: null`, `to_be_paid: 0`,
  `sale_collectible_amount: null`; `paid` / `partly_paid` dan —
  `paid_amount: 0`. Kim va qaysi holatdan qaytara olishi O'ZGARMAGAN
  (kuryer/menejer — sold/cancelled; superadmin — yana closed/paid/partly_paid;
  HQ'ga yetgan pul — hamma uchun 400). 🔧 FE: o'zgarish shart emas —
  `RollbackOrderDialog` allaqachon `target_status` yuboradi va
  muvaffaqiyatdan keyin pul keshlarini yangilaydi.
- [2026-10-23] 🟢 [order] — noto'g'ri status o'tishi xabari endi o'zbekcha:
  400 «Buyurtma holatini o'zgartirib bo'lmaydi: <eski> -> <yangi>» (ilgari
  «Invalid status transition: <eski> -> <yangi>»). Xatoni matndan emas,
  `statusCode` dan aniqlang; toast'da `message` ni o'zgarishsiz ko'rsatish
  mumkin.
### 2026-10-23 — Kvitansiya yetkazish metrikasi: `GET /telegram/dm-delivery` (2crjWf7v)

- [2026-10-23] 🆕 [notification] — `GET /telegram/dm-delivery` (Bearer,
  FAQAT superadmin; boshqa rol — 403; faqat o'qish) — «Yetkazish metrikasi:
  kvitansiya yuborilgan/yetgan nisbati». Ma'lumot saqlangan
  `notifications.delivery.telegram` dan (restart'da yo'qolmaydi).
  - Query (hammasi ixtiyoriy): `from`, `to` — ISO 8601; faqat sana bo'lsa
    Toshkent kuni (`to` — shu kun oxirigacha). Sukut — oxirgi 30 kun.
    `type` — `finance.payment_received` (sukut; to'lov kvitansiyasi: kuryer
    — «Pul qabul qilindi» 👍/❗️, market — «To'lov qabul qilindi») |
    `finance.payment_disputed` (kuryer e'tirozi, menejerga) |
    `finance.cash_reminder` (kassa eslatmasi, kuryerga). Boshqa tur, buzuq
    sana, `from >= to` yoki ortiqcha parametr → 400.
  - 200: `{ statusCode: 200, message: 'success', data: { type, from, to,
    totals, skipped_reasons, by_role, days } }`. `from`/`to` — ISO (UTC)
    haqiqiy chegara (`to` kirmaydi). `totals`, `by_role[]` (`role`:
    `courier` | `market` | `manager` | … | `unknown`, alifbo bo'yicha) va
    `days[]` (`day`: `YYYY-MM-DD` Toshkent, o'sish tartibida, bo'sh kunlar
    yo'q) — bir xil maydonlar: `total` (DM so'ralgan qabul qiluvchilar),
    `sent` (Telegram qabul qildi — yetdi), `failed` (urinildi, xato:
    bloklagan / chat yo'q), `pending` (navbatda), `skipped` (ataylab
    yuborilmadi: Telegram ulanmagan, botni bloklagan, o'chirib qo'ygan),
    `no_provider` (bot sozlanmagan), `other`, `delivery_ratio` =
    `sent / (sent + failed + pending)` (yuborilganlardan yetgani) va
    `reach_ratio` = `sent / total` (hamma qabul qiluvchidan yetgani —
    «yozildi ≠ yetadi»). Nisbatlar 0..1 (3 xona), maxraj 0 bo'lsa `null`
    (0% emas — «ma'lumot yo'q» deb ko'rsating). `skipped_reasons` —
    `{ no_telegram_id: 20, bot_blocked: 3, … }` (kalitlar ochiq ro'yxat).
  - Misol: `GET /telegram/dm-delivery?from=2026-10-01&to=2026-10-23` →
    `data.totals = { total: 120, sent: 90, failed: 4, pending: 1, skipped:
    25, no_provider: 0, other: 0, delivery_ratio: 0.947, reach_ratio: 0.75 }`.
  - ⚠️ O'qilgan bildirishnomalar retention bilan (sukut 60 kun) o'chadi —
    uzoqroq davrda eski qatorlar sanoqqa kirmaydi.
  - 🔧 Frontend (alohida vazifa; maket bo'yicha ega qarori kutilmoqda —
    eng yaqin naqsh `superadmin-notifications-sms-report` «Yetkazilish»
    o'lchagichi): superadmin dashboardida kvitansiya `delivery_ratio` /
    `reach_ratio` (kerak bo'lsa `by_role` dan `courier` qatori va `days`
    trendi). OpenAPI: `TelegramGatewayController_dmDelivery`,
    `TelegramDmDeliveryResponseDto`.

### 2026-10-23 — «Tizim holati» marshrut to'qnashuvi (7s1bqOT6)

- [2026-10-23] 🟢 [gateway] — `GET /health` endi HAQIQATAN gateway liveness
  (`HealthController`): `{ status: 'ok', timestamp, service: 'api-gateway',
  ai: 'enabled'|'disabled'|'cap_exceeded'|'unknown' }` — tez, hech bir
  servisni kutmaydi. Ilgari bu yo'lni prefikssiz `LogisticsGatewayController`
  `@Get('health')` egallab olgan edi va javob `{ statusCode, message, data:
  { service: 'logistics-service', … } }` bo'lardi. logistics-service holati
  endi `GET /logistics/health` da (Public; javob shakli avvalgi `/health`
  javobi bilan bir xil). `GET /health/readiness` o'zgarmagan (14 servis,
  200 | 503). Frontend `/health` ni ishlatmaydi («Tizim holati» —
  readiness), o'zgarish shart emas.

### 2026-10-23 — «Sessiyalar»: bitta qurilma — bitta sessiya (Notion «Elchi Pochta» #3)

- [2026-10-23] ⚠️ [auth] — sessiya endi QURILMAGA bog'langan
  ("Telegram'dagidek"): bitta qurilma (`X-Device-Id`) — bitta sessiya, u
  ANIQ yopilmaguncha. Shu qurilmadan qayta login (masalan, 1 kunlik refresh
  tugab login sahifasiga chiqqanda) YANGI sessiya ochmaydi: mavjud
  sessiyaning `id` si (access token `sid`) va `first_logged_in_at` saqlanadi,
  refresh token, `expires_at` (= shu login + 1 kun), `logged_in_at`,
  `last_seen_at`, qurilma nomi, User-Agent va IP yangilanadi. Eski refresh
  token shu zahoti 401. YANGI sessiya faqat: (a) shu qurilma sessiyasi
  yopilgan bo'lsa — «Chiqish» (`POST /auth/logout`), boshqa qurilmadan
  «Chiqarish» / «Boshqa sessiyalardan chiqish» yoki xavfsizlik hodisasi
  (parol/telefon/rol almashishi, bloklash); (b) `X-Device-Id` yuborilmagan
  yoki yaroqsiz bo'lsa — avvalgidek har login alohida sessiya. Yaroqli ID:
  16–128 belgi `[A-Za-z0-9._:-]` (`crypto.randomUUID()` yoki 32 xonali hex —
  hozirgi FE shakli mos); `"undefined"`, `"null"`, qisqa qiymat — yaroqsiz
  (sessiyada `device_id: null`). Boshqa foydalanuvchi AYNI `X-Device-Id`
  bilan kirsa — uning alohida sessiyasi. Login / refresh javobi shakli
  o'zgarmagan; refresh avvalgidek rotatsiya qilinmaydi va uzaymaydi. 🔧
  `X-Device-Id` ni parol va OTP login so'rovlarida yuborishda davom eting;
  ID chiqishda o'chirilmasin (u foydalanuvchi emas, qurilma belgisi).
- [2026-10-23] ✏️ [auth] — `GET /auth/sessions` kontrakti (qo'shimcha
  maydonlar, eski maydonlar joyida):
  - ro'yxatda endi barcha OCHIQ (yopilmagan) sessiyalar — muddati
    o'tganlari ham; har qatorda yangi `status: 'active' | 'expired'` va
    `first_logged_in_at`. `active` — ishlayapti (refresh muddati o'tmagan,
    parol o'sha). `expired` — refresh muddati o'tgan yoki parol almashgan,
    lekin qurilma chiqmagan → UI «Qayta kirish kerak» (shu qurilmadan login
    AYNI sessiyani tiklaydi, boshqa qurilmadan «Chiqarish» uni butunlay
    yopadi);
  - `logged_in_at` endi OXIRGI login vaqti (avval — sessiya ochilgan vaqt),
    `first_logged_in_at` — shu qurilmadan birinchi login;
  - `active_count` — FAQAT `status: 'active'` lar soni (`expired` sanalmaydi);
  - tartib: joriy (`current: true`) birinchi → `active` → `expired` (har
    guruh `last_seen_at` bo'yicha yangisi tepada), ko'pi bilan 50 ta;
  - muddati 90 kundan ko'p oldin o'tgan sessiyalar avtomatik o'chiriladi
    (avval 30 kun) — ro'yxatdan ham yo'qoladi.

  ```json
  {
    "statusCode": 200,
    "message": "success",
    "data": {
      "active_count": 1,
      "sessions": [
        {
          "id": "3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d",
          "status": "active",
          "device_name": "Windows 11 · Chrome 154",
          "device_id": "0b6f3c52-8d0e-4f4a-9a3b-6c1d2e3f4a5b",
          "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/154.0",
          "ip": "203.0.113.7",
          "first_logged_in_at": "2026-10-01T06:40:00.000Z",
          "logged_in_at": "2026-10-23T05:10:00.000Z",
          "last_seen_at": "2026-10-23T07:55:12.000Z",
          "expires_at": "2026-10-24T05:10:00.000Z",
          "current": true
        },
        {
          "id": "9a1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
          "status": "expired",
          "device_name": "Samsung SM-A515F · Android 13 · Chrome 155",
          "device_id": "f3a9c2d1-0b7e-4c55-9e21-7d4c3b2a1f00",
          "user_agent": "Mozilla/5.0 (Linux; Android 13; SM-A515F) … Mobile",
          "ip": "198.51.100.20",
          "first_logged_in_at": "2026-10-05T12:00:00.000Z",
          "logged_in_at": "2026-10-20T09:30:00.000Z",
          "last_seen_at": "2026-10-21T08:45:00.000Z",
          "expires_at": "2026-10-21T09:30:00.000Z",
          "current": false
        }
      ]
    }
  }
  ```

  🔧 «Sessiyalar» bo'limi: `status === 'expired'` qatorga «Qayta kirish
  kerak» belgisi (vaqt sifatida `last_seen_at`; «Birinchi kirgan» —
  `first_logged_in_at`, «Oxirgi kirgan» — `logged_in_at`); sarlavhadagi faol
  sessiyalar soni — `active_count`. «Boshqa sessiyalardan chiqish» tugmasi
  sharti endi `sessions.some((s) => !s.current)` (avval `active_count > 1`),
  chunki u `expired` sessiyalarni ham yopadi.
- [2026-10-23] ✏️ [auth] — `DELETE /auth/sessions/:id` va
  `POST /auth/sessions/revoke-others` `expired` sessiyalarni ham yopadi (ular
  ham foydalanuvchi qurilmalari); javob shakli o'zgarmagan, `revoked` /
  `session_ids` ularni ham o'z ichiga oladi. Yopilgan qurilma keyingi
  login'da YANGI sessiya oladi.
- [2026-10-23] 🟢 [gateway] — `X-Device-Name`: boyroq nom yuborish mumkin,
  masalan `Samsung SM-A515F · Android 13 · Chrome 155`, `Windows 11 · Chrome
  154`, `iPhone 15 · iOS 18 · Safari` (tavsiya ≤80 belgi; `encodeURIComponent`
  bilan — kirill / maxsus belgilar uchun). Server ko'rinmas va yo'nalish
  (bidi) belgilarini olib tashlaydi, boshqaruv belgilarini bo'shliqqa
  almashtiradi, bo'shliqlarni qisqartiradi va 128 belgigacha kesadi; bo'sh
  qolsa yoki yuborilmasa — User-Agent'dan («Telefon · Android · Chrome»).
  Sessiyada OXIRGI login paytidagi nom ko'rinadi. 🔧 Login (parol / OTP) va
  refresh so'rovlarida `X-Device-Id` bilan birga yuborish.


### 2026-10-22 — Boshqa sessiyalardan chiqish; kassa xarajatida kategoriya majburiy (Notion «Elchi Pochta» #3, #1)

- [2026-10-22] 🆕 [auth] — `DELETE /auth/sessions/:id` (Bearer, istalgan rol) —
  «Sessiyalar» ro'yxatidagi BOSHQA qurilma sessiyasini yopish (`:id` —
  `GET /auth/sessions` dagi `id`). Tana yo'q; kim va joriy sessiya faqat
  JWT'dan. 200: `{ statusCode: 200, message: 'Sessiya yopildi', data:
  { revoked: 1, session_ids: ['<id>'] } }`. Xatolar (`{ statusCode, message,
  trace_id? }`): 400 «Sessiya identifikatori noto'g'ri» (UUID emas); 400
  «Joriy sessiyani bu yerdan yopib bo'lmaydi — «Chiqish» tugmasidan
  foydalaning» (`current: true` qator — uning uchun `POST /auth/logout`); 404
  «Sessiya topilmadi yoki allaqachon yopilgan» (begona / yo'q / avval
  yopilgan); 401 «Session revoked» — so'rov yuborgan sessiyaning o'zi yopilgan.
- [2026-10-22] 🆕 [auth] — `POST /auth/sessions/revoke-others` (Bearer,
  istalgan rol, tana yo'q) — «Boshqa sessiyalardan chiqish»: joriy
  sessiyadan boshqa HAMMASI yopiladi, joriy qurilma ishlashda davom etadi.
  200 (201 emas): `{ statusCode: 200, message: 'Boshqa sessiyalardan
  chiqildi', data: { revoked: <n>, session_ids: [...] } }`; boshqa sessiya
  bo'lmasa ham 200 — `message: "Boshqa faol sessiya yo'q"`, `revoked: 0`.
  400 «Joriy sessiya aniqlanmadi — qayta kiring» — token'da `sid` yo'q
  (Telegram Mini App yoki deploy'dan oldingi token); 401 «Session revoked».
- [2026-10-22] ✏️ [auth] — chiqarilgan qurilma DARHOL chiqib ketadi (access
  token muddati tugashini kutmaydi): uning keyingi so'rovi 401 `{ statusCode:
  401, message: 'Session revoked' }` (odatda darhol; bir nechta gateway
  instansi bo'lsa ko'pi bilan ~30 soniya), keyin `POST /auth/refresh` ham 401 «Invalid refresh
  token». `POST /auth/logout` dan keyin shu sessiyaning boshqa tablaridagi
  token ham darhol 401; logout javobida qo'shimcha `data.session_ids`
  (qo'shimcha maydon, eski shakl buzilmagan). 🔧 Mavjud 401 → refresh →
  muvaffaqiyatsiz bo'lsa login sahifasi oqimi yetarli (refresh qayta-qayta
  urinmasin). «Sessiyalar» bo'limida: har `current: false` qator yonida
  «Chiqarish» (`DELETE /auth/sessions/:id`), umumiy «Boshqa sessiyalardan
  chiqish» tugmasi (`POST /auth/sessions/revoke-others`, faqat `active_count
  > 1` bo'lsa); muvaffaqiyatdan keyin `GET /auth/sessions` qayta yuklansin.
  `current: true` qatorga «Chiqarish» ko'rsatilmasin (400).
- [2026-10-22] ⚠️ [finance] — `PATCH /finance/cashbox/spend` da
  `expense_category_id` endi MAJBURIY (raqamli satr, `GET
  /finance/cashbox/expense-categories` dan). Yo'q / bo'sh / raqam emas → 400
  `{ statusCode: 400, message: 'Xarajat kategoriyasini tanlang' }`;
  o'chirilgan / mavjud bo'lmagan → 400 «Xarajat kategoriyasi topilmadi yoki
  o'chirilgan — ro'yxatdan faol kategoriya tanlang» (avvalgidek). `comment`
  IXTIYORIY (backendda avvaldan ham shunday edi). `PATCH /cashbox/fill`
  o'zgarmagan (kategoriya qabul qilmaydi). 🔧 Kassa → xarajat oynasida
  kategoriya tanlash majburiy, izoh maydoni ixtiyoriy.

### 2026-10-21 (kechki) — Kassa xarajati kategoriyalari, akkaunt sessiyalari (Notion «Elchi Pochta» #1, #3)

- [2026-10-21] 🆕 [finance] — kassa xarajati kategoriyalari
  (`/finance/cashbox/expense-categories`):
  - `GET` — SUPERADMIN, ADMIN, MANAGER; `data.items[]` = `{ id, name,
    description, sort_order, is_deleted, created_by, updated_by, created_at,
    updated_at }`, `sort_order` bo'yicha. `?include_deleted=true` faqat
    superadmin uchun (o'chirilganlar oxirida). Boshlang'ich 17 ta kategoriya
    bazaga yozilgan (Ovqatlanish … Qaytarilgan pullar).
  - `POST` / `PATCH :id` / `DELETE :id` — faqat SUPERADMIN. `POST { name
    (1–100), description? (≤500), sort_order? }`, `PATCH` — shu maydonlardan
    istalgani (`description: null|''` tozalaydi). `DELETE` — yumshoq o'chirish
    (`is_deleted: true`), tarixdagi nom saqlanadi. Takror nom → 409, topilmadi
    → 404.
- [2026-10-21] ✏️ [finance] — `PATCH /finance/cashbox/spend` da ixtiyoriy
  `expense_category_id` (raqamli satr). Faol bo'lmagan / yo'q kategoriya → 400
  «Xarajat kategoriyasi topilmadi yoki o'chirilgan — ro'yxatdan faol kategoriya
  tanlang». Berilmasa xarajat avvalgidek yoziladi. `PATCH /cashbox/fill`
  bu maydonni rad etadi (400). Kassa tarixi qatorlarida (`GET
  /finance/history`, `/finance/history/:id`, `/finance/cashbox/main` →
  `cashboxHistory`, spend javobi) yangi `expense_category_id: string|null` va
  `expense_category_name: string|null` (nom yozilgan paytdagi nusxa —
  kategoriya keyin o'zgarsa ham tarix o'zgarmaydi). 🔧 Kassa → xarajat
  oynasiga kategoriya tanlash (ro'yxat GET dan), superadmin uchun kategoriyalarni
  boshqarish ekrani, tarixda kategoriya nomi.
- [2026-10-21] 🆕 [auth] — `GET /auth/sessions` (Bearer, istalgan rol) —
  FAQAT so'rovchining o'z faol sessiyalari: `data = { active_count,
  sessions: [ { id, device_name, device_id, user_agent, ip, logged_in_at,
  last_seen_at, expires_at, current } ] }`, `last_seen_at` bo'yicha
  yangisi tepada, ko'pi bilan 50 ta. `last_seen_at` refresh'da yangilanadi
  (ilova ochiq bo'lsa ~soatiga bir). 🔧 Profil/Sozlamalarda «Sessiyalar» bo'limi
  (faol sessiyalar soni, qurilma, kirgan va oxirgi faollik vaqti, «Shu qurilma»
  belgisi). Qurilma nomi hozir User-Agent'dan — aniqroq nom uchun so'rovlarda
  `X-Device-Name` / `X-Device-Id` yuborish mumkin.
- [2026-10-21] ⚠️ [auth] — har login endi ALOHIDA sessiya: bitta akkauntga bir
  nechta qurilmadan bir vaqtda kirish mumkin, yangi login boshqa qurilmalarni
  chiqarib yubormaydi. `POST /auth/logout` faqat JORIY sessiyani yopadi
  (javob shakli o'zgarmagan). Parol/telefon/rol almashsa, akkaunt bloklansa
  yoki o'chirilsa — barcha sessiyalar yopiladi. Access token'da yangi `sid`
  claim'i. Token muddatlari: access 1 soat, refresh 1 kun (prod'da avvaldan
  shunday). Deploy paytida kirib turgan foydalanuvchilar chiqib ketmaydi.

### 2026-10-21 — Sotish oynasida «Marketga to'langan summa» chegarasi (uguUEhin)

- [2026-10-21] 🔧 [order] — buyurtma javoblarida (`GET /orders`,
  `GET /orders/:id`, `GET /orders/courier/orders`, enrich qilingan barcha
  ro'yxatlar) yangi `sale_market_paid_max: number | null`. Faqat `waiting`
  buyurtmada to'ladi: hozir TO'LIQ sotilsa sotuvchi `sell {paidAmount}` ga
  kirita oladigan buyurtma bo'yicha chegara, QO'SHIMCHA XARAJATDAN OLDIN —
  sotuvdagi formula bilan aynan bir xil: `max(total_price − paid_online_amount
  − market_tarif, 0) − paid_amount`. Boshqa holatlarda va tarifni aniqlab
  bo'lmasa — `null`. Sabab: sotuvgacha `to_be_paid` 0 turadi, shuning uchun
  oyna doim «0 so'mdan oshmasin» deb to'g'ri summani ham xato ko'rsatardi.
  🔧 `SellModal.tsx:215`: `getMarketPaidMax(order.sale_market_paid_max ??
  order.to_be_paid, effectiveExtraCost)`. Market kassasi qarzi bo'yicha yakuniy
  chegara avvalgidek sotuvning 400 xabarida.

### 2026-10-19 — Dalil fayllari baytlari, market buyurtma tarixi, bot jurnali (YEVhU6XK, Ho5qcDn4, f2Ud5tju)

- [2026-10-19] ✏️ [logistics] — `GET /post/return-requests/list`: guruhdagi
  `courier` endi faqat `{ id, name, phone_number }` (VfgcnxDa oq ro'yxati bilan
  bir xil). Ilgari identity'ning to'liq qatori (`username`, `salary`,
  `tariff_*`, `commission_*`, `settings`, `created_by`…) menejer brauzeriga
  chiqardi. 🟢 `returnMails.tsx` faqat shu uch maydonni ishlatadi.

- [2026-10-19] 🆕 [file] — `GET /files/:key/content` (JWT): fayl BAYTLARI
  gateway orqali, `Content-Type` fayl turidan. Ruxsat `GET /files/:key` bilan
  AYNAN bir xil: maxfiy kalit (`proof-`, `expense-`, …) — xodim rollari yoki
  faqat o'z buyurtmasining dalili (market/kuryer), aks holda 403; fayl
  topilmasa 404. `entities/order/api/proofFiles.ts` shu yo'lni allaqachon
  chaqiradi (`responseType: "blob"`) — prod'da imzolangan URL MinIO'ning ichki
  manzilini berib, dalil rasm/videosi ochilmasdi. 🟢 frontendda o'zgarish shart
  emas.
- [2026-10-19] ✏️ [order] — `GET /orders/:id/tracking`: `market` roli endi faqat
  O'Z buyurtmasining tarixini oladi (`market_id === sub`, boshqa market → 403).
  Market javobida har hodisaning `actor` i `{ id, name, role }` ga
  qisqartiriladi (`username`, `phone_number` yo'q); xodim rollari javobni
  avvalgidek oladi. 🟢 `OrderTracking` (`canRoleViewTracking` da `market` bor)
  o'zgarishsiz ishlaydi.
- [2026-10-19] 🟢 [audit] — Telegram bot webhook'i (`POST
  /telegram/webhook/:botSlug`) mashina yo'li: bot amallari qatorlarida
  (`tg_callback`, `tg_linked`) endi `ip` / `user_agent` / `device_*` YO'Q —
  ilgari Telegram/ichki IP va "Python-urllib" qurilma bo'lib yozilardi.

### 2026-10-17 (kechki) — Menejer kassasida kvitansiya javobi, extra-cost muddati (2crjWf7v, 1tnpaIqd)

- [2026-10-17] 🔧 [finance] — `payment_ack` endi menejerning kuryer kassasi
  sahifasi chaqiradigan sahifalangan tarixda ham bor (`GET
  /finance/cashbox/user/:id?with_history=true&page&limit&cashbox_type=couriers`
  → `data.history[]`; `cashbox_type`siz chaqiruvda faqat kuryer kassasining
  `courier_payment` qatorlarida). Ilgari bu yo'lda maydon kelmasdi —
  `/payments/cash-detail/:id?type=courier` da belgi chiqmasdi.
- [2026-10-17] ✏️ [order] — qo'shimcha xarajat so'rovida yangi
  `auto_approve_at: string | null` — kutilayotgan (`pending`) so'rov shu
  vaqtgacha javobsiz qolsa avtomatik tasdiqlanadi
  (`EXTRA_COST_AUTO_APPROVE_MINUTES`). Avtomatik tasdiq o'chiq yoki so'rov
  yopilgan — `null`. 🔧 Market kabinetida muddatni ko'rsatish.
- [2026-10-18] 🔧 [finance] — `GET /finance/history/:id`: menejer endi o'z filiali
  KURYERINING kassa yozuvini ham ochadi (ro'yxat bilan bir xil qoida). Ilgari
  `/payments/cash-detail/:id?type=courier` da yozuv tafsiloti 403 edi.

### 2026-10-17 — Kuryer kvitansiyasi javobi kassa tarixida (2crjWf7v)

- [2026-10-17] ✏️ [finance] — Kuryer kassasi tarixi (`GET
  /finance/cashbox/user/:id?cashbox_type=couriers`, `GET
  /finance/cashbox/my-cashbox` kuryer uchun) — `source_type:
  "courier_payment"` qatorlarida endi `payment_ack`: `"confirmed"` (kuryer
  botda «👍 Tasdiqlayman» bosgan), `"disputed"` («❗️ Noto'g'ri»), `null`
  (javob yo'q). Boshqa qatorlarda maydon yo'q. 🔧 To'lovlar tarixida
  `disputed` → «Noto'g'ri» (danger), `confirmed` → «Tasdiqlangan» (success)
  belgisi.

### 2026-10-17 — Skan Mini App (MWYaqprw) va ommaviy yopish isboti (j9KFyqlS)

- [2026-10-17] 🆕 [telegram] — Skan Mini App'i uchun backend tayyor. 🔧 Yangi
  ekran `/tg/scan` (v2, maket `courier-scan-active`):
  1. Ochilganda `window.Telegram.WebApp.initData` → `POST /auth/telegram
     { init_data }` → `{ accessToken }` (30 daqiqa, refresh yo'q). initData
     bo'lmasa yoki 401 — kamera ekrani ochilmaydi.
  2. Har skan → `POST /orders/scan-assign { qr_token }` (shu JWT bilan).
     ✏️ Muvaffaqiyatli javobda endi `data.order`: `{ id, order_number, status,
     total_price, address, district, region, market, customer: { name,
     phone_number } }` — tuman va mijozni darhol ko'rsating (alohida `GET
     /orders/:id` shart emas). Qidiruv yiqilsa `data.order` bo'lmaydi, skan
     baribir o'tgan. Xato (boshqa filial / boshqa kuryerniki / noto'g'ri holat)
     — `message` ni ko'rsating va oqimni to'xtatmang.
  3. «✅ Tayyor» → `POST /telegram/scan/done { order_ids: [...] }` (1..200,
     faqat kuryer) → `{ accepted, ignored }`; botga "N ta buyurtma qabul
     qilindi" + «📋 Topshiriqlarim» xabari tushadi. So'ng
     `Telegram.WebApp.close()`.
  4. iOS: `getUserMedia` ishlamasa `Telegram.WebApp.showScanQrPopup` zaxira yo'li.
  Ekran chiqqach prod `.env` ga `TELEGRAM_SCAN_WEBAPP_URL=https://admin.elchipochta.uz/tg/scan`
  yoziladi — shunda bot `/ishim` da «📷 Skaner» tugmasini ko'rsatadi (hozir bo'sh).
- [2026-10-17] 🟢 [order] — `/courier-bulk` isbot (j9KFyqlS): `POST
  /orders/sell/:id` va `POST /orders/cancel/:id` allaqachon `multipart/form-data`
  da `proof` faylini qabul qiladi (`withUploadedProof`). 🔧 `handleFinalize` da
  isbot talab qiladigan market buyurtmalari uchun `proof` uzatilsin (market
  `expense_proof_conditions`), isbotli buyurtmalarda parallellik 2.
- [2026-10-17] 🆕 [audit] — `X-Request-Source` sarlavhasi (CORS ruxsat
  berilgan): slug (`[a-z][a-z0-9-]{1,31}`) `activity_logs.metadata.request_source`
  ga tushadi. 🔧 `/courier-bulk` ommaviy sotish/bekor so'rovlarida
  `X-Request-Source: courier-bulk` yuborilsin — jurnalda ommaviy amal oddiy
  bittalikdan ajraladi. Bot so'rovlari o'zi `telegram-bot` bilan belgilanadi.

### 2026-10-17 — Prod e2e (superadmin UI) topilmalari

- [2026-10-17] 🔧 [notification] — "Xabar yuborish" sahifasi Telegram kanali
  belgilansa "Telegram uchun marketni tanlang" deb to'xtatadi. Backend endi
  (TgYRqaTk) market/guruh tanlanmasa Telegram'ni qabul qiluvchining SHAXSIY
  chatiga yuboradi (ulanmagan — `skipped`). 🔧 Bu validatsiyani olib
  tashlang: market tanlansa — guruhga, tanlanmasa — shaxsiy DM.
- [2026-10-17] 🔧 [identity] — Profil sahifasida "Telegram'ni ulash" yo'q:
  `POST /users/me/telegram/link-code` (deep-link) va `DELETE /users/me/telegram`
  ishlatilsin; market/operator/kuryer botdan foydalanishi shunga bog'liq.
- [2026-10-17] 🟢 [notification] — "Bildirishnoma qo'shish" oynasi FE
  `.env` dagi `VITE_TELEGRAM_NOTIFICATION_BOT_USERNAME` ni so'raydi — prod
  frontend build'iga bot username qo'shilsin.

### 2026-10-17 — Market Telegram guruhi kartalari (ysBqD9Nx, h9newLsd)

- [2026-10-17] 🆕 [identity] — `PATCH /markets/:id/telegram-group-pii`
  `{ tg_group_show_customer_pii: boolean }` (SUPERADMIN, ADMIN, MARKET —
  market faqat o'zinikini, boshqasi 403). Market obyektida yangi maydon
  `tg_group_show_customer_pii` (sukut `true` — ega qarori). 🔧 Market
  sozlamalari sahifasida "Telegram guruhida mijoz ismi va telefoni
  ko'rinsin" kaliti (o'chirilsa — ism yo'q, telefon niqoblangan).
- [2026-10-17] 🟢 [notification] — yangi tur `telegram.group_member_joined`
  (marketga: guruhga yangi a'zo qo'shildi; o'chirib bo'lmaydi). Activity
  log'da yangi amallar: `notification.tg_group_card`,
  `notification.tg_group_member_joined` (registry'da yorliq bor).

### 2026-10-17 — Bot bildirishnoma yadrosi va moliya xabarlari (rzGKtE9N, TgYRqaTk, VICfJuoi, 2crjWf7v)

- [2026-10-17] 🆕 [finance] — `POST /finance/cashbox/payment/courier/:id/ack`
  `{ ack: 'confirmed' | 'disputed', comment?: string (≤500) }` — faqat
  COURIER, `:id` — kuryer kassasidagi to'lov (cashbox_history) qatori. FAQAT
  audit yozuvi: kassa qoldig'i o'zgarmaydi. Javob `{ payment_id, ack,
  already }` (takror → 200 `already: true`; boshqa kuryerniki → 404). Bot
  tugmalari shuni chaqiradi; 🟢 kuryer kabinetida ixtiyoriy "Tasdiqlayman /
  Noto'g'ri" tugmalari ham shu endpoint bilan qilinishi mumkin.
- [2026-10-17] ✏️ [finance] — kassa tarixi qatorlarida (kuryer kassasidagi
  `courier_payment` chiqim qatorlari) yangi maydon `courier_ack: 'confirmed' |
  'disputed' | null`. 🔧 Kuryer kassasi / to'lovlar hisobotida `disputed` —
  qizil "❗️ E'tiroz" belgisi, `confirmed` — "👍".
- [2026-10-17] 🟢 [notification] — yangi turlar: `finance.payment_disputed`
  (menejer / filial boshlig'iga, HIGH), `finance.cash_reminder` (kuryerga,
  kuniga bir marta). `finance.payment_received` endi Telegram kanalida ham;
  matni boyidi (market: sana + hisob qoldig'i oldin → keyin; kuryer: "Qabul
  qildi: <xodim>. Qoldiq: …"). `GET /notifications/types` avtomatik ko'rsatadi.
- [2026-10-17] 🟢 [notification] — `notification.dispatch` ayni `request_id`
  bilan takrorlansa javob `{ dispatched: 0, duplicate: true }` (ikkinchi
  xabar yo'q). Frontend `client_request_id` naqshi o'zgarmaydi.
- [2026-10-17] ⚠️ [notification] — `POST /notifications/send` (qo'lda guruh
  relay'i) — ESKIRGAN (`deprecated`): yangi ekranlar `POST /notifications`
  (dispatch) dan foydalansin.

### 2026-10-17 — Qo'shimcha xarajat: atomik qaror, avtomatik tasdiq, Telegram DM (DuST9k8j, 1tnpaIqd)

- [2026-10-17] ✏️ [order] — `POST /orders/extra-cost-approvals/:id/reject` —
  yangi ixtiyoriy `reason`: `TOO_EXPENSIVE | NOT_AGREED | NO_PROOF | DUPLICATE`
  (boshqa qiymat → 400). 🔧 Rad etish modalida erkin matn o'rniga shu ro'yxat
  (izoh ixtiyoriy qoladi).
- [2026-10-17] ✏️ [order] — approval obyektida yangi maydonlar:
  `auto_approved: boolean`, `reject_reason: string | null`.
  `GET /orders/extra-cost-approvals?auto_approved=true` — avtomatik
  tasdiqlanganlar filtri. 🔧 Ro'yxat va buyurtma tarixida "⏱ avtomatik
  tasdiqlangan" belgisi + alohida filtr.
- [2026-10-17] ⚠️ [order] — qaror endi atomik: parallel/takroriy qaror —
  400 "Bu so'rov allaqachon yakunlangan" (avval ikkinchi qaror ham yozilardi).
  🔧 Bu xabarni xato emas, "allaqachon hal qilingan" deb ko'rsatib ro'yxatni
  yangilang.
- [2026-10-17] 🆕 [notification] — yangi turlar: `order.extra_cost_requested`,
  `order.extra_cost_reminder`, `order.extra_cost_auto_approved` (marketga,
  in-app + realtime + Telegram). 🔧 Ikonka/yorliq; bosilganda tasdiq
  sahifasiga (`data.approval_id`).

### 2026-10-17 — Telegram bot: kuryer oqimi (h9newLsd, MO2MLPGo, z2FRwu2c, 4BirMSVp, VICfJuoi)

- [2026-10-17] 🟢 [bot] — kuryer botda: `/ishim` (bugungi topshiriqlar
  kartalari: Sotildi / Bekor / Yetkazib bo'lmadi / Ortga, tasdiq qadami,
  yopiq sabablar ro'yxati, isbot rasm/video), `/kun` (kunlik hisobot),
  `/kassa`; market: `/balans`. Bot yangi endpoint ishlatmaydi — panel
  endpointlari kuryer/market JWT'si bilan. Frontend o'zgarishi shart emas.
- [2026-10-17] 🆕 [notification] — yangi tur `courier.daily_report` (in-app +
  Telegram). 🔧 Bildirishnomalar ro'yxatida shu tur uchun ikonka/yorliq
  ("Kunlik hisobot"); `data.telegram_buttons` — faqat Telegram uchun, panelda
  e'tiborsiz qoldiring.
- [2026-10-17] 🟢 [bot] — "🌐 Kabinetda ochish" tugmasi
  `${ELCHI_CABINET_URL}/orders?search=<id>` ga olib keladi. 🔧 Buyurtmalar
  sahifasi `?search=` query parametrini qidiruv maydoniga qo'yib ochsin.

### 2026-10-17 — Telegram bog'lash, RBAC va Mini App kirishi (6jXw0DDr, 4TfLyTrL, 9uNhwTZp, td89SKXQ, 3ZfiXuaW, 5i3UZjiF, Pq2dFj8A, xC88d8kH, BreQwksC)

- [2026-10-17] 🆕 [telegram] — `POST /users/me/telegram/link-code` (har qanday
  xodim, JWT) → `{ token, purpose: 'user', expires_at, deep_link, command }`.
  Havola BIR MARTALIK, 10 daqiqa. 🔧 Profil sahifasida «Telegram'ni ulash»:
  `deep_link` ni tugma + QR qilib ko'rsating (QR — `deep_link` dan), muddat
  tugasa qayta so'rang; holat — `GET /auth/my-profile` dagi `telegram_linked`.
- [2026-10-17] 🆕 [telegram] — `DELETE /users/me/telegram` → `{ unlinked }`.
  🔧 Profilda «Uzish» tugmasi.
- [2026-10-17] 🆕 [telegram] — `POST /telegram/link-code { purpose:
  'market_group', group_type: 'create'|'cancel', market_id? }` → `deep_link`
  (`t.me/<bot>?startgroup=…`). Market — o'z marketi; market operatori — o'z
  marketi (boshqa `market_id` → 403); admin/superadmin — `market_id`
  MAJBURIY. 🔧 `NotificationFormModal` dagi qo'lda "Telegram group ID" (logdan
  chat id olish) o'rniga «Telegram guruhini ulash» havolasi/QR; ulangach
  marketga `telegram.group_connected` bildirishnomasi keladi.
- [2026-10-17] 🆕 [telegram] — `GET /telegram/stats` (admin/superadmin) →
  `[{ role, total, linked, ratio }]`. 🔧 Dashboardda "Telegram'ga ulangan
  kuryerlar / jami" ko'rsatkichi.
- [2026-10-17] 🆕 [auth] — `POST /auth/telegram { init_data }` (Mini App,
  `window.Telegram.WebApp.initData` xom satri) → `{ accessToken,
  access_token_expires_at, user }`, 30 daqiqa, refresh token va cookie YO'Q
  (muddat tugasa qayta initData bilan). 401 — imzo noto'g'ri / eskirgan /
  akkaunt bog'lanmagan ("avval kabinetdan ulang").
- [2026-10-17] ⚠️ [identity] — td89SKXQ: GET /users, GET /users/:id,
  GET /markets, profil va buyurtmadagi `market` obyektida `telegram_id` YO'Q;
  o'rniga `telegram_linked: boolean`. 🔧 `telegram_id` ga tayangan joylar
  `telegram_linked` ga o'tsin; admin ro'yxatida "Telegram ulangan" ustuni.
- [2026-10-17] ⚠️ [notification] — 6jXw0DDr: `POST /notifications/connect-by-token`
  — `text` endi BIR MARTALIK guruh kodi (`market_group` javobidagi `token`);
  `group_token-…` matni 400. REGISTRATOR → 403. `POST /notifications/telegram/link`
  ham bir martalik kod beradi (10 daqiqa, avval 15 daqiqa qayta ishlatiluvchi).
- [2026-10-17] 🟢 [bot] — guruhda matnli `group_token-…` endi ulamaydi;
  shaxsiy chatda buyruqlar rol bo'yicha: kuryer `/ishim`, `/kun`, `/kassa`;
  market `/status`, `/balans`; bog'lanmagan chatga faqat `/start` javob beradi.

### 2026-10-16 — Telegram bot yadrosi (ZlpXb4Wh, Mvx0h1Fv, uCrzrElu, UQlmQiGT, GL2GgtEc, 9HIaV80X, bOMYoOtV)

- [2026-10-16] ⚠️ [notification] — bOMYoOtV: `POST /notifications/send` endi
  faqat `superadmin`/`admin` (REGISTRATOR → 403). 🔧 Registrator menyusidan
  "Telegram'ga yuborish" tugmasini yashiring.
- [2026-10-16] ✏️ [notification] — 9HIaV80X: `POST /notifications/send`
  natijasi: 200 — hammasi ketdi; **202 — navbatda** (Telegram 429/5xx, server
  o'zi qayta yuboradi — xabar yo'qolmaydi); 207 — aralash; 502 — hech biri
  (bot bloklangan/chiqarilgan, chat topilmadi). `data` ga `queued` (son) va
  har `results[]` elementiga `queued: true` qo'shildi. 🔧 202 ni xato emas,
  "navbatga qo'yildi" deb ko'rsating.
- [2026-10-16] ⚠️ [notification] — bOMYoOtV: `POST /notifications` va
  `PATCH /notifications/:id` da `token` maydoni olib tashlandi (yuborilsa
  400). Javoblarda `has_token` YO'Q — o'rniga `bot_slug` (`string | null`,
  sir emas). Bot tokeni faqat server env'ida. 🔧 Formada bot tokeni maydoni
  bo'lsa — olib tashlang; `has_token` ga tayangan joylarni o'chiring.
- [2026-10-16] 🟢 [notification] — 9HIaV80X: bot guruhdan chiqarilsa/bloklansa
  ulanish avtomatik `is_active: false` bo'ladi va adminlarga
  `telegram.channel_inactive` (SYSTEM, HIGH) bildirishnomasi keladi. Qayta
  faollashtirish — `PATCH /notifications/:id { is_active: true }`.
- [2026-10-16] 🟢 [notification] — Shaxsiy chatdagi buyruqlar: `/start`,
  `/help`, `/status <raqam>` (market), `/uzish` (`/stop` ham ishlaydi).
  Market tokenini shaxsiy chatga yuborib "kirish" olib tashlandi — bog'lanish
  profildagi «Telegram'ni ulash» havolasi (`POST /notifications/telegram/link`)
  orqali. WebApp tugmasi URL'iga token QO'SHILMAYDI.
- [2026-10-16] 🟢 [gateway] — `POST /telegram/webhook/:botSlug` (Telegram uchun,
  frontend ishlatmaydi; Swagger'da yashirin).

### 2026-10-16 — P: mahsulot narxi, nom dublikati, rasm turi, ro'yxat (zRqDRLAZ, Aws1oApe, ugoDD9TT, qNwXfqLL)

- [2026-10-16] ✏️ [catalog] — zRqDRLAZ: mahsulotda yangi ixtiyoriy
  `price` (so'm, `number | null`, ko'pi bilan 2 kasr). `POST /product`,
  `PATCH /product/:id`, `PATCH /product/my/:id` qabul qiladi (multipart'da
  satr: `"125000"`, `"125 000"`; bo'sh satr yoki `null` — narxni tozalaydi;
  manfiy / 3 kasr / matn → 400). `GET /product*` javoblarida har mahsulotda
  `price` (narxsiz — `null`). 🔧 Buyurtma yaratish formasi (Step2Combined):
  rasm uchun `product.image` emas `product.image_url` (fallback ikonka bilan);
  narx satrini faqat `product.price != null` bo'lsa chizing (bo'sh "so'm"
  chiqmasin); tanlangan mahsulotlardan UMUMIY SUMMA ni
  `Σ price × quantity` bo'yicha TAKLIF qiling — operator ustiga yoza olsin
  (backend summani o'zi yozmaydi). Mahsulot formasiga "Narx" maydoni.
- [2026-10-16] ⚠️ [catalog] — Aws1oApe: bir marketda mahsulot nomi endi
  registr va bo'shliqlarga befarq noyob: "Telefon" bor bo'lsa "telefon",
  "  TELEFON  " → **409** ("... nomli mahsulot allaqachon mavjud ...").
  Nom chetdagi bo'shliqlarsiz, ichki ketma-ket bo'shliqlar bittaga
  qisqartirilib, ASL registrda saqlanadi. PATCH bilan boshqa mahsulot nomiga
  o'zgartirish ham 409. `POST /product` tanasi endi DTO orqali tekshiriladi:
  noma'lum maydon (masalan `sku`) → **400** "property sku should not exist" —
  forma faqat `name`, `image`, `image_url`, `market_id`, `price` yuborsin.
  🔧 409 xabarini `getBackendErrorMessage` bilan ko'rsating.
- [2026-10-16] ⚠️ [catalog] — ugoDD9TT: mahsulot rasmi faqat PNG / JPEG /
  WebP. PDF, XLSX va boshqa turlar → **400** "Faqat PNG/JPEG/WebP rasm
  yuklash mumkin" (ilgari 201 bilan saqlanib, jim buzilgan rasm bo'lardi).
  Kengaytmasi rasm, mazmuni boshqa fayl → 400. `image_url` kengaytmasi
  haqiqiy turga mos (`.png`, `.jpg`/`.jpeg`, `.webp`). 🔧 Fayl tanlagichida
  `accept="image/png,image/jpeg,image/webp"`, 400 xabarini ko'rsating.
- [2026-10-16] 🟢 [catalog] — qNwXfqLL: backend qismi 3qDsJpfW da qilingan
  (2026-10-14 yozuvi): `GET /product/market/:marketId` va
  `GET /product/my-products` `search`, `page`, `limit` (≤500) ni qabul qiladi.
  🔧 Buyurtma formasidagi mahsulot tanlagichi `?search=` ni debounce (300ms)
  bilan serverga yuborsin va yetarli `limit` bersin (klient filtri o'rniga);
  0 mahsulotda "Topilmadi".
### 2026-10-16 — N3: SMS shablon muharriri hisoblagichi va PII minimumi (nkhURiKX)

- [2026-10-16] 🆕 [notification] — `POST /notifications/sms/templates/preview`
  (admin/superadmin) — muharrir hisoblagichi; HECH NARSA saqlanmaydi va
  yuborilmaydi. Body:
  `{ text: string (≤1000, bo'sh satr ham mumkin), message_class?: 'transactional' | 'promo' | 'security' (sukut transactional), required_vars?: string[], vars?: Record<string, string> }`.
  `vars` — namuna qiymatlar: berilsa to'ldirilgan matn sanaladi (aniq narx).
  Javob (200):
  `{ message_class, encoding: 'GSM-7' | 'UCS-2', units, parts, per_part, non_gsm_chars: string[], opt_out_included: boolean, vars: string[], pii_vars: string[], missing_vars: string[], rendered: string | null, currency: 'UZS', tariff: number | null, estimated_cost: number | null }`.
  Bo'lak qoidasi — hisob-kitobdagi AYNI `countSmsSegments` (GSM-7 160/153,
  UCS-2 70/67, kengaytma jadvali belgilari, masalan `{ } [ ] €` — 2 septet).
  `non_gsm_chars` — matnni UCS-2 ga o'tkazgan belgilar (masalan `ё`, `‘`,
  emoji). `promo` da bekor qilish havolasi ham sanaladi
  (`opt_out_included: true`, kampaniya prognozi bilan bir xil).
  `estimated_cost` = `parts × tariff` (BITTA xabar uchun, so'm); tarif
  sozlanmagan bo'lsa `null` (0 emas). 400 — noma'lum `message_class` yoki
  1000 dan uzun matn.
  → 🔧 Frontend (`SmsTemplatesTab` muharriri, kartaning 6-bandi): har bosishda
  mahalliy `smsSegments.ts` / `SmsMeter` (D5sxjGBY) qoladi; yozish to'xtaganda
  (debounce ~300 ms) va "Saqlash" oldidan shu endpointni chaqirib
  "UCS-2 · 2 bo'lak · ~190 so'm" (`encoding · parts · estimated_cost`),
  `non_gsm_chars` ro'yxati ("Bu belgilar narxni oshirdi: ё ‘"), `pii_vars`
  ogohlantirishi (saqlash 400 bo'ladi) va `missing_vars` ko'rsatilsin.
  Kirillga o'tganda raqam darhol o'zgarsin (TC11). Vitest vektorlari backend
  bilan bir xil: 160 lotin → 1, 161 → 2, 70 kirill → 1 (UCS-2), lotin + `ё` → UCS-2.
- [2026-10-16] ✏️ [notification] — PII minimumi kengaydi (TC13):
  `POST /notifications/sms/templates` va `PUT /notifications/templates`
  (`channel` = null yoki `sms`) endi naqsh bo'yicha ham rad etadi:
  `customer_`/`client_`/`receiver_`/`recipient_`/`buyer_`/`mijoz_` +
  `name`/`fio`/`ism`/`familiya`/`address`/`manzil`; `fio`, `ism`,
  `familiya`, `manzil`; mahsulot ro'yxati — `products`, `product_list`,
  `product_names`, `items`, `order_items`, `goods`, `mahsulotlar`,
  `tovarlar` (+ `_list`/`_names`/`_text`/`_nomlari`/`_royxati`).
  `market_name`, `branch_name`, `order_number`, `amount`, `status` —
  ruxsat. 400 xabarida taqiqlangan o'zgaruvchilar ro'yxati bor.
  → 🔧 Frontend: preview `pii_vars` ni saqlashdan OLDIN ko'rsating; 400
  matnini toast'da chiqaring.
- [2026-10-16] ✏️ [notification] — `POST /notifications/sms/campaigns` va
  `/campaigns/preview`: xom matnda yoki (eski) shablonda PII o'zgaruvchi
  bo'lsa → 400 `{ reason: 'pii_forbidden', pii_vars: [...] }` (navbatga hech
  narsa tushmaydi).
  → 🔧 Frontend (`CampaignPage`): `reason === 'pii_forbidden'` bo'lsa
  `pii_vars` ni ko'rsating.
- [2026-10-16] 🟢 [notification] — `GET /notifications/sms/templates`
  (o'zgarmagan): shablon matni o'zgartirilsa `provider_template_id` `null`
  bo'ladi va `needs_provider_approval: true` keladi.
  → 🔧 Frontend: ro'yxatda "Operator tasdig'i kerak" belgisi (TC12); tasdiq
  id si `PATCH /notifications/sms/templates/:id/approve` bilan yoziladi.
### 2026-10-16 — N1: kampaniyani rejalashtirish + tungi taqiq (WIsb9Ytq) va kampaniya natijasi hisoboti (H7kpCman)

**WIsb9Ytq — rejalashtirish va reklama tungi taqiq darvozasi** (hammasi
SUPERADMIN/ADMIN, `/notifications/campaigns`):

- [2026-10-16] ⚠️ [notification] — `POST /notifications/campaigns` →
  `scheduled_at` endi **ISO + ANIQ zona** bilan bo'lishi shart
  (`2026-10-20T09:00:00+05:00` yoki `...Z`). Zonasiz (`2026-10-20T09:00`) →
  **400** (brauzer mahalliy vaqti serverda boshqa zona deb o'qilmasin).
  "Darhol" tanlansa `scheduled_at` umuman YUBORILMASIN.
- [2026-10-16] ✏️ [notification] — Reklama (kategoriya `marketing`:
  `marketing.manual`, `marketing.promo`) 18:00–09:00 (Toshkent,
  `NOTIF_PROMO_QUIET_HOURS`) oralig'iga tushsa **tashlanmaydi** — oyna
  tugashiga (ertangi 09:00) suriladi; katta kampaniyaning 18:00 dan keyingi
  partiyalari ham ertalab davom etadi. Tranzaksion turlar (masalan
  `system.manual`, rol e'loni) **tunda ham bloklanmaydi**. 202 javobiga
  yangi maydonlar: `display_status`, `requested_scheduled_at` (so'ralgan),
  `scheduled_at` (haqiqiy), `scheduled_at_tashkent`
  (`'YYYY-MM-DDTHH:mm:ss+05:00'`), `quiet_hours_shifted: boolean`,
  `timezone: 'Asia/Tashkent'`.
- [2026-10-16] 🆕 [notification] — `GET /notifications/campaigns/schedule-policy?scheduled_at=&type=&category=`
  → `{ timezone: 'Asia/Tashkent', utc_offset: '+05:00', promo_quiet_hours:
  { start: '18:00', end: '09:00', enabled, env }, promo_categories:
  ['marketing'], is_promo, max_schedule_days: 90, check }`. `scheduled_at`
  berilsa `check = { requested_at, requested_at_tashkent, immediate,
  effective_at, effective_at_tashkent, shifted, reason:
  'promo_quiet_hours' | null, message }` — `message` tayyor matn
  ("... ga suriladi"). Hech narsa yaratilmaydi.
- [2026-10-16] ✏️ [notification] — `GET /notifications/campaigns` va
  `GET /notifications/campaigns/:id` har qatorida: `display_status`
  (`scheduled` | `sending` | `sent` | `failed` | `cancelled`), `can_cancel`
  (faqat yuborilmaguncha `true`), `is_promo`, `paused_until` (reklama tungi
  taqiqda to'xtagan — shu vaqtda davom etadi), `timezone`,
  `scheduled_at_tashkent`. Ro'yxatga yangi filtr `?state=scheduled|sending|sent|failed|cancelled`
  (`status` bilan birga — 400). Yuborilgan kampaniyani bekor qilish — 409
  (avvalgidek).
  → **Frontendda (`/campaigns`, forma):** 🔧 "Yuborish vaqti": Darhol /
  Belgilangan vaqtda (antd `DatePicker showTime`), maydon yonida **"Toshkent
  vaqti"** yozuvi; qiymatni `dayjs.tz(..., 'Asia/Tashkent').format()` kabi
  **+05:00 bilan** yuboring. 🔧 Tur reklama (`is_promo` / `schedule-policy`
  dagi `promo_quiet_hours`) bo'lsa `disabledTime` bilan 18:00–09:00 soatlarini
  bloklang (soatlarni qotirmang — `schedule-policy` dan oling); kiritilgan
  vaqt taqiqda bo'lsa `check.message` ("ertangi 09:00 ga suriladi")
  taklifini ko'rsating. 🔧 Ro'yxat: vaqt (`scheduled_at_tashkent`),
  auditoriya soni (`total`), kanal (`channels`), holat (`display_status`:
  rejalashtirilgan / yuborilmoqda / yuborilgan / xato / bekor qilingan);
  "Bekor qilish" tugmasi FAQAT `can_cancel === true` da. Yuborish 202 —
  progress `GET /notifications/campaigns/:id` (2–3 s poll). 390px da
  gorizontal scroll yo'q (WIsb9Ytq TC1–TC9, TC12).

**H7kpCman — kampaniya natijasi hisoboti** (bildirishnoma va SMS
kampaniyasi uchun BIR xil javob shakli):

- [2026-10-16] 🆕 [notification] — `GET /notifications/campaigns/:id/report`
  (bildirishnoma kampaniyasi) va `GET /notifications/sms/campaigns/:id/report`
  (SMS kampaniyasi) → `data`:
  `{ kind: 'notification'|'sms', campaign: {...}, stats: { audience, sent,
  delivered, failed, skipped, pending, undelivered, unlisted_failed,
  skipped_breakdown? }, dlr: { supported, received, awaiting, note },
  by_channel: [{ channel, sent, failed, skipped, pending, other, statuses }],
  sms: null | { messages, parts_total, parts_per_message: { min, max },
  encoding: 'GSM-7'|'UCS-2'|'mixed', encoding_breakdown, source, dlr: {
  final, delivered, failed, awaiting }, tariff_per_part, cost_of_sent },
  cost: { currency: 'UZS', estimated, cost_of_sent, is_estimate: true,
  paid_channels, note }, permissions: { can_export }, export_sync_limit:
  10000 }`.
  - `stats.delivered` — **`null` = o'lchanmagan** (DLR hali kelmagan yoki
    kanalda DLR yo'q: in_app/realtime/push) → **"—"** ko'rsating
    (`fmtMetric(null)`), HECH QACHON 0. DLR kelgach — son (0 ham haqiqiy).
  - SMS kampaniyasida `stats.sent` — provayder qabul qilgan; `skipped` =
    noto'g'ri raqam + rozilik yo'q (`skipped_breakdown`).
  - `sms` — faqat SMS kampaniyasida; bildirishnoma kampaniyasida `null` →
    SMS bloki **umuman chiqmasin**.
  - `cost.estimated` / `cost.cost_of_sent` — `null` = tarif sozlanmagan
    ("—"); bildirishnoma kampaniyasida 0 (bepul kanallar). Narx yonida
    **"taxminiy"** izohi (`cost.note`) bo'lsin.
- [2026-10-16] 🆕 [notification] — "Yetkazilmaganlar":
  `GET /notifications/campaigns/:id/undelivered?page&limit` va
  `GET /notifications/sms/campaigns/:id/undelivered?page&limit` (limit ≤100)
  → `{ items: [{ ref_id, recipient_id, name, role, phone, failures: [{
  channel, status, reason }] }], meta, unlisted_failed }`. `phone` — faqat
  maskalangan (`***7434`, SMS), bildirishnomada `null`.
- [2026-10-16] 🆕 [notification] — CSV eksport (**FAQAT SUPERADMIN**,
  admin → 403): `GET /notifications/campaigns/:id/undelivered/export` va
  `GET /notifications/sms/campaigns/:id/undelivered/export`.
  ≤ 10 000 qator → **200 `text/csv`** fayl (`Content-Disposition`,
  `X-Export-Total`). Kattasi → **202 JSON** `{ mode: 'async', export_id,
  status: 'queued', rows, duplicate }` (sinxron emas, fon vazifasi);
  holat: `GET /notifications/campaigns/exports/:export_id` (`status:
  queued|running|done|failed`, `download_url`), fayl:
  `GET /notifications/campaigns/exports/:export_id/download` (7 kun; keyin
  410, tayyor bo'lmasa 409). Har eksport/yuklash faoliyat jurnaliga
  **`export`** amali bilan yoziladi.
  → **Frontendda (`/campaigns/:id`):** 🔧 4–6 Statistic (Auditoriya,
  Yuborildi, Yetkazildi, Xato, O'tkazib yuborildi, Taxminiy narx) — null →
  "—"; kanal jadvali `by_channel`; SMS bloki faqat `sms !== null`;
  "Yetkazilmaganlar" jadvali sabab bilan; "CSV" tugmasi faqat
  `permissions.can_export` (superadmin) — javob 202 bo'lsa holatni poll
  qilib `download_url` dan yuklang (axios blob). 390px: statistikalar 2
  ustun, jadval o'z ichida scroll; dark tema — dizayn tokenlari; kampaniya
  yo'q bo'lsa tushunarli bo'sh holat (H7kpCman TC1–TC12).
### 2026-10-16 — N2: bildirishnoma inbox (dedupe, data.count, retention) va API xato kodlari (A1HzKEby, 3SeRYFqx)

- [2026-10-16] ✏️ [notification] — `POST /notifications/connect-by-token`:
  xato endi **2xx emas**. Noto'g'ri format / topilmagan token yoki noto'g'ri
  `group_id` — **HTTP 400**, market topilmadi — **404**, kutilmagan xato —
  500 (umumiy matn). Tana — standart konvert `{ statusCode, message }`
  (avval HTTP 201 + konvertsiz `{ message }` edi). Muvaffaqiyat — HTTP 201
  `{ statusCode: 201, message, data: <telegram config> }`. Telegram bot
  ichidagi ulash oqimi o'zgarmagan.
  → 🔧 Frontend (3SeRYFqx #4): `NotificationFormModal` ga token orqali ulash
  oqimini chiqaring — market tanlanganda uning tokeni
  `GET /markets/:id/tg-token` (faqat SUPERADMIN) dan olinadi va
  `group_token-<token>` (bekor qilinganlar guruhi uchun `…-cancel`) ko'rinishida
  ko'rsatiladi; "Group ID ni backend yoki bot logidan oling" matni o'rniga
  guruhda `/id` buyrug'i yoki shu oqim. Xato holati — HTTP kod + `message`.
- [2026-10-16] ✏️ [notification] — `POST /notifications/send`: HTTP kod =
  tana `statusCode`: hammasi ketdi — **200**, qisman — **207**
  (Multi-Status), hech biri ketmadi — **502**. Tana o'zgarmagan:
  `data: { total, success, failed, results: [{ group_id, ok, error? }] }`
  (502 da ham `data.results` keladi — sababni shundan ko'rsating).
  → 🔧 Frontend: 207 ni "qisman yuborildi" ogohlantirishi, 502 ni xato
  sifatida ko'rsating (axios 502 da `catch` ga tushadi — `error.response.data`).
- [2026-10-16] ✏️ [notification] — `POST /notifications/dispatch`: aniq
  `recipient_id(s)` identity'da tekshiriladi (o'chirilgan / mavjud bo'lmagan
  foydalanuvchiga qator **yozilmaydi**). Javobda yangi maydon
  `data.unresolved: string[]` (topilmagan id'lar; hammasi topilsa `[]`).
  Hammasi topilmasa — **HTTP 400** ("Qabul qiluvchi topilmadi … — hech narsa
  yozilmadi"). Rol/broadcast nishoni o'zgarmagan. Takror `client_request_id`
  — HTTP 200 (`duplicate: true`), yangi dispatch — 201.
  → 🔧 Frontend: "Xabar yuborish" natijasida `unresolved` bo'sh bo'lmasa
  "N ta qabul qiluvchi topilmadi: …" deb ko'rsating.
- [2026-10-16] ✏️ [notification] — `group_key` endi majburiy (A1HzKEby):
  berilmasa katalogdagi `group_key_pattern` + `data` dan hosil bo'ladi
  (`GET /notifications/types`); shablonli turda `data` o'zgaruvchisi
  yetishmasa — **400** ("group_key aniqlanmadi: … data.order_id berilmagan").
  Shablonsiz turlar (`<category>.manual`, `system.announcement`, `account.*`,
  `x.*`) — har dispatch alohida qator (o'zgarishsiz). Admin "Xabar yuborish"
  formasi (`*.manual`) ta'sirlanmaydi.
- [2026-10-16] ✏️ [notification] — inbox qatori (`GET /notifications/inbox`,
  realtime `notification:new` payload'i): bitta obyekt bo'yicha qator
  birlashtirilganda (masalan bitta buyurtmaning 5 ta holati — inboxda 1 qator)
  `data.count` — shu qatorga yig'ilgan hodisalar soni (yo'q bo'lsa = 1).
  Bo'ron chegarasi: bir foydalanuvchiga bir turdagi xabar 1 soatda 30 tadan
  oshsa (`NOTIF_HOURLY_CAP_PER_TYPE`) yangi qator o'rniga oxirgisi yangilanadi
  va `data.count` oshadi (CRITICAL — chegarasiz).
  → 🔧 Frontend: `data.count > 1` bo'lsa qatorda "N ta yangilanish" belgisi.
- [2026-10-16] 🟢 [notification] — Inbox retention (kunlik, partiyalab):
  o'qilganlar `NOTIF_RETENTION_READ_DAYS` (60), o'qilmaganlar
  `NOTIF_RETENTION_UNREAD_DAYS` (180) kundan keyin o'chiriladi, `critical`
  hech qachon. **Sukut o'chiq** (`NOTIF_RETENTION_ENABLED=false`) — yoqilguncha
  hech narsa o'chmaydi. API o'zgarmagan.
- [2026-10-16] 🟢 [notification] — Telegram guruh konfiguratsiyasi
  (`GET /notifications`, `GET /notifications/:id`) javobida `is_active` bor,
  `PATCH /notifications/:id { is_active: boolean }` uni o'zgartiradi,
  `GET /notifications?is_active=true|false` filtri ishlaydi (backend tayyor).
  → 🔧 Frontend (3SeRYFqx TC4): `Notification` tipiga
  (`src/entities/notification/model/types.ts`) `is_active: boolean` qo'shing,
  jadvalda `is_active` ustuni va toggle (PATCH) render qiling.
### 2026-10-16 — O1: almashtirish (kafolat-swap) oqimi (lQjt6sKP)

Yangi buyurtmani market avval YETKAZILGAN eski buyurtma o'rniga yaratadi:
kuryer yangisini topshirib, eski mahsulotni mijozdan qaytarib oladi. Eski
buyurtma SOTILGAN holatda qoladi, uning puli o'zgarmaydi (reversal yo'q).

- [2026-10-16] 🆕 [order] — `GET /orders/replaceable` (admin, superadmin,
  registrator, market, menejer, filial). Buyurtma yaratish formasidagi
  "Almashtirish" tanlagichi (BeePost `ReplacementPicker` analogi) uchun.
  Query: `market_id` (market rolida e'tiborsiz — token'dan; boshqa rollar
  uchun majburiy, yo'q bo'lsa 400), `customer_id`, `q`, `page`, `limit`
  (≤100). `q`: 1–6 raqam — buyurtma ID; telefon (`+998 90 …`, `901234567`) —
  shu marketdagi mijoz buyurtmalari; boshqa matn — izoh yoki mahsulot nomi.
  Faqat `sold` / `paid` / `partly_paid` va hali almashtirilmagan buyurtmalar.
  Javob: `data: { items, total, page, limit }`, har qator:
  `{ id, status, market_id, customer_id, customer: { id, name, phone_number },
  total_price, where_deliver, comment, sold_at, createdAt,
  items: [{ product_id, product_name, quantity }] }` — bir xil mahsulot bir
  necha marta buyurtma qilinganini ajratish uchun sana, narx va izohni
  ko'rsating.
- [2026-10-16] ✏️ [order] — `POST /orders` → ixtiyoriy
  `replaced_order_id` (raqamli ID). 400 holatlari (xabar o'zbekcha, ekranda
  ko'rsating): boshqa marketniki yoki topilmadi ("shu marketda topilmadi"),
  yetkazilmagan ("Faqat yetkazib berilgan (sotilgan) buyurtmani almashtirish
  mumkin"), allaqachon almashtirilgan ("allaqachon almashtirishga
  belgilangan"). Yangi buyurtma qatorida `replacement_of_order_id` va
  `replacement_state: 'awaiting_old_pickup'`; eski buyurtmada
  `is_replacement_return: true`. `POST /orders/external` da maydon → 400.
- [2026-10-16] ⚠️ [order] — KURYER SOTUVI: `POST /orders/sell/:id` va
  `POST /orders/partly-sell/:id` ga `oldItemCollected` (boolean; multipart'da
  `"true"`/`"1"`). Buyurtmada `replacement_of_order_id` bo'lsa va
  `replacement_state` hali `awaiting_old_pickup` bo'lsa,
  `oldItemCollected: true` siz sotuv **400** ("Avval eski mahsulotni mijozdan
  olganingizni tasdiqlang"). 🔧 Kuryer sotuv modalida almashtirish
  buyurtmasi uchun "Eskisini oldim (#<replacement_of_order_id>)" belgisi;
  belgilanmaguncha "Sotildi" tugmasi o'chiq. Oddiy buyurtmada maydon
  e'tiborsiz. Sotilgach ikkala buyurtmada `replacement_state:
  'old_collected'` va `old_item_collected_at`.
- [2026-10-16] 🆕 [order] — `GET /orders/replacement/returns` (superadmin,
  admin, market — market faqat o'zinikini). Qaytariladigan eski buyurtmalar:
  query `market_id`, `state` (`awaiting_old_pickup` | `old_collected` |
  `old_returned`), `page`, `limit`. Qator: yuqoridagi maydonlar +
  `replacement_state`, `old_item_collected_at`, `replacement_order_id`,
  `replacement_order_status`. 🔧 "Almashtirish qaytarmalari" sahifasi.
- [2026-10-16] 🟢 [order] — buyurtma qatorlarida yangi maydonlar:
  `replacement_of_order_id`, `replacement_state`, `is_replacement_return`,
  `old_item_collected_at` (kuryer ro'yxatida almashtirish belgisini ko'rsatish
  uchun).
### 2026-10-16 — B: filiallar, hududlar, rollar, pochta, kuryer hisoboti (8jtzNlFt, cI5gqN90, o2j9uDtT, K3scaE0W, 4YZcTTDQ, juZFa64U)

- [2026-10-16] ✏️ [branch] — **Hamkor filial modeli (8jtzNlFt).**
  `POST /branches` va `PATCH /branches/:id` endi ikkita ixtiyoriy maydonni
  qabul qiladi (avval 400 "property ownership should not exist"):
  `ownership: 'owned' | 'partner'` va `per_order_share` (son yoki satr,
  so'm, `^\d{1,12}(\.\d{1,2})?$`). Qoidalar (backend 400 o'zbekcha xabar
  bilan): `partner` ⇒ `per_order_share > 0` majburiy; `owned` ⇒ ulush 0
  (musbat ulush yuborilsa 400; `owned` ga o'tkazilsa ulush avtomatik 0);
  HQ faqat `owned`; o'zgartirishni faqat admin/superadmin qila oladi (403).
  `GET /branches`, `GET /branches/:id` javobida `ownership`,
  `per_order_share` (son) allaqachon bor edi — endi haqiqiy qiymat. Sotuvda
  hamkor filial ulushi buyurtmaga snapshot qilinadi (keyingi o'zgarish eski
  sotuvlarga ta'sir qilmaydi).
  → 🔧 Frontend: `BranchFormModal` / `BranchEditModal` ga "Filial turi:
  O'zimizniki / Hamkor" tanlagichi va "Har buyurtmaga ulush (so'm)" maydoni
  (faqat Hamkor tanlanganda ko'rinadi va majburiy). HQ uchun tanlagich
  yashirin (doim O'zimizniki). Ro'yxat/detalda "Hamkor · 5 000 so'm" belgisi.
- [2026-10-16] ✏️ [branch] — **XODIMLAR soni va SANA (cI5gqN90).**
  `GET /branches` har qatorida va `GET /branches/:id` da yangi maydonlar:
  `employees_count` (filialga biriktirilgan o'chirilmagan xodimlar —
  menejer/ro'yxatchi/kuryer; `GET /branches/:id/users` qatorlari soniga
  AYNAN teng) va `created_at` (= `createdAt`, ISO satr; snake_case alias).
  → 🔧 Frontend (`branchApi.normalizeBranch`): `created_at: item.created_at
  ?? item.createdAt ?? ""` — hech qachon `new Date()` bilan to'ldirmang;
  `formatDate("")` → "—". `employees_count` endi keladi — `?? 0` zaxirasi
  faqat eski javob uchun. Detal sahifasida XODIMLAR kartasi = jadval
  qatorlari soni (cI5gqN90 TC1/TC2/TC4 — vitest/render).
- [2026-10-16] ✏️ [logistics/identity] — **Xarita tooltipi "Kuryerlar"
  (o2j9uDtT).** `GET /region/stats/all` → `data.regions[]` har elementida
  yangi `activeCouriers` (faqat `status = 'active'` kuryerlar) va
  `totalCouriers`. Viloyatga tegishlilik `GET /region/stats/:id` dagi
  `summary.activeCouriers` bilan bir xil (super-kuryer ham sanaladi).
  identity javob bermasa ikkalasi `null` (yolg'on 0 emas).
  → 🔧 Frontend (`UzbekistanRegionMap.tsx:438`, `entities/region`):
  `couriersCount = region.stats.activeCouriers`; qiymat `null`/`undefined`
  bo'lsa tooltipda "Kuryerlar" qatorini UMUMAN chizmang (o2j9uDtT TC5);
  `Number(p.couriersCount || 0)` zaxirasini olib tashlang.
- [2026-10-16] 🆕 [identity/gateway] — **Rolni o'zgartirish va rol katalogi
  (K3scaE0W).**
  - `PATCH /users/:id/role` `{ role }` — FAQAT superadmin (admin/menejer →
    403). Almashtiriladigan rollar (manba ham, nishon ham): `admin`,
    `registrator`, `manager`, `logist`. Kuryer, market, market_operator,
    mijoz, investor, operator, branch va superadmin almashtirilmaydi (400 —
    ularga kassa/buyurtma/komissiya bog'langan). Filialga biriktirilgan
    foydalanuvchi → 409 (xabarda filial va
    `DELETE /branches/:id/users/:userId` yo'li): avval filialdan chiqaring,
    rol o'zgargach yangi rol bilan qayta biriktiring. Logist'dan chiqishda
    viloyatlari bo'shatiladi. Menejerdan boshqa rolga o'tganda
    `can_sell_cancel`, `can_add_extra_cost`, `tariff_home/center` tozalanadi.
    Muvaffaqiyatda foydalanuvchining sessiyasi yopiladi (qayta kiradi).
    Jurnal: `activity_log` da `old_value.role` / `new_value.role`
    (`metadata.change = 'role'`). Javob — yangilangan user (parolsiz).
  - `GET /roles` (superadmin/admin/menejer) →
    `{ items: [{ role, label, description, staff, creatable,
    create_endpoint, changeable, filterable }], changeable_roles }` —
    `Roles` enum'ining TO'LIQ ro'yxati (branch, investor, market_operator,
    logist ham).
  → 🔧 Frontend: `RoleSelector` va `UserFilters.defaultRoles` ni `GET /roles`
  dan quring (qo'lda uchta ro'yxat o'rniga; filtrga branch / investor /
  market_operator qo'shiladi — K3scaE0W TC1/TC4 snapshot/e2e). Foydalanuvchi
  tahririda (faqat superadmin) "Rolni o'zgartirish" tanlagichi
  (`changeable_roles`), 409 xabarini ko'rsating. `/roles-permissions`
  ma'lumotnoma sahifasi — `access.ts` predikatlaridan jadval (TC5) +
  `GET /roles` yorliqlari.
- [2026-10-16] ✏️ [logistics] — **Pochtaning o'z ma'lumoti (4YZcTTDQ).**
  `GET /post` har qatorida yangi `courier: { id, name, phone_number } |
  null` (courier_id yo'q/'0' yoki kuryer o'chirilgan → `null`; maosh/tarif
  YO'Q). `GET /post/orders/:id` → `data.post` kengaydi (avval faqat
  `{ id, status }`): `{ id, status, courier_id, courier, qr_code_token,
  order_quantity, branch_id, region_id, region: { id, name } | null,
  createdAt }`.
  → 🔧 Frontend: `oldMails.tsx:218` va Excel eksporti (`:430`) `mail.courier
  ?.name` — endi to'ladi ("Kuryer: Buxaro Courier"). Detal sahifasi
  (`pages/mails/detail`, `useMailDetail`): sarlavha (viloyat) va holat
  rozetkasi birlamchi manbasi `data.post` (router state'dagi
  `fallbackRegionName` faqat zaxira) — deep-link `/mails/70` state'siz ham
  to'g'ri holat ko'rsatadi.
- [2026-10-16] 🟢 [analytics] — **Kuryerlar hisoboti N+1 (juZFa64U).**
  `GET /analytics/reports/couriers` javob shakli va raqamlari O'ZGARMAGAN;
  ichkarida har kuryer uchun alohida RPC o'rniga bitta so'rov (60 kuryerda
  sovuq hisob ~217 ms → ~6 ms, RMQ kechikishisiz). 30 s kesh saqlangan.
  Frontend o'zgarishi shart emas.
### 2026-10-16 — O2: buyurtma yaratish — Idempotency-Key, operator ismi/raqami, market qo'shimcha xarajat sozlamasi (gpCIsGjH, VRyloH62, w2bDrE3i)

- [2026-10-16] ✏️ [order] — gpCIsGjH: `POST /orders` endi `Idempotency-Key`
  sarlavhasini qabul qiladi (≤255 belgi; uzun → 400). 🔧 Buyurtma yaratish
  formasi ochilganda bitta kalit (masalan `crypto.randomUUID()`) yarating va
  shu forma sessiyasidagi har yuborishda (qayta urinish, ikki marta bosish)
  AYNAN shu kalitni yuboring; muvaffaqiyatdan keyin yangi kalit. Ayni kalit
  bilan takroriy so'rov ikkinchi buyurtma yaratmaydi — avvalgi javob
  `idempotent_replay: true` bilan qaytadi; birinchisi hali bajarilayotgan
  bo'lsa **409** ("Takroriy so'rov: bu buyurtma hozir yaratilmoqda …").
  Validatsiya xatosidan (400) keyin tuzatilgan so'rov AYNI kalit bilan qayta
  bajariladi. Kalitsiz — avvalgidek. Yaratish tugmasini so'rov tugaguncha
  o'chiq qiling.
- [2026-10-16] ✏️ [order] — VRyloH62: registrator yoki market operatori
  `operator` maydonini bo'sh qoldirsa, unga o'z ismi yoziladi (avtomatik).
  `POST /orders` ga ixtiyoriy `operator_phone` (formadagi raqam). Market
  sozlamasi: `require_operator_phone` va `default_operator_phone`.
  Qoida: doimiy raqam bor — chekda 1-raqam doimiy, formadagi — 2-raqam;
  majburiy va doimiy raqam yo'q — formadagi raqam MAJBURIY (yo'q bo'lsa
  **400** "Operator telefon raqami majburiy …"). Buyurtma qatorida
  `operator_phone`, `secondary_operator_phone`; chekdagi "Muammo bo'lsa"
  qatori shu raqamlarni (yo'q bo'lsa avvalgidek market raqamini) chiqaradi.
  🔧 Forma: "Operator raqami" maydoni (market sozlamasida majburiy bo'lsa
  majburiy belgi bilan).
- [2026-10-16] 🆕 [identity] — VRyloH62: `PATCH /markets/:id/operator-phone`
  (superadmin, admin; market — faqat o'zi, boshqaga 403):
  `{ require_operator_phone?: boolean, default_operator_phone?: string | null }`
  (raqam `+998XXXXXXXXX` ga keltiriladi; `null`/'' — o'chirish). Market
  javobida shu ikki maydon bor. 🔧 Market profili / sozlamalari.
- [2026-10-16] 🆕 [identity] — w2bDrE3i: `PATCH /admin/markets/:id`
  (faqat superadmin, admin):
  `{ extra_cost_enabled?: boolean, extra_cost_requires_approval?: boolean }`
  (kamida bittasi). Market javobida ikkala maydon. YANGI market sukuti —
  `extra_cost_enabled: false`, `extra_cost_requires_approval: true`;
  deploydan oldin mavjud bo'lgan marketlar ochiq qoldi (ortga-moslik).
  `POST /markets` ham shu maydonlarni qabul qiladi (faqat admin/superadmin).
- [2026-10-16] ⚠️ [order] — w2bDrE3i: market sozlamasida
  `extra_cost_enabled: false` bo'lsa sotuv / bekor qilish / qisman sotuvda
  `extraCost > 0` → **403** ("Bu market uchun qo'shimcha xarajat yopiq …").
  `extra_cost_requires_approval: false` bo'lsa qo'shimcha xarajat market
  tasdig'isiz darhol yoziladi (202 emas — oddiy javob). Isbot
  (`expense_proof_conditions`) bundan mustaqil — avvalgidek talab qilinadi.
  🔧 Kuryer modalida qo'shimcha xarajat maydonini market yopiq bo'lsa
  yashiring; admin market tahririda ikki almashtirgich.
### 2026-10-16 — F: AI buyurtma narxi va marja hisoboti (NFiXfmq6), P&L daftari zanjiri (zTYaGWui)

- [2026-10-16] 🆕 [ai] — NFiXfmq6: `GET /ai-usage/margin` (superadmin, admin,
  market). Query: `fromDate`, `toDate`, `marketId` (faqat admin; market rolida
  token'dan, so'rovdagisi e'tiborsiz). Admin javobi (`view: 'admin'`):
  `totals` (`chargedUzs` — olingan narx, `costUzs`/`costUsd` — real
  xarajat, `marginUzs`, `marginNegative`, `aiOrders`, `freeAiOrders`,
  `unpricedAiOrders`, o'rtachalar), `cache` (tejalgan summa, hit-rate),
  `internal` (charj qilinmaydigan ichki AI), `byMarket` (market kesimida
  olingan vs real), `byFeature` (`order_extract_image` alohida qator),
  `dailySeries` (Toshkent kuni), `alerts` (kesh buzildi, market sakrashi,
  manfiy marja). Market javobi (`view: 'market'`): faqat `totals.chargedUzs`,
  `aiOrders`, `freeAiOrders`, `avgChargedPerAiOrderUzs` va kunlik seriya.
  🔧 "Moliyaviy balans" → "AI xarajat va marja" tabi: manfiy marja qizil,
  narx yonida "taxminiy", bo'sh davrda 0, alertlar ro'yxati.
- [2026-10-16] ✏️ [identity] — NFiXfmq6: `PATCH /users/:id` (faqat superadmin,
  admin; faqat market yozuvida) → `ai_price_per_order` (so'm, `null` — global
  narx, sukut 300; `0` — AI bepul; 0..1 000 000). Market javobida shu maydon.
  Narx o'zgarishi faoliyat jurnalida (eski → yangi). Eski AI buyurtmalar
  qayta hisoblanmaydi — har buyurtmada amal qilgan narx saqlanadi.
  🔧 Admin market tahrirlash formasida "AI buyurtma narxi" maydoni.
- [2026-10-16] 🟢 [finance] — zTYaGWui: P&L (moliyaviy balans tarixi)
  zanjiri endi oxirgi TIRIK qatordan davom etadi (o'chirilgan qator
  e'tiborsiz). Kontrakt o'zgarmagan.

### 2026-10-15 — R1: dashboard reyting davri ("Bugun" → oxirgi 30 kun) va bot manbasi (9zbSDkUI, Celz3rKJ)

- [2026-10-15] ✏️ [analytics] — `GET /analytics/dashboard` (admin/superadmin
  va filial rollari): tanlangan davr **bitta Toshkent kuni** bo'lsa (standart
  "Bugun", sanasiz so'rov yoki `startDate = endDate`) `topMarkets` va
  `topBranches` endi shu kun bilan tugaydigan **oxirgi 30 kun** bo'yicha
  keladi (kunlik ko'rinishda kartalar bo'sh turmaydi). 2+ kunlik davrda
  (shu jumladan "Bu hafta"/"Bu oy"/`all=true`) — avvalgidek **aynan
  tanlangan davr**. Qolgan bo'laklar (`orders`, `markets`, `couriers`,
  `branchDashboard`) har doim tanlangan davrda. `topMarketsMeta` /
  `topBranchesMeta` ga yangi maydonlar:
  `{ min_orders, filtered_out, from, to, period_rule: 'last_30_days' | 'selected_range', period_days: 30 | null, selected_from, selected_to }`.
  `from`/`to` — reytingning HAQIQIY oynasi, `selected_from`/`selected_to` —
  foydalanuvchi tanlagan davr. Market/market operatori dashboardi
  o'zgarmagan (u yerda `period_rule` yo'q).
  → 🔧 Frontend: reyting kartasi sarlavhasida davr yozuvi —
  `period_rule === 'last_30_days'` bo'lsa **"Oxirgi 30 kun"**, aks holda
  `from`–`to` (Toshkent sanasi). Bo'sh holat matni "kamida 30 buyurtma
  kerak" eskirgan — `meta.min_orders` dan oling (hozir 1). Bo'sh kartaga
  `<TopPerformers … compact />` (≤120px) va 390px'da ustma-ust kartalar
  bo'sh joy qoldirmasin (9zbSDkUI TC3/TC4/TC6).
- [2026-10-15] ✏️ [ai-usage/order] — `GET /ai-usage/dashboard` →
  `orderSources` endi **bot** manbasini alohida beradi va ulushlarni
  hisoblaydi:
  `{ total, ai, manual, bot, external, branch, shares: { ai, manual, bot, external, branch }, applied_range } | null`.
  `shares` — foiz (0–100, 1 xona; `total = 0` bo'lsa hammasi 0).
  `ai + manual + bot + external + branch = total`. Bot = Telegram bot
  WebApp (`POST /orders/telegram/bot/create`) orqali yaratilgan buyurtmalar
  (yangi `orders.created_via = 'bot'` ustuni); ustun deploy qilinishidan
  OLDINGI bot buyurtmalari `manual` ichida qoladi (backfill yo'q).
  → 🔧 Frontend ("Moliyaviy balans → AI xarajat" tabi): "Buyurtma manbasi"
  blokida AI / Qo'lda / Bot (+ Tashqi / Filial) nisbatini `shares` dan
  ko'rsating (Celz3rKJ TC6). 14-oktabr yozuvidagi "Bot manbasi alohida
  belgilanmaydi" izohi endi eskirgan.
- [2026-10-15] 🟢 [order] — to'liq buyurtma obyekti qaytadigan javoblarda
  (masalan `GET /orders/:id`) yangi `created_via: 'bot' | null` maydoni
  paydo bo'ladi (faqat ma'lumot;
  `POST /orders` DTO'si uni QABUL QILMAYDI — yuborilsa 400).

### 2026-10-15 — SMS kampaniyasi FAQAT reklama: "Xizmat xabari" olib tashlanadi (sVByLMnt, R3)

- [2026-10-15] ⚠️ [notification/sms] — `POST /notifications/sms/campaigns/preview`
  va `POST /notifications/sms/campaigns` endi **faqat reklama (`promo`)**
  qabul qiladi. Sabab: `message_class: 'transactional'` ("Xabar turi: Xizmat
  xabari") rozilik darvozasini ham, 18:00–09:00 taqiqini ham chetlab o'tardi —
  admin reklama matnini tunda roziliksiz yuborishi mumkin edi. Xizmat
  (`transactional`) va OTP (`security`) SMS endi faqat **tizim hodisalaridan**
  ketadi (buyurtma holati dispatch'i, CRITICAL eskalatsiya, OTP) — ular tunda
  ham ishlaydi, o'zgarmagan.
  **Kontrakt:**
  - `message_class` — ixtiyoriy; berilmasa `promo`. Faqat `'promo'` ruxsat.
    `'transactional'` / `'security'` → **400** (gateway validatsiyasi:
    `"message_class: kampaniya faqat 'promo' — ..."`).
  - `template_code` bilan: shablonning `message_class` i `promo` bo'lmasa
    (masalan `order.delivered` — transactional) → **400**,
    `{ reason: 'campaign_promo_only', message_class: 'transactional' }`.
  - Preview javobida `message_class` doim `'promo'`; `blocked_no_consent`,
    `sample_text` (opt-out havolasi bilan), `scheduled_for` (taqiq oynasida —
    ertangi 09:00) har doim reklama qoidasi bo'yicha.
  - Kampaniyalar tarixi (`GET /notifications/sms/campaigns`) — eski
    `transactional` kampaniyalar tarixda shu qiymat bilan qoladi.
  **Frontendda (`src/pages/notifications/ui/CampaignPage.tsx`):**
  - 🔧 "Xabar turi" tanlagichini (Reklama / Xizmat xabari) olib tashlash —
    `message_class: 'promo'` yuborish yoki umuman yubormaslik
    (`useState<"promo" | "transactional">` → doim `promo`).
  - 🔧 Shablon ro'yxatida faqat `message_class === 'promo'` shablonlarni
    ko'rsatish (hozir faqat `security` filtrlanadi, transactional shablonlar
    ham chiqadi); `effectiveClass` doim `promo`.
  - 🔧 400 `campaign_promo_only` xabarini foydalanuvchiga ko'rsatish.
  - 🟢 Shablonlar tabida `transactional` shablonlar qoladi — ular tizim
    dispatch'i uchun, kampaniya uchun emas.

### 2026-10-15 — AI tuman fallback'i: tuman ro'yxati keshlangan system-promptda (R2, 5Z1ZvvzE)

`[2026-10-15] [ichki] [ai-service, order-service]` — `ai.district.pick` endi barcha
tumanlar ro'yxatini (`ORDER BY id`) Anthropic prompt keshi bilan system-promptda
yuboradi, model sukuti `AI_DISTRICT_MODEL=claude-sonnet-5`. **Frontendda hech narsa
qilinmaydi:** HTTP javoblari (`POST /orders/ai-parse` preview, `GET /ai/status`) va ularning
maydonlari o'zgarmagan; tuman tanlovi oldingidek `district_id` / `candidates` bilan keladi.
Faqat backend jurnali: `ai_usage_log` dagi `feature='order_district'` qatorlarida endi
`cache_read_tokens > 0` bo'lishi mumkin (yangi ustun/endpoint yo'q).

### 2026-10-15 — Faoliyat jurnali arxivi: `?archive=true` (i6Nyedea, Guruh R4)

- [2026-10-15] ✏️ [gateway] — `GET /activity-logs` (va `/activity-logs/user/:user_id`)
  YANGI ixtiyoriy query parametri `archive` (`true` / `false`; boshqa qiymat —
  400). `archive=true` — saqlash muddati o'tib **arxivga ko'chirilgan**
  qatorlar (har servisning `activity_logs_archive` jadvali). Filtrlar
  (`service`, `entity_type`, `entity_id`, `action`, `user_id`, `user_role`,
  `trace_id`, `from`, `to`, `search`), `page`/`limit` va `cursor`
  (`meta.next_cursor`) AYNAN joriy jurnaldagidek; kursor bilan davom etganda
  `archive=true` ni ham qayta yuboring. Rollar o'zgarmagan: `superadmin`,
  `admin`.
  **Javob farqi:** har qatorda qo'shimcha `archived_at` (ISO, arxivga
  ko'chirilgan vaqt) va `archive_rule` (`"auth"` — kirish hodisalari, 90 kun;
  `"default"` — qolgani, 3 yil); `meta.archive: true`. Arxiv qatorlarida
  `metadata` dan `ip`, `user_agent`, `device_id`, `device_name` olib
  tashlangan (shaxsiy ma'lumot muddati).
  ```http
  GET /activity-logs?archive=true&entity_type=Order&entity_id=100439
  ```
  ```json
  { "data": { "items": [{ "id": "41", "action": "order.sell", "created_at": "2023-01-01T00:00:00.000Z",
      "archived_at": "2026-10-15T03:15:00.000Z", "archive_rule": "default", "...": "..." }],
    "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1, "next_cursor": null, "archive": true } } }
  ```
  ⚠️ Hozircha arxiv BO'SH: o'chirish/ko'chirish bayrog'i
  (`ACTIVITY_LOG_PRUNE_ENABLED`) prod'da o'chiq — muddatlar ega bilan
  kelishilgach yoqiladi. `/activity-logs/entity/:type/:id` (bitta obyekt
  tarixi) faqat joriy jurnaldan o'qiydi — arxiv uchun
  `GET /activity-logs?archive=true&entity_type=…&entity_id=…` ishlating.
  → **Frontendda:** 🔧 "Faoliyat jurnali" sahifasiga "Arxiv" almashtirgichi
  (tab yoki switch): yoqilganda barcha so'rovlarga `archive=true` qo'shilsin,
  jadvalda "Arxivlangan" ustuni (`archived_at`) ko'rsatilsin; qolgan
  ko'rinish/filtrlar o'zgarishsiz.

### 2026-10-15 — Guruh R5: buyurtma eksporti, tanlangan mijoz, investor logini, hudud doirasi (xWsCAA5N, hiqRNhkI, vpKijXce, uherIk8r)

- [2026-10-15] 🆕 [api-gateway] — `GET /orders/export/excel` (xWsCAA5N) —
  buyurtmalar ro'yxatining **haqiqiy .xlsx** eksporti, **bitta HTTP so'rov**.
  Query — `GET /orders` dagi filtrlar bilan AYNAN bir xil (`status`,
  `search`, `start_day`/`end_day`, `market_id`, `region_id`, `district_id`,
  `branch_id`, `courier_id`/`courier_ids`, `where_deliver`, `source`,
  `sort_by`/`sort_dir`, `cancelled_inventory`); `page`/`limit`/`fetch_all`
  YO'Q — filtrga mos HAMMA qator (50 000 gacha). Rol doirasi ham `GET /orders`
  bilan bir xil (market — o'ziniki, filial xodimi — o'z filiali, kuryer —
  o'ziniki). **Rollar:** superadmin, admin, manager, registrator, branch,
  market, market_operator, courier (customer/investor/logist/operator — 403).
  **Javob:** `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
  `Content-Disposition: attachment; filename="barcha_buyurtmalar_YYYY-MM-DD.xlsx"`.
  Sarlavhalar (CORS'da ochiq, JS o'qiy oladi): `X-Export-Total` (filtr bo'yicha
  jami), `X-Export-Limit` (50000), `X-Export-Truncated` (`true` — fayl
  chegarada kesilgan; faylning oxirida qizil «DIQQAT» qatori ham bor).
  Ustunlar: N, Buyurtma ID, Viloyat, Tuman, Firma, Mahsulot, Mijoz, Telefon
  raqam, Narxi, Kuryer (ism), Holati (uz), Sana (Toshkent); oxirida «Jami»
  qatori (soni + Narxi yig'indisi). Xato (403/400/504) — oddiy JSON xato,
  fayl emas.
  → 🔧 **frontend** (`src/pages/orders/index.tsx` `handleExportOrders`):
  sahifalash siklini (`EXPORT_PAGE_SIZE=100`, `exportPage >= 100`) va
  `exportOrdersToExcel.ts` HTML yasashni olib tashlab, joriy filtrlar bilan
  BITTA `GET orders/export/excel` (`responseType: 'blob'`,
  `LONG_REQUEST_TIMEOUT_MS`) chaqiring va blob'ni `Content-Disposition`
  dagi nom bilan saqlang (`xlsx` kutubxonasi shart emas). `X-Export-Truncated: true`
  bo'lsa `message.warning` bilan «faylda X ta, jami Y ta — filtrni toraytiring»
  ko'rsating (`X-Export-Total`). Xato javobi ham blob bo'lib keladi — JSON
  sifatida o'qib `message` ni chiqaring. Bu karta TC3 (bitta so'rov), TC4
  (Excel ogohlantirishsiz ochiladi), TC5 (jami qatori), TC2 (10 000+ to'liq /
  aniq ogohlantirish) ni yopadi.
- [2026-10-15] ✏️ [api-gateway] — eski `GET /export/orders.xlsx`: 100 dan
  ortiq buyurtma JIMGINA tushib qolardi (order-service sahifasi 100 bilan
  cheklangan edi) — tuzatildi (`max_limit`). Kontrakt o'zgarmadi. 🟢
- [2026-10-15] ✏️ [api-gateway] — `POST /orders` `customer_id` (hiqRNhkI TC3):
  endi market, market operatori va filial xodimi (registrator/manager/branch)
  ham `GET /customers/suggest` dan tanlangan mijozni `customer_id` bilan
  yubora oladi — **faqat** shu marketda (o'chirilmagan) buyurtmasi bor mijoz
  (suggest bilan AYNI doira; filial xodimi uchun `market_id` dagi market).
  Doiradan tashqari id: `customer` obyekti ham bo'lsa — avvalgidek telefon
  bo'yicha mijoz; obyektsiz — **403**. Superadmin/admin — o'zgarishsiz.
  `POST /orders/external` — o'zgarmagan (faqat admin).
  → 🔧 **frontend** (Step2Combined / `buildCreateOrderPayload`): taklif
  tanlanganda formaga `customer_id` yozing va `customer` o'rniga (yoki
  yonida) `customer_id` yuboring; foydalanuvchi telefon/ismni o'zgartirsa
  tanlovni bekor qilib, yana `customer` obyektiga qayting. 403 matni:
  «customer_id faqat shu marketda buyurtmasi bor mijoz uchun...».
- [2026-10-15] 🆕 [api-gateway/identity] — investor LOGINI (vpKijXce):
  `POST /investor-users` `{ name, phone_number (+998...), password (≥6) }` →
  rol = `investor` foydalanuvchi (maosh/filial/kassa yo'q; BeePost
  `POST /users/investor` naqshi). `GET /investor-users?search&status&page&limit`
  — investor loginlari ro'yxati (bog'lash uchun tanlov). **Rollar:**
  superadmin, admin. O'chirish — umumiy `DELETE /users/:id`.
  ✏️ `POST /investors` / `PATCH /investors/:id` `user_id` — endi faqat
  **investor rolli** login id si qabul qilinadi (boshqa rol — 400; uzish
  `user_id: null` — o'zgarishsiz).
  → 🔧 **frontend** (`src/pages/investors-ops/`): investor formasiga
  «Login» bloki — (1) yangi login: `POST /investor-users` → javobdagi `id` ni
  (2) `POST/PATCH /investors {user_id}` ga yozing; yoki mavjud loginni
  `GET /investor-users` dan tanlang. Shundan keyin investor o'z logini bilan
  kirib `/investors/me*` ni ko'radi (karta TC1/TC5/TC7 frontend qismi).
- [2026-10-15] 🆕 [api-gateway] — investor ichki marshrutlari ISHLAYDI
  (vpKijXce): ilgari ikki qavat dekorator tufayli ro'yxatdan o'tmagan edi
  (404): `POST /investors/:investor_id/investments`,
  `PATCH|DELETE /investors/:investor_id/investments/:id`,
  `POST /investors/:investor_id/profits`,
  `POST /investors/:investor_id/profits/calculate`. Body'da `investor_id`
  shart emas (berilsa yo'ldagi bilan bir xil bo'lishi kerak, aks holda 400);
  PATCH/DELETE da investitsiya shu investorniki bo'lmasa — 404. Tekis
  yo'llar (`/investments`, `/profits`, `/profits/calculate`) o'zgarmagan.
  **Rollar:** superadmin, admin. 🟢 (frontend hozir tekis yo'llarni ishlatadi)
- [2026-10-15] ⚠️ [logistics] — `GET /region/stats/all` va `GET /region/stats/:id`
  (uherIk8r, karta 3-band): **HQ filiali** menejeri/registratori endi ham
  faqat o'z (HQ filiali) viloyatini oladi; boshqa viloyat `stats/:id` — 403.
  Hamma viloyat — faqat superadmin, admin, logist.
  → 🔧 **frontend**: HQ registratori bosh sahifadagi hudud xaritasi
  (`widgets/dashboard-region/RegionStatsCard.tsx`) endi bitta viloyat oladi —
  manager/kuryer kabi `GET /region/my/district-stats` (tumanlar kesimi)
  yoki bitta viloyat ko'rinishiga o'ting; `pages/region` da menejer uchun
  `getProfileBranchId` `profile.branch.branch_id` ni olsin (oldingi yozuv).

### 2026-10-15 — R6: kargo avansi, filial smenasi, asosiy kassa nomli kartalari (utIffRFx, QTCUUgjA, kfdfYDik, 3PE0B03q)

- [2026-10-15] ✏️ [integration/api-gateway] — **Kargo to'lovining ortiqcha
  qismi endi hamkor AVANSI** (utIffRFx 4-band). Qarz qatorlariga sig'magan
  qoldiq (`unapplied_amount > 0`) yo'qolmaydi: KEYINGI `POST
  /integrations/:id/remittances` da avval avans + yangi summa bilan qarzlar
  FIFO (eng eskisidan, faqat to'liq qatorlar) yopiladi. Kassaga avvalgidek
  faqat haqiqiy kelgan summa yoziladi (avans allaqachon kassada).
  `POST /integrations/:id/remittances` javobida YANGI: `advance_applied`
  (shu to'lovda avvalgi avansdan ishlatilgani), `advance_balance`
  (to'lovdan keyingi hamkor avansi). `unapplied_amount = amount +
  advance_applied − settled_amount`. `warning` matni (qoldiq > 0): "…
  qoldiq hamkor AVANSIGA o'tdi va keyingi to'lovda avtomatik qarzlarga
  qo'llanadi". `GET /integrations/:id/receivable-balance` javobida YANGI:
  `advance_balance`, `payable_amount` (= max(0, `outstanding_amount` −
  `advance_balance`) — shu summa kelsa barcha qarz yopiladi).
  `GET /integrations/:id/remittances` qatorlarida YANGI `advance_applied`
  (`null` — eski yozuv). Misol: avans 800 000, qarz 2 000 000 →
  `payable_amount: 1200000`; 1 200 000 to'lansa `settled_amount: 2000000,
  advance_applied: 800000, advance_balance: 0`.
  → **Frontendda:** 🔧 `ConnectionSettlement.tsx`: overpay chegarasi
  (`<InputNumber max>` va "Qarzdan ortiq summa" Alert) uchun
  `outstanding_amount` o'rniga **`payable_amount`** ni ishlating; "Avans:
  N so'm" ko'rsatkichi (`advance_balance`); natija oynasida
  `advance_applied` / `advance_balance`. Eski "Kassaga yozilmaydi"
  ogohlantirishini olib tashlang (to'lov MAIN kassaga yoziladi).
- [2026-10-15] ⚠️ [integration/api-gateway] — **To'lovni bekor qilish
  (`POST /integrations/:id/remittances/:remittance_id/cancel`)**: to'lovdan
  qolgan avans KEYINGI to'lov(lar)da qarz yopishga ishlatilgan bo'lsa — **409**
  "Bu to'lovdan qolgan avansning N so'mi keyingi to'lov(lar)da qarz yopishga
  ishlatilgan (#78) — avval o'sha to'lovlarni (eng oxirgisidan boshlab) bekor
  qiling, keyin buni." — hech narsa o'zgarmaydi (kassa ham). Avansdan
  foydalangan to'lov bekor qilinsa avans hamkorga QAYTADI
  (`advance_balance` ortadi). Teskari kassa chiqimi endi tranzaksiya va
  hamkor qulfi ichida — kontrakt o'zgarmagan (javob, 400/409, idempotentlik).
  → **Frontendda:** 🔧 409 xabarini tasdiq oynasida ko'rsating (qaysi
  to'lovni avval bekor qilish kerakligi matnda).
- [2026-10-15] 🆕 [finance/api-gateway] — **Filial (menejer) smenasi**
  (QTCUUgjA "shu kassaga biriktirilgan ochiq smena"). `POST
  /finance/shift/open`, `POST /finance/shift/close`, `GET
  /finance/shift/current` endi **MANAGER** roli uchun ham: menejer faqat O'Z
  filiali kassasining smenasini ochadi/yopadi/ko'radi (filial JWT'dan; body'da
  `cashbox_user_id` yuborib bo'lmaydi — 400). Menejer boshqa kassa
  smenasini (masalan `shift_id` bilan MAIN) yopmoqchi bo'lsa — 404 "Ochiq
  smena topilmadi". Superadmin/admin/registrator — o'zgarishsiz (MAIN).
  `GET /finance/shift/current` → `data: { shift, required, cashbox_user_id }`
  (menejerda `cashbox_user_id` = filial ID; `required` — shu kassa uchun).
  Smena darvozasi `FINANCE_REQUIRE_OPEN_SHIFT` (sukut O'CHIQ): `true`/`main` —
  avvalgidek faqat MAIN; YANGI `all` — MAIN + filial: smenasiz menejer
  operatsiyalari (kuryerdan qabul, `PATCH /finance/cashbox/spend|fill`,
  `POST /finance/cashbox/payment/branch-to-main` — pul filialdan chiqadi)
  400 "Smena ochilmagan! Bu operatsiyani bajarish uchun avval filial
  kassasida smenani oching.". Sotuv/bekor qilish (outbox) darvozalanmaydi.
  → **Frontendda:** 🔧 menejer filial kassasi sahifasiga "Smenani ochish /
  Smenani yopish" tugmasi va banner (`GET /finance/shift/current` →
  `required && !shift` bo'lsa to'lov tugmalarini bloklang); yopish oynasida
  sanalgan naqd/karta (`closing_balance_cash/card`). Backend `all` faqat shu
  UI chiqqandan keyin yoqiladi.
- [2026-10-15] 🆕 [finance/api-gateway] — **Asosiy kassa NOMLI kartalari**
  (3PE0B03q UZOQ MUDDAT — BeePost `CardsManager` porti; SUPERADMIN, ADMIN):
  - `GET /finance/cashbox/cards?include_inactive=true` → `data: { cards[],
    balance_card, named_total, default_balance, total_card, in_sync }`.
    `cards[] = { id, name, balance, is_default, is_active, sort_order,
    created_at }`; birinchisi — himoyalangan **"Asosiy karta"** (balansi =
    `balance_card − Σ nomli kartalar`; kartasiz har qanday karta harakati shu
    yerga tushadi). `total_card == balance_card`; `in_sync: false` — nomli
    kartalar `balance_card` dan oshgan (Asosiy karta manfiy) — o'tkazma bilan
    tuzating.
  - `POST /finance/cashbox/cards` `{ name (1–100), sort_order? }` → 201;
    nom takrori (harf farqsiz) — 409.
  - `PATCH /finance/cashbox/cards/:id` `{ name }` — Asosiy karta — 400.
  - `PATCH /finance/cashbox/cards/:id/status` `{ is_active }` — arxivlash
    faqat balans 0 bo'lsa (aks holda 400); Asosiy kartani arxivlab bo'lmaydi.
  - `POST /finance/cashbox/cards/transfer` `{ from_card_id, to_card_id,
    amount, comment (majburiy) }` — `balance_card` o'zgarmaydi; manba kartada
    mablag' yetmasa 400. `Idempotency-Key` sarlavhasi bilan takroriy so'rov
    ikkinchi o'tkazma yozmaydi (`idempotent: true`).
  - `POST /finance/cashbox/cards/convert` `{ type: "card_to_cash" |
    "cash_to_card", card_id, amount, comment }` — kassa umumiy balansi
    o'zgarmaydi, naqd/karta ajratmasi o'zgaradi; `Idempotency-Key`.
  - `GET /finance/cashbox/cards/movements?card_id&page&limit` — ichki
    harakatlar jurnali (`from_card_name`, `to_card_name`, `balance_after_*`).
  - `GET /finance/cashbox/cards/:id/ledger?from_date&to_date&page&limit` —
    karta ko'chirmasi: `items[] = { kind (income|expense|transfer_in|
    transfer_out|card_to_cash|cash_to_card), amount, delta, balance_after,
    comment, created_by, created_at, ... }`, `summary { opening_balance,
    closing_balance, total_in, total_out, current_balance }`.
  - Ixtiyoriy **`card_id`** (raqamli satr) — `click` to'lovida qaysi nomli
    kartadan/kartaga: `PATCH /finance/cashbox/spend`, `PATCH
    /finance/cashbox/fill` (MAIN), `POST /finance/cashbox/payment/market`,
    `POST /finance/cashbox/payment/branch-to-main`. Naqdda yoki filial
    kassasida `card_id` — 400; nomli kartada mablag' yetmasa 400 (kassa
    ham o'zgarmaydi); arxivlangan karta — 400. Kassa tarixi qatorlarida
    YANGI `card_id` (`null` — Asosiy karta). `PATCH /finance/cashbox/balance`
    `card_id` qabul qilmaydi (400).
  - Smena darvozasi yoqilgan bo'lsa (`FINANCE_REQUIRE_OPEN_SHIFT`) o'tkazma va
    konvertatsiya ham MAIN smenasiz 400; smena yopishda karta↔naqd
    konvertatsiyasi `expected_balance_cash/card` ga qo'shiladi (soxta
    kamomad chiqmaydi).
  → **Frontendda:** 🔧 `/payments` da "Kartalar" bo'limi (BeePost
  `CardsManager.tsx`: ro'yxat, qo'shish, nomini o'zgartirish, arxivlash,
  kartalararo o'tkazma, karta↔naqd, `in_sync` ogohlantirishi) va
  `/payments/card-detail/:id` (ledger). "O'tkazma" (click) to'lov
  oynalarida xodim ("o'tkazma manbasi") o'rniga **karta tanlovi** →
  `card_id` (ro'yxatda "Ism — N so'm" soxta qoldiqlar o'rniga haqiqiy karta
  balansi). Har o'tkazma/konvertatsiya so'roviga `Idempotency-Key`.

### 2026-10-15 — Pochta detalidan buyurtmani o'chirish (superadmin savati, yokjwjXG)

- [2026-10-15] 🆕 [order/logistics] — `POST /post/delete` — superadmin
  pochta detalida (`/mails/:id`) buyurtmani **SHU POCHTADAN O'CHIRADI**:
  buyurtma tizimdan butunlay (soft-delete) o'chadi. Bu **bekor qilish
  EMAS** — `POST /post/cancel` (kuryer/menejerning "bekor qilinganlarni
  pochtaga yuborish" oqimi) o'zgarmagan va superadminga hamon 403.
  "Buyurtmani qoldirib faqat pochtadan chiqarish" yo'q: pochtasiz HQ
  buyurtmasi keyingi yuklashda avtomatik qayta pochtaga tushadi.
  **Rollar:** faqat `superadmin` (admin, manager, registrator, courier,
  market, branch — 403).
  **Payload:**
  ```json
  {
    "post_id": "88",
    "order_ids": ["700", "701"],
    "reason": "Market posilkani qaytarib oldi"
  }
  ```
  `post_id` — musbat butun son (satr; JSON son ham qabul qilinadi);
  `order_ids` — 1..100 ta, takrorsiz, har biri musbat butun son;
  `reason` — majburiy, chekka bo'sh joylar kesiladi, 3..500 belgi
  (jurnalga yoziladi). Boshqa maydon — 400.
  **Javob (200):**
  ```json
  {
    "statusCode": 200,
    "message": "2 ta buyurtma pochtadan o'chirildi",
    "data": {
      "post_id": "88",
      "deleted": ["700", "701"],
      "skipped": [],
      "post_deleted": false,
      "order_quantity": 3,
      "post_total_price": 450000
    }
  }
  ```
  `skipped` — allaqachon o'chirilgan id'lar (xato emas, takroriy so'rov
  xavfsiz; hammasi skipped bo'lsa ham 200, `deleted: []`).
  `post_deleted: true` — oxirgi buyurtma o'chdi va **bo'sh pochta ham
  o'chirildi** (`order_quantity: 0`) → detal sahifasidan chiqing.
  `order_quantity` / `post_total_price` — pochtaning jonli qatorlardan
  qayta hisoblangan yangi qiymati.
  **Hammasi-yoki-hech biri:** bitta buyurtma o'chirib bo'lmasa hech narsa
  o'zgarmaydi.
  **Xatolar:**
  | Kod | Qachon | `message` |
  |---|---|---|
  | 400 | payload noto'g'ri (id, 0/100+ ta, takror, sabab < 3 yoki > 500) | validatsiya matni |
  | 403 | superadmin emas | `Forbidden resource` |
  | 404 | pochta topilmadi | `Pochta #88 topilmadi` |
  | 409 | pochta jo'natilgan (`status ≠ new`) | `Pochta #88 jo'natilgan (holati: sent) — undan buyurtma o'chirib bo'lmaydi` |
  | 409 | buyurtma(lar) to'sildi — ro'yxat matnda | `2 ta buyurtmani pochtadan o'chirib bo'lmaydi: #701 — kuryer qo'lida; #702 — sotilgan. Hech narsa o'zgarmadi` |
  | 409 | pochta/buyurtma boshqa amal bilan band (5 s) | `Pochta yoki buyurtma hozir boshqa amal bilan band — birozdan keyin qayta urinib ko'ring` |
  | 504 | order-service 15 s da javob bermadi | qayta yuklab tekshiring (takror so'rov xavfsiz) |
  409 sabablari (matnda `#id — sabab`): `topilmadi`, `bu pochtaga tegishli
  emas`, `holati o'chirishga mos emas (…)`, `kuryer qo'lida`, `sotilgan`,
  `bekor qilingan pochtada`, `qaytarish so'ralgan`, `naqd pul yig'ilgan`,
  `filiallararo partiyada yo'lda`.
  **Yon ta'sirlar (backend o'zi bajaradi, frontend hech narsa qilmaydi):**
  hamkor (BeePost) buyurtmasi bo'lsa hamkorga `cancelled` webhooki ketadi
  va bog'lanish yopiladi (hamkor qayta yuborsa — yangi buyurtma); kutilayotgan
  (PENDING) filiallararo partiyadan chiqariladi va partiya soni tuzatiladi;
  onlayn oldindan to'langan summa jurnalga yoziladi (pul yo'qolmaydi,
  qaytarish moliya tomonidan); qidiruv indeksi va pochta qidiruv yozuvi
  yangilanadi; har buyurtmada kuzatuv (tracking) "pochtadan o'chirildi"
  qatori.
- [2026-10-15] ✏️ [logistics] — `GET /post/orders/:id` javobiga
  **qo'shimcha** `data.post: { id, status }` (pochtaning o'zi). Mavjud
  maydonlar (`allOrdersByPostId`, `homeOrders`, `centerOrders`)
  o'zgarmagan. Savatni shu `status` bo'yicha ko'rsating.
- [2026-10-15] 🟢 [order] — `DELETE /orders/:id` (bitta buyurtma, pochtadagi
  `received`) endi `deleted_at` ni ham yozadi va parallel o'zgarishda
  (UPDATE 0 qator) haqiqatan 409 qaytaradi (ilgari jimgina 200 bo'lardi).
  Kontrakt o'zgarmagan.
  → **Frontendda:** 🔧 `pages/mails/detail/index.tsx`:
  1. Har buyurtma qatorida **chop etish tugmasi yonida savat** — faqat
     `role === "superadmin"` **va** `data.post.status === "new"` bo'lsa
     (`canDelete={false}` olib tashlanadi; boshqa holatlarda yashirin).
     Ko'p tanlab o'chirish ham shu endpoint (`order_ids` massivi, ≤ 100).
  2. Bosilganda **tasdiq oynasi**: "Buyurtma(lar) tizimdan **butunlay
     o'chiriladi** — bu bekor qilish emas, qaytarib bo'lmaydi" + majburiy
     **sabab** maydoni (3–500 belgi, bo'sh bo'lsa tugma o'chiq).
  3. Eski `SendToPost` (`POST /post/cancel`) chaqiruvi bu sahifadan olib
     tashlansin — o'rniga yangi mutation `POST /post/delete`
     (`{ post_id, order_ids, reason }`).
  4. Muvaffaqiyatda: `mails` query'lari (`queryKey: ["mails", ...]` — detal,
     ro'yxatlar, bugungi/eski pochtalar), `orders` va pochta/sidebar
     raqamlari (soni, summa) yangilansin; `post_deleted: true` bo'lsa
     pochtalar ro'yxatiga (`getMailTabPath("today")`) qayting.
  5. 409 xabarini **o'zgartirmasdan** toast'da ko'rsating — unda qaysi
     `#id` nima sababdan o'chmagani yozilgan; hech narsa o'chmagan, tanlov
     saqlansin.

### 2026-10-15 — Sotuvda "To'langan summa", bekor qilishda to'lov yo'q, bekor sabablari statistikasi, ish rejimi UI (T0UGh8bL, smioRTUg, PUvKXWVw, DOZ6dtJn)

- [2026-10-15] ✏️ [order] — **`POST /orders/sell/:id` — `paidAmount` endi QABUL
  qilinadi** (T0UGh8bL TC3; ilgari ZsPLevZZ bo'yicha `> 0` → 400 edi).
  Ma'nosi: **sotuvchi (kuryer yoki menejer) mijozdan yig'ilgan naqddan
  marketga TO'G'RIDAN-TO'G'RI bergan summa** (so'm, butun son). Backend shu
  sotuv tranzaksiyasida pul oqimini to'liq yozadi: market kassasi −X
  (`market_payment`), sotuvchi kassasi −X (kuryer — `courier_payment`,
  menejer — filial kassasi), settlement'ning market/kuryer/filial oyoqlari −X
  — HQ keyin marketga to'laganda X ikkinchi marta to'lanmaydi.
  Misol: narx 250 000, market tarifi 45 000, kuryer ulushi 30 000,
  `paidAmount: 205 000` → market kassasi +205 000 −205 000 = 0, kuryer kassasi
  +220 000 −205 000 = 15 000 (filialga shuni topshiradi), holat **PAID**.
  `paidAmount: 100 000` → **PARTLY_PAID** (HQ qolgan 105 000 ni to'laydi).
  - Holat: buyurtma bo'yicha marketga to'lanadigan SOF summa
    (`to_be_paid − extraCost`) to'liq yopilsa `paid`, aks holda
    `partly_paid`; `paidAmount` 0 / yo'q — avvalgidek `sold`.
  - **400** (aniq xabar, hech narsa yozilmaydi): kasr / manfiy / son emas;
    `paidAmount` > marketga shu buyurtma bo'yicha to'lanadigan summa (market
    bizga qarzdor bo'lsa — avval qarz yopiladi, chegara kamayadi; xabarda
    chegara: `paidAmount (X) marketga shu buyurtma bo'yicha to'lanadigan
    summadan (Y) oshmasligi kerak`); hamkor (tashqi, `external_id` li)
    buyurtma; HQ menejeri sotuvi (filial kassasi yo'q).
  - Javob: `data: { id, status, to_be_paid, paid_amount, sale_market_paid_amount }`
    (ilgari `data: {}`).
  - `GET /orders/:id` — yangi maydon `sale_market_paid_amount` (sotuvda
    marketga berilgan summa; `null` — berilmagan). `paid_amount` = shu summa +
    market qarzidan avtomatik yopilgan qism + HQ keyingi to'lovlari.
  - X bilan sotilgan buyurtma `paid`/`partly_paid` bo'lgani uchun uni faqat
    **superadmin** rollback qila oladi (X ham kassalarga qaytariladi).
  → **Frontendda:** 🔧 `SellModal.tsx` (`SellPayload`) ga **"Marketga
  to'langan summa"** (`paidAmount`, sukut 0) maydoni; izoh: "mijozdan olingan
  puldan marketga o'zingiz bergan qism"; maksimum ko'rsatma
  `to_be_paid − extraCost` (yakuniy chegara — backend 400 xabari).
  Hamkor buyurtmasida (`external_id`) maydonni ko'rsatmang. Javobdagi
  `data.status` bo'yicha toast: `paid` — "Sotildi, marketga to'liq to'landi",
  `partly_paid` — "Sotildi, marketga qisman to'landi", `sold` — avvalgidek.
  `courier-bulk` (`paidAmount: 0`) — o'zgarish shart emas.
- [2026-10-15] 🔧 [order] — **Bekor qilish oynasidan "To'langan summa" olib
  tashlansin** (T0UGh8bL TC1, smioRTUg — B yo'li). Bekor qilingan buyurtmada
  to'lov bo'lmaydi: `POST /orders/cancel/:id` `paidAmount` ni qabul QILMAYDI.
  Eski kesh/klient `paidAmount: 0` (yoki `"0"`) yuborsa — 400 YO'Q;
  `> 0` → **400** `"paidAmount bekor qilishda qabul qilinmaydi — faqat 0
  bo'lishi mumkin"`. → **Frontendda:** 🔧 `CancelModal.tsx` — `paidAmount`
  state, input (`t("paidAmount")`) va `onCancel(...)` dagi maydon olib
  tashlansin; `entities/orders/index.ts` `CancelOrder` `data` tipidan ham.
  Oynada qoladi: sabab (select), qo'shimcha xarajat, izoh, dalil.
- [2026-10-15] 🔧✏️ [order] — **Bekor qilish sababi majburiy + statistika**
  (PUvKXWVw).
  - Bekor qilish: `reason` — yopiq ro'yxat `CUSTOMER_NO_ANSWER` (Mijoz javob
    bermadi), `CUSTOMER_REFUSED` (Mijoz rad etdi), `WRONG_ADDRESS` (Manzil
    noto'g'ri), `DEFECTIVE_PRODUCT` (Mahsulot nuqsonli), `PRICE_DISPUTE`
    (Narx bo'yicha kelishmovchilik), `OTHER` (Boshqa — izoh MAJBURIY).
    → **Frontendda:** 🔧 `CancelModal.tsx` ga sabab `select`i; **sabab
    tanlanmaguncha "Bekor qilish" tugmasi `disabled`**, `OTHER` da izoh
    bo'sh bo'lsa ham `disabled`; body'ga `reason` qo'shilsin (backend
    sababsiz so'rovni 400 bilan rad etadi).
  - ✏️ **`GET /orders/cancel-reasons/stats`** (superadmin, admin, menejer —
    o'z filiali, market — o'z buyurtmalari; doira tokendan) kontrakti
    to'g'rilandi:
    `?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` — **Toshkent kuni**
    (`endDate` kunining o'zi KIRADI; ilgari UTC yarim tun bilan tushib
    qolardi); `market_id` / `branch_id` (faqat SA/admin); `group_by=market|region|courier`.
    Javob: `{ total, by_reason: [{ reason, label, count }], applied_range: { from, to, timezone }, group_by?, rows?: [{ reason, key, count }] }`.
    `by_reason` da yopiq ro'yxatning HAR sababi (0 bo'lsa ham) o'zbekcha
    `label` bilan; sababi qayd etilmagan eski bekorlar — `UNKNOWN`
    ("Sabab qayd etilmagan"). Sanaladi: haqiqatan bekor qilingan (rollback
    qilib sotilgani yo'q), marketga topshirilgan bekorlar ham
    (`returned_to_market` / `closed`); qaytarish so'rovi bilan marketga
    qaytgan (bekor qilinmagan) buyurtma sanalmaydi. Noto'g'ri sana /
    `startDate > endDate` / noma'lum `group_by` — 400.
    → **Frontendda:** 🆕 hisobotlar bo'limida "Bekor qilish sabablari"
    sahifasi: davr tanlagich (Toshkent kuni), sabablar jadvali/diagrammasi
    (`label`, `count`, ulush = `count / total`), `group_by` bo'yicha
    market/hudud/kuryer kesimi; menejer va market uchun filtrlar
    yashiriladi (backend baribir o'z doirasini qo'llaydi).
- [2026-10-15] 🔧 [integration] — **Ish rejimi paneli: backend tayyor**
  (DOZ6dtJn — qolgan TC'lar faqat UI). `PATCH /integrations/:id`
  `{ webhook_enabled?, reconcile_enabled? }` (ikkalasi sukut `true`);
  `GET /integrations/:id` → `webhook_enabled`, `reconcile_enabled`,
  `last_reconcile_at`; **`POST /integrations/:id/reconcile-now`** (SA/admin)
  → `{ checked, applied, unchanged, unmapped, failed, skipped,
  last_reconcile_at }`; master (`is_active`) o'chiq yoki boshqa solishtiruv
  ishlayotgan bo'lsa **409**, tashuvchi holat so'rovi
  (`status_sync_config.status_query`) sozlanmagan bo'lsa **400** (aniq
  xabar). → **Frontendda:** 🔧 `ConnectionControl.tsx` — BeePost
  `ElchiControlTab` dagidek QATOR-RO'YXAT: har jarayon (Master, Kiruvchi
  webhook, Solishtiruvchi (CRON)) uchun icon + nom + holat tegi
  (Faol/O'chiq) + oqibat izohi + o'ngda Switch; matn: "Master o'chiq bo'lsa
  quyi kalitlar ta'sir qilmaydi — hech qanday jarayon ishlamaydi".
  "Hoziroq tenglashtirish" tugmasi (natija toast'i:
  `checked/applied/failed`) va "Oxirgi solishtiruv: {last_reconcile_at}"
  (bosilgandan keyin yangilanadi). 1920px da qator-ro'yxat, 390px da har
  qator to'liq sig'sin (Switch kesilmasin).
- [2026-10-15] 🟢 [monitoring] — n9o0KYd5: `receive_by_scan_total{outcome="none"}`
  uchun Prometheus alert qoidalari (`libs/common/src/metrics/alerts/`).
  Frontendda o'zgarish yo'q.

### 2026-10-14 — Mahsulotlar katalogi va mijozni telefon bo'yicha qidirish (Guruh E, 4-tur)

- [2026-10-14] ✏️ [catalog] — `GET /product/my-products` va
  `GET /product/market/:marketId` endi `search`, `page`, `limit` query'larini
  qabul qiladi (ilgari e'tiborsiz edi: server sukuti `limit = 10` bilan
  11-mahsulot ko'rinmasdi, qidiruv ishlamasdi). Javob o'zgarmagan:
  `{ data: Product[], total, page, limit }`. `limit` ≤ 500 (kattasi 500 ga
  tushiriladi), noto'g'ri `page`/`limit` — sukut (1 / 10). `GET /product` ham
  shu qoidada (3qDsJpfW).
  Misol: `GET /product/my-products?search=olma&page=2&limit=20`.
  → **Frontendda:** 🔧 `entities/product/index.tsx` —
  `useGetMyProducts(params, enabled)` (params `queryKey` ga ham),
  `pages/products/list/index.tsx:318` da market uchun ham `apiParams`
  uzatilsin (qidiruv inputi va Pagination shundagina ishlaydi);
  `useGetByMarketId(id, enabled, params)` — create sahifasidagi "mavjud
  mahsulotlar" jadvali va `orders/create/ui/Step2Combined.tsx` mahsulot
  tanlovi `limit` (masalan 100) yoki sahifalagich bilan.
- [2026-10-14] ✏️ [catalog] — `market_operator` endi mahsulot katalogida
  (tsEevElW): `POST /product` (mahsulot DOIM operator biriktirilgan
  marketga yoziladi, tanadagi `market_id` e'tiborsiz),
  `GET /product/my-products` (biriktirilgan marketning mahsulotlari),
  `PATCH /product/my/:id` (faqat shu marketning mahsuloti, begonasi — 403),
  `GET /product/:id` (faqat shu marketniki, begonasi — 403). Marketga
  biriktirilmagan operator — 400 `"Operator hech qaysi marketga
  biriktirilmagan — mahsulot katalogi bilan ishlab bo'lmaydi"`.
  `DELETE /product/:id` va umumiy `GET /product` operatorga OCHILMAGAN
  (BeePost'da ham yo'q).
  → **Frontendda:** 🔧 `app/lib/routes.tsx` `canManageProducts` va
  `app/lib/access.ts` `canCreateProducts` ga `market_operator`;
  `pages/products/list/index.tsx:206` `isMarketRole` →
  `role === "market" || role === "market_operator"` (ro'yxat
  `my-products` dan, tahrirlash `PATCH /product/my/:id` bilan, market
  tanlash oynasi operatorga ko'rsatilmaydi); o'chirish tugmasi operatorga
  yashirilsin.
- [2026-10-14] 🟢 [catalog] — o'chirilgan mahsulot nomini qayta ishlatish
  mumkin (As75bkGo, migratsiya 1716000000087): `(name, user_id)` unique
  indeksi endi faqat faol qatorlar uchun. Faol bir xil nomli ikkinchi
  mahsulot — hamon 409 `"Bu marketda bu nomdagi product allaqachon mavjud"`.
  Frontendda o'zgarish shart emas.
- [2026-10-14] 🟢 [catalog] — registrator/menejer `POST /product` (market_id
  bilan) b64f0aa (2026-10-05) dan beri ishlaydi; frontend `canCreateProducts`
  mos (QjkMUMIR). Backend ruxsat matritsasi frontend ro'yxati bilan
  `catalog-gateway.products-e.spec.ts` da solishtiriladi — frontend
  `canManageProducts` o'zgarsa, spec'dagi `FRONTEND_CAN_MANAGE_PRODUCTS` ham
  yangilansin.
- [2026-10-14] 🆕 [customers] — `GET /customers/suggest?phone=...&market_id=...`
  — buyurtma yaratish formasida mijozni telefon bo'yicha taklif qilish
  (hiqRNhkI). Rollar: superadmin, admin, registrator, manager, branch,
  market, market_operator. `phone` — har qanday formatda, kamida 7 raqam
  (aks holda 400). Doira: market — faqat o'z marketida buyurtmasi bo'lgan
  mijozlar (`market_id` e'tiborsiz); market_operator — biriktirilgan
  marketi; registrator/manager/branch — `market_id` MAJBURIY (400), faqat
  shu marketdagi mijozlar; admin/superadmin — hammasi (`market_id` ixtiyoriy,
  faqat xulosa uchun). Ko'pi bilan 10 ta.
  Javob: `{ statusCode: 200, message: "Customer suggestions", data: [{ id,
  name, phone_number, extra_number, address, region_id, district_id,
  orders_count, new_orders_count, has_new_orders, new_order_ids, last_order_at
  }] }` — `orders_count`/`new_orders_count` shu marketda (`created`/`new`
  holatlar "yangi"); market konteksti bo'lmasa `null`.
  → **Frontendda:** 🔧 `entities/customer` hook (debounce 300 ms, ≥ 9 raqam),
  `orders/create/ui/Step2Combined.tsx` telefon maydoni ostida taklif
  ro'yxati (390px da ekrandan chiqmasin); tanlanganda ism, tuman
  (`district_id`; viloyat — tuman ro'yxatidan yoki `region_id`), manzil,
  qo'shimcha raqam to'ldirilsin, "Mavjud mijoz tanlangan" belgisi;
  `has_new_orders` bo'lsa "Diqqat! Bu mijozda yangi holatdagi buyurtma
  mavjud" (`new_order_ids` ga havola). ⚠️ `POST /orders` da `customer_id`
  faqat superadmin/admin dan qabul qilinadi (fix3 RBAC-01) — boshqa rollar
  `customer` obyektini (ayni telefon bilan) yuborishda davom etadi:
  `identity.customer.create` mijozni telefon bo'yicha topadi va o'zgargan
  ism/tuman/manzil/qo'shimcha raqamni YANGILAYDI (j70YS4zJ, allaqachon bor).

### 2026-10-14 — Kassa / smena (Guruh A: kfdfYDik, QTCUUgjA, i75GDixP, 3PE0B03q)

- [2026-10-14] ✏️ [finance] — smena ochish/yopish: odam JWT'dan olinadi (kfdfYDik).
  - `POST /finance/shift/open` — body ixtiyoriy (bo'sh `{}` → 201). `opened_by`
    endi IXTIYORIY va E'TIBORGA OLINMAYDI (JWT `sub` yoziladi). Ixtiyoriy:
    `opening_balance_cash`, `opening_balance_card`, `comment`; qoldiq
    yuborilmasa — MAIN kassaning JONLI qoldig'i yoziladi (ilgari 0).
  - Bitta kassada (MAIN) bir vaqtda faqat BITTA ochiq smena: boshqa odamning
    smenasi ochiq bo'lsa 400 `"Bu kassada allaqachon ochiq smena bor (smena #ID) — avval uni yoping"`.
  - `POST /finance/shift/close` — `closed_by` endi IXTIYORIY va e'tiborsiz
    (JWT). Faqat `{ comment }` bilan ham yopiladi (ilgari 400 `closed_by must match ...`):
    `shift_id`/`opened_by` berilmasa — o'zingizning ochiq smenangiz, u bo'lmasa
    MAIN kassaning ochiq smenasi yopiladi; topilmasa 404 `"Ochiq smena topilmadi"`.
    HTTP status — 201 (POST sukuti).
  - Yopishda sanalgan summalar: `closing_balance_cash`, `closing_balance_card`
    (≥ 0, manfiy → 400). Javob (`data`) va `GET /finance/shift` qatorlarida
    YANGI maydonlar (QTCUUgjA): `expected_balance_cash`, `expected_balance_card`
    (= opening + kirim − chiqim), `discrepancy_cash`, `discrepancy_card`
    (= sanalgan − kutilgan; manfiy — kamomad, musbat — ortiqcha). Sanalgan
    summa yuborilmasa `discrepancy_*` = `null` (ochiq/eski smenalarda ham
    `null`).
  Misol: `POST /finance/shift/close { "comment": "kun yakuni", "closing_balance_cash": 489000, "closing_balance_card": 102500 }`
  → `data: { status: "closed", closed_by: "<siz>", expected_balance_cash: 490000, discrepancy_cash: -1000, discrepancy_card: 0, ... }`.
  → **Frontendda:** 🔧 `mainCashbox.tsx`: "Smenani ochish" tugmasi (body
  `{}` yetarli, `opened_by` yubormasa ham bo'ladi) va "Smena ochiq" banneri;
  `CloseShiftPopup.tsx`: sanalgan naqd/karta inputlari →
  `closing_balance_cash/card`, yopilgandan keyin `discrepancy_*` ni
  (kamomad/ortiqcha) ko'rsating; `null` — "sanalmadi".
- [2026-10-14] 🆕 [finance] — `GET /finance/shift/current`
  (superadmin/admin/registrator) → `data: { shift: Shift | null, required: boolean, cashbox_user_id: "0" }`
  — MAIN kassaning joriy ochiq smenasi va smena darvozasi yoqilganmi.
  → **Frontendda:** 🔧 banner/tugma holatini shundan o'qing (`?status=open&opened_by=`
  o'rniga — smena endi KASSAGA tegishli, boshqa admin ochgan smena ham ko'rinadi).
- [2026-10-14] ⚠️ [finance] — smena darvozasi `FINANCE_REQUIRE_OPEN_SHIFT`
  (QTCUUgjA). SUKUT — O'CHIQ: hozirgi oqimlar o'zgarmaydi. Yoqilganda MAIN
  kassada ochiq smena bo'lmasa quyidagilar 400
  `"Smena ochilmagan! Bu operatsiyani bajarish uchun avval asosiy kassada smenani oching."`:
  `POST /finance/cashbox/payment/courier` (HQ qabul), `POST /finance/cashbox/payment/market`,
  `POST /finance/cashbox/payment/branch-to-main` (menejer topshirig'i ham — pul
  MAIN'ga tushadi), `PATCH /finance/cashbox/spend` va `/fill` (MAIN). Filial
  kassasidagi menejer operatsiyalari (kuryerdan qabul, spend/fill BRANCH) va
  sotuv/bekor qilish darvozalanmaydi.
  → **Frontendda:** 🔧 `GET /finance/shift/current` → `required && !shift`
  bo'lsa Kirim/Chiqim/To'lov tugmalarini bloklang va "Smenani oching" deb
  ko'rsating; 400 xabarini foydalanuvchiga chiqaring. Backend env faqat shu
  UI chiqqandan keyin yoqiladi.
- [2026-10-14] 🟢 [finance] — filial kassasi qo'lda chiqimda manfiyga
  tushmaydi (i75GDixP): `PATCH /finance/cashbox/spend` (menejer, BRANCH)
  balansdan katta bo'lsa 400 `"Insufficient cash balance"`, `type: "click"`
  da — `"Insufficient card balance"`. `PATCH /finance/cashbox/balance`
  (admin) ham filialni manfiyga tushira olmaydi (`source_type: correction`
  bilan ham). `allow_negative` — ichki tizim bayrog'i, gateway DTO'sida YO'Q
  (yuborilsa 400 `property allow_negative should not exist`).
  → **Frontendda:** o'zgarish shart emas; 400 xabarini ko'rsating.
- [2026-10-14] ✏️ [finance] — "O'tkazma manbasi" (3PE0B03q):
  `POST /finance/cashbox/payment/market` va `POST /finance/cashbox/payment/branch-to-main`
  endi ixtiyoriy `source_user_id` (raqamli satr, xodim ID si) qabul qiladi —
  ilgari 400 `property source_user_id should not exist`. Faqat audit: click
  to'lovda tarix qatorlarida `transfer_source_user_id` bo'lib saqlanadi (naqdda
  `null`); `source_user_id` (kontragent = market/filial) o'zgarmaydi. Pul baribir
  kassaning yagona `balance_card` idan yechiladi — shaxs bo'yicha karta qoldig'i
  YO'Q.
  Misol: `{ "market_id": "121", "amount": 1000, "payment_method": "click", "source_user_id": "7" }` → 201.
  → **Frontendda:** 🟢 hozirgi C14 holati (manba yuborilmaydi) to'g'ri ishlaydi.
  Manba tanlovini qaytarsangiz — `source_user_id` yuboring, lekin "Ism — N
  so'm" kabi shaxsiy karta qoldiqlarini ko'rsatmang (backendda yo'q).

### 2026-10-14 — Moliya B (4-tur): CLICK taqsimoti, P&L daftari, filial hisob-kitobi, kargo to'lovlari

- [2026-10-14] ✏️ [finance] — **kuryer va market kassalari (FOR_COURIER /
  FOR_MARKET) endi qarz hisobi**: naqd/karta ajratmasi yuritilmaydi, butun
  qarz `balance_cash` da, `balance_card` doim 0 (1bz6tOle). Ilgari sotuv
  naqdga yozilib, CLICK to'lov kartadan yechilardi va kuryer ilovasida
  `balance_cash: 5 000 000, balance_card: -5 000 000` ("naqd qarzingiz 5 mln",
  aslida qarz yo'q) ko'rinardi. Eski bo'lingan qoldiq kassaning keyingi
  harakatida o'zi yig'iladi (`balance` o'zgarmaydi). MAIN/BRANCH avvalgidek
  usul bo'yicha: `PATCH /finance/cashbox/payment/market` (CLICK) MAIN karta
  qoldig'idan oshsa 400 `Insufficient card balance`. Noma'lum `payment_method`
  → 400. → **Frontendda:** 🔧 kuryer/market kassasida qarz uchun `balance`
  ni ko'rsating (naqd/karta bo'linmasi bu kassalarda ma'nosiz);
  `Insufficient card balance` xabarini "Asosiy kassa kartasida mablag'
  yetarli emas" deb ko'rsating.
- [2026-10-14] ✏️ [finance/api-gateway] — `PATCH /finance/cashbox/spend` va
  `/fill` (admin → MAIN, menejer → BRANCH) endi P&L daftariga
  (`financial_balance_history`) **AYNI tranzaksiyada** yozadi: chiqim −summa
  `manual_expense`, kirim +summa `manual_income`, `dedup_key =
  cashbox-history:<id>` (IgR4FVsR). Javobda yangi kalit
  `data.financial_balance_entry` (`{ id, amount, balance_before,
  balance_after, source_type, ... }`); takroriy (`Idempotency-Key`) so'rov
  daftarga ham qayta yozmaydi. Investor foyda to'lovi va kargo
  remittance'i bu yo'ldan P&L ga yozmaydi (avvalgidek). → **Frontendda:** 🔧
  qo'lda kassa chiqimi/kirimidan keyin `POST /finance/financial-balance/entries`
  ni IKKINCHI marta BOSTIRMANG (endi foydani ikki marta kamaytiradi/oshiradi);
  agar UI'da "daftarga ham yozing" maslahati yoki avtomatik ikkinchi chaqiruv
  bo'lsa — olib tashlang. Kassa operatsiyasidan keyin "Moliyaviy balans"
  so'rovlarini (`financial-balance/history`, `analytics`) invalidatsiya qiling.
- [2026-10-14] ✏️ [api-gateway/finance] — `GET /finance/cashbox/user/:id`
  (admin/superadmin filial kassasini ochganda, `with_history` true ham, false
  ham): `olinishi_kerak` endi HAQIQIY "kuryerlardan olinishi kerak" summasi
  (ilgari xato bilan `berilishi_kerak` qiymati yozilardi — ekranda ikkala
  raqam bir xil edi); yangi `hq_ga_tollangan` (tanlangan davrda HQ'ga
  topshirilgan). Ikkala yo'lda maydonlar to'plami bir xil: `kassadagi_summa,
  berilishi_kerak, olinishi_kerak, hq_ga_tollangan, counterparty`. Menejer
  `GET /finance/cashbox/manager/settlement` va `GET /finance/cashbox/all-info`
  (menejer) javobiga ham `hq_ga_tollangan` qo'shildi (j8qCkJhV). Misol:
  `{ "kassadagi_summa": 900000, "berilishi_kerak": 500000, "olinishi_kerak":
  120000, "hq_ga_tollangan": 70000, "counterparty": "HQ" }`. →
  **Frontendda:** 🟢 `cashDetail.tsx` dagi `amountToReceive` endi to'g'ri
  qiymatni oladi; ixtiyoriy — `hq_ga_tollangan` ni ko'rsatish.
- [2026-10-14] ✏️ [integration/api-gateway] — `POST
  /integrations/:id/remittances` javobi (utIffRFx): `settled_amount`,
  `settled_count`, `unapplied_amount` (= `remitted_amount − settled_amount`)
  endi yozuvda ham saqlanadi; qarzga mos kelmasa yangi `warning` (satr):
  qoldiq > 0 — "To'lovning N so'mi hech bir qarz qatoriga sig'madi ...";
  qoldiq < 0 — aniq `order_ids` to'lovdan ko'p qarzni yopdi. Kassaga
  avvalgidek TO'LIQ summa yoziladi (`cashbox_posted`). → **Frontendda:** 🔧
  `ConnectionSettlement.tsx`: `const res = await createRemittance.mutateAsync(...)`
  — natija oynasida `settled_count / settled_amount / unapplied_amount` va
  `warning` ni ko'rsating; `<InputNumber max={outstanding} />` + "Qarzdan
  ortiq summa" ogohlantirishi va "To'lash" tugmasini bloklash (backend
  bloklamaydi — faqat ogohlantiradi).
- [2026-10-14] 🆕 [integration/api-gateway] — `GET /integrations/:id/remittances`
  (SUPERADMIN, ADMIN) — kargo to'lovlari ro'yxati (DxdZFdIk). Query:
  `status` (`active|cancelled`), `from_date`/`to_date` (yoki `fromDate`/`toDate`,
  `YYYY-MM-DD` — Toshkent kuni), `page`, `limit` (≤100, sukut 20), yangisi
  birinchi. Javob: `data.items[]` = `{ id, integration_id, created_at, amount,
  settled_count, settled_amount, unapplied_amount, reference, note,
  created_by, status, cashbox_posted, cancelled_at, cancelled_by,
  cancel_reason }` + `data.pagination { total, page, limit, totalPages }`.
  Eski (migratsiyadan oldingi) yozuvlarda `settled_amount`,
  `unapplied_amount`, `cashbox_posted` — `null` ("noma'lum", 0 emas). →
  **Frontendda:** 🔧 ConnectionSettlement'ga "Olingan to'lovlar" jadvali
  (sana, summa, yopilgan qatorlar soni, o'tkazma raqami/chek, izoh, kim
  kiritdi, holat); qarz qatorlari jadvaliga `remittance_id` ustuni (qaysi
  to'lov yopgan). To'lov qayd etilgach ro'yxatni invalidatsiya qiling.
- [2026-10-14] 🆕 [integration/api-gateway] — `POST
  /integrations/:id/remittances/:remittance_id/cancel` (SUPERADMIN, ADMIN),
  body `{ reason?: string (≤500), reverse_cashbox?: boolean }`, javob 200
  (DxdZFdIk). O'chirmaydi: `status=cancelled` + kim/qachon/sabab; shu to'lov
  yopgan qarz qatorlari PENDING ga qaytadi ("kargo bizga qarz" shuncha
  ORTADI); to'lov kassaga yozilgan bo'lsa MAIN kassadan teskari chiqim BIR
  MARTA yoziladi. Javob: `{ remittance_id, status: "cancelled", amount,
  cancelled_at, cancelled_by, cancel_reason, reopened_count,
  reopened_order_ids, cashbox_reversed, settlement_reverted }`; takroriy
  bosish — 200 `idempotent: true`. Xatolar: MAIN kassada mablag' yetmasa —
  400 "Kassadan teskari chiqim yozilmadi — to'lov bekor qilinmadi: …" (hech
  narsa o'zgarmaydi); ESKI yozuvda kassaga yozilgani noma'lum bo'lsa — 409
  (operator `reverse_cashbox: true|false` ni aniq yuborishi kerak). →
  **Frontendda:** 🔧 jadvaldagi har qatorga "Bekor qilish" tugmasi +
  tasdiq oynasi: "Bu to'lov bekor qilinadi, kargo qarzi N so'mga ORTADI va
  Asosiy kassadan N so'm chiqim yoziladi"; sabab maydoni; 409 da
  "Kassaga yozilganmi?" tanlovi bilan qayta yuborish; muvaffaqiyatdan keyin
  qarz qatorlari, `receivable-balance` va kassa so'rovlarini invalidatsiya
  qiling.

### 2026-10-14 — Guruh D: yuborish tarixi, shaxsiy Telegram, realtime, shablonlar, segmentlar, OTP kvotasi

- [2026-10-14] 🆕 [notification] — **Yuborilgan xabarlar tarixi** (7Vozou5x),
  SUPERADMIN/ADMIN:
  - `GET /notifications/sent?page&limit&status&type&created_by` →
    `{ items: [{ dispatch_id, status, type, category, priority, title,
    body_preview, channels, recipients, dispatched, skipped_by_preference,
    by_channel, channel_status, no_provider, message, created_by: { id, name,
    role }, created_at, finished_at }], meta }`. `status`:
    `running | sent | partial | inbox_only | skipped | failed`. Faqat qo'lda
    (admin) yuborilganlar; tizim hodisalari (buyurtma holati) bu yerda yo'q.
  - `GET /notifications/sent/:dispatch_id?page&limit` → yuqoridagi + `body`,
    `link`, `audience`, `error`, JONLI `channel_status` (masalan
    `{ in_app: { sent: 2 }, sms: { queued: 1, not_eligible: 1 }, telegram:
    { sent: 3, failed: 1 }, email: { no_provider: 2 } }`) va `undelivered:
    { items: [{ notification_id, recipient_id, name, role, failures: [{
    channel, status, reason }] }], meta }` — telefon raqami YO'Q.
  - `POST /notifications/dispatch` tanasida yangi ixtiyoriy
    `client_request_id` (UUID, har "Yuborish" bosilishiga bitta, qayta
    urinishda O'SHA qiymat) — u `dispatch_id` bo'ladi. Ayni id bilan takror
    → **qayta yuborilmaydi**, javob 200 `{ duplicate: true, status, ... }`.
    Javobda yangi `channel_status` (kanal × holat soni).
  → **Frontendda:** 🔧 (1) natija paneli: har kanal alohida qator — yashil
  `sent`/`queued`/`emitted`, qizil `failed`, SARIQ `skipped`/`no_provider`/
  `not_eligible` ("provayder ulanmagan" / "telefon yo'q") — `skipped` ni
  "yuborildi" DEMANG; (2) 504 bo'lsa: "Noma'lum — tarixdan tekshiring" +
  `/notifications/sent/<client_request_id>` havolasi (`status: running` →
  "jarayonda"); (3) yangi sahifa `/notifications/sent` (jadval: sana,
  sarlavha, kim yubordi, qabul qiluvchilar, kanal chiplari, natija), qator
  ochilganda to'liq matn + kanal kesimi + "Yetkazilmaganlar" (ism + rol +
  sabab); faqat superadmin/admin; 390px da gorizontal scrollsiz.
- [2026-10-14] 🆕 [notification] — **Shaxsiy Telegram** (rCFZAmOz):
  - `POST /notifications/telegram/link` (istalgan tizimga kirgan rol, tana
    yo'q) → `{ token, expires_at, deep_link, command }` — 15 daqiqalik havola
    `https://t.me/<bot>?start=<token>` (`TELEGRAM_BOT_USERNAME` sozlanmagan
    bo'lsa `deep_link: null`, `command: "/start <token>"`). Bot shaxsiy
    chatda `/start <token>` ni oladi va chatni akkauntga ulaydi; `/stop` —
    uzadi. Bot tokeni yo'q → 503.
  - `TELEGRAM` kanali guruh nishonisiz (`telegram.market_id/group_id`
    yo'q) dispatch'da endi **shaxsiy chatga** ketadi (outbox orqali):
    `delivery.telegram`: `queued` → `sent` | `failed` (+`telegram_error`,
    `blocked_by_user: ...`); chat ulanmagan — `skipped` +
    `telegram_reason: 'no_telegram_id'` (dispatch yiqilmaydi). Javobdagi
    `by_channel.telegram` = navbatga qo'yilganlar soni.
  - `POST /notifications/telegram/broadcast` (SUPERADMIN/ADMIN) — `{ title,
    body?, roles? | broadcast? | recipient_ids?, client_request_id? }` →
    dispatch javobi (`by_channel.telegram`, `channel_status.telegram`);
    yakuniy sent/failed — `GET /notifications/sent/:dispatch_id`.
  → **Frontendda:** 🔧 profil sahifasida "Telegram'ni ulash" tugmasi
  (`deep_link` ni yangi oynada ochish, bo'lmasa `command` ni ko'rsatish);
  admin "Xabar yuborish" kanallarida Telegram (shaxsiy) va natijada
  `skipped` = "Telegram ulanmagan".
- [2026-10-14] 🔧 [gateway/realtime] — **Realtime mijozi** (m9BOlEbE).
  Backend yo'li tayyor va spec bilan qulflangan: socket.io namespace
  `/realtime` (gateway hosti), ulanish `io(`${API}/realtime`, { auth: {
  token: <access_token> } })` (yoki `Authorization: Bearer`). Ulanishda
  `connected` `{ user_id, roles }`; token yo'q/soxta → `error` va uziladi.
  Hodisa `notification:new`: aniq qabul qiluvchiga — to'liq inbox qatori
  (`id`, `title`, `body`, `type`, `category`, `priority`, `is_read`,
  `created_at`, `delivery`, ...); rol/broadcast dispatch'da — BITTA signal
  `{ type, category, priority }` (`id` YO'Q).
  → **Frontendda:** 🔧 `socket.io-client` qo'shib `shared/lib/realtime.ts`:
  `notification:new` kelganda `queryKeys.notificationsInbox.all` va
  unread-count ni invalidate (payload'da `id` bo'lsa `setQueryData` bilan
  qo'shish mumkin); access token yangilanganda qayta ulanish; uzilganda
  60 s polling (hozirgi `refetchInterval`) fallback bo'lib qolsin.
- [2026-10-14] 🆕 [notification/identity] — **Shablonlar va uch til**
  (C4R3YyvH):
  - `users.language` (`uz | ru | en`, sukut `uz`, DB CHECK): `PATCH
    /auth/my-profile` va `PATCH /users/:id` tanasida yangi ixtiyoriy
    `language`. Mijoz yaratishda (`identity.customer.create`) ham `language`.
    ⚠️ Xodim uchun bildirishnoma tili hozircha `settings.appearance.language`
    (UI tili) ustun — profilda til tanlansa ikkalasini birga saqlang.
  - `GET /notifications/templates?code&lang` (SUPERADMIN/ADMIN) → `{ items:
    [{ id, code, lang, channel, title, body, required_vars, is_active,
    updated_by, updated_at, source: 'db', encoding, parts, units }], defaults:
    [{ code, lang: 'uz', channel: null, title, body: null, source: 'default',
    encoding, parts }], languages, channels, forbidden_vars }`. `defaults` —
    DB'da `uz` shabloni yo'q katalog turlari (faqat ko'rsatish uchun,
    yuborishda QO'LLANMAYDI).
  - `PUT /notifications/templates` (SUPERADMIN/ADMIN) `{ code (katalog turi),
    lang, channel?: null | realtime|telegram|sms|email|push, title, body?,
    required_vars?, is_active? }` → yaratadi (201) yoki yangilaydi (200).
    `{{var}}` lar `required_vars` ga qo'shiladi; umumiy (`channel: null`) va
    `sms` shablonlarida mijoz ismi/manzili/mahsulotlari (`forbidden_vars`) →
    400 (PII). Javobda `encoding` (`GSM-7` 160 / `UCS-2` 70 belgi) va `parts`.
  - Yuborishda: DB'da shu tur uchun shablon bo'lsa matn qabul qiluvchi
    TILIDA renderlanadi (til → `uz` → xom matn) va inbox qatoriga yoziladi;
    o'zgaruvchi yetishmasa — asl (chaqiruvchi) matni. Dispatch javobida
    `template: { code, applied, fallback_raw, errors, by_lang }`.
  → **Frontendda:** 🔧 profilda til tanlovi (`language`); admin "Shablonlar"
  sahifasi: tur × til jadvali (`defaults` asos matn sifatida), tahrirlashda
  SMS bo'lak hisobi (`parts`, kirill — qimmatroq ogohlantirishi) va 400
  matnini ko'rsatish. Inbox `title`/`body` ni avvalgidek ko'rsating
  (frontend `type`+`data` dan o'z tilida renderlashi — keyingi bosqich,
  `locales/*/notifications.json` kalitlari kerak).
- [2026-10-14] 🆕 [notification] — **Auditoriya konstruktori** (ebSV5oyP),
  hammasi SUPERADMIN/ADMIN. Asosiy endpoint — mavjud `POST
  /notifications/audience/preview` (alohida `/campaigns/audience/preview`
  QURILMAGAN):
  - yangi `with_sample: true` → javobda `sample: [{ id, role, phone:
    '***7434' }]` (≤20; to'liq raqam va ism tarmoq javobida YO'Q);
  - yangi `audience_segment_id` → saqlangan segment sharti bilan jonli son;
  - `segment.max_orders` (buyurtmalar soni "dan–gacha" — `min_orders` bilan);
    teskari oraliq (`min_orders > max_orders` yoki `last_order_from >
    last_order_to`) → 400;
  - 0 ta → 200, `warnings: ['empty_audience']`, `hint` matni (xom 400 emas);
    filtrsiz so'rov → 400 "Auditoriya bo'sh: ...".
  - `GET /notifications/audience/segments` → `{ items: [{ id, name,
    description, audience, last_total, last_counted_at, created_by,
    created_at }] }`; `POST /notifications/audience/segments` `{ name,
    description?, roles? | broadcast? | include_customers? +
    confirm_all_customers? + segment? }` → 201 (faqat SHART saqlanadi; takror
    nom → 409, filtrsiz → 400); `DELETE /notifications/audience/segments/:id`.
  → **Frontendda:** 🔧 `/campaigns/new` sahifasi: segment konstruktori
  (hudud → tuman, market, oxirgi buyurtma oralig'i, buyurtmalar soni
  min–max, auditoriya turi) — har o'zgarishda debounce bilan preview
  ("Auditoriya: N ta"), filtrsiz holatda "filtr tanlang" (so'rov
  yubormang); "Namunani ko'rish" — `with_sample: true`; `dispatch_allowed`/
  `campaign_allowed: false` bo'lsa QIZIL xato va "Yuborish" bloklangan;
  segmentni nom bilan saqlash/tanlash (`audience_segment_id` bilan preview,
  yuborishda `segment.audience` maydonlarini dispatch/kampaniyaga bering);
  390px da bir ustun, filtrlar Collapse ichida.
- [2026-10-14] 🟢 [notification/sms] — OTP (tasdiq kodi) endi **alohida
  kunlik kvota** (`SMS_OTP_DAILY_CAP`, sukut 500) va alohida navbat
  ustuvorligi bilan (rkz0yBxr): reklama/tranzaksion SMS kvotani tugatsa ham
  login kodi ketadi. `GET /notifications/sms/status` javobida yangi
  `otp_used_today`, `otp_daily_cap` (`used_today`/`daily_cap` — endi OTP'siz
  umumiy oqim). → **Frontendda:** 🟢 ixtiyoriy — SMS sozlamalarida OTP
  kvotasini alohida ko'rsatish.

### 2026-10-14 — Faoliyat jurnali: kim, nima, sahifalash, settlement (Guruh C)

- [2026-10-14] ✏️ [gateway] — `GET /activity-logs/actions` (y8CxCtcK) endi
  REYESTRDAN: `data` — avvalgidek fe'l satrlari (`string[]`, endi 16 emas,
  50+ ta: `order.sell`, `finance.manual_expense`, `investor.profit_calculated`
  ...), YANGI `registry` va `categories`:
  ```json
  { "data": ["order.sell", "..."],
    "registry": [{ "action": "finance.manual_expense", "label": "Qo'lda chiqim",
      "category": "finance", "category_label": "Moliya",
      "icon": "minus", "tone": "rose", "known": true }],
    "categories": [{ "key": "order", "label": "Buyurtma" }, { "key": "finance", "label": "Moliya" },
      { "key": "auth", "label": "Kirish" }, { "key": "branch", "label": "Filial" },
      { "key": "integration", "label": "Integratsiya" }, { "key": "logistics", "label": "Logistika" },
      { "key": "notification", "label": "Bildirishnoma" }, { "key": "general", "label": "Umumiy" }] }
  ```
  → **Frontendda:** 🔧 `getActivityActions` `registry`/`categories` ni o'qisin;
  "Amal" filtri — antd `Select` `options` = kategoriya bo'yicha optGroup
  (`categories` tartibida, ichida `registry[].label`, qiymat — `action`).
  Ikona nomlari umumiy so'z (`plus`, `minus`, `wallet`, `login`, `warning`,
  `swap` ...) — o'z ikonka kutubxonangizga moslang; `tone` — BeePost tonlari.
- [2026-10-14] ✏️ [gateway] — `GET /activity-logs` (va `/entity/...`,
  `/user/:id`) har qatorga YANGI maydonlar:
  - `action_meta` — `{ action, label, category, category_label, icon, tone, known }`
    (reyestrda yo'q eski fe'l: humanize yorliq `"Order batch sent"`,
    `icon: "dot"`, `tone: "slate"`, `known: false` — UI sinmaydi);
  - `actor_status` — `snapshot` (qatordagi yozilgan paytdagi ism) /
    `resolved` (identity'dan) / `unresolved` (id bor, ism topilmadi) /
    `system` (aktyorsiz: cron/outbox/webhook);
  - `actor.resolved: boolean`; `actor.name`/`actor.role` — avval QATORDAGI
    (amal paytidagi) qiymat, keyin identity (rol keyin o'zgarsa ham eski qator
    o'zgarmaydi). Superadmin va mijoz amallarida endi ism bor ("1" emas).
  - ⚠️ `actor.phone_number` endi doim `null` (jurnal "Kim" lookup'i telefon
    qaytarmaydi — y8CxCtcK).
  - `cursor_ts` — mikrosekundli vaqt (texnik, ko'rsatish shart emas).
  → **Frontendda:** 🔧 "Amal" ustunida `action_meta.label` + ikona/rang;
  "Kim" ustunida `actor.name` (bo'sh bo'lsa `actor_status === 'unresolved'` →
  "#<id> (topilmadi)", `system` → "Tizim"). Telefonni actor'dan ko'rsatmang.
- [2026-10-14] ✏️ [gateway] — `GET /activity-logs` sahifalash ANIQ (8eYmt4NV):
  har `page <= totalPages` qatorli (avval 90-sahifadan keyin bo'sh edi),
  `meta.total` = haqiqatan o'qiladigan qatorlar. YANGI `meta` maydonlari:
  - `next_cursor` (satr | null) — keyingi sahifa kursori;
  - `truncated: true`, `total_all`, `hint` — bir nechta servis bo'ylab
    10 000 qatordan chuqur (bunda `total`/`totalPages` 10 000 bilan
    cheklangan; `?service=` yoki sana oralig'i bilan cheklov yo'q);
  - `failed_services: string[]` — javob bermagan servislar (bo'lmasa kalit yo'q);
  - YANGI query `?cursor=<meta.next_cursor>` — istalgan chuqurlikda keyingi
    sahifa (`page` e'tiborsiz, javobda `meta.page: null`); buzilgan kursor → 400.
  → **Frontendda:** 🔧 `meta.truncated` bo'lsa jadval ustida `meta.hint` ni
  ogohlantirish sifatida ko'rsating; `failed_services` bo'lsa "ba'zi
  servislar javob bermadi" belgisi. Ixtiyoriy: "Yana yuklash" uchun
  `next_cursor`.
- [2026-10-14] 🆕 [order] — naqd hisob-kitob jurnalga yoziladi (jtB0i4y3):
  `entity_type=Settlement`, `entity_id` — kuryer/filial/market id,
  `action=created`, `metadata: { leg: 'courier_to_branch'|'branch_to_hq'|'hq_to_market',
  kind: 'advance'|'close_zero', amount, allocated, leftover, settled_count,
  settled_order_ids, request_id }`, `description`:
  "Hisob-kitob (kuryer → filial) #263: 150 000 so'm, 2 ta buyurtma yopildi".
  Filtr: `GET /activity-logs?entity_type=Settlement`.
  → **Frontendda:** 🔧 jurnal "Obyekt turi" filtriga `Settlement`
  ("Hisob-kitob") qo'shing; tafsilotda `metadata.leg`/`amount` ni ko'rsating.
- [2026-10-14] 🟢 [identity] — access token'da YANGI `name` claim (aktyor
  ismi jurnalga avtomatik yozilishi uchun). Mavjud maydonlar o'zgarmagan.
- [2026-10-14] 🟢 [identity] — takroriy login (AYNI qurilma/IP, 10 daqiqa
  ichida) yangi jurnal qatori yaratmaydi: mavjud `login` qatorida
  `metadata.count` oshadi, `metadata.last_at` yangilanadi (i6Nyedea).
  → **Frontendda:** ixtiyoriy — `metadata.count > 1` bo'lsa "×N" belgisi.
- [2026-10-14] 🟢 [all] — jurnal saqlash muddati (i6Nyedea): o'chirish
  `ACTIVITY_LOG_PRUNE_ENABLED` bayrog'i ortida, SUKUT BO'YICHA O'CHIQ
  (faqat dry-run sanash). Yoqilganda: login/logout/auth_failure + OTP — 90 kun,
  qolgan hamma fe'l (moliya, buyurtma, investor, settlement) — 1095 kun.
  API kontrakti o'zgarmaydi. → **Frontendda:** o'zgarish shart emas.

### 2026-10-14 — Investor dashboard API (vpKijXce)

- [2026-10-14] 🆕 [investor] — investorning O'ZI uchun marshrutlar
  (`@Roles(investor)`; doira faqat JWT `sub` → `investors.user_id`; query'dagi
  `investor_id` e'tiborsiz qoldiriladi va servisga yuborilmaydi):
  - `GET /investors/me` → `{ investor, summary }`.
    `investor`: `id, name, phone_number, status, created_at` (admin izohi
    `description`, `user_id` YO'Q).
    `summary`: `total_invested`, `investments_count`, `first_invested_at`,
    `last_invested_at`, `total_paid_profit`, `total_unpaid_profit`,
    `total_profit`, `profit_shares_count`, `current_percentage` (oxirgi foyda
    davrining foiz stavkasi, yozuv bo'lmasa `null`), `last_paid_at`.
  - `GET /investors/me/dashboard?months=12` (1..36, default 12) →
    `{ investor, summary, monthly: { months, items: [{ month: 'YYYY-MM',
    paid_amount, unpaid_amount, total_amount }] } }` — oy Toshkent bo'yicha,
    foyda davrining oxiri (`period_end`) ga ko'ra; bo'sh oylar 0 bilan.
  - `GET /investors/me/investments?page&limit&from_date&to_date` →
    `{ items: [{ id, amount, invested_at, branch_id, created_at }], meta,
    summary: { total_amount } }`.
  - `GET /investors/me/profits?page&limit&is_paid` → `{ items: [{ id, amount,
    percentage, period_start, period_end, is_paid, paid_at, created_at }],
    meta, summary: { total_paid_amount, total_unpaid_amount } }`.
  - Xatolar: login investorga bog'lanmagan → 404; bitta loginga 2+ investor →
    409; investor nofaol → 403; rol/sub yo'q → 403. Hech birida kompaniya
    ma'lumoti qaytmaydi (fail-closed).
  → **Frontendda:** 🔧 kartadagi 4–8-bandlar: `src/pages/investor-dashboard/`
  ("Mening investitsiyam" = `summary.total_invested`, "Ulush foizi" =
  `summary.current_percentage`, "To'langan foyda" = `summary.total_paid_profit`,
  "Kutilayotgan foyda" = `summary.total_unpaid_profit`; foyda tarixi jadvali —
  `/investors/me/profits`; oylik grafik — `/investors/me/dashboard`
  `monthly.items`). `DashboardEntry` da `role === "investor"` →
  `<Navigate replace to="/investor" />`; `/investor` marshruti
  investor/superadmin uchun; investor sidebar'ida operatsion menyular yo'q.
  404/409/403 da bo'sh holat + "administratorga murojaat qiling" ko'rsating —
  kompaniya dashboardiga QAYTARMANG.
- [2026-10-14] 🆕 [investor] — `GET /investors/:investor_id/dashboard?months=`
  (superadmin/admin) — investor ko'radigan AYNAN shu `{ investor, summary,
  monthly }` javobi (TC7 nazorat).
  → **Frontendda:** 🔧 superadmin `/investor` sahifasini ochganda investor
  tanlab shu endpointdan foydalaning (tarix uchun mavjud
  `/investors/:investor_id/investments` va `/investors/:investor_id/profits`).
- [2026-10-14] ✏️ [investor] — `POST /investors` va `PATCH /investors/:id`
  endi `user_id` qabul qiladi (investor login qiladigan `users.id`; satr yoki
  raqam, musbat butun son). `PATCH` da `user_id: null` — bog'lanishni uzadi.
  Bitta login ikkinchi investorga bog'lansa 400. Ilgari bu maydon gateway'da
  yo'q edi (400 `property user_id should not exist`) — natijada hech bir
  investor login bilan bog'lanmagan.
  → **Frontendda:** 🔧 investors-ops formasiga "Login (foydalanuvchi)"
  tanlovini qo'shing va `user_id` yuboring.
- [2026-10-14] 🟢 [investor] — `GET /analytics/dashboard` investorga allaqachon
  403 (DASHBOARD_ROLES, ukulko6O/EgizXSKW) — o'zgarish yo'q.

### 2026-10-14 — Moliya/kassa kartalari (Codex ishini tekshirish)

- [2026-10-14] ✏️ [branch] — `DELETE /branches/:id` endi filialning PULINI
  ham tekshiradi (T4eu8kxu): HQ'ga qarzi bo'lsa (sotilgan, lekin
  topshirilmagan savdo) 400 "… filialning HQ'ga N so'm qarzi bor …";
  BRANCH kassasida qoldiq bo'lsa (musbat/manfiy, naqd yoki karta) 400
  "… filial kassasida qoldiq bor …"; moliya/buyurtmalar xizmati javob
  bermasa 503 (o'chirish bo'lmaydi). → **Frontendda:** 🔧 o'chirish
  tasdig'idan keyin 400/503 javobidagi `message` ni to'liq ko'rsating
  (umumiy "Xatolik" emas); 503 da "qayta urinib ko'ring".
- [2026-10-14] 🟢 [api-gateway/finance] — `/finance/cashbox/payment/courier|market|branch-to-main`
  DTO'lari `amount` = 0, bo'sh, `null` (FE'dagi `Number('100 000')` → NaN →
  JSON `null`) va manfiyni 400 bilan rad etadi — regressiya spec qo'shildi
  (qGaxcaD4). → **Frontendda:** 🔧 summa `InputNumber` (probel-ajratgich
  parser) yoki yuborishdan oldin `amount > 0` tekshiruvi; xatoda backend
  `message`; har uch oyoqqa tasdiq.

- [2026-10-14] ✏️ [api-gateway/finance] — qo'lda kuryer/market/filial→HQ
  to'lovi va `PATCH /finance/cashbox/spend|fill`: `Idempotency-Key`
  bo'lmasa har HTTP so'rov ALOHIDA to'lov (soatga bog'liq emas — eski 30 s
  oynasi butunlay yo'q). Kalit bo'lsa — ayni kalitli takroriy so'rov 200 va
  `data.idempotent: true` (kassa kirim/chiqimida xabar "... allaqachon
  bajarilgan (takroriy so'rov)"). 255 belgidan uzun kalit — 400 (TMgL1zvq).
  → **Frontendda:** 🔧 kuryer/market/filial to'lovlarida kalit allaqachon bor
  (`paymentIdempotency.ts`). `cashboxSpend`/`cashboxFill` (`entities/payments/index.ts`)
  hali kalitsiz — har submit uchun `crypto.randomUUID()` yaratib, retry'da
  ayni kalitni yuboring; `data.idempotent: true` bo'lsa "avval qabul
  qilingan" deb ko'rsating (ikkinchi muvaffaqiyat toast'i emas).
- [2026-10-14] 🆕 [api-gateway/finance] — `POST /finance/operator-payments`
  ixtiyoriy `Idempotency-Key` sarlavhasini qabul qiladi: ayni kalitli
  takroriy so'rov pulni qayta yechmaydi, 200 va `data.idempotent: true`
  qaytaradi. To'lov qarzdan (`earned - paid`) oshsa 400 "To'lov miqdori
  operatorga qarzdan oshib ketdi"; MAIN kassada naqd yetmasa 400
  "Insufficient cash balance" — ikkala holatda HECH NARSA yozilmaydi
  (to'lov qatori, kassa chiqimi va P&L yozuvi bitta tranzaksiyada)
  (FJVqcUTv). → **Frontendda:** 🔧 `finance-operators` formasida `comment`
  o'rniga `note` (2DCQKd37), har submit uchun `Idempotency-Key`, 400
  javobidagi `message` ni ko'rsating.
- [2026-10-14] ✏️ [api-gateway/finance] — `POST /finance/financial-balance/entries`:
  takroriy `Idempotency-Key` endi HTTP **200** (ilgari HTTP 201, body 200) va
  `data.idempotent: true` bilan mavjud yozuvni qaytaradi; yangi yozuv — 201,
  nol summa — 200 `skipped`. Kalit aktor bo'yicha nom fazosida saqlanadi
  (cSNJN7GP). → **Frontendda:** `FinancialEntryModal` 200 ni ham muvaffaqiyat
  deb qabul qilsin; `idempotent: true` da "yozuv avval saqlangan" deb ko'rsating.
- [2026-10-14] 🔧 [finance] — `GET /finance/financial-balance` market qatori
  (`markets.allMarketCashboxes[].balance`) — kassaning IMZOLI balansi
  (musbat = marketga qarzmiz), Σ balance = `markets.marketPayable`, karta
  "jami"si esa `marketsTotalBalans = −marketPayable` (IaMK2tf2, 2026-10-12
  yozuviga aniqlik). → **Frontendda:** 🔧 `lib/financialBalance.ts:134`
  `-Math.abs(rawBalance)` ni `-rawBalance` ga almashtiring (xom `balance`
  EMAS — aks holda qatorlar yig'indisi "jami" ga teskari ishorali bo'ladi);
  shunda market bizga qarzdor bo'lsa musbat ko'rinadi va Σ qatorlar = jami.
  Sanoq — `nonZeroCount`, `truncated: true` bo'lsa "top-500" yozuvi.
- [2026-10-14] 🟢 [finance] — `financial-balance/history` `source_type`
  tekshiruvi finance-service ichida ham (RMQ chaqiruvchilari 500 emas 400
  oladi) (b1QxU3qa); `financial-balance/top-impacts` da son bo'lmagan
  `page`/`limit` sukut qiymatiga tushadi (vmLTsAok). Frontendda o'zgarish shart emas.

### 2026-10-14 — Guruh F (buyurtma va pochta) tekshiruvi

- [2026-10-14] ✏️ [order] — `GET /orders` (va `order.find_all_enriched` /
  `findByIdEnriched` ishlatadigan barcha boyitilgan javoblar) har buyurtmada
  `courier: { id, name, phone_number } | null` qaytaradi (xWsCAA5N). Manba:
  `courier_id`, u bo'sh bo'lsa (bekor qilish oqimi) — buyurtma pochtasining
  kuryeri; filial/hudud pochtasi (`courier_id = 0`) — `null`. Maosh, tarif,
  login chiqmaydi. `fetch_all=true` — bitta so'rovda eng ko'pi 5000 qator,
  `total` esa haqiqiy jami (`total_pages > 1` yoki `total > data.length` —
  ro'yxat kesilgan).
  → **Frontendda:** 🔧 `exportOrdersToExcel.ts` `getCourierName` endi
  `order.courier.name` ni oladi (o'zgarish shart emas). `orders/index.tsx`
  dagi 100 talik sahifalash siklini bitta `fetch_all=true` so'rovga
  almashtiring; `total > data.length` bo'lsa "eksport to'liq emas — filtrni
  toraytiring" ogohlantirishini ko'rsating (jimgina kesmang). Haqiqiy
  `.xlsx` (`xlsx-js-style`/`exceljs`) va "Umumiy" yig'indi qatori —
  frontend ishi. `printLabelPdf.ts` yorlig'ida kuryer ismi/telefoni endi
  to'ladi.

- [2026-10-14] ✏️ [order] — `PATCH /orders/:id` va `/orders/:id/full`
  dagi `items[]` endi `product_name` ni saqlaydi (tashqi, katalogsiz
  satr: `{ product_id: null, product_name, quantity }`). Satrlar buyurtma
  bilan bitta tranzaksiyada almashtiriladi. 400 holatlari (hech narsa
  o'chirilmaydi): `items: []`; satrda `product_id` ham, bo'sh bo'lmagan
  `product_name` ham yo'q; `product_id` raqam emas; `quantity` butun son
  emas yoki < 1 (52NJNGaH). Hamkor API (`order.update_full`) yuboradigan
  nomlar ham endi yo'qolmaydi; hamkor `items: []` yuborsa ham 400.
  → **Frontendda:** 🔧 `newOrderUpdateRules.ts` `normalizeItems` satrni
  `product_id ?? 'name:' + product_name` bo'yicha kalitlasin va
  `product_id` yo'q satrni tashlab yubormasin; payloadda tashqi satr
  `{ product_name, quantity }` (yoki `product_id: null` bilan) ketsin.
  `new_orderUpdate.tsx` da mahsulot ro'yxati o'zgargan-u payload bo'sh
  bo'lsa jimgina yopmasdan ogohlantirish chiqsin; barcha mahsulot
  o'chirilsa backend 400 qaytaradi — `message` ni ko'rsating.

- [2026-10-14] ✏️ [api-gateway/logistics] — `GET /post/orders/:id`,
  `/post/orders/rejected/:id` va `GET /post/return-requests/list` ichidagi
  boyitilgan obyektlarning oq ro'yxati aniqlashtirildi (VfgcnxDa). 12-oktabr
  versiyasi pochta detali ishlatadigan maxfiy bo'lmagan maydonlarni ham
  kesib qo'ygan edi — qaytarildi:
  `market` = `id/name/phone_number`;
  `customer` = `id/name/phone_number/extra_number/address/district_id/region_id`;
  `district` = `id/name/sato_code/region_id/assigned_region/region/assignedToRegion`
  (`region`/`assignedToRegion` ichida `id/name/sato_code`).
  `market_tg_token`, `username`, `salary`, `tariff_*`, `commission_*`,
  `settings`, `password`, `refresh_token` hech qachon chiqmaydi.
  → **Frontendda:** 🔧 `PostOrder.market/customer/district` tiplarini shu
  ro'yxatga toraytiring (`Market` tipidagi `username/salary/tariff_home`
  pochta detalida endi yo'q); `printMode.ts` (`extra_number`) va
  `dispatchRegion.ts` (`assigned_region`) avvalgidek ishlaydi.

### 2026-10-14 — SMS kartalari qayta tekshiruvi (3fRbyadQ, 8auPBa1O, sVByLMnt)

- [2026-10-14] ✏️ [notification/sms] — `GET /notifications/sms/report` javobiga
  qo'shimcha maydonlar: `months` (`[{ month: 'YYYY-MM', total, delivered, failed,
  parts, cost, untariffed }]`) va `by_class` (`[{ message_class, ... }]`); `days`
  va `totals` o'zgarmagan. `from`/`to` faqat sana (`YYYY-MM-DD`) bo'lsa endi
  Toshkent kuni sifatida o'qiladi (`to` kuni ham KIRADI); zona bilan ISO
  (`...T00:00:00+05:00`) avvalgidek. `days[].day` endi server vaqt zonasidan
  qat'i nazar to'g'ri Toshkent sanasi (8auPBa1O). → **Frontendda:** 🔧
  `SmsReportTab` da oylik yig'indi va sinf kesimini ko'rsatish (ixtiyoriy);
  hozirgi `+05:00` bilan yuborish ishlayveradi.
- [2026-10-14] 🟢 [notification] — yangi bildirishnoma turi `sms.balance_low`
  (CRITICAL, `system`, o'chirib bo'lmaydi): SMS provayder balansi
  `SMS_BALANCE_ALERT_THRESHOLD` dan tushsa adminlar inboxiga, Toshkent kuniga
  bir marta (`data: { day, provider, balance, threshold }`). Avval tur katalogda
  yo'qligi sabab dispatch 400 bilan yiqilib, ogohlantirish umuman kelmasdi.
  → **Frontendda:** `GET /notifications/types` dan yorliq avtomatik keladi;
  maxsus ikonka kerak bo'lsa — `sms.` prefiksi.
- [2026-10-14] 🟢 [notification/sms] — reklama SMS tungi taqiqi
  (`NOTIF_PROMO_QUIET_HOURS`, Toshkent) endi YUBORISH paytida ham tekshiriladi:
  navbatda turgan reklama taqiq oynasida ketmaydi, oyna tugashiga suriladi
  (sVByLMnt). Kampaniya tarixidagi `pending` shunday qatorlarni ham o'z ichiga
  oladi. → Frontendda o'zgarish shart emas.

### 2026-10-14 — Guruh E: analitika / dashboard

- [2026-10-14] ⚠️ [analytics] — `GET /analytics/dashboard?all=true` ("Barchasi")
  endi HAQIQIY butun davr EMAS: 12-oktabrdagi yozuvdagi `clamped: false`,
  `effective_from` = 1970 BEKOR. Oyna eng so'nggi **366 kun** (Toshkent kuni
  boshidan) bilan cheklanadi (audit C3; chegarasiz oyna tarix o'sgani sari
  2,5 s byudjetdan chiqib 503 berardi). Javob yuqori darajasida (admin, market
  va kuryer dashboardi): `clamped: true`, `effective_from`, `effective_to`
  (ISO, qo'llangan oyna), `max_span_days: 366`; `message` —
  `"Dashboard infos (oxirgi 366 kun)"`. Market/kuryer dashboardida `myStat`
  ichida ham `applied_range` bor. Oddiy sana oralig'ida bu maydonlar yo'q
  (uN1tjjGu).
  → **Frontendda:** 🔧 "Barchasi" yozuvi ostida `clamped` bo'lsa
  "Oxirgi 366 kun: {effective_from} – {effective_to}" ni ko'rsating
  (Toshkent sanasi, `DD.MM.YYYY`); "butun davr" deb yozmang.
- [2026-10-14] ✏️ [analytics] — reyting meta'lari (`topMarketsMeta`,
  `topBranchesMeta`, `marketRatingMeta`, `rankingMeta`, kuryer dashboardida
  `topCouriersMeta`) endi `min_orders`, `filtered_out` dan tashqari reyting
  HISOBLANGAN davrni ham beradi: `from`, `to` (ISO, Toshkent kuni
  chegaralari). Teng ulushda ko'proq buyurtmali qator oldinda (PQt3n1N0,
  9zbSDkUI).
  → **Frontendda:** 🔧 "Top marketlar / filiallar / kuryerlar" kartasi
  sarlavhasida davrni meta'dan yozing (masalan "01.09 – 18.09"); bo'sh
  bo'lsa "kamida 30 buyurtma kerak" EMAS — `filtered_out > 0` bo'lsa
  "{filtered_out} ta {min_orders} tadan kam buyurtmali", aks holda "Bu davrda
  buyurtma yo'q". Bo'sh kartaga `compact` uzating (`DashboardPage.tsx`
  `<TopPerformers … compact />`, ≤120–170px) — 9zbSDkUI TC4/TC6.
- [2026-10-14] ⚠️ [analytics] — `GET /analytics/dashboard`: filial xodimining
  filiali (JWT'da `branch_id` yo'q va branch-service javob bermadi) yoki
  market operatorining marketi (identity javob bermadi) aniqlanmasa endi
  **503** (ilgari 200 + kompaniya bo'yicha raqamlar / soxta nollar). Filial
  dashboard'i (`branchDashboard`) tushsa `failed_parts: ['branchDashboard']`.
  Filial dashboard'i endi order bo'laklari bilan parallel olinadi — filial
  roli uchun javob vaqti ~2 baravar qisqardi (VkwhHqvW).
  → **Frontendda:** 🔧 503 da "Ma'lumot olinmadi, qayta urinib ko'ring"
  holatini ko'rsating (0 lar emas); `failed_parts` dagi bo'limni "olinmadi"
  deb belgilang.
- [2026-10-14] ✏️ [analytics] — kuryer roli uchun `GET /analytics/dashboard`
  da `topCouriers` endi to'ldiriladi (ilgari doim `[]`): tanlangan davr
  bo'yicha top-10, har qator faqat `courier_id`, `courier_name`,
  `total_orders`, `successful_orders`, `success_rate` (pul maydonlari yo'q).
  Yangi: `topCouriersMeta` (`min_orders`, `filtered_out`, `from`, `to`),
  `myRank` (so'rovchining to'liq reytingdagi o'rni, yo'q bo'lsa `null`),
  `myRanking` (o'z qatori). Reyting olinmasa —
  `failed_parts: ['topCouriers']` (5tUEVG1B).
  → **Frontendda:** 🔧 kuryer dashboardida reyting kartasi; o'z qatorini
  `courier_id === user.id` (yoki `myRank`) bo'yicha ajrating, top-10 dan
  tashqarida bo'lsa pastida "Siz: {myRank}-o'rin" qatorini (`myRanking`)
  ko'rsating.
- [2026-10-14] 🔧 [analytics] — `GET /analytics/revenue` kontrakti
  (2026-10-08, faAfgvW1) qayta tekshirildi: `data[]` (`period`, `label`,
  `ordersCount`, `revenue`), `summary {totalRevenue, totalOrders,
  avgRevenue}`, `chart {labels, values}` to'ldirilgan, raqamli kalitlar yo'q
  (2Fj7iw1k). Backend o'zgarishi yo'q.
  → **Frontendda:** 🔧 `FinancialAnalysis.tsx`: `rawRevenuePoints` zaxira
  yo'lini olib tashlab `data` dan o'qing; chartData ga
  `orders: ordersCount` va `avgOrderValue = revenue / ordersCount` qo'shing;
  "Aralash" (Combo) — ikki o'q: `Bar dataKey="orders"` (o'ng o'q),
  `Line dataKey="revenue"` (chap o'q); tooltip'da daromad + buyurtma soni +
  o'rtacha qiymat; grafik tepasida davr yakuni chipi:
  "Jami: {summary.totalRevenue} so'm · {summary.totalOrders} ta · o'rtacha
  {totalRevenue/totalOrders} so'm". `RevenueResponse` tipiga `summary?`.
- [2026-10-14] 🟢 [analytics] — `GET /analytics/kpi`: `averageFulfillmentHours`
  va `onTimeRate` endi order-service'da bitta SQL agregatidan
  (`order.analytics.fulfillment_stats`) — qiymatlar o'sha formula, javob
  shakli o'zgarmagan; KPI endi bitta parallel bosqichda (≤ 5 RMQ chaqiruv)
  qaytadi. Bu bo'lak olinmasa `failed_parts: ['fulfillment']` (ilgari butun
  KPI 503) (mKS1mjNr).
  → **Frontendda:** o'zgarish shart emas; `failed_parts` da `fulfillment`
  bo'lsa yetkazish vaqti/SLA ni "olinmadi" deb ko'rsating.

### 2026-10-14 — Bildirishnoma auditoriyasi va kampaniya navbati (W8aerwL6, xHPdpj0W)

- [2026-10-14] ✏️ [notification] — `POST /notifications/dispatch` endi
  mijoz va superadminni ham nishonlaydi (W8aerwL6). Yangi ixtiyoriy
  maydonlar: `include_customers: boolean`, `confirm_all_customers: boolean`,
  `segment: { region_id?, district_id?, market_id?, last_order_from?,
  last_order_to?, min_orders? }` (segment — mijozning BUYURTMALARI bo'yicha,
  faqat mijozlarga qo'llanadi). Qoidalar: `roles:['customer']` bayroqsiz →
  400 (matn nima qilishni aytadi); `include_customers: true` segmentsiz va
  `confirm_all_customers: true` siz → 400; segment mijozsiz → 400.
  `roles:['superadmin']` endi ishlaydi; `broadcast: true` — barcha xodimlar
  (superadmin ham), mijozlar faqat `include_customers` bilan. Sinxron
  dispatch chegarasi 5000 (oshsa 400, jimgina kesilmaydi).
  → **Frontendda:** 🔧 "Xabar yuborish" formasiga "Mijozlar" bo'limi:
  `include_customers` + segment filtrlari (hudud/tuman/market/oxirgi buyurtma
  oralig'i/min buyurtmalar), segmentsiz "Barcha mijozlar" tanlansa alohida
  tasdiq (checkbox) → `confirm_all_customers: true`. 400 matnini foydalanuvchiga
  ko'rsating.
- [2026-10-14] 🆕 [notification] — `POST /notifications/audience/preview`
  (SUPERADMIN/ADMIN; hech narsa yubormaydi). Body — dispatch'dagi nishon
  maydonlari (`recipient_id(s)`, `roles`, `broadcast`, `include_customers`,
  `confirm_all_customers`, `segment`). Javob `data`: `{ exact, total,
  by_role: {rol: son}, by_channel: { in_app, realtime, push, sms, email: 0,
  telegram: null }, explicit, not_found, limits: { dispatch_max: 5000,
  campaign_max }, dispatch_allowed, campaign_allowed, warnings: [...] }`.
  Telefon/ism QAYTMAYDI. `warnings`: `includes_customers`, `all_customers`,
  `recipients_not_found`, `over_dispatch_cap_use_campaign`, `over_campaign_cap`.
  → **Frontendda:** 🔧 yuborishdan OLDIN tasdiqlash oynasi (BeePost
  send-message namunasi): matn, "N ta qabul qiluvchi", rollar kesimi, kanal
  bo'yicha yaroqlilar; `dispatch_allowed: false` bo'lsa kampaniya orqali
  yuborishni taklif qiling.
- [2026-10-14] 🆕 [notification] — Kampaniya navbati (xHPdpj0W), hammasi
  SUPERADMIN/ADMIN:
  - `POST /notifications/campaigns` → **HTTP 202** `{ campaign_id, status:
    'queued', total, scheduled_at, duplicate }`. **`Idempotency-Key` sarlavhasi
    majburiy** (yoki body `idempotency_key`): ayni kalit bilan takror → o'sha
    kampaniya (`duplicate: true`, yangi yaratilmaydi); ayni kalit + boshqa
    mazmun → 409. Body: `type` (katalog), `title`, `body?`, `data?`, `link?`,
    `category?`, `priority?`, `channels?` (faqat `in_app|realtime|push`;
    `sms/telegram/email` → 400), nishon (dispatch bilan bir xil yoki
    `recipient_ids` — boshqa nishon bilan birga emas), `scheduled_at?` (ISO,
    ≤90 kun). Chegara 20 000 (env `NOTIFICATION_CAMPAIGN_MAX_FANOUT`), oshsa 400.
  - `GET /notifications/campaigns?page&limit&status` — tarix (yangilari
    birinchi), `meta` bilan.
  - `GET /notifications/campaigns/:id` — progress: `status`
    (`queued|running|done|failed|cancelled`), `total/sent/failed/skipped`,
    `progress_pct`, `batches_done`, `created_by`, `audience`, `scheduled_at`,
    `started_at`, `finished_at`, `last_error`.
  - `POST /notifications/campaigns/:id/cancel` → 200; yakunlangan — 409.
  → **Frontendda:** 🔧 katta yuborish (5000+ yoki ommaviy e'lon) uchun
  `/notifications/dispatch` o'rniga kampaniya: har "Yuborish" bosilishi uchun
  bitta UUID (qayta urinishda o'sha kalit), 202 dan keyin
  `GET /campaigns/:id` ni 2–3 s da poll qilib progress-bar; tarix sahifasi
  va "Bekor qilish" tugmasi. Progress real vaqtda emas — partiya (200 ta)
  qadamlari bilan yangilanadi.

### 2026-10-14 — Bildirishnoma: push, sozlamalar, kanal tanlash, eskalatsiya (Guruh C)

- [2026-10-14] 🟢 [notification] — Web Push (kf0uVbyg): `GET /notifications/push/public-key`
  → `{ enabled, public_key }` (faqat PUBLIC kalit), `POST /notifications/push/subscribe`
  (endpoint bo'yicha idempotent — qayta chaqirish yangi qator yaratmaydi), `DELETE
  /notifications/push/subscribe` (faqat o'z obunasi; begona/yo'q endpoint — 404). Prod'da
  VAPID kalitlari hozircha yo'q → `enabled:false`, subscribe 503.
  → **Frontendda:** 🔧 `enabled:false` bo'lsa `PushManager.subscribe` CHAQIRILMASIN (503);
  logout'dan OLDIN `DELETE /notifications/push/subscribe`.
- [2026-10-14] ✏️ [notification] — `POST /notifications/dispatch`: `recipient_ids` har elementi
  faqat musbat butun son (bigint) — aks holda 400 va hech narsa yozilmaydi (BoMa1A1R). 500
  javoblarida endi xom DB matni yo'q — faqat `Internal server error`.
  → **Frontendda:** 🟢 o'zgarish shart emas (forma raqamli id yuboradi).
- [2026-10-14] ⚠️ [notification] — kanal tanlash (7Ec56EIw): dispatch `channels` bersa katalogdagi
  `allowed_channels` bilan KESISHMA olinadi. `GET /notifications/types` har turida yangi
  `allowed_channels` maydoni. `*.manual` (admin "Xabar yuborish") va `x.` turlarda — barcha kanal
  (o'zgarish yo'q); katalog turlarida (masalan `order.sold`) faqat ruxsat etilgan kanallar.
  → **Frontendda:** 🟢 admin forma `*.manual` yuboradi — ta'sir yo'q; kanal tanlovi UI'da
  `allowed_channels` dan foydalanish mumkin.
- [2026-10-14] ✏️ [notification] — dispatch javobida yangi `skipped_by_preference` (son).
  Hamma qabul qiluvchi sozlama bilan filtrlansa — 400 EMAS, `dispatched: 0`,
  `skipped_by_preference: N`, xabar `Skipped by recipient preferences — nothing dispatched`.
  ⚠️ `marketing` kategoriyasi (shu jumladan `marketing.manual`) — yozuv yo'q foydalanuvchiga
  ketmaydi (default O'CHIQ, rozilik `scope: marketing, enabled: true` bilan).
  → **Frontendda:** 🔧 "Xabar yuborish" natijasida `skipped_by_preference` ni ko'rsating
  (`dispatched: 0` muvaffaqiyatsizlik emas).
- [2026-10-14] 🆕 [notification] — foydalanuvchi sozlamalari (mP1WGG1W): RMQ
  `notification.preferences.get` / `notification.preferences.update`. Gateway marshrutlari
  `GET /notifications/preferences` va `PATCH /notifications/preferences` (`user_id` faqat
  JWT'dan, rol talab qilinmaydi) — gateway kartasida (hali deploy qilinmagan).
  GET javobi: `{ items: [{ scope, channel, enabled, updated_at }], channels: ['all','in_app',
  'realtime','push','sms','email'], defaults: { marketing: false, other: true }, locked_types }`.
  PATCH tanasi: `{ items: [{ scope: 'order' | 'order.sold' | …, channel, enabled: true|false|null }] }`
  (`null` — sukutga qaytarish). Critical (`locked_types`) turni o'chirish — 400. `in_app`
  (yoki `all`) o'chirilsa — tur butunlay o'chadi.
  → **Frontendda:** 🔧 sozlamalar sahifasida kategoriya × kanal jadvali; `locked_types` disabled.
- [2026-10-14] 🔧 [notification/identity] — tinch soatlar: `user.settings.notifications.quiet_hours
  = { from: 'HH:MM', to: 'HH:MM' }` (Toshkent vaqti; mavjud settings PATCH orqali, migratsiya
  yo'q). Critical bo'lmagan PUSH oyna oxiriga suriladi (tashlanmaydi). ⏳ identity
  `contacts_by_ids` javobiga `quiet_hours` qo'shilgach ishlaydi.
  → **Frontendda:** 🔧 sozlamalarda "Tinch soatlar" (from/to) maydoni — `mergeSettings` bilan.
- [2026-10-14] 🟢 [notification] — inbox `delivery` JSONB'da yangi holatlar: `push:
  'no_subscription' | 'no_provider' | 'skipped'` (+ `push_reason: 'muted'|'online'|'quiet_hours'`,
  `push_deferred_until`, `push_attempts`, `push_retry_at`), `<kanal>: 'skipped'` +
  `<kanal>_reason: 'muted'`, `sms: 'not_eligible'` + `sms_reason: 'no_phone'`, critical uchun
  `escalation: 'scheduled'|'skipped'|'blocked'|'sms'`, `escalation_due_at`, `escalated_at`.
  → **Frontendda:** 🟢 ixtiyoriy — admin diagnostikasida ko'rsatish mumkin.

### 2026-10-14 — Guruh G (pochtalar ro'yxati/filtrlar, qabul skani, kuryer tablari)

- [2026-10-14] ✏️ [logistics] — `GET /post` ("Eski pochtalar") filtrlari endi
  SERVERDA ishlaydi (YfrqN70i). Avval gateway faqat `page/limit/status/branch_id`
  ni o'qirdi — qolganlari jimgina tashlanardi (mavjud bo'lmagan viloyat ham
  59 ta qaytardi). Yangi ixtiyoriy query'lar:
  - `region_id`, `courier_id` — bigint id. Raqam bo'lmagan qiymat (UUID) →
    bo'sh sahifa (`total: 0`), 500 emas;
  - `startDate`, `endDate` — `YYYY-MM-DD`, **Toshkent kuni** bo'yicha
    (`createdAt`; `endDate=2026-08-31` → 31-avgust 23:59:59 Toshkent kiradi).
    Yaroqsiz sana yoki `startDate > endDate` → 400;
  - `has_orders=true` — faqat `order_quantity > 0` (frontenddagi `hasOrders`
    filtrining server varianti — sahifalash/`total` to'g'ri qolishi uchun).
  `GET /post/courier/old-posts` ham `region_id`, `status`
  (`received|canceled|canceled_received`), `startDate`, `endDate`,
  `has_orders` ni qabul qiladi (`courier_id` — doim JWT).
  Misol: `GET /post?page=1&limit=20&region_id=3&courier_id=119&startDate=2026-08-01&endDate=2026-08-31&has_orders=true`.
  → **Frontendda:** 🔧 `oldMails.tsx` dagi mijoz tomonidagi filtrlashni
  (`filteredMails` — region/courier/status/sana/`hasOrders`) olib tashlang;
  parametrlarni so'rovga qo'yish allaqachon bor (`entities/mails/index.ts`),
  `has_orders: true` ni qo'shing.

- [2026-10-14] ✏️ [logistics] — pochta ro'yxatlarida limit shifti
  (100) endi JIMGINA EMAS (kA70Rban): `GET /post`,
  `GET /post/courier/old-posts` va kuryerning barcha pochtalari javobiga
  `limit_capped: boolean` va `max_limit: 100` qo'shildi. Masalan
  `GET /post?page=1&limit=10000` →
  `{ data: [...100], total: 150, page: 1, totalPages: 2, limit: 100, limit_capped: true, max_limit: 100 }`.
  Hozir prod'da 59 pochta — muammo LATENT (100 dan oshgan kuni arxiv
  jimgina yo'qolardi).
  → **Frontendda:** 🔧 `OLD_MAILS_COLLECTION_LIMIT = 10000` va
  `filteredMails.slice(...)` (mijoz tomonida sahifalash) o'rniga haqiqiy
  `page`/`limit` (8/20/50) ni yuboring va `data.total`/`data.totalPages` ni
  Pagination'ga bering. Excel eksporti: `limit=100` bilan `totalPages`
  gacha sahifama-sahifa yig'ing (150 pochta → 150 qator). `limit_capped:
  true` kelsa ogohlantirish ko'rsating. "Barcha partiyalar" rejimi
  (`useBatches`, `limit=10000`) — alohida endpoint, bu yozuvga kirmaydi.

- [2026-10-14] 🟢 [order] — `GET /orders/external` (kiruvchi posilkalar
  skani) har elementida `customer: {id, name, phone_number, ..., district,
  region}`, `district: {id, name, ...}`, `region`, `order_number` bor
  (e5L3RMRu). Backend 9b1b951 (DL6FCdrh) da yopilgan — mijoz/tuman bitta
  `find_by_ids` partiya so'rovi bilan biriktiriladi (N+1 yo'q); endi spec
  bilan qotirildi.
  → **Frontendda:** 🔧 `entities/incoming-orders/index.ts` `IncomingOrder`
  turiga `customer?: {name, phone_number, district?: {name}}`,
  `district?: {name}`, `order_number?: string` qo'shing; ro'yxatda xom id
  o'rniga `order_number` ko'rsating. O'qish kodi (`customer?.name`,
  `customer?.district?.name ?? district?.name`) allaqachon to'g'ri.

- [2026-10-14] 🆕 [order] — `GET /orders/courier/orders/counts` (faqat
  COURIER, 0d11ewk7) — kuryer tablari badge'i bitta so'rovda:
  `{ statusCode: 200, message: 'Courier order counts', data: { waiting: 12, all: 340, cancelled: 3 } }`.
  Sonlar `GET /orders/courier/orders` tablari bilan AYNI so'rovlardan
  (`waiting` = `status=waiting`, `all` = statussiz, `cancelled` =
  `status=cancelled`) — badge va ro'yxat `total`i farq qilmaydi.
  → **Frontendda:** 🔧 `entities/orders/index.ts` ga
  `useGetCourierOrderCounts` (queryKey `[orders, "courier", "counts"]`,
  `staleTime` bilan — tab almashganda qayta so'ralmasin); `tabs.tsx` Tab
  turiga `count` qo'shib mobil (~131) va desktop (~172) render'da badge;
  0 bo'lsa badge ko'rsatilmasin; 1000+ → `1.2k` (BeePost `formatBadgeCount`);
  sotish/qisman sotish/bekor qilish/qaytarish mutatsiyalaridan keyin counts
  query'sini invalidate qiling.

### 2026-10-14 — Guruh G (AI buyurtma)

- [2026-10-14] 🟢 [order/ai] — `POST /orders/ai-parse` preview'ida yangi
  ixtiyoriy kalit `district_source: 'ai'` (5Z1ZvvzE): deterministik rezolver
  tumanni topolmaganda (imlo xatosi, viloyat aytilmagan) arzon model tumanni
  INDEKS bilan tanladi (viloyat qulfi + SOATO tekshiruvidan o'tgan). Kalit
  faqat shu holatda bor; shakl boshqacha o'zgarmagan.
  → **Frontendda:** (ixtiyoriy) 🔧 tuman maydoni yonida "AI taklifi —
  tekshiring" belgisi. O'zgarish shart emas.

- [2026-10-14] ✏️ [order/ai] — `POST /orders/ai-confirm` har buyurtmasida
  yangi ixtiyoriy `ai_item_index` (0..29) — ai-parse preview'idagi `index`
  (Cp2v3ZJ7, vncdmXOy). `draft_id` + `ai_item_index` berilsa backend BARQAROR
  dublikat kaliti (`ai:<market>:<draft>:<index>`) ishlatadi: ayni band ikkinchi
  marta HECH QACHON yaratilmaydi (sahifa yangilansa ham), va operator
  o'zgartirgan maydonlar server tomonda audit qilinadi. Berilmasa — eski
  imzo-dedupe (10 daqiqa) va audit'siz.
  Natija: `ok:true` elementlarida endi `idempotent_replay: boolean` —
  `true` = bu band avval yaratilgan, xuddi o'sha `order_id` qaytdi (yangi
  buyurtma YO'Q). Boshqa draft'dan ayni mazmun 10 daqiqa ichida kelsa —
  avvalgidek `ok:false, code:'duplicate_recent'` (+ `order_id`).
  → **Frontendda:** 🔧 `buildAiConfirmPayload` da har buyurtmaga
  `ai_item_index: preview.index` qo'shing (qayta yuborishda O'ZGARTIRMANG);
  `ok:true` (shu jumladan `idempotent_replay:true`) kartalarni qulflang va
  qayta yubormang — retry'da faqat `ok:false` bo'lganlarni yuboring
  (`createdSigs` faqat qulaylik, haqiqiy himoya backendda).
  `idempotent_replay:true` ni "allaqachon yaratilgan #<order_id>" deb
  ko'rsating (xato EMAS).
- [2026-10-14] 🆕 [order/ai] — `GET /orders/:id/ai-trace` (faqat
  SUPERADMIN/ADMIN; boshqalar 403) — AI buyurtma audit izi (vncdmXOy):
  `source_text` (maskalangan, telefonlar `[TEL_n]`; 30 kundan keyin `null`,
  `source_purged:true`), `model`, `prompt_version`, `ai_suggestion` (AI
  taklifi; telefon faqat `phone_masked`), `edited_fields` (operator
  o'zgartirgan maydonlar — server hisoblagan), `confirmed_by`,
  `cost.{draft_cost_uzs, order_cost_uzs, calls, linked_orders}`.
  Buyurtma AI'dan yaratilmagan bo'lsa 404.
  → **Frontendda:** 🔧 (ixtiyoriy) buyurtma tafsilotida admin uchun
  "AI izi" bo'limi; 404 = oddiy buyurtma, bo'limni yashiring.

- [2026-10-14] ✏️ [ai] — `GET /ai/status` javobiga `model_policy`
  qo'shildi: `{ ok: boolean, order, vision, classify }`, har biri
  `'ok' | 'weak' | 'unknown'` (LP3RKvXY). `weak` — ekstraksiya modeli
  kuchsiz modelga (masalan Haiku) pasaytirilgan; `unknown` — model nomi narx
  jadvalida yo'q (xato yozilgan). Servis baribir ishlaydi.
  → **Frontendda:** 🔧 AI admin dashboard'ida `model_policy.ok === false`
  bo'lsa QIZIL belgi ("Ekstraksiya modeli pasaytirilgan: <models.order>")
  ko'rsating. Qolgan maydonlar o'zgarmagan.

### 2026-10-14 — Guruh H: hisobotlar, AI xarajat paneli, investor (W20LoskP, Celz3rKJ, GADgsW5G)

- [2026-10-14] 🆕 [api-gateway/ai] — (Celz3rKJ) `GET /ai-usage/dashboard?fromDate&toDate`
  (YYYY-MM-DD, Toshkent, ikkala chet ham kiradi; berilmasa oxirgi 30 kun;
  `fromDate > toDate` / noto'g'ri format → 400). Faqat SUPERADMIN, ADMIN —
  boshqa rol 403. Javob (BeePost `ai-usage/dashboard` bilan bir xil nomlar):
  `{ from, to, usdUzsRate, summary: { totalCostUsd, totalCostUzs, totalCalls,
  cacheSavedUsd, cacheSavedUzs, metaIncompleteCalls, linkedCalls, aiOrderCount,
  orderCostUsd, orderCostUzs, avgCostPerAiOrderUsd, avgCostPerAiOrderUzs },
  byArea: [{ area, calls, inputTokens, outputTokens, costUsd, costUzs }],
  byFeature: [{ feature, area, calls, steps, inputTokens, outputTokens, costUsd,
  costUzs }], byModel: [{ model, calls, costUsd, costUzs }], dailySeries:
  [{ day: 'YYYY-MM-DD', costUsd, costUzs, calls, aiOrders }], orderSources:
  { total, ai, manual, external, branch, applied_range } | null, degraded,
  failed_parts }`. `dailySeries` kuni SQL'da `AT TIME ZONE 'Asia/Tashkent'`
  bilan bucket'langan, davr ≤ 366 kun bo'lsa bo'sh kunlar 0 bilan keladi.
  So'm qiymati — jurnal qatoridagi `cost_uzs` (yozish paytidagi kurs);
  `usdUzsRate` — hozirgi kurs, faqat ma'lumot uchun. `orderSources.manual` =
  market/operator buyurtmalari − AI buyurtmalar; `orderSources: null` +
  `degraded: true` — order-service javob bermadi (AI xarajati baribir keladi).
  Feature nomlari: `order_extract_multi`, `order_extract_image`,
  `order_district`, `order_item_match`.
  → **Frontendda:** 🔧 `src/pages/financial-balance/index.tsx` ga "AI xarajat"
  tabi (alohida sahifa EMAS): KPI kartalari (`summary.totalCostUzs` +
  `summary.totalCostUsd`, chaqiruvlar, AI buyurtmalar, o'rtacha narx), feature
  jadvali, model PieChart, kunlik ComposedChart (`costUzs` + `calls` +
  `aiOrders`), buyurtma manbasi ulushi (`orderSources`). ⚠️ Kunni frontendda
  "epoch + 5 soat" bilan QAYTA hisoblamang — `dailySeries[].day` tayyor
  Toshkent sanasi. 390px da gorizontal skrollsiz (jadval kartaga aylansin).
  "Bot" manbasi Elchida alohida belgilanmaydi (bot buyurtmasi `manual` ichida).
- [2026-10-14] 🆕 [api-gateway/ai] — (Celz3rKJ) `GET /ai-usage/ai-orders?fromDate&toDate&limit`
  (limit 1..100, sukut 100; SUPERADMIN, ADMIN) → `{ from, to, total, limit,
  items: [{ orderId, orderNumber, status, totalPrice, draftId, marketId,
  confirmedBy, editedFields, createdAt, model, sourceKind, draftCostUsd,
  draftCostUzs, draftOrders }], degraded }`. Xarajat DRAFT darajasida (bitta
  AI so'rovdan bir nechta buyurtma chiqishi mumkin — `draftOrders`). Mijoz
  ismi/telefoni javobda YO'Q.
  → **Frontendda:** 🔧 "AI xarajat" tabida "AI buyurtmalar" ro'yxati
  (buyurtma raqami → buyurtma sahifasiga havola).
- [2026-10-14] ✏️ [analytics] — (W20LoskP) `GET /analytics/reports/orders`:
  `statusDistribution` endi `Order_status` enumidagi BARCHA 13 kalitni
  qaytaradi (`created`, `waiting`, `waiting_customer`, `returned_to_market` ham;
  0 bo'lsa ham) va yig'indisi `overview.acceptedCount` ga teng. Yangi maydonlar:
  `statusDistributionTotal`, `applied_range` (order-service 366 kunlik oynasi,
  `clamped`), `degraded`, `failed_parts`. `byRegion` va `topProducts` endi
  SQL'da to'liq hisoblanadi (ilgari 10 000 buyurtmadan keyin jim kesilardi).
  Bo'lak olinmasa `statusDistribution: null` (nollar emas) va `degraded: true`.
  → **Frontendda:** 🔧 status diagrammasi qo'lda yozilgan ro'yxat emas,
  javobdagi kalitlar bo'yicha chizilsin; `degraded` da ogohlantirish.
- [2026-10-14] ✏️ [investor] — (GADgsW5G) `PATCH /profits/:id/mark-paid`
  aktor (JWT foydalanuvchisi) aniqlanmasa endi 403 qaytaradi — pul aktorsiz
  (`user_id '0'`) chiqmaydi; kassa `created_by` = JWT `sub`. Investor
  moduli O'QISH marshrutlari ham endi `requester` uzatadi (javob o'zgarmagan).
  → **Frontendda:** 🟢 o'zgarish shart emas (oddiy login bilan 200).

### 2026-10-14 — Guruh F (filiallar, hududlar, RBAC, foydalanuvchi statistikasi)

- [2026-10-14] 🔧 [branch] (EiZj47Gc) — `POST /branches`: qaror — PICKUP ham
  ota filialga ega bo'ladi (backend qoidasi o'zgarmadi: HQ'dan boshqa BARCHA
  turlar uchun `parent_id` majburiy). Gateway endi `parent_id: ''` / `null` ni
  "yo'q" deb qabul qiladi, shuning uchun tushunarsiz
  `"parent_id must be a number string"` o'rniga branch-service'ning aniq xabari
  qaytadi: `400 "HQ bo'lmagan filial uchun ota filial (parent_id) majburiy"`.
  → Frontend: `BranchFormModal.tsx:125` dagi
  `parent_id: normalizedType === "PICKUP" ? "" : values.parent_id` shartini olib
  tashlang; `schema.ts` dagi `when("type")` ni `type !== "HQ"` bo'lganda
  `parent_id` required qilib o'zgartiring (PICKUP ham). Misol:
  `POST /branches {"name":"Chilonzor PVZ","type":"PICKUP","code":"TSH-CHL","parent_id":"7"}` → 201.

- [2026-10-14] 🔧 [branch] (RlMb3F26) — filial sozlamalari endi YOZILADI:
  `POST /branches/:id/config` (`{config_key, config_value}` → yangi 201 /
  mavjud 200) va `PATCH /branches/:id/config/:key` (`{config_value}` → 200)
  avval har doim `400 "branch_id majburiy"` qaytarardi (RMQ payloadida
  `dto.branch_id` o'qilmasdi) — tuzatildi. `GET /branches/:id/config`,
  `GET|DELETE /branches/:id/config/:key` o'zgarmadi. Javob qatori:
  `{id, branch_id, config_key, config_value (jsonb obyekt | null), isDeleted, createdAt, updatedAt}`.
  → Frontend: (1) `BranchSettingsSection.tsx` ni `BranchDetailWidget` ga
  ikkinchi tab qilib ulang (`widgets/branch-detail/index.ts` eksporti +
  `BranchDetailWidget.tsx:133-139` tab paneli) yoki ishlatilmayotgan
  komponentni o'chiring; (2) `branchApi.normalizeSetting` (branchApi.ts:144-152)
  `{key,value}` emas, `config_key` / `config_value` ni o'qisin. Misol:
  `POST /branches/1/config {"config_key":"working_hours","config_value":{"start":"09:00","end":"18:00"}}` → 201.

- [2026-10-14] ⚠️ [logistics] (uherIk8r) — hudud statistikasi serverda
  cheklandi:
  - `GET /region/stats/all` — COURIER endi **403** (MARKET avvaldan 403).
    Rollar: admin, superadmin, manager, registrator, logist. Doira SERVERDA:
    admin/superadmin/logist va HQ filial xodimi — 14 viloyat; boshqa filial
    menejeri/registratori — `regions` da FAQAT filial viloyati (`summary` ham
    shu bo'yicha); filialga biriktirilmagan bo'lsa `regions: []`.
  - `GET /region/stats/:id` — HQ'dan tashqari filial menejeri/registratori
    boshqa viloyat id'si bilan → 403 `"Bu viloyat statistikasini ko'rishga ruxsat yo'q"`.
  - 🆕 `GET /region/my/district-stats?startDate=&endDate=` — `@Roles(courier, manager)`.
    Viloyat tokendagi foydalanuvchidan serverda aniqlanadi (kuryer —
    `users.region_id`, menejer — filial viloyati); query'dagi `region_id` /
    `courier_id` e'tiborsiz. Kuryer ism/telefoni qaytmaydi. Javob:
    `{ region: {id, name, satoCode}, summary: {totalOrders, deliveredOrders, cancelledOrders, pendingOrders, totalRevenue, successRate, districtsCount}, districts: [{id, name, satoCode, totalOrders, deliveredOrders, cancelledOrders, pendingOrders, totalRevenue, successRate, couriersCount}] }`.
    Viloyat biriktirilmagan: `200 { region: null, summary: null, districts: [] }`,
    message `"Sizga viloyat biriktirilmagan"`.
  - O'tish davri: gateway env `REGION_STATS_COURIER_COMPAT=true` bo'lsa kuryer
    `stats/all` da 403 emas, `regions` da FAQAT o'z viloyatini oladi (eski
    /regions sahifasi `regions.length === 1` bilan ishlaydi). Default — 403.
  → 🔧 Frontend: `pages/region/index.tsx:128` dagi `useRegionStats` ni kuryer
  uchun yangi `useMyDistrictStats` hooki (`GET /region/my/district-stats`)
  bilan almashtiring; brauzerdagi `scopedRegion` filtri kerak emas. Menejer
  uchun ham shu endpoint (yoki hozirgidek `stats/:id` o'z viloyati bilan)
  ishlatilsin. `canViewRegionStats` dagi kuryer → yangi endpoint. FE chiqqach
  backend flag va `@Roles` dagi COURIER olib tashlanadi.

- [2026-10-14] ✏️ [identity] (nFmup26a) — `GET /users` meta: `totalEmployees`
  endi market BO'LMAGAN barcha rollar (avval faqat admin+registrator+courier;
  menejer/operator/branch/investor/logist tushib qolardi). Invariant:
  `totalMarket + totalEmployees === totalUsers`. 🆕 `meta.countsByRole` —
  Roles enum'ining har bir qiymati uchun son (yo'q rol — 0; superadmin/customer
  bu ro'yxatda doim 0). Misol:
  `meta: {total, page, limit, totalPages, totalMarket: 11, totalEmployees: 24, totalUsers: 35, countsByRole: {market: 11, manager: 11, courier: 10, registrator: 2, admin: 1, logist: 0, ...}}`.
  → Frontend: `UserStats.tsx` o'zgarishsiz to'g'ri raqam ko'rsatadi; xohlasa
  kartalarni `countsByRole` dan qursin. ⚠️ Eslatma: menejer so'rovida gateway
  `meta.totalUsers` ni sahifadagi filtrlangan qatorlar soniga qayta yozadi
  (api-gateway.controller.ts `getUsers`) — bu alohida karta, bu yerda tegilmadi.

- [2026-10-14] 🔧 [api-gateway] (lQP3ojwq, wLNccBkX) — ops RBAC: backend
  ruxsatlari O'ZGARMADI (hech kim ruxsat yo'qotmaydi/olmaydi); UI backendga
  moslashtirilsin. 🆕 `npm run openapi:generate` endi har operatsiyaga
  `x-roles: string[] | null` qo'shadi (gateway `@Roles`; `null` — `@Roles`
  yo'q, istalgan autentifikatsiyadan o'tgan foydalanuvchi). Joriy qiymatlar:
  - `POST /orders/settlement/courier-to-branch` — x-roles
    `[manager, registrator, superadmin, admin]`, lekin HAMMA uchun **410 Gone**
    (lump-sum olib tashlangan, MlVMpsfr/uEPILERk); `branch-to-hq`
    `[manager, superadmin, admin]` → 410; `hq-to-market` `[superadmin, admin]` → 410;
    ro'yxatda yo'q rol → 403.
  - `POST /transfer-batches/:id/cancel` — `[superadmin, admin, branch, manager, registrator]`;
    servisda FAQAT manba filial menejeri/registratori (yaratish huquqi bilan
    bir xil), boshqa filial → 403.
  - `/activity-logs/*` — `[superadmin, admin]`.
  → Frontend: (1) `ROUTE_ROLES` ni `openapi.json` dagi `x-roles` dan
  generatsiya qiling, `canViewOpsPages` / menyu shundan o'qisin; CI'da farq
  bo'lsa build yiqilsin (drift darvozasi). (2) `/settlement` sahifasi o'lik
  endpointlarni chaqiradi (410) — olib tashlansin yoki moliya kassasi
  oqimiga (`/finance/cashbox/payment/*`) yo'naltirilsin. (3) `pages/ops/index.tsx:106`
  dagi "faqat superadmin" matni haqiqatga moslansin; partiyani bekor qilish
  tugmasi menejer/registratorning o'z filiali partiyalari ekranida ko'rsatilishi
  mumkin (backend ruxsat beradi). (4) `/activity-logs` va `/ops` bir xil
  qoidaga keltirilsin (backend: activity-logs — superadmin+admin).

- [2026-10-14] 🆕 [identity] (hEjjuJaT) — super-kuryer (ko'p viloyat) va
  viloyat bo'yicha kuryer tarifi (migratsiya 1716000000089):
  - `GET /couriers/:id/regions` (superadmin, admin) →
    `{ courier_id, home_region_id, is_super_courier, serves_all_regions, flat_tariff_home, flat_tariff_center, regions: [{region_id, tariff_home, tariff_center}] }`.
  - `PUT /couriers/:id/regions` (superadmin, admin) — ro'yxat TO'LIQ
    almashtiriladi: `{ is_super_courier?: boolean, serves_all_regions?: boolean, regions?: [{ region_id: "5", tariff_home?: 15000|null, tariff_center?: 12000|null }] }`.
    `tariff_* = null` — kuryerning umumiy (yassi) tarifiga fallback.
    `is_super_courier=false` → viloyatlar tozalanadi; ro'yxat yoki
    `serves_all_regions=true` oddiy kuryerga — 400; takror/noma'lum viloyat,
    manfiy yoki kasr tarif — 400; logistics javob bermasa — 503.
  - Kuryer ro'yxatlari (`GET /couriers?region_id=`, `/couriers/region/:id`,
    pochta uchun kuryerlar) super-kuryerni biriktirilgan har viloyatda,
    `serves_all_regions=true` bo'lsa HAMMA viloyatda qaytaradi.
  - Sotuv/qisman sotuv/bekor qilish/rollback'da super-kuryer tarifi buyurtma
    viloyati bo'yicha olinadi va `orders.courier_tariff` ga snapshot bo'ladi
    (Elchi'da snapshot SOTUVDA; keyingi tarif o'zgarishi eski buyurtmaga
    ta'sir qilmaydi).
  → 🔧 Frontend: kuryer kartasida "Super-kuryer" bo'limi (bayroqlar +
  viloyatlar/tarif jadvali) — GET/PUT `/couriers/:id/regions`.

### 2026-10-12 — 1-kun backend kartalari

- [2026-10-12] ✏️ [order/logistics] — superadminning mavjud
  `DELETE /orders/:id` amali `received` buyurtmani faqat jo'natilmagan,
  to'lovsiz pochtadan o'chiradi; buyurtma belgisi va pochta sanog'i/summasi
  bitta DB tranzaksiyasida yangilanadi. Jo'natilgan pochta, to'lov yoki
  qaytarish/partiya aloqasi bo'lsa 409 qaytadi (yokjwjXG).
  `POST /post/cancel` hanuz faqat kuryer/menejerning bekor pochta oqimi.
  → **Frontendda:** 🔧 savatni qayta yoqish qarori haqiqiy buyurtmani
  o'chirish bo'lsa `DELETE /orders/:id` ni ishlating; faqat pochtadan
  ajratish istalsa bu endpoint mos emas, savat yashirin qolsin.
- [2026-10-12] ✏️ [order] — `disable_pagination` ichki ro'yxatlari 5000 qator
  bilan chegaralanadi; `GET /orders/markets/:marketId/new` javobida
  `truncated` bayrog'i bor (9Rdi2gJF). Kuryerning bekor tabi bitta
  sahifalangan so'rovdan qaytadi, javob shakli saqlangan.
  → **Frontendda:** 🔧 `truncated: true` bo'lsa ro'yxat to'liq emasligini
  ko'rsating; kuryer tabida server bergan `total/page` ga tayaning.
- [2026-10-12] 🔧 [finance] — `GET /finance/financial-balance/top-impacts`
  backendda avvaldan server sahifalashi bor: `limit` eng ko'pi 100,
  `pagination.totalPages` haqiqiy jami qatorga asoslanadi (vmLTsAok).
  → **Frontendda:** 🔧 AnalysisTab'da `limit: PAGE_SIZE` va joriy `page`
  yuboring, `totalPages` ni javobdan o'qing; mahalliy `slice/sort` ni olib
  tashlang. `buildBuckets(rows)` fallbackini olib tashlang yoki “taxminiy”
  deb belgilang. AnalysisTab/HistoryTab sana parametrlarini Toshkent kuni
  chegaralari bilan yuboring (`YYYY-MM-DD`, backend shu kunni hisoblaydi).
- [2026-10-12] ⚠️ [finance] — `POST /finance/financial-balance/entries`
  endi `Idempotency-Key` sarlavhasini talab qiladi; yo'q bo'lsa 400,
  ayni kalit boshqa yozuvga ishlatilsa 409 qaytadi. `amount: 0` daftar
  yozmasdan HTTP 200 `skipped` qaytaradi; haqiqiy yangi yozuv HTTP 201
  bo'lib qoladi (cSNJN7GP).
  → **Frontendda:** `FinancialEntryModal` har yangi yozuv uchun UUID yaratib,
  takroriy yuborishda ayni kalitni saqlashi allaqachon bor. 400/409 va
  `200 skipped` holatlarini yangi backend bilan integratsiyada tekshiring.
- [2026-10-12] 🔧 [finance] — `GET /finance/financial-balance/history`
  `source_type` endi enumga kirmasa 400 qaytaradi (b1QxU3qa).
  → **Frontendda:** `HistoryTab` `sell_profit` yuborishi, xatoda
  `QueryErrorState` va qayta urinishni ko'rsatishi allaqachon bor.
  AnalysisTab/HistoryTab'dagi eski `sell` ko'rsatish aliaslarini tozalash mumkin.
- [2026-10-12] ⚠️ [analytics] — dashboard/KPI asosiy order ma'lumoti
  olinmasa 503; qisman nosozlikda dashboard/revenue/KPI javobida
  `degraded: true` va `failed_parts` bor (VkwhHqvW).
  → **Frontendda:** 🔧 503 yoki `degraded` holatini “ma'lumot olinmadi” deb
  ko'rsating; yetishmagan bo'limda 0 sonini chizmang, qayta urinish imkonini
  bering.
- [2026-10-12] ✏️ [analytics] — top-market/kuryer/filial reytinglari tanlangan
  davrga bog'landi va sukut `min_orders=1`; qatorlar massivi avvalgidek
  (`topMarkets`, `topBranches`, `ranking`, `marketRating`), yonida
  `topMarketsMeta`, `topBranchesMeta`, `rankingMeta`, `marketRatingMeta`
  (`min_orders`, `filtered_out`) paydo bo'ldi (PQt3n1N0).
  → **Frontendda:** 🔧 “kamida 30 buyurtma” qotirilgan bo'sh holat matnini
  olib tashlang; server metadata'siga qarab sababini ko'rsating.
- [2026-10-12] ✏️ [analytics] — `GET /analytics/dashboard?all=true`
  market va kuryer qatorlarini ham qaytaradi; `all=true` haqiqiy barcha tarixni
  qamraydi (`clamped: false`, `effective_from` 1970-01-01 Toshkent kuni,
  `effective_to` joriy vaqt). Oddiy sana oralig'i 366 kun bilan chegaralangan
  holda qoladi (uN1tjjGu).
  → **Frontendda:** 🔧 “Barchasi” uchun barcha tarixni ko'rsating; oddiy
  oralig'ida `clamped` bo'lsa qo'llangan sanalarni chiqaring.
- [2026-10-12] ✏️ [finance] — `GET /finance/financial-balance` javobida
  `markets.allMarketCashboxes` va `couriers.allCourierCashboxes` endi nol
  bo'lmagan kassalarni qaytaradi; ikkala bo'limda `nonZeroCount` va
  `truncated` bor (IaMK2tf2). → **Frontendda:** 🔧 ro'yxat sanog'ini
  `nonZeroCount` dan o'qing, `truncated` bo'lsa top-N ekanini ko'rsating va
  “Barchasini ko'rish” havolasini qo'shing. Market qatorining `balance`
  ishorasini saqlang: `-Math.abs(rawBalance)` ni olib tashlang. 390px
  kenglikda gorizontal overflow yo'qligini tekshiring.
- [2026-10-12] 🔧 [sms] — promo SMS navbatga qo'yish va yuborish oldidan
  rozilik qayta tekshiriladi; roziligi yo'q yoki keyin bekor qilingan raqamga
  xabar ketmaydi (sVByLMnt). → **Frontendda:** 🔧 kampaniya uchun
  `POST /notifications/sms/campaigns/preview` javobidagi `recipients`, `blocked_no_consent`,
  `estimated_cost`, `sample_text` va `fanout_exceeded` ni tasdiq oynasida
  ko'rsatish, `Idempotency-Key` bilan yuborish va kampaniya tarixini ko'rsatish
  `CampaignPage` da allaqachon bor. Opt-out matni preview'da ko'rinadi.
  Davlat reyestri va OTP istisnosi huquqiy tekshiruv/tashkiliy ish bo'lib qoladi.
- [2026-10-12] 🔧 [settlement] — eski `/orders/settlement/*` endpointlari 410
  qaytaradi; ularning DTO'si ham `amount: 0` ni rad etadi (qGaxcaD4).
  → **Frontendda:** 🔧 eski settlement formasini ishlatmang; amaldagi
  `/finance/cashbox/payment/*` formalarida bo'sh summani yubormang, probel
  bilan ajratilgan raqamni to'g'ri o'qing, xatoda backend `message` ni ko'rsating
  va pul o'tkazishdan oldin tasdiq so'rang.
- [2026-10-12] 🔧 [logistics] — `POST /post/cancel` savatdagi "o'chirish"
  emas, bekor qilingan pochtani yaratish oqimi; superadmin bu oqimda 403
  oladi (yokjwjXG). → **Frontendda:** `/mails/:id` dagi savat amali
  `canDelete={false}` bilan allaqachon yashirilgan. Uni qayta yoqishdan oldin
  "pochtadan ajratish" yoki "bekor qilingan pochtaga yuborish" maqsadi tanlansin.
- [2026-10-12] 🔧 [api-gateway/finance] — qo'lda kuryer/market/filial to'lovi
  va kassa kirim/chiqimida `Idempotency-Key` sarlavhasi bo'lmasa dedup
  qilinmaydi; takroriy kalitda `data.idempotent: true` qaytadi (TMgL1zvq).
  → **Frontendda:** 🔧 har submit uchun `crypto.randomUUID()` kalit yarating,
  retry paytida ayni kalitni yuboring; `idempotent: true` ni alohida ko'rsating.
- [2026-10-12] 🔧 [api-gateway/finance] — `POST /finance/operator-payments`
  tanasida `note` qabul qilinadi, `comment` 400 qaytaradi (2DCQKd37).
  → **Frontendda:** 🔧 `finance-operators` to'lov formasida `comment` o'rniga
  `note` yuboring (bo'sh bo'lsa yubormang), jadvalning Izoh ustunini `note` dan
  o'qing va 400 javobdagi `message` ni ko'rsating.
- [2026-10-12] 🔧 [api-gateway/logistics] — `GET /post/orders/:id` va
  `/post/orders/rejected/:id` javobidagi `market` faqat `id/name/phone_number`,
  `customer` faqat `id/name/phone_number/address/district_id`, `district` esa
  `id/name/region` (regionda `id/name`) qaytaradi (VfgcnxDa).
  → **Frontendda:** 🔧 `PostOrder` ichidagi boyitilgan obyekt tiplarini
  toraytiring; pochta detalida faqat shu maydonlardan foydalaning.

### 2026-10-10 — Qaytgan kartalar (backend)

- [2026-10-10] ✏️ [logistics] — Tuman/viloyat o'chirish himoyasi endi faqat
  o'chirilmagan buyurtma/foydalanuvchi/filiallarni sanaydi (oNAE3LW9): faqat
  o'chirilgan buyurtmasi bor tuman o'chiriladi (200). `POST /district/:id/merge`
  o'chirilgan buyurtmalarni ham B ga ko'chiradi; javobdagi `moved` ularni ham
  sanaydi, `target_before`/`target_after` da `deleted` qismi.
- [2026-10-10] 🟢 [search/identity] — Telefon bo'yicha qidiruv istalgan
  formatda ishlaydi (`0330991009`, `+998 33 099 10 09`, `330991009`,
  `998330991009`): `GET /search?q=`, buyurtmalar ro'yxatidagi `search`, mijoz va
  foydalanuvchi qidiruvlari (zfPNDCCr). Kontrakt o'zgarmagan.

### 2026-10-09 — Prod testidan keyingi backend tuzatishlar (3-bosqich)

- [2026-10-09] ⚠️ [order/identity] — Mijoz telefoni hamma yo'lda (POST /orders,
  /orders/external, /orders/telegram/bot/create, import, ai-confirm, hamkor)
  `+998XXXXXXXXX` ga normallashtiriladi; o'zbek raqamiga keltirib bo'lmaydigan
  qiymat → **400** "Telefon raqam noto'g'ri" (`customer.phone_number`)
  (zfPNDCCr). Eski normallashtirilmagan mijozlar ham topiladi (dublikat yo'q).
  → **Frontendda:** 🔧 buyurtma formasidagi telefon maskasi 12 xonali `998…`
  joylanganda prefiksni olib tashlasin (hozir `+998998887009` yuboradi).
- [2026-10-09] ✏️ [order] — Buyurtma javoblarida rolga qarab moliyaviy
  proyeksiya (kH2zZsz3): MARKET/MARKET_OPERATOR — `courier_tariff`,
  `courier_share`, `branch_share` yo'q; COURIER — `market_tariff`,
  `branch_share`, market tarif/komissiya maydonlari yo'q (detal, ro'yxat,
  qr-code, scan, `GET /finance/history/:id`). Admin/menejer/registrator —
  o'zgarmagan. `to_be_paid`/`paid_amount` kuryerga hozircha qoldirildi.
  → **Frontendda:** 🔧 kuryer detalida `to_be_paid` qatorini yashiring.
- [2026-10-09] 🆕 [order] — `GET /orders/qr-code/:token?view=light` va
  `GET /scan/:token?view=light` — skaner uchun yengil javob (id, raqam,
  status, summa, manzil, mijoz, tuman/viloyat, mahsulot nomlari) (D148eHMA).
  Parametrsiz — avvalgidek to'liq javob.
  → **Frontendda:** 🔧 skan ekranlari `view=light` dan foydalansin.
- [2026-10-09] ✏️ [analytics] — Dashboard "Jami qabul qilingan" endi ro'yxat
  bilan bir xil sanaydi (qisman sotuvdan hosil bo'lgan bola-buyurtma ham
  alohida) (SqVMuhKo).
- [2026-10-09] 🟢 [notification] — Inbox: guruhlangan qator (`group_key`)
  yangilanganda ro'yxat tepasiga chiqadi (OA16fdSq).
- [2026-10-09] ✏️ [logistics] — Tuman/viloyat o'chirish 400 xabarlari endi
  tushunarli o'zbekcha, xom API yo'lisiz (oNAE3LW9).
- [2026-10-09] 🟢 [audit] — Faoliyat jurnalida superadmin/admin amallari
  "Kim" ustunida ism bilan (2WRzdWpZ).
- [2026-10-09] ✏️ [integration] — Hamkor posilkasida `collected_from_customer`
  eski sotuvlarda ham to'ladi (snapshot yo'q bo'lsa `total_price −
  paid_online_amount`); GET va webhook bir manbadan (Lx5oONlP).

### 2026-10-09 — Kartadagidek qilib tugatildi (2-bosqich)

- [2026-10-09] ⚠️ [identity] — `market_tg_token` endi HECH bir umumiy javobda
  yo'q: `GET /users`, `GET /users/:id` (SUPERADMIN/ADMIN uchun ham — avvalgi
  istisno bekor), `GET /markets`, profil (GvL6ZFAd). Tokenni ko'rish va
  almashtirish faqat SUPERADMIN:
  - `GET /markets/:id/tg-token` → `{ id, market_tg_token }`; boshqa rol → 403,
    market yo'q → 404. Har ko'rish audit jurnaliga yoziladi.
  - `POST /markets/:id/tg-token/rotate` → yangi token, eskisi darhol yaroqsiz.
  - `POST /markets/tg-token/rotate-all` `{ "confirm": "ROTATE_ALL" }` →
    `{ rotated_count }` (operatsion amal, UI shart emas).
  - Javoblar `Cache-Control: no-store`.
  → **Frontendda:** 🔧 `User.market_tg_token` ni tipdan olib tashlang;
  `UserDetailWidget` token kartasi yangi endpointdan olsin va faqat
  SUPERADMIN'ga ko'rinsin; "Tokenni yangilash" tugmasi + tasdiqlash.
- [2026-10-09] ⚠️ [identity] — `/market-operators` endi FAQAT market uchun
  (i76gGjyq: ko'lam `requester.sub = market_id`). SUPERADMIN/ADMIN →
  **403** (ilgari `?market_id=` bilan ko'ra olardi).
- [2026-10-09] 🟢 [notification] — Telegram bot tokeni DB'da shifrlangan
  (n0kLbx3d). Kontrakt o'zgarmagan (`has_token`). Server kaliti sozlanmagan
  bo'lsa `POST/PATCH /notifications` `token` bilan 400 qaytaradi;
  `/notifications/send` natijasida "Telegram bot tokenini ochib bo'lmadi" —
  tokenni `PATCH /notifications/:id` orqali qayta kiritish kerak.
- [2026-10-09] 🆕 [notification] — Inbox'da yangi avtomatik bildirishnomalar
  (OA16fdSq, ePpLHPX2). Turlar `GET /notifications/types` katalogida:
  - `order.*` holat bildirishnomalari endi viloyat LOGIST'iga ham keladi
    (bitta buyurtma = inboxda bitta qator);
  - `order.assigned_to_courier` — kuryer va marketga, `link /orders/{id}`;
  - `finance.payment_received` — `link /cash-box`, `data.kind` =
    `market_payment` | `courier_payment`;
  - `finance.balance_topup` — market/kuryer kassasiga qo'lda kirimda;
  - `logistics.batch_arrived` — filiallararo pochta qabul qilinganda filial
    MANAGER/REGISTRATOR'lariga, `link /mails/{post_id}`.
  → **Frontendda:** 🔧 shu turlar va havolalar inboxda to'g'ri ochilishini
  tekshiring.
- [2026-10-09] ✏️ [audit] — `GET /activity-logs`: `metadata.ip`, `user_agent`,
  `device_id`, `device_name` faqat oxirgi 30 kun yozuvlarida (env
  `ACTIVITY_LOG_DEVICE_RETENTION_DAYS`) — eskiroq qatorlarda bu kalitlar yo'q,
  chip ko'rsatilmasin (f2Ud5tju). Endpoint faqat SUPERADMIN/ADMIN.
- [2026-10-09] ✏️ [logistics] — `DELETE /region/:id`: filiallararo jo'natma
  (`branch_transfer_batches`) bog'langan viloyat ham → 400 (oNAE3LW9).
  `POST /district/:id/merge` → 200 `{ from_district_id, to_district_id,
  moved: { orders, users, branches }, target_before, target_after }`. Xato
  (409 — tekshiruv mos kelmadi / servis rad etdi; 503 — javob yo'q) bo'lsa
  ko'chirilganlar A ga qaytariladi, A o'chmaydi. 120 s gacha davom etishi
  mumkin.
  → **Frontendda:** 🔧 `message` ni to'liq ko'rsating ("QO'LDA TUZATING"
  bo'lsa ogohlantirish sifatida), loader va qayta bosishdan himoya.
- [2026-10-09] ✏️ [order] — `POST /orders/telegram/bot/create`: `total_price`
  manfiy bo'lsa 400 (IDG1z5y9).

### 2026-10-09 — 8-oktabr muddatli kartalar (buyurtma, geo, logist, settlement)

- [2026-10-09] ⚠️ [order] — `POST /orders`, `/orders/external`: `total_price`
  endi **majburiy** va `≥ 0`; `items` kamida 1 ta; `items[].quantity` butun
  son `≥ 1`. Manfiy/kasr qiymat → **400** (IDG1z5y9). Order-service ichki
  yo'llarda ham (AI tasdig'i, bot, hamkor) xuddi shu tekshiruv.
  → **Frontendda:** buyurtma formasida `total_price` doim yuborilsin,
  miqdor maydoniga `min=1 step=1`.
- [2026-10-09] ⚠️ [order] — `POST /orders` / `/orders/external` /
  `/orders/ai-confirm`: market tekshiriladi (UER0MpMX): yo'q → **404**,
  nofaol → **400**, MARKET/MARKET_OPERATOR uchun `add_order=false` → **400**.
  `items[].product_id` boshqa marketniki yoki o'chirilgan → **404**; katalog
  javob bermasa → **503**.
  → **Frontendda:** shu xabarlarni toast'da ko'rsating.
- [2026-10-09] 🟢 [order] — `GET /orders/extra-cost-approvals` endi `:id`
  marshrutidan oldin turadi — ilgari 400 qaytarardi, endi ishlaydi (PINtZcLj).
- [2026-10-09] ✏️ [order] — `GET /orders/external?limit=` ruxsat etilgan
  qiymatlar: `10, 25, 50, 100, 200` (PEc4BjVX). Boshqa ro'yxatlar o'zgarmagan
  (≤ 100).
  → **Frontendda:** skan ekrani 200 tagacha so'rashi mumkin.
- [2026-10-09] ✏️ [catalog] — mahsulot javobidagi `market` endi faqat
  `{ id, name, phone_number, status }` (5hfCZgu5). Parol hash, komissiya va
  boshqa ichki maydonlar chiqmaydi.
- [2026-10-09] ⚠️ [order] — `POST /orders/settlement/*` (3 ta lump-sum yo'l)
  → **410 Gone** (MlVMpsfr). To'lovlar faqat kassa to'lov endpointlari
  orqali.
  → **Frontendda:** bu yo'llarga murojaatlarni olib tashlang (`/settlement`
  sahifasi allaqachon yo'q — 5a8HRZkl).
- [2026-10-09] ✏️ [integration] — `POST /integrations/:id/remittances` javobida
  yangi `data.cashbox_posted: boolean` (N3yNa6rO): kassaga yozildimi.
- [2026-10-09] ⚠️ [logistics] — `DELETE /district/:id` va `DELETE /region/:id`
  (oNAE3LW9): tumanda buyurtma/foydalanuvchi/filial bo'lsa → **400**
  (xabarda nechtasi bog'langani); viloyatda tuman, buyurtma yoki pochta bo'lsa
  → **400**; tekshiruv servisi javob bermasa → **503**.
  🆕 `POST /district/:id/merge` `{ target_district_id }` — barcha bog'liqlarni
  B tumanga ko'chirib, A ni o'chiradi; o'ziga → 400, B yo'q → 404, qoldiq
  qolsa → 409 (qayta urinish mumkin).
  → **Frontendda:** o'chirishda 400 bo'lsa "Birlashtirish" taklif qiling.
- [2026-10-09] 🆕 [identity/logistics] — Logist roli (dzyVftBx):
  - `POST /logists` (superadmin/admin) — `POST /admins` bilan bir xil tana
    (`branch_id` yo'q); `GET /logists?search=&status=&page=&limit=`;
    o'chirish — `DELETE /users/:id` (viloyatlari bo'shatiladi).
  - `PATCH /region/:id/logist` `{ logist_id: string|null }` — `null` olib
    tashlaydi, maydon yo'q → 400.
  - `POST /region/logist/bulk` `{ logist_id, region_ids[] }` — ro'yxatdagi
    viloyatlar logistga o'tadi, ro'yxatda yo'qlari undan olinadi.
  - Logist: yo'q/boshqa rol → 404, bloklangan → 400.
  - `GET /region` javobida har viloyatda `logist_id`.
  - `GET /region/stats/all`, `/region/stats/:id` — LOGIST ham ko'radi.
  → **Frontendda:** 🔧 `pages/region/pages/logist-assignment` sahifasi,
  `logist` rolini rol yorliqlari va routing'ga qo'shish.
- [2026-10-09] ✏️ [audit] — `GET /activity-logs` (2WRzdWpZ, f2Ud5tju):
  - har qatorda yangi `description` — o'zbekcha gap ("Buyurtma #7001 bekor
    qilindi"), PII'siz. Eski qatorlarda `null`.
  - `metadata` da `ip`, `user_agent`, `device_id`, `device_name`.
  - `?search=` endi `description` bo'yicha ham qidiradi.
  → **Frontendda:** 🔧 `description` ni ko'rsating, `null` bo'lsa `action`
  yorlig'i; har so'rovda `X-Device-Id` (localStorage UUID) va ixtiyoriy
  `X-Device-Name` (`encodeURIComponent`) yuboring (CORS ruxsat etilgan);
  `metadata.device_name` / `metadata.ip` chiplari.
- [2026-10-09] ✏️ [finance] — `GET /finance/cashbox/financial-balanse`:
  yangi `unappliedCarry` (ko'rsatkich, formulaga kirmaydi) (znD3KaZL).

### 2026-10-09 — Market operatorlari (i76gGjyq)

- [2026-10-09] 🆕 [identity] — **`/market-operators`** (market o'z xodimlari):
  - `GET /market-operators?search=&status=&page=&limit=` — FAQAT
    `@Roles(market)` (superadmin/admin → 403). Ko'lam DOIM JWT `sub`:
    market boshqa `market_id` yuborsa → **400**. Javob `/users` bilan bir xil:
    `data.items[]` (`id, name, phone_number, role:'market_operator', status,
    market_id, commission_type, commission_value, createdAt, updatedAt`) +
    `data.meta`. `limit` ≤ 100.
  - `POST /market-operators` `{ name, phone_number, password }` → 201. Rol doim
    `market_operator`, `market_id` = market. Tanada `market_id`/`role` → 400.
    Telefon band → 409, market bloklangan → 403.
  - `DELETE /market-operators/:id` → 200 `{ id }` (soft-delete; operator keyingi refresh'da
    chiqariladi). Begona/yo'q operator → **404**.
  - `PATCH /market-operators/:id/commission` `{ commission_type:
    'percent'|'fixed'|null, commission_value: number|null }` — percent 0..100,
    fixed 0..1 000 000, ko'pi bilan 2 kasr; `null` — tozalash. Faqat keyingi
    sotuvlarga ta'sir qiladi.
  → **Frontendda:** 🔧 `pages/market-operators/index.tsx` — ro'yxatni
  `useGetUser({role:'operator'})` (→ `/users`, market uchun 403) o'rniga
  `GET /market-operators` ga o'tkazing, `user.role === 'operator'` filtrini
  `'market_operator'` qiling (yoki olib tashlang — server allaqachon
  ko'lamlaydi); `handleCreateSubmit` qo'g'irchog'i o'rniga
  `POST /market-operators` mutatsiyasi (`buildCreateMarketOperatorPayload`
  natijasi aynan shu tana); o'chirish va komissiya UI'sini BeePost
  `client/src/pages/market-operators` dan port qiling;
  `locales/*/marketOperators.json` dagi `createUnavailable*` matnlarini va
  `endpoints.ts:38-40` dagi "no /operators route" izohini olib tashlang.

### 2026-10-09 — Bildirishnoma yadrosi (delivery, fan-out, turlar, hodisalar, Telegram relay)

- [2026-10-09] 🆕 [notification] — `GET /notifications/types` (JWT, istalgan rol):
  turlar reyestri `{ items: [{ key, category, priority, default_channels,
  group_key_pattern, label_uz, default_audience, user_can_mute }], free_prefix: 'x.',
  categories }` (Eh8y21Ha) → 🔧 inbox yorliqlari/ikonalari va sozlamalar shu
  katalogdan olinsin, qo'lda takrorlanmasin.
- [2026-10-09] ⚠️ [notification] — `POST /notifications/dispatch`: `type` endi
  reyestrda bo'lishi SHART (yoki `x.` prefiksli), aks holda 400. Admin formasi
  yuboradigan `${category}.manual` katalogda bor — o'zgarish shart emas.
  `telegram` faqat `{ market_id?, group_id?, group_type? }` — `telegram.token` → 400.
  `channels` berilmasa tur katalogidagi `default_channels` ishlatiladi.
- [2026-10-09] ✏️ [notification] — dispatch javobi: `by_channel`
  (`{ in_app, realtime?, telegram?, sms?, push?, email? }` — haqiqatan ketgan son),
  `no_provider` (masalan `['sms','email']`), `delivery.realtime`/`telegram_status`.
  Xabar: hammasi ketdi → `Notification dispatched`; bir qismi → `Partially
  dispatched`; hech bir tashqi kanal ketmadi → `Saved to inbox only — no external
  channel delivered` (uFmUS86e) → 🔧 natija oynasi `by_channel`/`no_provider` ni
  ko'rsatsin. Rol/broadcast 5000 dan oshsa 400 `fan-out cap exceeded` (avval
  jimgina kesilardi).
- [2026-10-09] ✏️ [notification] — inbox elementlarida `delivery` maydoni
  (`{ in_app: 'sent', realtime: 'emitted'|'failed', telegram: 'sent'|'failed'|'not_eligible',
  sms: 'queued'|'no_provider'|…, email: 'no_provider', push: 'queued'|… }`).
  ⚠️ `realtime: 'emitted'` = brokerga topshirildi, yetkazilgani tasdiqlanmagan.
- [2026-10-09] ✏️ [notification] — socket `notification:new`: rol/broadcast
  dispatch'da endi BITTA signal `{ type, category, priority }` (qator id'siz) →
  🔧 socket tinglansa: payload'da `id` bo'lmasa inbox va badge'ni qayta so'rang.
- [2026-10-09] ⚠️ [notification] — `POST /notifications/send`: `token` maydoni
  olib tashlandi (yuborilsa 400); REGISTRATOR faqat Elchi'da ulangan market
  guruhlariga (begona `group_id` → 403). `GET/POST/PATCH /notifications`
  javoblarida `token` va `isDeleted` YO'Q, o'rniga `has_token: boolean` (n0kLbx3d).
- [2026-10-09] 🟢 [order] — buyurtma holati o'zgarganda market (va buyurtma
  operatori) inboxiga avtomatik bildirishnoma: `order.created`, `order.accepted`,
  `order.on_way`, `order.sold`, `order.cancelled` (+ market "cancel" Telegram
  guruhi), `order.returned`, `order.not_accepted`; `link: /orders/{id}`, bitta
  buyurtma = bitta qator (`group_key order:{id}:status`) (OA16fdSq, ePpLHPX2).

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
