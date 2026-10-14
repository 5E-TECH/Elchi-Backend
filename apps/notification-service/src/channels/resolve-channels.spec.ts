import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NotificationChannel,
  NotificationDeliveryStatus,
  findNotificationType,
} from '@app/common';
import {
  pushSuppressedByPresence,
  requestedChannels,
  resolveChannels,
} from './resolve-channels';

/** (7Ec56EIw) Kanal tanlash qoidasi — SOF funksiya, I/O yo'q. */
describe('resolveChannels (7Ec56EIw)', () => {
  it('TC1: NotificationChannel.PUSH = "push" va kanal uchun yangi migratsiya YO‘Q (channels — JSONB)', () => {
    expect(NotificationChannel.PUSH).toBe('push');
    const dir = join(__dirname, '../../../../migrations');
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) =>
        /ALTER TYPE[^;]*channel|channels_enum/i.test(
          readFileSync(join(dir, file), 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it('TC2: alohida faylda, sof — bir xil kirish → bir xil natija, kirish o‘zgarmaydi', () => {
    const requested = ['in_app', 'realtime'];
    const recipient = { muted: new Set(['realtime']) };
    const a = resolveChannels('order.manual', requested, recipient);
    const b = resolveChannels('order.manual', requested, recipient);
    expect(a).toEqual(b);
    expect(requested).toEqual(['in_app', 'realtime']);
    expect([...recipient.muted]).toEqual(['realtime']);
  });

  it('TC3: DTO channels berilmasa katalogning default_channels i ishlatiladi', () => {
    expect(requestedChannels('order.cancelled')).toEqual([
      ...(findNotificationType('order.cancelled')?.default_channels ?? []),
    ]);
    expect(resolveChannels('order.cancelled', undefined).active).toEqual([
      'in_app',
      'realtime',
      'telegram',
    ]);
  });

  it('TC4: katalogda yo‘q kanal so‘ralsa KESISHMA olinadi (ortiqcha kanal qo‘shilmaydi)', () => {
    // order.sold — faqat in_app + realtime.
    expect(
      requestedChannels('order.sold', ['in_app', 'sms', 'push', 'realtime']),
    ).toEqual(['in_app', 'realtime']);
    expect(requestedChannels('order.sold', ['sms'])).toEqual([]);
    // Qo'lda yuboriladigan va `x.` turlarda — barcha kanal ruxsat.
    expect(
      requestedChannels('order.manual', ['in_app', 'sms', 'push']),
    ).toEqual(['in_app', 'sms', 'push']);
    expect(requestedChannels('x.test', ['telegram'])).toEqual(['telegram']);
    // Noma'lum kanal nomi tashlanadi.
    expect(requestedChannels('x.test', ['in_app', 'fax'])).toEqual(['in_app']);
  });

  it('TC5: foydalanuvchi o‘chirgan kanal faol ro‘yxatda yo‘q, delivery da `skipped/muted`', () => {
    const res = resolveChannels(
      'order.manual',
      ['in_app', 'realtime', 'push'],
      {
        muted: new Set(['push']),
      },
    );
    expect(res.active).toEqual(['in_app', 'realtime']);
    expect(res.delivery).toEqual({
      in_app: 'sent',
      realtime: 'pending',
      push: 'skipped',
      push_reason: 'muted',
    });
    expect(res.excluded).toBe(false);
  });

  it('in_app (yoki hammasi) o‘chirilsa — qabul qiluvchi ro‘yxatdan tushadi', () => {
    expect(
      resolveChannels('order.manual', ['in_app', 'push'], { muted: 'all' })
        .excluded,
    ).toBe(true);
    expect(
      resolveChannels('order.manual', ['realtime'], {
        muted: new Set(['in_app']),
      }).excluded,
    ).toBe(true);
  });

  it('TC6/TC7: imkoniyati yo‘q kanal jimgina tashlanmaydi — `not_eligible` / `no_subscription` yoziladi', () => {
    const res = resolveChannels('order.manual', ['in_app', 'sms', 'push'], {
      blocked: {
        [NotificationChannel.SMS]: {
          status: NotificationDeliveryStatus.NOT_ELIGIBLE,
          reason: 'no_phone',
        },
        [NotificationChannel.PUSH]: {
          status: NotificationDeliveryStatus.NO_SUBSCRIPTION,
        },
      },
    });
    expect(res.active).toEqual(['in_app']);
    expect(res.delivery).toEqual({
      in_app: 'sent',
      sms: 'not_eligible',
      sms_reason: 'no_phone',
      push: 'no_subscription',
    });
  });

  it('faol kanallar boshlang‘ich holati: push=queued, email=no_provider, qolgan=pending', () => {
    expect(
      resolveChannels('system.manual', [
        'in_app',
        'push',
        'email',
        'sms',
        'telegram',
      ]).delivery,
    ).toEqual({
      in_app: 'sent',
      push: 'queued',
      email: 'no_provider',
      sms: 'pending',
      telegram: 'pending',
    });
  });

  it('TC8 (sof qism): onlayn + realtime so‘ralgan → push bostiriladi; oflayn yoki realtime yo‘q → push ketadi', () => {
    expect(pushSuppressedByPresence(['in_app', 'realtime', 'push'], true)).toBe(
      true,
    );
    expect(
      pushSuppressedByPresence(['in_app', 'realtime', 'push'], false),
    ).toBe(false);
    expect(pushSuppressedByPresence(['in_app', 'push'], true)).toBe(false);
  });
});
