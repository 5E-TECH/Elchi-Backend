import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import {
  Group_type,
  NotificationChannel,
  Order_status,
  findNotificationType,
} from '@app/common';
import { validateTelegramHtml } from '@app/common/notification/telegram-html-kit-spec';
import {
  OrderNotificationService,
  buildOrderNotificationPayload,
  buildOrderTelegramText,
  originalTotalPriceOf,
  refineOrderNotificationType,
} from './order-notification.service';

/**
 * (ega 2026-11-07, BeePost'dagidek) «Buyurtma arzonroq sotildi».
 *
 * Kuryer/menejer mahsulot sonini kamaytirmasdan faqat narxni tushirib sotsa
 * (500 000 → 350 000), `partly_sell_original_total_price` to'ldiriladi va
 * oddiy `order.sold` O'RNIGA `order.sold_cheaper` ketadi: in_app + realtime +
 * market Telegram guruhiga (eski → yangi narx bilan). Ega qarori: «Aha
 * yuborilsin».
 */

type Row = Record<string, unknown>;

const order = (overrides: Row = {}): Row => ({
  id: '81',
  market_id: '5',
  operator_id: '9',
  operator: 'Operator Ali',
  customer_id: '2',
  courier_id: '55',
  holder_courier_id: '55',
  region_id: '3',
  district_id: '31',
  status: Order_status.SOLD,
  total_price: 350000,
  partly_sell_original_total_price: 500000,
  address: "Ko'cha 5-uy",
  comment: 'Buyurtma arzonroqqa sotildi!',
  return_reason: null,
  createdAt: new Date('2026-11-07T09:05:00.000Z'),
  ...overrides,
});

type PayloadOrder = Parameters<typeof buildOrderNotificationPayload>[1];
const asPayloadOrder = (row: Row) => row as unknown as PayloadOrder;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('katalog: order.sold_cheaper', () => {
  it('Telegram kanali bilan (order.sold esa Telegram’siz qoladi)', () => {
    const cheaper = findNotificationType('order.sold_cheaper');
    expect(cheaper?.label_uz).toBe('Buyurtma arzonroq sotildi');
    expect(cheaper?.default_channels).toEqual([
      NotificationChannel.IN_APP,
      NotificationChannel.REALTIME,
      NotificationChannel.TELEGRAM,
    ]);
    expect(cheaper?.group_key_pattern).toBe('order:{{order_id}}:status');
    expect(findNotificationType('order.sold')?.default_channels).not.toContain(
      NotificationChannel.TELEGRAM,
    );
  });
});

describe('refineOrderNotificationType — order.sold → order.sold_cheaper', () => {
  it.each([
    ['500000 (son)', 500000, 'order.sold_cheaper'],
    ['"500000.00" (numeric satr)', '500000.00', 'order.sold_cheaper'],
    ['0 (0 so‘mlik asl summa ham belgi)', 0, 'order.sold_cheaper'],
    ['null — narx tushirilmagan', null, 'order.sold'],
    ['undefined — eski qator', undefined, 'order.sold'],
    ['yaroqsiz qiymat', 'abc', 'order.sold'],
  ])('ustun %s → %s', (_label, value, expected) => {
    expect(
      refineOrderNotificationType('order.sold', {
        partly_sell_original_total_price: value as number | null,
      }),
    ).toBe(expected);
  });

  it('boshqa turlar ustun bo‘lsa ham o‘zgarmaydi', () => {
    for (const type of [
      'order.created',
      'order.cancelled',
      'order.returned',
      'order.on_way',
    ] as const) {
      expect(
        refineOrderNotificationType(type, {
          partly_sell_original_total_price: 500000,
        }),
      ).toBe(type);
    }
  });

  it('originalTotalPriceOf: numeric satrni songa aylantiradi', () => {
    expect(
      originalTotalPriceOf({ partly_sell_original_total_price: 500000 }),
    ).toBe(500000);
    expect(
      originalTotalPriceOf({
        partly_sell_original_total_price: '120000.50' as unknown as number,
      }),
    ).toBe(120000.5);
    expect(originalTotalPriceOf({})).toBeNull();
  });
});

describe('buildOrderNotificationPayload — order.sold_cheaper', () => {
  it('⭐ in_app tanasi summasiz (logist ham oladi); market CREATE guruhiga Telegram', () => {
    const payload = buildOrderNotificationPayload(
      'order.sold_cheaper',
      asPayloadOrder(order()),
      Order_status.WAITING,
    )!;
    expect(payload.type).toBe('order.sold_cheaper');
    expect(payload.title).toBe('Buyurtma arzonroq sotildi');
    expect(payload.body).toBe('Buyurtma #EL-100081 arzonroq sotildi.');
    expect(payload.data).toEqual({
      order_id: '81',
      order_number: 'EL-100081',
      status: Order_status.SOLD,
      from_status: Order_status.WAITING,
    });
    expect(payload.channels).toEqual([
      NotificationChannel.IN_APP,
      NotificationChannel.REALTIME,
      NotificationChannel.TELEGRAM,
    ]);
    expect(payload.telegram).toEqual(
      expect.objectContaining({
        market_id: '5',
        group_type: Group_type.CREATE,
      }),
    );
    expect(payload.group_key).toBe('order:81:status');
    expect(payload.recipient_ids).toEqual(['5', '9']);
    // in_app'da PII yo'q
    expect(payload.body).not.toMatch(/Ko'cha|\+998/);
  });

  it('4BftLLnc: viloyat logisti ham qabul qiluvchi — umumiy tana va data’da pul YO‘Q', () => {
    const payload = buildOrderNotificationPayload(
      'order.sold_cheaper',
      asPayloadOrder(order()),
      Order_status.WAITING,
      { logist_id: '77' },
    )!;
    expect(payload.recipient_ids).toEqual(['5', '9', '77']);
    const shared = JSON.stringify({ body: payload.body, data: payload.data });
    expect(shared).not.toMatch(/500\s?000|350\s?000|150\s?000|price|so'm/);
    // Narxlar faqat market Telegram guruhi matnida.
    expect(payload.telegram?.text).toContain("500 000 so'm");
  });

  it('avval qaytarish boshlangan buyurtma: Telegram’da eski «Sabab» chiqmaydi', () => {
    const text = buildOrderTelegramText(
      'order.sold_cheaper',
      asPayloadOrder(order({ return_reason: 'CUSTOMER_REFUSED' })),
    );
    expect(text).not.toContain('Sabab');
    // Bekor qilish xabarida esa sabab avvalgidek.
    const cancelled = buildOrderTelegramText(
      'order.cancelled',
      asPayloadOrder(
        order({
          status: Order_status.CANCELLED,
          return_reason: 'CUSTOMER_REFUSED',
        }),
      ),
    );
    expect(cancelled).toContain('Sabab');
  });

  it('Telegram matni: asl narx, sotilgan narx, farq — HTML yaroqli', () => {
    const text = buildOrderTelegramText(
      'order.sold_cheaper',
      asPayloadOrder(order()),
      {
        customer: { name: 'Ali <VIP>', phone_number: '+998901112233' },
        courier: { name: 'Vali', phone_number: '+998907778899' },
        items: [{ name: 'Telefon', quantity: 1 }],
      },
    );
    const check = validateTelegramHtml(text);
    expect(check).toEqual(expect.objectContaining({ ok: true }));
    const plain = check.ok ? check.plain : '';
    expect(plain).toContain('⚠️ Buyurtma arzonroq sotildi');
    expect(plain).toContain("Asl narxi: 500 000 so'm");
    expect(plain).toContain("Sotilgan narxi: 350 000 so'm");
    expect(plain).toContain("Farqi: −150 000 so'm");
    expect(plain).toContain('Telefon — 1 dona');
    expect(plain).toContain('Mijoz: Ali <VIP>');
    expect(plain).toContain('Kuryer: Vali');
    expect(plain).toContain('Izoh: Buyurtma arzonroqqa sotildi!');
    // Oddiy «Narxi:» qatori bu turda chiqmaydi (ikki narx chalkashmasin).
    expect(plain).not.toMatch(/(^|\n)💰 Narxi:/);
  });

  it('0 so‘mga sotilgan — farq to‘liq summa', () => {
    const text = buildOrderTelegramText(
      'order.sold_cheaper',
      asPayloadOrder(order({ total_price: 0 })),
    );
    const check = validateTelegramHtml(text);
    const plain = check.ok ? check.plain : '';
    expect(plain).toContain("Sotilgan narxi: 0 so'm");
    expect(plain).toContain("Farqi: −500 000 so'm");
  });

  it('oddiy order.sold matni o‘zgarmagan (bitta «Narxi» qatori)', () => {
    const text = buildOrderTelegramText(
      'order.sold',
      asPayloadOrder(
        order({ total_price: 150000, partly_sell_original_total_price: null }),
      ),
    );
    const plain = (() => {
      const check = validateTelegramHtml(text);
      return check.ok ? check.plain : '';
    })();
    expect(plain).toContain("Narxi: 150 000 so'm");
    expect(plain).not.toContain('Asl narxi');
  });

  it('marketi yo‘q buyurtma — Telegram kanali olib tashlanadi', () => {
    const payload = buildOrderNotificationPayload(
      'order.sold_cheaper',
      asPayloadOrder(order({ market_id: null })),
      Order_status.WAITING,
    )!;
    expect(payload.channels).not.toContain(NotificationChannel.TELEGRAM);
    expect(payload.telegram).toBeUndefined();
  });
});

/** Minimal servis: outbox + repo + RPC mijozlari (enrichment spec'dagidek). */
function makeService(row: Row) {
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const orderRepo = {
    findOne: jest.fn((options: { relations?: string[] }): Promise<Row> =>
      Promise.resolve(
        options.relations?.includes('items')
          ? {
              ...row,
              items: [
                { product_id: '700', product_name: 'Telefon', quantity: 1 },
              ],
            }
          : { ...row },
      ),
    ),
  };
  const client = (reply: unknown) => ({
    send: jest.fn(() => of(reply)),
    emit: jest.fn(),
  });
  const service = new OrderNotificationService(
    outbox as never,
    orderRepo as never,
    client({ statusCode: 200, data: [] }) as never,
    client({
      success: true,
      data: [{ id: '2', name: 'Ali', phone_number: '+998901112233' }],
    }) as never,
    client({ data: [] }) as never,
  );
  const lastPayload = (): Row | undefined => {
    const calls = outbox.enqueue.mock.calls as unknown[][];
    return calls[calls.length - 1]?.[2] as Row | undefined;
  };
  return { service, outbox, orderRepo, lastPayload };
}

const SOLD = {
  order_id: '81',
  from_status: Order_status.WAITING,
  to_status: Order_status.SOLD,
};

describe('onStatusChange — WAITING → SOLD', () => {
  it('⭐ narx tushirilgan: BITTA xabar, order.sold_cheaper, mahsulotlar bilan Telegram', async () => {
    const w = makeService(order());
    await w.service.onStatusChange(SOLD);
    expect(w.outbox.enqueue).toHaveBeenCalledTimes(1);
    const payload = w.lastPayload()!;
    expect(payload.type).toBe('order.sold_cheaper');
    const telegram = payload.telegram as { text: string; group_type: string };
    expect(telegram.group_type).toBe(Group_type.CREATE);
    expect(telegram.text).toContain('Telefon');
    expect(telegram.text).toContain("500 000 so'm");
    // 1-o'qish mahsulotsiz (oddiy sotuv), 2-o'qish — faqat arzonroq sotuvda.
    expect(w.orderRepo.findOne).toHaveBeenCalledTimes(2);
    expect(w.orderRepo.findOne.mock.calls[1][0]).toEqual(
      expect.objectContaining({ relations: ['items'] }),
    );
  });

  it('oddiy sotuv: order.sold, Telegram yo‘q, bitta o‘qish (regressiya)', async () => {
    const w = makeService(
      order({ total_price: 150000, partly_sell_original_total_price: null }),
    );
    await w.service.onStatusChange(SOLD);
    const payload = w.lastPayload()!;
    expect(payload.type).toBe('order.sold');
    expect(payload.telegram).toBeUndefined();
    expect(payload.channels).not.toContain(NotificationChannel.TELEGRAM);
    expect(w.orderRepo.findOne).toHaveBeenCalledTimes(1);
  });

  it.each([Order_status.PAID, Order_status.PARTLY_PAID])(
    'WAITING → %s (oldindan to‘langan) ham arzonroq sotildi',
    async (to) => {
      const w = makeService(order({ status: to }));
      await w.service.onStatusChange({ ...SOLD, to_status: to });
      expect(w.lastPayload()!.type).toBe('order.sold_cheaper');
    },
  );

  it('SOLD → PAID (marketga to‘lov) — ustun bo‘lsa ham xabar yo‘q', async () => {
    const w = makeService(order({ status: Order_status.PAID }));
    await w.service.onStatusChange({
      order_id: '81',
      from_status: Order_status.SOLD,
      to_status: Order_status.PAID,
    });
    expect(w.outbox.enqueue).not.toHaveBeenCalled();
    expect(w.orderRepo.findOne).not.toHaveBeenCalled();
  });

  it('tranzaksiya ichida: outbox o‘sha manager bilan yoziladi', async () => {
    const w = makeService(order());
    const repo = { findOne: w.orderRepo.findOne };
    const manager = {
      getRepository: jest.fn(() => repo),
      queryRunner: { isTransactionActive: true },
    };
    await w.service.onStatusChange(SOLD, manager as never);
    expect(w.outbox.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ type: 'order.sold_cheaper' }),
      { manager },
    );
  });
});
