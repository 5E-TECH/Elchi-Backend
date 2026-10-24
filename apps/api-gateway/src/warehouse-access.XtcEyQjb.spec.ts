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
import { FindOperator } from 'typeorm';
import {
  AllExceptionsFilter,
  publicErrorFields,
  Roles,
  RpcExceptionFilter,
  Status,
  WAREHOUSE_RPC,
} from '@app/common';
import { IdentityController } from '../../identity-service/src/identity.controller';
import { UserServiceService } from '../../identity-service/src/user-service.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { MarketOperatorGatewayController } from './market-operator-gateway.controller';
import { WarehouseGatewayController } from './warehouse-gateway.controller';

/**
 * XtcEyQjb — ombor ruxsatlari uchidan-uchiga (HTTP → gateway → soxta RMQ →
 * HAQIQIY IdentityController/UserServiceService → xotiradagi `admins`):
 *
 *   - market o'z operatoriga «Ombordagi qoldiq»ni ochadi/yopadi
 *     (`PATCH /market-operators/:id/warehouse-access`), ro'yxat va profil
 *     maydoni, jurnal `identity.market_operator_warehouse_access_changed`;
 *   - `GET /market/warehouse-stock`: kalit o'chiq operator — 403
 *     `{ code: "WAREHOUSE_STOCK_FORBIDDEN" }`, yoqilgan — o'z marketi;
 *   - xato konvertida `WAREHOUSE_PAUSED` (kirim) va `WAREHOUSE_STOCK_FORBIDDEN`
 *     kodlari FE'ga yetadi (`PUBLIC_ERROR_CODES`);
 *   - o'qish rollari: registrator — hamma omborlar, kuryer/market/mijoz/
 *     investor — 403 (HAQIQIY RolesGuard).
 */

type Row = Record<string, any>;

function matches(row: Row, clause: Record<string, unknown>): boolean {
  return Object.entries(clause).every(([key, expected]) => {
    if (expected instanceof FindOperator) {
      if (expected.type === 'in') {
        const list = (expected.value as unknown[]).map(String);
        return list.includes(String(row[key]));
      }
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
  const clauses = (where: unknown) =>
    (Array.isArray(where) ? where : [where]) as Record<string, unknown>[];
  const filter = (where: unknown) =>
    rows.filter((row) => clauses(where).some((clause) => matches(row, clause)));
  return {
    rows,
    findOne: jest.fn(({ where }: { where: unknown }) => {
      const found = filter(where)[0];
      return Promise.resolve(found ? { ...found } : null);
    }),
    find: jest.fn(({ where }: { where: unknown }) =>
      Promise.resolve(filter(where).map((row) => ({ ...row }))),
    ),
    findAndCount: jest.fn(({ where }: { where: unknown }) => {
      const all = filter(where).sort((a, b) => Number(b.id) - Number(a.id));
      return Promise.resolve([all.map((row) => ({ ...row })), all.length]);
    }),
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((entity: Row) => {
      const index = rows.findIndex((row) => row.id === entity.id);
      rows[index] = { ...rows[index], ...entity, updatedAt: new Date() };
      return Promise.resolve({ ...rows[index] });
    }),
  };
}

/** `{ cmd }` → IdentityController `@MessagePattern` metodi (JSON round-trip). */
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
const OPERATOR_A = '50';
const OPERATOR_B = '51';

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
      add_order: true,
    },
    {
      ...base,
      id: MARKET_B,
      role: Roles.MARKET,
      status: Status.ACTIVE,
      name: 'Market B',
      phone_number: '+998900000020',
      add_order: true,
    },
    {
      ...base,
      id: OPERATOR_A,
      role: Roles.MARKET_OPERATOR,
      status: Status.ACTIVE,
      name: 'A operatori',
      phone_number: '+998905550050',
      market_id: MARKET_A,
      // Migratsiya 152 sukuti: ustun bor, qiymat false.
      can_view_warehouse_stock: false,
    },
    {
      ...base,
      id: OPERATOR_B,
      role: Roles.MARKET_OPERATOR,
      status: Status.ACTIVE,
      name: 'B operatori',
      phone_number: '+998905550051',
      market_id: MARKET_B,
      can_view_warehouse_stock: false,
    },
  ];
}

const asUser = (sub: string, role: string) =>
  JSON.stringify({ sub, username: `u${sub}`, roles: [role] });
const marketA = asUser(MARKET_A, 'market');
const operatorA = asUser(OPERATOR_A, 'market_operator');

describe('XtcEyQjb — ombor ruxsatlari (gateway ↔ identity)', () => {
  let app: INestApplication;
  let repo: ReturnType<typeof makeUsersRepo>;
  let transport: ReturnType<typeof makeRmqTransport>;
  let activityLog: { log: jest.Mock; logChange: jest.Mock };
  let catalogSend: jest.Mock;
  let branchSend: jest.Mock;

  beforeEach(async () => {
    repo = makeUsersRepo(seedRows());
    const noopClient = { send: jest.fn(() => of({})), emit: jest.fn() };
    activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    };
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
    catalogSend = jest.fn((pattern: { cmd: string }) =>
      pattern.cmd === WAREHOUSE_RPC.STOCK_IN
        ? throwError(() => ({
            statusCode: 409,
            message: "Ombor to'xtatilgan — kirim qilib bo'lmaydi",
            code: 'WAREHOUSE_PAUSED',
            warehouse_id: '3',
          }))
        : of({ data: [], market_id: MARKET_A }),
    );
    branchSend = jest.fn(() => of({ data: { branch_id: '11' } }));

    const moduleRef = await Test.createTestingModule({
      controllers: [
        MarketOperatorGatewayController,
        WarehouseGatewayController,
      ],
      providers: [
        { provide: 'IDENTITY', useValue: transport },
        { provide: 'CATALOG', useValue: { send: catalogSend } },
        { provide: 'BRANCH', useValue: { send: branchSend } },
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
    if (app) await app.close();
  });

  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);

  const setAccess = (user: string, id: string, body: unknown) =>
    http()
      .patch(`/market-operators/${id}/warehouse-access`)
      .set('x-test-user', user)
      .send(body as object);

  const marketStockCalls = () =>
    catalogSend.mock.calls.filter(
      ([pattern]) =>
        (pattern as { cmd: string }).cmd === WAREHOUSE_RPC.MARKET_STOCK,
    );

  it('kontrakt: identity`da handler bor; yo`l faqat MARKET', () => {
    expect(
      transport.handlers.has(
        'identity.market_operator.update_warehouse_access',
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        Object.getOwnPropertyDescriptor(
          MarketOperatorGatewayController.prototype,
          'updateWarehouseAccess',
        )?.value as object,
      ),
    ).toEqual(['market']);
  });

  it('⭐ market o`z operatoriga ochadi: javob — operator qatori; ro`yxatda maydon; jurnal yoziladi; takror — jurnalsiz', async () => {
    const before = await http()
      .get('/market-operators')
      .set('x-test-user', marketA)
      .expect(200);
    expect(before.body.data.items).toEqual([
      expect.objectContaining({
        id: OPERATOR_A,
        can_view_warehouse_stock: false,
      }),
    ]);

    const res = await setAccess(marketA, OPERATOR_A, {
      can_view_warehouse_stock: true,
    }).expect(200);
    expect(res.body.data).toMatchObject({
      id: OPERATOR_A,
      name: 'A operatori',
      phone_number: '+998905550050',
      market_id: MARKET_A,
      can_view_warehouse_stock: true,
    });
    expect(res.body.data).not.toHaveProperty('password');
    expect(activityLog.log).toHaveBeenCalledTimes(1);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'User',
        entity_id: OPERATOR_A,
        action: 'identity.market_operator_warehouse_access_changed',
        old_value: { can_view_warehouse_stock: false },
        new_value: { can_view_warehouse_stock: true },
        user_id: MARKET_A,
        metadata: { market_id: MARKET_A },
        description: `Operator #${OPERATOR_A} ga ombor qoldig'ini ko'rish ruxsati berildi`,
      }),
    );

    const list = await http()
      .get('/market-operators')
      .set('x-test-user', marketA)
      .expect(200);
    expect(list.body.data.items[0]).toMatchObject({
      id: OPERATOR_A,
      can_view_warehouse_stock: true,
    });

    await setAccess(marketA, OPERATOR_A, {
      can_view_warehouse_stock: true,
    }).expect(200);
    expect(activityLog.log).toHaveBeenCalledTimes(1);
  });

  it('⭐ begona operator — 404 (o`zgarmaydi); market emas — 403; boolean emas yoki ortiqcha maydon — 400', async () => {
    await setAccess(marketA, OPERATOR_B, {
      can_view_warehouse_stock: true,
    }).expect(404);
    expect(repo.rows.find((row) => row.id === OPERATOR_B)).toMatchObject({
      can_view_warehouse_stock: false,
    });

    for (const role of ['admin', 'superadmin', 'market_operator', 'courier']) {
      await setAccess(asUser('77', role), OPERATOR_A, {
        can_view_warehouse_stock: true,
      }).expect(403);
    }
    for (const body of [
      {},
      { can_view_warehouse_stock: 'true' },
      { can_view_warehouse_stock: 1 },
      { can_view_warehouse_stock: null },
      { can_view_warehouse_stock: true, market_id: MARKET_B },
    ]) {
      await setAccess(marketA, OPERATOR_A, body).expect(400);
    }
    await setAccess(marketA, 'abc', { can_view_warehouse_stock: true }).expect(
      400,
    );
    // Faqat begona operator so'rovi identity'ga yetdi (404); qolganlari — gateway'da.
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(activityLog.log).not.toHaveBeenCalled();
  });

  it('identity RMQ`da ham boolean majburiy (ValidationPipe yo`q yo`l) — 400', async () => {
    const handler = transport.handlers.get(
      'identity.market_operator.update_warehouse_access',
    )!;
    const error: unknown = await handler({
      id: OPERATOR_A,
      market_id: MARKET_A,
      dto: { can_view_warehouse_stock: 'yes' },
      requester: { id: MARKET_A, roles: ['market'] },
    }).catch((e: unknown) => e);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 400,
    });
  });

  it('⭐ GET /market/warehouse-stock: kalit o`chiq operator — 403 WAREHOUSE_STOCK_FORBIDDEN; yoqilgach — o`z marketi; yana o`chirilsa — 403', async () => {
    const denied = await http()
      .get('/market/warehouse-stock')
      .set('x-test-user', operatorA)
      .expect(403);
    expect(denied.body).toMatchObject({
      statusCode: 403,
      code: 'WAREHOUSE_STOCK_FORBIDDEN',
    });
    expect(marketStockCalls()).toHaveLength(0);

    await setAccess(marketA, OPERATOR_A, {
      can_view_warehouse_stock: true,
    }).expect(200);
    await http()
      .get('/market/warehouse-stock?search=shapka')
      .set('x-test-user', operatorA)
      .expect(200);
    expect(marketStockCalls()).toHaveLength(1);
    expect(marketStockCalls()[0][1]).toMatchObject({
      market_id: MARKET_A,
      query: { search: 'shapka' },
    });
    // Begona market — kalit yoqilgan bo'lsa ham 403.
    await http()
      .get(`/market/warehouse-stock?market_id=${MARKET_B}`)
      .set('x-test-user', operatorA)
      .expect(403);

    await setAccess(marketA, OPERATOR_A, {
      can_view_warehouse_stock: false,
    }).expect(200);
    await http()
      .get('/market/warehouse-stock')
      .set('x-test-user', operatorA)
      .expect(403);
    expect(marketStockCalls()).toHaveLength(1);

    // Market o'zi — kalitsiz (faqat o'zi).
    await http()
      .get('/market/warehouse-stock')
      .set('x-test-user', marketA)
      .expect(200);
  });

  it('⭐ profil (identity.user.profile): market operatorida can_view_warehouse_stock', async () => {
    const profile = transport.handlers.get('identity.user.profile')!;
    const off = (await profile({ id: OPERATOR_A })) as {
      data: Record<string, unknown>;
    };
    expect(off.data).toMatchObject({
      id: OPERATOR_A,
      can_view_warehouse_stock: false,
      market: { id: MARKET_A, name: 'Market A' },
    });
    await setAccess(marketA, OPERATOR_A, {
      can_view_warehouse_stock: true,
    }).expect(200);
    const on = (await profile({ id: OPERATOR_A })) as {
      data: Record<string, unknown>;
    };
    expect(on.data).toMatchObject({ can_view_warehouse_stock: true });
  });

  it('⭐ to`xtatilgan omborga kirim: catalog 409 → HTTP 409 `{ code: "WAREHOUSE_PAUSED" }`', async () => {
    const res = await http()
      .post('/warehouses/3/stock-in')
      .set('x-test-user', asUser('2', 'admin'))
      .set('Idempotency-Key', 'key-12345678')
      .send({ lines: [{ product_id: '9', qty: 1 }] })
      .expect(409);
    expect(res.body).toMatchObject({
      statusCode: 409,
      code: 'WAREHOUSE_PAUSED',
    });
    // Ro'yxatda yo'q maydon (warehouse_id) konvertga chiqmaydi.
    expect(res.body).not.toHaveProperty('warehouse_id');
  });

  it('PUBLIC_ERROR_CODES: ikkala kod ochiq, boshqa ombor kodlari — yo`q', () => {
    expect(publicErrorFields({ code: 'WAREHOUSE_PAUSED' })).toEqual({
      code: 'WAREHOUSE_PAUSED',
    });
    expect(publicErrorFields({ code: 'WAREHOUSE_STOCK_FORBIDDEN' })).toEqual({
      code: 'WAREHOUSE_STOCK_FORBIDDEN',
    });
    expect(publicErrorFields({ code: '23505' })).toEqual({});
  });

  it('⭐ o`qish (HTTP, haqiqiy RolesGuard): registrator — 200, scope yo`q; kuryer/market/operator/mijoz/investor — 403', async () => {
    await http()
      .get('/warehouses')
      .set('x-test-user', asUser('5', 'registrator'))
      .expect(200);
    const call = catalogSend.mock.calls.find(
      ([pattern]) =>
        (pattern as { cmd: string }).cmd === WAREHOUSE_RPC.FIND_ALL,
    );
    expect(call?.[1]).not.toHaveProperty('scope');
    expect(branchSend).not.toHaveBeenCalled();

    await http()
      .get('/warehouses/3/stock')
      .set('x-test-user', asUser('31', 'manager'))
      .expect(200);
    expect(catalogSend.mock.calls.at(-1)?.[1]).toMatchObject({
      scope: { branch_id: '11' },
    });

    for (const role of [
      'courier',
      'market',
      'market_operator',
      'customer',
      'investor',
    ]) {
      for (const path of [
        '/warehouses',
        '/warehouses/3',
        '/warehouses/3/stock',
        '/warehouses/3/movements',
        '/warehouses/3/export',
      ]) {
        await http()
          .get(path)
          .set('x-test-user', asUser('77', role))
          .expect(403);
      }
    }
    // Yozish — registratorga ham yopiq.
    await http()
      .post('/warehouses/3/stock-in')
      .set('x-test-user', asUser('5', 'registrator'))
      .set('Idempotency-Key', 'key-12345678')
      .send({ lines: [{ product_id: '9', qty: 1 }] })
      .expect(403);
  });
});
