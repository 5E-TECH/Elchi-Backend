import { Logger } from '@nestjs/common';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * (6CYRjoZG) `order.analytics.revenue` `branch_id` bilan — filial kesimi
 * (`applyAnalyticsBranchScope`: branch_id / holder_branch_id / custody).
 * `branch_id` yo'q — eski xulq (butun kompaniya).
 */
function makeAnalytics(rows: Array<Record<string, string>>) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'where',
    'andWhere',
    'select',
    'addSelect',
    'groupBy',
  ]) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  const custodyQb: Record<string, jest.Mock> = {};
  for (const method of ['select', 'where', 'andWhere']) {
    custodyQb[method] = jest.fn(() => custodyQb);
  }
  custodyQb.getQuery = jest.fn(() => 'SELECT 1 FROM custody');
  const service = new OrderAnalyticsService(
    { createQueryBuilder: jest.fn(() => qb) } as never,
    {} as never,
    { createQueryBuilder: jest.fn(() => custodyQb) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, qb };
}

const branchScopeCalls = (qb: Record<string, jest.Mock>) =>
  (qb.andWhere.mock.calls as Array<[string, unknown]>).filter(([sql]) =>
    String(sql).includes(':analyticsBranchId'),
  );

describe('6CYRjoZG — revenue filial kesimi', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('⭐ branch_id berilsa — filial sharti qo`shiladi, bandlar qaytadi', async () => {
    const { service, qb } = makeAnalytics([
      { period_key: '2026-10-23', orders_count: '2', revenue: '200000' },
    ]);
    const res = (await service.getRevenueStats(
      '2026-10-23',
      '2026-10-24',
      'daily',
      '5',
    )) as {
      data: Array<{ revenue: number }>;
      summary: { totalRevenue: number };
    };
    const scope = branchScopeCalls(qb);
    expect(scope).toHaveLength(1);
    expect(scope[0][1]).toEqual({ analyticsBranchId: '5' });
    expect(res.data).toHaveLength(2);
    expect(res.summary.totalRevenue).toBe(200000);
  });

  it('branch_id yo`q — filial sharti YO`Q (eski xulq)', async () => {
    const { service, qb } = makeAnalytics([]);
    await service.getRevenueStats('2026-10-23', '2026-10-24', 'daily');
    expect(branchScopeCalls(qb)).toHaveLength(0);
  });
});
