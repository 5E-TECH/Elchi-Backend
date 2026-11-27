import 'reflect-metadata';
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CarrierApiKeyGuard } from './auth/carrier-api-key.guard';
import { CarrierThrottlerGuard } from './auth/carrier-throttler.guard';
import { IS_PUBLIC_KEY } from './auth/public.decorator';
import { CarrierAuthGatewayController } from './carrier-auth-gateway.controller';
import { CarrierGatewayController } from './carrier-gateway.controller';
import { CarrierOlchaExceptionFilter } from './carrier-olcha-compat';
import { CarrierOlchaRootGatewayController } from './carrier-olcha-root-gateway.controller';

/**
 * Olcha'dagi kabi prefikssiz `/auth/token`, `/qrorder/find` — `/carrier/...`
 * bilan AYNI kirish, limit va xato filtri (metadata darajasida). HTTP
 * xatti-harakati: `carrier-olcha-http.spec.ts`; Swagger: `carrier-swagger.spec.ts`.
 */
type Ctor = { prototype: object; name: string };

const handlerOf = (cls: Ctor, name: string): object => {
  const fn = (cls.prototype as Record<string, unknown>)[name];
  if (typeof fn !== 'function') throw new Error(`${cls.name}.${name} yo'q`);
  return fn;
};

/** Nest qanday o'qisa shunday: metod, keyin klass (`getAllAndOverride`). */
const effective = (cls: Ctor, name: string, key: string): unknown =>
  Reflect.getMetadata(key, handlerOf(cls, name)) ??
  Reflect.getMetadata(key, cls);

/** Guardlar: klass + metod (Nest ikkalasini ham ishlatadi). */
const guards = (cls: Ctor, name: string): unknown[] => [
  ...((Reflect.getMetadata(GUARDS_METADATA, cls) as unknown[]) ?? []),
  ...((Reflect.getMetadata(GUARDS_METADATA, handlerOf(cls, name)) as
    unknown[] | undefined) ?? []),
];

/** Xato filtrlari: klass + metod, `{turi, rejimi}`. */
const filters = (cls: Ctor, name: string) =>
  [
    ...((Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, cls) as unknown[]) ??
      []),
    ...((Reflect.getMetadata(
      EXCEPTION_FILTERS_METADATA,
      handlerOf(cls, name),
    ) as unknown[] | undefined) ?? []),
  ].map((filter) => ({
    type: (filter as object).constructor,
    mode: (filter as { mode?: unknown }).mode,
  }));

/** `@Throttle` qiymatlari (resolvable — env bilan hisoblanadi). */
const throttle = (cls: Ctor, name: string) => {
  const value = (key: string): unknown => {
    const raw = effective(cls, name, key);
    return typeof raw === 'function' ? (raw as () => unknown)() : raw;
  };
  return {
    limit: value('THROTTLER:LIMITdefault'),
    ttl: value('THROTTLER:TTLdefault'),
  };
};

const ROOT = CarrierOlchaRootGatewayController;

describe('Olcha manzili (prefikssiz) = /carrier/... — metadata', () => {
  const pairs: Array<[string, Ctor, string, Ctor, string]> = [
    ['auth/token', CarrierAuthGatewayController, 'token', ROOT, 'token'],
    [
      'qrorder/find',
      CarrierGatewayController,
      'qrOrderFind',
      ROOT,
      'qrOrderFind',
    ],
  ];

  it.each(pairs)(
    '⭐ %s: yo‘l, metod, HTTP kodi, guard, @Public, filtr, limit — AYNI',
    (path, carrierCls, carrierFn, rootCls, rootFn) => {
      // Yo'l: `/carrier` + path va `/` + path.
      expect(Reflect.getMetadata(PATH_METADATA, carrierCls)).toBe('carrier');
      expect(Reflect.getMetadata(PATH_METADATA, rootCls)).toBe('/');
      for (const [cls, fn] of [
        [carrierCls, carrierFn],
        [rootCls, rootFn],
      ] as const) {
        expect(Reflect.getMetadata(PATH_METADATA, handlerOf(cls, fn))).toBe(
          path,
        );
        expect(Reflect.getMetadata(METHOD_METADATA, handlerOf(cls, fn))).toBe(
          RequestMethod.POST,
        );
        expect(
          Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf(cls, fn)),
        ).toBe(200);
        expect(effective(cls, fn, IS_PUBLIC_KEY)).toBe(true);
      }
      expect(guards(rootCls, rootFn)).toEqual(guards(carrierCls, carrierFn));
      expect(filters(rootCls, rootFn)).toEqual(filters(carrierCls, carrierFn));
      expect(throttle(rootCls, rootFn)).toEqual(
        throttle(carrierCls, carrierFn),
      );
    },
  );

  it('⭐ qrorder/find: CarrierApiKeyGuard + akkaunt limiti, Olcha `result` filtri', () => {
    expect(guards(ROOT, 'qrOrderFind')).toEqual([
      CarrierApiKeyGuard,
      CarrierThrottlerGuard,
    ]);
    expect(filters(ROOT, 'qrOrderFind')).toEqual([
      { type: CarrierOlchaExceptionFilter, mode: 'result' },
    ]);
  });

  it('⭐ auth/token: guardsiz (o‘zi tekshiradi), Olcha `auth` filtri, IP limiti 20/min', () => {
    const saved = process.env.CARRIER_AUTH_THROTTLE_LIMIT;
    delete process.env.CARRIER_AUTH_THROTTLE_LIMIT;
    try {
      expect(guards(ROOT, 'token')).toEqual([]);
      expect(filters(ROOT, 'token')).toEqual([
        { type: CarrierOlchaExceptionFilter, mode: 'auth' },
      ]);
      expect(throttle(ROOT, 'token')).toEqual({ limit: 20, ttl: 60_000 });
    } finally {
      if (saved === undefined) delete process.env.CARRIER_AUTH_THROTTLE_LIMIT;
      else process.env.CARRIER_AUTH_THROTTLE_LIMIT = saved;
    }
  });

  it('prefikssiz controller faqat ikki yo‘l ochadi (boshqa /carrier/* emas)', () => {
    const routes = Object.getOwnPropertyNames(ROOT.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        Reflect.hasMetadata(METHOD_METADATA, handlerOf(ROOT, name)),
    );
    expect(routes.sort()).toEqual(['qrOrderFind', 'token']);
  });

  it('api-gateway.module.ts controllerni ro‘yxatga oladi', () => {
    const moduleSrc = readFileSync(
      join(__dirname, 'api-gateway.module.ts'),
      'utf8',
    );
    expect(moduleSrc).toMatch(/^\s+CarrierOlchaRootGatewayController,$/m);
  });
});
