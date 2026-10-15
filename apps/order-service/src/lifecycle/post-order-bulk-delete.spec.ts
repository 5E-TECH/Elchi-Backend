import { RpcException } from '@nestjs/microservices';
import { QueryFailedError } from 'typeorm';
import {
  BranchTransferBatchAction,
  BranchTransferBatchStatus,
  Order_status,
} from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';
import {
  classifyPostOrders,
  parsePostOrderDeleteInput,
  returnedRows,
  type LockedPostOrderRow,
} from './post-order-bulk-delete';

/**
 * yokjwjXG — `order.post.delete_orders` (superadmin pochtadan ko'p
 * buyurtmani o'chiradi). Tranzaksiya xotiradagi soxta "baza"da: har SQL
 * jumlasi mazmuniga qarab bajariladi, `transaction` xato bo'lsa holat
 * TO'LIQ tiklanadi (rollback) — hammasi-yoki-hech biri shu orqali tekshiriladi.
 * Haqiqiy SQL esa `post-order-bulk-delete.pg.spec.ts` da.
 */

type ServiceHarness = OrderLifecycleService & Record<string, any>;

interface PostRow {
  id: string;
  status: string;
  qr_code_token: string | null;
  region_id: string | null;
  courier_id: string | null;
  branch_id: string | null;
  order_quantity: number;
  post_total_price: number;
  is_deleted: boolean;
}

interface BatchRow {
  id: string;
  status: string;
  order_count: number;
  total_price: number;
  cancelled_at: Date | null;
  is_deleted: boolean;
}

interface BatchItemRow {
  batch_id: string;
  order_id: string;
  snapshot_price: number;
  sent_at: Date | null;
  is_deleted: boolean;
}

interface DbState {
  posts: PostRow[];
  orders: LockedPostOrderRow[];
  batches: BatchRow[];
  items: BatchItemRow[];
}

const SUPERADMIN = { id: '1', roles: ['superadmin'] };

function order(
  id: string,
  over: Partial<LockedPostOrderRow> = {},
): LockedPostOrderRow {
  return {
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
    ...over,
  };
}

function post(over: Partial<PostRow> = {}): PostRow {
  return {
    id: '88',
    status: 'new',
    qr_code_token: 'POST-qr',
    region_id: '5',
    courier_id: '0',
    branch_id: null,
    order_quantity: 3,
    post_total_price: 300_000,
    is_deleted: false,
    ...over,
  };
}

const live = (row: LockedPostOrderRow) => !row.is_deleted && !row.deleted_at;

/** Xotiradagi soxta tranzaksiya — faqat shu oqim ishlatadigan SQL'lar. */
function makeHarness(initial: Partial<DbState> = {}) {
  let db: DbState = {
    posts: initial.posts ?? [post()],
    orders: initial.orders ?? [order('700'), order('701'), order('702')],
    batches: initial.batches ?? [],
    items: initial.items ?? [],
  };
  const sqlLog: string[] = [];
  const saved: Array<{ entity: string; row: Record<string, unknown> }> = [];
  let failOn: { match: RegExp; error: unknown } | null = null;
  let respondOnce: { match: RegExp; result: unknown } | null = null;

  const runSql = (sql: string, params: any[]): unknown => {
    sqlLog.push(sql);
    if (failOn && failOn.match.test(sql)) throw failOn.error;
    if (respondOnce && respondOnce.match.test(sql)) {
      const { result } = respondOnce;
      respondOnce = null;
      return result;
    }
    const s = sql.replace(/\s+/g, ' ');
    if (s.startsWith('SET LOCAL lock_timeout')) return [];
    if (
      s.includes('FROM "logistics_schema"."posts"') &&
      s.includes('FOR UPDATE')
    ) {
      return db.posts
        .filter((p) => p.id === params[0] && !p.is_deleted)
        .map((p) => ({ ...p }));
    }
    if (s.startsWith('SELECT') && s.includes('FROM "order_schema"."orders"')) {
      const ids: string[] = params[0];
      return db.orders
        .filter((o) => ids.includes(o.id))
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map((o) => ({ ...o }));
    }
    if (
      s.includes('FROM "order_schema"."branch_transfer_batches"') &&
      s.startsWith('SELECT')
    ) {
      const ids: string[] = params[0];
      return db.batches
        .filter((b) => ids.includes(b.id) && !b.is_deleted)
        .map((b) => ({ id: b.id, status: b.status }));
    }
    if (s.startsWith('SELECT') && s.includes('"branch_transfer_batch_items"')) {
      const [batchIds, orderIds] = params as [string[], string[]];
      return db.items
        .filter(
          (i) =>
            batchIds.includes(i.batch_id) &&
            orderIds.includes(i.order_id) &&
            !i.is_deleted,
        )
        .map((i) => ({ ...i }));
    }
    if (s.startsWith('UPDATE "order_schema"."orders"')) {
      const [ids, postId] = params as [string[], string];
      const hit = db.orders.filter(
        (o) => ids.includes(o.id) && o.post_id === postId && live(o),
      );
      for (const o of hit) {
        o.is_deleted = true;
        o.deleted_at = new Date();
        o.current_batch_id = null;
      }
      return [hit.map((o) => ({ id: o.id })), hit.length];
    }
    if (s.startsWith('UPDATE "order_schema"."branch_transfer_batch_items"')) {
      const [batchId, ids] = params as [string, string[]];
      const hit = db.items.filter(
        (i) =>
          i.batch_id === batchId && ids.includes(i.order_id) && !i.is_deleted,
      );
      hit.forEach((i) => (i.is_deleted = true));
      return [[], hit.length];
    }
    if (
      s.includes('UPDATE "order_schema"."branch_transfer_batches" AS batch')
    ) {
      const batch = db.batches.find((b) => b.id === params[0])!;
      const rest = db.items.filter(
        (i) => i.batch_id === batch.id && !i.is_deleted,
      );
      batch.order_count = rest.length;
      batch.total_price = rest.reduce((sum, i) => sum + i.snapshot_price, 0);
      return [[{ order_count: batch.order_count }], 1];
    }
    if (s.startsWith('UPDATE "order_schema"."branch_transfer_batches"')) {
      const [batchId, next, prev] = params as [string, string, string];
      const batch = db.batches.find(
        (b) => b.id === batchId && b.status === prev,
      );
      if (batch) {
        batch.status = next;
        batch.cancelled_at = new Date();
      }
      return [[], batch ? 1 : 0];
    }
    if (s.startsWith('UPDATE "logistics_schema"."posts" AS post')) {
      const p = db.posts.find((row) => row.id === params[0])!;
      const rest = db.orders.filter((o) => o.post_id === p.id && live(o));
      p.order_quantity = rest.length;
      p.post_total_price = rest.reduce(
        (sum, o) => sum + Number(o.total_price),
        0,
      );
      return [
        [
          {
            order_quantity: p.order_quantity,
            post_total_price: String(p.post_total_price),
          },
        ],
        1,
      ];
    }
    if (s.startsWith('DELETE FROM "logistics_schema"."posts"')) {
      const before = db.posts.length;
      db.posts = db.posts.filter(
        (p) => !(p.id === params[0] && p.status === 'new'),
      );
      return [
        before === db.posts.length ? [] : [{ id: params[0] }],
        before - db.posts.length,
      ];
    }
    throw new Error(`Kutilmagan SQL: ${s.slice(0, 120)}`);
  };
  // Sinxron xato ham rad etilgan Promise bo'lib qaytadi (haqiqiy driver kabi).
  const query = jest.fn(
    (sql: string, params: any[] = []) =>
      new Promise((resolve) => resolve(runSql(sql, params))),
  );

  const tx = {
    query,
    getRepository: jest.fn((entity: { name: string }) => ({
      create: (row: Record<string, unknown>) => row,
      save: jest.fn((row: Record<string, unknown>) => {
        saved.push({ entity: entity.name, row });
        return Promise.resolve(row);
      }),
      manager: tx,
    })),
  };
  const transaction = jest.fn(
    async (work: (m: typeof tx) => Promise<unknown>) => {
      const snapshot = structuredClone(db);
      const savedBefore = saved.length;
      try {
        return await work(tx);
      } catch (error) {
        db = snapshot; // ROLLBACK
        saved.splice(savedBefore);
        throw error;
      }
    },
  );

  const outboxEvents: Array<{ target: string; pattern: string; payload: any }> =
    [];
  const outbox = {
    enqueue: jest.fn((target: string, pattern: string, payload: any) => {
      outboxEvents.push({ target, pattern, payload });
      return Promise.resolve({});
    }),
  };
  const tracking: any[] = [];
  const custody = {
    auditActor: jest.fn((r?: { id?: string; roles?: string[] }) => ({
      user_id: r?.id ?? null,
      user_role: (r?.roles ?? []).join(',') || null,
    })),
    toTrackingRole: jest.fn(() => 'superadmin'),
    createTrackingEvent: jest.fn((data: unknown) => {
      tracking.push(data);
      return Promise.resolve();
    }),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };

  const service = Object.create(
    OrderLifecycleService.prototype,
  ) as ServiceHarness;
  Object.assign(service, {
    dataSource: { transaction },
    outbox,
    custody,
    activityLog,
  });
  // Outbox voqealari rollback'da ham "ketgan" bo'lib qolmasin — tranzaksiyaga
  // bog'liq: rollback bo'lsa test ularni hisobga olmaydi.
  const committedOutbox = () =>
    transaction.mock.results.every((r) => r.type === 'return')
      ? outboxEvents
      : [];

  return {
    service,
    get db() {
      return db;
    },
    sqlLog,
    saved,
    outbox,
    outboxEvents,
    committedOutbox,
    tracking,
    custody,
    activityLog,
    transaction,
    failNext(match: RegExp, error: unknown) {
      failOn = { match, error };
    },
    respondOnce(match: RegExp, result: unknown) {
      respondOnce = { match, result };
    },
  };
}

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as { statusCode: number; message: string };
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

const call = (
  h: ReturnType<typeof makeHarness>,
  over: Record<string, unknown> = {},
) =>
  h.service.deleteOrdersFromPost({
    post_id: '88',
    order_ids: ['700', '701'],
    reason: 'Market posilkani qaytarib oldi',
    requester: SUPERADMIN,
    ...over,
  });

describe("yokjwjXG — order.post.delete_orders (ko'p buyurtma, hammasi-yoki-hech biri)", () => {
  it('⭐ ikki buyurtma o`chadi: soft-delete (is_deleted + deleted_at), pochta sanog`i/summasi jonli qatordan', async () => {
    const h = makeHarness({
      orders: [
        order('700', { total_price: 100_000 }),
        order('701', { total_price: 150_000 }),
        order('702', { total_price: 200_000 }),
      ],
    });

    const res: any = await call(h);

    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({
      post_id: '88',
      deleted: ['700', '701'],
      skipped: [],
      post_deleted: false,
      order_quantity: 1,
      post_total_price: 200_000,
    });
    expect(h.transaction).toHaveBeenCalledTimes(1);
    const [o700, o701, o702] = h.db.orders;
    expect(o700).toMatchObject({ is_deleted: true });
    expect(o700.deleted_at).toBeInstanceOf(Date);
    expect(o701).toMatchObject({ is_deleted: true });
    expect(o702).toMatchObject({ is_deleted: false, deleted_at: null });
    expect(h.db.posts[0]).toMatchObject({
      order_quantity: 1,
      post_total_price: 200_000,
    });
    // Qulf tartibi: pochta → buyurtmalar (ORDER BY id).
    const lockSql = h.sqlLog.filter((sql) => sql.includes('FOR UPDATE'));
    expect(lockSql[0]).toContain('"logistics_schema"."posts"');
    expect(lockSql[1]).toContain('ORDER BY "id"');
    expect(h.sqlLog[0]).toContain('lock_timeout');
  });

  it('⭐ qidiruv: har buyurtma search.index.remove, pochta yozuvi yangi son bilan upsert — outbox, tranzaksiya ichida', async () => {
    const h = makeHarness();
    await call(h);

    const search = h.outboxEvents.filter((e) => e.target === 'SEARCH');
    expect(
      search
        .filter((e) => e.pattern === 'search.index.remove')
        .map((e) => e.payload),
    ).toEqual([
      { source: 'order', type: 'order', sourceId: '700' },
      { source: 'order', type: 'order', sourceId: '701' },
    ]);
    const upsert = search.find((e) => e.pattern === 'search.index.upsert');
    expect(upsert?.payload).toMatchObject({
      source: 'logistics',
      type: 'post',
      sourceId: '88',
      metadata: { order_quantity: 1, post_total_price: 100_000, status: 'new' },
    });
    // Hammasi `manager` bilan (tranzaksiyada) yozildi.
    for (const callArgs of h.outbox.enqueue.mock.calls) {
      expect(callArgs[3]).toEqual({ manager: expect.anything() });
    }
  });

  it('⭐ tracking "deleted_from_post" (holat o`zgarmaydi) + jurnal: sabab, post_id, requester, eski holat', async () => {
    const h = makeHarness();
    await call(h);

    expect(h.tracking).toHaveLength(2);
    expect(h.tracking[0]).toMatchObject({
      order_id: '700',
      from_status: Order_status.RECEIVED,
      to_status: Order_status.RECEIVED,
      action: 'deleted_from_post',
      changed_by: '1',
      metadata: expect.objectContaining({
        reason: 'Market posilkani qaytarib oldi',
        post_id: '88',
      }),
    });
    const orderLogs = h.activityLog.log.mock.calls
      .map((c) => c[0])
      .filter((entry) => entry.entity_type === 'Order');
    expect(orderLogs.map((entry) => entry.entity_id)).toEqual(['700', '701']);
    expect(orderLogs[0]).toMatchObject({
      action: 'deleted',
      user_id: '1',
      old_value: expect.objectContaining({ status: 'received', post_id: '88' }),
      metadata: expect.objectContaining({
        reason: 'Market posilkani qaytarib oldi',
        post_id: '88',
        old_status: 'received',
        requester_id: '1',
        requester_roles: ['superadmin'],
      }),
    });
    const postLog = h.activityLog.log.mock.calls
      .map((c) => c[0])
      .find((entry) => entry.entity_type === 'Post');
    expect(postLog).toMatchObject({
      entity_id: '88',
      action: 'updated',
      metadata: expect.objectContaining({
        deleted_order_ids: ['700', '701'],
        post_deleted: false,
      }),
    });
  });

  it.each<[string, Partial<LockedPostOrderRow>, RegExp]>([
    ["kuryer qo'lida", { holder_type: 'COURIER' }, /#701 — kuryer qo'lida/],
    ['sotilgan', { sold_at: '2026-10-14T10:00:00Z' }, /#701 — sotilgan/],
    ['naqd yig`ilgan', { paid_amount: 5_000 }, /#701 — naqd pul yig'ilgan/],
    [
      "qaytarish so'ralgan",
      { return_requested: true },
      /#701 — qaytarish so'ralgan/,
    ],
    [
      'bekor pochtada',
      { canceled_post_id: '90' },
      /#701 — bekor qilingan pochtada/,
    ],
    ['boshqa pochtada', { post_id: '99' }, /#701 — bu pochtaga tegishli emas/],
    [
      "yo'lda holati",
      { status: Order_status.ON_THE_ROAD },
      /#701 — holati .*\(on the road\)/,
    ],
  ])(
    '⭐ 409 hammasi-yoki-hech biri: %s — hech narsa o`zgarmaydi',
    async (_label, patch, message) => {
      const h = makeHarness({
        orders: [order('700'), order('701', patch), order('702')],
      });
      const before = structuredClone(h.db);

      const err = await rpcError(call(h));

      expect(err.statusCode).toBe(409);
      expect(err.message).toMatch(message);
      expect(err.message).toContain("Hech narsa o'zgarmadi");
      expect(h.db).toEqual(before);
      expect(h.committedOutbox()).toEqual([]);
      expect(h.tracking).toEqual([]);
      expect(h.activityLog.log).not.toHaveBeenCalled();
    },
  );

  it("409 xabari BARCHA to'siqlarni sanaydi (topilmagan id ham)", async () => {
    const h = makeHarness({
      orders: [
        order('700', { holder_type: 'COURIER' }),
        order('701', { sold_at: 'x' }),
      ],
    });

    const err = await rpcError(call(h, { order_ids: ['700', '701', '999'] }));

    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('3 ta buyurtmani');
    expect(err.message).toContain("#700 — kuryer qo'lida");
    expect(err.message).toContain('#701 — sotilgan');
    expect(err.message).toContain('#999 — topilmadi');
  });

  it("⭐ NEW bo'lmagan (jo'natilgan) pochta → 409 aniq xabar, buyurtmalar qulflanmaydi", async () => {
    const h = makeHarness({ posts: [post({ status: 'sent' })] });

    const err = await rpcError(call(h));

    expect(err.statusCode).toBe(409);
    expect(err.message).toBe(
      "Pochta #88 jo'natilgan (holati: sent) — undan buyurtma o'chirib bo'lmaydi",
    );
    expect(h.db.orders.every(live)).toBe(true);
    expect(
      h.sqlLog.some((sql) => sql.includes('"order_schema"."orders"')),
    ).toBe(false);
  });

  it("⭐ oxirgi buyurtma o'chsa bo'sh pochta ham o'chadi (post_deleted: true, qidiruvdan chiqadi)", async () => {
    const h = makeHarness({
      posts: [post({ order_quantity: 2, post_total_price: 200_000 })],
      orders: [order('700'), order('701')],
    });

    const res: any = await call(h);

    expect(res.data).toMatchObject({
      deleted: ['700', '701'],
      post_deleted: true,
      order_quantity: 0,
      post_total_price: 0,
    });
    expect(h.db.posts).toEqual([]);
    expect(
      h.outboxEvents.find(
        (e) => e.pattern === 'search.index.remove' && e.payload.type === 'post',
      )?.payload,
    ).toEqual({ source: 'logistics', type: 'post', sourceId: '88' });
    expect(
      h.outboxEvents.some(
        (e) => e.pattern === 'search.index.upsert' && e.payload.type === 'post',
      ),
    ).toBe(false);
    const postLog = h.activityLog.log.mock.calls
      .map((c) => c[0])
      .find((entry) => entry.entity_type === 'Post');
    expect(postLog).toMatchObject({ action: 'deleted' });
  });

  it("⭐ idempotent: allaqachon o'chirilgan id → skipped, qolgani o'chadi", async () => {
    const h = makeHarness({
      orders: [
        order('700', { is_deleted: true, deleted_at: new Date() }),
        order('701'),
        order('702'),
      ],
    });

    const res: any = await call(h);

    expect(res.statusCode).toBe(200);
    expect(res.data.deleted).toEqual(['701']);
    expect(res.data.skipped).toEqual(['700']);
    expect(h.tracking.map((t) => t.order_id)).toEqual(['701']);
  });

  it("⭐ idempotent: hammasi o'chirilgan → 200, deleted bo'sh, hech narsa yozilmaydi", async () => {
    const h = makeHarness({
      orders: [
        order('700', { is_deleted: true }),
        order('701', { is_deleted: true }),
        order('702'),
      ],
    });

    const res: any = await call(h);

    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({
      deleted: [],
      skipped: ['700', '701'],
      post_deleted: false,
    });
    expect(h.sqlLog.some((sql) => /^\s*(UPDATE|DELETE)/.test(sql))).toBe(false);
    expect(h.outboxEvents).toEqual([]);
    expect(h.activityLog.log).not.toHaveBeenCalled();
  });

  it("⭐ takroriy so'rov pochta allaqachon o'chgandan keyin → 200, hammasi skipped, post_deleted: true", async () => {
    const h = makeHarness({
      posts: [],
      orders: [
        order('700', { is_deleted: true }),
        order('701', { is_deleted: true }),
      ],
    });

    const res: any = await call(h);

    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({
      deleted: [],
      skipped: ['700', '701'],
      post_deleted: true,
    });
  });

  it("pochta yo'q va buyurtmalar o'chirilmagan → 404", async () => {
    const h = makeHarness({ posts: [] });

    const err = await rpcError(call(h));

    expect(err.statusCode).toBe(404);
  });

  describe('(a) hamkor / tashqi buyurtma', () => {
    it('⭐ BeePost (partner API) buyurtmasi o`chadi + outbox: integration.partner.shipment.detach (status cancelled)', async () => {
      const h = makeHarness({
        orders: [
          order('700', {
            source: 'external',
            external_id: 'BP-555',
            paid_online_amount: 40_000,
            total_price: 120_000,
          }),
          order('701'),
          order('702'),
        ],
      });

      const res: any = await call(h);

      expect(res.data.deleted).toEqual(['700', '701']);
      const integration = h.outboxEvents.filter(
        (e) => e.target === 'INTEGRATION',
      );
      expect(integration).toHaveLength(1);
      expect(integration[0]).toMatchObject({
        pattern: 'integration.partner.shipment.detach',
        payload: {
          order_id: '700',
          external_order_id: 'BP-555',
          action: 'canceled',
          old_status: 'received',
          new_status: Order_status.CANCELLED,
          reason: 'Market posilkani qaytarib oldi',
          cod_collected: 0,
          collected_from_customer: null,
          elchi_fee: null,
          market_amount: null,
          total_price: 120_000,
        },
      });
      expect(Order_status.CANCELLED).toBe('cancelled');
    });

    it('eski ExternalIntegration (operator external_*) → integration.sync.enqueue ham (canceled)', async () => {
      const h = makeHarness({
        orders: [
          order('700', {
            source: 'external',
            external_id: 'CRM-1',
            operator: 'external_crm',
          }),
          order('701'),
          order('702'),
        ],
      });

      await call(h);

      const patterns = h.outboxEvents
        .filter((e) => e.target === 'INTEGRATION')
        .map((e) => e.pattern);
      expect(patterns).toEqual([
        'integration.partner.shipment.detach',
        'integration.sync.enqueue',
      ]);
      expect(
        h.outboxEvents.find((e) => e.pattern === 'integration.sync.enqueue')
          ?.payload,
      ).toMatchObject({
        order_id: '700',
        operator: 'external_crm',
        action: 'canceled',
        new_status: 'cancelled',
      });
    });

    it('ichki buyurtma — INTEGRATION ga hech narsa ketmaydi', async () => {
      const h = makeHarness();
      await call(h);
      expect(h.outboxEvents.some((e) => e.target === 'INTEGRATION')).toBe(
        false,
      );
    });

    it("409 bo'lsa hamkor signali ham ketmaydi (rollback)", async () => {
      const h = makeHarness({
        orders: [
          order('700', { external_id: 'BP-1' }),
          order('701', { holder_type: 'COURIER' }),
        ],
      });

      await rpcError(call(h));

      expect(h.committedOutbox()).toEqual([]);
    });
  });

  describe('(b) partiya (current_batch_id)', () => {
    it('⭐ PENDING partiyadan chiqariladi: item soft-delete, order_count/total_price qayta hisob, pointer null', async () => {
      const h = makeHarness({
        orders: [
          order('700', { current_batch_id: '5' }),
          order('701'),
          order('702'),
        ],
        batches: [
          {
            id: '5',
            status: BranchTransferBatchStatus.PENDING,
            order_count: 2,
            total_price: 250_000,
            cancelled_at: null,
            is_deleted: false,
          },
        ],
        items: [
          {
            batch_id: '5',
            order_id: '700',
            snapshot_price: 100_000,
            sent_at: null,
            is_deleted: false,
          },
          {
            batch_id: '5',
            order_id: '800',
            snapshot_price: 150_000,
            sent_at: null,
            is_deleted: false,
          },
        ],
      });

      await call(h);

      expect(h.db.orders[0].current_batch_id).toBeNull();
      expect(h.db.items.map((i) => i.is_deleted)).toEqual([true, false]);
      expect(h.db.batches[0]).toMatchObject({
        status: BranchTransferBatchStatus.PENDING,
        order_count: 1,
        total_price: 150_000,
      });
      expect(
        h.saved.filter((s) => s.entity === 'BranchTransferBatchHistory'),
      ).toEqual([]);
    });

    it("bo'sh qolgan PENDING partiya CANCELLED bo'ladi + tarix qatori", async () => {
      const h = makeHarness({
        orders: [
          order('700', { current_batch_id: '5' }),
          order('701'),
          order('702'),
        ],
        batches: [
          {
            id: '5',
            status: BranchTransferBatchStatus.PENDING,
            order_count: 1,
            total_price: 100_000,
            cancelled_at: null,
            is_deleted: false,
          },
        ],
        items: [
          {
            batch_id: '5',
            order_id: '700',
            snapshot_price: 100_000,
            sent_at: null,
            is_deleted: false,
          },
        ],
      });

      await call(h);

      expect(h.db.batches[0]).toMatchObject({
        status: BranchTransferBatchStatus.CANCELLED,
        order_count: 0,
        total_price: 0,
      });
      expect(h.db.batches[0].cancelled_at).toBeInstanceOf(Date);
      const history = h.saved.filter(
        (s) => s.entity === 'BranchTransferBatchHistory',
      );
      expect(history).toHaveLength(1);
      expect(history[0].row).toMatchObject({
        batch_id: '5',
        user_id: '1',
        action: BranchTransferBatchAction.CANCELLED,
      });
    });

    it("⭐ SENT partiya (posilka yo'lda) → 409, hech narsa o'zgarmaydi", async () => {
      const h = makeHarness({
        orders: [order('700', { current_batch_id: '5' }), order('701')],
        batches: [
          {
            id: '5',
            status: BranchTransferBatchStatus.SENT,
            order_count: 1,
            total_price: 100_000,
            cancelled_at: null,
            is_deleted: false,
          },
        ],
        items: [
          {
            batch_id: '5',
            order_id: '700',
            snapshot_price: 100_000,
            sent_at: new Date(),
            is_deleted: false,
          },
        ],
      });
      const before = structuredClone(h.db);

      const err = await rpcError(call(h));

      expect(err.statusCode).toBe(409);
      expect(err.message).toContain("#700 — filiallararo partiyada yo'lda");
      expect(h.db).toEqual(before);
    });

    it('yakunlangan (RECEIVED) partiyaga eskirgan ko`rsatgich — faqat pointer tozalanadi, partiya tarixiga tegilmaydi', async () => {
      const h = makeHarness({
        orders: [
          order('700', { current_batch_id: '5' }),
          order('701'),
          order('702'),
        ],
        batches: [
          {
            id: '5',
            status: BranchTransferBatchStatus.RECEIVED,
            order_count: 4,
            total_price: 400_000,
            cancelled_at: null,
            is_deleted: false,
          },
        ],
        items: [
          {
            batch_id: '5',
            order_id: '700',
            snapshot_price: 100_000,
            sent_at: new Date(),
            is_deleted: false,
          },
        ],
      });

      // sent_at bor item, lekin partiya RECEIVED — bu "yo'lda" emas.
      h.db.items[0].sent_at = null;
      await call(h);

      expect(h.db.orders[0].current_batch_id).toBeNull();
      expect(h.db.batches[0]).toMatchObject({
        order_count: 4,
        total_price: 400_000,
      });
      expect(h.db.items[0].is_deleted).toBe(false);
    });
  });

  it("(c) onlayn oldindan to'langan buyurtma o'chadi va to'lov jurnalga yoziladi", async () => {
    const h = makeHarness({
      orders: [
        order('700', { paid_online_amount: 75_000, payment_status: 'paid' }),
        order('701'),
        order('702'),
      ],
    });

    const res: any = await call(h);

    expect(res.data.deleted).toEqual(['700', '701']);
    const log700 = h.activityLog.log.mock.calls
      .map((c) => c[0])
      .find(
        (entry) => entry.entity_type === 'Order' && entry.entity_id === '700',
      );
    expect(log700.metadata).toMatchObject({
      paid_online_amount: 75_000,
      payment_status: 'paid',
      paid_online_note: expect.stringContaining("pul yo'qolmaydi"),
    });
    expect(h.tracking[0].metadata).toMatchObject({
      paid_online_amount: 75_000,
    });
  });

  it("orders UPDATE so'ralgandan kam qatorga tegsa — 409 va hech narsa davom etmaydi", async () => {
    const h = makeHarness();
    // Qulf ostida bo'lmasligi kerak bo'lgan holat: UPDATE 1 qatorga tegdi.
    h.respondOnce(/^\s*UPDATE "order_schema"\."orders"/, [[{ id: '700' }], 1]);

    const err = await rpcError(call(h));

    expect(err.statusCode).toBe(409);
    expect(
      h.sqlLog.some((sql) => sql.includes('UPDATE "logistics_schema"."posts"')),
    ).toBe(false);
    expect(h.committedOutbox()).toEqual([]);
  });

  it('pochta UPDATE yiqilsa buyurtmalar ham rollback (hammasi-yoki-hech biri)', async () => {
    const h = makeHarness();
    h.failNext(
      /^\s*UPDATE "logistics_schema"\."posts"/,
      new Error('post update blocked'),
    );

    await expect(call(h)).rejects.toThrow();
    expect(h.db.orders.every(live)).toBe(true);
    expect(h.activityLog.log).not.toHaveBeenCalled();
  });

  it("lock_timeout (55P03) → 409 'band', rollback", async () => {
    const h = makeHarness();
    const lockError = new QueryFailedError(
      'SELECT',
      [],
      new Error('lock timeout'),
    );
    (lockError as unknown as { driverError: { code: string } }).driverError = {
      code: '55P03',
    };
    h.failNext(/FOR UPDATE/, lockError);

    const err = await rpcError(call(h));

    expect(err.statusCode).toBe(409);
    expect(err.message).toContain('band');
  });

  it.each([
    [['admin']],
    [['manager']],
    [['registrator']],
    [['courier']],
    [['market']],
  ])('superadmin emas (%j) → 403, tranzaksiya ochilmaydi', async (roles) => {
    const h = makeHarness();

    const err = await rpcError(call(h, { requester: { id: '9', roles } }));

    expect(err.statusCode).toBe(403);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['post_id', { post_id: '0' }],
    ["order_ids bo'sh", { order_ids: [] }],
    ['order_ids takror', { order_ids: ['700', '700'] }],
    [
      'order_ids > 100',
      { order_ids: Array.from({ length: 101 }, (_, i) => String(i + 1)) },
    ],
    ['reason qisqa', { reason: ' a ' }],
  ])('RMQ to`g`ridan chaqirilsa ham 400: %s', async (_label, over) => {
    const h = makeHarness();

    const err = await rpcError(call(h, over));

    expect(err.statusCode).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

describe('post-order-bulk-delete helperlar', () => {
  it('returnedRows: TypeORM UPDATE [rows, rowCount] va SELECT rows', () => {
    expect(returnedRows([[{ id: '1' }], 1])).toEqual([{ id: '1' }]);
    expect(returnedRows([[], 0])).toEqual([]);
    expect(returnedRows([{ id: '1' }, { id: '2' }])).toEqual([
      { id: '1' },
      { id: '2' },
    ]);
    expect(returnedRows(undefined)).toEqual([]);
  });

  it('parsePostOrderDeleteInput: trim va son id lar', () => {
    expect(
      parsePostOrderDeleteInput({
        post_id: 88,
        order_ids: [700, '701'],
        reason: '  abc ',
      }),
    ).toEqual({ postId: '88', orderIds: ['700', '701'], reason: 'abc' });
  });

  it("classifyPostOrders: so'rov tartibi saqlanadi", () => {
    const plan = classifyPostOrders(
      '88',
      ['702', '700'],
      [order('700'), order('702')],
    );
    expect(plan.toDelete.map((row) => row.id)).toEqual(['702', '700']);
  });
});
