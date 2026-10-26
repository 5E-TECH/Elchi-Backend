import {
  AI_ASSISTANT_TOOL_NAMES,
  AI_ASSISTANT_TOOL_ROLES,
  type AiAssistantRequester,
  type AiAssistantSource,
  type AiAssistantToolName,
  type ClaudeToolCallResult,
  type ClaudeToolDefinition,
} from '@app/common';
import { addDaysYmd, isYmd } from '../usage/tashkent-day';
import type { AssistantReader } from './assistant-reader';
import { capResultSize, sanitizeForModel } from './assistant-sanitize';

/**
 * F7PWp6cK — AI moliyaviy yordamchining 9 ta FAQAT O'QIYDIGAN tool'i.
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

/** Bir davr uchun maksimal oraliq (kun) — dashboard «Barchasi» bilan bir xil. */
export const ASSISTANT_MAX_PERIOD_DAYS = 366;
/** Ro'yxatlarda modelga ketadigan maksimal qatorlar. */
export const ASSISTANT_TOP_N = 15;
/** Tarix/xarajat agregati uchun o'qiladigan maksimal qatorlar. */
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
  if (daysBetween(from, to) > ASSISTANT_MAX_PERIOD_DAYS) {
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

const CASHBOX_TYPES = {
  main: 'main',
  branch: 'branch',
  courier: 'couriers',
  market: 'markets',
} as const;

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
] as const;

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
      'kartalar/hisob raqamlari qoldiqlari. «Kassada qancha pul bor», «umumiy holat» savollarida chaqiring. Davr parametri yo‘q (hozirgi holat).',
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
      "Kassa harakatlari (kirim/chiqim) davr bo'yicha: jami kirim/chiqim, manba turi va to'lov usuli kesimi, eng katta 15 operatsiya. " +
      "Sukut — ASOSIY kassa (API'dagi kabi). «Bu hafta kassaga qancha kirdi», «eng katta chiqimlar» savollarida chaqiring.",
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
      const res = unwrap(
        await ctx.reader.read('FINANCE', 'finance.history.find_all', {
          cashbox_type: CASHBOX_TYPES[cashboxKey],
          from_date: period.from,
          to_date: period.to,
          ...(operationType ? { operation_type: operationType } : {}),
          ...(sourceType ? { source_type: sourceType } : {}),
          page: 1,
          limit: ASSISTANT_HISTORY_FETCH_LIMIT,
        }),
      );
      const items = arr(res.items);
      const pagination = (res.pagination ?? {}) as Record<string, unknown>;
      const total = num(pagination.total) || items.length;
      const counts = (res.counts ?? {}) as Record<string, unknown>;
      const sums = { income: 0, expense: 0 };
      const bySource = new Map<string, { count: number; amount: number }>();
      const byMethod = new Map<string, { count: number; amount: number }>();
      for (const row of items) {
        const amount = num(row.amount);
        const op = str(row.operation_type);
        if (op === 'income') sums.income += amount;
        else if (op === 'expense') sums.expense += amount;
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
          totals: {
            income: round2(sums.income),
            expense: round2(sums.expense),
            net: round2(sums.income - sums.expense),
          },
          totals_complete: items.length >= total,
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
      "Kuryerlar qo'lidagi pul (kuryer kassalari): jami summa, nol bo'lmagan kuryerlar soni va eng katta 15 tasi (ism, summa naqd/karta). " +
      '«Kuryerlarda qancha pul qoldi», «qaysi kuryer ko‘p qarzdor» savollarida chaqiring. Joriy holat (davrsiz).',
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
      const nonZero = num(couriers.nonZeroCount) || list.length;
      return {
        data: {
          couriers_total_balance: num(couriers.couriersTotalBalanse),
          non_zero_count: nonZero,
          top: topByAbs(list, (r) => num(r.balance)).map((r) => {
            const user = (r.user ?? {}) as Record<string, unknown>;
            return {
              courier_id: str(r.user_id),
              name: str(user.name),
              region_id: str(user.region_id),
              balance: num(r.balance),
              balance_cash: num(r.balance_cash),
              balance_card: num(r.balance_card),
            };
          }),
        },
        records: nonZero,
        period: null,
        truncated: nonZero > ASSISTANT_TOP_N || couriers.truncated === true,
      };
    },
  },
  {
    name: 'get_market_payables',
    description:
      'Marketlar bilan hisob-kitob (market kassalari): jami «marketlarga berilishi kerak» summa va eng katta 15 market. ' +
      "balance musbat — marketga qarzmiz, manfiy — market bizga qarzdor. «Marketlarga qancha to'lashimiz kerak» savolida chaqiring. Joriy holat.",
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
      const nonZero = num(markets.nonZeroCount) || list.length;
      return {
        data: {
          market_payable_total: num(markets.marketPayable),
          non_zero_count: nonZero,
          top: topByAbs(list, (r) => num(r.balance)).map((r) => {
            const user = (r.user ?? {}) as Record<string, unknown>;
            return {
              market_id: str(r.user_id),
              name: str(user.name),
              balance: num(r.balance),
            };
          }),
        },
        records: nonZero,
        period: null,
        truncated: nonZero > ASSISTANT_TOP_N || markets.truncated === true,
      };
    },
  },
  {
    name: 'get_branch_settlements',
    description:
      'Filiallar bilan hisob-kitob: filiallardan olinishi kerak summa (jami va filial kesimida, nomi bilan), filial kassalaridagi naqd, ' +
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
      return {
        data: {
          branch_receivable_total: num(branches.branchReceivable),
          branch_cashbox_total: num(branches.branchCashboxTotal),
          active_branches: branchItems.length,
          receivable_by_branch: topByAbs(items, (r) => num(r.amount)).map(
            (r) => ({
              branch_id: str(r.branch_id),
              name: nameOf(r.branch_id),
              amount: num(r.amount),
            }),
          ),
          olinishi_kerak_by_branch: topByAbs(branchItems, (b) =>
            num(b.olinishi_kerak),
          ).map((b) => ({
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
          items.length > ASSISTANT_TOP_N ||
          branchItems.length > ASSISTANT_TOP_N,
      };
    },
  },
  {
    name: 'get_shift_summaries',
    description:
      "Kassa smenalari davr bo'yicha: smenalar soni (ochiq/yopiq), kamomad (−) va ortiqcha (+) jami (naqd/karta), farqi bor smenalar va eng katta 15 farq. " +
      '«Smenalarda kamomad bo‘ldimi» savolida chaqiring.',
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
      let autoKnown = false;
      const disc = {
        shortage_cash: 0,
        shortage_card: 0,
        surplus_cash: 0,
        surplus_card: 0,
      };
      const withDiff: Array<Record<string, unknown>> = [];
      for (const row of items) {
        if (str(row.status) === 'open') open += 1;
        else closed += 1;
        if ('close_reason' in row || 'auto_closed' in row) {
          autoKnown = true;
          if (row.close_reason === 'auto' || row.auto_closed === true) {
            autoClosed += 1;
          }
        }
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
          // Smena jadvali hozircha avtomatik yopilish belgisini saqlamaydi —
          // ma'lumot bo'lmasa `null` (taxmin qilinmaydi).
          auto_closed: autoKnown ? autoClosed : null,
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
      "Asosiy kassa CHIQIMLARI davr bo'yicha xarajat kategoriyasi kesimida (jami, soni, ulushi %) va manba turi kesimida. " +
      '«Bu oy nimaga ko‘p pul ketdi», «xarajatlar tarkibi» savollarida chaqiring.',
    input_schema: {
      type: 'object',
      properties: { ...PERIOD_PROPS },
      additionalProperties: false,
    },
    keys: ['from', 'to'],
    async run(input, ctx) {
      const period = parsePeriod(input, ctx.today);
      const [historyRes, categoriesRes] = await Promise.all([
        ctx.reader.read('FINANCE', 'finance.history.find_all', {
          cashbox_type: 'main',
          operation_type: 'expense',
          from_date: period.from,
          to_date: period.to,
          page: 1,
          limit: ASSISTANT_HISTORY_FETCH_LIMIT,
        }),
        ctx.reader.read(
          'FINANCE',
          'finance.cashbox.expense_categories.list',
          {},
        ),
      ]);
      const res = unwrap(historyRes);
      const items = arr(res.items);
      const pagination = (res.pagination ?? {}) as Record<string, unknown>;
      const total = num(pagination.total) || items.length;
      const categories = new Map(
        arr(unwrap(categoriesRes).items).map(
          (c) => [str(c.id) ?? '', str(c.name)] as const,
        ),
      );
      let sum = 0;
      const byCategory = new Map<string, { count: number; amount: number }>();
      const bySource = new Map<string, { count: number; amount: number }>();
      for (const row of items) {
        const amount = num(row.amount);
        sum += amount;
        const cat = str(row.expense_category_id) ?? 'none';
        const c = byCategory.get(cat) ?? { count: 0, amount: 0 };
        c.count += 1;
        c.amount += amount;
        byCategory.set(cat, c);
        const src = str(row.source_type) ?? 'unknown';
        const s = bySource.get(src) ?? { count: 0, amount: 0 };
        s.count += 1;
        s.amount += amount;
        bySource.set(src, s);
      }
      const share = (v: number) => (sum > 0 ? round2((v / sum) * 100) : 0);
      return {
        data: {
          total_expense: round2(sum),
          expense_count: items.length,
          totals_complete: items.length >= total,
          by_category: [...byCategory.entries()]
            .map(([id, v]) => ({
              category_id: id === 'none' ? null : id,
              name:
                id === 'none'
                  ? 'Kategoriyasiz'
                  : (categories.get(id) ?? `#${id}`),
              count: v.count,
              amount: round2(v.amount),
              share_percent: share(v.amount),
            }))
            .sort((a, b) => b.amount - a.amount)
            .slice(0, ASSISTANT_TOP_N),
          by_source_type: [...bySource.entries()]
            .map(([source_type, v]) => ({
              source_type,
              count: v.count,
              amount: round2(v.amount),
              share_percent: share(v.amount),
            }))
            .sort((a, b) => b.amount - a.amount),
        },
        records: total,
        period,
        truncated: items.length < total || byCategory.size > ASSISTANT_TOP_N,
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
            orders: numOrNull(r.orders ?? r.count ?? r.orderCount),
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
      "Buyurtmalar oqimi davr bo'yicha (dashboard bilan bir xil): qabul qilingan, sotilgan, bekor qilingan, yo'ldagi buyurtmalar, daromad, " +
      'oldingi davr bilan solishtirish, eng faol 5 market va 5 filial. «Bu hafta nechta buyurtma sotildi» savolida chaqiring.',
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
      const ranking = (rowsIn: unknown) =>
        arr(rowsIn)
          .slice(0, 5)
          .map((r) => {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(r)) {
              if (typeof v === 'number' || k === 'name' || k === 'id') {
                out[k] = v;
              }
            }
            return out;
          });
      const orders = res.orders;
      return {
        data: {
          orders: sanitizeForModel(orders ?? null),
          previous: sanitizeForModel(res.previous ?? null),
          top_markets: ranking(res.topMarkets),
          top_branches: ranking(res.topBranches),
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
