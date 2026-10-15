import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { InvestorGatewayController } from './investor-gateway.controller';

/**
 * GADgsW5G — kontrakt: investor gateway'ning HAR BIR marshruti `investor.*`
 * cmd payload'ida `requester.id` (= JWT sub) va `requester.roles` yuboradi.
 *
 * Marshrutlar qo'lda emas, kontroller metadata'sidan olinadi — yangi handler
 * requester'siz qo'shilsa, bu spec QIZIL bo'ladi.
 */
describe('GADgsW5G — investor gateway: barcha investor.* cmd`larida requester.id', () => {
  let app: INestApplication;
  const investor = {
    send: jest.fn(() => of({ statusCode: 200, data: {} })),
  };

  const INVESTOR = { sub: '25', username: 'inv', roles: ['investor'] };
  const ADMIN = { sub: '17', username: 'admin', roles: ['admin'] };
  const SUPERADMIN = { sub: '1', username: 'sa', roles: ['superadmin'] };

  /** Validatsiyadan o'tadigan minimal body (POST/PATCH). */
  const BODIES: Record<string, object> = {
    'POST investors': { name: 'Vali', phone_number: '+998901234567' },
    'PATCH investors/:id': { name: 'Vali 2' },
    'POST investments': {
      investor_id: '5',
      amount: 100,
      invested_at: '2026-03-01T00:00:00Z',
    },
    'PATCH investments/:id': { amount: 200 },
    'POST profits': {
      investor_id: '5',
      amount: 10,
      percentage: 1,
      period_start: '2026-01-01',
      period_end: '2026-01-31',
    },
    'POST profits/calculate': {
      period_start: '2026-01-01',
      period_end: '2026-01-31',
      percentage: 1,
    },
    // vpKijXce: ichki yo'llar — investor yo'ldan (body'da investor_id shart emas).
    'POST investors/:investor_id/investments': {
      amount: 100,
      invested_at: '2026-03-01T00:00:00Z',
    },
    'PATCH investors/:investor_id/investments/:id': { amount: 200 },
    'POST investors/:investor_id/profits': {
      amount: 10,
      percentage: 1,
      period_start: '2026-01-01',
      period_end: '2026-01-31',
    },
    'POST investors/:investor_id/profits/calculate': {
      period_start: '2026-01-01',
      period_end: '2026-01-31',
      percentage: 1,
    },
  };

  type Route = {
    handler: string;
    verb: 'get' | 'post' | 'patch' | 'delete';
    path: string;
    roles: string[];
  };

  const VERBS: Partial<Record<RequestMethod, Route['verb']>> = {
    [RequestMethod.GET]: 'get',
    [RequestMethod.POST]: 'post',
    [RequestMethod.PATCH]: 'patch',
    [RequestMethod.DELETE]: 'delete',
  };

  const routes: Route[] = Object.getOwnPropertyNames(
    InvestorGatewayController.prototype,
  )
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const fn = (InvestorGatewayController.prototype as any)[name];
      const path = Reflect.getMetadata(PATH_METADATA, fn);
      if (typeof path !== 'string') {
        return null;
      }
      const verb = VERBS[Reflect.getMetadata(METHOD_METADATA, fn)];
      if (!verb) {
        throw new Error(`${name}: kutilmagan HTTP metodi`);
      }
      return {
        handler: name,
        verb,
        path,
        roles: (Reflect.getMetadata(ROLES_KEY, fn) ?? []) as string[],
      };
    })
    .filter((r): r is Route => r !== null);

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

  // vpKijXce: 21 + 5 ichki yo'l (ilgari ikki qavat dekorator ostida edi va
  // ro'yxatdan o'tmasdi) = 26.
  it('metadata`dan barcha 26 handler topildi, har birida @Roles bor', () => {
    expect(routes).toHaveLength(26);
    for (const r of routes) {
      // RolesGuard @Roles bo'lmagan marshrutni HAMMAGA ochadi.
      expect({ handler: r.handler, roles: r.roles.length > 0 }).toEqual({
        handler: r.handler,
        roles: true,
      });
    }
  });

  it.each([ADMIN, SUPERADMIN])(
    '⭐ TC4: rol %#: har bir marshrut → payload.requester.id = JWT sub',
    async (adminUser) => {
      for (const r of routes) {
        const user = r.roles.includes('investor') ? INVESTOR : adminUser;
        const url = '/' + r.path.replace(/:[a-z_]+/g, '5');
        const body = BODIES[`${r.verb.toUpperCase()} ${r.path}`];

        investor.send.mockClear();
        let req = (request(app.getHttpServer()) as any)
          [r.verb](url)
          .set({ 'x-test-user': JSON.stringify(user) });
        if (body) {
          req = req.send(body);
        }
        const res = await req;

        if (res.status >= 300) {
          throw new Error(`${r.handler}: ${r.verb} ${url} → ${res.status}`);
        }
        expect(investor.send).toHaveBeenCalledTimes(1);
        const [pattern, payload] = investor.send.mock.calls[0] as unknown as [
          { cmd: string },
          Record<string, any>,
        ];
        expect(pattern.cmd).toMatch(/^investor\./);
        expect({ handler: r.handler, requester: payload.requester }).toEqual({
          handler: r.handler,
          requester: { id: user.sub, roles: user.roles },
        });
      }
    },
  );

  it('⭐ TC2: PATCH /profits/:id/mark-paid — requester.id = JWT sub (servis uni kassa created_by ga yozadi)', async () => {
    const res = await request(app.getHttpServer())
      .patch('/profits/9/mark-paid')
      .set({ 'x-test-user': JSON.stringify(SUPERADMIN) });
    expect(res.status).toBe(200);
    expect(investor.send).toHaveBeenCalledWith(
      { cmd: 'investor.profit.mark_paid' },
      { id: '9', requester: { id: '1', roles: ['superadmin'] } },
    );
  });
});
