import type { RawOrderExtraction } from '@app/common';
import { mergeExtractedOrders } from './merge-orders';

/** WHMAIqyo #4 — bo'laklab ekstraksiya natijalarini birlashtirish. */
function o(over: Partial<RawOrderExtraction> = {}): RawOrderExtraction {
  return {
    customer_name: 'Ali',
    phone_number: '+998900001234',
    extra_number: null,
    region_name: 'Andijon',
    district_name: 'Asaka',
    address: null,
    full_address: null,
    items: [{ name: 'atir', quantity: 2 }],
    total_price: 300000,
    comment: null,
    where_deliver: null,
    is_replacement: false,
    operator: null,
    warnings: [],
    ...over,
  };
}

describe('mergeExtractedOrders', () => {
  it('bir xil telefon + bir xil mahsulot (format farqi bilan) → bitta buyurtma', () => {
    const out = mergeExtractedOrders([
      [o()],
      [
        o({
          phone_number: '90 000 12 34',
          items: [{ name: 'Atir', quantity: 2 }],
        }),
      ],
    ]);
    expect(out).toHaveLength(1);
  });

  it('bo‘linib qolgan buyurtma: bir tomonda mahsulot yo‘q → null maydonlar to‘ldiriladi', () => {
    const out = mergeExtractedOrders([
      [o({ items: [], total_price: null, address: 'Navoiy 5-uy' })],
      [o({ comment: 'kechqurun' })],
    ]);
    expect(out).toEqual([o({ address: 'Navoiy 5-uy', comment: 'kechqurun' })]);
  });

  it('bir telefon, lekin narx/tuman to‘qnashuvi → IKKI alohida buyurtma', () => {
    expect(
      mergeExtractedOrders([[o()], [o({ total_price: 450000 })]]),
    ).toHaveLength(2);
    expect(
      mergeExtractedOrders([[o()], [o({ district_name: "Xo'jaobod" })]]),
    ).toHaveLength(2);
  });

  it('bir telefon, har xil mahsulot (ikkalasida ham bor) → ikki buyurtma', () => {
    expect(
      mergeExtractedOrders([
        [o()],
        [o({ items: [{ name: 'krem', quantity: 1 }] })],
      ]),
    ).toHaveLength(2);
  });

  it('telefonsiz buyurtma faqat AYNAN bir xil bo‘lsa olib tashlanadi', () => {
    const noPhone = o({ phone_number: null });
    expect(mergeExtractedOrders([[noPhone], [{ ...noPhone }]])).toHaveLength(1);
    expect(
      mergeExtractedOrders([
        [noPhone],
        [{ ...noPhone, customer_name: 'Vali' }],
      ]),
    ).toHaveLength(2);
  });

  it('ogohlantirishlar birlashadi (har maydonga bitta), is_replacement OR', () => {
    const [m] = mergeExtractedOrders([
      [o({ warnings: [{ field: 'total_price', reason: 'ambiguous' }] })],
      [
        o({
          is_replacement: true,
          warnings: [
            { field: 'customer_name', reason: 'unclear' },
            { field: 'total_price', reason: 'conflict' },
          ],
        }),
      ],
    ]);
    expect(m.is_replacement).toBe(true);
    expect(m.warnings).toEqual([
      { field: 'customer_name', reason: 'unclear' },
      { field: 'total_price', reason: 'ambiguous' },
    ]);
  });

  it('kirishni o‘zgartirmaydi, tartib saqlanadi', () => {
    const a = o({ items: [], total_price: null });
    const snapshot = JSON.stringify(a);
    const out = mergeExtractedOrders([
      [a, o({ phone_number: '+998910001111', customer_name: 'B' })],
      [o()],
    ]);
    expect(JSON.stringify(a)).toBe(snapshot);
    expect(out.map((x) => x.customer_name)).toEqual(['Ali', 'B']);
  });
});
