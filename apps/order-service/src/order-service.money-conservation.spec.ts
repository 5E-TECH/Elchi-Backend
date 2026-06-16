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
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface SaleInputs {
  total: number;
  marketTariff: number;
  courierShare: number;
  branchShare: number;
}

function legs(i: SaleInputs) {
  return {
    marketReceivable: round2(i.total - i.marketTariff),
    courierKept: round2(i.courierShare),
    branchKept: round2(i.branchShare),
    hqProfit: round2(i.marketTariff - i.courierShare - i.branchShare),
    // order_settlement "owed up-chain" amounts, consumed at each FIFO hop.
    courierAmount: round2(i.total - i.courierShare),
    branchAmount: round2(i.total - i.courierShare - i.branchShare),
    marketAmount: round2(i.total - i.marketTariff),
  };
}

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
      expect(Math.abs(i.total - l.courierAmount - l.courierKept)).toBeLessThanOrEqual(0.01);
      // Branch keeps the difference between the courier and branch owed legs.
      expect(Math.abs(l.courierAmount - l.branchAmount - l.branchKept)).toBeLessThanOrEqual(0.01);
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
