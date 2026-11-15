import {
  extractMoneyMentions,
  extractMoneyMentionsDetailed,
  priceDerivableFromMentions,
  priceMismatchesMentions,
  quantityLooksLikeMoney,
  uniqueMentionValues,
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
    ["150000so'm", [150000]],
    ["1 500 000so'm", [1500000]],
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

describe('PR #649 sharhi — ekstraktor', () => {
  it.each([
    // B1: valyuta raqamga yopishgan — 10 baravar kichik qiymat YO'Q.
    ["atir 150000so'm", [150000]],
    ['1500000сум', [1500000]],
    ["85000so'm", [85000]],
    ["1 500 000so'm", [1500000]],
    ["150000so'mdan", [150000]],
    ['150000сўм', [150000]],
    ['150000sum', [150000]],
    // Kelishik qo'shimchalari.
    ['150 mingga', [150000]],
    ['150 minglik', [150000]],
    ['1,5 mlnga', [1500000]],
    ['150 mingni', [150000]],
    // Raqamlar yopishishi.
    ['atir 2 150 ming', [150000]],
    ['krossovka 42 350 ming', [350000]],
    ["uy 12 150 000 so'm", [150000]],
    ['kv 45 150 000', [150000]],
    ['д. 7 150 000', [150000]],
    ['razmer 42 350 000', [350000]],
    ['3 mln 2 kunda', [3000000]],
    ['4 mln 12-uy', [4000000]],
    ['4 mln 200', [4200000]],
    ["4 mln 200 so'm", [4200000]],
    ['4 mln 200, Asaka', [4200000]],
    // Valyuta so'm emas.
    ['$1 200', []],
    ['usd 1 500', []],
    ['1 200$', []],
    ['soat 150 000 sumkasi bilan', [150000]],
    // Takrorlar saqlanadi (ikki mahsulot).
    ['atir 150 ming, krem 150 ming', [150000, 150000]],
    // 3-davra S5: guruh raqam bilan chegaralangan; telefonlar.
    ['tel 901 234 567 atir 150 000', [150000]],
    ['raqam: 931 234 567, atir 150 000', [150000]],
    ['+998 90 1234 567', []],
    ["1 2345 so'm", [2345]],
    ['150 0000', []],
    ['+7 999 123 45 67', []],
    ['muzlatgich 901 234 567', [901234567]],
    // S11: inkor qilingan summa tashlanadi.
    ['180 ming emas 150 ming', [150000]],
    ['180 ming эмас, 150 ming', [150000]],
  ])('%s → %j', (text, want) => {
    expect(extractMoneyMentions(text)).toEqual(want);
  });

  it.each([
    ['dostavka 20 ming', 'delivery'],
    ['dostavkasi 20 ming', 'delivery'],
    ['dastavka: 20 000', 'delivery'],
    ['yetkazib berish 25 ming', 'delivery'],
    ['доставка 20 000', 'delivery'],
    ['20 ming dostavka', 'delivery'],
    ['20 ming dostavka.', 'delivery'],
    ['oldindan 50 ming', 'prepaid'],
    ["oldindan to'lov 50 ming", 'prepaid'],
    ["50 000 to'landi", 'prepaid'],
    ['100 ming zaklad', 'prepaid'],
    ['predoplata 100 000', 'prepaid'],
    ['предоплата 100 тыс', 'prepaid'],
    ['avans 50 ming', 'prepaid'],
    ['50 ming kartaga tashladi', 'prepaid'],
    ['qolgani 120 ming', 'prepaid'],
    ['dostavka bilan 170 ming', 'total'],
    ['с доставкой 170 тыс', 'total'],
    ['150 ming dostavka bilan', 'total'],
    ['sumka 2 ta 210 000 jami', 'total'],
    ['jami summa: 300 000', 'total'],
    ['umumiy 300 ming', 'total'],
    ['donasi 100 ming', 'unit'],
    ["150 000 so'mdan", 'unit'],
    ['har biri 90 ming', 'unit'],
    ['за штуку 90 тыс', 'unit'],
    // 3-davra S11: to'lov so'zlari.
    ["50 ming click orqali o'tkazdi", 'prepaid'],
    ["50 ming kartaga o'tkazdim", 'prepaid'],
    ['оплачено 50 000', 'prepaid'],
    ['qolgan 100 ming', 'prepaid'],
  ])('%s → %s', (text, kind) => {
    expect(extractMoneyMentionsDetailed(text)[0]?.kind).toBe(kind);
  });

  it.each([
    // "по" va "summa" — faqat so'z boshida.
    ['kupon 150 000', null],
    ['isumma 150 000', null],
    // Dostavka so'zidan keyin son / bilan / bepul / до — narx mahsulotniki.
    ['atir 150 ming dostavka 20 ming', null],
    ['150 ming dostavka bepul', null],
    ['150 ming dostavka tekin', null],
    ['400 тыс доставка до двери', null],
    // Yangi qatordan o'tmaydi.
    ['150 ming\ndostavka kerak', null],
    ['dostavka\n150 ming', null],
  ])('%j → turi %s', (text, kind) => {
    expect(extractMoneyMentionsDetailed(text)[0]?.kind).toBe(kind);
  });

  it.each([
    ['120-150 ming'],
    ['120 yoki 150 ming'],
    ['120 ming yoki 150 ming'],
    ['eski narx 180 ming, yangi 150 ming'],
    ['150 ming (skidka bilan 130 ming)'],
    ['200 ming, 10% chegirma'],
    ['старая цена 180 тыс, новая 150 тыс'],
  ])('%s — noaniq narx', (text) => {
    const list = extractMoneyMentionsDetailed(text);
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((m) => m.ambiguous)).toBe(true);
  });

  it.each([
    // 3-davra S8: chegirma so'zi summaga yaqin yoki ikki xil summa.
    ['atir 150 ming aksiya narxida'],
    [
      'atir 150 ming, krem 80 ming\n\n\n\n\nAksiya davom etmoqda, kanalga obuna bo‘ling!',
    ],
    // S11: "...dan ...gacha" — oraliq.
    ['120 mingdan 150 minggacha'],
  ])('%j — noaniq narx (3-davra)', (text) => {
    expect(extractMoneyMentionsDetailed(text).some((m) => m.ambiguous)).toBe(
      true,
    );
  });

  it.each([
    [
      'atir 150 ming\nAsaka\n\n\nAksiya! Har hafta yangi mahsulotlar, kanalga obuna',
    ],
    ['Skidkalar kanalimizda! ________________________________\natir 150 ming'],
  ])('%j — uzoqdagi yolg‘iz "aksiya" noaniq emas', (text) => {
    const list = extractMoneyMentionsDetailed(text);
    expect(list.length).toBe(1);
    expect(list.some((m) => m.ambiguous)).toBe(false);
  });

  it('oddiy narx noaniq emas', () => {
    expect(
      extractMoneyMentionsDetailed('atir 150 ming, dostavka 20 ming').some(
        (m) => m.ambiguous,
      ),
    ).toBe(false);
  });

  it('uniqueMentionValues — UI uchun takrorsiz', () => {
    expect(
      uniqueMentionValues(
        extractMoneyMentionsDetailed('atir 150 ming, krem 150 ming, 50 ming'),
      ),
    ).toEqual([150000, 50000]);
  });
});

/**
 * Korpus: [matn, mahsulot miqdorlari, qabul qilinadigan narxlar,
 * belgilanadigan (mismatch) narxlar]. Hammasi sintetik.
 */
const CORPUS: [string, number[], number[], number[]][] = [
  // B1
  ["atir 150000so'm", [1], [150000], [15000]],
  ['1500000сум', [1], [1500000], [150000]],
  ["85000so'm", [1], [85000], [8500]],
  ["1 500 000so'm", [1], [1500000], [1500]],
  ["150000so'mdan 2 ta", [2], [300000], [15000, 150000]],
  // B2: tur hisobga olinadi.
  ['3 ta, donasi 250 ming', [3], [750000], [250000]],
  ['jami 750 ming (3 ta)', [3], [750000], [2250000, 250000]],
  ['atir 3 ta 250 ming', [3], [250000, 750000], [25000]],
  ['3 ta, donasi 250 ming, jami 750 000', [3], [750000], [250000, 1000000]],
  // B3: mahsulot + dostavka; oldindan to'lov ayirilmaydi.
  ['atir 150 ming, dostavka 20 ming', [1], [170000], [150000, 20000, 130000]],
  ['atir 150 ming, 20 ming dostavka', [1], [170000], [150000]],
  ['atir 150 ming dostavka 20 ming', [1], [170000], [150000]],
  [
    "150 000, dostavka 20 000, oldindan 50 000 to'landi",
    [1],
    [170000],
    [150000, 120000, 220000, 100000],
  ],
  [
    'kurtka 650 ming, 100 ming zaklad, dostavka 25 ming',
    [1],
    [675000],
    [650000, 550000, 575000, 775000],
  ],
  [
    '2 ta atir 150 mingdan, jami 300 ming + dostavka 25 ming',
    [2],
    [325000],
    [300000, 150000, 175000],
  ],
  ['atir 150 ming, dostavka 20 ming, jami 170 ming', [1], [170000], [190000]],
  ['dostavka bilan 170 ming', [1], [170000], [150000]],
  ['2 ta donasi 100 ming, dostavka 30 ming', [2], [230000], [200000, 130000]],
  ['avans 50 ming, kurtka 400 ming', [1], [400000], [350000, 450000]],
  [
    'predoplata 100 000, qolgani 200 000, sumka 300 000',
    [1],
    [300000],
    [200000],
  ],
  // Raqamlar yopishishi.
  ['atir 2 150 ming', [1], [150000], [2150000]],
  ['krossovka 42 350 ming', [1], [350000], [42350000]],
  ["uy 12 150 000 so'm", [1], [150000], [12150000]],
  ['kv 45 150 000', [1], [150000], [45150000]],
  ['televizor 3 mln 2 kunda yetkazing', [1], [3000000], [3002000]],
  ['muzlatgich 4 mln 12-uy', [1], [4000000], [4012000]],
  ['muzlatgich 4 mln 200', [1], [4200000], [4000200]],
  // Ko'p mahsulot.
  // Tartibsiz moslash: 150 000 / 200 000 ham kelib chiqadi (krem ← 100 ming).
  [
    'atir 2 ta donasi 100 ming, krem 50 ming',
    [2, 1],
    [250000],
    [25000, 100000],
  ],
  [
    'futbolka 3 ta 90 mingdan, shim 2 ta 150 mingdan',
    [3, 2],
    [570000],
    [240000, 390000],
  ],
  [
    'atir 150 ming, krem 150 ming, sovun 50 ming',
    [1, 1, 1],
    [350000],
    [200000, 150000],
  ],
  ['atir 150 ming, krem 50 ming', [1, 1], [200000], [150000, 50000]],
  ['atir 120 ming, krem 80 ming, jami 200 ming', [1, 1], [200000], [400000]],
  [
    'atir 120 ming, krem 80 ming, dostavka 25 ming',
    [1, 1],
    [225000],
    [200000, 145000],
  ],
  // Ko'p mahsulot, eslatma kam — tekshirilmaydi.
  ['atir va krem 200 ming', [1, 1], [200000, 20000], []],
  // Noaniq narx — tekshirilmaydi.
  ['120-150 ming', [1], [120000, 150000, 15000], []],
  ['120 yoki 150 ming', [1], [120000, 150000, 1000], []],
  ['eski narx 180 ming, yangi 150 ming', [1], [150000, 180000], []],
  ['150 ming (skidka bilan 130 ming)', [1], [130000, 150000], []],
  ['200 ming, 10% chegirma', [1], [180000, 200000], []],
  // Faqat dostavka aytilgan — mahsulot summasi noma'lum.
  ['dostavka 20 ming', [1], [150000, 20000], []],
  // Rus / kirill.
  ['пылесос 1,5 млн', [1], [1500000], [150000]],
  ['по 150 тыс 2 шт', [2], [300000], [150000]],
  ['блендер 400 тыс, доставка 30 тыс', [1], [430000], [400000]],
  ['итого 750 тыс', [3], [750000], [2250000]],
  // Sanalar, telefon tokenlari, dollar — eslatma emas.
  ['[TEL_1] Asaka 2026-yil, atir 150 ming', [1], [150000], [2026000]],
  ['soat $1 200', [1], [1200, 15000000], []],
  // 3-davra S1: jami dostavkadan OLDIN, lekin dostavka jami ichida.
  ['Jami 170 000 (dostavka 20 000 bilan)', [1], [170000], [190000, 150000]],
  ['Jami 170 ming, shundan dostavka 20 ming', [1], [170000], [190000]],
  ['Итого 170 000, включая доставку 20 000', [1], [170000], [190000]],
  [
    "Umumiy summa: 170 000 so'm (shu jumladan dostavka 20 000)",
    [1],
    [170000],
    [190000],
  ],
  ['Итого 170 тыс, в т.ч. доставка 20 тыс', [1], [170000], [190000]],
  // Jamisiz "dostavka ... bilan" — ikkala talqin ham qabul.
  [
    'atir 150 ming (dostavka 20 ming bilan)',
    [1],
    [150000, 170000],
    [190000, 130000],
  ],
  // Ichida emas — avvalgidek jami + dostavka.
  ['jami 150 ming, dostavka 20 ming', [1], [170000], [150000]],
  // S2: dostavka tarifi footer'i — har tarif alohida, yig'indisi emas.
  [
    'atir 150 000\nDostavka: Toshkent 20 000, viloyatlarga 35 000',
    [1],
    [170000, 185000],
    [150000, 205000],
  ],
  [
    "atir 150 000\nDostavka Toshkent bo'ylab 20 000, viloyatlarga 35 000",
    [1],
    [170000, 185000],
    [150000, 205000],
  ],
  [
    'atir 150 000\nDostavka Toshkent 20 ming / viloyat 35 ming',
    [1],
    [170000, 185000],
    [150000, 205000],
  ],
  // S3: "dostavka bilan" dan keyin son — oldingi summa jami emas.
  ['atir 150 ming dostavka bilan jami 170 ming', [1], [170000], [150000]],
  ['atir 150 ming dostavka bilan 170 ming', [1], [170000], [150000]],
  // S5: telefon raqamlari pul emas.
  ['tel 901 234 567 atir 150 000', [1], [150000], [901234567]],
  ['+998 90 1234 567 atir 150 ming', [1], [150000], [90123000]],
  ['+7 999 123 45 67, atir 150 ming', [1], [150000], [999123]],
  // S8: shablon footer'idagi "Aksiya" — narx noaniq EMAS.
  [
    'atir 150 ming\nAsaka\n\n🔥 Aksiya! Har hafta yangi mahsulotlar 🔥',
    [1],
    [150000],
    [15000],
  ],
  // S11: oraliq "...dan ...gacha", inkor "emas", to'lov so'zlari.
  ['120 mingdan 150 minggacha', [1], [120000, 150000, 1000], []],
  ['180 ming emas 150 ming', [1], [150000], [180000, 330000]],
  [
    "atir 150 ming, 50 ming click orqali o'tkazdi",
    [1],
    [150000],
    [100000, 200000],
  ],
  ['atir 150 000, оплачено 50 000', [1], [150000], [100000, 200000]],
  ['atir 150 ming, qolgan 100 ming', [1], [150000], [250000]],
];

describe('3-davra — dostavka jami ichida / tarif', () => {
  it.each([
    ['Jami 170 000 (dostavka 20 000 bilan)', [170000, 20000]],
    ['Jami 170 ming, shundan dostavka 20 ming', [170000, 20000]],
    ['Итого 170 000, включая доставку 20 000', [170000, 20000]],
  ])('%s — included', (text, values) => {
    const list = extractMoneyMentionsDetailed(text);
    expect(list.map((m) => m.value)).toEqual(values);
    expect(list[0].kind).toBe('total');
    expect(list[1]).toMatchObject({ kind: 'delivery', included: true });
  });

  it('oddiy dostavka included emas', () => {
    expect(
      extractMoneyMentionsDetailed('jami 150 ming, dostavka 20 ming')[1]
        ?.included,
    ).toBeUndefined();
  });

  it.each([
    ['Dostavka: Toshkent 20 000, viloyatlarga 35 000'],
    ["Dostavka Toshkent bo'ylab 20 000, viloyatlarga 35 000"],
    ['Dostavka Toshkent 20 ming / viloyat 35 ming'],
    ['Доставка по Ташкенту 20 000, по области 35 000'],
  ])('%s — ikkala tarif dostavka', (text) => {
    expect(extractMoneyMentionsDetailed(text).map((m) => m.kind)).toEqual([
      'delivery',
      'delivery',
    ]);
  });

  it('dostavkadan keyingi boshqa qatordagi summa — tarif davomi emas', () => {
    expect(
      extractMoneyMentionsDetailed(
        'Dostavka Toshkent 20 000\nviloyat 35 000',
      )[1]?.kind,
    ).toBeNull();
  });
});

describe('PR #649 korpus — qaror', () => {
  it.each(CORPUS)('%s (miqdor %j)', (text, qtys, accept, flag) => {
    const mentions = extractMoneyMentionsDetailed(text);
    for (const p of accept) {
      expect({ p, flag: priceMismatchesMentions(p, mentions, qtys) }).toEqual({
        p,
        flag: false,
      });
    }
    for (const p of flag) {
      expect({ p, flag: priceMismatchesMentions(p, mentions, qtys) }).toEqual({
        p,
        flag: true,
      });
    }
  });

  it("qidiruv chegarasi — ko'p mahsulot va ko'p eslatma tekshirilmaydi", () => {
    const mentions = Array.from({ length: 20 }, (_, i) => ({
      value: (i + 1) * 10_000,
      kind: null,
    }));
    expect(priceMismatchesMentions(1, mentions, [2, 2, 2, 2, 2, 2, 2, 2])).toBe(
      false,
    );
  });
});

describe('priceDerivableFromMentions (too_high)', () => {
  it.each([
    ['Cobalt mashina 120 mln', [1], 120_000_000, true],
    ['2 ta mashina donasi 120 mln', [2], 240_000_000, true],
    ['mashina 120 mln', [1], 150_000_000_000, false],
    ['', [1], 150_000_000, false],
  ])('%s', (text, qtys, price, want) => {
    expect(
      priceDerivableFromMentions(
        price,
        extractMoneyMentionsDetailed(text),
        qtys,
      ),
    ).toBe(want);
  });
});

describe('quantityLooksLikeMoney (qty_check)', () => {
  it.each([
    ['atir 150 ming', 150, true],
    ['televizor 2 mln', 2, true],
    ['atir 150 ming', 1, false],
    ['atir 2 ta 150 ming', 2, false],
    ['oldindan 5 ming', 5, false],
    // 3-davra S4: dona narxi yoki miqdor matnda aniq — to'g'ri miqdor.
    ['2 ta televizor 2 mln dan', 2, false],
    ['3 ta konditsioner, donasi 3 mln', 3, false],
    ['5 ta ruchka 5 mingdan, dostavka 20 ming', 5, false],
    ['televizor 2 ta, jami 2 mln', 2, false],
    ['konditsioner x3 3 mln', 3, false],
    // Miqdor aytilmagan — shubhali.
    ['konditsioner 3 mln', 3, true],
  ])('%s, quantity %d', (text, qty, want) => {
    expect(
      quantityLooksLikeMoney(qty, extractMoneyMentionsDetailed(text)),
    ).toBe(want);
  });
});
