import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (1tnpaIqd, ega qarori 2026-09-20 / DuST9k8j) order_extra_cost_approvals:
 *  - `auto_approved` — market muddat ichida javob bermagani uchun AVTOMATIK
 *    tasdiqlangan (qo'lda tasdiqdan ajratiladi; `decided_by_user_id` NULL);
 *  - `reminder_sent_at` — avtomatik tasdiqdan oldingi oxirgi eslatma
 *    (bir marta);
 *  - `reject_reason` — rad etish sababi (yopiq ro'yxat, ExtraCostRejectReason).
 * `IDX_EXTRA_COST_PENDING_CREATED` — avtomatik tasdiq skaneri.
 * Faqat sxema; qayta ishga tushirish xavfsiz.
 */
export class ExtraCostAutoApprove1716000000123 implements MigrationInterface {
  name = 'ExtraCostAutoApprove1716000000123';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_extra_cost_approvals"
      ADD COLUMN IF NOT EXISTS "auto_approved" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_extra_cost_approvals"
      ADD COLUMN IF NOT EXISTS "reminder_sent_at" timestamptz NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "order_schema"."order_extra_cost_approvals"
      ADD COLUMN IF NOT EXISTS "reject_reason" varchar(40) NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_EXTRA_COST_PENDING_CREATED"
      ON "order_schema"."order_extra_cost_approvals" ("status", "createdAt")
      WHERE "is_deleted" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."IDX_EXTRA_COST_PENDING_CREATED"`,
    );
    for (const column of ['reject_reason', 'reminder_sent_at', 'auto_approved']) {
      await queryRunner.query(`
        ALTER TABLE "order_schema"."order_extra_cost_approvals"
        DROP COLUMN IF EXISTS "${column}"
      `);
    }
  }
}
