import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { isObservable, of, throwError } from 'rxjs';
import { FinanceGatewayController } from './finance-gateway.controller';
import { collectRouteRoles } from './auth/route-roles';

/**
 * qzjTMWPb / uzWcMR1C — yangi o'qish endpointlari (gateway qismi):
 *   GET /finance/history/daily          — rol doirasi /finance/history bilan AYNI;
 *   GET /finance/financial-balance/daily — superadmin/admin, o'zgarishsiz uzatadi;
 *   GET /finance/cashbox/payments-meta   — filiallar (all-info manbasi) + HQ
 *                                          kuryerlari (hq-couriers to'plami) +
 *                                          finance-service market agregati.
 * Mock'lar `cmd` bo'yicha javob beradi; kutilmagan RPC — test yiqiladi.
 */
type Handler = (payload: any) => unknown;
type Client = { send: jest.Mock };

const client = (): Client => ({ send: jest.fn() });

function route(target: Client, handlers: Record<string, Handler>) {
  target.send.mockImplementation((pattern: { cmd: string }, payload: any) => {
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

const setup = () => {
  const finance = client();
  const identity = client();
  const branch = client();
  const order = client();
  const controller = new FinanceGatewayController(
    finance as never,
    identity as never,
    branch as never,
    order as never,
  );
  return { controller, finance, identity, branch, order };
};

const user = (roles: string[], extra: Record<string, unknown> = {}) => ({
  user: { sub: '26', roles, ...extra },
});

const dailyPayloads = (finance: Client) =>
  finance.send.mock.calls
    .filter((call: any[]) => call[0]?.cmd === 'finance.history.daily')
    .map((call: any[]) => call[1]);

describe('qzjTMWPb — GET /finance/history/daily (rol doirasi)', () => {
  const filters = {
    from_date: '2026-10-01',
    to_date: '2026-10-08',
    source_types: 'sell,cancel',
  };

  it('@Roles — /finance/history bilan AYNI ro‘yxat (logist yo‘q)', () => {
    const map = collectRouteRoles([FinanceGatewayController]);
    expect(map.get('FinanceGatewayController_historyDaily')).toEqual(
      map.get('FinanceGatewayController_findHistory'),
    );
    expect(map.get('FinanceGatewayController_historyDaily')).not.toContain(
      'logist',
    );
    expect(map.get('FinanceGatewayController_financialBalanceDaily')).toEqual(
      map.get('FinanceGatewayController_financialBalanceHistory'),
    );
    expect(map.get('FinanceGatewayController_paymentsMeta')).toEqual([
      'superadmin',
      'admin',
    ]);
  });

  it('superadmin: tanlovsiz — Asosiy kassa; tanlov bilan — o‘zgarishsiz', async () => {
    const { controller, finance } = setup();
    route(finance, {
      'finance.history.daily': () => ({ statusCode: 200, data: {} }),
    });
    await controller.historyDaily(
      { ...filters } as never,
      user(['superadmin']) as never,
    );
    await controller.historyDaily(
      { ...filters, user_id: '37', cashbox_type: 'markets' } as never,
      user(['admin']) as never,
    );
    expect(dailyPayloads(finance)).toEqual([
      expect.objectContaining({ ...filters, cashbox_type: 'main' }),
      expect.objectContaining({
        ...filters,
        user_id: '37',
        cashbox_type: 'markets',
      }),
    ]);
  });

  it('market / kuryer: faqat o‘z kassasi (user_id / cashbox_id e’tiborsiz)', async () => {
    const { controller, finance } = setup();
    route(finance, {
      'finance.history.daily': () => ({ statusCode: 200, data: {} }),
    });
    await controller.historyDaily(
      { cashbox_id: '1', user_id: '999', cashbox_type: 'main' } as never,
      user(['market'], { sub: '37' }) as never,
    );
    await controller.historyDaily(
      { user_id: '999' } as never,
      user(['courier'], { sub: '26' }) as never,
    );
    const [market, courier] = dailyPayloads(finance);
    expect(market).toMatchObject({ user_id: '37', cashbox_type: 'markets' });
    expect(market.cashbox_id).toBeUndefined();
    expect(courier).toMatchObject({ user_id: '26', cashbox_type: 'couriers' });
  });

  it('menejer: o‘z filiali kassasi; begona tanlov filialga almashtiriladi', async () => {
    const { controller, finance } = setup();
    route(finance, {
      'finance.history.daily': () => ({ statusCode: 200, data: {} }),
    });
    await controller.historyDaily(
      { cashbox_type: 'main' } as never,
      user(['manager'], { sub: '25', branch_id: '3' }) as never,
    );
    expect(dailyPayloads(finance)[0]).toMatchObject({
      user_id: '3',
      cashbox_type: 'branch',
    });
  });

  it('menejer: o‘z filiali kuryeri — ruxsat; begona kuryer — 403, finance chaqirilmaydi', async () => {
    const { controller, finance, branch, identity } = setup();
    route(finance, {
      'finance.history.daily': () => ({ statusCode: 200, data: {} }),
    });
    route(branch, {
      'branch.user.find_by_user': (p: { user_id: string }) => ({
        data:
          p.user_id === '26'
            ? { branch_id: '3', role: 'COURIER' }
            : { branch_id: '9', role: 'COURIER' },
      }),
      'branch.user.find_by_branch': () => ({ data: [] }),
      'branch.cashbox.resolve_for_manager': () => ({ data: null }),
    });
    route(identity, {
      'identity.user.find_by_id': (p: { id: string }) => ({
        data: {
          id: p.id,
          branch_id: p.id === '26' ? '3' : '9',
          roles: ['courier'],
        },
      }),
    });
    await controller.historyDaily(
      { user_id: '26', cashbox_type: 'couriers' } as never,
      user(['manager'], { sub: '25', branch_id: '3' }) as never,
    );
    expect(dailyPayloads(finance)[0]).toMatchObject({
      user_id: '26',
      cashbox_type: 'couriers',
    });

    finance.send.mockClear();
    await expect(
      controller.historyDaily(
        { user_id: '44', cashbox_type: 'couriers' } as never,
        user(['manager'], { sub: '25', branch_id: '3' }) as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(dailyPayloads(finance)).toEqual([]);
  });

  it('registrator: o‘z filiali; filialsiz — 403', async () => {
    const { controller, finance, branch } = setup();
    route(finance, {
      'finance.history.daily': () => ({ statusCode: 200, data: {} }),
    });
    route(branch, { 'branch.user.find_by_user': () => ({ data: null }) });
    await controller.historyDaily(
      {} as never,
      user(['registrator'], { branch_id: '3' }) as never,
    );
    expect(dailyPayloads(finance)[0]).toMatchObject({
      user_id: '3',
      cashbox_type: 'branch',
    });
    await expect(
      controller.historyDaily({} as never, user(['registrator']) as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('qzjTMWPb — GET /finance/financial-balance/daily', () => {
  it('faqat sanalarni uzatadi', async () => {
    const { controller, finance } = setup();
    route(finance, {
      'finance.financial_balance.daily': (p) => ({ statusCode: 200, data: p }),
    });
    const res = await controller.financialBalanceDaily({
      from_date: '2026-10-01',
      to_date: '2026-10-08',
    } as never);
    expect(res).toEqual({
      statusCode: 200,
      data: { from_date: '2026-10-01', to_date: '2026-10-08' },
    });
  });
});

describe('uzWcMR1C — GET /finance/cashbox/payments-meta', () => {
  const branches = {
    data: {
      items: [
        { id: '1', type: 'HQ', olinishi_kerak: 1_100_000 },
        { id: '3', type: 'REGIONAL', olinishi_kerak: 5_000_000 },
        { id: '4', type: 'REGIONAL', olinishi_kerak: 3_770_000 },
        { id: '5', type: 'REGIONAL', olinishi_kerak: 0 },
        { id: '6', type: 'REGIONAL', olinishi_kerak: -10 },
      ],
    },
  };
  const payable = {
    markets_count: 6,
    amount: 13_458_000,
    top_markets: [
      { market_id: '37', name: 'Baraka Shop', amount: 4_800_000, share: 35.7 },
    ],
    others: { count: 5, amount: 8_658_000, share: 64.3 },
  };

  it('filiallar (musbat, HQ’siz) + HQ kuryerlari (HQ COURIER id’lari) + market agregati', async () => {
    const { controller, finance, branch } = setup();
    route(branch, {
      'branch.find_all': () => branches,
      'branch.find_hq': () => ({ data: { id: '1' } }),
      'branch.user.find_by_branch': () => ({
        data: [
          { user_id: '119', role: 'COURIER' },
          { user_id: '120', role: 'courier' },
          { user_id: '119', role: 'COURIER' },
          { user_id: '25', role: 'MANAGER' },
        ],
      }),
    });
    route(finance, {
      'finance.cashbox.payments_meta': (p) => {
        expect(p).toEqual({ hq_courier_ids: ['119', '120'], top: 2 });
        return {
          data: { payable, hq_couriers: { count: 2, amount: 1_100_000 } },
        };
      },
    });
    const res = await controller.paymentsMeta(
      { top: 2 } as never,
      user(['superadmin']) as never,
    );
    expect(res.data).toEqual({
      receivable: {
        amount: 9_870_000,
        branches: { count: 2, amount: 8_770_000 },
        hq_couriers: { count: 2, amount: 1_100_000 },
      },
      payable,
    });
  });

  it('branch-service yiqilsa — filial/HQ bloklari null, market agregati baribir qaytadi', async () => {
    const { controller, finance, branch } = setup();
    route(branch, {});
    route(finance, {
      'finance.cashbox.payments_meta': (p) => {
        expect(p).toEqual({ hq_courier_ids: [], top: 3 });
        return { data: { payable, hq_couriers: { count: 0, amount: 0 } } };
      },
    });
    const res = await controller.paymentsMeta(
      {} as never,
      user(['admin']) as never,
    );
    expect(res.data.receivable).toEqual({
      amount: 0,
      branches: null,
      hq_couriers: null,
    });
    expect(res.data.payable).toEqual(payable);
  });
});
