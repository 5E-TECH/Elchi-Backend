import { RpcException } from '@nestjs/microservices';
import { defer, NEVER, of, throwError } from 'rxjs';
import {
  Order_status,
  WAREHOUSE_ERROR_CODES,
  WAREHOUSE_RPC,
} from '@app/common';
import {
  HQ_POST_ATTACH_DEADLINE_MS,
  HQ_POST_ATTACH_TIMEOUT_MS,
  hqPostAttachTimeoutMs,
  OrderLifecycleService,
} from './order-lifecycle.service';
import { OrderHolderType } from '../entities/order.entity';
import { OrderCustodyService } from '../custody/order-custody.service';
import {
  OrderWarehouseService,
  type WarehouseCreatePlan,
} from '../warehouse/order-warehouse.service';
import type { LockedPostOrderRow } from './post-order-bulk-delete';

/**
 * VkKDSNNn — Markaziy ombor buyurtmasi (order-service lifecycle, DB'siz):
 *   - yaratish: HQ'da qabul qilingan (`home_branch_id` = HQ id, egalik HQ),
 *     hudud catalog'dan, izoh/jurnalda tur; commit'dan keyin HQ pochtasiga
 *     best-effort biriktirish (logistika xatosi yaratishni buzmaydi);
 *   - marketga topshirish (QR'li `markReturnedToMarket` va bekor topshirish
 *     sessiyasi) — Markaziy ombor buyurtmasi 409 (omborga qaytadi), HQ id
 *     noma'lum — 503, viloyat ombori — bugungidek;
 *   - pochtadan o'chirish — ombor bandi bo'shaydi (`release`, shu tx).
 * DB bilan to'liq zanjir — `warehouse/order-warehouse.pg.spec.ts`.
 */

type Harness = OrderLifecycleService & Record<string, any>;

const HQ_ID = '1';
const REGISTRATOR = { id: '5', roles: ['registrator'] };
const ADMIN = { id: '9', roles: ['admin'] };
const MANAGER = { id: '41', roles: ['manager'] };

const HQ_PLAN: WarehouseCreatePlan = {
  warehouse_id: '9',
  warehouse_name: 'Markaziy ombor',
  branch_id: HQ_ID,
  market_id: '121',
  items: [{ product_id: '142', quantity: 2 }],
  kind: 'HQ',
  region_id: '7',
};
const REGIONAL_PLAN: WarehouseCreatePlan = {
  warehouse_id: '3',
  warehouse_name: 'Samarqand ombori',
  branch_id: '11',
  market_id: '121',
  items: [{ product_id: '142', quantity: 2 }],
  kind: 'REGIONAL',
  region_id: '7',
};

/** `new OrderLifecycleService(...)` — pozitsion argumentlar (konstruktor tartibi). */
function buildService(deps: {
  dataSource?: unknown;
  orderRepo?: unknown;
  transferBatchItemRepo?: unknown;
  logisticsClient?: unknown;
  branchClient?: unknown;
  outbox?: unknown;
  activityLog?: unknown;
  lookup?: unknown;
  custody?: unknown;
  orderWarehouse?: unknown;
}): Harness {
  return new OrderLifecycleService(
    (deps.dataSource ?? {}) as never,
    (deps.orderRepo ?? {}) as never,
    {} as never, // orderItemRepo
    {} as never, // orderTrackingRepo
    {} as never, // orderCustodyEventRepo
    {} as never, // orderSettlementRepo
    {} as never, // extraCostApprovalRepo
    (deps.transferBatchItemRepo ?? {}) as never,
    {} as never, // identityClient
    deps.logisticsClient as never,
    {} as never, // financeClient
    {} as never, // integrationClient
    (deps.branchClient ?? {}) as never,
    {} as never, // fileClient
    (deps.outbox ?? { enqueue: jest.fn().mockResolvedValue({}) }) as never,
    (deps.activityLog ?? {
      log: jest.fn().mockResolvedValue(undefined),
    }) as never,
    (deps.lookup ?? {}) as never,
    (deps.custody ?? {}) as never,
    undefined,
    deps.orderWarehouse as never,
  ) as Harness;
}

const mockCustody = () => ({
  createTrackingEvent: jest.fn().mockResolvedValue(undefined),
  createCustodyEvent: jest.fn().mockResolvedValue(undefined),
  toTrackingRole: jest.fn(() => 'registrator'),
  auditActor: jest.fn((r?: { id?: string }) => ({ user_id: r?.id ?? null })),
});

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as {
        statusCode: number;
        message: string;
        code?: string;
      };
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

describe('VkKDSNNn — createOnce: Markaziy ombor buyurtmasi', () => {
  // Soxta taymerli test muddati tugasa ham keyingi testlarga o'tmasin.
  afterEach(() => {
    jest.useRealTimers();
  });

  function makeCreate(
    opts: {
      /**
       * `hang` — logistika javob bermaydi; `plain-error` — RPC xato obyekti
       * (`RpcException` emas — `rmqSend` uni `retries` bo'lsa qayta yuborardi).
       */
      logistics?: 'ok' | 'empty' | 'error' | 'none' | 'hang' | 'plain-error';
      affected?: number;
    } = {},
  ) {
    const orderTxRepo = {
      create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
      save: jest.fn((value: Record<string, unknown>) =>
        Promise.resolve({ ...value, id: '900', product_quantity: 2 }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const itemsQb = {
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: { name: string }) => {
          if (entity.name === 'Order') return orderTxRepo;
          if (entity.name === 'OrderItem') {
            return { createQueryBuilder: () => itemsQb };
          }
          return {};
        }),
      },
    };
    const updateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: opts.affected ?? 1 }),
    };
    const stored = {
      id: '900',
      status: Order_status.RECEIVED,
      post_id: '55',
      holder_type: OrderHolderType.HQ,
    };
    const orderRepo = {
      createQueryBuilder: jest.fn(() => updateQb),
      findOne: jest.fn().mockResolvedValue(stored),
    };
    const mode = opts.logistics ?? 'ok';
    /** Har obunada oshadi: `rmqSend` qayta urinishi — qayta obuna (send emas). */
    let logisticsSubscriptions = 0;
    const logisticsClient =
      mode === 'none'
        ? undefined
        : {
            send: jest.fn(() =>
              mode === 'hang' || mode === 'plain-error'
                ? defer(() => {
                    logisticsSubscriptions += 1;
                    return mode === 'hang'
                      ? NEVER
                      : throwError(() => ({
                          statusCode: 500,
                          message: 'logistics down',
                        }));
                  })
                : mode === 'error'
                  ? throwError(
                      () =>
                        new RpcException({
                          statusCode: 500,
                          message: 'logistics down',
                        }),
                    )
                  : of({
                      statusCode: 200,
                      data:
                        mode === 'ok'
                          ? [{ order_id: '900', post_id: '55' }]
                          : [],
                    }),
            ),
          };
    const outbox = { enqueue: jest.fn().mockResolvedValue({}) };
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const custody = mockCustody();
    const orderWarehouse = {
      reserveForNewOrder: jest.fn().mockResolvedValue(undefined),
    };
    const service = buildService({
      dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
      orderRepo,
      logisticsClient,
      outbox,
      activityLog,
      lookup: { getHqBranchId: jest.fn().mockResolvedValue(HQ_ID) },
      custody,
      orderWarehouse,
    });
    const create = (
      plan: WarehouseCreatePlan | null,
      dto: Record<string, unknown> = {},
      requester: { id: string; roles: string[] } = REGISTRATOR,
      startedAt?: number,
    ) =>
      service.createOnce(
        {
          market_id: '121',
          customer_id: '77',
          total_price: 150_000,
          district_id: '700',
          region_id: '7',
          items: [{ product_id: '142', quantity: 2 }],
          ...dto,
        },
        requester,
        undefined,
        plan,
        startedAt,
      );
    return {
      service,
      create,
      logisticsSubscriptions: () => logisticsSubscriptions,
      orderTxRepo,
      queryRunner,
      orderRepo,
      updateQb,
      logisticsClient,
      outbox,
      activityLog,
      custody,
      orderWarehouse,
    };
  }

  const createdRow = (h: ReturnType<typeof makeCreate>) =>
    h.orderTxRepo.create.mock.calls[0][0];

  it('⭐ HQ`da qabul qilingan: branch/home = HQ id (dto home e`tiborsiz), egalik HQ, RECEIVED, WAREHOUSE, band shu tranzaksiyada', async () => {
    const h = makeCreate();
    await h.create(
      HQ_PLAN,
      { home_branch_id: '11', branch_id: '11' },
      { id: '1', roles: ['superadmin'] },
    );
    expect(createdRow(h)).toMatchObject({
      status: Order_status.RECEIVED,
      fulfillment_source: 'WAREHOUSE',
      warehouse_id: '9',
      branch_id: HQ_ID,
      home_branch_id: HQ_ID,
      holder_type: OrderHolderType.HQ,
      holder_branch_id: null,
      holder_courier_id: null,
      region_id: '7',
      post_id: null,
    });
    expect(h.orderWarehouse.reserveForNewOrder).toHaveBeenCalledWith(
      {
        order_id: '900',
        plan: HQ_PLAN,
        requester: { id: '1', roles: ['superadmin'] },
      },
      h.queryRunner.manager,
    );
    expect(h.custody.createTrackingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        note: "Order created — markaziy ombordan (#9), HQ'da qabul qilingan",
      }),
      expect.anything(),
    );
    expect(h.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        new_value: expect.objectContaining({
          fulfillment_source: 'WAREHOUSE',
          warehouse_id: '9',
          warehouse_kind: 'HQ',
          branch_id: HQ_ID,
        }),
      }),
    );
  });

  it('hudud dto`da bo`lmasa — catalog aniqlagani (plan.region_id); dto hududi ustun', async () => {
    const fallback = makeCreate();
    await fallback.create(HQ_PLAN, { region_id: undefined });
    expect(createdRow(fallback).region_id).toBe('7');

    const given = makeCreate();
    await given.create(HQ_PLAN, { region_id: '8' });
    expect(createdRow(given).region_id).toBe('8');
  });

  it('⭐ commit`dan keyin HQ pochtasiga biriktirish: logistics.post.receive_orders (hudud + HQ filiali) → post_id (himoyalangan UPDATE) → qidiruv', async () => {
    const h = makeCreate();
    const result = await h.create(HQ_PLAN);
    expect(h.logisticsClient!.send).toHaveBeenCalledTimes(1);
    const [pattern, payload] = (h.logisticsClient!.send as jest.Mock).mock
      .calls[0] as [{ cmd: string }, Record<string, unknown>];
    expect(pattern).toEqual({ cmd: 'logistics.post.receive_orders' });
    expect(payload).toMatchObject({
      orders: [
        {
          order_id: '900',
          assigned_region: '7',
          assigned_branch: HQ_ID,
          total_price: 150_000,
        },
      ],
    });
    // Tranzaksiya commit bo'lgandan KEYIN.
    expect(
      (h.logisticsClient!.send as jest.Mock).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      h.queryRunner.commitTransaction.mock.invocationCallOrder[0],
    );
    expect(h.updateQb.set).toHaveBeenCalledWith({ post_id: '55' });
    expect(h.updateQb.where).toHaveBeenCalledWith('"id" = :id', { id: '900' });
    const guards = h.updateQb.andWhere.mock.calls.map((call) => call[0]);
    expect(guards).toEqual(
      expect.arrayContaining([
        '"post_id" IS NULL',
        '"status" = :status',
        '"holder_type" <> :courier',
        '"is_deleted" = false',
      ]),
    );
    expect(h.updateQb.andWhere).toHaveBeenCalledWith('"status" = :status', {
      status: Order_status.RECEIVED,
    });
    expect(h.updateQb.andWhere).toHaveBeenCalledWith(
      '"holder_type" <> :courier',
      { courier: OrderHolderType.COURIER },
    );
    const searchUpserts = h.outbox.enqueue.mock.calls.filter(
      (call) => call[1] === 'search.index.upsert',
    );
    // 1) tranzaksiya ichida (yaratish), 2) pochta biriktirilgach (post_id bilan).
    expect(searchUpserts).toHaveLength(2);
    expect(searchUpserts[1][2]).toMatchObject({
      sourceId: '900',
      metadata: expect.objectContaining({ post_id: '55' }),
    });
    expect(result).toMatchObject({ id: '900', post_id: '55' });
  });

  it('⭐ logistika xatosi / pochta qaytmadi / holat o`zgargan / logistika mijozi yo`q — yaratish BUZILMAYDI (faqat ogohlantirish)', async () => {
    for (const logistics of ['error', 'empty', 'none'] as const) {
      const h = makeCreate({ logistics });
      await expect(h.create(HQ_PLAN)).resolves.toMatchObject({ id: '900' });
      expect(h.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(h.updateQb.execute).not.toHaveBeenCalled();
    }
    const raced = makeCreate({ affected: 0 });
    await expect(raced.create(HQ_PLAN)).resolves.toMatchObject({ id: '900' });
    expect(raced.updateQb.execute).toHaveBeenCalledTimes(1);
    // Holat o'zgargan — qayta qidiruv yozuvi yo'q (faqat tranzaksiyadagisi).
    expect(
      raced.outbox.enqueue.mock.calls.filter(
        (call) => call[1] === 'search.index.upsert',
      ),
    ).toHaveLength(1);
  });

  it('⭐ biriktirish muddati: bitta urinish ≤2 s, `create()` boshidan 7 s gacha; 0.5 s dan kam qolsa — chaqirilmaydi', () => {
    const start = 1_000_000;
    expect(hqPostAttachTimeoutMs(start, start)).toBe(HQ_POST_ATTACH_TIMEOUT_MS);
    expect(HQ_POST_ATTACH_TIMEOUT_MS).toBeLessThanOrEqual(2000);
    // Soat orqaga ketsa ham — 2 s dan oshmaydi.
    expect(hqPostAttachTimeoutMs(start, start - 5_000)).toBe(2000);
    expect(hqPostAttachTimeoutMs(start, start + 5_500)).toBe(1500);
    expect(hqPostAttachTimeoutMs(start, start + 6_500)).toBe(500);
    expect(hqPostAttachTimeoutMs(start, start + 6_600)).toBe(0);
    expect(hqPostAttachTimeoutMs(start, start + 30_000)).toBe(0);
  });

  it('⭐ logistika osilib qolsa — BITTA urinish, ~2 s da voz kechiladi (gateway 8 s chegarasidan oldin), yaratish buzilmaydi', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const h = makeCreate({ logistics: 'hang' });
    let settled = false;
    const pending = h.create(HQ_PLAN).then((result) => {
      settled = true;
      return result;
    });
    await jest.advanceTimersByTimeAsync(HQ_POST_ATTACH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(h.logisticsSubscriptions()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(pending).resolves.toMatchObject({ id: '900' });
    // Qayta urinish yo'q (logistika `receiveOrdersIntoPosts` idempotent emas).
    await jest.advanceTimersByTimeAsync(20_000);
    expect(h.logisticsSubscriptions()).toBe(1);
    expect(h.logisticsClient!.send).toHaveBeenCalledTimes(1);
    expect(h.updateQb.execute).not.toHaveBeenCalled();
  });

  it('⭐ logistika RPC xato obyekti (RpcException emas) — qayta yuborilmaydi; muddat tugagan bo`lsa — umuman chaqirilmaydi', async () => {
    const plain = makeCreate({ logistics: 'plain-error' });
    await expect(plain.create(HQ_PLAN)).resolves.toMatchObject({ id: '900' });
    expect(plain.logisticsSubscriptions()).toBe(1);
    expect(plain.updateQb.execute).not.toHaveBeenCalled();

    // Oldingi RPC'lar (hudud, resolve_source, reserve) byudjetni yeb bo'lgan.
    const late = makeCreate();
    await expect(
      late.create(
        HQ_PLAN,
        {},
        REGISTRATOR,
        Date.now() - HQ_POST_ATTACH_DEADLINE_MS,
      ),
    ).resolves.toMatchObject({ id: '900' });
    expect(late.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(late.logisticsClient!.send).not.toHaveBeenCalled();
    expect(late.updateQb.execute).not.toHaveBeenCalled();
  });

  it('viloyat ombori va HQ buyurtma — o`zgarishsiz: pochta chaqirilmaydi, izoh bugungi, jurnalda tur yo`q', async () => {
    const regional = makeCreate();
    await regional.create(REGIONAL_PLAN, { region_id: undefined });
    expect(createdRow(regional)).toMatchObject({
      branch_id: '11',
      home_branch_id: '11',
      holder_type: OrderHolderType.BRANCH,
      holder_branch_id: '11',
      region_id: null,
    });
    expect(regional.custody.createTrackingEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        note: 'Order created — ombordan (#3), viloyat filialida qabul qilingan',
      }),
      expect.anything(),
    );
    expect(
      regional.activityLog.log.mock.calls[0][0].new_value,
    ).not.toHaveProperty('warehouse_kind');
    expect(regional.logisticsClient!.send).not.toHaveBeenCalled();

    const hq = makeCreate();
    hq.service.resolveBranchIdForOrder = jest.fn().mockResolvedValue(HQ_ID);
    await hq.create(null);
    expect(createdRow(hq)).toMatchObject({
      status: Order_status.NEW,
      fulfillment_source: 'HQ',
      home_branch_id: HQ_ID,
    });
    expect(hq.logisticsClient!.send).not.toHaveBeenCalled();
    expect(hq.orderWarehouse.reserveForNewOrder).not.toHaveBeenCalled();
  });
});

describe('VkKDSNNn — marketga topshirish: Markaziy ombor buyurtmasi 409', () => {
  const warehouseOrder = (extra: Record<string, unknown> = {}) => ({
    id: '900',
    market_id: '16',
    status: Order_status.CANCELLED,
    fulfillment_source: 'WAREHOUSE',
    warehouse_id: '9',
    home_branch_id: HQ_ID,
    branch_id: HQ_ID,
    holder_type: OrderHolderType.BRANCH,
    holder_branch_id: HQ_ID,
    holder_courier_id: null,
    return_requested: true,
    canceled_post_id: null,
    isDeleted: false,
    ...extra,
  });

  describe('markReturnedToMarket', () => {
    function makeMark(order: Record<string, unknown>, hqId: string | null) {
      const batchQb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue(null),
      };
      const transferBatchItemRepo = {
        createQueryBuilder: jest.fn(() => batchQb),
      };
      const dataSource = { createQueryRunner: jest.fn() };
      const lookup = { getHqBranchId: jest.fn().mockResolvedValue(hqId) };
      const service = buildService({
        dataSource,
        orderRepo: { findOne: jest.fn().mockResolvedValue(order) },
        transferBatchItemRepo,
        lookup,
        custody: mockCustody(),
      });
      // Tranzaksiyaga yetmasin — guard'dan keyingi yo'l alohida spec'larda.
      return { service, transferBatchItemRepo, dataSource, lookup };
    }

    it('⭐ Markaziy ombor buyurtmasi (BRANCH/HQ, return_requested) → 409 WAREHOUSE_ORDER_RETURNS_TO_STOCK, partiya/tranzaksiyaga yetmaydi', async () => {
      const h = makeMark(warehouseOrder(), HQ_ID);
      const error = await rpcError(
        h.service.markReturnedToMarket(ADMIN, '900', 'MHA-token'),
      );
      expect(error).toEqual({
        statusCode: 409,
        message:
          'Markaziy ombor buyurtmasi markaziy omborga qaytadi — marketga topshirilmaydi: #900',
        code: WAREHOUSE_ERROR_CODES.ORDER_RETURNS_TO_STOCK,
        data: { details: { order_ids: ['900'] } },
      });
      expect(h.transferBatchItemRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(h.dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('(C2) HQ kuryeri qo`lidagi Markaziy ombor buyurtmasi ham — 409 (to`g`ridan yo`ldan OLDIN)', async () => {
      const h = makeMark(
        warehouseOrder({
          status: Order_status.WAITING,
          holder_type: OrderHolderType.COURIER,
          holder_branch_id: HQ_ID,
          holder_courier_id: '301',
        }),
        HQ_ID,
      );
      const error = await rpcError(
        h.service.markReturnedToMarket(ADMIN, '900', 'MHA-token'),
      );
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe(WAREHOUSE_ERROR_CODES.ORDER_RETURNS_TO_STOCK);
    });

    it('⭐ ombor buyurtmasi, HQ id noma`lum → 503 (turini bilib bo`lmaydi)', async () => {
      const h = makeMark(warehouseOrder(), null);
      const error = await rpcError(
        h.service.markReturnedToMarket(ADMIN, '900', 'MHA-token'),
      );
      expect(error.statusCode).toBe(503);
      expect(h.transferBatchItemRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('viloyat ombori va HQ buyurtmasi — guard o`tadi (keyingi tekshiruvlar bugungidek)', async () => {
      for (const [order, hqId] of [
        [
          warehouseOrder({
            home_branch_id: '11',
            branch_id: '11',
            holder_branch_id: '12',
            return_requested: false,
          }),
          HQ_ID,
        ],
        [
          warehouseOrder({
            fulfillment_source: 'HQ',
            warehouse_id: null,
            holder_branch_id: '12',
            return_requested: false,
          }),
          null,
        ],
      ] as Array<[Record<string, unknown>, string | null]>) {
        const h = makeMark(order, hqId);
        const error = await rpcError(
          h.service.markReturnedToMarket(ADMIN, '900', 'MHA-token'),
        );
        // Partiya/qaytish talabi yo'q — bugungi 400 (409/503 emas).
        expect(error.statusCode).toBe(400);
        expect(h.transferBatchItemRepo.createQueryBuilder).toHaveBeenCalled();
      }
    });
  });

  describe('completeMarketCancelledHandover', () => {
    function makeHandover(
      orders: Array<Record<string, unknown>>,
      opts: { hqId?: string | null; requester?: typeof ADMIN } = {},
    ) {
      const requester = opts.requester ?? MANAGER;
      const now = Date.now();
      const session = {
        id: '1',
        market_id: '16',
        scanned_by_user_id: requester.id,
        authorization_token_hash: 'x',
        authorization_expires_at: new Date(now + 300_000),
        consumed_at: null,
        authorized_via: 'qr',
        isDeleted: false,
      };
      const sessionRepo = {
        findOne: jest.fn().mockResolvedValue(session),
        save: jest.fn((value: unknown) => Promise.resolve(value)),
      };
      const orderRepo = {
        find: jest.fn().mockResolvedValue(orders),
        save: jest.fn((value: unknown) => Promise.resolve(value)),
      };
      const queryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          getRepository: jest.fn((entity: { name: string }) => {
            if (entity.name === 'MarketCancelledHandoverSession') {
              return sessionRepo;
            }
            if (entity.name === 'Order') return orderRepo;
            return {};
          }),
        },
      };
      const lookup = {
        getHqBranchId: jest
          .fn()
          .mockResolvedValue(opts.hqId === undefined ? HQ_ID : opts.hqId),
        getMarketsByIds: jest.fn().mockResolvedValue([{ id: '16' }]),
      };
      const branchClient = {
        send: jest.fn((pattern: { cmd: string }) =>
          of(
            pattern.cmd === 'branch.user.find_by_user'
              ? { data: { branch_id: '12', branch: { type: 'REGIONAL' } } }
              : { data: { name: 'Samarqand' } },
          ),
        ),
      };
      const service = buildService({
        dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
        branchClient,
        lookup,
        custody: mockCustody(),
      });
      service.queueExternalStatusSync = jest.fn().mockResolvedValue(undefined);
      const run = () =>
        service.completeMarketCancelledHandover({
          market_id: '16',
          order_ids: orders.map((order) => String(order.id)),
          authorization_token: 'MHA-valid-token',
          requester,
        });
      return { service, run, lookup, orderRepo, sessionRepo, queryRunner };
    }

    const atBranch = (extra: Record<string, unknown> = {}) =>
      warehouseOrder({
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: '12',
        ...extra,
      });

    it('⭐ filial xodimi: Markaziy ombor buyurtmasi → 409 (hammasi-yoki-hech biri), HQ id shu yerda so`raladi, sessiya ishlatilmaydi', async () => {
      const h = makeHandover([
        atBranch({ id: '800', home_branch_id: '12', branch_id: '12' }),
        atBranch({ id: '900' }),
      ]);
      const error = await rpcError(h.run());
      expect(error).toMatchObject({
        statusCode: 409,
        code: WAREHOUSE_ERROR_CODES.ORDER_RETURNS_TO_STOCK,
        // Faqat to'sgan buyurtma (viloyat ombori #800 — yo'q): FE tanlovdan
        // olib tashlaydi; matnda ham.
        data: { details: { order_ids: ['900'] } },
      });
      expect(error.message).toMatch(/#900$/);
      expect(error.message).not.toContain('#800');
      expect(h.lookup.getHqBranchId).toHaveBeenCalledTimes(1);
      expect(h.orderRepo.save).not.toHaveBeenCalled();
      expect(h.sessionRepo.save).not.toHaveBeenCalled();
      expect(h.queryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(h.queryRunner.commitTransaction).not.toHaveBeenCalled();
    });

    it('HQ xodimi (admin): HQ`da turgan Markaziy ombor buyurtmasi → 409', async () => {
      const h = makeHandover(
        [
          warehouseOrder({
            holder_type: OrderHolderType.HQ,
            holder_branch_id: null,
          }),
        ],
        { requester: ADMIN },
      );
      const error = await rpcError(h.run());
      expect(error.statusCode).toBe(409);
      expect(h.orderRepo.save).not.toHaveBeenCalled();
    });

    it('⭐ ombor buyurtmasi, HQ id noma`lum → 503', async () => {
      const h = makeHandover(
        [atBranch({ home_branch_id: '12', branch_id: '12' })],
        { hqId: null },
      );
      const error = await rpcError(h.run());
      expect(error.statusCode).toBe(503);
      expect(h.orderRepo.save).not.toHaveBeenCalled();
    });

    it('viloyat ombori buyurtmasi — bugungidek topshiriladi; ombor buyurtmasi yo`q — HQ id so`ralmaydi', async () => {
      const regional = makeHandover([
        atBranch({ home_branch_id: '12', branch_id: '12' }),
      ]);
      const res: any = await regional.run();
      expect(res.data.closed_count).toBe(1);
      expect(regional.orderRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: Order_status.RETURNED_TO_MARKET,
          holder_type: OrderHolderType.MARKET,
        }),
      );

      const plain = makeHandover([
        atBranch({ fulfillment_source: 'HQ', warehouse_id: null }),
      ]);
      await plain.run();
      expect(plain.lookup.getHqBranchId).not.toHaveBeenCalled();
      expect(plain.queryRunner.commitTransaction).toHaveBeenCalled();
    });
  });
});

describe('VkKDSNNn — pochtadan o`chirish: ombor bandi bo`shaydi', () => {
  const row = (
    id: string,
    fulfillment_source: string | null,
  ): LockedPostOrderRow => ({
    id,
    post_id: '88',
    status: Order_status.RECEIVED,
    is_deleted: false,
    deleted_at: null,
    holder_type: 'HQ',
    sold_at: null,
    canceled_post_id: null,
    return_requested: false,
    paid_amount: 0,
    paid_online_amount: 0,
    payment_status: null,
    current_batch_id: null,
    total_price: 100_000,
    extra_cost: 0,
    market_id: '10',
    source: 'internal',
    external_id: null,
    operator: null,
    fulfillment_source,
  });

  function makeDelete(withWarehouse: boolean) {
    const orders = [
      row('700', 'WAREHOUSE'), // Markaziy ombor
      row('701', 'HQ'),
      row('702', 'WAREHOUSE'), // viloyat ombori
      row('703', 'HQ'),
    ];
    const sql: string[] = [];
    const query = jest.fn((text: string, params: any[] = []) => {
      sql.push(text);
      const s = text.replace(/\s+/g, ' ');
      if (s.startsWith('SET LOCAL')) return Promise.resolve([]);
      if (s.includes('FROM "logistics_schema"."posts"')) {
        return Promise.resolve([
          {
            id: '88',
            status: 'new',
            qr_code_token: 'POST-qr',
            region_id: '7',
            courier_id: '0',
            branch_id: HQ_ID,
            order_quantity: 4,
            post_total_price: 400_000,
          },
        ]);
      }
      if (s.startsWith('SELECT') && s.includes('"order_schema"."orders"')) {
        const ids: string[] = params[0];
        return Promise.resolve(
          orders.filter((o) => ids.includes(o.id)).map((o) => ({ ...o })),
        );
      }
      if (s.startsWith('UPDATE "order_schema"."orders"')) {
        const ids: string[] = params[0];
        return Promise.resolve([ids.map((id) => ({ id })), ids.length]);
      }
      if (s.startsWith('UPDATE "logistics_schema"."posts" AS post')) {
        return Promise.resolve([
          [{ order_quantity: 1, post_total_price: '100000' }],
          1,
        ]);
      }
      return Promise.reject(new Error(`Kutilmagan SQL: ${s.slice(0, 80)}`));
    });
    const tx = { query, getRepository: jest.fn(() => ({})) };
    const outbox = {
      enqueue: jest.fn<Promise<unknown>, unknown[]>(() => Promise.resolve({})),
    };
    const custody = mockCustody();
    const orderWarehouse = withWarehouse
      ? new OrderWarehouseService(
          { send: jest.fn() } as never,
          outbox as never,
          custody as never,
        )
      : undefined;
    const service = buildService({
      dataSource: {
        transaction: jest.fn((work: (m: typeof tx) => Promise<unknown>) =>
          work(tx),
        ),
      },
      outbox,
      custody,
      orderWarehouse,
    });
    const run = () =>
      service.deleteOrdersFromPost({
        post_id: '88',
        order_ids: ['700', '701', '702'],
        reason: 'Market posilkani qaytarib oldi',
        requester: { id: '1', roles: ['superadmin'] },
      });
    return { run, sql, outbox, tx };
  }

  it('⭐ WAREHOUSE buyurtmalar uchun release (lenient) — AYNI tranzaksiyada; HQ buyurtma — yo`q', async () => {
    const h = makeDelete(true);
    const res: any = await h.run();
    expect(res.data.deleted).toEqual(['700', '701', '702']);
    const lockSql = h.sql.find(
      (text) =>
        text.includes('SELECT') && text.includes('"order_schema"."orders"'),
    )!;
    expect(lockSql).toContain('"fulfillment_source"');
    const releases = h.outbox.enqueue.mock.calls.filter(
      (call) => call[0] === 'CATALOG',
    );
    expect(releases).toEqual([
      [
        'CATALOG',
        WAREHOUSE_RPC.RELEASE,
        {
          order_id: '700',
          actor: { id: '1', roles: ['superadmin'] },
          lenient: true,
          note: "Buyurtma #700 o'chirildi",
        },
        { manager: h.tx },
      ],
      [
        'CATALOG',
        WAREHOUSE_RPC.RELEASE,
        {
          order_id: '702',
          actor: { id: '1', roles: ['superadmin'] },
          lenient: true,
          note: "Buyurtma #702 o'chirildi",
        },
        { manager: h.tx },
      ],
    ]);
  });

  it('ombor servisi yo`q (eski sozlama) — o`chirish bugungidek, CATALOG hodisasi yo`q', async () => {
    const h = makeDelete(false);
    const res: any = await h.run();
    expect(res.data.deleted).toEqual(['700', '701', '702']);
    expect(
      h.outbox.enqueue.mock.calls.filter((call) => call[0] === 'CATALOG'),
    ).toEqual([]);
  });
});

describe('VkKDSNNn — updateFull → onOrderWritten: yozuvdan OLDINGI egalik (DB`siz)', () => {
  /**
   * HAQIQIY `updateFull` (holder qayta hisobi, tracking) — DB/RMQ chegaralari
   * mock. Ombor hook'i (`onOrderWritten`) faqat updateFull'dan chaqiriladi;
   * `previousHolderBranchId` uzatilmasa BRANCH/<HQ> shaklidagi Markaziy ombor
   * buyurtmasi jo'natilganda chiqim (`out`) yo'qoladi va C1 503 o'chadi.
   */
  function makeUpdate(initial: Record<string, unknown>) {
    let current: Record<string, unknown> = { ...initial };
    const orderRepo = {
      save: jest.fn((value: Record<string, unknown>) => {
        current = { ...value };
        return Promise.resolve(value);
      }),
      findOne: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    };
    const repo = () => ({
      create: jest.fn((payload: unknown) => payload),
      save: jest.fn((payload: unknown) => Promise.resolve(payload)),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    });
    const trackingRepo = repo();
    const custodyRepo = repo();
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: { name: string }) =>
          entity.name === 'Order'
            ? orderRepo
            : entity.name === 'OrderCustodyEvent'
              ? custodyRepo
              : trackingRepo,
        ),
      },
    };
    const nullClient = { send: jest.fn() };
    const orderWarehouse = {
      onOrderWritten: jest.fn().mockResolvedValue(undefined),
    };
    const service = new OrderLifecycleService(
      { createQueryRunner: jest.fn(() => queryRunner) } as never,
      orderRepo as never,
      {} as never, // orderItemRepo
      trackingRepo as never,
      custodyRepo as never,
      {} as never, // orderSettlementRepo
      {} as never, // extraCostApprovalRepo
      { find: jest.fn().mockResolvedValue([]) } as never,
      nullClient as never, // identity
      nullClient as never, // logistics
      nullClient as never, // finance
      nullClient as never, // integration
      nullClient as never, // branch
      nullClient as never, // file
      { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
      {
        log: jest.fn().mockResolvedValue(undefined),
        logChange: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        getHqBranchId: jest.fn().mockResolvedValue(HQ_ID),
        getBranchAssignmentByUser: jest
          .fn()
          .mockResolvedValue({ branch_id: HQ_ID }),
      } as never,
      new OrderCustodyService(trackingRepo as never, custodyRepo as never),
      undefined,
      orderWarehouse as never,
    ) as Harness;
    jest
      .spyOn(service, 'findById')
      .mockImplementation(() =>
        Promise.resolve({ ...current, items: [] } as never),
      );
    service.syncOrderToSearch = jest.fn().mockResolvedValue(undefined);
    return { service, orderWarehouse, current: () => current };
  }

  it('⭐ BRANCH/HQ → BRANCH/12 (filialga jo`natish): hook`ka oldingi holder_type + holder_branch_id', async () => {
    const h = makeUpdate({
      id: '900',
      status: Order_status.RECEIVED,
      market_id: '121',
      customer_id: '77',
      where_deliver: 'center',
      total_price: 150_000,
      to_be_paid: 0,
      paid_amount: 0,
      return_requested: false,
      post_id: '9001',
      canceled_post_id: null,
      sold_at: null,
      fulfillment_source: 'WAREHOUSE',
      warehouse_id: '9',
      branch_id: HQ_ID,
      home_branch_id: HQ_ID,
      holder_type: OrderHolderType.BRANCH,
      holder_branch_id: HQ_ID,
      holder_courier_id: null,
      courier_id: null,
      district_id: '700',
      region_id: '7',
      address: null,
      qr_code_token: 'qr-900',
      source: 'internal',
      isDeleted: false,
    });
    await h.service.updateFull(
      '900',
      {
        branch_id: '12',
        post_id: '9002',
        current_batch_id: null,
        status: Order_status.ON_THE_ROAD,
      },
      { ...REGISTRATOR, note: 'Post dispatched to branch' },
    );
    expect(h.current()).toMatchObject({
      holder_type: OrderHolderType.BRANCH,
      holder_branch_id: '12',
    });
    expect(h.orderWarehouse.onOrderWritten).toHaveBeenCalledTimes(1);
    expect(h.orderWarehouse.onOrderWritten).toHaveBeenCalledWith(
      expect.objectContaining({
        oldStatus: Order_status.RECEIVED,
        previousHolderType: OrderHolderType.BRANCH,
        previousHolderBranchId: HQ_ID,
        order: expect.objectContaining({
          id: '900',
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: '12',
        }),
      }),
      expect.anything(),
    );
  });
});
