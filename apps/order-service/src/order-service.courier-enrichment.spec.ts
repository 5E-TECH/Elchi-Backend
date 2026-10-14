/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { of, throwError } from 'rxjs';
import { OrderServiceService } from './order-service.service';

/**
 * (xWsCAA5N) Excel eksport «Kuryer» ustuni: `GET /orders` (order.find_all_enriched
 * → enrichOrders) har buyurtmaga `courier: {id, name, phone_number}` qo'shadi.
 * Manba: `order.courier_id`, bo'sh bo'lsa — pochta kuryeri (post_id →
 * logistics_schema.posts.courier_id; '0' — kuryersiz filial pochtasi).
 */
const courierUser = (id: string, name: string) => ({
  id,
  name,
  username: `login_${id}`,
  phone_number: `+99890000000${id.slice(-1)}`,
  role: 'courier',
  status: 'active',
  // identity'ning to'liq qatoridan kelishi mumkin bo'lgan maxfiy maydonlar —
  // javobga chiqmasligi kerak.
  salary: 3_000_000,
  tariff_home: 20000,
  market_tg_token: 'secret',
});

function setup(
  opts: {
    postRows?: Array<{ id: string; courier_id: string | null }>;
    postQueryFails?: boolean;
    identityFails?: boolean;
  } = {},
) {
  const identitySend = jest.fn((pattern: { cmd: string }, payload: any) => {
    if (pattern.cmd === 'identity.user.find_by_ids') {
      if (opts.identityFails) {
        return throwError(() => new Error('identity down'));
      }
      return of({
        success: true,
        data: (payload.ids as string[])
          .filter((id) => id !== '404')
          .map((id) => courierUser(id, `Kuryer ${id}`)),
      });
    }
    return of({ data: [] });
  });
  const dataSource = {
    query: jest.fn(() =>
      opts.postQueryFails
        ? Promise.reject(new Error('relation does not exist'))
        : Promise.resolve(opts.postRows ?? []),
    ),
  };
  const empty = { send: jest.fn(() => of({ data: [] })) };
  const service = Object.create(OrderServiceService.prototype);
  Object.assign(service, {
    dataSource,
    identityClient: { send: identitySend },
    logisticsClient: empty,
    catalogClient: empty,
    logger: { warn: jest.fn() },
  });
  const enrich = (
    rows: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, any>>> => service.enrichOrders(rows);
  return {
    service: service as OrderServiceService,
    enrich,
    identitySend,
    dataSource,
  };
}

const order = (overrides: Record<string, unknown>) => ({
  id: '1',
  market_id: null,
  customer_id: null,
  district_id: null,
  region_id: null,
  courier_id: null,
  post_id: null,
  items: [],
  ...overrides,
});

describe('xWsCAA5N - enrichOrders kuryer boyitish', () => {
  it('TC1: courier_id bo`yicha courier {id,name,phone_number} qo`shiladi', async () => {
    const h = setup();
    const [row] = await h.enrich([order({ id: '10', courier_id: '7' })]);

    expect(row.courier).toEqual({
      id: '7',
      name: 'Kuryer 7',
      phone_number: '+998900000007',
    });
    expect(JSON.stringify(row.courier)).not.toMatch(
      /salary|tariff|username|market_tg_token/,
    );
  });

  it("courier_id bo'sh (bekor qilish) — pochta kuryeri olinadi; '0' pochta — kuryersiz", async () => {
    const h = setup({
      postRows: [
        { id: '55', courier_id: '8' },
        { id: '56', courier_id: '0' },
      ],
    });
    const rows = await h.enrich([
      order({ id: '11', courier_id: null, post_id: '55' }),
      order({ id: '12', courier_id: null, post_id: '56' }),
      order({ id: '13', courier_id: '9', post_id: '55' }),
      order({ id: '14' }),
    ]);

    expect(rows.map((r) => r.courier?.id ?? null)).toEqual([
      '8',
      null,
      '9',
      null,
    ]);
    // Pochta faqat courier_id siz qatorlar uchun so'raladi.
    expect(h.dataSource.query).toHaveBeenCalledTimes(1);
    expect(h.dataSource.query.mock.calls[0][1]).toEqual([['55', '56']]);
  });

  it('kuryerlar BITTA identity so`rovida (N+1 emas), takrorlar birlashadi', async () => {
    const h = setup();
    await h.enrich(
      Array.from({ length: 50 }, (_, i) =>
        order({ id: String(100 + i), courier_id: i % 2 ? '7' : '8' }),
      ),
    );

    const courierCalls = h.identitySend.mock.calls.filter(
      ([pattern]) => pattern.cmd === 'identity.user.find_by_ids',
    );
    expect(courierCalls).toHaveLength(1);
    expect([...courierCalls[0][1].ids].sort()).toEqual(['7', '8']);
  });

  it('500 dan ortiq kuryer — 500 talik bo`laklar', async () => {
    const h = setup();
    await h.enrich(
      Array.from({ length: 1201 }, (_, i) =>
        order({ id: String(i + 1), courier_id: String(1000 + i) }),
      ),
    );
    const sizes = h.identitySend.mock.calls
      .filter(([pattern]) => pattern.cmd === 'identity.user.find_by_ids')
      .map(([, payload]) => payload.ids.length);
    expect(sizes).toEqual([500, 500, 201]);
  });

  it('topilmagan kuryer — null; pochta/identity xatosi ro`yxatni yiqitmaydi', async () => {
    const missing = setup();
    const [row] = await missing.enrich([order({ courier_id: '404' })]);
    expect(row.courier).toBeNull();

    const failing = setup({ postQueryFails: true, identityFails: true });
    const rows = await failing.enrich([
      order({ id: '1', courier_id: '7' }),
      order({ id: '2', post_id: '55' }),
    ]);
    expect(rows.map((r) => r.courier)).toEqual([null, null]);
    expect(rows.map((r) => r.id)).toEqual(['1', '2']);
  }, 15_000);

  it('kuryersiz sahifada qo`shimcha so`rov yo`q', async () => {
    const h = setup();
    const [row] = await h.enrich([order({ id: '1' })]);

    expect(row.courier).toBeNull();
    expect(h.dataSource.query).not.toHaveBeenCalled();
    expect(
      h.identitySend.mock.calls.some(
        ([pattern]) => pattern.cmd === 'identity.user.find_by_ids',
      ),
    ).toBe(false);
  });
});
