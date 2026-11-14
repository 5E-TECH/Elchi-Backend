import { getMetadataArgsStorage } from 'typeorm';
import { CarrierRollbackToggle1716000000223 } from '../../../../migrations/1716000000223-CarrierRollbackToggle';
import { CarrierAccount } from '../entities/carrier-account.entity';

/**
 * Migratsiya 223 — `carrier_accounts.rollback_enabled` (yashirin rollback
 * toggle'i, egasi 2026-11-14). SQL matni tekshiriladi; haqiqiy Postgres'da —
 * `carrier-rollback-toggle.migration.pg.spec.ts`.
 */
describe('CarrierRollbackToggle1716000000223', () => {
  const run = async (direction: 'up' | 'down') => {
    const queryRunner = { query: jest.fn().mockResolvedValue(undefined) };
    await new CarrierRollbackToggle1716000000223()[direction](
      queryRunner as never,
    );
    return (queryRunner.query.mock.calls as Array<[string]>)
      .map(([sql]) => sql)
      .join('\n');
  };

  it('up(): NOT NULL DEFAULT false (mavjud qatorlar ham o‘chiq), qayta yurgizish xatosiz', async () => {
    const sql = await run('up');
    expect(sql).toContain('"integration_schema"."carrier_accounts"');
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "rollback_enabled" BOOLEAN NOT NULL DEFAULT false/,
    );
    // Backfill UPDATE yo'q — DEFAULT katalog darajasida.
    expect(sql).not.toMatch(/UPDATE/i);
  });

  it('down(): ustun olib tashlanadi (IF EXISTS)', async () => {
    const sql = await run('down');
    expect(sql).toMatch(/DROP COLUMN IF EXISTS "rollback_enabled"/);
  });

  it('entity: rollback_enabled — boolean, sukut false (yangi akkaunt o‘chiq)', () => {
    const column = getMetadataArgsStorage().columns.find(
      (c) =>
        c.target === CarrierAccount && c.propertyName === 'rollback_enabled',
    );
    expect(column?.options).toMatchObject({ type: 'boolean', default: false });
  });
});
