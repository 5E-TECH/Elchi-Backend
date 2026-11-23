/**
 * Skan auditi 2026-11-23 — QABUL IDEMPOTENT (`receiveNewOrders`).
 *
 * MUAMMO (prod, «Qabul va yaratish» skaneri). Operator posilkani
 * skanerlaydi, javob kechikadi (yoki gateway 8 s timeout beradi) va u qayta
 * skanerlaydi. Ikkinchi so'rov:
 *   - birinchisi commit qilgan bo'lsa — 404 «Buyurtmalar topilmadi» olardi
 *     (real bor posilka uchun «topilmadi»);
 *   - birinchisi hali ishlayotgan bo'lsa — buyurtmani yana `new` ko'rib,
 *     pochta hisoblagichini IKKINCHI marta oshirardi.
 *
 * Qulflanadigan invariantlar:
 *   - `received` buyurtmani qayta qabul — 200, `already_received_ids` da;
 *     pochta/javobgarlik/webhook QAYTA yozilmaydi;
 *   - aralash (new + received) so'rov — faqat `new` lari yoziladi;
 *   - qabuldan o'tib ketgan holat (`on_the_road`) «qabul qilindi» EMAS;
 *   - begona filialning qabul qilingan buyurtmasi haqida javob berilmaydi;
 *   - bir vaqtdagi ikki so'rov — logistics BIR marta chaqiriladi;
 *   - shartli UPDATE 0 qator qaytarsa (parallel nusxa) — qayta yozilmaydi.
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

type Row = Record<string, any>;

const SUPERADMIN = { id: '1', roles: ['superadmin'] };

const order = (over: Row = {}): Row => ({
  id: '31',
  status: Order_status.NEW,
  source: Order_source.INTERNAL,
  customer_id: 'c1',
  district_id: '120',
  region_id: '13',
  total_price: 100000,
  branch_id: '1',
  holder_type: OrderHolderType.HQ,
  holder_branch_id: null,
  isDeleted: false,
  ...over,
});

function makeSvc(
  rows: Row[],
  opts: {
    scopeBranchId?: string | null;
    /** logistics javobini qo'lda bo'shatish uchun (parallel test). */
    holdLogistics?: Promise<void>;
    /** shartli UPDATE natijasini majburlash (parallel nusxa simulyatsiyasi). */
    forceAffected?: number;
  } = {},
) {
  rmqSend.mockReset();
  const store = new Map(rows.map((row) => [String(row.id), { ...row }]));
  rmqSend.mockImplementation(
    async (_client: unknown, pattern: { cmd: string }, payload: any) => {
      switch (pattern.cmd) {
        case 'identity.customer.find_by_ids':
          return { data: [{ id: 'c1' }] };
        case 'logistics.district.find_by_ids':
          return { data: [{ id: '120', region_id: '13' }] };
        case 'logistics.post.receive_orders':
          if (opts.holdLogistics) await opts.holdLogistics;
          return {
            data: (payload.orders as Row[]).map((o) => ({
              order_id: String(o.order_id),
              post_id: '48',
            })),
          };
        default:
          return null;
      }
    },
  );

  // `find` haqiqiy repo kabi `id IN` va `status` bo'yicha filtrlaydi.
  const find = jest.fn(({ where }: { where: Row }) => {
    const ids: string[] = (where.id?._value ?? []).map(String);
    return Promise.resolve(
      [...store.values()]
        .filter((row) => ids.includes(String(row.id)))
        .filter((row) => !where.status || row.status === where.status)
        .map((row) => ({ ...row })),
    );
  });

  let pendingSet: Row = {};
  let whereParams: Row = {};
  const qb: Row = {
    update: jest.fn(() => qb),
    set: jest.fn((values: Row) => {
      pendingSet = values;
      return qb;
    }),
    where: jest.fn((_sql: string, params: Row) => {
      whereParams = params;
      return qb;
    }),
    execute: jest.fn(() => {
      if (opts.forceAffected !== undefined) {
        return Promise.resolve({ affected: opts.forceAffected });
      }
      const row = store.get(String(whereParams.id));
      if (!row || row.status !== whereParams.expectedStatus) {
        return Promise.resolve({ affected: 0 });
      }
      Object.assign(row, pendingSet);
      return Promise.resolve({ affected: 1 });
    }),
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
    toTrackingRole: jest.fn(() => 'superadmin'),
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const queueExternalStatusSync = jest.fn().mockResolvedValue(undefined);
  const s = Object.create(OrderLifecycleService.prototype) as Row;
  Object.assign(s, {
    orderRepo: { find },
    identityClient: {},
    logisticsClient: {},
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    resolveReceiveBranchScope: jest
      .fn()
      .mockResolvedValue(opts.scopeBranchId ?? null),
    resolveHolderFromState: jest.fn().mockResolvedValue({
      holder_type: OrderHolderType.BRANCH,
      holder_branch_id: opts.scopeBranchId ?? null,
      holder_courier_id: null,
    }),
    lookup: { getHqBranchId: jest.fn().mockResolvedValue('1') },
    custody,
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    activityLog,
    queueExternalStatusSync,
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
  });
  const svc = s as unknown as OrderLifecycleService;
  const receive = (ids: string[], requester: unknown = SUPERADMIN) =>
    svc.receiveNewOrders(ids, undefined, requester as never);
  const logisticsCalls = () =>
    rmqSend.mock.calls.filter(
      (call) =>
        (call[1] as { cmd: string }).cmd === 'logistics.post.receive_orders',
    );
  return { receive, store, qb, custody, activityLog, logisticsCalls, s };
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

describe('receiveNewOrders — qayta qabul idempotent (skan auditi 2026-11-23)', () => {
  it('⭐ allaqachon `received` buyurtma — 404 EMAS, 200 «allaqachon qabul qilingan»', async () => {
    const h = makeSvc([order({ status: Order_status.RECEIVED })]);

    const res: Row = await h.receive(['31']);

    expect(res).toMatchObject({
      statusCode: 200,
      data: { received_ids: [], already_received_ids: ['31'] },
    });
    // Hech narsa qayta yozilmaydi: pochta, holat, javobgarlik, log.
    expect(h.logisticsCalls()).toHaveLength(0);
    expect(h.qb.execute).not.toHaveBeenCalled();
    expect(h.custody.createTrackingEvent).not.toHaveBeenCalled();
    expect(h.activityLog.log).not.toHaveBeenCalled();
  });

  it('aralash so‘rov — faqat `new` lari pochtaga ajratiladi va yoziladi', async () => {
    const h = makeSvc([
      order({ id: '31' }),
      order({ id: '32', status: Order_status.RECEIVED }),
    ]);

    const res: Row = await h.receive(['31', '32']);

    expect(res.data).toEqual({
      received_ids: ['31'],
      already_received_ids: ['32'],
    });
    const [call] = h.logisticsCalls();
    expect(
      (call[2] as { orders: Row[] }).orders.map((o) => o.order_id),
    ).toEqual(['31']);
    expect(h.qb.execute).toHaveBeenCalledTimes(1);
    expect(h.store.get('31')?.status).toBe(Order_status.RECEIVED);
  });

  it('qabuldan o‘tib ketgan holat (`on_the_road`) «qabul qilindi» deb QAYTMAYDI', async () => {
    const h = makeSvc([order({ status: Order_status.ON_THE_ROAD })]);

    const error = await rpcError(h.receive(['31']));

    expect(error.statusCode).toBe(404);
    expect(h.logisticsCalls()).toHaveLength(0);
  });

  it('bir qismi umuman yo‘q bo‘lsa avvalgidek BUTUN so‘rov rad etiladi', async () => {
    const h = makeSvc([order({ id: '31' })]);

    const error = await rpcError(h.receive(['31', '999']));

    expect(error.statusCode).toBe(400);
    expect(h.logisticsCalls()).toHaveLength(0);
  });

  it('begona filialning qabul qilingan buyurtmasi haqida javob berilmaydi (403)', async () => {
    const h = makeSvc(
      [order({ status: Order_status.RECEIVED, branch_id: '9' })],
      { scopeBranchId: '7' },
    );

    const error = await rpcError(
      h.receive(['31'], { id: '5', roles: ['manager'] }),
    );

    expect(error.statusCode).toBe(403);
  });

  it('⭐ bir vaqtdagi ikki so‘rov — logistics BIR marta, ikkinchisi «allaqachon»', async () => {
    let release!: () => void;
    const holdLogistics = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeSvc([order()], { holdLogistics });

    const first = h.receive(['31']);
    // Birinchisi logistics javobini kutib turibdi — operator qayta skanerladi.
    await new Promise((resolve) => setImmediate(resolve));
    const second = h.receive(['31']);
    await new Promise((resolve) => setImmediate(resolve));
    release();

    const [a, b]: Row[] = await Promise.all([first, second]);

    expect(a.data).toEqual({ received_ids: ['31'], already_received_ids: [] });
    expect(b.data).toEqual({ received_ids: [], already_received_ids: ['31'] });
    expect(h.logisticsCalls()).toHaveLength(1);
    expect(h.custody.createTrackingEvent).toHaveBeenCalledTimes(1);
  });

  it('kutish xotirada qolmaydi — xato bilan tugagan qabuldan keyin ham qayta urinish ishlaydi', async () => {
    const h = makeSvc([order()]);
    rmqSend.mockRejectedValueOnce(new Error('identity down'));

    await expect(h.receive(['31'])).rejects.toThrow('identity down');
    const res: Row = await h.receive(['31']);

    expect(res.data).toEqual({
      received_ids: ['31'],
      already_received_ids: [],
    });
    expect((h.s.receiveInFlightMap as Map<string, unknown>).size).toBe(0);
  });

  it('shartli UPDATE 0 qator qaytarsa (parallel nusxa) — javobgarlik/log/webhook qayta yozilmaydi', async () => {
    const h = makeSvc([order({ external_id: 'ext-1' })], { forceAffected: 0 });

    const res: Row = await h.receive(['31']);

    expect(res.data).toEqual({
      received_ids: [],
      already_received_ids: ['31'],
    });
    expect(h.qb.where).toHaveBeenCalledWith(
      'id = :id AND "status" = :expectedStatus',
      { id: '31', expectedStatus: Order_status.NEW },
    );
    expect(h.custody.createTrackingEvent).not.toHaveBeenCalled();
    expect(h.custody.createCustodyEvent).not.toHaveBeenCalled();
    expect(h.activityLog.log).not.toHaveBeenCalled();
    expect(h.s.queueExternalStatusSync).not.toHaveBeenCalled();
  });
});
