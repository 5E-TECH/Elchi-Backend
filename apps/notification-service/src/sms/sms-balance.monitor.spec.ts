import {
  NotificationPriority,
  isKnownNotificationType,
  resolveNotificationDefaults,
} from '@app/common';
import { SmsBalanceMonitor } from './sms-balance.monitor';
import { SmsConfigService } from './sms-config.service';

/**
 * 8auPBa1O #7 / TC13 — provayder balansi chegaradan tushsa admin inboxiga
 * CRITICAL. `inbox.dispatch` mock'i dispatch'ning HAQIQIY reyestr darvozasini
 * takrorlaydi (notification-inbox.service.ts: `isKnownNotificationType` —
 * katalogda yo'q tur → 400). Real SMS/provayder yo'q: adapter soxta.
 */
const tashkent = (iso: string) => new Date(`${iso}+05:00`);

describe('SmsBalanceMonitor (8auPBa1O TC13)', () => {
  let env: Record<string, unknown>;
  let adapter: { provider: string; getBalance: jest.Mock };
  let dispatched: Array<Record<string, any>>;
  let inbox: { dispatch: jest.Mock };

  const make = () => {
    const config = { get: (key: string) => env[key] };
    return new SmsBalanceMonitor(
      new SmsConfigService(config as never),
      config as never,
      { resolve: jest.fn().mockResolvedValue(adapter) } as never,
      {} as never,
      inbox as never,
    );
  };

  beforeEach(() => {
    env = {
      SMS_ENABLED: 'true',
      SMS_BALANCE_ALERT_THRESHOLD: '50000',
      SMS_ALERT_RECIPIENT_IDS: '7, 8,abc',
    };
    adapter = {
      provider: 'eskiz',
      getBalance: jest.fn().mockResolvedValue(12_000),
    };
    dispatched = [];
    inbox = {
      dispatch: jest.fn((dto: Record<string, any>) => {
        if (!isKnownNotificationType(dto.type)) {
          return Promise.reject(
            new Error(`400: unknown notification type ${dto.type}`),
          );
        }
        dispatched.push(dto);
        return Promise.resolve({ statusCode: 201 });
      }),
    };
  });

  it('balans chegaradan past → admin inboxiga CRITICAL (tur katalogda — dispatch 400 bermaydi)', async () => {
    const now = tashkent('2026-10-14T10:00:00');
    expect(await make().check(now)).toBe('alerted');
    expect(dispatched).toHaveLength(1);
    const [dto] = dispatched;
    expect(dto).toMatchObject({
      type: 'sms.balance_low',
      priority: NotificationPriority.CRITICAL,
      roles: ['admin'],
      recipient_ids: ['7', '8'],
      group_key: 'sms:balance_low:2026-10-14',
      data: { day: '2026-10-14', balance: 12_000, threshold: 50_000 },
    });
    expect(dto.body).toContain('eskiz');
    // Katalog sukuti ham CRITICAL va o'chirib bo'lmaydi.
    expect(
      resolveNotificationDefaults({ type: 'sms.balance_low' }).priority,
    ).toBe(NotificationPriority.CRITICAL);
  });

  it('Toshkent kuniga BIR marta: o‘sha kun qayta tekshiruv — already_alerted, ertasi — yana', async () => {
    const monitor = make();
    expect(await monitor.check(tashkent('2026-10-14T10:00:00'))).toBe(
      'alerted',
    );
    expect(await monitor.check(tashkent('2026-10-14T23:30:00'))).toBe(
      'already_alerted',
    );
    // Toshkent 00:10 = UTC 19:10 (oldingi sana) — baribir YANGI Toshkent kuni.
    expect(await monitor.check(tashkent('2026-10-15T00:10:00'))).toBe(
      'alerted',
    );
    expect(dispatched.map((dto) => dto.group_key)).toEqual([
      'sms:balance_low:2026-10-14',
      'sms:balance_low:2026-10-15',
    ]);
  });

  it('balans yetarli → ogohlantirish yo‘q', async () => {
    adapter.getBalance.mockResolvedValue(50_000);
    expect(await make().check()).toBe('ok');
    expect(inbox.dispatch).not.toHaveBeenCalled();
  });

  it('chegara sozlanmagan yoki SMS o‘chiq → tekshirilmaydi (provayderga so‘rov ham yo‘q)', async () => {
    env.SMS_BALANCE_ALERT_THRESHOLD = '';
    expect(await make().check()).toBe('skipped');
    env.SMS_BALANCE_ALERT_THRESHOLD = '50000';
    env.SMS_ENABLED = 'false';
    expect(await make().check()).toBe('skipped');
    expect(adapter.getBalance).not.toHaveBeenCalled();
  });

  it('dispatch yiqilsa kun "ogohlantirilgan" deb belgilanmaydi — keyingi tekshiruv qayta urinadi', async () => {
    inbox.dispatch.mockRejectedValueOnce(new Error('rmq down'));
    const monitor = make();
    const now = tashkent('2026-10-14T10:00:00');
    await expect(monitor.check(now)).rejects.toThrow('rmq down');
    expect(await monitor.check(now)).toBe('alerted');
  });
});
