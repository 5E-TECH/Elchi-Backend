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
 * Qidiriladigan shakllar (C4 + #647): ixtiyoriy prefiks (+998 | 998 | 8 | 0)
 * + AYNAN 9 ta milliy raqam:
 * - yaxlit (`901234567`, `998901234567`, `0901234567`);
 * - 2-3-2-2 / 2-3-4 / 2-7 (`90 123 45 67`, `+998 (91) 234-56-78`,
 *   `90 123 4567`); birinchi juftlik qavsda bo'lishi mumkin (qavs ichida
 *   bo'shliq ham: `( 90 )`);
 * - +998 bilan 3-2-2-2, 3-3-3, 2-2-2-3, 2-4-3;
 * - prefikssiz (yoki 0/8 bilan) 3-2-2-2 (`901 23 45 67`, `0901 23 45 67`)
 *   va 2-2-2-3 (`90 12 34 567`);
 * - prefikssiz 3-3-3 (`901 234 567`) FAQAT telefon so'zidan keyin (yoki
 *   shunday raqamlar ro'yxatida `, ; / yoki va` orqali) yoki 0/8 prefiksi
 *   bilan (`0 901 234 567`).
 * Ajratgich: guruhlar orasida ≤ 2 bo'shliq/NBSP va bitta `. - – /`
 * (asosiy 2-3-2-2 da); 3-2-2-2 / 2-2-2-3 da faqat bo'shliq, `-`, `–`.
 * Milliy raqamning birinchi 2 raqami UZ operator/shahar kodi bo'lishi SHART:
 * 20, 33, 50, 55, 61-79, 88, 90, 91, 93, 94, 95, 97, 98, 99.
 *
 * ⚠️ Narx telefon deb olinmasligi kerak — noto'g'ri maskalangan narx eng
 * qimmat xato (total_price yo'qoladi), telefonni o'tkazib yuborish esa faqat
 * maxfiylik gigiyenasi. Lekin narx va telefon ba'zan bir xil yoziladi, shuning
 * uchun qoida shunday:
 * - +998/998 prefiksli shakl — DOIM telefon. 2 xonali guruhli shakl odatda
 *   telefon (narx 3 talab guruhlanadi). Istisno: `75 000 14/11`,
 *   `50 000 25.11`, `70 000  12 11`, `jami: 90 500 12 11` — narx + sana
 *   (`looksLikePriceAndDate`); telefon so'zi oldida bo'lsa baribir telefon.
 * - NOANIQ shakllar (prefikssiz yaxlit 9 raqam, 3-3-3, `8 901 234 567`) —
 *   summa so'zi yonida (`narxi …`, `… so'm`, `… ming`), id belgisi/so'zi
 *   (`#`, `№`, `Buyurtma raqami`, `STIR`, `ID`, `Trek`, `Pasport AA`)
 *   yonida, harflar orasida (`EE905123456UZ`) yoki `…000` bilan tugasa
 *   (telefon so'zidan keyingi yaxlit `Tel: 991000000` dan tashqari) —
 *   tegilmaydi. Shuning uchun NOMA'LUM so'zdan keyingi `901 234 567` yoki
 *   `Aziza 901234000` bu yerda maskalanMAYDI (narxdan farqlab bo'lmaydi);
 *   log uchun `maskPhonesForLog` (qo'riqchisiz, qo'shimcha 3-3-3 manbasi
 *   bilan) ularni ham yashiradi.
 * - Boshqa raqamlarga yopishgan ketma-ketlik `(?<!\d)`/`(?!\d)` bilan rad
 *   etiladi; abonent qismi 7 ta nol (`900000000`) — doim narx.
 */

/** UZ milliy kodlari (milliy raqamning birinchi 2 raqami). */
const UZ_NATIONAL_CODE = '(?:20|33|5[05]|6[1-9]|7\\d|88|9[013-57-9])';

/**
 * #647 review: summa so'zi (raqamdan KEYIN, 0–2 bo'shliq/NBSP). Butun so'z
 * SHART — `sumka`, `summa`, `сумма`, `Mingbuloq`, `somsa` summa EMAS; `k`
 * faqat raqamga yopishgan (`150k`); `ming rahmat` — rahmat, summa emas.
 */
const MONEY_AFTER_RE =
  /^(?:k(?![\p{L}\d])|[ \u00a0\u202f]{0,2}(?:\$|(?:so['ʻʼ‘’`]?m(?:ga|dan|lik|ni)?|sum|сум(?:ов)?|сўм|uzs|usd|y\.e\.|у\.е\.|(?:ming(?:ta)?|минг)(?![ \u00a0\u202f]+(?:rahmat|раҳмат|рахмат))|тыс\p{L}*|mln|млн|mlrd|млрд|million|dollar\p{L}*)(?![\p{L}\d])))/iu;

/**
 * Noaniq shakldan OLDIN summa so'zi yoki id belgisi/so'zi: `narxi 205000000`,
 * `#905123456`, `Buyurtma raqami 901 234 567`, `STIR 551234567`,
 * `Pasport AA 901234567`.
 * ⚠️ Butun so'z SHART: `Jamila`, `Summaya`, `Jamiyat`, `To'lovchi`,
 * `Buyurtmachi`, `центр` — summa/id so'zi EMAS (#647 round 2: aks holda
 * dev maskalagan telefon ochiq ketardi). `uy`/`kvartira`/`дом` id so'zi emas:
 * `Uy raqami 901234567` — telefon.
 */
const MONEY_OR_ID_BEFORE_RE =
  /(?:(?<![\p{L}\p{N}])(?:narx(?:i|lari)?|jami(?:si)?|summa(?:si)?|to['ʻʼ’]?lov(?:i)?|qiymat(?:i)?|цена|цену|сумма|сумму|итого|стоимость)(?![\p{L}])[ :=\u00a0-]{0,3}|[#№$][ \u00a0]?|(?<![\p{L}\p{N}])(?:buyurtma|zakaz|заказа?|order|chek|чека?|shartnoma|договора?)(?:ning)?[ \u00a0]+(?:raqami?|nomeri?|номер|№)[ \u00a0]*[:.]?[ \u00a0]*|(?<![\p{L}\p{N}])(?:stir|inn|инн|id|trek|трек|pasport|паспорт)(?![\p{L}])[ \u00a0:#№.-]{0,3}(?:[a-zа-я]{2}[ \u00a0]?)?)$/iu;

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
 * Telefon so'zi (yorlig'i). #647 S6: `tel` faqat `tel`, `telefon` va
 * qo'shimchalari — `Televizor`, `телевизор` telefon so'zi EMAS.
 */
const PHONE_WORD =
  '(?:(?<![\\p{L}\\d])(?:tel(?:efon)?(?:i|im|imiz|ingiz|lar|ga)?|raqam(?:i|im|imiz|ingiz|lar|ga)?|nomer(?:i|im|imiz|ingiz|lar|ga)?|phone|aloqa|whatsapp|telegram|tg|mob(?:il)?)(?: (?:raqam\\p{L}{0,6}|uchun))?|(?<![\\p{L}\\d])(?:тел(?:ефон(?:а|у|ы)?)?|номер(?:а|у)?|рақам(?:и|им|ингиз)?|моб\\p{L}{0,6}|алоқа|мурожаат|т\\.ф)\\.?(?: (?:телефона|учун))?)(?![\\p{L}])';

/**
 * Telefon so'zidan keyingi oraliq (≤ 4 belgi): `tel: `, `Tel 1: `,
 * `Tel1: `, `Tel (WhatsApp): `.
 */
const PHONE_WORD_BEFORE = `${PHONE_WORD}(?:[ ]?\\d(?!\\d))?(?:[ ]?\\([^()\\d]{1,20}\\))?[\\s.:\\-]{0,4}`;

/** `before` qismi telefon so'zi bilan tugaydimi (sana qo'riqchisi uchun). */
const PHONE_WORD_BEFORE_RE = new RegExp(`${PHONE_WORD_BEFORE}$`, 'iu');

/**
 * #647 S4: `…000` bilan tugagan YAXLIT 9 raqam telefon so'zidan keyin telefon
 * (`Tel: 991000000`, `nomer 901234000`). Yalang'och `Telefon 905000000` —
 * mahsulot+narx bo'lishi mumkin, tegilmaydi.
 */
const BARE_PRODUCT_PHONE_WORD_RE =
  /(?<![\p{L}\p{N}])(?:telefon|телефон)[ \u00a0]*$/iu;

/**
 * `before` telefon so'zi bilan tugaydi — lekin mahsulot nomi (`Telefon`) yoki
 * id iborasi (`Buyurtma raqami`) emas.
 */
function isPhoneWordBefore(before: string): boolean {
  return (
    PHONE_WORD_BEFORE_RE.test(before) &&
    !BARE_PRODUCT_PHONE_WORD_RE.test(before) &&
    !MONEY_OR_ID_BEFORE_RE.test(before)
  );
}

/**
 * Pul qo'riqchisi FAQAT noaniq shakllarga: prefikssiz yaxlit 9 raqam yoki
 * 3-3-3 (`8 901 234 567` ham — `8 901 234 000` milliard narx bo'lishi mumkin).
 */
const AMBIGUOUS_SHAPE_RE =
  /^(?:[08][ \u00a0])?(?:\d{9}|\d{3}[ .\-\u00a0]\d{3}[ .\-\u00a0]\d{3})$/u;

/**
 * Asosiy 2-3-2-2 dagi ajratgich (qavslar alohida): ko'pi bilan 2 ta
 * bo'shliq/NBSP va bitta `. - – /`.
 */
const GROUP_SEP = '[ \\u00a0\\u202f]{0,2}[.\\-–/]?[ \\u00a0\\u202f]{0,2}';

/** Qavs ichidagi bo'shliq (`( 90 )`). */
const PAREN_SP = '[ \\u00a0\\u202f]{0,2}';

/**
 * Ixtiyoriy prefiks.
 * ⚠️ Bir xonali `8`/`0` prefiksidan keyin BO'SHLIQ faqat `(` oldidan ruxsat
 * (`8 (90) 123-45-67`). Aks holda `atir 8 901234567` dagi miqdor `8` telefon
 * prefiksi sifatida tokenga "yutilib" ketardi.
 */
const UZ_PHONE_PREFIX = `(?:\\+?998${GROUP_SEP}|[08](?:[.\\-]|[ ]?(?=\\())?)?`;

/** 9 ta milliy raqam: yaxlit yoki 2-3-2-2 (birinchi juftlik qavsda bo'lishi mumkin). */
const UZ_NATIONAL = `(?:\\(${PAREN_SP}${UZ_NATIONAL_CODE}${PAREN_SP}\\)|${UZ_NATIONAL_CODE})${GROUP_SEP}\\d{3}${GROUP_SEP}\\d{2}${GROUP_SEP}\\d{2}`;

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

/** Prefikssiz guruhli shakllar ajratgichi (nuqta EMAS — sana bilan adashadi). */
const LOCAL_SEP = '[ \\u00a0\\-–]';
/**
 * Prefikssiz guruhli shakl chegaralari (#647 S1): gap oxiridagi nuqta
 * (`… 45 67.`) va `Tel.901` ruxsat, lekin `1.901`, `5,901` (o'nlik son) va
 * `2 789 957 18 10 22` (oldida boshqa raqam guruhi) emas.
 */
const LOCAL_BEFORE = '(?<![\\d+]|\\d[.,]|\\d[ \\u00a0])';
const LOCAL_AFTER = '(?!\\d|[.,]\\d)';

/** 3-3-3 milliy raqam (yaxlit ham). */
const NAT_333 = `${UZ_NATIONAL_CODE}\\d[ .\\-\\u00a0]?\\d{3}[ .\\-\\u00a0]?\\d{3}`;
/** Ro'yxatdagi raqamlar orasi: `, `, `; `, ` / `, ` yoki `, ` va `, ` или `. */
const LIST_JOIN =
  '[ \\u00a0]*(?:[,;/]|[ \\u00a0](?:yoki|va|или|и)(?![\\p{L}]))[ \\u00a0]*';

type SourceKind =
  /** Asosiy 2-3-2-2 / yaxlit (`UZ_PHONE_RE`). */
  | 'main'
  /** +998 / 998 bilan — har doim telefon. */
  | 'prefixed'
  /** Prefikssiz 3-2-2-2 / 2-2-2-3 — o'lcham qo'riqchisi. */
  | 'local'
  /** Noaniq 3-3-3 — summa qo'riqchisi. */
  | 'ambiguous'
  /** Faqat log: telefon so'zisiz 3-3-3 ham. */
  | 'log';

/**
 * A3 / #647: qo'shimcha guruhlashlar (asosiy `UZ_PHONE_RE` topmagan joyda).
 * Summa/sana/o'lcham qo'riqchilari regex'da EMAS — `replacePhoneCandidates`
 * da, `kind` bo'yicha.
 */
const UZ_ALT_PHONE_SOURCES: readonly { source: string; kind: SourceKind }[] = [
  // +998 bilan 3-2-2-2, 3-3-3, 2-2-2-3, 2-4-3 — narx 998 bilan boshlanmaydi.
  {
    source: `(?<!\\d)\\+?998${GROUP_SEP}${UZ_NATIONAL_CODE}\\d${GROUP_SEP}\\d{2}${GROUP_SEP}\\d{2}${GROUP_SEP}\\d{2}(?!\\d)`,
    kind: 'prefixed',
  },
  {
    source: `(?<!\\d)\\+?998${GROUP_SEP}${UZ_NATIONAL_CODE}\\d${GROUP_SEP}\\d{3}${GROUP_SEP}\\d{3}(?!\\d)`,
    kind: 'prefixed',
  },
  {
    source: `(?<!\\d)\\+?998${GROUP_SEP}${UZ_NATIONAL_CODE}${GROUP_SEP}\\d{2}${GROUP_SEP}\\d{2}${GROUP_SEP}\\d{3}(?!\\d)`,
    kind: 'prefixed',
  },
  {
    source: `(?<!\\d)\\+?998${GROUP_SEP}${UZ_NATIONAL_CODE}${GROUP_SEP}\\d{4}${GROUP_SEP}\\d{3}(?!\\d)`,
    kind: 'prefixed',
  },
  // Prefikssiz (yoki 0/8 bilan) 3-2-2-2 — nuqta bilan EMAS ("771 14.11.26" — sana).
  {
    source: `${LOCAL_BEFORE}[08]?${UZ_NATIONAL_CODE}\\d${LOCAL_SEP}\\d{2}${LOCAL_SEP}\\d{2}${LOCAL_SEP}\\d{2}${LOCAL_AFTER}`,
    kind: 'local',
  },
  // Prefikssiz 2-2-2-3 — oxirgi guruh narxning ming guruhi emas (`… 150 000`).
  {
    source: `${LOCAL_BEFORE}${UZ_NATIONAL_CODE}${LOCAL_SEP}\\d{2}${LOCAL_SEP}\\d{2}${LOCAL_SEP}\\d{3}${LOCAL_AFTER}(?![ \\u00a0]\\d{3}(?!\\d))`,
    kind: 'local',
  },
  // Prefikssiz 3-3-3 — telefon so'zidan keyin yoki shunday raqamlar
  // ro'yxatida (`tel: 901 234 567, 911 234 567`, `Tel 1: …, Tel 2: …`).
  // ⚠️ Ro'yxat oldingi 4 ta raqam bilan chegaralangan (`{0,4}`): `*` bilan
  // lookbehind har pozitsiyada butun ro'yxatni qayta o'qiydi — kvadratik,
  // 100 KB da soniyalar (#647 round 3, log'ga ketadigan webhook payload).
  // Ro'yxatdagi 6-raqamdan boshlab faqat log maskasi yashiradi.
  {
    source: `(?=${UZ_NATIONAL_CODE}\\d)(?<=${PHONE_WORD_BEFORE}(?:(?:\\+?998[ \\-]?)?${NAT_333}${LIST_JOIN}(?:${PHONE_WORD_BEFORE})?){0,4})${UZ_NATIONAL_CODE}\\d[ .\\-\\u00a0]\\d{3}[ .\\-\\u00a0]\\d{3}(?!\\d)`,
    kind: 'ambiguous',
  },
  // 0/8 + bo'shliq + 3-3-3 (`0 901 234 567`).
  {
    source: `(?<![\\d+]|\\d[.,])[08][ \\u00a0]${UZ_NATIONAL_CODE}\\d[ .\\-\\u00a0]\\d{3}[ .\\-\\u00a0]\\d{3}${LOCAL_AFTER}`,
    kind: 'ambiguous',
  },
];

/**
 * #647 S2: faqat log/Sentry uchun — telefon so'zisiz 3-3-3 (`Aziza 901 234
 * 567`) ham. Narx ham maskalanishi mumkin — log'da maxfiylik ustun.
 */
const UZ_LOG_ONLY_SOURCES: readonly { source: string; kind: SourceKind }[] = [
  {
    source: `(?<!\\d)${UZ_NATIONAL_CODE}\\d[ .\\-\\u00a0\\u202f–/]{1,3}\\d{3}[ .\\-\\u00a0\\u202f–/]{1,3}\\d{3}(?!\\d)`,
    kind: 'log',
  },
];

/** `DD MM` sanami (01-31, 01-12). */
function isDayMonth(dd: string, mm: string): boolean {
  const d = Number(dd);
  const m = Number(mm);
  return d >= 1 && d <= 31 && m >= 1 && m <= 12;
}

/**
 * #647 N2/N3: asosiy 2-3-2-2 / 2-3-4 dagi narx + sana (`75 000 14/11`,
 * `50 000 25.11 kuni`, `70 000  12 11`, `75 000 14.11.2026`,
 * `90 500 2026-11-14`). `8` + kod bilan boshlanadigan narx (`850 000 25/11`
 * — `8` prefiks deb olinadi) va yaxlit `CC000` (`75000 14/11`) ham.
 * +998/998/0 prefiksli yoki qavsli shakl — doim telefon.
 */
function looksLikePriceAndDate(
  raw: string,
  before: string,
  after: string,
): boolean {
  if (/^[+0]|\(/.test(raw)) return false;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 12) return false;
  // Telefon so'zi oldida — sana qoidalaridan OLDIN: `Tel: 90-123-12-11/…`
  // (#647 round 3 N4).
  if (isPhoneWordBefore(before)) return false;
  const nat = digits.slice(-9);
  // 2-3-4 + ISO sana davomi: `90 500 2026-11-14` (faqat prefikssiz).
  if (/^\d{2}\D\d{3}\D\d{4}$/.test(raw)) {
    const iso = /^([./-])(\d{2})\1(\d{2})(?!\d)/.exec(after);
    return (
      /^(?:19|20)\d{2}$/.test(nat.slice(5)) &&
      !!iso &&
      (isDayMonth(iso[2], iso[3]) || isDayMonth(iso[3], iso[2]))
    );
  }
  // Oxirgi ikki juftlik — sana (`DD MM`); oldidagi ajratgich tail[2].
  const tail = /(\d)(\D+)(\d{2})(\D+)(\d{2})$/.exec(raw);
  if (!tail || !isDayMonth(tail[3], tail[5])) return false;
  const rawSeps: string[] = raw.match(/\D+/g) ?? [];
  // Dev (21190eef) tanimagan ajratgich (`/`, `–`, NBSP, 2 bo'shliq, ` - `)
  // — dev bunday shaklni umuman telefon deb olmasdi.
  const devUnknownSep = rawSeps.some((x) => !/^[ .-]$/.test(x));
  // Asosiy N2 shakli — prefikssiz `CC NNN DD MM`. Boshqasi (`8` prefiksli
  // `850 000 25/11` yoki yaxlit `75000 14/11`) faqat dev tanimagan ajratgich
  // bilan — dev ularni telefon deb olmasdi. `90000 14.11`, `850 000 14 11`,
  // `890 123 14.11` — dev'dagidek telefon (maxfiylik dev'dan pasaymaydi).
  if (!/^\d{2}\D+\d{3}\D/.test(raw) && !devUnknownSep) return false;
  const roundThousands = nat.slice(2, 5) === '000';
  // Sana yil bilan davom etadi: `14.11.2026`, `14/11/26`. Lekin
  // `…/91 234 56 78`, `…/93-765-43-21`, `….93.765.43.21` — ikkinchi
  // telefon, sana emas (#647 round 3 N4: aks holda birinchi telefon ochiq).
  const yearContinues =
    /^[./\-–](?:\d{4}(?!\d)|\d{2}(?!\d|[ \u00a0\u202f]{0,2}[./\-–]?[ \u00a0\u202f]{0,2}\d{3}))/.test(
      after,
    );
  if (yearContinues) return true;
  const strip = (x: string) => x.replace(/[ \u00a0\u202f]/g, '');
  const lastSep = strip(tail[4]);
  // Oxirgi ajratgich `.`/`/` va OLDINGI HAMMA ajratgichlardan farqli:
  // `75 000 14.11`, `75000 14/11`. `90.123 14.11`, `91.734-13.12` — telefon
  // (dev'dagidek; faqat sanadan oldingisi bilan solishtirilsa ochiq ketardi).
  if (
    (lastSep === '.' || lastSep === '/') &&
    !rawSeps.slice(0, -1).some((x) => strip(x) === lastSep)
  ) {
    return true;
  }
  // `CC 000 DD MM` — yaxlit narx + sana (`50 000 25 11 kuni`, `75000  14 11`,
  // `850 000 25/11`); summa so'zidan keyin (`jami: 90 500 12 11`); yoki dev
  // tanimagan keng ajratgich (`/`, `–`, 2 bo'shliq, ` - `):
  // `90 500 – 14 – 11`.
  return roundThousands || MONEY_OR_ID_BEFORE_RE.test(before) || devUnknownSep;
}

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
 * Pul/id/sana/o'lcham qo'riqchisi: nomzod telefon EMASmi (`true` — tegilmaydi).
 */
function isGuardedNonPhone(
  kind: SourceKind,
  raw: string,
  before: string,
  after: string,
): boolean {
  if (kind === 'prefixed' || kind === 'log') return false;
  if (AMBIGUOUS_SHAPE_RE.test(raw)) {
    if (MONEY_AFTER_RE.test(after) || MONEY_OR_ID_BEFORE_RE.test(before)) {
      return true;
    }
    // #647 S5: harflar orasidagi 9 raqam — trek/id (`EE905123456UZ`).
    if (/\p{L}$/u.test(before) && /^\p{L}/u.test(after)) return true;
    // Narxlar odatda "…000" bilan tugaydi; telefon kam hollarda — faqat aniq
    // telefon yorlig'idan keyingi YAXLIT 9 raqam telefon (#647 S4).
    if (
      /000$/.test(raw) &&
      !(/^\d{9}$/.test(raw) && isPhoneWordBefore(before))
    ) {
      return true;
    }
  }
  if (kind === 'main') return looksLikePriceAndDate(raw, before, after);
  if (kind === 'local') {
    return (
      looksLikeSizeRun(raw) ||
      SIZE_AFTER_RE.test(after) ||
      SIZE_BEFORE_RE.test(before)
    );
  }
  return false;
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
  const sources = [
    { source: UZ_PHONE_RE.source, kind: 'main' as SourceKind },
    ...UZ_ALT_PHONE_SOURCES,
    ...(opts.moneyGuard ? [] : UZ_LOG_ONLY_SOURCES),
  ];
  const found: { start: number; end: number; e164: string; raw: string }[] = [];
  for (const { source, kind } of sources) {
    for (const m of text.matchAll(new RegExp(source, 'giu'))) {
      const raw = m[0];
      const start = m.index ?? 0;
      const end = start + raw.length;
      const e164 = toUzE164(raw);
      if (!e164 || /^0{7}$/.test(e164.slice(-7))) continue;
      if (
        opts.moneyGuard &&
        isGuardedNonPhone(
          kind,
          raw,
          text.slice(Math.max(0, start - 32), start),
          text.slice(end),
        )
      ) {
        continue;
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
  // Log/Sentry: pul qo'riqchisi YO'Q va telefon so'zisiz 3-3-3 ham
  // (`UZ_LOG_ONLY_SOURCES`) — shubhada maskalanadi (maxfiylik ustun).
  return replacePhoneCandidates(text, (e164) => maskPhoneForLog(e164), {
    moneyGuard: false,
  });
}
