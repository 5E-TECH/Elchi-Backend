import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `admins.can_sell_cancel` (#4) + `admins.created_by` (#3).
 *
 * can_sell_cancel — HYBRID filial menejerining SOTISH/BEKOR tugmalari uchun
 * per-manager ruxsat. Default FALSE: migratsiyadan keyin BARCHA mavjud
 * menejerlar sotish/bekordan vaqtincha mahrum bo'ladi — bu ATAYLAB (egasi
 * qarori): superadmin har bir menejer uchun qo'lda yoqadi. Backfill YO'Q.
 *
 * created_by — foydalanuvchini kim yaratgani. Manager FAQAT o'zi yaratgan
 * foydalanuvchilarni tahrirlaydi. Mavjud qatorlar uchun NULL qoladi (noma'lum
 * yaratuvchi) — bunday yozuvni hech bir manager tahrirlay olmaydi, faqat
 * admin/superadmin. Backfill qilib bo'lmaydi (yaratuvchi tarixi yo'q).
 */
export class AddManagerCapabilitiesAndCreatedBy1716000000051
  implements MigrationInterface
{
  name = 'AddManagerCapabilitiesAndCreatedBy1716000000051';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        ADD COLUMN IF NOT EXISTS "can_sell_cancel" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        ADD COLUMN IF NOT EXISTS "created_by" bigint NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        DROP COLUMN IF EXISTS "created_by"
    `);
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        DROP COLUMN IF EXISTS "can_sell_cancel"
    `);
  }
}
