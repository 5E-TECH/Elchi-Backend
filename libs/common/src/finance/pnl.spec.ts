import {
  fillPnlSeries,
  pnlMonthsBackStart,
  pnlPeriods,
  type PnlPoint,
} from './pnl';

/**
 * Tizim grafigi (ega 2026-11-28) — `finance.pnl.series` faqat qatori bor
 * davrlarni qaytaradi; bo'sh oy/kun 0 bilan to'ldiriladi, qiymat qayta
 * hisoblanmaydi.
 */
describe('pnlMonthsBackStart', () => {
  it.each([
    ['2026-11-28', 12, '2025-12-01'],
    ['2026-01-05', 12, '2025-02-01'],
    ['2026-01-31', 1, '2026-01-01'],
    ['2026-03-15', 3, '2026-01-01'],
    ['2026-03-15', 0, '2026-03-01'],
    ['2026-12-01', 24, '2025-01-01'],
  ])('(%s, %i) → %s', (toDay, months, expected) => {
    expect(pnlMonthsBackStart(toDay, months)).toBe(expected);
  });
});

describe('pnlPeriods', () => {
  it('oylik: yil chegarasidan o‘tadi, chala oylar ham kiradi', () => {
    expect(pnlPeriods('2025-11-15', '2026-02-03', 'month')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('kunlik: ikkala chet ham, kabisa yili', () => {
    expect(pnlPeriods('2028-02-28', '2028-03-01', 'day')).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  it('bitta davr; teskari oraliq — bo‘sh', () => {
    expect(pnlPeriods('2026-11-28', '2026-11-28', 'month')).toEqual([
      '2026-11',
    ]);
    expect(pnlPeriods('2026-12-01', '2026-11-01', 'month')).toEqual([]);
  });
});

describe('fillPnlSeries', () => {
  const point = (period: string, gross: number, opex: number): PnlPoint => ({
    period,
    gross,
    opex,
    net: gross - opex,
    other_income: 7,
  });

  it('bo‘sh oy — 0, bor oy — o‘zgarishsiz (qayta hisoblanmaydi)', () => {
    const nov = point('2026-11', 52000, 56500);
    const items = fillPnlSeries(
      [point('2026-09', 100, 30), nov],
      '2026-09-01',
      '2026-12-31',
      'month',
    );
    expect(items).toEqual([
      point('2026-09', 100, 30),
      { period: '2026-10', gross: 0, opex: 0, net: 0, other_income: 0 },
      nov,
      { period: '2026-12', gross: 0, opex: 0, net: 0, other_income: 0 },
    ]);
    expect(items[2]).toBe(nov);
  });

  it('kunlik seriya ham yoyiladi', () => {
    expect(
      fillPnlSeries(
        [point('2026-11-02', 5, 1)],
        '2026-11-01',
        '2026-11-03',
        'day',
      ).map((item) => [item.period, item.net]),
    ).toEqual([
      ['2026-11-01', 0],
      ['2026-11-02', 4],
      ['2026-11-03', 0],
    ]);
  });
});
