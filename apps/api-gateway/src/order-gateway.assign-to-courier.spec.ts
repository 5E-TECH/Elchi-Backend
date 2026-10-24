import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { AssignOrdersToCourierRequestDto } from './dto/order.swagger.dto';
import { OrderGatewayController } from './order-gateway.controller';

describe('OrderGatewayController assignOrdersToCourier', () => {
  it('forwards payload to logistics.order.assign_to_courier with requester context', async () => {
    const orderClient = { send: jest.fn(() => of({})) };
    const identityClient = { send: jest.fn(() => of({})) };
    const branchClient = { send: jest.fn(() => of({})) };
    const logisticsClient = {
      send: jest.fn(() =>
        of({
          statusCode: 200,
          data: { assigned_count: 3, post_created: false },
        }),
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

/**
 * 1gxmqLj5 ((a) yo'l) — SUPERADMIN/ADMIN ham `assign-to-courier` qiladi.
 * Doira (bitta filial, kuryer o'sha filial a'zosi) logistics-service'da;
 * gateway rolni ochadi va ixtiyoriy `branch_id` ni uzatadi.
 */
describe('1gxmqLj5 — assign-to-courier SUPERADMIN/ADMIN', () => {
  const rolesOf = () =>
    Reflect.getMetadata(
      ROLES_KEY,
      Object.getOwnPropertyDescriptor(
        OrderGatewayController.prototype,
        'assignOrdersToCourier',
      )?.value as object,
    ) as string[];

  it('@Roles: superadmin/admin qo‘shildi, filial rollari qoladi, kuryer/market yo‘q', () => {
    expect(rolesOf().sort()).toEqual(
      ['admin', 'branch', 'manager', 'registrator', 'superadmin'].sort(),
    );
  });

  it('⭐ SA so‘rovi branch_id bilan logistics’ga uzatiladi', async () => {
    const logisticsClient = {
      send: jest.fn(() => of({ statusCode: 200, data: { assigned_count: 1 } })),
    };
    const controller = new OrderGatewayController(
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({})) } as any,
      logisticsClient as any,
      { send: jest.fn(() => of({})) } as any,
    );

    await controller.assignOrdersToCourier(
      { order_ids: ['201'], courier_id: '55', branch_id: '20' } as any,
      { user: { sub: '1', username: 'sa', roles: ['SUPERADMIN'] } } as any,
    );

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.order.assign_to_courier' },
      {
        dto: { order_ids: ['201'], courier_id: '55', branch_id: '20' },
        requester: { id: '1', roles: ['superadmin'] },
      },
    );
  });

  it('DTO: branch_id ixtiyoriy satr', async () => {
    const ok = plainToInstance(AssignOrdersToCourierRequestDto, {
      order_ids: ['201'],
      courier_id: '55',
    });
    expect(await validate(ok)).toEqual([]);
    const bad = plainToInstance(AssignOrdersToCourierRequestDto, {
      order_ids: ['201'],
      courier_id: '55',
      branch_id: 20,
    });
    expect((await validate(bad)).map((e) => e.property)).toEqual(['branch_id']);
  });
});
