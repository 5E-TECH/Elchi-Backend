# Zaxira: RPO / RTO, oylik tiklash mashqi, nosog'lom backup alerti

> Karta 6RaEn5cN (B qismi). Bog'liq: [db-backups.md](db-backups.md) (DB dumplari,
> R2 off-site), [minio-backups.md](minio-backups.md) (fayllar).

## 1. Nima zaxiralanadi

| Ma'lumot | Lokal (VPS) | Off-site (Cloudflare R2, `elchipochtadatabase`) | Saqlash |
|---|---|---|---|
| Postgres (barcha sxemalar) | kunlik 05:00 Toshkent (`backups/daily`, 7 ta) + har deploy oldidan (`backups/pre-deploy`, 5 ta) | har soatda yangi dumplar → `daily/`, `pre-deploy/` | R2: 30 kun |
| MinIO `elchi-files` (dalil rasmlari) | — (faqat volume) | har soat `:35` → `minio/elchi-files/current/` + `versions/<ts>/` | current: doim, versions: 90 kun |
| `.env.production` (sirlar) | serverda | ❌ — **parol menejerida** bo'lishi shart (R2 kalitlari ham shu yerda) | — |
| RabbitMQ | ❌ (navbatlar vaqtinchalik; outbox Postgres'da) | ❌ | — |

## 2. RPO / RTO

RPO — eng ko'pi bilan qancha ma'lumot yo'qoladi; RTO — qancha vaqtda tiklanadi.

| Hodisa | RPO (hozir) | RTO (maqsad) | Izoh |
|---|---|---|---|
| DB buzildi / noto'g'ri migratsiya, server butun | deploy bo'lsa — o'sha deploy oldidagi dump (0 yo'qotish); aks holda ≤ 24 soat | **≤ 1 soat** | §5 db-backups.md: sinov bazaga tiklash → haqiqiy tiklash. Texnik vaqt: soniyalar (mashq: 2,4 s) |
| Fayl (rasm) o'chirildi / ustidan yozildi | ≤ 1 soat | ≤ 30 daqiqa | `versions/<ts>/` dan bitta faylni qaytarish (minio-backups.md §5) |
| **VPS butunlay yo'qoldi** (disk, Contabo) | DB: ≤ 25 soat (kunlik dump + 1 soat R2 nusxa kechikishi); fayllar: ≤ 1 soat | **≤ 4 soat** | yangi VPS + Docker + repo + `.env.production` (parol menejeri) + R2 dan DB dump + MinIO copy + Cloudflare tunnel token — vaqtning asosiy qismi server tayyorlash |

⚠️ DB uchun 24 soatlik RPO — eng zaif joy. DB kichik (dump 0,55 MB gz), shuning
uchun kuniga bir necha marta (masalan har 4–6 soatda) dump olish arzon —
alohida karta sifatida tavsiya qilinadi (`backup-cron.sh` hozir faqat kunlik
jadvalni biladi).

## 3. Oylik tiklash mashqi

Har oyning birinchi dushanbasi (kalendar kartasi). ~15 daqiqa, prod'ga tegmaydi.

1. **DB** — R2 dagi eng yangi dumpni VPS'dan TASHQARIDAGI mashinaga yuklab,
   bir martalik `postgres:15` ga tiklash va jadvallardagi qatorlar sonini
   dumpning o'zidagi `COPY` bloklari bilan solishtirish:
   `bash scripts/restore-drill.sh <bo'sh-ish-papka>` (R2 kalitlari env'da:
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` —
   yoki `RESTORE_DRILL_SSH=user@server` bilan serverdagi `.env.production` dan
   SSH orqali o'qiladi; hech biri chop etilmaydi). Skript oxirida lokal nusxa
   va konteyner o'chiriladi.
2. **MinIO** — `rclone check minio:elchi-files r2:…/minio/elchi-files/current
   --one-way` + bitta obyektni R2 dan yuklab MD5 solishtirish
   (minio-backups.md §4); yiliga bir marta — butun bucket'ni bo'sh MinIO
   konteyneriga tiklash.
3. Natijani pastdagi jurnalga va kartaga yozing: sana, fayl, hajm, vaqt, mos
   kelmagan jadvallar.

### Mashqlar jurnali

| # | Sana | Nima | Hajm | Vaqt | Natija |
|---|---|---|---|---|---|
| 1 | 2026-10-26 | DB: `pre-deploy/pre-deploy-20261026T102540Z-b327922-to-0dfde82.sql.gz` (R2 dagi eng yangisi) → lokal kompyuter → `postgres:15` (15.15) | 547 752 B gz → 4 025 606 B SQL → DB 24 MB (13 sxema, 119 jadval) | yuklash 4,2 s; tiklash 2,4 s | R2 MD5 = lokal; gzip butun; "dump complete" bor; **119/119 jadval qatorlar soni dump bilan bir xil** (8 758 qator; masalan orders 137, order_items 134, cashbox_history 124, cashboxes 17, migrations 166); psql xatosi 0 |
| 1 | 2026-10-26 | MinIO: `rclone check` + 1 obyekt yuklab olish | 117 obyekt, 24 722 429 B | birinchi to'liq nusxa 15 s | 117/117 mos; yuklangan obyekt MD5 = MinIO |

## 4. Nosog'lom backup alerti

`scripts/backup-alert.sh` — serverda cron, har 15 daqiqa
(`*/15 * * * * ~dilshodbek/elchi-ops/backup-alert.sh`). Tekshiradi:

| Tekshiruv | Muammo deb hisoblanadi |
|---|---|
| `elchi-db-backup` | ishlamayapti yoki `(unhealthy)` — eng yangi kunlik dump > 26 soat |
| `elchi-backup-offsite` | ishlamayapti yoki `(unhealthy)` — R2 ga oxirgi muvaffaqiyatli nusxa > 26 soat |
| MinIO off-site | `backup-minio-offsite.sh --check`: oxirgi muvaffaqiyatli run > 26 soat, yoki `disabled` |

Deploy paytidagi qisqa `(health: starting)` muammo hisoblanmaydi. Xabar:
muammo paydo bo'lganda, muammolar to'plami o'zgarganda, davom etsa har
`BACKUP_ALERT_REPEAT_HOURS` (6) soatda va tiklanganda bir marta ("✅ tiklandi").
Log: `~dilshodbek/elchi-ops/logs/backup-alert.log`.

**Kanallar** — `~dilshodbek/elchi-ops/backup-alert.env` (0600, `KEY=VALUE`) yoki `.env.production`:

| Kalit | Nima |
|---|---|
| `BACKUP_ALERT_TELEGRAM_CHAT_ID` | Telegram chat id — mavjud bot (`TELEGRAM_BOT_TOKEN`, yuborish paytida `.env.production` dan o'qiladi) orqali yuboriladi. Avval o'sha chatda botga `/start` yozilgan bo'lishi kerak |
| `BACKUP_ALERT_WEBHOOK_URL` | ixtiyoriy: matnli POST (masalan ntfy.sh mavzusi) |
| `BACKUP_ALERT_HEARTBEAT_URL` | ixtiyoriy: healthchecks.io ping URL — har sog'lom run'da ping, muammoda `/fail`. **Server butunlay o'chsa ham** xabar beradi (ping kelmay qoladi) |
| `BACKUP_ALERT_REPEAT_HOURS` | takroriy xabar oralig'i (6) |

Hech biri sozlanmagan bo'lsa — faqat log qatori (`ALERT (problem) — kanal
sozlanmagan …`). Tekshirish: `~/elchi-ops/backup-alert.sh --dry-run` (hech
narsa yubormaydi), kanal sozlangach `~/elchi-ops/backup-alert.sh --test`.

Muammo bo'lsa: `docker logs --tail 50 elchi-db-backup` / `elchi-backup-offsite`,
`tail ~/elchi-ops/logs/minio-offsite.log`; runbook'lar — db-backups.md §4/§6.3,
minio-backups.md §4.

## 5. Tashqi monitoring (ZfI9nERJ) — akkaunt talab qiladi

Serverning o'zi o'chsa yuqoridagi alert ham ishlamaydi — tashqaridan kuzatish kerak:

1. **Uptime monitor** (UptimeRobot / Better Stack, bepul reja): HTTP(S) monitor
   `https://api.elchipochta.uz/health` (200 kutiladi, oraliq 1–5 daqiqa) va
   `https://api.elchipochta.uz/health/readiness`; ogohlantirish — email +
   Telegram (UptimeRobot'da Telegram integratsiyasi bor).
2. **healthchecks.io** check (period 15 min, grace 30 min) → ping URL ni
   `BACKUP_ALERT_HEARTBEAT_URL` ga yozish — backup alerti uchun dead-man switch.
3. **Cloudflare Zero Trust → Notifications → "Tunnel health alert"** (mavjud
   Cloudflare akkaunti, yangi akkaunt kerak emas): tunnel `elchi` degraded/down
   bo'lsa email.
