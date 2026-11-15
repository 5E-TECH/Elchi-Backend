import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import {
  AI_ADVISOR_CURSOR_RULES,
  AI_ADVISOR_SYSTEM_SUBJECT_NAME,
  aiAdvisorThresholds,
  endOfTashkentDay,
  startOfTashkentDay,
  startOfTashkentWeek,
  type AiAdvisorCandidate,
  type AiAdvisorCursorRule,
  type AiAdvisorRuleInputsRequest,
  type AiAdvisorRuleKey,
  type AiAdvisorRulesSettings,
} from '@app/common';
import { AdvisorReader } from './advisor-reader';
import { AdvisorSettingsService } from './advisor-settings.service';
import { mergeR1 } from './advisor-merge';
import { advisorLinks, advisorTitle, withEvidenceHrefs } from './advisor-text';

/**
 * BE-5 (LhTIno57) — qoidalar dvigateli (API shartnomasi §4, §6).
 *
 * finance `rule_inputs` nomzodlarini ogohlantirishlarga aylantiradi:
 * - ochiq (`new`/`seen`) ogohlantirish `FOR UPDATE` bilan olinadi — PATCH
 *   resolve bilan poyga yo'q, `UQ_AI_ADVISOR_ALERT_OPEN_DEDUP` yiqilmaydi;
 * - yangi `fact_key` → `occurrences + 1` (holat o'zgarmaydi — Q6, izoh
 *   qayta yozilmaydi — Q7); ayni `fact_key` — hech narsa (R2/R4/R5 da
 *   ochiq bo'lsa faqat joriy faktlar yangilanadi);
 * - ochiq yo'q va yangi fakt bor → yangi qator (`reopened_from_id` —
 *   oxirgi yopilgan); yopilgandan keyin ayni fakt — hech narsa;
 * - §4.3: qoidaning BIRINCHI ishga tushishida 24 soatdan eski faktlardan
 *   ochilgan ogohlantirish `notify_skipped='backfill'`.
 *
 * Bildirishnoma (4-qism) va avtomatik AI izohi (5-qism) bu yerda yo'q:
 * `explanation_status` `none` bo'lib ochiladi.
 */
export type AdvisorRunGroup = 'frequent' | 'daily';

/** 30 daqiqalik tick: kursorli va holat qoidalari (§4.0). */
export const ADVISOR_FREQUENT_RULES: readonly AiAdvisorRuleKey[] = [
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R7',
];
/** 02:30 Toshkent: R6 (kecha; dushanba — o'tgan hafta ham), R8 (dushanba — o'tgan hafta). */
export const ADVISOR_DAILY_RULES: readonly AiAdvisorRuleKey[] = ['R6', 'R8'];
/** Holat qoidalari: ayni epizod qayta ko'rilsa ochiq qatorni yangilaydi. */
export const ADVISOR_STATE_RULES = new Set<AiAdvisorRuleKey>([
  'R2',
  'R4',
  'R5',
]);
/** Ochiq ogohlantirishda AYNI fakt qayta kelsa — faktlar/sarlavha yangilanadi. */
export const ADVISOR_REFRESH_RULES = new Set<AiAdvisorRuleKey>([
  ...ADVISOR_STATE_RULES,
  'R7',
]);
export const ADVISOR_CURSOR_OVERLAP_MS = 5 * 60_000;
export const ADVISOR_BACKFILL_WINDOW_MS = 7 * 24 * 3600_000;
export const ADVISOR_BACKFILL_NOTIFY_MS = 24 * 3600_000;

/** Vaqtinchalik xatoli nomzod shuncha urinishdan keyin o'tkaziladi (round-2 B2). */
export const ADVISOR_MAX_CANDIDATE_FAILURES = 5;
/** R6: o'tkazilgan kunlar (catch-up) chegarasi. */
export const ADVISOR_R6_CATCHUP_DAYS = 7;
/** apply() qator qulfini kutish chegarasi (round-2 S7). */
const APPLY_LOCK_TIMEOUT = '5s';
const DAY_MS = 24 * 3600_000;
const STATE_TABLE = 'ai_schema.ai_advisor_rule_state';
const ALERTS = 'ai_schema.ai_advisor_alerts';
const OCC = 'ai_schema.ai_advisor_alert_occurrences';

export type AdvisorApplyOutcome = 'opened' | 'occurred' | 'refreshed' | 'noop';

export interface AdvisorRunResult {
  group: AdvisorRunGroup;
  rules: AiAdvisorRuleKey[];
  candidates: number;
  opened: number;
  occurred: number;
  refreshed: number;
  failed: number;
}

interface RuleStateRow {
  rule_key: AiAdvisorRuleKey;
  cursor_at: Date | null;
  first_run_at: Date | null;
  failures: Record<string, number> | null;
}

interface OpenAlertRow {
  id: string;
  facts: unknown;
  evidence: unknown;
}

/** Natija holati — qoida bo'yicha (round-2 B2/S5). */
interface RuleOutcome {
  status: 'ok' | 'partial' | 'error';
  error: string | null;
  failed: number;
  /** Xatoli nomzodlar faktlarining eng erta vaqti — kursor shundan oshmaydi. */
  hold: Date | null;
  failures: Record<string, number>;
}

/**
 * Toshkent kalendar kuni `YYYY-MM-DD` — lib yordamchisi orqali (§10: qo'lda
 * «+5 soat» yo'q). Kun boshi + 12 soat — o'sha kun ichida.
 */
const tashkentDay = (d: Date) =>
  new Date(startOfTashkentDay(d).getTime() + 12 * 3600_000)
    .toISOString()
    .slice(0, 10);
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** `YYYY-MM-DD` (Toshkent) kunining oxiri — UTC lahza. */
const dayEnd = (day: string) =>
  endOfTashkentDay(new Date(`${day}T12:00:00.000+05:00`));

@Injectable()
export class AdvisorEngineService {
  private readonly logger = new Logger(AdvisorEngineService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly settings: AdvisorSettingsService,
    private readonly reader: AdvisorReader,
  ) {}

  /** Bitta tekshiruv (scheduler qulf ichida chaqiradi). */
  async run(
    group: AdvisorRunGroup,
    now: Date = new Date(),
  ): Promise<AdvisorRunResult> {
    const rules = await this.settings.getRules();
    const keys = (
      group === 'frequent' ? ADVISOR_FREQUENT_RULES : ADVISOR_DAILY_RULES
    ).filter((k) => rules[k].enabled);
    const result: AdvisorRunResult = {
      group,
      rules: [...keys],
      candidates: 0,
      opened: 0,
      occurred: 0,
      refreshed: 0,
      failed: 0,
    };
    if (!keys.length) return result;

    const states = await this.loadStates(keys);
    const request: AiAdvisorRuleInputsRequest = {
      rules: [...keys],
      now: now.toISOString(),
      thresholds: {},
      since: {},
    };
    for (const k of keys)
      request.thresholds[k] = aiAdvisorThresholds(k, rules[k]);
    for (const k of keys) {
      if (!isCursorRule(k)) continue;
      const cursor = states.get(k)?.cursor_at;
      request.since[k] = (
        cursor
          ? new Date(new Date(cursor).getTime() - ADVISOR_CURSOR_OVERLAP_MS)
          : new Date(now.getTime() - ADVISOR_BACKFILL_WINDOW_MS)
      ).toISOString();
    }
    if (keys.includes('R6') || keys.includes('R8')) {
      // R6: kursordan keyingi yopilgan kunlar/haftalar (round-2 catch-up);
      // R6 va R8: oxirgi YOPILGAN hafta har kuni so'raladi (#653 review S6) —
      // dushanbadagi ish yiqilsa ham hafta yo'qolmaydi; dedup — takror no-op.
      const periods = keys.includes('R6')
        ? r6Periods(now, states.get('R6'))
        : { days: [] };
      const lastWeek = tashkentDay(
        new Date(startOfTashkentWeek(now).getTime() - 7 * DAY_MS),
      );
      request.periods = {
        days: periods.days,
        weeks: [...new Set([...(periods.weeks ?? []), lastWeek])],
      };
    }

    let response: Awaited<ReturnType<AdvisorReader['ruleInputs']>>;
    try {
      response = await this.reader.ruleInputs(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.saveStates(
        keys,
        now,
        {},
        [],
        new Map(keys.map((k) => [k, errorOutcome(states.get(k), message)])),
      ).catch(() => undefined);
      throw error;
    }

    const errors = response?.errors ?? {};
    const candidates = (response?.candidates ?? []).filter(
      (c) => keys.includes(c.rule_key) && !errors[c.rule_key],
    );
    result.candidates = candidates.length;
    const outcomes = new Map<AiAdvisorRuleKey, RuleOutcome>();
    for (const k of keys) {
      outcomes.set(
        k,
        errors[k]
          ? errorOutcome(states.get(k), errors[k])
          : {
              status: 'ok',
              error: null,
              failed: 0,
              hold: null,
              failures: { ...(states.get(k)?.failures ?? {}) },
            },
      );
    }
    for (const c of candidates) {
      const outcome = outcomes.get(c.rule_key) as RuleOutcome;
      const attempts = outcome.failures[c.dedup_key] ?? 0;
      if (attempts >= ADVISOR_MAX_CANDIDATE_FAILURES) {
        // Doimiy xato (masalan buzuq ma'lumot) qoidani abadiy to'xtatmasin.
        this.logger.error(
          `ai_advisor_apply_skipped rule=${c.rule_key} dedup=${String(c.dedup_key).slice(0, 80)} attempts=${attempts}`,
        );
        delete outcome.failures[c.dedup_key];
        continue;
      }
      const firstRun = !states.get(c.rule_key)?.first_run_at;
      try {
        const applied = await this.apply(c, rules, now, firstRun);
        delete outcome.failures[c.dedup_key];
        if (applied !== 'noop') result[applied] += 1;
      } catch (error) {
        // Vaqtinchalik xato (ulanish, deadlock, lock_timeout): kursor shu
        // nomzod faktlaridan oshmaydi — keyingi tick qayta o'qiydi (round-2 B2).
        result.failed += 1;
        outcome.status = 'partial';
        outcome.failed += 1;
        outcome.error = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 300);
        outcome.failures[c.dedup_key] = attempts + 1;
        const earliest = minFactAt(dedupeFacts(c.fact_keys));
        if (
          !Number.isNaN(earliest.getTime()) &&
          (!outcome.hold || earliest < outcome.hold)
        )
          outcome.hold = earliest;
        this.logger.error(
          `ai_advisor_apply_failed rule=${c.rule_key} dedup=${String(c.dedup_key).slice(0, 80)} attempt=${attempts + 1}: ${outcome.error.slice(0, 200)}`,
        );
      }
    }
    await this.saveStates(
      keys,
      now,
      response?.cursors ?? {},
      candidates,
      outcomes,
    );
    return result;
  }

  /** Bitta nomzodni qo'llash — bitta tranzaksiya. */
  async apply(
    c: AiAdvisorCandidate,
    rules: AiAdvisorRulesSettings,
    now: Date,
    firstRun: boolean,
  ): Promise<AdvisorApplyOutcome> {
    const facts = dedupeFacts(c.fact_keys);
    if (!facts.length) return 'noop';
    return this.ds.transaction(async (m) => {
      // Ochiq qator GET/PATCH qulfida uzoq qolsa — tick osilmaydi: xato
      // vaqtinchalik deb hisoblanadi, kursor ushlanadi (round-2 S7/B2).
      await m.query(`SET LOCAL lock_timeout = '${APPLY_LOCK_TIMEOUT}'`);
      const open = await m.query<OpenAlertRow[]>(
        `SELECT "id"::text AS id, "facts", "evidence" FROM ${ALERTS}
          WHERE "dedup_key" = $1 AND "status" IN ('new','seen') AND "is_deleted" = false
          FOR UPDATE`,
        [c.dedup_key],
      );
      const known = new Set(
        (
          await m.query<Array<{ fact_key: string }>>(
            `SELECT "fact_key" FROM ${OCC} WHERE "dedup_key" = $1 AND "fact_key" = ANY($2::text[])`,
            [c.dedup_key, facts.map((f) => f.fact_key)],
          )
        ).map((r) => r.fact_key),
      );
      const fresh = facts.filter((f) => !known.has(f.fact_key));

      if (open.length) {
        const alertId = open[0].id;
        if (fresh.length) {
          // R1: yangi fakt-smenalar saqlanganlarga QO'SHILADI (round-2 B1).
          const present = this.presentation(
            c.rule_key === 'R1'
              ? mergeR1(open[0], c, new Set(fresh.map((f) => f.fact_key)))
              : c,
          );
          const inserted = await this.insertOccurrences(
            m,
            alertId,
            c.dedup_key,
            fresh,
            now,
          );
          await m.query(
            `UPDATE ${ALERTS}
                SET "occurrences" = "occurrences" + $2, "last_at" = $3,
                    "last_fact_at" = GREATEST(COALESCE("last_fact_at", $4), $4),
                    "title" = $5, "facts" = $6::jsonb, "evidence" = $7::jsonb, "links" = $8::jsonb,
                    "subject" = $9::jsonb, "branch" = $10::jsonb, "branch_id" = $11,
                    "headline_amount" = $12, "updatedAt" = now()
              WHERE "id" = $1`,
            [alertId, inserted, now, maxFactAt(fresh), ...present],
          );
          return inserted > 0 ? 'occurred' : 'noop';
        }
        if (ADVISOR_REFRESH_RULES.has(c.rule_key)) {
          // R2/R4/R5: epizod davom etmoqda — `last_fact_at` = endi.
          // R7: ayni chek/tekshiruv qayta tahlil / T6 tahriri — faktlar
          // yangilanadi, hodisa vaqti o'zgarmaydi (review S1).
          const factAt = ADVISOR_STATE_RULES.has(c.rule_key)
            ? now
            : maxFactAt(facts);
          const present = this.presentation(c);
          await m.query(
            `UPDATE ${ALERTS}
                SET "last_at" = $2, "last_fact_at" = GREATEST(COALESCE("last_fact_at", $3), $3),
                    "title" = $4, "facts" = $5::jsonb, "evidence" = $6::jsonb, "links" = $7::jsonb,
                    "subject" = $8::jsonb, "branch" = $9::jsonb, "branch_id" = $10,
                    "headline_amount" = $11, "updatedAt" = now()
              WHERE "id" = $1`,
            [alertId, now, factAt, ...present],
          );
          return 'refreshed';
        }
        return 'noop';
      }

      // Ochiq yo'q: faqat YANGI fakt yangi ogohlantirish ochadi.
      if (!fresh.length) return 'noop';
      const rule = rules[c.rule_key];
      const previous = await m.query<Array<{ id: string }>>(
        `SELECT "id"::text AS id FROM ${ALERTS}
          WHERE "dedup_key" = $1 AND "status" IN ('resolved','dismissed') AND "is_deleted" = false
          ORDER BY "id" DESC LIMIT 1`,
        [c.dedup_key],
      );
      const present = this.presentation(c);
      const firstFactAt = c.first_fact_at ? new Date(c.first_fact_at) : null;
      const backfill =
        firstRun &&
        maxFactAt(fresh).getTime() < now.getTime() - ADVISOR_BACKFILL_NOTIFY_MS;
      const [created] = await m.query<Array<{ id: string }>>(
        `INSERT INTO ${ALERTS}
           ("rule_key", "severity", "status", "dedup_key", "title", "facts", "evidence", "links",
            "subject", "branch", "branch_id", "headline_amount", "rule_snapshot", "occurrences",
            "first_at", "last_at", "first_fact_at", "last_fact_at", "explanation_status",
            "reopened_from_id", "notify_skipped")
         VALUES ($1, $2, 'new', $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10,
                 $11, $12::jsonb, $13, $14, $14, $15, $16, 'none', $17, $18)
         ON CONFLICT ("dedup_key") WHERE "status" IN ('new','seen') DO NOTHING
         RETURNING "id"::text AS id`,
        [
          c.rule_key,
          rule.severity,
          c.dedup_key,
          ...present,
          JSON.stringify({
            key: c.rule_key,
            severity: rule.severity,
            thresholds: aiAdvisorThresholds(c.rule_key, rule),
          }),
          fresh.length,
          now,
          firstFactAt && !Number.isNaN(firstFactAt.getTime())
            ? firstFactAt
            : minFactAt(fresh),
          maxFactAt(fresh),
          previous[0]?.id ?? null,
          backfill ? 'backfill' : null,
        ],
      );
      if (!created) return 'noop';
      await this.insertOccurrences(m, created.id, c.dedup_key, fresh, now);
      return 'opened';
    });
  }

  /** `title, facts, evidence, links, subject, branch, branch_id, headline_amount`. */
  private presentation(c: AiAdvisorCandidate): unknown[] {
    return [
      advisorTitle(c),
      JSON.stringify(c.facts ?? {}),
      JSON.stringify(withEvidenceHrefs(c) ?? {}),
      JSON.stringify(advisorLinks(c)),
      JSON.stringify(subjectOf(c)),
      c.branch ? JSON.stringify(c.branch) : null,
      c.branch && /^\d{1,18}$/.test(c.branch.id) ? c.branch.id : null,
      c.headline_amount ?? null,
    ];
  }

  private async insertOccurrences(
    m: EntityManager,
    alertId: string,
    dedupKey: string,
    facts: Array<{ fact_key: string; fact_at: Date }>,
    now: Date,
  ): Promise<number> {
    let inserted = 0;
    for (const f of facts) {
      const rows = await m.query<unknown[]>(
        `INSERT INTO ${OCC} ("alert_id", "dedup_key", "fact_key", "occurred_at", "fact_at")
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("dedup_key", "fact_key") DO NOTHING
         RETURNING "id"`,
        [alertId, dedupKey, f.fact_key, now, f.fact_at],
      );
      inserted += rows.length;
    }
    return inserted;
  }

  private async loadStates(
    keys: readonly AiAdvisorRuleKey[],
  ): Promise<Map<AiAdvisorRuleKey, RuleStateRow>> {
    const rows = await this.ds.query<RuleStateRow[]>(
      `SELECT "rule_key", "cursor_at", "first_run_at", "failures" FROM ${STATE_TABLE} WHERE "rule_key" = ANY($1::text[])`,
      [[...keys]],
    );
    return new Map(rows.map((r) => [r.rule_key, r]));
  }

  private async saveStates(
    keys: readonly AiAdvisorRuleKey[],
    now: Date,
    cursors: Partial<Record<AiAdvisorCursorRule, string | null>>,
    candidates: AiAdvisorCandidate[],
    outcomes: Map<AiAdvisorRuleKey, RuleOutcome>,
  ): Promise<void> {
    for (const k of keys) {
      const o = outcomes.get(k) as RuleOutcome;
      let cursor: string | null = null;
      if (o.status !== 'error' && isCursorRule(k)) {
        // Yangi qator ko'rilmasa — «shu lahzagacha ko'rildi» (keyingi tick
        // kursor − 5 daqiqadan boshlaydi, kech commit'lar ham qamraladi).
        // Xatoli nomzod bo'lsa — uning eng erta faktidan oshmaydi.
        const seen = new Date(cursors[k] ?? now.toISOString());
        cursor = (o.hold && o.hold < seen ? o.hold : seen).toISOString();
      } else if (k === 'R6' && o.status === 'ok') {
        // R6: kechagi kun oxirigacha tekshirildi (o'tkazilganlar keyin).
        cursor = dayEnd(addDays(tashkentDay(now), -1)).toISOString();
      }
      const count = candidates.filter((c) => c.rule_key === k).length;
      // Kursor faqat oldinga siljiydi; birinchi muvaffaqiyatli ishdan keyin
      // `first_run_at` qo'yiladi (§4.3 backfill tugadi).
      await this.ds.query(
        `INSERT INTO ${STATE_TABLE} ("rule_key", "cursor_at", "first_run_at", "last_run_at",
                                     "last_status", "last_error", "last_candidates", "last_failed", "failures")
         VALUES ($1, $2::timestamptz, CASE WHEN $5::text <> 'error' THEN $3::timestamptz END, $3, $5::text, $6, $4,
                 $7, $8::jsonb)
         ON CONFLICT ("rule_key") DO UPDATE SET
           "cursor_at" = GREATEST(${STATE_TABLE.split('.')[1]}."cursor_at", EXCLUDED."cursor_at"),
           "first_run_at" = COALESCE(${STATE_TABLE.split('.')[1]}."first_run_at", EXCLUDED."first_run_at"),
           "last_run_at" = EXCLUDED."last_run_at",
           "last_status" = EXCLUDED."last_status",
           "last_error" = EXCLUDED."last_error",
           "last_candidates" = EXCLUDED."last_candidates",
           "last_failed" = EXCLUDED."last_failed",
           "failures" = EXCLUDED."failures",
           "updatedAt" = now()`,
        [
          k,
          cursor,
          now,
          count,
          o.status,
          o.error ? o.error.slice(0, 300) : null,
          o.failed,
          JSON.stringify(o.failures),
        ],
      );
    }
  }
}

/** Qoida xatosi: kursor siljimaydi, xatolar hisoblagichi saqlanadi. */
function errorOutcome(
  state: RuleStateRow | undefined,
  message: string,
): RuleOutcome {
  return {
    status: 'error',
    error: message.slice(0, 300),
    failed: 0,
    hold: null,
    failures: { ...(state?.failures ?? {}) },
  };
}

/**
 * R6 davrlari (round-2 S2/S3): kursor (oxirgi tekshirilgan kun oxiri)dan
 * keyingi barcha yopilgan kunlar (≤ 7) va yopilgan haftalar; kursor yo'q —
 * faqat kecha (dushanba — o'tgan hafta ham). Dedup kalitlari qayta
 * tekshirishni xavfsiz qiladi.
 */
export function r6Periods(
  now: Date,
  state: Pick<RuleStateRow, 'cursor_at'> | undefined,
): { days: string[]; weeks?: string[] } {
  const today = tashkentDay(now);
  const yesterday = addDays(today, -1);
  const lastMonday = tashkentDay(
    new Date(startOfTashkentWeek(now).getTime() - 7 * DAY_MS),
  );
  const cursorDay = state?.cursor_at
    ? tashkentDay(new Date(state.cursor_at))
    : null;
  if (!cursorDay || cursorDay >= yesterday) {
    const isMonday = tashkentDay(startOfTashkentWeek(now)) === today;
    if (cursorDay && cursorDay >= yesterday) return { days: [] };
    return isMonday
      ? { days: [yesterday], weeks: [lastMonday] }
      : { days: [yesterday] };
  }
  const days: string[] = [];
  for (let d = addDays(cursorDay, 1); d <= yesterday; d = addDays(d, 1))
    days.push(d);
  const weeks: string[] = [];
  // Hafta yakshanbasi kursordan keyin bo'lsa — hali tekshirilmagan.
  for (let m = lastMonday; addDays(m, 6) > cursorDay; m = addDays(m, -7)) {
    weeks.unshift(m);
    if (weeks.length === 2) break;
  }
  return {
    days: days.slice(-ADVISOR_R6_CATCHUP_DAYS),
    ...(weeks.length ? { weeks } : {}),
  };
}

/** §5.1: `kind: system` — «Butun tizim». */
function subjectOf(c: AiAdvisorCandidate): AiAdvisorCandidate['subject'] {
  const subject = c.subject ?? { kind: 'system', id: null, name: null };
  return subject.kind === 'system' && !subject.name
    ? { ...subject, name: AI_ADVISOR_SYSTEM_SUBJECT_NAME }
    : subject;
}

function isCursorRule(k: AiAdvisorRuleKey): k is AiAdvisorCursorRule {
  return (AI_ADVISOR_CURSOR_RULES as readonly string[]).includes(k);
}

function dedupeFacts(
  list: AiAdvisorCandidate['fact_keys'],
): Array<{ fact_key: string; fact_at: Date }> {
  const out = new Map<string, Date>();
  for (const f of Array.isArray(list) ? list : []) {
    const key = typeof f?.fact_key === 'string' ? f.fact_key.slice(0, 200) : '';
    const at = new Date(f?.fact_at);
    if (key && !Number.isNaN(at.getTime()) && !out.has(key)) out.set(key, at);
  }
  return [...out.entries()].map(([fact_key, fact_at]) => ({
    fact_key,
    fact_at,
  }));
}

function maxFactAt(facts: Array<{ fact_at: Date }>): Date {
  return new Date(Math.max(...facts.map((f) => f.fact_at.getTime())));
}

function minFactAt(facts: Array<{ fact_at: Date }>): Date {
  return new Date(Math.min(...facts.map((f) => f.fact_at.getTime())));
}
