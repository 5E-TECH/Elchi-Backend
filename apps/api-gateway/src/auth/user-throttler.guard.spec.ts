import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  Throttle,
  ThrottlerException,
  ThrottlerModule,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import {
  AI_USER_THROTTLER_NAME,
  UserThrottlerGuard,
} from './user-throttler.guard';

/**
 * ai-parse per-foydalanuvchi limiti (Gy8Lt6KT #5-7, NsxoDSmm #9).
 *
 * HAQIQIY `ThrottlerStorageService` bilan — soxta hisoblagich emas: 11-so'rov
 * haqiqatan 429 (ThrottlerException) beradimi, shu tekshiriladi.
 */

// Route'ga ATAYLAB katta 'default' limiti qo'yilgan — guard uni o'qimasligi
// (o'z 'ai-user' limitini ishlatishi) shu bilan isbotlanadi.
class FakeOrderController {
  @Throttle({ default: { limit: 1000, ttl: 60_000 } })
  aiParse(): void {}

  otherRoute(): void {}
}

type Req = {
  user?: { sub?: unknown } | null;
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
};

describe('UserThrottlerGuard', () => {
  let storage: ThrottlerStorageService;
  let reflector: Reflector;

  const makeGuard = async (env: Record<string, unknown> = {}) => {
    const guard = new UserThrottlerGuard(
      { throttlers: [{ name: 'default', ttl: 60_000, limit: 60 }] },
      storage,
      reflector,
    );
    // Nest property-injection o'rniga — ConfigService'ning soxta nusxasi.
    (guard as unknown as { config: { get: (k: string) => unknown } }).config = {
      get: (key: string) => env[key],
    };
    await guard.onModuleInit();
    return guard;
  };

  /** Route handler (metama'lumoti bilan) — `this` siz, faqat kalit uchun. */
  const handlerOf = (name: 'aiParse' | 'otherRoute'): (() => void) =>
    Object.getOwnPropertyDescriptor(FakeOrderController.prototype, name)
      ?.value as () => void;

  const res = { header: jest.fn() };
  const ctxFor = (
    req: Req,
    handler: () => void = handlerOf('aiParse'),
  ): ExecutionContext =>
    ({
      getClass: () => FakeOrderController,
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    }) as unknown as ExecutionContext;

  const hit = (guard: UserThrottlerGuard, req: Req, handler?: () => void) =>
    guard.canActivate(ctxFor(req, handler));

  const hitTimes = async (guard: UserThrottlerGuard, req: Req, n: number) => {
    for (let i = 0; i < n; i++) {
      await expect(hit(guard, req)).resolves.toBe(true);
    }
  };

  beforeEach(() => {
    storage = new ThrottlerStorageService();
    reflector = new Reflector();
    res.header.mockClear();
  });

  afterEach(() => {
    // Xotiradagi hisoblagich taymerlarini tozalaymiz (jest ochiq handle qoldirmasin).
    storage.onApplicationShutdown();
  });

  it('Gy8Lt6KT #5 / NsxoDSmm #9: bitta foydalanuvchining 1-10 so‘rovi o‘tadi, 11-si ThrottlerException (429)', async () => {
    const guard = await makeGuard();
    const req: Req = {
      user: { sub: '42' },
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    };

    await hitTimes(guard, req, 10);
    await expect(hit(guard, req)).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('Gy8Lt6KT #6 / NsxoDSmm #9: bitta IP ortidagi ikki foydalanuvchi ALOHIDA sanaladi', async () => {
    const guard = await makeGuard();
    const headers = { 'cf-connecting-ip': '198.51.100.20' };
    const alice: Req = { user: { sub: '1' }, headers };
    const bob: Req = { user: { sub: '2' }, headers };

    await hitTimes(guard, alice, 10);
    await expect(hit(guard, alice)).rejects.toBeInstanceOf(ThrottlerException);

    // Xuddi o'sha NAT IP — lekin Bob'ning limiti butun.
    await hitTimes(guard, bob, 10);
    await expect(hit(guard, bob)).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('Gy8Lt6KT #7: JWT bo‘lmasa cf-connecting-ip ga, u ham bo‘lmasa req.ip ga qaytadi', async () => {
    const guard = await makeGuard();
    const withTracker = guard as unknown as {
      getTracker(req: Req): Promise<string>;
    };
    const tracker = (req: Req) => withTracker.getTracker(req);

    await expect(
      tracker({ user: { sub: '7' }, headers: {}, ip: '10.0.0.1' }),
    ).resolves.toBe('user-7');
    await expect(
      tracker({
        user: null,
        headers: { 'cf-connecting-ip': '203.0.113.9' },
        ip: '10.0.0.1',
      }),
    ).resolves.toBe('203.0.113.9');
    await expect(
      tracker({ user: { sub: '   ' }, headers: {}, ip: '10.0.0.2' }),
    ).resolves.toBe('10.0.0.2');
    await expect(tracker({ headers: {}, ip: '10.0.0.3' })).resolves.toBe(
      '10.0.0.3',
    );
  });

  it('Gy8Lt6KT #7: JWT siz so‘rovlar IP bo‘yicha sanaladi va guard ishlayveradi', async () => {
    const guard = await makeGuard();
    const anonymous: Req = { headers: { 'cf-connecting-ip': '203.0.113.50' } };

    await hitTimes(guard, anonymous, 10);
    await expect(hit(guard, anonymous)).rejects.toBeInstanceOf(
      ThrottlerException,
    );
    // Boshqa IP — o'z limiti.
    await expect(hit(guard, { headers: {}, ip: '10.9.9.9' })).resolves.toBe(
      true,
    );
  });

  it("route'dagi @Throttle({ default }) metama'lumotini o'qimaydi — faqat 'ai-user' limiti", async () => {
    const reflectorSpy = jest.spyOn(reflector, 'getAllAndOverride');
    const guard = await makeGuard();
    const req: Req = { user: { sub: '99' }, headers: {} };

    // Route'da default limit 1000, lekin 11-so'rov baribir bloklanadi.
    await hitTimes(guard, req, 10);
    await expect(hit(guard, req)).rejects.toBeInstanceOf(ThrottlerException);
    expect(reflectorSpy).not.toHaveBeenCalled();

    // Sarlavhalar 'ai-user' nomi bilan — global 'default' ga aralashmaydi.
    expect(res.header).toHaveBeenCalledWith(
      `X-RateLimit-Limit-${AI_USER_THROTTLER_NAME}`,
      10,
    );
  });

  it('AI_PARSE_THROTTLE_LIMIT / AI_PARSE_THROTTLE_TTL_MS env orqali sozlanadi', async () => {
    const guard = await makeGuard({
      AI_PARSE_THROTTLE_LIMIT: 3,
      AI_PARSE_THROTTLE_TTL_MS: '120000',
    });
    const req: Req = { user: { sub: '5' }, headers: {} };
    const incrementSpy = jest.spyOn(storage, 'increment');

    await hitTimes(guard, req, 3);
    await expect(hit(guard, req)).rejects.toBeInstanceOf(ThrottlerException);
    expect(incrementSpy).toHaveBeenCalledWith(
      expect.any(String),
      120_000,
      3,
      120_000,
      AI_USER_THROTTLER_NAME,
    );
  });

  it("noto'g'ri env qiymatida sukut (10 / 60000) ishlatiladi", async () => {
    const guard = await makeGuard({
      AI_PARSE_THROTTLE_LIMIT: 'abc',
      AI_PARSE_THROTTLE_TTL_MS: 5,
    });
    const incrementSpy = jest.spyOn(storage, 'increment');

    await hit(guard, { user: { sub: '6' }, headers: {} });
    expect(incrementSpy).toHaveBeenCalledWith(
      expect.any(String),
      60_000,
      10,
      60_000,
      AI_USER_THROTTLER_NAME,
    );
  });

  it('hisoblagich route bo‘yicha alohida — boshqa route limitni yemaydi', async () => {
    const guard = await makeGuard();
    const req: Req = { user: { sub: '77' }, headers: {} };

    await hitTimes(guard, req, 10);
    await expect(hit(guard, req)).rejects.toBeInstanceOf(ThrottlerException);
    await expect(hit(guard, req, handlerOf('otherRoute'))).resolves.toBe(true);
  });

  it('Nest DI: ConfigService xususiyat orqali ulanadi (AI_PARSE_THROTTLE_LIMIT=2)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ AI_PARSE_THROTTLE_LIMIT: 2 })],
        }),
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'default', ttl: 60_000, limit: 60 }],
        }),
      ],
      providers: [UserThrottlerGuard],
    }).compile();
    await moduleRef.init();
    try {
      const guard = moduleRef.get(UserThrottlerGuard);
      const req: Req = { user: { sub: 'di-1' }, headers: {} };

      await hitTimes(guard, req, 2);
      await expect(hit(guard, req)).rejects.toBeInstanceOf(ThrottlerException);
    } finally {
      await moduleRef.close();
    }
  });
});
