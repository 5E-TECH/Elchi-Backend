# Idempotency

`request_id` orqali RMQ xabarlar dublikatsiyasini oldini olish.

## Qachon kerak

- State o'zgartiruvchi operatsiyalar (create, update, delete, transfer, payment).
- RMQ at-least-once delivery + retry → bir xabar 2 marta consume bo'lishi mumkin.
- Mobile app yoki frontend timeout'da xuddi shu request'ni qaytadan yuborishi mumkin.

Read-only operatsiyalar (find_by_id, find_all) uchun idempotency kerak emas.

## Yangi servisga ulash

1. **Module'ga qo'shish:**
   ```typescript
   import { IdempotencyModule } from '@app/common';

   @Module({
     imports: [
       // ...
       IdempotencyModule.forService(),
     ],
   })
   ```

2. **Migration ishlatish** (har schema uchun bir marta):
   ```bash
   DB_SCHEMA=<service_schema> npm run migration:run
   ```
   `1713700000000-CreateIdempotencyKeysTable.ts` joriy schema'da `idempotency_keys` jadvalini yaratadi.

3. **Controller'ga `IdempotencyService` inject qilish va `executeIdempotent` ishlatish:**
   ```typescript
   @MessagePattern({ cmd: 'order.create' })
   create(@Payload() data: { dto: CreateOrderDto; request_id?: string }, @Ctx() ctx) {
     return executeIdempotent(
       this.rmqService,
       this.idempotencyService,
       ctx,
       { requestId: data.request_id, pattern: 'order.create' },
       () => this.orderService.create(data.dto),
     );
   }
   ```

## Gateway tarafi

`rmqSend` helperi `request_id` ni avtomatik kiritadi (UUIDv4). Caller o'zi bersa,
saqlanadi (mobile app idempotent retry uchun).

Read endpoint'lar uchun: `rmqSend(client, pattern, data, { attachRequestId: false })`.

## Ishlash mexanizmi

- Kalit: `${pattern}:${request_id}`
- Birinchi marta: `INSERT ... status='in_progress'` → handler ishlaydi → status='completed', javob keshlanadi
- Dublikat: `UNIQUE` violation → kesh ko'rilib, javob qaytariladi (handler qayta ishlamaydi)
- In-progress: xabar requeue qilinadi (qayta urinib ko'radi)
- Cleanup: `IdempotencyService.prune(olderThanMs)` — eski yozuvlarni o'chiradi (cron yoki manual)
