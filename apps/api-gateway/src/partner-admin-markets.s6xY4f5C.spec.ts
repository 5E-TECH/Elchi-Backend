import 'reflect-metadata';
import { ExecutionContext, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { PartnerAdminGatewayController } from './partner-admin-gateway.controller';
import { RolesGuard } from './auth/roles.guard';
import { LinkPartnerMarketRequestDto } from './dto/partner-market-admin.swagger.dto';

/**
 * T1 K1 (s6xY4f5C) — `GET|POST /admin/partners/:id/markets`: faqat
 * SUPERADMIN/ADMIN; tana validatsiyasi; RMQ buyrug'i va payload.
 */
describe('PartnerAdminGatewayController — hamkor sotuvchilari (T1 K1)', () => {
  const guard = new RolesGuard(new Reflector());
  const ctxFor = (handler: (...args: unknown[]) => unknown, roles: string[]) =>
    ({
      getHandler: () => handler,
      getClass: () => PartnerAdminGatewayController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { sub: '1', username: 'u', roles } }),
      }),
    }) as unknown as ExecutionContext;

  const proto = PartnerAdminGatewayController.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;

  it.each(['listMarkets', 'linkMarket'])(
    '%s: registrator / menejer → 403, superadmin / admin → o`tadi',
    (name) => {
      const handler = proto[name];
      for (const roles of [['registrator'], ['manager'], ['market']]) {
        // false → Nest 403 Forbidden
        expect(guard.canActivate(ctxFor(handler, roles))).toBe(false);
      }
      for (const roles of [['superadmin'], ['admin']]) {
        expect(guard.canActivate(ctxFor(handler, roles))).toBe(true);
      }
    },
  );

  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const validate = (body: unknown) =>
    pipe.transform(body, {
      type: 'body',
      metatype: LinkPartnerMarketRequestDto,
    }) as Promise<LinkPartnerMarketRequestDto>;

  it('tana: trim, son → satr; bo`sh / 101 belgi / raqam emas / ortiqcha maydon → 400', async () => {
    await expect(
      validate({ external_seller_id: '  shop-9 ', elchi_market_id: 1234 }),
    ).resolves.toEqual({
      external_seller_id: 'shop-9',
      elchi_market_id: '1234',
    });
    for (const body of [
      { external_seller_id: '   ', elchi_market_id: '1' },
      { external_seller_id: 'x'.repeat(101), elchi_market_id: '1' },
      { external_seller_id: 'a', elchi_market_id: '12a' },
      { external_seller_id: 'a', elchi_market_id: -5 },
      { external_seller_id: 'a', elchi_market_id: '1', tariff_home: 1 },
    ]) {
      await expect(validate(body)).rejects.toBeDefined();
    }
  });

  it('RMQ: markets.list / markets.link payload (requester JWT`dan)', async () => {
    const send = jest.fn(() => of({ statusCode: 200, data: [] }));
    const controller = new PartnerAdminGatewayController({ send } as never);
    await controller.listMarkets('7');
    await controller.linkMarket(
      '7',
      { external_seller_id: 'shop-9', elchi_market_id: '1234' },
      { user: { sub: '1', roles: ['admin'] } },
    );
    expect(send).toHaveBeenNthCalledWith(
      1,
      { cmd: 'integration.partner.markets.list' },
      { partner_id: '7' },
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      { cmd: 'integration.partner.markets.link' },
      {
        partner_id: '7',
        external_seller_id: 'shop-9',
        elchi_market_id: '1234',
        requester: { id: '1', roles: ['admin'] },
      },
    );
  });
});
