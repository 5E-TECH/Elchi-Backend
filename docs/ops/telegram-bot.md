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
        ├─ ChatSequencer: chat bo'yicha ketma-ket (BOT-3b: `telegram_chat_locks` lease, ulanish ushlanmaydi)
        └─ handlerlar: start / group / market (+ `a:<id>` tugmalar → telegram_bot_actions)
Chiquvchi: BotOutboxService (telegram_outbox) → BotTransportService (yagona api.telegram.org nuqtasi)
```

| Jadval (notification_schema) | Vazifa |
|---|---|
| `telegram_sessions` | chat holati (PII yo'q), TTL 24 soat; `poll:<slug>` — polling offset |
| `telegram_bot_actions` | inline tugma holati, `callback_data = a:<16 belgi>` |
| `telegram_rate_limits` | kiruvchi 20/daqiqa, bog'lash kodi 5/daqiqa → 15 daqiqa blok, update dedup |
| `telegram_outbox` | chiquvchi xabarlar: 429/5xx → qayta urinish, 403/400 → dead; `notification_ids` — yakuniy holatni shu inbox qatorlariga yozadi (BOT-3c) |
| `telegram_blocked_chats` | botni bloklagan shaxsiy chatlar — MUDDATSIZ (BOT-3c), `member` / `/start` da o'chadi |

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
**Guruh holati (BOT-3 #6).** Guruh supergroup'ga aylansa (`migrate_to_chat_id`
— yuborish javobida yoki eski guruhdagi servis xabarida) `telegram_markets.group_id`
(trigger orqali `telegram_chats` ham) va navbatdagi (`pending`) `telegram_outbox`
qatorlari YANGI id'ga ko'chadi; boshqa urinishdagi (`sending`) qatorlarning faqat
`chat_id` si yangilanadi (holatiga tegilmaydi — xabar ikki marta ketmaydi). Javobda
migrate kelgan xabar SHU urinishda yangi id'ga qayta yuboriladi (urinish hisoblanmaydi,
bir marta; guruh kartasi message_id ni oladi). Eski guruh kartalari ko'chirilmaydi
(message_id supergroup'da yaroqsiz) — o'chiriladi. Audit `notification.tg_group_migrated`.
«Not enough rights» — guruh nofaol (`blocked_on_send`) + admin va market EGASIGA
(`telegram.market_channel_inactive`, in-app + shaxsiy Telegram) xabar; huquq qaytib
bot `member` / `administrator` bo'lsa ulanish O'ZI qayta faol (Telegram har doim
`my_chat_member` yubormaydi — yoqilmasa egasi kod bilan qayta ulaydi). Yuborishda
aniqlangan chiqarilish (`kicked` / `not a member`) — `kicked` (avvalgi `blocked_on_send`
ham ustidan yoziladi). Chiqarilgan (`kicked` / `left` / `chat_not_found`) guruh — market
kabinetdan kod bilan qayta ulaydi (o'sha marketning nofaol qatori qayta yoqiladi, boshqa
marketniki — yo'q); admin o'chirgan (`manual`) yoki sababsiz qator — faqat admin PATCH. HTML xatosi (`can't parse entities`)
— faqat o'sha xabar `dead`, guruh faol qoladi.

**Tezlik va uzun xabarlar (BOT-3d).** Shaxsiy chatga ~1 xabar/s (3 tagacha
portlash). Token bucket'lar jarayon ichida (in-process) — prod'da bot bitta
replika; replika ko'paysa chegarani umumiy saqlovga ko'chirish kerak. Bucket'lar
soni 10 000 dan oshsa faqat eng eski (LRU) o'chiriladi. Uzun HTML xabar
teg/entity ichida kesilmaydi (teglar yopilib, keyingi bo'lakda qayta ochiladi);
bo'lakka sig'maydigan uzun teg (masalan 1024+ belgili havola) olib tashlanadi,
matni qoladi; ko'rinadigan matnli nuqta bo'lmasa ham teglar yopilib, keyingi
bo'lakda qayta ochiladi; surrogat jufti bo'linmaydi, bo'sh bo'lak yuborilmaydi. Outbox ko'p bo'lakli xabarda yetkazilgan bo'laklarni eslaydi
(`telegram_outbox.parts_sent`, migratsiya `1716000000199`) — qayta urinishda
yetkazilganlar qayta yuborilmaydi. Istisno (qabul qilingan): bo'lak yetib, lekin
`parts_sent` yozilmay qolsa — o'sha bitta bo'lak takror chiqishi mumkin.

**Javob kafolati (BOT-3d A).** Webhook update'ning brokerga uzatilishini kutadi
(3 s): RMQ xatosi / timeout → 503, Telegram qayta yuboradi; takror update
iste'molchida `update_id` bo'yicha tashlanadi (`telegram_rate_limits`
`upd:<id>`, 1 kun). Update ikki marta xato bersa shaxsiy chatga «⚠️ Xatolik yuz
berdi» (guruhga yo'q). identity javob bermasa «⚠️ Tizim vaqtincha ishlamayapti»
(«avval ulang» emas); tugma bosilganda ham shu matn callback javobida.
Chegara: 503 faqat brokerga UZATISH xatosini qoplaydi. Uzatilgan xabar
persistent emas (navbatda 60 s TTL), DLQ avtomatik qayta o'ynalmaydi — shu
oraliqda iste'molchi tushsa update yo'qolishi mumkin.

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
| notification-bot `group_token-…` (guruh) | guruhni ulash | O'CHIRILDI (6jXw0DDr) — faqat kabinetdagi bir martalik deep-link kodi; matnli token → `GROUP_TOKEN_REMOVED_TEXT` |
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
| Market guruhini ulash | `POST /telegram/link-code {purpose:'market_group', group_type}` (market EGASI — o'zi, admin — `market_id`; operator — 403, BOT-2 Q2 = A) → `t.me/<bot>?startgroup=<kod>` | guruhda `/start@bot <kod>` → `telegram_markets` qatori (`linked_by` — kodni yaratgan xodim, trigger `telegram_chats.linked_by` ga); mavjud ulanish ustidan yozilmaydi; marketga `telegram.group_connected`. `GET /notifications/me/telegram-groups` → `linked_by`, `linked_by_owner` (false — egasi ulamagan eski guruh) |
| Uzish | `DELETE /users/me/telegram` yoki botda `/uzish` | `telegram_id` NULL + audit |
| Statistika | `GET /telegram/stats` (admin) | rol bo'yicha `{total, linked, ratio}` |
| Mini App kirishi | `POST /auth/telegram {init_data}` | initData HMAC + `auth_date` ≤5 daqiqa → 30 daqiqalik JWT, refresh yo'q; IP + Telegram id 5/daqiqa. **Faqat kuryer** (boshqa rol 403 `TELEGRAM_COURIER_ONLY`); token `scope: 'tg_scan'` — gateway faqat `POST /orders/scan-assign` va `POST /telegram/scan/done` ni o'tkazadi (BOT-2) |
| Bot amallari | `BotGatewayClient` | `identity.auth.telegram_actor` → aktor JWT → MAVJUD gateway endpointlari (RBAC bitta joyda) |

**Telegram tokenlari (BOT-2).** Mini App va bot aktori tokenida `auth: 'telegram'`
va `tg_id`. Gateway `JwtStrategy` har so'rovda (≤60 s kesh) identity
`identity.auth.telegram_token_state` dan so'raydi: xodim faol, roli tokendagidek,
Telegram hamon SHU id'ga ulangan — aks holda 401 (nofaol qilingan yoki `/uzish`
qilgan xodim tokeni 60 s ichida to'xtaydi); identity javob bermasa — 503
(oxirgi 5 daqiqada «faol» tasdiqlangan token o'tadi). `must_change_password` →
tokenda `pwd_change`; `PASSWORD_CHANGE_GATE=on` da gateway 403, bot «🔐 Avval
kabinetda parolni almashtiring» deydi.

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
| `/ishim` | `GET /orders?status=waiting&status=on the road&status=waiting_customer&page&limit=10` — BITTA ro'yxat xabari (tuman bo'yicha, har buyurtma tugmasi → karta `GET /orders/:id`; "⬇️ Yana" / "⬆️ Oldingi" shu xabarni tahrirlaydi, BOT-3d; boshqa xabardagi «📋 Topshiriqlarim», masalan skan xulosasi — yangi ro'yxat xabari). Deploydan oldingi karta va «⬇️ Yana» tugmalari ishlashda davom etadi |
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
- **Idempotentlik (BOT-3d).** Har kuryer amali (`sell`, `cancel`,
  `could-not-deliver`, `partly-sell`, `rollback`) `Idempotency-Key: <action_id>`
  bilan yuboriladi. Gateway uni `idem:<user>:<sha256(kalit)>` ga aylantiradi;
  order-service kalitni **amal + buyurtma + tana barmoq izi** ga bog'laydi
  (`idempotency_keys.pattern` = `order.sell:<id>:<sha256(dto)[:32]>`, isbot fayl
  kalitlari kirmaydi). Ayni kalit boshqa amal, buyurtma yoki tana bilan → **422**,
  eski natija qaytmaydi. Yiqilgan urinish qayta egallanadi (`reclaimFailed`);
  ishlayotgan takror → **409** (`IDEMPOTENCY_IN_PROGRESS`; bot uni «natija
  noma'lum» deb ko'rsatadi, tugma qoladi); lease 90 s (gateway timeout 60 s dan
  uzun). Handler xatosida xabar requeue qilinmaydi (ack) — qayta yetkazish
  amalni fonda yuritmaydi; `markCompleted`/`markFailed` faqat `in_progress`
  qatorni yangilaydi. Isbot holati yakuniy natijadan keyin tozalanadi.
  Isbotli amal kaliti — o'sha «✅ Tugatdim» tugmasi (`proof:<action_id>`): har
  isbot urinishiga yangi, qayta urinishda o'zgarmaydi. Handler xatosida bir
  martalik «✅ Ha» / «✅ Tugatdim» qayta ochiladi (`retrySafe`).
- «✅ Ha» bosilganda darhol `answerCallbackQuery("⏳ Bajarilmoqda…")`; bot javobni
  **65 s** kutadi (`COURIER_OP_TIMEOUT_MS`), natija tasdiq xabarini TAHRIRLAB yoziladi.
  Timeout / 502–504 → "Natija noma'lum" va «✅ Ha» tugmasi qaytariladi: qayta bosish
  ayni kalit bilan ketadi, backend amalni ikkinchi marta bajarmaydi (keshdagi javob).

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
- (BOT-3c) Guruh relay'i (bekor / market guruhi xabari) — dispatch
  TRANZAKSIYASI ichida `telegram_outbox` ga (`pending`) + inbox qatorlari
  `delivery.telegram = queued`; commit'dan keyin darhol bir urinish, servis
  yiqilsa ham worker (har 5 s) yuboradi. Rollback → xabar yo'q. Relay
  navbatga qo'yish SAVEPOINT ichida: uning DB xatosi (timeout va h.k.) faqat
  relay'ni bekor qiladi (`delivery.telegram = failed`), dispatch'ni emas.
- (BOT-3c) `delivery.telegram`: `queued` (relay navbatda) / `retrying` (DM,
  429/5xx — outbox qayta uradi) — `sent` EMAS; yakuniy `sent` / `failed`
  (+ `telegram_error`) ni outbox ishchisi yozadi, yakunlangan qator qayta
  yozilmaydi. Migratsiya `1716000000192`.
- (BOT-3c) Botni bloklagan odam — `telegram_blocked_chats` (ilgari 24 soatlik
  sessiyada edi — sessiya tozalangach yana urinilardi); `my_chat_member:
  member` yoki shaxsiy `/start` da o'chadi. Migratsiya eski sessiya
  belgilarini ko'chiradi. Zaxira: 30 kundan eski blokda bitta sinov xabari
  (yo'qolgan `member` yangilanishi odamni abadiy uzmasin; 403 → blok yangilanadi).
- `notification.send` (`POST /notifications/send`) — ESKIRGAN, faqat
  superadminning qo'lda guruh relay'i; servislar `notification.dispatch`.
- `NOTIFICATION_ADMIN_GROUP_ID` / `TELEGRAM_ADMIN_GROUP_ID` — ixtiyoriy
  (Joi, bo'sh env bilan boot yiqilmaydi).
- ⚠️ integration-service `sendAdminNotification` (hamkor webhook xatolari)
  hali `notification.send` + `token` bilan — hamkor/integratsiya sohasi, bu
  kartalarda O'ZGARTIRILMADI (notification tomoni tokenni baribir qabul
  qilmaydi — faqat env).

## 10. Moliya xabarlari (VICfJuoi, 2crjWf7v)

> ⚠️ **QOIDA: pul — faqat shaxsiy chatga (BOT-2).** Summa, to'lov usuli, karta,
> qoldiq hech qachon guruhga yuborilmaydi (guruhda operator, kuryer va boshqa
> a'zolar bor). Smena hisoboti marketga: egasi Telegram'ga ulangan bo'lsa — uning
> SHAXSIY chatiga to'liq hisobot; ulanmagan (yoki holat noma'lum) bo'lsa — market
> guruhiga faqat summasiz «Smena yakunlandi — kabinetda ko'ring» + havola
> (ega sukut qarori Q1 = A, keyin o'zgarishi mumkin).

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

> BOT-3 #4: karta sinxronining tranzaksiyasi faqat qisqa — buyurtma qulfi,
> kartalarni o'qish va yangi guruh kartasiga JOY BAND QILISH
> (`telegram_order_cards.message_id` NULL). Telegram'ga yuborish / tahrir va
> `order.telegram_card` RPC tranzaksiyadan TASHQARIDA. Karta 429 bilan
> navbatga tushsa, outbox (`card_order_id`) yuborilganda `message_id` ni
> o'zi yozadi — keyingi holat hodisasi uni tahrirlaydi; yuborib bo'lmasa
> band qilish bo'shatiladi. Migratsiya `1716000000191`. notification-service
> `DB_POOL_MAX=20` (docker-compose.prod.yml).
>
> BOT-2: karta faqat guruh `telegram_chats` da hamon FAOL bo'lsa tahrirlanadi
> (uzilgan / nofaol guruhdagi eski karta yangilanmaydi). Bekor guruhi xabari
> ham `tg_group_show_customer_pii` ga bo'ysunadi (o'chiq — ism yo'q, telefon
> niqobli, manzil faqat tuman; sozlama o'qilmasa — niqoblanadi).
> Saqlash: yuborilgan `telegram_outbox` qatorida matn o'chiriladi, `dead` —
> 7 kun, `telegram_link_tokens` — 30 kun.

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

> **BOT-3b — AI fonda.** Matn / rasm → qoralama (`telegram_ai_drafts`, id
> update'dan deterministik — takror update ikkinchi qoralama ochmaydi) + «⏳»
> xabari; bot update'i shu bilan TUGAYDI. ai-parse va ai-confirm'ni fondagi
> ishchi (`AiOrderService`, shu replikada darhol, zaxira — har 5 s, bir
> replikada 5 tagacha parallel) bajaradi: `worker_at` bilan bir marta oladi,
> QAYTA URINMAYDI (xato — «🔁 Qayta urinish»). Ishchi olganiga 4 daqiqadan
> oshgan `parsing` → `failed` + «🔁 Qayta urinish», `creating` → preview +
> «✅ Yaratish» ni qayta bosish (server dedupe); navbatdagi (hali olinmagan)
> qoralama tegilmaydi. Har yakuniy yozuv da'vo tokeni (`worker_token`) bilan:
> tiklangan qoralamaning kech natijasi tashlanadi, xabar tahrirlanmaydi.
> Zaxira tick 5 s dan yangi qoralamani olmaydi. Chat qulfi lease 12 s,
> uzaytirish har 4 s. Migratsiya `1716000000190` (`worker_at`, `worker_token`,
> `telegram_chat_locks`).

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

## 14. Kabinet havolalari (PIJN1lGp)

Botdagi «🌐 Kabinetda …» tugmalarining yagona manbasi — `libs/common/src/telegram/cabinet-links.ts`
(`cabinetLinks(ELCHI_CABINET_URL)`; asos faqat `https://`, aks holda `https://admin.elchipochta.uz`).
Yo'llar FE `src/app/lib/routes.tsx` / `design/kit/route-map.json` bilan sinxron (`WEB_ROUTES`;
`cabinet-links.spec.ts` solishtiradi va kodda eski `/orders/create`, `/orders?search=` qolmaganini tekshiradi).

| Tugma | Funksiya | Yo'l |
|---|---|---|
| AI buyurtma — «Kabinetda yaratish» | `orderCreate()` | `/new-orders/create` |
| Guruh kartasi — «Kabinetda ochish» | `orderDetail(id)` | `/orders/edit/<id>` (ichki id) |
| Kuryer kartasi, «Video juda katta», «Faylni yuklab bo'lmadi» | `courierOrder(id)` | `/orders?status=waiting&orderSearch=EL-<id+100000>` |
| `/kun` hisoboti | `home()` | `/` |
| To'lov xabarlari | `selfCashbox()` | `/cash-box` |
| Smena hisoboti (va in-app bildirishnoma havolasi) | `shiftReport(id)` | `/payments/shifts/<id>` (eski `/payments/shift-report/<id>` ni FE yo'naltiradi) |

Buyurtmalar ro'yxati filtri kaliti — `orderSearch` (FE `ORDER_FILTER_KEYS.search`); eski `search` kaliti
yangi havolalarda ishlatilmaydi (FE uni faqat eski chat xabarlari uchun o'qiydi).

## 15. Kuzatuv — bot buzilsa xabar (zDUUxyH2)

`scripts/bot-alert.sh` — host cron'da har 5 daqiqada (`backup-alert.sh` naqshi; yangi konteyner yo'q,
kanal botga bog'liq emas). Faqat o'qiydi. Bir vaqtda bitta nusxa (`flock`); har `docker`/`psql`
chaqiruvi `timeout -k 5` bilan (`BOT_ALERT_CMD_TIMEOUT`, 30 s), SQL `statement_timeout=10s`. Qo'lda
`--dry-run`/`--test` paytida boshqa nusxa ishlayotgan bo'lsa — stderr'ga xabar va kod 3.

| Tekshiruv | Muammo | Chegara (env, sukut) |
|---|---|---|
| `getMe` | token buzuq (401/404) — yoki alohida: «Telegram API javob bermadi» (tarmoq / 5xx) | — |
| `getWebhookInfo` — faqat webhook rejimida (`resolveBotConfig` kabi: `TELEGRAM_BOT_MODE`, `TELEGRAM_WEBHOOK_SECRET`, `BOT_POLLING_LEADER`) | url `TELEGRAM_WEBHOOK_URL` ga teng emas (berilmagan bo'lsa `https://…/telegram/webhook/<slug>` emas) yoki bo'sh; yaqinda yetkazish xatosi; navbat to'lgan | `BOT_ALERT_WEBHOOK_ERROR_MIN` (15), `BOT_ALERT_PENDING_UPDATES_MAX` (100) |
| `telegram_outbox` (`BEGIN READ ONLY` SELECT, `elchi-postgres` ichida) | muddati o'tgan `pending` juda eski; oxirgi soatda `dead` ko'p; `sending` da qotgan; so'rov bajarilmadi / timeout | `BOT_ALERT_OUTBOX_PENDING_MIN` (10), `BOT_ALERT_OUTBOX_DEAD_MAX` (20) |
| notification-service konteyneri — aniq 1 ta (`com.docker.compose.project` = `BOT_ALERT_COMPOSE_PROJECT`/`COMPOSE_PROJECT_NAME`, `oneoff=False`; yoki `BOT_ALERT_NS_CONTAINER`) | topilmadi / bir nechta / docker javob bermadi; `running healthy` emas; crash-loop (`RestartCount` oynada ≥ 2 marta o'sdi; restart vaqti `State.StartedAt` dan, oynaga +1 cron intervali zaxira; 1..10080); health `starting` `StartedAt` dan uzoq | `BOT_ALERT_NS_START_GRACE_S` (90), `BOT_ALERT_RESTART_WINDOW_MIN` (30) |

- **Ogohlantirilgan to'plam tekshiruv kodi bo'yicha «yopishqoq»:**
  - kod shu yugurishda VA oldingi 2 yugurishdan birida yiqilsa qo'shiladi (qisqa uzilish jim o'tadi,
    «flapping» ham ushlanadi); crash-loop (oynada ≥ 2 restart) — darhol, oynada restart turgan ekan saqlanadi;
  - hech narsa ogohlantirilmagan, lekin so'nggi 4 yugurishdan 3 tasida ≥ 3 XIL tekshiruv (yoki 4 tasining
    hammasida) yiqilgan bo'lsa — bitta «unstable» yozuvi. Shu hodisada allaqachon ogohlantirilgan kodlar
    sanalmaydi (tiklanish dumi «unstable» emas; 2 ta shovqinli tekshiruv ham bermaydi);
  - kod faqat ketma-ket 2 TOZA yugurishdan keyin chiqadi. Hodisa oldingi «tiklandi» dan
    `BOT_ALERT_FLAP_WINDOW_MIN` (60; 11..10080) ichida qayta boshlansa (flapping) — 4 toza
    yugurish kerak (alert qilingan kodlar chiqqach, «tiklandi» qarori baribir 2 toza yugurish bo'yicha);
  - «✅ tiklandi» faqat to'plam bo'sh VA so'nggi 2 (flapping'da 4) yugurish to'liq toza bo'lsa. To'plam
    bo'shab, lekin hali tasdiqlanmagan yangi kod yiqilayotgan bo'lsa — hodisa jim ushlab turiladi.
  - Shu hodisada hali ogohlantirilmagan kod qo'shilganda — xabar (`ns_restart` va `ns_unhealthy` bitta
    sabab); kod chiqib, qayta kirsa — jim; kod chiqib ketganda — jim (to'liq tiklanishni kutadi). Kod
    4 yugurish ketma-ket toza bo'lsa hodisaning «alert qilingan» ro'yxatidan chiqadi — hodisa boshqa
    tekshiruv tufayli ochiq tursa ham, uning keyingi buzilishi yangi alert (2-yugurishda).
  - Eskalatsiya bir ildizda (`ns_unhealthy` → crash-loop → `exited`) yangi xabar bermaydi — yangi holat
    faqat 6 soatlik eslatmada ko'rinadi. Restart vaqti: konteyner `running` bo'lsa `StartedAt`, aks holda
    yugurish vaqti. Konteyner id almashsa (qayta yaratildi, deploy) restart tarixi boshidan boshlanadi.
  - `docker ps` yiqilsa konteyner id, `RestartCount` va restart vaqtlari oldingi holatdan ko'chiriladi
    (bitta xato davom etayotgan crash-loop'ni o'chirmaydi).
  - Eski formatdagi holat fayli: `ok` bo'lsa tarix bo'sh boshlanadi (yangilanishdagi blip darhol alert
    bermaydi); `problem` va hozir sog'lom bo'lsa — «tiklandi» 2-toza yugurishda.
- Takrorsizlik tekshiruv KODI bo'yicha (son yoki Telegram matni o'zgarsa yangi xabar ketmaydi): muammo
  paydo bo'lganda yoki hodisaga yangi kod qo'shilganda bitta; davom etsa har `BOT_ALERT_REPEAT_HOURS` (6) da
  eslatma; tiklanganda bitta «✅ tiklandi».
- Hech bir kanal qabul qilmasa holat oldinga surilmaydi — keyingi yugurish qayta yuboradi.
- Sirlar (tokenlar, URL'lar) argv/log'ga tushmaydi (`curl -K -`); holat va log fayllari `0600`.
- Metrika: yakuniy dead-letter — `bot_outbox_dead_total` (alohida counter; `bot_send_total` urinishlarni sanaydi).

**O'rnatish (serverda, qo'lda — repo'da sir yo'q):**

1. Skriptni ko'chiring: `cp scripts/bot-alert.sh ~/elchi-ops/ && chmod 700 ~/elchi-ops/bot-alert.sh`.
2. `~/elchi-ops/bot-alert.env` (`chmod 600`; `KEY=VALUE`, skript uni `source` qilmaydi). Izohlar —
   faqat ALOHIDA qatorda. Kamida bitta kanal:
   ```
   # ntfy / Slack-mos relay
   BOT_ALERT_WEBHOOK_URL=https://ntfy.sh/<maxfiy-topic>
   # ixtiyoriy Telegram kanali — ALOHIDA alert boti (asosiy token bilan bir xil bo'lsa rad etiladi)
   BOT_ALERT_TELEGRAM_CHAT_ID=<chat-id>
   BOT_ALERT_TELEGRAM_BOT_TOKEN=<alohida-alert-bot-tokeni>
   # dead-man switch (server o'chsa ham bilinadi)
   BOT_ALERT_HEARTBEAT_URL=https://hc-ping.com/<uuid>
   # bir xostda bir nechta compose loyiha bo'lsa
   BOT_ALERT_COMPOSE_PROJECT=<compose-loyiha-nomi>
   ```
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_SLUG`, `TELEGRAM_BOT_MODE`, `TELEGRAM_WEBHOOK_SECRET`,
   `TELEGRAM_WEBHOOK_URL`, `BOT_POLLING_LEADER`, `POSTGRES_USER`, `POSTGRES_DB` — `.env.production` dan
   o'qiladi. Chegaralarni shu faylda o'zgartirish mumkin (jadvaldagi nomlar). Har son oraliqda
   tekshiriladi; raqam bo'lmagan yoki oraliqdan tashqari qiymat (`0`, `-5`, `45m`, ulkan son) rad
   etiladi: logga xom qiymat bilan `WARN` yoziladi va sukut ishlatiladi. Oraliqlar:
   `BOT_ALERT_CMD_TIMEOUT` 1..600 (30), `BOT_ALERT_RESTART_WINDOW_MIN` 1..10080 (30),
   `BOT_ALERT_FLAP_WINDOW_MIN` 11..10080 (60), `BOT_ALERT_REPEAT_HOURS` 1..720 (6),
   `BOT_ALERT_OUTBOX_PENDING_MIN` 1..10080 (10), `BOT_ALERT_WEBHOOK_ERROR_MIN` 1..10080 (15),
   `BOT_ALERT_PENDING_UPDATES_MAX` ≥ 1 (100), `BOT_ALERT_OUTBOX_DEAD_MAX` ≥ 0 (20),
   `BOT_ALERT_NS_START_GRACE_S` 0..86400 (90). Bosh nollar e'tiborsiz (`010` = 10). `BOT_ALERT_CMD_TIMEOUT`,
   `BOT_ALERT_HOST_LABEL`, `BOT_ALERT_TELEGRAM_API` — fayldan yoki shu nomdagi env'dan (env ustun).
3. Tekshirish: `ELCHI_APP_DIR=<backend-katalogi> ~/elchi-ops/bot-alert.sh --dry-run` (hech narsa
   yubormaydi, holatni o'zgartirmaydi), `… --test` (kanallarga test xabar + heartbeat ping).
4. Cron (`docker` guruhidagi foydalanuvchi). **Server cron'ini #607 follow-up PR (yolg'on «tiklandi»,
   takroriy alert, `docker ps` xatosi tuzatishlari) dev'ga merge bo'lgach yoqing** — undan oldingi
   versiya shovqinli:
   `*/5 * * * * ELCHI_APP_DIR=/home/<user>/apps/backend /home/<user>/elchi-ops/bot-alert.sh`.
5. Log: `~/elchi-ops/logs/bot-alert.log`; holat: `~/elchi-ops/state/bot-alert.state`.

**Ogohlantirish kelsa:** token — BotFather / `.env.production` (§4); webhook — `npm run telegram:setup`;
outbox tiqilgan / `dead` ko'p — notification-service loglari va `telegram_outbox.last_error`;
konteyner / crash-loop — `docker compose -f docker-compose.prod.yml ps notification-service` va loglari.

Keyin (alohida karta): Prometheus + Alertmanager (`libs/common/src/metrics/alerts/telegram-bot.rules.yml`).
