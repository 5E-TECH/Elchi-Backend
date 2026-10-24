import { PRODUCT_BARCODE_MAX_LENGTH } from './product-measure';

/**
 * hY7uacJu (ombor) + MH-3 (9fHyFp3y): mahsulot kodlari — sof funksiyalar
 * (DB va I/O'siz). catalog-service (saqlash, `by-code` qidiruvi) va gateway
 * bir xil qoidadan foydalanadi.
 *
 * Ikki xil kod:
 *   • `sku_code` — Elchi kodi `ELC-P-` + id (kamida 6 xona, nol bilan).
 *     DB'da STORED generated ustun (migratsiya 1716000000141) — ilova uni
 *     HECH QACHON yozmaydi; bu yerdagi `formatProductSkuCode` SQL ifodasi
 *     bilan AYNAN bir xil natija beradi (qidiruv uchun).
 *   • `barcode` — zavod kodi: EAN-13/8, UPC-A (12), UPC-E (8), GTIN-14,
 *     GS1 DataMatrix («Asl belgisi») / GS1 QR dan ajratilgan GTIN, yoki
 *     erkin zavod QR matni. Market ichida yagona (faqat faol qatorlar). GTIN
 *     DB'da KANONIK shaklda saqlanadi (`canonicalGtin`) — bir mahsulot
 *     turining 12/13/14 xonali yozuvlari (UPC-E esa — kengaytirilgan UPC-A
 *     sifatida) bitta qiymat bo'lib, unique indeks va aniq tenglik
 *     (`=` / `IN`) dublikatni ushlaydi.
 */

export const PRODUCT_SKU_PREFIX = 'ELC-P-';
/** `ELC-P-000123` — id kamida shuncha xonaga nol bilan to'ldiriladi. */
export const PRODUCT_SKU_MIN_DIGITS = 6;

/**
 * GTIN-8 (yoki UPC-E) / UPC-A (12) / EAN-13 / GTIN-14 — nazorat raqami
 * MAJBURIY tekshiriladi.
 */
const GTIN_LENGTHS: ReadonlySet<number> = new Set([8, 12, 13, 14]);

/** UPC-E: son tizimi 0 yoki 1, 6 ta ma'lumot raqami, nazorat raqami. */
const UPC_E_PATTERN = /^[01]\d{7}$/;
/** UPC-E ga siqiladigan UPC-A: son tizimi 0 yoki 1, 12 xona. */
const UPC_A_PATTERN = /^[01]\d{11}$/;

/**
 * GS1 element satri boshida GTIN: ixtiyoriy simbologiya belgisi (`]d2` —
 * DataMatrix, `]Q3` — QR, `]C1` — GS1-128) yoki FNC1 (`\x1d`), so'ng AI
 * `01` (qavsli yoki qavssiz) va 14 raqam.
 */
// eslint-disable-next-line no-control-regex
const GS1_GTIN_PATTERN = /^(?:\]d2|\]Q3|\]C1|\x1d)?\(?01\)?(\d{14})/;

/** Faqat raqam, probel va `-` (kamida bitta raqam) — chop etilgan EAN ko'rinishi. */
const DIGITS_WITH_SEPARATORS = /^[\d -]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const SKU_PATTERN = /^ELC-P-0*(\d{1,18})$/i;
const SKU_PREFIX_PATTERN = /^ELC-P-/i;

/**
 * Elchi kodi: `ELC-P-` + id; id 6 xonadan qisqa bo'lsa boshiga nol
 * qo'shiladi, uzun bo'lsa QISQARTIRILMAYDI (`1234567` → `ELC-P-1234567`).
 * SQL ekvivalenti: `'ELC-P-' || lpad(id::text, GREATEST(6, length(id::text)), '0')`.
 */
export function formatProductSkuCode(id: string | number): string {
  return (
    PRODUCT_SKU_PREFIX + String(id).trim().padStart(PRODUCT_SKU_MIN_DIGITS, '0')
  );
}

/**
 * `ELC-P-000123` / `elc-p-123` → `'123'` (boshidagi nollarsiz id). Format
 * noto'g'ri, id `0` yoki bigint'ga sig'maydigan bo'lsa — `null`.
 */
export function parseProductSkuCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = SKU_PATTERN.exec(raw.trim());
  if (!match) return null;
  const id = match[1].replace(/^0+/, '');
  return id ? id : null;
}

/**
 * GS1 mod-10 nazorat raqami (GTIN-8/12/13/14): nazorat raqamidan oldingi
 * raqamlar O'NGDAN 3, 1, 3, 1… og'irlik bilan qo'shiladi.
 */
export function hasValidGtinCheckDigit(digits: string): boolean {
  if (!/^\d+$/.test(digits) || !GTIN_LENGTHS.has(digits.length)) {
    return false;
  }
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 2; i >= 0; i -= 1) {
    sum += Number(digits[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[digits.length - 1]);
}

/**
 * UPC-E (8 xona: son tizimi 0/1 + 6 raqam + nazorat raqami) → UPC-A (12).
 * GS1 bo'yicha UPC-E — GTIN-12 ning siqilgan yozuvi (o'zi GTIN-8 EMAS):
 * nazorat raqami kengaytirilgan UPC-A bo'yicha hisoblanadi. 6-ma'lumot
 * raqami (D6) siqish turini bildiradi:
 *   • 0–2: ishlab chiqaruvchi `D1 D2 D6 0 0`, mahsulot `0 0 D3 D4 D5`;
 *   • 3:   ishlab chiqaruvchi `D1 D2 D3 0 0`, mahsulot `0 0 0 D4 D5`;
 *   • 4:   ishlab chiqaruvchi `D1 D2 D3 D4 0`, mahsulot `0 0 0 0 D5`;
 *   • 5–9: ishlab chiqaruvchi `D1 … D5`, mahsulot `0 0 0 0 D6`.
 * Masalan `04963406` → `049000006346`. Nazorat raqamini TEKSHIRMAYDI
 * (`hasValidGtinCheckDigit` bilan tekshiring). Format mos kelmasa — `null`.
 */
export function expandUpcE(code: string): string | null {
  if (!UPC_E_PATTERN.test(code)) return null;
  const system = code[0];
  const d = code.slice(1, 7);
  const check = code[7];
  const kind = d[5];
  let body: string; // ishlab chiqaruvchi (5) + mahsulot (5)
  if (kind <= '2') {
    body = `${d.slice(0, 2)}${kind}00` + `00${d.slice(2, 5)}`;
  } else if (kind === '3') {
    body = `${d.slice(0, 3)}00` + `000${d.slice(3, 5)}`;
  } else if (kind === '4') {
    body = `${d.slice(0, 4)}0` + `0000${d[4]}`;
  } else {
    body = d.slice(0, 5) + `0000${kind}`;
  }
  return system + body + check;
}

/**
 * UPC-A (12) → uning yagona standart UPC-E (8) yozuvi; siqib bo'lmasa (yoki
 * son tizimi 0/1 emas) — `null`. `expandUpcE(compressUpcA(x)) === x`.
 */
export function compressUpcA(upcA: string): string | null {
  if (!UPC_A_PATTERN.test(upcA)) return null;
  const system = upcA[0];
  const maker = upcA.slice(1, 6);
  const item = upcA.slice(6, 11);
  const check = upcA[11];
  let data: string | null = null;
  if (/^\d\d[012]00$/.test(maker) && item.startsWith('00')) {
    data = maker.slice(0, 2) + item.slice(2) + maker[2];
  } else if (maker.endsWith('00') && item.startsWith('000')) {
    data = `${maker.slice(0, 3)}${item.slice(3)}3`;
  } else if (maker.endsWith('0') && item.startsWith('0000')) {
    data = `${maker.slice(0, 4)}${item[4]}4`;
  } else if (
    !maker.endsWith('0') &&
    item.startsWith('0000') &&
    item[4] >= '5'
  ) {
    data = maker + item[4];
  }
  return data ? system + data + check : null;
}

/**
 * 8 xonali chiziqli skan — EAN-8 (GTIN-8) mi yoki UPC-E mi, simbologiya
 * belgisisiz (AIM ID) ajratib bo'lmaydi; qaysi GTIN sifatida
 * kanonlashtirilishini qaytaradi (yaroqsiz — `null`):
 *   • `0` bilan boshlansa — avval UPC-E (kengaytirilgan UPC-A nazorat
 *     raqami to'g'ri bo'lsa — UPC-A), aks holda GTIN-8. GS1-8 prefiksi 0xx —
 *     do'kon ichidagi «velocity» kodlar (zavod kodi emas), UPC-E esa
 *     deyarli doim son tizimi 0 bilan;
 *   • `1` bilan boshlansa — avval GTIN-8 (GS1-8 prefiksi 1xx berilgan),
 *     o'tmasa UPC-E (son tizimi 1 — ba'zi skanerlar o'qiydi);
 *   • boshqa — faqat GTIN-8.
 * Ikkala talqin ham to'g'ri bo'lgan kod boshqa yozuvda (12/13/14 xona)
 * kelsa ham topilishi uchun qidiruv `productBarcodeEquivalents` dan foydalanadi.
 */
function eightDigitScanGtin(digits: string): string | null {
  const upcA = expandUpcE(digits);
  const upcEValid = upcA !== null && hasValidGtinCheckDigit(upcA);
  const gtin8Valid = hasValidGtinCheckDigit(digits);
  if (digits[0] === '0') {
    if (upcEValid) return upcA;
    return gtin8Valid ? digits : null;
  }
  if (gtin8Valid) return digits;
  return upcEValid ? upcA : null;
}

/**
 * GS1 DataMatrix («Asl belgisi» — har donada boshqacha seriya) yoki GS1 QR
 * matnidan mahsulot turining GTIN-14 qismi (AI 01). Nazorat raqami to'g'ri
 * bo'lmasa — `null` (GS1 deb hisoblanmaydi).
 */
export function extractGs1Gtin(raw: string): string | null {
  const match = GS1_GTIN_PATTERN.exec(raw);
  if (!match) return null;
  return hasValidGtinCheckDigit(match[1]) ? match[1] : null;
}

/**
 * GTIN'ning KANONIK (saqlash va qidiruv) shakli. GS1 bo'yicha GTIN-8/12/13
 * — GTIN-14 ning boshiga nol qo'shilgan ko'rinishlari (nol bilan to'ldirish
 * nazorat raqamini o'zgartirmaydi), ya'ni bitta mahsulot turi turli
 * skanerlarda 12 (UPC-A), 13 (EAN-13) yoki 14 (DataMatrix / GTIN-14) xonali
 * bo'lib keladi. Kanonik shakl:
 *   • GTIN-14 ko'rinishi `000000` bilan boshlansa — 8 xona (GTIN-8);
 *   • `0` bilan boshlansa — 13 xona (UPC-A va EAN-13 → EAN-13 shakli,
 *     masalan `036000291452` → `0036000291452`);
 *   • aks holda (indikator 1–9) — 14 xona o'zicha.
 * Yaroqsiz kirish (uzunlik 8/12/13/14 emas, nazorat raqami noto'g'ri yoki
 * hammasi nol) — `null`.
 */
export function canonicalGtin(digits: string): string | null {
  if (!hasValidGtinCheckDigit(digits) || /^0+$/.test(digits)) {
    return null;
  }
  const gtin14 = digits.padStart(14, '0');
  if (gtin14.startsWith('000000')) return gtin14.slice(6);
  if (gtin14.startsWith('0')) return gtin14.slice(1);
  return gtin14;
}

const ZERO_GTIN_REASON =
  "Shtrix kod faqat nollardan iborat bo'lishi mumkin emas — kodni qayta skanerlang";

export type ProductBarcodeNormalization =
  | { ok: true; value: string | null | undefined }
  | { ok: false; reason: string };

/**
 * Saqlash uchun shtrix kod normalizatsiyasi (create / PATCH / RMQ — bir xil):
 *   • `undefined` — o'zgarmaydi; `null` yoki bo'sh satr — tozalash (`null`);
 *   • satr bo'lmagan qiymat — xato (JSON raqami boshidagi nollarni yo'qotadi);
 *   • GS1 (DataMatrix / QR) — GTIN ajratib olinadi, KANONIK shaklda;
 *   • faqat raqam/probel/`-` — faqat raqamlar qoladi; 8/12/13/14 xonali
 *     bo'lsa nazorat raqami MAJBURIY to'g'ri va KANONIK shaklga keltiriladi
 *     (`canonicalGtin`; ichki EAN 20–29 — oddiy EAN-13); 8 xonali — EAN-8
 *     yoki UPC-E (`eightDigitScanGtin`; UPC-E kengaytirilgan UPC-A ning
 *     kanonik shaklida, `04963406` → `0049000006346`); boshqa uzunlik
 *     (Code128, ichki kod) o'zicha;
 *   • matn (zavod QR'i) — faqat trim, registr SAQLANADI; `ELC-P-…` (Elchi
 *     kodi) va boshqaruv belgilari — xato.
 */
export function normalizeProductBarcode(
  raw: unknown,
): ProductBarcodeNormalization {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return {
      ok: false,
      reason:
        "Shtrix kod satr bo'lishi kerak (raqamli kodni ham satr sifatida yuboring — boshidagi nollar yo'qolmasin)",
    };
  }
  const text = raw.trim();
  if (!text) return { ok: true, value: null };
  if (text.length > PRODUCT_BARCODE_MAX_LENGTH) {
    return {
      ok: false,
      reason: `Shtrix kod ${PRODUCT_BARCODE_MAX_LENGTH} belgidan oshmasligi kerak`,
    };
  }

  const gs1Gtin = extractGs1Gtin(text);
  if (gs1Gtin) {
    const canonical = canonicalGtin(gs1Gtin);
    return canonical
      ? { ok: true, value: canonical }
      : { ok: false, reason: ZERO_GTIN_REASON };
  }

  if (DIGITS_WITH_SEPARATORS.test(text) && /\d/.test(text)) {
    const digits = text.replace(/\D/g, '');
    if (!GTIN_LENGTHS.has(digits.length)) {
      return { ok: true, value: digits };
    }
    const gtin =
      digits.length === 8
        ? eightDigitScanGtin(digits)
        : hasValidGtinCheckDigit(digits)
          ? digits
          : null;
    if (!gtin) {
      const kind = digits.length === 8 ? 'EAN-8/UPC-E' : 'EAN/UPC/GTIN';
      return {
        ok: false,
        reason: `Shtrix kod nazorat raqami noto'g'ri (${digits.length} xonali ${kind}) — kodni qayta skanerlang`,
      };
    }
    const canonical = canonicalGtin(gtin);
    return canonical
      ? { ok: true, value: canonical }
      : { ok: false, reason: ZERO_GTIN_REASON };
  }

  if (CONTROL_CHARS.test(text)) {
    return {
      ok: false,
      reason: "Shtrix kodda boshqaruv belgilari bo'lmasligi kerak",
    };
  }
  if (SKU_PREFIX_PATTERN.test(text)) {
    return {
      ok: false,
      reason:
        'ELC-P-… — Elchi mahsulot kodi (sku_code), u avtomatik beriladi; shtrix kod maydoniga zavod kodi yoziladi',
    };
  }
  return { ok: true, value: text };
}

/**
 * Saqlangan (kanonik) shtrix kodning UPC-E ↔ EAN-8 ikkiligi tufayli
 * boshqacha saqlangan bo'lishi mumkin bo'lgan TENG qiymatlari (o'zisiz):
 *   • 8 xona (GTIN-8 sifatida saqlangan) — UPC-E sifatida ham to'g'ri
 *     bo'lsa, kengaytirilgan UPC-A ning kanonik shakli;
 *   • 13 xona `0…` (UPC-A) — standart UPC-E yozuvi GTIN-8 sifatida ham
 *     to'g'ri bo'lsa, shu 8 xona (masalan GS1 DataMatrix'dan GTIN-8 bo'lib
 *     yoki `1…` UPC-E skanidan saqlangan).
 * Dublikat tekshiruvi va qidiruv shu qiymatlarni ham qamraydi; oddiy EAN-13 /
 * GTIN-14 / matnda — `[]`.
 */
export function productBarcodeEquivalents(canonical: string): string[] {
  const equivalents: string[] = [];
  if (/^\d{8}$/.test(canonical)) {
    const upcA = expandUpcE(canonical);
    const alt = upcA ? canonicalGtin(upcA) : null;
    if (alt) equivalents.push(alt);
  } else if (/^0\d{12}$/.test(canonical)) {
    const upcE = compressUpcA(canonical.slice(1));
    if (upcE && hasValidGtinCheckDigit(upcE)) equivalents.push(upcE);
  }
  return equivalents.filter((value) => value !== canonical);
}

/**
 * Qidiruv (`by-code`, ro'yxat qidiruvi) uchun variantlar — xato
 * tashlamaydi. Saqlashdagi bilan AYNI kanonlashtirish: [xom (trim) matn,
 * `normalizeProductBarcode` natijasi (bo'lsa), uning
 * `productBarcodeEquivalents` qiymatlari]. Masalan 12 xonali UPC-A skani
 * 13 xonali kanonik saqlangan mahsulotni topadi, UPC-E (8) skani esa
 * kengaytirilgan UPC-A bilan saqlanganini; nazorat raqami noto'g'ri kod
 * faqat o'zicha qidiriladi (topilmaydi). Bo'sh, juda uzun yoki satr
 * bo'lmagan qiymatda — `[]`.
 */
export function productBarcodeLookupVariants(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const text = raw.trim();
  if (!text || text.length > PRODUCT_BARCODE_MAX_LENGTH) return [];

  const variants = new Set<string>([text]);
  const normalized = normalizeProductBarcode(text);
  if (normalized.ok && normalized.value) {
    variants.add(normalized.value);
    for (const value of productBarcodeEquivalents(normalized.value)) {
      variants.add(value);
    }
  }
  return [...variants];
}
