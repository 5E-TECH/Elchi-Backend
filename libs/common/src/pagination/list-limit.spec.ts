import { clampListLimit, LOOKUP_LIST_MAX_LIMIT } from './list-limit';

describe('clampListLimit — tanlash ro‘yxatlari limiti', () => {
  it('berilmagan / noto‘g‘ri qiymat — sukut', () => {
    for (const raw of [undefined, null, '', 'abc', 0, '0', -5, NaN, Infinity]) {
      expect(clampListLimit(raw, 10)).toBe(10);
    }
  });

  it('100 dan katta qiymat endi kesilmaydi (ilgari 100 edi)', () => {
    expect(clampListLimit('500', 10)).toBe(500);
    expect(clampListLimit(1000, 10)).toBe(1000);
    expect(clampListLimit('10000', 10)).toBe(LOOKUP_LIST_MAX_LIMIT);
  });

  it('yuqori chegara — LOOKUP_LIST_MAX_LIMIT (yoki berilgan max); kasr — butun qismi', () => {
    expect(LOOKUP_LIST_MAX_LIMIT).toBe(10_000);
    expect(clampListLimit('20000', 10)).toBe(10_000);
    expect(clampListLimit(250, 20, 200)).toBe(200);
    expect(clampListLimit('12.7', 10)).toBe(12);
  });
});
