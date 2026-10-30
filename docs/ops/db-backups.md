# Elchi DB backup'lari — kunlik, deploy oldidan va off-site (Cloudflare R2)

> Talab (Elchi Pochta, "Avtomatik backup tizimi"): har kuni 05:00 da backup,
> oxirgi 7 kunlik saqlanadi; har bir deploydan oldin backup, oxirgi 5 tasi
> saqlanadi. Eskilari avtomatik o'chiriladi.
>
> Off-site: dumplar DB bilan bir VPS da (Contabo o'chib qolishlari bo'lgan) —
> shuning uchun har soatda nusxasi VPS dan tashqariga, Cloudflare R2 ga
> chiqariladi (§6).
>
> Fayllar (MinIO) zaxirasi — [minio-backups.md](minio-backups.md); RPO/RTO,
> oylik tiklash mashqi va nosog'lom backup alerti — [backup-rpo-rto.md](backup-rpo-rto.md).

## 1. Qayerda nima

Hammasi serverdagi repo ildizida (`$SERVER_APP_PATH`), `./backups/` ichida
(git-ignored, fayllar `0600`, root).

| Tur | Qachon | Papka | Fayl nomi | Saqlanadi | Kim yozadi |
|---|---|---|---|---|---|
| Kunlik | har kuni **05:00 Asia/Tashkent** (= 00:00 UTC; server Berlin vaqtida 02:00 yozda / 01:00 qishda) | `backups/daily/` | `elchi-daily-YYYYMMDDTHHMMSSZ.sql.gz` | oxirgi **7** ta | `db-backup` konteyneri — `scripts/backup-cron.sh` |
| Deploy oldidan | **har bir** deploy, hech bir image/konteyner/migratsiyaga tegilmasdan oldin | `backups/pre-deploy/` | `pre-deploy-YYYYMMDDTHHMMSSZ-<eski7>-to-<yangi7>.sql.gz` | oxirgi **5** ta | `deploy.yml` → `scripts/pre-deploy-backup.sh` |
| Eski (2026-10-21 gacha) | faqat migratsiyali deploylarda edi | `backups/pre-migration/` | `pre-migration-*.sql.gz` | tegilmaydi, yangisi yozilmaydi | — (kerak bo'lmay qolganda qo'lda o'chiring) |
| **Off-site (R2)** | har soatda — yuqoridagi uchala papkadagi YANGI dumplar | `r2:elchi-db-backups/{daily,pre-deploy,pre-migration}/` | lokal nom bilan bir xil | **30 kun** (dump vaqtidan) | `backup-offsite` konteyneri — `scripts/backup-offsite.sh` |

- Nomdagi vaqt **UTC** (`Z`): 05:00 Toshkent → `…T0000xxZ`. Nom tartibi = vaqt
  tartibi; rotatsiya nom bo'yicha.
- Saqlash **soni bo'yicha**, yoshi bo'yicha emas: server bir necha kun o'chiq
  turgan bo'lsa ham oxirgi 7 ta yaxshi dump qoladi ("7 kundan eski" hammasi
  o'chib ketmaydi).
- Pre-deploy fayl nomidagi `<eski7>-to-<yangi7>` — shu dump qaysi deployni
  himoya qilganini bildiradi (dump `<eski7>` holati).

## 2. Qanday ishlaydi

**Har bir dump** (`scripts/backup-db.sh`): yashirin `.<nom>.partial.<pid>` ga
yoziladi va faqat hammasi o'tsa atomik `mv` bilan `<nom>.sql.gz` bo'ladi:
`pg_dump` exit 0, gzip oqimi butun, ≥ 1 KB, oxirida pg_dump'ning
`-- PostgreSQL database dump complete` qatori bor. Muvaffaqiyatsiz run **hech
narsani o'chirmaydi** va yarim fayl qoldirmaydi; rotatsiya faqat yaxshi dumpdan
keyin, o'sha papka + prefiks ichida.

**Kunlik** (`db-backup`): keyingi 05:00 gacha uxlaydi (BACKUP_TZ har doim
aniq beriladi — server zonasi ahamiyatsiz), soatiga bir marta qayta tekshiradi.
Oxirgi 05:00 uchun dump yo'q bo'lsa (birinchi start, 05:00 da konteyner o'chiq,
xato) — darhol oladi. Xato bo'lsa har 15 daqiqada qayta urinadi.
Healthcheck: eng yangi kunlik dump 26 soatdan eski bo'lsa `docker ps` da
`(unhealthy)`.

**Deploy** (`.github/workflows/deploy.yml`):
1. yangi kod checkout → **pre-deploy backup** (gate). Postgres ishlayotgan
   konteyneri orqali: `docker compose exec -T postgres pg_dump`.
2. Backup muvaffaqiyatsiz → deploy to'xtaydi, **hech bir konteynerga
   tegilmaydi**, kod `OLD_SHA` ga qaytariladi, job qizil.
3. Shu dump — migratsiyaning tiklash nuqtasi (ikkinchi dump olinmaydi). Deploy
   logida: `Pre-deploy backup: /…/backups/pre-deploy/…sql.gz`; rollback bo'lsa
   xabar aynan shu faylni ko'rsatadi.
4. Oxirida `db-backup` ko'tariladi (yo'q bo'lsa yaratiladi; skriptlari
   o'zgarsa qayta yaratiladi) va ishlayotgani tekshiriladi. Ishlamasa deploy
   rollback **qilinmaydi**, lekin job qizil bo'ladi ("daily backups are OFF").
   Postgres konteyneri umuman yo'q bo'lsa (yangi server) backup o'tkazib
   yuboriladi; bor-u to'xtagan bo'lsa deploy to'xtaydi.
5. Keyin `backup-offsite` ham `up -d` qilinadi (birinchi deployda yaratiladi;
   compose ta'rifi yoki `.env.production` o'zgarsa compose o'zi qayta
   yaratadi; `scripts/backup-offsite.sh` o'zgarsa `--force-recreate`). Bu
   **gate emas**: deploy uning health'ini kutmaydi, ishga tushmasa faqat
   `WARNING: backup-offsite … did not start` chiqadi — rollback ham, qizil job
   ham yo'q.

## 3. Sozlash

`.env.production` ga yoziladi (`docker-compose.prod.yml` `environment:` ga
EMAS — u env_file'dan ustun turib, qiymatni jim bekor qiladi):

| O'zgaruvchi | Sukut | Ma'nosi |
|---|---|---|
| `BACKUP_DAILY_AT` | `05:00` | kunlik backup vaqti (HH:MM) |
| `BACKUP_TZ` | `Asia/Tashkent` | shu vaqtning zonasi (noma'lum zona → ogohlantirish + Asia/Tashkent, hech qachon jim UTC emas) |
| `BACKUP_DAILY_KEEP` | `7` | nechta kunlik dump saqlanadi |
| `BACKUP_RETRY_SECONDS` | `900` | xatodan keyin qayta urinish |
| `BACKUP_S3_TARGET` | — | eski off-box ilgak (ishlamaydi, pastga qarang) — o'rniga R2 |
| `POSTGRES_URI` | (bor) | `db-backup` ulanishi — servislar ishlatadigan o'sha qiymat |
| `R2_ACCOUNT_ID` | — | Cloudflare account ID → endpoint `https://<id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | — | R2 API token'ning Access Key ID si |
| `R2_SECRET_ACCESS_KEY` | — | R2 API token'ning Secret Access Key si |
| `R2_BUCKET` | `elchi-db-backups` | bucket nomi |
| `R2_ENDPOINT` | — | ixtiyoriy: endpoint'ni to'liq berish (masalan EU jurisdiction bucket: `https://<id>.eu.r2.cloudflarestorage.com`) |
| `OFFSITE_INTERVAL_SECONDS` | `3600` | R2 sinxronlash oralig'i (min 60) |
| `OFFSITE_RETENTION_DAYS` | `30` | R2 dagi nusxa necha kun saqlanadi |
| `OFFSITE_ENCRYPTION_KEY` | — | ≥ 32 belgi: nusxalarni client-side shifrlash (§6.7). Bo'sh = o'chiq, eski xulq |

R2 kalitlaridan biri bo'sh (yoki `__REPLACE_WITH…__`) bo'lsa off-site o'chiq.

Pre-deploy soni (`5`) skriptda (`BACKUP_PRE_DEPLOY_KEEP`, deploy shell env).
O'zgartirgandan keyin:
`docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate db-backup`.

`BACKUP_S3_TARGET`: `postgres:15` image'da `aws`/`mc` yo'q, shuning uchun u
faqat ogohlantirish beradi ("local-only"). Off-site nusxa endi alohida
`backup-offsite` konteynerida (§6) — `BACKUP_S3_TARGET` ni bo'sh qoldiring.

## 4. Tekshirish

```bash
cd $SERVER_APP_PATH
ls -lh backups/daily backups/pre-deploy
docker compose -f docker-compose.prod.yml ps db-backup              # Up … (healthy)
docker compose -f docker-compose.prod.yml logs --tail 50 db-backup   # "next daily backup at … +05"
docker compose -f docker-compose.prod.yml exec db-backup bash /scripts/backup-cron.sh --next
docker compose -f docker-compose.prod.yml exec db-backup bash /scripts/backup-cron.sh --check

# Dump butunmi (prodga tegmaydi):
F=backups/daily/elchi-daily-….sql.gz
gzip -t "$F" && gzip -dc "$F" | tail -n 8    # "-- PostgreSQL database dump complete" bo'lishi shart
```

Qo'lda (ad-hoc) dump — kunlik/pre-deploy rotatsiyasiga kirmaydi:

```bash
BACKUP_COMPOSE_FILE=docker-compose.prod.yml BACKUP_DIR=./backups/manual BACKUP_PREFIX=manual \
  bash scripts/backup-db.sh
```

## 5. Tiklash (restore)

⚠️ Tiklash dumpdan keyingi BARCHA yozuvlarni (buyurtmalar, kassa) o'chiradi.
Rollback DB ni o'zi tiklamaydi — bu qaror odamniki.

1. **Faylni tanlang.** Deploy/migratsiya buzgan bo'lsa — deploy logidagi
   `Pre-deploy backup:` / rollback xabaridagi fayl (yoki
   `ls -1 backups/pre-deploy | tail -1`). Aks holda —
   `ls -1 backups/daily | tail -1`.
2. **Avval sinov bazaga tiklab ko'ring** (prod DB ga tegmaydi):
   ```bash
   F=backups/pre-deploy/pre-deploy-….sql.gz
   DC="docker compose -f docker-compose.prod.yml"
   $DC exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" restore_check'
   gzip -dc "$F" | $DC exec -T postgres sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d restore_check'
   $DC exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d restore_check -c "\dn"'
   $DC exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" restore_check'
   ```
3. **Haqiqiy tiklash:**
   ```bash
   F=backups/pre-deploy/pre-deploy-….sql.gz
   DC="docker compose -f docker-compose.prod.yml"
   # hozirgi holatni ham saqlab qo'ying
   BACKUP_COMPOSE_FILE=docker-compose.prod.yml BACKUP_DIR=./backups/manual BACKUP_PREFIX=before-restore \
     bash scripts/backup-db.sh
   # DB ga yozadiganlarni to'xtating (db-reconcile / activity-log-prune `$DC ps`
   # da ishlayotgan bo'lsa — ularni ham shu ro'yxatga qo'shing)
   SERVICES="api-gateway identity-service order-service catalog-service logistics-service finance-service notification-service integration-service analytics-service branch-service investor-service file-service c2c-service search-service ai-service"
   $DC stop $SERVICES
   # dump --clean --if-exists bilan olingan: mavjud obyektlarni tashlab, qayta yaratadi
   gzip -dc "$F" | $DC exec -T postgres sh -c 'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
   $DC start $SERVICES
   ```
   Migratsiyali deploy rollback bo'lgan bo'lsa kod allaqachon `OLD_SHA` da —
   tiklangan sxema unga mos.

Shu tartib (sinov bazaga va o'sha bazaning ustiga tiklash) `postgres:15`
(15.15) da lokal sinab ko'rilgan.

## 6. Off-site nusxa — Cloudflare R2 (`backup-offsite`)

### 6.1 Qanday ishlaydi

`backup-offsite` konteyneri (`rclone/rclone:1.68.2`, aniq tag) host'dagi
`./backups` ni **faqat o'qish uchun** (`:ro`) ko'radi va har
`OFFSITE_INTERVAL_SECONDS` (1 soat) da (`scripts/backup-offsite.sh`):

1. `daily/`, `pre-deploy/`, `pre-migration/` ichidagi `*.sql.gz` lardan
   (`OFFSITE_RETENTION_DAYS` dan yoshroqlari) R2 da hali YO'Q nomlarini
   `r2:<bucket>/<papka>/` ga yuklaydi — `rclone copy --ignore-existing
   --immutable`: R2 dagi obyekt **hech qachon ustidan yozilmaydi**. Yozilayotgan
   dump (`.…partial.<pid>`) hech qachon olinmaydi.
2. Yangi yuklanganlarini `rclone check` bilan lokal fayl bilan solishtiradi
   (o'lcham + MD5). Farq bo'lsa — run xato.
3. Hammasi o'tsa — R2 dagi 30 kundan eski nusxalarni o'chiradi (`rclone delete
   --min-age 30d`; yosh = dump faylining mtime'i, rclone uni har obyekt bilan
   saqlaydi). Faqat shu uch prefiks ichidagi `*.sql.gz`; bucket'dagi boshqa
   narsaga tegmaydi. ⚠️ Himoya: R2 `daily/` da 30 kundan yangi nusxa bo'lmasa
   (kunlik backup to'xtagan) **hech narsa o'chirilmaydi** — oxirgi off-site
   nusxalar qoladi, logda ogohlantirish.
4. Har run'da bitta log qatori:
   `[backup-offsite] ok @ …Z: uploaded 1 (daily=1 pre-deploy=0 pre-migration=0), pruned 1 older than 30d -> r2:elchi-db-backups`
   va konteyner ichida status fayl (`/tmp/backup-offsite/status`: `state`,
   `last_success_at`, `last_uploaded`, …).

Xato bo'lsa (tarmoq, noto'g'ri kalit, bucket yo'q) hech narsa o'chirilmaydi,
`ERROR: sync failed (…)` + rclone'ning oxirgi 3 qatori chiqadi, keyingi
intervalda qayta urinadi.

**Kalitlarsiz**: har intervalda
`WARNING: R2 sozlanmagan — off-site nusxa o'chiq (.env.production da yo'q: …)`
yozadi, status `disabled`, konteyner ishlab turaveradi (crash-loop yo'q) va
`healthy` hisoblanadi.

**Healthcheck** (`sh /scripts/backup-offsite.sh --check`, har 5 daqiqa):
o'chiq (kalitsiz) → healthy; sozlangan bo'lsa oxirgi muvaffaqiyatli sinxron
26 soatdan yangi → healthy; eski bo'lsa yoki birinchi run muvaffaqiyatsiz
tugagan bo'lsa → `(unhealthy)`. Deploy bu health'ni kutmaydi.

rclone **faqat env orqali** sozlanadi: skript `R2_*` dan
`RCLONE_CONFIG_R2_*` (`TYPE=s3`, `PROVIDER=Cloudflare`, `ENDPOINT`,
`REGION=auto`, `NO_CHECK_BUCKET=true`, kalitlar) ni o'zi eksport qiladi,
`RCLONE_CONFIG=""` — diskda `rclone.conf` yo'q, kalitlar logga chiqmaydi.

### 6.2 R2 ni sozlash (bir marta)

1. Cloudflare dashboard → **R2** → **Create bucket**: `elchi-db-backups`
   (Location: Automatic). Public access — o'chiq qoladi.
2. **R2 → Manage R2 API Tokens → Create API token**:
   - Permissions: **Object Read & Write**;
   - **Apply to specific buckets only** → `elchi-db-backups` (boshqa bucket'larga
     ruxsat YO'Q);
   - yaratilgandan keyin **Access Key ID** va **Secret Access Key** ni oling
     (secret faqat bir marta ko'rsatiladi). Account ID — R2 sahifasida yoki
     ko'rsatilgan endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` da.
3. Serverda (`$SERVER_APP_PATH`), avval zaxira: `cp .env.production .env.production.bak.$(date +%s)`,
   so'ng `.env.production` ga (qo'shtirnoqsiz):
   ```
   R2_ACCOUNT_ID=<account id>
   R2_ACCESS_KEY_ID=<access key id>
   R2_SECRET_ACCESS_KEY=<secret access key>
   R2_BUCKET=elchi-db-backups
   ```
4. Qo'llash: `docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate backup-offsite`
5. Tekshirish — §6.3. Birinchi run darhol boshlanadi.
6. ⚠️ R2 kalitlari (va DB parollari) — `.env.production` nusxasini VPS dan
   TASHQARIDA ham saqlang (parol menejeri): VPS butunlay yo'qolsa R2 dagi
   dumplarga faqat shu kalitlar bilan yetib boriladi.

### 6.3 Tekshirish

```bash
cd $SERVER_APP_PATH
DC="docker compose -f docker-compose.prod.yml"
$DC logs --tail 20 backup-offsite            # "[backup-offsite] ok @ …: uploaded N (daily=… …)"
$DC ps backup-offsite                        # Up … (healthy) — birinchi tekshiruv ~5 daqiqada
$DC exec backup-offsite sh /scripts/backup-offsite.sh --status
$DC exec backup-offsite sh /scripts/backup-offsite.sh --check
# R2 dagi nusxalar (o'lcham, vaqt, nom):
$DC exec backup-offsite sh /scripts/backup-offsite.sh rclone lsl r2:elchi-db-backups
# lokal 30 kunlik dumplar R2 da borligi va bir xilligi (o'lcham + MD5):
$DC exec backup-offsite sh /scripts/backup-offsite.sh rclone check /backups/daily r2:elchi-db-backups/daily --one-way --include '*.sql.gz' --max-age 30d
```

ℹ️ Oddiy `docker exec elchi-backup-offsite rclone lsl r2:…` ishlamaydi
(`didn't find section in config file`): `r2:` remote'ini skript `R2_*` dan
quradi, konteyner env'ida faqat `R2_*` bor. Compose `${…}` interpolatsiyasi
`.env` ni o'qiydi, `.env.production` ni emas (deploy `--env-file`
bermaydi), shuning uchun `RCLONE_CONFIG_R2_*` compose faylida berilmagan —
har doim `sh /scripts/backup-offsite.sh rclone …` o'rami orqali chaqiring.

Ishlamasa: `ERROR … list R2` + `SignatureDoesNotMatch`/`InvalidAccessKeyId` →
kalit noto'g'ri; `upload` + `NoSuchBucket` → bucket nomi/token bucket'i mos
emas; `AccessDenied` → token boshqa bucket'ga berilgan yoki faqat Read.

### 6.4 R2 dan tiklash

Lokal dumplar yo'q/buzilgan bo'lsa yoki yangi serverga ko'chilganda.

1. **Faylni tanlang:**
   ```bash
   cd $SERVER_APP_PATH
   DC="docker compose -f docker-compose.prod.yml"
   $DC exec backup-offsite sh /scripts/backup-offsite.sh rclone lsl r2:elchi-db-backups/daily
   ```
   Yangi serverda (repo + `.env.production` tiklangan, `$DC up -d postgres`
   qilingan): `exec` o'rniga
   `$DC run --rm --no-deps backup-offsite rclone lsl r2:elchi-db-backups/daily`.
2. **Vaqtinchalik papkaga yuklab oling** (`backup-offsite` da `/backups`
   read-only, shuning uchun bir martalik konteyner + yozsa bo'ladigan papka;
   rclone yuklashda MD5 ni o'zi tekshiradi):
   ```bash
   mkdir -p backups/from-r2 && chmod 700 backups/from-r2
   F=elchi-daily-….sql.gz            # yoki pre-deploy/… — papkasini ham moslang
   $DC run --rm --no-deps -v "$PWD/backups/from-r2:/restore" backup-offsite \
     rclone copy "r2:elchi-db-backups/daily/$F" /restore
   gzip -t "backups/from-r2/$F" && gzip -dc "backups/from-r2/$F" | tail -n 8   # "dump complete" bo'lishi shart
   ```
   Repo yo'q joyda (istalgan Docker bor mashina) — kalitlar faqat env'da:
   ```bash
   read -r R2_ACCOUNT_ID; read -r RCLONE_CONFIG_R2_ACCESS_KEY_ID; read -rs RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
   export RCLONE_CONFIG_R2_ACCESS_KEY_ID RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
   docker run --rm -v "$PWD:/restore" -e RCLONE_CONFIG= -e RCLONE_CONFIG_R2_TYPE=s3 \
     -e RCLONE_CONFIG_R2_PROVIDER=Cloudflare -e RCLONE_CONFIG_R2_REGION=auto \
     -e RCLONE_CONFIG_R2_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com" \
     -e RCLONE_CONFIG_R2_ACCESS_KEY_ID -e RCLONE_CONFIG_R2_SECRET_ACCESS_KEY \
     rclone/rclone:1.68.2 copy "r2:elchi-db-backups/daily/$F" /restore
   ```
3. **So'ng §5 dagi qadamlar** (avval sinov bazaga, keyin haqiqiy tiklash)
   `F=backups/from-r2/$F` bilan. Tugagach: `rm -rf backups/from-r2`.

### 6.5 Saqlash muddati va narx

- R2 da: dump vaqtidan **30 kun** (`OFFSITE_RETENTION_DAYS`) — ~30 kunlik +
  shu davrdagi pre-deploy dumplar. 30 kundan eski lokal dumplar (eski
  `pre-migration/`) umuman yuklanmaydi.
- Kunlik backup to'xtasa (R2 `daily/` da 30 kundan yangi nusxa yo'q) — prune
  to'xtaydi, eski nusxalar o'chmaydi.
- R2: saqlash ~$0.015/GB-oy (10 GB bepul), chiqish (egress) bepul; so'rovlar
  soatiga bir necha o'nta — bepul limit ichida.

### 6.6 Xavfsizlik va cheklovlar

- ⚠️ Token **Object Read & Write** — o'chirishga ham ruxsat bor. Server
  buzilsa, hujumchi `.env.production` dagi shu token bilan R2 dagi nusxalarni
  ham o'chirishi/ustidan yozishi mumkin. `--immutable`/`--ignore-existing`
  faqat bizning skriptni cheklaydi. Kelajakda: R2 **Bucket Lock** qoidasi
  (prefiks `daily/` va `pre-deploy/` uchun, masalan 29 kun — muddat
  `OFFSITE_RETENTION_DAYS` dan kamida 1 kun qisqa bo'lsin, aks holda prune
  xato beradi), yoki
  o'chirishni serverdan olib tashlab, muddatni R2 Object Lifecycle qoidasiga
  berish. R2 token turlarida "yozish-ha, o'chirish-yo'q" darajasi yo'q.
- `.env.production` hamma app konteynerlariga `env_file` bo'lib beriladi —
  R2 kaliti ham ularning env'ida bo'ladi (POSTGRES paroli kabi). Token faqat
  bitta bucket'ga cheklangani — asosiy himoya.
- `OFFSITE_ENCRYPTION_KEY` bo'lmasa dumplar client-side shifrlanmaydi (R2 o'zi
  at-rest shifrlaydi), ichida PII/pul ma'lumotlari — bucket public qilinmasin,
  token boshqa joyda ishlatilmasin. Shifrlash: §6.7.

### 6.7 Client-side shifrlash (6RaEn5cN, sukut o'chiq)

`OFFSITE_ENCRYPTION_KEY` berilsa `backup-offsite` va `backup-minio-offsite` nusxalarni
rclone `crypt` remote orqali yuklaydi: `r2:<bucket>/encrypted/{daily,pre-deploy,pre-migration}/<nom>.sql.gz.bin`
va `encrypted/minio/…` (kontent shifrlangan, nomlar ochiq). Tekshiruv `rclone cryptcheck`.
Kalit noto'g'ri (< 32 belgi) bo'lsa run xato bilan tugaydi, ochiq nusxaga qaytmaydi.

**Yoqish** (Dilshod, serverda):

1. `openssl rand -hex 32` — avval **parol menejeriga**: kalit yo'qolsa nusxalarni o'qib
   bo'lmaydi, VPS bilan birga yo'qolsa ham.
2. `.env.production` ga `OFFSITE_ENCRYPTION_KEY=<kalit>`, so'ng
   `docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate backup-offsite`.
3. MinIO cron nusxasini yangilash: `cp scripts/backup-minio-offsite.sh scripts/backup-minio-offsite-cron.sh ~/elchi-ops/`.
4. Tekshirish: logda `-> r2crypt:encrypted`;
   `$DC exec backup-offsite sh /scripts/backup-offsite.sh rclone lsl r2crypt:encrypted/daily`.
5. Ochiq nusxalar: `daily/`, `pre-deploy/`, `pre-migration/` dagilari muddat bo'yicha o'chadi (yangi
   shifrli kunlik nusxa bo'lgandagina); MinIO'ning ochiq `minio/` prefiksi — [minio-backups.md §2](minio-backups.md).

**Tiklash:** §6.4 dagi yo'l, faqat manba `r2crypt:encrypted/daily/$F` (`.bin` siz nom). `$DC run … backup-offsite`
o'rami kalitni `.env.production` dan oladi; rclone yuklashda shifrni ochadi va autentifikatsiya tegini
tekshiradi. Repo yo'q joyda: `RCLONE_CONFIG_R2CRYPT_TYPE=crypt`,
`RCLONE_CONFIG_R2CRYPT_REMOTE=r2:<bucket>`, `RCLONE_CONFIG_R2CRYPT_FILENAME_ENCRYPTION=off`,
`RCLONE_CONFIG_R2CRYPT_DIRECTORY_NAME_ENCRYPTION=false`, `RCLONE_CONFIG_R2CRYPT_PASSWORD="$(rclone obscure -)"`
(kalit stdin'dan).

Haqiqiy `rclone/rclone:1.68.2` bilan lokal S3 (rclone serve s3) ustida sinalgan: DB nusxa, MinIO sync,
versiya, prune, `restore-drill.sh`. R2'ning o'zida yoqilmagan.
