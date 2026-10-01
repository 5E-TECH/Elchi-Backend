import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ClientProxy } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of } from 'rxjs';
import {
  AUTH_REFRESH_THROTTLE,
  AUTH_THROTTLE,
  AuthGatewayController,
  authThrottleConfig,
} from './auth-gateway.controller';
import { PartnerApiKeyGuard } from './auth/partner-api-key.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { CatalogGatewayController } from './catalog-gateway.controller';
import { ExcelGatewayController } from './excel-gateway.controller';
import { isPartnerProvisionedMarket } from './partner-gateway.controller';
import {
  PRINT_MAX_ORDER_IDS,
  PrintOrdersDto,
  PrinterGatewayController,
} from './printer-gateway.controller';
import { formatDateStr } from './printer/printer.util';
import { ScanGatewayController } from './scan-gateway.controller';

/**
 * fix3 A2 — gateway HTTP qatlami (order-gateway'dan tashqari):
 * RBAC-08 (printer), CODE-22 (yorliq sanasi, orders.xlsx sana filtri),
 * RBAC-12 (hamkor IP allowlist), RBAC-13 (hamkor tarifi), C10/RBAC-11
 * (auth rate limit), C11/CODE-04/CODE-08 (orders.xlsx, /product, /scan).
 */
const sends = (client: { send: jest.Mock }, cmd: string) =>
  (client.send.mock.calls as unknown[][]).filter(
    (args) => (args[0] as { cmd?: string } | undefined)?.cmd === cmd,
  );

describe('fix3 A2 — printer (RBAC-08, CODE-22)', () => {
  it('faqat SUPERADMIN/ADMIN (klass darajasida RolesGuard)', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      PrinterGatewayController,
    ) as string[];
    expect([...roles].sort()).toEqual(['admin', 'superadmin']);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, PrinterGatewayController),
    ).toContain(RolesGuard);
  });

  it(`order_ids ${PRINT_MAX_ORDER_IDS} tadan ko'p bo'lsa DTO rad etadi`, async () => {
    const ids = (count: number) =>
      Array.from({ length: count }, (_, i) => String(i + 1));
    const tooMany = await validate(
      plainToInstance(PrintOrdersDto, {
        order_ids: ids(PRINT_MAX_ORDER_IDS + 1),
      }),
    );
    expect(tooMany.map((e) => e.property)).toContain('order_ids');
    const ok = await validate(
      plainToInstance(PrintOrdersDto, { order_ids: ids(PRINT_MAX_ORDER_IDS) }),
    );
    expect(ok).toHaveLength(0);
  });

  it('ValidationPipe’siz chaqiruvda ham chegara: order-service chaqirilmaydi', async () => {
    const orderClient = { send: jest.fn(() => of({ data: [] })) };
    const controller = new PrinterGatewayController(orderClient as any);
    const res = { set: jest.fn(), end: jest.fn() };
    await expect(
      controller.receipt(
        {
          order_ids: Array.from({ length: PRINT_MAX_ORDER_IDS + 1 }, (_, i) =>
            String(i),
          ),
        },
        res as any,
      ),
    ).rejects.toThrow(/ko'pi bilan/);
    expect(orderClient.send).not.toHaveBeenCalled();
  });

  it('yorliq sanasi Toshkent kuni (UTC 21:30 = Toshkentda ertasi kun)', () => {
    const sameLocaleUtc = (y: number, m: number, d: number) =>
      new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('uz-UZ', {
        timeZone: 'UTC',
      });
    // 2026-09-30 21:30 UTC = 2026-10-01 02:30 Toshkent.
    expect(formatDateStr(Date.UTC(2026, 8, 30, 21, 30))).toBe(
      sameLocaleUtc(2026, 10, 1),
    );
    // 2026-09-30 18:59 UTC = 2026-09-30 23:59 Toshkent.
    expect(formatDateStr(Date.UTC(2026, 8, 30, 18, 59))).toBe(
      sameLocaleUtc(2026, 9, 30),
    );
  });
});

describe('fix3 A2 — PartnerApiKeyGuard CF-Connecting-IP (RBAC-12)', () => {
  const makeGuard = () =>
    new PartnerApiKeyGuard({
      send: jest.fn(() =>
        of({
          id: '7',
          name: 'Acme',
          is_active: true,
          ip_allowlist: ['203.0.113.10'],
        }),
      ),
    } as unknown as ClientProxy);

  const contextFor = (headers: Record<string, unknown>, ip?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-api-key': 'elp_x', ...headers },
          ip,
        }),
      }),
    }) as unknown as ExecutionContext;

  it('soxta X-Forwarded-For (req.ip ruxsatda), lekin CF IP begona -> 403', async () => {
    await expect(
      makeGuard().canActivate(
        contextFor({ 'cf-connecting-ip': '198.51.100.9' }, '203.0.113.10'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('CF-Connecting-IP ruxsat ro‘yxatida -> o‘tadi', async () => {
    await expect(
      makeGuard().canActivate(
        contextFor({ 'cf-connecting-ip': '203.0.113.10' }, '10.0.0.5'),
      ),
    ).resolves.toBe(true);
  });

  it('CF sarlavhasi yo‘q (lokal) -> req.ip ishlatiladi (avvalgi xulq)', async () => {
    await expect(
      makeGuard().canActivate(contextFor({}, '203.0.113.10')),
    ).resolves.toBe(true);
  });
});

describe('fix3 A2 — hamkor tarifi egaligi (RBAC-13)', () => {
  it.each([
    [{ username: 'mp7_shop1' }, '7', true],
    [{ username: 'MP7_Shop1' }, '7', true],
    [{ username: 'mp70_shop' }, '7', false],
    [{ username: 'mp7_shop' }, '70', false],
    [{ username: 'yandex' }, '7', false],
    [{ username: null }, '7', false],
    [{ username: 'mp7_shop' }, undefined, false],
    [{ username: 'mp_shop' }, '', false],
  ])('%j / partner %s -> %s', (market, partnerId, expected) => {
    expect(isPartnerProvisionedMarket(market, partnerId)).toBe(expected);
  });
});

describe('fix3 A2 — auth rate limit (C10, RBAC-11)', () => {
  const metadata = (handler: unknown, key: string) =>
    Reflect.getMetadata(`THROTTLER:${key}default`, handler as object) as
      | number
      | undefined;

  it('sukut: login 30/min, refresh 60/min (alohida o‘zgaruvchilar)', () => {
    expect(authThrottleConfig({})).toEqual({
      login: { default: { limit: 30, ttl: 60_000 } },
      refresh: { default: { limit: 60, ttl: 60_000 } },
    });
  });

  it('env bilan o‘zgartiriladi; eski AUTH_THROTTLE_LIMIT refresh’ga ta’sir qilmaydi', () => {
    const config = authThrottleConfig({
      AUTH_THROTTLE_LIMIT: '10',
      AUTH_REFRESH_THROTTLE_LIMIT: '90',
      AUTH_REFRESH_THROTTLE_TTL_MS: '30000',
    });
    expect(config.login.default.limit).toBe(10);
    expect(config.refresh.default).toEqual({ limit: 90, ttl: 30_000 });
  });

  it('noto‘g‘ri qiymat -> sukut (NaN/0 limit bo‘lib qolmaydi)', () => {
    const config = authThrottleConfig({
      AUTH_THROTTLE_LIMIT: 'abc',
      AUTH_REFRESH_THROTTLE_LIMIT: '0',
    });
    expect(config.login.default.limit).toBe(30);
    expect(config.refresh.default.limit).toBe(60);
  });

  it('refresh va login handlerlarida o‘z limiti turadi', () => {
    const handler = (name: keyof AuthGatewayController): object =>
      Object.getOwnPropertyDescriptor(AuthGatewayController.prototype, name)
        ?.value as object;
    expect(metadata(handler('refresh'), 'LIMIT')).toBe(
      AUTH_REFRESH_THROTTLE.default.limit,
    );
    expect(metadata(handler('login'), 'LIMIT')).toBe(
      AUTH_THROTTLE.default.limit,
    );
    expect(metadata(handler('refresh'), 'TTL')).toBe(
      AUTH_REFRESH_THROTTLE.default.ttl,
    );
  });
});

describe('fix3 A2 — orders.xlsx (C11 CODE-04, CODE-22)', () => {
  const setup = (branchLookup?: unknown) => {
    const orderClient = {
      send: jest.fn(() => of({ data: [], total: 0 })),
    };
    const financeClient = { send: jest.fn() };
    const branchClient = {
      send: jest.fn(() => of(branchLookup ?? { data: null })),
    };
    const controller = new ExcelGatewayController(
      orderClient as any,
      financeClient as any,
      branchClient as any,
    );
    const res = { set: jest.fn(), end: jest.fn() };
    return { controller, orderClient, branchClient, res };
  };

  const exportAs = (
    fx: ReturnType<typeof setup>,
    user: Record<string, unknown>,
    query: {
      branch_id?: string;
      courier_id?: string;
      from?: string;
      to?: string;
    } = {},
  ) =>
    fx.controller.exportOrders(
      fx.res as any,
      undefined,
      undefined,
      undefined,
      query.courier_id,
      query.branch_id,
      query.from,
      query.to,
      { user: user as any },
    );

  const sentQuery = (fx: ReturnType<typeof setup>) =>
    (
      sends(fx.orderClient, 'order.find_all_enriched')[0][1] as {
        query: Record<string, unknown>;
      }
    ).query;

  it('MANAGER: branch_id so‘rovdan EMAS — o‘z filiali (JWT)', async () => {
    const fx = setup();
    await exportAs(fx, { sub: '55', roles: ['manager'], branch_id: '21' });
    expect(sentQuery(fx).branch_id).toBe('21');
    expect(fx.branchClient.send).not.toHaveBeenCalled();
    expect(fx.res.end).toHaveBeenCalled();
  });

  it('REGISTRATOR: begona branch_id e’tiborsiz, filial branch-service’dan', async () => {
    const fx = setup({ data: { branch_id: '22', role: 'REGISTRATOR' } });
    await exportAs(
      fx,
      { sub: '300', roles: ['registrator'] },
      { branch_id: '99' },
    );
    expect(sentQuery(fx).branch_id).toBe('22');
  });

  it('filialsiz xodim -> 403, eksport bo‘lmaydi', async () => {
    const fx = setup({ data: null });
    await expect(
      exportAs(fx, { sub: '300', roles: ['branch'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fx.orderClient.send).not.toHaveBeenCalled();
  });

  it('ADMIN: branch_id so‘rovdan; sana va kuryer filtrlari order-service kalitlariga', async () => {
    const fx = setup();
    await exportAs(
      fx,
      { sub: '1', roles: ['admin'] },
      {
        branch_id: '21',
        courier_id: '179',
        from: '2026-10-01',
        to: '2026-10-02',
      },
    );
    expect(sentQuery(fx)).toEqual(
      expect.objectContaining({
        branch_id: '21',
        courier_ids: ['179'],
        start_day: '2026-10-01',
        end_day: '2026-10-02',
      }),
    );
    expect(sentQuery(fx).from_date).toBeUndefined();
    expect(sentQuery(fx).courier_id).toBeUndefined();
  });
});

describe('fix3 A2 — /product o‘qish (C11, CODE-08)', () => {
  const setup = (product?: Record<string, unknown>) => {
    const catalogClient = {
      send: jest.fn((pattern: { cmd: string }) =>
        pattern.cmd === 'catalog.product.find_by_id'
          ? of(product)
          : of({ data: [] }),
      ),
    };
    const controller = new CatalogGatewayController(
      catalogClient as any,
      { send: jest.fn() } as any,
    );
    return { controller, catalogClient };
  };

  it('GET /product va /product/:id — RolesGuard; kuryer/mijoz/investor yo‘q', () => {
    for (const name of ['findAll', 'findById'] as const) {
      const handler = Object.getOwnPropertyDescriptor(
        CatalogGatewayController.prototype,
        name,
      )?.value as object;
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
        RolesGuard,
      );
      const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[];
      for (const denied of [
        'courier',
        'customer',
        'investor',
        'operator',
        'market_operator',
      ]) {
        expect(roles).not.toContain(denied);
      }
      expect(roles).toEqual(
        expect.arrayContaining([
          'superadmin',
          'admin',
          'registrator',
          'market',
        ]),
      );
    }
  });

  it('MARKET: ro‘yxat doim o‘z mahsulotlari; boshqa market id -> 403', () => {
    const { controller, catalogClient } = setup();
    void controller.findAll(undefined, undefined, 'olma', '1', '10', {
      user: { sub: '201', roles: ['market'] },
    });
    expect(catalogClient.send).toHaveBeenCalledWith(
      { cmd: 'catalog.product.find_all' },
      { query: { user_id: '201', search: 'olma', page: 1, limit: 10 } },
    );
    expect(() =>
      controller.findAll('202', undefined, undefined, undefined, undefined, {
        user: { sub: '201', roles: ['market'] },
      }),
    ).toThrow(ForbiddenException);
  });

  it('ADMIN: market_id filtri avvalgidek', () => {
    const { controller, catalogClient } = setup();
    void controller.findAll('202', undefined, undefined, undefined, undefined, {
      user: { sub: '1', roles: ['admin'] },
    });
    expect(catalogClient.send).toHaveBeenCalledWith(
      { cmd: 'catalog.product.find_all' },
      expect.objectContaining({
        query: expect.objectContaining({ user_id: '202' }),
      }),
    );
  });

  it('GET /product/:id: MARKET boshqa market mahsuloti -> 403, o‘ziniki -> OK', async () => {
    const other = setup({ id: '5', user_id: '202', name: 'x' });
    await expect(
      other.controller.findById('5', {
        user: { sub: '201', roles: ['market'] },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const own = setup({ id: '5', user_id: '201', name: 'x' });
    await expect(
      own.controller.findById('5', { user: { sub: '201', roles: ['market'] } }),
    ).resolves.toMatchObject({ id: '5' });
  });

  it("GET /product/:id: eski { statusCode, data } o'rami ham tekshiriladi", async () => {
    const wrapped = setup({
      statusCode: 200,
      data: { id: '5', user_id: '202', name: 'x' },
    } as Record<string, unknown>);
    await expect(
      wrapped.controller.findById('5', {
        user: { sub: '201', roles: ['market'] },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('GET /product/:id: REGISTRATOR -> cheklanmaydi', async () => {
    const { controller } = setup({ id: '5', user_id: '202' });
    await expect(
      controller.findById('5', {
        user: { sub: '300', roles: ['registrator'] },
      }),
    ).resolves.toMatchObject({ id: '5' });
  });
});

describe('fix3 A2 — GET /scan/:token buyurtma tokeni (C11, CODE-04)', () => {
  const setup = (orderData: Record<string, unknown>) => {
    const orderClient = { send: jest.fn(() => of({ data: orderData })) };
    const branchClient = { send: jest.fn(() => of({ data: { id: 'b1' } })) };
    const logisticsClient = { send: jest.fn() };
    const controller = new ScanGatewayController(
      orderClient as any,
      branchClient as any,
      logisticsClient as any,
    );
    return { controller, orderClient, branchClient };
  };

  it.each([['customer'], ['investor'], ['operator'], ['market_operator']])(
    '%s -> 403, order-service chaqirilmaydi',
    async (role) => {
      const fx = setup({ id: '1', market_id: '201' });
      await expect(
        fx.controller.scan('ORD-abc', { user: { sub: '9', roles: [role] } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(fx.orderClient.send).not.toHaveBeenCalled();
    },
  );

  it('MARKET: boshqa market buyurtmasi -> 403, o‘ziniki -> OK', async () => {
    const other = setup({ id: '1', market_id: '202' });
    await expect(
      other.controller.scan('ORD-abc', {
        user: { sub: '201', roles: ['market'] },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const own = setup({ id: '1', market_id: '201' });
    await expect(
      own.controller.scan('ORD-abc', {
        user: { sub: '201', roles: ['market'] },
      }),
    ).resolves.toEqual({ type: 'order', data: { id: '1', market_id: '201' } });
  });

  it('paket (BTB-) tokeni bu tekshiruvga tushmaydi — branch-service hal qiladi', async () => {
    const fx = setup({});
    await expect(
      fx.controller.scan('BTB-x', { user: { sub: '9', roles: ['customer'] } }),
    ).resolves.toMatchObject({ type: 'batch' });
    expect(
      sends(fx.branchClient, 'branch.transfer_batch.find_by_token'),
    ).toHaveLength(1);
  });
});
