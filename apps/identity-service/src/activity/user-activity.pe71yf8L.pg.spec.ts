import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { requestContext } from '@app/common';
import { CreateUserSessions1716000000130 } from '../../../../migrations/1716000000130-CreateUserSessions';
import { UserSessionsDeviceReuse1716000000140 } from '../../../../migrations/1716000000140-UserSessionsDeviceReuse';
import { UserActivity1716000000253 } from '../../../../migrations/1716000000253-UserActivity';
import { UserSession } from '../entities/user-session.entity';
import { UserActivity } from '../entities/user-activity.entity';
import { AuthSessionService } from '../auth/auth-session.service';
import { UserActivityService } from './user-activity.service';

/**
 * (pe71yf8L, TC5) Migratsiya 253 `identity_schema.user_activity` va
 * `UserActivityService` HAQIQIY Postgres'da: `user_sessions` dan
 * to'ldirish (yopilgan sessiyalar ham, MAX), qayta yurgizish, login /
 * refresh / socket yozuvlari (`GREATEST` — vaqt orqaga ketmaydi), FK,
 * down().
 *
 * O'z vaqtinchalik bazasi (oxirida o'chiriladi); faqat lokal xost:
 *   IDENTITY_ACTIVITY_PG_TEST_URI=postgres://postgres:pw@127.0.0.1:55499/postgres
 */
const pgUri = process.env.IDENTITY_ACTIVITY_PG_TEST_URI;
const localHost = (() => {
  if (!pgUri) return false;
  return ['127.0.0.1', 'localhost'].includes(new URL(pgUri).hostname);
})();
const describePg = localHost ? describe : describe.skip;

type Row = Record<string, unknown>;
const DAY = 24 * 3600_000;

describePg('pe71yf8L — user_activity (pg)', () => {
  const dbName = `spec_activity_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let activity: UserActivityService;
  let sessions: AuthSessionService;
  const migration = new UserActivity1716000000253();

  const dbUrl = () => {
    const url = new URL(pgUri!);
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  const runMigration = async (
    target: { up(r: unknown): Promise<void>; down(r: unknown): Promise<void> },
    direction: 'up' | 'down' = 'up',
  ) => {
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await target[direction](runner);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };

  const activityRows = () =>
    db.query<Row[]>(
      `SELECT user_id::text, last_login_at, last_seen_at
         FROM identity_schema.user_activity ORDER BY user_id`,
    );

  const insertSession = (
    userId: string,
    hash: string,
    loginAt: string,
    seenAt: string,
    revoked: boolean,
  ) =>
    db.query(
      `INSERT INTO identity_schema.user_sessions
         (id, user_id, refresh_token_hash, epoch, password_fp, method,
          created_at, last_login_at, last_seen_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, 0, 'fp', 'password', $4, $4, $5, $5::timestamptz + interval '1 day', $6)`,
      [
        randomUUID(),
        userId,
        hash.padEnd(64, '0'),
        loginAt,
        seenAt,
        revoked ? seenAt : null,
      ],
    );

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    db = new DataSource({
      type: 'postgres',
      url: dbUrl(),
      entities: [UserSession, UserActivity],
    });
    await db.initialize();
    activity = new UserActivityService(db.getRepository(UserActivity));
    sessions = new AuthSessionService(
      db.getRepository(UserSession),
      undefined,
      activity,
    );
  });

  afterAll(async () => {
    await db?.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
    await db.query('CREATE SCHEMA identity_schema');
    await db.query(
      `CREATE TABLE identity_schema.admins (
         id bigserial PRIMARY KEY, role varchar NOT NULL, name varchar,
         password varchar(255) NOT NULL, refresh_token varchar(512))`,
    );
    await db.query(
      `INSERT INTO identity_schema.admins (id, role, name, password)
       VALUES (25, 'courier', 'TEST kuryer', 'hash-25'),
              (26, 'market', 'TEST market', 'hash-26'),
              (27, 'market', 'TEST hech kirmagan', 'hash-27')`,
    );
    await runMigration(new CreateUserSessions1716000000130());
    await runMigration(new UserSessionsDeviceReuse1716000000140());
  });

  it('⭐ TC5: to`ldirish — har foydalanuvchiga MAX (yopilgan sessiya ham); sessiyasiz — qator yo`q; qayta yurgizish o`zgartirmaydi', async () => {
    await insertSession(
      '26',
      'a',
      '2026-11-20T08:00:00Z',
      '2026-11-20T09:00:00Z',
      true,
    );
    await insertSession(
      '26',
      'b',
      '2026-11-25T08:00:00Z',
      '2026-11-25T10:00:00Z',
      false,
    );
    await insertSession(
      '26',
      'c',
      '2026-11-22T08:00:00Z',
      '2026-11-26T07:00:00Z',
      true,
    );
    await insertSession(
      '25',
      'd',
      '2026-11-01T05:00:00Z',
      '2026-11-01T06:00:00Z',
      true,
    );

    await runMigration(migration);
    const expected = [
      {
        user_id: '25',
        last_login_at: new Date('2026-11-01T05:00:00Z'),
        last_seen_at: new Date('2026-11-01T06:00:00Z'),
      },
      {
        user_id: '26',
        last_login_at: new Date('2026-11-25T08:00:00Z'),
        last_seen_at: new Date('2026-11-26T07:00:00Z'),
      },
    ];
    expect(await activityRows()).toEqual(expected);

    await runMigration(migration);
    expect(await activityRows()).toEqual(expected);
  });

  it('⭐ TC5: to`ldirish activity_logs (+ arxiv) login yozuvlaridan ham — sessiyalardan oldingi kirish, birlashtirilgan `last_at`; telegram / logout / noto`g`ri id hisoblanmaydi', async () => {
    for (const table of ['activity_logs', 'activity_logs_archive']) {
      await db.query(
        `CREATE TABLE identity_schema.${table} (
           id bigserial PRIMARY KEY, entity_type varchar(64) NOT NULL,
           entity_id varchar(100) NOT NULL, action varchar(64) NOT NULL,
           user_id varchar(100), metadata jsonb, created_at timestamptz NOT NULL)`,
      );
    }
    const log = (
      table: string,
      userId: string | null,
      at: string,
      metadata: Row | null = null,
      action = 'login',
      entityType = 'Auth',
    ) =>
      db.query(
        `INSERT INTO identity_schema.${table}
           (entity_type, entity_id, action, user_id, metadata, created_at)
         VALUES ($1, COALESCE($2, '0'), $3, $2, $4, $5)`,
        [entityType, userId, action, metadata, at],
      );
    // 26: sessiya 11-25 — eski log uni kamaytirmaydi.
    await insertSession(
      '26',
      'a',
      '2026-11-25T08:00:00Z',
      '2026-11-25T10:00:00Z',
      false,
    );
    await log('activity_logs', '26', '2026-10-01T08:00:00Z');
    // 27: sessiyasi yo'q (10-21 dan oldin kirgan) — log + birlashtirilgan last_at + arxiv.
    await log('activity_logs', '27', '2026-10-02T08:00:00Z', {
      count: 3,
      last_at: '2026-10-05T09:30:00.000Z',
    });
    await log('activity_logs_archive', '27', '2026-09-01T08:00:00Z');
    await log('activity_logs', '27', '2026-10-20T08:00:00Z', null, 'logout');
    await log(
      'activity_logs',
      '27',
      '2026-10-21T08:00:00Z',
      null,
      'login',
      'User',
    );
    await log('activity_logs', '27', '2026-10-03T08:00:00Z', {
      last_at: 'not-a-date',
    });
    // 25: faqat telegram Mini App kirishi — hisoblanmaydi.
    await log('activity_logs', '25', '2026-11-26T08:00:00Z', {
      method: 'telegram',
    });
    // Noto'g'ri / admins da yo'q id — xato bermaydi, o'tkaziladi.
    await log('activity_logs', 'abc', '2026-11-26T08:00:00Z');
    await log('activity_logs', '99999999999999999999', '2026-11-26T08:00:00Z');
    await log('activity_logs', '999', '2026-11-26T08:00:00Z');
    await log('activity_logs', null, '2026-11-26T08:00:00Z');

    await runMigration(migration);
    const expected = [
      {
        user_id: '26',
        last_login_at: new Date('2026-11-25T08:00:00Z'),
        last_seen_at: new Date('2026-11-25T10:00:00Z'),
      },
      {
        user_id: '27',
        last_login_at: new Date('2026-10-05T09:30:00Z'),
        last_seen_at: new Date('2026-10-05T09:30:00Z'),
      },
    ];
    expect(await activityRows()).toEqual(expected);
    await runMigration(migration);
    expect(await activityRows()).toEqual(expected);
  });

  it('⭐ TC1: login (AuthSessionService.open) → last_login_at va last_seen_at = login vaqti; refresh (touch) → faqat last_seen_at', async () => {
    await runMigration(migration);
    const loginAt = new Date('2026-11-27T08:00:00.000Z');
    const session = await requestContext.run({ traceId: 't' }, async () =>
      sessions.open({
        user: {
          id: '26',
          password: 'hash-26',
          session_epoch: 0,
        } as never,
        refreshToken: 'refresh-26',
        method: 'password',
        expiresAt: new Date(loginAt.getTime() + DAY),
        now: loginAt,
      }),
    );
    expect(await activityRows()).toEqual([
      { user_id: '26', last_login_at: loginAt, last_seen_at: loginAt },
    ]);

    const refreshAt = new Date('2026-11-27T09:05:00.000Z');
    expect(await sessions.touch(session.id, refreshAt)).toBe(true);
    expect(await activityRows()).toEqual([
      { user_id: '26', last_login_at: loginAt, last_seen_at: refreshAt },
    ]);
  });

  it('⭐ TC2: socket yozuvi — kechikkan eski vaqt yangisini bosmaydi; kelajak → hozir; 1 kundan eski va noto`g`ri qiymat — yozilmaydi', async () => {
    await runMigration(migration);
    const now = new Date('2026-11-27T10:00:00.000Z');
    expect(
      await activity.recordSeen('26', '2026-11-27T09:50:00.000Z', now),
    ).toBe(true);
    expect(
      await activity.recordSeen('26', '2026-11-27T09:40:00.000Z', now),
    ).toBe(true);
    let [row] = await activityRows();
    expect(row.last_seen_at).toEqual(new Date('2026-11-27T09:50:00.000Z'));
    expect(row.last_login_at).toBeNull();

    expect(
      await activity.recordSeen('26', '2026-11-28T10:00:00.000Z', now),
    ).toBe(true);
    [row] = await activityRows();
    expect(row.last_seen_at).toEqual(now);

    expect(
      await activity.recordSeen('27', '2026-11-25T10:00:00.000Z', now),
    ).toBe(false);
    expect(await activity.recordSeen('27', 'not-a-date', now)).toBe(false);
    expect(await activity.recordSeen('1; DROP', now.toISOString(), now)).toBe(
      false,
    );
    expect((await activityRows()).map((r) => r.user_id)).toEqual(['26']);
  });

  it('login keyin eski socket vaqti kelsa — last_login_at ham, last_seen_at ham kamaymaydi', async () => {
    await runMigration(migration);
    await activity.recordLogin('26', new Date('2026-11-27T08:00:00.000Z'));
    await activity.recordSeen(
      '26',
      '2026-11-27T07:59:00.000Z',
      new Date('2026-11-27T08:01:00.000Z'),
    );
    expect(await activityRows()).toEqual([
      {
        user_id: '26',
        last_login_at: new Date('2026-11-27T08:00:00.000Z'),
        last_seen_at: new Date('2026-11-27T08:00:00.000Z'),
      },
    ]);
  });

  it('FK: admins da yo`q foydalanuvchi — xato otilmaydi, false', async () => {
    await runMigration(migration);
    const warn = jest
      .spyOn(
        (activity as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    expect(await activity.recordSeen('999', new Date().toISOString())).toBe(
      false,
    );
    await expect(activity.recordLogin('999')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(await activityRows()).toEqual([]);
  });

  it('findByUserIds — ISO qatorlar, noma`lum id javobda yo`q', async () => {
    await runMigration(migration);
    await activity.recordLogin('26', new Date('2026-11-27T08:00:00.000Z'));
    expect(await activity.findByUserIds(['26', 27, 'x', '26'])).toEqual([
      {
        user_id: '26',
        last_login_at: '2026-11-27T08:00:00.000Z',
        last_seen_at: '2026-11-27T08:00:00.000Z',
      },
    ]);
    expect(await activity.findByUserIds('26')).toEqual([]);
  });

  it('admin o`chirilsa (hard delete) — qator CASCADE bilan ketadi; down() jadvalni o`chiradi', async () => {
    await runMigration(migration);
    await activity.recordLogin('27');
    await db.query('DELETE FROM identity_schema.admins WHERE id = 27');
    expect(await activityRows()).toEqual([]);

    await runMigration(migration, 'down');
    const [exists] = await db.query<Row[]>(
      `SELECT to_regclass('identity_schema.user_activity') AS t`,
    );
    expect(exists.t).toBeNull();
  });
});
