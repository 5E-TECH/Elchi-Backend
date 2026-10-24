import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * XtcEyQjb — ombor ruxsatlari (ega qarorlari 2026-10-24).
 *
 * identity_schema:
 *   - `admins.can_view_warehouse_stock` boolean NOT NULL DEFAULT false —
 *     market operatorining «Ombordagi qoldiq»ni ko'rish kaliti. Market o'zi
 *     har operatorga alohida yoqadi (`PATCH /market-operators/:id/
 *     warehouse-access`); sukut o'chiq — mavjud operatorlar qoldiqni
 *     ko'rmaydi (market yoqmaguncha).
 *
 * XAVFSIZLIK: mavjud ma'lumot o'zgartirilmaydi (sukutli ustun — PG 11+ da
 * jadval qayta yozilmaydi). `IF NOT EXISTS` — qayta yurgizish xatosiz;
 * `admins` yo'q muhitda o'tkazib yuboriladi.
 *
 * down(): ustun o'chiriladi — yoqilgan kalitlar yo'qoladi (operatorlar
 * qoldiqni ko'rmay qoladi), boshqa ma'lumotga ta'sir yo'q.
 *
 * Sxema nomi konstruktorda (sukut `identity_schema`) — pg spec alohida
 * sxemada yuradi.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class MarketOperatorWarehouseAccess1716000000152 implements MigrationInterface {
  name = 'MarketOperatorWarehouseAccess1716000000152';

  private readonly identity: string;

  constructor(identitySchema = 'identity_schema') {
    if (!SCHEMA_NAME.test(identitySchema)) {
      throw new Error(
        'MarketOperatorWarehouseAccess1716000000152: noto‘g‘ri sxema nomi',
      );
    }
    this.identity = identitySchema;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"${this.identity}"."admins"') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "${this.identity}"."admins"
          ADD COLUMN IF NOT EXISTS "can_view_warehouse_stock" boolean
          NOT NULL DEFAULT false;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"${this.identity}"."admins"') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "${this.identity}"."admins"
          DROP COLUMN IF EXISTS "can_view_warehouse_stock";
      END
      $$
    `);
  }
}
