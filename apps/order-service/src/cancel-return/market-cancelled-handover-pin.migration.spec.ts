import { MarketCancelledHandoverPin1716000000156 } from '../../../../migrations/1716000000156-MarketCancelledHandoverPin';

/**
 * zkRab9M2 (BG6) — migratsiya 156: sessiya jadvaliga kod ustunlari (SQL
 * matni tekshiriladi; haqiqiy Postgres'da — `IF NOT EXISTS` / `to_regclass`
 * bilan qayta yurgizish xavfsiz).
 */
describe('MarketCancelledHandoverPin1716000000156 (zkRab9M2)', () => {
  const run = async (direction: 'up' | 'down', schema?: string) => {
    const queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
    const migration = schema
      ? new MarketCancelledHandoverPin1716000000156(schema)
      : new MarketCancelledHandoverPin1716000000156();
    await migration[direction](queryRunner as never);
    return (queryRunner.query.mock.calls as Array<[string]>)
      .map(([sql]) => sql)
      .join('\n');
  };

  it('up(): pin_hash, pin_failed_attempts (NOT NULL DEFAULT 0), pin_blocked_at, authorized_via + CHECK — idempotent', async () => {
    const sql = await run('up');

    expect(sql).toContain(
      `to_regclass('"order_schema"."market_cancelled_handover_sessions"') IS NULL`,
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "pin_hash" character varying\(64\) NULL/,
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "pin_failed_attempts" smallint NOT NULL DEFAULT 0/,
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "pin_blocked_at" TIMESTAMPTZ NULL/,
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "authorized_via" character varying\(8\) NULL/,
    );
    expect(sql).toMatch(
      /CHECK \("authorized_via" IS NULL\s+OR "authorized_via" IN \('qr', 'pin'\)\)/,
    );
    expect(sql).toMatch(/CHECK \("pin_failed_attempts" >= 0\)/);
    // Cheklovlar ikkinchi yurgizishda takror qo'shilmaydi.
    expect(
      sql.match(/IF NOT EXISTS \(\s+SELECT 1 FROM pg_constraint/g),
    ).toHaveLength(2);
    // Ochiq kod ustuni yo'q.
    expect(sql).not.toMatch(/"pin" /);
  });

  it('down(): cheklovlar va ustunlar olib tashlanadi', async () => {
    const sql = await run('down');

    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS "CHK_market_cancelled_handover_authorized_via"',
    );
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS "CHK_market_cancelled_handover_pin_attempts"',
    );
    for (const column of [
      'pin_hash',
      'pin_failed_attempts',
      'pin_blocked_at',
      'authorized_via',
    ]) {
      expect(sql).toContain(`DROP COLUMN IF EXISTS "${column}"`);
    }
  });

  it('sxema nomi tekshiriladi (SQL in`ektsiyasi yo`q)', async () => {
    expect(
      () => new MarketCancelledHandoverPin1716000000156('x"; DROP TABLE y; --'),
    ).toThrow(/noto‘g‘ri sxema nomi/);
    const sql = await run('up', 'mchp_test');
    expect(sql).toContain('"mchp_test"."market_cancelled_handover_sessions"');
    expect(sql).not.toContain('order_schema');
  });
});
