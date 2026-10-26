import { RpcException } from '@nestjs/microservices';
import { Observable, of, throwError, TimeoutError } from 'rxjs';
import { Order_status, OutboxEvent, WAREHOUSE_RPC } from '@app/common';
import { OrderHolderType } from '../entities/order.entity';
import { OrderLifecycleService } from '../lifecycle/order-lifecycle.service';
import {
  isWarehouseReserveFallback,
  OrderWarehouseService,
  WAREHOUSE_RESERVE_GUARD_DELAY_MS,
  WarehouseReserveFallback,
  warehouseRefOf,
} from './order-warehouse.service';

/**
 * 6kHnNH9j — order-service ombor oqimi (DB'siz):
 *   - manba tanlovi (`planCreate`): faqat `auto` + ruxsatli yaratuvchi +
 *     katalog mahsulotlari; HQ buyurtma ombor RPC'sini chaqirmaydi;
 *   - band (`reserveForNewOrder`): qo'riqchi → reserve → qo'riqchi o'chiriladi;
 *     xato — HQ'ga qaytish (aniq 4xx — qo'riqchi bekor, timeout — qoladi);
 *   - har o'tish → to'g'ri outbox hodisasi (`out`, `return`, `release`),
 *     takroriy yozuv — hech narsa; HQ buyurtma — hech narsa;
 *   - `create()` — band bo'lmasa butun buyurtma HQ bilan qayta yaratiladi.
 * DB bilan to'liq zanjir — `order-warehouse.pg.spec.ts`.
 */
type Send = jest.Mock<Observable<unknown>, [{ cmd: string }, any]>;

const REGISTRATOR = { id: '5', roles: ['registrator'] };
const MARKET = { id: '121', roles: ['market'] };
const PLAN = {
  warehouse_id: '3',
  warehouse_name: 'Samarqand ombori',
  branch_id: '11',
  market_id: '121',
  items: [{ product_id: '142', quantity: 2 }],
  // VkKDSNNn: tur va hudud (resolveReply'da hudud yo'q — null).
  kind: 'REGIONAL' as const,
  region_id: null,
};

const resolveReply = (source: 'WAREHOUSE' | 'HQ') => ({
  source,
  reason: source === 'WAREHOUSE' ? 'OK' : 'INSUFFICIENT_STOCK',
  warehouse: { id: '3', name: 'Samarqand ombori', branch_id: '11' },
});

const make = (
  handlers: Record<string, (payload: any) => Observable<unknown>> = {},
  // VkKDSNNn: HQ id manbai (OrderLookupService); berilmasa — lookup yo'q.
  lookup?: { getHqBranchId: jest.Mock },
) => {
  const send: Send = jest.fn((pattern: { cmd: string }, payload: any) => {
    const handler = handlers[pattern.cmd];
    return handler ? handler(payload) : of({});
  });
  let guardSeq = 0;
  const outbox = {
    enqueue: jest.fn((target: string, pattern: string, payload: unknown) =>
      Promise.resolve({
        id: String(++guardSeq),
        target,
        pattern,
        payload,
      } as unknown as OutboxEvent),
    ),
    markPublished: jest.fn(() => Promise.resolve()),
  };
  const custody = {
    createTrackingEvent: jest.fn(() => Promise.resolve()),
    createCustodyEvent: jest.fn(() => Promise.resolve()),
    toTrackingRole: jest.fn(() => 'manager'),
  };
  const deleteOutbox = jest.fn(() => Promise.resolve({ affected: 1 }));
  const updateOrder = jest.fn(() => Promise.resolve({ affected: 1 }));
  const findItems = jest.fn(() =>
    Promise.resolve([
      { product_id: '142', quantity: 1 },
      { product_id: null, quantity: 1 },
    ]),
  );
  const findOrders = jest.fn<Promise<any[]>, [any]>(() => Promise.resolve([]));
  const repos = new Map<unknown, unknown>([
    [OutboxEvent, { delete: deleteOutbox }],
  ]);
  const manager = {
    getRepository: jest.fn((entity: { name?: string }) => {
      if (repos.has(entity)) return repos.get(entity);
      if (entity?.name === 'Order') {
        return { update: updateOrder, find: findOrders };
      }
      if (entity?.name === 'OrderItem') return { find: findItems };
      return {};
    }),
  };
  const service = new OrderWarehouseService(
    { send } as never,
    outbox as never,
    custody as never,
    lookup as never,
  );
  return {
    service,
    send,
    outbox,
    custody,
    manager: manager as never,
    deleteOutbox,
    updateOrder,
    findItems,
    findOrders,
  };
};

const createDto = (extra: Record<string, unknown> = {}) => ({
  fulfillment: 'auto',
  market_id: '121',
  district_id: '700',
  region_id: '7',
  items: [{ product_id: '142', quantity: 2 }],
  ...extra,
});

const outboxPatterns = (outbox: { enqueue: jest.Mock }) =>
  outbox.enqueue.mock.calls.map((call) => call[1] as string);

const warehouseOrder = (extra: Record<string, unknown> = {}) =>
  ({
    id: '900',
    fulfillment_source: 'WAREHOUSE',
    warehouse_id: '3',
    status: Order_status.RECEIVED,
    home_branch_id: '11',
    holder_type: OrderHolderType.BRANCH,
    holder_branch_id: '11',
    holder_courier_id: null,
    parent_order_id: null,
    ...extra,
  }) as never;

describe('6kHnNH9j — OrderWarehouseService', () => {
  describe('planCreate (manba tanlovi)', () => {
    it('⭐ auto + registrator + katalog mahsulotlari → resolve_source (tuman bilan) → WAREHOUSE reja', async () => {
      const { service, send } = make({
        [WAREHOUSE_RPC.RESOLVE_SOURCE]: () => of(resolveReply('WAREHOUSE')),
      });
      await expect(
        service.planCreate(createDto(), REGISTRATOR),
      ).resolves.toEqual(PLAN);
      expect(send).toHaveBeenCalledWith(
        { cmd: WAREHOUSE_RPC.RESOLVE_SOURCE },
        {
          district_id: '700',
          market_id: '121',
          items: [{ product_id: '142', quantity: 2 }],
          requester: { id: '5', roles: ['registrator'] },
        },
      );
    });

    it('⭐ HQ buyurtma ombor RPC`sini chaqirmaydi: hq, fulfillment yo`q (ichki yo`llar), ruxsatsiz rol, katalogsiz qator, aniq joylashuv', async () => {
      const { service, send } = make({
        [WAREHOUSE_RPC.RESOLVE_SOURCE]: () => of(resolveReply('WAREHOUSE')),
      });
      const cases: Array<[Record<string, unknown>, unknown]> = [
        [createDto({ fulfillment: 'hq' }), REGISTRATOR],
        [createDto({ fulfillment: undefined }), REGISTRATOR],
        [createDto(), { id: '31', roles: ['manager'] }],
        [createDto(), { id: '77', roles: ['courier'] }],
        [createDto(), undefined],
        [
          createDto({ items: [{ product_name: 'Atir', quantity: 1 }] }),
          REGISTRATOR,
        ],
        [createDto({ items: [] }), REGISTRATOR],
        [
          createDto({ items: [{ product_id: '142', quantity: 0 }] }),
          REGISTRATOR,
        ],
        [createDto({ district_id: null, region_id: null }), REGISTRATOR],
        [createDto({ courier_id: '301' }), { id: '1', roles: ['superadmin'] }],
        [createDto({ status: 'received' }), { id: '1', roles: ['admin'] }],
        [createDto({ source: 'external' }), REGISTRATOR],
        [createDto({ parent_order_id: '10' }), REGISTRATOR],
      ];
      for (const [dto, requester] of cases) {
        await expect(
          service.planCreate(dto as never, requester as never),
        ).resolves.toBeNull();
      }
      expect(send).not.toHaveBeenCalled();
    });

    it('resolve_source HQ yoki xato/timeout — HQ (yaratish to`xtamaydi); noto`g`ri fulfillment — 400', async () => {
      const hq = make({
        [WAREHOUSE_RPC.RESOLVE_SOURCE]: () => of(resolveReply('HQ')),
      });
      await expect(
        hq.service.planCreate(createDto(), MARKET),
      ).resolves.toBeNull();
      const down = make({
        [WAREHOUSE_RPC.RESOLVE_SOURCE]: () =>
          throwError(() => new TimeoutError()),
      });
      await expect(
        down.service.planCreate(createDto(), MARKET),
      ).resolves.toBeNull();
      const error: unknown = await hq.service
        .planCreate(createDto({ fulfillment: 'warehouse' }), MARKET)
        .catch((e: unknown) => e);
      expect((error as RpcException).getError()).toMatchObject({
        statusCode: 400,
      });
    });

    it('tuman bo`lmasa viloyat yuboriladi; market so`rovchi — requester bilan (catalog kalitni tekshiradi)', async () => {
      const { service, send } = make({
        [WAREHOUSE_RPC.RESOLVE_SOURCE]: () => of(resolveReply('WAREHOUSE')),
      });
      await service.planCreate(createDto({ district_id: undefined }), MARKET);
      expect(send.mock.calls[0][1]).toEqual({
        region_id: '7',
        market_id: '121',
        items: [{ product_id: '142', quantity: 2 }],
        requester: { id: '121', roles: ['market'] },
      });
    });
  });

  describe('reserveForNewOrder (yaratishdagi band)', () => {
    it('⭐ qo`riqchi (10 daqiqa keyin release) → reserve (buyurtma id — kalit) → qo`riqchi SHU tranzaksiyada o`chiriladi', async () => {
      const { service, send, outbox, manager, deleteOutbox } = make({
        [WAREHOUSE_RPC.RESERVE]: () => of({ status: 'RESERVED' }),
      });
      const before = Date.now();
      await service.reserveForNewOrder(
        { order_id: '900', plan: PLAN, requester: REGISTRATOR },
        manager,
      );
      const [target, pattern, payload, options] = outbox.enqueue.mock
        .calls[0] as unknown as [
        string,
        string,
        unknown,
        { scheduledAt: Date; manager?: unknown },
      ];
      expect({ target, pattern, payload }).toEqual({
        target: 'CATALOG',
        pattern: WAREHOUSE_RPC.RELEASE,
        payload: {
          order_id: '900',
          actor: { id: null, role: 'system' },
          lenient: true,
          note: 'order_create_guard',
        },
      });
      // Alohida commit — buyurtma tranzaksiyasiga qo'shilmaydi.
      expect(options.manager).toBeUndefined();
      expect(options.scheduledAt.getTime()).toBeGreaterThanOrEqual(
        before + WAREHOUSE_RESERVE_GUARD_DELAY_MS,
      );
      expect(send).toHaveBeenCalledWith(
        { cmd: WAREHOUSE_RPC.RESERVE },
        {
          order_id: '900',
          warehouse_id: '3',
          items: [{ product_id: '142', quantity: 2 }],
          market_id: '121',
          actor: { id: '5', roles: ['registrator'] },
        },
      );
      expect(deleteOutbox).toHaveBeenCalledWith({ id: '1' });
    });

    it('⭐ aniq rad (409 yetmaydi/to`xtatilgan) → HQ`ga qaytish, qo`riqchi bekor; timeout/5xx → HQ, qo`riqchi QOLADI (yetim bandni bo`shatadi)', async () => {
      const refused = make({
        [WAREHOUSE_RPC.RESERVE]: () =>
          throwError(() => ({
            statusCode: 409,
            code: 'WAREHOUSE_STOCK_INSUFFICIENT',
            message: 'Omborda yetmaydi',
          })),
      });
      const error: unknown = await refused.service
        .reserveForNewOrder({ order_id: '900', plan: PLAN }, refused.manager)
        .catch((e: unknown) => e);
      expect(isWarehouseReserveFallback(error)).toBe(true);
      expect(error).toMatchObject({
        reason: 'WAREHOUSE_STOCK_INSUFFICIENT',
        ambiguous: false,
      });
      expect(refused.outbox.markPublished).toHaveBeenCalledWith('1');
      expect(refused.deleteOutbox).not.toHaveBeenCalled();

      for (const failure of [
        new TimeoutError(),
        { statusCode: 503, message: 'down' },
        new Error('ECONNRESET'),
      ]) {
        const down = make({
          [WAREHOUSE_RPC.RESERVE]: () => throwError(() => failure),
        });
        const err: unknown = await down.service
          .reserveForNewOrder({ order_id: '901', plan: PLAN }, down.manager)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WarehouseReserveFallback);
        expect((err as WarehouseReserveFallback).ambiguous).toBe(true);
        expect(down.outbox.markPublished).not.toHaveBeenCalled();
        expect(down.deleteOutbox).not.toHaveBeenCalled();
      }
    });

    it('qo`riqchi yozilmasa — reserve chaqirilmaydi, HQ`ga qaytish', async () => {
      const { service, send, outbox, manager } = make();
      outbox.enqueue.mockRejectedValueOnce(new Error('db down'));
      const err: unknown = await service
        .reserveForNewOrder({ order_id: '900', plan: PLAN }, manager)
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ reason: 'guard_failed', ambiguous: false });
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('onOrderWritten (har o`tish → outbox)', () => {
    it('⭐ kuryerga berish (egalik → COURIER) → catalog.warehouse.out (lenient), shu tranzaksiyada', async () => {
      const { service, outbox, manager } = make();
      await service.onOrderWritten(
        {
          order: warehouseOrder({
            status: Order_status.ON_THE_ROAD,
            holder_type: OrderHolderType.COURIER,
            holder_courier_id: '301',
          }),
          oldStatus: Order_status.RECEIVED,
          previousHolderType: OrderHolderType.BRANCH,
          requester: { id: '31', roles: ['manager'] },
        },
        manager,
      );
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      expect(outbox.enqueue).toHaveBeenCalledWith(
        'CATALOG',
        WAREHOUSE_RPC.OUT,
        {
          order_id: '900',
          actor: { id: '31', roles: ['manager'] },
          lenient: true,
          note: 'Buyurtma #900 kuryerga berildi',
        },
        { manager },
      );
    });

    it('⭐ takroriy yozuv (o`tish yo`q) va HQ buyurtma — hech narsa', async () => {
      const { service, outbox, manager } = make();
      await service.onOrderWritten(
        {
          order: warehouseOrder({
            status: Order_status.WAITING,
            holder_type: OrderHolderType.COURIER,
          }),
          oldStatus: Order_status.ON_THE_ROAD,
          previousHolderType: OrderHolderType.COURIER,
        },
        manager,
      );
      await service.onOrderWritten(
        {
          order: warehouseOrder({
            fulfillment_source: 'HQ',
            warehouse_id: null,
            status: Order_status.ON_THE_ROAD,
            holder_type: OrderHolderType.COURIER,
          }),
          oldStatus: Order_status.RECEIVED,
          previousHolderType: OrderHolderType.BRANCH,
        },
        manager,
      );
      await service.onOrderWritten(
        {
          order: warehouseOrder({
            fulfillment_source: 'HQ',
            warehouse_id: null,
            status: Order_status.CANCELLED,
          }),
          oldStatus: Order_status.CANCELLED_SENT,
          previousHolderType: OrderHolderType.BRANCH,
        },
        manager,
      );
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('⭐ bekor posilka o`z ombori filialiga qabul qilindi → return (o`sha omborga) + buyurtma yopiladi (returned_to_market, MARKET)', async () => {
      const { service, outbox, manager, updateOrder, custody } = make();
      const order = warehouseOrder({
        status: Order_status.CANCELLED,
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: '11',
      }) as unknown as Record<string, unknown>;
      await service.onOrderWritten(
        {
          order: order as never,
          oldStatus: Order_status.CANCELLED_SENT,
          previousHolderType: OrderHolderType.BRANCH,
          requester: { id: '31', roles: ['manager'] },
        },
        manager,
      );
      expect(outboxPatterns(outbox)).toEqual([WAREHOUSE_RPC.RETURN]);
      expect(outbox.enqueue.mock.calls[0][2]).toEqual({
        order_id: '900',
        actor: { id: '31', roles: ['manager'] },
        note: 'Buyurtma #900 bekor — omborga qaytdi',
      });
      expect(updateOrder).toHaveBeenCalledWith(
        { id: '900' },
        expect.objectContaining({
          status: Order_status.RETURNED_TO_MARKET,
          holder_type: OrderHolderType.MARKET,
          holder_branch_id: null,
          holder_courier_id: null,
        }),
      );
      expect(order).toMatchObject({
        status: Order_status.RETURNED_TO_MARKET,
        holder_type: OrderHolderType.MARKET,
      });
      expect(custody.createTrackingEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          from_status: Order_status.CANCELLED,
          to_status: Order_status.RETURNED_TO_MARKET,
          action: 'warehouse_returned',
        }),
        expect.anything(),
      );
      expect(custody.createCustodyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          from_holder_type: OrderHolderType.BRANCH,
          from_branch_id: '11',
          to_holder_type: OrderHolderType.MARKET,
        }),
        expect.anything(),
      );
    });

    it('qisman sotuv bolasi: return OTA buyurtma bandiga, faqat bola qatorlari va alohida kalit bilan; chiqim — yo`q', async () => {
      const { service, outbox, manager } = make();
      await service.onOrderWritten(
        {
          order: warehouseOrder({
            id: '950',
            parent_order_id: '900',
            status: Order_status.CANCELLED,
          }),
          oldStatus: Order_status.CANCELLED_SENT,
          previousHolderType: OrderHolderType.BRANCH,
        },
        manager,
      );
      expect(outbox.enqueue.mock.calls[0][2]).toEqual({
        order_id: '900',
        items: [{ product_id: '142', quantity: 1 }],
        idempotency_key: 'child-order-950',
        actor: { id: null, role: 'system' },
        note: 'Buyurtma #950 bekor — omborga qaytdi',
      });

      outbox.enqueue.mockClear();
      await service.onOrderWritten(
        {
          order: warehouseOrder({
            id: '951',
            parent_order_id: '900',
            status: Order_status.CANCELLED,
            holder_type: OrderHolderType.COURIER,
          }),
          oldStatus: Order_status.WAITING,
          previousHolderType: OrderHolderType.BRANCH,
        },
        manager,
      );
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('boshqa filialga (yoki HQ`ga) qabul qilingan bekor posilka — qaytish yo`q (mahsulot omborda emas)', async () => {
      const { service, outbox, manager, updateOrder } = make();
      for (const holder of [
        { holder_type: OrderHolderType.BRANCH, holder_branch_id: '12' },
        { holder_type: OrderHolderType.HQ, holder_branch_id: null },
      ]) {
        await service.onOrderWritten(
          {
            order: warehouseOrder({
              status: Order_status.CANCELLED,
              ...holder,
            }),
            oldStatus: Order_status.CANCELLED_SENT,
            previousHolderType: OrderHolderType.BRANCH,
          },
          manager,
        );
      }
      // Kuryer qo'lidagi bekor (hali qaytmagan) — ham yo'q.
      await service.onOrderWritten(
        {
          order: warehouseOrder({
            status: Order_status.CANCELLED,
            holder_type: OrderHolderType.COURIER,
          }),
          oldStatus: Order_status.WAITING,
          previousHolderType: OrderHolderType.COURIER,
        },
        manager,
      );
      expect(outbox.enqueue).not.toHaveBeenCalled();
      expect(updateOrder).not.toHaveBeenCalled();
    });

    it('o`chirish (kuryerga berilmagan) → release (lenient); HQ buyurtma — hech narsa', async () => {
      const { service, outbox, manager } = make();
      await service.onOrderRemoved(
        warehouseOrder(),
        { id: '1', roles: ['superadmin'] },
        manager,
      );
      await service.onOrderRemoved(
        { id: '901', fulfillment_source: 'HQ' } as never,
        undefined,
        manager,
      );
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      expect(outbox.enqueue).toHaveBeenCalledWith(
        'CATALOG',
        WAREHOUSE_RPC.RELEASE,
        {
          order_id: '900',
          actor: { id: '1', roles: ['superadmin'] },
          lenient: true,
          note: "Buyurtma #900 o'chirildi",
        },
        { manager },
      );
    });
  });

  describe('javob boyitishi', () => {
    it('warehouse { id, name, branch_id }; catalog javob bermasa — id bilan; HQ — null; HQ ro`yxat catalog`ga bormaydi', async () => {
      const ok = make({
        [WAREHOUSE_RPC.FIND_BY_IDS]: () =>
          of({
            data: [
              {
                id: '3',
                name: 'Samarqand ombori',
                branch_id: '11',
                status: 'ACTIVE',
                kind: 'REGIONAL',
              },
            ],
          }),
      });
      const refs = await ok.service.loadWarehouseRefs(['3', null, '3']);
      expect(ok.send).toHaveBeenCalledWith(
        { cmd: WAREHOUSE_RPC.FIND_BY_IDS },
        { ids: ['3'] },
      );
      expect(warehouseRefOf({ warehouse_id: '3' }, refs)).toEqual({
        id: '3',
        name: 'Samarqand ombori',
        branch_id: '11',
        kind: 'REGIONAL',
      });
      expect(warehouseRefOf({ warehouse_id: null }, refs)).toBeNull();

      const down = make({
        [WAREHOUSE_RPC.FIND_BY_IDS]: () => throwError(() => new Error('x')),
      });
      const fallback = await down.service.loadWarehouseRefs(['3']);
      expect(warehouseRefOf({ warehouse_id: '3' }, fallback)).toEqual({
        id: '3',
        name: null,
        branch_id: null,
        kind: null,
      });

      const hq = make();
      await hq.service.loadWarehouseRefs([null, undefined]);
      expect(hq.send).not.toHaveBeenCalled();
    });

    it('qisman sotuv bolasi ota manbasini meros oladi', () => {
      const { service } = make();
      expect(
        service.inheritedFields({
          fulfillment_source: 'WAREHOUSE',
          warehouse_id: '3',
        }),
      ).toEqual({ fulfillment_source: 'WAREHOUSE', warehouse_id: '3' });
      expect(
        service.inheritedFields({
          fulfillment_source: 'HQ',
          warehouse_id: null,
        }),
      ).toEqual({ fulfillment_source: 'HQ', warehouse_id: null });
    });
  });
});

/**
 * VkKDSNNn — Markaziy ombor (2-pog'ona). Markaziy ombor buyurtmasi =
 * `WAREHOUSE` + `home_branch_id = HQ id` ('1'). HQ'da turish: egalik HQ/null
 * yoki BRANCH/'1'. HQ id noma'lum — HQ-tur mantiq yo'q (fail-closed).
 */
describe('VkKDSNNn — markaziy ombor (OrderWarehouseService)', () => {
  const HQ_ID = '1';
  const hqLookup = (value: string | null | Error = HQ_ID) => ({
    getHqBranchId: jest.fn(() =>
      value instanceof Error ? Promise.reject(value) : Promise.resolve(value),
    ),
  });
  const hqReply = (extra: Record<string, unknown> = {}) => ({
    source: 'WAREHOUSE',
    reason: 'OK',
    region_id: '7',
    warehouse: {
      id: '9',
      name: 'Markaziy ombor',
      branch_id: HQ_ID,
      kind: 'HQ',
    },
    ...extra,
  });
  const HQ_PLAN = {
    warehouse_id: '9',
    warehouse_name: 'Markaziy ombor',
    branch_id: HQ_ID,
    market_id: '121',
    items: [{ product_id: '142', quantity: 2 }],
    kind: 'HQ',
    region_id: '7',
  };
  const hqOrder = (extra: Record<string, unknown> = {}) =>
    warehouseOrder({
      warehouse_id: '9',
      home_branch_id: HQ_ID,
      holder_type: OrderHolderType.HQ,
      holder_branch_id: null,
      ...extra,
    });
  const MANAGER = { id: '31', roles: ['manager'] };

  describe('planCreate', () => {
    it('⭐ catalog Markaziy omborni tanladi (HQ id mos, hudud bor) → kind HQ + region_id', async () => {
      const lookup = hqLookup();
      const { service } = make(
        { [WAREHOUSE_RPC.RESOLVE_SOURCE]: () => of(hqReply()) },
        lookup,
      );
      await expect(
        service.planCreate(createDto(), REGISTRATOR),
      ).resolves.toEqual(HQ_PLAN);
      expect(lookup.getHqBranchId).toHaveBeenCalledTimes(1);
    });

    it('viloyat ombori — kind REGIONAL, hudud catalog`dan; HQ id so`ralmaydi', async () => {
      const lookup = hqLookup();
      const { service } = make(
        {
          [WAREHOUSE_RPC.RESOLVE_SOURCE]: () =>
            of({
              ...resolveReply('WAREHOUSE'),
              region_id: '7',
              warehouse: {
                ...resolveReply('WAREHOUSE').warehouse,
                kind: 'REGIONAL',
              },
            }),
        },
        lookup,
      );
      await expect(
        service.planCreate(createDto(), REGISTRATOR),
      ).resolves.toEqual({ ...PLAN, kind: 'REGIONAL', region_id: '7' });
      expect(lookup.getHqBranchId).not.toHaveBeenCalled();
    });

    it('⭐ fail-closed: lookup yo`q / HQ id null / lookup xatosi / ombor filiali HQ emas / hudud yo`q → null (oddiy HQ)', async () => {
      const cases: Array<
        [ReturnType<typeof hqLookup> | undefined, Record<string, unknown>]
      > = [
        [undefined, hqReply()],
        [hqLookup(null), hqReply()],
        [hqLookup(new Error('branch down')), hqReply()],
        [hqLookup('2'), hqReply()],
        [hqLookup(), hqReply({ region_id: null })],
        [hqLookup(), hqReply({ region_id: 'abc' })],
      ];
      for (const [lookup, reply] of cases) {
        const { service } = make(
          { [WAREHOUSE_RPC.RESOLVE_SOURCE]: () => of(reply) },
          lookup,
        );
        await expect(
          service.planCreate(createDto(), REGISTRATOR),
        ).resolves.toBeNull();
      }
    });
  });

  describe('onOrderWritten — chiqim (out)', () => {
    const write = async (
      order: unknown,
      prev: { type: OrderHolderType | null; branch: string | null },
      lookup = hqLookup(),
      oldStatus: Order_status = Order_status.RECEIVED,
    ) => {
      const h = make({}, lookup);
      await h.service.onOrderWritten(
        {
          order: order as never,
          oldStatus,
          previousHolderType: prev.type,
          previousHolderBranchId: prev.branch,
          requester: MANAGER,
        },
        h.manager,
      );
      return h;
    };
    const outNote = (h: ReturnType<typeof make>) =>
      h.outbox.enqueue.mock.calls
        .filter((call) => call[1] === WAREHOUSE_RPC.OUT)
        .map((call) => (call[2] as { note: string }).note);

    it('⭐ HQ → kuryer, HQ → filial (jo`natish), BRANCH(HQ) → filial → out (lenient), shu tranzaksiyada', async () => {
      const toCourier = await write(
        hqOrder({
          status: Order_status.ON_THE_ROAD,
          holder_type: OrderHolderType.COURIER,
          holder_branch_id: HQ_ID,
          holder_courier_id: '301',
        }),
        { type: OrderHolderType.HQ, branch: null },
      );
      expect(toCourier.outbox.enqueue).toHaveBeenCalledWith(
        'CATALOG',
        WAREHOUSE_RPC.OUT,
        {
          order_id: '900',
          actor: { id: '31', roles: ['manager'] },
          lenient: true,
          note: "Buyurtma #900 markaziy ombordan jo'natildi",
        },
        { manager: toCourier.manager },
      );

      const dispatched = await write(
        hqOrder({
          status: Order_status.ON_THE_ROAD,
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: '12',
        }),
        { type: OrderHolderType.HQ, branch: null },
      );
      expect(outNote(dispatched)).toEqual([
        "Buyurtma #900 markaziy ombordan jo'natildi",
      ]);

      const fromBatchForm = await write(
        hqOrder({
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: '12',
        }),
        { type: OrderHolderType.BRANCH, branch: HQ_ID },
      );
      expect(outNote(fromBatchForm)).toEqual([
        "Buyurtma #900 markaziy ombordan jo'natildi",
      ]);
    });

    it('viloyat filialida kuryerga berildi (HQ`dan oldin chiqqan) → out «kuryerga berildi»', async () => {
      const h = await write(
        hqOrder({
          status: Order_status.ON_THE_ROAD,
          holder_type: OrderHolderType.COURIER,
          holder_branch_id: '12',
          holder_courier_id: '302',
        }),
        { type: OrderHolderType.BRANCH, branch: '12' },
      );
      expect(outNote(h)).toEqual(['Buyurtma #900 kuryerga berildi']);
    });

    it('⭐ HQ ↔ BRANCH(HQ), → MARKET, filial ichida takror, qisman sotuv bolasi — out yo`q', async () => {
      const cases: Array<
        [unknown, { type: OrderHolderType | null; branch: string | null }]
      > = [
        [
          hqOrder({
            holder_type: OrderHolderType.BRANCH,
            holder_branch_id: HQ_ID,
          }),
          { type: OrderHolderType.HQ, branch: null },
        ],
        [hqOrder(), { type: OrderHolderType.BRANCH, branch: HQ_ID }],
        [
          hqOrder({
            status: Order_status.RETURNED_TO_MARKET,
            holder_type: OrderHolderType.MARKET,
          }),
          { type: OrderHolderType.HQ, branch: null },
        ],
        [
          hqOrder({
            holder_type: OrderHolderType.BRANCH,
            holder_branch_id: '12',
          }),
          { type: OrderHolderType.BRANCH, branch: '12' },
        ],
        [
          hqOrder({
            id: '950',
            parent_order_id: '900',
            holder_type: OrderHolderType.BRANCH,
            holder_branch_id: '12',
          }),
          { type: OrderHolderType.HQ, branch: null },
        ],
        [
          hqOrder({
            id: '951',
            parent_order_id: '900',
            holder_type: OrderHolderType.COURIER,
            holder_courier_id: '301',
          }),
          { type: OrderHolderType.HQ, branch: null },
        ],
      ];
      for (const [order, prev] of cases) {
        const h = await write(order, prev);
        expect(h.outbox.enqueue).not.toHaveBeenCalled();
        expect(h.updateOrder).not.toHaveBeenCalled();
      }
    });
  });

  describe('onOrderWritten — qaytish (return)', () => {
    it('⭐ bekor posilka HQ`ga qabul qilindi (HQ/null va BRANCH/HQ) → Markaziy omborga return + yopiladi', async () => {
      for (const holder of [
        { holder_type: OrderHolderType.HQ, holder_branch_id: null },
        { holder_type: OrderHolderType.BRANCH, holder_branch_id: HQ_ID },
      ]) {
        const { service, outbox, manager, updateOrder, custody } = make(
          {},
          hqLookup(),
        );
        const order = hqOrder({
          status: Order_status.CANCELLED,
          ...holder,
        }) as unknown as Record<string, unknown>;
        await service.onOrderWritten(
          {
            order: order as never,
            oldStatus: Order_status.CANCELLED_SENT,
            previousHolderType: OrderHolderType.HQ,
            previousHolderBranchId: null,
            requester: MANAGER,
          },
          manager,
        );
        expect(outboxPatterns(outbox)).toEqual([WAREHOUSE_RPC.RETURN]);
        expect(outbox.enqueue.mock.calls[0][2]).toEqual({
          order_id: '900',
          actor: { id: '31', roles: ['manager'] },
          note: 'Buyurtma #900 markaziy omborga qaytdi',
        });
        expect(updateOrder).toHaveBeenCalledWith(
          { id: '900' },
          expect.objectContaining({
            status: Order_status.RETURNED_TO_MARKET,
            holder_type: OrderHolderType.MARKET,
            holder_branch_id: null,
          }),
        );
        expect(order).toMatchObject({
          status: Order_status.RETURNED_TO_MARKET,
          holder_type: OrderHolderType.MARKET,
        });
        expect(custody.createTrackingEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            from_status: Order_status.CANCELLED,
            to_status: Order_status.RETURNED_TO_MARKET,
            action: 'warehouse_returned',
            description: 'Markaziy omborga qaytarildi',
            metadata: { warehouse_id: '9', warehouse_kind: 'HQ' },
            note: 'Markaziy ombor buyurtmasi omborga qaytarildi — qoldiq tiklandi',
          }),
          expect.anything(),
        );
        expect(custody.createCustodyEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            from_holder_type: holder.holder_type,
            from_branch_id: holder.holder_branch_id,
            to_holder_type: OrderHolderType.MARKET,
          }),
          expect.anything(),
        );
      }
    });

    it('HQ`da turgan buyurtma to`g`ridan bekor (WAITING → CANCELLED) → return', async () => {
      const { service, outbox, manager } = make({}, hqLookup());
      await service.onOrderWritten(
        {
          order: hqOrder({ status: Order_status.CANCELLED }),
          oldStatus: Order_status.WAITING,
          previousHolderType: OrderHolderType.HQ,
          previousHolderBranchId: null,
        },
        manager,
      );
      expect(outboxPatterns(outbox)).toEqual([WAREHOUSE_RPC.RETURN]);
    });

    it('⭐ viloyat filialida / kuryerda bekor yoki allaqachon bekor (o`tish yo`q) — qaytish yo`q', async () => {
      const cases: Array<[Record<string, unknown>, Order_status]> = [
        [
          {
            status: Order_status.CANCELLED,
            holder_type: OrderHolderType.BRANCH,
            holder_branch_id: '12',
          },
          Order_status.CANCELLED_SENT,
        ],
        [
          {
            status: Order_status.CANCELLED,
            holder_type: OrderHolderType.COURIER,
            holder_branch_id: '12',
            holder_courier_id: '302',
          },
          Order_status.WAITING,
        ],
        [{ status: Order_status.CANCELLED }, Order_status.CANCELLED],
      ];
      for (const [extra, oldStatus] of cases) {
        const { service, outbox, manager, updateOrder } = make({}, hqLookup());
        await service.onOrderWritten(
          {
            order: hqOrder(extra),
            oldStatus,
            previousHolderType: extra.holder_type as OrderHolderType,
            previousHolderBranchId: (extra.holder_branch_id as string) ?? null,
          },
          manager,
        );
        expect(outbox.enqueue).not.toHaveBeenCalled();
        expect(updateOrder).not.toHaveBeenCalled();
      }
    });

    it('viloyat ombori buyurtmasi HQ id ma`lum bo`lsa ham bugungidek (izoh/tur REGIONAL)', async () => {
      const { service, outbox, manager, custody } = make({}, hqLookup());
      await service.onOrderWritten(
        {
          order: warehouseOrder({ status: Order_status.CANCELLED }),
          oldStatus: Order_status.CANCELLED_SENT,
          previousHolderType: OrderHolderType.BRANCH,
          previousHolderBranchId: '11',
        },
        manager,
      );
      expect(outbox.enqueue.mock.calls[0][2]).toEqual({
        order_id: '900',
        actor: { id: null, role: 'system' },
        note: 'Buyurtma #900 bekor — omborga qaytdi',
      });
      expect(custody.createTrackingEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          from_status: Order_status.CANCELLED,
          description: 'Omborga qaytarildi',
          metadata: { warehouse_id: '3', warehouse_kind: 'REGIONAL' },
          note: 'Ombor buyurtmasi omborga qaytarildi — qoldiq tiklandi (HQ qaytarish oqimisiz)',
        }),
        expect.anything(),
      );
    });
  });

  describe('HQ id noma`lum', () => {
    it('⭐ lookup yo`q → viloyat semantikasi (HQ-tur mantiq yo`q, 503 ham yo`q)', async () => {
      const dispatch = make();
      await dispatch.service.onOrderWritten(
        {
          order: hqOrder({
            holder_type: OrderHolderType.BRANCH,
            holder_branch_id: '12',
          }),
          oldStatus: Order_status.RECEIVED,
          previousHolderType: OrderHolderType.HQ,
          previousHolderBranchId: null,
        },
        dispatch.manager,
      );
      // HQ'da qabul — viloyat qoidasida qaytish yo'q (egalik HQ).
      await dispatch.service.onOrderWritten(
        {
          order: hqOrder({ status: Order_status.CANCELLED }),
          oldStatus: Order_status.CANCELLED_SENT,
          previousHolderType: OrderHolderType.HQ,
        },
        dispatch.manager,
      );
      expect(dispatch.outbox.enqueue).not.toHaveBeenCalled();

      // Kuryerga berish — bugungi qoida bilan out.
      const courier = make();
      await courier.service.onOrderWritten(
        {
          order: hqOrder({
            holder_type: OrderHolderType.COURIER,
            holder_courier_id: '301',
          }),
          oldStatus: Order_status.RECEIVED,
          previousHolderType: OrderHolderType.HQ,
        },
        courier.manager,
      );
      expect(courier.outbox.enqueue.mock.calls[0][2]).toMatchObject({
        note: 'Buyurtma #900 kuryerga berildi',
      });
    });

    it('⭐ (C1) lookup bor, HQ id null: uydan/HQ`dan boshqa filialga o`tish → 503 (yozuv bekor); kuryer — out; bola va uy ichida — o`tadi', async () => {
      const blocked: Array<
        [Record<string, unknown>, OrderHolderType, string | null]
      > = [
        [
          { holder_type: OrderHolderType.BRANCH, holder_branch_id: '12' },
          OrderHolderType.HQ,
          null,
        ],
        [
          { holder_type: OrderHolderType.BRANCH, holder_branch_id: '12' },
          OrderHolderType.BRANCH,
          HQ_ID,
        ],
      ];
      for (const [extra, prevType, prevBranch] of blocked) {
        const { service, outbox, manager } = make({}, hqLookup(null));
        const error: unknown = await service
          .onOrderWritten(
            {
              order: hqOrder(extra),
              oldStatus: Order_status.RECEIVED,
              previousHolderType: prevType,
              previousHolderBranchId: prevBranch,
            },
            manager,
          )
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RpcException);
        expect((error as RpcException).getError()).toMatchObject({
          statusCode: 503,
        });
        expect(outbox.enqueue).not.toHaveBeenCalled();
      }

      // Viloyat buyurtmasi uyidan boshqa filialga — ham 503 (turini bilmaymiz).
      const regional = make({}, hqLookup(new Error('down')));
      await expect(
        regional.service.onOrderWritten(
          {
            order: warehouseOrder({ holder_branch_id: '12' }),
            oldStatus: Order_status.RECEIVED,
            previousHolderType: OrderHolderType.BRANCH,
            previousHolderBranchId: '11',
          },
          regional.manager,
        ),
      ).rejects.toBeInstanceOf(RpcException);

      const passing: Array<
        [Record<string, unknown>, OrderHolderType, string | null]
      > = [
        // kuryerga — bugungi out
        [
          {
            holder_type: OrderHolderType.COURIER,
            holder_courier_id: '301',
          },
          OrderHolderType.HQ,
          null,
        ],
        // bola — chiqim otada
        [
          {
            id: '950',
            parent_order_id: '900',
            holder_type: OrderHolderType.BRANCH,
            holder_branch_id: '12',
          },
          OrderHolderType.HQ,
          null,
        ],
        // HQ → BRANCH/uy (= HQ id, noma'lum bo'lsa shu shakl)
        [
          { holder_type: OrderHolderType.BRANCH, holder_branch_id: HQ_ID },
          OrderHolderType.HQ,
          null,
        ],
        // boshqa filial ichida takror
        [
          { holder_type: OrderHolderType.BRANCH, holder_branch_id: '12' },
          OrderHolderType.BRANCH,
          '12',
        ],
      ];
      const patterns: string[][] = [];
      for (const [extra, prevType, prevBranch] of passing) {
        const { service, outbox, manager } = make({}, hqLookup(null));
        await service.onOrderWritten(
          {
            order: hqOrder(extra),
            oldStatus: Order_status.RECEIVED,
            previousHolderType: prevType,
            previousHolderBranchId: prevBranch,
          },
          manager,
        );
        patterns.push(outboxPatterns(outbox));
      }
      expect(patterns).toEqual([[WAREHOUSE_RPC.OUT], [], [], []]);
    });
  });

  describe('onReturnBatchReceived (HQ`ga qaytish partiyasi)', () => {
    const rows = [
      hqOrder({
        id: '900',
        status: Order_status.RECEIVED,
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: HQ_ID,
      }),
      // Partiyada turganida SOTILGAN: partiya QB'si uni ham RECEIVED ga
      // yozgan (haqiqiy oqim) — faqat OLDINGI holat (SOLD) bo'yicha ajraladi.
      hqOrder({
        id: '901',
        status: Order_status.RECEIVED,
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: HQ_ID,
      }),
      // Oldingi holati noma'lum (uzatilmagan) — fail-closed, tegilmaydi.
      hqOrder({
        id: '904',
        status: Order_status.RECEIVED,
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: HQ_ID,
      }),
      // Viloyat ombori buyurtmasi (K1) — filtrdan o'tmaydi.
      warehouseOrder({
        id: '902',
        status: Order_status.RECEIVED,
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: HQ_ID,
      }),
      // HQ buyurtma — filtrdan o'tmaydi.
      hqOrder({
        id: '903',
        fulfillment_source: 'HQ',
        warehouse_id: null,
        status: Order_status.NEW,
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: HQ_ID,
      }),
    ] as unknown as Array<Record<string, any>>;
    const withRows = (h: ReturnType<typeof make>) => {
      h.findOrders.mockImplementation(({ where }: any) =>
        Promise.resolve(
          rows
            .filter(
              (row) =>
                (where.id.value as string[]).includes(String(row.id)) &&
                row.fulfillment_source === where.fulfillment_source &&
                String(row.home_branch_id) === String(where.home_branch_id),
            )
            .map((row) => ({ ...row })),
        ),
      );
      return h;
    };

    /** Partiya QB'sidan OLDINGI holat (chaqiruvchi o'qigani). */
    const priorStatusById = new Map<string, Order_status>([
      ['900', Order_status.CANCELLED],
      ['901', Order_status.SOLD],
      ['902', Order_status.CANCELLED],
      ['903', Order_status.NEW],
    ]);

    it('⭐ manzil HQ → Markaziy ombor buyurtmasi omborga qaytadi (from_status — yangi holat); sotilgan (oldingi holat bo`yicha), oldingi holati noma`lum, viloyat va HQ buyurtma — yo`q', async () => {
      const h = withRows(make({}, hqLookup()));
      await h.service.onReturnBatchReceived(
        {
          orderIds: ['900', '901', '902', '903', '904', '900', 'abc'],
          destinationBranchId: HQ_ID,
          priorStatusById,
          requester: { id: '41', roles: ['manager'] },
        },
        h.manager,
      );
      expect(h.findOrders).toHaveBeenCalledTimes(1);
      const { where } = h.findOrders.mock.calls[0][0];
      expect(where).toMatchObject({
        fulfillment_source: 'WAREHOUSE',
        home_branch_id: HQ_ID,
        isDeleted: false,
      });
      expect(where.id.value).toEqual(['900', '901', '902', '903', '904']);
      expect(outboxPatterns(h.outbox)).toEqual([WAREHOUSE_RPC.RETURN]);
      expect(h.outbox.enqueue.mock.calls[0][2]).toEqual({
        order_id: '900',
        actor: { id: '41', roles: ['manager'] },
        note: 'Buyurtma #900 markaziy omborga qaytdi',
      });
      expect(h.updateOrder).toHaveBeenCalledTimes(1);
      expect(h.updateOrder).toHaveBeenCalledWith(
        { id: '900' },
        expect.objectContaining({ status: Order_status.RETURNED_TO_MARKET }),
      );
      expect(h.custody.createTrackingEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          from_status: Order_status.RECEIVED,
          to_status: Order_status.RETURNED_TO_MARKET,
          metadata: { warehouse_id: '9', warehouse_kind: 'HQ' },
        }),
        expect.anything(),
      );
      expect(h.custody.createCustodyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          from_holder_type: OrderHolderType.BRANCH,
          from_branch_id: HQ_ID,
          to_holder_type: OrderHolderType.MARKET,
        }),
        expect.anything(),
      );
    });

    it('manzil viloyat filiali, HQ id noma`lum yoki lookup yo`q — hech narsa (DB ham o`qilmaydi)', async () => {
      for (const [lookup, destination] of [
        [hqLookup(), '11'],
        [hqLookup(null), HQ_ID],
        [undefined, HQ_ID],
      ] as Array<[ReturnType<typeof hqLookup> | undefined, string]>) {
        const h = withRows(make({}, lookup));
        await h.service.onReturnBatchReceived(
          {
            orderIds: ['900'],
            destinationBranchId: destination,
            priorStatusById,
          },
          h.manager,
        );
        expect(h.findOrders).not.toHaveBeenCalled();
        expect(h.outbox.enqueue).not.toHaveBeenCalled();
      }
      const empty = withRows(make({}, hqLookup()));
      await empty.service.onReturnBatchReceived(
        { orderIds: [], destinationBranchId: HQ_ID, priorStatusById },
        empty.manager,
      );
      expect(empty.findOrders).not.toHaveBeenCalled();
    });
  });
});

describe('6kHnNH9j — OrderLifecycleService.create (manba va HQ`ga qaytish)', () => {
  const makeLifecycle = (plan: unknown) => {
    const lifecycle = Object.create(
      OrderLifecycleService.prototype,
    ) as OrderLifecycleService & Record<string, any>;
    const createOnce = jest.fn();
    lifecycle.createOnce = createOnce;
    lifecycle.orderWarehouse = {
      planCreate: jest.fn(() => Promise.resolve(plan)),
    };
    return { lifecycle, createOnce };
  };

  it('⭐ reja bor → ombor bilan; band bo`lmasa (fallback) → BUTUN buyurtma HQ bilan qayta yaratiladi', async () => {
    const { lifecycle, createOnce } = makeLifecycle(PLAN);
    createOnce
      .mockRejectedValueOnce(new WarehouseReserveFallback('timeout', true))
      .mockResolvedValueOnce({ id: '901', fulfillment_source: 'HQ' });
    await expect(
      lifecycle.create(createDto() as never, REGISTRATOR),
    ).resolves.toEqual({ id: '901', fulfillment_source: 'HQ' });
    expect(createOnce.mock.calls.map((call) => call[3])).toEqual([PLAN, null]);
  });

  it('reja bor va band bo`ldi — bitta yaratish; boshqa xato — qayta urinilmaydi', async () => {
    const ok = makeLifecycle(PLAN);
    ok.createOnce.mockResolvedValueOnce({ id: '900' });
    await ok.lifecycle.create(createDto() as never, REGISTRATOR);
    expect(ok.createOnce).toHaveBeenCalledTimes(1);

    const failing = makeLifecycle(PLAN);
    const boom = new RpcException({ statusCode: 400, message: 'bad' });
    failing.createOnce.mockRejectedValueOnce(boom);
    await expect(
      failing.lifecycle.create(createDto() as never, REGISTRATOR),
    ).rejects.toBe(boom);
    expect(failing.createOnce).toHaveBeenCalledTimes(1);
  });

  it('reja yo`q (HQ) yoki ombor servisi yo`q — to`g`ridan HQ', async () => {
    const hq = makeLifecycle(null);
    hq.createOnce.mockResolvedValueOnce({ id: '902' });
    await hq.lifecycle.create(
      createDto({ fulfillment: 'hq' }) as never,
      MARKET,
    );
    expect(hq.createOnce.mock.calls[0][3]).toBeNull();

    const legacy = makeLifecycle(null);
    legacy.lifecycle.orderWarehouse = undefined;
    legacy.createOnce.mockResolvedValueOnce({ id: '903' });
    await legacy.lifecycle.create(createDto() as never, MARKET);
    expect(legacy.createOnce.mock.calls[0][3]).toBeNull();
  });
});
