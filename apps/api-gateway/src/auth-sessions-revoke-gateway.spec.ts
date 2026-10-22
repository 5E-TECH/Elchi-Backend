import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { AllExceptionsFilter, RpcExceptionFilter } from '@app/common';
import { AuthGatewayController } from './auth-gateway.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { JwtStrategy } from './auth/jwt.strategy';
import { IS_PUBLIC_KEY } from './auth/public.decorator';
import { collectRouteRoles } from './auth/route-roles';
import { SessionRevocationService } from './auth/session-revocation.service';

/**
 * (Elchi Pochta #3 — «Sessiyalar»: boshqa sessiyalarni chiqarib yuborish)
 * gateway, HAQIQIY JwtStrategy + JwtAuthGuard + SessionRevocationService va
 * soxta identity bilan:
 *  - `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-others` — kim
 *    va joriy sessiya FAQAT JWT `sub`/`sid` dan;
 *  - chiqarilgan qurilmaning access tokeni keyingi so'rovdayoq 401
 *    («Session revoked»), refresh'i ham 401 → FE login sahifasiga;
 *  - `sid` siz tokenlar tekshirilmaydi; identity javob bermasa — ruxsat.
 */
const KEY = 'k'.repeat(48);
const SID_PHONE = '3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d';
const SID_LAPTOP = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const SID_TABLET = '11111111-2222-4333-8444-555555555555';
const SID_OTHER_USER = '66666666-7777-4888-9999-000000000000';

describe('Elchi Pochta #3 — boshqa sessiyalarni yopish (gateway, haqiqiy JwtStrategy)', () => {
  let app: INestApplication;
  let revocation: SessionRevocationService;
  const jwt = new JwtService({ secret: KEY, signOptions: { expiresIn: '1h' } });

  // Soxta identity: sessiya → egasi; yopilganlar to'plami.
  const owners = new Map<string, string>();
  const revoked = new Set<string>();
  let identityDown = false;
  const identitySend = jest.fn(
    (pattern: { cmd: string }, payload: Record<string, unknown>) => {
      const sid = (value: unknown) =>
        typeof value === 'string' ? value.toLowerCase() : null;
      switch (pattern.cmd) {
        case 'identity.auth.session_state': {
          if (identityDown) {
            return throwError(() => new Error('identity unavailable'));
          }
          const id = sid(payload.sessionId);
          return of({
            active:
              id !== null &&
              owners.get(id) === payload.userId &&
              !revoked.has(id),
          });
        }
        case 'identity.auth.sessions':
          return of({
            statusCode: 200,
            message: 'success',
            data: { active_count: 0, sessions: [] },
          });
        case 'identity.auth.sessions.revoke': {
          const id = sid(payload.sessionId);
          if (id === sid(payload.currentSessionId)) {
            return throwError(() => ({
              statusCode: 400,
              message:
                "Joriy sessiyani bu yerdan yopib bo'lmaydi — «Chiqish» tugmasidan foydalaning",
              data: null,
            }));
          }
          if (!id || owners.get(id) !== payload.userId || revoked.has(id)) {
            return throwError(() => ({
              statusCode: 404,
              message: 'Sessiya topilmadi yoki allaqachon yopilgan',
              data: null,
            }));
          }
          revoked.add(id);
          return of({
            statusCode: 200,
            message: 'Sessiya yopildi',
            data: { revoked: 1, session_ids: [id] },
          });
        }
        case 'identity.auth.sessions.revoke_others': {
          const current = sid(payload.currentSessionId);
          if (!current) {
            return throwError(() => ({
              statusCode: 400,
              message: 'Joriy sessiya aniqlanmadi — qayta kiring',
              data: null,
            }));
          }
          const ids = [...owners.entries()]
            .filter(
              ([id, owner]) =>
                owner === payload.userId && id !== current && !revoked.has(id),
            )
            .map(([id]) => id);
          ids.forEach((id) => revoked.add(id));
          return of({
            statusCode: 200,
            message: 'Boshqa sessiyalardan chiqildi',
            data: { revoked: ids.length, session_ids: ids },
          });
        }
        case 'identity.logout': {
          const id = sid(payload.sessionId);
          if (id) revoked.add(id);
          return of({
            statusCode: 200,
            message: 'Logged out successfully',
            data: { session_ids: id ? [id] : [] },
          });
        }
        case 'identity.refresh':
          // Yopilgan sessiyaning refresh tokeni — identity 401 (rejectReason
          // 'revoked', auth.sessions.spec.ts da isbotlangan).
          return String(payload.refreshToken).startsWith('rt-phone')
            ? throwError(() => ({
                statusCode: 401,
                message: 'Invalid refresh token',
                data: null,
              }))
            : of({
                statusCode: 200,
                accessToken: 'access.jwt',
                accessTokenExpiresAt: Date.now() + 3600_000,
              });
        default:
          return throwError(() => new Error(`unexpected ${pattern.cmd}`));
      }
    },
  );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule,
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }]),
      ],
      controllers: [AuthGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: { send: identitySend } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({ ACCESS_TOKEN_KEY: KEY, ACCESS_TOKEN_TIME: '1h' })[key],
          },
        },
        Reflector,
        SessionRevocationService,
        JwtStrategy,
        JwtAuthGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
    revocation = app.get(SessionRevocationService);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    identityDown = false;
    revoked.clear();
    owners.clear();
    owners.set(SID_PHONE, '25');
    owners.set(SID_LAPTOP, '25');
    owners.set(SID_TABLET, '25');
    owners.set(SID_OTHER_USER, '26');
    identitySend.mockClear();
    // Har test toza kesh bilan (boshqa gateway instansi kabi).
    (revocation as unknown as { cache: Map<string, unknown> }).cache.clear();
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const token = (sid: string | null, sub = '25') =>
    `Bearer ${jwt.sign({
      sub,
      username: null,
      roles: ['COURIER'],
      ...(sid ? { sid } : {}),
    })}`;
  type Call = [{ cmd: string }, Record<string, unknown>];
  const calls = (cmd: string) =>
    (identitySend.mock.calls as Call[]).filter(([p]) => p.cmd === cmd);

  it('⭐ noutbukdan telefon chiqariladi → telefon keyingi so‘rovda 401 (identity’ga so‘rovsiz), refresh ham 401; noutbuk ishlaydi', async () => {
    await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(SID_PHONE))
      .expect(200);

    const res = await request(http())
      .delete(`/auth/sessions/${SID_PHONE}`)
      .set('Authorization', token(SID_LAPTOP))
      .expect(200);
    expect(res.body).toEqual({
      statusCode: 200,
      message: 'Sessiya yopildi',
      data: { revoked: 1, session_ids: [SID_PHONE] },
    });
    expect(calls('identity.auth.sessions.revoke')[0][1]).toEqual({
      userId: '25',
      sessionId: SID_PHONE,
      currentSessionId: SID_LAPTOP,
    });

    // Telefon: access token muddati tugashini kutmay 401. Telefon sid i
    // avval «ochiq» deb keshlangan edi — revoke uni darhol almashtirdi.
    const stateCallsBefore = calls('identity.auth.session_state').length;
    const denied = await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(SID_PHONE))
      .expect(401);
    expect((denied.body as { message: string }).message).toBe(
      'Session revoked',
    );
    expect(calls('identity.auth.session_state')).toHaveLength(stateCallsBefore);
    expect(calls('identity.auth.sessions')).toHaveLength(1);

    // FE 401 dan keyin refresh qiladi — u ham 401 → login sahifasi.
    const refresh = await request(http())
      .post('/auth/refresh')
      .set('Cookie', 'refreshToken=rt-phone')
      .expect(401);
    expect((refresh.body as { message: string }).message).toBe(
      'Invalid refresh token',
    );

    await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(SID_LAPTOP))
      .expect(200);
  });

  it('⭐ boshqa gateway instansi (kesh belgilanmagan) — identity session_state orqali 401', async () => {
    revoked.add(SID_PHONE);
    await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(SID_PHONE))
      .expect(401);
    expect(calls('identity.auth.session_state')[0][1]).toEqual({
      userId: '25',
      sessionId: SID_PHONE,
    });
    expect(calls('identity.auth.sessions')).toHaveLength(0);
  });

  it('⭐ POST /auth/sessions/revoke-others — 200, joriy qoladi, qolganlari darhol 401', async () => {
    const res = await request(http())
      .post('/auth/sessions/revoke-others')
      .set('Authorization', token(SID_LAPTOP))
      .send({ userId: '26', currentSessionId: SID_PHONE })
      .expect(200);
    expect(res.body).toEqual({
      statusCode: 200,
      message: 'Boshqa sessiyalardan chiqildi',
      data: { revoked: 2, session_ids: [SID_PHONE, SID_TABLET] },
    });
    // Kim va joriy sessiya — faqat JWT'dan (tanadagi qiymatlar e'tiborsiz).
    expect(calls('identity.auth.sessions.revoke_others')[0][1]).toEqual({
      userId: '25',
      currentSessionId: SID_LAPTOP,
    });

    for (const sid of [SID_PHONE, SID_TABLET]) {
      await request(http())
        .get('/auth/sessions')
        .set('Authorization', token(sid))
        .expect(401);
    }
    await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(SID_LAPTOP))
      .expect(200);
    // Boshqa foydalanuvchi ta'sirlanmagan.
    await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(SID_OTHER_USER, '26'))
      .expect(200);
  });

  it('revoke-others: `sid` siz token → identity’ga currentSessionId null, 400 xabari o‘tadi', async () => {
    const res = await request(http())
      .post('/auth/sessions/revoke-others')
      .set('Authorization', token(null))
      .expect(400);
    expect(res.body).toEqual(
      expect.objectContaining({
        statusCode: 400,
        message: 'Joriy sessiya aniqlanmadi — qayta kiring',
      }),
    );
    expect(calls('identity.auth.sessions.revoke_others')[0][1]).toEqual({
      userId: '25',
      currentSessionId: null,
    });
  });

  it('DELETE: joriy sessiya → 400, begona sessiya → 404; kesh belgilanmaydi', async () => {
    const current = await request(http())
      .delete(`/auth/sessions/${SID_LAPTOP}`)
      .set('Authorization', token(SID_LAPTOP))
      .expect(400);
    expect((current.body as { message: string }).message).toBe(
      "Joriy sessiyani bu yerdan yopib bo'lmaydi — «Chiqish» tugmasidan foydalaning",
    );

    const foreign = await request(http())
      .delete(`/auth/sessions/${SID_OTHER_USER}`)
      .set('Authorization', token(SID_LAPTOP))
      .expect(404);
    expect((foreign.body as { message: string }).message).toBe(
      'Sessiya topilmadi yoki allaqachon yopilgan',
    );
    // Xato javobidan keyin hech kim bloklanmagan: joriy va begona sessiya.
    await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(SID_LAPTOP))
      .expect(200);
    await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(SID_OTHER_USER, '26'))
      .expect(200);
  });

  it('POST /auth/logout — identity qaytargan session_ids darhol yopilgan: shu token boshqa tabda ham 401', async () => {
    await request(http())
      .post('/auth/logout')
      .set('Authorization', token(SID_PHONE))
      .expect(201);
    await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(SID_PHONE))
      .expect(401);
  });

  it('`sid` siz token (Telegram Mini App / bot / eski) — session_state chaqirilmaydi', async () => {
    await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(null))
      .expect(200);
    expect(calls('identity.auth.session_state')).toHaveLength(0);
  });

  it('⭐ identity ishlamasa — FAIL OPEN: token ruxsat oladi (hamma chiqarib yuborilmaydi)', async () => {
    identityDown = true;
    const warn = jest
      .spyOn(
        (revocation as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(SID_LAPTOP))
      .expect(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('autentifikatsiyasiz — 401, identity chaqirilmaydi', async () => {
    await request(http()).delete(`/auth/sessions/${SID_PHONE}`).expect(401);
    await request(http()).post('/auth/sessions/revoke-others').expect(401);
    expect(identitySend).not.toHaveBeenCalled();
  });

  it('marshrut metadata: @Public EMAS, JwtAuthGuard, @Roles yo‘q (har qanday rol)', () => {
    const roles = collectRouteRoles([AuthGatewayController]);
    for (const name of ['revokeSession', 'revokeOtherSessions'] as const) {
      const handler = Object.getOwnPropertyDescriptor(
        AuthGatewayController.prototype,
        name,
      )?.value as object;
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
        JwtAuthGuard,
      );
      expect(roles.get(`AuthGatewayController_${name}`)).toBeNull();
    }
  });
});
