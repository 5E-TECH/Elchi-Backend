# Elchi Telegram boti — yadro, rollout va token aylantirish

> Kartalar: ZlpXb4Wh, Mvx0h1Fv, uCrzrElu, UQlmQiGT, GL2GgtEc, 9HIaV80X, bOMYoOtV.
> Ega qarori (2026-09-20): **bitta bot, bitta token, bitta yadro** —
> `apps/notification-service/src/bot/`.

## 1. Tuzilma

```
Telegram ──HTTPS 443──▶ Cloudflare Tunnel ──▶ api-gateway
   POST /telegram/webhook/:botSlug   (X-Telegram-Bot-Api-Secret-Token, timingSafeEqual)
        │  emit notification.telegram.webhook_update → NOTIFICATION_BOT navbati (BOT-3a), DARHOL 200
        ▼
notification-service  BotController → BotRouterService
        ├─ botSlug tekshiruvi (noto'g'ri → jim)
        ├─ my_chat_member → BotChannelService (kanal nofaol + admin inbox)
        ├─ kiruvchi cheklov: chat 20/daqiqa (telegram_rate_limits)
        ├─ ChatSequencer: chat bo'yicha ketma-ket (advisory lock, replikalararo)
        └─ handlerlar: start / group / market (+ `a:<id>` tugmalar → telegram_bot_actions)
Chiquvchi: BotOutboxService (telegram_outbox) → BotTransportService (yagona api.telegram.org nuqtasi)
```

| Jadval (notification_schema) | Vazifa |
|---|---|
| `telegram_sessions` | chat holati (PII yo'q), TTL 24 soat; `poll:<slug>` — polling offset |
| `telegram_bot_actions` | inline tugma holati, `callback_data = a:<16 belgi>` |
| `telegram_rate_limits` | kiruvchi 20/daqiqa, bog'lash kodi 5/daqiqa → 15 daqiqa blok, update dedup |
| `telegram_outbox` | chiquvchi xabarlar: 429/5xx → qayta urinish, 403/400 → dead |

Tozalash: `BotMaintenanceService` (har soat, `:17`).

**Navbatlar (BOT-3a).** Bot update'lari (gateway webhook) —
`RABBITMQ_NOTIFICATION_BOT_QUEUE` (sukut `notification_bot_queue`, o'z DLQ'si
`…_dlq`): umumiy `notification_queue` (dispatch, push) to'lqini bot javobini
kechiktirmaydi. Karta hodisalari (`notification.telegram.order_status`) ATAYLAB
umumiy navbatda qoladi — ommaviy holat o'zgarishi interaktiv bot navbatini
tiqmasin. Navbatni iste'molchi (notification-service) ham, publisher
(api-gateway bootstrap'ida `RmqService.ensureQueue`, ayni argumentlar bilan) ham
e'lon qiladi — xabar JIM tashlanmaydi, lekin navbatda `RMQ_RPC_TTL_MS` (60 s)
TTL bor va DLQ'ni hech kim qayta o'ynamaydi: iste'molchi 60 s ichida turmasa
update DLQ'ga tushadi (yo'qoladi). Update faqat consumer TTL ichida tursa
yo'qolmaydi — **deploy'da notification-service baribir BIRINCHI**. Gateway
bootstrap'idagi e'lon 5 s ulanish / 15 s umumiy chegara bilan, xato — faqat
warn (listen to'silmaydi). Readiness (`GET /health/readiness`) bot navbatini
`NOTIFICATION` qatorining `bot_queue` maydonida tekshiradi (ishlamasa qator
`down`); `scripts/rmq-cleanup-queues.sh` ham bu navbatni biladi.

## 2. Rejimlar (`TELEGRAM_BOT_MODE`, sukut `auto`)

| Holat | Natija |
|---|---|
| token yo'q / `replace_me` | `off` — hech narsa yuborilmaydi, readiness'ga ta'sir yo'q |
| token + `TELEGRAM_WEBHOOK_SECRET` | `webhook` — getUpdates HECH QACHON chaqirilmaydi |
| token, secret yo'q, `BOT_POLLING_LEADER=1` | `polling` (zaxira) — webhook o'rnatilgan bo'lsa ishga tushmaydi; 3s→60s backoff, 401/404 da to'xtaydi |
| token, secret yo'q, leader emas | `off` |
| getMe 401/404 | bot ishga tushmaydi, `bot_token_healthy=0`, `/health/readiness` → 503 (docker liveness'iga tegmaydi) |

## 3. Rollout (prod)

1. BotFather: DEV uchun **alohida** bot yarating. Privacy mode — **yoqilgan**
   (`/setprivacy` → Enable): guruhni ulash endi bir martalik deep-link
   (`t.me/<bot>?startgroup=<kod>` → guruhda `/start@bot <kod>` — buyruq,
   privacy'da ham keladi); matnli `group_token-…` olib tashlangan.
   `TELEGRAM_BOT_USERNAME` (deep link uchun) .env ga yoziladi.
2. `.env.production` (api-gateway VA notification-service bir faylni o'qiydi):
   ```
   TELEGRAM_BOT_TOKEN=<BotFather>
   TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
   TELEGRAM_BOT_SLUG=elchi
   TELEGRAM_WEBHOOK_URL=https://<api domeni>/telegram/webhook/elchi
   ```
3. Deploy (konteynerlar yangi env bilan ko'tariladi).
4. `npm run telegram:setup` — `setWebhook(url, secret_token, allowed_updates=[message, callback_query, my_chat_member])`, `setMyCommands`, `getWebhookInfo` tekshiruvi. Port ochish SHART EMAS — TLS'ni Cloudflare 443 da beradi.
5. Tekshiruv: `GET /health/readiness` → NOTIFICATION `ok`; `notification-service:3016/metrics` → `bot_token_healthy{bot="elchi"} 1`.

## 4. Token aylantirish

1. BotFather → `/revoke` (yangi token).
2. `.env.production` → `TELEGRAM_BOT_TOKEN` yangilanadi (secret ham almashtirilishi mumkin).
3. `npm run telegram:setup` — webhook yangi token bilan qayta o'rnatiladi.
4. api-gateway va notification-service restart.
5. `bot_token_healthy` = 1 ekanini tekshiring. Token hech qachon DB'ga yoki so'rov tanasiga yozilmaydi (bOMYoOtV): `telegram_markets.token` eski qiymatlari migratsiya 1716000000120 da NULL qilingan.

## 5. Inventarizatsiya — eski ikki botning har funksiyasi (ZlpXb4Wh)

| Eski joy | Funksiya | Yangi joy / holat |
|---|---|---|
| notification-bot `pollLoop` (getUpdates, 3 s cheksiz) | kiruvchi update | webhook (`telegram-webhook.controller.ts`) + zaxira polling `BotRuntimeService` (leader, backoff 3s→60s, 401 da to'xtaydi) |
| notification-bot `/id`, `/id@bot` | guruh ID | `StartHandler` (o'zgarmagan javob) |
| notification-bot `/start <token>` (shaxsiy) | akkauntni ulash (rCFZAmOz) | `StartHandler` + bog'lash kodi cheklovi 5/daqiqa → 15 daqiqa blok + activity log |
| notification-bot `/stop` | uzish | `StartHandler` (`/stop` va `/uzish`) + activity log |
| notification-bot `/start`, `/help` (guruh) | ulash ko'rsatmasi | `GroupHandler` (o'zgarmagan matn) |
| notification-bot `group_token-…` (guruh) | guruhni ulash | `GroupHandler` → `connectGroupByTokenText` (+ cheklov) |
| notification-bot `salom` | salomlashish | `StartHandler` (shaxsiy chat) |
| order-bot `pollLoop`, `ORDER_BOT_TOKEN` | ikkinchi bot | O'CHIRILDI — bitta token (`TELEGRAM_BOT_TOKEN`) |
| order-bot `TOKEN_RE` market tokeni bilan kirish + `links` Map | chat → market | TASHLANDI (ZlpXb4Wh #3): aktor `users.telegram_id` → `identity.telegram.resolve` (restartdan keyin ham) |
| order-bot `/start`, `/help` | menyu + WebApp tugmasi | `StartHandler.replyMenu` — market/operator uchun WebApp (URL ga token QO'SHILMAYDI) |
| order-bot `/status <id>`, `status <id>` | buyurtma holati | `MarketHandler`: bog'lanmagan → "avval ulang", faqat o'z marketi, yo'q/begona → bir xil "topilmadi" |
| order-bot callback `status:<id>` | tugma | `a:<action_id>` (`telegram_bot_actions`); eski format — "tugma eskirgan" |
| order-bot per-chat navbat (MAX_QUEUE 12, drain 8 s) | ketma-ketlik | `ChatSequencer` (12, drain 8 s) + replikalararo advisory lock |
| order-bot `processWithRetry` | bir marta qayta urinish | `BotRouterService.processWithRetry` |
| ikkala bot `sendMessage`/`answerCallbackQuery` (xom fetch, timeout) | chiquvchi | `BotTransportService` (timeout, 429 `retry_after`, 403 qayta urinmaslik, 4096 bo'lish, 64 bayt guard, token redaktsiya) + `telegram_outbox` |
| `sendTelegramMessage` (DB/payload token) | relay | env token, outbox; 200/202/207/502 |
| HTML escape (`escape`) | xavfsiz matn | `escapeTelegramHtml` (@app/common) |

## 6. Bog'lash va kirish (6jXw0DDr, 4TfLyTrL, 9uNhwTZp, td89SKXQ, xC88d8kH)

| Oqim | Endpoint / buyruq | Natija |
|---|---|---|
| Xodim o'z Telegram'ini ulaydi | `POST /users/me/telegram/link-code` (yoki `POST /telegram/link-code {purpose:'user'}`, eski `POST /notifications/telegram/link`) → `t.me/<bot>?start=<kod>` | bot `/start <kod>` → kod ATOMIK band → `identity.telegram.link` (band id 409, boshqa id bilan ulangan 409, nofaol/mijoz/investor 403) → `users.telegram_id`, `telegram_username`, `telegram_linked_at` |
| Market guruhini ulash | `POST /telegram/link-code {purpose:'market_group', group_type}` (market — o'zi, operator — o'z marketi, admin — `market_id`) → `t.me/<bot>?startgroup=<kod>` | guruhda `/start@bot <kod>` → `telegram_markets` qatori; mavjud ulanish ustidan yozilmaydi; marketga `telegram.group_connected` |
| Uzish | `DELETE /users/me/telegram` yoki botda `/uzish` | `telegram_id` NULL + audit |
| Statistika | `GET /telegram/stats` (admin) | rol bo'yicha `{total, linked, ratio}` |
| Mini App kirishi | `POST /auth/telegram {init_data}` | initData HMAC + `auth_date` ≤5 daqiqa → 30 daqiqalik JWT, refresh yo'q; IP + Telegram id 5/daqiqa |
| Bot amallari | `BotGatewayClient` | `identity.auth.telegram_actor` → aktor JWT → MAVJUD gateway endpointlari (RBAC bitta joyda) |

Kod: `randomBytes(32)` base64url (43 belgi), DB'da faqat SHA-256, TTL 10 daqiqa,
bir martalik; bog'lash urinishlari odam bo'yicha 5/daqiqa → 15 daqiqa blok.
`users.telegram_id` — partial unique (`UQ_ADMINS_TELEGRAM_ID`); umumiy
javoblarda yo'q (`telegram_linked` boolean).

Buyruqlar (rol reyestri, 3ZfiXuaW): umumiy `/start`, `/help`, `/uzish`;
kuryer `/ishim`, `/kun`, `/kassa`; market/operator `/status`, `/balans`.
Bog'lanmagan chat — faqat `/start` ga javob (fail-closed); rol buyrug'i
guruhda yoki boshqa rolda — rad.

## 7. Kuryer oqimi (h9newLsd, MO2MLPGo, z2FRwu2c, 4BirMSVp) va market `/balans` (VICfJuoi)

Bot HAMMA amalni aktorning O'Z JWT'si bilan MAVJUD gateway endpointlariga
yuboradi (`BotGatewayClient` → `ELCHI_GATEWAY_INTERNAL_URL`); buyurtma
bazasiga o'zi yozmaydi, doira/holat mashinasi/isbot/extra-cost — serverda.

| Buyruq / tugma | Endpoint |
|---|---|
| `/ishim` | `GET /orders?status=waiting&status=on the road&status=waiting_customer&page&limit=10` (tuman bo'yicha, "⬇️ Yana") |
| ✅ Sotildi → tasdiq → Ha | `POST /orders/sell/:id` (`proofFileKeys` isbot bilan) |
| ❌ Bekor → sabab (CancelReason enum) → Ha | `POST /orders/cancel/:id { reason }` |
| 🕗 Yetkazib bo'lmadi → sabab → Ha | `POST /orders/:id/could-not-deliver { reason }` |
| ↩️ Ortga (SOLD/CANCELLED) → Ha | `POST /orders/rollback/:id` |
| Isbot (rasm/video, ≤3, ≤20MB) | `getFile` → `POST /files/upload (folder=proof)` → kalit; `proofFileKeysVerified` bot tomonidan qo'yilmaydi |
| `/kun` | `GET /analytics/dashboard?period=today` + `GET /finance/cashbox/my-cashbox` → `notification.dispatch` (`courier.daily_report`, in-app + Telegram) |
| `/kassa` (kuryer), `/balans` (market) | `GET /finance/cashbox/my-cashbox` |

- Tugma tugmalari FAQAT o'sha holatdan mumkin bo'lganlar: WAITING → Sotildi/Bekor
  (+ 🌐 Kabinetda ochish — qisman sotuv brauzerda); ON_THE_ROAD → Yetkazib
  bo'lmadi; SOLD/CANCELLED → Ortga.
- Natija: 200 → karta tahrirlanadi (`telegram_order_cards`); 202 → "⏳ Market
  tasdig'i kutilmoqda" (karta tugmasiz); isbot talabi → isbot rejimi; holat rad →
  "Bu holatda bu amal mumkin emas".
- Avtomatik kunlik hisobot: `COURIER_DAILY_REPORT_CRON` (Asia/Tashkent, bo'sh —
  o'chiq); faqat ulangan kuryerlarga, kuniga bitta (deterministik
  `client_request_id`); botni bloklagan chat o'tkaziladi.

## 8. Qo'shimcha xarajat tasdig'i (DuST9k8j, 1tnpaIqd)

- So'rov yaratilganda order-service `order.extra_cost_requested` ni outbox
  orqali ko'taradi (best-effort — kuryerning 202 javobi o'zgarmaydi):
  market EGASIGA in-app + Telegram DM. Isbot: 1 fayl — rasm/video + izoh +
  ✅/❌ bitta postda; ko'p — albom + alohida xabarda tugmalar.
- ✅ / ❌ → `POST /orders/extra-cost-approvals/:id/approve|reject` market JWT'si
  bilan; rad etish sababi — yopiq ro'yxat (`ExtraCostRejectReason`:
  TOO_EXPENSIVE, NOT_AGREED, NO_PROOF, DUPLICATE; boshqasi 400).
- Qaror ATOMIK (`UPDATE … WHERE status='pending'`): ikki bosish / panel bilan
  bir vaqtda → bittasi o'tadi, ikkinchisi "allaqachon yakunlangan"; biznes amali
  xato bersa so'rov `pending` ga qaytadi. Qarordan keyin DM tugmalari olinadi.
- EGA QARORI — avtomatik tasdiq: `EXTRA_COST_AUTO_APPROVE_MINUTES` (bo'sh —
  o'chiq), `EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES` (sukut 10) qolganda
  eslatma (`order.extra_cost_reminder`, bir marta). Avtomatik tasdiq:
  `auto_approved=true`, `decided_by_user_id=NULL`, sabab matni, audit
  (`order.extra_cost_auto_approved`), marketga xabar. Ro'yxat filtri:
  `GET /orders/extra-cost-approvals?status=approved&auto_approved=true`;
  e'tiroz bo'lsa admin buyurtmani mavjud `POST /orders/rollback/:id` bilan
  qaytaradi. ⚠️ Xodim ishdan bo'shaganda uni Telegram guruhidan chiqarish —
  tashkiliy qadam.

## 9. Bot — bildirishnoma yadrosining TRANSPORTI (rzGKtE9N, TgYRqaTk)

- Hodisa → `outbox_events` (biznes tranzaksiyasining ICHIDA) →
  `notification.dispatch` → inbox qatori + kanallar. Bot hech qachon o'zi
  matn yasamaydi va o'z `sendMessage` yo'lini ochmaydi: TELEGRAM — yadroning
  bir kanali (`api.telegram.org` faqat `bot-transport.service.ts` da).
- Manzillash: `telegram.market_id|group_id` → market guruhi (relay);
  aks holda (faqat `recipients`) → shaxsiy chat:
  `identity.telegram.resolve_many { user_ids }` → `{ user_id: chat_id|null }`
  (FAIL-CLOSED: nofaol / ulanmagan / bitta chat bir nechta akkauntda → null).
  Ulanmagan → `delivery.telegram = skipped (no_telegram_id)`, dispatch
  yiqilmaydi. DM faqat musbat (shaxsiy) chat id ga — manfiy → `not_private_chat`.
- QAYTA YETKAZISH: `notification_schema.notification_dispatch_keys`
  (migratsiya 124) — `<type>:<request_id>` kaliti dispatch tranzaksiyasi
  ICHIDA egallanadi; takror (outbox / RMQ redelivery) → `duplicate: true`,
  ikkinchi inbox yangilanishi va ikkinchi Telegram xabari YO'Q. 7 kundan
  eski kalitlar soatlik tozalashda.
- `notification.send` (`POST /notifications/send`) — ESKIRGAN, faqat
  superadminning qo'lda guruh relay'i; servislar `notification.dispatch`.
- `NOTIFICATION_ADMIN_GROUP_ID` / `TELEGRAM_ADMIN_GROUP_ID` — ixtiyoriy
  (Joi, bo'sh env bilan boot yiqilmaydi).
- ⚠️ integration-service `sendAdminNotification` (hamkor webhook xatolari)
  hali `notification.send` + `token` bilan — hamkor/integratsiya sohasi, bu
  kartalarda O'ZGARTIRILMADI (notification tomoni tokenni baribir qabul
  qilmaydi — faqat env).

## 10. Moliya xabarlari (VICfJuoi, 2crjWf7v)

- HQ → market to'lovi (`POST /finance/cashbox/payment/market`): pul
  yozuvlari bilan AYNI tranzaksiyada `finance.payment_received` → market
  egasiga in-app + Telegram DM: summa, sana, hisob qoldig'i (oldin → keyin),
  "🌐 Kabinetda ochish" (`ELCHI_CABINET_URL` + `/cash-box`). Takroriy
  Idempotency-Key → to'lov ham, xabar ham ikkinchi marta YO'Q. `/balans` —
  market o'z FOR_MARKET kassasi (§7).
- Kuryerdan pul qabul qilish (`POST /finance/cashbox/payment/courier`,
  faqat SUPERADMIN/ADMIN/MANAGER — kuryer 403): kuryerga KVITANSIYA DM
  "✅ N so'm qabul qilindi. Qabul qildi: <xodim>. Qoldiq: M so'm" +
  "👍 Tasdiqlayman" / "❗️ Noto'g'ri". Faqat shaxsiy chat, guruhga hech qachon.
- Tugmalar KASSAGA TA'SIR QILMAYDI: bot kuryer JWT'si bilan
  `POST /finance/cashbox/payment/courier/:id/ack { ack }` → faqat
  `finance_schema.courier_payment_acks` (migratsiya 125; bir kvitansiyaga
  bitta yozuv) + audit `finance.courier_payment_ack`. "❗️" → qabul qilgan
  xodim + kuryer filiali boshlig'iga (`branches.manager_id`)
  `finance.payment_disputed`; kassa tarixi ro'yxatida `courier_ack`
  (confirmed | disputed | null) flagi.
- Kassa eslatmasi: `COURIER_CASH_REMINDER_THRESHOLD` (so'm; bo'sh — o'chiq),
  `COURIER_CASH_REMINDER_HOUR` (sukut 18, Toshkent) — chegaradan oshgan
  kuryerga kuniga BIR marta `finance.cash_reminder` (deterministik
  `client_request_id` + dispatch dedup — replika/qayta ishga tushishda takror yo'q).
- Yetkazish metrikasi ("yozildi ≠ yetadi"): `bot_dm_delivery_total{type,status}`
  (planned | skipped | no_provider | sent | failed). Dashboard paneli:
  `bot:dm_delivery_ratio:1d{type="finance.payment_received"}` (yetgan /
  navbatga qo'yilgan) va `bot:dm_reach_ratio:1d` (ulanmaganlar ham hisobda);
  alert `TelegramReceiptDeliveryLow` (< 80%) — `telegram-bot.rules.yml`.

## 11. Market guruhi kartalari va kartalarni yangilash (ysBqD9Nx, h9newLsd #5)

- Guruh — KO'RINISH joyi, qaror joyi emas: holatni o'zgartiruvchi har
  callback ODAM bo'yicha (telegram_id → user → rol/market); chat bo'yicha
  hech qachon. Guruh kartasida ✅/❌ tasdiq tugmasi YO'Q (Elchida bunday
  bosqich yo'q) — faqat "🌐 Kabinetda ochish".
- Buyurtma yaratilganda market `create` guruhlariga karta: raqam, holat,
  TUMAN (to'liq manzil emas), summa, operator; mijoz ismi/telefoni — EGA
  QARORI bo'yicha sukut ko'rinadi, market darajasida o'chiriladi
  (`admins.tg_group_show_customer_pii`, `PATCH /markets/:id/telegram-group-pii`;
  o'chiq yoki bayroq o'qilmasa — ism yo'q, telefon `+998 90 *** ** 12`).
  Ma'lumot order-service `order.telegram_card` RPC'sidan (niqoblash o'sha
  yerda — xom PII chiqmaydi).
- Holat o'zgarishi: order-service kuzatuv qatori bilan BITTA tranzaksiyada
  `notification.telegram.order_status` (outbox, fire-and-forget; HAR o'tish,
  ichki holatlar ham) → notification-service kartalarni TAHRIRLAYDI (yangi
  xabar emas): guruh kartasi — yangi ma'lumot bilan; kuryer kartasi —
  kuryerning o'z JWT'si bilan (buyurtma endi unga ko'rinmasa — tugmalar
  olinadi). Kechikish = outbox publisher sikli (soniyalar; TC: ≤ 1 daqiqa).
  Buyurtma bo'yicha advisory lock — created→new ketma-ket hodisalari ikki
  karta bermaydi. Guruhga yuborib bo'lmasa — faqat WARN (buyurtma oqimi
  allaqachon commit bo'lgan).
- Har guruh kartasi (yuborish/tahrirlash) audit izida:
  `notification.tg_group_card` (buyurtma, guruh chat_id, market, vaqt).
- `telegram_chats` (migratsiya 126) — umumlashtirilgan chat ↔ egasi jadvali
  (chat_type, owner_type, scope, is_active, linked_at, linked_by);
  `telegram_markets` yozuvlari ko'chirilgan va trigger orqali sinxron
  (bot guruhdan chiqarilsa — `is_active=false`).
- Guruhga yangi a'zo (odam) qo'shilsa — market egasiga
  `telegram.group_member_joined` (in-app + Telegram DM) + audit
  `notification.tg_group_member_joined`.
- ⚠️ TASHKILIY QADAM: xodim ishdan bo'shaganda uni market Telegram
  guruhidan CHIQARISH — guruh a'zoligi Elchi nazoratidan tashqarida
  (keyin qo'shilgan odam eski xabarlarni ham o'qiy oladi).

## 12. AI orqali buyurtma (e7KhaeOO) — bot faqat CHAQIRUVCHI

- Market / market operatori shaxsiy chatda buyruq emas MATN (telefon raqami
  bor — kamida 7 ta raqam) yoki RASM tashlaydi → `POST /orders/ai-parse`
  (operatorning o'z JWT'si; ekstraksiya ai-service'da, botda YO'Q) →
  preview kartasi: ✅ Yaratish / ✏️ Tuzatish / ❌ Bekor.
- ✅ → `POST /orders/ai-confirm` — faqat tayyor buyurtmalar (kamchiligi
  narxni tasdiqlash yoki katalogda yo'q mahsulot bo'lsa — nomi bilan;
  tuman/telefon/ism yo'q bo'lsa — kabinetda). `market_id` YUBORILMAYDI:
  server operatorning `user.market_id` sidan oladi. Dublikat himoyasi:
  qoralama `preview → creating` shartli UPDATE (ikki bosish — bitta
  chaqiruv) + server `ai:<market>:<draft>:<index>` kaliti.
- Qoralama DB'da (`telegram_ai_drafts`, migratsiya 128; 24 soat, keyin
  soatlik tozalashda o'chadi — matnda mijoz PII si bor). Deploy/restartdan
  keyin eski tugma ishlaydi; muddati o'tgan — "⏳ Bu ro'yxat eskirgan".
- AI javob bermasa — server matni + "🔁 Qayta urinish" (saqlangan matn /
  file_id bilan, qoralama yo'qolmaydi); `disabled` / `cap_exceeded` /
  `refused` — "🌐 Kabinetda yaratish".
- Media: rasm 2MB gacha (ai-parse chegarasi) — limit ostidagi eng katta
  o'lcham; hujjat faqat JPG/PNG ≤2MB; HEIC / webp / katta → yo'naltiruvchi
  matn, AI CHAQIRILMAYDI.
- Navbat: chat bo'yicha ChatSequencer (DB advisory lock, ko'p replikada
  tartib), ≤12 — to'lsa "⏳ Juda ko'p xabar navbatda". Har rasm/matn — o'z
  qoralamasi (ustma-ust yozilmaydi). Foydalanuvchi bo'yicha AI limiti —
  gateway `ai-user` throttler (429 → "🔁 Qayta urinish").

## 13. Skan Mini App (MWYaqprw) — chatda skan YO'Q

- `TELEGRAM_SCAN_WEBAPP_URL` (https, ixtiyoriy) — berilsa kuryer `/ishim` ning
  sarlavha xabarida «📷 Skaner» `web_app` tugmasi chiqadi (faol topshiriq yo'q
  bo'lsa ham). URL'ga token QO'YILMAYDI: Mini App initData bilan `POST
  /auth/telegram` dan JWT oladi (imzo tekshiriladi). Frontend `/tg/scan`
  chiqmaguncha bo'sh qoldiriladi.
- `POST /orders/scan-assign` javobida `data.order` (tuman, mijoz, summa) —
  `order.find_by_qr_light` dan; qidiruv yiqilsa skan javobi o'zgarmaydi.
- «✅ Tayyor» → `POST /telegram/scan/done { order_ids }` (faqat kuryer) →
  notification-service `notification.telegram.scan_done`: son SERVERDA —
  yuborilgan id'lardan faqat HOZIR shu kuryerda `on the road` turganlari
  (`order.find_all`); xabar `notification.dispatch` (in-app + shaxsiy
  Telegram) bilan, «📋 Topshiriqlarim» = `/ishim` 1-sahifa.
- Ega qarori (2026-09-20) kuchda: skan chat orqali qilinmaydi.
