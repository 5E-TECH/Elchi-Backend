import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationChannel } from '@app/common';
import type { DispatchNotificationDto } from '../dto/dispatch-notification.dto';
import { makeInbox, makeMemoryDedup } from '../testing/inbox-kit-spec';
import { TelegramDmService } from './telegram-dm.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: (...args: unknown[]) => rmqSendMock(...args) };
});

/**
 * TgYRqaTk — bot bildirishnoma yadrosining TRANSPORTI (o'z xabar tizimi yo'q):
 *  - `dispatch` faqat `recipients` bilan → TELEGRAM shaxsiy chatga
 *    (`identity.telegram.resolve_many { user_ids }` → chat_id);
 *  - bog'lanmagan qabul qiluvchi → `skipped`, xato yo'q;
 *  - `relayTelegram` token uzatmaydi;
 *  - Telegram natijasi `notifications.delivery` ga;
 *  - `notification.send` ichki/deprecated.
 * (Bot o'z sendMessage yo'lini ochmasligi — bot-core.ZlpXb4Wh.spec.ts grep-guard.)
 * (Joi NOTIFICATION_ADMIN_GROUP_ID — dispatch-redelivery.rzGKtE9N.spec.ts.)
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  rmqSendMock
    .mockReset()
    .mockImplementation(
      (
        _client: unknown,
        pattern: { cmd?: string },
        payload: { user_ids?: string[] },
      ) =>
        Promise.resolve(
          pattern?.cmd === 'identity.telegram.resolve_many'
            ? {
                data: Object.fromEntries(
                  (payload.user_ids ?? []).map((id) => [
                    id,
                    id === '11'
                      ? '5550011'
                      : id === '13'
                        ? '-1001234567'
                        : null,
                  ]),
                ),
              }
            : { data: null },
        ),
    );
});
afterEach(() => jest.restoreAllMocks());

const makeDm = () => {
  const patches: Array<{ ids: string[]; patch: Record<string, string> }> = [];
  const notifications = {
    query: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(() => {
      const qb: Record<string, jest.Mock> = {};
      let patch: Record<string, string> = {};
      qb.update = jest.fn(() => qb);
      qb.set = jest.fn(() => qb);
      qb.setParameter = jest.fn((_: string, value: string) => {
        patch = JSON.parse(value) as Record<string, string>;
        return qb;
      });
      qb.whereInIds = jest.fn((ids: string[]) => {
        patches.push({ ids, patch });
        return qb;
      });
      qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
      return qb;
    }),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue({}) };
  const telegram = { sendDirectToGroup: jest.fn().mockResolvedValue({}) };
  const dm = new TelegramDmService(
    notifications as never,
    outbox as never,
    { contacts: jest.fn() } as never,
    telegram as never,
    { get: (key: string) => ({ TELEGRAM_BOT_TOKEN: 'x:y' })[key] } as never,
    {} as never,
    {} as never,
  );
  return { dm, notifications, outbox, telegram, patches };
};

const dto = (extra: Partial<DispatchNotificationDto> = {}) =>
  ({
    type: 'finance.payment_received',
    title: "💰 To'lov qabul qilindi",
    body: "Sizga 1 500 000 so'm to'landi.",
    data: { kind: 'market_payment', amount: 1_500_000, payment_id: '701' },
    recipient_ids: ['11', '12'],
    channels: [NotificationChannel.IN_APP, NotificationChannel.TELEGRAM],
    ...extra,
  }) as DispatchNotificationDto;

describe('TgYRqaTk #1 — recipients → shaxsiy chat (market_id/group_id siz)', () => {
  it('⭐ dispatch faqat recipients bilan → DM navbatga, deliver shaxsiy chat_id ga yuboradi', async () => {
    const { dm, notifications, outbox, telegram, patches } = makeDm();
    const { service, store } = makeInbox({ dm, dedup: makeMemoryDedup() });
    const res = (await service.dispatch(dto())) as {
      data: { dispatched: number };
    };
    expect(res.data.dispatched).toBe(2);
    expect(rmqSendMock).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'identity.telegram.resolve_many' },
      { user_ids: ['11', '12'] },
    );
    // Guruh relay'i (telegram_markets) chaqirilmaydi.
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    const [queuedId] = (
      outbox.enqueue.mock.calls[0][2] as { notification_ids: string[] }
    ).notification_ids;
    const row = store.get(queuedId)!;
    expect(row.recipient_id).toBe('11');

    // Outbox iste'molchisi: da'vo → yuborish → `delivery.telegram = sent`.
    notifications.query.mockResolvedValueOnce([
      {
        id: queuedId,
        recipient_id: '11',
        title: row.title,
        body: row.body,
        data: row.data,
        type: row.type,
        link: null,
      },
    ]);
    expect(await dm.deliver({ notification_ids: [queuedId] })).toEqual({
      processed: 1,
      sent: 1,
      failed: 0,
    });
    expect(telegram.sendDirectToGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        group_id: '5550011',
        source: 'notification.dm',
      }),
    );
    // TgYRqaTk #5: kanal natijasi `notifications.delivery` ga.
    expect(patches.at(-1)).toEqual({
      ids: [queuedId],
      patch: { telegram: 'sent' },
    });
  });

  it('⭐ bog‘lanmagan qabul qiluvchi → telegram = skipped(no_telegram_id), xato tashlanmaydi', async () => {
    const { dm } = makeDm();
    const { service, store } = makeInbox({ dm, dedup: makeMemoryDedup() });
    const res = (await service.dispatch(dto())) as { statusCode: number };
    expect(res.statusCode).toBe(201);
    const unlinked = [...store.values()].find(
      (row) => row.recipient_id === '12',
    );
    expect(unlinked?.delivery).toEqual(
      expect.objectContaining({
        in_app: 'sent',
        telegram: 'skipped',
        telegram_reason: 'no_telegram_id',
      }),
    );
  });

  it('identity javob bermasa — telegram = failed(contacts_unavailable), in_app baribir', async () => {
    rmqSendMock.mockRejectedValue(new Error('timeout'));
    const { dm } = makeDm();
    const { service, store } = makeInbox({ dm, dedup: makeMemoryDedup() });
    await service.dispatch(dto());
    for (const row of store.values()) {
      expect(row.delivery).toEqual(
        expect.objectContaining({
          in_app: 'sent',
          telegram: 'failed',
          telegram_error: 'contacts_unavailable',
        }),
      );
    }
  });

  it('DM faqat shaxsiy chatga: manfiy (guruh) chat id → skipped(not_private_chat)', async () => {
    const { dm } = makeDm();
    const plan = await dm.plan(['13'], 'finance.payment_received');
    expect(plan.get('13')).toEqual({
      telegram: 'skipped',
      telegram_reason: 'not_private_chat',
    });
  });
});

describe('TgYRqaTk #2/#3 — token uzatilmaydi, notification.send ichki', () => {
  it('⭐ relayTelegram (market guruhi) — sendNotification payload’ida token YO‘Q', async () => {
    const { service, telegramService } = makeInbox({
      dedup: makeMemoryDedup(),
    });
    await service.dispatch(
      dto({
        type: 'order.cancelled',
        data: { order_id: '81' },
        recipient_ids: ['11'],
        channels: [NotificationChannel.IN_APP, NotificationChannel.TELEGRAM],
        telegram: { market_id: '37', text: 'Bekor', token: 'LEAK' } as never,
      }),
    );
    expect(telegramService.sendNotification).toHaveBeenCalledTimes(1);
    const [payload] = telegramService.sendNotification.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(payload).not.toHaveProperty('token');
    expect(JSON.stringify(payload)).not.toContain('LEAK');
    expect(payload).toEqual(
      expect.objectContaining({ market_id: '37', parse_mode: 'HTML' }),
    );
  });

  it('notification.send — @deprecated (ichki), servislar notification.dispatch ishlatadi', () => {
    const source = readFileSync(
      join(__dirname, '..', 'notification-service.controller.ts'),
      'utf8',
    );
    const at = source.indexOf("@MessagePattern({ cmd: 'notification.send' })");
    expect(at).toBeGreaterThan(0);
    expect(source.slice(Math.max(0, at - 600), at)).toMatch(
      /@deprecated[\s\S]*notification\.dispatch/,
    );
  });
});
