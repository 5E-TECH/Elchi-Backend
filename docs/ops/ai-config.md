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
#   ANTHROPIC_API_KEY=...   (server kaliti — faqat shu yerda; ko'chirish — §6)
```

Deploy preflight: `.env.production` / `.env.staging` da `AI_KEY_ENCRYPTION_SECRET*`,
`ANTHROPIC_BASE_URL` yoki qiymati bor `ANTHROPIC_API_KEY` bo'lsa — deploy RAD etiladi,
hech narsaga tegilmaydi (audit 2026-11-22 #15: u yerda kalit ~20 konteynerga, jumladan
internetga ochiq api-gateway'ga ham tarqaladi). Bo'sh `ANTHROPIC_API_KEY=` o'tadi.

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

## 6. Server kalitini umumiy env fayldan ko'chirish (bir martalik, audit 2026-11-22 #15)

Deploy preflight `.env.production` / `.env.staging` da qiymati bor `ANTHROPIC_API_KEY` ni rad
etadi (§1). Kalit hali o'sha yerda bo'lsa — shu tartibda ko'chiring va bir vaqtning o'zida
**almashtiring** (eski kalit ~20 konteyner env'ida va `.env*.bak` nusxalarida qolgan).

Ta'sir: faqat ai-service ~1 daqiqa qayta ishga tushadi (o'sha paytdagi AI so'rov xato
berishi mumkin, qayta urinish ishlaydi) — sokin vaqtda qiling. Boshqa konteynerlarga
tegilmaydi. Oddiy deploy buni o'zi qilmaydi: u faqat kodi o'zgargan servislarni qayta
yaratadi. Kalit qiymati hech qayerda ekranga yoki logga chiqmaydi.

> ⚠️ Env fayl o'zgargach `$DC up -d` ni servis nomisiz ishlatmang: `env_file` i o'zgargan
> hamma konteyner (cloudflared tunneli ham) qayta yaratiladi — to'liq uzilish.

0. Console'da **yangi** kalit (staging — alohida workspace, §2). Eskisi 7-qadamgacha
   o'chirilmaydi. UI'da («AI kalit va modellar») ham shu eski kalit qo'shilgan bo'lsa, uni
   ham almashtiring.
1. Deploy foydalanuvchisi (env fayl egasi) bilan, bash'da, qolgan hamma qadam **bitta
   oynada** (o'zgaruvchilar keyingi qadamlarda kerak):

```bash
# prod:
cd /home/shodiyor/apps/backend
ENVF=.env.production SECF=.env.ai-secrets HEALTH=https://api.elchipochta.uz/health
DC="docker compose -f docker-compose.prod.yml"
# staging — yuqoridagi uch qator o'rniga:
# cd /opt/elchi-staging
# ENVF=.env.staging SECF=.env.staging.ai-secrets HEALTH=https://test-api.elchipochta.uz/health
# DC="docker compose --env-file .env.staging -f docker-compose.prod.yml -f docker-compose.staging.yml"
id -un; stat -c '%U:%G %a %n' "$ENVF" .env "$SECF" 2>&1
grep -nE '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=' "$ENVF" .env "$SECF" 2>/dev/null | cut -d= -f1
grep -E '^AI_CONFIG_UI_ENABLED=' "$ENVF"
$DC ps ai-service; curl -s "$HEALTH"; echo
```

2. Zaxira (faqat sizga o'qiladigan papka):

```bash
BK=~/elchi-ops/ai-key-move-$(date +%Y%m%d-%H%M)
install -d -m 0700 "$BK"
for f in "$ENVF" .env "$SECF"; do [ -f "$f" ] && [ ! -L "$f" ] && cp -p "$f" "$BK"/; done
ls -la "$BK"
```

3. Yangi kalit — blokni to'liq qo'yib Enter, keyin kalitni qo'yib (ko'rinmaydi) Enter.
   Format xato, admin/obuna kaliti yoki eski kalit bo'lsa hech narsa yozilmaydi:

```bash
{
printf 'Yangi kalit (ekranda korinmaydi): '; IFS= read -rs K; echo
OLD=$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=//p' "${ENVF:-/yoq}" 2>/dev/null | tail -n 1)
if [ ! -d "${BK:-/yoq}" ] || [ -z "${ENVF:-}" ] || [ -z "${SECF:-}" ]; then
  echo "XATO: 1- va 2-qadamni shu oynada bajaring; hech narsa yozilmadi"
elif ! printf %s "$K" | grep -qE '^sk-ant-[A-Za-z0-9_-]{33,249}$' || printf %s "$K" | grep -qE '^sk-ant-(admin|oat|ort)'; then
  echo "XATO: kalit formati noto'g'ri - hech narsa yozilmadi"
elif [ "$K" = "$OLD" ]; then
  echo "XATO: bu ESKI kalit - Console'da yangisini yarating; hech narsa yozilmadi"
else
  [ -e "$SECF" ] || install -m 600 /dev/null "$SECF"
  chmod 600 "$SECF"
  T=$(mktemp "$BK/secrets.XXXXXX")
  grep -vE '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=' "$SECF" > "$T"
  printf 'ANTHROPIC_API_KEY=%s\n' "$K" >> "$T"
  [ -s "$T" ] && cat "$T" > "$SECF" && echo "OK: $SECF yozildi (${#K} belgi)"
  rm -f "$T"
fi
unset K OLD
}
```

4. Eski qatorni umumiy env fayldan (va `.env` alohida fayl bo'lsa — undan ham) olib
   tashlash. Egasi va huquqlari o'zgarmaydi; compose `${ANTHROPIC_API_KEY}` ni hech qayerda
   ishlatmaydi:

```bash
for f in "$ENVF" .env; do
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  grep -qE '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=' "$f" || { echo "$f: kalit qatori yo'q"; continue; }
  T=$(mktemp "$BK/env.XXXXXX") || continue
  grep -vE '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=' "$f" > "$T"
  [ -s "$T" ] && cat "$T" > "$f" && echo "$f: kalit qatori olib tashlandi"
  rm -f "$T"
done
grep -cE '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=' "$ENVF" .env "$SECF" 2>/dev/null
stat -c '%U:%G %a %n' "$SECF"
$DC config --quiet && echo "compose: OK"
```

   Kutiladi: `$ENVF:0`, `.env:0`, `$SECF:1`, huquq `600`, egasi deploy foydalanuvchisi
   (boshqa bo'lsa: `sudo chown --reference="$ENVF" "$SECF"`), `compose: OK`.

5. Faqat ai-service'ni qayta yaratish (`--no-deps` — postgres/rabbitmq va boshqa servislarga
   tegilmaydi; `--no-build` — hozirgi image):

```bash
$DC up -d --no-deps --no-build --force-recreate ai-service
for i in $(seq 1 24); do
  s=$(docker inspect -f '{{.State.Health.Status}}' "$($DC ps -q ai-service)")
  echo "$((i*5)) s: $s"; [ "$s" = healthy ] && break; sleep 5
done
```

6. Tekshirish — fayldagi va konteynerdagi kalitning faqat sha256 hash'i solishtiriladi:

```bash
F=$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$SECF" | tail -n 1 | tr -d '\r\n' | sha256sum | cut -d' ' -f1)
C=$($DC exec -T ai-service node -e "process.stdout.write(require('crypto').createHash('sha256').update(process.env.ANTHROPIC_API_KEY||'').digest('hex'))")
[ -n "$C" ] && [ "$F" = "$C" ] && echo "OK: ai-service yangi kalitni oldi" || echo "XATO: ai-service'dagi kalit fayldagidan farq qiladi"
unset F C
$DC logs --since 5m ai-service 2>&1 | grep -iE "error|o'chiq|ANTHROPIC" | tail -n 20
curl -s "$HEALTH"; echo
```

   Health'da `"ai":"enabled"` (1–2 daqiqada; avval `unknown` normal). Keyin kabinetda TEST
   market bilan bitta AI buyurtma. `AI_CONFIG_UI_ENABLED=true` va UI kaliti bor bo'lsa, AI
   UI kalitidan ishlaydi — server kalitini yuqoridagi `OK` tasdiqlaydi.

7. Shundan keyingina eski kalitni Console'da o'chiring va yana bitta AI buyurtma. Eski kalit
   qolgan konteynerlar (faqat nomlar) — bekor qilingan kalit zararsiz, ular keyingi
   deploy'larda qayta yaratilganda yo'qoladi:

```bash
for c in $(docker ps -q); do
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -q '^ANTHROPIC_API_KEY=' && docker inspect -f '{{.Name}}' "$c"
done
```

**Orqaga qaytarish** (5–6-qadam muvaffaqiyatsiz, eski kalit hali o'chirilmagan). Yangi
oynada avval 1-qadam va `BK=$(ls -d ~/elchi-ops/ai-key-move-* | tail -n 1)`:

```bash
if [ -d "${BK:-/yoq}" ] && [ -n "${ENVF:-}" ] && [ -n "${SECF:-}" ]; then
  for f in "$ENVF" .env; do [ -f "$BK/$f" ] && cat "$BK/$f" > "$f"; done
  if [ -f "$BK/$SECF" ]; then cat "$BK/$SECF" > "$SECF"; else rm -f "$SECF"; fi
  $DC up -d --no-deps --no-build --force-recreate ai-service
else
  echo "XATO: avval 1-qadam va BK"
fi
```

**Tozalash** (1–2 kun barqaror ishlagandan keyin):

```bash
BK=$(ls -d ~/elchi-ops/ai-key-move-* | tail -n 1); shred -u "$BK"/.env* && rmdir "$BK"
```

Keyingi oddiy deploy'da `db-backup` / `backup-offsite` umumiy env fayl o'zgargani uchun o'zi
qayta yaratiladi — kutilgan, API'ga ta'sir qilmaydi.
