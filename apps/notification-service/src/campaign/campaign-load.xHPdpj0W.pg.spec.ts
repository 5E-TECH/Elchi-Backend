import { Logger } from '@nestjs/common';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { OutboxEvent, OutboxService } from '@app/common';
import { Notification } from '../entities/notification.entity';
import { TelegramSession } from '../entities/telegram-session.entity';
import { NotificationInboxService } from '../notification-inbox.service';
import { BotRuntimeService } from '../bot/bot-runtime.service';
import { BotSessionService } from '../bot/bot-session.service';
import { CreateNotificationCampaigns1716000000076 } from '../../../../migrations/1716000000076-CreateNotificationCampaigns';
import { NotificationCampaignPausedUntil1716000000106 } from '../../../../migrations/1716000000106-NotificationCampaignPausedUntil';
import { NotificationCampaignRequestedAt1716000000151 } from '../../../../migrations/1716000000151-NotificationCampaignRequestedAt';
import { CampaignService } from './campaign.service';
import { CAMPAIGN_BATCH_PATTERN } from './campaign-limits';
import { NotificationCampaign } from './notification-campaign.entity';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  };
});

/**
 * (xHPdpj0W TC10 / TC11) Kampaniya BAJARILAYOTGANDA notification-service
 * jarayonining qolgan ishi to'xtamaydi — HAQIQIY Postgres, bitta jarayon,
 * bitta ulanishlar havzasi (prod'dagidek: partiya handleri, bot va inbox
 * o'qishlari bir servisda):
 *
 *  - 5000 qabul qiluvchili kampaniya outbox partiyalari (200 tadan) bilan
 *    TO'LIQ bajariladi;
 *  - SHU PAYTDA haqiqiy `BotRuntimeService` polling sikli aylanadi (soxta
 *    Telegram: getUpdates 100 ms "long-poll" + 1 update; offset haqiqiy
 *    `telegram_sessions` ga yoziladi) — TC10: sikl to'xtamaydi, ikki
 *    getUpdates orasida 1 s dan katta uzilish yo'q, xato logi yo'q;
 *  - SHU PAYTDA 5 ta foydalanuvchi `GET /notifications/inbox` ni
 *    (`NotificationInboxService.list`, gateway shu RPC'ni chaqiradi) 25 ms
 *    oraliq bilan so'raydi — TC11: p95 < 500 ms (ULTRACODE qayta tekshiruvi
 *    taklif qilgan o'lchov mezoni); kampaniyasiz bazaviy p95 ham o'lchanadi;
 *  - event loop kechikishi (`monitorEventLoopDelay`) — bitta partiya
 *    jarayonni bloklamaydi.
 *
 *   NOTIFICATION_CAMPAIGN_LOAD_PG_TEST_URI=postgres://postgres@127.0.0.1:55444/elchi_campaign_load_test \
 *     npx jest apps/notification-service/src/campaign/campaign-load.xHPdpj0W.pg.spec.ts --runInBand
 *
 * ⚠️ Faqat lokal `elchi_campaign_load_test` bazasida (sxemani tozalaydi).
 * Real Telegram / SMS / push CHAQIRILMAYDI — hammasi soxta.
 */
const uri = process.env.NOTIFICATION_CAMPAIGN_LOAD_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_campaign_load_test'
  );
})();

const USER_BASE = 8_000_000;
const AUDIENCE = 5000;
/** Inbox'ni so'raydigan foydalanuvchilar — auditoriya ichida (inbox o'sadi). */
const READERS = Array.from({ length: 5 }, (_, i) => String(USER_BASE + i * 7));
/** Har o'quvchida kampaniyadan oldin bor bildirishnomalar. */
const SEED_PER_READER = 300;
/** Boshqa foydalanuvchilarning fon qatorlari (jadval bo'sh bo'lmasin). */
const SEED_BACKGROUND = 50_000;
const READER_THINK_MS = 25;
const BASELINE_MS = 2_000;

/** Soxta Telegram long-poll davomiyligi va sikl qadami (pollOnce → next(200)). */
const LONG_POLL_MS = 100;
const POLL_STEP_MS = 200;
/** "Uzilish" chegarasi: ikki getUpdates orasidagi oraliq shundan oshmasin. */
const MAX_POLL_GAP_MS = 1_000;
/** TC11 mezoni: kampaniya paytida inbox p95. */
const INBOX_P95_LIMIT_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const percentile = (values: number[], p: number): number => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
};

const round1 = (n: number) => Math.round(n * 10) / 10;

interface LoadMetrics {
  campaignMs: number;
  batches: number;
  row: NotificationCampaign;
  baseline: number[];
  during: number[];
  inboxErrors: number;
  pollTimes: number[];
  pollsAfterCampaign: number;
  dispatched: number;
  loopMaxMs: number;
  loopP99Ms: number;
  botErrors: string[];
}

(localTestDatabase ? describe : describe.skip)(
  'xHPdpj0W TC10/TC11 — kampaniya paytida bot polling va inbox (Postgres)',
  () => {
    let db: DataSource;
    let campaigns: CampaignService;
    let outbox: OutboxService;
    let inbox: NotificationInboxService;
    let sessions: BotSessionService;
    let metrics: LoadMetrics;

    const users = Array.from({ length: AUDIENCE }, (_, i) => ({
      id: String(USER_BASE + i),
      role: 'courier',
    }));

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const setup = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [Notification, OutboxEvent, TelegramSession],
        synchronize: false,
      });
      await setup.initialize();
      await setup.query('DROP SCHEMA IF EXISTS "notification_schema" CASCADE');
      await setup.query('CREATE SCHEMA "notification_schema"');
      await setup.synchronize();
      await setup.destroy();

      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [
          Notification,
          OutboxEvent,
          TelegramSession,
          NotificationCampaign,
        ],
        synchronize: false,
      });
      await db.initialize();
      const runner = db.createQueryRunner();
      try {
        await new CreateNotificationCampaigns1716000000076().up(runner);
        await new NotificationCampaignPausedUntil1716000000106().up(runner);
        await new NotificationCampaignRequestedAt1716000000151().up(runner);
      } finally {
        await runner.release();
      }

      // Fon: boshqa foydalanuvchilarning qatorlari + o'quvchilarning inbox'i.
      await db.query(
        `INSERT INTO notification_schema.notifications
           (recipient_id, recipient_role, type, title, body, "createdAt")
         SELECT 9000000 + (g % 4000), 'market', 'system.manual', 'Fon', 'Matn',
                now() - (g || ' seconds')::interval
         FROM generate_series(1, $1::int) AS g`,
        [SEED_BACKGROUND],
      );
      await db.query(
        `INSERT INTO notification_schema.notifications
           (recipient_id, recipient_role, type, title, body, is_read, "createdAt")
         SELECT r::bigint, 'courier', 'system.manual', 'Eski', 'Matn',
                (g % 3 = 0), now() - (g || ' minutes')::interval
         FROM unnest($1::text[]) AS r, generate_series(1, $2::int) AS g`,
        [READERS, SEED_PER_READER],
      );
      await db.query('ANALYZE notification_schema.notifications');

      inbox = new NotificationInboxService(
        db.getRepository(Notification),
        {} as never,
        { emit: jest.fn(() => of(null)) } as never,
        {} as never,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
        { enqueue: jest.fn() } as never,
        { assertFanout: jest.fn() } as never,
      );
      outbox = new OutboxService(db.getRepository(OutboxEvent));
      campaigns = new CampaignService(
        db.getRepository(NotificationCampaign),
        {} as never,
        inbox,
        outbox,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
        { get: jest.fn(() => undefined) } as never,
      );
      sessions = new BotSessionService(db.getRepository(TelegramSession));

      // identity.audience.resolve: keyset sahifa (campaign.pg.spec bilan bir xil).
      rmqSendMock.mockImplementation(
        (_client: unknown, pattern: { cmd: string }, payload: any) => {
          if (pattern.cmd !== 'identity.audience.resolve') {
            return Promise.reject(new Error(`unexpected ${pattern.cmd}`));
          }
          const after = payload.after_id ? Number(payload.after_id) : 0;
          const items = users
            .filter((user) => Number(user.id) > after)
            .slice(0, payload.limit)
            .map((user) => ({ ...user, language: 'uz', phone_valid: true }));
          return Promise.resolve({
            statusCode: 200,
            data: {
              items,
              total: payload.with_total === false ? null : users.length,
              next_after_id:
                items.length === payload.limit
                  ? items[items.length - 1].id
                  : null,
            },
          });
        },
      );

      metrics = await runLoad();
      // Natija hisobotga (karta izohi) — raqamlar bilan.
      console.info(
        `[xHPdpj0W load] ${JSON.stringify({
          campaign_ms: Math.round(metrics.campaignMs),
          batches: metrics.batches,
          inbox_baseline: {
            n: metrics.baseline.length,
            p50: round1(percentile(metrics.baseline, 50)),
            p95: round1(percentile(metrics.baseline, 95)),
            max: round1(Math.max(...metrics.baseline)),
          },
          inbox_during_campaign: {
            n: metrics.during.length,
            p50: round1(percentile(metrics.during, 50)),
            p95: round1(percentile(metrics.during, 95)),
            max: round1(Math.max(...metrics.during)),
          },
          poll: {
            iterations: metrics.pollTimes.length - 2,
            max_gap_ms: round1(maxGap(metrics.pollTimes)),
            after_campaign: metrics.pollsAfterCampaign,
            dispatched: metrics.dispatched,
          },
          event_loop: {
            max_ms: round1(metrics.loopMaxMs),
            p99_ms: round1(metrics.loopP99Ms),
          },
        })}`,
      );
    }, 180_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS "notification_schema" CASCADE');
        await db.destroy();
      }
      jest.restoreAllMocks();
    });

    const maxGap = (times: number[]) => {
      let max = 0;
      for (let i = 1; i < times.length; i += 1) {
        max = Math.max(max, times[i] - times[i - 1]);
      }
      return max;
    };

    /** Outbox publisher o'rnida: vaqti kelgan partiyalarni ketma-ket bajaradi. */
    const drainOutbox = async (campaignId: string) => {
      let batches = 0;
      for (let round = 0; round < 500; round += 1) {
        const due = (await outbox.getDuePending(50)).filter(
          (event) =>
            event.pattern === CAMPAIGN_BATCH_PATTERN &&
            (event.payload as any).campaign_id === campaignId,
        );
        if (!due.length) return batches;
        for (const event of due) {
          await campaigns.runBatch(event.payload as never);
          await outbox.markPublished(event.id);
          batches += 1;
        }
      }
      throw new Error('outbox drain did not finish');
    };

    /** N ta o'quvchi `stop()` gacha inbox'ni so'raydi; latency (ms) yig'iladi. */
    const startReaders = () => {
      const samples: number[] = [];
      let errors = 0;
      let running = true;
      const loops = READERS.map(async (recipientId, i) => {
        await sleep(i * 5);
        while (running) {
          const t0 = performance.now();
          try {
            await inbox.list({
              recipient_id: recipientId,
              page: 1,
              limit: 20,
            } as never);
            samples.push(performance.now() - t0);
          } catch {
            errors += 1;
          }
          await sleep(READER_THINK_MS);
        }
      });
      return {
        samples,
        errors: () => errors,
        stop: async () => {
          running = false;
          await Promise.all(loops);
        },
      };
    };

    /** Haqiqiy BotRuntimeService polling (soxta Telegram), getUpdates vaqtlari. */
    const startBot = () => {
      const pollTimes: number[] = [];
      const errors: string[] = [];
      let dispatched = 0;
      let updateId = 1;
      jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((message: unknown) => {
          errors.push(String(message));
        });
      const transport = {
        getMe: jest.fn().mockResolvedValue({ username: 'elchi_load_bot' }),
        getWebhookInfo: jest.fn().mockResolvedValue({ url: '' }),
        getUpdates: jest.fn(async () => {
          pollTimes.push(performance.now());
          await sleep(LONG_POLL_MS);
          const id = updateId++;
          return [
            {
              update_id: id,
              message: {
                message_id: id,
                chat: { id: 40, type: 'private' },
                from: { id: 40 },
                text: '/help',
              },
            },
          ];
        }),
        describe: (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      };
      const router = {
        dispatch: jest.fn(() => {
          dispatched += 1;
          return Promise.resolve();
        }),
      };
      const config = {
        get: (key: string) =>
          ({
            TELEGRAM_BOT_TOKEN: '123456:load-spec-token-abcdef',
            TELEGRAM_BOT_MODE: 'polling',
            BOT_POLLING_LEADER: 'true',
          })[key],
      };
      const runtime = new BotRuntimeService(
        config as never,
        transport as never,
        router as never,
        sessions,
        {} as never,
      );
      return {
        runtime,
        pollTimes,
        errors,
        dispatched: () => dispatched,
        start: () => runtime.onApplicationBootstrap(),
        stop: () => runtime.onModuleDestroy(),
      };
    };

    async function runLoad(): Promise<LoadMetrics> {
      // 1) Bazaviy: kampaniyasiz inbox javob vaqti.
      const base = startReaders();
      await sleep(BASELINE_MS);
      await base.stop();

      // 2) Bot polling ishga tushadi, keyin kampaniya.
      const bot = startBot();
      await bot.start();
      await sleep(600);

      const readers = startReaders();
      const histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
      const t0 = performance.now();
      const res: any = await campaigns.create({
        type: 'system.manual',
        title: "E'lon",
        body: 'Matn',
        roles: ['courier'],
        idempotency_key: 'load-key-1',
        requester: { id: '25', roles: ['admin'] },
      });
      const campaignId = String(res.data.campaign_id);
      const batches = await drainOutbox(campaignId);
      const campaignMs = performance.now() - t0;
      histogram.disable();
      await readers.stop();

      // Kampaniyadan KEYIN ham sikl aylanayaptimi (to'xtab qolmaganmi).
      const pollsAtEnd = bot.pollTimes.length;
      await sleep(1_000);
      const pollsAfterCampaign = bot.pollTimes.length - pollsAtEnd;
      bot.stop();
      await sleep(LONG_POLL_MS + 50);

      const tEnd = t0 + campaignMs;
      return {
        campaignMs,
        batches,
        row: await db
          .getRepository(NotificationCampaign)
          .findOneByOrFail({ id: campaignId }),
        baseline: base.samples,
        during: readers.samples,
        inboxErrors: readers.errors() + base.errors(),
        // Kampaniya oynasi chegaralari + oynadagi getUpdates vaqtlari:
        // oyna boshi/oxiridagi to'xtash ham "uzilish" sifatida o'lchanadi.
        pollTimes: [
          t0,
          ...bot.pollTimes.slice(0, pollsAtEnd).filter((t) => t > t0),
          tEnd,
        ],
        pollsAfterCampaign,
        dispatched: bot.dispatched(),
        loopMaxMs: histogram.max / 1e6,
        loopP99Ms: histogram.percentile(99) / 1e6,
        botErrors: bot.errors,
      };
    }

    it('kampaniya to‘liq bajarildi (5000 qabul qiluvchi, 200 talik partiyalar)', () => {
      expect(metrics.batches).toBe(26);
      expect(metrics.row).toEqual(
        expect.objectContaining({ status: 'done', sent: 5000, failed: 0 }),
      );
    });

    it('TC10: kampaniya davomida bot polling sikli to‘xtamaydi — uzilish (>1 s) yo‘q, xato logi yo‘q', () => {
      // Sikl qadami ~ LONG_POLL_MS + POLL_STEP_MS (+ offset yozuvi).
      const expectedStep = LONG_POLL_MS + POLL_STEP_MS;
      const minIterations = Math.floor(
        (metrics.campaignMs / (expectedStep + 200)) * 0.8,
      );
      const iterations = metrics.pollTimes.length - 2;
      expect(iterations).toBeGreaterThanOrEqual(Math.max(3, minIterations));
      expect(maxGap(metrics.pollTimes)).toBeLessThan(MAX_POLL_GAP_MS);
      // Kampaniyadan keyin ham aylanadi.
      expect(metrics.pollsAfterCampaign).toBeGreaterThanOrEqual(2);
      // Har getUpdates update'i router'ga yetdi; "getUpdates xato" logi yo'q.
      expect(metrics.dispatched).toBeGreaterThanOrEqual(iterations);
      expect(metrics.botErrors).toEqual([]);
      // Partiya jarayonni bloklamaydi: event loop kechikishi past.
      expect(metrics.loopMaxMs).toBeLessThan(MAX_POLL_GAP_MS / 2);
    });

    it(`TC11: kampaniya paytida GET /notifications/inbox p95 < ${INBOX_P95_LIMIT_MS} ms (xatosiz)`, () => {
      expect(metrics.inboxErrors).toBe(0);
      expect(metrics.baseline.length).toBeGreaterThan(20);
      // Kampaniya davomida o'quvchilar haqiqatan so'rov yuborgan.
      expect(metrics.during.length).toBeGreaterThan(20);
      expect(percentile(metrics.during, 95)).toBeLessThan(INBOX_P95_LIMIT_MS);
    });
  },
);
