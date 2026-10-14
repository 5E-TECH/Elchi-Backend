import { Logger } from '@nestjs/common';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * (9QzTsnZB) Daromad grafigi BITTA ORTIQCHA kun bilan boshlanmaydi.
 *
 * Ilgari skelet `periodStart` da `setHours(0,0,0,0)` — SERVER vaqtida
 * (konteyner UTC) kesilardi: Toshkent kuni UTC'da oldingi kunning 19:00 ida
 * boshlangani uchun "Bugun" (18.09) da grafik 17.09 bo'sh ustunidan
 * boshlanardi, `avgRevenue` esa 2 ga bo'linardi. Tuzatish CODE-22 da
 * (`periodStart` → Toshkent devor soati); bu spec kartaning TC'larini va
 * natija server mintaqasiga (TZ) bog'liq emasligini tekshiradi.
 */
type Bucket = {
  period: string;
  label: string;
  ordersCount: number;
  revenue: number;
};
type RevenueResult = {
  data: Bucket[];
  summary: { totalRevenue: number; totalOrders: number; avgRevenue: number };
};

function makeAnalytics(
  rows: Array<{ period_key: string; orders_count: string; revenue: string }>,
) {
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
  return new OrderAnalyticsService(
    { createQueryBuilder: jest.fn(() => qb) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

/**
 * TC5: natija server mintaqasiga bog'liq emas. Jest ishchisida
 * `process.env.TZ` ni test ichida almashtirish ta'sir qilmaydi, shuning
 * uchun fayl turli `TZ` bilan ishga tushiriladi:
 * `TZ=UTC npx jest <fayl>`, `TZ=Asia/Tashkent …`, `TZ=America/New_York …`
 * (hammasi yashil), va pastdagi test mahalliy-vaqt Date metodlari umuman
 * chaqirilmasligini tekshiradi.
 */
async function runInCurrentTz<T>(run: () => Promise<T>): Promise<T[]> {
  return [await run()];
}

describe('9QzTsnZB — daromad grafigida ortiqcha kun yo`q', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('⭐ TC1: "Bugun" (sanasiz va analytics-service ISO oralig`i) → AYNAN 1 band, bugungi Toshkent sanasi', async () => {
    // 18.09 01:00 Toshkent = 17.09 20:00 UTC — UTC kuni hali 17.09.
    jest.useFakeTimers({ now: new Date('2026-09-17T20:00:00.000Z') });
    const results = await runInCurrentTz(async () => {
      const analytics = makeAnalytics([
        { period_key: '2026-09-18', orders_count: '2', revenue: '90000' },
      ]);
      const noDates = (await analytics.getRevenueStats(
        undefined,
        undefined,
        'daily',
      )) as RevenueResult;
      const isoToday = (await analytics.getRevenueStats(
        '2026-09-17T19:00:00.000Z',
        '2026-09-18T18:59:59.999Z',
        'daily',
      )) as RevenueResult;
      return { noDates, isoToday };
    });

    for (const { noDates, isoToday } of results) {
      for (const res of [noDates, isoToday]) {
        expect(res.data).toHaveLength(1);
        expect(res.data[0]).toEqual({
          period: '2026-09-18',
          label: '18.09',
          ordersCount: 2,
          revenue: 90000,
        });
        expect(res.summary.avgRevenue).toBe(90000);
      }
    }
  });

  it('⭐ TC2: 01.09–18.09 → 18 band, birinchisi 2026-09-01 (31.08 EMAS), oxirgisi 2026-09-18', async () => {
    const results = await runInCurrentTz(
      async () =>
        (await makeAnalytics([]).getRevenueStats(
          '2026-09-01',
          '2026-09-18',
          'daily',
        )) as RevenueResult,
    );
    for (const res of results) {
      expect(res.data).toHaveLength(18);
      expect(res.data[0].period).toBe('2026-09-01');
      expect(res.data[0].label).toBe('01.09');
      expect(res.data[17].period).toBe('2026-09-18');
      expect(res.data.map((row) => row.period)).not.toContain('2026-08-31');
    }
  });

  it('⭐ TC3: oylik 01.09–30.09 → faqat bitta band M:2026-09 (bo`sh avgust YO`Q)', async () => {
    const results = await runInCurrentTz(
      async () =>
        (await makeAnalytics([
          { period_key: 'M:2026-09', orders_count: '41', revenue: '166840000' },
        ]).getRevenueStats(
          '2026-09-01',
          '2026-09-30',
          'monthly',
        )) as RevenueResult,
    );
    for (const res of results) {
      expect(res.data.map((row) => row.period)).toEqual(['M:2026-09']);
      expect(res.summary).toEqual({
        totalRevenue: 166840000,
        totalOrders: 41,
        avgRevenue: 166840000,
      });
    }
  });

  it('⭐ TC4: avgRevenue = jami / oraliqdagi HAQIQIY bandlar soni (ortiqcha band hisobga kirmaydi)', async () => {
    const res = (await makeAnalytics([
      { period_key: '2026-09-02', orders_count: '3', revenue: '700000' },
      { period_key: '2026-09-07', orders_count: '1', revenue: '20000' },
    ]).getRevenueStats('2026-09-01', '2026-09-08', 'daily')) as RevenueResult;
    expect(res.data).toHaveLength(8);
    expect(res.summary.totalRevenue).toBe(720000);
    expect(res.summary.avgRevenue).toBe(90000); // 720 000 / 8, 9 emas
  });

  it.each(['daily', 'weekly', 'monthly', 'yearly'])(
    '⭐ TC5: server mintaqasiga bog`liq Date metodlari ishlatilmaydi (%s)',
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
      try {
        await makeAnalytics([]).getRevenueStats(
          '2026-09-01',
          '2026-09-30',
          period,
        );
        await makeAnalytics([]).getRevenueStats(undefined, undefined, period);
        for (const spy of spies) {
          expect(spy).not.toHaveBeenCalled();
        }
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    },
  );
});
