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

  it('allows managers to create branch-to-main payments (scoped to own branch)', () => {
    // Audit I5: managers now have a real branch→HQ settle action — they were
    // previously locked out with no way to record remitting their branch's cash.
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      FinanceGatewayController.prototype.paymentBranchToMain,
    );

    expect(roles).toEqual(['superadmin', 'admin', 'manager']);
  });

  it('forbids a manager remitting another branch to HQ', async () => {
    const { controller } = setup();
    const req = {
      user: { sub: 'm1', roles: ['manager'], branch_id: 'B1' },
    } as any;

    // Manager belongs to B1 but tries to remit B2 → rejected before any send.
    await expect(
      controller.paymentBranchToMain(req, {
        branch_id: 'B2',
        amount: 1000,
        payment_method: 'cash',
      } as any),
    ).rejects.toThrow();
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

  it('shows manager branch-to-HQ history from the branch cashbox', async () => {
    const { controller, financeClient } = setup();
    const req = {
      user: { sub: 'manager-1', roles: ['manager'], branch_id: '16' },
    } as any;
    financeClient.send.mockReturnValue(of({ data: { items: [] } }));

    await controller.findHistory(
      {
        user_id: 'manager-1',
        cashbox_type: 'main',
        source_type: 'branch_to_main',
        page: 1,
        limit: 100,
      } as any,
      req,
    );

    expect(financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.history.find_all' },
      expect.objectContaining({
        user_id: '16',
        cashbox_type: 'branch',
        source_type: 'branch_to_main',
        operation_type: 'expense',
        page: 1,
        limit: 100,
      }),
    );
  });

  it('scopes market payment history to the current market cashbox', async () => {
    const { controller, financeClient } = setup();
    const req = {
      user: { sub: '16', roles: ['market'] },
    } as any;
    financeClient.send.mockReturnValue(of({ data: { items: [] } }));

    await controller.findHistory({ cashbox_type: 'main' } as any, req);

    expect(financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.history.find_all' },
      expect.objectContaining({
        user_id: '16',
        cashbox_type: 'for_market',
      }),
    );
  });

  it('requests the market cashbox explicitly for my cashbox', async () => {
    const { controller, financeClient } = setup();
    const req = {
      user: { sub: '3', role: 'market' },
    } as any;
    financeClient.send.mockReturnValue(of({ data: { cashboxHistory: [] } }));

    await controller.myCashbox(req, {} as any);

    expect(financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.my' },
      expect.objectContaining({
        user_id: '3',
        roles: ['market'],
        cashbox_type: 'for_market',
      }),
    );
  });

  it('scopes courier payment history to the current courier cashbox', async () => {
    const { controller, financeClient } = setup();
    const req = {
      user: { sub: '8', roles: ['courier'] },
    } as any;
    financeClient.send.mockReturnValue(of({ data: { items: [] } }));

    await controller.findHistory({ cashbox_type: 'main' } as any, req);

    expect(financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.history.find_all' },
      expect.objectContaining({
        user_id: '8',
        cashbox_type: 'for_courier',
      }),
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

  it('forbids market users from opening non-market cashbox history details', async () => {
    const { controller, financeClient } = setup();
    const req = {
      user: { sub: '16', roles: ['market'] },
    } as any;
    financeClient.send.mockReturnValue(
      of({
        data: {
          id: 'history-branch',
          cashbox: { user_id: '16', cashbox_type: 'branch' },
        },
      }),
    );

    await expect(controller.findHistoryById('1', req)).rejects.toThrow(
      "Siz faqat o'zingizning kassa tarixingizni ko'ra olasiz",
    );
  });
});
