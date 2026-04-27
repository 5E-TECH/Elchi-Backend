import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

describe('OrderGatewayController scanAssignOrder', () => {
  it('forwards qr_token to logistics.order.scan_assign with requester context', async () => {
    const orderClient = { send: jest.fn(() => of({})) };
    const identityClient = { send: jest.fn(() => of({})) };
    const branchClient = { send: jest.fn(() => of({})) };
    const logisticsClient = { send: jest.fn(() => of({ statusCode: 200, data: { idempotent: false } })) };

    const controller = new OrderGatewayController(
      orderClient as any,
      identityClient as any,
      logisticsClient as any,
      branchClient as any,
    );

    const response = await controller.scanAssignOrder(
      { qr_token: 'ORD-abc123' } as any,
      { user: { sub: '44', username: 'courier-1', roles: ['courier'] } } as any,
    );

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.order.scan_assign' },
      {
        dto: { qr_token: 'ORD-abc123' },
        requester: { id: '44', roles: ['courier'] },
      },
    );
    expect(response).toEqual({ statusCode: 200, data: { idempotent: false } });
  });
});
