import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { lastValueFrom, Observable, of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';

/**
 * ysBqD9Nx (EGA QARORI) — `PATCH /markets/:id/telegram-group-pii`: guruh
 * kartasida mijoz PII ni market darajasida kodsiz o'chirish/yoqish.
 * Market — faqat o'zinikini; admin/superadmin — istalganini.
 */
type Send = jest.Mock<Observable<unknown>, [{ cmd: string }, unknown]>;

const setup = () => {
  const identitySend: Send = jest.fn<
    Observable<unknown>,
    [{ cmd: string }, unknown]
  >(() => of({ statusCode: 200, data: {} }));
  const controller = Object.create(
    ApiGatewayController.prototype,
  ) as ApiGatewayController & Record<string, unknown>;
  Object.assign(controller, { identityClient: { send: identitySend } });
  return { controller, identitySend };
};
const req = (sub: string, roles: string[]) =>
  ({ user: { sub, username: 'u', roles } }) as never;

describe('ysBqD9Nx — PATCH /markets/:id/telegram-group-pii', () => {
  it('rollar: superadmin, admin, market (RolesGuard)', () => {
    const handler = Object.getOwnPropertyDescriptor(
      ApiGatewayController.prototype,
      'updateMarketTelegramGroupPii',
    )?.value as object;
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
    expect(
      (Reflect.getMetadata(ROLES_KEY, handler) as string[]).sort(),
    ).toEqual(['admin', 'market', 'superadmin']);
  });

  it('⭐ market o‘zinikini o‘chiradi — identity.market.update { tg_group_show_customer_pii:false }', async () => {
    const { controller, identitySend } = setup();
    await lastValueFrom(
      controller.updateMarketTelegramGroupPii(
        '37',
        { tg_group_show_customer_pii: false },
        req('37', ['market']),
      ),
    );
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.market.update' },
      {
        id: '37',
        dto: { tg_group_show_customer_pii: false },
        requester: expect.objectContaining({ id: '37' }),
      },
    );
  });

  it('⭐ market BOSHQA marketniki — 403; admin — ruxsat', async () => {
    const { controller, identitySend } = setup();
    expect(() =>
      controller.updateMarketTelegramGroupPii(
        '38',
        { tg_group_show_customer_pii: true },
        req('37', ['market']),
      ),
    ).toThrow(ForbiddenException);
    expect(identitySend).not.toHaveBeenCalled();
    await lastValueFrom(
      controller.updateMarketTelegramGroupPii(
        '38',
        { tg_group_show_customer_pii: true },
        req('2', ['admin']),
      ),
    );
    expect(identitySend).toHaveBeenCalledTimes(1);
  });
});
