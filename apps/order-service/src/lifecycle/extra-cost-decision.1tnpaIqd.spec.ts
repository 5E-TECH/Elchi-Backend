import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ExtraCostRejectReason, Order_status } from '@app/common';
import {
  ExtraCostExecutionOptions,
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
  const svc = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService;
  Object.assign(svc, {
    extraCostApprovalRepo: repo,
    orderRepo,
    dataSource: { manager },
    outbox,
    activityLog,
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

  it('scheduler: EXTRA_COST_AUTO_APPROVE_MINUTES berilmasa — o‘chiq (kodga qotirilmagan)', async () => {
    const lifecycle = { runExtraCostAutoApproval: jest.fn() };
    const off = new ExtraCostAutoApproveScheduler(
      lifecycle as never,
      { get: () => undefined } as never,
    );
    await off.tick();
    expect(lifecycle.runExtraCostAutoApproval).not.toHaveBeenCalled();
    const on = new ExtraCostAutoApproveScheduler(
      lifecycle as never,
      {
        get: (key: string) => ({ EXTRA_COST_AUTO_APPROVE_MINUTES: '45' })[key],
      } as never,
    );
    lifecycle.runExtraCostAutoApproval.mockResolvedValue({
      reminded: 0,
      approved: 0,
      failed: 0,
    });
    await on.tick();
    expect(lifecycle.runExtraCostAutoApproval).toHaveBeenCalledWith({
      minutes: 45,
      reminderMinutes: 10,
    });
  });
});
