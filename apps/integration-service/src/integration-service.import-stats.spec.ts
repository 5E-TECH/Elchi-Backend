import { of, throwError } from 'rxjs';
import { IntegrationServiceService } from './integration-service.service';

/** `imported_orders` — ro'yxat va tafsilotda; order-service yo'q bo'lsa `null`. */
type Row = Record<string, any>;

function svc(send: () => unknown) {
  const s = Object.create(IntegrationServiceService.prototype) as Row;
  Object.assign(s, {
    orderClient: { send: jest.fn(send) },
    attachMarkets: (rows: Row[]) =>
      Promise.resolve(rows.map((row) => ({ ...row, market: { id: '9' } }))),
    maskCredentials: (value: unknown) => value,
    integrationRepo: {
      findOne: jest.fn().mockResolvedValue({ id: '3', slug: 'lidershop' }),
      find: jest.fn().mockResolvedValue([
        { id: '3', slug: 'lidershop' },
        { id: '1', slug: 'alion' },
      ]),
    },
  });
  return s;
}

const stats = () =>
  of({
    data: [
      {
        slug: 'lidershop',
        total: 49,
        today: 1,
        last_at: '2026-11-24T18:57:57.000Z',
      },
    ],
  });

describe('imported_orders', () => {
  it('⭐ tafsilot — son va oxirgi vaqt, market ham joyida', async () => {
    const res = await svc(stats).findIntegrationById('3');
    expect(res.data.imported_orders).toEqual({
      total: 49,
      today: 1,
      last_at: '2026-11-24T18:57:57.000Z',
    });
    expect(res.data.market).toEqual({ id: '9' });
  });

  it('ro`yxat — buyurtmasi yo`q sayt 0', async () => {
    const rows = await svc(stats).attachMarketsAndImports([
      { slug: 'lidershop' },
      { slug: 'alion' },
    ]);
    expect(rows.map((row: Row) => row.imported_orders.total)).toEqual([49, 0]);
    expect(rows[1].imported_orders.last_at).toBeNull();
  });

  it('⭐ order-service javob bermasa — `null` (0 emas), ro`yxat qaytadi', async () => {
    const res = await svc(() =>
      throwError(() => new Error('down')),
    ).findIntegrationById('3');
    expect(res.data.imported_orders).toBeNull();
    expect(res.data.id).toBe('3');
  });
});
