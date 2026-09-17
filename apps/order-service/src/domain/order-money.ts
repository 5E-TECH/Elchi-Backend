import { CourierCompensationMode } from '@app/common';

/**
 * COD (cash-on-delivery) money model — the pure split/profit formulas for one
 * sold order, extracted from OrderServiceService so they are a single, typed,
 * unit-testable source of truth (Audit: financial math was inline in the 10k-line
 * service and the "money-conservation" test re-implemented it instead of
 * importing it). Behaviour matches the previous inline arithmetic exactly.
 *
 * All amounts are som on numeric(14,2) columns. `round2` mirrors the 2-dp money
 * scale for the derived conservation legs; `computeSellProfit` is intentionally
 * NOT rounded to stay byte-identical to the finance ledger write in the service.
 */

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * HQ (company) profit on a sale = what the market is charged (market tariff)
 * minus what the courier keeps minus what a PARTNER branch keeps. Mirrored by
 * finance-service's sell_profit ledger entry.
 */
export function computeSellProfit(
  marketTariff: number,
  courierShare: number,
  branchShare: number,
): number {
  return marketTariff - courierShare - branchShare;
}

/**
 * The per-order amount a courier KEEPS, per their compensation mode:
 * SALARY_ONLY keeps nothing (0); PER_ORDER / SALARY_PLUS_PER_ORDER keep the
 * configured tariff. Defaults to keeping the tariff when the mode is unknown
 * (back-compatible with couriers created before the mode existed).
 */
export function resolveCourierShare(
  courier: { compensation_mode?: string | null } | null | undefined,
  courierTariff: number,
): number {
  if (courier?.compensation_mode === CourierCompensationMode.SALARY_ONLY) {
    return 0;
  }
  return courierTariff;
}

/**
 * The share kept by the sale's financial actor. A manager-performed sale keeps
 * the full tariff; a courier sale keeps their compensation-mode share.
 */
export function resolveSaleActorShare(
  isManagerSale: boolean,
  financialActor: { compensation_mode?: string | null } | null | undefined,
  tariff: number,
): number {
  return isManagerSale ? tariff : resolveCourierShare(financialActor, tariff);
}

export interface SaleShareInputs {
  /** Total COD price the customer pays on delivery. */
  total: number;
  /** What HQ charges the market for the order (HQ's gross). */
  marketTariff: number;
  /** What the courier keeps. */
  courierShare: number;
  /** What a PARTNER branch keeps (0 for HQ-owned branches). */
  branchShare: number;
}

/**
 * The full set of COD money legs for one sold order. The conservation identity
 * that MUST always hold (no money leaked, none double-counted):
 *
 *   marketReceivable + courierKept + branchKept + hqProfit === total
 *
 * The *Amount legs are the "owed up-chain" values consumed at each FIFO
 * settlement hop (order_settlement.courier_amount / branch_amount / market_amount).
 */
export function computeSaleLegs(i: SaleShareInputs) {
  return {
    marketReceivable: round2(i.total - i.marketTariff),
    courierKept: round2(i.courierShare),
    branchKept: round2(i.branchShare),
    hqProfit: round2(i.marketTariff - i.courierShare - i.branchShare),
    courierAmount: round2(i.total - i.courierShare),
    branchAmount: round2(i.total - i.courierShare - i.branchShare),
    marketAmount: round2(i.total - i.marketTariff),
  };
}

/**
 * Tiyin-level tolerance for the tariff-coverage check below. Money is stored as
 * numeric(14,2), so anything at or under one tiyin is rounding noise, not a
 * real shortfall.
 */
export const TARIFF_SHORTFALL_TOLERANCE = 0.01;

/**
 * How much a sale would cost HQ out of its own pocket, i.e. the amount by which
 * what the courier and a PARTNER branch KEEP exceeds what the market is charged.
 *
 * The COD chain pays the market `total − marketTariff` but only collects
 * `total − courierShare − branchShare` up the chain, so whenever the market
 * tariff does not cover both shares HQ must hand the market MORE than it ever
 * received — a silent per-order loss (booked as a negative `sell_profit`). This
 * is the negated `computeSellProfit`, clamped at 0 so a healthy sale returns 0.
 *
 * Returns 0 (no shortfall) when the tariff covers the shares.
 */
export function computeTariffShortfall(
  marketTariff: number,
  courierShare: number,
  branchShare: number,
): number {
  const shortfall = round2(
    -computeSellProfit(marketTariff, courierShare, branchShare),
  );
  return shortfall > TARIFF_SHORTFALL_TOLERANCE ? shortfall : 0;
}

/**
 * The tariff ONE order must be settled with: the per-order snapshot/override
 * when the order carries one, otherwise the live profile tariff for the order's
 * delivery mode (center vs home).
 *
 * Every sale and rollback path MUST resolve tariffs through this helper. The
 * same 8-line ternary used to be copy-pasted per path and they had DRIFTED:
 * `sellOrder` read only the live profile while `partlySellOrder` and the
 * rollback preferred the snapshot — so an order with a per-order override got
 * its market cashbox leg posted with one tariff while `sell_profit` and the
 * reversal used another, leaving the market over/under-paid and a residue in
 * its cashbox after a rollback.
 */
export function resolveOrderTariff(params: {
  /** Per-order snapshot/override (`order.market_tariff` / `courier_tariff`). */
  snapshot: number | null | undefined;
  /** True when the order is delivered to a center (vs the customer's address). */
  isCenter: boolean;
  centerTariff: number | null | undefined;
  homeTariff: number | null | undefined;
}): number {
  if (params.snapshot != null) {
    return Number(params.snapshot);
  }
  return Number(
    (params.isCenter ? params.centerTariff : params.homeTariff) ?? 0,
  );
}
