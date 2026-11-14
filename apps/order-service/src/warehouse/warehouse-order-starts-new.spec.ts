/**
 * Ega 2026-11-13: «Ombordan maxsulot yaratsa ham yangi bo'lishi kerak oddiy
 * buyurtma yaratgandey HQ ning ishchilari yani superadmin, admin, registrator
 * yaratsa».
 *
 * HQ xodimi ombordan yaratgan buyurtma `new` bo'lib HQ'da turadi (yaratish —
 * `lifecycle/hq-warehouse-order.VkKDSNNn.spec.ts`). Bu yerda:
 *   - qabul (`receiveNewOrders`): Markaziy VA viloyat ombori buyurtmasi —
 *     oddiy HQ qabuli, hudud pochtasiga tushadi. Ega 2026-11-14: «1 ta pochta
 *     bor edi Toshkentga 2 ta buyurtmasi bor 5 ta yaratdim … 7 ta
 *     bo'lmadiku» (13-noyabrdagi «viloyat ombori — pochtasiz» yo'li xato edi);
 *   - `new` ombor buyurtmasida summa va mahsulot qulf (band shu tarkibga).
 */
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: jest.fn() };
});

import { RpcException } from '@nestjs/microservices';
import { Order_status, rmqSend as rmqSendFn } from '@app/common';
import { OrderLifecycleService } from '../lifecycle/order-lifecycle.service';
import { OrderHolderType, Order_source } from '../entities/order.entity';
import { isHqStaffWarehouseCreator } from './order-warehouse.service';

const rmqSend = rmqSendFn as unknown as jest.Mock;

type Row = Record<string, unknown>;
type RpcBody = { statusCode?: number; message?: string };

const HQ_ID = '1';
const WAREHOUSE_BRANCH = '11';
const SUPERADMIN = { id: '1', roles: ['superadmin'] };
const REGISTRATOR = { id: '301', roles: ['registrator'] };

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

const order = (over: Row = {}): Row => ({
  id: '66',
  status: Order_status.NEW,
  source: Order_source.INTERNAL,
  customer_id: 'c1',
  district_id: '12',
  region_id: null,
  total_price: 100000,
  branch_id: HQ_ID,
  home_branch_id: HQ_ID,
  holder_type: OrderHolderType.HQ,
  holder_branch_id: null,
  holder_courier_id: null,
  fulfillment_source: 'HQ',
  warehouse_id: null,
  post_id: null,
  current_batch_id: null,
  ...over,
});

/** HQ xodimi yaratgan, qabulni kutayotgan viloyat ombori buyurtmasi. */
const REGIONAL_WH = order({
  id: '483',
  fulfillment_source: 'WAREHOUSE',
  warehouse_id: '3',
  home_branch_id: WAREHOUSE_BRANCH,
});
/** HQ xodimi yaratgan Markaziy ombor buyurtmasi (uyi HQ). */
const HQ_WH = order({
  id: '490',
  fulfillment_source: 'WAREHOUSE',
  warehouse_id: '9',
  home_branch_id: HQ_ID,
});
const HQ_PLAIN = order({ id: '66' });

function makeSvc(
  rows: Row[],
  opts: { scope?: string | null; hqId?: string | null } = {},
) {
  rmqSend.mockReset();
  rmqSend.mockImplementation(
    (
      _client: unknown,
      pattern: { cmd: string },
      payload: { orders?: Array<{ order_id: string }> },
    ) => {
      switch (pattern.cmd) {
        case 'identity.customer.find_by_ids':
          return Promise.resolve({ data: [{ id: 'c1' }] });
        case 'logistics.district.find_by_ids':
          return Promise.resolve({
            data: [{ id: '12', assigned_region: '5' }],
          });
        case 'logistics.post.receive_orders':
          return Promise.resolve({
            data: (payload.orders ?? []).map((row) => ({
              order_id: String(row.order_id),
              post_id: '9001',
            })),
          });
        default:
          return Promise.resolve(null);
      }
    },
  );

  const sets: Array<{ id: string; set: Row }> = [];
  let pendingSet: Row = {};
  const qb = {
    update: jest.fn(() => qb),
    set: jest.fn((value: Row) => {
      pendingSet = value;
      return qb;
    }),
    where: jest.fn((_sql: string, params: { id: string }) => {
      sets.push({ id: String(params.id), set: pendingSet });
      return qb;
    }),
    execute: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      createQueryBuilder: jest.fn(() => qb),
      getRepository: jest.fn(() => ({})),
    },
  };
  const custody = {
    createTrackingEvent: jest.fn().mockResolvedValue(undefined),
    createCustodyEvent: jest.fn().mockResolvedValue(undefined),
    toTrackingRole: jest.fn((roles?: string[]) => roles?.[0] ?? 'system'),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const s = Object.create(OrderLifecycleService.prototype) as Record<
    string,
    any
  >;
  Object.assign(s, {
    orderRepo: {
      find: jest.fn(() => Promise.resolve(rows.map((r) => ({ ...r })))),
    },
    identityClient: {},
    logisticsClient: {},
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    resolveReceiveBranchScope: jest
      .fn()
      .mockResolvedValue(opts.scope === undefined ? null : opts.scope),
    lookup: {
      getHqBranchId: jest
        .fn()
        .mockResolvedValue(opts.hqId === undefined ? HQ_ID : opts.hqId),
    },
    custody,
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    activityLog,
  });
  const receive = (
    requester: { id: string; roles: string[] },
    ids = rows.map((r) => String(r.id)),
  ) =>
    (s as unknown as OrderLifecycleService).receiveNewOrders(
      ids,
      undefined,
      requester,
    );
  const sentCmds = () =>
    rmqSend.mock.calls.map((call) => (call[1] as { cmd: string }).cmd);
  const postPayload = () =>
    rmqSend.mock.calls.find(
      (call) =>
        (call[1] as { cmd: string }).cmd === 'logistics.post.receive_orders',
    )?.[2] as { orders: Array<Record<string, unknown>> } | undefined;
  const setFor = (id: string) => sets.find((row) => row.id === id)?.set;
  return {
    s,
    receive,
    sentCmds,
    postPayload,
    setFor,
    queryRunner,
    custody,
    activityLog,
  };
}

describe('2026-11-13 — isHqStaffWarehouseCreator', () => {
  it.each([
    [['superadmin'], true],
    [['admin'], true],
    [['registrator'], true],
    [['REGISTRATOR'], true],
    [['market'], false],
    [['market_operator'], false],
    [['manager'], false],
    [['courier'], false],
    // Market tomoni ustun: market roli bo'lsa — avvalgidek darhol qabul.
    [['registrator', 'market'], false],
    [[], false],
  ])('%j → %s', (roles, expected) => {
    expect(isHqStaffWarehouseCreator({ id: '5', roles })).toBe(expected);
  });

  it('so`rovchi yo`q (ichki yo`l) — false', () => {
    expect(isHqStaffWarehouseCreator(undefined)).toBe(false);
    expect(isHqStaffWarehouseCreator(null)).toBe(false);
  });
});

describe('2026-11-13 — receiveNewOrders: HQ xodimi ombordan yaratgan buyurtma', () => {
  it('⭐ superadmin: viloyat ombori buyurtmasi → RECEIVED, hudud pochtasiga (oddiy buyurtmadek), egalik HQ, uyi — ombor filiali', async () => {
    const h = makeSvc([REGIONAL_WH]);

    await expect(h.receive(SUPERADMIN)).resolves.toMatchObject({
      statusCode: 200,
    });

    expect(h.postPayload()?.orders).toEqual([
      {
        order_id: '483',
        assigned_region: '5',
        assigned_branch: HQ_ID,
        total_price: 100000,
      },
    ]);
    expect(h.setFor('483')).toMatchObject({
      status: Order_status.RECEIVED,
      post_id: '9001',
      holder_type: OrderHolderType.HQ,
      holder_branch_id: null,
      holder_courier_id: null,
      // YfWZXu9g: bo'sh hudud tumandan to'ldiriladi (bugungidek).
      region_id: '5',
    });
    // Filial va uy (ombor filiali) o'zgarmaydi — ombor hisobi uyga tayanadi.
    expect(h.setFor('483')).not.toHaveProperty('branch_id');
    expect(h.setFor('483')).not.toHaveProperty('home_branch_id');
    expect(h.custody.createTrackingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: '483',
        from_status: Order_status.NEW,
        to_status: Order_status.RECEIVED,
        note: 'Order assigned to post',
      }),
      expect.anything(),
    );
    // HQ'da turgan edi, HQ'da qoladi — egalik hodisasi yo'q.
    expect(h.custody.createCustodyEvent).not.toHaveBeenCalled();
    expect(h.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: '483',
        new_value: { status: Order_status.RECEIVED, post_id: '9001' },
      }),
    );
    expect(h.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('⭐ HQ registratori (doira — HQ) ham qabul qiladi: hudud pochtasiga', async () => {
    const h = makeSvc([REGIONAL_WH], { scope: HQ_ID });

    await expect(h.receive(REGISTRATOR)).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(h.sentCmds()).toContain('logistics.post.receive_orders');
    expect(h.setFor('483')).toMatchObject({
      status: Order_status.RECEIVED,
      post_id: '9001',
    });
    expect(h.setFor('483')).not.toHaveProperty('branch_id');
  });

  it('⭐ oddiy buyurtma + 5 ta viloyat ombori buyurtmasi bir qabulda → hammasi o`sha hudud pochtasiga (test #489–#493)', async () => {
    const warehouseRows = ['489', '490', '491', '492', '493'].map((id) =>
      order({ ...REGIONAL_WH, id }),
    );
    const h = makeSvc([HQ_PLAIN, ...warehouseRows]);

    await h.receive(SUPERADMIN);

    expect((h.postPayload()?.orders ?? []).map((row) => row.order_id)).toEqual([
      '66',
      '489',
      '490',
      '491',
      '492',
      '493',
    ]);
    for (const id of ['66', '489', '490', '491', '492', '493']) {
      expect(h.setFor(id)).toMatchObject({
        status: Order_status.RECEIVED,
        post_id: '9001',
        holder_type: OrderHolderType.HQ,
      });
      expect(h.setFor(id)).not.toHaveProperty('branch_id');
    }
  });

  it('⭐ Markaziy ombor buyurtmasi — oddiy HQ qabuli: hudud pochtasiga (HQ filiali), egalik HQ, filial o`zgarmaydi', async () => {
    const h = makeSvc([HQ_WH]);

    await h.receive(SUPERADMIN);

    expect(h.postPayload()?.orders).toEqual([
      {
        order_id: '490',
        assigned_region: '5',
        assigned_branch: HQ_ID,
        total_price: 100000,
      },
    ]);
    expect(h.setFor('490')).toMatchObject({
      status: Order_status.RECEIVED,
      post_id: '9001',
      holder_type: OrderHolderType.HQ,
    });
    expect(h.setFor('490')).not.toHaveProperty('branch_id');
    expect(h.custody.createTrackingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'Order assigned to post' }),
      expect.anything(),
    );
  });

  it('HQ id aniqlanmasa ham ombor buyurtmasi oddiy qabul qilinadi (HQ id so`ralmaydi)', async () => {
    const h = makeSvc([REGIONAL_WH, HQ_PLAIN], { hqId: null });

    await expect(h.receive(SUPERADMIN)).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(h.s.lookup.getHqBranchId).not.toHaveBeenCalled();
    expect(h.setFor('483')).toMatchObject({ post_id: '9001' });
  });

  it('filialda turgan NEW ombor buyurtmasi (masalan tranzit) — avvalgi qoida: HQ qabuli 400', async () => {
    const atBranch = order({
      ...REGIONAL_WH,
      branch_id: WAREHOUSE_BRANCH,
      holder_type: OrderHolderType.BRANCH,
      holder_branch_id: WAREHOUSE_BRANCH,
    });
    const h = makeSvc([atBranch]);

    const error = await rpcError(h.receive(SUPERADMIN));

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("uni o'sha filial qabul qiladi");
    expect(h.queryRunner.startTransaction).not.toHaveBeenCalled();
  });
});

describe('2026-11-13 — `new` ombor buyurtmasi: summa va mahsulot qulf', () => {
  const svc = () =>
    Object.create(OrderLifecycleService.prototype) as Record<string, any>;
  const stored = (over: Row = {}) => ({
    id: '483',
    status: Order_status.NEW,
    fulfillment_source: 'WAREHOUSE',
    total_price: 100000,
    paid_online_amount: 0,
    market_tariff: null,
    items: [{ product_id: '142', product_name: null, quantity: 2 }],
    ...over,
  });
  const assertEditable = (orderRow: Row, dto: Row) => () =>
    svc().assertCommercialFieldsEditable(orderRow, dto);
  const errorOf = (fn: () => void): RpcBody => {
    try {
      fn();
    } catch (error) {
      if (error instanceof RpcException) return error.getError() as RpcBody;
      throw error;
    }
    throw new Error('RpcException kutilgan edi');
  };

  it.each([
    ['summa', { total_price: 120000 }],
    ['oldindan to`langan qism', { paid_online_amount: 5000 }],
    ['mahsulot soni', { items: [{ product_id: '142', quantity: 3 }] }],
    ['boshqa mahsulot', { items: [{ product_id: '150', quantity: 2 }] }],
  ])('⭐ %s o`zgarsa — 400 «omborda band qilingan»', (_label, dto) => {
    const error = errorOf(assertEditable(stored(), dto));
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(
      "Mahsulotlar omborda band qilingan — summa va mahsulot sonini o'zgartirib bo'lmaydi",
    );
  });

  it('o`zgarishsiz qiymatlar va market tarifi — o`tadi (oddiy `new` dagidek)', () => {
    expect(
      assertEditable(stored(), {
        total_price: 100000,
        items: [{ product_id: '142', quantity: 2 }],
        market_tariff: 25000,
      }),
    ).not.toThrow();
  });

  it('oddiy (HQ) `new` buyurtma — bugungidek tahrirlanadi', () => {
    expect(
      assertEditable(stored({ fulfillment_source: 'HQ' }), {
        total_price: 120000,
        items: [{ product_id: '150', quantity: 5 }],
      }),
    ).not.toThrow();
  });

  it('qabul qilingan ombor buyurtmasi — avvalgi matn', () => {
    const error = errorOf(
      assertEditable(stored({ status: Order_status.RECEIVED }), {
        total_price: 120000,
      }),
    );
    expect(error.message).toBe(
      "HQ qabul qilgan buyurtmaning summasi va mahsulot sonini o'zgartirib bo'lmaydi",
    );
  });
});
