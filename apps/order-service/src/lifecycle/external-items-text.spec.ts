import { readExternalItemsText } from './external-items-text';

/**
 * «Tashqi saytlar» — `items` matni → mahsulot qatorlari.
 *
 * ⚠️ Shu jadval Elchi-Frontend `siteOrder.test.ts` da ham bor: ro'yxatdagi
 * mahsulot yaratiladigan buyurtmaniki bilan bir xil bo'lishi kerak.
 */
const read = (raw: string, totalCount?: unknown) =>
  readExternalItemsText(raw, totalCount).map((item) => [
    item.product_name,
    item.quantity,
  ]);

describe('readExternalItemsText — ajraladigan matn', () => {
  it.each<[string, [string, number][]]>([
    ["Diskali soat x 1 = 99 000 so'm", [['Diskali soat', 1]]],
    ['Diskali soat x 3 = 297000', [['Diskali soat', 3]]],
    // Saytlar yozadigan boshqa shakllar.
    ['Soat X2=99000', [['Soat', 2]]],
    ['Soat х 2 = 99 000 сум', [['Soat', 2]]],
    ['Soat × 2 = 99.000 UZS', [['Soat', 2]]],
    ['Soat * 2 = 99,000.50 so‘m.', [['Soat', 2]]],
    ["  Soat  x 1 = 99 000 so'm ; ", [['Soat', 1]]],
    // Bir nechta qator.
    [
      "Soat x 1 = 99 000 so'm, Kamar x 2 = 50 000 so'm",
      [
        ['Soat', 1],
        ['Kamar', 2],
      ],
    ],
    [
      "Soat x 1 = 99 000 so'm\r\n\nKamar x 2 = 50 000 so'm\n",
      [
        ['Soat', 1],
        ['Kamar', 2],
      ],
    ],
    [
      'Soat x 1 = 99 000; Kamar x 2 = 50 000;',
      [
        ['Soat', 1],
        ['Kamar', 2],
      ],
    ],
    // Summadagi vergul chegara emas; keyingi nom raqamdan boshlansa ham.
    [
      '2-qavat soat x 1 = 99,000, 200 ml krem x 2 = 5 000',
      [
        ['2-qavat soat', 1],
        ['200 ml krem', 2],
      ],
    ],
    // Nom ichida vergul, `x` va o'lcham.
    ["Soat, qora, XL x 1 = 99 000 so'm", [['Soat, qora, XL', 1]]],
    ['Gilam 2 x 3 x 1 = 500 000', [['Gilam 2 x 3', 1]]],
  ])('%j', (raw, expected) => {
    // Matn ajralsa son matndan — `total_count` e'tiborsiz.
    expect(read(raw, 7)).toEqual(expected);
  });
});

describe('readExternalItemsText — ishonch bilan ajralmaydi', () => {
  it.each([
    'Diskali soat',
    // `= summa` yo'q: o'lcham ham bo'lishi mumkin.
    'Gilam 2 x 3',
    'Soat x 2',
    // Son emas, narx.
    'Soat x 99000 = 99000',
    'Soat x 0 = 0',
    'Soat x 1.5 = 99 000',
    'Soat x 1 = bepul',
    '1 x Soat = 99 000',
    // Bir bo'lagi ajralib, qolgani ajralmasa — hammasi bitta qator.
    "Soat x 1 = 99 000 so'm, Kamar",
    "Soat x 1 = 99 000 so'm Kamar x 2 = 50 000 so'm",
    "Sovg'a; Soat x 1 = 99 000 so'm",
    // Ajralmagan oldingi qator keyingisining nomiga yutilmasin.
    'Soat x 99000 = 99000, Kamar x 2 = 50 000',
    'Soat = 99 000, Kamar x 2 = 50 000',
    // Noma'lum valyuta: "99,000" vergulidan bo'linib, "000 tenge" nomga tushmasin.
    'Soat x 1 = 99,000 tenge, Kamar x 2 = 50 000',
    'Soat x 1 = 99 000 Kamar',
  ])('⭐ %j — butun matn bitta qator, soni total_count', (raw) => {
    expect(read(raw, 4)).toEqual([[raw, 4]]);
  });

  it("yangi qatorlar nomda bo'shliqqa aylanadi", () => {
    expect(read("Sovg'a\n  Soat x 1 = 99 000", 2)).toEqual([
      ["Sovg'a Soat x 1 = 99 000", 2],
    ]);
  });

  it.each<[unknown, number]>([
    [3, 3],
    ['3', 3],
    [' 12 ', 12],
    [undefined, 1],
    [null, 1],
    ['', 1],
    [0, 1],
    [-2, 1],
    [1.5, 1],
    ['2 ta', 1],
    [NaN, 1],
    [true, 1],
    [[5], 1],
    // int4 ga sig'maydi — INSERT yiqilmasin.
    [2_147_483_648, 1],
  ])('total_count=%p → %p', (totalCount, expected) => {
    expect(read('Soat', totalCount)).toEqual([['Soat', expected]]);
  });
});

describe('readExternalItemsText — chegaralar', () => {
  it.each(['', '   ', '\n', '-', '[]', '{}'])(
    "%j — mahsulot emas, bo'sh ro'yxat",
    (raw) => {
      expect(read(raw, 1)).toEqual([]);
    },
  );

  it('⭐ nom 255 belgidan oshmaydi (varchar(255))', () => {
    const long = 'я'.repeat(300);
    expect(read(long)).toEqual([['я'.repeat(255), 1]]);
    expect(read(`${long} x 2 = 99 000`)).toEqual([['я'.repeat(255), 2]]);
  });

  it("juda uzun matn ham tez o'qiladi (regex portlamaydi)", () => {
    const started = Date.now();
    read('Soat x 1 = 9 '.repeat(20_000), 1);
    read('x 1 = 1 000 000 '.repeat(20_000), 1);
    read(' '.repeat(200_000) + 'a', 1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('ketma-ket chaqiruvlar bir-biriga tegmaydi', () => {
    expect(read('Soat x 1 = 99 000, Kamar', 1)).toHaveLength(1);
    expect(read('Soat x 2 = 99 000')).toEqual([['Soat', 2]]);
    expect(read('Soat x 2 = 99 000')).toEqual([['Soat', 2]]);
  });
});
