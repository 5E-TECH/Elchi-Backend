import 'reflect-metadata';
import {
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { Test } from '@nestjs/testing';
import { catchError, from, of, throwError } from 'rxjs';
import request from 'supertest';
import { FindOperator, QueryFailedError } from 'typeorm';
import {
  AllExceptionsFilter,
  Roles,
  RpcExceptionFilter,
  Status,
} from '@app/common';
import { IdentityController } from '../../identity-service/src/identity.controller';
import { UserServiceService } from '../../identity-service/src/user-service.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { MarketOperatorGatewayController } from './market-operator-gateway.controller';

/**
 * i76gGjyq — /market-operators uchidan-uchiga (kontrakt darajasida).
 *
 * Zanjir: HTTP (supertest) → MarketOperatorGatewayController (HAQIQIY
 * RolesGuard, global ValidationPipe whitelist+forbidNonWhitelisted, gateway
 * filtrlari) → soxta RMQ transport (`@MessagePattern` metadata bo'yicha
 * marshrut, JSON round-trip, RpcException → oddiy xato obyekti) → HAQIQIY
 * IdentityController → HAQIQIY UserServiceService → xotiradagi `admins`.
 * Faqat JWT (JwtAuthGuard) soxta: `x-test-user` sarlavhasidagi payload.
 *
 * TC1 — market login → operator yaratish → ro'yxatda paydo bo'lishi.
 * TC2 — A ro'yxatida B operatorlari yo'q; A B nikini o'chira/tahrirlay olmaydi.
 * TC3 — market rolida GET /market-operators 200 (ilgari /users → 403).
 * TC5 — o'chirish va komissiya (percent/fixed) saqlanishi.
 */

type Row = Record<string, any>;

function matches(row: Row, clause: Record<string, unknown>): boolean {
  return Object.entries(clause).every(([key, expected]) => {
    if (expected instanceof FindOperator) {
      if (expected.type !== 'ilike') {
        throw new Error(`unsupported operator ${expected.type}`);
      }
      const needle = String(expected.value).replace(/%/g, '').toLowerCase();
      return String(row[key] ?? '')
        .toLowerCase()
        .includes(needle);
    }
    const actual = row[key] ?? null;
    const want = expected ?? null;
    if (actual === null || want === null) {
      return actual === want;
    }
    return String(actual) === String(want as string | number | boolean);
  });
}

function makeUsersRepo(seed: Row[]) {
  const rows: Row[] = seed.map((row) => ({ ...row }));
  let seq = 1000;
  const clauses = (where: unknown) =>
    (Array.isArray(where) ? where : [where]) as Record<string, unknown>[];
  return {
    rows,
    findOne: jest.fn(({ where }: { where: unknown }) => {
      const found = rows.find((row) =>
        clauses(where).some((clause) => matches(row, clause)),
      );
      return Promise.resolve(found ? { ...found } : null);
    }),
    findAndCount: jest.fn(
      ({
        where,
        skip = 0,
        take,
      }: {
        where: unknown;
        skip?: number;
        take?: number;
      }) => {
        const all = rows
          .filter((row) =>
            clauses(where).some((clause) => matches(row, clause)),
          )
          .sort((a, b) => Number(b.id) - Number(a.id));
        const page = all.slice(skip, take ? skip + take : undefined);
        return Promise.resolve([page.map((row) => ({ ...row })), all.length]);
      },
    ),
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((entity: Row) => {
      if (!entity.id) {
        if (rows.some((row) => row.phone_number === entity.phone_number)) {
          return Promise.reject(
            new QueryFailedError(
              'INSERT',
              [],
              Object.assign(new Error('duplicate key'), { code: '23505' }),
            ),
          );
        }
        const now = new Date();
        const created = {
          ...entity,
          id: String(++seq),
          createdAt: now,
          updatedAt: now,
        };
        rows.push(created);
        return Promise.resolve({ ...created });
      }
      const index = rows.findIndex((row) => row.id === entity.id);
      rows[index] = { ...rows[index], ...entity, updatedAt: new Date() };
      return Promise.resolve({ ...rows[index] });
    }),
  };
}

/**
 * RMQ o'rniga: `{ cmd }` → IdentityController'dagi `@MessagePattern` metodi.
 * Yuk va javob JSON'dan o'tadi (undefined kalitlar tushib qoladi, Date →
 * satr), RpcException esa — xuddi Nest RMQ kabi — `getError()` obyekti
 * bo'lib qaytadi.
 */
function makeRmqTransport(controller: IdentityController) {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  const proto = IdentityController.prototype as unknown as Record<
    string,
    unknown
  >;
  const context = { getPattern: () => 'test' } as unknown as RmqContext;
  for (const key of Object.getOwnPropertyNames(proto)) {
    const method = proto[key];
    if (typeof method !== 'function') continue;
    const patterns = (Reflect.getMetadata(PATTERN_METADATA, method) ??
      []) as Array<{ cmd?: string }>;
    for (const pattern of patterns) {
      if (pattern?.cmd) {
        handlers.set(pattern.cmd, (payload) =>
          Promise.resolve(
            (method as (...args: unknown[]) => unknown).call(
              controller,
              payload,
              context,
            ),
          ),
        );
      }
    }
  }
  const roundTrip = <T>(value: T): T =>
    value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  return {
    handlers,
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      const handler = handlers.get(pattern.cmd);
      if (!handler) {
        return throwError(() => ({
          statusCode: 500,
          message: `identity'da ${pattern.cmd} handleri yo'q`,
        }));
      }
      return from(handler(roundTrip(payload)).then(roundTrip)).pipe(
        catchError((error: unknown) =>
          throwError(() =>
            error instanceof RpcException ? error.getError() : error,
          ),
        ),
      );
    }),
  };
}

const MARKET_A = '10';
const MARKET_B = '20';

function seedRows(): Row[] {
  const base = { isDeleted: false, username: null, market_id: null };
  return [
    {
      ...base,
      id: MARKET_A,
      role: Roles.MARKET,
      status: Status.ACTIVE,
      name: 'Market A',
      phone_number: '+998900000010',
    },
    {
      ...base,
      id: MARKET_B,
      role: Roles.MARKET,
      status: Status.ACTIVE,
      name: 'Market B',
      phone_number: '+998900000020',
    },
    {
      ...base,
      id: '50',
      role: Roles.MARKET_OPERATOR,
      status: Status.ACTIVE,
      name: 'B operatori',
      phone_number: '+998905550050',
      market_id: MARKET_B,
      commission_type: null,
      commission_value: null,
    },
  ];
}

const asUser = (sub: string, role: string) =>
  JSON.stringify({ sub, username: `u${sub}`, roles: [role] });
const marketA = asUser(MARKET_A, 'MARKET'); // RolesGuard katta harfni ham normallaydi
const marketB = asUser(MARKET_B, 'market');
const admin = asUser('1', 'admin');

describe('MarketOperatorGatewayController ↔ identity (i76gGjyq)', () => {
  let app: INestApplication;
  let repo: ReturnType<typeof makeUsersRepo>;
  let transport: ReturnType<typeof makeRmqTransport>;

  beforeEach(async () => {
    repo = makeUsersRepo(seedRows());
    const noopClient = { send: jest.fn(() => of({})), emit: jest.fn() };
    const service = new UserServiceService(
      repo as any,
      noopClient as any, // search
      noopClient as any, // catalog
      noopClient as any, // order
      noopClient as any, // logistics
      noopClient as any, // finance
      noopClient as any, // branch
      {
        encrypt: jest.fn((plain: string) => Promise.resolve(`bcrypt$${plain}`)),
        compare: jest.fn(),
      } as any,
      { get: jest.fn() } as any,
      {
        log: jest.fn().mockResolvedValue(undefined),
        logChange: jest.fn().mockResolvedValue(undefined),
      } as any,
    );
    const identityController = new IdentityController(
      { ack: jest.fn(), nackForError: jest.fn() } as any,
      service,
      {} as any,
      {} as any,
    );
    transport = makeRmqTransport(identityController);

    const moduleRef = await Test.createTestingModule({
      controllers: [MarketOperatorGatewayController],
      providers: [{ provide: 'IDENTITY', useValue: transport }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{
            headers: Record<string, string | undefined>;
            user?: unknown;
          }>();
          const raw = req.headers['x-test-user'];
          if (!raw) throw new UnauthorizedException();
          req.user = JSON.parse(raw);
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
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);

  const createOperator = (user: string, body: Record<string, unknown>) =>
    http().post('/market-operators').set('x-test-user', user).send(body);

  const operatorBody = {
    name: 'Ali Valiyev',
    phone_number: '+998901234567',
    password: 'secret123',
  };

  it('kontrakt: gateway yuboradigan har bir cmd identity`da handlerga ega', () => {
    expect([...transport.handlers.keys()]).toEqual(
      expect.arrayContaining([
        'identity.market_operator.create',
        'identity.market_operator.find_by_market',
        'identity.market_operator.delete',
        'identity.market_operator.update_commission',
      ]),
    );
  });

  it('rollar: hamma yo`l — faqat market', () => {
    const rolesOf = (method: keyof MarketOperatorGatewayController) =>
      Reflect.getMetadata(
        ROLES_KEY,
        Object.getOwnPropertyDescriptor(
          MarketOperatorGatewayController.prototype,
          method,
        )?.value,
      ) as string[];
    expect(rolesOf('list')).toEqual(['market']);
    expect(rolesOf('create')).toEqual(['market']);
    expect(rolesOf('remove')).toEqual(['market']);
    expect(rolesOf('updateCommission')).toEqual(['market']);
  });

  it('TC1: market operator yaratadi → u ro`yxatda market_operator sifatida chiqadi', async () => {
    const created = await createOperator(marketA, operatorBody).expect(201);
    expect(created.body.data).toMatchObject({
      name: 'Ali Valiyev',
      phone_number: '+998901234567',
      role: 'market_operator',
      market_id: MARKET_A,
      status: 'active',
    });
    expect(created.body.data).not.toHaveProperty('password');

    const list = await http()
      .get('/market-operators?page=1&limit=100')
      .set('x-test-user', marketA)
      .expect(200);
    expect(list.body.data.items).toEqual([
      expect.objectContaining({
        id: created.body.data.id,
        role: 'market_operator',
        market_id: MARKET_A,
      }),
    ]);
    expect(list.body.data.meta).toMatchObject({
      page: 1,
      limit: 100,
      total: 1,
    });

    // Bazada parol hash holida.
    const stored = repo.rows.find((row) => row.id === created.body.data.id);
    expect(stored?.password).toBe('bcrypt$secret123');
  });

  it('TC3: market rolida GET /market-operators → 200 (bo`sh ro`yxat ham)', async () => {
    const res = await http()
      .get('/market-operators')
      .set('x-test-user', marketA)
      .expect(200);
    expect(res.body.data.items).toEqual([]);
  });

  it.each([
    ['courier'],
    ['market_operator'],
    ['operator'],
    ['manager'],
    ['registrator'],
  ])('TC3: %s roli → 403 (RolesGuard)', async (role) => {
    await http()
      .get('/market-operators')
      .set('x-test-user', asUser('77', role))
      .expect(403);
    await createOperator(asUser('77', role), operatorBody).expect(403);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('JWT yo`q → 401', async () => {
    await http().get('/market-operators').expect(401);
  });

  it('TC2: A ro`yxatida B operatorlari yo`q; B o`zinikini ko`radi', async () => {
    await createOperator(marketA, operatorBody).expect(201);

    const listA = await http()
      .get('/market-operators')
      .set('x-test-user', marketA)
      .expect(200);
    const idsA = listA.body.data.items.map((item: { id: string }) => item.id);
    expect(idsA).not.toContain('50');
    expect(
      listA.body.data.items.every(
        (item: { market_id: string }) => item.market_id === MARKET_A,
      ),
    ).toBe(true);

    const listB = await http()
      .get('/market-operators')
      .set('x-test-user', marketB)
      .expect(200);
    expect(
      listB.body.data.items.map((item: { id: string }) => item.id),
    ).toEqual(['50']);
  });

  it('TC2: market boshqa market_id so`rasa → 400; o`zinikini takrorlasa → 200', async () => {
    await http()
      .get(`/market-operators?market_id=${MARKET_B}`)
      .set('x-test-user', marketA)
      .expect(400);
    await http()
      .get(`/market-operators?market_id=${MARKET_A}`)
      .set('x-test-user', marketA)
      .expect(200);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('TC2: tanadagi market_id/role → 400 (forbidNonWhitelisted), identity`ga yetmaydi', async () => {
    await createOperator(marketA, {
      ...operatorBody,
      market_id: MARKET_B,
    }).expect(400);
    await createOperator(marketA, { ...operatorBody, role: 'admin' }).expect(
      400,
    );
    expect(transport.send).not.toHaveBeenCalled();
    expect(
      repo.rows.filter((row) => row.role === Roles.MARKET_OPERATOR),
    ).toHaveLength(1);
  });

  it('TC2: A B operatorini o`chira olmaydi va komissiyasini o`zgartira olmaydi → 404', async () => {
    await http()
      .delete('/market-operators/50')
      .set('x-test-user', marketA)
      .expect(404);
    await http()
      .patch('/market-operators/50/commission')
      .set('x-test-user', marketA)
      .send({ commission_type: 'percent', commission_value: 50 })
      .expect(404);
    expect(repo.rows.find((row) => row.id === '50')).toMatchObject({
      isDeleted: false,
      commission_type: null,
    });
  });

  it('TC5: operatorni o`chirish → ro`yxatdan yo`qoladi, takroran → 404', async () => {
    const created = await createOperator(marketA, operatorBody).expect(201);
    const id = created.body.data.id as string;

    const deleted = await http()
      .delete(`/market-operators/${id}`)
      .set('x-test-user', marketA)
      .expect(200);
    expect(deleted.body.data).toEqual({ id });

    const list = await http()
      .get('/market-operators')
      .set('x-test-user', marketA)
      .expect(200);
    expect(list.body.data.items).toEqual([]);
    await http()
      .delete(`/market-operators/${id}`)
      .set('x-test-user', marketA)
      .expect(404);
  });

  it('TC5: komissiya percent → fixed saqlanadi va ro`yxatda ko`rinadi', async () => {
    const created = await createOperator(marketA, operatorBody).expect(201);
    const id = created.body.data.id as string;

    const percent = await http()
      .patch(`/market-operators/${id}/commission`)
      .set('x-test-user', marketA)
      .send({ commission_type: 'percent', commission_value: 5 })
      .expect(200);
    expect(percent.body.data).toMatchObject({
      commission_type: 'percent',
      commission_value: 5,
    });

    await http()
      .patch(`/market-operators/${id}/commission`)
      .set('x-test-user', marketA)
      .send({ commission_type: 'fixed', commission_value: 12000 })
      .expect(200);

    const list = await http()
      .get('/market-operators')
      .set('x-test-user', marketA)
      .expect(200);
    expect(list.body.data.items[0]).toMatchObject({
      id,
      commission_type: 'fixed',
      commission_value: 12000,
    });
  });

  it('TC5: komissiya validatsiyasi — DTO (gateway) va turi bo`yicha chegara (identity) → 400', async () => {
    const created = await createOperator(marketA, operatorBody).expect(201);
    const id = created.body.data.id as string;
    const patch = (body: Record<string, unknown>) =>
      http()
        .patch(`/market-operators/${id}/commission`)
        .set('x-test-user', marketA)
        .send(body);

    await patch({ commission_type: 'bonus', commission_value: 1 }).expect(400);
    await patch({ commission_value: -5 }).expect(400);
    await patch({ commission_value: '5' }).expect(400);
    await patch({ commission_value: 1.005 }).expect(400);
    await patch({ commission_value: 2_000_000 }).expect(400);
    await patch({ commission_type: 'percent', commission_value: 150 }).expect(
      400,
    ); // identity
    await patch({}).expect(400); // identity: hech bo'lmasa bitta maydon
    await patch({ commission_type: 'percent', market_id: MARKET_B }).expect(
      400,
    );
    expect(repo.rows.find((row) => row.id === id)?.commission_type).toBeNull();
  });

  it('noto`g`ri :id → 400 (ParseBigintIdPipe), identity`ga yetmaydi', async () => {
    await http()
      .delete('/market-operators/abc')
      .set('x-test-user', marketA)
      .expect(400);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('yaratish: telefon band → 409; noto`g`ri telefon → 400', async () => {
    await createOperator(marketA, operatorBody).expect(201);
    await createOperator(marketB, { ...operatorBody, name: 'Boshqa' }).expect(
      409,
    );
    await createOperator(marketA, {
      ...operatorBody,
      phone_number: '123',
    }).expect(400);
  });

  it('superadmin/admin: ro`yxat ham, yaratish ham → 403 (faqat market)', async () => {
    await http()
      .get(`/market-operators?market_id=${MARKET_B}`)
      .set('x-test-user', admin)
      .expect(403);
    await http().get('/market-operators').set('x-test-user', admin).expect(403);
    await createOperator(admin, operatorBody).expect(403);
  });
});
