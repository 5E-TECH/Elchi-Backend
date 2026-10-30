import { of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';
import { ScanGatewayController } from './scan-gateway.controller';
import { qrBatchScope } from './auth/order-qr-visibility';

/**
 * Sm3LZ6EN — gateway qismi: `meta.batches` javobdan tushib qolmaydi va son
 * doirasi so'rovchidan olinadi (mijoz yuborgan `market_id` market rolida
 * ishlamaydi).
 */
describe('GET orders/external — meta.batches (Sm3LZ6EN)', () => {
  const batches = [
    {
      external_batch_token: 'QOP-1',
      external_batch_ref: 'BP-24817',
      external_batch_size: 3,
      received_count: 1,
      pending_count: 1,
    },
  ];

  const make = () => {
    const orderClient = {
      send: jest.fn(() =>
        of({
          data: [{ id: '1', status: 'new', market_id: '121' }],
          total: 1,
          page: 1,
          limit: 100,
          meta: { batches },
        }),
      ),
    };
    const noop = { send: jest.fn(() => of({ data: null })) };
    const controller = new OrderGatewayController(
      orderClient as any,
      noop as any,
      noop as any,
      noop as any,
      noop as any,
    );
    return { controller, orderClient };
  };

  const call = (
    controller: OrderGatewayController,
    user: Record<string, unknown>,
    marketId?: string,
  ) =>
    controller.findAllExternal(
      marketId,
      'new',
      undefined,
      undefined,
      undefined,
      '1',
      '100',
      undefined,
      { user } as any,
    );

  it.each([
    ['superadmin', { sub: '1', roles: ['superadmin'] }],
    ['market', { sub: '121', roles: ['market'] }],
    ['menejer', { sub: '7', roles: ['manager'], branch_id: '11' }],
    ['registrator', { sub: '8', roles: ['registrator'], branch_id: '11' }],
  ])('⭐ %s javobida `meta.batches` saqlanadi', async (_name, user) => {
    const { controller } = make();
    const res = (await call(controller, user, '121')) as {
      total: number;
      meta: { batches: unknown };
    };
    expect(res.meta.batches).toEqual(batches);
    expect(res.total).toBe(1);
  });

  it('⭐ market roli: doira — o`zi', async () => {
    const { controller, orderClient } = make();
    await call(controller, { sub: '121', roles: ['market'] });
    const calls = orderClient.send.mock.calls as unknown as any[][];
    expect(calls[0][1].query.market_id).toBe('121');
  });

  it('⭐ menejer: doira — o`z filiali', async () => {
    const { controller, orderClient } = make();
    await call(controller, { sub: '7', roles: ['manager'], branch_id: '11' });
    const calls = orderClient.send.mock.calls as unknown as any[][];
    expect(calls[0][1].query.branch_id).toBe('11');
  });
});

describe('qrBatchScope (Sm3LZ6EN)', () => {
  it.each([
    [{ sub: '1', roles: ['superadmin'] }, {}],
    [{ sub: '1', roles: ['admin'], branch_id: '11' }, {}],
    [{ sub: '121', roles: ['market'] }, { market_id: '121' }],
    [{ sub: '7', roles: ['manager'], branch_id: '11' }, { branch_id: '11' }],
    [
      { sub: '8', roles: ['registrator'], branch_id: '11' },
      { branch_id: '11' },
    ],
    [{ sub: '9', roles: ['branch'], branch_id: '11' }, { branch_id: '11' }],
    [{ sub: '7', roles: ['manager'] }, {}],
    [{ sub: '5', roles: ['courier'], branch_id: '11' }, {}],
  ])('%j', (user, expected) => {
    expect(qrBatchScope(user)).toEqual(expected);
  });

  it('market + admin — admin ustun (assertQrOrderVisible bilan bir xil)', () => {
    expect(qrBatchScope({ sub: '1', roles: ['market', 'admin'] })).toEqual({});
  });
});

describe('GET /scan/:token — qop doirasi (Sm3LZ6EN)', () => {
  const make = () => {
    const orderClient = { send: jest.fn() };
    const noop = { send: jest.fn() };
    const controller = new ScanGatewayController(
      orderClient as any,
      noop as any,
      noop as any,
    );
    orderClient.send
      .mockReturnValueOnce(
        throwError(() => ({ statusCode: 404, message: 'Order not found' })),
      )
      .mockReturnValueOnce(
        of({
          data: {
            external_batch_token: 'QOP-1',
            is_external_batch: true,
            count: 1,
            members: [{ id: '1' }],
            batch: {
              external_batch_token: 'QOP-1',
              size: 3,
              received_count: 1,
              pending_count: 1,
              scanned_count: 1,
            },
          },
        }),
      );
    return { controller, orderClient };
  };

  it.each([
    [{ sub: '121', roles: ['market'] }, { market_id: '121' }],
    [{ sub: '7', roles: ['manager'], branch_id: '11' }, { branch_id: '11' }],
    [{ sub: '1', roles: ['admin'] }, {}],
  ])('⭐ %j — doira order-service ga uzatiladi', async (user, scope) => {
    const { controller, orderClient } = make();

    const res = await controller.scan('QOP-1', { user });

    expect(orderClient.send).toHaveBeenNthCalledWith(
      2,
      { cmd: 'order.find_batch_by_external_token' },
      { token: 'QOP-1', ...scope },
    );
    expect(res.type).toBe('batch');
    expect(res.data.batch).toMatchObject({ size: 3, received_count: 1 });
  });
});
