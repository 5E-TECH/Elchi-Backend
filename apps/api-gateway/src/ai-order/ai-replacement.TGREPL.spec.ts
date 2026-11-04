import { aiOrderSignature } from './ai-order.helpers';
import {
  AI_REPLACEMENT_MAX_CANDIDATES,
  aiReplacementCustomerIds,
  aiReplacementPhone9,
  applyAiReplacement,
  isAiReplacementPreview,
  pickAiReplacementRows,
  toAiReplacementCandidates,
} from './ai-replacement';

/**
 * TGREPL — AI almashtirish yordamchilari (BeePost `resolveReplacement`):
 * telefonning oxirgi 9 raqami (aniq moslik), shu market nomzodlari (yangisi
 * birinchi, ≤10), avto-tanlov, qidiruv holati (`replacement_lookup`) va narx
 * kamchiliklari; dublikat imzosida `replaced_order_id`.
 */

const row = (
  id: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  status: 'sold',
  market_id: '77',
  customer_id: '120',
  total_price: 150000,
  createdAt,
  items: [{ product_id: '15', product_name: 'Atir 50 ml', quantity: 2 }],
  ...extra,
});

describe('TGREPL — aiReplacementPhone9', () => {
  it('oxirgi 9 raqam (ajratuvchilar tashlanadi)', () => {
    expect(aiReplacementPhone9('+998 (90) 123-45-67')).toBe('901234567');
    expect(aiReplacementPhone9('998901234567')).toBe('901234567');
    expect(aiReplacementPhone9('901234567')).toBe('901234567');
  });

  it('9 raqamdan kam yoki telefon emas → null (qidiruv yo‘q)', () => {
    expect(aiReplacementPhone9('12345678')).toBeNull();
    expect(aiReplacementPhone9('')).toBeNull();
    expect(aiReplacementPhone9(null)).toBeNull();
    expect(aiReplacementPhone9({ phone: '901234567' })).toBeNull();
  });
});

describe('TGREPL — aiReplacementCustomerIds', () => {
  it('⭐ faqat telefonining OXIRGI 9 raqami teng mijozlar (qidiruv matn ichidan izlaydi)', () => {
    const ids = aiReplacementCustomerIds(
      [
        // A: +998 98 901 23 45 — izlangan raqam.
        { id: '11', phone_number: '+998989012345' },
        // B: +998 90 123 45 67 — raqamlari ichida 989012345 bor (begona).
        { id: '12', phone_number: '+998901234567' },
        // Ism bo'yicha topilgan / telefonsiz — tushmaydi.
        { id: '13', name: '989012345', phone_number: null },
        { id: '14', phone_number: '998989012345' },
        { id: '11', phone_number: '989012345' },
        { id: 'x', phone_number: '+998989012345' },
        null,
      ],
      '989012345',
    );
    expect(ids).toEqual(['11', '14']);
  });
});

describe('TGREPL — isAiReplacementPreview', () => {
  it('faqat is_replacement === true', () => {
    expect(isAiReplacementPreview({ is_replacement: true })).toBe(true);
    expect(isAiReplacementPreview({ is_replacement: 'true' })).toBe(false);
    expect(isAiReplacementPreview({ is_replacement: false })).toBe(false);
    expect(isAiReplacementPreview(null)).toBe(false);
    expect(isAiReplacementPreview([{ is_replacement: true }])).toBe(false);
  });
});

describe('TGREPL — toAiReplacementCandidates', () => {
  it('yangisi birinchi (yaratilgan vaqt), faqat SHU market, kichik shakl', () => {
    const list = toAiReplacementCandidates(
      [
        row('300', '2026-10-01T10:00:00.000Z'),
        row('310', '2026-10-20T10:00:00.000Z', {
          items: [
            { product_id: '15', product_name: 'Atir 50 ml', quantity: 2 },
            { product_id: null, product_name: null, quantity: 1 },
          ],
        }),
        // Boshqa market — order-service filtriga qo'shimcha himoya.
        row('320', '2026-10-25T10:00:00.000Z', { market_id: '88' }),
      ],
      '77',
    );
    expect(list.map((c) => c.id)).toEqual(['310', '300']);
    expect(list[0]).toEqual({
      id: '310',
      order_number: 'EL-100310',
      created_at: '2026-10-20T10:00:00.000Z',
      items: 'Atir 50 ml ×2, mahsulot ×1',
      total_price: 150000,
    });
    // PII (mijoz) nomzodga tushmaydi.
    expect(Object.keys(list[0]).sort()).toEqual(
      ['created_at', 'id', 'items', 'order_number', 'total_price'].sort(),
    );
  });

  it('vaqt teng/noma’lum — katta id oldin; ≤10 ta; buzuq qator tashlanadi', () => {
    const rows = Array.from({ length: 14 }, (_, i) =>
      row(String(100 + i), '2026-10-01T10:00:00.000Z'),
    );
    rows.push(row('9', 'not-a-date'), { id: 'abc', market_id: '77' });
    const list = toAiReplacementCandidates(rows, '77');
    expect(list).toHaveLength(AI_REPLACEMENT_MAX_CANDIDATES);
    expect(list[0].id).toBe('113');
    expect(list.map((c) => c.id)).not.toContain('abc');
  });

  it('Date obyekti va epoch ms ham o‘qiladi; uzun mahsulot matni qisqartiriladi', () => {
    const list = toAiReplacementCandidates(
      [
        row('1', '', {
          createdAt: new Date('2026-10-02T00:00:00.000Z'),
          items: [{ product_name: 'x'.repeat(300), quantity: 1 }],
        }),
        row('2', '', { createdAt: Date.parse('2026-10-03T00:00:00.000Z') }),
      ],
      '77',
    );
    expect(list.map((c) => c.id)).toEqual(['2', '1']);
    expect(list[1].created_at).toBe('2026-10-02T00:00:00.000Z');
    expect(list[1].items.length).toBeLessThanOrEqual(120);
  });
});

describe('TGREPL — pickAiReplacementRows', () => {
  it('⭐ sold_at tartibidagi keng sahifadan yaratilgan vaqt bo‘yicha eng yangi 10 tasi', () => {
    // order-service tartibi: sold_at DESC — eng yangi yaratilgan (500) oxirida.
    const rows = [
      ...Array.from({ length: 12 }, (_, i) =>
        row(String(400 + i), `2026-10-${String(10 + i)}T10:00:00.000Z`),
      ),
      row('500', '2026-11-03T10:00:00.000Z'),
    ];
    const picked = pickAiReplacementRows(rows, '77');
    expect(picked).toHaveLength(AI_REPLACEMENT_MAX_CANDIDATES);
    expect(picked[0].id).toBe('500');
    expect(picked.map((r) => r.id)).not.toContain('400');
  });
});

describe('TGREPL — applyAiReplacement', () => {
  const candidates = toAiReplacementCandidates(
    [
      row('310', '2026-10-20T10:00:00.000Z'),
      row('300', '2026-10-01T10:00:00.000Z'),
    ],
    '77',
  );
  const found = { candidates, total: 2 };
  const replacementPreview = (
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    is_replacement: true,
    total_price: null,
    ready: false,
    issues: ['price_missing'],
    ...extra,
  });

  it('bog‘landi: eng yangisi avto-tanlanadi, narx kamchiliklari olib tashlanadi, ready qayta hisoblanadi', () => {
    const preview = replacementPreview();
    applyAiReplacement(preview, found);
    expect(preview.replacement_lookup).toBe('found');
    expect(preview.replaced_order_id).toBe('310');
    expect(preview.replacement_candidates).toHaveLength(2);
    expect(preview.replacement_candidates_total).toBe(2);
    expect(preview.issues).toEqual([]);
    expect(preview.ready).toBe(true);
    // Narx preview'da o'zgarmaydi (0 — ai-confirm'da).
    expect(preview.total_price).toBeNull();

    const small = replacementPreview({
      total_price: 3000,
      issues: ['price_confirm', 'item_unresolved'],
    });
    applyAiReplacement(small, found);
    expect(small.issues).toEqual(['item_unresolved']);
    expect(small.ready).toBe(false);
  });

  it('total — order-service umumiy soni (10 talik ro‘yxatdan katta bo‘lishi mumkin)', () => {
    const preview = replacementPreview();
    applyAiReplacement(preview, { candidates, total: 25 });
    expect(preview.replacement_candidates_total).toBe(25);
    // Buzuq total — kamida ro'yxat uzunligi.
    applyAiReplacement(preview, { candidates, total: Number.NaN });
    expect(preview.replacement_candidates_total).toBe(2);
  });

  it('topilmadi: not_found, null + bo‘sh ro‘yxat, kamchiliklar o‘zgarmaydi (oddiy buyurtma)', () => {
    const preview = replacementPreview();
    applyAiReplacement(preview, { candidates: [], total: 0 });
    expect(preview.replacement_lookup).toBe('not_found');
    expect(preview.replaced_order_id).toBeNull();
    expect(preview.replacement_candidates).toEqual([]);
    expect(preview.replacement_candidates_total).toBe(0);
    expect(preview.issues).toEqual(['price_missing']);
    expect(preview.ready).toBe(false);
  });

  it('⭐ qidiruv bo‘lmadi/yiqildi (null): unavailable — "topilmadi" EMAS', () => {
    const preview = replacementPreview({ total_price: 150000, issues: [] });
    applyAiReplacement(preview, null);
    expect(preview.replacement_lookup).toBe('unavailable');
    expect(preview.replaced_order_id).toBeNull();
    expect(preview.replacement_candidates).toEqual([]);
    expect(preview.issues).toEqual([]);
  });

  it('⭐ bitta eski buyurtma ikki preview’ga bog‘lanmaydi: keyingisi navbatdagi nomzod, qolmasa taken', () => {
    const used = new Set<string>();
    const first = replacementPreview();
    const second = replacementPreview();
    const third = replacementPreview();
    applyAiReplacement(first, found, used);
    applyAiReplacement(second, found, used);
    applyAiReplacement(third, found, used);
    expect(first.replaced_order_id).toBe('310');
    expect(second.replaced_order_id).toBe('300');
    expect(second.replacement_lookup).toBe('found');
    expect(third.replacement_lookup).toBe('taken');
    expect(third.replaced_order_id).toBeNull();
    // Ro'yxat to'liq qaytadi, narx kamchiligi qoladi.
    expect(third.replacement_candidates).toHaveLength(2);
    expect(third.issues).toEqual(['price_missing']);
  });
});

describe('TGREPL — aiOrderSignature: replaced_order_id', () => {
  const base = {
    customer: { phone_number: '+998901234567' },
    district_id: '12',
    total_price: 0,
    where_deliver: 'center',
    items: [{ product_id: '15', quantity: 1 }],
  };

  it('faqat replaced_order_id bilan farqlanadigan ikki almashtirish — TURLI imzo', () => {
    expect(
      aiOrderSignature('77', { ...base, replaced_order_id: '555' }),
    ).not.toBe(aiOrderSignature('77', { ...base, replaced_order_id: '556' }));
    expect(
      aiOrderSignature('77', { ...base, replaced_order_id: '555' }),
    ).not.toBe(aiOrderSignature('77', base));
  });

  it('oddiy buyurtma imzosi o‘zgarmaydi (yo‘q / bo‘sh replaced_order_id)', () => {
    const plain = aiOrderSignature('77', base);
    expect(
      aiOrderSignature('77', { ...base, replaced_order_id: undefined }),
    ).toBe(plain);
    expect(aiOrderSignature('77', { ...base, replaced_order_id: null })).toBe(
      plain,
    );
    expect(aiOrderSignature('77', { ...base, replaced_order_id: '' })).toBe(
      plain,
    );
  });
});
