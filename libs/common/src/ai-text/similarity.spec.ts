import {
  AI_MAX_CANDIDATES,
  PRODUCT_AUTO_MIN,
  SIM_LENGTH_RATIO_MIN,
  SUBSTRING_MIN_NEEDLE,
  bestSubstringSim,
  levenshtein,
  simRatio,
  tokenFuzzy,
} from './';

/**
 * I73soTpf. O'xshashlik funksiyalari. Eng muhimi — `simRatio` ning ikki
 * qat'iy himoyasi (raqam va uzunlik): BeePost'da o'lcham/model farqini
 * fuzzy yutib yuborishi eng ko'p pul yo'qotgan xato edi.
 */
describe('levenshtein', () => {
  it('klassik masofani hisoblaydi', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('andijon', 'andijn')).toBe(1);
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('bo`sh satrda ikkinchisining uzunligi', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', '')).toBe(0);
  });
});

describe('simRatio', () => {
  it('I73soTpf #5: simRatio("quloqchin 700 gr", "quloqchin 500 gr") === 0 (raqam qat`iyligi)', () => {
    expect(simRatio('quloqchin 700 gr', 'quloqchin 500 gr')).toBe(0);
  });

  it('I73soTpf #6: simRatio("a51", "a50") === 0', () => {
    expect(simRatio('a51', 'a50')).toBe(0);
  });

  it('I73soTpf #7: simRatio("olma", "olma va uzum sharbati") === 0 (uzunlik farqi 0.4 dan katta)', () => {
    expect(simRatio('olma', 'olma va uzum sharbati')).toBe(0);
  });

  it('raqamli satr faqat AYNAN teng bo`lsa 1', () => {
    expect(simRatio('a51', 'a51')).toBe(1);
    expect(simRatio('700 gr', '700 gr')).toBe(1);
    expect(simRatio('700 gr', '700 g')).toBe(0);
  });

  it('uzunlik chegarasi SIM_LENGTH_RATIO_MIN bo`yicha', () => {
    // 3 < 10 × 0.4 -> 0 (Levenshteinsiz).
    expect(simRatio('abc', 'abcdefghij')).toBe(0);
    // 4 = 10 × 0.4 -> chegarada hisoblanadi: 1 - 6/10.
    expect(simRatio('abcd', 'abcdefghij')).toBeCloseTo(0.4, 10);
  });

  it('imlo xatosiga bardosh (Levenshtein nisbati)', () => {
    expect(simRatio('televizr', 'televizor')).toBeCloseTo(1 - 1 / 9, 10);
    expect(simRatio('andijn', 'andijon')).toBeCloseTo(1 - 1 / 7, 10);
  });

  it('bo`sh satrda 0', () => {
    expect(simRatio('', 'olma')).toBe(0);
    expect(simRatio('olma', '')).toBe(0);
    expect(simRatio('', '')).toBe(0);
  });
});

describe('bestSubstringSim', () => {
  it('manzil ichidagi tuman nomini topadi (aniq va imlo xatosi bilan)', () => {
    expect(bestSubstringSim('toshkentyunusobodkocha12', 'yunusobod')).toBe(1);
    // Bitta harf tushib qolgan ("yunusobd") — oyna n-1.
    expect(bestSubstringSim('manzilyunusobdtumani', 'yunusobod')).toBeCloseTo(
      1 - 1 / 9,
      10,
    );
  });

  it('SUBSTRING_MIN_NEEDLE dan qisqa igna — 0', () => {
    expect(bestSubstringSim('qoqonshahri', 'qoq')).toBe(0);
  });

  it('hay igna uzunligidan qisqa yoki teng — oddiy Levenshtein nisbati', () => {
    expect(bestSubstringSim('olot', 'olot')).toBe(1);
    expect(bestSubstringSim('olo', 'olot')).toBeCloseTo(1 - 1 / 4, 10);
  });
});

describe('tokenFuzzy', () => {
  it('I73soTpf #11: tokenFuzzy("olma sharbat", "olma va uzum sharbat") === 0.5 — so`z soni farqiga jarima', () => {
    expect(tokenFuzzy('olma sharbat', 'olma va uzum sharbat')).toBe(0.5);
    expect(tokenFuzzy('olma sharbat', 'olma va uzum sharbat')).toBeLessThan(
      PRODUCT_AUTO_MIN,
    );
  });

  it('satr va massiv bir xil natija beradi', () => {
    expect(
      tokenFuzzy(['olma', 'sharbat'], ['olma', 'va', 'uzum', 'sharbat']),
    ).toBe(0.5);
    expect(tokenFuzzy('  olma   sharbat ', 'olma sharbat')).toBe(1);
  });

  it('har so`zga eng yaqin so`zning o`rtachasi', () => {
    expect(tokenFuzzy('televizr', 'televizor')).toBeCloseTo(1 - 1 / 9, 10);
    // Raqamli so'z faqat aniq tenglikda mos: "a51" vs "a50" -> 0.
    expect(tokenFuzzy('samsung a51', 'samsung a50')).toBe(0.5);
  });

  it('bo`sh kirishda 0', () => {
    expect(tokenFuzzy('', 'olma')).toBe(0);
    expect(tokenFuzzy('olma', [])).toBe(0);
    expect(tokenFuzzy([], [])).toBe(0);
  });
});

describe('o`xshashlik konstantalari', () => {
  it('bo`sag`alar eksport qilingan konstantalar', () => {
    expect(SIM_LENGTH_RATIO_MIN).toBe(0.4);
    expect(SUBSTRING_MIN_NEEDLE).toBe(4);
    expect(AI_MAX_CANDIDATES).toBe(5);
  });
});
