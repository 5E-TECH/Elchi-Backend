import type { RawOrderExtraction } from '@app/common';
import { sanitizeExtraction } from './sanitize-extraction';

/** To'liq, yaroqli bitta buyurtma (model chiqishi shaklida). */
function order(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    customer_name: 'Ali',
    phone_number: '+998901234567',
    extra_number: null,
    region_name: 'Andijon',
    district_name: 'Asaka',
    address: null,
    full_address: null,
    items: [{ name: 'atir', quantity: 3 }],
    total_price: 750000,
    comment: null,
    where_deliver: 'address',
    is_replacement: false,
    operator: null,
    ...overrides,
  };
}

function one(overrides: Record<string, unknown>): RawOrderExtraction {
  const out = sanitizeExtraction({ orders: [order(overrides)] });
  expect(out).toHaveLength(1);
  return out[0];
}

describe('sanitizeExtraction', () => {
  it('yaroqli buyurtma o‘zgarishsiz o‘tadi (13 maydon)', () => {
    const res = one({});
    expect(res).toEqual({
      customer_name: 'Ali',
      phone_number: '+998901234567',
      extra_number: null,
      region_name: 'Andijon',
      district_name: 'Asaka',
      address: null,
      full_address: null,
      items: [{ name: 'atir', quantity: 3 }],
      total_price: 750000,
      comment: null,
      where_deliver: 'address',
      is_replacement: false,
      operator: null,
    });
    expect(Object.keys(res)).toHaveLength(13);
  });

  describe('yxwpN5h5 #2 — total_price: 0 yoki manfiy → null (0 EMAS)', () => {
    it.each([
      [0, null],
      [-1, null],
      [-5000, null],
      [null, null],
      [undefined, null],
      [Number.NaN, null],
      [Number.POSITIVE_INFINITY, null],
      ['750000', null],
      [750000, 750000],
      [2500000, 2500000],
      [300000.4, 300000],
      [180000.6, 180001],
    ])('%p → %p', (input, expected) => {
      expect(one({ total_price: input }).total_price).toBe(expected);
    });
  });

  describe("yxwpN5h5 #7 — where_deliver faqat 'center' | 'address' | null", () => {
    it.each([
      ['center', 'center'],
      ['address', 'address'],
      ['free', null],
      ['Address', null],
      ['CENTER', null],
      [' center ', null],
      ['', null],
      [null, null],
      [1, null],
    ])('%p → %p', (input, expected) => {
      expect(one({ where_deliver: input }).where_deliver).toBe(expected);
    });
  });

  describe('yxwpN5h5 #10 — axlat filtri (telefon HAM, mahsulot HAM yo‘q)', () => {
    it.each([
      [
        'telefon ham, mahsulot ham yo‘q → tashlanadi',
        { phone_number: null, extra_number: null, items: [] },
        0,
      ],
      [
        'faqat ism qoldig‘i → tashlanadi',
        {
          customer_name: 'Ali',
          phone_number: null,
          extra_number: null,
          items: [],
          total_price: null,
        },
        0,
      ],
      [
        'telefon 9 raqamdan kam, mahsulot nomi bo‘sh → tashlanadi',
        {
          phone_number: '12345',
          extra_number: null,
          items: [{ name: '   ', quantity: 1 }],
        },
        0,
      ],
      [
        'items massiv emas, telefon yo‘q → tashlanadi',
        { phone_number: null, extra_number: null, items: 'atir' },
        0,
      ],
      [
        'faqat telefon → qoladi',
        { phone_number: '+998901234567', extra_number: null, items: [] },
        1,
      ],
      [
        'faqat qo‘shimcha raqam → qoladi',
        { phone_number: null, extra_number: '90 123 45 67', items: [] },
        1,
      ],
      [
        'faqat mahsulot → qoladi',
        {
          phone_number: null,
          extra_number: null,
          items: [{ name: 'atir', quantity: 1 }],
        },
        1,
      ],
    ])('%s', (_label, overrides, expectedLength) => {
      expect(sanitizeExtraction({ orders: [order(overrides)] })).toHaveLength(
        expectedLength,
      );
    });
  });

  it('13 ta ruxsat etilgan maydondan boshqa kalitlar tashlanadi', () => {
    const res = one({
      district_id: '160',
      region_id: '1',
      product_id: '7',
      market_id: '3',
      operator_id: '99',
      status: 'sold',
    }) as unknown as Record<string, unknown>;
    for (const key of [
      'district_id',
      'region_id',
      'product_id',
      'market_id',
      'operator_id',
      'status',
    ]) {
      expect(res).not.toHaveProperty(key);
    }
  });

  it('item ichidagi begona kalitlar (product_id) ham tashlanadi', () => {
    const res = one({
      items: [{ name: 'atir', quantity: 2, product_id: '5', price: 1 }],
    });
    expect(res.items).toEqual([{ name: 'atir', quantity: 2 }]);
  });

  it('satrlar trim qilinadi, bo‘sh satr → null, satr bo‘lmagan → null', () => {
    const res = one({
      customer_name: '  Ali  ',
      region_name: '   ',
      district_name: '',
      address: 'paxtaobod mfy 5-uy ',
      full_address: 123,
      comment: '\n',
    });
    expect(res.customer_name).toBe('Ali');
    expect(res.region_name).toBeNull();
    expect(res.district_name).toBeNull();
    expect(res.address).toBe('paxtaobod mfy 5-uy');
    expect(res.full_address).toBeNull();
    expect(res.comment).toBeNull();
  });

  it("operator: boshidagi '#' olib tashlanadi va trim qilinadi", () => {
    expect(one({ operator: '#sevinch' }).operator).toBe('sevinch');
    expect(one({ operator: ' ##admin ' }).operator).toBe('admin');
    expect(one({ operator: '# ali' }).operator).toBe('ali');
    expect(one({ operator: '#' }).operator).toBeNull();
    expect(one({ operator: 42 }).operator).toBeNull();
  });

  it('items: bo‘sh nomli qatorlar tashlanadi, nom trim qilinadi', () => {
    const res = one({
      items: [
        { name: '  atir ', quantity: 2 },
        { name: '', quantity: 5 },
        { name: null, quantity: 1 },
        'atir',
        null,
        { quantity: 4 },
      ],
    });
    expect(res.items).toEqual([{ name: 'atir', quantity: 2 }]);
  });

  it.each([
    [0, 1],
    [-2, 1],
    [2.5, 1],
    ['3', 1],
    [null, 1],
    [undefined, 1],
    [1, 1],
    [1000, 1000],
    // ⚠️ 1000 dan kattasi o'zgartirilmaydi — ai-confirm DTO to'xtatadi.
    [99999, 99999],
  ])('quantity %p → %p', (input, expected) => {
    expect(one({ items: [{ name: 'atir', quantity: input }] }).items).toEqual([
      { name: 'atir', quantity: expected },
    ]);
  });

  it('is_replacement faqat aynan true bo‘lsa true', () => {
    expect(one({ is_replacement: true }).is_replacement).toBe(true);
    expect(one({ is_replacement: 'true' }).is_replacement).toBe(false);
    expect(one({ is_replacement: 1 }).is_replacement).toBe(false);
    expect(one({ is_replacement: null }).is_replacement).toBe(false);
  });

  it('obyekt bo‘lmagan elementlar tashlanadi', () => {
    const res = sanitizeExtraction({
      orders: [null, 'order', 5, [order()], order()],
    });
    expect(res).toHaveLength(1);
  });

  it('kirish shakli: {orders}, massiv yoki boshqa narsa', () => {
    expect(sanitizeExtraction({ orders: [order()] })).toHaveLength(1);
    expect(sanitizeExtraction([order()])).toHaveLength(1);
    expect(sanitizeExtraction(null)).toEqual([]);
    expect(sanitizeExtraction('x')).toEqual([]);
    expect(sanitizeExtraction({ orders: 'x' })).toEqual([]);
    expect(sanitizeExtraction({})).toEqual([]);
  });

  it('kirish obyekti o‘zgartirilmaydi', () => {
    const input = { orders: [order({ operator: '#x', district_id: '1' })] };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    sanitizeExtraction(input);
    expect(input).toEqual(snapshot);
  });
});
