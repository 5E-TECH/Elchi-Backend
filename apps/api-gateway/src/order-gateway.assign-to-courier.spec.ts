import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

describe('OrderGatewayController assignOrdersToCourier', () => {
  it('forwards payload to logistics.order.assign_to_courier with requester context', async () => {
    const orderClient = { send: jest.fn(() => of({})) };
    const identityClient = { send: jest.fn(() => of({})) };
    const branchClient = { send: jest.fn(() => of({})) };
    const logisticsClient = {
      send: jest.fn(() =>
        of({ statusCode: 200, data: { assigned_count: 3, post_created: false } }),
      ),
    };

    const controller = new OrderGatewayController(
      orderClient as any,
      identityClient as any,
      logisticsClient as any,
      branchClient as any,
    );

    const response = await controller.assignOrdersToCourier(
      {
        order_ids: ['101', '102', '103'],
        courier_id: '44',
      } as any,
      { user: { sub: '77', username: 'manager', roles: ['branch'] } } as any,
    );

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.order.assign_to_courier' },
      {
        dto: { order_ids: ['101', '102', '103'], courier_id: '44' },
        requester: { id: '77', roles: ['branch'] },
      },
    );
    expect(response).toEqual({
      statusCode: 200,
      data: { assigned_count: 3, post_created: false },
    });
  });
});
