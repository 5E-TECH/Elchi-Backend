# Transactional Outbox

`outbox_events` jadval orqali RMQ xabarlarni xizmat tranzaksiyasi bilan
**atomik** yozish.

## Muammo

`order.save()` keyin `rmqSend('finance.cashbox.update_balance')`:
- 1-chi muvaffaqiyatli, 2-chi timeout → order qoldi, kassada balans noto'g'ri.
- Saga compensation murakkab. Outbox shuni hal qiladi.

## Yechim mexanizmi

1. Tranzaksiya ichida ikki insert: `orders` + `outbox_events` (status=pending).
2. Tranzaksiya commit bo'lsa, ikkalasi yoziladi. Rollback bo'lsa, ikkalasi yo'qoladi.
3. Background `OutboxPublisher` har 1 sekundda pending event'larni o'qib RMQ'ga uzatadi.
4. Muvaffaqiyatli yetkazilsa → status='published'. Fail bo'lsa → exponential backoff
   (1, 2, 4 … s, yuqori chegara 60 s).
5. Oddiy hodisa 10 marta fail → status='failed' (poison, operator inspect qiladi).
6. **PUL hodisalari hech qachon `failed` bo'lmaydi** (audit M8): `finance.*`
   (sotuv oyoqlari, moliyaviy balans, operator daromadi) va
   `order.settlement.advance` 60 s lik chegarada CHEKSIZ qayta uriniladi —
   maqsad servis 5 daqiqadan ko'p ishlamasa ham daftar kassaga yetib oladi.
   Ro'yxat: `DEFAULT_PERSISTENT_OUTBOX_PATTERNS` (`tokens.ts`), modulda
   `OutboxModule.forService({ targets, options: { persistentPatterns } })`
   bilan almashtiriladi (`[]` — eski xatti-harakat).
7. Kamida 10 marta yiqilib hamon `pending` turgan hodisa "STUCK" deb har
   daqiqada error log'ga, soni o'zgarganda Sentry'ga chiqadi
   (`stuckAlertAttempts`).

## Ulash

1. **Module'ga qo'shish:**
   ```typescript
   import { OutboxModule, RmqModule } from '@app/common';

   @Module({
     imports: [
       RmqModule.register({ name: 'FINANCE' }),  // shu yerda registered bo'lishi kerak
       RmqModule.register({ name: 'CATALOG' }),
       OutboxModule.forService({ targets: ['FINANCE', 'CATALOG'] }),
     ],
   })
   ```

2. **Migration:**
   ```bash
   DB_SCHEMA=order_schema npm run migration:run
   ```

3. **Kodda ishlatish (transactional):**
   ```typescript
   constructor(
     private readonly outbox: OutboxService,
     private readonly dataSource: DataSource,
   ) {}

   async sellOrder(...) {
     const queryRunner = this.dataSource.createQueryRunner();
     await queryRunner.connect();
     await queryRunner.startTransaction();
     try {
       const order = await queryRunner.manager.save(Order, orderData);

       await this.outbox.enqueue('FINANCE', 'finance.cashbox.update_balance', {
         user_id: order.market_id,
         amount: marketTariff,
         // ...
       }, { manager: queryRunner.manager });  // ← MUHIM: manager pass qilinadi

       await queryRunner.commitTransaction();
     } catch (e) {
       await queryRunner.rollbackTransaction();
       throw e;
     } finally {
       await queryRunner.release();
     }
   }
   ```

4. **Non-transactional (oddiy):**
   ```typescript
   await this.outbox.enqueue('FINANCE', 'finance.cashbox.update_balance', payload);
   ```
   Bu hali ham foydali — RMQ broker down bo'lsa retry qiladi (DB ishlasa).
   Ammo full safety uchun manager bilan ishlatish kerak.

## Cleanup

`OutboxService.pruneOldPublished(7 * 24 * 60 * 60 * 1000)` — 7 kundan eski published yozuvlarni o'chiradi.
Cron ishga tushirish uchun har serviceda alohida qo'shing (yoki @nestjs/schedule).

## Diagnostika

```sql
-- Kelmayotgan eventlar
SELECT * FROM outbox_events WHERE status = 'pending' AND attempts > 3;

-- Qotib qolgan PUL eventlari (cheksiz qayta urinilmoqda — maqsad servisni tekshiring)
SELECT id, target, pattern, attempts, last_error, scheduled_at
FROM outbox_events WHERE status = 'pending' AND attempts >= 10 ORDER BY id;

-- Poison eventlar (operator tekshirsin)
SELECT * FROM outbox_events WHERE status = 'failed';
```

## Qayta o'ynash (replay)

`failed` hodisa o'z-o'zidan qayta yuborilmaydi. Sababi bartaraf etilgach
(maqsad servis tiklandi, ma'lumot tuzatildi) — tekshirib, qayta navbatga
qo'ying. Kod orqali: `OutboxService.requeueFailed({ ids?, patterns? })`.
SQL orqali (har servis o'z sxemasida, masalan `order_schema` /
`finance_schema`):

```sql
-- 1) Avval ko'ring: nima va nega yiqilgan
SELECT id, target, pattern, attempts, last_error, payload
FROM outbox_events WHERE status = 'failed' ORDER BY id;

-- 2) Tanlanganlarni qayta navbatga qo'ying (publisher ~1 s ichida oladi)
UPDATE outbox_events
SET status = 'pending', attempts = 0, scheduled_at = NOW()
WHERE status = 'failed' AND id IN (/* tekshirilgan id'lar */);
```

⚠️ Hodisa qo'lda (SQL bilan) allaqachon qo'llangan bo'lsa uni qayta
o'ynamang. Qabul qiluvchilar takroriy yetkazishga chidamli
(`finance.cashbox.update_balance` dedup kaliti, `order.settlement.advance`
`request_id` + "applied" belgisi), lekin qo'lda kiritilgan tuzatishni ular
bilmaydi.

`order.settlement.advance` uchun ilgari yiqilgan idempotency kaliti endi
o'z-o'zidan qayta egallanadi (`reclaimFailed`) — alohida tozalash kerak emas.

## Bildirishnoma (`notification.dispatch`) ulash — yo'riqnoma (OA16fdSq)

Pilot: order-service (`apps/order-service/src/notification/order-notification.service.ts`).
Keyingi servislar (finance, branch, logistics) AYNAN shu naqsh bilan:

1. Modulda: `RmqModule.register({ name: 'NOTIFICATION' })` va
   `OutboxModule.forService({ targets: [..., 'NOTIFICATION'], options: { fireAndForgetPatterns: ['notification.dispatch'] } })`.
   `fireAndForgetPatterns` — publisher bildirishnoma javobini KUTMAYDI
   (dispatch Telegram'ni ham kutadi; notification-service yiqilsa ortidagi
   pul hodisalari kechikmasin). Pul/holat patternlarini bu ro'yxatga qo'shmang.
2. Hodisa nuqtasida, biznes tranzaksiyasi ICHIDA:
   `await this.outbox.enqueue('NOTIFICATION', 'notification.dispatch', payload, { manager })`.
   To'g'ridan-to'g'ri `rmqSend` / `client.send` TAQIQ (rollback bo'lsa ham
   xabar ketardi; sinxron chaqiruv tugmani bildirishnomani kutishga majburlaydi).
3. `payload.type` — `NOTIFICATION_TYPES` katalogidan (`libs/common/src/notification/notification-types.ts`);
   yangi tur = katalogga yozuv (migratsiya kerak emas), kategoriya faqat mavjud 7 ta
   (`integration`/`ai` → `system`). Katalogda yo'q tur notification-service'da 400.
4. `category`/`priority`/`group_key`/`channels` ni katalogdan oling
   (`findNotificationType`, `renderNotificationGroupKey`) — notification-service
   ham bermasangiz shu yerdan to'ldiradi.
5. PII: in_app `body` — faqat raqam + holat. Telefon/manzil faqat
   `telegram.text` da (market guruhi), har foydalanuvchi qismi
   `escapeTelegramHtml` dan o'tsin (`parse_mode: HTML`).
6. Fail-open: payload qurishdagi xato biznes amalini yiqitmasin (try/catch + WARN).

Kutilayotgan turlar: `finance.payment_received` (to'lov / balans to'ldirish,
market), `finance.settlement_closed`, `branch.transfer_sent|received`
(`batch_id`), `logistics.assigned` (kuryer, `order_id`),
`logistics.return_approved`.
