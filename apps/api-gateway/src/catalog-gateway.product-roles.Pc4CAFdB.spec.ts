import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter, Roles as RoleEnum } from '@app/common';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { BodyStatusCodeInterceptor } from './body-status-code.interceptor';
import { CatalogGatewayController } from './catalog-gateway.controller';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * Pc4CAFdB — mahsulot yaratish/o'chirish faqat superadmin · admin ·
 * registrator · menejer (market va market operatori chiqarildi),
 * `PATCH /product/my/:id` olib tashlandi.
 *
 * HAQIQIY Nest routeri + HAQIQIY RolesGuard + gateway'ning global
 * ValidationPipe opsiyalari va AllExceptionsFilter. Faqat JwtAuthGuard
 * almashtiriladi (token o'rniga `user` qo'yadi).
 */

const MEASURES = {
  weight_kg: '1.2',
  length_cm: '30',
  width_cm: '22',
  height_cm: '15',
};

const MARKET = { sub: '121', roles: [RoleEnum.MARKET] };
const OPERATOR = { sub: '501', roles: [RoleEnum.MARKET_OPERATOR] };
const REGISTRATOR = { sub: '77', roles: [RoleEnum.REGISTRATOR] };
const MANAGER = { sub: '78', roles: [RoleEnum.MANAGER] };
const ADMIN = { sub: '1', roles: [RoleEnum.ADMIN] };
const SUPERADMIN = { sub: '2', roles: [RoleEnum.SUPERADMIN] };

describe('Pc4CAFdB — mahsulot yaratish/o`chirish rollari (gateway, HTTP)', () => {
  let app: INestApplication;
  const catalogSend = jest.fn();
  const fileSend = jest.fn();
  const identitySend = jest.fn(() =>
    of({ data: { id: OPERATOR.sub, market_id: '121' } }),
  );
  let user: { sub: string; roles: string[] } | null = null;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CatalogGatewayController],
      providers: [
        { provide: 'CATALOG', useValue: { send: catalogSend } },
        { provide: 'FILE', useValue: { send: fileSend } },
        { provide: 'IDENTITY', useValue: { send: identitySend } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = user;
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(new BodyStatusCodeInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    catalogSend.mockReset();
    catalogSend.mockImplementation((pattern: { cmd: string }) => {
      if (pattern.cmd === 'catalog.product.create') {
        return of({ statusCode: 201, data: { id: '9', user_id: '121' } });
      }
      if (pattern.cmd === 'catalog.product.delete') {
        return of({ statusCode: 200, data: { id: '9' } });
      }
      return of({ data: [], total: 0, page: 1, limit: 10 });
    });
    fileSend.mockClear();
    identitySend.mockClear();
    user = null;
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const createCalls = () =>
    catalogSend.mock.calls.filter(
      ([pattern]) =>
        (pattern as { cmd: string }).cmd === 'catalog.product.create',
    );

  it('⭐ TC1: market tokeni bilan POST /product → 403 (catalog chaqirilmaydi)', async () => {
    user = MARKET;
    const res = await request(http())
      .post('/product')
      .send({ name: 'Olma', market_id: '121', ...MEASURES });
    expect(res.status).toBe(403);
    expect(createCalls()).toHaveLength(0);
  });

  it('⭐ TC2: market_operator tokeni bilan POST /product → 403 (identity ham chaqirilmaydi)', async () => {
    user = OPERATOR;
    const res = await request(http())
      .post('/product')
      .send({ name: 'Olma', ...MEASURES });
    expect(res.status).toBe(403);
    expect(createCalls()).toHaveLength(0);
    expect(identitySend).not.toHaveBeenCalled();
  });

  it.each([
    ['TC3 registrator', REGISTRATOR],
    ['TC4 manager', MANAGER],
    ['admin', ADMIN],
    ['superadmin', SUPERADMIN],
  ])(
    '⭐ %s + market_id bilan POST /product → 201, user_id = market_id',
    async (_label, who) => {
      user = who;
      const res = await request(http())
        .post('/product')
        .send({ name: 'Olma', market_id: '121', ...MEASURES });
      expect(res.status).toBe(201);
      expect(createCalls()).toHaveLength(1);
      expect(createCalls()[0][1]).toMatchObject({
        dto: { name: 'Olma', user_id: '121', weight_kg: 1.2 },
      });
    },
  );

  it.each([
    ['admin', ADMIN],
    ['registrator', REGISTRATOR],
    ['manager', MANAGER],
  ])(
    '⭐ TC5: %s market_id yubormasa (yoki bo`sh) → 400',
    async (_label, who) => {
      user = who;
      for (const extra of [{}, { market_id: '' }, { market_id: '   ' }]) {
        const res = await request(http())
          .post('/product')
          .send({ name: 'Olma', ...MEASURES, ...extra });
        expect(res.status).toBe(400);
      }
      expect(createCalls()).toHaveLength(0);
    },
  );

  it('⭐ TC6: market tokeni bilan DELETE /product/:id → 403; xodim — 200', async () => {
    user = MARKET;
    const denied = await request(http()).delete('/product/9');
    expect(denied.status).toBe(403);
    expect(catalogSend).not.toHaveBeenCalled();

    user = OPERATOR;
    expect((await request(http()).delete('/product/9')).status).toBe(403);
    expect(catalogSend).not.toHaveBeenCalled();

    user = REGISTRATOR;
    const ok = await request(http()).delete('/product/9');
    expect(ok.status).toBe(200);
    expect(catalogSend).toHaveBeenCalledWith(
      { cmd: 'catalog.product.delete' },
      { id: '9', requester: { id: '77', roles: [RoleEnum.REGISTRATOR] } },
    );
  });

  it.each([
    ['market', MARKET],
    ['market_operator', OPERATOR],
    ['admin', ADMIN],
  ])(
    '⭐ TC7: PATCH /product/my/:id → 404 (endpoint olib tashlangan) — %s',
    async (_label, who) => {
      user = who;
      const res = await request(http())
        .patch('/product/my/9')
        .send({ name: 'Yangi' });
      expect(res.status).toBe(404);
      expect(catalogSend).not.toHaveBeenCalled();
    },
  );

  it('⭐ TC9: market mahsulotlar RO`YXATINI hamon ko`radi (GET /product, GET /product/my-products → 200)', async () => {
    user = MARKET;
    const list = await request(http()).get('/product');
    expect(list.status).toBe(200);
    const mine = await request(http()).get('/product/my-products');
    expect(mine.status).toBe(200);
    const listCalls = catalogSend.mock.calls.filter(
      ([pattern]) =>
        (pattern as { cmd: string }).cmd === 'catalog.product.find_all',
    );
    expect(listCalls).toHaveLength(2);
    for (const [, payload] of listCalls) {
      expect(payload).toMatchObject({ query: { user_id: '121' } });
    }
  });
});

describe('Pc4CAFdB — metadata tekshiruvlari', () => {
  const proto = CatalogGatewayController.prototype as unknown as Record<
    string,
    unknown
  >;

  it('⭐ TC8: CatalogGatewayController — har bir himoyalangan handler`da RolesGuard va BO`SH BO`LMAGAN @Roles (fail-open yo`q)', () => {
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (name) =>
        name !== 'constructor' &&
        typeof proto[name] === 'function' &&
        Reflect.getMetadata(PATH_METADATA, proto[name] as object) !== undefined,
    );
    expect(handlers.length).toBeGreaterThan(5);
    for (const name of handlers) {
      const handler = proto[name] as object;
      if (Reflect.getMetadata('isPublic', handler) === true) continue;
      expect({
        name,
        guarded: (
          (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[]) ?? []
        ).includes(RolesGuard),
      }).toEqual({ name, guarded: true });
      const roles = (Reflect.getMetadata(ROLES_KEY, handler) as string[]) ?? [];
      expect({ name, roles: roles.length > 0 }).toEqual({ name, roles: true });
    }
    expect(handlers).not.toContain('updateMyProduct');
  });

  it('⭐ TC10: buyurtma rollari TEGILMAGAN — market POST /orders da hamon bor', () => {
    const create = Object.getOwnPropertyDescriptor(
      OrderGatewayController.prototype,
      'create',
    )?.value as object;
    expect(Reflect.getMetadata(GUARDS_METADATA, create)).toContain(RolesGuard);
    const roles = Reflect.getMetadata(ROLES_KEY, create) as string[];
    expect(roles).toEqual(
      expect.arrayContaining([
        RoleEnum.MARKET,
        RoleEnum.MARKET_OPERATOR,
        RoleEnum.ADMIN,
        RoleEnum.SUPERADMIN,
        RoleEnum.REGISTRATOR,
        RoleEnum.MANAGER,
      ]),
    );
  });
});
