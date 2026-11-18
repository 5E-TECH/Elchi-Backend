import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { CreateNotifications1716000000008 } from '../../../migrations/1716000000008-CreateNotifications';
import { CreateNotificationDispatches1716000000084 } from '../../../migrations/1716000000084-CreateNotificationDispatches';
import { DispatchNotificationDto } from './dto/dispatch-notification.dto';
import { Notification } from './entities/notification.entity';
import { NotificationInboxService } from './notification-inbox.service';

/**
 * BE-5 #655 N1 — `delivery_only`: kechiktirilgan Telegram (R6 09:00) ayni
 * `group_key` qatorini QAYTA KO'TARMAYDI: o'qilgan holati, inbox tartibi
 * (`createdAt`), `data.count`, matn o'zgarmaydi; faqat yangi kanal
 * qo'shiladi. Bayroqsiz dispatch — avvalgidek qatorni yangilaydi.
 *
 *   NOTIFICATION_PG_TEST_URI=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     npx jest apps/notification-service/src/notification-inbox.delivery-only.pg.spec.ts
 */
const uri = process.env.NOTIFICATION_PG_TEST_URI;
const isLocal = (() => {
  if (!uri) return false;
  try {
    return ['127.0.0.1', 'localhost'].includes(new URL(uri).hostname);
  } catch {
    return false;
  }
})();

const USER = '778000000001';

(isLocal ? describe : describe.skip)(
  'dispatch delivery_only — haqiqiy PG (BE-5 #655 N1)',
  () => {
    let ds: DataSource;
    let service: NotificationInboxService;

    beforeAll(async () => {
      ds = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [Notification],
      });
      await ds.initialize();
      const runner = ds.createQueryRunner();
      try {
        await new CreateNotifications1716000000008().up(runner);
        await new CreateNotificationDispatches1716000000084().up(runner);
      } finally {
        await runner.release();
      }
      service = new NotificationInboxService(
        ds.getRepository(Notification),
        { send: jest.fn() } as never,
        { emit: jest.fn(() => of(null)) } as never,
        { sendNotification: jest.fn() } as never,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
        { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
        { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as never,
      );
    });

    afterAll(async () => {
      if (!ds?.isInitialized) return;
      await ds.query(
        `DELETE FROM notification_schema.notifications WHERE recipient_id = ${USER}`,
      );
      await ds.destroy();
    });

    beforeEach(() =>
      ds.query(
        `DELETE FROM notification_schema.notifications WHERE recipient_id = ${USER}`,
      ),
    );

    const rows = () =>
      ds.query<
        Array<{
          id: string;
          is_read: boolean;
          createdAt: Date;
          channels: string[];
          data: Record<string, unknown>;
          title: string;
        }>
      >(
        `SELECT id::text AS id, is_read, "createdAt", channels, data, title
           FROM notification_schema.notifications WHERE recipient_id = ${USER}`,
      );
    const base = (over: Partial<DispatchNotificationDto> = {}) =>
      ({
        recipient_ids: [USER],
        type: 'x.advisor.test',
        title: 'Jiddiy ogohlantirish · Zarar',
        body: 'b',
        group_key: 'ai.advisor_alert:42',
        channels: ['in_app', 'realtime'],
        data: { alert_id: '42' },
        ...over,
      }) as DispatchNotificationDto;

    it('delivery_only — o‘qilgan qator qayta ko‘tarilmaydi; faqat kanal qo‘shiladi', async () => {
      await service.dispatch(base());
      const [first] = await rows();
      await ds.query(
        `UPDATE notification_schema.notifications SET is_read = true, read_at = now(),
                "createdAt" = now() - INTERVAL '6 hours' WHERE id = $1`,
        [first.id],
      );
      const [before] = await rows();
      await service.dispatch(
        base({
          channels: ['telegram'] as never,
          title: 'boshqa sarlavha',
          delivery_only: true,
        }),
      );
      const after = await rows();
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        id: first.id,
        is_read: true,
        title: 'Jiddiy ogohlantirish · Zarar',
      });
      expect(new Date(after[0].createdAt).getTime()).toBe(
        new Date(before.createdAt).getTime(),
      );
      expect(after[0].data.count ?? 1).toBe(before.data.count ?? 1);
      expect([...after[0].channels].sort()).toEqual(
        ['in_app', 'realtime', 'telegram'].sort(),
      );
    });

    it('nazorat: bayroqsiz ayni group_key — qator yangilanadi (o‘qilmagan, count 2)', async () => {
      await service.dispatch(base());
      const [first] = await rows();
      await ds.query(
        `UPDATE notification_schema.notifications SET is_read = true WHERE id = $1`,
        [first.id],
      );
      await service.dispatch(base({ channels: ['telegram'] as never }));
      const [after] = await rows();
      expect(after.is_read).toBe(false);
      expect(after.data.count).toBe(2);
    });

    it('delivery_only, foydalanuvchi qatorni o‘chirgan — tiriltirilmaydi, faqat yetkazish holati yoziladi', async () => {
      await service.dispatch(base());
      const [first] = await rows();
      await ds.query(
        `UPDATE notification_schema.notifications SET is_deleted = true WHERE id = $1`,
        [first.id],
      );
      await service.dispatch(
        base({ channels: ['telegram'] as never, delivery_only: true }),
      );
      const all = await ds.query<
        Array<{ id: string; is_deleted: boolean; delivery: object }>
      >(
        `SELECT id::text AS id, is_deleted, delivery
           FROM notification_schema.notifications WHERE recipient_id = ${USER}`,
      );
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(first.id);
      expect(all[0].is_deleted).toBe(true);
      expect(all[0].delivery).toHaveProperty('telegram');
    });

    it('delivery_only, shu group_key bo‘yicha hech qachon qator bo‘lmagan — yangi qator YO‘Q', async () => {
      await service.dispatch(
        base({ channels: ['telegram'] as never, delivery_only: true }),
      );
      expect(await rows()).toHaveLength(0);
    });
  },
);
