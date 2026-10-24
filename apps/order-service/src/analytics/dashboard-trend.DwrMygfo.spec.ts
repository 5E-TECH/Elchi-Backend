import { Logger } from '@nestjs/common';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * (DwrMygfo) `getDashboardTrend`: oldingi teng davr (overview + yetkazish
 * agregati) va oxirgi 14 kunlik kunlik seriya — bitta RPC.
 */
type Rows = Record<string, Array<Record<string, string>>>;

function chain(rowsByAlias: Rows, log: string[][]) {
  const aliases: string[] = [];
  const wheres: Array<[string, unknown]> = [];
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'where',
    'innerJoin',
    'leftJoin',
    'groupBy',
    'setParameter',
  ]) {
    qb[method] = jest.fn(() => qb);
  }
  qb.andWhere = jest.fn((sql: string, params?: unknown) => {
    wheres.push([sql, params]);
    return qb;
  });
  qb.select = jest.fn((_sql: string, alias?: string) => {
    aliases.length = 0;
    if (alias) aliases.push(alias);
    return qb;
  });
  qb.addSelect = jest.fn((_sql: string, alias?: string) => {
    if (alias) aliases.push(alias);
    return qb;
  });
  qb.getRawMany = jest.fn(() => {
    log.push([...aliases]);
    const key = aliases.find((alias) => rowsByAlias[alias]);
    return Promise.resolve(key ? rowsByAlias[key] : []);
  });
  qb.getQuery = jest.fn(() => 'SELECT 1');
  (qb as unknown as { wheres: typeof wheres }).wheres = wheres;
  return qb;
}

function make(rows: Rows = {}) {
  const log: string[][] = [];
  const created: Array<Record<string, jest.Mock>> = [];
  const repo = {
    createQueryBuilder: jest.fn(() => {
      const qb = chain(rows, log);
      created.push(qb);
      return qb;
    }),
  };
  const service = new OrderAnalyticsService(
    repo as never,
    repo as never,
    repo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const overview = jest.spyOn(service, 'getOverviewStats').mockResolvedValue({
    acceptedCount: 8,
    soldAndPaid: 4,
    cancelled: 2,
    lostRevenue: 50000,
    totalRevenue: 400000,
    profit: 60000,
  } as never);
  const fulfillment = jest
    .spyOn(service, 'getFulfillmentStats')
    .mockResolvedValue({
      deliveredCount: 4,
      deliveryMsTotal: 4 * 3600000,
      onTimeCount: 3,
    } as never);
  return { service, overview, fulfillment, log, created };
}

describe('DwrMygfo — getDashboardTrend', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.useFakeTimers({ now: new Date('2026-10-24T08:00:00.000Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('⭐ 7 kunlik davr → oldingi 7 kun (Toshkent chegaralari), previous qiymatlari', async () => {
    const { service, overview, fulfillment } = make();
    const res = await service.getDashboardTrend({
      startDate: '2026-10-18',
      endDate: '2026-10-24',
    });
    expect(overview).toHaveBeenCalledWith(
      '2026-10-10T19:00:00.000Z',
      '2026-10-17T18:59:59.999Z',
      undefined,
    );
    expect(fulfillment).toHaveBeenCalledWith(
      '2026-10-10T19:00:00.000Z',
      '2026-10-17T18:59:59.999Z',
      undefined,
    );
    expect(res.previous).toEqual({
      from: '2026-10-10T19:00:00.000Z',
      to: '2026-10-17T18:59:59.999Z',
      acceptedCount: 8,
      soldAndPaid: 4,
      cancelled: 2,
      lostRevenue: 50000,
      totalRevenue: 400000,
      profit: 60000,
      deliveredCount: 4,
      deliveryMsTotal: 4 * 3600000,
      onTimeCount: 3,
    });
  });

  it('«Bugun» → oldingi davr = kecha', async () => {
    const { service, overview } = make();
    await service.getDashboardTrend({
      startDate: '2026-10-23T19:00:00.000Z',
      endDate: '2026-10-24T18:59:59.999Z',
    });
    expect(overview).toHaveBeenCalledWith(
      '2026-10-22T19:00:00.000Z',
      '2026-10-23T18:59:59.999Z',
      undefined,
    );
  });

  it('⭐ series: 14 kun (bo`sh kunlar 0), kesimlar kun bo`yicha joylanadi', async () => {
    const { service } = make({
      accepted: [{ day: '2026-10-24', accepted: '5' }],
      sold: [
        { day: '2026-10-23', sold: '2', revenue: '200000', profit: '30000' },
      ],
      cancelled: [{ day: '2026-10-11', cancelled: '1', lost: '70000' }],
      delivered: [
        {
          day: '2026-10-24',
          delivered: '2',
          delivery_ms_total: '7200000',
          on_time: '1',
        },
      ],
    });
    const res = await service.getDashboardTrend({
      startDate: '2026-10-18',
      endDate: '2026-10-24',
    });
    expect(res.series).toHaveLength(14);
    expect(res.series_days).toBe(14);
    expect(res.series[0].date).toBe('2026-10-11');
    expect(res.series[13].date).toBe('2026-10-24');
    expect(res.series[0]).toMatchObject({ cancelled: 1, lostRevenue: 70000 });
    expect(res.series[12]).toMatchObject({
      date: '2026-10-23',
      soldAndPaid: 2,
      totalRevenue: 200000,
      profit: 30000,
      acceptedCount: 0,
    });
    expect(res.series[13]).toMatchObject({
      acceptedCount: 5,
      deliveredCount: 2,
      deliveryMsTotal: 7200000,
      onTimeCount: 1,
    });
    expect(res.series[5]).toEqual({
      date: '2026-10-16',
      acceptedCount: 0,
      soldAndPaid: 0,
      totalRevenue: 0,
      profit: 0,
      cancelled: 0,
      lostRevenue: 0,
      deliveredCount: 0,
      deliveryMsTotal: 0,
      onTimeCount: 0,
    });
  });

  it('⭐ all=true («Barchasi») — previous null, seriya baribir 14 kun', async () => {
    const { service, overview } = make();
    const res = await service.getDashboardTrend({ all: true });
    expect(res.previous).toBeNull();
    expect(overview).not.toHaveBeenCalled();
    expect(res.series).toHaveLength(14);
    expect(res.series[13].date).toBe('2026-10-24');
  });

  it('filial kesimi: previous va seriya so`rovlari branch_id bilan', async () => {
    const { service, overview, created } = make();
    await service.getDashboardTrend({
      startDate: '2026-10-18',
      endDate: '2026-10-24',
      branch_id: '5',
    });
    expect(overview).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      '5',
    );
    const scoped = created.filter((qb) =>
      (qb as unknown as { wheres: Array<[string, unknown]> }).wheres.some(
        ([, params]) =>
          JSON.stringify(params ?? {}).includes('"analyticsBranchId":"5"'),
      ),
    );
    // accepted, sold, cancelled (kuzatuv), yetkazish — 4 ta seriya so'rovi.
    expect(scoped.length).toBe(4);
  });
});
