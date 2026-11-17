import { parseReceiptDate } from '../cashbox-receipt/receipt.rules';
import {
  addDaysKey,
  isForeignReceipt,
  parseReceiptDateTime,
  r7Cursor,
  tashkentDateKey,
} from './advisor-inputs.service';

/** BE-5 — sof yordamchilar: Toshkent kuni, chek sanasi (§5.4), valyuta, R7 kursori. */
describe('advisor-inputs yordamchilari (BE-5)', () => {
  it('Toshkent kuni: UTC 19:00 — keyingi kun', () => {
    expect(tashkentDateKey(new Date('2026-10-21T18:59:59Z'))).toBe(
      '2026-10-21',
    );
    expect(tashkentDateKey(new Date('2026-10-21T19:00:00Z'))).toBe(
      '2026-10-22',
    );
    expect(addDaysKey('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysKey('2026-03-01', -1)).toBe('2026-02-28');
  });

  it.each([
    ['22.10.2026 11:05', '2026-10-22T06:05:00.000Z', '2026-10-22'],
    ['22/10/2026 9:05:30', '2026-10-22T04:05:30.000Z', '2026-10-22'],
    ['2026-10-22 11:05', '2026-10-22T06:05:00.000Z', '2026-10-22'],
    ['5-3-2026 23:59', '2026-03-05T18:59:00.000Z', '2026-03-05'],
    [
      'Sana: 22.10.2026, 11:05 Toshkent',
      '2026-10-22T06:05:00.000Z',
      '2026-10-22',
    ],
    // Aniq mintaqa — o'sha bo'yicha.
    ['2026-10-22T11:05:00Z', '2026-10-22T11:05:00.000Z', '2026-10-22'],
    ['2026-10-22T11:05:00+05:00', '2026-10-22T06:05:00.000Z', '2026-10-22'],
    // round-3 S5: bo'sh joy + Z; date_day — Toshkent kuni.
    ['2026-10-22 10:00Z', '2026-10-22T10:00:00.000Z', '2026-10-22'],
    ['2026-10-22T22:00:00Z', '2026-10-22T22:00:00.000Z', '2026-10-23'],
  ])('vaqtli: %s → %s', (raw, at, day) => {
    expect(parseReceiptDateTime(raw)).toEqual({ date_at: at, date_day: day });
  });

  it.each([
    ['22.10.2026', '2026-10-22'],
    ['2026-10-22', '2026-10-22'],
    ['22.10.2026 24:00', '2026-10-22'], // noto'g'ri vaqt — faqat kun
    ['22.10.2026 10:60', '2026-10-22'],
  ])(
    'faqat sana (soxta 00:00 yo‘q): %s → date_at null, date_day %s',
    (raw, day) => {
      expect(parseReceiptDateTime(raw)).toEqual({
        date_at: null,
        date_day: day,
      });
    },
  );

  it.each([
    null,
    undefined,
    '',
    'Oct 22, 2026',
    '31.02.2026',
    '30.02.2026 10:00',
    '32.13.2026',
    '2026-02-30T10:00:00Z',
  ])('tahlil qilinmaydi (kalendar tekshiruvi): %p', (raw) => {
    expect(parseReceiptDateTime(raw as string | null)).toEqual({
      date_at: null,
      date_day: null,
    });
  });

  it('receipt.rules parseReceiptDate bilan ayni kun (date_far bilan izchil)', () => {
    for (const raw of [
      '22.10.2026 11:05',
      '5-3-2026',
      '2026-10-22',
      'Chek 01/11/2026 09:00',
    ]) {
      const rules = parseReceiptDate(raw);
      expect(rules).not.toBeNull();
      expect(parseReceiptDateTime(raw).date_day).toBe(
        tashkentDateKey(rules as Date),
      );
    }
  });

  it('valyuta: UZS/bo‘sh — so‘m; USD yoki currency_not_uzs — chet el', () => {
    expect(isForeignReceipt(null, null)).toBe(false);
    expect(isForeignReceipt(' uzs ', null)).toBe(false);
    expect(isForeignReceipt('USD', null)).toBe(true);
    expect(isForeignReceipt(null, 'currency_not_uzs')).toBe(true);
    // round-3 N2: #643 so'm sinonimlari va apostrof variantlari — so'm.
    for (const c of ['SUM', 'SOM', 'UZB', "SO'M", 'SOʻM', 'so‘m', 'СУМ', 'СЎМ'])
      expect(isForeignReceipt(c, null)).toBe(false);
  });

  it('R7 kursori: LIMIT’ga yetgan manba — o‘sha manbaning oxirgisidan oshmaydi', () => {
    const rows = (n: number, start: number) =>
      Array.from({ length: n }, (_, i) => ({
        seen_at: new Date(start + i * 1000),
      }));
    expect(r7Cursor([[], []])).toBeNull();
    expect(r7Cursor([rows(2, 0), rows(1, 60_000)])).toBe(
      new Date(60_000).toISOString(),
    );
    const full = rows(2000, 0);
    expect(r7Cursor([full, rows(1, 10_000_000)])).toBe(
      full[1999].seen_at.toISOString(),
    );
  });
});
