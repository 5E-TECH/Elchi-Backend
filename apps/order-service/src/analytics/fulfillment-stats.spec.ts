import { Order_status } from '@app/common';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * (mKS1mjNr) `getFulfillmentStats` — bitta SQL agregati (haqiqiy Postgres
 * tekshiruvi: `fulfillment-stats.pg.spec.ts`). Bu yerda: filtrlar eski
 * `order.find_all` tanlovi bilan bir xil, natija SATR kelsa ham raqam.
 */
function makeAnalytics(raw: Record<string, unknown> | undefined) {
  const calls: Array<[string, string, unknown?]> = [];
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'where',
    'andWhere',
    'select',
    'addSelect',
    'setParameter',
  ]) {
    qb[method] = jest.fn((sql: string, params?: unknown) => {
      calls.push([method, sql, params]);
      return qb;
    });
  }
  qb.getRawOne = jest.fn().mockResolvedValue(raw);
  const analytics = new OrderAnalyticsService(
    { createQueryBuilder: jest.fn(() => qb) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { analytics, calls };
}

describe('mKS1mjNr — getFulfillmentStats', () => {
  it('⭐ TC6: Postgres numeric/bigint SATR qaytarsa — raqamlar', async () => {
    const { analytics } = makeAnalytics({
      delivered_count: '41',
      delivery_ms_total: '37026936000',
      on_time_count: '22',
    });
    const res = await analytics.getFulfillmentStats('2026-06-21', '2026-09-18');
    expect(res).toMatchObject({
      deliveredCount: 41,
      deliveryMsTotal: 37026936000,
      onTimeCount: 22,
      slaMs: 24 * 60 * 60 * 1000,
    });
  });

  it('bo`sh natija (undefined/null) — nollar', async () => {
    const { analytics } = makeAnalytics(undefined);
    const res = await analytics.getFulfillmentStats();
    expect(res).toMatchObject({
      deliveredCount: 0,
      deliveryMsTotal: 0,
      onTimeCount: 0,
    });
  });

  it('⭐ TC3/TC7: tanlov eski yo`l bilan bir xil — 4 status, o`chirilmagan, createdAt Toshkent oynasida, farq > 0', async () => {
    const { analytics, calls } = makeAnalytics({});
    await analytics.getFulfillmentStats('2026-10-01', '2026-10-07');

    const where = calls.filter(([method]) =>
      ['where', 'andWhere'].includes(method),
    );
    expect(where).toContainEqual([
      'where',
      'o.isDeleted = :isDeleted',
      { isDeleted: false },
    ]);
    expect(where).toContainEqual([
      'andWhere',
      'o.status IN (:...fulfillmentStatuses)',
      {
        fulfillmentStatuses: [
          Order_status.SOLD,
          Order_status.PAID,
          Order_status.CLOSED,
          Order_status.PARTLY_PAID,
        ],
      },
    ]);
    expect(where).toContainEqual([
      'andWhere',
      'o.createdAt BETWEEN :start AND :end',
      {
        start: new Date('2026-09-30T19:00:00.000Z'),
        end: new Date('2026-10-07T18:59:59.999Z'),
      },
    ]);
    expect(where.map(([, sql]) => sql)).toEqual(
      expect.arrayContaining([
        'o.sold_at IS NOT NULL',
        expect.stringMatching(
          /sold_at::bigint - FLOOR\(EXTRACT\(EPOCH FROM o\.createdAt\) \* 1000\)\) > 0$/,
        ),
      ]),
    );
    // Vaqt mintaqasi SQL'da qayta qo'llanmaydi (qo'shaloq AT TIME ZONE yo'q).
    for (const [, sql] of calls) {
      expect(String(sql)).not.toMatch(/AT TIME ZONE/i);
    }
  });
});
