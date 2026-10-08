/**
 * ANDIJON E2E (BeePost→Elchi, 2026-09-24) — sotish / bekor qilish / qisman
 * sotish yo'llaridagi server darvozalari.
 *
 *   ZsPLevZZ — sotuvda `paidAmount` buyurtmani "to'landi" qilardi, kassaga esa
 *              hech narsa yozilmasdi (ikki daftar ajralardi) → endi 400.
 *   T0UGh8bL — bekor qilishda `paidAmount` jimgina yo'qolardi → >0 bo'lsa 400.
 *   PUvKXWVw — bekor qilish sababi ixtiyoriy erkin matn edi → yopiq ro'yxat,
 *              `return_reason` ga yoziladi, sababsiz 400.
 *   pLmAsEsj — bekor qilingan buyurtmada `to_be_paid` qolardi → 0.
 *   UlhtEpsI — qisman sotuvda hamma qatorni 0 qilish mumkin edi → 400.
 *
 * Harness `order-service.extra-cost-settlement.spec.ts` bilan bir uslub: faqat
 * pul/validatsiya mantig'i, RMQ/TypeORM eng kichik ko'rinishda.
 */
import { of } from 'rxjs';
import { RpcException } from '@nestjs/microservices';
import {
  CancelReason,
  Cashbox_type,
  Order_status,
  Where_deliver,
} from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order } from './entities/order.entity';
import { OrderSettlement } from './entities/order-settlement.entity';

type Row = Record<string, unknown>;

const ORDER = {
  id: '7001',
  status: Order_status.WAITING,
  post_id: '9001',
  market_id: '501',
  total_price: 250000,
  paid_online_amount: 0,
  paid_amount: 0,
  where_deliver: Where_deliver.CENTER,
  branch_id: '77',
  home_branch_id: '77',
  holder_branch_id: '77',
  comment: null,
} as unknown as Order;

async function rpcError(
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; message?: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as { statusCode?: number; message?: string };
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

function makeService(opts: { items?: Row[] } = {}) {
  const cashboxLegs: Row[] = [];
  const settlementRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: Row) => row),
    save: jest.fn((row: Row) => Promise.resolve(row)),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const tx = {
    getRepository: jest.fn((entity: unknown) =>
      entity === OrderSettlement ? settlementRepo : { update: jest.fn() },
    ),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: tx,
  };

  const s = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService & Record<string, any>;

  Object.assign(s, {
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '301' } })),
    },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
    orderItemRepo: { find: jest.fn().mockResolvedValue(opts.items ?? []) },
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
          id: '301',
          tariff_center: 30000,
          tariff_home: 50000,
          can_add_extra_cost: true,
          can_sell_cancel: true,
        },
      ]),
      getCashboxByUser: jest.fn((_id: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-cashbox`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue('77'),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
    },
    findById: jest.fn().mockResolvedValue(ORDER),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    updateFull: jest.fn().mockResolvedValue(undefined),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
    updateCashboxBalance: jest.fn((leg: Row) => {
      cashboxLegs.push(leg);
      return Promise.resolve(undefined);
    }),
  });

  const requester = { id: '301', roles: ['courier'], branch_id: '77' };
  const updateFull = (s as Record<string, jest.Mock>).updateFull;
  return { s, requester, cashboxLegs, updateFull };
}

describe('ZsPLevZZ — sotuvda paidAmount qabul qilinmaydi', () => {
  it('⭐ paidAmount > 0 — 400, hech qanday kassa oyog`i yozilmaydi', async () => {
    const { s, requester, cashboxLegs, updateFull } = makeService();

    const error = await rpcError(
      s.sellOrder(requester, '7001', { paidAmount: 105000 }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('paidAmount');
    expect(cashboxLegs).toHaveLength(0);
    expect(updateFull).not.toHaveBeenCalled();
  });

  it('paidAmount 0 yoki yo`q — avvalgidek SOLD, paid_amount 0 (regressiya)', async () => {
    for (const dto of [{ paidAmount: 0 }, {}]) {
      const { s, requester, cashboxLegs, updateFull } = makeService();

      await s.sellOrder(requester, '7001', dto);

      expect(updateFull).toHaveBeenCalledWith(
        '7001',
        expect.objectContaining({
          status: Order_status.SOLD,
          paid_amount: 0,
          to_be_paid: 205000,
        }),
        expect.anything(),
        expect.anything(),
      );
      // Market oyog'i — to'liq daromad, holat esa "to'lanmagan": ikki daftar
      // bir xil gapiradi.
      expect(
        cashboxLegs.find((leg) => leg.cashbox_type === Cashbox_type.FOR_MARKET),
      ).toMatchObject({ amount: 205000, operation_type: 'income' });
    }
  });
});

describe('T0UGh8bL / PUvKXWVw / pLmAsEsj — bekor qilish', () => {
  it('⭐ sababsiz (reason ham, izoh ham yo`q) — 400', async () => {
    const { s, requester, updateFull } = makeService();

    const error = await rpcError(s.cancelOrder(requester, '7001', {}));

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('sababi majburiy');
    expect(updateFull).not.toHaveBeenCalled();
  });

  it('⭐ reason=CUSTOMER_REFUSED — return_reason yoziladi, to_be_paid 0', async () => {
    const { s, requester, updateFull } = makeService();

    await s.cancelOrder(requester, '7001', {
      reason: CancelReason.CUSTOMER_REFUSED,
    });

    expect(updateFull).toHaveBeenCalledWith(
      '7001',
      expect.objectContaining({
        status: Order_status.CANCELLED,
        return_reason: CancelReason.CUSTOMER_REFUSED,
        to_be_paid: 0,
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('reason=OTHER izohsiz — 400; izoh bilan — o`tadi', async () => {
    const first = makeService();
    const error = await rpcError(
      first.s.cancelOrder(first.requester, '7001', {
        reason: CancelReason.OTHER,
        comment: '   ',
      }),
    );
    expect(error.statusCode).toBe(400);

    const second = makeService();
    await second.s.cancelOrder(second.requester, '7001', {
      reason: CancelReason.OTHER,
      comment: 'Mijoz boshqa shaharga ketib qolgan',
    });
    expect(second.updateFull).toHaveBeenCalledWith(
      '7001',
      expect.objectContaining({ return_reason: CancelReason.OTHER }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('ro`yxatda yo`q sabab — 400', async () => {
    const { s, requester } = makeService();

    const error = await rpcError(
      s.cancelOrder(requester, '7001', { reason: 'BORED' }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('CUSTOMER_REFUSED');
  });

  it('eski klient: reason yo`q, izoh bor — OTHER bo`lib yoziladi', async () => {
    const { s, requester, updateFull } = makeService();

    await s.cancelOrder(requester, '7001', { comment: 'Mijoz olmadi' });

    expect(updateFull).toHaveBeenCalledWith(
      '7001',
      expect.objectContaining({ return_reason: CancelReason.OTHER }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('⭐ paidAmount > 0 — 400 (jimgina yo`qolmaydi); 0 — zararsiz', async () => {
    const first = makeService();
    const error = await rpcError(
      first.s.cancelOrder(first.requester, '7001', {
        comment: 'Mijoz olmadi',
        paidAmount: 99999,
      }),
    );
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('paidAmount');
    expect(first.updateFull).not.toHaveBeenCalled();

    const second = makeService();
    await second.s.cancelOrder(second.requester, '7001', {
      comment: 'Mijoz olmadi',
      paidAmount: 0,
    });
    expect(second.updateFull).toHaveBeenCalled();
  });

  it('bu qoidadan oldin ochilgan market tasdig`i sababsiz ham yakunlanadi', async () => {
    const { s, requester, updateFull } = makeService();

    await s.cancelOrder(requester, '7001', {
      extraCost: 5000,
      extraCostApproved: true,
    });

    expect(updateFull).toHaveBeenCalledWith(
      '7001',
      expect.objectContaining({ return_reason: CancelReason.OTHER }),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('UlhtEpsI — qisman sotuvda kamida bitta mahsulot sotiladi', () => {
  const items = [
    { id: '5501', product_id: '10', quantity: 2, product_name: null },
  ];

  it('⭐ hamma qator 0 — 400, tranzaksiya ochilmaydi', async () => {
    const { s, requester, cashboxLegs } = makeService({ items });

    const error = await rpcError(
      s.partlySellOrder(requester, '7001', {
        order_item_info: [{ order_item_id: '5501', quantity: 0 }],
        totalPrice: 90000,
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('kamida bitta mahsulot sotilishi kerak');
    expect(
      (s as Record<string, jest.Mock>).lockWaitingOrder,
    ).not.toHaveBeenCalled();
    expect(cashboxLegs).toHaveLength(0);
  });

  it('takroriy qator yig`indini shishirmaydi — baribir 400', async () => {
    const { s, requester } = makeService({ items });

    const error = await rpcError(
      s.partlySellOrder(requester, '7001', {
        order_item_info: [
          { order_item_id: '5501', quantity: 0 },
          { product_id: '10', quantity: 1 },
        ],
        totalPrice: 90000,
      }),
    );

    expect(error.statusCode).toBe(400);
  });

  it('2 donadan 1 tasi sotilsa darvoza o`tkazadi', async () => {
    const { s, requester } = makeService({ items });

    await s
      .partlySellOrder(requester, '7001', {
        order_item_info: [{ order_item_id: '5501', quantity: 1 }],
        totalPrice: 125000,
      })
      // Tranzaksiya ichidagi qolgan qadamlar bu harness'da taqlid
      // qilinmagan — faqat darvozadan o'tgani tekshiriladi.
      .catch(() => undefined);

    expect(
      (s as Record<string, jest.Mock>).lockWaitingOrder,
    ).toHaveBeenCalled();
  });

  it('totalPrice eski narxdan katta — 400 (mavjud chegara)', async () => {
    const { s, requester } = makeService({ items });

    const error = await rpcError(
      s.partlySellOrder(requester, '7001', {
        order_item_info: [{ order_item_id: '5501', quantity: 1 }],
        totalPrice: 300000,
      }),
    );

    expect(error.statusCode).toBe(400);
  });
});
