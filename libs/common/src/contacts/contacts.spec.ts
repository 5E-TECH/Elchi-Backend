import {
  dedupeProblemContacts,
  formatContactPhone,
  isMarketResponsibleRole,
  normalizeSupportPhones,
  readSupportPhones,
} from './contacts';

/** T7 (QPq2C1co) — aloqa raqamlari sof funksiyalari. */
describe('T7 — contacts helpers', () => {
  it('normalizeSupportPhones: +998XXXXXXXXX ga normallaydi, takrorsiz, ≤ 2', () => {
    expect(normalizeSupportPhones([])).toEqual([]);
    expect(
      normalizeSupportPhones(['71 200 11 22', '+998 90 111 22 33']),
    ).toEqual(['+998712001122', '+998901112233']);
  });

  it('normalizeSupportPhones: "123", 3 ta, takror, massiv emas — null (SUPPORT_PHONES_INVALID)', () => {
    expect(normalizeSupportPhones(['123'])).toBeNull();
    expect(
      normalizeSupportPhones([
        '+998901112233',
        '+998901112234',
        '+998901112235',
      ]),
    ).toBeNull();
    expect(
      normalizeSupportPhones(['+998901112233', '90 111 22 33']),
    ).toBeNull();
    expect(normalizeSupportPhones('+998901112233')).toBeNull();
    expect(normalizeSupportPhones([901112233])).toBeNull();
  });

  it('readSupportPhones: saqlangan qiymatdan yaroqlilari (qat`iy emas)', () => {
    expect(readSupportPhones(null)).toEqual([]);
    expect(
      readSupportPhones(['+998712001122', 'xato', '+998712001122']),
    ).toEqual(['+998712001122']);
  });

  it('formatContactPhone: «+998 90 111 22 33»', () => {
    expect(formatContactPhone('+998901112233')).toBe('+998 90 111 22 33');
    expect(formatContactPhone('998712001122')).toBe('+998 71 200 11 22');
    expect(formatContactPhone(' 12 ')).toBe('12');
  });

  it('dedupeProblemContacts: telefon bo`yicha takrorsiz, ≤ 2, bo`sh telefon tashlanadi', () => {
    expect(
      dedupeProblemContacts([
        { name: 'A', phone: '+998901112233', source: 'logist' },
        { name: null, phone: '+998 90 111 22 33', source: 'support' },
        { name: null, phone: '', source: 'support' },
        { name: null, phone: '+998712001122', source: 'support' },
        { name: null, phone: '+998712001123', source: 'support' },
      ]),
    ).toEqual([
      { name: 'A', phone: '+998901112233', source: 'logist' },
      { name: null, phone: '+998712001122', source: 'support' },
    ]);
  });

  it('mas`ul rollari: superadmin, admin, registrator, logist', () => {
    for (const role of ['superadmin', 'admin', 'registrator', 'LOGIST']) {
      expect(isMarketResponsibleRole(role)).toBe(true);
    }
    for (const role of ['manager', 'courier', 'market', 'operator', '']) {
      expect(isMarketResponsibleRole(role)).toBe(false);
    }
  });
});
