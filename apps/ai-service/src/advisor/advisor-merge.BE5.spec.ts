import type { AiAdvisorCandidate } from '@app/common';
import { mergeR1 } from './advisor-merge';
import { r6Periods } from './advisor-engine.service';

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
