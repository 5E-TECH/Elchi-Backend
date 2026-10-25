import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import {
  Group_type,
  Order_status,
  OutboxPublisher,
  OutboxService,
  isKnownNotificationType,
} from '@app/common';
import { OrderCustodyService } from '../custody/order-custody.service';
import { OrderLifecycleService } from '../lifecycle/order-lifecycle.service';
import { validateTelegramHtml } from '@app/common/notification/telegram-html-kit-spec';
import {
  NOTIFICATION_DISPATCH_PATTERN,
  NOTIFICATION_OUTBOX_TARGET,
  ORDER_COURIER_ASSIGNED_TYPE,
  ORDER_PILOT_NOTIFICATION_TYPES,
  OrderNotificationService,
  buildCourierAssignedPayload,
  buildOrderNotificationPayload,
  buildOrderTelegramText,
  orderDetailLink,
  resolveOrderNotificationType,
} from './order-notification.service';

/**
 * OA16fdSq / ePpLHPX2 — buyurtma hodisasi → bildirishnoma (outbox orqali,
 * biznes tranzaksiyasi ichida, fail-open).
 */
const SRC = join(__dirname, '..');

const order = (overrides: Record<string, unknown> = {}) =>
  ({
    id: '81',
    market_id: '5',
    operator_id: '9',
    customer_id: '2',
    status: Order_status.SOLD,
    total_price: 150000,
    address: 'Toshkent, Chilonzor 5-uy',
    comment: null,
    return_reason: null,
    ...overrides,
  }) as any;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('resolveOrderNotificationType — o‘tish → tur', () => {
  it.each([
    [null, Order_status.NEW, 'order.created'],
    [null, Order_status.CREATED, 'order.created'],
    [Order_status.NEW, Order_status.RECEIVED, 'order.accepted'],
    [Order_status.RECEIVED, Order_status.ON_THE_ROAD, 'order.on_way'],
    [Order_status.WAITING, Order_status.SOLD, 'order.sold'],
    [Order_status.WAITING, Order_status.PAID, 'order.sold'],
    [Order_status.WAITING, Order_status.PARTLY_PAID, 'order.sold'],
    [Order_status.WAITING, Order_status.CANCELLED, 'order.cancelled'],
    [Order_status.CANCELLED, Order_status.RETURNED_TO_MARKET, 'order.returned'],
    [
      Order_status.ON_THE_ROAD,
      Order_status.WAITING_CUSTOMER,
      'order.not_accepted',
    ],
  ])('%s → %s = %s', (from, to, type) => {
    expect(resolveOrderNotificationType(from as any, to)).toBe(type);
  });

  it.each([
    [Order_status.SOLD, Order_status.PAID], // marketga to'lov — sotuv emas
    [Order_status.SOLD, Order_status.WAITING], // rollback
    [Order_status.CANCELLED_SENT, Order_status.CANCELLED], // qaytgan pochta qabul qilindi
    [Order_status.WAITING, Order_status.WAITING], // izoh
    [Order_status.RECEIVED, Order_status.WAITING],
    [Order_status.CANCELLED, Order_status.CLOSED],
  ])('%s → %s — bildirishnoma yo‘q', (from, to) => {
    expect(resolveOrderNotificationType(from, to)).toBeNull();
  });

  it('TC12: barcha pilot turlar notification-types katalogida', () => {
    expect(ORDER_PILOT_NOTIFICATION_TYPES).toHaveLength(7);
    ORDER_PILOT_NOTIFICATION_TYPES.forEach((type) =>
      expect(isKnownNotificationType(type)).toBe(true),
    );
    // (ePpLHPX2) kuryerga biriktirish turi ham katalogda
    expect(isKnownNotificationType(ORDER_COURIER_ASSIGNED_TYPE)).toBe(true);
  });
});

describe('buildOrderNotificationPayload', () => {
  it('ePpLHPX2 TC1 / OA16fdSq TC6: sotildi — market egasi (+ operator) qabul qiluvchi, link /orders/edit/{id}, group_key order:{id}:status', () => {
    const payload = buildOrderNotificationPayload(
      'order.sold',
      order(),
      Order_status.WAITING,
    );
    expect(payload).toEqual(
      expect.objectContaining({
        type: 'order.sold',
        category: 'order',
        recipient_ids: ['5', '9'],
        link: '/orders/edit/81',
        group_key: 'order:81:status',
        channels: ['in_app', 'realtime'],
        data: expect.objectContaining({
          order_id: '81',
          order_number: 'EL-100081',
          status: Order_status.SOLD,
          from_status: Order_status.WAITING,
        }),
      }),
    );
    expect(payload).not.toHaveProperty('telegram');
  });

  it('TC10: in_app body’da mijoz telefoni va manzili YO‘Q (faqat raqam + holat)', () => {
    const payload = buildOrderNotificationPayload(
      'order.cancelled',
      order({
        status: Order_status.CANCELLED,
        address: 'Chilonzor 5-uy',
        comment: 'Mijoz +998 90 123 45 67 javob bermadi',
      }),
      Order_status.WAITING,
    )!;
    expect(payload.body).toBe('Buyurtma #EL-100081 bekor qilindi.');
    for (const text of [
      payload.title,
      payload.body,
      JSON.stringify(payload.data),
    ]) {
      expect(text).not.toContain('Chilonzor');
      expect(text).not.toContain('123 45 67');
    }
  });

  it('TC8: bekor qilish — market "cancel" Telegram guruhiga HTML matn bilan', () => {
    const payload = buildOrderNotificationPayload(
      'order.cancelled',
      order({
        status: Order_status.CANCELLED,
        return_reason: 'CUSTOMER_REFUSED',
      }),
      Order_status.WAITING,
    )!;
    expect(payload.channels).toEqual(['in_app', 'realtime', 'telegram']);
    expect(payload.telegram).toEqual({
      market_id: '5',
      group_type: Group_type.CANCEL,
      text: expect.stringContaining('<b>Buyurtma bekor qilindi</b>'),
    });
    expect(payload.telegram!.text).toContain('<b>Narxi:</b> 150 000 so');
    // CancelReason kodi o'zbekcha yorliq bilan (BeePost matni kabi o'qiladi).
    expect(payload.telegram!.text).toContain('<b>Sabab:</b> Mijoz rad etdi');
  });

  it('TC9: `<`, `&`, `*` belgilari HTML-escape — Telegram "can’t parse entities" bilan rad etmaydi', () => {
    const text = buildOrderTelegramText(
      'order.cancelled',
      order({
        address: 'Ko‘cha <b>&</b> *5*',
        comment: 'Ism: A&B <Ali> *VIP*',
        operator: 'Op <1> & *2*',
      }),
      {
        customer: { name: '<Ali> & *Vali*', phone_number: '+998901234567' },
        courier: { name: 'Kuryer <K&K>', phone_number: '+998907654321' },
        items: [{ name: 'Telefon <Pro> & *Max*', quantity: 2 }],
      },
    );
    expect(text).toContain(
      '<b>Manzil:</b> Ko‘cha &lt;b&gt;&amp;&lt;/b&gt; *5*',
    );
    expect(text).toContain('<b>Izoh:</b> Ism: A&amp;B &lt;Ali&gt; *VIP*');
    expect(text).toContain('<b>Mijoz:</b> &lt;Ali&gt; &amp; *Vali*');
    expect(text).toContain('<b>Kuryer:</b> Kuryer &lt;K&amp;K&gt;');
    expect(text).toContain('<b>Operator:</b> Op &lt;1&gt; &amp; *2*');
    expect(text).toContain('1. Telefon &lt;Pro&gt; &amp; *Max* — 2 dona');
    // escape qilinmagan `&` (entity'dan tashqari) qolmagan
    expect(text.replace(/&(amp|lt|gt|quot);/g, '')).not.toContain('&');
    // faqat bizning teglarimiz qoladi
    const tags = text.match(/<\/?[a-z]+>/g) ?? [];
    expect(new Set(tags)).toEqual(new Set(['<b>', '</b>']));
  });

  it('operator bo‘lmasa — faqat market; market ham yo‘q — payload yo‘q', () => {
    expect(
      buildOrderNotificationPayload(
        'order.sold',
        order({ operator_id: null }),
        null,
      )?.recipient_ids,
    ).toEqual(['5']);
    expect(
      buildOrderNotificationPayload(
        'order.sold',
        order({ operator_id: '5' }),
        null,
      )?.recipient_ids,
    ).toEqual(['5']);
    expect(
      buildOrderNotificationPayload(
        'order.sold',
        order({ market_id: null, operator_id: null }),
        null,
      ),
    ).toBeNull();
  });
});

/**
 * OA16fdSq TC6/TC15 — bildirishnoma havolasi frontend «Buyurtma tafsiloti»
 * marshrutiga olib boradi. Elchi-Frontend `src/app/lib/routes.tsx`:
 * `orders` → `edit/:orderId` (NewOrderUpdate); `/orders/:id` marshruti YO'Q
 * (faqat eski havolalar uchun redirect) — 2026-10-09 prod testida 404 edi.
 */
const FE_ORDER_DETAIL_ROUTE = /^\/orders\/edit\/(\d+)$/;

describe('OA16fdSq — link /orders/edit/{id} (frontend «Buyurtma tafsiloti», 404 emas)', () => {
  const fromStatus: Record<string, Order_status | null> = {
    'order.created': null,
    'order.accepted': Order_status.NEW,
    'order.on_way': Order_status.RECEIVED,
    'order.sold': Order_status.WAITING,
    'order.cancelled': Order_status.WAITING,
    'order.returned': Order_status.CANCELLED,
    'order.not_accepted': Order_status.ON_THE_ROAD,
  };

  it.each(ORDER_PILOT_NOTIFICATION_TYPES.map((type) => [type]))(
    '%s — link /orders/edit/{id}, data.order_id bilan bir xil buyurtma',
    (type) => {
      const payload = buildOrderNotificationPayload(
        type,
        order({ id: '36', market_id: '37' }),
        fromStatus[type],
      )!;
      expect(payload.link).toBe('/orders/edit/36');
      expect(FE_ORDER_DETAIL_ROUTE.exec(payload.link)?.[1]).toBe(
        payload.data.order_id,
      );
      expect(payload.link).not.toMatch(/^\/orders\/\d+$/);
    },
  );

  it('order.assigned_to_courier — o‘sha marshrut', () => {
    const payload = buildCourierAssignedPayload(
      {
        id: '42',
        market_id: '37',
        courier_id: '26',
        status: Order_status.ON_THE_ROAD,
      } as any,
      null,
    )!;
    expect(payload.link).toBe('/orders/edit/42');
    expect(payload.link).toMatch(FE_ORDER_DETAIL_ROUTE);
  });

  it('orderDetailLink — yagona manba; raqamdan boshqa narsa yo‘lni buzmaydi', () => {
    expect(orderDetailLink('81')).toBe('/orders/edit/81');
    expect(orderDetailLink(81)).toBe('/orders/edit/81');
    expect(orderDetailLink('1/../x?y')).toBe('/orders/edit/1%2F..%2Fx%3Fy');
  });
});

describe('OA16fdSq TC8/TC9 — Telegram matni Telegram HTML tekshiruvidan o‘tadi', () => {
  const ADVERSARIAL = [
    '<Ali> & *Vali*',
    'Ali & Co <b>VIP</b>',
    '</b><i>*_`[x](tg://y)`',
    '&lt; allaqachon & escape',
    '"Qo‘chqor" > Ali',
    '*Vali',
  ];

  it.each(ADVERSARIAL.map((name) => [name]))(
    'mijoz ismi %p — matn yaroqli, ism o‘zgarmay ko‘rinadi',
    (name) => {
      const payload = buildOrderNotificationPayload(
        'order.cancelled',
        order({
          status: Order_status.CANCELLED,
          address: `${name} ko‘chasi`,
          comment: `Izoh: ${name}`,
          operator: name,
          return_reason: 'CUSTOMER_REFUSED',
        }),
        Order_status.WAITING,
        {
          telegram: {
            customer: { name, phone_number: '+998901234567' },
            courier: { name, phone_number: '+998907654321' },
            region_name: name,
            district_name: name,
            items: [{ name, quantity: 1 }],
          },
        },
      )!;
      const check = validateTelegramHtml(payload.telegram!.text);
      expect(check).toEqual(expect.objectContaining({ ok: true }));
      const plain = check.ok ? check.plain : '';
      expect(plain).toContain(`Mijoz: ${name}`);
      expect(plain).toContain(`Izoh: Izoh: ${name}`);
      expect(plain).toContain(`Operator: ${name}`);
      expect(plain).toContain(`1. ${name} — 1 dona`);
    },
  );

  it('uzun ism emoji yarmida kesilmaydi (yolg‘iz surrogate — yaroqsiz UTF-8)', () => {
    // 118 ta "A" + 😀 (2 ta UTF-16 birligi): 120 chegarada 119-belgi surrogate
    // juftligining birinchi yarmi bo'lardi.
    const name = `${'A'.repeat(118)}😀 oxiri`;
    const text = buildOrderTelegramText('order.cancelled', order(), {
      customer: { name, phone_number: '+998901234567' },
    });
    const check = validateTelegramHtml(text);
    expect(check).toEqual(expect.objectContaining({ ok: true }));
    expect(text).toContain(`<b>Mijoz:</b> ${'A'.repeat(118)}…`);
  });

  it('tasodifiy maxsus belgilar (300 ta) — har doim yaroqli HTML, chegaradan oshmaydi', () => {
    const alphabet = [
      '<',
      '>',
      '&',
      '*',
      '_',
      '`',
      '"',
      "'",
      'a',
      'Я',
      'ў',
      '😀',
      '👨‍💼',
      '\n',
      ' ',
      '&amp;',
      '</b>',
      '<b>',
      '&#',
      ';',
      '<a href="x">',
    ];
    let seed = 20261025;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const word = (max: number) =>
      Array.from(
        { length: 1 + Math.floor(random() * max) },
        () => alphabet[Math.floor(random() * alphabet.length)],
      ).join('');
    for (let run = 0; run < 300; run += 1) {
      const text = buildOrderTelegramText(
        'order.cancelled',
        order({ address: word(400), comment: word(900), operator: word(150) }),
        {
          customer: { name: word(150), phone_number: word(50) },
          courier: { name: word(150), phone_number: word(50) },
          region_name: word(50),
          district_name: word(50),
          items: Array.from({ length: Math.floor(random() * 25) }, () => ({
            name: word(150),
            quantity: 1 + Math.floor(random() * 3),
          })),
        },
      );
      const check = validateTelegramHtml(text);
      if (!check.ok) throw new Error(`${check.description}\n${text}`);
      expect(text.length).toBeLessThanOrEqual(4000);
    }
  });
});

/** Haqiqiy OutboxService + xotiradagi tranzaksiya: commit/rollback simulyatsiyasi. */
function makeTransaction() {
  const committed: any[] = [];
  let pending: any[] = [];
  const queryRunner: any = { isTransactionActive: true };
  const outboxRepo = {
    create: jest.fn((value: any) => ({ ...value })),
    save: jest.fn((value: any) => {
      pending.push(value);
      return Promise.resolve({ id: String(pending.length), ...value });
    }),
  };
  const orderRepo = { findOne: jest.fn().mockResolvedValue(order()) };
  const manager: any = {
    queryRunner,
    getRepository: jest.fn((entity: { name: string }) =>
      entity.name === 'OutboxEvent' ? outboxRepo : orderRepo,
    ),
  };
  queryRunner.manager = manager;
  return {
    manager,
    orderRepo,
    committed,
    commit: () => {
      committed.push(...pending);
      pending = [];
    },
    rollback: () => {
      pending = [];
    },
  };
}

describe('OrderCustodyService.createTrackingEvent → outbox (OA16fdSq TC3/TC4)', () => {
  const defaultOutboxRepo = { create: jest.fn(), save: jest.fn() };
  const makeCustody = () => {
    const outbox = new OutboxService(defaultOutboxRepo as never);
    const notifier = new OrderNotificationService(outbox, {
      findOne: jest.fn(),
    } as never);
    return new OrderCustodyService(
      { create: jest.fn((v) => v), save: jest.fn() } as never,
      {} as never,
      notifier,
    );
  };

  const trackingRepoIn = (tx: ReturnType<typeof makeTransaction>) => ({
    manager: tx.manager,
    create: jest.fn((value: any) => value),
    save: jest.fn().mockResolvedValue(undefined),
  });

  it('TC3: sotuv commit bo‘lsa outbox_events da target=NOTIFICATION, pattern=notification.dispatch qatori (o‘sha tranzaksiyada)', async () => {
    const tx = makeTransaction();
    await makeCustody().createTrackingEvent(
      {
        order_id: '81',
        from_status: Order_status.WAITING,
        to_status: Order_status.SOLD,
        changed_by: '55',
        changed_by_role: 'courier',
      },
      trackingRepoIn(tx) as never,
    );
    tx.commit();

    expect(tx.committed).toHaveLength(1);
    expect(tx.committed[0]).toEqual(
      expect.objectContaining({
        target: 'NOTIFICATION',
        pattern: 'notification.dispatch',
        status: 'pending',
        payload: expect.objectContaining({
          type: 'order.sold',
          recipient_ids: ['5', '9'],
          request_id: expect.any(String),
        }),
      }),
    );
    // tranzaksiya menejeri orqali (default repo emas)
    expect(defaultOutboxRepo.save).not.toHaveBeenCalled();
    expect(tx.orderRepo.findOne).toHaveBeenCalledWith({ where: { id: '81' } });
  });

  it('TC7: ketma-ket 3 ta holat o‘zgarishi (qabul → yo‘lda → sotildi) — 3 ta outbox qatori, hammasida BITTA group_key order:{id}:status', async () => {
    const tx = makeTransaction();
    const custody = makeCustody();
    const chain: Array<[Order_status, Order_status]> = [
      [Order_status.NEW, Order_status.RECEIVED],
      [Order_status.RECEIVED, Order_status.ON_THE_ROAD],
      // ichki o'tish — bildirishnoma yo'q (zanjir haqiqiy ko'rinishda)
      [Order_status.ON_THE_ROAD, Order_status.WAITING],
      [Order_status.WAITING, Order_status.SOLD],
    ];
    for (const [from_status, to_status] of chain) {
      tx.orderRepo.findOne.mockResolvedValueOnce(order({ status: to_status }));
      await custody.createTrackingEvent(
        {
          order_id: '81',
          from_status,
          to_status,
          changed_by: '55',
          changed_by_role: 'courier',
        },
        trackingRepoIn(tx) as never,
      );
    }
    tx.commit();

    expect(tx.committed.map((row) => row.payload.type)).toEqual([
      'order.accepted',
      'order.on_way',
      'order.sold',
    ]);
    expect(new Set(tx.committed.map((row) => row.payload.group_key))).toEqual(
      new Set(['order:81:status']),
    );
    // inboxda 1 qator qolishi — notification-inbox.group-key.spec.ts
  });

  it('TC4: biznes tranzaksiyasi rollback bo‘lsa outbox qatori HAM yo‘q (bildirishnoma ketmaydi)', async () => {
    const tx = makeTransaction();
    await makeCustody().createTrackingEvent(
      {
        order_id: '81',
        from_status: Order_status.WAITING,
        to_status: Order_status.SOLD,
        changed_by: '55',
        changed_by_role: 'courier',
      },
      trackingRepoIn(tx) as never,
    );
    tx.rollback();
    expect(tx.committed).toHaveLength(0);
    expect(defaultOutboxRepo.save).not.toHaveBeenCalled();
  });

  it('izoh / ichki o‘tish — outbox’ga hech narsa yozilmaydi, buyurtma o‘qilmaydi', async () => {
    const tx = makeTransaction();
    await makeCustody().createTrackingEvent(
      {
        order_id: '81',
        from_status: Order_status.SOLD,
        to_status: Order_status.PAID,
        changed_by: 'system',
        changed_by_role: 'system',
      },
      trackingRepoIn(tx) as never,
    );
    tx.commit();
    expect(tx.committed).toHaveLength(0);
    expect(tx.orderRepo.findOne).not.toHaveBeenCalled();
  });

  it('notifier ulanmagan (eski 2-argumentli konstruktor) — kuzatuv avvalgidek', async () => {
    const save = jest.fn();
    const custody = new OrderCustodyService(
      { create: jest.fn((v) => v), save } as never,
      {} as never,
    );
    await custody.createTrackingEvent({
      order_id: '81',
      from_status: Order_status.WAITING,
      to_status: Order_status.SOLD,
      changed_by: '1',
      changed_by_role: 'admin',
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('fail-open (ePpLHPX2 TC3)', () => {
  it('payload qurishda kutilmagan xato — tranzaksiya ichida ham biznes amali YIQILMAYDI', async () => {
    const tx = makeTransaction();
    tx.orderRepo.findOne.mockResolvedValue({
      ...order(),
      get market_id(): string {
        throw new Error('bug');
      },
    });
    const outbox = { enqueue: jest.fn() };
    const notifier = new OrderNotificationService(outbox as never, {} as never);
    await expect(
      notifier.onStatusChange(
        {
          order_id: '81',
          from_status: Order_status.WAITING,
          to_status: Order_status.SOLD,
        },
        tx.manager,
      ),
    ).resolves.toBeUndefined();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('tranzaksiyasiz yo‘lda outbox xatosi — yutiladi (WARN), chaqiruvchi davom etadi', async () => {
    const outbox = { enqueue: jest.fn().mockRejectedValue(new Error('db')) };
    const notifier = new OrderNotificationService(
      outbox as never,
      {
        findOne: jest.fn().mockResolvedValue(order()),
      } as never,
    );
    await expect(
      notifier.onStatusChange({
        order_id: '81',
        from_status: Order_status.RECEIVED,
        to_status: Order_status.ON_THE_ROAD,
      }),
    ).resolves.toBeUndefined();
  });

  it('TC3: notification-service o‘chiq — OutboxPublisher bildirishnomani kutmaydi, PUL hodisasi o‘sha tick’da baribir ketadi', async () => {
    const events = [
      {
        id: '1',
        target: 'NOTIFICATION',
        pattern: 'notification.dispatch',
        payload: { request_id: 'n1' },
        status: 'pending',
        attempts: 0,
      },
      {
        id: '2',
        target: 'FINANCE',
        pattern: 'finance.cashbox.update_balance',
        payload: { request_id: 'f1' },
        status: 'pending',
        attempts: 0,
      },
    ];
    const outbox = {
      getDuePending: jest.fn().mockResolvedValue(events),
      markPublished: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const deadNotification = {
      send: jest.fn(() => throwError(() => new Error('no consumer'))),
      emit: jest.fn(() => throwError(() => new Error('broker down'))),
    };
    const finance = { send: jest.fn(() => of({ ok: true })) };
    const publisher = new OutboxPublisher(
      {} as ModuleRef,
      outbox as never,
      ['NOTIFICATION', 'FINANCE'],
      { fireAndForgetPatterns: ['notification.dispatch'] },
    );
    const internals = publisher as unknown as {
      clients: Map<string, unknown>;
      tick: () => Promise<void>;
    };
    internals.clients.set('NOTIFICATION', deadNotification);
    internals.clients.set('FINANCE', finance);

    await internals.tick();

    // bildirishnoma — RPC javobi kutilmaydi (emit), yiqilsa qayta urinish
    expect(deadNotification.send).not.toHaveBeenCalled();
    expect(deadNotification.emit).toHaveBeenCalledWith(
      { cmd: 'notification.dispatch' },
      { request_id: 'n1' },
    );
    expect(outbox.markFailed).toHaveBeenCalledWith(
      '1',
      'broker down',
      expect.any(Number),
      expect.any(Number),
    );
    // pul hodisasi — avvalgidek `send`, o'sha tick'da published
    expect(finance.send).toHaveBeenCalledTimes(1);
    expect(outbox.markPublished).toHaveBeenCalledWith('2');
  });

  it('fireAndForgetPatterns sukuti [] — boshqa servislarda xulq o‘zgarmagan (hammasi `send`)', async () => {
    const outbox = {
      getDuePending: jest.fn().mockResolvedValue([
        {
          id: '1',
          target: 'NOTIFICATION',
          pattern: 'notification.push.deliver',
          payload: {},
          status: 'pending',
          attempts: 0,
        },
      ]),
      markPublished: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn(),
    };
    const client = { send: jest.fn(() => of(true)), emit: jest.fn() };
    const publisher = new OutboxPublisher(
      {} as ModuleRef,
      outbox as never,
      ['NOTIFICATION'],
      {},
    );
    (publisher as any).clients.set('NOTIFICATION', client);
    await (publisher as any).tick();
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.emit).not.toHaveBeenCalled();
    expect(outbox.markPublished).toHaveBeenCalledWith('1');
  });
});

describe('ePpLHPX2 TC1 / OA16fdSq TC6: updateFull(SOLD) — sotilgan buyurtma uchun dispatch outbox’da (market egasi qabul qiluvchi)', () => {
  it('tranzaksiya menejeri orqali, commit bilan; notification RMQ mijozi umuman chaqirilmaydi', async () => {
    const baseOrder = order({
      status: Order_status.WAITING,
      operator_id: null,
    });
    const orderRepo = {
      save: jest.fn().mockResolvedValue(undefined),
      findOne: jest
        .fn()
        .mockResolvedValue({ ...baseOrder, status: Order_status.SOLD }),
    };
    const trackingRepo: any = {
      create: jest.fn((v: any) => v),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const outboxRepo = {
      create: jest.fn((v: any) => v),
      save: jest.fn((v: any) => Promise.resolve(v)),
    };
    const queryRunner: any = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      isTransactionActive: true,
    };
    const manager: any = {
      queryRunner,
      getRepository: jest.fn((entity: { name: string }) =>
        entity.name === 'Order'
          ? orderRepo
          : entity.name === 'OutboxEvent'
            ? outboxRepo
            : trackingRepo,
      ),
    };
    queryRunner.manager = manager;
    trackingRepo.manager = manager;

    const businessOutbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const notificationOutbox = new OutboxService({} as never);
    const custody = new OrderCustodyService(
      trackingRepo,
      {} as never,
      new OrderNotificationService(notificationOutbox, orderRepo as never),
    );
    const notificationClient = {
      send: jest.fn(() => {
        throw new Error('notification-service o‘chiq');
      }),
      emit: jest.fn(() => {
        throw new Error('notification-service o‘chiq');
      }),
    };
    const nullClient = { send: jest.fn() };
    const lifecycle = new OrderLifecycleService(
      { createQueryRunner: jest.fn(() => queryRunner) } as never,
      orderRepo as never,
      {} as never,
      trackingRepo,
      {} as never,
      {} as never,
      {} as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      nullClient as never,
      nullClient as never,
      nullClient as never,
      nullClient as never,
      nullClient as never,
      nullClient as never,
      businessOutbox as never,
      {
        log: jest.fn().mockResolvedValue(undefined),
        logChange: jest.fn().mockResolvedValue(undefined),
      } as never,
      {} as never,
      custody,
    );
    jest
      .spyOn(lifecycle, 'findById')
      .mockResolvedValueOnce({ ...baseOrder, items: [] } as never)
      .mockResolvedValue({
        ...baseOrder,
        status: Order_status.SOLD,
        items: [],
      } as never);
    jest
      .spyOn<any, any>(lifecycle as any, 'syncOrderToSearch')
      .mockResolvedValue(undefined);

    await lifecycle.updateFull(
      '81',
      { status: Order_status.SOLD },
      { id: '55', roles: ['courier'], note: 'sold by courier' },
    );

    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(outboxRepo.save).toHaveBeenCalledTimes(1);
    expect(outboxRepo.save.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        target: NOTIFICATION_OUTBOX_TARGET,
        pattern: NOTIFICATION_DISPATCH_PATTERN,
        payload: expect.objectContaining({
          type: 'order.sold',
          recipient_ids: ['5'],
          link: '/orders/edit/81',
        }),
      }),
    );
    expect(notificationClient.send).not.toHaveBeenCalled();
    expect(notificationClient.emit).not.toHaveBeenCalled();
  });
});

describe('TC5: order-service kodida notification.dispatch uchun to‘g‘ridan-to‘g‘ri rmqSend YO‘Q', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  it('grep bo‘sh: notification.dispatch faqat outbox orqali, NOTIFICATION mijozi inject qilinmaydi', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
    )) {
      // izohlar olib tashlanadi — ular "rmqSend TAQIQ" deb yozadi, kod emas.
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (
        /rmqSend(?:<[^>]*>)?\([^;]*notification\.dispatch/s.test(src) ||
        /\.(send|emit)\(\s*\{\s*cmd:\s*['"]notification\./.test(src) ||
        /@Inject\(\s*['"]NOTIFICATION['"]\s*\)/.test(src)
      ) {
        offenders.push(file.replace(SRC, ''));
      }
    }
    expect(offenders).toEqual([]);
  });
});
