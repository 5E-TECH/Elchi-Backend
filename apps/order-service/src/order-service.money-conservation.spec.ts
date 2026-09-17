/**
 * Money-conservation property test (Faza 3).
 *
 * The COD money model must conserve EXACTLY: every som the courier COLLECTS on
 * delivery is fully accounted for across the four parties, with no leak and no
 * double-count.
 *
 * ⚠️ `total` = YIG'ILGAN NAQD, buyurtma narxi EMAS. Ular odatda teng, lekin
 * mijoz onlayn to'lagan bo'lsa pul MARKETGA tushadi va kuryer qo'liga hech
 * narsa olmaydi. Shunda `total = total_price − paid_online_amount` (ishlab
 * chiqarishda `sale_collectible_amount` ga snapshot qilinadi) va identiklik
 * o'zgarishsiz saqlanadi: `total = 0` bo'lganda market bizga QARZDOR
 * (`marketReceivable` manfiy), kuryer ulushini HQ to'laydi, HQ foydasi esa
 * `marketTariff − courierShare − branchShare` bo'lib qolaveradi. This test fuzzes the model and asserts the conservation
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
      // stays ≥ 0 (the normal owned/per-order config space). The OPPOSITE
      // region (tariff does not cover the shares → HQ pays the market more than
      // it collected) is now REJECTED at sale time and is covered by
      // order-service.tariff-guard.spec.ts.
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

/**
 * ONLAYN TO'LANGAN BUYURTMA — IDENTIKLIK SHU YERDA HAM SAQLANADI.
 *
 * Pul modeli (foydalanuvchi qarori 2026-09-14): onlayn pulni MARKET oladi,
 * pochta unga aralashmaydi. Kitobimizda bunday buyurtma 0 so'mlik buyurtma
 * bilan ayni — ya'ni `total = 0`, lekin tarif va ulushlar o'z joyida.
 */
describe("⭐ onlayn to'langan buyurtma (yig'ilgan naqd = 0)", () => {
  const marketTariff = 30000;
  const courierShare = 15000;
  const branchShare = 0;

  it('⭐ market BIZGA qarzdor bo`ladi, biz marketga emas', () => {
    const legs = computeSaleLegs({
      total: 0,
      marketTariff,
      courierShare,
      branchShare,
    });
    // Manfiy `marketReceivable` = "market bizga qarz".
    expect(legs.marketReceivable).toBe(-30000);
  });

  it('⭐ HQ foydasi naqd yig`ilmagani uchun O`ZGARMAYDI', () => {
    const legs = computeSaleLegs({
      total: 0,
      marketTariff,
      courierShare,
      branchShare,
    });
    expect(legs.hqProfit).toBe(15000);
  });

  it('⭐ saqlanish identikligi buzilmaydi', () => {
    const legs = computeSaleLegs({
      total: 0,
      marketTariff,
      courierShare,
      branchShare,
    });
    expect(
      round2(
        legs.marketReceivable +
          legs.courierKept +
          legs.branchKept +
          legs.hqProfit,
      ),
    ).toBe(0);
  });

  it('qisman onlayn to`lovda ham saqlanadi', () => {
    // 250 000 buyurtma, 100 000 oldindan to'langan -> 150 000 naqd yig'iladi.
    const total = 150000;
    const legs = computeSaleLegs({
      total,
      marketTariff,
      courierShare,
      branchShare,
    });
    expect(
      round2(
        legs.marketReceivable +
          legs.courierKept +
          legs.branchKept +
          legs.hqProfit,
      ),
    ).toBe(total);
  });
});
