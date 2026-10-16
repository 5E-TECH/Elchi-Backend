import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Market sozlamalari (`identity_schema.admins`, market qatorlari):
 *
 * w2bDrE3i — qo'shimcha xarajat darvozasi:
 *   - `extra_cost_enabled`           — market buyurtmalariga extra_cost
 *                                      yozish mumkinmi;
 *   - `extra_cost_requires_approval` — market tasdig'i talab qilinadimi
 *                                      (TRUE — avvalgi xulq).
 *
 * ⚠️ ORTGA-MOSLIK (kartadagi qaror): YANGI market uchun sukut — YOPIQ
 * (`false`), lekin MAVJUD marketlar avval darvozasiz ishlagan (ya'ni amalda
 * ochiq edi) — ularning xulqi buzilmasligi kerak. Shuning uchun:
 *   1) ustun `DEFAULT true` bilan qo'shiladi — Postgres 11+ da bu faqat
 *      katalog o'zgarishi ("fast default"): mavjud qatorlar `true` o'qiladi,
 *      jadval qayta yozilmaydi va UPDATE (backfill) YO'Q;
 *   2) so'ng ustun sukuti `false` ga o'tkaziladi — faqat KEYINGI yangi
 *      qatorlarga ta'sir qiladi.
 * Natija: mavjud marketlarda qo'shimcha xarajat ochiq qoladi, yangi
 * marketlarda yopiq; admin `PATCH /admin/markets/:id` bilan boshqaradi.
 *
 * VRyloH62 — chekdagi operator raqami:
 *   - `require_operator_phone` (sukut false — avvalgi xulq);
 *   - `default_operator_phone` (NULL — yo'q).
 *
 * `IF NOT EXISTS` — qayta yurgizish xatosiz. Ustun allaqachon bo'lsa 1-qadam
 * hech narsa qilmaydi (mavjud qiymatlar o'zgarmaydi), 2-qadam faqat sukutni
 * qayta o'rnatadi.
 */
export class MarketExtraCostAndOperatorPhone1716000000114 implements MigrationInterface {
  name = 'MarketExtraCostAndOperatorPhone1716000000114';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        ADD COLUMN IF NOT EXISTS "extra_cost_enabled" BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "extra_cost_requires_approval" BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "require_operator_phone" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "default_operator_phone" VARCHAR(20)
    `);
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        ALTER COLUMN "extra_cost_enabled" SET DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "identity_schema"."admins"
        DROP COLUMN IF EXISTS "default_operator_phone",
        DROP COLUMN IF EXISTS "require_operator_phone",
        DROP COLUMN IF EXISTS "extra_cost_requires_approval",
        DROP COLUMN IF EXISTS "extra_cost_enabled"
    `);
  }
}
