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
 *    `150 тыс`, `4 mln 200` (= 4 200 000), kelishik qo'shimchasi bilan ham
 *    (`150 mingdan`, `150 mingga`, `150 minglik`, `1,5 mlnga`);
 *  - valyuta so'zi bilan (yopishgan bo'lsa ham): `150000 so'm`,
 *    `150000so'm`, `1500000сум`;
 *  - minglik guruhlangan: `150 000`, `1.500.000`, `150,000`.
 * Rad etiladi: `$` / `usd` / `dollar` (oldin yoki keyin — so'm emas), keyin
 * `ta` / `dona` / `шт` / `x` (miqdor), `[TEL_n]` tokenlari, 1 000 so'mdan
 * kichik qiymat.
 *
 * Sonlarning yopishishi:
 *  - `ming`/`тыс`/`k` oldidagi bo'sh joy bilan ajralgan guruhlardan faqat
 *    OXIRGISI olinadi ("atir 2 150 ming" → 150 000, "42 350 ming" → 350 000);
 *  - ko'paytiruvchisiz son `uy`/`kv`/`dom`/`razmer`... dan keyin 1–2 xonali
 *    birinchi guruh bilan kelsa — u guruh tashlanadi ("uy 12 150 000" →
 *    150 000);
 *  - `mln` dan keyingi qo'shimcha son ("4 mln 200") faqat undan keyin qator
 *    oxiri, tinish belgisi, `ming`, `so'm` yoki `dan` kelsa olinadi
 *    ("3 mln 2 kunda" → 3 000 000).
 *
 * ⚠️ Eslatmalar TAKRORLANADI (qiymat bo'yicha birlashtirilmaydi): "atir
 * 150 ming, krem 150 ming" — ikki mahsulot. Takrorsiz ro'yxat faqat UI
 * uchun (`uniqueMentionValues`).
 */

const NUM_SRC =
  // 1: son — ATOMAR (lookahead + backreference): regex orqaga qaytib
  // "150000so'm" dan "15000" ni ajratib olmasin. Ikkala muqobil ham
  // raqam bilan CHEGARALANGAN (`(?!\d)`): "901 234 567" ning bo'lagi
  // "901 234", "150 0000" ning "150 000", "1 2345" ning "1 234" bo'lmaydi.
  String.raw`(?=(\d{1,3}(?:[ .,]\d{3})+(?!\d)|\d+(?:[.,]\d{1,2})?(?!\d)))\1`;
const CURRENCY_SRC = String.raw`so['ʻ‘’\x60]?m|сум|сўм`;

const AMOUNT_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_\[])` +
    NUM_SRC +
    String.raw`[ \t]*` +
    // 2: ko'paytiruvchi
    String.raw`(mln|млн|million|миллион|ming|минг|тыс(?:яч)?|k|к)?` +
    // 3: kelishik qo'shimchasi ("150 mingdan", "150 mingga", "150 minglik",
    // "150 minggacha" — oraliq oxiri)
    String.raw`(dan|дан|gacha|гача|ga|ni|lik|га|ни|лик)?` +
    // Songa yopishgan harf — faqat valyuta so'zi bo'lsa ("150000so'm").
    String.raw`(?!(?!${CURRENCY_SRC}|sum(?!\p{L}))\p{L})` +
    // 4: "mln" dan keyingi qo'shimcha ("4 mln 200") — faqat undan keyin
    // qator oxiri / tinish belgisi / ming / so'm / dan kelsa.
    String.raw`(?:(?<=mln|млн|million|миллион)[ \t]*(\d{1,3})` +
    String.raw`(?=[ \t]*(?:$|[.,;:!?)\r\n]|ming|минг|тыс|${CURRENCY_SRC}|sum|dan|дан)))?` +
    String.raw`[ \t]*` +
    // 5: valyuta / rad etuvchi qo'shimchalar
    String.raw`(${CURRENCY_SRC}|sum(?!\p{L})|\$|usd|dollar|долл\p{L}*|` +
    String.raw`(?:ta|dona|шт|x|х)(?![\p{L}\p{N}]))?`,
  'giu',
);

const GROUPED_RE = /^\d{1,3}(?:[ .,]\d{3})+$/;

function parseNumber(raw: string, hasMultiplier: boolean): number | null {
  const s = raw.trim();
  // Minglik guruhlangan: "150 000", "1.500.000", "150,000".
  if (GROUPED_RE.test(s)) return Number(s.replace(/[ .,]/g, ''));
  // O'nlik kasr ("1.5", "1,5") faqat ko'paytiruvchi bilan ma'noli.
  if (/^\d+[.,]\d{1,2}$/.test(s)) {
    return hasMultiplier ? Number(s.replace(',', '.')) : null;
  }
  return /^\d+$/.test(s) ? Number(s) : null;
}

const MULT: ReadonlyArray<[RegExp, number]> = [
  [/^(?:mln|млн|million|миллион)$/i, 1_000_000],
  [/^(?:ming|минг|тыс|тысяч|k|к)$/i, 1_000],
];

/**
 * Eslatma turi:
 *  - `unit` — dona narxi ("donasi", "har biri", "150 mingdan");
 *  - `total` — jami ("jami", "итого", "dostavka bilan X");
 *  - `delivery` — dostavka narxi ("dostavka 20 ming", "20 ming dostavka");
 *  - `prepaid` — oldindan to'lov / zaklad / qoldiq ("oldindan 50 ming",
 *    "50 ming to'landi") — buyurtma summasidan AYIRILMAYDI va unga
 *    qo'shilmaydi (u `paid_online_amount` ga ketadi);
 *  - `null` — noma'lum.
 */
export type MoneyMentionKind = 'unit' | 'total' | 'delivery' | 'prepaid' | null;

export interface MoneyMention {
  /** So'mda. */
  value: number;
  kind: MoneyMentionKind;
  /**
   * Narx matnda NOANIQ: oraliq ("120-150 ming"), muqobil ("120 yoki
   * 150 ming"), chegirma / eski-yangi narx. Bunday matnda `price_check`
   * mismatch TEKSHIRILMAYDI (model `null` + warnings qaytaradi).
   */
  ambiguous?: true;
  /**
   * Faqat `delivery`: dostavka summasi OLDINGI jami ichida ("Jami 170 000
   * (dostavka 20 000 bilan)", "shundan dostavka 20 ming", "включая
   * доставку") — jamiga qo'shilmaydi.
   */
  included?: true;
  /**
   * Eslatmaning minglik / millionlik qismi (2–10) matnda miqdor sifatida
   * ham aniq aytilgan ("televizor 2 ta 2 mln") — `qty_check` uni pul deb
   * o'qilgan miqdor hisoblamaydi.
   */
  count_stated?: true;
}

const L = String.raw`(?:^|[^\p{L}])`;
const SEP_END = String.raw`\s*[:\-–=]?\s*$`;
const CUR_OPT = String.raw`^\s*(?:${CURRENCY_SRC}|sum)?\s*`;

const PREPAID_WORDS = String.raw`oldindan|predoplata|предоплат\p{L}*|avans|аванс|zaklad|задаток|qolgani|qolgan|остаток|оплачен\p{L}*`;
const DELIVERY_WORDS = String.raw`dostavka(?:si|ga|ni)?|dastavka(?:si|ga|ni)?|yetkazib\s+berish|yetkazish|доставк[аиуой]`;

/** Eslatmadan OLDIN (shu qatorda) — oldindan to'lov. */
const PREPAID_BEFORE_RE = new RegExp(
  L +
    String.raw`(?:${PREPAID_WORDS})(?:\s+(?:to['ʻ‘’\x60]?lov|to['ʻ‘’\x60]?lan\p{L}*|summa\p{L}*|puli))?` +
    SEP_END,
  'iu',
);
/** Eslatmadan KEYIN — oldindan to'lov ("50 ming to'landi", "100 ming zaklad"). */
const PREPAID_AFTER_RE = new RegExp(
  CUR_OPT +
    String.raw`(?:to['ʻ‘’\x60]?lan\p{L}*|tashla\p{L}*|kartaga|o['ʻ‘’\x60]?tkaz\p{L}*|` +
    String.raw`(?:click|payme|uzum|клик)\s+(?:orqali|орқали|через)|переве\p{L}*|` +
    String.raw`(?:${PREPAID_WORDS})(?!\p{L}))`,
  'iu',
);
/** Eslatmadan OLDIN — dostavka narxi. */
const DELIVERY_BEFORE_RE = new RegExp(
  L +
    String.raw`(?:${DELIVERY_WORDS})(?:\s+(?:narxi|puli|haqqi|стоимость))?` +
    SEP_END,
  'iu',
);
/** Tarif ro'yxatidagi joy so'zlari ("Toshkent 20 000, viloyatlarga 35 000"). */
const PLACE_WORD = String.raw`(?:toshkent\p{L}*|tashkent\p{L}*|viloyat\p{L}*|shahar\p{L}*|shahri|bo['ʻ‘’\x60]?ylab|ichida|tuman\p{L}*|по|ташкент\p{L}*|тошкент\p{L}*|област\p{L}*|регион\p{L}*|город\p{L}*|вилоят\p{L}*)`;
const PLACE_WORDS = String.raw`${PLACE_WORD}(?:\s+${PLACE_WORD}){0,2}`;
/**
 * Eslatmadan OLDIN — dostavka tarifi: "Dostavka: Toshkent 20 000",
 * "Dostavka Toshkent bo'ylab 20 ming".
 */
const DELIVERY_TARIFF_BEFORE_RE = new RegExp(
  L + String.raw`(?:${DELIVERY_WORDS})\s*:?\s*${PLACE_WORDS}` + SEP_END,
  'iu',
);
/**
 * Tarif davomi: oldingi eslatma (shu qatorda) dostavka, oraliqda faqat
 * ", viloyatlarga " / " / viloyat " — bu ham dostavka.
 */
const TARIFF_CONTINUATION_RE = new RegExp(
  String.raw`^\s*(?:${CURRENCY_SRC}|sum)?\s*[,/;]\s*${PLACE_WORDS}` + SEP_END,
  'iu',
);
/**
 * Dostavka OLDINGI jami ichida: "shundan dostavka 20 ming", "shu jumladan
 * dostavka", "включая доставку", "в т.ч. доставка", "в том числе доставка".
 */
const DELIVERY_INCLUDED_BEFORE_RE = new RegExp(
  L +
    String.raw`(?:shundan|jumladan|ichida|включая|в\s+т\.?\s*ч\.?|в\s+том\s+числе)\s*` +
    String.raw`(?:${DELIVERY_WORDS})(?:\s+(?:narxi|puli|haqqi|стоимость))?` +
    SEP_END,
  'iu',
);
/** "(dostavka 20 000 bilan)" — summa jami ichida. */
const DELIVERY_INCLUDED_AFTER_RE = new RegExp(
  CUR_OPT + String.raw`(?:bilan|билан)(?!\p{L})`,
  'iu',
);
/** Eslatmadan KEYIN — inkor ("180 ming emas 150 ming") — eslatma tashlanadi. */
const NEGATED_AFTER_RE = new RegExp(
  CUR_OPT + String.raw`(?:emas|эмас)(?!\p{L})`,
  'iu',
);
/**
 * Eslatmadan KEYIN — dostavka narxi ("20 ming dostavka"), agar dostavka
 * so'zidan keyin son, "bilan" yoki "bepul/tekin/bizdan" kelmasa
 * ("150 ming dostavka 20 ming" — 150 ming mahsulot narxi).
 */
const DELIVERY_AFTER_RE = new RegExp(
  CUR_OPT +
    String.raw`(?:${DELIVERY_WORDS})(?!\p{L})` +
    String.raw`(?!\s*(?:[:\-–=]\s*)?(?:\d|bilan|bepul|tekin|bizdan|бесплатн|до(?!\p{L})))`,
  'iu',
);
/** Eslatmadan OLDIN — jami. */
const TOTAL_BEFORE_RE = new RegExp(
  L +
    String.raw`(?:jami|umumiy|hammasi|итого|всего|общая\s+сумма|summa|сумма|` +
    String.raw`(?:dostavka|dastavka)(?:si)?\s+bilan|с\s+доставкой)` +
    String.raw`(?:\s+(?:narxi|summa(?:si)?|сумма))?` +
    SEP_END,
  'iu',
);
/**
 * Eslatmadan KEYIN — jami ("210 000 jami", "150 ming dostavka bilan").
 * "150 ming dostavka bilan jami 170 ming" / "... dostavka bilan 170" —
 * keyin son kelsa 150 ming jami EMAS (mahsulot narxi).
 */
const TOTAL_AFTER_RE = new RegExp(
  CUR_OPT +
    String.raw`(?:(?:jami|итого|всего)(?!\p{L})|` +
    String.raw`(?:(?:dostavka|dastavka)(?:si)?\s+bilan|с\s+доставкой)` +
    String.raw`(?!\s*(?:jami|итого|всего)?\s*[:\-–=]?\s*\d))`,
  'iu',
);
/** Eslatmadan OLDIN — dona narxi. */
const UNIT_BEFORE_RE = new RegExp(
  L +
    String.raw`(?:donasi|dona\s+narxi|har\s+biri|har\s+bittasi|bittasi|narxi\s+bir\s+dona|по|за\s+шт\.?|за\s+штуку)` +
    SEP_END,
  'iu',
);
/** Eslatmadan KEYIN — dona narxi ("150 000 so'mdan"). */
const UNIT_AFTER_RE = new RegExp(
  CUR_OPT + String.raw`(?:dan|дан|за\s*шт)`,
  'iu',
);

/** Eslatmadan OLDIN — so'm emas. */
const FOREIGN_BEFORE_RE =
  /(?:\$|(?:^|[^\p{L}])(?:usd|dollar|долл\p{L}*))\s*$/iu;
/** Raqamlar yopishishi: "uy 12 150 000" — birinchi guruh uy raqami. */
const HOUSE_BEFORE_RE =
  /(?:^|[^\p{L}])(?:uy|kv|dom|д|кв|kvartal|mavze|razmer|размер)\.?\s*[:#№-]?\s*$/iu;
/** Eslatmadan OLDIN — oraliq yoki muqobil ("120-150 ming", "120 yoki 150"). */
const ALT_BEFORE_RE = new RegExp(
  String.raw`(?:\d|ming|минг|mln|млн|k|к|тыс|${CURRENCY_SRC})\s*(?:[-–—/]|yoki|или|ёки)\s*$`,
  'iu',
);
/**
 * Chegirma yoki eski/yangi narx so'zi — narx noaniq, LEKIN faqat so'z pul
 * eslatmasiga yaqin (≤ `AMBIGUOUS_NEAR` belgi) bo'lsa yoki matnda kamida
 * ikki xil mahsulot summasi bo'lsa. Shablon footer'idagi "Aksiya!" yolg'iz
 * narxli buyurtmada mismatch tekshiruvini o'chirmaydi.
 */
const AMBIGUOUS_WORD_RE =
  /(?<!\p{L})(?:skidka\p{L}*|chegirma\p{L}*|скидк\p{L}*|aksiya\p{L}*|акци\p{L}*|eski\s+narx\p{L}*|yangi\s+narx\p{L}*|стар\p{L}*\s+цен\p{L}*|нов\p{L}*\s+цен\p{L}*)/giu;
const AMBIGUOUS_NEAR = 40;

/** Telefon: "+" dan keyingi raqamlar ("+7 999 123 45 67", "+998 90 1234 567"). */
const AFTER_PLUS_RE = /\+[\d \-().]*$/;
/** Telefon so'zi ("tel 901 234 567", "raqam: ..."). */
const PHONE_WORD_BEFORE_RE =
  /(?:^|[^\p{L}])(?:tel|telefon|raqam\p{L}*|nomer\p{L}*|тел|телефон|номер|рақам\p{L}*)\.?\s*[:-]?\s*$/iu;
/** 3-3-3 guruhli 9 raqam, UZ operator kodi bilan boshlanadi. */
const UZ_PHONE_333_RE =
  /^(?:20|33|5[05]|6[1-9]|7\d|88|9[013-57-9])\d[ .-]\d{3}[ .-]\d{3}$/;

/** Eslatmadan oldingi matn — faqat shu qatorda, ≤ 30 belgi. */
function lineBefore(text: string, start: number): string {
  const s = text.slice(Math.max(0, start - 30), start);
  const nl = Math.max(s.lastIndexOf('\n'), s.lastIndexOf('\r'));
  return nl >= 0 ? s.slice(nl + 1) : s;
}

/** Eslatmadan keyingi matn — faqat shu qatorda, ≤ 40 belgi. */
function lineAfter(text: string, end: number): string {
  const s = text.slice(end, end + 40);
  const nl = s.search(/[\r\n]/);
  return nl >= 0 ? s.slice(0, nl) : s;
}

function kindOf(before: string, after: string, dan: boolean): MoneyMentionKind {
  if (PREPAID_BEFORE_RE.test(before)) return 'prepaid';
  if (TOTAL_BEFORE_RE.test(before)) return 'total';
  if (DELIVERY_BEFORE_RE.test(before)) return 'delivery';
  if (UNIT_BEFORE_RE.test(before)) return 'unit';
  if (dan) return 'unit';
  if (PREPAID_AFTER_RE.test(after)) return 'prepaid';
  if (TOTAL_AFTER_RE.test(after)) return 'total';
  if (DELIVERY_AFTER_RE.test(after)) return 'delivery';
  if (UNIT_AFTER_RE.test(after)) return 'unit';
  return null;
}

/**
 * Matndagi so'm eslatmalari (uchrash tartibida, TAKRORLARI bilan) va turi.
 * `[TEL_n]` tokenlari tegilmaydi.
 */
export function extractMoneyMentionsDetailed(
  text: string | null | undefined,
): MoneyMention[] {
  if (typeof text !== 'string' || !text) return [];
  const out: MoneyMention[] = [];
  /** `out` bilan parallel: matndagi [boshi, oxiri). */
  const spans: [number, number][] = [];
  let rangeEnd = false;
  for (const m of text.matchAll(AMOUNT_RE)) {
    const [whole, numRaw0, multRaw, caseRaw, extraRaw, suffixRaw] = m;
    const start = m.index ?? 0;
    const suffix = (suffixRaw ?? '').toLowerCase();
    if (/^(\$|usd|dollar|долл)/.test(suffix)) continue;
    if (/^(ta|dona|шт|x|х)$/.test(suffix)) continue;
    const before = lineBefore(text, start);
    if (FOREIGN_BEFORE_RE.test(before)) continue;
    // Telefon: "+" dan keyin yoki "tel 901 234 567" (ai-service faqat
    // 2-3-2-2 / yaxlit UZ raqamini maskalaydi).
    if (AFTER_PLUS_RE.test(before)) continue;
    if (
      UZ_PHONE_333_RE.test(numRaw0.trim()) &&
      PHONE_WORD_BEFORE_RE.test(before)
    ) {
      continue;
    }
    const mult = multRaw
      ? (MULT.find(([re]) => re.test(multRaw))?.[1] ?? 1)
      : 1;
    let numRaw = numRaw0.trim();
    // "atir 2 150 ming" — ming oldida faqat oxirgi guruh.
    if (mult === 1_000 && /^\d{1,3}(?: \d{3})+$/.test(numRaw)) {
      numRaw = numRaw.slice(numRaw.lastIndexOf(' ') + 1);
    }
    // "uy 12 150 000" — 1–2 xonali birinchi guruh uy/kv raqami.
    if (
      mult === 1 &&
      /^\d{1,2} \d{3}(?:[ .,]\d{3})*$/.test(numRaw) &&
      HOUSE_BEFORE_RE.test(before)
    ) {
      numRaw = numRaw.slice(numRaw.indexOf(' ') + 1);
    }
    const grouped = GROUPED_RE.test(numRaw);
    const currency = /^(so|сум|сўм|sum)/.test(suffix);
    if (mult === 1 && !grouped && !currency) continue;
    const n = parseNumber(numRaw, mult > 1);
    if (n === null) continue;
    let value = n * mult;
    if (mult === 1_000_000 && extraRaw) value += Number(extraRaw) * 1_000;
    value = Math.round(value);
    if (value < 1_000 || value > 10_000_000_000) continue;
    const end = start + whole.length;
    const after = lineAfter(text, end);
    // "180 ming emas 150 ming" — inkor qilingan summa tashlanadi.
    if (NEGATED_AFTER_RE.test(after)) continue;
    const caseWord = (caseRaw ?? '').toLowerCase();
    const dan = caseWord === 'dan' || caseWord === 'дан';
    // "120 mingdan 150 minggacha" — oraliq.
    if (caseWord === 'gacha' || caseWord === 'гача') rangeEnd = true;
    let kind = kindOf(before, after, dan);
    if (kind === null && DELIVERY_TARIFF_BEFORE_RE.test(before)) {
      kind = 'delivery';
    }
    // Tarif davomi: "Toshkent 20 000, viloyatlarga 35 000".
    const prev = out.length - 1;
    if (kind === null && prev >= 0 && out[prev].kind === 'delivery') {
      const gap = text.slice(spans[prev][1], start);
      if (!/[\r\n]/.test(gap) && TARIFF_CONTINUATION_RE.test(gap)) {
        kind = 'delivery';
      }
    }
    const mention: MoneyMention = { value, kind };
    if (
      kind === 'delivery' &&
      (DELIVERY_INCLUDED_BEFORE_RE.test(before) ||
        DELIVERY_INCLUDED_AFTER_RE.test(after))
    ) {
      mention.included = true;
    }
    if (ALT_BEFORE_RE.test(before)) mention.ambiguous = true;
    out.push(mention);
    spans.push([start, end]);
  }
  if (rangeEnd || ambiguousWordApplies(text, out, spans)) {
    for (const m of out) m.ambiguous = true;
  }
  markStatedCounts(text, out);
  return out;
}

/**
 * Chegirma / eski-yangi narx so'zi narxni noaniq qiladimi: so'z biror
 * eslatmadan ≤ `AMBIGUOUS_NEAR` belgi uzoqlikda (bo'sh qator orqali emas)
 * yoki kamida ikki xil mahsulot (dostavka / oldindan to'lov emas) summasi
 * bor.
 */
function ambiguousWordApplies(
  text: string,
  mentions: readonly MoneyMention[],
  spans: readonly [number, number][],
): boolean {
  const words = [...text.matchAll(AMBIGUOUS_WORD_RE)];
  if (!words.length || !mentions.length) return false;
  const goods = new Set(
    mentions
      .filter((m) => m.kind !== 'delivery' && m.kind !== 'prepaid')
      .map((m) => m.value),
  );
  if (goods.size >= 2) return true;
  return words.some((w) => {
    const ws = w.index ?? 0;
    const we = ws + w[0].length;
    return spans.some(([s, e]) => {
      if (ws - e > AMBIGUOUS_NEAR || s - we > AMBIGUOUS_NEAR) return false;
      // Bo'sh qator (alohida paragraf — shablon footer'i) orqali emas.
      const gap = text.slice(Math.min(e, we), Math.max(s, ws));
      return !/\n[ \t]*\r?\n/.test(gap);
    });
  });
}

/** "televizor 2 ta 2 mln" — eslatma qismi (2–10) miqdor sifatida aytilgan. */
function markStatedCounts(text: string, mentions: MoneyMention[]): void {
  for (const m of mentions) {
    for (const unit of [1_000, 1_000_000]) {
      const q = m.value / unit;
      if (!Number.isInteger(q) || q < 2 || q > 10) continue;
      const re = new RegExp(
        String.raw`(?<![\p{N}.,])${q}\s*(?:ta|dona|шт|x|х)(?![\p{L}\p{N}])|` +
          String.raw`(?<![\p{L}\p{N}])(?:x|х)\s*${q}(?![\p{N}.,])`,
        'iu',
      );
      if (re.test(text)) m.count_stated = true;
    }
  }
}

/** Faqat qiymatlar (so'mda), takrorlari bilan. */
export function extractMoneyMentions(
  text: string | null | undefined,
): number[] {
  return extractMoneyMentionsDetailed(text).map((m) => m.value);
}

/** UI uchun: takrorsiz qiymatlar, uchrash tartibida. */
export function uniqueMentionValues(
  mentions: readonly (MoneyMention | number)[],
): number[] {
  const out: number[] = [];
  for (const m of mentions) {
    const v = typeof m === 'number' ? m : m.value;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Ko'p mahsulotli qidiruvda ko'rib chiqiladigan eslatmalar soni. */
const MAX_SEARCH_MENTIONS = 20;
/** Ko'p mahsulotli qidiruv qadamlari chegarasi — oshsa tekshirilmaydi. */
const MAX_SEARCH_STEPS = 200_000;

const toMentions = (
  mentions: readonly (MoneyMention | number)[],
): MoneyMention[] =>
  mentions.map((m) => (typeof m === 'number' ? { value: m, kind: null } : m));

const qtyList = (quantities: number | readonly number[]): number[] =>
  (typeof quantities === 'number' ? [quantities] : [...quantities]).map((q) =>
    Number.isFinite(q) && q > 1 ? Math.round(q) : 1,
  );

/**
 * Mahsulot (dostavkasiz) summasi nomzodlari; aniqlab bo'lmasa — `null`.
 *  - "jami" eslatmasi bor — FAQAT jami summalar;
 *  - bitta mahsulot (miqdor q): har eslatma (dona narxi × q, noma'lum —
 *    o'zi va × q) va hammasining yig'indisi;
 *  - ko'p mahsulot: har mahsulotga alohida eslatma (dona narxi × uning
 *    miqdori, noma'lum — o'zi yoki × miqdor) — yig'indilar. Eslatma
 *    mahsulotdan kam yoki qidiruv katta bo'lsa — `null`.
 */
function goodsCandidates(
  goods: readonly MoneyMention[],
  qtys: readonly number[],
): Set<number> | null {
  if (!goods.length) return null;
  const totals = goods.filter((m) => m.kind === 'total');
  if (totals.length) return new Set(totals.map((m) => m.value));
  if (qtys.length <= 1) {
    const q = qtys[0] ?? 1;
    const scaled = (m: MoneyMention) =>
      m.kind === 'unit' && q > 1 ? m.value * q : m.value;
    const out = new Set<number>();
    let sum = 0;
    for (const m of goods) {
      out.add(scaled(m));
      if (m.kind === null && q > 1) out.add(m.value * q);
      sum += scaled(m);
    }
    out.add(sum);
    return out;
  }
  const ms = goods.slice(0, MAX_SEARCH_MENTIONS);
  if (ms.length < qtys.length) return null;
  const out = new Set<number>();
  const used = ms.map(() => false);
  let steps = 0;
  const walk = (i: number, acc: number): boolean => {
    if (++steps > MAX_SEARCH_STEPS) return false;
    if (i === qtys.length) {
      out.add(acc);
      return true;
    }
    const q = qtys[i];
    for (let j = 0; j < ms.length; j++) {
      if (used[j]) continue;
      const m = ms[j];
      const mults = m.kind === 'unit' ? [q] : q > 1 ? [1, q] : [1];
      used[j] = true;
      for (const k of mults) {
        if (!walk(i + 1, acc + m.value * k)) return false;
      }
      used[j] = false;
    }
    return true;
  };
  return walk(0, 0) ? out : null;
}

/**
 * Matndan kelib chiqadigan buyurtma summalari (mahsulot + dostavka;
 * oldindan to'lov ayirilmaydi va qo'shilmaydi); aniqlab bo'lmasa — `null`.
 * Dostavka aytilgan bo'lsa faqat mahsulot yoki faqat dostavka summasi qabul
 * qilinmaydi; "jami" dostavkadan KEYIN aytilgan bo'lsa — u dostavka bilan.
 */
function acceptedTotals(
  list: readonly MoneyMention[],
  qtys: readonly number[],
): Set<number> | null {
  const goods = list.filter(
    (m) => m.kind !== 'delivery' && m.kind !== 'prepaid',
  );
  const goodsSet = goodsCandidates(goods, qtys);
  if (!goodsSet) return null;
  const firstDelivery = list.findIndex((m) => m.kind === 'delivery');
  if (firstDelivery < 0) return goodsSet;
  const deliveries = list
    .filter((m) => m.kind === 'delivery' && !m.included)
    .map((m) => m.value);
  // Bir nechta dostavka summasi — tarif ro'yxati ("Toshkent 20 000,
  // viloyatlarga 35 000"): har biri ALOHIDA, yig'indisi emas.
  const withDelivery = (v: number, out: Set<number>) => {
    if (!deliveries.length) out.add(v);
    for (const d of deliveries) out.add(v + d);
  };
  const out = new Set<number>();
  if (goods.some((m) => m.kind === 'total')) {
    list.forEach((m, i) => {
      if (m.kind !== 'total') return;
      // "Jami 170 000 (dostavka 20 000 bilan)" — dostavka jami ichida.
      const includedAfter = list
        .slice(i + 1)
        .some((d) => d.kind === 'delivery' && d.included);
      if (i > firstDelivery || includedAfter) out.add(m.value);
      else withDelivery(m.value, out);
    });
    return out;
  }
  // Jamisiz "atir 150 ming (dostavka 20 ming bilan)" — 150 ming dostavka
  // bilanmi yoki unga qo'shiladimi, aniq emas: ikkalasi ham qabul.
  const included = list
    .filter((m) => m.kind === 'delivery' && m.included)
    .map((m) => m.value);
  for (const v of goodsSet) {
    withDelivery(v, out);
    for (const d of included) out.add(v).add(v + d);
  }
  return out;
}

/**
 * `price_check` (mismatch) qarori: model narxi matndagi eslatmalardan
 * kelib chiqadigan summalarning hech biriga teng bo'lmasa — `true`.
 *
 * `quantities` — har mahsulot miqdori (preview `items[].quantity`); bitta
 * son berilsa — bitta mahsulot. Qoidalar: `acceptedTotals`. Tekshirilmaydi
 * (`false`): narx yoki eslatma yo'q, narx noaniq (`ambiguous`), mahsulot
 * summasini aniqlab bo'lmaydi.
 */
export function priceMismatchesMentions(
  totalPrice: number | null,
  mentions: readonly (MoneyMention | number)[],
  quantities: number | readonly number[],
): boolean {
  const list = toMentions(mentions);
  if (totalPrice === null || !list.length) return false;
  if (list.some((m) => m.ambiguous)) return false;
  const ok = acceptedTotals(list, qtyList(quantities));
  if (!ok) return false;
  return !ok.has(Math.round(totalPrice));
}

/**
 * `too_high` uchun: summa matndan kelib chiqadimi (eslatma qiymati, uning
 * miqdorga ko'paytmasi, yig'indi yoki `acceptedTotals`). "Cobalt 120 mln" —
 * 120 000 000 katta, lekin matnda aytilgan.
 */
export function priceDerivableFromMentions(
  totalPrice: number | null,
  mentions: readonly (MoneyMention | number)[],
  quantities: number | readonly number[],
): boolean {
  const list = toMentions(mentions);
  if (totalPrice === null || !list.length) return false;
  const qtys = qtyList(quantities);
  const qtySum = qtys.reduce((a, b) => a + b, 0);
  const ok = new Set<number>(acceptedTotals(list, qtys) ?? []);
  let sum = 0;
  for (const m of list) {
    ok.add(m.value);
    for (const q of [...qtys, qtySum]) ok.add(m.value * q);
    if (m.kind !== 'prepaid') sum += m.value;
  }
  ok.add(sum);
  return ok.has(Math.round(totalPrice));
}

/**
 * `qty_check`: miqdor narx eslatmasining minglik / millionlik qismiga teng
 * ("150 ming" → quantity 150, "2 mln" → quantity 2) — model narxni miqdor
 * deb o'qigan bo'lishi mumkin. Miqdor 1 bo'lsa tekshirilmaydi.
 *
 * E'tiborsiz: oldindan to'lov, dona narxi ("2 ta televizor 2 mln dan",
 * "donasi 3 mln" — dona narxi miqdorga teng bo'lishi tabiiy) va miqdori
 * matnda aniq aytilgan eslatma (`count_stated`: "televizor 2 ta 2 mln").
 * 10 dan katta miqdor ("150 ming" → 150) preview'da limit bilan baribir
 * belgilanadi.
 */
export function quantityLooksLikeMoney(
  quantity: number,
  mentions: readonly (MoneyMention | number)[],
): boolean {
  if (!Number.isFinite(quantity) || quantity <= 1) return false;
  return toMentions(mentions).some(
    (m) =>
      m.kind !== 'prepaid' &&
      m.kind !== 'unit' &&
      !m.count_stated &&
      (m.value === quantity * 1_000 || m.value === quantity * 1_000_000),
  );
}
