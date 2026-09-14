# Yuk testi — Elchi Pochta

> **Maqsad.** "Kuniga nechta buyurtmani ko'taradi?" degan savolga taxmin
> emas, **o'lchov** bilan javob berish.

Audit paytida chegara model asosida baholangan edi (~5 000/kun; Scale
1-bosqichdan keyin ~30 000). Bu skriptlar o'sha raqamlarni haqiqiy
o'lchovga almashtiradi.

---

## ⚠️ Avval o'qing

1. **`main.js`/`capacity.js` produksiyaga qarshi yurgizilmaydi.**
   `create_orders` haqiqiy buyurtma yaratadi, `capacity.js` esa yukni
   uzilishgacha ko'taradi. Produksiyada faqat `probe.mjs` (0-bo'lim).
2. **Rate limit testni buzadi.** Gateway sukut bo'yicha IP bo'yicha
   daqiqasiga 60 so'rovga ruxsat beradi — ya'ni yuk testi darhol `429` ga
   uriladi va siz **yukni emas, chegarani** o'lchaysiz. Staging'da testdan
   oldin:

   ```bash
   THROTTLE_LIMIT=100000
   THROTTLE_TTL_MS=60000
   ```

   Skriptlar `429` larni alohida sanaydi va xulosada ogohlantiradi —
   natija jimgina buzilmaydi.
3. **Baza staging'da prodga o'xshash hajmda bo'lsin.** Bo'sh bazada
   o'lchangan sig'im ma'nosiz: aynan hajm o'sishi bilan sekinlashadigan
   so'rovlarni qidiryapmiz.

---

## O'rnatish

```bash
# k6 (Debian/Ubuntu)
sudo gpg -k && sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

---

## 0. Produksiyada xavfsiz o'lchov — `probe.mjs`

⚠️ **`main.js` va `capacity.js` produksiyada yurgizilmaydi.** Ular yukni
o'nlab/yuzlab req/s gacha ko'taradi — bu jonli tizimda ataylab uzilish
demakdir. Ustiga produksiyada throttle (IP bo'yicha daqiqasiga 60) yoqiq,
ya'ni natija baribir yuk emas, chegara o'lchovi bo'lib chiqadi.

`probe.mjs` boshqa narsa qiladi: og'ir ekranlarni **bitta operator
tezligida** (1 so'rov/soniya) ochib, ularning REAL ma'lumot hajmidagi
kechikishini o'lchaydi. Yuk — bitta odam brauzerda bosgani bilan bir xil.
k6 ham kerak emas, faqat Node.

```bash
BASE_URL=https://api.elchipochta.uz \
LOGIN_PHONE='+998...' LOGIN_PASSWORD='...' \
node tests/load/probe.mjs
```

**Nega bu yetarli.** Sig'im modelidagi yagona katta noma'lum — og'ir
so'rovning haqiqiy bazadagi narxi. Uni bilsak qolgani hisob: bir so'rov
N ms server ishi yesa, bitta yadro sekundiga ~1000/N ta shunday so'rovni
ko'taradi. Skript `health` (ish qilmaydigan endpoint) ni baza sifatida olib,
undan ortiqchasini "server ishi" deb ajratadi — ya'ni tarmoq va tunnel
kechikishi natijani buzmaydi.

Hech narsa yozmaydi: faqat `GET` + oddiy login.

---

## 1. Kundalik yuk — `main.js`

Hozirgi yuk qanday ushlanishini ko'rsatadi va **regressiyani ushlaydi**:
Scale 1-bosqichda tuzatilgan og'ir o'qish yo'llari shu yerda o'lchanadi.
Kimdir agregatsiyani yana JS'ga qaytarsa, `dashboard_latency` p95 hajm
o'sishi bilan chiziqli o'sa boshlaydi.

```bash
BASE_URL=https://staging.elchipochta.uz \
LOGIN_PHONE='+998...' LOGIN_PASSWORD='...' \
k6 run tests/load/main.js
```

Yozish yo'lini ham o'lchash (staging!):

```bash
WRITE=1 SEED_MARKET_ID=1 SEED_REGION_ID=1 SEED_DISTRICT_ID=1 \
BASE_URL=... LOGIN_PHONE=... LOGIN_PASSWORD=... \
k6 run tests/load/main.js
```

Yukni oshirish: `RATE=50 DURATION=3m k6 run tests/load/main.js`

**Chegaralar (thresholds)** — buzilса test qizil bo'ladi:

| Metrika | Chegara | Nega |
|---|---|---|
| `dashboard_latency` p95 | < 1000 ms | Audit hisobotidagi "bemalol" zonasi shu bilan belgilangan |
| `orders_list_latency` p95 | < 800 ms | CRM'ning eng ko'p ochiladigan ekrani |
| `money_latency` p95 | < 1000 ms | Kassa/hisob-kitob ekrani |
| `failed_requests` | < 1% | — |
| `throttled_429` | < 10 | Ko'p bo'lsa natija ishonchsiz (yuqoriga qarang) |

---

## 2. Chegarani topish — `capacity.js`

Yuk bosqichma-bosqich oshiriladi (5 → 10 → 25 → 50 → 100 → 200 req/s) va
**chegara buzilgan nuqtada test to'xtaydi**. Aynan shu nuqta — sig'imning
yuqori qirrasi.

```bash
BASE_URL=... LOGIN_PHONE=... LOGIN_PASSWORD=... \
k6 run tests/load/capacity.js
```

Bosqichlarni o'zgartirish: `START=10 PEAK=500 STAGE_DURATION=2m`

Oxirida skript **buyurtma/kun** ga aylantirilgan xulosa chiqaradi.

---

## Eng aniq usul: testni SERVERNING O'ZIDA yurgizish

Tashqaridan (internet → Cloudflare → tunnel) o'lchaganda javobga ~200 ms
tarmoq qo'shiladi va Cloudflare o'zi ham yukni cheklashi mumkin — ya'ni siz
tizimni emas, yo'lni o'lchaysiz. Server ichidan `http://localhost:3004` ga
urish bu qatlamlarni butunlay chetlab o'tadi.

```bash
# 1) Serverga kirish
ssh elchi

# 2) k6 (bir marta)
curl -sL https://github.com/grafana/k6/releases/download/v0.54.0/k6-v0.54.0-linux-amd64.tar.gz \
  | tar xz && sudo mv k6-v0.54.0-linux-amd64/k6 /usr/local/bin/

# 3) Throttle'ni VAQTINCHA ko'tarish (aks holda 429 o'lchanadi, yuk emas)
cd ~/apps/backend
echo "THROTTLE_LIMIT=100000" >> .env.production
docker compose -f docker-compose.prod.yml up -d --no-deps api-gateway

# 4) O'lchov
BASE_URL=http://localhost:3004 LOGIN_PHONE='+998...' LOGIN_PASSWORD='...' \
  k6 run tests/load/capacity.js

# 5) Throttle'ni QAYTARISH — bu qadam unutilmasin
sed -i '/^THROTTLE_LIMIT=100000$/d' .env.production
docker compose -f docker-compose.prod.yml up -d --no-deps api-gateway
```

⚠️ k6 o'sha 6 vCPU ni servislar bilan bo'lishadi. 100 req/s gacha ta'siri
sezilarsiz; undan yuqorida k6 ni boshqa mashinadan yurgizib, `BASE_URL` ni
serverning ichki manzili qilib qo'yish to'g'riroq.

---

## Natijani buyurtma/kunga aylantirish

O'lchov `req/s` beradi, savol esa `buyurtma/kun` haqida. Aylantirish:

```
buyurtma/kun = (req_s ÷ REQ_PER_ORDER) × 3600 × ISH_SOATI ÷ PEAK_FACTOR
```

| Koeffitsient | Sukut | Ma'nosi |
|---|---|---|
| `REQ_PER_ORDER` | 25 | Bitta buyurtma butun hayoti davomida keltiradigan API so'rovlari (yaratish, qabul, skan, pochta, sotuv, hisob-kitob + ekran ko'rishlari). Real qiymatni gateway loglaridan oling. |
| `ISH_SOATI` | 10 | Kunlik faol soat |
| `PEAK_FACTOR` | 3 | Yuk tekis tushmaydi: peak soat o'rtachadan ~3× yuqori |

Misol: 60 req/s barqaror ushlansa →
`(60 ÷ 25) × 3600 × 10 ÷ 3 ≈ 28 800 buyurtma/kun`.

Koeffitsientlarni o'zgartirish:

```bash
REQ_PER_ORDER=18 PEAK_FACTOR=2.5 k6 run tests/load/capacity.js
```

---

## Nimani o'lchamaydi (ataylab)

- **Kuryer ilovasining real oqimi** (skan, QR, fayl yuklash) — alohida
  skript talab qiladi va fayl yuklash tarmoqqa bog'liq.
- **Outbox shifti.** Sotuv oyoqlari asinxron qo'llanadi, ya'ni HTTP javobi
  tez qaytadi. Outbox kechikishini o'lchash uchun sotuvdan keyin
  `order_settlement` holatini kuzatish kerak — bu keyingi qadam
  (Scale 2-bosqich bilan birga).
- **Disk.** Isbot rasm/videolari MinIO'da; yuk testi ularni yaratmaydi.
  Hajm rejasi alohida masala.
