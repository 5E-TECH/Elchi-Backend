import { RpcException } from '@nestjs/microservices';
import { normalizeAudienceSegment } from './audience-resolver';

/**
 * ebSV5oyP — segment oraliqlari: buyurtmalar soni "dan–gacha" (TC3) va
 * teskari oraliq — validatsiya xatosi (TC11), jim 0 natija emas.
 */
const statusOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof RpcException)
      return (error.getError() as { statusCode: number }).statusCode;
    throw error;
  }
  return null;
};

describe('ebSV5oyP — normalizeAudienceSegment oraliqlari', () => {
  it('TC3: min_orders + max_orders (3–10) qabul qilinadi', () => {
    expect(
      normalizeAudienceSegment({ min_orders: 3, max_orders: '10' }),
    ).toEqual({ min_orders: 3, max_orders: 10 });
    expect(normalizeAudienceSegment({ max_orders: 1 })).toEqual({
      max_orders: 1,
    });
  });

  it('TC11: teskari oraliq — 400 (min > max; from > to)', () => {
    expect(
      statusOf(() =>
        normalizeAudienceSegment({ min_orders: 10, max_orders: 3 }),
      ),
    ).toBe(400);
    expect(
      statusOf(() =>
        normalizeAudienceSegment({
          last_order_from: '2026-10-10',
          last_order_to: '2026-10-01',
        }),
      ),
    ).toBe(400);
    expect(
      statusOf(() =>
        normalizeAudienceSegment({
          last_order_from: '2026-10-01',
          last_order_to: '2026-10-10',
        }),
      ),
    ).toBeNull();
  });

  it('max_orders musbat butun son bo‘lishi shart', () => {
    for (const value of [0, -1, 2.5, 'abc']) {
      expect(
        statusOf(() => normalizeAudienceSegment({ max_orders: value })),
      ).toBe(400);
    }
  });
});
