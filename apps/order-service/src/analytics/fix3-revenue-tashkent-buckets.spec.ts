import { Logger } from '@nestjs/common';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * CODE-22 — daromad grafigining bo'sh bandlari (skelet) TOSHKENT kuni
 * bo'yicha quriladi.
 *
 * Ilgari `periodStart` kunni SERVER vaqtida (`setHours`, konteynerda UTC)
 * kesardi. Toshkent oynasi UTC'da oldingi kunning 19:00 ida boshlangani uchun
 * skelet bitta ORTIQCHA bo'sh bandni (oynadan oldingi kun / hafta / oy / yil)
 * qo'shardi va `avgRevenue` = jami / (n + 1) bo'lib chiqardi. Natija server
 * mintaqasiga bog'liq bo'lmasligi kerak (dasturchi mashinasi Toshkentda, prod
 * konteyner UTC'da): xulq testlari har qanday `TZ` da o'tadi, oxirgi test esa
 * mahalliy-vaqt Date metodlari umuman ishlatilmasligini tekshiradi. Qo'lda:
 * `TZ=UTC npx jest <shu fayl>` va `TZ=America/New_York npx jest <shu fayl>`.
 */
type RevenueRow = {
  period_key: string;
  orders_count: string;
  revenue: string;
};

function makeAnalytics(rows: RevenueRow[] = []) {
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
  const orderRepo = { createQueryBuilder: jest.fn(() => qb) };
  const analytics = new OrderAnalyticsService(
    orderRepo as never,
    {} as never, // orderTrackingRepo
    {} as never, // orderCustodyEventRepo
    {} as never, // identityClient
    {} as never, // branchClient
    {} as never, // logisticsClient
    {} as never, // lookup
  );
  return { analytics, qb };
}

type RevenueResult = {
  data: Array<{
    period: string;
    label: string;
    ordersCount: number;
    revenue: number;
  }>;
  summary: { totalRevenue: number; totalOrders: number; avgRevenue: number };
};

describe('CODE-22 — daromad bandlari Toshkent kuni bo`yicha', () => {
  beforeEach(() => {
    // 180 kunlik chegara ogohlantirishi (yillik oyna) — kutilgan, shovqin.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('⭐ kunlik 01.10–07.10: AYNAN 7 band, oldingi kun (30.09) YO`Q, o`rtacha jami/7', async () => {
    const { analytics } = makeAnalytics([
      // Toshkent 02.10 02:30 dagi sotuv — SQL kaliti Toshkent kuni.
      { period_key: '2026-10-02', orders_count: '3', revenue: '700000' },
      { period_key: '2026-10-07', orders_count: '1', revenue: '0' },
    ]);

    const res = (await analytics.getRevenueStats(
      '2026-10-01',
      '2026-10-07',
      'daily',
    )) as RevenueResult;

    expect(res.data.map((row) => row.period)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]);
    expect(res.data.map((row) => row.label)).toEqual([
      '01.10',
      '02.10',
      '03.10',
      '04.10',
      '05.10',
      '06.10',
      '07.10',
    ]);
    expect(res.data[1]).toEqual({
      period: '2026-10-02',
      label: '02.10',
      ordersCount: 3,
      revenue: 700000,
    });
    expect(res.summary).toEqual({
      totalRevenue: 700000,
      totalOrders: 4,
      avgRevenue: 100000,
    });
  });

  it('haftalik: dushanba 28.09 dan — birinchi band W:2026-09-28 (oldingi hafta YO`Q)', async () => {
    const { analytics } = makeAnalytics();

    const res = (await analytics.getRevenueStats(
      '2026-09-28',
      '2026-10-11',
      'weekly',
    )) as RevenueResult;

    expect(res.data.map((row) => row.period)).toEqual([
      'W:2026-09-28',
      'W:2026-10-05',
    ]);
    expect(res.data.map((row) => row.label)).toEqual([
      '28.09-04.10',
      '05.10-11.10',
    ]);
  });

  it('oylik sentabr–oktabr: M:2026-09 va M:2026-10 (avgust YO`Q)', async () => {
    const { analytics } = makeAnalytics([
      { period_key: 'M:2026-10', orders_count: '2', revenue: '300000' },
    ]);

    const res = (await analytics.getRevenueStats(
      '2026-09-01',
      '2026-10-31',
      'monthly',
    )) as RevenueResult;

    expect(res.data.map((row) => row.period)).toEqual([
      'M:2026-09',
      'M:2026-10',
    ]);
    expect(res.data.map((row) => row.label)).toEqual(['09.2026', '10.2026']);
    expect(res.summary.avgRevenue).toBe(150000);
  });

  it('yillik 2026: bitta Y:2026 band (2025 YO`Q)', async () => {
    const { analytics } = makeAnalytics();

    const res = (await analytics.getRevenueStats(
      '2026-01-01',
      '2026-12-31',
      'yearly',
    )) as RevenueResult;

    expect(res.data.map((row) => row.period)).toEqual(['Y:2026']);
    expect(res.data[0].label).toBe('2026');
  });

  it('SQL oynasi Toshkent chegaralarida (oldingi kun 19:00Z … oxirgi kun 18:59:59.999Z)', async () => {
    const { analytics, qb } = makeAnalytics();

    await analytics.getRevenueStats('2026-10-01', '2026-10-07', 'daily');

    const call = qb.andWhere.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' && c[0].includes('o.sold_at BETWEEN'),
    ) as [string, { startMs: string; endMs: string }];
    expect(new Date(Number(call[1].startMs)).toISOString()).toBe(
      '2026-09-30T19:00:00.000Z',
    );
    expect(new Date(Number(call[1].endMs)).toISOString()).toBe(
      '2026-10-07T18:59:59.999Z',
    );
  });

  it.each(['daily', 'weekly', 'monthly', 'yearly'])(
    'server mintaqasiga bog`liq Date metodlari ishlatilmaydi (%s)',
    async (period) => {
      const localMethods = [
        'setHours',
        'setDate',
        'setMonth',
        'setFullYear',
        'getHours',
        'getDay',
        'getDate',
        'getMonth',
        'getFullYear',
      ] as const;
      const spies = localMethods.map((method) =>
        jest.spyOn(Date.prototype, method),
      );
      const { analytics } = makeAnalytics();

      try {
        await analytics.getRevenueStats('2026-01-01', '2026-03-31', period);
        for (const spy of spies) {
          expect(spy).not.toHaveBeenCalled();
        }
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    },
  );
});
