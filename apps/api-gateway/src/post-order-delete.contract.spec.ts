import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
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

  /**
   * (yokjwjXG TC2/TC3) Haqiqiy RolesGuard bilan rol matritsasi — metadata
   * emas, guard natijasi (false → Nest 403). Pochta detalidagi ikki amal:
   * savat (`DELETE /orders/:id`) va bekor pochta (`POST /post/cancel`).
   */
  describe('RolesGuard rol matritsasi (TC2/TC3)', () => {
    const guard = new RolesGuard(new Reflector());
    const ctxFor = (
      controller: object,
      method: string,
      roles: string[],
    ): ExecutionContext => {
      const handler = Object.getOwnPropertyDescriptor(
        (controller as { prototype: object }).prototype,
        method,
      )?.value as () => unknown;
      return {
        getHandler: () => handler,
        getClass: () => controller,
        switchToHttp: () => ({
          getRequest: () => ({ user: { sub: '1', username: 'u', roles } }),
        }),
      } as unknown as ExecutionContext;
    };

    it.each([
      [RoleEnum.SUPERADMIN, false],
      [RoleEnum.ADMIN, false],
      [RoleEnum.REGISTRATOR, false],
      [RoleEnum.MARKET, false],
      [RoleEnum.COURIER, true],
      [RoleEnum.MANAGER, true],
    ])('POST /post/cancel: %s → ruxsat=%s', (role, allowed) => {
      expect(
        guard.canActivate(
          ctxFor(LogisticsGatewayController, 'createCanceledPost', [role]),
        ),
      ).toBe(allowed);
    });

    it.each([
      [RoleEnum.SUPERADMIN, true],
      [RoleEnum.ADMIN, true],
      [RoleEnum.COURIER, false],
    ])('DELETE /orders/:id: %s → ruxsat=%s', (role, allowed) => {
      expect(
        guard.canActivate(ctxFor(OrderGatewayController, 'remove', [role])),
      ).toBe(allowed);
    });
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
