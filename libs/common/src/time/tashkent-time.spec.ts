import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TASHKENT_OFFSET_MINUTES,
  endOfTashkentDay,
  endOfTashkentMonth,
  parseDateOnly,
  startOfTashkentDay,
  startOfTashkentMonth,
  startOfTashkentWeek,
  tashkentDayRange,
} from './tashkent-time';

const iso = (date: Date | null | undefined) => date?.toISOString();
const at = (value: string) => new Date(value);

/**
 * ESKI analytics kodi (analytics-service.service.ts, SqVMuhKo'dan oldin) —
 * aynan ko'chirilgan "oracle". Yangi helper dashboard raqamlarini
 * o'zgartirmasligi shu nusxa bilan solishtirib isbotlanadi.
 */
const LEGACY_TASHKENT_OFFSET_MINUTES = 5 * 60;

function legacyParseDateOnly(value?: string): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function legacyTashkentBoundaryToUtc(date: Date, isEnd: boolean): Date {
  const offsetMs = LEGACY_TASHKENT_OFFSET_MINUTES * 60 * 1000;
  const shifted = new Date(date.getTime() + offsetMs);

  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();

  const utcMs =
    Date.UTC(
      y,
      m,
      d,
      isEnd ? 23 : 0,
      isEnd ? 59 : 0,
      isEnd ? 59 : 0,
      isEnd ? 999 : 0,
    ) - offsetMs;

  return new Date(utcMs);
}

function legacyWeekStart(now: Date): Date {
  const start = legacyTashkentBoundaryToUtc(now, false);
  const offsetMs = LEGACY_TASHKENT_OFFSET_MINUTES * 60 * 1000;
  const tashkentNow = new Date(now.getTime() + offsetMs);
  const daysSinceMonday = (tashkentNow.getUTCDay() + 6) % 7;
  return new Date(start.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
}

function legacyMonthStart(now: Date): Date {
  const start = legacyTashkentBoundaryToUtc(now, false);
  const offsetMs = LEGACY_TASHKENT_OFFSET_MINUTES * 60 * 1000;
  const tashkentNow = new Date(now.getTime() + offsetMs);
  const daysSinceMonthStart = tashkentNow.getUTCDate() - 1;
  return new Date(start.getTime() - daysSinceMonthStart * 24 * 60 * 60 * 1000);
}

describe('tashkent-time (SqVMuhKo)', () => {
  it('Toshkent siljishi — UTC+5 (300 daqiqa)', () => {
    expect(TASHKENT_OFFSET_MINUTES).toBe(300);
  });

  it("00:00-05:00 (Toshkent) oralig'i UTC kuniga emas, AYNI Toshkent kuniga tushadi", () => {
    // 2026-09-30T21:30Z = Toshkentda 1-oktabr, 02:30 (UTC bo'yicha hali 30-sentabr).
    const night = at('2026-09-30T21:30:00.000Z');
    expect(iso(startOfTashkentDay(night))).toBe('2026-09-30T19:00:00.000Z');
    expect(iso(endOfTashkentDay(night))).toBe('2026-10-01T18:59:59.999Z');
  });

  it('05:00 dan keyingi vaqt ham ayni kunga tushadi', () => {
    // 2026-10-01T01:00Z = Toshkentda 1-oktabr, 06:00.
    expect(iso(startOfTashkentDay(at('2026-10-01T01:00:00.000Z')))).toBe(
      '2026-09-30T19:00:00.000Z',
    );
  });

  it('kun chegarasi aynan Toshkent yarim tunida almashadi', () => {
    expect(iso(startOfTashkentDay(at('2026-10-01T18:59:59.999Z')))).toBe(
      '2026-09-30T19:00:00.000Z',
    );
    expect(iso(startOfTashkentDay(at('2026-10-01T19:00:00.000Z')))).toBe(
      '2026-10-01T19:00:00.000Z',
    );
    expect(iso(endOfTashkentDay(at('2026-10-01T19:00:00.000Z')))).toBe(
      '2026-10-02T18:59:59.999Z',
    );
  });

  it('oy va yil chegarasi', () => {
    expect(iso(startOfTashkentDay(at('2026-10-31T19:30:00.000Z')))).toBe(
      '2026-10-31T19:00:00.000Z',
    );
    expect(iso(startOfTashkentDay(at('2026-12-31T19:00:00.000Z')))).toBe(
      '2026-12-31T19:00:00.000Z',
    );
    expect(iso(endOfTashkentDay(at('2026-12-31T20:00:00.000Z')))).toBe(
      '2027-01-01T18:59:59.999Z',
    );
    expect(iso(endOfTashkentDay(at('2026-12-31T18:59:59.999Z')))).toBe(
      '2026-12-31T18:59:59.999Z',
    );
  });

  it('kabisa kuni (29-fevral)', () => {
    const leapDay = parseDateOnly('2028-02-29') as Date;
    expect(iso(startOfTashkentDay(leapDay))).toBe('2028-02-28T19:00:00.000Z');
    expect(iso(endOfTashkentDay(leapDay))).toBe('2028-02-29T18:59:59.999Z');
  });

  it('startOfTashkentWeek — Toshkent dushanbasi 00:00', () => {
    // Payshanba.
    expect(iso(startOfTashkentWeek(at('2026-10-01T10:00:00.000Z')))).toBe(
      '2026-09-27T19:00:00.000Z',
    );
    // Toshkentda dushanba 01:00, UTC bo'yicha hali yakshanba.
    expect(iso(startOfTashkentWeek(at('2026-10-04T20:00:00.000Z')))).toBe(
      '2026-10-04T19:00:00.000Z',
    );
    // Toshkentda yakshanba 23:30 — hafta hali tugamagan.
    expect(iso(startOfTashkentWeek(at('2026-10-04T18:30:00.000Z')))).toBe(
      '2026-09-27T19:00:00.000Z',
    );
    // Juma, yil chegarasidan o'tadigan hafta.
    expect(iso(startOfTashkentWeek(at('2027-01-01T10:00:00.000Z')))).toBe(
      '2026-12-27T19:00:00.000Z',
    );
  });

  it('startOfTashkentMonth — oyning 1-kuni 00:00 (Toshkent)', () => {
    expect(iso(startOfTashkentMonth(at('2026-10-15T10:00:00.000Z')))).toBe(
      '2026-09-30T19:00:00.000Z',
    );
    expect(iso(startOfTashkentMonth(at('2026-10-31T19:30:00.000Z')))).toBe(
      '2026-10-31T19:00:00.000Z',
    );
    expect(iso(startOfTashkentMonth(at('2026-12-31T19:30:00.000Z')))).toBe(
      '2026-12-31T19:00:00.000Z',
    );
  });

  it('endOfTashkentMonth — oyning oxirgi kuni 23:59:59.999 (Toshkent)', () => {
    expect(iso(endOfTashkentMonth(at('2026-10-15T10:00:00.000Z')))).toBe(
      '2026-10-31T18:59:59.999Z',
    );
    expect(iso(endOfTashkentMonth(at('2026-12-15T10:00:00.000Z')))).toBe(
      '2026-12-31T18:59:59.999Z',
    );
    expect(iso(endOfTashkentMonth(at('2026-12-31T19:30:00.000Z')))).toBe(
      '2027-01-31T18:59:59.999Z',
    );
    expect(iso(endOfTashkentMonth(at('2028-02-10T10:00:00.000Z')))).toBe(
      '2028-02-29T18:59:59.999Z',
    );
  });

  it("parseDateOnly — faqat aniq 'YYYY-MM-DD' (12:00 UTC)", () => {
    expect(iso(parseDateOnly('2026-10-01'))).toBe('2026-10-01T12:00:00.000Z');
    expect(iso(parseDateOnly(' 2026-10-01 '))).toBe('2026-10-01T12:00:00.000Z');
    expect(parseDateOnly('2026-10-01T00:00:00Z')).toBeNull();
    expect(parseDateOnly('2026-1-5')).toBeNull();
    expect(parseDateOnly('')).toBeNull();
    expect(parseDateOnly(undefined)).toBeNull();
    expect(parseDateOnly(null)).toBeNull();
  });

  describe('tashkentDayRange', () => {
    it('bir kun — Toshkent 00:00 dan 23:59:59.999 gacha (dashboard bilan bir xil)', () => {
      const range = tashkentDayRange('2026-10-01', '2026-10-01');
      expect(iso(range.start)).toBe('2026-09-30T19:00:00.000Z');
      expect(iso(range.end)).toBe('2026-10-01T18:59:59.999Z');
    });

    it("to'liq ISO qiymat o'zgarishsiz ishlatiladi", () => {
      const range = tashkentDayRange(
        '2026-10-01T03:00:00.000Z',
        '2026-10-01T04:00:00+05:00',
      );
      expect(iso(range.start)).toBe('2026-10-01T03:00:00.000Z');
      expect(iso(range.end)).toBe('2026-09-30T23:00:00.000Z');
    });

    it("bo'sh qiymat — filtr yo'q (barcha vaqt)", () => {
      const range = tashkentDayRange(undefined, '');
      expect(range.start).toBeUndefined();
      expect(range.end).toBeUndefined();
      expect(tashkentDayRange(null, null).start).toBeUndefined();
    });

    it("yaroqsiz qiymat Invalid Date bo'lib qaytadi (400 ni chaqiruvchi tashlaydi)", () => {
      const range = tashkentDayRange('abc', '2026-13-45');
      expect(Number.isNaN(range.start?.getTime())).toBe(true);
      expect(Number.isNaN(range.end?.getTime())).toBe(true);
    });

    it("tungi buyurtma ayni kunga tushadi, eski UTC oynasi esa uni noto'g'ri olardi", () => {
      const inRange = (value: Date, range: { start?: Date; end?: Date }) =>
        value.getTime() >= (range.start as Date).getTime() &&
        value.getTime() <= (range.end as Date).getTime();

      const oct1 = tashkentDayRange('2026-10-01', '2026-10-01');
      const sep30 = tashkentDayRange('2026-09-30', '2026-09-30');
      const nightOrder = at('2026-10-01T02:30:00+05:00');
      const nextNightOrder = at('2026-10-02T03:00:00+05:00');

      expect(inRange(nightOrder, oct1)).toBe(true);
      expect(inRange(nightOrder, sep30)).toBe(false);
      expect(inRange(nextNightOrder, oct1)).toBe(false);

      // Eski ro'yxat oynasi (UTC kuni) 2-oktabr tungi buyurtmasini 1-oktabrga
      // qo'shib yuborardi.
      const legacyUtcDay = {
        start: at('2026-10-01T00:00:00.000Z'),
        end: at('2026-10-01T23:59:59.999Z'),
      };
      expect(inRange(nextNightOrder, legacyUtcDay)).toBe(true);
    });
  });

  describe('eski analytics kodi bilan tenglik (dashboard raqamlari o`zgarmaydi)', () => {
    const QUARTER_HOUR_MS = 15 * 60 * 1000;
    const windows: Array<[string, string]> = [
      ['2026-12-27T00:00:00.000Z', '2027-01-03T00:00:00.000Z'],
      ['2028-02-27T00:00:00.000Z', '2028-03-02T00:00:00.000Z'],
      // Ishga tushirish kuni atrofi — sentabr/oktabr chegarasi.
      ['2026-09-28T00:00:00.000Z', '2026-10-06T00:00:00.000Z'],
    ];

    it.each(windows)(
      'har 15 daqiqada %s .. %s oralig`ida natija aynan bir xil',
      (from, to) => {
        const mismatches: string[] = [];
        for (
          let ms = at(from).getTime();
          ms <= at(to).getTime();
          ms += QUARTER_HOUR_MS
        ) {
          const now = new Date(ms);
          const checks: Array<[string, Date, Date]> = [
            [
              'startOfTashkentDay',
              startOfTashkentDay(now),
              legacyTashkentBoundaryToUtc(now, false),
            ],
            [
              'endOfTashkentDay',
              endOfTashkentDay(now),
              legacyTashkentBoundaryToUtc(now, true),
            ],
            [
              'startOfTashkentWeek',
              startOfTashkentWeek(now),
              legacyWeekStart(now),
            ],
            [
              'startOfTashkentMonth',
              startOfTashkentMonth(now),
              legacyMonthStart(now),
            ],
          ];
          for (const [name, actual, expected] of checks) {
            if (actual.getTime() !== expected.getTime()) {
              mismatches.push(
                `${name}(${now.toISOString()}): ${actual.toISOString()} != ${expected.toISOString()}`,
              );
            }
          }
        }
        expect(mismatches).toEqual([]);
      },
    );

    it('parseDateOnly har qanday satr uchun eski natijani beradi', () => {
      const samples = [
        '2026-10-01',
        ' 2026-10-01 ',
        '2026-02-30',
        '2026-13-45',
        '1970-01-01',
        '2026-10-01T00:00:00Z',
        '2026-1-5',
        '2026/10/01',
        'abc',
        '',
      ];
      for (const sample of samples) {
        expect(iso(parseDateOnly(sample))).toBe(
          iso(legacyParseDateOnly(sample)),
        );
      }
    });

    it.each([
      '2026-01-01',
      '2026-09-30',
      '2026-10-01',
      '2026-12-31',
      '2028-02-29',
    ])("tashkentDayRange('%s') dashboard formulasi bilan bir xil", (day) => {
      const range = tashkentDayRange(day, day);
      const legacyDay = legacyParseDateOnly(day) as Date;
      expect(iso(range.start)).toBe(
        iso(legacyTashkentBoundaryToUtc(legacyDay, false)),
      );
      expect(iso(range.end)).toBe(
        iso(legacyTashkentBoundaryToUtc(legacyDay, true)),
      );
    });
  });

  /**
   * Natija server TZ'iga bog'liq emasligi tuzilish bo'yicha kafolatlanadi:
   * modulda mahalliy vaqt getter/setter'lari (`setHours`, `getDate`, ...)
   * YO'Q, faqat `getUTC*` va `Date.UTC`. (Jest ichida `process.env.TZ` ni
   * almashtirish vaqt mintaqasini o'zgartirmaydi — shuning uchun TZ'ni
   * almashtirib solishtirish o'rniga manba tekshiriladi.)
   */
  it('faqat UTC API ishlatiladi — natija server TZ`iga bog`liq emas', () => {
    const localTimeApi =
      /\.(get|set)(FullYear|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds)\(|\.getTimezoneOffset\(|\.toLocale\w*\(/;
    // Tekshiruvning o'zi ishlashi (bo'sh o'tib ketmasligi) — namunada.
    expect('end.setHours(23, 59, 59, 999)').toMatch(localTimeApi);
    expect('shifted.getUTCDate()').not.toMatch(localTimeApi);

    const code = readFileSync(join(__dirname, 'tashkent-time.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('getUTCDate()');
    expect(code).not.toMatch(localTimeApi);
  });
});
