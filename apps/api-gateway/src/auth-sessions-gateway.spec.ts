import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { of } from 'rxjs';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { AuthGatewayController } from './auth-gateway.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { JwtStrategy } from './auth/jwt.strategy';
import { SessionRevocationService } from './auth/session-revocation.service';
import { IS_PUBLIC_KEY } from './auth/public.decorator';
import { collectRouteRoles } from './auth/route-roles';

/**
 * (Elchi Pochta #3 — "Sessionlar bo'limi") gateway:
 *  - `GET /auth/sessions` — har qanday autentifikatsiyadan o'tgan rol, kim —
 *    FAQAT JWT `sub` dan (so'rovdagi user_id e'tiborsiz), joriy sessiya —
 *    JWT `sid`;
 *  - `POST /auth/logout` — identity'ga `sid` va shu brauzerning refresh
 *    cookie'si boradi (faqat joriy sessiya yopiladi), cookie tozalanadi;
 *  - login/refresh cookie xulqi O'ZGARMAGAN (httpOnly, path=/auth,
 *    refresh rotatsiya qilinmaydi).
 */
const SID = '3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d';

describe('Elchi Pochta #3 — auth sessiyalari (gateway)', () => {
  let app: INestApplication;
  const identitySend = jest.fn();
  let user: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [AuthGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: { send: identitySend } },
        Reflector,
        SessionRevocationService,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const isPublic =
            Reflect.getMetadata(IS_PUBLIC_KEY, ctx.getHandler()) === true;
          if (isPublic) return true;
          if (!user) return false;
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            ...user,
          };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  type Call = [{ cmd: string }, Record<string, unknown>];
  const lastCall = () => identitySend.mock.calls.at(-1) as Call;
  const setCookies = (res: request.Response): string[] => {
    const raw = res.headers['set-cookie'] as string[] | string | undefined;
    return Array.isArray(raw) ? raw : raw ? [raw] : [];
  };

  beforeEach(() => {
    user = { sub: '25', username: null, roles: ['courier'], sid: SID };
    identitySend.mockReset().mockReturnValue(
      of({
        statusCode: 200,
        message: 'success',
        data: { active_count: 1, sessions: [] },
      }),
    );
  });

  it('⭐ GET /auth/sessions — identity.auth.sessions, kim JWT’dan; so‘rovdagi user_id qabul qilinmaydi', async () => {
    const res = await request(http())
      .get('/auth/sessions?user_id=99&userId=99')
      .expect(200);

    expect(res.body).toEqual({
      statusCode: 200,
      message: 'success',
      data: { active_count: 1, sessions: [] },
    });
    const [pattern, payload] = lastCall();
    expect(pattern).toEqual({ cmd: 'identity.auth.sessions' });
    expect(payload).toEqual({ userId: '25', sessionId: SID });
  });

  it('GET /auth/sessions — `sid` siz token (Telegram / deploy’dan oldingi) → sessionId null', async () => {
    user = { sub: '37', roles: ['market'], auth: 'telegram' };
    await request(http()).get('/auth/sessions').expect(200);
    expect(lastCall()[1]).toEqual({ userId: '37', sessionId: null });
  });

  it('GET /auth/sessions — autentifikatsiyasiz kirib bo‘lmaydi, identity chaqirilmaydi', async () => {
    user = null;
    await request(http()).get('/auth/sessions').expect(403);
    expect(identitySend).not.toHaveBeenCalled();
  });

  it('marshrut metadata: @Public EMAS, JwtAuthGuard bilan, @Roles yo‘q (har qanday rol — x-roles: null)', () => {
    const handler = Object.getOwnPropertyDescriptor(
      AuthGatewayController.prototype,
      'mySessions',
    )?.value as object;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
      JwtAuthGuard,
    );
    const roles = collectRouteRoles([AuthGatewayController]);
    expect(roles.get('AuthGatewayController_mySessions')).toBeNull();
    // Mavjud auth marshrutlari ham o'zgarmagan.
    expect(roles.get('AuthGatewayController_logout')).toBeNull();
    expect(roles.get('AuthGatewayController_myProfile')).toBeNull();
  });

  it('JwtStrategy `sid` claim’ini req.user’ga o‘zgarmay uzatadi (eski tokenlar — sid’siz ham ishlaydi)', async () => {
    const strategy = new JwtStrategy({
      get: () => 'k'.repeat(48),
    } as unknown as ConfigService);
    await expect(
      strategy.validate({
        sub: '25',
        username: 'u',
        roles: ['COURIER'],
        sid: SID,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ sub: '25', roles: ['courier'], sid: SID }),
    );
    await expect(
      strategy.validate({ sub: '25', username: 'u', roles: ['courier'] }),
    ).resolves.not.toHaveProperty('sid');
  });

  it('⭐ POST /auth/logout — identity’ga sid + cookie’dagi refresh token; cookie tozalanadi', async () => {
    identitySend.mockReturnValue(
      of({ statusCode: 200, message: 'Logged out successfully', data: {} }),
    );
    const res = await request(http())
      .post('/auth/logout')
      .set('Cookie', 'theme=dark; refreshToken=rt%2Eabc; other=1')
      .expect(201);

    const [pattern, payload] = lastCall();
    expect(pattern).toEqual({ cmd: 'identity.logout' });
    expect(payload).toEqual({
      userId: '25',
      sessionId: SID,
      refreshToken: 'rt.abc',
    });
    const cleared = setCookies(res).find((c) => c.startsWith('refreshToken='));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/Path=\/auth/);
    expect(cleared).toMatch(/HttpOnly/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('POST /auth/logout — sid ham, cookie ham bo‘lmasa null’lar ketadi (identity hech narsani taxmin qilmaydi)', async () => {
    user = { sub: '25', roles: ['courier'] };
    identitySend.mockReturnValue(of({ statusCode: 200, data: {} }));
    await request(http()).post('/auth/logout').expect(201);
    expect(lastCall()[1]).toEqual({
      userId: '25',
      sessionId: null,
      refreshToken: null,
    });
  });

  it('login — cookie o‘zgarmagan: httpOnly, path=/auth, muddati refresh exp’gacha; javobda refresh token YO‘Q', async () => {
    const refreshExp = Date.now() + 24 * 3600_000;
    identitySend.mockReturnValue(
      of({
        statusCode: 200,
        accessToken: 'access.jwt',
        refreshToken: 'refresh.jwt',
        accessTokenExpiresAt: Date.now() + 3600_000,
        refreshTokenExpiresAt: refreshExp,
        refreshTokenWarnAt: refreshExp - 15 * 60_000,
      }),
    );
    const res = await request(http())
      .post('/auth/login')
      .send({ phone_number: '+998900000025', password: '0990' })
      .expect(201);

    expect((res.body as { accessToken?: string }).accessToken).toBe(
      'access.jwt',
    );
    expect(JSON.stringify(res.body)).not.toContain('refresh.jwt');
    const cookie = setCookies(res).find((c) => c.startsWith('refreshToken='));
    expect(cookie).toMatch(/^refreshToken=refresh\.jwt;/);
    expect(cookie).toMatch(/Path=\/auth/);
    expect(cookie).toMatch(/HttpOnly/);
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie ?? '')?.[1]);
    expect(maxAge).toBeGreaterThan(24 * 3600 - 60);
    expect(maxAge).toBeLessThanOrEqual(24 * 3600);
  });

  it('refresh — cookie’dagi token identity’ga; yangi refresh qaytmasa cookie qayta yozilmaydi (rotatsiya yo‘q)', async () => {
    identitySend.mockReturnValue(
      of({
        statusCode: 200,
        accessToken: 'access.jwt.2',
        accessTokenExpiresAt: Date.now() + 3600_000,
        refreshTokenExpiresAt: Date.now() + 3600_000,
      }),
    );
    const res = await request(http())
      .post('/auth/refresh')
      .set('Cookie', 'refreshToken=refresh.jwt')
      .expect(201);

    expect(lastCall()).toEqual([
      { cmd: 'identity.refresh' },
      { refreshToken: 'refresh.jwt' },
    ]);
    expect((res.body as { accessToken?: string }).accessToken).toBe(
      'access.jwt.2',
    );
    expect(setCookies(res)).toEqual([]);
  });
});
