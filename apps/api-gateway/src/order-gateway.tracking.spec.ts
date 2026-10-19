import { ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

describe('OrderGatewayController tracking access', () => {
  function setup(orderData: Record<string, unknown>) {
    const trackingResponse = {
      data: [
        {
          id: 'tracking-1',
          order_id:
            typeof orderData.id === 'string' || typeof orderData.id === 'number'
              ? String(orderData.id)
              : '101',
        },
      ],
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

describe('Ho5qcDn4 TC9 — market o`z buyurtmasi tarixini ko`radi', () => {
  const STAFF_ACTOR = {
    id: '1',
    name: 'Dilshod',
    username: 'superadmin_login',
    phone_number: '+998900000000',
    role: 'superadmin',
    status: 'active',
  };

  function setupWithActor(orderData: Record<string, unknown>) {
    const trackingResponse = {
      data: [
        {
          id: 'tracking-1',
          order_id: String(orderData.id),
          description: 'Buyurtma yaratildi',
          changed_by: '1',
          changed_by_role: 'superadmin',
          actor: STAFF_ACTOR,
        },
        {
          id: 'custody-1',
          event_type: 'custody',
          actor: null,
        },
      ],
      total: 2,
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
    const empty = { send: jest.fn(() => of({})) };
    const controller = new OrderGatewayController(
      orderClient as any,
      empty as any,
      empty as any,
      empty as any,
    );
    return { controller, orderClient, trackingResponse };
  }

  const market = (sub: string) =>
    ({ user: { sub, username: 'market', roles: ['market'] } }) as any;

  it('`@Roles` ro`yxatida MARKET bor (RolesGuard 403 bermaydi)', () => {
    const proto = OrderGatewayController.prototype as unknown as Record<
      string,
      unknown
    >;
    const roles = Reflect.getMetadata('roles', proto.getTracking) as string[];
    expect(roles).toContain('market');
  });

  it('⭐ o`z buyurtmasi → tarix qaytadi; xodim actor`idan login va telefon olib tashlanadi', async () => {
    const { controller, orderClient } = setupWithActor({
      id: '78',
      market_id: '37',
      holder_type: 'COURIER',
      holder_courier_id: '26',
    });

    const result = (await controller.getTracking(
      '78',
      undefined,
      undefined,
      market('37'),
    )) as { data: Array<Record<string, unknown>>; total: number };

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.tracking' },
      { id: '78', page: 1, limit: 20 },
    );
    expect(result.total).toBe(2);
    expect(result.data[0].actor).toEqual({
      id: '1',
      name: 'Dilshod',
      role: 'superadmin',
    });
    expect(JSON.stringify(result)).not.toContain('+998900000000');
    expect(JSON.stringify(result)).not.toContain('superadmin_login');
    // Hodisaning qolgan maydonlari va actor'siz qator o'zgarmaydi.
    expect(result.data[0].description).toBe('Buyurtma yaratildi');
    expect(result.data[1]).toEqual({
      id: 'custody-1',
      event_type: 'custody',
      actor: null,
    });
  });

  it('boshqa market buyurtmasi → 403, tarix so`ralmaydi', async () => {
    const { controller, orderClient } = setupWithActor({
      id: '32',
      market_id: '16',
    });

    await expect(
      controller.getTracking('32', undefined, undefined, market('37')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(orderClient.send).not.toHaveBeenCalledWith(
      { cmd: 'order.tracking' },
      expect.anything(),
    );
  });

  it('market_id bo`sh buyurtma → 403 (fail-closed)', async () => {
    const { controller } = setupWithActor({ id: '90', market_id: null });

    await expect(
      controller.getTracking('90', undefined, undefined, market('37')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('xodim rollari (superadmin, kuryer) javobni o`zgarishsiz oladi', async () => {
    const { controller, trackingResponse } = setupWithActor({
      id: '78',
      market_id: '37',
      holder_type: 'COURIER',
      holder_courier_id: '26',
    });

    await expect(
      controller.getTracking('78', undefined, undefined, {
        user: { sub: '1', roles: ['superadmin'] },
      } as any),
    ).resolves.toEqual(trackingResponse);
    await expect(
      controller.getTracking('78', undefined, undefined, {
        user: { sub: '26', roles: ['courier'] },
      } as any),
    ).resolves.toEqual(trackingResponse);
  });
});
