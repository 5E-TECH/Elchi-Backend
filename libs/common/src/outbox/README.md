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
4. Muvaffaqiyatli yetkazilsa → status='published'. Fail bo'lsa → exponential backoff.
5. 10 marta fail → status='failed' (poison, operator inspect qiladi).

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

-- Poison eventlar (operator tekshirsin)
SELECT * FROM outbox_events WHERE status = 'failed';
```
