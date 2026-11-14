import { ExecutionContext, INestApplication } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'http';
import { from, of, throwError } from 'rxjs';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { CarrierAdminGatewayController } from './carrier-admin-gateway.controller';
import { UzValidationPipe } from './validation/uz-validation.pipe';
import { CarrierAccountController } from '../../integration-service/src/carrier/carrier-account.controller';
import { CarrierAccountService } from '../../integration-service/src/carrier/carrier-account.service';

/**
 * `/admin/carriers` — yashirin rollback toggle'i UCHIDAN-UCHIGA (round-trip):
 * HTTP (haqiqiy RolesGuard + global UzValidationPipe + filtrlar) → gateway
 * kontrolleri → RMQ payload → HAQIQIY integration `CarrierAccountController`
 * + `CarrierAccountService` → xotiradagi `carrier_accounts` jadvali
 * (DB sukuti `rollback_enabled = false` taqlid qilinadi) → activity-log.
 */

type Row = Record<string, unknown> & { id: string };

/** Xotiradagi `carrier_accounts` (TypeORM repo'ning ishlatiladigan qismi). */
function memoryRepo() {
  const rows: Row[] = [];
  let seq = 0;
  const matches = (row: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, value]) => {
      const actual = row[key];
      return typeof value === 'boolean'
        ? actual === value
        : String(actual) === String(value);
    });
  return {
    rows,
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
    ),
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => Number(b.id) - Number(a.id)),
      ),
    ),
    create: jest.fn((v: Record<string, unknown>) => ({ ...v })),
    save: jest.fn((v: Record<string, unknown>) => {
      seq += 1;
      const now = new Date('2026-11-14T18:40:00.000Z');
      const row: Row = {
        isDeleted: false,
        // DB sukuti (migratsiya 223): ustun berilmasa — false.
        rollback_enabled: false,
        ...v,
        id: String(seq),
        createdAt: now,
        updatedAt: now,
      };
      rows.push(row);
      return Promise.resolve({ ...row });
    }),
    update: jest.fn(
      (where: Record<string, unknown>, changes: Record<string, unknown>) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const row of hit) Object.assign(row, changes);
        return Promise.resolve({ affected: hit.length });
      },
    ),
  };
}

describe('/admin/carriers — rollback_enabled (round-trip)', () => {
  let app: INestApplication;
  let user: { sub: string; roles: string[] } = {
    sub: '1',
    roles: ['superadmin'],
  };
  const repo = memoryRepo();
  const activityLog = { log: jest.fn(() => Promise.resolve()) };
  const identityClient = {
    send: jest.fn(() =>
      of({
        data: [
          { id: '55', name: 'BTS kuryer', role: 'courier', status: 'active' },
        ],
      }),
    ),
  };
  const service = new CarrierAccountService(
    repo as never,
    activityLog as never,
    identityClient as never,
  );
  const rmqController = new CarrierAccountController(
    { ack: jest.fn(), nackForError: jest.fn() } as never,
    service,
  );

  /** `{cmd}` → integration RMQ handler (`@MessagePattern` metadata'sidan). */
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  const proto = CarrierAccountController.prototype as unknown as Record<
    string,
    unknown
  >;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const fn = proto[name];
    if (typeof fn !== 'function') continue;
    const meta: unknown = Reflect.getMetadata('microservices:pattern', fn);
    const patterns = (Array.isArray(meta) ? meta : [meta]) as Array<
      { cmd?: string } | undefined
    >;
    for (const pattern of patterns) {
      if (!pattern?.cmd) continue;
      const ctx = { getPattern: () => pattern.cmd };
      const methods = rmqController as unknown as Record<
        string,
        (p: unknown, c: unknown) => Promise<unknown>
      >;
      handlers.set(pattern.cmd, (payload) =>
        name === 'list'
          ? rmqController.list(ctx as never)
          : methods[name](payload, ctx),
      );
    }
  }

  /** Haqiqiy transport kabi: RpcException — oddiy `{statusCode, message}`. */
  const integrationClient = {
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      const handler = handlers.get(pattern.cmd);
      if (!handler) {
        return throwError(() => new Error(`kutilmagan cmd ${pattern.cmd}`));
      }
      return from(
        handler(payload).catch((error: unknown) => {
          throw error instanceof RpcException ? error.getError() : error;
        }),
      );
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CarrierAdminGatewayController],
      providers: [{ provide: 'INTEGRATION', useValue: integrationClient }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            ...user,
            roles: [...user.roles],
          };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new UzValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    user = { sub: '1', roles: ['superadmin'] };
    integrationClient.send.mockClear();
    activityLog.log.mockClear();
  });

  const server = () => app.getHttpServer() as Server;
  const body = (res: request.Response) =>
    res.body as {
      statusCode: number;
      message: string;
      data: Record<string, unknown> & Array<Record<string, unknown>>;
    };

  let id = '';

  it('⭐ yaratish: rollback_enabled QABUL QILINMAYDI (400, RMQ yo‘q); yangi akkaunt — false', async () => {
    const rejected = await request(server())
      .post('/admin/carriers')
      .send({ name: 'BTS Express', courier_id: '55', rollback_enabled: true });
    expect(rejected.status).toBe(400);
    expect(body(rejected).message).toBe(
      'rollback_enabled: bunday maydon qabul qilinmaydi',
    );
    expect(integrationClient.send).not.toHaveBeenCalled();

    const created = await request(server())
      .post('/admin/carriers')
      .send({ name: 'BTS Express', courier_id: '55' });
    expect(created.status).toBe(201);
    expect(body(created).data).toMatchObject({
      name: 'BTS Express',
      rollback_enabled: false,
    });
    id = String(body(created).data.id);

    const list = await request(server()).get('/admin/carriers');
    expect(body(list).data).toEqual([
      expect.objectContaining({ id, rollback_enabled: false }),
    ]);
    expect(JSON.stringify(body(list).data)).not.toContain('api_key');
  });

  it('⭐ PATCH { rollback_enabled: true } → yoqiladi, ro‘yxatda ko‘rinadi, audit eski → yangi (kim bilan)', async () => {
    const res = await request(server())
      .patch(`/admin/carriers/${id}`)
      .send({ rollback_enabled: true });
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({
      statusCode: 200,
      message: 'carrier account updated',
      data: { id, name: 'BTS Express', rollback_enabled: true },
    });
    expect(integrationClient.send).toHaveBeenCalledWith(
      { cmd: 'integration.carrier.update' },
      expect.objectContaining({
        id,
        rollback_enabled: true,
        requester: { id: '1', roles: ['superadmin'] },
      }),
    );
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'CarrierAccount',
        entity_id: id,
        action: 'updated',
        old_value: { rollback_enabled: false },
        new_value: { rollback_enabled: true },
        user_id: '1',
        user_role: 'superadmin',
      }),
    );
    const list = await request(server()).get('/admin/carriers');
    expect(body(list).data[0]).toMatchObject({ id, rollback_enabled: true });

    // validate_key (gateway guard'i shu bilan qaror qiladi) — yangi qiymat.
    const row = repo.rows.find((r) => r.id === id) as Row;
    repo.findOne.mockImplementationOnce(() => Promise.resolve({ ...row }));
    await expect(service.validateKey('elc_any')).resolves.toMatchObject({
      rollback_enabled: true,
    });
  });

  it('PATCH name + rollback_enabled: false birga; ADMIN ham mumkin', async () => {
    user = { sub: '2', roles: ['admin'] };
    const res = await request(server())
      .patch(`/admin/carriers/${id}`)
      .send({ name: 'BTS', rollback_enabled: false });
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({
      name: 'BTS',
      rollback_enabled: false,
    });
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: { name: 'BTS Express', rollback_enabled: true },
        new_value: { name: 'BTS', rollback_enabled: false },
        user_id: '2',
      }),
    );
  });

  it('PATCH: boolean emas → 400 (gateway yoki servis), o‘zgarmaydi', async () => {
    const asString = await request(server())
      .patch(`/admin/carriers/${id}`)
      .send({ rollback_enabled: 'true' });
    expect(asString.status).toBe(400);
    expect(body(asString).message).toBe(
      "rollback_enabled: true yoki false bo'lishi kerak",
    );

    const asNull = await request(server())
      .patch(`/admin/carriers/${id}`)
      .send({ rollback_enabled: null });
    expect(asNull.status).toBe(400);
    expect(body(asNull).message).toBe(
      "rollback_enabled boolean bo'lishi kerak",
    );

    expect(repo.rows.find((r) => r.id === id)?.rollback_enabled).toBe(false);
    expect(activityLog.log).not.toHaveBeenCalled();
  });

  it('⭐ MANAGER / COURIER — 403 (toggle faqat SUPERADMIN/ADMIN)', async () => {
    for (const role of ['manager', 'courier', 'market']) {
      user = { sub: '9', roles: [role] };
      const res = await request(server())
        .patch(`/admin/carriers/${id}`)
        .send({ rollback_enabled: true });
      expect(res.status).toBe(403);
      expect(body(res).message).toBe("Bu amal uchun ruxsat yo'q");
    }
    expect(integrationClient.send).not.toHaveBeenCalled();
    expect(repo.rows.find((r) => r.id === id)?.rollback_enabled).toBe(false);
  });

  it('rotate-key va status javoblarida rollback_enabled bor', async () => {
    const rotated = await request(server()).post(
      `/admin/carriers/${id}/rotate-key`,
    );
    expect(body(rotated).data).toMatchObject({ id, rollback_enabled: false });
    expect(String(body(rotated).data.api_key)).toMatch(/^elc_/);

    const status = await request(server())
      .post(`/admin/carriers/${id}/status`)
      .send({ is_active: false });
    expect(body(status).data).toEqual({
      id,
      is_active: false,
      rollback_enabled: false,
    });
  });
});
