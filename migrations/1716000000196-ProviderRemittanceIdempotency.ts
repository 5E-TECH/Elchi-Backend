import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * N3yNa6rO — kargo to'lovining idempotentligi:
 * `integration_schema.provider_remittances.idempotency_key`.
 *
 * Ayni `Idempotency-Key` bilan takror POST yangi to'lov ochib, MAIN kassaga
 * ikkinchi marta kirim yozardi: kassa `dedup_epoch` i remittance id'siga
 * bog'langan, id esa har safar yangi edi.
 *
 * Qisman UNIQUE: kalitsiz eski yozuvlar va kalitsiz so'rovlar cheklanmaydi.
 * Mavjud qatorlar NULL qoladi, pulga tegmaydi. `lock_timeout` 5 s (187 dagidek).
 *
 * down(): indeks va ustun o'chiriladi.
 */
export class ProviderRemittanceIdempotency1716000000196 implements MigrationInterface {
  name = 'ProviderRemittanceIdempotency1716000000196';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        previous_lock_timeout text := current_setting('lock_timeout');
      BEGIN
        IF to_regclass('integration_schema.provider_remittances') IS NULL THEN
          RETURN;
        END IF;
        PERFORM set_config('lock_timeout', '5s', true);
        ALTER TABLE "integration_schema"."provider_remittances"
          ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(255);
        CREATE UNIQUE INDEX IF NOT EXISTS "UQ_REMITTANCE_IDEMPOTENCY"
          ON "integration_schema"."provider_remittances" ("integration_id", "idempotency_key")
          WHERE "idempotency_key" IS NOT NULL;
        PERFORM set_config('lock_timeout', previous_lock_timeout, true);
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "integration_schema"."UQ_REMITTANCE_IDEMPOTENCY";
    `);
    await queryRunner.query(`
      ALTER TABLE "integration_schema"."provider_remittances"
        DROP COLUMN IF EXISTS "idempotency_key";
    `);
  }
}
