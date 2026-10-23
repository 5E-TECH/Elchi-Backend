/**
 * y2RarzlT — superadmin (va kuryer) sotilgan buyurtmani «Bekor qilingan»
 * holatiga qaytaradi: `POST /orders/rollback/:id` + `target_status: cancelled`.
 *
 * Prod'da (eea0e0e) bu 400 «Invalid status transition: sold -> cancelled»
 * qaytarardi: rollback CANCELLED ni `updateFull` orqali yozardi, umumiy status
 * mashinasida esa SOLD → CANCELLED qirrasi yo'q. Mavjud rollback speclari
 * `updateFull` ni stub qilgani uchun buni ko'rmagan — bu yerda `updateFull`
 * HAQIQIY (status tekshiruvi, tracking, finance outbox bilan birga).
 */
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import {
  Cashbox_type,
  Operation_type,
  Order_status,
  SettlementStatus,
  Source_type,
  Where_deliver,
} from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';
import { Order } from '../entities/order.entity';

type Row = Record<string, unknown>;
type Enqueued = { cmd: string; payload: Row };
type Svc = OrderLifecycleService & Record<string, any>;

const SUPERADMIN = { id: '1', roles: ['superadmin'] };
const COURIER = { id: '289', roles: ['courier'], branch_id: '77' };

/** Kuryer 289 sotgan buyurtma: 165 000 − ulush 25 000 = 140 000. */
const SOLD_ORDER: Row = {
  id: '62',
  status: Order_status.SOLD,
  post_id: '9001',
  market_id: '501',
  customer_id: '801',
  operator_id: null,
  total_price: 165000,
  paid_online_amount: 0,
  sale_collectible_amount: 165000,
  paid_amount: 0,
  to_be_paid: 135000,
  where_deliver: Where_deliver.CENTER,
  market_tariff: 30000,
  courier_tariff: 25000,
  courier_share: 25000,
  branch_share: 0,
  branch_cashbox_amount: 0,
  extra_cost: 0,
  branch_id: '77',
  holder_type: 'COURIER',
  holder_branch_id: '77',
  holder_courier_id: '289',
  courier_id: '289',
  sold_at: '1759300000000',
  comment: null,
};

const pendingSettlement: Row = {
  order_id: '62',
  status: SettlementStatus.PENDING,
  courier_id: '289',
  branch_id: '77',
  market_id: '501',
  courier_amount: 140000,
  branch_amount: 140000,
  market_amount: 135000,
  isDeleted: false,
};

function makeService(orderOver: Row = {}) {
  const order: Row = { ...SOLD_ORDER, ...orderOver };
  const legs: Row[] = [];
  const enqueued: Enqueued[] = [];
  const saved: Row[] = [];
  const tracking: Row[] = [];

  const orderRepo = {
    // Rollback tranzaksiyasidagi qulf: status hali o'zgarmagan.
    findOne: jest.fn(() => Promise.resolve({ ...order })),
    save: jest.fn((row: Row) => {
      saved.push({ ...row });
      return Promise.resolve(row);
    }),
  };
  const manager = {
    getRepository: jest.fn((entity: unknown) =>
      entity === Order ? orderRepo : {},
    ),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager,
  };

  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    orderSettlementRepo: {
      findOne: jest.fn().mockResolvedValue(pendingSettlement),
    },
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '289' } })),
    },
    outbox: {
      enqueue: jest.fn((_target: string, cmd: string, payload: Row) => {
        enqueued.push({ cmd, payload });
        return Promise.resolve();
      }),
    },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: {
      auditActor: jest.fn(() => ({})),
      toTrackingRole: jest.fn(() => 'superadmin'),
      createTrackingEvent: jest.fn((row: Row) => {
        tracking.push(row);
        return Promise.resolve();
      }),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
    },
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
      getUserById: jest.fn().mockResolvedValue(null),
      getCashboxByUser: jest.fn((userId: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-${userId}`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
      getHqBranchId: jest.fn().mockResolvedValue('1'),
    },
    // Rollback ham, updateFull ham o'qiydi — har safar asl (sotilgan) nusxa.
    findById: jest.fn(() => Promise.resolve({ ...order })),
    updateCashboxBalance: jest.fn((leg: Row) => {
      legs.push(leg);
      return Promise.resolve();
    }),
    resetSettlementOnRollback: jest.fn().mockResolvedValue(undefined),
    mergePartialChildrenBack: jest.fn().mockResolvedValue(0),
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
  });

  return { s, legs, enqueued, saved, tracking, queryRunner };
}

const shape = (legs: Row[]) =>
  legs.map((leg) => ({
    user_id: leg.user_id,
    cashbox_type: leg.cashbox_type,
    amount: leg.amount,
    operation_type: leg.operation_type,
    source_type: leg.source_type,
  }));

const profitRollbacks = (enqueued: Enqueued[]) =>
  enqueued.filter(
    (e) =>
      e.cmd === 'finance.financial_balance.record' &&
      typeof e.payload.comment === 'string' &&
      e.payload.comment.includes('sell profit rollback'),
  );

describe('y2RarzlT — rollback «Bekor qilish» (sold → cancelled)', () => {
  it('⭐ superadmin: sotilgan buyurtma CANCELLED bo`ladi (ilgari 400 «sold -> cancelled»)', async () => {
    const h = makeService();

    const res = await h.s.rollbackOrderToWaiting(
      SUPERADMIN,
      '62',
      { target_status: 'cancelled' },
      'rb-62',
    );

    expect(res).toMatchObject({
      statusCode: 200,
      message: 'Order CANCELLED holatiga qaytarildi',
    });
    expect(h.queryRunner.commitTransaction).toHaveBeenCalled();
    expect(h.queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      status: Order_status.CANCELLED,
      sold_at: null,
      to_be_paid: 0,
      sale_collectible_amount: null,
      canceled_post_id: null,
      return_requested: false,
    });
    // Tarix: sold → cancelled yozuvi.
    expect(h.tracking).toEqual([
      expect.objectContaining({
        from_status: Order_status.SOLD,
        to_status: Order_status.CANCELLED,
      }),
    ]);
  });

  it('kassa oyoqlari WAITING ga qaytarishdagi bilan AYNAN bir xil teskari yoziladi', async () => {
    const toCancelled = makeService();
    const toWaiting = makeService();

    await toCancelled.s.rollbackOrderToWaiting(SUPERADMIN, '62', {
      target_status: 'cancelled',
    });
    await toWaiting.s.rollbackOrderToWaiting(SUPERADMIN, '62', {
      target_status: 'waiting',
    });

    expect(shape(toCancelled.legs)).toEqual(shape(toWaiting.legs));
    expect(shape(toCancelled.legs)).toEqual([
      {
        user_id: '501',
        cashbox_type: Cashbox_type.FOR_MARKET,
        amount: 135000,
        operation_type: Operation_type.EXPENSE,
        source_type: Source_type.CORRECTION,
      },
      {
        user_id: '289',
        cashbox_type: Cashbox_type.FOR_COURIER,
        amount: 140000,
        operation_type: Operation_type.EXPENSE,
        source_type: Source_type.CORRECTION,
      },
    ]);
  });

  it('sotuv foydasi ham qaytariladi (WAITING dagidek CORRECTION yozuvi)', async () => {
    const toCancelled = makeService();
    const toWaiting = makeService();

    await toCancelled.s.rollbackOrderToWaiting(SUPERADMIN, '62', {
      target_status: 'cancelled',
    });
    await toWaiting.s.rollbackOrderToWaiting(SUPERADMIN, '62', {
      target_status: 'waiting',
    });

    // Foyda = market tarifi 30 000 − kuryer ulushi 25 000 = 5 000.
    const rows = profitRollbacks(toCancelled.enqueued);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      amount: -5000,
      source_type: 'correction',
      order_id: '62',
      dedup_key: 'rollback:sale:1759300000000',
    });
    expect(profitRollbacks(toCancelled.enqueued)).toEqual(
      profitRollbacks(toWaiting.enqueued),
    );
  });

  it('superadmin: to`langan buyurtma ham bekorga qaytadi, paid_amount nolga tushadi', async () => {
    const h = makeService({
      status: Order_status.PAID,
      paid_amount: 135000,
      to_be_paid: 0,
    });

    await expect(
      h.s.rollbackOrderToWaiting(SUPERADMIN, '62', {
        target_status: 'cancelled',
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(h.saved[0]).toMatchObject({
      status: Order_status.CANCELLED,
      paid_amount: 0,
      to_be_paid: 0,
    });
  });

  it('kuryer: o`z sotuvini «Bekor qilish» bilan qaytara oladi', async () => {
    const h = makeService();

    await expect(
      h.s.rollbackOrderToWaiting(COURIER, '62', {
        target_status: 'cancelled',
      }),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(h.saved[0]).toMatchObject({ status: Order_status.CANCELLED });
  });
});

describe('y2RarzlT — oddiy (rollbacksiz) yo`l sotilgan buyurtmani bekor qila olmaydi', () => {
  it('updateFull status: cancelled — 400, xabar o`zbekcha', async () => {
    const h = makeService();

    const error = await h.s
      .updateFull(
        '62',
        { status: Order_status.CANCELLED },
        { id: '1', roles: ['superadmin'] },
        h.queryRunner.manager as never,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 400,
      message: "Buyurtma holatini o'zgartirib bo'lmaydi: sold -> cancelled",
    });
    expect(h.saved).toEqual([]);
  });
});
