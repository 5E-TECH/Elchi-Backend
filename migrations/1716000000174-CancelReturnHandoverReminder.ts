import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * vNKGbg5q (BG7) — bekor buyurtma HQ/filialda uzoq turib qolsa: 3 kunda
 * marketga eslatma, 7 kunda admin navbatiga eskalatsiya. Takror yubormaslik
 * belgilari buyurtmada.
 *
 * order_schema.orders (hammasi NULL, sukutsiz — jadval qayta yozilmaydi):
 *   - `handover_notified_at` timestamptz — marketga eslatma ketgan payt;
 *   - `handover_escalated_at` timestamptz — admin navbatiga chiqarilgan payt;
 *   - qism indeks `IDX_orders_cancel_return_waiting` (`market_id`) WHERE
 *     `status = 'cancelled' AND holder_type IN ('HQ','BRANCH') AND
 *     handover_escalated_at IS NULL` — cron skani faqat kutayotgan bekorlarni
 *     o'qiydi.
 *
 * BACKFILL YO'Q: eski bekorlar ham NULL — yoqilgandan keyingi birinchi
 * yugurishda muddati o'tganlarga bir martalik eslatma/eskalatsiya ketadi
 * (ega qarori 2026-10-19: 3 / 7 kun — ha). O'chirish — env
 * `CANCEL_RETURN_REMINDER_ENABLED=false`.
 *
 * down(): indeks va ustunlar o'chiriladi.
 *
 * Sxema nomi konstruktorda (sukut `order_schema`) — pg spec alohida sxemada
 * yurgizadi.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class CancelReturnHandoverReminder1716000000174 implements MigrationInterface {
  name = 'CancelReturnHandoverReminder1716000000174';

  private readonly order: string;

  constructor(orderSchema = 'order_schema') {
    if (!SCHEMA_NAME.test(orderSchema)) {
      throw new Error(
        'CancelReturnHandoverReminder1716000000174: noto‘g‘ri sxema nomi',
      );
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
          ADD COLUMN IF NOT EXISTS "handover_notified_at" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "handover_escalated_at" TIMESTAMPTZ NULL;
        CREATE INDEX IF NOT EXISTS "IDX_orders_cancel_return_waiting"
          ON "${o}"."orders" ("market_id")
          WHERE "status" = 'cancelled'
            AND "holder_type" IN ('HQ', 'BRANCH')
            AND "handover_escalated_at" IS NULL;
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
        DROP INDEX IF EXISTS "${o}"."IDX_orders_cancel_return_waiting";
        ALTER TABLE "${o}"."orders"
          DROP COLUMN IF EXISTS "handover_escalated_at",
          DROP COLUMN IF EXISTS "handover_notified_at";
      END
      $$
    `);
  }
}
