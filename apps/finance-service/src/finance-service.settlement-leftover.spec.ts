import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { FinanceServiceService } from './finance-service.service';

/**
 * znD3KaZL — finance tomoni: advance javobidagi FIFO qoldig'i (`leftover`)
 * endi o'qiladi va /financial-balance "taqsimlanmagan qoldiq" ni ko'rsatadi.
 *
 * Qoldiqning O'ZI order-service'da (`order_settlement_carry`, FIFO bilan bitta
 * tranzaksiyada) — finance ikkinchi nusxa saqlamaydi: outbox relay javobni
 * o'qimaydi, ya'ni finance tomonidagi yozuv faqat tezkor yo'lda paydo bo'lib,
 * daftardan ajralib qolardi. Bu yerda tekshiriladi:
 *   • kassa to'lovni TO'LIQ ko'chiradi (550 000), advance aynan shu summa
 *     bilan navbatga qo'yiladi, javobdagi qoldiq (250 000) WARN logga chiqadi;
 *   • `financialBalance` yangi `unappliedCarry` maydoni — mavjud maydonlar
 *     va holat formulasi o'zgarmaydi.
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

function makeService() {
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
  );
  return { service, manager, cashboxRepo, orderClient, outbox, queryRunner };
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

const leftoverLogs = () =>
  warnSpy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((msg: string) => msg.includes("FIFO qoldig'i (znD3KaZL)"));

describe('znD3KaZL TC2 (finance) — advance javobidagi qoldiq o`qiladi', () => {
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

  it('⭐ kuryer 550 000 topshiradi: kassa TO`LIQ ko`chadi, advance shu summa bilan, qoldiq 250 000 WARN logda', async () => {
    const env = makeService();
    env.manager.findOne
      .mockResolvedValueOnce(courierCashbox())
      .mockResolvedValueOnce(null) // isDuplicateTransfer → yangi to'lov
      .mockResolvedValueOnce(branchCashbox());
    env.orderClient.send.mockReturnValue(
      of({
        statusCode: 200,
        message: 'Settlement advanced',
        data: {
          settled_order_ids: ['A', 'B'],
          allocated: 300_000,
          leftover: 250_000,
        },
      }),
    );

    const res = (await env.service.paymentsFromCourier({
      courier_id: '7',
      amount: 550_000,
      payment_method: 'cash' as never,
      receiver_user_id: '10',
      receiver_cashbox_type: 'branch' as never,
      created_by: '1',
      dedup_epoch: 'tok-1',
    })) as { statusCode: number };

    expect(res.statusCode).toBe(201);
    // Kassa: kuryerdan 550 000 chiqdi, filialga 550 000 kirdi (qoldiq ham).
    expect(env.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cb-7', balance: 50_000 }),
    );
    expect(env.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'br-10', balance: 550_000 }),
    );
    // Advance — AYNAN kassa harakati summasi (daftar shu summadan yuritadi).
    expect(env.outbox.enqueue).toHaveBeenCalledWith(
      'ORDER',
      'order.settlement.advance',
      expect.objectContaining({
        level: 'courier_to_branch',
        match_value: '7',
        amount: 550_000,
        request_id: 'tok-1',
      }),
      expect.objectContaining({ requestId: 'tok-1' }),
    );
    const logs = leftoverLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('level=courier_to_branch');
    expect(logs[0]).toContain('match=7');
    expect(logs[0]).toContain('amount=550000');
    expect(logs[0]).toContain('allocated=300000');
    expect(logs[0]).toContain('leftover=250000');
    expect(logs[0]).toContain('order_settlement_carry');
  });

  it('leftover 0 → log yo`q', async () => {
    const env = makeService();
    env.orderClient.send.mockReturnValue(
      of({ data: { settled_order_ids: ['A'], allocated: 100, leftover: 0 } }),
    );

    await (env.service as any).tryPublishAdvanceNow({
      level: 'branch_to_hq',
      match_value: '14',
      amount: 100,
      request_id: 'tok-2',
    });

    expect(env.orderClient.send).toHaveBeenCalledTimes(1);
    expect(leftoverLogs()).toHaveLength(0);
  });

  it('javob xato / bo`sh / boshqa shaklda — yutiladi, log yo`q, xato otilmaydi', async () => {
    const env = makeService();
    const payload = {
      level: 'hq_to_market',
      match_value: '191',
      amount: 100,
      request_id: 'tok-3',
    };

    env.orderClient.send.mockReturnValueOnce(
      throwError(() => new Error('timeout')),
    );
    await expect(
      (env.service as any).tryPublishAdvanceNow(payload),
    ).resolves.toBeUndefined();
    env.orderClient.send.mockReturnValueOnce(of(undefined));
    await expect(
      (env.service as any).tryPublishAdvanceNow(payload),
    ).resolves.toBeUndefined();
    env.orderClient.send.mockReturnValueOnce(of({ data: { leftover: 'x' } }));
    await expect(
      (env.service as any).tryPublishAdvanceNow(payload),
    ).resolves.toBeUndefined();

    expect(leftoverLogs()).toHaveLength(0);
  });

  it('token yo`q — tezkor yo`l yuborilmaydi (avvalgidek)', async () => {
    const env = makeService();

    await (env.service as any).tryPublishAdvanceNow({
      level: 'courier_to_branch',
      match_value: '7',
      amount: 100,
    });

    expect(env.orderClient.send).not.toHaveBeenCalled();
  });
});

describe('znD3KaZL — /financial-balance "taqsimlanmagan qoldiq" (unappliedCarry)', () => {
  function primeBalance(env: ReturnType<typeof makeService>) {
    env.cashboxRepo.findOne.mockResolvedValue({
      id: 'main-1',
      user_id: '0',
      cashbox_type: 'main',
      balance: 500_000,
    });
    // sumCashboxBalanceByType: market → courier → branch.
    env.cashboxRepo.createQueryBuilder = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest
        .fn()
        .mockResolvedValueOnce({ total: '200000' })
        .mockResolvedValueOnce({ total: '300000' })
        .mockResolvedValueOnce({ total: '550000' }),
    });
  }
  const summary = (extra: Record<string, unknown> = {}) => ({
    data: {
      chain_receivable: 190_000,
      branch_receivable: 140_000,
      hq_receivable: 50_000,
      market_payable: 200_000,
      branches: [{ branch_id: '14', amount: 140_000 }],
      markets: [{ market_id: '191', amount: 200_000 }],
      ...extra,
    },
  });
  const route = (payload: unknown) =>
    rmqSendMock.mockImplementation((_client: unknown, pattern: any) =>
      Promise.resolve(
        pattern?.cmd === 'integration.receivable.outstanding_total'
          ? { data: { outstanding_amount: 0 } }
          : payload,
      ),
    );

  it('⭐ order-service qoldig`i camelCase ko`rsatkichga o`tadi; holat formulasi O`ZGARMAYDI', async () => {
    const withCarry = makeService();
    primeBalance(withCarry);
    route(
      summary({
        unapplied_carry: {
          total: 405_000,
          courier_to_branch: 290_000,
          branch_to_hq: 95_000,
          hq_to_market: 20_000,
          count: 2,
          items: [
            {
              level: 'courier_to_branch',
              party_id: '7',
              branch_id: '10',
              amount: 250_000,
            },
            {
              level: 'branch_to_hq',
              party_id: '14',
              branch_id: null,
              amount: 95_000,
            },
          ],
        },
      }),
    );
    const a: any = await withCarry.service.financialBalance();

    const withoutCarry = makeService();
    primeBalance(withoutCarry);
    route(summary());
    const b: any = await withoutCarry.service.financialBalance();

    expect(a.data.unappliedCarry).toEqual({
      total: 405_000,
      courierToBranch: 290_000,
      branchToHq: 95_000,
      hqToMarket: 20_000,
      count: 2,
      items: [
        {
          level: 'courier_to_branch',
          party_id: '7',
          branch_id: '10',
          amount: 250_000,
        },
        {
          level: 'branch_to_hq',
          party_id: '14',
          branch_id: null,
          amount: 95_000,
        },
      ],
    });
    // Mavjud maydonlar va holat — qoldiq ko'rsatkichidan qat'i nazar bir xil
    // (qoldiq `chainReceivable` da allaqachon ayirilgan).
    const withoutIndicator = (data: Record<string, unknown>) => {
      const copy = { ...data };
      delete copy.unappliedCarry;
      return copy;
    };
    expect(withoutIndicator(a.data)).toEqual(withoutIndicator(b.data));
    // 500 000 + 190 000 + 0 − 200 000
    expect(a.data.currentSituation).toBe(490_000);
    expect(a.data.formula).toBe(
      'main_cashbox + chain_receivable + provider_receivable - market_cashbox_payable',
    );
  });

  it('kalit yo`q (qoldiq yo`q yoki order-service eski) — nollar', async () => {
    const env = makeService();
    primeBalance(env);
    route(summary());

    const res: any = await env.service.financialBalance();

    expect(res.data.unappliedCarry).toEqual({
      total: 0,
      courierToBranch: 0,
      branchToHq: 0,
      hqToMarket: 0,
      count: 0,
      items: [],
    });
  });
});
