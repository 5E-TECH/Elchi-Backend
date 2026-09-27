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
 *   o'z holicha ketadi. Rasm bazaga ham, diskka ham YOZILMAYDI — faqat RAM'dan
 *   o'tadi (NsxoDSmm §4 / HD5zOyBp §3).
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

/** Guruhlar orasidagi bitta ixtiyoriy ajratgich (qavslar alohida). */
const GROUP_SEP = '[ .\\-]?';

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
);

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
): string {
  const re = new RegExp(UZ_PHONE_RE.source, 'g');
  return text.replace(re, (match: string) => {
    const e164 = toUzE164(match);
    if (!e164 || /^0{7}$/.test(e164.slice(-7))) return match;
    return replacer(e164, match);
  });
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
  return replacePhoneCandidates(text, (e164) => maskPhoneForLog(e164));
}
