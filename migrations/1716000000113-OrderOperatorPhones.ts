import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * VRyloH62 — buyurtmadagi operator raqamlari (yorliq/chekdagi "Muammo
 * bo'lsa" qatori):
 *   - `operator_phone`           — 1-raqam (market doimiy raqami yoki
 *                                  majburiy holatda formadagi raqam);
 *   - `secondary_operator_phone` — 2-raqam (formada kiritilgan, 1-dan farqli).
 * Qiymatni gateway (`order-create/order-operator-phone.ts`) hal qiladi.
 *
 * FAQAT SXEMA: ikkala ustun NULL bilan qo'shiladi — mavjud buyurtmalarda
 * raqam yo'q, chekda avvalgidek market raqami chiqadi. Backfill yo'q;
 * `IF NOT EXISTS` — qayta yurgizish xatosiz.
 */
export class OrderOperatorPhones1716000000113 implements MigrationInterface {
  name = 'OrderOperatorPhones1716000000113';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        ADD COLUMN IF NOT EXISTS "operator_phone" VARCHAR(20),
        ADD COLUMN IF NOT EXISTS "secondary_operator_phone" VARCHAR(20)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "order_schema"."orders"
        DROP COLUMN IF EXISTS "secondary_operator_phone",
        DROP COLUMN IF EXISTS "operator_phone"
    `);
  }
}
