import 'reflect-metadata';
import { BadRequestException, INestApplication } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * VkKDSNNn — `GET /orders`, `/orders/export/excel`, `/orders/status-counts`
 * ombor filtrlari:
 *   - `warehouse_id` — musbat butun son (bigint), bo'shliqlar kesiladi;
 *   - `warehouse_kind` — HQ | REGIONAL (katta-kichik harf farqsiz → katta);
 *   - noto'g'ri qiymat — 400, order-service'ga so'rov yo'q;
 *   - berilmasa — so'rovda kalit yo'q (bugungidek);
 *   - yangi `@Query` parametrlari OXIRIDA — mavjud pozitsiyalar siljimagan.
 */
type Resolver = (
  filters: Record<string, unknown>,
  user: unknown,
) => Promise<{ kind: string; query?: Record<string, unknown> }>;

function makeController() {
  const orderClient = { send: jest.fn(() => of({ data: [], total: 0 })) };
  const controller = new OrderGatewayController(
    orderClient as never,
    { send: jest.fn(() => of({ data: null })) } as never,
    { send: jest.fn(() => of({})) } as never,
    { send: jest.fn(() => of({ data: null })) } as never,
  );
  const internals = controller as unknown as {
    resolveOrderListRequest: Resolver;
    resolveBranchAssignment: jest.Mock;
    isHqRegistrator: jest.Mock;
  };
  internals.resolveBranchAssignment = jest
    .fn()
    .mockResolvedValue({ branch_id: '13', role: 'MANAGER' });
  internals.isHqRegistrator = jest.fn().mockResolvedValue(false);
  // `internals` — controller'ning o'zi (`this` saqlanadi).
  const resolve: Resolver = (filters, user) =>
    internals.resolveOrderListRequest(filters, user);
  return { controller, orderClient, resolve };
}

type Handler = (...args: unknown[]) => Promise<unknown>;
type HandlerName = 'findAll' | 'statusCounts' | 'exportOrdersExcel';
/** Handler'ni pozitsion argumentlar bilan chaqirish (`this` — controller). */
const invoke = (
  controller: OrderGatewayController,
  name: HandlerName,
  args: unknown[],
) => (controller as unknown as Record<HandlerName, Handler>)[name](...args);

const admin = { sub: '2', roles: ['admin'] };
const market = { sub: '37', roles: ['market'] };
const manager = { sub: '25', roles: ['manager'] };
const courier = { sub: '289', roles: ['courier'] };

const sentQuery = (orderClient: { send: jest.Mock }, cmd: string) => {
  const call = (orderClient.send.mock.calls as unknown[][]).find(
    (args) => (args[0] as { cmd?: string })?.cmd === cmd,
  );
  return (call?.[1] as { query: Record<string, unknown> } | undefined)?.query;
};

/** GET /orders handler: 23 mavjud parametr + warehouse_id (24) + warehouse_kind (25). */
const findAllArgs = (user: unknown, warehouseId?: string, kind?: string) => {
  const args: unknown[] = Array.from({ length: 23 }, () => undefined);
  args[15] = { user };
  args.push(warehouseId, kind);
  return args;
};

describe('VkKDSNNn — GET /orders ombor filtrlari (gateway)', () => {
  describe('resolveOrderListRequest', () => {
    it('⭐ warehouse_id (kesiladi) va warehouse_kind (katta harf) so`rovga uzatiladi', async () => {
      const { resolve } = makeController();
      await expect(
        resolve({ warehouse_id: ' 42 ', warehouse_kind: 'hq' }, admin),
      ).resolves.toMatchObject({
        kind: 'query',
        query: { warehouse_id: '42', warehouse_kind: 'HQ' },
      });
      await expect(
        resolve({ warehouse_kind: ' Regional ' }, admin),
      ).resolves.toMatchObject({ query: { warehouse_kind: 'REGIONAL' } });
      await expect(
        resolve({ warehouse_id: '9223372036854775807' }, admin),
      ).resolves.toMatchObject({
        query: { warehouse_id: '9223372036854775807' },
      });
    });

    it('⭐ berilmasa / bo`sh — so`rovda kalit yo`q (bugungidek)', async () => {
      const { resolve } = makeController();
      for (const filters of [
        {},
        { warehouse_id: '', warehouse_kind: '' },
        { warehouse_id: '   ', warehouse_kind: '  ' },
      ]) {
        const res = await resolve(filters, admin);
        expect(res.query).not.toHaveProperty('warehouse_id');
        expect(res.query).not.toHaveProperty('warehouse_kind');
      }
    });

    it.each([
      '0',
      '-3',
      '007',
      'abc',
      '1.5',
      '1e3',
      '9223372036854775808',
      '99999999999999999999',
    ])('warehouse_id=%p — 400', async (warehouse_id) => {
      const { resolve, orderClient } = makeController();
      await expect(resolve({ warehouse_id }, admin)).rejects.toThrow(
        new BadRequestException(
          `Noto'g'ri warehouse_id qiymati: ${warehouse_id} (musbat butun son)`,
        ),
      );
      expect(orderClient.send).not.toHaveBeenCalled();
    });

    it('warehouse_id massiv (takroriy parametr) — 400', async () => {
      const { resolve } = makeController();
      await expect(
        resolve({ warehouse_id: ['1', '2'] }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each(['markaziy', 'BRANCH', 'WAREHOUSE', 'hq,regional'])(
      'warehouse_kind=%p — 400',
      async (warehouse_kind) => {
        const { resolve } = makeController();
        await expect(resolve({ warehouse_kind }, admin)).rejects.toThrow(
          new BadRequestException(
            `Noto'g'ri warehouse_kind qiymati: ${warehouse_kind} (HQ yoki REGIONAL)`,
          ),
        );
      },
    );

    it('⭐ kuryer «Bekor» tabi (status=cancelled) — ombor filtrlari ham uzatiladi (jim tashlanmaydi)', async () => {
      const { resolve } = makeController();
      const res = (await resolve(
        {
          status: 'cancelled',
          warehouse_id: ' 42 ',
          warehouse_kind: 'hq',
          fulfillment_source: 'warehouse',
        },
        courier,
      )) as { kind: string; filters?: Record<string, unknown> };
      expect(res.kind).toBe('courier_cancelled');
      expect(res.filters).toMatchObject({
        warehouse_id: '42',
        warehouse_kind: 'HQ',
        fulfillment_source: 'WAREHOUSE',
      });
      const plain = (await resolve({ status: 'cancelled' }, courier)) as {
        filters?: Record<string, unknown>;
      };
      expect(plain.filters).not.toHaveProperty('warehouse_id');
      expect(plain.filters).not.toHaveProperty('warehouse_kind');
      expect(plain.filters).not.toHaveProperty('fulfillment_source');
    });

    it('rol doirasi o`zgarmaydi: market — o`z id`si, filial xodimi — o`z filiali', async () => {
      const { resolve } = makeController();
      await expect(
        resolve({ warehouse_kind: 'hq' }, market),
      ).resolves.toMatchObject({
        query: { market_id: '37', warehouse_kind: 'HQ' },
      });
      await expect(
        resolve({ warehouse_id: '60', branch_id: '99' }, manager),
      ).resolves.toMatchObject({
        query: { branch_id: '13', warehouse_id: '60' },
      });
    });
  });

  describe('handler`lar (pozitsion parametrlar)', () => {
    it('⭐ GET /orders → find_all_enriched so`rovida; mavjud 23 parametr siljimagan', async () => {
      const { controller, orderClient } = makeController();
      const args = findAllArgs(admin, '42', 'regional');
      args[21] = 'warehouse'; // fulfillment_source — 22-pozitsiya
      args[22] = 'hq'; // cancel_stage — 23-pozitsiya
      await invoke(controller, 'findAll', args);
      expect(sentQuery(orderClient, 'order.find_all_enriched')).toMatchObject({
        fulfillment_source: 'WAREHOUSE',
        cancel_stages: ['hq'],
        warehouse_id: '42',
        warehouse_kind: 'REGIONAL',
      });
    });

    it('GET /orders: noto`g`ri qiymat — 400, order-service`ga so`rov yo`q', async () => {
      const { controller, orderClient } = makeController();
      await expect(
        invoke(controller, 'findAll', findAllArgs(admin, 'x1')),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        invoke(controller, 'findAll', findAllArgs(admin, undefined, 'ombor')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(orderClient.send).not.toHaveBeenCalled();
    });

    it('⭐ GET /orders/status-counts → order.status_counts `query`da', async () => {
      const { controller, orderClient } = makeController();
      orderClient.send.mockReturnValue(
        of({ by_status: {}, total: 0, cancelled: null, new_incoming: null }),
      );
      // (req, 16 mavjud filtr, warehouse_id, warehouse_kind)
      const args: unknown[] = [{ user: admin }];
      args.push(...Array.from({ length: 16 }, () => undefined));
      args.push('7', 'Hq');
      await invoke(controller, 'statusCounts', args);
      expect(sentQuery(orderClient, 'order.status_counts')).toMatchObject({
        warehouse_id: '7',
        warehouse_kind: 'HQ',
      });
    });

    it('GET /orders/export/excel ham ombor filtrlarini resolver`ga uzatadi', async () => {
      const { controller } = makeController();
      const spy = jest
        .spyOn(
          controller as unknown as { resolveOrderListRequest: Resolver },
          'resolveOrderListRequest',
        )
        .mockRejectedValue(new Error('__STOP__'));
      // (res, req, 19 mavjud filtr, warehouse_id, warehouse_kind)
      const args: unknown[] = [{} as never, { user: admin }];
      args.push(...Array.from({ length: 19 }, () => undefined));
      args.push('60', 'regional');
      await expect(
        invoke(controller, 'exportOrdersExcel', args),
      ).rejects.toThrow('__STOP__');
      expect(spy.mock.calls[0][0]).toMatchObject({
        warehouse_id: '60',
        warehouse_kind: 'regional',
      });
    });
  });
});

describe('VkKDSNNn — ombor filtrlari HTTP darajasida', () => {
  let app: INestApplication;
  const orderSend = jest.fn();
  const noop = { send: jest.fn(() => of({ data: {} })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderGatewayController],
      providers: [
        { provide: 'ORDER', useValue: { send: orderSend } },
        { provide: 'IDENTITY', useValue: noop },
        { provide: 'LOGISTICS', useValue: noop },
        { provide: 'BRANCH', useValue: noop },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => { user?: unknown } };
        }) => {
          ctx.switchToHttp().getRequest().user = {
            sub: '1',
            roles: ['admin'],
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => orderSend.mockReset());

  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);

  it('⭐ GET /orders?warehouse_kind=hq&warehouse_id=42 → order-service so`rovida (nomli @Query)', async () => {
    orderSend.mockReturnValue(of({ data: [], total: 0 }));
    const res = await http().get('/orders?warehouse_kind=hq&warehouse_id=42');
    expect(res.status).toBe(200);
    expect(
      sentQuery({ send: orderSend }, 'order.find_all_enriched'),
    ).toMatchObject({ warehouse_id: '42', warehouse_kind: 'HQ' });
  });

  it('GET /orders/status-counts?warehouse_kind=REGIONAL → order.status_counts', async () => {
    orderSend.mockReturnValue(
      of({ by_status: {}, total: 0, cancelled: null, new_incoming: null }),
    );
    const res = await http().get(
      '/orders/status-counts?warehouse_kind=REGIONAL',
    );
    expect(res.status).toBe(200);
    expect(sentQuery({ send: orderSend }, 'order.status_counts')).toMatchObject(
      { warehouse_kind: 'REGIONAL' },
    );
  });

  it.each([
    '/orders?warehouse_id=0',
    '/orders?warehouse_kind=ombor',
    '/orders/status-counts?warehouse_id=abc',
    '/orders/export/excel?warehouse_kind=x',
  ])('%s — 400, order-service`ga so`rov yo`q', async (url) => {
    const res = await http().get(url);
    expect(res.status).toBe(400);
    expect(orderSend).not.toHaveBeenCalled();
  });

  it('order-service 503 (HQ filiali aniqlanmadi) — HTTP 503', async () => {
    orderSend.mockReturnValue(
      throwError(() =>
        new RpcException({
          statusCode: 503,
          message: "Markaziy filial aniqlanmadi — qayta urinib ko'ring",
        }).getError(),
      ),
    );
    const res = await http().get('/orders/status-counts?warehouse_kind=hq');
    expect(res.status).toBe(503);
  });
});
