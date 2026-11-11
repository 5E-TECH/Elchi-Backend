import { of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * (Dilshod 2026-11-12) «Yo'lda» buyurtmada «Sotish» / «Qisman sotish» /
 * «Bekor qilish» bosilsa — gateway avval skan-qabul qiladi
 * (`logistics.post.receive`, `scan: true`, faqat shu buyurtma), keyin
 * amalni yuboradi. Tracking: «Yo'lda → Kutilmoqda», keyin natija.
 */
describe("Yo'ldagi buyurtmani sotish/bekor qilish — avtomatik qabul", () => {
  type Order = { id: string; status: string; post_id: string | null };
  type Post = { id: string; courier_id: string | null };

  const make = (opts: {
    order: Order | null;
    post?: Post | null;
    receive?: unknown;
    receiveError?: unknown;
  }) => {
    const calls: string[] = [];
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        calls.push(pattern.cmd);
        if (pattern.cmd === 'order.find_by_id') {
          return opts.order
            ? of(opts.order)
            : throwError(() => ({ statusCode: 404 }));
        }
        return of({ statusCode: 200, message: 'ok', data: {} });
      }),
    };
    const logisticsClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        calls.push(pattern.cmd);
        if (pattern.cmd === 'logistics.post.find_by_ids') {
          return of({ statusCode: 200, data: opts.post ? [opts.post] : [] });
        }
        if (pattern.cmd === 'logistics.post.receive') {
          if (opts.receiveError) return throwError(() => opts.receiveError);
          return of(opts.receive);
        }
        return of({});
      }),
    };
    const controller = new OrderGatewayController(
      orderClient as never,
      { send: jest.fn(() => of({})) } as never,
      logisticsClient as never,
      { send: jest.fn(() => of({})) } as never,
    );
    const receivePayload = () =>
      (
        logisticsClient.send.mock.calls as unknown as Array<
          [{ cmd: string }, Record<string, unknown>]
        >
      ).find(([pattern]) => pattern.cmd === 'logistics.post.receive')?.[1];
    return { controller, calls, receivePayload };
  };

  const req = (sub: string, roles: string[], branchId?: string) =>
    ({
      user: { sub, username: 'u', roles, branch_id: branchId },
      headers: {},
    }) as never;

  const received = (ids: string[], already: string[] = []) => ({
    statusCode: 200,
    message: 'Buyurtma qabul qilindi',
    data: [],
    received_order_ids: ids,
    already_received_order_ids: already,
    not_received_order_ids: [],
    remaining_count: 0,
    post_status: 'received',
  });

  type Act = (c: OrderGatewayController, r: never) => Promise<unknown>;
  const acts: Array<[string, string, Act]> = [
    ['sell', 'order.sell', (c, r) => c.sellOrder('81', {}, undefined, r)],
    [
      'cancel',
      'order.cancel',
      (c, r) =>
        c.cancelOrder(
          '81',
          { reason: 'customer_refused' } as never,
          undefined,
          r,
        ),
    ],
    [
      'partly-sell',
      'order.partly_sell',
      (c, r) => c.partlySellOrder('81', { items: [] } as never, undefined, r),
    ],
  ];

  it.each(acts)(
    "⭐ %s: kuryer o'z pochtasidagi yo'ldagi buyurtma — avval qabul, keyin amal",
    async (_label, cmd, act) => {
      const { controller, calls, receivePayload } = make({
        order: { id: '81', status: 'on the road', post_id: '7' },
        post: { id: '7', courier_id: '25' },
        receive: received(['81']),
      });
      await act(controller, req('25', ['courier'], '3'));
      expect(calls).toEqual([
        'order.find_by_id',
        'logistics.post.find_by_ids',
        'logistics.post.receive',
        cmd,
      ]);
      expect(receivePayload()).toEqual({
        id: '7',
        dto: { order_ids: ['81'], scan: true },
        requester: { id: '25', roles: ['courier'], branch_id: '3' },
      });
    },
  );

  it('waiting_customer ham avtomatik qabul qilinadi', async () => {
    const { controller, calls } = make({
      order: { id: '81', status: 'waiting_customer', post_id: '7' },
      post: { id: '7', courier_id: '25' },
      receive: received(['81']),
    });
    await controller.sellOrder('81', {}, undefined, req('25', ['courier']));
    expect(calls).toContain('logistics.post.receive');
    expect(calls[calls.length - 1]).toBe('order.sell');
  });

  it('menejer — filial o‘tkazma pochtasi (courier_id 0) avtomatik qabul', async () => {
    const { controller, calls } = make({
      order: { id: '81', status: 'on the road', post_id: '9' },
      post: { id: '9', courier_id: '0' },
      receive: received(['81']),
    });
    await controller.cancelOrder(
      '81',
      { reason: 'customer_refused' } as never,
      undefined,
      req('30', ['manager'], '3'),
    );
    expect(calls).toEqual([
      'order.find_by_id',
      'logistics.post.find_by_ids',
      'logistics.post.receive',
      'order.cancel',
    ]);
  });

  it("menejer — kuryer pochtasidagi buyurtmani qabul QILMAYDI (amal avvalgidek o'tadi)", async () => {
    const { controller, calls } = make({
      order: { id: '81', status: 'on the road', post_id: '7' },
      post: { id: '7', courier_id: '25' },
    });
    await controller.sellOrder('81', {}, undefined, req('30', ['manager']));
    expect(calls).not.toContain('logistics.post.receive');
    expect(calls[calls.length - 1]).toBe('order.sell');
  });

  it('kuryer — boshqa kuryer pochtasi: qabul qilinmaydi', async () => {
    const { controller, calls } = make({
      order: { id: '81', status: 'on the road', post_id: '7' },
      post: { id: '7', courier_id: '26' },
    });
    await controller.sellOrder('81', {}, undefined, req('25', ['courier']));
    expect(calls).not.toContain('logistics.post.receive');
    expect(calls[calls.length - 1]).toBe('order.sell');
  });

  it.each(['waiting', 'sold', 'cancelled', 'new'])(
    'holat %s — qabul so‘ralmaydi (pochta ham o‘qilmaydi)',
    async (status) => {
      const { controller, calls } = make({
        order: { id: '81', status, post_id: '7' },
        post: { id: '7', courier_id: '25' },
      });
      await controller.sellOrder('81', {}, undefined, req('25', ['courier']));
      expect(calls).toEqual(['order.find_by_id', 'order.sell']);
    },
  );

  it("post_id yo'q / buyurtma topilmadi — amal avvalgidek (order-service javob beradi)", async () => {
    const noPost = make({
      order: { id: '81', status: 'on the road', post_id: null },
    });
    await noPost.controller.sellOrder(
      '81',
      {},
      undefined,
      req('25', ['courier']),
    );
    expect(noPost.calls).toEqual(['order.find_by_id', 'order.sell']);

    const missing = make({ order: null });
    await missing.controller.sellOrder(
      '81',
      {},
      undefined,
      req('25', ['courier']),
    );
    expect(missing.calls).toEqual(['order.find_by_id', 'order.sell']);
  });

  it('allaqachon qabul qilingan (already_received) — amal davom etadi', async () => {
    const { controller, calls } = make({
      order: { id: '81', status: 'on the road', post_id: '7' },
      post: { id: '7', courier_id: '25' },
      receive: received([], ['81']),
    });
    await controller.sellOrder('81', {}, undefined, req('25', ['courier']));
    expect(calls[calls.length - 1]).toBe('order.sell');
  });

  it('⭐ qabul xatosi (403) — amal YUBORILMAYDI, xato qaytadi', async () => {
    const { controller, calls } = make({
      order: { id: '81', status: 'on the road', post_id: '9' },
      post: { id: '9', courier_id: '0' },
      receiveError: { statusCode: 403, message: 'Boshqa filial pochtasi' },
    });
    await expect(
      controller.sellOrder('81', {}, undefined, req('30', ['manager'])),
    ).rejects.toEqual({ statusCode: 403, message: 'Boshqa filial pochtasi' });
    expect(calls).not.toContain('order.sell');
  });

  it("⭐ buyurtma qabul ro'yxatida yo'q — 400 auto_receive_failed, amal yo'q", async () => {
    const { controller, calls } = make({
      order: { id: '81', status: 'on the road', post_id: '7' },
      post: { id: '7', courier_id: '25' },
      receive: { ...received([]), not_received_order_ids: ['81'] },
    });
    await expect(
      controller.cancelOrder(
        '81',
        { reason: 'customer_refused' } as never,
        undefined,
        req('25', ['courier']),
      ),
    ).rejects.toMatchObject({
      response: { reason: 'auto_receive_failed' },
    });
    expect(calls).not.toContain('order.cancel');
  });
});
