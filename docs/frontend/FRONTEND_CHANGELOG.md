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
