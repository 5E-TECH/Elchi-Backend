import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { FinanceServiceService } from './finance-service.service';
import {
  SETTLEMENT_UNAPPLIED_RECORDED_PATTERN,
  SettlementUnappliedService,
} from './settlement/settlement-unapplied.service';
import { SettlementUnappliedController } from './settlement/settlement-unapplied.controller';

/**
 * znD3KaZL TC2 (finance) — advance javobidagi FIFO qoldig'i (`leftover` > 0)
 * `finance_settlement_unapplied` ga (actor_id, level, amount, dedup_epoch)
 * yoziladi. Ikki yo'l, ikkalasi idempotent (`ON CONFLICT DO NOTHING`):
 *   • tezkor — finance `tryPublishAdvanceNow` javobni o'qiganda;
 *   • sekin — order-service FIFO tranzaksiyasi ichida outbox orqali
 *     yuboradigan `finance.settlement.unapplied_recorded` hodisasi (relay
 *     javobni ko'rmaydi, shuning uchun kafolat shu yerda).
 * Kassa harakatlari bu yozuvga bog'liq emas.
 */

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common/time/tashkent-time'),
  ...jest.requireActual('@app/common/activity-log/describe-uz'),
  Cashbox_type: {
    MAIN: 'main',
    FOR_COURIER: 'couriers',
    FOR_MARKET: 'markets',
    BRANCH: 'branch',
  },
  Operation_type: { INCOME: 'income', EXPENSE: 'expense' },
  Source_type: {
    COURIER_PAYMENT: 'courier_payment',
    BRANCH_TO_MAIN: 'branch_to_main',
    MARKET_PAYMENT: 'market_payment',
    MANUAL_EXPENSE: 'manual_expense',
    MANUAL_INCOME: 'manual_income',
    CORRECTION: 'correction',
    SALARY: 'salary',
    SELL: 'sell',
    CANCEL: 'cancel',
    EXTRA_COST: 'extra_cost',
    BILLS: 'bills',
  },
  FinancialSource_type: { SELL_PROFIT: 'sell_profit' },
  Order_status: {
    SOLD: 'sold',
    PAID: 'paid',
    PARTLY_PAID: 'partly_paid',
    WAITING: 'waiting',
  },
  PaymentMethod: {
    CASH: 'cash',
    CLICK: 'click',
    CLICK_TO_MARKET: 'click_to_market',
  },
  Commission_type: { PERCENT: 'percent', FIXED: 'fixed' },
  ActivityAction: {
    CREATED: 'created',
    DELETED: 'deleted',
    UPDATED: 'updated',
    PAYMENT: 'payment',
    STATUS_CHANGE: 'status_change',
  },
  ActivityLogService: class {},
  numericTransformer: jest.requireActual(
    '@app/common/database/numeric.transformer',
  ).numericTransformer,
  RmqService: class {},
  // Controller'ning ack yordamchisi — handlerni o'zgarishsiz ishga tushiradi.
  executeAndAck: (_rmq: unknown, _ctx: unknown, handler: () => unknown) =>
    handler(),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

jest.mock('./entities/cashbox.entity', () => ({ Cashbox: class Cashbox {} }));
jest.mock('./entities/cashbox-history.entity', () => ({
  CashboxHistory: class CashboxHistory {},
}));
jest.mock('./entities/shift.entity', () => ({
  Shift: class Shift {},
  ShiftStatus: { OPEN: 'open', CLOSED: 'closed' },
}));
jest.mock('./entities/user-salary.entity', () => ({
  UserSalary: class UserSalary {},
}));
jest.mock('./entities/operator-earning.entity', () => ({
  OperatorEarning: class OperatorEarning {},
}));
jest.mock('./entities/operator-payment.entity', () => ({
  OperatorPayment: class OperatorPayment {},
}));
jest.mock('./entities/financial-balance-history.entity', () => ({
  FinancialBalanceHistory: class FinancialBalanceHistory {},
}));

type Saved = Record<string, unknown>;
type UnappliedRow = {
  id: string;
  level: string;
  actor_id: string;
  amount: number;
  dedup_epoch: string;
};

/**
 * `finance_settlement_unapplied` xotirada: `(level, actor_id, dedup_epoch)`
 * UNIQUE, `orIgnore()` = `ON CONFLICT DO NOTHING` (RETURNING bo'sh).
 */
function makeUnappliedRepo() {
  const rows: UnappliedRow[] = [];
  const failures: Error[] = [];
  const repo = {
    createQueryBuilder: jest.fn(() => {
      let values: Record<string, unknown> = {};
      let ignore = false;
      const qb = {
        insert: () => qb,
        values: (v: Record<string, unknown>) => {
          values = v;
          return qb;
        },
        orIgnore: () => {
          ignore = true;
          return qb;
        },
        updateEntity: () => qb,
        returning: () => qb,
        execute: () => {
          const failure = failures.shift();
          if (failure) {
            return Promise.reject(failure);
          }
          const duplicate = rows.some(
            (row) =>
              row.level === values.level &&
              row.actor_id === values.actor_id &&
              row.dedup_epoch === values.dedup_epoch,
          );
          if (duplicate) {
            return ignore
              ? Promise.resolve({ raw: [], identifiers: [] })
              : Promise.reject(new Error('duplicate key (23505)'));
          }
          const row = {
            id: String(rows.length + 1),
            ...values,
          } as UnappliedRow;
          rows.push(row);
          return Promise.resolve({
            raw: [{ id: row.id }],
            identifiers: [{ id: row.id }],
          });
        },
      };
      return qb;
    }),
  };
  return { repo, rows, failNext: (error: Error) => failures.push(error) };
}

function makeService(opts: { recorder?: boolean } = {}) {
  const unapplied = makeUnappliedRepo();
  const recorder = new SettlementUnappliedService(unapplied.repo as never);
  const manager = {
    findOne: jest.fn(),
    save: jest.fn((entity: Saved) => Promise.resolve(entity)),
    create: jest.fn((_entity: unknown, dto: Saved) => ({ ...dto })),
  };
  const queryRunner = {
    manager,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };
  const cashboxRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((dto: Saved) => dto),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(),
  };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const orderClient = {
    send: jest.fn(() => of({ statusCode: 200 })),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const service = new FinanceServiceService(
    cashboxRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    dataSource as never,
    activityLog as never,
    orderClient as never,
    { send: jest.fn() } as never,
    { send: jest.fn() } as never,
    outbox as never,
    undefined,
    opts.recorder === false ? undefined : recorder,
  );
  return {
    service,
    recorder,
    unapplied,
    manager,
    orderClient,
    outbox,
    queryRunner,
  };
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  rmqSendMock.mockReset();
  rmqSendMock.mockResolvedValue(undefined);
  warnSpy = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const warnings = (needle: string) =>
  warnSpy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((msg: string) => msg.includes(needle));

/** order-service outbox'i yuboradigan hodisa (FIFO tranzaksiyasi ichida). */
const orderEvent = (extra: Record<string, unknown> = {}) => ({
  level: 'courier_to_branch',
  actor_id: '7',
  amount: 250_000,
  dedup_epoch: 'tok-1',
  lump_sum: 550_000,
  allocated: 300_000,
  carry_persisted: true,
  settled_count: 2,
  // OutboxService.enqueue o'zi qo'shadi.
  request_id: 'b6f1c2d0-0000-4000-8000-000000000001',
  ...extra,
});

const advanceReply = (data: Record<string, unknown>) =>
  of({ statusCode: 200, message: 'Settlement advanced', data });

describe('znD3KaZL TC2 (finance) — sekin yo`l: outbox hodisasi `finance.settlement.unapplied_recorded`', () => {
  it('pattern order-service bilan AYNAN bir xil; handler shu patternga ulangan', () => {
    expect(SETTLEMENT_UNAPPLIED_RECORDED_PATTERN).toBe(
      'finance.settlement.unapplied_recorded',
    );
    const pattern = Reflect.getMetadata(
      'microservices:pattern',
      Reflect.get(
        SettlementUnappliedController.prototype,
        'unappliedRecorded',
      ) as object,
    );
    expect(pattern).toEqual([{ cmd: 'finance.settlement.unapplied_recorded' }]);
  });

  it('⭐ leftover > 0 → unapplied yozuvi (actor_id, level, amount, dedup_epoch) + WARN log', async () => {
    const env = makeService();
    const controller = new SettlementUnappliedController(
      {} as never,
      env.recorder,
    );

    const res = await controller.unappliedRecorded(
      orderEvent() as never,
      {} as never,
    );

    expect(res).toMatchObject({
      statusCode: 200,
      data: { recorded: true, duplicate: false, skipped_reason: null },
    });
    expect(env.unapplied.rows).toEqual([
      {
        id: '1',
        level: 'courier_to_branch',
        actor_id: '7',
        amount: 250_000,
        dedup_epoch: 'tok-1',
      },
    ]);
    const logs = warnings("FIFO qoldig'i (znD3KaZL, outbox)");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('level=courier_to_branch');
    expect(logs[0]).toContain('match=7');
    expect(logs[0]).toContain('leftover=250000');
    expect(logs[0]).toContain('allocated=300000');
    expect(logs[0]).toContain('finance_settlement_unapplied ga yozildi');
  });

  it('⭐ takroriy hodisa (outbox qayta yetkazdi) → dublikat YO`Q, ikkinchi WARN yo`q', async () => {
    const env = makeService();

    await env.recorder.handleRecordedEvent(orderEvent());
    const again = await env.recorder.handleRecordedEvent(
      orderEvent({ request_id: 'other-delivery' }),
    );

    expect(again.data).toEqual({
      recorded: false,
      duplicate: true,
      skipped_reason: null,
    });
    expect(env.unapplied.rows).toHaveLength(1);
    expect(warnings("FIFO qoldig'i (znD3KaZL, outbox)")).toHaveLength(1);
  });

  it('boshqa to`lov tokeni / boshqa bo`g`in / boshqa tomon — alohida qatorlar', async () => {
    const env = makeService();

    await env.recorder.handleRecordedEvent(orderEvent());
    await env.recorder.handleRecordedEvent(
      orderEvent({ dedup_epoch: 'tok-2' }),
    );
    await env.recorder.handleRecordedEvent(
      orderEvent({
        level: 'hq_to_market',
        actor_id: '191',
        dedup_epoch: 'tok-1:m',
      }),
    );
    await env.recorder.handleRecordedEvent(orderEvent({ actor_id: '8' }));

    expect(
      env.unapplied.rows.map((r) => [r.level, r.actor_id, r.dedup_epoch]),
    ).toEqual([
      ['courier_to_branch', '7', 'tok-1'],
      ['courier_to_branch', '7', 'tok-2'],
      ['hq_to_market', '191', 'tok-1:m'],
      ['courier_to_branch', '8', 'tok-1'],
    ]);
  });

  it('leftover = 0 (yoki manfiy / son emas) → yozuv yo`q, xato yo`q', async () => {
    const env = makeService();

    for (const amount of [0, -5, 'x', null, 0.004]) {
      const res = await env.recorder.handleRecordedEvent(
        orderEvent({ amount }),
      );
      expect(res.data).toEqual({
        recorded: false,
        duplicate: false,
        skipped_reason: 'no_leftover',
      });
    }
    expect(env.unapplied.rows).toHaveLength(0);
    expect(env.unapplied.repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('noto`g`ri hodisa — e`tiborsiz (ack, 200): `finance.*` doimiy pattern, aks holda abadiy qayta urilardi', async () => {
    const env = makeService();

    for (const bad of [
      orderEvent({ level: 'branch' }),
      orderEvent({ actor_id: 'abc' }),
      orderEvent({ actor_id: '' }),
      orderEvent({ dedup_epoch: '  ' }),
      null,
    ]) {
      const res = await env.recorder.handleRecordedEvent(bad as never);
      expect(res).toMatchObject({
        statusCode: 200,
        data: { recorded: false, skipped_reason: 'invalid_payload' },
      });
    }
    expect(env.unapplied.rows).toHaveLength(0);
    expect(warnings("noto'g'ri hodisa")).toHaveLength(5);
  });

  it('⭐ baza xatosi (masalan migratsiya 066 hali yo`q) → RpcException 500 (outbox qayta uradi), yozuv YO`QOLMAYDI', async () => {
    const env = makeService();
    env.unapplied.failNext(
      new Error('relation "finance_settlement_unapplied" does not exist'),
    );

    const error = await env.recorder
      .handleRecordedEvent(orderEvent())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 500,
    });
    expect(env.unapplied.rows).toHaveLength(0);

    // Outbox AYNAN shu hodisani qayta yetkazadi.
    await env.recorder.handleRecordedEvent(orderEvent());
    expect(env.unapplied.rows).toHaveLength(1);
  });

  it('summa tiyingacha yaxlitlanadi (numeric(14,2))', async () => {
    const env = makeService();

    await env.recorder.handleRecordedEvent(orderEvent({ amount: 250_000.004 }));

    expect(env.unapplied.rows[0].amount).toBe(250_000);
  });
});

describe('znD3KaZL TC2 (finance) — tezkor yo`l: advance javobini o`qiganda', () => {
  const courierCashbox = () => ({
    id: 'cb-7',
    user_id: '7',
    cashbox_type: 'couriers',
    balance: 600_000,
    balance_cash: 600_000,
    balance_card: 0,
  });
  const branchCashbox = () => ({
    id: 'br-10',
    user_id: '10',
    cashbox_type: 'branch',
    balance: 0,
    balance_cash: 0,
    balance_card: 0,
  });
  const payCourier = async (env: ReturnType<typeof makeService>) => {
    env.manager.findOne
      .mockResolvedValueOnce(courierCashbox())
      .mockResolvedValueOnce(null) // isDuplicateTransfer → yangi to'lov
      .mockResolvedValueOnce(branchCashbox());
    return (await env.service.paymentsFromCourier({
      courier_id: '7',
      amount: 550_000,
      payment_method: 'cash' as never,
      receiver_user_id: '10',
      receiver_cashbox_type: 'branch' as never,
      created_by: '1',
      dedup_epoch: 'tok-1',
    })) as { statusCode: number };
  };
  const leftoverReply = () =>
    advanceReply({
      settled_order_ids: ['A', 'B'],
      allocated: 300_000,
      leftover: 250_000,
    });

  it('⭐ kuryer 550 000 topshiradi, javobda qoldiq 250 000 → WARN log + unapplied yozuvi; keyin outbox hodisasi → dublikat yo`q', async () => {
    const env = makeService();
    env.orderClient.send.mockReturnValue(leftoverReply());

    const res = await payCourier(env);

    expect(res.statusCode).toBe(201);
    expect(warnings("FIFO qoldig'i (znD3KaZL)")).toHaveLength(1);
    expect(env.unapplied.rows).toEqual([
      {
        id: '1',
        level: 'courier_to_branch',
        actor_id: '7',
        amount: 250_000,
        dedup_epoch: 'tok-1',
      },
    ]);

    // Sekin yo'l ham keladi (order-service outbox'i) — o'sha kalit.
    const slow = await env.recorder.handleRecordedEvent(orderEvent());
    expect(slow.data).toMatchObject({ recorded: false, duplicate: true });
    expect(env.unapplied.rows).toHaveLength(1);
  });

  it('teskari tartib: avval outbox hodisasi, keyin tezkor yo`l → baribir bitta qator', async () => {
    const env = makeService();
    await env.recorder.handleRecordedEvent(orderEvent());

    await (env.service as any).tryPublishAdvanceNow({
      level: 'courier_to_branch',
      match_value: '7',
      amount: 550_000,
      request_id: 'tok-1',
    });

    expect(env.orderClient.send).toHaveBeenCalledTimes(1);
    expect(env.unapplied.rows).toHaveLength(1);
  });

  it('M8 takror javobi (`replayed: true`, o`sha qoldiq) — dublikat yo`q', async () => {
    const env = makeService();
    const payload = {
      level: 'courier_to_branch',
      match_value: '7',
      amount: 550_000,
      request_id: 'tok-1',
    };
    env.orderClient.send
      .mockReturnValueOnce(leftoverReply())
      .mockReturnValueOnce(
        advanceReply({
          settled_order_ids: ['A', 'B'],
          allocated: 300_000,
          leftover: 250_000,
          replayed: true,
        }),
      );

    await (env.service as any).tryPublishAdvanceNow(payload);
    await (env.service as any).tryPublishAdvanceNow(payload);

    expect(env.unapplied.rows).toHaveLength(1);
  });

  it('leftover = 0 → yozuv yo`q', async () => {
    const env = makeService();
    env.orderClient.send.mockReturnValue(
      advanceReply({ settled_order_ids: ['A'], allocated: 100, leftover: 0 }),
    );

    await (env.service as any).tryPublishAdvanceNow({
      level: 'branch_to_hq',
      match_value: '14',
      amount: 100,
      request_id: 'tok-2',
    });

    expect(env.unapplied.rows).toHaveLength(0);
    expect(env.unapplied.repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('⭐ tezkor yo`l timeout (javob yo`q) → yozuv yo`q; sekin yo`l (outbox hodisasi) yozadi', async () => {
    const env = makeService();
    env.orderClient.send.mockReturnValue(
      throwError(() => new Error('timeout')),
    );

    const res = await payCourier(env);

    expect(res.statusCode).toBe(201);
    expect(env.unapplied.rows).toHaveLength(0);

    await env.recorder.handleRecordedEvent(orderEvent());
    expect(env.unapplied.rows).toEqual([
      expect.objectContaining({
        level: 'courier_to_branch',
        actor_id: '7',
        amount: 250_000,
        dedup_epoch: 'tok-1',
      }),
    ]);
  });

  it('tezkor yo`lda baza xatosi — yutiladi (to`lov 201), WARN; sekin yo`l keyin yozadi', async () => {
    const env = makeService();
    env.orderClient.send.mockReturnValue(leftoverReply());
    env.unapplied.failNext(new Error('db down'));

    const res = await payCourier(env);

    expect(res.statusCode).toBe(201);
    expect(env.unapplied.rows).toHaveLength(0);
    expect(warnings("tezkor yo'lda yozib bo'lmadi")).toHaveLength(1);

    await env.recorder.handleRecordedEvent(orderEvent());
    expect(env.unapplied.rows).toHaveLength(1);
  });

  it('⭐ kassa harakatlari va advance navbati O`ZGARMAYDI (yozuvchi bilan va usiz bir xil)', async () => {
    const withRecorder = makeService();
    withRecorder.orderClient.send.mockReturnValue(leftoverReply());
    const a = await payCourier(withRecorder);

    const without = makeService({ recorder: false });
    without.orderClient.send.mockReturnValue(leftoverReply());
    const b = await payCourier(without);

    expect(a).toEqual(b);
    expect(withRecorder.manager.save.mock.calls).toEqual(
      without.manager.save.mock.calls,
    );
    // Navbatga qo'yilgan hodisalar (target, pattern, payload) — bir xil.
    const enqueued = (env: ReturnType<typeof makeService>) =>
      env.outbox.enqueue.mock.calls.map((call: unknown[]) => call.slice(0, 3));
    expect(enqueued(withRecorder)).toEqual(enqueued(without));
    expect(enqueued(withRecorder)).toHaveLength(1);
    expect(withRecorder.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cb-7', balance: 50_000 }),
    );
    expect(withRecorder.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'br-10', balance: 550_000 }),
    );
    // Yozuvchisiz (eski DI) — faqat WARN, yozuv yo'q.
    expect(without.unapplied.rows).toHaveLength(0);
  });
});
