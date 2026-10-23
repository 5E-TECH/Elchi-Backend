import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { requestContext } from '@app/common';
import { CreateUserSessions1716000000130 } from '../../../../migrations/1716000000130-CreateUserSessions';
import { UserSessionsDeviceReuse1716000000140 } from '../../../../migrations/1716000000140-UserSessionsDeviceReuse';
import { UserSession } from '../entities/user-session.entity';
import { AuthSessionService } from './auth-session.service';

/**
 * (Elchi Pochta #3) Migratsiyalar 1716000000130 + 1716000000140 va
 * AuthSessionService HAQIQIY Postgres'da: UNIQUE hash (legacy poygasi), FK,
 * CHECK, epoch/parol izi filtri, faqat o'z sessiyasini yopish, shartli
 * touch, soatlik tozalash SQL'i, egasi boshqa sessiyalarini yopishi
 * (`UPDATE … RETURNING`), session_state; 140: qurilma dedup'i, UNIQUE
 * (user_id, device_id) WHERE ochiq, qayta ishlatish, poyga, eski kod
 * trigger'i.
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
    const deviceMigration = new UserSessionsDeviceReuse1716000000140();

    const runOne = async (
      target: {
        up(r: unknown): Promise<void>;
        down(r: unknown): Promise<void>;
      },
      direction: 'up' | 'down',
    ) => {
      const runner = db.createQueryRunner();
      try {
        await target[direction](runner);
      } finally {
        await runner.release();
      }
    };
    /** 130 + 140 (down — teskari tartibda). */
    const run = async (direction: 'up' | 'down' = 'up') => {
      if (direction === 'up') {
        await runOne(migration, 'up');
        await runOne(deviceMigration, 'up');
      } else {
        await runOne(deviceMigration, 'down');
        await runOne(migration, 'down');
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
      expect(byName.UQ_USER_SESSIONS_USER_DEVICE_OPEN).toContain(
        'UNIQUE INDEX',
      );
      expect(byName.UQ_USER_SESSIONS_USER_DEVICE_OPEN).toContain(
        '(user_id, device_id) WHERE ((revoked_at IS NULL) AND (device_id IS NOT NULL))',
      );
      const [col] = await db.query<Row[]>(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'identity_schema' AND table_name = 'user_sessions'
            AND column_name = 'last_login_at'`,
      );
      expect(col).toEqual({ is_nullable: 'NO', column_default: null });
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

    it('⭐ listOwn: faqat o‘ziniki; joriy → active → expired; epoch / yopilgan chiqmaydi, parol izi eskirgan — expired', async () => {
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
      expect(list.sessions.map((s) => [s.id, s.status, s.current])).toEqual([
        [laptop.id, 'active', true],
        [phone.id, 'active', false],
        [expired.id, 'expired', false],
      ]);

      // Xavfsizlik hodisasi (epoch) — ro'yxat darhol bo'sh.
      await db.query(
        `UPDATE identity_schema.admins SET session_epoch = session_epoch + 1 WHERE id = 25`,
      );
      expect(await service.listOwn(await loadUser('25'), null)).toEqual({
        active_count: 0,
        sessions: [],
      });

      // Parol almashsa (epoch'siz ham) — sessiya «expired» (qayta kirish kerak).
      const fresh = await open('25', 'tok-fresh');
      await db.query(
        `UPDATE identity_schema.admins SET password = 'hash-25-new' WHERE id = 25`,
      );
      const afterPassword = await service.listOwn(await loadUser('25'), null);
      expect(afterPassword.active_count).toBe(0);
      expect(afterPassword.sessions.map((s) => [s.id, s.status])).toEqual([
        [fresh.id, 'expired'],
      ]);
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

    it('⭐ revokeOwnExcept (UPDATE … RETURNING): joriydan boshqa o‘z ochiq sessiyalari; begona va avval yopilgan qatorga tegilmaydi', async () => {
      const current = await open('25', 'tok-current');
      const phone = await open('25', 'tok-phone');
      const tablet = await open('25', 'tok-tablet');
      const closed = await open('25', 'tok-closed');
      const other = await open('26', 'tok-other');
      await service.revokeOwn('25', { sessionId: closed.id }, 'logout');
      const [{ closed_at: closedAt }] = await db.query<Row[]>(
        `SELECT revoked_at AS closed_at FROM identity_schema.user_sessions WHERE id = $1`,
        [closed.id],
      );

      const ids = await service.revokeOwnExcept(
        '25',
        current.id.toUpperCase(),
        'revoked_by_owner',
      );
      expect([...ids].sort()).toEqual([phone.id, tablet.id].sort());

      const rows = await db.query<Row[]>(
        `SELECT id::text, revoke_reason, revoked_at
           FROM identity_schema.user_sessions`,
      );
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      expect(byId.get(current.id)).toMatchObject({
        revoke_reason: null,
        revoked_at: null,
      });
      expect(byId.get(phone.id)?.revoke_reason).toBe('revoked_by_owner');
      expect(byId.get(tablet.id)?.revoke_reason).toBe('revoked_by_owner');
      expect(byId.get(closed.id)).toMatchObject({
        revoke_reason: 'logout',
        revoked_at: closedAt,
      });
      expect(byId.get(other.id)).toMatchObject({
        revoke_reason: null,
        revoked_at: null,
      });
      // Ikkinchi marta — yopiladigan narsa yo'q.
      expect(
        await service.revokeOwnExcept('25', current.id, 'revoked_by_owner'),
      ).toEqual([]);
    });

    it('revokeOwnById: faqat o‘z ochiq sessiyasi; begona / yopilgan → []', async () => {
      const mine = await open('25', 'tok-mine');
      const other = await open('26', 'tok-other');
      expect(
        await service.revokeOwnById('25', other.id, 'revoked_by_owner'),
      ).toEqual([]);
      expect(
        await service.revokeOwnById(
          '25',
          mine.id.toUpperCase(),
          'revoked_by_owner',
        ),
      ).toEqual([mine.id]);
      expect(
        await service.revokeOwnById('25', mine.id, 'revoked_by_owner'),
      ).toEqual([]);
      const [row] = await db.query<Row[]>(
        `SELECT revoke_reason FROM identity_schema.user_sessions WHERE id = $1`,
        [other.id],
      );
      expect(row.revoke_reason).toBeNull();
    });

    it('isOpen (session_state): o‘z ochiq sessiyasi true; begona, yopilgan, yo‘q — false', async () => {
      const mine = await open('25', 'tok-mine');
      const closed = await open('25', 'tok-closed');
      await service.revokeOwnById('25', closed.id, 'revoked_by_owner');

      expect(await service.isOpen('25', mine.id)).toBe(true);
      expect(await service.isOpen('26', mine.id)).toBe(false);
      expect(await service.isOpen('25', closed.id)).toBe(false);
      expect(
        await service.isOpen('25', '00000000-0000-4000-8000-000000000000'),
      ).toBe(false);
    });

    it('ownSessionIds (logout javobi): id yoki hash bo‘yicha, faqat o‘ziniki', async () => {
      const mine = await open('25', 'tok-mine');
      const other = await open('26', 'tok-other');
      expect(
        await service.ownSessionIds('25', {
          sessionId: mine.id,
          refreshTokenHash: sha256('tok-mine'),
        }),
      ).toEqual([mine.id]);
      expect(
        await service.ownSessionIds('25', {
          sessionId: other.id,
          refreshTokenHash: sha256('tok-other'),
        }),
      ).toEqual([]);
    });

    // ── 1716000000140: bitta qurilma — bitta sessiya ────────────────────
    const DEV = 'f3a9c2d1-0b7e-4c55-9e21-7d4c3b2a1f00';
    const DEV_E = '0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
    const onDevice = (deviceId: string, extra: Row = {}) => ({
      device_id: deviceId,
      device_name: 'Samsung SM-A515F · Android 13 · Chrome 155',
      ...extra,
    });
    const openOnDevice = async (userId: string, deviceId: string) =>
      db.query<Row[]>(
        `SELECT id::text, refresh_token_hash FROM identity_schema.user_sessions
          WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
        [userId, deviceId],
      );

    it('⭐ migratsiya 140: last_login_at = created_at; har qurilmaning ochiq dublikatlari merged (eng oxirgi faoli qoladi); indeks; down/up', async () => {
      await runOne(deviceMigration, 'down');
      const base = Date.now();
      const ago = (hours: number) => new Date(base - hours * 3600_000);
      const insert = (values: Row) =>
        db.query<Row[]>(
          `INSERT INTO identity_schema.user_sessions
             (id, user_id, refresh_token_hash, password_fp, device_id,
              created_at, last_seen_at, expires_at, revoked_at, revoke_reason)
           VALUES (gen_random_uuid(), $1, $2, 'fp', $3, $4, $5,
                   now() + interval '1 day', $6, $7)
           RETURNING id::text`,
          [
            values.user,
            values.hash,
            values.device ?? null,
            values.created ?? ago(24),
            values.seen ?? ago(1),
            values.revoked_at ?? null,
            values.reason ?? null,
          ],
        );
      // r2 va r3 — bir xil last_seen_at; r2 keyinroq yaratilgan → r2 qoladi.
      const [r1] = await insert({
        user: 25,
        hash: 'h1',
        device: DEV,
        created: ago(120),
        seen: ago(3),
      });
      const [r2] = await insert({
        user: 25,
        hash: 'h2',
        device: DEV,
        created: ago(48),
        seen: ago(1),
      });
      const [r3] = await insert({
        user: 25,
        hash: 'h3',
        device: DEV,
        created: ago(72),
        seen: ago(1),
      });
      const loggedOutAt = new Date('2026-10-20T10:00:00Z');
      const [r4] = await insert({
        user: 25,
        hash: 'h4',
        device: DEV,
        revoked_at: loggedOutAt,
        reason: 'logout',
      });
      const [n1] = await insert({ user: 25, hash: 'n1' });
      const [n2] = await insert({ user: 25, hash: 'n2' });
      const [o1] = await insert({ user: 26, hash: 'o1', device: DEV });
      const [e1] = await insert({ user: 25, hash: 'e1', device: DEV_E });

      await runOne(deviceMigration, 'up');

      const rows = await db.query<Row[]>(
        `SELECT id::text, revoke_reason, revoked_at,
                last_login_at = created_at AS backfilled
           FROM identity_schema.user_sessions`,
      );
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      expect(rows.every((r) => r.backfilled === true)).toBe(true);
      expect(byId.get(r2.id as string)).toMatchObject({
        revoke_reason: null,
        revoked_at: null,
      });
      for (const merged of [r1, r3]) {
        const row = byId.get(merged.id as string)!;
        expect(row.revoke_reason).toBe('merged');
        expect(row.revoked_at).toBeInstanceOf(Date);
      }
      expect(byId.get(r4.id as string)).toMatchObject({
        revoke_reason: 'logout',
        revoked_at: loggedOutAt,
      });
      for (const untouched of [n1, n2, o1, e1]) {
        expect(byId.get(untouched.id as string)).toMatchObject({
          revoke_reason: null,
        });
      }

      // Indeks: qurilmada ikkinchi ochiq qator — 23505.
      await expect(
        db.query(
          `INSERT INTO identity_schema.user_sessions
             (id, user_id, refresh_token_hash, password_fp, device_id, expires_at, last_login_at)
           VALUES (gen_random_uuid(), 25, 'dup', 'fp', $1, now(), now())`,
          [DEV],
        ),
      ).rejects.toThrow(/UQ_USER_SESSIONS_USER_DEVICE_OPEN/);

      // Qayta ishlatish: o'sha qurilma kirsa — r2 yangilanadi.
      const reused = await open('25', 'tok-again', onDevice(DEV));
      expect(reused.id).toBe(r2.id);
      expect(await openOnDevice('25', DEV)).toEqual([
        { id: r2.id, refresh_token_hash: sha256('tok-again') },
      ]);

      // down: indeks / trigger / ustun yo'q; merged qatorlar yopiqligicha.
      await runOne(deviceMigration, 'down');
      expect(
        await db.query<Row[]>(
          `SELECT indexname FROM pg_indexes WHERE indexname = 'UQ_USER_SESSIONS_USER_DEVICE_OPEN'`,
        ),
      ).toEqual([]);
      expect(
        await db.query<Row[]>(
          `SELECT revoke_reason FROM identity_schema.user_sessions WHERE id = ANY($1) ORDER BY 1`,
          [[r1.id, r3.id]],
        ),
      ).toEqual([{ revoke_reason: 'merged' }, { revoke_reason: 'merged' }]);
      // Qayta up — xatosiz (dublikat yo'q).
      await runOne(deviceMigration, 'up');
      await runOne(deviceMigration, 'up');
    });

    it('⭐ eski kod (last_login_at siz INSERT, deploy/rollback oynasi) — 23505 YO‘Q: trigger qurilmaning avvalgi ochiq qatorini merged qiladi', async () => {
      const live = await open('25', 'tok-live', onDevice(DEV));
      const [legacyInsert] = await db.query<Row[]>(
        `INSERT INTO identity_schema.user_sessions
           (id, user_id, refresh_token_hash, password_fp, device_id, expires_at)
         VALUES (gen_random_uuid(), 25, 'old-code', 'fp', $1, now() + interval '1 day')
         RETURNING id::text, last_login_at = created_at AS filled`,
        [DEV],
      );
      expect(legacyInsert.filled).toBe(true);
      const [old] = await db.query<Row[]>(
        `SELECT revoke_reason FROM identity_schema.user_sessions WHERE id = $1`,
        [live.id],
      );
      expect(old.revoke_reason).toBe('merged');
      expect(await openOnDevice('25', DEV)).toEqual([
        { id: legacyInsert.id, refresh_token_hash: 'old-code' },
      ]);
      // Yangi kod last_login_at ni yozadi — trigger ishlamaydi (boshqa qurilma qatori tegilmaydi).
      const other = await open('25', 'tok-e', onDevice(DEV_E));
      await open('25', 'tok-e2', onDevice(DEV_E));
      expect(await openOnDevice('25', DEV_E)).toEqual([
        { id: other.id, refresh_token_hash: sha256('tok-e2') },
      ]);
    });

    it('⭐ qayta ishlatish (pg): muddati o‘tgan qator — AYNI id, created_at saqlanadi; logout qilingani — yangi qator', async () => {
      const first = await open(
        '25',
        'tok-1',
        onDevice(DEV, { ip: '203.0.113.7' }),
      );
      await db.query(
        `UPDATE identity_schema.user_sessions
            SET expires_at = now() - interval '1 hour',
                created_at = now() - interval '3 days',
                last_login_at = now() - interval '3 days'
          WHERE id = $1`,
        [first.id],
      );
      const again = await open(
        '25',
        'tok-2',
        onDevice(DEV, { ip: '198.51.100.9' }),
      );
      expect(again.id).toBe(first.id);
      const [row] = await db.query<Row[]>(
        `SELECT refresh_token_hash, ip, expires_at > now() AS live,
                created_at < now() - interval '2 days' AS kept_first_login,
                last_login_at > now() - interval '1 minute' AS fresh_login
           FROM identity_schema.user_sessions WHERE id = $1`,
        [first.id],
      );
      expect(row).toEqual({
        refresh_token_hash: sha256('tok-2'),
        ip: '198.51.100.9',
        live: true,
        kept_first_login: true,
        fresh_login: true,
      });
      expect(await service.findByHash(sha256('tok-1'))).toBeNull();

      await service.revokeOwn('25', { sessionId: first.id }, 'logout');
      const third = await open('25', 'tok-3', onDevice(DEV));
      expect(third.id).not.toBe(first.id);
      expect(await openOnDevice('25', DEV)).toEqual([
        { id: third.id, refresh_token_hash: sha256('tok-3') },
      ]);
    });

    it('⭐ poyga (pg): bir qurilmadan 5 ta parallel login — bitta ochiq qator, hammasi bitta id', async () => {
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => open('25', `tok-race-${n}`, onDevice(DEV))),
      );
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      const open25 = await openOnDevice('25', DEV);
      expect(open25).toHaveLength(1);
      expect(open25[0].id).toBe(results[0].id);
      expect([1, 2, 3, 4, 5].map((n) => sha256(`tok-race-${n}`))).toContain(
        open25[0].refresh_token_hash,
      );
      // Boshqa foydalanuvchi AYNI device_id — alohida qator.
      const theirs = await open('26', 'tok-26', onDevice(DEV));
      expect(theirs.id).not.toBe(results[0].id);
      expect(await openOnDevice('26', DEV)).toHaveLength(1);
    });

    it('epoch eskirgan ochiq qator (pg) — security_reset bilan yopiladi, yangi qator ochiladi (indeks to‘sqinlik qilmaydi)', async () => {
      const before = await open('25', 'tok-before', onDevice(DEV));
      await db.query(
        `UPDATE identity_schema.admins SET session_epoch = session_epoch + 1 WHERE id = 25`,
      );
      const after = await open('25', 'tok-after', onDevice(DEV));
      expect(after.id).not.toBe(before.id);
      const [old] = await db.query<Row[]>(
        `SELECT revoke_reason FROM identity_schema.user_sessions WHERE id = $1`,
        [before.id],
      );
      expect(old.revoke_reason).toBe('security_reset');
      expect(await openOnDevice('25', DEV)).toEqual([
        { id: after.id, refresh_token_hash: sha256('tok-after') },
      ]);
    });

    it('adoptLegacy (pg): qurilmada ochiq qator bor — 23505 yutiladi, o‘sha qator qaytadi', async () => {
      const live = await open('25', 'tok-live', onDevice(DEV));
      const adopted = await requestContext.run(
        { traceId: 't', ...onDevice(DEV) },
        async () =>
          service.adoptLegacy({
            user: await loadUser('25'),
            refreshToken: 'legacy-25',
            expiresAt: new Date(Date.now() + DAY),
          }),
      );
      expect(adopted?.id).toBe(live.id);
      expect(
        await db.query<Row[]>(
          'SELECT count(*)::int AS n FROM identity_schema.user_sessions',
        ),
      ).toEqual([{ n: 1 }]);
    });

    it('⭐ cleanup: epoch eskirgan ochiq qatorlar (muddati o‘tgani ham) security_reset; 90 kundan eski qatorlar o‘chadi; boshqalar tegilmaydi', async () => {
      const keep = await open('26', 'tok-keep');
      const reset = await open('25', 'tok-reset');
      const resetExpired = await open('25', 'tok-reset-expired');
      const month = await open('26', 'tok-month');
      const ancient = await open('26', 'tok-ancient');
      await db.query(
        `UPDATE identity_schema.user_sessions
            SET expires_at = now() - interval '91 days', created_at = now() - interval '92 days'
          WHERE id = $1`,
        [ancient.id],
      );
      await db.query(
        `UPDATE identity_schema.user_sessions
            SET expires_at = now() - interval '31 days', created_at = now() - interval '32 days'
          WHERE id = ANY($1)`,
        [[month.id, resetExpired.id]],
      );
      await db.query(
        `UPDATE identity_schema.admins SET session_epoch = 1 WHERE id = 25`,
      );

      expect(await service.cleanup(new Date())).toEqual({
        reset: 2,
        deleted: 1,
      });
      const rows = await db.query<Row[]>(
        `SELECT id::text, revoke_reason FROM identity_schema.user_sessions ORDER BY created_at`,
      );
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: keep.id, revoke_reason: null },
          { id: month.id, revoke_reason: null },
          { id: reset.id, revoke_reason: 'security_reset' },
          { id: resetExpired.id, revoke_reason: 'security_reset' },
        ]),
      );
      expect(rows).toHaveLength(4);
      // Ikkinchi marta — hech narsa (idempotent).
      expect(await service.cleanup(new Date())).toEqual({
        reset: 0,
        deleted: 0,
      });
    });
  },
);
