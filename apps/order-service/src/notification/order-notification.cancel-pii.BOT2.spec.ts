import { of, throwError } from 'rxjs';
import { Order_status } from '@app/common';
import {
  OrderNotificationService,
  buildOrderTelegramText,
} from './order-notification.service';

/**
 * BOT-2 #1 — bekor guruhi xabari market `tg_group_show_customer_pii`
 * sozlamasiga bo'ysunadi (guruh kartasidagidek): o'chiq → ism yo'q,
 * telefon niqoblangan (`+998 90 *** ** 12`), manzil faqat tuman; yoqiq —
 * hozirgidek; sozlama o'qilmasa — niqoblanadi (fail-closed).
 */
const REGIONS = {
  data: [
    {
      id: '3',
      name: 'Toshkent sh.',
      logist_id: null,
      districts: [{ id: '31', name: 'Chilonzor' }],
    },
  ],
};

const order = {
  id: '81',
  market_id: '5',
  operator_id: null,
  operator: 'Operator Ali',
  customer_id: '2',
  courier_id: null,
  holder_courier_id: null,
  region_id: '3',
  district_id: '31',
  status: Order_status.CANCELLED,
  total_price: 150000,
  address: "Navoiy ko'chasi 12-uy",
  comment: 'Ikkinchi raqam +998931112299, oluvchi Dilnoza',
  return_reason: null,
  createdAt: new Date('2026-10-09T09:05:00.000Z'),
  items: [],
} as any;

function textFor(marketFlag: boolean | undefined | 'down') {
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const identity = {
    send: jest.fn((pattern: { cmd: string }) => {
      if (pattern.cmd === 'identity.customer.find_by_ids') {
        return of({
          data: [
            { id: '2', name: 'Aziz Karimov', phone_number: '+998901234512' },
          ],
        });
      }
      if (pattern.cmd === 'identity.user.find_by_id') {
        return marketFlag === 'down'
          ? throwError(() => new Error('identity down'))
          : of({ data: { id: '5', tg_group_show_customer_pii: marketFlag } });
      }
      return of({ data: [] });
    }),
  };
  const service = new OrderNotificationService(
    outbox as never,
    { findOne: jest.fn().mockResolvedValue(order) } as never,
    { send: jest.fn(() => of(REGIONS)) } as never,
    identity as never,
    { send: jest.fn(() => of({ data: [] })) } as never,
  );
  return service
    .onStatusChange({
      order_id: '81',
      from_status: Order_status.WAITING,
      to_status: Order_status.CANCELLED,
    })
    .then(() => {
      const payload = outbox.enqueue.mock.calls[0]?.[2];
      return String(payload?.telegram?.text ?? '');
    });
}

describe('BOT-2 #1 — bekor guruhi xabari va mijoz PII sozlamasi', () => {
  it('⭐ sozlama O`CHIQ: ism yo`q, telefon niqobli, manzil faqat tuman', async () => {
    const text = await textFor(false);
    expect(text).toContain('❌');
    expect(text).not.toContain('Aziz');
    expect(text).not.toContain('Mijoz:');
    expect(text).not.toContain('+998901234512');
    expect(text).toContain('📞 <b>Telefon:</b> +998 90 *** ** 12');
    expect(text).toContain('📍 <b>Manzil:</b> Chilonzor');
    expect(text).not.toContain('Navoiy');
    expect(text).not.toContain('Toshkent sh.');
    // Izoh (ikkinchi telefon, oluvchi ismi) ham chiqmaydi.
    expect(text).not.toContain('Izoh');
    expect(text).not.toContain('+998931112299');
    expect(text).not.toContain('Dilnoza');
  });

  it('sozlama YOQIQ (sukut) — hozirgidek to`liq', async () => {
    for (const flag of [true, undefined]) {
      const text = await textFor(flag);
      expect(text).toContain('👤 <b>Mijoz:</b> Aziz Karimov');
      expect(text).toContain('📞 <b>Telefon:</b> +998901234512');
      expect(text).toContain(
        "📍 <b>Manzil:</b> Toshkent sh., Chilonzor, Navoiy ko'chasi 12-uy",
      );
      expect(text).toContain('📝 <b>Izoh:</b> Ikkinchi raqam +998931112299');
    }
  });

  it('sozlamani o`qib bo`lmadi — fail-closed (niqoblanadi)', async () => {
    const text = await textFor('down');
    expect(text).not.toContain('+998901234512');
    expect(text).not.toContain('Navoiy');
  });

  it('buildOrderTelegramText: show_customer_pii berilmasa — eski xulq', () => {
    const text = buildOrderTelegramText('order.cancelled', order, {
      customer: { name: 'Aziz', phone_number: '+998901234512' },
      district_name: 'Chilonzor',
    });
    expect(text).toContain('👤 <b>Mijoz:</b> Aziz');
    expect(text).toContain('+998901234512');
  });
});
