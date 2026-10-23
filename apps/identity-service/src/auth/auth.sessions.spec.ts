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
 *  - ro'yxat: faqat o'ziniki, active_count, joriy belgi, tartib, holat;
 *  - bitta qurilma — bitta sessiya (2026-10-23): qayta kirish AYNI qatorni
 *    yangilaydi, aniq yopilgani (logout / egasi / xavfsizlik) — yangi qator.
 * Haqiqiy SQL (UNIQUE, FK, tozalash so'rovi, dedup migratsiyasi) —
 * `user-sessions.pg.spec.ts`.
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

/**
 * TypeORM `where` ning shu spec'ga kerakli qismi (IsNull, MoreThan,
 * LessThan, Between, Not; massiv — OR).
 */
function matches(row: object, where: Where | Where[]): boolean {
  if (Array.isArray(where)) return where.some((w) => matches(row, w));
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
        case 'between': {
          const [from, to] = cond.value as unknown as [Date, Date];
          return Number(actual) >= Number(from) && Number(actual) <= Number(to);
        }
        case 'not':
          return actual !== cond.value;
        default:
          throw new Error(`fake repo: ${cond.type} qo'llanmaydi`);
      }
    }
    return actual === cond;
  });
}

/** `order: { last_seen_at: 'DESC', created_at: 'DESC' }` — sanalar bo'yicha. */
function sortBy(rows: UserSession[], order?: Record<string, 'ASC' | 'DESC'>) {
  const keys = Object.entries(order ?? { last_seen_at: 'DESC' });
  return [...rows].sort((a, b) => {
    for (const [key, dir] of keys) {
      const diff =
        Number((a as unknown as Record<string, Date>)[key]) -
        Number((b as unknown as Record<string, Date>)[key]);
      if (diff) return dir === 'DESC' ? -diff : diff;
    }
    return 0;
  });
}

const isOpenRow = (r: UserSession) =>
  r.revoked_at === null || r.revoked_at === undefined;

function makeSessionRepo() {
  const rows: UserSession[] = [];
  return {
    rows,
    create: (value: Partial<UserSession>) => ({ ...value }) as UserSession,
    insert: jest.fn((value: UserSession) => {
      // UQ_USER_SESSIONS_REFRESH_HASH va UQ_USER_SESSIONS_USER_DEVICE_OPEN.
      const deviceTaken =
        Boolean(value.device_id) &&
        isOpenRow(value) &&
        rows.some(
          (r) =>
            isOpenRow(r) &&
            r.user_id === value.user_id &&
            r.device_id === value.device_id,
        );
      if (
        deviceTaken ||
        rows.some((r) => r.refresh_token_hash === value.refresh_token_hash)
      ) {
        return Promise.reject(
          Object.assign(new Error('duplicate key'), { code: '23505' }),
        );
      }
      rows.push({ ...value });
      return Promise.resolve({});
    }),
    findOne: jest.fn(({ where }: { where: Where | Where[] }) => {
      const hit = rows.find((r) => matches(r, where));
      return Promise.resolve(hit ? { ...hit } : null);
    }),
    update: jest.fn((where: Where, patch: Partial<UserSession>) => {
      const hits = rows.filter((r) => matches(r, where));
      hits.forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ affected: hits.length });
    }),
    findAndCount: jest.fn(
      ({
        where,
        take,
        order,
      }: {
        where: Where;
        take: number;
        order?: Record<string, 'ASC' | 'DESC'>;
      }) => {
        const hits = sortBy(
          rows.filter((r) => matches(r, where)),
          order,
        );
        return Promise.resolve([
          hits.slice(0, take).map((r) => ({ ...r })),
          hits.length,
        ]);
      },
    ),
    find: jest.fn(
      ({
        where,
        take,
        order,
      }: {
        where: Where | Where[];
        take: number;
        order?: Record<string, 'ASC' | 'DESC'>;
      }) =>
        Promise.resolve(
          (order
            ? sortBy(
                rows.filter((r) => matches(r, where)),
                order,
              )
            : rows.filter((r) => matches(r, where))
          )
            .slice(0, take ?? rows.length)
            .map((r) => ({ ...r })),
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
  device_id: 'a1b2c3d4-laptop-device-0001',
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
      device_id: 'a1b2c3d4-laptop-device-0001',
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

const DEVICE_A = 'f3a9c2d1-0b7e-4c55-9e21-7d4c3b2a1f00';
const DEVICE_B = '0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
const PHONE_A_CTX = {
  ip: '203.0.113.7',
  user_agent: PHONE_CTX.user_agent,
  device_name: 'Samsung SM-A515F · Android 13 · Chrome 155',
  device_id: DEVICE_A,
};
const LAPTOP_B_CTX = {
  ip: '198.51.100.20',
  user_agent: LAPTOP_CTX.user_agent,
  device_name: 'Windows 11 · Chrome 154',
  device_id: DEVICE_B,
};
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const openRowsOf = (rows: UserSession[], userId: string, deviceId: string) =>
  rows.filter(
    (r) => r.user_id === userId && r.device_id === deviceId && isOpenRow(r),
  );

describe('Elchi Pochta #3 (2026-10-23) — bitta qurilma, bitta sessiya', () => {
  it('⭐ muddati o‘tgandan keyin qayta login — AYNI qator: id va created_at saqlanadi, last_login_at / muddat / hash yangilanadi; yangi refresh ishlaydi, eskisi 401', async () => {
    const w = makeWorld();
    const first = await w.login('25', PHONE_A_CTX);
    const row = w.sessionRepo.rows[0];
    const sid = w.sidOf(first.accessToken)!;
    const createdAt = row.created_at;
    expect(row.last_login_at).toEqual(createdAt);

    // 1 kunlik refresh tugadi — FE login sahifasiga chiqardi.
    row.expires_at = new Date(Date.now() - 1000);
    expect(
      (await errorOf(w.service.refresh({ refreshToken: first.refreshToken })))
        .statusCode,
    ).toBe(401);
    await tick();

    const second = await w.login('25', {
      ...PHONE_A_CTX,
      ip: '198.51.100.99',
      device_name: 'Samsung SM-A515F · Android 14 · Chrome 156',
    });

    expect(w.sessionRepo.rows).toHaveLength(1);
    expect(w.sidOf(second.accessToken)).toBe(sid);
    expect(row).toMatchObject({
      id: sid,
      created_at: createdAt,
      refresh_token_hash: sha256(second.refreshToken),
      revoked_at: null,
      ip: '198.51.100.99',
      device_name: 'Samsung SM-A515F · Android 14 · Chrome 156',
      device_id: DEVICE_A,
    });
    expect(row.last_login_at.getTime()).toBeGreaterThan(createdAt.getTime());
    expect(row.last_seen_at).toEqual(row.last_login_at);
    expect(row.expires_at.getTime()).toBe(second.refresh_token_expires_at);

    const ok = await w.service.refresh({ refreshToken: second.refreshToken });
    expect(ok.statusCode).toBe(200);
    expect(w.sidOf(ok.accessToken)).toBe(sid);
    w.activityLog.log.mockClear();
    expect(
      (await errorOf(w.service.refresh({ refreshToken: first.refreshToken })))
        .statusCode,
    ).toBe(401);
    expect(failureReasons(w.activityLog)).toEqual([
      'refresh_session_not_found',
    ]);
    // Gateway uchun sessiya ochiq — o'sha `sid`.
    expect(
      await w.service.sessionState({ userId: '25', sessionId: sid }),
    ).toEqual({ active: true });
  });

  it('muddati o‘tmagan (faol) sessiyada qayta login ham AYNI qator (qurilmada bitta sessiya)', async () => {
    const w = makeWorld();
    const first = await w.login('25', PHONE_A_CTX);
    const second = await w.login('25', PHONE_A_CTX);
    expect(w.sessionRepo.rows).toHaveLength(1);
    expect(w.sidOf(second.accessToken)).toBe(w.sidOf(first.accessToken));
    expect(
      (await w.service.refresh({ refreshToken: second.refreshToken }))
        .statusCode,
    ).toBe(200);
  });

  it('OTP login ham shu qurilma sessiyasini qayta ishlatadi (method yangilanadi)', async () => {
    const w = makeWorld();
    const first = await w.login('26', PHONE_A_CTX);
    const otp = await requestContext.run({ traceId: 't', ...PHONE_A_CTX }, () =>
      w.service.sessionForUser(w.users.get('26') as never, 'otp'),
    );
    expect(w.sessionRepo.rows).toHaveLength(1);
    expect(w.sidOf(otp.accessToken)).toBe(w.sidOf(first.accessToken));
    expect(w.sessionRepo.rows[0].method).toBe('otp');
  });

  it.each([
    ['logout', 'logout'],
    ['revoked_by_owner', 'revoked_by_owner'],
  ] as const)(
    '⭐ aniq yopilgan sessiya (%s) QAYTA ISHLATILMAYDI — yangi qator, eskisi yopiqligicha',
    async (how, reason) => {
      const w = makeWorld();
      const first = await w.login('25', PHONE_A_CTX);
      const laptop = await w.login('25', LAPTOP_B_CTX);
      const sid = w.sidOf(first.accessToken)!;
      if (how === 'logout') {
        await w.service.logout('25', { sessionId: sid });
      } else {
        await w.service.revokeSession({
          userId: '25',
          sessionId: sid,
          currentSessionId: w.sidOf(laptop.accessToken),
        });
      }
      const closedAt = w.sessionRepo.rows.find((r) => r.id === sid)!.revoked_at;

      const again = await w.login('25', PHONE_A_CTX);
      const newSid = w.sidOf(again.accessToken)!;
      expect(newSid).not.toBe(sid);
      expect(w.sessionRepo.rows).toHaveLength(3);
      expect(w.sessionRepo.rows.find((r) => r.id === sid)).toMatchObject({
        revoke_reason: reason,
        revoked_at: closedAt,
      });
      expect(openRowsOf(w.sessionRepo.rows, '25', DEVICE_A)).toHaveLength(1);
      // Gateway keshidagi yopilgan sid tirilmaydi.
      expect(
        await w.service.sessionState({ userId: '25', sessionId: sid }),
      ).toEqual({ active: false });
      expect(
        (await w.service.refresh({ refreshToken: again.refreshToken }))
          .statusCode,
      ).toBe(200);
    },
  );

  it('⭐ xavfsizlik hodisasi (epoch) — eski qator security_reset bilan yopiladi, yangi qator ochiladi', async () => {
    const w = makeWorld();
    const first = await w.login('25', PHONE_A_CTX);
    const sid = w.sidOf(first.accessToken)!;
    invalidateAllSessions(w.users.get('25') as never); // qator hali revoked_at=null

    const again = await w.login('25', PHONE_A_CTX);
    expect(w.sidOf(again.accessToken)).not.toBe(sid);
    expect(w.sessionRepo.rows.find((r) => r.id === sid)).toMatchObject({
      revoke_reason: 'security_reset',
    });
    expect(openRowsOf(w.sessionRepo.rows, '25', DEVICE_A)).toEqual([
      expect.objectContaining({ id: w.sidOf(again.accessToken), epoch: 1 }),
    ]);
    expect(
      (await w.service.refresh({ refreshToken: again.refreshToken }))
        .statusCode,
    ).toBe(200);
  });

  it('⭐ parol almashgan (epoch o‘zgarmagan, faqat barmoq izi) — AYNI qator qayta ishlatiladi, parol izi yangilanadi', async () => {
    const w = makeWorld();
    const first = await w.login('25', PHONE_A_CTX);
    w.users.get('25')!.password = 'bcrypt-hash-NEW';

    const list = await w.service.listSessions({ userId: '25' });
    expect(list.data.active_count).toBe(0);
    expect(list.data.sessions.map((s) => s.status)).toEqual(['expired']);

    const again = await w.login('25', PHONE_A_CTX);
    expect(w.sidOf(again.accessToken)).toBe(w.sidOf(first.accessToken));
    expect(w.sessionRepo.rows).toHaveLength(1);
    expect(w.sessionRepo.rows[0].password_fp).toBe(
      passwordFingerprint('bcrypt-hash-NEW'),
    );
    expect(
      (await w.service.refresh({ refreshToken: again.refreshToken }))
        .statusCode,
    ).toBe(200);
  });

  it('⭐ device_id siz (yoki yaroqsiz device_id) — har login yangi qator (avvalgi xulq), device_id saqlanmaydi', async () => {
    const w = makeWorld();
    await w.login('25', PHONE_CTX);
    await w.login('25', PHONE_CTX);
    for (const device_id of [
      'undefined',
      'null',
      'short-id',
      'bad id with spaces!!',
    ]) {
      await w.login('25', { ...PHONE_CTX, device_id });
      await w.login('25', { ...PHONE_CTX, device_id });
    }
    expect(w.sessionRepo.rows).toHaveLength(10);
    expect(w.sessionRepo.rows.every((r) => r.device_id === null)).toBe(true);
    expect(w.sessionRepo.rows.every((r) => r.revoked_at === null)).toBe(true);
  });

  it('⭐ boshqa foydalanuvchi AYNI device_id bilan — alohida qatorlar, bir-biriga tegmaydi', async () => {
    const w = makeWorld();
    const mine = await w.login('25', PHONE_A_CTX);
    const theirs = await w.login('26', PHONE_A_CTX);
    expect(w.sessionRepo.rows).toHaveLength(2);
    expect(w.sidOf(mine.accessToken)).not.toBe(w.sidOf(theirs.accessToken));

    const again = await w.login('25', PHONE_A_CTX);
    expect(w.sessionRepo.rows).toHaveLength(2);
    expect(w.sidOf(again.accessToken)).toBe(w.sidOf(mine.accessToken));
    expect(
      (await w.service.refresh({ refreshToken: theirs.refreshToken }))
        .statusCode,
    ).toBe(200);
  });

  it('⭐ bir qurilmadan ikki login bir vaqtda (ikki tab) — bitta ochiq qator, ikkala access token bitta sid', async () => {
    const w = makeWorld();
    const [a, b] = await Promise.all([
      w.login('25', PHONE_A_CTX),
      w.login('25', PHONE_A_CTX),
    ]);
    expect(w.sessionRepo.rows).toHaveLength(1);
    expect(w.sidOf(a.accessToken)).toBe(w.sidOf(b.accessToken));
    // Qatorda oxirgi yozganning hashi; o'sha token ishlaydi.
    const hash = w.sessionRepo.rows[0].refresh_token_hash;
    expect([sha256(a.refreshToken), sha256(b.refreshToken)]).toContain(hash);
    const winner = hash === sha256(a.refreshToken) ? a : b;
    expect(
      (await w.service.refresh({ refreshToken: winner.refreshToken }))
        .statusCode,
    ).toBe(200);
  });

  it('poyga deterministik: tekshiruvdan keyin boshqa tab qator ochdi → INSERT 23505 → qayta urinish o‘sha qatorni yangilaydi', async () => {
    const w = makeWorld();
    const other = await w.login('25', PHONE_A_CTX); // "birinchi tab" qatori
    // Ikkinchi tab qidirganda qator hali ko'rinmagan (parallel tranzaksiya).
    w.sessionRepo.findOne.mockImplementationOnce(() => Promise.resolve(null));
    w.sessionRepo.insert.mockClear();

    const res = await w.login('25', PHONE_A_CTX);
    expect(w.sessionRepo.insert).toHaveBeenCalledTimes(1);
    await expect(
      w.sessionRepo.insert.mock.results[0].value as Promise<unknown>,
    ).rejects.toMatchObject({ code: '23505' });
    expect(w.sessionRepo.rows).toHaveLength(1);
    expect(w.sidOf(res.accessToken)).toBe(w.sidOf(other.accessToken));
    expect(w.sessionRepo.rows[0].refresh_token_hash).toBe(
      sha256(res.refreshToken),
    );
  });

  it('boshqa (23505 bo‘lmagan) INSERT xatosi yutilmaydi', async () => {
    const w = makeWorld();
    w.sessionRepo.insert.mockImplementationOnce(() =>
      Promise.reject(new Error('connection lost')),
    );
    await expect(w.login('25', PHONE_A_CTX)).rejects.toThrow('connection lost');
  });

  it('legacy token, qurilmada ochiq qator bor (UQ device 23505) — o‘sha qurilma qatori ishlatiladi, takroriy qator yo‘q', async () => {
    const w = makeWorld();
    const live = await w.login('25', PHONE_A_CTX);
    const legacy = await w.jwt.signAsync(
      { sub: '25', username: null, jti: 'legacy-same-device' },
      { secret: REFRESH_KEY, expiresIn: '1d' },
    );
    w.users.get('25')!.refresh_token = sha256(legacy);

    const res = await requestContext.run({ traceId: 't', ...PHONE_A_CTX }, () =>
      w.service.refresh({ refreshToken: legacy }),
    );
    expect(res.statusCode).toBe(200);
    expect(w.sidOf(res.accessToken)).toBe(w.sidOf(live.accessToken));
    expect(w.sessionRepo.rows).toHaveLength(1);
  });
});

describe('Elchi Pochta #3 (2026-10-23) — ro‘yxat: status, tartib, active_count', () => {
  const DAY = 24 * 3600_000;

  it('⭐ joriy → active → expired (har biri last_seen bo‘yicha); active_count faqat faollar; yopilgan / epoch / 90 kundan eski yo‘q', async () => {
    const w = makeWorld();
    const current = await w.login('25', LAPTOP_B_CTX);
    const phone = await w.login('25', PHONE_A_CTX);
    const tablet = await w.login('25', {
      ...PHONE_CTX,
      device_id: 'tablet-device-000000000001',
    });
    const oldPc = await w.login('25', {
      ...LAPTOP_CTX,
      device_id: 'oldpc-device-0000000000001',
    });
    const pwStale = await w.login('25', {
      ...PHONE_CTX,
      device_id: 'pwstale-device-00000000001',
    });
    const closed = await w.login('25', {
      ...PHONE_CTX,
      device_id: 'closed-device-000000000001',
    });
    const ancient = await w.login('25', {
      ...PHONE_CTX,
      device_id: 'ancient-device-00000000001',
    });
    const otherEpoch = await w.login('25', {
      ...PHONE_CTX,
      device_id: 'epoch-device-0000000000001',
    });
    await w.login('26', PHONE_A_CTX); // begona

    const rowOf = (res: { accessToken: string }) =>
      w.sessionRepo.rows.find((r) => r.id === w.sidOf(res.accessToken))!;
    const now = Date.now();
    rowOf(current).last_seen_at = new Date(now - 60 * 60_000);
    rowOf(phone).last_seen_at = new Date(now - 5 * 60_000);
    rowOf(tablet).last_seen_at = new Date(now - 30 * 60_000);
    Object.assign(rowOf(oldPc), {
      expires_at: new Date(now - 3 * DAY),
      last_seen_at: new Date(now - 4 * DAY),
    });
    Object.assign(rowOf(pwStale), {
      password_fp: passwordFingerprint('old-password'),
      last_seen_at: new Date(now - 60_000),
    });
    await w.service.logout('25', { sessionId: w.sidOf(closed.accessToken) });
    Object.assign(rowOf(ancient), {
      expires_at: new Date(now - 91 * DAY),
      last_seen_at: new Date(now - 92 * DAY),
    });
    rowOf(otherEpoch).epoch = 7;

    const res = await w.service.listSessions({
      userId: '25',
      sessionId: w.sidOf(current.accessToken),
    });

    expect(res.data.active_count).toBe(3);
    expect(res.data.sessions.map((s) => [s.id, s.status, s.current])).toEqual([
      [w.sidOf(current.accessToken), 'active', true],
      [w.sidOf(phone.accessToken), 'active', false],
      [w.sidOf(tablet.accessToken), 'active', false],
      [w.sidOf(pwStale.accessToken), 'expired', false],
      [w.sidOf(oldPc.accessToken), 'expired', false],
    ]);
  });

  it('joriy sessiyaning o‘zi muddati o‘tgan bo‘lsa ham birinchi (status: expired), active_count uni sanamaydi', async () => {
    const w = makeWorld();
    const current = await w.login('25', LAPTOP_B_CTX);
    await w.login('25', PHONE_A_CTX);
    const sid = w.sidOf(current.accessToken)!;
    w.sessionRepo.rows.find((r) => r.id === sid)!.expires_at = new Date(
      Date.now() - 60_000,
    );

    const res = await w.service.listSessions({ userId: '25', sessionId: sid });
    expect(res.data.active_count).toBe(1);
    expect(res.data.sessions.map((s) => [s.status, s.current])).toEqual([
      ['expired', true],
      ['active', false],
    ]);
  });

  it('qayta kirgan qurilma: first_logged_in_at — birinchi login, logged_in_at — oxirgi login', async () => {
    const w = makeWorld();
    await w.login('25', PHONE_A_CTX);
    const row = w.sessionRepo.rows[0];
    const firstAt = new Date(Date.now() - 2 * DAY);
    Object.assign(row, {
      created_at: firstAt,
      last_login_at: firstAt,
      expires_at: new Date(Date.now() - DAY),
    });
    const again = await w.login('25', PHONE_A_CTX);

    const res = await w.service.listSessions({
      userId: '25',
      sessionId: w.sidOf(again.accessToken),
    });
    expect(res.data.sessions).toHaveLength(1);
    const [view] = res.data.sessions;
    expect(view.first_logged_in_at).toBe(firstAt.toISOString());
    expect(new Date(view.logged_in_at).getTime()).toBeGreaterThan(
      firstAt.getTime() + DAY,
    );
    expect(view).toMatchObject({ status: 'active', current: true });
  });
});

describe('Elchi Pochta #3 (2026-10-23) — muddati o‘tgan (ochiq) sessiyani yopish', () => {
  it('⭐ DELETE /auth/sessions/:id muddati o‘tgan qatorni ham yopadi; keyin shu qurilma qayta kirsa — YANGI sessiya', async () => {
    const w = makeWorld();
    const phone = await w.login('25', PHONE_A_CTX);
    const laptop = await w.login('25', LAPTOP_B_CTX);
    const phoneSid = w.sidOf(phone.accessToken)!;
    w.sessionRepo.rows.find((r) => r.id === phoneSid)!.expires_at = new Date(
      Date.now() - 60_000,
    );

    const res = await w.service.revokeSession({
      userId: '25',
      sessionId: phoneSid,
      currentSessionId: w.sidOf(laptop.accessToken),
    });
    expect(res.data).toEqual({ revoked: 1, session_ids: [phoneSid] });
    const list = await w.service.listSessions({
      userId: '25',
      sessionId: w.sidOf(laptop.accessToken),
    });
    expect(list.data.sessions.map((s) => s.id)).toEqual([
      w.sidOf(laptop.accessToken),
    ]);

    const again = await w.login('25', PHONE_A_CTX);
    expect(w.sidOf(again.accessToken)).not.toBe(phoneSid);
  });

  it('⭐ revoke-others muddati o‘tgan va parol izi eskirgan ochiq qatorlarni ham yopadi', async () => {
    const w = makeWorld();
    const current = await w.login('25', LAPTOP_B_CTX);
    const expired = await w.login('25', PHONE_A_CTX);
    const pwStale = await w.login('25', PHONE_CTX);
    const rowOf = (res: { accessToken: string }) =>
      w.sessionRepo.rows.find((r) => r.id === w.sidOf(res.accessToken))!;
    rowOf(expired).expires_at = new Date(Date.now() - 60_000);
    rowOf(pwStale).password_fp = passwordFingerprint('old');

    const res = await w.service.revokeOtherSessions({
      userId: '25',
      currentSessionId: w.sidOf(current.accessToken),
    });
    expect(res.data.revoked).toBe(2);
    expect([...res.data.session_ids].sort()).toEqual(
      [w.sidOf(expired.accessToken)!, w.sidOf(pwStale.accessToken)!].sort(),
    );
    expect(rowOf(expired).revoke_reason).toBe('revoked_by_owner');
    expect(rowOf(pwStale).revoke_reason).toBe('revoked_by_owner');
    const list = await w.service.listSessions({
      userId: '25',
      sessionId: w.sidOf(current.accessToken),
    });
    expect(list.data.sessions).toHaveLength(1);
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
    // Joriy sessiya — doim birinchi, keyin qolgan faollar (oxirgi faollik).
    expect(res.data.sessions.map((s) => s.device_name)).toEqual([
      'Kompyuter · Windows · Chrome',
      'Telefon · Android · Chrome',
    ]);
    expect(res.data.sessions.map((s) => s.current)).toEqual([true, false]);
    expect(res.data.sessions.map((s) => s.status)).toEqual([
      'active',
      'active',
    ]);
    const current = res.data.sessions[0];
    expect(Object.keys(current).sort()).toEqual([
      'current',
      'device_id',
      'device_name',
      'expires_at',
      'first_logged_in_at',
      'id',
      'ip',
      'last_seen_at',
      'logged_in_at',
      'status',
      'user_agent',
    ]);
    expect(current).toMatchObject({
      id: w.sidOf(laptop.accessToken),
      device_name: 'Kompyuter · Windows · Chrome',
      device_id: 'a1b2c3d4-laptop-device-0001',
      user_agent: LAPTOP_CTX.user_agent,
      ip: '198.51.100.20',
      expires_at: new Date(laptop.refresh_token_expires_at!).toISOString(),
      current: true,
    });
    expect(current.logged_in_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(current.first_logged_in_at).toBe(current.logged_in_at);
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
  it('epoch eskirganlarni belgilaydi (SQL) va retention’dan (90 kun) o‘tganlarni partiyalab o‘chiradi', async () => {
    const repo = makeSessionRepo();
    repo.query.mockResolvedValue([[], 3]);
    const now = new Date('2026-10-21T00:00:00Z');
    const day = 24 * 3600_000;
    const at = (id: string, offsetMs: number) =>
      repo.create({ id, expires_at: new Date(now.getTime() + offsetMs) });
    repo.rows.push(
      at('old', -91 * day),
      at('month', -31 * day),
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

    expect(SESSION_RETENTION_DAYS).toBe(90);
    expect(await service.cleanup(now)).toEqual({ reset: 3, deleted: 1 });
    // 31 kun oldin tugagan qator endi QOLADI (ro'yxatda «Qayta kirish kerak»).
    expect(repo.rows.map((r) => r.id)).toEqual(['month', 'recent', 'live']);
    const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"session_epoch"');
    expect(sql).toContain("'security_reset'");
    // Muddati o'tgan ochiq qatorlar ham belgilanadi (qurilma kalitini band qilmasin).
    expect(sql).not.toContain('"expires_at"');
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
