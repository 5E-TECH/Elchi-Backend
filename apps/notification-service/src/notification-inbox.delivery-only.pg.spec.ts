import { of } from 'rxjs';
import { DataSource, type FindOneOptions } from 'typeorm';
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
    const emit = jest.fn(() => of(null));

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
        { emit } as never,
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

    it('aralash qabul qiluvchilar + haqiqiy DM yo‘li: o‘qilgan qator o‘zgarmaydi, o‘chirilgani o‘chirilganligicha, qatorsizga yangi qator yo‘q; DM mavjud qator id lari bilan', async () => {
      const A = USER;
      const B = '778000000002';
      const C = '778000000003';
      const enqueue = jest.fn<Promise<void>, [unknown, string[]]>(() =>
        Promise.resolve(),
      );
      const dm = {
        plan: jest.fn((ids: string[]) =>
          Promise.resolve(
            new Map(ids.map((id) => [id, { telegram: 'queued' }])),
          ),
        ),
        enqueue,
      };
      const withDm = new NotificationInboxService(
        ds.getRepository(Notification),
        { send: jest.fn() } as never,
        { emit: jest.fn(() => of(null)) } as never,
        { sendNotification: jest.fn() } as never,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
        { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
        { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as never,
        undefined,
        undefined,
        undefined,
        dm as never,
      );
      const all = [A, B, C];
      const visible = () =>
        ds.query<
          Array<{
            id: string;
            recipient_id: string;
            is_read: boolean;
            is_deleted: boolean;
            createdAt: Date;
            delivery: Record<string, string>;
          }>
        >(
          `SELECT id::text AS id, recipient_id::text AS recipient_id, is_read, is_deleted, "createdAt", delivery
             FROM notification_schema.notifications
            WHERE recipient_id = ANY($1::bigint[]) ORDER BY recipient_id`,
          [all],
        );
      try {
        await ds.query(
          `DELETE FROM notification_schema.notifications WHERE recipient_id = ANY($1::bigint[])`,
          [all],
        );
        await withDm.dispatch(base({ recipient_ids: [A, B] }));
        const [ra, rb] = await visible();
        await ds.query(
          `UPDATE notification_schema.notifications SET is_read = true WHERE id = $1`,
          [ra.id],
        );
        await ds.query(
          `UPDATE notification_schema.notifications SET is_deleted = true WHERE id = $1`,
          [rb.id],
        );
        const before = await visible();
        const res = (await withDm.dispatch(
          base({
            recipient_ids: [A, B, C],
            channels: ['telegram'] as never,
            delivery_only: true,
          }),
        )) as { data: { delivery: { in_app: number } } };
        const after = await visible();
        expect(after.map((r) => r.recipient_id)).toEqual([A, B]);
        expect(after[0]).toMatchObject({ id: ra.id, is_read: true });
        expect(after[1]).toMatchObject({ id: rb.id, is_deleted: true });
        expect(after.map((r) => new Date(r.createdAt).getTime())).toEqual(
          before.map((r) => new Date(r.createdAt).getTime()),
        );
        for (const r of after) expect(r.delivery.telegram).toBe('queued');
        // Ko'rinadigan o'qilmaganlar soni o'zgarmadi (0).
        const [{ n }] = await ds.query<Array<{ n: string }>>(
          `SELECT COUNT(*) AS n FROM notification_schema.notifications
            WHERE recipient_id = ANY($1::bigint[]) AND is_deleted = false AND is_read = false`,
          [all],
        );
        expect(Number(n)).toBe(0);
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect([...enqueue.mock.calls[0][1]].sort()).toEqual(
          [ra.id, rb.id].sort(),
        );
        expect(res.data.delivery.in_app).toBe(0);
      } finally {
        await ds.query(
          `DELETE FROM notification_schema.notifications WHERE recipient_id = ANY($1::bigint[])`,
          [all],
        );
      }
    });

    it('delivery_only, shu group_key bo‘yicha hech qachon qator bo‘lmagan — yangi qator YO‘Q', async () => {
      await service.dispatch(
        base({ channels: ['telegram'] as never, delivery_only: true }),
      );
      expect(await rows()).toHaveLength(0);
    });

    /** Bir vaqtda yozilgan yetkazish holati (masalan 09:00 Telegram). */
    const raceOnRead = () => {
      const repo = ds.getRepository(Notification);
      const original = (opts: FindOneOptions<Notification>) =>
        repo.findOne(opts);
      const spy = jest
        .spyOn(repo, 'findOne')
        .mockImplementationOnce(async (opts: FindOneOptions<Notification>) => {
          const row: Notification | null = await original(opts);
          await ds.query(
            `UPDATE notification_schema.notifications
                SET delivery = COALESCE(delivery, '{}'::jsonb) || '{"telegram":"queued"}'::jsonb
              WHERE recipient_id = ${USER}`,
          );
          return row;
        });
      return spy;
    };
    const deliveryOf = async () =>
      (
        await ds.query<
          Array<{
            delivery: Record<string, string>;
            is_deleted: boolean;
            is_read: boolean;
          }>
        >(
          `SELECT delivery, is_deleted, is_read FROM notification_schema.notifications WHERE recipient_id = ${USER}`,
        )
      )[0];

    it('#699 S2: remove() — o‘qish va yozish orasidagi parallel yetkazish holati saqlanadi (faqat is_deleted)', async () => {
      await service.dispatch(base());
      const [row] = await rows();
      const repo = ds.getRepository(Notification);
      // Parallel yozuv — remove() ning YOZUVIDAN oldin (eski yo'lda findOne
      // dan keyin, save(eski nusxa) dan oldin; yangi yo'lda UPDATE dan oldin).
      const inject = () =>
        ds.query(
          `UPDATE notification_schema.notifications
              SET delivery = COALESCE(delivery, '{}'::jsonb) || '{"telegram":"queued"}'::jsonb
            WHERE recipient_id = ${USER}`,
        );
      const save = repo.save.bind(repo);
      const update = repo.update.bind(repo);
      const saveSpy = jest
        .spyOn(repo, 'save')
        .mockImplementation(async (...args: Parameters<typeof save>) => {
          await inject();
          return save(...args);
        });
      const updateSpy = jest
        .spyOn(repo, 'update')
        .mockImplementation(async (...args: Parameters<typeof update>) => {
          await inject();
          return update(...args);
        });
      try {
        await service.remove(USER, row.id);
      } finally {
        saveSpy.mockRestore();
        updateSpy.mockRestore();
      }
      expect(await deliveryOf()).toMatchObject({
        is_deleted: true,
        delivery: { telegram: 'queued' },
      });
      await expect(service.remove(USER, row.id)).rejects.toBeDefined();
    });

    it('#708 S-a: delivery_only [sms, telegram] — sms_reason / realtime_reason mavjud qatorga yozilmaydi', async () => {
      await service.dispatch(base());
      const before = await deliveryOf();
      await service.dispatch(
        base({
          channels: ['sms', 'realtime', 'telegram'] as never,
          delivery_only: true,
        }),
      );
      const after = await deliveryOf();
      const keys = (d: Record<string, string>) =>
        Object.keys(d).filter((k) => !k.startsWith('telegram'));
      expect(keys(after.delivery).sort()).toEqual(keys(before.delivery).sort());
      for (const k of keys(before.delivery))
        expect(after.delivery[k]).toBe(before.delivery[k]);
    });

    it('#708 S-c: delivery_only, tashqi kanal yo‘q ([in_app] / []) — 400, hech narsa yozilmaydi', async () => {
      await service.dispatch(base());
      const before = await deliveryOf();
      for (const channels of [['in_app'], []]) {
        await expect(
          service.dispatch(
            base({ channels: channels as never, delivery_only: true }),
          ),
        ).rejects.toMatchObject({ error: { statusCode: 400 } });
      }
      expect(await deliveryOf()).toEqual(before);
    });

    it('#699 S2: markRead() ham — faqat is_read/read_at', async () => {
      await service.dispatch(base());
      const [row] = await rows();
      const spy = raceOnRead();
      try {
        await service.markRead(USER, row.id);
      } finally {
        spy.mockRestore();
      }
      expect(await deliveryOf()).toMatchObject({
        is_read: true,
        delivery: { telegram: 'queued' },
      });
    });

    it('#699 S3: delivery_only — realtime/SMS so‘ralsa ham emit yo‘q, mavjud realtime holati o‘zgarmaydi', async () => {
      await service.dispatch(base());
      const before = await deliveryOf();
      emit.mockClear();
      await service.dispatch(
        base({
          channels: ['realtime', 'telegram'] as never,
          delivery_only: true,
        }),
      );
      expect(emit).not.toHaveBeenCalled();
      const after = await deliveryOf();
      expect(after.delivery.realtime).toBe(before.delivery.realtime);
      expect(after.delivery.in_app).toBe(before.delivery.in_app);
      expect(after.is_read).toBe(false);
    });

    it('#699 S4: delivery_only, qator yo‘q — «saqlandi» emas, skipped_no_row', async () => {
      const res = (await service.dispatch(
        base({ channels: ['telegram'] as never, delivery_only: true }),
      )) as { message: string; data: { skipped_no_row: number } };
      expect(res.message).toMatch(/no existing inbox row/);
      expect(res.data.skipped_no_row).toBe(1);
      expect(await rows()).toHaveLength(0);
    });
  },
);
