import type { EntityManager } from 'typeorm';
import {
  CASHBOX_RECEIPT_FILTER_STATUSES,
  CASHBOX_RECEIPT_KINDS,
  type CashboxReceiptFilterStatus,
  type CashboxReceiptKind,
} from '@app/common';
import {
  receiptStatusIdCondition,
  type ReceiptTables,
} from './cashbox-receipt.views';

/**
 * T3-4 (QlLf33Ma) — chek tekshiruvi xulosasi (`GET /finance/receipts/summary`,
 * AI yordamchining `get_receipt_checks` tool'i).
 *
 * Qatorlar to'plami — davrdagi (operatsiya sanasi, Toshkent kuni) tarix
 * qatorlari:
 *  - bog'langan chekning ASOSIY qatori (`history_id`) → chekning `ai_status`;
 *  - «Chek yo'q» (`none`) — `receiptStatusIdCondition('none')` bilan AYNI
 *    shart (tarixdagi `receipt_status=none` filtri bilan bitta funksiya).
 * Javobda ism, rasm havolasi va karta raqami YO'Q.
 */
export const RECEIPT_SUMMARY_TOP_N = 15;

export type ReceiptSummaryCounts = Record<CashboxReceiptFilterStatus, number>;

export interface ReceiptSummaryFilter {
  start: Date;
  end: Date;
  kind?: CashboxReceiptKind;
  ai_status?: CashboxReceiptFilterStatus;
}

export interface ReceiptChecksSummary {
  counts: ReceiptSummaryCounts;
  total: number;
  mismatch_total: number;
  by_branch: Array<{ branch_id: string; counts: ReceiptSummaryCounts }>;
  by_category: Array<{
    expense_category_id: string;
    name: string | null;
    counts: ReceiptSummaryCounts;
  }>;
  top: Array<{
    receipt_id: string;
    history_id: string;
    kind: CashboxReceiptKind;
    entered_amount: number | null;
    difference: number;
    date: Date;
  }>;
}

const quote = (tablePath: string) =>
  tablePath
    .split('.')
    .map((part) => `"${part.replace(/"/g, '')}"`)
    .join('.');

export const emptyReceiptCounts = (): ReceiptSummaryCounts =>
  Object.fromEntries(
    CASHBOX_RECEIPT_FILTER_STATUSES.map((status) => [status, 0]),
  ) as ReceiptSummaryCounts;

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Davrdagi qatorlar: `status`, `kind`, filial, kategoriya (filtrlar bilan). */
function baseSql(tables: ReceiptTables, filter: ReceiptSummaryFilter) {
  const h = quote(tables.history);
  const r = quote(tables.receipts);
  const none = receiptStatusIdCondition('hh."id"', 'none', tables);
  const params: unknown[] = [filter.start, filter.end];
  const where: string[] = [];
  if (filter.kind) {
    params.push(filter.kind);
    where.push(`b."kind" = $${params.length}`);
  }
  if (filter.ai_status) {
    params.push(filter.ai_status);
    where.push(`b."status" = $${params.length}`);
  }
  const sql = `WITH b AS (
      SELECT hh."id" AS history_id,
        hh."createdAt" AS date,
        r."id" AS receipt_id,
        COALESCE(r."ai_status", 'none') AS status,
        COALESCE(r."kind", CASE hh."source_type"
          WHEN 'manual_expense' THEN 'manual_expense'
          WHEN 'courier_payment' THEN 'courier_to_hq'
          WHEN 'branch_to_main' THEN 'branch_to_hq' END) AS kind,
        COALESCE(r."branch_id",
          CASE WHEN r."id" IS NULL AND hh."source_type" = 'branch_to_main'
            THEN hh."source_user_id" END) AS branch_id,
        hh."expense_category_id" AS expense_category_id,
        hh."expense_category_name" AS expense_category_name,
        COALESCE(r."entered_amount", hh."amount") AS entered_amount,
        r."ai_difference" AS difference
      FROM ${h} hh
      LEFT JOIN ${r} r ON r."history_id" = hh."id"
        AND r."is_deleted" = false AND r."state" = 'linked'
      WHERE hh."is_deleted" = false
        AND hh."createdAt" BETWEEN $1 AND $2
        AND (r."id" IS NOT NULL OR (${none.sql}))
    )
    `;
  return {
    sql,
    where: where.length ? ` WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

export async function loadReceiptChecksSummary(
  manager: EntityManager,
  tables: ReceiptTables,
  filter: ReceiptSummaryFilter,
): Promise<ReceiptChecksSummary> {
  const base = baseSql(tables, filter);
  const [groups, topRows] = await Promise.all([
    manager.query<
      Array<{
        status: CashboxReceiptFilterStatus;
        branch_id: string | null;
        expense_category_id: string | null;
        name: string | null;
        count: number;
        mismatch_sum: string | number;
      }>
    >(
      `${base.sql}
      SELECT b."status", b."branch_id", b."expense_category_id",
        MAX(b."expense_category_name") AS name, COUNT(*)::int AS count,
        COALESCE(SUM(ABS(b."difference"))
          FILTER (WHERE b."status" = 'mismatch'), 0) AS mismatch_sum
      FROM b${base.where}
      GROUP BY 1, 2, 3`,
      base.params,
    ),
    manager.query<
      Array<{
        receipt_id: string;
        history_id: string;
        kind: CashboxReceiptKind;
        entered_amount: string | number | null;
        difference: string | number;
        date: Date;
      }>
    >(
      `${base.sql}
      SELECT * FROM (SELECT * FROM b${base.where}) t
      WHERE t."status" = 'mismatch' AND t."difference" IS NOT NULL
      ORDER BY ABS(t."difference") DESC, t."history_id" DESC
        LIMIT ${RECEIPT_SUMMARY_TOP_N}`,
      base.params,
    ),
  ]);

  const counts = emptyReceiptCounts();
  const byBranch = new Map<string, ReceiptSummaryCounts>();
  const byCategory = new Map<
    string,
    { name: string | null; counts: ReceiptSummaryCounts }
  >();
  let mismatchTotal = 0;
  for (const row of groups) {
    const n = Number(row.count) || 0;
    if (!(row.status in counts)) continue;
    counts[row.status] += n;
    mismatchTotal += num(row.mismatch_sum) ?? 0;
    if (row.branch_id !== null && row.branch_id !== undefined) {
      const key = String(row.branch_id);
      const c = byBranch.get(key) ?? emptyReceiptCounts();
      c[row.status] += n;
      byBranch.set(key, c);
    }
    if (
      row.expense_category_id !== null &&
      row.expense_category_id !== undefined
    ) {
      const key = String(row.expense_category_id);
      const c = byCategory.get(key) ?? {
        name: row.name ?? null,
        counts: emptyReceiptCounts(),
      };
      c.counts[row.status] += n;
      c.name = c.name ?? row.name ?? null;
      byCategory.set(key, c);
    }
  }
  const sum = (c: ReceiptSummaryCounts) =>
    Object.values(c).reduce((s, v) => s + v, 0);
  return {
    counts,
    total: sum(counts),
    mismatch_total: round2(mismatchTotal),
    by_branch: [...byBranch.entries()]
      .map(([branch_id, c]) => ({ branch_id, counts: c }))
      .sort((a, b) => sum(b.counts) - sum(a.counts)),
    by_category: [...byCategory.entries()]
      .map(([expense_category_id, v]) => ({
        expense_category_id,
        name: v.name,
        counts: v.counts,
      }))
      .sort((a, b) => sum(b.counts) - sum(a.counts)),
    top: topRows.map((row) => ({
      receipt_id: String(row.receipt_id),
      history_id: String(row.history_id),
      kind: row.kind,
      entered_amount: num(row.entered_amount),
      difference: num(row.difference) ?? 0,
      date: row.date,
    })),
  };
}

export const isReceiptSummaryKind = (
  value: unknown,
): value is CashboxReceiptKind =>
  typeof value === 'string' &&
  (CASHBOX_RECEIPT_KINDS as readonly string[]).includes(value);
