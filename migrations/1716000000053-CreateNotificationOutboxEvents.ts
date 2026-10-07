import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `notification_schema.outbox_events` — notification-service push yetkazishni
 * transactional outbox orqali navbatga qo'yadi (`notification.push.deliver`).
 *
 * Har migratsiya bir marta `order_schema.migrations` da yoziladi va o'z
 * sxemasini qattiq ko'rsatadi (1716000000012 bilan bir xil naqsh): asl outbox
 * migratsiyasi (1713800000000) faqat ulanish sxemasida jadval yaratgan.
 *
 * Push dispatch javobini kutmasligi uchun navbatga qo'yiladi; enqueue inbox
 * qatorlari bilan BITTA tranzaksiyada — dispatch rollback bo'lsa push ketmaydi.
 */
export class CreateNotificationOutboxEvents1716000000053 implements MigrationInterface {
  name = 'CreateNotificationOutboxEvents1716000000053';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SCHEMA IF NOT EXISTS "notification_schema"`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."outbox_events" (
        "id" BIGSERIAL PRIMARY KEY,
        "target" VARCHAR(64) NOT NULL,
        "pattern" VARCHAR(128) NOT NULL,
        "payload" JSONB NOT NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "last_error" TEXT,
        "scheduled_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "published_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_NOTIFICATION_OUTBOX_DUE"
      ON "notification_schema"."outbox_events" ("status", "scheduled_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_NOTIFICATION_OUTBOX_TARGET"
      ON "notification_schema"."outbox_events" ("target")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."outbox_events" CASCADE`,
    );
  }
}
