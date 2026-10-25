import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * zkRab9M2 (BG6) — bekor buyurtmalarni marketga topshirishda QR yonida 6 xonali
 * KOD (PIN). Xodim QR'ni skanerlaydi YOKI marketning ekranidagi kodni yozadi.
 *
 * order_schema.market_cancelled_handover_sessions:
 *   - `pin_hash` varchar(64) NULL — sha256('MCP:' + qr_token_hash + ':' + pin);
 *     ochiq kod saqlanmaydi (eski sessiyalarda NULL — ularga kod yo'q);
 *   - `pin_failed_attempts` smallint NOT NULL DEFAULT 0 — noto'g'ri kod soni
 *     (CHECK >= 0);
 *   - `pin_blocked_at` timestamptz NULL — 5-xato payti: sessiya QR bilan ham,
 *     kod bilan ham ochilmaydi (market yangi QR chiqaradi);
 *   - `authorized_via` varchar(8) NULL — ruxsat qanday ochilgan: `qr` | `pin`
 *     (CHECK). Topshirishda `orders.market_handover_method` va tracking
 *     `metadata.method` shundan (`pin` — BG2 migratsiyasi 155 CHECK'ida bor).
 *
 * Qidiruv `market_id` + oxirgi sessiya bo'yicha — mavjud
 * `IDX_market_cancelled_handover_market_created` yetarli, yangi indeks yo'q.
 * Jadval qayta yozilmaydi (PG 11+: sukutli NOT NULL ustun — faqat metama'lumot).
 *
 * down(): cheklovlar va ustunlar o'chiriladi (kodsiz QR oqimi avvalgidek ishlaydi).
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class MarketCancelledHandoverPin1716000000156 implements MigrationInterface {
  name = 'MarketCancelledHandoverPin1716000000156';

  private readonly schema: string;

  constructor(schema = 'order_schema') {
    if (!SCHEMA_NAME.test(schema)) {
      throw new Error(
        'MarketCancelledHandoverPin1716000000156: noto‘g‘ri sxema nomi',
      );
    }
    this.schema = schema;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const s = this.schema;
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"${s}"."market_cancelled_handover_sessions"') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "${s}"."market_cancelled_handover_sessions"
          ADD COLUMN IF NOT EXISTS "pin_hash" character varying(64) NULL,
          ADD COLUMN IF NOT EXISTS "pin_failed_attempts" smallint NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS "pin_blocked_at" TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS "authorized_via" character varying(8) NULL;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_market_cancelled_handover_authorized_via'
             AND conrelid = '"${s}"."market_cancelled_handover_sessions"'::regclass
        ) THEN
          ALTER TABLE "${s}"."market_cancelled_handover_sessions"
            ADD CONSTRAINT "CHK_market_cancelled_handover_authorized_via"
            CHECK ("authorized_via" IS NULL
              OR "authorized_via" IN ('qr', 'pin'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_market_cancelled_handover_pin_attempts'
             AND conrelid = '"${s}"."market_cancelled_handover_sessions"'::regclass
        ) THEN
          ALTER TABLE "${s}"."market_cancelled_handover_sessions"
            ADD CONSTRAINT "CHK_market_cancelled_handover_pin_attempts"
            CHECK ("pin_failed_attempts" >= 0);
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const s = this.schema;
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"${s}"."market_cancelled_handover_sessions"') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE "${s}"."market_cancelled_handover_sessions"
          DROP CONSTRAINT IF EXISTS "CHK_market_cancelled_handover_pin_attempts",
          DROP CONSTRAINT IF EXISTS "CHK_market_cancelled_handover_authorized_via";
        ALTER TABLE "${s}"."market_cancelled_handover_sessions"
          DROP COLUMN IF EXISTS "authorized_via",
          DROP COLUMN IF EXISTS "pin_blocked_at",
          DROP COLUMN IF EXISTS "pin_failed_attempts",
          DROP COLUMN IF EXISTS "pin_hash";
      END
      $$
    `);
  }
}
