import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type QueryRunner } from 'typeorm';
import {
  AI_ADVISOR_INPUT_MAX_PERIODS,
  AI_ADVISOR_INPUT_MAX_SINCE_DAYS,
  AI_ADVISOR_SYSTEM_SUBJECT_NAME,
  startOfTashkentDay,
  rmqSend,
  type AiAdvisorCandidate,
  type AiAdvisorCashboxRef,
  type AiAdvisorRef,
  type AiAdvisorRuleInputsRequest,
  type AiAdvisorRuleInputsResponse,
  type AiAdvisorRuleKey,
} from '@app/common';
import { FinanceDailyService } from '../aggregates/finance-daily.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxExpenseCategory } from '../entities/cashbox-expense-category.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinanceCashboxDaily } from '../entities/finance-cashbox-daily.entity';
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
/** Filial nomlari: parallel so'rovlar chegarasi (round-2 #652). */
const BRANCH_NAME_CONCURRENCY = 5;
/** `branch.user.find_by_user_ids` chegarasi (USER_BRANCH_LOOKUP_MAX). */
const USER_BRANCH_CHUNK = 500;
/**
 * Har SQL ifoda chegarasi — AdvisorReader 30 s timeout'idan PAST (round-2
 * #651 ops-B1): og'ir so'rov finance'ni band qilib qolmaydi, qoida xatosi
 * faqat o'sha qoidaga tegadi (`errors`).
 */
export const ADVISOR_STATEMENT_TIMEOUT_MS = 15_000;
/** R3: bitta tekshiruvdagi vaqt byudjeti — oshsa, ishlangan qismgacha kursor. */
export const R3_TIME_BUDGET_MS = 12_000;
/** R3: yangi qatorlar shu bo'laklarda ishlanadi (progress kafolati). */
const R3_CHUNK = 200;
/** R1: ketma-ketlik uzunligini aniqlash uchun oldingi smenalar chegarasi. */
const R1_STREAK_LOOKBACK = 50;
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
  // Kun boshi (UTC lahza) + 12 soat — Toshkent kalendar kunining ichida;
  // qo'lda «+5 soat» yo'q (§10, round-2 #651 S9).
  return new Date(startOfTashkentDay(date).getTime() + 12 * 3600_000)
    .toISOString()
    .slice(0, 10);
}

/** `YYYY-MM-DD` + n kun. */
export function addDaysKey(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Bitta tranzaksiya ichidagi so'rov (statement_timeout bilan). */
type SqlQuery = <R = unknown>(sql: string, params?: unknown[]) => Promise<R>;

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

interface EpisodeRow {
  cashbox_id: string;
  owner: string;
  balance: string;
  last_id: string | null;
  last_at: Date | null;
  last_amount: string | null;
  last_day: string | null;
  first_at: Date | null;
  first_day: string | null;
}

interface Episode {
  /** `ep:h:<oxirgi chiqish history_id>` yoki `ep:d:<boshlangan kun>`. */
  key: string;
  /** Epizod boshlangan Toshkent kuni 00:00 (ISO). */
  at: string;
  /** «N kundan beri» = bugun − hodisa kuni (to'liq kalendar kunlari). */
  days: number;
}

/** Epizod: oxirgi chiqishdan (bo'lmasa qoldiq paydo bo'lgan kundan) beri. */
function episodeOf(r: EpisodeRow, today: string): Episode | null {
  const day = r.last_id ? r.last_day : r.first_day;
  if (!day) return null;
  const key = r.last_id ? `ep:h:${r.last_id}` : `ep:d:${day}`;
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) /
      86_400_000,
  );
  return { key, at: new Date(`${day}T00:00:00.000+05:00`).toISOString(), days };
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
      daily: path(FinanceCashboxDaily),
    };
  }

  async ruleInputs(
    input: AiAdvisorRuleInputsRequest,
  ): Promise<AiAdvisorRuleInputsResponse> {
    const now = new Date(input?.now ?? Date.now());
    if (Number.isNaN(now.getTime())) throw new Error('now noto‘g‘ri');
    const started = Date.now();
    const rules = new Set(Array.isArray(input?.rules) ? input.rules : []);
    const out: AiAdvisorRuleInputsResponse = { candidates: [], cursors: {} };
    const names = new NameCache(this);
    // Har qoida alohida: biri yiqilsa (timeout) — boshqalari odatdagidek,
    // yiqilgan qoida `errors` da, kursorsiz (round-2 #651 ops-B1).
    const guard = async (rule: AiAdvisorRuleKey, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (error) {
        (out.errors ??= {})[rule] = short(error);
        this.logger.warn(`advisor.rule_inputs ${rule} xato: ${short(error)}`);
      }
    };

    if (rules.has('R1')) {
      await guard('R1', async () => {
        const t = input.thresholds?.R1 ?? {};
        const since = parseSince(input.since?.R1, now);
        const r = await this.withTimeout((q) =>
          this.r1(q, since, now, t, names),
        );
        out.candidates.push(...r.candidates);
        out.cursors.R1 = r.cursor;
      });
    }
    if (rules.has('R3')) {
      await guard('R3', async () => {
        const t = input.thresholds?.R3 ?? {};
        const since = parseSince(input.since?.R3, now);
        const r = await this.withTimeout((q) =>
          this.r3(q, since, now, t, names, started + R3_TIME_BUDGET_MS),
        );
        out.candidates.push(...r.candidates);
        out.cursors.R3 = r.cursor;
      });
    }
    const today = tashkentDateKey(now);
    if (rules.has('R2')) {
      await guard('R2', async () => {
        out.candidates.push(
          ...(await this.r2(input.thresholds?.R2 ?? {}, today, names)),
        );
      });
    }
    if (rules.has('R4')) {
      await guard('R4', async () => {
        out.candidates.push(
          ...(await this.r4(input.thresholds?.R4 ?? {}, today, names)),
        );
      });
    }
    if (rules.has('R5')) {
      await guard('R5', async () => {
        out.candidates.push(
          ...(await this.r5(input.thresholds?.R5 ?? {}, today, names)),
        );
      });
    }
    if (rules.has('R6')) {
      await guard('R6', async () => {
        out.candidates.push(...(await this.r6(input.periods ?? {}, now)));
      });
    }
    await names.fill(out.candidates);
    return out;
  }

  /**
   * O'qish so'rovlari alohida ulanishda, `statement_timeout` bilan (SET
   * LOCAL — faqat shu tranzaksiya). Hech narsa yozilmaydi.
   */
  private async withTimeout<T>(fn: (q: SqlQuery) => Promise<T>): Promise<T> {
    const runner: QueryRunner = this.ds.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      await runner.query(
        `SET LOCAL statement_timeout = ${ADVISOR_STATEMENT_TIMEOUT_MS}`,
      );
      const result = await fn(
        <R>(sql: string, params?: unknown[]) =>
          runner.query(sql, params) as Promise<R>,
      );
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (runner.isTransactionActive)
        await runner.rollbackTransaction().catch(() => undefined);
      throw error;
    } finally {
      await runner.release();
    }
  }

  // ─── R1 Smena kamomadi (§4.2) ─────────────────────────────────────────

  private async r1(
    q: SqlQuery,
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
    const columns = `s."id"::text AS id,
             COALESCE(s."cashbox_user_id", 0)::text AS owner,
             s."closed_at", s."closed_by"::text AS closed_by, s."closed_by_system",
             s."expected_balance_cash", s."expected_balance_card",
             s."discrepancy_cash", s."discrepancy_card",
             (COALESCE(s."discrepancy_cash", 0) + COALESCE(s."discrepancy_card", 0)) AS difference,
             (COALESCE(s."discrepancy_cash", 0) + COALESCE(s."discrepancy_card", 0)) < -($1::numeric) AS is_short,
             (COALESCE(s."discrepancy_cash", 0) + COALESCE(s."discrepancy_card", 0)) < 0 AS is_negative`;
    // Mos smena: yopilgan, kamida bitta qismi sanalgan (avtomatik yopilgan —
    // ikkalasi NULL — o'tkaziladi, ketma-ketlikni na uzaytiradi, na uzadi).
    const eligible = (
      a: string,
    ) => `${a}."status" = 'closed' AND ${a}."is_deleted" = false
        AND (${a}."discrepancy_cash" IS NOT NULL OR ${a}."discrepancy_card" IS NOT NULL)`;
    const fresh = await q<ShiftRow[]>(
      `SELECT ${columns} FROM ${this.tables().shifts} s
        WHERE ${eligible('s')} AND s."closed_at" >= $2 AND s."closed_at" <= $3
        ORDER BY s."closed_at" ASC, s."id" ASC
        LIMIT ${R1_MAX_NEW_SHIFTS}`,
      [shortage, since, now],
    );
    if (!fresh.length) return { candidates: [], cursor: null };
    const cursor = iso(fresh[fresh.length - 1].closed_at);
    warnIfStalled(
      this.logger,
      'R1',
      fresh.length,
      R1_MAX_NEW_SHIFTS,
      fresh[0].closed_at,
      cursor,
    );
    const owners = [...new Set(fresh.map((r) => r.owner))];
    // Har kassa uchun birinchi yangi smenadan OLDINGI mos smenalar (≤ 50):
    // ketma-ketlik oynasi har YANGI smenada tugaydigan qilib tekshiriladi
    // (orqa oynada tugagan ketma-ketlik ham — round-2 #651 S1), uzunligi
    // esa butun uzluksiz manfiy qator bo'yicha.
    const prior = await q<ShiftRow[]>(
      `SELECT p.* FROM unnest($2::text[]) AS o(owner)
         CROSS JOIN LATERAL (
           SELECT ${columns} FROM ${this.tables().shifts} s
            WHERE ${eligible('s')} AND COALESCE(s."cashbox_user_id", 0) = o.owner::bigint
              AND (s."closed_at", s."id") < (
                SELECT f."closed_at", f."id" FROM ${this.tables().shifts} f
                 WHERE ${eligible('f')} AND COALESCE(f."cashbox_user_id", 0) = o.owner::bigint
                   AND f."closed_at" >= $3 AND f."closed_at" <= $4
                 ORDER BY f."closed_at" ASC, f."id" ASC LIMIT 1)
            ORDER BY s."closed_at" DESC, s."id" DESC
            LIMIT ${R1_STREAK_LOOKBACK}
         ) p`,
      [shortage, owners, since, now],
    );
    const types = await this.cashboxTypes(q, owners);

    const candidates: AiAdvisorCandidate[] = [];
    for (const owner of owners) {
      const freshRows = fresh.filter((r) => r.owner === owner);
      const freshIds = new Set(freshRows.map((r) => r.id));
      const series = [...prior.filter((r) => r.owner === owner), ...freshRows]
        .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i)
        .sort(byClosedAt);
      const byId = new Map<string, ShiftRow>();
      for (const r of freshRows) if (r.is_short) byId.set(r.id, r);
      // Oxirgi N ta mos smena hammasi manfiy bo'lgan har oyna, oxiri YANGI
      // smena bo'lsa — oynadagi N smena fakt.
      let lastStreakEnd = -1;
      for (let i = streakLen - 1; i < series.length; i++) {
        if (!freshIds.has(series[i].id)) continue;
        const window = series.slice(i - streakLen + 1, i + 1);
        if (!window.every((r) => r.is_negative)) continue;
        for (const r of window) byId.set(r.id, r);
        lastStreakEnd = i;
      }
      if (!byId.size) continue;
      const shifts = [...byId.values()].sort(byClosedAt);
      const last = shifts[shifts.length - 1];
      const total = money(
        shifts.reduce((sum, r) => sum + Number(r.difference), 0),
      );
      const lastDiff = money(last.difference);
      // trigger — OXIRGI fakt-smenani chaqirgan shart (§4.2).
      const streak = lastStreakEnd >= 0 && series[lastStreakEnd].id === last.id;
      const trigger = streak ? 'consecutive_negative' : 'single_shortage';
      // Ketma-ketlik uzunligi/jami — oxirgi oynani o'z ichiga olgan butun
      // uzluksiz manfiy qator (sarlavha «N smena ketma-ket», round-2 B1).
      let streakFrom = lastStreakEnd;
      if (streak) {
        while (streakFrom > 0 && series[streakFrom - 1].is_negative)
          streakFrom -= 1;
      }
      const run = streak ? series.slice(streakFrom, lastStreakEnd + 1) : [];
      const cashbox = cashboxRef(owner, types.get(owner));
      const branch: AiAdvisorRef | null =
        cashbox.type === 'branch' ? { id: owner, name: null } : null;
      const closedBy = [
        ...new Set(
          [...shifts]
            .reverse()
            .map((r) => r.closed_by)
            .filter(isId),
        ),
      ].slice(0, 5);
      for (const id of closedBy) names.wantUser(id);
      if (branch) names.wantBranch(branch.id);
      candidates.push({
        rule_key: 'R1',
        dedup_key: `R1:cashbox:${owner}`,
        fact_keys: shifts.map((r) => ({
          fact_key: r.id,
          fact_at: iso(r.closed_at),
          amount: money(r.difference),
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
          streak_length: streak ? run.length : null,
          streak_total: streak
            ? money(run.reduce((sum, r) => sum + Number(r.difference), 0))
            : null,
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
    q: SqlQuery,
    since: Date,
    now: Date,
    t: Record<string, number>,
    names: NameCache,
    deadline: number,
  ): Promise<{ candidates: AiAdvisorCandidate[]; cursor: string | null }> {
    const k = positive(t.mad_multiplier, 3);
    const fresh = await q<Array<{ id: string; createdAt: Date }>>(
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
    warnIfStalled(
      this.logger,
      'R3',
      fresh.length,
      R3_MAX_NEW_ROWS,
      fresh[0].createdAt,
      iso(fresh[fresh.length - 1].createdAt),
    );
    // Har yangi qator uchun oldingi 30 kun statistikasi (joriy qatorsiz):
    // avval shu kassa + kategoriya, namuna < 5 bo'lsa butun tizim + kategoriya.
    // Oyna — qator vaqtidan 30×24 soat orqaga (sirpanuvchi; Toshkent kun
    // chegarasi emas). Mediana/MAD `percentile_cont` (float8) → 2 xonaga
    // yaxlitlanadi, chegara solishtiruvi numeric'da (so'm aniqligi yetarli).
    const window = (scopeCashbox: boolean) => `
      SELECT ABS(w."amount") AS a FROM ${this.tables().history} w
       WHERE w."source_type" = 'manual_expense' AND w."operation_type" = 'expense'
         AND w."is_deleted" = false AND w."expense_category_id" = h."expense_category_id"
         ${scopeCashbox ? 'AND w."cashbox_id" = h."cashbox_id"' : ''}
         AND w."id" <> h."id"
         AND w."createdAt" >= h."createdAt" - INTERVAL '${R3_WINDOW_DAYS} days'
         AND w."createdAt" < h."createdAt"`;
    // `gate` — butun tizim statistikasi FAQAT kassa namunasi < 5 bo'lsa
    // hisoblanadi (aks holda skan yo'q — round-2 #651 ops-B1).
    const stats = (alias: string, scopeCashbox: boolean, gate = '') => `
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS n,
               ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY a)::numeric, 2) AS med
          FROM (${window(scopeCashbox)}) x ${gate ? `WHERE ${gate}` : ''}
      ) ${alias} ON true
      LEFT JOIN LATERAL (
        SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ABS(a - ${alias}.med))::numeric, 2) AS mad
          FROM (${window(scopeCashbox)}) x ${gate ? `WHERE ${gate}` : ''}
      ) ${alias}m ON true`;
    const sql = `SELECT * FROM (
         SELECT h."id"::text AS id, ABS(h."amount") AS amount, h."createdAt",
                h."cashbox_id"::text AS cashbox_id, c."cashbox_type"::text AS cashbox_type,
                COALESCE(c."user_id", 0)::text AS owner,
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
           ${stats('sc', false, 'sb.n < $3')}
          WHERE h."id" = ANY($1::bigint[])
       ) r,
       LATERAL (
         SELECT (r.median + $2::numeric * GREATEST(r.mad, ROUND(r.median * $4::numeric, 2)))::numeric(20,2) AS threshold
       ) th
       WHERE r.sample_size >= $3 AND r.amount > th.threshold
       ORDER BY r."createdAt" ASC, r.id ASC`;
    // Bo'laklarda: vaqt byudjeti tugasa — ishlangan qismgacha kursor
    // (keyingi tick davom ettiradi; bir xil oyna qayta-qayta o'qilmaydi).
    const rows: R3Row[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < fresh.length; i += R3_CHUNK) {
      const chunk = fresh.slice(i, i + R3_CHUNK);
      rows.push(
        ...(await q<R3Row[]>(sql, [
          chunk.map((r) => r.id),
          k,
          R3_MIN_SAMPLE,
          R3_MIN_MAD_RATIO,
        ])),
      );
      cursor = iso(chunk[chunk.length - 1].createdAt);
      if (Date.now() > deadline && i + R3_CHUNK < fresh.length) {
        this.logger.warn(
          `advisor R3: vaqt byudjeti tugadi — ${i + chunk.length}/${fresh.length} qator, kursor ${cursor}`,
        );
        break;
      }
    }

    const candidates: AiAdvisorCandidate[] = [];
    for (const row of rows) {
      const cashbox = cashboxRef(row.owner, row.cashbox_type);
      const branch: AiAdvisorRef | null =
        cashbox.type === 'branch' ? { id: row.owner, name: null } : null;
      if (branch) names.wantBranch(branch.id);
      if (isId(row.created_by)) names.wantUser(row.created_by);
      const amount = money(row.amount);
      const median = money(row.median);
      const mad = money(row.mad);
      const threshold = money(row.threshold);
      const sample = await this.r3Sample(q, row);
      for (const r of sample.rows) names.wantCashbox(r.cashbox);
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
              cashbox,
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

  /**
   * R3 dalili: statistika oynasidagi eng katta 14 qator. Har qator O'Z
   * kassasi bilan (`cashbox` — ai-service `href` va nom uchun; REST'ga
   * chiqishidan oldin olib tashlanadi; round-2 #651 S2).
   */
  private async r3Sample(
    q: SqlQuery,
    row: R3Row,
  ): Promise<{
    total: number;
    rows: Array<Record<string, unknown> & { cashbox: AiAdvisorCashboxRef }>;
  }> {
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
    const list = await q<
      Array<{
        id: string;
        createdAt: Date;
        amount: string;
        created_by: string | null;
        owner: string | null;
        cashbox_type: string | null;
        total: string;
      }>
    >(
      `SELECT w."id"::text AS id, w."createdAt", ABS(w."amount") AS amount,
              w."created_by"::text AS created_by, COALESCE(c."user_id", 0)::text AS owner,
              c."cashbox_type"::text AS cashbox_type, COUNT(*) OVER () AS total
         FROM ${this.tables().history} w
         LEFT JOIN ${this.tables().cashboxes} c ON c."id" = w."cashbox_id"
        WHERE ${where}
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
        cashbox: cashboxRef(r.owner ?? '0', r.cashbox_type ?? undefined),
      })),
    };
  }

  // ─── R6 Zarar (§4.2): yopilgan kun / hafta ────────────────────────────

  private async r6(
    periods: NonNullable<AiAdvisorRuleInputsRequest['periods']>,
    now: Date,
  ): Promise<AiAdvisorCandidate[]> {
    const today = tashkentDateKey(now);
    // Faqat yopilgan davrlar, ≤ 14 tadan (round-2 #651 S10).
    const days = [...new Set(periods.days ?? [])]
      .filter((d) => isDay(d) && d < today)
      .slice(-AI_ADVISOR_INPUT_MAX_PERIODS);
    const weeks = [...new Set(periods.weeks ?? [])]
      .filter((d) => isDay(d) && addDaysKey(d, 6) < today)
      .slice(-AI_ADVISOR_INPUT_MAX_PERIODS);
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
      // §5.1: R6 — first_fact_at = davr boshi, last_fact_at = davr oxiri.
      const factAt = new Date(`${to}T23:59:59.999+05:00`).toISOString();
      return {
        rule_key: 'R6',
        dedup_key: key,
        fact_keys: [{ fact_key: key, fact_at: factAt }],
        first_fact_at: new Date(`${from}T00:00:00.000+05:00`).toISOString(),
        branch: null,
        subject: {
          kind: 'system',
          id: null,
          name: AI_ADVISOR_SYSTEM_SUBJECT_NAME,
        },
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

  // ─── R2/R4/R5 holat qoidalari: epizod (§4.1, §4.2, BE-rev B5) ─────────

  /**
   * Kassa turi bo'yicha joriy holat: qoldiq, oxirgi «chiqish» (topshirish /
   * to'lov / o'tkazma — `createdAt` bo'yicha, T6 bilan qaytarilgani
   * hisobga olinmaydi) va bunday chiqish bo'lmasa epizod boshlangan lahza
   * (qoldiq birinchi marta `episodeFloor` dan oshgan qator).
   */
  private async episodes(
    type: 'couriers' | 'markets' | 'branch',
    source: 'courier_payment' | 'market_payment' | 'branch_to_main',
    minBalance: number,
    episodeFloor: number,
  ): Promise<EpisodeRow[]> {
    const t = this.tables();
    return this.ds.query<EpisodeRow[]>(
      `SELECT c."id"::text AS cashbox_id, c."user_id"::text AS owner, c."balance",
              lh.id AS last_id, lh."createdAt" AS last_at, lh.amount AS last_amount,
              to_char(lh."createdAt" AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS last_day,
              fp.first_at,
              to_char(fp.first_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS first_day
         FROM ${t.cashboxes} c
         LEFT JOIN LATERAL (
           SELECT h."id"::text AS id, h."createdAt", ABS(h."amount") AS amount
             FROM ${t.history} h
            WHERE h."cashbox_id" = c."id" AND h."operation_type" = 'expense'
              AND h."source_type" = $2 AND h."is_deleted" = false
              AND NOT EXISTS (
                SELECT 1 FROM ${t.history} r
                 WHERE r."source_type" = 'payment_reversal'
                   AND r."reverses_history_id" = h."id" AND r."is_deleted" = false)
            ORDER BY h."createdAt" DESC, h."id" DESC
            LIMIT 1
         ) lh ON true
         LEFT JOIN LATERAL (
           SELECT MIN(h."createdAt") AS first_at
             FROM ${t.history} h
            WHERE lh.id IS NULL AND h."cashbox_id" = c."id"
              AND h."is_deleted" = false AND h."balance_after" > $4::numeric
         ) fp ON true
        WHERE c."cashbox_type" = $1 AND c."is_deleted" = false
          AND c."balance" > $3::numeric
        ORDER BY c."id"`,
      [type, source, minBalance, episodeFloor],
    );
  }

  /** Kassa kunlik yopilishlari (`finance_cashbox_daily`) — oxirgi kunlar. */
  private async dailyClosings(
    cashboxIds: string[],
    fromDay: string,
    toDay: string,
  ): Promise<
    Map<
      string,
      Array<{ date: string; opening: number; income: number; closing: number }>
    >
  > {
    const out = new Map<
      string,
      Array<{ date: string; opening: number; income: number; closing: number }>
    >();
    if (!cashboxIds.length) return out;
    const rows = await this.ds.query<
      Array<{
        cashbox_id: string;
        date: string;
        opening_balance: string;
        income: string;
        closing_balance: string;
      }>
    >(
      `SELECT "cashbox_id"::text AS cashbox_id, to_char("snapshot_date", 'YYYY-MM-DD') AS date,
              "opening_balance", "income", "closing_balance"
         FROM ${this.tables().daily}
        WHERE "cashbox_id" = ANY($1::bigint[]) AND "snapshot_date" BETWEEN $2::date AND $3::date
          AND "is_deleted" = false
        ORDER BY "cashbox_id", "snapshot_date"`,
      [cashboxIds, fromDay, toDay],
    );
    for (const r of rows) {
      const list = out.get(r.cashbox_id) ?? [];
      list.push({
        date: r.date,
        opening: money(r.opening_balance),
        income: money(r.income),
        closing: money(r.closing_balance),
      });
      out.set(r.cashbox_id, list);
    }
    return out;
  }

  /** Kun bo'yicha «chiqish» yig'indisi (T6 qaytarilganlarsiz). */
  private async dailyOutflows(
    cashboxIds: string[],
    source: string,
    fromDay: string,
  ): Promise<Map<string, Map<string, number>>> {
    const out = new Map<string, Map<string, number>>();
    if (!cashboxIds.length) return out;
    const t = this.tables();
    const rows = await this.ds.query<
      Array<{ cashbox_id: string; day: string; total: string }>
    >(
      `SELECT h."cashbox_id"::text AS cashbox_id,
              to_char(h."createdAt" AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS day,
              SUM(ABS(h."amount")) AS total
         FROM ${t.history} h
        WHERE h."cashbox_id" = ANY($1::bigint[]) AND h."operation_type" = 'expense'
          AND h."source_type" = $2 AND h."is_deleted" = false
          AND h."createdAt" >= ($3::date::timestamp AT TIME ZONE 'Asia/Tashkent')
          AND NOT EXISTS (
            SELECT 1 FROM ${t.history} r
             WHERE r."source_type" = 'payment_reversal'
               AND r."reverses_history_id" = h."id" AND r."is_deleted" = false)
        GROUP BY 1, 2`,
      [cashboxIds, source, fromDay],
    );
    for (const r of rows) {
      const m = out.get(r.cashbox_id) ?? new Map<string, number>();
      m.set(r.day, money(r.total));
      out.set(r.cashbox_id, m);
    }
    return out;
  }

  /** R2 Kuryer qarzi o'smoqda: (o'sish VA > balance_uzs) YOKI (> N kun topshirilmagan). */
  private async r2(
    t: Record<string, number>,
    today: string,
    names: NameCache,
  ): Promise<AiAdvisorCandidate[]> {
    const balanceUzs = positive(t.balance_uzs, 2_000_000);
    const growthDays = Math.floor(positive(t.growth_days, 3));
    const noHandover = Math.floor(positive(t.no_handover_days, 3));
    const rows = await this.episodes('couriers', 'courier_payment', 0, 0);
    if (!rows.length) return [];
    const ids = rows.map((r) => r.cashbox_id);
    const window = Math.max(growthDays + 1, ADVISOR_EVIDENCE_LIMIT);
    const closings = await this.dailyClosings(
      ids,
      addDaysKey(today, -window),
      addDaysKey(today, -1),
    );
    const outflows = await this.dailyOutflows(
      ids,
      'courier_payment',
      addDaysKey(today, -window),
    );
    const candidates: AiAdvisorCandidate[] = [];
    for (const r of rows) {
      const ep = episodeOf(r, today);
      if (!ep) continue;
      const balance = money(r.balance);
      const days = (closings.get(r.cashbox_id) ?? []).filter(
        (d) => d.date < today,
      );
      // (a) o'sish: oxirgi growthDays+1 ta YOPILGAN kun (kechagacha) — har kuni
      // oldingisidan qat'iy katta. Kun yetishmasa (snapshot hali yo'q) — o'tkaziladi.
      const tail = days.slice(-(growthDays + 1));
      const expected = Array.from({ length: growthDays + 1 }, (_, i) =>
        addDaysKey(today, i - growthDays - 1),
      );
      const growth =
        tail.length === growthDays + 1 &&
        tail.every((d, i) => d.date === expected[i]) &&
        tail.every((d, i) => i === 0 || d.closing > tail[i - 1].closing) &&
        balance > balanceUzs;
      const stale = balance > 0 && ep.days > noHandover;
      if (!growth && !stale) continue;
      // O'sish signali kechagacha yopilgan kunlardan; bugun topshirish bo'lsa
      // (epizod bugun boshlangan) — o'sha holat, yangi epizod emas (§6, Q23;
      // round-2 #652 B1). Ertaga topshirishdan keyingi yopilishlar bilan
      // shart qayta rost bo'lsa — yangi epizod.
      if (growth && !stale && ep.days <= 0) continue;
      const trigger =
        growth && stale ? 'both' : growth ? 'growth' : 'no_handover';
      names.wantUser(r.owner);
      names.wantUserBranch(r.owner);
      const out = outflows.get(r.cashbox_id) ?? new Map<string, number>();
      const ev = days.slice(-ADVISOR_EVIDENCE_LIMIT);
      candidates.push({
        rule_key: 'R2',
        dedup_key: `R2:courier:${r.owner}`,
        fact_keys: [{ fact_key: ep.key, fact_at: ep.at }],
        branch: null,
        subject: { kind: 'courier', id: r.owner, name: null },
        headline_amount: balance,
        facts: {
          trigger,
          courier: { id: r.owner, name: null },
          branch: null,
          balance,
          growth_days: growth ? growthDays : 0,
          days_without_handover: ep.days,
          last_handover_at: r.last_at ? iso(r.last_at) : null,
        },
        evidence: {
          kind: 'courier_days',
          total_rows: days.length,
          truncated: days.length > ev.length,
          rows: ev.map((d) => ({
            date: d.date,
            opening_balance: d.opening,
            income: d.income,
            handed_over: out.get(d.date) ?? 0,
            closing_balance: d.closing,
          })),
          last_handover: r.last_id
            ? {
                at: iso(r.last_at),
                amount: money(r.last_amount),
                history_id: r.last_id,
              }
            : null,
        },
      });
    }
    return candidates;
  }

  /** R4 Market to'lovi kechikmoqda: qarz > 0 VA > N kun to'lov yo'q. */
  private async r4(
    t: Record<string, number>,
    today: string,
    names: NameCache,
  ): Promise<AiAdvisorCandidate[]> {
    const limitDays = Math.floor(positive(t.days_without_payout, 7));
    const rows = await this.episodes('markets', 'market_payment', 0, 0);
    const hits = rows
      .map((r) => ({ r, ep: episodeOf(r, today) }))
      .filter(
        (x): x is { r: EpisodeRow; ep: Episode } =>
          !!x.ep && x.ep.days > limitDays,
      );
    if (!hits.length) return [];
    const ids = hits.map((x) => x.r.cashbox_id);
    const from = addDaysKey(today, -ADVISOR_EVIDENCE_LIMIT);
    const closings = await this.dailyClosings(ids, from, addDaysKey(today, -1));
    const paid = await this.dailyOutflows(ids, 'market_payment', from);
    return hits.map(({ r, ep }) => {
      names.wantUser(r.owner);
      const debt = money(r.balance);
      const days = closings.get(r.cashbox_id) ?? [];
      const p = paid.get(r.cashbox_id) ?? new Map<string, number>();
      return {
        rule_key: 'R4',
        dedup_key: `R4:market:${r.owner}`,
        fact_keys: [{ fact_key: ep.key, fact_at: ep.at }],
        branch: null,
        subject: { kind: 'market', id: r.owner, name: null },
        headline_amount: debt,
        facts: {
          market: { id: r.owner, name: null },
          debt,
          days_without_payout: ep.days,
          last_payout_at: r.last_at ? iso(r.last_at) : null,
          last_payout_amount: r.last_id ? money(r.last_amount) : null,
        },
        evidence: {
          kind: 'market_debt_days',
          total_rows: days.length,
          truncated: false,
          rows: days.map((d) => ({
            date: d.date,
            debt: d.closing,
            paid: p.get(d.date) ?? 0,
          })),
          last_payout: r.last_id
            ? {
                at: iso(r.last_at),
                amount: money(r.last_amount),
                history_id: r.last_id,
              }
            : null,
        },
      } satisfies AiAdvisorCandidate;
    });
  }

  /** R5 HQ'ga o'tkazma kechikmoqda: qoldiq > balance_uzs VA > N kun o'tkazma yo'q (Q17). */
  private async r5(
    t: Record<string, number>,
    today: string,
    names: NameCache,
  ): Promise<AiAdvisorCandidate[]> {
    const balanceUzs = positive(t.balance_uzs, 5_000_000);
    const limitDays = Math.floor(positive(t.days_without_transfer, 3));
    const rows = await this.episodes(
      'branch',
      'branch_to_main',
      balanceUzs,
      balanceUzs,
    );
    const hits = rows
      .map((r) => ({ r, ep: episodeOf(r, today) }))
      .filter(
        (x): x is { r: EpisodeRow; ep: Episode } =>
          !!x.ep && x.ep.days > limitDays,
      );
    if (!hits.length) return [];
    const ids = hits.map((x) => x.r.cashbox_id);
    const closings = await this.dailyClosings(
      ids,
      addDaysKey(today, -ADVISOR_EVIDENCE_LIMIT),
      addDaysKey(today, -1),
    );
    const t2 = this.tables();
    const transfers = await this.ds.query<
      Array<{
        cashbox_id: string;
        id: string;
        createdAt: Date;
        amount: string;
        rn: string;
      }>
    >(
      `SELECT * FROM (
         SELECT h."cashbox_id"::text AS cashbox_id, h."id"::text AS id, h."createdAt", ABS(h."amount") AS amount,
                ROW_NUMBER() OVER (PARTITION BY h."cashbox_id" ORDER BY h."createdAt" DESC, h."id" DESC) AS rn
           FROM ${t2.history} h
          WHERE h."cashbox_id" = ANY($1::bigint[]) AND h."operation_type" = 'expense'
            AND h."source_type" = 'branch_to_main' AND h."is_deleted" = false
            AND NOT EXISTS (
              SELECT 1 FROM ${t2.history} r
               WHERE r."source_type" = 'payment_reversal'
                 AND r."reverses_history_id" = h."id" AND r."is_deleted" = false)
       ) x WHERE x.rn <= ${ADVISOR_EVIDENCE_LIMIT}`,
      [ids],
    );
    return hits.map(({ r, ep }) => {
      const branch: AiAdvisorRef = { id: r.owner, name: null };
      names.wantBranch(r.owner);
      const balance = money(r.balance);
      return {
        rule_key: 'R5',
        dedup_key: `R5:branch:${r.owner}`,
        fact_keys: [{ fact_key: ep.key, fact_at: ep.at }],
        branch,
        subject: { kind: 'branch', id: r.owner, name: null },
        headline_amount: balance,
        facts: {
          branch,
          balance,
          days_without_transfer: ep.days,
          last_transfer_at: r.last_at ? iso(r.last_at) : null,
          last_transfer_amount: r.last_id ? money(r.last_amount) : null,
        },
        evidence: {
          kind: 'branch_transfers',
          total_rows: (closings.get(r.cashbox_id) ?? []).length,
          truncated: false,
          days: (closings.get(r.cashbox_id) ?? []).map((d) => ({
            date: d.date,
            closing_balance: d.closing,
          })),
          transfers: transfers
            .filter((x) => x.cashbox_id === r.cashbox_id)
            .map((x) => ({
              at: iso(x.createdAt),
              amount: money(x.amount),
              history_id: x.id,
              href: null,
            })),
        },
      } satisfies AiAdvisorCandidate;
    });
  }

  // ─── Yordamchilar ─────────────────────────────────────────────────────

  private async cashboxTypes(
    q: SqlQuery,
    owners: string[],
  ): Promise<Map<string, string>> {
    const ids = owners.filter((o) => o !== '0');
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = await q<Array<{ owner: string; cashbox_type: string }>>(
      `SELECT DISTINCT ON ("user_id") "user_id"::text AS owner, "cashbox_type"::text AS cashbox_type
         FROM ${this.tables().cashboxes}
        WHERE "user_id" = ANY($1::bigint[]) AND "cashbox_type" IN ('branch', 'main')
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

  /**
   * Foydalanuvchi → filial (`branch.user.find_by_user_ids`) — fail-open.
   * branch-service bir so'rovda ≤ 500 id qabul qiladi — bo'laklarda (round-2).
   */
  async userBranches(ids: string[]): Promise<Map<string, AiAdvisorRef>> {
    const out = new Map<string, AiAdvisorRef>();
    const unique = [...new Set(ids.filter(isId))];
    if (!this.branchClient || !unique.length) return out;
    for (let i = 0; i < unique.length; i += USER_BRANCH_CHUNK) {
      await this.userBranchChunk(unique.slice(i, i + USER_BRANCH_CHUNK), out);
    }
    return out;
  }

  private async userBranchChunk(
    unique: string[],
    out: Map<string, AiAdvisorRef>,
  ): Promise<void> {
    if (!this.branchClient) return;
    try {
      const response = await rmqSend<{
        data?: Array<{
          user_id?: unknown;
          branch?: { id?: unknown; name?: unknown } | null;
        }>;
      }>(
        this.branchClient,
        { cmd: 'branch.user.find_by_user_ids' },
        { user_ids: unique, requester: SYSTEM_BRANCH_REQUESTER },
        { timeoutMs: NAME_TIMEOUT_MS, retries: 0 },
      );
      for (const row of Array.isArray(response?.data) ? response.data : []) {
        const userId =
          typeof row?.user_id === 'string' || typeof row?.user_id === 'number'
            ? String(row.user_id)
            : '';
        const branchId =
          typeof row?.branch?.id === 'string' ||
          typeof row?.branch?.id === 'number'
            ? String(row.branch.id)
            : '';
        if (!userId || !branchId) continue;
        const name =
          typeof row?.branch?.name === 'string' && row.branch.name.trim()
            ? row.branch.name.trim().slice(0, 120)
            : null;
        out.set(userId, { id: branchId, name });
      }
    } catch (error) {
      this.logger.warn(`advisor: kuryer filiallari olinmadi — ${short(error)}`);
    }
  }

  /**
   * Filial nomlari (`branch.find_by_id`) — fail-open, parallel (≤ 5 bir
   * vaqtda): osilgan branch-service tick'ni 30 s dan oshirmasin (round-2).
   */
  async branchNames(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.branchClient) return out;
    const client = this.branchClient;
    const queue = [...new Set(ids.filter(isId))];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const response = await rmqSend<{ data?: { name?: unknown } }>(
            client,
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
    };
    await Promise.all(
      Array.from({ length: BRANCH_NAME_CONCURRENCY }, () => worker()),
    );
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
  private readonly userBranches = new Set<string>();

  constructor(private readonly svc: AdvisorInputsService) {}

  wantUser(id: string): void {
    this.users.add(id);
  }

  wantBranch(id: string): void {
    this.branches.add(id);
  }

  /** Kuryerning filiali (R2 `branch`) — `branch.user.find_by_user_ids`. */
  wantUserBranch(id: string): void {
    this.userBranches.add(id);
  }

  /** Dalil qatori kassasi (R3 «tizim bo'yicha» — har qator o'z kassasi). */
  wantCashbox(cb: AiAdvisorCashboxRef | undefined): void {
    if (!cb || cb.owner_id === '0') return;
    if (cb.type === 'branch') this.branches.add(cb.owner_id);
    else if (cb.type !== 'main') this.users.add(cb.owner_id);
  }

  async fill(candidates: AiAdvisorCandidate[]): Promise<void> {
    const [users, branches, userBranch] = await Promise.all([
      this.svc.userNames([...this.users]),
      this.svc.branchNames([...this.branches]),
      this.svc.userBranches([...this.userBranches]),
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
      if (c.rule_key === 'R2' && c.subject.id) {
        const b = userBranch.get(c.subject.id) ?? null;
        c.branch = b;
        c.facts.branch = b;
      }
      branchRef(c.branch);
      const f = c.facts;
      if (f.branch && f.branch !== c.branch) branchRef(f.branch);
      cashboxName(f.cashbox as AiAdvisorCashboxRef | undefined);
      for (const u of (f.closed_by as unknown[] | undefined) ?? []) userRef(u);
      userRef(f.created_by);
      userRef(f.courier);
      userRef(f.market);
      if (c.subject.name === null && c.subject.id) {
        if (c.subject.kind === 'cashbox') {
          c.subject.name =
            (f.cashbox as AiAdvisorCashboxRef | undefined)?.name ?? null;
        } else if (
          c.subject.kind === 'courier' ||
          c.subject.kind === 'market'
        ) {
          c.subject.name = users.get(c.subject.id) ?? null;
        } else if (c.subject.kind === 'branch') {
          c.subject.name = branches.get(c.subject.id) ?? null;
        }
      }
      for (const row of (c.evidence.rows as
        Array<Record<string, unknown>> | undefined) ?? []) {
        userRef(row.closed_by);
        userRef(row.created_by);
        if ('cashbox_name' in row && row.cashbox_name === null) {
          const own = row.cashbox as AiAdvisorCashboxRef | undefined;
          if (own) cashboxName(own);
          row.cashbox_name =
            (own ?? (f.cashbox as AiAdvisorCashboxRef | undefined))?.name ??
            null;
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
  // Orqa oyna ≤ 30 kun (round-2 #651 S10) — finance'ni himoya qiladi.
  const floor = new Date(
    now.getTime() - AI_ADVISOR_INPUT_MAX_SINCE_DAYS * 24 * 3600_000,
  );
  if (d && !Number.isNaN(d.getTime()) && d <= now) return d < floor ? floor : d;
  // Kursor yo'q / noto'g'ri — §4.3 qisqa orqa oyna (7 kun).
  return new Date(now.getTime() - 7 * 24 * 3600_000);
}

function positive(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function isDay(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * Partiya to'la va hammasi bir lahzada (masalan bitta tranzaksiyadagi
 * ommaviy yozuv) — kursor siljiy olmaydi; jim qolmasin (round-2 ops-S8).
 */
function warnIfStalled(
  logger: Logger,
  rule: string,
  count: number,
  limit: number,
  first: Date,
  cursor: string,
): void {
  if (count >= limit && iso(first) === cursor) {
    logger.error(
      `advisor ${rule}: kursor siljimaydi — ${count} qator bir lahzada (${cursor})`,
    );
  }
}

function byClosedAt(a: ShiftRow, b: ShiftRow): number {
  return +new Date(a.closed_at) - +new Date(b.closed_at) || cmpId(a.id, b.id);
}

function cmpId(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function short(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
