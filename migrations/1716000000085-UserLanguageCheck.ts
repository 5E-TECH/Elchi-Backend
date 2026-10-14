import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * (C4R3YyvH) `identity_schema.admins.language` — ustun 1716000000056 da
 * qo'shilgan (VARCHAR(2), NOT NULL, DEFAULT 'uz'), lekin CHECK yo'q edi:
 * endi faqat 'uz' | 'ru' | 'en'. Ruxsat etilmagan eski qiymat (bo'lsa) avval
 * 'uz' ga normallashtiriladi — aks holda constraint qo'yilmasdi.
 */
export class UserLanguageCheck1716000000085 implements MigrationInterface {
  name = 'UserLanguageCheck1716000000085';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        ADD COLUMN IF NOT EXISTS "language" VARCHAR(2) NOT NULL DEFAULT 'uz'
    `);
    await queryRunner.query(`
      UPDATE "identity_schema"."admins"
         SET "language" = 'uz'
       WHERE "language" IS NULL OR "language" NOT IN ('uz', 'ru', 'en')
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_ADMINS_LANGUAGE'
             AND conrelid = '"identity_schema"."admins"'::regclass
        ) THEN
          ALTER TABLE "identity_schema"."admins"
            ADD CONSTRAINT "CHK_ADMINS_LANGUAGE"
            CHECK ("language" IN ('uz', 'ru', 'en'));
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        DROP CONSTRAINT IF EXISTS "CHK_ADMINS_LANGUAGE"
    `);
  }
}
