# AI kalit va modellar — ops runbook

Spec: «AI kalit va modellar» v0.2 (be-brief §9–§10, §15). Ega qarorlari 2026-11-15:
server kaliti (`ANTHROPIC_API_KEY`) zaxira sifatida qoladi, lekin **avtomatik o'tish yo'q** —
UI kaliti rad etilsa (401/402/403/ochilmadi) AI to'xtaydi, ops Telegram'ga darhol xabar
ketadi, ega «Kalitni o'chirish» bilan server kalitiga bir bosishda o'tkazadi.

> ⚠️ Kalit qiymati HECH QACHON chatga, Telegram'ga, ticket'ga, logga yozilmaydi va
> yuborilmaydi. Kalit faqat UI orqali (brauzerda muhrlanadi) qo'shiladi.

## 1. Fayllar (faqat ai-service ko'radi)

| Muhit | Sir fayli | Master sir |
|---|---|---|
| prod | `.env.ai-secrets` | `./secrets/ai/ai_key_master` |
| staging | `.env.staging.ai-secrets` | `./secrets/ai/ai_key_master` (prod'dagidan BOSHQA) |

Ikkalasi ham git'ga tushmaydi (`.gitignore`); namuna — `.env.ai-secrets.example`
(qatorlari ataylab izohda: bu fayl umumiy env fayldan KEYIN o'qiladi, bo'sh qator u yerdagi
kalitni bosib ketadi).

Master sir yaratish (qiymat ekranga chiqmaydi):

```bash
cd "$APP_DIR"
install -d -m 0700 secrets/ai
( umask 077; openssl rand -base64 48 > secrets/ai/ai_key_master )
sudo chown 1000:1000 secrets/ai/ai_key_master && sudo chmod 0400 secrets/ai/ai_key_master
# .env.ai-secrets (staging: .env.staging.ai-secrets):
#   AI_KEY_ENCRYPTION_SECRET_FILE=/run/secrets/ai/ai_key_master
#   ANTHROPIC_API_KEY=...   (server kaliti — .env.production dan KO'CHIRILADI)
```

Deploy preflight: `.env.production` / `.env.staging` da `AI_KEY_ENCRYPTION_SECRET*` yoki
`ANTHROPIC_BASE_URL` bo'lsa — deploy RAD etiladi; `ANTHROPIC_API_KEY` hali u yerda bo'lsa —
WARN (keyingi relizdan FAIL).

## 2. Staging'ni yoqish (be-brief §15)

1. Deploy: ai-service (migratsiya 228) → keyin api-gateway.
2. `.env.staging`: `AI_CONFIG_UI_ENABLED=true`, `AI_MODEL_POLICY_STRICT=false`,
   `AI_CONFIG_WRITER_IDS=<eganing staging user id'si>`, `AI_CONFIG_STEP_UP_REQUIRED=false`
   (step-up BE-5 chiqqach `true` — mashq uchun), `RMQ_REQUESTER_SIG_SECRET` (gateway VA
   ai-service'da; yo'q bo'lsa yozish o'chiq — `rmq_unsigned`).
3. Master sir (§1) va `.env.staging.ai-secrets`.
4. Alert cron (§3), `BOT_ALERT_HOST_LABEL=staging`; `ai-config-alert.sh --test`.
5. `docker compose ... up -d --force-recreate ai-service`, keyin `api-gateway`.
6. Ega: staging parolini almashtiradi (restore hammaga umumiy parol beradi), Console'da
   ALOHIDA workspace + oylik limit ($20) bilan kalit yaratadi va UI orqali qo'shadi;
   ops chatdagi xabarni va modellar ro'yxatini tekshiradi.

Restore drill / staging restore: `anonymize.sql` kalitlar, urinishlar va runtime
sozlamalarini o'chiradi (`verify.sql` tekshiradi) — restore'dan keyin kalitni UI orqali
QAYTA qo'shish va parolni almashtirish kerak. Pilot `--collect` kutilayotgan bo'lsa restore
qoldiriladi.

## 3. Ops Telegram xabari (`scripts/ai-config-alert.sh`)

Konfiguratsiya `bot-alert.sh` bilan bir xil (`$ELCHI_OPS_DIR/bot-alert.env`:
`BOT_ALERT_TELEGRAM_BOT_TOKEN`, `BOT_ALERT_TELEGRAM_CHAT_ID`, ixtiyoriy
`BOT_ALERT_WEBHOOK_URL`, `BOT_ALERT_HOST_LABEL`, `BOT_ALERT_PG_CONTAINER`). UI'dan
o'zgartirilmaydi.

```bash
install -m 0755 scripts/ai-config-alert.sh ~/elchi-ops/ai-config-alert.sh
crontab -e
# prod:
* * * * * ELCHI_APP_DIR=/home/<user>/apps/backend /home/<user>/elchi-ops/ai-config-alert.sh
# staging (env fayli va konteyner nomi boshqa):
* * * * * ELCHI_APP_DIR=/opt/elchi-staging ELCHI_ENV_FILE=/opt/elchi-staging/.env.staging /home/<user>/elchi-ops/ai-config-alert.sh
~/elchi-ops/ai-config-alert.sh --test      # bitta test xabar
~/elchi-ops/ai-config-alert.sh --dry-run   # nima yuborilishini ko'rsatadi
```

Birinchi yugurish kursorni joriy oxirgi qatorga qo'yadi (eski tarix yuborilmaydi). Kursor
faqat kanal xabarni qabul qilgach suriladi. Rad etilgan urinishlar — soatiga bitta yig'ma
xabar (≥ 3 ta). Inbox (superadmin + admin) xabarlari ai-service'dan alohida ketadi
(`ai.key_alert`, `ai.model_alert`).

## 4. Nosozlikda

| Holat | Belgisi | Tiklash |
|---|---|---|
| UI kaliti rad etildi / pul yo'q / ruxsat yo'q | ops xabari, UI «AI to'xtagan» | UI: «Kalitni almashtirish», «Oldingisiga qaytarish» yoki «Kalitni o'chirish» (server kaliti ishlaydi) |
| Saqlangan kalit ochilmadi (master sir yo'q/boshqa) | `ui_key_unreadable` | Master sir faylini tiklang yoki «Kalitni o'chirish» (master sirsiz ishlaydi) |
| Yozish o'chiq | `key_locked_reason` | `feature_off` → flag; `rmq_unsigned` → `RMQ_REQUESTER_SIG_SECRET`; `master_key_missing` → §1; `writer_list_empty` → `AI_CONFIG_WRITER_IDS` |

To'liq orqaga qaytish: `AI_CONFIG_UI_ENABLED=false` + ai-service'ni qayta yaratish — sof env
xulqi (DB qatorlari o'zgarmaydi). `ANTHROPIC_API_KEY` ai-service'ga ochiq qolishi shart
(`.env.ai-secrets`); slotlar env modellariga qaytadi (prod `AI_ORDER_MODEL`).

## 5. Master sir rotatsiyasi

1. Eski faylni `secrets/ai/ai_key_master.previous` ga ko'chiring; yangisini §1 dagidek yarating.
2. `.env.ai-secrets`: `AI_KEY_ENCRYPTION_SECRET_PREVIOUS_FILE=/run/secrets/ai/ai_key_master.previous`.
3. ai-service'ni qayta yarating → saqlangan kalitlar qayta shifrlanadi (`ai.key.reencrypt`),
   UI'da `master_key.rotation_pending = 0`.
4. `_PREVIOUS_FILE` ni olib tashlang, eski faylni xavfsiz o'chiring (`shred -u`), qayta yarating.

Master sir sizib chiqqan bo'lsa: rotatsiya **va** Anthropic kalitini almashtirish (eskisini
Console'da o'chirish) — Elchi kalitni Anthropic'da bekor qilmaydi.
