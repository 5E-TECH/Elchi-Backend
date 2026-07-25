import { ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

describe('OrderGatewayController tracking access', () => {
  function setup(orderData: Record<string, unknown>) {
    const trackingResponse = {
      data: [{ id: 'tracking-1', order_id: String(orderData.id ?? '101') }],
      total: 1,
      page: 1,
      limit: 20,
    };
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.find_by_id_enriched') {
          return of({ statusCode: 200, data: orderData });
        }
        if (pattern.cmd === 'order.tracking') {
          return of(trackingResponse);
        }
        return of({ statusCode: 200 });
      }),
    };
    const identityClient = { send: jest.fn(() => of({})) };
    const logisticsClient = { send: jest.fn(() => of({})) };
    const branchClient = { send: jest.fn(() => of({})) };
    const controller = new OrderGatewayController(
      orderClient as any,
      identityClient as any,
      logisticsClient as any,
      branchClient as any,
    );

    return { controller, orderClient, trackingResponse };
  }

  it('allows courier tracking only while the order is held by that courier', async () => {
    const { controller, orderClient, trackingResponse } = setup({
      id: '101',
      holder_type: 'COURIER',
      holder_courier_id: '44',
      holder_branch_id: '10',
      courier_id: '99',
    });

    await expect(
      controller.getTracking('101', undefined, undefined, {
        user: { sub: '44', username: 'courier', roles: ['courier'] },
      } as any),
    ).resolves.toEqual(trackingResponse);
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.tracking' },
      { id: '101', page: 1, limit: 20 },
    );
  });

  it('allows courier to read an order they currently hold even when courier_id is empty', async () => {
    const order = {
      id: '101',
      holder_type: 'COURIER',
      holder_courier_id: '44',
      courier_id: null,
    };
    const { controller } = setup(order);

    await expect(
      controller.findById('101', {
        user: { sub: '44', username: 'courier', roles: ['courier'] },
      } as any),
    ).resolves.toMatchObject({ data: order });
  });

  it('blocks courier tracking when the order is not currently held by them', async () => {
    const { controller } = setup({
      id: '101',
      holder_type: 'BRANCH',
      holder_branch_id: '10',
      holder_courier_id: null,
      courier_id: '44',
    });

    await expect(
      controller.getTracking('101', undefined, undefined, {
        user: { sub: '44', username: 'courier', roles: ['courier'] },
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows manager tracking only while the order is held by their branch', async () => {
    const { controller, trackingResponse } = setup({
      id: '101',
      holder_type: 'BRANCH',
      holder_branch_id: '10',
      branch_id: '99',
    });

    await expect(
      controller.getTracking('101', undefined, undefined, {
        user: {
          sub: '77',
          username: 'manager',
          roles: ['manager'],
          branch_id: '10',
        },
      } as any),
    ).resolves.toEqual(trackingResponse);
  });
});
