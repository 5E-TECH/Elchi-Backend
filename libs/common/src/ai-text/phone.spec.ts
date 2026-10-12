import { normalizeUzPhone, parseUzPhoneSearch, uzPhoneDigitsLikeSql } from './';

/**
 * I73soTpf, 32fNx0Ci. Telefon normalizatsiyasi — HECH QACHON "tuzatmaydi":
 * to'ldirmaydi ham, kesmaydi ham. Mos kelmasa `null`.
 */
describe('normalizeUzPhone', () => {
  it('I73soTpf #8: "90 123 45 67", "+998 (90) 123-45-67" va "998901234567" bir xil "+998901234567"', () => {
    const expected = '+998901234567';
    expect(normalizeUzPhone('90 123 45 67')).toBe(expected);
    expect(normalizeUzPhone('+998 (90) 123-45-67')).toBe(expected);
    expect(normalizeUzPhone('998901234567')).toBe(expected);
    expect(normalizeUzPhone('90 123 45 67')).toBe(
      normalizeUzPhone('+998 (90) 123-45-67'),
    );
  });

  it('32fNx0Ci #7: normalizeUzPhone("+998 (90) 123-45-67") === "+998901234567"', () => {
    expect(normalizeUzPhone('+998 (90) 123-45-67')).toBe('+998901234567');
  });

  it('0 yoki 8 trunk prefiksi + 9 raqam, nuqta va probel ajratkichlari', () => {
    expect(normalizeUzPhone('0901234567')).toBe('+998901234567');
    expect(normalizeUzPhone('8 (90) 123 45 67')).toBe('+998901234567');
    expect(normalizeUzPhone('90.123.45.67')).toBe('+998901234567');
    expect(normalizeUzPhone(' +998 90 123 45 67 ')).toBe('+998901234567');
  });

  it('frontend qoidasi bilan mos: /^\\d{9}$/ + `+998${phone}`', () => {
    const phone = '901234567';
    expect(/^\d{9}$/.test(phone)).toBe(true);
    expect(normalizeUzPhone(phone)).toBe(`+998${phone}`);
  });

  it('raqam (number) ko`rinishidagi kirish', () => {
    expect(normalizeUzPhone(998901234567)).toBe('+998901234567');
    expect(normalizeUzPhone(901234567)).toBe('+998901234567');
    expect(normalizeUzPhone(-901234567)).toBeNull();
    expect(normalizeUzPhone(90123456.7)).toBeNull();
    expect(normalizeUzPhone(Number.NaN)).toBeNull();
  });

  it('I73soTpf #9: normalizeUzPhone("abc") === null va normalizeUzPhone("9012345") === null (to`ldirmaydi)', () => {
    expect(normalizeUzPhone('abc')).toBeNull();
    expect(normalizeUzPhone('9012345')).toBeNull();
  });

  it('I73soTpf #9: 8 raqam to`ldirilmaydi, 13 raqam kesilmaydi', () => {
    // 8 raqam — oldiga/oxiriga raqam QO'SHILMAYDI.
    expect(normalizeUzPhone('90123456')).toBeNull();
    // 13 raqam — ortiqcha raqam KESILMAYDI.
    expect(normalizeUzPhone('9989012345678')).toBeNull();
    expect(normalizeUzPhone('+998 90 123 45 678')).toBeNull();
    // 11 raqam.
    expect(normalizeUzPhone('99890123456')).toBeNull();
  });

  it('noto`g`ri prefiksli 10 va 12 raqam — null', () => {
    expect(normalizeUzPhone('9901234567')).toBeNull();
    expect(normalizeUzPhone('997901234567')).toBeNull();
    expect(normalizeUzPhone('+7 901 234 56 78')).toBeNull();
  });

  it('ikki raqam birga yozilsa — null (birinchisini tanlab olmaydi)', () => {
    expect(normalizeUzPhone('+998901234567, +998911234567')).toBeNull();
  });

  it('bo`sh yoki satr bo`lmagan qiymat — null', () => {
    expect(normalizeUzPhone('')).toBeNull();
    expect(normalizeUzPhone('   ')).toBeNull();
    expect(normalizeUzPhone(null)).toBeNull();
    expect(normalizeUzPhone(undefined)).toBeNull();
    expect(normalizeUzPhone({ phone: '901234567' })).toBeNull();
    expect(normalizeUzPhone(['901234567'])).toBeNull();
  });
});

/**
 * zfPNDCCr: qidiruv matni telefonga o'xshasa — saqlangan telefonning
 * raqamlari ichidan izlanadigan kalit (prod 2-tur: global qidiruv
 * '0330991009' / '+998 33 099 10 09' bilan 0 natija berardi).
 */
describe('parseUzPhoneSearch (zfPNDCCr)', () => {
  it.each([
    '0330991009',
    '+998 33 099 10 09',
    '330991009',
    '998330991009',
    '+998330991009',
    '+998 (33) 099-10-09',
    ' 33 099 10 09 ',
  ])("⭐ %p → kanonik '+998330991009', milliy '330991009'", (input) => {
    expect(parseUzPhoneSearch(input)).toEqual({
      canonical: '+998330991009',
      digits: '330991009',
    });
  });

  it('qisman raqam (7+ raqam) — kiritilgan raqamlar bo`yicha', () => {
    expect(parseUzPhoneSearch('099-10-09')).toEqual({
      canonical: null,
      digits: '0991009',
    });
    expect(parseUzPhoneSearch('+1 202 555 0100')).toEqual({
      canonical: null,
      digits: '12025550100',
    });
  });

  it.each([
    'Ali',
    'Ali 90 123 45 67',
    'abc330991009',
    '330 99',
    '123456',
    '90.123.45.67',
    '1234567890123456',
    '',
    '   ',
    null,
    undefined,
    330991009,
  ])('%p → telefon qidiruvi EMAS (null)', (input) => {
    expect(parseUzPhoneSearch(input)).toBeNull();
  });

  it('SQL: ustun raqamlari ichidan parametr bilan LIKE', () => {
    expect(uzPhoneDigitsLikeSql('u.phone_number')).toBe(
      "regexp_replace(u.phone_number, '[^0-9]', '', 'g') LIKE :phoneDigits",
    );
    expect(uzPhoneDigitsLikeSql("doc.metadata->>'phone_number'", 'p')).toBe(
      "regexp_replace(doc.metadata->>'phone_number', '[^0-9]', '', 'g') LIKE :p",
    );
  });
});
