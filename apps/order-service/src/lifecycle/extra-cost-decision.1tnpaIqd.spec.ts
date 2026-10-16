import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ExtraCostRejectReason } from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';
import { ExtraCostAutoApproveScheduler } from './extra-cost-auto-approve.scheduler';

/**
 * 1tnpaIqd + DuST9k8j (order-service tomoni):
 *  - qaror ATOMIK shartli UPDATE: ikki parallel approve (yoki approve +
 *    reject) — faqat bittasi; biznes amali faqat claim'dan keyin, BIR marta;
 *  - biznes amali xato bersa — so'rov `pending` ga qaytadi;
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

/** Xotiradagi jadval: shartli UPDATE'lar haqiqiy "status = pending" semantikasi bilan. */
function makeRepo(rows: Row[]) {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const repo = {
    rows: byId,
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        byId.has(String(where.id)) ? { ...byId.get(String(where.id)) } : null,
      ),
    ),
    createQueryBuilder: jest.fn(() => {
      let patch: Row = {};
      let params: Row = {};
      let sql = '';
      const filters: Array<(row: Row) => boolean> = [];
      const qb: Record<string, any> = {
        update: () => qb,
        set: (value: Row) => ((patch = value), qb),
        where: (clause: string, p: Row) => (
          (sql = clause),
          (params = p ?? {}),
          qb
        ),
        andWhere: (clause: string, p: Row) => {
          if (clause.includes('reminder_sent_at IS NULL'))
            filters.push((r) => !r.reminder_sent_at);
          if (clause.includes(':reminderAt')) {
            filters.push(
              (r) => r.createdAt <= p.reminderAt && r.createdAt > p.deadline,
            );
          } else if (clause.includes(':deadline')) {
            filters.push((r) => r.createdAt <= p.deadline);
          }
          return qb;
        },
        orderBy: () => qb,
        take: () => qb,
        returning: () => qb,
        getMany: () =>
          Promise.resolve(
            [...byId.values()].filter(
              (row) => row.status === 'pending' && filters.every((f) => f(row)),
            ),
          ),
        execute: () => {
          const row = byId.get(String(params.id));
          let ok = Boolean(row);
          if (ok && sql.includes('status = :pending'))
            ok = row!.status === 'pending';
          if (ok && sql.includes('reminder_sent_at IS NULL'))
            ok = !row!.reminder_sent_at;
          if (ok && sql.includes('decided_at = :decidedAt')) {
            ok =
              row!.status === params.status &&
              row!.decided_at === params.decidedAt;
          }
          if (ok) Object.assign(row!, patch);
          return Promise.resolve({ affected: ok ? 1 : 0 });
        },
      };
      return qb;
    }),
  };
  return repo;
}

function makeService(rows: Row[]) {
  const repo = makeRepo(rows);
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService;
  Object.assign(svc, {
    extraCostApprovalRepo: repo,
    outbox,
    activityLog,
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
  });
  const sellOrder = jest
    .spyOn(svc, 'sellOrder')
    .mockImplementation(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return { statusCode: 200, message: 'Order sold', data: {} } as never;
    });
  const cancelOrder = jest
    .spyOn(svc, 'cancelOrder')
    .mockResolvedValue({ statusCode: 200, message: 'ok', data: {} } as never);
  return { svc, repo, outbox, activityLog, sellOrder, cancelOrder };
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

describe('1tnpaIqd — atomik qaror', () => {
  it('⭐ ikki parallel approve — biri 200, ikkinchisi "allaqachon yakunlangan", sellOrder BIR marta', async () => {
    const { svc, sellOrder, repo } = makeService([pending()]);
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
    expect((failed.error.getError() as { message: string }).message).toBe(
      "Bu so'rov allaqachon yakunlangan",
    );
    expect(sellOrder).toHaveBeenCalledTimes(1);
    expect(repo.rows.get('7')!.status).toBe('approved');
  });

  it('⭐ approve + reject bir vaqtda — faqat bittasi o‘tadi, status aralashmaydi', async () => {
    const { svc, sellOrder, repo } = makeService([pending()]);
    const outcomes = await Promise.allSettled([
      svc.approveExtraCostApproval(market, '7'),
      svc.rejectExtraCostApproval(market, '7', {
        reason: ExtraCostRejectReason.TOO_EXPENSIVE,
      }),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const status = repo.rows.get('7')!.status;
    expect(['approved', 'rejected']).toContain(status);
    expect(sellOrder).toHaveBeenCalledTimes(status === 'approved' ? 1 : 0);
  });

  it('⭐ yakunlangan so‘rovga qayta qaror — 400, DB o‘zgarmaydi, biznes amali yo‘q', async () => {
    const { svc, sellOrder, repo } = makeService([
      pending({ status: 'rejected', decision_comment: 'x' }),
    ]);
    expect(await errorOf(svc.approveExtraCostApproval(market, '7'))).toEqual({
      statusCode: 400,
      message: "Bu so'rov allaqachon yakunlangan",
    });
    expect(sellOrder).not.toHaveBeenCalled();
    expect(repo.rows.get('7')!.status).toBe('rejected');
  });

  it('biznes amali xato bersa — so‘rov pending ga qaytadi (qayta urinish mumkin)', async () => {
    const { svc, sellOrder, repo } = makeService([pending()]);
    sellOrder.mockRejectedValueOnce(
      new RpcException({ statusCode: 400, message: 'boom' }),
    );
    await expect(
      svc.approveExtraCostApproval(market, '7'),
    ).rejects.toBeInstanceOf(RpcException);
    expect(repo.rows.get('7')!.status).toBe('pending');
    expect(repo.rows.get('7')!.decided_at).toBeNull();
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
    expect(bad.repo.rows.get('7')!.status).toBe('pending');
    const ok = makeService([pending()]);
    await ok.svc.rejectExtraCostApproval(market, '7', {
      reason: ExtraCostRejectReason.NO_PROOF,
      comment: 'rasm xira',
    });
    expect(ok.repo.rows.get('7')).toEqual(
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
      pending({ id: '8', createdAt: new Date('2026-10-16T10:55:00Z') }),
    ]);
    const stats = await svc.runExtraCostAutoApproval({
      minutes: 30,
      reminderMinutes: 10,
      now,
    });
    expect(stats.approved).toBe(1);
    expect(repo.rows.get('7')).toEqual(
      expect.objectContaining({
        status: 'approved',
        decided_by_user_id: null,
        auto_approved: true,
        decision_comment: expect.stringContaining('avtomatik'),
      }),
    );
    expect(repo.rows.get('8')!.status).toBe('pending');
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
    expect(repo.rows.get('9')!.reminder_sent_at).toEqual(now);
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
