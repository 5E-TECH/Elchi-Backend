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
import {
  AllExceptionsFilter,
  Roles,
  RpcExceptionFilter,
  Status,
} from '@app/common';
import { IdentityController } from '../../identity-service/src/identity.controller';
import { UserServiceService } from '../../identity-service/src/user-service.service';
import { MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM as IDENTITY_CONFIRM } from '../../identity-service/src/contracts/market.payloads';
import { ApiGatewayController } from './api-gateway.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM as GATEWAY_CONFIRM } from './dto/identity.swagger.dto';

/**
 * GvL6ZFAd — market_tg_token umumiy javoblarda YO'Q, ko'rish/rotatsiya faqat
 * SUPERADMIN marshrutlarida (kontrakt darajasida, uchidan-uchiga).
 *
 * Zanjir: HTTP (supertest) → ApiGatewayController (HAQIQIY RolesGuard,
 * global ValidationPipe whitelist+forbidNonWhitelisted, gateway filtrlari) →
 * soxta RMQ transport (`@MessagePattern` metadata bo'yicha, JSON round-trip,
 * RpcException → oddiy xato obyekti) → HAQIQIY IdentityController → HAQIQIY
 * UserServiceService → xotiradagi `admins`. Faqat JWT soxta: `x-test-user`.
 *
 * TC1 — GET /users: hech bir qatorda market_tg_token kaliti yo'q.
 * TC2 — GET /users/:id va GET /markets: kalit yo'q (SUPERADMIN uchun ham).
 * TC4 — tokenni ko'rish/rotatsiya faqat SUPERADMIN marshruti orqali; boshqa
 *       rollar 403; rotate-all tasdiqsiz 400.
 */

type Row = Record<string, any>;

const TOKEN_3 = 'group_token-0123456789abcdef0123456789abcdef';
const TOKEN_4 = 'group_token-11111111111111111111111111111111';
const TOKEN_6 = 'group_token-22222222222222222222222222222222';
const TOKEN_9 = 'group_token-33333333333333333333333333333333';
const TOKEN_RE = /^group_token-[a-f0-9]{32}$/;
const SECRET_KEYS = ['password', 'refresh_token', 'market_tg_token'];

function seedRows(): Row[] {
  const base = {
    isDeleted: false,
    region_id: null,
    district_id: null,
    username: null,
    market_id: null,
    password: '$2b$10$hash',
    refresh_token: 'f'.repeat(64),
    market_tg_token: null,
  };
  return [
    {
      ...base,
      id: '1',
      role: Roles.SUPERADMIN,
      name: 'SA',
      status: Status.ACTIVE,
    },
    {
      ...base,
      id: '2',
      role: Roles.ADMIN,
      name: 'Admin',
      status: Status.ACTIVE,
    },
    {
      ...base,
      id: '3',
      role: Roles.MARKET,
      name: 'Market A',
      phone_number: '+998900000003',
      status: Status.ACTIVE,
      market_tg_token: TOKEN_3,
    },
    {
      ...base,
      id: '4',
      role: Roles.MARKET,
      name: 'Nofaol market',
      phone_number: '+998900000004',
      status: Status.INACTIVE,
      market_tg_token: TOKEN_4,
    },
    {
      ...base,
      id: '6',
      role: Roles.MARKET,
      name: "O'chirilgan market",
      status: Status.INACTIVE,
      isDeleted: true,
      market_tg_token: TOKEN_6,
    },
    {
      // Xodim qatorida qolib ketgan eski qiymat.
      ...base,
      id: '9',
      role: Roles.COURIER,
      name: 'Kuryer',
      status: Status.ACTIVE,
      market_tg_token: TOKEN_9,
    },
  ];
}

function rowMatches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    const actual = row[key] ?? null;
    if (actual === null || expected === null) return actual === expected;
    return String(actual) === String(expected as string | number | boolean);
  });
}

/** findAllAdmins ('admin' alias) / findAllMarkets ('market' alias) uchun soddalashtirilgan QB. */
function makeQueryBuilder(rows: Row[], alias: string) {
  const visible = () =>
    rows.filter((row) => {
      if (row.isDeleted) return false;
      if (alias === 'market') return row.role === Roles.MARKET;
      if (alias === 'admin') {
        return row.role !== Roles.SUPERADMIN && row.role !== Roles.CUSTOMER;
      }
      return true;
    });
  const qb: Record<string, unknown> = {};
  Object.assign(qb, {
    where: () => qb,
    andWhere: () => qb,
    orderBy: () => qb,
    skip: () => qb,
    take: () => qb,
    clone: () => qb,
    getManyAndCount: () =>
      Promise.resolve([visible().map((row) => ({ ...row })), visible().length]),
    getCount: () => Promise.resolve(visible().length),
  });
  return qb;
}

function makeUsersRepo(seed: Row[]) {
  const rows: Row[] = seed.map((row) => ({ ...row }));
  const find = jest.fn(({ where }: { where: Record<string, unknown> }) =>
    Promise.resolve(
      rows
        .filter((row) => rowMatches(row, where))
        .map((row) => ({ id: row.id })),
    ),
  );
  const update = jest.fn(
    (where: Record<string, unknown>, patch: Record<string, unknown>) => {
      const targets = rows.filter((row) => rowMatches(row, where));
      targets.forEach((row) => Object.assign(row, patch));
      return Promise.resolve({ affected: targets.length });
    },
  );
  return {
    rows,
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      const found = rows.find((row) => rowMatches(row, where));
      return Promise.resolve(found ? { ...found } : null);
    }),
    update,
    createQueryBuilder: jest.fn((alias: string) =>
      makeQueryBuilder(rows, alias),
    ),
    manager: {
      transaction: jest.fn(
        (cb: (manager: { getRepository: () => unknown }) => unknown) =>
          Promise.resolve(cb({ getRepository: () => ({ find, update }) })),
      ),
    },
  };
}

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

const asUser = (sub: string, role: string) =>
  JSON.stringify({ sub, username: `u${sub}`, roles: [role] });
const SUPERADMIN = asUser('1', 'superadmin');
const NON_SUPERADMIN_ROLES = [
  'admin',
  'manager',
  'registrator',
  'market',
  'courier',
  'branch',
  'logist',
  'market_operator',
];

describe('market_tg_token — umumiy javoblarda yo‘q, faqat SUPERADMIN marshrutlari (GvL6ZFAd)', () => {
  let app: INestApplication;
  let repo: ReturnType<typeof makeUsersRepo>;
  let transport: ReturnType<typeof makeRmqTransport>;
  let activityLog: { log: jest.Mock; logChange: jest.Mock };

  beforeEach(async () => {
    repo = makeUsersRepo(seedRows());
    activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    };
    const noopClient = { send: jest.fn(() => of({})), emit: jest.fn() };
    const service = new UserServiceService(
      repo as any,
      noopClient as any, // search
      noopClient as any, // catalog
      noopClient as any, // order
      noopClient as any, // logistics
      noopClient as any, // finance
      noopClient as any, // branch
      { encrypt: jest.fn(), compare: jest.fn() } as any,
      { get: jest.fn() } as any,
      activityLog as any,
    );
    const identityController = new IdentityController(
      { ack: jest.fn(), nackForError: jest.fn() } as any,
      service,
      {} as any,
      {} as any,
    );
    transport = makeRmqTransport(identityController);

    // Menejer filiali: REGIONAL, a'zolari — market 3 va kuryer 9.
    const branchClient = {
      send: jest.fn(({ cmd }: { cmd: string }) => {
        if (cmd === 'branch.user.find_by_user') {
          return of({
            data: { branch_id: '7', branch: { id: '7', type: 'REGIONAL' } },
          });
        }
        if (cmd === 'branch.user.find_by_branch') {
          return of({
            data: [
              { user_id: '3', role: 'MARKET' },
              { user_id: '9', role: 'COURIER' },
            ],
          });
        }
        return of({ data: null });
      }),
    };
    const financeClient = {
      send: jest.fn(() => of({ data: { balance: 0 } })),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: transport },
        { provide: 'FINANCE', useValue: financeClient },
        { provide: 'BRANCH', useValue: branchClient },
      ],
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
    expect(JSON.stringify(activityLog.log.mock.calls)).not.toContain(
      'group_token-',
    );
    if (app) await app.close();
  });

  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const sentCmds = () =>
    transport.send.mock.calls.map(
      ([pattern]: [{ cmd: string }]) => pattern.cmd,
    );
  const tokenOf = (id: string) =>
    repo.rows.find((row) => row.id === id)?.market_tg_token as string | null;

  function expectNoSecretKeys(items: Row[]) {
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      for (const key of SECRET_KEYS) {
        expect(item).not.toHaveProperty(key);
      }
    }
  }

  describe('kontrakt', () => {
    it('gateway yuboradigan token cmd’larining identity’da handleri bor', () => {
      expect([...transport.handlers.keys()]).toEqual(
        expect.arrayContaining([
          'identity.market.get_tg_token',
          'identity.market.rotate_tg_token',
          'identity.market.rotate_all_tg_tokens',
        ]),
      );
    });

    it('uchala token marshruti @Roles AYNAN [superadmin]', () => {
      const rolesOf = (method: keyof ApiGatewayController) =>
        Reflect.getMetadata(
          ROLES_KEY,
          Object.getOwnPropertyDescriptor(
            ApiGatewayController.prototype,
            method,
          )?.value,
        ) as string[];
      expect(rolesOf('getMarketTgToken')).toEqual(['superadmin']);
      expect(rolesOf('rotateMarketTgToken')).toEqual(['superadmin']);
      expect(rolesOf('rotateAllMarketTgTokens')).toEqual(['superadmin']);
    });

    it("rotate-all tasdig'i gateway DTO va identity kontraktida bir xil", () => {
      expect(GATEWAY_CONFIRM).toBe('ROTATE_ALL');
      expect(IDENTITY_CONFIRM).toBe(GATEWAY_CONFIRM);
    });
  });

  describe('TC1/TC2 — umumiy javoblarda market_tg_token kaliti yo‘q', () => {
    it.each([['superadmin'], ['admin'], ['manager']])(
      'GET /users (%s): hech bir qatorda kalit yo‘q, javob matnida token yo‘q',
      async (role) => {
        const res = await http()
          .get('/users?limit=100')
          .set('x-test-user', asUser('19', role));

        expect(res.status).toBe(200);
        expectNoSecretKeys(res.body.data.items);
        expect(
          (res.body.data.items as Row[]).some((row) => row.role === 'market'),
        ).toBe(true);
        expect(res.text).not.toContain('group_token-');
      },
    );

    it.each([['superadmin'], ['admin'], ['manager']])(
      'GET /users/:id (%s) market qatori: kalit yo‘q',
      async (role) => {
        const res = await http()
          .get('/users/3')
          .set('x-test-user', asUser('19', role));

        expect(res.status).toBe(200);
        expect(res.body.data.id).toBe('3');
        expectNoSecretKeys([res.body.data]);
        expect(res.text).not.toContain('group_token-');
      },
    );

    it('GET /users/:id?include_tg_token=true (superadmin) — eski flag ham ochmaydi', async () => {
      const res = await http()
        .get('/users/3?include_tg_token=true')
        .set('x-test-user', SUPERADMIN);

      expect(res.status).toBe(200);
      expectNoSecretKeys([res.body.data]);
      expect(transport.send).toHaveBeenCalledWith(
        { cmd: 'identity.user.find_by_id' },
        { id: '3' },
      );
    });

    it('GET /users/:id kuryer qatorida qolib ketgan eski token ham chiqmaydi', async () => {
      const res = await http().get('/users/9').set('x-test-user', SUPERADMIN);

      expect(res.status).toBe(200);
      expectNoSecretKeys([res.body.data]);
      expect(res.text).not.toContain('group_token-');
    });

    it.each([
      ['superadmin'],
      ['admin'],
      ['manager'],
      ['registrator'],
      ['branch'],
      ['courier'],
    ])('GET /markets (%s): kalit yo‘q', async (role) => {
      const res = await http()
        .get('/markets?limit=100')
        .set('x-test-user', asUser('19', role));

      expect(res.status).toBe(200);
      expectNoSecretKeys(res.body.data.items);
      expect(res.text).not.toContain('group_token-');
    });
  });

  describe('TC4 — GET /markets/:id/tg-token', () => {
    it('SUPERADMIN: 200, { id, market_tg_token }, Cache-Control: no-store, jurnalga yoziladi', async () => {
      const res = await http()
        .get('/markets/3/tg-token')
        .set('x-test-user', SUPERADMIN);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: '3', market_tg_token: TOKEN_3 });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_id: '3',
          action: 'market.tg_token_viewed',
          user_id: '1',
        }),
      );
    });

    it.each(NON_SUPERADMIN_ROLES)(
      '%s → 403 (RolesGuard), identity’ga so‘rov ketmaydi',
      async (role) => {
        const res = await http()
          .get('/markets/3/tg-token')
          .set('x-test-user', asUser('2', role));

        expect(res.status).toBe(403);
        expect(res.text).not.toContain('group_token-');
        expect(sentCmds()).not.toContain('identity.market.get_tg_token');
        expect(activityLog.log).not.toHaveBeenCalled();
      },
    );

    it('JWT yo‘q → 401', async () => {
      const res = await http().get('/markets/3/tg-token');

      expect(res.status).toBe(401);
      expect(transport.send).not.toHaveBeenCalled();
    });

    it.each([
      ["mavjud bo'lmagan market", '999'],
      ["o'chirilgan market", '6'],
      ['market emas (kuryer)', '9'],
    ])('SUPERADMIN, %s → 404', async (_label, id) => {
      const res = await http()
        .get(`/markets/${id}/tg-token`)
        .set('x-test-user', SUPERADMIN);

      expect(res.status).toBe(404);
      expect(res.text).not.toContain('group_token-');
    });

    it('SUPERADMIN, raqam bo‘lmagan id → 404, identity’ga bormaydi', async () => {
      const res = await http()
        .get('/markets/abc/tg-token')
        .set('x-test-user', SUPERADMIN);

      expect(res.status).toBe(404);
      expect(transport.send).not.toHaveBeenCalled();
    });
  });

  describe('TC4 — POST /markets/:id/tg-token/rotate', () => {
    it('SUPERADMIN: 200, yangi token qaytadi; eski token bilan market endi topilmaydi', async () => {
      const res = await http()
        .post('/markets/3/tg-token/rotate')
        .set('x-test-user', SUPERADMIN);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.data.id).toBe('3');
      expect(res.body.data.market_tg_token).toMatch(TOKEN_RE);
      expect(res.body.data.market_tg_token).not.toBe(TOKEN_3);
      expect(tokenOf('3')).toBe(res.body.data.market_tg_token);

      const oldLookup = await transport.handlers.get(
        'identity.market.find_by_tg_token',
      )!({ market_tg_token: TOKEN_3 }).then(
        () => null,
        (error: unknown) => (error as RpcException).getError(),
      );
      expect(oldLookup).toEqual(expect.objectContaining({ statusCode: 404 }));

      const view = await http()
        .get('/markets/3/tg-token')
        .set('x-test-user', SUPERADMIN);
      expect(view.body.data.market_tg_token).toBe(
        res.body.data.market_tg_token,
      );
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_id: '3',
          action: 'market.tg_token_rotated',
          user_id: '1',
        }),
      );
    });

    it.each(NON_SUPERADMIN_ROLES)(
      '%s → 403, token o‘zgarmaydi',
      async (role) => {
        const res = await http()
          .post('/markets/3/tg-token/rotate')
          .set('x-test-user', asUser('2', role));

        expect(res.status).toBe(403);
        expect(tokenOf('3')).toBe(TOKEN_3);
        expect(sentCmds()).not.toContain('identity.market.rotate_tg_token');
      },
    );

    it("SUPERADMIN, o'chirilgan market → 404, token o'zgarmaydi", async () => {
      const res = await http()
        .post('/markets/6/tg-token/rotate')
        .set('x-test-user', SUPERADMIN);

      expect(res.status).toBe(404);
      expect(tokenOf('6')).toBe(TOKEN_6);
    });
  });

  describe('TC4 — POST /markets/tg-token/rotate-all', () => {
    it.each([
      ['tanasiz', undefined],
      ["bo'sh tana", {}],
      ["noto'g'ri confirm", { confirm: 'yes' }],
      ['kichik harf', { confirm: 'rotate_all' }],
      ['ortiqcha maydon', { confirm: 'ROTATE_ALL', force: true }],
    ])(
      'SUPERADMIN, %s → 400, hech bir token o‘zgarmaydi',
      async (_label, body) => {
        const req = http()
          .post('/markets/tg-token/rotate-all')
          .set('x-test-user', SUPERADMIN);
        const res = await (body === undefined ? req : req.send(body));

        expect(res.status).toBe(400);
        expect(sentCmds()).not.toContain(
          'identity.market.rotate_all_tg_tokens',
        );
        expect(tokenOf('3')).toBe(TOKEN_3);
        expect(tokenOf('4')).toBe(TOKEN_4);
      },
    );

    it.each(NON_SUPERADMIN_ROLES)(
      "%s (to'g'ri tasdiq bilan ham) → 403",
      async (role) => {
        const res = await http()
          .post('/markets/tg-token/rotate-all')
          .set('x-test-user', asUser('2', role))
          .send({ confirm: 'ROTATE_ALL' });

        expect(res.status).toBe(403);
        expect(repo.manager.transaction).not.toHaveBeenCalled();
        expect(tokenOf('3')).toBe(TOKEN_3);
      },
    );

    it("SUPERADMIN + { confirm: 'ROTATE_ALL' }: 200, javobda faqat son; faol marketlar (INACTIVE ham) yangilanadi, o'chirilgan/xodim qatori yo'q; bitta jurnal qatori", async () => {
      const res = await http()
        .post('/markets/tg-token/rotate-all')
        .set('x-test-user', SUPERADMIN)
        .send({ confirm: 'ROTATE_ALL' });

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.data).toEqual({ rotated_count: 2 });
      expect(res.text).not.toContain('group_token-');

      // Statik marshrut `:id` ga tushmadi — rotate_tg_token(id='tg-token') emas.
      expect(sentCmds()).toEqual(['identity.market.rotate_all_tg_tokens']);
      expect(repo.manager.transaction).toHaveBeenCalledTimes(1);

      expect(tokenOf('3')).toMatch(TOKEN_RE);
      expect(tokenOf('3')).not.toBe(TOKEN_3);
      expect(tokenOf('4')).toMatch(TOKEN_RE);
      expect(tokenOf('4')).not.toBe(TOKEN_4);
      expect(tokenOf('6')).toBe(TOKEN_6);
      expect(tokenOf('9')).toBe(TOKEN_9);

      const rotateAllLogs = activityLog.log.mock.calls.filter(
        ([input]: [{ action: string }]) =>
          input.action === 'market.tg_token_rotated_all',
      );
      expect(rotateAllLogs).toHaveLength(1);
      expect(rotateAllLogs[0][0]).toEqual(
        expect.objectContaining({
          user_id: '1',
          metadata: { rotated_count: 2 },
        }),
      );
      expect(activityLog.log).toHaveBeenCalledTimes(1);
    });
  });
});
