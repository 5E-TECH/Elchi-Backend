import { DataSource } from 'typeorm';
import { TelegramChats1716000000126 } from '../../../migrations/1716000000126-TelegramChats';
import { TelegramMarketsLinkedBy1716000000189 } from '../../../migrations/1716000000189-TelegramMarketsLinkedBy';

/**
 * BOT-2 #5 — migratsiya 1716000000189 (lokal Postgres):
 *  - eski `telegram_markets.linked_by` audit jurnalidan to'ldiriladi;
 *  - trigger yangi / yangilangan qatorda `telegram_chats.linked_by` ni yozadi;
 *  - ikki marta up — xatosiz; down — ustun o'chadi, trigger ishlayveradi.
 *
 *   TG_LINKED_BY_PG_TEST_URI=postgres://postgres@127.0.0.1:55432/elchi_tg_linked_test \
 *     npx jest telegram-markets-linked-by
 */
const uri = process.env.TG_LINKED_BY_PG_TEST_URI;
const local = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_tg_linked_test'
  );
})();

(local ? describe : describe.skip)(
  'BOT-2 #5 — telegram_markets.linked_by (migratsiya 189)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;
    const run = async (
      migration: {
        up: (r: never) => Promise<void>;
        down: (r: never) => Promise<void>;
      },
      direction: 'up' | 'down',
    ) => {
      const runner = db.createQueryRunner();
      try {
        await migration[direction](runner as never);
      } finally {
        await runner.release();
      }
    };

    beforeAll(async () => {
      db = new DataSource({ type: 'postgres', url: uri });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
      await db.query('CREATE SCHEMA notification_schema');
      await db.query(`
        CREATE TYPE notification_schema.group_type_enum AS ENUM ('create', 'cancel')`);
      await db.query(`
        CREATE TABLE notification_schema.telegram_markets (
          "id" bigserial PRIMARY KEY,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          "is_deleted" boolean NOT NULL DEFAULT false,
          "market_id" bigint NOT NULL,
          "group_id" varchar NOT NULL,
          "group_type" notification_schema.group_type_enum NOT NULL,
          "is_active" boolean NOT NULL DEFAULT true
        )`);
      await db.query(`
        CREATE TABLE notification_schema.activity_logs (
          "id" bigserial PRIMARY KEY,
          "entity_type" varchar(64) NOT NULL,
          "entity_id" varchar(100) NOT NULL,
          "action" varchar(64) NOT NULL,
          "metadata" jsonb,
          "created_at" timestamptz NOT NULL DEFAULT now()
        )`);
      await db.query(`
        INSERT INTO notification_schema.telegram_markets (market_id, group_id, group_type)
        VALUES (5, '-1001', 'create'), (5, '-1002', 'cancel'), (7, '-1003', 'create')`);
      await run(new TelegramChats1716000000126(), 'up');
      await db.query(`
        INSERT INTO notification_schema.activity_logs (entity_type, entity_id, action, metadata, created_at)
        VALUES ('TelegramMarket', '1', 'notification.tg_group_connected', '{"linked_by": "40"}', now() - interval '2 days'),
               ('TelegramMarket', '1', 'notification.tg_group_connected', '{"linked_by": "5"}', now() - interval '1 day'),
               ('TelegramMarket', '2', 'notification.tg_group_connected', '{"via": "code"}', now()),
               ('TelegramMarket', '3', 'notification.tg_group_connected', '{"linked_by": "abc"}', now())`);
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
        await db.destroy();
      }
    });

    it('⭐ up (ikki marta): eski qatorlar auditdan, telegram_chats ham', async () => {
      await run(new TelegramMarketsLinkedBy1716000000189(), 'up');
      await run(new TelegramMarketsLinkedBy1716000000189(), 'up');
      const markets: Array<{ id: string; linked_by: string | null }> =
        await db.query(
          `SELECT id, linked_by FROM notification_schema.telegram_markets ORDER BY id`,
        );
      // Eng so'nggi audit yozuvi; linked_by yo'q / raqam emas — NULL.
      expect(markets.map((r) => r.linked_by)).toEqual(['5', null, null]);
      const chats: Array<{ linked_by: string | null }> = await db.query(
        `SELECT linked_by FROM notification_schema.telegram_chats ORDER BY source_market_row_id`,
      );
      expect(chats.map((r) => r.linked_by)).toEqual(['5', null, null]);
    });

    it('⭐ trigger: yangi ulanish va yangilanishda telegram_chats.linked_by', async () => {
      const [{ id }]: Array<{ id: string }> = await db.query(`
        INSERT INTO notification_schema.telegram_markets (market_id, group_id, group_type, linked_by)
        VALUES (9, '-1009', 'create', 9) RETURNING id`);
      let [chat]: Array<{ linked_by: string; owner_id: string }> =
        await db.query(
          `SELECT linked_by, owner_id FROM notification_schema.telegram_chats WHERE source_market_row_id = $1`,
          [id],
        );
      expect(chat).toEqual({ linked_by: '9', owner_id: '9' });
      await db.query(
        `UPDATE notification_schema.telegram_markets SET linked_by = 1, is_active = false WHERE id = $1`,
        [id],
      );
      [chat] = await db.query(
        `SELECT linked_by FROM notification_schema.telegram_chats WHERE source_market_row_id = $1`,
        [id],
      );
      expect(chat.linked_by).toBe('1');
    });

    it('down: ustun o`chadi, trigger eski holatda ishlaydi', async () => {
      await run(new TelegramMarketsLinkedBy1716000000189(), 'down');
      const cols: Array<{ column_name: string }> = await db.query(`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'notification_schema' AND table_name = 'telegram_markets'
           AND column_name = 'linked_by'`);
      expect(cols).toEqual([]);
      await db.query(`
        INSERT INTO notification_schema.telegram_markets (market_id, group_id, group_type)
        VALUES (11, '-1011', 'cancel')`);
      const [count]: Array<{ n: string }> = await db.query(
        `SELECT count(*)::text AS n FROM notification_schema.telegram_chats WHERE chat_id = '-1011'`,
      );
      expect(count.n).toBe('1');
    });
  },
);
