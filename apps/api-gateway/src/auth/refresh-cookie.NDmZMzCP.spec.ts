import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { of } from 'rxjs';
import request from 'supertest';
import { AuthGatewayController } from '../auth-gateway.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { SessionRevocationService } from './session-revocation.service';
import {
  refreshCookieOptions,
  resolveRefreshCookieSameSite,
} from './refresh-cookie';

/**
 * (NDmZMzCP, 2026-10-26) Refresh cookie `SameSite`: prod'da ilgari `None`
 * edi → endi sukut `Lax` (admin.elchipochta.uz va api.elchipochta.uz — bitta
 * sayt). `REFRESH_COOKIE_SAMESITE` bilan `strict` / `none` (favqulodda);
 * `none` da `Secure` majburiy. O'rnatish va o'chirish — AYNI parametrlar.
 */
describe('NDmZMzCP — refresh cookie SameSite', () => {
  describe('refreshCookieOptions (env)', () => {
    it('⭐ prod sukut: Lax + Secure + HttpOnly + path=/auth', () => {
      expect(refreshCookieOptions({ NODE_ENV: 'production' })).toEqual({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/auth',
      });
    });

    it('dev sukut: Lax, Secure yo‘q (http://localhost)', () => {
      expect(refreshCookieOptions({ NODE_ENV: 'development' })).toEqual({
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/auth',
      });
    });

    it('REFRESH_COOKIE_SAMESITE: strict / none (none → Secure majburiy, dev’da ham)', () => {
      expect(
        refreshCookieOptions({
          NODE_ENV: 'production',
          REFRESH_COOKIE_SAMESITE: ' Strict ',
        }).sameSite,
      ).toBe('strict');
      expect(
        refreshCookieOptions({
          NODE_ENV: 'development',
          REFRESH_COOKIE_SAMESITE: 'none',
        }),
      ).toEqual(expect.objectContaining({ sameSite: 'none', secure: true }));
    });

    it('noto‘g‘ri / bo‘sh qiymat — lax', () => {
      for (const raw of [undefined, '', 'NONE ', 'lax', 'yes', 'None;']) {
        const expected = raw === 'NONE ' ? 'none' : 'lax';
        expect(resolveRefreshCookieSameSite(raw)).toBe(expected);
      }
    });
  });

  describe('AuthGatewayController (prod)', () => {
    let app: INestApplication;
    const identitySend = jest.fn();
    const previousEnv = {
      NODE_ENV: process.env.NODE_ENV,
      REFRESH_COOKIE_SAMESITE: process.env.REFRESH_COOKIE_SAMESITE,
    };

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
            if (Reflect.getMetadata(IS_PUBLIC_KEY, ctx.getHandler()) === true) {
              return true;
            }
            ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
              sub: '25',
              roles: ['courier'],
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

    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      delete process.env.REFRESH_COOKIE_SAMESITE;
      identitySend.mockReset();
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const http = () => app.getHttpServer() as Parameters<typeof request>[0];
    const refreshCookie = (res: request.Response) => {
      const raw = res.headers['set-cookie'] as string[] | string | undefined;
      const all = Array.isArray(raw) ? raw : raw ? [raw] : [];
      return all.find((c) => c.startsWith('refreshToken='));
    };
    const loginReply = () =>
      of({
        statusCode: 200,
        accessToken: 'access.jwt',
        refreshToken: 'refresh.jwt',
        accessTokenExpiresAt: Date.now() + 3600_000,
        refreshTokenExpiresAt: Date.now() + 24 * 3600_000,
      });

    it('⭐ login — Set-Cookie: SameSite=Lax; Secure; HttpOnly; Path=/auth (None EMAS)', async () => {
      identitySend.mockReturnValue(loginReply());
      const res = await request(http())
        .post('/auth/login')
        .send({ phone_number: '+998900000025', password: 'TEST-parol-25' })
        .expect(201);
      const cookie = refreshCookie(res);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).not.toMatch(/SameSite=None/i);
      expect(cookie).toMatch(/; Secure/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Path=\/auth/);
    });

    it('⭐ logout — cookie AYNI parametrlar bilan o‘chiriladi (SameSite=Lax; Secure; Path=/auth)', async () => {
      identitySend.mockReturnValue(
        of({ statusCode: 200, message: 'Logged out successfully', data: {} }),
      );
      const res = await request(http())
        .post('/auth/logout')
        .set('Cookie', 'refreshToken=refresh.jwt')
        .expect(201);
      const cleared = refreshCookie(res);
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(cleared).toMatch(/SameSite=Lax/);
      expect(cleared).toMatch(/; Secure/);
      expect(cleared).toMatch(/Path=\/auth/);
    });

    it('REFRESH_COOKIE_SAMESITE=none — favqulodda orqaga qaytish (SameSite=None; Secure)', async () => {
      process.env.REFRESH_COOKIE_SAMESITE = 'none';
      identitySend.mockReturnValue(loginReply());
      const res = await request(http())
        .post('/auth/login')
        .send({ phone_number: '+998900000025', password: 'TEST-parol-25' })
        .expect(201);
      const cookie = refreshCookie(res);
      expect(cookie).toMatch(/SameSite=None/);
      expect(cookie).toMatch(/; Secure/);
    });
  });
});
