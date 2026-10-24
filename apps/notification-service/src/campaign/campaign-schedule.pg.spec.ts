import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { OutboxEvent, OutboxService } from '@app/common';
import { Notification } from '../entities/notification.entity';
import { NotificationInboxService } from '../notification-inbox.service';
import { CreateNotificationCampaigns1716000000076 } from '../../../../migrations/1716000000076-CreateNotificationCampaigns';
import { NotificationCampaignPausedUntil1716000000106 } from '../../../../migrations/1716000000106-NotificationCampaignPausedUntil';
import { NotificationCampaignRequestedAt1716000000151 } from '../../../../migrations/1716000000151-NotificationCampaignRequestedAt';
import { CampaignService } from './campaign.service';
import { CAMPAIGN_BATCH_PATTERN } from './campaign-limits';
import { promoReleaseAt } from './campaign-schedule';
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
 * (WIsb9Ytq) Haqiqiy Postgres: tungi taqiq darvozasi SQL'i (BITTA
 * `AT TIME ZONE 'Asia/Tashkent'`) sessiya TZ'idan qat'i nazar to'g'ri, va
 * kampaniya oqimi outbox `scheduled_at` bilan: reklama surilib (tashlanmay)
 * 09:00 da ketadi, tranzaksion — tunda ham.
 *
 *   NOTIFICATION_CAMPAIGN_SCHEDULE_PG_TEST_URI=postgres://postgres@127.0.0.1:55491/elchi_campaign_schedule_test
 */
const uri = process.env.NOTIFICATION_CAMPAIGN_SCHEDULE_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_campaign_schedule_test'
  );
})();

/** Toshkent devor soati → UTC lahza (UTC+5, yozgi vaqt yo'q). */
const tash = (local: string) => new Date(`${local}+05:00`);

const USER_BASE = 8_000_000;

(localTestDatabase ? describe : describe.skip)(
  'WIsb9Ytq — tungi taqiq darvozasi (Postgres)',
  () => {
    let db: DataSource;
    let campaigns: CampaignService;
    let outbox: OutboxService;
    let config: Record<string, string | undefined> = {};
    let users: Array<{ id: string; role: string }> = [];

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const setup = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [Notification, OutboxEvent],
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
        entities: [Notification, OutboxEvent, NotificationCampaign],
        synchronize: false,
      });
      await db.initialize();
      const runner = db.createQueryRunner();
      try {
        await new CreateNotificationCampaigns1716000000076().up(runner);
        await new NotificationCampaignPausedUntil1716000000106().up(runner);
        // (fb4qy6bd) requested_at + quiet_hours_shifted.
        await new NotificationCampaignRequestedAt1716000000151().up(runner);
      } finally {
        await runner.release();
      }

      const inbox = new NotificationInboxService(
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
        { get: jest.fn((key: string) => config[key]) } as never,
      );

      rmqSendMock.mockImplementation(
        (_client: unknown, pattern: { cmd: string }, payload: any) => {
          if (pattern.cmd !== 'identity.audience.resolve') {
            return Promise.reject(new Error(`unexpected ${pattern.cmd}`));
          }
          const after = payload.after_id ? Number(payload.after_id) : 0;
          const items = users
            .filter((user) => Number(user.id) > after)
            .slice(0, payload.limit);
          return Promise.resolve({
            statusCode: 200,
            data: {
              items,
              total: payload.with_total === false ? null : users.length,
            },
          });
        },
      );
    }, 60_000);

    afterEach(() => {
      jest.useRealTimers();
      config = {};
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS "notification_schema" CASCADE');
        await db.destroy();
      }
    });

    /** Faqat `Date` soxta — pg drayveri taymerlari haqiqiy qoladi. */
    const clock = (now: Date) => {
      jest.useFakeTimers({
        now,
        doNotFake: [
          'nextTick',
          'setImmediate',
          'clearImmediate',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'queueMicrotask',
          'hrtime',
          'performance',
        ],
      });
    };

    const setUsers = (n: number, offset: number) => {
      users = Array.from({ length: n }, (_, i) => ({
        id: String(USER_BASE + offset + i),
        role: 'courier',
      }));
    };

    const drain = async (campaignId: string) => {
      let batches = 0;
      for (let round = 0; round < 50; round += 1) {
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
      throw new Error('drain did not finish');
    };

    const pendingEvents = async (campaignId: string) =>
      (
        await db.getRepository(OutboxEvent).find({
          where: { pattern: CAMPAIGN_BATCH_PATTERN, status: 'pending' },
          order: { id: 'ASC' },
        })
      ).filter((event) => (event.payload as any).campaign_id === campaignId);

    const row = (id: string) =>
      db.getRepository(NotificationCampaign).findOneByOrFail({ id });

    const written = (id: string) =>
      db.getRepository(Notification).countBy({ group_key: `campaign:${id}` });

    let keySeq = 0;
    const create = async (over: Record<string, unknown> = {}) =>
      (await campaigns.create({
        type: 'marketing.manual',
        title: 'Aksiya',
        body: 'Chegirma',
        roles: ['courier'],
        idempotency_key: `sched-key-${++keySeq}`,
        requester: { id: '25', roles: ['admin'] },
        ...over,
      })) as any;

    it('SQL darvozasi: Toshkent devor soati bo‘yicha, sessiya TZ’iga bog‘liq emas (UTC / New York / Toshkent)', async () => {
      const night = { start: 18 * 60, end: 9 * 60 };
      const day = { start: 12 * 60, end: 14 * 60 };
      const cases: Array<[string, string, { start: number; end: number }]> = [
        ['2026-10-20T19:00:00', '2026-10-21T09:00:00', night],
        ['2026-10-20T18:00:00', '2026-10-21T09:00:00', night],
        ['2026-10-20T17:59:59.999', '2026-10-20T17:59:59.999', night],
        ['2026-10-20T23:59:30', '2026-10-21T09:00:00', night],
        ['2026-10-21T00:00:00', '2026-10-21T09:00:00', night],
        ['2026-10-21T03:30:15.250', '2026-10-21T09:00:00', night],
        ['2026-10-21T08:59:59', '2026-10-21T09:00:00', night],
        ['2026-10-21T09:00:00', '2026-10-21T09:00:00', night],
        ['2026-10-21T10:00:00', '2026-10-21T10:00:00', night],
        // oy/yil chegarasi
        ['2026-12-31T21:15:00', '2027-01-01T09:00:00', night],
        // kunduzgi oyna (start < end) — sozlama boshqacha bo'lsa ham
        ['2026-10-20T13:00:00', '2026-10-20T14:00:00', day],
        ['2026-10-20T11:59:00', '2026-10-20T11:59:00', day],
        ['2026-10-20T14:00:00', '2026-10-20T14:00:00', day],
      ];
      for (const zone of ['UTC', 'America/New_York', 'Asia/Tashkent']) {
        const runner = db.createQueryRunner();
        await runner.connect();
        try {
          await runner.query(`SET TIME ZONE '${zone}'`);
          for (const [at, expected, window] of cases) {
            const release = await promoReleaseAt(runner, tash(at), window);
            expect({ zone, at, release: release.toISOString() }).toEqual({
              zone,
              at,
              release: tash(expected).toISOString(),
            });
          }
        } finally {
          await runner.query('RESET TIME ZONE');
          await runner.release();
        }
      }
    });

    it('reklama 19:00 da “darhol” — tashlanmaydi: outbox partiyasi ertangi 09:00 da, ungacha hech kim olmaydi; bekor qilinsa 09:00 da ham ketmaydi', async () => {
      setUsers(5, 0);
      clock(tash('2026-10-20T19:00:00'));
      const res = await create();
      expect(res.statusCode).toBe(202);
      expect(res.data).toEqual(
        expect.objectContaining({
          display_status: 'scheduled',
          quiet_hours_shifted: true,
          requested_scheduled_at: null,
          scheduled_at_tashkent: '2026-10-21T09:00:00+05:00',
        }),
      );
      const id = res.data.campaign_id;
      const [event] = await pendingEvents(id);
      expect(new Date(event.scheduled_at).toISOString()).toBe(
        tash('2026-10-21T09:00:00').toISOString(),
      );
      expect((await row(id)).scheduled_at?.toISOString()).toBe(
        tash('2026-10-21T09:00:00').toISOString(),
      );
      // tun bo'yi — partiya chiqmaydi
      clock(tash('2026-10-21T08:59:00'));
      expect(await drain(id)).toBe(0);
      expect(await written(id)).toBe(0);

      // ro'yxatda "rejalashtirilgan", bekor qilish mumkin
      const listed: any = await campaigns.list({ state: 'scheduled' });
      expect(listed.data.items.map((item: any) => item.id)).toContain(id);
      const cancelled: any = await campaigns.cancel({
        id,
        requester: { id: '25', roles: ['admin'] },
      });
      expect(cancelled.data.display_status).toBe('cancelled');
      expect(cancelled.data.can_cancel).toBe(false);

      clock(tash('2026-10-21T09:00:01'));
      await drain(id);
      expect(await written(id)).toBe(0);
      expect((await row(id)).status).toBe('cancelled');
    });

    it('reklama belgilangan vaqti (20:00) taqiqda — keyingi 09:00 ga; 09:00 da yuboriladi', async () => {
      setUsers(3, 1000);
      clock(tash('2026-10-20T10:00:00'));
      const res = await create({ scheduled_at: '2026-10-20T20:00:00+05:00' });
      const id = res.data.campaign_id;
      expect(res.data.requested_scheduled_at).toEqual(
        tash('2026-10-20T20:00:00'),
      );
      expect(res.data.scheduled_at_tashkent).toBe('2026-10-21T09:00:00+05:00');
      clock(tash('2026-10-20T20:00:30'));
      expect(await drain(id)).toBe(0);
      clock(tash('2026-10-21T09:00:01'));
      await drain(id);
      const done = await row(id);
      expect(done.status).toBe('done');
      expect(done.sent).toBe(3);
    });

    it('17:59 da boshlangan katta reklama: 18:00 dan keyingi partiya ertangi 09:00 ga suriladi (o‘sha partiya), ertalab davom etib tugaydi', async () => {
      setUsers(450, 2000);
      clock(tash('2026-10-20T17:59:30'));
      const res = await create();
      const id = res.data.campaign_id;
      expect(res.data.display_status).toBe('sending');
      // 0-partiya 17:59 da ketadi
      const [first] = await pendingEvents(id);
      await campaigns.runBatch(first.payload as never);
      await outbox.markPublished(first.id);
      expect(await written(id)).toBe(200);

      // 18:00 dan keyin — 1-partiya surildi, hech kim olmadi
      clock(tash('2026-10-20T18:00:05'));
      expect(await drain(id)).toBe(1);
      expect(await written(id)).toBe(200);
      let state = await row(id);
      expect(state.status).toBe('running');
      expect(state.batch_no).toBe(1);
      expect(state.paused_until?.toISOString()).toBe(
        tash('2026-10-21T09:00:00').toISOString(),
      );
      const waiting = await pendingEvents(id);
      expect(waiting).toHaveLength(1);
      expect((waiting[0].payload as any).batch_no).toBe(1);
      expect(new Date(waiting[0].scheduled_at).toISOString()).toBe(
        tash('2026-10-21T09:00:00').toISOString(),
      );
      const progress: any = await campaigns.get({ id });
      expect(progress.data).toEqual(
        expect.objectContaining({
          display_status: 'sending',
          can_cancel: true,
          is_promo: true,
          sent: 200,
        }),
      );

      clock(tash('2026-10-21T03:00:00'));
      expect(await drain(id)).toBe(0);

      clock(tash('2026-10-21T09:00:02'));
      await drain(id);
      state = await row(id);
      expect(state.status).toBe('done');
      expect(state.sent).toBe(450);
      expect(state.paused_until).toBeNull();
      expect(await written(id)).toBe(450);
    });

    it('TC11: tranzaksion (promo emas) kampaniya 23:00 da ham darhol ketadi', async () => {
      setUsers(250, 3000);
      clock(tash('2026-10-20T23:00:00'));
      const res = await create({ type: 'system.manual', title: "E'lon" });
      const id = res.data.campaign_id;
      expect(res.data.quiet_hours_shifted).toBe(false);
      expect(res.data.scheduled_at).toBeNull();
      // 200 + 50 (oxirgisi to'liq emas — yakun)
      expect(await drain(id)).toBe(2);
      const done = await row(id);
      expect(done.status).toBe('done');
      expect(done.sent).toBe(250);
      expect(done.paused_until).toBeNull();
    });

    it('NOTIF_PROMO_QUIET_HOURS sozlanadi: 22:00-08:00 da 19:00 reklama darhol ketadi', async () => {
      config.NOTIF_PROMO_QUIET_HOURS = '22:00-08:00';
      setUsers(2, 4000);
      clock(tash('2026-10-20T19:00:00'));
      const res = await create();
      expect(res.data.quiet_hours_shifted).toBe(false);
      expect(await drain(res.data.campaign_id)).toBe(1);
      expect((await row(res.data.campaign_id)).status).toBe('done');
    });
  },
);
