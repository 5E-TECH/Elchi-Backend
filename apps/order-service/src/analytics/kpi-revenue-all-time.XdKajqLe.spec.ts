import { Logger } from '@nestjs/common';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * (XdKajqLe) «Barchasi»: `getRevenueStats` va `getFulfillmentStats` `all`
 * bilan — overview bilan AYNI oyna (1970 → endDate, eng so'nggi 366 kunga
 * qisqartiriladi, `applied_range.clamped`).
 */
function makeAnalytics() {
  const qb: Record<string, jest.Mock> = {};
  const whereCalls: Array<[string, unknown]> = [];
  for (const method of [
    'where',
    'andWhere',
    'select',
    'addSelect',
    'groupBy',
    'setParameter',
  ]) {
    qb[method] = jest.fn((sql: string, params?: unknown) => {
      if (method === 'andWhere') whereCalls.push([sql, params]);
      return qb;
    });
  }
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getRawOne = jest.fn().mockResolvedValue({
    delivered_count: '0',
    delivery_ms_total: '0',
    on_time_count: '0',
  });
  const service = new OrderAnalyticsService(
    { createQueryBuilder: jest.fn(() => qb) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, whereCalls };
}

describe('XdKajqLe — revenue/fulfillment all-time', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.useFakeTimers({ now: new Date('2026-10-24T08:00:00.000Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('⭐ revenue all=true — 366 kunlik oyna, applied_range.clamped, requested_* null', async () => {
    const { service } = makeAnalytics();
    const res = (await service.getRevenueStats(
      undefined,
      undefined,
      'monthly',
      undefined,
      true,
    )) as {
      data: unknown[];
      applied_range: Record<string, unknown>;
    };
    expect(res.applied_range).toMatchObject({
      clamped: true,
      requested_from: null,
      requested_to: null,
      max_span_days: 366,
    });
    // 366 kun ≈ 13 oylik band (bo'sh bandlar ham), 1970 dan emas.
    expect(res.data.length).toBeGreaterThanOrEqual(12);
    expect(res.data.length).toBeLessThanOrEqual(14);
  });

  it('revenue all yo`q — eski xulq (bugungi kun, clamped false)', async () => {
    const { service } = makeAnalytics();
    const res = (await service.getRevenueStats()) as {
      data: unknown[];
      applied_range: Record<string, unknown>;
    };
    expect(res.data).toHaveLength(1);
    expect(res.applied_range.clamped).toBe(false);
  });

  it('⭐ fulfillment all=true — oyna 1970 dan emas, oxirgi 366 kun', async () => {
    const { service, whereCalls } = makeAnalytics();
    const res = await service.getFulfillmentStats(
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(res.applied_range).toMatchObject({
      clamped: true,
      requested_from: null,
    });
    const created = whereCalls.find(([sql]) =>
      sql.includes('o.createdAt BETWEEN'),
    )?.[1] as { start: Date; end: Date };
    const spanDays =
      (created.end.getTime() - created.start.getTime()) / 86_400_000;
    expect(spanDays).toBeLessThanOrEqual(366);
    expect(spanDays).toBeGreaterThan(364);
  });
});
