import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * BOT-3d (NIMA 12) — kuryer amallari `Idempotency-Key` ni o'qiydi:
 * request_id = `idem:<user>:<sha256(kalit)>` (POST /orders naqshi). Ayni kalit
 * — ayni request_id (order-service `pattern:request_id` bo'yicha bir marta
 * bajaradi); kalitsiz — har so'rovga yangi UUID (avvalgidek); kalit
 * foydalanuvchi bo'yicha ajratilgan.
 */
describe('BOT-3d — kuryer amali Idempotency-Key → request_id', () => {
  const make = () => {
    const orderClient = { send: jest.fn(() => of({ ok: true })) };
    const controller = new OrderGatewayController(
      orderClient as never,
      { send: jest.fn(() => of({})) } as never,
      { send: jest.fn(() => of({})) } as never,
      { send: jest.fn(() => of({})) } as never,
    );
    const requestIds = () =>
      (
        orderClient.send.mock.calls as unknown as Array<
          [unknown, { request_id: string }]
        >
      ).map(([, payload]) => payload.request_id);
    return { controller, requestIds };
  };
  const req = (sub: string, key?: string) =>
    ({
      user: { sub, username: 'k', roles: ['courier'] },
      headers: key === undefined ? {} : { 'idempotency-key': key },
    }) as never;
  type Call = (
    c: OrderGatewayController,
    key?: string,
    sub?: string,
  ) => Promise<unknown>;

  it.each<[string, Call]>([
    [
      'sell',
      (c, key, sub = '25') => c.sellOrder('81', {}, undefined, req(sub, key)),
    ],
    [
      'cancel',
      (c, key, sub = '25') =>
        c.cancelOrder(
          '81',
          { reason: 'customer_refused' } as never,
          undefined,
          req(sub, key),
        ),
    ],
    [
      'partly-sell',
      (c, key, sub = '25') =>
        c.partlySellOrder(
          '81',
          { items: [] } as never,
          undefined,
          req(sub, key),
        ),
    ],
    [
      'could-not-deliver',
      (c, key, sub = '25') =>
        c.couldNotDeliverOrder(
          '81',
          { reason: 'Mijoz telefonni olmadi' },
          req(sub, key),
        ),
    ],
    [
      'rollback',
      (c, key, sub = '25') => c.rollbackOrder('81', {}, req(sub, key)),
    ],
  ])(
    '⭐ %s: ayni kalit — ayni request_id; boshqa foydalanuvchi — boshqa; kalitsiz — UUID',
    async (_label, call) => {
      const { controller, requestIds } = make();
      await call(controller, 'tg:act0000000000001');
      await call(controller, 'tg:act0000000000001');
      await call(controller, 'tg:act0000000000001', '26');
      await call(controller);
      const [first, second, other, noKey] = requestIds();
      expect(first).toMatch(/^idem:25:[0-9a-f]{64}$/);
      expect(second).toBe(first);
      expect(other).toMatch(/^idem:26:/);
      expect(other).not.toBe(first);
      expect(noKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    },
  );

  it('255 belgidan uzun kalit → 400', () => {
    const { controller } = make();
    expect(() =>
      controller.rollbackOrder('81', {}, req('25', 'k'.repeat(256))),
    ).toThrow(/255/);
  });
});
