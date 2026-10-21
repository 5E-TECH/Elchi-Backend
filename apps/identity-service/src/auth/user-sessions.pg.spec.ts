import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { requestContext } from '@app/common';
import { CreateUserSessions1716000000130 } from '../../../../migrations/1716000000130-CreateUserSessions';
import { UserSession } from '../entities/user-session.entity';
import { AuthSessionService } from './auth-session.service';

/**
 * (Elchi Pochta #3) Migratsiya 1716000000130 va AuthSessionService HAQIQIY
 * Postgres'da: UNIQUE hash (legacy poygasi), FK, CHECK, epoch/parol izi
 * filtri, faqat o'z sessiyasini yopish, shartli touch, soatlik tozalash SQL'i.
 *
 * Faqat lokal baza (`/elchi_o2_test`):
 *   O2_PG_TEST_URI=postgres://postgres@127.0.0.1:55497/elchi_o2_test
 */
const uri = process.env.O2_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_o2_test'
  );
})();

type Row = Record<string, unknown>;
const DAY = 24 * 3600_000;
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

(localTestDatabase ? describe : describe.skip)(
  'Elchi Pochta #3 — user_sessions (pg)',
  () => {
    let db: DataSource;
    let service: AuthSessionService;
    const migration = new CreateUserSessions1716000000130();

    const run = async (direction: 'up' | 'down' = 'up') => {
      const runner = db.createQueryRunner();
      try {
        await migration[direction](runner);
      } finally {
        await runner.release();
      }
    };

    const loadUser = async (id: string) => {
      const [user] = await db.query<Row[]>(
        `SELECT id::text, password, session_epoch, refresh_token
           FROM identity_schema.admins WHERE id = $1`,
        [id],
      );
      return user as never;
    };

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        entities: [UserSession],
      });
      await db.initialize();
      service = new AuthSessionService(db.getRepository(UserSession));
      jest
        .spyOn(
          (service as unknown as { logger: { log: () => void } }).logger,
          'log',
        )
        .mockImplementation(() => undefined);
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
        await db.destroy();
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
        `INSERT INTO identity_schema.admins (id, role, name, password, refresh_token)
         VALUES (25, 'courier', 'TEST kuryer', 'hash-25', $1),
                (26, 'market', 'TEST market', 'hash-26', NULL)`,
        [sha256('legacy-25')],
      );
      await run();
    });

    const open = (userId: string, token: string, ctx: Row = {}) =>
      requestContext.run({ traceId: 't', ...ctx }, async () =>
        service.open({
          user: await loadUser(userId),
          refreshToken: token,
          method: 'password',
          expiresAt: new Date(Date.now() + DAY),
        }),
      );

    it('⭐ migratsiya: mavjud foydalanuvchilar session_epoch=0, eski hash saqlanadi; jadval va indekslar', async () => {
      const users = await db.query<Row[]>(
        `SELECT id::text, session_epoch, refresh_token
           FROM identity_schema.admins ORDER BY id`,
      );
      expect(users).toEqual([
        { id: '25', session_epoch: 0, refresh_token: sha256('legacy-25') },
        { id: '26', session_epoch: 0, refresh_token: null },
      ]);
      const indexes = await db.query<
        Array<{ indexname: string; indexdef: string }>
      >(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'identity_schema' AND tablename = 'user_sessions'
          ORDER BY indexname`,
      );
      const byName = Object.fromEntries(
        indexes.map((i) => [i.indexname, i.indexdef]),
      );
      expect(byName.UQ_USER_SESSIONS_REFRESH_HASH).toContain('UNIQUE');
      expect(byName.IDX_USER_SESSIONS_USER_ACTIVE).toContain(
        'WHERE (revoked_at IS NULL)',
      );
      expect(byName.IDX_USER_SESSIONS_EXPIRES).toBeDefined();
    });

    it('migratsiya qayta yurgizilsa xavfsiz; down/up ishlaydi', async () => {
      await open('25', 'tok-a');
      await run();
      expect(
        await db.query<Row[]>(
          'SELECT count(*)::int AS n FROM identity_schema.user_sessions',
        ),
      ).toEqual([{ n: 1 }]);
      await run('down');
      const cols = await db.query<Row[]>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'identity_schema' AND table_name = 'admins'
            AND column_name = 'session_epoch'`,
      );
      expect(cols).toEqual([]);
      await run();
    });

    it('⭐ ikki login — ikki qator, qurilma/IP kontekstdan; ochiq token bazada yo‘q', async () => {
      await open('25', 'tok-phone', {
        ip: '203.0.113.7',
        device_name: 'Telefon · Android · Chrome',
      });
      await open('25', 'tok-laptop', { ip: '198.51.100.20' });

      const rows = await db.query<Row[]>(
        `SELECT user_id::text, refresh_token_hash, ip, device_name, method, epoch
           FROM identity_schema.user_sessions ORDER BY created_at`,
      );
      expect(rows).toEqual([
        {
          user_id: '25',
          refresh_token_hash: sha256('tok-phone'),
          ip: '203.0.113.7',
          device_name: 'Telefon · Android · Chrome',
          method: 'password',
          epoch: 0,
        },
        expect.objectContaining({ ip: '198.51.100.20', device_name: null }),
      ]);
      const dump = JSON.stringify(
        await db.query('SELECT * FROM identity_schema.user_sessions'),
      );
      expect(dump).not.toContain('tok-phone');
    });

    it('UNIQUE hash: legacy qabul qilish poygasi — ikkinchisi mavjud qatorni oladi', async () => {
      const user = await loadUser('25');
      const input = {
        user,
        refreshToken: 'legacy-25',
        expiresAt: new Date(Date.now() + DAY),
        createdAt: new Date(Date.now() - 3600_000),
      };
      const [a, b] = await Promise.all([
        service.adoptLegacy(input),
        service.adoptLegacy(input),
      ]);
      expect(a?.id).toBeDefined();
      expect(b?.id).toBe(a?.id);
      expect(
        await db.query<Row[]>(
          `SELECT method, count(*)::int AS n FROM identity_schema.user_sessions GROUP BY method`,
        ),
      ).toEqual([{ method: 'legacy', n: 1 }]);
    });

    it('CHECK (method) va FK (user_id → admins, ON DELETE CASCADE)', async () => {
      await expect(
        db.query(
          `INSERT INTO identity_schema.user_sessions
             (id, user_id, refresh_token_hash, password_fp, method, expires_at)
           VALUES (gen_random_uuid(), 25, 'x', 'fp', 'telegram', now())`,
        ),
      ).rejects.toThrow(/CHK_USER_SESSIONS_METHOD/);
      await expect(
        db.query(
          `INSERT INTO identity_schema.user_sessions
             (id, user_id, refresh_token_hash, password_fp, expires_at)
           VALUES (gen_random_uuid(), 999, 'y', 'fp', now())`,
        ),
      ).rejects.toThrow(/foreign key/);
      await open('26', 'tok-26');
      await db.query('DELETE FROM identity_schema.admins WHERE id = 26');
      expect(
        await db.query<Row[]>(
          'SELECT count(*)::int AS n FROM identity_schema.user_sessions',
        ),
      ).toEqual([{ n: 0 }]);
    });

    it('⭐ listOwn: faqat o‘ziniki, faollar, last_seen bo‘yicha; epoch / parol izi / yopilgan / muddati o‘tgan chiqmaydi', async () => {
      const phone = await open('25', 'tok-phone');
      const laptop = await open('25', 'tok-laptop');
      const closed = await open('25', 'tok-closed');
      const expired = await open('25', 'tok-expired');
      await open('26', 'tok-other');
      await service.revokeOwn('25', { sessionId: closed.id }, 'logout');
      await db.query(
        `UPDATE identity_schema.user_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [expired.id],
      );
      await service.touch(phone.id, new Date(Date.now() + 60_000));

      const list = await service.listOwn(await loadUser('25'), laptop.id);
      expect(list.active_count).toBe(2);
      expect(list.sessions.map((s) => [s.id, s.current])).toEqual([
        [phone.id, false],
        [laptop.id, true],
      ]);

      // Xavfsizlik hodisasi (epoch) — ro'yxat darhol bo'sh.
      await db.query(
        `UPDATE identity_schema.admins SET session_epoch = session_epoch + 1 WHERE id = 25`,
      );
      expect(
        (await service.listOwn(await loadUser('25'), null)).active_count,
      ).toBe(0);

      // Parol almashsa (epoch'siz ham) — yangi sessiya ko'rinadi, eskisi yo'q.
      const fresh = await open('25', 'tok-fresh');
      await db.query(
        `UPDATE identity_schema.admins SET password = 'hash-25-new' WHERE id = 25`,
      );
      expect(
        (await service.listOwn(await loadUser('25'), null)).active_count,
      ).toBe(0);
      expect(fresh.password_fp).toBeDefined();
    });

    it('revokeOwn: begona foydalanuvchining sessiyasi id yoki hash bilan ham yopilmaydi; touch yopilganini yangilamaydi', async () => {
      const other = await open('26', 'tok-other');
      expect(
        await service.revokeOwn(
          '25',
          { sessionId: other.id, refreshTokenHash: sha256('tok-other') },
          'logout',
        ),
      ).toBe(0);
      expect(await service.touch(other.id)).toBe(true);

      expect(
        await service.revokeOwn('26', { sessionId: other.id }, 'logout'),
      ).toBe(1);
      expect(await service.touch(other.id)).toBe(false);
      const [row] = await db.query<Row[]>(
        `SELECT revoke_reason, revoked_at IS NOT NULL AS revoked
           FROM identity_schema.user_sessions WHERE id = $1`,
        [other.id],
      );
      expect(row).toEqual({ revoke_reason: 'logout', revoked: true });
    });

    it('⭐ cleanup: epoch eskirgan ochiq qatorlar security_reset; 30 kundan eski qatorlar o‘chadi; boshqalar tegilmaydi', async () => {
      const keep = await open('26', 'tok-keep');
      const reset = await open('25', 'tok-reset');
      const ancient = await open('26', 'tok-ancient');
      await db.query(
        `UPDATE identity_schema.user_sessions
            SET expires_at = now() - interval '31 days', created_at = now() - interval '32 days'
          WHERE id = $1`,
        [ancient.id],
      );
      await db.query(
        `UPDATE identity_schema.admins SET session_epoch = 1 WHERE id = 25`,
      );

      expect(await service.cleanup(new Date())).toEqual({
        reset: 1,
        deleted: 1,
      });
      const rows = await db.query<Row[]>(
        `SELECT id::text, revoke_reason FROM identity_schema.user_sessions ORDER BY created_at`,
      );
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: keep.id, revoke_reason: null },
          { id: reset.id, revoke_reason: 'security_reset' },
        ]),
      );
      expect(rows).toHaveLength(2);
      // Ikkinchi marta — hech narsa (idempotent).
      expect(await service.cleanup(new Date())).toEqual({
        reset: 0,
        deleted: 0,
      });
    });
  },
);
