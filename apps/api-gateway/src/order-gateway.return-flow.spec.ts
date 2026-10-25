import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

describe('OrderGatewayController return flow', () => {
  function setup() {
    const orderClient = { send: jest.fn(() => of({ statusCode: 200 })) };
    const identityClient = { send: jest.fn(() => of({})) };
    const logisticsClient = { send: jest.fn(() => of({})) };
    const branchClient = { send: jest.fn(() => of({})) };
    const controller = new OrderGatewayController(
      orderClient as any,
      identityClient as any,
      logisticsClient as any,
      branchClient as any,
    );
    return { controller, orderClient };
  }

  it('forwards initiate-return request to order service', async () => {
    const { controller, orderClient } = setup();
    await controller.initiateReturn(
      '101',
      { reason: 'Mijoz rad etdi' } as any,
      { user: { sub: '7', roles: ['admin'] } } as any,
    );

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.initiate_return' },
      {
        id: '101',
        dto: { reason: 'Mijoz rad etdi' },
        requester: { id: '7', roles: ['admin'] },
      },
    );
  });

  it('forwards mark-returned-to-market request (market QR token) to order service', async () => {
    const { controller, orderClient } = setup();
    await controller.markReturnedToMarket(
      '101',
      { authorization_token: 'MHA-token' },
      { user: { sub: '9', roles: ['superadmin'] } } as any,
    );

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.mark_returned_to_market' },
      {
        id: '101',
        authorization_token: 'MHA-token',
        requester: { id: '9', roles: ['superadmin'] },
      },
    );
  });

  it('scopes market cancelled orders to its own HQ-held orders', async () => {
    const { controller, orderClient } = setup();

    await controller.findCancelledOrdersByMarket('16', {
      user: { sub: '16', roles: ['market'] },
    } as any);

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.find_cancelled_by_market_enriched' },
      {
        market_id: '16',
        branch_id: undefined,
        holder_type: 'HQ',
        exclude_branch_source: false,
      },
    );
  });

  it('M0EPcJVf (BG3): market `stage` bilan — HQ qotirmasisiz, bosqichlar va sana oralig`i uzatiladi', async () => {
    const { controller, orderClient } = setup();

    await controller.findCancelledOrdersByMarket(
      '16',
      { user: { sub: '16', roles: ['market'] } } as any,
      'courier, in_transit,BRANCH',
      undefined,
      undefined,
    );
    expect(orderClient.send).toHaveBeenLastCalledWith(
      { cmd: 'order.find_cancelled_by_market_enriched' },
      {
        market_id: '16',
        exclude_branch_source: false,
        stages: ['courier', 'in_transit', 'branch'],
      },
    );
    const lastPayload = (orderClient.send.mock.calls as unknown[][]).at(
      -1,
    )?.[1] as Record<string, unknown>;
    expect(lastPayload.holder_type).toBeUndefined();

    await controller.findCancelledOrdersByMarket(
      '16',
      { user: { sub: '16', roles: ['market'] } } as any,
      ['market'],
      '2026-10-01',
      ' 2026-10-25 ',
    );
    expect(orderClient.send).toHaveBeenLastCalledWith(
      { cmd: 'order.find_cancelled_by_market_enriched' },
      expect.objectContaining({
        market_id: '16',
        stages: ['market'],
        start_day: '2026-10-01',
        end_day: '2026-10-25',
      }),
    );
  });

  it('M0EPcJVf (BG3): noma`lum bosqich — 400; begona market — avvalgidek 403', async () => {
    const { controller, orderClient } = setup();

    await expect(
      controller.findCancelledOrdersByMarket(
        '16',
        { user: { sub: '16', roles: ['market'] } } as any,
        'hq,yolda',
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.findCancelledOrdersByMarket(
        '17',
        { user: { sub: '16', roles: ['market'] } } as any,
        'market',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(orderClient.send).not.toHaveBeenCalled();
  });

  it('M0EPcJVf (BG3): market bo`lmagan rol uchun `stage` e`tiborsiz — topshirish ro`yxati (HQ) o`zgarmaydi', async () => {
    const { controller, orderClient } = setup();

    await controller.findCancelledOrdersByMarket(
      '16',
      { user: { sub: '1', roles: ['superadmin'] } } as any,
      'market',
      '2026-10-01',
    );

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.find_cancelled_by_market_enriched' },
      {
        market_id: '16',
        branch_id: undefined,
        holder_type: 'HQ',
        exclude_branch_source: false,
      },
    );
    const payload = (orderClient.send.mock.calls as unknown[][])[0][1];
    expect(payload).not.toHaveProperty('stages');
  });

  it('creates a cancelled handover QR for the authenticated market', async () => {
    const { controller, orderClient } = setup();

    await controller.createCancelledMarketHandoverQr('16', {
      user: { sub: '16', roles: ['market'] },
    } as any);

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.market_cancelled_handover.create_qr' },
      {
        market_id: '16',
        requester: { id: '16', roles: ['market'] },
      },
    );
  });

  it('forwards selected cancelled orders with the scan authorization', async () => {
    const { controller, orderClient } = setup();

    await controller.handoverCancelledOrdersToMarket(
      '16',
      {
        order_ids: ['101', '102'],
        authorization_token: 'MHA-secure-token',
      },
      { user: { sub: '9', roles: ['admin'] } } as any,
    );

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.market_cancelled_handover.complete' },
      {
        market_id: '16',
        order_ids: ['101', '102'],
        authorization_token: 'MHA-secure-token',
        requester: { id: '9', roles: ['admin'] },
      },
    );
  });
});
