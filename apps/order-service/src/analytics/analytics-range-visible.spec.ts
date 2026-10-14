import { Logger } from '@nestjs/common';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * (uN1tjjGu) Analitika oynasi JIM kesilmaydi va "Barchasi" chegarani chetlab
 * o'tmaydi (audit C3, wt8): `all=true` — 1970-01-01 → hozir, eng so'nggi
 * 366 kunga qisqartiriladi va `applied_range` buni aytadi (`clamped: true`,
 * `requested_*: null`). Hamma bo'lak (overview, market/kuryer jadvali,
 * reytinglar) AYNI oynada.
 */
type AppliedRange = {
  requested_from: string | null;
  requested_to: string | null;
  applied_from: string;
  applied_to: string;
  clamped: boolean;
  max_span_days: number;
};

type Window = { start: Date; end: Date; applied_range: AppliedRange };

function makeAnalytics() {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const chain = () => {
    const qb: Record<string, jest.Mock> = {};
    for (const method of [
      'where',
      'select',
      'addSelect',
      'groupBy',
      'innerJoin',
      'leftJoin',
      'setParameters',
      'setParameter',
    ]) {
      qb[method] = jest.fn(() => qb);
    }
    qb.andWhere = jest.fn((sql: string, params?: Record<string, unknown>) => {
      calls.push([sql, params]);
      return qb;
    });
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    qb.getRawOne = jest
      .fn()
      .mockResolvedValue({ count: '0', sold_count: '0', revenue: '0' });
    qb.getCount = jest.fn().mockResolvedValue(0);
    qb.getQuery = jest.fn().mockReturnValue('SELECT 1');
    return qb;
  };
  const repo = { createQueryBuilder: jest.fn(() => chain()) };
  const service = new OrderAnalyticsService(
    repo as never,
    repo as never,
    repo as never,
    {} as never,
    {} as never,
    {} as never,
    {
      getMarketsByIds: jest.fn().mockResolvedValue([]),
      getCouriersByIds: jest.fn().mockResolvedValue([]),
    } as never,
  );
  const ranges = service as unknown as {
    analyticsDateRange: (start?: string, end?: string, all?: boolean) => Window;
    resolveAnalyticsRange: (
      start: string | undefined,
      end: string | undefined,
      all: boolean,
    ) => Window;
  };
  /** Har bir hisobning sana parametrlari (SQL'ga ketgan oyna). */
  const windowParams = () =>
    calls
      .filter(([sql]) => /BETWEEN/.test(sql))
      .map(([sql, params]) => [sql, params]);
  return { service, ranges, calls, windowParams };
}

describe('order analytics applied range (uN1tjjGu)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('aniq so`ralgan kalendar yil 180 kunga jim kesilmaydi', () => {
    const { ranges } = makeAnalytics();
    const range = ranges.analyticsDateRange('2026-01-01', '2026-12-31');
    expect(range.start.toISOString()).toBe('2025-12-31T19:00:00.000Z');
    expect(range.applied_range.clamped).toBe(false);
    expect(range.applied_range.requested_from).toBe('2025-12-31T19:00:00.000Z');
  });

  it('⭐ all=true chegarani chetlab o`tmaydi: eng so`nggi 366 kun, clamped=true, requested_*=null', () => {
    jest.useFakeTimers({ now: new Date('2026-10-12T08:00:00.000Z') });
    const { ranges } = makeAnalytics();
    const range = ranges.resolveAnalyticsRange(undefined, undefined, true);
    expect(range.applied_range).toEqual({
      requested_from: null,
      requested_to: null,
      // 12.10.2025 00:00 Toshkent — butun kundan.
      applied_from: '2025-10-11T19:00:00.000Z',
      applied_to: '2026-10-12T08:00:00.000Z',
      clamped: true,
      max_span_days: 366,
    });
    expect(range.start.toISOString()).toBe(range.applied_range.applied_from);
    expect(range.end.getTime() - range.start.getTime()).toBeLessThanOrEqual(
      366 * 24 * 60 * 60 * 1000,
    );
  });

  it('all=true + analytics-service yuborgan sanalar (market/kuryer/reyting bo`laklari) — AYNI qisqartirilgan oyna', () => {
    jest.useFakeTimers({ now: new Date('2026-10-12T08:00:00.000Z') });
    const { ranges } = makeAnalytics();
    const now = new Date().toISOString();
    const legs = ranges.analyticsDateRange(
      '1969-12-31T19:00:00.000Z',
      now,
      true,
    );
    const overview = ranges.resolveAnalyticsRange(undefined, undefined, true);
    expect(legs.start.toISOString()).toBe('2025-10-11T19:00:00.000Z');
    expect(legs.applied_range.clamped).toBe(true);
    expect(legs.start.getTime()).toBe(overview.start.getTime());
    expect(legs.end.getTime()).toBe(overview.end.getTime());
  });

  it('⭐ TC3: all=true dagi acceptedCount aniq oraliq (qo`llangan oyna) bilan chaqirilgandagiga teng — SQL oynasi aynan bir xil', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-12T08:00:00.000Z') });
    const all = makeAnalytics();
    const allRes = (await all.service.getOverviewStats(
      undefined,
      undefined,
      undefined,
      true,
    )) as { applied_range: AppliedRange; from: number; to: number };

    const explicit = makeAnalytics();
    const explicitRes = (await explicit.service.getOverviewStats(
      allRes.applied_range.applied_from,
      allRes.applied_range.applied_to,
    )) as { applied_range: AppliedRange; from: number; to: number };

    expect(all.windowParams()).toEqual(explicit.windowParams());
    expect(all.windowParams().length).toBeGreaterThanOrEqual(3);
    expect(allRes.from).toBe(explicitRes.from);
    expect(allRes.to).toBe(explicitRes.to);
    expect(explicitRes.applied_range.clamped).toBe(false);
  });

  it('qisqartirilgan oyna butun Toshkent kunidan boshlanadi (1 ms lik grafik bandi yo`q)', () => {
    const { ranges } = makeAnalytics();
    const range = ranges.analyticsDateRange('1970-01-01', '2026-10-12');
    expect(range.start.toISOString()).toBe('2025-10-11T19:00:00.000Z');
    expect(range.applied_range.clamped).toBe(true);
    expect(range.applied_range.requested_from).toBe('1969-12-31T19:00:00.000Z');
  });

  it('kuryer va market dashboardi applied_range qaytaradi', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-12T08:00:00.000Z') });
    const { service } = makeAnalytics();
    jest
      .spyOn(
        service as unknown as { getAllPostsForAnalytics: () => unknown },
        'getAllPostsForAnalytics',
      )
      .mockResolvedValue([]);
    const courier = (await service.getCourierStat(
      '7',
      undefined,
      undefined,
      true,
    )) as { applied_range: AppliedRange };
    expect(courier.applied_range.clamped).toBe(true);
    expect(courier.applied_range.requested_from).toBeNull();

    const market = (await service.getMarketStat(
      '1',
      '2026-10-01',
      '2026-10-09',
    )) as { applied_range: AppliedRange };
    expect(market.applied_range).toEqual({
      requested_from: '2026-09-30T19:00:00.000Z',
      requested_to: '2026-10-09T18:59:59.999Z',
      applied_from: '2026-09-30T19:00:00.000Z',
      applied_to: '2026-10-09T18:59:59.999Z',
      clamped: false,
      max_span_days: 366,
    });
  });
});
