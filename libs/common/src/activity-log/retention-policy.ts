import { ACTIVITY_LOG_AUTH_ACTIONS } from './action-registry';
import {
  ACTIVITY_LOG_PRUNE_BATCH_DEFAULT,
  ActivityLogSqlRunner,
  parseRetentionDays,
} from './retention';

/**
 * JURNAL SAQLASH MUDDATI SIYOSATI (i6Nyedea).
 *
 * ⚠️ O'CHIRISH SUKUT BO'YICHA O'CHIQ. `ACTIVITY_LOG_PRUNE_ENABLED=true`
 * bo'lmaguncha HECH bir mexanizm (servis cron'i, `activity-log-prune`
 * sidecar'i, integration-service retention tick'i) `activity_logs`
 * qatorlarini O'CHIRMAYDI — faqat DRY-RUN: o'chiriladigan qatorlarni sanaydi
 * va tizim log'iga yozadi. Sabab (karta DIQQAT bandi): muddat noto'g'ri
 * qo'yilsa moliyaviy/huquqiy dalil qaytarib bo'lmas darajada yo'qoladi —
 * muddatlar ega bilan yozma kelishilib, TEST ma'lumotlari eksport qilingach
 * yoqiladi.
 *
 * Ikki sinf (fe'l bo'yicha):
 *   • `auth` — kirish hodisalari (login/logout/auth_failure + OTP; reyestrdagi
 *     `auth` kategoriyasi): `ACTIVITY_LOG_RETENTION_AUTH_DAYS`, sukut 90 kun;
 *   • `default` — QOLGAN HAMMASI (moliya, buyurtma, investor, settlement ...):
 *     `ACTIVITY_LOG_RETENTION_DEFAULT_DAYS`, sukut 1095 kun (3 yil).
 * Pastki chegara: noto'g'ri yoki juda kichik qiymat (auth < 7, default <
 * 365) RAD etiladi va xavfsiz (uzun) sukut ishlaydi + ogohlantirish.
 */

export const ACTIVITY_LOG_PRUNE_ENABLED_ENV = 'ACTIVITY_LOG_PRUNE_ENABLED';
export const ACTIVITY_LOG_RETENTION_AUTH_DAYS_ENV =
  'ACTIVITY_LOG_RETENTION_AUTH_DAYS';
export const ACTIVITY_LOG_RETENTION_DEFAULT_DAYS_ENV =
  'ACTIVITY_LOG_RETENTION_DEFAULT_DAYS';
export const ACTIVITY_LOG_PRUNE_BATCH_ENV = 'ACTIVITY_LOG_PRUNE_BATCH';
export const ACTIVITY_LOG_PRUNE_PAUSE_MS_ENV = 'ACTIVITY_LOG_PRUNE_PAUSE_MS';

export const ACTIVITY_LOG_RETENTION_AUTH_DEFAULT_DAYS = 90;
export const ACTIVITY_LOG_RETENTION_AUTH_MIN_DAYS = 7;
export const ACTIVITY_LOG_RETENTION_DEFAULT_DEFAULT_DAYS = 1095;
export const ACTIVITY_LOG_RETENTION_DEFAULT_MIN_DAYS = 365;
/** Partiyalar orasidagi pauza (ms) — replikatsiya/qulf bosimi taqsimlansin. */
export const ACTIVITY_LOG_PRUNE_PAUSE_MS_DEFAULT = 200;
/** Bitta ishga tushishda partiyalar chegarasi (qochib ketgan sikl himoyasi). */
export const ACTIVITY_LOG_PRUNE_MAX_BATCHES = 1_000;

type Env = Record<string, string | undefined>;

/** `true`/`1`/`yes`/`on` — yoqilgan; qolgan hamma narsa (bo'sh ham) — O'CHIQ. */
export function isActivityLogPruneEnabled(env: Env = process.env): boolean {
  const raw = String(env[ACTIVITY_LOG_PRUNE_ENABLED_ENV] ?? '')
    .trim()
    .toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

export interface ActivityLogRetentionRule {
  name: 'auth' | 'default';
  days: number;
  /** `include` — faqat shu fe'llar; `exclude` — shu fe'llardan TASHQARI. */
  mode: 'include' | 'exclude';
  actions: string[];
}

export interface ActivityLogRetentionPolicy {
  rules: ActivityLogRetentionRule[];
  warnings: string[];
}

function daysFromEnv(
  env: Env,
  key: string,
  fallback: number,
  min: number,
  warnings: string[],
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const days = parseRetentionDays(raw);
  if (days === null || days < min) {
    warnings.push(
      `${key}="${raw}" rad etildi (musbat butun, kamida ${min} kun) — xavfsiz sukut ${fallback} kun ishlatiladi`,
    );
    return fallback;
  }
  return days;
}

/** Env'dan siyosat. Qiymat berilmasa — xavfsiz (uzun) sukutlar. */
export function resolveActivityLogRetentionPolicy(
  env: Env = process.env,
): ActivityLogRetentionPolicy {
  const warnings: string[] = [];
  const authDays = daysFromEnv(
    env,
    ACTIVITY_LOG_RETENTION_AUTH_DAYS_ENV,
    ACTIVITY_LOG_RETENTION_AUTH_DEFAULT_DAYS,
    ACTIVITY_LOG_RETENTION_AUTH_MIN_DAYS,
    warnings,
  );
  const defaultDays = daysFromEnv(
    env,
    ACTIVITY_LOG_RETENTION_DEFAULT_DAYS_ENV,
    ACTIVITY_LOG_RETENTION_DEFAULT_DEFAULT_DAYS,
    ACTIVITY_LOG_RETENTION_DEFAULT_MIN_DAYS,
    warnings,
  );
  const actions = [...ACTIVITY_LOG_AUTH_ACTIONS];
  return {
    rules: [
      { name: 'auth', days: authDays, mode: 'include', actions },
      { name: 'default', days: defaultDays, mode: 'exclude', actions },
    ],
    warnings,
  };
}

export function resolvePruneBatchSize(env: Env = process.env): number {
  return (
    parseRetentionDays(env[ACTIVITY_LOG_PRUNE_BATCH_ENV]) ??
    ACTIVITY_LOG_PRUNE_BATCH_DEFAULT
  );
}

export function resolvePrunePauseMs(env: Env = process.env): number {
  const raw = env[ACTIVITY_LOG_PRUNE_PAUSE_MS_ENV];
  if (raw === undefined || raw.trim() === '') {
    return ACTIVITY_LOG_PRUNE_PAUSE_MS_DEFAULT;
  }
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0
    ? n
    : ACTIVITY_LOG_PRUNE_PAUSE_MS_DEFAULT;
}

/** `$1` — kun, `$2` — fe'llar (`text[]`). DELETE va dry-run uchun AYNI shart. */
function ruleWhere(rule: ActivityLogRetentionRule, alias: string): string {
  const actionCond =
    rule.mode === 'include'
      ? `${alias}.action = ANY($2::text[])`
      : `${alias}.action <> ALL($2::text[])`;
  return `${alias}.created_at < now() - make_interval(days => $1) AND ${actionCond}`;
}

/**
 * Bitta partiya (`retention.ts` dagi `buildActivityLogPruneSql` naqshi):
 * PK tartibida `LIMIT` ta qator — bitta qisqa so'rov, uzoq qulf/WAL yo'q.
 * Natija — bitta qator `{ deleted }`.
 */
export function buildPolicyPruneSql(
  table: string,
  rule: ActivityLogRetentionRule,
  batchSize: number,
): string {
  const limit =
    Number.isInteger(batchSize) && batchSize > 0
      ? batchSize
      : ACTIVITY_LOG_PRUNE_BATCH_DEFAULT;
  return `WITH batch AS (
  SELECT s.id FROM ${table} AS s
   WHERE ${ruleWhere(rule, 's')}
   ORDER BY s.id
   LIMIT ${limit}
), deleted AS (
  DELETE FROM ${table}
   WHERE id IN (SELECT id FROM batch)
  RETURNING 1
)
SELECT COUNT(*)::int AS deleted FROM deleted`;
}

/** Dry-run: o'chiriladigan qatorlar soni (AYNI shart). */
export function buildPolicyCountSql(
  table: string,
  rule: ActivityLogRetentionRule,
): string {
  return `SELECT COUNT(*)::int AS count FROM ${table} AS s WHERE ${ruleWhere(rule, 's')}`;
}

export interface PolicyPruneOptions {
  batchSize?: number;
  pauseMs?: number;
  maxBatches?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Bitta qoida bo'yicha PARTIYALAB o'chiradi: har partiya alohida so'rov
 * (alohida qisqa tranzaksiya), partiyalar orasida `pauseMs` pauza — parallel
 * `/activity-logs` o'qishlari kutib qolmaydi. Jami o'chirilganlar soni.
 */
export async function pruneByRuleBatched(
  run: ActivityLogSqlRunner,
  table: string,
  rule: ActivityLogRetentionRule,
  opts: PolicyPruneOptions = {},
): Promise<{ deleted: number; batches: number }> {
  if (!Number.isInteger(rule.days) || rule.days <= 0) {
    throw new RangeError(
      `activity_logs prune (${rule.name}): days musbat butun son bo'lishi kerak (${rule.days}).`,
    );
  }
  const batchSize =
    opts.batchSize && opts.batchSize > 0
      ? opts.batchSize
      : ACTIVITY_LOG_PRUNE_BATCH_DEFAULT;
  const pauseMs = opts.pauseMs ?? ACTIVITY_LOG_PRUNE_PAUSE_MS_DEFAULT;
  const maxBatches = opts.maxBatches ?? ACTIVITY_LOG_PRUNE_MAX_BATCHES;
  const sleep = opts.sleep ?? defaultSleep;
  const sql = buildPolicyPruneSql(table, rule, batchSize);
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const rows = (await run(sql, [rule.days, rule.actions])) as
      | Array<{ deleted?: number | string }>
      | undefined;
    batches += 1;
    const n = Number((Array.isArray(rows) ? rows[0] : undefined)?.deleted ?? 0);
    if (!Number.isFinite(n) || n <= 0) break;
    deleted += n;
    if (n < batchSize) break;
    if (pauseMs > 0) await sleep(pauseMs);
  }
  return { deleted, batches };
}

export async function countByRule(
  run: ActivityLogSqlRunner,
  table: string,
  rule: ActivityLogRetentionRule,
): Promise<number> {
  const rows = (await run(buildPolicyCountSql(table, rule), [
    rule.days,
    rule.actions,
  ])) as Array<{ count?: number | string }> | undefined;
  return Number((Array.isArray(rows) ? rows[0] : undefined)?.count ?? 0) || 0;
}

/**
 * Servislar bo'yicha TAQSIMLANGAN ishga tushish vaqti (Toshkent, tun):
 * hammasi bir daqiqada bitta Postgres'ni yuklamasin. Servis o'z vaqtini
 * `ACTIVITY_LOG_PRUNE_CRON_<SERVIS>` bilan almashtira oladi
 * (masalan `ACTIVITY_LOG_PRUNE_CRON_ORDER_SERVICE="0 15 3 * * *"`).
 */
export const ACTIVITY_LOG_PRUNE_SCHEDULE: Readonly<Record<string, string>> =
  Object.freeze({
    'identity-service': '0 5 3 * * *',
    'order-service': '0 15 3 * * *',
    'finance-service': '0 25 3 * * *',
    'branch-service': '0 35 3 * * *',
    'integration-service': '0 45 3 * * *',
    'logistics-service': '0 55 3 * * *',
    'catalog-service': '0 5 4 * * *',
    'investor-service': '0 15 4 * * *',
    'notification-service': '0 25 4 * * *',
    'ai-service': '0 35 4 * * *',
  });
/** Ro'yxatda yo'q servis (yangi) — eng oxirgi slot. */
export const ACTIVITY_LOG_PRUNE_SCHEDULE_FALLBACK = '0 45 4 * * *';
export const ACTIVITY_LOG_PRUNE_TIMEZONE = 'Asia/Tashkent';

export function activityLogPruneCronFor(
  serviceName: string | null | undefined,
  env: Env = process.env,
): string {
  const name = String(serviceName ?? '').trim();
  const envKey = `ACTIVITY_LOG_PRUNE_CRON_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  const override = name ? env[envKey]?.trim() : undefined;
  if (override) return override;
  return (
    ACTIVITY_LOG_PRUNE_SCHEDULE[name] ?? ACTIVITY_LOG_PRUNE_SCHEDULE_FALLBACK
  );
}
