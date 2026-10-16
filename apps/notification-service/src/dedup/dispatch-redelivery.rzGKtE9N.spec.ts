import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationChannel, notificationValidationSchema } from '@app/common';
import type { DispatchNotificationDto } from '../dto/dispatch-notification.dto';
import { makeInbox, makeMemoryDedup } from '../testing/inbox-kit-spec';
import { DispatchDedupService } from './dispatch-dedup.service';

/**
 * rzGKtE9N — buyurtma/moliya hodisalari bildirishnoma yadrosiga (outbox →
 * `notification.dispatch`), bot faqat TELEGRAM kanali.
 *
 *  TC1 (order.sell → outbox AYNI tranzaksiyada, rollback'da yo'q) —
 *      order-service: `order-notification.service.spec.ts` (OA16fdSq TC3/TC4)
 *      va `order-status-outbox.rzGKtE9N.pg.spec.ts` (haqiqiy Postgres).
 *  TC2 ulanmagan qabul qiluvchi → in_app baribir yoziladi.
 *  TC3 integration-service (`sendAdminNotification`) — hamkor/integratsiya
 *      sohasi: bu kartada O'ZGARTIRILMAGAN (Shodiyor akaga). Notification
 *      tomoni tokenni baribir qabul qilmaydi (faqat env) — TgYRqaTk spec'i.
 *  TC4 NOTIFICATION_ADMIN_GROUP_ID Joi'da, bo'sh env bilan boot yiqilmaydi.
 *  TC5 outbox qayta yetkazsa ikkinchi Telegram xabari YO'Q (dedup kaliti).
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const outboxEvent = (extra: Partial<DispatchNotificationDto> = {}) =>
  ({
    // finance-service outbox payload'i (HQ → market to'lovi): barqaror
    // request_id (OutboxService.attachRequestId), Telegram DM kanali.
    type: 'finance.payment_received',
    title: "💰 To'lov qabul qilindi",
    body: "Sizga 1 500 000 so'm to'landi (to'lov #701).",
    data: { kind: 'market_payment', amount: 1_500_000, payment_id: '701' },
    group_key: 'finance:payment:701',
    recipient_ids: ['11', '12'],
    channels: [
      NotificationChannel.IN_APP,
      NotificationChannel.REALTIME,
      NotificationChannel.TELEGRAM,
    ],
    request_id: '6f1c4f5e-1b2a-4c3d-8e9f-0a1b2c3d4e5f',
    ...extra,
  }) as DispatchNotificationDto;

const makeDm = () => ({
  plan: jest.fn((ids: string[]) =>
    Promise.resolve(
      new Map(
        ids.map((id) => [
          id,
          id === '11'
            ? { telegram: 'queued' }
            : { telegram: 'skipped', telegram_reason: 'no_telegram_id' },
        ]),
      ),
    ),
  ),
  enqueue: jest.fn().mockResolvedValue(undefined),
});

describe('rzGKtE9N TC5 — outbox qayta yetkazishi: ikkinchi Telegram xabari yo‘q', () => {
  it('⭐ ayni request_id bilan ikkinchi dispatch — qator yangilanmaydi, DM navbatga qo‘yilmaydi', async () => {
    const dm = makeDm();
    const dedup = makeMemoryDedup();
    const { service, txRepo } = makeInbox({ dm, dedup });

    const first = (await service.dispatch(outboxEvent())) as {
      data: { dispatched: number };
    };
    expect(first.data.dispatched).toBe(2);
    expect(dm.enqueue).toHaveBeenCalledTimes(1);

    const second = (await service.dispatch(outboxEvent())) as {
      statusCode: number;
      data: { dispatched: number; duplicate: boolean };
    };
    expect(second.data).toEqual(
      expect.objectContaining({ dispatched: 0, duplicate: true }),
    );
    expect(dm.enqueue).toHaveBeenCalledTimes(1);
    // group_key qatori QAYTA `queued` qilinmadi (avval aynan shu yo'l bilan
    // Telegram xabari ikkinchi marta ketardi).
    expect(txRepo.update).not.toHaveBeenCalled();
    expect(txRepo.insert).toHaveBeenCalledTimes(1);
    expect(dedup.keys).toEqual(
      new Set([
        'finance.payment_received:6f1c4f5e-1b2a-4c3d-8e9f-0a1b2c3d4e5f',
      ]),
    );
  });

  it('guruh relay (market_id nishoni) ham takrorda chaqirilmaydi', async () => {
    const dedup = makeMemoryDedup();
    const { service, telegramService } = makeInbox({ dedup });
    const event = outboxEvent({
      type: 'order.cancelled',
      telegram: { market_id: '37', text: 'Bekor qilindi' },
    });
    await service.dispatch(event);
    await service.dispatch({ ...event });
    expect(telegramService.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('turli hodisa (boshqa request_id) — odatdagidek yangilanadi va yuboriladi', async () => {
    const dm = makeDm();
    const { service } = makeInbox({ dm, dedup: makeMemoryDedup() });
    await service.dispatch(outboxEvent());
    await service.dispatch(
      outboxEvent({
        request_id: '7f1c4f5e-1b2a-4c3d-8e9f-0a1b2c3d4e5f',
      } as never),
    );
    expect(dm.enqueue).toHaveBeenCalledTimes(2);
  });

  it('request_id siz dispatch (tasodifiy partiya) — dedup qo‘llanmaydi', async () => {
    const dedup = makeMemoryDedup();
    const { service } = makeInbox({ dm: makeDm(), dedup });
    const event = outboxEvent();
    delete (event as { request_id?: string }).request_id;
    await service.dispatch(event);
    expect(dedup.claim).not.toHaveBeenCalled();
  });

  it('kalit tranzaksiya ICHIDA egallanadi (rollback — kalit ham qaytadi)', async () => {
    const dedup = makeMemoryDedup();
    const { service, txRepo } = makeInbox({ dm: makeDm(), dedup });
    txRepo.insert.mockRejectedValueOnce(new Error('db down'));
    // Haqiqiy Postgres'da INSERT xatosi tranzaksiyani (va kalitni) qaytaradi —
    // xotira dedup'ida buni qo'lda taqlid qilamiz.
    dedup.claim.mockImplementationOnce(() => Promise.resolve(true));
    await expect(service.dispatch(outboxEvent())).rejects.toBeDefined();
    const retry = (await service.dispatch(outboxEvent())) as {
      data: { dispatched: number };
    };
    expect(retry.data.dispatched).toBe(2);
  });

  it('DispatchDedupService.key: `<type>:<request_id>`, 220 belgigacha', () => {
    expect(DispatchDedupService.key(' order.sold ', 'abc')).toBe(
      'order.sold:abc',
    );
    expect(DispatchDedupService.key('x.y', 'z'.repeat(400))).toHaveLength(220);
  });
});

describe('rzGKtE9N TC2 — TELEGRAM tanlangan, qabul qiluvchi ulanmagan', () => {
  it('in_app baribir yoziladi, telegram = skipped(no_telegram_id), dispatch yiqilmaydi', async () => {
    const dm = makeDm();
    const { service, store } = makeInbox({ dm, dedup: makeMemoryDedup() });
    const res = (await service.dispatch(outboxEvent())) as {
      statusCode: number;
      data: { dispatched: number };
    };
    expect(res.statusCode).toBe(201);
    expect(res.data.dispatched).toBe(2);
    const byRecipient = Object.fromEntries(
      [...store.values()].map((row) => [row.recipient_id, row.delivery]),
    );
    expect(byRecipient['12']).toEqual(
      expect.objectContaining({
        in_app: 'sent',
        telegram: 'skipped',
        telegram_reason: 'no_telegram_id',
      }),
    );
    expect(byRecipient['11']).toEqual(
      expect.objectContaining({ in_app: 'sent', telegram: 'queued' }),
    );
  });
});

describe('rzGKtE9N TC4 / TgYRqaTk #4 — NOTIFICATION_ADMIN_GROUP_ID Joi sxemasida', () => {
  const base = {
    POSTGRES_URI: 'postgres://x@localhost/db',
    RABBITMQ_URI: 'amqp://localhost',
    RABBITMQ_NOTIFICATION_QUEUE: 'notification_queue',
    RABBITMQ_IDENTITY_QUEUE: 'identity_queue',
    RABBITMQ_ORDER_QUEUE: 'order_queue',
  };
  const validate = (env: Record<string, string>) =>
    notificationValidationSchema.validate(
      { ...base, ...env },
      {
        allowUnknown: true,
      },
    );

  it('bo‘sh / berilmagan — boot yiqilmaydi (.optional)', () => {
    expect(validate({}).error).toBeUndefined();
    expect(validate({ NOTIFICATION_ADMIN_GROUP_ID: '' }).error).toBeUndefined();
    expect(validate({ TELEGRAM_ADMIN_GROUP_ID: '' }).error).toBeUndefined();
  });

  it('guruh chat id (manfiy) qabul qilinadi; matn — rad', () => {
    expect(
      validate({ NOTIFICATION_ADMIN_GROUP_ID: '-1001234567890' }).error,
    ).toBeUndefined();
    expect(
      validate({ NOTIFICATION_ADMIN_GROUP_ID: 'admins' }).error,
    ).toBeDefined();
    const keys = Object.keys(
      (notificationValidationSchema.describe() as { keys: object }).keys,
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        'NOTIFICATION_ADMIN_GROUP_ID',
        'TELEGRAM_ADMIN_GROUP_ID',
      ]),
    );
  });

  it('.env.example ikkala kalitni hujjatlaydi', () => {
    const example = readFileSync(
      join(__dirname, '..', '..', '..', '..', '.env.example'),
      'utf8',
    );
    expect(example).toMatch(/^#?\s*NOTIFICATION_ADMIN_GROUP_ID=/m);
    expect(example).toMatch(/^#?\s*TELEGRAM_ADMIN_GROUP_ID=/m);
  });
});
