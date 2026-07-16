import { OrderServiceService } from './order-service.service';

describe('OrderServiceService filters', () => {
  function setup() {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };

    const orderRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    const custodyQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getQuery: jest.fn().mockReturnValue('SELECT 1'),
    };
    const orderCustodyEventRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(custodyQb),
    };

    // OrderServiceService konstruktori — 16 ta pozitsion bog'liqlik.
    const service = new OrderServiceService(
      {} as any, // dataSource
      orderRepo as any, // orderRepo
      {} as any, // orderItemRepo
      {} as any, // orderTrackingRepo
      orderCustodyEventRepo as any, // orderCustodyEventRepo
      {} as any, // orderSettlementRepo
      {} as any, // transferBatchRepo
      {} as any, // transferBatchItemRepo
      {} as any, // transferBatchHistoryRepo
      {} as any, // searchClient
      {} as any, // identityClient
      {} as any, // logisticsClient
      {} as any, // catalogClient
      {} as any, // financeClient
      {} as any, // integrationClient
      {} as any, // branchClient
      {} as any, // fileClient
      {} as any, // outbox
      {
        log: jest.fn().mockResolvedValue(undefined),
        logChange: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({
          items: [],
          meta: { page: 1, limit: 50, total: 0, totalPages: 1 },
        }),
        findByEntity: jest.fn().mockResolvedValue([]),
        findByUser: jest.fn().mockResolvedValue([]),
      } as any, // activityLog
    );

    return { service, qb, custodyQb };
  }

  it('filters by source=BRANCH and branch_id/holder_branch_id', async () => {
    const { service, qb } = setup();

    await service.findAll({
      source: 'BRANCH',
      branch_id: '123',
      page: 1,
      limit: 10,
    } as any);

    const whereCalls = qb.andWhere.mock.calls.map((call) => call[0]);
    expect(
      whereCalls.some((value) => typeof value === 'object' && value !== null),
    ).toBe(true);
    expect(qb.andWhere).toHaveBeenCalledWith('order.source = :source', {
      source: 'branch',
    });
  });

  it('filters manager canceled tab to branch-held unassigned orders', async () => {
    const { service, qb } = setup();

    await service.findAll({
      branch_id: '10',
      status: ['cancelled', 'cancelled (sent)'],
      holder_type: 'BRANCH',
      canceled_post_unassigned: true,
      page: 1,
      limit: 10,
    } as any);

    expect(qb.andWhere).toHaveBeenCalledWith('order.status IN (:...statuses)', {
      statuses: ['cancelled', 'cancelled (sent)'],
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.holder_type = :holder_type',
      {
        holder_type: 'BRANCH',
      },
    );
    expect(qb.andWhere).toHaveBeenCalledWith('order.canceled_post_id IS NULL');
  });

  it('filters courier orders by current courier ownership only', async () => {
    const { service, qb } = setup();

    await service.findAll({
      status: ['cancelled'],
      courier_ids: ['77'],
      page: 1,
      limit: 10,
    });

    const courierScope = qb.andWhere.mock.calls.find(
      ([value]) => typeof value === 'object' && value !== null,
    );
    expect(courierScope).toBeDefined();

    const nested = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
    };
    courierScope?.[0]?.whereFactory?.(nested);
    expect(nested.where).toHaveBeenCalledWith(
      'order.courier_id IN (:...courier_ids)',
      { courier_ids: ['77'] },
    );
    expect(nested.orWhere).toHaveBeenCalledWith(
      'order.holder_courier_id IN (:...courier_ids)',
      { courier_ids: ['77'] },
    );
  });

  it('returns all NEW market orders without pagination', async () => {
    const { service, qb } = setup();

    const result = await service.findNewOrdersByMarket('16');

    expect(qb.andWhere).toHaveBeenCalledWith('order.market_id = :market_id', {
      market_id: '16',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('order.status IN (:...statuses)', {
      statuses: ['new'],
    });
    expect(qb.andWhere).toHaveBeenCalledWith('order.current_batch_id IS NULL');
    expect(qb.skip).not.toHaveBeenCalled();
    expect(qb.take).not.toHaveBeenCalled();
    expect(result).toEqual({ data: [], total: 0 });
  });

  it('groups only unassigned CANCELLED orders held by the requested scope', async () => {
    const { service, qb } = setup();

    const result = await service.findCancelledMarkets({
      branch_id: '16',
      holder_type: 'BRANCH' as any,
    });

    expect(qb.andWhere).toHaveBeenCalledWith('order.status IN (:...statuses)', {
      statuses: ['cancelled'],
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.holder_type = :holder_type',
      {
        holder_type: 'BRANCH',
      },
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.holder_branch_id = :branch_id',
      {
        branch_id: '16',
      },
    );
    expect(qb.andWhere).toHaveBeenCalledWith('order.canceled_post_id IS NULL');
    expect(result).toEqual([]);
  });

  it('returns only received CANCELLED orders for a market handover list', async () => {
    const { service, qb } = setup();

    await service.findCancelledOrdersByMarket('16', {
      holder_type: 'HQ' as any,
    });

    expect(qb.andWhere).toHaveBeenCalledWith('order.market_id = :market_id', {
      market_id: '16',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('order.status IN (:...statuses)', {
      statuses: ['cancelled'],
    });
    expect(qb.andWhere).toHaveBeenCalledWith('order.canceled_post_id IS NULL');
  });

  it('credits the full order amount to branch cashbox for manager-direct sales', () => {
    const { service } = setup();

    const amount = (service as any).resolveBranchCashboxSaleAmount(
      1_000_000,
      950_000,
      true,
    );

    expect(amount).toBe(1_000_000);
  });

  it('keeps the existing tariff-adjusted branch amount for courier sales', () => {
    const { service } = setup();

    const amount = (service as any).resolveBranchCashboxSaleAmount(
      1_000_000,
      940_000,
      false,
    );

    expect(amount).toBe(940_000);
  });

  it('always deducts manager tariff from the amount payable to HQ', () => {
    const { service } = setup();

    const managerShare = (service as any).resolveSaleActorShare(
      true,
      { compensation_mode: 'salary_only' },
      50_000,
    );

    expect(managerShare).toBe(50_000);
  });

  it('scopes analytics to branch and includes courier-held branch orders', () => {
    const { service, qb } = setup();

    const result = (service as any).applyAnalyticsBranchScope(qb, '16');

    expect(result).toBe(qb);
    const analyticsScope = qb.andWhere.mock.calls.find(
      ([value]) =>
        typeof value === 'string' && value.includes('analyticsBranchId'),
    );
    expect(analyticsScope?.[0]).toContain(
      'o.branch_id = :analyticsBranchId',
    );
    expect(analyticsScope?.[0]).toContain(
      'o.holder_branch_id = :analyticsBranchId',
    );
    expect(analyticsScope?.[0]).toContain('EXISTS (SELECT 1)');
    expect(analyticsScope?.[1]).toEqual({ analyticsBranchId: '16' });
  });
});
