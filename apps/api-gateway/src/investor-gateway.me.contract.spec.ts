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
import { InvestorGatewayController } from './investor-gateway.controller';

/**
 * vpKijXce — investor gateway kontrakti (HAQIQIY RolesGuard bilan).
 *
 * JwtAuthGuard o'rniga test guard: `x-test-user` sarlavhasidagi JSON'ni
 * `req.user` qiladi (sarlavha yo'q → req.user yo'q → RolesGuard 403).
 */
describe('vpKijXce — investor gateway: /investors/me va requester', () => {
  let app: INestApplication;
  const investor = {
    send: jest.fn(() => of({ statusCode: 200, data: {} })),
  };

  const INVESTOR = { sub: '25', username: 'inv', roles: ['investor'] };
  const ADMIN = { sub: '1', username: 'admin', roles: ['admin'] };
  const SUPERADMIN = { sub: '2', username: 'sa', roles: ['superadmin'] };
  const as = (user: object) => ({ 'x-test-user': JSON.stringify(user) });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [InvestorGatewayController],
      providers: [{ provide: 'INVESTOR', useValue: investor }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest();
          const raw = req.headers['x-test-user'];
          if (raw) {
            req.user = JSON.parse(String(raw));
          }
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    // main.ts dagi global pipe bilan bir xil.
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
    await app?.close();
  });

  beforeEach(() => investor.send.mockClear());

  const lastCall = () =>
    investor.send.mock.calls.at(-1) as unknown as [
      { cmd: string },
      Record<string, any>,
    ];

  // --- TC3 / TC4 ---------------------------------------------------------

  it('⭐ TC3: investor GET /investors/me → investor.me.profile, faqat requester', async () => {
    const res = await request(app.getHttpServer())
      .get('/investors/me')
      .set(as(INVESTOR));

    expect(res.status).toBe(200);
    expect(investor.send).toHaveBeenCalledTimes(1);
    expect(lastCall()).toEqual([
      { cmd: 'investor.me.profile' },
      { requester: { id: '25', roles: ['investor'] } },
    ]);
  });

  it('⭐ TC4: query`dagi boshqa investor_id servisga UMUMAN yetmaydi', async () => {
    for (const path of [
      '/investors/me?investor_id=26&id=26',
      '/investors/me/dashboard?investor_id=26&months=6',
      '/investors/me/investments?investor_id=26&page=2&limit=5',
      '/investors/me/profits?investor_id=26&is_paid=true',
    ]) {
      investor.send.mockClear();
      const res = await request(app.getHttpServer())
        .get(path)
        .set(as(INVESTOR));
      expect(res.status).toBe(200);
      const [, payload] = lastCall();
      expect(JSON.stringify(payload)).not.toContain('26');
      expect(payload.requester).toEqual({ id: '25', roles: ['investor'] });
    }
  });

  it('me/investments, me/profits, me/dashboard — to`g`ri cmd va query', async () => {
    await request(app.getHttpServer())
      .get('/investors/me/investments?page=2&limit=5&from_date=2026-01-01')
      .set(as(INVESTOR));
    expect(lastCall()).toEqual([
      { cmd: 'investor.me.investments' },
      {
        requester: { id: '25', roles: ['investor'] },
        query: { from_date: '2026-01-01', page: 2, limit: 5 },
      },
    ]);

    await request(app.getHttpServer())
      .get('/investors/me/profits?is_paid=false')
      .set(as(INVESTOR));
    expect(lastCall()[0]).toEqual({ cmd: 'investor.me.profits' });
    expect(lastCall()[1].query).toEqual({ is_paid: false });

    await request(app.getHttpServer())
      .get('/investors/me/dashboard?months=6')
      .set(as(INVESTOR));
    expect(lastCall()).toEqual([
      { cmd: 'investor.me.dashboard' },
      { requester: { id: '25', roles: ['investor'] }, query: { months: 6 } },
    ]);
  });

  // --- Investor admin marshrutlariga kira olmaydi ------------------------

  it.each([
    ['get', '/investors'],
    ['get', '/investors/26'],
    ['get', '/investors/26/dashboard'],
    ['get', '/investors/26/investments'],
    ['get', '/investors/26/profits'],
    ['get', '/investments'],
    ['get', '/investments/5'],
    ['get', '/profits'],
    ['patch', '/profits/5/mark-paid'],
  ])('⭐ investor %s %s → 403', async (method, path) => {
    const res = await (request(app.getHttpServer()) as any)
      [method](path)
      .set(as(INVESTOR));
    expect(res.status).toBe(403);
    expect(investor.send).not.toHaveBeenCalled();
  });

  // --- Marshrut tartibi: "me" :id ga tushmasin ---------------------------

  it('⭐ admin GET /investors/me → 403 (investors/:id handler`iga tushmaydi)', async () => {
    const res = await request(app.getHttpServer())
      .get('/investors/me')
      .set(as(ADMIN));
    expect(res.status).toBe(403);
    expect(investor.send).not.toHaveBeenCalled();
  });

  // --- TC9: fail-closed ---------------------------------------------------

  it.each([
    ['req.user yo`q', undefined],
    ['rollar bo`sh', { sub: '25', roles: [] }],
    ['rollar maydoni yo`q', { sub: '25' }],
  ])('⭐ TC9: %s → 403, servisga so`rov yo`q', async (_label, user) => {
    for (const path of [
      '/investors/me',
      '/investors/me/dashboard',
      '/investors/me/investments',
      '/investors/me/profits',
    ]) {
      const req = request(app.getHttpServer()).get(path);
      const res = await (user ? req.set(as(user)) : req);
      expect(res.status).toBe(403);
    }
    expect(investor.send).not.toHaveBeenCalled();
  });

  // --- TC7: superadmin nazorati ------------------------------------------

  it('⭐ TC7: superadmin GET /investors/:id/dashboard → investor.dashboard', async () => {
    const res = await request(app.getHttpServer())
      .get('/investors/26/dashboard?months=6')
      .set(as(SUPERADMIN));
    expect(res.status).toBe(200);
    expect(lastCall()).toEqual([
      { cmd: 'investor.dashboard' },
      { investor_id: '26', query: { months: 6 } },
    ]);
  });

  // --- requester endi uzatiladi (audit aktori) ---------------------------

  it.each([
    [
      'post',
      '/investors',
      { name: 'Vali', phone_number: '+998901234567' },
      'investor.create',
    ],
    ['patch', '/investors/5', { name: 'Vali 2' }, 'investor.update'],
    ['delete', '/investors/5', undefined, 'investor.delete'],
    [
      'post',
      '/investments',
      { investor_id: '5', amount: 100, invested_at: '2026-03-01T00:00:00Z' },
      'investor.investment.create',
    ],
    ['patch', '/investments/9', { amount: 200 }, 'investor.investment.update'],
    ['delete', '/investments/9', undefined, 'investor.investment.delete'],
    [
      'post',
      '/profits',
      {
        investor_id: '5',
        amount: 10,
        percentage: 1,
        period_start: '2026-01-01',
        period_end: '2026-01-31',
      },
      'investor.profit.create',
    ],
    [
      'post',
      '/profits/calculate',
      { period_start: '2026-01-01', period_end: '2026-01-31', percentage: 1 },
      'investor.profit.calculate',
    ],
    ['patch', '/profits/9/mark-paid', undefined, 'investor.profit.mark_paid'],
  ])(
    '⭐ admin %s %s → requester servisga uzatiladi',
    async (method, path, body, cmd) => {
      let req = (request(app.getHttpServer()) as any)
        [method](path)
        .set(as(ADMIN));
      if (body) {
        req = req.send(body);
      }
      const res = await req;
      expect(res.status).toBeLessThan(300);
      const [pattern, payload] = lastCall();
      expect(pattern).toEqual({ cmd });
      expect(payload.requester).toEqual({ id: '1', roles: ['admin'] });
    },
  );

  // --- user_id bog'lash kontrakti ----------------------------------------

  it('POST /investors user_id (satr yoki raqam) qabul qilinadi', async () => {
    for (const user_id of ['25', 25]) {
      const res = await request(app.getHttpServer())
        .post('/investors')
        .set(as(ADMIN))
        .send({ name: 'Vali', phone_number: '+998901234567', user_id });
      expect(res.status).toBe(201);
      expect(lastCall()[1].dto.user_id).toBe('25');
    }
  });

  it.each([['0'], ['abc'], ['-1'], ['1.5']])(
    'POST /investors user_id=%s → 400, servisga yetmaydi',
    async (user_id) => {
      const res = await request(app.getHttpServer())
        .post('/investors')
        .set(as(ADMIN))
        .send({ name: 'Vali', phone_number: '+998901234567', user_id });
      expect(res.status).toBe(400);
      expect(investor.send).not.toHaveBeenCalled();
    },
  );

  it('PATCH /investors/:id user_id: null — uzish uchun o`tadi', async () => {
    const res = await request(app.getHttpServer())
      .patch('/investors/5')
      .set(as(ADMIN))
      .send({ user_id: null });
    expect(res.status).toBe(200);
    expect(lastCall()[1].dto).toEqual({ user_id: null });
  });
});
