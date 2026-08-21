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

/**
 * Amount credited to the branch cashbox at sale time. Branch/HQ balances show
 * the tariff-adjusted payable share, regardless of whether a courier or manager
 * performed the sale; the gross product price remains on the order detail.
 */
export function resolveBranchCashboxSaleAmount(
  totalPrice: number,
  branchPayable: number,
  isManagerSale: boolean,
): number {
  void totalPrice;
  void isManagerSale;
  return branchPayable;
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
