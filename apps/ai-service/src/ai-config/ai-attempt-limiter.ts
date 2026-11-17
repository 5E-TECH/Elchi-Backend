import { DataSource } from 'typeorm';

/**
 * Urinishlar cheklovi (spec §5.4) — DB'da (`ai_config_attempts`), qayta
 * ishga tushish nolga tushirmaydi.
 *
 * - `key` (saqlash + tekshirish + qaytarish birga): bitta superadmin uchun
 *   daqiqasiga 5, butun muhit uchun soatiga 30.
 * - `catalog` (qo'lda yangilash): bitta superadmin uchun soatiga 6
 *   (kunlik avtomatik yangilanish bu yerdan o'tmaydi).
 *
 * 24 soatdan eski qatorlar har yozuvda dangasa o'chiriladi. Bir vaqtdagi
 * so'rovlar advisory lock bilan ketma-ket (hisob → yozish atomik).
 */
export type AiAttemptKind = 'key' | 'catalog';

interface Window {
  scope: 'requester' | 'all';
  ms: number;
  max: number;
}

export const AI_ATTEMPT_WINDOWS: Record<AiAttemptKind, Window[]> = {
  key: [
    { scope: 'requester', ms: 60_000, max: 5 },
    { scope: 'all', ms: 3_600_000, max: 30 },
  ],
  catalog: [{ scope: 'requester', ms: 3_600_000, max: 6 }],
};

const TABLE = 'ai_schema.ai_config_attempts';
/** `pg_advisory_xact_lock` kaliti (ixtiyoriy doimiy). */
const LOCK_KEY = 0x41_49_43_46; // 'AICF'

export type AiAttemptResult =
  { ok: true } | { ok: false; retry_after_seconds: number };

export async function consumeAiAttempt(
  ds: DataSource,
  requesterId: string,
  kind: AiAttemptKind,
  now: Date = new Date(),
): Promise<AiAttemptResult> {
  return ds.transaction(async (m) => {
    await m.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await m.query(
      `DELETE FROM ${TABLE} WHERE "created_at" < $1::timestamptz - interval '24 hours'`,
      [now.toISOString()],
    );
    let retry = 0;
    for (const w of AI_ATTEMPT_WINDOWS[kind]) {
      const since = new Date(now.getTime() - w.ms).toISOString();
      const rows = await m.query<{ n: string; oldest: Date | string | null }[]>(
        w.scope === 'requester'
          ? `SELECT count(*)::text AS n, min("created_at") AS oldest FROM ${TABLE}
              WHERE "kind" = $1 AND "requester_id" = $2 AND "created_at" > $3::timestamptz`
          : `SELECT count(*)::text AS n, min("created_at") AS oldest FROM ${TABLE}
              WHERE "kind" = $1 AND "created_at" > $3::timestamptz AND $2::text IS NOT NULL`,
        [kind, requesterId, since],
      );
      const n = Number(rows[0]?.n ?? 0);
      if (n >= w.max) {
        const oldest = rows[0]?.oldest
          ? new Date(rows[0].oldest).getTime()
          : now.getTime();
        retry = Math.max(
          retry,
          Math.max(1, Math.ceil((oldest + w.ms - now.getTime()) / 1000)),
        );
      }
    }
    if (retry > 0) return { ok: false, retry_after_seconds: retry };
    await m.query(
      `INSERT INTO ${TABLE} ("requester_id", "kind", "created_at") VALUES ($1, $2, $3)`,
      [requesterId, kind, now.toISOString()],
    );
    return { ok: true };
  });
}
