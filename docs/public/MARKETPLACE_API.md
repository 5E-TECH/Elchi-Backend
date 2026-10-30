# Elchi Pochta — Marketplace API

**Dasturchilar uchun qo'llanma** · Versiya 1 · Oxirgi yangilanish: 2026-10-30

> Tayyor so'rovlar to'plami (Postman): [`elchi-partner-api.postman_collection.json`](./elchi-partner-api.postman_collection.json)
> — o'zgaruvchilar `{{base_url}}`, `{{api_key}}`, `{{elchi_market_id}}`, `{{shipment_id}}`.

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
   ko'pini birdan so'rash            POST /partner/shipments/status

4. Kerak bo'lsa yangilash            PATCH /partner/shipments/:id
   yoki bekor qilish                 POST /partner/shipments/:id/cancel
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
- solishtirish kerak bo'lsa posilkalarni **bittalab emas**, 100 tadan
  `POST /partner/shipments/status` bilan so'rang (§5.6);
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

| Query | Majburiy | Izoh |
|---|---|---|
| `elchi_market_id` | ✅ | Sizning sotuvchingiz marketi (§5.1) |
| `where_deliver` | — | `center` (punktdan olib ketish) yoki `address` (uyga yetkazish). Standart: `address` |
| `weight_kg` | — | Posilkaning **jami** og'irligi, kg (0.001–10000, ko'pi bilan 3 kasr). Bir nechta mahsulot bo'lsa — yig'indi |
| `length_cm`, `width_cm`, `height_cm` | — | Posilka o'lchami, sm (butun son, 1–1000). **Uchalasi birga** — bittasi yetishmasa 400 |
| `express` | — | `true` / `false` — tezkor yetkazish |
| `pickup` | — | `true` / `false` — kuryer chaqiruvi (bitta posilkali tashrif) |
| `region_id`, `district_id` | — | Qabul qiluvchi hududi (§4). Berilmasa yo'nalish `where_deliver` bo'yicha olinadi — Toshkent shahri ichidagi arzonroq tarif hisobga olinmaydi |

Yangi parametrlarsiz so'rov avvalgidek ishlaydi: `market_tariff` o'zgarmaydi,
javobga qo'shimcha maydonlar qo'shiladi xolos.

```json
{
  "statusCode": 200,
  "message": "tariff",
  "data": {
    "elchi_market_id": "121",
    "where_deliver": "center",
    "market_tariff": 15000,
    "tariff_source": "profile",
    "estimated": false,
    "quote": {
      "tariffId": "center",
      "base": 40000,
      "perExtraKg": 4000,
      "actualKg": 3,
      "volumetricKg": 4.8,
      "volumetricFromKg": 0,
      "volumetricApplied": true,
      "billableKg": 4.8,
      "extraKg": 4,
      "extra": 16000,
      "subtotal": 56000,
      "expressFee": 0,
      "pickupFee": 0,
      "total": 56000,
      "totalWithPickup": 56000,
      "basis": "volume",
      "missingDimensionItems": 0,
      "estimated": false,
      "daysMin": 1,
      "daysMax": 2,
      "days": [1, 2],
      "cityRoute": false
    }
  }
}
```

| Javob maydoni | Ma'nosi |
|---|---|
| `market_tariff` | **Elchi sotuvda oladigan summa** — mijozga shuni ko'rsating. Sotuv hisobi bilan bitta manbadan chiqadi |
| `tariff_source` | `profile` — market profilidagi kelishilgan tarif; `engine` — vazn/hajm dvigateli (standart narx + qo'shimcha) |
| `estimated` | `true` — narx **taxminiy**: o'lchov berilmagan yoki to'liq emas, ya'ni baza tarif olingan. Haqiqiy narx mahsulot o'lchangandan keyin farq qilishi mumkin |
| `quote` | Dvigatel hisobi (`billableKg`, `extra`, `total` va h.k.). O'lchov, `express` yoki `pickup` berilganda keladi; dvigatel o'chiq bo'lsa ham ma'lumot uchun qaytadi. Boshqa holatda `null` |

- **`market_tariff` va `quote.total` farq qiladi.** Birinchisi — market
  shartnomasidagi narx (+ yoqilgan bo'lsa vazn/hajm qo'shimchasi), ikkinchisi —
  Elchi umumiy tarif jadvali. Mijozga `market_tariff` ko'rsatiladi.
- **`express` va `pickup`** faqat `quote` da (`expressFee`, `pickupFee`,
  `totalWithPickup`); `market_tariff` ga kirmaydi.
- **Profilda tarif yo'q (`null`)** — `market_tariff` tarif jadvalidagi baza
  (jimgina 0 emas), `estimated: true`. Tarif jadvali ham javob bermasa — **503**,
  keyinroq qayta so'rang.
- **Profilda aniq `0`** (§5.1: tarif berilmasa — 0) — bu kelishuv: `market_tariff`
  `0` qoladi, chunki sotuvda ham 0 olinadi. Taqqoslash uchun `quote` qaytadi.
- Dvigatel vaqtincha javob bermasa — so'rov yiqilmaydi: profil tarifi,
  `estimated: true`, `quote: null`.
- `elchi_market_id` sizniki bo'lmasa — **404**. Noto'g'ri o'lchov — **400**.

#### Savatdagi narx va Elchi oladigan narx

Tarif so'rovida qanday o'lchov bersangiz, posilkada ham shuni yuboring (§5.2) —
aks holda savatdagi narx bilan Elchi oladigan narx ajraladi:

| Holat | Savatda (`market_tariff`) | Elchi sotuvda | Farq |
|---|---|---|---|
| Vazn/hajm narxi o'chiq (hozirgi holat) | Profil tarifi | Profil tarifi | Yo'q |
| Yoqiq, posilka `{ name, quantity }` — katalogsiz | Profil tarifi | Profil tarifi (o'lchovsiz — qo'shimcha 0) | Yo'q, faqat minimal narx qoidasi sotuvda tarifni ko'tarishi mumkin |
| Yoqiq, mahsulot o'lchovi Elchi'da bor, tarif o'lchovsiz so'ralgan | Profil tarifi, `estimated: true` | Profil + vazn/hajm qo'shimchasi | **Bor** — o'lchovni `GET /partner/tariff` ga yuboring |
| Tarif savat va sotuv orasida o'zgardi | Eski tarif | Yangi tarif | **Bor** — tarif sotuv paytida qotiriladi |

---

## 5. Asosiy oqim

### 5.1 Sotuvchini ro'yxatga olish

Har bir sotuvchi (do'kon) Elchi tomonida **market akkaunti** oladi. Bu bir
marta bajariladi va **idempotent** — takror chaqirsangiz o'sha akkaunt
qaytadi, yangisi ochilmaydi.

```http
POST /partner/markets
X-Api-Key: elp_...
Content-Type: application/json

{
  "external_seller_id": "seller-4471",
  "name": "Zamon Store",
  "phone": "+998901234567",
  "tariff_home": 25000,
  "tariff_center": 15000
}
```

**Birinchi chaqiruv** — yangi market ochildi, **201**:

```json
{
  "statusCode": 201,
  "message": "market provisioned",
  "data": { "elchi_market_id": "121" }
}
```

**Takror chaqiruv** (ayni `external_seller_id`) — **200**, yangi market
ochilmaydi:

```json
{
  "statusCode": 200,
  "message": "market already provisioned",
  "data": { "elchi_market_id": "121", "idempotent": true, "tariff_updated": false }
}
```

| Maydon | Majburiy | Izoh |
|---|---|---|
| `external_seller_id` | ✅ | **Idempotency kaliti** — sizning tizimingizdagi sotuvchi id'si. O'zgarmas bo'lishi kerak |
| `name`, `phone` | ✅ | Faqat **birinchi** chaqiruvda ishlatiladi (market nomi va telefoni) |
| `tariff_home`, `tariff_center` | — | Elchi xizmat haqi (so'm): uyga / punktgacha. Birinchi chaqiruvda berilmasa — 0 |
| `region_id`, `district_id` | — | Qabul qilinadi, hozircha ishlatilmaydi |

- `elchi_market_id` ni **saqlab qo'ying** — har posilkada kerak (§5.2).
- **Tarif yangilash.** Takror chaqiruvda tarif berilsa, Elchi'dagi tarif
  **ustidan yoziladi** va javobda `tariff_updated: true`. Faqat bittasini
  yuborsangiz (masalan `tariff_center`), ikkinchisi **o'zgarmaydi** (0 ga
  tushib, bepul yetkazishga aylanib qolmaydi). Tarif berilmasa — hech narsa
  o'zgarmaydi.
- **Market kabinetiga kirish.** Market akkaunti tasodifiy parol bilan
  ochiladi — sotuvchi Elchi kabinetiga kirishi kerak bo'lsa, login/parolni
  Elchi operatori o'rnatadi.
- **Sotuvchi Elchi'da allaqachon market bo'lsa.** Yangi market ochish o'rniga
  Elchi operatori sizning `external_seller_id` ni o'sha **mavjud marketga
  bog'laydi** (admin panel). Shundan keyin `POST /partner/markets` ni
  **tarifsiz** chaqiring — javob 200 `idempotent: true` va mavjud
  `elchi_market_id` bo'ladi (tarif yuborsangiz, ichki tarif ustidan yoziladi).

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
| `customer.name`, `customer.phone` | ✅ | Mijoz — telefon bo'yicha topiladi/yaratiladi. Telefon O'zbekiston raqami bo'lishi shart (pastga qara) |
| `district_id` | ✅ | §4 dan |
| `region_id` | — | §4 dan. Berilmasa tumandan aniqlanadi |
| `where_deliver` | — | `center` \| `address` (**standart: `center`** — punktdan olib ketish) |
| `address` | — | Uyga yetkazish manzili. ⚠️ `where_deliver: "address"` da bo'sh manzil ham **qabul qilinadi** (rad etilmaydi) — lekin kuryer manzilni mijozdan so'rab aniqlaydi, shuning uchun **yuboring** |
| `items[]` | — | `{ name, quantity?, external_product_id?, weight_kg?, length_cm?, width_cm?, height_cm? }` — o'lchov ixtiyoriy (pastga qara) |
| `cod_amount` | ✅ | Kuryer mijozdan **yig'adigan** summa. `0` = oldindan to'langan |
| `subtotal` | ✅ | Buyurtma summasi — **`cod_amount` bilan teng yuboring** (pastga qara). Berilmasa `cod_amount` olinadi |
| `label_token` | — | Sizning **yorlig'ingizdagi QR** qiymati: 8–128 belgi, faqat `A-Z a-z 0-9 _ -`. Berilsa Elchi uni posilkaga yozadi va yorliq **QR sifatida chop etiladi / skanerlanadi**. Boshqa posilkada band bo'lsa — **409**. Berilmasa Elchi o'z tokenini yaratadi (javobdagi `qr_code_token`) |
| `batch_ref` | — | Qop / pochta id'ingiz (≤128) — kiruvchi ekranda posilkalarni guruhlash uchun |
| `batch_label_token` | — | **Qop ustidagi QR** (format `label_token` bilan bir xil). Operator bitta skan bilan qopdagi barcha posilkani qabul qiladi |
| `batch_size` | — | Qopdagi posilka soni (1–10000) — Elchi o'zi sanagani bilan solishtiradi |
| `comment` | — | Izoh (≤1000) — Elchi kuryeri yetkazishda ko'radi. Berilmasa mahsulotlar ro'yxatidan tuziladi |

Jadvalda yo'q maydon yuborilsa — **400** (`property … should not exist`).

#### ⚠️ `cod_amount` va `subtotal` teng bo'lishi kerak

Elchi'ning sotuv matematikasi buyurtma **to'liq narxi** ustida ishlaydi. Ikki
maydon farq qilsa, pul hisobi siz kutgandan boshqacha chiqadi. Oldindan
to'langan buyurtmada esa ikkalasini ham to'g'ri yuborish muhim:

```
Naqd (COD):        cod_amount = 450000,  subtotal = 450000
Oldindan to'langan: cod_amount = 0,      subtotal = 450000
```

#### Telefon formati

Telefon **`+998XXXXXXXXX`** ko'rinishiga keltiriladi. Qabul qilinadi:
`+998901234567`, `998901234567`, `0901234567`, `901234567`, probel, qavs va
defis bilan ham (`+998 (90) 123-45-67`). Boshqa narsa (`not-a-phone`, chet el
raqami) — **400**.

Nega: mijoz telefon bo'yicha topiladi. Ilgari raqam xom holda saqlanardi va
bitta odam formatiga qarab bir nechta mijozga bo'linib ketardi.

#### `external_product_id` — nega muhim

Berilsa, Elchi katalogida mahsulot **avtomatik yaratiladi** (yo'q bo'lsa) va
keyingi posilkalarda **qayta ishlatiladi**. Bog'lanish **id bo'yicha**, nom
bo'yicha emas — shuning uchun mahsulot nomini o'zgartirsangiz katalogda
dublikat paydo bo'lmaydi va hisobot buzilmaydi.

Berilmasa nom faqat matn bo'lib qoladi: posilka ishlaydi, lekin mahsulot
bo'yicha hisobotda qatnashmaydi.

#### Mahsulot o'lchovi — `weight_kg`, `length_cm`, `width_cm`, `height_cm`

Ixtiyoriy: eski so'rovlar o'zgarishsiz ishlaydi. O'lchov yetkazish narxiga
kiradi, shuning uchun imkon bo'lsa yuboring.

- Birliklar: og'irlik — kg (0.001–1000, ko'pi bilan 3 kasr), o'lchamlar — sm
  (butun son, 1–1000). `length_cm`, `width_cm`, `height_cm` **uchalasi birga** —
  bittasi yetishmasa **400**.
- O'lchov **`external_product_id` bilan birga** ishlaydi: Elchi uni avtomatik
  yaratilayotgan mahsulotga yozadi. Mahsulot avval o'lchovsiz yaratilgan bo'lsa,
  bo'sh maydonlari to'ldiriladi. Elchi xodimi kiritgan o'lchov **almashtirilmaydi**.
  `external_product_id` siz o'lchov saqlanmaydi (saqlaydigan mahsulot yo'q).
- O'lchovsiz mahsulot ham **qabul qilinadi** — posilka rad etilmaydi. Mahsulot
  Elchi'da «o'lchov kutilmoqda» deb belgilanadi va xodim o'lchaguncha narx baza
  tarifga tushadi.

#### Idempotentlik

Bir xil `external_order_id` bilan takror yuborsangiz **yangi posilka
YARATILMAYDI**:

```json
{
  "statusCode": 200,
  "message": "shipment already exists",
  "data": {
    "shipment_id": "124",
    "order_status": "new",
    "qr_code_token": "c0ae6c9e2b92c13cc05f5b2b",
    "to_be_paid": 450000,
    "cod_amount": 450000,
    "total_price": 450000,
    "idempotent": true,
    "mismatched_fields": []
  }
}
```

`statusCode` `201` emas `200` va `idempotent: true` — shundan bilib olasiz.

> ⚠️ **Takror yuborish QIYMATLARNI YANGILAMAYDI.** Narx yoki manzilni
> o'zgartirib qayta `POST` qilsangiz, Elchi'dagi posilka o'zgarmaydi. Javobda
> Elchi'da **haqiqatan turgan** `cod_amount`/`total_price` va siz yuborgandan
> farq qilgan maydonlar (`mismatched_fields`) qaytadi — bo'sh bo'lmasa,
> o'zgarishni `PATCH /partner/shipments/:id` bilan yuboring (§5.5).

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
- Muvaffaqiyatli bekor qilishda webhook `status: "cancelled"` keladi (§6.5).
- Allaqachon bekor qilingan bo'lsa **200** va `idempotent: true`.

### 5.5 Yangilash

```http
PATCH /partner/shipments/124
X-Api-Key: elp_...
Content-Type: application/json

{ "cod_amount": 420000, "subtotal": 420000 }
```

Faqat yuborilgan maydonlar o'zgaradi: `cod_amount`, `subtotal`, `items`,
`address`, `district_id`, `region_id`, `where_deliver`, `comment`. Javob —
§5.3 dagi shakl va `updated_fields`.

| Nima | Qachongacha mumkin | Keyin |
|---|---|---|
| Narx (`cod_amount`, `subtotal`), `items` | Elchi posilkani **qabul qilmaguncha** (`created`, `new`) | **409** — posilkani bekor qilib, qayta yuboring |
| Manzil, tuman, `where_deliver` | Posilka filialga **jo'natilmaguncha** | **400** |
| Hammasi | Yakuniy holatgacha | Sotilgan / bekor / qaytarilgan → **409** |

Qoidalar Elchi'ning ichki tahrir qoidalari bilan bir xil: qabul qilingan
posilkaning summasi pochta va kassa bilan bog'langan bo'ladi.

### 5.6 Ko'p posilka holati — bitta so'rovda

```http
POST /partner/shipments/status
X-Api-Key: elp_...
Content-Type: application/json

{ "shipment_ids": ["124", "ORD-2026-55124", "125"] }
```

```json
{
  "statusCode": 200,
  "message": "shipments",
  "data": {
    "items": [ { "shipment_id": "124", "status": "sold", "...": "..." } ],
    "not_found": ["ORD-2026-55124"],
    "failed": []
  }
}
```

- 100 tagacha id; `shipment_id` yoki `external_order_id`.
- `items[]` elementlari **§5.3 bilan aynan bir xil** shaklda.
- Topilmagan (yoki boshqa hamkorga tegishli) id — `not_found`; vaqtinchalik
  xato — `failed` (shu id larni keyinroq qayta so'rang).

---

## 6. Webhook — statusni real vaqtda olish

Buyurtma statusi o'zgarganda biz **sizning manzilingizga POST** qilamiz.
Statusni so'rab turishdan (`polling`) **ancha yaxshi**: tez va rate limitni
yemaydi.

Operatorga bering:
- **`webhook_url`** — bizning POST manzilimiz (HTTPS, ommaviy);
- **`webhook_secret`** — imzo kaliti (uzun tasodifiy satr).

### 6.1 So'rov

Ikki xil hodisa keladi (`event` maydoni): `shipment.status_changed` — posilka
holati (§6.5) va `settlement.payment` — Elchi sotuvchiga to'lov qildi (§6.6).

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
  "market_paid_amount": 0,
  "collected_from_customer": 450000,
  "elchi_fee": 15000,
  "market_amount": 435000,
  "total_price": 450000,
  "extra_cost": 0,
  "occurred_at": "2026-09-12T09:30:01.235Z"
}
```

`collected_from_customer` (kuryer mijozdan yig'gan naqd), `elchi_fee` (Elchi
ushlagan tarif) va `market_amount` (Elchi sizga qarz) — sotuvdan keyin
(`sold`, `paid`, `partly_paid`) raqam; sotuvgacha (`received`, `on the road`,
`waiting` …) **`null`** — "hali hisoblanmagan", 0 emas. `cod_collected` /
`market_paid_amount` — sotuv holatlaridan boshqasida 0.

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

`shipment.status_changed` hodisasida **haqiqatan yuboriladigan** `status`
qiymatlari:

| `status` | Ma'nosi | Terminalmi |
|---|---|---|
| `received` | Elchi posilkani **qabul qildi** (HQ / punktga keldi, skanerlandi) | yo'q |
| `on the road` | Posilka **pochta bilan yo'lda** — filial / viloyat punktiga ketmoqda (kuryer qo'lida mijozga ketayotgani **emas**) | yo'q |
| `waiting` | Yetkazish jarayonida (kuryerda / yetkazib bo'lmadi, qayta uriniladi; bekor yoki sotuvdan qaytarilganda ham shu) | yo'q |
| `waiting_customer` | Kuryer mijozga yetkaza olmadi (javob bermadi / keyinga qoldirdi) — hali terminal emas | yo'q |
| `sold` | **Yetkazildi**, pul yig'ildi | ✅ ha |
| `paid` / `partly_paid` | Yetkazildi va hisob-kitob qilindi | ✅ ha |
| `cancelled` | Bekor qilindi | ✅ ha |
| `cancelled (sent)` | Bekor qilindi va posilka sotuvchiga qaytarish pochtasiga qo'shildi | ✅ ha |
| `returned_to_market` | Sotuvchiga qaytarildi | ✅ ha |

`new` (posilka Elchi'da **yaratildi**, hali qabul qilinmagan) — `POST
/partner/shipments` javobidagi `order_status` va `GET /partner/shipments/:id`
da ko'rinadi; webhook sifatida **kelmaydi**.

Ro'yxatda yo'q statusni **xato deb hisoblamang** — yozib qo'ying va
e'tiborsiz qoldiring. Biz yangi oraliq status qo'shishimiz mumkin.

### 6.6 `settlement.payment` — sotuvchiga to'lov

Elchi sizning sotuvchingizga (market) pul to'laganda yuboriladi. Imzo, qayta
urinish va `event_id` qoidalari — yuqoridagidek.

```json
{
  "event": "settlement.payment",
  "event_id": "5b0e7d0a-2f7f-4c43-9a4a-2a8d6c1f8e11",
  "payment_id": "8812",
  "amount": 1250000,
  "paid_at": 1789203601000,
  "market_id": "121",
  "occurred_at": "2026-09-12T09:40:01.000Z",
  "note": null
}
```

| Maydon | Izoh |
|---|---|
| `payment_id` | To'lovning barqaror id'si — **daftaringizda takror kaliti** (bir to'lov ikki marta kelsa ham bir marta yozing) |
| `amount` | To'langan summa (so'm, > 0) |
| `paid_at` | To'lov vaqti, epoch **millisekund** |
| `occurred_at` | O'sha vaqt ISO formatda |
| `market_id` | `elchi_market_id` (§5.1) |
| `note` | Izoh yoki `null` |

Faqat sizga **faol bog'langan** marketlar bo'yicha keladi.

### 6.7 Sandbox — sinov manzili

Operator qo'shimcha **`sandbox_webhook_url`** qo'yishi mumkin. Unda har bir
hodisaning **nusxasi** o'sha manzilga ham boradi:

- yukda `"sandbox": true`;
- sarlavhada `X-Elchi-Sandbox: 1`.

Bu prodakshn qabul qiluvchisiga tegmasdan haqiqiy hodisalar oqimini
kuzatish uchun. Sandbox xatosi **asosiy yetkazishga ta'sir qilmaydi** va
qayta urinilmaydi.

### 6.8 Ulanishni sinash

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
      (sotuvchi Elchi'da allaqachon market bo'lsa — avval operator bog'laydi, §5.1)
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
