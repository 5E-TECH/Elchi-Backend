import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Between } from 'typeorm';
import { FinanceServiceService } from './finance-service.service';

/**
 * FIX3 / A3 — finance-service tuzatishlari (audit M2, M4, M9, M12, M16,
 * CODE-08, C2/CODE-22). Har bir blok bitta topilmani himoya qiladi.
 */

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common/time/tashkent-time'),
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
  rmqSend: (...args: any[]) => rmqSendMock(...args),
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

type Row = Record<string, any>;

function makeManager() {
  return {
    findOne: jest.fn(),
    save: jest.fn((entity: any) => Promise.resolve(entity)),
    create: jest.fn((_entity: any, dto: any) => ({ ...dto })),
  };
}

function makeService(manager = makeManager()) {
  const queryRunner = {
    manager,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
  };
  const dataSource: any = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };
  const cashboxRepo: any = {
    findOne: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const historyRepo: any = {
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    createQueryBuilder: jest.fn(),
  };
  const financialHistoryRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    createQueryBuilder: jest.fn(),
  };
  const activityLog: any = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  // tryPublishAdvanceNow → orderClient.send(...).pipe(timeout(2000)).
  const orderClient: any = { send: jest.fn(() => of({ statusCode: 200 })) };
  const integrationClient: any = { send: jest.fn() };
  const identityClient: any = { send: jest.fn() };
  const outbox: any = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const service = new FinanceServiceService(
    cashboxRepo,
    historyRepo,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    financialHistoryRepo,
    dataSource,
    activityLog,
    orderClient,
    integrationClient,
    identityClient,
    outbox,
  );
  return {
    service,
    manager,
    queryRunner,
    cashboxRepo,
    historyRepo,
    financialHistoryRepo,
    outbox,
    orderClient,
  };
}

/**
 * `rmqSend` mock'ini `cmd` bo'yicha yo'naltiradi. Handler tashlagan xato
 * promise'ni reject qiladi (mikroservis xatosi kabi).
 */
function routeRmq(handlers: Record<string, (payload: any) => unknown>) {
  rmqSendMock.mockImplementation(
    (_client: unknown, pattern: { cmd: string }, payload: any) =>
      new Promise((resolve) => {
        const handler = handlers[pattern.cmd];
        resolve(handler ? handler(payload) : undefined);
      }),
  );
}

/** Mikroservis RPC xatosi: `{ statusCode, message }` (Error sifatida). */
const rpcError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

/** Mikrotask navbatini bo'shatadi (fondagi `.then` lar ishlab olsin). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const callsOf = (cmd: string) =>
  rmqSendMock.mock.calls.filter((call: any[]) => call[1]?.cmd === cmd);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  rmqSendMock.mockReset();
  rmqSendMock.mockResolvedValue(undefined);
});

describe('M2 — market to`lovi javobi buyurtma sinxronini kutmaydi', () => {
  const mainCashbox = () => ({
    id: 'main-1',
    user_id: '0',
    cashbox_type: 'main',
    balance: 5_000_000,
    balance_cash: 5_000_000,
    balance_card: 0,
  });
  const marketCashbox = () => ({
    id: 'mk-1',
    user_id: '201',
    cashbox_type: 'markets',
    balance: 3_000_000,
    balance_cash: 3_000_000,
    balance_card: 0,
  });

  function payoutEnv() {
    const env = makeService();
    env.manager.findOne
      .mockResolvedValueOnce(mainCashbox())
      .mockResolvedValueOnce(marketCashbox())
      // isDuplicateTransfer → yangi to'lov
      .mockResolvedValueOnce(null);
    return env;
  }

  it('commit dan keyin darhol javob qaytadi; sinxron fonda tugaydi', async () => {
    const env = payoutEnv();
    const gate = deferred();
    const sync = jest
      .spyOn(env.service as any, 'syncMarketPaymentsSafely')
      .mockImplementation(() => gate.promise);

    const res: any = await env.service.paymentsToMarket({
      market_id: '201',
      amount: 2_000_000,
      payment_method: 'cash' as any,
      created_by: '1',
      dedup_epoch: 'idem-key-1',
    });

    // Sinxron hali tugamagan, lekin javob allaqachon qaytdi.
    expect(res.statusCode).toBe(200);
    await flush();
    expect(env.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith('201', 2_000_000);
    // Ledger siljishi tranzaksiya ICHIDA navbatga qo'yilgan.
    expect(env.outbox.enqueue).toHaveBeenCalledWith(
      'ORDER',
      'order.settlement.advance',
      expect.objectContaining({ level: 'hq_to_market', match_value: '201' }),
      expect.objectContaining({ requestId: 'idem-key-1' }),
    );

    gate.resolve();
    await env.service.onModuleDestroy();
  });

  it('takroriy kalit → { idempotent: true }, pul ham sinxron ham yo`q', async () => {
    const env = makeService();
    env.manager.findOne
      .mockResolvedValueOnce(mainCashbox())
      .mockResolvedValueOnce(marketCashbox())
      .mockResolvedValueOnce({ id: 'h-existing' });
    const sync = jest
      .spyOn(env.service as any, 'syncMarketPaymentsSafely')
      .mockResolvedValue(undefined);

    const res: any = await env.service.paymentsToMarket({
      market_id: '201',
      amount: 2_000_000,
      payment_method: 'cash' as any,
      dedup_epoch: 'idem-key-1',
    });

    expect(res).toMatchObject({ statusCode: 200, data: { idempotent: true } });
    expect(env.manager.save).not.toHaveBeenCalled();
    expect(env.outbox.enqueue).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('bitta marketning sinxronlari ketma-ket (navbat), boshqa market kutmaydi', async () => {
    const { service } = makeService();
    const order: string[] = [];
    const firstGate = deferred();
    jest
      .spyOn(service as any, 'syncMarketPaymentsSafely')
      .mockImplementation(async (...args: unknown[]) => {
        const [marketId, amount] = args as [string, number];
        order.push(`start:${marketId}:${amount}`);
        if (amount === 1) {
          await firstGate.promise;
        }
        order.push(`end:${marketId}:${amount}`);
      });
    jest
      .spyOn(service as any, 'emitSettlementPaymentSafely')
      .mockResolvedValue(undefined);

    const a = (service as any).scheduleMarketPaymentFollowUp({
      market_id: '201',
      amount: 1,
    });
    const b = (service as any).scheduleMarketPaymentFollowUp({
      market_id: '201',
      amount: 2,
    });
    const c = (service as any).scheduleMarketPaymentFollowUp({
      market_id: '305',
      amount: 3,
    });
    await c;
    // 305 — boshqa market, 201 ning birinchi sinxronini kutmadi.
    expect(order).toContain('end:305:3');
    expect(order).not.toContain('start:201:2');

    firstGate.resolve();
    await Promise.all([a, b]);
    expect(order.indexOf('end:201:1')).toBeLessThan(
      order.indexOf('start:201:2'),
    );
    // Navbat tozalanadi (xotira oqmaydi).
    expect((service as any).marketOrderSyncChains.size).toBe(0);
    expect((service as any).pendingFollowUps.size).toBe(0);
  });

  it('sinxron xatosi navbatni buzmaydi va reject bo`lmaydi', async () => {
    const { service } = makeService();
    routeRmq({
      'order.find_all': () => {
        throw new Error('order-service down');
      },
    });

    await expect(
      (service as any).scheduleMarketPaymentFollowUp({
        market_id: '201',
        amount: 100,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('M9 — buyurtma holati sinxroni: eng eskisi birinchi, sof summa', () => {
  const orderRow = (over: Row) => ({
    status: 'sold',
    to_be_paid: 0,
    paid_amount: 0,
    extra_cost: 0,
    ...over,
  });

  it('order.find_all eng eskisi birinchi, 100 talik sahifalar bilan; to`lov qoplanguncha o`qiladi', async () => {
    const { service } = makeService();
    const page1 = Array.from({ length: 100 }, (_, i) =>
      orderRow({ id: String(i + 1), to_be_paid: 10 }),
    );
    const page2 = [orderRow({ id: '101', to_be_paid: 10 })];
    routeRmq({
      'order.find_all': (payload) => ({
        data: payload.query.page === 1 ? page1 : page2,
      }),
    });

    // 1 005 > 100 × 10 → 2-sahifa ham kerak.
    await (service as any).applyPaymentToOrders('201', 1_005);

    const finds = callsOf('order.find_all');
    expect(finds).toHaveLength(2);
    expect(finds[0][2]).toEqual({
      query: {
        market_id: '201',
        status: ['partly_paid', 'sold'],
        sort_by: 'created_at',
        sort_dir: 'asc',
        page: 1,
        limit: 100,
      },
    });
    expect(finds[1][2].query.page).toBe(2);

    const updates = callsOf('order.update_normalized').map(
      (call: any[]) => call[2],
    );
    expect(updates).toHaveLength(101);
    expect(updates[0]).toEqual({
      id: '1',
      dto: { paid_amount: 10, status: 'paid' },
    });
    // Oxirgisi qisman: 1 005 − 1 000 = 5.
    expect(updates[100]).toEqual({
      id: '101',
      dto: { paid_amount: 5, status: 'partly_paid' },
    });
  });

  it('to`lov 1-sahifada qoplansa, 2-sahifa so`ralmaydi', async () => {
    const { service } = makeService();
    const page1 = Array.from({ length: 100 }, (_, i) =>
      orderRow({ id: String(i + 1), to_be_paid: 10 }),
    );
    routeRmq({ 'order.find_all': () => ({ data: page1 }) });

    await (service as any).applyPaymentToOrders('201', 30);

    expect(callsOf('order.find_all')).toHaveLength(1);
    expect(callsOf('order.update_normalized')).toHaveLength(3);
  });

  it('qo`shimcha xarajatli buyurtma SOF summa (to_be_paid − extra_cost) bilan PAID bo`ladi', async () => {
    const { service } = makeService();
    routeRmq({
      'order.find_all': () => ({
        data: [
          // Market bu buyurtmadan 100 000 − 30 000 = 70 000 oladi.
          orderRow({ id: '11', to_be_paid: '100000', extra_cost: '30000' }),
          orderRow({ id: '12', to_be_paid: 50_000 }),
        ],
      }),
    });

    await (service as any).applyPaymentToOrders('201', 120_000);

    const updates = callsOf('order.update_normalized').map(
      (call: any[]) => call[2],
    );
    expect(updates).toEqual([
      // paid_amount = to_be_paid (PAID ⇔ to'liq), sarflangani 70 000.
      { id: '11', dto: { paid_amount: 100_000, status: 'paid' } },
      { id: '12', dto: { paid_amount: 50_000, status: 'paid' } },
    ]);
  });

  it('PARTLY_PAID buyurtmaning qoldig`i paid_amount ni hisobga oladi', async () => {
    const { service } = makeService();
    routeRmq({
      'order.find_all': () => ({
        data: [
          orderRow({
            id: '21',
            status: 'partly_paid',
            to_be_paid: 100,
            paid_amount: 60,
          }),
          orderRow({ id: '22', to_be_paid: 100 }),
        ],
      }),
    });

    await (service as any).applyPaymentToOrders('201', 50);

    const updates = callsOf('order.update_normalized').map(
      (call: any[]) => call[2],
    );
    expect(updates).toEqual([
      { id: '21', dto: { paid_amount: 100, status: 'paid' } },
      { id: '22', dto: { paid_amount: 10, status: 'partly_paid' } },
    ]);
  });

  it('SOLD → PARTLY_PAID rad etilsa (400) faqat paid_amount yoziladi', async () => {
    const { service } = makeService();
    routeRmq({
      'order.find_all': () => ({
        data: [orderRow({ id: '31', to_be_paid: 100 })],
      }),
      'order.update_normalized': (payload) => {
        if (payload.dto.status === 'partly_paid') {
          throw rpcError(400, 'Invalid status transition: sold -> partly_paid');
        }
        return { statusCode: 200 };
      },
    });

    await (service as any).applyPaymentToOrders('201', 40);

    const updates = callsOf('order.update_normalized').map(
      (call: any[]) => call[2],
    );
    expect(updates).toEqual([
      { id: '31', dto: { paid_amount: 40, status: 'partly_paid' } },
      { id: '31', dto: { paid_amount: 40 } },
    ]);
  });

  it('PAID yozuvi xato bersa (5xx) sinxron to`xtaydi — FIFO`da "teshik" qolmaydi', async () => {
    const { service } = makeService();
    routeRmq({
      'order.find_all': () => ({
        data: [
          orderRow({ id: '41', to_be_paid: 10 }),
          orderRow({ id: '42', to_be_paid: 10 }),
        ],
      }),
      'order.update_normalized': (payload) => {
        if (payload.id === '41') {
          throw rpcError(500, 'db blip');
        }
        return { statusCode: 200 };
      },
    });

    await expect(
      (service as any).applyPaymentToOrders('201', 20),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(callsOf('order.update_normalized')).toHaveLength(1);
  });
});

describe('M12 — filial kassasi qo`lda chiqimda manfiyga tushmaydi', () => {
  const branchCashbox = () => ({
    id: 'br-15',
    user_id: '15',
    cashbox_type: 'branch',
    balance: 100_000,
    balance_cash: 100_000,
    balance_card: 0,
  });

  it('menejerning MANUAL_EXPENSE i kassadan oshsa → 400, kassa saqlanmaydi', async () => {
    const env = makeService();
    env.manager.findOne.mockResolvedValueOnce(branchCashbox());

    const error: unknown = await env.service
      .spendMoney({
        user_id: '15',
        amount: 500_000,
        cashbox_type: 'branch' as any,
        created_by: '208',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toEqual({
      statusCode: 400,
      message: 'Insufficient cash balance',
    });
    expect(env.manager.save).not.toHaveBeenCalled();
    expect(env.queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('kassa yetarli bo`lsa qo`lda chiqim avvalgidek o`tadi', async () => {
    const env = makeService();
    env.manager.findOne.mockResolvedValueOnce(branchCashbox());

    await env.service.spendMoney({
      user_id: '15',
      amount: 40_000,
      cashbox_type: 'branch' as any,
      created_by: '208',
    });

    expect(env.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'br-15', balance_cash: 60_000 }),
    );
  });

  it.each(['sell', 'extra_cost', 'correction', 'cancel'])(
    'tizim oyog`i (%s) filialni avvalgidek manfiyga tushira oladi',
    async (sourceType) => {
      const env = makeService();
      env.manager.findOne
        .mockResolvedValueOnce(branchCashbox())
        // idempotentlik tekshiruvi (source_id bor) → yangi
        .mockResolvedValueOnce(null);

      await env.service.updateBalance({
        user_id: '15',
        cashbox_type: 'branch' as any,
        amount: 300_000,
        operation_type: 'expense' as any,
        source_type: sourceType as any,
        source_id: '777',
      });

      expect(env.manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'br-15', balance_cash: -200_000 }),
      );
    },
  );
});

describe('M4 — "Marketga o`tkazma" (click_to_market)', () => {
  const courierCashbox = () => ({
    id: 'cb-209',
    user_id: '209',
    cashbox_type: 'couriers',
    balance: 300_000,
    balance_cash: 300_000,
    balance_card: 0,
  });
  const mainCashbox = () => ({
    id: 'main-1',
    user_id: '0',
    cashbox_type: 'main',
    balance: 0,
    balance_cash: 0,
    balance_card: 0,
  });
  const marketCashbox = (balance: number) => ({
    id: 'mk-201',
    user_id: '201',
    cashbox_type: 'markets',
    balance,
    balance_cash: balance,
    balance_card: 0,
  });

  it('filial kassasi orqali → 400, hech narsa qulflanmaydi/ko`chmaydi', async () => {
    const env = makeService();

    const error: unknown = await env.service
      .paymentsFromCourier({
        courier_id: '209',
        amount: 300_000,
        payment_method: 'click_to_market' as any,
        market_id: '201',
        receiver_user_id: '15',
        receiver_cashbox_type: 'branch' as any,
        dedup_epoch: 'tok-1',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 400,
    });
    expect(env.manager.findOne).not.toHaveBeenCalled();
    expect(env.manager.save).not.toHaveBeenCalled();
    expect(env.outbox.enqueue).not.toHaveBeenCalled();
  });

  it('marketga qarzdan oshsa → 400, pul ko`chmaydi', async () => {
    const env = makeService();
    env.manager.findOne
      .mockResolvedValueOnce(courierCashbox())
      .mockResolvedValueOnce(null) // isDuplicateTransfer
      .mockResolvedValueOnce(mainCashbox())
      .mockResolvedValueOnce(marketCashbox(100_000));

    const error: unknown = await env.service
      .paymentsFromCourier({
        courier_id: '209',
        amount: 300_000,
        payment_method: 'click_to_market' as any,
        market_id: '201',
        dedup_epoch: 'tok-1',
      })
      .catch((caught: unknown) => caught);

    expect((error as RpcException).getError()).toEqual({
      statusCode: 400,
      message: "To'lov miqdori marketga qarzdan oshib ketdi (qarz: 100000)",
    });
    expect(env.manager.save).not.toHaveBeenCalled();
    expect(env.outbox.enqueue).not.toHaveBeenCalled();
    expect(env.queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('HQ (MAIN) orqali: market bo`g`ini ham yopiladi — ikkinchi siljish `:m` tokeni bilan', async () => {
    const env = makeService();
    env.manager.findOne
      .mockResolvedValueOnce(courierCashbox())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mainCashbox())
      .mockResolvedValueOnce(marketCashbox(1_000_000));
    const followUp = jest
      .spyOn(env.service as any, 'scheduleMarketPaymentFollowUp')
      .mockResolvedValue(undefined);

    const res: any = await env.service.paymentsFromCourier({
      courier_id: '209',
      amount: 300_000,
      payment_method: 'click_to_market' as any,
      market_id: '201',
      created_by: '1',
      dedup_epoch: 'tok-1',
    });

    expect(res.statusCode).toBe(201);
    expect(env.outbox.enqueue).toHaveBeenCalledTimes(2);
    expect(env.outbox.enqueue).toHaveBeenNthCalledWith(
      1,
      'ORDER',
      'order.settlement.advance',
      expect.objectContaining({
        level: 'courier_to_branch',
        match_value: '209',
        amount: 300_000,
      }),
      expect.objectContaining({ requestId: 'tok-1' }),
    );
    expect(env.outbox.enqueue).toHaveBeenNthCalledWith(
      2,
      'ORDER',
      'order.settlement.advance',
      expect.objectContaining({
        level: 'hq_to_market',
        match_value: '201',
        amount: 300_000,
        request_id: 'tok-1:m',
      }),
      expect.objectContaining({ requestId: 'tok-1:m' }),
    );
    // Market payable 1 000 000 → 700 000.
    expect(env.manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'mk-201', balance: 700_000 }),
    );
    // Ikkala siljish ham commit'dan keyin darhol yuboriladi (2 s chegara).
    expect(env.orderClient.send).toHaveBeenCalledTimes(2);
    // Sinxron + hamkor xabari fonda.
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ market_id: '201', amount: 300_000 }),
    );
  });

  it('token bo`lmasa ikkinchi siljish ham tokensiz (umumiy ":m" kalit yo`q)', async () => {
    const env = makeService();
    env.manager.findOne
      .mockResolvedValueOnce(courierCashbox())
      .mockResolvedValueOnce(mainCashbox())
      .mockResolvedValueOnce(marketCashbox(1_000_000));
    jest
      .spyOn(env.service as any, 'scheduleMarketPaymentFollowUp')
      .mockResolvedValue(undefined);

    await env.service.paymentsFromCourier({
      courier_id: '209',
      amount: 300_000,
      payment_method: 'click_to_market' as any,
      market_id: '201',
    });

    const second = env.outbox.enqueue.mock.calls[1];
    expect(second[2]).not.toHaveProperty('request_id');
    expect(second[3]).toEqual(
      expect.objectContaining({ requestId: undefined }),
    );
  });

  it('oddiy naqd qabulda market siljishi va sinxron yo`q', async () => {
    const env = makeService();
    env.manager.findOne
      .mockResolvedValueOnce(courierCashbox())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mainCashbox());
    const followUp = jest.spyOn(
      env.service as any,
      'scheduleMarketPaymentFollowUp',
    );

    await env.service.paymentsFromCourier({
      courier_id: '209',
      amount: 300_000,
      payment_method: 'cash' as any,
      dedup_epoch: 'tok-2',
    });

    expect(env.outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(followUp).not.toHaveBeenCalled();
  });
});

describe('M16 — "Berilishi kerak" faqat musbat market kassalari', () => {
  it('allCashboxesTotal marketPayableTotal ni GREATEST(balance, 0) bilan beradi', async () => {
    const { service, cashboxRepo, historyRepo } = makeService();
    cashboxRepo.findOne.mockResolvedValue({ balance: 5000 });
    historyRepo.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    });
    const selects: string[] = [];
    cashboxRepo.createQueryBuilder.mockImplementation(() => {
      let select = '';
      let type = '';
      const qb: any = {
        select: jest.fn((sql: string) => {
          select = sql;
          selects.push(sql);
          return qb;
        }),
        where: jest.fn((_sql: string, params: { cashboxType: string }) => {
          type = params.cashboxType;
          return qb;
        }),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn(() => {
          // A market +1 000 000, B market −200 000.
          if (type === 'markets') {
            return Promise.resolve({
              total: select.includes('GREATEST') ? '1000000' : '800000',
            });
          }
          return Promise.resolve({ total: '0' });
        }),
      };
      return qb;
    });

    const res: any = await service.allCashboxesTotal({ page: 1, limit: 20 });

    expect(res.data.marketCashboxTotal).toBe(800_000);
    expect(res.data.marketPayableTotal).toBe(1_000_000);
    expect(selects).toContain('COALESCE(SUM(GREATEST(c.balance, 0)), 0)');
  });

  it('allCashboxesTotal sana filtri — Toshkent kuni', async () => {
    const { service, cashboxRepo, historyRepo } = makeService();
    cashboxRepo.findOne.mockResolvedValue({ balance: 0 });
    const andWhere = jest.fn().mockReturnThis();
    historyRepo.createQueryBuilder.mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere,
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    });
    cashboxRepo.createQueryBuilder.mockImplementation(() => {
      const qb: any = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ total: '0' }),
      };
      return qb;
    });

    await service.allCashboxesTotal({
      fromDate: '2026-10-01',
      toDate: '2026-10-01',
    });

    expect(andWhere).toHaveBeenCalledWith('h.createdAt >= :fromDate', {
      fromDate: new Date('2026-09-30T19:00:00.000Z'),
    });
    expect(andWhere).toHaveBeenCalledWith('h.createdAt <= :toDate', {
      toDate: new Date('2026-10-01T18:59:59.999Z'),
    });
  });
});

describe('CODE-08 — kassa egasi: filial id si foydalanuvchi deb olinmaydi', () => {
  it('BRANCH/MAIN kassasi uchun identity so`ralmaydi, user = null; market kassasi — so`raladi', async () => {
    const { service } = makeService();
    routeRmq({
      'identity.user.find_by_id': (payload) => ({
        data: { id: payload.id, name: `user-${payload.id}` },
      }),
    });

    const enriched: any[] = await (service as any).enrichHistoryWithUsers([
      {
        id: 'h1',
        created_by: '208',
        source_type: 'courier_payment',
        source_user_id: '209',
        cashbox: { id: 'br-15', user_id: '15', cashbox_type: 'branch' },
      },
      {
        id: 'h2',
        created_by: '1',
        source_type: 'branch_to_main',
        source_user_id: '15',
        cashbox: { id: 'main-1', user_id: '0', cashbox_type: 'main' },
      },
      {
        id: 'h3',
        created_by: '1',
        source_type: 'market_payment',
        source_user_id: '201',
        cashbox: { id: 'mk-201', user_id: '201', cashbox_type: 'markets' },
      },
    ]);

    const lookedUp = callsOf('identity.user.find_by_id').map(
      (call: any[]) => call[2].id,
    );
    // 15 (filial id si) va 0 (MAIN) foydalanuvchi sifatida so'ralmaydi.
    expect(lookedUp).not.toContain('15');
    expect(lookedUp).not.toContain('0');
    expect(lookedUp).toEqual(
      expect.arrayContaining(['208', '209', '1', '201']),
    );

    expect(enriched[0].cashbox.user).toBeNull();
    expect(enriched[0].source_user).toEqual(
      expect.objectContaining({ id: '209' }),
    );
    expect(enriched[1].cashbox.user).toBeNull();
    // BRANCH_TO_MAIN ning source_user_id si filial id si — foydalanuvchi emas.
    expect(enriched[1].source_user).toBeNull();
    expect(enriched[2].cashbox.user).toEqual(
      expect.objectContaining({ id: '201' }),
    );
  });
});

describe('C2 / CODE-22 — moliyaviy balans sana filtri Toshkent kuni', () => {
  const OCT_1_START = new Date('2026-09-30T19:00:00.000Z');
  const OCT_1_END = new Date('2026-10-01T18:59:59.999Z');

  it('history: YYYY-MM-DD → Toshkent kunining butun oynasi', async () => {
    const { service, financialHistoryRepo } = makeService();

    await service.findFinancialBalanceHistory({
      from_date: '2026-10-01',
      to_date: '2026-10-01',
    });

    const where = financialHistoryRepo.findAndCount.mock.calls[0][0].where;
    expect(where.createdAt).toEqual(Between(OCT_1_START, OCT_1_END));
  });

  it('history: yaroqsiz sana → avvalgidek 400', async () => {
    const { service } = makeService();

    const error: unknown = await service
      .findFinancialBalanceHistory({ from_date: 'abc' })
      .catch((caught: unknown) => caught);

    expect((error as RpcException).getError()).toEqual({
      statusCode: 400,
      message: 'Invalid date format: abc',
    });
  });

  it('analytics/top-impacts: Toshkent chegaralari', async () => {
    const { service, financialHistoryRepo } = makeService();
    const andWhere = jest.fn().mockReturnThis();
    financialHistoryRepo.createQueryBuilder.mockImplementation(() => {
      const qb: any = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere,
        groupBy: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({}),
        getMany: jest.fn().mockResolvedValue([]),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      return qb;
    });

    await service.financialBalanceTopImpacts({
      from_date: '2026-10-01',
      to_date: '2026-10-01',
    });

    expect(andWhere).toHaveBeenCalledWith('h.createdAt >= :from', {
      from: OCT_1_START,
    });
    expect(andWhere).toHaveBeenCalledWith('h.createdAt <= :to', {
      to: OCT_1_END,
    });
  });

  it('findCashboxByUser (turi berilmagan, barcha kassalar) ham sana filtrini qo`llaydi', async () => {
    const { service, cashboxRepo, historyRepo } = makeService();
    cashboxRepo.find.mockResolvedValue([{ id: 'c1' }]);
    const andWhere = jest.fn().mockReturnThis();
    historyRepo.createQueryBuilder.mockReturnValue({
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere,
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    });

    await service.findCashboxByUser({
      user_id: '201',
      with_history: true,
      fromDate: '2026-10-01',
      toDate: '2026-10-01',
    });

    expect(andWhere).toHaveBeenCalledWith('history.createdAt >= :historyFrom', {
      historyFrom: OCT_1_START,
    });
    expect(andWhere).toHaveBeenCalledWith('history.createdAt <= :historyTo', {
      historyTo: OCT_1_END,
    });
  });
});

describe('onModuleDestroy — fondagi ishlar cheklangan muddat kutiladi', () => {
  it('tugagan ishni kutadi, osilib qolganini 5 s dan keyin tashlaydi', async () => {
    jest.useFakeTimers();
    try {
      const { service } = makeService();
      jest
        .spyOn(service as any, 'syncMarketPaymentsSafely')
        .mockImplementation(() => new Promise(() => undefined));
      jest
        .spyOn(service as any, 'emitSettlementPaymentSafely')
        .mockResolvedValue(undefined);
      void (service as any).scheduleMarketPaymentFollowUp({
        market_id: '201',
        amount: 1,
      });

      let done = false;
      const drain = service.onModuleDestroy().then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(4_000);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1_500);
      await drain;
      expect(done).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
