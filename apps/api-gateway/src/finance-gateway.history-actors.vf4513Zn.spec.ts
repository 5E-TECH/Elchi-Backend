import 'reflect-metadata';
import { of } from 'rxjs';
import { FinanceGatewayController } from './finance-gateway.controller';

/**
 * vf4513Zn (prod tester, 2026-10-25) — gateway `attachCreatedByUsers`
 * kassa tarixidagi `created_by_user` / `createdByUser` ni identity'ning
 * TO'LIQ yozuvi bilan USTIDAN yozardi (finance minimal bersa ham): market 37
 * my-cashbox'da kuryer 26 ning `tariff_home`/`salary` sini ko'rardi. Endi
 * har qanday rol yo'lida (kuryer/market/menejer my-cashbox, GET
 * /finance/history, superadmin cashbox/main) — faqat
 * `{id, name, role, phone_number}`.
 */
const FULL_USERS: Record<string, Record<string, unknown>> = {
  '25': {
    id: '25',
    name: 'TEST Claude Menejer',
    phone_number: '+998900000025',
    role: 'manager',
    status: 'active',
    salary: 7_000_000,
    payment_day: 5,
    username: 'menejer25',
  },
  '26': {
    id: '26',
    name: 'TEST Claude Kuryer',
    phone_number: '+998900000026',
    role: 'courier',
    status: 'active',
    tariff_home: 15_000,
    tariff_center: 12_000,
    salary: 3_000_000,
    payment_day: 10,
    compensation_mode: 'tariff',
  },
  '37': {
    id: '37',
    name: 'TEST Claude Market',
    phone_number: '+998900000037',
    role: 'market',
    status: 'active',
    tariff_home: 20_000,
    tariff_center: 20_000,
    default_tariff: 'center',
    compensation_mode: 'tariff',
    salary: 0,
    payment_day: 1,
    commission_type: 'percent',
    commission_value: 5,
    ai_price_per_order: 300,
  },
};

const ALLOWED = ['id', 'name', 'phone_number', 'role'];
const MONEY = /tariff|salary|commission|payment_day|compensation|price|token/i;
const USER_KEYS = [
  'source_user',
  'sourceUser',
  'created_by_user',
  'createdByUser',
  'user',
];

/** Javob daraxtidagi barcha foydalanuvchi obyektlari (`USER_KEYS` ostida). */
const nestedUsers = (
  value: unknown,
  out: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    value.forEach((item) => nestedUsers(item, out));
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (USER_KEYS.includes(key) && nested && typeof nested === 'object') {
        out.push(nested as Record<string, unknown>);
      }
      nestedUsers(nested, out);
    }
  }
  return out;
};

const expectMinimal = (payload: unknown, minCount: number) => {
  const found = nestedUsers(payload);
  expect(found.length).toBeGreaterThanOrEqual(minCount);
  for (const user of found) {
    expect(Object.keys(user).sort()).toEqual(ALLOWED);
    expect(Object.keys(user).filter((key) => MONEY.test(key))).toEqual([]);
  }
};

/** Finance javobi — tarix qatorlari (finance allaqachon minimal beradi). */
const historyRow = (over: Record<string, unknown>) => ({
  id: '110',
  cashbox_id: '21',
  operation_type: 'expense',
  amount: 30_000,
  source_user: null,
  sourceUser: null,
  ...over,
});

const setup = (financeResponse: unknown) => {
  const finance = { send: jest.fn(() => of(financeResponse)) };
  const identity = {
    send: jest.fn((_pattern: unknown, payload: { id: string }) =>
      of({ statusCode: 200, data: FULL_USERS[String(payload.id)] ?? null }),
    ),
  };
  const controller = new FinanceGatewayController(
    finance as never,
    identity as never,
    { send: jest.fn() } as never,
    { send: jest.fn() } as never,
  );
  return { controller, finance, identity };
};

type Res = { data: Record<string, any> };

describe('vf4513Zn — gateway created_by_user minimal (kassa tarixi)', () => {
  it('⭐ market 37 my-cashbox: kuryer 26 (created_by_user) — faqat {id, name, role, phone_number}', async () => {
    const { controller } = setup({
      statusCode: 200,
      data: {
        cashbox: { id: '16', user_id: '37', cashbox_type: 'markets' },
        cashboxHistory: [
          historyRow({ source_type: 'market_payment', created_by: '26' }),
        ],
      },
    });

    const res = (await controller.myCashbox(
      { user: { sub: '37', roles: ['market'] } } as never,
      {} as never,
    )) as unknown as Res;

    const [row] = res.data.cashboxHistory;
    expect(row.created_by_user).toEqual({
      id: '26',
      name: 'TEST Claude Kuryer',
      role: 'courier',
      phone_number: '+998900000026',
    });
    expect(row.createdByUser).toEqual(row.created_by_user);
    expectMinimal(res.data, 2);
  });

  it('kuryer 26 my-cashbox: menejer/market yaratuvchisi — maosh/tarif yo`q', async () => {
    const { controller } = setup({
      statusCode: 200,
      data: {
        cashbox: { id: '21', user_id: '26', cashbox_type: 'couriers' },
        cashboxHistory: [
          historyRow({ source_type: 'courier_payment', created_by: '25' }),
          historyRow({ id: '111', source_type: 'sell', created_by: '37' }),
        ],
      },
    });

    const res = (await controller.myCashbox(
      { user: { sub: '26', roles: ['courier'] } } as never,
      {} as never,
    )) as unknown as Res;

    expect(res.data.cashboxHistory[0].created_by_user).toMatchObject({
      id: '25',
      role: 'manager',
    });
    expect(res.data.cashboxHistory[1].created_by_user).toMatchObject({
      id: '37',
      name: 'TEST Claude Market',
    });
    expectMinimal(res.data, 4);
  });

  it('menejer my-cashbox (filial kassasi): xodimlar minimal', async () => {
    const { controller, finance } = setup({
      statusCode: 200,
      data: {
        cashbox: { id: '20', user_id: '3', cashbox_type: 'branch' },
        cashboxHistory: [
          historyRow({ source_type: 'courier_payment', created_by: '26' }),
        ],
      },
    });

    const res = (await controller.myCashbox(
      { user: { sub: '25', roles: ['manager'], branch_id: '3' } } as never,
      {} as never,
    )) as unknown as Res;

    expect(finance.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.my' },
      expect.objectContaining({ user_id: '25', branch_id: '3' }),
    );
    expectMinimal(res.data, 2);
  });

  it.each([
    ['courier', '26'],
    ['market', '37'],
  ])(
    'GET /finance/history (%s) — items[].created_by_user minimal',
    async (role, sub) => {
      const { controller } = setup({
        statusCode: 200,
        data: {
          items: [historyRow({ source_type: 'sell', created_by: '25' })],
          pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
        },
      });

      const res = (await controller.findHistory(
        {} as never,
        { user: { sub, roles: [role] } } as never,
      )) as unknown as Res;

      expect(res.data.items[0].created_by_user).toEqual({
        id: '25',
        name: 'TEST Claude Menejer',
        role: 'manager',
        phone_number: '+998900000025',
      });
      expectMinimal(res.data, 2);
    },
  );

  it('superadmin cashbox/main: menejer kiritgan courier_payment filtri `role` bo`yicha ishlaydi (rol saqlanadi)', async () => {
    const { controller } = setup({
      statusCode: 200,
      data: {
        cashbox: { id: '1', user_id: '0', cashbox_type: 'main' },
        cashboxHistory: [
          historyRow({
            id: '1',
            source_type: 'courier_payment',
            operation_type: 'income',
            created_by: '25',
          }),
          historyRow({
            id: '2',
            source_type: 'manual_income',
            operation_type: 'income',
            created_by: '26',
          }),
        ],
      },
    });

    const res = (await controller.getMainCashbox(
      {} as never,
      { user: { sub: '1', roles: ['superadmin'] } } as never,
    )) as unknown as Res;

    // Menejer kiritgan kuryer to'lovi (filial ichidagi) MAIN ro'yxatidan chiqadi.
    expect(
      res.data.cashboxHistory.map((row: { id: string }) => row.id),
    ).toEqual(['2']);
    expectMinimal(res.data, 2);
  });
});
