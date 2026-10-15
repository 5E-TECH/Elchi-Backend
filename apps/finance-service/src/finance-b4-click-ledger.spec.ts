import { BadRequestException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { FinanceServiceService } from './finance-service.service';

/**
 * 4-tur B guruhi (2026-10-14):
 *  • 1bz6tOle — CLICK to'lovlari naqd/karta taqsimotini buzmasin
 *    (FOR_COURIER / FOR_MARKET — qarz hisobi, MAIN/BRANCH — usul bo'yicha);
 *  • gEdrZxMz — click_to_market market kassasi qidiruvida `isDeleted: false`;
 *  • IgR4FVsR — qo'lda kirim/chiqim P&L daftariga AYNI tranzaksiyada.
 */

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
  FinancialSource_type: {
    SELL_PROFIT: 'sell_profit',
    MANUAL_INCOME: 'manual_income',
    MANUAL_EXPENSE: 'manual_expense',
  },
  Order_status: { SOLD: 'sold', PAID: 'paid', PARTLY_PAID: 'partly_paid' },
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
  rmqSend: jest.fn(),
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
// 3PE0B03q — nomli kartalar (servis importi; entity BaseEntity'ga bog'liq).
jest.mock('./entities/cashbox-card.entity', () => ({
  CashboxCard: class CashboxCard {},
}));
jest.mock('./entities/cashbox-card-movement.entity', () => ({
  CashboxCardMovement: class CashboxCardMovement {},
  CardMovementType: {
    CARD_TO_CARD: 'card_to_card',
    CARD_TO_CASH: 'card_to_cash',
    CASH_TO_CARD: 'cash_to_card',
  },
}));

// jest.mock yuqoriga ko'tariladi — bu importlar mock klasslarni oladi.
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';

type Row = Record<string, any>;

function makeEnv() {
  let seq = 0;
  const manager = {
    findOne: jest.fn(),
    save: jest.fn((entity: any) =>
      Promise.resolve(entity?.id ? entity : { ...entity, id: `h-${++seq}` }),
    ),
    create: jest.fn((entity: any, dto: any) => ({ __entity: entity, ...dto })),
    query: jest.fn().mockResolvedValue(undefined),
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
  const dataSource: any = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };
  const activityLog: any = { log: jest.fn().mockResolvedValue(undefined) };
  const orderClient: any = { send: jest.fn(() => of({ statusCode: 200 })) };
  const outbox: any = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const service = new FinanceServiceService(
    { findOne: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { findOne: jest.fn() } as any,
    dataSource,
    activityLog,
    orderClient,
    { send: jest.fn() } as any,
    { send: jest.fn() } as any,
    outbox,
  );
  return { service, manager, queryRunner, activityLog, outbox };
}

const cashbox = (type: string, cash: number, card = 0, extra: Row = {}) => ({
  id: `cb-${type}`,
  user_id: type === 'main' ? '0' : '15',
  cashbox_type: type,
  balance: cash + card,
  balance_cash: cash,
  balance_card: card,
  ...extra,
});

const apply = (
  service: FinanceServiceService,
  box: Row,
  amount: number,
  op: 'income' | 'expense',
  method: unknown,
  override = false,
) => (service as any).updateBalancesByMethod(box, amount, op, method, override);

describe('1bz6tOle — updateBalancesByMethod usul tarmoqlari', () => {
  it('⭐ kuryer: sotuv (CASH) +X, keyin CLICK bilan X to`lov → balance_cash 0, balance_card 0', () => {
    const { service } = makeEnv();
    const courier = cashbox('couriers', 0);

    apply(service, courier, 5_000_000, 'income', 'cash');
    apply(service, courier, 5_000_000, 'expense', 'click');

    // Ilgari: balance_cash = +5 000 000, balance_card = −5 000 000.
    expect(courier).toMatchObject({
      balance: 0,
      balance_cash: 0,
      balance_card: 0,
    });
  });

  it('market (FOR_MARKET) ham qarz hisobi: click_to_market chiqimi karta chelagini manfiyga tushirmaydi', () => {
    const { service } = makeEnv();
    const market = cashbox('markets', 0);

    apply(service, market, 300_000, 'income', 'cash');
    apply(service, market, 100_000, 'expense', 'click_to_market');

    expect(market).toMatchObject({
      balance: 200_000,
      balance_cash: 200_000,
      balance_card: 0,
    });
  });

  it('eski bo`lingan qoldiq (cash +X / card −X) keyingi harakatda jami saqlangan holda yig`iladi', () => {
    const { service } = makeEnv();
    const courier = cashbox('couriers', 400_000, -400_000);

    apply(service, courier, 100_000, 'income', 'cash');

    expect(courier).toMatchObject({
      balance: 100_000,
      balance_cash: 100_000,
      balance_card: 0,
    });
  });

  it('qarz hisobi manfiyga tusha oladi (avvalgidek) — usuldan qat`i nazar', () => {
    const { service } = makeEnv();
    const courier = cashbox('couriers', 0);

    apply(service, courier, 50_000, 'expense', 'click');

    expect(courier).toMatchObject({
      balance: -50_000,
      balance_cash: -50_000,
      balance_card: 0,
    });
  });

  it('MAIN: CLICK chiqimi naqd yetarli bo`lsa ham karta qoldig`idan oshsa → 400', () => {
    const { service } = makeEnv();
    const main = cashbox('main', 1_000_000, 100_000);

    expect(() => apply(service, main, 200_000, 'expense', 'click')).toThrow(
      'Insufficient card balance',
    );
    expect(() =>
      apply(service, main, 200_000, 'expense', 'click_to_market'),
    ).toThrow('Insufficient card balance');
    expect(main).toMatchObject({
      balance_cash: 1_000_000,
      balance_card: 100_000,
    });
  });

  it('BRANCH: CLICK kirimi kartaga, CASH chiqimi naqddan (usul bo`yicha ajratma saqlanadi)', () => {
    const { service } = makeEnv();
    const branch = cashbox('branch', 100_000, 0);

    apply(service, branch, 70_000, 'income', 'click');
    apply(service, branch, 40_000, 'expense', 'cash');

    expect(branch).toMatchObject({
      balance: 130_000,
      balance_cash: 60_000,
      balance_card: 70_000,
    });
  });

  it('noma`lum usul endi kartaga "tushib ketmaydi" → 400', () => {
    const { service } = makeEnv();
    const main = cashbox('main', 0, 500_000);

    expect(() => apply(service, main, 1, 'expense', 'card')).toThrow(
      BadRequestException,
    );
    expect(main.balance_card).toBe(500_000);
  });

  it('usul berilmasa — CASH (updateBalance sukuti bilan bir xil)', () => {
    const { service } = makeEnv();
    const main = cashbox('main', 100, 0);

    apply(service, main, 30, 'income', undefined);

    expect(main).toMatchObject({ balance_cash: 130, balance_card: 0 });
  });
});

describe('1bz6tOle — to`lov oqimlari', () => {
  it('paymentsFromCourier(CLICK): kuryer jami qarzi bilan tekshiriladi, kuryer kassasi 0/0 bo`ladi, MAIN kartaga tushadi', async () => {
    const env = makeEnv();
    const courier = cashbox('couriers', 500_000, 0, { user_id: '209' });
    const main = cashbox('main', 0, 0);
    env.manager.findOne
      .mockResolvedValueOnce(courier)
      .mockResolvedValueOnce(null) // isDuplicateTransfer
      .mockResolvedValueOnce(main);

    const res: any = await env.service.paymentsFromCourier({
      courier_id: '209',
      amount: 500_000,
      payment_method: 'click' as any,
      dedup_epoch: 'tok-1',
    });

    expect(res.statusCode).toBe(201);
    expect(res.data.courier_cashbox).toMatchObject({
      balance: 0,
      balance_cash: 0,
      balance_card: 0,
    });
    expect(res.data.main_cashbox).toMatchObject({
      balance: 500_000,
      balance_cash: 0,
      balance_card: 500_000,
    });
  });

  it('paymentsFromCourier(CLICK): kuryer qarzidan oshsa → 400, pul ko`chmaydi', async () => {
    const env = makeEnv();
    env.manager.findOne
      .mockResolvedValueOnce(
        cashbox('couriers', 100_000, 0, { user_id: '209' }),
      )
      .mockResolvedValueOnce(null);

    const error: unknown = await env.service
      .paymentsFromCourier({
        courier_id: '209',
        amount: 100_001,
        payment_method: 'click' as any,
        dedup_epoch: 'tok-2',
      })
      .catch((caught: unknown) => caught);

    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 400,
    });
    expect(env.manager.save).not.toHaveBeenCalled();
    expect(env.queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('paymentsToMarket(CLICK): MAIN karta qoldig`idan oshsa → 400 va rollback (market kassasi saqlanmaydi)', async () => {
    const env = makeEnv();
    const market = cashbox('markets', 900_000, 0, { user_id: '201' });
    env.manager.findOne
      .mockResolvedValueOnce(cashbox('main', 5_000_000, 100_000))
      .mockResolvedValueOnce(market)
      .mockResolvedValueOnce(null); // isDuplicateTransfer

    const error: unknown = await env.service
      .paymentsToMarket({
        market_id: '201',
        amount: 300_000,
        payment_method: 'click' as any,
        dedup_epoch: 'tok-3',
      })
      .catch((caught: unknown) => caught);

    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 400,
      message: 'Insufficient card balance',
    });
    expect(env.manager.save).not.toHaveBeenCalled();
    expect(env.queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(env.queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(market.balance).toBe(900_000);
  });
});

describe('gEdrZxMz — click_to_market market kassasi', () => {
  it('market kassasi faqat o`chirilmaganlar orasidan qidiriladi (isDeleted: false)', async () => {
    const env = makeEnv();
    env.manager.findOne
      .mockResolvedValueOnce(
        cashbox('couriers', 300_000, 0, { user_id: '209' }),
      )
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cashbox('main', 0, 0))
      .mockResolvedValueOnce(null); // o'chirilmagan market kassasi yo'q

    const error: unknown = await env.service
      .paymentsFromCourier({
        courier_id: '209',
        amount: 300_000,
        payment_method: 'click_to_market' as any,
        market_id: '201',
        dedup_epoch: 'tok-4',
      })
      .catch((caught: unknown) => caught);

    expect(env.manager.findOne).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      expect.objectContaining({
        where: {
          user_id: '201',
          cashbox_type: 'markets',
          isDeleted: false,
        },
      }),
    );
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 404,
    });
    expect(env.manager.save).not.toHaveBeenCalled();
  });
});

describe('IgR4FVsR — qo`lda kirim/chiqim P&L daftariga', () => {
  const fbhSaves = (manager: ReturnType<typeof makeEnv>['manager']) =>
    manager.save.mock.calls
      .map((call) => call[0])
      .filter((row: any) => row?.__entity === FinancialBalanceHistory);

  function primeMain(env: ReturnType<typeof makeEnv>, main: Row) {
    env.manager.findOne.mockImplementation((entity: unknown) => {
      if (entity === FinancialBalanceHistory) {
        return Promise.resolve({ id: '55', balance_after: 1_000_000 });
      }
      if (entity === CashboxHistory) {
        return Promise.resolve(null); // takroriy emas
      }
      return Promise.resolve(main);
    });
    jest
      .spyOn(env.service as any, 'getCashboxBySelectorWithManager')
      .mockResolvedValue(main);
  }

  it('spendMoney(financial_ledger): kassa EXPENSE bilan birga FBH −amount, manual_expense, kalit = cashbox_history id', async () => {
    const env = makeEnv();
    primeMain(env, cashbox('main', 800_000));

    const res: any = await env.service.spendMoney({
      user_id: '1',
      amount: 150_000,
      comment: 'Ijara',
      created_by: '1',
      dedup_epoch: 'idem-1',
      financial_ledger: true,
    });

    const ledger = fbhSaves(env.manager);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      amount: -150_000,
      balance_before: 1_000_000,
      balance_after: 850_000,
      source_type: 'manual_expense',
      dedup_key: 'cashbox-history:h-1',
      order_id: null,
      comment: 'Ijara',
      created_by: '1',
    });
    // Advisory qulf AYNI tranzaksiya menejerida, bitta commit.
    expect(env.manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock($1::bigint)',
      ['947310021'],
    );
    expect(env.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    const fbhSaveOrder =
      env.manager.save.mock.invocationCallOrder[
        env.manager.save.mock.calls.findIndex(
          (call) => call[0]?.__entity === FinancialBalanceHistory,
        )
      ];
    expect(fbhSaveOrder).toBeLessThan(
      env.queryRunner.commitTransaction.mock.invocationCallOrder[0],
    );
    expect(res.data.financial_balance_entry).toMatchObject({
      amount: -150_000,
    });
    expect(env.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'FinancialBalanceHistory',
        action: 'created',
      }),
    );
  });

  it('fillTheCashbox(financial_ledger): +amount, manual_income (filial kassasi ham)', async () => {
    const env = makeEnv();
    primeMain(env, cashbox('branch', 0));

    await env.service.fillTheCashbox({
      user_id: '15',
      amount: 70_000,
      cashbox_type: 'branch' as any,
      created_by: '9',
      dedup_epoch: 'idem-2',
      financial_ledger: true,
    });

    const ledger = fbhSaves(env.manager);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      amount: 70_000,
      balance_after: 1_070_000,
      source_type: 'manual_income',
      dedup_key: 'cashbox-history:h-1',
    });
  });

  it('⭐ FBH yozuvi yiqilsa kassa harakati ham rollback (commit yo`q)', async () => {
    const env = makeEnv();
    primeMain(env, cashbox('main', 800_000));
    const realSave = env.manager.save.getMockImplementation()!;
    env.manager.save.mockImplementation((entity: any) =>
      entity?.__entity === FinancialBalanceHistory
        ? Promise.reject(new Error('fbh insert failed'))
        : realSave(entity),
    );

    await expect(
      env.service.spendMoney({
        user_id: '1',
        amount: 150_000,
        dedup_epoch: 'idem-3',
        financial_ledger: true,
      }),
    ).rejects.toBeInstanceOf(RpcException);

    expect(env.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(env.queryRunner.commitTransaction).not.toHaveBeenCalled();
    // Kassa audit yozuvi ham yo'q (commit bo'lmagan).
    expect(env.activityLog.log).not.toHaveBeenCalled();
  });

  it('flag bo`lmasa (investor to`lovi / kargo remittance) — FBH yozilmaydi (avvalgidek)', async () => {
    const env = makeEnv();
    primeMain(env, cashbox('main', 800_000));

    await env.service.spendMoney({
      user_id: '1',
      amount: 10_000,
      dedup_epoch: 'investor-profit:7',
    });
    await env.service.fillTheCashbox({
      user_id: '1',
      amount: 10_000,
      dedup_epoch: 'remittance:3',
    });

    expect(fbhSaves(env.manager)).toHaveLength(0);
    expect(env.manager.query).not.toHaveBeenCalled();
  });

  it('takroriy so`rov (idempotent) — FBH ham qayta yozilmaydi', async () => {
    const env = makeEnv();
    const main = cashbox('main', 800_000);
    primeMain(env, main);
    env.manager.findOne.mockImplementation((entity: unknown) =>
      Promise.resolve(
        entity === CashboxHistory ? { id: 'h-old', amount: 150_000 } : main,
      ),
    );

    const res: any = await env.service.spendMoney({
      user_id: '1',
      amount: 150_000,
      dedup_epoch: 'idem-1',
      financial_ledger: true,
    });

    expect(res.data.idempotent).toBe(true);
    expect(fbhSaves(env.manager)).toHaveLength(0);
  });

  it('market/kuryer kassasi (qarz hisobi) flag bilan ham P&L ga yozilmaydi', async () => {
    const env = makeEnv();
    primeMain(env, cashbox('markets', 0));

    await env.service.fillTheCashbox({
      user_id: '201',
      amount: 5_000,
      cashbox_type: 'markets' as any,
      dedup_epoch: 'idem-5',
      financial_ledger: true,
    });

    expect(fbhSaves(env.manager)).toHaveLength(0);
  });
});
