import {
  hasCardLikeDigits,
  maskCardLikeDigits,
  maskCardLikeDigitsKeepingDates,
} from './mask-card-digits';

/** T3 / kiZgTybn — karta raqami (PAN) niqobi: har qanday ajratgich bilan. */
describe('maskCardLikeDigits', () => {
  const PANS = [
    '8600123456789012',
    '8600 1234 5678 9012',
    '8600  1234  5678  9012',
    '8600-1234-5678-9012',
    '8600–1234–5678–9012',
    '8600 - 1234 - 5678 - 9012',
    '8600/1234/5678/9012',
    '8600_1234_5678_9012',
    '8600.1234.5678.9012',
    '8600,1234,5678,9012',
  ];

  it.each(PANS)('⭐ %s → ***', (pan) => {
    expect(maskCardLikeDigits(pan)).toBe('***');
    expect(maskCardLikeDigits(`Ali ${pan} Kapitalbank`)).toBe(
      'Ali *** Kapitalbank',
    );
    expect(hasCardLikeDigits(`TX ${pan}`)).toBe(true);
  });

  it('telefon (+998 …) ham niqoblanadi', () => {
    expect(maskCardLikeDigits('+998 90 123 45 67')).toBe('+***');
  });

  it('summa, qisqa raqamlar, 11 raqam — o`zgarmaydi', () => {
    for (const text of [
      '150 000 so`m',
      '1 250 000,50',
      'TX-0012345',
      '12345678901',
    ]) {
      expect(maskCardLikeDigits(text)).toBe(text);
    }
    expect(hasCardLikeDigits('TX-0012345')).toBe(false);
  });

  it('⭐ sana-vaqt saqlanadi, yonidagi karta raqami niqoblanadi', () => {
    for (const date of [
      '30.10.2026 14.05.33',
      '30.10.2026 14:05:33',
      '2026-10-30T14:05',
      '2026-10-30 14:05:33',
      '30/10/26 14:05',
      '30.10.2026, 14:05',
    ]) {
      expect(maskCardLikeDigitsKeepingDates(date)).toBe(date);
    }
    expect(
      maskCardLikeDigitsKeepingDates('30.10.2026 8600 1234 5678 9012'),
    ).toBe('30.10.2026 ***');
    expect(
      maskCardLikeDigitsKeepingDates('30.10.2026 14:05 8600-1234-5678-9012'),
    ).toBe('30.10.2026 14:05 ***');
    expect(maskCardLikeDigitsKeepingDates('8600 1234 5678 9012')).toBe('***');
  });
});
