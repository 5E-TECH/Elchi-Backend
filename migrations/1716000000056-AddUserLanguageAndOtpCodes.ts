import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * - `identity_schema.admins.language` — mijoz tili (nkhURiKX #1): SMS shablon
 *   shu tilda tanlanadi. Sukut 'uz', mavjud qatorlar buzilmaydi. Xodimlar tili
 *   baribir `settings->'appearance'->>'language'` da — SQL fallback shundan.
 * - `identity_schema.otp_codes` (rkz0yBxr #1) — OCHIQ KOD SAQLANMAYDI, faqat hash.
 */
export class AddUserLanguageAndOtpCodes1716000000056 implements MigrationInterface {
  name = 'AddUserLanguageAndOtpCodes1716000000056';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        ADD COLUMN IF NOT EXISTS "language" VARCHAR(2) NOT NULL DEFAULT 'uz'
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "identity_schema"."otp_codes" (
        "id" BIGSERIAL PRIMARY KEY,
        "phone" VARCHAR(16) NOT NULL,
        "code_hash" VARCHAR(128) NOT NULL,
        "purpose" VARCHAR(16) NOT NULL CHECK ("purpose" IN ('login', 'phone_verify')),
        "expires_at" TIMESTAMPTZ NOT NULL,
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "max_attempts" INTEGER NOT NULL DEFAULT 5,
        "consumed_at" TIMESTAMPTZ,
        "ip" VARCHAR(64),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_OTP_CODES_PHONE_PURPOSE_CREATED"
      ON "identity_schema"."otp_codes" ("phone", "purpose", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_OTP_CODES_EXPIRES"
      ON "identity_schema"."otp_codes" ("expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "identity_schema"."otp_codes" CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" DROP COLUMN IF EXISTS "language"`,
    );
  }
}
