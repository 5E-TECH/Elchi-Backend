import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `order_schema.order_settings` — buyurtma servisining global sozlamalari
 * (key/value, `finance_schema.finance_settings` bilan bir xil shakl).
 *
 * Birinchi kalitlar (ega 2026-11-09, `libs/common/src/order/order-intake.ts`):
 *   - `intake.cutoff`          — BUGUNGI ish kuni uchun qabul tugash vaqti
 *     (`{ window_start, date, cutoff_time }`); kun almashganda o'zi amal
 *     qilmay qoladi, qator o'chirilmaydi;
 *   - `intake.day_change_time` — kun almashish soati (`{ time: 'HH:MM' }`,
 *     Trello #756). Qator yo'q — `00:00` (avvalgi xulq).
 *
 * Faqat yangi jadval: mavjud jadvallarga tegilmaydi, backfill yo'q, ya'ni
 * qator bo'lmagani — «cheklovsiz, kun 00:00 da almashadi» (o'zgarishsiz).
 * `IF NOT EXISTS` — qayta ishga tushirish xavfsiz.
 */
export class OrderSettings1716000000213 implements MigrationInterface {
  name = 'OrderSettings1716000000213';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_schema"."order_settings" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "key" VARCHAR(100) NOT NULL,
        "value" JSONB NOT NULL,
        "updated_by" BIGINT NULL,
        CONSTRAINT "PK_order_settings_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_ORDER_SETTINGS_KEY"
        ON "order_schema"."order_settings" ("key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "order_schema"."UQ_ORDER_SETTINGS_KEY"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "order_schema"."order_settings"`,
    );
  }
}
