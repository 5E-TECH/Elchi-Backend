import { Logger } from '@nestjs/common';
import { NotificationChannel } from '@app/common';
import type { DispatchNotificationDto } from './dto/dispatch-notification.dto';
import { makeInbox } from './testing/inbox-kit-spec';

/**
 * BOT-3c (NIMA 7/8) — guruh relay'i (bekor / market guruhi xabari) dispatch
 * TRANZAKSIYASI ichida outbox'ga yoziladi; inbox qatorlari shu tranzaksiyada
 * `delivery.telegram = queued`. Rollback → xabar yo'q. `queued` natijani
 * dispatch oxirida qayta yozmaydi — yakunni outbox ishchisi yozadi.
 * (Haqiqiy Postgres'dagi tranzaksiya/restart: bot/telegram-relay.BOT3c.pg.spec.ts.)
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const dto = (extra: Partial<DispatchNotificationDto> = {}) =>
  ({
    type: 'order.cancelled',
    title: 'Buyurtma bekor qilindi',
    data: { order_id: '81' },
    recipient_ids: ['11'],
    channels: [NotificationChannel.IN_APP, NotificationChannel.TELEGRAM],
    telegram: { market_id: '37', group_type: 'cancel', text: 'Bekor' },
    ...extra,
  }) as DispatchNotificationDto;

describe('BOT-3c — guruh relay outbox dispatch tranzaksiyasida', () => {
  it('⭐ outbox qatori inbox qatorlari bilan AYNI tranzaksiyada; qatorlar `queued`; commit’dan keyin darhol yuboriladi', async () => {
    const { service, telegramService, store } = makeInbox();
    let committed = false;
    telegramService.flushGroupRelay.mockImplementation(() => {
      committed = true;
      return Promise.resolve({
        data: { success: 1, failed: 0, queued: 0, results: [{ ok: true }] },
      });
    });
    const res = (await service.dispatch(dto(), {
      afterPersist: () => {
        // Tranzaksiya ichida: relay navbatga qo'yilgan, hali yuborilmagan.
        expect(telegramService.enqueueGroupRelay).toHaveBeenCalledTimes(1);
        expect(committed).toBe(false);
        return Promise.resolve();
      },
    })) as { data: { by_channel: Record<string, number> } };
    const [manager, target, message, ids] = telegramService.enqueueGroupRelay
      .mock.calls[0] as [{ query: jest.Mock }, unknown, string, string[]];
    expect(target).toEqual({
      market_id: '37',
      group_id: undefined,
      group_type: 'cancel',
    });
    expect(message).toBe('Bekor');
    expect(ids).toEqual([...store.keys()]);
    // `delivery.telegram = queued` — ayni tranzaksiya menejeri orqali.
    expect(String(manager.query.mock.calls[0][0])).toContain(
      '"telegram":"queued"',
    );
    expect(telegramService.flushGroupRelay).toHaveBeenCalledTimes(1);
    expect(res.data.by_channel.telegram).toBe(1);
  });

  it('⭐ tranzaksiya yiqilsa (rollback) — relay YUBORILMAYDI', async () => {
    const { service, telegramService } = makeInbox();
    await expect(
      service.dispatch(dto(), {
        afterPersist: () => Promise.reject(new Error('db')),
      }),
    ).rejects.toBeTruthy();
    expect(telegramService.enqueueGroupRelay).toHaveBeenCalledTimes(1);
    expect(telegramService.flushGroupRelay).not.toHaveBeenCalled();
    expect(telegramService.sendNotification).not.toHaveBeenCalled();
  });

  it('⭐ 429 (queued) — dispatch oxirida `queued` qayta yozilmaydi (outbox ishchisining `sent` i bosilmaydi)', async () => {
    const { service, telegramService, store } = makeInbox();
    telegramService.sendNotification.mockResolvedValue({
      data: { success: 0, failed: 0, queued: 1, results: [{ queued: true }] },
    });
    const res = (await service.dispatch(dto())) as {
      data: { by_channel: Record<string, number> };
    };
    const [row] = [...store.values()];
    expect(row.delivery).toMatchObject({ telegram: 'queued' });
    // Ishchi yakunladi — keyingi yozuv yo'q (recordDelivery telegram'siz).
    store.set(row.id, { ...row, delivery: { telegram: 'sent' } });
    expect([...store.values()][0].delivery).toEqual({ telegram: 'sent' });
    expect(res.data.by_channel.telegram).toBe(0);
  });

  it('marketda guruh yo‘q — not_eligible (no_telegram_group), dispatch yiqilmaydi', async () => {
    const { service, telegramService, store } = makeInbox();
    telegramService.enqueueGroupRelay.mockResolvedValue(null);
    const res = (await service.dispatch(dto())) as {
      data: { by_channel: Record<string, number> };
    };
    expect(telegramService.flushGroupRelay).not.toHaveBeenCalled();
    // `queued` yozilmaydi (guruh yo'q) — not_eligible dispatch oxirida.
    expect([...store.values()][0].delivery?.telegram).not.toBe('queued');
    expect(res.data.by_channel.telegram).toBe(0);
  });
});
