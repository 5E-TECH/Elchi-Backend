import {
  PRODUCT_AUTO_MARGIN,
  PRODUCT_AUTO_MIN,
  PRODUCT_CANDIDATE_MIN,
  PRODUCT_EXACT_SCORE,
  PRODUCT_SUBSTRING_SCORE,
  SIM_LENGTH_RATIO_MIN,
  normalizeProduct,
} from './';

/**
 * I73soTpf. Mahsulot nomi normalizatsiyasi va mahsulot tanlash bo'sag'alari
 * (BeePost `rankProducts` / avto-tanlash qoidasi).
 */
describe('normalizeProduct', () => {
  it('translit qiladi va miqdor so`zlarini (dona, ta, pcs, sht, shtuk) olib tashlaydi', () => {
    expect(normalizeProduct('Quloqchin 700 gr 2 dona')).toBe(
      'quloqchin 700 gr 2',
    );
    expect(normalizeProduct('Олма шарбати 3 та')).toBe('olma sharbati 3');
    expect(normalizeProduct('Televizor  Samsung  A51 pcs')).toBe(
      'televizor samsung a51',
    );
    expect(normalizeProduct('Krossovka 1 sht')).toBe('krossovka 1');
    expect(normalizeProduct('Krossovka 1 shtuk')).toBe('krossovka 1');
  });

  it('miqdor so`zi faqat ALOHIDA so`z bo`lsa olinadi', () => {
    expect(normalizeProduct('Kartoshka')).toBe('kartoshka');
    expect(normalizeProduct('Donaxon choy')).toBe('donaxon choy');
  });

  it('raqamlarni saqlaydi (simRatio raqam qat`iyligi uchun)', () => {
    expect(normalizeProduct('Samsung A51')).not.toBe(
      normalizeProduct('Samsung A50'),
    );
  });

  it('satr bo`lmagan qiymatda bo`sh satr', () => {
    expect(normalizeProduct(null)).toBe('');
    expect(normalizeProduct(undefined)).toBe('');
    expect(normalizeProduct('  ')).toBe('');
  });
});

describe('mahsulot konstantalari', () => {
  it('bo`sag`alar hardcode emas — eksport qilingan konstantalar', () => {
    expect(PRODUCT_EXACT_SCORE).toBe(1);
    expect(PRODUCT_SUBSTRING_SCORE).toBe(0.8);
    expect(PRODUCT_AUTO_MIN).toBe(0.85);
    expect(PRODUCT_AUTO_MARGIN).toBe(0.2);
    expect(PRODUCT_CANDIDATE_MIN).toBe(0.4);
  });

  it('substring mosligi hech qachon avto-tanlanmaydi (0.8 < 0.85)', () => {
    expect(PRODUCT_SUBSTRING_SCORE).toBeLessThan(PRODUCT_AUTO_MIN);
  });

  it('PRODUCT_CANDIDATE_MIN va SIM_LENGTH_RATIO_MIN — alohida konstantalar (qiymati bir xil)', () => {
    expect(PRODUCT_CANDIDATE_MIN).toBe(SIM_LENGTH_RATIO_MIN);
  });
});
