/**
 * A1(a) — buyurtma matnidagi PUL eslatmalari (so'mda), LLM'siz.
 *
 * Model `total_price` ni xato o'qishi mumkin ("150 000 so'm" → 15 000,
 * "3 ta, donasi 250 ming" → 250 000). Preview model qiymatini matndagi
 * eslatmalar bilan solishtiradi (`price_check`) — avto-tuzatish YO'Q, faqat
 * yumshoq ogohlantirish.
 *
 * Qabul qilinadigan eslatma (aks holda — oddiy son, e'tiborsiz):
 *  - ko'paytiruvchi bilan: `150 ming`, `150k`, `1.5 mln`, `1,5 млн`,
 *    `150 тыс`, `4 mln 200` (= 4 200 000);
 *  - valyuta so'zi bilan: `150000 so'm`, `150 000 сум`;
 *  - minglik guruhlangan: `150 000`, `1.500.000`, `150,000`.
 * Rad etiladi: `$` / `usd` / `dollar` (so'm emas), keyin `ta` / `dona` / `x`
 * (miqdor), `[TEL_n]` tokenlari, 1 000 so'mdan kichik qiymat.
 */

const MULT: ReadonlyArray<[RegExp, number]> = [
  [/^(?:mln|млн|million|миллион|mlн)$/i, 1_000_000],
  [/^(?:ming|минг|тыс|тысяч|k|к)$/i, 1_000],
];

const AMOUNT_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_\[])` +
    // 1: son (minglik guruhlangan yoki o'nlik kasrli)
    String.raw`(\d{1,3}(?:[ .,]\d{3})+|\d+(?:[.,]\d{1,2})?)` +
    String.raw`\s*` +
    // 2: ko'paytiruvchi
    String.raw`(mln|млн|million|миллион|ming|минг|тыс(?:яч)?|k|к)?` +
    // 3: "-dan" (dona narxi: "150 mingdan")
    String.raw`(dan|дан)?` +
    String.raw`(?![\p{L}])` +
    // 4: "mln" dan keyingi qo'shimcha ("4 mln 200")
    String.raw`(?:\s*(\d{1,3})(?![\d.,]*\s*(?:ta|dona|шт|x|х)\b)(?!\d))?` +
    String.raw`\s*` +
    // 5: valyuta / rad etuvchi qo'shimchalar
    String.raw`(so['ʻ‘’\x60]?m|сум|сўм|sum|\$|usd|dollar|долл\w*|ta\b|dona\b|шт\b|x\b|х\b)?`,
  'giu',
);

function parseNumber(raw: string, hasMultiplier: boolean): number | null {
  const s = raw.trim();
  // Minglik guruhlangan: "150 000", "1.500.000", "150,000".
  if (/^\d{1,3}(?:[ .,]\d{3})+$/.test(s))
    return Number(s.replace(/[ .,]/g, ''));
  // O'nlik kasr ("1.5", "1,5") faqat ko'paytiruvchi bilan ma'noli.
  if (/^\d+[.,]\d{1,2}$/.test(s)) {
    return hasMultiplier ? Number(s.replace(',', '.')) : null;
  }
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** Eslatma turi: dona narxi, jami yoki noma'lum. */
export type MoneyMentionKind = 'unit' | 'total' | null;

export interface MoneyMention {
  /** So'mda. */
  value: number;
  kind: MoneyMentionKind;
}

/** Eslatmadan OLDIN (≤ 20 belgi) yoki KEYIN kelsa — dona narxi. */
const UNIT_BEFORE_RE =
  /(donasi|dona narxi|har biri|har bittasi|bittasi|narxi bir dona|по|за шт\.?|за штуку)\s*[:\-–]?\s*$/iu;
const UNIT_AFTER_RE = /^\s*(?:so['ʻ‘’\x60]?m|сум|сўм)?\s*(?:dan|дан|за\s*шт)/iu;
/** Eslatmadan OLDIN kelsa — jami. */
const TOTAL_BEFORE_RE =
  /(jami|umumiy|hammasi|итого|всего|общая сумма|summa)\s*[:\-–]?\s*$/iu;

/**
 * Matndagi so'm eslatmalari (qiymat bo'yicha takrorlarsiz, uchrash
 * tartibida) va turi. `[TEL_n]` tokenlari tegilmaydi.
 */
export function extractMoneyMentionsDetailed(
  text: string | null | undefined,
): MoneyMention[] {
  if (typeof text !== 'string' || !text) return [];
  const out: MoneyMention[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const [whole, numRaw, multRaw, danRaw, extraRaw, suffixRaw] = m;
    const suffix = (suffixRaw ?? '').toLowerCase();
    if (/^(\$|usd|dollar|долл)/.test(suffix)) continue;
    if (/^(ta|dona|шт|x|х)$/.test(suffix)) continue;
    const mult = multRaw
      ? (MULT.find(([re]) => re.test(multRaw))?.[1] ?? 1)
      : 1;
    const grouped = /^\d{1,3}(?:[ .,]\d{3})+$/.test(numRaw.trim());
    const currency = /^(so|сум|сўм|sum)/.test(suffix);
    if (mult === 1 && !grouped && !currency) continue;
    const n = parseNumber(numRaw, mult > 1);
    if (n === null) continue;
    let value = n * mult;
    if (mult === 1_000_000 && extraRaw) value += Number(extraRaw) * 1_000;
    value = Math.round(value);
    if (value < 1_000 || value > 10_000_000_000) continue;
    const start = m.index ?? 0;
    const before = text.slice(Math.max(0, start - 20), start);
    const after = text.slice(start + whole.length, start + whole.length + 12);
    const kind: MoneyMentionKind =
      danRaw || UNIT_BEFORE_RE.test(before) || UNIT_AFTER_RE.test(after)
        ? 'unit'
        : TOTAL_BEFORE_RE.test(before)
          ? 'total'
          : null;
    if (!out.some((x) => x.value === value)) out.push({ value, kind });
  }
  return out;
}

/** Faqat qiymatlar (so'mda). */
export function extractMoneyMentions(
  text: string | null | undefined,
): number[] {
  return extractMoneyMentionsDetailed(text).map((m) => m.value);
}

/**
 * `price_check` qarori: model narxi matndagi eslatmalarning hech biriga
 * (yakka, yig'indi — mahsulot + dostavka, dona narxi × jami miqdor) teng
 * bo'lmasa — `true`. "Jami" deb aytilgan summa miqdorga KO'PAYTIRILMAYDI.
 * Eslatma yo'q yoki narx yo'q — `false`.
 */
export function priceMismatchesMentions(
  totalPrice: number | null,
  mentions: readonly (MoneyMention | number)[],
  totalQuantity: number,
): boolean {
  const list: MoneyMention[] = mentions.map((m) =>
    typeof m === 'number' ? { value: m, kind: null } : m,
  );
  if (totalPrice === null || !list.length) return false;
  const ok = new Set<number>(list.map((m) => m.value));
  ok.add(list.reduce((a, b) => a + b.value, 0));
  const qty =
    Number.isFinite(totalQuantity) && totalQuantity > 1 ? totalQuantity : 1;
  for (const m of list) if (m.kind !== 'total') ok.add(m.value * qty);
  return !ok.has(Math.round(totalPrice));
}
