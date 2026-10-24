/* eslint-disable @typescript-eslint/require-await -- spec mock'lari: async soxta implementatsiyalar */
import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { NotificationChannel } from '@app/common';
import { CreateNotifications1716000000008 } from '../../../../migrations/1716000000008-CreateNotifications';
import { CreateNotificationDispatches1716000000084 } from '../../../../migrations/1716000000084-CreateNotificationDispatches';
import { DispatchNotificationDto } from '../dto/dispatch-notification.dto';
import { Notification } from '../entities/notification.entity';
import { NotificationInboxService } from '../notification-inbox.service';
import { DispatchHistoryService } from './dispatch-history.service';
import { TelegramDmService } from '../telegram/telegram-dm.service';
import { NotificationDispatch } from './notification-dispatch.entity';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]) => rmqSendMock(...args),
  };
});

/**
 * 7Vozou5x — HAQIQIY Postgres (faqat lokal test bazasi): migratsiya 084
 * up/down, `delivery` DB'da to'ldirilgan (TC4), tarix ro'yxati va tafsiloti
 * (kanal × holat, yetkazilmaganlar ism + rol + sabab), UNIQUE dispatch_id
 * (504 dan keyingi takror yubormaydi). Real SMS/Telegram yo'q.
 *
 *   NOTIFICATION_HISTORY_PG_TEST_URI=postgres://postgres@127.0.0.1:55464/elchi_history_test \
 *     npx jest apps/notification-service/src/history/dispatch-history.pg.spec.ts
 */
const uri = process.env.NOTIFICATION_HISTORY_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_history_test'
  );
})();

const CLIENT_ID = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

(localTestDatabase ? describe : describe.skip)(
  'notification_dispatches — lokal Postgres (7Vozou5x)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;
    let history: DispatchHistoryService;
    let service: NotificationInboxService;
    let smsDispatch: {
      assertFanout: jest.Mock;
      queueForNotifications: jest.Mock;
    };

    const migrate = async (direction: 'up' | 'down') => {
      const runner = db.createQueryRunner();
      try {
        if (direction === 'up') {
          await new CreateNotifications1716000000008().up(runner);
          await new CreateNotificationDispatches1716000000084().up(runner);
        } else {
          await new CreateNotificationDispatches1716000000084().down(runner);
        }
      } finally {
        await runner.release();
      }
    };

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [Notification, NotificationDispatch],
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
      await migrate('up');
      history = new DispatchHistoryService(
        db.getRepository(NotificationDispatch),
        db.getRepository(Notification),
        {} as never,
      );
      // SMS: telefoni bor 11 — navbatga, 12 — telefon yo'q (mock, real SMS yo'q).
      smsDispatch = {
        assertFanout: jest.fn(),
        queueForNotifications: jest.fn(
          async (
            rows: Notification[],
            manager: {
              query: (sql: string, params: unknown[]) => Promise<unknown>;
            },
          ) => {
            for (const row of rows) {
              const patch =
                String(row.recipient_id) === '11'
                  ? { sms: 'queued' }
                  : { sms: 'not_eligible', sms_reason: 'no_phone' };
              await manager.query(
                `UPDATE notification_schema.notifications
                    SET delivery = COALESCE(delivery, '{}'::jsonb) || $2::jsonb
                  WHERE id = $1`,
                [row.id, JSON.stringify(patch)],
              );
            }
            return { sms: 1, sms_status: 'partial', sms_skipped: 1 };
          },
        ),
      };
      service = new NotificationInboxService(
        db.getRepository(Notification),
        { send: jest.fn() } as never,
        { emit: jest.fn(() => of(null)) } as never,
        { sendNotification: jest.fn() } as never,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
        { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
        smsDispatch as never,
        undefined,
        undefined,
        history,
      );
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
        await db.destroy();
      }
    });

    beforeEach(() => {
      rmqSendMock.mockReset();
      // identity.user.find_by_ids — ism + rol (telefon olinmaydi).
      rmqSendMock.mockImplementation(
        (_client: unknown, pattern: { cmd: string }, data: { ids: string[] }) =>
          Promise.resolve(
            pattern.cmd === 'identity.user.find_by_ids'
              ? {
                  data: data.ids.map((id) => ({
                    id,
                    name: id === '1' ? 'Bosh admin' : `Kuryer ${id}`,
                    role: id === '1' ? 'superadmin' : 'courier',
                    // find_by_ids telefon ham beradi — tarix uni OLMASLIGI kerak.
                    phone_number: `+99890000000${id.slice(-1)}`,
                  })),
                }
              : { data: [] },
          ),
      );
    });

    const send = (extra: Partial<DispatchNotificationDto> = {}) =>
      service.dispatch({
        type: 'system.manual',
        title: 'Ertaga yig‘ilish',
        body: 'Soat 9:00 da filialda',
        recipient_ids: ['11', '12'],
        channels: [
          NotificationChannel.IN_APP,
          NotificationChannel.SMS,
          NotificationChannel.EMAIL,
        ],
        client_request_id: CLIENT_ID,
        requester: { id: '1', roles: ['superadmin'] },
        ...extra,
      } as DispatchNotificationDto) as Promise<{
        data: Record<string, unknown>;
        message: string;
      }>;

    it('TC4: `delivery` DB’da to‘ldirilgan va har qatorda dispatch_id; tarix qatori yakunlangan', async () => {
      const res = await send();
      expect(res.data.dispatch_id).toBe(CLIENT_ID);
      const rows: Array<{
        recipient_id: string;
        dispatch_id: string;
        delivery: Record<string, string>;
      }> = await db.query(
        `SELECT recipient_id::text, dispatch_id, delivery
           FROM notification_schema.notifications ORDER BY recipient_id`,
      );
      expect(rows).toEqual([
        {
          recipient_id: '11',
          dispatch_id: CLIENT_ID,
          delivery: expect.objectContaining({
            in_app: 'sent',
            sms: 'queued',
            email: 'no_provider',
          }),
        },
        {
          recipient_id: '12',
          dispatch_id: CLIENT_ID,
          delivery: expect.objectContaining({
            in_app: 'sent',
            sms: 'not_eligible',
            sms_reason: 'no_phone',
            email: 'no_provider',
          }),
        },
      ]);
      // Javobda kanal × holat — sent/failed/skipped alohida.
      expect(res.data.channel_status).toEqual({
        in_app: { sent: 2 },
        sms: { queued: 1, not_eligible: 1 },
        email: { no_provider: 2 },
      });
      const [stored] = await db.query(
        `SELECT status, recipients, dispatched, no_provider, finished_at
           FROM notification_schema.notification_dispatches WHERE dispatch_id = $1`,
        [CLIENT_ID],
      );
      expect(stored).toMatchObject({
        status: 'partial',
        recipients: 2,
        dispatched: 2,
        no_provider: ['email'],
      });
      expect(stored.finished_at).not.toBeNull();
    });

    it('504 dan keyin ayni client_request_id — UNIQUE: ikkinchi marta YOZILMAYDI, saqlangan natija', async () => {
      const res = await send();
      expect(res.data).toMatchObject({ duplicate: true, status: 'partial' });
      const [{ n }] = await db.query(
        `SELECT COUNT(*)::int AS n FROM notification_schema.notifications`,
      );
      expect(n).toBe(2);
      expect(smsDispatch.queueForNotifications).toHaveBeenCalledTimes(1);
    });

    it('GET /notifications/sent — sahifalab, kim yubordi (ism), qabul qiluvchilar soni, kanal chiplari', async () => {
      await send({
        client_request_id: '8b2e3d4c-5f60-4b7c-9d8e-0f1a2b3c4d5e',
        title: 'Ikkinchi',
        channels: [NotificationChannel.IN_APP],
        recipient_ids: ['11'],
      });
      const res = (await history.list({ page: 1, limit: 1 })) as {
        data: {
          items: Array<Record<string, unknown>>;
          meta: Record<string, number>;
        };
      };
      expect(res.data.meta).toMatchObject({ page: 1, limit: 1, total: 2 });
      expect(res.data.items).toHaveLength(1);
      expect(res.data.items[0]).toMatchObject({
        title: 'Ikkinchi',
        status: 'sent',
        recipients: 1,
        channels: ['in_app'],
        created_by: { id: '1', name: 'Bosh admin', role: 'superadmin' },
      });
      const page2 = (await history.list({ page: 2, limit: 1 })) as {
        data: { items: Array<Record<string, unknown>> };
      };
      expect(page2.data.items[0]).toMatchObject({ dispatch_id: CLIENT_ID });
      const failedOnly = (await history.list({ status: 'failed' })) as {
        data: { items: unknown[] };
      };
      expect(failedOnly.data.items).toEqual([]);

      // (NwlmrcMf) «Kimga»: bitta odam — recipient (ism · rol), ko'p — son.
      expect(res.data.items[0].audience).toEqual({
        recipient_ids: 1,
        recipient: { id: '11', name: 'Kuryer 11', role: 'courier' },
      });
      expect(page2.data.items[0]).toMatchObject({
        audience: { recipient_ids: 2 },
      });
      // Eski yozuv (recipient_id saqlanmagan) — inbox qatoridan (DISTINCT ON).
      await db.query(
        `UPDATE notification_schema.notification_dispatches
            SET "audience" = '{"recipient_ids": 1}'::jsonb
          WHERE "dispatch_id" = $1`,
        ['8b2e3d4c-5f60-4b7c-9d8e-0f1a2b3c4d5e'],
      );
      const legacy = (await history.list({ page: 1, limit: 1 })) as {
        data: { items: Array<Record<string, unknown>> };
      };
      expect(legacy.data.items[0].audience).toEqual({
        recipient_ids: 1,
        recipient: { id: '11', name: 'Kuryer 11', role: 'courier' },
      });
    });

    it('tafsilot: to‘liq matn, jonli kanal × holat, "Yetkazilmaganlar" — ism + rol + sabab (DLR keyin o‘zgarsa ham)', async () => {
      // DLR keyin 11-ga `sms: failed` yozdi — tafsilot jonli ko'rsatadi.
      await db.query(
        `UPDATE notification_schema.notifications
            SET delivery = delivery || '{"sms":"failed","sms_error":"DLR: rejected"}'::jsonb
          WHERE recipient_id = 11 AND dispatch_id = $1`,
        [CLIENT_ID],
      );
      const res = (await history.detail(CLIENT_ID, { limit: 10 })) as {
        data: Record<string, any>;
      };
      expect(res.data).toMatchObject({
        dispatch_id: CLIENT_ID,
        title: 'Ertaga yig‘ilish',
        body: 'Soat 9:00 da filialda',
        channel_status: {
          in_app: { sent: 2 },
          sms: { failed: 1, not_eligible: 1 },
          email: { no_provider: 2 },
        },
      });
      expect(res.data.undelivered.meta.total).toBe(2);
      expect(res.data.undelivered.items).toEqual([
        expect.objectContaining({
          recipient_id: '11',
          name: 'Kuryer 11',
          failures: expect.arrayContaining([
            { channel: 'sms', status: 'failed', reason: 'DLR: rejected' },
            { channel: 'email', status: 'no_provider', reason: null },
          ]),
        }),
        expect.objectContaining({
          recipient_id: '12',
          name: 'Kuryer 12',
          failures: expect.arrayContaining([
            { channel: 'sms', status: 'not_eligible', reason: 'no_phone' },
          ]),
        }),
      ]);
      // Telefon raqami javobda YO'Q.
      expect(JSON.stringify(res.data)).not.toMatch(/\+998|phone_number/);
    });

    it('identity javob bermasa ham tafsilot ochiladi (ism null)', async () => {
      rmqSendMock.mockRejectedValue(new Error('timeout'));
      const res = (await history.detail(CLIENT_ID)) as {
        data: Record<string, any>;
      };
      expect(res.data.undelivered.items[0].name).toBeNull();
    });

    it('yo‘q dispatch — 404, noto‘g‘ri id — 400', async () => {
      await expect(
        history.detail('00000000-0000-4000-8000-000000000000'),
      ).rejects.toMatchObject({ error: { statusCode: 404 } });
      await expect(history.detail("x'; DROP")).rejects.toMatchObject({
        error: { statusCode: 400 },
      });
    });

    it('rCFZAmOz (haqiqiy SQL): Telegram DM da’vosi — queued → sending → sent, qayta yetkazishda IKKINCHI xabar yo‘q', async () => {
      const [row] = await db.query(
        `INSERT INTO notification_schema.notifications
           (recipient_id, type, title, body, delivery)
         VALUES (21, 'system.manual', 'DM', 'matn', '{"in_app":"sent","telegram":"queued"}')
         RETURNING id::text AS id`,
      );
      const sendDirectToGroup = jest.fn().mockResolvedValue({});
      // (TgYRqaTk #1) chat — identity.telegram.resolve_many (user_ids).
      rmqSendMock
        .mockReset()
        .mockImplementation((_client: unknown, pattern: { cmd?: string }) =>
          Promise.resolve(
            pattern?.cmd === 'identity.telegram.resolve_many'
              ? { data: { '21': '777' } }
              : { data: null },
          ),
        );
      const dm = new TelegramDmService(
        db.getRepository(Notification),
        {} as never,
        {
          contacts: jest.fn(
            async () => new Map([['21', { id: '21', telegram_id: '777' }]]),
          ),
        } as never,
        { sendDirectToGroup } as never,
        { get: () => 'bot' } as never,
        {} as never,
        {} as never,
      );
      const [first, second] = await Promise.all([
        dm.deliver({ notification_ids: [row.id] }),
        dm.deliver({ notification_ids: [row.id] }),
      ]);
      expect(first.processed + second.processed).toBe(1);
      expect(sendDirectToGroup).toHaveBeenCalledTimes(1);
      expect(sendDirectToGroup).toHaveBeenCalledWith(
        expect.objectContaining({ group_id: '777' }),
      );
      const [after] = await db.query(
        `SELECT delivery FROM notification_schema.notifications WHERE id = $1`,
        [row.id],
      );
      expect(after.delivery).toMatchObject({ telegram: 'sent' });
      expect((await dm.deliver({ notification_ids: [row.id] })).processed).toBe(
        0,
      );
    });

    it('down(): jadval va ustun olib tashlanadi, up qayta ishlaydi', async () => {
      await migrate('down');
      const [col] = await db.query(
        `SELECT COUNT(*)::int AS n FROM information_schema.columns
          WHERE table_schema = 'notification_schema' AND table_name = 'notifications'
            AND column_name = 'dispatch_id'`,
      );
      const [tbl] = await db.query(
        `SELECT COUNT(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'notification_schema' AND table_name = 'notification_dispatches'`,
      );
      expect([col.n, tbl.n]).toEqual([0, 0]);
      await migrate('up');
    });
  },
);
