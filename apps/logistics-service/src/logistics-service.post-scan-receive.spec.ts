import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { TimeoutError, of, throwError } from 'rxjs';
import {
  OutboxEvent,
  OutboxService,
  Order_status,
  Post_status,
  publicErrorData,
} from '@app/common';
import { Post } from './entities/post.entity';
import {
  LogisticsServiceService,
  POST_RECEIVE_MANAGER_ONLY_MESSAGE,
  POST_SCAN_ORDER_NOT_IN_POST_MESSAGE,
  POST_SCAN_ORDER_NOT_RECEIVABLE_MESSAGE,
} from './logistics-service.service';
import { LogisticsNotificationService } from './notification/logistics-notification.service';

/**
 * Skaner bilan qabul (2026-11-07) — `PATCH post/receive/:id`
 * `{ order_ids, scan: true }`: skan = darhol qabul (BeePost kabi).
 *
 * Haqiqiy servis + xotiradagi order-service (find_all / update / find_by_id)
 * + xotiradagi tranzaksiya (advisory qulf so'rovi, ichki SAVEPOINT) + haqiqiy
 * OutboxService / LogisticsNotificationService.
 */
type Row = Record<string, any>;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const USERS = {
  courier44: { id: '44', roles: ['courier'], branch_id: '10' },
  courier45: { id: '45', roles: ['courier'], branch_id: '10' },
  manager10: { id: '198', roles: ['manager'], branch_id: '10' },
  registrator10: { id: '78', roles: ['registrator'], branch_id: '10' },
  manager11: { id: '87', roles: ['manager'], branch_id: '11' },
  superadmin: { id: '1', roles: ['superadmin'] },
};

const STAFF_ROWS = [
  { user_id: '198', role: 'MANAGER' },
  { user_id: '199', role: 'REGISTRATOR' },
];

const courierPost = (overrides: Row = {}): Row => ({
  id: '40',
  courier_id: '44',
  branch_id: null,
  region_id: '14',
  status: Post_status.SENT,
  order_quantity: 3,
  post_total_price: 300_000,
  ...overrides,
});

const transferPost = (overrides: Row = {}): Row =>
  courierPost({ courier_id: '0', branch_id: '10', ...overrides });

const order = (id: string, status: Order_status, overrides: Row = {}): Row => ({
  id,
  status,
  branch_id: '10',
  post_id: '40',
  total_price: 100_000,
  return_requested: false,
  return_reason: null,
  ...overrides,
});
const onTheRoad = (id: string, overrides: Row = {}) =>
  order(id, Order_status.ON_THE_ROAD, overrides);
const waiting = (id: string, overrides: Row = {}) =>
  order(id, Order_status.WAITING, overrides);

function setup(options: {
  post?: Row;
  orders: Row[];
  /** order.update shu id lar uchun xato qaytaradi (yozuvsiz). */
  updateErrors?: Record<string, unknown>;
  /** order.update xato qaytaradi, lekin yozuv aslida o'tgan (timeout). */
  appliedDespiteError?: Record<string, unknown>;
  /** yozuvlardan keyingi qayta o'qish (2-chi find_all) yiqiladi. */
  refetchError?: boolean;
  withNotifier?: boolean;
  outboxError?: Error;
  courierBranchId?: string | null;
}) {
  const orders = new Map<string, Row>(
    options.orders.map((row) => [String(row.id), { ...row }]),
  );
  let findAllCalls = 0;
  const orderClient = {
    send: jest.fn(
      (
        pattern: { cmd: string },
        payload: { id?: string; dto?: Row; query?: Row },
      ) => {
        if (pattern.cmd === 'order.find_all') {
          findAllCalls += 1;
          if (options.refetchError && findAllCalls > 1) {
            return throwError(() => new TimeoutError());
          }
          const postId = String(payload.query?.post_id ?? '');
          const statuses = payload.query?.status
            ? ([] as unknown[]).concat(payload.query.status).map(String)
            : null;
          const rows = [...orders.values()].filter(
            (row) =>
              String(row.post_id ?? '') === postId &&
              (!statuses || statuses.includes(String(row.status))),
          );
          return of({ data: { data: rows.map((row) => ({ ...row })) } });
        }
        if (pattern.cmd === 'order.update') {
          const id = String(payload.id);
          const error = options.updateErrors?.[id];
          if (error) return throwError(() => error);
          const target = orders.get(id);
          if (target) Object.assign(target, payload.dto);
          const lateError = options.appliedDespiteError?.[id];
          if (lateError) return throwError(() => lateError);
          return of({ statusCode: 200 });
        }
        if (pattern.cmd === 'order.find_by_id') {
          return of({ ...orders.get(String(payload.id)) });
        }
        return of({});
      },
    ),
  };

  const postState: Row = { ...(options.post ?? courierPost()) };
  const committed: Row[] = [];
  let pending: Row[] = [];
  const outboxRepo = {
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((value: Row) => {
      if (options.outboxError) return Promise.reject(options.outboxError);
      pending.push(value);
      return Promise.resolve({ id: String(pending.length), ...value });
    }),
  };
  const txPostRepo = {
    findOne: jest.fn(() => Promise.resolve({ ...postState })),
    update: jest.fn((_where: Row, patch: Row) => {
      Object.assign(postState, patch);
      return Promise.resolve({ affected: 1 });
    }),
    // Bulk yo'l (`savePostWithArrivalNotification`) — butun obyekt `save`.
    save: jest.fn((entity: Row) => {
      Object.assign(postState, entity);
      return Promise.resolve({ ...entity });
    }),
  };
  const txManager: Row = {
    queryRunner: { isTransactionActive: true },
    query: jest.fn(() => Promise.resolve([])),
    getRepository: jest.fn((entity: unknown) => {
      if (entity === OutboxEvent) return outboxRepo;
      if (entity === Post) return txPostRepo;
      throw new Error('unexpected repository');
    }),
  };
  // Ichki tranzaksiya = SAVEPOINT: xatoda faqat shu qism qaytariladi.
  txManager.transaction = jest.fn(
    async (work: (manager: Row) => Promise<unknown>) => {
      const postBefore = { ...postState };
      const pendingBefore = pending.length;
      try {
        return await work(txManager);
      } catch (error) {
        for (const key of Object.keys(postState)) delete postState[key];
        Object.assign(postState, postBefore);
        pending = pending.slice(0, pendingBefore);
        throw error;
      }
    },
  );
  const transaction = jest.fn(
    async (work: (manager: Row) => Promise<unknown>) => {
      const postBefore = { ...postState };
      try {
        const result = await work(txManager);
        committed.push(...pending);
        pending = [];
        return result;
      } catch (error) {
        for (const key of Object.keys(postState)) delete postState[key];
        Object.assign(postState, postBefore);
        pending = [];
        throw error;
      }
    },
  );
  const postRepo = {
    findOne: jest.fn(() => Promise.resolve({ ...postState })),
    save: jest.fn((entity: Row) => {
      Object.assign(postState, entity);
      return Promise.resolve({ ...entity });
    }),
    manager: { transaction },
  };
  // Kuryer pochtasi RECEIVED bo'lganda kuryer filiali (Ega qarori 4).
  const branchClient = {
    send: jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === 'branch.user.find_by_user'
        ? of({
            data:
              options.courierBranchId === null
                ? null
                : { branch_id: options.courierBranchId ?? '10' },
          })
        : of({ data: null }),
    ),
  };
  const notifierBranchClient = {
    send: jest.fn(() => of({ data: STAFF_ROWS })),
  };
  const notifier = new LogisticsNotificationService(
    new OutboxService({ create: jest.fn(), save: jest.fn() } as never),
    notifierBranchClient as never,
  );
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new LogisticsServiceService(
    postRepo as any,
    {} as any,
    {} as any,
    orderClient as any,
    branchClient as any,
    {} as any,
    { send: jest.fn(() => of({})) } as any,
    activityLog as any,
    options.withNotifier === false ? undefined : notifier,
  );

  const updates = () =>
    orderClient.send.mock.calls
      .filter(([pattern]) => pattern.cmd === 'order.update')
      .map(([, payload]) => payload as Row);
  const actions = () =>
    activityLog.log.mock.calls.map(([entry]) => (entry as Row).action);
  const logEntry = (action: string) =>
    activityLog.log.mock.calls
      .map(([entry]) => entry as Row)
      .find((entry) => entry.action === action);
  const notifications = () =>
    committed.filter((row) => row.target === 'NOTIFICATION');

  return {
    service,
    orders,
    postState,
    postRepo,
    txPostRepo,
    txManager,
    transaction,
    orderClient,
    activityLog,
    notifierBranchClient,
    committed,
    updates,
    actions,
    logEntry,
    notifications,
    expectNothingWritten() {
      expect(updates()).toEqual([]);
      expect(txPostRepo.update).not.toHaveBeenCalled();
      expect(txPostRepo.save).not.toHaveBeenCalled();
      expect(postRepo.save).not.toHaveBeenCalled();
      expect(activityLog.log).not.toHaveBeenCalled();
      expect(committed).toEqual([]);
    },
  };
}

const scan = (
  ctx: ReturnType<typeof setup>,
  requester: Row,
  orderIds: string[],
  postId = '40',
) =>
  ctx.service.receivePost(requester as any, postId, {
    order_ids: orderIds,
    scan: true,
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
    // Gateway HTTP javobiga chiqadigan `data` (all-exceptions.filter kabi).
    return { ...payload, gateway: publicErrorData(payload) };
  }
  throw new Error('RpcException kutilgan edi');
}

describe('skan-qabul — faqat skanlangan buyurtma, qolganlarga tegilmaydi', () => {
  it('⭐ kuryer o‘z SENT pochtasida 1 ta skan: faqat shu buyurtma WAITING, qolgan yo‘ldagilar o‘zgarmaydi, pochta SENT', async () => {
    const ctx = setup({
      orders: [
        onTheRoad('101'),
        // Eski initiate-return sababi bor qoldiq — bulk yo'l uni tozalardi.
        onTheRoad('102', { return_reason: 'Market qaytarib oldi' }),
        onTheRoad('103'),
      ],
    });

    const res = await scan(ctx, USERS.courier44, ['101']);

    expect(res.statusCode).toBe(200);
    expect(res.message).toBe('Buyurtma qabul qilindi');
    expect(ctx.updates()).toEqual([
      {
        id: '101',
        dto: {
          status: Order_status.WAITING,
          return_requested: false,
          branch_id: '10',
        },
        requester: {
          id: '44',
          roles: ['courier'],
          note: 'Post received by courier',
          post_receive_guard: {
            post_id: '40',
            status: Order_status.ON_THE_ROAD,
          },
        },
      },
    ]);
    // Tanlanmaganlarga TEGILMAYDI: qaytarish so'rovi yo'q, sabab saqlanadi.
    expect(ctx.orders.get('102')).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      return_requested: false,
      return_reason: 'Market qaytarib oldi',
    });
    expect(ctx.orders.get('103')).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      return_requested: false,
    });
    // Pochta SENT da qoldi (status / branch_id o'zgarmadi — yozuv yo'q).
    expect(ctx.postState.status).toBe(Post_status.SENT);
    expect(ctx.txPostRepo.update).not.toHaveBeenCalled();
    expect(res.received_order_ids).toEqual(['101']);
    expect(res.already_received_order_ids).toEqual([]);
    expect(res.not_received_order_ids).toEqual([]);
    expect(res.failures).toEqual([]);
    expect(res.remaining_count).toBe(2);
    expect(res.post_status).toBe(Post_status.SENT);
    expect(res.data.map((row: Row) => row.id)).toEqual(['101']);
  });

  it('⭐ per-post advisory qulf: `post_receive:<id>` tranzaksiya ichida, hamma o‘qish/yozuvdan OLDIN', async () => {
    const ctx = setup({ orders: [onTheRoad('101'), onTheRoad('102')] });

    await scan(ctx, USERS.courier44, ['101']);

    expect(ctx.transaction).toHaveBeenCalledTimes(1);
    expect(ctx.txManager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['post_receive:40'],
    );
    const lockOrder = ctx.txManager.query.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(
      ctx.txPostRepo.findOne.mock.invocationCallOrder[0],
    );
    expect(lockOrder).toBeLessThan(
      ctx.orderClient.send.mock.invocationCallOrder[0],
    );
    // Pochta qulf ostida tranzaksiya menejeri orqali qayta o'qildi.
    expect(ctx.postRepo.findOne).not.toHaveBeenCalled();
  });

  it('⭐ oxirgi yo‘ldagi skanlandi — LC-11: pochta RECEIVED, faqat status/branch_id `update` (save EMAS)', async () => {
    const ctx = setup({
      orders: [waiting('101'), onTheRoad('102')],
      courierBranchId: '12',
    });

    const res = await scan(ctx, USERS.courier44, ['102']);

    expect(res.post_status).toBe(Post_status.RECEIVED);
    expect(res.remaining_count).toBe(0);
    expect(res.message).toBe(
      "Buyurtma qabul qilindi — pochta to'liq qabul qilindi",
    );
    expect(ctx.txPostRepo.update).toHaveBeenCalledTimes(1);
    expect(ctx.txPostRepo.update).toHaveBeenCalledWith(
      { id: '40' },
      // Ega qarori 4: RECEIVED kuryer pochtasi — kuryer filialida.
      { status: Post_status.RECEIVED, branch_id: '12' },
    );
    expect(ctx.txPostRepo.save).not.toHaveBeenCalled();
    expect(ctx.postRepo.save).not.toHaveBeenCalled();
    // order_quantity / post_total_price ustidan yozilmagan.
    expect(ctx.postState).toMatchObject({
      order_quantity: 3,
      post_total_price: 300_000,
    });
    expect(ctx.logEntry('status_change')).toMatchObject({
      entity_type: 'Post',
      entity_id: '40',
      new_value: { status: Post_status.RECEIVED },
      metadata: expect.objectContaining({ scan: true, order_count: 2 }),
    });
  });

  it('WAITING_CUSTOMER (mijoz kutilmoqda) skan bilan qabul qilinadi; pochta holatini faqat ON_THE_ROAD ushlaydi (bulk LC-11 bilan bir xil)', async () => {
    const ctx = setup({
      orders: [
        order('101', Order_status.WAITING_CUSTOMER),
        order('102', Order_status.WAITING_CUSTOMER),
      ],
    });

    const res = await scan(ctx, USERS.courier44, ['101']);

    expect(res.received_order_ids).toEqual(['101']);
    expect(ctx.updates()[0]).toMatchObject({
      id: '101',
      dto: { status: Order_status.WAITING },
      requester: {
        post_receive_guard: {
          post_id: '40',
          status: Order_status.WAITING_CUSTOMER,
        },
      },
    });
    // Qolgan «mijoz kutilmoqda» pochtani SENT da qotirmaydi.
    expect(res.remaining_count).toBe(0);
    expect(res.post_status).toBe(Post_status.RECEIVED);
  });

  it('SENT pochta: yo‘ldagi bitta + WAITING_CUSTOMER bitta — yo‘ldagisi skanlansa pochta RECEIVED (FE ro‘yxati bilan bir xil)', async () => {
    const ctx = setup({
      orders: [onTheRoad('101'), order('102', Order_status.WAITING_CUSTOMER)],
    });

    const res = await scan(ctx, USERS.courier44, ['101']);

    expect(res.received_order_ids).toEqual(['101']);
    expect(res.remaining_count).toBe(0);
    expect(res.post_status).toBe(Post_status.RECEIVED);
    // Skanlanmagan WAITING_CUSTOMER ga tegilmadi.
    expect(ctx.updates().map((u: Row) => u.id)).toEqual(['101']);
  });

  it('RECEIVED pochtadagi WAITING_CUSTOMER skanlansa — qabul qilinadi, pochta SENT ga QAYTA OCHILMAYDI', async () => {
    const ctx = setup({
      post: courierPost({ status: Post_status.RECEIVED, branch_id: '10' }),
      orders: [
        waiting('100'),
        order('101', Order_status.WAITING_CUSTOMER),
        order('102', Order_status.WAITING_CUSTOMER),
      ],
    });

    const res = await scan(ctx, USERS.courier44, ['101']);

    expect(res.received_order_ids).toEqual(['101']);
    expect(res.post_status).toBe(Post_status.RECEIVED);
    expect(ctx.txPostRepo.update).not.toHaveBeenCalled();
    expect(
      ctx.activityLog.log.mock.calls
        .map((call: Row[]) => call[0].action)
        .filter((action: string) => action !== 'logistics.post_scan_receive'),
    ).toEqual([]);
  });
});

describe('skan-qabul — qulf kutish chegarasi', () => {
  it('qulf so‘rovidan oldin `SET LOCAL lock_timeout` (gateway 8 s dan oldin voz kechadi)', async () => {
    const ctx = setup({ orders: [onTheRoad('101'), onTheRoad('102')] });

    await scan(ctx, USERS.courier44, ['101']);

    const sqls = ctx.txManager.query.mock.calls.map(
      (call: unknown[]) => call[0],
    );
    expect(sqls[0]).toBe("SET LOCAL lock_timeout = '7s'");
    expect(sqls[1]).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
  });

  it('qulf 7 s da bo‘shamadi (55P03) — 409 `post_receive_busy`, order.update yo‘q', async () => {
    const ctx = setup({ orders: [onTheRoad('101'), onTheRoad('102')] });
    ctx.txManager.query.mockImplementation((sql: string) =>
      sql.startsWith('SELECT pg_advisory_xact_lock')
        ? Promise.reject(
            Object.assign(
              new Error('canceling statement due to lock timeout'),
              {
                code: '55P03',
              },
            ),
          )
        : Promise.resolve([]),
    );

    const error = await rpcError(scan(ctx, USERS.courier44, ['101']));

    expect(error.statusCode).toBe(409);
    expect(error.message).toBe(
      'Pochta boshqa skan bilan band — qayta skanerlang',
    );
    expect(ctx.updates()).toEqual([]);
  });
});

describe('skan-qabul — already_received (xato emas)', () => {
  it('⭐ allaqachon WAITING buyurtma qayta skanlandi — 200, order.update yo‘q, pochta o‘zgarmaydi', async () => {
    const ctx = setup({ orders: [waiting('101'), onTheRoad('102')] });

    const res = await scan(ctx, USERS.courier44, ['101']);

    expect(res.statusCode).toBe(200);
    expect(res.message).toBe('Buyurtma allaqachon qabul qilingan');
    expect(ctx.updates()).toEqual([]);
    expect(res.received_order_ids).toEqual([]);
    expect(res.already_received_order_ids).toEqual(['101']);
    expect(res.not_received_order_ids).toEqual([]);
    expect(res.data.map((row: Row) => row.id)).toEqual(['101']);
    expect(res.post_status).toBe(Post_status.SENT);
    expect(ctx.txPostRepo.update).not.toHaveBeenCalled();
    expect(ctx.actions()).toEqual(['logistics.post_scan_receive']);
  });

  it('⭐ pochta RECEIVED bo‘lgandan keyin oxirgi buyurtmani qayta skan — 200 already (holat darvozasi qo‘llanmaydi)', async () => {
    const ctx = setup({
      post: courierPost({ status: Post_status.RECEIVED, branch_id: '10' }),
      orders: [waiting('101'), waiting('102')],
    });

    const res = await scan(ctx, USERS.courier44, ['102']);

    expect(res.statusCode).toBe(200);
    expect(res.already_received_order_ids).toEqual(['102']);
    expect(res.remaining_count).toBe(0);
    expect(res.post_status).toBe(Post_status.RECEIVED);
    expect(ctx.updates()).toEqual([]);
    expect(ctx.txPostRepo.update).not.toHaveBeenCalled();
  });

  it('hammasi already, lekin pochta noto‘g‘ri SENT qolgan — LC-11 tuzatish baribir: RECEIVED', async () => {
    const ctx = setup({ orders: [waiting('101'), waiting('102')] });

    const res = await scan(ctx, USERS.courier44, ['102']);

    expect(res.already_received_order_ids).toEqual(['102']);
    expect(res.post_status).toBe(Post_status.RECEIVED);
    expect(ctx.txPostRepo.update).toHaveBeenCalledWith(
      { id: '40' },
      { status: Post_status.RECEIVED, branch_id: '10' },
    );
    expect(ctx.actions()).toEqual([
      'logistics.post_scan_receive',
      'status_change',
    ]);
  });

  it('bekor (CANCELED) pochtadagi WAITING buyurtma — 200 already, pochta holatiga tegilmaydi', async () => {
    const ctx = setup({
      post: courierPost({ status: Post_status.CANCELED }),
      orders: [waiting('101')],
    });

    const res = await scan(ctx, USERS.courier44, ['101']);

    expect(res.already_received_order_ids).toEqual(['101']);
    expect(res.post_status).toBe(Post_status.CANCELED);
    expect(ctx.txPostRepo.update).not.toHaveBeenCalled();
  });
});

describe('skan-qabul — rad javoblari (400), hech narsa yozilmaydi', () => {
  it('⭐ pochtada yo‘q buyurtma — 400 order_not_in_post { order_id, post_id }', async () => {
    const ctx = setup({ orders: [onTheRoad('101')] });

    const error = await rpcError(scan(ctx, USERS.courier44, ['999']));

    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(POST_SCAN_ORDER_NOT_IN_POST_MESSAGE);
    expect(error.message).toBe('Bu buyurtma shu pochtada emas');
    expect(error.gateway).toEqual({
      reason: 'order_not_in_post',
      details: { order_id: '999', post_id: '40' },
    });
    ctx.expectNothingWritten();
  });

  it.each([
    Order_status.SOLD,
    Order_status.PARTLY_PAID,
    Order_status.PAID,
    Order_status.CANCELLED,
    Order_status.CLOSED,
    Order_status.RETURNED_TO_MARKET,
  ])(
    '⭐ yo‘lda emas (%s) — 400 order_not_receivable { order_id, status }',
    async (status) => {
      const ctx = setup({ orders: [onTheRoad('101'), order('103', status)] });

      const error = await rpcError(scan(ctx, USERS.courier44, ['103']));

      expect(error.statusCode).toBe(400);
      expect(error.message).toBe(POST_SCAN_ORDER_NOT_RECEIVABLE_MESSAGE);
      expect(error.message).toBe(
        "Buyurtma yo'lda emas — qabul qilib bo'lmaydi",
      );
      expect(error.gateway).toEqual({
        reason: 'order_not_receivable',
        details: { order_id: '103', status },
      });
      ctx.expectNothingWritten();
    },
  );

  it('qabul qilinadigani bor, lekin pochta NEW — mavjud darvoza 400', async () => {
    const ctx = setup({
      post: courierPost({ status: Post_status.NEW }),
      orders: [onTheRoad('101')],
    });

    const error = await rpcError(scan(ctx, USERS.courier44, ['101']));

    expect(error.statusCode).toBe(400);
    expect(error.message).toBe("Bu holatdagi pochtani qabul qilib bo'lmaydi");
    ctx.expectNothingWritten();
  });

  it('RECEIVED pochtadagi yo‘ldagi buyurtma (qoldiq) — darvoza o‘tkazadi, qabul qilinadi', async () => {
    const ctx = setup({
      post: courierPost({ status: Post_status.RECEIVED, branch_id: '10' }),
      orders: [waiting('101'), onTheRoad('102')],
    });

    const res = await scan(ctx, USERS.courier44, ['102']);

    expect(res.received_order_ids).toEqual(['102']);
    expect(res.post_status).toBe(Post_status.RECEIVED);
  });

  it('bo‘sh order_ids — 400, tranzaksiya ochilmaydi', async () => {
    const ctx = setup({ orders: [onTheRoad('101')] });

    const error = await rpcError(scan(ctx, USERS.courier44, ['  ']));

    expect(error.statusCode).toBe(400);
    expect(ctx.transaction).not.toHaveBeenCalled();
    ctx.expectNothingWritten();
  });

  it('pochta topilmadi — 404', async () => {
    const ctx = setup({ orders: [] });
    ctx.txPostRepo.findOne.mockResolvedValue(null as never);

    const error = await rpcError(scan(ctx, USERS.courier44, ['101']));

    expect(error.statusCode).toBe(404);
    ctx.expectNothingWritten();
  });
});

describe('skan-qabul — qabul qilinmadi / qayta o‘qish', () => {
  it('⭐ order.update 409 (shu orada pochtadan chiqdi) — 200, not_received + failures, pochta SENT', async () => {
    const ctx = setup({
      orders: [onTheRoad('101'), onTheRoad('102')],
      updateErrors: {
        '101': new RpcException({
          statusCode: 409,
          message:
            "Buyurtma #101 shu orada pochtadan chiqdi yoki holati o'zgardi — sahifani yangilang",
        }),
      },
    });

    const res = await scan(ctx, USERS.courier44, ['101']);

    expect(res.statusCode).toBe(200);
    expect(res.received_order_ids).toEqual([]);
    expect(res.not_received_order_ids).toEqual(['101']);
    expect(res.failures).toEqual([
      {
        order_id: '101',
        error:
          "Buyurtma #101 shu orada pochtadan chiqdi yoki holati o'zgardi — sahifani yangilang",
      },
    ]);
    expect(res.message).toBe(
      "Buyurtma #101 qabul qilinmadi: Buyurtma #101 shu orada pochtadan chiqdi yoki holati o'zgardi — sahifani yangilang",
    );
    expect(res.data).toEqual([]);
    expect(res.post_status).toBe(Post_status.SENT);
  });

  it('timeout, lekin yozuv aslida o‘tgan — yangi o‘qishdan `received` (xato diagnostika uchun failures da)', async () => {
    const ctx = setup({
      orders: [onTheRoad('101')],
      appliedDespiteError: { '101': new TimeoutError() },
    });

    const res = await scan(ctx, USERS.courier44, ['101']);

    expect(res.received_order_ids).toEqual(['101']);
    expect(res.not_received_order_ids).toEqual([]);
    expect(res.failures).toEqual([
      expect.objectContaining({ order_id: '101' }),
    ]);
    expect(res.post_status).toBe(Post_status.RECEIVED);
  });

  it('qayta o‘qish yiqilsa — surat bo‘yicha: remaining_count null, yo‘ldagi qoldiq bor → SENT', async () => {
    const ctx = setup({
      orders: [onTheRoad('101'), onTheRoad('102')],
      refetchError: true,
    });

    const res = await scan(ctx, USERS.courier44, ['101']);

    expect(res.received_order_ids).toEqual(['101']);
    expect(res.remaining_count).toBeNull();
    expect(res.post_status).toBe(Post_status.SENT);
    expect(ctx.txPostRepo.update).not.toHaveBeenCalled();
  });

  it('qayta o‘qish yiqilsa va update ham yiqilgan — xavfsiz tomon (SENT), not_received', async () => {
    const ctx = setup({
      orders: [onTheRoad('101')],
      updateErrors: { '101': new RpcException({ statusCode: 502 }) },
      refetchError: true,
    });

    const res = await scan(ctx, USERS.courier44, ['101']);

    expect(res.not_received_order_ids).toEqual(['101']);
    expect(res.post_status).toBe(Post_status.SENT);
  });
});

describe('skan-qabul — logistics.batch_arrived faqat pochta shu so‘rovda yopilganda', () => {
  it('⭐ o‘tkazma pochtasi: 1-skan (qoldiq bor) — bildirishnoma yo‘q; oxirgi skan SENT → RECEIVED — bitta bildirishnoma, pochta yozuvi bilan bitta SAVEPOINT da', async () => {
    const ctx = setup({
      post: transferPost(),
      orders: [onTheRoad('101'), onTheRoad('102')],
    });

    const first = await scan(ctx, USERS.manager10, ['101']);
    expect(first.post_status).toBe(Post_status.SENT);
    expect(ctx.notifications()).toEqual([]);
    expect(ctx.txManager.transaction).not.toHaveBeenCalled();

    const second = await scan(ctx, USERS.manager10, ['102']);
    expect(second.post_status).toBe(Post_status.RECEIVED);
    expect(ctx.txManager.transaction).toHaveBeenCalledTimes(1);
    expect(ctx.txPostRepo.update).toHaveBeenCalledWith(
      { id: '40' },
      { status: Post_status.RECEIVED },
    );
    expect(ctx.notifications()).toHaveLength(1);
    expect(ctx.notifications()[0].payload).toMatchObject({
      type: 'logistics.batch_arrived',
      recipient_ids: ['198', '199'],
      link: '/mails/40',
      data: expect.objectContaining({
        post_id: '40',
        branch_id: '10',
        received_count: 2,
        order_count: 2,
        status: Post_status.RECEIVED,
      }),
    });
    // Menejer — filial qabul izohi.
    expect(ctx.updates()[1].requester).toMatchObject({
      id: '198',
      note: 'Post received by branch',
    });
    expect(ctx.actions()).not.toContain('logistics.post_receive_override');
  });

  it('pochta oldin ham RECEIVED edi (qoldiq qabul) — bildirishnoma yo‘q', async () => {
    const ctx = setup({
      post: transferPost({ status: Post_status.RECEIVED }),
      orders: [waiting('101'), onTheRoad('102')],
    });

    const res = await scan(ctx, USERS.manager10, ['102']);

    expect(res.post_status).toBe(Post_status.RECEIVED);
    expect(ctx.notifications()).toEqual([]);
    expect(ctx.notifierBranchClient.send).not.toHaveBeenCalled();
  });

  it('outbox yozilmasa — faqat SAVEPOINT qaytariladi, pochta bildirishnomasiz RECEIVED (qabul yiqilmaydi)', async () => {
    const ctx = setup({
      post: transferPost(),
      orders: [onTheRoad('101')],
      outboxError: new Error('relation does not exist'),
    });

    const res = await scan(ctx, USERS.manager10, ['101']);

    expect(res.statusCode).toBe(200);
    expect(res.post_status).toBe(Post_status.RECEIVED);
    expect(ctx.postState.status).toBe(Post_status.RECEIVED);
    expect(ctx.txPostRepo.update).toHaveBeenCalledTimes(2);
    expect(ctx.committed).toEqual([]);
  });

  it('kuryer o‘z pochtasini yopdi — filialga kelish EMAS: bildirishnoma yo‘q', async () => {
    const ctx = setup({ orders: [onTheRoad('101')] });

    await scan(ctx, USERS.courier44, ['101']);

    expect(ctx.postState.status).toBe(Post_status.RECEIVED);
    expect(ctx.notifierBranchClient.send).not.toHaveBeenCalled();
    expect(ctx.notifications()).toEqual([]);
  });
});

describe('skan-qabul — activity log', () => {
  it('⭐ har skan — bitta `logistics.post_scan_receive` (scan:true, id lar, remaining_count, post_status); STATUS_CHANGE faqat holat o‘zgarganda', async () => {
    const ctx = setup({
      orders: [onTheRoad('101'), onTheRoad('102'), waiting('103')],
    });

    await scan(ctx, USERS.courier44, ['101', '103']);

    expect(ctx.actions()).toEqual(['logistics.post_scan_receive']);
    expect(ctx.logEntry('logistics.post_scan_receive')).toMatchObject({
      entity_type: 'Post',
      entity_id: '40',
      user_id: '44',
      new_value: { status: Post_status.SENT },
      metadata: {
        scan: true,
        received_order_ids: ['101'],
        already_received_order_ids: ['103'],
        not_received_order_ids: [],
        remaining_count: 1,
        post_status: Post_status.SENT,
        branch_id: '10',
        courier_id: '44',
        failed_order_count: 0,
      },
    });
  });
});

describe('skan-qabul — ruxsat yo‘llari o‘zgarmagan (bulk bilan bir xil)', () => {
  it('⭐ kuryer begona kuryer pochtasini skanlasa — 403, hech narsa yozilmaydi', async () => {
    const ctx = setup({ orders: [onTheRoad('101')] });

    const error = await rpcError(scan(ctx, USERS.courier45, ['101']));

    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(
      "Courier faqat o'ziga biriktirilgan pochtani qabul qilishi mumkin",
    );
    ctx.expectNothingWritten();
  });

  it('⭐ ruxsat tasnifdan OLDIN: begona kuryer pochtada yo‘q id bilan ham 403 (400 emas)', async () => {
    const ctx = setup({ orders: [onTheRoad('101')] });

    const error = await rpcError(scan(ctx, USERS.courier45, ['999']));

    expect(error.statusCode).toBe(403);
  });

  it.each([
    ['filial registratori', USERS.registrator10],
    ['filial kuryeri', USERS.courier44],
  ])(
    '⭐ o‘tkazma pochtasi — %s 403 post_receive_manager_only',
    async (_label, requester) => {
      const ctx = setup({ post: transferPost(), orders: [onTheRoad('101')] });

      const error = await rpcError(scan(ctx, requester, ['101']));

      expect(error.statusCode).toBe(403);
      expect(error.message).toBe(POST_RECEIVE_MANAGER_ONLY_MESSAGE);
      expect(error.gateway).toEqual({
        reason: 'post_receive_manager_only',
        details: { post_id: '40' },
      });
      ctx.expectNothingWritten();
    },
  );

  it('⭐ boshqa filial menejeri — ma‘lumotsiz umumiy 403', async () => {
    const ctx = setup({ post: transferPost(), orders: [onTheRoad('101')] });

    const error = await rpcError(scan(ctx, USERS.manager11, ['101']));

    expect(error.statusCode).toBe(403);
    expect(error.message).toBe('Siz bu branch pochtasini qabul qila olmaysiz');
    expect(error.gateway?.reason).toBeUndefined();
    ctx.expectNothingWritten();
  });

  it('⭐ superadmin o‘tkazma pochtasini skanlasa — qabul + override yozuvi (scan:true); already bo‘lsa override yo‘q', async () => {
    const ctx = setup({
      post: transferPost(),
      orders: [onTheRoad('101'), waiting('102'), onTheRoad('103')],
    });

    const res = await scan(ctx, USERS.superadmin, ['101']);

    expect(res.received_order_ids).toEqual(['101']);
    expect(ctx.logEntry('logistics.post_receive_override')).toMatchObject({
      entity_id: '40',
      user_id: '1',
      metadata: expect.objectContaining({
        override: true,
        scan: true,
        post_id: '40',
        branch_id: '10',
        received_order_ids: ['101'],
      }),
    });

    ctx.activityLog.log.mockClear();
    await scan(ctx, USERS.superadmin, ['102']);
    expect(ctx.actions()).toEqual(['logistics.post_scan_receive']);
  });
});

describe('bulk himoya (scan yo‘q yo‘l) — sotilgan buyurtma «kutilmoqda» ga qaytmaydi', () => {
  it.each([
    Order_status.SOLD,
    Order_status.PARTLY_PAID,
    Order_status.PAID,
    Order_status.CANCELLED,
    Order_status.CLOSED,
  ])(
    '⭐ tanlangan %s buyurtma WAITING ga yozilmaydi, failures da; yo‘ldagisi qabul qilinadi',
    async (status) => {
      const ctx = setup({
        post: transferPost(),
        orders: [onTheRoad('101'), order('103', status)],
      });

      const res = (await ctx.service.receivePost(USERS.manager10, '40', {
        order_ids: ['101', '103'],
      })) as Row;

      expect(res.statusCode).toBe(200);
      const waitingWrites = ctx
        .updates()
        .filter((payload) => payload.dto?.status === Order_status.WAITING)
        .map((payload) => payload.id);
      expect(waitingWrites).toEqual(['101']);
      expect(ctx.orders.get('103')?.status).toBe(status);
      expect(res.failures).toEqual([
        {
          order_id: '103',
          error: `Buyurtma yo'lda emas — qabul qilib bo'lmaydi (holati: ${status})`,
        },
      ]);
      // Yo'lda emas — not_received ga tushmaydi (FE uni qayta skanlamaydi).
      expect(res.not_received_order_ids).toEqual([]);
      expect(ctx.postState.status).toBe(Post_status.RECEIVED);
      // Bulk yo'l qulfsiz va eski `save` bilan (o'zgarmagan).
      expect(ctx.transaction).toHaveBeenCalledTimes(1); // faqat bildirishnoma
      expect(ctx.txManager.query).not.toHaveBeenCalled();
    },
  );

  it('scan:false — avvalgi bulk qoida (tanlanmagan yo‘ldagi qaytarishga)', async () => {
    const ctx = setup({ orders: [onTheRoad('101'), onTheRoad('102')] });

    await ctx.service.receivePost(USERS.courier44, '40', {
      order_ids: ['101'],
      scan: false,
    });

    expect(ctx.orders.get('102')).toMatchObject({
      status: Order_status.ON_THE_ROAD,
      return_requested: true,
    });
    expect(ctx.txManager.query).not.toHaveBeenCalled();
  });
});

describe('PATCH post/receive/order/:id — holat himoyasi', () => {
  function receiveOrderSetup(status: Order_status) {
    const ctx = setup({ orders: [order('101', status, { courier_id: '44' })] });
    return ctx;
  }

  it.each([
    Order_status.SOLD,
    Order_status.PAID,
    Order_status.CANCELLED,
    Order_status.CLOSED,
    Order_status.WAITING,
  ])(
    '⭐ %s buyurtma — 400 order_not_receivable, yozuv yo‘q',
    async (status) => {
      const ctx = receiveOrderSetup(status);

      const error = await rpcError(
        ctx.service.receiveOrderWithScannerCourier(USERS.courier44, '101'),
      );

      expect(error.statusCode).toBe(400);
      expect(error.message).toBe(POST_SCAN_ORDER_NOT_RECEIVABLE_MESSAGE);
      expect(error.gateway).toEqual({
        reason: 'order_not_receivable',
        details: { order_id: '101', status },
      });
      expect(ctx.updates()).toEqual([]);
      expect(ctx.postRepo.save).not.toHaveBeenCalled();
    },
  );

  it.each([Order_status.ON_THE_ROAD, Order_status.WAITING_CUSTOMER])(
    '%s buyurtma — avvalgidek qabul qilinadi',
    async (status) => {
      const ctx = receiveOrderSetup(status);

      const res = (await ctx.service.receiveOrderWithScannerCourier(
        USERS.courier44,
        '101',
      )) as Row;

      expect(res.statusCode).toBe(200);
      expect(ctx.orders.get('101')?.status).toBe(Order_status.WAITING);
    },
  );
});
