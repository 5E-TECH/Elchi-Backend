import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import {
  normalizeSpecialCategories,
  Order_status,
  SPECIAL_CATEGORIES_MARKET_EDITABLE_STATUSES,
  SPECIAL_CATEGORIES_STAFF_EDITABLE_STATUSES,
} from '@app/common';
import { Order, Order_source } from '../entities/order.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * T8 (0OUcHZ7R) — maxsus belgilar, order-service qatlami:
 *  • `normalizeSpecialCategories` — kanonik tartib, noma'lum / takror → xato;
 *  • `create` — DTO'siz yo'llar (bot, hamkor) ham tekshiriladi, yo'q → `[]`;
 *  • `setSpecialCategories` — rol × holat qulfi (409 SPECIAL_CATEGORIES_LOCKED),
 *    market egaligi (403), yo'q (404), o'zgarmagan to'plam (`changed:false`,
 *    tracking/jurnal yo'q).
 */

type Row = Record<string, unknown>;
type Svc = OrderLifecycleService & Record<string, any>;
type RpcBody = { statusCode?: number; message?: string; code?: string };

async function rpcError(promise: Promise<unknown>): Promise<RpcBody> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as RpcBody;
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

const ALL_STATUSES = Object.values(Order_status);

const ADMIN = { id: '2', roles: ['admin'] };
const SUPERADMIN = { id: '1', roles: ['superadmin'] };
const REGISTRATOR = { id: '30', roles: ['registrator'] };
const MANAGER = { id: '31', roles: ['manager'] };
const BRANCH = { id: '32', roles: ['branch'] };
const MARKET = { id: '501', roles: ['market'], market_id: '501' };
const MARKET_OPERATOR = {
  id: '601',
  roles: ['market_operator'],
  market_id: '501',
};

describe('T8 normalizeSpecialCategories', () => {
  it('⭐ ["liquid","fragile"] → kanonik ["fragile","liquid"]', () => {
    expect(normalizeSpecialCategories(['liquid', 'fragile'])).toEqual({
      ok: true,
      value: ['fragile', 'liquid'],
    });
  });

  it.each([undefined, null])('%p → []', (input) => {
    expect(normalizeSpecialCategories(input)).toEqual({ ok: true, value: [] });
  });

  it('noma`lum kod → «Noma`lum maxsus belgi: glass»', () => {
    expect(normalizeSpecialCategories(['fragile', 'glass'])).toEqual({
      ok: false,
      message: "Noma'lum maxsus belgi: glass",
    });
  });

  it('takror kod → xato', () => {
    expect(normalizeSpecialCategories(['heavy', 'heavy'])).toMatchObject({
      ok: false,
      message: 'Maxsus belgi takrorlangan: heavy',
    });
  });

  it.each(['fragile', 5, { a: 1 }])('massiv emas (%p) → xato', (input) => {
    expect(normalizeSpecialCategories(input).ok).toBe(false);
  });

  it('massiv ichida satr bo`lmagan qiymat → xato', () => {
    expect(normalizeSpecialCategories([1])).toEqual({
      ok: false,
      message: "Noma'lum maxsus belgi: 1",
    });
  });

  it('barcha 7 kod — o`tadi, ortiq bo`lishi takrorsiz mumkin emas', () => {
    const all = [
      'documents',
      'heavy',
      'battery',
      'perishable',
      'liquid',
      'religious_book',
      'fragile',
    ];
    expect(normalizeSpecialCategories(all)).toEqual({
      ok: true,
      value: [...all].reverse(),
    });
  });
});

// ───────────────────────── yaratish ─────────────────────────

function makeCreateHarness() {
  const orderCreate = jest.fn((value: Row) => value);
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: unknown) =>
        entity === Order
          ? {
              create: orderCreate,
              save: jest.fn((value: Row) =>
                Promise.resolve({ id: '900', product_quantity: 0, ...value }),
              ),
              update: jest.fn(),
            }
          : {
              createQueryBuilder: () => ({
                insert: () => ({ values: () => ({ execute: jest.fn() }) }),
              }),
            },
      ),
    },
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    branchClient: { send: jest.fn(() => of({ data: null })) },
    lookup: {
      getHqBranchId: jest.fn().mockResolvedValue('1'),
      getBranchAssignmentByUserStrict: jest.fn().mockResolvedValue(null),
    },
    custody: {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'system'),
      auditActor: jest.fn(() => ({})),
    },
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    findById: jest.fn().mockResolvedValue({ id: '900' }),
  });
  return { s, orderCreate, queryRunner };
}

const BASE_DTO = {
  market_id: '501',
  customer_id: '801',
  total_price: 100000,
  district_id: '12',
  region_id: '3',
  items: [{ product_id: null, product_name: 'Kitob', quantity: 1 }],
};

describe('T8 create — special_categories', () => {
  it('⭐ ["liquid","fragile"] kanonik tartibda yoziladi', async () => {
    const h = makeCreateHarness();
    await h.s.create(
      { ...BASE_DTO, special_categories: ['liquid', 'fragile'] },
      ADMIN,
    );
    expect(h.orderCreate.mock.calls[0][0]).toMatchObject({
      special_categories: ['fragile', 'liquid'],
    });
  });

  it('berilmasa (bot / eski mijoz) — []', async () => {
    const h = makeCreateHarness();
    await h.s.create(BASE_DTO, ADMIN);
    expect(h.orderCreate.mock.calls[0][0]).toMatchObject({
      special_categories: [],
    });
  });

  it('market (imtiyozsiz) ham yubora oladi — olib tashlanmaydi', async () => {
    const h = makeCreateHarness();
    await h.s.create(
      { ...BASE_DTO, special_categories: ['religious_book'] },
      { id: '501', roles: ['market'] },
    );
    expect(h.orderCreate.mock.calls[0][0]).toMatchObject({
      special_categories: ['religious_book'],
    });
  });

  it('hamkor (DTO`siz yo`l): noma`lum kod → 400, tranzaksiya OCHILMAYDI', async () => {
    const h = makeCreateHarness();
    const body = await rpcError(
      h.s.create(
        {
          ...BASE_DTO,
          source: Order_source.EXTERNAL,
          external_id: 'ord-1',
          special_categories: ['glass'],
        },
        { id: 'partner:7', roles: ['superadmin'] },
      ),
    );
    expect(body).toMatchObject({
      statusCode: 400,
      message: "Noma'lum maxsus belgi: glass",
    });
    expect(h.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(h.orderCreate).not.toHaveBeenCalled();
  });

  it('takror kod → 400', async () => {
    const h = makeCreateHarness();
    const body = await rpcError(
      h.s.create(
        { ...BASE_DTO, special_categories: ['heavy', 'heavy'] },
        ADMIN,
      ),
    );
    expect(body.statusCode).toBe(400);
  });
});

// ─────────────────── setSpecialCategories ───────────────────

function makeSetHarness(order: Row | null) {
  const findOne = jest.fn().mockResolvedValue(order);
  const update = jest.fn().mockResolvedValue({ affected: 1 });
  const trackingRepo = { marker: 'tracking' };
  const manager = {
    getRepository: jest.fn((entity: unknown) =>
      entity === Order
        ? { findOne, update }
        : entity === OrderTracking
          ? trackingRepo
          : {},
    ),
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  const custody = {
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    toTrackingRole: jest.fn(() => 'admin'),
    auditActor: jest.fn((r: { id?: string }) => ({ user_id: r?.id ?? null })),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  Object.assign(s, {
    dataSource: {
      transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)),
    },
    custody,
    activityLog,
  });
  return { s, findOne, update, custody, activityLog, trackingRepo };
}

const orderRow = (status: Order_status, extra: Row = {}): Row => ({
  id: '120',
  market_id: '501',
  status,
  special_categories: [],
  ...extra,
});

describe('T8 setSpecialCategories — holat qulfi', () => {
  const staff = [ADMIN, SUPERADMIN, REGISTRATOR, MANAGER, BRANCH];
  const market = [MARKET, MARKET_OPERATOR];

  const cases: Array<[string, Row, Order_status, boolean]> = [];
  for (const status of ALL_STATUSES) {
    for (const requester of staff) {
      cases.push([
        requester.roles[0],
        requester,
        status,
        SPECIAL_CATEGORIES_STAFF_EDITABLE_STATUSES.includes(status),
      ]);
    }
    for (const requester of market) {
      cases.push([
        requester.roles[0],
        requester,
        status,
        SPECIAL_CATEGORIES_MARKET_EDITABLE_STATUSES.includes(status),
      ]);
    }
  }

  it.each(cases)('%s @ %s → ruxsat=%s', async (_r, requester, status, ok) => {
    const h = makeSetHarness(orderRow(status));
    const call = h.s.setSpecialCategories('120', ['fragile'], requester);
    if (ok) {
      await expect(call).resolves.toEqual({
        statusCode: 200,
        message: 'success',
        data: { id: '120', special_categories: ['fragile'], changed: true },
      });
      expect(h.update).toHaveBeenCalledWith(
        { id: '120' },
        { special_categories: ['fragile'] },
      );
    } else {
      await expect(rpcError(call)).resolves.toEqual({
        statusCode: 409,
        code: 'SPECIAL_CATEGORIES_LOCKED',
        message: "Bu holatda maxsus belgini o'zgartirib bo'lmaydi",
      });
      expect(h.update).not.toHaveBeenCalled();
      expect(h.custody.createTrackingEvent).not.toHaveBeenCalled();
      expect(h.activityLog.log).not.toHaveBeenCalled();
    }
  });

  it('jadval: yakunlangan holatlar HECH KIMGA ochiq emas', () => {
    for (const status of [
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
      Order_status.CLOSED,
      Order_status.RETURNED_TO_MARKET,
    ]) {
      expect(SPECIAL_CATEGORIES_STAFF_EDITABLE_STATUSES).not.toContain(status);
      expect(SPECIAL_CATEGORIES_MARKET_EDITABLE_STATUSES).not.toContain(status);
    }
    // Har holat ikki ro'yxatdan biriga tegishli yoki yakunlangan — yangi
    // holat qo'shilsa shu spec ogohlantiradi (ro'yxatda yo'q = qulf).
    expect(
      ALL_STATUSES.length - SPECIAL_CATEGORIES_STAFF_EDITABLE_STATUSES.length,
    ).toBe(5);
  });
});

describe('T8 setSpecialCategories — tarix, doira, xatolar', () => {
  it('⭐ market @ new: changed:true + tracking + jurnal (kanonik tartibda)', async () => {
    const h = makeSetHarness(
      orderRow(Order_status.NEW, { special_categories: ['heavy'] }),
    );

    const res = await h.s.setSpecialCategories(
      '120',
      ['liquid', 'fragile'],
      MARKET,
    );

    expect(res.data).toEqual({
      id: '120',
      special_categories: ['fragile', 'liquid'],
      changed: true,
    });
    expect(h.findOne).toHaveBeenCalledWith({
      where: { id: '120', isDeleted: false },
      lock: { mode: 'pessimistic_write' },
    });
    expect(h.custody.createTrackingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: '120',
        from_status: Order_status.NEW,
        to_status: Order_status.NEW,
        action: 'special_categories_changed',
        old_value: { special_categories: ['heavy'] },
        new_value: { special_categories: ['fragile', 'liquid'] },
        changed_by: '501',
      }),
      h.trackingRepo,
    );
    expect(h.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Order',
        entity_id: '120',
        action: 'order.special_categories_changed',
        old_value: { special_categories: ['heavy'] },
        new_value: { special_categories: ['fragile', 'liquid'] },
        metadata: { status: Order_status.NEW },
      }),
    );
  });

  it('⭐ o`sha to`plam (boshqa tartibda) → changed:false, hech narsa yozilmaydi', async () => {
    const h = makeSetHarness(
      orderRow(Order_status.NEW, { special_categories: ['fragile', 'liquid'] }),
    );

    const res = await h.s.setSpecialCategories(
      '120',
      ['liquid', 'fragile'],
      MARKET,
    );

    expect(res.data).toEqual({
      id: '120',
      special_categories: ['fragile', 'liquid'],
      changed: false,
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.custody.createTrackingEvent).not.toHaveBeenCalled();
    expect(h.activityLog.log).not.toHaveBeenCalled();
  });

  it('o`zgarmagan to`plam qulflangan holatda ham — 409 emas, changed:false', async () => {
    const h = makeSetHarness(
      orderRow(Order_status.SOLD, { special_categories: ['fragile'] }),
    );
    const res = await h.s.setSpecialCategories('120', ['fragile'], ADMIN);
    expect(res.data.changed).toBe(false);
  });

  it('[] — hammasini olib tashlash', async () => {
    const h = makeSetHarness(
      orderRow(Order_status.CANCELLED, { special_categories: ['battery'] }),
    );
    const res = await h.s.setSpecialCategories('120', [], ADMIN);
    expect(res.data).toMatchObject({ special_categories: [], changed: true });
  });

  it('begona market → 403, yozuv yo`q', async () => {
    const h = makeSetHarness(orderRow(Order_status.NEW, { market_id: '777' }));
    const body = await rpcError(
      h.s.setSpecialCategories('120', ['fragile'], MARKET),
    );
    expect(body.statusCode).toBe(403);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('begona market operatori → 403', async () => {
    const h = makeSetHarness(orderRow(Order_status.NEW, { market_id: '777' }));
    const body = await rpcError(
      h.s.setSpecialCategories('120', ['fragile'], MARKET_OPERATOR),
    );
    expect(body.statusCode).toBe(403);
  });

  it.each([
    ['kuryer', { id: '9', roles: ['courier'] }],
    ['investor', { id: '9', roles: ['investor'] }],
    ['market_id siz market', { id: '501', roles: ['market'] }],
    ['so`rovchisiz', {}],
  ])('%s → 403 (fail-closed)', async (_n, requester) => {
    const h = makeSetHarness(orderRow(Order_status.NEW));
    const body = await rpcError(
      h.s.setSpecialCategories('120', ['fragile'], requester),
    );
    expect(body.statusCode).toBe(403);
    expect(h.findOne).not.toHaveBeenCalled();
  });

  it('yo`q / o`chirilgan buyurtma → 404', async () => {
    const h = makeSetHarness(null);
    const body = await rpcError(
      h.s.setSpecialCategories('999', ['fragile'], ADMIN),
    );
    expect(body.statusCode).toBe(404);
  });

  it('raqam bo`lmagan id → 404 (DB`ga bormaydi)', async () => {
    const h = makeSetHarness(orderRow(Order_status.NEW));
    const body = await rpcError(
      h.s.setSpecialCategories('abc', ['fragile'], ADMIN),
    );
    expect(body.statusCode).toBe(404);
    expect(h.findOne).not.toHaveBeenCalled();
  });

  it.each([
    [['glass']],
    [['fragile', 'fragile']],
    ['fragile'],
    [undefined],
    [null],
  ])('%p → 400 (DB`ga bormaydi)', async (input) => {
    const h = makeSetHarness(orderRow(Order_status.NEW));
    const body = await rpcError(h.s.setSpecialCategories('120', input, ADMIN));
    expect(body.statusCode).toBe(400);
    expect(h.findOne).not.toHaveBeenCalled();
  });
});
