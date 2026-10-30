import { EntityManager, In, type FindOptionsWhere } from 'typeorm';
import {
  Cashbox_type,
  Operation_type,
  PAYMENT_CORRECTION_DEFAULT_WINDOW_DAYS,
  PAYMENT_CORRECTION_ERROR_CODES,
  PAYMENT_CORRECTION_MAX_WINDOW_DAYS,
  PAYMENT_CORRECTION_MIN_WINDOW_DAYS,
  PAYMENT_CORRECTION_NOT_CORRECTABLE_REASONS,
  PAYMENT_CORRECTION_WINDOW_KEY,
  PaymentMethod,
  Source_type,
  type PaymentCorrectionErrorCode,
  type PaymentCorrectionNotCorrectableReason,
} from '@app/common';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinanceSetting } from '../entities/finance-setting.entity';
import {
  PaymentCorrection,
  type PaymentCorrectionKind,
} from '../entities/payment-correction.entity';

/**
 * T6 — to'lovni qaytarish / tahrirlash qoidalari (sof funksiyalar + o'qish
 * yordamchilari). Pul YOZMAYDI — yozish `PaymentCorrectionService` da,
 * tarix javobidagi `correction` / `correctable` bloklari esa
 * `FinanceServiceService` dan shu yerdagi funksiyalar orqali (servislar
 * bir-biriga aylanma bog'lanmasin).
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export type HistoryWithCashbox = CashboxHistory & { cashbox: Cashbox };

/** Bir to'lovning oyoqlari, vazifasi bo'yicha. */
export interface TransferShape {
  kind: PaymentCorrectionKind;
  /** click_to_market: kuryer → HQ → market (to'rt oyoq). */
  clickToMarket: boolean;
  amount: number;
  payment_method: PaymentMethod;
  /** Kuryer kassasi EXPENSE (`courier_payment`). */
  courierLeg: HistoryWithCashbox | null;
  /** Qabul qiluvchi MAIN/BRANCH INCOME (`courier_payment`). */
  receiverLeg: HistoryWithCashbox | null;
  /** MAIN EXPENSE (`market_payment`) — marketga to'lov / click_to_market. */
  mainMarketLeg: HistoryWithCashbox | null;
  /** Market kassasi EXPENSE (`market_payment`). */
  marketLeg: HistoryWithCashbox | null;
  /** Pul qabul qilgan / bergan MAIN yoki BRANCH kassa. */
  receiverCashbox: Cashbox;
  /** Kuryer (kuryer to'lovi) yoki market (marketga to'lov) user id si. */
  counterpartyUserId: string;
  legs: HistoryWithCashbox[];
}

const isType = (leg: HistoryWithCashbox, type: Cashbox_type) =>
  leg.cashbox?.cashbox_type === type;

/**
 * Oyoqlardan to'lov turini aniqlaydi. Qamrov: `courier_payment` (MAIN /
 * BRANCH; cash / click / click_to_market) va `market_payment` (MAIN →
 * market). Boshqa shakl (sotuv oyoqlari, qisman / buzilgan guruh) — `null`.
 */
export function classifyTransfer(
  legs: HistoryWithCashbox[],
): TransferShape | null {
  if (!legs.length) return null;
  const pick = (
    test: (leg: HistoryWithCashbox) => boolean,
  ): HistoryWithCashbox | null => {
    const found = legs.filter(test);
    return found.length === 1 ? found[0] : null;
  };
  const courierLeg = pick(
    (leg) =>
      isType(leg, Cashbox_type.FOR_COURIER) &&
      leg.operation_type === Operation_type.EXPENSE &&
      leg.source_type === Source_type.COURIER_PAYMENT,
  );
  const receiverLeg = pick(
    (leg) =>
      (isType(leg, Cashbox_type.MAIN) || isType(leg, Cashbox_type.BRANCH)) &&
      leg.operation_type === Operation_type.INCOME &&
      leg.source_type === Source_type.COURIER_PAYMENT,
  );
  const mainMarketLeg = pick(
    (leg) =>
      isType(leg, Cashbox_type.MAIN) &&
      leg.operation_type === Operation_type.EXPENSE &&
      leg.source_type === Source_type.MARKET_PAYMENT,
  );
  const marketLeg = pick(
    (leg) =>
      isType(leg, Cashbox_type.FOR_MARKET) &&
      leg.operation_type === Operation_type.EXPENSE &&
      leg.source_type === Source_type.MARKET_PAYMENT,
  );
  const amount = Number(legs[0].amount);
  if (
    !(amount > 0) ||
    legs.some((leg) => Number(leg.amount) !== amount) ||
    legs.some((leg) => leg.payment_method !== legs[0].payment_method)
  ) {
    return null;
  }
  const method = legs[0].payment_method;

  if (courierLeg && receiverLeg) {
    const click = method === PaymentMethod.CLICK_TO_MARKET;
    if (click) {
      if (
        legs.length !== 4 ||
        !mainMarketLeg ||
        !marketLeg ||
        !isType(receiverLeg, Cashbox_type.MAIN) ||
        String(mainMarketLeg.cashbox_id) !== String(receiverLeg.cashbox_id)
      ) {
        return null;
      }
    } else if (legs.length !== 2) {
      return null;
    }
    return {
      kind: 'courier_payment',
      clickToMarket: click,
      amount,
      payment_method: method,
      courierLeg,
      receiverLeg,
      mainMarketLeg: click ? mainMarketLeg : null,
      marketLeg: click ? marketLeg : null,
      receiverCashbox: receiverLeg.cashbox,
      counterpartyUserId: String(courierLeg.cashbox.user_id),
      legs,
    };
  }
  if (
    !courierLeg &&
    !receiverLeg &&
    mainMarketLeg &&
    marketLeg &&
    legs.length === 2 &&
    method !== PaymentMethod.CLICK_TO_MARKET
  ) {
    return {
      kind: 'market_payment',
      clickToMarket: false,
      amount,
      payment_method: method,
      courierLeg: null,
      receiverLeg: null,
      mainMarketLeg,
      marketLeg,
      receiverCashbox: mainMarketLeg.cashbox,
      counterpartyUserId: String(marketLeg.cashbox.user_id),
      legs,
    };
  }
  return null;
}

/** Muddat sozlamasi (kun). Qator yo'q / yaroqsiz — 30. */
export function parseWindowDays(value: unknown): number {
  const days = Number(value);
  return Number.isInteger(days) &&
    days >= PAYMENT_CORRECTION_MIN_WINDOW_DAYS &&
    days <= PAYMENT_CORRECTION_MAX_WINDOW_DAYS
    ? days
    : PAYMENT_CORRECTION_DEFAULT_WINDOW_DAYS;
}

export async function readWindowSetting(manager: EntityManager): Promise<{
  window_days: number;
  updated_by: string | null;
  updated_at: Date | null;
}> {
  const row = await manager.findOne(FinanceSetting, {
    where: { key: PAYMENT_CORRECTION_WINDOW_KEY, isDeleted: false },
  });
  return {
    window_days: parseWindowDays(row?.value),
    updated_by: row?.updated_by ? String(row.updated_by) : null,
    updated_at: row?.updatedAt ?? null,
  };
}

/** `root_created_at + window_days × 24 soat`. */
export function correctionDeadline(rootCreatedAt: Date, windowDays: number) {
  return new Date(new Date(rootCreatedAt).getTime() + windowDays * DAY_MS);
}

export async function loadTransferLegs(
  manager: EntityManager,
  transferId: string,
): Promise<HistoryWithCashbox[]> {
  const legs = await manager.find(CashboxHistory, {
    where: { transfer_id: transferId, isDeleted: false },
    relations: ['cashbox'],
    order: { id: 'ASC' },
  });
  return legs;
}

/** Tahrir zanjirining birinchi to'lovi (muddat shundan). */
export async function resolveChainRoot(
  manager: EntityManager,
  transferId: string,
  legs: HistoryWithCashbox[],
): Promise<{ root_transfer_id: string; root_created_at: Date }> {
  const parent = await manager.findOne(PaymentCorrection, {
    where: { replacement_transfer_id: transferId, isDeleted: false },
  });
  if (parent) {
    return {
      root_transfer_id: parent.root_transfer_id,
      root_created_at: new Date(parent.root_created_at),
    };
  }
  const first = legs.reduce(
    (min, leg) => Math.min(min, new Date(leg.createdAt).getTime()),
    Number.POSITIVE_INFINITY,
  );
  return { root_transfer_id: transferId, root_created_at: new Date(first) };
}

/** Bu to'lov allaqachon qaytarilganmi / tuzatilganmi. */
export async function isTransferCorrected(
  manager: EntityManager,
  transferId: string,
  legIds: string[],
): Promise<boolean> {
  const correction = await manager.findOne(PaymentCorrection, {
    where: { original_transfer_id: transferId, isDeleted: false },
  });
  if (correction) return true;
  if (!legIds.length) return false;
  const reversal = await manager.findOne(CashboxHistory, {
    where: { reverses_history_id: In(legIds), isDeleted: false },
  });
  return Boolean(reversal);
}

export interface CorrectableVerdict {
  allowed: boolean;
  code?: PaymentCorrectionErrorCode;
  /** (iPlY5yop) Faqat `NOT_CORRECTABLE` da. */
  reason?: PaymentCorrectionNotCorrectableReason;
  deadline: string | null;
  window_days: number;
  shape?: TransferShape;
  root?: { root_transfer_id: string; root_created_at: Date };
}

/** Tuzatish qamrovidagi turmi (teskari qator — alohida, `reversal_row`). */
export function isCorrectableType(type: Source_type): boolean {
  return (
    type === Source_type.COURIER_PAYMENT || type === Source_type.MARKET_PAYMENT
  );
}

/**
 * Tarix qatori tuzatilishi mumkinmi (smena / balans / karta tekshiruvisiz —
 * ular amal paytida, qulf ostida). Tartib: tur → bog'lanish → shakl →
 * allaqachon tuzatilgan → kontragent kassasi → muddat.
 */
export async function evaluateCorrectable(
  manager: EntityManager,
  history: HistoryWithCashbox,
  options: { windowDays: number; now?: Date },
): Promise<CorrectableVerdict> {
  const C = PAYMENT_CORRECTION_ERROR_CODES;
  const R = PAYMENT_CORRECTION_NOT_CORRECTABLE_REASONS;
  const base = { window_days: options.windowDays, deadline: null };
  const notCorrectable = {
    allowed: false,
    code: C.NOT_CORRECTABLE,
  };
  if (
    history.source_type === Source_type.PAYMENT_REVERSAL ||
    history.reverses_history_id
  ) {
    return { ...base, ...notCorrectable, reason: R.REVERSAL_ROW };
  }
  if (!isCorrectableType(history.source_type)) {
    return { ...base, ...notCorrectable, reason: R.UNSUPPORTED_TYPE };
  }
  if (!history.transfer_id) {
    return { ...base, allowed: false, code: C.LEGACY_UNLINKED };
  }
  const legs = await loadTransferLegs(manager, history.transfer_id);
  const shape = classifyTransfer(legs);
  if (!shape) {
    return { ...base, ...notCorrectable, reason: R.UNSUPPORTED_TYPE };
  }
  const root = await resolveChainRoot(manager, history.transfer_id, legs);
  const deadline = correctionDeadline(
    root.root_created_at,
    options.windowDays,
  ).toISOString();
  const verdict = { ...base, deadline, shape, root };
  if (
    await isTransferCorrected(
      manager,
      history.transfer_id,
      legs.map((leg) => String(leg.id)),
    )
  ) {
    return { ...verdict, allowed: false, code: C.ALREADY_CORRECTED };
  }
  if (legs.some((leg) => leg.cashbox?.isDeleted)) {
    return { ...verdict, ...notCorrectable, reason: R.CASHBOX_DELETED };
  }
  const now = options.now ?? new Date();
  if (now.getTime() > new Date(deadline).getTime()) {
    return { ...verdict, allowed: false, code: C.WINDOW_EXPIRED };
  }
  return { ...verdict, allowed: true };
}

/**
 * (iPlY5yop) `correctable.root_history_id` — zanjirning birinchi to'lovidagi
 * oyoq, shu kassadagisi (bir kassada ikki oyoq bo'lsa tur va amal ham mos).
 * Zanjir boshi — qatorning o'zi; teskari qator zanjiri jurnaldan; eski yozuvda
 * zanjir yo'q — `null`.
 */
export async function resolveRootHistoryId(
  manager: EntityManager,
  history: HistoryWithCashbox,
  root?: CorrectableVerdict['root'],
): Promise<string | null> {
  if (!history.transfer_id) return null;
  const transferId = String(history.transfer_id);
  const rootTransferId =
    root?.root_transfer_id ??
    (
      await manager.findOne(PaymentCorrection, {
        where: { reversal_transfer_id: transferId, isDeleted: false },
        select: ['id', 'root_transfer_id'],
      })
    )?.root_transfer_id;
  if (!rootTransferId) return null;
  if (rootTransferId === transferId) return String(history.id);
  const legs = await manager.find(CashboxHistory, {
    where: { transfer_id: rootTransferId, isDeleted: false },
    select: ['id', 'cashbox_id', 'source_type', 'operation_type'],
    order: { id: 'ASC' },
  });
  const sameBox = legs.filter(
    (leg) => String(leg.cashbox_id) === String(history.cashbox_id),
  );
  const leg =
    sameBox.find(
      (item) =>
        item.source_type === history.source_type &&
        item.operation_type === history.operation_type,
    ) ??
    sameBox[0] ??
    legs[0];
  return leg ? String(leg.id) : null;
}

export type CorrectionRole = 'original' | 'reversal' | 'replacement';

/**
 * (iPlY5yop, ega qarori «Bog'liq yozuv») — o'sha kassadagi juft oyoq:
 * asl → yangi (tahrir) / teskari (qaytarish); teskari / yangi → asl.
 */
export interface CorrectionRelatedRow {
  id: string;
  source_type: Source_type;
  role: CorrectionRole;
  operation_type: Operation_type;
  amount: number;
  created_at: Date;
}

export interface CorrectionView {
  id: string;
  action: string;
  payment_kind: PaymentCorrectionKind;
  role: CorrectionRole;
  reason: string;
  created_by_name: string | null;
  created_at: Date;
  original_amount: number;
  new_amount: number | null;
  related_history_id: string | null;
  related: CorrectionRelatedRow | null;
}

/**
 * Tarix qatorlariga `correction` bloki: asl to'lov oyog'i (`original`),
 * teskari qator (`reversal`) va tahrirdagi yangi to'lov oyog'i
 * (`replacement`; o'zi keyin yana tuzatilsa — `original`). `related_history_id` — shu kassadagi juft qator (asl ↔
 * teskari; yangi → asl); `related` — «Bog'liq yozuv» qatori (iPlY5yop).
 * Bog'liq oyoqlar BITTA so'rovda (N+1 yo'q). Tuzatilmagan qator —
 * `correction: null`.
 */
export async function attachCorrectionViews<
  T extends {
    id: string;
    cashbox_id: string;
    transfer_id?: string | null;
    reverses_history_id?: string | null;
    source_type?: unknown;
    operation_type?: unknown;
  },
>(
  manager: EntityManager,
  rows: T[],
  nameOf: (ids: string[]) => Promise<Map<string, string | null>>,
): Promise<Array<T & { correction: CorrectionView | null }>> {
  if (!Array.isArray(rows) || !rows.length) {
    return (rows ?? []) as Array<T & { correction: CorrectionView | null }>;
  }
  const transferIds = [
    ...new Set(
      rows
        .map((row) => row?.transfer_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const corrections = transferIds.length
    ? await manager.find(PaymentCorrection, {
        where: [
          { original_transfer_id: In(transferIds), isDeleted: false },
          { reversal_transfer_id: In(transferIds), isDeleted: false },
          { replacement_transfer_id: In(transferIds), isDeleted: false },
        ],
      })
    : [];
  if (!corrections.length) {
    return rows.map((row) => ({ ...row, correction: null }));
  }

  const byOriginal = new Map<string, PaymentCorrection>();
  const byReversal = new Map<string, PaymentCorrection>();
  const byReplacement = new Map<string, PaymentCorrection>();
  for (const correction of corrections) {
    byOriginal.set(correction.original_transfer_id, correction);
    byReversal.set(correction.reversal_transfer_id, correction);
    if (correction.replacement_transfer_id) {
      byReplacement.set(correction.replacement_transfer_id, correction);
    }
  }

  // Juft qatorlar, BITTA so'rov: asl oyoq → teskari qator va yangi oyoq;
  // teskari qator → asl oyoq; yangi oyoq → asl oyoq.
  const legIds = new Set<string>();
  const originalLegIds = new Set<string>();
  const transfers = new Set<string>();
  for (const row of rows) {
    const tid = row.transfer_id ? String(row.transfer_id) : '';
    if (!tid) continue;
    const original = byOriginal.get(tid);
    if (byReversal.has(tid)) {
      if (row.reverses_history_id) legIds.add(String(row.reverses_history_id));
    } else if (original) {
      originalLegIds.add(String(row.id));
      if (original.replacement_transfer_id) {
        transfers.add(original.replacement_transfer_id);
      }
    } else if (byReplacement.has(tid)) {
      transfers.add(byReplacement.get(tid)!.original_transfer_id);
    }
  }
  const legFilters: FindOptionsWhere<CashboxHistory>[] = [
    ...(legIds.size ? [{ id: In([...legIds]) }] : []),
    ...(originalLegIds.size
      ? [{ reverses_history_id: In([...originalLegIds]) }]
      : []),
    ...(transfers.size ? [{ transfer_id: In([...transfers]) }] : []),
  ].map((filter) => ({ ...filter, isDeleted: false }));
  const legs = legFilters.length
    ? await manager.find(CashboxHistory, {
        where: legFilters,
        select: [
          'id',
          'cashbox_id',
          'transfer_id',
          'reverses_history_id',
          'source_type',
          'operation_type',
          'amount',
          'createdAt',
        ],
      })
    : [];
  const legById = new Map<string, CashboxHistory>();
  const reversalsOf = new Map<string, CashboxHistory>();
  const legsByTransfer = new Map<string, CashboxHistory[]>();
  for (const leg of legs) {
    legById.set(String(leg.id), leg);
    if (leg.reverses_history_id) {
      reversalsOf.set(String(leg.reverses_history_id), leg);
    }
    if (leg.transfer_id) {
      const group = legsByTransfer.get(String(leg.transfer_id)) ?? [];
      group.push(leg);
      legsByTransfer.set(String(leg.transfer_id), group);
    }
  }
  // click_to_market: MAIN da ikki oyoq — tur va amal bo'yicha o'z jufti.
  const pairOf = (transferId: string, row: T) => {
    const sameBox = (legsByTransfer.get(transferId) ?? []).filter(
      (leg) => String(leg.cashbox_id) === String(row.cashbox_id),
    );
    return (
      sameBox.find(
        (leg) =>
          leg.source_type === row.source_type &&
          leg.operation_type === row.operation_type,
      ) ??
      sameBox[0] ??
      null
    );
  };
  const relatedRow = (
    leg: CashboxHistory | null | undefined,
    role: CorrectionRole,
  ): CorrectionRelatedRow | null =>
    leg
      ? {
          id: String(leg.id),
          source_type: leg.source_type,
          role,
          operation_type: leg.operation_type,
          amount: Number(leg.amount),
          created_at: leg.createdAt,
        }
      : null;

  const names = await nameOf([
    ...new Set(corrections.map((correction) => String(correction.created_by))),
  ]).catch(() => new Map<string, string | null>());

  return rows.map((row) => {
    const tid = row.transfer_id ? String(row.transfer_id) : '';
    let correction: PaymentCorrection | undefined;
    let role: CorrectionRole | null = null;
    let relatedId: string | null = null;
    let related: CorrectionRelatedRow | null = null;
    if (tid && byReversal.has(tid)) {
      correction = byReversal.get(tid);
      role = 'reversal';
      relatedId = row.reverses_history_id
        ? String(row.reverses_history_id)
        : null;
      related = relatedRow(legById.get(relatedId ?? ''), 'original');
    } else if (tid && byOriginal.has(tid)) {
      // Tahrirdagi yangi to'lov keyin yana tuzatilgan bo'lsa — joriy holat
      // (u ham endi `original`).
      correction = byOriginal.get(tid);
      role = 'original';
      const reversal = reversalsOf.get(String(row.id));
      relatedId = reversal ? String(reversal.id) : null;
      const replacement = correction!.replacement_transfer_id
        ? pairOf(correction!.replacement_transfer_id, row)
        : null;
      related = replacement
        ? relatedRow(replacement, 'replacement')
        : relatedRow(reversal, 'reversal');
    } else if (tid && byReplacement.has(tid)) {
      correction = byReplacement.get(tid);
      role = 'replacement';
      const original = pairOf(correction!.original_transfer_id, row);
      relatedId = original ? String(original.id) : null;
      related = relatedRow(original, 'original');
    }
    if (!correction || !role) {
      return { ...row, correction: null };
    }
    return {
      ...row,
      correction: {
        id: String(correction.id),
        action: correction.action,
        payment_kind: correction.payment_kind,
        role,
        reason: correction.reason,
        created_by_name: names.get(String(correction.created_by)) ?? null,
        created_at: correction.createdAt,
        original_amount: Number(correction.original_amount),
        new_amount:
          correction.new_amount === null || correction.new_amount === undefined
            ? null
            : Number(correction.new_amount),
        related_history_id: relatedId,
        related,
      },
    };
  });
}
