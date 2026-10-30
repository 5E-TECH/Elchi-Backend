import { formatOrderNumber, ORDER_NUMBER_OFFSET } from './order-number';

/** T9 (HJ5sLHiz) — yagona «EL-…» buyurtma raqami. */
describe('formatOrderNumber', () => {
  it('id=81 → "EL-100081" (satr va son)', () => {
    expect(ORDER_NUMBER_OFFSET).toBe(100000);
    expect(formatOrderNumber('81')).toBe('EL-100081');
    expect(formatOrderNumber(81)).toBe('EL-100081');
  });

  it('noto`g`ri id → null', () => {
    for (const id of [null, undefined, '', '0', '-3', 'abc', '1.5', {}, 0]) {
      expect(formatOrderNumber(id)).toBeNull();
    }
  });
});
