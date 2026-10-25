import 'reflect-metadata';
import { of } from 'rxjs';

jest.mock('@app/common', () => ({
  // vf4513Zn — tarixdagi foydalanuvchi proyeksiyasi (sof funksiya) haqiqiy.
  ...jest.requireActual('@app/common/security/user-summary'),
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
 * IgR4FVsR — qo'lda kirim/chiqim marshrutlari finance'ga `financial_ledger:
 * true` yuboradi: kassa harakati P&L daftariga AYNI tranzaksiyada yoziladi
 * (alohida POST /financial-balance/entries kerak emas). Menejer (filial
 * kassasi) ham.
 */
function setup() {
  const financeClient = {
    send: jest.fn(() => of({ statusCode: 200, data: {} })),
  };
  const controller = new FinanceGatewayController(
    financeClient as any,
    { send: jest.fn() } as any,
    { send: jest.fn() } as any,
    { send: jest.fn() } as any,
  );
  return { controller, financeClient };
}

const superadmin = { user: { sub: '9', roles: ['superadmin'] } } as any;
const manager = {
  user: { sub: '208', roles: ['manager'], branch_id: '15' },
} as any;

describe('IgR4FVsR — gateway qo`lda kirim/chiqim P&L bayrog`i', () => {
  it('spend (admin, MAIN) — financial_ledger: true', async () => {
    const env = setup();
    await env.controller.spendMoney(
      superadmin,
      { amount: 150_000, comment: 'Ijara' } as any,
      'idem-1',
    );

    expect(env.financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.spend' },
      expect.objectContaining({
        amount: 150_000,
        created_by: '9',
        financial_ledger: true,
      }),
    );
  });

  it('fill (menejer, BRANCH) — financial_ledger: true va cashbox_type branch', async () => {
    const env = setup();
    await env.controller.fillCashbox(
      manager,
      { amount: 70_000 } as any,
      'idem-2',
    );

    expect(env.financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.fill' },
      expect.objectContaining({
        user_id: '15',
        cashbox_type: 'branch',
        financial_ledger: true,
      }),
    );
  });
});
