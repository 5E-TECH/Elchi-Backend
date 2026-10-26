/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { createHash } from 'node:crypto';
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
  BranchTransferBatchStatus,
  BranchTransferDirection,
  IdempotencyKey,
  Order_status,
  OutboxEvent,
  OutboxService,
  WAREHOUSE_ERROR_CODES,
  WAREHOUSE_HQ_TIER_FLAG,
  WAREHOUSE_RPC,
} from '@app/common';
import { Order, OrderHolderType } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { OrderSettlement } from '../entities/order-settlement.entity';
import { OrderSettlementCarry } from '../entities/order-settlement-carry.entity';
import { BranchTransferBatch } from '../entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from '../entities/branch-transfer-batch-item.entity';
import { BranchTransferBatchHistory } from '../entities/branch-transfer-batch-history.entity';
import { MarketCancelledHandoverSession } from '../entities/market-cancelled-handover-session.entity';
import { OrderCustodyService } from '../custody/order-custody.service';
import { OrderLifecycleService } from '../lifecycle/order-lifecycle.service';
import { OrderServiceService } from '../order-service.service';
import { BranchTransferBatchService } from '../transfer-batch/branch-transfer-batch.service';
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
    /**
     * VkKDSNNn: HQ filiali ('1') katalog ma'lumotnomasida — faqat markaziy
     * ombor zanjiri describe'ida yoqiladi (mavjud testlar bugungidek).
     */
    let hqBranchListed = false;

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
            : id === HQ_BRANCH && hqBranchListed
              ? {
                  id,
                  name: 'Markaziy filial',
                  type: 'HQ',
                  status: 'active',
                  address: null,
                  // Ataylab buyurtma hududi bilan bir xil: HQ baribir viloyat
                  // nomzodi emas (`regional: false`), faqat 2-pog'ona.
                  region_id: REGION_SAM,
                  region: { id: REGION_SAM, name: 'Samarqand' },
                  is_hq: true,
                  can_host_warehouse: true,
                  regional: false,
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
          // VkKDSNNn: qaytarish partiyasi (HQ qabuli) va marketga topshirish
          // sessiyasi — markaziy ombor zanjiri uchun.
          BranchTransferBatch,
          BranchTransferBatchItem,
          BranchTransferBatchHistory,
          MarketCancelledHandoverSession,
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
        ref_order_id: String(child.id),
      });
      await deliver();
      expect(await stockRow()).toEqual({ on_hand: 4, reserved: 0 });
      // hfkhYrGk: jurnalda qaytish bola buyurtma bilan (band — otada).
      const returns = await catalogDb.query(
        `SELECT ref_id FROM "${CATALOG}".stock_movements
          WHERE type = 'RETURN' AND ref_type = 'order' ORDER BY id`,
      );
      expect(returns.map((row: Row) => String(row.ref_id))).toEqual([
        String(child.id),
      ]);
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

    /**
     * VkKDSNNn — MARKAZIY OMBOR (2-pog'ona) zanjiri, haqiqiy Postgres'da.
     * Alohida harness: kalit yoqilgan catalog `WarehouseService` (5-arg
     * config), HQ id'ni biladigan `OrderWarehouseService` (4-arg lookup),
     * logistika mijozi (pochtaga biriktirish) va qaytarish partiyasi servisi.
     * Tashqi describe'ning `lifecycle` / `controller` i shu yerda vaqtincha
     * almashtiriladi va `afterAll` da tiklanadi — yuqoridagi viloyat testlari
     * o'zgarishsiz.
     *
     * Qoldiq: viloyat ombori (Samarqand) 5 dona, Markaziy ombor (HQ '1')
     * 10 dona — 7 donali buyurtma viloyatda yetmaydi, Markaziyda yetadi.
     */
    describe('markaziy ombor zanjiri (VkKDSNNn)', () => {
      const HQ_MANAGER = { id: '41', roles: ['manager'] };
      const COURIER = { id: COURIER_ID, roles: ['courier'] };
      let hqTierFlag = true;
      let hqIdKnown = true;
      let logisticsPostId: string | null = '9001';
      const logisticsCalls: Array<{ cmd: string; payload: Row }> = [];
      let centralId: string;
      let regularLifecycle: OrderLifecycleService & Row;
      let regularController: WarehouseController;
      let hqWarehouses: WarehouseService;
      let batches: BranchTransferBatchService;
      let hqOrderWarehouse: OrderWarehouseService;

      /** HQ id manbai — order-service `OrderLookupService` o'rnida. */
      const hqLookup = {
        getHqBranchId: jest.fn(() =>
          Promise.resolve(hqIdKnown ? HQ_BRANCH : null),
        ),
        getMarketsByIds: jest.fn((ids: string[]) =>
          Promise.resolve(ids.map((id) => ({ id, name: 'Baraka' }))),
        ),
      };
      /** logistics `receiveOrdersIntoPosts` javobi: `{statusCode, data[]}`. */
      const logisticsClient = {
        send: jest.fn((pattern: { cmd: string }, payload: Row) => {
          logisticsCalls.push({ cmd: pattern.cmd, payload });
          const orders = (payload?.orders ?? []) as Row[];
          return of({
            statusCode: 200,
            message: 'Posts assigned',
            data: logisticsPostId
              ? orders.map((o) => ({
                  order_id: o.order_id,
                  post_id: logisticsPostId,
                }))
              : [],
          });
        }),
      };
      /** Filial xodimi — Samarqand menejeri (marketga topshirish yo'li). */
      const branchClient = {
        send: jest.fn((pattern: { cmd: string }) =>
          of(
            pattern.cmd === 'branch.user.find_by_user'
              ? {
                  data: { branch_id: BRANCH_SAM, branch: { type: 'REGIONAL' } },
                }
              : { data: { name: 'Filial' } },
          ),
        ),
      };

      const centralRow = async () =>
        (
          await catalogDb.query(
            `SELECT on_hand, reserved FROM "${CATALOG}".warehouse_stock
              WHERE warehouse_id = $1 AND product_id = $2`,
            [centralId, productId],
          )
        )[0] as { on_hand: number; reserved: number };

      const regionOf = async (id: string) => {
        const rows: Row[] = await orderDb.query(
          `SELECT region_id::text FROM "${ORDER}".orders WHERE id = $1`,
          [id],
        );
        return (rows[0]?.region_id ?? null) as string | null;
      };

      const orderMovements = async (id: string): Promise<Row[]> =>
        catalogDb.query(
          `SELECT warehouse_id::text, type, qty FROM "${CATALOG}".stock_movements
            WHERE ref_type = 'order' AND ref_id = $1 ORDER BY id`,
          [id],
        );

      const rpcErrorOf = async (work: Promise<unknown>): Promise<Row> => {
        try {
          await work;
        } catch (error) {
          expect(error).toBeInstanceOf(RpcException);
          return (error as RpcException).getError() as Row;
        }
        throw new Error('RpcException kutilgan edi');
      };

      /**
       * branch-service `dispatchPostToBranch`: HQ pochtasi viloyat filialiga
       * (`holder_*` ni ham yuboradi — updateFull ularni e'tiborsiz qoldiradi,
       * egalik `branch_id` dan hisoblanadi).
       */
      const dispatchToSam = (id: string) =>
        lifecycle.updateFull(
          id,
          {
            branch_id: BRANCH_SAM,
            holder_type: OrderHolderType.BRANCH,
            holder_branch_id: BRANCH_SAM,
            holder_courier_id: null,
            post_id: '9002',
            current_batch_id: null,
            status: Order_status.ON_THE_ROAD,
          } as never,
          { ...HQ_MANAGER, note: 'Post dispatched to branch' },
        );

      /** logistics `receivePost` — filial pochtani qabul qildi (WAITING). */
      const receiveAtSam = (id: string) =>
        lifecycle.updateFull(
          id,
          { status: Order_status.WAITING, branch_id: BRANCH_SAM },
          { ...MANAGER, note: 'Post received by branch' },
        );

      /** logistics `createCanceledPostToHq` → `receiveCanceledPost` (HQ). */
      const sendCancelledToHq = async (id: string) => {
        await lifecycle.updateFull(
          id,
          {
            status: Order_status.CANCELLED_SENT,
            branch_id: HQ_BRANCH,
            courier_id: null,
            assigned_at: null,
            canceled_post_id: '9200',
          },
          { ...MANAGER, note: 'Branch canceled post sent to HQ' },
        );
        await lifecycle.updateFull(
          id,
          {
            status: Order_status.CANCELLED,
            branch_id: HQ_BRANCH,
            courier_id: null,
            assigned_at: null,
            canceled_post_id: null,
          },
          {
            ...HQ_MANAGER,
            note: 'Canceled order received by HQ and held for market handover',
            canceled_post_sender: {
              user_id: MANAGER.id,
              role: 'manager',
              branch_id: BRANCH_SAM,
            },
          },
        );
      };

      /** HQ → filial → kuryer → bekor → filial qabuli (CANCELLED, BRANCH/11). */
      const runToCancelledAtSam = async (id: string) => {
        await dispatchToSam(id);
        await deliver();
        await receiveAtSam(id);
        await assign(id);
        await deliver();
        await cancelAndReturnToBranch(id);
      };

      beforeAll(() => {
        hqBranchListed = true;
        regularLifecycle = lifecycle;
        regularController = controller;
        const activityLog = { log: jest.fn(), logChange: jest.fn() };
        hqWarehouses = new WarehouseService(
          catalogDb.getRepository(Warehouse),
          catalogDb,
          directory as unknown as WarehouseDirectoryService,
          activityLog as never,
          {
            get: (key: string) =>
              key === WAREHOUSE_HQ_TIER_FLAG ? hqTierFlag : undefined,
          } as never,
        );
        // Shu sxemadagi o'sha jadvallar — tashqi harness bilan bir xil.
        const outbox = new OutboxService(orderDb.getRepository(OutboxEvent));
        const custody = new OrderCustodyService(
          orderDb.getRepository(OrderTracking),
          orderDb.getRepository(OrderCustodyEvent),
        );
        hqOrderWarehouse = new OrderWarehouseService(
          catalogClient as never,
          outbox,
          custody,
          hqLookup as never,
        );
        const hqLifecycle = Object.create(
          OrderLifecycleService.prototype,
        ) as OrderLifecycleService & Row;
        Object.assign(
          hqLifecycle,
          { ...regularLifecycle },
          {
            outbox,
            custody,
            orderWarehouse: hqOrderWarehouse,
            lookup: hqLookup,
            logisticsClient,
            branchClient,
            transferBatchItemRepo: orderDb.getRepository(
              BranchTransferBatchItem,
            ),
          },
        );
        batches = new BranchTransferBatchService(
          orderDb,
          orderDb.getRepository(BranchTransferBatch),
          orderDb.getRepository(BranchTransferBatchItem),
          orderDb.getRepository(BranchTransferBatchHistory),
          orderDb.getRepository(Order),
          orderDb.getRepository(OrderTracking),
          orderDb.getRepository(OrderCustodyEvent),
          { log: jest.fn().mockResolvedValue(undefined) } as never,
          custody,
          hqOrderWarehouse,
        );
        lifecycle = hqLifecycle;
        controller = new WarehouseController(rmq as never, hqWarehouses, stock);
      });

      afterAll(() => {
        lifecycle = regularLifecycle;
        controller = regularController;
        hqBranchListed = false;
      });

      beforeEach(async () => {
        hqTierFlag = true;
        hqIdKnown = true;
        logisticsPostId = '9001';
        logisticsCalls.length = 0;
        await orderDb.query(
          `TRUNCATE "${ORDER}".branch_transfer_batch_items,
            "${ORDER}".branch_transfer_batch_history,
            "${ORDER}".branch_transfer_batches,
            "${ORDER}".market_cancelled_handover_sessions RESTART IDENTITY CASCADE`,
        );
        // Markaziy ombor — HQ filialida (Pa1KaXmj: mas'ulsiz, nomi sukut).
        const central = await hqWarehouses.create(
          { branch_id: HQ_BRANCH },
          ADMIN,
        );
        centralId = central.id;
        expect(central).toMatchObject({ kind: 'HQ', branch_id: HQ_BRANCH });
        await stock.stockIn({
          warehouse_id: centralId,
          lines: [{ product_id: productId, qty: 10 }],
          idempotency_key: `seed-hq-${process.pid}-${Date.now()}`,
          actor: ADMIN,
        });
      });

      it('⭐ (a) viloyatda yetmaydi, Markaziyda yetadi → RECEIVED, HQ`da qabul qilingan, hudud pochtasiga biriktirildi, Markaziy band', async () => {
        const created = await createOrder(7);
        expect(created).toMatchObject({ post_id: '9001' });
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.RECEIVED,
          fulfillment_source: 'WAREHOUSE',
          warehouse_id: centralId,
          branch_id: HQ_BRANCH,
          home_branch_id: HQ_BRANCH,
          holder_type: OrderHolderType.HQ,
          holder_branch_id: null,
          holder_courier_id: null,
          post_id: '9001',
        });
        expect(await regionOf(created.id)).toBe(REGION_SAM);
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 7 });
        expect(await stockRow()).toEqual({ on_hand: 5, reserved: 0 });
        expect(catalogCalls).toEqual([
          WAREHOUSE_RPC.RESOLVE_SOURCE,
          WAREHOUSE_RPC.RESERVE,
        ]);
        // Qo'riqchi buyurtma bilan birga o'chirildi.
        expect(await pendingCatalog()).toEqual([]);
        expect(logisticsCalls).toEqual([
          {
            cmd: 'logistics.post.receive_orders',
            payload: expect.objectContaining({
              orders: [
                {
                  order_id: created.id,
                  assigned_region: REGION_SAM,
                  assigned_branch: HQ_BRANCH,
                  total_price: 150000,
                },
              ],
            }),
          },
        ]);
        const [createdTracking]: Row[] = await orderDb.query(
          `SELECT note FROM "${ORDER}".order_tracking
            WHERE order_id = $1 AND from_status IS NULL`,
          [created.id],
        );
        expect(createdTracking.note).toBe(
          `Order created — markaziy ombordan (#${centralId}), HQ'da qabul qilingan`,
        );
        expect(await orderMovements(created.id)).toEqual([
          { warehouse_id: centralId, type: 'RESERVE', qty: 7 },
        ]);
      });

      it('⭐ (b)(c)(d) jo`natish → chiqim; viloyat kuryeri — harakat yo`q; filialda bekor — omborga qaytmaydi; HQ qabuli → Markaziy qoldiq tiklanadi, yopiladi', async () => {
        const created = await createOrder(7);

        // (b) HQ → Samarqand filiali: Markaziy ombordan chiqim.
        await dispatchToSam(created.id);
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.ON_THE_ROAD,
          branch_id: BRANCH_SAM,
          home_branch_id: HQ_BRANCH,
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: BRANCH_SAM,
          post_id: '9002',
        });
        const [out] = await pendingCatalog();
        expect(out).toMatchObject({
          pattern: WAREHOUSE_RPC.OUT,
          payload: expect.objectContaining({
            order_id: created.id,
            lenient: true,
            note: `Buyurtma #${created.id} markaziy ombordan jo'natildi`,
          }),
        });
        expect(await deliver()).toEqual([WAREHOUSE_RPC.OUT]);
        expect(await centralRow()).toEqual({ on_hand: 3, reserved: 0 });

        // Filial pochtani qabul qildi — ombor hodisasi yo'q.
        await receiveAtSam(created.id);
        expect(await pendingCatalog()).toEqual([]);

        // (c) viloyat kuryeri — `out` (lenient) navbatga tushadi, lekin
        // catalog'da band qolmagan: qoldiq va harakat o'zgarmaydi.
        await assign(created.id);
        expect(await deliver()).toEqual([WAREHOUSE_RPC.OUT]);
        expect(await centralRow()).toEqual({ on_hand: 3, reserved: 0 });
        expect(await orderMovements(created.id)).toEqual([
          { warehouse_id: centralId, type: 'RESERVE', qty: 7 },
          { warehouse_id: centralId, type: 'OUT', qty: -7 },
        ]);

        // (d) kuryer bekor qildi → bekor pochta → Samarqand qabul qildi:
        // Markaziy ombor buyurtmasi viloyat qoidasi bilan QAYTMAYDI (uyi HQ).
        await cancelAndReturnToBranch(created.id);
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.CANCELLED,
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: BRANCH_SAM,
        });
        expect(await pendingCatalog()).toEqual([]);

        // Samarqand → HQ bekor pochtasi; HQ qabul qildi → Markaziy omborga.
        await sendCancelledToHq(created.id);
        expect((await pendingCatalog()).map((e) => String(e.pattern))).toEqual([
          WAREHOUSE_RPC.RETURN,
        ]);
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.RETURNED_TO_MARKET,
          branch_id: HQ_BRANCH,
          holder_type: OrderHolderType.MARKET,
          holder_branch_id: null,
          holder_courier_id: null,
        });
        expect(await deliver()).toEqual([WAREHOUSE_RPC.RETURN]);
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 0 });
        expect(await stockRow()).toEqual({ on_hand: 5, reserved: 0 });

        const tracking: Row[] = await orderDb.query(
          `SELECT from_status::text, to_status::text, action, description,
                  metadata->>'warehouse_kind' AS warehouse_kind
             FROM "${ORDER}".order_tracking WHERE order_id = $1`,
          [created.id],
        );
        expect(tracking).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              from_status: Order_status.CANCELLED_SENT,
              to_status: Order_status.CANCELLED,
              action: 'cancelled_post_received',
            }),
            {
              from_status: Order_status.CANCELLED,
              to_status: Order_status.RETURNED_TO_MARKET,
              action: 'warehouse_returned',
              description: 'Markaziy omborga qaytarildi',
              warehouse_kind: 'HQ',
            },
          ]),
        );
        const custodyRows: Row[] = await orderDb.query(
          `SELECT from_holder_type::text FROM "${ORDER}".order_custody_events
            WHERE order_id = $1 AND to_holder_type::text = 'MARKET'`,
          [created.id],
        );
        expect(custodyRows).toEqual([{ from_holder_type: OrderHolderType.HQ }]);
        expect(await orderMovements(created.id)).toEqual([
          { warehouse_id: centralId, type: 'RESERVE', qty: 7 },
          { warehouse_id: centralId, type: 'OUT', qty: -7 },
          { warehouse_id: centralId, type: 'RETURN', qty: 7 },
        ]);

        // Outbox qayta yetkazishi — qoldiq ikki marta o'zgarmaydi.
        await redeliverAll(created.id);
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 0 });
      });

      it('HQ kuryeri: HQ`dan to`g`ridan kuryerga → chiqim; kuryer bekor pochtasi HQ`ga → HQ qabuli → Markaziy omborga qaytadi', async () => {
        const created = await createOrder(7);
        // logistics `assignOrdersToCourier` (HQ kuryeri, doira — HQ).
        await lifecycle.updateFull(
          created.id,
          {
            courier_id: COURIER_ID,
            assigned_at: new Date().toISOString(),
            status: Order_status.ON_THE_ROAD,
            post_id: '9300',
          },
          {
            ...HQ_MANAGER,
            note: 'Manager tomonidan ommaviy courier biriktirish',
          },
        );
        expect(await orderRow(created.id)).toMatchObject({
          holder_type: OrderHolderType.COURIER,
          holder_branch_id: HQ_BRANCH,
          holder_courier_id: COURIER_ID,
        });
        const [out] = await pendingCatalog();
        expect(out.payload).toMatchObject({
          order_id: created.id,
          note: `Buyurtma #${created.id} markaziy ombordan jo'natildi`,
        });
        expect(await deliver()).toEqual([WAREHOUSE_RPC.OUT]);
        expect(await centralRow()).toEqual({ on_hand: 3, reserved: 0 });

        // Kuryer bekor qildi va bekor pochtani o'z filialiga (HQ) yubordi —
        // egalik jo'natishda HQ'ga o'tadi, qaytish faqat HQ QABULIDA.
        await lifecycle.updateFull(
          created.id,
          { status: Order_status.CANCELLED },
          { ...COURIER, note: 'Order canceled' },
        );
        await lifecycle.updateFull(
          created.id,
          {
            status: Order_status.CANCELLED_SENT,
            canceled_post_id: '9301',
            branch_id: HQ_BRANCH,
            courier_id: null,
            assigned_at: null,
          },
          { ...COURIER, note: 'Canceled post created' },
        );
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.CANCELLED_SENT,
          holder_type: OrderHolderType.HQ,
        });
        expect(await pendingCatalog()).toEqual([]);
        await lifecycle.updateFull(
          created.id,
          {
            status: Order_status.CANCELLED,
            branch_id: HQ_BRANCH,
            courier_id: null,
            assigned_at: null,
            canceled_post_id: null,
          },
          {
            ...HQ_MANAGER,
            note: 'Canceled order received by HQ and held for market handover',
          },
        );
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.RETURNED_TO_MARKET,
          holder_type: OrderHolderType.MARKET,
        });
        expect(await deliver()).toEqual([WAREHOUSE_RPC.RETURN]);
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 0 });
      });

      it('C1: HQ id noma`lum bo`lsa jo`natish 503 (yozuv bekor, chiqim yo`qolmaydi); aniqlangach — chiqim', async () => {
        const created = await createOrder(7);
        hqIdKnown = false;
        const error = await rpcErrorOf(dispatchToSam(created.id));
        expect(error).toMatchObject({ statusCode: 503 });
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.RECEIVED,
          branch_id: HQ_BRANCH,
          holder_type: OrderHolderType.HQ,
          post_id: '9001',
        });
        expect(await pendingCatalog()).toEqual([]);

        hqIdKnown = true;
        await dispatchToSam(created.id);
        expect(await deliver()).toEqual([WAREHOUSE_RPC.OUT]);
        expect(await centralRow()).toEqual({ on_hand: 3, reserved: 0 });
      });

      it('⭐ updateFull hook`ka oldingi `holder_branch_id` ni uzatadi: BRANCH/HQ shaklidan jo`natish — HQ id noma`lum 503, aniqlangach chiqim (bitta)', async () => {
        const created = await createOrder(7);
        // HQ id vaqtincha noma'lum: `branch_id` li yozuv egalikni BRANCH/<HQ>
        // shaklida yozadi (HQ/null emas) — HQ'da turishning ikkinchi shakli.
        hqIdKnown = false;
        await lifecycle.updateFull(
          created.id,
          { branch_id: HQ_BRANCH },
          HQ_MANAGER,
        );
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.RECEIVED,
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: HQ_BRANCH,
        });
        expect(await pendingCatalog()).toEqual([]);

        // C1: uydan (BRANCH/HQ) boshqa filialga — 503, yozuv bekor.
        expect(await rpcErrorOf(dispatchToSam(created.id))).toMatchObject({
          statusCode: 503,
        });
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.RECEIVED,
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: HQ_BRANCH,
        });
        expect(await pendingCatalog()).toEqual([]);

        // HQ id aniqlandi: BRANCH/HQ → BRANCH/Samarqand — chiqim yo'qolmaydi.
        hqIdKnown = true;
        await dispatchToSam(created.id);
        expect((await pendingCatalog()).map((e) => String(e.pattern))).toEqual([
          WAREHOUSE_RPC.OUT,
        ]);
        expect(await deliver()).toEqual([WAREHOUSE_RPC.OUT]);
        expect(await centralRow()).toEqual({ on_hand: 3, reserved: 0 });
      });

      it('⭐ (g) filialda bekor turgan Markaziy ombor buyurtmasi marketga topshirilmaydi — 409 WAREHOUSE_ORDER_RETURNS_TO_STOCK (ikkala yo`l), holat o`zgarmaydi', async () => {
        const created = await createOrder(7);
        await runToCancelledAtSam(created.id);
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.CANCELLED,
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: BRANCH_SAM,
        });

        // Topshirishga tayyor ro'yxat (filial xodimi) va market guruhlari —
        // Markaziy ombor buyurtmasi YO'Q; oddiy bekor buyurtma — bor.
        const plain = await createOrder(1, { fulfillment: 'hq' });
        await orderDb.query(
          `UPDATE "${ORDER}".orders
              SET status = $1, holder_type = 'BRANCH', holder_branch_id = $2,
                  branch_id = $2, canceled_post_id = NULL
            WHERE id = $3`,
          [Order_status.CANCELLED, BRANCH_SAM, plain.id],
        );
        const lists = Object.create(
          OrderServiceService.prototype,
        ) as OrderServiceService & Row;
        Object.assign(lists, {
          logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
          orderRepo: orderDb.getRepository(Order),
          lookup: hqLookup,
        });
        const handoverIds = async () =>
          (
            (
              await lists.findCancelledOrdersByMarket(MARKET_ID, {
                holder_type: OrderHolderType.BRANCH,
                branch_id: BRANCH_SAM,
              })
            ).data as Row[]
          ).map((row) => String(row.id));
        expect(await handoverIds()).toEqual([plain.id]);
        expect(
          await lists.findCancelledMarkets({
            market_id: MARKET_ID,
            holder_type: OrderHolderType.BRANCH,
            branch_id: BRANCH_SAM,
          }),
        ).toEqual([
          expect.objectContaining({ market_id: MARKET_ID, orders_count: 1 }),
        ]);
        // HQ id noma'lum — turini bilib bo'lmaydi: ombor buyurtmalari chiqariladi.
        hqIdKnown = false;
        expect(await handoverIds()).toEqual([plain.id]);
        hqIdKnown = true;
        // Bosqich bo'yicha ko'rinish (market) — o'zgarmagan: buyurtma ko'rinadi.
        expect(
          (
            (
              await lists.findCancelledOrdersByMarket(MARKET_ID, {
                stages: ['branch'] as never,
              })
            ).data as Row[]
          ).map((row) => String(row.id)),
        ).toContain(created.id);

        // QR'siz «to'g'ridan» yo'l (admin) — guard partiya so'rovidan OLDIN.
        expect(
          await rpcErrorOf(
            lifecycle.markReturnedToMarket(
              ADMIN,
              created.id,
              'MHA-hq-tier-test',
            ),
          ),
        ).toMatchObject({
          statusCode: 409,
          code: WAREHOUSE_ERROR_CODES.ORDER_RETURNS_TO_STOCK,
          data: { details: { order_ids: [created.id] } },
        });

        // Market QR sessiyasi bilan filial menejeri topshirishi.
        const token = `MHA-hq-${process.pid}-${Date.now()}`;
        const sessions = orderDb.getRepository(MarketCancelledHandoverSession);
        const now = Date.now();
        const session = await sessions.save(
          sessions.create({
            market_id: MARKET_ID,
            qr_token_hash: `qr-${process.pid}-${now}`,
            qr_expires_at: new Date(now + 5 * 60_000),
            scanned_at: new Date(now),
            scanned_by_user_id: MANAGER.id,
            // lifecycle `hashHandoverToken` bilan bir xil (sha256 hex).
            authorization_token_hash: createHash('sha256')
              .update(token)
              .digest('hex'),
            authorization_expires_at: new Date(now + 5 * 60_000),
            consumed_at: null,
          }),
        );
        expect(
          await rpcErrorOf(
            lifecycle.completeMarketCancelledHandover({
              market_id: MARKET_ID,
              order_ids: [plain.id, created.id],
              authorization_token: token,
              requester: MANAGER,
            }),
          ),
        ).toMatchObject({
          statusCode: 409,
          code: WAREHOUSE_ERROR_CODES.ORDER_RETURNS_TO_STOCK,
          // Faqat to'sgan buyurtma — FE uni tanlovdan olib tashlaydi.
          data: { details: { order_ids: [created.id] } },
        });
        // Hammasi-yoki-hech biri: sessiya ishlatilmadi, buyurtma joyida.
        expect(
          (await sessions.findOneByOrFail({ id: session.id })).consumed_at,
        ).toBeNull();
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.CANCELLED,
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: BRANCH_SAM,
        });
        expect(await pendingCatalog()).toEqual([]);
        expect(await centralRow()).toEqual({ on_hand: 3, reserved: 0 });
      });

      it('⭐ (e) jo`natishdan oldin o`chirish → Markaziy band bo`shaydi (pochta biriktirilmagan — self-heal kutilgan holat)', async () => {
        logisticsPostId = null;
        const created = await createOrder(7);
        expect(logisticsCalls).toHaveLength(1);
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.RECEIVED,
          post_id: null,
        });
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 7 });
        await lifecycle.remove(created.id, SUPERADMIN);
        expect(await deliver()).toEqual([WAREHOUSE_RPC.RELEASE]);
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 0 });
        await redeliverAll(created.id);
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 0 });
      });

      it('HQ`da (jo`natilmasdan) bekor → Markaziy omborga qaytadi: band bo`shaydi, buyurtma yopiladi', async () => {
        const created = await createOrder(7);
        await lifecycle.updateFull(
          created.id,
          { status: Order_status.CANCELLED },
          ADMIN,
        );
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.RETURNED_TO_MARKET,
          holder_type: OrderHolderType.MARKET,
        });
        expect(await deliver()).toEqual([WAREHOUSE_RPC.RETURN]);
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 0 });
        expect(
          (await orderMovements(created.id)).map((m) => String(m.type)),
        ).toEqual(['RESERVE', 'RELEASE']);
      });

      it('⭐ (f) poyga: Markaziy reserve 409 → oddiy HQ NEW (market olib keladi), pochta yo`q', async () => {
        reserveHook = async (_payload, run) => {
          await stock.reserve({
            order_id: '7777',
            warehouse_id: centralId,
            items: [{ product_id: productId, quantity: 4 }],
          });
          return run();
        };
        const created = await createOrder(7);
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.NEW,
          fulfillment_source: 'HQ',
          warehouse_id: null,
          home_branch_id: HQ_BRANCH,
          holder_type: OrderHolderType.HQ,
          post_id: null,
        });
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 4 });
        expect(await stockRow()).toEqual({ on_hand: 5, reserved: 0 });
        expect(await pendingCatalog()).toEqual([]);
        expect(logisticsCalls).toEqual([]);
      });

      it('⭐ (h) kalit o`chiq → viloyatda yetmasa oddiy HQ NEW, Markaziy band yo`q', async () => {
        hqTierFlag = false;
        const created = await createOrder(7);
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.NEW,
          fulfillment_source: 'HQ',
          warehouse_id: null,
        });
        expect(catalogCalls).toEqual([WAREHOUSE_RPC.RESOLVE_SOURCE]);
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 0 });
        expect(logisticsCalls).toEqual([]);
      });

      it('I3: order-service HQ id`ni bilmasa — Markaziy reja rad etiladi (oddiy HQ NEW, band yo`q)', async () => {
        hqIdKnown = false;
        const created = await createOrder(7);
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.NEW,
          fulfillment_source: 'HQ',
          warehouse_id: null,
        });
        expect(catalogCalls).toEqual([WAREHOUSE_RPC.RESOLVE_SOURCE]);
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 0 });
        expect(logisticsCalls).toEqual([]);
      });

      it('⭐ (i) kalit yoqilgan harness`da viloyat zanjiri o`zgarmagan: viloyat ombori tanlanadi, filialga qaytib qoldiq tiklanadi; Markaziyga tegilmaydi', async () => {
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
        await assign(created.id);
        expect(await deliver()).toEqual([WAREHOUSE_RPC.OUT]);
        await cancelAndReturnToBranch(created.id);
        expect(await deliver()).toEqual([WAREHOUSE_RPC.RETURN]);
        expect(await stockRow()).toEqual({ on_hand: 5, reserved: 0 });
        expect(await orderRow(created.id)).toMatchObject({
          status: Order_status.RETURNED_TO_MARKET,
          holder_type: OrderHolderType.MARKET,
        });
        const [returned]: Row[] = await orderDb.query(
          `SELECT description, metadata->>'warehouse_kind' AS warehouse_kind
             FROM "${ORDER}".order_tracking
            WHERE order_id = $1 AND action = 'warehouse_returned'`,
          [created.id],
        );
        expect(returned).toEqual({
          description: 'Omborga qaytarildi',
          warehouse_kind: 'REGIONAL',
        });
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 0 });
        expect(logisticsCalls).toEqual([]);
      });

      it('⭐ (j) qaytarish partiyasi (RETURN) HQ`ga qabul qilindi → Markaziy omborga qaytadi; oddiy HQ buyurtma — tegilmaydi', async () => {
        const hqKind = await createOrder(7);
        await dispatchToSam(hqKind.id);
        await deliver();
        await receiveAtSam(hqKind.id);
        // Filialda (kuryersiz) bekor — qaytarish partiyasi bilan HQ'ga.
        await lifecycle.updateFull(
          hqKind.id,
          { status: Order_status.CANCELLED },
          MANAGER,
        );
        const plain = await createOrder(1, { fulfillment: 'hq' });
        expect(await centralRow()).toEqual({ on_hand: 3, reserved: 0 });
        expect(await pendingCatalog()).toEqual([]);

        const batchRepo = orderDb.getRepository(BranchTransferBatch);
        const batch = await batchRepo.save(
          batchRepo.create({
            qr_code_token: `BTR-hq${process.pid}${Date.now()}`.slice(0, 32),
            source_branch_id: BRANCH_SAM,
            request_key: `return-hq-${process.pid}-${Date.now()}`,
            destination_branch_id: HQ_BRANCH,
            direction: BranchTransferDirection.RETURN,
            target_region_id: REGION_SAM,
            status: BranchTransferBatchStatus.SENT,
            order_count: 2,
            sent_at: new Date(),
          }),
        );
        const itemRepo = orderDb.getRepository(BranchTransferBatchItem);
        for (const id of [hqKind.id, plain.id]) {
          await itemRepo.save(
            itemRepo.create({
              batch_id: batch.id,
              order_id: id,
              snapshot_price: 150000,
              snapshot_market_id: MARKET_ID,
              sent_at: new Date(),
            }),
          );
        }
        await orderDb.query(
          `UPDATE "${ORDER}".orders SET current_batch_id = $1 WHERE id = ANY($2::bigint[])`,
          [batch.id, [hqKind.id, plain.id]],
        );

        await batches.receiveBranchTransferBatch({
          batch_id: batch.id,
          requester_id: HQ_MANAGER.id,
          requester_name: 'HQ menejeri',
          requester_roles: HQ_MANAGER.roles,
        });

        expect(await orderRow(hqKind.id)).toMatchObject({
          status: Order_status.RETURNED_TO_MARKET,
          holder_type: OrderHolderType.MARKET,
          holder_branch_id: null,
        });
        expect(await orderRow(plain.id)).toMatchObject({
          status: Order_status.RECEIVED,
          fulfillment_source: 'HQ',
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: HQ_BRANCH,
        });
        const pending = await pendingCatalog();
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          pattern: WAREHOUSE_RPC.RETURN,
          payload: expect.objectContaining({
            order_id: hqKind.id,
            note: `Buyurtma #${hqKind.id} markaziy omborga qaytdi`,
          }),
        });
        expect(await deliver()).toEqual([WAREHOUSE_RPC.RETURN]);
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 0 });
        const [returned]: Row[] = await orderDb.query(
          `SELECT from_status::text, changed_by FROM "${ORDER}".order_tracking
            WHERE order_id = $1 AND action = 'warehouse_returned'`,
          [hqKind.id],
        );
        expect(returned).toEqual({
          from_status: Order_status.RECEIVED,
          changed_by: HQ_MANAGER.id,
        });
      });

      it('qaytarish partiyasidan TANLAB qabul (HQ) → Markaziy omborga qaytadi', async () => {
        const hqKind = await createOrder(7);
        await dispatchToSam(hqKind.id);
        await deliver();
        await receiveAtSam(hqKind.id);
        await lifecycle.updateFull(
          hqKind.id,
          { status: Order_status.CANCELLED },
          MANAGER,
        );
        const batchRepo = orderDb.getRepository(BranchTransferBatch);
        const batch = await batchRepo.save(
          batchRepo.create({
            qr_code_token: `BTR-hs${process.pid}${Date.now()}`.slice(0, 32),
            source_branch_id: BRANCH_SAM,
            request_key: `return-hs-${process.pid}-${Date.now()}`,
            destination_branch_id: HQ_BRANCH,
            direction: BranchTransferDirection.RETURN,
            target_region_id: REGION_SAM,
            status: BranchTransferBatchStatus.SENT,
            order_count: 1,
            sent_at: new Date(),
          }),
        );
        const itemRepo = orderDb.getRepository(BranchTransferBatchItem);
        await itemRepo.save(
          itemRepo.create({
            batch_id: batch.id,
            order_id: hqKind.id,
            snapshot_price: 150000,
            snapshot_market_id: MARKET_ID,
            sent_at: new Date(),
          }),
        );

        await batches.receiveBranchTransferBatchOrders({
          batch_id: batch.id,
          order_ids: [hqKind.id],
          requester_id: HQ_MANAGER.id,
          requester_name: 'HQ menejeri',
          requester_roles: HQ_MANAGER.roles,
        });

        expect(await orderRow(hqKind.id)).toMatchObject({
          status: Order_status.RETURNED_TO_MARKET,
          holder_type: OrderHolderType.MARKET,
        });
        expect(await deliver()).toEqual([WAREHOUSE_RPC.RETURN]);
        expect(await centralRow()).toEqual({ on_hand: 10, reserved: 0 });
      });

      it('⭐ qaytarish partiyasida turganida SOTILGAN Markaziy ombor buyurtmasi — HQ qabulida omborga QAYTMAYDI (butun va tanlab; soxta qoldiq yo`q)', async () => {
        // Ikki buyurtma (har biri 7 — viloyatda yetmaydi) uchun Markaziyga kirim.
        await stock.stockIn({
          warehouse_id: centralId,
          lines: [{ product_id: productId, qty: 10 }],
          idempotency_key: `seed-hq-sold-${process.pid}-${Date.now()}`,
          actor: ADMIN,
        });
        for (const mode of ['whole', 'selected'] as const) {
          const hqKind = await createOrder(7);
          expect(await orderRow(hqKind.id)).toMatchObject({
            fulfillment_source: 'WAREHOUSE',
            home_branch_id: HQ_BRANCH,
          });
          await dispatchToSam(hqKind.id);
          await deliver();
          // Filial qabul qildi: WAITING (+ post_id) — RETURN partiyasiga
          // ruxsat etilgan holat.
          await receiveAtSam(hqKind.id);
          const before = await centralRow();
          const batchRepo = orderDb.getRepository(BranchTransferBatch);
          const batch = await batchRepo.save(
            batchRepo.create({
              qr_code_token: `BTR-${mode[0]}s${process.pid}${Date.now()}`.slice(
                0,
                32,
              ),
              source_branch_id: BRANCH_SAM,
              request_key: `return-sold-${mode}-${process.pid}-${Date.now()}`,
              destination_branch_id: HQ_BRANCH,
              direction: BranchTransferDirection.RETURN,
              target_region_id: REGION_SAM,
              status: BranchTransferBatchStatus.SENT,
              order_count: 1,
              sent_at: new Date(),
            }),
          );
          const itemRepo = orderDb.getRepository(BranchTransferBatchItem);
          await itemRepo.save(
            itemRepo.create({
              batch_id: batch.id,
              order_id: hqKind.id,
              snapshot_price: 150000,
              snapshot_market_id: MARKET_ID,
              sent_at: new Date(),
            }),
          );
          // Partiya jo'natilgach filialda sotildi (`sellOrder` faqat WAITING +
          // post_id ni tekshiradi; partiya yuborilishi holatni o'zgartirmaydi).
          await orderDb.query(
            `UPDATE "${ORDER}".orders SET current_batch_id = $1, status = $2
              WHERE id = $3`,
            [batch.id, Order_status.SOLD, hqKind.id],
          );

          if (mode === 'whole') {
            await batches.receiveBranchTransferBatch({
              batch_id: batch.id,
              requester_id: HQ_MANAGER.id,
              requester_name: 'HQ menejeri',
              requester_roles: HQ_MANAGER.roles,
            });
          } else {
            await batches.receiveBranchTransferBatchOrders({
              batch_id: batch.id,
              order_ids: [hqKind.id],
              requester_id: HQ_MANAGER.id,
              requester_name: 'HQ menejeri',
              requester_roles: HQ_MANAGER.roles,
            });
          }

          // Omborga qaytarish YO'Q: RETURN navbatga tushmaydi, buyurtma
          // marketga yopilmaydi, Markaziy qoldiq o'zgarmaydi.
          expect(await pendingCatalog()).toEqual([]);
          const row = await orderRow(hqKind.id);
          expect(row.status).not.toBe(Order_status.RETURNED_TO_MARKET);
          expect(row.holder_type).not.toBe(OrderHolderType.MARKET);
          expect(await centralRow()).toEqual(before);
          const returned: Row[] = await orderDb.query(
            `SELECT 1 FROM "${ORDER}".order_tracking
              WHERE order_id = $1 AND action = 'warehouse_returned'`,
            [hqKind.id],
          );
          expect(returned).toEqual([]);
        }
      });

      it('ro`yxat: `warehouse.kind` (HQ | REGIONAL) boyitishi va `?warehouse_kind=` filtri — haqiqiy catalog bilan', async () => {
        const central = await createOrder(7);
        const regional = await createOrder(1);
        const plain = await createOrder(1, { fulfillment: 'hq' });
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
          lookup: hqLookup,
          orderWarehouse: hqOrderWarehouse,
          loadPostCourierIds: jest.fn(() => Promise.resolve(new Map())),
          loadCourierSummaries: jest.fn(() => Promise.resolve(new Map())),
        });

        const ids = async (query: Row) =>
          ((await service.findAll(query)).data as Row[]).map((row) =>
            String(row.id),
          );
        expect(await ids({ warehouse_kind: 'HQ' })).toEqual([central.id]);
        expect(await ids({ warehouse_kind: 'regional' })).toEqual([
          regional.id,
        ]);
        expect(await ids({ warehouse_id: centralId })).toEqual([central.id]);
        expect((await ids({})).sort()).toEqual(
          [central.id, regional.id, plain.id].sort(),
        );

        const enriched = (await service.findAllEnriched({})).data as Row[];
        const byId = new Map(enriched.map((row) => [row.id, row]));
        expect(byId.get(central.id)).toMatchObject({
          fulfillment_source: 'WAREHOUSE',
          warehouse: {
            id: centralId,
            name: 'Markaziy ombor',
            branch_id: HQ_BRANCH,
            kind: 'HQ',
          },
        });
        expect(byId.get(regional.id)).toMatchObject({
          warehouse: {
            id: warehouseId,
            branch_id: BRANCH_SAM,
            kind: 'REGIONAL',
          },
        });
        expect(byId.get(plain.id)).toMatchObject({
          fulfillment_source: 'HQ',
          warehouse: null,
        });

        // HQ id aniqlanmasa — filtr 503 (fail-closed).
        hqIdKnown = false;
        expect(
          await rpcErrorOf(service.findAll({ warehouse_kind: 'HQ' })),
        ).toMatchObject({ statusCode: 503 });
      });
    });
  },
);
