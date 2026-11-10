/**
 * «QABUL VA YARATISH → BEKOR QILINGANLAR → TOPSHIRILGAN» (HQ) — «Marketga jo'natish» PARTIYALARI.
 *
 * Partiya = HQ xodimining BITTA «Marketga jo'natish» bosishi (`order.market_cancelled_handover.complete`).
 * U yo'l hamma buyurtmaga BITTA `now` yozadi (`market_handover_at`), shuning uchun partiya kaliti:
 * `market_id` + `market_handover_at` (mikrosekundgacha) + `market_handover_by`.
 *
 * ⚠️ Bittalab yo'l (`mark-returned-to-market`, «Marketga qaytarish») ham xuddi shu ustunlarni yozadi, lekin market QR
 * sessiyasini YOPMAYDI (`consumed_at`). Ommaviy yo'l esa sessiyani AYNAN shu `now` bilan yopadi — partiya shu
 * belgidan ajratiladi (ega qarori 2026-11-10: «Topshirilgan»da faqat HQ'da shu sahifadan berilganlar). Migratsiya
 * 155 to'ldirgan eski qatorlarda vaqt tracking yozuvidan olingan (bir necha ms farq) — shuning uchun ± oraliq.
 */

/** Sessiya `consumed_at` ↔ buyurtma `market_handover_at` farqi chegarasi (eski to'ldirilgan qatorlar uchun). */
export const HANDOVER_BATCH_SESSION_TOLERANCE_SQL = "interval '5 seconds'";

/** Sahifa o'lchamlari (kartalar 3 ustunli to'r — 12 ga karrali). */
export const HANDOVER_BATCH_PAGE_LIMITS = [12, 24, 48] as const;
export const HANDOVER_BATCH_DEFAULT_LIMIT = 24;

export type HandoverBatchKey = {
  market_id: string;
  /** `market_handover_at` epoch mikrosekundlarda (bigint qatori). */
  handed_at_us: string;
  /** `market_handover_by` (raqamli foydalanuvchi id) yoki `null` (eski qatorlar). */
  handed_by: string | null;
};

const DIGITS = /^\d{1,20}$/;

/** Faqat matn / son qiymat — obyektni `[object Object]` qilib yubormaslik uchun. */
const asText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** `<market_id>_<handed_at_us>_<handed_by|0>` — URL'da xavfsiz, shaffof kalit. */
export const formatHandoverBatchId = (key: HandoverBatchKey): string =>
  `${key.market_id}_${key.handed_at_us}_${key.handed_by ?? '0'}`;

/** Yaroqsiz kalit — `null` (chaqiruvchi 400 qaytaradi). */
export const parseHandoverBatchId = (raw: unknown): HandoverBatchKey | null => {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split('_');
  if (parts.length !== 3 || !parts.every((part) => DIGITS.test(part))) {
    return null;
  }
  const [market_id, handed_at_us, by] = parts;
  if (market_id === '0' || handed_at_us === '0') return null;
  return { market_id, handed_at_us, handed_by: by === '0' ? null : by };
};

export type HandoverBatchMethod = 'qr' | 'pin' | 'no_qr' | 'manual';

const KNOWN_METHODS = new Set<HandoverBatchMethod>([
  'qr',
  'pin',
  'no_qr',
  'manual',
]);

/**
 * Kartaning asosiy usuli: qo'lda bo'lmagan buyurtmalarning usuli (bir partiyada hammasi bir xil — sessiya QR yoki
 * kod bilan ochilgan). Hamma buyurtma qo'lda bo'lsa — `manual`; eski qatorlarda usul yo'q — `null`.
 */
export const resolveHandoverBatchMethod = (
  nonManualMethod: unknown,
  manualCount: number,
  ordersCount: number,
): HandoverBatchMethod | null => {
  const method = asText(nonManualMethod).trim() as HandoverBatchMethod;
  if (KNOWN_METHODS.has(method) && method !== 'manual') return method;
  return manualCount > 0 && manualCount >= ordersCount ? 'manual' : null;
};

/** Guruhlangan SQL qatori (`getRawMany`). */
export type HandoverBatchRawRow = {
  market_id: string;
  handed_at_us: string;
  handed_by: string | null;
  day: string;
  orders_count: string | number;
  total_price_sum: string | number;
  manual_count: string | number;
  method: string | null;
};

export type HandoverBatchView = {
  id: string;
  market_id: string;
  market: {
    id: string;
    name: string | null;
    phone_number: string | null;
  } | null;
  /** ISO vaqt (millisekundgacha). */
  handed_at: string;
  /** Toshkent kuni `YYYY-MM-DD` — kun sarlavhasi serverdan (qurilma soati boshqa mintaqada bo'lishi mumkin). */
  day: string;
  handed_by: { id: string; name: string | null } | null;
  method: HandoverBatchMethod | null;
  manual_count: number;
  orders_count: number;
  total_price_sum: number;
};

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const toHandoverBatchView = (
  row: HandoverBatchRawRow,
  market: Record<string, unknown> | null | undefined,
  handedByName: string | null | undefined,
): HandoverBatchView => {
  const handedBy = row.handed_by == null ? null : String(row.handed_by);
  const ordersCount = toNumber(row.orders_count);
  const manualCount = toNumber(row.manual_count);
  return {
    id: formatHandoverBatchId({
      market_id: String(row.market_id),
      handed_at_us: String(row.handed_at_us),
      handed_by: handedBy,
    }),
    market_id: String(row.market_id),
    market: market
      ? {
          id: asText(market.id) || String(row.market_id),
          name: typeof market.name === 'string' ? market.name : null,
          phone_number:
            typeof market.phone_number === 'string'
              ? market.phone_number
              : null,
        }
      : null,
    handed_at: new Date(
      Math.floor(Number(row.handed_at_us) / 1000),
    ).toISOString(),
    day: String(row.day),
    handed_by: handedBy ? { id: handedBy, name: handedByName ?? null } : null,
    method: resolveHandoverBatchMethod(row.method, manualCount, ordersCount),
    manual_count: manualCount,
    orders_count: ordersCount,
    total_price_sum: toNumber(row.total_price_sum),
  };
};
