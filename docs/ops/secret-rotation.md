# Server sirlarini almashtirish — runbook (AFiXurLH, 2026-10-26)

> ⚠️ TAYYORLANGAN, BAJARILMAGAN. Ijro faqat Dilshodning ruxsati bilan, sokin
> vaqtda (tun). Skript: `scripts/rotate-datastore-secrets.sh` (har qadam
> alohida; `--execute` bo'lmasa faqat dry-run). Eski umumiy runbook:
> `docs/audit/SECRET_ROTATION_RUNBOOK.md` (git tarixini tozalash — §2).

## 0. Holat (2026-10-26, faqat uzunlik/hash/boolean bilan tekshirilgan)

`.env.production` va `.env` dagi joriy qiymatlar git tarixidagi (9 commit)
qiymatlar bilan sha256 bo'yicha solishtirildi:

| Sir | Hozir | Git tarixida ochiq ketganmi | Kerak |
|---|---|---|---|
| `POSTGRES_PASSWORD` (+ `POSTGRES_URI`) | 17 belgi | **HA — hozir ham ishlaydi** | almashtirish (`postgres`) |
| RabbitMQ | yagona foydalanuvchi `guest:guest` (administrator), 59 ulanish ham guest | **HA** (URI) | alohida foydalanuvchi + guest o'chirish (`rabbitmq`) |
| MinIO **root** (`.env` `MINIO_ACCESS_KEY/SECRET_KEY` → compose `MINIO_ROOT_*`; `.env.production` `MINIO_ROOT_*` ham shu) | parol 10 belgi | **HA — hozir ham ishlaydi** | almashtirish (`minio-root`) |
| MinIO ilova kaliti (`.env.production` `MINIO_ACCESS_KEY/SECRET_KEY`, IAM user, readwrite) | secret 48 | yo'q (yangi) | ixtiyoriy, gigiyena (`minio-app`) |
| `TELEGRAM_BOT_TOKEN` | 46 | yo'q; tarixdagi eski token Telegram'da **404 (o'lik)** | BotFather — Dilshod qarori (§6) |
| JWT kalitlari, `SUPERADMIN_PASSWORD`, `SWAGGER_PASSWORD`, `TUNNEL_TOKEN`, `INTEGRATION_CREDENTIAL_SECRET` | — | yo'q (allaqachon almashgan) | — |

Qo'shimcha topilmalar:
- `.env` (compose faqat `${…}` interpolatsiyasi uchun o'qiydi) — ichida tarixdagi
  ESKI JWT/superadmin/bot qiymatlari ham turibdi, fayl `775`. Rotatsiyadan keyin
  faqat kerakli kalitlar qoldirilsin (§7).
- `.env.production` va 9 ta `.env.production.bak*` — `664` (backendteam guruhi:
  shodiyor, dilshodbek, faxriddin). `/tmp/elchi-env-backup` (deploy nusxasi)
  `664` edi → 2026-10-26 da `600` qilindi; yangi `deploy.yml` uni o'chiradi va
  o'rniga `mktemp` (0600) ishlatadi.
- Postgres `pg_hba`: konteyner ichidagi `127.0.0.1` — `trust`. Parolni faqat
  docker tarmog'i orqali kirish tekshiradi — skript shunday tekshiradi.

## 1. Tartib (bitta tunda, ~45 daqiqa)

| # | Qadam | Ta'sir |
|---|---|---|
| 0 | `preflight` — faqat o'qish | — |
| 1 | `prepare --execute` → `new.env` ni **darhol parol menejeriga** | — |
| 2 | `postgres --execute` | postgres (~5–10 s) + barcha app konteynerlari qayta yaratiladi: ~30–60 s API uzilishi |
| 3 | `verify` | — |
| 4 | `rabbitmq --execute` | yana ~30–60 s uzilish |
| 5 | `minio-app --execute` | faqat file-service (~20 s yuklash/yuklab olish yo'q) |
| 6 | `minio-root --execute` | MinIO qayta ishga tushadi (~5–10 s) |
| 7 | `verify` → hammasi `OK` | — |
| 8 | Validator va preflight allaqachon kodda (§5) | — |
| 9 | `cleanup --execute` (eski qiymatlar `shred`) — faqat 1–2 kun barqaror ishlagandan keyin | — |

Har qadamdan keyin: `https://api.elchipochta.uz/health/readiness` 200,
admin panelga kirish, TEST market (37) bilan bitta buyurtma ko'rish, fayl
(rasm) ochish. Muammo — o'sha qadamning `rollback`.

```bash
cd /home/shodiyor/apps/backend
S=scripts/rotate-datastore-secrets.sh      # (yoki ~/elchi-ops/rotate-datastore-secrets.sh)
bash $S preflight
bash $S prepare --execute                  # ~/elchi-ops/rotation/ (0700): env.production.before, env.before, new.env
bash $S postgres                           # avval dry-run: nima qilishini ko'ring
bash $S postgres --execute
bash $S verify
bash $S rabbitmq --execute
bash $S minio-app --execute
bash $S minio-root --execute
bash $S verify
```

## 2. Postgres (`postgres`)

1. `ALTER ROLE <POSTGRES_USER> WITH PASSWORD '<yangi, 48 hex>'` — psql'ga
   stdin orqali (argv/log'da yo'q). Mavjud ulanishlar uzilmaydi (parol faqat
   ulanishda tekshiriladi).
2. `.env.production`: `POSTGRES_PASSWORD` va `POSTGRES_URI` ichidagi parol;
   `.env`: `POSTGRES_PASSWORD` (postgres konteyneri env'i — faqat initdb uchun,
   lekin mos turishi kerak). Fayllar JOYIDA yoziladi (egasi/guruh/rejim o'zgarmaydi).
3. Avval `postgres` konteyneri qayta yaratiladi (~5–10 s; o'sha image, volume
   tegilmaydi): `.env` dagi parol compose orqali uning env'iga tushadi —
   aks holda KEYINGI deploy (`up -d … postgres`) uni kutilmaganda qayta
   yaratardi. So'ng barcha app servislari + `db-backup` (+ ishlayotgan bo'lsa
   `db-reconcile`, `activity-log-prune`) `up -d --no-deps --force-recreate`,
   health kutiladi.
4. Tekshiruv: docker tarmog'i orqali `psql -h postgres` — yangi parol ✅,
   eski parol ❌; readiness 200.

Rollback: `bash $S rollback postgres --execute` — eski parol `ALTER ROLE` bilan
qaytadi, env fayllar eski qiymatga, postgres va servislar qayta yaratiladi.

Dry-run (2026-10-26, prod, release 8 dan keyin): `preflight` — compose
servislari, postgres tarmoq logini, RabbitMQ management API, `mc` va MinIO
admin API, ilova/root loginlari, readiness — hammasi OK; `postgres`,
`rabbitmq`, `minio-app`, `minio-root`, `rollback` dry-run'lari xatosiz reja
chiqardi.

## 3. RabbitMQ (`rabbitmq`)

1. `elchi` foydalanuvchisi (parol stdin orqali `rabbitmqctl add_user`),
   `set_permissions -p / elchi '.*' '.*' '.*'`, teg `management`
   (`scripts/rmq-cleanup-queues.sh` HTTP API ishlatadi — endi
   `RABBITMQ_USER=elchi RABBITMQ_PASS=…` bilan chaqiriladi; sukut guest edi).
   Bu qadam qo'shimcha — guest hali ishlaydi.
2. `RABBITMQ_URI` → `amqp://elchi:<yangi>@rabbitmq:5672` (`.env.production` va `.env`).
3. 15 app servisi qayta yaratiladi, health kutiladi.
4. `rabbitmqctl list_connections user` da **birorta ham `guest` qolmagani**
   tekshiriladi (qolsa — skript to'xtaydi, guest o'chirilmaydi).
5. `rabbitmqctl delete_user guest`; tekshiruv: management API
   `/api/whoami` guest:guest → 401.

Rollback: `rollback rabbitmq --execute` — guest qayta yaratiladi (administrator,
`/` ga to'liq ruxsat), URI eski, servislar qayta yaratiladi.

⚠️ `elchi` foydalanuvchisi brokerning mnesia'sida turadi, node nomi esa konteyner
id'si (`rabbit@<id>`, compose'da `hostname:` yo'q). `elchi-rabbitmq` qayta
yaratilsa volume'da bo'sh mnesia ochiladi: `elchi` yo'qoladi, guest qaytadi,
hamma servis brokerga ulana olmaydi. Shuning uchun `deploy.yml` uni
`--no-recreate` bilan ko'taradi (qUEE0Bgd); qo'lda `--force-recreate rabbitmq`
qilmang.

## 4. MinIO (`minio-app`, `minio-root`)

- `minio-app`: ilova IAM foydalanuvchisiga (kalit nomi o'zgarmaydi) yangi
  secret (`mc admin user add` — mavjud foydalanuvchida secret'ni yangilaydi),
  `.env.production` `MINIO_SECRET_KEY`, faqat `file-service` qayta yaratiladi.
  Oldin berilgan presigned URL'lar (`FILE_SIGNED_URL_EXPIRES` ichida) eski kalit
  bilan imzolangan — almashtirishdan keyin ochilmaydi; FE yangisini so'raydi.
- `minio-root`: avval `mc admin cluster iam export` (foydalanuvchi/policy'lar
  zaxirasi, `rotation/minio-iam-before.zip`), keyin `.env`
  (`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` — compose ularni `MINIO_ROOT_USER/PASSWORD`
  ga qo'yadi) va `.env.production` (`MINIO_ROOT_USER/PASSWORD`) yangilanadi,
  `minio` qayta yaratiladi. Tekshiruv: yangi root ✅, eski root ❌, ilova kaliti
  ✅, `elchi-backup-ro` (zaxira) bor.
- Zaxira (`elchi-backup-ro`, faqat o'qish) ikkala qadamdan ham ta'sirlanmaydi.

Rollback: `rollback minio-app --execute` / `rollback minio-root --execute`.

## 5. `POSTGRES_PASSWORD` Joi validatori (min 24) va deploy preflight'i

Rotatsiyadan keyin (2026-10-27: prod paroli 48 belgi) validator kodga kirdi:
`libs/common/src/config/index.ts` `observabilityKeys` — production'da
`POSTGRES_PASSWORD` ≥ 24, dev/test'da cheklov yo'q. Validator o'tkazmaydigan qiymat
hamma servisni boot'da yiqitadi va rollback buni tuzatmaydi (env fayl git'da emas),
shuning uchun `deploy.yml` skriptining boshida **env preflight** turadi (prod va
staging): serverga tegilmasdan `POSTGRES_PASSWORD` ≥ 24 va `SUPERADMIN_PASSWORD` ≥ 12
tekshiriladi. Deploy logida:

```
!!! .env.production: missing or too short: POSTGRES_PASSWORD (min 24) — deploy refused, nothing was touched.
```

Hech narsa o'zgarmagan: serverda qiymatni tuzating (Postgres uchun avval `ALTER ROLE`
— §2) va deploy'ni qayta ishga tushiring. Logga qiymat ham, uzunlik ham chiqmaydi.
Preflight faqat uzunlikni ko'radi: `SUPERADMIN_PASSWORD` ning zaif-qiymat tekshiruvi
(`rejectWeakPassword`) Joi'da qoladi, uni deploy oxiridagi readiness darvozasi ushlaydi.

## 6. `TELEGRAM_BOT_TOKEN` — Dilshod (BotFather, uning Telegrami)

Tarixda ketgan eski token allaqachon o'lik (Telegram `getMe` → 404); joriy
token tarixda yo'q, lekin hamma app konteynerlari env'ida va `664` faylda turibdi.
Almashtirish — gigiyena, qaror Dilshodniki. Qadamlar:

1. Telegram → @BotFather → `/mybots` → `@howareyoutodaybro_bot` → **API Token**
   → **Revoke current token** (yoki `/revoke`). Eski token darhol o'ladi — bot
   keyingi qadamlar tugaguncha javob bermaydi (~5 daqiqa).
2. Yangi tokenni chatga YOZMANG — serverda o'zingiz:
   `cd /home/shodiyor/apps/backend && cp .env.production .env.production.bak.$(date +%s)`,
   so'ng `.env.production` dagi `TELEGRAM_BOT_TOKEN=` qatorini yangilang
   (ixtiyoriy: `TELEGRAM_WEBHOOK_SECRET` ham — `openssl rand -hex 32`).
3. `docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate notification-service identity-service api-gateway`
   (identity — Mini App `initData` imzosini shu token bilan tekshiradi).
4. Webhook: `npm run telegram:setup` (docs/ops/telegram-bot.md §3–4) — `getWebhookInfo` da URL va `pending_update_count` tekshiriladi.
5. Tekshiruv: botga `/start` → javob; Mini App ochiladi; eski token bilan
   `getMe` → 401/404.

## 7. Market Telegram tokenlari — `ROTATE_ALL` (chaqirilmagan)

`POST /markets/tg-token/rotate-all` (`{ "confirm": "ROTATE_ALL" }`, faqat
SUPERADMIN; `api-gateway.controller.ts` → identity
`rotateAllMarketTelegramTokens`): barcha `role=market, is_deleted=false`
(INACTIVE ham) qatorlarning `market_tg_token` i BITTA tranzaksiyada yangi
tasodifiy qiymatga almashadi; javobda faqat `rotated_count`; bitta activity-log
qatori. Xato bo'lsa hech biri o'zgarmaydi.

**Marketlar uchun nima buziladi — kod bo'yicha amalda hech narsa:**
- Guruhni ulash endi FAQAT paneldan olingan bir martalik 10 daqiqalik kod bilan
  (`telegram_link_tokens`, 6jXw0DDr/4TfLyTrL); matnli `group_token-…` / uzoq
  yashovchi market tokeni bilan ulash olib tashlangan — bot «Matnli token bilan
  ulash o'chirildi» deydi. Mavjud ulangan guruhlar `group_id` bo'yicha saqlangan —
  ishlashda davom etadi.
- `identity.market.find_by_tg_token` RPC'ni Elchi-Backend'da hech bir servis
  chaqirmaydi; prod loglarida (72 soat) ham iz yo'q (identity har RPC'ni
  loglamaydi — bu kuchsiz dalil). Elchi-Frontend `tg-token` endpoint'larini
  ishlatmaydi.
- Ya'ni rotatsiya — oqib ketgan eski qiymatlarni o'ldirish (gigiyena). Faqat
  repo'dan TASHQARIDAGI biror tizim (masalan, eski tashqi order-bot) RMQ
  orqali `find_by_tg_token` ni eski token bilan chaqirsa — o'sha to'xtaydi.
- Swagger tavsifidagi «order-bot'ga qayta ulanish va yangi guruh ulash faqat
  yangi token bilan» jumlasi eskirgan.

Ijro (Dilshod ruxsatidan keyin): SUPERADMIN token bilan
`curl -X POST https://api.elchipochta.uz/markets/tg-token/rotate-all -H "Authorization: Bearer …" -H 'Content-Type: application/json' -d '{"confirm":"ROTATE_ALL"}'`
→ `rotated_count` = market soni. Keyin GvL6ZFAd yopiladi.

## 8. Keyin

- `.env` ni faqat compose interpolatsiyasi kalitlariga qisqartirish
  (`POSTGRES_USER/PASSWORD/DB/PORT`, `MINIO_ACCESS_KEY/SECRET_KEY`,
  `RECONCILE_INTERVAL_SECONDS`, `ACTIVITY_LOG_PRUNE_INTERVAL_SECONDS`), rejim `640`.
- `.env.production*` → `640` (guruh backendteam o'qiydi — deploy foydalanuvchisi
  `dilshodbek`, egasi ham u), eski `.env.production.bak*` fayllarni rotatsiya
  tasdiqlangach o'chirish (ularda ESKI parollar).
- Yangi qiymatlar parol menejerida ekanini tekshirib, `cleanup --execute`.
- B: `git filter-repo` bilan tarixdan `.env.production` ni tozalash
  (SECRET_ROTATION_RUNBOOK.md §2) — faqat rotatsiyadan keyin va ochiq PR'lar yo'q paytda.
- `TUNNEL_TOKEN` tarixda yo'q. Agar almashtirilsa: `cloudflared` endi
  deploy'da avtomatik qayta yaratilmaydi — qo'lda navbat bilan:
  `up -d --no-deps --force-recreate cloudflared-2`, "Registered tunnel
  connection" ni kuting, keyin `cloudflared`.
