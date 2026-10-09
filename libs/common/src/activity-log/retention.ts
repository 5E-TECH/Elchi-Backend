import { AUDIT_CONTEXT_LIMITS, AuditContext } from '../context/request-context';

/**
 * IP/qurilma maydonlari uchun QISQAROQ saqlash muddati (f2Ud5tju, DIQQAT
 * bandi: "IP — shaxsiy ma'lumot ... qisqaroq saqlash muddati qo'llanilsin").
 *
 * Qator O'ZI qoladi (audit izi: kim, nima, qachon) — `metadata` dan faqat
 * gateway avtomatik qo'shadigan 4 kalit olib tashlanadi: `ip`, `user_agent`,
 * `device_id`, `device_name`. Boshqa metadata kalitlari (market_id, reason,
 * phone_masked ...) TEGILMAYDI.
 *
 * Ikki joydan chaqiriladi (mavjud prune qanday qamrasa — shunday):
 *  - `scripts/prune-activity-logs.ts` (`activity-log-prune` sidecar) — BARCHA
 *    sxemalardagi `activity_logs` (information_schema orqali topiladi);
 *  - `ActivityLogService.prune()` — servisning o'z sxemasi (integration-service
 *    retention tick'i, umumiy muddat `ACTIVITY_LOG_RETENTION_MS`, sukut 90 kun).
 */

/** Muddat (kun) env kaliti. Umumiy muddatdan katta bo'lsa — umumiy ustun. */
export const ACTIVITY_LOG_DEVICE_RETENTION_ENV =
  'ACTIVITY_LOG_DEVICE_RETENTION_DAYS';
export const ACTIVITY_LOG_DEVICE_RETENTION_DEFAULT_DAYS = 30;
/** Bitta UPDATE partiyasidagi qatorlar soni (katta jadval bir so'rovda qulflanmasin). */
export const ACTIVITY_LOG_DEVICE_STRIP_BATCH_DEFAULT = 5_000;

/**
 * Olib tashlanadigan kalitlar — `RequestContextStore` audit maydonlarining
 * YAGONA ro'yxatidan (`AUDIT_CONTEXT_LIMITS`) olinadi: kontekstga yangi
 * maydon qo'shilsa, u ham avtomatik qisqa muddatga tushadi.
 */
export const ACTIVITY_LOG_DEVICE_METADATA_KEYS: ReadonlyArray<
  keyof AuditContext
> = Object.freeze(
  Object.keys(AUDIT_CONTEXT_LIMITS) as Array<keyof AuditContext>,
);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Musbat butun son bo'lsa — son, aks holda `null` (bo'sh, "abc", 0, 1.5). */
export function parseRetentionDays(
  raw: string | number | undefined | null,
): number | null {
  if (raw === undefined || raw === null || `${raw}`.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * IP/qurilma muddati (kun): env (`ACTIVITY_LOG_DEVICE_RETENTION_DAYS`, sukut
 * 30) va umumiy muddatning KICHIGI — qurilma maydoni qatorning o'zidan uzoq
 * yashay olmaydi. Noto'g'ri env qiymati sukutga tushadi (boshqa in-process
 * retention env'lari kabi; skript esa o'zi qat'iy tekshiradi).
 */
export function resolveDeviceRetentionDays(
  generalRetentionDays: number,
  raw: string | number | undefined = process.env[
    ACTIVITY_LOG_DEVICE_RETENTION_ENV
  ],
): number {
  const days =
    parseRetentionDays(raw) ?? ACTIVITY_LOG_DEVICE_RETENTION_DEFAULT_DAYS;
  return Number.isFinite(generalRetentionDays) && generalRetentionDays > 0
    ? Math.min(days, generalRetentionDays)
    : days;
}

/** `resolveDeviceRetentionDays` ning millisekund varianti (`prune(olderThanMs)` uchun). */
export function resolveDeviceRetentionMs(
  generalRetentionMs: number,
  raw: string | number | undefined = process.env[
    ACTIVITY_LOG_DEVICE_RETENTION_ENV
  ],
): number {
  const ms =
    (parseRetentionDays(raw) ?? ACTIVITY_LOG_DEVICE_RETENTION_DEFAULT_DAYS) *
    DAY_MS;
  return Number.isFinite(generalRetentionMs) && generalRetentionMs > 0
    ? Math.min(ms, generalRetentionMs)
    : ms;
}

/** Postgres identifikatori: `"order_schema"."activity_logs"`. */
export function quoteActivityLogTable(
  schema: string | null | undefined,
  table = 'activity_logs',
): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return schema ? `${q(schema)}.${q(table)}` : q(table);
}

function normaliseBatchSize(
  batchSize: number,
  fallback: number = ACTIVITY_LOG_DEVICE_STRIP_BATCH_DEFAULT,
): number {
  return Number.isInteger(batchSize) && batchSize > 0 ? batchSize : fallback;
}

const KEYS_SQL = `ARRAY[${ACTIVITY_LOG_DEVICE_METADATA_KEYS.map((k) => `'${k}'`).join(', ')}]::text[]`;

/**
 * Bitta partiya: `$1` — chegara (shundan ESKI qatorlar), `$2` — oldingi
 * partiyaning oxirgi `id` si (keyset: har partiya PK indeksidan davom etadi,
 * tozalangan qatorlarni qayta skanerlamaydi).
 *
 * - `created_at < $1` — FAQAT eski qatorlar;
 * - `metadata ?| keys` — faqat shu kalitlardan biri BOR obyekt qatorlar (NULL,
 *   massiv va kalitsiz qatorlarga UPDATE yozilmaydi; qayta ishga tushirish
 *   idempotent);
 * - `metadata - keys` — faqat shu 4 kalit olib tashlanadi, qolgani qoladi.
 *
 * CTE natijasi bitta `SELECT` qatori — driver shaklidan qat'i nazar
 * (TypeORM `query()` UPDATE uchun `[rows, rowCount]` qaytaradi) aniq son.
 */
export function buildDeviceMetadataStripSql(
  table: string,
  batchSize: number = ACTIVITY_LOG_DEVICE_STRIP_BATCH_DEFAULT,
): string {
  const limit = normaliseBatchSize(batchSize);
  return `WITH batch AS (
  SELECT s.id FROM ${table} AS s
   WHERE s.created_at < $1
     AND s.id > $2
     AND jsonb_typeof(s.metadata) = 'object'
     AND s.metadata ?| ${KEYS_SQL}
   ORDER BY s.id
   LIMIT ${limit}
), stripped AS (
  UPDATE ${table} AS t
     SET metadata = t.metadata - ${KEYS_SQL}
    FROM batch
   WHERE t.id = batch.id
  RETURNING t.id
)
SELECT COUNT(*)::int AS stripped, MAX(id)::text AS last_id FROM stripped`;
}

/** `--dry-run` uchun: tozalanadigan qatorlar soni. `$1` — chegara. */
export function buildDeviceMetadataCountSql(table: string): string {
  return `SELECT COUNT(*)::int AS count FROM ${table}
   WHERE created_at < $1
     AND jsonb_typeof(metadata) = 'object'
     AND metadata ?| ${KEYS_SQL}`;
}

export type ActivityLogSqlRunner = (
  sql: string,
  params: unknown[],
) => Promise<unknown>;

/**
 * Chegaradan eski qatorlarda IP/qurilma kalitlarini PARTIYALAB olib
 * tashlaydi; jami tozalangan qatorlar sonini qaytaradi. Har partiya alohida
 * so'rov (alohida qisqa tranzaksiya) — butun jadval bir so'rovda qulflanmaydi.
 */
export async function stripDeviceMetadataBatched(
  run: ActivityLogSqlRunner,
  table: string,
  cutoff: Date,
  batchSize: number = ACTIVITY_LOG_DEVICE_STRIP_BATCH_DEFAULT,
): Promise<number> {
  const limit = normaliseBatchSize(batchSize);
  const sql = buildDeviceMetadataStripSql(table, limit);
  let lastId = '0';
  let total = 0;
  for (;;) {
    const rows = (await run(sql, [cutoff, lastId])) as
      | Array<{ stripped?: number | string; last_id?: string | null }>
      | undefined;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    const stripped = Number(row?.stripped ?? 0);
    if (!Number.isFinite(stripped) || stripped <= 0) break;
    total += stripped;
    if (stripped < limit || !row?.last_id) break;
    lastId = String(row.last_id);
  }
  return total;
}

/**
 * UMUMIY muddat: `ACTIVITY_LOG_RETENTION_DAYS` dan eski qatorlar butunlay
 * o'chiriladi (`scripts/prune-activity-logs.ts`, barcha sxemalar).
 *
 * (f2Ud5tju topilmasi, prune-delete-count) Avval skript top-level
 * `DELETE ... RETURNING 1` natijasining `.length` ini son deb olardi. TypeORM
 * 0.3 `query()` DELETE/UPDATE uchun `[rows, rowCount]` qaytaradi — `.length`
 * har doim 2: tsikl birinchi partiyadan keyin to'xtardi (har ishga tushishda
 * har sxemadan ko'pi bilan bitta partiya, log'da "deleted 2"), batch <= 2 da
 * esa cheksiz aylanardi. Endi DELETE CTE ichida, yuqori darajadagi buyruq —
 * `SELECT COUNT(*)`: driver shaklidan qat'i nazar bitta qator, aniq son.
 */
export const ACTIVITY_LOG_PRUNE_BATCH_DEFAULT = 10_000;

/** `$1` — muddat (kun, musbat butun). DELETE va `--dry-run` uchun AYNI shart. */
const PRUNE_CUTOFF_SQL = 'now() - make_interval(days => $1)';

/**
 * Bitta partiya: chegaradan eski qatorlardan PK tartibida `LIMIT` tasi
 * o'chiriladi (bitta qisqa so'rov — uzoq qulf/WAL shishishi yo'q). Natija —
 * bitta qator: `{ deleted: number }`.
 */
export function buildActivityLogPruneSql(
  table: string,
  batchSize: number = ACTIVITY_LOG_PRUNE_BATCH_DEFAULT,
): string {
  const limit = normaliseBatchSize(batchSize, ACTIVITY_LOG_PRUNE_BATCH_DEFAULT);
  return `WITH batch AS (
  SELECT s.id FROM ${table} AS s
   WHERE s.created_at < ${PRUNE_CUTOFF_SQL}
   ORDER BY s.id
   LIMIT ${limit}
), deleted AS (
  DELETE FROM ${table}
   WHERE id IN (SELECT id FROM batch)
  RETURNING 1
)
SELECT COUNT(*)::int AS deleted FROM deleted`;
}

/** `--dry-run` uchun: o'chiriladigan qatorlar soni. `$1` — muddat (kun). */
export function buildActivityLogPruneCountSql(table: string): string {
  return `SELECT COUNT(*)::text AS count FROM ${table}
   WHERE created_at < ${PRUNE_CUTOFF_SQL}`;
}

/**
 * `retentionDays` dan eski qatorlarni PARTIYALAB o'chiradi; jami o'chirilgan
 * qatorlar sonini qaytaradi. Partiya `batchSize` dan kam bo'lsa — tugadi.
 * Noto'g'ri muddat (0 — HAMMA qatorni o'chirardi) so'rovsiz rad etiladi.
 */
export async function pruneActivityLogsBatched(
  run: ActivityLogSqlRunner,
  table: string,
  retentionDays: number,
  batchSize: number = ACTIVITY_LOG_PRUNE_BATCH_DEFAULT,
): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new RangeError(
      `activity_logs prune: retentionDays musbat butun son bo'lishi kerak (${retentionDays}).`,
    );
  }
  const limit = normaliseBatchSize(batchSize, ACTIVITY_LOG_PRUNE_BATCH_DEFAULT);
  const sql = buildActivityLogPruneSql(table, limit);
  let total = 0;
  for (;;) {
    const rows = (await run(sql, [retentionDays])) as
      | Array<{ deleted?: number | string }>
      | undefined;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    const deleted = Number(row?.deleted ?? 0);
    if (!Number.isFinite(deleted) || deleted <= 0) break;
    total += deleted;
    if (deleted < limit) break;
  }
  return total;
}
