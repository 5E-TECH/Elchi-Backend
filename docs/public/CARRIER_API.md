# Elchi Pochta — Carrier API (tashqi yetkazuvchi)

**Dasturchilar uchun qo'llanma** · Versiya 1 · Oxirgi yangilanish: 2026-11-14

> Qisqa variant: [`CARRIER_API_QUICKSTART.md`](./CARRIER_API_QUICKSTART.md).
> Interaktiv hujjat (Swagger, faqat Carrier API): test —
> `https://test-api.elchipochta.uz/carrier-docs`, production —
> `https://api.elchipochta.uz/carrier-docs` (login va parolni Elchi beradi;
> muhitlar — §1 «Baza manzili»). Mashina o'qiydigan spec:
> [`carrier-openapi.json`](./carrier-openapi.json) (Postman / kod generatori;
> ikkala server ham ichida).

Bu hujjat Elchi Pochta posilkalarini **yetkazib beradigan tashqi kompaniya**
dasturchisi uchun. Unda quyidagilar bor: posilka QR'ini skanerlab buyurtma
ma'lumotini olish, yetkazish natijasini (sotildi, qisman sotildi, bekor
qilindi) Elchi'ga yuborish, bekor qilingan posilkani qaytarish va
hisob-kitobni kuzatish.

> **Marketplace API bilan adashtirmang.** `/partner/*` (Marketplace API,
> [`MARKETPLACE_API.md`](./MARKETPLACE_API.md)) Elchi'ga buyurtma
> **beradiganlar** uchun. Bu hujjatdagi `/carrier/*` esa Elchi buyurtmasini
> **yetkazadiganlar** uchun. Kalitlar ham alohida: biri ikkinchisida ishlamaydi.

---

## 1. Umumiy tasavvur

Elchi'da siz **bitta kurier akkaunti** sifatida ro'yxatdan o'tasiz. Bu bir
marta, ulanishda qilinadi. Keyingi oqim:

```
1. Elchi xodimi buyurtmani sizning kurier akkauntingizga biriktiradi
   (bu Elchi ichida bo'ladi, sizdan so'rov kerak emas).

2. Posilkani qo'lingizga olganda QR'ni skanerlaysiz   POST /carrier/scan
   → buyurtma ma'lumoti qaytadi va posilka sizda "qabul qilindi"
     (waiting) holatiga o'tadi.

3. Yetkazish natijasini yuborasiz                     POST /carrier/orders/:id/status
   sold | partly_sold | cancelled

4. Bekor qilingan posilkalarni qaytarasiz             POST /carrier/returns

5. Solishtirish va hisob-kitob                        GET  /carrier/orders
                                                      GET  /carrier/cashbox
```

**Muhim tushunchalar:**

- Siz **faqat o'zingizga biriktirilgan** (yoki hozir qo'lingizdagi)
  buyurtmalarni ko'rasiz. Boshqa buyurtmaning QR'i yoki id'si yuborilsa
  **404** qaytadi. Bunday buyurtma bazada bor-yo'qligi ham aytilmaydi.
- Sotilgan buyurtma summasi sizning **kurier kassangizga** yoziladi.
  Naqdni Elchi'ga topshirganingizda kassadan ayiriladi (§7).
- Statuslar **bizning nomlarimizda** yuboriladi (§5.2). Sizdagi ichki
  statuslarni shu uchtasiga o'zingiz moslaysiz.
- Viloyat va tuman **nomi emas, SOATO kodi** bilan keladi (§4).

### Baza manzili

| Muhit | Baza manzili (`BASE_URL`) | Swagger |
|---|---|---|
| Test | `https://test-api.elchipochta.uz` | `https://test-api.elchipochta.uz/carrier-docs` |
| Production | `https://api.elchipochta.uz` | `https://api.elchipochta.uz/carrier-docs` |

- Avval **test muhitida** sinang: kontrakt production bilan bir xil, lekin
  ma'lumot faqat sinov uchun (haqiqiy mijoz va pul yo'q).
- Test va production — **alohida tizimlar**: kalit, kurier akkaunti va
  buyurtmalar alohida. Test kaliti production'da ishlamaydi (va aksincha).
- Swagger sahifasi login/parol (Basic Auth) bilan yopiq — ularni Elchi beradi.
  U yerda **Authorize** tugmasiga `X-Api-Key` ni kiritib, "Try it out" bilan
  so'rov yuborish mumkin; so'rov sahifa ochilgan muhitga ketadi.
- Yo'llarda `/api` yoki versiya prefiksi yo'q: `BASE_URL` + `/carrier/...`.

---

## 2. Autentifikatsiya

Har bir so'rovda **`X-Api-Key`** sarlavhasi bo'lishi kerak:

```http
GET /carrier/ping HTTP/1.1
Host: test-api.elchipochta.uz
X-Api-Key: elc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- JWT **ishlatilmaydi**, faqat API kalit. Kalit `elc_` bilan boshlanadi.
- Kalit **bir marta** ko'rsatiladi (yaratilganda). Bazada faqat uning
  SHA-256 hash'i saqlanadi, shuning uchun biz uni tiklab bera olmaymiz.
  Yo'qotsangiz, yangisi beriladi.
- Kalitni Elchi operatori yangilaydi (rotate). Bunda **eski kalit darhol
  ishlamay qoladi**.
- Kurier akkauntining **paroli sizga berilmaydi** va kerak ham emas: barcha
  amallar shu kalit orqali bajariladi. Elchi kurier akkauntini bloklasa,
  kalit ham ishlamay qoladi (`403`, `CARRIER_COURIER_INACTIVE`).

### IP cheklovi (ixtiyoriy)

Operator akkauntingizga IP ro'yxatini qo'yishi mumkin. Qabul qilinadigan
yozuvlar: IPv4 manzil (`203.0.113.10`), IPv4 diapazon (`203.0.113.0/24`) va
IPv6 manzil (`2001:db8::1`). **IPv6 diapazon qo'llab-quvvatlanmaydi.**
Serveringiz IPv6 orqali chiqsa, IPv6 manzilini ham bering. Ro'yxat **bo'sh
bo'lsa cheklov yo'q**. Ro'yxatdan tashqari manzildan kelgan so'rovga **403**
qaytadi va xabarda aniqlangan IP ko'rsatiladi.

### Rate limit

- Akkaunt uchun **daqiqada 120 so'rov** — barcha `/carrier/*` endpointlari
  birgalikda.
- Qo'shimcha ravishda har bir endpoint uchun bitta IP manzildan daqiqada
  120 so'rov.

Oshsa **429** qaytadi (`Retry-After` sarlavhasi bilan). Solishtirish uchun
buyurtmalarni bittalab so'ramang, `GET /carrier/orders` bilan sahifalab
oling (§5.3).

---

## 3. Javob shakllari

### Muvaffaqiyat

**Barcha** `/carrier/*` javoblari shu qobiqda keladi:

```json
{
  "statusCode": 200,
  "message": "Buyurtma topildi",
  "data": { ... }
}
```

### Xatolar

```json
{
  "statusCode": 409,
  "message": "Bu Idempotency-Key oldingi urinishga tegishli — amal qayta bajarilmadi. Yangi kalit bilan yuboring",
  "code": "CARRIER_IDEMPOTENCY_KEY_STALE",
  "trace_id": "eaff465b-4c89-4721-b7c8-30cf22fb403e"
}
```

`trace_id` ni **saqlab qo'ying**: muammo bo'lganda biz shu id bo'yicha
loglardan aniq so'rovni topamiz. Qarorni xabar **matniga emas**,
`statusCode` va (bo'lsa) `code` ga qarab qabul qiling — matn o'zgarishi mumkin.

| Kod | Ma'nosi | Qayta urinishmi |
|---|---|---|
| `400` | So'rov noto'g'ri (maydon, `Idempotency-Key` yo'q — `CARRIER_IDEMPOTENCY_KEY_REQUIRED`, isbot fayli mos emas) yoki buyurtma bu amal uchun mos holatda emas | ❌ yo'q — tuzatish kerak |
| `401` | `X-Api-Key` yo'q yoki yaroqsiz | ❌ yo'q |
| `403` | Akkaunt o'chirilgan, bog'langan kurier faol emas (`CARRIER_COURIER_INACTIVE`) yoki IP ruxsat etilmagan | ❌ yo'q — Elchi'ga murojaat |
| `404` | Buyurtma topilmadi yoki sizga biriktirilmagan | ❌ yo'q |
| `409` + `IDEMPOTENCY_IN_PROGRESS` | Ayni `Idempotency-Key` bilan so'rov hali bajarilmoqda | ✅ ha, biroz kutib, **ayni** kalit bilan |
| `409` + `CARRIER_IDEMPOTENCY_KEY_STALE` | Kalit eski urinishga tegishli — amal bajarilmadi | ✅ ha, **yangi** kalit bilan |
| `413` | Isbot fayli 50 MB dan katta | ❌ yo'q |
| `422` + `IDEMPOTENCY_KEY_MISMATCH` | Shu `Idempotency-Key` boshqa amal, buyurtma yoki tana bilan ishlatilgan | ❌ yo'q — yangi kalit |
| `429` | Rate limitdan oshdi | ✅ ha, `Retry-After` kutib |
| `5xx`, `503`, `504` | Bizning tomonimizdagi vaqtinchalik xato yoki timeout (`CARRIER_KEY_CHECK_UNAVAILABLE`, `CARRIER_TEMPORARILY_UNAVAILABLE`) | ✅ ha, **ayni** `Idempotency-Key` bilan. 10 daqiqadan uzoq takrorlansa — `trace_id` bilan Elchi'ga murojaat qiling |

---

## 4. Buyurtma obyekti

`scan`, `status` va `orders` javoblaridagi `order` obyekti:

| Maydon | Tur | Izoh |
|---|---|---|
| `id` | string | Buyurtma id — `POST /carrier/orders/:id/status` uchun |
| `order_number` | string \| null | Inson o'qiydigan raqam |
| `qr_token` | string \| null | Yorliqdagi QR qiymati |
| `parent_order_id` | string \| null | Qisman sotuvdan ajralgan (sotilmagan) qism bo'lsa — asl buyurtma |
| `status` | string | Elchi'dagi holat (§6) |
| `total_price` | number | Buyurtma summasi, so'm |
| `paid_online_amount` | number | Mijoz oldindan onlayn to'lagan qism |
| `cod_amount` | number | **Mijozdan naqd olinadigan summa** = `total_price − paid_online_amount` |
| `where_deliver` | string \| null | `center` yoki `address` |
| `address` | string \| null | Yetkazish manzili |
| `comment` | string \| null | Buyurtmaga izoh |
| `customer` | object \| null | `{ name, phone_number, extra_number }` |
| `region`, `district` | object \| null | `{ id, soato_code }` — viloyat va tuman **nomi emas, rasmiy SOATO kodi** bilan (viloyat 4 xona, masalan `1726`; tuman 7 xona, masalan `1726294`). Geo'ni o'zingizdagi ma'lumotnomaga SOATO bo'yicha moslang. Obyekt `null` — buyurtmada viloyat/tuman yo'q; `soato_code: null` — bu hudud uchun SOATO kodi Elchi'da yo'q (bunda `id` dan foydalaning yoki Elchi'dan so'rang) |
| `market` | object \| null | Sotuvchi: `{ id, name }` |
| `replacement` | object \| null | Almashtirish buyurtmasi: `{ of_order_id, old_item_required }`. `old_item_required: true` bo'lsa eski mahsulotni mijozdan oling va sotishda `old_item_collected: true` yuboring (aks holda `400`). Oddiy buyurtmada `null` |
| `items` | array | `[{ id, product_id, name, quantity }]` — `id` qisman sotuvda kerak |
| `created_at` | string \| null | ISO vaqt |

Ro'yxatga **yangi maydon qo'shilishi mumkin**. Kodingiz noma'lum maydonni
e'tiborsiz qoldirsin. Mavjud maydon esa o'chirilmaydi va ma'nosi
o'zgarmaydi.

---

## 5. Asosiy oqim

### 5.1 Posilkani skanerlash

`POST /carrier/scan`

| Maydon | Tur | Majburiy | Izoh |
|---|---|---|---|
| `qr_token` | string | ✅ | Yorliqdagi QR qiymati (≤255 belgi) |

```json
{ "qr_token": "a1b2c3d4e5" }
```

Javob:

```json
{
  "statusCode": 200,
  "message": "Posilka qabul qilindi",
  "data": {
    "received": true,
    "order": { "id": "900", "status": "waiting", "cod_amount": 150000, "...": "..." }
  }
}
```

- Posilka **yo'lda** (`on the road`) yoki **mijozni kutishda**
  (`waiting_customer`) bo'lsa, skan uni sizga **qabul qiladi**: holati
  `waiting` ga o'tadi va `received: true` qaytadi. Sotish va bekor qilish
  faqat `waiting` holatida mumkin, shuning uchun posilkani **avval
  skanerlang**.
- `received: true` bilan `order: null`, `refreshed: false` — posilka qabul
  qilindi, lekin ma'lumotni hozir o'qib bo'lmadi: biroz kutib qayta
  skanerlang (endi `received: false` bilan to'liq ma'lumot keladi — bu normal).
- Boshqa holatda faqat ma'lumot qaytadi (`received: false`). Qayta skanerlash
  xavfsiz: allaqachon sotilgan yoki bekor qilingan buyurtma qayta "qabul
  qilinmaydi".
- Sizga biriktirilmagan posilka bo'lsa **404** qaytadi.

### 5.2 Holatni yuborish

`POST /carrier/orders/:id/status` · `application/json` yoki `multipart/form-data`
· **`Idempotency-Key` sarlavhasi majburiy**

| Maydon | Tur | Majburiy | Izoh |
|---|---|---|---|
| `status` | string | ✅ | `sold` · `partly_sold` · `cancelled` |
| `comment` | string | — | Izoh (≤1000 belgi). `reason: OTHER` bo'lsa majburiy |
| `reason` | string | `cancelled` da ✅ | `CUSTOMER_NO_ANSWER` · `CUSTOMER_REFUSED` · `WRONG_ADDRESS` · `DEFECTIVE_PRODUCT` · `PRICE_DISPUTE` · `OTHER` |
| `total_price` | number | `partly_sold` da ✅ | Mijoz **olgan** tovarlarning to'liq qiymati, so'm — oldindan onlayn to'langan qism (`paid_online_amount`) ham shu ichida. Buyurtma summasidan oshmaydi. Siz yig'adigan naqd = `max(total_price − paid_online_amount, 0)` |
| `items` | array | `partly_sold` da ✅ | Buyurtmaning **har bir** qatori va undan **sotilgan** dona (pastdagi jadval) |
| `old_item_collected` | boolean | almashtirishda ✅ | `order.replacement.old_item_required: true` bo'lsa — eski mahsulot mijozdan olindi |

`items[]` elementi:

| Maydon | Tur | Majburiy | Izoh |
|---|---|---|---|
| `order_item_id` | string | tavsiya | `order.items[].id` |
| `product_id` | string | `order_item_id` bo'lmasa ✅ | `order.items[].product_id` |
| `quantity` | integer | ✅ | Shu qatordan **sotilgan** dona (0 — hech narsa) |

**Statuslar:**

| Status | Nima bo'ladi | Shart |
|---|---|---|
| `sold` | Buyurtma to'liq sotildi. Summa kassangizga yoziladi (§7). Javobdagi holat `sold`, ba'zan darhol `paid`/`partly_paid` | Holat `waiting` |
| `partly_sold` | Qisman sotildi. Sotilmagan qism alohida `cancelled` buyurtma bo'lib ajraladi (`parent_order_id` bilan) va sizda qoladi — uni §5.5 bilan qaytarasiz | Holat `waiting`. `items` da buyurtmaning **har bir** qatori bo'lishi, kamida bitta qator kamaytirilgan va kamida bitta dona sotilgan bo'lishi kerak |
| `cancelled` | Mijoz olmadi. Pul harakati yo'q. Posilka sizda qoladi — uni §5.5 bilan Elchi filialiga qaytarasiz | Holat `waiting` |

Natija xato yuborilgan bo'lsa (masalan, sotilmagan posilka `sold` bo'lib
ketgan) — Elchi operatoriga murojaat qiling: tuzatishni operator qiladi.

Qo'shimcha xarajat (`extraCost`) va sotuvchiga to'g'ridan-to'g'ri to'lov
(`paidAmount`) **bu versiyada yo'q**. Bunday maydon yuborilsa 400 qaytadi.

#### Qisman sotuv misoli (oldindan to'langan buyurtma)

Buyurtma: `total_price = 300 000`, `paid_online_amount = 100 000`, ikki
qator (2 ta kurtka 100 000 dan, 1 ta shim 100 000). Mijoz 1 ta kurtka va
shimni oldi:

```json
{
  "status": "partly_sold",
  "total_price": 200000,
  "items": [
    { "order_item_id": "5501", "quantity": 1 },
    { "order_item_id": "5502", "quantity": 1 }
  ]
}
```

Siz yig'adigan naqd: `200 000 − 100 000 = 100 000`. Sotilmagan 1 ta kurtka
(`100 000`) alohida `cancelled` buyurtma bo'lib qoladi.

#### Isbot fayli (`proof`)

Sotuvchi isbot talab qilgan buyurtmada `multipart/form-data` bilan `proof`
fayli yuboriladi (aks holda 400 va xabarda sabab):

- rasm `jpeg`/`png`/`webp` yoki `pdf` — **≤10 MB**;
- video `mp4`/`mov`/`webm` — **≤50 MB** (kattasi — `413`);
- fayl qismi `Content-Type` i haqiqiy turga mos bo'lishi kerak (HEIC qabul
  qilinmaydi).

Multipart'da boshqa maydonlar matn bo'lib yuboriladi: `items` — bitta
JSON-massiv satri (`[{"order_item_id":"5501","quantity":1}]`) yoki har bir
qator alohida `items` qismi (JSON-obyekt satri), `total_price` — raqam satri,
`old_item_collected` — `true`/`false`.

#### Idempotentlik

`Idempotency-Key` **majburiy** (≤255 belgi). Qoida oddiy:

- **Har yangi urinish (niyat) uchun yangi kalit** — masalan UUID.
- Ayni kalitni **faqat shu so'rovni qayta yuborishda** ishlating (javob
  kelmadi, `409`, `429`, `5xx`, `504`). Amal ikkinchi marta bajarilmaydi.
- Buyurtma holati o'shandan beri o'zgargan bo'lsa (masalan, natijani Elchi
  operatori tuzatgan), keyingi yuborish — **yangi** kalit bilan. Eski kalit
  bilan yuborilsa amal bajarilmaydi va `409` `CARRIER_IDEMPOTENCY_KEY_STALE`
  qaytadi.
- Ayni kalit boshqa tana bilan yuborilsa **422** qaytadi.

```http
POST /carrier/orders/900/status HTTP/1.1
X-Api-Key: elc_…
Idempotency-Key: 6f1c2a8e-4b7d-4c1e-9a3f-2d5b8e7c1a90
Content-Type: application/json

{ "status": "sold" }
```

Javob — yangilangan buyurtma:

```json
{ "statusCode": 200, "message": "Holat qabul qilindi", "data": { "order": { "id": "900", "status": "sold", "...": "..." }, "refreshed": true } }
```

`refreshed: false` va `order: null` — holat **qabul qilindi**, lekin
yangilangan buyurtmani hozir o'qib bo'lmadi. **Qayta yubormang**: buyurtmani
keyinroq `GET /carrier/orders` bilan oling.

### 5.3 Buyurtmalar ro'yxati

`GET /carrier/orders?status=waiting,sold&from=2026-11-01&to=2026-11-10&page=1&limit=50`

| Parametr | Izoh |
|---|---|
| `status` | Vergul bilan ajratilgan holatlar (§6). Berilmasa barcha holatlar |
| `from`, `to` | **Buyurtma yaratilgan** kun oralig'i (`YYYY-MM-DD`, Toshkent vaqti, chegaralar kiradi) — biriktirilgan yoki sotilgan sana emas |
| `page` | 1 dan boshlanadi |
| `limit` | `10` · `25` · `50` · `100` (standart 50) |

Javob: `data: { items: Order[], total, page, limit }`. Bu yerda sizga
biriktirilgan yoki hozir qo'lingizdagi buyurtmalar chiqadi.

### 5.4 Kassa

`GET /carrier/cashbox?from=2026-11-01&to=2026-11-10`

Kurier kassangizning balansi va harakatlar tarixi: sotuvdan tushgan summalar
va Elchi'ga topshirgan naqdingiz. Pul qoidalari §7 da.

| Maydon | Tur | Izoh |
|---|---|---|
| `from`, `to` | string | Tarix oynasi (`YYYY-MM-DD`, Toshkent kunlari). Berilmasa — oxirgi 30 kun; eng ko'pi 92 kun (uzunroq oraliq — `400`, bo'lib so'rang) |
| `balance` | number | Joriy balans — Elchi'ga topshirilishi kerak bo'lgan summa. Oynaga **bog'liq emas** |
| `income`, `outcome` | number | Oynadagi jami kirim va chiqim |
| `history` | array | Oynadagi harakatlar (pastdagi jadval), yangidan eskiga |

> ⚠️ Kassa yozuvi holat yuborilgandan keyin **bir necha soniyada** paydo
> bo'ladi (pul yozuvlari navbat orqali, kafolatlangan holda yoziladi).
> `status` javobi kelgan zahoti kassada ko'rinmasa — biroz kutib qayta so'rang.

`history[]` elementi:

| Maydon | Tur | Izoh |
|---|---|---|
| `id` | string | Harakat id |
| `type` | string | Yo'nalish: `income` — kirim, `expense` — chiqim |
| `source_type` | string | Manba, masalan `sell` — sotuv, `cancel` — bekor, `correction` — tuzatish (Elchi operatori), `courier_payment` — topshirilgan naqd, `extra_cost`, `payment_reversal` — to'lov tuzatishi. Ro'yxat **ochiq**: yangi qiymat paydo bo'lishi mumkin |
| `amount` | number | Summa, so'm — **doim musbat**; yo'nalish `type` da. `sell` qatori ham `expense` bo'lishi mumkin (oldindan to'langan buyurtma, §7) |
| `balance_after` | number | Shu harakatdan keyingi balans |
| `order_id` | string \| null | Buyurtma bilan bog'liq qatorda — buyurtma id |
| `payment_method` | string \| null | To'lov usuli |
| `comment` | string \| null | Izoh |
| `created_at` | string \| null | ISO vaqt |

### 5.5 Bekor qilingan posilkalarni qaytarish

`POST /carrier/returns`

| Maydon | Tur | Majburiy | Izoh |
|---|---|---|---|
| `order_ids` | array | ✅ | Sizdagi `cancelled` posilkalar id'lari (qisman sotuvdan ajralgan qism ham), 1–50 ta |

```json
{ "order_ids": ["901", "905"] }
```

Javob: `data: { post_id, order_ids }`. Posilkalar Elchi'ning qaytarish
pochtasiga tushadi va holati `cancelled (sent)` bo'ladi. Posilkalarni Elchi
filialiga topshirasiz, filial pochtani qabul qiladi. Takroriy so'rov
xavfsiz: allaqachon shu pochtadagi posilka uchun o'sha `post_id` qaytadi.

Qaytarilgan posilka **`GET /carrier/orders` ro'yxatidan chiqadi** (u endi
sizda emas). Uni QR bo'yicha `POST /carrier/scan` bilan ko'rish mumkin
(holati `cancelled (sent)`, filial qabul qilgach — `cancelled`). Qaytarishni
javobdagi `post_id` bo'yicha kuzating.
`cancelled` bo'lmagan posilka bor bo'lsa — `400`, sizniki bo'lmagani — `404`
(id'lar xabarda).

---

## 6. Elchi'dagi holatlar

| Holat | Ma'nosi |
|---|---|
| `created`, `new`, `received` | Elchi ichida (hali sizga jo'natilmagan) |
| `on the road` | Sizga biriktirildi, hali skanerlanmagan |
| `waiting` | Sizda (skanerlangan) — natija kutilmoqda |
| `waiting_customer` | Mijozni kutish (yetkazib bo'lmadi). Skan uni yana sizga qabul qiladi (`waiting`) |
| `sold` | Sotildi |
| `paid`, `partly_paid` | Sotildi va sotuvchi bilan hisob-kitob qilindi (Elchi ichida) |
| `cancelled` | Bekor qilindi. Posilka hali sizda — §5.5 bilan qaytaring |
| `cancelled (sent)` | Bekor qilingan posilka qaytarish pochtasida (Elchi filialiga) |
| `returned_to_market` | Posilka sotuvchiga qaytarildi |
| `closed` | Yopilgan (eski yozuvlar) |

Holatlar ro'yxati **kengayishi mumkin**: kodingiz noma'lum holatni xato deb
emas, "boshqa" deb qabul qilsin.

---

## 7. Pul qanday hisoblanadi

- **Sotuvda** kassangizga yoziladigan summa: mijozdan olingan naqd
  (`cod_amount`, qisman sotuvda `total_price − paid_online_amount`) minus
  **sizning yetkazish haqingiz** (shartnomadagi tarif). Bu siz Elchi'ga
  topshirishingiz kerak bo'lgan summa (`income` qatori).
- Buyurtma oldindan to'langan bo'lsa va naqd yetkazish haqidan kam bo'lsa,
  farq **`expense`** qatori bo'lib yoziladi (`source_type: sell`, `amount`
  musbat): balans kamayadi — ya'ni Elchi sizga qarzdor.
- **Bekor qilishda** pul harakati yo'q.
- **Naqdni topshirganingizda** Elchi xodimi uni qabul qiladi. Kassangizdan
  **chiqim** yoziladi (`courier_payment`) va tarixda ko'rinadi (§5.4).
  Topshirilgan pul eng eski sotuvlardan boshlab yopiladi.
- Xato yuborilgan natijani Elchi operatori tuzatadi: sotuv teskari yoziladi
  (`correction` qatori). Qisman topshirilgan summa yo'qolmaydi — keyingi
  hisob-kitobga o'tadi.

---

## 8. Ulanish tartibi (checklist)

**Elchi tomoni (operator):**

1. Naqd qabul qilinadigan filialda yangi kurier ochiladi (`POST /couriers`).
   Undagi tarif — kompaniyaning har bir buyurtma uchun oladigan haqi.
2. `POST /admin/carriers` `{ name, courier_id, ip_allowlist? }` — javobdagi
   `api_key` kompaniyaga xavfsiz kanal orqali beriladi.
3. Kurier paroli kompaniyaga **berilmaydi**.
4. Kompaniya bilan ishni to'xtatish: `POST /admin/carriers/:id/status`
   `{ is_active: false }`. Kurierni bloklash ham kalitni to'xtatadi (≤30 s
   ichida), lekin kurier **qayta faollashtirilsa eski kalit ham qayta
   ishlaydi** — kalit sizib chiqqan bo'lsa, albatta
   `POST /admin/carriers/:id/rotate-key` qiling yoki akkauntni o'chiring.
5. Qaytarilgan posilkalarni filial qaytarish pochtasi bo'yicha qabul qiladi.

**Sizning tomoningiz:**

1. `GET /carrier/ping` — kalit ishlayotganini tekshiring.
2. Sinov buyurtmasi akkauntingizga biriktirilgach: `scan` → `status: sold`
   → `GET /carrier/cashbox` da kirimni ko'ring.
3. Sizdagi statuslarni §5.2 dagi uchta qiymatga moslang.
4. Har bir holat yuborishda **yangi** `Idempotency-Key` (UUID) yarating;
   qayta urinishda ayni kalitni ishlating.
5. Bekor qilingan posilkalarni `POST /carrier/returns` bilan qaytaring.
6. Geo'ni SOATO kodi bo'yicha moslang (§4).
7. `trace_id` va `Idempotency-Key` ni loglaringizda saqlang.

---

## 9. Tez-tez uchraydigan xatolar

| Xabar | Sabab | Yechim |
|---|---|---|
| `Buyurtma topilmadi yoki sizga biriktirilmagan` (404) | Buyurtma boshqa kurierda yoki hali biriktirilmagan | Elchi operatoridan biriktirishni so'rang |
| Holat `waiting` emas (400) | Posilka skanerlanmagan | Avval `POST /carrier/scan` |
| `CARRIER_IDEMPOTENCY_KEY_REQUIRED` (400) | `Idempotency-Key` sarlavhasi yo'q | Har urinish uchun UUID yuboring |
| `CARRIER_IDEMPOTENCY_KEY_STALE` (409) | Eski urinish kaliti qayta ishlatildi | Yangi kalit bilan yuboring |
| `extraCost: bunday maydon qabul qilinmaydi` (400) | v1 da qo'shimcha xarajat yo'q | Maydonni olib tashlang |
| Almashtirish buyurtmasi (400) | `old_item_collected: true` yuborilmagan | `order.replacement` ga qarang |
| Isbot talab qilinadi (400) | Sotuvchi isbot so'raydi | `proof` faylini multipart bilan yuboring |
| `CARRIER_COURIER_INACTIVE` (403) | Bog'langan kurier bloklangan | Elchi operatoriga murojaat qiling |
| `Carrier akkaunt faol emas` (403) | Akkaunt o'chirilgan | Elchi operatoriga murojaat qiling |
| `CARRIER_KEY_CHECK_UNAVAILABLE` / `CARRIER_TEMPORARILY_UNAVAILABLE` (503) | Vaqtinchalik ichki xato | Biroz kutib ayni kalit bilan qayta urining |
