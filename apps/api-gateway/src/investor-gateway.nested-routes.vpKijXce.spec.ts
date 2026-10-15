import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { ApiGatewayController } from './api-gateway.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { InvestorGatewayController } from './investor-gateway.controller';

/**
 * vpKijXce (a) — ichki investor marshrutlari HAQIQIY Nest routerida.
 *
 * Ilgari `@Post('investments') @Post('investors/:investor_id/investments')`
 * kabi ikki qavat dekoratorlarda faqat yuqoridagi yo'l ro'yxatdan o'tardi:
 * `POST/PATCH/DELETE /investors/:investor_id/investments(/:id)`,
 * `POST /investors/:investor_id/profits(/calculate)` — 404. Endi har biri
 * alohida handler; PATCH/DELETE da investitsiya egasi (`scope_investor_id`)
 * servisga uzatiladi.
 *
 * vpKijXce (b) — investor yozuviga faqat INVESTOR rolli login bog'lanadi.
 */
describe('vpKijXce — ichki investor marshrutlari va login bog‘lash', () => {
  let app: INestApplication;
  const investor = {
    send: jest.fn(() => of({ statusCode: 200, data: {} })),
  };
  let identityRole: string | null = 'investor';
  const identity = {
    send: jest.fn(() => of({ data: { id: '31', role: identityRole } })),
  };
  const ADMIN = { sub: '17', username: 'admin', roles: ['admin'] };
  const INVESTOR = { sub: '25', username: 'inv', roles: ['investor'] };
  const as = (user: object) => ({ 'x-test-user': JSON.stringify(user) });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [InvestorGatewayController],
      providers: [
        { provide: 'INVESTOR', useValue: investor },
        { provide: 'IDENTITY', useValue: identity },
      ],
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

  beforeEach(() => {
    investor.send.mockClear();
    identity.send.mockClear();
    identityRole = 'investor';
  });

  const http = () => request(app.getHttpServer());
  const lastCall = () =>
    investor.send.mock.calls[
      investor.send.mock.calls.length - 1
    ] as unknown as [{ cmd: string }, Record<string, any>];

  const investment = { amount: 100, invested_at: '2026-03-01T00:00:00Z' };
  const profit = {
    amount: 10,
    percentage: 1,
    period_start: '2026-01-01',
    period_end: '2026-01-31',
  };
  const calc = {
    period_start: '2026-01-01',
    period_end: '2026-01-31',
    percentage: 5,
  };

  it('⭐ POST /investors/5/investments → 201, investor_id YO‘LDAN (body‘da shart emas)', async () => {
    const res = await http()
      .post('/investors/5/investments')
      .set(as(ADMIN))
      .send(investment);

    expect(res.status).toBe(201);
    expect(lastCall()[0]).toEqual({ cmd: 'investor.investment.create' });
    expect(lastCall()[1].dto).toEqual({ ...investment, investor_id: '5' });
    expect(lastCall()[1].requester).toEqual({ id: '17', roles: ['admin'] });
  });

  it('POST /investors/5/investments body investor_id=7 → 400 (noaniq), servisga yetmaydi; =5 → o‘tadi', async () => {
    const bad = await http()
      .post('/investors/5/investments')
      .set(as(ADMIN))
      .send({ ...investment, investor_id: '7' });
    expect(bad.status).toBe(400);
    expect(investor.send).not.toHaveBeenCalled();

    const ok = await http()
      .post('/investors/5/investments')
      .set(as(ADMIN))
      .send({ ...investment, investor_id: '5' });
    expect(ok.status).toBe(201);
    expect(lastCall()[1].dto.investor_id).toBe('5');
  });

  it('⭐ PATCH /investors/5/investments/9 → egasi (scope_investor_id) servisga uzatiladi, body investor_id majburan yozilmaydi', async () => {
    const res = await http()
      .patch('/investors/5/investments/9')
      .set(as(ADMIN))
      .send({ amount: 200 });

    expect(res.status).toBe(200);
    expect(lastCall()[0]).toEqual({ cmd: 'investor.investment.update' });
    expect(lastCall()[1]).toEqual({
      id: '9',
      dto: { amount: 200 },
      scope_investor_id: '5',
      requester: { id: '17', roles: ['admin'] },
    });
  });

  it('⭐ DELETE /investors/5/investments/9 → egasi bilan', async () => {
    const res = await http()
      .delete('/investors/5/investments/9')
      .set(as(ADMIN));

    expect(res.status).toBe(200);
    expect(lastCall()).toEqual([
      { cmd: 'investor.investment.delete' },
      {
        id: '9',
        scope_investor_id: '5',
        requester: { id: '17', roles: ['admin'] },
      },
    ]);
  });

  it('⭐ POST /investors/5/profits va /investors/5/profits/calculate → investor_id yo‘ldan', async () => {
    const p = await http()
      .post('/investors/5/profits')
      .set(as(ADMIN))
      .send(profit);
    expect(p.status).toBe(201);
    expect(lastCall()[0]).toEqual({ cmd: 'investor.profit.create' });
    expect(lastCall()[1].dto).toEqual({ ...profit, investor_id: '5' });

    const c = await http()
      .post('/investors/5/profits/calculate')
      .set(as(ADMIN))
      .send(calc);
    expect(c.status).toBe(201);
    expect(lastCall()[0]).toEqual({ cmd: 'investor.profit.calculate' });
    expect(lastCall()[1].dto).toEqual({ ...calc, investor_id: '5' });
  });

  it('tekis yo‘llar o‘zgarmadi: POST /investments, PATCH/DELETE /investments/9 (egasiz)', async () => {
    await http()
      .post('/investments')
      .set(as(ADMIN))
      .send({ ...investment, investor_id: '5' });
    expect(lastCall()[1].dto).toEqual({ ...investment, investor_id: '5' });

    await http().patch('/investments/9').set(as(ADMIN)).send({ amount: 3 });
    expect(lastCall()[1]).toEqual({
      id: '9',
      dto: { amount: 3 },
      requester: { id: '17', roles: ['admin'] },
    });

    await http().delete('/investments/9').set(as(ADMIN));
    expect(lastCall()[1]).toEqual({
      id: '9',
      requester: { id: '17', roles: ['admin'] },
    });

    await http().post('/profits/calculate').set(as(ADMIN)).send(calc);
    expect(lastCall()[1].dto).toEqual(calc);
  });

  it.each([
    ['post', '/investors/5/investments'],
    ['patch', '/investors/5/investments/9'],
    ['delete', '/investors/5/investments/9'],
    ['post', '/investors/5/profits'],
    ['post', '/investors/5/profits/calculate'],
  ])(
    'investor roli %s %s → 403 (faqat SUPERADMIN/ADMIN)',
    async (verb, url) => {
      const res = await (http() as any)[verb](url).set(as(INVESTOR)).send({});
      expect(res.status).toBe(403);
      expect(investor.send).not.toHaveBeenCalled();
    },
  );

  // --- (b) login bog'lash ------------------------------------------------

  it('⭐ POST /investors user_id = INVESTOR rolli login → o‘tadi (identity tekshiradi)', async () => {
    const res = await http()
      .post('/investors')
      .set(as(ADMIN))
      .send({ name: 'Vali', phone_number: '+998901234567', user_id: '31' });

    expect(res.status).toBe(201);
    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      { id: '31' },
    );
    expect(lastCall()[1].dto.user_id).toBe('31');
  });

  it.each([['courier'], ['admin'], ['market'], [null]])(
    'POST/PATCH /investors user_id roli %s → 400, investor yozuvi o‘zgarmaydi',
    async (role) => {
      identityRole = role;

      const created = await http()
        .post('/investors')
        .set(as(ADMIN))
        .send({ name: 'Vali', phone_number: '+998901234567', user_id: '31' });
      const patched = await http()
        .patch('/investors/5')
        .set(as(ADMIN))
        .send({ user_id: '31' });

      expect(created.status).toBe(400);
      expect(patched.status).toBe(400);
      expect(investor.send).not.toHaveBeenCalled();
    },
  );

  it('PATCH user_id: null (uzish) va user_id yo‘q — identity so‘ralmaydi', async () => {
    await http().patch('/investors/5').set(as(ADMIN)).send({ user_id: null });
    await http().patch('/investors/5').set(as(ADMIN)).send({ name: 'Ali' });

    expect(identity.send).not.toHaveBeenCalled();
    expect(investor.send).toHaveBeenCalledTimes(2);
  });

  it('identity ulanmagan bo‘lsa user_id bog‘lash RAD (fail-closed, 503)', async () => {
    const controller = new InvestorGatewayController(investor as any);

    await expect(
      controller.createInvestor(
        { name: 'Vali', phone_number: '+998901234567', user_id: '31' } as any,
        { user: ADMIN },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(investor.send).not.toHaveBeenCalled();
  });
});

describe('vpKijXce — POST/GET /investor-users (investor logini, BeePost naqshi)', () => {
  let app: INestApplication;
  const identitySend = jest.fn(() =>
    of({ statusCode: 201, data: { id: '31' } }),
  );
  let user: object = { sub: '1', username: 'sa', roles: ['superadmin'] };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: { send: identitySend } },
        { provide: 'FINANCE', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: { send: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = user;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
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

  beforeEach(() => {
    identitySend.mockClear();
    user = { sub: '1', username: 'sa', roles: ['superadmin'] };
  });

  const body = {
    name: 'Ali Investor',
    phone_number: '+998901234567',
    password: 'secret12',
  };

  it('⭐ superadmin POST /investor-users → identity.investor_user.create (dto + requester)', async () => {
    const res = await request(app.getHttpServer())
      .post('/investor-users')
      .send(body);

    expect(res.status).toBe(201);
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.investor_user.create' },
      { dto: body, requester: { id: '1', roles: ['superadmin'] } },
    );
  });

  it('GET /investor-users → identity.user.find_all role=investor', async () => {
    user = { sub: '2', username: 'admin', roles: ['admin'] };

    const res = await request(app.getHttpServer()).get(
      '/investor-users?search=Ali&page=2&limit=5',
    );

    expect(res.status).toBe(200);
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_all' },
      {
        query: {
          role: 'investor',
          search: 'Ali',
          status: undefined,
          page: 2,
          limit: 5,
        },
      },
    );
  });

  it.each([['manager'], ['investor'], ['market'], ['registrator']])(
    '%s → 403, identity chaqirilmaydi',
    async (role) => {
      user = { sub: '9', username: 'x', roles: [role] };

      const res = await request(app.getHttpServer())
        .post('/investor-users')
        .send(body);

      expect(res.status).toBe(403);
      expect(identitySend).not.toHaveBeenCalled();
    },
  );

  it('parol 6 belgidan qisqa / telefon noto‘g‘ri → 400', async () => {
    const short = await request(app.getHttpServer())
      .post('/investor-users')
      .send({ ...body, password: '123' });
    const phone = await request(app.getHttpServer())
      .post('/investor-users')
      .send({ ...body, phone_number: '12345' });

    expect(short.status).toBe(400);
    expect(phone.status).toBe(400);
    expect(identitySend).not.toHaveBeenCalled();
  });
});
