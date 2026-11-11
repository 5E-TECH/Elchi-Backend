# Elchi Pochta — Carrier API: tezkor qo'llanma

Elchi Pochta posilkalarini yetkazadigan tashqi kompaniya uchun API. Elchi'da siz **bitta kurier akkaunti** sifatida ishlaysiz: Elchi xodimi buyurtmani sizga biriktiradi, siz posilka QR'ini skanerlaysiz va yetkazish natijasini yuborasiz. Pul sizning kurier kassangizga yoziladi.

## 1. Kirish

Har so'rovda `X-Api-Key` sarlavhasi (kalit `elc_` bilan boshlanadi, uni Elchi operatori beradi). Kalit faqat bir marta ko'rsatiladi — xavfsiz saqlang.

**Muhitlar.** Avval test muhitida sinang. Test va production — alohida tizimlar: kalit ham, buyurtmalar ham alohida (test kaliti production'da ishlamaydi va aksincha).

| Muhit | `BASE_URL` | Interaktiv hujjat (Swagger) |
|---|---|---|
| Test | `https://test-api.elchipochta.uz` | `https://test-api.elchipochta.uz/carrier-docs` |
| Production | `https://api.elchipochta.uz` | `https://api.elchipochta.uz/carrier-docs` |

Swagger sahifasining login va parolini Elchi beradi. U yerda **Authorize** tugmasiga kalitni kiritib, so'rovlarni ("Try it out") to'g'ridan-to'g'ri sinash mumkin — so'rov sahifa ochilgan muhitga yuboriladi. Quyidagi misollarda `BASE_URL` — tanlangan muhit manzili:

```bash
BASE_URL=https://test-api.elchipochta.uz
curl "$BASE_URL/carrier/ping" -H "X-Api-Key: elc_..."
```

## 2. Ish oqimi

**1) Skanerlash** — posilkani qo'lingizga olganda:

```bash
curl -X POST "$BASE_URL/carrier/scan" \
  -H "X-Api-Key: elc_..." -H "Content-Type: application/json" \
  -d '{"qr_token":"a1b2c3d4e5"}'
```

Javobda buyurtma (`data.order`): mijoz, manzil, tovarlar va **`cod_amount` — mijozdan olinadigan naqd**. Viloyat va tuman nomi emas, **SOATO kodi** bilan keladi: `region.soato_code` (4 xona), `district.soato_code` (7 xona; kod noma'lum bo'lsa `null`). Yo'ldagi (yoki mijozni kutishdagi) posilka shu skanda sizga qabul qilinadi (`status: waiting`). Sotish va bekor qilish faqat shundan keyin mumkin. `replacement.old_item_required: true` — almashtirish: eski mahsulotni oling va sotishda `old_item_collected: true` yuboring.

**2) Natijani yuborish** — `data.order.id` bilan. **`Idempotency-Key` majburiy** — har yangi urinish uchun yangi UUID:

```bash
curl -X POST "$BASE_URL/carrier/orders/900/status" \
  -H "X-Api-Key: elc_..." -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"status":"sold"}'
```

| status | Qachon | Qo'shimcha maydonlar |
|---|---|---|
| `sold` | To'liq sotildi | — |
| `partly_sold` | Qisman sotildi | `total_price` (mijoz olgan tovarlar qiymati, onlayn to'langan qism ham ichida), `items: [{order_item_id, quantity}]` — buyurtmaning har bir qatori |
| `cancelled` | Mijoz olmadi | `reason`: `CUSTOMER_NO_ANSWER`, `CUSTOMER_REFUSED`, `WRONG_ADDRESS`, `DEFECTIVE_PRODUCT`, `PRICE_DISPUTE`, `OTHER` (+ `comment`) |
| `rollback` | Xato yuborilgan sold/cancelled ni qaytarish | — (holat aynan sold yoki cancelled va hisob-kitob yopilmagan bo'lsa) |

**3) Bekor qilinganlarni qaytarish** — `cancelled` posilkalar (qisman sotuvning sotilmagan qismi ham) sizda qoladi: `POST /carrier/returns` `{"order_ids":["901"]}` → qaytarish pochtasi (`post_id`); posilkalarni Elchi filialiga topshirasiz. Qaytarilgan posilka `/carrier/orders` ro'yxatidan chiqadi.

**4) Solishtirish** — `GET /carrier/orders` (sizdagi buyurtmalar) va `GET /carrier/cashbox` (balans va oxirgi 30 kunlik harakatlar).

## 3. Muhim qoidalar

- Faqat **sizga biriktirilgan** buyurtmalar ko'rinadi; boshqasiga `404`.
- `Idempotency-Key`: har **yangi** urinish — yangi kalit; javob kelmasa — **ayni kalit** bilan qayta yuboring (amal ikki marta bajarilmaydi). Rollback'dan keyingi qayta sotuv — yangi kalit (eskisi bilan `409 CARRIER_IDEMPOTENCY_KEY_STALE`).
- Limit: akkaunt uchun daqiqada 120 so'rov, barcha endpoint birgalikda, va har endpoint uchun bitta IP'dan 120 (`429`). Ro'yxatni bittalab emas, sahifalab oling.
- Xato javobi: `{ statusCode, message, code?, trace_id }`. Qarorni matnga emas, `statusCode`/`code` ga qarab qiling. `trace_id` ni saqlang — muammo bo'lsa Elchi'ga yuboring.
- `409`, `429`, `5xx`, `503`, `504` — biroz kutib, **ayni** `Idempotency-Key` bilan qayta urining (`CARRIER_IDEMPOTENCY_KEY_STALE` — yangi kalit; 10 daqiqadan uzoq takrorlansa — Elchi'ga). Boshqa `4xx` — so'rovni tuzating.
- `refreshed: false` — holat qabul qilindi, buyurtmani keyinroq o'qing (qayta yubormang).

## 4. Pul

Sotuvda kassangizga **(mijozdan olingan naqd − yetkazish haqingiz)** yoziladi — bu Elchi'ga topshiriladigan summa. Naqdni topshirganingizda Elchi xodimi qabul qiladi va kassada chiqim paydo bo'ladi (eng eski sotuvlardan boshlab yopiladi). Bekor qilishda pul harakati yo'q. Kassa yozuvi holat yuborilgandan keyin **bir necha soniyada** paydo bo'ladi. Yo'nalish — `type` (income/expense), `amount` doim musbat.
