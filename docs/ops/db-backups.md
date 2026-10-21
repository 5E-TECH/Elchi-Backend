# Elchi DB backup'lari — kunlik va deploy oldidan

> Talab (Elchi Pochta, "Avtomatik backup tizimi"): har kuni 05:00 da backup,
> oxirgi 7 kunlik saqlanadi; har bir deploydan oldin backup, oxirgi 5 tasi
> saqlanadi. Eskilari avtomatik o'chiriladi.

## 1. Qayerda nima

Hammasi serverdagi repo ildizida (`$SERVER_APP_PATH`), `./backups/` ichida
(git-ignored, fayllar `0600`, root).

| Tur | Qachon | Papka | Fayl nomi | Saqlanadi | Kim yozadi |
|---|---|---|---|---|---|
| Kunlik | har kuni **05:00 Asia/Tashkent** (= 00:00 UTC; server Berlin vaqtida 02:00 yozda / 01:00 qishda) | `backups/daily/` | `elchi-daily-YYYYMMDDTHHMMSSZ.sql.gz` | oxirgi **7** ta | `db-backup` konteyneri — `scripts/backup-cron.sh` |
| Deploy oldidan | **har bir** deploy, hech bir image/konteyner/migratsiyaga tegilmasdan oldin | `backups/pre-deploy/` | `pre-deploy-YYYYMMDDTHHMMSSZ-<eski7>-to-<yangi7>.sql.gz` | oxirgi **5** ta | `deploy.yml` → `scripts/pre-deploy-backup.sh` |
| Eski (2026-10-21 gacha) | faqat migratsiyali deploylarda edi | `backups/pre-migration/` | `pre-migration-*.sql.gz` | tegilmaydi, yangisi yozilmaydi | — (kerak bo'lmay qolganda qo'lda o'chiring) |

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

## 3. Sozlash

`.env.production` ga yoziladi (`docker-compose.prod.yml` `environment:` ga
EMAS — u env_file'dan ustun turib, qiymatni jim bekor qiladi):

| O'zgaruvchi | Sukut | Ma'nosi |
|---|---|---|
| `BACKUP_DAILY_AT` | `05:00` | kunlik backup vaqti (HH:MM) |
| `BACKUP_TZ` | `Asia/Tashkent` | shu vaqtning zonasi (noma'lum zona → ogohlantirish + Asia/Tashkent, hech qachon jim UTC emas) |
| `BACKUP_DAILY_KEEP` | `7` | nechta kunlik dump saqlanadi |
| `BACKUP_RETRY_SECONDS` | `900` | xatodan keyin qayta urinish |
| `BACKUP_S3_TARGET` | — | ixtiyoriy off-box nusxa (pastga qarang) |
| `POSTGRES_URI` | (bor) | `db-backup` ulanishi — servislar ishlatadigan o'sha qiymat |

Pre-deploy soni (`5`) skriptda (`BACKUP_PRE_DEPLOY_KEEP`, deploy shell env).
O'zgartirgandan keyin:
`docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate db-backup`.

⚠️ Off-box: `postgres:15` image'da `aws`/`mc` yo'q, shuning uchun
`BACKUP_S3_TARGET` hozir faqat ogohlantirish beradi ("local-only"). Dumplar DB
bilan bir diskda — disk yo'qolsa ular ham yo'qoladi. Off-box uchun alohida
ish kerak (masalan, hostda `backups/daily` ni boshqa joyga sinxronlash).

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
