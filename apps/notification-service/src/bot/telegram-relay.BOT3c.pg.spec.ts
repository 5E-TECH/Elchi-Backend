import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TelegramBotCore1716000000120 } from '../../../../migrations/1716000000120-TelegramBotCore';
import { TelegramMarketInactiveReason1716000000150 } from '../../../../migrations/1716000000150-TelegramMarketInactiveReason';
import { TelegramOutboxDeliveryBlocks1716000000192 } from '../../../../migrations/1716000000192-TelegramOutboxDeliveryBlocks';
import { TelegramMarket } from '../entities/telegram-market.entity';
import { TelegramOutbox } from '../entities/telegram-outbox.entity';
import { TelegramSession } from '../entities/telegram-session.entity';
import { NotificationServiceService } from '../notification-service.service';
import { BotChannelService } from './bot-channel.service';
import { BotMaintenanceService } from './bot-maintenance.service';
import { BotOutboxService } from './bot-outbox.service';
import { BotSessionService } from './bot-session.service';
import {
  makeChannels,
  makeFetch,
  makeTransport,
  okResponse,
  telegramResponse,
} from './testing/bot-kit-spec';

/**
 * BOT-3c — HAQIQIY Postgres'da (faqat lokal test bazasi):
 *  - guruh relay'i (bekor / market guruhi xabari) dispatch tranzaksiyasi
 *    ichida outbox'ga: rollback → xabar yo'q; commit'dan keyin jarayon
 *    yiqilsa ham ishchi yuboradi;
 *  - `queued` / `retrying` — yakuniy `sent` / `failed` ni outbox ishchisi
 *    yozadi (429 → queued → sent, takror yo'q);
 *  - blok belgisi muddatsiz jadvalda (25 soatdan keyin ham), `member` da
 *    o'chadi; migratsiya eski sessiya belgilarini ko'chiradi.
 *
 *   BOT_PG_TEST_URI=postgres://postgres@127.0.0.1:55432/elchi_bot_test npx jest telegram-relay.BOT3c
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

const env = {
  TELEGRAM_BOT_TOKEN: '1234567890:ENV_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaa',
};

(localTestDatabase ? describe : describe.skip)(
  'BOT-3c — relay outbox tranzaksiyada, yakuniy holat, muddatsiz blok (lokal Postgres)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;

    const run = async (migration: { up: (runner: never) => Promise<void> }) => {
      const runner = db.createQueryRunner();
      try {
        await migration.up(runner as never);
      } finally {
        await runner.release();
      }
    };

    const makeOutbox = (fetchMock = makeFetch()) => {
      const outbox = new BotOutboxService(
        db.getRepository(TelegramOutbox),
        makeTransport(fetchMock, env),
        makeChannels() as never,
        {
          get: (key: string) => (env as Record<string, unknown>)[key],
        } as never,
      );
      const notifications = new NotificationServiceService(
        db.getRepository(TelegramMarket),
        {} as never,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
        outbox,
        {} as never,
      );
      return { outbox, notifications, fetchMock };
    };

    const insertNotification = async (telegram: string) => {
      const [row]: Array<{ id: string }> = await db.query(
        `INSERT INTO notification_schema.notifications (delivery)
         VALUES (jsonb_build_object('telegram', $1::text)) RETURNING id`,
        [telegram],
      );
      return String(row.id);
    };
    const deliveryOf = async (id: string) => {
      const [row]: Array<{ delivery: Record<string, string> }> = await db.query(
        `SELECT delivery FROM notification_schema.notifications WHERE id = $1`,
        [id],
      );
      return row.delivery;
    };
    const outboxCount = async () => {
      const [row]: Array<{ n: string }> = await db.query(
        `SELECT count(*)::text AS n FROM notification_schema.telegram_outbox`,
      );
      return Number(row.n);
    };

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [TelegramSession, TelegramOutbox, TelegramMarket],
        extra: { max: 5 },
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
      await db.query('CREATE SCHEMA notification_schema');
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
      // Inbox qatorlari — faqat `delivery` (outbox shu ustunni yakunlaydi).
      await db.query(`
        CREATE TABLE notification_schema.notifications (
          "id" bigserial PRIMARY KEY,
          "delivery" jsonb NULL
        )`);
      await db.query(`
        INSERT INTO notification_schema.telegram_markets
          (market_id, group_id, group_type)
        VALUES (5, '-100556', 'cancel'), (5, '-100557', 'create')`);
      await run(new TelegramBotCore1716000000120());
      await run(new TelegramMarketInactiveReason1716000000150());
      // Migratsiyadan OLDIN bloklagan chat (eski 24 soatlik sessiya belgisi).
      await db.query(`
        INSERT INTO notification_schema.telegram_sessions
          (chat_id, bot_slug, state, expires_at)
        VALUES ('5550099', 'elchi', '{"blocked_at": "2026-10-01T10:00:00Z"}', now() + interval '1 hour')`);
      await run(new TelegramOutboxDeliveryBlocks1716000000192());
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
        await db.destroy();
      }
      jest.restoreAllMocks();
    });

    beforeEach(async () => {
      await db.query(`DELETE FROM notification_schema.telegram_outbox`);
    });

    it('⭐ bekor xabari: dispatch tranzaksiyasi ROLLBACK → outbox qatori ham yo‘q', async () => {
      const { notifications } = makeOutbox();
      await expect(
        db.transaction(async (manager) => {
          const ids = await notifications.enqueueGroupRelay(
            manager,
            { market_id: '5', group_type: 'cancel' as never },
            'Buyurtma bekor qilindi',
            [],
          );
          expect(ids).toHaveLength(1);
          throw new Error('dispatch yiqildi');
        }),
      ).rejects.toThrow('dispatch yiqildi');
      expect(await outboxCount()).toBe(0);
    });

    it('⭐ commit’dan keyin jarayon yiqildi (sendNow chaqirilmadi) — servis qayta turgach ishchi yuboradi, inbox `sent`', async () => {
      const id = await insertNotification('queued');
      const before = makeOutbox();
      await db.transaction((manager) =>
        before.notifications.enqueueGroupRelay(
          manager,
          { market_id: '5', group_type: 'cancel' as never },
          'Buyurtma bekor qilindi',
          [id],
        ),
      );
      // «Restart»: yangi servis nusxasi, faqat worker.
      const after = makeOutbox();
      expect(await after.outbox.processDue()).toBe(1);
      expect(after.fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = after.fetchMock.mock.calls[0];
      expect(JSON.parse(init.body as string)).toMatchObject({
        chat_id: '-100556',
        text: 'Buyurtma bekor qilindi',
        parse_mode: 'HTML',
      });
      expect(await deliveryOf(id)).toEqual({ telegram: 'sent' });
    });

    it('⭐ 429 → queued (inbox `queued` qoladi) → worker → sent; takror yo‘q', async () => {
      const id = await insertNotification('queued');
      const fetchMock = makeFetch();
      fetchMock
        .mockResolvedValueOnce(
          telegramResponse(429, {
            ok: false,
            description: 'Too Many Requests: retry after 1',
            parameters: { retry_after: 1 },
          }),
        )
        .mockResolvedValue(okResponse());
      const { notifications, outbox } = makeOutbox(fetchMock);
      const ids = (await db.transaction((manager) =>
        notifications.enqueueGroupRelay(
          manager,
          { market_id: '5', group_type: 'cancel' as never },
          'x',
          [id],
        ),
      ))!;
      const flushed = await notifications.flushGroupRelay(ids);
      expect(flushed.data).toMatchObject({ success: 0, queued: 1, failed: 0 });
      expect(await deliveryOf(id)).toEqual({ telegram: 'queued' });
      // Takroriy sendNow (masalan qayta yetkazish) — da'vo yo'q, yuborilmaydi.
      expect(await outbox.sendNow(ids)).toEqual([
        { id: ids[0], status: 'queued' },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await db.query(
        `UPDATE notification_schema.telegram_outbox SET next_attempt_at = now()`,
      );
      expect(await outbox.processDue()).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await deliveryOf(id)).toEqual({ telegram: 'sent' });
      expect(await outbox.processDue()).toBe(0);
    });

    it('DM `retrying` → dead (400) → inbox `failed` + sabab; yakunlangan qator qayta yozilmaydi', async () => {
      const retrying = await insertNotification('retrying');
      const alreadySent = await insertNotification('sent');
      const fetchMock = makeFetch();
      fetchMock.mockResolvedValue(
        telegramResponse(400, {
          ok: false,
          description: 'Bad Request: message is too long',
        }),
      );
      const { outbox } = makeOutbox(fetchMock);
      const result = await outbox.send({
        chatId: '5550011',
        text: 'x',
        source: 'notification.dm',
        notificationIds: [retrying, alreadySent],
      });
      expect(result.status).toBe('dead');
      expect(await deliveryOf(retrying)).toMatchObject({
        telegram: 'failed',
        telegram_error: expect.stringContaining('too long') as unknown,
      });
      expect(await deliveryOf(alreadySent)).toEqual({ telegram: 'sent' });
    });

    it('market guruhi yo‘q — null (not_eligible), outbox qatori yo‘q', async () => {
      const { notifications } = makeOutbox();
      await expect(
        db.transaction((manager) =>
          notifications.enqueueGroupRelay(
            manager,
            { market_id: '999' },
            'x',
            [],
          ),
        ),
      ).resolves.toBeNull();
      expect(await outboxCount()).toBe(0);
    });

    describe('blok belgisi muddatsiz (NIMA 9)', () => {
      const channels = () =>
        new BotChannelService(
          db.getRepository(TelegramMarket),
          new BotSessionService(db.getRepository(TelegramSession)),
          { log: jest.fn().mockResolvedValue(undefined) } as never,
          { get: () => ({ dispatch: jest.fn() }) } as never,
        );
      const blocked = async (chatId: string) =>
        (
          await db.query<unknown[]>(
            `SELECT 1 FROM notification_schema.telegram_blocked_chats WHERE chat_id = $1`,
            [chatId],
          )
        ).length > 0;

      it('migratsiya eski sessiya belgisini ko‘chirdi', async () => {
        expect(await blocked('5550099')).toBe(true);
      });

      it('⭐ bloklagan odam 25 soatdan keyin (sessiya tozalangach) ham bloklangan; `member` — o‘chadi', async () => {
        await channels().markInactive('5550012', 'elchi', 'blocked_on_send');
        await db.query(
          `UPDATE notification_schema.telegram_blocked_chats
              SET blocked_at = now() - interval '25 hours' WHERE chat_id = '5550012'`,
        );
        await db.query(
          `UPDATE notification_schema.telegram_sessions SET expires_at = now() - interval '1 hour'`,
        );
        await new BotMaintenanceService(db).prune();
        expect(await blocked('5550012')).toBe(true);
        await channels().markActive('5550012', 'elchi');
        expect(await blocked('5550012')).toBe(false);
        // Takroriy blok — xatosiz (upsert).
        await channels().markInactive('5550012', 'elchi', 'kicked');
        await channels().markInactive('5550012', 'elchi', 'kicked');
        expect(await blocked('5550012')).toBe(true);
      });
    });
  },
);
