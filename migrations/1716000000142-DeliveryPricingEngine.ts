import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DAqXPeSy — yetkazish narxi dvigateli: tarif jadvali, sozlamalar va shahar
 * zonasi. Hisob — `@app/common` `computeDeliveryQuote` (sof funksiya); bu
 * migratsiya faqat uning KIRISH qiymatlarini (yagona manba, admin tahrirlaydi)
 * yaratadi. Sotuv oqimiga ULANMAYDI (KmWO9gTA).
 *
 * 1. `logistics_schema.delivery_tariffs` — VERSIYALANGAN tarif jadvali
 *    (BeePost `marketplace_tariff` naqshi). Faol tarif = shu `tariff_id`
 *    bo'yicha `is_active` va `valid_from <= now()` qatorlar ichida eng
 *    so'nggi `valid_from` (teng bo'lsa katta `id`). Yangi narx — YANGI qator;
 *    eski qator o'chirilmaydi (tarix va sotuvdagi snapshot izohi uchun).
 *    Pul — `numeric(14,2)` (market profilidagi `int` tarif asimmetriyasi
 *    takrorlanmaydi).
 * 2. `logistics_schema.delivery_pricing_settings` — formula sozlamalari;
 *    `UQ_delivery_pricing_settings_active` bilan ko'pi bilan BITTA faol qator.
 *    O'zgartirish ham yangi qator (eski `is_active = false`) — tarix qoladi.
 * 3. `logistics_schema.regions.is_city_zone` — `city` tarifi faqat ikkala
 *    uchi ham shahar zonasida bo'lsa (landing `isCityRoute`). Faqat Toshkent
 *    SHAHRI: SOATO `1726`; SOATO'si yo'q qatorda — aniq nom bilan. ⚠️ Nom
 *    prefiksi bilan ("Toshkent%") QIDIRILMAYDI: prod'da Toshkent VILOYATI
 *    qatori `Toshkent` (SOATO 1727) deb nomlangan.
 *    Belgilash FAQAT ustun shu migratsiyada qo'shilganda bajariladi — qayta
 *    yurgizish admin o'zgartirishini ustidan yozmaydi.
 *
 * SEED — elchipochta.uz `config/site.ts` (landing origin/main 3697d84) bilan
 * AYNI: city 35 000 + 4 000/kg (1 kun), center 40 000 + 4 000/kg (1–2 kun),
 * address 60 000 + 5 000/kg (2–3 kun), `valid_from` — biznes tasdiqlagan
 * sana 2026-10-08 (Toshkent). Sozlamalar: hajm bo'luvchisi 5000 (MH-S1..S4),
 * birinchi kg bazada (1.0), minimum 0.1 kg, qadam 0.1 kg, 500 ga yaxlitlash,
 * express × 1.4. ⚠️ PICKUP — ega qarori (Shodiyor, 2026-10-15): 1–9 posilka
 * 20 000, 10+ tekin; saytdagi 8 000 eski (tuzatish — GiR4WoBl).
 * `days_*` va express koeffitsienti landing'da hali `TODO(real)` —
 * tasdiqlanganda admin endpointi orqali yangi versiya yoziladi.
 *
 * XAVFSIZLIK: `IF NOT EXISTS` / `NOT EXISTS` — qayta yurgizish xatosiz va
 * dublikat seed'siz; mavjud ma'lumot o'zgartirilmaydi (faqat yangi
 * `is_city_zone` ustuni to'ldiriladi). `regions` jadvali yo'q muhitda ustun
 * qadami o'tkazib yuboriladi.
 *
 * down(): ikkala jadval va `is_city_zone` o'chiriladi — admin kiritgan tarif
 * versiyalari va sozlamalar YO'QOLADI. Revert'dan oldin backup
 * (`npm run migration:run:safe` / `npm run db:backup`).
 */
export const DELIVERY_TARIFF_SEED: ReadonlyArray<{
  tariff_id: 'city' | 'center' | 'address';
  base_price: number;
  extra_per_kg: number;
  days_min: number;
  days_max: number;
}> = Object.freeze([
  {
    tariff_id: 'city',
    base_price: 35_000,
    extra_per_kg: 4_000,
    days_min: 1,
    days_max: 1,
  },
  {
    tariff_id: 'center',
    base_price: 40_000,
    extra_per_kg: 4_000,
    days_min: 1,
    days_max: 2,
  },
  {
    tariff_id: 'address',
    base_price: 60_000,
    extra_per_kg: 5_000,
    days_min: 2,
    days_max: 3,
  },
]);

/** Landing narxlari biznes tomonidan tasdiqlangan sana (Toshkent vaqti). */
export const DELIVERY_TARIFF_SEED_VALID_FROM = '2026-10-08T00:00:00+05:00';

export const DELIVERY_PRICING_SETTINGS_SEED = Object.freeze({
  volumetric_divisor: 5000,
  first_kg_included: 1,
  min_billable_kg: 0.1,
  billable_step_kg: 0.1,
  round_to: 500,
  pickup_fee: 20_000,
  pickup_free_from_count: 10,
  express_multiplier: 1.4,
});

export class DeliveryPricingEngine1716000000142 implements MigrationInterface {
  name = 'DeliveryPricingEngine1716000000142';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "logistics_schema"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "logistics_schema"."delivery_tariffs" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "tariff_id" VARCHAR(16) NOT NULL,
        "base_price" NUMERIC(14,2) NOT NULL,
        "extra_per_kg" NUMERIC(14,2) NOT NULL,
        "days_min" INTEGER NOT NULL,
        "days_max" INTEGER NOT NULL,
        "valid_from" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_active" BOOLEAN NOT NULL DEFAULT true,
        "created_by" BIGINT NULL,
        CONSTRAINT "PK_delivery_tariffs_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_delivery_tariffs_tariff_id"
          CHECK ("tariff_id" IN ('city', 'center', 'address')),
        CONSTRAINT "CHK_delivery_tariffs_prices"
          CHECK ("base_price" >= 0 AND "extra_per_kg" >= 0),
        CONSTRAINT "CHK_delivery_tariffs_days"
          CHECK ("days_min" >= 0 AND "days_max" >= "days_min")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_delivery_tariffs_current"
        ON "logistics_schema"."delivery_tariffs"
          ("tariff_id", "valid_from" DESC, "id" DESC)
        WHERE "is_active" = true AND "is_deleted" = false
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "logistics_schema"."delivery_pricing_settings" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "volumetric_divisor" INTEGER NOT NULL,
        "first_kg_included" NUMERIC(10,3) NOT NULL,
        "min_billable_kg" NUMERIC(10,3) NOT NULL,
        "billable_step_kg" NUMERIC(10,3) NOT NULL,
        "round_to" INTEGER NOT NULL,
        "pickup_fee" NUMERIC(14,2) NOT NULL,
        "pickup_free_from_count" INTEGER NULL,
        "express_multiplier" NUMERIC(6,3) NOT NULL,
        "is_active" BOOLEAN NOT NULL DEFAULT true,
        "created_by" BIGINT NULL,
        CONSTRAINT "PK_delivery_pricing_settings_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_delivery_pricing_settings_values" CHECK (
          "volumetric_divisor" > 0 AND
          "first_kg_included" >= 0 AND
          "min_billable_kg" > 0 AND
          "billable_step_kg" > 0 AND
          "round_to" > 0 AND
          "pickup_fee" >= 0 AND
          ("pickup_free_from_count" IS NULL OR "pickup_free_from_count" > 0) AND
          "express_multiplier" >= 1
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_delivery_pricing_settings_active"
        ON "logistics_schema"."delivery_pricing_settings" ("is_active")
        WHERE "is_active" = true AND "is_deleted" = false
    `);

    // Seed — har tarif faqat shu tariff_id bo'yicha hech qanday qator yo'q
    // bo'lsa (qayta yurgizishda dublikat yo'q, admin versiyalari saqlanadi).
    for (const tariff of DELIVERY_TARIFF_SEED) {
      await queryRunner.query(
        `
        INSERT INTO "logistics_schema"."delivery_tariffs"
          ("tariff_id", "base_price", "extra_per_kg", "days_min", "days_max", "valid_from")
        SELECT $1::varchar, $2::numeric, $3::numeric, $4::int, $5::int, $6::timestamptz
        WHERE NOT EXISTS (
          SELECT 1 FROM "logistics_schema"."delivery_tariffs" WHERE "tariff_id" = $1::varchar
        )
      `,
        [
          tariff.tariff_id,
          tariff.base_price,
          tariff.extra_per_kg,
          tariff.days_min,
          tariff.days_max,
          DELIVERY_TARIFF_SEED_VALID_FROM,
        ],
      );
    }

    const s = DELIVERY_PRICING_SETTINGS_SEED;
    await queryRunner.query(
      `
      INSERT INTO "logistics_schema"."delivery_pricing_settings"
        ("volumetric_divisor", "first_kg_included", "min_billable_kg",
         "billable_step_kg", "round_to", "pickup_fee", "pickup_free_from_count",
         "express_multiplier")
      SELECT $1::int, $2::numeric, $3::numeric, $4::numeric, $5::int,
             $6::numeric, $7::int, $8::numeric
      WHERE NOT EXISTS (
        SELECT 1 FROM "logistics_schema"."delivery_pricing_settings"
      )
    `,
      [
        s.volumetric_divisor,
        s.first_kg_included,
        s.min_billable_kg,
        s.billable_step_kg,
        s.round_to,
        s.pickup_fee,
        s.pickup_free_from_count,
        s.express_multiplier,
      ],
    );

    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('logistics_schema.regions') IS NULL THEN
          RETURN;
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'logistics_schema'
             AND table_name = 'regions'
             AND column_name = 'is_city_zone'
        ) THEN
          RETURN;
        END IF;

        ALTER TABLE "logistics_schema"."regions"
          ADD COLUMN "is_city_zone" BOOLEAN NOT NULL DEFAULT false;

        UPDATE "logistics_schema"."regions"
           SET "is_city_zone" = true
         WHERE "sato_code" = '1726'
            OR (
              "sato_code" IS NULL
              AND lower(btrim("name")) IN ('toshkent shahri', 'toshkent sh.', 'toshkent sh')
            );
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('logistics_schema.regions') IS NOT NULL THEN
          ALTER TABLE "logistics_schema"."regions" DROP COLUMN IF EXISTS "is_city_zone";
        END IF;
      END
      $$;
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "logistics_schema"."delivery_pricing_settings"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "logistics_schema"."delivery_tariffs"`,
    );
  }
}
