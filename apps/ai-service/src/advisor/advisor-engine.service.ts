import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import {
  AI_ADVISOR_CURSOR_RULES,
  aiAdvisorThresholds,
  type AiAdvisorCandidate,
  type AiAdvisorCursorRule,
  type AiAdvisorRuleInputsRequest,
  type AiAdvisorRuleKey,
  type AiAdvisorRulesSettings,
} from '@app/common';
import { AdvisorReader } from './advisor-reader';
import { AdvisorSettingsService } from './advisor-settings.service';
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
export const ADVISOR_CURSOR_OVERLAP_MS = 5 * 60_000;
export const ADVISOR_BACKFILL_WINDOW_MS = 7 * 24 * 3600_000;
export const ADVISOR_BACKFILL_NOTIFY_MS = 24 * 3600_000;

const TASHKENT_MS = 5 * 3600_000;
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
}

interface OpenAlertRow {
  id: string;
}

const tashkentDay = (d: Date) =>
  new Date(d.getTime() + TASHKENT_MS).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Toshkent hafta kuni: 1 = dushanba … 7 = yakshanba. */
const tashkentIsoWeekday = (d: Date) => {
  const wd = new Date(d.getTime() + TASHKENT_MS).getUTCDay();
  return wd === 0 ? 7 : wd;
};

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
      const today = tashkentDay(now);
      request.periods = { days: [addDays(today, -1)] };
      if (tashkentIsoWeekday(now) === 1)
        request.periods.weeks = [addDays(today, -7)];
    }

    try {
      const response = await this.reader.ruleInputs(request);
      const candidates = (response?.candidates ?? []).filter((c) =>
        keys.includes(c.rule_key),
      );
      result.candidates = candidates.length;
      for (const c of candidates) {
        const firstRun = !states.get(c.rule_key)?.first_run_at;
        // Bitta buzuq nomzod butun tick'ni (va kursorni) to'xtatmasin.
        try {
          const outcome = await this.apply(c, rules, now, firstRun);
          if (outcome !== 'noop') result[outcome] += 1;
        } catch (error) {
          result.failed += 1;
          this.logger.error(
            `ai_advisor_apply_failed rule=${c.rule_key} dedup=${String(c.dedup_key).slice(0, 80)}: ${
              error instanceof Error ? error.message.slice(0, 200) : 'unknown'
            }`,
          );
        }
      }
      await this.saveStates(
        keys,
        now,
        response?.cursors ?? {},
        candidates,
        'ok',
        null,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.saveStates(keys, now, {}, [], 'error', message).catch(
        () => undefined,
      );
      throw error;
    }
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
      const open = await m.query<OpenAlertRow[]>(
        `SELECT "id"::text AS id FROM ${ALERTS}
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
      const present = this.presentation(c);

      if (open.length) {
        const alertId = open[0].id;
        if (fresh.length) {
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
        if (ADVISOR_STATE_RULES.has(c.rule_key)) {
          await m.query(
            `UPDATE ${ALERTS}
                SET "last_at" = $2, "last_fact_at" = GREATEST(COALESCE("last_fact_at", $3), $3),
                    "title" = $4, "facts" = $5::jsonb, "evidence" = $6::jsonb, "links" = $7::jsonb,
                    "subject" = $8::jsonb, "branch" = $9::jsonb, "branch_id" = $10,
                    "headline_amount" = $11, "updatedAt" = now()
              WHERE "id" = $1`,
            [alertId, now, now, ...present],
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
          minFactAt(fresh),
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
      JSON.stringify(c.subject ?? { kind: 'system', id: null, name: null }),
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
      `SELECT "rule_key", "cursor_at", "first_run_at" FROM ${STATE_TABLE} WHERE "rule_key" = ANY($1::text[])`,
      [[...keys]],
    );
    return new Map(rows.map((r) => [r.rule_key, r]));
  }

  private async saveStates(
    keys: readonly AiAdvisorRuleKey[],
    now: Date,
    cursors: Partial<Record<AiAdvisorCursorRule, string | null>>,
    candidates: AiAdvisorCandidate[],
    status: 'ok' | 'error',
    error: string | null,
  ): Promise<void> {
    for (const k of keys) {
      // Yangi qator ko'rilmasa — «shu lahzagacha ko'rildi» (keyingi tick
      // kursor − 5 daqiqadan boshlaydi, kech commit'lar ham qamraladi).
      const cursor =
        isCursorRule(k) && status === 'ok'
          ? (cursors[k] ?? now.toISOString())
          : null;
      const count = candidates.filter((c) => c.rule_key === k).length;
      // Kursor faqat oldinga siljiydi; birinchi muvaffaqiyatli ishdan keyin
      // `first_run_at` qo'yiladi (§4.3 backfill tugadi).
      await this.ds.query(
        `INSERT INTO ${STATE_TABLE} ("rule_key", "cursor_at", "first_run_at", "last_run_at",
                                     "last_status", "last_error", "last_candidates")
         VALUES ($1, $2::timestamptz, CASE WHEN $5::text = 'ok' THEN $3::timestamptz END, $3, $5::text, $6, $4)
         ON CONFLICT ("rule_key") DO UPDATE SET
           "cursor_at" = GREATEST(${STATE_TABLE.split('.')[1]}."cursor_at", EXCLUDED."cursor_at"),
           "first_run_at" = COALESCE(${STATE_TABLE.split('.')[1]}."first_run_at", EXCLUDED."first_run_at"),
           "last_run_at" = EXCLUDED."last_run_at",
           "last_status" = EXCLUDED."last_status",
           "last_error" = EXCLUDED."last_error",
           "last_candidates" = EXCLUDED."last_candidates",
           "updatedAt" = now()`,
        [k, cursor, now, count, status, error ? error.slice(0, 300) : null],
      );
    }
  }
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
