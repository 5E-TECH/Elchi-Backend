import { OrderServiceService } from './order-service.service';
import { SettlementStatus } from '@app/common';
import { OrderSettlement } from './entities/order-settlement.entity';

/**
 * FIFO settlement allocation: a lump-sum payment settles the oldest unsettled
 * orders whole, advances their settlement status, and posts cashbox movements
 * (captured here via the outbox mock). Whole-order allocation — an order is only
 * settled when the remaining lump-sum covers its full leg amount.
 */
describe('OrderServiceService settlement (FIFO)', () => {
  function makeService(rows: Partial<OrderSettlement>[]) {
    // Mutable in-memory settlement rows.
    const store = rows.map((r, i) => ({
      id: String(i + 1),
      status: SettlementStatus.PENDING,
      courier_amount: 0,
      branch_amount: 0,
      market_amount: 0,
      isDeleted: false,
      ...r,
    })) as OrderSettlement[];

    const settlementRepo = {
      find: jest.fn(async (opts: any) => {
        const where = opts?.where ?? {};
        return store
          .filter((row) =>
            Object.entries(where).every(([k, v]) => (row as any)[k] === v),
          )
          .sort((a, b) => Number(a.id) - Number(b.id));
      }),
      update: jest.fn(async (criteria: any, patch: any) => {
        const row = store.find((r) => r.id === criteria.id);
        if (row) Object.assign(row, patch);
        return { affected: row ? 1 : 0 };
      }),
      createQueryBuilder: jest.fn(),
    };

    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn(() => settlementRepo),
      },
    };

    const outbox = { enqueue: jest.fn() };

    const service = new OrderServiceService(
      { createQueryRunner: jest.fn(() => queryRunner) } as any, // dataSource
      {} as any, // orderRepo
      {} as any, // orderItemRepo
      {} as any, // orderTrackingRepo
      {} as any, // orderCustodyEventRepo
      settlementRepo as any, // orderSettlementRepo
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
      outbox as any, // outbox
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

    return { service, store, outbox, settlementRepo };
  }

  it('courier→branch settles oldest orders whole until the lump-sum runs out', async () => {
    const { service, store, outbox } = makeService([
      { order_id: '101', courier_id: '7', courier_amount: 60 },
      { order_id: '102', courier_id: '7', courier_amount: 50 },
      { order_id: '103', courier_id: '7', courier_amount: 40 },
    ]);

    const res: any = await service.settleCourierToBranch(
      { id: '1', roles: ['manager'] },
      { courier_id: '7', amount: 120 },
    );

    // 60 + 50 = 110 settled (whole orders); 40 doesn't fit in remaining 10.
    expect(res.data.settled_order_ids).toEqual(['101', '102']);
    expect(res.data.allocated).toBe(110);
    expect(res.data.leftover).toBe(10);
    expect(store[0].status).toBe(SettlementStatus.COURIER_SETTLED);
    expect(store[1].status).toBe(SettlementStatus.COURIER_SETTLED);
    expect(store[2].status).toBe(SettlementStatus.PENDING);
    // One courier EXPENSE enqueued per settled order.
    expect(outbox.enqueue).toHaveBeenCalledTimes(2);
  });

  it('branch→HQ only advances COURIER_SETTLED orders and posts two legs each', async () => {
    const { service, store, outbox } = makeService([
      {
        order_id: '201',
        branch_id: '10',
        branch_amount: 30,
        status: SettlementStatus.COURIER_SETTLED,
      },
      {
        order_id: '202',
        branch_id: '10',
        branch_amount: 30,
        status: SettlementStatus.PENDING, // not yet courier-settled → skipped
      },
    ]);

    const res: any = await service.settleBranchToHq(
      { id: '1', roles: ['manager'] },
      { branch_id: '10', amount: 100 },
    );

    expect(res.data.settled_order_ids).toEqual(['201']);
    expect(store[0].status).toBe(SettlementStatus.BRANCH_SETTLED);
    // 202 was only PENDING (courier hasn't settled it) → untouched by branch→HQ.
    expect(store[1].status).toBe(SettlementStatus.PENDING);
    // branch EXPENSE + MAIN INCOME for the one settled order.
    expect(outbox.enqueue).toHaveBeenCalledTimes(2);
  });

  it('summarizes open branch receivables and market payables', async () => {
    const { service, settlementRepo } = makeService([]);
    const makeQb = (rows: any[]) => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    });
    const branchQb = makeQb([
      { branch_id: '10', amount: '150000' },
      { branch_id: '11', amount: '50000' },
    ]);
    const marketQb = makeQb([
      { market_id: '20', amount: '120000' },
      { market_id: '21', amount: '30000' },
    ]);
    settlementRepo.createQueryBuilder
      .mockReturnValueOnce(branchQb)
      .mockReturnValueOnce(marketQb);

    const response: any = await service.getFinancialBalanceSettlementSummary();

    expect(response.data).toEqual({
      branch_receivable: 200000,
      market_payable: 150000,
      branches: [
        { branch_id: '10', amount: 150000 },
        { branch_id: '11', amount: 50000 },
      ],
      markets: [
        { market_id: '20', amount: 120000 },
        { market_id: '21', amount: 30000 },
      ],
    });
    expect(branchQb.andWhere).toHaveBeenCalledWith(
      'settlement.status IN (:...statuses)',
      {
        statuses: [SettlementStatus.PENDING, SettlementStatus.COURIER_SETTLED],
      },
    );
    expect(marketQb.andWhere).toHaveBeenCalledWith(
      'settlement.status IN (:...statuses)',
      {
        statuses: [
          SettlementStatus.PENDING,
          SettlementStatus.COURIER_SETTLED,
          SettlementStatus.BRANCH_SETTLED,
        ],
      },
    );
  });
});
