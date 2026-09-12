# Elchi Pochta — Marketplace API

**Dasturchilar uchun qo'llanma** · Versiya 1 · Oxirgi yangilanish: 2026-09-12

Bu hujjat marketplace, do'kon, CRM yoki boshqa tizim dasturchisi uchun: Elchi
Pochta'ga qanday ulanish, buyurtmani yetkazishga topshirish va statusni
real vaqtda qabul qilish.

> **Kimga kerak emas:** agar siz Elchi operatori bo'lsangiz, bu hujjat sizga
> kerak emas — admin panelidan ishlang.

---

## 1. Umumiy tasavvur

Siz **hamkor** (partner) sifatida ro'yxatga olinasiz va API kaliti olasiz.
Keyin ish oqimi shunday:

```
1. Sotuvchini ro'yxatga olish        POST /partner/markets
   (bir marta, har sotuvchi uchun)

2. Buyurtmani yetkazishga topshirish POST /partner/shipments
   (har buyurtma uchun)

3. Statusni kutish                   webhook (biz sizga POST qilamiz)
   yoki so'rash                      GET  /partner/shipments/:id
```

**Muhim tushuncha:** buyurtma sizda yaratiladi, Elchi faqat **yetkazadi**.
Shuning uchun har bir posilkada sizning `external_order_id` bo'lishi shart —
biz shu id bilan sizga javob qaytaramiz.

### Baza manzili

```
https://api.elchipochta.uz
```

---

## 2. Autentifikatsiya

Har bir so'rovda **`X-Api-Key`** sarlavhasi:

```http
GET /partner/ping HTTP/1.1
Host: api.elchipochta.uz
X-Api-Key: elp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- JWT **ishlatilmaydi** — faqat API kalit.
- Kalit **bir marta** ko'rsatiladi (yaratilganda). Bazada faqat uning
  SHA-256 hash'i saqlanadi, ya'ni biz ham uni tiklab bera olmaymiz —
  yo'qotsangiz yangisini olish kerak.
- Kalit har so'rovda yuboriladi, muddati tugamaydi. Aylantirish
  (rotate) operator tomonidan bajariladi va **eski kalit darhol
  ishlamaydi**.

### IP cheklovi (ixtiyoriy)

Operator sizning hamkor yozuvingizga IP ro'yxatini qo'yishi mumkin. Qo'yilsa,
faqat o'sha manzillardan kelgan so'rovlar qabul qilinadi.

- Aniq manzil: `203.0.113.10`
- Diapazon (CIDR): `203.0.113.0/24`
- Ro'yxat **bo'sh bo'lsa cheklov yo'q**.

Ro'yxatdan tashqari manzildan so'rov kelsa **403** qaytadi va xabarda
aniqlangan IP ko'rsatiladi — sozlashni osonlashtirish uchun.

### Rate limit

Har hamkor uchun alohida: **daqiqada 120 so'rov** (standart). Oshsa **429**
qaytadi. Limitdan oshmaslik uchun:

- statusni **so'rab turmang** — webhook ishlatib turing (§6);
- geo ma'lumotlarini (viloyat/tuman) **keshlang** — u kamdan-kam o'zgaradi.

---

## 3. Javob shakllari

### Xatolar — bir xil shakl

```json
{
  "statusCode": 400,
  "message": "elchi_market_id majburiy",
  "trace_id": "eaff465b-4c89-4721-b7c8-30cf22fb403e"
}
```

`trace_id` ni **saqlab qo'ying**: muammo bo'lganda biz shu id bo'yicha
loglardan aniq so'rovni topamiz.

| Kod | Ma'nosi | Qayta urinishmi |
|---|---|---|
| `400` | So'rov noto'g'ri (majburiy maydon yo'q, format xato) | ❌ yo'q — so'rovni tuzatish kerak |
| `401` | `X-Api-Key` yo'q yoki yaroqsiz | ❌ yo'q |
| `403` | Hamkor o'chirilgan yoki IP ruxsat etilmagan | ❌ yo'q |
| `404` | Topilmadi (market, posilka) | ❌ yo'q |
| `409` | Ziddiyat — masalan yetkazilgan posilkani bekor qilish | ❌ yo'q |
| `429` | Rate limitdan oshdi | ✅ ha, kutib |
| `5xx` | Bizning tomonimizdagi xato | ✅ ha, backoff bilan |

### Muvaffaqiyat — bitta shakl

**Barcha** `/partner/*` javobi shu qobiqda:

```json
{
  "statusCode": 200,
  "message": "regions",
  "data": [ ... ]
}
```

| Maydon | Izoh |
|---|---|
| `statusCode` | HTTP kodi bilan bir xil |
| `message` | Qisqa yorliq (`regions`, `shipment created`, `shipment already exists`) |
| `data` | Foydali yuk — obyekt yoki massiv |

Foydali yukni o'qish:

```js
const { data } = await res.json();
```

> **Tarixiy qayd.** 2026-09-12 gacha `ping`, `regions`, `districts` va
> `tariff` marshrutlari qobiqSIZ (xom) qaytarardi, `markets`/`shipments` esa
> qobiqli. Endi hammasi birxil. Agar siz eski xulqqa moslashgan kod yozgan
> bo'lsangiz, `body.data ?? body` naqshi ikkalasida ham ishlaydi.

---

## 4. Geo ma'lumotlari

Posilka yaratishda `region_id` va `district_id` **Elchi'dagi** id bo'lishi
kerak. Ularni bir marta olib keshlang.

### `GET /partner/regions`

```json
{
  "statusCode": 200,
  "message": "regions",
  "data": [
    { "id": "3",  "name": "Andijon", "sato_code": "1703" },
    { "id": "14", "name": "Qoraqalpog'iston Respublikasi", "sato_code": "1735" }
  ]
}
```

### `GET /partner/districts?region_id=3`

```json
{
  "statusCode": 200,
  "message": "districts",
  "data": [
    { "id": "28", "name": "Andijon", "region_id": "3", "sato_code": "1703203" },
    { "id": "31", "name": "Asaka",   "region_id": "3", "sato_code": "1703224" }
  ]
}
```

**`sato_code` — eng ishonchli kalit.** Bu O'zbekiston rasmiy SOATO
klassifikatori kodi. Agar sizning tizimingizda ham SOATO bo'lsa, tumanlarni
**nom bo'yicha emas, SOATO bo'yicha** moslang: nomlar imlo bilan farq qiladi
(`Xo'jaobod` / `Khojaobod`), SOATO esa aniq.

### `GET /partner/tariff?elchi_market_id=121&where_deliver=center`

```json
{
  "statusCode": 200,
  "message": "tariff",
  "data": {
    "elchi_market_id": "121",
    "where_deliver": "center",
    "market_tariff": 15000
  }
}
```

Narxni mijozga ko'rsatishdan oldin shu bilan tekshiring. `where_deliver`:
`center` (punktdan olib ketish) yoki `address` (uyga yetkazish).

---

## 5. Asosiy oqim

### 5.1 Sotuvchini ro'yxatga olish

Har bir sotuvchi (do'kon) Elchi tomonida **market akkaunti** oladi. Bu bir
marta bajariladi va **idempotent** — takror chaqirsangiz o'sha akkaunt
qaytadi.

```http
POST /partner/markets
X-Api-Key: elp_...
Content-Type: application/json

{
  "external_seller_id": "seller-4471",
  "name": "Zamon Store",
  "phone": "+998901234567",
  "region_id": "3",
  "tariff_home": 25000,
  "tariff_center": 15000
}
```

```json
{
  "statusCode": 200,
  "message": "market provisioned",
  "data": { "elchi_market_id": "121", "tariff_home": 25000, "tariff_center": 15000 }
}
```

- `external_seller_id` — **idempotency kaliti**. Sizning tizimingizdagi
  sotuvchi id'si. O'zgarmas bo'lishi kerak.
- `elchi_market_id` ni **saqlab qo'ying** — har posilkada kerak.
- Tariflar berilsa yangilanadi; **berilmasa mavjudi saqlanadi** (tasodifan
  0 ga tushib, bepul yetkazishga aylanib qolmasin).

### 5.2 Buyurtmani topshirish

```http
POST /partner/shipments
X-Api-Key: elp_...
Content-Type: application/json

{
  "external_order_id": "ORD-2026-55123",
  "elchi_market_id": "121",
  "customer": { "name": "Aziz Karimov", "phone": "+998935551122" },
  "region_id": "3",
  "district_id": "31",
  "address": "Asaka sh., Navoiy ko'chasi 12",
  "where_deliver": "address",
  "items": [
    { "name": "Simsiz quloqchin", "quantity": 1, "external_product_id": "SKU-8891" }
  ],
  "cod_amount": 450000,
  "subtotal": 450000
}
```

```json
{
  "statusCode": 201,
  "message": "shipment created",
  "data": {
    "shipment_id": "124",
    "order_status": "new",
    "qr_code_token": "c0ae6c9e2b92c13cc05f5b2b",
    "to_be_paid": 450000
  }
}
```

#### Maydonlar

| Maydon | Majburiy | Izoh |
|---|---|---|
| `external_order_id` | ✅ | **Idempotency kaliti.** Sizning buyurtma id'ingiz |
| `elchi_market_id` | ✅ | §5.1 dan |
| `customer.name`, `customer.phone` | ✅ | Mijoz — telefon bo'yicha topiladi/yaratiladi |
| `region_id`, `district_id` | ✅ | §4 dan |
| `address` | uyga yetkazishda | `where_deliver: "address"` bo'lsa shart |
| `where_deliver` | — | `center` \| `address` (standart: `address`) |
| `items[]` | — | `{ name, quantity, external_product_id? }` |
| `cod_amount` | ✅ | Kuryer mijozdan **yig'adigan** summa. `0` = oldindan to'langan |
| `subtotal` | ✅ | Buyurtma summasi — **`cod_amount` bilan teng yuboring** (pastga qara) |

#### ⚠️ `cod_amount` va `subtotal` teng bo'lishi kerak

Elchi'ning sotuv matematikasi buyurtma **to'liq narxi** ustida ishlaydi. Ikki
maydon farq qilsa, pul hisobi siz kutgandan boshqacha chiqadi. Oldindan
to'langan buyurtmada esa ikkalasini ham to'g'ri yuborish muhim:

```
Naqd (COD):        cod_amount = 450000,  subtotal = 450000
Oldindan to'langan: cod_amount = 0,      subtotal = 450000
```

#### `external_product_id` — nega muhim

Berilsa, Elchi katalogida mahsulot **avtomatik yaratiladi** (yo'q bo'lsa) va
keyingi posilkalarda **qayta ishlatiladi**. Bog'lanish **id bo'yicha**, nom
bo'yicha emas — shuning uchun mahsulot nomini o'zgartirsangiz katalogda
dublikat paydo bo'lmaydi va hisobot buzilmaydi.

Berilmasa nom faqat matn bo'lib qoladi: posilka ishlaydi, lekin mahsulot
bo'yicha hisobotda qatnashmaydi.

#### Idempotentlik

Bir xil `external_order_id` bilan takror yuborsangiz **yangi posilka
YARATILMAYDI**:

```json
{
  "statusCode": 200,
  "message": "shipment already exists",
  "data": { "shipment_id": "124", "idempotent": true }
}
```

`statusCode` `201` emas `200` va `idempotent: true` — shundan bilib olasiz.

> **Timeout bo'lsa qayta yuboring.** Posilka yaratish bir necha bosqichdan
> iboratlashi mumkin. Javob kelmasa ayni `external_order_id` bilan qayta
> yuborish **xavfsiz** — dublikat bo'lmaydi.

### 5.3 Statusni so'rash

```http
GET /partner/shipments/124
X-Api-Key: elp_...
```

```json
{
  "statusCode": 200,
  "message": "shipment",
  "data": {
    "shipment_id": "124",
    "external_order_id": "ORD-2026-55123",
    "status": "sold",
    "cod_amount": 435000,
    "cod_collected": 0,
    "total_price": 450000,
    "extra_cost": 0,
    "tracking": "c0ae6c9e2b92c13cc05f5b2b"
  }
}
```

`:id` sifatida **ikkalasi ham** ishlaydi: `shipment_id` (`124`) yoki sizning
`external_order_id` (`ORD-2026-55123`).

#### ⚠️ Pul maydonlarini aralashtirmang

| Maydon | Ma'nosi |
|---|---|
| `total_price` | Buyurtma narxi. Elchi tomonida o'zgargan bo'lishi mumkin (kuryer chegirma bilan sotgan) |
| `cod_amount` | Elchi sizga **qarz** summasi. Sotuvdan keyin Elchi undan o'z tarifini ushlab qoladi |
| `cod_collected` | Elchi sizga **allaqachon to'lab bergan** qismi. ⚠️ "kuryer yiqqan naqd" **EMAS** |
| `extra_cost` | Kuryer yozgan qo'shimcha xarajat (yo'l, qayta urinish) |

Ya'ni: `Elchi ushlab qolgan tarif = total_price − cod_amount`.

Bu raqamlarni **o'z daftaringiz bilan solishtirib turing** — farq bo'lsa
tarif yoki narx o'zgargan.

### 5.4 Bekor qilish

```http
POST /partner/shipments/124/cancel
X-Api-Key: elp_...
```

- Yetkazilgan posilka **bekor qilinmaydi** → **409**.
- Allaqachon bekor qilingan bo'lsa **200** va `idempotent: true`.

---

## 6. Webhook — statusni real vaqtda olish

Buyurtma statusi o'zgarganda biz **sizning manzilingizga POST** qilamiz.
Statusni so'rab turishdan (`polling`) **ancha yaxshi**: tez va rate limitni
yemaydi.

Operatorga bering:
- **`webhook_url`** — bizning POST manzilimiz (HTTPS, ommaviy);
- **`webhook_secret`** — imzo kaliti (uzun tasodifiy satr).

### 6.1 So'rov

```http
POST /your/webhook HTTP/1.1
Content-Type: application/json
X-Elchi-Signature: 5d41402abc4b2a76b9719d911017c592...

{
  "event": "shipment.status_changed",
  "event_id": "9f1c2e40-7b44-4d91-9f02-1c5e6d8a4b30",
  "external_order_id": "ORD-2026-55123",
  "shipment_id": "124",
  "status": "sold",
  "cod_collected": 0,
  "total_price": 450000,
  "extra_cost": 0,
  "occurred_at": "2026-09-12T09:30:01.235Z"
}
```

### 6.2 Imzoni tekshirish — MAJBURIY

`X-Elchi-Signature` = **HMAC-SHA256**(so'rov tanasi, `webhook_secret`), hex.

> ⚠️ **Xom tanani** (raw body) ishlating. JSON'ni parse qilib qayta
> serializatsiya qilsangiz bayt-baytga farq chiqadi va imzo **mos
> kelmaydi** — bu eng ko'p uchraydigan xato.

**Node.js (Express):**

```js
const crypto = require('crypto');

// Xom tanani saqlash — parse qilishdan OLDIN
app.use('/your/webhook', express.raw({ type: 'application/json' }));

app.post('/your/webhook', (req, res) => {
  const raw = req.body;                          // Buffer
  const expected = crypto
    .createHmac('sha256', process.env.ELCHI_WEBHOOK_SECRET)
    .update(raw)
    .digest('hex');
  const got = String(req.get('X-Elchi-Signature') || '');

  // Doimiy vaqtli solishtirish — timing attack'dan himoya
  const ok =
    expected.length === got.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));

  if (!ok) return res.status(401).json({ message: 'invalid signature' });

  const event = JSON.parse(raw.toString('utf8'));
  // ... ishlov berish
  return res.status(200).json({ ok: true });
});
```

**PHP:**

```php
$raw = file_get_contents('php://input');
$expected = hash_hmac('sha256', $raw, getenv('ELCHI_WEBHOOK_SECRET'));
$got = $_SERVER['HTTP_X_ELCHI_SIGNATURE'] ?? '';

if (!hash_equals($expected, $got)) {
    http_response_code(401);
    exit(json_encode(['message' => 'invalid signature']));
}
$event = json_decode($raw, true);
```

**Python (Flask):**

```python
import hmac, hashlib

@app.post("/your/webhook")
def webhook():
    raw = request.get_data()  # xom baytlar
    expected = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    got = request.headers.get("X-Elchi-Signature", "")
    if not hmac.compare_digest(expected, got):
        return {"message": "invalid signature"}, 401
    event = request.get_json()
    return {"ok": True}, 200
```

### 6.3 Javob va qayta urinish

- **2xx** qaytarsangiz — yetkazilgan hisoblanadi.
- 2xx bo'lmasa yoki javob kelmasa — biz **qayta urinamiz**: `1 daqiqa`,
  `5 daqiqa`, `15 daqiqa`. Undan keyin to'xtatiladi va operator panelida
  "yetkazilmadi" bo'lib ko'rinadi (qo'lda qayta yuborish mumkin).
- **Tez javob bering** (< 10 s). Og'ir ishni navbatga qo'yib, darhol 2xx
  qaytaring.

### 6.4 Takrorni ajratish — MAJBURIY

Ayni hodisa **bir necha marta** kelishi mumkin (qayta urinish, tarmoq
uzilishi). `event_id` **noyob** — uni saqlab, takrorini tashlab yuboring:

```js
if (await seen(event.event_id)) return res.status(200).json({ ok: true });
await remember(event.event_id);
```

Busiz bitta sotuv ikki marta hisoblanib, **pul xatosi** bo'ladi.

### 6.5 Statuslar

| `status` | Ma'nosi | Terminalmi |
|---|---|---|
| `new` | Elchi qabul qildi | yo'q |
| `received` | Punktda | yo'q |
| `on the road` | Kuryerda | yo'q |
| `waiting` | Yetkazish jarayonida | yo'q |
| `sold` | **Yetkazildi**, pul yig'ildi | ✅ ha |
| `paid` / `partly_paid` | Yetkazildi va hisob-kitob qilindi | ✅ ha |
| `cancelled` | Bekor qilindi | ✅ ha |
| `returned_to_market` | Sotuvchiga qaytarildi | ✅ ha |

Ro'yxatda yo'q statusni **xato deb hisoblamang** — yozib qo'ying va
e'tiborsiz qoldiring. Biz yangi oraliq status qo'shishimiz mumkin.

### 6.6 Sandbox — sinov manzili

Operator qo'shimcha **`sandbox_webhook_url`** qo'yishi mumkin. Unda har bir
hodisaning **nusxasi** o'sha manzilga ham boradi:

- yukda `"sandbox": true`;
- sarlavhada `X-Elchi-Sandbox: 1`.

Bu prodakshn qabul qiluvchisiga tegmasdan haqiqiy hodisalar oqimini
kuzatish uchun. Sandbox xatosi **asosiy yetkazishga ta'sir qilmaydi** va
qayta urinilmaydi.

### 6.7 Ulanishni sinash

Operator admin panelidan **sinov hodisasi** yubora oladi — haqiqiy buyurtma
kutmasdan:

```json
{
  "event": "webhook.test",
  "event_id": "...",
  "test": true,
  "message": "Elchi sinov webhooki — buyurtmaga ta'sir qilmaydi",
  "occurred_at": "2026-09-12T09:00:00.000Z"
}
```

Sizning tomoningiz shu hodisani **imzo tekshiruvidan o'tkazib**, 2xx
qaytarishi kerak. `event === 'webhook.test'` bo'lsa buyurtma bilan hech
narsa qilmang.

---

## 7. Ulanish tartibi (checklist)

- [ ] Operatordan **API kalit** oling, `GET /partner/ping` bilan tekshiring
- [ ] `regions` va `districts` ni olib **keshlang**, tumanlarni **SOATO
      bo'yicha** moslang
- [ ] Har sotuvchi uchun `POST /partner/markets`, `elchi_market_id` ni saqlang
- [ ] Webhook endpointini yozing: **xom tana** + **imzo tekshiruvi** +
      **`event_id` bo'yicha takror himoyasi** + tez 2xx
- [ ] Operatorga `webhook_url` va `webhook_secret` bering
- [ ] Operator **sinov hodisasini** yuborsin — 2xx kelishini tasdiqlang
- [ ] Sinov buyurtmasini `POST /partner/shipments` bilan yuboring
- [ ] Statusni webhook orqali olganingizni tekshiring
- [ ] Pul maydonlarini o'z daftaringiz bilan solishtirib ko'ring (§5.3)
- [ ] `429` va `5xx` uchun backoff bilan qayta urinish yozing
- [ ] `trace_id` ni loglaringizda saqlang

---

## 8. Tez-tez uchraydigan xatolar

| Alomat | Sabab |
|---|---|
| Webhookda `401 invalid signature` | JSON parse qilib qayta serializatsiya qilingan — **xom tana** kerak |
| Bitta sotuv ikki marta hisoblandi | `event_id` bo'yicha takror himoyasi yo'q |
| `403 IP ruxsat etilmagan` | Operator IP ro'yxatini qo'ygan, sizning chiquvchi IP'ingiz unda yo'q |
| Posilka dublikat bo'ldi | Timeoutdan keyin **boshqa** `external_order_id` bilan yuborilgan |
| Pul summasi mos kelmaydi | `cod_amount` va `subtotal` teng yuborilmagan (§5.2) |
| Tuman topilmadi | Nom bo'yicha moslangan — **SOATO** bo'yicha moslash kerak |
| `data` `undefined` chiqdi | Javob qobig'i `{statusCode, message, data}` — `body.data` ni o'qing |
| Katalogda mahsulot dublikati | `external_product_id` yuborilmagan |

---

## 9. Yordam

Muammo bo'lsa quyidagilarni bering:

- `trace_id` (xato javobidan)
- `external_order_id` yoki `shipment_id`
- so'rov vaqti (UTC)
- `event_id` (webhook muammosi bo'lsa)

Bu ma'lumot bilan biz loglardan aniq so'rovni topamiz.
