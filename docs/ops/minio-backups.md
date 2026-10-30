# MinIO (fayllar) zaxirasi — Cloudflare R2 ga off-site, versiyali nusxa

> Karta 6RaEn5cN. MinIO'da COD va xarajat dalillari, rasmlar (`elchi-files`
> bucket) — 2026-10-26 gacha umuman zaxiralanmagan. Endi har soatda VPS dan
> tashqariga, DB dumplari turgan o'sha R2 bucket'ga nusxalanadi.

## 1. Qayerda nima

| Nima | Qayerda |
|---|---|
| Manba | MinIO `elchi-files` (2026-10-26: 117 obyekt, 24,7 MB) |
| Joriy nusxa | `r2:<R2_BUCKET>/minio/elchi-files/current/` — MinIO'ning aynan ko'zgusi |
| Eski versiyalar | `r2:<R2_BUCKET>/minio/elchi-files/versions/<UTC run vaqti>/` — MinIO'da **ustidan yozilgan yoki o'chirilgan** obyekt shu yerga KO'CHADI (yo'qolmaydi) |
| Saqlash | `versions/` — **90 kun** (papka nomidagi vaqtdan), `current/` — doim |
| Jadval | har soat `:35` da (server cron, `dilshodbek` foydalanuvchisi) |
| Skriptlar | repo: `scripts/backup-minio-offsite.sh` (rclone konteynerida ishlaydi), `scripts/backup-minio-offsite-cron.sh` (host cron wrapper); serverda nusxasi: `~dilshodbek/elchi-ops/` |
| Holat / log | `~dilshodbek/elchi-ops/state/minio-offsite/status`, `~dilshodbek/elchi-ops/logs/minio-offsite.log` |
| Alert | `scripts/backup-alert.sh` (har 15 daqiqa) — [backup-rpo-rto.md §4](backup-rpo-rto.md) |

`R2_BUCKET` prod'da `elchipochtadatabase` (DB dumplari bilan bir bucket, boshqa
prefiks: `daily/`, `pre-deploy/`, `pre-migration/` — `backup-offsite` faqat
o'shalarga tegadi, `minio/` ga hech qachon).

## 2. Qanday ishlaydi

Bitta run (`backup-minio-offsite.sh`, `rclone/rclone:1.68.2`, compose tarmog'ida
`docker run --rm`, `--memory 256m`):

1. MinIO va R2 `current/` dagi obyektlar soni. **MinIO bo'sh, R2 da esa obyekt
   bor** bo'lsa — run rad etiladi, hech narsa ko'chirilmaydi (bo'sh ro'yxat —
   ko'pincha buzilgan MinIO, haqiqiy o'chirish emas).
2. `rclone sync minio:elchi-files r2:…/current --backup-dir r2:…/versions/<ts>
   --checksum --max-delete 50` — yangi/o'zgargan obyektlar yuklanadi; ustidan
   yozilgan/o'chirilgan obyektning eski nusxasi `versions/<ts>/` ga server
   tomonida ko'chadi. Bitta run 50 tadan ko'p obyektni `current/` dan chiqarmoqchi
   bo'lsa — to'xtaydi va xato beradi (ommaviy o'chirishdan himoya).
3. `rclone check` (o'lcham + MD5) — farq bo'lsa run xato.
4. Hammasi o'tsa — `versions/` dagi 90 kundan eski papkalar o'chiriladi (yosh
   papka NOMIDAN, obyekt mtime'idan emas; nom formati `YYYYMMDDTHHMMSSZ` bo'lmagan
   hech narsaga tegilmaydi).
5. Log qatori: `[minio-offsite] ok @ …Z: elchi-files=117obj/0new/0ver, 24722429 B, pruned 0 …`
   va `status` fayl (`state`, `last_success_at`, `objects`, `bytes`, …).

**MinIO faqat O'QISH uchun** ochiladi: alohida MinIO foydalanuvchisi
`elchi-backup-ro`, policy `elchi-backup-read` = `s3:ListBucket` +
`s3:GetBucketLocation` (`arn:aws:s3:::elchi-files`) + `s3:GetObject`
(`elchi-files/*`). Yozish urinishi — `403` (2026-10-26 tekshirilgan). Root
yoki ilova (readwrite) kaliti ishlatilmaydi, shuning uchun MinIO root/ilova
kalitlarini almashtirish bu zaxiraga ta'sir qilmaydi.

**Shifrlash**: R2 ga TLS orqali, R2 at-rest AES-256 (DB nusxalari bilan bir
xil daraja). Client-side shifrlash `OFFSITE_ENCRYPTION_KEY` bilan yoqiladi (sukut
o'chiq, [db-backups.md §6.7](db-backups.md)): nusxa
`r2:<R2_BUCKET>/encrypted/minio/elchi-files/{current,versions/<ts>}/` ga tushadi,
sync `--checksum` o'rniga o'lcham + mtime bilan solishtiradi, `rclone check` o'rniga
`rclone cryptcheck` (har run'da hamma obyektni MinIO'dan o'qiydi). Birinchi run hammasini
qayta yuklaydi. Eski ochiq `minio/` prefiksi o'zi o'chmaydi: birinchi `state=ok` dan
keyin qo'lda `mo purge r2:<R2_BUCKET>/minio`. Keyin `mo` buyruqlaridagi yo'llar
`r2crypt:encrypted/minio/…` bo'ladi, wrapper `.env.production` dan kalitni oladi.

**Kalitlar** (hech biri log/argv'ga chiqmaydi): cron wrapper Docker'ga
`--env-file` bilan beradi — `.env.production` dan FAQAT `R2_*` va `MINIO_ENDPOINT/
PORT/USE_SSL/BUCKET` qatorlari (DB/JWT kalitlari emas) + `~dilshodbek/elchi-ops/minio-backup.env`
(0600: `MINIO_BACKUP_ACCESS_KEY`, `MINIO_BACKUP_SECRET_KEY`). Keyinchalik bu
ikki kalitni `.env.production` ga ko'chirsa bo'ladi — wrapper ularni u yerdan
ham o'qiydi, `minio-backup.env` esa ixtiyoriy.

## 3. Sozlash (bir marta; 2026-10-26 da bajarilgan)

```bash
# serverda, docker guruhidagi foydalanuvchi
umask 077; mkdir -p ~/elchi-ops/{state,logs}; chmod 700 ~/elchi-ops
cp scripts/backup-minio-offsite.sh scripts/backup-minio-offsite-cron.sh scripts/backup-alert.sh ~/elchi-ops/
printf 'MINIO_BACKUP_ACCESS_KEY=elchi-backup-ro\nMINIO_BACKUP_SECRET_KEY=%s\n' "$(openssl rand -hex 24)" > ~/elchi-ops/minio-backup.env
# policy + user (sir stdin orqali; root kalitlari konteyner env'idan)
POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetBucketLocation","s3:ListBucket"],"Resource":["arn:aws:s3:::elchi-files"]},{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::elchi-files/*"]}]}'
printf '%s\n%s\n' "$(grep ^MINIO_BACKUP_SECRET_KEY= ~/elchi-ops/minio-backup.env | cut -d= -f2-)" "$POLICY" |
  docker exec -i elchi-minio bash -c 'read -r SEC; read -r POL; export MC_CONFIG_DIR=/tmp/.mc-$$
    export MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@127.0.0.1:9000"
    printf %s "$POL" > /tmp/p.json; mc admin policy create local elchi-backup-read /tmp/p.json
    mc admin user add local elchi-backup-ro "$SEC" >/dev/null
    mc admin policy attach local elchi-backup-read --user elchi-backup-ro; rm -rf $MC_CONFIG_DIR /tmp/p.json'
# cron (crontab -e)
35 * * * * /home/dilshodbek/elchi-ops/backup-minio-offsite-cron.sh >/dev/null 2>&1
*/15 * * * * /home/dilshodbek/elchi-ops/backup-alert.sh >/dev/null 2>&1
```

Birinchi run: 117 obyekt / 24 722 429 B, 15 s; ikkinchisi — 0 yangi;
`rclone check`: 117 matching, 0 differences.

## 4. Tekshirish

```bash
tail -n 5 ~/elchi-ops/logs/minio-offsite.log
cat ~/elchi-ops/state/minio-offsite/status
MINIO_OFFSITE_STATE_DIR=~/elchi-ops/state/minio-offsite sh ~/elchi-ops/backup-minio-offsite.sh --check
# R2 dagi nusxa va MinIO bir xilmi (o'lcham + MD5):
mo() { docker run --rm --network backend_default --user "$(id -u):$(id -g)" -e HOME=/tmp \
  --env-file ~/elchi-ops/minio-backup.env \
  --env-file <(grep -E '^(MINIO_ENDPOINT|MINIO_PORT|MINIO_USE_SSL|MINIO_BUCKET|R2_[A-Z_]+)=' /home/shodiyor/apps/backend/.env.production) \
  -v ~/elchi-ops/backup-minio-offsite.sh:/s.sh:ro --entrypoint sh rclone/rclone:1.68.2 /s.sh rclone "$@"; }
mo check minio:elchi-files r2:elchipochtadatabase/minio/elchi-files/current --one-way
mo lsf r2:elchipochtadatabase/minio/elchi-files/versions       # eski versiyalar papkalari
```

## 5. Tiklash

⚠️ Tiklash YOZISH kalitini talab qiladi — `elchi-backup-ro` bilan bo'lmaydi.
Ilova kaliti (`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`, policy `readwrite`) bilan:

```bash
# 1 ta fayl (masalan, yo'qolgan dalil rasmi): avval qayerdaligini toping
mo lsf -R r2:elchipochtadatabase/minio/elchi-files/current | grep '<nom>'
mo lsf -R r2:elchipochtadatabase/minio/elchi-files/versions | grep '<nom>'   # o'chirilgan/eski versiya
# yozish uchun MINIO_BACKUP_* o'rniga ilova kalitini bering (faqat shu buyruq uchun):
docker run --rm --network backend_default --user "$(id -u):$(id -g)" -e HOME=/tmp \
  --env-file <(grep -E '^(MINIO_ENDPOINT|MINIO_PORT|MINIO_USE_SSL|MINIO_BUCKET|R2_[A-Z_]+)=' .env.production;
               grep -E '^MINIO_ACCESS_KEY=' .env.production | sed 's/^MINIO_ACCESS_KEY=/MINIO_BACKUP_ACCESS_KEY=/';
               grep -E '^MINIO_SECRET_KEY=' .env.production | sed 's/^MINIO_SECRET_KEY=/MINIO_BACKUP_SECRET_KEY=/') \
  -v ~/elchi-ops/backup-minio-offsite.sh:/s.sh:ro --entrypoint sh rclone/rclone:1.68.2 \
  /s.sh rclone copyto "r2:elchipochtadatabase/minio/elchi-files/current/<kalit>" "minio:elchi-files/<kalit>"
# butun bucket (yangi server / MinIO volume yo'qolgan): o'sha buyruq, lekin
#   … rclone copy r2:elchipochtadatabase/minio/elchi-files/current minio:elchi-files --checksum
```

Yangi serverda: avval `docker compose up -d minio`, bucket'ni yarating
(`mc mb local/elchi-files`), ilova foydalanuvchisini (readwrite) qayta yarating,
keyin yuqoridagi `copy`. VPS yo'q joyda R2 kalitlari parol menejeridan
olinadi (db-backups.md §6.4 dagi `docker run … rclone` usuli).

Tiklash sinovi (2026-10-26): R2 `current/` dan bitta obyekt (1 296 794 B)
yuklab olindi — MD5 MinIO'dagi bilan bir xil; `rclone check` 117/117 mos.
To'liq bucket tiklash hali mashq qilinmagan (oylik mashqqa kiritilgan —
backup-rpo-rto.md §3).

## 6. Cheklovlar

- R2 token "Object Read & Write" — server buzilsa hujumchi R2 dagi nusxani ham
  o'chira oladi (db-backups.md §6.6). Kelajakda: `minio/` prefiksi uchun R2
  Bucket Lock.
- Saqlash narxi: ~25 MB — R2 bepul 10 GB ichida.
- `versions/` faqat run'lar orasidagi holatni ushlaydi: bir soat ichida ikki
  marta o'zgargan obyektning oraliq versiyasi saqlanmaydi.
- MinIO'ning ichki `.minio.sys` (IAM foydalanuvchilar/policy'lar) bu nusxaga
  kirmaydi — tiklashda foydalanuvchilar qayta yaratiladi (§5).
