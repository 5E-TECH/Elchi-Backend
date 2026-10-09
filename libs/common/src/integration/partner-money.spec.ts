import { Order_status } from '../../enums';
import {
  resolvePartnerCollectedFromCustomer,
  resolvePartnerMoneyFields,
} from './partner-money';

/**
 * Lx5oONlP — hamkor pul maydonlarining YAGONA manbasi. GET
 * (integration-service) va webhook (order-service) shu funksiyani
 * ishlatadi; servis darajasidagi tenglik testi:
 * `apps/integration-service/src/integration-service.partner-collected-fallback.spec.ts`.
 */
const sold = (over: Record<string, unknown> = {}) => ({
  status: Order_status.SOLD,
  sold_at: '1726000000000',
  sale_collectible_amount: null,
  total_price: 500000,
  paid_online_amount: 0,
  market_tariff: 15000,
  ...over,
});

describe('resolvePartnerCollectedFromCustomer (Lx5oONlP)', () => {
  it('snapshot ustun — 0 ham haqiqiy qiymat', () => {
    expect(
      resolvePartnerCollectedFromCustomer(sold({ sale_collectible_amount: 0 })),
    ).toBe(0);
    expect(
      resolvePartnerCollectedFromCustomer(
        sold({ sale_collectible_amount: '275000.50' }),
      ),
    ).toBe(275000.5);
  });

  it('⭐ snapshotsiz sotuv -> max(total − online, 0)', () => {
    expect(resolvePartnerCollectedFromCustomer(sold())).toBe(500000);
    expect(
      resolvePartnerCollectedFromCustomer(
        sold({ total_price: '300000.00', paid_online_amount: '200000.00' }),
      ),
    ).toBe(100000);
    expect(
      resolvePartnerCollectedFromCustomer(
        sold({ total_price: 100000, paid_online_amount: 150000 }),
      ),
    ).toBe(0);
  });

  it('tiyin aniqligi saqlanadi (float qoldig`i yo`q)', () => {
    expect(
      resolvePartnerCollectedFromCustomer(
        sold({ total_price: 100000.3, paid_online_amount: 0.1 }),
      ),
    ).toBe(100000.2);
  });

  it('`sold_at` raqam ko`rinishida ham qabul qilinadi', () => {
    expect(
      resolvePartnerCollectedFromCustomer(sold({ sold_at: 1726000000000 })),
    ).toBe(500000);
  });

  it.each([
    ['sotilmagan', { status: Order_status.WAITING, sold_at: null }],
    ['CLOSED', { status: Order_status.CLOSED }],
    ['CANCELLED', { status: Order_status.CANCELLED }],
    ['sold_at yo`q', { sold_at: null }],
    ['sold_at bo`sh', { sold_at: '' }],
    ['total_price yo`q', { total_price: null }],
    ['total_price son emas', { total_price: 'abc' }],
  ])('%s -> null', (_label, over) => {
    expect(resolvePartnerCollectedFromCustomer(sold(over))).toBeNull();
  });

  it('buyurtma yo`q -> null', () => {
    expect(resolvePartnerCollectedFromCustomer(null)).toBeNull();
    expect(resolvePartnerCollectedFromCustomer(undefined)).toBeNull();
  });
});

describe('resolvePartnerMoneyFields (Lx5oONlP)', () => {
  it('market_amount = yig`ilgan − tarif', () => {
    expect(resolvePartnerMoneyFields(sold())).toEqual({
      collected_from_customer: 500000,
      elchi_fee: 15000,
      market_amount: 485000,
    });
  });

  it('tarif yo`q -> market_amount null, collected baribir son', () => {
    expect(resolvePartnerMoneyFields(sold({ market_tariff: null }))).toEqual({
      collected_from_customer: 500000,
      elchi_fee: null,
      market_amount: null,
    });
  });

  it('sotilmagan -> uchalasi ham tarifga qarab (collected null)', () => {
    expect(
      resolvePartnerMoneyFields({
        status: Order_status.ON_THE_ROAD,
        total_price: 65000,
        market_tariff: null,
      }),
    ).toEqual({
      collected_from_customer: null,
      elchi_fee: null,
      market_amount: null,
    });
  });
});
