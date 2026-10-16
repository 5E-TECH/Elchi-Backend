import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { lastValueFrom, Observable, of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';

/**
 * w2bDrE3i — `PATCH /admin/markets/:id` (qo'shimcha xarajat sozlamasi, faqat
 * admin/superadmin) va VRyloH62 — `PATCH /markets/:id/operator-phone`
 * (market — faqat o'zi).
 */
type Send = jest.Mock<Observable<unknown>, [{ cmd: string }, unknown]>;

const setup = () => {
  const identitySend: Send = jest.fn(() => of({ statusCode: 200, data: {} }));
  const controller = Object.create(
    ApiGatewayController.prototype,
  ) as ApiGatewayController & Record<string, unknown>;
  Object.assign(controller, { identityClient: { send: identitySend } });
  return { controller, identitySend };
};

const req = (sub: string, roles: string[]) => ({ user: { sub, roles } }) as any;

const rolesOf = (method: keyof ApiGatewayController): string[] => {
  const handler = Object.getOwnPropertyDescriptor(
    ApiGatewayController.prototype,
    method,
  )?.value as object;
  expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  return Reflect.getMetadata(ROLES_KEY, handler) as string[];
};

describe('w2bDrE3i — PATCH /admin/markets/:id', () => {
  it('rollar: faqat superadmin va admin', () => {
    expect(rolesOf('updateMarketExtraCost').sort()).toEqual(
      ['admin', 'superadmin'].sort(),
    );
  });

  it('⭐ TC2: admin ochadi/yopadi — identity.market.update ga faqat berilgan maydonlar + requester', async () => {
    const { controller, identitySend } = setup();
    await lastValueFrom(
      controller.updateMarketExtraCost(
        '37',
        { extra_cost_enabled: false },
        req('2', ['admin']),
      ),
    );
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.market.update' },
      {
        id: '37',
        dto: { extra_cost_enabled: false },
        requester: expect.objectContaining({ id: '2' }),
      },
    );
  });

  it('bo`sh tana → 400; raqam bo`lmagan id → 404', () => {
    const { controller, identitySend } = setup();
    expect(() =>
      controller.updateMarketExtraCost('37', {}, req('2', ['admin'])),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.updateMarketExtraCost(
        'abc',
        { extra_cost_enabled: true },
        req('2', ['admin']),
      ),
    ).toThrow();
    expect(identitySend).not.toHaveBeenCalled();
  });
});

describe('VRyloH62 — PATCH /markets/:id/operator-phone', () => {
  it('rollar: superadmin, admin, market', () => {
    expect(rolesOf('updateMarketOperatorPhone').sort()).toEqual(
      ['admin', 'market', 'superadmin'].sort(),
    );
  });

  it('market o`zining sozlamasini o`zgartiradi', async () => {
    const { controller, identitySend } = setup();
    await lastValueFrom(
      controller.updateMarketOperatorPhone(
        '37',
        {
          require_operator_phone: true,
          default_operator_phone: '+998901234567',
        },
        req('37', ['market']),
      ),
    );
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.market.update' },
      expect.objectContaining({
        id: '37',
        dto: {
          require_operator_phone: true,
          default_operator_phone: '+998901234567',
        },
      }),
    );
  });

  it('market boshqa marketnikini o`zgartira olmaydi → 403', () => {
    const { controller, identitySend } = setup();
    expect(() =>
      controller.updateMarketOperatorPhone(
        '38',
        { require_operator_phone: true },
        req('37', ['market']),
      ),
    ).toThrow(ForbiddenException);
    expect(identitySend).not.toHaveBeenCalled();
  });

  it('bo`sh tana → 400', () => {
    const { controller } = setup();
    expect(() =>
      controller.updateMarketOperatorPhone('37', {}, req('2', ['admin'])),
    ).toThrow(BadRequestException);
  });
});
