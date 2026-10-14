import { CustomerSegmentService } from './customer-segment.service';

/**
 * ebSV5oyP TC3 — buyurtmalar soni oralig'i "dan–gacha": `max_orders`
 * HAVING `COUNT(*) <= :maxOrders` (min bilan birga ham, yolg'iz ham).
 */
describe('CustomerSegmentService — buyurtmalar soni oralig‘i (ebSV5oyP)', () => {
  let having: Array<[string, Record<string, unknown>]>;

  const make = () => {
    having = [];
    const qb: Record<string, jest.Mock> = {};
    for (const key of [
      'select',
      'addSelect',
      'where',
      'groupBy',
      'andWhere',
      'orderBy',
      'limit',
    ])
      qb[key] = jest.fn(() => qb);
    qb.having = jest.fn((sql: string, params: Record<string, unknown>) => {
      having.push([sql, params]);
      return qb;
    });
    qb.andHaving = qb.having;
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    return new CustomerSegmentService({
      createQueryBuilder: () => qb,
    } as never);
  };

  it('3–10: COUNT(*) >= 3 VA COUNT(*) <= 10', async () => {
    await make().find({ min_orders: 3, max_orders: 10 });
    expect(having).toEqual([
      ['COUNT(*) >= :minOrders', { minOrders: 3 }],
      ['COUNT(*) <= :maxOrders', { maxOrders: 10 }],
    ]);
  });

  it('faqat max_orders — yuqori chegara; yaroqsiz qiymat e’tiborsiz', async () => {
    await make().find({ max_orders: 2 });
    expect(having).toEqual([['COUNT(*) <= :maxOrders', { maxOrders: 2 }]]);
    await make().find({ max_orders: 0 });
    expect(having).toEqual([]);
  });
});
