import { of } from 'rxjs';
import { RpcException } from '@nestjs/microservices';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderCustodyService } from './custody/order-custody.service';
import {
  Order_status,
  BranchTransferBatchStatus,
  BranchTransferDirection,
} from '@app/common';
import { Order, OrderHolderType } from './entities/order.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { MarketCancelledHandoverSession } from './entities/market-cancelled-handover-session.entity';

describe('OrderServiceService return flow', () => {
  function makeService(options?: {
    orderStatus?: Order_status;
    hasReceivedReturnBatch?: boolean;
    branchId?: string;
    homeBranchId?: string;
    holderType?: OrderHolderType;
    holderBranchId?: string | null;
    returnRequested?: boolean;
    handoverSession?: unknown;
    requesterBranch?: unknown;
  }) {
    const order = {
      id: '101',
      market_id: 'm1',
      status: options?.orderStatus ?? Order_status.WAITING,
      branch_id: options?.branchId ?? '10',
      home_branch_id: options?.homeBranchId ?? '10',
      holder_type: options?.holderType,
      holder_branch_id:
        options?.holderBranchId === undefined ? null : options.holderBranchId,
      return_requested: options?.returnRequested ?? false,
      return_reason: null,
      isDeleted: false,
    } as any;

    const orderRepo = {
      findOne: jest.fn().mockResolvedValue(order),
      save: jest.fn((entity: any) => entity),
    };

    const transferBatchItemQb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawOne: jest
        .fn()
        .mockResolvedValue(
          options?.hasReceivedReturnBatch === false ? null : { item_id: '1' },
        ),
    };
    const transferBatchItemRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(transferBatchItemQb),
    };

    const trackingRepo = {
      create: jest.fn((x) => x),
      save: jest.fn((x) => x),
    };

    const custodyRepo = {
      create: jest.fn((x) => x),
      save: jest.fn((x) => x),
    };

    // Market QR handover sessiyasi — sukut bo'yicha AMALDAGI ruxsat (shu market,
    // skan qilgan xodim id='9', muddati o'tmagan). Testlar `handoverSession` ni
    // null / muddati o'tgan / boshqa market qilib rad holatini sinaydi.
    const defaultHandoverSession = {
      market_id: 'm1',
      scanned_by_user_id: '9',
      authorization_expires_at: new Date(Date.now() + 60_000),
      consumed_at: null,
      isDeleted: false,
    };
    const handoverSession =
      options?.handoverSession === undefined
        ? defaultHandoverSession
        : options.handoverSession;
    const sessionRepo = {
      findOne: jest.fn().mockResolvedValue(handoverSession),
    };

    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: { name: string }) => {
          if (entity.name === Order.name) return orderRepo;
          if (entity.name === OrderTracking.name) return trackingRepo;
          if (entity.name === OrderCustodyEvent.name) return custodyRepo;
          if (entity.name === MarketCancelledHandoverSession.name)
            return sessionRepo;
          return {};
        }),
      },
    };

    const outbox = { enqueue: jest.fn() };

    // branch.user.find_by_user — F3 filial xodimining filialini qaytaradi.
    const branchClient = {
      send: jest.fn(() => of({ data: options?.requesterBranch ?? null })),
    };

    // OrderServiceService konstruktori — 16 ta pozitsion bog'liqlik.
    // Faqat shu test ishlatadigan repolar haqiqiy mock, qolgani {}.
    const custody = new OrderCustodyService(
      trackingRepo as any,
      custodyRepo as any,
    );
    const service = new OrderLifecycleService(
      { createQueryRunner: jest.fn(() => queryRunner) } as any, // dataSource
      orderRepo as any, // orderRepo
      {} as any, // orderItemRepo
      trackingRepo as any, // orderTrackingRepo
      {} as any, // orderCustodyEventRepo
      {} as any, // orderSettlementRepo
      {} as any, // extraCostApprovalRepo
      transferBatchItemRepo as any, // transferBatchItemRepo
      {} as any, // identityClient
      {} as any, // logisticsClient
      {} as any, // financeClient
      {} as any, // integrationClient
      branchClient as any, // branchClient
      {} as any, // fileClient
      outbox as any, // outbox
      {
        log: jest.fn().mockResolvedValue(undefined),
        logChange: jest.fn().mockResolvedValue(undefined),
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
      custody as any, // OrderCustodyService
    );

    return {
      service,
      orderRepo,
      transferBatchItemQb,
      trackingRepo,
      queryRunner,
      outbox,
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

  it('initiateReturn requires reason', async () => {
    const { service } = makeService();
    await expectRpc(
      service.initiateReturn({ id: '1', roles: ['admin'] }, '101', {
        reason: '',
      }),
      400,
    );
  });

  it('initiateReturn rejects disallowed status', async () => {
    const { service } = makeService({ orderStatus: Order_status.SOLD });
    await expectRpc(
      service.initiateReturn({ id: '1', roles: ['admin'] }, '101', {
        reason: 'Mijoz rad etdi',
      }),
      400,
    );
  });

  it('initiateReturn stores reason and return_requested and writes history', async () => {
    const { service, orderRepo, trackingRepo, queryRunner } = makeService({
      orderStatus: Order_status.WAITING,
    });

    const res: any = await service.initiateReturn(
      { id: '7', roles: ['admin'] },
      '101',
      { reason: 'Adres noto‘g‘ri bo‘lgani uchun qaytarilsin' },
    );

    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        return_requested: true,
        return_reason: 'Adres noto‘g‘ri bo‘lgani uchun qaytarilsin',
      }),
    );
    expect(trackingRepo.save).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('markReturnedToMarket requires order to be received in return batch', async () => {
    const { service } = makeService({
      orderStatus: Order_status.RECEIVED,
      hasReceivedReturnBatch: false,
    });

    await expectRpc(
      service.markReturnedToMarket(
        { id: '9', roles: ['superadmin'] },
        '101',
        'MHA-ok',
      ),
      400,
    );
  });

  it('markReturnedToMarket sets final status and history once', async () => {
    const { service, orderRepo, trackingRepo, transferBatchItemQb } =
      makeService({
        orderStatus: Order_status.RECEIVED,
        hasReceivedReturnBatch: true,
      });

    const res: any = await service.markReturnedToMarket(
      { id: '9', roles: ['superadmin'] },
      '101',
      'MHA-ok',
    );

    expect(transferBatchItemQb.andWhere).toHaveBeenCalledWith(
      'batch.direction = :direction',
      { direction: BranchTransferDirection.RETURN },
    );
    expect(transferBatchItemQb.andWhere).toHaveBeenCalledWith(
      'batch.status = :status',
      { status: BranchTransferBatchStatus.RECEIVED },
    );
    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: Order_status.RETURNED_TO_MARKET,
        return_requested: false,
      }),
    );
    expect(trackingRepo.save).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('markReturnedToMarket cannot run twice', async () => {
    const { service } = makeService({
      orderStatus: Order_status.RETURNED_TO_MARKET,
    });

    await expectRpc(
      service.markReturnedToMarket(
        { id: '9', roles: ['superadmin'] },
        '101',
        'MHA-ok',
      ),
      400,
    );
  });

  it('markReturnedToMarket direct path: home-branch courier + return_requested (no batch)', async () => {
    const { service, orderRepo } = makeService({
      orderStatus: Order_status.WAITING_CUSTOMER,
      hasReceivedReturnBatch: false,
      homeBranchId: '10',
      holderType: OrderHolderType.COURIER,
      holderBranchId: '10', // courier belongs to the home branch
      returnRequested: true,
    });

    const res: any = await service.markReturnedToMarket(
      { id: '9', roles: ['superadmin'] },
      '101',
      'MHA-ok',
    );

    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: Order_status.RETURNED_TO_MARKET,
        return_requested: false,
      }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('markReturnedToMarket direct path: order held by home branch + return_requested', async () => {
    const { service, orderRepo } = makeService({
      orderStatus: Order_status.WAITING_CUSTOMER,
      hasReceivedReturnBatch: false,
      homeBranchId: '10',
      holderType: OrderHolderType.BRANCH,
      holderBranchId: '10',
      returnRequested: true,
    });

    const res: any = await service.markReturnedToMarket(
      { id: '9', roles: ['superadmin'] },
      '101',
      'MHA-ok',
    );

    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: Order_status.RETURNED_TO_MARKET }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('markReturnedToMarket rejects direct handover when courier is not at home branch', async () => {
    const { service } = makeService({
      orderStatus: Order_status.WAITING_CUSTOMER,
      hasReceivedReturnBatch: false,
      homeBranchId: '10',
      holderType: OrderHolderType.COURIER,
      holderBranchId: '99', // courier of a different (non-home) branch
      returnRequested: true,
    });

    await expectRpc(
      service.markReturnedToMarket(
        { id: '9', roles: ['superadmin'] },
        '101',
        'MHA-ok',
      ),
      400,
    );
  });

  it('markReturnedToMarket rejects direct handover without return_requested', async () => {
    const { service } = makeService({
      orderStatus: Order_status.RECEIVED,
      hasReceivedReturnBatch: false,
      homeBranchId: '10',
      holderType: OrderHolderType.BRANCH,
      holderBranchId: '10',
      returnRequested: false,
    });

    await expectRpc(
      service.markReturnedToMarket(
        { id: '9', roles: ['superadmin'] },
        '101',
        'MHA-ok',
      ),
      400,
    );
  });

  // ⭐ MARKET QR MAJBURIY (return-market-qr-majburiy) — QR'siz / HQ bo'lmagan /
  // boshqa market / muddati o'tgan ruxsat bilan topshirib bo'lmaydi.
  it('⭐ market QR (token) SIZ rad etiladi (400)', async () => {
    const { service } = makeService({
      orderStatus: Order_status.RECEIVED,
      hasReceivedReturnBatch: true,
    });
    await expectRpc(
      // token berilmadi — market QR majburiy
      service.markReturnedToMarket({ id: '9', roles: ['superadmin'] }, '101'),
      400,
    );
  });

  it('⭐ HQ bo`lmagan xodim (operator) rad etiladi (403)', async () => {
    const { service } = makeService({
      orderStatus: Order_status.RECEIVED,
      hasReceivedReturnBatch: true,
    });
    await expectRpc(
      service.markReturnedToMarket(
        { id: '9', roles: ['operator'] },
        '101',
        'MHA-ok',
      ),
      403,
    );
  });

  it('⭐ boshqa market QR si rad etiladi (403)', async () => {
    const { service } = makeService({
      orderStatus: Order_status.RECEIVED,
      hasReceivedReturnBatch: true,
      handoverSession: {
        market_id: 'BOSHQA',
        scanned_by_user_id: '9',
        authorization_expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
        isDeleted: false,
      },
    });
    await expectRpc(
      service.markReturnedToMarket(
        { id: '9', roles: ['superadmin'] },
        '101',
        'MHA-ok',
      ),
      403,
    );
  });

  it('⭐ muddati o`tgan market QR rad etiladi (403)', async () => {
    const { service } = makeService({
      orderStatus: Order_status.RECEIVED,
      hasReceivedReturnBatch: true,
      handoverSession: {
        market_id: 'm1',
        scanned_by_user_id: '9',
        authorization_expires_at: new Date(Date.now() - 1000),
        consumed_at: null,
        isDeleted: false,
      },
    });
    await expectRpc(
      service.markReturnedToMarket(
        { id: '9', roles: ['superadmin'] },
        '101',
        'MHA-ok',
      ),
      403,
    );
  });

  // ⭐ F3 — FILIAL darajasi: menejer o'z filialidagi bekor orderni market QR
  // bilan topshira oladi; begona filial orderi rad etiladi.
  it('⭐ F3: filial menejeri O`Z filialidagi orderni topshira oladi (200)', async () => {
    const { service, orderRepo } = makeService({
      orderStatus: Order_status.RECEIVED,
      hasReceivedReturnBatch: true,
      holderType: OrderHolderType.BRANCH,
      holderBranchId: '10',
      requesterBranch: { branch_id: '10', branch: { type: 'REGIONAL' } },
    });

    const res: any = await service.markReturnedToMarket(
      { id: '9', roles: ['manager'] },
      '101',
      'MHA-ok',
    );

    expect(orderRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: Order_status.RETURNED_TO_MARKET }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('⭐ F3: filial menejeri BEGONA filial orderini topshira olmaydi (403)', async () => {
    const { service } = makeService({
      orderStatus: Order_status.RECEIVED,
      hasReceivedReturnBatch: true,
      holderType: OrderHolderType.BRANCH,
      holderBranchId: '99', // boshqa filial
      requesterBranch: { branch_id: '10', branch: { type: 'REGIONAL' } },
    });

    await expectRpc(
      service.markReturnedToMarket(
        { id: '9', roles: ['manager'] },
        '101',
        'MHA-ok',
      ),
      403,
    );
  });
});
