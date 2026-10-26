import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ExecutionContext,
  INestApplication,
  RequestMethod,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { IS_PUBLIC_KEY } from './auth/public.decorator';
import { ROLES_KEY } from './auth/roles.decorator';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { AnalyticsGatewayController } from './analytics-gateway.controller';
import { FinanceGatewayController } from './finance-gateway.controller';
import { InvestorGatewayController } from './investor-gateway.controller';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * gShYHHGj — RBAC regressiya darvozasi (ega LG-S1: «logist moliyaga
 * aralashmaydi») + xavfsizlik tekshiruvi 2026-10-23 P2·A.
 *
 * Marshrutlar QO'LDA yozilmaydi: `api-gateway.module.ts` dagi `controllers`
 * ro'yxatidagi har bir kontroller Nest metadata'sidan (PATH/METHOD, @Roles,
 * @Public, @UseGuards) o'qiladi. Yangi marshrut qo'shilsa test uni o'zi
 * qamrab oladi:
 *   • @Roles'siz marshrut — faqat quyidagi ANIQ oq ro'yxatda bo'lsa o'tadi
 *     (yangisi qo'shilsa CI yiqiladi; ro'yxatdagi eskirgan yozuv ham);
 *   • @Roles'li marshrutda RolesGuard bo'lishi shart (aks holda @Roles
 *     hech narsani yopmaydi);
 *   • moliya marshrutlari (finance/*, kassa, settlement, to'lovlar, investor,
 *     analytics daromad/dashboard, ai-usage) — LOGIST ro'yxatda YO'Q va
 *     LOGIST tokeni bilan HAQIQIY HTTP so'rov 403 (servis chaqirilmaydi).
 */

type ControllerClass = { name: string; prototype: object };

type RouteInfo = {
  key: string; // 'GET /finance/history'
  controller: string;
  handler: string;
  roles: string[] | null;
  isPublic: boolean;
  guards: string[];
  method: string;
  path: string;
};

const SRC = __dirname;

const registeredControllerNames = (): Set<string> => {
  const moduleSrc = readFileSync(join(SRC, 'api-gateway.module.ts'), 'utf8');
  const start = moduleSrc.indexOf('controllers: [');
  const end = moduleSrc.indexOf('providers: [', start);
  const block = moduleSrc.slice(start, end).replace(/\/\/.*$/gm, '');
  return new Set(block.match(/\b[A-Z][A-Za-z0-9]*Controller\b/g) ?? []);
};

const controllerFiles = (dir: string, acc: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      controllerFiles(full, acc);
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.spec.ts') &&
      readFileSync(full, 'utf8').includes('@Controller(')
    ) {
      acc.push(full);
    }
  }
  return acc;
};

const normalizeRoles = (roles: unknown): string[] | null =>
  Array.isArray(roles) && roles.length
    ? roles.map((role) => String(role).toLowerCase())
    : null;

const guardNames = (target: object): string[] =>
  ((Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? []).map(
    (guard) =>
      typeof guard === 'function'
        ? guard.name
        : String(
            (guard as { constructor?: { name?: string } } | null)?.constructor
              ?.name,
          ),
  );

const joinPath = (base: string, sub: string): string => {
  const full =
    `/${[base, sub].filter((part) => part && part !== '/').join('/')}`
      .replace(/\/+/g, '/')
      .replace(/\/$/, '');
  return full || '/';
};

function collectGatewayRoutes(): {
  routes: RouteInfo[];
  controllers: Map<string, ControllerClass>;
  registered: Set<string>;
} {
  const registered = registeredControllerNames();
  const controllers = new Map<string, ControllerClass>();
  for (const file of controllerFiles(SRC)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (
        typeof value === 'function' &&
        registered.has(name) &&
        Reflect.hasMetadata(PATH_METADATA, value)
      ) {
        controllers.set(name, value as unknown as ControllerClass);
      }
    }
  }

  const routes: RouteInfo[] = [];
  for (const [name, cls] of controllers) {
    const basePaths = ([] as unknown[]).concat(
      Reflect.getMetadata(PATH_METADATA, cls) ?? '',
    );
    const classRoles = normalizeRoles(Reflect.getMetadata(ROLES_KEY, cls));
    const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, cls) === true;
    const classGuards = guardNames(cls);
    const proto = cls.prototype as Record<string, unknown>;
    for (const handler of Object.getOwnPropertyNames(proto)) {
      const fn = proto[handler];
      if (
        handler === 'constructor' ||
        typeof fn !== 'function' ||
        !Reflect.hasMetadata(METHOD_METADATA, fn)
      ) {
        continue;
      }
      const methodCode: RequestMethod = Reflect.getMetadata(
        METHOD_METADATA,
        fn,
      );
      const method: string = RequestMethod[methodCode];
      const subPaths = ([] as unknown[]).concat(
        Reflect.getMetadata(PATH_METADATA, fn) ?? '',
      );
      const roles =
        normalizeRoles(Reflect.getMetadata(ROLES_KEY, fn)) ?? classRoles;
      const handlerPublic = Reflect.getMetadata(IS_PUBLIC_KEY, fn) as
        | boolean
        | undefined;
      for (const base of basePaths) {
        for (const sub of subPaths) {
          const path = joinPath(
            typeof base === 'string' ? base : '',
            typeof sub === 'string' ? sub : '',
          );
          routes.push({
            key: `${method} ${path}`,
            controller: name,
            handler,
            roles,
            isPublic: handlerPublic ?? classPublic,
            guards: [...classGuards, ...guardNames(fn)],
            method,
            path,
          });
        }
      }
    }
  }
  routes.sort((a, b) => a.key.localeCompare(b.key));
  return { routes, controllers, registered };
}

/**
 * P2·A — @Roles'SIZ marshrutlarning ANIQ oq ro'yxati (2026-10-26 holati).
 * Bular RolesGuard'siz: JWT bo'lsa (yoki @Public / API-kalit / HMAC) har
 * qanday rol kiradi, doira servisda yoki marshrut rolga bog'liq emas.
 * Yangi @Roles'siz marshrut qo'shish — shu ro'yxatga ONGLI qo'shish va
 * kod-review talab qiladi.
 */
const NO_ROLES_WHITELIST: readonly string[] = [
  // Auth: login/refresh/OTP — ochiq; profil/sessiyalar — o'z hisobi.
  'DELETE /auth/sessions/:id',
  'GET /auth/my-profile',
  'GET /auth/sessions',
  'GET /auth/validate',
  'PATCH /auth/my-profile',
  'PATCH /auth/my-settings',
  'POST /auth/login',
  'POST /auth/logout',
  'POST /auth/otp/request',
  'POST /auth/otp/verify',
  'POST /auth/refresh',
  'POST /auth/sessions/revoke-others',
  'POST /auth/telegram',
  // Inbox / push / bildirishnoma sozlamalari — faqat o'z yozuvlari.
  'DELETE /notifications/inbox/:id',
  'DELETE /notifications/push/subscribe',
  'GET /notifications/inbox',
  'GET /notifications/inbox/:id',
  'GET /notifications/inbox/counts',
  'GET /notifications/inbox/unread-count',
  'GET /notifications/preferences',
  'GET /notifications/push/public-key',
  'GET /notifications/types',
  'PATCH /notifications/inbox/:id/read',
  'PATCH /notifications/inbox/read-all',
  'PATCH /notifications/preferences',
  'POST /notifications/push/subscribe',
  'POST /notifications/telegram/link',
  // Fayllar — kalit bo'yicha (servisda egasi tekshiriladi), view — ochiq.
  // POST /files/upload|qr|pdf endi @Roles bilan (dgvwZasd) — ro'yxatda yo'q.
  'GET /files/:key',
  'GET /files/:key/content',
  // kiZgTybn — smena rasmi/hisoboti: ochiq, lekin 300 s shifrlangan token.
  'GET /files/signed/:token',
  'GET /files/view/:key',
  // Skan / qidiruv / buyurtma ro'yxati — doira servis + gateway proyeksiyasi.
  'GET /orders',
  'GET /orders/:id',
  'GET /orders/courier/orders',
  'GET /orders/status-counts',
  'GET /scan/:token',
  'POST /scan/market-cancelled',
  'GET /search',
  // Telegram bog'lash (o'z hisobi) va webhook (HMAC / secret).
  'DELETE /users/me/telegram',
  'POST /telegram/link-code',
  'POST /telegram/webhook/:botSlug',
  'POST /users/me/telegram/link-code',
  'POST /webhooks/:slug',
  'POST /webhooks/sms/:provider',
  'GET /sms/stop/:token',
  // Partner API — o'z API-kalit guard'i (PartnerApiKeyGuard).
  'GET /partner/districts',
  'GET /partner/ping',
  'GET /partner/regions',
  'GET /partner/shipments/:id',
  'GET /partner/tariff',
  'PATCH /partner/shipments/:id',
  'POST /partner/markets',
  'POST /partner/shipments',
  'POST /partner/shipments/:id/cancel',
  'POST /partner/shipments/status',
  // Ochiq narx kalkulyatori (mSkzzNBJ).
  'GET /public/delivery-tariffs',
  'POST /public/delivery-quote',
  // Health / texnik.
  'GET /',
  'GET /finance/health',
  'GET /health',
  'GET /health/readiness',
  'GET /logistics/health',
  'GET /notifications/health',
  'GET /product/health',
  'GET /search/health',
  'POST /client-errors',
  'POST /csp-report',
];

/** LOGIST moliya yopiqligi qamrovi — yo'l naqshi (kontrollerdan qat'i nazar). */
const FINANCE_PATH_RE =
  /^\/(finance|investors|investments|profits|analytics|ai-usage)(\/|$)|cashbox|settlement|payment|salary|revenue/i;
/** Moliya bo'lmagan, lekin naqshga tushadigan texnik yo'l. */
const FINANCE_PATH_EXCEPTIONS = new Set(['GET /finance/health']);

describe('gShYHHGj — gateway RBAC xaritasi (metadata’dan avtomatik)', () => {
  const { routes, controllers, registered } = collectGatewayRoutes();

  it('modulda ro‘yxatdagi HAR bir kontroller topildi (test soxta emas)', () => {
    expect(controllers.size).toBe(registered.size);
    expect(controllers.has('FinanceGatewayController')).toBe(true);
    expect(routes.length).toBeGreaterThan(300);
  });

  it('marshrut kalitlari takrorlanmaydi (bir xil METHOD path ikki handler’da yo‘q)', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const route of routes) {
      const owner = `${route.controller}.${route.handler}`;
      const previous = seen.get(route.key);
      if (previous && previous !== owner)
        duplicates.push(`${route.key} (${previous} / ${owner})`);
      seen.set(route.key, owner);
    }
    expect(duplicates).toEqual([]);
  });

  it('P2·A: @Roles’siz marshrutlar — FAQAT aniq oq ro‘yxat (yangi qo‘shilsa CI yiqiladi)', () => {
    const withoutRoles = routes
      .filter((route) => route.roles === null)
      .map((route) => route.key)
      .sort();
    const whitelist = [...NO_ROLES_WHITELIST].sort();
    const unexpected = withoutRoles.filter((key) => !whitelist.includes(key));
    const stale = whitelist.filter((key) => !withoutRoles.includes(key));
    expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] });
  });

  it('@Roles’li har bir marshrutda RolesGuard bor (aks holda @Roles hech narsani yopmaydi)', () => {
    const missing = routes
      .filter(
        (route) => route.roles !== null && !route.guards.includes('RolesGuard'),
      )
      .map((route) => `${route.key} (${route.controller}.${route.handler})`);
    expect(missing).toEqual([]);
  });

  it('@Public marshrutlar faqat oq ro‘yxatda (JWT’siz yo‘l yashirincha qo‘shilmaydi)', () => {
    const publicRoutes = routes
      .filter((route) => route.isPublic)
      .map((route) => route.key);
    expect(
      publicRoutes.filter((key) => !NO_ROLES_WHITELIST.includes(key)),
    ).toEqual([]);
  });

  describe('LOGIST — moliya yopiq (ega LG-S1)', () => {
    const financeRoutes = routes.filter(
      (route) =>
        !FINANCE_PATH_EXCEPTIONS.has(route.key) &&
        (FINANCE_PATH_RE.test(route.path) ||
          route.controller === 'FinanceGatewayController' ||
          route.controller === 'InvestorGatewayController' ||
          route.controller === 'AnalyticsGatewayController'),
    );

    it('qamrov: finance/*, kassa, settlement, to‘lovlar, investor, analytics, ai-usage', () => {
      const keys = financeRoutes.map((route) => route.key);
      expect(financeRoutes.length).toBeGreaterThan(90);
      for (const expected of [
        'GET /finance/history',
        'GET /finance/history/daily',
        'GET /finance/financial-balance/daily',
        'GET /finance/cashbox/payments-meta',
        'GET /finance/cashbox/financial-balanse',
        'POST /finance/cashbox/payment/market',
        'GET /analytics/revenue',
        'GET /analytics/dashboard',
        'GET /investors',
        'POST /orders/settlement/hq-to-market',
        'GET /orders/:id/settlement',
        'GET /export/cashbox-history.xlsx',
        'GET /integrations/payments',
      ]) {
        expect(keys).toContain(expected);
      }
    });

    it('hech bir moliya marshrutining @Roles’ida LOGIST yo‘q va @Roles + RolesGuard bor', () => {
      const offenders = financeRoutes
        .filter(
          (route) =>
            route.roles === null ||
            route.roles.includes('logist') ||
            !route.guards.includes('RolesGuard'),
        )
        .map((route) => `${route.key} roles=${JSON.stringify(route.roles)}`);
      expect(offenders).toEqual([]);
    });
  });
});

/**
 * HAQIQIY HTTP: LOGIST tokeni bilan har bir moliya marshruti 403, RMQ
 * mijozi chaqirilmaydi. Ro'yxat — yuqoridagi metadata to'plami (kontroller
 * bo'yicha), qo'lda yozilmagan.
 */
describe('gShYHHGj — LOGIST tokeni bilan moliya marshrutlari → 403 (HTTP)', () => {
  const { routes } = collectGatewayRoutes();
  const logistGuard = {
    canActivate: (ctx: ExecutionContext) => {
      const req = ctx
        .switchToHttp()
        .getRequest<{ headers: Record<string, string>; user?: unknown }>();
      req.user = {
        sub: '77',
        username: 'logist',
        roles: [req.headers['x-test-role'] ?? 'logist'],
        branch_id: null,
      };
      return true;
    },
  };
  const send = jest.fn(() => of({ statusCode: 200, data: {} }));
  const client = { send, emit: jest.fn(() => of(undefined)) };
  let app: INestApplication;

  const httpTargets = routes.filter(
    (route) =>
      route.key !== 'GET /finance/health' &&
      (route.controller === 'FinanceGatewayController' ||
        route.controller === 'InvestorGatewayController' ||
        route.controller === 'AnalyticsGatewayController' ||
        (route.controller === 'OrderGatewayController' &&
          /settlement/.test(route.path))),
  );

  beforeAll(async () => {
    const providers = [
      'FINANCE',
      'IDENTITY',
      'BRANCH',
      'ORDER',
      'FILE',
      'AI',
      'INVESTOR',
      'ANALYTICS',
      'LOGISTICS',
      'CATALOG',
      'NOTIFICATION',
      'INTEGRATION',
      'SEARCH',
    ].map((token) => ({ provide: token, useValue: client }));
    const moduleRef = await Test.createTestingModule({
      controllers: [
        FinanceGatewayController,
        InvestorGatewayController,
        AnalyticsGatewayController,
        OrderGatewayController,
      ],
      providers,
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(logistGuard)
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('qamrov: finance-gateway’ning BARCHA marshrutlari (+ investor, analytics, settlement)', () => {
    const financeCount = routes.filter(
      (route) => route.controller === 'FinanceGatewayController',
    ).length;
    expect(
      httpTargets.filter(
        (route) => route.controller === 'FinanceGatewayController',
      ).length,
    ).toBe(financeCount - 1); // − /finance/health (ochiq, ma'lumotsiz)
    expect(httpTargets.length).toBeGreaterThan(90);
  });

  it('har bir marshrut: logist → 403, servis chaqirilmaydi', async () => {
    const failures: string[] = [];
    for (const route of httpTargets) {
      send.mockClear();
      const url = route.path.replace(/:[A-Za-z_]+/g, '1');
      const method = route.method.toLowerCase() as
        | 'get'
        | 'post'
        | 'patch'
        | 'put'
        | 'delete';
      const res = await request(
        app.getHttpServer() as Parameters<typeof request>[0],
      )
        [method](url)
        .set('x-test-role', 'logist')
        .send({});
      if (res.status !== 403 || send.mock.calls.length > 0) {
        failures.push(
          `${route.key} → ${res.status} (rpc: ${send.mock.calls.length})`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('nazorat: o‘sha guard bilan superadmin 403 OLMAYDI (test soxta emas)', async () => {
    const res = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    )
      .get('/finance/cashbox/financial-balanse')
      .set('x-test-role', 'superadmin');
    expect(res.status).not.toBe(403);
    expect(send).toHaveBeenCalled();
  });
});
