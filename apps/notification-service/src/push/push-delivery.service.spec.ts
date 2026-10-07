import { NotificationPriority } from '@app/common';
import {
  PUSH_DELIVER_PATTERN,
  PUSH_OUTBOX_TARGET,
  PushDeliveryService,
} from './push-delivery.service';

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
    type: 'order.new',
    priority: NotificationPriority.NORMAL,
    group_key: null,
    delivery: { push: 'queued' },
    ...extra,
  }) as any;

describe('PushDeliveryService', () => {
  let notifications: any;
  let subscriptions: any;
  let webPush: any;
  let outbox: any;
  let smsDispatch: any;
  let service: PushDeliveryService;
  let patches: Array<{ ids: string[]; sql: string; patch?: unknown }>;

  beforeEach(() => {
    patches = [];
    const qb = () => {
      const state: any = { ids: [], sql: '', patch: undefined };
      const builder: any = {
        update: jest.fn(() => builder),
        set: jest.fn((values: any) => {
          state.sql = values.delivery();
          return builder;
        }),
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
    notifications = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(qb),
    };
    subscriptions = { find: jest.fn().mockResolvedValue([]) };
    webPush = {
      enabled: true,
      sendToSubscriptions: jest.fn(),
    };
    outbox = { enqueue: jest.fn().mockResolvedValue({}) };
    smsDispatch = { escalate: jest.fn().mockResolvedValue(1) };
    service = new PushDeliveryService(
      notifications,
      subscriptions,
      webPush,
      outbox,
      smsDispatch,
    );
  });

  const patchFor = (id: string) =>
    patches.filter((p) => p.ids.includes(id) && p.patch).map((p) => p.patch);

  it('enqueues outbox events in chunks of 100 inside the caller transaction', async () => {
    const manager = { tx: true } as any;
    const ids = Array.from({ length: 250 }, (_, i) => String(i + 1));

    await service.enqueue(manager, ids);

    expect(outbox.enqueue).toHaveBeenCalledTimes(3);
    expect(outbox.enqueue).toHaveBeenNthCalledWith(
      1,
      PUSH_OUTBOX_TARGET,
      PUSH_DELIVER_PATTERN,
      { notification_ids: ids.slice(0, 100) },
      { manager },
    );
    expect(outbox.enqueue.mock.calls[2][2].notification_ids).toHaveLength(50);
  });

  it('writes sent / no_subscription / failed into delivery (DB, not just logs)', async () => {
    notifications.find.mockResolvedValue([
      row('1', '42'),
      row('2', '43'),
      row('3', '44'),
    ]);
    subscriptions.find.mockResolvedValue([
      { id: 's1', user_id: '42' },
      { id: 's3', user_id: '44' },
    ]);
    webPush.sendToSubscriptions.mockImplementation((subs: any[]) => {
      if (!subs.length)
        return Promise.resolve({ sent: 0, failed: 0, gone: 0, error: null });
      if (subs[0].id === 's1')
        return Promise.resolve({ sent: 1, failed: 0, gone: 0, error: null });
      return Promise.resolve({
        sent: 0,
        failed: 1,
        gone: 0,
        error: 'HTTP 500: oops',
      });
    });

    const res = await service.deliver({ notification_ids: ['1', '2', '3'] });

    expect(res).toEqual({
      processed: 3,
      sent: 1,
      no_subscription: 1,
      failed: 1,
    });
    expect(patchFor('1')[0]).toEqual(
      expect.objectContaining({
        push: 'sent',
        push_sent_at: expect.any(String),
        push_error: null,
      }),
    );
    expect(patchFor('2')[0]).toEqual({ push: 'no_subscription' });
    expect(patchFor('3')[0]).toEqual({
      push: 'failed',
      push_error: 'HTTP 500: oops',
    });
    // subscriptions are loaded once for all recipients, not per user
    expect(subscriptions.find).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a retried event skips notifications already sent', async () => {
    notifications.find.mockResolvedValue([
      row('1', '42', { delivery: { push: 'sent' } }),
      row('2', '43'),
    ]);
    webPush.sendToSubscriptions.mockResolvedValue({
      sent: 0,
      failed: 0,
      gone: 0,
      error: null,
    });

    const res = await service.deliver({ notification_ids: ['1', '2'] });

    expect(res.processed).toBe(1);
    expect(webPush.sendToSubscriptions).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL without a successful push is flagged for SMS escalation exactly once', async () => {
    notifications.find.mockResolvedValue([
      row('1', '42', { priority: NotificationPriority.CRITICAL }),
      row('2', '43', { priority: NotificationPriority.NORMAL }),
    ]);
    webPush.sendToSubscriptions.mockResolvedValue({
      sent: 0,
      failed: 0,
      gone: 0,
      error: null,
    });

    await service.deliver({ notification_ids: ['1', '2'] });

    const escalation = patches.find((p) =>
      p.sql.includes('escalation_pending'),
    );
    expect(escalation?.ids).toEqual(['1']);
    // guarded so a retry never escalates twice
    const builder = notifications.createQueryBuilder.mock.results.find(
      (r: any) =>
        r.value.set.mock.calls[0]?.[0]
          .delivery()
          .includes('escalation_pending'),
    ).value;
    expect(builder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('escalated_at'),
    );
    // SMS kanali bor — faqat CRITICAL qatorlar SMS'ga uzatiladi (Jht84wGp #8).
    expect(smsDispatch.escalate).toHaveBeenCalledWith(['1']);
  });

  it('marks push as failed (push_disabled) when VAPID is not configured', async () => {
    webPush.enabled = false;
    notifications.find.mockResolvedValue([row('1', '42')]);

    await service.deliver({ notification_ids: ['1'] });

    expect(patchFor('1')[0]).toEqual({
      push: 'failed',
      push_error: 'push_disabled',
    });
    expect(webPush.sendToSubscriptions).not.toHaveBeenCalled();
  });

  it('ignores an empty payload', async () => {
    expect(await service.deliver({})).toEqual({ processed: 0 });
    expect(notifications.find).not.toHaveBeenCalled();
  });
});
