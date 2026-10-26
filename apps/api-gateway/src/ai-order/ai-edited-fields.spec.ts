import {
  aiPhoneDigest,
  aiStableRequestId,
  buildPreviewSnapshots,
  computeEditedFields,
  computeFieldCorrections,
  type AiConfirmedForAudit,
} from './ai-edited-fields';

/** vncdmXOy #2 (edited_fields server tomonda) va Cp2v3ZJ7 #1 (barqaror kalit). */
const PREVIEW = {
  index: 2,
  ready: true,
  issues: [],
  customer_name: 'Dilnoza',
  phone_number: '+998901234567',
  extra_number: null,
  region_id: '2',
  region_name: 'Andijon',
  district_id: '15',
  district_candidates: [],
  address: 'temiryol 12',
  items: [
    { name: 'atir', quantity: 3, product_id: '9', candidates: [] },
    { name: 'krem', quantity: 1, product_id: null, candidates: [] },
  ],
  total_price: 750000,
  where_deliver: 'address',
  comment: null,
  is_replacement: false,
  operator: 'sevinch',
};

const confirmedFrom = (
  over: Partial<AiConfirmedForAudit> = {},
): AiConfirmedForAudit => ({
  customer: { name: 'Dilnoza', phone_number: '90 123 45 67' },
  district_id: '15',
  region_id: '2',
  address: 'temiryol 12',
  total_price: 750000,
  where_deliver: 'ADDRESS',
  comment: '',
  operator: 'sevinch',
  items: [
    { product_name: 'Krem', quantity: 1 },
    { product_id: '9', quantity: 3 },
  ],
  ...over,
});

describe('buildPreviewSnapshots', () => {
  it('to‘liq telefon YO‘Q — maskalangan + sha256; begona kalitlar tushmaydi', () => {
    const [s] = buildPreviewSnapshots([PREVIEW, null, 'x']);
    expect(s.index).toBe(2);
    expect(s.phone_masked).toBe('+99890*****67');
    expect(s.phone_sha256).toBe(aiPhoneDigest('+998901234567'));
    expect(JSON.stringify(s)).not.toContain('998901234567');
    expect(s).not.toHaveProperty('ready');
    expect(s).not.toHaveProperty('district_candidates');
  });
});

describe('computeEditedFields', () => {
  const [snap] = buildPreviewSnapshots([PREVIEW]);

  it('TC5: hech narsa o‘zgarmasa [] (format farqi: telefon ko‘rinishi, harf, tartib, ""/null)', () => {
    expect(computeEditedFields(snap, confirmedFrom())).toEqual([]);
  });

  it('TC4: tuman o‘zgarsa district_id (va viloyat o‘zgarsa region_id)', () => {
    expect(
      computeEditedFields(snap, confirmedFrom({ district_id: '16' })),
    ).toEqual(['district_id']);
    expect(
      computeEditedFields(
        snap,
        confirmedFrom({ district_id: '40', region_id: '7' }),
      ),
    ).toEqual(['region_id', 'district_id']);
  });

  it('har maydon alohida aniqlanadi, tartib AI_AUDITED_FIELDS bo‘yicha', () => {
    expect(
      computeEditedFields(
        snap,
        confirmedFrom({
          customer: {
            name: 'Dilnoza opa',
            phone_number: '+998911111111',
            extra_number: '+998935555555',
          },
          total_price: 700000,
          where_deliver: 'center',
          comment: 'kechqurun',
          operator: null,
          items: [{ product_id: '9', quantity: 2 }],
          address: 'boshqa',
        }),
      ),
    ).toEqual([
      'customer_name',
      'phone_number',
      'extra_number',
      'address',
      'total_price',
      'where_deliver',
      'comment',
      'operator',
      'items',
    ]);
  });

  it('AI tumanni topolmagan (null), operator tanlagan → district_id o‘zgargan', () => {
    const [noDistrict] = buildPreviewSnapshots([
      { ...PREVIEW, district_id: null },
    ]);
    expect(computeEditedFields(noDistrict, confirmedFrom())).toEqual([
      'district_id',
    ]);
  });

  it('narx null (AI aytmagan) → operator kiritgan narx total_price o‘zgarishi', () => {
    const [noPrice] = buildPreviewSnapshots([
      { ...PREVIEW, total_price: null },
    ]);
    expect(computeEditedFields(noPrice, confirmedFrom())).toEqual([
      'total_price',
    ]);
  });
});

describe('computeFieldCorrections (J3hEDtFN #4)', () => {
  const [snap] = buildPreviewSnapshots([PREVIEW]);

  it('faqat o‘zgargan maydonlar: AI taklifi va operator qiymati, telefon ikkala tomonda maskalangan', () => {
    const confirmed = confirmedFrom({
      customer: { name: 'Dilnoza opa', phone_number: '+998911112233' },
      district_id: '16',
      total_price: 700000,
      items: [{ product_id: '9', product_name: 'Atir', quantity: 2 }],
    });
    const edited = computeEditedFields(snap, confirmed);
    const corrections = computeFieldCorrections(snap, confirmed, edited);
    expect(Object.keys(corrections)).toEqual(edited);
    expect(corrections).toEqual({
      customer_name: { ai: 'Dilnoza', final: 'Dilnoza opa' },
      phone_number: { ai: '+99890*****67', final: '+99891*****33' },
      district_id: { ai: '15', final: '16' },
      total_price: { ai: 750000, final: 700000 },
      items: {
        ai: [
          { name: 'atir', product_id: '9', quantity: 3 },
          { name: 'krem', product_id: null, quantity: 1 },
        ],
        final: [{ name: 'Atir', product_id: '9', quantity: 2 }],
      },
    });
    // MAXFIYLIK: to'liq telefon raqami YO'Q.
    const json = JSON.stringify(corrections);
    expect(json).not.toContain('998911112233');
    expect(json).not.toContain('998901234567');
  });

  it('hech narsa o‘zgarmasa — bo‘sh obyekt', () => {
    expect(computeFieldCorrections(snap, confirmedFrom(), [])).toEqual({});
  });
});

describe('aiStableRequestId (Cp2v3ZJ7)', () => {
  const draft = 'AAAAAAAA-0000-4000-8000-000000000001';
  it('market + draft + index → ai:<market>:<draft kichik harf>:<idx>', () => {
    expect(aiStableRequestId('77', draft, 0)).toBe(
      'ai:77:aaaaaaaa-0000-4000-8000-000000000001:0',
    );
  });
  it.each([
    ['77', undefined, 0],
    ['77', draft, undefined],
    ['77', draft, null],
    ['77', draft, -1],
    ['77', draft, 1.5],
    ['77', 'not-uuid', 0],
    ['x', draft, 0],
  ])('%s/%s/%s → null (eski ai-dedupe yo‘li)', (m, d, i) => {
    expect(aiStableRequestId(m, d, i)).toBeNull();
  });
});
