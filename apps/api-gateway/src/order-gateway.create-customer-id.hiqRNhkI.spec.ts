import { ForbiddenException, GatewayTimeoutException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * hiqRNhkI TC3 — «Tanlangandan keyin POST /orders da `customer` emas,
 * `customer_id` ketadi».
 *
 * fix3 RBAC-01 tayyor `customer_id` ni faqat SUPERADMIN/ADMIN dan qabul
 * qilardi — market/filial xodimi `GET /customers/suggest` tanlagan mijozni
 * yuborsa id JIMGINA tashlanardi (karta TC3 hech qachon bajarilmasdi).
 * Endi admin bo'lmagan rol uchun id qabul qilinadi, lekin FAQAT suggest bilan
 * AYNI doirada: mijozning SHU marketda (o'chirilmagan) buyurtmasi bo'lsa
 * (`order.customer.market_summary`). RBAC-01 himoyasi saqlanadi: begona
 * market mijozining id si bog'lanmaydi.
 */
describe('hiqRNhkI — POST /orders: tanlangan mijoz customer_id bilan (doira ichida)', () => {
  const customerObj = {
    name: 'Ali',
    phone_number: '+998901112233',
    district_id: '5',
  };
  const baseDto = {
    market_id: '999',
    total_price: 120000,
    district_id: '5',
    region_id: '2',
    address: 'Chilonzor',
    items: [{ product_id: '10', quantity: 1 }],
  };

  type SummaryMode = { inScope: string[] } | 'timeout' | 'error';

  const makeController = (opts: {
    summary: SummaryMode;
    branchAssignment?: Record<string, unknown> | null;
  }) => {
    const orderClient = {
      send: jest.fn(
        (pattern: { cmd: string }, payload: { customer_ids?: string[] }) => {
          if (pattern.cmd === 'order.customer.market_summary') {
            if (opts.summary === 'timeout') {
              return throwError(
                () => new GatewayTimeoutException('Order service timeout'),
              );
            }
            if (opts.summary === 'error') {
              return throwError(() => new Error('db down'));
            }
            const inScope = opts.summary.inScope;
            return of({
              statusCode: 200,
              data: {
                items: (payload.customer_ids ?? [])
                  .filter((id) => inScope.includes(id))
                  .map((id) => ({ customer_id: id, orders: 3, new_orders: 1 })),
              },
            });
          }
          return of({ statusCode: 201, data: { id: '500' } });
        },
      ),
    };
    const identityClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'identity.customer.create') {
          return of({ data: { id: 'c-new' } });
        }
        if (pattern.cmd === 'identity.market.find_by_id') {
          return of({ data: { status: 'active', add_order: true } });
        }
        return of({});
      }),
    };
    const branchClient = {
      send: jest.fn(() => of({ data: opts.branchAssignment ?? null })),
    };
    const controller = new OrderGatewayController(
      orderClient as any,
      identityClient as any,
      { send: jest.fn(() => of({})) } as any,
      branchClient as any,
    );
    const calls = (client: { send: jest.Mock }, cmd: string) =>
      (client.send.mock.calls as unknown[][]).filter(
        (args) => (args[0] as { cmd?: string } | undefined)?.cmd === cmd,
      );
    return { controller, orderClient, identityClient, calls };
  };

  const userReq = (sub: string, roles: string[], extra = {}) =>
    ({ user: { sub, username: 'u', roles, ...extra } }) as any;

  const createdDto = (
    fx: ReturnType<typeof makeController>,
  ): Record<string, unknown> => {
    const call = fx.calls(fx.orderClient, 'order.create')[0];
    expect(call).toBeDefined();
    return (call[1] as { dto: Record<string, unknown> }).dto;
  };

  it('⭐ TC3: MARKET tanlagan mijoz (shu marketda buyurtmasi bor) — faqat customer_id, buyurtma SHU mijozga ulanadi, yangi mijoz yaratilmaydi', async () => {
    const fx = makeController({ summary: { inScope: ['153'] } });

    await fx.controller.create(
      { ...baseDto, customer_id: '153' } as any,
      userReq('37', ['market']),
    );

    expect(createdDto(fx).customer_id).toBe('153');
    expect(
      fx.calls(fx.identityClient, 'identity.customer.create'),
    ).toHaveLength(0);
    // Doira tokendagi market bo'yicha (body market_id 999 emas).
    expect(
      fx.calls(fx.orderClient, 'order.customer.market_summary')[0][1],
    ).toEqual({ market_id: '37', customer_ids: ['153'] });
  });

  it('⭐ TC3: customer_id + customer obyekt birga — doiradagi id ustun (mijoz qayta yaratilmaydi)', async () => {
    const fx = makeController({ summary: { inScope: ['153'] } });

    await fx.controller.create(
      { ...baseDto, customer_id: '153', customer: customerObj } as any,
      userReq('37', ['market']),
    );

    expect(createdDto(fx).customer_id).toBe('153');
    expect(
      fx.calls(fx.identityClient, 'identity.customer.create'),
    ).toHaveLength(0);
  });

  it('RBAC-01 saqlanadi: boshqa market mijozi (bu marketda buyurtmasi yo‘q), obyektsiz → 403, buyurtma ham, mijoz ham yaratilmaydi', async () => {
    const fx = makeController({ summary: { inScope: [] } });

    await expect(
      fx.controller.create(
        { ...baseDto, customer_id: '1' } as any,
        userReq('37', ['market']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fx.calls(fx.orderClient, 'order.create')).toHaveLength(0);
    expect(
      fx.calls(fx.identityClient, 'identity.customer.create'),
    ).toHaveLength(0);
  });

  it('begona customer_id + customer obyekt → avvalgidek telefon yo‘li (id e‘tiborsiz)', async () => {
    const fx = makeController({ summary: { inScope: [] } });

    await fx.controller.create(
      { ...baseDto, customer_id: '1', customer: customerObj } as any,
      userReq('37', ['market']),
    );

    expect(createdDto(fx).customer_id).toBe('c-new');
    expect(
      fx.calls(fx.identityClient, 'identity.customer.create'),
    ).toHaveLength(1);
  });

  it.each([['registrator'], ['manager']])(
    '⭐ TC3: filial xodimi (%s) — market_id dagi market doirasida tanlangan mijoz ulanadi',
    async (role) => {
      const fx = makeController({
        summary: { inScope: ['153'] },
        branchAssignment: { branch_id: '21', role: role.toUpperCase() },
      });

      await fx.controller.create(
        { ...baseDto, market_id: '37', customer_id: '153' } as any,
        userReq('300', [role]),
      );

      expect(createdDto(fx).customer_id).toBe('153');
      expect(
        fx.calls(fx.orderClient, 'order.customer.market_summary')[0][1],
      ).toEqual({ market_id: '37', customer_ids: ['153'] });
    },
  );

  it('raqam bo‘lmagan customer_id → doira so‘ralmaydi, obyektsiz 403', async () => {
    const fx = makeController({ summary: { inScope: ['1 OR 1=1'] } });

    await expect(
      fx.controller.create(
        { ...baseDto, customer_id: '1 OR 1=1' } as any,
        userReq('37', ['market']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      fx.calls(fx.orderClient, 'order.customer.market_summary'),
    ).toHaveLength(0);
  });

  it('doira xulosasi olinmadi (timeout): obyektsiz → 504 (fail-closed), obyekt bilan → telefon yo‘li', async () => {
    const fx = makeController({ summary: 'timeout' });
    await expect(
      fx.controller.create(
        { ...baseDto, customer_id: '153' } as any,
        userReq('37', ['market']),
      ),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
    expect(fx.calls(fx.orderClient, 'order.create')).toHaveLength(0);

    const fx2 = makeController({ summary: 'error' });
    await fx2.controller.create(
      { ...baseDto, customer_id: '153', customer: customerObj } as any,
      userReq('37', ['market']),
    );
    expect(createdDto(fx2).customer_id).toBe('c-new');
  });

  it('ADMIN: o‘zgarishsiz — istalgan customer_id, doira so‘ralmaydi', async () => {
    const fx = makeController({ summary: { inScope: [] } });

    await fx.controller.create(
      { ...baseDto, customer_id: '55' } as any,
      userReq('1', ['admin']),
    );

    expect(createdDto(fx).customer_id).toBe('55');
    expect(
      fx.calls(fx.orderClient, 'order.customer.market_summary'),
    ).toHaveLength(0);
  });
});
