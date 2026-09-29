import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * 5hBeDuyn. Hisob-kitob oyog'i qayta bosilsa (javob kechikkan) bir xil
 * `Idempotency-Key` bilan keladi — order-service `runIdempotent` uni
 * (pattern + request_id) bo'yicha ushlab, pulni ikkinchi marta taqsimlamaydi.
 */
describe('OrderGatewayController settlement idempotency', () => {
  const setup = () => {
    const orderClient = {
      send: jest.fn(() => of({ statusCode: 200, data: { allocated: 0 } })),
    };
    const controller = new OrderGatewayController(
      orderClient as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
    );
    const requestIds = () =>
      orderClient.send.mock.calls.map(
        (call: any[]) => (call[1] as { request_id: string }).request_id,
      );
    return { controller, orderClient, requestIds };
  };
  const req = (sub: string, key?: string) =>
    ({
      user: { sub, roles: ['superadmin'] },
      headers: key ? { 'idempotency-key': key } : {},
    }) as any;

  it('reuses the Idempotency-Key for every retry of the same form submit (all three legs)', async () => {
    const { controller, requestIds } = setup();
    const key = 'a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab';

    await controller.settlementBranchToHq(
      { branch_id: '12', amount: 1000 } as any,
      req('1', key),
    );
    await controller.settlementBranchToHq(
      { branch_id: '12', amount: 1000 } as any,
      req('1', key),
    );
    await controller.settlementHqToMarket(
      { market_id: '3', amount: 500 } as any,
      req('1', key),
    );
    await controller.settlementCourierToBranch(
      { courier_id: '56', amount: 500 } as any,
      req('1', key),
    );

    expect(requestIds()).toEqual([
      `1:${key}`,
      `1:${key}`,
      `1:${key}`,
      `1:${key}`,
    ]);
  });

  it('binds the key to the user so another user can never replay it', async () => {
    const { controller, requestIds } = setup();
    const key = 'same-key-12345';

    await controller.settlementBranchToHq({} as any, req('1', key));
    await controller.settlementBranchToHq({} as any, req('2', key));

    const [first, second] = requestIds();
    expect(first).not.toBe(second);
  });

  it('falls back to a fresh random id without a (valid) key', async () => {
    const { controller, requestIds } = setup();

    await controller.settlementBranchToHq({} as any, req('1'));
    await controller.settlementBranchToHq({} as any, req('1'));
    await controller.settlementBranchToHq(
      {} as any,
      req('1', 'bad key with spaces'),
    );

    const ids = requestIds();
    expect(new Set(ids).size).toBe(3);
    ids.forEach((id) => expect(id).toMatch(/^[0-9a-f-]{36}$/));
  });
});
