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
      getMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(0),
    };

    const orderRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    const trackingQb = {
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ count: '0' }),
    };
    const orderTrackingRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(trackingQb),
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
      orderTrackingRepo as any, // orderTrackingRepo
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

    return { service, qb, trackingQb, custodyQb };
  }

  it('filters by source=BRANCH and branch/home branch scope', async () => {
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
    const whereCalls = qb.andWhere.mock.calls.map((call) => call[0]);
    expect(
      whereCalls.some((value) => typeof value === 'object' && value !== null),
    ).toBe(true);
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
    expect(
      nested.orWhere.mock.calls.some(([value]) =>
        String(value).includes('order_custody_events'),
      ),
    ).toBe(false);
  });

  it('includes courier custody history only when requested', async () => {
    const { service, qb } = setup();

    await service.findAll({
      status: ['cancelled'],
      courier_ids: ['77'],
      include_courier_history: true,
      page: 1,
      limit: 10,
    });

    const courierScope = qb.andWhere.mock.calls.find(
      ([value]) => typeof value === 'object' && value !== null,
    );
    const nested = {
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
    };
    courierScope?.[0]?.whereFactory?.(nested);

    expect(nested.orWhere).toHaveBeenCalledWith(
      expect.stringContaining(
        'FROM "order_schema"."order_custody_events" courier_history',
      ),
      { courier_ids: ['77'] },
    );
    expect(nested.orWhere).toHaveBeenCalledWith(
      expect.stringContaining(
        'WHERE courier_history.order_id = "order"."id"',
      ),
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

  it('counts dashboard accepted orders only from branch batch receive events', async () => {
    const { service, trackingQb } = setup();
    const range = {
      start: new Date('2026-07-22T19:00:00.000Z'),
      end: new Date('2026-07-23T18:59:59.999Z'),
    };
    trackingQb.getRawOne.mockResolvedValue({ count: '3' });

    const count = await (service as any).countBranchBatchAcceptedOrders(
      range,
      '16',
    );

    expect(count).toBe(3);
    expect(trackingQb.andWhere).toHaveBeenCalledWith('t.action = :action', {
      action: 'branch_batch_received',
    });
    expect(trackingQb.andWhere).toHaveBeenCalledWith('t.to_status = :status', {
      status: 'received',
    });
    expect(trackingQb.andWhere).toHaveBeenCalledWith(
      't.created_at BETWEEN :start AND :end',
      range,
    );
  });

  it('excludes courier cancellations from branch dashboard cancelled totals', async () => {
    const { service, trackingQb } = setup();

    await (service as any).countHistoricallyCancelledOrders(
      {
        start: new Date('2026-07-22T19:00:00.000Z'),
        end: new Date('2026-07-23T18:59:59.999Z'),
      },
      '16',
    );

    expect(trackingQb.andWhere).toHaveBeenCalledWith(
      'LOWER(t.changed_by_role) != :courierRole',
      { courierRole: 'courier' },
    );
    expect(trackingQb.andWhere).toHaveBeenCalledWith(
      '(t.action IS NULL OR t.action != :cancelledPostReceived)',
      { cancelledPostReceived: 'cancelled_post_received' },
    );
  });

  it('scopes courier dashboard totals by assignment date instead of update date', async () => {
    const { service, qb } = setup();

    jest
      .spyOn(service as any, 'getAllPostsForAnalytics')
      .mockResolvedValue([{ id: 'post-1', courier_id: '77' }]);
    jest.spyOn(service as any, 'getCouriersByIds').mockResolvedValue([]);

    await service.getCourierStat(
      '77',
      '2026-07-01T00:00:00.000Z',
      '2026-07-31T23:59:59.999Z',
    );

    expect(qb.andWhere).toHaveBeenCalledWith(
      'COALESCE(o.assigned_at, o.createdAt) BETWEEN :start AND :end',
      expect.objectContaining({
        start: expect.any(Date),
        end: expect.any(Date),
      }),
    );
    expect(qb.andWhere).not.toHaveBeenCalledWith(
      'o.updatedAt BETWEEN :start AND :end',
      expect.anything(),
    );
  });
});
