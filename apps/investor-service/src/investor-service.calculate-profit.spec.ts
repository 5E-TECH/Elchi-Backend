import { InvestorServiceService } from './investor-service.service';

/**
 * Focused unit tests for the investor profit-share math (the only money logic
 * in this service). Gives investor-service its first test coverage.
 */
function makeService(opts: {
  investors?: Array<{ id: string }>;
  totals?: Array<{ investor_id: string; total_amount: string }>;
}) {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(opts.totals ?? []),
  };
  const investorRepo: any = {
    find: jest.fn().mockResolvedValue(opts.investors ?? []),
    findOne: jest.fn().mockResolvedValue(opts.investors?.[0] ?? null),
  };
  const investmentRepo: any = { createQueryBuilder: jest.fn(() => qb) };
  const savedRows: any[] = [];
  const profitShareRepo: any = {
    create: jest.fn((dto: any) => dto),
    save: jest.fn(async (row: any) => {
      const saved = { id: `ps${savedRows.length + 1}`, ...row };
      savedRows.push(saved);
      return saved;
    }),
  };
  const service = new InvestorServiceService(
    investorRepo,
    investmentRepo,
    profitShareRepo,
  );
  return { service, profitShareRepo, savedRows };
}

function statusOf(err: unknown): number | undefined {
  const payload = (err as any)?.getError?.();
  return payload?.statusCode;
}

describe('InvestorServiceService.calculateProfit', () => {
  const period = { period_start: '2026-01-01', period_end: '2026-03-31' };

  it('rejects a percentage above 100', async () => {
    const { service } = makeService({});
    await service
      .calculateProfit({ ...period, percentage: 150 } as never)
      .catch((e) => expect(statusOf(e)).toBe(400));
  });

  it('rejects a negative percentage', async () => {
    const { service } = makeService({});
    await service
      .calculateProfit({ ...period, percentage: -5 } as never)
      .catch((e) => expect(statusOf(e)).toBe(400));
  });

  it('rejects period_start after period_end', async () => {
    const { service } = makeService({});
    await service
      .calculateProfit({
        period_start: '2026-03-31',
        period_end: '2026-01-01',
        percentage: 10,
      } as never)
      .catch((e) => expect(statusOf(e)).toBe(400));
  });

  it('computes amount = total_investment * percentage / 100, rounded to 2dp', async () => {
    const { service, savedRows } = makeService({
      investors: [{ id: 'inv1' }],
      totals: [{ investor_id: 'inv1', total_amount: '1000000' }],
    });

    await service.calculateProfit({ ...period, percentage: 10 } as never);

    expect(savedRows).toHaveLength(1);
    expect(savedRows[0].amount).toBe(100000); // 1,000,000 * 10%
    expect(savedRows[0].percentage).toBe(10);
    expect(savedRows[0].is_paid).toBe(false);
  });

  it('rounds half-cent results to 2 decimals', async () => {
    const { service, savedRows } = makeService({
      investors: [{ id: 'inv1' }],
      totals: [{ investor_id: 'inv1', total_amount: '333.333' }],
    });

    await service.calculateProfit({ ...period, percentage: 10 } as never);

    // 333.333 * 0.10 = 33.3333 → toFixed(2) → 33.33
    expect(savedRows[0].amount).toBe(33.33);
  });

  it('assigns zero profit to an investor with no investments', async () => {
    const { service, savedRows } = makeService({
      investors: [{ id: 'inv1' }],
      totals: [], // no investment rows
    });

    await service.calculateProfit({ ...period, percentage: 25 } as never);

    expect(savedRows[0].amount).toBe(0);
  });
});
