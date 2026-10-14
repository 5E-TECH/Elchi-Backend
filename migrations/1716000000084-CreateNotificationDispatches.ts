import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (7Vozou5x) Yuborilgan xabarlar tarixi — `/notifications/sent` MANBASI.
 *
 * • `notification_schema.notification_dispatches` — BITTA qo'lda dispatch =
 *   BITTA qator (qabul qiluvchi boshiga emas): sarlavha, matn, kim yubordi,
 *   qabul qiluvchilar soni, kanal kesimidagi natija. Tarix activity_logs ga
 *   TAYANMAYDI (u audit; bitta dispatch = bitta audit qatori qoidasi o'zgarmaydi).
 * • `dispatch_id` UNIQUE — `client_request_id` bilan qayta yuborish (504 dan
 *   keyin) IKKINCHI marta yubormaydi, o'sha natijani qaytaradi.
 * • `notifications.dispatch_id` — har inbox qatori o'z partiyasiga bog'lanadi
 *   ("Yetkazilmaganlar" ro'yxati shu bo'yicha). Eski qatorlarda NULL.
 * • soft-delete ustuni `is_deleted`; vaqt ustunlari BaseEntity bilan bir xil.
 */
export class CreateNotificationDispatches1716000000084 implements MigrationInterface {
  name = 'CreateNotificationDispatches1716000000084';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SCHEMA IF NOT EXISTS "notification_schema"`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification_schema"."notification_dispatches" (
        "id" BIGSERIAL PRIMARY KEY,
        "dispatch_id" VARCHAR(100) NOT NULL,
        "status" VARCHAR(16) NOT NULL DEFAULT 'running'
          CHECK ("status" IN ('running', 'sent', 'partial', 'inbox_only', 'skipped', 'failed')),
        "created_by" BIGINT,
        "created_by_role" VARCHAR(100),
        "type" VARCHAR(120) NOT NULL,
        "category" VARCHAR(32),
        "priority" VARCHAR(16),
        "title" VARCHAR(255) NOT NULL,
        "body" TEXT,
        "link" VARCHAR(512),
        "channels" JSONB NOT NULL DEFAULT '[]'::jsonb,
        "audience" JSONB,
        "recipients" INTEGER NOT NULL DEFAULT 0,
        "dispatched" INTEGER NOT NULL DEFAULT 0,
        "skipped_by_preference" INTEGER NOT NULL DEFAULT 0,
        "by_channel" JSONB,
        "channel_status" JSONB,
        "no_provider" JSONB,
        "message" VARCHAR(255),
        "error" TEXT,
        "finished_at" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_NOTIF_DISPATCH_ID"
      ON "notification_schema"."notification_dispatches" ("dispatch_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_NOTIF_DISPATCH_CREATED"
      ON "notification_schema"."notification_dispatches" ("createdAt")
    `);
    await queryRunner.query(`
      ALTER TABLE "notification_schema"."notifications"
        ADD COLUMN IF NOT EXISTS "dispatch_id" VARCHAR(100)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_NOTIF_DISPATCH"
      ON "notification_schema"."notifications" ("dispatch_id")
      WHERE "dispatch_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "notification_schema"."IDX_NOTIF_DISPATCH"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_schema"."notifications" DROP COLUMN IF EXISTS "dispatch_id"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_schema"."notification_dispatches" CASCADE`,
    );
  }
}
