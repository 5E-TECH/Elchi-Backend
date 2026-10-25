import { ForbiddenException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * WCuZzUCv — POST /orders `customer_id`: boshqa market mijozi (ega qarori
 * 2026-10-19 S3). Qoida GET /customers/suggest bilan bir xil: shu marketda
 * buyurtmasi bor mijoz — avvalgidek; boshqa market mijozi — identity'da
 * CUSTOMER kartasi bo'lsa VA so'rovdagi `customer.phone_number` kartaga
 * TO'LIQ mos kelsa (ketma-ket id bilan sanab chiqib bo'lmaydi — RBAC-01).
 * IR2OHIiN: payload doim mahsulot + tuman + viloyat bilan.
 */
describe('WCuZzUCv — POST /orders: boshqa market mijozi customer_id bilan', () => {
  const baseDto = {
    market_id: '999',
    total_price: 120000,
    district_id: '5',
    region_id: '2',
    address: 'Chilonzor',
    items: [{ product_id: '10', quantity: 1 }],
  };
  const customerObj = {
    name: 'Vali',
    phone_number: '+998 90 111 22 33',
    district_id: '5',
  };

  const makeController = (opts: {
    inScope?: string[];
    card?: Record<string, unknown> | 'not_found';
  }) => {
    const orderClient = {
      send: jest.fn(
        (pattern: { cmd: string }, payload: { customer_ids?: string[] }) => {
          if (pattern.cmd === 'order.customer.market_summary') {
            return of({
              statusCode: 200,
              data: {
                items: (payload.customer_ids ?? [])
                  .filter((id) => (opts.inScope ?? []).includes(id))
                  .map((id) => ({ customer_id: id, orders: 1, new_orders: 0 })),
              },
            });
          }
          return of({ statusCode: 201, data: { id: '500' } });
        },
      ),
    };
    const identityClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'identity.customer.find_by_id') {
          if (opts.card === 'not_found' || !opts.card) {
            return throwError(() => new Error('Customer topilmadi'));
          }
          return of({ statusCode: 200, data: opts.card });
        }
        if (pattern.cmd === 'identity.customer.create') {
          return of({ data: { id: 'c-new' } });
        }
        if (pattern.cmd === 'identity.market.find_by_id') {
          return of({ data: { status: 'active', add_order: true } });
        }
        if (pattern.cmd === 'identity.user.find_by_id') {
          return of({ data: { market_id: '37', name: 'Op' } });
        }
        return of({});
      }),
    };
    const controller = new OrderGatewayController(
      orderClient as any,
      identityClient as any,
      { send: jest.fn(() => of({})) } as any,
      { send: jest.fn(() => of({ data: null })) } as any,
    );
    const calls = (client: { send: jest.Mock }, cmd: string) =>
      (client.send.mock.calls as unknown[][]).filter(
        (args) => (args[0] as { cmd?: string } | undefined)?.cmd === cmd,
      );
    const createdDto = () => {
      const call = calls(orderClient, 'order.create')[0];
      expect(call).toBeDefined();
      return (call[1] as { dto: Record<string, unknown> }).dto;
    };
    return { controller, orderClient, identityClient, calls, createdDto };
  };

  const userReq = (sub: string, roles: string[]) =>
    ({ user: { sub, username: 'u', roles } }) as any;

  it.each([
    ['market', '37'],
    ['market_operator', '501'],
  ])(
    '⭐ %s: boshqa market mijozi — telefon to`liq mos (format farqli) → buyurtma SHU customer_id bilan, mijoz qayta yaratilmaydi',
    async (role, sub) => {
      const fx = makeController({
        inScope: [],
        card: { id: '777', role: 'customer', phone_number: '+998901112233' },
      });

      await fx.controller.create(
        { ...baseDto, customer_id: '777', customer: customerObj } as any,
        userReq(sub, [role]),
      );

      expect(fx.createdDto().customer_id).toBe('777');
      expect(
        fx.calls(fx.identityClient, 'identity.customer.create'),
      ).toHaveLength(0);
      expect(
        fx.calls(fx.identityClient, 'identity.customer.find_by_id')[0][1],
      ).toEqual({ id: '777' });
    },
  );

  it.each([['registrator'], ['manager']])(
    '⭐ %s: boshqa market mijozi to`liq telefon bilan qabul qilinadi',
    async (role) => {
      const fx = makeController({
        inScope: [],
        card: { id: '777', phone_number: '998901112233' },
      });

      await fx.controller.create(
        {
          ...baseDto,
          market_id: '37',
          customer_id: '777',
          customer: customerObj,
        } as any,
        userReq('300', [role]),
      );

      expect(fx.createdDto().customer_id).toBe('777');
    },
  );

  it('RBAC-01: telefon mos kelmasa — id e`tiborsiz, telefon yo`li (customer obyekti bo`yicha)', async () => {
    const fx = makeController({
      inScope: [],
      card: { id: '777', phone_number: '+998935554433' },
    });

    await fx.controller.create(
      { ...baseDto, customer_id: '777', customer: customerObj } as any,
      userReq('37', ['market']),
    );

    expect(fx.createdDto().customer_id).toBe('c-new');
    expect(
      fx.calls(fx.identityClient, 'identity.customer.create'),
    ).toHaveLength(1);
  });

  it('RBAC-01: ketma-ket id, customer obyektsiz (telefon yo`q) → 403, karta so`ralmaydi, buyurtma yo`q', async () => {
    const fx = makeController({
      inScope: [],
      card: { id: '778', phone_number: '+998901112233' },
    });

    await expect(
      fx.controller.create(
        { ...baseDto, customer_id: '778' } as any,
        userReq('37', ['market']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      fx.calls(fx.identityClient, 'identity.customer.find_by_id'),
    ).toHaveLength(0);
    expect(fx.calls(fx.orderClient, 'order.create')).toHaveLength(0);
  });

  it('o`chirilgan / mijoz bo`lmagan id (identity topmaydi) → telefon yo`li', async () => {
    const fx = makeController({ inScope: [], card: 'not_found' });

    await fx.controller.create(
      { ...baseDto, customer_id: '779', customer: customerObj } as any,
      userReq('37', ['market']),
    );

    expect(fx.createdDto().customer_id).toBe('c-new');
  });

  it('shu marketda buyurtmasi bor mijoz — avvalgidek, karta so`ralmaydi', async () => {
    const fx = makeController({ inScope: ['153'] });

    await fx.controller.create(
      { ...baseDto, customer_id: '153' } as any,
      userReq('37', ['market']),
    );

    expect(fx.createdDto().customer_id).toBe('153');
    expect(
      fx.calls(fx.identityClient, 'identity.customer.find_by_id'),
    ).toHaveLength(0);
  });
});
