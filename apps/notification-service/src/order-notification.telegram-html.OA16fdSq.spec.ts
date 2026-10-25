import { Logger } from '@nestjs/common';
import { Group_type, NotificationPriority, Order_status } from '@app/common';
import { telegramBotApiStub } from '@app/common/notification/telegram-html-kit-spec';
// Kontrakt testi: order-service HAQIQIY payload quruvchisi (outbox'ga aynan
// shu yoziladi) → notification-service dispatch → market guruhi.
import {
  ORDER_PILOT_NOTIFICATION_TYPES,
  buildOrderNotificationPayload,
} from '../../order-service/src/notification/order-notification.service';
import { BotOutboxService } from './bot/bot-outbox.service';
import { BotTransportService } from './bot/bot-transport.service';
import { NotificationServiceService } from './notification-service.service';
import { PushDeliveryService } from './push/push-delivery.service';
import { makeInbox } from './testing/inbox-kit-spec';

/**
 * OA16fdSq — buyurtma bildirishnomasining oxirgi qadami.
 *
 * TC6/TC15: 7 ta pilot hodisaning har biri inboxda qator yaratadi, `link`
 * — `/orders/edit/{id}` (frontend «Buyurtma tafsiloti»; `/orders/{id}`
 * marshruti yo'q — 404 edi); push ham aynan shu havolani oladi.
 *
 * TC8/TC9: Telegram kanali so'ralganda (order.cancelled) xabar marketning
 * "cancel" guruhiga `parse_mode: HTML` bilan yetadi va mijoz ismidagi `<`,
 * `&`, `*` uni buzmaydi. Zanjirning HECH bir bo'g'ini mock emas:
 * `NotificationInboxService.dispatch` → `relayTelegram` →
 * `NotificationServiceService.sendNotification` (guruh tanlash) →
 * `BotOutboxService.send` (telegram_outbox) → `BotTransportService.sendMessage`
 * → `fetch`. Faqat `fetch` o'rnida Telegram Bot API emulyatori — u Telegram
 * kabi yaroqsiz HTML'ni `400 can't parse entities` bilan rad etadi.
 */

const MARKET = '37';
const CREATE_GROUP = '-1003700000001';
const CANCEL_GROUP = '-1003700000002';

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const order = (overrides: Record<string, unknown> = {}) =>
  ({
    id: '36',
    market_id: MARKET,
    operator_id: null,
    status: Order_status.CANCELLED,
    total_price: 150000,
    address: 'Chilonzor 5-uy',
    comment: null,
    return_reason: 'CUSTOMER_REFUSED',
    operator: 'TEST Operator',
    ...overrides,
  }) as any;

/** Haqiqiy guruh relay zanjiri; faqat `fetch` — Telegram emulyatori. */
function makeTelegramChain() {
  const api = telegramBotApiStub();
  const groups = [
    {
      id: '1',
      market_id: MARKET,
      group_type: Group_type.CREATE,
      group_id: CREATE_GROUP,
    },
    {
      id: '2',
      market_id: MARKET,
      group_type: Group_type.CANCEL,
      group_id: CANCEL_GROUP,
    },
  ];
  const tgMarketRepo = {
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        groups.filter(
          (group) =>
            group.market_id === where.market_id &&
            (!where.group_type || group.group_type === where.group_type),
        ),
      ),
    ),
  };
  const outboxRows: Array<Record<string, any>> = [];
  const outboxRepo = {
    insert: jest.fn((row: Record<string, unknown>) => {
      outboxRows.push({ ...row, id: String(outboxRows.length + 1) });
      return Promise.resolve({
        identifiers: [{ id: String(outboxRows.length) }],
      });
    }),
    update: jest.fn(
      ({ id }: { id: string }, patch: Record<string, unknown>) => {
        Object.assign(outboxRows[Number(id) - 1], patch);
        return Promise.resolve({ affected: 1 });
      },
    ),
  };
  const config = {
    get: (key: string) =>
      ({ TELEGRAM_BOT_TOKEN: '123456:TEST-bot-token' })[key],
  };
  const transport = new BotTransportService(config as never);
  transport.fetchImpl = api.fetchImpl;
  transport.sleep = () => Promise.resolve();
  const botOutbox = new BotOutboxService(
    outboxRepo as never,
    transport,
    { markInactive: jest.fn().mockResolvedValue(undefined) } as never,
    config as never,
  );
  const telegram = new NotificationServiceService(
    tgMarketRepo as never,
    {} as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never,
    botOutbox,
    {} as never,
  );
  const relay = {
    sendNotification: jest.fn(
      (dto: Parameters<NotificationServiceService['sendNotification']>[0]) =>
        telegram.sendNotification(dto),
    ),
  };
  const inbox = makeInbox({ telegramService: relay });
  return { api, relay, outboxRows, telegram, ...inbox };
}

const cancelPayload = (
  customerName: string,
  extra: Record<string, unknown> = {},
) =>
  buildOrderNotificationPayload(
    'order.cancelled',
    order(extra),
    Order_status.WAITING,
    {
      telegram: {
        customer: { name: customerName, phone_number: '+998887009196' },
        courier: { name: 'TEST Claude Kuryer', phone_number: '+998887009126' },
        region_name: 'Toshkent',
        district_name: 'Chilonzor',
        items: [{ name: 'Telefon', quantity: 1 }],
      },
    },
  )!;

describe('OA16fdSq TC8 — Telegram kanali: market guruhiga parse_mode HTML bilan yetadi', () => {
  it('order.cancelled → marketning CANCEL guruhiga BITTA sendMessage, parse_mode=HTML, matn order-service tayyorlagani; telegram_outbox ham HTML saqlaydi', async () => {
    const chain = makeTelegramChain();
    const payload = cancelPayload('Ali Valiyev');
    expect(payload.channels).toContain('telegram');

    const res: any = await chain.service.dispatch({
      ...payload,
      request_id: 'req-tc8',
    } as never);

    expect(chain.relay.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        market_id: MARKET,
        group_type: Group_type.CANCEL,
        parse_mode: 'HTML',
        message: payload.telegram!.text,
      }),
    );
    // Faqat "cancel" guruhi — "create" guruhiga emas.
    expect(chain.api.calls).toHaveLength(1);
    const [call] = chain.api.calls;
    expect(call).toEqual(
      expect.objectContaining({ method: 'sendMessage', ok: true }),
    );
    expect(call.body).toEqual({
      chat_id: CANCEL_GROUP,
      text: payload.telegram!.text,
      parse_mode: 'HTML',
    });
    expect(call.plain).toContain('❌ Buyurtma bekor qilindi');
    expect(call.plain).toContain('Mijoz: Ali Valiyev');
    // Qayta urinish (429/5xx) ham HTML bilan ketadi — outbox payload'ida.
    expect(chain.outboxRows).toEqual([
      expect.objectContaining({
        chat_id: CANCEL_GROUP,
        method: 'sendMessage',
        status: 'sent',
        source: 'notification.send',
        payload: { text: payload.telegram!.text, parse_mode: 'HTML' },
      }),
    ]);
    expect(res.data.by_channel.telegram).toBe(1);
  });

  it('Telegram kanali so‘ralmagan tur (order.sold) — guruhga hech narsa ketmaydi', async () => {
    const chain = makeTelegramChain();
    const payload = buildOrderNotificationPayload(
      'order.sold',
      order({ status: Order_status.SOLD }),
      Order_status.WAITING,
    )!;
    await chain.service.dispatch({ ...payload, request_id: 'r' } as never);
    expect(payload).not.toHaveProperty('telegram');
    expect(chain.relay.sendNotification).not.toHaveBeenCalled();
    expect(chain.api.calls).toHaveLength(0);
  });
});

describe('OA16fdSq TC9 — mijoz ismida `<`, `&`, `*` — Telegram rad etmaydi (escape)', () => {
  it.each([
    ['<Ali> & *Vali*'],
    ['Ali & Co <b>VIP</b>'],
    ['</b><i>*_`[x](tg://y)`'],
    ['&lt; allaqachon & escape'],
    ['*Vali'],
    [`${'A'.repeat(118)}😀 uzun ism`],
  ])('mijoz %p — 200 ok, guruhda ism aynan ko‘rinadi', async (name) => {
    const chain = makeTelegramChain();
    const payload = cancelPayload(name, {
      comment: `Mijoz ${name} rad etdi`,
      address: `${name} ko‘chasi`,
    });

    const res: any = await chain.service.dispatch({
      ...payload,
      request_id: `req-${name.length}`,
    } as never);

    expect(chain.api.calls).toHaveLength(1);
    const [call] = chain.api.calls;
    expect(call.description).toBeUndefined();
    expect(call.ok).toBe(true);
    expect(call.body.parse_mode).toBe('HTML');
    const shown = name.length > 120 ? `${'A'.repeat(118)}…` : name;
    expect(call.plain).toContain(`Mijoz: ${shown}`);
    expect(res.data.by_channel.telegram).toBe(1);
    expect(chain.outboxRows[0].status).toBe('sent');
  });

  it('nazorat: escape QILINMAGAN matn emulyatorda rad etiladi (400 can’t parse entities → dead, delivery failed)', async () => {
    const chain = makeTelegramChain();
    const res: any = await chain.service.dispatch({
      type: 'order.cancelled',
      title: 'Bekor',
      recipient_ids: [MARKET],
      data: { order_id: '36' },
      channels: ['in_app', 'telegram'],
      telegram: {
        market_id: MARKET,
        group_type: Group_type.CANCEL,
        text: '<b>Mijoz:</b> <Ali> & *Vali*',
      },
      request_id: 'req-raw',
    } as never);

    expect(chain.api.calls).toEqual([
      expect.objectContaining({
        ok: false,
        description: expect.stringContaining("can't parse entities"),
      }),
    ]);
    // 400 — qayta urinilmaydi (dead), bildirishnoma natijasi "failed".
    expect(chain.outboxRows[0]).toEqual(
      expect.objectContaining({ status: 'dead', retry_count: 1 }),
    );
    expect(res.data.by_channel.telegram).toBe(0);
  });
});

describe('OA16fdSq TC6/TC15 — 7 pilot hodisa: inbox qatori + /orders/edit/{id}; push havolasi ham', () => {
  const fromStatus: Record<string, Order_status | null> = {
    'order.created': null,
    'order.accepted': Order_status.NEW,
    'order.on_way': Order_status.RECEIVED,
    'order.sold': Order_status.WAITING,
    'order.cancelled': Order_status.WAITING,
    'order.returned': Order_status.CANCELLED,
    'order.not_accepted': Order_status.ON_THE_ROAD,
  };

  it('har hodisa market inboxida qator yaratadi; link — frontend «Buyurtma tafsiloti» /orders/edit/{id}', async () => {
    const { service, store } = makeInbox();
    let orderId = 40;
    const expected: Array<[string, string]> = [];
    for (const type of ORDER_PILOT_NOTIFICATION_TYPES) {
      orderId += 1;
      const payload = buildOrderNotificationPayload(
        type,
        order({ id: String(orderId), operator_id: null }),
        fromStatus[type],
      )!;
      await service.dispatch({
        ...payload,
        request_id: `req-${type}`,
      } as never);
      expected.push([type, `/orders/edit/${orderId}`]);
    }

    const rows = [...store.values()].filter(
      (row) => row.recipient_id === MARKET,
    );
    expect(rows.map((row) => [row.type, row.link])).toEqual(expected);
    for (const row of rows) {
      expect(row.link).toMatch(/^\/orders\/edit\/\d+$/);
      expect(row.link).toBe(`/orders/edit/${(row.data as any).order_id}`);
    }
  });

  it('push (sw.js notificationclick shu `link` ni ochadi) — payload.link /orders/edit/{id}', async () => {
    const { service, store } = makeInbox();
    const payload = buildOrderNotificationPayload(
      'order.sold',
      order({ id: '43', status: Order_status.SOLD }),
      Order_status.WAITING,
    )!;
    await service.dispatch({ ...payload, request_id: 'req-push' } as never);
    const [row] = [...store.values()];

    const sendToSubscriptions = jest
      .fn()
      .mockResolvedValue({ sent: 1, failed: 0, gone: 0, error: null });
    const qb: any = {
      update: () => qb,
      set: () => qb,
      setParameter: () => qb,
      whereInIds: () => qb,
      andWhere: () => qb,
      execute: () => Promise.resolve({ affected: 1 }),
    };
    const push = new PushDeliveryService(
      {
        find: jest.fn().mockResolvedValue([
          {
            ...row,
            priority: NotificationPriority.NORMAL,
            delivery: { ...(row.delivery ?? {}), push: 'queued' },
            isDeleted: false,
          },
        ]),
        createQueryBuilder: () => qb,
      } as never,
      {
        find: jest.fn().mockResolvedValue([{ id: 's1', user_id: MARKET }]),
      } as never,
      { enabled: true, sendToSubscriptions } as never,
      { enqueue: jest.fn() } as never,
      { escalate: jest.fn() } as never,
      {
        createQueryRunner: () => ({
          connect: () => Promise.resolve(),
          query: () => Promise.resolve([{ locked: true }]),
          release: () => Promise.resolve(),
        }),
      } as never,
    );

    await push.deliver({
      notification_ids: [String(row.id)],
      quiet_checked: true,
    });

    expect(sendToSubscriptions).toHaveBeenCalledWith(
      [{ id: 's1', user_id: MARKET }],
      expect.objectContaining({
        type: 'order.sold',
        link: '/orders/edit/43',
        tag: 'order:43:status',
      }),
    );
  });
});
