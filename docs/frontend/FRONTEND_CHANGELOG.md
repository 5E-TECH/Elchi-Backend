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
