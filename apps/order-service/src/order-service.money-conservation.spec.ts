/**
 * Money-conservation property test (Faza 3).
 *
 * The COD money model must conserve EXACTLY: every som a customer pays on
 * delivery is fully accounted for across the four parties, with no leak and no
 * double-count. This test fuzzes the model and asserts the conservation
 * identity, so any future change to a leg/share formula that breaks the balance
 * fails loudly.
 *
 * Formulas mirror the production code (numeric(14,2) money):
 *   - market receivable  = total − marketTariff
 *       (order_settlement.market_amount; HQ keeps marketTariff)
 *   - courier owes up    = total − courierShare        (courier keeps courierShare)
 *   - branch owes up     = total − courierShare − branchShare (branch keeps branchShare)
 *   - SELL_PROFIT (HQ)   = marketTariff − courierShare − branchShare
 *       (finance-service.service.ts: sellProfit = market_tariff − courierShare − branchShare)
 *
 * Conservation identity (the whole COD splits with no remainder):
 *   marketReceivable + courierKept + branchKept + hqProfit === total
 *
 * Audit P1 fix: the split legs are now computed by the REAL production formula
 * (./domain/order-money) via computeSaleLegs, not a re-implementation, so a
 * regression in the actual money math is caught here instead of passing against
 * a copy of itself.
 */
import {
  computeSaleLegs,
  computeSellProfit,
  resolveCourierShare,
  resolveSaleActorShare,
} from './domain/order-money';
import { CourierCompensationMode } from '@app/common';

const round2 = (n: number): number => Math.round(n * 100) / 100;

type SaleInputs = Parameters<typeof computeSaleLegs>[0];

// Now backed by the production formula (was a local re-implementation).
const legs = (i: SaleInputs) => computeSaleLegs(i);

describe('COD money conservation (Faza 3)', () => {
  // Deterministic pseudo-random inputs (no Math.random — reproducible).
  function* cases(): Generator<SaleInputs> {
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let k = 0; k < 500; k++) {
      const total = round2(next() * 1_000_000); // up to 1,000,000 som
      const marketTariff = round2(next() * total); // 0..total
      // courierShare + branchShare drawn from within marketTariff so HQ profit
      // stays ≥ 0 (the normal owned/per-order config space).
      const courierShare = round2(next() * marketTariff);
      const branchShare = round2(next() * (marketTariff - courierShare));
      yield { total, marketTariff, courierShare, branchShare };
    }
  }

  it('splits the whole COD with no leak: market + courier + branch + HQ === total', () => {
    for (const i of cases()) {
      const l = legs(i);
      const sum = round2(
        l.marketReceivable + l.courierKept + l.branchKept + l.hqProfit,
      );
      // Allow ≤1 tiyin rounding noise from the four independent round2() calls.
      expect(Math.abs(sum - i.total)).toBeLessThanOrEqual(0.01);
    }
  });

  it('settlement leg amounts are internally consistent with the shares', () => {
    for (const i of cases()) {
      const l = legs(i);
      // What the courier keeps = total − what they owe up the chain.
      expect(
        Math.abs(i.total - l.courierAmount - l.courierKept),
      ).toBeLessThanOrEqual(0.01);
      // Branch keeps the difference between the courier and branch owed legs.
      expect(
        Math.abs(l.courierAmount - l.branchAmount - l.branchKept),
      ).toBeLessThanOrEqual(0.01);
    }
  });

  it('SELL_PROFIT equals marketTariff minus the courier and branch shares', () => {
    for (const i of cases()) {
      const l = legs(i);
      expect(l.hqProfit).toBe(
        round2(i.marketTariff - i.courierShare - i.branchShare),
      );
      // With shares drawn from within the tariff, HQ never goes negative here.
      expect(l.hqProfit).toBeGreaterThanOrEqual(-0.01);
    }
  });
});

describe('order-money share/profit primitives', () => {
  it('computeSellProfit = marketTariff − courierShare − branchShare', () => {
    expect(computeSellProfit(1000, 300, 100)).toBe(600);
    expect(computeSellProfit(500, 500, 0)).toBe(0);
    // Not rounded — matches the finance ledger write byte-for-byte.
    expect(computeSellProfit(100.05, 0, 0)).toBe(100.05);
  });

  it('resolveCourierShare: SALARY_ONLY keeps nothing, others keep the tariff', () => {
    expect(
      resolveCourierShare(
        { compensation_mode: CourierCompensationMode.SALARY_ONLY },
        5000,
      ),
    ).toBe(0);
    expect(
      resolveCourierShare(
        { compensation_mode: CourierCompensationMode.PER_ORDER },
        5000,
      ),
    ).toBe(5000);
    // Unknown / legacy courier defaults to keeping the tariff.
    expect(resolveCourierShare(null, 5000)).toBe(5000);
    expect(resolveCourierShare({}, 5000)).toBe(5000);
  });

  it('resolveSaleActorShare: a manager sale keeps the full tariff', () => {
    expect(
      resolveSaleActorShare(
        true,
        { compensation_mode: CourierCompensationMode.SALARY_ONLY },
        5000,
      ),
    ).toBe(5000);
    // A courier sale falls back to their compensation-mode share.
    expect(
      resolveSaleActorShare(
        false,
        { compensation_mode: CourierCompensationMode.SALARY_ONLY },
        5000,
      ),
    ).toBe(0);
  });
});
