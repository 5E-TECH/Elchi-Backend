import {
  canonicalGtin,
  compressUpcA,
  expandUpcE,
  extractGs1Gtin,
  formatProductSkuCode,
  hasValidGtinCheckDigit,
  normalizeProductBarcode,
  parseProductSkuCode,
  productBarcodeEquivalents,
  productBarcodeLookupVariants,
  PRODUCT_SKU_PREFIX,
} from './product-code';
import { PRODUCT_BARCODE_MAX_LENGTH } from './product-measure';

/**
 * hY7uacJu (ombor) + MH-3: mahsulot kodlari — Elchi kodi `ELC-P-…` va zavod
 * shtrix kodi (EAN/UPC/GTIN, GS1 DataMatrix/QR, erkin QR matni).
 */
describe('Elchi mahsulot kodi (sku_code)', () => {
  it.each([
    ['1', 'ELC-P-000001'],
    ['42', 'ELC-P-000042'],
    ['123456', 'ELC-P-123456'],
    // ⭐ 6 xonadan uzun id QISQARMAYDI (SQL'da `GREATEST(6, length)`).
    ['1234567', 'ELC-P-1234567'],
    [7, 'ELC-P-000007'],
  ])('formatProductSkuCode(%p) → %p', (id, expected) => {
    expect(formatProductSkuCode(id)).toBe(expected);
  });

  it('prefiks — ELC-P-', () => {
    expect(PRODUCT_SKU_PREFIX).toBe('ELC-P-');
  });

  it.each([
    ['ELC-P-000012', '12'],
    ['elc-p-12', '12'],
    ['  ELC-P-000007  ', '7'],
    ['ELC-P-100', '100'],
    ['ELC-P-1234567', '1234567'],
  ])('parseProductSkuCode(%p) → %p', (raw, expected) => {
    expect(parseProductSkuCode(raw)).toBe(expected);
  });

  it.each([
    ['ELC-P-'],
    ['ELC-P-0'],
    ['ELC-P-000000'],
    ['ELC-P-1a'],
    ['ELC-P-12 3'],
    ['ELC-X-12'],
    ['4780000000007'],
    [''],
    [null],
    [12],
    // bigint chegarasidan oshadigan (19+ xonali) — rad.
    ['ELC-P-1234567890123456789'],
  ])('parseProductSkuCode(%p) → null', (raw) => {
    expect(parseProductSkuCode(raw)).toBeNull();
  });

  it('format → parse aylanmasi id ni qaytaradi', () => {
    for (const id of ['1', '99', '123456', '9876543']) {
      expect(parseProductSkuCode(formatProductSkuCode(id))).toBe(id);
    }
  });
});

describe('GTIN nazorat raqami (GS1 mod-10)', () => {
  it.each([
    ['4780000000007', true],
    ['4006381333931', true],
    ['4006381333932', false],
    ['73513537', true],
    ['73513538', false],
    ['036000291452', true],
    ['036000291453', false],
    ['00036000291452', true],
    ['04780000000007', true],
    // GTIN uzunligi emas (10 xona) yoki raqam emas — false.
    ['1234567890', false],
    ['47800000000a7', false],
  ])('hasValidGtinCheckDigit(%p) → %p', (digits, expected) => {
    expect(hasValidGtinCheckDigit(digits)).toBe(expected);
  });
});

describe('GS1 element satri (DataMatrix «Asl belgisi», GS1 QR, GS1-128)', () => {
  it.each([
    ['(01)04780000000007(21)ABC', '04780000000007'],
    [']d20104780000000007215xyz', '04780000000007'],
    [']Q30104780000000007', '04780000000007'],
    ['0104780000000007\u001d21abc', '04780000000007'],
  ])('extractGs1Gtin(%p) → %p', (raw, expected) => {
    expect(extractGs1Gtin(raw)).toBe(expected);
  });

  it.each([
    // Nazorat raqami noto'g'ri GTIN — GS1 deb hisoblanmaydi.
    ['(01)04780000000008(21)ABC'],
    ['4780000000007'],
    ['https://example.uz/p/1'],
    [''],
  ])('extractGs1Gtin(%p) → null', (raw) => {
    expect(extractGs1Gtin(raw)).toBeNull();
  });
});

describe('canonicalGtin (GS1 GTIN-14 fazosi — saqlash va qidiruv shakli)', () => {
  it('⭐ UPC-A (12), EAN-13 va GTIN-14 yozuvlari — bitta kanonik qiymat (13 xona)', () => {
    for (const raw of ['036000291452', '0036000291452', '00036000291452']) {
      expect(canonicalGtin(raw)).toBe('0036000291452');
    }
  });

  it('EAN-13 (boshida nol yo`q) — o`zicha; uning GTIN-14 shakli ham shu', () => {
    expect(canonicalGtin('4780000000007')).toBe('4780000000007');
    expect(canonicalGtin('04780000000007')).toBe('4780000000007');
  });

  it('⭐ GTIN-8 va uning 12/13/14 xonali ko`rinishlari — 8 xona', () => {
    for (const raw of [
      '73513537',
      '000073513537',
      '0000073513537',
      '00000073513537',
    ]) {
      expect(canonicalGtin(raw)).toBe('73513537');
    }
  });

  it('⭐ indikatori 1–9 bo`lgan GTIN-14 — o`zgarmaydi', () => {
    expect(canonicalGtin('10036000291459')).toBe('10036000291459');
    expect(canonicalGtin('14780000000004')).toBe('14780000000004');
  });

  it('ichki EAN (20–29) — oddiy EAN-13', () => {
    expect(canonicalGtin('2000000000008')).toBe('2000000000008');
  });

  it.each([
    ['00000000'],
    ['000000000000'],
    ['0000000000000'],
    ['00000000000000'],
    // Nazorat raqami noto'g'ri / GTIN uzunligi emas / raqam emas.
    ['036000291453'],
    ['1234567890'],
    ['47800000000a7'],
    [''],
  ])('⭐ yaroqsiz yoki hammasi nol %p → null', (raw) => {
    expect(canonicalGtin(raw)).toBeNull();
  });
});

describe('UPC-E ↔ UPC-A (GS1: UPC-E — GTIN-12 ning siqilgan yozuvi)', () => {
  it.each([
    // D6 0–2: ishlab chiqaruvchi D1 D2 D6 0 0, mahsulot 0 0 D3 D4 D5.
    ['04963406', '049000006346'],
    ['01234514', '012100003454'],
    // D6 3: ishlab chiqaruvchi D1 D2 D3 0 0, mahsulot 0 0 0 D4 D5.
    ['01234531', '012300000451'],
    // D6 4: ishlab chiqaruvchi D1 D2 D3 D4 0, mahsulot 0 0 0 0 D5.
    ['01234543', '012340000053'],
    // D6 5–9: ishlab chiqaruvchi D1 … D5, mahsulot 0 0 0 0 D6.
    ['01234572', '012345000072'],
    // Son tizimi 1.
    ['10123500', '101000002350'],
  ])('expandUpcE(%p) → %p, compressUpcA — teskarisi', (upcE, upcA) => {
    expect(expandUpcE(upcE)).toBe(upcA);
    expect(hasValidGtinCheckDigit(upcA)).toBe(true);
    expect(compressUpcA(upcA)).toBe(upcE);
  });

  it.each([['24963406'], ['0496340'], ['049634061'], ['0496340a']])(
    'expandUpcE(%p) → null (son tizimi 0/1 emas yoki 8 raqam emas)',
    (raw) => {
      expect(expandUpcE(raw)).toBeNull();
    },
  );

  it.each([['036000291452'], ['478000000000'], ['04900000634']])(
    'compressUpcA(%p) → null (siqib bo`lmaydi / son tizimi 0/1 emas)',
    (raw) => {
      expect(compressUpcA(raw)).toBeNull();
    },
  );

  it('⭐ siqiladigan har UPC-A: expand(compress(x)) === x (namunada)', () => {
    let checked = 0;
    for (let i = 0; i < 1_000_000; i += 997) {
      for (const system of ['0', '1']) {
        const upcE = expandUpcE(`${system}${String(i).padStart(6, '0')}0`);
        const body = upcE!.slice(0, 11);
        for (let c = 0; c < 10; c += 1) {
          const upcA = body + c;
          const compressed = compressUpcA(upcA);
          if (compressed) {
            expect(expandUpcE(compressed)).toBe(upcA);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });
});

describe('normalizeProductBarcode', () => {
  const ok = (raw: unknown) => {
    const result = normalizeProductBarcode(raw);
    expect(result.ok).toBe(true);
    return (result as { ok: true; value: string | null | undefined }).value;
  };
  const fail = (raw: unknown) => {
    const result = normalizeProductBarcode(raw);
    expect(result.ok).toBe(false);
    return (result as { ok: false; reason: string }).reason;
  };

  it('undefined — o`zgarmaydi; null / bo`sh — tozalash (null)', () => {
    expect(ok(undefined)).toBeUndefined();
    expect(ok(null)).toBeNull();
    expect(ok('')).toBeNull();
    expect(ok('   ')).toBeNull();
  });

  it.each([
    ['4780000000007', '4780000000007'],
    ['4 780000 000007', '4780000000007'],
    ['4780-0000-00007', '4780000000007'],
    ['73513537', '73513537'],
    // ⭐ GTIN — KANONIK shaklda (UPC-A va GTIN-14 → 13 xonali EAN shakli).
    ['036000291452', '0036000291452'],
    ['0036000291452', '0036000291452'],
    ['00036000291452', '0036000291452'],
    ['04780000000007', '4780000000007'],
    ['10036000291459', '10036000291459'],
    ['2000000000008', '2000000000008'],
    // Boshqa uzunlikdagi raqam (Code128 / ichki kod) — o'zicha.
    ['1234567890', '1234567890'],
    ['  12345  ', '12345'],
  ])('raqamli kod %p → %p', (raw, expected) => {
    expect(ok(raw)).toBe(expected);
  });

  it.each([
    // ⭐ Haqiqiy UPC-E (Coca-Cola bankasi): GTIN-8 sifatida nazorat raqami
    // noto'g'ri, kengaytirilgan UPC-A bo'yicha to'g'ri — kanonik UPC-A.
    ['04963406', '0049000006346'],
    ['0496 3406', '0049000006346'],
    // `0…` — avval UPC-E: GTIN-8 sifatida ham to'g'ri bo'lsa ham UPC-A
    // (GS1-8 prefiksi 0xx — zavod kodi emas).
    ['01234572', '0012345000072'],
    ['00017268', '0000172000068'],
    // `0…`, UPC-E sifatida noto'g'ri, GTIN-8 sifatida to'g'ri — 8 xona.
    ['00123501', '00123501'],
    ['04963400', '04963400'],
    // `1…` — avval GTIN-8; o'tmasa UPC-E (son tizimi 1).
    ['10017265', '10017265'],
    ['10123500', '0101000002350'],
    // Boshqa raqam bilan — faqat GTIN-8.
    ['73513537', '73513537'],
  ])('⭐ 8 xonali skan (EAN-8 / UPC-E) %p → %p', (raw, expected) => {
    expect(ok(raw)).toBe(expected);
  });

  it('⭐ UPC-E skani va uning UPC-A / EAN-13 / GTIN-14 yozuvlari — bitta kanonik qiymat', () => {
    for (const raw of [
      '04963406',
      '049000006346',
      '0049000006346',
      '00049000006346',
    ]) {
      expect(ok(raw)).toBe('0049000006346');
    }
  });

  it.each([['04963407'], ['04963401'], ['73513538'], ['24963406']])(
    '8 xonali, EAN-8 ham, UPC-E ham emas %p → xato',
    (raw) => {
      expect(fail(raw)).toMatch(/nazorat raqami noto'g'ri \(8 xonali/);
    },
  );

  it.each([
    ['4006381333932'],
    ['73513538'],
    ['036000291453'],
    ['04780000000008'],
  ])('⭐ GTIN uzunligida, nazorat raqami noto`g`ri %p → xato', (raw) => {
    expect(fail(raw)).toMatch(/nazorat raqami/);
  });

  it.each([['00000000'], ['0000000000000'], ['(01)00000000000000']])(
    '⭐ hammasi nol GTIN %p → xato',
    (raw) => {
      expect(fail(raw)).toMatch(/nollardan/);
    },
  );

  it('⭐ GS1 (DataMatrix / QR) — GTIN ajratib olinadi, KANONIK shaklda', () => {
    expect(ok('(01)04780000000007(21)ABC')).toBe('4780000000007');
    expect(ok(']d20104780000000007215xyz')).toBe('4780000000007');
    expect(ok(']d2010478000000000721SERIAL')).toBe('4780000000007');
    // GTIN-8 ning GTIN-14 ko'rinishi — 8 xona.
    expect(ok('(01)00000073513537')).toBe('73513537');
    // Indikatorli GTIN-14 — o'zicha.
    expect(ok('(01)10036000291459(17)261231')).toBe('10036000291459');
  });

  it('zavod QR matni — trim, registr SAQLANADI', () => {
    expect(ok('  https://Zavod.uz/P/AbC-123  ')).toBe(
      'https://Zavod.uz/P/AbC-123',
    );
    expect(ok('SN-Xy12')).toBe('SN-Xy12');
  });

  it('⭐ Elchi kodi (ELC-P-…) shtrix kod maydoniga yozilmaydi', () => {
    expect(fail('ELC-P-000001')).toMatch(/ELC-P-/);
    expect(fail('elc-p-7')).toMatch(/ELC-P-/);
  });

  it('boshqaruv belgilari → xato', () => {
    expect(fail('ABC\u0000DEF')).toMatch(/boshqaruv/);
    expect(fail('AB\tCD')).toMatch(/boshqaruv/);
    expect(fail('AB\u007fCD')).toMatch(/boshqaruv/);
  });

  it(`${PRODUCT_BARCODE_MAX_LENGTH} belgidan uzun → xato; aynan ${PRODUCT_BARCODE_MAX_LENGTH} — ruxsat`, () => {
    expect(fail('x'.repeat(PRODUCT_BARCODE_MAX_LENGTH + 1))).toMatch(
      String(PRODUCT_BARCODE_MAX_LENGTH),
    );
    expect(ok('x'.repeat(PRODUCT_BARCODE_MAX_LENGTH))).toHaveLength(
      PRODUCT_BARCODE_MAX_LENGTH,
    );
  });

  it('satr bo`lmagan qiymat (JSON raqami — boshidagi nollar yo`qoladi) → xato', () => {
    expect(fail(4780000000007)).toMatch(/satr/);
    expect(fail({})).toMatch(/satr/);
    expect(fail(true)).toMatch(/satr/);
  });
});

describe('productBarcodeLookupVariants (qidiruv — xato tashlamaydi)', () => {
  it('⭐ 12 xonali UPC skani → [xom, kanonik 13 xona] (saqlash bilan bir xil)', () => {
    expect(productBarcodeLookupVariants('036000291452')).toEqual([
      '036000291452',
      '0036000291452',
    ]);
  });

  it('⭐ 14 xonali GTIN → [xom, kanonik]', () => {
    expect(productBarcodeLookupVariants('00036000291452')).toEqual([
      '00036000291452',
      '0036000291452',
    ]);
    expect(productBarcodeLookupVariants('04780000000007')).toEqual([
      '04780000000007',
      '4780000000007',
    ]);
  });

  it('kanonik EAN-13 — faqat o`zi (takrorlanmaydi)', () => {
    expect(productBarcodeLookupVariants('4780000000007')).toEqual([
      '4780000000007',
    ]);
  });

  it('GS1 DataMatrix skani — kanonik GTIN', () => {
    expect(productBarcodeLookupVariants(']d20104780000000007215xyz')).toEqual([
      ']d20104780000000007215xyz',
      '4780000000007',
    ]);
  });

  it('probel bilan raqam — raqamlari (kanonik) ham', () => {
    expect(productBarcodeLookupVariants('4 780000 000007')).toEqual([
      '4 780000 000007',
      '4780000000007',
    ]);
  });

  it('matn — o`zi (trim); bo`sh / juda uzun / satr emas — []', () => {
    expect(productBarcodeLookupVariants('  https://Zavod.uz/P/1 ')).toEqual([
      'https://Zavod.uz/P/1',
    ]);
    expect(productBarcodeLookupVariants('')).toEqual([]);
    expect(productBarcodeLookupVariants('   ')).toEqual([]);
    expect(
      productBarcodeLookupVariants('x'.repeat(PRODUCT_BARCODE_MAX_LENGTH + 1)),
    ).toEqual([]);
    expect(productBarcodeLookupVariants(null)).toEqual([]);
    expect(productBarcodeLookupVariants({})).toEqual([]);
  });

  it('⭐ UPC-E skani → [xom, kengaytirilgan UPC-A ning kanonik shakli]', () => {
    expect(productBarcodeLookupVariants('04963406')).toEqual([
      '04963406',
      '0049000006346',
    ]);
    expect(productBarcodeLookupVariants('049000006346')).toEqual([
      '049000006346',
      '0049000006346',
    ]);
  });

  it('⭐ UPC-E / EAN-8 ikkiligi: boshqacha saqlangan teng qiymat ham qidiriladi', () => {
    // `1…` ikkala talqinda to'g'ri — GTIN-8 bo'lib saqlanadi; kengaytirib
    // yuboradigan skaner (12 xona) ham uni topadi.
    expect(productBarcodeLookupVariants('10017265')).toEqual([
      '10017265',
      '0100172000065',
    ]);
    expect(productBarcodeLookupVariants('100172000065')).toEqual([
      '100172000065',
      '0100172000065',
      '10017265',
    ]);
    // GS1 DataMatrix'dagi GTIN-8 (8 xona) va xuddi shu raqamlarning UPC-E
    // skani (kanonik UPC-A) bir-birini topadi.
    expect(productBarcodeLookupVariants('(01)00000000017268')).toEqual([
      '(01)00000000017268',
      '00017268',
      '0000172000068',
    ]);
    expect(productBarcodeLookupVariants('000172000068')).toEqual([
      '000172000068',
      '0000172000068',
      '00017268',
    ]);
  });

  it('noto`g`ri nazorat raqamli kod va ELC-P — xatosiz, faqat o`zicha qidiriladi', () => {
    expect(productBarcodeLookupVariants('4006381333932')).toEqual([
      '4006381333932',
    ]);
    expect(productBarcodeLookupVariants('ELC-P-000001')).toEqual([
      'ELC-P-000001',
    ]);
  });
});

describe('productBarcodeEquivalents (UPC-E ↔ EAN-8 ikkiligi)', () => {
  const ok = (raw: string) => {
    const result = normalizeProductBarcode(raw);
    expect(result.ok).toBe(true);
    return (result as { ok: true; value: string }).value;
  };

  it.each([
    ['10017265', ['0100172000065']],
    ['0100172000065', ['10017265']],
    ['00017268', ['0000172000068']],
    ['0000172000068', ['00017268']],
    // Siqilgan UPC-E GTIN-8 sifatida noto'g'ri — teng qiymat yo'q.
    ['0049000006346', []],
    ['04963400', []],
    ['4780000000007', []],
    ['0036000291452', []],
    ['10036000291459', []],
    ['73513537', []],
    ['https://Zavod.uz/P/1', []],
  ])('%p → %p', (canonical, expected) => {
    expect(productBarcodeEquivalents(canonical)).toEqual(expected);
  });

  it('⭐ har standart UPC-E: 8 / 12 / 13 / 14 xonali har qaysi skan, qaysi yozuvda saqlangan bo`lsa ham, topadi (namunada)', () => {
    let checked = 0;
    for (let i = 0; i < 1_000_000; i += 991) {
      for (const system of ['0', '1']) {
        for (let c = 0; c < 10; c += 1) {
          const upcE = `${system}${String(i).padStart(6, '0')}${c}`;
          const upcA = expandUpcE(upcE)!;
          if (!hasValidGtinCheckDigit(upcA) || compressUpcA(upcA) !== upcE) {
            continue;
          }
          if (/^0+$/.test(upcA)) continue;
          const scans = [upcE, upcA, `0${upcA}`, `00${upcA}`];
          const stored = scans.map((scan) => ok(scan));
          for (const scan of scans) {
            const variants = productBarcodeLookupVariants(scan);
            for (const value of stored) {
              expect(variants).toContain(value);
            }
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });
});
