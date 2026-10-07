import { of } from 'rxjs';
import { Workbook } from 'exceljs';
import { FinanceGatewayController } from '../finance-gateway.controller';
import { ExcelGatewayController } from '../excel-gateway.controller';
import {
  resolveFinancialActors,
  toFinancialBalanceExportRow,
} from './financial-balance.util';

/**
 * Moliyaviy daftar: "kim kiritgan" (4WeT0Tv5) va Excel eksport (GtAoqHlk).
 */

type Client = { send: jest.Mock };

const ledgerRow = (id: number, overrides: Record<string, unknown> = {}) => ({
  id: String(id),
  amount: -50000,
  balance_before: 1_000_000,
  balance_after: 950_000,
  source_type: 'manual_expense',
  comment: `Ofis ijarasi ${id}`,
  created_by: '1',
  order_id: null,
  related_user_id: null,
  createdAt: '2026-10-05T07:00:00.000Z',
  ...overrides,
});

const fullUser = {
  id: '1',
  name: 'Dilshod',
  role: 'superadmin',
  phone_number: '+998901234567',
  market_tg_token: 'MAXFIY',
  tariff_home: 30000,
};

describe('resolveFinancialActors', () => {
  it('har id bir marta so‘raladi va faqat id/ism/rol qaytadi', async () => {
    const fetchUser = jest.fn((id: string) =>
      Promise.resolve({ data: { ...fullUser, id } }),
    );
    const actors = await resolveFinancialActors(
      ['1', '1', 2, null, undefined, 'abc'],
      fetchUser,
    );

    expect(fetchUser).toHaveBeenCalledTimes(2);
    expect(actors.get('1')).toEqual({
      id: '1',
      name: 'Dilshod',
      role: 'superadmin',
    });
    expect(JSON.stringify([...actors.values()])).not.toMatch(
      /MAXFIY|phone_number|tariff/,
    );
  });

  it('identity xatosi — null, butun so‘rov yiqilmaydi', async () => {
    const actors = await resolveFinancialActors(['7'], () =>
      Promise.reject(new Error('timeout')),
    );
    expect(actors.get('7')).toBeNull();
  });
});

describe('toFinancialBalanceExportRow', () => {
  it('avtomatik yozuv (created_by yo‘q) — "Avtomatik"; noma‘lum foydalanuvchi — #id', () => {
    const actors = new Map([['9', null]]);
    expect(
      toFinancialBalanceExportRow(ledgerRow(1, { created_by: null }), actors)
        .created_by,
    ).toBe('Avtomatik');
    expect(
      toFinancialBalanceExportRow(ledgerRow(1, { created_by: '9' }), actors)
        .created_by,
    ).toBe('#9');
  });

  it('o‘zgarish ishorasi balans farqidan; manba o‘zbekcha', () => {
    const row = toFinancialBalanceExportRow(ledgerRow(1), new Map());
    expect(row.change).toBe(-50000);
    expect(row.source).toBe("Qo'lda chiqim");
  });
});

describe('GET finance/financial-balance/history — created_by_user', () => {
  it('qatorlarga MINIMAL created_by_user qo‘shiladi (items/rows/history bir xil)', async () => {
    const financeClient: Client = {
      send: jest.fn(() =>
        of({
          statusCode: 200,
          data: {
            items: [ledgerRow(1), ledgerRow(2, { created_by: null })],
            rows: [ledgerRow(1), ledgerRow(2, { created_by: null })],
            history: [ledgerRow(1), ledgerRow(2, { created_by: null })],
            total: 2,
          },
        }),
      ),
    };
    const identityClient: Client = {
      send: jest.fn(() => of({ data: fullUser })),
    };
    const controller = new FinanceGatewayController(
      financeClient as any,
      identityClient as any,
      { send: jest.fn() } as any,
      { send: jest.fn() } as any,
    );

    const response: any = await controller.financialBalanceHistory(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
      '10',
    );

    expect(identityClient.send).toHaveBeenCalledTimes(1);
    expect(response.data.items[0].created_by_user).toEqual({
      id: '1',
      name: 'Dilshod',
      role: 'superadmin',
    });
    expect(response.data.items[0].comment).toBe('Ofis ijarasi 1');
    expect(response.data.items[1].created_by_user).toBeNull();
    expect(response.data.rows).toEqual(response.data.items);
    expect(response.data.history).toEqual(response.data.items);
    expect(JSON.stringify(response)).not.toMatch(/MAXFIY|phone_number/);
  });
});

describe('GET export/financial-balance.xlsx', () => {
  const setup = (total: number) => {
    const all = Array.from({ length: total }, (_, i) => ledgerRow(i + 1));
    const financeClient: Client = {
      send: jest.fn(
        (_pattern: unknown, payload: { limit: number; offset: number }) =>
          of({
            data: {
              items: all.slice(payload.offset, payload.offset + payload.limit),
              total,
            },
          }),
      ),
    };
    const identityClient: Client = {
      send: jest.fn(() => of({ data: fullUser })),
    };
    const controller = new ExcelGatewayController(
      { send: jest.fn() } as any,
      financeClient as any,
      undefined,
      identityClient as any,
    );
    const res = { set: jest.fn(), end: jest.fn(), send: jest.fn() };
    return { controller, financeClient, identityClient, res };
  };

  const sheetOf = async (res: { end: jest.Mock; send: jest.Mock }) => {
    const buf = (res.end.mock.calls[0]?.[0] ??
      res.send.mock.calls[0]?.[0]) as Buffer;
    const wb = new Workbook();
    await wb.xlsx.load(buf as any);
    return wb.worksheets[0];
  };

  it('sahifalab o‘qiydi: qator soni jadvaldagi total ga teng (250)', async () => {
    const fx = setup(250);
    await fx.controller.exportFinancialBalance(
      fx.res as any,
      'manual_expense',
      '2026-10-01',
      '2026-10-05',
    );

    const payloads = fx.financeClient.send.mock.calls.map((c) => c[1]);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      source_type: 'manual_expense',
      from_date: '2026-10-01',
      to_date: '2026-10-05',
      limit: 200,
      offset: 0,
    });
    expect(payloads[1]).toMatchObject({ offset: 200 });

    const sheet = await sheetOf(fx.res);
    expect(sheet.rowCount).toBe(251); // sarlavha + 250
    const header = sheet.getRow(1).values as unknown[];
    expect(header).toEqual(
      expect.arrayContaining(['Izoh', 'Kim kiritgan', 'Buyurtma ID']),
    );
    const first = sheet.getRow(2);
    expect(first.getCell(7).value).toBe('Ofis ijarasi 1'); // Izoh
    expect(first.getCell(8).value).toBe('Dilshod'); // Kim kiritgan
    expect(fx.identityClient.send).toHaveBeenCalledTimes(1);
    expect(fx.res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Disposition': 'attachment; filename="financial-balance.xlsx"',
      }),
    );
  });

  it('noma‘lum manba turi (eski havola) yuborilmaydi — 500 o‘rniga barcha manbalar', async () => {
    const fx = setup(3);
    await fx.controller.exportFinancialBalance(fx.res as any, 'sell');
    expect(fx.financeClient.send.mock.calls[0][1].source_type).toBeUndefined();
    expect((await sheetOf(fx.res)).rowCount).toBe(4);
  });
});

describe('POST finance/financial-balance/entries — takroriy bosish (GtAoqHlk)', () => {
  const setup = () => {
    const financeClient: Client = {
      send: jest.fn(() => of({ statusCode: 201, data: { id: '1' } })),
    };
    const controller = new FinanceGatewayController(
      financeClient as any,
      { send: jest.fn() } as any,
      { send: jest.fn() } as any,
      { send: jest.fn() } as any,
    );
    const record = (dto: Record<string, unknown>, key?: string) =>
      controller.recordFinancialBalance(
        dto as any,
        { user: { sub: '1' } as any },
        key,
      );
    const dedupKeys = () =>
      financeClient.send.mock.calls.map(
        (call) => (call[1] as { dedup_key: string }).dedup_key,
      );
    return { record, dedupKeys, financeClient };
  };

  const expense = {
    amount: -50000,
    source_type: 'manual_expense',
    comment: 'Ofis ijarasi',
  };

  it('ayni kalit + ayni yozuv → ayni dedup_key (finance bir marta yozadi)', async () => {
    const fx = setup();
    await fx.record(expense, 'k-1');
    await fx.record(expense, 'k-1');
    const [a, b] = fx.dedupKeys();
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(fx.financeClient.send.mock.calls[0][1]).toMatchObject({
      ...expense,
      created_by: '1',
    });
  });

  it('ayni kalit, lekin boshqa summa → BOSHQA yozuv (yutilmaydi)', async () => {
    const fx = setup();
    await fx.record(expense, 'k-1');
    await fx.record({ ...expense, amount: -60000 }, 'k-1');
    const [a, b] = fx.dedupKeys();
    expect(a).not.toBe(b);
  });

  it('kalitsiz ikki marta bosish — 30 soniya ichida ayni token', async () => {
    const fx = setup();
    await fx.record(expense);
    await fx.record(expense);
    const [a, b] = fx.dedupKeys();
    expect(a).toBe(b);
  });
});
