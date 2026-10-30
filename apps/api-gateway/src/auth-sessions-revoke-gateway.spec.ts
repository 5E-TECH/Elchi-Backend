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
import { ApiGatewayController } from './api-gateway.controller';
import { AuthGatewayController } from './auth-gateway.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { JwtStrategy } from './auth/jwt.strategy';
import { IS_PUBLIC_KEY } from './auth/public.decorator';
import { collectRouteRoles } from './auth/route-roles';
import { SessionRevocationService } from './auth/session-revocation.service';
import {
  RealtimeGateway,
  SESSION_KICK_DISCONNECT_DELAY_MS,
} from './realtime/realtime.gateway';

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
/** (2026-10-23) Planshet — 48 soatdan yosh sessiya (identity 403 beradi). */
const TABLET_AVAILABLE_AT = '2026-10-25T07:00:00.000Z';
const LOCK_MESSAGE =
  "Xavfsizlik uchun yangi qurilmadan boshqa sessiyalarni chiqarib bo'lmaydi — 25.10.2026 12:00 (Toshkent) dan keyin mumkin";
const tooNew = () => ({
  statusCode: 403,
  message: LOCK_MESSAGE,
  data: null,
  code: 'SESSION_TOO_NEW',
  available_at: TABLET_AVAILABLE_AT,
});

describe('Elchi Pochta #3 — boshqa sessiyalarni yopish (gateway, haqiqiy JwtStrategy)', () => {
  let app: INestApplication;
  let revocation: SessionRevocationService;
  const jwt = new JwtService({ secret: KEY, signOptions: { expiresIn: '1h' } });
  /** (2026-10-24) Soxta socket.io serveriga ketgan emit / uzishlar. */
  const socketLog: Array<
    | { kind: 'emit'; room: string; event: string; data: unknown }
    | { kind: 'disconnect'; rooms: string[]; close: boolean }
  > = [];

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
            data: {
              active_count: 0,
              sessions: [],
              can_revoke_others: sid(payload.sessionId) !== SID_TABLET,
              revoke_available_at:
                sid(payload.sessionId) === SID_TABLET
                  ? TABLET_AVAILABLE_AT
                  : null,
            },
          });
        case 'identity.user.update': {
          // Parol almashtirish: o'zi bo'lsa joriy sessiya qoladi, aks holda
          // nishon foydalanuvchining hammasi (auth.sessions.spec.ts da
          // haqiqiy identity bilan isbotlangan).
          const target = String(payload.id);
          if (!(payload.dto as { password?: string }).password) {
            return of({
              statusCode: 200,
              message: 'User yangilandi',
              data: { id: target },
            });
          }
          const requester = payload.requester as { id: string };
          const keep =
            requester.id === target ? sid(payload.current_session_id) : null;
          const ids = [...owners.entries()]
            .filter(
              ([id, owner]) =>
                owner === target && !revoked.has(id) && id !== keep,
            )
            .map(([id]) => id);
          ids.forEach((id) => revoked.add(id));
          return of({
            statusCode: 200,
            message: 'User yangilandi',
            data: { id: target },
            sessions_revoked: ids.length,
            revoked_session_ids: ids,
          });
        }
        case 'identity.auth.sessions.revoke': {
          const id = sid(payload.sessionId);
          if (sid(payload.currentSessionId) === SID_TABLET) {
            return throwError(tooNew);
          }
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
          if (current === SID_TABLET) return throwError(tooNew);
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
                message: 'Refresh token yaroqsiz',
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
      controllers: [AuthGatewayController, ApiGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: { send: identitySend } },
        { provide: 'FINANCE', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: { send: jest.fn() } },
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
        // (2026-10-24) socket qismi — server soxta (`socketLog`).
        { provide: JwtService, useValue: jwt },
        RealtimeGateway,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter(), new RpcExceptionFilter());
    await app.init();
    revocation = app.get(SessionRevocationService);
    const realtime: RealtimeGateway = app.get(RealtimeGateway);
    (realtime as unknown as { server: unknown }).server = {
      to: (room: string) => ({
        emit: (event: string, data: unknown) =>
          socketLog.push({ kind: 'emit', room, event, data }),
      }),
      in: (rooms: string[]) => ({
        disconnectSockets: (close: boolean) =>
          socketLog.push({ kind: 'disconnect', rooms, close }),
      }),
      emit: jest.fn(),
    };
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
    socketLog.length = 0;
    // Har test toza kesh bilan (boshqa gateway instansi kabi).
    (revocation as unknown as { cache: Map<string, unknown> }).cache.clear();
    // (2026-10-26) 5 daqiqalik «oxirgi tasdiq» muhlati ham — toza.
    (
      revocation as unknown as { lastActiveAt: Map<string, number> }
    ).lastActiveAt.clear();
    revocation.now = () => Date.now();
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const token = (sid: string | null, sub = '25', roles = ['COURIER']) =>
    `Bearer ${jwt.sign({
      sub,
      username: null,
      roles,
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
      'Refresh token yaroqsiz',
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

  it('⭐ (NDmZMzCP) identity ishlamasa — FAIL CLOSED: 503 (401 EMAS — FE chiqarib yubormaydi), identity qaytgach ishlaydi', async () => {
    identityDown = true;
    const warn = jest
      .spyOn(
        (revocation as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    const res = await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(SID_LAPTOP))
      .expect(503);
    expect(res.body).toEqual(
      expect.objectContaining({
        statusCode: 503,
        message:
          "Sessiyani tekshirib bo'lmadi — birozdan keyin qayta urinib ko'ring",
      }),
    );
    expect(warn).toHaveBeenCalled();
    expect(calls('identity.auth.sessions')).toHaveLength(0);
    warn.mockRestore();

    // identity qaytdi — «noma'lum» kesh (5 s) o'tgach token yana ishlaydi.
    identityDown = false;
    revocation.now = () => Date.now() + 10_000;
    await request(http())
      .get('/auth/sessions')
      .set('Authorization', token(SID_LAPTOP))
      .expect(200);
    revocation.now = () => Date.now();
  });

  describe('(2026-10-26) identity javob bermasa — 5 daqiqalik «oxirgi tasdiq» muhlati', () => {
    let warn: jest.SpyInstance;
    let clock: number;
    beforeEach(() => {
      warn = jest
        .spyOn(
          (revocation as unknown as { logger: { warn: () => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      clock = Date.now();
      revocation.now = () => clock;
    });
    afterEach(() => {
      warn.mockRestore();
    });
    const get = (sid: string) =>
      request(http()).get('/auth/sessions').set('Authorization', token(sid));

    it('⭐ 5 daqiqa ichida tasdiqlangan sessiya — identity ishlamasa ham 200 (503 EMAS)', async () => {
      await get(SID_LAPTOP).expect(200);
      identityDown = true;
      // «active» kesh (30 s) o'tdi — identity so'raladi va xato beradi.
      clock += 4 * 60_000;
      await get(SID_LAPTOP).expect(200);
      expect(calls('identity.auth.session_state').length).toBeGreaterThan(1);
      // Hech tasdiqlanmagan sessiya — fail closed.
      await get(SID_PHONE).expect(503);
    });

    it('⭐ muhlat o‘tgan (oxirgi tasdiq > 5 daqiqa) — 503', async () => {
      await get(SID_LAPTOP).expect(200);
      identityDown = true;
      clock += 5 * 60_000 + 1;
      const res = await get(SID_LAPTOP).expect(503);
      expect(res.body).toEqual(
        expect.objectContaining({
          statusCode: 503,
          message:
            "Sessiyani tekshirib bo'lmadi — birozdan keyin qayta urinib ko'ring",
        }),
      );
    });

    it('⭐ muhlat davomida yopilgan sessiya — darhol 401 (markRevoked / kick ustun)', async () => {
      await get(SID_LAPTOP).expect(200);
      await get(SID_PHONE).expect(200);
      identityDown = true;
      clock += 60_000;
      revocation.markRevoked([SID_LAPTOP]);
      revocation.kickSessions([SID_PHONE], 'security_reset');
      await get(SID_LAPTOP).expect(401);
      await get(SID_PHONE).expect(401);
      // Yopilgan yozuv muddati tugasa ham muhlat qaytmaydi.
      clock += 2 * 3600_000;
      await get(SID_LAPTOP).expect(503);
    });
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

  describe('(2026-10-23) 48 soatlik qulf — 403 SESSION_TOO_NEW konverti', () => {
    it('⭐ revoke-others: 403 — `code` va `available_at` javobda (data yo‘q), hech kim chiqarilmaydi', async () => {
      const res = await request(http())
        .post('/auth/sessions/revoke-others')
        .set('Authorization', token(SID_TABLET))
        .expect(403);
      expect(res.body).toEqual({
        statusCode: 403,
        message: LOCK_MESSAGE,
        code: 'SESSION_TOO_NEW',
        available_at: TABLET_AVAILABLE_AT,
      });
      for (const sid of [SID_PHONE, SID_LAPTOP, SID_TABLET]) {
        await request(http())
          .get('/auth/sessions')
          .set('Authorization', token(sid))
          .expect(200);
      }
    });

    it('⭐ DELETE /auth/sessions/:id: 403 — xuddi shu konvert, nishon ishlashda davom etadi', async () => {
      const res = await request(http())
        .delete(`/auth/sessions/${SID_PHONE}`)
        .set('Authorization', token(SID_TABLET))
        .expect(403);
      expect(res.body).toEqual({
        statusCode: 403,
        message: LOCK_MESSAGE,
        code: 'SESSION_TOO_NEW',
        available_at: TABLET_AVAILABLE_AT,
      });
      await request(http())
        .get('/auth/sessions')
        .set('Authorization', token(SID_PHONE))
        .expect(200);
    });

    it('GET /auth/sessions: `can_revoke_others` / `revoke_available_at` o‘zgarmay o‘tadi', async () => {
      const young = await request(http())
        .get('/auth/sessions')
        .set('Authorization', token(SID_TABLET))
        .expect(200);
      expect((young.body as { data: unknown }).data).toEqual(
        expect.objectContaining({
          can_revoke_others: false,
          revoke_available_at: TABLET_AVAILABLE_AT,
        }),
      );
      const old = await request(http())
        .get('/auth/sessions')
        .set('Authorization', token(SID_LAPTOP))
        .expect(200);
      expect((old.body as { data: unknown }).data).toEqual(
        expect.objectContaining({
          can_revoke_others: true,
          revoke_available_at: null,
        }),
      );
    });

    it('POST /auth/logout — qulfsiz (yangi sessiya ham chiqadi)', async () => {
      await request(http())
        .post('/auth/logout')
        .set('Authorization', token(SID_TABLET))
        .expect(201);
      await request(http())
        .get('/auth/sessions')
        .set('Authorization', token(SID_TABLET))
        .expect(401);
    });
  });

  describe('(2026-10-23) parol almashtirish — boshqa qurilmalar shu gateway keshida DARHOL 401', () => {
    it('⭐ PATCH /auth/my-profile (o‘zi, noutbukdan): identity’ga `current_session_id` = JWT sid; telefon/planshet darhol 401 (session_state so‘ralmaydi), noutbuk ishlaydi; ichki id lar javobdan olib tashlanadi', async () => {
      // Telefon va planshet «ochiq» deb keshlangan (30 s qayta so'ralmaydi).
      for (const sid of [SID_PHONE, SID_TABLET]) {
        await request(http())
          .get('/auth/sessions')
          .set('Authorization', token(sid))
          .expect(200);
      }
      const stateCalls = calls('identity.auth.session_state').length;

      const res = await request(http())
        .patch('/auth/my-profile')
        .set('Authorization', token(SID_LAPTOP))
        .send({ password: 'yangi-parol' })
        .expect(200);
      expect(res.body).toEqual({
        statusCode: 200,
        message: 'User yangilandi',
        data: { id: '25' },
        sessions_revoked: 2,
      });
      expect(calls('identity.user.update')[0][1]).toEqual({
        id: '25',
        dto: { password: 'yangi-parol' },
        requester: { id: '25', roles: ['courier'] },
        current_session_id: SID_LAPTOP,
      });

      for (const sid of [SID_PHONE, SID_TABLET]) {
        const denied = await request(http())
          .get('/auth/sessions')
          .set('Authorization', token(sid))
          .expect(401);
        expect((denied.body as { message: string }).message).toBe(
          'Session revoked',
        );
      }
      // Kesh belgisidan — identity'ga qayta so'rov yo'q.
      expect(calls('identity.auth.session_state').length).toBe(
        stateCalls + 1, // faqat noutbukning birinchi tekshiruvi
      );
      await request(http())
        .get('/auth/sessions')
        .set('Authorization', token(SID_LAPTOP))
        .expect(200);
    });

    it('⭐ PATCH /users/:id (superadmin tiklaydi): foydalanuvchining BARCHA sessiyalari darhol 401; superadminniki va boshqalar ishlaydi', async () => {
      for (const sid of [SID_PHONE, SID_LAPTOP, SID_TABLET]) {
        await request(http())
          .get('/auth/sessions')
          .set('Authorization', token(sid))
          .expect(200);
      }
      const res = await request(http())
        .patch('/users/25')
        .set('Authorization', token(SID_OTHER_USER, '26', ['SUPERADMIN']))
        .send({ password: 'tiklangan' })
        .expect(200);
      expect(res.body).toEqual({
        statusCode: 200,
        message: 'User yangilandi',
        data: { id: '25' },
        sessions_revoked: 3,
      });
      expect(calls('identity.user.update')[0][1]).toEqual(
        expect.objectContaining({
          id: '25',
          requester: { id: '26', roles: ['superadmin'] },
          current_session_id: SID_OTHER_USER,
        }),
      );
      for (const sid of [SID_PHONE, SID_LAPTOP, SID_TABLET]) {
        await request(http())
          .get('/auth/sessions')
          .set('Authorization', token(sid))
          .expect(401);
      }
      await request(http())
        .get('/auth/sessions')
        .set('Authorization', token(SID_OTHER_USER, '26', ['SUPERADMIN']))
        .expect(200);
    });

    it('`sid` siz token bilan PATCH /auth/my-profile — `current_session_id: null`; parolsiz javob o‘zgarmagan', async () => {
      const res = await request(http())
        .patch('/auth/my-profile')
        .set('Authorization', token(null))
        .send({ name: 'Ism' })
        .expect(200);
      expect(res.body).toEqual({
        statusCode: 200,
        message: 'User yangilandi',
        data: { id: '25' },
      });
      expect(calls('identity.user.update')[0][1]).toEqual(
        expect.objectContaining({ current_session_id: null }),
      );
    });
  });

  describe('(2026-10-24) ochiq socketlar SHU ZAHOTI chiqadi — `auth:session_revoked` + uzish', () => {
    const kicks = () =>
      socketLog.flatMap((entry) =>
        entry.kind === 'emit'
          ? [{ room: entry.room, event: entry.event, data: entry.data }]
          : [],
      );
    const kick = (sid: string, reason: string) => ({
      room: `session:${sid}`,
      event: 'auth:session_revoked',
      data: { session_id: sid, reason },
    });

    const settle = () =>
      new Promise((resolve) =>
        setTimeout(resolve, SESSION_KICK_DISCONNECT_DELAY_MS + 50),
      );

    it('⭐ DELETE /auth/sessions/:id — faqat telefon xonasiga `revoked_by_owner`, 250 ms dan keyin uziladi; noutbuk/planshet tegilmaydi', async () => {
      // Oldingi testlarning kutilayotgan uzishlari tugasin.
      await settle();
      socketLog.length = 0;
      await request(http())
        .delete(`/auth/sessions/${SID_PHONE}`)
        .set('Authorization', token(SID_LAPTOP))
        .expect(200);
      expect(kicks()).toEqual([kick(SID_PHONE, 'revoked_by_owner')]);
      expect(socketLog.filter((e) => e.kind === 'disconnect')).toEqual([]);
      await settle();
      expect(socketLog.filter((e) => e.kind === 'disconnect')).toEqual([
        { kind: 'disconnect', rooms: [`session:${SID_PHONE}`], close: true },
      ]);
    });

    it('⭐ POST /auth/sessions/revoke-others — telefon va planshet `revoked_by_owner`; joriy (noutbuk) va boshqa foydalanuvchi tegilmaydi', async () => {
      await request(http())
        .post('/auth/sessions/revoke-others')
        .set('Authorization', token(SID_LAPTOP))
        .expect(200);
      expect(kicks()).toEqual([
        kick(SID_PHONE, 'revoked_by_owner'),
        kick(SID_TABLET, 'revoked_by_owner'),
      ]);
    });

    it('⭐ POST /auth/logout — joriy sessiyaning boshqa tablari `logout` bilan chiqadi', async () => {
      await request(http())
        .post('/auth/logout')
        .set('Authorization', token(SID_PHONE))
        .expect(201);
      expect(kicks()).toEqual([kick(SID_PHONE, 'logout')]);
    });

    it('⭐ PATCH /auth/my-profile { password } (o‘zi, noutbukdan) — telefon va planshet `password_changed`, noutbuk qoladi', async () => {
      await request(http())
        .patch('/auth/my-profile')
        .set('Authorization', token(SID_LAPTOP))
        .send({ password: 'yangi-parol' })
        .expect(200);
      expect(kicks()).toEqual([
        kick(SID_PHONE, 'password_changed'),
        kick(SID_TABLET, 'password_changed'),
      ]);
    });

    it('⭐ PATCH /users/:id { password } (superadmin tiklaydi) — o‘sha foydalanuvchining HAMMA sessiyasi `password_changed`; superadminniki tegilmaydi', async () => {
      await request(http())
        .patch('/users/25')
        .set('Authorization', token(SID_OTHER_USER, '26', ['SUPERADMIN']))
        .send({ password: 'tiklangan' })
        .expect(200);
      expect(kicks()).toEqual([
        kick(SID_PHONE, 'password_changed'),
        kick(SID_LAPTOP, 'password_changed'),
        kick(SID_TABLET, 'password_changed'),
      ]);
    });

    it('rad etilgan so‘rovlar (403 SESSION_TOO_NEW, 404, 400) va parolsiz profil — hech kim chiqarilmaydi', async () => {
      await request(http())
        .post('/auth/sessions/revoke-others')
        .set('Authorization', token(SID_TABLET))
        .expect(403);
      await request(http())
        .delete(`/auth/sessions/${SID_PHONE}`)
        .set('Authorization', token(SID_TABLET))
        .expect(403);
      await request(http())
        .delete(`/auth/sessions/${SID_OTHER_USER}`)
        .set('Authorization', token(SID_LAPTOP))
        .expect(404);
      await request(http())
        .delete(`/auth/sessions/${SID_LAPTOP}`)
        .set('Authorization', token(SID_LAPTOP))
        .expect(400);
      await request(http())
        .patch('/auth/my-profile')
        .set('Authorization', token(SID_LAPTOP))
        .send({ name: 'Ism' })
        .expect(200);
      expect(kicks()).toEqual([]);
    });
  });
});
