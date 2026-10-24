import { Logger } from '@nestjs/common';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * (l9NNdsCH) overview `lostRevenue` — `cancelled` bilan AYNI to'plamning
 * `total_price` yig'indisi (buyurtma bo'yicha DISTINCT); revenue bandlarida
 * `profit` («Sof foyda» trendi) va `summary.totalProfit`.
 */
function chain(raw: Record<string, unknown>, rows: unknown[] = []) {
  const qb: Record<string, jest.Mock> = {};
  const selects: string[] = [];
  const wheres: Array<[string, unknown]> = [];
  for (const method of [
    'where',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'setParameter',
    'setParameters',
  ]) {
    qb[method] = jest.fn(() => qb);
  }
  qb.andWhere = jest.fn((sql: string, params?: unknown) => {
    wheres.push([sql, params]);
    return qb;
  });
  qb.select = jest.fn((sql: string) => {
    selects.push(sql);
    return qb;
  });
  qb.addSelect = jest.fn((sql: string) => {
    selects.push(sql);
    return qb;
  });
  qb.getRawOne = jest.fn().mockResolvedValue(raw);
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  qb.getQuery = jest.fn(() => 'SELECT 1');
  return { qb, selects, wheres };
}

function make(trackingRaw: Record<string, unknown>) {
  const order = chain({
    count: '10',
    sold_count: '6',
    revenue: '600000',
    profit: '90000',
  });
  const tracking = chain(trackingRaw);
  const custody = chain({});
  const service = new OrderAnalyticsService(
    { createQueryBuilder: jest.fn(() => order.qb) } as never,
    { createQueryBuilder: jest.fn(() => tracking.qb) } as never,
    { createQueryBuilder: jest.fn(() => custody.qb) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, tracking };
}

describe('l9NNdsCH — overview lostRevenue', () => {
  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());

  it('⭐ lostRevenue bekor to`plami summasidan, cancelled bilan bitta so`rovda', async () => {
    const { service, tracking } = make({ count: '3', amount: '450000' });
    const res = await service.getOverviewStats('2026-10-01', '2026-10-24');
    expect(res).toMatchObject({ cancelled: 3, lostRevenue: 450000 });
    expect(tracking.qb.getRawOne).toHaveBeenCalledTimes(1);
    // Buyurtma bo'yicha DISTINCT: takroriy bekor o'tishlari ikki marta qo'shilmaydi.
    const lostSql = tracking.selects.find((sql) => sql.includes('lost'));
    expect(lostSql).toContain('jsonb_object_agg(o.id');
    expect(lostSql).toContain('COALESCE(o.total_price, 0)');
    expect(tracking.selects).toContain('COUNT(DISTINCT t.order_id)');
  });

  it('bekor yo`q (NULL summa) — 0', async () => {
    const { service } = make({ count: '0', amount: null });
    const res = await service.getOverviewStats('2026-10-01', '2026-10-24');
    expect(res).toMatchObject({ cancelled: 0, lostRevenue: 0 });
  });

  it('filial kesimi lostRevenue ga ham qo`llanadi', async () => {
    const { service, tracking } = make({ count: '1', amount: '100' });
    await service.getOverviewStats('2026-10-01', '2026-10-24', '5');
    expect(
      tracking.wheres.some(([, params]) =>
        JSON.stringify(params ?? {}).includes('"analyticsBranchId":"5"'),
      ),
    ).toBe(true);
  });
});

describe('l9NNdsCH — revenue bandlarida profit', () => {
  it('⭐ har band profit + summary.totalProfit', async () => {
    const order = chain({}, [
      {
        period_key: '2026-10-23',
        orders_count: '2',
        revenue: '200000',
        profit: '30000',
      },
      {
        period_key: '2026-10-24',
        orders_count: '1',
        revenue: '100000',
        profit: '-5000',
      },
    ]);
    const service = new OrderAnalyticsService(
      { createQueryBuilder: jest.fn(() => order.qb) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const res = (await service.getRevenueStats(
      '2026-10-23',
      '2026-10-24',
      'daily',
    )) as {
      data: Array<{ period: string; profit: number }>;
      summary: { totalProfit: number };
    };
    expect(res.data.map((b) => [b.period, b.profit])).toEqual([
      ['2026-10-23', 30000],
      ['2026-10-24', -5000],
    ]);
    expect(res.summary.totalProfit).toBe(25000);
    expect(order.selects.some((sql) => sql.includes('o.market_tariff'))).toBe(
      true,
    );
  });
});
