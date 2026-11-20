import {
  AUTO_CLOSE_DEFAULTS,
  REPORT_DEFAULTS,
  SHIFT_AUTOMATION_KEYS,
  ShiftSettingsError,
  autoCloseClaimKey,
  autoClosedLabel,
  dueCloseSlots,
  dueWarnSlots,
  missedCloseSlot,
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

    describe("o'tkazib yuborilgan yopish sloti (server ishlamagan)", () => {
      /** Toshkent vaqti → UTC lahza. */
      const T = (local: string) => new Date(`${local.replace(' ', 'T')}+05:00`);

      it('22:59 dan keyin tick yo‘q, 23:12 da qayta ishga tushdi — 23:00 sloti', () => {
        expect(
          missedCloseSlot(
            T('2026-11-20 23:12'),
            ['23:00'],
            T('2026-11-20 22:59'),
          )?.key,
        ).toBe('2026-11-20T23:00');
      });

      it("catch-up oynasi ichida — oddiy yo'l (dueCloseSlots), missed emas", () => {
        expect(
          missedCloseSlot(
            T('2026-11-20 23:05'),
            ['23:00'],
            T('2026-11-20 22:59'),
          ),
        ).toBeNull();
      });

      it("slotdan keyin tick bo'lgan (avtomatika o'chiq yoki yopish xatosi) — quvlanmaydi", () => {
        expect(
          missedCloseSlot(
            T('2026-11-20 23:30'),
            ['23:00'],
            T('2026-11-20 23:00'),
          ),
        ).toBeNull();
        expect(
          missedCloseSlot(
            T('2026-11-21 08:00'),
            ['23:00'],
            T('2026-11-20 23:04'),
          ),
        ).toBeNull();
      });

      it("yurak urishi yo'q (birinchi ishga tushish) / yaroqsiz / kelajakda — null", () => {
        const now = T('2026-11-20 23:30');
        expect(missedCloseSlot(now, ['23:00'], null)).toBeNull();
        expect(missedCloseSlot(now, ['23:00'], new Date('x'))).toBeNull();
        expect(
          missedCloseSlot(now, ['23:00'], T('2026-11-20 23:40')),
        ).toBeNull();
        expect(missedCloseSlot(now, [], T('2026-11-20 20:00'))).toBeNull();
      });

      it('yarim tun: 23:55 sloti, server 23:50 → 00:20 o‘chiq — kechagi slot', () => {
        expect(
          missedCloseSlot(
            T('2026-11-21 00:20'),
            ['23:55'],
            T('2026-11-20 23:50'),
          )?.key,
        ).toBe('2026-11-20T23:55');
      });

      it('kuniga bir necha vaqt, uzoq uzilish — faqat ENG OXIRGI o‘tgan slot', () => {
        expect(
          missedCloseSlot(
            T('2026-11-21 15:00'),
            ['14:00', '23:00'],
            T('2026-11-20 10:00'),
          )?.key,
        ).toBe('2026-11-21T14:00');
      });
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

    it("sukut: hisobot yuborish O'CHIQ — hech bir qabul qiluvchi × kanal yoqilmagan", () => {
      const off = { telegram: false, in_app: false };
      expect(readReportSettings(new Map())).toEqual({
        recipients: { superadmin: off, couriers: off, markets: off },
        format: 'pdf',
      });
      // Yaroqsiz / qisman saqlangan qiymat ham yoqilgan deb o'qilmaydi.
      expect(
        readReportSettings(
          new Map<string, unknown>([
            [
              SHIFT_AUTOMATION_KEYS.reportRecipients,
              { couriers: { telegram: 'yes' }, markets: null },
            ],
          ]),
        ).recipients,
      ).toEqual({ superadmin: off, couriers: off, markets: off });
      // Superadmin faqat bitta guruhni yoqsa — qolganlari o'chiq qoladi.
      const [[key, value]] = parseReportPatch(
        { recipients: { superadmin: { in_app: true } } },
        REPORT_DEFAULTS,
      );
      expect(key).toBe(SHIFT_AUTOMATION_KEYS.reportRecipients);
      expect(value).toEqual({
        superadmin: { telegram: false, in_app: true },
        couriers: off,
        markets: off,
      });
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
      const on = { telegram: true, in_app: true };
      const report = parseReportPatch(
        { recipients: { couriers: { telegram: false } }, format: 'xlsx' },
        {
          recipients: { superadmin: on, couriers: on, markets: on },
          format: 'pdf',
        },
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
