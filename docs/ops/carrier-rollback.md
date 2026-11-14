# Carrier API — yashirin «rollback» toggle'i (ICHKI)

> ⚠️ **Faqat Elchi jamoasi uchun.** Bu fayl kompaniyaga (tashqi
> yetkazuvchiga) berilmaydi va `docs/public/` ga ko'chirilmaydi —
> `carrier-public-docs.no-rollback.spec.ts` buni tekshiradi.
>
> Egasining qarori (2026-11-14): kompaniya bilan endi ishlay boshladik.
> Ishonch paydo bo'lguncha rollback **o'chiq**, keyin kerak bo'lsa admin
> akkaunt bo'yicha **bitta toggle** bilan yoqadi. Hozircha kompaniyaga
> rollback haqida aytilmaydi: Swagger, ommaviy hujjat va PDF'da u yo'q.

## 1. Nima bu

- **Rollback** — kompaniya `POST /carrier/orders/{id}/status`
  `{ "status": "rollback" }` bilan o'zi yuborgan natijani bekor qiladi:
  `sold` / `cancelled` → `waiting` (`order.rollback_waiting`, kassada
  `correction` qatori). Shart: holat aynan `sold` yoki `cancelled` va shu
  buyurtmaning hisob-kitobi yopilmagan; `paid` / `partly_paid` — 400
  (tuzatishni Elchi operatori qiladi).
- **Toggle** — `integration_schema.carrier_accounts.rollback_enabled`
  (`BOOLEAN NOT NULL DEFAULT false`, migratsiya `1716000000223`). Har
  akkaunt (kompaniya) uchun alohida.
- **Sukut — o'chiq**: yangi akkaunt ham, migratsiyadan oldin ochilgan barcha
  akkauntlar ham.
- Elchi operatorining ichki paneldagi rollback'i (`/orders/...`) bunga
  **bog'liq emas** — toggle faqat Carrier API'ga tegishli.

## 2. O'chiq bo'lganda kompaniya nimani ko'radi

- `status: "rollback"` → **400**, istalgan noma'lum qiymat (`"sould"`)
  bilan **aynan bir xil** javob (faqat `trace_id` boshqa):

  ```json
  { "statusCode": 400, "message": "status: quyidagilardan biri bo'lishi kerak: sold, partly_sold, cancelled", "trace_id": "…" }
  ```

  Maxsus `code` yo'q. Boshqa maydon xatolari bilan birga yuborilsa ham
  javob noma'lum qiymatnikidek (masalan `extraCost` + `status` xatosi).
- Rad etish **har qanday amaldan oldin**: buyurtma o'qilmaydi,
  `Idempotency-Key` order-service'ga yetmaydi (saqlanmaydi), RMQ amali,
  kassa yozuvi, fayl yuklash yo'q.
- Toggle yoqiq bo'lsa ham **har qanday** status xato xabari faqat
  `sold, partly_sold, cancelled` ni sanaydi — rollback hech qachon oshkor
  qilinmaydi.

Kod: `apps/api-gateway/src/carrier-status-body.ts` (tana akkaunt ruxsatiga
qarab `CarrierOrderStatusRequestDto` yoki
`CarrierOrderStatusWithRollbackRequestDto` bilan tekshiriladi) +
kontrollerdagi himoya tekshiruvi. Testlar: `carrier-rollback-toggle.spec.ts`
(HTTP), `carrier-gateway.controller.spec.ts`,
`carrier-account.service.spec.ts`.

## 3. Qanday yoqiladi / o'chiriladi

- **Admin panel** (SUPERADMIN, ADMIN): Carrier akkaunt → «Rollback» toggle.
- **API**: `PATCH /admin/carriers/:id` `{ "rollback_enabled": true }`
  (yoki `false`). Yolg'iz yoki `name` / `ip_allowlist` bilan birga.
  Javob — akkaunt ko'rinishi (`rollback_enabled` bilan). `GET
  /admin/carriers`, `POST /admin/carriers/:id/rotate-key`,
  `POST /admin/carriers/:id/status` javoblarida ham `rollback_enabled` bor.
- Yaratishda (`POST /admin/carriers`) maydon **qabul qilinmaydi** (400
  «rollback_enabled: bunday maydon qabul qilinmaydi») — yangi akkaunt doim
  `false`.
- **Audit**: activity-log, `entity_type = CarrierAccount`,
  `action = updated`, `old_value: { rollback_enabled: false }` →
  `new_value: { rollback_enabled: true }`, kim (`user_id`, `user_role`).
  integration-service logida: `carrier <id>: rollback YOQILDI` /
  `O'CHIRILDI`.
- **Kuchga kirish — darhol, keyingi so'rovdan.** Gateway ham,
  integration-service ham akkaunt qatorini keshlamaydi: `validate_key` har
  `/carrier/*` so'rovida bazadan o'qiydi (30 s kesh faqat bog'langan kurier
  faolligi uchun). Faqat o'sha paytda bajarilayotgan so'rov eski qiymat
  bilan tugaydi.
- SQL (favqulodda, panel ishlamasa): `UPDATE integration_schema.carrier_accounts
  SET rollback_enabled = false, "updatedAt" = NOW() WHERE id = <id>;` —
  audit yozilmaydi, imkon qadar API'dan foydalaning.

## 4. Ochish (un-hide) ro'yxati — kompaniyaga rollback'ni e'lon qilish

Hujjat **barcha kompaniyalar uchun umumiy**. Bitta kompaniyaga yoqib, unga
alohida (xat/chat) aytish mumkin — ommaviy hujjat yashirin qoladi. Hammaga
ochishga qaror qilinsa (yoki hujjatda ko'rsatish kerak bo'lsa):

1. **Kompaniyaga xabar** (qaysi akkaunt, qachondan): faqat `sold` /
   `cancelled` holatdagi buyurtma, hisob-kitob yopilmagan bo'lsa;
   `paid`/`partly_paid` — Elchi operatori; rollback'dan keyingi qayta
   `sold`/`cancelled` — **yangi** `Idempotency-Key` (eskisi → 409
   `CARRIER_IDEMPOTENCY_KEY_STALE`); `proof` yuborilmaydi.
2. **Toggle** — kerakli akkauntlarda `rollback_enabled: true` (ochish
   toggle'ni bekor qilmaydi: validator rollback'ni baribir faqat ruxsatli
   akkauntga o'tkazadi).
3. **Swagger / kod** (`apps/api-gateway/src/`):
   - `dto/carrier.swagger.dto.ts` — `CARRIER_PUBLIC_ORDER_STATUSES` ga
     `CarrierOrderStatus.ROLLBACK` (Swagger enum'i va status xato xabari),
     `CarrierOrderStatusRequestDto.status` tavsifi,
     `CARRIER_STATUS_REQUEST_EXAMPLES` ga `rollback` misoli
     (`{ status: 'rollback' }`), `CarrierCashboxEntryDto.source_type`
     tavsifi (`correction`).
   - `carrier-gateway.controller.ts` — `updateStatus` `@ApiOperation`
     summary (`…, bekor (cancelled), rollback`) va description (rollback
     jumlasi).
   - `carrier-swagger.ts` — `CARRIER_SWAGGER_GUIDE` (ish tartibi, statuslar
     jadvali, Idempotency-Key qoidasi) **va** aynan shu matn
     `docs/public/CARRIER_API_QUICKSTART.md` da.
4. **Ommaviy hujjatlar** (`docs/public/`):
   - `CARRIER_API.md` — §1 oqim va «statuslar soni», §5.2 maydon va
     statuslar jadvali, «Idempotentlik», §5.4 `source_type`, §7 «Pul», §8
     checklist («uchta» → «to'rtta»).
   - `carrier-guide.html` va undan `Carrier-API-qollanma.pdf`.
   - `npm run openapi:generate` → `carrier-openapi.json` (va
     `docs/frontend/openapi.json`).
   - Avvalgi (rollback bor) matn manbai: `git show 04ac6229:<fayl>`.
5. **Spec'lar**: `carrier-public-docs.no-rollback.spec.ts` (qo'riq — olib
   tashlang yoki ochilgan joylarga ruxsat bering), `carrier-status-examples.spec.ts`
   (`EXPECTED_SUMMARY`, `EXPECTED_EXAMPLES`), `carrier-api-docs-contract.spec.ts`
   (statuslar jadvali), `carrier-rollback-toggle.spec.ts` (xabar matni).
6. Ushbu fayl va `docs/BACKEND_MAP.md` (Carrier API bo'limi) — holatni
   yangilang.
