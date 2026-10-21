import {
  Cashbox_type,
  CourierCompensationMode,
  Order_status,
  SettlementStatus,
} from '@app/common';

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

/**
 * (uguUEhin) SOTUVDAN OLDIN — kutilayotgan buyurtma hozir TO'LIQ sotilsa,
 * sotuvchi «Marketga to'langan summa» (`sell {paidAmount}`) ga kirita oladigan
 * buyurtma bo'yicha yuqori chegara, QO'SHIMCHA XARAJATDAN OLDIN (frontend
 * kiritilgan xarajatni o'zi ayiradi).
 *
 * Sotuvdagi formulaning aynan o'zi (`sellOrder`): naqd = total_price −
 * paid_online_amount; `to_be_paid` = max(naqd − market tarifi, 0); allaqachon
 * to'langan qism (`paid_amount`, to_be_paid bilan qisilgan) ayiriladi. Market
 * tarifi — buyurtmadagi snapshot, bo'lmasa market profilidan
 * (`resolveOrderTariff`). Sotuvgacha `to_be_paid` ustuni 0 turadi, shuning
 * uchun oyna shu qiymatni ishlatadi.
 *
 * Market KASSASI chegarasi (`computeSaleMarketPaymentLimit` dagi qarz) bu
 * yerda yo'q — yakuniy chegarani sotuvning o'zi 400 bilan beradi. Tarifni
 * aniqlab bo'lmasa (snapshot ham, market profili ham yo'q) — `null`.
 */
export function computeSaleMarketPaidMax(params: {
  totalPrice: number | string | null | undefined;
  paidOnlineAmount: number | string | null | undefined;
  paidAmount: number | string | null | undefined;
  marketTariffSnapshot: number | string | null | undefined;
  isCenter: boolean;
  centerTariff: number | string | null | undefined;
  homeTariff: number | string | null | undefined;
}): number | null {
  const profileTariff = params.isCenter
    ? params.centerTariff
    : params.homeTariff;
  if (params.marketTariffSnapshot == null && profileTariff == null) {
    return null;
  }
  const marketTariff = resolveOrderTariff({
    snapshot:
      params.marketTariffSnapshot == null
        ? null
        : Number(params.marketTariffSnapshot),
    isCenter: params.isCenter,
    centerTariff:
      params.centerTariff == null ? null : Number(params.centerTariff),
    homeTariff: params.homeTariff == null ? null : Number(params.homeTariff),
  });
  if (!Number.isFinite(marketTariff)) {
    return null;
  }
  const collectible = Math.max(
    (Number(params.totalPrice) || 0) - (Number(params.paidOnlineAmount) || 0),
    0,
  );
  const netToBePaid = Math.max(collectible - marketTariff, 0);
  const currentPaid = Math.min(
    Math.max(Number(params.paidAmount) || 0, 0),
    netToBePaid,
  );
  return round2(Math.max(netToBePaid - currentPaid, 0));
}

/**
 * Id ni normallashtirish: bo'sh qiymat va `'0'` (tayinlanmagan pochta
 * sentineli) "yo'q" degani.
 */
const normalizePartyId = (value: unknown): string => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }
  const normalized = String(value).trim();
  return normalized === '0' ? '' : normalized;
};

/** Rollback paytida settlement qatoridan kerak bo'ladigan maydonlar. */
export interface RollbackSettlementSnapshot {
  status?: SettlementStatus | null;
  courier_id?: string | null;
  branch_id?: string | null;
  courier_amount?: number | string | null;
}

/** Qo'shimcha xarajat (market'dan tashqari) AYNAN yozilgan kassa. */
export interface RollbackExtraCostParty {
  user_id: string;
  cashbox_type: Cashbox_type;
}

export interface RollbackReversalActor {
  /**
   * Sotuvning FOR_COURIER oyog'i yozilgan kuryer. `null` — sotuv kuryer
   * kassasiga hech narsa yozmagan (menejer/filial sotuvi, kargo sotuvi).
   */
  saleCourierId: string | null;
  /** Qo'shimcha xarajat yechilgan kassa (market'dan tashqari) yoki `null`. */
  extraCostParty: RollbackExtraCostParty | null;
  /** Qaror manbai: settlement qatori yoki eski (qatorsiz) buyurtma zaxirasi. */
  source: 'settlement' | 'legacy';
}

/**
 * ROLLBACK QAYSI KASSALARNI TESKARI QILADI — sotuv YOZGAN oyoqlar bo'yicha,
 * rollbackni KIM bosganidan qat'i nazar (audit M1/LC-01).
 *
 * ⚠️ JONLI XATO (prod, 289-kuryer, 140 000 soxta qarz). Ilgari teskari oyoqlar
 * SO'ROVCHIGA qarab tanlanardi: menejer bosgan rollback kuryer kassasini
 * umuman tekshirmasdi (`courierCashbox = null`), qo'shimcha xarajatni esa
 * filial id si bilan qidirardi. Kuryer sotgan buyurtmani menejer qaytarganda
 * market oyog'i va settlement qatori qaytarilardi, kuryer kassasidagi kirim
 * esa qolib ketardi — kuryer hech qachon olmagan pul uchun qarzdor bo'lib
 * qolardi. Teskari holat ham bor edi: SA yoki kuryer menejer sotuvini
 * qaytarganda HECH QACHON yozilmagan kuryer oyog'i teskari yozilardi.
 *
 * Endi manba — `order_settlement` qatori: sotuv uni o'sha tranzaksiyada
 * yozadi va `courier_id` ni FAQAT kuryer kassasiga oyoq yozilganda qo'yadi
 * (bekor qilishda esa faqat qo'shimcha xarajat kuryerdan yechilganda).
 *   • `courier_id` bor  → kuryer oyog'i va xarajat shu kuryerning FOR_COURIER
 *     kassasida;
 *   • `courier_id` yo'q → kuryer oyog'i yo'q, xarajat settlement filialining
 *     BRANCH kassasida (filial yo'q bo'lsa — faqat market'da).
 * Qator umuman yo'q bo'lsa (juda eski buyurtma) — avvalgi, so'rovchiga
 * asoslangan qoida zaxira sifatida qoladi.
 */
export function resolveRollbackReversalActor(params: {
  settlement: RollbackSettlementSnapshot | null | undefined;
  legacy: {
    isManagerRequester: boolean;
    /** `resolveActorCourierId` natijasi (eski qoida). */
    courierId: string;
    requesterBranchId?: string | null;
  };
}): RollbackReversalActor {
  const { settlement, legacy } = params;
  if (settlement) {
    const courierId = normalizePartyId(settlement.courier_id);
    if (courierId) {
      return {
        saleCourierId: courierId,
        extraCostParty: {
          user_id: courierId,
          cashbox_type: Cashbox_type.FOR_COURIER,
        },
        source: 'settlement',
      };
    }
    const branchId = normalizePartyId(settlement.branch_id);
    return {
      saleCourierId: null,
      extraCostParty: branchId
        ? { user_id: branchId, cashbox_type: Cashbox_type.BRANCH }
        : null,
      source: 'settlement',
    };
  }

  if (legacy.isManagerRequester) {
    const branchId = normalizePartyId(legacy.requesterBranchId);
    return {
      saleCourierId: null,
      extraCostParty: branchId
        ? { user_id: branchId, cashbox_type: Cashbox_type.BRANCH }
        : null,
      source: 'legacy',
    };
  }
  const courierId = normalizePartyId(legacy.courierId);
  return {
    saleCourierId: courierId || null,
    extraCostParty: courierId
      ? { user_id: courierId, cashbox_type: Cashbox_type.FOR_COURIER }
      : null,
    source: 'legacy',
  };
}

/**
 * ROLLBACK KURYER KASSASINI QANCHA O'ZGARTIRADI (fix3b, M6) — INCOME +,
 * EXPENSE −. `rollbackOrderToWaiting` dagi kuryer oyoqlarining AYNAN o'sha
 * formulasi: avval qo'shimcha xarajat qaytariladi (INCOME), so'ng sotuv
 * oyog'i teskari yoziladi (`yig'ilgan − ulush` EXPENSE, yig'ilgan ulushdan
 * kam bo'lsa farq INCOME).
 *
 * Superadmin COURIER_SETTLED qatorni qaytarganda qatorning `courier_amount`
 * i kuryer qoldig'iga (carry) KREDIT bo'lib yoziladi. Daftar kassaga mos
 * qolishi uchun kassa aynan shu summaga kamayishi SHART:
 * `delta === −courier_amount`. Mos kelmasa (eski/buzilgan snapshot)
 * rollback rad etiladi — yarim to'g'ri yozuvdan ko'ra to'xtash xavfsiz.
 */
export function computeRollbackCourierCashboxDelta(params: {
  /** Sotuv oyoqlari teskari yoziladimi (SOLD/PAID, SA uchun PARTLY_PAID). */
  reverseSale: boolean;
  /** Sotuvda yig'ilgan naqd snapshoti (`sale_collectible_amount`). */
  saleCollectible: number;
  /** Kuryer ulushi snapshoti (`courier_share`). */
  courierShare: number;
  /** Shu kuryer kassasiga qaytariladigan qo'shimcha xarajat. */
  extraCostRefund: number;
  /**
   * T0UGh8bL — sotuvda shu kuryer marketga to'g'ridan-to'g'ri bergan naqd
   * (`sale_market_paid_amount`). Sotuv uni kuryer kassasidan yechgan va
   * `courier_amount` ni ham shuncha kamaytirgan — rollback qaytaradi (INCOME).
   */
  marketPaidRefund?: number;
}): number {
  const refund =
    Math.max(Number(params.extraCostRefund) || 0, 0) +
    Math.max(Number(params.marketPaidRefund) || 0, 0);
  if (!params.reverseSale) {
    return round2(refund);
  }
  const collectible = Number(params.saleCollectible) || 0;
  const share = Number(params.courierShare) || 0;
  const income = Math.max(collectible - share, 0);
  const expense = Math.max(share - collectible, 0);
  return round2(refund - income + expense);
}

/**
 * KURYER BU BUYURTMA PULINI FILIALGA TOPSHIRGANMI (audit M6).
 *
 * `COURIER_SETTLED` + `courier_id` + nolga teng bo'lmagan `courier_amount`
 * = kuryer to'lovining FIFO taqsimotida bu qator ALLAQACHON hisobga olingan.
 * Rollback qatorni o'chirib, kuryer kassasini teskari yozadi, lekin o'sha
 * taqsimotni kuryerning qoldig'iga (`order_settlement_carry`) QAYTARMAYDI —
 * natijada daftar kuryerdan kassada yo'q pulni abadiy talab qilardi (to'lov
 * "ortiqcha to'lov" bo'lib rad etiladi, kuryerni o'tkazish ham to'siladi).
 * Shuning uchun kuryer va menejer bunday qatorni rollback qilmaydi;
 * superadmin (tuzatish roli) — faqat taqsimotni qoldiqqa QAYTARIB
 * (fix3b, `rollbackOrderToWaiting` dagi kredit yo'li).
 *
 * Istisnolar (rollback xavfsiz):
 *   • `courier_id` yo'q — menejer/filial sotuvi: qator sotuvdayoq
 *     `COURIER_SETTLED` bo'lib ochiladi, kuryer to'lovi umuman yo'q;
 *   • `courier_amount` = 0 — FIFO uni bepul o'tkazgan, taqsimotda hech narsa
 *     sarflanmagan.
 */
export function isCourierRemittedSettlement(
  settlement: RollbackSettlementSnapshot | null | undefined,
): boolean {
  if (!settlement || settlement.status !== SettlementStatus.COURIER_SETTLED) {
    return false;
  }
  if (!normalizePartyId(settlement.courier_id)) {
    return false;
  }
  return (Number(settlement.courier_amount) || 0) !== 0;
}

/**
 * T0UGh8bL — SOTUVDA MARKETGA TO'G'RIDAN-TO'G'RI BERISH MUMKIN BO'LGAN ENG
 * KATTA SUMMA (`sell {paidAmount}` chegarasi).
 *
 * Ikki chegara, kichigi olinadi:
 *   • buyurtma bo'yicha marketga to'lanadigan SOF summa —
 *     `max(yig'ilgan − market tarifi, 0) − qo'shimcha xarajat − allaqachon
 *     to'langan`. Finance FIFO (`marketOrderRemaining`) ham aynan shu
 *     formulani ishlatadi, ya'ni ortiqchasi keyingi HQ to'lovida "manfiy
 *     qoldiq" bo'lib qaytardi;
 *   • market kassasidagi qarz SOTUVDAN KEYIN — `qoldiq + daromad − teskari
 *     oyoq − xarajat`. Market bizga qarzdor bo'lsa (manfiy qoldiq) avval o'sha
 *     qarz yopiladi (autoPay), naqd faqat qolganiga beriladi. `paymentsToMarket`
 *     dagi "ORTIQCHA TO'LOV QO'RIQCHISI" (audit M9) bilan bir xil qoida.
 *
 * Manfiy natija 0 ga qisiladi: bunday buyurtmada naqd berib bo'lmaydi.
 */
export function computeSaleMarketPaymentLimit(params: {
  /** Sotuvda yig'ilgan naqd (`total_price − paid_online_amount`). */
  collectible: number;
  marketTariff: number;
  extraCost: number;
  /** Buyurtmada sotuvdan oldin turgan `paid_amount` (to_be_paid bilan qisilgan). */
  currentPaid: number;
  /** Market kassasining sotuvdan oldingi qoldig'i (HQ'ning qarzi; manfiy — market qarzi). */
  marketBalanceBefore: number;
}): number {
  const collectible = Number(params.collectible) || 0;
  const tariff = Number(params.marketTariff) || 0;
  const extraCost = Math.max(Number(params.extraCost) || 0, 0);
  const currentPaid = Math.max(Number(params.currentPaid) || 0, 0);
  const marketIncome = Math.max(collectible - tariff, 0);
  const marketExpense = Math.max(tariff - collectible, 0);
  const orderPayable = marketIncome - extraCost - currentPaid;
  const cashboxPayable =
    (Number(params.marketBalanceBefore) || 0) +
    marketIncome -
    marketExpense -
    extraCost;
  return round2(Math.max(Math.min(orderPayable, cashboxPayable), 0));
}

/**
 * T0UGh8bL — SOTUVDAN KEYINGI `paid_amount` VA HOLAT.
 *
 * `marketPaidAtSale` (sotuvchi marketga bergan naqd) avval yopiladi, so'ng
 * market qarzidan avtomatik yopiladigan qism (`autoPay`) QOLGANIGA
 * qo'llanadi.
 *
 *   • `marketPaidAtSale = 0` — holat formulasi ilgarigidek BAYTMA-BAYT
 *     (`to_be_paid` to'liq yopilsa PAID, qisman — PARTLY_PAID, aks holda
 *     SOLD). Regressiya: ZsPLevZZ TC 2.
 *   • `marketPaidAtSale > 0` — "to'liq yopildi" SOF summaga nisbatan
 *     (`to_be_paid − qo'shimcha xarajat`), finance FIFO bilan bir xil: aks
 *     holda xarajatli buyurtma marketga to'liq to'langan bo'lsa ham
 *     PARTLY_PAID bo'lib qolardi.
 */
export function computeSalePaymentState(params: {
  /** `max(yig'ilgan − market tarifi, 0)` — buyurtmaning `to_be_paid` i. */
  netToBePaid: number;
  /** Buyurtmada sotuvdan oldin turgan `paid_amount` (qisilgan). */
  currentPaid: number;
  /** Sotuvchi marketga to'g'ridan-to'g'ri bergan naqd (tekshirilgan). */
  marketPaidAtSale: number;
  /** Market kassasining sotuvdan oldingi manfiy qoldig'i (market qarzi), ≥ 0. */
  debtBeforeSale: number;
  extraCost: number;
}): { paidAfter: number; autoPay: number; status: Order_status } {
  const netToBePaid = Math.max(Number(params.netToBePaid) || 0, 0);
  const marketPaidAtSale = Math.max(Number(params.marketPaidAtSale) || 0, 0);
  const paidBeforeDebt = Math.min(
    netToBePaid,
    (Number(params.currentPaid) || 0) + marketPaidAtSale,
  );
  const remainingBeforeDebt = netToBePaid - paidBeforeDebt;
  const autoPay = Math.min(
    remainingBeforeDebt,
    Math.max(Number(params.debtBeforeSale) || 0, 0),
  );
  const paidAfter = Math.min(netToBePaid, paidBeforeDebt + autoPay);

  if (marketPaidAtSale > 0) {
    const extraCost = Math.max(Number(params.extraCost) || 0, 0);
    return {
      paidAfter,
      autoPay,
      status:
        round2(netToBePaid - extraCost - paidAfter) <= 0
          ? Order_status.PAID
          : Order_status.PARTLY_PAID,
    };
  }
  const remaining = Math.max(netToBePaid - paidAfter, 0);
  return {
    paidAfter,
    autoPay,
    status:
      remaining === 0 && paidAfter > 0
        ? Order_status.PAID
        : paidAfter > 0
          ? Order_status.PARTLY_PAID
          : Order_status.SOLD,
  };
}
