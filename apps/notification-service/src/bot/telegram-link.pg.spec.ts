import { DataSource } from 'typeorm';
import { TelegramLinking1716000000121 } from '../../../../migrations/1716000000121-TelegramLinking';
import { TelegramLinkToken } from '../entities/telegram-link-token.entity';
import { TelegramLinkService, hashLinkToken } from './telegram-link.service';

/**
 * Telegram bog'lash — HAQIQIY Postgres (faqat lokal test bazasi):
 * migratsiya 1716000000121 (identity_schema.admins: partial unique
 * telegram_id + noaniq dublikatlarni tozalash; telegram_link_tokens),
 * bir martalik kodning ATOMIK band qilinishi (6jXw0DDr / 9uNhwTZp).
 *
 *   BOT_PG_TEST_URI=postgres://postgres@127.0.0.1:55443/elchi_bot_test npx jest telegram-link.pg
 * (spec o'zi yonma-yon `elchi_bot_link_test` bazasini yaratadi.)
 */
const uri = process.env.BOT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_bot_test'
  );
})();

const migration = new TelegramLinking1716000000121();
/** bot-core.pg bilan parallel to'qnashmaslik uchun ALOHIDA baza. */
const LINK_DB = 'elchi_bot_link_test';
const linkUri = (() => {
  if (!uri) return '';
  const url = new URL(uri);
  url.pathname = `/${LINK_DB}`;
  return url.toString();
})();

(localTestDatabase ? describe : describe.skip)(
  'Telegram bog‘lash — lokal Postgres (6jXw0DDr / 9uNhwTZp / td89SKXQ)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;
    const service = () =>
      new TelegramLinkService(db.getRepository(TelegramLinkToken));
    const run = async (direction: 'up' | 'down') => {
      const runner = db.createQueryRunner();
      try {
        await migration[direction](runner);
      } finally {
        await runner.release();
      }
    };

    beforeAll(async () => {
      const admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      const exists: unknown[] = await admin.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [LINK_DB],
      );
      if (!exists.length) await admin.query(`CREATE DATABASE ${LINK_DB}`);
      await admin.destroy();
      db = new DataSource({
        type: 'postgres',
        url: linkUri,
        schema: 'notification_schema',
        entities: [TelegramLinkToken],
        extra: { max: 10 },
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
      await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
      await db.query('CREATE SCHEMA notification_schema');
      await db.query('CREATE SCHEMA identity_schema');
      await db.query(`
        CREATE TABLE identity_schema.admins (
          "id" bigserial PRIMARY KEY,
          "is_deleted" boolean NOT NULL DEFAULT false,
          "telegram_id" varchar(64) NULL
        )`);
      // Mavjud holat: NULL'lar, bitta yagona va ikki akkauntda bir xil id.
      await db.query(`
        INSERT INTO identity_schema.admins (telegram_id)
        VALUES (NULL), (NULL), ('5550001'), ('5550002'), ('5550002')`);
      await run('up');
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
        await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
        await db.destroy();
      }
    });

    describe('migratsiya 1716000000121', () => {
      it('⭐ partial unique indeks mavjud NULL qatorlarni buzmaydi; noaniq dublikatlar NULL qilinadi', async () => {
        const rows: Array<{ telegram_id: string | null }> = await db.query(
          `SELECT telegram_id FROM identity_schema.admins ORDER BY id`,
        );
        expect(rows.map((r) => r.telegram_id)).toEqual([
          null,
          null,
          '5550001',
          null,
          null,
        ]);
        // Yana NULL qo'shish mumkin, band id — yo'q (23505).
        await db.query(`INSERT INTO identity_schema.admins (telegram_id) VALUES (NULL)`);
        await expect(
          db.query(`INSERT INTO identity_schema.admins (telegram_id) VALUES ('5550001')`),
        ).rejects.toMatchObject({ code: '23505' });
        const cols: Array<{ column_name: string }> = await db.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'identity_schema' AND table_name = 'admins'`,
        );
        expect(cols.map((c) => c.column_name)).toEqual(
          expect.arrayContaining(['telegram_username', 'telegram_linked_at']),
        );
      });

      it('qayta up xavfsiz; down → up qayta tiklaydi', async () => {
        await run('up');
        await run('down');
        await run('up');
        const [row]: Array<{ n: string }> = await db.query(
          `SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'UQ_ADMINS_TELEGRAM_ID'`,
        );
        expect(Number(row.n)).toBe(1);
      });
    });

    describe('telegram_link_tokens', () => {
      it('⭐ kod DB’da faqat hash; 10 daqiqa; birinchi claim ok, ikkinchisi used', async () => {
        const { token, expires_at } = await service().issue({
          purpose: 'user',
          owner_type: 'courier',
          owner_id: '25',
          created_by: '25',
        });
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const minutes = (expires_at.getTime() - Date.now()) / 60_000;
        expect(minutes).toBeGreaterThan(9.9);
        expect(minutes).toBeLessThanOrEqual(10);
        const stored: Array<{ token_hash: string }> = await db.query(
          `SELECT token_hash FROM notification_schema.telegram_link_tokens`,
        );
        expect(stored.map((r) => r.token_hash)).toContain(hashLinkToken(token));
        expect(JSON.stringify(stored)).not.toContain(token);

        const first = await service().claim(token, 'private', '5550007');
        expect(first.status).toBe('ok');
        expect(await service().claim(token, 'private', '5550007')).toEqual({
          status: 'used',
        });
      });

      it('⭐ ikki bir vaqtli /start <kod> — FAQAT bittasi ok', async () => {
        const { token } = await service().issue({
          purpose: 'market_group',
          owner_type: 'market',
          owner_id: '37',
          group_type: 'create',
        });
        const results = await Promise.all([
          service().claim(token, 'group', '-100555'),
          service().claim(token, 'group', '-100666'),
          service().claim(token, 'group', '-100777'),
        ]);
        expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
        expect(results.filter((r) => r.status === 'used')).toHaveLength(2);
      });

      it('⭐ muddati o‘tgan kod — expired; noto‘g‘ri scope — band qilinmaydi', async () => {
        const { token } = await service().issue({
          purpose: 'user',
          owner_type: 'courier',
          owner_id: '25',
        });
        expect(await service().claim(token, 'group', '-1')).toEqual({
          status: 'wrong_scope',
        });
        await db.query(
          `UPDATE notification_schema.telegram_link_tokens
              SET expires_at = now() - interval '1 second'
            WHERE token_hash = $1`,
          [hashLinkToken(token)],
        );
        expect(await service().claim(token, 'private', '1')).toEqual({
          status: 'expired',
        });
        expect(await service().claim('group_token-2', 'group', '1')).toEqual({
          status: 'invalid',
        });
      });
    });
  },
);
