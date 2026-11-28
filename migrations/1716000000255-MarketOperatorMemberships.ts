import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bitta operator — bir nechta market, 1-bosqich (ega qarorlari 2026-11-28,
 * D1–D8). Hozir market operatori `admins.market_id` orqali BITTA marketga
 * bog'langan; kelajakda bir odam (bitta akkaunt, bitta telefon, bitta
 * Telegram) bir nechta marketda ishlaydi. Qaysi marketlarda ishlashi —
 * shu jadvalda, har birining holati, komissiyasi va ombor ruxsati bilan.
 *
 * `identity_schema.market_operator_markets` — bitta qator = bitta
 * (operator, market) a'zoligi:
 *   • `status` — pending (taklif, hali qabul qilinmagan) | active | inactive
 *     | removed (marketdan chiqarilgan — tarix uchun qoladi);
 *   • `is_primary` — `admins.market_id` bilan sinxron «asosiy market» (eski
 *     kod uchun; bitta operatorda ko'pi bilan bittasi);
 *   • `commission_type` / `commission_value` / `can_view_warehouse_stock` —
 *     hozir `admins` qatorida (bitta qiymat), keyin har market alohida (D3);
 *   • `invited_*` / `accepted_at` / `removed_*` — taklif oqimi (5-bosqich).
 *
 * O'TISH DAVRI (shu migratsiya): yozuvlar hali `admins` ga ketadi, jadval
 * trigger orqali ko'zgu sifatida saqlanadi — HECH BIR o'qish yo'li hali bu
 * jadvalga o'tmagan, xatti-harakat o'zgarmaydi. Trigger
 * `sync_market_operator_primary_membership` (AFTER INSERT / UPDATE OF
 * role, market_id, status, is_deleted, commission_*, can_view_warehouse_stock):
 *   • operator ASOSIY marketni yo'qotsa (rol o'zgardi, `market_id`
 *     almashdi yoki NULL bo'ldi, akkaunt o'chirildi) — eski a'zolik
 *     `removed`;
 *   • operator + mavjud market bo'lsa — (operator, market) a'zoligi upsert:
 *     holat `admins.status` dan (active → active, boshqasi → inactive),
 *     komissiya va ombor kaliti nusxa, `is_primary = true`.
 * Operator qatorini o'zgartiradigan har yo'l (market: yaratish, komissiya,
 * ombor, holat, o'chirish; admin: holat, o'chirish, rol almashtirish)
 * shu bilan qamraladi — ilova kodida ikki joyga yozish unutilmaydi.
 * Trigger operatorning faqat ASOSIY a'zoligiga tegadi; boshqa a'zoliklar
 * (taklif / admin bog'lashi, keyingi bosqichlar) ga tegmaydi. Yozuvlar
 * to'g'ridan-to'g'ri a'zolikka o'tganda (keyingi bosqichlar) trigger qayta
 * ko'rib chiqiladi.
 *
 * Market qatori mavjud bo'lmasa (`market_id` begona id yoki market emas) —
 * a'zolik yozilmaydi: trigger operator amalini HECH QACHON yiqitmasin
 * (FK xatosi `admins` UPDATE'ini rad etardi).
 *
 * Seed: o'chirilmagan, mavjud marketga bog'langan har market operatori —
 * bitta asosiy a'zolik (`accepted_at` = akkaunt yaratilgan vaqt).
 *
 * TARTIB va QULF: jadval va indekslar → trigger → seed. `CREATE TRIGGER`
 * `admins` ga SHARE ROW EXCLUSIVE qulf oladi va commit'gacha turadi —
 * seed bilan trigger orasida parallel o'zgarish tushib qolmaydi. Jadval
 * kichik (operatorlar soni), seed bitta INSERT … SELECT.
 *
 * XAVFSIZLIK: pulga va mavjud ma'lumotga tegmaydi (`admins` faqat
 * o'qiladi). `IF NOT EXISTS` / `CREATE OR REPLACE` / `ON CONFLICT DO
 * NOTHING` — qayta yurgizish xatosiz va dublikatsiz.
 * down(): trigger, funksiya va jadval o'chiriladi (hali hech kim
 * o'qimaydi — ma'lumot `admins` da to'liq).
 */
export const MARKET_OPERATOR_MARKETS_TABLE =
  '"identity_schema"."market_operator_markets"';
export const MARKET_OPERATOR_MARKETS_FUNCTION =
  '"identity_schema"."sync_market_operator_primary_membership"';
export const MARKET_OPERATOR_MARKETS_TRIGGER =
  'TRG_ADMINS_SYNC_MARKET_OPERATOR_MEMBERSHIP';

/** Operator + asosiy marketi a'zolikka yozilishi mumkinmi (trigger va seed). */
const memberCondition = (row: string) => `
  ${row}."role"::text = 'market_operator'
  AND ${row}."market_id" IS NOT NULL
  AND ${row}."is_deleted" = false`;

const marketExists = (marketId: string) => `
  EXISTS (
    SELECT 1 FROM "identity_schema"."admins" m
     WHERE m."id" = ${marketId} AND m."role"::text = 'market'
  )`;

export class MarketOperatorMemberships1716000000255 implements MigrationInterface {
  name = 'MarketOperatorMemberships1716000000255';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ${MARKET_OPERATOR_MARKETS_TABLE} (
        "id" bigserial PRIMARY KEY,
        "operator_id" bigint NOT NULL
          REFERENCES "identity_schema"."admins"("id") ON DELETE CASCADE,
        "market_id" bigint NOT NULL
          REFERENCES "identity_schema"."admins"("id") ON DELETE CASCADE,
        "status" varchar(16) NOT NULL,
        "is_primary" boolean NOT NULL DEFAULT false,
        "commission_type" varchar(16) NULL,
        "commission_value" numeric(14,2) NULL,
        "can_view_warehouse_stock" boolean NOT NULL DEFAULT false,
        "invited_by" bigint NULL,
        "invited_at" timestamptz NULL,
        "accepted_at" timestamptz NULL,
        "removed_by" bigint NULL,
        "removed_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_MARKET_OPERATOR_MARKET_STATUS"
          CHECK ("status" IN ('pending', 'active', 'inactive', 'removed')),
        CONSTRAINT "CHK_MARKET_OPERATOR_MARKET_COMMISSION_TYPE"
          CHECK ("commission_type" IS NULL
                 OR "commission_type" IN ('percent', 'fixed')),
        CONSTRAINT "CHK_MARKET_OPERATOR_MARKET_NOT_SELF"
          CHECK ("operator_id" <> "market_id")
      )
    `);
    // Bitta (operator, market) — bitta ochiq a'zolik; chiqarilganlari tarix.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_MARKET_OPERATOR_MARKET_OPEN"
        ON ${MARKET_OPERATOR_MARKETS_TABLE} ("operator_id", "market_id")
        WHERE "status" <> 'removed'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_MARKET_OPERATOR_MARKET_PRIMARY"
        ON ${MARKET_OPERATOR_MARKETS_TABLE} ("operator_id")
        WHERE "is_primary"
    `);
    // Market sahifasi: «mening operatorlarim» (holat bo'yicha).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_MARKET_OPERATOR_MARKET_MARKET"
        ON ${MARKET_OPERATOR_MARKETS_TABLE} ("market_id", "status")
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${MARKET_OPERATOR_MARKETS_FUNCTION}()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        changed_at timestamptz := clock_timestamp();
        was_member boolean := false;
        is_member boolean;
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          was_member := ${memberCondition('OLD')};
        END IF;
        is_member := ${memberCondition('NEW')}
          AND ${marketExists('NEW."market_id"')};

        -- Asosiy market yo'qoldi yoki almashdi — eski a'zolik yopiladi.
        IF was_member
           AND (NOT is_member OR NEW."market_id" IS DISTINCT FROM OLD."market_id")
        THEN
          UPDATE ${MARKET_OPERATOR_MARKETS_TABLE}
             SET "status" = 'removed',
                 "is_primary" = false,
                 "removed_at" = changed_at,
                 "updated_at" = changed_at
           WHERE "operator_id" = OLD."id"
             AND "market_id" = OLD."market_id"
             AND "status" <> 'removed';
        END IF;

        IF is_member THEN
          -- Boshqa marketdagi «asosiy» belgisi olinadi (bittadan ortiq bo'lmasin).
          UPDATE ${MARKET_OPERATOR_MARKETS_TABLE}
             SET "is_primary" = false, "updated_at" = changed_at
           WHERE "operator_id" = NEW."id"
             AND "is_primary"
             AND "market_id" <> NEW."market_id";
          INSERT INTO ${MARKET_OPERATOR_MARKETS_TABLE}
            ("operator_id", "market_id", "status", "is_primary",
             "commission_type", "commission_value", "can_view_warehouse_stock",
             "accepted_at", "created_at", "updated_at")
          VALUES
            (NEW."id", NEW."market_id",
             CASE WHEN NEW."status"::text = 'active' THEN 'active' ELSE 'inactive' END,
             true,
             NEW."commission_type"::text, NEW."commission_value",
             COALESCE(NEW."can_view_warehouse_stock", false),
             changed_at, changed_at, changed_at)
          ON CONFLICT ("operator_id", "market_id") WHERE "status" <> 'removed'
          DO UPDATE SET
            "status" = EXCLUDED."status",
            "is_primary" = true,
            "commission_type" = EXCLUDED."commission_type",
            "commission_value" = EXCLUDED."commission_value",
            "can_view_warehouse_stock" = EXCLUDED."can_view_warehouse_stock",
            "updated_at" = changed_at;
        END IF;
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "${MARKET_OPERATOR_MARKETS_TRIGGER}"
        ON "identity_schema"."admins"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "${MARKET_OPERATOR_MARKETS_TRIGGER}"
      AFTER INSERT OR UPDATE OF
        "role", "market_id", "status", "is_deleted",
        "commission_type", "commission_value", "can_view_warehouse_stock"
        ON "identity_schema"."admins"
      FOR EACH ROW EXECUTE FUNCTION ${MARKET_OPERATOR_MARKETS_FUNCTION}()
    `);

    // Seed — hozirgi bog'lanishlar (qayta yurgizishda ochiq a'zolik bor —
    // qisman unikal indeks tufayli hech narsa qo'shilmaydi).
    await queryRunner.query(`
      INSERT INTO ${MARKET_OPERATOR_MARKETS_TABLE}
        ("operator_id", "market_id", "status", "is_primary",
         "commission_type", "commission_value", "can_view_warehouse_stock",
         "accepted_at")
      SELECT a."id", a."market_id",
             CASE WHEN a."status"::text = 'active' THEN 'active' ELSE 'inactive' END,
             true,
             a."commission_type"::text, a."commission_value",
             COALESCE(a."can_view_warehouse_stock", false),
             a."createdAt"
        FROM "identity_schema"."admins" a
       WHERE ${memberCondition('a')}
         AND ${marketExists('a."market_id"')}
      ON CONFLICT ("operator_id", "market_id") WHERE "status" <> 'removed'
      DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "${MARKET_OPERATOR_MARKETS_TRIGGER}"
        ON "identity_schema"."admins"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS ${MARKET_OPERATOR_MARKETS_FUNCTION}()
    `);
    await queryRunner.query(`
      DROP TABLE IF EXISTS ${MARKET_OPERATOR_MARKETS_TABLE}
    `);
  }
}
