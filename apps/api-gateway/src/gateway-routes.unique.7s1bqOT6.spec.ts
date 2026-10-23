import 'reflect-metadata';
// ⚠️ Birinchi: env ApiGatewayModule import qilinishidan OLDIN (Joi tekshiruvi).
import '../test/gateway-test-env';
import { RequestMethod, type Type } from '@nestjs/common';
import {
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  VERSION_METADATA,
} from '@nestjs/common/constants';
import { ApiGatewayModule } from './api-gateway.module';

/**
 * (7s1bqOT6) Regressiya — shlyuzda bir xil yo'lli ikkita marshrut qolmasin.
 *
 * Muammo: `LogisticsGatewayController` prefikssiz (`@Controller()`) bo'lib,
 * `@Get('health')` = `GET /health` edi — HealthController (`@Controller('health')`
 * + `@Get()`) bilan AYNAN bir xil yo'l. Express birinchi ro'yxatga olinganini
 * ishlatadi, logistics kontroller modulda oldin turgani uchun «Tizim holati»
 * gateway liveness o'rniga logistics-service javobini olardi.
 *
 * Bu test STATIK: HTTP server ko'tarilmaydi — ApiGatewayModule'dagi har
 * kontroller va handler'ning Nest metadata'sidan (`path`, `method`, versiya)
 * to'liq yo'l yig'iladi. `:id` va `:orderId` Express uchun bir xil naqsh —
 * parametr nomlari `:param` ga tenglashtiriladi. HTTP darajasidagi tekshiruv:
 * `apps/api-gateway/test/health.e2e-spec.ts` (`npm run test:e2e`).
 */

interface RouteEntry {
  key: string;
  method: string;
  path: string;
  owner: string;
}

const asArray = (value: unknown): string[] =>
  value === undefined || value === null
    ? []
    : (Array.isArray(value) ? value : [value]).map(String);

const normalizePath = (...parts: string[]) => {
  const joined = `/${parts.join('/')}`
    .replace(/\/{2,}/g, '/')
    .replace(/(.)\/$/, '$1');
  return joined.replace(/:[A-Za-z0-9_]+/g, ':param');
};

/** Kontroller (va ota-klasslari) handler'laridan to'liq marshrutlar. */
const collectRoutes = (controllers: Type[]): RouteEntry[] => {
  const routes: RouteEntry[] = [];
  for (const controller of controllers) {
    const prefixes = asArray(Reflect.getMetadata(PATH_METADATA, controller));
    const controllerVersion = asArray(
      Reflect.getMetadata(VERSION_METADATA, controller),
    );
    const seen = new Set<string>();
    let proto: object | null = controller.prototype as object;
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor' || seen.has(name)) continue;
        seen.add(name);
        // Getter'larni chaqirmaslik uchun — faqat deskriptor qiymati.
        const handler: unknown = Object.getOwnPropertyDescriptor(
          proto,
          name,
        )?.value;
        if (typeof handler !== 'function') continue;
        const paths = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          | RequestMethod
          | undefined;
        if (paths === undefined || method === undefined) continue;
        const version = asArray(
          Reflect.getMetadata(VERSION_METADATA, handler) ?? controllerVersion,
        ).join(',');
        for (const prefix of prefixes.length ? prefixes : ['']) {
          for (const path of asArray(paths)) {
            const full = normalizePath(prefix, path);
            const verb = RequestMethod[method];
            routes.push({
              key: `${verb} ${full}${version ? ` @v${version}` : ''}`,
              method: verb,
              path: full,
              owner: `${controller.name}.${name}`,
            });
          }
        }
      }
      proto = Object.getPrototypeOf(proto) as object | null;
    }
  }
  return routes;
};

describe('7s1bqOT6 — shlyuz marshrutlari takrorlanmaydi (statik)', () => {
  let routes: RouteEntry[];

  beforeAll(() => {
    const controllers = (Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      ApiGatewayModule,
    ) ?? []) as Type[];
    routes = collectRoutes(controllers);
  });

  it("modulda kontrollerlar va marshrutlar o'qildi", () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.map((r) => r.owner)).toContain('HealthController.check');
  });

  it("bir xil (metod + yo'l) ikki handler'da YO'Q", () => {
    const byKey = new Map<string, string[]>();
    for (const route of routes) {
      byKey.set(route.key, [...(byKey.get(route.key) ?? []), route.owner]);
    }
    const duplicates = [...byKey.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([key, owners]) => `${key} ← ${owners.join(' + ')}`);
    expect(duplicates).toEqual([]);
  });

  it('GET /health — faqat HealthController (gateway liveness)', () => {
    const owners = routes
      .filter((r) => r.method === 'GET' && r.path === '/health')
      .map((r) => r.owner);
    expect(owners).toEqual(['HealthController.check']);
  });

  it('GET /health/readiness — faqat HealthController.readiness', () => {
    const owners = routes
      .filter((r) => r.method === 'GET' && r.path === '/health/readiness')
      .map((r) => r.owner);
    expect(owners).toEqual(['HealthController.readiness']);
  });

  it("servis health'lari o'z prefiksida: har `…/health` yo'li yagona", () => {
    const health = routes.filter(
      (r) => r.method === 'GET' && /\/health$/.test(r.path),
    );
    const paths = health.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      health.find((r) => r.owner === 'LogisticsGatewayController.health')?.path,
    ).toBe('/logistics/health');
  });
});
