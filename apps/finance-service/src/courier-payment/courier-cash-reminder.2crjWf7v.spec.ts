import { Logger } from '@nestjs/common';
import { MoreThan } from 'typeorm';
import { Cashbox_type, deterministicUuid } from '@app/common';
import {
  FinanceNotificationService,
  buildCashReminderPayload,
} from '../notification/finance-notification.service';
import { CourierCashReminderScheduler } from './courier-cash-reminder.scheduler';

/**
 * 2crjWf7v #2 — kuryer kassasidagi naqd chegaradan oshsa eslatma: chegara
 * sozlanadigan (ENV), KUNIGA BIR MARTA (spam yo'q), kuryer moliyada faqat
 * o'quvchi (eslatma pul yozuvi yaratmaydi).
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const make = (
  env: Record<string, unknown> = { COURIER_CASH_REMINDER_THRESHOLD: '1000000' },
) => {
  const cashboxes = {
    find: jest.fn().mockResolvedValue([
      { id: '3', user_id: '44', balance: '1500000.00' },
      { id: '4', user_id: '45', balance: 2_000_000 },
    ]),
  };
  const outbox = { enqueue: jest.fn().mockResolvedValue({}) };
  const notifications = new FinanceNotificationService(outbox as never);
  const scheduler = new CourierCashReminderScheduler(
    { get: (key: string) => env[key] } as never,
    cashboxes as never,
    notifications,
  );
  return { scheduler, cashboxes, outbox };
};

/** Toshkent vaqti (UTC+5) → Date. */
const at = (local: string) => new Date(`${local}+05:00`);

describe('2crjWf7v #2 — kassa chegarasi eslatmasi', () => {
  it('⭐ kuniga faqat BIR marta: soatdan oldin — yo‘q, 18:05 — yuboriladi, 21:00 — takror yo‘q, ertasi — yana', async () => {
    const { scheduler, outbox } = make();
    expect(await scheduler.tick(at('2026-10-16T17:59:00'))).toBeNull();
    expect(outbox.enqueue).not.toHaveBeenCalled();

    expect(await scheduler.tick(at('2026-10-16T18:05:00'))).toEqual({
      couriers: 2,
      enqueued: 2,
      failed: 0,
    });
    expect(await scheduler.tick(at('2026-10-16T21:00:00'))).toBeNull();
    expect(outbox.enqueue).toHaveBeenCalledTimes(2);

    await scheduler.tick(at('2026-10-17T18:00:00'));
    expect(outbox.enqueue).toHaveBeenCalledTimes(4);
  });

  it('⭐ ko‘p replika / qayta ishga tushish — ayni kun uchun BIR XIL client_request_id (dispatch dedup takrorni yubormaydi)', async () => {
    const a = make();
    const b = make();
    await a.scheduler.tick(at('2026-10-16T18:05:00'));
    await b.scheduler.tick(at('2026-10-16T19:30:00'));
    const ids = (env: ReturnType<typeof make>) =>
      env.outbox.enqueue.mock.calls.map(
        (call) => (call[2] as { client_request_id: string }).client_request_id,
      );
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a)[0]).toBe(deterministicUuid('cash-reminder:44:2026-10-16'));
  });

  it('faqat chegaradan OSHGAN kuryer kassalari so‘raladi (MoreThan), matn: «💰 Kassangizda X so‘m — filialga topshiring»', async () => {
    const { scheduler, cashboxes, outbox } = make();
    await scheduler.tick(at('2026-10-16T18:05:00'));
    expect(cashboxes.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          cashbox_type: Cashbox_type.FOR_COURIER,
          isDeleted: false,
          balance: MoreThan(1_000_000),
        },
      }),
    );
    const payload = outbox.enqueue.mock.calls[0][2] as Record<string, unknown>;
    expect(payload).toEqual(
      expect.objectContaining({
        type: 'finance.cash_reminder',
        recipient_ids: ['44'],
        body: "💰 Kassangizda 1 500 000 so'm — filialga topshiring.",
        channels: ['in_app', 'telegram'],
      }),
    );
    // Faqat bildirishnoma — pul yozuvi (ORDER/settlement) yo'q.
    expect(
      outbox.enqueue.mock.calls.every((call) => call[0] === 'NOTIFICATION'),
    ).toBe(true);
  });

  it('chegara berilmagan / 0 — o‘chiq (hech narsa so‘ralmaydi)', async () => {
    for (const env of [
      {},
      { COURIER_CASH_REMINDER_THRESHOLD: '' },
      { COURIER_CASH_REMINDER_THRESHOLD: '0' },
    ]) {
      const { scheduler, cashboxes } = make(env);
      expect(await scheduler.tick(at('2026-10-16T20:00:00'))).toBeNull();
      expect(cashboxes.find).not.toHaveBeenCalled();
    }
  });

  it('soat sozlanadi (COURIER_CASH_REMINDER_HOUR)', async () => {
    const { scheduler, outbox } = make({
      COURIER_CASH_REMINDER_THRESHOLD: 1,
      COURIER_CASH_REMINDER_HOUR: 9,
    });
    await scheduler.tick(at('2026-10-16T09:01:00'));
    expect(outbox.enqueue).toHaveBeenCalled();
  });

  it('payload: musbat bo‘lmagan qoldiq — eslatma yo‘q', () => {
    expect(
      buildCashReminderPayload({
        courier_id: '44',
        balance: 0,
        day: '2026-10-16',
      }),
    ).toBeNull();
  });
});
