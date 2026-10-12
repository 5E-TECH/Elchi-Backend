import { QueryRunner } from 'typeorm';
import { ManualFinancialBalanceIdempotency1716000000071 } from '../../../migrations/1716000000071-ManualFinancialBalanceIdempotency';

describe('cSNJN7GP migration 071', () => {
  it('protects non-order ledger keys with a partial unique index', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new ManualFinancialBalanceIdempotency1716000000071();

    await migration.up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('CREATE UNIQUE INDEX IF NOT EXISTS'),
    );
    expect(query.mock.calls[0][0]).toContain('"order_id" IS NULL');
    expect(query.mock.calls[0][0]).toContain('"dedup_key" <>');

    await migration.down({ query } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('DROP INDEX IF EXISTS'),
    );
  });
});
