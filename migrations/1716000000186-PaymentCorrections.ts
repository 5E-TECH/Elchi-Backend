import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T6-BE-1 — kuryerdan olingan / marketga berilgan pulni QAYTARISH yoki
 * summasini TAHRIRLASH (superadmin).
 *
 *  1. `finance_schema.cashbox_history`:
 *     • `transfer_id uuid NULL` + indeks — bitta to'lovning barcha oyoqlari
 *       (kuryer EXPENSE + qabul qiluvchi INCOME [+ click_to_market: MAIN
 *       EXPENSE + market EXPENSE]; marketga to'lov: MAIN + market) bitta
 *       kalit bilan bog'lanadi. Yangi to'lovlar uni o'zi yozadi;
 *     • `reverses_history_id bigint NULL` — teskari qator qaysi oyoqni
 *       qaytargani. UNIQUE partial (`IS NOT NULL AND is_deleted = false`):
 *       bitta oyoq ikki marta qaytarilmaydi (ikki superadmin bir vaqtda).
 *  2. `cashbox_history_source_type_enum` += `payment_reversal`.
 *  3. `finance_schema.payment_corrections` — jurnal: kim, qachon, nega,
 *     qaysi to'lov, qaysi teskari / yangi o'tkazma. `original_transfer_id`
 *     UNIQUE (bir to'lov bir marta tuzatiladi), `idempotency_key` UNIQUE.
 *  4. BACKFILL (oxirgi 365 kun) — eski oyoqlar AYNAN aniqlanadigan bo'lsa
 *     bitta `transfer_id` ga bog'lanadi: bir xil `amount`, `created_by`,
 *     `payment_method`, kontragent, vaqt farqi ≤ 5 s. Har oyoq uchun
 *     juftlik YAGONA bo'lishi shart; noaniq (ikki nomzod) — NULL qoladi
 *     (API `LEGACY_UNLINKED`). Pulga TEGMAYDI: faqat bog'lovchi ustun.
 *  5. Sozlama `payment_correction.window_days` (finance_settings) — qator
 *     yaratilmaydi: yo'q bo'lsa servis 30 kun deb o'qiydi.
 *
 * Qayta yurgizish xavfsiz (IF NOT EXISTS, backfill faqat NULL qatorlarga).
 * ⚠️ `ADD VALUE` tranzaksiyada qo'shiladi, lekin yangi qiymat bu
 * migratsiyada ISHLATILMAYDI (Postgres cheklovi).
 *
 * down(): jadval, ustunlar va indekslar o'chiriladi (enum qiymati qoladi —
 * Postgres qiymatni o'chirishni qo'llamaydi). Teskari qatorlar
 * (`payment_reversal`) kassa tarixida qoladi.
 */
export class PaymentCorrections1716000000186 implements MigrationInterface {
  name = 'PaymentCorrections1716000000186';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ t: historyTable }] = (await queryRunner.query(
      `SELECT to_regclass('finance_schema.cashbox_history') AS t`,
    )) as Array<{ t: string | null }>;
    if (!historyTable) {
      return;
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_enum e
          JOIN pg_type t ON t.oid = e.enumtypid
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'finance_schema'
            AND t.typname = 'cashbox_history_source_type_enum'
            AND e.enumlabel = 'payment_reversal'
        ) THEN
          ALTER TYPE "finance_schema"."cashbox_history_source_type_enum" ADD VALUE 'payment_reversal';
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "finance_schema"."cashbox_history"
        ADD COLUMN IF NOT EXISTS "transfer_id" UUID NULL,
        ADD COLUMN IF NOT EXISTS "reverses_history_id" BIGINT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_CASHBOX_HISTORY_TRANSFER"
        ON "finance_schema"."cashbox_history" ("transfer_id")
        WHERE "transfer_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_CASHBOX_HISTORY_REVERSES"
        ON "finance_schema"."cashbox_history" ("reverses_history_id")
        WHERE "reverses_history_id" IS NOT NULL AND "is_deleted" = false
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "finance_schema"."payment_corrections" (
        "id" BIGSERIAL NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" BOOLEAN NOT NULL DEFAULT false,
        "action" VARCHAR(16) NOT NULL,
        "payment_kind" VARCHAR(32) NOT NULL,
        "original_transfer_id" UUID NOT NULL,
        "root_transfer_id" UUID NOT NULL,
        "reversal_transfer_id" UUID NOT NULL,
        "replacement_transfer_id" UUID NULL,
        "original_amount" NUMERIC(20,2) NOT NULL,
        "new_amount" NUMERIC(20,2) NULL,
        "payment_method" VARCHAR(32) NOT NULL,
        "counterparty_user_id" BIGINT NOT NULL,
        "receiver_cashbox_id" BIGINT NOT NULL,
        "reason" VARCHAR(500) NOT NULL,
        "created_by" BIGINT NOT NULL,
        "idempotency_key" VARCHAR(255) NOT NULL,
        "root_created_at" TIMESTAMPTZ NOT NULL,
        CONSTRAINT "PK_payment_corrections_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_PAYMENT_CORRECTIONS_ACTION"
          CHECK ("action" IN ('reverse', 'edit')),
        CONSTRAINT "CHK_PAYMENT_CORRECTIONS_KIND"
          CHECK ("payment_kind" IN ('courier_payment', 'market_payment')),
        CONSTRAINT "CHK_PAYMENT_CORRECTIONS_EDIT"
          CHECK (
            ("action" = 'reverse' AND "new_amount" IS NULL AND "replacement_transfer_id" IS NULL)
            OR ("action" = 'edit' AND "new_amount" > 0 AND "replacement_transfer_id" IS NOT NULL)
          )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_PAYMENT_CORRECTIONS_ORIGINAL"
        ON "finance_schema"."payment_corrections" ("original_transfer_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_PAYMENT_CORRECTIONS_IDEMPOTENCY"
        ON "finance_schema"."payment_corrections" ("idempotency_key")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PAYMENT_CORRECTIONS_REVERSAL"
        ON "finance_schema"."payment_corrections" ("reversal_transfer_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_PAYMENT_CORRECTIONS_REPLACEMENT"
        ON "finance_schema"."payment_corrections" ("replacement_transfer_id")
        WHERE "replacement_transfer_id" IS NOT NULL
    `);

    await this.backfill(queryRunner);
  }

  /**
   * Eski to'lovlarni bog'lash. Har guruh uchun YAGONA juftlik talab
   * qilinadi (ikki tomondan ham), aks holda oyoqlar NULL qoladi.
   */
  private async backfill(queryRunner: QueryRunner): Promise<void> {
    // Vaqtinchalik jadvallar sessiyaga tegishli — `ON COMMIT DROP` emas:
    // migratsiya tranzaksiyasiz (`--transaction none`) yurgizilsa ham ishlaydi.
    await this.dropBackfillTables(queryRunner);
    // Vaqtinchalik jadval: oyoqlar (365 kun, hali bog'lanmagan).
    await queryRunner.query(`
      CREATE TEMP TABLE "t6_legs" AS
      SELECT h."id", h."createdAt" AS created_at, h."amount",
             h."created_by", h."payment_method"::text AS payment_method,
             h."source_user_id", h."operation_type"::text AS operation_type,
             h."source_type"::text AS source_type,
             cb."cashbox_type"::text AS cashbox_type, cb."user_id" AS cashbox_user_id
        FROM "finance_schema"."cashbox_history" h
        JOIN "finance_schema"."cashboxes" cb ON cb."id" = h."cashbox_id"
       WHERE h."transfer_id" IS NULL
         AND h."is_deleted" = false
         AND h."createdAt" >= now() - interval '365 days'
         AND h."source_type"::text IN ('courier_payment', 'market_payment')
    `);

    // Kuryer oyog'i ↔ qabul qiluvchi (MAIN / BRANCH) oyog'i.
    await queryRunner.query(`
      CREATE TEMP TABLE "t6_courier_pairs" AS
      WITH c AS (
        SELECT * FROM "t6_legs"
         WHERE cashbox_type = 'couriers' AND operation_type = 'expense'
           AND source_type = 'courier_payment'
      ), r AS (
        SELECT * FROM "t6_legs"
         WHERE cashbox_type IN ('main', 'branch') AND operation_type = 'income'
           AND source_type = 'courier_payment'
      ), p AS (
        SELECT c."id" AS courier_leg, r."id" AS receiver_leg,
               c.created_at, c."amount", c."created_by", c.payment_method
          FROM c JOIN r
            ON r."amount" = c."amount"
           AND r."created_by" IS NOT DISTINCT FROM c."created_by"
           AND r.payment_method = c.payment_method
           AND r."source_user_id" IS NOT DISTINCT FROM c."source_user_id"
           AND abs(extract(epoch FROM (r.created_at - c.created_at))) <= 5
      )
      SELECT p.* FROM p
       WHERE (SELECT count(*) FROM p p2 WHERE p2.courier_leg = p.courier_leg) = 1
         AND (SELECT count(*) FROM p p3 WHERE p3.receiver_leg = p.receiver_leg) = 1
    `);

    // Marketga to'lov oyoqlari: MAIN EXPENSE ↔ market EXPENSE.
    await queryRunner.query(`
      CREATE TEMP TABLE "t6_market_pairs" AS
      WITH m AS (
        SELECT * FROM "t6_legs"
         WHERE cashbox_type = 'main' AND operation_type = 'expense'
           AND source_type = 'market_payment'
      ), k AS (
        SELECT * FROM "t6_legs"
         WHERE cashbox_type = 'markets' AND operation_type = 'expense'
           AND source_type = 'market_payment'
      ), p AS (
        SELECT m."id" AS main_leg, k."id" AS market_leg,
               m.created_at, m."amount", m."created_by", m.payment_method
          FROM m JOIN k
            ON k."amount" = m."amount"
           AND k."created_by" IS NOT DISTINCT FROM m."created_by"
           AND k.payment_method = m.payment_method
           AND k."source_user_id" IS NOT DISTINCT FROM m."source_user_id"
           AND k.cashbox_user_id = m."source_user_id"
           AND abs(extract(epoch FROM (k.created_at - m.created_at))) <= 5
      )
      SELECT p.* FROM p
       WHERE (SELECT count(*) FROM p p2 WHERE p2.main_leg = p.main_leg) = 1
         AND (SELECT count(*) FROM p p3 WHERE p3.market_leg = p.market_leg) = 1
    `);

    /**
     * click_to_market: kuryer juftligi + marketga to'lov juftligi (ikkalasi
     * `click_to_market`, bir xil summa / yaratuvchi, ≤ 5 s). Har tomondan
     * yagona bo'lsa — to'rt oyoq bitta guruh. Kuryer juftligi click_to_market
     * bo'lib, market juftligi topilmasa yoki noaniq bo'lsa — HECH NARSA
     * bog'lanmaydi (qisman guruh qaytarilsa pul yarim qaytgan bo'lardi).
     */
    await queryRunner.query(`
      CREATE TEMP TABLE "t6_click_groups" AS
      WITH g AS (
        SELECT cp.courier_leg, cp.receiver_leg, mp.main_leg, mp.market_leg
          FROM "t6_courier_pairs" cp
          JOIN "t6_market_pairs" mp
            ON mp."amount" = cp."amount"
           AND mp."created_by" IS NOT DISTINCT FROM cp."created_by"
           AND mp.payment_method = 'click_to_market'
           AND abs(extract(epoch FROM (mp.created_at - cp.created_at))) <= 5
         WHERE cp.payment_method = 'click_to_market'
      )
      SELECT g.* FROM g
       WHERE (SELECT count(*) FROM g g2 WHERE g2.courier_leg = g.courier_leg) = 1
         AND (SELECT count(*) FROM g g3 WHERE g3.main_leg = g.main_leg) = 1
    `);

    await queryRunner.query(`
      CREATE TEMP TABLE "t6_assign" ("leg_id" BIGINT PRIMARY KEY, "transfer_id" UUID NOT NULL)
    `);
    // 1) click_to_market guruhlari (to'rt oyoq).
    await queryRunner.query(`
      WITH g AS (
        SELECT courier_leg, receiver_leg, main_leg, market_leg,
               md5(random()::text || clock_timestamp()::text || courier_leg::text)::uuid AS tid
          FROM "t6_click_groups"
      )
      INSERT INTO "t6_assign" ("leg_id", "transfer_id")
      SELECT leg, tid FROM g,
        LATERAL (VALUES (courier_leg), (receiver_leg), (main_leg), (market_leg)) v(leg)
      ON CONFLICT ("leg_id") DO NOTHING
    `);
    // 2) Oddiy kuryer to'lovlari (click_to_market emas).
    await queryRunner.query(`
      WITH g AS (
        SELECT courier_leg, receiver_leg,
               md5(random()::text || clock_timestamp()::text || courier_leg::text)::uuid AS tid
          FROM "t6_courier_pairs"
         WHERE payment_method <> 'click_to_market'
      )
      INSERT INTO "t6_assign" ("leg_id", "transfer_id")
      SELECT leg, tid FROM g,
        LATERAL (VALUES (courier_leg), (receiver_leg)) v(leg)
      ON CONFLICT ("leg_id") DO NOTHING
    `);
    // 3) Marketga to'lovlar (click_to_market guruhiga kirmaganlari).
    await queryRunner.query(`
      WITH g AS (
        SELECT main_leg, market_leg,
               md5(random()::text || clock_timestamp()::text || main_leg::text)::uuid AS tid
          FROM "t6_market_pairs"
         WHERE payment_method <> 'click_to_market'
      )
      INSERT INTO "t6_assign" ("leg_id", "transfer_id")
      SELECT leg, tid FROM g,
        LATERAL (VALUES (main_leg), (market_leg)) v(leg)
      ON CONFLICT ("leg_id") DO NOTHING
    `);

    await queryRunner.query(`
      UPDATE "finance_schema"."cashbox_history" h
         SET "transfer_id" = a."transfer_id"
        FROM "t6_assign" a
       WHERE h."id" = a."leg_id"
         AND h."transfer_id" IS NULL
    `);
    await this.dropBackfillTables(queryRunner);
  }

  private async dropBackfillTables(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS pg_temp."t6_assign", pg_temp."t6_click_groups",
        pg_temp."t6_market_pairs", pg_temp."t6_courier_pairs", pg_temp."t6_legs"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "finance_schema"."payment_corrections"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."UQ_CASHBOX_HISTORY_REVERSES"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "finance_schema"."IDX_CASHBOX_HISTORY_TRANSFER"`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('finance_schema.cashbox_history') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "finance_schema"."cashbox_history"
          DROP COLUMN IF EXISTS "reverses_history_id",
          DROP COLUMN IF EXISTS "transfer_id";
      END
      $$
    `);
  }
}
