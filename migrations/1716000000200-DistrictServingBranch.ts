import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tuman ↔ filial qamrovi (ega qarori, 2026-11-02) — tumanga XIZMAT filiali:
 * `logistics_schema.districts.serving_branch_id` (branch-service filial id).
 * Bir viloyatda bir nechta filial bo'lsa tumanlar shu ustun bilan bo'linadi;
 * NULL — o'tish davri (qamrov tumanning xizmat viloyati bo'yicha,
 * `isOrderServedByBranch`).
 *
 * FK YO'Q ataylab: filiallar boshqa sxemada (`branch_schema`). Filial
 * o'chirilsa / nofaol qilinsa branch-service
 * `logistics.district.clear_serving_branch` bilan bo'shatadi.
 *
 * XAVFSIZLIK: pulga tegmaydi. `ADD COLUMN … NULL` (sukutsiz) — faqat
 * metama'lumot. `IF NOT EXISTS` — qayta yurgizish xatosiz. down(): indeks
 * va ustun o'chiriladi.
 */
export class DistrictServingBranch1716000000200 implements MigrationInterface {
  name = 'DistrictServingBranch1716000000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "logistics_schema"."districts"
        ADD COLUMN IF NOT EXISTS "serving_branch_id" bigint NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_DISTRICT_SERVING_BRANCH"
        ON "logistics_schema"."districts" ("serving_branch_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "logistics_schema"."IDX_DISTRICT_SERVING_BRANCH"
    `);
    await queryRunner.query(`
      ALTER TABLE "logistics_schema"."districts"
        DROP COLUMN IF EXISTS "serving_branch_id"
    `);
  }
}
