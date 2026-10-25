import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * txmkXVBa — buyurtmada mijoz QO'SHIMCHA raqamining nusxasi (ega qarori
 * 2026-10-19 S5: «Faqat shu buyurtmada» tanlansa mijoz kartasi o'zgarmaydi,
 * qo'shimcha raqam faqat buyurtmaga yoziladi — manzil va tuman kabi).
 *
 * order_schema.orders:
 *   - `extra_number` varchar(32) NULL, sukutsiz — jadval qayta yozilmaydi;
 *     eski buyurtmalar NULL qoladi (backfill yo'q).
 *
 * down(): ustun o'chiriladi.
 *
 * Sxema nomi konstruktorda (sukut `order_schema`) — pg spec alohida sxemada
 * yurgizishi mumkin.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class OrderExtraNumber1716000000156 implements MigrationInterface {
  name = 'OrderExtraNumber1716000000156';

  private readonly order: string;

  constructor(orderSchema = 'order_schema') {
    if (!SCHEMA_NAME.test(orderSchema)) {
      throw new Error('OrderExtraNumber1716000000156: noto‘g‘ri sxema nomi');
    }
    this.order = orderSchema;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const o = this.order;
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"${o}"."orders"') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "${o}"."orders"
          ADD COLUMN IF NOT EXISTS "extra_number" character varying(32) NULL;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const o = this.order;
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"${o}"."orders"') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "${o}"."orders" DROP COLUMN IF EXISTS "extra_number";
      END
      $$
    `);
  }
}
