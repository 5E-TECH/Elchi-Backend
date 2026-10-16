import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Cashbox_type, ExpenseProofCondition, Order_status } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

/**
 * w2bDrE3i — market bo'yicha qo'shimcha xarajat darvozasi:
 *   - `extra_cost_enabled === false` → sotuv / bekor / qisman sotuvda
 *     extraCost > 0 — 403 (kuryer/menejer ruxsatidan OLDIN, AND);
 *   - `extra_cost_requires_approval === false` → tasdiqsiz (202 emas);
 *   - isbot (`expense_proof_conditions`) bundan MUSTAQIL — alohida tekshiriladi;
 *   - maydon yo'q (eski identity javobi) → avvalgi xulq (ochiq + tasdiq).
 */
describe('w2bDrE3i — market qo`shimcha xarajat darvozasi', () => {
  const order = {
    id: '7001',
    status: Order_status.WAITING,
    post_id: '9001',
    market_id: '501',
    total_price: 250000,
    where_deliver: 'center',
    branch_id: '77',
    home_branch_id: '77',
    holder_branch_id: '77',
    comment: null,
  } as any;

  const COURIER = { id: '301', roles: ['courier'], branch_id: '77' };
  const MANAGER = { id: '201', roles: ['manager'], branch_id: '77' };

  function makeService(market: Record<string, unknown>) {
    const extraCostApprovalRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((entity: any) => entity),
      save: jest.fn((entity: any) => ({
        id: 'approval-1',
        createdAt: new Date('2026-10-16T10:00:00.000Z'),
        updatedAt: new Date('2026-10-16T10:00:00.000Z'),
        isDeleted: false,
        ...entity,
      })),
    };
    const lookup = {
      getMarketsByIds: jest.fn().mockResolvedValue([
        {
          id: '501',
          tariff_center: 45000,
          tariff_home: 70000,
          expense_proof_conditions: [],
          ...market,
        },
      ]),
      getCouriersByIds: jest.fn().mockResolvedValue([
        {
          id: '301',
          tariff_center: 30000,
          tariff_home: 50000,
          can_add_extra_cost: true,
          can_sell_cancel: true,
        },
      ]),
      getUserById: jest.fn().mockResolvedValue({
        id: '201',
        branch_id: '77',
        can_add_extra_cost: true,
        can_sell_cancel: true,
        tariff_center: 0,
        tariff_home: 0,
      }),
      getCashboxByUser: jest.fn((_id: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-cashbox`, balance: 0 }),
      ),
      resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
      getBranchAssignmentByUser: jest
        .fn()
        .mockResolvedValue({ branch_id: '77' }),
      getBranchUsers: jest.fn().mockResolvedValue([]),
      getHqBranchId: jest.fn().mockResolvedValue('1'),
    };
    const service = new OrderLifecycleService(
      {} as any,
      { findOne: jest.fn().mockResolvedValue(order) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      extraCostApprovalRepo as any,
      {} as any,
      {} as any,
      {
        send: jest.fn(() => of({ data: { id: '9001', courier_id: '301' } })),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      { send: jest.fn(() => of({ data: { exists: true } })) } as any,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      lookup as any,
      {} as any,
    );
    return { service, extraCostApprovalRepo };
  }

  const rpcError = async (promise: Promise<unknown>) => {
    const error: unknown = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode?: number;
      message?: string;
    };
  };

  describe('extra_cost_enabled = false', () => {
    it('⭐ TC3: sotuvda extraCost → 403, tasdiq so`rovi ham yaratilmaydi', async () => {
      const { service, extraCostApprovalRepo } = makeService({
        extra_cost_enabled: false,
      });
      expect(
        await rpcError(
          service.sellOrder(COURIER, '7001', { extraCost: 12000 }),
        ),
      ).toMatchObject({
        statusCode: 403,
        message: expect.stringMatching(/yopiq/),
      });
      expect(extraCostApprovalRepo.save).not.toHaveBeenCalled();
    });

    it('⭐ TC3: bekor qilishda extraCost → 403', async () => {
      const { service } = makeService({ extra_cost_enabled: false });
      expect(
        await rpcError(
          service.cancelOrder(COURIER, '7001', {
            extraCost: 15000,
            comment: 'Bekor',
          }),
        ),
      ).toMatchObject({ statusCode: 403 });
    });

    it('⭐ TC3: qisman sotuvda extraCost → 403 (menejer ruxsati bo`lsa ham — AND)', async () => {
      const { service } = makeService({ extra_cost_enabled: false });
      expect(
        await rpcError(
          service.partlySellOrder(MANAGER, '7001', {
            totalPrice: 180000,
            extraCost: 9000,
            order_item_info: [{ product_id: 'p-1', quantity: 1 }] as never,
          }),
        ),
      ).toMatchObject({ statusCode: 403 });
    });
  });

  describe('extra_cost_requires_approval', () => {
    it('⭐ TC4: true — avvalgidek market tasdig`i (202)', async () => {
      const { service, extraCostApprovalRepo } = makeService({
        extra_cost_enabled: true,
        extra_cost_requires_approval: true,
      });
      const res: any = await service.sellOrder(COURIER, '7001', {
        extraCost: 12000,
      });
      expect(res.statusCode).toBe(202);
      expect(extraCostApprovalRepo.save).toHaveBeenCalled();
    });

    it('⭐ TC4: false — tasdiqsiz (tasdiq so`rovi yaratilmaydi, null qaytadi)', async () => {
      const { service, extraCostApprovalRepo } = makeService({
        extra_cost_enabled: true,
        extra_cost_requires_approval: false,
      });
      const result = await (service as any).requestExtraCostApprovalIfNeeded({
        order,
        requester: COURIER,
        action: 'sell',
        extraCost: 12000,
        proofFiles: [],
        dto: { extraCost: 12000 },
        market: { extra_cost_requires_approval: false },
      });
      expect(result).toBeNull();
      expect(extraCostApprovalRepo.save).not.toHaveBeenCalled();
    });

    it('⭐ TC5: tasdiqsiz bo`lsa ham isbot ALOHIDA talab qilinadi (expense_proof_conditions)', async () => {
      const { service, extraCostApprovalRepo } = makeService({
        extra_cost_enabled: true,
        extra_cost_requires_approval: false,
        expense_proof_conditions: [ExpenseProofCondition.SELL_EXTRA_COST],
      });
      expect(
        await rpcError(
          service.sellOrder(COURIER, '7001', { extraCost: 12000 }),
        ),
      ).toMatchObject({ statusCode: 400 });
      expect(extraCostApprovalRepo.save).not.toHaveBeenCalled();
    });
  });

  it('⭐ TC6 ortga-moslik: maydonlar yo`q (eski identity javobi) — ochiq + tasdiq (202)', async () => {
    const { service } = makeService({});
    const res: any = await service.sellOrder(COURIER, '7001', {
      extraCost: 12000,
    });
    expect(res.statusCode).toBe(202);
  });
});
