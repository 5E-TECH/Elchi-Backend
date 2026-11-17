import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import {
  COURIER_SCAN_TRACKING_NOTES,
  OutboxEvent,
  OutboxService,
  Order_status,
  POST_RECEIVED_TRACKING_NOTES,
  Post_status,
  publicErrorData,
} from '@app/common';
import {
  COURIER_SCAN_NOT_ARRIVED_MESSAGE,
  LogisticsServiceService,
} from './logistics-service.service';
import { LogisticsNotificationService } from './notification/logistics-notification.service';

/**
 * COURIER-SCAN (ega, 2026-11-17) — KURYER SKANI = QABUL.
 *
 *  - HQ → filial o'tkazma pochtasini (courier_id '0', SENT) menejer hali
 *    qabul qilmagan bo'lsa ham filial kuryeri buyurtmani skanlab oladi: skan
 *    shu bitta buyurtmani filialga qabul qiladi va kuryerga beradi;
 *  - skandan keyin holat doim WAITING (kuryerda) — ON_THE_ROAD ga
 *    qaytmaydi, kuryerdan «Qabul qilish» kutilmaydi;
 *  - pochta: oxirgi yo'ldagi olinsa — RECEIVED + bitta «yetib keldi»
 *    xabari; qisman — SENT, menejer qolganini qabul qiladi;
 *  - kuryerda bo'sh SENT pochta qolmaydi, bir kunda — bitta pochta;
 *  - ikki kuryer bir vaqtda — faqat bittasi oladi.
 *
 * Haqiqiy servis + xotiradagi order-service (find_by_qr / find_by_id /
 * find_all / update — qulf ostidagi shartli yozuvlar bilan / pochta tarixi)
 * + xotiradagi pochtalar + advisory qulf (navbat) + haqiqiy
 * LogisticsNotificationService / OutboxService.
 */
type Row = Record<string, any>;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const BRANCHES: Record<string, Row> = {
  '1': { id: '1', type: 'HQ', region_id: '1', status: 'active' },
  '10': { id: '10', type: 'REGIONAL', region_id: '1', status: 'active' },
  '11': { id: '11', type: 'REGIONAL', region_id: '2', status: 'active' },
};
const USER_BRANCH: Record<string, string> = {
  '44': '10',
  '45': '10',
  '99': '11',
  '7': '1',
  '198': '10',
};
const NAMES: Record<string, string> = {
  '44': 'Ali Valiyev',
  '45': 'Vali Aliyev',
};
const COURIER_44 = { id: '44', roles: ['courier'] };
const COURIER_45 = { id: '45', roles: ['courier'] };
const COURIER_OTHER_BRANCH = { id: '99', roles: ['courier'] };
const HQ_COURIER = { id: '7', roles: ['courier'] };
const MANAGER_10 = { id: '198', roles: ['manager'] };

const STAFF_ROWS = [
  { user_id: '198', role: 'MANAGER' },
  { user_id: '199', role: 'REGISTRATOR' },
];

const transferPost = (overrides: Row = {}): Row => ({
  id: '42',
  courier_id: '0',
  branch_id: '10',
  region_id: '1',
  status: Post_status.SENT,
  order_quantity: 2,
  post_total_price: 200_000,
  qr_code_token: 'POST-42',
  createdAt: new Date(Date.now() - 60 * 60 * 1000),
  ...overrides,
});

/** HQ dispatch'dan keyingi holat: filialga yo'lda, kuryersiz. */
const inTransfer = (id: string, overrides: Row = {}): Row => ({
  id,
  qr_code_token: `ORD-${id}`,
  status: Order_status.ON_THE_ROAD,
  branch_id: '10',
  region_id: '1',
  post_id: '42',
  holder_type: 'BRANCH',
  holder_branch_id: '10',
  holder_courier_id: null,
  courier_id: null,
  current_batch_id: null,
  total_price: 100_000,
  return_requested: false,
  return_reason: null,
  ...overrides,
});

class Conflict extends RpcException {
  constructor(reason: string) {
    super({ statusCode: 409, message: `conflict: ${reason}`, reason });
  }
}

function setup(options: { orders: Row[]; posts: Row[] }) {
  const orders = new Map<string, Row>(
    options.orders.map((row) => [String(row.id), { ...row }]),
  );
  const posts = new Map<string, Row>(
    options.posts.map((row) => [String(row.id), { ...row }]),
  );
  // Pochta tarixi (`order_schema.post_order_memberships` — trigger kabi).
  const memberships: Row[] = [...orders.values()]
    .filter((row) => row.post_id)
    .map((row) => ({
      order_id: String(row.id),
      post_id: String(row.post_id),
      kind: 'DELIVERY',
      joined_at: new Date(0).toISOString(),
      left_at: null,
      next_post_id: null,
    }));
  let nextPostId = 500;

  const applyOrderUpdate = (payload: {
    id: string;
    dto: Row;
    requester?: Row;
  }) => {
    const row = orders.get(String(payload.id));
    if (!row) throw new RpcException({ statusCode: 404, message: 'yo‘q' });
    const prg = payload.requester?.post_receive_guard;
    if (
      prg &&
      (String(row.post_id ?? '') !== String(prg.post_id) ||
        (prg.status && row.status !== prg.status))
    ) {
      throw new Conflict('post_receive_conflict');
    }
    const csg = payload.requester?.courier_scan_guard;
    if (
      csg &&
      ((csg.status && row.status !== csg.status) ||
        String(row.post_id ?? '') !== String(csg.post_id ?? '') ||
        String(row.courier_id ?? '') !== String(csg.courier_id ?? '') ||
        (row.holder_courier_id &&
          String(row.holder_courier_id) !== String(csg.courier_id ?? '')))
    ) {
      throw new Conflict('courier_scan_conflict');
    }
    const dto = payload.dto;
    if (
      typeof dto.post_id !== 'undefined' &&
      String(dto.post_id ?? '') !== String(row.post_id ?? '')
    ) {
      const open = memberships.find(
        (m) => m.order_id === String(row.id) && !m.left_at,
      );
      if (open) {
        open.left_at = new Date().toISOString();
        open.next_post_id = dto.post_id ? String(dto.post_id) : null;
      }
      if (dto.post_id) {
        memberships.push({
          order_id: String(row.id),
          post_id: String(dto.post_id),
          kind: 'DELIVERY',
          joined_at: new Date().toISOString(),
          left_at: null,
          next_post_id: null,
        });
      }
    }
    Object.assign(row, dto);
    if (typeof dto.courier_id !== 'undefined' && dto.courier_id) {
      row.holder_type = 'COURIER';
      row.holder_courier_id = String(dto.courier_id);
      row.holder_branch_id = row.holder_branch_id ?? row.branch_id;
      row.last_handover_by = String(payload.requester?.id ?? '');
    }
  };

  const orderClient = {
    send: jest.fn((pattern: { cmd: string }, payload: Row) => {
      switch (pattern.cmd) {
        case 'order.find_by_qr': {
          const row = [...orders.values()].find(
            (o) => o.qr_code_token === payload.token,
          );
          return row
            ? of({ data: { ...row } })
            : of({ statusCode: 404, data: null });
        }
        case 'order.find_by_id':
          return of({ ...orders.get(String(payload.id)) });
        case 'order.find_all': {
          const query = payload.query ?? {};
          const statuses = query.status
            ? ([] as unknown[]).concat(query.status).map(String)
            : null;
          const rows = [...orders.values()].filter(
            (row) =>
              (!query.post_id ||
                String(row.post_id ?? '') === String(query.post_id)) &&
              (!statuses || statuses.includes(String(row.status))),
          );
          return of({ data: { data: rows.map((row) => ({ ...row })) } });
        }
        case 'order.update':
          try {
            applyOrderUpdate(payload as never);
          } catch (error) {
            return throwError(() => error);
          }
          return of({ statusCode: 200 });
        case 'order.post_membership.find':
          return of({
            data: memberships.filter((m) =>
              (payload.post_ids as string[]).includes(m.post_id),
            ),
          });
        case 'order.transfer_batch.receive_one_by_scan':
          return of({ data: { received: false, reason: 'no_batch' } });
        default:
          return of({});
      }
    }),
  };

  const branchClient = {
    send: jest.fn((pattern: { cmd: string }, payload: Row) => {
      if (pattern.cmd === 'branch.user.find_by_user') {
        const branchId = USER_BRANCH[String(payload.user_id)];
        return of({
          data: branchId
            ? { branch_id: branchId, branch: { ...BRANCHES[branchId] } }
            : null,
        });
      }
      if (pattern.cmd === 'branch.find_by_id') {
        return of({ data: { ...BRANCHES[String(payload.id)] } });
      }
      if (pattern.cmd === 'branch.find_hq') {
        return of({ data: { id: '1' } });
      }
      return of({ data: null });
    }),
  };
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }, payload: Row) =>
      pattern.cmd === 'identity.courier.find_by_ids'
        ? of({
            data: (payload.ids as string[])
              .filter((id) => NAMES[id])
              .map((id) => ({ id, name: NAMES[id] })),
          })
        : of({ data: [] }),
    ),
  };

  // --- pochtalar (xotirada) ---
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, expected]) => {
      if (expected && typeof expected === 'object' && 'type' in expected) {
        const op = expected as { type: string; value: Date };
        return op.type === 'moreThanOrEqual'
          ? new Date(row[key]).getTime() >= new Date(op.value).getTime()
          : true;
      }
      return String(row[key] ?? '') === String(expected ?? '');
    });
  const findPost = (query: { where?: Row; order?: Row }) => {
    const rows = [...posts.values()].filter((row) =>
      matches(row, query?.where),
    );
    rows.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return rows[0] ? { ...rows[0] } : null;
  };
  const savePost = (entity: Row) => {
    const id = String(entity.id ?? nextPostId++);
    const current = posts.get(id) ?? { createdAt: new Date() };
    const next = { ...current, ...entity, id };
    posts.set(id, next);
    return { ...next };
  };
  const counterQb = () => {
    let setValues: Row = {};
    let targetId = '';
    const qb: Row = {
      update: () => qb,
      set: (values: Row) => {
        setValues = values;
        return qb;
      },
      where: (_sql: string, params: { id: string }) => {
        targetId = String(params.id);
        return qb;
      },
      execute: () => {
        const row = posts.get(targetId);
        if (row) {
          for (const [key, fn] of Object.entries(setValues)) {
            const sql = String((fn as () => string)());
            const plus = /\+ (\d+(?:\.\d+)?)/.exec(sql);
            const minus = /- (\d+(?:\.\d+)?)/.exec(sql);
            if (plus) row[key] = Number(row[key] ?? 0) + Number(plus[1]);
            if (minus)
              row[key] = Math.max(Number(row[key] ?? 0) - Number(minus[1]), 0);
          }
        }
        return Promise.resolve({ affected: row ? 1 : 0 });
      },
    };
    return qb;
  };

  // --- tranzaksiya + advisory qulf (navbat) + outbox ---
  const lockCalls: string[] = [];
  const locks = new Map<string, Promise<void>>();
  const committed: Row[] = [];
  const transaction = jest.fn(
    async (work: (manager: Row) => Promise<unknown>) => {
      const releases: Array<() => void> = [];
      const pending: Row[] = [];
      const outboxRepo = {
        create: (value: Row) => ({ ...value }),
        save: (value: Row) => {
          pending.push(value);
          return Promise.resolve({ id: String(pending.length), ...value });
        },
      };
      const txPostRepo = {
        findOne: (query: { where?: Row }) => Promise.resolve(findPost(query)),
        update: (where: { id: string }, patch: Row) => {
          const row = posts.get(String(where.id));
          if (row) Object.assign(row, patch);
          return Promise.resolve({ affected: row ? 1 : 0 });
        },
        save: (entity: Row) => Promise.resolve(savePost(entity)),
      };
      const tx: Row = {
        queryRunner: { isTransactionActive: true },
        query: async (sql: string, params?: unknown[]) => {
          if (sql.includes('pg_advisory_xact_lock')) {
            const key = String(params?.[0]);
            lockCalls.push(key);
            const previous = locks.get(key) ?? Promise.resolve();
            let release!: () => void;
            const mine = new Promise<void>((resolve) => (release = resolve));
            locks.set(
              key,
              previous.then(() => mine),
            );
            await previous;
            releases.push(release);
          }
          return [];
        },
        getRepository: (entity: unknown) =>
          entity === OutboxEvent ? outboxRepo : txPostRepo,
      };
      tx.transaction = (inner: (m: Row) => Promise<unknown>) => inner(tx);
      try {
        const result = await work(tx);
        committed.push(...pending);
        return result;
      } finally {
        releases.forEach((release) => release());
      }
    },
  );
  const postRepo = {
    findOne: jest.fn((query: { where?: Row }) =>
      Promise.resolve(findPost(query)),
    ),
    find: jest.fn((query: { where?: Row }) =>
      Promise.resolve(
        [...posts.values()].filter((row) => matches(row, query?.where)),
      ),
    ),
    create: jest.fn((payload: Row) => ({ ...payload })),
    save: jest.fn((entity: Row) => Promise.resolve(savePost(entity))),
    createQueryBuilder: jest.fn(() => counterQb()),
    manager: { transaction },
  };

  const notifier = new LogisticsNotificationService(
    new OutboxService({ create: jest.fn(), save: jest.fn() } as never),
    { send: jest.fn(() => of({ data: STAFF_ROWS })) } as never,
  );
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new LogisticsServiceService(
    postRepo as any,
    {} as any,
    { find: jest.fn().mockResolvedValue([]) } as any,
    orderClient as any,
    branchClient as any,
    identityClient as any,
    { send: jest.fn(() => of({})) } as any,
    activityLog as any,
    notifier,
  );

  const updates = () =>
    orderClient.send.mock.calls
      .filter(([pattern]) => pattern.cmd === 'order.update')
      .map(([, payload]) => payload);

  return {
    service,
    orders,
    posts,
    memberships,
    orderClient,
    activityLog,
    lockCalls,
    committed,
    updates,
    notifications: () =>
      committed.filter((row) => row.target === 'NOTIFICATION'),
    courierPostsOf: (courierId: string) =>
      [...posts.values()].filter((row) => row.courier_id === courierId),
  };
}

const scan = (ctx: ReturnType<typeof setup>, requester: Row, orderId: string) =>
  ctx.service.scanAssignOrder(requester as any, {
    qr_token: `ORD-${orderId}`,
  }) as Promise<Row>;

async function rpcError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    const payload = (error as RpcException).getError() as {
      statusCode: number;
      message: string;
      data: Row | null;
    };
    return { ...payload, gateway: publicErrorData(payload) };
  }
  throw new Error('RpcException kutilgan edi');
}

describe('COURIER-SCAN — o‘tkazma pochtasidan kuryer skani bilan olish', () => {
  it('⭐ menejer qabul qilmagan pochtadagi buyurtma: 200, WAITING, kuryerda, kuryer pochtasida; pochta SENT (qolgani bor)', async () => {
    const ctx = setup({
      orders: [inTransfer('201'), inTransfer('202')],
      posts: [transferPost()],
    });

    const res = await scan(ctx, COURIER_44, '201');

    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({
      idempotent: false,
      order_id: '201',
      status: Order_status.WAITING,
    });
    const order = ctx.orders.get('201')!;
    expect(order).toMatchObject({
      status: Order_status.WAITING,
      courier_id: '44',
      holder_type: 'COURIER',
      holder_courier_id: '44',
      branch_id: '10',
      return_requested: false,
    });
    // Kuryer pochtasi — yangi, darhol RECEIVED (kuryer filialida).
    const [courierPost] = ctx.courierPostsOf('44');
    expect(order.post_id).toBe(courierPost.id);
    expect(courierPost).toMatchObject({
      status: Post_status.RECEIVED,
      branch_id: '10',
      order_quantity: 1,
      post_total_price: 100_000,
    });
    // Ikki yozuv: (1) filialga qabul — kuryer skani, shartli; (2) kuryerga
    // berish — skan izohi va `courier_scan_guard` bilan. ON_THE_ROAD yo'q.
    const [receive, take] = ctx.updates();
    expect(receive).toEqual({
      id: '201',
      dto: {
        status: Order_status.WAITING,
        return_requested: false,
        branch_id: '10',
      },
      requester: {
        id: '44',
        roles: ['courier'],
        note: COURIER_SCAN_TRACKING_NOTES.BRANCH_RECEIVE,
        post_receive_guard: { post_id: '42', status: Order_status.ON_THE_ROAD },
      },
    });
    expect(take.dto).toEqual(
      expect.objectContaining({
        courier_id: '44',
        status: Order_status.WAITING,
        post_id: courierPost.id,
      }),
    );
    expect(take.requester).toEqual({
      id: '44',
      roles: ['courier'],
      note: COURIER_SCAN_TRACKING_NOTES.TAKE,
      courier_scan_guard: {
        status: Order_status.WAITING,
        post_id: '42',
        courier_id: null,
      },
    });
    expect(ctx.updates()).toHaveLength(2);
    expect(
      ctx.updates().some((u) => u.dto.status === Order_status.ON_THE_ROAD),
    ).toBe(false);
    // Menejerning skan-qabuli bilan bitta qulf.
    expect(ctx.lockCalls).toEqual(['post_receive:42']);
    // Pochta: qolgan yo'ldagi bor — SENT, hisob o'zgarmaydi, xabar yo'q.
    expect(ctx.posts.get('42')).toMatchObject({
      status: Post_status.SENT,
      order_quantity: 2,
    });
    expect(ctx.orders.get('202')).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      return_requested: false,
    });
    expect(ctx.notifications()).toEqual([]);
    expect(
      ctx.activityLog.log.mock.calls
        .map(([entry]) => entry as Row)
        .find((entry) => entry.action === 'logistics.post_scan_receive')
        ?.metadata,
    ).toMatchObject({ courier_scan: 'BRANCH', received_order_ids: ['201'] });
  });

  it('⭐ oxirgi yo‘ldagi olindi — pochta RECEIVED va «yetib keldi» xabari BIR marta (son — pochta hisobidan)', async () => {
    const ctx = setup({
      // 202 ni boshqa kuryer avvalroq skan bilan olib ketgan (pochtada yo'q).
      orders: [
        inTransfer('201'),
        inTransfer('202', {
          status: Order_status.WAITING,
          courier_id: '45',
          holder_type: 'COURIER',
          holder_courier_id: '45',
          post_id: '600',
        }),
      ],
      posts: [transferPost()],
    });

    await scan(ctx, COURIER_44, '201');

    expect(ctx.posts.get('42')).toMatchObject({ status: Post_status.RECEIVED });
    const arrivals = ctx.notifications();
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].payload).toMatchObject({
      type: 'logistics.batch_arrived',
      data: expect.objectContaining({
        post_id: '42',
        received_count: 2,
        order_count: 2,
        branch_id: '10',
      }),
    });

    // Qayta skan (o'z WAITING) — idempotent, xabar qayta ketmaydi.
    const again = await scan(ctx, COURIER_44, '201');
    expect(again.data.idempotent).toBe(true);
    expect(ctx.notifications()).toHaveLength(1);
  });

  it('⭐ qisman olindi — pochta SENT; keyin menejer bulk qabuli faqat qolganini oladi, kuryer olganiga «kelmagan» tushmaydi', async () => {
    const ctx = setup({
      orders: [inTransfer('201'), inTransfer('202'), inTransfer('203')],
      posts: [transferPost({ order_quantity: 3 })],
    });

    await scan(ctx, COURIER_44, '201');
    expect(ctx.posts.get('42')!.status).toBe(Post_status.SENT);

    // Menejer: 202 ni qabul qiladi, 203 — kelmagan (tanlanmagan).
    await ctx.service.receivePost(MANAGER_10, '42', {
      order_ids: ['202'],
    });

    expect(ctx.orders.get('202')).toMatchObject({
      status: Order_status.WAITING,
    });
    expect(ctx.orders.get('203')).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      return_requested: true,
    });
    // Kuryer olgani pochtada emas — tegilmaydi.
    expect(ctx.orders.get('201')).toMatchObject({
      status: Order_status.WAITING,
      courier_id: '44',
      return_requested: false,
    });
    expect(
      ctx.updates().filter((u) => u.id === '201' && u.dto.return_requested),
    ).toEqual([]);
  });

  it('⭐ menejer kuryer olgan buyurtmani «Pochtadan qabul»da skanlasa — 400 `order_taken_by_courier` (kuryer ismi bilan)', async () => {
    const ctx = setup({
      orders: [inTransfer('201'), inTransfer('202')],
      posts: [transferPost()],
    });
    await scan(ctx, COURIER_44, '201');

    const error = await rpcError(
      ctx.service.receivePost(MANAGER_10, '42', {
        order_ids: ['201'],
        scan: true,
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(
      'Bu buyurtmani kuryer Ali Valiyev skan bilan olgan',
    );
    expect(error.gateway).toEqual({
      reason: 'order_taken_by_courier',
      details: {
        order_id: '201',
        post_id: '42',
        courier_id: '44',
        courier_name: 'Ali Valiyev',
      },
    });
  });

  it('pochtaga hech qachon kirmagan buyurtma — avvalgidek `order_not_in_post`', async () => {
    const ctx = setup({
      orders: [
        inTransfer('202'),
        inTransfer('300', {
          status: Order_status.WAITING,
          courier_id: '45',
          holder_type: 'COURIER',
          holder_courier_id: '45',
          post_id: '600',
        }),
      ],
      posts: [transferPost()],
    });
    const error = await rpcError(
      ctx.service.receivePost(MANAGER_10, '42', {
        order_ids: ['300'],
        scan: true,
      }),
    );
    expect(error.gateway?.reason).toBe('order_not_in_post');
  });

  describe('rad etishlar — hech narsa yozilmaydi', () => {
    it('boshqa filial kuryeri — 403', async () => {
      const ctx = setup({
        orders: [inTransfer('201')],
        posts: [transferPost()],
      });
      const error = await rpcError(scan(ctx, COURIER_OTHER_BRANCH, '201'));
      expect(error.statusCode).toBe(403);
      expect(error.message).toBe(
        'Boshqa filial buyurtmasi — qabul qila olmaysiz',
      );
      expect(ctx.updates()).toEqual([]);
      expect(ctx.lockCalls).toEqual([]);
    });

    it('HQ kuryeri — 400 «yo‘lda» (HQ kuryeri qoidasi o‘zgarmaydi)', async () => {
      const ctx = setup({
        orders: [inTransfer('201')],
        posts: [transferPost()],
      });
      const error = await rpcError(scan(ctx, HQ_COURIER, '201'));
      expect(error.statusCode).toBe(400);
      expect(error.message).toContain("Buyurtma yo'lda");
      expect(ctx.updates()).toEqual([]);
    });

    it('boshqa kuryer qo‘lidagi buyurtma — 400', async () => {
      const ctx = setup({
        orders: [
          inTransfer('201', {
            status: Order_status.WAITING,
            courier_id: '45',
            holder_type: 'COURIER',
            holder_courier_id: '45',
          }),
        ],
        posts: [transferPost()],
      });
      const error = await rpcError(scan(ctx, COURIER_44, '201'));
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe(
        'Buyurtma allaqachon boshqa kuryerga biriktirilgan',
      );
      expect(ctx.updates()).toEqual([]);
    });

    it('⭐ «kelmagan» belgili buyurtma (return_requested) — 409 `order_marked_not_arrived`', async () => {
      const ctx = setup({
        orders: [inTransfer('201', { return_requested: true })],
        posts: [transferPost()],
      });
      const error = await rpcError(scan(ctx, COURIER_44, '201'));
      expect(error.statusCode).toBe(409);
      expect(error.message).toBe(COURIER_SCAN_NOT_ARRIVED_MESSAGE);
      expect(error.gateway?.reason).toBe('order_marked_not_arrived');
      expect(ctx.updates()).toEqual([]);
      expect(ctx.lockCalls).toEqual([]);
    });

    it('boshqa viloyat buyurtmasi — 403, filialga ham qabul qilinmaydi', async () => {
      const ctx = setup({
        orders: [inTransfer('201', { region_id: '2' })],
        posts: [transferPost()],
      });
      const error = await rpcError(scan(ctx, COURIER_44, '201'));
      expect(error.statusCode).toBe(403);
      expect(error.gateway?.reason).toBe('district_not_served_by_branch');
      expect(ctx.updates()).toEqual([]);
      expect(ctx.orders.get('201')!.status).toBe(Order_status.ON_THE_ROAD);
    });
  });

  it('⭐ ikki kuryer bir vaqtda skanlasa — faqat bittasi oladi, ikkinchisi aniq xato', async () => {
    const ctx = setup({
      orders: [inTransfer('201'), inTransfer('202')],
      posts: [transferPost()],
    });

    const results = await Promise.allSettled([
      scan(ctx, COURIER_44, '201'),
      scan(ctx, COURIER_45, '201'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as RpcException).getError()).toMatchObject({
      statusCode: 400,
      message: 'Buyurtma allaqachon boshqa kuryerga biriktirilgan',
    });
    const order = ctx.orders.get('201')!;
    expect(order.status).toBe(Order_status.WAITING);
    expect(['44', '45']).toContain(order.courier_id);
    // Filialga qabul — bir marta.
    expect(
      ctx
        .updates()
        .filter(
          (u) =>
            u.requester?.note === COURIER_SCAN_TRACKING_NOTES.BRANCH_RECEIVE,
        ),
    ).toHaveLength(1);
  });
});

describe('COURIER-SCAN — skan = qabul (yakuniy holat WAITING)', () => {
  const branchOrder = (id: string, overrides: Row = {}) =>
    inTransfer(id, {
      status: Order_status.WAITING,
      post_id: '42',
      ...overrides,
    });

  it.each([
    ['filial qabul qilgan WAITING', Order_status.WAITING],
    ['RECEIVED', Order_status.RECEIVED],
    ['NEW', Order_status.NEW],
  ])(
    '⭐ %s → WAITING (hech qachon ON_THE_ROAD emas)',
    async (_label, status) => {
      const ctx = setup({
        orders: [branchOrder('301', { status })],
        posts: [transferPost({ status: Post_status.RECEIVED })],
      });

      await scan(ctx, COURIER_44, '301');

      expect(ctx.orders.get('301')).toMatchObject({
        status: Order_status.WAITING,
        courier_id: '44',
      });
      expect(
        ctx.updates().some((u) => u.dto.status === Order_status.ON_THE_ROAD),
      ).toBe(false);
      expect(ctx.updates().at(-1)!.requester.note).toBe(
        COURIER_SCAN_TRACKING_NOTES.TAKE,
      );
    },
  );

  it('⭐ bir kunda 5 ta skan — bitta kuryer pochtasi (RECEIVED), hisob 5', async () => {
    const ids = ['311', '312', '313', '314', '315'];
    const ctx = setup({
      orders: ids.map((id) => branchOrder(id)),
      posts: [transferPost({ status: Post_status.RECEIVED })],
    });

    for (const id of ids) {
      await scan(ctx, COURIER_44, id);
    }

    const courierPosts = ctx.courierPostsOf('44');
    expect(courierPosts).toHaveLength(1);
    expect(courierPosts[0]).toMatchObject({
      status: Post_status.RECEIVED,
      order_quantity: 5,
    });
    expect(
      ids.every((id) => ctx.orders.get(id)!.post_id === courierPosts[0].id),
    ).toBe(true);
  });

  it('⭐ bugungi SENT pochta (menejer jo‘natgan) — skan undagi yo‘ldagini ham qabul qiladi; yo‘ldagi qolmasa pochta yopiladi (bo‘sh SENT yo‘q)', async () => {
    const ctx = setup({
      orders: [
        branchOrder('321'),
        // Menejer kuryerga jo'natgan, kuryer hali qabul qilmagan.
        inTransfer('322', {
          post_id: '50',
          courier_id: '44',
          holder_type: 'COURIER',
          holder_courier_id: '44',
        }),
      ],
      posts: [
        transferPost({ status: Post_status.RECEIVED }),
        {
          id: '50',
          courier_id: '44',
          branch_id: null,
          status: Post_status.SENT,
          order_quantity: 1,
          post_total_price: 100_000,
          createdAt: new Date(),
        },
      ],
    });

    // Yangi buyurtma bugungi SENT pochtaga tushadi — unda yo'ldagi bor (SENT).
    await scan(ctx, COURIER_44, '321');
    expect(ctx.orders.get('321')!.post_id).toBe('50');
    expect(ctx.posts.get('50')!.status).toBe(Post_status.SENT);

    // O'zidagi yo'ldagini skanlash — qabul: WAITING, pochta yopiladi.
    const res = await scan(ctx, COURIER_44, '322');
    expect(res.data).toMatchObject({ accepted: true, status: 'waiting' });
    expect(ctx.orders.get('322')).toMatchObject({
      status: Order_status.WAITING,
      courier_id: '44',
    });
    const accept = ctx.updates().at(-1)!;
    expect(accept.requester.note).toBe(COURIER_SCAN_TRACKING_NOTES.TAKE);
    expect(accept.requester.note).not.toBe(
      POST_RECEIVED_TRACKING_NOTES.COURIER,
    );
    expect(ctx.posts.get('50')).toMatchObject({
      status: Post_status.RECEIVED,
      branch_id: '10',
    });
    // Kuryerda bo'sh SENT pochta qolmadi.
    expect(
      ctx.courierPostsOf('44').filter((p) => p.status === Post_status.SENT),
    ).toEqual([]);
  });

  it('kuryer yo‘ldagi buyurtmasi qolmagan SENT pochtaga yangi skan — pochta darhol yopiladi', async () => {
    const ctx = setup({
      orders: [branchOrder('331')],
      posts: [
        transferPost({ status: Post_status.RECEIVED }),
        {
          id: '51',
          courier_id: '44',
          branch_id: null,
          status: Post_status.SENT,
          order_quantity: 0,
          post_total_price: 0,
          createdAt: new Date(),
        },
      ],
    });

    const res = await scan(ctx, COURIER_44, '331');

    expect(res.data.post_id).toBe('51');
    expect(ctx.posts.get('51')).toMatchObject({
      status: Post_status.RECEIVED,
      branch_id: '10',
      order_quantity: 1,
    });
  });

  it('o‘z WAITING buyurtmasini qayta skanlash — idempotent, yozuv yo‘q', async () => {
    const ctx = setup({
      orders: [
        branchOrder('341', {
          courier_id: '44',
          holder_type: 'COURIER',
          holder_courier_id: '44',
          post_id: '50',
        }),
      ],
      posts: [
        {
          id: '50',
          courier_id: '44',
          status: Post_status.RECEIVED,
          createdAt: new Date(),
        },
      ],
    });
    const res = await scan(ctx, COURIER_44, '341');
    expect(res.data.idempotent).toBe(true);
    expect(ctx.updates()).toEqual([]);
  });
});

describe('COURIER-SCAN — qayta skan = qabul (savol 5 sukuti)', () => {
  it('⭐ HQ kuryeri: «Pochta → HQ kuryeri» bilan kelgan o‘z yo‘ldagi buyurtmasi — WAITING, pochta yopiladi', async () => {
    const ctx = setup({
      orders: [
        inTransfer('401', {
          branch_id: '1',
          post_id: '60',
          courier_id: '7',
          holder_type: 'COURIER',
          holder_branch_id: '1',
          holder_courier_id: '7',
        }),
      ],
      posts: [
        {
          id: '60',
          courier_id: '7',
          branch_id: null,
          status: Post_status.SENT,
          order_quantity: 1,
          post_total_price: 100_000,
          createdAt: new Date(),
        },
      ],
    });

    const res = await scan(ctx, HQ_COURIER, '401');

    expect(res.data).toMatchObject({
      accepted: true,
      idempotent: false,
      post_id: '60',
      status: Order_status.WAITING,
    });
    expect(ctx.orders.get('401')).toMatchObject({
      status: Order_status.WAITING,
      courier_id: '7',
    });
    expect(ctx.updates()).toHaveLength(1);
    expect(ctx.updates()[0].requester).toMatchObject({
      id: '7',
      note: COURIER_SCAN_TRACKING_NOTES.TAKE,
      post_receive_guard: { post_id: '60', status: Order_status.ON_THE_ROAD },
    });
    expect(ctx.lockCalls).toEqual(['post_receive:60']);
    expect(ctx.posts.get('60')!.status).toBe(Post_status.RECEIVED);
  });

  it('filial kuryeri: menejer biriktirgan «kelmagan» deb belgilagan o‘z buyurtmasi qo‘liga kelib skanlandi — qabul, belgi tozalanadi', async () => {
    const ctx = setup({
      orders: [
        inTransfer('402', {
          post_id: '61',
          courier_id: '44',
          holder_type: 'COURIER',
          holder_courier_id: '44',
          return_requested: true,
        }),
        inTransfer('403', {
          post_id: '61',
          courier_id: '44',
          holder_type: 'COURIER',
          holder_courier_id: '44',
        }),
      ],
      posts: [
        {
          id: '61',
          courier_id: '44',
          branch_id: null,
          status: Post_status.SENT,
          order_quantity: 2,
          post_total_price: 200_000,
          createdAt: new Date(),
        },
      ],
    });

    await scan(ctx, COURIER_44, '402');

    expect(ctx.orders.get('402')).toMatchObject({
      status: Order_status.WAITING,
      return_requested: false,
    });
    // 403 hali yo'lda — pochta ochiq, unga tegilmaydi.
    expect(ctx.orders.get('403')!.status).toBe(Order_status.ON_THE_ROAD);
    expect(ctx.posts.get('61')!.status).toBe(Post_status.SENT);
  });
});
