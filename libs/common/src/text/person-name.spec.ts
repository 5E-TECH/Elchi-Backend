import { Roles, isPersonNameRole, normalizePersonName } from '@app/common';

/**
 * Ega qarori 2026-11-04: odam ismida har so'zning birinchi harfi katta —
 * kichik kiritilsa ham. Qolgan harflar AYNAN kiritilganidek.
 */
describe('normalizePersonName', () => {
  it('kichik harfli ism-familiya → har so`z bosh harfi katta', () => {
    expect(normalizePersonName('ali valiyev')).toBe('Ali Valiyev');
    expect(normalizePersonName('ali')).toBe('Ali');
  });

  it('o`zbekcha tutuq belgisi: «o`tkir», «g`ulom» — faqat birinchi harf', () => {
    expect(normalizePersonName("o'tkir")).toBe("O'tkir");
    expect(normalizePersonName("g'ulom o'tkirov")).toBe("G'ulom O'tkirov");
    expect(normalizePersonName('o‘tkir')).toBe('O‘tkir');
    expect(normalizePersonName('oʻtkir')).toBe('Oʻtkir');
  });

  it('qolgan harflar o`zgarmaydi: «ALI» → «ALI», «mcDonald» → «McDonald»', () => {
    expect(normalizePersonName('ALI')).toBe('ALI');
    expect(normalizePersonName('ALI VALIYEV')).toBe('ALI VALIYEV');
    expect(normalizePersonName('mcDonald')).toBe('McDonald');
    expect(normalizePersonName('aLI')).toBe('ALI');
    expect(normalizePersonName('Ali Valiyev')).toBe('Ali Valiyev');
  });

  it('kirill: «иван петров» → «Иван Петров»', () => {
    expect(normalizePersonName('иван петров')).toBe('Иван Петров');
    expect(normalizePersonName('ёқубов шерзод')).toBe('Ёқубов Шерзод');
  });

  it('defis ham so`z ajratkichi: «abdulla-ugli» → «Abdulla-Ugli»', () => {
    expect(normalizePersonName('abdulla-ugli')).toBe('Abdulla-Ugli');
    expect(normalizePersonName('ali - vali')).toBe('Ali - Vali');
  });

  it('boshidagi harf bo`lmagan belgilar o`tkazib yuboriladi (qo`shtirnoq, qavs)', () => {
    expect(normalizePersonName('"ali" valiyev')).toBe('"Ali" Valiyev');
    expect(normalizePersonName('«ali»')).toBe('«Ali»');
    expect(normalizePersonName('(ali)')).toBe('(Ali)');
    expect(normalizePersonName('ʻali')).toBe('ʻAli');
  });

  it('bo`shliqlar: chetdagisi olinadi, ketma-ketlari bitta probel', () => {
    expect(normalizePersonName('  ali   valiyev  ')).toBe('Ali Valiyev');
    expect(normalizePersonName('ali\t\nvaliyev')).toBe('Ali Valiyev');
    expect(normalizePersonName('ali valiyev')).toBe('Ali Valiyev');
    expect(normalizePersonName('   ')).toBe('');
    expect(normalizePersonName('')).toBe('');
  });

  it('lokal: «i» → «I» (turkcha «İ» emas)', () => {
    expect(normalizePersonName('ilhom')).toBe('Ilhom');
    expect(normalizePersonName('ilhom')).not.toBe('İlhom');
  });

  it('harfsiz so`z va raqamlar — o`zgarmaydi; raqamdan keyingi harf katta', () => {
    expect(normalizePersonName('-- 123')).toBe('-- 123');
    expect(normalizePersonName('test 2')).toBe('Test 2');
  });

  it('matn bo`lmagan qiymat o`zgarishsiz qaytadi (RMQ payloadi)', () => {
    expect(normalizePersonName(undefined)).toBeUndefined();
    expect(normalizePersonName(null)).toBeNull();
    expect(normalizePersonName(42)).toBe(42);
  });
});

/**
 * Qaysi rolda nom odam ismi: market (biznes) va eski filial hisobi — yo'q,
 * qolgan hamma rol — ha (Elchi-Frontend `isPersonNameRole` bilan ayni).
 */
describe('isPersonNameRole', () => {
  it('market va eski filial hisobi (branch) — odam ismi emas', () => {
    expect(isPersonNameRole(Roles.MARKET)).toBe(false);
    expect(isPersonNameRole(Roles.BRANCH)).toBe(false);
  });

  it('xodim rollari va mijoz — odam ismi', () => {
    for (const role of [
      Roles.SUPERADMIN,
      Roles.ADMIN,
      Roles.MANAGER,
      Roles.REGISTRATOR,
      Roles.LOGIST,
      Roles.COURIER,
      Roles.INVESTOR,
      Roles.MARKET_OPERATOR,
      Roles.OPERATOR,
      Roles.CUSTOMER,
    ]) {
      expect(isPersonNameRole(role)).toBe(true);
    }
  });

  it('rol noma`lum (null/undefined) — odam ismi deb olinadi', () => {
    expect(isPersonNameRole(null)).toBe(true);
    expect(isPersonNameRole(undefined)).toBe(true);
  });
});
