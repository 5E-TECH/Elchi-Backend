/**
 * YfWZXu9g — HQ qabuli (`receiveNewOrders`) bo'sh `order.region_id` ni
 * tumandan to'ldiradi.
 *
 * MUAMMO (jonli E2E, buyurtma #31). HQ'da yaratilgan (region_id
 * yuborilmagan) buyurtma qabul qilinganda hudud tumandan aniqlanib FAQAT
 * pochtaga uzatilardi, buyurtmaga yozilmasdi — `order.region_id` NULL
 * qolardi va filialga dispatch shu bo'sh hududga tayanardi (500).
 * Dispatch tomoni LC-13 da yopilgan (manba pochta hududi → buyurtma hududi
 * → aks holda 400; `branch-service/src/fix3-branch-service.spec.ts`).
 */
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: jest.fn() };
});

import { RpcException } from '@nestjs/microservices';
import { Order_status, rmqSend as rmqSendFn } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderHolderType, Order_source } from './entities/order.entity';

const rmqSend = rmqSendFn as unknown as jest.Mock;

type Row = Record<string, unknown>;

const SUPERADMIN = { id: '1', roles: ['superadmin'] };

const order = (over: Row = {}): Row => ({
  id: '31',
  status: Order_status.NEW,
  source: Order_source.INTERNAL,
  customer_id: 'c1',
  district_id: '120',
  region_id: null,
  total_price: 100000,
  branch_id: '1',
  holder_type: OrderHolderType.HQ,
  holder_branch_id: null,
  ...over,
});

function makeSvc(rows: Row[], districts: Row[]) {
  rmqSend.mockReset();
  rmqSend.mockImplementation((_client: unknown, pattern: { cmd: string }) => {
    switch (pattern.cmd) {
      case 'identity.customer.find_by_ids':
        return Promise.resolve({ data: [{ id: 'c1' }] });
      case 'logistics.district.find_by_ids':
        return Promise.resolve({ data: districts });
      case 'logistics.post.receive_orders':
        return Promise.resolve({
          data: rows.map((row) => ({
            order_id: String(row.id),
            post_id: '48',
          })),
        });
      default:
        return Promise.resolve(null);
    }
  });

  const sets: Array<{ id: unknown; values: Row }> = [];
  let pending: Row = {};
  const qb = {
    update: jest.fn(() => qb),
    set: jest.fn((values: Row) => {
      pending = values;
      return qb;
    }),
    where: jest.fn((_sql: string, params: { id: unknown }) => {
      sets.push({ id: params.id, values: pending });
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
  const syncOrderToSearch = jest.fn().mockResolvedValue(undefined);
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
    resolveReceiveBranchScope: jest.fn().mockResolvedValue(null),
    lookup: { getHqBranchId: jest.fn().mockResolvedValue('1') },
    custody: {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'superadmin'),
    },
    syncOrderToSearch,
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
  });
  const receive = () =>
    (s as unknown as OrderLifecycleService).receiveNewOrders(
      rows.map((r) => String(r.id)),
      undefined,
      SUPERADMIN as never,
    );
  const setFor = (id: string) =>
    sets.find((entry) => String(entry.id) === id)?.values;
  const receivePayload = () =>
    rmqSend.mock.calls.find(
      (call) =>
        (call[1] as { cmd: string }).cmd === 'logistics.post.receive_orders',
    )?.[2] as { orders: Row[] } | undefined;
  const receiveCalled = () =>
    rmqSend.mock.calls.some(
      (call) =>
        (call[1] as { cmd: string }).cmd === 'logistics.post.receive_orders',
    );
  return { receive, setFor, syncOrderToSearch, receivePayload, receiveCalled };
}

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

describe('YfWZXu9g — HQ qabuli bo`sh region_id ni tumandan to`ldiradi', () => {
  it('⭐ TC3: region_id NULL buyurtma — qabulda tuman hududi (assigned_region) yoziladi', async () => {
    const h = makeSvc(
      [order()],
      [{ id: '120', region_id: '13', assigned_region: '13' }],
    );

    await expect(h.receive()).resolves.toMatchObject({ statusCode: 200 });

    expect(h.setFor('31')).toEqual(
      expect.objectContaining({
        status: Order_status.RECEIVED,
        post_id: '48',
        region_id: '13',
      }),
    );
    // Qidiruv indeksi ham yangi hudud bilan.
    expect(h.syncOrderToSearch).toHaveBeenCalledWith(
      expect.objectContaining({ id: '31', region_id: '13' }),
      expect.anything(),
    );
    // Pochta ham aynan shu hudud bo'yicha.
    expect(h.receivePayload()?.orders).toEqual([
      expect.objectContaining({ order_id: '31', assigned_region: '13' }),
    ]);
  });

  it('assignedToRegion relatsiyasi orqali kelgan hudud ham yoziladi (region_id dan ustun)', async () => {
    // Relation qiymati geografik region_id dan farq qiladi — tartib
    // (assigned_region → assignedToRegion.id → region_id) haqiqatan tekshiriladi.
    const h = makeSvc(
      [order()],
      [{ id: '120', region_id: '13', assignedToRegion: { id: '5' } }],
    );

    await h.receive();

    expect(h.setFor('31')).toEqual(expect.objectContaining({ region_id: '5' }));
    expect(h.receivePayload()?.orders).toEqual([
      expect.objectContaining({ order_id: '31', assigned_region: '5' }),
    ]);
  });

  it('⭐ TC4 (regressiya): region_id to`lgan buyurtma — ustidan yozilmaydi', async () => {
    const h = makeSvc(
      [order({ region_id: '7' })],
      [{ id: '120', region_id: '13', assigned_region: '13' }],
    );

    await expect(h.receive()).resolves.toMatchObject({ statusCode: 200 });

    expect(h.setFor('31')).not.toHaveProperty('region_id');
    expect(h.syncOrderToSearch).toHaveBeenCalledWith(
      expect.objectContaining({ id: '31', region_id: '7' }),
      expect.anything(),
    );
  });

  it('aralash: faqat bo`sh hududli buyurtma to`ldiriladi', async () => {
    const h = makeSvc(
      [order({ id: '31' }), order({ id: '32', region_id: '7' })],
      [{ id: '120', region_id: '13', assigned_region: '13' }],
    );

    await h.receive();

    expect(h.setFor('31')).toEqual(
      expect.objectContaining({ region_id: '13' }),
    );
    expect(h.setFor('32')).not.toHaveProperty('region_id');
  });
});

/**
 * LC-13 — HQ qabulida xizmat hududi `assigned_region ?? region_id`
 * (`OrderLookupService.resolveRegionIdForDistrict` bilan bir xil tartib:
 * `assigned_region`, `assignedToRegion.id`, `region_id`, `region.id` —
 * birinchi raqamli qiymat). Ilgari biriktirilmagan (`assigned_region`
 * NULL) eski tuman butun partiyani 404 bilan to'xtatardi.
 */
describe('LC-13 — HQ qabuli: xizmat hududi assigned_region ?? region_id', () => {
  it('⭐ assigned_region NULL eski tuman — o`z viloyati (region_id) bo`yicha qabul, 404 emas', async () => {
    const h = makeSvc(
      [order()],
      [{ id: '120', region_id: '13', assigned_region: null }],
    );

    await expect(h.receive()).resolves.toMatchObject({ statusCode: 200 });

    expect(h.receivePayload()?.orders).toEqual([
      expect.objectContaining({ order_id: '31', assigned_region: '13' }),
    ]);
    expect(h.setFor('31')).toEqual(
      expect.objectContaining({ region_id: '13' }),
    );
  });

  it('faqat region relatsiyasi ({ id }) kelsa ham ishlaydi', async () => {
    const h = makeSvc([order()], [{ id: '120', region: { id: '13' } }]);

    await expect(h.receive()).resolves.toMatchObject({ statusCode: 200 });

    expect(h.receivePayload()?.orders).toEqual([
      expect.objectContaining({ order_id: '31', assigned_region: '13' }),
    ]);
  });

  it('ko`chirilgan tuman — assigned_region region_id dan ustun', async () => {
    const h = makeSvc(
      [order()],
      [{ id: '120', region_id: '13', assigned_region: '5' }],
    );

    await expect(h.receive()).resolves.toMatchObject({ statusCode: 200 });

    expect(h.receivePayload()?.orders).toEqual([
      expect.objectContaining({ order_id: '31', assigned_region: '5' }),
    ]);
  });

  it('tumanda hech qanday hudud yo`q — 404, pochtaga uzatilmaydi', async () => {
    const h = makeSvc(
      [order()],
      [{ id: '120', region_id: null, assigned_region: null }],
    );

    const error = await rpcError(h.receive());

    expect(error.statusCode).toBe(404);
    expect(h.receiveCalled()).toBe(false);
  });

  it('tuman logistikada topilmadi — 404, pochtaga uzatilmaydi', async () => {
    const h = makeSvc([order()], []);

    const error = await rpcError(h.receive());

    expect(error.statusCode).toBe(404);
    expect(h.receiveCalled()).toBe(false);
  });
});
