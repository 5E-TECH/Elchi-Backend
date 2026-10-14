import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DxdZFdIk — kargo to'lovini (remittance) BEKOR QILISH (o'chirish emas).
 *
 * Yozuv o'zgarmas qoladi: `status = 'cancelled'` + kim/qachon/nima uchun.
 * Bekor qilinganda yopilgan qarz qatorlari PENDING ga qaytadi va MAIN kassadan
 * teskari chiqim yoziladi (integration-service `cancelRemittance`).
 *
 *   `status`          — 'active' | 'cancelled' (mavjud qatorlar: 'active');
 *   `cancelled_at`, `cancelled_by`, `cancel_reason` — bekor qilish izi;
 *   `cashbox_posted`  — to'lov MAIN kassaga kirim bo'lib yozilganmi (true /
 *                       false). NULL — migratsiyadan oldingi yozuv, noma'lum:
 *                       bunday yozuvni bekor qilishda kassani teskari
 *                       yozish-yozmaslik operatordan ANIQ so'raladi.
 */
export class ProviderRemittanceCancel1716000000081 implements MigrationInterface {
  name = 'ProviderRemittanceCancel1716000000081';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."provider_remittances"
        ADD COLUMN IF NOT EXISTS "status" VARCHAR(16) NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "cancelled_by" BIGINT NULL,
        ADD COLUMN IF NOT EXISTS "cancel_reason" TEXT NULL,
        ADD COLUMN IF NOT EXISTS "cashbox_posted" BOOLEAN NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_REMITTANCE_INTEGRATION_CREATED"
        ON "integration_schema"."provider_remittances" ("integration_id", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "integration_schema"."IDX_REMITTANCE_INTEGRATION_CREATED"`,
    );
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."provider_remittances"
        DROP COLUMN IF EXISTS "cashbox_posted",
        DROP COLUMN IF EXISTS "cancel_reason",
        DROP COLUMN IF EXISTS "cancelled_by",
        DROP COLUMN IF EXISTS "cancelled_at",
        DROP COLUMN IF EXISTS "status"
    `);
  }
}
