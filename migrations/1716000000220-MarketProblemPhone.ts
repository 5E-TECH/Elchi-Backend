import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Market sozlamasi (`identity_schema.admins`, market qatorlari) — chekdagi
 * «Muammo bo'lsa» uchun «Qo'shimcha raqam» (Dilshod 2026-11-12):
 *
 *  - `problem_phone_enabled` FALSE (sukut, hamma market — mavjudlari ham):
 *    avvalgi xulq — «Muammo bo'lsa»da viloyat logisti yoki umumiy raqam
 *    (`problem_contacts`, T7).
 *  - TRUE — shu marketning HAMMA buyurtmasi chekida «Muammo bo'lsa» o'rniga
 *    `problem_phone` (`+998XXXXXXXXX`) chiqadi. Yoqishda raqam majburiy.
 *
 * Postgres 11+ da `DEFAULT false` faqat katalog o'zgarishi, backfill UPDATE
 * yo'q. `IF NOT EXISTS` — qayta yurgizish xatosiz.
 */
export class MarketProblemPhone1716000000220 implements MigrationInterface {
  name = 'MarketProblemPhone1716000000220';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        ADD COLUMN IF NOT EXISTS "problem_phone_enabled" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "problem_phone" VARCHAR(20) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        DROP COLUMN IF EXISTS "problem_phone",
        DROP COLUMN IF EXISTS "problem_phone_enabled"
    `);
  }
}
