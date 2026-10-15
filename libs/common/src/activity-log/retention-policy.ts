import { ACTIVITY_LOG_AUTH_ACTIONS } from './action-registry';
import {
  ACTIVITY_LOG_DEVICE_KEYS_SQL,
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
 *
 * ARXIV (karta 5-band: "o'chirishdan oldin arxiv — moliyaviy/huquqiy dalil
 * yo'qolmasin"; variant — COLD JADVAL). Bayroq yoqilganda qatorlar
 * o'chirilmaydi, KO'CHIRILADI: har sxemadagi `activity_logs_archive` ga
 * (migratsiya 1716000000101), bitta SQL buyrug'ida (DELETE ... RETURNING →
 * INSERT) — ikkalasi birga bo'ladi yoki birortasi ham bo'lmaydi.
 * `ACTIVITY_LOG_PRUNE_ARCHIVE` sukut YOQIQ; faqat aniq `false` arxivsiz
 * o'chirishga o'tkazadi. Arxiv jadvali yo'q sxemada o'chirish RAD etiladi.
 */

export const ACTIVITY_LOG_PRUNE_ENABLED_ENV = 'ACTIVITY_LOG_PRUNE_ENABLED';
export const ACTIVITY_LOG_RETENTION_AUTH_DAYS_ENV =
  'ACTIVITY_LOG_RETENTION_AUTH_DAYS';
export const ACTIVITY_LOG_RETENTION_DEFAULT_DAYS_ENV =
  'ACTIVITY_LOG_RETENTION_DEFAULT_DAYS';
export const ACTIVITY_LOG_PRUNE_BATCH_ENV = 'ACTIVITY_LOG_PRUNE_BATCH';
export const ACTIVITY_LOG_PRUNE_PAUSE_MS_ENV = 'ACTIVITY_LOG_PRUNE_PAUSE_MS';
/** i6Nyedea arxiv: `false`/`0`/`no`/`off` — arxivsiz o'chirish; qolgani — arxiv. */
export const ACTIVITY_LOG_PRUNE_ARCHIVE_ENV = 'ACTIVITY_LOG_PRUNE_ARCHIVE';
/** Har sxemadagi arxiv (cold) jadvali nomi. */
export const ACTIVITY_LOG_ARCHIVE_TABLE = 'activity_logs_archive';

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

/**
 * Arxivga ko'chirish SUKUT bo'yicha YOQIQ (xavfsiz tomon): faqat aniq
 * `false`/`0`/`no`/`off` uni o'chiradi; bo'sh yoki noma'lum qiymat — arxiv.
 */
export function isActivityLogArchiveEnabled(env: Env = process.env): boolean {
  const raw = String(env[ACTIVITY_LOG_PRUNE_ARCHIVE_ENV] ?? '')
    .trim()
    .toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'no' || raw === 'off');
}

/**
 * Arxivga ko'chiriladigan ustunlar — `ActivityLog` entity'sining HAMMA
 * ustunlari (spec solishtiradi: entity'ga ustun qo'shilsa shu ro'yxat va
 * arxiv migratsiyasi ham yangilanishi SHART, aks holda spec yiqiladi).
 */
export const ACTIVITY_LOG_ARCHIVE_COLUMNS: ReadonlyArray<string> =
  Object.freeze([
    'id',
    'entity_type',
    'entity_id',
    'action',
    'old_value',
    'new_value',
    'user_id',
    'user_name',
    'user_role',
    'service',
    'trace_id',
    'metadata',
    'description',
    'created_at',
  ]);

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

/**
 * i6Nyedea ARXIV partiyasi: bitta SQL buyrug'i — PK tartibida `LIMIT` ta
 * qator hot jadvaldan O'CHIRILADI va AYNI qatorlar (`RETURNING`) arxivga
 * YOZILADI. Postgres buyruqni bitta tranzaksiyada bajaradi: INSERT yiqilsa
 * (arxiv jadvali yo'q, ustun mos emas, dublikat id) DELETE ham bekor —
 * qator yo'qolmaydi. `ON CONFLICT` ATAYLAB yo'q: dublikat jim yutilmasin.
 *
 * `metadata` dan IP/qurilma kalitlari olib tashlanadi (f2Ud5tju: ko'chiriladigan
 * har qator qurilma muddatidan eski — u eng qisqa qoida muddatidan oshmaydi).
 *
 * `$1` — kun, `$2` — fe'llar, `$3` — qoida nomi (`archive_rule`).
 * Natija — bitta qator `{ deleted, archived }`.
 */
export function buildPolicyArchiveSql(
  table: string,
  archiveTable: string,
  rule: ActivityLogRetentionRule,
  batchSize: number,
): string {
  const limit =
    Number.isInteger(batchSize) && batchSize > 0
      ? batchSize
      : ACTIVITY_LOG_PRUNE_BATCH_DEFAULT;
  const cols = ACTIVITY_LOG_ARCHIVE_COLUMNS.map((c) => `"${c}"`);
  const selected = cols.map((c) =>
    c === '"metadata"'
      ? `CASE WHEN jsonb_typeof(m."metadata") = 'object' THEN m."metadata" - ${ACTIVITY_LOG_DEVICE_KEYS_SQL} ELSE m."metadata" END`
      : `m.${c}`,
  );
  return `WITH batch AS (
  SELECT s.id FROM ${table} AS s
   WHERE ${ruleWhere(rule, 's')}
   ORDER BY s.id
   LIMIT ${limit}
), moved AS (
  DELETE FROM ${table} AS t
   WHERE t.id IN (SELECT id FROM batch)
  RETURNING ${cols.map((c) => `t.${c}`).join(', ')}
), archived AS (
  INSERT INTO ${archiveTable} (${cols.join(', ')}, "archive_rule")
  SELECT ${selected.join(', ')}, $3::varchar FROM moved AS m
  RETURNING 1
)
SELECT (SELECT COUNT(*)::int FROM moved) AS deleted,
       (SELECT COUNT(*)::int FROM archived) AS archived`;
}

/**
 * Arxiv jadvali bormi (`"schema"."activity_logs_archive"`). Yo'q bo'lsa —
 * o'chirish boshlanmaydi (dalil arxivsiz yo'qolmasin).
 */
export async function activityLogArchiveExists(
  run: ActivityLogSqlRunner,
  archiveTable: string,
): Promise<boolean> {
  const rows = (await run('SELECT to_regclass($1) IS NOT NULL AS ok', [
    archiveTable,
  ])) as Array<{ ok?: boolean }> | undefined;
  return (Array.isArray(rows) ? rows[0] : undefined)?.ok === true;
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
  /**
   * i6Nyedea — berilsa qatorlar shu arxiv jadvaliga KO'CHIRILADI
   * (`buildPolicyArchiveSql`); berilmasa — eski DELETE yo'li.
   */
  archiveTable?: string;
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
): Promise<{ deleted: number; batches: number; archived?: number }> {
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
  const archiveTable = opts.archiveTable;
  const sql = archiveTable
    ? buildPolicyArchiveSql(table, archiveTable, rule, batchSize)
    : buildPolicyPruneSql(table, rule, batchSize);
  const params = archiveTable
    ? [rule.days, rule.actions, rule.name]
    : [rule.days, rule.actions];
  let deleted = 0;
  let archived = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const rows = (await run(sql, params)) as
      | Array<{ deleted?: number | string; archived?: number | string }>
      | undefined;
    batches += 1;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    const n = Number(row?.deleted ?? 0);
    if (archiveTable) {
      const a = Number(row?.archived ?? 0);
      // Bitta buyruqda mumkin emas (INSERT yiqilsa DELETE ham bekor), lekin
      // driver/so'rov o'zgarsa — jim davom etmaydi, monitoringga chiqadi.
      if (a !== n) {
        throw new Error(
          `activity_logs arxiv (${rule.name}): o'chirilgan ${n} != arxivlangan ${a} — ko'chirish to'xtatildi`,
        );
      }
      if (Number.isFinite(a) && a > 0) archived += a;
    }
    if (!Number.isFinite(n) || n <= 0) break;
    deleted += n;
    if (n < batchSize) break;
    if (pauseMs > 0) await sleep(pauseMs);
  }
  return archiveTable ? { deleted, batches, archived } : { deleted, batches };
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
