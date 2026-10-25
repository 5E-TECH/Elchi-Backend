/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { RpcException } from '@nestjs/microservices';
import {
  catchError,
  firstValueFrom,
  from,
  of,
  throwError,
  TimeoutError,
} from 'rxjs';
import { DataSource } from 'typeorm';
import {
  IdempotencyKey,
  Order_status,
  OutboxEvent,
  OutboxService,
  WAREHOUSE_RPC,
} from '@app/common';
import { Order, OrderHolderType } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { OrderSettlement } from '../entities/order-settlement.entity';
import { OrderSettlementCarry } from '../entities/order-settlement-carry.entity';
import { OrderCustodyService } from '../custody/order-custody.service';
import { OrderLifecycleService } from '../lifecycle/order-lifecycle.service';
import { OrderServiceService } from '../order-service.service';
import { OrderWarehouseService } from './order-warehouse.service';
import { Product } from '../../../catalog-service/src/entities/product.entity';
import {
  Warehouse,
  WAREHOUSE_ENTITIES,
  WarehouseController,
  WarehouseService,
  WarehouseStockService,
} from '../../../catalog-service/src/warehouse';
import type { WarehouseDirectoryService } from '../../../catalog-service/src/warehouse/warehouse-directory.service';
import { WarehouseModule1716000000143 } from '../../../../migrations/1716000000143-WarehouseModule';
import { OrderFulfillmentSource1716000000153 } from '../../../../migrations/1716000000153-OrderFulfillmentSource';

/**
 * 6kHnNH9j — ombor ↔ buyurtma oqimi HAQIQIY Postgres'da, ikki servis bilan:
 * order-service (`OrderLifecycleService` + `OrderWarehouseService`, haqiqiy
 * outbox) va catalog-service (`WarehouseController` → `WarehouseService` /
 * `WarehouseStockService`, migratsiya 143). RMQ o'rniga soxta CATALOG
 * mijozi HAQIQIY controller'ga yo'naltiradi; outbox publisher o'rnida
 * `deliver()` — navbatdagi hodisalarni yuboradi (qayta yuborish ham).
 *
 *   - yaratish → band (shu tranzaksiyada, qo'riqchi o'chiriladi);
 *   - kuryerga berish → chiqim; takror yetkazish — no-op;
 *   - bekor posilka filialga qaytdi → qoldiq tiklanadi, buyurtma yopiladi;
 *   - kuryerga berilmasdan o'chirish → band bo'shaydi;
 *   - yetmaydi / poyga (reserve 409) / timeout → butun buyurtma HQ;
 *     timeout'dagi yetim bandni qo'riqchi bo'shatadi;
 *   - hodisalar tartibi almashsa (return oldin) — qoldiq to'g'ri, xato yo'q;
 *   - qisman sotuv bolasi — ota bandiga faqat o'z qatorlari bilan qaytadi;
 *   - migratsiya 153: up ikki marta, sukut HQ, CHECK, down.
 *
 * Faqat lokal `/elchi_e_test`:
 *   ORDER_WAREHOUSE_PG_TEST_URI=postgres://postgres:root@127.0.0.1:5432/elchi_e_test
 */
const uri = process.env.ORDER_WAREHOUSE_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_e_test'
  );
})();

type Row = Record<string, any>;

const ORDER = `owh_order_${process.pid}`;
const CATALOG = `owh_catalog_${process.pid}`;
const IDENTITY = `owh_identity_${process.pid}`;
const MIGRATION = `owh_mig_${process.pid}`;
const HQ_BRANCH = '1';
const BRANCH_SAM = '11';
const REGION_SAM = '7';
const DISTRICT_SAM = '700';
const MARKET_ID = '121';
const COURIER_ID = '301';
const REGISTRATOR = { id: '5', roles: ['registrator'] };
const MANAGER = { id: '31', roles: ['manager'] };
const SUPERADMIN = { id: '1', roles: ['superadmin'] };
const ADMIN = { id: '2', roles: ['admin'] };

(localTestDatabase ? describe : describe.skip)(
  '6kHnNH9j — ombor ↔ buyurtma oqimi, haqiqiy Postgres (pg)',
  () => {
    let orderDb: DataSource;
    let catalogDb: DataSource;
    let lifecycle: OrderLifecycleService & Row;
    let stock: WarehouseStockService;
    let warehouses: WarehouseService;
    let controller: WarehouseController;
    let warehouseId: string;
    let productId: string;
    /** Soxta CATALOG: RESERVE dan oldin/keyin aralashish (poyga, timeout). */
    let reserveHook:
      | ((payload: Row, run: () => Promise<unknown>) => Promise<unknown>)
      | null = null;
    const catalogCalls: string[] = [];

    const directory = {
      getBranch: jest.fn((id: string) =>
        Promise.resolve(
          id === BRANCH_SAM
            ? {
                id,
                name: 'Samarqand filiali',
                type: 'REGIONAL',
                status: 'active',
                address: null,
                region_id: REGION_SAM,
                region: { id: REGION_SAM, name: 'Samarqand' },
                // Pa1KaXmj: `eligible` → ombor ochish / viloyat nomzodi.
                is_hq: false,
                can_host_warehouse: true,
                regional: true,
              }
            : null,
        ),
      ),
      getHqBranchId: jest.fn(() => Promise.resolve(HQ_BRANCH)),
      getBranches: jest.fn(async (ids: string[]) => {
        const map = new Map();
        for (const id of ids) map.set(id, await directory.getBranch(id));
        return map;
      }),
      getBranchManagerIds: jest.fn(() => Promise.resolve(['31'])),
      getFirstActiveBranchManagerId: jest.fn(() => Promise.resolve('31')),
      regionForDistrict: jest.fn((id: string) =>
        Promise.resolve(id === DISTRICT_SAM ? REGION_SAM : null),
      ),
      getUsers: jest.fn(() => Promise.resolve(new Map())),
      getUserSummaries: jest.fn(() => Promise.resolve(new Map())),
      getMarkets: jest.fn(() => Promise.resolve(new Map())),
      getMarket: jest.fn((id: string) =>
        Promise.resolve({
          id,
          name: 'Baraka',
          status: 'active',
          can_order_from_warehouse: true,
        }),
      ),
    };

    const rmq = { ack: jest.fn(), nackForError: jest.fn() };
    const ctx = { getPattern: () => 'test' } as never;
    const route = (cmd: string, payload: Row): Promise<unknown> => {
      const handlers: Record<string, () => Promise<unknown>> = {
        [WAREHOUSE_RPC.RESOLVE_SOURCE]: () =>
          controller.resolveSource(payload, ctx),
        [WAREHOUSE_RPC.RESERVE]: () => controller.reserve(payload, ctx),
        [WAREHOUSE_RPC.RELEASE]: () => controller.release(payload, ctx),
        [WAREHOUSE_RPC.OUT]: () => controller.out(payload, ctx),
        [WAREHOUSE_RPC.RETURN]: () =>
          controller.returnToWarehouse(payload, ctx),
        [WAREHOUSE_RPC.FIND_BY_IDS]: () => controller.findByIds(payload, ctx),
      };
      const handler = handlers[cmd];
      if (!handler) return Promise.reject(new Error(`no ${cmd}`));
      return handler();
    };
    const roundTrip = <T>(value: T): T =>
      value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
    const catalogClient = {
      send: jest.fn((pattern: { cmd: string }, payload: Row) => {
        catalogCalls.push(pattern.cmd);
        const run = () => route(pattern.cmd, roundTrip(payload));
        const work =
          pattern.cmd === WAREHOUSE_RPC.RESERVE && reserveHook
            ? reserveHook(roundTrip(payload), run)
            : run();
        return from(work.then(roundTrip)).pipe(
          catchError((error: unknown) =>
            throwError(() =>
              error instanceof RpcException ? error.getError() : error,
            ),
          ),
        );
      }),
    };

    const createOrder = (
      quantity: number,
      extra: Row = {},
      requester: Row = REGISTRATOR,
    ) =>
      lifecycle.create(
        {
          market_id: MARKET_ID,
          customer_id: '801',
          total_price: 150000,
          where_deliver: 'center' as never,
          district_id: DISTRICT_SAM,
          region_id: REGION_SAM,
          items: [{ product_id: productId, quantity }],
          fulfillment: 'auto',
          ...extra,
        },
        requester as never,
      );

    const stockRow = async () =>
      (
        await catalogDb.query(
          `SELECT on_hand, reserved FROM "${CATALOG}".warehouse_stock
            WHERE warehouse_id = $1 AND product_id = $2`,
          [warehouseId, productId],
        )
      )[0] as { on_hand: number; reserved: number };

    const orderRow = async (id: string) =>
      (
        await orderDb.query(
          `SELECT id::text, status::text, fulfillment_source,
                  warehouse_id::text, branch_id::text, home_branch_id::text,
                  holder_type::text, holder_branch_id::text,
                  holder_courier_id::text, post_id::text
             FROM "${ORDER}".orders WHERE id = $1`,
          [id],
        )
      )[0] as Row;

    const pendingCatalog = async (): Promise<Row[]> =>
      orderDb.query(
        `SELECT id::text, pattern, payload, scheduled_at FROM "${ORDER}".outbox_events
          WHERE target = 'CATALOG' AND status = 'pending' ORDER BY id`,
      );

    /** Outbox ichki konteksti (`_audit_ctx`) handler'ga yuborilmaydi. */
    const handlerPayload = (raw: unknown): Row => {
      const payload: Row = { ...((raw as Row | null) ?? {}) };
      delete payload._audit_ctx;
      return payload;
    };

    /** Outbox publisher o'rnida: vaqti kelgan CATALOG hodisalarini yuboradi. */
    const deliver = async (
      opts: { patterns?: string[]; markPublished?: boolean } = {},
    ) => {
      const due: Row[] = await orderDb.query(
        `SELECT id::text, pattern, payload FROM "${ORDER}".outbox_events
          WHERE target = 'CATALOG' AND status = 'pending' AND scheduled_at <= now()
          ORDER BY scheduled_at, id`,
      );
      const sent: string[] = [];
      for (const event of due) {
        if (opts.patterns && !opts.patterns.includes(event.pattern)) continue;
        await firstValueFrom(
          catalogClient.send(
            { cmd: event.pattern },
            handlerPayload(event.payload),
          ),
        );
        sent.push(event.pattern);
        if (opts.markPublished !== false) {
          await orderDb.query(
            `UPDATE "${ORDER}".outbox_events SET status = 'published' WHERE id = $1`,
            [event.id],
          );
        }
      }
      return sent;
    };

    /** Bitta buyurtmaning yuborilgan hodisalarini yana yuborish (takror yetkazish). */
    const redeliverAll = async (orderId: string) => {
      const rows: Row[] = await orderDb.query(
        `SELECT pattern, payload FROM "${ORDER}".outbox_events
          WHERE target = 'CATALOG' AND status = 'published'
            AND payload->>'order_id' = $1 ORDER BY id`,
        [orderId],
      );
      for (const row of rows) {
        await firstValueFrom(
          catalogClient.send({ cmd: row.pattern }, handlerPayload(row.payload)),
        );
      }
      return rows.length;
    };

    const assign = (id: string) =>
      lifecycle.updateFull(
        id,
        {
          courier_id: COURIER_ID,
          assigned_at: new Date().toISOString(),
          status: Order_status.ON_THE_ROAD,
          post_id: '9001',
        },
        { ...MANAGER, note: 'Manager tomonidan ommaviy courier biriktirish' },
      );

    /** Kuryer bekor qiladi → bekor pochta → filial qabul qiladi (logistics yo'li). */
    const cancelAndReturnToBranch = async (id: string) => {
      await lifecycle.updateFull(id, { status: Order_status.WAITING }, MANAGER);
      await lifecycle.updateFull(
        id,
        { status: Order_status.CANCELLED },
        { id: COURIER_ID, roles: ['courier'], note: 'Order canceled' },
      );
      await lifecycle.updateFull(
        id,
        {
          status: Order_status.CANCELLED_SENT,
          canceled_post_id: '9100',
          branch_id: BRANCH_SAM,
          courier_id: null,
          assigned_at: null,
        },
        { id: COURIER_ID, roles: ['courier'], note: 'Canceled post created' },
      );
      await lifecycle.updateFull(
        id,
        {
          status: Order_status.CANCELLED,
          branch_id: BRANCH_SAM,
          courier_id: null,
          assigned_at: null,
          canceled_post_id: null,
        },
        { ...MANAGER, note: 'Canceled order received by branch manager' },
      );
    };

    beforeAll(async () => {
      orderDb = new DataSource({
        type: 'postgres',
        url: uri,
        schema: ORDER,
        entities: [
          Order,
          OrderItem,
          OrderTracking,
          OrderCustodyEvent,
          Branch,
          OrderSettlement,
          OrderSettlementCarry,
          OutboxEvent,
          IdempotencyKey,
        ],
      });
      await orderDb.initialize();
      for (const schema of [ORDER, CATALOG, IDENTITY, MIGRATION]) {
        await orderDb.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await orderDb.query(`CREATE SCHEMA "${schema}"`);
      }
      await orderDb.query('CREATE SCHEMA IF NOT EXISTS "branch_schema"');
      await orderDb.synchronize();
      // Migratsiya 153 sinxronlangan jadvalda: CHECK'lar va indeks.
      const runner = orderDb.createQueryRunner();
      try {
        await new OrderFulfillmentSource1716000000153(ORDER).up(runner);
      } finally {
        await runner.release();
      }

      catalogDb = new DataSource({
        type: 'postgres',
        url: uri,
        schema: CATALOG,
        entities: [Product, ...WAREHOUSE_ENTITIES],
        extra: { max: 10 },
      });
      await catalogDb.initialize();
      await catalogDb.query(`
        CREATE TABLE "${CATALOG}".products (
          "id" BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "is_deleted" boolean NOT NULL DEFAULT false,
          "name" character varying NOT NULL,
          "user_id" bigint NOT NULL,
          "image_url" character varying,
          "price" numeric(14,2),
          "weight_kg" numeric(10,3),
          "length_cm" integer,
          "width_cm" integer,
          "height_cm" integer,
          "volumetric_enabled" boolean NOT NULL DEFAULT true,
          "barcode" character varying(512),
          "sku_code" character varying(32) GENERATED ALWAYS AS (
            'ELC-P-' || lpad("id"::text, GREATEST(6, length("id"::text)), '0')
          ) STORED
        )`);
      const catalogRunner = catalogDb.createQueryRunner();
      try {
        await new WarehouseModule1716000000143(CATALOG, IDENTITY).up(
          catalogRunner,
        );
      } finally {
        await catalogRunner.release();
      }
      const activityLog = { log: jest.fn(), logChange: jest.fn() };
      warehouses = new WarehouseService(
        catalogDb.getRepository(Warehouse),
        catalogDb,
        directory as unknown as WarehouseDirectoryService,
        activityLog as never,
      );
      stock = new WarehouseStockService(catalogDb, activityLog as never);
      controller = new WarehouseController(rmq as never, warehouses, stock);

      const outbox = new OutboxService(orderDb.getRepository(OutboxEvent));
      const custody = new OrderCustodyService(
        orderDb.getRepository(OrderTracking),
        orderDb.getRepository(OrderCustodyEvent),
      );
      const orderWarehouse = new OrderWarehouseService(
        catalogClient as never,
        outbox,
        custody,
      );
      const instance = Object.create(
        OrderLifecycleService.prototype,
      ) as OrderLifecycleService & Row;
      Object.assign(instance, {
        logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
        dataSource: orderDb,
        orderRepo: orderDb.getRepository(Order),
        orderItemRepo: orderDb.getRepository(OrderItem),
        orderSettlementRepo: orderDb.getRepository(OrderSettlement),
        outbox,
        custody,
        orderWarehouse,
        lookup: { getHqBranchId: jest.fn().mockResolvedValue(HQ_BRANCH) },
        branchClient: { send: jest.fn(() => of({ data: { name: 'Filial' } })) },
        activityLog: { log: jest.fn().mockResolvedValue(undefined) },
        enqueueFinanceOnStatusChange: jest.fn().mockResolvedValue(undefined),
        queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
        // HQ yaratish — HQ filiali (branch-service'siz).
        resolveBranchIdForOrder: jest.fn().mockResolvedValue(HQ_BRANCH),
      });
      lifecycle = instance;
    }, 60_000);

    afterAll(async () => {
      if (catalogDb?.isInitialized) await catalogDb.destroy();
      if (orderDb?.isInitialized) {
        for (const schema of [ORDER, CATALOG, IDENTITY, MIGRATION]) {
          await orderDb.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
        await orderDb.destroy();
      }
    });

    beforeEach(async () => {
      reserveHook = null;
      catalogCalls.length = 0;
      await orderDb.query(
        `TRUNCATE "${ORDER}".orders, "${ORDER}".order_items,
          "${ORDER}".order_tracking, "${ORDER}".order_custody_events,
          "${ORDER}".outbox_events RESTART IDENTITY CASCADE`,
      );
      await catalogDb.query(
        `TRUNCATE "${CATALOG}".stock_reservations, "${CATALOG}".warehouse_stock,
          "${CATALOG}".warehouses, "${CATALOG}".products RESTART IDENTITY CASCADE`,
      );
      // stock_movements — faqat qo'shiladigan (trigger): TRUNCATE ruxsat.
      await catalogDb.query(`TRUNCATE "${CATALOG}".stock_movements`);
      const [product]: Array<{ id: string }> = await catalogDb.query(
        `INSERT INTO "${CATALOG}".products (name, user_id) VALUES ('Shapka', $1)
         RETURNING id::text AS id`,
        [MARKET_ID],
      );
      productId = product.id;
      const warehouse = await warehouses.create(
        { branch_id: BRANCH_SAM },
        ADMIN,
      );
      warehouseId = warehouse.id;
      await stock.stockIn({
        warehouse_id: warehouseId,
        lines: [{ product_id: productId, qty: 5 }],
        idempotency_key: `seed-${process.pid}-${Date.now()}`,
        actor: ADMIN,
      });
    });

    it('⭐ yaratish → band (shu tranzaksiyada) → kuryer → chiqim → bekor posilka filialga → qoldiq tiklanadi; takror yetkazish — no-op', async () => {
      const created = await createOrder(2);
      expect(await orderRow(created.id)).toMatchObject({
        status: Order_status.RECEIVED,
        fulfillment_source: 'WAREHOUSE',
        warehouse_id: warehouseId,
        branch_id: BRANCH_SAM,
        home_branch_id: BRANCH_SAM,
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: BRANCH_SAM,
        post_id: null,
      });
      expect(await stockRow()).toEqual({ on_hand: 5, reserved: 2 });
      // Qo'riqchi buyurtma bilan birga o'chirildi — hech narsa navbatda yo'q.
      expect(await pendingCatalog()).toEqual([]);

      await assign(created.id);
      expect((await pendingCatalog()).map((e) => e.pattern)).toEqual([
        WAREHOUSE_RPC.OUT,
      ]);
      expect(await deliver()).toEqual([WAREHOUSE_RPC.OUT]);
      expect(await stockRow()).toEqual({ on_hand: 3, reserved: 0 });

      await cancelAndReturnToBranch(created.id);
      expect(await deliver()).toEqual([WAREHOUSE_RPC.RETURN]);
      expect(await stockRow()).toEqual({ on_hand: 5, reserved: 0 });
      expect(await orderRow(created.id)).toMatchObject({
        status: Order_status.RETURNED_TO_MARKET,
        holder_type: OrderHolderType.MARKET,
        holder_branch_id: null,
      });
      // created_at — tranzaksiya vaqti (filial qabuli va yopilish bir xil),
      // shuning uchun tartib emas, tarkib tekshiriladi.
      const tracking: Row[] = await orderDb.query(
        `SELECT from_status::text, to_status::text, action FROM "${ORDER}".order_tracking
          WHERE order_id = $1`,
        [created.id],
      );
      expect(tracking).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from_status: Order_status.CANCELLED_SENT,
            to_status: Order_status.CANCELLED,
          }),
          {
            from_status: Order_status.CANCELLED,
            to_status: Order_status.RETURNED_TO_MARKET,
            action: 'warehouse_returned',
          },
        ]),
      );
      const custodyRows: Row[] = await orderDb.query(
        `SELECT to_holder_type::text FROM "${ORDER}".order_custody_events
          WHERE order_id = $1 AND to_holder_type::text = 'MARKET'`,
        [created.id],
      );
      expect(custodyRows).toHaveLength(1);

      // RMQ/outbox qayta yetkazishi — qoldiq ikki marta o'zgarmaydi.
      expect(await redeliverAll(created.id)).toBe(2);
      expect(await stockRow()).toEqual({ on_hand: 5, reserved: 0 });
      const movements: Row[] = await catalogDb.query(
        `SELECT type, qty FROM "${CATALOG}".stock_movements
          WHERE ref_type = 'order' AND ref_id = $1 ORDER BY id`,
        [created.id],
      );
      expect(movements).toEqual([
        { type: 'RESERVE', qty: 2 },
        { type: 'OUT', qty: -2 },
        { type: 'RETURN', qty: 2 },
      ]);
    });

    it('⭐ kuryerga berilmasdan o`chirish → band bo`shaydi (bir marta)', async () => {
      const created = await createOrder(3);
      expect(await stockRow()).toEqual({ on_hand: 5, reserved: 3 });
      await lifecycle.remove(created.id, SUPERADMIN);
      expect(await deliver()).toEqual([WAREHOUSE_RPC.RELEASE]);
      expect(await stockRow()).toEqual({ on_hand: 5, reserved: 0 });
      await redeliverAll(created.id);
      expect(await stockRow()).toEqual({ on_hand: 5, reserved: 0 });
    });

    it('⭐ yetmaydi (resolve) yoki `hq` — butun buyurtma HQ, band yo`q; HQ buyurtma kuryerga berilsa ombor RPC`si yo`q', async () => {
      const short = await createOrder(9);
      expect(await orderRow(short.id)).toMatchObject({
        status: Order_status.NEW,
        fulfillment_source: 'HQ',
        warehouse_id: null,
        holder_type: OrderHolderType.HQ,
      });
      expect(catalogCalls).toEqual([WAREHOUSE_RPC.RESOLVE_SOURCE]);

      catalogCalls.length = 0;
      const hq = await createOrder(1, { fulfillment: 'hq' });
      expect(await orderRow(hq.id)).toMatchObject({ fulfillment_source: 'HQ' });
      expect(catalogCalls).toEqual([]);

      await lifecycle.updateFull(
        hq.id,
        { status: Order_status.RECEIVED },
        ADMIN,
      );
      await assign(hq.id);
      expect(await pendingCatalog()).toEqual([]);
      expect(catalogCalls).toEqual([]);
      expect(await stockRow()).toEqual({ on_hand: 5, reserved: 0 });
    });

    it('⭐ poyga: resolve OK, reserve 409 (boshqa buyurtma oldin band qildi) → HQ; qo`riqchi bekor', async () => {
      reserveHook = async (_payload, run) => {
        await stock.reserve({
          order_id: '7777',
          warehouse_id: warehouseId,
          items: [{ product_id: productId, quantity: 4 }],
        });
        return run();
      };
      const created = await createOrder(2);
      expect(await orderRow(created.id)).toMatchObject({
        status: Order_status.NEW,
        fulfillment_source: 'HQ',
      });
      expect(await stockRow()).toEqual({ on_hand: 5, reserved: 4 });
      expect(await pendingCatalog()).toEqual([]);
    });

    it('⭐ timeout (catalog band qildi, javob yo`qoldi) → HQ; yetim bandni 10 daqiqalik qo`riqchi bo`shatadi', async () => {
      reserveHook = async (_payload, run) => {
        await run();
        throw new TimeoutError();
      };
      const created = await createOrder(2);
      expect(await orderRow(created.id)).toMatchObject({
        fulfillment_source: 'HQ',
      });
      // Birinchi urinishning (qaytarilgan) buyurtma id'sida band qoldi.
      expect(await stockRow()).toEqual({ on_hand: 5, reserved: 2 });
      const [guard] = await pendingCatalog();
      expect(guard).toMatchObject({
        pattern: WAREHOUSE_RPC.RELEASE,
        payload: expect.objectContaining({ note: 'order_create_guard' }),
      });
      expect(new Date(guard.scheduled_at).getTime()).toBeGreaterThan(
        Date.now() + 9 * 60_000,
      );
      expect(await deliver()).toEqual([]); // hali vaqti kelmagan
      await orderDb.query(
        `UPDATE "${ORDER}".outbox_events SET scheduled_at = now() WHERE id = $1`,
        [guard.id],
      );
      expect(await deliver()).toEqual([WAREHOUSE_RPC.RELEASE]);
      expect(await stockRow()).toEqual({ on_hand: 5, reserved: 0 });
    });

    it('hodisalar tartibi almashsa (return chiqimdan oldin yetsa) — qoldiq to`g`ri, out lenient (xato yo`q)', async () => {
      const created = await createOrder(2);
      await assign(created.id);
      await cancelAndReturnToBranch(created.id);
      expect((await pendingCatalog()).map((e) => e.pattern)).toEqual([
        WAREHOUSE_RPC.OUT,
        WAREHOUSE_RPC.RETURN,
      ]);
      expect(await deliver({ patterns: [WAREHOUSE_RPC.RETURN] })).toEqual([
        WAREHOUSE_RPC.RETURN,
      ]);
      expect(await deliver()).toEqual([WAREHOUSE_RPC.OUT]);
      expect(await stockRow()).toEqual({ on_hand: 5, reserved: 0 });
    });

    it('qisman sotuv bolasi: ota bandiga faqat o`z qatorlari bilan qaytadi (alohida kalit)', async () => {
      const parent = await createOrder(2);
      await assign(parent.id);
      await deliver();
      expect(await stockRow()).toEqual({ on_hand: 3, reserved: 0 });
      // partlySellOrder yaratadigan bola (CANCELLED, kuryerda, ota manbasi bilan).
      const child = await orderDb.getRepository(Order).save(
        orderDb.getRepository(Order).create({
          market_id: MARKET_ID,
          customer_id: '801',
          total_price: 50000,
          status: Order_status.CANCELLED,
          branch_id: BRANCH_SAM,
          home_branch_id: BRANCH_SAM,
          courier_id: COURIER_ID,
          holder_type: OrderHolderType.COURIER,
          holder_branch_id: BRANCH_SAM,
          holder_courier_id: COURIER_ID,
          parent_order_id: parent.id,
          qr_code_token: `CANCEL-${Date.now()}`,
          ...lifecycle.orderWarehouse.inheritedFields(
            await orderDb
              .getRepository(Order)
              .findOneByOrFail({ id: parent.id }),
          ),
        }),
      );
      await orderDb.query(
        `INSERT INTO "${ORDER}".order_items (order_id, product_id, quantity) VALUES ($1, $2, 1)`,
        [child.id, productId],
      );
      await lifecycle.updateFull(
        child.id,
        {
          status: Order_status.CANCELLED_SENT,
          canceled_post_id: '9100',
          branch_id: BRANCH_SAM,
          courier_id: null,
        },
        { id: COURIER_ID, roles: ['courier'] },
      );
      await lifecycle.updateFull(
        child.id,
        { status: Order_status.CANCELLED, canceled_post_id: null },
        MANAGER,
      );
      const [event] = await pendingCatalog();
      expect(event.payload).toMatchObject({
        order_id: parent.id,
        items: [{ product_id: productId, quantity: 1 }],
        idempotency_key: `child-order-${child.id}`,
      });
      await deliver();
      expect(await stockRow()).toEqual({ on_hand: 4, reserved: 0 });
      await redeliverAll(parent.id);
      expect(await stockRow()).toEqual({ on_hand: 4, reserved: 0 });
    });

    it('market yaratuvchi: kalit o`chiq — HQ (catalog MARKET_NOT_ALLOWED)', async () => {
      directory.getMarket.mockResolvedValueOnce({
        id: MARKET_ID,
        name: 'Baraka',
        status: 'active',
        can_order_from_warehouse: false,
      });
      const created = await createOrder(
        1,
        {},
        { id: MARKET_ID, roles: ['market'] },
      );
      expect(await orderRow(created.id)).toMatchObject({
        fulfillment_source: 'HQ',
      });
      expect(await stockRow()).toEqual({ on_hand: 5, reserved: 0 });
    });

    it('⭐ ro`yxat va detal: `fulfillment_source` + `warehouse { id, name, branch_id }`; `?fulfillment_source=WAREHOUSE` filtri; noto`g`ri — 400', async () => {
      const fromWarehouse = await createOrder(1);
      const fromHq = await createOrder(1, { fulfillment: 'hq' });
      const service = Object.create(
        OrderServiceService.prototype,
      ) as OrderServiceService & Row;
      const empty = { send: jest.fn(() => of({ data: [] })) };
      Object.assign(service, {
        logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
        orderRepo: orderDb.getRepository(Order),
        identityClient: empty,
        logisticsClient: empty,
        catalogClient: empty,
        orderWarehouse: lifecycle.orderWarehouse,
        loadPostCourierIds: jest.fn(() => Promise.resolve(new Map())),
        loadCourierSummaries: jest.fn(() => Promise.resolve(new Map())),
      });

      const listed = await service.findAll({ fulfillment_source: 'WAREHOUSE' });
      expect(listed.data.map((row: Row) => row.id)).toEqual([fromWarehouse.id]);
      const hqOnly = await service.findAll({ fulfillment_source: 'hq' });
      expect(hqOnly.data.map((row: Row) => row.id)).toEqual([fromHq.id]);
      const all = await service.findAll({});
      expect(all.data).toHaveLength(2);
      await expect(
        service.findAll({ fulfillment_source: 'ombor' }),
      ).rejects.toBeInstanceOf(RpcException);

      const enriched = (await service.findAllEnriched({})).data as Row[];
      const byId = new Map(enriched.map((row) => [row.id, row]));
      expect(byId.get(fromWarehouse.id)).toMatchObject({
        fulfillment_source: 'WAREHOUSE',
        warehouse: {
          id: warehouseId,
          name: 'Samarqand filiali ombori',
          branch_id: BRANCH_SAM,
        },
      });
      expect(byId.get(fromHq.id)).toMatchObject({
        fulfillment_source: 'HQ',
        warehouse: null,
      });
      await expect(
        service.findByIdEnriched(fromWarehouse.id),
      ).resolves.toMatchObject({
        warehouse: { id: warehouseId, branch_id: BRANCH_SAM },
      });
    });

    it('migratsiya 153: up ikki marta, eski qatorlar HQ, CHECK, down — ustunlar yo`q', async () => {
      const migration = new OrderFulfillmentSource1716000000153(MIGRATION);
      await orderDb.query(
        `CREATE TABLE "${MIGRATION}".orders (id bigserial PRIMARY KEY, status varchar)`,
      );
      await orderDb.query(
        `INSERT INTO "${MIGRATION}".orders (status) VALUES ('sold'), ('new')`,
      );
      const run = async (direction: 'up' | 'down') => {
        const runner = orderDb.createQueryRunner();
        try {
          await migration[direction](runner);
        } finally {
          await runner.release();
        }
      };
      await run('up');
      await expect(run('up')).resolves.toBeUndefined();
      expect(
        await orderDb.query(
          `SELECT fulfillment_source, warehouse_id FROM "${MIGRATION}".orders ORDER BY id`,
        ),
      ).toEqual([
        { fulfillment_source: 'HQ', warehouse_id: null },
        { fulfillment_source: 'HQ', warehouse_id: null },
      ]);
      const pgCode = async (sql: string) =>
        orderDb.query(sql).then(
          () => null,
          (e: { driverError?: { code?: string } }) =>
            e?.driverError?.code ?? null,
        );
      expect(
        await pgCode(
          `INSERT INTO "${MIGRATION}".orders (fulfillment_source) VALUES ('WAREHOUSE')`,
        ),
      ).toBe('23514');
      expect(
        await pgCode(
          `INSERT INTO "${MIGRATION}".orders (fulfillment_source, warehouse_id) VALUES ('HQ', 3)`,
        ),
      ).toBe('23514');
      expect(
        await pgCode(
          `INSERT INTO "${MIGRATION}".orders (fulfillment_source, warehouse_id) VALUES ('BRANCH', NULL)`,
        ),
      ).toBe('23514');
      expect(
        await pgCode(
          `INSERT INTO "${MIGRATION}".orders (fulfillment_source, warehouse_id) VALUES ('WAREHOUSE', 3)`,
        ),
      ).toBeNull();
      await run('down');
      const columns: Row[] = await orderDb.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'orders' ORDER BY column_name`,
        [MIGRATION],
      );
      expect(columns.map((c) => c.column_name)).toEqual(['id', 'status']);
      await expect(run('down')).resolves.toBeUndefined();
      await orderDb.query(`DROP TABLE "${MIGRATION}".orders`);
      await expect(run('up')).resolves.toBeUndefined();
    });
  },
);
