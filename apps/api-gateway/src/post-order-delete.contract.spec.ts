import 'reflect-metadata';
import { of } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { ROLES_KEY } from './auth/roles.decorator';
import { LogisticsGatewayController } from './logistics-gateway.controller';
import { OrderGatewayController } from './order-gateway.controller';

describe("yokjwjXG - o'chirish va bekor pochta rollari ajratilgan", () => {
  it("superadmin order.delete ga kiradi, post/cancel esa kuryer/menejer oqimi bo'lib qoladi", () => {
    const deleteMethod = Object.getOwnPropertyDescriptor(
      OrderGatewayController.prototype,
      'remove',
    )?.value as object;
    const cancelMethod = Object.getOwnPropertyDescriptor(
      LogisticsGatewayController.prototype,
      'createCanceledPost',
    )?.value as object;
    const deleteRoles = Reflect.getMetadata(
      ROLES_KEY,
      deleteMethod,
    ) as string[];
    const cancelRoles = Reflect.getMetadata(
      ROLES_KEY,
      cancelMethod,
    ) as string[];

    expect(deleteRoles).toContain(RoleEnum.SUPERADMIN);
    expect(cancelRoles).not.toContain(RoleEnum.SUPERADMIN);
    expect(cancelRoles).toEqual([RoleEnum.COURIER, RoleEnum.MANAGER]);
  });

  it('superadmin DELETE /orders/:id order.delete ni chaqiradi', async () => {
    const send = jest.fn(() => of({ statusCode: 200, data: {} }));
    const controller = Object.create(
      OrderGatewayController.prototype,
    ) as OrderGatewayController & { orderClient: { send: typeof send } };
    controller.orderClient = { send };

    await expect(
      controller.remove('700', {
        user: { sub: '1', roles: [RoleEnum.SUPERADMIN] },
      } as never),
    ).resolves.toMatchObject({ statusCode: 200 });
    expect(send).toHaveBeenCalledWith(
      { cmd: 'order.delete' },
      {
        id: '700',
        requester: { id: '1', roles: [RoleEnum.SUPERADMIN] },
      },
    );
  });
});
