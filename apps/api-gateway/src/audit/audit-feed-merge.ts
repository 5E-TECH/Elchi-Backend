/**
 * 8eYmt4NV — faoliyat jurnali fan-out'ining ANIQ sahifalashi.
 *
 * Avval gateway har servisdan `min(500, page*limit)` qator olib xotirada
 * birlashtirardi: `total` yig'indidan hisoblanar, birlashgan massiv esa
 * `sum(min(500, leg_total))` bilan cheklanardi — prod'da 3425 qatordan 1594
 * tasi o'qilardi, 90-sahifadan keyin bo'sh, 500-qatordan keyin tartib ham
 * buzilishi mumkin edi.
 *
 * Endi KEYSET: global tartib `(cursor_ts DESC, servis tartibi ASC, id DESC)`.
 * `cursor_ts` — servis qaytaradigan mikrosekundli UTC satr (Postgres
 * `timestamptz` aniqligi; JS Date ms ga kesilsa bir ms ichidagi qatorlar
 * yo'qolardi). Kursor — global tartibdagi oxirgi qator; har servisga o'z
 * shartiga aylantirib uzatiladi (`legBefore`), servis kursordan keyingi
 * `limit` qatorni qaytaradi, gateway k-way merge qiladi.
 */

export interface FeedKey {
  /** Mikrosekundli UTC satr: `2026-10-14T09:10:19.064123Z`. */
  ts: string;
  /** Servisning global tartib raqami (`AuditGatewayController.services`). */
  rank: number;
  /** Servis ichidagi `activity_logs.id` (bigint satr). */
  id: string;
}

/**
 * Sahifa rejimida (`?page=N`, bir nechta servis) aniq o'qiladigan qatorlar
 * chegarasi. Undan chuqur — `meta.truncated` + sana/servis filtri maslahati
 * (yoki `?cursor=` bilan istalgan chuqurlik). Bitta servis filtri bilan —
 * chegara YO'Q (servisning o'z ofseti aniq).
 */
export const ACTIVITY_FEED_OFFSET_CAP = 10_000;

const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ZERO_TS = '0000-01-01T00:00:00.000000Z';

/**
 * Qatorning kursor vaqti: servis bergan `cursor_ts` (aniq), bo'lmasa
 * (eski servis versiyasi / test soxtasi) `created_at` ms → µs ga to'ldirilgan.
 */
export function cursorTsOf(row: Record<string, unknown>): string {
  const raw = row?.cursor_ts;
  if (typeof raw === 'string' && CURSOR_TS_RE.test(raw)) return raw;
  const created = row?.created_at;
  const d =
    created instanceof Date
      ? created
      : typeof created === 'string' || typeof created === 'number'
        ? new Date(created)
        : null;
  if (!d || Number.isNaN(d.getTime())) return ZERO_TS;
  return d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

function idText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '0';
}

/** bigint satrlarni raqam sifatida solishtiradi (uzunlik, so'ng leksik). */
function compareIdAsc(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Global tartib: manfiy — `a` `b` dan OLDIN (yangiroq). */
export function compareFeedKeys(a: FeedKey, b: FeedKey): number {
  if (a.ts !== b.ts) return a.ts > b.ts ? -1 : 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return -compareIdAsc(a.id, b.id);
}

export function feedKeyOf(row: Record<string, unknown>, rank: number): FeedKey {
  return { ts: cursorTsOf(row), rank, id: idText(row?.id) };
}

/** `key` global tartibda `cursor` dan KEYIN keladimi. */
export function isAfterCursor(key: FeedKey, cursor: FeedKey): boolean {
  return compareFeedKeys(cursor, key) < 0;
}

/**
 * Global kursor → `rank` li servis uchun keyset sharti
 * (`ActivityLogQuery.before_*`):
 *   • tartibi kursor servisidan KEYIN (rank > r0) — `created_at <= ts`;
 *   • OLDIN (rank < r0) — `created_at < ts`;
 *   • AYNI servis — `(created_at, id) < (ts, id0)`.
 */
export function legBefore(
  cursor: FeedKey,
  rank: number,
): { before_ts: string; before_id?: string; before_inclusive?: boolean } {
  if (rank === cursor.rank) {
    return { before_ts: cursor.ts, before_id: cursor.id };
  }
  return rank > cursor.rank
    ? { before_ts: cursor.ts, before_inclusive: true }
    : { before_ts: cursor.ts, before_inclusive: false };
}

/** Shaffof bo'lmagan kursor: base64url(JSON `{t, s, i}`), `s` — servis nomi. */
export function encodeFeedCursor(key: FeedKey, serviceName: string): string {
  return Buffer.from(
    JSON.stringify({ t: key.ts, s: serviceName, i: key.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeFeedCursor(
  raw: unknown,
  serviceNames: ReadonlyArray<string>,
): FeedKey | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw.trim(), 'base64url').toString('utf8'),
    ) as { t?: unknown; s?: unknown; i?: unknown };
    const service = typeof parsed?.s === 'string' ? parsed.s : '';
    const id = typeof parsed?.i === 'string' ? parsed.i : '';
    const rank = serviceNames.indexOf(service);
    if (
      typeof parsed?.t !== 'string' ||
      !CURSOR_TS_RE.test(parsed.t) ||
      rank < 0 ||
      !/^\d{1,19}$/.test(id)
    ) {
      return null;
    }
    return { ts: parsed.t, rank, id };
  } catch {
    return null;
  }
}
