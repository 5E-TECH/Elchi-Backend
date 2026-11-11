import { isKnownNotificationType, SHIFT_SCHEDULE_CONFLICT } from '@app/common';
import {
  AUTO_OPEN_DEFAULTS,
  LATE_ALERT_DEFAULTS,
  SHIFT_AUTOMATION_KEYS,
  ShiftScheduleConflictError,
  ShiftSettingsError,
  applySettingEntries,
  assertShiftScheduleValid,
  autoOpenClaimKey,
  dueLateSlots,
  lateCloseClaimKey,
  lateOpenClaimKey,
  parseAutoOpenPatch,
  parseLateAlertPatch,
  readAutoCloseSettings,
  readAutoOpenSettings,
  readLateAlertSettings,
} from './shift-schedule.rules';
import { buildShiftLateAlertPayload } from '../notification/finance-notification.service';
import { buildShiftAutoOpenedMessage } from '../realtime/finance-realtime.service';

/**
 * «KUN TARTIBI» (ega 2026-11-11) — avtomatik ochish va kechikish xabari
 * qoidalari (DB'siz). Haqiqiy Postgres oqimi —
 * `shift-auto-open.kun-tartibi.pg.spec.ts`.
 */

const tashkent = (iso: string) => new Date(`${iso}+05:00`);
const K = SHIFT_AUTOMATION_KEYS;

describe('«Kun tartibi» — smena jadvali qoidalari', () => {
  describe('sozlamalarni o`qish', () => {
    it('sukut: auto_open o`chiq 09:00 main; late_alert o`chiq 15 daq, faqat in_app', () => {
      const map = new Map<string, unknown>();
      expect(readAutoOpenSettings(map)).toEqual(AUTO_OPEN_DEFAULTS);
      expect(readLateAlertSettings(map)).toEqual(LATE_ALERT_DEFAULTS);
      expect(LATE_ALERT_DEFAULTS).toEqual({
        enabled: false,
        grace_min: 15,
        channels: { telegram: false, in_app: true },
      });
    });

    it('yaroqsiz qiymat — sukutga tushadi', () => {
      const map = new Map<string, unknown>([
        [K.autoOpenEnabled, 'ha'],
        [K.autoOpenTimes, ['25:00']],
        [K.autoOpenScope, 'all'],
        [K.lateAlertGraceMin, 999],
        [K.lateAlertChannels, { telegram: 'yes', in_app: false }],
      ]);
      expect(readAutoOpenSettings(map)).toEqual(AUTO_OPEN_DEFAULTS);
      expect(readLateAlertSettings(map)).toEqual({
        enabled: false,
        grace_min: 15,
        channels: { telegram: false, in_app: false },
      });
    });
  });

  describe('PATCH', () => {
    it('auto_open — faqat berilgan maydonlar, vaqtlar tartiblanadi', () => {
      expect(
        parseAutoOpenPatch({
          enabled: true,
          times: ['09:00', '08:30', '09:00'],
        }),
      ).toEqual([
        [K.autoOpenEnabled, true],
        [K.autoOpenTimes, ['08:30', '09:00']],
      ]);
      expect(parseAutoOpenPatch(undefined)).toEqual([]);
    });

    it.each([
      [{ enabled: 'ha' }],
      [{ times: ['9:00'] }],
      [{ scope: 'all' }],
      ['matn'],
    ])('auto_open yaroqsiz %p — xato', (input) => {
      expect(() => parseAutoOpenPatch(input)).toThrow(ShiftSettingsError);
    });

    it('late_alert — channels qisman birlashtiriladi', () => {
      expect(
        parseLateAlertPatch(
          { grace_min: 20, channels: { telegram: true } },
          LATE_ALERT_DEFAULTS,
        ),
      ).toEqual([
        [K.lateAlertGraceMin, 20],
        [K.lateAlertChannels, { telegram: true, in_app: true }],
      ]);
    });

    it.each([
      [{ grace_min: 181 }],
      [{ grace_min: 1.5 }],
      [{ grace_min: '15' }],
      [{ channels: { sms: true } }],
      [{ channels: { telegram: 'yes' } }],
      [{ enabled: 1 }],
    ])('late_alert yaroqsiz %p — xato', (input) => {
      expect(() => parseLateAlertPatch(input, LATE_ALERT_DEFAULTS)).toThrow(
        ShiftSettingsError,
      );
    });

    it('PATCH dan keyingi jadval tekshiruvi — ochish ∩ yopish, vaqtsiz ochish, kanalsiz xabar', () => {
      const base = new Map<string, unknown>([[K.autoCloseTimes, ['23:00']]]);
      const next = (entries: Array<[string, unknown]>) => {
        const map = applySettingEntries(base, entries);
        return {
          auto_open: readAutoOpenSettings(map),
          auto_close: readAutoCloseSettings(map),
          late_alert: readLateAlertSettings(map),
        };
      };
      let conflict: unknown;
      try {
        assertShiftScheduleValid(next([[K.autoOpenTimes, ['09:00', '23:00']]]));
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(ShiftScheduleConflictError);
      expect((conflict as ShiftScheduleConflictError).times).toEqual(['23:00']);
      expect(SHIFT_SCHEDULE_CONFLICT).toBe('SHIFT_SCHEDULE_CONFLICT');

      expect(() =>
        assertShiftScheduleValid(
          next([
            [K.autoOpenEnabled, true],
            [K.autoOpenTimes, []],
          ]),
        ),
      ).toThrow(ShiftSettingsError);
      expect(() =>
        assertShiftScheduleValid(
          next([
            [K.lateAlertEnabled, true],
            [K.lateAlertChannels, { telegram: false, in_app: false }],
          ]),
        ),
      ).toThrow(ShiftSettingsError);
      expect(() =>
        assertShiftScheduleValid(next([[K.autoOpenEnabled, true]])),
      ).not.toThrow();
    });
  });

  describe('dueLateSlots — slot + grace oynasi', () => {
    it('09:00, grace 15 — 09:15 dan 09:25 gacha (catch-up 10 daq)', () => {
      const at = (clock: string) =>
        dueLateSlots(tashkent(`2026-11-11T${clock}:00`), ['09:00'], 15).map(
          (slot) => slot.key,
        );
      expect(at('09:14')).toEqual([]);
      expect(at('09:15')).toEqual(['2026-11-11T09:00']);
      expect(at('09:24')).toEqual(['2026-11-11T09:00']);
      expect(at('09:25')).toEqual([]);
    });

    it('yarim tun atrofi — kechagi 23:55 sloti ertasi 00:05 da', () => {
      expect(
        dueLateSlots(tashkent('2026-11-12T00:05:00'), ['23:55'], 10).map(
          (slot) => slot.key,
        ),
      ).toEqual(['2026-11-11T23:55']);
    });
  });

  it('kalitlar — kassa / smena × slot', () => {
    expect(autoOpenClaimKey('0', '2026-11-11T09:00')).toBe(
      'auto_open:0:2026-11-11T09:00',
    );
    expect(lateOpenClaimKey('13', '2026-11-11T09:00')).toBe(
      'late_open:13:2026-11-11T09:00',
    );
    expect(lateCloseClaimKey('77', '2026-11-11T23:00')).toBe(
      'late_close:77:2026-11-11T23:00',
    );
  });
});

describe('«Kun tartibi» — kechikish xabari payload', () => {
  const base = {
    kind: 'open' as const,
    cashbox_user_id: '0',
    slot: '2026-11-11T09:00',
    time: '09:00',
    grace_min: 15,
    recipient_ids: ['1', '2', '1', 'x'],
    channels: { telegram: true, in_app: true },
  };

  it('tur katalogda; ochilmadi — superadminlar, kanallar, deterministik id', () => {
    expect(isKnownNotificationType('finance.shift_late')).toBe(true);
    const payload = buildShiftLateAlertPayload(base);
    expect(payload).toMatchObject({
      type: 'finance.shift_late',
      title: '⚠️ Smena vaqtida ochilmadi',
      recipient_ids: ['1', '2'],
      channels: ['in_app', 'realtime', 'telegram'],
      link: '/payments/main-cashbox',
      data: {
        kind: 'open',
        cashbox_type: 'main',
        branch_id: null,
        failed: false,
      },
    });
    expect(payload?.body).toContain("15 daqiqa o'tib ham ochilmagan");
    expect(payload?.client_request_id).toBe(
      buildShiftLateAlertPayload(base)?.client_request_id,
    );
  });

  it('yopilmadi + tizim xatosi — sabab matnda, filial', () => {
    const payload = buildShiftLateAlertPayload({
      ...base,
      kind: 'close',
      cashbox_user_id: '13',
      shift_id: '77',
      reason: 'qulf band',
      channels: { telegram: false, in_app: true },
    });
    expect(payload).toMatchObject({
      title: '⚠️ Smena vaqtida yopilmadi',
      channels: ['in_app', 'realtime'],
      data: {
        kind: 'close',
        cashbox_type: 'branch',
        branch_id: '13',
        shift_id: '77',
        failed: true,
      },
    });
    expect(payload?.body).toContain('Filial #13 kassasida smena #77');
    expect(payload?.body).toContain('tizim yopa olmadi: qulf band');
  });

  it('kanal yoki oluvchi yo`q — yuborilmaydi', () => {
    expect(
      buildShiftLateAlertPayload({
        ...base,
        channels: { telegram: false, in_app: false },
      }),
    ).toBeNull();
    expect(
      buildShiftLateAlertPayload({ ...base, recipient_ids: [] }),
    ).toBeNull();
  });
});

describe('«Kun tartibi» — realtime finance.shift.auto_opened', () => {
  it('asosiy kassa — MAIN rollari, ochuvchi xodim yo`q', () => {
    const message = buildShiftAutoOpenedMessage({
      id: '5',
      cashbox_user_id: '0',
      opened_by: null,
      opened_at: '2026-11-11T04:00:00.000Z',
    });
    expect(message).toEqual({
      event: 'finance.shift.auto_opened',
      payload: {
        shift_id: '5',
        cashbox_user_id: '0',
        cashbox_type: 'main',
        branch_id: null,
        status: 'open',
        open_reason: 'auto',
        opened_at: '2026-11-11T04:00:00.000Z',
      },
      targets: [
        { role: 'superadmin' },
        { role: 'admin' },
        { role: 'registrator' },
      ],
    });
  });

  it('filial kassasi — faqat o`sha filial menejerlari', () => {
    expect(
      buildShiftAutoOpenedMessage({ id: '6', cashbox_user_id: '13' }).targets,
    ).toEqual([{ role: 'manager', branch_id: '13' }]);
  });
});
