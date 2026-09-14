import { of } from 'rxjs';
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
    // Dedup pre-check (Audit P1-10): default to "no existing share for this
    // period" so calculateProfit creates a fresh row. Override per-test to
    // simulate a re-run that should skip.
    findOne: jest.fn().mockResolvedValue(opts.existingShare ?? null),
    create: jest.fn((dto: any) => dto),
    save: jest.fn(async (row: any) => {
      const saved = { id: `ps${savedRows.length + 1}`, ...row };
      savedRows.push(saved);
      return saved;
    }),
  };
  const activityLog: any = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({
      items: [],
      meta: { page: 1, limit: 50, total: 0, totalPages: 1 },
    }),
    findByEntity: jest.fn().mockResolvedValue([]),
    findByUser: jest.fn().mockResolvedValue([]),
  };
  // Finance klienti: `markProfitPaid` MAIN kassadan pul yechadi (audit M6).
  const financeSent: Array<{ cmd: string; payload: any }> = [];
  const financeClient: any = {
    send: jest.fn((pattern: any, payload: any) => {
      financeSent.push({ cmd: pattern?.cmd, payload });
      return of({ data: {} });
    }),
  };
  const service = new InvestorServiceService(
    investorRepo,
    investmentRepo,
    profitShareRepo,
    activityLog,
    financeClient,
  );
  return { service, profitShareRepo, savedRows, financeSent, financeClient };
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

  it('skips an investor whose profit for the same period already exists (idempotent re-run)', async () => {
    const { service, savedRows } = makeService({
      investors: [{ id: 'inv1' }],
      totals: [{ investor_id: 'inv1', total_amount: '1000000' }],
      existingShare: { id: 'ps-existing', investor_id: 'inv1' },
    });

    const res = (await service.calculateProfit({
      ...period,
      percentage: 10,
    } as never)) as { data?: { calculated_count?: number; skipped_count?: number } };

    // No new obligation created — the re-run is a no-op for this investor.
    expect(savedRows).toHaveLength(0);
    expect(res?.data?.calculated_count).toBe(0);
    expect(res?.data?.skipped_count).toBe(1);
  });
});

/**
 * AUDIT M6. Investor foydasini to'lash faqat `is_paid` bayrog'ini qo'yardi:
 * MAIN kassa ham, P&L daftari ham tegilmasdi — ya'ni kompaniyadan chiqqan
 * pul hisobotda umuman ko'rinmasdi.
 */
describe('markProfitPaid', () => {
  it('MAIN kassadan pul yechadi va daftarga chiqim yozadi', async () => {
    const { service, profitShareRepo, financeSent } = makeService({});
    profitShareRepo.findOne.mockResolvedValue({
      id: 'ps9',
      investor_id: '42',
      amount: 250000,
      is_paid: false,
      isDeleted: false,
    });

    await service.markProfitPaid('ps9', { id: '1', roles: ['superadmin'] });

    const spend = financeSent.find((m) => m.cmd === 'finance.cashbox.spend');
    expect(spend).toBeDefined();
    expect(spend?.payload).toEqual(
      expect.objectContaining({
        amount: 250000,
        cashbox_type: 'main',
        dedup_epoch: 'investor-profit:ps9',
      }),
    );
    const ledger = financeSent.find(
      (m) => m.cmd === 'finance.financial_balance.record',
    );
    expect(ledger?.payload).toEqual(
      expect.objectContaining({ amount: -250000 }),
    );
  });

  it('allaqachon to`langan qatorni ikkinchi marta yechmaydi', async () => {
    const { service, profitShareRepo, financeSent } = makeService({});
    profitShareRepo.findOne.mockResolvedValue({
      id: 'ps9',
      investor_id: '42',
      amount: 250000,
      is_paid: true,
      isDeleted: false,
    });

    await service.markProfitPaid('ps9', { id: '1', roles: ['superadmin'] });

    expect(financeSent).toHaveLength(0);
  });
});
