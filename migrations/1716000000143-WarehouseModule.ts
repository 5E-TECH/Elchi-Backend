import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * hY7uacJu — vaqtinchalik ombor moduli (ega qarorlari 2026-10-23).
 *
 * catalog_schema:
 *   - `warehouses` — viloyat filiali ombori: `branch_id` yagona (faqat
 *     o'chirilmagan qatorlar), holat ACTIVE | PAUSED (to'xtatilganda
 *     `paused_at` majburiy — `CHK_warehouses_paused_at`), «kam qoldiq»
 *     sukuti `low_stock_default`.
 *   - `warehouse_stock` — ombor × mahsulot qoldig'i, UNIQUE(warehouse_id,
 *     product_id). `on_hand ≥ 0`, `0 ≤ reserved ≤ on_hand` — DB darajasida
 *     (ilova xatosi ham manfiy qoldiq yoki ortiqcha band yoza olmaydi).
 *     `market_id` — mahsulot egasi (products.user_id) nusxasi: market
 *     «Ombordagi qoldiq» so'rovi JOIN'siz indeksdan o'qiydi.
 *   - `stock_movements` — FAQAT QO'SHILADIGAN jurnal: UPDATE/DELETE trigger
 *     bilan taqiqlangan (`TRG_stock_movements_append_only`).
 *     `idempotency_key` UNIQUE — takroriy so'rov ikkinchi marta yozmaydi.
 *     `qty` ishorasi tur bo'yicha CHECK bilan qulflangan
 *     (`@app/common` `STOCK_MOVEMENT_TYPES` izohi).
 *   - `stock_reservations` — buyurtma bandi (order-service RPC'lari):
 *     RESERVED → RELEASED | OUT → RETURNED. Bitta buyurtma × mahsulot uchun
 *     faqat bitta FAOL (RESERVED/OUT) qator — partial UNIQUE. Shu jadval
 *     release/out/return'ni buyurtma bo'yicha AYNAN band qilingan miqdorga
 *     bog'laydi va takroriy chaqiruvni no-op qiladi.
 * identity_schema:
 *   - `admins.can_order_from_warehouse` boolean NOT NULL DEFAULT false —
 *     market «Ombordan buyurtma yaratish» kaliti (faqat SUPERADMIN/ADMIN).
 *
 * XAVFSIZLIK: mavjud ma'lumot o'zgartirilmaydi (faqat yangi jadvallar va
 * sukutli ustun — PG 11+ da jadval qayta yozilmaydi). Hammasi `IF NOT
 * EXISTS` / mavjudlik tekshiruvi bilan — qayta yurgizish xatosiz;
 * `identity_schema.admins` yo'q muhitda identity qismi o'tkazib yuboriladi.
 *
 * down(): to'rt jadval va ustun o'chiriladi — qoldiq va harakatlar
 * YO'QOLADI. Revert'dan oldin backup (`npm run migration:run:safe` /
 * `npm run db:backup`).
 *
 * Sxema nomlari konstruktorda (sukut `catalog_schema` / `identity_schema`)
 * — TypeORM argumentsiz yaratadi; haqiqiy Postgres spec'i
 * (`warehouse.pg.spec.ts`) alohida sxemada yurib, boshqa spec'lar
 * `catalog_schema` ni tashlab yuborishi bilan to'qnashmaydi.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class WarehouseModule1716000000143 implements MigrationInterface {
  name = 'WarehouseModule1716000000143';

  private readonly catalog: string;
  private readonly identity: string;

  constructor(
    catalogSchema = 'catalog_schema',
    identitySchema = 'identity_schema',
  ) {
    if (!SCHEMA_NAME.test(catalogSchema) || !SCHEMA_NAME.test(identitySchema)) {
      throw new Error('WarehouseModule1716000000143: noto‘g‘ri sxema nomi');
    }
    this.catalog = catalogSchema;
    this.identity = identitySchema;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const c = this.catalog;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${c}"."warehouses" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "branch_id" bigint NOT NULL,
        "name" character varying(160) NOT NULL,
        "manager_user_id" bigint NULL,
        "address" character varying(255) NULL,
        "low_stock_default" integer NOT NULL DEFAULT 5,
        "note" character varying(1000) NULL,
        "status" character varying(16) NOT NULL DEFAULT 'ACTIVE',
        "paused_at" TIMESTAMPTZ NULL,
        "paused_by" bigint NULL,
        "created_by" bigint NULL,
        CONSTRAINT "PK_warehouses_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_warehouses_status"
          CHECK ("status" IN ('ACTIVE', 'PAUSED')),
        CONSTRAINT "CHK_warehouses_paused_at"
          CHECK (("status" = 'PAUSED') = ("paused_at" IS NOT NULL)),
        CONSTRAINT "CHK_warehouses_low_stock_default"
          CHECK ("low_stock_default" >= 0),
        CONSTRAINT "CHK_warehouses_name_not_blank"
          CHECK (btrim("name") <> '')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_warehouses_branch_id"
        ON "${c}"."warehouses" ("branch_id") WHERE "is_deleted" = false
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_warehouses_status"
        ON "${c}"."warehouses" ("status")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${c}"."warehouse_stock" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "warehouse_id" bigint NOT NULL,
        "product_id" bigint NOT NULL,
        "market_id" bigint NOT NULL,
        "on_hand" integer NOT NULL DEFAULT 0,
        "reserved" integer NOT NULL DEFAULT 0,
        "low_stock_threshold" integer NULL,
        "last_movement_at" TIMESTAMPTZ NULL,
        CONSTRAINT "PK_warehouse_stock_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_warehouse_stock_warehouse_product"
          UNIQUE ("warehouse_id", "product_id"),
        CONSTRAINT "CHK_warehouse_stock_on_hand" CHECK ("on_hand" >= 0),
        CONSTRAINT "CHK_warehouse_stock_reserved"
          CHECK ("reserved" >= 0 AND "reserved" <= "on_hand"),
        CONSTRAINT "CHK_warehouse_stock_threshold"
          CHECK ("low_stock_threshold" IS NULL OR "low_stock_threshold" >= 0),
        CONSTRAINT "FK_warehouse_stock_warehouse"
          FOREIGN KEY ("warehouse_id") REFERENCES "${c}"."warehouses" ("id"),
        CONSTRAINT "FK_warehouse_stock_product"
          FOREIGN KEY ("product_id") REFERENCES "${c}"."products" ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_warehouse_stock_market"
        ON "${c}"."warehouse_stock" ("market_id", "warehouse_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_warehouse_stock_product"
        ON "${c}"."warehouse_stock" ("product_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${c}"."stock_movements" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "warehouse_id" bigint NOT NULL,
        "product_id" bigint NOT NULL,
        "market_id" bigint NOT NULL,
        "type" character varying(16) NOT NULL,
        "qty" integer NOT NULL,
        "on_hand_after" integer NOT NULL,
        "reserved_after" integer NOT NULL,
        "ref_type" character varying(16) NULL,
        "ref_id" character varying(128) NULL,
        "actor_id" bigint NULL,
        "actor_role" character varying(32) NULL,
        "note" character varying(1000) NULL,
        "idempotency_key" character varying(255) NOT NULL,
        CONSTRAINT "PK_stock_movements_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_stock_movements_idempotency_key"
          UNIQUE ("idempotency_key"),
        CONSTRAINT "CHK_stock_movements_type" CHECK ("type" IN (
          'IN', 'ADJUST', 'RESERVE', 'RELEASE', 'OUT', 'RETURN',
          'MOVE_OUT', 'MOVE_IN'
        )),
        CONSTRAINT "CHK_stock_movements_qty_sign" CHECK (
          ("type" IN ('IN', 'RETURN', 'MOVE_IN', 'RESERVE') AND "qty" > 0) OR
          ("type" IN ('OUT', 'MOVE_OUT', 'RELEASE') AND "qty" < 0) OR
          ("type" = 'ADJUST' AND "qty" <> 0)
        ),
        CONSTRAINT "CHK_stock_movements_after" CHECK (
          "on_hand_after" >= 0 AND "reserved_after" >= 0
          AND "reserved_after" <= "on_hand_after"
        ),
        CONSTRAINT "CHK_stock_movements_ref_type" CHECK (
          "ref_type" IS NULL OR
          "ref_type" IN ('stock_in', 'inventory', 'order', 'move')
        ),
        CONSTRAINT "FK_stock_movements_warehouse"
          FOREIGN KEY ("warehouse_id") REFERENCES "${c}"."warehouses" ("id"),
        CONSTRAINT "FK_stock_movements_product"
          FOREIGN KEY ("product_id") REFERENCES "${c}"."products" ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stock_movements_warehouse_created"
        ON "${c}"."stock_movements" ("warehouse_id", "createdAt" DESC, "id" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stock_movements_ref"
        ON "${c}"."stock_movements" ("ref_type", "ref_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stock_movements_product"
        ON "${c}"."stock_movements" ("product_id", "warehouse_id")
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "${c}"."stock_movements_append_only"()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'stock_movements faqat qo''shiladi (% taqiqlangan)', TG_OP
          USING ERRCODE = '55000';
      END
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_stock_movements_append_only"
        ON "${c}"."stock_movements"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_stock_movements_append_only"
        BEFORE UPDATE OR DELETE ON "${c}"."stock_movements"
        FOR EACH ROW EXECUTE FUNCTION "${c}"."stock_movements_append_only"()
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${c}"."stock_reservations" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "order_id" bigint NOT NULL,
        "warehouse_id" bigint NOT NULL,
        "product_id" bigint NOT NULL,
        "market_id" bigint NOT NULL,
        "qty" integer NOT NULL,
        "returned_qty" integer NOT NULL DEFAULT 0,
        "status" character varying(16) NOT NULL DEFAULT 'RESERVED',
        "released_at" TIMESTAMPTZ NULL,
        "out_at" TIMESTAMPTZ NULL,
        "returned_at" TIMESTAMPTZ NULL,
        CONSTRAINT "PK_stock_reservations_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_stock_reservations_qty" CHECK ("qty" > 0),
        CONSTRAINT "CHK_stock_reservations_returned_qty"
          CHECK ("returned_qty" >= 0 AND "returned_qty" <= "qty"),
        CONSTRAINT "CHK_stock_reservations_status" CHECK (
          "status" IN ('RESERVED', 'RELEASED', 'OUT', 'RETURNED')
        ),
        CONSTRAINT "FK_stock_reservations_warehouse"
          FOREIGN KEY ("warehouse_id") REFERENCES "${c}"."warehouses" ("id"),
        CONSTRAINT "FK_stock_reservations_product"
          FOREIGN KEY ("product_id") REFERENCES "${c}"."products" ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_stock_reservations_order_product_active"
        ON "${c}"."stock_reservations" ("order_id", "product_id")
        WHERE "status" IN ('RESERVED', 'OUT')
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stock_reservations_order"
        ON "${c}"."stock_reservations" ("order_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stock_reservations_warehouse_status"
        ON "${c}"."stock_reservations" ("warehouse_id", "status")
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"${this.identity}"."admins"') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "${this.identity}"."admins"
          ADD COLUMN IF NOT EXISTS "can_order_from_warehouse" boolean
          NOT NULL DEFAULT false;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const c = this.catalog;
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"${this.identity}"."admins"') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "${this.identity}"."admins"
          DROP COLUMN IF EXISTS "can_order_from_warehouse";
      END
      $$
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "${c}"."stock_reservations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${c}"."stock_movements"`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "${c}"."stock_movements_append_only"()`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "${c}"."warehouse_stock"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${c}"."warehouses"`);
  }
}
