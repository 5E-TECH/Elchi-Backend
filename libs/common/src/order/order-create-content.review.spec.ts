import { orderCreateItemsProblem } from './order-create-content';

describe('IR2OHIiN (review 2026-10-25) — mahsulot qatori mahsulotga ishora qilishi shart', () => {
  it.each([
    ['bo`sh obyekt', [{}]],
    ['faqat miqdor', [{ quantity: 2 }]],
    ['bo`sh nom va id', [{ product_id: '', product_name: '   ', quantity: 1 }]],
  ])('%s → rad', (_name, items) => {
    expect(orderCreateItemsProblem(items)).not.toBeNull();
  });

  it.each([
    ['product_id', [{ product_id: '12', quantity: 1 }]],
    ['raqamli product_id', [{ product_id: 12, quantity: 1 }]],
    ['product_name', [{ product_name: 'Ko`ylak', quantity: 2 }]],
  ])('%s → o`tadi', (_name, items) => {
    expect(orderCreateItemsProblem(items)).toBeNull();
  });
});
