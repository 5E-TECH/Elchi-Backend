import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * fix3 A2 — buyurtma YARATISH (POST /orders, /orders/external, bot).
 *
 *  - C6 / RBAC-05 / LC-07: hayot sikli va saqlash maydonlari (status,
 *    post_id, courier_id, batch, assigned_at, return_reason) hamda market
 *    uchun branch_id/source faqat SUPERADMIN/ADMIN dan qabul qilinadi.
 *  - RBAC-01: tayyor `customer_id` faqat SUPERADMIN/ADMIN dan — boshqalar
 *    mijozni `customer` obyektidan aniqlaydi.
 *  - LC-14: bot buyurtmasi CREATED emas, sukutdagi NEW.
 */
describe('fix3 A2 — order create hardening', () => {
  const LIFECYCLE_FIELDS = [
    'status',
    'post_id',
    'courier_id',
    'current_batch_id',
    'assigned_at',
    'return_reason',
  ];

  const abuseDto = {
    market_id: '999',
    customer: { name: 'Ali', phone_number: '+998901112233', district_id: '5' },
    total_price: 120000,
    status: 'received',
    post_id: '41',
    courier_id: '179',
    current_batch_id: '7',
    assigned_at: '2026-10-01T09:00:00+05:00',
    return_reason: 'x',
    branch_id: '21',
    source: 'branch',
    district_id: '5',
    region_id: '2',
    address: 'Chilonzor',
    items: [{ product_id: '10', quantity: 1 }],
  };

  const makeController = (opts?: {
    branchAssignment?: Record<string, unknown> | null;
    operatorMarketId?: string | null;
  }) => {
    const orderClient = {
      send: jest.fn(() => of({ statusCode: 201, data: { id: '500' } })),
    };
    const identityClient = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'identity.customer.create') {
          return of({ data: { id: 'c-new' } });
        }
        if (pattern.cmd === 'identity.user.find_by_id') {
          return of({ data: { market_id: opts?.operatorMarketId ?? null } });
        }
        return of({});
      }),
    };
    const logisticsClient = { send: jest.fn(() => of({})) };
    const branchClient = {
      send: jest.fn(() => of({ data: opts?.branchAssignment ?? null })),
    };
    const controller = new OrderGatewayController(
      orderClient as any,
      identityClient as any,
      logisticsClient as any,
      branchClient as any,
    );
    return { controller, orderClient, identityClient, branchClient };
  };

  const sentCreate = (orderClient: { send: jest.Mock }, cmd: string) => {
    const calls = orderClient.send.mock.calls as unknown[][];
    const call = calls.find(
      (args) => (args[0] as { cmd?: string } | undefined)?.cmd === cmd,
    ) as
      | [unknown, { dto: Record<string, unknown>; requester?: unknown }]
      | undefined;
    expect(call).toBeDefined();
    return call![1];
  };

  const userReq = (sub: string, roles: string[]) =>
    ({ user: { sub, username: 'u', roles } }) as any;

  it('MARKET: holat/saqlash/joylashuv maydonlari olib tashlanadi, market_id tokendan', async () => {
    const { controller, orderClient } = makeController();

    await controller.create(abuseDto as any, userReq('201', ['market']));

    const { dto } = sentCreate(orderClient, 'order.create');
    for (const field of LIFECYCLE_FIELDS) {
      expect(dto[field]).toBeUndefined();
    }
    expect(dto.branch_id).toBeNull();
    expect(dto.source).toBeUndefined();
    expect(dto.market_id).toBe('201');
    // Xavfsiz maydonlar saqlanadi.
    expect(dto).toEqual(
      expect.objectContaining({
        total_price: 120000,
        district_id: '5',
        region_id: '2',
        address: 'Chilonzor',
        items: [{ product_id: '10', quantity: 1 }],
      }),
    );
  });

  it('MARKET: begona customer_id e’tiborsiz — mijoz customer obyektidan', async () => {
    const { controller, orderClient, identityClient } = makeController();

    await controller.create(
      { ...abuseDto, customer_id: '1' } as any,
      userReq('201', ['market']),
    );

    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.customer.create' },
      { dto: abuseDto.customer },
    );
    expect(sentCreate(orderClient, 'order.create').dto.customer_id).toBe(
      'c-new',
    );
  });

  it('MARKET: faqat customer_id (customer obyektsiz) -> 400, buyurtma yaratilmaydi', async () => {
    const { controller, orderClient } = makeController();

    await expect(
      controller.create(
        { customer_id: '1', total_price: 1 } as any,
        userReq('201', ['market']),
      ),
    ).rejects.toThrow(/customer_id faqat admin uchun/);
    expect(orderClient.send).not.toHaveBeenCalled();
  });

  it('ADMIN: shartnoma bo‘yicha maydonlar saqlanadi (status, branch_id, customer_id)', async () => {
    const { controller, orderClient, identityClient } = makeController();

    await controller.create(
      { ...abuseDto, customer: undefined, customer_id: '55' } as any,
      userReq('1', ['admin']),
    );

    const { dto } = sentCreate(orderClient, 'order.create');
    expect(dto.status).toBe('received');
    expect(dto.courier_id).toBe('179');
    expect(dto.branch_id).toBe('21');
    expect(dto.source).toBe('branch');
    expect(dto.customer_id).toBe('55');
    expect(dto.market_id).toBe('999');
    expect(identityClient.send).not.toHaveBeenCalled();
  });

  it('REGISTRATOR (filial xodimi): status/kuryer olib tashlanadi, filial majburan', async () => {
    const { controller, orderClient } = makeController({
      branchAssignment: { branch_id: '21', role: 'REGISTRATOR' },
    });

    await controller.create(
      {
        ...abuseDto,
        status: 'sold',
        source: undefined,
        branch_id: undefined,
      } as any,
      userReq('300', ['registrator']),
    );

    const { dto } = sentCreate(orderClient, 'order.create');
    for (const field of LIFECYCLE_FIELDS) {
      expect(dto[field]).toBeUndefined();
    }
    expect(dto.branch_id).toBe('21');
    expect(dto.source).toBe('branch');
    expect(dto.operator_id).toBe('300');
  });

  it('REGISTRATOR: boshqa filial branch_id yuborsa avvalgidek 400 (himoya kuchsizlanmadi)', async () => {
    const { controller } = makeController({
      branchAssignment: { branch_id: '21', role: 'REGISTRATOR' },
    });

    await expect(
      controller.create(
        { ...abuseDto, branch_id: '99', source: undefined } as any,
        userReq('300', ['registrator']),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('LC-14: bot buyurtmasi status yubormaydi (NEW), market operatordan aniqlanadi', async () => {
    const { controller, orderClient } = makeController({
      operatorMarketId: '201',
    });

    await controller.botOrderCreate(
      {
        name: 'Ali',
        phone_number: '+998901112233',
        district_id: '5',
        order_item_info: [{ product_id: '10', quantity: 1 }],
        total_price: 50000,
      } as any,
      userReq('400', ['market_operator']),
    );

    const { dto } = sentCreate(orderClient, 'order.create');
    expect(dto.status).toBeUndefined();
    expect(dto.market_id).toBe('201');
    expect(dto.operator_id).toBe('400');
  });

  it('POST /orders/external (MARKET): maydonlar olib tashlanadi, requester uzatiladi', async () => {
    const { controller, orderClient, identityClient } = makeController();

    await controller.createExternal(
      { ...abuseDto, customer_id: '1', external_id: 'EXT-1' } as any,
      userReq('201', ['market']),
    );

    const payload = sentCreate(orderClient, 'order.external.create');
    for (const field of LIFECYCLE_FIELDS) {
      expect(payload.dto[field]).toBeUndefined();
    }
    expect(payload.dto.branch_id).toBeUndefined();
    expect(payload.dto.source).toBeUndefined();
    expect(payload.dto.market_id).toBe('201');
    expect(payload.dto.external_id).toBe('EXT-1');
    expect(payload.dto.customer_id).toBe('c-new');
    expect(payload.requester).toEqual({ id: '201', roles: ['market'] });
    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.customer.create' },
      expect.anything(),
    );
  });

  it('POST /orders/external (MARKET): faqat customer_id -> 400', async () => {
    const { controller, orderClient } = makeController();

    await expect(
      controller.createExternal(
        { customer_id: '1' } as any,
        userReq('201', ['market']),
      ),
    ).rejects.toThrow(/customer_id faqat admin uchun/);
    expect(orderClient.send).not.toHaveBeenCalled();
  });

  it('POST /orders/external (SUPERADMIN): maydonlar saqlanadi, requester uzatiladi', async () => {
    const { controller, orderClient } = makeController();

    await controller.createExternal(
      { ...abuseDto, customer: undefined, customer_id: '55' } as any,
      userReq('1', ['superadmin']),
    );

    const payload = sentCreate(orderClient, 'order.external.create');
    expect(payload.dto.status).toBe('received');
    expect(payload.dto.customer_id).toBe('55');
    expect(payload.requester).toEqual({ id: '1', roles: ['superadmin'] });
  });
});
