import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D1 (ega qarori, 2026-11-14): rasmiy SOATO'dagi yetishmagan 25 tuman/shahar
 * prod'ga qo'shiladi va filialga AVTOMATIK biriktiriladi; har avtomatik
 * biriktirilgan qator «tekshirilmagan» — ops tasdiqlaguncha yoki
 * biriktirishni o'zgartirguncha «Hududlar» sahifasida ogohlantirish.
 *
 * - `assignment_review_required` — belgi (sukut `false`, mavjud qatorlar
 *   o'zgarmaydi).
 * - `assignment_review_reason` — `auto_assigned_D1` | `no_branch_found`;
 *   belgi tushganda ham SAQLANADI (tarix uchun).
 * - `assignment_flagged_at` — belgi qo'yilgan vaqt.
 * - `assignment_confirmed_by` / `assignment_confirmed_at` — kim/qachon
 *   tasdiqladi (yoki qayta biriktirdi).
 *
 * XAVFSIZLIK: pulga tegmaydi, faqat metama'lumot. `IF NOT EXISTS` — qayta
 * yurgizish xatosiz. Qatorlarning o'zi seed (`onModuleInit`) bilan
 * qo'shiladi — migratsiya ma'lumot yozmaydi. down(): indeks va ustunlar
 * o'chiriladi.
 */
export class DistrictAssignmentReview1716000000227 implements MigrationInterface {
  name = 'DistrictAssignmentReview1716000000227';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "logistics_schema"."districts"
        ADD COLUMN IF NOT EXISTS "assignment_review_required" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "assignment_review_reason" varchar(32) NULL,
        ADD COLUMN IF NOT EXISTS "assignment_flagged_at" timestamptz NULL,
        ADD COLUMN IF NOT EXISTS "assignment_confirmed_by" bigint NULL,
        ADD COLUMN IF NOT EXISTS "assignment_confirmed_at" timestamptz NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_DISTRICT_ASSIGNMENT_REVIEW"
        ON "logistics_schema"."districts" ("assignment_review_required")
        WHERE "assignment_review_required" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "logistics_schema"."IDX_DISTRICT_ASSIGNMENT_REVIEW"
    `);
    await queryRunner.query(`
      ALTER TABLE "logistics_schema"."districts"
        DROP COLUMN IF EXISTS "assignment_confirmed_at",
        DROP COLUMN IF EXISTS "assignment_confirmed_by",
        DROP COLUMN IF EXISTS "assignment_flagged_at",
        DROP COLUMN IF EXISTS "assignment_review_reason",
        DROP COLUMN IF EXISTS "assignment_review_required"
    `);
  }
}
