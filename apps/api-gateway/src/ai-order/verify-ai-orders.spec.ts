import {
  AI_VERIFY_REASON_TEXT,
  type AiVerifyOrderInput,
  verifyAiOrders,
} from './verify-ai-orders';

/**
 * ai-confirm server tomondagi qayta tekshiruv (wgqxS0Cp #6-8, 32fNx0Ci #9-11).
 * Mijoz yuborgan region_id / tuman / mahsulotga ishonilmaydi.
 */
describe('verifyAiOrders', () => {
  const MARKET = '12';

  const districts = [
    // region_id — DB'dagi haqiqiy qiymat (bigint → satr).
    { id: '101', name: 'Chilonzor', region_id: '1', isDeleted: false },
    { id: '102', name: 'Yunusobod', region_id: '1', isDeleted: false },
    { id: '201', name: 'Chirchiq', region_id: '2', isDeleted: false },
    // O'chirilgan tuman (camelCase va snake_case bayroqlari).
    { id: '301', name: 'Eski', region_id: '3', isDeleted: true },
    { id: '302', name: 'Eski2', region_id: '3', is_deleted: true },
    // region_id ustuni yo'q, lekin relation bor.
    { id: '401', name: 'Relation', region: { id: 4 } },
    // Viloyatsiz buzuq qator.
    { id: '501', name: 'Buzuq' },
  ];

  const products = [
    { id: '7', name: 'Atir', user_id: '12', isDeleted: false },
    { id: '8', name: 'Krem', user_id: 12, isDeleted: false },
    { id: '9', name: 'Begona', user_id: '99', isDeleted: false },
    { id: '10', name: "O'chgan", user_id: '12', isDeleted: true },
  ];

  const order = (
    over: Partial<AiVerifyOrderInput> & {
      customerDistrict?: unknown;
    } = {},
  ): AiVerifyOrderInput => {
    const { customerDistrict, ...rest } = over;
    const districtId = rest.district_id ?? '101';
    return {
      district_id: districtId,
      customer: {
        district_id:
          customerDistrict === undefined ? districtId : customerDistrict,
      },
      items: [{ product_id: '7' }],
      ...rest,
    };
  };

  const verifyOne = (input: AiVerifyOrderInput, marketId = MARKET) =>
    verifyAiOrders([input], { marketId, districts, products })[0];

  it.each([
    ['tuman DB’da yo‘q', order({ district_id: '999' }), 'district_not_found'],
    [
      'tuman o‘chirilgan (isDeleted)',
      order({ district_id: '301' }),
      'district_not_found',
    ],
    [
      'tuman o‘chirilgan (is_deleted)',
      order({ district_id: '302' }),
      'district_not_found',
    ],
    ['district_id bo‘sh', order({ district_id: '' }), 'district_not_found'],
    [
      'viloyatsiz buzuq tuman qatori',
      order({ district_id: '501' }),
      'district_not_found',
    ],
    [
      'customer.district_id ≠ district_id',
      order({ district_id: '101', customerDistrict: '102' }),
      'district_mismatch',
    ],
    [
      'customer.district_id yo‘q',
      order({ district_id: '101', customerDistrict: null }),
      'district_mismatch',
    ],
    [
      'mahsulot katalogda yo‘q',
      order({ items: [{ product_id: '7' }, { product_id: '555' }] }),
      'product_not_found',
    ],
    [
      'mahsulot o‘chirilgan',
      order({ items: [{ product_id: '10' }] }),
      'product_not_found',
    ],
    [
      'boshqa marketning mahsuloti',
      order({ items: [{ product_id: '9' }] }),
      'product_foreign',
    ],
  ])('%s → %s', (_title, input, code) => {
    const result = verifyOne(input);
    expect(result).toEqual({
      ok: false,
      code,
      reason: expect.any(String) as unknown,
    });
    if (!result.ok) {
      // Odam o'qiydigan o'zbekcha matn; xom payload yo'q.
      expect(result.reason.length).toBeGreaterThan(10);
      expect(result.reason).not.toContain('{');
    }
  });

  it('tuman va moslik xatosida reason — AI_VERIFY_REASON_TEXT dagi matn', () => {
    expect(verifyOne(order({ district_id: '999' }))).toEqual({
      ok: false,
      code: 'district_not_found',
      reason: AI_VERIFY_REASON_TEXT.district_not_found,
    });
    expect(
      verifyOne(order({ district_id: '101', customerDistrict: '102' })),
    ).toEqual({
      ok: false,
      code: 'district_mismatch',
      reason: AI_VERIFY_REASON_TEXT.district_mismatch,
    });
  });

  it('mahsulot xatosida qaysi mahsulot ekani ko‘rsatiladi', () => {
    const result = verifyOne(order({ items: [{ product_id: '9' }] }));
    expect(!result.ok && result.reason).toContain('#9');
  });

  it('32fNx0Ci #9: region_id HAR DOIM DB’dagi tumandan — mijoz yuborgan qiymat e’tiborsiz', () => {
    const input = {
      ...order({ district_id: '201' }),
      // DTO region_id ni qabul qiladi, lekin u HECH QACHON o'qilmaydi.
      region_id: '999',
    } as AiVerifyOrderInput;

    expect(verifyOne(input)).toEqual({
      ok: true,
      district_id: '201',
      region_id: '2',
    });
  });

  it('region_id ustuni bo‘lmasa region relation’idan olinadi', () => {
    expect(verifyOne(order({ district_id: '401' }))).toEqual({
      ok: true,
      district_id: '401',
      region_id: '4',
    });
  });

  it('ID’lar satr sifatida solishtiriladi (raqam user_id / bo‘shliqli id)', () => {
    expect(
      verifyOne(
        order({
          district_id: ' 101 ',
          customerDistrict: '101',
          items: [{ product_id: '8' }],
        }),
      ),
    ).toEqual({ ok: true, district_id: '101', region_id: '1' });
    expect(
      verifyAiOrders([order({ district_id: 102 as unknown as string })], {
        marketId: MARKET,
        districts: [{ id: 102, region_id: 1 }],
        products,
      })[0],
    ).toEqual({ ok: true, district_id: '102', region_id: '1' });
  });

  it('product_id siz (erkin matn) qator katalogda tekshirilmaydi', () => {
    expect(
      verifyOne(
        order({ items: [{ product_id: undefined }, { product_id: '7' }] }),
      ),
    ).toEqual({ ok: true, district_id: '101', region_id: '1' });
  });

  it('natijalar kirish tartibida, har buyurtmaga bittadan (2 tasi o‘tadi, 1 tasi yo‘q)', () => {
    const results = verifyAiOrders(
      [order(), order({ district_id: '999' }), order({ district_id: '201' })],
      { marketId: MARKET, districts, products },
    );

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]).toMatchObject({ code: 'district_not_found' });
    expect(results[2]).toEqual({
      ok: true,
      district_id: '201',
      region_id: '2',
    });
  });

  it('boshqa market nomidan tekshirilsa o‘sha mahsulot product_foreign', () => {
    expect(verifyOne(order(), '99')).toMatchObject({
      ok: false,
      code: 'product_foreign',
    });
    expect(verifyOne(order(), '')).toMatchObject({
      ok: false,
      code: 'product_foreign',
    });
  });

  it('bo‘sh / buzuq kirishda yiqilmaydi', () => {
    expect(
      verifyAiOrders([], { marketId: MARKET, districts, products }),
    ).toEqual([]);
    expect(
      verifyAiOrders([{} as AiVerifyOrderInput], {
        marketId: MARKET,
        districts: [],
        products: [],
      }),
    ).toEqual([
      expect.objectContaining({ ok: false, code: 'district_not_found' }),
    ]);
  });
});
