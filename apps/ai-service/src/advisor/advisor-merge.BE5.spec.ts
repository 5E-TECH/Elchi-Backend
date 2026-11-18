import type { AiAdvisorCandidate } from '@app/common';
import { mergeR1 } from './advisor-merge';
import { catchingUp, r6Periods } from './advisor-engine.service';

const row = (id: string, at: string, diff: number) => ({
  shift_id: id,
  closed_at: at,
  difference: diff,
});

describe('mergeR1 (BE-5 round-2 #651 B1)', () => {
  const stored = {
    facts: {
      trigger: 'single_shortage',
      shifts_count: 1,
      total_difference: -120000,
      last_difference: -120000,
      closed_by: [{ id: '5', name: 'Ali' }],
      last_shift_id: '1',
    },
    evidence: {
      kind: 'shifts',
      rows: [row('1', '2026-10-21T08:10:00.000Z', -120000)],
    },
  };
  const candidate = (
    over: Partial<AiAdvisorCandidate> = {},
  ): AiAdvisorCandidate => ({
    rule_key: 'R1',
    dedup_key: 'R1:cashbox:7',
    fact_keys: [
      { fact_key: '3', fact_at: '2026-10-22T08:10:00.000Z', amount: -80000 },
    ],
    branch: null,
    subject: { kind: 'cashbox', id: '7', name: null },
    headline_amount: -80000,
    facts: {
      trigger: 'single_shortage',
      shifts_count: 1,
      total_difference: -80000,
      last_difference: -80000,
      closed_by: [{ id: '6', name: 'Vali' }],
      last_shift_id: '3',
    },
    evidence: {
      kind: 'shifts',
      rows: [row('3', '2026-10-22T08:10:00.000Z', -80000)],
      totals: { count: 1, difference: -80000 },
    },
    ...over,
  });

  it('#704 S1: ketma-ketlik — headline_amount sarlavhadagi streak_total bilan mos (yangi alertda ham)', () => {
    const c = candidate({
      facts: {
        trigger: 'consecutive_negative',
        shifts_count: 2,
        total_difference: -130000,
        last_difference: -10000,
        closed_by: [],
        last_shift_id: '3',
        streak_length: 2,
        streak_total: -130000,
      },
      fact_keys: [
        { fact_key: '3', fact_at: '2026-10-22T08:10:00.000Z', amount: -10000 },
      ],
    });
    const m = mergeR1({ facts: {}, evidence: {} }, c, new Set(['3']));
    expect(m.facts).toMatchObject({
      shifts_count: 1,
      total_difference: -10000,
    });
    expect(m.headline_amount).toBe(-130000);
  });

  it('ikki tick: faktlar va dalil birlashadi (shifts_count 2, jami −200 000)', () => {
    const m = mergeR1(stored, candidate(), new Set(['3']));
    expect(m.facts).toMatchObject({
      shifts_count: 2,
      total_difference: -200000,
      last_difference: -80000,
      last_shift_id: '3',
      closed_by: [
        { id: '6', name: 'Vali' },
        { id: '5', name: 'Ali' },
      ],
    });
    expect(m.evidence).toMatchObject({
      total_rows: 2,
      truncated: false,
      totals: { count: 2, difference: -200000 },
    });
    expect(
      (m.evidence.rows as Array<{ shift_id: string }>).map((r) => r.shift_id),
    ).toEqual(['1', '3']);
    expect(m.headline_amount).toBe(-80000);
  });

  it('ketma-ketlik davomi: allaqachon ko‘rilgan smenalar qayta qo‘shilmaydi', () => {
    const streak = candidate({
      fact_keys: [
        { fact_key: '1', fact_at: '2026-10-21T08:10:00.000Z', amount: -120000 },
        { fact_key: '3', fact_at: '2026-10-22T08:10:00.000Z', amount: -80000 },
      ],
      facts: {
        ...candidate().facts,
        trigger: 'consecutive_negative',
        streak_length: 2,
        streak_total: -200000,
      },
      evidence: {
        kind: 'shifts',
        rows: [
          row('1', '2026-10-21T08:10:00.000Z', -120000),
          row('3', '2026-10-22T08:10:00.000Z', -80000),
        ],
      },
    });
    const m = mergeR1(stored, streak, new Set(['3']));
    expect(m.facts).toMatchObject({
      trigger: 'consecutive_negative',
      shifts_count: 2,
      total_difference: -200000,
      streak_length: 2,
    });
    expect(m.headline_amount).toBe(-200000);
    expect((m.evidence.rows as unknown[]).length).toBe(2);
  });

  it('dalil ≤ 15 (oxirgilari), truncated', () => {
    const many = {
      facts: { ...stored.facts, shifts_count: 15, total_difference: -1500000 },
      evidence: {
        rows: Array.from({ length: 15 }, (_, i) =>
          row(
            String(i + 1),
            `2026-10-0${1 + Math.floor(i / 2)}T0${i % 2}:00:00.000Z`,
            -100000,
          ),
        ),
      },
    };
    const m = mergeR1(
      many,
      candidate({
        fact_keys: [
          {
            fact_key: '99',
            fact_at: '2026-10-22T08:10:00.000Z',
            amount: -80000,
          },
        ],
        evidence: {
          kind: 'shifts',
          rows: [row('99', '2026-10-22T08:10:00.000Z', -80000)],
        },
      }),
      new Set(['99']),
    );
    expect(m.evidence).toMatchObject({ total_rows: 16, truncated: true });
    const rows = m.evidence.rows as Array<{ shift_id: string }>;
    expect(rows).toHaveLength(15);
    expect(rows[14].shift_id).toBe('99');
    expect(rows[0].shift_id).toBe('2');
  });
});

describe('r6Periods (BE-5 round-2 #651 S2/S3)', () => {
  // 2026-10-22 (payshanba) 02:30 Toshkent = 2026-10-21T21:30Z
  const thu = new Date('2026-10-21T21:30:00.000Z');
  const mon = new Date('2026-10-25T21:30:00.000Z'); // 26.10 dushanba
  const cursorEnd = (day: string) => ({
    cursor_at: new Date(`${day}T23:59:59.999+05:00`),
  });

  it('kursor yo‘q: faqat kecha; dushanba — o‘tgan hafta ham', () => {
    expect(r6Periods(thu, undefined)).toEqual({ days: ['2026-10-21'] });
    expect(r6Periods(mon, undefined)).toEqual({
      days: ['2026-10-25'],
      weeks: ['2026-10-19'],
    });
  });

  it('o‘tkazilgan kun keyingi ishda tekshiriladi (catch-up)', () => {
    expect(r6Periods(thu, cursorEnd('2026-10-19'))).toEqual({
      days: ['2026-10-20', '2026-10-21'],
    });
    expect(r6Periods(thu, cursorEnd('2026-10-21'))).toEqual({ days: [] });
  });

  it('dushanba o‘tkazilsa — hafta seshanba kuni ham tekshiriladi; ≤ 7 kun', () => {
    const tue = new Date('2026-10-26T21:30:00.000Z'); // 27.10
    expect(r6Periods(tue, cursorEnd('2026-10-24'))).toEqual({
      days: ['2026-10-25', '2026-10-26'],
      weeks: ['2026-10-19'],
    });
    const late = r6Periods(tue, cursorEnd('2026-10-01'));
    expect(late.days).toHaveLength(7);
    expect(late.days[6]).toBe('2026-10-26');
    expect(late.weeks).toEqual(['2026-10-12', '2026-10-19']);
  });
});

describe('catchingUp (BE-5 round-2 ops-S1)', () => {
  const now = new Date('2026-10-22T09:00:00.000Z');
  const h = (n: number) => new Date(now.getTime() - n * 3600_000);
  it('birinchi ish — ha; kursor 30 daq — yo‘q; > 24 soat — ha; R6 — > 8 kun', () => {
    expect(catchingUp('R1', undefined, now)).toBe(true);
    expect(
      catchingUp('R1', { first_run_at: h(100), cursor_at: h(0.5) }, now),
    ).toBe(false);
    expect(
      catchingUp('R1', { first_run_at: h(100), cursor_at: h(25) }, now),
    ).toBe(true);
    expect(
      catchingUp('R6', { first_run_at: h(100), cursor_at: h(27) }, now),
    ).toBe(false);
    // #704 B2: bitta o'tkazilgan kunlik yugurish (50 soat) — backfill EMAS.
    expect(
      catchingUp('R6', { first_run_at: h(100), cursor_at: h(50) }, now),
    ).toBe(false);
    expect(
      catchingUp('R6', { first_run_at: h(400), cursor_at: h(8 * 24 + 1) }, now),
    ).toBe(true);
    expect(
      catchingUp('R2', { first_run_at: h(100), cursor_at: null }, now),
    ).toBe(false);
  });
});
