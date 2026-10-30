import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TelegramBotCore1716000000120 } from '../../../../migrations/1716000000120-TelegramBotCore';
import { TelegramMarketInactiveReason1716000000150 } from '../../../../migrations/1716000000150-TelegramMarketInactiveReason';
import { TelegramBotAction } from '../entities/telegram-bot-action.entity';
import { TelegramMarket } from '../entities/telegram-market.entity';
import { TelegramOutbox } from '../entities/telegram-outbox.entity';
import { TelegramRateLimit } from '../entities/telegram-rate-limit.entity';
import { TelegramSession } from '../entities/telegram-session.entity';
import { BotActionsService } from './bot-actions.service';
import { BotChannelService } from './bot-channel.service';
import { BotMaintenanceService } from './bot-maintenance.service';
import { BotOutboxService } from './bot-outbox.service';
import { BotRateLimiterService } from './bot-rate-limiter.service';
import { BotSessionService } from './bot-session.service';
import { ChatSequencer } from './chat-sequencer';
import {
  makeChannels,
  makeFetch,
  makeTransport,
  okResponse,
  telegramResponse,
} from './testing/bot-kit-spec';

/**
 * Telegram bot yadrosi — HAQIQIY Postgres'da (faqat lokal test bazasi):
 * migratsiya 1716000000120 (up/down/qayta up), sessiya TTL va optimistik
 * yangilash, tugma holati (atomik consume), rate-limit + blok, update dedup,
 * TTL tozalash, outbox worker da'vosi, kanalni nofaol qilish, replikalararo
 * advisory qulf. Telegram'ga so'rov YO'Q — fetch soxta.
 *
 *   BOT_PG_TEST_URI=postgres://postgres@127.0.0.1:55443/elchi_bot_test npx jest bot-core.pg
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

const migration = new TelegramBotCore1716000000120();

(localTestDatabase ? describe : describe.skip)(
  'Telegram bot yadrosi — lokal Postgres (UQlmQiGT / GL2GgtEc / 9HIaV80X / bOMYoOtV)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;

    const sessions = () =>
      new BotSessionService(db.getRepository(TelegramSession));
    const actions = () =>
      new BotActionsService(db.getRepository(TelegramBotAction));
    const limiter = () =>
      new BotRateLimiterService(db.getRepository(TelegramRateLimit));
    const runMigration = async (direction: 'up' | 'down') => {
      const runner = db.createQueryRunner();
      try {
        await migration[direction](runner);
      } finally {
        await runner.release();
      }
    };

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [
          TelegramSession,
          TelegramBotAction,
          TelegramRateLimit,
          TelegramOutbox,
          TelegramMarket,
        ],
        extra: { max: 10 },
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
      await db.query('CREATE SCHEMA notification_schema');
      // Baseline'dagi telegram_markets (soddalashtirilgan, eski `token` bilan).
      await db.query(`
        CREATE TABLE notification_schema.telegram_markets (
          "id" bigserial PRIMARY KEY,
          "createdAt" timestamptz NOT NULL DEFAULT now(),
          "updatedAt" timestamptz NOT NULL DEFAULT now(),
          "is_deleted" boolean NOT NULL DEFAULT false,
          "market_id" bigint NOT NULL,
          "group_id" varchar NOT NULL,
          "group_type" varchar NOT NULL,
          "token" varchar NULL,
          "is_active" boolean NOT NULL DEFAULT true
        )`);
      await db.query(`
        INSERT INTO notification_schema.telegram_markets
          (market_id, group_id, group_type, token)
        VALUES (5, '-100555', 'create', 'group_token-abcdef0123456789'),
               (5, '-100556', 'cancel', 'enc:v1:xxxx'),
               (7, '-100777', 'create', NULL)`);
      await runMigration('up');
      // (G085w5Qr) inactive_reason / inactive_at ustunlari.
      const reasonRunner = db.createQueryRunner();
      try {
        await new TelegramMarketInactiveReason1716000000150().up(reasonRunner);
      } finally {
        await reasonRunner.release();
      }
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
        await db.destroy();
      }
      jest.restoreAllMocks();
    });

    describe('migratsiya 1716000000120 (bOMYoOtV #4)', () => {
      it('eski `token` qiymatlari NULL; connect_token_hash + bot_slug qo‘shildi', async () => {
        const rows: Array<Record<string, unknown>> = await db.query(
          `SELECT token, connect_token_hash, bot_slug
             FROM notification_schema.telegram_markets ORDER BY id`,
        );
        expect(rows).toHaveLength(3);
        for (const row of rows) {
          expect(row.token).toBeNull();
          expect(row).toHaveProperty('connect_token_hash', null);
          expect(row).toHaveProperty('bot_slug', null);
        }
      });

      it('qayta up — xavfsiz (IF NOT EXISTS); down → up qayta tiklaydi', async () => {
        await runMigration('up');
        await runMigration('down');
        const gone: unknown[] = await db.query(
          `SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'notification_schema' AND table_name = 'telegram_sessions'`,
        );
        expect(gone).toHaveLength(0);
        await runMigration('up');
        const tables: Array<{ table_name: string }> = await db.query(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'notification_schema' ORDER BY table_name`,
        );
        expect(tables.map((t) => t.table_name)).toEqual(
          expect.arrayContaining([
            'telegram_bot_actions',
            'telegram_outbox',
            'telegram_rate_limits',
            'telegram_sessions',
          ]),
        );
      });
    });

    describe('telegram_sessions (UQlmQiGT)', () => {
      it('⭐ restart simulyatsiyasi: yangi servis nusxasi holatni DB’dan tiklaydi', async () => {
        await sessions().update('900001', 'elchi', () => ({
          state: { menu: 'orders', order_ids: ['101', '102'] },
          user_id: '37',
        }));
        // "Restart": butunlay yangi servis va repozitoriya nusxasi.
        const restored = await sessions().load('900001', 'elchi');
        expect(restored.state).toEqual({
          menu: 'orders',
          order_ids: ['101', '102'],
        });
        expect(restored.user_id).toBe('37');
      });

      it('⭐ expires_at o‘tgan sessiya o‘qilmaydi — yangi `initial` holat', async () => {
        await sessions().update('900002', 'elchi', () => ({
          state: { step: 'awaiting_proof' },
          user_id: '25',
        }));
        await db.query(
          `UPDATE notification_schema.telegram_sessions
              SET expires_at = now() - interval '1 minute' WHERE chat_id = '900002'`,
        );
        const loaded = await sessions().load('900002', 'elchi');
        expect(loaded.state).toEqual({});
        expect(loaded.user_id).toBeNull();
        // Eskirgan qator ustiga yozish ham ishlaydi (TTL suriladi).
        const next = await sessions().update('900002', 'elchi', (s) => ({
          state: { ...s.state, fresh: true },
        }));
        expect(next.state).toEqual({ fresh: true });
      });

      it('⭐ ikki parallel update bitta chat holatini buzmaydi (optimistik)', async () => {
        const bump = () =>
          sessions().update('900003', 'elchi', (s) => ({
            state: { n: Number(s.state.n ?? 0) + 1 },
          }));
        await Promise.all([bump(), bump()]);
        const final = await sessions().load('900003', 'elchi');
        expect(final.state.n).toBe(2);
      });

      it('state ichiga PII yozilmaydi (DB’ga ham tushmaydi)', async () => {
        await expect(
          sessions().update('900004', 'elchi', () => ({
            state: { customer_phone: '+998901234567' },
          })),
        ).rejects.toThrow(/PII/);
        const rows: unknown[] = await db.query(
          `SELECT 1 FROM notification_schema.telegram_sessions WHERE chat_id = '900004'`,
        );
        expect(rows).toHaveLength(0);
      });

      it('polling offset shu jadvalda, TTL’siz (UQlmQiGT #4)', async () => {
        await sessions().setPollOffset('elchi', 12345);
        expect(await sessions().getPollOffset('elchi')).toBe(12345);
        await sessions().setPollOffset('elchi', 12400);
        expect(await sessions().getPollOffset('elchi')).toBe(12400);
      });
    });

    describe('telegram_bot_actions (Pq2dFj8A / Mvx0h1Fv)', () => {
      it('⭐ restartdan keyin tugma ishlaydi; ikki parallel bosishdan FAQAT bittasi o‘tadi', async () => {
        const data = await actions().create({
          chatId: '900010',
          action: 'order.sold',
          actorUserId: '25',
          orderId: '101',
          payload: { order_id: '101' },
        });
        expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
        // "Restart": yangi servis nusxasi.
        const lookup = await actions().lookup(data);
        expect(lookup.status).toBe('ok');
        const id = data.slice(2);
        const results = await Promise.all([
          actions().consume(id),
          actions().consume(id),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await actions().lookup(data)).status).toBe('consumed');
      });

      it('muddati o‘tgan tugma — expired, band qilinmaydi', async () => {
        const data = await actions().create({
          chatId: '900011',
          action: 'order.sold',
          ttlMs: -1_000,
        });
        expect((await actions().lookup(data)).status).toBe('expired');
        expect(await actions().consume(data.slice(2))).toBe(false);
      });
    });

    describe('telegram_rate_limits (GL2GgtEc)', () => {
      it('⭐ bitta chatdan 25 update → 20 tasi o‘tadi, 5 tasi rad', async () => {
        const service = limiter();
        const decisions: Array<{ allowed: boolean }> = [];
        for (let i = 0; i < 25; i += 1) {
          decisions.push(await service.inbound('900020'));
        }
        expect(decisions.filter((d) => d.allowed)).toHaveLength(20);
        expect(decisions.slice(20).every((d) => !d.allowed)).toBe(true);
        // Boshqa chat ta'sirlanmaydi.
        expect((await service.inbound('900021')).allowed).toBe(true);
      });

      it('⭐ bog‘lash kodi: 6-urinish rad + 15 daqiqalik blok YOZILADI', async () => {
        const service = limiter();
        for (let i = 0; i < 5; i += 1) {
          expect((await service.linkAttempt('777')).allowed).toBe(true);
        }
        const sixth = await service.linkAttempt('777');
        expect(sixth).toEqual({ allowed: false, blocked: true, hits: 6 });
        const [row]: Array<{ minutes: number }> = await db.query(
          `SELECT EXTRACT(EPOCH FROM (blocked_until - now())) / 60 AS minutes
             FROM notification_schema.telegram_rate_limits WHERE bucket = 'link:777'`,
        );
        expect(Number(row.minutes)).toBeGreaterThan(14);
        expect(Number(row.minutes)).toBeLessThanOrEqual(15);
        // Oyna o'tsa ham blok amalda.
        await db.query(
          `UPDATE notification_schema.telegram_rate_limits
              SET window_start = now() - interval '2 minutes' WHERE bucket = 'link:777'`,
        );
        expect((await service.linkAttempt('777')).allowed).toBe(false);
      });

      it('update_id takrori bir marta ishlanadi (webhook qayta yuborishi)', async () => {
        const service = limiter();
        expect(await service.firstSeen(555001)).toBe(true);
        expect(await service.firstSeen(555001)).toBe(false);
      });
    });

    describe('TTL tozalash (UQlmQiGT #2)', () => {
      it('⭐ eskirgan qatorlar o‘chadi, yangilari va tizim qatori qoladi', async () => {
        await db.query(`DELETE FROM notification_schema.telegram_sessions`);
        await db.query(`
          INSERT INTO notification_schema.telegram_sessions
            (chat_id, bot_slug, state, expires_at)
          VALUES ('old', 'elchi', '{}', now() - interval '1 hour'),
                 ('fresh', 'elchi', '{}', now() + interval '1 hour'),
                 ('poll:elchi', 'elchi', '{"offset": 1}', NULL)`);
        await db.query(`
          INSERT INTO notification_schema.telegram_outbox
            (bot_slug, chat_id, payload, status, created_at)
          VALUES ('elchi', '1', '{}', 'sent', now() - interval '4 days'),
                 ('elchi', '2', '{}', 'sent', now()),
                 ('elchi', '3', '{}', 'dead', now() - interval '31 days'),
                 ('elchi', '4', '{}', 'pending', now() - interval '40 days'),
                 ('elchi', '5', '{}', 'dead', now() - interval '8 days'),
                 ('elchi', '6', '{}', 'dead', now() - interval '6 days')`);
        // (BOT-2 #4) bog'lash kodlari — 30 kundan eskisi o'chadi.
        await db.query(`
          CREATE TABLE IF NOT EXISTS notification_schema.telegram_link_tokens (
            "token_hash" varchar(64) PRIMARY KEY,
            "created_at" timestamptz NOT NULL DEFAULT now()
          )`);
        await db.query(`
          INSERT INTO notification_schema.telegram_link_tokens (token_hash, created_at)
          VALUES ('old', now() - interval '31 days'), ('new', now() - interval '29 days')`);

        const result = await new BotMaintenanceService(db).prune();

        const left: Array<{ chat_id: string }> = await db.query(
          `SELECT chat_id FROM notification_schema.telegram_sessions ORDER BY chat_id`,
        );
        expect(left.map((r) => r.chat_id)).toEqual(['fresh', 'poll:elchi']);
        expect(result.sessions).toBe(1);
        const outbox: Array<{ chat_id: string }> = await db.query(
          `SELECT chat_id FROM notification_schema.telegram_outbox ORDER BY chat_id`,
        );
        // pending (hali yuborilmagan) HECH QACHON o'chmaydi; BOT-2: dead —
        // 7 kundan keyin.
        expect(outbox.map((r) => r.chat_id)).toEqual(['2', '4', '6']);
        const tokens: Array<{ token_hash: string }> = await db.query(
          `SELECT token_hash FROM notification_schema.telegram_link_tokens`,
        );
        expect(tokens.map((r) => r.token_hash)).toEqual(['new']);
        expect(result.linkTokens).toBe(1);
      });
    });

    describe('telegram_outbox worker (9HIaV80X #3)', () => {
      it('⭐ 429 → pending (retry_count++), worker keyin yuboradi → sent', async () => {
        await db.query(`DELETE FROM notification_schema.telegram_outbox`);
        const fetchMock = makeFetch();
        fetchMock.mockResolvedValueOnce(
          telegramResponse(429, {
            ok: false,
            description: 'Too Many Requests: retry after 1',
            parameters: { retry_after: 1 },
          }),
        );
        const env = {
          TELEGRAM_BOT_TOKEN: '1234567890:ENV_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaa',
        };
        const outbox = new BotOutboxService(
          db.getRepository(TelegramOutbox),
          makeTransport(fetchMock, env),
          makeChannels() as never,
          {
            get: (key: string) => (env as Record<string, unknown>)[key],
          } as never,
        );
        const first = await outbox.send({
          chatId: '-100555',
          text: 'salom',
          source: 'test',
        });
        expect(first.status).toBe('queued');
        let [row]: Array<Record<string, any>> = await db.query(
          `SELECT * FROM notification_schema.telegram_outbox WHERE id = $1`,
          [first.id],
        );
        expect(row.status).toBe('pending');
        expect(row.retry_count).toBe(1);
        // retry_after kelishini kutmasdan — vaqtni oldinga suramiz.
        await db.query(
          `UPDATE notification_schema.telegram_outbox SET next_attempt_at = now() WHERE id = $1`,
          [first.id],
        );
        fetchMock.mockResolvedValueOnce(okResponse());
        expect(await outbox.processDue()).toBe(1);
        [row] = await db.query(
          `SELECT * FROM notification_schema.telegram_outbox WHERE id = $1`,
          [first.id],
        );
        expect(row.status).toBe('sent');
        // (BOT-2 #4) yuborilgan xabar matni bazada qolmaydi.
        expect(row.payload).toEqual({});
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    });

    describe('kanal nofaol (9HIaV80X #1)', () => {
      it('⭐ guruh qatorlari is_active=false, admin xabari bitta', async () => {
        const dispatch = jest.fn().mockResolvedValue({});
        const channels = new BotChannelService(
          db.getRepository(TelegramMarket),
          sessions(),
          { log: jest.fn().mockResolvedValue(undefined) } as never,
          { get: () => ({ dispatch }) } as never,
        );
        const result = await channels.markInactive(
          '-100555',
          'elchi',
          'kicked',
        );
        expect(result.deactivated).toBe(1);
        const [row]: Array<{ is_active: boolean }> = await db.query(
          `SELECT is_active FROM notification_schema.telegram_markets WHERE group_id = '-100555'`,
        );
        expect(row.is_active).toBe(false);
        // (G085w5Qr) sabab + vaqt qatorda.
        const [reasonRow]: Array<{
          inactive_reason: string;
          inactive_at: Date | null;
        }> = await db.query(
          `SELECT inactive_reason, inactive_at FROM notification_schema.telegram_markets WHERE group_id = '-100555'`,
        );
        expect(reasonRow.inactive_reason).toBe('kicked');
        expect(reasonRow.inactive_at).not.toBeNull();
        // CHECK: ro'yxatda yo'q sabab yozilmaydi.
        await expect(
          db.query(
            `UPDATE notification_schema.telegram_markets SET inactive_reason = 'boshqa' WHERE group_id = '-100555'`,
          ),
        ).rejects.toThrow(/CHK_TG_MARKET_INACTIVE_REASON/);
        // 150 qayta up — xavfsiz; down → up qayta tiklaydi (ma'lumot NULL).
        const reasonRunner = db.createQueryRunner();
        try {
          const reasonMigration =
            new TelegramMarketInactiveReason1716000000150();
          await reasonMigration.up(reasonRunner);
          await reasonMigration.down(reasonRunner);
          await reasonMigration.up(reasonRunner);
        } finally {
          await reasonRunner.release();
        }
        expect(dispatch).toHaveBeenCalledTimes(1);
        // Takror — o'zgarish yo'q, qayta xabar yo'q.
        expect(
          (await channels.markInactive('-100555', 'elchi', 'kicked'))
            .deactivated,
        ).toBe(0);
        expect(dispatch).toHaveBeenCalledTimes(1);
      });
    });

    describe('replikalararo ketma-ketlik (GL2GgtEc #3)', () => {
      it('⭐ ikki "replika" bitta chatning ishini ustma-ust bajarmaydi', async () => {
        const replicaA = new ChatSequencer(db);
        const replicaB = new ChatSequencer(db);
        const events: string[] = [];
        const task = (name: string) => async () => {
          events.push(`${name}:start`);
          await new Promise((resolve) => setTimeout(resolve, 150));
          events.push(`${name}:end`);
        };
        await Promise.all([
          replicaA.run('900030', task('A')),
          replicaB.run('900030', task('B')),
        ]);
        expect(events).toHaveLength(4);
        // Ikkinchisi birinchisi tugagandan KEYIN boshlanadi.
        expect(events[1]).toMatch(/:end$/);
        expect(events[0].split(':')[0]).toBe(events[1].split(':')[0]);
      });
    });
  },
);
