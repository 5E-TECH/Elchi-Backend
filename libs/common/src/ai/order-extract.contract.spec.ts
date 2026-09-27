import {
  AI_IMAGE_MAX_BYTES,
  AI_MAX_IMAGES,
  AI_MAX_ITEMS_PER_ORDER,
  AI_MAX_ORDERS_PER_PARSE,
  AI_MAX_QUANTITY,
  AI_PRICE_CONFIRM_THRESHOLD,
  AI_TEXT_MAX_CHARS,
  type RawOrderExtraction,
  isJunkRawOrder,
} from './order-extract.contract';

type JunkInput = Pick<
  RawOrderExtraction,
  'phone_number' | 'extra_number' | 'items'
>;

describe('isJunkRawOrder (yxwpN5h5 #10 — axlat filtri)', () => {
  const cases: Array<[string, boolean, JunkInput]> = [
    [
      "telefon yo'q, mahsulot yo'q",
      true,
      { phone_number: null, extra_number: null, items: [] },
    ],
    [
      "telefon bor, mahsulot yo'q",
      false,
      { phone_number: '+998901234567', extra_number: null, items: [] },
    ],
    [
      "telefon yo'q, nomli mahsulot bor",
      false,
      {
        phone_number: null,
        extra_number: null,
        items: [{ name: 'Atir', quantity: 1 }],
      },
    ],
    [
      "faqat extra_number (9 raqam, bo'shliqlar bilan), mahsulot yo'q",
      false,
      { phone_number: null, extra_number: '90 123 45 67', items: [] },
    ],
    [
      "qisqa telefon (5 raqam) + bo'sh nomli mahsulot",
      true,
      {
        phone_number: '12345',
        extra_number: null,
        items: [{ name: '   ', quantity: 2 }],
      },
    ],
    [
      "8 raqamli telefon + bo'sh nom",
      true,
      {
        phone_number: '90-123-45-6',
        extra_number: '',
        items: [{ name: '', quantity: 1 }],
      },
    ],
    [
      'aynan 9 raqam (chegara)',
      false,
      { phone_number: '901234567', extra_number: null, items: [] },
    ],
    [
      "bo'sh + nomli mahsulot aralash",
      false,
      {
        phone_number: null,
        extra_number: null,
        items: [
          { name: ' ', quantity: 1 },
          { name: 'Krem', quantity: 3 },
        ],
      },
    ],
  ];

  it.each(cases)('%s → junk=%p', (_label, expected, input) => {
    expect(isJunkRawOrder(input)).toBe(expected);
  });

  it("LLM chiqishidagi buzuq shakllarga chidamli (items null, name null) — throw yo'q", () => {
    const brokenItems = {
      phone_number: null,
      extra_number: null,
      items: null,
    } as unknown as JunkInput;
    const nullName = {
      phone_number: null,
      extra_number: null,
      items: [{ name: null, quantity: 1 }, null],
    } as unknown as JunkInput;

    expect(isJunkRawOrder(brokenItems)).toBe(true);
    expect(isJunkRawOrder(nullName)).toBe(true);
  });

  it("to'liq RawOrderExtraction obyektini qabul qiladi", () => {
    const order: RawOrderExtraction = {
      customer_name: 'Ali',
      phone_number: '+998901234567',
      extra_number: null,
      region_name: 'Andijon',
      district_name: "Xo'jaobod",
      address: null,
      full_address: null,
      items: [{ name: 'Atir', quantity: 3 }],
      total_price: 750000,
      comment: null,
      where_deliver: null,
      is_replacement: false,
      operator: null,
    };
    expect(isJunkRawOrder(order)).toBe(false);
  });
});

describe('ekstraksiya chegaralari (C2)', () => {
  it('qiymatlar kontraktga mos', () => {
    expect(AI_TEXT_MAX_CHARS).toBe(4000);
    expect(AI_MAX_IMAGES).toBe(3);
    expect(AI_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(AI_MAX_ORDERS_PER_PARSE).toBe(30);
    expect(AI_MAX_ITEMS_PER_ORDER).toBe(50);
    expect(AI_MAX_QUANTITY).toBe(1000);
    expect(AI_PRICE_CONFIRM_THRESHOLD).toBe(10_000);
  });
});
