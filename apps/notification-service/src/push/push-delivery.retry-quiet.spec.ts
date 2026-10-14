import { NotificationPriority } from '@app/common';
import { of, throwError } from 'rxjs';
import {
  PRESENCE_CHECK_PATTERN,
  PUSH_DELIVER_PATTERN,
  PUSH_MAX_ATTEMPTS,
  PushDeliveryService,
} from './push-delivery.service';

/**
 * (Jht84wGp TC6) vaqtinchalik xatoda qayta urinish, (mP1WGG1W TC8/TC9) tinch
 * soatlar — ertalabga surish, (7Ec56EIw TC8) onlayn foydalanuvchiga push yo'q.
 */
const row = (
  id: string,
  recipient: string,
  extra: Record<string, unknown> = {},
) =>
  ({
    id,
    recipient_id: recipient,
    title: `T${id}`,
    body: null,
    link: null,
    type: 'order.manual',
    priority: NotificationPriority.NORMAL,
    group_key: null,
    channels: ['in_app', 'push'],
    delivery: { push: 'queued' },
    isDeleted: false,
    ...extra,
  }) as any;

describe('PushDeliveryService — retry / quiet hours / presence', () => {
  let notifications: any;
  let subscriptions: any;
  let webPush: any;
  let outbox: any;
  let smsDispatch: any;
  let config: any;
  let gatewayClient: any;
  let service: PushDeliveryService;
  let patches: Array<{ ids: string[]; patch: any; tx: boolean }>;

  const build = () =>
    new PushDeliveryService(
      notifications,
      subscriptions,
      webPush,
      outbox,
      smsDispatch,
      {
        createQueryRunner: () => ({
          connect: jest.fn(),
          query: jest.fn().mockResolvedValue([{ locked: true }]),
          release: jest.fn(),
        }),
      } as any,
      config,
      gatewayClient,
    );

  beforeEach(() => {
    patches = [];
    const qb = (tx: boolean) => () => {
      const state: any = { ids: [], patch: undefined, tx };
      const builder: any = {
        update: jest.fn(() => builder),
        set: jest.fn(() => builder),
        setParameter: jest.fn((_: string, value: string) => {
          state.patch = JSON.parse(value);
          return builder;
        }),
        whereInIds: jest.fn((ids: string[]) => {
          state.ids = ids;
          return builder;
        }),
        andWhere: jest.fn(() => builder),
        execute: jest.fn(() => {
          patches.push(state);
          return Promise.resolve({ affected: state.ids.length });
        }),
      };
      return builder;
    };
    const txManager = {
      getRepository: () => ({ createQueryBuilder: qb(true) }),
    };
    notifications = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(qb(false)),
      manager: {
        transaction: jest.fn((work: (m: unknown) => Promise<unknown>) =>
          work(txManager),
        ),
      },
    };
    subscriptions = {
      find: jest.fn().mockResolvedValue([
        { id: 's42', user_id: '42' },
        { id: 's43', user_id: '43' },
      ]),
    };
    webPush = {
      enabled: true,
      sendToSubscriptions: jest
        .fn()
        .mockResolvedValue({ sent: 1, failed: 0, gone: 0, error: null }),
    };
    outbox = { enqueue: jest.fn().mockResolvedValue({}) };
    smsDispatch = {
      contacts: jest.fn().mockResolvedValue(new Map()),
      escalate: jest.fn(),
    };
    config = { get: jest.fn(() => undefined) };
    gatewayClient = { send: jest.fn(() => of({ online: [] })) };
    service = build();
  });

  afterEach(() => jest.useRealTimers());

  const patchFor = (id: string) =>
    patches.filter((p) => p.ids.includes(id)).map((p) => p.patch);

  describe('Jht84wGp TC6 — provayder 500 → qayta urinish', () => {
    const fail500 = {
      sent: 0,
      failed: 1,
      gone: 0,
      error: 'HTTP 500: oops',
      retryable: true,
    };

    it('1-urinish: qator "queued" qoladi, keyingi urinish outbox scheduledAt bilan (BITTA tranzaksiyada)', async () => {
      notifications.find.mockResolvedValue([row('1', '42')]);
      webPush.sendToSubscriptions.mockResolvedValue(fail500);

      const before = Date.now();
      const res = await service.deliver({ notification_ids: ['1'] });

      expect(res).toEqual(expect.objectContaining({ retry: 1, sent: 0 }));
      const [patch] = patchFor('1');
      expect(patch).toEqual(
        expect.objectContaining({
          push: 'queued',
          push_error: 'HTTP 500: oops',
          push_attempts: 1,
        }),
      );
      expect(patches[0].tx).toBe(true);
      const [, pattern, payload, options] = outbox.enqueue.mock.calls[0];
      expect(pattern).toBe(PUSH_DELIVER_PATTERN);
      expect(payload).toEqual({
        notification_ids: ['1'],
        attempt: 2,
        quiet_checked: true,
      });
      expect(options.scheduledAt.getTime()).toBeGreaterThanOrEqual(
        before + 60_000,
      );
      expect(options.manager).toBeDefined();
      // Obuna o'chirilmaydi (faqat 404/410 da) — web-push.service last_error yozadi.
      expect(subscriptions.delete).toBeUndefined();
    });

    it(`oxirgi (${PUSH_MAX_ATTEMPTS}-) urinishda ham yiqilsa — yakuniy "failed", yangi hodisa yo‘q`, async () => {
      notifications.find.mockResolvedValue([row('1', '42')]);
      webPush.sendToSubscriptions.mockResolvedValue(fail500);

      await service.deliver({
        notification_ids: ['1'],
        attempt: PUSH_MAX_ATTEMPTS,
        quiet_checked: true,
      });

      expect(patchFor('1')[0]).toEqual({
        push: 'failed',
        push_error: 'HTTP 500: oops',
        push_attempts: PUSH_MAX_ATTEMPTS,
      });
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('4xx (retryable=false) — qayta urinish YO‘Q', async () => {
      notifications.find.mockResolvedValue([row('1', '42')]);
      webPush.sendToSubscriptions.mockResolvedValue({
        ...fail500,
        error: 'HTTP 400: bad',
        retryable: false,
      });

      await service.deliver({ notification_ids: ['1'] });

      expect(patchFor('1')[0].push).toBe('failed');
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('idempotent: "queued" bo‘lmagan (yakunlangan) qator qayta yuborilmaydi', async () => {
      notifications.find.mockResolvedValue([
        row('1', '42', { delivery: { push: 'failed' } }),
        row('2', '43', { delivery: { push: 'no_subscription' } }),
        row('3', '43', { delivery: { push: 'sent' } }),
      ]);
      expect(
        await service.deliver({ notification_ids: ['1', '2', '3'] }),
      ).toEqual({ processed: 0 });
      expect(webPush.sendToSubscriptions).not.toHaveBeenCalled();
    });
  });

  describe('mP1WGG1W TC8/TC9 — tinch soatlar (Toshkent vaqti)', () => {
    const QUIET = { quiet_hours: { from: '22:00', to: '08:00' } };

    it('23:00 Toshkent (18:00Z) — normal push tashlanmaydi, 08:00 Toshkent (03:00Z) ga suriladi', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-14T18:00:00.000Z') });
      notifications.find.mockResolvedValue([
        row('1', '42'),
        row('2', '43', { priority: NotificationPriority.CRITICAL }),
      ]);
      smsDispatch.contacts.mockResolvedValue(
        new Map([
          ['42', { id: '42', ...QUIET }],
          ['43', { id: '43', ...QUIET }],
        ]),
      );

      const res = await service.deliver({ notification_ids: ['1', '2'] });

      // Critical tinch soatga qaramaydi — darhol ketadi.
      expect(webPush.sendToSubscriptions).toHaveBeenCalledTimes(1);
      expect(webPush.sendToSubscriptions.mock.calls[0][1].id).toBe('2');
      expect(res).toEqual(expect.objectContaining({ deferred: 1 }));

      expect(patchFor('1')[0]).toEqual({
        push: 'queued',
        push_reason: 'quiet_hours',
        push_deferred_until: '2026-10-15T03:00:00.000Z',
      });
      const [, pattern, payload, options] = outbox.enqueue.mock.calls[0];
      expect(pattern).toBe(PUSH_DELIVER_PATTERN);
      expect(payload).toEqual({
        notification_ids: ['1'],
        attempt: 1,
        quiet_checked: true,
      });
      expect(options.scheduledAt.toISOString()).toBe(
        '2026-10-15T03:00:00.000Z',
      );
    });

    it('UTC bo‘yicha emas: 22:30Z (= 03:30 Toshkent) ham oyna ichida, 05:00Z (= 10:00) — tashqarida', async () => {
      smsDispatch.contacts.mockResolvedValue(
        new Map([['42', { id: '42', ...QUIET }]]),
      );
      notifications.find.mockResolvedValue([row('1', '42')]);

      jest.useFakeTimers({ now: new Date('2026-10-14T22:30:00.000Z') });
      await service.deliver({ notification_ids: ['1'] });
      expect(outbox.enqueue.mock.calls[0][3].scheduledAt.toISOString()).toBe(
        '2026-10-15T03:00:00.000Z',
      );

      outbox.enqueue.mockClear();
      webPush.sendToSubscriptions.mockClear();
      jest.setSystemTime(new Date('2026-10-15T05:00:00.000Z'));
      await service.deliver({ notification_ids: ['1'] });
      expect(outbox.enqueue).not.toHaveBeenCalled();
      expect(webPush.sendToSubscriptions).toHaveBeenCalledTimes(1);
    });

    it('surilgan hodisa (quiet_checked) qayta tekshirilmaydi va identity chaqirilmaydi', async () => {
      notifications.find.mockResolvedValue([row('1', '42')]);
      await service.deliver({ notification_ids: ['1'], quiet_checked: true });
      expect(smsDispatch.contacts).not.toHaveBeenCalled();
      expect(webPush.sendToSubscriptions).toHaveBeenCalledTimes(1);
    });

    it('identity javob bermasa — push hozir yuboriladi (yo‘qolmaydi)', async () => {
      notifications.find.mockResolvedValue([row('1', '42')]);
      smsDispatch.contacts.mockRejectedValue(new Error('identity down'));
      await service.deliver({ notification_ids: ['1'] });
      expect(webPush.sendToSubscriptions).toHaveBeenCalledTimes(1);
    });
  });

  describe('7Ec56EIw TC8 — onlayn foydalanuvchiga push yo‘q (faqat realtime)', () => {
    beforeEach(() => {
      config.get.mockImplementation((key: string) =>
        key === 'NOTIF_PUSH_PRESENCE_CHECK' ? true : undefined,
      );
    });

    it('socket ulangan + realtime so‘ralgan → push "skipped/online"; oflayn → push ketadi', async () => {
      notifications.find.mockResolvedValue([
        row('1', '42', { channels: ['in_app', 'realtime', 'push'] }),
        row('2', '43', { channels: ['in_app', 'realtime', 'push'] }),
      ]);
      gatewayClient.send.mockReturnValue(of({ online: ['42'] }));

      await service.deliver({ notification_ids: ['1', '2'] });

      expect(gatewayClient.send).toHaveBeenCalledWith(
        { cmd: PRESENCE_CHECK_PATTERN },
        { user_ids: ['42', '43'] },
      );
      expect(patchFor('1')[0]).toEqual({
        push: 'skipped',
        push_reason: 'online',
      });
      expect(webPush.sendToSubscriptions).toHaveBeenCalledTimes(1);
      expect(webPush.sendToSubscriptions.mock.calls[0][1].id).toBe('2');
    });

    it('realtime so‘ralmagan bo‘lsa onlayn foydalanuvchiga ham push ketadi', async () => {
      notifications.find.mockResolvedValue([row('1', '42')]);
      await service.deliver({ notification_ids: ['1'] });
      expect(gatewayClient.send).not.toHaveBeenCalled();
      expect(webPush.sendToSubscriptions).toHaveBeenCalledTimes(1);
    });

    it('gateway javob bermasa — oflayn deb hisoblanadi, push ketadi', async () => {
      notifications.find.mockResolvedValue([
        row('1', '42', { channels: ['in_app', 'realtime', 'push'] }),
      ]);
      gatewayClient.send.mockReturnValue(
        throwError(() => new Error('no handler')),
      );
      await service.deliver({ notification_ids: ['1'] });
      expect(webPush.sendToSubscriptions).toHaveBeenCalledTimes(1);
    });

    it('NOTIF_PUSH_PRESENCE_CHECK o‘chiq (sukut) — gateway so‘ralmaydi', async () => {
      config.get.mockReturnValue(undefined);
      notifications.find.mockResolvedValue([
        row('1', '42', { channels: ['in_app', 'realtime', 'push'] }),
      ]);
      await service.deliver({ notification_ids: ['1'] });
      expect(gatewayClient.send).not.toHaveBeenCalled();
      expect(webPush.sendToSubscriptions).toHaveBeenCalledTimes(1);
    });
  });
});
