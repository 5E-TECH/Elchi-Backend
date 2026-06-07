# Elchi Backend — Audit & Hardening Log

> **Maqsad.** Har bir servisni birma-bir **audit + test + check** qilish jarayonining
> yagona jurnali. Har topilgan kamchilik (severity bilan), tuzatish va yangi
> funksiya shu yerda yoziladi. Frontend'ga taalluqli o'zgarishlar
> [`docs/frontend/FRONTEND_CHANGELOG.md`](../frontend/FRONTEND_CHANGELOG.md) ga ham yoziladi.
>
> **Severity:** 🔴 P0 (pul/ma'lumot yo'qolishi, xavfsizlik teshigi, ishlamaydigan flow) ·
> 🟠 P1 (jiddiy bug, noto'g'ri natija, yetishmayotgan validatsiya) ·
> 🟡 P2 (texnik qarz, kichik bug, UX/DX yaxshilash) · 🟢 INFO (kuzatuv/tavsiya).
>
> **Status belgilari:** ☐ ochiq · ⏳ jarayonda · ✅ tuzatilgan · ⏭️ keyinga qoldirilgan.

---

## 0. Audit baseline (2026-06-06)

- **Servislar:** 14 + API Gateway + `libs/common`.
- **Test baseline:** `npx jest` → **179 testdan 145 o'tdi, 34 fail (2 suite)**.
  - 🟠 `apps/branch-service/src/branch-service.service.spec.ts` — testда `ConfigService`
    provide qilinmagan; konstruktordagi `config.get(...)` `undefined`da yiqiladi.
    *(branch-service auditida tuzatiladi.)* — ☐
  - 🟠 `apps/integration-service/src/integration-service.webhook.spec.ts` — fail.
    *(integration-service auditida tekshiriladi.)* — ☐
- **Test qoplamasi (spec fayllar):** order(8), gateway(7), identity(2), integration(2),
  logistics(2), analytics/branch/file/finance/notification(1), **catalog/c2c/investor/search(0)**.

---

## Servislar bo'yicha audit

### api-gateway — 2026-06-07 (RBAC guard qamrovi)

**Audit qamrovi:** barcha gateway controller'larining route↔`@Roles` qamrovi skanerlandi.
Heuristika (route soni vs @Roles soni) ishonchsiz — ko'p route ikki yo'lli (alias path)
decorator ishlatadi (1 metod, 2 path, 1 @Roles), bu false-gap beradi. Qo'lda tasdiqlandi:
- ✅ **investor-gateway** — barcha 16 metod `@Roles(SUPERADMIN, ADMIN)` (false-gap'lar alias edi).
- ✅ **analytics** — moliyaviy route'lar tuzatildi (yuqoriga qarang).

**Topilmalar:**
- 🔴 **P0** [✅ **TUZATILDI** 2026-06-07] **Avtorizatsiyasiz order update (pul-ta'sirli write).**
  `PATCH /orders/:id` va `/orders/:id/full` faqat `@UseGuards(JwtAuthGuard)` edi → istalgan
  login qilgan user istalgan order'ning `total_price`/`paid_amount`/`status`/`courier_id`ni
  o'zgartira olardi (updateFull rol enforce qilmaydi). **Yechim:** ikkala gateway route'ga
  `@Roles(SUPERADMIN, ADMIN, REGISTRATOR)` + `RolesGuard` (foydalanuvchi qarori). **Service'ga
  ATAYLAB tegilmadi:** `updateFull` ichki shared metod — sell/cancel/return oqimlari va
  finance/branch/logistics cross-service `order.update_normalized` orqali (kuryer/trusted
  requester bilan) chaqiradi; service'da enforce qilish ichki sell oqimini buzardi. To'g'ri
  qatlam = gateway HTTP guard (ichki RMQ trusted qoladi). — `order-gateway.controller.ts:1407,1436`
- 🟡 P2 [☐] **Order read route'lari `@Roles`siz** (`findAll`, `findById`, `getTracking`,
  `findAllByMarket`, `findNewMarkets`, ...). Operatsion ma'lumot, ehtimol ataylab ochiq, lekin
  service requester bo'yicha scoping qiladimi — tekshirish kerak (courier hamma order'ni
  ko'rmasligi uchun). — `order-gateway.controller.ts`
- 🟢 INFO [☐] **Tizimli gateway RBAC auditi tavsiya etiladi:** har route uchun "kim kira oladi +
  service scoping bormi" ni qo'lda ko'rib chiqish (heuristika yetarli emas). Bu alohida fokuslangan
  bosqich sifatida qilinsa yaxshi.

**Frontend ta'siri:** order update P0 tuzatilsa, ba'zi rollar `PATCH /orders/:id`da 403 oladi
— qaror qabul qilingach FRONTEND_CHANGELOG'ga yoziladi.

**Yakun:** 🔴P0 order update avtorizatsiya ✅ tuzatildi (gateway `@Roles(SUPERADMIN, ADMIN,
REGISTRATOR)`, 229 test yashil). 🟡P2 order read scoping + tizimli gateway RBAC auditi keyingi
bosqichga qoldirildi.

---

<!-- Har servis uchun shablon:
### <service-name> — <sana>
**Audit qamrovi:** <qaysi fayllar>
**Topilmalar:**
- 🔴/🟠/🟡 [STATUS] <tavsif> — `fayl:satr`
**Tuzatishlar:** ...
**Yangi funksiyalar:** ...
**Test:** <qo'shilgan testlar / natija>
**Check:** build/lint natijasi
**Frontend ta'siri:** <bor/yo'q — FRONTEND_CHANGELOG'ga yozildi>
-->

### libs/common — 2026-06-06

**Audit qamrovi:** `rmq/` (execute-and-ack, rmq-client, rmq.service), `idempotency/`
(service, helper, entity), `outbox/` (publisher), `security/ssrf.ts`, `webhook/hmac.ts`,
`database/numeric.transformer.ts`. Umumiy baho: **kutubxona yaxshi mustahkamlangan** —
SSRF guard (fail-closed, IPv4/IPv6, IP-obfuscation himoyasi) va HMAC (constant-time,
key-rotation) test bilan qoplangan va sifatli. RMQ smart-nack/DLQ topologiyasi to'g'ri.

**Topilmalar:**
- 🟠 P1 [✅ **TUZATILDI** 2026-06-06] **Idempotency `in_progress` stuck-key (lease yo'q).**
  `IdempotencyKey` entity'da lease/expiry ustuni yo'q. Agar worker ish o'rtasida
  (insert→markCompleted oralig'ida) crash qilsa, kalit abadiy `in_progress` qoladi. Har
  qayta-yetkazib berishda `executeIdempotent` `nack(requeue:true)` qiladi → RMQ hot-loop
  (faqat `RMQ_RPC_TTL_MS`=10s messageTtl→DLQ bilan cheklangan), va o'sha `request_id`
  abadiy "zaharlanadi". Hozir faqat order-service ishlatadi (pul operatsiyalari!). —
  `idempotent-execute.helper.ts:50-53`, `idempotency-key.entity.ts`, `idempotency.service.ts`
  - **Yechim:** `IdempotencyService.tryAcquire`ga **stale-lease reclaim** qo'shildi
    (`DEFAULT_IDEMPOTENCY_LEASE_MS = 30s`, har chaqiruvda override mumkin). `in_progress`
    qator lease'dan eski bo'lsa, keyingi chaqiruvchi uni atomik `UPDATE ... WHERE
    status='in_progress' AND created_at < cutoff SET created_at=now()` bilan qayta egallaydi
    (faqat bitta race g'olibi, qolganlari `in_progress` ko'radi). DB migratsiyasi shart emas
    (mavjud `created_at` ustunidan foydalanadi). — `idempotency.service.ts:44-96`
  - **Test:** 7 ta yangi unit test (`idempotency.service.spec.ts`): fresh/cached/failed/
    fresh-lease/stale-reclaim/race-loser/non-unique-error. `npx jest libs/common` → 27/27 ✅.
    `nest build order-service` ✅, lint 0 error.
- 🟡 P2 [☐] **`prune` hech qayerda rejalashtirilmagan.** `IdempotencyService.prune`,
  `OutboxService.pruneOldPublished`, `ActivityLogService.prune` mavjud, lekin hech qaysi
  servisda cron/interval bilan chaqirilmaydi → `idempotency_keys`, `outbox_events`,
  `activity_log` jadvallari cheksiz o'sadi. — `idempotency.service.ts:79`,
  `outbox.service.ts:94`, `activity-log.service.ts:117`
- 🟢 INFO [☐] `rmqSend` default timeout (5s) × retries(2) = 15s, gateway timeout esa 8s.
  Service retry tugamasdan gateway timeout bo'lishi mumkin (faqat latency, data-loss emas).
  Kuzatuv sifatida qoldirildi.

**Frontend ta'siri:** Yo'q (ichki infratuzilma). FRONTEND_CHANGELOG'ga yozilmadi.

**Yakun:** P1 ✅ tuzatildi (lease/reclaim + 7 test). P2 (prune cron) va INFO ⏭️ keyinga
qoldirildi (foydalanuvchi qarori: faqat P1).

---

### identity-service — 2026-06-06

**Audit qamrovi:** `auth/auth.service.ts`, `user-service.service.ts` (1423 satr),
`identity.controller.ts`, `entities/user.entity.ts`, DTO'lar (`create-courier`,
`create-market`, ...). Umumiy baho: **auth qatlami juda yaxshi** — refresh-token reuse
detection + session invalidation, SHA-256 refresh hash, user-enumeration himoyasi (login
xatolar bir xil 401), bcrypt parol. Controller toza thin pass-through (`executeAndAck`).
DTO'lar class-validator bilan to'liq qoplangan. RBAC requester-asoslangan helperlar mavjud.

**Topilmalar:**
- 🟠 P1 [✅ **TUZATILDI** 2026-06-06] **Manager `FOR_COURIER` cashbox oladi.**
  `createManager` aniq `ensureUserCashbox(saved.id, Cashbox_type.FOR_COURIER)` chaqiradi,
  lekin `roleToCashboxType(MANAGER)` → `null` qaytarib, ziddiyat yaratardi.
  **Domen qarori (foydalanuvchi):** manager amalda kuryer kabi pul yig'adi → `FOR_COURIER`
  **to'g'ri**. **Yechim:** `roleToCashboxType` MANAGER'ni ham `FOR_COURIER`ga map qiladigan
  qilib moslandi (ziddiyat yo'qoldi, izoh qo'shildi). — `user-service.service.ts:432-441`
- 🟡 P2 [✅ **TUZATILDI** 2026-06-06] **Avtorizatsiya assimetriyasi (defense-in-depth).**
  `createCourier`/`createManager`/`createMarket` endi service-darajasida requester-rol
  tekshiruvini bajaradi (gateway `@Roles` ni aks ettiradi: courier/market = SUPERADMIN|ADMIN|
  MANAGER, manager = SUPERADMIN|ADMIN; `requester` yo'q = ishonchli ichki chaqiruv, ruxsat).
  `createMarket`ga `requester` payload orqali ulandi (gateway `toRequester(req)` yuboradi).
  `createCustomer` ataylab tashqarida qoldirildi (gateway route yo'q, order oqimidan ichki
  chaqiriladi). — `user-service.service.ts:185-253,975`, `api-gateway.controller.ts:849-864`
- 🟡 P2 [✅ **TUZATILDI** 2026-06-06] **Customer avto-parol `Math.random()` bilan.**
  `randomBytes(12).toString('hex')` ga o'zgartirildi (crypto-strong). —
  `user-service.service.ts:1110`
- 🟢 INFO [☐] **Saga gap:** `createMarket/createCourier/createManager` user'ni saqlab,
  keyin cashbox yaratadi; cashbox xatosi (≠"already exists") bo'lsa user cashbox'siz qoladi
  (branch-assign'dan farqli — kompensatsiya yo'q). Keyin tiklasa bo'ladi. — `:947,986,1023`
- 🟢 INFO [☐] `user.entity` `salary` decimal'ida inline transformer, `commission_value`'da
  esa shared `numericTransformer` — nomuvofiqlik (kosmetik). — `entities/user.entity.ts:36-46`
- 🟢 INFO [☐] **Pre-existing lint qarzi:** `user-service.service.ts` va
  `api-gateway.controller.ts` da ~180+ `no-unsafe-*` / `no-unsafe-enum-comparison` /
  unused-var eslint xatosi (audit o'zgarishlaridan oldin ham bor edi, men tegmagan satrlarda).
  Kelajakda tozalash uchun qayd etildi.

**Test:** +1 yangi spec `user-service.rbac.spec.ts` (7 test: RBAC forbidden/allow +
roleToCashboxType). identity-service jami **16/16 o'tadi**. `nest build identity-service` +
`nest build api-gateway` ✅.

**Frontend ta'siri:** 🟢 INFO — kontrakt o'zgarmadi. Manager cashbox `FOR_COURIER` ekani
**tasdiqlandi** (finance UI'da manager cashbox'ini kuryer turi sifatida ko'rsatish to'g'ri).
FRONTEND_CHANGELOG'ga info yozildi.

**Yakun:** P1 + ikkala P2 ✅ tuzatildi (foydalanuvchi: uchalasi). INFO'lar keyinga qoldirildi.

---

### order-service (yadro) — 2026-06-06

**Audit qamrovi:** entity'lar (`order` 194 satr, `order_settlement`, `order-tracking`,
`custody-event`, transfer-batch); `order-service.service.ts` (**7968 satr**) — pul yadrosiga
fokuslangan: settlement helperlar (`resolveBranchShare`, `resolveCourierShare`,
`recordSaleSettlement`, `resetSettlementOnRollback`, `runFifoSettlement`, `settle*`),
`sellOrder`, `updateCashboxBalance`. Umumiy baho: **pul oqimi juda yuqori sifatli** —
ajratilgan (decoupled) COD legs, `Math.max(…,0)` clamp, atomik tranzaksiya + transactional
outbox, per-attempt `dedup_epoch` (sell→rollback→sell qayta-qo'llanadi), settlement-aware
rollback (HQ'ga yetgach taqiqlanadi), proof enforcement, `paidAmount` validatsiyasi.
Mavjud **8 spec / 36 test — hammasi yashil**.

**Topilmalar:**
- 🟡 P2 [✅ **TUZATILDI** 2026-06-07] **Pul ustunlari `orders` jadvalida `float` edi.**
  `total_price`, `market_tariff`, `courier_tariff`, `courier_share`, `branch_share` —
  `float`, ammo `order_settlement` ayni qiymatlarni `numeric(14,2)` saqlardi. Analitikada
  `COALESCE(SUM(order.total_price),0)` (satr 2762) float8 agregatsiyasi → drift riski.
  **Yechim:** (1) entity'da beshala ustun `numeric(14,2)` + `numericTransformer`ga
  o'tkazildi (JS hali ham `number`, API kontrakti o'zgarmaydi); (2) yangi migratsiya
  `1716000000004-OrderMoneyColumnsToNumeric.ts` (`ALTER COLUMN ... TYPE numeric(14,2)
  USING ...`, qiymatlar saqlanadi, re-runnable, down() bilan). — `entities/order.entity.ts`,
  `migrations/1716000000004-*.ts`
- 🟢 INFO [☐] **Qamrov cheklovi:** 7968 satrli servisning pul yadrosi chuqur tekshirildi,
  ammo har bir oqim (cancel, partlySell, external orders, transfer-batch orchestration,
  analytics 15+ method) line-by-line ko'rilmadi. Mavjud testlar kuchli; kerak bo'lsa
  alohida chuqur audit pass qilinadi.

**Frontend ta'siri:** 🟢 INFO — API'da `total_price` va tariflar hali ham `number` qaytadi
(transformer) — kontrakt **o'zgarmadi**. Faqat backend aniqligi yaxshilandi. FRONTEND_CHANGELOG'ga
info yozildi.

**Yakun:** 🟡P2 float→numeric ✅ tuzatildi (migratsiya + entity + 36 test yashil). 🟢INFO
chuqur-qamrov keyinga qoldirildi (foydalanuvchi: hozircha yetarli). ⚠️ Deploy'da
`npm run migration:run` kerak (yangi migratsiya).

---

### analytics / catalog / notification / file / search / c2c — 2026-06-07 (parallel audit)

> Qolgan 6 servis parallel Explore-agentlari bilan auditlandi; da'volar **qo'lda
> tasdiqlandi** (ba'zilari false-positive bo'lib chiqdi — pastda belgilangan).

**analytics-service** (aggregator, no DB):
- 🔴 **P0** [✅ **TUZATILDI** 2026-06-07] **Moliyaviy hisobotlar avtorizatsiyasiz edi.**
  Gateway'da `/analytics/reports/finance`, `/revenue`, `/kpi`, `/reports/orders`
  faqat `@UseGuards(JwtAuthGuard)` — `@Roles` yo'q edi; service `requester`ni ishlatmasdi
  (`_requester`). Natija: **istalgan login qilgan user** kompaniya moliyasini ko'rardi.
  **Yechim (ikki qatlam):** (1) gateway'da o'sha 4 route'ga `@Roles(SUPERADMIN, ADMIN)` +
  `RolesGuard`; (2) service'da `assertFinancialAccess(requester)` helper — 4 metod boshida
  enforce qiladi (defense-in-depth, RMQ entrypoint'da ham). **Foydalanuvchi qarori:** faqat
  SUPERADMIN+ADMIN. +5 test (4 forbid-403 + 1 allow-admin). —
  `analytics-gateway.controller.ts:61,92,117,142`, `analytics-service.service.ts:46-61`
- 🟠 P1 [✅ **TUZATILDI** 2026-06-07] **Fan-out resilience.** 5 ta asosiy fan-out
  (revenue, kpi, orders report + dashboard courier/market/general) elementlariga
  `.catch(() => null)` qo'shildi → bitta downstream timeout butun hisobot/dashboard'ni
  yiqitmaydi (downstream `unwrap`/`?.`/`parseNumber` null'ni ishlaydi). finance report
  allaqachon himoyalangan edi. Ichki `.map` fan-out'lar (collectOrders/countOrders) helper'lar
  bilan ishlaydi — keyinroq. — `analytics-service.service.ts:333,364,399,441,471,558`
- 🟡 P2 [☐] Moliyaviy yig'indilar JS'da `reduce(+)` float bilan (analytics DB'siz, lekin
  hisobotda drift). N+1 rmqSend per courier (concurrency limit yo'q).

**catalog-service** (0 test):
- 🟡 P2 [☐] `delete_by_market` requester/ownership tekshiruvi yo'q (RMQ-internal; identity
  deleteMarket chaqiradi — gateway to'g'ridan ochmaydi, lekin defense-in-depth yo'q).
- 🟡 P2 [☐] Controller DTO'lari validatsiyasiz (gateway ValidationPipe bor, lekin service
  darajasida yo'q). — `catalog-service.controller.ts:31,39,55`

**notification-service** (1 test):
- 🟡 P2 [☐] Bot polling `fetch` AbortController timeout'i yo'q → osilib qolish mumkin.
- 🟡 P2 [☐] `connectGroupByTokenText` error'da `{message}`, success'da `{statusCode,message,data}`
  qaytaradi — TYPE nomuvofiq (lekin `.message` ikkisida ham bor, runtime bug EMAS).
- ❌ FALSE-POSITIVE: agent "isDeleted maydoni yo'q" dedi — `isDeleted` **BaseEntity'dan keladi**,
  mavjud. "result.message undefined on success" ham noto'g'ri (successRes message'ni o'z ichiga oladi).

**file-service** (1 test): upload validatsiyasi kuchli (magic bytes + MIME + size).
- 🟠 P1 [✅ **TUZATILDI** 2026-06-07] `read()` butun faylni xotiraga base64 qilardi — katta
  faylda OOM/DoS. **Yechim:** `transformToByteArray()`dan oldin `response.ContentLength`
  tekshiriladi; `maxVideoSizeBytes` (50MB)dan oshsa 400 qaytaradi (xotiraga olishdan oldin).
  build + 9 test ✅. — `file-service.service.ts:386`
- 🟡 P2 [☐] `FILE_MAX_VIDEO_SIZE_MB` Joi schema'da yo'q (silent 50MB fallback). Fayl key'lariga
  ownership tekshiruvi yo'q (caller identity'ga ishonadi).

**search-service** (0 test): asosan toza — query parametrlangan (injection yo'q), pagination
50 bilan cheklangan, unique index bor.
- 🟡 P2 [☐] upsert find→save orasida TOCTOU race (unique constraint ushlaydi, lekin DLQ'ga ketadi).
- 🟡 P2 [☐] upsert `content`/`tags` uzunlik validatsiyasi yo'q.

**c2c-service** (0 test, **DORMANT** — gateway'ga ulanmagan, controller `notImplemented()`
qaytaradi, service bo'sh skeleton):
- 🟡 P2 [☐ — keyinga] `listing.price`/`c2c_order.price` float (gateway'ga ulashdan oldin
  numeric'ga o'tkazish kerak). Review rating 1–5 constraint yo'q, FSM/escrow/auth yo'q —
  hammasi c2c'ni aktivlashtirishdan oldin. Hozir dormant bo'lgani uchun risk yo'q.

**Frontend ta'siri:** analytics P0 tuzatilsa, ba'zi rollar moliyaviy hisobotlarga kira olmay
qoladi (403) — front shuni hisobga olishi kerak (FRONTEND_CHANGELOG'ga yoziladi).

**Yakun:** 🔴P0 analytics moliyaviy leak ✅ (gateway @Roles + service enforce + 5 test),
🟠P1 analytics resilience ✅ (6 fan-out .catch), 🟠P1 file OOM ✅. Qolgan P2'lar (catalog DTO/
ownership, notification timeout, search TOCTOU, c2c dormant) AUDIT_LOG'da — keyingi bosqich.
To'liq suite **229 test yashil**.

---

### investor-service — 2026-06-07

**Audit qamrovi:** entity'lar (investor, investment, profit_share), service (601 satr),
`calculateProfit` pul mantiqi. Baho: **toza** — pul ustunlari allaqachon `numeric(14,2)` +
`numericTransformer` (PCS ishi). `calculateProfit` percentage 0–100 va period validatsiya,
`.toFixed(2)` yaxlitlash, SQL `SUM`.

**Topilmalar:** money/correctness topilmasi yo'q.
- 🟢 INFO [✅] **0 test edi → +6 test.** `investor-service.calculate-profit.spec.ts`:
  percentage/period validatsiya + profit math (amount = total×pct/100, yaxlitlash, 0-invest).
  investor-service'ning birinchi test qoplamasi. 6/6 ✅.

**Frontend ta'siri:** yo'q.

---

### logistics-service — 2026-06-07

**Audit qamrovi:** entity'lar (region, district, post), `logistics-service.service.ts`
(2795 satr — geo/SATO + post boshqaruvi), mavjud 2 spec. Geo qismi (SATO matcher) toza.

**Topilmalar:**
- 🟡 P2 [✅ **TUZATILDI** 2026-06-07] **`posts.post_total_price` float edi.** Post (kuryer
  yetkazish to'plami) order narxlari yig'indisi; `post_total_price + delta` bilan to'planadi
  → float drift. order.total_price endi numeric, izchillik uchun bu ham `numeric(14,2)` +
  `numericTransformer`ga o'tkazildi + migratsiya `1716000000006`. (Float→numeric initsiativasi
  davomi — foydalanuvchi order/finance uchun tasdiqlagan.) — `entities/post.entity.ts`,
  `migrations/1716000000006-*.ts`

**Frontend ta'siri:** 🟢 INFO — `post_total_price` hali ham `number` (kontrakt o'zgarmadi).

**Yakun:** 🟡P2 ✅ (post_total_price → numeric, 11 test yashil). Boshqa topilma yo'q.

---

### integration-service — 2026-06-07

**Audit qamrovi:** entity'lar (provider-receivable/remittance/shipment, external-integration),
`integration-service.service.ts` (2716 satr), webhook spec. Umumiy baho: xavfsizlik kuchli —
AES-256 kredensiya shifrlash (`createCipheriv` + key rotation `previousKey`), SSRF guard
(`assertPublicUrl`), HMAC webhook verifikatsiya (test bilan). `provider_receivable/remittance`
`amount` `numeric(14,2)` va ataylab `string` deb tiplangan, `Number()`/`.toFixed(2)` bilan
qo'lda konvertatsiya + SQL `SUM` — izchil va to'g'ri (transformer'siz yondashuv).

**Topilmalar:**
- 🟠 P1 [✅ **TUZATILDI** 2026-06-07] **Buzilgan webhook unit suite (baseline fail).**
  Ikki sabab: (1) spec `provider-receivable`/`provider-remittance` entity'larini mock
  qilmagan → `@app/common` mock'ida `BaseEntity` yo'qligi sbabli `Class extends undefined`
  (suite umuman yuklanmасdi); (2) konstruktorga `receivableRepo`+`remittanceRepo` (6-7 arg)
  qo'shilgani uchun spec'ning `new(...)` chaqiruvi siljigan → `activityLog.log undefined`
  (12 test fail). **Yechim:** ikki entity mock + ikki repo mock to'g'ri tartibda qo'shildi →
  **33/33 o'tadi**. — `integration-service.webhook.spec.ts`
- 🟢 INFO [☐] `provider_receivable/remittance.amount` string+manual konvertatsiya ishlatadi,
  qolgan kod `numericTransformer`→number. Izchillik uchun keyin birlashtirish mumkin (hozir to'g'ri).

**Frontend ta'siri:** yo'q.

**Yakun:** 🟠P1 (buzilgan suite) ✅ tuzatildi. Xavfsizlik/pul mantiqida yangi topilma yo'q.

---

### branch-service — 2026-06-07

**Audit qamrovi:** entity'lar (`branch`, `branch_config`, `branch_user`),
`branch-service.service.ts` (3084 satr — orkestratsiya: tree, transfer-batch, config,
dashboard). Umumiy baho: toza. `branch.per_order_share` allaqachon `numeric(14,2)`,
`branch_config`/`branch_user` da pul ustuni yo'q. Cross-service chaqiruvlar (finance/file)
to'g'ri timeout + error-handling bilan o'ralgan.

**Topilmalar:**
- 🟠 P1 [✅ **TUZATILDI** 2026-06-07] **Buzilgan unit test (baseline fail).**
  `branch-service.service.spec.ts` konstruktorga 8 arg berardi, ammo konstruktorga
  `FINANCE` client qo'shilib 9 arg bo'lgan → `configService` `financeClient` o'rniga tushib,
  `config.get` undefined'da yiqilardi (34 test fail). **Yechim:** spec'ga `financeClient`
  mock qo'shildi va to'g'ri tartibda berildi → **34/34 o'tadi**. — `branch-service.service.spec.ts`

**Frontend ta'siri:** yo'q.

**Yakun:** 🟠P1 (buzilgan test) ✅ tuzatildi. Servisning o'zida yangi money/correctness
topilmasi yo'q (orkestratsiya, yaxshi qoplangan).

---

### finance-service — 2026-06-07

**Audit qamrovi:** entity'lar (`cashbox`, `cashbox_history`, `financial_balance_history`,
`shift`, `user_salary`, `operator_*`), `finance-service.service.ts` (2428 satr) — balans
yadrosi: `updateBalancesByMethod`, `normalizeBalance`, `updateBalance`, `createCashbox`.
Umumiy baho: balans mantiqi puxta — idempotency guard (`IDX_CASHBOX_HISTORY_IDEMPOTENT` +
`dedup_epoch`), market/courier uchun negativ balansga ruxsat (qarz modeli), invariant
skript (`db:check-cashbox`) mavjud.

**Topilmalar:**
- 🟠 P1 [✅ **TUZATILDI** 2026-06-07] **Legacy float pul ustunlari (butun money yadrosi).**
  `cashboxes` (`balance`, `balance_cash`, `balance_card`), `cashbox_history` (`amount`,
  `balance_after`, `balance_cash_after`, `balance_card_after`), `financial_balance_history`
  (`amount`, `balance_before`, `balance_after` — **running P&L ledger!**), `shift`
  (8 ta balans ustuni) — barchasi `float` edi. `updateBalancesByMethod` har tranzaksiyada
  float `+=` qilardi → drift to'planadi; ledger `balance_after=before+amount` → P&L buziladi.
  `check-cashbox-invariant.ts` buni EPSILON bilan yashirardi. **Yechim:** (1) 4 entity'da
  18 ustun `numeric(14,2)` + `numericTransformer`ga o'tkazildi (`user_salary`/`operator_*`
  bilan bir xil; API `number`); (2) migratsiya `1716000000005-FinanceMoneyColumnsToNumeric.ts`
  (helper bilan up/down, `USING ::numeric(14,2)`, re-runnable); (3) invariant izohi yangilandi
  (EPSILON=0.01 endi faqat tarixiy cast yaxlitlashni yutadi, doimiy drift emas). —
  `entities/{cashbox,cashbox-history,financial-balance-history,shift}.entity.ts`,
  `migrations/1716000000005-*.ts`, `scripts/check-cashbox-invariant.ts`

**Frontend ta'siri:** 🟢 INFO — API hali ham `number` qaytaradi (transformer), kontrakt
o'zgarmadi. FRONTEND_CHANGELOG'ga info yozildi.

**Yakun:** 🟠P1 ✅ tuzatildi (4 entity + migratsiya + invariant izoh, finance 19 test yashil,
to'liq suite regresssiz). ⚠️ Deploy'da `npm run migration:run` kerak. Migratsiyadan keyin
`npm run db:check-cashbox` bilan invariant tekshirilsin.

> **PRECISION TUZATISH (2026-06-07, deploy fail'dan keyin):** finance pul ustunlari dastlab
> `numeric(14,2)` (max ~1e12) edi — bu **kümülatif** qiymatlar (cashbox balanslar, P&L ledger
> running total) UZS'da 1 trillion'dan oshib `ALTER ... USING ::numeric(14,2)` **overflow**
> berib, migratsiya (va deploy) fail bo'lishiga sabab bo'ldi. **Yechim:** finance ustunlari
> `numeric(20,2)` (max ~1e18) ga oshirildi (migratsiya 005 + 4 entity). Per-order ustunlar
> (order 004, logistics 006) `numeric(14,2)` da qoldi — ular bitta order/post, overflow yo'q.
