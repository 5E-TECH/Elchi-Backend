import {
  extractMoneyMentions,
  extractMoneyMentionsDetailed,
  priceMismatchesMentions,
} from './money-mentions';

describe('extractMoneyMentions (A1a)', () => {
  it.each([
    ["atir 150 000 so'm", [150000]],
    ['muzlatgich 1 500 000', [1500000]],
    ['narxi 150.000', [150000]],
    ['narxi 150,000', [150000]],
    ['televizor 1.5 mln', [1500000]],
    ['pylesos 1,5 млн', [1500000]],
    ['sumka 150k', [150000]],
    ['150 ming', [150000]],
    ['150 тыс', [150000]],
    ['4 mln 200', [4200000]],
    ['3 ta, donasi 250 ming, jami 750 000', [250000, 750000]],
    ['150 ming + dostavka 20 ming', [150000, 20000]],
    ['120 yoki 150 ming', [150000]],
    ["150000 so'm", [150000]],
  ])('%s → %j', (text, want) => {
    expect(extractMoneyMentions(text)).toEqual(want);
  });

  it.each([
    ['soat 150$'],
    ['150 usd'],
    ['3 ta atir'],
    ['50 dona'],
    ['Ali [TEL_1] Asaka'],
    ['uy 12, kv 45'],
    ['narx 500 so‘m'],
    ['2026-yil 14-noyabr'],
  ])('%s → yo‘q', (text) => {
    expect(extractMoneyMentions(text)).toEqual([]);
  });
});

describe('extractMoneyMentionsDetailed — turi', () => {
  it.each([
    ['donasi 250 ming', 'unit'],
    ['150 mingdan 3 ta', 'unit'],
    ['по 150 тыс', 'unit'],
    ['jami 750 000', 'total'],
    ['итого 750 тыс', 'total'],
    ['150 ming', null],
  ])('%s → %s', (text, kind) => {
    expect(extractMoneyMentionsDetailed(text)[0]?.kind).toBe(kind);
  });
});

describe('priceMismatchesMentions', () => {
  it('yakka, yig‘indi (mahsulot + dostavka), eslatma × miqdor — mos', () => {
    expect(priceMismatchesMentions(150000, [150000], 1)).toBe(false);
    expect(priceMismatchesMentions(170000, [150000, 20000], 1)).toBe(false);
    expect(priceMismatchesMentions(750000, [250000], 3)).toBe(false);
  });

  it('model xatolari — mos emas', () => {
    expect(priceMismatchesMentions(15000, [150000], 1)).toBe(true);
    // "jami 750 ming (3 ta)" — jami summa miqdorga ko'paytirilmaydi.
    expect(
      priceMismatchesMentions(
        2250000,
        extractMoneyMentionsDetailed('jami 750 ming (3 ta)'),
        3,
      ),
    ).toBe(true);
    // "donasi 250 ming" × 3 — to'g'ri.
    expect(
      priceMismatchesMentions(
        750000,
        extractMoneyMentionsDetailed('3 ta, donasi 250 ming'),
        3,
      ),
    ).toBe(false);
    expect(priceMismatchesMentions(1920000, [], 1)).toBe(false);
    expect(priceMismatchesMentions(4000200, [4200000], 1)).toBe(true);
  });

  it('narx yoki eslatma yo‘q — tekshirilmaydi', () => {
    expect(priceMismatchesMentions(null, [150000], 1)).toBe(false);
    expect(priceMismatchesMentions(150000, [], 1)).toBe(false);
  });
});
