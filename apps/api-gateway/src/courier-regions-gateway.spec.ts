import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ApiGatewayController } from './api-gateway.controller';

/**
 * hEjjuJaT — GET/PUT /couriers/:id/regions (super-kuryer viloyatlari va
 * viloyat tarifi). HAQIQIY router + RolesGuard + main.ts ValidationPipe.
 */
const fakeJwtGuard = {
  canActivate: (ctx: ExecutionContext) => {
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const role = req.headers['x-test-role'];
    if (!role) return false;
    req.user = { sub: '1', username: 'u', roles: [role] };
    return true;
  },
};

describe('hEjjuJaT — /couriers/:id/regions (gateway)', () => {
  let app: INestApplication;
  const identitySend = jest.fn();
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const noop = { send: jest.fn(() => of({})) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: { send: identitySend } },
        { provide: 'FINANCE', useValue: noop },
        { provide: 'BRANCH', useValue: noop },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(fakeJwtGuard)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    identitySend.mockReset();
    identitySend.mockReturnValue(of({ statusCode: 200, data: {} }));
  });

  const body = {
    is_super_courier: true,
    serves_all_regions: false,
    regions: [
      { region_id: '5', tariff_home: 15000 },
      { region_id: '6', tariff_home: null, tariff_center: null },
    ],
  };

  it.each(['superadmin', 'admin'])(
    'PUT %s → identity.courier.regions.set (so‘rovchi bilan)',
    async (role) => {
      const res = await request(http())
        .put('/couriers/301/regions')
        .set('x-test-role', role)
        .send(body);
      expect(res.status).toBe(200);
      expect(identitySend).toHaveBeenCalledWith(
        { cmd: 'identity.courier.regions.set' },
        {
          id: '301',
          dto: body,
          requester: { id: '1', roles: [role] },
        },
      );
    },
  );

  it('GET admin → identity.courier.regions.get', async () => {
    const res = await request(http())
      .get('/couriers/301/regions')
      .set('x-test-role', 'admin');
    expect(res.status).toBe(200);
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.courier.regions.get' },
      { id: '301' },
    );
  });

  it.each(['manager', 'registrator', 'courier', 'market', 'logist'])(
    '%s → GET/PUT 403, identity chaqirilmaydi',
    async (role) => {
      const put = await request(http())
        .put('/couriers/301/regions')
        .set('x-test-role', role)
        .send(body);
      const get = await request(http())
        .get('/couriers/301/regions')
        .set('x-test-role', role);
      expect([put.status, get.status]).toEqual([403, 403]);
      expect(identitySend).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['manfiy tarif', { regions: [{ region_id: '5', tariff_home: -1 }] }],
    ['kasr tarif', { regions: [{ region_id: '5', tariff_center: 10.5 }] }],
    ['raqam bo‘lmagan region_id', { regions: [{ region_id: 'abc' }] }],
    ['noma’lum maydon', { regions: [], extra: 1 }],
  ])('%s → 400', async (_label, payload) => {
    const res = await request(http())
      .put('/couriers/301/regions')
      .set('x-test-role', 'admin')
      .send(payload);
    expect(res.status).toBe(400);
    expect(identitySend).not.toHaveBeenCalled();
  });

  it('id raqam bo‘lmasa → 400', async () => {
    const res = await request(http())
      .get('/couriers/abc/regions')
      .set('x-test-role', 'admin');
    expect(res.status).toBe(400);
  });
});
