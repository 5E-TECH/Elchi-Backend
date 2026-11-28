import { FinancialSource_type } from '../enums';

/**
 * KOMPANIYA FOYDA-ZARAR (P&L) QOIDALARI — `financial_balance_history`
 * (P&L daftari) qatorlarini «Daromad», «Xarajat», «Boshqa kirim» ga ajratish.
 *
 * Yagona manba: investor ulushi (`investor-service`) ham, kelajakdagi tizim
 * bo'yicha «oylik daromad / sof foyda» grafigi ham shu qoidalardan o'qiydi —
 * ikki joyda ikki xil «sof foyda» chiqmasin.
 *
 * BeePost bilan bir xil ma'no (ega 2026-11-28, «Beepostga qarab»):
 *   • DAROMAD (`gross`, BeePost «Yalpi marja») — pochta foydasi, xarajat
 *     ayrilmaydi: sotuv foydasi (`sell_profit` = market tarifi − kuryer
 *     ulushi − hamkor filial ulushi), uning qaytarilishi (`correction`,
 *     `rollback-extra:*` dan tashqari) va pickup haqi (`pickup_fee`).
 *   • XARAJAT (`opex`, musbat son) — qo'lda chiqim (`manual_expense`),
 *     ish haqi (`salary`), kommunal va boshqa hisoblar (`bills`), buyurtma
 *     qo'shimcha xarajati (`sell_extra_cost`, `cancel_extra_cost`) va uning
 *     qaytarilishi (`correction` + `rollback-extra:*`, xarajatni kamaytiradi).
 *     «Balans → Tahlil» xarajat hisobotidagi manbalar bilan bir xil.
 *   • SOF FOYDA (`net`) = daromad − xarajat.
 *   • BOSHQA KIRIM (`other_income`) — qo'lda kirim (`manual_income`, masalan
 *     kassani to'ldirish). Alohida ko'rsatiladi, sof foydaga QO'SHILMAYDI:
 *     ko'pincha bu egasi/investor qo'ygan pul, foyda emas (BeePost ham
 *     hisoblamaydi).
 *   • Investorga foyda to'lovi (`dedup_key` = `investor-profit:<id>`) —
 *     xarajat EMAS, foydaning taqsimoti: umuman hisobga kirmaydi. Aks holda
 *     investorga to'lov uning o'z keyingi ulushini kamaytirardi.
 */

export type ProfitBasis = 'net' | 'gross';

export const PROFIT_BASES: readonly ProfitBasis[] = Object.freeze([
  'net',
  'gross',
]);

export const DEFAULT_PROFIT_BASIS: ProfitBasis = 'net';

export function isProfitBasis(value: unknown): value is ProfitBasis {
  return value === 'net' || value === 'gross';
}

/** Investor foyda to'lovining daftar kaliti (`markProfitPaid`). */
export const INVESTOR_PROFIT_DEDUP_PREFIX = 'investor-profit:';

/** Qo'shimcha xarajat qaytarilishi (`correction`) kaliti. */
const EXTRA_COST_ROLLBACK_PREFIX = 'rollback-extra:';

const GROSS_SOURCES = [
  FinancialSource_type.SELL_PROFIT,
  FinancialSource_type.PICKUP_FEE,
] as const;

const OPEX_SOURCES = [
  FinancialSource_type.MANUAL_EXPENSE,
  FinancialSource_type.SALARY,
  FinancialSource_type.BILLS,
  FinancialSource_type.SELL_EXTRA_COST,
  FinancialSource_type.CANCEL_EXTRA_COST,
] as const;

const list = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * SQL shartlari (`alias` — daftar jadvali taxallusi). Qiymatlar faqat
 * enum'dan, foydalanuvchi matni kirmaydi.
 */
export function pnlSql(alias: string) {
  const source = `${alias}.source_type`;
  const key = `${alias}.dedup_key`;
  const correction = `'${FinancialSource_type.CORRECTION}'`;
  const extraRollback = `${key} LIKE '${EXTRA_COST_ROLLBACK_PREFIX}%'`;
  return {
    /** Daftar qatori P&L ga kiradimi (investor to'lovi — yo'q). */
    included: `${key} NOT LIKE '${INVESTOR_PROFIT_DEDUP_PREFIX}%'`,
    gross: `(${source} IN (${list(GROSS_SOURCES)}) OR (${source} = ${correction} AND NOT (${extraRollback})))`,
    opex: `(${source} IN (${list(OPEX_SOURCES)}) OR (${source} = ${correction} AND ${extraRollback}))`,
    otherIncome: `${source} = '${FinancialSource_type.MANUAL_INCOME}'`,
  };
}

/** Bitta davr (kun `YYYY-MM-DD` yoki oy `YYYY-MM`) bo'yicha P&L. */
export type PnlPoint = {
  period: string;
  /** Daromad (pochta foydasi). */
  gross: number;
  /** Xarajatlar (musbat son; qaytarilish ko'p bo'lsa manfiy bo'lishi mumkin). */
  opex: number;
  /** Sof foyda = gross − opex. */
  net: number;
  /** Qo'lda kirim — sof foydaga kirmaydi. */
  other_income: number;
};

export type PnlGranularity = 'day' | 'month';
