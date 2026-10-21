import { createHash } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { FindOperator } from 'typeorm';
import { requestContext } from '@app/common';
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
    query: jest.fn().mockResolvedValue([[], 0]),
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
