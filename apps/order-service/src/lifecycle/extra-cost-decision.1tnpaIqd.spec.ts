import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ExtraCostRejectReason, Order_status } from '@app/common';
import {
  ExtraCostExecutionOptions,
  ExtraCostRequestClosedError,
  OrderLifecycleService,
} from './order-lifecycle.service';
import {
  extraCostApprovalTable,
  extraCostManager,
} from '../testing/extra-cost-kit-spec';
import { ExtraCostAutoApproveScheduler } from './extra-cost-auto-approve.scheduler';

/**
 * 1tnpaIqd + DuST9k8j (order-service tomoni):
 *  - qaror ATOMIK shartli UPDATE: ikki parallel approve (yoki approve +
 *    reject) — faqat bittasi; biznes amali BIR marta;
 *  - (hwTkXsGi) «tasdiqlandi» sotuv bilan BITTA tranzaksiyada; darvoza
 *    (buyurtma «kutilmoqda», holati o'zgarmagan) yoki biznes xatosi —
 *    so'rov `void` + 409; faqat infratuzilma xatosida `pending` qoladi;
 *  - rad etish sababi yopiq ro'yxat;
 *  - so'rov yaratilganda `extra_cost.requested` (outbox, best-effort);
 *  - ega qarori: muddat o'tsa AVTOMATIK tasdiq (env), eslatma, audit.
 */
type Row = Record<string, any>;

const pending = (overrides: Row = {}): Row => ({
  id: '7',
  order_id: '7001',
  market_id: '501',
  requested_by_user_id: '301',
  requested_by_role: 'courier',
  requester_branch_id: '77',
  action: 'sell',
  amount: 12000,
  proof_file_keys: ['proof-1'],
  operation_payload: { extraCost: 12000 },
  status: 'pending',
  isDeleted: false,
  auto_approved: false,
  reminder_sent_at: null,
  createdAt: new Date('2026-10-16T10:00:00Z'),
  ...overrides,
});

const NOT_WAITING =
  'Buyurtma topilmadi yoki kutilmoqda (waiting) holatida emas';

/**
 * Jadval — haqiqiy WHERE semantikasi bilan (`testing/extra-cost-kit-spec`).
 * Qayta ijro (`sellOrder` / `cancelOrder`) soxta, lekin uning TRANZAKSIYASI
 * modellashtirilgan (hwTkXsGi): buyurtma qulfi (navbat) → WAITING tekshiruvi →
 * HAQIQIY `applyExtraCostApprovalsOnExecution` (darvoza + claim) → pul;
 * xato bo'lsa jadval holati qaytadi. `failures` — claim'dan keyin, pul
 * yozilayotganda chiqadigan xatolar navbati.
 */
function makeService(rows: Row[]) {
  const repo = extraCostApprovalTable(rows);
  const order = {
    id: '7001',
    status: Order_status.WAITING as Order_status,
    isDeleted: false,
  };
  const orderRepo = {
    findOne: jest.fn(() => Promise.resolve({ ...order })),
  };
  const manager = extraCostManager({ table: repo, orderRepo });
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  // «… topilmadi» (404) qayta ijroda — market / xodim identity'da bormi
  // (hwTkXsGi): sukut — bor (lookup xatoni yutgan, so'rov pending qoladi).
  const lookup = {
    getUserByIdStrict: jest.fn((id: string) => Promise.resolve({ id })),
  };
  const svc = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService;
  Object.assign(svc, {
    extraCostApprovalRepo: repo,
    orderRepo,
    dataSource: { manager },
    outbox,
    activityLog,
    lookup,
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
  });
  const executed: string[] = [];
  const failures: unknown[] = [];
  let orderLock: Promise<unknown> = Promise.resolve();
  const replay =
    (name: 'sellOrder' | 'cancelOrder') =>
    async (
      actor: { id: string },
      orderId: string,
      _payload: unknown,
      _requestId?: string,
      options?: ExtraCostExecutionOptions,
    ) => {
      await new Promise((resolve) => setImmediate(resolve));
      const run = orderLock.then(() =>
        repo.transaction(async () => {
          if (order.status !== Order_status.WAITING) {
            throw new RpcException({ statusCode: 400, message: NOT_WAITING });
          }
          await (
            svc as unknown as {
              applyExtraCostApprovalsOnExecution: (
                ...args: unknown[]
              ) => Promise<void>;
            }
          ).applyExtraCostApprovalsOnExecution(
            manager,
            orderId,
            actor,
            options,
          );
          if (failures.length) throw failures.shift();
          order.status =
            name === 'cancelOrder' ? Order_status.CANCELLED : Order_status.SOLD;
          executed.push(name);
          return { statusCode: 200, message: 'ok', data: {} };
        }),
      );
      orderLock = run.catch(() => undefined);
      return run as never;
    };
  const sellOrder = jest
    .spyOn(svc, 'sellOrder')
    .mockImplementation(replay('sellOrder'));
  const cancelOrder = jest
    .spyOn(svc, 'cancelOrder')
    .mockImplementation(replay('cancelOrder'));
  return {
    svc,
    repo,
    lookup,
    order,
    manager,
    outbox,
    activityLog,
    sellOrder,
    cancelOrder,
    executed,
    failures,
  };
}

const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => ({ statusCode: 200, message: 'ok' }),
    (error: unknown) =>
      (error as RpcException).getError() as {
        statusCode: number;
        message: string;
      },
  );

const market = { id: '501', roles: ['market'] };

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('1tnpaIqd + hwTkXsGi — atomik qaror', () => {
  it('⭐ ikki parallel approve — biri 200, ikkinchisi "allaqachon yakunlangan", sotuv BIR marta', async () => {
    const { svc, executed, repo } = makeService([pending()]);
    const [first, second] = await Promise.all([
      svc.approveExtraCostApproval(market, '7').then(
        (res) => ({ ok: true, res }),
        (error: unknown) => ({ ok: false, error }),
      ),
      svc.approveExtraCostApproval(market, '7').then(
        (res) => ({ ok: true, res }),
        (error: unknown) => ({ ok: false, error }),
      ),
    ]);
    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const failed = results.find((r) => !r.ok) as { error: RpcException };
    expect(failed.error.getError()).toEqual({
      statusCode: 409,
      message: "Bu so'rov allaqachon yakunlangan",
    });
    expect(executed).toEqual(['sellOrder']);
    expect(repo.row('7')).toEqual(
      expect.objectContaining({
        status: 'approved',
        decided_by_user_id: '501',
      }),
    );
    expect(repo.row('7')!.closed_reason).toBeUndefined();
  });

  it('⭐ approve + reject bir vaqtda — faqat bittasi o‘tadi, status aralashmaydi', async () => {
    const { svc, executed, repo } = makeService([pending()]);
    const outcomes = await Promise.allSettled([
      svc.approveExtraCostApproval(market, '7'),
      svc.rejectExtraCostApproval(market, '7', {
        reason: ExtraCostRejectReason.TOO_EXPENSIVE,
      }),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const status = repo.row('7')!.status;
    expect(['approved', 'rejected']).toContain(status);
    expect(executed).toHaveLength(status === 'approved' ? 1 : 0);
  });

  it('⭐ yakunlangan so‘rovga qayta qaror — 409, DB o‘zgarmaydi, biznes amali yo‘q', async () => {
    const { svc, sellOrder, repo } = makeService([
      pending({ status: 'rejected', decision_comment: 'x' }),
    ]);
    expect(await errorOf(svc.approveExtraCostApproval(market, '7'))).toEqual({
      statusCode: 409,
      message: "Bu so'rov allaqachon yakunlangan",
    });
    expect(
      await errorOf(
        svc.rejectExtraCostApproval(market, '7', {
          reason: ExtraCostRejectReason.TOO_EXPENSIVE,
        }),
      ),
    ).toEqual({
      statusCode: 409,
      message: "Bu so'rov allaqachon yakunlangan",
    });
    expect(sellOrder).not.toHaveBeenCalled();
    expect(repo.row('7')!.status).toBe('rejected');
  });

  it('⭐ TC8 bir martada: muvaffaqiyatda «tasdiqlandi» claim sotuv tranzaksiyasi ICHIDA yoziladi', async () => {
    const { svc, sellOrder, repo, order } = makeService([pending()]);
    const res = await svc.approveExtraCostApproval(market, '7', {
      comment: 'mayli',
    });
    expect(res.statusCode).toBe(200);
    // Qayta ijroga claim parametri beriladi — qaror oldindan yozilmaydi.
    expect(sellOrder).toHaveBeenCalledWith(
      { id: '301', roles: ['courier'], branch_id: '77' },
      '7001',
      expect.objectContaining({ extraCost: 12000 }),
      'extra-cost-approval:7',
      {
        extraCostApproval: {
          id: '7',
          patch: {
            decided_by_user_id: '501',
            decided_at: expect.any(Date),
            decision_comment: 'mayli',
            auto_approved: false,
          },
        },
      },
    );
    expect(order.status).toBe(Order_status.SOLD);
    expect(repo.row('7')).toEqual(
      expect.objectContaining({
        status: 'approved',
        decided_by_user_id: '501',
        decision_comment: 'mayli',
        reject_reason: null,
      }),
    );
  });

  it("⭐ TC8 bir martada: sotuv tranzaksiyasi claim'dan KEYIN infratuzilma xatosi bersa — so‘rov «tasdiqlandi» bo‘lib qolmaydi, pending", async () => {
    const { svc, repo, executed, failures } = makeService([pending()]);
    const timeout = new Error('RMQ timeout');
    failures.push(timeout);
    await expect(svc.approveExtraCostApproval(market, '7')).rejects.toBe(
      timeout,
    );
    expect(executed).toHaveLength(0);
    expect(repo.row('7')!.status).toBe('pending');
    expect(repo.row('7')!.decided_at).toBeUndefined();
    expect(repo.row('7')!.decided_by_user_id).toBeUndefined();
    // Qayta urinish mumkin — keyingi tasdiq o'tadi.
    await svc.approveExtraCostApproval(market, '7');
    expect(repo.row('7')!.status).toBe('approved');
    expect(executed).toEqual(['sellOrder']);
  });

  it.each([
    ['5xx', new RpcException({ statusCode: 500, message: 'DB xatosi' })],
    [
      'javob bermagan lookup (Market)',
      new RpcException({ statusCode: 404, message: 'Market topilmadi' }),
    ],
    [
      'javob bermagan lookup (kassa)',
      new RpcException({
        statusCode: 404,
        message: 'Kuryer kassasi topilmadi',
      }),
    ],
  ])(
    'infratuzilma xatosi (%s) — xato o‘zgarmaydi, so‘rov pending qoladi',
    async (_label, error) => {
      const { svc, repo, failures } = makeService([pending()]);
      failures.push(error);
      await expect(svc.approveExtraCostApproval(market, '7')).rejects.toBe(
        error,
      );
      expect(repo.row('7')!.status).toBe('pending');
      expect(repo.row('7')!.closed_reason).toBeUndefined();
    },
  );

  it('⭐ «Market topilmadi», market identity’da haqiqatan o‘chirilgan — so‘rov void, 409 (abadiy pending emas)', async () => {
    const { svc, repo, lookup, failures } = makeService([pending()]);
    lookup.getUserByIdStrict.mockResolvedValueOnce(null as never);
    failures.push(
      new RpcException({ statusCode: 404, message: 'Market topilmadi' }),
    );

    const error = await svc
      .approveExtraCostApproval(market, '7')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtraCostRequestClosedError);
    expect(lookup.getUserByIdStrict).toHaveBeenCalledWith(
      String(pending().market_id),
    );
    expect(repo.row('7')).toMatchObject({
      status: 'void',
      closed_reason: "amalni bajarib bo'lmadi: Market topilmadi",
    });
  });

  it.each([400, 403, 404, 409])(
    '⭐ qayta ijro biznes xatosi (%s) — so‘rov sababi bilan void, 409 «allaqachon yakunlangan — …»',
    async (statusCode) => {
      const { svc, repo, failures, executed } = makeService([pending()]);
      failures.push(
        new RpcException({ statusCode, message: 'Kuryer bloklangan' }),
      );
      expect(await errorOf(svc.approveExtraCostApproval(market, '7'))).toEqual({
        statusCode: 409,
        message:
          "Bu so'rov allaqachon yakunlangan — amalni bajarib bo'lmadi: Kuryer bloklangan",
      });
      expect(executed).toHaveLength(0);
      expect(repo.row('7')).toEqual(
        expect.objectContaining({
          status: 'void',
          closed_reason: "amalni bajarib bo'lmadi: Kuryer bloklangan",
          closed_by_user_id: '501',
          closed_at: expect.any(Date),
        }),
      );
      expect(repo.row('7')!.decided_at).toBeUndefined();
    },
  );

  it('⭐ TC2 darvoza: buyurtma endi «kutilmoqda» emas — void + 409, qayta ijro chaqirilmaydi', async () => {
    const { svc, repo, order, sellOrder } = makeService([pending()]);
    order.status = Order_status.SOLD;
    expect(await errorOf(svc.approveExtraCostApproval(market, '7'))).toEqual({
      statusCode: 409,
      message:
        "Bu so'rov allaqachon yakunlangan — buyurtma endi «kutilmoqda» holatida emas (sold)",
    });
    expect(sellOrder).not.toHaveBeenCalled();
    expect(repo.row('7')).toEqual(
      expect.objectContaining({
        status: 'void',
        closed_reason: 'buyurtma endi «kutilmoqda» holatida emas (sold)',
      }),
    );
  });

  it('⭐ TC6 darvoza: so‘rovdan keyin holat o‘zgargan (sotilib, orqaga qaytarilgan) — void + 409', async () => {
    const { svc, repo, manager, sellOrder } = makeService([pending()]);
    manager.tracking.state.changedTo = Order_status.SOLD;
    expect(await errorOf(svc.approveExtraCostApproval(market, '7'))).toEqual({
      statusCode: 409,
      message:
        "Bu so'rov allaqachon yakunlangan — so'rov ochilgandan keyin buyurtma holati o'zgargan (sold)",
    });
    expect(sellOrder).not.toHaveBeenCalled();
    expect(repo.row('7')!.status).toBe('void');
  });

  it('darvoza qulf ostida ham: tezkor tekshiruvdan keyin holat o‘zgarsa — claim yo‘q, void + 409', async () => {
    const { svc, repo, manager, executed } = makeService([pending()]);
    // Tezkor (qulfsiz) darvoza o'tadi, keyin — sotuv tranzaksiyasigacha — o'zgaradi.
    const qb = manager.tracking.qb;
    qb.getRawOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ to_status: Order_status.CANCELLED });
    expect(
      (await errorOf(svc.approveExtraCostApproval(market, '7'))).statusCode,
    ).toBe(409);
    expect(executed).toHaveLength(0);
    expect(repo.row('7')).toEqual(
      expect.objectContaining({
        status: 'void',
        closed_reason:
          "so'rov ochilgandan keyin buyurtma holati o'zgargan (cancelled)",
      }),
    );
  });

  it('avtomatik tasdiq darvozadan o‘tmasa — void, yopuvchi NULL (tizim)', async () => {
    const { svc, repo, order } = makeService([pending()]);
    order.status = Order_status.CANCELLED;
    await expect(
      svc.approveExtraCostApproval(null, '7', undefined, { auto: true }),
    ).rejects.toBeInstanceOf(RpcException);
    expect(repo.row('7')).toEqual(
      expect.objectContaining({ status: 'void', closed_by_user_id: null }),
    );
  });

  it('⭐ rad etish sababi — yopiq ro‘yxat: noto‘g‘ri → 400; to‘g‘ri → reject_reason + izoh', async () => {
    const bad = makeService([pending()]);
    expect(
      (
        await errorOf(
          bad.svc.rejectExtraCostApproval(market, '7', {
            reason: 'I_DONT_LIKE',
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(bad.repo.row('7')!.status).toBe('pending');
    const ok = makeService([pending()]);
    await ok.svc.rejectExtraCostApproval(market, '7', {
      reason: ExtraCostRejectReason.NO_PROOF,
      comment: 'rasm xira',
    });
    expect(ok.repo.row('7')).toEqual(
      expect.objectContaining({
        status: 'rejected',
        reject_reason: 'NO_PROOF',
        decision_comment: 'Isbot yetarli emas — rasm xira',
      }),
    );
  });

  it('market operatori qaror qila olmaydi — 403 (faqat market egasi)', async () => {
    const { svc } = makeService([pending()]);
    expect(
      (
        await errorOf(
          svc.approveExtraCostApproval(
            { id: '40', roles: ['market_operator'] },
            '7',
          ),
        )
      ).statusCode,
    ).toBe(403);
  });
});

describe('DuST9k8j — so‘rov yaratilganda market egasiga xabar', () => {
  const callNotify = (svc: OrderLifecycleService, approval: Row) =>
    (
      svc as unknown as {
        notifyExtraCostRequested: (a: Row, o: Row) => Promise<void>;
      }
    ).notifyExtraCostRequested(approval, {
      id: '7001',
      total_price: '250000.00',
    });

  it('⭐ extra_cost.requested → notification.dispatch (outbox): egaga, Telegram, tugmalar va isbot fayllari', async () => {
    const { svc, outbox } = makeService([]);
    await callNotify(svc, pending({ proof_file_keys: ['proof-1', 'proof-2'] }));
    expect(outbox.enqueue).toHaveBeenCalledWith(
      'NOTIFICATION',
      'notification.dispatch',
      expect.objectContaining({
        type: 'order.extra_cost_requested',
        recipient_id: '501',
        channels: ['in_app', 'realtime', 'telegram'],
        body: expect.stringContaining("Summa: 12 000 so'm"),
        data: expect.objectContaining({
          approval_id: '7',
          telegram_media: ['proof-1', 'proof-2'],
          telegram_buttons: [
            [
              expect.objectContaining({
                text: '✅ Tasdiqlash',
                action: 'ec.ok',
                payload: { approval_id: '7' },
              }),
              expect.objectContaining({
                text: '❌ Rad etish',
                action: 'ec.no',
              }),
            ],
          ],
        }),
      }),
    );
  });

  it('⭐ yuborib bo‘lmasa (outbox xato) — xato otilmaydi, kuryer oqimi 202 bilan davom etadi', async () => {
    const { svc, outbox } = makeService([]);
    outbox.enqueue.mockRejectedValueOnce(new Error('rmq down'));
    await expect(callNotify(svc, pending())).resolves.toBeUndefined();
  });
});

describe('1tnpaIqd — ega qarori: muddat o‘tsa avtomatik tasdiq', () => {
  const now = new Date('2026-10-16T11:00:00Z');

  it('⭐ muddati o‘tgan — avtomatik tasdiq: decided_by NULL, auto_approved, sabab, audit, marketga xabar', async () => {
    const { svc, repo, sellOrder, activityLog, outbox } = makeService([
      pending({ id: '7', createdAt: new Date('2026-10-16T10:00:00Z') }),
      // Boshqa buyurtma: bitta buyurtmada bittadan ortiq ochiq so'rov yo'q (hwTkXsGi).
      pending({
        id: '8',
        order_id: '7002',
        createdAt: new Date('2026-10-16T10:55:00Z'),
      }),
    ]);
    const stats = await svc.runExtraCostAutoApproval({
      minutes: 30,
      reminderMinutes: 10,
      now,
    });
    expect(stats.approved).toBe(1);
    expect(repo.row('7')).toEqual(
      expect.objectContaining({
        status: 'approved',
        decided_by_user_id: null,
        auto_approved: true,
        decision_comment: expect.stringContaining('avtomatik'),
      }),
    );
    expect(repo.row('8')!.status).toBe('pending');
    expect(sellOrder).toHaveBeenCalledTimes(1);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'order.extra_cost_auto_approved',
        entity_id: '7001',
      }),
    );
    expect(outbox.enqueue).toHaveBeenCalledWith(
      'NOTIFICATION',
      'notification.dispatch',
      expect.objectContaining({
        type: 'order.extra_cost_auto_approved',
        recipient_id: '501',
      }),
    );
  });

  it('⭐ avtomatik tasdiqdan 10 daqiqa oldin — oxirgi eslatma BIR marta', async () => {
    const { svc, repo, outbox } = makeService([
      pending({ id: '9', createdAt: new Date('2026-10-16T10:39:00Z') }),
    ]);
    const first = await svc.runExtraCostAutoApproval({
      minutes: 30,
      reminderMinutes: 10,
      now,
    });
    const second = await svc.runExtraCostAutoApproval({
      minutes: 30,
      reminderMinutes: 10,
      now,
    });
    expect(first.reminded).toBe(1);
    expect(second.reminded).toBe(0);
    expect(repo.row('9')!.reminder_sent_at).toEqual(now);
    expect(
      outbox.enqueue.mock.calls.filter(
        ([, , payload]) => payload.type === 'order.extra_cost_reminder',
      ),
    ).toHaveLength(1);
  });

  it('⭐ (AFZaUUi5) scheduler: env berilmasa yoki bo‘sh — 1440 daqiqa (24 soat); env qiymati — o‘sha', async () => {
    const stats = { reminded: 0, approved: 0, failed: 0, deferred: 0 };
    const tick = async (env: Record<string, unknown>) => {
      const lifecycle = {
        runExtraCostAutoApproval: jest.fn().mockResolvedValue(stats),
      };
      await new ExtraCostAutoApproveScheduler(
        lifecycle as never,
        { get: (key: string) => env[key] } as never,
      ).tick();
      return lifecycle.runExtraCostAutoApproval;
    };

    expect(await tick({})).toHaveBeenCalledWith({
      minutes: 1440,
      reminderMinutes: 10,
    });
    expect(
      await tick({ EXTRA_COST_AUTO_APPROVE_MINUTES: '' }),
    ).toHaveBeenCalledWith({ minutes: 1440, reminderMinutes: 10 });
    // Joi sukuti ConfigService'dan son bo'lib keladi.
    expect(
      await tick({ EXTRA_COST_AUTO_APPROVE_MINUTES: 1440 }),
    ).toHaveBeenCalledWith({ minutes: 1440, reminderMinutes: 10 });
    expect(
      await tick({ EXTRA_COST_AUTO_APPROVE_MINUTES: '45' }),
    ).toHaveBeenCalledWith({ minutes: 45, reminderMinutes: 10 });
    expect(
      await tick({
        EXTRA_COST_AUTO_APPROVE_MINUTES: '60',
        EXTRA_COST_AUTO_APPROVE_REMINDER_MINUTES: '5',
      }),
    ).toHaveBeenCalledWith({ minutes: 60, reminderMinutes: 5 });
  });

  it('(AFZaUUi5) scheduler env bo‘sh bo‘lsa ham ishga tushadi (interval)', () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const scheduler = new ExtraCostAutoApproveScheduler(
      { runExtraCostAutoApproval: jest.fn() } as never,
      { get: () => undefined } as never,
    );
    try {
      scheduler.onModuleInit();
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    } finally {
      scheduler.onModuleDestroy();
      setIntervalSpy.mockRestore();
    }
  });
});

describe('AFZaUUi5 — market 24 soatda javob bermasa avtomatik tasdiq', () => {
  const DAY = 1440;
  const now = new Date('2026-11-06T12:00:00Z');
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000);
  const run = (svc: OrderLifecycleService, at: Date = now, limit?: number) =>
    svc.runExtraCostAutoApproval({
      minutes: DAY,
      reminderMinutes: 10,
      now: at,
      limit,
    });

  it('⭐ TC1: javobsiz 24 soat — avtomatik tasdiq: auto_approved, sotuv BIR marta; 24 soat to‘lmagan — kutadi', async () => {
    const { svc, repo, sellOrder } = makeService([
      pending({ id: '7', createdAt: minutesAgo(DAY + 1) }),
      pending({ id: '8', order_id: '7002', createdAt: minutesAgo(DAY - 60) }),
    ]);

    const stats = await run(svc);

    expect(stats).toMatchObject({ approved: 1, failed: 0, deferred: 0 });
    expect(repo.row('7')).toMatchObject({
      status: 'approved',
      auto_approved: true,
      decided_by_user_id: null,
    });
    expect(repo.row('8')!.status).toBe('pending');
    expect(sellOrder).toHaveBeenCalledTimes(1);
    // Qayta ijro — so'rov yozgan kuryer nomidan, tasdiqlangan xarajat bilan.
    expect(sellOrder).toHaveBeenCalledWith(
      { id: '301', roles: ['courier'], branch_id: '77' },
      '7001',
      expect.objectContaining({ extraCost: 12000, extraCostApproved: true }),
      'extra-cost-approval:7',
      {
        extraCostApproval: expect.objectContaining({
          id: '7',
          patch: expect.objectContaining({
            decided_by_user_id: null,
            auto_approved: true,
          }),
        }),
      },
    );
    expect(await run(svc)).toMatchObject({ approved: 0 });
    expect(sellOrder).toHaveBeenCalledTimes(1);
  });

  it('⭐ TC2: tasdiqdan 10 daqiqa oldin marketga BITTA eslatma', async () => {
    const { svc, repo, outbox } = makeService([
      pending({ id: '9', createdAt: minutesAgo(DAY - 9) }),
    ]);

    expect((await run(svc)).reminded).toBe(1);
    expect((await run(svc)).reminded).toBe(0);
    expect(repo.row('9')!.status).toBe('pending');
    const reminders = outbox.enqueue.mock.calls.filter(
      ([, , payload]) => payload.type === 'order.extra_cost_reminder',
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0][2]).toMatchObject({ recipient_id: '501' });
  });

  it('⭐ TC3/TC6: market qaror qilgan yoki so‘rov yopilgan (approved / rejected / void / reversed) — avtomatik tasdiq tegmaydi', async () => {
    const old = minutesAgo(3 * DAY);
    const { svc, repo, sellOrder } = makeService([
      pending({ id: '11', status: 'approved', createdAt: old }),
      pending({
        id: '12',
        order_id: '7012',
        status: 'rejected',
        createdAt: old,
      }),
      pending({ id: '13', order_id: '7013', status: 'void', createdAt: old }),
      pending({
        id: '14',
        order_id: '7014',
        status: 'reversed',
        createdAt: old,
      }),
    ]);

    expect(await run(svc)).toEqual({
      reminded: 0,
      approved: 0,
      failed: 0,
      deferred: 0,
    });
    expect(sellOrder).not.toHaveBeenCalled();
    expect(repo.updates.filter((update) => update.ids.length)).toEqual([]);
  });

  it('⭐ TC5: yoqilgan paytda ochiq turgan 3 kunlik so‘rov darhol tasdiqlanmaydi — muddat skaner birinchi ko‘rgan paytdan (eslatma 10 daqiqa oldin)', async () => {
    const { svc, repo, sellOrder } = makeService([
      pending({
        id: '15',
        createdAt: minutesAgo(3 * DAY),
        auto_approve_from: null,
        // Eski kod (1tnpaIqd, env bilan) yuborgan eslatma — qaytadan yuboriladi.
        reminder_sent_at: minutesAgo(2 * DAY),
      }),
    ]);

    expect(await run(svc)).toMatchObject({ approved: 0, reminded: 0 });
    expect(sellOrder).not.toHaveBeenCalled();
    expect(repo.row('15')).toMatchObject({
      status: 'pending',
      auto_approve_from: now,
      reminder_sent_at: null,
    });

    // Keyingi tiklarda muddat boshi qayta belgilanmaydi.
    const later = new Date(now.getTime() + 60_000);
    await run(svc, later);
    expect(repo.row('15')!.auto_approve_from).toEqual(now);

    const reminderTime = new Date(now.getTime() + (DAY - 9) * 60_000);
    expect((await run(svc, reminderTime)).reminded).toBe(1);
    expect(repo.row('15')!.status).toBe('pending');

    const due = new Date(now.getTime() + DAY * 60_000);
    expect((await run(svc, due)).approved).toBe(1);
    expect(repo.row('15')).toMatchObject({
      status: 'approved',
      auto_approved: true,
    });
  });

  it('⭐ TC4/TC5: yoqilgan paytda 24 soatdan yosh ochiq so‘rov — muddat so‘rov vaqtidan (yoqilgan paytdan emas)', async () => {
    const { svc, repo, sellOrder } = makeService([
      pending({
        id: '18',
        createdAt: minutesAgo(DAY - 5),
        auto_approve_from: null,
      }),
      pending({
        id: '19',
        order_id: '7019',
        createdAt: minutesAgo(120),
        auto_approve_from: null,
      }),
    ]);

    // 5 daqiqa qolgan: eslatma hozir, muddat so'rov vaqtidan.
    expect(await run(svc)).toMatchObject({ reminded: 1, approved: 0 });
    expect(repo.row('18')).toMatchObject({
      auto_approve_from: minutesAgo(DAY - 5),
      reminder_sent_at: now,
    });
    expect(repo.row('19')!.auto_approve_from).toEqual(minutesAgo(120));

    const due = new Date(now.getTime() + 5 * 60_000);
    expect(await run(svc, due)).toMatchObject({ approved: 1 });
    expect(repo.row('18')).toMatchObject({
      status: 'approved',
      auto_approved: true,
    });
    expect(repo.row('19')!.status).toBe('pending');
    expect(sellOrder).toHaveBeenCalledTimes(1);
  });

  it('⭐ TC7: biznes xatosi (buyurtma o‘zgargan) — so‘rov void, keyingi daqiqalarda qayta urinilmaydi', async () => {
    const { svc, repo, order, sellOrder } = makeService([
      pending({ id: '16', createdAt: minutesAgo(DAY + 5) }),
    ]);
    order.status = Order_status.SOLD;

    expect(await run(svc)).toMatchObject({
      approved: 0,
      failed: 1,
      deferred: 0,
    });
    expect(repo.row('16')).toMatchObject({
      status: 'void',
      closed_reason: expect.stringContaining('kutilmoqda'),
    });

    const later = new Date(now.getTime() + 60_000);
    expect(await run(svc, later)).toEqual({
      reminded: 0,
      approved: 0,
      failed: 0,
      deferred: 0,
    });
    expect(sellOrder).not.toHaveBeenCalled();
  });

  it('⭐ infratuzilma xatosi — so‘rov pending, keyingi urinish 15 → 30 daqiqadan keyin (har daqiqa emas)', async () => {
    const { svc, repo, failures, sellOrder } = makeService([
      pending({ id: '17', createdAt: minutesAgo(DAY + 5) }),
    ]);
    failures.push(new Error('Timeout has occurred'));

    expect(await run(svc)).toMatchObject({ approved: 0, deferred: 1 });
    expect(repo.row('17')).toMatchObject({
      status: 'pending',
      auto_attempts: 1,
      auto_retry_at: new Date(now.getTime() + 15 * 60_000),
    });
    expect(sellOrder).toHaveBeenCalledTimes(1);

    // Keyingi daqiqalarda — urinilmaydi.
    for (const minutes of [1, 2, 14]) {
      await run(svc, new Date(now.getTime() + minutes * 60_000));
    }
    expect(sellOrder).toHaveBeenCalledTimes(1);

    // 15 daqiqadan keyin — yana; yana xato — 30 daqiqa.
    const second = new Date(now.getTime() + 15 * 60_000);
    failures.push(new Error('Timeout has occurred'));
    expect(await run(svc, second)).toMatchObject({ deferred: 1 });
    expect(sellOrder).toHaveBeenCalledTimes(2);
    expect(repo.row('17')).toMatchObject({
      auto_attempts: 2,
      auto_retry_at: new Date(second.getTime() + 30 * 60_000),
    });

    // Navbat kelganda xato bo'lmasa — tasdiqlanadi.
    const third = new Date(second.getTime() + 30 * 60_000);
    expect(await run(svc, third)).toMatchObject({ approved: 1 });
    expect(repo.row('17')).toMatchObject({
      status: 'approved',
      auto_approved: true,
    });
  });

  it('kechiktirish xato bo‘lgan paytdan sanaladi (uzun tikda tik boshidan emas)', async () => {
    const tickStart = new Date('2026-11-06T12:00:00Z');
    jest.useFakeTimers({
      now: tickStart,
      doNotFake: ['setImmediate', 'setTimeout', 'nextTick', 'queueMicrotask'],
    });
    try {
      const { svc, repo } = makeService([
        pending({ id: '20', createdAt: minutesAgo(DAY + 5) }),
      ]);
      // Urinish 20 daqiqa davom etib, timeout bilan tugadi.
      jest.spyOn(svc, 'approveExtraCostApproval').mockImplementation(() => {
        jest.setSystemTime(new Date(tickStart.getTime() + 20 * 60_000));
        return Promise.reject(new Error('Timeout has occurred'));
      });

      expect(
        await svc.runExtraCostAutoApproval({
          minutes: DAY,
          reminderMinutes: 10,
        }),
      ).toMatchObject({ deferred: 1 });
      expect(repo.row('20')!.auto_retry_at).toEqual(
        new Date(tickStart.getTime() + 35 * 60_000),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('kechiktirilgan so‘rovlar navbat boshini egallamaydi (take limit)', async () => {
    const { svc, repo } = makeService([
      pending({
        id: '18',
        createdAt: minutesAgo(5 * DAY),
        auto_attempts: 3,
        auto_retry_at: new Date(now.getTime() + 60 * 60_000),
      }),
      pending({ id: '19', order_id: '7019', createdAt: minutesAgo(DAY + 1) }),
    ]);

    expect(await run(svc, now, 1)).toMatchObject({ approved: 1 });
    expect(repo.row('18')!.status).toBe('pending');
    expect(repo.row('19')!.status).toBe('approved');
  });

  it('kechiktirish oralig‘i 360 daqiqadan oshmaydi', async () => {
    const { svc, repo, failures } = makeService([
      pending({
        id: '20',
        createdAt: minutesAgo(10 * DAY),
        auto_attempts: 9,
      }),
    ]);
    failures.push(new Error('Timeout has occurred'));

    await run(svc);

    expect(repo.row('20')).toMatchObject({
      auto_attempts: 10,
      auto_retry_at: new Date(now.getTime() + 360 * 60_000),
    });
  });

  it('⭐ TC8: boshqa muddat (60 daqiqa) — o‘sha ishlatiladi', async () => {
    const { svc, repo } = makeService([
      pending({ id: '21', createdAt: minutesAgo(61) }),
      pending({ id: '22', order_id: '7022', createdAt: minutesAgo(59) }),
    ]);

    await svc.runExtraCostAutoApproval({
      minutes: 60,
      reminderMinutes: 10,
      now,
    });

    expect(repo.row('21')!.status).toBe('approved');
    expect(repo.row('22')!.status).toBe('pending');
  });
});
