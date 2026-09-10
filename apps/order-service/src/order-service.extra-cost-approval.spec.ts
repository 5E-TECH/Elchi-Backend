import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Cashbox_type, ExpenseProofCondition, Order_status } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';

describe('OrderServiceService extra cost approval flow', () => {
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

  function makeService(options?: {
    marketProofConditions?: ExpenseProofCondition[] | null;
    pendingApproval?: any;
  }) {
    const orderRepo = {
      findOne: jest.fn().mockResolvedValue(order),
      save: jest.fn(async (entity: any) => entity),
    };
    const extraCostApprovalRepo = {
      findOne: jest.fn().mockResolvedValue(options?.pendingApproval ?? null),
      create: jest.fn((entity: any) => entity),
      save: jest.fn(async (entity: any) => ({
        id: entity.id ?? 'approval-1',
        createdAt: new Date('2026-09-10T10:00:00.000Z'),
        updatedAt: new Date('2026-09-10T10:00:00.000Z'),
        isDeleted: false,
        ...entity,
      })),
      find: jest.fn().mockResolvedValue([]),
    };
    const logisticsClient = {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '301' } })),
    };
    const fileClient = {
      send: jest.fn(() => of({ data: { exists: true } })),
    };
    const lookup = {
      getMarketsByIds: jest.fn().mockResolvedValue([
        {
          id: '501',
          tariff_center: 45000,
          tariff_home: 70000,
          expense_proof_conditions: options?.marketProofConditions ?? [],
        },
      ]),
      getCouriersByIds: jest.fn().mockResolvedValue([
        {
          id: '301',
          tariff_center: 30000,
          tariff_home: 50000,
          can_add_extra_cost: true,
        },
      ]),
      getUserById: jest.fn().mockResolvedValue({
        id: '201',
        branch_id: '77',
        can_add_extra_cost: true,
        tariff_center: 0,
        tariff_home: 0,
      }),
      getCashboxByUser: jest.fn(async (_id: string, type: Cashbox_type) => ({
        id: `${type}-cashbox`,
        balance: 0,
      })),
      resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
      getBranchAssignmentByUser: jest
        .fn()
        .mockResolvedValue({ branch_id: '77' }),
      getBranchUsers: jest.fn().mockResolvedValue([]),
      getHqBranchId: jest.fn().mockResolvedValue('1'),
      getIntegrationById: jest.fn().mockResolvedValue(null),
      getDefaultDistrictId: jest.fn().mockResolvedValue(null),
      resolveDistrictId: jest.fn().mockResolvedValue(null),
    };

    const service = new OrderLifecycleService(
      {} as any,
      orderRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      extraCostApprovalRepo as any,
      {} as any,
      {} as any,
      logisticsClient as any,
      {} as any,
      {} as any,
      {} as any,
      fileClient as any,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      lookup as any,
      {} as any,
    );

    return { service, orderRepo, extraCostApprovalRepo, fileClient };
  }

  async function expectRpc(promise: Promise<unknown>, code: number) {
    try {
      await promise;
      throw new Error('expected RpcException');
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      expect(((error as RpcException).getError() as any)?.statusCode).toBe(
        code,
      );
    }
  }

  it('proof OFF bo‘lsa ham sell extra cost market approval kutadi', async () => {
    const { service, extraCostApprovalRepo, orderRepo } = makeService();

    const res: any = await service.sellOrder(
      { id: '301', roles: ['courier'], branch_id: '77' },
      '7001',
      { extraCost: 12000, comment: 'Yo‘l xarajati' },
      'manual-sell-extra-cost',
    );

    expect(res.statusCode).toBe(202);
    expect(res.data.approval_required).toBe(true);
    expect(extraCostApprovalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: '7001',
        market_id: '501',
        requested_by_user_id: '301',
        requested_by_role: 'courier',
        action: 'sell',
        amount: 12000,
        status: 'pending',
      }),
    );
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  it('proof ON bo‘lsa proofsiz extra cost approvalga ham chiqmaydi', async () => {
    const { service, extraCostApprovalRepo } = makeService({
      marketProofConditions: [ExpenseProofCondition.SELL_EXTRA_COST],
    });

    await expectRpc(
      service.sellOrder(
        { id: '301', roles: ['courier'], branch_id: '77' },
        '7001',
        { extraCost: 12000, comment: 'Yo‘l xarajati' },
      ),
      400,
    );
    expect(extraCostApprovalRepo.save).not.toHaveBeenCalled();
  });

  it('proof ON va proof bor bo‘lsa cancel extra cost pending approval yaratadi', async () => {
    const { service, extraCostApprovalRepo, fileClient } = makeService({
      marketProofConditions: [ExpenseProofCondition.CANCEL_EXTRA_COST],
    });

    const res: any = await service.cancelOrder(
      { id: '301', roles: ['courier'], branch_id: '77' },
      '7001',
      {
        extraCost: 15000,
        comment: 'Bekor qilish xarajati',
        proofFileKeys: ['proof/cancel.jpg'],
      },
    );

    expect(res.statusCode).toBe(202);
    expect(fileClient.send).toHaveBeenCalled();
    expect(extraCostApprovalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cancel',
        amount: 15000,
        proof_file_keys: ['proof/cancel.jpg'],
      }),
    );
  });

  it('manager partly-sell extra cost ham approval kutadi', async () => {
    const { service, extraCostApprovalRepo } = makeService();

    const res: any = await service.partlySellOrder(
      { id: '201', roles: ['manager'], branch_id: '77' },
      '7001',
      {
        totalPrice: 180000,
        extraCost: 9000,
        comment: 'Qisman sotildi',
        order_item_info: [{ product_id: 'p-1', quantity: 1 }],
      },
    );

    expect(res.statusCode).toBe(202);
    expect(extraCostApprovalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        requested_by_user_id: '201',
        requested_by_role: 'manager',
        requester_branch_id: '77',
        action: 'partly_sell',
        amount: 9000,
      }),
    );
  });

  it('market approve qilsa asl amal extraCostApproved=true bilan bajariladi', async () => {
    const pendingApproval = {
      id: 'approval-7',
      order_id: '7001',
      market_id: '501',
      requested_by_user_id: '301',
      requested_by_role: 'courier',
      requester_branch_id: '77',
      action: 'sell',
      amount: 12000,
      proof_file_keys: [],
      operation_payload: { extraCost: 12000, comment: 'Yo‘l xarajati' },
      status: 'pending',
      isDeleted: false,
    };
    const { service, extraCostApprovalRepo } = makeService({ pendingApproval });
    const sellSpy = jest
      .spyOn(service, 'sellOrder')
      .mockResolvedValue({ statusCode: 200, data: {}, message: 'Order sold' });

    const res: any = await service.approveExtraCostApproval(
      { id: '501', roles: ['market'] },
      'approval-7',
    );

    expect(res.statusCode).toBe(200);
    expect(sellSpy).toHaveBeenCalledWith(
      { id: '301', roles: ['courier'], branch_id: '77' },
      '7001',
      expect.objectContaining({ extraCost: 12000, extraCostApproved: true }),
      'extra-cost-approval:approval-7',
    );
    expect(extraCostApprovalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'approved',
        decided_by_user_id: '501',
        decided_at: expect.any(Date),
      }),
    );
  });

  it('market reject qilsa amal bajarilmaydi va so‘rov rejected bo‘ladi', async () => {
    const pendingApproval = {
      id: 'approval-8',
      order_id: '7001',
      market_id: '501',
      requested_by_user_id: '301',
      requested_by_role: 'courier',
      requester_branch_id: '77',
      action: 'cancel',
      amount: 15000,
      proof_file_keys: [],
      operation_payload: { extraCost: 15000 },
      status: 'pending',
      isDeleted: false,
    };
    const { service, extraCostApprovalRepo } = makeService({ pendingApproval });
    const cancelSpy = jest.spyOn(service, 'cancelOrder');

    const res: any = await service.rejectExtraCostApproval(
      { id: '501', roles: ['market'] },
      'approval-8',
      { comment: 'Tasdiqlanmadi' },
    );

    expect(res.statusCode).toBe(200);
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(extraCostApprovalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'rejected',
        decision_comment: 'Tasdiqlanmadi',
      }),
    );
  });
});
