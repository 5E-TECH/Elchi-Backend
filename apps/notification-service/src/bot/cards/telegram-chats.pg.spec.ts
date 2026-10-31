import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TelegramChats1716000000126 } from '../../../../../migrations/1716000000126-TelegramChats';
import { TelegramChat } from '../../entities/telegram-chat.entity';
import { TelegramMarket } from '../../entities/telegram-market.entity';
import { TelegramOrderCard } from '../../entities/telegram-order-card.entity';
import { TelegramOutbox } from '../../entities/telegram-outbox.entity';
import { BotChannelService } from '../bot-channel.service';
import { OrderCardSyncService } from './order-card-sync.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: (...args: unknown[]) => rmqSendMock(...args) };
});

/**
 * ysBqD9Nx #5 / #7 — HAQIQIY Postgres (faqat lokal test bazasi):
 *  - telegram_markets → telegram_chats migratsiyasi yozuvlarni YO'QOTMAYDI;
 *  - trigger: telegram_markets o'zgarishi telegram_chats ga aks etadi;
 *  - my_chat_member (bot guruhdan chiqarildi) → telegram_chats.is_active=false;
 *  - created → new parallel hodisalari — har guruhga BITTA karta (advisory lock).
 *
 *   BOT_PG_TEST_URI=postgres://postgres@127.0.0.1:55443/elchi_bot_test npx jest telegram-chats.pg
 */
const uri = process.env.BOT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return ['127.0.0.1', 'localhost'].includes(url.hostname);
})();
const DB = 'elchi_telegram_chats_test';

(localTestDatabase ? describe : describe.skip)(
  'telegram_chats — lokal Postgres (ysBqD9Nx)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;
    const urlFor = () => {
      const url = new URL(uri!);
      url.pathname = `/${DB}`;
      return url.toString();
    };
    const chats = async () =>
      await db.query(
        `SELECT chat_id, chat_type, owner_type, owner_id::text AS owner_id, scope, is_active
           FROM notification_schema.telegram_chats ORDER BY source_market_row_id`,
      );

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      const exists: unknown[] = await admin.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [DB],
      );
      if (!exists.length) await admin.query(`CREATE DATABASE ${DB}`);
      await admin.destroy();

      // Mavjud jadvallar — entity'dan; telegram_chats — MIGRATSIYADAN (126).
      const base = new DataSource({
        type: 'postgres',
        url: urlFor(),
        schema: 'notification_schema',
        // (BOT-3 #4) telegram_outbox — yetim band qilishni qayta olish uni o'qiydi.
        entities: [TelegramMarket, TelegramOrderCard, TelegramOutbox],
      });
      await base.initialize();
      await base.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
      await base.query('CREATE SCHEMA notification_schema');
      await base.synchronize();
      // Migratsiyadan OLDINGI prod holati: faol, nofaol va o'chirilgan guruhlar.
      await base.query(`
        INSERT INTO notification_schema.telegram_markets
          (market_id, group_id, group_type, is_active, is_deleted)
        VALUES (5, '-1001', 'create', true, false),
               (5, '-1002', 'cancel', false, false),
               (6, '-1003', 'create', true, true)
      `);
      await base.destroy();

      db = new DataSource({
        type: 'postgres',
        url: urlFor(),
        schema: 'notification_schema',
        entities: [TelegramMarket, TelegramOrderCard, TelegramChat],
        extra: { max: 10 },
      });
      await db.initialize();
      const runner = db.createQueryRunner();
      try {
        await new TelegramChats1716000000126().up(runner);
        await new TelegramChats1716000000126().up(runner);
      } finally {
        await runner.release();
      }
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
        await db.destroy();
      }
      jest.restoreAllMocks();
    });

    it('⭐ migratsiya mavjud yozuvlarni YO‘QOTMAYDI (3 → 3; faol/nofaol/o‘chirilgan holati saqlanadi)', async () => {
      expect(await chats()).toEqual([
        {
          chat_id: '-1001',
          chat_type: 'group',
          owner_type: 'market',
          owner_id: '5',
          scope: 'create',
          is_active: true,
        },
        {
          chat_id: '-1002',
          chat_type: 'group',
          owner_type: 'market',
          owner_id: '5',
          scope: 'cancel',
          is_active: false,
        },
        {
          chat_id: '-1003',
          chat_type: 'group',
          owner_type: 'market',
          owner_id: '6',
          scope: 'create',
          is_active: false,
        },
      ]);
    });

    it('trigger: yangi guruh ulandi → telegram_chats; o‘chirildi → nofaol', async () => {
      const [row]: Array<{ id: string }> = await db.query(`
        INSERT INTO notification_schema.telegram_markets (market_id, group_id, group_type)
        VALUES (7, '-1004', 'create') RETURNING id
      `);
      expect((await chats()).at(-1)).toEqual(
        expect.objectContaining({
          chat_id: '-1004',
          owner_id: '7',
          is_active: true,
        }),
      );
      await db.query(
        `DELETE FROM notification_schema.telegram_markets WHERE id = $1`,
        [row.id],
      );
      expect((await chats()).at(-1)).toEqual(
        expect.objectContaining({ chat_id: '-1004', is_active: false }),
      );
    });

    it('⭐ my_chat_member: bot guruhdan chiqarildi → telegram_chats.is_active=false', async () => {
      const inbox = { dispatch: jest.fn(() => Promise.resolve({})) };
      const channel = new BotChannelService(
        db.getRepository(TelegramMarket),
        {} as never,
        { log: jest.fn(() => Promise.resolve()) } as never,
        { get: () => inbox } as never,
      );
      await channel.markInactive('-1001', 'elchi', 'kicked');
      expect((await chats())[0]).toEqual(
        expect.objectContaining({ chat_id: '-1001', is_active: false }),
      );
      await db.query(
        `UPDATE notification_schema.telegram_markets SET is_active = true WHERE group_id = '-1001'`,
      );
    });

    it('⭐ created → new hodisalari PARALLEL — har guruhga BITTA karta (advisory lock)', async () => {
      rmqSendMock.mockResolvedValue({
        data: {
          id: '81',
          order_number: 'EL-100081',
          market_id: '5',
          status: 'new',
        },
      });
      let seq = 500;
      const send = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { id: '1', status: 'sent', result: { message_id: ++seq } };
      });
      const sync = new OrderCardSyncService(
        db,
        {} as never,
        { send } as never,
        {
          editMessage: jest.fn(() => Promise.resolve(true)),
          describe: String,
        } as never,
        { refreshCardForChat: jest.fn() } as never,
        { log: jest.fn(() => Promise.resolve()) } as never,
        { get: () => 'https://admin.elchi.test' } as never,
      );
      await Promise.all([
        sync.sync({
          order_id: '81',
          from_status: null,
          to_status: 'created',
          market_id: '5',
        }),
        sync.sync({
          order_id: '81',
          from_status: 'created',
          to_status: 'new',
          market_id: '5',
        }),
      ]);
      expect(send).toHaveBeenCalledTimes(1);
      const cards: Array<{ chat_id: string; kind: string }> = await db.query(
        `SELECT chat_id, kind FROM notification_schema.telegram_order_cards WHERE order_id = 81`,
      );
      expect(cards).toEqual([{ chat_id: '-1001', kind: 'group' }]);
    });

    it('down() trigger, funksiya va jadvalni olib tashlaydi; telegram_markets tegilmaydi', async () => {
      const runner = db.createQueryRunner();
      try {
        await new TelegramChats1716000000126().down(runner);
        const [row]: Array<{ name: string | null }> = await db.query(
          `SELECT to_regclass('notification_schema.telegram_chats')::text AS name`,
        );
        expect(row.name).toBeNull();
        const [{ n }]: Array<{ n: number }> = await db.query(
          `SELECT count(*)::int AS n FROM notification_schema.telegram_markets`,
        );
        expect(n).toBe(3);
        await db.query(
          `INSERT INTO notification_schema.telegram_markets (market_id, group_id, group_type) VALUES (8, '-1005', 'create')`,
        );
        await new TelegramChats1716000000126().up(runner);
      } finally {
        await runner.release();
      }
    });
  },
);
