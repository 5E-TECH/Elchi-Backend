/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { from, of } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, Roles, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ApiGatewayController } from './api-gateway.controller';
import { createRoleWorld } from '../../identity-service/test/identity-role-world';

/**
 * K3scaE0W — API: PATCH /users/:id/role va GET /roles.
 * HAQIQIY gateway routeri + HAQIQIY RolesGuard + main.ts ValidationPipe →
 * RMQ o'rnida HAQIQIY identity UserServiceService (xotiradagi jadval).
 *   - superadmin → 200, admin → 403 (RolesGuard), identity servisi ham
 *     superadmin'dan boshqasini 403 qiladi;
 *   - activity_log da old_value.role / new_value.role.
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

describe('K3scaE0W — PATCH /users/:id/role, GET /roles (gateway e2e)', () => {
  let app: INestApplication;
  let world: ReturnType<typeof createRoleWorld>;
  const identityCalls: Array<{ cmd: string; payload: any }> = [];
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const noop = { send: jest.fn(() => of({})) };

  const dispatch = (cmd: string, payload: any): Promise<unknown> => {
    switch (cmd) {
      case 'identity.user.change_role':
        return world.service.changeUserRole(
          payload.id,
          payload.role,
          payload.requester,
        );
      case 'identity.role.catalog':
        return Promise.resolve(world.service.getRoleCatalog());
      default:
        return Promise.reject(new Error('kutilmagan cmd ' + cmd));
    }
  };

  beforeAll(async () => {
    const identitySend = jest.fn((pattern: { cmd: string }, payload: any) => {
      identityCalls.push({ cmd: pattern.cmd, payload });
      return from(
        dispatch(pattern.cmd, payload).catch((error: unknown) => {
          throw error instanceof RpcException ? error.getError() : error;
        }),
      );
    });
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
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    identityCalls.length = 0;
    world = createRoleWorld([
      { id: '1', name: 'Super', role: Roles.SUPERADMIN },
      { id: '10', name: "Ro'yxatchi", role: Roles.REGISTRATOR },
    ]);
  });

  it('⭐ superadmin → 200: rol o`zgaradi, activity_log da old_value.role / new_value.role', async () => {
    const res = await request(http())
      .patch('/users/10/role')
      .set('x-test-role', 'superadmin')
      .send({ role: 'manager' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: '10', role: 'manager' });
    expect(identityCalls).toEqual([
      {
        cmd: 'identity.user.change_role',
        payload: {
          id: '10',
          role: 'manager',
          requester: { id: '1', roles: ['superadmin'] },
        },
      },
    ]);
    const entry = world.activityLog.log.mock.calls[0][0];
    expect(entry.old_value.role).toBe('registrator');
    expect(entry.new_value.role).toBe('manager');
    expect(world.rows.find((r) => r.id === '10')?.role).toBe('manager');
  });

  it.each(['admin', 'manager', 'registrator'])(
    '⭐ %s → 403, identity chaqirilmaydi, rol o`zgarmaydi',
    async (role) => {
      const res = await request(http())
        .patch('/users/10/role')
        .set('x-test-role', role)
        .send({ role: 'manager' });

      expect(res.status).toBe(403);
      expect(identityCalls).toHaveLength(0);
      expect(world.rows.find((r) => r.id === '10')?.role).toBe('registrator');
    },
  );

  it.each([
    ["noma'lum rol", { role: 'boss' }],
    ["bo'sh tana", {}],
    ['ortiqcha kalit', { role: 'manager', name: 'x' }],
  ])('%s → 400 (DTO), identity chaqirilmaydi', async (_l, body) => {
    const res = await request(http())
      .patch('/users/10/role')
      .set('x-test-role', 'superadmin')
      .send(body);

    expect(res.status).toBe(400);
    expect(identityCalls).toHaveLength(0);
  });

  it("almashtirib bo'lmaydigan nishon (courier) → identity 400 o'zbekcha xabar bilan", async () => {
    const res = await request(http())
      .patch('/users/10/role')
      .set('x-test-role', 'superadmin')
      .send({ role: 'courier' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("bo'lishi kerak");
  });

  it('id raqam emas → 400', async () => {
    const res = await request(http())
      .patch('/users/abc/role')
      .set('x-test-role', 'superadmin')
      .send({ role: 'manager' });
    expect(res.status).toBe(400);
    expect(identityCalls).toHaveLength(0);
  });

  it.each(['superadmin', 'admin', 'manager'])(
    'GET /roles (%s) → katalog: Roles enum to`liq, branch/investor/market_operator bor',
    async (role) => {
      const res = await request(http()).get('/roles').set('x-test-role', role);

      expect(res.status).toBe(200);
      const roles = res.body.data.items.map((item: any) => item.role);
      expect([...roles].sort()).toEqual(Object.values(Roles).sort());
      expect(roles).toEqual(
        expect.arrayContaining(['branch', 'investor', 'market_operator']),
      );
      expect(res.body.data.changeable_roles).toEqual(
        expect.arrayContaining(['admin', 'registrator', 'manager', 'logist']),
      );
    },
  );

  it('GET /roles — kuryer → 403', async () => {
    const res = await request(http())
      .get('/roles')
      .set('x-test-role', 'courier');
    expect(res.status).toBe(403);
  });
});
