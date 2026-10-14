import 'reflect-metadata';
import { isObservable, of, throwError } from 'rxjs';

jest.mock('@app/common', () => ({
  Cashbox_type: {
    BRANCH: 'branch',
    FOR_COURIER: 'couriers',
    FOR_MARKET: 'markets',
    MAIN: 'main',
  },
  FinancialSource_type: { MANUAL_EXPENSE: 'manual_expense' },
  Operation_type: { EXPENSE: 'expense', INCOME: 'income' },
  Order_status: { PAID: 'paid', PARTLY_PAID: 'partly_paid', SOLD: 'sold' },
  PaymentMethod: {
    CASH: 'cash',
    CLICK: 'click',
    CLICK_TO_MARKET: 'click_to_market',
  },
  Roles: {
    SUPERADMIN: 'superadmin',
    ADMIN: 'admin',
    REGISTRATOR: 'registrator',
    COURIER: 'courier',
    MARKET: 'market',
    MANAGER: 'manager',
  },
  Source_type: {
    BRANCH_TO_MAIN: 'branch_to_main',
    COURIER_PAYMENT: 'courier_payment',
    MARKET_PAYMENT: 'market_payment',
  },
  Where_deliver: { CENTER: 'center' },
}));

import { FinanceGatewayController } from './finance-gateway.controller';

/**
 * j8qCkJhV — admin/superadmin filial kassasini ochganda `olinishi_kerak`
 * (kuryerlar filialga qarz) va `berilishi_kerak` (filial HQ'ga qarz) AJRALGAN
 * holda qaytadi. Ilgari ikkala maydonga ham `berilishi_kerak` yozilardi.
 */

type Handler = (payload: any) => unknown;
type Client = { send: jest.Mock };

function route(client: Client, handlers: Record<string, Handler>) {
  client.send.mockImplementation((pattern: { cmd: string }, payload: any) => {
    const handler = handlers[pattern.cmd];
    if (!handler) {
      return throwError(
        () =>
          new Error(
            `kutilmagan RPC: ${pattern.cmd} ${JSON.stringify(payload)}`,
          ),
      );
    }
    const result = handler(payload);
    return isObservable(result) ? result : of(result);
  });
}

const BRANCH_ID = '15';
const branchCashbox = {
  id: '30',
  user_id: BRANCH_ID,
  cashbox_type: 'branch',
  balance: 900_000,
  balance_cash: 900_000,
  balance_card: 0,
};

function setup() {
  const financeClient: Client = { send: jest.fn() };
  const identityClient: Client = { send: jest.fn() };
  const branchClient: Client = { send: jest.fn() };
  const orderClient: Client = { send: jest.fn() };
  const controller = new FinanceGatewayController(
    financeClient as any,
    identityClient as any,
    branchClient as any,
    orderClient as any,
  );

  route(branchClient, {
    'branch.find_by_id': () => ({ data: { id: BRANCH_ID } }),
    'branch.user.find_by_branch': () => ({
      data: [
        { role: 'MANAGER', user_id: '208' },
        { role: 'COURIER', user_id: '209' },
      ],
    }),
  });
  route(identityClient, {
    'identity.user.find_by_id': () => ({ data: { id: '208' } }),
    'identity.courier.find_by_ids': () => ({ data: [{ id: '209' }] }),
    'identity.user.find_by_ids': () => ({ data: [] }),
  });
  route(orderClient, {
    'order.settlement.branch_summary': () => ({
      data: { branch_payable: 500_000, courier_receivable: 120_000 },
    }),
  });
  const findByUser = jest.fn();
  route(financeClient, {
    'finance.cashbox.my': () => ({ data: { cashbox: branchCashbox } }),
    'finance.history.find_all': () => ({
      data: { items: [{ amount: 70_000 }] },
    }),
    'finance.cashbox.find_by_user': (payload) => findByUser(payload),
  });

  return { controller, findByUser };
}

const superadmin = { user: { sub: '9', roles: ['superadmin'] } } as any;

const SETTLEMENT_KEYS = [
  'berilishi_kerak',
  'counterparty',
  'hq_ga_tollangan',
  'kassadagi_summa',
  'olinishi_kerak',
];

describe('j8qCkJhV — filial kassasi: berilishi_kerak / olinishi_kerak ajralgan', () => {
  it('with_history=false: {berilishi_kerak: 500 000, olinishi_kerak: 120 000} — ikkalasi o`z qiymati bilan', async () => {
    const env = setup();
    env.findByUser.mockReturnValue({ statusCode: 200, data: branchCashbox });

    const res: any = await env.controller.findCashboxByUser(
      BRANCH_ID,
      { with_history: false } as any,
      superadmin,
    );

    expect(res.data).toMatchObject({
      kassadagi_summa: 900_000,
      berilishi_kerak: 500_000,
      olinishi_kerak: 120_000,
      hq_ga_tollangan: 70_000,
      counterparty: 'HQ',
    });
    expect(res.data.cashbox).toEqual(branchCashbox);
  });

  it('with_history=true: ayni qiymatlar va ayni maydonlar to`plami', async () => {
    const env = setup();
    env.findByUser.mockReturnValue({
      statusCode: 200,
      data: {
        cashbox: branchCashbox,
        history: [],
        pagination: { total: 0, page: 1, limit: 20, totalPages: 0 },
      },
    });

    const res: any = await env.controller.findCashboxByUser(
      BRANCH_ID,
      { with_history: true } as any,
      superadmin,
    );

    expect(res.data).toMatchObject({
      kassadagi_summa: 900_000,
      berilishi_kerak: 500_000,
      olinishi_kerak: 120_000,
      hq_ga_tollangan: 70_000,
      counterparty: 'HQ',
    });
  });

  it('prod frontend so`rovi cashbox_type=branch: maydonlar ham qo`shiladi', async () => {
    const env = setup();
    env.findByUser.mockReturnValue({ statusCode: 200, data: branchCashbox });

    const res: any = await env.controller.findCashboxByUser(
      BRANCH_ID,
      { cashbox_type: 'branch', with_history: false } as any,
      superadmin,
    );

    expect(res.data).toMatchObject({
      berilishi_kerak: 500_000,
      olinishi_kerak: 120_000,
      hq_ga_tollangan: 70_000,
      counterparty: 'HQ',
    });
  });

  it('ikkala yo`lda hisob-kitob maydonlari to`plami bir xil', async () => {
    const pick = (data: Record<string, unknown>) =>
      Object.keys(data)
        .filter((key) => SETTLEMENT_KEYS.includes(key))
        .sort();

    const withoutHistory = setup();
    withoutHistory.findByUser.mockReturnValue({
      statusCode: 200,
      data: branchCashbox,
    });
    const a: any = await withoutHistory.controller.findCashboxByUser(
      BRANCH_ID,
      { with_history: false } as any,
      superadmin,
    );

    const withHistory = setup();
    withHistory.findByUser.mockReturnValue({
      statusCode: 200,
      data: { cashbox: branchCashbox, history: [], pagination: {} },
    });
    const b: any = await withHistory.controller.findCashboxByUser(
      BRANCH_ID,
      { with_history: true } as any,
      superadmin,
    );

    expect(pick(a.data)).toEqual(SETTLEMENT_KEYS);
    expect(pick(b.data)).toEqual(SETTLEMENT_KEYS);
  });

  it('menejer /cashbox/manager/settlement — hq_ga_tollangan ham qaytadi', async () => {
    const env = setup();
    const manager = {
      user: { sub: '208', roles: ['manager'], branch_id: BRANCH_ID },
    } as any;

    const res: any = await env.controller.managerSettlement(manager, {} as any);

    expect(res.data).toMatchObject({
      berilishi_kerak: 500_000,
      olinishi_kerak: 120_000,
      hq_ga_tollangan: 70_000,
    });
  });
});
