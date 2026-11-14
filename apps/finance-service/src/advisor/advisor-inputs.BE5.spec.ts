import {
  addDaysKey,
  parseReceiptDate,
  tashkentDateKey,
} from './advisor-inputs.service';

/** BE-5 — sof yordamchilar: Toshkent kuni, chek sanasi (§5.4 `date_at`). */
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
    ['22.10.2026 11:05', '2026-10-22T06:05:00.000Z'],
    ['22.10.2026', '2026-10-21T19:00:00.000Z'],
    ['22/10/2026 9:05:30', '2026-10-22T04:05:30.000Z'],
    ['2026-10-22 11:05', '2026-10-22T06:05:00.000Z'],
    ['2026-10-22', '2026-10-21T19:00:00.000Z'],
  ])('chek sanasi %s → %s (+05:00 deb olinadi)', (raw, iso) => {
    expect(parseReceiptDate(raw)).toBe(iso);
  });

  it.each([
    null,
    undefined,
    '',
    'Oct 22, 2026',
    '32.13.2026',
    '2026-10-22T11:05Z',
  ])('tahlil qilinmaydi: %p → null', (raw) => {
    expect(parseReceiptDate(raw as string | null)).toBeNull();
  });
});
