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
};

const resolveReply = (source: 'WAREHOUSE' | 'HQ') => ({
  source,
  reason: source === 'WAREHOUSE' ? 'OK' : 'INSUFFICIENT_STOCK',
  warehouse: { id: '3', name: 'Samarqand ombori', branch_id: '11' },
});

const make = (
  handlers: Record<string, (payload: any) => Observable<unknown>> = {},
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
  const repos = new Map<unknown, unknown>([
    [OutboxEvent, { delete: deleteOutbox }],
  ]);
  const manager = {
    getRepository: jest.fn((entity: { name?: string }) => {
      if (repos.has(entity)) return repos.get(entity);
      if (entity?.name === 'Order') return { update: updateOrder };
      if (entity?.name === 'OrderItem') return { find: findItems };
      return {};
    }),
  };
  const service = new OrderWarehouseService(
    { send } as never,
    outbox as never,
    custody as never,
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
