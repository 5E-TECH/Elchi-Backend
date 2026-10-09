import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Market xodimi rolini yagona qilish (i76gGjyq).
 *
 * Biznes mantiq (order, analytics, custody, `/market-operators`) faqat
 * `market_operator` ga tayanadi; eski frontend esa `operator` bilan ishlardi.
 * Marketga bog'langan (`market_id` bor) `operator` qatorlari aslida market
 * xodimi — ular `market_operator` ga ko'chiriladi. `market_id` siz `operator`
 * (Elchi ichki operatori) tegilmaydi.
 *
 * 2026-10-09 holatiga prod'da bunday qator YO'Q — migratsiya himoya uchun
 * (no-op). Ko'chirilganlar `identity_schema.unify_market_operator_role_065`
 * ga yoziladi — `down()` aynan shularni qaytaradi.
 */
export class UnifyMarketOperatorRole1716000000065 implements MigrationInterface {
  name = 'UnifyMarketOperatorRole1716000000065';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "identity_schema"."unify_market_operator_role_065" (
        "user_id" bigint PRIMARY KEY,
        "migrated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      WITH moved AS (
        UPDATE "identity_schema"."admins"
           SET "role" = 'market_operator'
         WHERE "role" = 'operator'
           AND "market_id" IS NOT NULL
        RETURNING "id"
      )
      INSERT INTO "identity_schema"."unify_market_operator_role_065" ("user_id")
      SELECT "id" FROM moved
      ON CONFLICT ("user_id") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "identity_schema"."admins" a
         SET "role" = 'operator'
        FROM "identity_schema"."unify_market_operator_role_065" m
       WHERE a."id" = m."user_id"
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "identity_schema"."unify_market_operator_role_065"`,
    );
  }
}
