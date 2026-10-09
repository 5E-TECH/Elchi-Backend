import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { Order_status } from '@app/common';
import { NotificationInboxService } from './notification-inbox.service';
// Kontrakt testi: order-service HAQIQIY payload quruvchisi (outbox'ga aynan
// shu yoziladi) → notification-service dispatch → inbox qatorlari.
import {
  buildCourierAssignedPayload,
  buildOrderNotificationPayload,
} from '../../order-service/src/notification/order-notification.service';

/**
 * OA16fdSq TC7 — bir buyurtma bo'yicha ketma-ket 3 ta status o'zgarishi
 * inboxda 3 ta emas, BITTA qator (`group_key` = `order:{id}:status`)
 * qoldiradi: qator yangilanadi (tur/sarlavha/matn — oxirgisi, `is_read`
 * qayta `false`). Boshqa buyurtma va kuryer bildirishnomasi
 * (`order:{id}:courier`) alohida qatorlar. TC8 — Telegram matni market
 * guruhiga `parse_mode: HTML` bilan, o'zgarishsiz.
 */
describe('NotificationInboxService — group_key: bir buyurtma = inboxda bitta qator (OA16fdSq TC7)', () => {
  let service: NotificationInboxService;
  let store: Map<string, any>;
  let telegramService: { sendNotification: jest.Mock };

  const valuesOf = (operator: any): string[] =>
    (operator?.value ?? operator ?? []).map(String);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    store = new Map();
    let nextId = 1;
    let clock = Date.parse('2026-10-09T09:00:00.000Z');
    const txRepo = {
      create: jest.fn((value: any) => ({ ...value })),
      insert: jest.fn((rows: any[]) =>
        Promise.resolve({
          identifiers: rows.map((row) => {
            const id = String(nextId++);
            store.set(id, {
              id,
              isDeleted: false,
              createdAt: new Date((clock += 1000)),
              ...row,
            });
            return { id };
          }),
        }),
      ),
      update: jest.fn((where: any, patch: any) => {
        for (const id of valuesOf(where.id)) {
          store.set(id, { ...store.get(id), ...patch });
        }
        return Promise.resolve({ affected: valuesOf(where.id).length });
      }),
      find: jest.fn(({ where }: any) => {
        const rows = [...store.values()];
        if (where.id) {
          const ids = valuesOf(where.id);
          return Promise.resolve(rows.filter((row) => ids.includes(row.id)));
        }
        const recipients = valuesOf(where.recipient_id);
        return Promise.resolve(
          rows.filter(
            (row) =>
              recipients.includes(String(row.recipient_id)) &&
              row.group_key === where.group_key &&
              !row.isDeleted,
          ),
        );
      }),
    };
    const ownRows = (where: any) =>
      [...store.values()].filter(
        (row) =>
          String(row.recipient_id) === String(where.recipient_id) &&
          !row.isDeleted &&
          (where.is_read === undefined || row.is_read === where.is_read),
      );
    const qb: any = {
      update: jest.fn(() => qb),
      set: jest.fn(() => qb),
      setParameter: jest.fn(() => qb),
      whereInIds: jest.fn(() => qb),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const repo: any = {
      findAndCount: jest.fn(({ where }: any) => {
        const rows = ownRows(where);
        return Promise.resolve([rows, rows.length]);
      }),
      count: jest.fn(({ where }: any) =>
        Promise.resolve(ownRows(where).length),
      ),
      createQueryBuilder: jest.fn(() => qb),
      manager: {
        transaction: jest.fn((work: (manager: any) => Promise<unknown>) =>
          work({ getRepository: () => txRepo }),
        ),
      },
    };
    telegramService = {
      sendNotification: jest.fn().mockResolvedValue({
        data: { success: 1, failed: 0, results: [{ ok: true }] },
      }),
    };
    service = new NotificationInboxService(
      repo,
      { send: jest.fn() } as any,
      { emit: jest.fn(() => of(null)) } as any,
      telegramService as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { enqueue: jest.fn().mockResolvedValue(undefined) } as any,
      { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as any,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const order = (overrides: Record<string, unknown> = {}) =>
    ({
      id: '81',
      market_id: '5',
      operator_id: '9',
      status: Order_status.RECEIVED,
      total_price: 150000,
      address: 'Chilonzor 5-uy',
      comment: null,
      return_reason: null,
      ...overrides,
    }) as any;

  /** order-service outbox qatori payload'i (+ OutboxService qo'shadigan request_id). */
  const outboxPayload = (
    type: Parameters<typeof buildOrderNotificationPayload>[0],
    status: Order_status,
    from: Order_status,
    overrides: { id?: string; comment?: string } = {},
  ) => ({
    ...buildOrderNotificationPayload(
      type,
      order({ status, ...overrides }),
      from,
      { logist_id: '77' },
    )!,
    request_id: `req-${type}-${overrides.id ?? '81'}`,
  });

  const inbox = async (recipientId: string) =>
    ((await service.list({ recipient_id: recipientId } as any)) as any).data;

  it('TC7: qabul → yo‘lda → sotildi (3 dispatch) — har qabul qiluvchida BITTA qator, oxirgi holat bilan', async () => {
    const chain = [
      outboxPayload('order.accepted', Order_status.RECEIVED, Order_status.NEW),
      outboxPayload(
        'order.on_way',
        Order_status.ON_THE_ROAD,
        Order_status.RECEIVED,
      ),
      outboxPayload('order.sold', Order_status.SOLD, Order_status.WAITING),
    ];
    for (const payload of chain) {
      expect(payload.group_key).toBe('order:81:status');
      await service.dispatch(payload as any);
    }

    const rows = [...store.values()];
    // market (5) + operator (9) + logist (77) — har biriga 1 tadan, 9 ta emas
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.recipient_id).sort()).toEqual([
      '5',
      '77',
      '9',
    ]);
    for (const row of rows) {
      expect(row).toEqual(
        expect.objectContaining({
          group_key: 'order:81:status',
          type: 'order.sold',
          title: 'Buyurtma sotildi',
          body: 'Buyurtma #EL-100081 sotildi.',
          link: '/orders/81',
        }),
      );
    }

    const marketInbox = await inbox('5');
    expect(marketInbox.items).toHaveLength(1);
    expect(marketInbox.meta.total).toBe(1);
    expect(marketInbox.items[0].type).toBe('order.sold');
  });

  it('o‘qilgan qator yangi holatda qayta "o‘qilmagan" bo‘ladi (yangilik ko‘rinadi)', async () => {
    await service.dispatch(
      outboxPayload(
        'order.accepted',
        Order_status.RECEIVED,
        Order_status.NEW,
      ) as any,
    );
    for (const row of store.values()) row.is_read = true;
    expect((await inbox('5')).unread).toBe(0);

    await service.dispatch(
      outboxPayload(
        'order.on_way',
        Order_status.ON_THE_ROAD,
        Order_status.RECEIVED,
      ) as any,
    );
    const market = await inbox('5');
    expect(market.items).toHaveLength(1);
    expect(market.unread).toBe(1);
  });

  it('boshqa buyurtma — alohida qator; kuryer bildirishnomasi (order:{id}:courier) — status qatoridan alohida', async () => {
    await service.dispatch(
      outboxPayload(
        'order.accepted',
        Order_status.RECEIVED,
        Order_status.NEW,
      ) as any,
    );
    await service.dispatch(
      outboxPayload('order.accepted', Order_status.RECEIVED, Order_status.NEW, {
        id: '82',
      }) as any,
    );
    await service.dispatch({
      ...buildCourierAssignedPayload(
        {
          id: '81',
          market_id: '5',
          courier_id: '55',
          status: Order_status.ON_THE_ROAD,
        } as any,
        null,
      )!,
      request_id: 'req-courier-81',
    } as any);

    // `toPublic` group_key'ni chiqarmaydi — DB qatorlari bo'yicha tekshiriladi.
    const marketRows = [...store.values()].filter(
      (row) => row.recipient_id === '5',
    );
    expect(marketRows.map((row) => row.group_key).sort()).toEqual([
      'order:81:courier',
      'order:81:status',
      'order:82:status',
    ]);
    expect((await inbox('5')).items).toHaveLength(3);
    const courier = await inbox('55');
    expect(courier.items).toHaveLength(1);
    expect(courier.items[0]).toEqual(
      expect.objectContaining({
        type: 'order.assigned_to_courier',
        link: '/orders/81',
      }),
    );
  });

  it('TC8: bekor qilish — Telegram market "cancel" guruhiga order-service tayyorlagan HTML matn bilan (parse_mode HTML); inbox qatori baribir bitta', async () => {
    await service.dispatch(
      outboxPayload(
        'order.on_way',
        Order_status.ON_THE_ROAD,
        Order_status.RECEIVED,
      ) as any,
    );
    const cancel = outboxPayload(
      'order.cancelled',
      Order_status.CANCELLED,
      Order_status.WAITING,
      { comment: 'Mijoz <Ali> & *Vali* rad etdi' },
    );
    await service.dispatch(cancel as any);

    expect(telegramService.sendNotification).toHaveBeenCalledTimes(1);
    expect(telegramService.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        market_id: '5',
        group_type: 'cancel',
        parse_mode: 'HTML',
        message: cancel.telegram!.text,
      }),
    );
    expect(cancel.telegram!.text).toContain(
      'Mijoz &lt;Ali&gt; &amp; *Vali* rad etdi',
    );
    // in_app qatori (TC10): manzil/izoh yo'q, guruh bitta
    const market = await inbox('5');
    expect(market.items).toHaveLength(1);
    expect(JSON.stringify(market.items[0])).not.toContain('Chilonzor');
    expect(JSON.stringify(market.items[0])).not.toContain('Vali');
  });
});
