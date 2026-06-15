import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add a terminal MARKET value to the order holder-type enum so a returned /
 * cancelled-and-returned parcel can be attributed back to the market instead of
 * being left with a stale COURIER/BRANCH holder. The custody-event columns
 * (from_holder_type / to_holder_type) reuse the SAME `orders_holder_type_enum`,
 * so a single ADD VALUE covers orders.holder_type and order_custody_events.
 * (Audit I10.)
 */
export class AddMarketHolderType1716000000010 implements MigrationInterface {
  name = 'AddMarketHolderType1716000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = 'order_schema';
    // Resolve the actual enum type bound to orders.holder_type (robust against
    // any naming drift) and add 'MARKET' only if it is missing.
    await queryRunner.query(`
      DO $$
      DECLARE holder_enum regtype;
      BEGIN
        SELECT a.atttypid::regtype
        INTO holder_enum
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${schema}'
          AND c.relname = 'orders'
          AND a.attname = 'holder_type'
          AND a.attnum > 0
          AND NOT a.attisdropped
        LIMIT 1;

        IF holder_enum IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_enum e
            WHERE e.enumtypid = holder_enum
              AND e.enumlabel = 'MARKET'
          ) THEN
            EXECUTE format('ALTER TYPE %s ADD VALUE %L', holder_enum, 'MARKET');
          END IF;
        END IF;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // No-op: removing a Postgres enum value is unsafe (rows may reference it).
  }
}
