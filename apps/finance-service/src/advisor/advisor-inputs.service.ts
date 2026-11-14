import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  TASHKENT_OFFSET_MINUTES,
  rmqSend,
  type AiAdvisorCandidate,
  type AiAdvisorCashboxRef,
  type AiAdvisorRef,
  type AiAdvisorRuleInputsRequest,
  type AiAdvisorRuleInputsResponse,
} from '@app/common';
import { FinanceDailyService } from '../aggregates/finance-daily.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxExpenseCategory } from '../entities/cashbox-expense-category.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { Shift } from '../entities/shift.entity';

/**
 * BE-5 (LhTIno57) — `finance.advisor.rule_inputs`: AI maslahatchi
 * qoidalari uchun FAQAT O'QIYDIGAN agregatlar (API shartnomasi §4.4).
 *
 * - Hech narsa yozmaydi; barcha chegara solishtiruvi SQL `numeric` da.
 * - Kun chegaralari Asia/Tashkent (`AT TIME ZONE`), «oxirgi …» — `createdAt`.
 * - Ism snapshotlari shu yerda (IDENTITY/BRANCH mijozlari finance'da bor);
 *   ism olinmasa `name: null` (FE «#id» ko'rsatadi) — xato emas.
 * - Telefon va boshqa PII qaytarilmaydi.
 */
export const ADVISOR_EVIDENCE_LIMIT = 15;
/** R1: bitta tekshiruvda ko'riladigan yangi smenalar chegarasi. */
const R1_MAX_NEW_SHIFTS = 2_000;
/** R3: bitta tekshiruvda ko'riladigan yangi qo'lda chiqimlar chegarasi. */
const R3_MAX_NEW_ROWS = 2_000;
/** R3: statistika oynasi (kun) va minimal namuna (Q18). */
export const R3_WINDOW_DAYS = 30;
export const R3_MIN_SAMPLE = 5;
/** BQ9 (ega): minimal MAD = mediana × 5%. */
export const R3_MIN_MAD_RATIO = 0.05;

const NAME_TIMEOUT_MS = 5_000;
const SYSTEM_BRANCH_REQUESTER = { id: 'system', roles: ['superadmin'] };
const MAIN_CASHBOX_NAME = 'Asosiy kassa';

const money = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const moneyOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : money(v);
const iso = (v: unknown): string => new Date(v as string).toISOString();
const isId = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{1,18}$/.test(v);

/** Toshkent kalendar kuni `YYYY-MM-DD`. */
export function tashkentDateKey(date: Date): string {
  return new Date(date.getTime() + TASHKENT_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 10);
}

/** `YYYY-MM-DD` + n kun. */
export function addDaysKey(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

interface ShiftRow {
  id: string;
  owner: string;
  closed_at: Date;
  closed_by: string | null;
  closed_by_system: boolean;
  expected_balance_cash: string | null;
  expected_balance_card: string | null;
  discrepancy_cash: string | null;
  discrepancy_card: string | null;
  difference: string;
  is_short: boolean;
  is_negative: boolean;
}

interface R3Row {
  id: string;
  amount: string;
  createdAt: Date;
  cashbox_id: string;
  cashbox_type: string;
  owner: string;
  category_id: string;
  category_name: string | null;
  created_by: string | null;
  scope: 'category_branch' | 'category';
  sample_size: number;
  median: number;
  mad: number;
  threshold: string;
}

@Injectable()
export class AdvisorInputsService {
  private readonly logger = new Logger(AdvisorInputsService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly daily: FinanceDailyService,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Optional() @Inject('BRANCH') private readonly branchClient?: ClientProxy,
  ) {}

  /** Jadval yo'llari entity metadata'sidan (sxema bilan). */
  private tables() {
    const path = (entity: Parameters<DataSource['getMetadata']>[0]) =>
      this.ds
        .getMetadata(entity)
        .tablePath.split('.')
        .map((part) => `"${part.replace(/"/g, '""')}"`)
        .join('.');
    return {
      shifts: path(Shift),
      history: path(CashboxHistory),
      cashboxes: path(Cashbox),
      categories: path(CashboxExpenseCategory),
    };
  }

  async ruleInputs(
    input: AiAdvisorRuleInputsRequest,
  ): Promise<AiAdvisorRuleInputsResponse> {
    const now = new Date(input?.now ?? Date.now());
    if (Number.isNaN(now.getTime())) throw new Error('now noto‘g‘ri');
    const rules = new Set(Array.isArray(input?.rules) ? input.rules : []);
    const out: AiAdvisorRuleInputsResponse = { candidates: [], cursors: {} };
    const names = new NameCache(this);

    if (rules.has('R1')) {
      const t = input.thresholds?.R1 ?? {};
      const since = parseSince(input.since?.R1, now);
      const r = await this.r1(since, now, t, names);
      out.candidates.push(...r.candidates);
      out.cursors.R1 = r.cursor;
    }
    if (rules.has('R3')) {
      const t = input.thresholds?.R3 ?? {};
      const since = parseSince(input.since?.R3, now);
      const r = await this.r3(since, now, t, names);
      out.candidates.push(...r.candidates);
      out.cursors.R3 = r.cursor;
    }
    if (rules.has('R6')) {
      out.candidates.push(...(await this.r6(input.periods ?? {}, now)));
    }
    await names.fill(out.candidates);
    return out;
  }

  // ─── R1 Smena kamomadi (§4.2) ─────────────────────────────────────────

  private async r1(
    since: Date,
    now: Date,
    t: Record<string, number>,
    names: NameCache,
  ): Promise<{ candidates: AiAdvisorCandidate[]; cursor: string | null }> {
    const shortage = positive(t.shortage_uzs, 50_000);
    const streakLen = Math.max(
      2,
      Math.floor(positive(t.consecutive_negative, 3)),
    );
    const select = `
      SELECT s."id"::text AS id,
             COALESCE(s."cashbox_user_id", 0)::text AS owner,
             s."closed_at", s."closed_by"::text AS closed_by, s."closed_by_system",
             s."expected_balance_cash", s."expected_balance_card",
             s."discrepancy_cash", s."discrepancy_card",
             (COALESCE(s."discrepancy_cash", 0) + COALESCE(s."discrepancy_card", 0)) AS difference,
             (COALESCE(s."discrepancy_cash", 0) + COALESCE(s."discrepancy_card", 0)) < -($1::numeric) AS is_short,
             (COALESCE(s."discrepancy_cash", 0) + COALESCE(s."discrepancy_card", 0)) < 0 AS is_negative
        FROM ${this.tables().shifts} s`;
    // Mos smena: yopilgan, kamida bitta qismi sanalgan (avtomatik yopilgan —
    // ikkalasi NULL — o'tkaziladi, ketma-ketlikni na uzaytiradi, na uzadi).
    const eligible = `s."status" = 'closed' AND s."is_deleted" = false
        AND (s."discrepancy_cash" IS NOT NULL OR s."discrepancy_card" IS NOT NULL)`;
    const fresh = await this.ds.query<ShiftRow[]>(
      `${select}
        WHERE ${eligible} AND s."closed_at" >= $2 AND s."closed_at" <= $3
        ORDER BY s."closed_at" ASC, s."id" ASC
        LIMIT ${R1_MAX_NEW_SHIFTS}`,
      [shortage, since, now],
    );
    if (!fresh.length) return { candidates: [], cursor: null };
    const cursor = iso(fresh[fresh.length - 1].closed_at);
    const owners = [...new Set(fresh.map((r) => r.owner))];
    const recent = await this.ds.query<Array<ShiftRow & { rn: string }>>(
      `SELECT * FROM (
         ${select.replace('SELECT', 'SELECT ROW_NUMBER() OVER (PARTITION BY COALESCE(s."cashbox_user_id", 0) ORDER BY s."closed_at" DESC, s."id" DESC) AS rn,')}
          WHERE ${eligible} AND s."closed_at" <= $2
            AND COALESCE(s."cashbox_user_id", 0)::text = ANY($3::text[])
       ) x WHERE x.rn <= $4
       ORDER BY x.owner, x."closed_at" ASC, x.id ASC`,
      [shortage, now, owners, streakLen],
    );
    const types = await this.cashboxTypes(owners);

    const candidates: AiAdvisorCandidate[] = [];
    for (const owner of owners) {
      const freshIds = new Set(
        fresh.filter((r) => r.owner === owner).map((r) => r.id),
      );
      const singles = fresh.filter((r) => r.owner === owner && r.is_short);
      const lastN = recent.filter((r) => r.owner === owner);
      const streak =
        lastN.length === streakLen &&
        lastN.every((r) => r.is_negative) &&
        lastN.some((r) => freshIds.has(r.id));
      const byId = new Map<string, ShiftRow>();
      for (const r of singles) byId.set(r.id, r);
      if (streak) for (const r of lastN) byId.set(r.id, r);
      if (!byId.size) continue;
      const shifts = [...byId.values()].sort(
        (a, b) =>
          +new Date(a.closed_at) - +new Date(b.closed_at) || cmpId(a.id, b.id),
      );
      const last = shifts[shifts.length - 1];
      const total = money(
        shifts.reduce((sum, r) => sum + Number(r.difference), 0),
      );
      const lastDiff = money(last.difference);
      const trigger = streak ? 'consecutive_negative' : 'single_shortage';
      const cashbox = cashboxRef(owner, types.get(owner));
      const branch: AiAdvisorRef | null =
        cashbox.type === 'branch' ? { id: owner, name: null } : null;
      const closedBy = [
        ...new Set(shifts.map((r) => r.closed_by).filter(isId)),
      ].slice(0, 5);
      for (const id of closedBy) names.wantUser(id);
      if (branch) names.wantBranch(branch.id);
      candidates.push({
        rule_key: 'R1',
        dedup_key: `R1:cashbox:${owner}`,
        fact_keys: shifts.map((r) => ({
          fact_key: r.id,
          fact_at: iso(r.closed_at),
        })),
        branch,
        subject: { kind: 'cashbox', id: owner, name: null },
        headline_amount: trigger === 'single_shortage' ? lastDiff : total,
        facts: {
          trigger,
          cashbox,
          branch,
          shifts_count: shifts.length,
          total_difference: total,
          last_difference: lastDiff,
          closed_by: closedBy.map((id) => ({ id, name: null })),
          last_shift_id: last.id,
        },
        evidence: {
          kind: 'shifts',
          total_rows: shifts.length,
          truncated: shifts.length > ADVISOR_EVIDENCE_LIMIT,
          rows: shifts.slice(-ADVISOR_EVIDENCE_LIMIT).map(shiftEvidenceRow),
          totals: { count: shifts.length, difference: total },
        },
      });
    }
    return { candidates, cursor };
  }

  // ─── R3 G'ayrioddiy xarajat (§4.2, BQ9, Q18, Q24) ─────────────────────

  private async r3(
    since: Date,
    now: Date,
    t: Record<string, number>,
    names: NameCache,
  ): Promise<{ candidates: AiAdvisorCandidate[]; cursor: string | null }> {
    const k = positive(t.mad_multiplier, 3);
    const fresh = await this.ds.query<Array<{ id: string; createdAt: Date }>>(
      `SELECT h."id"::text AS id, h."createdAt"
         FROM ${this.tables().history} h
        WHERE h."source_type" = 'manual_expense' AND h."operation_type" = 'expense'
          AND h."is_deleted" = false AND h."expense_category_id" IS NOT NULL
          AND h."createdAt" >= $1 AND h."createdAt" <= $2
        ORDER BY h."createdAt" ASC, h."id" ASC
        LIMIT ${R3_MAX_NEW_ROWS}`,
      [since, now],
    );
    if (!fresh.length) return { candidates: [], cursor: null };
    const cursor = iso(fresh[fresh.length - 1].createdAt);
    // Har yangi qator uchun oldingi 30 kun statistikasi (joriy qatorsiz):
    // avval shu kassa + kategoriya, namuna < 5 bo'lsa butun tizim + kategoriya.
    const window = (scopeCashbox: boolean) => `
      SELECT ABS(w."amount") AS a FROM ${this.tables().history} w
       WHERE w."source_type" = 'manual_expense' AND w."operation_type" = 'expense'
         AND w."is_deleted" = false AND w."expense_category_id" = h."expense_category_id"
         ${scopeCashbox ? 'AND w."cashbox_id" = h."cashbox_id"' : ''}
         AND w."id" <> h."id"
         AND w."createdAt" >= h."createdAt" - INTERVAL '${R3_WINDOW_DAYS} days'
         AND w."createdAt" < h."createdAt"`;
    const stats = (alias: string, scopeCashbox: boolean) => `
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS n,
               ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY a)::numeric, 2) AS med
          FROM (${window(scopeCashbox)}) x
      ) ${alias} ON true
      LEFT JOIN LATERAL (
        SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ABS(a - ${alias}.med))::numeric, 2) AS mad
          FROM (${window(scopeCashbox)}) x
      ) ${alias}m ON true`;
    const rows = await this.ds.query<R3Row[]>(
      `SELECT * FROM (
         SELECT h."id"::text AS id, ABS(h."amount") AS amount, h."createdAt",
                h."cashbox_id"::text AS cashbox_id, c."cashbox_type"::text AS cashbox_type,
                c."user_id"::text AS owner,
                h."expense_category_id"::text AS category_id,
                COALESCE(cat."name", h."expense_category_name") AS category_name,
                h."created_by"::text AS created_by,
                CASE WHEN sb.n >= $3 THEN 'category_branch' ELSE 'category' END AS scope,
                CASE WHEN sb.n >= $3 THEN sb.n ELSE sc.n END AS sample_size,
                CASE WHEN sb.n >= $3 THEN sb.med ELSE sc.med END AS median,
                CASE WHEN sb.n >= $3 THEN sbm.mad ELSE scm.mad END AS mad
           FROM ${this.tables().history} h
           JOIN ${this.tables().cashboxes} c ON c."id" = h."cashbox_id"
           LEFT JOIN ${this.tables().categories} cat ON cat."id" = h."expense_category_id"
           ${stats('sb', true)}
           ${stats('sc', false)}
          WHERE h."id"::text = ANY($1::text[])
       ) r,
       LATERAL (
         SELECT (r.median + $2::numeric * GREATEST(r.mad, ROUND(r.median * $4::numeric, 2)))::numeric(20,2) AS threshold
       ) th
       WHERE r.sample_size >= $3 AND r.amount > th.threshold
       ORDER BY r."createdAt" ASC, r.id ASC`,
      [fresh.map((r) => r.id), k, R3_MIN_SAMPLE, R3_MIN_MAD_RATIO],
    );

    const types = new Map<string, string>();
    const candidates: AiAdvisorCandidate[] = [];
    for (const row of rows) {
      const cashbox = cashboxRef(row.owner, row.cashbox_type);
      types.set(row.owner, row.cashbox_type);
      const branch: AiAdvisorRef | null =
        cashbox.type === 'branch' ? { id: row.owner, name: null } : null;
      if (branch) names.wantBranch(branch.id);
      if (isId(row.created_by)) names.wantUser(row.created_by);
      const amount = money(row.amount);
      const median = money(row.median);
      const mad = money(row.mad);
      const threshold = money(row.threshold);
      const sample = await this.r3Sample(row);
      candidates.push({
        rule_key: 'R3',
        dedup_key: `R3:history:${row.id}`,
        fact_keys: [{ fact_key: row.id, fact_at: iso(row.createdAt) }],
        branch,
        subject: { kind: 'cashbox', id: row.owner, name: null },
        headline_amount: amount,
        facts: {
          history_id: row.id,
          amount,
          category: { id: row.category_id, name: row.category_name ?? null },
          cashbox,
          branch,
          created_by: isId(row.created_by)
            ? { id: row.created_by, name: null }
            : null,
          created_at: iso(row.createdAt),
          median,
          mad,
          threshold,
          ratio_to_median:
            median > 0 ? Math.round((amount / median) * 10) / 10 : null,
          sample_size: Number(row.sample_size),
          window_days: R3_WINDOW_DAYS,
          scope: row.scope,
        },
        evidence: {
          kind: 'expense_stats',
          stats: {
            window_days: R3_WINDOW_DAYS,
            sample_size: Number(row.sample_size),
            median,
            mad,
            multiplier: k,
            threshold,
            scope: row.scope,
          },
          total_rows: sample.total + 1,
          truncated: sample.total + 1 > ADVISOR_EVIDENCE_LIMIT,
          rows: [
            {
              history_id: row.id,
              created_at: iso(row.createdAt),
              amount,
              cashbox_name: null,
              created_by: isId(row.created_by)
                ? { id: row.created_by, name: null }
                : null,
              is_trigger: true,
              href: null,
            },
            ...sample.rows,
          ],
        },
      });
      for (const r of sample.rows) {
        const by = r.created_by as AiAdvisorRef | null;
        if (by) names.wantUser(by.id);
      }
    }
    return { candidates, cursor };
  }

  /** R3 dalili: statistika oynasidagi eng katta 14 qator. */
  private async r3Sample(
    row: R3Row,
  ): Promise<{ total: number; rows: Array<Record<string, unknown>> }> {
    const scopeCashbox = row.scope === 'category_branch';
    const params = [
      row.category_id,
      row.createdAt,
      row.id,
      ...(scopeCashbox ? [row.cashbox_id] : []),
    ];
    const where = `w."source_type" = 'manual_expense' AND w."operation_type" = 'expense'
         AND w."is_deleted" = false AND w."expense_category_id" = $1
         AND w."id" <> $3 AND w."createdAt" >= $2::timestamptz - INTERVAL '${R3_WINDOW_DAYS} days'
         AND w."createdAt" < $2::timestamptz
         ${scopeCashbox ? 'AND w."cashbox_id" = $4' : ''}`;
    const list = await this.ds.query<
      Array<{
        id: string;
        createdAt: Date;
        amount: string;
        created_by: string | null;
        total: string;
      }>
    >(
      `SELECT w."id"::text AS id, w."createdAt", ABS(w."amount") AS amount,
              w."created_by"::text AS created_by, COUNT(*) OVER () AS total
         FROM ${this.tables().history} w WHERE ${where}
        ORDER BY ABS(w."amount") DESC, w."id" DESC
        LIMIT ${ADVISOR_EVIDENCE_LIMIT - 1}`,
      params,
    );
    return {
      total: list.length ? Number(list[0].total) : 0,
      rows: list.map((r) => ({
        history_id: r.id,
        created_at: iso(r.createdAt),
        amount: money(r.amount),
        cashbox_name: null,
        created_by: isId(r.created_by)
          ? { id: r.created_by, name: null }
          : null,
        is_trigger: false,
        href: null,
      })),
    };
  }

  // ─── R6 Zarar (§4.2): yopilgan kun / hafta ────────────────────────────

  private async r6(
    periods: NonNullable<AiAdvisorRuleInputsRequest['periods']>,
    now: Date,
  ): Promise<AiAdvisorCandidate[]> {
    const today = tashkentDateKey(now);
    const days = (periods.days ?? []).filter((d) => isDay(d) && d < today);
    const weeks = (periods.weeks ?? []).filter(
      (d) => isDay(d) && addDaysKey(d, 6) < today,
    );
    const candidates: AiAdvisorCandidate[] = [];
    const load = async (from: string, to: string) => {
      const res = (await this.daily.financialBalanceDaily({
        from_date: from,
        to_date: to,
      })) as {
        data?: {
          days?: Array<{
            date: string;
            ledger: { income: number; expense: number; net: number };
          }>;
        };
      };
      return (res?.data?.days ?? []).map((d) => ({
        date: d.date,
        income: money(d.ledger?.income),
        expense: money(d.ledger?.expense),
        net: money(d.ledger?.net),
      }));
    };
    const build = (
      period: 'day' | 'week',
      from: string,
      to: string,
      rows: Array<{
        date: string;
        income: number;
        expense: number;
        net: number;
      }>,
    ): AiAdvisorCandidate | null => {
      const income = money(rows.reduce((s, r) => s + r.income, 0));
      const expense = money(rows.reduce((s, r) => s + r.expense, 0));
      const net = money(income - expense);
      if (!(net < 0)) return null;
      const key = period === 'day' ? `R6:day:${from}` : `R6:week:${from}`;
      const factAt = new Date(`${to}T23:59:59.999+05:00`).toISOString();
      return {
        rule_key: 'R6',
        dedup_key: key,
        fact_keys: [{ fact_key: key, fact_at: factAt }],
        branch: null,
        subject: { kind: 'system', id: null, name: null },
        headline_amount: net,
        facts: { period, from, to, income, expense, net },
        evidence: {
          kind: 'profit_days',
          total_rows: rows.length,
          truncated: false,
          rows: rows.map((r) => ({ ...r, is_trigger: r.net < 0 })),
          totals: { income, expense, net },
        },
      };
    };
    for (const day of days) {
      const c = build('day', day, day, await load(day, day));
      if (c) candidates.push(c);
    }
    for (const monday of weeks) {
      const sunday = addDaysKey(monday, 6);
      const c = build('week', monday, sunday, await load(monday, sunday));
      if (c) candidates.push(c);
    }
    return candidates;
  }

  // ─── Yordamchilar ─────────────────────────────────────────────────────

  private async cashboxTypes(owners: string[]): Promise<Map<string, string>> {
    const ids = owners.filter((o) => o !== '0');
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = await this.ds.query<
      Array<{ owner: string; cashbox_type: string }>
    >(
      `SELECT DISTINCT ON ("user_id") "user_id"::text AS owner, "cashbox_type"::text AS cashbox_type
         FROM ${this.tables().cashboxes}
        WHERE "user_id"::text = ANY($1::text[]) AND "cashbox_type" IN ('branch', 'main')
          AND "is_deleted" = false
        ORDER BY "user_id", ("cashbox_type" = 'branch') DESC`,
      [ids],
    );
    for (const r of rows) out.set(r.owner, r.cashbox_type);
    return out;
  }

  /** `identity.user.find_by_ids` — fail-open. */
  async userNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(isId))];
    const out = new Map<string, string>();
    if (!unique.length) return out;
    try {
      const response = await rmqSend<{ data?: unknown }>(
        this.identityClient,
        { cmd: 'identity.user.find_by_ids' },
        { ids: unique },
        { timeoutMs: NAME_TIMEOUT_MS, retries: 1 },
      );
      const rows = Array.isArray(response?.data) ? response.data : [];
      for (const row of rows as Array<{ id?: unknown; name?: unknown }>) {
        const id =
          typeof row?.id === 'string' || typeof row?.id === 'number'
            ? String(row.id)
            : '';
        const name = typeof row?.name === 'string' ? row.name.trim() : '';
        if (id && name) out.set(id, name.slice(0, 120));
      }
    } catch (error) {
      this.logger.warn(`advisor: ismlar olinmadi — ${short(error)}`);
    }
    return out;
  }

  /** Filial nomlari (`branch.find_by_id`, kam sonli) — fail-open. */
  async branchNames(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.branchClient) return out;
    for (const id of [...new Set(ids.filter(isId))]) {
      try {
        const response = await rmqSend<{ data?: { name?: unknown } }>(
          this.branchClient,
          { cmd: 'branch.find_by_id' },
          { id, requester: SYSTEM_BRANCH_REQUESTER },
          { timeoutMs: NAME_TIMEOUT_MS, retries: 0 },
        );
        const name = response?.data?.name;
        if (typeof name === 'string' && name.trim())
          out.set(id, name.trim().slice(0, 120));
      } catch (error) {
        this.logger.warn(
          `advisor: filial nomi olinmadi (${id}) — ${short(error)}`,
        );
      }
    }
    return out;
  }
}

/**
 * Ism snapshotlari: qoidalar `want*` bilan yig'adi, oxirida bitta to'plam
 * so'rov bilan `name: null` maydonlarini to'ldiradi.
 */
class NameCache {
  private readonly users = new Set<string>();
  private readonly branches = new Set<string>();

  constructor(private readonly svc: AdvisorInputsService) {}

  wantUser(id: string): void {
    this.users.add(id);
  }

  wantBranch(id: string): void {
    this.branches.add(id);
  }

  async fill(candidates: AiAdvisorCandidate[]): Promise<void> {
    const [users, branches] = await Promise.all([
      this.svc.userNames([...this.users]),
      this.svc.branchNames([...this.branches]),
    ]);
    const branchRef = (ref: unknown) => {
      const r = ref as AiAdvisorRef | null;
      if (r && r.name === null) r.name = branches.get(r.id) ?? null;
    };
    const userRef = (ref: unknown) => {
      const r = ref as AiAdvisorRef | null;
      if (r && typeof r === 'object' && r.name === null)
        r.name = users.get(r.id) ?? null;
    };
    const cashboxName = (cb: AiAdvisorCashboxRef | undefined) => {
      if (!cb || cb.name !== null) return;
      if (cb.type === 'main') cb.name = MAIN_CASHBOX_NAME;
      else if (cb.type === 'branch') {
        const b = branches.get(cb.owner_id);
        cb.name = b ? `${b} kassasi` : null;
      } else cb.name = users.get(cb.owner_id) ?? null;
    };
    for (const c of candidates) {
      branchRef(c.branch);
      const f = c.facts;
      if (f.branch && f.branch !== c.branch) branchRef(f.branch);
      cashboxName(f.cashbox as AiAdvisorCashboxRef | undefined);
      for (const u of (f.closed_by as unknown[] | undefined) ?? []) userRef(u);
      userRef(f.created_by);
      if (c.subject.kind === 'cashbox' && c.subject.name === null) {
        c.subject.name =
          (f.cashbox as AiAdvisorCashboxRef | undefined)?.name ?? null;
      }
      for (const row of (c.evidence.rows as
        Array<Record<string, unknown>> | undefined) ?? []) {
        userRef(row.closed_by);
        userRef(row.created_by);
        if ('cashbox_name' in row && row.cashbox_name === null) {
          row.cashbox_name =
            (f.cashbox as AiAdvisorCashboxRef | undefined)?.name ?? null;
        }
      }
    }
  }
}

function shiftEvidenceRow(r: ShiftRow): Record<string, unknown> {
  const expectedCash = moneyOrNull(r.expected_balance_cash);
  const expectedCard = moneyOrNull(r.expected_balance_card);
  const dCash = moneyOrNull(r.discrepancy_cash);
  const dCard = moneyOrNull(r.discrepancy_card);
  const countedCash =
    dCash === null ? null : money((expectedCash ?? 0) + dCash);
  const countedCard =
    dCard === null ? null : money((expectedCard ?? 0) + dCard);
  // «Kutilgan»/«Sanalgan» — faqat SANALGAN qismlar: counted − expected = difference.
  const expected = money(
    (dCash === null ? 0 : (expectedCash ?? 0)) +
      (dCard === null ? 0 : (expectedCard ?? 0)),
  );
  const counted = money((countedCash ?? 0) + (countedCard ?? 0));
  return {
    shift_id: r.id,
    closed_at: iso(r.closed_at),
    closed_by: isId(r.closed_by) ? { id: r.closed_by, name: null } : null,
    closed_by_system: r.closed_by_system === true,
    expected_cash: expectedCash ?? 0,
    expected_card: expectedCard ?? 0,
    counted_cash: countedCash,
    counted_card: countedCard,
    expected,
    counted,
    difference: money(r.difference),
    href: `/payments/shifts/${r.id}`,
  };
}

function cashboxRef(
  owner: string,
  type: string | undefined,
): AiAdvisorCashboxRef {
  if (owner === '0') return { type: 'main', owner_id: '0', name: null };
  if (type === 'main') return { type: 'main', owner_id: owner, name: null };
  if (type === 'couriers' || type === 'markets')
    return { type, owner_id: owner, name: null };
  return { type: 'branch', owner_id: owner, name: null };
}

function parseSince(value: string | undefined, now: Date): Date {
  const d = value ? new Date(value) : null;
  if (d && !Number.isNaN(d.getTime()) && d <= now) return d;
  // Kursor yo'q / noto'g'ri — §4.3 qisqa orqa oyna (7 kun).
  return new Date(now.getTime() - 7 * 24 * 3600_000);
}

function positive(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function isDay(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function cmpId(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function short(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
