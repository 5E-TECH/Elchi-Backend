import 'reflect-metadata';
import { GoneException } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import {
  LEGACY_POST_ROUTE_DISABLED_MESSAGE,
  LogisticsGatewayController,
} from './logistics-gateway.controller';

const rolesOf = (method: keyof LogisticsGatewayController) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    LogisticsGatewayController.prototype,
    method,
  );
  return Reflect.getMetadata(ROLES_KEY, descriptor?.value) as string[];
};

const buildController = () => {
  const logisticsClient = {
    send: jest.fn(() => of({ statusCode: 200, data: { ok: true } })),
  };
  const identityClient = { send: jest.fn(() => of({ data: null })) };
  const controller = new LogisticsGatewayController(
    logisticsClient as any,
    identityClient as any,
  );
  return { controller, logisticsClient };
};

/**
 * FIX3 LC-08 / RBAC-06 — PATCH /district/:id (tumanni boshqa hududga
 * biriktirish) faqat admin/superadmin; so'rovchi logistics'ga uzatiladi.
 */
describe('FIX3 LC-08 — PATCH district/:id', () => {
  it('faqat admin va superadmin (district/name va district/sato bilan bir xil)', () => {
    const roles = rolesOf('update');

    expect(roles).toEqual(['admin', 'superadmin']);
    expect(roles).not.toContain('courier');
    expect(roles).not.toContain('market');
    expect(rolesOf('updateName')).toEqual(roles);
    expect(rolesOf('updateDistrictSato')).toEqual(roles);
  });

  it('so‘rovchi {id, roles} logistics.district.update ga uzatiladi', async () => {
    const { controller, logisticsClient } = buildController();
    const dto = { assigned_region: '7' };

    await firstValueFrom(
      controller.update('12', dto, {
        user: { sub: '1', roles: ['superadmin'] },
      }),
    );

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.district.update' },
      { id: '12', dto, requester: { id: '1', roles: ['superadmin'] } },
    );
  });
});

/**
 * FIX3 RBAC-14 — hudud statistikasi: market (tashqi) hech birini o'qimaydi;
 * kuryer batafsil statistikani (har bir kuryerning ismi, telefoni,
 * daromadi) o'qimaydi. Kuryerning /regions sahifasi faqat stats/all
 * agregatlarini o'qiydi (kuryer PII yo'q).
 */
describe('FIX3 RBAC-14 — region stats rollari', () => {
  it('stats/all: market yo‘q, kuryer qoladi', () => {
    const roles = rolesOf('getAllRegionStats');

    expect(roles).not.toContain('market');
    expect(roles).toEqual(
      expect.arrayContaining([
        'admin',
        'superadmin',
        'manager',
        'registrator',
        'courier',
      ]),
    );
  });

  it('stats/:id: market ham, kuryer ham yo‘q', () => {
    const roles = rolesOf('getRegionStatsById');

    expect(roles).toEqual(['admin', 'superadmin', 'manager', 'registrator']);
  });
});

/**
 * FIX3 CODE-12 — PATCH post/:id (sendPost) va PATCH post/reassign/:id
 * ishga tushirishda o'chiq: 410, logistics'ga hech narsa yuborilmaydi.
 */
describe('FIX3 CODE-12 — eski pochta route lari o‘chiq', () => {
  it.each(['sendPost', 'reassignPost'] as const)(
    '%s — 410 Gone, logistics chaqirilmaydi',
    (method) => {
      const { controller, logisticsClient } = buildController();

      let thrown: unknown;
      try {
        controller[method]();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(GoneException);
      expect((thrown as GoneException).getStatus()).toBe(410);
      expect((thrown as GoneException).message).toBe(
        LEGACY_POST_ROUTE_DISABLED_MESSAGE,
      );
      expect(logisticsClient.send).not.toHaveBeenCalled();
      // Rollar o'zgarmagan (registrator hamon yo'q).
      expect(rolesOf(method)).toEqual(['superadmin', 'admin']);
    },
  );
});
