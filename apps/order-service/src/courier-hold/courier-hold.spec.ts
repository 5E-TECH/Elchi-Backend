import {
  Group_type,
  NotificationChannel,
  canViewCourierHold,
  parseCourierHoldFilter,
} from '@app/common';
import {
  COURIER_HOLD_WARNING_TYPE,
  buildCourierHoldCourierPayload,
  buildCourierHoldMarketPayload,
  courierHoldBucketOf,
  courierHoldHours,
  courierHoldInQuiet,
  courierHoldRange,
  courierHoldSql,
  readCourierHoldWarnConfig,
  type CourierHoldDueOrder,
} from './courier-hold';
import { CourierHoldWarningScheduler } from './courier-hold.scheduler';
import type { CourierHoldService } from './courier-hold.service';

/**
 * onXzDc5n — kuryerdagi buyurtmalar: sof qoidalar (filtr, oraliqlar, rollar,
 * sozlama, matn/payload) va scheduler (taqiq, o'chiq, partiya).
 */
const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-11-27T07:00:00Z'); // 12:00 Toshkent
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR);

describe('onXzDc5n — filtr va oraliqlar', () => {
  it('⭐ parseCourierHoldFilter: ma`lum qiymat / bo`sh / noto`g`ri', () => {
    expect(parseCourierHoldFilter('OVER_72')).toEqual({
      filter: 'over_72',
      invalid: false,
    });
    expect(parseCourierHoldFilter(['near_48', 'any'])).toEqual({
      filter: 'near_48',
      invalid: false,
    });
    expect(parseCourierHoldFilter('')).toEqual({
      filter: null,
      invalid: false,
    });
    expect(parseCourierHoldFilter(undefined)).toEqual({
      filter: null,
      invalid: false,
    });
    expect(parseCourierHoldFilter('72')).toEqual({
      filter: null,
      invalid: true,
    });
  });

  it('⭐ canViewCourierHold: SA/admin/menejer/kuryer/market — ha; qolganlar — yo`q', () => {
    for (const role of [
      'superadmin',
      'admin',
      'manager',
      'courier',
      'MARKET',
    ]) {
      expect(canViewCourierHold([role])).toBe(true);
    }
    for (const role of [
      'registrator',
      'operator',
      'market_operator',
      'logist',
      'investor',
      'customer',
      'branch',
    ]) {
      expect(canViewCourierHold([role])).toBe(false);
    }
    expect(canViewCourierHold(undefined)).toBe(false);
  });

  it('⭐ courierHoldRange: near_48 = (now−48, now−36], over_48 = (now−72, now−48], over_72 ≤ now−72, any — chegarasiz', () => {
    expect(courierHoldRange('near_48', NOW)).toEqual({
      before: hoursAgo(36),
      after: hoursAgo(48),
    });
    expect(courierHoldRange('over_48', NOW)).toEqual({
      before: hoursAgo(48),
      after: hoursAgo(72),
    });
    expect(courierHoldRange('over_72', NOW)).toEqual({ before: hoursAgo(72) });
    expect(courierHoldRange('any', NOW)).toEqual({});
  });

  it('⭐ bucket chegaralari: 35:59 → under_36, 36 → near_48, 47:59 → near_48, 48 → over_48, 72 → over_72', () => {
    const minute = 60 * 1000;
    expect(
      courierHoldBucketOf(new Date(hoursAgo(36).getTime() + minute), NOW),
    ).toBe('under_36');
    expect(courierHoldBucketOf(hoursAgo(36), NOW)).toBe('near_48');
    expect(
      courierHoldBucketOf(new Date(hoursAgo(48).getTime() + minute), NOW),
    ).toBe('near_48');
    expect(courierHoldBucketOf(hoursAgo(48), NOW)).toBe('over_48');
    expect(courierHoldBucketOf(hoursAgo(71.9), NOW)).toBe('over_48');
    expect(courierHoldBucketOf(hoursAgo(72), NOW)).toBe('over_72');
    expect(courierHoldHours(hoursAgo(98.7), NOW)).toBe(98);
    expect(courierHoldHours(new Date(NOW.getTime() + HOUR), NOW)).toBe(0);
  });

  it('courierHoldSql — holder COURIER, faol holatlar (indeks sharti bilan bir xil), o`chirilmagan', () => {
    const sql = courierHoldSql('order');
    expect(sql).toContain("order.holder_type = 'COURIER'");
    expect(sql).toContain(
      "order.status IN ('on the road', 'waiting', 'waiting_customer')",
    );
    expect(sql).toContain('order.is_deleted = false');
    expect(sql).toContain('order.deleted_at IS NULL');
    expect(sql).toContain('order.last_handover_at IS NOT NULL');
    expect(sql).not.toMatch(/sold|cancelled|closed|paid/);
  });
});

describe('onXzDc5n — sozlama', () => {
  it('⭐ sukut: yoqiq, taqiq 22:00-08:00 (umumiy 18:00-09:00 EMAS)', () => {
    const config = readCourierHoldWarnConfig(() => undefined);
    expect(config).toEqual({
      enabled: true,
      quiet: { start: 22 * 60, end: 8 * 60 },
    });
  });

  it('o`chirish va boshqa taqiq; noto`g`ri qiymat — sukut', () => {
    const env: Record<string, string> = {
      COURIER_HOLD_WARN_ENABLED: 'false',
      COURIER_HOLD_WARN_QUIET_HOURS: ' 23:30 - 07:00 ',
    };
    expect(readCourierHoldWarnConfig((k) => env[k])).toEqual({
      enabled: false,
      quiet: { start: 23 * 60 + 30, end: 7 * 60 },
    });
    for (const bad of [
      '25:00-08:00',
      'kechasi',
      '22:00',
      '22:00-08:00-09:00',
    ]) {
      expect(
        readCourierHoldWarnConfig((k) =>
          k === 'COURIER_HOLD_WARN_QUIET_HOURS' ? bad : undefined,
        ).quiet,
      ).toEqual({ start: 22 * 60, end: 8 * 60 });
    }
  });

  it('⭐ taqiq Toshkent vaqtida: 21:59 — yo`q, 22:00 / 03:00 / 07:59 — bor, 08:00 — yo`q', () => {
    const config = readCourierHoldWarnConfig(() => undefined);
    const at = (hhmm: string) => new Date(`2026-11-27T${hhmm}:00+05:00`);
    expect(courierHoldInQuiet(at('21:59'), config)).toBe(false);
    expect(courierHoldInQuiet(at('22:00'), config)).toBe(true);
    expect(courierHoldInQuiet(at('03:00'), config)).toBe(true);
    expect(courierHoldInQuiet(at('07:59'), config)).toBe(true);
    expect(courierHoldInQuiet(at('08:00'), config)).toBe(false);
  });
});

describe('onXzDc5n — xabar payload`lari', () => {
  const orders: CourierHoldDueOrder[] = [
    { id: '12', market_id: '37', courier_id: '26', since: hoursAgo(37) },
    { id: '10', market_id: '37', courier_id: '26', since: hoursAgo(40) },
  ];

  it('⭐ kuryerga: bitta xabar, Telegram DM (guruh nishonisiz), raqamlar, kabinet havolasi, barqaror id', () => {
    const payload = buildCourierHoldCourierPayload('26', orders, NOW);
    expect(payload).toMatchObject({
      type: COURIER_HOLD_WARNING_TYPE,
      recipient_ids: ['26'],
      title: '⏳ Buyurtmalar 48 soatga yaqinlashdi',
      link: '/courier-hold?tab=near_48',
      data: {
        audience: 'courier',
        count: 2,
        order_ids: ['10', '12'],
        order_numbers: ['EL-100010', 'EL-100012'],
        telegram_cabinet_link: true,
      },
    });
    expect(payload?.channels).toEqual([
      NotificationChannel.IN_APP,
      NotificationChannel.REALTIME,
      NotificationChannel.TELEGRAM,
    ]);
    expect(payload).not.toHaveProperty('telegram');
    expect(payload?.body).toContain(
      'Sizda 2 ta buyurtma 36 soatdan beri turibdi',
    );
    expect(payload?.body).toContain('8 soat ichida');
    expect(payload?.body).toContain('EL-100010, EL-100012');
    // Tartib o'zgarsa ham id bir xil (outbox qayta yetkazsa dedup).
    expect(
      buildCourierHoldCourierPayload('26', [...orders].reverse(), NOW)
        ?.client_request_id,
    ).toBe(payload?.client_request_id);
  });

  it('⭐ marketga: bitta xabar, market «create» guruhi, kuryer ma`lumoti YO`Q', () => {
    const payload = buildCourierHoldMarketPayload('37', orders, NOW);
    expect(payload).toMatchObject({
      type: COURIER_HOLD_WARNING_TYPE,
      recipient_ids: ['37'],
      data: { audience: 'market', market_id: '37', count: 2 },
      telegram: { market_id: '37', group_type: Group_type.CREATE },
    });
    expect(payload?.telegram?.text).toContain(
      '<b>⏳ Buyurtmalar kuryerda 48 soatga yaqinlashdi</b>',
    );
    expect(payload?.telegram?.text).toContain('EL-100010, EL-100012');
    expect(JSON.stringify(payload)).not.toMatch(/courier_id|\+998/);
    expect(payload?.client_request_id).not.toBe(
      buildCourierHoldCourierPayload('26', orders, NOW)?.client_request_id,
    );
  });

  it('30 tadan ko`p raqam — «(+N)»; noto`g`ri id / bo`sh ro`yxat — null', () => {
    const many = Array.from({ length: 33 }, (_, i) => ({
      id: String(i + 1),
      market_id: '37',
      courier_id: '26',
      since: hoursAgo(37),
    }));
    expect(buildCourierHoldCourierPayload('26', many, NOW)?.body).toContain(
      '(+3)',
    );
    expect(buildCourierHoldCourierPayload('', orders, NOW)).toBeNull();
    expect(buildCourierHoldMarketPayload('37', [], NOW)).toBeNull();
  });
});

describe('onXzDc5n — CourierHoldWarningScheduler', () => {
  const make = (
    env: Record<string, string> = {},
    runs: Array<{ locked: boolean; hit_limit: boolean }> = [
      { locked: true, hit_limit: false },
    ],
  ) => {
    const warnDue = jest.fn();
    for (const run of runs) {
      warnDue.mockResolvedValueOnce({ ...run, orders: 1, notifications: 2 });
    }
    const scheduler = new CourierHoldWarningScheduler(
      { warnDue } as unknown as CourierHoldService,
      { get: (key: string) => env[key] } as never,
    );
    return { scheduler, warnDue };
  };
  const day = new Date('2026-11-27T12:00:00+05:00');
  const night = new Date('2026-11-27T23:00:00+05:00');

  it('⭐ kunduzi — warnDue; kechasi (22–08) — hech narsa', async () => {
    const { scheduler, warnDue } = make();
    await expect(scheduler.tick(night)).resolves.toBeNull();
    expect(warnDue).not.toHaveBeenCalled();
    await expect(scheduler.tick(day)).resolves.toHaveLength(1);
    expect(warnDue).toHaveBeenCalledWith(day);
  });

  it('o`chiq — hech narsa', async () => {
    const { scheduler, warnDue } = make({ COURIER_HOLD_WARN_ENABLED: 'false' });
    await expect(scheduler.tick(day)).resolves.toBeNull();
    expect(warnDue).not.toHaveBeenCalled();
  });

  it('partiya to`lsa — yana urinadi (ko`pi bilan 5), qulf band bo`lsa — to`xtaydi', async () => {
    const full = { locked: true, hit_limit: true };
    const { scheduler, warnDue } = make({}, [
      full,
      full,
      { locked: true, hit_limit: false },
    ]);
    await expect(scheduler.tick(day)).resolves.toHaveLength(3);
    expect(warnDue).toHaveBeenCalledTimes(3);

    const busy = make({}, [{ locked: false, hit_limit: false }]);
    await expect(busy.scheduler.tick(day)).resolves.toHaveLength(1);
    expect(busy.warnDue).toHaveBeenCalledTimes(1);

    const endless = make(
      {},
      Array.from({ length: 9 }, () => full),
    );
    await endless.scheduler.tick(day);
    expect(endless.warnDue).toHaveBeenCalledTimes(5);
  });

  it('xato — yutiladi (servis yiqilmaydi)', async () => {
    const { scheduler, warnDue } = make({}, []);
    warnDue.mockRejectedValueOnce(new Error('db down'));
    await expect(scheduler.tick(day)).resolves.toBeNull();
  });

  it('onModuleInit: o`chiq bo`lsa interval yo`q', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const off = make({ COURIER_HOLD_WARN_ENABLED: '0' });
    off.scheduler.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    const on = make();
    on.scheduler.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(1);
    on.scheduler.onModuleDestroy();
    spy.mockRestore();
  });
});
