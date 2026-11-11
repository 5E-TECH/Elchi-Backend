import {
  AI_ASSISTANT_TOOL_NAMES,
  AI_ASSISTANT_TOOL_ROLES,
  CASHBOX_RECEIPT_FILTER_STATUSES,
  CASHBOX_RECEIPT_KINDS,
  type AiAssistantRequester,
  type AiAssistantSource,
  type AiAssistantToolName,
  type ClaudeToolCallResult,
  type ClaudeToolDefinition,
} from '@app/common';
import { addDaysYmd, isYmd, tashkentDay } from '../usage/tashkent-day';
import type { AssistantReader } from './assistant-reader';
import { capResultSize, sanitizeForModel } from './assistant-sanitize';

/**
 * F7PWp6cK — AI moliyaviy yordamchining FAQAT O'QIYDIGAN tool'lari (9 ta +
 * T3-4 `get_receipt_checks`).
 *
 * Har tool:
 *  - faqat `AssistantReader` orqali (RMQ oq ro'yxati) mavjud o'qish
 *    handler'larini chaqiradi — yozuvchi buyruq YO'Q;
 *  - payload'ni API'ning SUPERADMIN/ADMIN yo'li bilan AYNAN bir xil quradi
 *    (masalan /finance/history selector'siz → MAIN kassa; analytics —
 *    haqiqiy `requester` bilan, servis o'zi rol bo'yicha kesadi);
 *  - natijani top-N + agregatga qisqartiradi; PII (telefon, izoh, karta
 *    egasi) modelga ketmaydi (`sanitizeForModel`);
 *  - model bergan kirishni QAT'IY tekshiradi (sana, enum, noma'lum kalit).
 */

export interface AssistantToolContext {
  reader: AssistantReader;
  requester: AiAssistantRequester;
  /** Bugungi Toshkent sanasi (YYYY-MM-DD) — sukut davr uchun. */
  today: string;
}

export interface AssistantToolRun {
  data: Record<string, unknown>;
  records: number;
  period: { from: string; to: string } | null;
  truncated: boolean;
}

interface AssistantToolSpec extends ClaudeToolDefinition {
  name: AiAssistantToolName;
  /** Ruxsat etilgan kirish kalitlari (boshqasi — INVALID). */
  keys: readonly string[];
  run(
    input: Record<string, unknown>,
    ctx: AssistantToolContext,
  ): Promise<AssistantToolRun>;
}

/**
 * Bir davr uchun maksimal oraliq — KALENDAR kunlari, ikki chet ham kiradi
 * (`from`..`to` = 366 kun). `GET /finance/history/daily` (MAX_RANGE_DAYS)
 * va analytics oynasi (MAX_ANALYTICS_SPAN_DAYS) bilan bir xil: 367 kunlik
 * davrni history/daily rad etardi, analytics esa boshini jim qisqartirardi.
 */
export const ASSISTANT_MAX_PERIOD_DAYS = 366;
/** Ro'yxatlarda modelga ketadigan maksimal qatorlar. */
export const ASSISTANT_TOP_N = 15;
/**
 * Tarix/xarajat KESIMLARI (manba, to'lov usuli, kategoriya) uchun o'qiladigan
 * maksimal qatorlar. JAMI summalar va sonlar bu chegaraga bog'liq EMAS —
 * ular `finance.history.daily` (SQL SUM) dan olinadi.
 */
export const ASSISTANT_HISTORY_FETCH_LIMIT = 1000;
/** Smena agregati uchun o'qiladigan maksimal smenalar. */
export const ASSISTANT_SHIFT_FETCH_LIMIT = 200;

class ToolInputError extends Error {}

const PERIOD_PROPS = {
  from: {
    type: 'string',
    description:
      'Davr boshi, Toshkent sanasi YYYY-MM-DD (kiradi). Berilmasa — joriy oyning 1-kuni.',
  },
  to: {
    type: 'string',
    description:
      'Davr oxiri, Toshkent sanasi YYYY-MM-DD (kiradi). Berilmasa — bugun.',
  },
} as const;

function num(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = num(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

/** `{statusCode, message, data}` o'ramini ochadi. */
function unwrap(res: unknown): Record<string, unknown> {
  if (res && typeof res === 'object') {
    const data = (res as { data?: unknown }).data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    return res as Record<string, unknown>;
  }
  return {};
}

function arr(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (v): v is Record<string, unknown> => !!v && typeof v === 'object',
      )
    : [];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function monthStart(today: string): string {
  return `${today.slice(0, 8)}01`;
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

function parsePeriod(
  input: Record<string, unknown>,
  today: string,
): { from: string; to: string } {
  const rawFrom = input.from;
  const rawTo = input.to;
  if (rawFrom !== undefined && !isYmd(rawFrom)) {
    throw new ToolInputError('from YYYY-MM-DD formatida bo‘lishi kerak');
  }
  if (rawTo !== undefined && !isYmd(rawTo)) {
    throw new ToolInputError('to YYYY-MM-DD formatida bo‘lishi kerak');
  }
  const to = rawTo ?? today;
  const from = rawFrom ?? monthStart(to);
  if (from > to) throw new ToolInputError('from to dan keyin bo‘lmasin');
  if (to > addDaysYmd(today, 1)) {
    throw new ToolInputError('kelajak sanasi berilmasin');
  }
  if (daysBetween(from, to) + 1 > ASSISTANT_MAX_PERIOD_DAYS) {
    throw new ToolInputError(
      `davr ${ASSISTANT_MAX_PERIOD_DAYS} kundan oshmasin`,
    );
  }
  return { from, to };
}

function enumInput<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = input[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new ToolInputError(`${key}: ${allowed.join(' | ')} dan biri`);
  }
  return v as T;
}

function topByAbs<T>(
  rows: T[],
  value: (row: T) => number,
  n = ASSISTANT_TOP_N,
): T[] {
  return [...rows]
    .sort((a, b) => Math.abs(value(b)) - Math.abs(value(a)))
    .slice(0, n);
}

/**
 * F7PWp6cK (D6) — ishorali balanslar IKKI alohida ro'yxatda: eng katta
 * musbatlar (kamayish tartibida) va eng katta manfiylar (o'sish tartibida —
 * eng manfiysi birinchi). |balans| bo'yicha bitta ro'yxatda katta manfiylar
 * eng katta musbat egalarini siqib chiqarardi.
 *
 * `complete=false` (manba ro'yxati chegaralangan) bo'lsa soni/yig'indi
 * `null` — qisman raqam to'liq deb ko'rsatilmaydi.
 */
function splitBySign<T>(
  rows: T[],
  value: (row: T) => number,
  complete: boolean,
  n = ASSISTANT_TOP_N,
) {
  const positive = rows
    .filter((r) => value(r) > 0)
    .sort((a, b) => value(b) - value(a));
  const negative = rows
    .filter((r) => value(r) < 0)
    .sort((a, b) => value(a) - value(b));
  const total = (list: T[]) => round2(list.reduce((s, r) => s + value(r), 0));
  return {
    positive: positive.slice(0, n),
    negative: negative.slice(0, n),
    positive_count: complete ? positive.length : null,
    negative_count: complete ? negative.length : null,
    positive_total: complete ? total(positive) : null,
    negative_total: complete ? total(negative) : null,
    listTruncated: positive.length > n || negative.length > n,
  };
}

/**
 * F7PWp6cK (D6) — finance kuryer/market ro'yxati to'liq o'qilganmi.
 *
 * finance ro'yxat so'rovi yiqilsa xatoni yutib `{items: [], nonZeroCount: 0,
 * truncated: false}` qaytaradi, imzoli jami esa ALOHIDA SUM so'rovidan keladi.
 * Bo'sh ro'yxat + nol bo'lmagan jami — ro'yxat noma'lum: `nonZero` null,
 * musbat/manfiy soni va yig'indisi null bo'ladi (aniq nol deb
 * ko'rsatilmaydi). Σ ro'yxat = jami deb QAT'IY solishtirilmaydi: SUM va
 * ro'yxat bitta snapshot'dan emas — parallel yozuvda to'liq ro'yxat ham
 * bir necha so'mga farq qilishi mumkin.
 */
function partyListState(
  list: Record<string, unknown>[],
  party: Record<string, unknown>,
  signedTotal: number,
): { nonZero: number | null; complete: boolean } {
  const listFailed = list.length === 0 && Math.abs(signedTotal) >= 0.01;
  if (listFailed) return { nonZero: null, complete: false };
  const nonZero = num(party.nonZeroCount) || list.length;
  // finance ro'yxati ≤500 qator (|balans| bo'yicha) — kesilgan bo'lsa
  // musbat/manfiy soni va yig'indisi noma'lum (null).
  return {
    nonZero,
    complete: party.truncated !== true && list.length >= nonZero,
  };
}

/**
 * UTC ISO satr / epoch ms → Toshkent sanasi (YYYY-MM-DD). Allaqachon
 * YYYY-MM-DD bo'lsa — o'zi; yaroqsiz — `null`. Davr oxiri (23:59:59.999
 * Toshkent = 18:59:59.999Z) shu kunning sanasini beradi.
 */
function toTashkentYmd(value: unknown): string | null {
  if (isYmd(value)) return value;
  let d: Date | null = null;
  if (value instanceof Date) d = value;
  else if (typeof value === 'number') d = new Date(value);
  else if (typeof value === 'string' && value !== '') d = new Date(value);
  return d && !Number.isNaN(d.getTime()) ? tashkentDay(d) : null;
}

/** Obyektdagi ko'rsatilgan sana kalitlarini Toshkent YYYY-MM-DD ga o'giradi. */
function withTashkentDates(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value ?? null;
  }
  const out: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  for (const key of keys) {
    if (key in out) out[key] = toTashkentYmd(out[key]);
  }
  return out;
}

const CASHBOX_TYPES = {
  main: 'main',
  branch: 'branch',
  courier: 'couriers',
  market: 'markets',
} as const;

/** T3-4 — chek turi va holati (finance bilan bitta ro'yxat). */
const RECEIPT_KINDS = CASHBOX_RECEIPT_KINDS;
const RECEIPT_STATUSES = CASHBOX_RECEIPT_FILTER_STATUSES;

const SOURCE_TYPES = [
  'courier_payment',
  'branch_to_main',
  'market_payment',
  'manual_expense',
  'manual_income',
  'correction',
  'salary',
  'sell',
  'cancel',
  'extra_cost',
  'bills',
  // AG1Mlikw (T6) — qaytarilgan to'lovning teskari qatori.
  'payment_reversal',
  // B824gOu5 — pickup tashrifi haqi (market kassasi chiqimi).
  'pickup_fee',
] as const;

/** Qo'lda kiritilgan xarajat — kategoriyasi bor yagona manba turi. */
const MANUAL_EXPENSE = 'manual_expense';
/** Qo'lda xarajatdan BOSHQA manba turlari (market to'lovi, ish haqi, …). */
const NON_MANUAL_SOURCE_TYPES = SOURCE_TYPES.filter(
  (s) => s !== MANUAL_EXPENSE,
);

interface HistoryTotals {
  income: number;
  expense: number;
  income_count: number;
  expense_count: number;
}

/**
 * F7PWp6cK (D5) — davr JAMI summalari va sonlari: `finance.history.daily`
 * (API: GET /finance/history/daily) — SQL SUM, `finance.history.find_all`
 * bilan AYNI WHERE (o'chirilmagan qator, shu turdagi faol kassalar, Toshkent
 * kunlari, operatsiya/manba filtri). Qator chegarasi YO'Q — raqam aniq.
 */
async function readHistoryTotals(
  ctx: AssistantToolContext,
  filters: Record<string, unknown>,
): Promise<HistoryTotals> {
  const res = unwrap(
    await ctx.reader.read('FINANCE', 'finance.history.daily', filters),
  );
  const totals = (res.totals ?? {}) as Record<string, unknown>;
  return {
    income: round2(num(totals.income)),
    expense: round2(num(totals.expense)),
    income_count: num(totals.income_count),
    expense_count: num(totals.expense_count),
  };
}

async function readFinancialBalance(
  ctx: AssistantToolContext,
  includePartyLists: boolean,
): Promise<Record<string, unknown>> {
  // API: GET /finance/cashbox/financial-balanse → `include_party_lists: true`.
  return unwrap(
    await ctx.reader.read('FINANCE', 'finance.cashbox.financial_balance', {
      include_party_lists: includePartyLists,
    }),
  );
}

function historyRow(row: Record<string, unknown>) {
  return {
    id: str(row.id),
    date: str(row.createdAt ?? row.created_at),
    operation_type: str(row.operation_type),
    source_type: str(row.source_type),
    payment_method: str(row.payment_method),
    amount: num(row.amount),
    balance_after: numOrNull(row.balance_after),
  };
}

const TOOL_SPECS: readonly AssistantToolSpec[] = [
  {
    name: 'get_cash_position',
    description:
      "Kompaniyaning JORIY pul holati: asosiy kassa qoldig'i (naqd/karta), kompaniya holati formulasi (asosiy kassa + zanjirdagi qarz + kargo qarzi − marketlarga qarz), " +
      "kartalar/hisob raqamlari qoldiqlari. market_payable — market kassalarining IMZOLI sof yig'indisi (faqat musbatlar yig'indisi — get_market_payables). " +
      '«Kassada qancha pul bor», «umumiy holat» savollarida chaqiring. Davr parametri yo‘q (hozirgi holat).',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    keys: [],
    async run(_input, ctx) {
      const [fb, cardsRes] = await Promise.all([
        readFinancialBalance(ctx, false),
        ctx.reader.read('FINANCE', 'finance.cashbox.cards.list', {
          include_inactive: false,
        }),
      ]);
      const main = (fb.main ?? {}) as Record<string, unknown>;
      const chain = (fb.chain ?? {}) as Record<string, unknown>;
      const cardsData = unwrap(cardsRes);
      const cards = arr(cardsData.cards);
      return {
        data: {
          main_cashbox: {
            balance: num(main.balance),
            balance_cash: num(main.balance_cash),
            balance_card: num(main.balance_card),
          },
          current_situation: num(fb.currentSituation),
          formula: str(fb.formula),
          chain_receivable: num(chain.chainReceivable),
          branch_receivable: num(chain.branchReceivable),
          hq_receivable: num(chain.hqReceivable),
          provider_receivable: num(chain.providerReceivable),
          market_payable: num(
            (fb.markets as Record<string, unknown> | undefined)?.marketPayable,
          ),
          couriers_total_balance: num(
            (fb.couriers as Record<string, unknown> | undefined)
              ?.couriersTotalBalanse,
          ),
          branch_cashbox_total: num(
            (fb.branches as Record<string, unknown> | undefined)
              ?.branchCashboxTotal,
          ),
          cards: cards.slice(0, ASSISTANT_TOP_N).map((c) => ({
            name: str(c.name),
            kind: str(c.kind),
            bank_name: str(c.bank_name),
            last4: str(c.last4),
            balance: num(c.balance),
            is_default: c.is_default === true,
          })),
          cards_total: num(cardsData.total_card ?? cardsData.balance_card),
          cards_in_sync: cardsData.in_sync === true,
        },
        records: 1 + cards.length,
        period: null,
        truncated: cards.length > ASSISTANT_TOP_N,
      };
    },
  },
  {
    name: 'get_cashbox_history',
    description:
      "Kassa harakatlari (kirim/chiqim) davr bo'yicha: jami kirim/chiqim va soni (totals — aniq, qator chegarasiz), manba turi va to'lov usuli kesimi, eng katta 15 operatsiya. " +
      "Kesimlar ko'pi bilan 1000 ta eng yangi qatordan — breakdown_complete=false bo'lsa ular qisman. " +
      "Bitta manba turining ANIQ summasi/soni kerak bo'lsa (masalan kuryer to'lovlari) — shu davr bilan source_type (+operation_type) filtri bilan chaqiring: totals SQL agregatdan, qator chegarasiz. " +
      "Sukut — ASOSIY kassa (API'dagi kabi). " +
      '«Bu hafta kassaga qancha kirdi», «eng katta chiqimlar» savollarida chaqiring.',
    input_schema: {
      type: 'object',
      properties: {
        ...PERIOD_PROPS,
        operation_type: {
          type: 'string',
          enum: ['income', 'expense'],
          description: 'Faqat kirim (income) yoki chiqim (expense).',
        },
        source_type: {
          type: 'string',
          enum: [...SOURCE_TYPES],
          description: 'Manba turi bo‘yicha filtr.',
        },
        cashbox_type: {
          type: 'string',
          enum: Object.keys(CASHBOX_TYPES),
          description:
            'Kassa turi: main (sukut), branch (filial kassalari), courier, market.',
        },
      },
      additionalProperties: false,
    },
    keys: ['from', 'to', 'operation_type', 'source_type', 'cashbox_type'],
    async run(input, ctx) {
      const period = parsePeriod(input, ctx.today);
      const operationType = enumInput(input, 'operation_type', [
        'income',
        'expense',
      ] as const);
      const sourceType = enumInput(input, 'source_type', SOURCE_TYPES);
      const cashboxKey =
        enumInput(
          input,
          'cashbox_type',
          Object.keys(CASHBOX_TYPES) as Array<keyof typeof CASHBOX_TYPES>,
        ) ?? 'main';
      // API'dagi SUPERADMIN/ADMIN payload'i (history va history/daily uchun
      // AYNI filtrlar).
      const filters = {
        cashbox_type: CASHBOX_TYPES[cashboxKey],
        from_date: period.from,
        to_date: period.to,
        ...(operationType ? { operation_type: operationType } : {}),
        ...(sourceType ? { source_type: sourceType } : {}),
      };
      const [totals, rowsRes] = await Promise.all([
        // D5 — jami: SQL SUM (qator chegarasiz).
        readHistoryTotals(ctx, filters),
        // Kesimlar va eng katta operatsiyalar — eng yangi ≤1000 qator.
        ctx.reader.read('FINANCE', 'finance.history.find_all', {
          ...filters,
          page: 1,
          limit: ASSISTANT_HISTORY_FETCH_LIMIT,
        }),
      ]);
      const res = unwrap(rowsRes);
      const items = arr(res.items);
      const pagination = (res.pagination ?? {}) as Record<string, unknown>;
      const total =
        num(pagination.total) ||
        totals.income_count + totals.expense_count ||
        items.length;
      const counts = (res.counts ?? {}) as Record<string, unknown>;
      const bySource = new Map<string, { count: number; amount: number }>();
      const byMethod = new Map<string, { count: number; amount: number }>();
      for (const row of items) {
        const amount = num(row.amount);
        const op = str(row.operation_type);
        const key = `${op ?? '?'}:${str(row.source_type) ?? 'unknown'}`;
        const s = bySource.get(key) ?? { count: 0, amount: 0 };
        s.count += 1;
        s.amount += amount;
        bySource.set(key, s);
        const m = str(row.payment_method) ?? 'unknown';
        const pm = byMethod.get(m) ?? { count: 0, amount: 0 };
        pm.count += 1;
        pm.amount += amount;
        byMethod.set(m, pm);
      }
      return {
        data: {
          cashbox_type: cashboxKey,
          filters: {
            operation_type: operationType ?? null,
            source_type: sourceType ?? null,
          },
          counts: {
            all: num(counts.all),
            income: num(counts.income),
            expense: num(counts.expense),
          },
          // D5 — finance.history.daily (SQL SUM): davrning BARCHA qatorlari.
          totals: {
            income: totals.income,
            expense: totals.expense,
            net: round2(totals.income - totals.expense),
            income_count: totals.income_count,
            expense_count: totals.expense_count,
          },
          totals_complete: true,
          // by_source / by_payment_method / largest — o'qilgan qatorlardan.
          breakdown_complete: items.length >= total,
          breakdown_rows: items.length,
          // F4 — kesim qisman bo'lsa: bitta manba turining aniq summasi
          // filtrli chaqiruvdan (totals — SQL agregat, aniq).
          breakdown_hint:
            items.length < total
              ? `by_source/by_payment_method qisman (eng yangi ${items.length} qator); aniq manba summasi uchun source_type filtri bilan qayta chaqiring — totals aniq`
              : null,
          by_source: [...bySource.entries()]
            .map(([k, v]) => {
              const [operation_type, source_type] = k.split(':');
              return {
                operation_type,
                source_type,
                count: v.count,
                amount: round2(v.amount),
              };
            })
            .sort((a, b) => b.amount - a.amount),
          by_payment_method: [...byMethod.entries()].map(([k, v]) => ({
            payment_method: k,
            count: v.count,
            amount: round2(v.amount),
          })),
          largest: topByAbs(items, (r) => num(r.amount)).map(historyRow),
        },
        records: total,
        period,
        truncated: items.length < total || items.length > ASSISTANT_TOP_N,
      };
    },
  },
  {
    name: 'get_courier_debts',
    description:
      "Kuryerlar qo'lidagi pul (kuryer kassalari): IMZOLI sof jami (couriers_total_balance), nol bo'lmagan kuryerlar soni, " +
      "ALOHIDA ro'yxatlar: top_positive — eng ko'p pul ushlab turganlar (balance > 0, kamayish), top_negative — ortiqcha topshirganlar (balance < 0, eng manfiysi birinchi), " +
      'har biri 15 tagacha, soni va yig‘indisi bilan (ism, naqd/karta). «Kuryerlarda qancha pul qoldi», «qaysi kuryerda ko‘p pul» savollarida chaqiring. Joriy holat (davrsiz).',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    keys: [],
    async run(_input, ctx) {
      const fb = await readFinancialBalance(ctx, true);
      const couriers = (fb.couriers ?? {}) as Record<string, unknown>;
      const list = arr(couriers.allCourierCashboxes);
      const total = num(couriers.couriersTotalBalanse);
      const { nonZero, complete } = partyListState(list, couriers, total);
      const split = splitBySign(list, (r) => num(r.balance), complete);
      const row = (r: Record<string, unknown>) => {
        const user = (r.user ?? {}) as Record<string, unknown>;
        return {
          courier_id: str(r.user_id),
          name: str(user.name),
          region_id: str(user.region_id),
          balance: num(r.balance),
          balance_cash: num(r.balance_cash),
          balance_card: num(r.balance_card),
        };
      };
      return {
        data: {
          // Imzoli sof yig'indi (= /financial-balance couriersTotalBalanse).
          couriers_total_balance: total,
          non_zero_count: nonZero,
          sign_rule:
            "balance > 0 — kuryer qo'lidagi, kompaniyaga topshirishi kerak bo'lgan pul; balance < 0 — kuryer ortiqcha topshirgan",
          positive_count: split.positive_count,
          positive_total: split.positive_total,
          negative_count: split.negative_count,
          negative_total: split.negative_total,
          lists_complete: complete,
          top_positive: split.positive.map(row),
          top_negative: split.negative.map(row),
        },
        records: nonZero ?? 0,
        period: null,
        truncated: split.listTruncated || !complete,
      };
    },
  },
  {
    name: 'get_market_payables',
    description:
      'Marketlar bilan hisob-kitob (market kassalari). balance musbat — marketga qarzmiz, manfiy — market bizga qarzdor. IKKI jami: ' +
      "market_payable_net — IMZOLI sof yig'indi (Moliyaviy holat sahifasi, kompaniya holati formulasi); market_payable_positive_only — faqat musbat qoldiqlar " +
      "(«Barcha kassalar» / To'lovlar sahifasidagi «berilishi kerak» — haqiqatan to'lanadigan summa). ALOHIDA ro'yxatlar: top_positive (biz qarzdor, kamayish) va " +
      "top_negative (market qarzdor, eng manfiysi birinchi), 15 tagacha. «Marketlarga qancha to'lashimiz kerak» savolida chaqiring. Joriy holat.",
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    keys: [],
    async run(_input, ctx) {
      const fb = await readFinancialBalance(ctx, true);
      const markets = (fb.markets ?? {}) as Record<string, unknown>;
      const list = arr(markets.allMarketCashboxes);
      const net = num(markets.marketPayable);
      // Ro'yxat finance'da jami bilan AYNI filtr (faol market kassalari,
      // balans ≠ 0), ≤500 qator: to'liq bo'lsa Σ musbat ===
      // all-info `marketPayableTotal` (SUM(GREATEST(balance, 0))).
      const { nonZero, complete } = partyListState(list, markets, net);
      const split = splitBySign(list, (r) => num(r.balance), complete);
      const row = (r: Record<string, unknown>) => {
        const user = (r.user ?? {}) as Record<string, unknown>;
        return {
          market_id: str(r.user_id),
          name: str(user.name),
          balance: num(r.balance),
        };
      };
      return {
        data: {
          // = /financial-balance marketPayable = all-info marketCashboxTotal.
          market_payable_net: net,
          // = all-info marketPayableTotal (/payments «berilishi kerak»).
          market_payable_positive_only: split.positive_total,
          // Marketlar bizga qarzi (manfiy qoldiqlar, musbat son sifatida).
          markets_owe_us_total:
            split.negative_total === null
              ? null
              : round2(-split.negative_total),
          non_zero_count: nonZero,
          sign_rule:
            'balance > 0 — biz marketga qarzmiz; balance < 0 — market bizga qarzdor; net = positive_only − markets_owe_us_total',
          positive_count: split.positive_count,
          negative_count: split.negative_count,
          lists_complete: complete,
          top_positive: split.positive.map(row),
          top_negative: split.negative.map(row),
        },
        records: nonZero ?? 0,
        period: null,
        truncated: split.listTruncated || !complete,
      };
    },
  },
  {
    name: 'get_branch_settlements',
    description:
      "Filiallar bilan hisob-kitob: filiallardan olinishi kerak summa (IMZOLI jami va filial kesimida, nomi bilan — receivable_positive: filial HQ'ga qarzdor, kamayish; " +
      'receivable_negative: HQ filialga qarzdor, eng manfiysi birinchi), «Filiallar» sahifasidagi olinishi_kerak (≥0), filial kassalaridagi naqd, ' +
      'qarzidan ortiq naqd ushlab turgan filiallar. «Qaysi filial qancha topshirishi kerak» savolida chaqiring. Joriy holat.',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    keys: [],
    async run(_input, ctx) {
      const [fb, branchesRes] = await Promise.all([
        readFinancialBalance(ctx, false),
        // API: GET /branches (SUPERADMIN/ADMIN) — haqiqiy requester bilan.
        ctx.reader.read('BRANCH', 'branch.find_all', {
          requester: { id: ctx.requester.id, roles: ctx.requester.roles },
          query: { status: 'active', page: 1, limit: 1000 },
        }),
      ]);
      const branches = (fb.branches ?? {}) as Record<string, unknown>;
      const branchItems = arr(unwrap(branchesRes).items);
      const names = new Map(
        branchItems.map((b) => [str(b.id) ?? '', b] as const),
      );
      const items = arr(branches.items);
      const excess = arr(branches.cashExceedingPayable);
      const nameOf = (id: unknown) => {
        const b = names.get(str(id) ?? '');
        return b ? str(b.name) : null;
      };
      // Settlement `items` — barcha filiallar (finance cheklamaydi).
      const split = splitBySign(items, (r) => num(r.amount), true);
      const receivableRow = (r: Record<string, unknown>) => ({
        branch_id: str(r.branch_id),
        name: nameOf(r.branch_id),
        amount: num(r.amount),
      });
      const olinishi = branchItems
        .filter((b) => num(b.olinishi_kerak) > 0)
        .sort((a, b) => num(b.olinishi_kerak) - num(a.olinishi_kerak));
      return {
        data: {
          branch_receivable_total: num(branches.branchReceivable),
          branch_cashbox_total: num(branches.branchCashboxTotal),
          active_branches: branchItems.length,
          sign_rule:
            "amount > 0 — filial HQ'ga topshirishi kerak; amount < 0 — HQ filialga qarzdor (hq_qarzi)",
          receivable_positive_count: split.positive_count,
          receivable_positive_total: split.positive_total,
          receivable_negative_count: split.negative_count,
          receivable_negative_total: split.negative_total,
          receivable_positive: split.positive.map(receivableRow),
          receivable_negative: split.negative.map(receivableRow),
          olinishi_kerak_count: olinishi.length,
          olinishi_kerak_by_branch: olinishi
            .slice(0, ASSISTANT_TOP_N)
            .map((b) => ({
              branch_id: str(b.id),
              name: str(b.name),
              type: str(b.type),
              olinishi_kerak: num(b.olinishi_kerak),
            })),
          cash_exceeding_payable: excess.slice(0, ASSISTANT_TOP_N).map((r) => ({
            branch_id: str(r.branch_id),
            name: nameOf(r.branch_id),
            cashbox_balance: num(r.cashbox_balance),
            payable: num(r.payable),
            excess: num(r.excess),
          })),
        },
        records: Math.max(items.length, branchItems.length),
        period: null,
        truncated:
          split.listTruncated ||
          olinishi.length > ASSISTANT_TOP_N ||
          excess.length > ASSISTANT_TOP_N,
      };
    },
  },
  {
    name: 'get_shift_summaries',
    description:
      "Kassa smenalari davr bo'yicha (smena OCHILGAN Toshkent kuni bo'yicha, ikki chet ham kiradi; asosiy va filial kassalari birga): smenalar soni (ochiq/yopiq, " +
      'avtomatik yopilganlar), kamomad (−) va ortiqcha (+) jami (naqd/karta), farqi bor smenalar va eng katta 15 farq. «Smenalarda kamomad bo‘ldimi» savolida chaqiring.',
    input_schema: {
      type: 'object',
      properties: {
        ...PERIOD_PROPS,
        status: {
          type: 'string',
          enum: ['open', 'closed'],
          description: 'Faqat ochiq yoki yopiq smenalar.',
        },
      },
      additionalProperties: false,
    },
    keys: ['from', 'to', 'status'],
    async run(input, ctx) {
      const period = parsePeriod(input, ctx.today);
      const status = enumInput(input, 'status', ['open', 'closed'] as const);
      // API: GET /finance/shift — SUPERADMIN/ADMIN uchun doira yo'q.
      const res = unwrap(
        await ctx.reader.read('FINANCE', 'finance.shift.find_all', {
          from_date: period.from,
          to_date: period.to,
          ...(status ? { status } : {}),
          page: 1,
          limit: ASSISTANT_SHIFT_FETCH_LIMIT,
        }),
      );
      const items = arr(res.items);
      const pagination = (res.pagination ?? {}) as Record<string, unknown>;
      const total = num(pagination.total) || items.length;
      let open = 0;
      let closed = 0;
      let autoClosed = 0;
      let closedWithoutReason = 0;
      const disc = {
        shortage_cash: 0,
        shortage_card: 0,
        surplus_cash: 0,
        surplus_card: 0,
      };
      const withDiff: Array<Record<string, unknown>> = [];
      for (const row of items) {
        const isOpen = str(row.status) === 'open';
        if (isOpen) open += 1;
        else closed += 1;
        // (y8Tqm9Ap) `close_reason`: 'auto' — tizim jadval bo'yicha yopgan;
        // 'manual' — xodim. NULL — ochiq smena yoki ustun paydo bo'lishidan
        // (migratsiya 167) OLDIN yopilgan eski smena: avto deb SANALMAYDI.
        if (row.close_reason === 'auto') autoClosed += 1;
        else if (!isOpen && row.close_reason == null) closedWithoutReason += 1;
        const dc = num(row.discrepancy_cash);
        const dk = num(row.discrepancy_card);
        if (dc < 0) disc.shortage_cash += dc;
        else disc.surplus_cash += dc;
        if (dk < 0) disc.shortage_card += dk;
        else disc.surplus_card += dk;
        if (dc !== 0 || dk !== 0) withDiff.push(row);
      }
      return {
        data: {
          shifts: { total, open, closed },
          // D7 — `close_reason = 'auto'` soni (o'qilgan qatorlar bo'yicha).
          auto_closed: autoClosed,
          // Yopilgan, lekin sababi saqlanmagan eski smenalar (avto emas).
          closed_without_reason: closedWithoutReason,
          discrepancy_totals: {
            shortage_cash: round2(disc.shortage_cash),
            shortage_card: round2(disc.shortage_card),
            surplus_cash: round2(disc.surplus_cash),
            surplus_card: round2(disc.surplus_card),
          },
          shifts_with_discrepancy: withDiff.length,
          largest_discrepancies: topByAbs(
            withDiff,
            (r) =>
              Math.abs(num(r.discrepancy_cash)) +
              Math.abs(num(r.discrepancy_card)),
          ).map((r) => ({
            shift_id: str(r.id),
            cashbox:
              str(r.cashbox_user_id) === '0' || r.cashbox_user_id == null
                ? 'main'
                : `branch:${str(r.cashbox_user_id)}`,
            opened_at: str(r.opened_at),
            closed_at: str(r.closed_at),
            opened_by_name: str(r.opened_by_name),
            closed_by_name: str(r.closed_by_name),
            discrepancy_cash: numOrNull(r.discrepancy_cash),
            discrepancy_card: numOrNull(r.discrepancy_card),
          })),
          totals_complete: items.length >= total,
        },
        records: total,
        period,
        truncated: items.length < total || withDiff.length > ASSISTANT_TOP_N,
      };
    },
  },
  {
    name: 'get_expenses_by_category',
    description:
      "Asosiy kassa CHIQIMLARI davr bo'yicha. total_expense — asosiy kassaning BARCHA chiqimlari (qo'lda xarajatlar HAM, shuningdek market to'lovlari, ish haqi, qaytarishlar va h.k.; total_expense = manual_expense_total + non_manual_expense_total — ularni qayta qo'shmang). " +
      "Qo'lda kiritilgan xarajatlar (manual_expense) alohida: manual_expense_total, kategoriya kesimi by_category (joriy nomlar; o'chirilgan kategoriya '#id', deleted_category=true) " +
      "va manual_uncategorised (kategoriyasiz qo'lda xarajat). Qolgan chiqimlar — non_manual_by_source_type (manba turi bo'yicha) va non_manual_expense_total. " +
      "Jami summalar aniq; kesimlar ko'pi bilan 1000 qatordan (*_complete=false — qisman). «Bu oy nimaga ko'p pul ketdi», «xarajatlar tarkibi» savollarida chaqiring.",
    input_schema: {
      type: 'object',
      properties: { ...PERIOD_PROPS },
      additionalProperties: false,
    },
    keys: ['from', 'to'],
    async run(input, ctx) {
      const period = parsePeriod(input, ctx.today);
      // API: GET /finance/history[/daily]?cashbox_type=main&operation_type=expense
      const base = {
        cashbox_type: 'main',
        operation_type: 'expense',
        from_date: period.from,
        to_date: period.to,
      };
      const [all, manual, manualRes, otherRes, categoriesRes] =
        await Promise.all([
          // D5 — jami summalar SQL SUM (qator chegarasiz, aniq).
          readHistoryTotals(ctx, base),
          readHistoryTotals(ctx, { ...base, source_type: MANUAL_EXPENSE }),
          // D4 — kategoriya kesimi FAQAT qo'lda xarajatlardan (kategoriya
          // faqat manual_expense qatorida bo'ladi).
          ctx.reader.read('FINANCE', 'finance.history.find_all', {
            ...base,
            source_type: MANUAL_EXPENSE,
            page: 1,
            limit: ASSISTANT_HISTORY_FETCH_LIMIT,
          }),
          // Qolgan chiqimlar — manba turi kesimi uchun.
          ctx.reader.read('FINANCE', 'finance.history.find_all', {
            ...base,
            source_types: NON_MANUAL_SOURCE_TYPES.join(','),
            page: 1,
            limit: ASSISTANT_HISTORY_FETCH_LIMIT,
          }),
          ctx.reader.read(
            'FINANCE',
            'finance.cashbox.expense_categories.list',
            {},
          ),
        ]);
      const manualItems = arr(unwrap(manualRes).items);
      const otherItems = arr(unwrap(otherRes).items);
      // Faqat O'CHIRILMAGAN kategoriyalar (API sukuti bilan bir xil).
      const categories = new Map(
        arr(unwrap(categoriesRes).items).map(
          (c) => [str(c.id) ?? '', str(c.name)] as const,
        ),
      );
      const totalExpense = all.expense;
      const manualTotal = manual.expense;
      const nonManualTotal = round2(totalExpense - manualTotal);
      const nonManualCount = Math.max(
        0,
        all.expense_count - manual.expense_count,
      );
      const group = (rows: Array<Record<string, unknown>>, key: string) => {
        const out = new Map<string, { count: number; amount: number }>();
        for (const row of rows) {
          const k = str(row[key]) ?? 'none';
          const g = out.get(k) ?? { count: 0, amount: 0 };
          g.count += 1;
          g.amount += num(row.amount);
          out.set(k, g);
        }
        return out;
      };
      const byCategory = group(manualItems, 'expense_category_id');
      const bySource = group(otherItems, 'source_type');
      const uncategorised = byCategory.get('none') ?? { count: 0, amount: 0 };
      byCategory.delete('none');
      const shareOf = (v: number, of: number) =>
        of > 0 ? round2((v / of) * 100) : 0;
      // Kesimlar to'liqmi: o'qilgan qatorlar soni SQL agregat soniga teng.
      const byCategoryComplete = manualItems.length >= manual.expense_count;
      const bySourceComplete = otherItems.length >= nonManualCount;
      const categoryRows = [...byCategory.entries()]
        .map(([id, v]) => {
          const current = categories.get(id);
          return {
            category_id: id,
            name: current ?? `#${id}`,
            ...(current === undefined ? { deleted_category: true } : {}),
            count: v.count,
            amount: round2(v.amount),
            share_of_manual_percent: shareOf(v.amount, manualTotal),
          };
        })
        .sort((a, b) => b.amount - a.amount);
      return {
        data: {
          // Asosiy kassaning BARCHA chiqimlari (= GET /finance/history/daily
          // ?cashbox_type=main&operation_type=expense → totals.expense).
          total_expense: totalExpense,
          expense_count: all.expense_count,
          total_expense_scope:
            "BARCHA chiqimlar: qo'lda xarajatlar ham, market to'lovi, ish haqi, qaytarish va h.k. ham (= manual_expense_total + non_manual_expense_total)",
          totals_complete: true,
          manual_expense_total: manualTotal,
          manual_expense_count: manual.expense_count,
          by_category: categoryRows.slice(0, ASSISTANT_TOP_N),
          manual_uncategorised: {
            count: uncategorised.count,
            amount: round2(uncategorised.amount),
            share_of_manual_percent: shareOf(uncategorised.amount, manualTotal),
          },
          by_category_complete: byCategoryComplete,
          non_manual_expense_total: nonManualTotal,
          non_manual_expense_count: nonManualCount,
          non_manual_by_source_type: [...bySource.entries()]
            .map(([source_type, v]) => ({
              source_type,
              count: v.count,
              amount: round2(v.amount),
              share_of_non_manual_percent: shareOf(v.amount, nonManualTotal),
            }))
            .sort((a, b) => b.amount - a.amount),
          non_manual_by_source_complete: bySourceComplete,
        },
        records: all.expense_count,
        period,
        truncated:
          !byCategoryComplete ||
          !bySourceComplete ||
          categoryRows.length > ASSISTANT_TOP_N,
      };
    },
  },
  {
    name: 'get_revenue_profit',
    description:
      "Daromad va foyda (P&L) davr bo'yicha: sotuv daromadi va sof foyda (davr seriyasi + jami), kompaniya moliyaviy daftari bo'yicha " +
      "kirim/chiqim manbalar kesimida (foyda, qo'shimcha xarajat, ish haqi, qo'lda kirim/chiqim). «Bu oy foyda qancha» savolida chaqiring.",
    input_schema: {
      type: 'object',
      properties: {
        ...PERIOD_PROPS,
        granularity: {
          type: 'string',
          enum: ['daily', 'weekly', 'monthly'],
          description: 'Seriya bandi (sukut: daily).',
        },
      },
      additionalProperties: false,
    },
    keys: ['from', 'to', 'granularity'],
    async run(input, ctx) {
      const period = parsePeriod(input, ctx.today);
      const granularity =
        enumInput(input, 'granularity', [
          'daily',
          'weekly',
          'monthly',
        ] as const) ?? 'daily';
      const [revenueRes, ledgerRes] = await Promise.all([
        // API: GET /analytics/revenue — servis `requester` bo'yicha tekshiradi.
        ctx.reader.read('ANALYTICS', 'analytics.revenue', {
          requester: {
            id: ctx.requester.id,
            roles: ctx.requester.roles,
            branch_id: ctx.requester.branch_id ?? null,
          },
          filter: {
            startDate: period.from,
            endDate: period.to,
            period: granularity,
          },
        }),
        ctx.reader.read('FINANCE', 'finance.financial_balance.analytics', {
          from_date: period.from,
          to_date: period.to,
        }),
      ]);
      const revenue = unwrap(revenueRes);
      const rows = arr(revenue.data);
      const ledger = unwrap(ledgerRes);
      const impact = (rowsIn: unknown) =>
        arr(rowsIn)
          .slice(0, 10)
          .map((r) => ({
            source_type: str(r.source_type),
            total_amount: num(r.total_amount),
            transaction_count: num(r.transaction_count),
            percentage: num(r.percentage),
          }));
      return {
        data: {
          revenue_summary: sanitizeForModel(revenue.summary ?? null),
          series: rows.slice(-31).map((r) => ({
            period: str(r.label ?? r.period),
            revenue: num(r.revenue),
            profit: num(r.profit),
            // D3 — order-service bandi maydoni `ordersCount` (sotilgan
            // buyurtmalar soni); eski nomlar zaxira sifatida.
            orders: numOrNull(
              r.ordersCount ?? r.orders ?? r.count ?? r.orderCount,
            ),
          })),
          series_total: {
            revenue: round2(rows.reduce((s, r) => s + num(r.revenue), 0)),
            profit: round2(rows.reduce((s, r) => s + num(r.profit), 0)),
          },
          degraded: revenue.degraded === true,
          ledger: {
            summary: sanitizeForModel(ledger.summary ?? null),
            current_balance: sanitizeForModel(ledger.currentBalance ?? null),
            positive_by_source: impact(ledger.positiveImpact),
            negative_by_source: impact(ledger.negativeImpact),
          },
        },
        records:
          rows.length +
          num(
            (ledger.summary as Record<string, unknown> | undefined)?.totalCount,
          ),
        period,
        truncated: rows.length > 31,
      };
    },
  },
  {
    name: 'get_order_flow',
    description:
      "Buyurtmalar oqimi davr bo'yicha (dashboard bilan bir xil): qabul qilingan (yaratilgan sana bo'yicha), sotilgan (sotilgan sana), bekor qilingan (bekor qilingan sana), " +
      'daromad, foyda, oldingi teng davr bilan solishtirish (previous; sanalar Toshkent YYYY-MM-DD). top_markets / top_branches — MUVAFFAQIYAT ULUSHI (success_rate) ' +
      "bo'yicha eng yaxshi 5 market va 5 filial (nomi bilan; hajm bo'yicha EMAS, oynasi — ranking). Hozir yo'ldagi buyurtmalar soni bu tool'da YO'Q. " +
      '«Bu hafta nechta buyurtma sotildi» savolida chaqiring.',
    input_schema: {
      type: 'object',
      properties: { ...PERIOD_PROPS },
      additionalProperties: false,
    },
    keys: ['from', 'to'],
    async run(input, ctx) {
      const period = parsePeriod(input, ctx.today);
      // API: GET /analytics/dashboard — servis `requester` bo'yicha kesadi.
      const res = unwrap(
        await ctx.reader.read('ANALYTICS', 'analytics.dashboard', {
          requester: {
            id: ctx.requester.id,
            roles: ctx.requester.roles,
            branch_id: ctx.requester.branch_id ?? null,
          },
          filter: { startDate: period.from, endDate: period.to },
        }),
      );
      // D2 — reyting qatori aniq proyeksiya bilan: id va NOM (biznes nomi,
      // SA'ga dashboardda ko'rinadi) + sonlar. Ilgari faqat raqamli maydonlar
      // va aynan `name`/`id` kalitlari qolardi — market_name/branch_name,
      // market_id/branch_id tushib qolib, model hech kimni nomlay olmasdi.
      const ranking = (rowsIn: unknown, kind: 'market' | 'branch') =>
        arr(rowsIn)
          .slice(0, 5)
          .map((r) => ({
            [`${kind}_id`]: str(r[`${kind}_id`] ?? r.id),
            name: str(r[`${kind}_name`] ?? r.name),
            total_orders: numOrNull(r.total_orders),
            successful_orders: numOrNull(r.successful_orders),
            success_rate: numOrNull(r.success_rate),
          }));
      const meta = (res.topMarketsMeta ??
        res.topBranchesMeta ??
        null) as Record<string, unknown> | null;
      const orders = res.orders;
      // from/to (epoch ms) va applied_range (UTC ISO) — Toshkent sanasi.
      const ordersOut = withTashkentDates(sanitizeForModel(orders ?? null), [
        'from',
        'to',
      ]) as Record<string, unknown> | null;
      if (ordersOut && ordersOut.applied_range) {
        ordersOut.applied_range = withTashkentDates(ordersOut.applied_range, [
          'requested_from',
          'requested_to',
          'applied_from',
          'applied_to',
        ]);
      }
      return {
        data: {
          orders: ordersOut,
          // previous.from/to — UTC ISO edi (masalan 2026-10-25T19:00:00Z =
          // 26-oktabr Toshkent) → Toshkent YYYY-MM-DD.
          previous: withTashkentDates(sanitizeForModel(res.previous ?? null), [
            'from',
            'to',
          ]),
          top_markets: ranking(res.topMarkets, 'market'),
          top_branches: ranking(res.topBranches, 'branch'),
          ranking: {
            sorted_by:
              "success_rate (muvaffaqiyat ulushi, %) kamayish, teng bo'lsa total_orders — hajm bo'yicha EMAS",
            // Bitta Toshkent kuni so'ralsa — oxirgi 30 kun (last_30_days).
            window_rule: meta ? str(meta.period_rule) : null,
            window_from: meta ? toTashkentYmd(meta.from) : null,
            window_to: meta ? toTashkentYmd(meta.to) : null,
          },
          degraded: res.degraded === true,
        },
        records: (() => {
          const o = (orders ?? {}) as Record<string, unknown>;
          return num(o.total ?? o.totalOrders ?? o.acceptedCount ?? o.accepted);
        })(),
        period,
        truncated: false,
      };
    },
  },
  {
    name: 'get_receipt_checks',
    description:
      "Kassa CHEKLARI tekshiruvi (karta bilan qo'lda chiqim, kuryer → HQ va filial → HQ click o'tkazmalari; naqdda chek yo'q) davr bo'yicha: AI holati soni " +
      '(match — summa mos, mismatch — farq bor, unreadable, pending, error, disabled, none — chek so‘raladigan, lekin yuklanmagan), ' +
      "farqlar yig'indisi (Σ|farq|), filial va xarajat kategoriyasi kesimi, eng katta farqli 15 chek. «Cheklar mosmi», «qaysi chiqimda chek yo'q» savollarida chaqiring.",
    input_schema: {
      type: 'object',
      properties: {
        ...PERIOD_PROPS,
        kind: {
          type: 'string',
          enum: [...RECEIPT_KINDS],
          description: 'Operatsiya turi (berilmasa — hammasi).',
        },
        ai_status: {
          type: 'string',
          enum: [...RECEIPT_STATUSES],
          description: 'Faqat shu holat (berilmasa — hammasi).',
        },
      },
      additionalProperties: false,
    },
    keys: ['from', 'to', 'kind', 'ai_status'],
    async run(input, ctx) {
      const period = parsePeriod(input, ctx.today);
      const kind = enumInput(input, 'kind', RECEIPT_KINDS);
      const aiStatus = enumInput(input, 'ai_status', RECEIPT_STATUSES);
      // API: GET /finance/receipts/summary — servis rolni qayta tekshiradi.
      const res = unwrap(
        await ctx.reader.read('FINANCE', 'finance.receipt_checks.summary', {
          from: period.from,
          to: period.to,
          ...(kind ? { kind } : {}),
          ...(aiStatus ? { ai_status: aiStatus } : {}),
          requester_roles: ctx.requester.roles,
        }),
      );
      const counts = (c: unknown) => {
        const row = (c ?? {}) as Record<string, unknown>;
        return Object.fromEntries(
          RECEIPT_STATUSES.map((status) => [status, num(row[status])]),
        );
      };
      const branches = arr(res.by_branch);
      const categories = arr(res.by_category);
      const top = arr(res.top);
      return {
        data: {
          counts: counts(res.counts),
          total: num(res.total),
          mismatch_total: num(res.mismatch_total),
          by_branch: branches.slice(0, ASSISTANT_TOP_N).map((b) => ({
            branch_id: str(b.branch_id),
            counts: counts(b.counts),
          })),
          by_category: categories.slice(0, ASSISTANT_TOP_N).map((c) => ({
            expense_category_id: str(c.expense_category_id),
            name: str(c.name),
            counts: counts(c.counts),
          })),
          largest_differences: top.slice(0, ASSISTANT_TOP_N).map((t) => ({
            receipt_id: str(t.receipt_id),
            history_id: str(t.history_id),
            kind: str(t.kind),
            entered_amount: numOrNull(t.entered_amount),
            difference: num(t.difference),
            date: str(t.date),
          })),
        },
        records: num(res.total),
        period,
        truncated:
          branches.length > ASSISTANT_TOP_N ||
          categories.length > ASSISTANT_TOP_N,
      };
    },
  },
];

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((s) => [s.name, s] as const));

/** Model ko'radigan tool ro'yxati (rol bo'yicha filtr, tartib DOIM bir xil). */
export function assistantToolDefinitions(
  roles: readonly string[],
): ClaudeToolDefinition[] {
  const set = new Set(roles.map((r) => String(r).toLowerCase()));
  return AI_ASSISTANT_TOOL_NAMES.filter((name) =>
    AI_ASSISTANT_TOOL_ROLES[name].some((r) => set.has(r)),
  ).map((name) => {
    const spec = SPEC_BY_NAME.get(name)!;
    return {
      name: spec.name,
      description: spec.description,
      input_schema: spec.input_schema,
    };
  });
}

/** Testlar uchun: barcha spec nomlari. */
export function assistantToolSpecNames(): string[] {
  return TOOL_SPECS.map((s) => s.name);
}

export interface AssistantToolExecution {
  result: ClaudeToolCallResult;
  source: AiAssistantSource | null;
  /** Audit uchun normallashtirilgan kirish. */
  input: Record<string, unknown>;
  records: number;
  /** Ichki xato (faqat logga — modelga ketmaydi). */
  failure?: string;
}

/**
 * Model so'ragan tool'ni bajaradi. HECH QACHON throw qilmaydi.
 *  - oq ro'yxatda yo'q nom / ruxsatsiz rol → is_error (o'qish YO'Q);
 *  - sxemaga mos bo'lmagan kirish → is_error `INVALID_JSON` (eager streaming);
 *  - RMQ xatosi → is_error `tool_failed` (xato matni modelga ketmaydi).
 */
export async function executeAssistantTool(
  name: string,
  rawInput: unknown,
  ctx: AssistantToolContext,
): Promise<AssistantToolExecution> {
  const spec = SPEC_BY_NAME.get(name as AiAssistantToolName);
  const roles = new Set(
    ctx.requester.roles.map((r) => String(r).toLowerCase()),
  );
  if (!spec || !AI_ASSISTANT_TOOL_ROLES[spec.name].some((r) => roles.has(r))) {
    return {
      result: {
        content: JSON.stringify({
          error: 'unknown_tool',
          tool: String(name).slice(0, 64),
        }),
        isError: true,
      },
      source: null,
      input: {},
      records: 0,
    };
  }
  const input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : null;
  const unknownKey = input
    ? Object.keys(input).find((k) => !spec.keys.includes(k))
    : undefined;
  if (!input || unknownKey) {
    return {
      result: {
        content: JSON.stringify({
          INVALID_JSON: JSON.stringify(rawInput ?? null).slice(0, 500),
        }),
        isError: true,
      },
      source: {
        tool: spec.name,
        period: null,
        records: 0,
        truncated: false,
        ok: false,
      },
      input: {},
      records: 0,
    };
  }
  try {
    const run = await spec.run(input, ctx);
    const sanitized = sanitizeForModel(run.data) as Record<string, unknown>;
    const capped = capResultSize(sanitized);
    const truncated = run.truncated || capped.truncated;
    return {
      result: {
        content: JSON.stringify({
          tool: spec.name,
          period: run.period,
          records: run.records,
          truncated,
          data: capped.data,
        }),
        isError: false,
      },
      source: {
        tool: spec.name,
        period: run.period,
        records: run.records,
        truncated,
        ok: true,
      },
      input,
      records: run.records,
    };
  } catch (err) {
    const invalid = err instanceof ToolInputError;
    const failure = invalid
      ? undefined
      : err instanceof Error
        ? `${err.name}: ${err.message}`.slice(0, 300)
        : 'non-error throw';
    return {
      failure,
      result: {
        content: JSON.stringify(
          invalid
            ? { error: 'invalid_input', message: err.message }
            : { error: 'tool_failed', message: "Ma'lumot olinmadi" },
        ),
        isError: true,
      },
      source: {
        tool: spec.name,
        period: null,
        records: 0,
        truncated: false,
        ok: false,
      },
      input,
      records: 0,
    };
  }
}
