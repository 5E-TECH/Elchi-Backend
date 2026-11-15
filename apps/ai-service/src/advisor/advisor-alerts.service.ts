import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  AI_ADVISOR_ALERT_STATUSES,
  AI_ADVISOR_ERROR_CODES,
  AI_ADVISOR_EXPLANATION_POLL_MS,
  AI_ADVISOR_EXPLANATION_STALE_MS,
  AI_ADVISOR_HISTORY_LIMIT,
  AI_ADVISOR_LIST_STATUSES,
  AI_ADVISOR_NOTE_MAX,
  AI_ADVISOR_NOTE_MIN,
  AI_ADVISOR_RULE_KEYS,
  AI_ADVISOR_RULE_NAMES,
  AI_ADVISOR_SEVERITIES,
  AI_ADVISOR_SORT_FIELDS,
  ActivityLogService,
  type AiAdvisorAlertDetail,
  type AiAdvisorAlertHistoryEvent,
  type AiAdvisorAlertListData,
  type AiAdvisorAlertListItem,
  type AiAdvisorAlertStatus,
  type AiAdvisorAlertsQuery,
  type AiAdvisorOverviewData,
  type AiAdvisorRequester,
  type AiAdvisorRuleKey,
  type AiAdvisorUserRef,
} from '@app/common';
import { advisorError } from './advisor-errors';

const ALERTS = 'ai_schema.ai_advisor_alerts';
const OCC = 'ai_schema.ai_advisor_alert_occurrences';
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;

/** DB qatori (faqat REST'ga kerakli ustunlar; `explanation_model`/`kb_version` YO'Q). */
export interface AlertRow {
  id: string;
  rule_key: AiAdvisorRuleKey;
  severity: string;
  status: AiAdvisorAlertStatus;
  title: string;
  branch: Record<string, unknown> | null;
  subject: Record<string, unknown>;
  headline_amount: string | number | null;
  facts: Record<string, unknown>;
  evidence: Record<string, unknown>;
  links: unknown[];
  rule_snapshot: Record<string, unknown>;
  occurrences: number;
  first_at: Date;
  last_at: Date;
  first_fact_at: Date | null;
  last_fact_at: Date | null;
  explanation_status: string;
  explanation_md: string | null;
  explanation_error: string | null;
  explanation_error_scope: string | null;
  explanation_retry_at: Date | null;
  explanation_requested_at: Date | null;
  explained_at: Date | null;
  seen_at: Date | null;
  seen_by: string | null;
  seen_by_name: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolution_note: string | null;
  reopened_from_id: string | null;
}

const SELECT = `
  "id"::text AS id, "rule_key", "severity", "status", "title", "branch", "subject",
  "headline_amount", "facts", "evidence", "links", "rule_snapshot", "occurrences",
  "first_at", "last_at", "first_fact_at", "last_fact_at", "explanation_status",
  "explanation_md", "explanation_error", "explanation_error_scope", "explanation_retry_at",
  "explanation_requested_at", "explained_at", "seen_at", "seen_by"::text AS seen_by,
  "seen_by_name", "resolved_at", "resolved_by"::text AS resolved_by, "resolved_by_name",
  "resolution_note", "reopened_from_id"::text AS reopened_from_id`;

const isoOrNull = (d: Date | string | null | undefined) =>
  d === null || d === undefined ? null : new Date(d).toISOString();
const userRef = (
  id: string | null,
  name: string | null,
): AiAdvisorUserRef | null => (id ? { id, name: name ?? null } : null);
/**
 * Aniq kalendar kuni: `YYYY-MM-DD`, aylanib o'tmaydi (2026-02-30 → yo'q) va
 * yil ≥ 2000 — Postgres 22008 → 500 bo'lmasin (round-2 #654 S1).
 */
export const isDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return (
    !Number.isNaN(d.getTime()) &&
    d.getUTCFullYear() >= 2000 &&
    d.toISOString().slice(0, 10) === v
  );
};
/** C0 boshqaruv belgilari (\n, \t dan tashqari) va DEL — Postgres U+0000 ni rad etadi. */
// eslint-disable-next-line no-control-regex -- ataylab: boshqaruv belgilarini rad etish
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** Ro'yxat ustunlari — `toListItem` o'qiydiganlari (round-2 #654 S4). */
const LIST_SELECT = `
  "id"::text AS id, "rule_key", "severity", "status", "title", "branch", "subject",
  "headline_amount", "facts", "occurrences", "first_at", "last_at", "first_fact_at",
  "last_fact_at", "explanation_status", "explanation_requested_at",
  "reopened_from_id"::text AS reopened_from_id`;

/**
 * `pending` izoh 3 daqiqadan oshsa — `failed` + `error` deb ko'rsatiladi
 * (restart/deploy `pending` ni yetim qoldirishi mumkin, §6). Bazaga
 * 5-qismdagi tick yozadi; GET faqat ko'rinishni o'zgartiradi.
 */
export function effectiveExplanation(
  row: AlertRow,
  now: Date,
): {
  status: AiAdvisorAlertListItem['explanation_status'];
  error: AiAdvisorAlertDetail['explanation_error'];
} {
  const status =
    row.explanation_status as AiAdvisorAlertListItem['explanation_status'];
  if (
    status === 'pending' &&
    (!row.explanation_requested_at ||
      now.getTime() - new Date(row.explanation_requested_at).getTime() >
        AI_ADVISOR_EXPLANATION_STALE_MS)
  ) {
    return { status: 'failed', error: 'error' };
  }
  return {
    status,
    error:
      status === 'failed'
        ? ((row.explanation_error as AiAdvisorAlertDetail['explanation_error']) ??
          'error')
        : null,
  };
}

export function toListItem(row: AlertRow, now: Date): AiAdvisorAlertListItem {
  return {
    id: row.id,
    rule_key: row.rule_key,
    severity: row.severity as AiAdvisorAlertListItem['severity'],
    status: row.status,
    title: row.title,
    branch: (row.branch as AiAdvisorAlertListItem['branch']) ?? null,
    subject: row.subject as unknown as AiAdvisorAlertListItem['subject'],
    headline_amount:
      row.headline_amount === null ? null : Number(row.headline_amount),
    facts: row.facts ?? {},
    occurrences: Number(row.occurrences),
    first_at: new Date(row.first_at).toISOString(),
    last_at: new Date(row.last_at).toISOString(),
    first_fact_at: isoOrNull(row.first_fact_at),
    last_fact_at: isoOrNull(row.last_fact_at),
    explanation_status: effectiveExplanation(row, now).status,
    reopened_from_id: row.reopened_from_id ?? null,
  };
}

/**
 * Izoh validatsiyasi (§7.5): trim; faqat bo'sh joy → null. `resolved` —
 * majburiy 3–500; `dismissed` — ixtiyoriy, ≤ 500.
 */
export function normalizeNote(
  status: 'resolved' | 'dismissed',
  note: unknown,
): string | null {
  const fail = (
    reason: 'required' | 'too_short' | 'too_long',
    message: string,
  ) =>
    advisorError(400, AI_ADVISOR_ERROR_CODES.NOTE_INVALID, message, {
      reason,
      min_length: AI_ADVISOR_NOTE_MIN,
      max_length: AI_ADVISOR_NOTE_MAX,
    });
  if (note !== undefined && note !== null && typeof note !== 'string') {
    throw fail('required', "Izoh matn bo'lishi kerak");
  }
  if (typeof note === 'string' && CONTROL_CHARS.test(note)) {
    throw new BadRequestException('Izohda ruxsat etilmagan belgi bor');
  }
  const text = typeof note === 'string' ? note.trim() : '';
  if (text.length > AI_ADVISOR_NOTE_MAX) {
    throw fail('too_long', `Izoh ${AI_ADVISOR_NOTE_MAX} belgidan oshmasin`);
  }
  if (status === 'resolved') {
    if (!text) throw fail('required', '«Hal qilindi» uchun izoh majburiy');
    if (text.length < AI_ADVISOR_NOTE_MIN) {
      throw fail(
        'too_short',
        `Izoh kamida ${AI_ADVISOR_NOTE_MIN} belgi bo'lsin`,
      );
    }
  }
  return text || null;
}

/**
 * BE-5 (LhTIno57) — ogohlantirishlar REST'i (§5, §7.1–7.3, §7.5).
 * Faqat o'qish va holat; pul amali yo'q (faqat bo'limga havola).
 */
@Injectable()
export class AdvisorAlertsService {
  private readonly logger = new Logger(AdvisorAlertsService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly activityLog: ActivityLogService,
  ) {}

  // ─── overview (§5.5) ──────────────────────────────────────────────────

  async overview(now: Date = new Date()): Promise<AiAdvisorOverviewData> {
    const [counts] = await this.ds.query<
      Array<{
        new: string;
        open: string;
        critical: string;
        critical_open: string;
      }>
    >(
      `SELECT COUNT(*) FILTER (WHERE "status" = 'new') AS new,
              COUNT(*) AS open,
              COUNT(*) FILTER (WHERE "status" = 'new' AND "severity" = 'critical') AS critical,
              COUNT(*) FILTER (WHERE "severity" = 'critical') AS critical_open
         FROM ${ALERTS}
        WHERE "is_deleted" = false AND "status" IN ('new','seen')`,
    );
    const keys = async (statuses: string[]) =>
      (
        await this.ds.query<Array<{ rule_key: AiAdvisorRuleKey }>>(
          `SELECT "rule_key" FROM ${ALERTS}
            WHERE "is_deleted" = false AND "severity" = 'critical' AND "status" = ANY($1::text[])
            GROUP BY "rule_key" ORDER BY MAX("last_at") DESC, "rule_key"`,
          [statuses],
        )
      ).map((r) => r.rule_key);
    return {
      alerts: {
        new: Number(counts?.new ?? 0),
        open: Number(counts?.open ?? 0),
        critical: Number(counts?.critical ?? 0),
        critical_open: Number(counts?.critical_open ?? 0),
        critical_rule_keys: await keys(['new']),
        critical_open_rule_keys: await keys(['new', 'seen']),
      },
      recommendations: null,
      budget: null,
      usd_uzs_rate: null,
      generated_at: now.toISOString(),
    };
  }

  // ─── ro'yxat (§7.2) ───────────────────────────────────────────────────

  async list(
    query: AiAdvisorAlertsQuery = {},
    now: Date = new Date(),
  ): Promise<AiAdvisorAlertListData> {
    const q = parseQuery(query);
    const where: string[] = ['"is_deleted" = false'];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.severity) add('"severity" = ?', q.severity);
    if (q.rule_key) add('"rule_key" = ?', q.rule_key);
    if (q.from)
      add(
        `"last_at" >= (?::date::timestamp AT TIME ZONE 'Asia/Tashkent')`,
        q.from,
      );
    if (q.to)
      add(
        `"last_at" < ((?::date + 1)::timestamp AT TIME ZONE 'Asia/Tashkent')`,
        q.to,
      );
    if (q.q) {
      add(
        `("title" ILIKE ? OR "subject"->>'name' ILIKE $${params.length + 1} OR "branch"->>'name' ILIKE $${params.length + 1})`,
        `%${escapeLike(q.q)}%`,
      );
    }
    // Segment sonlari — `status` filtrisiz, qolgan filtrlar bilan.
    const countRows = await this.ds.query<
      Array<{ status: AiAdvisorAlertStatus; n: string }>
    >(
      `SELECT "status", COUNT(*) AS n FROM ${ALERTS} WHERE ${where.join(' AND ')} GROUP BY "status"`,
      params,
    );
    const byStatus = Object.fromEntries(
      AI_ADVISOR_ALERT_STATUSES.map((s) => [s, 0]),
    ) as Record<AiAdvisorAlertStatus, number>;
    for (const r of countRows)
      if (r.status in byStatus) byStatus[r.status] = Number(r.n);

    if (q.status === 'open') where.push(`"status" IN ('new','seen')`);
    else if (q.status) add('"status" = ?', q.status);

    const dir = q.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const order =
      q.sort_by === 'severity'
        ? `CASE WHEN "severity" = 'critical' THEN 0 ELSE 1 END ${dir === 'DESC' ? 'ASC' : 'DESC'}, "last_at" DESC`
        : `"${q.sort_by}" ${dir}`;
    // Jami — segment sonlaridan (bitta skan kam, ikkalasi bir-biriga mos).
    const totalN =
      q.status === 'open'
        ? byStatus.new + byStatus.seen
        : q.status
          ? byStatus[q.status]
          : Object.values(byStatus).reduce((a, b) => a + b, 0);
    const offset = (q.page - 1) * q.limit;
    const rows =
      offset >= totalN
        ? []
        : await this.ds.query<AlertRow[]>(
            `SELECT ${LIST_SELECT} FROM ${ALERTS} WHERE ${where.join(' AND ')}
              ORDER BY ${order}, "id" DESC
              LIMIT ${q.limit} OFFSET ${offset}`,
            params,
          );
    return {
      items: rows.map((r) => toListItem(r, now)),
      meta: {
        page: q.page,
        limit: q.limit,
        total: totalN,
        totalPages: Math.max(1, Math.ceil(totalN / q.limit)),
      },
      counts: { by_status: byStatus },
    };
  }

  // ─── tafsilot (§7.3): ochilganda `new → seen` ──────────────────────────

  async get(
    requester: AiAdvisorRequester,
    id: string,
    options: { mark_seen?: boolean; include?: string[] } = {},
    now: Date = new Date(),
  ): Promise<AiAdvisorAlertDetail> {
    const alertId = parseId(id);
    if (options.mark_seen !== false) {
      // Atomik: faqat `new` bo'lsa; boshqa holatga tegmaydi; audit yo'q (EGA-1029/2).
      await this.ds.query(
        `UPDATE ${ALERTS}
            SET "status" = 'seen', "seen_at" = $2, "seen_by" = $3, "seen_by_name" = $4, "updatedAt" = now()
          WHERE "id" = $1 AND "status" = 'new' AND "is_deleted" = false`,
        [alertId, now, requester.id, nameOf(requester)],
      );
    }
    const row = await this.findRow(alertId);
    return this.toDetail(row, now, (options.include ?? []).includes('history'));
  }

  // ─── holat (§7.5): «Hal qilindi» / «Ahamiyatsiz» ───────────────────────

  async update(
    requester: AiAdvisorRequester,
    id: string,
    status: unknown,
    note: unknown,
    now: Date = new Date(),
  ): Promise<AiAdvisorAlertDetail> {
    const alertId = parseId(id);
    if (status !== 'resolved' && status !== 'dismissed') {
      throw new BadRequestException("status noto'g'ri");
    }
    let text: string | null = null;
    const outcome = await this.ds.transaction(async (m) => {
      const [row] = await m.query<AlertRow[]>(
        `SELECT ${SELECT} FROM ${ALERTS} WHERE "id" = $1 AND "is_deleted" = false FOR UPDATE`,
        [alertId],
      );
      if (!row) throw notFound();
      if (row.status === status && row.resolved_by === requester.id) {
        // Idempotent: ayni foydalanuvchi ayni holat — 200, o'zgarishsiz, audit yo'q.
        return { changed: false, before: row };
      }
      if (row.status !== 'new' && row.status !== 'seen') {
        throw advisorError(
          409,
          AI_ADVISOR_ERROR_CODES.ALERT_CLOSED,
          'Ogohlantirish allaqachon yopilgan',
          {
            alert_status: row.status,
          },
        );
      }
      // Izoh — holat haqiqatan o'zgarganda tekshiriladi: idempotent takror
      // 200, yopilgan — 409 (izoh xatosidan oldin; round-2 #654).
      text = normalizeNote(status, note);
      await m.query(
        `UPDATE ${ALERTS}
            SET "status" = $2, "resolved_at" = $3, "resolved_by" = $4, "resolved_by_name" = $5,
                "resolution_note" = $6, "updatedAt" = now()
          WHERE "id" = $1`,
        [alertId, status, now, requester.id, nameOf(requester), text],
      );
      return { changed: true, before: row };
    });
    if (outcome.changed)
      await this.audit(requester, outcome.before, status, text);
    return this.toDetail(await this.findRow(alertId), now, false);
  }

  private async audit(
    requester: AiAdvisorRequester,
    row: AlertRow,
    status: 'resolved' | 'dismissed',
    note: string | null,
  ): Promise<void> {
    try {
      const where = nameFrom(row.branch) ?? nameFrom(row.subject);
      const rule = AI_ADVISOR_RULE_NAMES[row.rule_key] ?? row.rule_key;
      await this.activityLog.log({
        entity_type: 'ai_advisor_alert',
        entity_id: row.id,
        action:
          status === 'resolved'
            ? 'ai.advisor.alert.resolve'
            : 'ai.advisor.alert.dismiss',
        old_value: { status: row.status },
        new_value: { status, resolution_note: note },
        user_id: requester.id,
        user_name: requester.name ?? null,
        user_role: requester.roles.join(',').slice(0, 32) || null,
        metadata: {
          rule_key: row.rule_key,
          severity: row.severity,
          occurrences: Number(row.occurrences),
        },
        description:
          `AI ogohlantirish #${row.id} ${status === 'resolved' ? 'hal qilindi' : 'ahamiyatsiz deb belgilandi'} — ${rule}` +
          (where ? `, ${where}` : ''),
      });
    } catch (err) {
      // Audit best-effort (§11): haqiqat manbai — ogohlantirish qatori.
      this.logger.warn(
        `ai_advisor_alert_audit_failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  private async findRow(id: string): Promise<AlertRow> {
    const [row] = await this.ds.query<AlertRow[]>(
      `SELECT ${SELECT} FROM ${ALERTS} WHERE "id" = $1 AND "is_deleted" = false`,
      [id],
    );
    if (!row) throw notFound();
    return row;
  }

  private async toDetail(
    row: AlertRow,
    now: Date,
    withHistory: boolean,
  ): Promise<AiAdvisorAlertDetail> {
    const item = toListItem(row, now);
    const expl = effectiveExplanation(row, now);
    const snapshot = row.rule_snapshot ?? {};
    let reopenedFrom: AiAdvisorAlertDetail['reopened_from'] = null;
    if (row.reopened_from_id) {
      const [prev] = await this.ds.query<
        Array<{
          id: string;
          status: AiAdvisorAlertStatus;
          resolved_at: Date | null;
        }>
      >(
        `SELECT "id"::text AS id, "status", "resolved_at" FROM ${ALERTS} WHERE "id" = $1`,
        [row.reopened_from_id],
      );
      if (prev)
        reopenedFrom = {
          id: prev.id,
          status: prev.status,
          resolved_at: isoOrNull(prev.resolved_at),
        };
    }
    const budget = expl.error === 'budget_exceeded';
    const detail: AiAdvisorAlertDetail = {
      ...item,
      rule: {
        key: row.rule_key,
        severity: ((snapshot.severity as string) ??
          row.severity) as AiAdvisorAlertDetail['rule']['severity'],
        thresholds: (snapshot.thresholds as Record<string, number>) ?? {},
      },
      evidence: row.evidence ?? {},
      links: (row.links as AiAdvisorAlertDetail['links']) ?? [],
      explanation_md: expl.status === 'ready' ? row.explanation_md : null,
      explanation_error: expl.error,
      explanation_error_scope: budget
        ? (row.explanation_error_scope as 'advisor' | 'global' | null)
        : null,
      explanation_retry_at: budget ? isoOrNull(row.explanation_retry_at) : null,
      explanation_requested_at: isoOrNull(row.explanation_requested_at),
      explanation_poll_after_ms:
        expl.status === 'pending' ? AI_ADVISOR_EXPLANATION_POLL_MS : null,
      explained_at:
        expl.status === 'ready' ? isoOrNull(row.explained_at) : null,
      seen_at: isoOrNull(row.seen_at),
      seen_by: userRef(row.seen_by, row.seen_by_name),
      resolved_at: isoOrNull(row.resolved_at),
      resolved_by: userRef(row.resolved_by, row.resolved_by_name),
      resolution_note: row.resolution_note ?? null,
      reopened_from: reopenedFrom,
    };
    if (withHistory) detail.history = await this.history(row);
    return detail;
  }

  /** Hayot sikli (≤ 50, eskisi birinchi; ko'p bo'lsa — eng yangilari). */
  private async history(row: AlertRow): Promise<AiAdvisorAlertHistoryEvent[]> {
    const occ = await this.ds.query<Array<{ occurred_at: Date }>>(
      `SELECT "occurred_at" FROM ${OCC} WHERE "alert_id" = $1 ORDER BY "occurred_at", "id"`,
      [row.id],
    );
    const events: AiAdvisorAlertHistoryEvent[] = [];
    const seenAt = new Set<number>();
    occ.forEach((o, i) => {
      const t = new Date(o.occurred_at).getTime();
      // Bir tick'da bir nechta fakt — bitta hodisa.
      if (i > 0 && seenAt.has(t)) return;
      seenAt.add(t);
      events.push({
        at: new Date(t).toISOString(),
        event: i === 0 ? 'opened' : 'occurred',
        by: null,
        note: null,
      });
    });
    if (!occ.length)
      events.push({
        at: new Date(row.first_at).toISOString(),
        event: 'opened',
        by: null,
        note: null,
      });
    if (row.seen_at) {
      events.push({
        at: new Date(row.seen_at).toISOString(),
        event: 'seen',
        by: userRef(row.seen_by, row.seen_by_name),
        note: null,
      });
    }
    if (row.explained_at && row.explanation_status === 'ready') {
      events.push({
        at: new Date(row.explained_at).toISOString(),
        event: 'explained',
        by: null,
        note: null,
      });
    }
    if (
      row.resolved_at &&
      (row.status === 'resolved' || row.status === 'dismissed')
    ) {
      events.push({
        at: new Date(row.resolved_at).toISOString(),
        event: row.status,
        by: userRef(row.resolved_by, row.resolved_by_name),
        note: row.resolution_note ?? null,
      });
    }
    events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return events.length > AI_ADVISOR_HISTORY_LIMIT
      ? [events[0], ...events.slice(-(AI_ADVISOR_HISTORY_LIMIT - 1))]
      : events;
  }
}

function notFound() {
  return advisorError(
    404,
    AI_ADVISOR_ERROR_CODES.ALERT_NOT_FOUND,
    'Ogohlantirish topilmadi',
  );
}

function parseId(id: unknown): string {
  const s = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
  if (!/^\d{1,18}$/.test(s))
    throw new BadRequestException("Ogohlantirish ID si noto'g'ri");
  return s;
}

function nameOf(r: AiAdvisorRequester): string | null {
  return r.name ? String(r.name).slice(0, 200) : null;
}

function nameFrom(ref: unknown): string | null {
  const r = ref as { name?: unknown } | null | undefined;
  return r && typeof r.name === 'string' && r.name.trim()
    ? r.name.trim()
    : null;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Gateway class-validator'dan o'tgan so'rov — ai-service ham qayta tekshiradi. */
function parseQuery(
  query: AiAdvisorAlertsQuery,
): Required<
  Pick<AiAdvisorAlertsQuery, 'page' | 'limit' | 'sort_by' | 'sort_dir'>
> &
  AiAdvisorAlertsQuery {
  const bad = (field: string) => new BadRequestException(`${field} noto'g'ri`);
  const out: ReturnType<typeof parseQuery> = {
    page: 1,
    limit: 20,
    sort_by: 'last_at',
    sort_dir: 'desc',
  };
  const q = query ?? {};
  if (q.status !== undefined) {
    if (!(AI_ADVISOR_LIST_STATUSES as readonly string[]).includes(q.status))
      throw bad('status');
    out.status = q.status;
  }
  if (q.severity !== undefined) {
    if (!(AI_ADVISOR_SEVERITIES as readonly string[]).includes(q.severity))
      throw bad('severity');
    out.severity = q.severity;
  }
  if (q.rule_key !== undefined) {
    if (!(AI_ADVISOR_RULE_KEYS as readonly string[]).includes(q.rule_key))
      throw bad('rule_key');
    out.rule_key = q.rule_key;
  }
  if (q.from !== undefined) {
    if (!isDay(q.from)) throw bad('from');
    out.from = q.from;
  }
  if (q.to !== undefined) {
    if (!isDay(q.to)) throw bad('to');
    out.to = q.to;
  }
  if (out.from && out.to) {
    const span =
      (Date.parse(`${out.to}T00:00:00Z`) -
        Date.parse(`${out.from}T00:00:00Z`)) /
      DAY_MS;
    // ≤ 366 Toshkent kuni (ikkala chet kiradi).
    if (span < 0 || span >= MAX_RANGE_DAYS) throw bad('from/to');
  }
  if (q.q !== undefined && q.q !== null) {
    const text = String(q.q).trim();
    if (text.length > 100 || CONTROL_CHARS.test(text)) throw bad('q');
    if (text) out.q = text;
  }
  if (q.sort_by !== undefined) {
    if (!(AI_ADVISOR_SORT_FIELDS as readonly string[]).includes(q.sort_by))
      throw bad('sort_by');
    out.sort_by = q.sort_by;
  }
  if (q.sort_dir !== undefined) {
    if (q.sort_dir !== 'asc' && q.sort_dir !== 'desc') throw bad('sort_dir');
    out.sort_dir = q.sort_dir;
  }
  const int = (v: unknown, min: number, max: number, field: string) => {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
      throw bad(field);
    return n;
  };
  if (q.page !== undefined) out.page = int(q.page, 1, 1_000_000, 'page');
  if (q.limit !== undefined) out.limit = int(q.limit, 1, 100, 'limit');
  return out;
}
