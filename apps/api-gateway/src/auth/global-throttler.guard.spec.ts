import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  ThrottlerException,
  ThrottlerModule,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import { GlobalThrottlerGuard } from './global-throttler.guard';
import { Public } from './public.decorator';

/**
 * Global 'default' limit kaliti: kirgan foydalanuvchi — JWT `sub`; anonim,
 * login va public route'lar — IP (`CF-Connecting-IP`).
 *
 * HAQIQIY `ThrottlerStorageService` va haqiqiy imzo (JwtService) bilan.
 */

const ACCESS_KEY = 'a'.repeat(48);
const REFRESH_KEY = 'r'.repeat(48);
const LIMIT = 3;
const NAT_IP = '203.0.113.7';

class FakeController {
  list(): void {}

  @Public()
  login(): void {}
}

const handlerOf = (name: 'list' | 'login'): (() => void) =>
  Object.getOwnPropertyDescriptor(FakeController.prototype, name)
    ?.value as () => void;

type Req = {
  headers: Record<string, string | undefined>;
  ip?: string;
};

describe('GlobalThrottlerGuard', () => {
  let storage: ThrottlerStorageService;
  const access = new JwtService({ secret: ACCESS_KEY });
  const refresh = new JwtService({ secret: REFRESH_KEY });
  const res = { header: jest.fn() };

  const makeGuard = async () => {
    const guard = new GlobalThrottlerGuard(
      { throttlers: [{ name: 'default', ttl: 60_000, limit: LIMIT }] },
      storage,
      new Reflector(),
    );
    // Nest property-injection o'rniga — JwtModule'dagi AYNI kalit.
    (guard as unknown as { jwt: JwtService }).jwt = access;
    await guard.onModuleInit();
    return guard;
  };

  const ctxFor = (
    req: Req,
    handler: () => void = handlerOf('list'),
    type: 'http' | 'rpc' = 'http',
  ): ExecutionContext =>
    ({
      getType: () => type,
      getClass: () => FakeController,
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    }) as unknown as ExecutionContext;

  const bearer = (token: string, ip = NAT_IP): Req => ({
    headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': ip },
  });
  const tokenFor = (sub: string) => access.sign({ sub, roles: ['market'] });

  const hit = (guard: GlobalThrottlerGuard, req: Req, handler?: () => void) =>
    guard.canActivate(ctxFor(req, handler));
  const hitTimes = async (
    guard: GlobalThrottlerGuard,
    req: Req,
    n: number,
    handler?: () => void,
  ) => {
    for (let i = 0; i < n; i++) {
      await expect(hit(guard, req, handler)).resolves.toBe(true);
    }
  };
  const tracker = (guard: GlobalThrottlerGuard, req: Req, ctx = ctxFor(req)) =>
    (
      guard as unknown as {
        getTracker(r: Req, c: ExecutionContext): Promise<string>;
      }
    ).getTracker(req, ctx);

  beforeEach(() => {
    storage = new ThrottlerStorageService();
    res.header.mockClear();
  });

  afterEach(() => {
    storage.onApplicationShutdown();
  });

  it('bitta NAT IP ortidagi ikki operator — har biri o‘z limitida', async () => {
    const guard = await makeGuard();
    const alice = bearer(tokenFor('101'));
    const bob = bearer(tokenFor('102'));

    await hitTimes(guard, alice, LIMIT);
    await expect(hit(guard, alice)).rejects.toBeInstanceOf(ThrottlerException);

    // Xuddi o'sha IP — Bob'ning limiti butun.
    await hitTimes(guard, bob, LIMIT);
    await expect(hit(guard, bob)).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('bitta foydalanuvchi IP almashtirsa ham AYNI limitda', async () => {
    const guard = await makeGuard();
    const token = tokenFor('201');

    await hitTimes(guard, bearer(token, '198.51.100.1'), LIMIT);
    await expect(
      hit(guard, bearer(token, '198.51.100.2')),
    ).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('@Public route (login) — token bo‘lsa ham IP bo‘yicha', async () => {
    const guard = await makeGuard();
    const login = handlerOf('login');

    await expect(
      tracker(guard, bearer(tokenFor('301')), ctxFor({ headers: {} }, login)),
    ).resolves.toBe(NAT_IP);

    await hitTimes(guard, bearer(tokenFor('301')), LIMIT, login);
    // Boshqa foydalanuvchi, o'sha IP — login limiti umumiy.
    await expect(
      hit(guard, bearer(tokenFor('302')), login),
    ).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('tokensiz so‘rov — IP bo‘yicha (anonim limit saqlanadi)', async () => {
    const guard = await makeGuard();
    const anon: Req = { headers: { 'cf-connecting-ip': NAT_IP } };

    await expect(tracker(guard, anon)).resolves.toBe(NAT_IP);
    await hitTimes(guard, anon, LIMIT);
    await expect(hit(guard, anon)).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('soxta imzo, muddati o‘tgan va refresh token — IP’ga tushadi (sub soxtalashtirib bo‘lmaydi)', async () => {
    const guard = await makeGuard();
    const forged = new JwtService({ secret: 'x'.repeat(48) }).sign({
      sub: '999',
    });
    const expired = access.sign({ sub: '401' }, { expiresIn: -10 });
    const refreshToken = refresh.sign({ sub: '402' });

    for (const token of [forged, expired, refreshToken, 'not-a-jwt']) {
      await expect(tracker(guard, bearer(token))).resolves.toBe(NAT_IP);
    }

    // Har so'rovda boshqa soxta `sub` — baribir bitta IP hisoblagichi.
    for (let i = 0; i < LIMIT; i++) {
      const fake = new JwtService({ secret: 'x'.repeat(48) }).sign({
        sub: `fake-${i}`,
      });
      await expect(hit(guard, bearer(fake))).resolves.toBe(true);
    }
    await expect(hit(guard, bearer(forged))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('to‘g‘ri token — `user-<sub>` kaliti; bo‘sh sub — IP', async () => {
    const guard = await makeGuard();
    await expect(tracker(guard, bearer(tokenFor('77')))).resolves.toBe(
      'user-77',
    );
    await expect(
      tracker(guard, bearer(access.sign({ sub: '   ' }))),
    ).resolves.toBe(NAT_IP);
    await expect(
      tracker(guard, bearer(access.sign({ roles: ['admin'] }))),
    ).resolves.toBe(NAT_IP);
  });

  it('Nest DI: JwtService (JwtModule kaliti) xususiyat orqali ulanadi', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: ACCESS_KEY }),
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'default', ttl: 60_000, limit: LIMIT }],
        }),
      ],
      providers: [GlobalThrottlerGuard],
    }).compile();
    await moduleRef.init();
    try {
      const guard = moduleRef.get(GlobalThrottlerGuard);
      await expect(tracker(guard, bearer(tokenFor('di-1')))).resolves.toBe(
        'user-di-1',
      );
    } finally {
      await moduleRef.close();
    }
  });

  it('HTTP bo‘lmagan kontekst va JwtService yo‘q holat — IP (avvalgi xulq)', async () => {
    const guard = await makeGuard();
    const req = bearer(tokenFor('88'));
    await expect(
      tracker(guard, req, ctxFor(req, handlerOf('list'), 'rpc')),
    ).resolves.toBe(NAT_IP);

    (guard as unknown as { jwt?: JwtService }).jwt = undefined;
    await expect(tracker(guard, req)).resolves.toBe(NAT_IP);
  });
});
