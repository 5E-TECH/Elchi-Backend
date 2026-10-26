import {
  AUTO_CLOSE_DEFAULTS,
  REPORT_DEFAULTS,
  SHIFT_AUTOMATION_KEYS,
  ShiftSettingsError,
  autoCloseClaimKey,
  autoClosedLabel,
  dueCloseSlots,
  dueWarnSlots,
  normalizeTimes,
  parseAutoClosePatch,
  parseReportPatch,
  readAutoCloseSettings,
  readReportSettings,
  slotInstant,
  tashkentClock,
  tashkentDay,
  warnClaimKey,
} from './shift-schedule.rules';

/**
 * y8Tqm9Ap — jadval qoidalari: slot, Toshkent vaqt zonasi, o'chirilgan holat,
 * ogohlantirish oynasi, sozlamalar validatsiyasi (DB'siz).
 */
describe('y8Tqm9Ap — smena jadvali qoidalari', () => {
  describe('vaqt zonasi (Asia/Tashkent = UTC+5)', () => {
    it('23:00 Toshkent = 18:00 UTC', () => {
      expect(slotInstant('2026-10-26', '23:00').toISOString()).toBe(
        '2026-10-26T18:00:00.000Z',
      );
      expect(tashkentClock(new Date('2026-10-26T18:00:00Z'))).toBe('23:00');
      expect(tashkentDay(new Date('2026-10-26T19:30:00Z'))).toBe('2026-10-27');
    });

    it('23:00 slot — 18:00:30 UTC da yopiladi, 23:00 UTC (04:00 Toshkent) da emas', () => {
      const due = dueCloseSlots(new Date('2026-10-26T18:00:30Z'), ['23:00']);
      expect(due.map((slot) => slot.key)).toEqual(['2026-10-26T23:00']);
      expect(
        dueCloseSlots(new Date('2026-10-26T23:00:30Z'), ['23:00']),
      ).toEqual([]);
    });

    it("slotdan oldin — yo'q; catch-up oynasidan keyin — yo'q", () => {
      expect(
        dueCloseSlots(new Date('2026-10-26T17:59:59Z'), ['23:00']),
      ).toEqual([]);
      expect(
        dueCloseSlots(new Date('2026-10-26T18:09:59Z'), ['23:00']),
      ).toHaveLength(1);
      expect(
        dueCloseSlots(new Date('2026-10-26T18:10:00Z'), ['23:00']),
      ).toEqual([]);
    });

    it('kuniga N marta: 14:00 va 23:00 alohida slot kalitlari', () => {
      expect(
        dueCloseSlots(new Date('2026-10-26T09:00:10Z'), ['14:00', '23:00']).map(
          (slot) => slot.key,
        ),
      ).toEqual(['2026-10-26T14:00']);
    });

    it('yarim tun: 23:55 slot, tick 00:02 (ertasi kun) — kechagi slot', () => {
      // 00:02 Toshkent 27-oktabr = 19:02 UTC 26-oktabr
      expect(
        dueCloseSlots(new Date('2026-10-26T19:02:00Z'), ['23:55']).map(
          (slot) => slot.key,
        ),
      ).toEqual(['2026-10-26T23:55']);
      // 00:05 slot, 23:58 da ogohlantirish (ertangi kun sloti)
      expect(
        dueWarnSlots(new Date('2026-10-26T18:58:00Z'), ['00:05'], 15).map(
          (slot) => slot.key,
        ),
      ).toEqual(['2026-10-27T00:05']);
    });

    it("ogohlantirish oynasi: slot − warn ≤ now < slot; warn=0 — yo'q", () => {
      expect(
        dueWarnSlots(new Date('2026-10-26T17:45:00Z'), ['23:00'], 15),
      ).toHaveLength(1);
      expect(
        dueWarnSlots(new Date('2026-10-26T17:44:59Z'), ['23:00'], 15),
      ).toHaveLength(0);
      expect(
        dueWarnSlots(new Date('2026-10-26T18:00:00Z'), ['23:00'], 15),
      ).toHaveLength(0);
      expect(
        dueWarnSlots(new Date('2026-10-26T17:50:00Z'), ['23:00'], 0),
      ).toEqual([]);
    });
  });

  it('idempotent kalitlar va banner matni', () => {
    expect(autoCloseClaimKey('12', '2026-10-26T23:00')).toBe(
      'auto_close:12:2026-10-26T23:00',
    );
    expect(warnClaimKey('12', '2026-10-26T23:00')).toBe(
      'warn:12:2026-10-26T23:00',
    );
    expect(autoClosedLabel(new Date('2026-10-26T18:00:20Z'))).toBe(
      'Avtomatik yopildi — 23:00, kassir yopmagan',
    );
  });

  describe('sozlamalar', () => {
    it("sukut: o'chiq (hech narsa yopilmaydi), 23:00, main, 15 daqiqa", () => {
      expect(readAutoCloseSettings(new Map())).toEqual(AUTO_CLOSE_DEFAULTS);
      expect(AUTO_CLOSE_DEFAULTS.enabled).toBe(false);
      expect(readReportSettings(new Map())).toEqual(REPORT_DEFAULTS);
    });

    it('normalizeTimes — tartib, takror, yaroqsiz', () => {
      expect(normalizeTimes(['23:00', '14:00', '14:00'])).toEqual([
        '14:00',
        '23:00',
      ]);
      expect(() => normalizeTimes(['24:00'])).toThrow(ShiftSettingsError);
      expect(() => normalizeTimes(['9:00'])).toThrow(ShiftSettingsError);
      expect(() => normalizeTimes('23:00')).toThrow(ShiftSettingsError);
      expect(() =>
        normalizeTimes(
          Array.from(
            { length: 13 },
            (_, i) => `${String(i).padStart(2, '0')}:00`,
          ),
        ),
      ).toThrow(ShiftSettingsError);
    });

    it('PATCH: faqat berilgan maydonlar, yaroqsizi — xato', () => {
      expect(
        parseAutoClosePatch({ enabled: true, times: ['23:00', '14:00'] }),
      ).toEqual([
        [SHIFT_AUTOMATION_KEYS.autoCloseEnabled, true],
        [SHIFT_AUTOMATION_KEYS.autoCloseTimes, ['14:00', '23:00']],
      ]);
      expect(() => parseAutoClosePatch({ scope: 'all' })).toThrow(
        ShiftSettingsError,
      );
      expect(() => parseAutoClosePatch({ warn_before_min: -1 })).toThrow(
        ShiftSettingsError,
      );
      expect(() => parseAutoClosePatch({ enabled: 'yes' })).toThrow(
        ShiftSettingsError,
      );
      const report = parseReportPatch(
        { recipients: { couriers: { telegram: false } }, format: 'xlsx' },
        REPORT_DEFAULTS,
      );
      expect(report[0][1]).toEqual({
        superadmin: { telegram: true, in_app: true },
        couriers: { telegram: false, in_app: true },
        markets: { telegram: true, in_app: true },
      });
      expect(report[1]).toEqual([SHIFT_AUTOMATION_KEYS.reportFormat, 'xlsx']);
      expect(() =>
        parseReportPatch({ recipients: { admins: {} } }, REPORT_DEFAULTS),
      ).toThrow(ShiftSettingsError);
      expect(() =>
        parseReportPatch({ format: 'csv' }, REPORT_DEFAULTS),
      ).toThrow(ShiftSettingsError);
    });
  });
});
