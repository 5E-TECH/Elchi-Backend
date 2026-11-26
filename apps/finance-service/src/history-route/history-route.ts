import { EntityManager, In } from 'typeorm';
import { Cashbox_type, Source_type } from '@app/common';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import {
  classifyTransfer,
  type HistoryWithCashbox,
  type TransferVariant,
} from '../payment-correction/payment-correction.rules';

/**
 * (2026-11-26, ega) Kassa tarixi Excel'idagi «Yo'nalish» (kimdan → kimga):
 * to'lov qatori qaysi kassada bo'lmasin, BUTUN to'lov (bitta `transfer_id`
 * oyoqlari, `classifyTransfer`) — kuryer, filial, asosiy kassa va market.
 * Teskari qator (`payment_reversal`) — asl to'lovning yo'nalishi.
 * Shakli aniqlanmagan qator (oddiy filial → HQ topshirig'i, qo'lda kirim,
 * sotuv …) — `route: null` (Excel boshqa ustunlardan yozadi).
 */
export interface HistoryRouteParty {
  id: string;
  name: string | null;
}

export interface HistoryRoute {
  variant: TransferVariant;
  /** Pul qabul qilgan / bergan asosiy yoki filial kassasi. */
  cashbox_type: Cashbox_type.MAIN | Cashbox_type.BRANCH;
  /** Filial id si (filial ishtirok etganda), aks holda `null`. */
  branch_id: string | null;
  courier: HistoryRouteParty | null;
  market: HistoryRouteParty | null;
}

/** Yo'nalish hisoblanadigan turlar. */
const ROUTE_SOURCES: ReadonlySet<string> = new Set([
  Source_type.COURIER_PAYMENT,
  Source_type.MARKET_PAYMENT,
  Source_type.BRANCH_TO_MAIN,
  Source_type.PAYMENT_REVERSAL,
]);

/** `IN (...)` parametrlari bo'laklab (Excel — minglab qator). */
const CHUNK = 1000;
const chunks = <T>(values: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    out.push(values.slice(i, i + CHUNK));
  }
  return out;
};

const sourceOf = (row: { source_type?: unknown } | null | undefined) =>
  typeof row?.source_type === 'string' ? row.source_type : '';

type RouteRow = {
  id: string | number;
  source_type?: unknown;
  transfer_id?: string | null;
  reverses_history_id?: string | number | null;
};

export async function attachHistoryRoutes<T extends RouteRow>(
  manager: EntityManager,
  rows: T[],
  nameOf: (ids: string[]) => Promise<Map<string, string | null>>,
): Promise<Array<T & { route: HistoryRoute | null }>> {
  if (!Array.isArray(rows) || !rows.length) {
    return (rows ?? []) as Array<T & { route: HistoryRoute | null }>;
  }
  const candidates = rows.filter((row) => ROUTE_SOURCES.has(sourceOf(row)));

  // Teskari qator → asl oyoqning `transfer_id` si.
  const reversed = [
    ...new Set(
      candidates
        .filter(
          (row) =>
            row.source_type === Source_type.PAYMENT_REVERSAL &&
            row.reverses_history_id,
        )
        .map((row) => String(row.reverses_history_id)),
    ),
  ];
  const originalTransfer = new Map<string, string>();
  for (const part of chunks(reversed)) {
    const originals = await manager.find(CashboxHistory, {
      where: { id: In(part) },
      select: ['id', 'transfer_id'],
    });
    for (const leg of originals) {
      if (leg.transfer_id) {
        originalTransfer.set(String(leg.id), String(leg.transfer_id));
      }
    }
  }
  const transferOf = (row: RouteRow): string | null =>
    row.source_type === Source_type.PAYMENT_REVERSAL
      ? (originalTransfer.get(String(row.reverses_history_id ?? '')) ?? null)
      : row.transfer_id
        ? String(row.transfer_id)
        : null;

  const transferIds = [
    ...new Set(
      candidates.map(transferOf).filter((id): id is string => Boolean(id)),
    ),
  ];
  const legsByTransfer = new Map<string, HistoryWithCashbox[]>();
  for (const part of chunks(transferIds)) {
    const legs = (await manager.find(CashboxHistory, {
      where: { transfer_id: In(part), isDeleted: false },
      relations: ['cashbox'],
      order: { id: 'ASC' },
    })) as HistoryWithCashbox[];
    for (const leg of legs) {
      const key = String(leg.transfer_id);
      const group = legsByTransfer.get(key) ?? [];
      group.push(leg);
      legsByTransfer.set(key, group);
    }
  }

  const shapes = new Map<string, ReturnType<typeof classifyTransfer>>();
  const userIds = new Set<string>();
  for (const [transferId, legs] of legsByTransfer) {
    const shape = classifyTransfer(legs);
    shapes.set(transferId, shape);
    if (shape?.courierLeg)
      userIds.add(String(shape.courierLeg.cashbox.user_id));
    if (shape?.marketLeg) userIds.add(String(shape.marketLeg.cashbox.user_id));
  }
  const names = userIds.size
    ? await nameOf([...userIds]).catch(() => new Map<string, string | null>())
    : new Map<string, string | null>();
  const party = (id: string | null): HistoryRouteParty | null =>
    id ? { id, name: names.get(id) ?? null } : null;

  const routes = new Map<string, HistoryRoute | null>();
  for (const [transferId, shape] of shapes) {
    if (!shape) {
      routes.set(transferId, null);
      continue;
    }
    const branch =
      shape.receiverCashbox.cashbox_type === Cashbox_type.BRANCH
        ? String(shape.receiverCashbox.user_id)
        : null;
    routes.set(transferId, {
      variant: shape.variant,
      cashbox_type: branch ? Cashbox_type.BRANCH : Cashbox_type.MAIN,
      branch_id: branch,
      courier: party(
        shape.courierLeg ? String(shape.courierLeg.cashbox.user_id) : null,
      ),
      market: party(
        shape.marketLeg ? String(shape.marketLeg.cashbox.user_id) : null,
      ),
    });
  }

  return rows.map((row) => {
    if (!ROUTE_SOURCES.has(sourceOf(row))) {
      return { ...row, route: null };
    }
    const transferId = transferOf(row);
    return {
      ...row,
      route: transferId ? (routes.get(transferId) ?? null) : null,
    };
  });
}
