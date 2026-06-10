import { OrderServiceService } from './order-service.service';

describe('OrderServiceService filters', () => {
  function setup() {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };

    const orderRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    // OrderServiceService konstruktori — 16 ta pozitsion bog'liqlik.
    const service = new OrderServiceService(
      {} as any, // dataSource
      orderRepo as any, // orderRepo
      {} as any, // orderItemRepo
      {} as any, // orderTrackingRepo
      {} as any, // orderCustodyEventRepo
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
    );

    return { service, qb };
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
});
