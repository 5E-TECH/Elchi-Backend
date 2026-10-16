import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { Order_status } from '@app/common';
import { OrderCustodyService } from '../custody/order-custody.service';
import { Order } from '../entities/order.entity';
import {
  OrderNotificationService,
  TELEGRAM_ORDER_STATUS_PATTERN,
  maskPhoneForGroup,
} from './order-notification.service';
import { OrderTelegramCardPublisher } from './order-telegram-card.publisher';

/**
 * ysBqD9Nx / h9newLsd #5 (order-service tomoni):
 *  - HAR holat o'zgarishi (ichki WAITING ham) → `notification.telegram.order_status`
 *    outbox hodisasi, kuzatuv qatori bilan BITTA tranzaksiyada;
 *  - `order.telegram_card` — guruh kartasi ma'lumoti: tuman (to'liq manzil
 *    emas), mijoz PII market bayrog'iga qarab (sukut yoqiq, o'chiq — niqob).
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const makePublisher = () => {
  const outbox = { enqueue: jest.fn().mockResolvedValue({}) };
  const orderRepo = {
    findOne: jest.fn().mockResolvedValue({ id: '81', market_id: '5' }),
  };
  const manager = {
    queryRunner: { isTransactionActive: true },
    getRepository: jest.fn((entity: unknown) =>
      entity === Order ? orderRepo : null,
    ),
  };
  const publisher = new OrderTelegramCardPublisher(
    outbox as never,
    { findOne: jest.fn() } as never,
  );
  return { publisher, outbox, orderRepo, manager };
};

describe('ysBqD9Nx / h9newLsd #5 — holat o‘zgarishi → karta sinxron hodisasi', () => {
  it('⭐ ichki o‘tish (on the road → waiting) ham hodisa beradi, AYNI tranzaksiya menejerida; buyurtma o‘qilmaydi', async () => {
    const { publisher, outbox, orderRepo, manager } = makePublisher();
    await publisher.onStatusChange(
      {
        order_id: '81',
        from_status: Order_status.ON_THE_ROAD,
        to_status: Order_status.WAITING,
      },
      manager as never,
    );
    expect(outbox.enqueue).toHaveBeenCalledWith(
      'NOTIFICATION',
      TELEGRAM_ORDER_STATUS_PATTERN,
      {
        order_id: '81',
        from_status: Order_status.ON_THE_ROAD,
        to_status: Order_status.WAITING,
        market_id: null,
      },
      { manager },
    );
    expect(orderRepo.findOne).not.toHaveBeenCalled();
  });

  it('yaratilish — market_id o‘qiladi (guruhga birinchi karta)', async () => {
    const { publisher, outbox, orderRepo, manager } = makePublisher();
    await publisher.onStatusChange(
      { order_id: '81', from_status: null, to_status: Order_status.NEW },
      manager as never,
    );
    expect(orderRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: '81' } }),
    );
    expect(outbox.enqueue.mock.calls[0][2]).toEqual(
      expect.objectContaining({ market_id: '5', to_status: Order_status.NEW }),
    );
  });

  it('holat o‘zgarmagan — hodisa yo‘q; tranzaksiya ichida xato — chaqiruvchiga (rollback), tashqarida — yutiladi', async () => {
    const { publisher, outbox, manager } = makePublisher();
    await publisher.onStatusChange(
      {
        order_id: '81',
        from_status: Order_status.SOLD,
        to_status: Order_status.SOLD,
      },
      manager as never,
    );
    expect(outbox.enqueue).not.toHaveBeenCalled();
    outbox.enqueue.mockRejectedValue(new Error('db'));
    await expect(
      publisher.onStatusChange(
        {
          order_id: '81',
          from_status: Order_status.WAITING,
          to_status: Order_status.SOLD,
        },
        manager as never,
      ),
    ).rejects.toThrow('db');
    await expect(
      publisher.onStatusChange({
        order_id: '81',
        from_status: Order_status.WAITING,
        to_status: Order_status.SOLD,
      }),
    ).resolves.toBeUndefined();
  });

  it('custody: kuzatuv qatori → bildirishnoma VA karta hodisasi (ikkalasi shu repo menejeri bilan)', async () => {
    const notifier = { onStatusChange: jest.fn().mockResolvedValue(undefined) };
    const cards = { onStatusChange: jest.fn().mockResolvedValue(undefined) };
    const manager = { id: 'tx' };
    const custody = new OrderCustodyService(
      { create: jest.fn((v: unknown) => v), save: jest.fn(), manager } as never,
      {} as never,
      notifier as never,
      cards as never,
    );
    await custody.createTrackingEvent(
      {
        order_id: '81',
        from_status: Order_status.WAITING,
        to_status: Order_status.CANCELLED,
        changed_by: '1',
        changed_by_role: 'admin',
      },
      { create: jest.fn((v: unknown) => v), save: jest.fn(), manager } as never,
    );
    expect(cards.onStatusChange).toHaveBeenCalledWith(
      {
        order_id: '81',
        from_status: Order_status.WAITING,
        to_status: Order_status.CANCELLED,
      },
      manager,
    );
  });
});

describe('ysBqD9Nx #3 — order.telegram_card (guruh kartasi ma’lumoti)', () => {
  const order = {
    id: '81',
    market_id: '5',
    customer_id: '700',
    district_id: '12',
    region_id: '3',
    status: Order_status.NEW,
    total_price: '150000.00',
    operator: 'Operator Olim',
    address: 'Navoiy ko‘chasi 5-uy, 12-xonadon',
  };
  const make = (flag: unknown, identityUp = true) => {
    const identity = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (!identityUp) return throwError(() => new Error('down'));
        if (pattern.cmd === 'identity.customer.find_by_ids') {
          return of({
            data: [
              { id: '700', name: 'Ali Valiyev', phone_number: '+998901234512' },
            ],
          });
        }
        return of({ data: { id: '5', tg_group_show_customer_pii: flag } });
      }),
    };
    const logistics = {
      send: jest.fn(() =>
        of({
          data: [
            {
              id: '3',
              name: 'Andijon',
              logist_id: null,
              districts: [{ id: '12', name: 'Asaka' }],
            },
          ],
        }),
      ),
    };
    return new OrderNotificationService(
      { enqueue: jest.fn() } as never,
      { findOne: jest.fn().mockResolvedValue(order) } as never,
      logistics as never,
      identity as never,
      undefined,
    );
  };

  it('⭐ bayroq yoqiq (EGA QARORI sukut) — mijoz ismi va telefoni to‘liq; tuman bor, to‘liq manzil YO‘Q', async () => {
    const card = await make(true).telegramCardData('81');
    expect(card).toEqual({
      id: '81',
      order_number: 'EL-100081',
      market_id: '5',
      status: Order_status.NEW,
      total_price: 150000,
      district_name: 'Asaka',
      operator: 'Operator Olim',
      show_customer_pii: true,
      customer_name: 'Ali Valiyev',
      customer_phone: '+998901234512',
    });
    expect(JSON.stringify(card)).not.toContain('Navoiy');
  });

  it('⭐ bayroq o‘chiq — ism YO‘Q, telefon niqoblangan (+998 90 *** ** 12)', async () => {
    const card = await make(false).telegramCardData('81');
    expect(card).toEqual(
      expect.objectContaining({
        show_customer_pii: false,
        customer_name: null,
        customer_phone: '+998 90 *** ** 12',
      }),
    );
    expect(JSON.stringify(card)).not.toContain('1234512');
  });

  it('identity javob bermasa — FAIL-CLOSED (niqob), karta baribir', async () => {
    const card = await make(true, false).telegramCardData('81');
    expect(card).toEqual(
      expect.objectContaining({
        show_customer_pii: false,
        customer_name: null,
      }),
    );
  });

  it('maskPhoneForGroup', () => {
    expect(maskPhoneForGroup('+998 (90) 123-45-12')).toBe('+998 90 *** ** 12');
    expect(maskPhoneForGroup('901234512')).toBe('*** ** 12');
    expect(maskPhoneForGroup('12')).toBe('***');
  });
});
