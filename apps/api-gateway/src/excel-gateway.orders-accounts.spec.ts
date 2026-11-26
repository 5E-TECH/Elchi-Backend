import { of } from 'rxjs';
import { ExcelGatewayController } from './excel-gateway.controller';
import { buildOrdersAccountsXlsx } from './order-export/orders-accounts-xlsx';

/**
 * `GET /export/orders.xlsx` — yig'ish: 50 000 chegarasi (JIM qirqilmaydi,
 * `total` hisobotga uzatiladi), takror qatorlar, banner matni.
 */
jest.mock('./order-export/orders-accounts-xlsx', () => ({
  ...jest.requireActual<object>('./order-export/orders-accounts-xlsx'),
  buildOrdersAccountsXlsx: jest.fn(() => Promise.resolve(Buffer.from('PK'))),
}));

const build = jest.mocked(buildOrdersAccountsXlsx);

type Query = { page: number; limit: number };

const run = async (
  page: (query: Query) => { data: unknown[]; total: number },
  filters: {
    status?: string;
    market_id?: string;
    from?: string;
    to?: string;
  } = {},
) => {
  const orderClient = {
    send: jest.fn((_pattern: unknown, payload: { query: Query }) =>
      of(page(payload.query)),
    ),
  };
  const controller = new ExcelGatewayController(
    orderClient as never,
    { send: jest.fn() } as never,
    { send: jest.fn() } as never,
  );
  const res = { set: jest.fn(), end: jest.fn() };
  await controller.exportOrders(
    res as never,
    filters.status,
    filters.market_id,
    undefined,
    undefined,
    undefined,
    filters.from,
    filters.to,
    { user: { sub: '1', roles: ['superadmin'] } },
  );
  return { orderClient, res, input: build.mock.calls[0][0] };
};

const order = (id: number) => ({
  id: String(id),
  status: 'sold',
  total_price: 1000,
  market: { id: '1', name: 'Baraka Shop' },
  courier: { name: 'Jasur' },
});

describe('export/orders.xlsx — yig‘ish', () => {
  beforeEach(() => build.mockClear());

  it('50 000 dan oshsa birinchi 50 000 tasi va haqiqiy jami uzatiladi', async () => {
    const total = 50_001;
    const { input, orderClient, res } = await run(({ page, limit }) => ({
      data: Array.from({ length: limit }, (_, i) =>
        order((page - 1) * limit + i + 1),
      ),
      total,
    }));
    expect(input.rows).toHaveLength(50_000);
    expect(input.total).toBe(total);
    expect(input.maxRows).toBe(50_000);
    expect(orderClient.send).toHaveBeenCalledTimes(100);
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Disposition': 'attachment; filename="orders.xlsx"',
      }),
    );
    // Ixcham qator: boyitilgan obyektlar (market, mijoz) saqlanmaydi.
    expect(input.rows[0]).toMatchObject({
      n: 1,
      id: 1,
      market: 'Baraka Shop',
      courier: 'Jasur',
      status: 'Sotilgan',
    });
  });

  it('sahifalar surilsa takror buyurtma ikki marta hisoblanmaydi', async () => {
    const { input } = await run(({ page, limit }) => ({
      data:
        page === 1
          ? Array.from({ length: limit }, (_, i) => order(i + 1))
          : [order(limit), order(limit + 1)],
      total: 502,
    }));
    expect(input.rows).toHaveLength(501);
    expect(input.rows.map((row) => row.n)).toEqual(
      Array.from({ length: 501 }, (_, i) => i + 1),
    );
    expect(input.total).toBe(502);
  });

  it('banner: davr, holat, market nomi (qatordan)', async () => {
    const { input } = await run(() => ({ data: [order(1)], total: 1 }), {
      status: 'sold',
      market_id: '1',
      from: '2026-11-16',
      to: '2026-11-25',
    });
    expect(input.subtitle).toBe(
      'Davr: 16.11.2026 – 25.11.2026 · Holat: Sotilgan · Market: Baraka Shop',
    );
  });
});
