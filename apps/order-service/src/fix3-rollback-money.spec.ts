/**
 * FIX3 / L1 — rollback va pul to'g'riligi (order-lifecycle).
 *
 *   M1 / LC-01 (blocker, prod'da jonli): menejer kuryer sotuvini qaytarsa
 *     kuryer kassasi teskari yozilmasdi — 289-kuryerda 140 000 soxta qarz.
 *   M5:  qo'shimcha xarajat 5 soniyalik tarix evristikasi bilan qaytarilardi.
 *   M6:  kuryer pulni topshirgandan keyin (COURIER_SETTLED) rollback ruxsat
 *        etilardi va FIFO taqsimoti yo'qolardi.
 *   RBAC-20: menejer uchun status ro'yxati yo'q edi.
 *   CODE-14: cancelled_sent rollbackidan keyin pochta xatosi 500 qaytarardi.
 *   M13: qo'shimcha xarajat P&L yozuvlarida dedup_key yo'q edi.
 *   M15: menejer sotuvi filial kassasi topilmasa ham o'tardi.
 *   M10: qisman sotuv summasi buyurtma summasidan oshishi mumkin edi.
 *
 * Uslub: `Object.create(prototype)` + stub (boshqa lifecycle speclari kabi).
 * Pul mantig'i (hasRole, resolveActorCourierId, isSettledToHq, rollback
 * oyoqlari, recordSaleSettlement) HAQIQIY qoladi — tekshiriladigan narsa
 * aynan ular yozgan kassa oyoqlari.
 */
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import {
  Cashbox_type,
  Operation_type,
  Order_status,
  SettlementStatus,
  Source_type,
  Where_deliver,
} from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderSettlement } from './entities/order-settlement.entity';
import {
  isCourierRemittedSettlement,
  resolveRollbackReversalActor,
} from './domain/order-money';

type Leg = Record<string, unknown>;
type Row = Record<string, unknown>;
type Enqueued = { target: string; cmd: string; payload: Row };
type Svc = OrderLifecycleService & Record<string, any>;

const COURIER = { id: '289', roles: ['courier'], branch_id: '77' };
const MANAGER = { id: '201', roles: ['manager'], branch_id: '77' };
const SUPERADMIN = { id: '1', roles: ['superadmin'] };

/** Kuryer 289 sotgan buyurtma (prod holati): 165 000 − ulush 25 000 = 140 000. */
const COURIER_SOLD_ORDER: Row = {
  id: '7001',
  status: Order_status.SOLD,
  post_id: '9001',
  market_id: '501',
  customer_id: '801',
  total_price: 165000,
  paid_online_amount: 0,
  sale_collectible_amount: 165000,
  where_deliver: Where_deliver.CENTER,
  market_tariff: 30000,
  courier_tariff: 25000,
  courier_share: 25000,
  branch_share: 0,
  branch_cashbox_amount: 0,
  extra_cost: 0,
  branch_id: '77',
  home_branch_id: '77',
  holder_branch_id: '77',
  holder_courier_id: '289',
  courier_id: '289',
  sold_at: '1759300000000',
  updatedAt: new Date('2026-09-30T08:00:00.000Z'),
  comment: null,
};

const courierSettlement = (over: Row = {}): Row => ({
  order_id: '7001',
  status: SettlementStatus.PENDING,
  courier_id: '289',
  branch_id: '77',
  market_id: '501',
  courier_amount: 140000,
  branch_amount: 140000,
  market_amount: 135000,
  isDeleted: false,
  ...over,
});

function makeRollbackService(
  opts: {
    order?: Row;
    settlement?: Row | null;
    postCourierId?: string | null;
    cancelPostError?: unknown;
    cashbox?: (userId: string, type: Cashbox_type) => unknown;
  } = {},
) {
  const order: Row = { ...COURIER_SOLD_ORDER, ...(opts.order ?? {}) };
  const legs: Leg[] = [];
  const enqueued: Enqueued[] = [];
  const updates: Row[] = [];
  const resets: string[] = [];
  const rpcCalls: string[] = [];

  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: unknown) =>
        entity === Order
          ? { findOne: jest.fn().mockResolvedValue({ ...order }) }
          : {},
      ),
    },
  };

  // Tekshiriladigan stub'lar alohida ushlanadi: sinf tipidagi metodga
  // `h.s.x.y` orqali murojaat `unbound-method` lint xatosini beradi.
  const mocks = {
    createQueryRunner: jest.fn(() => queryRunner),
    financeSend: jest.fn(() => {
      throw new Error('rollback finance tarixini o`qimasligi kerak');
    }),
    ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
    loggerWarn: jest.fn(),
    activityLog: jest.fn().mockResolvedValue(undefined),
  };

  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: mocks.loggerWarn, log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: mocks.createQueryRunner },
    orderSettlementRepo: {
      findOne: jest.fn().mockResolvedValue(opts.settlement ?? null),
    },
    logisticsClient: {
      send: jest.fn((pattern: { cmd: string }) => {
        rpcCalls.push(pattern.cmd);
        if (
          pattern.cmd === 'logistics.post.cancel.create' &&
          opts.cancelPostError
        ) {
          return throwError(() => opts.cancelPostError);
        }
        return of({
          data: {
            id: '9001',
            courier_id:
              opts.postCourierId === undefined ? '289' : opts.postCourierId,
          },
        });
      }),
    },
    // M5: rollback endi finance tarixiga UMUMAN murojaat qilmaydi.
    financeClient: { send: mocks.financeSend },
    outbox: {
      enqueue: jest.fn((target: string, cmd: string, payload: Row) => {
        enqueued.push({ target, cmd, payload });
        return Promise.resolve();
      }),
    },
    activityLog: { log: mocks.activityLog },
    custody: { auditActor: jest.fn(() => ({})) },
    lookup: {
      getMarketsByIds: jest
        .fn()
        .mockResolvedValue([
          { id: '501', tariff_center: 30000, tariff_home: 45000 },
        ]),
      getCouriersByIds: jest.fn((ids: string[]) =>
        Promise.resolve(
          ids.map((id) => ({ id, tariff_center: 25000, tariff_home: 35000 })),
        ),
      ),
      getUserById: jest.fn((id: string) =>
        Promise.resolve({ id, tariff_center: 0, tariff_home: 0 }),
      ),
      getCashboxByUser: jest.fn((userId: string, type: Cashbox_type) =>
        Promise.resolve(
          opts.cashbox
            ? opts.cashbox(userId, type)
            : { id: `${type}-${userId}`, balance: 0 },
        ),
      ),
      ensureBranchCashbox: mocks.ensureBranchCashbox,
      resolveSettlementBranchId: jest.fn().mockResolvedValue('77'),
      getHqBranchId: jest.fn().mockResolvedValue('1'),
    },
    findById: jest.fn().mockResolvedValue(order),
    updateCashboxBalance: jest.fn((leg: Leg) => {
      legs.push(leg);
      return Promise.resolve();
    }),
    resetSettlementOnRollback: jest.fn((_tx: unknown, orderId: string) => {
      resets.push(orderId);
      return Promise.resolve();
    }),
    updateFull: jest.fn((_id: string, dto: Row) => {
      updates.push(dto);
      return Promise.resolve(order);
    }),
    mergePartialChildrenBack: jest.fn().mockResolvedValue(0),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
  });

  return {
    s,
    mocks,
    order,
    legs,
    enqueued,
    updates,
    resets,
    rpcCalls,
    queryRunner,
  };
}

/** Kassa oyoqlarining ma'noli qismi (created_by / dedup_epoch siz). */
const shape = (legs: Leg[]) =>
  legs.map((leg) => ({
    user_id: leg.user_id,
    cashbox_type: leg.cashbox_type,
    amount: leg.amount,
    operation_type: leg.operation_type,
    source_type: leg.source_type,
  }));

const legsOf = (legs: Leg[], type: Cashbox_type) =>
  legs.filter((leg) => leg.cashbox_type === type);

const extraCostCorrections = (enqueued: Enqueued[]) =>
  enqueued.filter(
    (e) =>
      e.cmd === 'finance.financial_balance.record' &&
      e.payload.source_type === 'correction' &&
      typeof e.payload.comment === 'string' &&
      e.payload.comment.includes('extra cost rollback'),
  );

async function rpcError(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
}

describe('M1 / LC-01 — teskari oyoqlar sotuv yozganidan, so`rovchidan emas', () => {
  it('⭐ prod holati: menejer rollbacki 289-kuryer kassasidan 140 000 ni qaytaradi', async () => {
    const h = makeRollbackService({ settlement: courierSettlement() });

    await h.s.rollbackOrderToWaiting(MANAGER, '7001', undefined, 'rb-1');

    expect(shape(legsOf(h.legs, Cashbox_type.FOR_COURIER))).toEqual([
      {
        user_id: '289',
        cashbox_type: Cashbox_type.FOR_COURIER,
        amount: 140000,
        operation_type: Operation_type.EXPENSE,
        source_type: Source_type.CORRECTION,
      },
    ]);
    expect(shape(legsOf(h.legs, Cashbox_type.FOR_MARKET))).toEqual([
      {
        user_id: '501',
        cashbox_type: Cashbox_type.FOR_MARKET,
        amount: 135000,
        operation_type: Operation_type.EXPENSE,
        source_type: Source_type.CORRECTION,
      },
    ]);
    // Kuryer sotuvida filial kassasiga hech narsa yozilmagan — teskari ham yo'q.
    expect(legsOf(h.legs, Cashbox_type.BRANCH)).toEqual([]);
    expect(h.resets).toEqual(['7001']);
    expect(h.queryRunner.commitTransaction).toHaveBeenCalled();
  });

  it('menejer rollbacki kuryerning o`z rollbacki bilan AYNAN bir xil oyoqlarni yozadi', async () => {
    const byManager = makeRollbackService({
      settlement: courierSettlement(),
    });
    const byCourier = makeRollbackService({
      settlement: courierSettlement(),
    });

    await byManager.s.rollbackOrderToWaiting(MANAGER, '7001');
    await byCourier.s.rollbackOrderToWaiting(COURIER, '7001');

    expect(shape(byManager.legs)).toEqual(shape(byCourier.legs));
  });

  it('qo`shimcha xarajat kuryerdan yechilgan bo`lsa menejer rollbacki uni KURYERGA qaytaradi (filial id si bilan emas)', async () => {
    const h = makeRollbackService({
      order: { extra_cost: 5000 },
      settlement: courierSettlement({ courier_amount: 135000 }),
    });

    await h.s.rollbackOrderToWaiting(MANAGER, '7001', undefined, 'rb-1');

    const refunds = shape(
      h.legs.filter((leg) => leg.operation_type === Operation_type.INCOME),
    );
    expect(refunds).toEqual([
      {
        user_id: '501',
        cashbox_type: Cashbox_type.FOR_MARKET,
        amount: 5000,
        operation_type: Operation_type.INCOME,
        source_type: Source_type.CORRECTION,
      },
      {
        user_id: '289',
        cashbox_type: Cashbox_type.FOR_COURIER,
        amount: 5000,
        operation_type: Operation_type.INCOME,
        source_type: Source_type.CORRECTION,
      },
    ]);
    // Filial kassasiga (77) hech narsa yozilmaydi.
    expect(h.legs.some((leg) => leg.user_id === '77')).toBe(false);
    // Xarajat qaytarildi — buyurtmadagi snapshot ham nolga tushadi.
    expect(h.updates[0]).toMatchObject({
      status: Order_status.WAITING,
      extra_cost: 0,
    });
  });

  it('teskari holat: SA menejer sotuvini qaytarsa YOZILMAGAN kuryer oyog`i teskari yozilmaydi', async () => {
    const h = makeRollbackService({
      order: {
        courier_share: 0,
        courier_tariff: 0,
        // Menejer sotuvi: naqd filial kassasiga tushgan (165 000 − 0).
        branch_cashbox_amount: 165000,
        extra_cost: 5000,
      },
      settlement: {
        order_id: '7001',
        status: SettlementStatus.COURIER_SETTLED,
        courier_id: null,
        branch_id: '77',
        market_id: '501',
        courier_amount: 165000,
        branch_amount: 160000,
        market_amount: 130000,
      },
    });

    await h.s.rollbackOrderToWaiting(SUPERADMIN, '7001');

    expect(legsOf(h.legs, Cashbox_type.FOR_COURIER)).toEqual([]);
    expect(shape(legsOf(h.legs, Cashbox_type.BRANCH))).toEqual([
      {
        user_id: '77',
        cashbox_type: Cashbox_type.BRANCH,
        amount: 5000,
        operation_type: Operation_type.INCOME,
        source_type: Source_type.CORRECTION,
      },
      {
        user_id: '77',
        cashbox_type: Cashbox_type.BRANCH,
        amount: 165000,
        operation_type: Operation_type.EXPENSE,
        source_type: Source_type.CORRECTION,
      },
    ]);
  });

  it('kuryer menejer sotuvini (o`z pochtasida) qaytarsa ham kuryer kassasiga tegilmaydi', async () => {
    const h = makeRollbackService({
      order: { courier_share: 0, branch_cashbox_amount: 165000 },
      settlement: {
        order_id: '7001',
        status: SettlementStatus.COURIER_SETTLED,
        courier_id: null,
        branch_id: '77',
        courier_amount: 165000,
      },
    });

    await h.s.rollbackOrderToWaiting(COURIER, '7001');

    expect(legsOf(h.legs, Cashbox_type.FOR_COURIER)).toEqual([]);
    expect(
      legsOf(h.legs, Cashbox_type.BRANCH).map((leg) => leg.amount),
    ).toEqual([165000]);
  });

  it('menejer kuryer sotuvini qaytarganda kuryer kassasi topilmasa — 404, hech narsa yozilmaydi', async () => {
    const h = makeRollbackService({
      settlement: courierSettlement(),
      cashbox: (userId, type) =>
        type === Cashbox_type.FOR_COURIER
          ? undefined
          : { id: `${type}-${userId}`, balance: 0 },
    });

    const error = await rpcError(h.s.rollbackOrderToWaiting(MANAGER, '7001'));

    expect(error.statusCode).toBe(404);
    expect(h.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(h.legs).toEqual([]);
  });
});

describe('M5 — qo`shimcha xarajat deterministik qaytariladi (tarix evristikasi yo`q)', () => {
  it('⭐ bekor qilingan buyurtma: updatedAt qancha eski bo`lmasin xarajat kuryer va marketga qaytadi', async () => {
    const h = makeRollbackService({
      order: {
        status: Order_status.CANCELLED,
        extra_cost: 4000,
        sold_at: null,
        // Bekor qilinganidan keyin buyurtma yana yangilangan (eski evristika
        // aynan shu yerda qaytarishni o'tkazib yuborardi).
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      },
      settlement: courierSettlement({
        courier_amount: -4000,
        branch_amount: -4000,
        market_amount: -4000,
      }),
    });

    await h.s.rollbackOrderToWaiting(COURIER, '7001', undefined, 'rb-2');

    expect(shape(h.legs)).toEqual([
      {
        user_id: '501',
        cashbox_type: Cashbox_type.FOR_MARKET,
        amount: 4000,
        operation_type: Operation_type.INCOME,
        source_type: Source_type.CORRECTION,
      },
      {
        user_id: '289',
        cashbox_type: Cashbox_type.FOR_COURIER,
        amount: 4000,
        operation_type: Operation_type.INCOME,
        source_type: Source_type.CORRECTION,
      },
    ]);
    expect(String(h.legs[0].comment)).toContain('Bekor qilingan');
    expect(h.mocks.financeSend).not.toHaveBeenCalled();
    expect(h.resets).toEqual(['7001']);
    expect(h.updates[0]).toMatchObject({
      status: Order_status.WAITING,
      extra_cost: 0,
    });
    // P&L ham qaytariladi (avval bekor rollbackida bu yozuv umuman yo'q edi).
    expect(extraCostCorrections(h.enqueued)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          amount: 4000,
          dedup_key: 'rollback-extra:req:rb-2',
        }),
      }),
    ]);
  });

  it('sotilgan buyurtma: xarajat finance tarixi yozilmasdan oldin ham (tezkor rollback) qaytariladi', async () => {
    const h = makeRollbackService({
      order: { extra_cost: 5000 },
      settlement: courierSettlement({ courier_amount: 135000 }),
    });

    await h.s.rollbackOrderToWaiting(COURIER, '7001', undefined, 'rb-3');

    expect(
      h.legs
        .filter((leg) => leg.operation_type === Operation_type.INCOME)
        .map((leg) => [leg.user_id, leg.amount]),
    ).toEqual([
      ['501', 5000],
      ['289', 5000],
    ]);
    expect(extraCostCorrections(h.enqueued)).toHaveLength(1);
    expect(extraCostCorrections(h.enqueued)[0].payload.dedup_key).toBe(
      'rollback-extra:req:rb-3',
    );
  });

  it('extra_cost 0 bo`lsa hech narsa qaytarilmaydi va snapshotga tegilmaydi', async () => {
    const h = makeRollbackService({ settlement: courierSettlement() });

    await h.s.rollbackOrderToWaiting(COURIER, '7001');

    expect(
      h.legs.filter((leg) => leg.operation_type === Operation_type.INCOME),
    ).toEqual([]);
    expect(extraCostCorrections(h.enqueued)).toEqual([]);
    expect(h.updates[0]).not.toHaveProperty('extra_cost');
  });

  it('menejer xarajatli bekorini qaytarsa xarajat settlement filialiga qaytadi', async () => {
    const h = makeRollbackService({
      order: { status: Order_status.CANCELLED, extra_cost: 3000 },
      settlement: {
        order_id: '7001',
        status: SettlementStatus.COURIER_SETTLED,
        courier_id: null,
        branch_id: '77',
        courier_amount: 0,
        branch_amount: -3000,
        market_amount: -3000,
      },
    });

    await h.s.rollbackOrderToWaiting(MANAGER, '7001');

    expect(h.mocks.ensureBranchCashbox).toHaveBeenCalledWith('77');
    expect(
      h.legs.map((leg) => [leg.user_id, leg.cashbox_type, leg.amount]),
    ).toEqual([
      ['501', Cashbox_type.FOR_MARKET, 3000],
      ['77', Cashbox_type.BRANCH, 3000],
    ]);
  });

  it('xarajat egasining kassasi topilmasa rollback 404 bilan to`xtaydi (jimgina o`tkazilmaydi)', async () => {
    const h = makeRollbackService({
      order: { status: Order_status.CANCELLED, extra_cost: 3000 },
      settlement: {
        order_id: '7001',
        status: SettlementStatus.COURIER_SETTLED,
        courier_id: null,
        branch_id: '77',
        courier_amount: 0,
      },
      cashbox: (userId, type) =>
        type === Cashbox_type.BRANCH
          ? undefined
          : { id: `${type}-${userId}`, balance: 0 },
    });

    const error = await rpcError(h.s.rollbackOrderToWaiting(MANAGER, '7001'));

    expect(error).toMatchObject({
      statusCode: 404,
      message: 'Filial kassasi topilmadi',
    });
    expect(h.queryRunner.startTransaction).not.toHaveBeenCalled();
  });
});

describe('M6 — kuryer pulni topshirgandan keyin rollback yo`q', () => {
  /**
   * fix3b: SUPERADMIN endi tuzatish roli (hujjatdagi chegara — HQ) — u
   * qaytarganda kuryer topshirgan summa uning qoldig'iga kredit bo'lib
   * yoziladi. Bu yo'l `fix3b-sa-rollback-courier-credit.spec.ts` da
   * (daftar ↔ kassa izchilligi bilan) to'liq tekshiriladi.
   */
  it.each([
    ['kuryer', COURIER],
    ['menejer', MANAGER],
  ])(
    '⭐ COURIER_SETTLED kuryer qatori — %s ham qaytara olmaydi, kassaga hech narsa yozilmaydi',
    async (_label, requester) => {
      const h = makeRollbackService({
        settlement: courierSettlement({
          status: SettlementStatus.COURIER_SETTLED,
        }),
      });

      const error = await rpcError(
        h.s.rollbackOrderToWaiting(requester, '7001'),
      );

      expect(error.statusCode).toBe(400);
      expect(error.message).toContain("topshirib bo'lgan");
      expect(h.mocks.createQueryRunner).not.toHaveBeenCalled();
      expect(h.legs).toEqual([]);
      expect(h.resets).toEqual([]);
    },
  );

  it('ishlatilgan (COURIER_SETTLED) bekor krediti ham qaytarilmaydi', async () => {
    const h = makeRollbackService({
      order: { status: Order_status.CANCELLED, extra_cost: 4000 },
      settlement: courierSettlement({
        status: SettlementStatus.COURIER_SETTLED,
        courier_amount: -4000,
      }),
    });

    const error = await rpcError(h.s.rollbackOrderToWaiting(COURIER, '7001'));

    expect(error.statusCode).toBe(400);
    expect(h.legs).toEqual([]);
  });

  it('nol summali COURIER_SETTLED qator (FIFO bepul o`tkazgan) qaytariladi', async () => {
    const h = makeRollbackService({
      order: { total_price: 25000, sale_collectible_amount: 25000 },
      settlement: courierSettlement({
        status: SettlementStatus.COURIER_SETTLED,
        courier_amount: 0,
      }),
    });

    await h.s.rollbackOrderToWaiting(COURIER, '7001');

    expect(h.resets).toEqual(['7001']);
  });

  it('PENDING kuryer qatori avvalgidek qaytariladi', async () => {
    const h = makeRollbackService({ settlement: courierSettlement() });

    await expect(
      h.s.rollbackOrderToWaiting(COURIER, '7001'),
    ).resolves.toMatchObject({ statusCode: 200 });
  });
});

describe('RBAC-20 — menejer faqat SOLD/CANCELLED buyurtmani qaytaradi', () => {
  it.each([
    Order_status.CLOSED,
    Order_status.RECEIVED,
    Order_status.ON_THE_ROAD,
    Order_status.NEW,
    Order_status.PAID,
  ])('⭐ menejer %s buyurtmani qaytara olmaydi', async (status) => {
    const h = makeRollbackService({ order: { status } });

    const error = await rpcError(h.s.rollbackOrderToWaiting(MANAGER, '7001'));

    expect(error).toMatchObject({
      statusCode: 400,
      message: `Rollback mumkin emas (status: ${status})`,
    });
    expect(h.mocks.createQueryRunner).not.toHaveBeenCalled();
  });

  it('PARTLY_PAID uchun aniqroq "faqat superadmin" xabari saqlanadi', async () => {
    const h = makeRollbackService({
      order: { status: Order_status.PARTLY_PAID },
    });

    const error = await rpcError(h.s.rollbackOrderToWaiting(MANAGER, '7001'));

    expect(error.message).toContain('superadmin');
  });

  it('superadmin CLOSED buyurtmani avvalgidek qaytaradi', async () => {
    const h = makeRollbackService({
      order: { status: Order_status.CLOSED, extra_cost: 0 },
      settlement: null,
    });

    await expect(
      h.s.rollbackOrderToWaiting(SUPERADMIN, '7001'),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it('menejer SOLD va CANCELLED ni qaytara oladi', async () => {
    const sold = makeRollbackService({ settlement: courierSettlement() });
    const cancelled = makeRollbackService({
      order: { status: Order_status.CANCELLED, sold_at: null },
    });

    await expect(
      sold.s.rollbackOrderToWaiting(MANAGER, '7001'),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      cancelled.s.rollbackOrderToWaiting(MANAGER, '7001'),
    ).resolves.toMatchObject({ statusCode: 200 });
  });
});

describe('CODE-14 — cancelled_sent: pochta xatosi commit bo`lgan rollbackni 500 ga aylantirmaydi', () => {
  const cancelledOrder = { status: Order_status.CANCELLED, sold_at: null };

  it('⭐ logistika rad etsa ham 200 + ogohlantirish qaytadi, audit yoziladi', async () => {
    const h = makeRollbackService({
      order: cancelledOrder,
      cancelPostError: new RpcException({
        statusCode: 403,
        message: 'Bu pochta sizga tegishli emas',
      }),
    });

    const res = (await h.s.rollbackOrderToWaiting(COURIER, '7001', {
      target_status: 'cancelled_sent',
    })) as { statusCode: number; message: string; data: Row };

    expect(h.queryRunner.commitTransaction).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({ cancel_post_created: false });
    expect(res.message).toContain('Bu pochta sizga tegishli emas');
    expect(h.mocks.loggerWarn).toHaveBeenCalled();
    expect(h.mocks.activityLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          cancel_post_warning: expect.stringContaining("qo'lda"),
        }),
      }),
    );
  });

  it('pochta yaratilsa avvalgi javob o`zgarmaydi', async () => {
    const h = makeRollbackService({ order: cancelledOrder });

    const res = await h.s.rollbackOrderToWaiting(COURIER, '7001', {
      target_status: 'cancelled_sent',
    });

    expect(h.rpcCalls).toContain('logistics.post.cancel.create');
    expect(res).toEqual({
      statusCode: 200,
      message: "Order bekor qilinib pochtaga qo'shildi",
      data: {},
    });
  });
});

// ─────────────────────────── sotuv yo'llari ───────────────────────────

const WAITING_ORDER: Row = {
  id: '7001',
  status: Order_status.WAITING,
  post_id: '9001',
  market_id: '501',
  customer_id: '801',
  total_price: 250000,
  paid_online_amount: 0,
  where_deliver: Where_deliver.CENTER,
  branch_id: '77',
  home_branch_id: '77',
  holder_branch_id: '77',
  comment: null,
  sold_at: null,
};

function makeSellService(
  opts: {
    order?: Row;
    cashbox?: (userId: string, type: Cashbox_type) => unknown;
  } = {},
) {
  const order: Row = { ...WAITING_ORDER, ...(opts.order ?? {}) };
  const legs: Leg[] = [];
  const enqueued: Enqueued[] = [];
  const updates: Row[] = [];
  const settlements: Row[] = [];

  const settlementRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: Row) => row),
    save: jest.fn((row: Row) => {
      settlements.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const tx = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === OrderSettlement) return settlementRepo;
      if (entity === OrderItem) {
        return {
          save: jest.fn((row: Row) => Promise.resolve(row)),
          createQueryBuilder: () => ({
            insert: () => ({
              values: () => ({ execute: () => Promise.resolve({}) }),
            }),
          }),
        };
      }
      if (entity === Order) {
        return {
          create: (value: Row) => value,
          save: (value: Row) => Promise.resolve({ id: '9900', ...value }),
          update: jest.fn().mockResolvedValue({ affected: 1 }),
        };
      }
      return {};
    }),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: tx,
  };

  const mocks = {
    createQueryRunner: jest.fn(() => queryRunner),
    resolveSettlementBranchId: jest.fn().mockResolvedValue('77'),
  };

  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: mocks.createQueryRunner },
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '289' } })),
    },
    outbox: {
      enqueue: jest.fn((target: string, cmd: string, payload: Row) => {
        enqueued.push({ target, cmd, payload });
        return Promise.resolve();
      }),
    },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: {
      auditActor: jest.fn(() => ({})),
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'courier'),
    },
    orderItemRepo: {
      find: jest.fn().mockResolvedValue([
        {
          id: '1',
          order_id: '7001',
          product_id: '4',
          product_name: null,
          quantity: 2,
        },
      ]),
    },
    lookup: {
      getMarketsByIds: jest.fn().mockResolvedValue([
        {
          id: '501',
          tariff_center: 45000,
          tariff_home: 70000,
          expense_proof_conditions: [],
        },
      ]),
      getCouriersByIds: jest.fn().mockResolvedValue([
        {
          id: '289',
          tariff_center: 30000,
          tariff_home: 50000,
          can_add_extra_cost: true,
        },
      ]),
      getUserById: jest.fn().mockResolvedValue({
        id: '201',
        can_add_extra_cost: true,
        tariff_center: 0,
        tariff_home: 0,
      }),
      getCashboxByUser: jest.fn((userId: string, type: Cashbox_type) =>
        Promise.resolve(
          opts.cashbox
            ? opts.cashbox(userId, type)
            : { id: `${type}-${userId}`, balance: 0 },
        ),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: mocks.resolveSettlementBranchId,
      resolveBranchShare: jest.fn().mockResolvedValue(0),
      getHqBranchId: jest.fn().mockResolvedValue('1'),
    },
    findById: jest.fn().mockResolvedValue(order),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    resolveHolderFromState: jest.fn().mockResolvedValue({
      holder_type: 'COURIER',
      holder_branch_id: '77',
      holder_courier_id: '289',
    }),
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    updateFull: jest.fn((_id: string, dto: Row) => {
      updates.push(dto);
      return Promise.resolve(order);
    }),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
    updateCashboxBalance: jest.fn((leg: Leg) => {
      legs.push(leg);
      return Promise.resolve();
    }),
  });

  return { s, mocks, order, legs, enqueued, updates, settlements, queryRunner };
}

const ledgerOf = (enqueued: Enqueued[], sourceType: string) =>
  enqueued.filter(
    (e) =>
      e.cmd === 'finance.financial_balance.record' &&
      e.payload.source_type === sourceType,
  );

describe('M13 — qo`shimcha xarajat P&L yozuvlari urinish tokeni bilan', () => {
  it('⭐ sotuv: sell_extra_cost dedup_key = sale:<sold_at> (sell_profit bilan bir xil token)', async () => {
    const h = makeSellService();

    await h.s.sellOrder(COURIER, '7001', {
      extraCost: 5000,
      extraCostApproved: true,
    });

    const [entry] = ledgerOf(h.enqueued, 'sell_extra_cost');
    expect(entry.payload.amount).toBe(-5000);
    expect(h.updates[0].sold_at).toEqual(expect.any(String));
    expect(entry.payload.dedup_key).toBe(
      `sale:${String(h.updates[0].sold_at)}`,
    );
  });

  it('bekor: cancel_extra_cost dedup_key = cancel:<so`rov epoxasi>', async () => {
    const h = makeSellService();

    await h.s.cancelOrder(
      COURIER,
      '7001',
      { extraCost: 5000, extraCostApproved: true },
      'cancel-req-1',
    );

    const [entry] = ledgerOf(h.enqueued, 'cancel_extra_cost');
    expect(entry.payload.dedup_key).toBe('cancel:req:cancel-req-1');
  });

  it('qisman sotuv: dedup_key yoziladigan sold_at dan, extra_cost buyurtmaga yoziladi (M5)', async () => {
    const h = makeSellService();

    await h.s.partlySellOrder(COURIER, '7001', {
      order_item_info: [{ product_id: '4', quantity: 1 }],
      totalPrice: 150000,
      extraCost: 5000,
      extraCostApproved: true,
    });

    const [entry] = ledgerOf(h.enqueued, 'sell_extra_cost');
    expect(entry.payload.dedup_key).toBe(
      `sale:${String(h.updates[0].sold_at)}`,
    );
    expect(h.updates[0]).toMatchObject({
      extra_cost: 5000,
      total_price: 150000,
    });
  });
});

describe('M15 — menejer sotuvi filial kassasisiz o`tmaydi', () => {
  const noBranchCashbox = (userId: string, type: Cashbox_type) =>
    type === Cashbox_type.BRANCH
      ? undefined
      : { id: `${type}-${userId}`, balance: 0 };

  it('⭐ sellOrder: 404, tranzaksiya ochilmaydi, kassaga hech narsa yozilmaydi', async () => {
    const h = makeSellService({ cashbox: noBranchCashbox });

    const error = await rpcError(h.s.sellOrder(MANAGER, '7001', {}));

    expect(error.statusCode).toBe(404);
    expect(error.message).toContain('Filial kassasi topilmadi');
    expect(h.mocks.createQueryRunner).not.toHaveBeenCalled();
    expect(h.legs).toEqual([]);
  });

  it('partlySellOrder: 404, tranzaksiya ochilmaydi', async () => {
    const h = makeSellService({ cashbox: noBranchCashbox });

    const error = await rpcError(
      h.s.partlySellOrder(MANAGER, '7001', {
        order_item_info: [{ product_id: '4', quantity: 1 }],
        totalPrice: 150000,
      }),
    );

    expect(error.statusCode).toBe(404);
    expect(h.mocks.createQueryRunner).not.toHaveBeenCalled();
  });

  it('kuryer sotuvi filial kassasiga tayanmaydi — to`silmaydi', async () => {
    const h = makeSellService({ cashbox: noBranchCashbox });

    await expect(
      h.s.sellOrder(COURIER, '7001', { comment: 'Sotildi' }),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it('HQ menejeri (settlement filiali yo`q) avvalgidek sotadi', async () => {
    const h = makeSellService({ cashbox: noBranchCashbox });
    h.mocks.resolveSettlementBranchId.mockResolvedValue(null);

    await expect(h.s.sellOrder(MANAGER, '7001', {})).resolves.toMatchObject({
      statusCode: 200,
    });
  });
});

describe('M10 — qisman sotuv summasi buyurtma summasidan oshmaydi', () => {
  it('⭐ 250 000 lik buyurtmaga 2 500 000 — 400, hech narsa yozilmaydi', async () => {
    const h = makeSellService();

    const error = await rpcError(
      h.s.partlySellOrder(COURIER, '7001', {
        order_item_info: [{ product_id: '4', quantity: 1 }],
        totalPrice: 2500000,
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('oshmasligi kerak');
    expect(h.mocks.createQueryRunner).not.toHaveBeenCalled();
    expect(h.legs).toEqual([]);
  });

  it('summa buyurtma summasiga teng bo`lsa ruxsat (chegara qat`iy emas)', async () => {
    const h = makeSellService();

    await expect(
      h.s.partlySellOrder(COURIER, '7001', {
        order_item_info: [{ product_id: '4', quantity: 1 }],
        totalPrice: 250000,
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
  });
});

describe('sotuv → rollback: har kassa AYNAN sotuvdan oldingi holatga qaytadi', () => {
  /** INCOME +, EXPENSE − — (foydalanuvchi, kassa turi) bo'yicha yig'indi. */
  const net = (legs: Leg[]) => {
    const sums = new Map<string, number>();
    for (const leg of legs) {
      const key = `${String(leg.cashbox_type)}:${String(leg.user_id)}`;
      const sign = leg.operation_type === Operation_type.INCOME ? 1 : -1;
      sums.set(key, (sums.get(key) ?? 0) + sign * Number(leg.amount));
    }
    return sums;
  };

  async function sellThenRollback(params: {
    seller: typeof COURIER | typeof MANAGER;
    rollbackBy: typeof COURIER | typeof MANAGER | typeof SUPERADMIN;
    extraCost: number;
  }) {
    const sale = makeSellService();
    await sale.s.sellOrder(params.seller, '7001', {
      extraCost: params.extraCost,
      extraCostApproved: true,
    });
    const soldOrder: Row = {
      ...WAITING_ORDER,
      ...sale.updates[0],
      holder_courier_id: '289',
      courier_id: '289',
    };
    const rollback = makeRollbackService({
      order: soldOrder,
      settlement: { ...sale.settlements[0], isDeleted: false },
    });
    await rollback.s.rollbackOrderToWaiting(params.rollbackBy, '7001');
    return { sale, rollback };
  }

  it.each([
    ['kuryer sotdi, menejer qaytardi (prod blocker)', COURIER, MANAGER, 5000],
    ['kuryer sotdi, kuryer qaytardi', COURIER, COURIER, 5000],
    ['kuryer sotdi, superadmin qaytardi', COURIER, SUPERADMIN, 0],
    ['menejer sotdi, superadmin qaytardi', MANAGER, SUPERADMIN, 5000],
    ['menejer sotdi, kuryer qaytardi', MANAGER, COURIER, 0],
    ['menejer sotdi, menejer qaytardi', MANAGER, MANAGER, 5000],
  ])(
    '⭐ %s — barcha kassalar net 0',
    async (_label, seller, rollbackBy, extraCost) => {
      const { sale, rollback } = await sellThenRollback({
        seller,
        rollbackBy,
        extraCost,
      });

      const combined = net([...sale.legs, ...rollback.legs]);
      for (const [key, sum] of combined) {
        expect([key, sum]).toEqual([key, 0]);
      }
      expect(combined.size).toBeGreaterThan(0);
    },
  );
});

describe('domen yordamchilari', () => {
  const legacy = {
    isManagerRequester: false,
    courierId: '289',
    requesterBranchId: '77',
  };

  it('settlement kuryeri — oyoq va xarajat o`sha kuryerda', () => {
    expect(
      resolveRollbackReversalActor({
        settlement: { courier_id: '300', branch_id: '77' },
        legacy: { ...legacy, isManagerRequester: true },
      }),
    ).toEqual({
      saleCourierId: '300',
      extraCostParty: {
        user_id: '300',
        cashbox_type: Cashbox_type.FOR_COURIER,
      },
      source: 'settlement',
    });
  });

  it('settlement kuryersiz — kuryer oyog`i yo`q, xarajat settlement filialida', () => {
    expect(
      resolveRollbackReversalActor({
        settlement: { courier_id: null, branch_id: '77' },
        legacy,
      }),
    ).toEqual({
      saleCourierId: null,
      extraCostParty: { user_id: '77', cashbox_type: Cashbox_type.BRANCH },
      source: 'settlement',
    });
    expect(
      resolveRollbackReversalActor({
        settlement: { courier_id: '0', branch_id: null },
        legacy,
      }),
    ).toEqual({
      saleCourierId: null,
      extraCostParty: null,
      source: 'settlement',
    });
  });

  it('settlement qatori yo`q — eski (so`rovchiga asoslangan) qoida', () => {
    expect(
      resolveRollbackReversalActor({ settlement: null, legacy }),
    ).toMatchObject({ saleCourierId: '289', source: 'legacy' });
    expect(
      resolveRollbackReversalActor({
        settlement: null,
        legacy: { ...legacy, isManagerRequester: true },
      }),
    ).toEqual({
      saleCourierId: null,
      extraCostParty: { user_id: '77', cashbox_type: Cashbox_type.BRANCH },
      source: 'legacy',
    });
  });

  it('isCourierRemittedSettlement', () => {
    const base = {
      status: SettlementStatus.COURIER_SETTLED,
      courier_id: '289',
      courier_amount: 50000,
    };
    expect(isCourierRemittedSettlement(base)).toBe(true);
    expect(
      isCourierRemittedSettlement({ ...base, courier_amount: -4000 }),
    ).toBe(true);
    expect(isCourierRemittedSettlement({ ...base, courier_amount: 0 })).toBe(
      false,
    );
    expect(isCourierRemittedSettlement({ ...base, courier_id: null })).toBe(
      false,
    );
    expect(isCourierRemittedSettlement({ ...base, courier_id: '0' })).toBe(
      false,
    );
    expect(
      isCourierRemittedSettlement({
        ...base,
        status: SettlementStatus.PENDING,
      }),
    ).toBe(false);
    expect(isCourierRemittedSettlement(null)).toBe(false);
  });
});
