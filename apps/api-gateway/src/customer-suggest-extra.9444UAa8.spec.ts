import { Observable, of } from 'rxjs';
import { CustomerGatewayController } from './customer-gateway.controller';

/**
 * 9444UAa8 — GET /customers/suggest qo'shimcha raqam bo'yicha ham:
 *   - identity'ga `match_extra_number: true` yuboriladi;
 *   - har taklifda `matched_by` (`phone` | `extra_number` | `name`) — frontend
 *     «Qo'shimcha raqam: …» belgisini shundan chizadi;
 *   - qo'shimcha raqam bo'yicha topilgan mijoz ham market doirasidan o'tadi:
 *     shu marketda buyurtmasi bo'lmasa taklif QILINMAYDI (maxfiylik qoidasi).
 */
type Send = jest.Mock<Observable<unknown>, [{ cmd: string }, unknown]>;
type Row = Record<string, unknown>;

const MARKET = { sub: '121', roles: ['market'] };
const ADMIN = { sub: '1', roles: ['admin'] };

const customer = (id: string, over: Row = {}): Row => ({
  id,
  name: `Mijoz ${id}`,
  phone_number: '+998991330152',
  extra_number: '+998903456744',
  role: 'customer',
  ...over,
});

const setup = (customers: Row[], summaryIds: string[]) => {
  const identitySend: Send = jest.fn<
    Observable<unknown>,
    [{ cmd: string }, unknown]
  >(() => of({ success: true, data: customers }));
  const orderSend: Send = jest.fn<
    Observable<unknown>,
    [{ cmd: string }, unknown]
  >(() =>
    of({
      statusCode: 200,
      data: {
        items: summaryIds.map((id) => ({
          customer_id: id,
          orders: 1,
          new_orders: 0,
        })),
      },
    }),
  );
  const controller = new CustomerGatewayController(
    { send: identitySend } as never,
    { send: orderSend } as never,
  );
  return { controller, identitySend };
};

describe('9444UAa8 — GET /customers/suggest qo`shimcha raqam', () => {
  it('⭐ identity`ga match_extra_number: true; matched_by uzatiladi', async () => {
    const { controller, identitySend } = setup(
      [
        customer('70', { matched_by: 'extra_number' }),
        customer('72', {
          phone_number: '+998903456744',
          matched_by: 'phone',
        }),
      ],
      ['70', '72'],
    );

    const res: { data: Row[] } = await controller.suggest(
      '+998 90 345 67 44',
      undefined,
      {
        user: MARKET,
      } as never,
    );

    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.customer.search' },
      expect.objectContaining({ match_extra_number: true }),
    );
    expect(res.data.map((row) => [row.id, row.matched_by])).toEqual([
      ['70', 'extra_number'],
      ['72', 'phone'],
    ]);
    expect(res.data[0].extra_number).toBe('+998903456744');
  });

  it('⭐ maxfiylik: qo`shimcha raqam bo`yicha topilgan, lekin shu marketda buyurtmasi yo`q mijoz — taklif qilinmaydi', async () => {
    const { controller } = setup(
      [customer('80', { matched_by: 'extra_number' })],
      [],
    );

    const res: { data: Row[] } = await controller.suggest(
      '903456744',
      undefined,
      {
        user: MARKET,
      } as never,
    );

    expect(res.data).toEqual([]);
  });

  it('admin — doirasiz; matched_by noma`lum/yo`q — `phone`', async () => {
    const { controller } = setup(
      [
        customer('81', { matched_by: 'extra_number' }),
        customer('82', { matched_by: 'boshqa' }),
        customer('83'),
      ],
      [],
    );

    const res: { data: Row[] } = await controller.suggest(
      '903456744',
      undefined,
      {
        user: ADMIN,
      } as never,
    );

    expect(res.data.map((row) => [row.id, row.matched_by])).toEqual([
      ['81', 'extra_number'],
      ['82', 'phone'],
      ['83', 'phone'],
    ]);
  });
});
