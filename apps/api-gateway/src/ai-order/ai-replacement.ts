import { formatOrderNumber } from '@app/common';

/**
 * AI ALMASHTIRISH (kafolat-swap) — ai-parse preview'iga eski buyurtmani
 * bog'lash. Manba: BeePost `ai-order.service.ts` `resolveReplacement`
 * (~670): AI `is_replacement` desa, telefonning oxirgi 9 raqami bo'yicha
 * SHU marketning yetkazilgan, hali almashtirilmagan buyurtmalari (yangisi
 * birinchi, ko'pi bilan 10 ta) — eng yangisi AVTOMATIK tanlanadi.
 *
 * Elchida nomzodlar `GET /orders/replaceable` bilan AYNI yo'ldan olinadi
 * (identity `customer.search` → order-service `order.replaceable`, market
 * doirasi `resolveAiMarket` da) — yangi SQL qoidasi YO'Q. Bu modul faqat sof
 * funksiyalar: RPC chaqirmaydi.
 */

/** Preview'dagi nomzodlar soni (BeePost `take(10)`). */
export const AI_REPLACEMENT_MAX_CANDIDATES = 10;
/**
 * `order.replaceable` dan olinadigan qatorlar (order-service `MAX_LIMIT`).
 * U `sold_at` bo'yicha saralaydi — "eng yangi" (yaratilgan vaqt, BeePost
 * `created_at DESC`) 10 talik sahifadan tushib qolmasin deb kengroq olinib,
 * saralash va 10 taga qisqartirish shu yerda (`pickAiReplacementRows`).
 */
export const AI_REPLACEMENT_FETCH_LIMIT = 100;
/** Qidiruv shifti — ai-parse umumiy byudjetidan oshmaydi (fail-open). */
export const AI_REPLACEMENT_LOOKUP_TIMEOUT_MS = 4_000;
/** Byudjetdan shundan kam vaqt qolsa qidirilmaydi (`unavailable`). */
export const AI_REPLACEMENT_MIN_BUDGET_MS = 1_000;
/** Nomzod qatoridagi mahsulotlar matni chegarasi. */
const ITEMS_TEXT_MAX_CHARS = 120;
const ID_RE = /^\d{1,18}$/;

/** Bog'langan almashtirishda operator hal qilmaydigan narx kamchiliklari. */
const REPLACEMENT_PRICE_ISSUES = new Set(['price_missing', 'price_confirm']);

/**
 * Preview'dagi qidiruv natijasi (`replacement_lookup`):
 *  - `found` — eski buyurtma bog'landi (`replaced_order_id`);
 *  - `not_found` — qidirildi, mos eski buyurtma yo'q (yoki telefon 9
 *    raqamdan kam) — ODDIY buyurtma (narx odatdagidek shart);
 *  - `taken` — nomzodlar bor, lekin hammasi shu xabardagi oldingi
 *    almashtirishga bog'landi — bot yaratmaydi (kabinetda);
 *  - `unavailable` — qidiruv xato/timeout yoki byudjet qolmadi — "topilmadi"
 *    EMAS: bot yaratmaydi (qayta yuborish yoki kabinet).
 */
export type AiReplacementLookup =
  'found' | 'not_found' | 'taken' | 'unavailable';

/** Preview'dagi bitta eski buyurtma nomzodi (kichik: PII yo'q). */
export interface AiReplacementCandidate {
  id: string;
  /** `EL-<id+100000>` — mijoz/operator ko'radigan raqam. */
  order_number: string | null;
  /** Eski buyurtma yaratilgan vaqt (ISO). */
  created_at: string | null;
  /** "Atir 50 ml ×2, Krem ×1" — mahsulot nomlari (katalogdan). */
  items: string;
  total_price: number;
}

/** Bitta telefon qidiruvi natijasi. */
export interface AiReplacementFound {
  /** Yangisi birinchi, ko'pi bilan 10 ta. */
  candidates: AiReplacementCandidate[];
  /** Barcha mos eski buyurtmalar soni (`order.replaceable` `total`). */
  total: number;
}

type Row = Record<string, unknown>;

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** Telefonning oxirgi 9 raqami; 9 raqam bo'lmasa `null` (qidiruv yo'q). */
export function aiReplacementPhone9(phone: unknown): string | null {
  const digits = text(phone).replace(/\D/g, '').slice(-9);
  return digits.length === 9 ? digits : null;
}

/**
 * identity `customer.search` qatorlaridan AYNAN shu raqamli mijozlar.
 * Qidiruv raqamni matn ICHIDAN izlaydi (`LIKE '%…%'`, ism ham): masalan
 * 989012345 «+998 90 123 45 67» ichida ham bor — begona mijozning eski
 * buyurtmasi avto-tanlanib ketmasin deb faqat telefonining OXIRGI 9 raqami
 * teng bo'lganlar qoladi (milliy raqam bo'yicha aniq moslik).
 */
export function aiReplacementCustomerIds(
  rows: ReadonlyArray<Row | null | undefined>,
  phone9: string,
): string[] {
  const list: ReadonlyArray<Row | null | undefined> = Array.isArray(rows)
    ? rows
    : [];
  return [
    ...new Set(
      list
        .filter((row) => aiReplacementPhone9(row?.phone_number) === phone9)
        .map((row) => text(row?.id))
        .filter((id) => ID_RE.test(id)),
    ),
  ];
}

/** AI almashtirish deb belgilagan preview (order-service `is_replacement`). */
export function isAiReplacementPreview(preview: unknown): preview is Row {
  return (
    !!preview &&
    typeof preview === 'object' &&
    !Array.isArray(preview) &&
    (preview as Row).is_replacement === true
  );
}

function createdAtOf(row: Row): { iso: string | null; ms: number } {
  const raw = row.createdAt ?? row.created_at;
  const ms =
    raw instanceof Date
      ? raw.getTime()
      : typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? /^\d+$/.test(raw.trim())
            ? Number(raw)
            : Date.parse(raw)
          : Number.NaN;
  return Number.isFinite(ms)
    ? { iso: new Date(ms).toISOString(), ms }
    : { iso: null, ms: Number.NEGATIVE_INFINITY };
}

/** Raqamli id'lar (bigint satr) — kattasi oldin (vaqt teng yoki noma'lum bo'lsa). */
function compareIdDesc(a: string, b: string): number {
  return b.length - a.length || (b > a ? 1 : b < a ? -1 : 0);
}

function itemsText(row: Row): string {
  const items = Array.isArray(row.items) ? (row.items as Row[]) : [];
  const joined = items
    .map((item) => {
      const quantity = Math.max(1, Math.trunc(Number(item?.quantity) || 1));
      return `${text(item?.product_name) || 'mahsulot'} ×${quantity}`;
    })
    .join(', ');
  return joined.length > ITEMS_TEXT_MAX_CHARS
    ? `${joined.slice(0, ITEMS_TEXT_MAX_CHARS - 1)}…`
    : joined;
}

/**
 * `order.replaceable` qatorlaridan nomzod qatorlar: faqat SHU market
 * (order-service filtriga qo'shimcha himoya), yangisi birinchi (yaratilgan
 * vaqt, teng bo'lsa katta id — BeePost `created_at DESC`), ko'pi bilan 10
 * ta. Mahsulot nomlari faqat shularga to'ldiriladi.
 */
export function pickAiReplacementRows(
  rows: ReadonlyArray<Row | null | undefined>,
  marketId: string,
): Row[] {
  const market = text(marketId);
  const list: ReadonlyArray<Row | null | undefined> = Array.isArray(rows)
    ? rows
    : [];
  return list
    .filter(
      (row): row is Row =>
        !!row &&
        typeof row === 'object' &&
        ID_RE.test(text(row.id)) &&
        text(row.market_id) === market,
    )
    .map((row) => ({ row, ms: createdAtOf(row).ms }))
    .sort(
      (a, b) => b.ms - a.ms || compareIdDesc(text(a.row.id), text(b.row.id)),
    )
    .slice(0, AI_REPLACEMENT_MAX_CANDIDATES)
    .map(({ row }) => row);
}

/** `order.replaceable` qatorlari → nomzodlar (`pickAiReplacementRows` tartibida). */
export function toAiReplacementCandidates(
  rows: ReadonlyArray<Row | null | undefined>,
  marketId: string,
): AiReplacementCandidate[] {
  return pickAiReplacementRows(rows, marketId).map((row) => ({
    id: text(row.id),
    order_number: formatOrderNumber(row.id),
    created_at: createdAtOf(row).iso,
    items: itemsText(row),
    total_price: Number(row.total_price) || 0,
  }));
}

/**
 * Preview'ga natija: `replacement_lookup`, `replaced_order_id`,
 * `replacement_candidates` va `replacement_candidates_total`.
 * `found = null` — qidiruv bo'lmadi/yiqildi (`unavailable`). Eng yangi
 * nomzod avto-tanlanadi, lekin shu xabarda boshqa preview'ga bog'langani
 * (`used`) o'tkazib yuboriladi — bitta eski buyurtma ikki marta
 * bog'lanmasin (ikkinchisi ✅ da baribir rad etilardi).
 *
 * Bog'lansa — BeePost kabi narx so'ralmaydi (bo'sh narx ai-confirm'da 0 —
 * bepul almashtirish) va kichik narx tasdiq talab qilmaydi: `price_missing`
 * / `price_confirm` olib tashlanadi, `ready` qayta hisoblanadi. Aks holda
 * kamchiliklar o'zgarmaydi.
 *
 * ⚠️ Veb AI sahifasi kamchiliklarni o'zi hisoblaydi (`evalPreview`) — bu
 * kalitlar u yerda o'qilmaydi, faqat bot va qo'shimcha ma'lumot.
 */
export function applyAiReplacement(
  preview: Row,
  found: AiReplacementFound | null,
  used: Set<string> = new Set(),
): void {
  const candidates = found ? [...found.candidates] : [];
  const linked =
    candidates.find((candidate) => !used.has(candidate.id))?.id ?? null;
  const lookup: AiReplacementLookup = !found
    ? 'unavailable'
    : linked
      ? 'found'
      : candidates.length
        ? 'taken'
        : 'not_found';
  preview.replacement_lookup = lookup;
  preview.replaced_order_id = linked;
  preview.replacement_candidates = candidates;
  preview.replacement_candidates_total = candidates.length
    ? Math.max(Math.trunc(Number(found?.total) || 0), candidates.length)
    : 0;
  if (!linked) return;
  used.add(linked);
  const issues = (Array.isArray(preview.issues) ? preview.issues : []).filter(
    (issue) => !REPLACEMENT_PRICE_ISSUES.has(String(issue)),
  );
  preview.issues = issues;
  preview.ready = issues.length === 0;
}
