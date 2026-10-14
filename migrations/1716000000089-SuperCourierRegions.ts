import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * hEjjuJaT — super-kuryer (ko'p viloyat) va viloyat bo'yicha kuryer tarifi
 * (BeePost `courier_regions` + `users.is_super_courier/serves_all_regions`).
 *
 * 1. `identity_schema.admins.is_super_courier` / `serves_all_regions`
 *    boolean NOT NULL DEFAULT false — mavjud kuryerlar o'zgarmaydi (yassi tarif,
 *    bitta `region_id`).
 * 2. `identity_schema.courier_regions` — (courier_id, region_id) UNIQUE,
 *    `tariff_home` / `tariff_center` NULL = kuryerning umumiy tarifiga fallback.
 *    `courier_id` → admins(id) FK (bir sxema ichida); kuryer qatori o'chirilsa
 *    (hard delete) qatorlar ham ketadi. `region_id` — logistics_schema'da,
 *    sxemalararo FK yo'q (loyiha qoidasi, 1716000000060 bilan bir xil).
 *    Tarif manfiy bo'lmaydi (CHECK).
 */
export class SuperCourierRegions1716000000089 implements MigrationInterface {
  name = 'SuperCourierRegions1716000000089';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" ADD COLUMN IF NOT EXISTS "is_super_courier" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" ADD COLUMN IF NOT EXISTS "serves_all_regions" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "identity_schema"."courier_regions" (
        "id" BIGSERIAL PRIMARY KEY,
        "courier_id" bigint NOT NULL
          REFERENCES "identity_schema"."admins" ("id") ON DELETE CASCADE,
        "region_id" bigint NOT NULL,
        "tariff_home" integer NULL,
        "tariff_center" integer NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_COURIER_REGIONS_TARIFF_NON_NEGATIVE" CHECK (
          ("tariff_home" IS NULL OR "tariff_home" >= 0)
          AND ("tariff_center" IS NULL OR "tariff_center" >= 0)
        )
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_COURIER_REGIONS_COURIER_REGION" ON "identity_schema"."courier_regions" ("courier_id", "region_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_COURIER_REGIONS_REGION" ON "identity_schema"."courier_regions" ("region_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "identity_schema"."courier_regions"`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" DROP COLUMN IF EXISTS "serves_all_regions"`,
    );
    await queryRunner.query(
      `ALTER TABLE "identity_schema"."admins" DROP COLUMN IF EXISTS "is_super_courier"`,
    );
  }
}
