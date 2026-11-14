/**
 * ⚠️ MAXFIYLIK (HD5zOyBp): AI buyurtma oqimida mijoz matni (ism, telefon,
 * manzil) Anthropic (AQSh) API'ga tahlil uchun YUBORILADI. Ega 2026-09-19 da
 * aniq ruxsat bergan ("Ha jo'natilib analiz qilinsin") — ya'ni yuborish
 * bloklanmaydi, lekin KERAKSIZ ma'lumot yuborilmasin.
 *
 * Shu modul nima qiladi va nimani QILMAYDI:
 * - Faqat TELEFON raqamlari maskalanadi: raqam topish deterministik vazifa
 *   (regex), LLM kerak emas. Claude `[TEL_1]`, `[TEL_2]` tokenlarini ko'radi,
 *   natijadagi token esa ai-service ICHIDA haqiqiy raqamga qaytariladi —
 *   tokenlar ai-service'dan TASHQARIGA chiqmaydi.
 * - Ism va manzil maskalanMAYDI — ekstraksiyaning o'zi aynan shularni ajratib
 *   olishi kerak (region/tuman/manzil matni Claude'ga ochiq ketadi).
 * - RASMNI maskalab BO'LMAYDI: varaqa suratidagi telefon/ism/manzil Anthropic'ga
 *   o'z holicha ketadi. Rasm bazaga YOZILMAYDI; WHMAIqyo #3 dan beri u
 *   kichraytirilib MinIO'da VAQTINCHALIK (`ai-tmp/`, TTL 1 soat, ai-service
 *   o'qigach darhol o'chiriladi) turadi (NsxoDSmm §4 / HD5zOyBp §3).
 *
 * Qidiriladigan shakl (C4): ixtiyoriy prefiks (+998 | 998 | 8 | 0) + AYNAN 9
 * ta milliy raqam — yoki yaxlit (`901234567`, `998901234567`, `0901234567`),
 * yoki 2-3-2-2 guruhlab `[ -().]` ajratgichlar bilan (`90 123 45 67`,
 * `+998 (91) 234-56-78`); birinchi juftlik qavs ichida bo'lishi mumkin.
 * Milliy raqamning birinchi 2 raqami UZ operator/shahar kodi bo'lishi SHART:
 * 20, 33, 50, 55, 61-79, 88, 90, 91, 93, 94, 95, 97, 98, 99.
 *
 * ⚠️ Narxlar HECH QACHON telefon deb olinmaydi: 3-3-3 guruhlar
 * (`900 000 000`, `125 000 000`, `1 500 000`) 2-3-2-2 ajratgich o'rinlariga
 * tushmaydi, boshqa raqamlarga YOPISHIB turgan ketma-ketlik esa
 * `(?<!\d)`/`(?!\d)` bilan rad etiladi. Noto'g'ri maskalangan narx — eng qimmat
 * xato (total_price yo'qoladi), telefonni o'tkazib yuborish esa faqat maxfiylik
 * gigiyenasi — shuning uchun regex ataylab qattiq.
 */

/** UZ milliy kodlari (milliy raqamning birinchi 2 raqami). */
const UZ_NATIONAL_CODE = '(?:20|33|5[05]|6[1-9]|7\\d|88|9[013-57-9])';

/**
 * #647 review: summa so'zi (raqamdan KEYIN, 0–2 bo'shliq/NBSP). Butun so'z
 * SHART — `sumka`, `summa`, `сумма`, `Mingbuloq`, `somsa` summa EMAS; `k`
 * faqat raqamga yopishgan (`150k`).
 */
const MONEY_AFTER_RE =
  /^(?:k(?![\p{L}\d])|[ \u00a0\u202f]{0,2}(?:\$|(?:so['ʻʼ‘’`]?m(?:ga|dan|lik|ni)?|sum|сум(?:ов)?|сўм|uzs|usd|y\.e\.|у\.е\.|ming(?:ta)?|минг|тыс\p{L}*|mln|млн|mlrd|млрд|million|dollar\p{L}*)(?![\p{L}\d])))/iu;

/**
 * Noaniq shakldan OLDIN summa so'zi yoki id belgisi: `narxi 205000000`,
 * `#905123456`, `Buyurtma raqami 901 234 567`, `Uy raqami 205 000 000`.
 */
const MONEY_OR_ID_BEFORE_RE =
  /(?:(?:narx|jami|summa|to['ʻʼ’]?lov|qiymat|цен|сумм|итого|стоимост)\p{L}*[ :=\u00a0-]{0,3}|[#№$]\s?|(?:buyurtma|zakaz|заказ|order|chek|чек|shartnoma|договор|uy|kvartira|xonadon|дом|kv)\p{L}*\s+(?:raqam|nomer|номер|№)\p{L}*\s*[:.]?\s*)$/iu;

/** O'lcham/model ro'yxati: `990 40 41 42 razmer`, `Razmerlar: 200 50 60 70`. */
const SIZE_AFTER_RE = /^\s*[,;]?\s*(?:razmer|размер|o['ʻ‘’]?lcham)/iu;
const SIZE_BEFORE_RE = /(?:razmer|размер|o['ʻ‘’]?lcham)\p{L}*\s*[:-]?\s*$/iu;

/**
 * Prefikssiz 3-2-2-2 oxirgi uch juftligi ketma-ket o'suvchi (`41 42 43`,
 * `50 60 70`) — o'lchamlar, telefon emas.
 */
function looksLikeSizeRun(raw: string): boolean {
  const g = raw.split(/[^\d]+/).filter(Boolean);
  if (g.length !== 4) return false;
  const [a, b, c] = [Number(g[1]), Number(g[2]), Number(g[3])];
  const d = b - a;
  return d > 0 && d <= 10 && c - b === d;
}

/**
 * Pul qo'riqchisi FAQAT noaniq shakllarga: prefikssiz yaxlit 9 raqam yoki
 * 3-3-3. 2 xonali guruhli yoki +998/998/0/8 prefiksli shakl — DOIM telefon
 * (narx shunday yozilmaydi; maxfiylik ustun).
 */
const AMBIGUOUS_SHAPE_RE =
  /^(?:\d{9}|\d{3}[ .\-\u00a0]\d{3}[ .\-\u00a0]\d{3})$/u;

/** Prefikssiz 3-3-3 uchun: oldida telefon so'zi (≤ 4 belgi oraliq). */
const PHONE_WORD_BEFORE =
  "(?:\\b(?:tel|raqam|nomer|phone|aloqa|whatsapp|telegram|tg|mob)[a-z'ʻ‘’]{0,8}(?: (?:raqam\\p{L}*|uchun))?|(?<![а-яё])(?:тел|номер|рақам|моб|алоқа|мурожаат|т\\.ф)[а-яёқўғҳ.]{0,9}(?: (?:телефона|учун))?)[\\s.:\\-]{0,4}";

/**
 * Guruhlar orasidagi ajratgich (qavslar alohida): ko'pi bilan 2 ta
 * bo'shliq/NBSP va bitta `. - – /`.
 */
const GROUP_SEP = '[ \\u00a0\\u202f]{0,2}[.\\-–/]?[ \\u00a0\\u202f]{0,2}';

/**
 * Ixtiyoriy prefiks.
 * ⚠️ Bir xonali `8`/`0` prefiksidan keyin BO'SHLIQ faqat `(` oldidan ruxsat
 * (`8 (90) 123-45-67`). Aks holda `atir 8 901234567` dagi miqdor `8` telefon
 * prefiksi sifatida tokenga "yutilib" ketardi.
 */
const UZ_PHONE_PREFIX = `(?:\\+?998${GROUP_SEP}|[08](?:[.\\-]|[ ]?(?=\\())?)?`;

/** 9 ta milliy raqam: yaxlit yoki 2-3-2-2 (birinchi juftlik qavsda bo'lishi mumkin). */
const UZ_NATIONAL = `(?:\\(${UZ_NATIONAL_CODE}\\)|${UZ_NATIONAL_CODE})${GROUP_SEP}\\d{3}${GROUP_SEP}\\d{2}${GROUP_SEP}\\d{2}`;

/**
 * UZ telefon nomzodi. Boshqa raqamlarga yopishgan ketma-ketlik rad etiladi.
 *
 * ⚠️ Ataylab `g` bayroqsiz: umumiy (export qilingan) global regex'ning
 * `lastIndex` holati `.test()` chaqiruvlari orasida "sizib" ketadi. Matn
 * bo'ylab yurish uchun ichkarida `new RegExp(UZ_PHONE_RE.source, 'g')`
 * ishlatiladi.
 */
export const UZ_PHONE_RE = new RegExp(
  `(?<!\\d)${UZ_PHONE_PREFIX}${UZ_NATIONAL}(?!\\d)`,
  'u',
);

/**
 * A3: qo'shimcha guruhlashlar (asosiy `UZ_PHONE_RE` topmagan joyda):
 * - +998 / 998 prefiksi bilan 3-2-2-2 (`+998 901 23 45 67`) va 3-3-3
 *   (`+998 901 234 567`) — narx hech qachon 998 bilan boshlanmaydi;
 * - prefikssiz 3-2-2-2 (`901 23 45 67`) — narxlar 3 talab guruhlanadi;
 * - prefikssiz 3-3-3 (`901 234 567`) FAQAT telefon so'zidan keyin
 *   ("tel", "raqam", "номер", ...) — aks holda `915 500 000` narx bo'lishi
 *   mumkin.
 * - +998 bilan 2-2-2-3 va 2-4-3 ham.
 * Summa so'zi qo'riqchisi regex'da EMAS — `replacePhoneCandidates` da va
 * faqat noaniq shakllarga (`AMBIGUOUS_SHAPE_RE`).
 */
const UZ_ALT_PHONE_SOURCES: readonly string[] = [
  `(?<!\\d)\\+?998${GROUP_SEP}${UZ_NATIONAL_CODE}\\d${GROUP_SEP}\\d{2}${GROUP_SEP}\\d{2}${GROUP_SEP}\\d{2}(?!\\d)`,
  `(?<!\\d)\\+?998${GROUP_SEP}${UZ_NATIONAL_CODE}\\d${GROUP_SEP}\\d{3}${GROUP_SEP}\\d{3}(?!\\d)`,
  `(?<!\\d)\\+?998${GROUP_SEP}${UZ_NATIONAL_CODE}${GROUP_SEP}\\d{2}${GROUP_SEP}\\d{2}${GROUP_SEP}\\d{3}(?!\\d)`,
  `(?<!\\d)\\+?998${GROUP_SEP}${UZ_NATIONAL_CODE}${GROUP_SEP}\\d{4}${GROUP_SEP}\\d{3}(?!\\d)`,
  // Prefikssiz 3-2-2-2 — nuqta bilan EMAS ("771 14.11.26" — sana).
  `(?<![\\d+.])${UZ_NATIONAL_CODE}\\d[ \\u00a0\\-–]\\d{2}[ \\u00a0\\-–]\\d{2}[ \\u00a0\\-–]\\d{2}(?![\\d.])`,
  // Prefikssiz 3-3-3 — faqat telefon so'zidan keyin.
  `(?<=${PHONE_WORD_BEFORE})${UZ_NATIONAL_CODE}\\d[ .\\-\\u00a0]\\d{3}[ .\\-\\u00a0]\\d{3}(?!\\d)`,
];

/**
 * Tokenga o'xshash qism (`[TEL_1]`, `TEL_1`, `[TEL_12`) — C4:
 * `/\[?TEL_(\d+)\]?/`. `\b` qo'shilgan, shunda `HOTEL_1` kabi so'z
 * ichidagi bo'lak token deb olinmaydi.
 */
const TOKEN_LIKE_SOURCE = '\\[?\\bTEL_(\\d+)\\b\\]?';

export interface MaskedPhones {
  /** Telefonlar `[TEL_n]` bilan almashtirilgan matn. */
  masked: string;
  /** `'[TEL_n]'` → normallashgan raqam (`'+998XXXXXXXXX'`). */
  tokens: Map<string, string>;
}

/**
 * Raqamni `'+998XXXXXXXXX'` ga keltiradi (faqat uzunlik/prefiks bo'yicha).
 * 998+9, 0|8+9 yoki 9 raqam; boshqasi → null. Hech qachon to'ldirmaydi/kesmaydi.
 */
function toUzE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('998')) return `+${digits}`;
  if (digits.length === 10 && (digits[0] === '0' || digits[0] === '8')) {
    return `+998${digits.slice(1)}`;
  }
  if (digits.length === 9) return `+998${digits}`;
  return null;
}

/**
 * Matndagi har bir telefon nomzodini `replacer` natijasi bilan almashtiradi.
 *
 * ⚠️ Abonent qismi (oxirgi 7 raqam) butunlay nol bo'lsa (`900000000`,
 * `500000000` — bo'shliqsiz yozilgan yaxlit narx) — bu haqiqiy abonent raqami
 * EMAS, o'z holicha qoldiriladi.
 */
function replacePhoneCandidates(
  text: string,
  replacer: (e164: string, match: string) => string,
  opts: { moneyGuard: boolean } = { moneyGuard: true },
): string {
  // Hamma shakl BITTA matn ustida yig'iladi va chapdan o'ngga almashtiriladi:
  // tokenlar matndagi tartibda raqamlanadi; kesishganda boshlanishi oldin,
  // keyin uzunrog'i yutadi.
  const found: { start: number; end: number; e164: string; raw: string }[] = [];
  for (const source of [UZ_PHONE_RE.source, ...UZ_ALT_PHONE_SOURCES]) {
    for (const m of text.matchAll(new RegExp(source, 'giu'))) {
      const raw = m[0];
      const start = m.index ?? 0;
      const end = start + raw.length;
      const e164 = toUzE164(raw);
      if (!e164 || /^0{7}$/.test(e164.slice(-7))) continue;
      if (opts.moneyGuard) {
        const before = text.slice(Math.max(0, start - 32), start);
        const after = text.slice(end);
        if (
          AMBIGUOUS_SHAPE_RE.test(raw) &&
          (MONEY_AFTER_RE.test(after) ||
            MONEY_OR_ID_BEFORE_RE.test(before) ||
            // Narxlar odatda "…000" bilan tugaydi; telefon kam hollarda.
            /000$/.test(raw))
        ) {
          continue;
        }
        if (
          /^\d{3}[ \u00a0\-–]\d{2}[ \u00a0\-–]\d{2}[ \u00a0\-–]\d{2}$/u.test(
            raw,
          ) &&
          (looksLikeSizeRun(raw) ||
            SIZE_AFTER_RE.test(after) ||
            SIZE_BEFORE_RE.test(before))
        ) {
          continue;
        }
      }
      found.push({ start, end, e164, raw });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let pos = 0;
  for (const f of found) {
    if (f.start < pos) continue;
    out += text.slice(pos, f.start) + replacer(f.e164, f.raw);
    pos = f.end;
  }
  return out + text.slice(pos);
}

/**
 * Claude'ga yuborishdan OLDIN telefonlarni `[TEL_1]`, `[TEL_2]`, ... bilan
 * almashtiradi. Bitta normallashgan raqam (`90 123 45 67` va `+998901234567`)
 * DOIM bitta tokenni oladi; tokenlar birinchi uchrash tartibida raqamlanadi.
 *
 * ⚠️ Matnda allaqachon `TEL_n` ko'rinishidagi bo'lak bo'lsa (foydalanuvchi
 * yozgan yoki injection urinishi), raqamlash undan keyingi `n` dan boshlanadi
 * — aks holda begona `[TEL_1]` bizning `[TEL_1]` bilan to'qnashib, unmask
 * boshqa mijozning raqamini qaytarib qo'yardi.
 */
export function maskPhones(text: string): MaskedPhones {
  const tokens = new Map<string, string>();
  if (typeof text !== 'string') return { masked: '', tokens };
  if (text.length === 0) return { masked: text, tokens };

  let next = 1;
  for (const m of text.matchAll(new RegExp(TOKEN_LIKE_SOURCE, 'g'))) {
    next = Math.max(next, Number(m[1]) + 1);
  }

  const tokenByNumber = new Map<string, string>();
  const masked = replacePhoneCandidates(text, (e164) => {
    let token = tokenByNumber.get(e164);
    if (!token) {
      token = `[TEL_${next++}]`;
      tokenByNumber.set(e164, token);
      tokens.set(token, e164);
    }
    return token;
  });

  return { masked, tokens };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function unmaskString(
  value: string,
  tokens: ReadonlyMap<string, string>,
): string | null {
  let unknownToken = false;
  const restored = value.replace(
    new RegExp(TOKEN_LIKE_SOURCE, 'g'),
    (match: string, n: string) => {
      const phone = tokens.get(`[TEL_${Number(n)}]`);
      if (phone === undefined) {
        unknownToken = true;
        return match;
      }
      return phone;
    },
  );
  return unknownToken ? null : restored;
}

function unmaskDeep(
  value: unknown,
  tokens: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === 'string') return unmaskString(value, tokens);
  if (Array.isArray(value)) {
    return value.map((item: unknown) => unmaskDeep(item, tokens));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = unmaskDeep(item, tokens);
    }
    return out;
  }
  return value;
}

/**
 * Claude natijasini chuqur aylanib, `[TEL_n]` tokenlarini haqiqiy
 * (`'+998XXXXXXXXX'`) raqamga qaytaradi. Kirish qiymati o'zgartirilmaydi —
 * yangi nusxa qaytadi.
 *
 * ⚠️ Noma'lum token (model o'ylab topgan `[TEL_9]`) bo'lgan satr maydoni
 * butunlay `null` bo'ladi — gallyutsinatsiya raqam o'rniga tokenni oqizib
 * yubormaslik uchun. Preview buni `phone_invalid` sifatida ko'rsatadi.
 */
export function unmaskPhones<T>(
  value: T,
  tokens: ReadonlyMap<string, string>,
): T {
  return unmaskDeep(value, tokens) as T;
}

/**
 * Bitta raqamni log/Sentry uchun maskalaydi:
 * `'+998901234567'` → `'+99890*****67'` (kod ko'rinadi, abonent yashirinadi).
 * UZ raqamiga keltirib bo'lmaydigan qiymatda oxirgi 2 tadan boshqa hamma
 * raqam `*` bilan almashtiriladi.
 */
export function maskPhoneForLog(
  phone: string | number | null | undefined,
): string {
  if (phone === null || phone === undefined) return '';
  const raw = String(phone);
  const e164 = toUzE164(raw);
  if (e164) return `${e164.slice(0, 6)}*****${e164.slice(-2)}`;
  const digitCount = raw.replace(/\D/g, '').length;
  let seen = 0;
  return raw.replace(/\d/g, (d: string) => (++seen > digitCount - 2 ? d : '*'));
}

/**
 * Erkin matndagi har bir telefon nomzodini `maskPhoneForLog` shakliga
 * keltiradi (log, Sentry xabari). Token emas — qaytarib bo'lmaydi.
 */
export function maskPhonesForLog(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  // Log/Sentry: pul qo'riqchisi YO'Q — shubhada maskalanadi (maxfiylik ustun).
  return replacePhoneCandidates(text, (e164) => maskPhoneForLog(e164), {
    moneyGuard: false,
  });
}
