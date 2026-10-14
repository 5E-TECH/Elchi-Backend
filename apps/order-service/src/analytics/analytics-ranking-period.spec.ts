import { BranchType } from '@app/common';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * (PQt3n1N0, 9zbSDkUI) Top marketlar / kuryerlar / filiallar reytingi
 * TANLANGAN davr bo'yicha hisoblanadi, qattiq `>= 30` chegarasi yo'q
 * (sukut `min_orders = 1`), bo'sh holat sababi va davr meta'da.
 */
describe('analytics rankings respect selected range (PQt3n1N0)', () => {
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
    getMarketsByIds: jest.fn().mockResolvedValue([
      { id: '4', name: 'Small market' },
      { id: '5', name: 'Big market' },
    ]),
    getCouriersByIds: jest.fn().mockResolvedValue([{ id: '77', name: 'Ali' }]),
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

  it('⭐ TC3: 5 buyurtmali market reytingga tushadi, meta chegarani va davrni aytadi', async () => {
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
    expect(result).toEqual({
      min_orders: 1,
      filtered_out: 0,
      from: '2026-08-31T19:00:00.000Z',
      to: '2026-09-18T18:59:59.999Z',
      items: [expect.objectContaining({ market_id: '4', total_orders: 5 })],
    });
  });

  it('chegara parametri ishlaydi: min_orders ostidagilar filtered_out da sanaladi', async () => {
    qb.getRawMany.mockResolvedValue([
      { market_id: '4', total_orders: '5', successful_orders: '5' },
      { market_id: '5', total_orders: '59', successful_orders: '50' },
    ]);
    const result = (await service.getTopMarkets(
      10,
      undefined,
      '2026-09-01',
      '2026-09-18',
      30,
      true,
    )) as { items: Array<{ market_id: string }>; filtered_out: number };
    expect(result.items.map((row) => row.market_id)).toEqual(['5']);
    expect(result.filtered_out).toBe(1);
  });

  it('teng ulushda ko`proq buyurtmali market oldinda (1 buyurtmali 100% emas)', async () => {
    qb.getRawMany.mockResolvedValue([
      { market_id: '4', total_orders: '1', successful_orders: '1' },
      { market_id: '5', total_orders: '59', successful_orders: '59' },
    ]);
    const result = (await service.getTopMarkets(
      10,
      undefined,
      '2026-09-01',
      '2026-09-18',
    )) as Array<{ market_id: string }>;
    expect(result.map((row) => row.market_id)).toEqual(['5', '4']);
  });

  it('⭐ TC1: top_couriers tanlangan sanalarni SQL ga uzatadi (oxirgi 30 kun EMAS)', async () => {
    qb.getRawMany.mockResolvedValue([]);
    const result = await service.getTopCouriers(
      10,
      undefined,
      '2026-01-01',
      '2026-01-31',
      1,
      true,
    );
    expect(andWhere).toHaveBeenCalledWith(
      'o.createdAt BETWEEN :start AND :end',
      {
        start: new Date('2025-12-31T19:00:00.000Z'),
        end: new Date('2026-01-31T18:59:59.999Z'),
      },
    );
    expect(result).toMatchObject({
      items: [],
      from: '2025-12-31T19:00:00.000Z',
      to: '2026-01-31T18:59:59.999Z',
    });
  });

  it('⭐ TC5: topBranches HQ filialini ko`rsatmaydi va uni filtered_out ga ham qo`shmaydi', async () => {
    qb.getRawMany.mockResolvedValue([
      { branch_id: '1', total_orders: '40', successful_orders: '40' },
      { branch_id: '3', total_orders: '6', successful_orders: '5' },
    ]);
    jest
      .spyOn(
        service as unknown as { getBranchesByIds: () => unknown },
        'getBranchesByIds',
      )
      .mockResolvedValue([
        { id: '1', name: 'HQ', type: BranchType.HQ },
        { id: '3', name: 'Samarqand', type: 'BRANCH' },
      ]);
    const result = (await service.getTopBranches(
      10,
      undefined,
      '2026-07-01',
      '2026-09-28',
      1,
      true,
    )) as { items: Array<{ branch_id: string }>; filtered_out: number };
    expect(result.items.map((row) => row.branch_id)).toEqual(['3']);
    expect(result.filtered_out).toBe(0);
  });
});

/**
 * (9zbSDkUI) "Top marketlar / Top filiallar" kunlik va 90 kunlik ko'rinishda
 * qattiq "kamida 30 buyurtma" chegarasi bilan BO'SH qolmaydi; reyting davri
 * meta'da (kartada "qaysi davr" yorlig'i uchun).
 */
describe('9zbSDkUI — reyting kunlik/90 kunlik davrda bo`sh emas', () => {
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
  qb.getRawMany = jest.fn();
  const service = new OrderAnalyticsService(
    { createQueryBuilder: () => qb } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      getMarketsByIds: jest.fn().mockResolvedValue([{ id: '4', name: 'M' }]),
    } as never,
  );

  it('⭐ TC2: 90 kunlik oraliqda 30 dan kam buyurtmali filiallar ham chiqadi', async () => {
    // Jonli holat: 90 kunda birorta filial 30 ga yetmaydi (topBranches = []).
    qb.getRawMany.mockResolvedValue([
      { branch_id: '3', total_orders: '22', successful_orders: '15' },
      { branch_id: '4', total_orders: '9', successful_orders: '8' },
    ]);
    jest
      .spyOn(
        service as unknown as { getBranchesByIds: () => unknown },
        'getBranchesByIds',
      )
      .mockResolvedValue([
        { id: '3', name: 'Samarqand', type: 'BRANCH' },
        { id: '4', name: 'Buxoro', type: 'BRANCH' },
      ]);
    const result = (await service.getTopBranches(
      10,
      undefined,
      '2026-06-21',
      '2026-09-18',
      undefined,
      true,
    )) as { items: Array<{ branch_id: string }>; min_orders: number };
    expect(result.items.map((row) => row.branch_id)).toEqual(['4', '3']);
    expect(result.min_orders).toBe(1);
  });

  it('⭐ TC1/TC3/TC5: "Bugun" (1 kun) — 3 buyurtmali market reytingda, davr meta`da', async () => {
    qb.getRawMany.mockResolvedValue([
      { market_id: '4', total_orders: '3', successful_orders: '2' },
    ]);
    const result = (await service.getTopMarkets(
      10,
      undefined,
      '2026-10-13T19:00:00.000Z',
      '2026-10-14T18:59:59.999Z',
      undefined,
      true,
    )) as {
      items: Array<{ market_id: string }>;
      min_orders: number;
      from: string;
      to: string;
    };
    expect(result.items).toHaveLength(1);
    expect(result.min_orders).toBe(1);
    expect(result.from).toBe('2026-10-13T19:00:00.000Z');
    expect(result.to).toBe('2026-10-14T18:59:59.999Z');
  });
});
