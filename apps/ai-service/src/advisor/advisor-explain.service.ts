import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AI_ADVISOR_AUTO_EXPLAIN_PER_TICK,
  AI_ADVISOR_ERROR_CODES,
  AI_ADVISOR_EXPLANATION_MAX,
  AI_ADVISOR_EXPLANATION_POLL_MS,
  AI_ADVISOR_EXPLANATION_STALE_MS,
  AI_ADVISOR_RULE_NAMES,
  AI_MODEL_DEFAULTS,
  ClaudeService,
  type AiAdvisorExplainResult,
  type AiAdvisorRequester,
  type AiAdvisorRuleKey,
} from '@app/common';
import { AiBudgetService } from '../budget/ai-budget.service';
import { sanitizeForModel } from '../assistant/assistant-sanitize';
import { effortParam } from '../usage/ai-pricing';
import { advisorError } from './advisor-errors';
import { AdvisorRealtime } from './advisor-realtime';
import { returnedRows } from './advisor-sql';

const ALERTS = 'ai_schema.ai_advisor_alerts';
/** Izoh promptining versiyasi (DB `kb_version`, REST'da yo'q). */
export const ADVISOR_KB_VERSION = 'advisor-v1';
const MAX_TOKENS = 1_200;
const EVIDENCE_ROWS_FOR_MODEL = 10;

/**
 * O'zgarmas system prompt — kesh prefiksi (dinamik qiymat YO'Q).
 * Yordamchi faqat tushuntiradi: pul amali taklif qilmaydi (§1).
 */
export const ADVISOR_EXPLAIN_SYSTEM = [
  "Sen «Elchi Pochta» kuryerlik kompaniyasining moliyaviy maslahatchisisan. Superadminga kassadagi xavfli holat bo'yicha QISQA izoh yozasan.",
  "Kirish — LLM'siz qoida (R1–R8) aniqlagan ogohlantirish: qoida, chegaralar, faktlar va dalillar (JSON).",
  'Javob — `explanation_md`: o‘zbek tilida (lotin), 60–150 so‘z, cheklangan markdown (qalin, ro‘yxat; HTML, havola, jadval YO‘Q).',
  'Tuzilma: 1) nima bo‘ldi — raqamlar bilan, faqat kirishdagi faktlardan; 2) ehtimoliy sabablar (2–3 ta, taxmin ekanini ayt); 3) nimani tekshirish kerak (2–3 qadam, qaysi bo‘limda).',
  'QOIDALAR: raqam, ism, sana o‘ylab topilmaydi — faqat kirishdagilar. Pul o‘tkazish, qaytarish, tuzatish kabi amallarni bajarishni TAKLIF QILMA — faqat qaysi bo‘limda ko‘rish kerakligini ayt. Ayblama: «ehtimol», «tekshirish kerak» de.',
  "Summalar: «1 024 000 so'm» (guruhlar bo'sh joy bilan), manfiy «−18 000 so'm».",
].join('\n');

export const ADVISOR_EXPLAIN_SCHEMA = {
  type: 'object',
  properties: { explanation_md: { type: 'string' } },
  required: ['explanation_md'],
  additionalProperties: false,
} as const;

interface ExplainRow {
  id: string;
  rule_key: AiAdvisorRuleKey;
  severity: string;
  status: string;
  title: string;
  facts: Record<string, unknown>;
  evidence: Record<string, unknown>;
  rule_snapshot: Record<string, unknown>;
  occurrences: number;
  explanation_status: string;
  explanation_md: string | null;
  explanation_requested_at: Date | null;
  explained_at: Date | null;
}

/**
 * Promptga ketadigan kirish — PII'siz (§3.5, BE-rev S14): chek oluvchi/
 * to'lovchi ismi, tranzaksiya raqami, telefon, izohlar chiqariladi; faqat
 * `*_last4`. `sanitizeForModel` telefonlarni maskalaydi va PII kalitlarini
 * tashlaydi.
 */
export function explainInput(row: ExplainRow): Record<string, unknown> {
  const evidence = { ...(row.evidence ?? {}) };
  if (Array.isArray(evidence.rows))
    evidence.rows = evidence.rows.slice(-EVIDENCE_ROWS_FOR_MODEL);
  if (evidence.receipt && typeof evidence.receipt === 'object') {
    const {
      recipient: _r,
      payer: _p,
      reference: _ref,
      ...rest
    } = evidence.receipt as Record<string, unknown>;
    void _r;
    void _p;
    void _ref;
    evidence.receipt = rest;
  }
  return sanitizeForModel({
    rule_key: row.rule_key,
    rule_name: AI_ADVISOR_RULE_NAMES[row.rule_key] ?? row.rule_key,
    severity: row.severity,
    title: row.title,
    thresholds:
      (row.rule_snapshot?.thresholds as Record<string, unknown>) ?? {},
    occurrences: Number(row.occurrences),
    facts: row.facts ?? {},
    evidence,
  }) as Record<string, unknown>;
}

/** Model javobini tozalash: HTML teglari olib tashlanadi, ≤ 2000. */
export function cleanExplanation(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return null;
  return text.length > AI_ADVISOR_EXPLANATION_MAX
    ? `${text.slice(0, AI_ADVISOR_EXPLANATION_MAX - 1)}…`
    : text;
}

/**
 * BE-5 (LhTIno57) — AI izohi (§6, §7.4). RMQ shifti 8 s — LLM sinxron
 * kutilmaydi: `POST explain` doim 202 (`pending` yoki tayyor `ready`),
 * natija fonda yoziladi; FE `GET :id` ni poll qiladi yoki realtime
 * `change: explanation` ni kutadi.
 *
 * - Budjet — OLDINDAN: umumiy kunlik AI shifti (`AiBudgetService.check()`,
 *   `scope: global`); o'qilmasa — 503 (fail-closed). Maslahatchi budjeti
 *   (`scope: advisor`) — BE-1 bilan.
 * - 429/503 `explanation_status` ni O'ZGARTIRMAYDI.
 * - Takroriy so'rov `pending` (3 daqiqadan yangi) — qayta navbat yo'q, pul
 *   ikkinchi marta ketmaydi; `ready` — keshdan, narx 0.
 * - Audit yozilmaydi — sarf `ai_usage_log` da (`feature: advisor_alert`).
 */
@Injectable()
export class AdvisorExplainService {
  private readonly logger = new Logger(AdvisorExplainService.name);
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly claude: ClaudeService,
    private readonly budget: AiBudgetService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly realtime?: AdvisorRealtime,
  ) {}

  model(): string {
    const raw = this.config?.get<unknown>('AI_ADVISOR_MODEL');
    const value = typeof raw === 'string' ? raw.trim() : '';
    return value || AI_MODEL_DEFAULTS.order;
  }

  private enabled(): boolean {
    const flag = String(this.config?.get<string>('AI_ADVISOR_EXPLAIN') ?? '')
      .trim()
      .toLowerCase();
    return !(flag === 'off' || flag === 'false' || flag === '0');
  }

  /** `POST alerts/:id/explain` (§7.4). */
  async request(
    requester: AiAdvisorRequester,
    id: string,
    now: Date = new Date(),
  ): Promise<AiAdvisorExplainResult> {
    const row = await this.find(id);
    if (row.status !== 'new' && row.status !== 'seen') {
      throw advisorError(
        409,
        AI_ADVISOR_ERROR_CODES.ALERT_CLOSED,
        'Yopilgan ogohlantirishga izoh so‘ralmaydi',
        {
          alert_status: row.status,
        },
      );
    }
    if (row.explanation_status === 'ready' && row.explanation_md) {
      return {
        alert_id: row.id,
        explanation_status: 'ready',
        explanation_md: row.explanation_md,
        explained_at: row.explained_at
          ? new Date(row.explained_at).toISOString()
          : null,
        cached: true,
        poll_after_ms: null,
      };
    }
    if (row.explanation_status === 'pending' && !isStale(row, now))
      return pending(row.id);

    await this.preflight(now);
    const queued = await this.markPending(row.id, now);
    if (queued) this.start(row.id, requester.id);
    return pending(row.id);
  }

  /**
   * Tick'dan keyin: yangi ochilgan `critical` (backfill emas) — darhol izoh,
   * ≤ 5 ta; 3 daqiqadan eski `pending` — bazada `failed` + `error` (§6).
   * Budjet tugagan / AI o'chiq — yozuvsiz (izohsiz qoladi, so'ralganda 429/503).
   */
  async autoExplain(
    now: Date = new Date(),
  ): Promise<{ queued: number; stale: number }> {
    const stale = returnedRows(
      await this.ds.query<unknown>(
        `UPDATE ${ALERTS}
          SET "explanation_status" = 'failed', "explanation_error" = 'error',
              "explanation_error_scope" = NULL, "explanation_retry_at" = NULL, "updatedAt" = now()
        WHERE "explanation_status" = 'pending'
          AND ("explanation_requested_at" IS NULL OR "explanation_requested_at" < $1)
        RETURNING "id"`,
        [new Date(now.getTime() - AI_ADVISOR_EXPLANATION_STALE_MS)],
      ),
    );
    if (!this.enabled() || !this.claude.isEnabled())
      return { queued: 0, stale: stale.length };
    try {
      if (!(await this.budget.check(now)).ok)
        return { queued: 0, stale: stale.length };
    } catch {
      return { queued: 0, stale: stale.length };
    }
    const rows = await this.ds.query<Array<{ id: string }>>(
      `SELECT "id"::text AS id FROM ${ALERTS}
        WHERE "severity" = 'critical' AND "status" IN ('new','seen') AND "is_deleted" = false
          AND "explanation_status" = 'none' AND "notify_skipped" IS NULL
        ORDER BY "id" DESC LIMIT ${AI_ADVISOR_AUTO_EXPLAIN_PER_TICK}`,
    );
    let queued = 0;
    for (const r of rows) {
      if (await this.markPending(r.id, now)) {
        queued += 1;
        this.start(r.id, null);
      }
    }
    return { queued, stale: stale.length };
  }

  /** Budjet va yoqilganlik — OLDINDAN (429 / 503). */
  private async preflight(now: Date): Promise<void> {
    if (!this.enabled()) {
      throw advisorError(
        503,
        AI_ADVISOR_ERROR_CODES.AI_DISABLED,
        'AI izohi o‘chirilgan',
        { reason: 'feature_disabled' },
      );
    }
    if (!this.claude.isEnabled()) {
      throw advisorError(
        503,
        AI_ADVISOR_ERROR_CODES.AI_DISABLED,
        'AI xizmati o‘chiq',
        { reason: 'ai_disabled' },
      );
    }
    let decision: Awaited<ReturnType<AiBudgetService['check']>>;
    try {
      decision = await this.budget.check(now);
    } catch {
      // Hisoblagich o'qilmadi — fail-closed (TZ B5 «O'qilmasa — AI o'chiq»).
      throw advisorError(
        503,
        AI_ADVISOR_ERROR_CODES.AI_DISABLED,
        'AI budjetini tekshirib bo‘lmadi',
        {
          reason: 'budget_unreadable',
        },
      );
    }
    if (!decision.ok) {
      const retry = Math.max(
        1,
        Math.min(
          86_400,
          Math.ceil((Date.parse(decision.reset_at) - now.getTime()) / 1000),
        ),
      );
      throw advisorError(
        429,
        AI_ADVISOR_ERROR_CODES.BUDGET_EXCEEDED,
        'Bugungi umumiy AI shifti tugadi',
        {
          scope: 'global',
          period: 'day',
          reset_at: decision.reset_at,
          retry_after_seconds: retry,
        },
      );
    }
  }

  /** Atomik navbat: faqat ochiq va (none | failed | eskirgan pending). */
  private async markPending(id: string, now: Date): Promise<boolean> {
    const rows = returnedRows(
      await this.ds.query<unknown>(
        `UPDATE ${ALERTS}
          SET "explanation_status" = 'pending', "explanation_requested_at" = $2,
              "explanation_error" = NULL, "explanation_error_scope" = NULL,
              "explanation_retry_at" = NULL, "updatedAt" = now()
        WHERE "id" = $1 AND "status" IN ('new','seen') AND "is_deleted" = false
          AND ("explanation_status" IN ('none','failed')
               OR ("explanation_status" = 'ready' AND "explanation_md" IS NULL)
               OR ("explanation_status" = 'pending'
                   AND ("explanation_requested_at" IS NULL OR "explanation_requested_at" < $3)))
        RETURNING "id"`,
        [id, now, new Date(now.getTime() - AI_ADVISOR_EXPLANATION_STALE_MS)],
      ),
    );
    return rows.length > 0;
  }

  private start(id: string, userId: string | null): void {
    if (this.inFlight.has(id)) return;
    const job = this.generate(id, userId)
      .catch((err: unknown) =>
        this.logger.error(
          `ai_advisor_explain_failed alert=${id}: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
        ),
      )
      .finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, job);
  }

  /** Fondagi generatsiyalar tugashini kutish (testlar, to'xtash). */
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight.values()]);
  }

  /** Fon generatsiyasi — natija faqat ayni `pending` navbatga yoziladi. */
  async generate(id: string, userId: string | null): Promise<void> {
    const row = await this.find(id);
    if (row.explanation_status !== 'pending' || !row.explanation_requested_at)
      return;
    const requestedAt = new Date(row.explanation_requested_at);
    const model = this.model();
    const result = await this.claude.extractJson<{ explanation_md?: unknown }>({
      system: ADVISOR_EXPLAIN_SYSTEM,
      userText: JSON.stringify(explainInput(row)),
      schema: ADVISOR_EXPLAIN_SCHEMA,
      meta: {
        feature: 'advisor_alert',
        requestArea: 'internal',
        marketId: null,
        userId,
        traceId: null,
        draftId: null,
      },
      model,
      maxTokens: MAX_TOKENS,
      ...effortParam(model, 'low'),
    });
    let set: Record<string, unknown>;
    if (result.ok) {
      const md = cleanExplanation(result.data?.explanation_md);
      set = md
        ? {
            explanation_status: 'ready',
            explanation_md: md,
            explained_at: new Date(),
            explanation_model: result.model.slice(0, 64),
            kb_version: ADVISOR_KB_VERSION,
            explanation_error: null,
          }
        : { explanation_status: 'failed', explanation_error: 'error' };
    } else if (result.reason === 'cap_exceeded') {
      set = {
        explanation_status: 'failed',
        explanation_error: 'budget_exceeded',
        explanation_error_scope: 'global',
        explanation_retry_at:
          'reset_at' in result ? new Date(result.reset_at) : null,
      };
    } else if (result.reason === 'disabled') {
      set = { explanation_status: 'failed', explanation_error: 'ai_disabled' };
    } else {
      set = { explanation_status: 'failed', explanation_error: 'error' };
    }
    const keys = Object.keys(set);
    const updated = returnedRows<{
      status: string;
      rule_key: string;
      severity: string;
    }>(
      await this.ds.query<unknown>(
        `UPDATE ${ALERTS}
          SET ${keys.map((k, i) => `"${k}" = $${i + 3}`).join(', ')}, "updatedAt" = now()
        WHERE "id" = $1 AND "explanation_status" = 'pending' AND "explanation_requested_at" = $2
        RETURNING "status", "rule_key", "severity"`,
        [id, requestedAt, ...keys.map((k) => set[k])],
      ),
    );
    if (updated.length) {
      this.realtime?.emit([
        {
          alert_id: id,
          rule_key: updated[0].rule_key,
          severity: updated[0].severity,
          status: updated[0].status,
          change: 'explanation',
          explanation_status: String(set.explanation_status),
          at: new Date().toISOString(),
        },
      ]);
    }
  }

  private async find(id: string): Promise<ExplainRow> {
    if (!/^\d{1,18}$/.test(String(id ?? ''))) {
      throw advisorError(
        404,
        AI_ADVISOR_ERROR_CODES.ALERT_NOT_FOUND,
        'Ogohlantirish topilmadi',
      );
    }
    const [row] = await this.ds.query<ExplainRow[]>(
      `SELECT "id"::text AS id, "rule_key", "severity", "status", "title", "facts", "evidence",
              "rule_snapshot", "occurrences", "explanation_status", "explanation_md",
              "explanation_requested_at", "explained_at"
         FROM ${ALERTS} WHERE "id" = $1 AND "is_deleted" = false`,
      [id],
    );
    if (!row)
      throw advisorError(
        404,
        AI_ADVISOR_ERROR_CODES.ALERT_NOT_FOUND,
        'Ogohlantirish topilmadi',
      );
    return row;
  }
}

function isStale(row: ExplainRow, now: Date): boolean {
  return (
    !row.explanation_requested_at ||
    now.getTime() - new Date(row.explanation_requested_at).getTime() >
      AI_ADVISOR_EXPLANATION_STALE_MS
  );
}

function pending(id: string): AiAdvisorExplainResult {
  return {
    alert_id: id,
    explanation_status: 'pending',
    explanation_md: null,
    explained_at: null,
    cached: false,
    poll_after_ms: AI_ADVISOR_EXPLANATION_POLL_MS,
  };
}
