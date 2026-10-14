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
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * uherIk8r — GET /region/stats/* va GET /region/my/district-stats.
 * HAQIQIY Nest routeri + HAQIQIY RolesGuard; JWT o'rniga `x-test-role`.
 */
const fakeJwtGuard = {
  canActivate: (ctx: ExecutionContext) => {
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const role = req.headers['x-test-role'];
    if (!role) return false;
    req.user = {
      sub: '77',
      username: 'u',
      roles: [role],
      branch_id: req.headers['x-test-branch'] ?? null,
    };
    return true;
  },
};

type RpcCall = [{ cmd: string }, Record<string, unknown>];

describe('uherIk8r — region stats marshrutlari (gateway)', () => {
  let app: INestApplication;
  const logisticsSend = jest.fn();
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const lastCall = () => logisticsSend.mock.calls.at(-1) as RpcCall | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LogisticsGatewayController],
      providers: [
        { provide: 'LOGISTICS', useValue: { send: logisticsSend } },
        { provide: 'IDENTITY', useValue: { send: jest.fn() } },
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
    logisticsSend.mockReset();
    logisticsSend.mockReturnValue(of({ statusCode: 200, data: {} }));
  });

  it.each(['market', 'courier'])(
    'GET /region/stats/all %s bilan → 403, logistics chaqirilmaydi',
    async (role) => {
      const res = await request(http())
        .get('/region/stats/all')
        .set('x-test-role', role);
      expect(res.status).toBe(403);
      expect(logisticsSend).not.toHaveBeenCalled();
    },
  );

  describe("o'tish davri: REGION_STATS_COURIER_COMPAT=true", () => {
    afterEach(() => {
      delete process.env.REGION_STATS_COURIER_COMPAT;
    });

    it('kuryer stats/all → 200, so‘rovchi uzatiladi (doira logistics’da — faqat o‘z viloyati)', async () => {
      process.env.REGION_STATS_COURIER_COMPAT = 'true';
      const res = await request(http())
        .get('/region/stats/all')
        .set('x-test-role', 'courier');
      expect(res.status).toBe(200);
      expect(lastCall()).toEqual([
        { cmd: 'logistics.region.stats_all' },
        {
          startDate: undefined,
          endDate: undefined,
          requester: { id: '77', roles: ['courier'], branch_id: null },
        },
      ]);
    });

    it('flag boshqa qiymatda (false) → kuryer yana 403', async () => {
      process.env.REGION_STATS_COURIER_COMPAT = 'false';
      const res = await request(http())
        .get('/region/stats/all')
        .set('x-test-role', 'courier');
      expect(res.status).toBe(403);
      expect(logisticsSend).not.toHaveBeenCalled();
    });

    it('market flag bilan ham 403 (RolesGuard)', async () => {
      process.env.REGION_STATS_COURIER_COMPAT = 'true';
      const res = await request(http())
        .get('/region/stats/all')
        .set('x-test-role', 'market');
      expect(res.status).toBe(403);
    });
  });

  it('COURIER boshqa viloyat id bilan GET /region/stats/:id → 403', async () => {
    const res = await request(http())
      .get('/region/stats/9')
      .set('x-test-role', 'courier');
    expect(res.status).toBe(403);
    expect(logisticsSend).not.toHaveBeenCalled();
  });

  it.each(['admin', 'superadmin'])(
    'GET /region/stats/all %s bilan → 200, so‘rovchi servisga uzatiladi',
    async (role) => {
      const res = await request(http())
        .get('/region/stats/all?startDate=2026-10-01&endDate=2026-10-14')
        .set('x-test-role', role);
      expect(res.status).toBe(200);
      expect(lastCall()).toEqual([
        { cmd: 'logistics.region.stats_all' },
        {
          startDate: '2026-10-01',
          endDate: '2026-10-14',
          requester: { id: '77', roles: [role], branch_id: null },
        },
      ]);
    },
  );

  it.each(['courier', 'manager'])(
    "GET /region/my/district-stats %s bilan → 200; query region_id e'tiborsiz",
    async (role) => {
      const res = await request(http())
        .get('/region/my/district-stats?startDate=2026-10-01&region_id=9')
        .set('x-test-role', role)
        .set('x-test-branch', '7');
      expect(res.status).toBe(200);
      expect(lastCall()).toEqual([
        { cmd: 'logistics.region.my_district_stats' },
        {
          startDate: '2026-10-01',
          endDate: undefined,
          requester: { id: '77', roles: [role], branch_id: '7' },
        },
      ]);
    },
  );

  it.each(['market', 'admin', 'registrator'])(
    'GET /region/my/district-stats %s bilan → 403',
    async (role) => {
      const res = await request(http())
        .get('/region/my/district-stats')
        .set('x-test-role', role);
      expect(res.status).toBe(403);
    },
  );
});
