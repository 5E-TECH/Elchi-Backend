import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { OutboxEvent, OutboxService } from '@app/common';
import { Notification } from '../entities/notification.entity';
import { NotificationInboxService } from '../notification-inbox.service';
import { CreateNotificationCampaigns1716000000076 } from '../../../../migrations/1716000000076-CreateNotificationCampaigns';
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
 * (xHPdpj0W) Haqiqiy Postgres: migratsiya (TC1), 5000 qabul qiluvchili
 * kampaniya outbox partiyalari bilan to'liq bajariladi (TC3), qayta
 * yetkazilgan partiya ikki marta yozmaydi, bekor qilish keyingi partiyani
 * to'xtatadi (TC6), rejalashtirilgan partiya vaqtidan oldin chiqmaydi (TC7).
 *
 *   NOTIFICATION_CAMPAIGN_PG_TEST_URI=postgres://postgres@127.0.0.1:55444/elchi_campaign_test
 */
const uri = process.env.NOTIFICATION_CAMPAIGN_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_campaign_test'
  );
})();

const USER_BASE = 7_000_000;

(localTestDatabase ? describe : describe.skip)(
  'xHPdpj0W — kampaniya navbati (Postgres)',
  () => {
    let db: DataSource;
    let campaigns: CampaignService;
    let outbox: OutboxService;
    /** identity'dagi foydalanuvchilar (id o'sish tartibida). */
    let users: Array<{ id: string; role: string }> = [];
    let identityCalls = 0;

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
        { get: jest.fn(() => undefined) } as never,
      );

      // identity.audience.resolve: keyset + COUNT, faqat id/rol (minimal).
      rmqSendMock.mockImplementation(
        (_client: unknown, pattern: { cmd: string }, payload: any) => {
          if (pattern.cmd !== 'identity.audience.resolve') {
            return Promise.reject(new Error(`unexpected ${pattern.cmd}`));
          }
          identityCalls += 1;
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
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS "notification_schema" CASCADE');
        await db.destroy();
      }
    });

    const setUsers = (n: number, offset = 0) => {
      users = Array.from({ length: n }, (_, i) => ({
        id: String(USER_BASE + offset + i),
        role: 'courier',
      }));
    };

    /** Outbox publisher o'rnida: vaqti kelgan partiyalarni ketma-ket bajaradi. */
    const drainOutbox = async (campaignId: string, maxRounds = 200) => {
      let batches = 0;
      for (let round = 0; round < maxRounds; round += 1) {
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

    const campaignRow = (id: string) =>
      db.getRepository(NotificationCampaign).findOneByOrFail({ id });

    let keySeq = 0;
    const create = async (over: Record<string, unknown> = {}) =>
      (await campaigns.create({
        type: 'system.manual',
        title: "E'lon",
        body: 'Matn',
        roles: ['courier'],
        idempotency_key: `pg-key-${++keySeq}`,
        requester: { id: '25', roles: ['admin'] },
        ...over,
      })) as any;

    it('TC1: migratsiya entity bilan mos (schema builder o‘zgarish so‘ramaydi), is_deleted bor, down tozalaydi', async () => {
      const sql = await db.driver.createSchemaBuilder().log();
      const campaignChanges = sql.upQueries
        .map((query) => query.query)
        .filter((query) => query.includes('notification_campaigns'))
        // Inline CHECK — TypeORM @Check bilan nomlanmagan, prod'da synchronize yo'q.
        .filter((query) => !query.includes('status_check'));
      expect(campaignChanges).toEqual([]);

      const columns: Array<{ column_name: string }> = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'notification_schema' AND table_name = 'notification_campaigns'`,
      );
      const names = columns.map((c) => c.column_name);
      for (const column of [
        'is_deleted',
        'idempotency_key',
        'created_by',
        'audience',
        'status',
        'total',
        'sent',
        'failed',
        'skipped',
        'scheduled_at',
        'started_at',
        'finished_at',
      ]) {
        expect(names).toContain(column);
      }
      await expect(
        db.query(
          `INSERT INTO notification_schema.notification_campaigns
            (type, category, priority, channels, audience, title, status, idempotency_key, request_hash)
           VALUES ('x', 'system', 'normal', '[]', '{}', 't', 'bogus', 'k-check', 'h')`,
        ),
      ).rejects.toThrow(/check/i);

      // down → up (idempotent sxema)
      const runner = db.createQueryRunner();
      try {
        const migration = new CreateNotificationCampaigns1716000000076();
        await migration.down(runner);
        expect(
          await runner.hasTable('notification_schema.notification_campaigns'),
        ).toBe(false);
        await migration.up(runner);
      } finally {
        await runner.release();
      }
    });

    it('TC2/TC3: 5000 qabul qiluvchi — create darhol 202, partiyalar bilan TO‘LIQ bajariladi', async () => {
      setUsers(5000);
      identityCalls = 0;
      const started = Date.now();
      const res = await create();
      const createMs = Date.now() - started;
      expect(res.statusCode).toBe(202);
      // create — faqat COUNT (bitta identity chaqiruvi), qatorlar yozilmaydi
      expect(identityCalls).toBe(1);
      expect(createMs).toBeLessThan(2000);
      const id = res.data.campaign_id;
      expect(
        await db
          .getRepository(Notification)
          .countBy({ group_key: `campaign:${id}` }),
      ).toBe(0);

      const batches = await drainOutbox(id);
      // 5000 / 200 = 25 to'liq partiya + 1 bo'sh (oxirini aniqlash)
      expect(batches).toBe(26);
      const row = await campaignRow(id);
      expect(row).toEqual(
        expect.objectContaining({
          status: 'done',
          total: 5000,
          sent: 5000,
          failed: 0,
          skipped: 0,
          batch_no: 25,
          created_by: '25',
          audience: { roles: ['courier'] },
        }),
      );
      expect(row.started_at).toBeInstanceOf(Date);
      expect(row.finished_at).toBeInstanceOf(Date);

      const written: Array<{ n: number; distinct: number; roles: number }> =
        await db.query(
          `SELECT COUNT(*)::int AS n, COUNT(DISTINCT recipient_id)::int AS distinct,
                  COUNT(*) FILTER (WHERE recipient_role = 'courier')::int AS roles
           FROM notification_schema.notifications
           WHERE group_key = $1 AND data->>'campaign_id' = $2`,
          [`campaign:${id}`, id],
        );
      expect(written[0]).toEqual({ n: 5000, distinct: 5000, roles: 5000 });

      // TC4: get progress
      const progress: any = await campaigns.get({ id });
      expect(progress.data).toEqual(
        expect.objectContaining({ progress_pct: 100, sent: 5000, total: 5000 }),
      );
    }, 120_000);

    it('qayta yetkazilgan partiya (outbox at-least-once, parallel) — ikki marta yozilmaydi', async () => {
      setUsers(450, 10_000);
      const res = await create();
      const id = res.data.campaign_id;
      const first = (await outbox.getDuePending(50)).find(
        (event) => (event.payload as any).campaign_id === id,
      )!;
      // 0-partiya ikki marta bir vaqtda
      await Promise.all([
        campaigns.runBatch(first.payload as never),
        campaigns.runBatch(first.payload as never),
      ]);
      await outbox.markPublished(first.id);
      let row = await campaignRow(id);
      expect(row.sent).toBe(200);
      expect(row.batch_no).toBe(1);
      expect(
        await db
          .getRepository(Notification)
          .countBy({ group_key: `campaign:${id}` }),
      ).toBe(200);

      await drainOutbox(id);
      row = await campaignRow(id);
      expect(row.status).toBe('done');
      expect(row.sent).toBe(450);
      // eski partiyaning kech kelgan nusxasi — e'tiborsiz
      expect(await campaigns.runBatch(first.payload as never)).toEqual(
        expect.objectContaining({ skipped: 'done' }),
      );
      expect(
        await db
          .getRepository(Notification)
          .countBy({ group_key: `campaign:${id}` }),
      ).toBe(450);
    });

    it('TC6: cancelled — keyingi partiyalar ishga tushmaydi', async () => {
      setUsers(1000, 20_000);
      const res = await create();
      const id = res.data.campaign_id;
      const first = (await outbox.getDuePending(50)).find(
        (event) => (event.payload as any).campaign_id === id,
      )!;
      await campaigns.runBatch(first.payload as never);
      await outbox.markPublished(first.id);

      const cancelled: any = await campaigns.cancel({
        id,
        requester: { id: '26', roles: ['superadmin'] },
      });
      expect(cancelled.data.status).toBe('cancelled');

      await drainOutbox(id);
      const row = await campaignRow(id);
      expect(row.status).toBe('cancelled');
      expect(row.sent).toBe(200);
      expect(row.skipped).toBe(800);
      expect(row.cancelled_by).toBe('26');
      expect(
        await db
          .getRepository(Notification)
          .countBy({ group_key: `campaign:${id}` }),
      ).toBe(200);
      // yakunlangan kampaniyani qayta bekor qilish — 409
      await expect(campaigns.cancel({ id })).rejects.toMatchObject({
        error: expect.objectContaining({ statusCode: 409 }),
      });
    });

    it('TC7: scheduled_at — vaqtidan oldin outbox partiyani bermaydi', async () => {
      setUsers(10, 30_000);
      const at = new Date(Date.now() + 3_600_000);
      const res = await create({ scheduled_at: at.toISOString() });
      const id = res.data.campaign_id;
      const [event] = await db.getRepository(OutboxEvent).find({
        where: { pattern: CAMPAIGN_BATCH_PATTERN },
        order: { id: 'DESC' },
        take: 1,
      });
      expect((event.payload as any).campaign_id).toBe(id);
      expect(new Date(event.scheduled_at).getTime()).toBe(at.getTime());
      expect(await drainOutbox(id)).toBe(0);
      const row = await campaignRow(id);
      expect(row.status).toBe('queued');
      expect(row.sent).toBe(0);
    });

    it('TC5: bir xil kalit — bitta qator (UNIQUE) va bitta 0-partiya', async () => {
      setUsers(5, 40_000);
      const input = {
        type: 'system.manual',
        title: 'Takror',
        roles: ['courier'],
        idempotency_key: 'same-key',
      };
      const [a, b] = (await Promise.all([
        campaigns.create(input),
        campaigns.create(input),
      ])) as any[];
      expect(a.data.campaign_id).toBe(b.data.campaign_id);
      const rows = await db
        .getRepository(NotificationCampaign)
        .countBy({ idempotency_key: 'same-key' });
      expect(rows).toBe(1);
      const events = (await outbox.getDuePending(50)).filter(
        (event) => (event.payload as any).campaign_id === a.data.campaign_id,
      );
      expect(events).toHaveLength(1);
    });
  },
);
