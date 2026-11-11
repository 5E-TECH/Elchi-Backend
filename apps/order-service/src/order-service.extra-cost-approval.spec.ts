import { RpcException } from '@nestjs/microservices';
import { QueryFailedError } from 'typeorm';
import { of } from 'rxjs';
import { Cashbox_type, ExpenseProofCondition, Order_status } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import {
  extraCostApprovalTable,
  extraCostDataSource,
  extraCostManager,
} from './testing/extra-cost-kit-spec';

/**
 * (SPEC v2) Bu spec ESKI (replay, 202) yo'lni qamraydi. Endi u faqat hamkor
 * buyurtmasida (`external_id`) ochiladi — oddiy buyurtmada E kechiktiriladi
 * (`extra-cost-deferred.spec.ts`). Shuning uchun buyurtma hamkorniki.
 */
describe('OrderServiceService extra cost approval flow', () => {
  const order = {
    id: '7001',
    status: Order_status.WAITING,
    external_id: 'BP-7001',
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
      save: jest.fn((entity: any) => entity),
    };
    // (hwTkXsGi) so'rov buyurtma qulfi ostida, o'z tranzaksiyasida yoziladi.
    const extraCostApprovalRepo = extraCostApprovalTable(
      options?.pendingApproval ? [options.pendingApproval] : [],
    );
    const manager = extraCostManager({
      table: extraCostApprovalRepo,
      orderRepo,
    });
    const dataSource = extraCostDataSource(manager, extraCostApprovalRepo);
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
        Promise.resolve({
          id: `${type}-cashbox`,
          balance: 0,
        }),
      ),
      resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
      getBranchAssignmentByUser: jest
        .fn()
        .mockResolvedValue({ branch_id: '77' }),
      getBranchAssignmentByUserStrict: jest
        .fn()
        .mockResolvedValue({ branch_id: '77' }),
      getBranchUsersStrict: jest.fn().mockResolvedValue([]),
      getHqBranchId: jest.fn().mockResolvedValue('1'),
      getIntegrationById: jest.fn().mockResolvedValue(null),
      getDefaultDistrictId: jest.fn().mockResolvedValue(null),
      resolveDistrictId: jest.fn().mockResolvedValue(null),
    };

    const service = new OrderLifecycleService(
      dataSource as any,
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

    return {
      service,
      orderRepo,
      extraCostApprovalRepo,
      fileClient,
      dataSource,
    };
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

  it.each([
    ['sellOrder', 'sell'],
    ['cancelOrder', 'cancel'],
  ] as const)(
    "iMNLvs06: %s — kasrli extraCost (RMQ, gateway'siz) butun so'mga kesiladi",
    async (method, action) => {
      const { service, extraCostApprovalRepo } = makeService();

      const res: any = await service[method](
        { id: '301', roles: ['courier'], branch_id: '77' },
        '7001',
        { extraCost: 1500.5, comment: 'Yo‘l xarajati' },
      );

      expect(res.statusCode).toBe(202);
      expect(extraCostApprovalRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          amount: 1500,
          operation_payload: expect.objectContaining({ extraCost: 1500 }),
        }),
      );
    },
  );

  it('iMNLvs06: partly-sell — kasrli extraCost butun so‘mga kesiladi', async () => {
    const { service, extraCostApprovalRepo } = makeService();

    await service.partlySellOrder(
      { id: '201', roles: ['manager'], branch_id: '77' },
      '7001',
      {
        totalPrice: 180000,
        extraCost: 9000.99,
        comment: 'Qisman sotildi',
        order_item_info: [{ product_id: 'p-1', quantity: 1 }],
      },
    );

    expect(extraCostApprovalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'partly_sell',
        amount: 9000,
        operation_payload: expect.objectContaining({ extraCost: 9000 }),
      }),
    );
  });

  it('hwTkXsGi: so‘rov buyurtma qulfi ostida yoziladi — buyurtma shu payt «kutilmoqda» emas bo‘lsa 400, so‘rov ochilmaydi', async () => {
    const { service, extraCostApprovalRepo, orderRepo, dataSource } =
      makeService();
    // Darvozadan oldingi o'qish WAITING, qulf ostidagi qayta o'qish — sotilgan.
    orderRepo.findOne
      .mockResolvedValueOnce(order)
      .mockResolvedValue({ ...order, status: Order_status.SOLD });

    await expectRpc(
      service.sellOrder(
        { id: '301', roles: ['courier'], branch_id: '77' },
        '7001',
        { extraCost: 12000, comment: 'Yo‘l xarajati' },
      ),
      400,
    );
    expect(extraCostApprovalRepo.rows).toHaveLength(0);
    expect(dataSource.runner.rollbackTransaction).toHaveBeenCalled();
  });

  it('hwTkXsGi TC9: parallel ikkinchi so‘rov unique indeksga urilsa — 409, qator qo‘shilmaydi', async () => {
    const { service, extraCostApprovalRepo, dataSource } = makeService();
    extraCostApprovalRepo.save.mockRejectedValueOnce(
      new QueryFailedError('INSERT ...', [], {
        code: '23505',
        constraint: 'UQ_ORDER_EXTRA_COST_APPROVAL_PENDING',
      } as never),
    );

    await expect(
      service.sellOrder(
        { id: '301', roles: ['courier'], branch_id: '77' },
        '7001',
        { extraCost: 12000, comment: 'Yo‘l xarajati' },
      ),
    ).rejects.toMatchObject({
      error: {
        statusCode: 409,
        message:
          "Bu buyurtmaga shu payt boshqa qo'shimcha xarajat so'rovi ochildi — qaytadan urinib ko'ring",
      },
    });
    expect(extraCostApprovalRepo.rows).toHaveLength(0);
    expect(dataSource.runner.rollbackTransaction).toHaveBeenCalled();
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

  it('market approve qilsa asl amal qayta ijro qilinadi — «tasdiqlandi» sotuv tranzaksiyasida (hwTkXsGi)', async () => {
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
      expect.objectContaining({ extraCost: 12000 }),
      'extra-cost-approval:approval-7',
      {
        extraCostApproval: {
          id: 'approval-7',
          patch: expect.objectContaining({
            decided_by_user_id: '501',
            decided_at: expect.any(Date),
            auto_approved: false,
          }),
        },
      },
    );
    // Qaror sotuvdan OLDIN alohida yozilmaydi — claim sotuv tranzaksiyasida
    // (`applyExtraCostApprovalsOnExecution`; bu yerda sotuv soxta).
    expect(extraCostApprovalRepo.updates).toEqual([]);
    expect(res.data.approval).toEqual(
      expect.objectContaining({ id: 'approval-7', status: 'approved' }),
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
    expect(extraCostApprovalRepo.updates).toEqual([
      {
        patch: expect.objectContaining({
          status: 'rejected',
          decision_comment: 'Tasdiqlanmadi',
        }),
        ids: ['approval-8'],
      },
    ]);
    expect(extraCostApprovalRepo.row('approval-8')!.status).toBe('rejected');
  });
});
