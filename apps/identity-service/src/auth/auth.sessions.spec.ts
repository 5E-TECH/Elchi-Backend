import { createHash } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { FindOperator } from 'typeorm';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { requestContext } from '@app/common';
import { IdentityController } from '../identity.controller';
import { AuthService } from './auth.service';
import {
  AuthSessionService,
  SESSION_RETENTION_DAYS,
  passwordFingerprint,
} from './auth-session.service';
import { invalidateAllSessions } from './session-security';
import type { UserSession } from '../entities/user-session.entity';

/**
 * (Elchi Pochta #3 — "Sessionlar bo'limi") AuthService + AuthSessionService
 * birgalikda, HAQIQIY JwtService (imzo/muddat) va xotiradagi repozitoriylar
 * bilan:
 *  - har login — alohida sessiya, boshqa qurilmalar chiqarib yuborilmaydi;
 *  - refresh: yaroqli / yopilgan / muddati o'tgan / epoch / parol izi /
 *    deploy'dan oldingi (legacy `admins.refresh_token`) token;
 *  - logout faqat joriy sessiyani yopadi, begona sessiyaga tegolmaydi;
 *  - ro'yxat: faqat o'ziniki, active_count, joriy belgi, tartib.
 * Haqiqiy SQL (UNIQUE, FK, tozalash so'rovi) — `user-sessions.pg.spec.ts`.
 */

const ACCESS_KEY = 'a'.repeat(48);
const REFRESH_KEY = 'r'.repeat(48);
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

type Where = Record<string, unknown>;

interface UserRow {
  id: string;
  name: string;
  username: string | null;
  phone_number: string;
  password: string;
  role: string;
  status: string;
  isDeleted: boolean;
  refresh_token: string | null;
  session_epoch: number;
  telegram_id?: string;
}

/** TypeORM `where` ning shu spec'ga kerakli qismi (IsNull, MoreThan, LessThan). */
function matches(row: object, where: Where): boolean {
  const record = row as Record<string, unknown>;
  return Object.entries(where).every(([key, cond]) => {
    const actual = record[key];
    if (cond instanceof FindOperator) {
      switch (cond.type) {
        case 'isNull':
          return actual === null || actual === undefined;
        case 'moreThan':
          return Number(actual) > Number(cond.value);
        case 'lessThan':
          return Number(actual) < Number(cond.value);
        default:
          throw new Error(`fake repo: ${cond.type} qo'llanmaydi`);
      }
    }
    return actual === cond;
  });
}

function makeSessionRepo() {
  const rows: UserSession[] = [];
  return {
    rows,
    create: (value: Partial<UserSession>) => ({ ...value }) as UserSession,
    insert: jest.fn((value: UserSession) => {
      if (rows.some((r) => r.refresh_token_hash === value.refresh_token_hash)) {
        return Promise.reject(
          Object.assign(new Error('duplicate key'), { code: '23505' }),
        );
      }
      rows.push({ ...value });
      return Promise.resolve({});
    }),
    findOne: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
    ),
    update: jest.fn((where: Where, patch: Partial<UserSession>) => {
      const hits = rows.filter((r) => matches(r, where));
      hits.forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ affected: hits.length });
    }),
    findAndCount: jest.fn(({ where, take }: { where: Where; take: number }) => {
      const hits = rows
        .filter((r) => matches(r, where))
        .sort((a, b) => Number(b.last_seen_at) - Number(a.last_seen_at));
      return Promise.resolve([
        hits.slice(0, take).map((r) => ({ ...r })),
        hits.length,
      ]);
    }),
    find: jest.fn(({ where, take }: { where: Where; take: number }) =>
      Promise.resolve(
        rows.filter((r) => matches(r, where)).slice(0, take ?? rows.length),
      ),
    ),
    delete: jest.fn((ids: string[]) => {
      let affected = 0;
      for (const id of ids) {
        const index = rows.findIndex((r) => r.id === id);
        if (index >= 0) {
          rows.splice(index, 1);
          affected += 1;
        }
      }
      return Promise.resolve({ affected });
    }),
    // `revokeOwnExcept` ning `UPDATE … RETURNING "id"` i (shart va
    // parametrlar tartibi bilan); haqiqiy SQL — user-sessions.pg.spec.ts.
    query: jest.fn((sql: string, params: unknown[] = []) => {
      if (!sql.includes('RETURNING "id"')) return Promise.resolve([[], 0]);
      const [now, reason, userId, keep] = params as [
        Date,
        UserSession['revoke_reason'],
        string,
        string,
      ];
      const hits = rows.filter(
        (r) =>
          r.user_id === userId &&
          (r.revoked_at === null || r.revoked_at === undefined) &&
          r.id !== keep,
      );
      hits.forEach((r) =>
        Object.assign(r, { revoked_at: now, revoke_reason: reason }),
      );
      return Promise.resolve([hits.map((r) => ({ id: r.id })), hits.length]);
    }),
  };
}

const baseUser = (id: string, phone: string): UserRow => ({
  id,
  name: `TEST ${id}`,
  username: null,
  phone_number: phone,
  password: `bcrypt-hash-${id}`,
  role: 'courier',
  status: 'active',
  isDeleted: false,
  refresh_token: null,
  session_epoch: 0,
});

function makeWorld() {
  const users = new Map<string, UserRow>([
    ['25', baseUser('25', '+998900000025')],
    ['26', baseUser('26', '+998900000026')],
  ]);
  const usersRepo = {
    findOne: jest.fn(({ where }: { where: Where }) => {
      for (const user of users.values()) {
        if (user.isDeleted !== where.isDeleted) continue;
        if (where.id !== undefined && user.id !== where.id) continue;
        if (
          where.phone_number !== undefined &&
          user.phone_number !== where.phone_number
        ) {
          continue;
        }
        return Promise.resolve(user);
      }
      return Promise.resolve(null);
    }),
    find: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(
        [...users.values()].filter((u) => u.telegram_id === where.telegram_id),
      ),
    ),
    update: jest.fn((where: Where, patch: Partial<UserRow>) => {
      const user = users.get(String(where.id));
      if (!user || !matches(user, where)) {
        return Promise.resolve({ affected: 0 });
      }
      Object.assign(user, patch);
      return Promise.resolve({ affected: 1 });
    }),
    save: jest.fn((user: UserRow) => Promise.resolve(user)),
  };
  const sessionRepo = makeSessionRepo();
  const sessions = new AuthSessionService(sessionRepo as never);
  const jwt = new JwtService({
    secret: ACCESS_KEY,
    signOptions: { expiresIn: '1h' },
  });
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const env: Record<string, string> = {
    REFRESH_TOKEN_KEY: REFRESH_KEY,
    REFRESH_TOKEN_TIME: '1d',
  };
  const service = new AuthService(
    usersRepo as never,
    jwt,
    { get: (key: string) => env[key] } as never,
    { compare: jest.fn().mockResolvedValue(true) } as never,
    { send: jest.fn(() => of({ data: { branch_id: null } })) } as never,
    activityLog as never,
    sessions,
  );
  jest
    .spyOn(
      (service as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    )
    .mockImplementation(() => undefined);

  const login = (userId: string, ctx: Record<string, string> = {}) =>
    requestContext.run({ traceId: `t-${userId}`, ...ctx }, () =>
      service.login({
        phone_number: users.get(userId)!.phone_number,
        password: '0990',
      }),
    );
  const sidOf = (accessToken: string) =>
    jwt.decode<{ sid?: string }>(accessToken).sid;

  return {
    service,
    sessions,
    users,
    usersRepo,
    sessionRepo,
    jwt,
    activityLog,
    login,
    sidOf,
  };
}

const errorOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => {
      throw new Error('401 kutilgandi');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode: number;
    message: string;
  };
};

type LogEntry = { action: string; metadata: { reason: string } };
const failureReasons = (activityLog: { log: jest.Mock }) =>
  (activityLog.log.mock.calls as Array<[LogEntry]>)
    .map(([entry]) => entry)
    .filter((entry) => entry.action === 'auth_failure')
    .map((entry) => entry.metadata.reason);

const PHONE_CTX = {
  ip: '203.0.113.7',
  user_agent: 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile',
  device_name: 'Telefon · Android · Chrome',
};
const LAPTOP_CTX = {
  ip: '198.51.100.20',
  user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0',
  device_name: 'Kompyuter · Windows · Chrome',
  device_id: 'dev-laptop-1',
};

describe('Elchi Pochta #3 — login: har login alohida sessiya', () => {
  it('⭐ ikki qurilmadan login — ikki sessiya, birinchisi chiqarib yuborilmaydi', async () => {
    const w = makeWorld();
    const phone = await w.login('25', PHONE_CTX);
    const laptop = await w.login('25', LAPTOP_CTX);

    expect(w.sessionRepo.rows).toHaveLength(2);
    expect(phone.refreshToken).not.toBe(laptop.refreshToken);
    expect(w.sidOf(phone.accessToken)).toBe(w.sessionRepo.rows[0].id);
    expect(w.sidOf(laptop.accessToken)).toBe(w.sessionRepo.rows[1].id);

    // Ikkala qurilma ham refresh qila oladi (RBAC-10 "superseded" endi yo'q).
    const a = await w.service.refresh({ refreshToken: phone.refreshToken });
    const b = await w.service.refresh({ refreshToken: laptop.refreshToken });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(w.sidOf(a.accessToken)).toBe(w.sidOf(phone.accessToken));
    expect(failureReasons(w.activityLog)).toEqual([]);
  });

  it('sessiya qatori: qurilma/IP so‘rov kontekstidan, hash (ochiq token YO‘Q), muddat = refresh exp, epoch va parol izi', async () => {
    const w = makeWorld();
    const res = await w.login('25', LAPTOP_CTX);
    const [row] = w.sessionRepo.rows;

    expect(row).toMatchObject({
      user_id: '25',
      refresh_token_hash: sha256(res.refreshToken),
      method: 'password',
      epoch: 0,
      password_fp: passwordFingerprint('bcrypt-hash-25'),
      revoked_at: null,
      ip: '198.51.100.20',
      user_agent: LAPTOP_CTX.user_agent,
      device_name: 'Kompyuter · Windows · Chrome',
      device_id: 'dev-laptop-1',
    });
    expect(JSON.stringify(row)).not.toContain(res.refreshToken);
    expect(row.expires_at.getTime()).toBe(res.refresh_token_expires_at);
    // 1 kunlik refresh (REFRESH_TOKEN_TIME=1d).
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBeGreaterThan(
      24 * 3600_000 - 5_000,
    );
    // Rollback uchun eski ustun — eng oxirgi login hashi (avvalgidek).
    expect(w.users.get('25')!.refresh_token).toBe(sha256(res.refreshToken));
  });

  it('bir soniyada ikki login (ikki marta bosish) — tokenlar `jti` bilan farq qiladi, UNIQUE to‘qnashmaydi', async () => {
    const w = makeWorld();
    const [a, b] = await Promise.all([w.login('25'), w.login('25')]);
    expect(a.refreshToken).not.toBe(b.refreshToken);
    expect(new Set(w.sessionRepo.rows.map((r) => r.id)).size).toBe(2);
  });

  it('OTP login ham sessiya ochadi (method=otp)', async () => {
    const w = makeWorld();
    await w.service.sessionForUser(w.users.get('26') as never, 'otp');
    expect(w.sessionRepo.rows[0]).toMatchObject({
      user_id: '26',
      method: 'otp',
    });
  });

  it('Telegram Mini App tokeni sessiya OCHMAYDI va `sid` siz (brauzer sessiyasi emas)', async () => {
    const w = makeWorld();
    w.users.get('25')!.telegram_id = '5550007';
    const res = await w.service.telegramAccessToken('5550007', 'mini_app');
    expect(w.sessionRepo.rows).toHaveLength(0);
    expect(w.sidOf(res.accessToken)).toBeUndefined();
    expect(res).not.toHaveProperty('refreshToken');
  });
});

describe('Elchi Pochta #3 — refresh', () => {
  it('⭐ yaroqli: faqat access token yangilanadi (rotatsiya yo‘q), refresh muddati o‘zgarmaydi, last_seen_at yangilanadi', async () => {
    const w = makeWorld();
    const res = await w.login('25');
    const row = w.sessionRepo.rows[0];
    const loginSeenAt = row.last_seen_at;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const refreshed = await w.service.refresh({
      refreshToken: res.refreshToken,
    });

    expect(refreshed).not.toHaveProperty('refreshToken');
    expect(refreshed.refresh_token_expires_at).toBe(
      res.refresh_token_expires_at,
    );
    expect(row.last_seen_at.getTime()).toBeGreaterThan(loginSeenAt.getTime());
    expect(row.created_at).toEqual(loginSeenAt);
    expect(w.sidOf(refreshed.accessToken)).toBe(row.id);
  });

  it('yopilgan sessiya (logout) — 401 "Invalid refresh token", eski ustun uni tiriltirmaydi', async () => {
    const w = makeWorld();
    const res = await w.login('25');
    await w.service.logout('25', { sessionId: w.sidOf(res.accessToken) });
    // Hatto eski ustun qo'lda qaytarilsa ham — qator bor va yopilgan.
    w.users.get('25')!.refresh_token = sha256(res.refreshToken);

    const err = await errorOf(
      w.service.refresh({ refreshToken: res.refreshToken }),
    );
    expect(err).toEqual(
      expect.objectContaining({
        statusCode: 401,
        message: 'Invalid refresh token',
      }),
    );
    expect(failureReasons(w.activityLog)).toEqual(['refresh_session_revoked']);
    expect(w.sessionRepo.rows).toHaveLength(1);
  });

  it('muddati o‘tgan sessiya qatori — 401 (refresh_session_expired)', async () => {
    const w = makeWorld();
    const res = await w.login('25');
    w.sessionRepo.rows[0].expires_at = new Date(Date.now() - 1000);

    const err = await errorOf(
      w.service.refresh({ refreshToken: res.refreshToken }),
    );
    expect(err.statusCode).toBe(401);
    expect(failureReasons(w.activityLog)).toEqual(['refresh_session_expired']);
  });

  it('JWT muddati o‘tgan — 401 (imzo/exp tekshiruvi avvalgidek birinchi)', async () => {
    const w = makeWorld();
    // Sukut `expiresIn` siz imzolovchi — `exp` qo'lda (o'tib ketgan).
    const expired = await new JwtService({}).signAsync(
      { sub: '25', username: null, exp: Math.floor(Date.now() / 1000) - 10 },
      { secret: REFRESH_KEY },
    );
    w.users.get('25')!.refresh_token = sha256(expired);
    const err = await errorOf(w.service.refresh({ refreshToken: expired }));
    expect(err.statusCode).toBe(401);
    expect(w.sessionRepo.rows).toHaveLength(0);
  });

  it('noma’lum token (imzo to‘g‘ri, sessiya yo‘q, eski ustunga mos emas) — 401, boshqa sessiyalarga TEGILMAYDI', async () => {
    const w = makeWorld();
    const live = await w.login('25');
    const stray = await w.jwt.signAsync(
      { sub: '25', username: null, jti: 'stray' },
      { secret: REFRESH_KEY, expiresIn: '1d' },
    );

    const err = await errorOf(w.service.refresh({ refreshToken: stray }));
    expect(err.statusCode).toBe(401);
    expect(failureReasons(w.activityLog)).toEqual([
      'refresh_session_not_found',
    ]);
    expect(w.sessionRepo.rows).toHaveLength(1);
    expect(w.sessionRepo.rows[0].revoked_at).toBeNull();
    const ok = await w.service.refresh({ refreshToken: live.refreshToken });
    expect(ok.statusCode).toBe(200);
  });

  it('⭐ deploy’dan oldin kirgan foydalanuvchi (faqat admins.refresh_token) — chiqarib yuborilmaydi: sessiya qatori yaratiladi', async () => {
    const w = makeWorld();
    const iat = Math.floor(Date.now() / 1000) - 3600;
    const legacy = await w.jwt.signAsync(
      { sub: '25', username: null, roles: ['courier'], iat },
      { secret: REFRESH_KEY, expiresIn: '1d' },
    );
    w.users.get('25')!.refresh_token = sha256(legacy);

    const first = await requestContext.run({ traceId: 't', ...PHONE_CTX }, () =>
      w.service.refresh({ refreshToken: legacy }),
    );
    expect(first.statusCode).toBe(200);
    expect(w.sessionRepo.rows).toHaveLength(1);
    const row = w.sessionRepo.rows[0];
    expect(row).toMatchObject({
      user_id: '25',
      method: 'legacy',
      refresh_token_hash: sha256(legacy),
      device_name: 'Telefon · Android · Chrome',
      ip: '203.0.113.7',
    });
    expect(row.created_at.getTime()).toBe(iat * 1000);
    expect(row.expires_at.getTime()).toBe(first.refresh_token_expires_at);
    expect(w.sidOf(first.accessToken)).toBe(row.id);

    // Keyingi refresh — o'sha qator (takroriy qator yo'q).
    await w.service.refresh({ refreshToken: legacy });
    expect(w.sessionRepo.rows).toHaveLength(1);

    // Endi u oddiy sessiya: ro'yxatda ko'rinadi va logout faqat uni yopadi.
    const list = await w.service.listSessions({ userId: '25' });
    expect(list.data.active_count).toBe(1);
  });

  it('legacy: ikki tab bir vaqtda — ikkinchi INSERT UNIQUE’ga uriladi, mavjud qator ishlatiladi', async () => {
    const w = makeWorld();
    const legacy = await w.jwt.signAsync(
      { sub: '25', username: null },
      { secret: REFRESH_KEY, expiresIn: '1d' },
    );
    w.users.get('25')!.refresh_token = sha256(legacy);

    const [a, b] = await Promise.all([
      w.service.refresh({ refreshToken: legacy }),
      w.service.refresh({ refreshToken: legacy }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(w.sessionRepo.rows).toHaveLength(1);
    expect(w.sidOf(a.accessToken)).toBe(w.sidOf(b.accessToken));
  });

  it('legacy token, lekin parol almashgan (eski ustun tozalangan) — 401, qator yaratilmaydi', async () => {
    const w = makeWorld();
    const legacy = await w.jwt.signAsync(
      { sub: '25', username: null },
      { secret: REFRESH_KEY, expiresIn: '1d' },
    );
    w.users.get('25')!.refresh_token = sha256(legacy);
    invalidateAllSessions(w.users.get('25') as never);

    const err = await errorOf(w.service.refresh({ refreshToken: legacy }));
    expect(err.statusCode).toBe(401);
    expect(w.sessionRepo.rows).toHaveLength(0);
  });

  it('bloklangan / o‘chirilgan foydalanuvchi — 401 (avvalgidek)', async () => {
    const w = makeWorld();
    const res = await w.login('25');
    w.users.get('25')!.status = 'inactive';
    expect(
      (await errorOf(w.service.refresh({ refreshToken: res.refreshToken })))
        .statusCode,
    ).toBe(401);
    w.users.get('25')!.status = 'active';
    w.users.get('25')!.isDeleted = true;
    expect(
      (await errorOf(w.service.refresh({ refreshToken: res.refreshToken })))
        .statusCode,
    ).toBe(401);
  });
});

describe('Elchi Pochta #3 — xavfsizlik: barcha sessiyalar yopiladi', () => {
  it('⭐ invalidateAllSessions (parol/telefon/rol, bloklash, o‘chirish) — IKKALA qurilma 401, qatorlar security_reset', async () => {
    const w = makeWorld();
    const phone = await w.login('25');
    const laptop = await w.login('25');
    const user = w.users.get('25')!;
    invalidateAllSessions(user as never);
    expect(user.session_epoch).toBe(1);
    expect(user.refresh_token).toBeNull();

    for (const token of [phone.refreshToken, laptop.refreshToken]) {
      expect(
        (await errorOf(w.service.refresh({ refreshToken: token }))).statusCode,
      ).toBe(401);
    }
    expect(w.sessionRepo.rows.map((r) => r.revoke_reason)).toEqual([
      'security_reset',
      'security_reset',
    ]);
    // Ro'yxat ham darhol bo'sh (soatlik belgilashni kutmaydi).
    const list = await w.service.listSessions({ userId: '25' });
    expect(list.data).toEqual({ active_count: 0, sessions: [] });

    // Yangi login (yangi parol bilan) — ishlaydi.
    const fresh = await w.login('25');
    expect(
      (await w.service.refresh({ refreshToken: fresh.refreshToken }))
        .statusCode,
    ).toBe(200);
  });

  it('parol hashi QAYSI yo‘l bilan almashmasin (invalidateAllSessions chaqirilmasa ham) — sessiyalar yaroqsiz', async () => {
    const w = makeWorld();
    const res = await w.login('25');
    w.users.get('25')!.password = 'bcrypt-hash-NEW';

    expect(
      (await errorOf(w.service.refresh({ refreshToken: res.refreshToken })))
        .statusCode,
    ).toBe(401);
    const failure = (w.activityLog.log.mock.calls as Array<[LogEntry]>)
      .map(([entry]) => entry)
      .find((entry) => entry.action === 'auth_failure');
    expect(failure?.metadata).toMatchObject({
      reason: 'refresh_session_revoked',
      cause: 'password_changed',
    });
    expect(w.sessionRepo.rows[0].revoke_reason).toBe('security_reset');
  });

  it('boshqa foydalanuvchining xavfsizlik hodisasi bu akkauntga ta’sir qilmaydi', async () => {
    const w = makeWorld();
    const mine = await w.login('25');
    await w.login('26');
    invalidateAllSessions(w.users.get('26') as never);
    expect(
      (await w.service.refresh({ refreshToken: mine.refreshToken })).statusCode,
    ).toBe(200);
  });
});

describe('Elchi Pochta #3 — logout faqat joriy sessiyani yopadi', () => {
  it('⭐ `sid` bo‘yicha: telefon chiqadi, noutbuk ishlashda davom etadi', async () => {
    const w = makeWorld();
    const phone = await w.login('25');
    const laptop = await w.login('25');

    const res = await w.service.logout('25', {
      sessionId: w.sidOf(phone.accessToken),
    });
    expect(res).toEqual(
      expect.objectContaining({
        statusCode: 200,
        message: 'Logged out successfully',
      }),
    );
    expect(w.sessionRepo.rows.map((r) => r.revoke_reason)).toEqual([
      'logout',
      null,
    ]);
    expect(
      (await errorOf(w.service.refresh({ refreshToken: phone.refreshToken })))
        .statusCode,
    ).toBe(401);
    expect(
      (await w.service.refresh({ refreshToken: laptop.refreshToken }))
        .statusCode,
    ).toBe(200);
    // Eski ustunda noutbuk (oxirgi login) hashi qoladi — rollback uchun.
    expect(w.users.get('25')!.refresh_token).toBe(sha256(laptop.refreshToken));
  });

  it('cookie bo‘yicha (`sid` siz eski access token) — o‘sha sessiya yopiladi; eski ustun shu sessiyaniki bo‘lsa tozalanadi', async () => {
    const w = makeWorld();
    const first = await w.login('25');
    const last = await w.login('25');

    await w.service.logout('25', { refreshToken: last.refreshToken });
    expect(w.sessionRepo.rows.map((r) => r.revoke_reason)).toEqual([
      null,
      'logout',
    ]);
    expect(w.users.get('25')!.refresh_token).toBeNull();
    expect(
      (await w.service.refresh({ refreshToken: first.refreshToken }))
        .statusCode,
    ).toBe(200);
  });

  it('`sid` bo‘yicha oxirgi login yopilsa eski ustun ham tozalanadi (rollback’da tirilmaydi)', async () => {
    const w = makeWorld();
    const res = await w.login('25');
    await w.service.logout('25', { sessionId: w.sidOf(res.accessToken) });
    expect(w.users.get('25')!.refresh_token).toBeNull();
  });

  it('⭐ begona sessiyani yopib bo‘lmaydi — boshqa foydalanuvchining sid/cookie’si e’tiborsiz', async () => {
    const w = makeWorld();
    const other = await w.login('26');
    await w.login('25');

    await w.service.logout('25', {
      sessionId: w.sidOf(other.accessToken),
      refreshToken: other.refreshToken,
    });

    const otherRow = w.sessionRepo.rows.find((r) => r.user_id === '26')!;
    expect(otherRow.revoked_at).toBeNull();
    expect(w.users.get('26')!.refresh_token).toBe(sha256(other.refreshToken));
    expect(
      (await w.service.refresh({ refreshToken: other.refreshToken }))
        .statusCode,
    ).toBe(200);
  });

  it('noto‘g‘ri `sid` (UUID emas) — so‘rov yuborilmaydi, xato yo‘q', async () => {
    const w = makeWorld();
    await w.login('25');
    w.sessionRepo.update.mockClear();
    const res = await w.service.logout('25', { sessionId: "1' OR 1=1" });
    expect(res.statusCode).toBe(200);
    expect(w.sessionRepo.update).not.toHaveBeenCalled();
    expect(w.sessionRepo.rows[0].revoked_at).toBeNull();
  });

  it('logout javobi: yopilgan sessiya id lari (gateway keshi uchun) — faqat o‘ziniki', async () => {
    const w = makeWorld();
    const mine = await w.login('25');
    const other = await w.login('26');

    const res = await w.service.logout('25', {
      sessionId: w.sidOf(mine.accessToken),
      refreshToken: mine.refreshToken,
    });
    expect(res.data).toEqual({ session_ids: [w.sidOf(mine.accessToken)] });

    // Begona sid/cookie — id qaytmaydi (gateway boshqa odamni bloklamaydi).
    const foreign = await w.service.logout('25', {
      sessionId: w.sidOf(other.accessToken),
      refreshToken: other.refreshToken,
    });
    expect(foreign.data).toEqual({ session_ids: [] });
  });

  it('logout jurnali: nechta sessiya yopilgani', async () => {
    const w = makeWorld();
    const res = await w.login('25');
    await w.service.logout('25', {
      sessionId: w.sidOf(res.accessToken),
      refreshToken: res.refreshToken,
    });
    expect(w.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'logout',
        user_id: '25',
        metadata: { sessions_revoked: 1 },
      }),
    );
  });
});

describe('Elchi Pochta #3 — GET /auth/sessions (identity.auth.sessions)', () => {
  it('⭐ faqat o‘z faol sessiyalari: soni, qurilma, IP, vaqtlar, joriy belgi; token/hash chiqmaydi', async () => {
    const w = makeWorld();
    const phone = await w.login('25', PHONE_CTX);
    const laptop = await w.login('25', LAPTOP_CTX);
    const closed = await w.login('25');
    await w.service.logout('25', { sessionId: w.sidOf(closed.accessToken) });
    await w.login('26', LAPTOP_CTX); // boshqa foydalanuvchi
    // Telefon keyinroq faol bo'lgan — ro'yxatda birinchi.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await w.service.refresh({ refreshToken: phone.refreshToken });

    const res = await w.service.listSessions({
      userId: '25',
      sessionId: w.sidOf(laptop.accessToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.active_count).toBe(2);
    expect(res.data.sessions.map((s) => s.device_name)).toEqual([
      'Telefon · Android · Chrome',
      'Kompyuter · Windows · Chrome',
    ]);
    expect(res.data.sessions.map((s) => s.current)).toEqual([false, true]);
    const current = res.data.sessions[1];
    expect(Object.keys(current).sort()).toEqual([
      'current',
      'device_id',
      'device_name',
      'expires_at',
      'id',
      'ip',
      'last_seen_at',
      'logged_in_at',
      'user_agent',
    ]);
    expect(current).toMatchObject({
      id: w.sidOf(laptop.accessToken),
      device_name: 'Kompyuter · Windows · Chrome',
      device_id: 'dev-laptop-1',
      user_agent: LAPTOP_CTX.user_agent,
      ip: '198.51.100.20',
      expires_at: new Date(laptop.refresh_token_expires_at!).toISOString(),
      current: true,
    });
    expect(current.logged_in_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(current.last_seen_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    const serialized = JSON.stringify(res);
    for (const secret of [
      phone.refreshToken,
      laptop.refreshToken,
      sha256(phone.refreshToken),
      'password_fp',
      'epoch',
      'user_id',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('`sid` siz token (Telegram / eski) — hech biri current emas', async () => {
    const w = makeWorld();
    await w.login('25');
    const res = await w.service.listSessions({ userId: '25' });
    expect(res.data.sessions.map((s) => s.current)).toEqual([false]);
  });

  it('bloklangan / topilmagan foydalanuvchi — 401', async () => {
    const w = makeWorld();
    w.users.get('25')!.status = 'inactive';
    expect(
      (await errorOf(w.service.listSessions({ userId: '25' }))).statusCode,
    ).toBe(401);
    expect(
      (await errorOf(w.service.listSessions({ userId: '999' }))).statusCode,
    ).toBe(401);
  });
});

describe('Elchi Pochta #3 — AuthSessionService.cleanup', () => {
  it('epoch eskirganlarni belgilaydi (SQL) va retention’dan o‘tganlarni partiyalab o‘chiradi', async () => {
    const repo = makeSessionRepo();
    repo.query.mockResolvedValue([[], 3]);
    const now = new Date('2026-10-21T00:00:00Z');
    const day = 24 * 3600_000;
    const at = (id: string, offsetMs: number) =>
      repo.create({ id, expires_at: new Date(now.getTime() + offsetMs) });
    repo.rows.push(
      at('old', -31 * day),
      at('recent', -2 * day),
      at('live', day),
    );
    const service = new AuthSessionService(repo as never);
    jest
      .spyOn(
        (service as unknown as { logger: { log: () => void } }).logger,
        'log',
      )
      .mockImplementation(() => undefined);

    expect(SESSION_RETENTION_DAYS).toBe(30);
    expect(await service.cleanup(now)).toEqual({ reset: 3, deleted: 1 });
    expect(repo.rows.map((r) => r.id)).toEqual(['recent', 'live']);
    const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"session_epoch"');
    expect(sql).toContain("'security_reset'");
    expect(params).toEqual([now]);
  });
});

type RevokeLogEntry = {
  action: string;
  metadata: Record<string, unknown>;
  description?: string;
};
const ownerRevokeLogs = (activityLog: { log: jest.Mock }) =>
  (activityLog.log.mock.calls as Array<[RevokeLogEntry]>)
    .map(([entry]) => entry)
    .filter((entry) => entry.metadata && 'scope' in entry.metadata);

describe('Elchi Pochta #3 — egasi boshqa sessiyasini yopadi (identity.auth.sessions.revoke)', () => {
  it('⭐ noutbukdan telefon sessiyasi yopiladi: 200 {revoked:1, session_ids}, revoked_by_owner, telefon refresh 401, noutbuk ishlaydi', async () => {
    const w = makeWorld();
    const phone = await w.login('25', PHONE_CTX);
    const laptop = await w.login('25', LAPTOP_CTX);
    const phoneSid = w.sidOf(phone.accessToken)!;
    const laptopSid = w.sidOf(laptop.accessToken)!;

    const res = await w.service.revokeSession({
      userId: '25',
      sessionId: phoneSid,
      currentSessionId: laptopSid,
    });

    expect(res).toEqual({
      statusCode: 200,
      message: 'Sessiya yopildi',
      data: { revoked: 1, session_ids: [phoneSid] },
    });
    const phoneRow = w.sessionRepo.rows.find((r) => r.id === phoneSid)!;
    expect(phoneRow.revoke_reason).toBe('revoked_by_owner');
    expect(phoneRow.revoked_at).toBeInstanceOf(Date);
    expect(
      w.sessionRepo.rows.find((r) => r.id === laptopSid)!.revoked_at,
    ).toBeNull();

    // Telefon: refresh 401 → FE login sahifasiga; noutbuk: davom etadi.
    const err = await errorOf(
      w.service.refresh({ refreshToken: phone.refreshToken }),
    );
    expect(err).toEqual(
      expect.objectContaining({
        statusCode: 401,
        message: 'Invalid refresh token',
      }),
    );
    expect(failureReasons(w.activityLog)).toEqual(['refresh_session_revoked']);
    expect(
      (await w.service.refresh({ refreshToken: laptop.refreshToken }))
        .statusCode,
    ).toBe(200);

    // Gateway tekshiruvi: telefon yopilgan, noutbuk ochiq.
    expect(
      await w.service.sessionState({ userId: '25', sessionId: phoneSid }),
    ).toEqual({ active: false });
    expect(
      await w.service.sessionState({ userId: '25', sessionId: laptopSid }),
    ).toEqual({ active: true });

    // Ro'yxatda faqat noutbuk qoldi.
    const list = await w.service.listSessions({
      userId: '25',
      sessionId: laptopSid,
    });
    expect(list.data.sessions.map((s) => s.id)).toEqual([laptopSid]);
  });

  it('joriy sessiya → 400 (katta harfli id bilan ham), hech narsa yopilmaydi', async () => {
    const w = makeWorld();
    const res = await w.login('25');
    const sid = w.sidOf(res.accessToken)!;

    for (const sessionId of [sid, sid.toUpperCase()]) {
      const err = await errorOf(
        w.service.revokeSession({
          userId: '25',
          sessionId,
          currentSessionId: sid,
        }),
      );
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message:
            "Joriy sessiyani bu yerdan yopib bo'lmaydi — «Chiqish» tugmasidan foydalaning",
        }),
      );
    }
    expect(w.sessionRepo.rows[0].revoked_at).toBeNull();
  });

  it('id UUID emas → 400, bazaga so‘rov yo‘q', async () => {
    const w = makeWorld();
    const res = await w.login('25');
    w.sessionRepo.update.mockClear();
    for (const sessionId of ["1' OR 1=1", '', null, '42']) {
      const err = await errorOf(
        w.service.revokeSession({
          userId: '25',
          sessionId,
          currentSessionId: w.sidOf(res.accessToken),
        }),
      );
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: "Sessiya identifikatori noto'g'ri",
        }),
      );
    }
    expect(w.sessionRepo.update).not.toHaveBeenCalled();
  });

  it('⭐ begona / yo‘q / allaqachon yopilgan sessiya → bir xil 404; begona sessiya OCHIQ qoladi', async () => {
    const w = makeWorld();
    const mine = await w.login('25');
    const closed = await w.login('25');
    const other = await w.login('26');
    await w.service.logout('25', { sessionId: w.sidOf(closed.accessToken) });
    const current = w.sidOf(mine.accessToken);

    for (const sessionId of [
      w.sidOf(other.accessToken),
      w.sidOf(closed.accessToken),
      '00000000-0000-4000-8000-000000000000',
    ]) {
      const err = await errorOf(
        w.service.revokeSession({
          userId: '25',
          sessionId,
          currentSessionId: current,
        }),
      );
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 404,
          message: 'Sessiya topilmadi yoki allaqachon yopilgan',
        }),
      );
    }
    const otherRow = w.sessionRepo.rows.find((r) => r.user_id === '26')!;
    expect(otherRow.revoked_at).toBeNull();
    const closedRow = w.sessionRepo.rows.find(
      (r) => r.id === w.sidOf(closed.accessToken),
    )!;
    expect(closedRow.revoke_reason).toBe('logout');
    expect(
      (await w.service.refresh({ refreshToken: other.refreshToken }))
        .statusCode,
    ).toBe(200);
    expect(ownerRevokeLogs(w.activityLog)).toEqual([]);
  });

  it('`sid` siz token (eski / Telegram) ham boshqa sessiyani yopa oladi', async () => {
    const w = makeWorld();
    const phone = await w.login('25');
    const res = await w.service.revokeSession({
      userId: '25',
      sessionId: w.sidOf(phone.accessToken),
      currentSessionId: null,
    });
    expect(res.data.revoked).toBe(1);
  });

  it('yopilgan sessiya tokeni (gateway keshi yangilanguncha) boshqa sessiyani yopa olmaydi → 401', async () => {
    const w = makeWorld();
    const owner = await w.login('25');
    const thief = await w.login('25');
    await w.service.revokeSession({
      userId: '25',
      sessionId: w.sidOf(thief.accessToken),
      currentSessionId: w.sidOf(owner.accessToken),
    });

    const err = await errorOf(
      w.service.revokeSession({
        userId: '25',
        sessionId: w.sidOf(owner.accessToken),
        currentSessionId: w.sidOf(thief.accessToken),
      }),
    );
    expect(err).toEqual(
      expect.objectContaining({ statusCode: 401, message: 'Session revoked' }),
    );
    expect(
      w.sessionRepo.rows.find((r) => r.id === w.sidOf(owner.accessToken))!
        .revoked_at,
    ).toBeNull();
  });

  it('bloklangan / topilmagan foydalanuvchi → 401', async () => {
    const w = makeWorld();
    const res = await w.login('25');
    w.users.get('25')!.status = 'inactive';
    expect(
      (
        await errorOf(
          w.service.revokeSession({
            userId: '25',
            sessionId: w.sidOf(res.accessToken),
          }),
        )
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await errorOf(
          w.service.revokeOtherSessions({
            userId: '999',
            currentSessionId: w.sidOf(res.accessToken),
          }),
        )
      ).statusCode,
    ).toBe(401);
  });

  it('eski ustun: yopilgan sessiyaning hashi tozalanadi; boshqa (ochiq) sessiyaniki qoladi', async () => {
    const w = makeWorld();
    const phone = await w.login('25');
    const laptop = await w.login('25');
    const tablet = await w.login('25');
    const user = w.users.get('25')!;

    // Ustunda telefon hashi — telefon yopilsa tozalanadi.
    user.refresh_token = sha256(phone.refreshToken);
    await w.service.revokeSession({
      userId: '25',
      sessionId: w.sidOf(phone.accessToken),
      currentSessionId: w.sidOf(laptop.accessToken),
    });
    expect(user.refresh_token).toBeNull();

    // Ustunda noutbuk hashi — planshet yopilsa ustun o'zgarmaydi.
    user.refresh_token = sha256(laptop.refreshToken);
    await w.service.revokeSession({
      userId: '25',
      sessionId: w.sidOf(tablet.accessToken),
      currentSessionId: w.sidOf(laptop.accessToken),
    });
    expect(user.refresh_token).toBe(sha256(laptop.refreshToken));
  });

  it('jurnal: logout fe’li, scope=session, sessions_revoked, session_ids, o‘zbekcha gap', async () => {
    const w = makeWorld();
    const phone = await w.login('25');
    const laptop = await w.login('25');
    await w.service.revokeSession({
      userId: '25',
      sessionId: w.sidOf(phone.accessToken),
      currentSessionId: w.sidOf(laptop.accessToken),
    });
    expect(w.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Auth',
        action: 'logout',
        user_id: '25',
        metadata: {
          scope: 'session',
          sessions_revoked: 1,
          session_ids: [w.sidOf(phone.accessToken)],
        },
        description: 'Boshqa qurilmadagi sessiya yopildi',
      }),
    );
  });
});

describe('Elchi Pochta #3 — boshqa sessiyalardan chiqish (identity.auth.sessions.revoke_others)', () => {
  it('⭐ joriydan boshqa hammasi yopiladi; joriy, begona va avval yopilgan sessiya o‘zgarmaydi', async () => {
    const w = makeWorld();
    const phone = await w.login('25', PHONE_CTX);
    const laptop = await w.login('25', LAPTOP_CTX);
    const tablet = await w.login('25');
    const closed = await w.login('25');
    const other = await w.login('26');
    await w.service.logout('25', { sessionId: w.sidOf(closed.accessToken) });
    const closedAt = w.sessionRepo.rows.find(
      (r) => r.id === w.sidOf(closed.accessToken),
    )!.revoked_at;

    const res = await w.service.revokeOtherSessions({
      userId: '25',
      currentSessionId: w.sidOf(laptop.accessToken),
    });

    expect(res.statusCode).toBe(200);
    expect(res.message).toBe('Boshqa sessiyalardan chiqildi');
    expect(res.data.revoked).toBe(2);
    expect([...res.data.session_ids].sort()).toEqual(
      [w.sidOf(phone.accessToken)!, w.sidOf(tablet.accessToken)!].sort(),
    );
    const reasonOf = (token: string) =>
      w.sessionRepo.rows.find((r) => r.id === w.sidOf(token))!.revoke_reason;
    expect(reasonOf(phone.accessToken)).toBe('revoked_by_owner');
    expect(reasonOf(tablet.accessToken)).toBe('revoked_by_owner');
    expect(reasonOf(laptop.accessToken)).toBeNull();
    expect(reasonOf(closed.accessToken)).toBe('logout');
    expect(
      w.sessionRepo.rows.find((r) => r.id === w.sidOf(closed.accessToken))!
        .revoked_at,
    ).toBe(closedAt);
    expect(reasonOf(other.accessToken)).toBeNull();

    for (const token of [phone.refreshToken, tablet.refreshToken]) {
      expect(
        (await errorOf(w.service.refresh({ refreshToken: token }))).statusCode,
      ).toBe(401);
    }
    expect(
      (await w.service.refresh({ refreshToken: laptop.refreshToken }))
        .statusCode,
    ).toBe(200);
    expect(
      (await w.service.refresh({ refreshToken: other.refreshToken }))
        .statusCode,
    ).toBe(200);

    const list = await w.service.listSessions({
      userId: '25',
      sessionId: w.sidOf(laptop.accessToken),
    });
    expect(list.data.active_count).toBe(1);
    expect(list.data.sessions[0].current).toBe(true);

    // SQL parametrlari: user_id va saqlanadigan (joriy) sessiya.
    const [sql, params] = w.sessionRepo.query.mock.calls.at(-1) as [
      string,
      unknown[],
    ];
    expect(sql).toMatch(/"user_id" = \$3/);
    expect(sql).toMatch(/"revoked_at" IS NULL/);
    expect(sql).toMatch(/"id" <> \$4/);
    expect(params.slice(1)).toEqual([
      'revoked_by_owner',
      '25',
      w.sidOf(laptop.accessToken),
    ]);
  });

  it('boshqa sessiya yo‘q → 200, revoked: 0', async () => {
    const w = makeWorld();
    const only = await w.login('25');
    const res = await w.service.revokeOtherSessions({
      userId: '25',
      currentSessionId: w.sidOf(only.accessToken),
    });
    expect(res).toEqual({
      statusCode: 200,
      message: "Boshqa faol sessiya yo'q",
      data: { revoked: 0, session_ids: [] },
    });
    expect(w.sessionRepo.rows[0].revoked_at).toBeNull();
  });

  it('⭐ `sid` siz / noto‘g‘ri sid → 400 «Joriy sessiya aniqlanmadi — qayta kiring», hech narsa yopilmaydi', async () => {
    const w = makeWorld();
    await w.login('25');
    await w.login('25');
    for (const currentSessionId of [null, undefined, '', 'not-a-uuid']) {
      const err = await errorOf(
        w.service.revokeOtherSessions({ userId: '25', currentSessionId }),
      );
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: 'Joriy sessiya aniqlanmadi — qayta kiring',
        }),
      );
    }
    expect(w.sessionRepo.rows.every((r) => r.revoked_at === null)).toBe(true);
  });

  it('yopilgan sessiya tokeni egasining boshqa sessiyalarini yopa olmaydi → 401', async () => {
    const w = makeWorld();
    const owner = await w.login('25');
    const thief = await w.login('25');
    await w.service.revokeSession({
      userId: '25',
      sessionId: w.sidOf(thief.accessToken),
      currentSessionId: w.sidOf(owner.accessToken),
    });
    const err = await errorOf(
      w.service.revokeOtherSessions({
        userId: '25',
        currentSessionId: w.sidOf(thief.accessToken),
      }),
    );
    expect(err.statusCode).toBe(401);
    expect(
      w.sessionRepo.rows.find((r) => r.id === w.sidOf(owner.accessToken))!
        .revoked_at,
    ).toBeNull();
  });

  it('⭐ legacy: eski ustundagi qatorsiz (hali qabul qilinmagan) hash tozalanadi — o‘sha qurilma adoptLegacy bilan qaytolmaydi', async () => {
    const w = makeWorld();
    const current = await w.login('25');
    const legacy = await w.jwt.signAsync(
      { sub: '25', username: null, jti: 'legacy-device' },
      { secret: REFRESH_KEY, expiresIn: '1d' },
    );
    const user = w.users.get('25')!;
    user.refresh_token = sha256(legacy);

    const res = await w.service.revokeOtherSessions({
      userId: '25',
      currentSessionId: w.sidOf(current.accessToken),
    });
    expect(res.data.revoked).toBe(0);
    expect(user.refresh_token).toBeNull();

    const err = await errorOf(w.service.refresh({ refreshToken: legacy }));
    expect(err.statusCode).toBe(401);
    expect(failureReasons(w.activityLog)).toEqual([
      'refresh_session_not_found',
    ]);
    expect(w.sessionRepo.rows).toHaveLength(1);
  });

  it('legacy: eski ustunda JORIY sessiya hashi bo‘lsa — saqlanadi (rollback uchun)', async () => {
    const w = makeWorld();
    await w.login('25');
    const current = await w.login('25');
    const user = w.users.get('25')!;
    expect(user.refresh_token).toBe(sha256(current.refreshToken));

    await w.service.revokeOtherSessions({
      userId: '25',
      currentSessionId: w.sidOf(current.accessToken),
    });
    expect(user.refresh_token).toBe(sha256(current.refreshToken));
  });

  it('legacy: eski ustunda yopilgan BOSHQA sessiya hashi — tozalanadi', async () => {
    const w = makeWorld();
    const current = await w.login('25');
    const phone = await w.login('25');
    const user = w.users.get('25')!;
    expect(user.refresh_token).toBe(sha256(phone.refreshToken));

    await w.service.revokeOtherSessions({
      userId: '25',
      currentSessionId: w.sidOf(current.accessToken),
    });
    expect(user.refresh_token).toBeNull();
  });

  it('jurnal: scope=others, soni va id lar, o‘zbekcha gap', async () => {
    const w = makeWorld();
    const current = await w.login('25');
    const phone = await w.login('25');
    await w.service.revokeOtherSessions({
      userId: '25',
      currentSessionId: w.sidOf(current.accessToken),
    });
    expect(ownerRevokeLogs(w.activityLog)).toEqual([
      expect.objectContaining({
        action: 'logout',
        metadata: {
          scope: 'others',
          sessions_revoked: 1,
          session_ids: [w.sidOf(phone.accessToken)],
        },
        description: 'Boshqa sessiyalardan chiqildi: 1 ta',
      }),
    ]);
  });
});

describe('Elchi Pochta #3 — identity.auth.session_state (gateway JwtStrategy)', () => {
  it('⭐ ochiq o‘z sessiyasi — active; logout / egasi yopgani / begona / yo‘q — active: false', async () => {
    const w = makeWorld();
    const open = await w.login('25');
    const loggedOut = await w.login('25');
    const other = await w.login('26');
    await w.service.logout('25', {
      sessionId: w.sidOf(loggedOut.accessToken),
    });

    const state = (userId: unknown, sessionId: unknown) =>
      w.service.sessionState({ userId, sessionId });
    expect(await state('25', w.sidOf(open.accessToken))).toEqual({
      active: true,
    });
    // Katta harfli id ham (UUID registrga bog'liq emas).
    expect(await state('25', w.sidOf(open.accessToken)!.toUpperCase())).toEqual(
      { active: true },
    );
    expect(await state('25', w.sidOf(loggedOut.accessToken))).toEqual({
      active: false,
    });
    expect(await state('25', w.sidOf(other.accessToken))).toEqual({
      active: false,
    });
    expect(await state('25', '00000000-0000-4000-8000-000000000000')).toEqual({
      active: false,
    });
  });

  it('noto‘g‘ri kirish — bazaga so‘rovsiz active: false', async () => {
    const w = makeWorld();
    await w.login('25');
    w.sessionRepo.findOne.mockClear();
    for (const [userId, sessionId] of [
      ['25', 'nope'],
      [null, '00000000-0000-4000-8000-000000000000'],
      ["25' OR 1=1", '00000000-0000-4000-8000-000000000000'],
      [{}, {}],
    ] as Array<[unknown, unknown]>) {
      expect(await w.service.sessionState({ userId, sessionId })).toEqual({
        active: false,
      });
    }
    expect(w.sessionRepo.findOne).not.toHaveBeenCalled();
  });

  it('epoch (parol almashgan) — bu yerda hali active: xulq o‘zgarmagan, refresh’da 401', async () => {
    const w = makeWorld();
    const res = await w.login('25');
    invalidateAllSessions(w.users.get('25') as never);
    expect(
      await w.service.sessionState({
        userId: '25',
        sessionId: w.sidOf(res.accessToken),
      }),
    ).toEqual({ active: true });
    expect(
      (await errorOf(w.service.refresh({ refreshToken: res.refreshToken })))
        .statusCode,
    ).toBe(401);
    // Refresh qatorga security_reset yozdi — endi gateway ham 401 beradi.
    expect(
      await w.service.sessionState({
        userId: '25',
        sessionId: w.sidOf(res.accessToken),
      }),
    ).toEqual({ active: false });
  });
});

describe('Elchi Pochta #3 — identity.controller: yangi RMQ handlerlari', () => {
  const SID = '3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d';
  const patternOf = (method: keyof IdentityController) =>
    Reflect.getMetadata(
      PATTERN_METADATA,
      Object.getOwnPropertyDescriptor(IdentityController.prototype, method)
        ?.value as object,
    ) as unknown;

  it('pattern nomlari: revoke / revoke_others / session_state', () => {
    expect(patternOf('revokeSession')).toEqual([
      { cmd: 'identity.auth.sessions.revoke' },
    ]);
    expect(patternOf('revokeOtherSessions')).toEqual([
      { cmd: 'identity.auth.sessions.revoke_others' },
    ]);
    expect(patternOf('sessionState')).toEqual([
      { cmd: 'identity.auth.session_state' },
    ]);
  });

  it('AuthService ga aynan JWT dagi sub/sid uzatiladi va xabar ack qilinadi', async () => {
    const auth = {
      revokeSession: jest.fn().mockResolvedValue('one'),
      revokeOtherSessions: jest.fn().mockResolvedValue('others'),
      sessionState: jest.fn().mockResolvedValue({ active: true }),
    };
    const rmq = { ack: jest.fn(), nackForError: jest.fn() };
    const controller = new IdentityController(
      rmq as never,
      {} as never,
      auth as never,
      {} as never,
    );
    const ctx = { getPattern: () => 'p' } as never;

    await expect(
      controller.revokeSession(
        { userId: '25', sessionId: SID, currentSessionId: null },
        ctx,
      ),
    ).resolves.toBe('one');
    expect(auth.revokeSession).toHaveBeenCalledWith({
      userId: '25',
      sessionId: SID,
      currentSessionId: null,
    });
    await expect(
      controller.revokeOtherSessions({ userId: '25' }, ctx),
    ).resolves.toBe('others');
    expect(auth.revokeOtherSessions).toHaveBeenCalledWith({
      userId: '25',
      currentSessionId: null,
    });
    await expect(
      controller.sessionState({ userId: '25', sessionId: SID }, ctx),
    ).resolves.toEqual({ active: true });
    expect(rmq.ack).toHaveBeenCalledTimes(3);
  });
});
