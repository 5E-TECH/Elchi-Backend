import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

describe('OrderGatewayController pagination', () => {
  const makeController = () => {
    const orderClient = { send: jest.fn() };
    const identityClient = { send: jest.fn() };
    const logisticsClient = { send: jest.fn() };
    const branchClient = { send: jest.fn() };
    const controller = new OrderGatewayController(
      orderClient as any,
      identityClient as any,
      logisticsClient as any,
      branchClient as any,
    );
    return { controller, orderClient, branchClient };
  };

  it('default limit=10 and page=1 for list endpoint', async () => {
    const { controller, orderClient } = makeController();
    orderClient.send.mockReturnValue(
      of({ data: [], total: 0, page: 1, limit: 10 }),
    );

    const res: any = await controller.findAll(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { user: { sub: '1', username: 'u', roles: ['admin'] } } as any,
    );

    expect(orderClient.send).toHaveBeenCalled();
    const payload = orderClient.send.mock.calls[0][1];
    expect(payload.query.page).toBe(1);
    expect(payload.query.limit).toBe(10);
    expect(res.total_pages).toBe(0);
  });

  it('allowed limits are accepted (25/50/100)', async () => {
    const { controller, orderClient } = makeController();
    orderClient.send.mockReturnValue(
      of({ data: [{ id: '1' }], total: 51, page: 1, limit: 25 }),
    );

    const res: any = await controller.findAll(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
      '25',
      { user: { sub: '1', username: 'u', roles: ['admin'] } } as any,
    );

    const payload = orderClient.send.mock.calls[0][1];
    expect(payload.query.limit).toBe(25);
    expect(res.total_pages).toBe(3);
  });

  it('invalid limit rejected with 400', async () => {
    const { controller } = makeController();
    expect(() =>
      controller.findAll(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '1',
        '15',
        { user: { sub: '1', username: 'u', roles: ['admin'] } } as any,
      ),
    ).toThrow(BadRequestException);
  });
});
