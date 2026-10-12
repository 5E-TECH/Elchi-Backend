import { OrderAnalyticsService } from './order-analytics.service';

describe('analytics rankings respect selected range', () => {
  const andWhere = jest.fn();
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'where',
    'andWhere',
    'select',
    'addSelect',
    'setParameter',
    'groupBy',
  ]) {
    qb[method] = jest.fn(() => qb);
  }
  qb.andWhere = andWhere.mockImplementation(() => qb);
  qb.getRawMany = jest.fn();
  const lookup = {
    getMarketsByIds: jest
      .fn()
      .mockResolvedValue([{ id: '4', name: 'Small market' }]),
  };
  const service = new OrderAnalyticsService(
    { createQueryBuilder: () => qb } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    lookup as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes a five-order market and reports the applied threshold', async () => {
    qb.getRawMany.mockResolvedValue([
      { market_id: '4', total_orders: '5', successful_orders: '4' },
    ]);
    const result = await service.getTopMarkets(
      10,
      undefined,
      '2026-09-01',
      '2026-09-18',
      1,
      true,
    );
    expect(result).toMatchObject({
      min_orders: 1,
      filtered_out: 0,
      items: [expect.objectContaining({ market_id: '4', total_orders: 5 })],
    });
  });

  it('passes the selected dates into top-courier SQL', async () => {
    qb.getRawMany.mockResolvedValue([]);
    await service.getTopCouriers(10, undefined, '2026-01-01', '2026-01-31');
    expect(andWhere).toHaveBeenCalledWith(
      'o.createdAt BETWEEN :start AND :end',
      {
        start: new Date('2025-12-31T19:00:00.000Z'),
        end: new Date('2026-01-31T18:59:59.999Z'),
      },
    );
  });
});
