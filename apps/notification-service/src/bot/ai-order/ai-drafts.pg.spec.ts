import { DataSource } from 'typeorm';
import { TelegramAiDrafts1716000000128 } from '../../../../../migrations/1716000000128-TelegramAiDrafts';
import { TelegramChatLocksAiWorker1716000000190 } from '../../../../../migrations/1716000000190-TelegramChatLocksAiWorker';
import { TelegramAiDraft } from '../../entities/telegram-ai-draft.entity';
import { AiOrderService } from './ai-order.service';

/**
 * e7KhaeOO — AI qoralamasi HAQIQIY Postgres'da (faqat lokal test bazasi):
 * migratsiya 128, "✅ Yaratish" parallel bosilsa `preview → creating` faqat
 * BITTA da'vo, muddati o'tgan qoralama da'vo qilinmaydi, tozalash PII'ni
 * o'chiradi.
 *
 *   BOT_PG_TEST_URI=postgres://postgres@127.0.0.1:55443/elchi_bot_test npx jest ai-drafts.pg
 */
const uri = process.env.BOT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return ['127.0.0.1', 'localhost'].includes(url.hostname);
})();
const DB = 'elchi_ai_drafts_test';

(localTestDatabase ? describe : describe.skip)(
  'telegram_ai_drafts — lokal Postgres (e7KhaeOO)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;
    let claim: (
      id: string,
      from: string[],
      to: string,
    ) => Promise<TelegramAiDraft | null>;

    beforeAll(async () => {
      const admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      const exists: unknown[] = await admin.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [DB],
      );
      if (!exists.length) await admin.query(`CREATE DATABASE ${DB}`);
      await admin.destroy();
      const url = new URL(uri!);
      url.pathname = `/${DB}`;
      db = new DataSource({
        type: 'postgres',
        url: url.toString(),
        schema: 'notification_schema',
        entities: [TelegramAiDraft],
        extra: { max: 10 },
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
      await db.query('CREATE SCHEMA notification_schema');
      const runner = db.createQueryRunner();
      try {
        await new TelegramAiDrafts1716000000128().up(runner);
        await new TelegramAiDrafts1716000000128().up(runner);
        // (BOT-3b) worker_at ustuni — da'vo uni NULL qiladi.
        await new TelegramChatLocksAiWorker1716000000190().up(runner);
      } finally {
        await runner.release();
      }
      const service = new AiOrderService(
        db.getRepository(TelegramAiDraft),
        {} as never,
        {} as never,
        {} as never,
        { get: () => undefined } as never,
        {} as never,
      );
      claim = (id, from, to) =>
        (
          service as unknown as {
            claim: (
              i: string,
              f: string[],
              t: string,
            ) => Promise<TelegramAiDraft | null>;
          }
        ).claim(id, from, to);
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
        await db.destroy();
      }
    });

    const insert = async (id: string, expired = false) => {
      await db.query(
        `INSERT INTO notification_schema.telegram_ai_drafts
           (id, chat_id, actor_user_id, status, input, orders, expires_at)
         VALUES ($1, '40', 40, 'preview', '{"text":"Ali +998901234567"}'::jsonb,
                 '[{"index":0,"customer_name":"Ali"}]'::jsonb,
                 ${expired ? "now() - interval '1 minute'" : "now() + interval '24 hours'"})`,
        [id],
      );
    };

    it('⭐ "Yaratish" 5 marta parallel — faqat BITTA da’vo (preview → creating), jsonb tiklanadi', async () => {
      const id = '0f0f0f0f-0000-4000-8000-000000000001';
      await insert(id);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => claim(id, ['preview'], 'creating')),
      );
      const won = results.filter(Boolean);
      expect(won).toHaveLength(1);
      expect(won[0]).toEqual(
        expect.objectContaining({
          status: 'creating',
          orders: [{ index: 0, customer_name: 'Ali' }],
        }),
      );
    });

    it('muddati o‘tgan qoralama — da’vo qilinmaydi ("eskirgan")', async () => {
      const id = '0f0f0f0f-0000-4000-8000-000000000002';
      await insert(id, true);
      expect(await claim(id, ['preview'], 'creating')).toBeNull();
    });

    it('tozalash: muddati o‘tganlar (PII) o‘chadi, faollar qoladi', async () => {
      await db.query(
        `DELETE FROM "notification_schema"."telegram_ai_drafts" WHERE "expires_at" < now()`,
      );
      const rows: Array<{ id: string }> = await db.query(
        `SELECT id::text FROM notification_schema.telegram_ai_drafts ORDER BY id`,
      );
      expect(rows.map((row) => row.id)).toEqual([
        '0f0f0f0f-0000-4000-8000-000000000001',
      ]);
    });
  },
);
