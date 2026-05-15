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

    const service = new OrderServiceService(
      orderRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
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
    expect(whereCalls.some((value) => typeof value === 'object' && value !== null)).toBe(true);
    expect(qb.andWhere).toHaveBeenCalledWith('order.source = :source', { source: 'branch' });
  });
});
