import { TimeoutError, of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * «Tezkor amal» — kunni yakunlash (2026-11-21, BeePost modeli):
 *  - `POST /orders/bulk/sell|cancel` — bitta so'rov, buyurtmalar server ichida
 *    KETMA-KET, har biri yakka handler orqali; bittasining xatosi
 *    qolganlarini to'xtatmaydi, javobda har buyurtma natijasi;
 *  - har buyurtmaga yakunlash kalitidan barqaror request_id (bo'lak / xato
 *    bergan buyurtma qayta yuborilsa amal ikki marta bajarilmaydi);
 *  - JWT'da filial yo'q menejer — filial biriktirishdan (ro'yxat bilan AYNI);
 *  - `scope=actionable` — menejer ro'yxati faqat jismoniy filial doirasi.
 */
describe('«Tezkor amal» — bulk sell/cancel', () => {
  type Payload = {
    id?: string;
    dto?: Record<string, unknown>;
    requester?: { id: string; roles: string[]; branch_id: string | null };
    request_id?: string;
    query?: Record<string, unknown>;
  };

  const make = (opts: { failIds?: Record<string, unknown> } = {}) => {
    const actions: Array<{ cmd: string; payload: Payload }> = [];
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }, payload: Payload) => {
        if (pattern.cmd === 'order.find_by_id') {
          return of({ id: payload.id, status: 'waiting', post_id: '9' });
        }
        if (pattern.cmd === 'order.find_all_enriched') {
          actions.push({ cmd: pattern.cmd, payload });
          return of({ data: [], total: 0, page: 1, limit: 100 });
        }
        actions.push({ cmd: pattern.cmd, payload });
        const failure = opts.failIds?.[String(payload.id)];
        if (failure) return throwError(() => failure);
        return of({ statusCode: 200, message: 'ok', data: {} });
      }),
    };
    const branchClient = {
      send: jest.fn(() =>
        of({ statusCode: 200, data: { branch_id: '77', role: 'MANAGER' } }),
      ),
    };
    const controller = new OrderGatewayController(
      orderClient as never,
      { send: jest.fn(() => of({})) } as never,
      { send: jest.fn(() => of({ data: [] })) } as never,
      branchClient as never,
    );
    const ops = (cmd: string) =>
      actions.filter((call) => call.cmd === cmd).map((call) => call.payload);
    return { controller, ops, branchClient };
  };

  const req = (
    opts: {
      sub?: string;
      roles?: string[];
      branch?: string | null;
      key?: string;
    } = {},
  ) =>
    ({
      user: {
        sub: opts.sub ?? '289',
        username: 'u',
        roles: opts.roles ?? ['courier'],
        branch_id: opts.branch ?? null,
      },
      headers: opts.key === undefined ? {} : { 'idempotency-key': opts.key },
    }) as never;

  it('⭐ ketma-ket, takrorlar bir marta; bitta xato qolganlarini to`xtatmaydi — har buyurtma natijasi', async () => {
    const { controller, ops } = make({
      failIds: {
        '82': { statusCode: 400, message: 'Buyurtma kutilmoqda holatida emas' },
        '84': new TimeoutError(),
      },
    });

    const result = (await controller.bulkSellOrders(
      { order_ids: ['81', '82', '81', '83', '84'], comment: ' Tezkor amal ' },
      req({ key: 'run-1' }),
    )) as { statusCode: number; data: Record<string, unknown> };

    expect(ops('order.sell').map((payload) => payload.id)).toEqual([
      '81',
      '82',
      '83',
      '84',
    ]);
    expect(ops('order.sell')[0].dto).toMatchObject({
      comment: 'Tezkor amal',
      extraCost: 0,
    });
    expect(result.statusCode).toBe(200);
    expect(result.data).toEqual({
      action: 'sell',
      total: 4,
      succeeded: ['81', '83'],
      failed: [
        {
          order_id: '82',
          status_code: 400,
          message: 'Buyurtma kutilmoqda holatida emas',
        },
        {
          order_id: '84',
          status_code: 504,
          message: 'Buyurtma xizmati vaqtida javob bermadi (timeout)',
        },
      ],
    });
  });

  it('⭐ har buyurtma request_id — yakunlash kalitidan barqaror (bo`lak qayta yuborilsa — ayni), kalitsiz — UUID', async () => {
    const { controller, ops } = make();

    await controller.bulkSellOrders(
      { order_ids: ['81', '82'] },
      req({ key: 'run-1' }),
    );
    await controller.bulkSellOrders(
      { order_ids: ['82'] },
      req({ key: 'run-1' }),
    );
    await controller.bulkSellOrders(
      { order_ids: ['81'] },
      req({ key: 'run-2' }),
    );
    await controller.bulkSellOrders({ order_ids: ['81'] }, req());

    const [first81, first82, retry82, other81, noKey81] = ops('order.sell').map(
      (payload) => payload.request_id,
    );
    expect(first81).toMatch(/^idem:289:[0-9a-f]{64}$/);
    expect(first82).not.toBe(first81);
    expect(retry82).toBe(first82);
    expect(other81).not.toBe(first81);
    expect(noKey81).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('⭐ bekor: amal kaliti sotuvnikidan farq qiladi; sabab va izoh uzatiladi', async () => {
    const { controller, ops } = make();

    await controller.bulkSellOrders(
      { order_ids: ['81'] },
      req({ key: 'run-1' }),
    );
    await controller.bulkCancelOrders(
      {
        order_ids: ['81'],
        comment: 'Tezkor amal: bekor',
        reason: 'other' as never,
      },
      req({ key: 'run-1' }),
    );

    const [cancel] = ops('order.cancel');
    expect(cancel.dto).toMatchObject({
      comment: 'Tezkor amal: bekor',
      reason: 'other',
      extraCost: 0,
    });
    expect(cancel.request_id).not.toBe(ops('order.sell')[0].request_id);
  });

  it('⭐ JWT`da filial yo`q menejer — filial biriktirishdan, bulk`da BIR marta o`qiladi', async () => {
    const { controller, ops, branchClient } = make();

    await controller.bulkSellOrders(
      { order_ids: ['81', '82', '83'] },
      req({ sub: '201', roles: ['manager'], branch: null, key: 'run-1' }),
    );

    expect(
      ops('order.sell').map((payload) => payload.requester?.branch_id),
    ).toEqual(['77', '77', '77']);
    const lookups = (
      branchClient.send.mock.calls as unknown as Array<[{ cmd: string }]>
    ).filter(([pattern]) => pattern.cmd === 'branch.user.find_by_user');
    expect(lookups).toHaveLength(1);
  });

  it('yakka sotuv/bekor ham: JWT`da filial yo`q menejer — biriktirishdan; JWT filiali bo`lsa — o`sha', async () => {
    const { controller, ops } = make();

    await controller.sellOrder(
      '81',
      {},
      undefined,
      req({ sub: '201', roles: ['manager'], branch: null }),
    );
    await controller.cancelOrder(
      '82',
      { comment: 'x' },
      undefined,
      req({ sub: '201', roles: ['manager'], branch: '55' }),
    );
    await controller.sellOrder('83', {}, undefined, req({ branch: null }));

    expect(ops('order.sell')[0].requester?.branch_id).toBe('77');
    expect(ops('order.cancel')[0].requester?.branch_id).toBe('55');
    // Kuryer — o'zgarishsiz (filial so'ralmaydi).
    expect(ops('order.sell')[1].requester?.branch_id).toBeNull();
  });

  it('⭐ scope=actionable — menejer ro`yxati faqat jismoniy filial doirasi; scope`siz — avvalgidek', async () => {
    const { controller, ops } = make();
    const manager = req({ sub: '201', roles: ['manager'], branch: '77' });

    await controller.findCourierOrdersLegacy(
      'waiting',
      undefined,
      undefined,
      undefined,
      '1',
      '100',
      manager,
      undefined,
      'actionable',
    );
    await controller.findCourierOrdersLegacy(
      'waiting',
      undefined,
      undefined,
      undefined,
      '1',
      '100',
      manager,
    );

    const [scoped, plain] = ops('order.find_all_enriched');
    expect(scoped.query).toMatchObject({
      branch_id: '77',
      branch_physical_only: true,
    });
    expect(plain.query).not.toHaveProperty('branch_physical_only');
  });
});
