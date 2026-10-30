import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T7 (QPq2C1co) «Aloqa raqamlari» — market mas'uli va umumiy aloqa sozlamalari.
 *
 * 1. `identity_schema.admins.market_responsible_id` bigint NULL — faqat
 *    MARKET qatorlarida ma'noli: marketning Elchi mas'uli (superadmin, admin,
 *    registrator yoki logist). NULL — sukut mas'ul (`app_settings`).
 *    FK YO'Q (o'sha jadvalning o'ziga ishora, foydalanuvchi soft-delete
 *    bo'ladi): mas'ul o'chirilganda / roli o'zgarganda NULL qilishni identity
 *    `deleteUser` / `changeUserRole` bajaradi (bitta tranzaksiyada).
 *    Partial indeks — `market_count` va `?responsible_id=` filtri uchun.
 * 2. YANGI `identity_schema.app_settings` (`key` UNIQUE, `value` jsonb,
 *    `updated_by`, vaqtlar) — umumiy kalit-qiymat sozlamalari. Boshlang'ich
 *    kalitlar bo'sh qiymat bilan: `contacts.support_phones` = `[]`,
 *    `contacts.default_market_responsible_id` = `null`.
 *
 * Mavjud ma'lumotga tegmaydi (hamma market sukutda). `IF NOT EXISTS` /
 * `ON CONFLICT DO NOTHING` — qayta yurgizish xatosiz.
 *
 * down(): jadval va ustun o'chiriladi — biriktiruvlar va zaxira raqamlar
 * yo'qoladi.
 */
export class MarketResponsibleContacts1716000000185 implements MigrationInterface {
  name = 'MarketResponsibleContacts1716000000185';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('identity_schema.admins') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "identity_schema"."admins"
          ADD COLUMN IF NOT EXISTS "market_responsible_id" bigint NULL;
        CREATE INDEX IF NOT EXISTS "IDX_ADMINS_MARKET_RESPONSIBLE"
          ON "identity_schema"."admins" ("market_responsible_id")
          WHERE "market_responsible_id" IS NOT NULL;
      END
      $$
    `);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "identity_schema"`);
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "identity_schema"."app_settings" (
        "id" BIGSERIAL NOT NULL,
        "key" varchar(100) NOT NULL,
        "value" jsonb NULL,
        "updated_by" bigint NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_APP_SETTINGS" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_APP_SETTINGS_KEY" UNIQUE ("key")
      )`,
    );
    await queryRunner.query(
      `INSERT INTO "identity_schema"."app_settings" ("key", "value")
       VALUES
         ('contacts.support_phones', '[]'::jsonb),
         ('contacts.default_market_responsible_id', 'null'::jsonb)
       ON CONFLICT ("key") DO NOTHING`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "identity_schema"."app_settings"`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('identity_schema.admins') IS NULL THEN
          RETURN;
        END IF;
        DROP INDEX IF EXISTS "identity_schema"."IDX_ADMINS_MARKET_RESPONSIBLE";
        ALTER TABLE "identity_schema"."admins"
          DROP COLUMN IF EXISTS "market_responsible_id";
      END
      $$
    `);
  }
}
