import {
  SmsBlockedError,
  SmsGateService,
  tashkentMinuteOfDay,
} from './sms-gate.service';
import { SmsConfigService } from './sms-config.service';

const config = (env: Record<string, unknown>) =>
  new SmsConfigService({ get: (key: string) => env[key] } as never);

/** Toshkent devor vaqti → UTC Date (Toshkent = UTC+5, yozgi vaqt yo'q). */
const tashkent = (iso: string) => new Date(`${iso}+05:00`);

describe('SmsGateService', () => {
  let outbox: { count: jest.Mock };
  const gate = (env: Record<string, unknown>) =>
    new SmsGateService(config(env), outbox as never);

  beforeEach(() => {
    outbox = { count: jest.fn().mockResolvedValue(0) };
  });

  it('kill-switch: SMS_ENABLED=false → blocked with a clear reason, nothing counted', async () => {
    await expect(gate({}).assertCanEnqueue(1)).rejects.toMatchObject({
      reason: 'sms_disabled',
    });
    expect(outbox.count).not.toHaveBeenCalled();
  });

  it('SMS_MAX_FANOUT applies (not MAX_FANOUT=5000) and is an ERROR, not a silent cut', async () => {
    const error = await gate({ SMS_ENABLED: 'true', SMS_MAX_FANOUT: '200' })
      .assertCanEnqueue(201)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmsBlockedError);
    expect(error).toMatchObject({
      reason: 'fanout_exceeded',
      details: { requested: 201, max: 200 },
    });
  });

  it('daily cap is fail-closed and counted from the start of the Tashkent day', async () => {
    outbox.count.mockResolvedValue(499);
    const now = tashkent('2026-10-06T02:00:00');
    const g = gate({ SMS_ENABLED: 'true', SMS_DAILY_CAP: '500' });
    await expect(g.assertCanEnqueue(1, now)).resolves.toBeUndefined();
    await expect(g.assertCanEnqueue(2, now)).rejects.toMatchObject({
      reason: 'daily_cap_exceeded',
    });
    const where = outbox.count.mock.calls[0][0].where.created_at;
    // Toshkent 00:00 = UTC 19:00 oldingi kun — UTC yarim tuni EMAS.
    expect(where.value).toEqual(new Date('2026-10-05T19:00:00Z'));
  });

  it('Tashkent minute-of-day uses the fixed +5 offset', () => {
    expect(tashkentMinuteOfDay(tashkent('2026-10-06T19:00:00'))).toBe(19 * 60);
    expect(tashkentMinuteOfDay(tashkent('2026-10-06T00:30:00'))).toBe(30);
  });

  describe('promo quiet window (18:00–09:00 Tashkent)', () => {
    const g = () => gate({ SMS_ENABLED: 'true' });

    it('promo at 19:00 is moved (not dropped) to 09:00 next day', () => {
      expect(g().scheduleFor('promo', tashkent('2026-10-06T19:00:00'))).toEqual(
        tashkent('2026-10-07T09:00:00'),
      );
    });

    it('promo at 03:00 goes out at 09:00 the same day', () => {
      expect(g().scheduleFor('promo', tashkent('2026-10-07T03:00:00'))).toEqual(
        tashkent('2026-10-07T09:00:00'),
      );
    });

    it('promo at 10:00 goes right away', () => {
      const now = tashkent('2026-10-06T10:00:00');
      expect(g().scheduleFor('promo', now)).toEqual(now);
    });

    it('transactional and security (OTP) ignore the window — night OTP works', () => {
      const night = tashkent('2026-10-06T23:30:00');
      expect(g().scheduleFor('transactional', night)).toEqual(night);
      expect(g().scheduleFor('security', night)).toEqual(night);
    });

    it('the window is configurable (NOTIF_PROMO_QUIET_HOURS)', () => {
      const custom = gate({
        SMS_ENABLED: 'true',
        NOTIF_PROMO_QUIET_HOURS: '21:00-08:00',
      });
      const at2030 = tashkent('2026-10-06T20:30:00');
      expect(custom.scheduleFor('promo', at2030)).toEqual(at2030);
      expect(
        custom.scheduleFor('promo', tashkent('2026-10-06T21:30:00')),
      ).toEqual(tashkent('2026-10-07T08:00:00'));
    });
  });
});
