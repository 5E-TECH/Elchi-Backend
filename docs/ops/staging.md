# Staging (test server) — `dev → test → main`

> Maqsad: prod'ga chiqishdan oldin har reliz alohida test serverda, prod bilan
> **bir xil** deploy yo'li bilan tekshiriladi.
>
> ```
> dev ──(fast-forward)──► test ──► deploy-staging ──► test-api.elchipochta.uz
>                          │
>                          └─(fast-forward)──► main ──► deploy (prod) ──► api.elchipochta.uz
> ```
>
> **Hozirgi holat: kod tayyor, lekin O'CHIQ.** Server olingan (2026-10-28),
> §3–§5 bo'yicha sozlanadi. `test` branchi yo'q, `STAGING_ENABLED`
> o'rnatilmagan — shuning uchun hech narsa ishga tushmaydi va prod deploy
> avvalgidek ishlaydi (staging darvozasi ham o'chiq).

## 1. Nima qayerda

| Fayl | Vazifasi |
|---|---|
| `.github/workflows/deploy.yml` | `main` push → `deploy` (prod). `test` push → `deploy-staging` (faqat `vars.STAGING_ENABLED == 'true'` bo'lsa). Ikkalasi ham `test` + `unit-tests` (3 shard) yashil bo'lgandagina. `STAGING_ENABLED` yoqiq bo'lsa prod deploy **staging darvozasidan** o'tadi (§6.2). Deploy yarim yo'lda bekor qilinmaydi (`cancel-in-progress: false`), har run faqat o'z commitini deploy qiladi. Skript boshida env preflight (AFiXurLH: `POSTGRES_PASSWORD` ≥ 24, `SUPERADMIN_PASSWORD` ≥ 12, serverga tegilmasdan), gateway almashgach readiness darvozasi (hamma servis ok bo'lmasa rollback). |
| `scripts/staging/sync-deploy-workflow.mjs` | `deploy-staging` skripti prod skriptidan **generatsiya qilinadi** (qo'lda tahrirlanmaydi). Prod skript o'zgarsa: `node scripts/staging/sync-deploy-workflow.mjs` → commit. CI (`ci.yml`, «Staging deploy is in sync») farq bo'lsa qizil. |
| `docker-compose.staging.yml` | prod compose ustidan override: `.env.staging`, 8 GB ga mos xotira chegaralari, `elchi-staging` loyiha nomi (volume/network), `elchi-stg-*` konteyner nomlari, boshqa localhost portlar, o'z tunnel tokeni, backup faqat lokal. |
| `.env.staging.example` | `.env.staging` shabloni (hamma kalit + staging qiymatlari). CI (`ci.yml`, «Staging deploy is in sync») `.env.example` dagi har kalit shu yerda borligini tekshiradi. Funksiya kalitlari (`…_ENABLED`, `SALE_PRICING_ENGINE`, `FINANCE_*`) serverdagi `.env.staging` da prod qiymati bilan bir xil bo'lsin. Istisno: `FILE_OWNERSHIP_ENFORCE` — `docker-compose.staging.yml` uni `on` qiladi (egalik qoidasi prod'dan oldin shu yerda sinaladi). |
| `scripts/staging/bootstrap-server.sh` | yangi serverni bir marta tayyorlash (idempotent). |
| `scripts/staging/restore-anonymize.sh` (+ `anonymize.sql`) | prod nusxasini staging'ga tiklash va anonimlashtirish — alohida ish (staging-safe), §8. |

`deploy-staging` prod skriptidan faqat shular bilan farq qiladi: branch `test`,
`.env.staging`, har `docker compose` chaqiruvida `-f docker-compose.staging.yml`,
`/tmp/elchi-stg-*`, va boshidagi himoyalar:

- papkada `.env.production` bo'lsa yoki `.env.staging` bo'lmasa — **rad etadi**
  (staging secret xato bo'lib prod serverga ulansa ham hech narsaga tegmaydi);
- `.env.staging` da `__REPLACE_WITH…__` qolgan bo'lsa — rad etadi;
- Docker Compose < 2.24.4 bo'lsa — rad etadi (`!override` kerak);
- birorta app konteyneri yo'q bo'lsa (yangi server) — hammasini deploy qiladi.

Compose'ni serverda qo'lda ishlatganda doim:

```bash
cd /opt/elchi-staging
DC="docker compose --env-file .env.staging -f docker-compose.prod.yml -f docker-compose.staging.yml"
$DC ps
$DC logs --tail 50 api-gateway
```

## 2. Server talabi

- **≥ 4 vCPU, 8 GB RAM, 80–100 GB SSD**, Ubuntu **24.04 LTS**, public IPv4
  (prod: ~11 GB RAM). Kirish portlari: faqat SSH. API tashqariga faqat
  Cloudflare Tunnel (chiquvchi ulanish) orqali chiqadi.
- 15 image'ni 8 GB da build qilish uchun bootstrap 4 GB swap qo'shadi.
- Xotira chegaralari (`docker-compose.staging.yml`): gateway/order/finance
  768m, qolgan servislar 512m, postgres 1536m, rabbitmq 768m, minio 512m,
  cloudflared 256m (x2). OOM-kill bo'lsa (`docker inspect … OOMKilled`) — shu yerda
  oshiring.

## 3. Serverni tayyorlash (bir marta)

1. **GitHub Actions uchun SSH kalit** — O'Z kompyuteringizda (serverda emas):
   ```bash
   ssh-keygen -t ed25519 -N '' -C elchi-staging-actions -f ~/.ssh/elchi-staging-actions
   ```
   `~/.ssh/elchi-staging-actions` (private) → keyin GitHub secret
   `SSH_PRIVATE_KEY` ga (§5); `.pub` → serverga.
2. **Bootstrap** (root bilan):
   ```bash
   scp scripts/staging/bootstrap-server.sh root@<IP>:
   ssh root@<IP> "ACTIONS_PUBKEY='$(cat ~/.ssh/elchi-staging-actions.pub)' bash bootstrap-server.sh"
   ```
   Skript: Docker (Docker'ning rasmiy apt repo'sidan), `deploy` foydalanuvchisi
   (docker guruhida), Actions kaliti, `ufw` (faqat SSH), `fail2ban`, swap. Qayta ishga tushirish xavfsiz — bor narsaga
   tegmaydi. O'zgartirish: `DEPLOY_USER`, `APP_DIR` (sukut
   `/opt/elchi-staging`), `SSH_PORT`, `SWAP_SIZE`, `REPO_URL`, `REPO_BRANCH`.
3. **Repo kirishi.** Repo ochiq (public): server uni HTTPS orqali kalitsiz
   oladi (`REPO_URL` sukuti, prod ham shunday) — deploy key kerak emas
   (5E-TECH'da deploy key'lar baribir o'chiq). Repo yopiq qilinsa: tashkilotda
   deploy key'larni yoqish, bootstrap'ni
   `REPO_URL=git@github.com:5E-TECH/Elchi-Backend.git` bilan qayta ishga
   tushirish, chiqqan kalitni GitHub → Settings → Deploy keys ga
   **Allow write access — O'CHIQ** bilan qo'shish va serverda
   `git remote set-url origin` — prod uchun ham xuddi shunday.
4. `test` branchi bo'lishi kerak (§6.1). So'ng bootstrap'ni yana bir marta
   ishga tushiring — repo `/opt/elchi-staging` ga klonlanadi,
   `.env.staging` shablondan (chmod 600) va `backups/` (egasi `deploy`) yaratiladi.
5. **`.env.staging` ni to'ldiring** (`sudo -u deploy nano /opt/elchi-staging/.env.staging`):
   - har `__REPLACE_WITH…__` → yangi qiymat (`openssl rand -hex 32` /
     `openssl rand -hex 24`); `POSTGRES_URI` dagi parol = `POSTGRES_PASSWORD`;
   - `SMS_CREDENTIAL_SECRET`, `OTP_HASH_SECRET`, `TELEGRAM_WEBHOOK_SECRET` — yangi;
   - `STAGING_TUNNEL_TOKEN` — §4;
   - `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME` — test bot (§4.3) yoki `replace_me` (bot o'chiq);
   - `STAGING_*_ALLOWLIST` — test qiluvchilarning raqamlari / chat id / user id.
   ⚠️ **Prod'dan HECH BIR secret ko'chirilmaydi.** Ayniqsa `ACCESS_TOKEN_KEY`
   bir xil bo'lsa staging tokeni prod'da ham o'tadi. `SMS_CREDENTIAL_SECRET` va
   `INTEGRATION_CREDENTIAL_SECRET` boshqacha bo'lgani uchun prod nusxasidagi
   Eskiz/hamkor kredensiallari staging'da ochilmaydi — bu ataylab.
6. **MinIO image.** `minio/minio` Docker Hub'da yo'q (2026-10-30: repo 404) va
   compose'da `pull_policy: never` (qUEE0Bgd): image serverda birinchi deploy'dan
   OLDIN bo'lishi shart, aks holda `up` yiqiladi. Prod'dan ko'chiring:
   ```bash
   # prod'da
   docker save minio/minio:latest | gzip > /root/minio-image.tar.gz
   # o'z kompyuteringiz orqali staging'ga, so'ng staging'da
   gunzip -c minio-image.tar.gz | docker load
   ```

## 4. Cloudflare

1. **Tunnel**: Zero Trust → Networks → Tunnels → Create → Cloudflared →
   nom `elchi-staging` (prod tunnelidan ALOHIDA). Token → `.env.staging` dagi
   `STAGING_TUNNEL_TOKEN`. (Prod `TUNNEL_TOKEN` staging'da baribir e'tiborga
   olinmaydi.) Prod kabi 2 ta connector (`elchi-stg-cloudflared`,
   `elchi-stg-cloudflared-2`) — ikkalasi shu bitta staging tokeni bilan.
2. **Public hostname** (shu tunnelda): `test-api.elchipochta.uz` → Service
   `HTTP` → `api-gateway:3004`. DNS CNAME'ni Cloudflare o'zi yaratadi.
3. **Telegram test bot** (BotFather): `/newbot` → masalan `elchi_test_bot` →
   token `TELEGRAM_BOT_TOKEN` ga, username `TELEGRAM_BOT_USERNAME` ga,
   `TELEGRAM_WEBHOOK_SECRET` — yangi. Webhook birinchi deploydan keyin —
   docs/ops/telegram-bot.md §3 (4–5-qadam), `.env.staging` qiymatlari bilan
   (`TELEGRAM_WEBHOOK_URL=https://test-api.elchipochta.uz/telegram/webhook/elchi`).
   Prod bot tokeni staging'ga HECH QACHON qo'yilmaydi.
4. **test-admin.elchipochta.uz** — frontend (Elchi-Frontend, Cloudflare Pages):
   `test` branchi deploy'iga custom domain va API manzili
   `https://test-api.elchipochta.uz`. Bu FE tomoni; backend CORS'i
   (`CORS_ORIGINS`) allaqachon shu ikkala domenga sozlangan.
5. (Ixtiyoriy) Zero Trust → Access bilan `test-admin` ni faqat jamoaga ochish.

## 5. GitHub (repo admini, bir marta)

1. **Environment `staging`**: Settings → Environments → New environment →
   `staging`.
   - Deployment branches and tags → **Selected branches** → `test`.
   - Environment secrets (nomlari prod bilan bir xil, qiymatlari staging'niki):
     `SERVER_IP`, `SERVER_SSH_PORT` (22), `SERVER_USER` (`deploy`),
     `SERVER_APP_PATH` (`/opt/elchi-staging`), `SSH_PRIVATE_KEY`
     (`~/.ssh/elchi-staging-actions` fayli to'liq).
2. **Environment `production`** ni tekshiring: Deployment branches → faqat
   `main`. Prod `SERVER_*` secret'lari **repository** darajasida bo'lsa —
   ularni `production` environment'ga ko'chiring: staging environment'da
   biror secret yetishmasa GitHub repository secret'ini oladi (deploy skripti
   prod papkada baribir rad etadi, lekin ularni ajratib qo'ygan ma'qul).
3. **Yoqish**: Settings → Secrets and variables → Actions → **Variables** →
   **Repository variables** → `STAGING_ENABLED` = `true`. (Environment
   variable bo'lmasin — job darajasidagi `if` uni ko'rmaydi.) O'chirish —
   `false` yoki o'chirib tashlash.
4. **Branch himoyasi** (Settings → Rules → Rulesets, yoki Branches):
   - `main` va `test`: Restrict deletions, Block force pushes, **Require
     linear history** (faqat fast-forward). Push qilish huquqi — faqat reliz
     qiluvchilar (bypass list).
   - `test` ga PR ochilsa CI (`ci.yml`) ishlaydi; `test` va `main` ga
     to'g'ridan-to'g'ri push faqat §6 dagi fast-forward reliz uchun.
   - `dev` — hozirgidek.

## 6. Reliz oqimi

### 6.1 Birinchi marta

```bash
git fetch origin
git push origin origin/dev:refs/heads/test     # test branchini yaratadi
```

`STAGING_ENABLED=true` bo'lsa shu push birinchi staging deploy'ni boshlaydi
(server yangi → hamma servis build qilinadi, migratsiyalar ishlaydi).

### 6.2 Har reliz

```bash
git fetch origin
# 1) dev -> test: staging deploy (Actions → deploy-staging)
git push origin origin/dev:refs/heads/test
#    test-admin.elchipochta.uz da tekshirish (faqat TEST ma'lumot)
# 2) test -> main: prod deploy (Actions → deploy)
git push origin origin/test:refs/heads/main
```

- Ikkala push ham **fast-forward** — `--force` yo'q; tarix ajralgan bo'lsa
  git o'zi rad etadi. Natija: `main` = `test` = `dev` (bitta commit).
- **Staging darvozasi** (`deploy` job'ining birinchi qadami, faqat
  `STAGING_ENABLED=true` da): prod faqat test serverga **muvaffaqiyatli**
  chiqqan kodni oladi — commit'ning daraxti (tree) oxirgi 30 ta `staging`
  deployment'dan birortasining daraxtiga teng va u deployment `success`
  bo'lishi shart. Fast-forward ham, `test` → `main` merge commit (PR) ham
  o'tadi (kod bir xil). `main` ga to'g'ridan-to'g'ri push yoki `test` ni
  chetlab o'tgan PR — run qizil, serverga tegilmaydi.
- **Shoshilinch hotfix** ham `dev → test → main` yo'lidan o'tadi. Faqat test
  server ishlamay qolganda: `STAGING_ENABLED=false` (staging deploy ham,
  darvoza ham o'chadi) → `main` ga chiqarish → darhol `true` ga qaytarish.
- Har run faqat **o'z** commitini deploy qiladi: branch undan oldinga ketgan
  bo'lsa run «Superseded» deb hech narsa qilmay yashil tugaydi, keyingi
  (navbatda turgan) run yangi commitni o'z darvozasi bilan deploy qiladi.
  Eski run'ni "Re-run" qilish eski versiyani qaytarmaydi.
- Deploy yarim yo'lda bekor qilinmaydi: yangi push navbatda kutadi
  (navbatda faqat eng yangisi qoladi).

## 7. Rollback

- **Avtomatik** (prod bilan bir xil): deploy yiqilsa kod oldingi commitga
  qaytadi va servislar undan qayta build qilinadi; migratsiya qisman o'tgan
  bo'lsa — shu deploy'ning pre-deploy dumpi logda (`Pre-deploy backup: …`).
- **Kod**: `dev` da `git revert` → §6.2 (dev → test → main). `test`/`main` ga
  force-push qilinmaydi.
- **Shoshilinch (faqat staging)**: serverda
  `git reset --hard <yaxshi_sha> && $DC up -d --no-deps --build <servislar>` —
  keyingi deploy shu SHA'dan farqni hisoblaydi.
- **DB**: docs/ops/db-backups.md §5 — `DC` ni yuqoridagi staging `DC` bilan
  almashtiring; qo'lda dump:
  `BACKUP_COMPOSE_FILE=docker-compose.prod.yml:docker-compose.staging.yml COMPOSE_ENV_FILES=.env.staging BACKUP_DIR=./backups/manual BACKUP_PREFIX=manual bash scripts/backup-db.sh`.

## 8. Staging ma'lumotini yangilash (prod nusxasi → anonim)

Staging'da faqat **anonimlashtirilgan** prod nusxasi yoki sintetik TEST
ma'lumot bo'ladi.

1. Prod'da eng yangi kunlik dump: `ls -1 backups/daily | tail -1`.
2. Uni o'z kompyuteringiz orqali staging'ga `scp` bilan (uchinchi joyga —
   bulut, messenjer — HECH QACHON; dumpda shaxsiy ma'lumot bor).
3. Staging'da: `scripts/staging/restore-anonymize.sh` (staging-safe ishi —
   foydalanish, `STAGING_DEFAULT_PASSWORD` va saqlanadigan TEST
   akkauntlar skript sarlavhasida). Skript dumpni tiklaydi,
   `scripts/staging/anonymize.sql` + tekshiruvni bitta tranzaksiyada
   bajaradi; tekshiruv yiqilsa hammasi bekor qilinadi.
4. Tiklangan dump faylini serverdan o'chiring.
5. MinIO fayllari (rasmlar, cheklar) ko'chirilmaydi — staging'da ular bo'sh.

## 9. Xavfsizlik qoidalari (qisqa)

- `APP_ENV=staging` va `SENTRY_ENVIRONMENT=staging` compose override'da
  majburiy — `.env.staging` xato to'ldirilsa ham SMS/Telegram/push faqat
  allowlist'ga (bo'sh = hech kimga), AI faqat `STAGING_AI_ENABLED=true` bilan.
- `TUNNEL_TOKEN`, `R2_*`, `BACKUP_S3_TARGET` staging'da e'tiborga olinmaydi —
  faqat `STAGING_TUNNEL_TOKEN`, `STAGING_R2_*`, `STAGING_BACKUP_S3_TARGET`.
  R2 off-site nusxa sukut o'chiq; yoqilsa — alohida bucket va token.
- Backup: kunlik (05:00, 7 ta) va pre-deploy (5 ta) — faqat serverda.
- Prod va staging bitta hostda bo'lib qolsa ham to'qnashmaydi: loyiha nomi
  `elchi-staging`, konteynerlar `elchi-stg-*`, localhost portlar: postgres
  5433, rabbitmq 5673/15673, minio 9100/9101 (SSH tunnel bilan kirish).
