/**
 * BE-5 (LhTIno57) — AI maslahatchi: ogohlantirishlar R1–R8.
 *
 * gateway ↔ ai-service RMQ shartnomasi (`ai.advisor.*`), xato kodlari va
 * qoidalar sozlamasining YAGONA manbai: sukutlar, chegaralar (`limits`) —
 * FE forma validatsiyasi (`GET settings.limits`) va ai-service tekshiruvi
 * shu jadvaldan. API shartnomasi v0.3 (§7.6–7.7, §8).
 *
 * ⚠️ Faqat superadmin (ega qarori 1). Gateway `RolesGuard` + ai-service
 * `requester.roles` ni qayta tekshiradi (ikki qavat).
 */

export const AI_ADVISOR_RULE_KEYS = [
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
] as const;
export type AiAdvisorRuleKey = (typeof AI_ADVISOR_RULE_KEYS)[number];

export const AI_ADVISOR_SEVERITIES = ['warning', 'critical'] as const;
export type AiAdvisorSeverity = (typeof AI_ADVISOR_SEVERITIES)[number];

export const AI_ADVISOR_ALERT_STATUSES = [
  'new',
  'seen',
  'resolved',
  'dismissed',
] as const;
export type AiAdvisorAlertStatus = (typeof AI_ADVISOR_ALERT_STATUSES)[number];

export const AI_ADVISOR_EXPLANATION_STATUSES = [
  'none',
  'pending',
  'ready',
  'failed',
] as const;
export type AiAdvisorExplanationStatus =
  (typeof AI_ADVISOR_EXPLANATION_STATUSES)[number];

/** RMQ buyruqlari (gateway → ai-service). */
export const AI_ADVISOR_PATTERNS = {
  SETTINGS_GET: 'ai.advisor.settings.get',
  SETTINGS_UPDATE: 'ai.advisor.settings.update',
  OVERVIEW: 'ai.advisor.overview',
  ALERTS_LIST: 'ai.advisor.alerts.list',
  ALERTS_GET: 'ai.advisor.alerts.get',
  ALERTS_UPDATE: 'ai.advisor.alerts.update',
} as const;

/** Xato kodlari (`PUBLIC_ERROR_CODES` da ruxsat etilgan maydonlari bilan). */
export const AI_ADVISOR_ERROR_CODES = {
  /** 404 */
  ALERT_NOT_FOUND: 'AI_ADVISOR_ALERT_NOT_FOUND',
  /** 409 `{alert_status}` */
  ALERT_CLOSED: 'AI_ADVISOR_ALERT_CLOSED',
  /** 400 `{reason: required|too_short|too_long, min_length, max_length}` */
  NOTE_INVALID: 'AI_ADVISOR_NOTE_INVALID',
  /** 400 `{field, min, max}` — chegara `limits` dan tashqarida. */
  INVALID_RULE: 'AI_ADVISOR_INVALID_RULE',
  /** 400 `{field}` — noma'lum kalit, `version` yo'q, o'zgarmaydigan maydon. */
  INVALID_SETTING: 'AI_ADVISOR_INVALID_SETTING',
  /** 409 `{version}` — eskirgan `version` (optimistik qulf). */
  SETTINGS_CONFLICT: 'AI_ADVISOR_SETTINGS_CONFLICT',
  /** 429 `{scope, period, reset_at, retry_after_seconds}` */
  BUDGET_EXCEEDED: 'AI_ADVISOR_BUDGET_EXCEEDED',
  /** 503 `{reason}` */
  AI_DISABLED: 'AI_ADVISOR_AI_DISABLED',
} as const;
export type AiAdvisorErrorCode =
  (typeof AI_ADVISOR_ERROR_CODES)[keyof typeof AI_ADVISOR_ERROR_CODES];

/** `PUBLIC_ERROR_CODES` uchun: kod → javobga chiqadigan maydonlar. */
export const AI_ADVISOR_PUBLIC_ERROR_FIELDS: Readonly<
  Record<AiAdvisorErrorCode, readonly string[]>
> = Object.freeze({
  AI_ADVISOR_ALERT_NOT_FOUND: [],
  AI_ADVISOR_ALERT_CLOSED: ['alert_status'],
  AI_ADVISOR_NOTE_INVALID: ['reason', 'min_length', 'max_length'],
  AI_ADVISOR_INVALID_RULE: ['field', 'min', 'max'],
  AI_ADVISOR_INVALID_SETTING: ['field'],
  AI_ADVISOR_SETTINGS_CONFLICT: ['version'],
  AI_ADVISOR_BUDGET_EXCEEDED: [
    'scope',
    'period',
    'reset_at',
    'retry_after_seconds',
  ],
  AI_ADVISOR_AI_DISABLED: ['reason'],
});

/** «Hal qilindi» izohi: trim'dan keyin 3–500 belgi (§7.5). */
export const AI_ADVISOR_NOTE_MIN = 3;
export const AI_ADVISOR_NOTE_MAX = 500;

export type AiAdvisorLimitUnit = 'uzs' | 'days' | 'count' | 'multiplier';

export interface AiAdvisorFieldLimit {
  min: number;
  max: number;
  /** 1 — butun son; 0.1 — bir kasr xona. */
  step: number;
  unit: AiAdvisorLimitUnit;
  default: number;
}

const uzs = (def: number): AiAdvisorFieldLimit => ({
  min: 1,
  max: 1_000_000_000,
  step: 1,
  unit: 'uzs',
  default: def,
});
const days = (def: number): AiAdvisorFieldLimit => ({
  min: 1,
  max: 60,
  step: 1,
  unit: 'days',
  default: def,
});

/**
 * `limits.rules.<R>.<maydon>` (§7.6, BQ4). Kalitlar `rule.thresholds` bilan
 * AYNAN bir xil. R6/R7 — chegarasiz (`{}`).
 */
export const AI_ADVISOR_RULE_LIMITS: Readonly<
  Record<AiAdvisorRuleKey, Readonly<Record<string, AiAdvisorFieldLimit>>>
> = Object.freeze({
  R1: {
    shortage_uzs: uzs(50_000),
    consecutive_negative: {
      min: 2,
      max: 30,
      step: 1,
      unit: 'count',
      default: 3,
    },
  },
  R2: {
    balance_uzs: uzs(2_000_000),
    growth_days: days(3),
    no_handover_days: days(3),
  },
  R3: {
    mad_multiplier: {
      min: 1,
      max: 10,
      step: 0.1,
      unit: 'multiplier',
      default: 3,
    },
  },
  R4: { days_without_payout: days(7) },
  R5: { balance_uzs: uzs(5_000_000), days_without_transfer: days(3) },
  R6: {},
  R7: {},
  R8: {
    ratio: { min: 1.1, max: 10, step: 0.1, unit: 'multiplier', default: 2 },
  },
});

/**
 * Qoida darajasi — ega qarori 2026-11-14 (Q1): superadmin TANLAMAYDI.
 * R2, R6, R7 — `critical`; qolgani — `warning`. PATCH'da `severity` → 400.
 */
export const AI_ADVISOR_RULE_SEVERITY: Readonly<
  Record<AiAdvisorRuleKey, AiAdvisorSeverity>
> = Object.freeze({
  R1: 'warning',
  R2: 'critical',
  R3: 'warning',
  R4: 'warning',
  R5: 'warning',
  R6: 'critical',
  R7: 'critical',
  R8: 'warning',
});

/**
 * `rules.<R>.telegram` sukuti — Q2 (c): R7 `critical`, lekin Telegram'ga
 * YO'Q (faqat ilova ichi + kunlik hisobot). Superadmin o'zgartira oladi.
 */
export const AI_ADVISOR_RULE_TELEGRAM_DEFAULT: Readonly<
  Record<AiAdvisorRuleKey, boolean>
> = Object.freeze({
  R1: true,
  R2: true,
  R3: true,
  R4: true,
  R5: true,
  R6: true,
  R7: false,
  R8: true,
});

/** Bitta qoida sozlamasi: umumiy kalitlar + qoida chegaralari. */
export interface AiAdvisorRuleSettings {
  enabled: boolean;
  severity: AiAdvisorSeverity;
  telegram: boolean;
  [threshold: string]: boolean | number | string;
}

export type AiAdvisorRulesSettings = Record<
  AiAdvisorRuleKey,
  AiAdvisorRuleSettings
>;

/** Qoida chegaralari (`rule.thresholds`) — faqat `limits` dagi kalitlar. */
export function aiAdvisorThresholds(
  key: AiAdvisorRuleKey,
  rule: AiAdvisorRuleSettings,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const field of Object.keys(AI_ADVISOR_RULE_LIMITS[key])) {
    out[field] = Number(rule[field]);
  }
  return out;
}

/** Qoida nomi (UI «Turi», audit va server matnlari). */
export const AI_ADVISOR_RULE_NAMES: Readonly<Record<AiAdvisorRuleKey, string>> =
  Object.freeze({
    R1: 'Smena kamomadi',
    R2: "Kuryer qarzi o'smoqda",
    R3: "G'ayrioddiy xarajat",
    R4: "Market to'lovi kechikmoqda",
    R5: "HQ'ga o'tkazma kechikmoqda",
    R6: 'Zarar',
    R7: 'Chek yoki karta farqi',
    R8: "Tuzatishlar ko'paydi",
  });

/** Sukut qoidalar (TZ qiymatlari, EGA-1029/1). */
export function aiAdvisorDefaultRules(): AiAdvisorRulesSettings {
  const rules = {} as AiAdvisorRulesSettings;
  for (const key of AI_ADVISOR_RULE_KEYS) {
    const rule: AiAdvisorRuleSettings = {
      enabled: true,
      severity: AI_ADVISOR_RULE_SEVERITY[key],
      telegram: AI_ADVISOR_RULE_TELEGRAM_DEFAULT[key],
    };
    for (const [field, limit] of Object.entries(AI_ADVISOR_RULE_LIMITS[key])) {
      rule[field] = limit.default;
    }
    rules[key] = rule;
  }
  return rules;
}

/** gateway → ai-service: so'rovchi (ism — `requestContext.userName`). */
export interface AiAdvisorRequester {
  id: string;
  roles: string[];
  name?: string | null;
}

export interface AiAdvisorUserRef {
  id: string;
  name: string | null;
}

/** `GET /ai/advisor/settings` → `data` (§7.6). */
export interface AiAdvisorSettingsView {
  version: number;
  rules: AiAdvisorRulesSettings;
  limits: {
    rules: Record<AiAdvisorRuleKey, Record<string, AiAdvisorFieldLimit>>;
  };
  /** x-owner BE-1 — hozircha null. */
  telegram: {
    enabled: boolean;
    recipients?: Array<{ user: AiAdvisorUserRef; telegram_connected: boolean }>;
  } | null;
  /** x-owner BE-1 — hozircha null. */
  budget: Record<string, unknown> | null;
  /** x-owner BE-1/BE-4 — hozircha null. */
  schedule: Record<string, unknown> | null;
  updated_at: string | null;
  updated_by: AiAdvisorUserRef | null;
}

export interface AiAdvisorSettingsUpdateRequest {
  requester: AiAdvisorRequester;
  /** Gateway DTO'dan o'tgan tana — ichki tekshiruv ai-service'da. */
  patch: Record<string, unknown>;
}

// ─── BE-5 2-qism: qoida ma'lumotlari (finance → ai-service, §4.4) ─────────

/** finance-service: FAQAT o'qiydigan qoida ma'lumotlari RMQ'si. */
export const AI_ADVISOR_FINANCE_RULE_INPUTS = 'finance.advisor.rule_inputs';

/** Inkremental (kursorli) qoidalar — §4.0. */
export const AI_ADVISOR_CURSOR_RULES = ['R1', 'R3', 'R7'] as const;
export type AiAdvisorCursorRule = (typeof AI_ADVISOR_CURSOR_RULES)[number];

export interface AiAdvisorRuleInputsRequest {
  rules: AiAdvisorRuleKey[];
  /** Tekshiruv lahzasi (ISO) — barcha «bugun/kecha» shundan. */
  now: string;
  /** Qoida chegaralari (`aiAdvisorThresholds`). */
  thresholds: Partial<Record<AiAdvisorRuleKey, Record<string, number>>>;
  /** Kursorli qoidalar: shu lahzadan keyingi hodisalar (kursor − 5 daq). */
  since: Partial<Record<AiAdvisorCursorRule, string>>;
  /** R6: tekshiriladigan yopilgan davrlar. */
  periods?: {
    days?: string[];
    /** Hafta dushanbasi (YYYY-MM-DD). */
    weeks?: string[];
  };
}

export interface AiAdvisorRef {
  id: string;
  name: string | null;
}

export interface AiAdvisorCashboxRef {
  type: 'main' | 'branch' | 'couriers' | 'markets';
  owner_id: string;
  name: string | null;
}

export interface AiAdvisorSubjectRef {
  kind: 'branch' | 'courier' | 'market' | 'cashbox' | 'system';
  id: string | null;
  name: string | null;
}

/** Bitta fakt (takror): `fact_key` — §4.1. */
export interface AiAdvisorFactKey {
  fact_key: string;
  /** Hodisa vaqti (ISO). */
  fact_at: string;
}

/**
 * Bitta nomzod ogohlantirish — bitta `dedup_key` va uning shu tekshiruvda
 * topilgan faktlari. `facts`/`evidence` — §5.3/§5.4 shakli (ism
 * snapshotlari bilan); sarlavha va havolalarni ai-service quradi.
 */
export interface AiAdvisorCandidate {
  rule_key: AiAdvisorRuleKey;
  dedup_key: string;
  fact_keys: AiAdvisorFactKey[];
  branch: AiAdvisorRef | null;
  subject: AiAdvisorSubjectRef;
  headline_amount: number | null;
  facts: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

export interface AiAdvisorRuleInputsResponse {
  candidates: AiAdvisorCandidate[];
  /** Kursorli qoidalarning yangi qiymati (ko'rilgan eng katta vaqt). */
  cursors: Partial<Record<AiAdvisorCursorRule, string | null>>;
  /** Qoida bo'yicha o'tkazib yuborish sababi (masalan R3 namuna < 5). */
  skipped?: Partial<Record<AiAdvisorRuleKey, string>>;
}

// ─── BE-5 3-qism: ogohlantirishlar REST (§5, §7.1–7.3, §7.5) ─────────────

/** `pending` izoh eskirishi (§6) — `CASHBOX_RECEIPT_AI_STALE_MS` bilan bir xil. */
export const AI_ADVISOR_EXPLANATION_STALE_MS = 3 * 60_000;
/** `pending` da FE poll oralig'i (§5.2 `explanation_poll_after_ms`). */
export const AI_ADVISOR_EXPLANATION_POLL_MS = 2_000;
export const AI_ADVISOR_HISTORY_LIMIT = 50;

export const AI_ADVISOR_LIST_STATUSES = [
  ...AI_ADVISOR_ALERT_STATUSES,
  'open',
] as const;
export const AI_ADVISOR_SORT_FIELDS = [
  'last_at',
  'first_at',
  'occurrences',
  'severity',
] as const;
export type AiAdvisorSortField = (typeof AI_ADVISOR_SORT_FIELDS)[number];

export interface AiAdvisorAlertsQuery {
  status?: AiAdvisorAlertStatus | 'open';
  severity?: AiAdvisorSeverity;
  rule_key?: AiAdvisorRuleKey;
  from?: string;
  to?: string;
  q?: string;
  sort_by?: AiAdvisorSortField;
  sort_dir?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface AiAdvisorAlertListItem {
  id: string;
  rule_key: AiAdvisorRuleKey;
  severity: AiAdvisorSeverity;
  status: AiAdvisorAlertStatus;
  title: string;
  branch: AiAdvisorRef | null;
  subject: AiAdvisorSubjectRef;
  headline_amount: number | null;
  facts: Record<string, unknown>;
  occurrences: number;
  first_at: string;
  last_at: string;
  first_fact_at: string | null;
  last_fact_at: string | null;
  explanation_status: AiAdvisorExplanationStatus;
  reopened_from_id: string | null;
}

export interface AiAdvisorAlertHistoryEvent {
  at: string;
  event:
    'opened' | 'occurred' | 'seen' | 'explained' | 'resolved' | 'dismissed';
  by: AiAdvisorUserRef | null;
  note: string | null;
}

export interface AiAdvisorAlertDetail extends AiAdvisorAlertListItem {
  rule: {
    key: AiAdvisorRuleKey;
    severity: AiAdvisorSeverity;
    thresholds: Record<string, number>;
  };
  evidence: Record<string, unknown>;
  links: Array<{
    kind: string;
    href: string;
    entity_id: string | null;
    primary: boolean;
  }>;
  explanation_md: string | null;
  explanation_error: 'budget_exceeded' | 'ai_disabled' | 'error' | null;
  explanation_error_scope: 'advisor' | 'global' | null;
  explanation_retry_at: string | null;
  explanation_requested_at: string | null;
  explanation_poll_after_ms: number | null;
  explained_at: string | null;
  seen_at: string | null;
  seen_by: AiAdvisorUserRef | null;
  resolved_at: string | null;
  resolved_by: AiAdvisorUserRef | null;
  resolution_note: string | null;
  reopened_from: {
    id: string;
    status: AiAdvisorAlertStatus;
    resolved_at: string | null;
  } | null;
  /** Faqat `?include=history`. */
  history?: AiAdvisorAlertHistoryEvent[];
}

export interface AiAdvisorAlertListData {
  items: AiAdvisorAlertListItem[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  counts: { by_status: Record<AiAdvisorAlertStatus, number> };
}

export interface AiAdvisorOverviewData {
  alerts: {
    new: number;
    open: number;
    critical: number;
    critical_open: number;
    critical_rule_keys: AiAdvisorRuleKey[];
    critical_open_rule_keys: AiAdvisorRuleKey[];
  };
  /** x-owner BE-4. */
  recommendations: { new: number } | null;
  /** x-owner BE-1. */
  budget: Record<string, unknown> | null;
  /** x-owner BE-1. */
  usd_uzs_rate: number | null;
  generated_at: string;
}

export interface AiAdvisorAlertGetRequest {
  requester: AiAdvisorRequester;
  id: string;
  /** Sukut true — `new → seen`. Chat/hisobot `false` bilan o'qiydi. */
  mark_seen?: boolean;
  include?: string[];
}

export interface AiAdvisorAlertUpdateRequest {
  requester: AiAdvisorRequester;
  id: string;
  status: 'resolved' | 'dismissed';
  note?: unknown;
}
