import { DataSource } from 'typeorm';
import { OutboxEvent, OutboxService } from '@app/common';
import { Notification } from '../entities/notification.entity';
import { SmsCampaign } from '../entities/sms-campaign.entity';
import { SmsOutbox } from '../entities/sms-outbox.entity';
import { CreateNotificationCampaigns1716000000076 } from '../../../../migrations/1716000000076-CreateNotificationCampaigns';
import { NotificationCampaignPausedUntil1716000000106 } from '../../../../migrations/1716000000106-NotificationCampaignPausedUntil';
import { CreateCampaignReportExports1716000000107 } from '../../../../migrations/1716000000107-CreateCampaignReportExports';
import { CampaignReportExport } from './campaign-report-export.entity';
import {
  CAMPAIGN_EXPORT_RUN_PATTERN,
  CampaignReportService,
} from './campaign-report.service';
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
 * (H7kpCman) Haqiqiy Postgres: migratsiya 107, kanal kesimi (jsonb
 * `delivery`), SMS agregatlari (DLR yo'q — null), yetkazilmaganlar va
 * 10 000+ qatorli eksport FON vazifasi orqali (sinxron emas).
 *
 *   NOTIFICATION_CAMPAIGN_REPORT_PG_TEST_URI=postgres://postgres@127.0.0.1:55491/elchi_campaign_report_test
 */
const uri = process.env.NOTIFICATION_CAMPAIGN_REPORT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_campaign_report_test'
  );
})();

const EOL = String.fromCharCode(13, 10);
const superadmin = { id: '26', roles: ['superadmin'] };

(localTestDatabase ? describe : describe.skip)(
  'H7kpCman — kampaniya hisoboti (Postgres)',
  () => {
    let db: DataSource;
    let service: CampaignReportService;
    let outbox: OutboxService;
    let activityLog: { log: jest.Mock };

    beforeAll(async () => {
      const setup = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [Notification, OutboxEvent, SmsOutbox, SmsCampaign],
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
          SmsOutbox,
          SmsCampaign,
          NotificationCampaign,
          CampaignReportExport,
        ],
        synchronize: false,
      });
      await db.initialize();
      const runner = db.createQueryRunner();
      try {
        await new CreateNotificationCampaigns1716000000076().up(runner);
        await new NotificationCampaignPausedUntil1716000000106().up(runner);
        await new CreateCampaignReportExports1716000000107().up(runner);
      } finally {
        await runner.release();
      }
      outbox = new OutboxService(db.getRepository(OutboxEvent));
      activityLog = { log: jest.fn().mockResolvedValue(undefined) };
      service = new CampaignReportService(
        db.getRepository(NotificationCampaign),
        db.getRepository(SmsCampaign),
        db.getRepository(CampaignReportExport),
        {} as never,
        outbox,
        activityLog as never,
        { tariff: () => 80 } as never,
      );
      // identity.user.find_by_ids — ism/rol (telefon yo'q)
      rmqSendMock.mockImplementation(
        (_c: unknown, pattern: { cmd: string }, data: { ids: string[] }) =>
          pattern.cmd === 'identity.user.find_by_ids'
            ? Promise.resolve({
                data: data.ids.map((id) => ({
                  id,
                  name: `User ${id}`,
                  role: 'customer',
                })),
              })
            : Promise.reject(new Error(`unexpected ${pattern.cmd}`)),
      );
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS "notification_schema" CASCADE');
        await db.destroy();
      }
    });

    let keySeq = 0;
    const campaign = (over: Partial<NotificationCampaign> = {}) =>
      db.getRepository(NotificationCampaign).save(
        db.getRepository(NotificationCampaign).create({
          type: 'marketing.manual',
          category: 'marketing',
          priority: 'low',
          channels: ['in_app', 'realtime', 'push'],
          audience: { roles: ['courier'] },
          title: 'Aksiya',
          status: 'done',
          total: 0,
          idempotency_key: `report-${++keySeq}`,
          request_hash: 'h',
          ...over,
        }),
      );

    /** Kampaniya qatorlari (dispatch yozganidek: group_key + data.campaign_id). */
    const inbox = (
      campaignId: string,
      count: number,
      delivery: Record<string, string>,
      base = 0,
    ) =>
      db.query(
        `INSERT INTO "notification_schema"."notifications"
           (recipient_id, recipient_role, type, category, priority, title, data, channels, delivery, group_key)
         SELECT ($4::bigint + g), 'courier', 'marketing.manual', 'marketing', 'low', 'Aksiya',
                jsonb_build_object('campaign_id', $1::text),
                '["in_app","realtime","push"]'::jsonb, $3::jsonb, 'campaign:' || $1
           FROM generate_series(1, $2::int) g`,
        [campaignId, count, JSON.stringify(delivery), base],
      );

    it('migratsiya 107: entity bilan mos, idempotent, holat CHECK, down tozalaydi', async () => {
      const sql = await db.driver.createSchemaBuilder().log();
      const changes = sql.upQueries
        .map((query) => query.query)
        .filter(
          (query) =>
            query.includes('campaign_report_exports') ||
            query.includes('notification_campaigns'),
        )
        // Inline CHECK — TypeORM @Check bilan nomlanmagan (prod'da synchronize yo'q).
        .filter((query) => !/_check/i.test(query));
      expect(changes).toEqual([]);
      await expect(
        db.query(
          `INSERT INTO notification_schema.campaign_report_exports (campaign_kind, campaign_id, status)
           VALUES ('sms', 1, 'bogus')`,
        ),
      ).rejects.toThrow(/check/i);
      const runner = db.createQueryRunner();
      try {
        const migration = new CreateCampaignReportExports1716000000107();
        await migration.up(runner);
        await migration.down(runner);
        expect(
          await runner.hasTable('notification_schema.campaign_report_exports'),
        ).toBe(false);
        await migration.up(runner);
      } finally {
        await runner.release();
      }
    });

    it('TC1/TC3: kanal kesimi jsonb delivery dan; begona qatorlar (boshqa campaign_id) aralashmaydi', async () => {
      const row = await campaign({ total: 10, sent: 9, failed: 1 });
      const id = String(row.id);
      await inbox(id, 6, { in_app: 'sent', realtime: 'emitted', push: 'sent' });
      await inbox(
        id,
        2,
        { in_app: 'sent', realtime: 'emitted', push: 'no_subscription' },
        100,
      );
      await inbox(
        id,
        1,
        {
          in_app: 'sent',
          realtime: 'failed',
          realtime_error: 'timeout',
          push: 'queued',
        },
        200,
      );
      // begona: boshqa kampaniya va AYNI group_key, lekin boshqa campaign_id
      const other = await campaign();
      await inbox(String(other.id), 3, { in_app: 'sent', push: 'failed' }, 300);
      await inbox(id, 1, { in_app: 'sent', push: 'failed' }, 400);
      await db.query(
        `UPDATE notification_schema.notifications
            SET data = jsonb_build_object('campaign_id', '999')
          WHERE recipient_id = $1`,
        ['401'],
      );

      const res: any = await service.report({
        kind: 'notification',
        id,
        requester: superadmin,
      });
      const byChannel = Object.fromEntries(
        res.data.by_channel.map((item: any) => [item.channel, item]),
      );
      expect(byChannel.in_app).toEqual(
        expect.objectContaining({ sent: 9, failed: 1 }),
      );
      expect(byChannel.realtime).toEqual(
        expect.objectContaining({ sent: 8, failed: 1 }),
      );
      expect(byChannel.push).toEqual(
        expect.objectContaining({ sent: 6, skipped: 2, pending: 1, failed: 0 }),
      );
      expect(res.data.stats).toEqual(
        expect.objectContaining({
          audience: 10,
          sent: 9,
          failed: 1,
          delivered: null,
          undelivered: 3,
        }),
      );
      expect(res.data.sms).toBeNull();
      expect(res.data.permissions.can_export).toBe(true);

      const list: any = await service.undelivered({
        kind: 'notification',
        id,
        limit: 2,
        page: 2,
      });
      expect(list.data.meta).toEqual({
        page: 2,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
      expect(list.data.items).toHaveLength(1);
      expect(list.data.items[0]).toEqual(
        expect.objectContaining({
          name: expect.stringMatching(/^User /),
          failures: [
            { channel: 'realtime', status: 'failed', reason: 'timeout' },
          ],
        }),
      );
    });

    it('SMS: DLR kelmaguncha Yetkazildi null; DLR kelgach son; bo‘laklar/kodlash/narx; yetkazilmaganlar maskalangan', async () => {
      const sms = await db.getRepository(SmsCampaign).save(
        db.getRepository(SmsCampaign).create({
          idempotency_key: 'sms-report-1',
          created_by: '25',
          message_class: 'promo',
          text: 'Chegirma',
          segment: {},
          status: 'queued',
          total: 5,
          queued: 3,
          blocked: 1,
          skipped: 1,
          estimated_cost: '480.00',
        }),
      );
      const id = String(sms.id);
      const outboxRow = (n: number, over: Partial<SmsOutbox>) =>
        db.getRepository(SmsOutbox).save(
          db.getRepository(SmsOutbox).create({
            to_phone: `+99890123740${n}`,
            customer_id: String(70 + n),
            text: 'Chegirma',
            message_class: 'promo',
            parts: 2,
            encoding: 'GSM-7',
            provider: 'eskiz',
            client_message_id: `camp-${id}-${n}`,
            cost: '160.00',
            campaign_id: id,
            scheduled_at: new Date(),
            status: 'sent',
            sent_at: new Date(),
            ...over,
          }),
        );
      const a = await outboxRow(1, {});
      const b = await outboxRow(2, {});
      await outboxRow(3, { status: 'pending', sent_at: null });

      let res: any = await service.report({ kind: 'sms', id });
      expect(res.data.stats).toEqual(
        expect.objectContaining({
          audience: 5,
          sent: 2,
          delivered: null,
          failed: 0,
          pending: 1,
          skipped: 2,
        }),
      );
      expect(res.data.dlr).toEqual(
        expect.objectContaining({ received: 0, awaiting: 2 }),
      );
      expect(res.data.sms).toEqual(
        expect.objectContaining({
          messages: 3,
          parts_total: 6,
          parts_per_message: { min: 2, max: 2 },
          encoding: 'GSM-7',
          cost_of_sent: 320,
        }),
      );
      expect(res.data.cost).toEqual(
        expect.objectContaining({
          estimated: 480,
          cost_of_sent: 320,
          is_estimate: true,
        }),
      );

      // DLR: biri yetkazildi, biri rad etildi
      await db
        .getRepository(SmsOutbox)
        .update(
          { id: a.id },
          { status: 'delivered', dlr_status: 'delivered', dlr_at: new Date() },
        );
      await db.getRepository(SmsOutbox).update(
        { id: b.id },
        {
          status: 'failed',
          dlr_status: 'not_delivered',
          dlr_at: new Date(),
          last_error: 'DLR: UNDELIV',
        },
      );
      res = await service.report({ kind: 'sms', id });
      expect(res.data.stats).toEqual(
        expect.objectContaining({ sent: 2, delivered: 1, failed: 1 }),
      );
      expect(res.data.sms.dlr).toEqual({
        final: 2,
        delivered: 1,
        failed: 1,
        awaiting: 0,
      });

      const list: any = await service.undelivered({ kind: 'sms', id });
      expect(list.data.items).toEqual([
        expect.objectContaining({
          recipient_id: '72',
          name: 'User 72',
          phone: '***7402',
          failures: [
            { channel: 'sms', status: 'not_delivered', reason: 'DLR: UNDELIV' },
          ],
        }),
      ]);
      expect(JSON.stringify(list.data)).not.toContain('901237402');
    });

    it('TC8/TC9: ≤10 000 — darhol CSV; 10 000+ — fon vazifasi (outbox), tayyor fayl yuklanadi, `export` jurnali', async () => {
      // kichik — sinxron
      const small = await campaign({ total: 2, sent: 2 });
      await inbox(String(small.id), 2, { in_app: 'sent', push: 'failed' }, 500);
      const sync: any = await service.exportUndelivered({
        kind: 'notification',
        id: String(small.id),
        requester: superadmin,
      });
      expect(sync.statusCode).toBe(200);
      expect(sync.data.mode).toBe('sync');
      expect(sync.data.csv.split(EOL)).toHaveLength(4);
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'export',
          entity_id: String(small.id),
          metadata: expect.objectContaining({ mode: 'sync', rows: 2 }),
        }),
      );
      activityLog.log.mockClear();

      // katta — 10 050 qator: sinxron EMAS
      const big = await campaign({ total: 10_050, sent: 10_050 });
      const bigId = String(big.id);
      await inbox(
        bigId,
        10_050,
        { in_app: 'sent', push: 'failed', push_error: '410' },
        100_000,
      );
      const queued: any = await service.exportUndelivered({
        kind: 'notification',
        id: bigId,
        requester: superadmin,
      });
      expect(queued.statusCode).toBe(202);
      expect(queued.data).toEqual(
        expect.objectContaining({
          mode: 'async',
          status: 'queued',
          rows: 10_050,
        }),
      );
      expect(activityLog.log).not.toHaveBeenCalled();
      const exportId = queued.data.export_id;

      // qayta bosish — ikkinchi vazifa ochilmaydi
      const again: any = await service.exportUndelivered({
        kind: 'notification',
        id: bigId,
        requester: superadmin,
      });
      expect(again.data).toEqual(
        expect.objectContaining({ export_id: exportId, duplicate: true }),
      );

      const [event] = (await outbox.getDuePending(50)).filter(
        (item) => item.pattern === CAMPAIGN_EXPORT_RUN_PATTERN,
      );
      expect((event.payload as any).export_id).toBe(exportId);
      const started = Date.now();
      expect(await service.runExport(event.payload as never)).toEqual({
        export_id: exportId,
        status: 'running',
      });
      // outbox iste'molchisi yig'ishni kutmaydi
      expect(Date.now() - started).toBeLessThan(2000);
      // qayta yetkazilgan xabar — ikkinchi marta yig'ilmaydi
      expect(await service.runExport(event.payload as never)).toEqual({
        export_id: exportId,
        skipped: 'not_queued',
      });
      await service.settled(exportId);

      const status: any = await service.getExport({
        export_id: exportId,
        requester: superadmin,
      });
      expect(status.data).toEqual(
        expect.objectContaining({
          status: 'done',
          rows: 10_050,
          download_url: `/notifications/campaigns/exports/${exportId}/download`,
        }),
      );
      const file: any = await service.downloadExport({
        export_id: exportId,
        requester: superadmin,
      });
      const lines = file.data.csv.split(EOL);
      // sarlavha + 10 050 qator + oxirgi bo'sh
      expect(lines).toHaveLength(10_052);
      expect(lines[1]).toMatch(
        /^100001,User 100001,courier,,push,failed,410,\d+$/,
      );
      expect(activityLog.log).toHaveBeenCalledTimes(1);
      expect(activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'export',
          entity_type: 'NotificationCampaign',
          entity_id: bigId,
          user_id: '26',
          metadata: expect.objectContaining({
            mode: 'async',
            rows: 10_050,
            export_id: exportId,
          }),
        }),
      );
    }, 120_000);
  },
);
