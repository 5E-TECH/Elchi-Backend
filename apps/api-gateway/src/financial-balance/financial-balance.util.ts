import { FinancialSource_type } from '@app/common';
import { ExpenseCategory } from '@app/common/enums';
import {
  LEDGER_SOURCE_CATEGORY,
  ledgerSourceAsksCategory,
} from '@app/common/finance/expense-category';
import { excelDate, excelNumber, type ExcelColumn } from '../excel/excel.util';

/**
 * MOLIYAVIY DAFTAR (financial balance) — gateway yordamchilari
 * (4WeT0Tv5 "Izoh"/kim kiritgan, GtAoqHlk Excel eksport).
 */

/** Jadval va Excel uchun yetarli minimal ma'lumot — to'liq identity yozuvi emas. */
export interface FinancialActor {
  id: string;
  name: string | null;
  role: string | null;
}

const flagOn = (value: string | undefined) =>
  String(value ?? '')
    .trim()
    .toLowerCase() === 'on';

/**
 * ljVOuNz4 — `POST /financial-balance/entries` da kategoriya majburiy
 * (`manual_expense`, `bills`). Sukut o'chiq: hozirgi FE payload'i `{ amount,
 * source_type, comment }`. Tanlov oynasi chiqqandan keyin yoqiladi.
 */
export const financialEntryCategoryRequired = () =>
  flagOn(process.env.FINANCIAL_ENTRY_CATEGORY_REQUIRED);

/**
 * ljVOuNz4 — `PATCH /cashbox/spend` da izoh majburiy. Sukut o'chiq (ega
 * 2026-10-22: xarajat kategoriya orqali, izoh ixtiyoriy; FE bo'sh izohni
 * yubormaydi).
 */
export const cashboxSpendCommentRequired = () =>
  flagOn(process.env.CASHBOX_SPEND_COMMENT_REQUIRED);

const asText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** identity javobidan (`{data: user}` yoki `user`) faqat id/ism/rol. */
export const toFinancialActor = (
  id: string,
  response: unknown,
): FinancialActor | null => {
  const raw = (response as { data?: unknown } | null)?.data ?? response;
  if (!raw || typeof raw !== 'object') return null;
  const user = raw as { name?: unknown; role?: unknown };
  return {
    id,
    name: asText(user.name).trim() || null,
    role: asText(user.role).trim() || null,
  };
};

/**
 * Takrorlanmas `created_by` lar bo'yicha BIR martadan so'raydi; xato bo'lgan
 * foydalanuvchi `null` (jadval "—" ko'rsatadi, so'rov yiqilmaydi).
 */
export async function resolveFinancialActors(
  ids: unknown[],
  fetchUser: (id: string) => Promise<unknown>,
): Promise<Map<string, FinancialActor | null>> {
  const unique = Array.from(
    new Set(
      ids.map((id) => asText(id).trim()).filter((id) => /^\d+$/.test(id)),
    ),
  );
  const pairs = await Promise.all(
    unique.map(async (id) => {
      try {
        return [id, toFinancialActor(id, await fetchUser(id))] as const;
      } catch {
        return [id, null] as const;
      }
    }),
  );
  return new Map(pairs);
}

/** Frontend yorliqlari bilan bir xil (locales/uz/payments.json). */
export const FINANCIAL_SOURCE_LABEL_UZ: Readonly<
  Record<FinancialSource_type, string>
> = Object.freeze({
  [FinancialSource_type.SELL_PROFIT]: 'Pochta foydasi',
  [FinancialSource_type.SELL_EXTRA_COST]: "Qo'shimcha xarajat",
  [FinancialSource_type.CANCEL_EXTRA_COST]: "Qo'shimcha xarajat",
  [FinancialSource_type.MANUAL_INCOME]: "Qo'lda kirim",
  [FinancialSource_type.MANUAL_EXPENSE]: "Qo'lda chiqim",
  [FinancialSource_type.SALARY]: 'Maosh',
  [FinancialSource_type.CORRECTION]: 'Tuzatish (rollback)',
  [FinancialSource_type.BILLS]: 'Hisob-fakturalar',
  [FinancialSource_type.PICKUP_FEE]: 'Pickup haqi',
});

/** ljVOuNz4 — kategoriya nomlari (karta ro'yxati bilan bir xil). */
export const EXPENSE_CATEGORY_LABEL_UZ: Readonly<
  Record<ExpenseCategory, string>
> = Object.freeze({
  [ExpenseCategory.FOOD]: 'Ovqat',
  [ExpenseCategory.TRANSPORT]: 'Transport',
  [ExpenseCategory.FUEL]: "Yoqilg'i",
  [ExpenseCategory.RENT]: 'Ijara',
  [ExpenseCategory.UTILITIES]: 'Kommunal',
  [ExpenseCategory.COMMUNICATION]: 'Aloqa/Internet',
  [ExpenseCategory.STATIONERY]: 'Kanstovar',
  [ExpenseCategory.REPAIR]: "Ta'mirlash",
  [ExpenseCategory.MARKETING]: 'Reklama/Marketing',
  [ExpenseCategory.TAX]: 'Soliq',
  [ExpenseCategory.BANK_FEE]: 'Bank/komissiya',
  [ExpenseCategory.GIFT]: "Sovg'a/mehmon",
  [ExpenseCategory.CLEANING]: 'Tozalash',
  [ExpenseCategory.PACKAGING]: 'Ombor/qadoqlash',
  [ExpenseCategory.SALARY]: 'Oylik/maosh',
  [ExpenseCategory.COURIER_FEE]: 'Kuryer haqi',
  [ExpenseCategory.VEHICLE_REPAIR]: "Transport ta'miri",
  [ExpenseCategory.OTHER]: 'Boshqa',
});

/**
 * Daftar qatorining kategoriya matni: xarajatda hisobot bilan bir xil qoida
 * (kategoriya → manba ma'nosi → «Kategoriyasiz»), xarajat emas — bo'sh.
 */
const expenseCategoryLabel = (row: Record<string, unknown>): string => {
  const source = asText(row.source_type) as FinancialSource_type;
  const category =
    (row.expense_category as ExpenseCategory | null | undefined) ??
    LEDGER_SOURCE_CATEGORY[source];
  if (category) {
    return EXPENSE_CATEGORY_LABEL_UZ[category] ?? category;
  }
  return ledgerSourceAsksCategory(source) ? 'Kategoriyasiz' : '';
};

export const FINANCIAL_BALANCE_EXPORT_COLUMNS: ExcelColumn[] = [
  { header: 'ID', key: 'id', width: 10 },
  { header: 'Sana', key: 'date', width: 22 },
  { header: 'Manba', key: 'source', width: 22 },
  { header: "O'zgarish", key: 'change', width: 16 },
  { header: 'Oldingi balans', key: 'balance_before', width: 18 },
  { header: 'Keyingi balans', key: 'balance_after', width: 18 },
  { header: 'Izoh', key: 'comment', width: 40 },
  { header: 'Kim kiritgan', key: 'created_by', width: 22 },
  { header: 'Buyurtma ID', key: 'order_id', width: 14 },
  { header: 'Kategoriya', key: 'category', width: 20 },
];

/**
 * Bitta daftar qatori → Excel qatori. O'zgarish jadvaldagidek: balans farqi
 * (bo'lmasa `amount` ning o'zi, u allaqachon ishorali).
 */
export const toFinancialBalanceExportRow = (
  row: Record<string, unknown>,
  actors: Map<string, FinancialActor | null>,
): Record<string, unknown> => {
  const before = Number(row.balance_before);
  const after = Number(row.balance_after);
  const change =
    Number.isFinite(before) && Number.isFinite(after) && before !== after
      ? after - before
      : excelNumber(row.amount);
  const source = asText(row.source_type);
  const createdBy = asText(row.created_by);
  const actor = createdBy ? actors.get(createdBy) : null;
  return {
    id: asText(row.id),
    date: excelDate(row.createdAt ?? row.created_at),
    source: FINANCIAL_SOURCE_LABEL_UZ[source as FinancialSource_type] ?? source,
    change,
    balance_before: excelNumber(row.balance_before),
    balance_after: excelNumber(row.balance_after),
    comment: asText(row.comment),
    created_by: createdBy ? (actor?.name ?? `#${createdBy}`) : 'Avtomatik',
    order_id: asText(row.order_id),
    category: expenseCategoryLabel(row),
  };
};
