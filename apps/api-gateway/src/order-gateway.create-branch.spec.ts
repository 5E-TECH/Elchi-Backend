import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

describe('OrderGatewayController create with branch auto binding', () => {
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
    return { controller, orderClient, identityClient, branchClient };
  };

  it('filial OPERATOR create qilsa branch_id va source=branch avtomatik bo‘ladi', async () => {
    const { controller, orderClient, identityClient, branchClient } = makeController();

    branchClient.send.mockReturnValue(
      of({
        data: { branch_id: '12', role: 'OPERATOR' },
      }),
    );
    identityClient.send.mockReturnValue(of({ data: { id: 'op1', market_id: '77', name: 'Operator 1' } }));
    orderClient.send.mockReturnValue(of({ statusCode: 201, data: { id: '100' } }));

    await controller.create(
      {
        customer_id: '55',
        items: [{ product_id: '10', quantity: 1 }],
      } as any,
      { user: { sub: 'op1', username: 'op', roles: ['operator'] } } as any,
    );

    const payload = orderClient.send.mock.calls[0][1];
    expect(payload.dto.branch_id).toBe('12');
    expect(payload.dto.source).toBe('branch');
  });

  it('HQ admin create qilsa eski flow qoladi (branch auto qo‘shilmaydi)', async () => {
    const { controller, orderClient, branchClient } = makeController();

    branchClient.send.mockReturnValue(of({ data: null }));
    orderClient.send.mockReturnValue(of({ statusCode: 201, data: { id: '101' } }));

    await controller.create(
      {
        market_id: '77',
        customer_id: '55',
      } as any,
      { user: { sub: 'admin1', username: 'admin', roles: ['admin'] } } as any,
    );

    const payload = orderClient.send.mock.calls[0][1];
    expect(payload.dto.branch_id).toBeNull();
    expect(payload.dto.source).toBeUndefined();
  });

  it('filial xodimi boshqa branch_id yuborsa xato qaytadi', async () => {
    const { controller, branchClient } = makeController();

    branchClient.send.mockReturnValue(
      of({
        data: { branch_id: '12', role: 'MANAGER' },
      }),
    );

    await expect(
      controller.create(
        {
          market_id: '77',
          customer_id: '55',
          branch_id: '999',
        } as any,
        { user: { sub: 'u1', username: 'manager', roles: ['branch'] } } as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
