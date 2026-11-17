import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B0ILd7YI — rejalashtirilgan (kelajakda kuchga kiradigan) yetkazish tarifi
 * versiyasini BEKOR QILISH (`POST /delivery/tariffs/:id/cancel`).
 *
 * `logistics_schema.delivery_tariffs` ga ikki ustun:
 *   - `cancelled_at` TIMESTAMPTZ NULL — qachon bekor qilingan;
 *   - `cancelled_by` BIGINT NULL — kim (`identity_schema.admins.id`, FK yo'q —
 *     sxemalar alohida, `created_by` kabi).
 * Bekor qilingan qator O'CHIRILMAYDI: `is_active = false` bo'ladi (faol tarif
 * tanlovi — `is_active AND valid_from <= now()` — uni hech qachon olmaydi),
 * tarixda «Bekor qilingan» bo'lib qoladi.
 *
 * CHECK `CHK_delivery_tariffs_cancelled` — bekor qilingan qator faol bo'la
 * olmaydi (`cancelled_at IS NULL OR is_active = false`).
 *
 * Mavjud qatorlarga tegilmaydi (ikkala ustun NULL — hech biri bekor
 * qilinmagan). `IF NOT EXISTS` / mavjudlik tekshiruvi — qayta yurgizish
 * xatosiz; jadval yo'q muhitda (142 yurgizilmagan) o'tkaziladi.
 *
 * down(): CHECK va ustunlar o'chiriladi — kim/qachon bekor qilgani yo'qoladi
 * (jurnalda `logistics.delivery_tariff_cancelled` qoladi), bekor qilingan
 * qatorlar esa `is_active = false` bo'lib qoladi (qayta kuchga kirmaydi).
 */
export class DeliveryTariffCancelScheduled1716000000232 implements MigrationInterface {
  name = 'DeliveryTariffCancelScheduled1716000000232';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('logistics_schema.delivery_tariffs') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "logistics_schema"."delivery_tariffs"
          ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ NULL;
        ALTER TABLE "logistics_schema"."delivery_tariffs"
          ADD COLUMN IF NOT EXISTS "cancelled_by" BIGINT NULL;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_delivery_tariffs_cancelled'
             AND conrelid = 'logistics_schema.delivery_tariffs'::regclass
        ) THEN
          ALTER TABLE "logistics_schema"."delivery_tariffs"
            ADD CONSTRAINT "CHK_delivery_tariffs_cancelled"
            CHECK ("cancelled_at" IS NULL OR "is_active" = false);
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('logistics_schema.delivery_tariffs') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "logistics_schema"."delivery_tariffs"
          DROP CONSTRAINT IF EXISTS "CHK_delivery_tariffs_cancelled";
        ALTER TABLE "logistics_schema"."delivery_tariffs"
          DROP COLUMN IF EXISTS "cancelled_by";
        ALTER TABLE "logistics_schema"."delivery_tariffs"
          DROP COLUMN IF EXISTS "cancelled_at";
      END
      $$
    `);
  }
}
