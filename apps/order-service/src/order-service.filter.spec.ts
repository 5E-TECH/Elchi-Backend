import { OrderServiceService } from './order-service.service';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderAnalyticsService } from './analytics/order-analytics.service';

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
      {
        getHqBranchId: jest.fn().mockResolvedValue('1'),
        getMarketsByIds: jest.fn().mockResolvedValue([]),
        getCouriersByIds: jest.fn().mockResolvedValue([]),
        getUserById: jest.fn().mockResolvedValue(null),
        getCashboxByUser: jest.fn().mockResolvedValue(null),
        resolveBranchShare: jest.fn().mockResolvedValue(0),
        ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
        resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
        getIntegrationById: jest.fn().mockResolvedValue(null),
        getDefaultDistrictId: jest.fn().mockResolvedValue(null),
        resolveDistrictId: jest.fn().mockResolvedValue(null),
      } as any, // lookup (OrderLookupService)
    );

    const lifecycle = new OrderLifecycleService(
      {} as any,
      // dataSource
      orderRepo as any,
      // orderRepo
      {} as any,
      // orderItemRepo
      orderTrackingRepo as any,
      // orderTrackingRepo
      orderCustodyEventRepo as any,
      // orderCustodyEventRepo
      {} as any,
      // transferBatchRepo
      {} as any,
      // searchClient
      {} as any,
      // identityClient
      {} as any,
      // catalogClient
      {} as any,
      // financeClient
      {} as any,
      // integrationClient
      {} as any,
      // branchClient
      {} as any,
      // fileClient
      {} as any,
      // outbox
      {
        log: jest.fn().mockResolvedValue(undefined),
        logChange: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({
          items: [],
          meta: { page: 1, limit: 50, total: 0, totalPages: 1 },
        }),
        findByEntity: jest.fn().mockResolvedValue([]),
        findByUser: jest.fn().mockResolvedValue([]),
      } as any,
      // activityLog
      {
        getHqBranchId: jest.fn().mockResolvedValue('1'),
        getMarketsByIds: jest.fn().mockResolvedValue([]),
        getCouriersByIds: jest.fn().mockResolvedValue([]),
        getUserById: jest.fn().mockResolvedValue(null),
        getCashboxByUser: jest.fn().mockResolvedValue(null),
        resolveBranchShare: jest.fn().mockResolvedValue(0),
        ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
        resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
        getIntegrationById: jest.fn().mockResolvedValue(null),
        getDefaultDistrictId: jest.fn().mockResolvedValue(null),
        resolveDistrictId: jest.fn().mockResolvedValue(null),
      } as any,
      // lookup (OrderLookupService),
    );

    // Read-only analytics methods now live in OrderAnalyticsService; it shares
    // the same order/tracking/custody repo mocks so the scope/count assertions
    // still exercise the real query-building logic.
    const analytics = new OrderAnalyticsService(
      orderRepo as any,
      orderTrackingRepo as any,
      orderCustodyEventRepo as any,
      {} as any, // identityClient
      {} as any, // branchClient
      {} as any, // logisticsClient
      {
        getMarketsByIds: jest.fn().mockResolvedValue([]),
        getCouriersByIds: jest.fn().mockResolvedValue([]),
      } as any, // lookup (OrderLookupService)
    );

    return { service, lifecycle, analytics, qb, trackingQb, custodyQb };
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

  it('filters orders by delivery type', async () => {
    const { service, qb } = setup();

    await service.findAll({
      where_deliver: 'address' as any,
      page: 1,
      limit: 10,
    });

    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.where_deliver = :where_deliver',
      { where_deliver: 'address' },
    );
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
      expect.stringContaining('WHERE courier_history.order_id = "order"."id"'),
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
    const { lifecycle } = setup();

    const amount = (lifecycle as any).resolveBranchCashboxSaleAmount(
      1_000_000,
      950_000,
      true,
    );

    expect(amount).toBe(1_000_000);
  });

  it('keeps the existing tariff-adjusted branch amount for courier sales', () => {
    const { lifecycle } = setup();

    const amount = (lifecycle as any).resolveBranchCashboxSaleAmount(
      1_000_000,
      940_000,
      false,
    );

    expect(amount).toBe(940_000);
  });

  it('always deducts manager tariff from the amount payable to HQ', () => {
    const { lifecycle } = setup();

    const managerShare = (lifecycle as any).resolveSaleActorShare(
      true,
      { compensation_mode: 'salary_only' },
      50_000,
    );

    expect(managerShare).toBe(50_000);
  });

  it('scopes analytics to branch and includes courier-held branch orders', () => {
    const { analytics, qb } = setup();

    const result = (analytics as any).applyAnalyticsBranchScope(qb, '16');

    expect(result).toBe(qb);
    const analyticsScope = qb.andWhere.mock.calls.find(
      ([value]) =>
        typeof value === 'string' && value.includes('analyticsBranchId'),
    );
    expect(analyticsScope?.[0]).toContain('o.branch_id = :analyticsBranchId');
    expect(analyticsScope?.[0]).toContain(
      'o.holder_branch_id = :analyticsBranchId',
    );
    expect(analyticsScope?.[0]).toContain('EXISTS (SELECT 1)');
    expect(analyticsScope?.[1]).toEqual({ analyticsBranchId: '16' });
  });

  it('counts dashboard accepted orders only from branch batch receive events', async () => {
    const { analytics, trackingQb } = setup();
    const range = {
      start: new Date('2026-07-22T19:00:00.000Z'),
      end: new Date('2026-07-23T18:59:59.999Z'),
    };
    trackingQb.getRawOne.mockResolvedValue({ count: '3' });

    const count = await (analytics as any).countBranchBatchAcceptedOrders(
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
    const { analytics, trackingQb } = setup();

    await (analytics as any).countHistoricallyCancelledOrders(
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
    const { analytics, qb } = setup();

    jest
      .spyOn(analytics as any, 'getAllPostsForAnalytics')
      .mockResolvedValue([{ id: 'post-1', courier_id: '77' }]);
    // getCouriersByIds now lives in the injected OrderLookupService mock
    // (returns [] by default), so no local spy is needed.

    await analytics.getCourierStat(
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

  // Audit (unbounded query): getRevenueStats/getMarketStat load individual
  // order rows for the range and aggregate in JS. analyticsDateRange must cap
  // the span so a pathologically-wide range can't pull the whole orders table.
  describe('analytics date-span cap', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const MAX_SPAN = 768 * DAY;

    const revenueSpanMs = (qb: any): number => {
      const call = qb.andWhere.mock.calls.find(
        (c: any[]) =>
          typeof c[0] === 'string' && c[0].includes('o.sold_at BETWEEN'),
      );
      expect(call).toBeDefined();
      const { startMs, endMs } = call[1];
      return Number(endMs) - Number(startMs);
    };

    it('clamps a 30-year revenue range to the max span', async () => {
      const { analytics, qb } = setup();
      await analytics.getRevenueStats('2000-01-01', '2030-01-01', 'monthly');
      const span = revenueSpanMs(qb);
      expect(span).toBeLessThanOrEqual(MAX_SPAN);
      // clamped to (approximately) the cap, not something tiny
      expect(span).toBeGreaterThan(MAX_SPAN - 2 * DAY);
    });

    it('leaves a normal 30-day range untouched', async () => {
      const { analytics, qb } = setup();
      await analytics.getRevenueStats('2026-01-01', '2026-01-31', 'daily');
      const span = revenueSpanMs(qb);
      // ~30 days (end is end-of-day, so a touch over 30*DAY) — well under cap
      expect(span).toBeGreaterThan(29 * DAY);
      expect(span).toBeLessThan(32 * DAY);
    });
  });
});
