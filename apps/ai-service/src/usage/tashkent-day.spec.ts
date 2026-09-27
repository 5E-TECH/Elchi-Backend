import {
  addDaysYmd,
  isYmd,
  nextTashkentMidnight,
  tashkentDay,
  tashkentDayStartIso,
  TASHKENT_DAY_SQL,
} from './tashkent-day';

describe('tashkent-day (lYVuADRE #12/#23, wFSMEIIy #11/#12/#18)', () => {
  it('lYVuADRE #12: Toshkent 23:30 va 00:30 TURLI bucketlarga tushadi', () => {
    // 23:30 Toshkent = 18:30 UTC; 00:30 Toshkent = 19:30 UTC.
    expect(tashkentDay(new Date('2026-09-26T18:30:00Z'))).toBe('2026-09-26');
    expect(tashkentDay(new Date('2026-09-26T19:30:00Z'))).toBe('2026-09-27');
  });

  it('lYVuADRE #23: UTC yarim tunida kun Toshkent bo`yicha (UTC bo`yicha EMAS)', () => {
    // UTC 23:59 (26-kun) va UTC 00:00 (27-kun) — Toshkentda ikkalasi 27-kun.
    expect(tashkentDay(new Date('2026-09-26T23:59:59Z'))).toBe('2026-09-27');
    expect(tashkentDay(new Date('2026-09-27T00:00:00Z'))).toBe('2026-09-27');
  });

  it('wFSMEIIy #11: period_key Toshkent yarim tunida aniq almashadi', () => {
    expect(tashkentDay(new Date('2026-09-26T18:59:59.999Z'))).toBe(
      '2026-09-26',
    );
    expect(tashkentDay(new Date('2026-09-26T19:00:00.000Z'))).toBe(
      '2026-09-27',
    );
    // Oy va yil chegarasi.
    expect(tashkentDay(new Date('2026-09-30T19:00:00Z'))).toBe('2026-10-01');
    expect(tashkentDay(new Date('2026-12-31T19:00:00Z'))).toBe('2027-01-01');
  });

  it('wFSMEIIy #12: reset_at — keyingi Toshkent yarim tuni, doim kelajakda', () => {
    const cases = [
      '2026-09-26T19:00:00Z', // aynan yarim tun
      '2026-09-27T06:00:00Z', // kunduz
      '2026-09-27T18:59:59Z', // yarim tundan 1s oldin
    ];
    for (const iso of cases) {
      const now = new Date(iso);
      const reset = nextTashkentMidnight(now);
      expect(reset).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\+05:00$/);
      expect(new Date(reset).getTime()).toBeGreaterThan(now.getTime());
      expect(new Date(reset).getTime() - now.getTime()).toBeLessThanOrEqual(
        24 * 3600 * 1000,
      );
    }
    expect(nextTashkentMidnight(new Date('2026-09-27T06:00:00Z'))).toBe(
      '2026-09-28T00:00:00+05:00',
    );
  });

  it('wFSMEIIy #18: reset_at paytida period_key yangi kunga o`tadi (hisoblagich nol)', () => {
    const now = new Date('2026-09-27T10:00:00Z');
    const reset = new Date(nextTashkentMidnight(now));
    expect(tashkentDay(reset)).toBe(addDaysYmd(tashkentDay(now), 1));
    expect(tashkentDay(new Date(reset.getTime() - 1))).toBe(tashkentDay(now));
  });

  it('SQL bucket ifodasi Asia/Tashkent bo`yicha', () => {
    expect(TASHKENT_DAY_SQL).toBe(
      `("createdAt" AT TIME ZONE 'Asia/Tashkent')::date`,
    );
  });

  it('yordamchilar: isYmd, addDaysYmd, tashkentDayStartIso', () => {
    expect(isYmd('2026-09-27')).toBe(true);
    expect(isYmd('2026-02-31')).toBe(false);
    expect(isYmd('2026-9-27')).toBe(false);
    expect(isYmd(undefined)).toBe(false);
    expect(addDaysYmd('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysYmd('2026-01-01', -1)).toBe('2025-12-31');
    expect(tashkentDayStartIso('2026-09-27')).toBe('2026-09-27T00:00:00+05:00');
    expect(new Date(tashkentDayStartIso('2026-09-27')).toISOString()).toBe(
      '2026-09-26T19:00:00.000Z',
    );
  });
});
