import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * UER0MpMX — `POST /orders` da market va mahsulot egaligi server tomonda.
 * Ilgari: mavjud bo'lmagan `market_id` (99999999) bilan yetim buyurtma, A
 * marketning mahsuloti B marketning buyurtmasida (IDOR), nofaol market va
 * `add_order=false` market ham buyurtma yaratardi.
 */
type Market = { id: string; status?: string; add_order?: boolean } | 'missing';

function makeController(opts: {
  market?: Market;
  products?: Array<{ id: string; user_id: string; isDeleted?: boolean }>;
  catalogDown?: boolean;
}) {
  const orderClient = {
    send: jest.fn(() => of({ statusCode: 201, data: { id: '500' } })),
  };
  const identityClient = {
    send: jest.fn((pattern: { cmd: string }) => {
      if (pattern.cmd === 'identity.market.find_by_id') {
        const market = opts.market ?? {
          id: '16',
          status: 'active',
          add_order: true,
        };
        return market === 'missing'
          ? throwError(
              () =>
                new RpcException({
                  statusCode: 404,
                  message: 'Market topilmadi yoki faol emas',
                }),
            )
          : of({ data: market });
      }
      if (pattern.cmd === 'identity.customer.create') {
        return of({ data: { id: 'c-1' } });
      }
      return of({});
    }),
  };
  const catalogClient = {
    send: jest.fn(() =>
      opts.catalogDown
        ? throwError(() => new Error('catalog down'))
        : of({ data: opts.products ?? [] }),
    ),
  };
  const controller = new OrderGatewayController(
    orderClient as any,
    identityClient as any,
    { send: jest.fn(() => of({})) } as any,
    { send: jest.fn(() => of({ data: null })) } as any,
    undefined,
    undefined,
    catalogClient as any,
  );
  return { controller, orderClient, identityClient, catalogClient };
}

const body = (over: Record<string, unknown> = {}) =>
  ({
    market_id: '16',
    customer: {
      name: 'TEST',
      phone_number: '+998887009201',
      district_id: '173',
    },
    district_id: '173',
    total_price: 100000,
    items: [{ product_id: '4', quantity: 1 }],
    ...over,
  }) as any;
const req = (sub: string, roles: string[]) =>
  ({ user: { sub, username: 'u', roles } }) as any;
const created = (orderClient: { send: jest.Mock }) =>
  orderClient.send.mock.calls.filter((c: any[]) => c[0]?.cmd === 'order.create')
    .length;
const customerCreated = (identityClient: { send: jest.Mock }) =>
  identityClient.send.mock.calls.some(
    (c: any[]) => c[0]?.cmd === 'identity.customer.create',
  );

describe('POST /orders — market va mahsulot egaligi (UER0MpMX)', () => {
  it('⭐ TC1: mavjud bo`lmagan market_id → 404, mijoz ham buyurtma ham yaratilmaydi', async () => {
    const fx = makeController({ market: 'missing' });
    await expect(
      fx.controller.create(
        body({ market_id: '99999999' }),
        req('1', ['superadmin']),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(created(fx.orderClient)).toBe(0);
    expect(customerCreated(fx.identityClient)).toBe(false);
  });

  it('⭐ TC2: boshqa marketning product_id si → 404', async () => {
    const fx = makeController({ products: [{ id: '4', user_id: '3' }] });
    await expect(
      fx.controller.create(body(), req('1', ['superadmin'])),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(created(fx.orderClient)).toBe(0);
  });

  it('o`chirilgan yoki umuman yo`q mahsulot → 404', async () => {
    const deleted = makeController({
      products: [{ id: '4', user_id: '16', isDeleted: true }],
    });
    await expect(
      deleted.controller.create(body(), req('1', ['superadmin'])),
    ).rejects.toBeInstanceOf(NotFoundException);
    const none = makeController({ products: [] });
    await expect(
      none.controller.create(body(), req('1', ['superadmin'])),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('⭐ TC3: add_order=false — market roli → 400', async () => {
    const fx = makeController({
      market: { id: '16', status: 'active', add_order: false },
      products: [{ id: '4', user_id: '16' }],
    });
    await expect(
      fx.controller.create(body(), req('16', ['market'])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(created(fx.orderClient)).toBe(0);
  });

  it('add_order=false — admin market nomidan yaratishda davom etadi', async () => {
    const fx = makeController({
      market: { id: '16', status: 'active', add_order: false },
      products: [{ id: '4', user_id: '16' }],
    });
    await fx.controller.create(body(), req('1', ['admin']));
    expect(created(fx.orderClient)).toBe(1);
  });

  it('⭐ TC4: to`g`ri market + o`z mahsuloti → order.create chaqiriladi', async () => {
    const fx = makeController({ products: [{ id: '4', user_id: '16' }] });
    await fx.controller.create(body(), req('16', ['market']));
    expect(created(fx.orderClient)).toBe(1);
  });

  it.each(['inactive', 'blocked'])(
    '⭐ TC5: market status=%s → 400',
    async (status) => {
      const fx = makeController({
        market: { id: '16', status, add_order: true },
        products: [{ id: '4', user_id: '16' }],
      });
      await expect(
        fx.controller.create(body(), req('1', ['superadmin'])),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(created(fx.orderClient)).toBe(0);
    },
  );

  it('catalog javob bermasa — fail-closed 503 (tekshiruvsiz yaratilmaydi)', async () => {
    const fx = makeController({ catalogDown: true });
    await expect(
      fx.controller.create(body(), req('1', ['superadmin'])),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(created(fx.orderClient)).toBe(0);
  });

  it('faqat erkin matnli mahsulot (product_id yo`q) — catalog chaqirilmaydi', async () => {
    const fx = makeController({});
    await fx.controller.create(
      body({ items: [{ product_name: 'Katalogsiz', quantity: 1 }] }),
      req('1', ['superadmin']),
    );
    expect(fx.catalogClient.send).not.toHaveBeenCalled();
    expect(created(fx.orderClient)).toBe(1);
  });
});
