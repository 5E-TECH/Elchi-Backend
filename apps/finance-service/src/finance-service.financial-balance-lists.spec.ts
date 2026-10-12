import { Logger } from '@nestjs/common';
import { FinanceServiceService } from './finance-service.service';

/**
 * G1 (2026-10-09 prod UI testi, znD3KaZL topilmasi) — /financial-balance:
 * "Kuryerlar bilan hisob-kitob 0 ta / Ma'lumot topilmadi", lekin "jami
 * 90 000 UZS"; "Marketlar 0 ta", lekin "jami -240 000 UZS".
 *
 * Sabab backendda: `couriers.allCourierCashboxes` doim `[]` deb qotirilgan,
 * `markets.allMarketCashboxes` esa perf commit'ida (d3c83af6) "hech bir
 * klient o'qimaydi" deb olib tashlangan — holbuki Elchi-Frontend
 * `normalizeFinancialBalance` aynan shu massivlarni o'qib "Marketlar" va
 * "Kuryerlar" ro'yxatlarini chizadi. Jami SQL SUM'dan keladi, ro'yxat esa
 * yo'q — UI o'zaro zid ikki raqam ko'rsatadi.
 *
 * Tuzatish: gateway (`include_party_lists: true`) so'raganda balansi NOL
 * BO'LMAGAN kassalar chegaralangan ro'yxat bo'lib, egasining nomi bilan
 * qaytadi; Σ ro'yxat == jami. Analytics (flag'siz) eski, ro'yxatsiz javobni
 * oladi — perf tuzatishi saqlanadi.
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
    SELL: 'sell',
  },
  FinancialSource_type: { SELL_PROFIT: 'sell_profit' },
  PaymentMethod: { CASH: 'cash', CARD: 'card' },
  Commission_type: { PERCENT: 'percent', FIXED: 'fixed' },
  ActivityAction: {
    CREATED: 'created',
    DELETED: 'deleted',
    UPDATED: 'updated',
    PAYMENT: 'payment',
    STATUS_CHANGE: 'status_change',
  },
  ActivityLogService: class {},
  captureException: jest.fn(),
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

interface FakeCashbox {
  id: string;
  user_id: string;
  cashbox_type: string;
  balance: number;
  balance_cash: number;
  balance_card: number;
  isDeleted: boolean;
}

const cashbox = (
  id: string,
  userId: string,
  type: string,
  balance: number,
  isDeleted = false,
): FakeCashbox => ({
  id,
  user_id: userId,
  cashbox_type: type,
  balance,
  balance_cash: balance,
  balance_card: 0,
  isDeleted,
});

/**
 * `cashboxes` jadvalining kichik simulyatori: `sumCashboxBalanceByType`
 * (getRawOne) va ro'yxat so'rovi (getManyAndCount) bir xil qatorlardan
 * hisoblanadi — Σ ro'yxat == jami invarianti shu bilan tekshiriladi.
 */
function makeCashboxQueryBuilder(rows: FakeCashbox[]) {
  const state: {
    params: Record<string, unknown>;
    wheres: string[];
    orderBys: string[];
    limit?: number;
  } = { params: {}, wheres: [], orderBys: [] };

  const filtered = () =>
    rows.filter((row) => {
      if (row.cashbox_type !== state.params.cashboxType) return false;
      if (state.params.active === false && row.isDeleted) return false;
      if (state.wheres.some((w) => /balance\s*<>\s*0/.test(w))) {
        return Number(row.balance) !== 0;
      }
      return true;
    });

  const qb: any = {
    state,
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    where: jest.fn((sql: string, params?: Record<string, unknown>) => {
      state.wheres.push(sql);
      Object.assign(state.params, params ?? {});
      return qb;
    }),
    andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
      state.wheres.push(sql);
      Object.assign(state.params, params ?? {});
      return qb;
    }),
    orderBy: jest.fn((sql: string) => {
      state.orderBys.push(sql);
      return qb;
    }),
    addOrderBy: jest.fn((sql: string) => {
      state.orderBys.push(sql);
      return qb;
    }),
    limit: jest.fn((n: number) => {
      state.limit = n;
      return qb;
    }),
    take: jest.fn((n: number) => {
      state.limit = n;
      return qb;
    }),
    getRawOne: jest.fn(() =>
      Promise.resolve({
        total: String(
          filtered().reduce((sum, row) => sum + Number(row.balance), 0),
        ),
      }),
    ),
    getManyAndCount: jest.fn(() => {
      const all = filtered();
      const sorted = state.orderBys.some((o) => /ABS\(/i.test(o))
        ? [...all].sort(
            (a, b) => Math.abs(Number(b.balance)) - Math.abs(Number(a.balance)),
          )
        : all;
      return Promise.resolve([
        state.limit === undefined ? sorted : sorted.slice(0, state.limit),
        all.length,
      ]);
    }),
  };
  return qb;
}

const IDENTITY_USERS: Record<string, Record<string, unknown>> = {
  // Kuryerlar
  '19': {
    id: '19',
    name: 'Kuryer Ali',
    phone_number: '+998901112233',
    region_id: '1',
    role: 'courier',
    // identity sanitize'dan o'tgan, lekin ro'yxatga KERAK EMAS maydonlar.
    salary: 3_000_000,
    settings: { secret: true },
  },
  '21': {
    id: '21',
    name: 'Kuryer Vali',
    phone_number: '+998901112244',
    region_id: '2',
    role: 'courier',
  },
  // Marketlar
  '16': {
    id: '16',
    name: 'Market A',
    phone_number: '+998907770016',
    role: 'market',
    tariff_home: 25_000,
  },
  '11': {
    id: '11',
    name: 'Market B',
    phone_number: '+998907770011',
    role: 'market',
  },
};

function makeEnv(
  rows: FakeCashbox[],
  opts: { identityFails?: boolean; listQueryFails?: boolean } = {},
) {
  const qbs: any[] = [];
  const cashboxRepo: any = {
    findOne: jest.fn().mockResolvedValue({
      id: '3',
      user_id: '0',
      cashbox_type: 'main',
      balance: 45_000,
    }),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(() => {
      const qb = makeCashboxQueryBuilder(rows);
      if (opts.listQueryFails) {
        qb.getManyAndCount = jest.fn().mockRejectedValue(new Error('db down'));
      }
      qbs.push(qb);
      return qb;
    }),
  };

  rmqSendMock.mockReset();
  rmqSendMock.mockImplementation(
    (_client: unknown, pattern: { cmd: string }, payload: any) => {
      switch (pattern?.cmd) {
        case 'order.settlement.financial_balance_summary':
          return Promise.resolve({
            data: {
              chain_receivable: 260_000,
              branch_receivable: 260_000,
              hq_receivable: 0,
              branches: [{ branch_id: '3', amount: 260_000 }],
            },
          });
        case 'integration.receivable.outstanding_total':
          return Promise.resolve({ data: { outstanding_amount: 0 } });
        case 'identity.courier.find_by_ids':
        case 'identity.market.find_by_ids': {
          if (opts.identityFails) {
            return Promise.reject(new Error('identity timeout'));
          }
          const role =
            pattern.cmd === 'identity.courier.find_by_ids'
              ? 'courier'
              : 'market';
          const ids: string[] = payload?.ids ?? [];
          return Promise.resolve({
            success: true,
            data: ids
              .map((id) => IDENTITY_USERS[id])
              .filter((user) => user && user.role === role),
          });
        }
        default:
          return Promise.resolve({ data: {} });
      }
    },
  );

  const integrationClient: any = {};
  const service = new FinanceServiceService(
    cashboxRepo,
    {} as any, // historyRepo
    {} as any, // shiftRepo
    {} as any, // salaryRepo
    {} as any, // earningRepo
    {} as any, // paymentRepo
    {} as any, // financialHistoryRepo
    {} as any, // dataSource
    { log: jest.fn() } as any,
    {} as any, // orderClient
    integrationClient,
    {} as any, // identityClient
    { enqueue: jest.fn() } as any,
  );
  return { service, cashboxRepo, qbs };
}

/** 2026-10-09 prod holati: kuryerlarda jami 90 000, marketlarga 240 000. */
const PROD_LIKE_ROWS: FakeCashbox[] = [
  cashbox('9', '26', 'couriers', 0), // TEST Claude Kuryer — 0, ro'yxatda yo'q
  cashbox('5', '19', 'couriers', 60_000),
  cashbox('6', '21', 'couriers', 30_000),
  cashbox('7', '99', 'couriers', 500_000, true), // o'chirilgan kassa
  cashbox('11', '37', 'markets', 0), // TEST Claude Market — 0
  cashbox('2', '16', 'markets', 255_000),
  cashbox('4', '11', 'markets', -15_000), // market bizga qarzdor
  cashbox('1', '0', 'main', 45_000),
];

const sumBalances = (items: Array<{ balance: number }>) =>
  items.reduce((sum, item) => sum + item.balance, 0);

describe('financial-balance-lists (G1) — FinanceServiceService.financialBalance ro`yxatlari', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('⭐ G1: jami 90 000 / -240 000 bo`lsa, ro`yxatlar BO`SH EMAS va Σ ro`yxat == jami', async () => {
    const { service } = makeEnv(PROD_LIKE_ROWS);

    const res: any = await service.financialBalance({
      include_party_lists: true,
    });

    // Jami raqamlar o'zgarmagan.
    expect(res.data.couriers.couriersTotalBalanse).toBe(90_000);
    expect(res.data.markets.marketPayable).toBe(240_000);
    expect(res.data.markets.marketsTotalBalans).toBe(-240_000);

    // Prod'da: allCourierCashboxes: [] / allMarketCashboxes yo'q edi.
    const couriers = res.data.couriers.allCourierCashboxes;
    const markets = res.data.markets.allMarketCashboxes;
    expect(couriers).toHaveLength(2);
    expect(markets).toHaveLength(2);
    expect(sumBalances(couriers)).toBe(res.data.couriers.couriersTotalBalanse);
    expect(sumBalances(markets)).toBe(res.data.markets.marketPayable);

    expect(res.data.couriers.nonZeroCount).toBe(2);
    expect(res.data.couriers.truncated).toBe(false);
    expect(res.data.markets.nonZeroCount).toBe(2);
    expect(res.data.markets.truncated).toBe(false);
  });

  it('qator shakli frontend `normalizePartyItems` o`qiydigan maydonlarda (id, user.name, balance)', async () => {
    const { service } = makeEnv(PROD_LIKE_ROWS);

    const res: any = await service.financialBalance({
      include_party_lists: true,
    });

    expect(res.data.couriers.allCourierCashboxes).toEqual([
      {
        id: '5',
        user_id: '19',
        cashbox_type: 'couriers',
        balance: 60_000,
        balance_cash: 60_000,
        balance_card: 0,
        user: {
          id: '19',
          name: 'Kuryer Ali',
          phone_number: '+998901112233',
          region_id: '1',
        },
      },
      {
        id: '6',
        user_id: '21',
        cashbox_type: 'couriers',
        balance: 30_000,
        balance_cash: 30_000,
        balance_card: 0,
        user: {
          id: '21',
          name: 'Kuryer Vali',
          phone_number: '+998901112244',
          region_id: '2',
        },
      },
    ]);
    // Market qatorida balans IMZOLI (manfiy = market bizga qarzdor).
    expect(
      res.data.markets.allMarketCashboxes.map((row: any) => [
        row.user?.name,
        row.balance,
      ]),
    ).toEqual([
      ['Market A', 255_000],
      ['Market B', -15_000],
    ]);
    // Identity'dan kelgan ortiqcha maydonlar (maosh, tarif, sozlamalar)
    // ro'yxatga sizib chiqmaydi.
    const serialized = JSON.stringify(res.data);
    expect(serialized).not.toContain('salary');
    expect(serialized).not.toContain('tariff_home');
    expect(serialized).not.toContain('settings');
  });

  it('nol balansli va o`chirilgan kassalar ro`yxatga kirmaydi; so`rov SQL darajasida filtrlanadi', async () => {
    const { service, qbs } = makeEnv(PROD_LIKE_ROWS);

    const res: any = await service.financialBalance({
      include_party_lists: true,
    });

    const userIds = [
      ...res.data.couriers.allCourierCashboxes,
      ...res.data.markets.allMarketCashboxes,
    ].map((row: any) => row.user_id);
    expect(userIds).not.toContain('26');
    expect(userIds).not.toContain('37');
    expect(userIds).not.toContain('99');

    const listQueries = qbs.filter(
      (qb) => qb.getManyAndCount.mock.calls.length,
    );
    expect(listQueries).toHaveLength(2);
    for (const qb of listQueries) {
      expect(qb.state.wheres).toEqual(
        expect.arrayContaining([expect.stringMatching(/balance\s*<>\s*0/)]),
      );
      expect(qb.state.params.active).toBe(false);
      expect(qb.state.limit).toBeGreaterThan(0);
    }
  });

  it('ro`yxat chegaralangan: limitdan ko`p kassa bo`lsa eng katta |balans| lar qaytadi, truncated=true', async () => {
    const many: FakeCashbox[] = Array.from({ length: 503 }, (_, i) =>
      cashbox(String(1000 + i), String(5000 + i), 'couriers', (i + 1) * 100),
    );
    const { service } = makeEnv(many);

    const res: any = await service.financialBalance({
      include_party_lists: true,
    });

    const list = res.data.couriers.allCourierCashboxes;
    expect(list).toHaveLength(500);
    expect(res.data.couriers.nonZeroCount).toBe(503);
    expect(res.data.couriers.truncated).toBe(true);
    // Eng katta qarzdorlar birinchi.
    expect(list[0].balance).toBe(50_300);
    expect(list[499].balance).toBe(400);
    // Jami baribir SQL SUM — barcha 503 kassa bo'yicha.
    expect(res.data.couriers.couriersTotalBalanse).toBe(
      many.reduce((s, r) => s + r.balance, 0),
    );
  });

  it('identity javob bermasa — ro`yxat nomsiz (user: null) qaytadi, hisobot yiqilmaydi', async () => {
    const { service } = makeEnv(PROD_LIKE_ROWS, { identityFails: true });

    const res: any = await service.financialBalance({
      include_party_lists: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.couriers.allCourierCashboxes).toHaveLength(2);
    expect(
      res.data.couriers.allCourierCashboxes.every((r: any) => r.user === null),
    ).toBe(true);
    expect(sumBalances(res.data.markets.allMarketCashboxes)).toBe(240_000);
    expect(res.data.currentSituation).toBe(45_000 + 260_000 - 240_000);
  });

  it('ro`yxat so`rovi yiqilsa — bo`sh ro`yxat, jami va holat o`zgarmaydi', async () => {
    const { service } = makeEnv(PROD_LIKE_ROWS, { listQueryFails: true });

    const res: any = await service.financialBalance({
      include_party_lists: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.couriers.allCourierCashboxes).toEqual([]);
    expect(res.data.markets.allMarketCashboxes).toEqual([]);
    expect(res.data.couriers.couriersTotalBalanse).toBe(90_000);
    expect(res.data.markets.marketsTotalBalans).toBe(-240_000);
    expect(res.data.currentSituation).toBe(65_000);
  });

  it('flag`siz chaqiruv (analytics) — ro`yxat so`rovi va identity chaqiruvi YO`Q, javob avvalgidek', async () => {
    const { service, qbs } = makeEnv(PROD_LIKE_ROWS);

    const res: any = await service.financialBalance();

    expect(qbs.some((qb) => qb.getManyAndCount.mock.calls.length > 0)).toBe(
      false,
    );
    expect(
      rmqSendMock.mock.calls.some(([, pattern]) =>
        String(pattern?.cmd).startsWith('identity.'),
      ),
    ).toBe(false);
    expect(res.data.markets).toEqual({
      marketPayable: 240_000,
      marketsTotalBalans: -240_000,
    });
    expect(res.data.couriers).toEqual({
      allCourierCashboxes: [],
      couriersTotalBalanse: 90_000,
    });
  });
});
