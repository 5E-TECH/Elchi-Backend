import { Logger } from '@nestjs/common';
import { Group_type, isKnownNotificationType } from '@app/common';
import {
  CANCEL_RETURN_ESCALATED_TYPE,
  CANCEL_RETURN_REMINDER_TYPE,
  buildCancelReturnEscalationPayload,
  buildCancelReturnReminderPayload,
  cancelReturnAwaitingSql,
  cancelReturnReceivedAtSql,
  cancelReturnReminderSlot,
  inQuietWindow,
  readCancelReturnReminderConfig,
  type CancelReturnDueOrder,
} from './cancel-return-reminder';
import { CancelReturnReminderScheduler } from './cancel-return-reminder.scheduler';
import { cancelReturnStageSql } from './cancel-return';

/**
 * vNKGbg5q (BG7) — eslatma / eskalatsiya qoidalari (DB'siz). SQL va
 * idempotentlik haqiqiy Postgres'da: `cancel-return-reminder.pg.spec.ts`.
 * Haqiqiy yuborish YO'Q — faqat payload (outbox) va mock xizmatlar.
 */
const DAY = 24 * 60 * 60 * 1000;
/** Toshkent vaqti → UTC Date. */
const tashkent = (iso: string) => new Date(Date.parse(`${iso}+05:00`));

const env =
  (values: Record<string, unknown> = {}) =>
  (key: string): unknown =>
    values[key];

const due = (
  overrides: Partial<CancelReturnDueOrder> = {},
): CancelReturnDueOrder => ({
  id: '36',
  market_id: '37',
  stage: 'hq',
  place_id: '1',
  place_name: 'Toshkent HQ',
  received_at: new Date(Date.parse('2026-10-22T05:00:00Z')),
  ...overrides,
});
const NOW = new Date(Date.parse('2026-10-26T05:00:00Z'));

describe('vNKGbg5q — sozlama (env)', () => {
  it('sukut: YOQIQ, 3 / 7 kun, soat 10, tungi taqiq 18:00–09:00', () => {
    expect(readCancelReturnReminderConfig(env())).toEqual({
      enabled: true,
      remindAfterDays: 3,
      escalateAfterDays: 7,
      runHour: 10,
      quiet: { start: 18 * 60, end: 9 * 60 },
    });
  });

  it("o'chirish va qiymatlar env'dan; noto'g'ri qiymat — sukut (servis yiqilmaydi)", () => {
    expect(
      readCancelReturnReminderConfig(
        env({
          CANCEL_RETURN_REMINDER_ENABLED: 'false',
          CANCEL_RETURN_REMIND_AFTER_DAYS: '2',
          CANCEL_RETURN_ESCALATE_AFTER_DAYS: 10,
          CANCEL_RETURN_REMINDER_HOUR: '11',
          NOTIF_PROMO_QUIET_HOURS: '20:00-08:30',
        }),
      ),
    ).toEqual({
      enabled: false,
      remindAfterDays: 2,
      escalateAfterDays: 10,
      runHour: 11,
      quiet: { start: 20 * 60, end: 8 * 60 + 30 },
    });
    expect(
      readCancelReturnReminderConfig(
        env({
          CANCEL_RETURN_REMINDER_ENABLED: 'maybe',
          CANCEL_RETURN_REMIND_AFTER_DAYS: '0',
          CANCEL_RETURN_ESCALATE_AFTER_DAYS: 'abc',
          CANCEL_RETURN_REMINDER_HOUR: '25',
          NOTIF_PROMO_QUIET_HOURS: 'kech',
        }),
      ),
    ).toEqual(readCancelReturnReminderConfig(env()));
    expect(
      readCancelReturnReminderConfig(
        env({ CANCEL_RETURN_REMINDER_ENABLED: '' }),
      ).enabled,
    ).toBe(true);
  });
});

describe('vNKGbg5q — kunlik oyna va tungi taqiq', () => {
  const config = readCancelReturnReminderConfig(env());

  it('tungi taqiq (18:00–09:00 Toshkent) — hech narsa yuborilmaydi', () => {
    expect(inQuietWindow(tashkent('2026-10-26T18:00:00'), config.quiet)).toBe(
      true,
    );
    expect(inQuietWindow(tashkent('2026-10-26T03:00:00'), config.quiet)).toBe(
      true,
    );
    expect(inQuietWindow(tashkent('2026-10-26T12:00:00'), config.quiet)).toBe(
      false,
    );
    expect(
      cancelReturnReminderSlot(tashkent('2026-10-26T19:30:00'), config),
    ).toBeNull();
    expect(
      cancelReturnReminderSlot(tashkent('2026-10-26T08:59:00'), config),
    ).toBeNull();
  });

  it('soat 10 dan oldin — kutadi; 10:00 dan keyin — chegaralar KUN BO‘YI bir xil (10:00 dan sanaladi)', () => {
    expect(
      cancelReturnReminderSlot(tashkent('2026-10-26T09:50:00'), config),
    ).toBeNull();
    const morning = cancelReturnReminderSlot(
      tashkent('2026-10-26T10:00:00'),
      config,
    );
    const afternoon = cancelReturnReminderSlot(
      tashkent('2026-10-26T16:40:00'),
      config,
    );
    expect(morning).toEqual({
      day: '2026-10-26',
      runAt: tashkent('2026-10-26T10:00:00'),
      remindCutoff: tashkent('2026-10-23T10:00:00'),
      escalateCutoff: tashkent('2026-10-19T10:00:00'),
    });
    expect(afternoon).toEqual(morning);
  });

  it('soat tungi taqiqqa tushsa (20) — taqiq tugashida (09:00) ishlaydi, hech qachon tunda emas', () => {
    const late = readCancelReturnReminderConfig(
      env({ CANCEL_RETURN_REMINDER_HOUR: '20' }),
    );
    expect(
      cancelReturnReminderSlot(tashkent('2026-10-26T20:30:00'), late),
    ).toBeNull();
    expect(
      cancelReturnReminderSlot(tashkent('2026-10-26T09:10:00'), late)?.runAt,
    ).toEqual(tashkent('2026-10-26T09:00:00'));
  });

  it('«3 kundan ko‘p»: yugurish paytida posilka joyda ≥ 3 kun turgan', () => {
    const slot = cancelReturnReminderSlot(
      tashkent('2026-10-26T10:00:00'),
      config,
    )!;
    expect(slot.runAt.getTime() - slot.remindCutoff.getTime()).toBe(3 * DAY);
    expect(slot.runAt.getTime() - slot.escalateCutoff.getTime()).toBe(7 * DAY);
  });
});

describe('vNKGbg5q — SQL sharti BG1 bosqichi bilan bir xil', () => {
  it('hq | branch, ombor buyurtmasi va o‘chirilganlar chiqariladi; received_at — GREATEST', () => {
    const sql = cancelReturnAwaitingSql('o');
    expect(sql).toContain(cancelReturnStageSql('hq', 'o'));
    expect(sql).toContain(cancelReturnStageSql('branch', 'o'));
    expect(sql).not.toContain(cancelReturnStageSql('courier', 'o'));
    expect(sql).not.toContain(cancelReturnStageSql('market', 'o'));
    expect(sql).toContain("o.fulfillment_source IS DISTINCT FROM 'WAREHOUSE'");
    expect(sql).toContain('o.is_deleted = false AND o.deleted_at IS NULL');
    expect(cancelReturnReceivedAtSql('"s"."order_tracking"', 'o')).toBe(
      'GREATEST(o.last_handover_at, (SELECT MAX(t.created_at) FROM "s"."order_tracking" t' +
        " WHERE t.order_id = o.id AND t.action = 'cancelled_post_received'))",
    );
  });
});

describe('vNKGbg5q — eslatma payload (market, «bekor» Telegram guruhi)', () => {
  it('turlar katalogda', () => {
    expect(isKnownNotificationType(CANCEL_RETURN_REMINDER_TYPE)).toBe(true);
    expect(isKnownNotificationType(CANCEL_RETURN_ESCALATED_TYPE)).toBe(true);
  });

  it('market bo‘yicha BITTA xabar: CANCEL guruhi, HTML matn, joylar va raqamlar, PII yo‘q', () => {
    const orders = [
      due({ id: '41', received_at: new Date(NOW.getTime() - 4 * DAY) }),
      due({ id: '36', received_at: new Date(NOW.getTime() - 9.5 * DAY) }),
      due({
        id: '50',
        stage: 'branch',
        place_id: '10',
        place_name: 'Urgut <filiali> & Co',
        received_at: new Date(NOW.getTime() - 3.2 * DAY),
      }),
    ];
    const payload = buildCancelReturnReminderPayload('37', orders, NOW)!;
    expect(payload).toEqual(
      expect.objectContaining({
        type: 'order.cancel_return_reminder',
        category: 'order',
        recipient_ids: ['37'],
        channels: ['in_app', 'realtime', 'telegram'],
        group_key: 'cancel_return:reminder:37',
        link: '/new-orders/cancelled/37',
        data: {
          market_id: '37',
          count: 3,
          oldest_days: 9,
          order_ids: ['36', '41', '50'],
          order_numbers: ['EL-100036', 'EL-100041', 'EL-100050'],
        },
      }),
    );
    expect(payload.telegram).toEqual({
      market_id: '37',
      group_type: Group_type.CANCEL,
      text: expect.any(String),
    });
    const text = payload.telegram!.text;
    expect(text).toContain('<b>⏳ Qaytarishlaringiz markazda kutmoqda</b>');
    expect(text).toContain(
      '3 ta bekor qilingan buyurtma olib ketilishini kutmoqda (eng keksasi 9 kun):',
    );
    expect(text).toContain('• Toshkent HQ — 2 ta');
    expect(text).toContain('• Urgut &lt;filiali&gt; &amp; Co — 1 ta');
    expect(text).toContain('Buyurtmalar: EL-100041, EL-100036, EL-100050');
    expect(text).toContain('olib keting.');
    expect(payload.body).toBe(
      '3 ta bekor qilingan buyurtma olib ketilishini kutmoqda (eng keksasi 9 kun).',
    );
  });

  it('client_request_id barqaror (outbox qayta yetkazsa dedup), boshqa to‘plam — boshqa id', () => {
    const a = buildCancelReturnReminderPayload(
      '37',
      [due({ id: '1' }), due({ id: '2' })],
      NOW,
    )!;
    const b = buildCancelReturnReminderPayload(
      '37',
      [due({ id: '2' }), due({ id: '1' })],
      NOW,
    )!;
    const c = buildCancelReturnReminderPayload('37', [due({ id: '3' })], NOW)!;
    expect(a.client_request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(a.client_request_id).toBe(b.client_request_id);
    expect(c.client_request_id).not.toBe(a.client_request_id);
  });

  it('joy nomi yo‘q — «HQ» / «Filial»; ko‘p buyurtma — «+N»', () => {
    const many = Array.from({ length: 33 }, (_, i) =>
      due({ id: String(100 + i), place_name: null }),
    );
    const text = buildCancelReturnReminderPayload('37', many, NOW)!.telegram!
      .text;
    expect(text).toContain('• HQ — 33 ta');
    expect(text).toContain('(+3)');
  });

  it('noto‘g‘ri market / bo‘sh ro‘yxat — payload yo‘q', () => {
    expect(buildCancelReturnReminderPayload('', [due()], NOW)).toBeNull();
    expect(buildCancelReturnReminderPayload('37', [], NOW)).toBeNull();
  });
});

describe('vNKGbg5q — eskalatsiya payload (admin navbati)', () => {
  it('kartadagi matn: «Buyurtma #N markazda 7 kundan beri turibdi — market olib ketmadi»; admin/superadmin, Telegram yo‘q', () => {
    const payload = buildCancelReturnEscalationPayload(
      due({ received_at: new Date(NOW.getTime() - 7.4 * DAY) }),
      NOW,
    )!;
    expect(payload).toEqual(
      expect.objectContaining({
        type: 'order.cancel_return_escalated',
        priority: 'high',
        title: 'Bekor buyurtma olib ketilmadi',
        body: 'Buyurtma #EL-100036 markazda 7 kundan beri turibdi — market olib ketmadi',
        roles: ['admin', 'superadmin'],
        channels: ['in_app', 'realtime'],
        group_key: 'cancel_return:escalated:36',
        link: '/orders/edit/36',
      }),
    );
    expect(payload.telegram).toBeUndefined();
    expect(payload.recipient_ids).toBeUndefined();
    expect(payload.data).toEqual(
      expect.objectContaining({
        order_id: '36',
        market_id: '37',
        stage: 'hq',
        days: 7,
      }),
    );
  });

  it('filialda — «filialda (Nom)»', () => {
    expect(
      buildCancelReturnEscalationPayload(
        due({
          stage: 'branch',
          place_name: 'Urgut filiali',
          received_at: new Date(NOW.getTime() - 8 * DAY),
        }),
        NOW,
      )!.body,
    ).toBe(
      'Buyurtma #EL-100036 filialda (Urgut filiali) 8 kundan beri turibdi — market olib ketmadi',
    );
  });
});

describe('vNKGbg5q — CancelReturnReminderScheduler', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const step = (overrides = {}) => ({
    locked: true,
    orders: 0,
    notifications: 0,
    hit_limit: false,
    ...overrides,
  });

  const make = (values: Record<string, unknown> = {}) => {
    const reminders = {
      remindMarkets: jest.fn().mockResolvedValue(step({ orders: 2 })),
      escalateStale: jest.fn().mockResolvedValue(step()),
    };
    const scheduler = new CancelReturnReminderScheduler(
      reminders as never,
      { get: env(values) } as never,
    );
    return { scheduler, reminders };
  };

  it('kuniga bir marta: 10:00 dan keyin ishlaydi, shu kun qayta tikda — yo‘q, ertasi — yana', async () => {
    const { scheduler, reminders } = make();
    expect(await scheduler.tick(tashkent('2026-10-26T09:40:00'))).toBeNull();
    expect(reminders.remindMarkets).not.toHaveBeenCalled();

    const run = await scheduler.tick(tashkent('2026-10-26T10:05:00'));
    expect(run?.day).toBe('2026-10-26');
    expect(reminders.remindMarkets).toHaveBeenCalledWith(
      tashkent('2026-10-23T10:00:00'),
      tashkent('2026-10-26T10:05:00'),
    );
    expect(reminders.escalateStale).toHaveBeenCalledWith(
      tashkent('2026-10-19T10:00:00'),
      tashkent('2026-10-26T10:05:00'),
    );

    expect(await scheduler.tick(tashkent('2026-10-26T10:15:00'))).toBeNull();
    expect(reminders.remindMarkets).toHaveBeenCalledTimes(1);

    await scheduler.tick(tashkent('2026-10-27T10:00:00'));
    expect(reminders.remindMarkets).toHaveBeenCalledTimes(2);
  });

  it('tungi taqiqda ishlamaydi', async () => {
    const { scheduler, reminders } = make();
    expect(await scheduler.tick(tashkent('2026-10-26T21:00:00'))).toBeNull();
    expect(reminders.remindMarkets).not.toHaveBeenCalled();
  });

  it("CANCEL_RETURN_REMINDER_ENABLED=false — umuman ishlamaydi (timer ham qo'yilmaydi)", async () => {
    const { scheduler, reminders } = make({
      CANCEL_RETURN_REMINDER_ENABLED: 'false',
    });
    const spy = jest.spyOn(global, 'setInterval');
    scheduler.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    expect(await scheduler.tick(tashkent('2026-10-26T11:00:00'))).toBeNull();
    expect(reminders.remindMarkets).not.toHaveBeenCalled();
  });

  it('qulf boshqa replikada yoki partiya to‘lgan — shu kun keyingi tikda davom etadi', async () => {
    const { scheduler, reminders } = make();
    reminders.remindMarkets.mockResolvedValueOnce(step({ locked: false }));
    await scheduler.tick(tashkent('2026-10-26T10:00:00'));
    reminders.escalateStale.mockResolvedValueOnce(step({ hit_limit: true }));
    await scheduler.tick(tashkent('2026-10-26T10:10:00'));
    await scheduler.tick(tashkent('2026-10-26T10:20:00'));
    await scheduler.tick(tashkent('2026-10-26T10:30:00'));
    expect(reminders.remindMarkets).toHaveBeenCalledTimes(3);
  });

  it('xato — yutiladi (servis yiqilmaydi), keyingi tikda qayta urinadi; bir vaqtda faqat bitta tik', async () => {
    const { scheduler, reminders } = make();
    reminders.remindMarkets.mockRejectedValueOnce(new Error('db down'));
    expect(await scheduler.tick(tashkent('2026-10-26T10:00:00'))).toBeNull();

    let release!: () => void;
    reminders.remindMarkets.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(step());
        }),
    );
    const first = scheduler.tick(tashkent('2026-10-26T10:10:00'));
    expect(await scheduler.tick(tashkent('2026-10-26T10:10:01'))).toBeNull();
    release();
    expect((await first)?.day).toBe('2026-10-26');
    expect(reminders.remindMarkets).toHaveBeenCalledTimes(2);
  });
});
