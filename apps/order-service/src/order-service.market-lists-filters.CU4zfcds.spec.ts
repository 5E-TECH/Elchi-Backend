/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method */
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { OrderServiceService } from './order-service.service';

/**
 * CU4zfcds — market yangi/bekor ro'yxatlari: `search` (market nomi/telefoni)
 * va `start_day`/`end_day` (Toshkent kuni, yaratilgan sana).
 */
describe('CU4zfcds — market ro‘yxatlari search va sana', () => {
  function setup(rows: Array<Record<string, string>> = []) {
    const qb: Record<string, jest.Mock> = {};
    for (const m of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'groupBy',
      'orderBy',
    ]) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn().mockResolvedValue(rows);
    const service: any = Object.create(OrderServiceService.prototype);
    service.orderRepo = { createQueryBuilder: jest.fn(() => qb) };
    service.identityClient = {
      send: jest.fn(() =>
        of({
          data: [
            { id: '37', name: 'TEST market', phone_number: '+998901112233' },
            { id: '16', name: 'Boshqa do‘kon', phone_number: '+998935556677' },
          ],
        }),
      ),
    };
    return { service, qb };
  }

  const ROWS = [
    { market_id: '37', orders_count: '2', total_price_sum: '100' },
    { market_id: '16', orders_count: '1', total_price_sum: '50' },
  ];

  it('findNewMarkets: start_day/end_day — Toshkent kuni chegaralari', async () => {
    const { service, qb } = setup();
    await service.findNewMarkets(undefined, true, {
      start_day: '2026-10-01',
      end_day: '2026-10-02',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('order.createdAt >= :startDate', {
      startDate: new Date('2026-09-30T19:00:00.000Z'),
    });
    const endCall = qb.andWhere.mock.calls.find(
      (c) => c[0] === 'order.createdAt <= :endDate',
    );
    expect(endCall).toBeDefined();
    expect((endCall![1].endDate as Date).toISOString()).toBe(
      '2026-10-02T18:59:59.999Z',
    );
  });

  it('sanasiz — eski so‘rov (createdAt sharti yo‘q)', async () => {
    const { service, qb } = setup();
    await service.findNewMarkets();
    await service.findCancelledMarkets({});
    expect(
      qb.andWhere.mock.calls.some((c) => String(c[0]).includes('createdAt')),
    ).toBe(false);
  });

  it('noto‘g‘ri sana — 400', async () => {
    const { service } = setup();
    await expect(
      service.findCancelledMarkets({ start_day: 'abc' }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('findCancelledMarkets: sana oralig‘i qo‘llanadi', async () => {
    const { service, qb } = setup();
    await service.findCancelledMarkets({ start_day: '2026-10-01' });
    expect(qb.andWhere).toHaveBeenCalledWith('order.createdAt >= :startDate', {
      startDate: new Date('2026-09-30T19:00:00.000Z'),
    });
  });

  it('enriched: search market nomi bo‘yicha (katta-kichik harf farqsiz)', async () => {
    const { service } = setup(ROWS);
    const res: any[] = await service.findNewMarketsEnriched(undefined, true, {
      search: 'test',
    });
    expect(res.map((r) => r.market_id)).toEqual(['37']);
    const all: any[] = await service.findCancelledMarketsEnriched({});
    expect(all).toHaveLength(2);
  });

  it('enriched: search telefon raqami qismi bo‘yicha', async () => {
    const { service } = setup(ROWS);
    const res: any[] = await service.findCancelledMarketsEnriched({
      search: '555 66',
    });
    expect(res.map((r) => r.market_id)).toEqual(['16']);
  });

  it('findNewByMarketEnriched: search — findAllEnriched yo‘li (mijoz/EL- qidiruvi), NEW + partiyasiz', async () => {
    const { service } = setup();
    service.findAllEnriched = jest.fn().mockResolvedValue({
      data: [{ id: '1' }],
      total: 1,
      search_truncated: false,
    });
    const res: any = await service.findNewByMarketEnriched(
      '37',
      undefined,
      true,
      {
        search: 'Ali',
        start_day: '2026-10-01',
      },
    );
    expect(service.findAllEnriched).toHaveBeenCalledWith(
      expect.objectContaining({
        market_id: '37',
        status: 'new',
        unbatched_only: true,
        exclude_sources: ['branch'],
        search: 'Ali',
        start_day: '2026-10-01',
        disable_pagination: true,
      }),
    );
    expect(res).toMatchObject({ data: [{ id: '1' }], total: 1 });
  });

  it('findNewByMarketEnriched: searchsiz — findAll ga sana o‘tadi', async () => {
    const { service } = setup();
    service.findAll = jest.fn().mockResolvedValue({ data: [], total: 0 });
    service.enrichOrders = jest.fn().mockResolvedValue([]);
    await service.findNewByMarketEnriched('37', undefined, false, {
      start_day: '2026-10-01',
      end_day: '2026-10-03',
    });
    expect(service.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        market_id: '37',
        start_day: '2026-10-01',
        end_day: '2026-10-03',
        unbatched_only: true,
      }),
    );
  });
});
