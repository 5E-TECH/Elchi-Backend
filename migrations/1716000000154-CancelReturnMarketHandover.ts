import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * fL79tFbs (BG2) — bekor/qaytgan posilkaning MARKETGA TOPSHIRILISHI buyurtmada
 * saqlanadi (usul va joy), M0EPcJVf (BG3) market «Olganlarim» sana oralig'i
 * shu vaqt bo'yicha.
 *
 * order_schema.orders (hammasi NULL, sukutsiz — jadval qayta yozilmaydi):
 *   - `market_handover_at` timestamptz — topshirilgan payt;
 *   - `market_handover_by` bigint — topshirgan xodim;
 *   - `market_handover_method` varchar(16) — `qr` | `manual` | `no_qr` | `pin`
 *     (CHECK `CHK_orders_market_handover_method`);
 *   - `market_handover_branch_id` bigint — topshirilgan joy (HQ ham filial;
 *     branch_schema — FK yo'q);
 *   - partial indeks `IDX_orders_market_handover` (`market_id`,
 *     `market_handover_at`) WHERE `market_handover_at` IS NOT NULL.
 *
 * BACKFILL (faqat `holder_type = 'MARKET'` va `market_handover_at IS NULL`
 * qatorlar; qayta yurgizish xavfsiz):
 *   - vaqt/xodim — `returned_to_market` ga (F4 dan oldingi topshirishlarda
 *     `closed` ga) o'tgan ENG OXIRGI tracking hodisasidan; ombor qaytishi
 *     (`action = 'warehouse_returned'`) marketga topshirish emas — o'tkazib
 *     yuboriladi;
 *   - usul — faqat aniq bilinsa: qo'lda tasdiq (`cancelled_market_handover_manual`
 *     / `metadata.manual_reason` / izoh «qo'lda tasdiqlanib») → `manual`,
 *     izoh «QR talab qilinmasdan» → `no_qr`, izoh «QR tasdiqi bilan» → `qr`;
 *     boshqasi (masalan eski `mark-returned-to-market` izohi) — NULL;
 *   - joy — MARKET ga yopuvchi eng oxirgi custody hodisasining `from_branch_id`
 *     si; HQ qo'lidan topshirilganda (`from_holder_type = 'HQ'`, filial id'si
 *     yo'q) — `branch_schema.branches` dagi HQ (jadval bo'lmasa — NULL).
 *
 * down(): ustunlar, cheklov va indeks o'chiriladi (topshirish usuli/joyi
 * tracking metadata'sida qoladi).
 *
 * Sxema nomlari konstruktorda (sukut `order_schema` / `branch_schema`) — pg
 * spec alohida sxemalarda yurgizadi.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class CancelReturnMarketHandover1716000000154 implements MigrationInterface {
  name = 'CancelReturnMarketHandover1716000000154';

  private readonly order: string;
  private readonly branch: string;

  constructor(orderSchema = 'order_schema', branchSchema = 'branch_schema') {
    if (!SCHEMA_NAME.test(orderSchema) || !SCHEMA_NAME.test(branchSchema)) {
      throw new Error(
        'CancelReturnMarketHandover1716000000154: noto‘g‘ri sxema nomi',
      );
    }
    this.order = orderSchema;
    this.branch = branchSchema;
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
          ADD COLUMN IF NOT EXISTS "market_handover_at" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "market_handover_by" bigint NULL,
          ADD COLUMN IF NOT EXISTS "market_handover_method" character varying(16) NULL,
          ADD COLUMN IF NOT EXISTS "market_handover_branch_id" bigint NULL;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_orders_market_handover_method'
             AND conrelid = '"${o}"."orders"'::regclass
        ) THEN
          ALTER TABLE "${o}"."orders"
            ADD CONSTRAINT "CHK_orders_market_handover_method"
            CHECK ("market_handover_method" IS NULL
              OR "market_handover_method" IN ('qr', 'manual', 'no_qr', 'pin'));
        END IF;
        CREATE INDEX IF NOT EXISTS "IDX_orders_market_handover"
          ON "${o}"."orders" ("market_id", "market_handover_at")
          WHERE "market_handover_at" IS NOT NULL;
      END
      $$
    `);

    const [tables] = (await queryRunner.query(
      `SELECT to_regclass($1) IS NOT NULL AS "orders",
              to_regclass($2) IS NOT NULL AS "tracking",
              to_regclass($3) IS NOT NULL AS "custody",
              to_regclass($4) IS NOT NULL AS "branches"`,
      [
        `"${o}"."orders"`,
        `"${o}"."order_tracking"`,
        `"${o}"."order_custody_events"`,
        `"${this.branch}"."branches"`,
      ],
    )) as Array<
      Record<'orders' | 'tracking' | 'custody' | 'branches', boolean>
    >;
    if (!tables?.orders || !tables.tracking) return;

    // Vaqt, xodim, usul — oxirgi topshirish hodisasidan.
    await queryRunner.query(`
      WITH ev AS (
        SELECT DISTINCT ON (t."order_id")
               t."order_id", t."created_at", t."changed_by", t."action",
               t."note", t."metadata"
          FROM "${o}"."order_tracking" t
          JOIN "${o}"."orders" ord ON ord."id" = t."order_id"
         WHERE ord."holder_type"::text = 'MARKET'
           AND ord."market_handover_at" IS NULL
           AND t."to_status"::text IN ('returned_to_market', 'closed')
           AND COALESCE(t."action", '') <> 'warehouse_returned'
         ORDER BY t."order_id", t."created_at" DESC
      )
      UPDATE "${o}"."orders" ord
         SET "market_handover_at" = ev."created_at",
             "market_handover_by" = CASE
               WHEN ev."changed_by" ~ '^[0-9]{1,18}$' THEN ev."changed_by"::bigint
             END,
             "market_handover_method" = CASE
               WHEN ev."action" = 'cancelled_market_handover_manual'
                 OR ev."metadata" ->> 'manual_reason' IS NOT NULL
                 OR ev."note" ILIKE '%qo''lda tasdiqlanib%' THEN 'manual'
               WHEN ev."note" ILIKE '%QR talab qilinmasdan%' THEN 'no_qr'
               WHEN ev."note" ILIKE '%QR tasdiqi bilan%' THEN 'qr'
             END
        FROM ev
       WHERE ord."id" = ev."order_id"
         AND ord."market_handover_at" IS NULL
         AND ord."status"::text IN ('returned_to_market', 'closed')
         AND ord."fulfillment_source" IS DISTINCT FROM 'WAREHOUSE'
    `);

    if (!tables.custody) return;
    // Joy — MARKET ga yopuvchi oxirgi custody hodisasi qayerdan bo'lgan.
    const hqSql = tables.branches
      ? `(SELECT b."id" FROM "${this.branch}"."branches" b
           WHERE b."type"::text = 'HQ' AND b."is_deleted" = false
           ORDER BY b."id" LIMIT 1)`
      : 'NULL::bigint';
    await queryRunner.query(`
      WITH ce AS (
        SELECT DISTINCT ON (c."order_id")
               c."order_id", c."from_holder_type", c."from_branch_id"
          FROM "${o}"."order_custody_events" c
          JOIN "${o}"."orders" ord ON ord."id" = c."order_id"
         WHERE c."to_holder_type"::text = 'MARKET'
           AND ord."market_handover_at" IS NOT NULL
           AND ord."market_handover_branch_id" IS NULL
         ORDER BY c."order_id", c."created_at" DESC
      )
      UPDATE "${o}"."orders" ord
         SET "market_handover_branch_id" = COALESCE(
               ce."from_branch_id",
               CASE WHEN ce."from_holder_type"::text = 'HQ' THEN ${hqSql} END
             )
        FROM ce
       WHERE ord."id" = ce."order_id"
         AND ord."market_handover_branch_id" IS NULL
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
        DROP INDEX IF EXISTS "${o}"."IDX_orders_market_handover";
        ALTER TABLE "${o}"."orders"
          DROP CONSTRAINT IF EXISTS "CHK_orders_market_handover_method";
        ALTER TABLE "${o}"."orders"
          DROP COLUMN IF EXISTS "market_handover_branch_id",
          DROP COLUMN IF EXISTS "market_handover_method",
          DROP COLUMN IF EXISTS "market_handover_by",
          DROP COLUMN IF EXISTS "market_handover_at";
      END
      $$
    `);
  }
}
