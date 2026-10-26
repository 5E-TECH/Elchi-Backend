import { DataSource } from 'typeorm';
import { AuthLoginThrottle1716000000164 } from '../../../../migrations/1716000000164-AuthLoginThrottle';
import { UserMustChangePassword1716000000163 } from '../../../../migrations/1716000000163-UserMustChangePassword';
import {
  AuthLoginThrottle,
  LOGIN_LOCK_MAX_MS,
  LoginThrottleService,
  loginLockDurationMs,
  loginThrottleKeys,
} from './login-throttle.service';

/**
 * (NDmZMzCP) Telefon bo'yicha login qulfi — haqiqiy Postgres (UPSERT, oyna,
 * backoff, reset, tozalash) + 163/164 migratsiyalari (qayta yurgizish
 * xavfsiz). Faqat lokal baza (`/elchi_o2_test`):
 *   O2_PG_TEST_URI=postgres://postgres@127.0.0.1:55497/elchi_o2_test
 * Sxemani o'chirmaydi — faqat o'z jadvali/ustuni.
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

describe('NDmZMzCP — loginLockDurationMs (backoff)', () => {
  it('5 → 1 daq, 6 → 2, 7 → 4, 8 → 8, 9+ → 15 daqiqa (chegara)', () => {
    expect(loginLockDurationMs(4, 5)).toBe(0);
    expect(loginLockDurationMs(5, 5)).toBe(60_000);
    expect(loginLockDurationMs(6, 5)).toBe(120_000);
    expect(loginLockDurationMs(7, 5)).toBe(240_000);
    expect(loginLockDurationMs(8, 5)).toBe(480_000);
    expect(loginLockDurationMs(9, 5)).toBe(LOGIN_LOCK_MAX_MS);
    expect(loginLockDurationMs(500, 5)).toBe(LOGIN_LOCK_MAX_MS);
    expect(loginLockDurationMs(20, 20)).toBe(60_000);
  });

  it('kalitlar: telefon va telefon+IP; IP bo‘lmasa faqat telefon', () => {
    expect(loginThrottleKeys('abc', '203.0.113.7')).toEqual({
      phone: 'p:abc',
      phone_ip: 'pi:abc:203.0.113.7',
    });
    expect(loginThrottleKeys('abc', '')).toEqual({
      phone: 'p:abc',
      phone_ip: null,
    });
  });
});

(localTestDatabase ? describe : describe.skip)(
  'NDmZMzCP — auth_login_throttle (pg)',
  () => {
    let db: DataSource;
    let service: LoginThrottleService;
    const keys = loginThrottleKeys('hash-a', '203.0.113.7');
    const otherIp = loginThrottleKeys('hash-a', '198.51.100.20');

    const runMigration = async (
      migration: {
        up(r: unknown): Promise<void>;
        down(r: unknown): Promise<void>;
      },
      direction: 'up' | 'down',
    ) => {
      const runner = db.createQueryRunner();
      try {
        await migration[direction](runner);
      } finally {
        await runner.release();
      }
    };

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        entities: [AuthLoginThrottle],
      });
      await db.initialize();
      await db.query('CREATE SCHEMA IF NOT EXISTS identity_schema');
      await db.query(
        'CREATE TABLE IF NOT EXISTS identity_schema.admins (id bigserial PRIMARY KEY)',
      );
      service = new LoginThrottleService(db.getRepository(AuthLoginThrottle));
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await runMigration(new AuthLoginThrottle1716000000164(), 'down');
        await runMigration(new UserMustChangePassword1716000000163(), 'down');
        await db.destroy();
      }
    });

    beforeEach(async () => {
      await runMigration(new AuthLoginThrottle1716000000164(), 'down');
      // Ikki marta — IF NOT EXISTS (aidsxJ2H ham shu ustunni qo'shsa ham).
      await runMigration(new AuthLoginThrottle1716000000164(), 'up');
      await runMigration(new AuthLoginThrottle1716000000164(), 'up');
      await runMigration(new UserMustChangePassword1716000000163(), 'up');
      await runMigration(new UserMustChangePassword1716000000163(), 'up');
    });

    it('163: must_change_password ustuni, sukut false', async () => {
      await db.query('INSERT INTO identity_schema.admins DEFAULT VALUES');
      const [row] = await db.query<Array<{ must_change_password: boolean }>>(
        'SELECT must_change_password FROM identity_schema.admins LIMIT 1',
      );
      expect(row.must_change_password).toBe(false);
    });

    it('5 ta xato (shu IP) → 1 daqiqa qulf; boshqa IP faqat umumiy hisobda', async () => {
      const now = new Date('2026-10-26T08:00:00Z');
      for (let i = 1; i <= 4; i += 1) {
        const res = await service.recordFailure(keys, now);
        expect(res.locked).toEqual([]);
      }
      expect(await service.activeLock(keys, now)).toBeNull();
      const fifth = await service.recordFailure(keys, now);
      expect(fifth.locked).toEqual([
        {
          scope: 'phone_ip',
          fail_count: 5,
          locked_until: new Date(now.getTime() + 60_000),
        },
      ]);
      expect(await service.activeLock(keys, now)).toEqual({
        scope: 'phone_ip',
        locked_until: new Date(now.getTime() + 60_000),
      });
      // Boshqa IP — o'z hisobi yo'q, umumiy (20) hali yetmagan.
      expect(await service.activeLock(otherIp, now)).toBeNull();
      // Qulf vaqti tugadi.
      expect(
        await service.activeLock(keys, new Date(now.getTime() + 60_001)),
      ).toBeNull();
    });

    it('20 ta xato turli IP’lardan → telefonning umumiy qulfi; ignorePhoneScope uni chetlab o‘tadi', async () => {
      const now = new Date('2026-10-26T08:00:00Z');
      let locked: unknown[] = [];
      for (let i = 1; i <= 20; i += 1) {
        const ip = loginThrottleKeys('hash-a', `10.0.0.${i}`);
        locked = (await service.recordFailure(ip, now)).locked;
      }
      expect(locked).toEqual([
        expect.objectContaining({ scope: 'phone', fail_count: 20 }),
      ]);
      expect(await service.activeLock(otherIp, now)).toMatchObject({
        scope: 'phone',
      });
      expect(
        await service.activeLock(otherIp, now, { ignorePhoneScope: true }),
      ).toBeNull();
    });

    it('oyna: oxirgi xatodan 15 daqiqa o‘tsa (qulf yo‘q) hisob 1 dan', async () => {
      const t0 = new Date('2026-10-26T08:00:00Z');
      for (let i = 0; i < 4; i += 1) await service.recordFailure(keys, t0);
      const later = new Date(t0.getTime() + 15 * 60_000 + 1);
      expect((await service.recordFailure(keys, later)).locked).toEqual([]);
      const [row] = await db.query<Array<{ fail_count: number }>>(
        `SELECT fail_count FROM identity_schema.auth_login_throttle WHERE key = $1`,
        [keys.phone_ip],
      );
      expect(row.fail_count).toBe(1);
    });

    it('backoff ikki barobar oshadi, 15 daqiqadan oshmaydi', async () => {
      const now = new Date('2026-10-26T08:00:00Z');
      const durations: number[] = [];
      for (let i = 1; i <= 12; i += 1) {
        const { locked } = await service.recordFailure(keys, now);
        const own = locked.find((lock) => lock.scope === 'phone_ip');
        if (own) durations.push(own.locked_until.getTime() - now.getTime());
      }
      expect(durations).toEqual([
        60_000,
        120_000,
        240_000,
        480_000,
        LOGIN_LOCK_MAX_MS,
        LOGIN_LOCK_MAX_MS,
        LOGIN_LOCK_MAX_MS,
        LOGIN_LOCK_MAX_MS,
      ]);
    });

    it('muvaffaqiyatli kirish — ikkala hisob o‘chadi; purge eski qatorlarni o‘chiradi', async () => {
      const now = new Date('2026-10-26T08:00:00Z');
      await service.recordFailure(keys, now);
      await service.reset(keys);
      const rows = await db.query<unknown[]>(
        'SELECT key FROM identity_schema.auth_login_throttle',
      );
      expect(rows).toEqual([]);

      await service.recordFailure(keys, now);
      expect(
        await service.purge(new Date(now.getTime() + 2 * 86_400_000)),
      ).toBe(2);
    });
  },
);
