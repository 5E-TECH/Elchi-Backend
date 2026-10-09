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
import { ROLES_KEY } from './auth/roles.decorator';
import { ApiGatewayController } from './api-gateway.controller';
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * (dzyVftBx) Gateway: logist roli va viloyat ↔ logist marshrutlari.
 *
 * HAQIQIY Nest routeri, HAQIQIY RolesGuard va main.ts dagi global
 * ValidationPipe (whitelist + forbidNonWhitelisted + transform). Faqat JWT
 * o'rniga sinov guard'i: `x-test-role` sarlavhasidan `req.user` yasaydi.
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

async function buildApp(
  controllers: Array<new (...args: never[]) => unknown>,
  providers: Array<{ provide: string; useValue: unknown }>,
) {
  const moduleRef = await Test.createTestingModule({
    controllers,
    providers,
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(fakeJwtGuard)
    .compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  return app;
}

type RpcCall = [{ cmd: string }, Record<string, unknown>];

describe('(dzyVftBx) LogisticsGatewayController — logist', () => {
  let app: INestApplication;
  const logisticsSend = jest.fn();
  const identitySend = jest.fn();
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const lastCall = () => logisticsSend.mock.calls.at(-1) as RpcCall | undefined;

  beforeAll(async () => {
    app = await buildApp(
      [LogisticsGatewayController],
      [
        { provide: 'LOGISTICS', useValue: { send: logisticsSend } },
        { provide: 'IDENTITY', useValue: { send: identitySend } },
      ],
    );
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    logisticsSend.mockReset();
    logisticsSend.mockReturnValue(of({ statusCode: 200, data: {} }));
  });

  describe('⭐ TC3 — GET /region/stats/* rollari', () => {
    it('LOGIST bilan GET /region/stats/all → 200', async () => {
      const res = await request(http())
        .get('/region/stats/all?startDate=2026-10-01')
        .set('x-test-role', 'logist');

      expect(res.status).toBe(200);
      expect(lastCall()?.[0]).toEqual({ cmd: 'logistics.region.stats_all' });
    });

    it('MARKET bilan GET /region/stats/all → 403, logistics chaqirilmaydi', async () => {
      const res = await request(http())
        .get('/region/stats/all')
        .set('x-test-role', 'market');

      expect(res.status).toBe(403);
      expect(logisticsSend).not.toHaveBeenCalled();
    });

    it('LOGIST bilan GET /region/stats/5 → 200 (stats/:id)', async () => {
      const res = await request(http())
        .get('/region/stats/5')
        .set('x-test-role', 'logist');

      expect(res.status).toBe(200);
      expect(lastCall()).toEqual([
        { cmd: 'logistics.region.stats_by_id' },
        { id: '5', startDate: undefined, endDate: undefined },
      ]);
    });

    it.each(['market', 'courier'])(
      'GET /region/stats/5 %s bilan → 403 (RBAC-14 o‘zgarmagan)',
      async (role) => {
        const res = await request(http())
          .get('/region/stats/5')
          .set('x-test-role', role);

        expect(res.status).toBe(403);
      },
    );

    it('stats/all: kuryer, menejer, registrator, admin hamon 200 (regressiya yo‘q)', async () => {
      for (const role of [
        'courier',
        'manager',
        'registrator',
        'admin',
        'superadmin',
      ]) {
        const res = await request(http())
          .get('/region/stats/all')
          .set('x-test-role', role);
        expect(res.status).toBe(200);
      }
    });
  });

  describe('PATCH /region/:id/logist', () => {
    it('{logist_id} → logistics.region.assign_logist (so‘rovchi bilan)', async () => {
      const res = await request(http())
        .patch('/region/5/logist')
        .set('x-test-role', 'admin')
        .send({ logist_id: '42' });

      expect(res.status).toBe(200);
      expect(lastCall()).toEqual([
        { cmd: 'logistics.region.assign_logist' },
        { id: '5', logist_id: '42', requester: { id: '1', roles: ['admin'] } },
      ]);
    });

    it('⭐ TC2: {logist_id: null} — olib tashlash so‘rovi o‘tadi', async () => {
      const res = await request(http())
        .patch('/region/5/logist')
        .set('x-test-role', 'superadmin')
        .send({ logist_id: null });

      expect(res.status).toBe(200);
      expect(lastCall()?.[1]).toEqual(
        expect.objectContaining({ id: '5', logist_id: null }),
      );
    });

    it('raqam ko‘rinishidagi id (42) satrga keltiriladi', async () => {
      await request(http())
        .patch('/region/5/logist')
        .set('x-test-role', 'admin')
        .send({ logist_id: 42 });

      expect(lastCall()?.[1]).toEqual(
        expect.objectContaining({ logist_id: '42' }),
      );
    });

    it.each([
      ['logist_id yo‘q', {}],
      ['logist_id buzuq', { logist_id: 'abc' }],
      ['logist_id kasr', { logist_id: '4.2' }],
      ['ortiqcha maydon', { logist_id: '42', extra: 1 }],
    ])('%s → 400, logistics chaqirilmaydi', async (_l, body) => {
      const res = await request(http())
        .patch('/region/5/logist')
        .set('x-test-role', 'admin')
        .send(body);

      expect(res.status).toBe(400);
      expect(logisticsSend).not.toHaveBeenCalled();
    });

    it.each(['manager', 'registrator', 'logist', 'market', 'courier'])(
      '%s → 403',
      async (role) => {
        const res = await request(http())
          .patch('/region/5/logist')
          .set('x-test-role', role)
          .send({ logist_id: '42' });

        expect(res.status).toBe(403);
        expect(logisticsSend).not.toHaveBeenCalled();
      },
    );

    it('PATCH /region/5 (nom/sato) hamon logistics.region.update ga boradi', async () => {
      await request(http())
        .patch('/region/5')
        .set('x-test-role', 'admin')
        .send({ name: 'Andijon' });

      expect(lastCall()?.[0]).toEqual({ cmd: 'logistics.region.update' });
    });
  });

  describe('⭐ TC1 — POST /region/logist/bulk', () => {
    it('{logist_id, region_ids} → logistics.region.bulk_assign_logist', async () => {
      const res = await request(http())
        .post('/region/logist/bulk')
        .set('x-test-role', 'admin')
        .send({ logist_id: '42', region_ids: ['1', 2, '3'] });

      expect(res.status).toBe(200);
      expect(lastCall()).toEqual([
        { cmd: 'logistics.region.bulk_assign_logist' },
        {
          logist_id: '42',
          region_ids: ['1', '2', '3'],
          requester: { id: '1', roles: ['admin'] },
        },
      ]);
    });

    it('region_ids: [] (logistni hamma viloyatdan olish) qabul qilinadi', async () => {
      const res = await request(http())
        .post('/region/logist/bulk')
        .set('x-test-role', 'superadmin')
        .send({ logist_id: '42', region_ids: [] });

      expect(res.status).toBe(200);
      expect(lastCall()?.[1]).toEqual(
        expect.objectContaining({ region_ids: [] }),
      );
    });

    it.each([
      ['region_ids yo‘q', { logist_id: '42' }],
      ['region_ids massiv emas', { logist_id: '42', region_ids: '1' }],
      ['region_ids da buzuq id', { logist_id: '42', region_ids: ['1', 'x'] }],
      ['logist_id yo‘q', { region_ids: ['1'] }],
      [
        '200 tadan ko‘p viloyat',
        {
          logist_id: '42',
          region_ids: Array.from({ length: 201 }, (_, i) => String(i + 1)),
        },
      ],
    ])('%s → 400', async (_l, body) => {
      const res = await request(http())
        .post('/region/logist/bulk')
        .set('x-test-role', 'admin')
        .send(body);

      expect(res.status).toBe(400);
      expect(logisticsSend).not.toHaveBeenCalled();
    });

    it.each(['manager', 'registrator', 'logist', 'market'])(
      '%s → 403',
      async (role) => {
        const res = await request(http())
          .post('/region/logist/bulk')
          .set('x-test-role', role)
          .send({ logist_id: '42', region_ids: ['1'] });

        expect(res.status).toBe(403);
      },
    );
  });

  it('rollar metadatasi: biriktirish faqat superadmin/admin', () => {
    const rolesOf = (method: keyof LogisticsGatewayController) =>
      Reflect.getMetadata(
        ROLES_KEY,
        Object.getOwnPropertyDescriptor(
          LogisticsGatewayController.prototype,
          method,
        )?.value,
      ) as string[];

    expect(rolesOf('assignRegionLogist')).toEqual(['superadmin', 'admin']);
    expect(rolesOf('bulkAssignRegionLogist')).toEqual(['superadmin', 'admin']);
    expect(rolesOf('getAllRegionStats')).toContain('logist');
    expect(rolesOf('getAllRegionStats')).not.toContain('market');
  });
});

describe('(dzyVftBx) ApiGatewayController — POST/GET /logists', () => {
  let app: INestApplication;
  const identitySend = jest.fn();
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const lastCall = () => identitySend.mock.calls.at(-1) as RpcCall | undefined;

  beforeAll(async () => {
    app = await buildApp(
      [ApiGatewayController],
      [
        { provide: 'IDENTITY', useValue: { send: identitySend } },
        { provide: 'FINANCE', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: { send: jest.fn() } },
      ],
    );
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    identitySend.mockReset();
    identitySend.mockReturnValue(of({ statusCode: 201, data: { id: '42' } }));
  });

  const body = {
    name: 'Shaxriyor',
    phone_number: '+998903333334',
    password: 'secret1',
    salary: 4000000,
    payment_day: 10,
  };

  it.each(['superadmin', 'admin'])(
    '%s: POST /logists → identity.logist.create (so‘rovchi bilan)',
    async (role) => {
      const res = await request(http())
        .post('/logists')
        .set('x-test-role', role)
        .send(body);

      expect(res.status).toBe(201);
      expect(lastCall()).toEqual([
        { cmd: 'identity.logist.create' },
        { dto: body, requester: { id: '1', roles: [role] } },
      ]);
    },
  );

  it.each(['manager', 'registrator', 'logist', 'market'])(
    '%s: POST /logists → 403',
    async (role) => {
      const res = await request(http())
        .post('/logists')
        .set('x-test-role', role)
        .send(body);

      expect(res.status).toBe(403);
      expect(identitySend).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['branch_id (logist filial xodimi emas)', { ...body, branch_id: '3' }],
    ['telefon buzuq', { ...body, phone_number: '123' }],
    ['parol qisqa', { ...body, password: '12' }],
  ])('POST /logists: %s → 400', async (_l, payload) => {
    const res = await request(http())
      .post('/logists')
      .set('x-test-role', 'superadmin')
      .send(payload);

    expect(res.status).toBe(400);
    expect(identitySend).not.toHaveBeenCalled();
  });

  it('GET /logists → identity.user.find_all role=logist', async () => {
    identitySend.mockReturnValue(of({ statusCode: 200, data: { items: [] } }));

    const res = await request(http())
      .get('/logists?search=Sha&page=2&limit=5')
      .set('x-test-role', 'admin');

    expect(res.status).toBe(200);
    expect(lastCall()).toEqual([
      { cmd: 'identity.user.find_all' },
      {
        query: {
          role: 'logist',
          search: 'Sha',
          status: undefined,
          page: 2,
          limit: 5,
        },
      },
    ]);
  });

  it('GET /logists manager bilan → 403', async () => {
    const res = await request(http())
      .get('/logists')
      .set('x-test-role', 'manager');

    expect(res.status).toBe(403);
  });
});
