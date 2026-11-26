import {
  addDayKey,
  businessDayChangeTimeFor,
  businessDayEnd,
  businessDayKey,
  businessDayKeySql,
  businessDayLocalSql,
  businessDayRange,
  businessDayStart,
  configuredBusinessDayTime,
  endOfBusinessDay,
  endOfBusinessMonth,
  getBusinessDaySchedule,
  normalizeBusinessDaySchedule,
  parseStoredBusinessDay,
  planBusinessDayChange,
  setBusinessDaySchedule,
  startOfBusinessDay,
  startOfBusinessMonth,
  startOfBusinessWeek,
  type BusinessDayRule,
} from './business-day';
import {
  endOfTashkentDay,
  endOfTashkentMonth,
  startOfTashkentDay,
  startOfTashkentMonth,
  startOfTashkentWeek,
  tashkentDayRange,
} from './tashkent-time';
import { resolveOrderIntakeState } from '../order/order-intake';

/** Toshkent devor soati → UTC lahza ('2026-11-27 00:59'). */
const tk = (local: string) =>
  new Date(
    `${local.replace(' ', 'T')}${local.length > 10 ? ':00' : 'T00:00:00'}+05:00`,
  );
const iso = (date?: Date) => date?.toISOString();

const FIVE: BusinessDayRule[] = [{ from: '2026-01-01', time: '05:00' }];

afterEach(() => setBusinessDaySchedule([]));

describe('xhiXv3w3 — ish kuni (kun almashish soati)', () => {
  describe('sukut 00:00 — tashkent-time.ts bilan AYNI (mezon 2)', () => {
    // Har 37 daqiqada 3 oy — yarim tun, oy/hafta chegaralari ham tushadi.
    const instants: Date[] = [];
    for (
      let t = tk('2026-09-28 00:00').getTime();
      t < tk('2027-01-03 00:00').getTime();
      t += 37 * 60_000
    ) {
      instants.push(new Date(t));
    }
    instants.push(tk('2026-11-26 23:59'), tk('2026-11-27 00:00'));

    it("kun / hafta / oy chegaralari o'zgarmaydi", () => {
      for (const at of instants) {
        expect(iso(startOfBusinessDay(at))).toBe(iso(startOfTashkentDay(at)));
        expect(iso(endOfBusinessDay(at))).toBe(iso(endOfTashkentDay(at)));
        expect(iso(startOfBusinessWeek(at))).toBe(iso(startOfTashkentWeek(at)));
        expect(iso(startOfBusinessMonth(at))).toBe(
          iso(startOfTashkentMonth(at)),
        );
        expect(iso(endOfBusinessMonth(at))).toBe(iso(endOfTashkentMonth(at)));
      }
    });

    it("businessDayRange === tashkentDayRange (sana, ISO, bo'sh, yaroqsiz)", () => {
      const cases: Array<[string | undefined, string | undefined]> = [
        ['2026-10-01', '2026-10-01'],
        ['2026-02-28', '2026-03-31'],
        ['2026-02-30', '2026-02-30'],
        ['2026-10-01T10:00:00.000Z', '2026-10-02T10:00:00.000Z'],
        [undefined, undefined],
        ['', ''],
      ];
      for (const [start, end] of cases) {
        const a = businessDayRange(start, end);
        const b = tashkentDayRange(start, end);
        expect(iso(a.start)).toBe(iso(b.start));
        expect(iso(a.end)).toBe(iso(b.end));
      }
      const bad = businessDayRange('nima', 'nima');
      expect(Number.isNaN(bad.start?.getTime())).toBe(true);
      expect(Number.isNaN(bad.end?.getTime())).toBe(true);
    });

    it("SQL ifodasi — eski Toshkent ifodasining o'zi", () => {
      expect(businessDayLocalSql('o."createdAt"')).toBe(
        `(o."createdAt" AT TIME ZONE 'Asia/Tashkent')`,
      );
      expect(businessDayKeySql('h."createdAt"')).toBe(
        `to_char((h."createdAt" AT TIME ZONE 'Asia/Tashkent'), 'YYYY-MM-DD')`,
      );
    });
  });

  describe('05:00 — 00:59 va 01:30 kechagi ish kuniga (mezon 1)', () => {
    beforeEach(() => setBusinessDaySchedule(FIVE));

    it('buyurtma vaqtlari → ish kuni sanasi', () => {
      expect(businessDayKey(tk('2026-11-27 00:59'))).toBe('2026-11-26');
      expect(businessDayKey(tk('2026-11-27 01:30'))).toBe('2026-11-26');
      expect(businessDayKey(tk('2026-11-27 04:59'))).toBe('2026-11-26');
      expect(businessDayKey(tk('2026-11-27 05:00'))).toBe('2026-11-27');
      expect(businessDayKey(tk('2026-11-27 23:59'))).toBe('2026-11-27');
    });

    it('«26-noyabr» = 26.11 05:00 → 27.11 05:00 (filtr chegarasi)', () => {
      const range = businessDayRange('2026-11-26', '2026-11-26');
      expect(iso(range.start)).toBe(iso(tk('2026-11-26 05:00')));
      expect(iso(range.end)).toBe(
        iso(new Date(tk('2026-11-27 05:00').getTime() - 1)),
      );
      // 100 + 20 misoli: yarim tundan keyingi 20 ta ham shu kunda.
      const late = tk('2026-11-27 00:59');
      expect(late >= range.start! && late <= range.end!).toBe(true);
    });

    it('hafta — dushanba 05:00, oy — 1-kun 05:00 (mezon 4)', () => {
      // 2026-11-30 dushanba; 01.12 02:00 — hali 30-noyabr ish kuni.
      expect(iso(startOfBusinessWeek(tk('2026-12-01 02:00')))).toBe(
        iso(tk('2026-11-30 05:00')),
      );
      expect(iso(startOfBusinessWeek(tk('2026-11-30 04:00')))).toBe(
        iso(tk('2026-11-23 05:00')),
      );
      expect(iso(startOfBusinessMonth(tk('2026-12-01 03:00')))).toBe(
        iso(tk('2026-11-01 05:00')),
      );
      expect(iso(endOfBusinessMonth(tk('2026-11-15 12:00')))).toBe(
        iso(new Date(tk('2026-12-01 05:00').getTime() - 1)),
      );
    });

    it('SQL ifodasi soatni siljitadi', () => {
      expect(businessDayKeySql('c')).toContain(`interval '300 minutes'`);
    });
  });

  it('18:00 — kun kecha kechqurun boshlanadi (qabul oynasi qoidasi)', () => {
    const rules = [{ from: '2026-01-01', time: '18:00' }];
    expect(iso(businessDayStart('2026-11-10', rules))).toBe(
      iso(tk('2026-11-09 18:00')),
    );
    expect(businessDayKey(tk('2026-11-09 18:00'), rules)).toBe('2026-11-10');
    expect(businessDayKey(tk('2026-11-09 17:59'), rules)).toBe('2026-11-09');
  });

  describe('FAQAT OLDINGA — effective_from (5a)', () => {
    it('26.11 14:00 da 00:00 → 05:00: 27.11 dan, 26.11 29 soat', () => {
      const plan = planBusinessDayChange([], '05:00', tk('2026-11-26 14:00'));
      expect(plan.effectiveFrom).toBe('2026-11-27');
      expect(iso(plan.effectiveAt)).toBe(iso(tk('2026-11-27 05:00')));
      const rules = plan.schedule;
      expect(rules).toEqual([{ from: '2026-11-27', time: '05:00' }]);
      // Eski kunlar o'zgarmaydi.
      expect(iso(businessDayStart('2026-11-25', rules))).toBe(
        iso(tk('2026-11-25 00:00')),
      );
      expect(iso(businessDayEnd('2026-11-25', rules))).toBe(
        iso(new Date(tk('2026-11-26 00:00').getTime() - 1)),
      );
      // Joriy kun yangi chegarada tugaydi; 27.11 01:30 — hali 26-noyabr.
      expect(iso(businessDayStart('2026-11-26', rules))).toBe(
        iso(tk('2026-11-26 00:00')),
      );
      expect(businessDayKey(tk('2026-11-27 01:30'), rules)).toBe('2026-11-26');
      expect(businessDayKey(tk('2026-11-27 05:00'), rules)).toBe('2026-11-27');
      expect(businessDayChangeTimeFor('2026-11-26', rules)).toBe('00:00');
      expect(businessDayChangeTimeFor('2026-11-27', rules)).toBe('05:00');
    });

    it("05:00 → 00:00 kechasi 02:00 da: o'tgan chegara qayta ishlatilmaydi", () => {
      const now = tk('2026-11-27 02:00'); // hali 26-noyabr ish kuni
      const plan = planBusinessDayChange(FIVE, '00:00', now);
      // 27.11 00:00 o'tib ketgan → 28.11 dan.
      expect(plan.effectiveFrom).toBe('2026-11-28');
      const rules = plan.schedule;
      expect(businessDayKey(now, rules)).toBe('2026-11-26');
      expect(iso(businessDayStart('2026-11-27', rules))).toBe(
        iso(tk('2026-11-27 05:00')),
      );
      expect(iso(businessDayStart('2026-11-28', rules))).toBe(
        iso(tk('2026-11-28 00:00')),
      );
    });

    it('kamida 5 daqiqa oldin: 23:58 da 05:00 → ertaga, 00:02 → indinga', () => {
      const plan = planBusinessDayChange([], '05:00', tk('2026-11-26 23:58'));
      expect(plan.effectiveFrom).toBe('2026-11-27');
      const close = planBusinessDayChange([], '00:02', tk('2026-11-26 23:58'));
      // 27.11 00:02 — 4 daqiqa qoldi, zaxira yetmaydi → 28.11.
      expect(close.effectiveFrom).toBe('2026-11-28');
    });

    it('kutilayotgan qoida almashtiriladi, ortiqcha qoida qolmaydi', () => {
      const first = planBusinessDayChange([], '05:00', tk('2026-11-26 14:00'));
      const back = planBusinessDayChange(
        first.schedule,
        '00:00',
        tk('2026-11-26 15:00'),
      );
      expect(back.schedule).toEqual([]);
      expect(configuredBusinessDayTime(back.schedule)).toBe('00:00');
      expect(configuredBusinessDayTime(first.schedule)).toBe('05:00');
    });

    it("kunlar ketma-ket — bo'shliq / ustma-ust yo'q (har xil o'tishlar)", () => {
      const times = ['00:00', '05:00', '11:59', '12:00', '18:00', '23:59'];
      for (const from of times) {
        for (const to of times) {
          if (from === to) continue;
          const base = normalizeBusinessDaySchedule([
            { from: '2026-01-01', time: from },
          ]);
          for (const hour of ['03:00', '13:00', '23:30']) {
            const now = tk(`2026-11-26 ${hour}`);
            const { schedule } = planBusinessDayChange(base, to, now);
            // Hozirgi ish kuni o'zgarmaydi (o'tmish qayta yozilmaydi).
            expect(businessDayKey(now, schedule)).toBe(
              businessDayKey(now, base),
            );
            let key = '2026-11-20';
            for (let i = 0; i < 12; i += 1) {
              const end = businessDayEnd(key, schedule).getTime();
              const next = addDayKey(key, 1);
              expect(businessDayStart(next, schedule).getTime()).toBe(end + 1);
              expect(end).toBeGreaterThan(
                businessDayStart(key, schedule).getTime(),
              );
              key = next;
            }
          }
        }
      }
    });
  });

  it('jadval saqlash shakli va global holat', () => {
    expect(parseStoredBusinessDay({ time: '05:00' })).toEqual([]);
    expect(
      parseStoredBusinessDay({
        time: '05:00',
        schedule: [
          { from: '2026-11-27', time: '05:00' },
          { from: 'xato', time: '05:00' },
          { from: '2026-11-20', time: '25:00' },
        ],
      }),
    ).toEqual([{ from: '2026-11-27', time: '05:00' }]);
    setBusinessDaySchedule(FIVE);
    expect(getBusinessDaySchedule()).toEqual(FIVE);
    setBusinessDaySchedule('buzuq');
    expect(getBusinessDaySchedule()).toEqual([]);
  });

  it("«Kun tartibi» holati — o'tish kuni va keyingi kun", () => {
    const schedule = [{ from: '2026-11-27', time: '05:00' }];
    const today = resolveOrderIntakeState({
      now: tk('2026-11-26 14:00'),
      schedule,
      cutoff: { cutoff_time: '10:00' },
    });
    expect(today.date).toBe('2026-11-26');
    expect(today.day_change_time).toBe('05:00');
    expect(today.current_day_change_time).toBe('00:00');
    expect(today.day_change_effective_from).toBe('2026-11-27');
    expect(today.day_started_at).toBe(iso(tk('2026-11-26 00:00')));
    expect(today.next_day_change_at).toBe(iso(tk('2026-11-27 05:00')));
    expect(today.closes_at).toBe(iso(tk('2026-11-26 10:00')));
    expect(today.reopens_at).toBe(iso(tk('2026-11-27 05:00')));
    expect(today.is_open).toBe(false);
    // 27.11 01:30 — hali 26-noyabr ish kuni, qabul yopiq.
    const night = resolveOrderIntakeState({
      now: tk('2026-11-27 01:30'),
      schedule,
      cutoff: { cutoff_time: '10:00' },
    });
    expect(night.date).toBe('2026-11-26');
    expect(night.is_open).toBe(false);
    const next = resolveOrderIntakeState({
      now: tk('2026-11-27 06:00'),
      schedule,
      cutoff: { cutoff_time: '10:00' },
    });
    expect(next.date).toBe('2026-11-27');
    expect(next.is_open).toBe(true);
    expect(next.closes_at).toBe(iso(tk('2026-11-27 10:00')));
    expect(next.current_day_change_time).toBe('05:00');
  });
});
