import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (rzGKtE9N TC5) `notification.dispatch` dedup kaliti: outbox / RMQ bir
 * hodisani QAYTA yetkazsa (ayni `request_id` / `client_request_id`) ikkinchi
 * inbox yangilanishi va ikkinchi Telegram xabari bo'lmaydi. Kalit
 * `<type>:<dispatch_id>`, dispatch tranzaksiyasining ICHIDA yoziladi (rollback
 * bo'lsa kalit ham qaytadi — qayta urinish yo'qolmaydi). 7 kundan eskilari
 * soatlik tozalashda o'chiriladi. Faqat sxema; qayta ishga tushirish xavfsiz.
 */
export class NotificationDispatchKeys1716000000124 implements MigrationInterface {
  name = 'NotificationDispatchKeys1716000000124';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."notification_dispatch_keys" (
        "key" varchar(220) PRIMARY KEY,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_NOTIFICATION_DISPATCH_KEYS_CREATED"
      ON "notification_schema"."notification_dispatch_keys" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."notification_dispatch_keys"`,
    );
  }
}
