import 'reflect-metadata';
import { of } from 'rxjs';

jest.mock('@app/common', () => ({
  Cashbox_type: {
    BRANCH: 'branch',
    FOR_COURIER: 'for_courier',
    FOR_MARKET: 'for_market',
    MAIN: 'main',
  },
  FinancialSource_type: { MANUAL_EXPENSE: 'manual_expense' },
  Operation_type: { EXPENSE: 'expense', INCOME: 'income' },
  Order_status: { PAID: 'paid', PARTLY_PAID: 'partly_paid', SOLD: 'sold' },
  PaymentMethod: { CASH: 'cash' },
  Roles: {
    SUPERADMIN: 'superadmin',
    ADMIN: 'admin',
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
import { ROLES_KEY } from './auth/roles.decorator';

describe('FinanceGatewayController', () => {
  function setup() {
    const financeClient = { send: jest.fn() };
    const identityClient = { send: jest.fn() };
    const branchClient = { send: jest.fn() };
    const orderClient = { send: jest.fn() };
    const controller = new FinanceGatewayController(
      financeClient as any,
      identityClient as any,
      branchClient as any,
      orderClient as any,
    );

    return { controller, financeClient, branchClient };
  }

  it('does not allow managers to create branch-to-main payments', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      FinanceGatewayController.prototype.paymentBranchToMain,
    );

    expect(roles).toEqual(['superadmin', 'admin']);
  });

  it('shows all payment history from the manager branch cashbox', async () => {
    const { controller, financeClient } = setup();
    const req = {
      user: { sub: 'manager-1', roles: ['manager'], branch_id: '16' },
    } as any;
    financeClient.send.mockReturnValue(of({ data: { items: [] } }));

    await controller.findHistory(
      {
        user_id: '999',
        cashbox_type: 'main',
        source_type: 'courier_payment',
      } as any,
      req,
    );

    expect(financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.history.find_all' },
      expect.objectContaining({
        user_id: '16',
        cashbox_type: 'branch',
        source_type: 'courier_payment',
      }),
    );
    expect(financeClient.send.mock.calls[0][1]).not.toHaveProperty(
      'operation_type',
    );
  });

  it('resolves manager user ID to their branch cashbox without 403', async () => {
    const { controller, financeClient, branchClient } = setup();
    const req = {
      user: { sub: '2', roles: ['manager'], branch_id: '16' },
    } as any;
    branchClient.send.mockReturnValue(of({ data: { branch_id: '16' } }));
    financeClient.send.mockReturnValue(
      of({
        data: {
          cashbox: { user_id: '16', cashbox_type: 'branch' },
          history: [],
        },
      }),
    );

    await controller.findCashboxByUser(
      '2',
      { with_history: true, page: 1, limit: 100 } as any,
      req,
    );

    expect(financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.find_by_user' },
      {
        user_id: '16',
        with_history: true,
        page: 1,
        limit: 100,
        cashbox_type: 'branch',
      },
    );
  });

  it('allows a manager to open only their branch history detail', async () => {
    const { controller, financeClient } = setup();
    const req = {
      user: { sub: '2', roles: ['manager'], branch_id: '16' },
    } as any;
    financeClient.send.mockReturnValue(
      of({
        data: {
          id: 'history-1',
          cashbox: { user_id: '16', cashbox_type: 'branch' },
        },
      }),
    );

    await expect(controller.findHistoryById('1', req)).resolves.toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ id: 'history-1' }),
      }),
    );

    financeClient.send.mockReturnValue(
      of({
        data: {
          id: 'history-2',
          cashbox: { user_id: '99', cashbox_type: 'branch' },
        },
      }),
    );

    await expect(controller.findHistoryById('2', req)).rejects.toThrow(
      "Siz faqat o'z branch'ingiz tarixini ko'ra olasiz",
    );
  });
});
