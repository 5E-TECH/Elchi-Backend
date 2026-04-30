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

  it('forwards mark-returned-to-market request to order service', async () => {
    const { controller, orderClient } = setup();
    await controller.markReturnedToMarket(
      '101',
      { user: { sub: '9', roles: ['operator'] } } as any,
    );

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.mark_returned_to_market' },
      {
        id: '101',
        requester: { id: '9', roles: ['operator'] },
      },
    );
  });
});
