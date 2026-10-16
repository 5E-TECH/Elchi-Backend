# Elchi Telegram boti — yadro, rollout va token aylantirish

> Kartalar: ZlpXb4Wh, Mvx0h1Fv, uCrzrElu, UQlmQiGT, GL2GgtEc, 9HIaV80X, bOMYoOtV.
> Ega qarori (2026-09-20): **bitta bot, bitta token, bitta yadro** —
> `apps/notification-service/src/bot/`.

## 1. Tuzilma

```
Telegram ──HTTPS 443──▶ Cloudflare Tunnel ──▶ api-gateway
   POST /telegram/webhook/:botSlug   (X-Telegram-Bot-Api-Secret-Token, timingSafeEqual)
        │  emit notification.telegram.update (RMQ), DARHOL 200
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
