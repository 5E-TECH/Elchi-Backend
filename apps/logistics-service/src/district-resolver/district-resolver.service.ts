import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AI_MAX_CANDIDATES,
  GEO_FUZZY_MIN,
  GEO_FUZZY_NEAR_DELTA,
  GEO_SUBSTRING_MIN,
  REGION_ALIASES,
  bestSubstringSim,
  lightNorm,
  normGeo,
  RU_ADJ_SUFFIX_RE,
  regionAlias,
  simRatio,
  translit,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { Region } from '../entities/region.entity';
import { satoRegions } from '../data/sato-codes';
import { District } from '../entities/district.entity';
import {
  DISTRICT_ALIASES,
  geoSkeleton,
  geoSpellingVariants,
} from './district-aliases';
import type {
  DistrictCandidate,
  DistrictMatchInfo,
  DistrictResolutionReason,
  DistrictSnapshot,
  DistrictTextQuery,
  DistrictTextResolution,
} from './district-resolver.types';

/**
 * Tuman rezolyutsiyasi — `logistics.district.resolve_by_text` (karta
 * AnKM7xmy, PLAN C7 / §5.14).
 *
 * Manba: BeePost `ai-order.service.ts` (origin/dev) `resolveDistrict()`
 * :1504-1752. searchPool qulfi va 1-4 usullar 1:1 ko'chirilgan; farqlar:
 *   - 0-bosqich (viloyat) QAYTA YOZILGAN: Elchi viloyat nomlari yalang'och
 *     ("Toshkent" = viloyat), shuning uchun nom emas —
 *     `regionAlias()` → SOATO → shu `sato_code`li viloyat qatori.
 *   - R1: shahar/tuman afzalligi nomdagi qo'shimcha emas, SOATO 5-raqami
 *     bo'yicha ('4' = shahar, '2' = tuman) + boshqa turdagi o'xshash qo'shni.
 *   - R2: viloyat qulflanmagan bo'lsa, boshqa viloyatda juda o'xshash tumani
 *     bor yagona moslik jimgina tanlanmaydi (Mirzaobod ↔ Mirobod). Qulf
 *     bo'lsa — 3-usul fuzzy moslik, so'rov qulfdan tashqaridagi tumanga
 *     kamida shunchalik yaqin bo'lsa, tanlanmaydi ("Qashqadaryo" + "Kogon").
 *   - R3: SOATO darvozasi — avto-tanlangan tumanning kodi o'z viloyati kodi
 *     bilan boshlanishi SHART.
 *   - R4: SOATO'siz tuman — darvoza o'tkazib yuboriladi + WARN; qulfsiz
 *     holatda faqat nomzod.
 *   - Tuman so'rovidan viloyat so'zining birinchi uchrashi olib tashlanadi
 *     ("Andijon xojaobd"); 2-usulda viloyat nomli tuman boshqa topilgan
 *     tumandan keyin turadi; yalang'och "Toshkent" tuman matni sifatida ham
 *     "Toshkent tumani"ni (1727) taxmin qildirmaydi.
 *
 * ⚠️ LLM, DB va tarmoq YO'Q — asosiy mantiq sof funksiya
 * (`resolveDistrictText`), spec DB'siz ishlaydi. Yordamchilar
 * `@app/common` (ai-text) dan olinadi — bu yerda QAYTA YOZILMAYDI, aks holda
 * spec'dagi o'lchangan juftliklar (Koson ↔ Kogon 0.80 ...) siljiydi.
 *
 * ⚠️ `order-service/src/lookup/order-lookup.service.ts`
 * (`resolveExternalDistrict`) bu yerga ULANMAYDI: hamkor importining qat'iy
 * rejimi fuzzy bilan jimgina zaiflashib qolardi.
 */

/** Bitta RPC'dagi elementlar chegarasi (C7). */
export const DISTRICT_RESOLVE_MAX_ITEMS = 50;

/** Har bir matn maydoni trim'dan keyin shu uzunlikda kesiladi (C7). */
export const DISTRICT_TEXT_MAX_CHARS = 300;

/**
 * 4-usul (fuzzy-substring) korpusining bo'shliqsiz skeleti shu uzunlikda
 * kesiladi. ⚠️ CPU: logistics bitta oqimli — qulfsiz holatda 181 tuman ×
 * korpus oynalari × Levenshtein 30 buyurtmali partiyada soniyalarga
 * cho'zilardi. Tuman nomi manzilda odatda boshida keladi.
 */
export const DISTRICT_CORPUS_MAX_CHARS = 120;

/**
 * Matnda joy belgisi bormi — BeePost :1596-1601 (hasPlaceSignal). D5: rus
 * va qisqa shakllar ham (shaxri, rayon, r-n, gorod, sh., g.).
 * r12: qo'shimchali tuman so'zlari (tum., tumanida/tumanidagi/tumaniga)
 * bu yerda YO'Q - ular faqat topilgan nomga tegishli bo'lsa belgi
 * (`suffixFor`): "Yangiyer tumanida, Navoiy 5" dagi belgi Yangiyer'niki -
 * yalang'och "Navoiy" (ko'cha) avto bo'lmaydi. "X tumani dan" (ajratib
 * yozilgan "tumanidan") - joy belgisi emas (r7 S3). r13: 4-usulda ham
 * (`placeSignalFor`).
 */
const PLACE_STRICT_RE =
  /\b(tumani|tuman|shahri|shaxri|shahar|shaharcha|shaharchasi|rayon|rayoni|raion|gorod)\b(?![\s-]*dan\b)|\br-n\b|\b(sh|g)\./;
/**
 * r17: belgilarning yana ikki yozuvi (translit matnda) - "р-он" ("r-on") =
 * "р-н" (tuman); qism oxiridagi nuqtasiz "X sh" ("Shahrisabz sh", "URGANCH
 * sh,") = "X sh." (shahar). Nuqtasiz "sh" faqat vergul / nuqtali vergul /
 * matn oxiridan oldin va X MA'LUM joy nomi bo'lsa (`isPlace`: tuman, alias,
 * fold shakli, viloyat so'zi) - "Ergasheva Sh" (ism bosh harfi), "Amir
 * Temur sh" (shoh ko'chasi), "5 sh", "sh Navoiy" belgi EMAS. `isPlace`
 * berilmasa (tokenlar - nuqta baribir o'chadi) faqat "р-он".
 */
function markNorm(
  s: string,
  isPlace?: (words: readonly string[]) => boolean,
): string {
  const out = s.replace(/\br-on\b/g, 'r-n');
  if (!isPlace) return out;
  return out.replace(
    /\s+sh(?=\s*(?:[,;]|$))/g,
    (m: string, at: number, all: string) => {
      const words = all
        .slice(0, at)
        .replace(/kh/g, 'x')
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .slice(-3);
      return words.length && isPlace(words) ? `${m}.` : m;
    },
  );
}
/** Shahar afzalligi belgisi — BeePost :1708-1709 (+ shaxri, gorod, sh., g.). */
const CITY_WORD_RE = /\b(shahri|shaxri|shahar|gorod)\b|\b(sh|g)\./;
/**
 * Tuman afzalligi belgisi — BeePost :1708-1709 (+ rayon, r-n, "X t.").
 * r4 NEW-B3 / r6 NEW-R6-1: "t." faqat nomdan keyin VA undan keyin vergul,
 * nuqtali vergul yoki matn oxiri ("Qarshi t.", "Yunusobod t., 5-uy").
 * Telefon ("t. 90 ...", "t.: 90..."), "t.y." / "t. y." (temir yo'l), ism
 * bosh harfi ("Toshkent T. Malik", "Qarshi T.Malik") va "Qarshi t. 5-uy"
 * (raqam) — belgi EMAS. Matnlar `, ` bilan qo'shiladi (maydon chegarasi).
 * r7 B2: "X t." faqat X tuman/viloyat nomi bo'lsa (`namedT`) — "Karimov T."
 * (familiya + bosh harf) joy belgisi EMAS; shuning uchun umumiy "X t."
 * PLACE_STRICT_RE / TUMAN_WORD_RE dan olib tashlangan.
 * r12: nom va "t." orasida chiziqcha yoki nuqta ham ("Qarshi-t.,",
 * "Qarshi -t.,", "Qarshi.t.,") - xuddi "Qarshi t.," kabi.
 */
const TUMAN_T_ABBR_RE = /([a-z]{2,})(?:\s*-\s*|\.\s*|\s+)t\.(?=\s*(?:[,;]|$))/g;
/** `addressTokens` da "X t." dan keyin qo'yiladigan belgi tokeni (r11). */
const TUMAN_T_ABBR_TOKEN = 'qqtabbrqq';
/** `addressTokens` ichida vergul / nuqtali vergul o'rni (r13). */
const SEPARATOR_TOKEN = 'qqsepqq';

/**
 * Manzil tokenlari va `sepBefore` - oldidan vergul yoki nuqtali vergul
 * kelgan token indekslari (r13): "Farg'ona rayon, Quva" dagi "rayon"
 * Farg'ona'niki, keyingi Quva uchun "rayon X" belgisi EMAS.
 */
interface AddressTokens {
  tokens: string[];
  sepBefore: ReadonlySet<number>;
}
const TUMAN_WORD_RE = /\b(tumani|tuman|rayon|rayoni|raion)\b|\br-n\b/;
/**
 * r6 qo'shimchali tuman belgilari: "X tumanida / tumanidagi / tumaniga",
 * "X tum." / "tum. X". Manzilda faqat X topilgan tumanning o'z nomi bo'lsa tur
 * belgisi - "Qarshi, Navoiy 5, Kasbi tumaniga yaqin" dagi "tumaniga"
 * Kasbi'niki, Qarshi'ni TUMANga aylantirmaydi (r11).
 */
const TUMAN_SUFFIX_RE =
  /([a-z]{2,})\s+(?:tumanida|tumanidagi|tumaniga)\b|([a-z]{2,})\s+tum\.|\btum\.\s*([a-z]{2,})/g;
/**
 * r7 B1: vergulsiz "X t. <so'z|uy raqami>" ("Qarshi t. Mustaqillik", "Qarshi
 * T.Malik", "Qarshi t. 5-uy") — tuman belgisi ham, ism bosh harfi / boshqa
 * narsa ham bo'lishi mumkin. Telefon ("t. 90 123 ...", "t. 901234567",
 * "t.: ", "t. +998", "t. (90)"), "t.y." va "[TEL_1]" bundan mustasno.
 * r12: "Qarshi.t. Navoiy 5", "Qarshi t. [Navoiy 5]" - ham noaniq; "[" faqat
 * "[TEL_n]" / "[EMAIL]" tokeni oldida belgi emas.
 * r13: "t.: (90) ...", "t. (tel) 90 ...", "t.: mob. ...", "t. (TEL_1)" -
 * telefon, belgi emas (head kabi).
 */
const SOFT_TUMAN_T_RE =
  /([a-z]{2,})(?:\s*-\s*|\.\s*|\s+)t\.(?!\s*(?:[,;+]|\[(?:tel|email)|[:(][\s:(]*(?:[+\d[]|tel|mob|nom|raq|sot|phone|aloqa|kont|cont)|$|y\b|y\.|\d{2}\s*\d{3}|\d{5,}))/g;

/**
 * D2: manzilda tuman nomidan KEYIN kelsa — bu ko'cha/mahalla nomi, tuman
 * emas ("Furqat ko'chasi", "Paxtaobod MFY", "ул. Навои" — `ul` OLDIN keladi,
 * u alohida tekshiriladi).
 */
const STREET_AFTER_WORDS: ReadonlySet<string> = new Set([
  'kochasi',
  'kocha',
  'koch',
  'kuchasi',
  'kucha',
  'mahallasi',
  'mahalla',
  'mfy',
  'mfi',
  'massivi',
  'massiv',
  'mavze',
  'mavzesi',
  'kvartal',
  'kvartali',
  'tor',
  'berk',
  'prospekti',
  'prospekt',
  'shoh',
  'guzar',
  'guzari',
  'ulitsa',
  'ulica',
  'proyezd',
  'pereulok',
  // Faqat keyin raqam yoki matn oxiri bo'lsa (2b'da tekshiriladi).
  'ul',
  // "Sergeli yo'li" — yo'l (translit apostrofni olib tashlaydi), r4 S2.
  'yoli',
  'yuli',
  'maxalla',
  'maxallasi',
  'qishlogi',
  'qishloq',
  'qfy',
  'ovul',
  'ovuli',
  'posyolok',
  'poselok',
  'bozori',
  'bekati',
]);
/**
 * "Olmazor ul. d. 5", "Sergeli ul. dom 12", "Chilonzor ul. uy 5" — "ul."
 * dan keyin uy/xonadon belgisi: bu ko'cha (r6 S1).
 */
const UL_HOUSE_WORDS: ReadonlySet<string> = new Set([
  'd',
  'dom',
  'uy',
  'kv',
  'kvartira',
  'xonadon',
  'k',
  'korpus',
  'no',
  'n',
  // r11: "ul. korp. 2", "ul. nomer 5", "ul. raqam 5", "ul. bino 5"
  'korp',
  'kor',
  'nomer',
  'raqam',
  'bino',
  // r13: "ul. xona 5", "ul. blok 3", "ul. qavat 2", "ул. этаж 4",
  // "ул. подъезд 1" — xonadon/bino qismi (ko'cha, tuman emas).
  'xona',
  'hona',
  'blok',
  'qavat',
  'kavat',
  'etaj',
  'etazh',
  'podyezd',
  'podezd',
  'padez',
  'pod',
]);
/** Nomdan OLDIN kelsa ko'cha belgisi ("ул. Навои", "pr. Amir Temur"). */
const STREET_BEFORE_WORDS: ReadonlySet<string> = new Set([
  'ul',
  'ulitsa',
  'pr',
  'prospekt',
  'mavze',
  'kvartal',
]);
/** Nomdan KEYIN kelsa — bu viloyat nomi (tuman emas). */
const REGION_AFTER_WORDS: ReadonlySet<string> = new Set([
  'viloyati',
  'viloyat',
  'vil',
  'oblast',
  'oblasti',
  'obl',
  'respublikasi',
]);
/** Nomdan KEYIN kelsa — aniq joy belgisi. */
const PLACE_AFTER_WORDS: ReadonlySet<string> = new Set([
  'tumani',
  'tuman',
  'tum',
  'tumanida',
  'tumanidagi',
  'tumaniga',
  'shahri',
  'shaxri',
  'shahar',
  'rayon',
  'rayoni',
  'raion',
  'sh',
  'g',
  'gorod',
  'shaharcha',
  'shaharchasi',
]);
const CITY_AFTER_WORDS: ReadonlySet<string> = new Set([
  'shahri',
  'shaxri',
  'shahar',
  'sh',
  'g',
  'gorod',
]);
const AREA_AFTER_WORDS: ReadonlySet<string> = new Set([
  'massivi',
  'massiv',
  'mavze',
  'mavzesi',
  'kvartal',
  'kvartali',
]);

const TUMAN_AFTER_WORDS: ReadonlySet<string> = new Set([
  'tumani',
  'tuman',
  // "Toshkent tum., ...", "Toshkent tumanida, ..." (r6). "tumanidan"
  // ("…dan kelgan") — yetkazish manzili EMAS, belgi emas (r7 S3).
  'tum',
  'tumanida',
  'tumanidagi',
  'tumaniga',
  'rayon',
  'rayoni',
  'raion',
]);

/** PR'dagi yangi qo'shimchali tuman belgilari (dev'da belgi emas edi, r6). */
const NEW_TUMAN_AFTER_WORDS: ReadonlySet<string> = new Set([
  'tum',
  'tumanida',
  'tumanidagi',
  'tumaniga',
]);

/** Nomdan keyin "...dan" - jo'natish joyi, yetkazish manzili emas (r7 S3). */
const ORIGIN_AFTER_WORDS: ReadonlySet<string> = new Set([
  'tumanidan',
  'shahridan',
  'shahardan',
]);

/**
 * r13: yashirin raqib qidiruvida nom bo'la olmaydigan so'zlar - belgilar,
 * ko'cha va uy so'zlari.
 */
const HIDDEN_SKIP_WORDS: ReadonlySet<string> = new Set([
  ...PLACE_AFTER_WORDS,
  ...ORIGIN_AFTER_WORDS,
  ...REGION_AFTER_WORDS,
  // "guzar" - ko'cha so'zi ham, G'uzor'ning rus yozuvi ("Гузар") ham.
  ...[...STREET_AFTER_WORDS].filter((w) => w !== 'guzar'),
  ...STREET_BEFORE_WORDS,
  ...UL_HOUSE_WORDS,
  'dan',
  'r',
  'n',
  // `geoFold` bilan tuman nomiga yaqin umumiy so'zlar (bozor ~ G'uzor,
  // katta ~ Quva, yangi ~ Yangiyer, do'kon ~ Qo'qon; mamlakat nomi).
  'bozor',
  'bozori',
  'bozorcha',
  'katta',
  'yangi',
  'dokon',
  'dukon',
  'ozbekiston',
  'uzbekistan',
]);

/** r14 (B1): mamlakat nomi ("Uzbekistan", "Узбекистан") - tuman emas. */
const COUNTRY_FOLDS: ReadonlySet<string> = new Set(['ozbiqiston']);
/**
 * r14 (B2): rus old qo'shimchalari - "из / с / от / откуда / отправитель /
 * рядом / возле / около / близ" + "г. X" / "р-н X" - jo'natish joyi yoki
 * mo'ljal (`ruOriginAt`).
 */
const RU_FROM_WORDS: ReadonlySet<string> = new Set([
  'iz',
  's',
  'ot',
  'otkuda',
  'otpravitel',
  'ryadom',
  'vozle',
  'okolo',
  'bliz',
  // r15: o'zbekcha jo'natuvchi so'zlari ("jo'natuvchi: г. X").
  'jonatuvchi',
  'jonatuvchisi',
  'yuboruvchi',
  'yuboruvchisi',
]);

/**
 * r13: matcher ko'rmaydigan yozuvni ("Карши", "Термез", "Денау", "Баяут",
 * "Yangiyer") tuman nomi bilan fuzzy taqqoslash uchun ikkala tomonda bir
 * xil yig'iladi: a/u -> o, k -> q, y/e -> i, dj/dzh/zh -> j, takror harf -
 * bitta.
 */
function geoFold(skel: string): string {
  return skel
    .replace(/dzh|dj|zh/g, 'j')
    .replace(/[au]/g, 'o')
    .replace(/k/g, 'q')
    .replace(/[ye]/g, 'i')
    .replace(/(.)\1+/g, '$1');
}

/**
 * r14 (S5): `geoFold` keshi - sof funksiya, so'rovlar orasida ham bir xil.
 * Hajmi chegaralangan (erkin matn so'zlari cheksiz emas).
 */
const GEO_FOLD_CACHE = new Map<string, string>();
const GEO_FOLD_CACHE_MAX = 20_000;
function foldOf(skel: string): string {
  let f = GEO_FOLD_CACHE.get(skel);
  if (f === undefined) {
    if (GEO_FOLD_CACHE.size >= GEO_FOLD_CACHE_MAX) GEO_FOLD_CACHE.clear();
    f = geoFold(skel);
    GEO_FOLD_CACHE.set(skel, f);
  }
  return f;
}

/**
 * r13: `tokens[j]` nomga (vergulsiz) qo'shilgan uy raqamimi - "Navoiy 5",
 * "Navoiy 12-uy" (ko'cha). "Qarshi, 5-mavze" (vergul) va "Chilonzor
 * 5-kvartal" (mavze / kvartal / massiv raqami) - uy raqami EMAS.
 */
function houseNumberAt(
  tokens: readonly string[],
  j: number,
  sepBefore: ReadonlySet<number>,
): boolean {
  if (sepBefore.has(j) || !/^\d/.test(tokens[j] ?? '')) return false;
  return !AREA_AFTER_WORDS.has(tokens[j + 1] ?? '');
}

/** `tokens[j]` dan aniq tuman belgisi boshlanadimi ("tumani", "t.", "r-n"). */
function tumanMarkerAt(tokens: string[], j: number): boolean {
  const w = tokens[j] ?? '';
  return TUMAN_AFTER_WORDS.has(w) || (w === 'r' && tokens[j + 1] === 'n');
}

/**
 * Nomdan OLDIN belgi — rus tartibi ("г. X" shahar, "р-н X" / "rayon X"
 * tuman). r13: oradagi vergul yoki nuqtali vergul bilan emas ("Farg'ona
 * rayon, Quva" dagi "rayon" Quva'niki EMAS).
 */
function kindBefore(
  tokens: readonly string[],
  i: number,
  sepBefore: ReadonlySet<number>,
): DistrictKind | null {
  if (sepBefore.has(i)) return null;
  const prev = tokens[i - 1] ?? '';
  if (prev === 'g' || prev === 'gorod') return 'city';
  if (
    prev === 'rayon' ||
    prev === 'raion' ||
    (prev === 'n' && tokens[i - 2] === 'r')
  ) {
    return 'tuman';
  }
  return null;
}

/**
 * r14 (B2): `tokens[i]` dagi nom oldida rus old qo'shimchasi + belgi - "из г.
 * X", "с г. X", "отправитель: р-н X" (`RU_FROM_WORDS`): jo'natish joyi yoki
 * mo'ljal, yetkazish manzili emas va boshqa nomga raqib ham emas.
 */
function ruOriginAt(
  tokens: readonly string[],
  i: number,
  sepBefore: ReadonlySet<number>,
): boolean {
  if (!kindBefore(tokens, i, sepBefore)) return false;
  const mark = tokens[i - 1] === 'n' ? i - 2 : i - 1;
  return !sepBefore.has(mark) && RU_FROM_WORDS.has(tokens[mark - 1] ?? '');
}

/**
 * r14 (S2): mo'ljal so'zlari - "X tumaniga ketaverishda / burilishda", "X
 * tumani tomonga", "X tumanidagi bozor yonida" (belgidan keyin 2 so'z
 * ichida) yoki nomdan OLDIN "mo'ljal: X", "orientir X", "возле X".
 */
const LANDMARK_AFTER_WORDS: ReadonlySet<string> = new Set([
  'tomonga',
  'tomon',
  'tomonda',
  'tomondagi',
  'tarafga',
  'tarafda',
  'ketaverishda',
  'ketaverish',
  'ketishda',
  'burilishda',
  'burilishida',
  'burilish',
  'chiqaverishda',
  'chiqishda',
  'kiraverishda',
  'kirishda',
  'borishda',
  'boraverishda',
  'yaqin',
  'yaqinida',
  'yaqinidagi',
  'yonida',
  'yonidagi',
  'oldida',
  'oldidagi',
  'ortida',
  'orqasida',
  'qarshisida',
  'chegarasida',
  // r15: "X tumaniga boradigan yo'lda", "X tumani bilan chegarada", "X р-н
  // рядом" (vergulsiz rus tartibi).
  'boradigan',
  'ketadigan',
  'chiqadigan',
  'yolda',
  'chegarada',
  'ryadom',
  'vozle',
  'okolo',
  'bliz',
]);
const LANDMARK_BEFORE_WORDS: ReadonlySet<string> = new Set([
  'moljal',
  'orientir',
  'oriyentir',
  'ryadom',
  'vozle',
  'okolo',
  'bliz',
]);

/** r15: `tokens[j]` joy belgisining oxirimi ("tumani", "sh", "р-н", "t."). */
function placeMarkEndsAt(tokens: readonly string[], j: number): boolean {
  const w = tokens[j] ?? '';
  return (
    PLACE_AFTER_WORDS.has(w) ||
    w === TUMAN_T_ABBR_TOKEN ||
    (w === 'n' && tokens[j - 1] === 'r')
  );
}

/** r14 (S2): `tokens[start..end)` dagi nom mo'ljalmi (`LANDMARK_*`). */
function landmarkAt(
  tokens: readonly string[],
  start: number,
  end: number,
  sepBefore: ReadonlySet<number>,
): boolean {
  const before = tokens[start - 1] ?? '';
  if (
    !sepBefore.has(start) &&
    LANDMARK_BEFORE_WORDS.has(before) &&
    // r15: "Бандихан р-н рядом Jarqo'rg'on sh." - "рядом" oldingi belgili
    // nomniki (u mo'ljal), keyingi nom esa manzil.
    !(!sepBefore.has(start - 1) && placeMarkEndsAt(tokens, start - 2))
  ) {
    return true;
  }
  let j = end;
  let span = 1;
  if (!sepBefore.has(j) && PLACE_AFTER_WORDS.has(tokens[j] ?? '')) {
    j += tokens[j + 1] === TUMAN_T_ABBR_TOKEN ? 2 : 1;
    span = 2;
  } else if (!sepBefore.has(j) && tokens[j] === 'r' && tokens[j + 1] === 'n') {
    j += 2;
    span = 2;
  }
  // Belgisiz nom - faqat darhol keyingi so'z ("Kasbi yonida"). r15: "bilan"
  // oraliq so'z ("X tumani bilan chegarada").
  for (let k = 0; k < span && j + k < tokens.length; k++) {
    if (sepBefore.has(j + k)) break;
    if (LANDMARK_AFTER_WORDS.has(tokens[j + k])) return true;
    if (tokens[j + k] === 'bilan' && span < 3) span++;
  }
  return false;
}

/**
 * r15: jo'natuvchi so'zi + nom ("otpravitel Do'stlik sh.", "jo'natuvchi:
 * Buloqboshi sh.") - jo'natish joyi: yetkazish manzili ham, raqib ham emas.
 */
const SENDER_WORDS: ReadonlySet<string> = new Set([
  'otpravitel',
  'otpravitelya',
  'jonatuvchi',
  'jonatuvchisi',
  'yuboruvchi',
  'yuboruvchisi',
]);
/**
 * r15: jo'natish joyi bo'laklari (translit matnda) - "из г. X", "рядом с г.
 * X", "отправитель: р-н X", "jo'natuvchi: X sh." - 4-usulning joy belgisi
 * (`PLACE_STRICT_RE`) ulardan olinmaydi: "рядом с г. Карши" - Karshi TUMANi
 * avto emas.
 */
const ORIGIN_CLAUSE_RES: readonly RegExp[] = [
  /(?:^|[^a-z])(?:iz|s|ot|otkuda|otpravitel[a-z]*|ryadom|vozle|okolo|bliz|jonatuvchi[a-z]*|yuboruvchi[a-z]*)(?:\s+so?)?[\s:,.-]*(?:g\.|gorod\b|r-n\b|rayon[a-z]*\b)\s*[a-z-]+/g,
  /(?:^|[^a-z])(?:otpravitel[a-z]*|jonatuvchi[a-z]*|yuboruvchi[a-z]*)[\s:-]*[a-z-]+(?:\s+(?:sh\.?|g\.|t\.|shahri|shahar|tumani|tuman|rayon|r-n)(?![a-z]))?/g,
];
function stripOriginClauses(translitText: string): string {
  let out = translitText;
  for (const re of ORIGIN_CLAUSE_RES) out = out.replace(re, ' ');
  return out;
}

/**
 * r16: mo'ljal bo'laklari (translit matnda) - "Шават р-н рядом", "X tumaniga
 * boradigan yo'lda", "mo'ljal: X tumani" - 4-usulning joy belgisi va tur
 * ulardan olinmaydi ("Gulzor ko'chasi 1, Шават р-н рядом" - G'uzor emas).
 */
const LANDMARK_CLAUSE_RES: readonly RegExp[] = [
  new RegExp(
    `[a-z-]+\\s*(?:-\\s*)?(?:tumani|tuman|tumaniga|tumanida|tumanidagi|tum\\.|rayon[a-z]*|r-n|sh\\.?|shahri|shahar|g\\.)\\s+(?:[a-z]+\\s+)?(?:${[...LANDMARK_AFTER_WORDS].join('|')})(?![a-z])`,
    'g',
  ),
  /(?:^|[^a-z])(?:moljal|orientir|oriyentir)[\s:,-]*[a-z-]+(?:\s+(?:tumani|tuman|tumaniga|tumanidagi|tum\.|rayon[a-z]*|r-n|sh\.?|shahri|shahar))?(?![a-z])/g,
];
/** r16: jo'natish joyi + mo'ljal bo'laklarisiz matn (`stripOriginClauses`). */
function stripNonDestClauses(translitText: string): string {
  let out = stripOriginClauses(translitText);
  for (const re of LANDMARK_CLAUSE_RES) out = out.replace(re, ' ');
  return out;
}

function senderAt(
  tokens: readonly string[],
  i: number,
  sepBefore: ReadonlySet<number>,
): boolean {
  return !sepBefore.has(i) && SENDER_WORDS.has(tokens[i - 1] ?? '');
}

/**
 * Manzil tokenlari: `normGeo` qo'shimchalarini SAQLAB (tumani, shahri).
 * Nomdan keyingi "t." (`TUMAN_T_ABBR_RE`) — "tumani" tokeni; telefon,
 * "t.y." yoki ism bosh harfidagi "t." esa oddiy "t" bo'lib qoladi.
 */
function addressTokens(text: string): AddressTokens {
  const raw = markNorm(lightNorm(text))
    // "№12": translit (kichik harf) dan keyin NFKC "№" → "No" (katta N) —
    // `[^a-z0-9]` uni o'chirib "o12" qoldirardi (r7 B3).
    // r11: raqamsiz "\u2116" ham ("Sergeli ul. \u2116").
    .replace(/No/g, ' no ')
    // r11: "X t." -> "tumani" + belgi tokeni (TUMAN_T_ABBR_TOKEN): bosh
    // harfli ism ("Muborak T.") aniq "sh./tumani"ni bosib ketmasin.
    .replace(TUMAN_T_ABBR_RE, `$1 tumani ${TUMAN_T_ABBR_TOKEN} `)
    .replace(RU_ADJ_SUFFIX_RE, '$1')
    // r13: vergul / nuqtali vergul - qism chegarasi (`sepBefore`).
    .replace(/[,;]/g, ` ${SEPARATOR_TOKEN} `)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  const tokens: string[] = [];
  const sepBefore = new Set<number>();
  let sep = false;
  for (const t of raw) {
    if (t === SEPARATOR_TOKEN) {
      sep = true;
      continue;
    }
    if (sep) sepBefore.add(tokens.length);
    sep = false;
    tokens.push(t);
  }
  return { tokens, sepBefore };
}

type DistrictKind = 'city' | 'tuman';

/** 0..1 ball — 3 xonagacha (null saqlanadi). */
function round3(x: number | null): number | null {
  return x === null ? null : Math.round(x * 1000) / 1000;
}

/** Toshkent shahri (1726) yoki viloyati (1727). */
function isTashkentSato(sato: string | null | undefined): boolean {
  return sato === '1726' || sato === '1727';
}

/**
 * Bir nechta viloyatga tegishli asos so'zlar — `REGION_ALIASES` dan
 * hisoblanadi (hozir "toshkent"/"tashkent": shahar 1726 ham, viloyat 1727
 * ham). Yalang'och shunday so'z tuman matni sifatida ham viloyatni
 * aniqlamaydi (quyidagi "yalang'och Toshkent" himoyasi).
 */
const AMBIGUOUS_REGION_WORDS: ReadonlySet<string> = (() => {
  const count = new Map<string, number>();
  for (const row of REGION_ALIASES) {
    for (const base of new Set(row.bases.map((b) => normGeo(b)))) {
      count.set(base, (count.get(base) ?? 0) + 1);
    }
  }
  return new Set([...count].filter(([, n]) => n > 1).map(([base]) => base));
})();

/**
 * Barcha viloyatlarning asos so'zlari (`REGION_ALIASES`, normGeo'dan
 * keyin). Shunday nomli tuman ("Andijon", "Samarqand", "Toshkent tumani")
 * 2-usulda boshqa tumandan KEYIN turadi: manzildagi "Samarqand" odatda
 * viloyatni bildiradi.
 */
const REGION_BASE_WORDS: ReadonlySet<string> = new Set(
  REGION_ALIASES.flatMap((row) => row.bases.map((b) => normGeo(b))),
);
/** `REGION_BASE_WORDS` skelet ko'rinishida (`tHeads` bilan taqqoslash). */
const REGION_BASE_SKELS: ReadonlySet<string> = new Set(
  [...REGION_BASE_WORDS].map((w) => geoSkeleton(w)),
);
/** r13: viloyat asos so'zi skeleti -> viloyat SOATO'lari ("toshkent" - 2). */
const REGION_SATOS_BY_SKEL: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const out = new Map<string, Set<string>>();
  for (const row of REGION_ALIASES) {
    for (const b of row.bases) {
      const sk = geoSkeleton(normGeo(b));
      const set = out.get(sk) ?? new Set<string>();
      set.add(row.sato);
      out.set(sk, set);
    }
  }
  return out;
})();

/**
 * r13: matnda KICHIK "t." / "т." bilan yozilgan "W t." nomlari (oxirgi so'z
 * skeleti) - "Поп т.", "So'x-t.,". Katta "T." ("Furqat T.") - ism bosh harfi
 * bo'lishi mumkin (S2).
 */
const LOWER_T_ABBR_RE =
  /([\p{L}\p{M}'`\u02bb\u02bc\u2018\u2019]{2,})(?:\s*-\s*|\.\s*|\s+)[t\u0442]\.(?=\s*(?:[,;]|$))/gu;
function lowerAbbrNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(LOWER_T_ABBR_RE)) {
    const sk = geoSkeleton(lightNorm(m[1]));
    if (sk) out.add(sk);
  }
  return out;
}

/**
 * r14 (S1): "Name T." - KATTA "T." / "Т." faqat ism bosh harfi bo'lishi
 * mumkin ("oluvchi Furqat T.", "Sherin Т."): yolg'iz o'zi hech qachon avto
 * bermaydi va turni (tuman) belgilamaydi. Kichik "t." ("Kasbi t.") -
 * tuman qisqartmasi, avvalgidek.
 */
const CAP_T_ANY_RE =
  /([\p{L}\p{M}'`\u02bb\u02bc\u2018\u2019]{2,})(?:\s*-\s*|\.\s*|\s+)[T\u0422]\./gu;
const LOWER_T_ANY_RE =
  /([\p{L}\p{M}'`\u02bb\u02bc\u2018\u2019]{2,})(?:\s*-\s*|\.\s*|\s+)[t\u0442]\./gu;
/** Faqat katta "T." bilan yozilgan nomlar (skelet; kichik "t." bilan ham - yo'q). */
/**
 * r15 (S1): tuman nomi bilan bir xil yoziladigan keng tarqalgan odam ismlari
 * ("Furqat T.", "Shirin T.", "Kitob T.") - katta "T." bilan bunday nom hech
 * qachon tuman belgisi deb qabul qilinmaydi. `geoFold` shaklida
 * ("Sherin", "Gulistan" ham). Kengaytirish uchun shu ro'yxatga qo'shing.
 */
export const PERSON_NAME_WORDS: readonly string[] = [
  'Furqat',
  'Shirin',
  'Muborak',
  'Guliston',
  'Navbahor',
  'Marhamat',
  'Nurafshon',
  'Nishon',
  "Bo'ston",
  'Kitob',
];
const PERSON_NAME_FOLDS: ReadonlySet<string> = new Set(
  PERSON_NAME_WORDS.map((n) => geoFold(geoSkeleton(normGeo(n)))),
);

function capitalAbbrNames(text: string): Set<string> {
  const lower = new Set<string>();
  for (const m of text.matchAll(LOWER_T_ANY_RE)) {
    lower.add(geoSkeleton(lightNorm(m[1])));
  }
  const out = new Set<string>();
  for (const m of text.matchAll(CAP_T_ANY_RE)) {
    const sk = geoSkeleton(lightNorm(m[1]));
    if (sk && !lower.has(sk)) out.add(sk);
  }
  return out;
}

/**
 * r14 (S1): oluvchi / mijoz / qabul qiluvchi / получатель / ism ... dan
 * keyingi "Name T." ("oluvchi Фуркат Т.", "получатель: Sherin Т.") - odam
 * ismi va bosh harfi: joy nomi ham, tuman belgisi ham emas - olib
 * tashlanadi (yalang'och raqib nom bo'lib ham qolmaydi).
 * r17: har qanday bosh harf - "Sh" / "Ch" (nuqtali yoki nuqtasiz: "mijoz
 * Guliston Sh", "получатель Rashidov SH", "oluvchi Muborak sh.") va bitta
 * harf + nuqta ("oluvchi Karimova D.").
 */
const RECIPIENT_INITIAL_RE =
  /((?<![\p{L}\p{M}])(?:oluvchi(?:si)?|qabul\s+qiluvchi(?:si)?|buyurtmachi(?:si)?|xaridor(?:i)?|mijoz|ismi?|fio|f\.i\.o\.?|klient|poluchatel|kimga|олувчи(?:си)?|қабул\s+қилувчи(?:си)?|мижоз|исми?|получател[ьяю]|получ\.|клиент|имя|фио|ф\.и\.о\.?|кому|буюртмачи(?:си)?|харидор(?:и)?|заказчик(?:а|у)?|покупател[ьяю])(?![\p{L}\p{M}])\s*[:\-\u2013\u2014]?\s*)((?:[\p{L}\p{M}'`\u02bb\u02bc\u2018\u2019]{2,}\s+)?[\p{L}\p{M}'`\u02bb\u02bc\u2018\u2019]{2,})(?:\s*-\s*|\.\s*|\s+)(?:[Tt\u0422\u0442]\.|(?:[Ss][Hh]|[Cc][Hh]|[\u0428\u0448\u0427\u0447])\.?(?![\p{L}\p{M}])|[A-Za-z\u0410-\u042f\u0430-\u044f]\.)/giu;
function dropRecipientInitials(text: string): string {
  return text.replace(RECIPIENT_INITIAL_RE, '$1');
}

/**
 * r14 (S4): yangi qator va bo'shliqli chiziqcha (" - ", " — ") - vergul kabi
 * qism chegarasi ("Forish\nNavro'z 4-uy", "Qarshi sh. - Navoiy 5"). "Qarshi
 * - t.," (nom va "t." orasidagi chiziqcha, r12) bundan mustasno.
 */
function normalizeSeparators(text: string): string {
  return text
    .replace(/\s*[\r\n]+\s*/g, ', ')
    .replace(/(?<=[\p{L}\p{N}.])\s+[-\u2013\u2014]+\s+(?![t\u0442]\.)/gu, ', ')
    .replace(/^(?:,\s*)+|(?:,\s*)+$/g, '')
    .trim();
}

/**
 * r12 (B3 kengaytmasi): manzilda aniq belgili ("W tumani", "W sh.", "W r-n",
 * "g. W", "rayon W"; `pool` dagi nom uchun "W t." ham) BOSHQA tuman nomi
 * bormi - W `heads` (rasmiy/bazadagi tuman nomlari) ichida, lekin `own`
 * (topilgan tumanlar) emas va viloyat asos so'zi emas ("Toshkent sh." -
 * viloyat). "Yangiyer tumani, Navoiy 5, Guliston T." da Yangiyer bazada
 * "Yangier" - topilmaydi, lekin u boshqa tuman.
 */
function explicitOtherName(
  tokenLists: readonly string[][],
  heads: ReadonlySet<string>,
  own: ReadonlySet<string>,
  pool: ReadonlySet<string>,
  lowerAbbr: ReadonlySet<string>,
  devOnly = false,
): boolean {
  for (const tokens of tokenLists) {
    for (let j = 0; j < tokens.length; j++) {
      const w = tokens[j];
      // "W t." - faqat qidiruv havzasidagi tuman nomi bo'lsa ("Yangiyer t." -
      // bazada "Yangier"); boshqa viloyat nomi + "T." ism bo'lishi mumkin (S2).
      // r13: kichik "t." / "т." bilan ("Поп т.", "So'x-t.") - ism bosh harfi
      // emas, tuman qisqartmasi: havzadan tashqarida ham boshqa tuman.
      const abbr = w === 'tumani' && tokens[j + 1] === TUMAN_T_ABBR_TOKEN;
      // r13 `devOnly`: faqat dev belgilari ("t." / "tumaniga" emas).
      if (devOnly && (abbr || NEW_TUMAN_AFTER_WORDS.has(w))) continue;
      const after =
        (PLACE_AFTER_WORDS.has(w) && tokens[j + 1] !== 'dan') ||
        (w === 'r' && tokens[j + 1] === 'n');
      // r14 (B2): "из г. X" / "с р-н X" - jo'natish joyi, boshqa nom emas.
      const before =
        (w === 'g' ||
          w === 'gorod' ||
          w === 'rayon' ||
          w === 'raion' ||
          (w === 'n' && tokens[j - 1] === 'r')) &&
        !RU_FROM_WORDS.has(tokens[w === 'n' ? j - 2 : j - 1] ?? '');
      for (let k = 1; k <= 3; k++) {
        const afterName = after && j >= k ? tokens.slice(j - k, j) : null;
        for (const name of [
          afterName,
          before ? tokens.slice(j + 1, j + 1 + k) : null,
        ]) {
          if (!name || name.length !== k) continue;
          // r15: "otpravitel X sh." - jo'natish joyi, boshqa nom emas.
          if (name === afterName && SENDER_WORDS.has(tokens[j - k - 1] ?? ''))
            continue;
          const sk = name.join('');
          if (
            heads.has(sk) &&
            !own.has(sk) &&
            !REGION_BASE_SKELS.has(sk) &&
            (!abbr || pool.has(sk) || lowerAbbr.has(name[k - 1]))
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

interface PreparedRegion {
  id: string;
  /** DB nomi, trim qilingan. */
  name: string;
  sato: string | null;
  /** Kanonik nom (`REGION_ALIASES`), bo'lmasa trim qilingan DB nomi. */
  label: string;
}

interface PreparedDistrict {
  id: string;
  /** DB nomi, trim qilingan. */
  name: string;
  sato: string | null;
  region_id: string;
  /** `normGeo(name)` — snapshot uchun BIR MARTA hisoblanadi. */
  geo: string;
  /** `geo` bo'shliqsiz (4-usul ignasi). */
  skeleton: string;
  /** `geo` faqat harf/raqam (`geoSkeleton`) — 1-usul skelet mosligi. */
  skel: string;
  /** `geo` tokenlari (harf/raqam) — 2-usul manzil qidiruvi. */
  tokens: string[];
  /** SOATO alias'lari (`DISTRICT_ALIASES`), skelet ko'rinishida. */
  aliases: ReadonlySet<string>;
  kind: DistrictKind | null;
  /** Nomi viloyat asos so'zi bilan bir xil ("Andijon", "Toshkent tumani"). */
  regionNamed: boolean;
}

interface PreparedSnapshot {
  regionById: Map<string, PreparedRegion>;
  regionBySato: Map<string, PreparedRegion>;
  nullSatoRegionIds: string[];
  districts: PreparedDistrict[];
  districtsByRegion: Map<string, PreparedDistrict[]>;
  /** R2 qo'shnilari keshi (tuman id → boshqa viloyatdagi o'xshashlar). */
  neighbourCache: Map<string, PreparedDistrict[]>;
  /** r13: `geoFold` shakllari (nom, alias, rasmiy nom) — yashirin raqib. */
  folds: {
    id: string;
    forms: string[];
    region: string;
    regionNamed: boolean;
  }[];
  /** r13: tuman id -> `geoFold` shakllari (2b belgili moslik). */
  foldById: Map<string, ReadonlySet<string>>;
  /** r13: ko'p so'zli nom qismlari ("mirzo", "ulugbek", "rashidov"). */
  nameParts: ReadonlySet<string>;
  /**
   * r14 (S5): `foldById` teskarisi - `geoFold` shakli -> tuman id'lari (2b
   * oynasi uchun har tumanni aylanib chiqmasdan).
   */
  idsByFold: Map<string, ReadonlySet<string>>;
  /** r14 (S5): `folds` shakllari uzunlik bo'yicha (yashirin raqib). */
  foldsByLen: Map<number, FoldForm[]>;
  /** r14 (S5): `${min}:${fold}` -> `min` dan o'xshash shakllar (kesh). */
  rivalHits: Map<string, RivalHit[]>;
  /** r14 (S5): bazadagi + rasmiy SOATO nom skeletlari (so'rovdan mustaqil). */
  allSkels: ReadonlySet<string>;
  /** r14 (S5): "X t." nom boshlari (`tHeads`, so'rovdan mustaqil). */
  tHeads: ReadonlySet<string>;
  /** r14 (S5): qidiruv havzasi (viloyat yoki hammasi) keshi. */
  poolInfo: WeakMap<readonly PreparedDistrict[], PoolInfo>;
}

/** r14 (S5): yashirin raqib qidiruvidagi bitta `geoFold` shakli. */
interface FoldForm {
  id: string;
  g: string;
  region: string;
  regionNamed: boolean;
}
interface RivalHit {
  id: string;
  region: string;
  regionNamed: boolean;
  sim: number;
}
/** r14 (S5): havza skeletlari, id'lari va nom boshlari (`headsOf`). */
interface PoolInfo {
  skels: ReadonlySet<string>;
  ids: ReadonlySet<string>;
  heads: ReadonlySet<string> | null;
}
const RIVAL_HITS_MAX = 20_000;

/** Tozalangan so'rov: hamma maydon satr ('' = yo'q). */
interface CleanQuery {
  region_name: string;
  district_name: string;
  address: string;
  full_address: string;
  region_inferred: boolean;
}

const PREPARED = new WeakMap<DistrictSnapshot, PreparedSnapshot>();

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, DISTRICT_TEXT_MAX_CHARS).trim();
}

/**
 * RMQ elementini xavfsiz shaklga keltiradi: satr bo'lmagan qiymat '' ga,
 * har bir satr trim + `DISTRICT_TEXT_MAX_CHARS` bilan kesiladi.
 */
export function sanitizeDistrictTextQuery(raw: unknown): CleanQuery {
  const src =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    region_name: cleanText(src.region_name),
    district_name: cleanText(src.district_name),
    address: cleanText(src.address),
    full_address: cleanText(src.full_address),
    region_inferred: src.region_inferred === true,
  };
}

function cleanSato(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value as string | number).trim();
  return s ? s : null;
}

/**
 * SOATO 5-belgisi: '4' = shahar, '2' = tuman. Kod yo'q bo'lsa — nomdagi
 * alohida so'z ("shahri" / "tumani"). ⚠️ "Shahrixon" / "Shahrisabz" ichidagi
 * "shah" shahar belgisi EMAS (so'z chegarasi).
 */
function districtKind(name: string, sato: string | null): DistrictKind | null {
  if (sato && /^\d{5,}$/.test(sato)) {
    if (sato[4] === '4') return 'city';
    if (sato[4] === '2') return 'tuman';
    return null;
  }
  const light = lightNorm(name);
  if (CITY_WORD_RE.test(light)) return 'city';
  if (TUMAN_WORD_RE.test(light)) return 'tuman';
  return null;
}

/**
 * Rasmiy SOATO ro'yxatida (sato-codes.ts) viloyat + skelet bo'yicha qaysi
 * turlar MAVJUD. kind_mismatch faqat so'ralgan tur rasmiy ro'yxatda bor
 * bo'lsa (shahar qatori bazaga hali qo'shilmagan): "Farg'ona shahri" →
 * 1730401 bor, bazada faqat tuman → operator tanlaydi. Rasmiy ro'yxatda
 * so'ralgan tur YO'Q bo'lsa ("Asaka shahri", "Chust shahri", "Urgut
 * shahri" — alohida SOATO shahar emas) — bu so'zlashuv odati, mavjud
 * qator avto-tanlanadi.
 */
const OFFICIAL_KINDS: ReadonlyMap<string, ReadonlySet<DistrictKind>> = (() => {
  const out = new Map<string, Set<DistrictKind>>();
  for (const r of satoRegions) {
    for (const d of r.districts) {
      const kind = districtKind(d.name, d.sato_code);
      if (!kind) continue;
      const key = `${r.sato_code}:${geoSkeleton(normGeo(d.name))}`;
      const set = out.get(key) ?? new Set<DistrictKind>();
      set.add(kind);
      out.set(key, set);
    }
  }
  return out;
})();

/**
 * #646 review (round 2): rasmiy SOATO'dagi BARCHA nomlar skeleti — bazada
 * hali yo'q nom ("O'rta Chirchiq", "Quvasoy") ham "uzunroq nom ichidagi
 * qisqa nom" himoyasida hisobga olinadi.
 */
const OFFICIAL_SKELS: readonly string[] = satoRegions.flatMap((r) =>
  r.districts.map((d) => geoSkeleton(normGeo(d.name))),
);
/**
 * SOATO kodi -> rasmiy nom skeleti ("1724413" -> "yangiyer"; bazadagi qator
 * nomi "Yangier").
 */
const OFFICIAL_SKEL_BY_SATO: ReadonlyMap<string, string> = new Map(
  satoRegions.flatMap((r) =>
    r.districts.map((d) => [d.sato_code, geoSkeleton(normGeo(d.name))]),
  ),
);

/**
 * r13: rasmiy ko'p so'zli nomlarning qismlari (`geoFold`) — "Rashidov T.",
 * "Ulug'bek T." (ism + bosh harf) yashirin raqib EMAS (r11 B1).
 */
const NAME_PART_FOLDS: readonly string[] = satoRegions.flatMap((r) =>
  r.districts.flatMap((d) => {
    const tokens = normGeo(d.name).split(' ').filter(Boolean);
    return tokens.length > 1 ? tokens.map((t) => geoFold(geoSkeleton(t))) : [];
  }),
);

function officialHasKind(
  sato: string | null,
  skel: string,
  kind: DistrictKind,
): boolean {
  if (!sato || sato.length < 4) return true; // noma'lum — ehtiyotkor
  return OFFICIAL_KINDS.get(`${sato.slice(0, 4)}:${skel}`)?.has(kind) ?? false;
}

/** Satr bigrammalari (pozitsiya bo'yicha, takrorlari bilan). */
export function geoBigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 <= s.length; i++) out.push(s.slice(i, i + 2));
  return out;
}

/**
 * 4-usul uchun ARZON zaruriy shart — natijani O'ZGARTIRMAYDI, faqat CPU'ni
 * tejaydi. q-gram lemmasi: tahrir masofasi <= k bo'lsa, ignaning (n-1) ta
 * bigrammasidan kamida (n-1-2k) tasi korpusda uchraydi. `bestSubstringSim`
 * balli = 1 - lev / max(oyna, n), oyna <= n + 1, ya'ni
 * `GEO_SUBSTRING_MIN` uchun lev <= (1 - GEO_SUBSTRING_MIN)·(n + 1).
 * false → `bestSubstringSim(corpus, needle) < GEO_SUBSTRING_MIN` KAFOLATLI.
 */
export function mayReachGeoSubstringMin(
  corpusBigrams: ReadonlySet<string>,
  needle: string,
): boolean {
  const n = needle.length;
  // Ortiqcha baholash xavfsiz (kamroq filtrlaydi), kam baholash — yo'q.
  const maxEdits = Math.floor((1 - GEO_SUBSTRING_MIN) * (n + 1) + 1e-9);
  const need = n - 1 - 2 * maxEdits;
  if (need <= 0) return true;
  let shared = 0;
  for (let i = 0; i + 2 <= n; i++) {
    if (corpusBigrams.has(needle.slice(i, i + 2))) shared++;
    if (shared >= need) return true;
  }
  return false;
}

function prepareSnapshot(snapshot: DistrictSnapshot): PreparedSnapshot {
  const cached = PREPARED.get(snapshot);
  if (cached) return cached;

  const regionById = new Map<string, PreparedRegion>();
  const regionBySato = new Map<string, PreparedRegion>();
  const nullSatoRegionIds: string[] = [];
  for (const row of snapshot.regions ?? []) {
    const name = String(row.name ?? '').trim();
    const sato = cleanSato(row.sato_code);
    const region: PreparedRegion = {
      id: String(row.id),
      name,
      sato,
      label: REGION_ALIASES.find((r) => r.sato === sato)?.canonical ?? name,
    };
    regionById.set(region.id, region);
    if (sato) regionBySato.set(sato, region);
    else nullSatoRegionIds.push(region.id);
  }

  const districts: PreparedDistrict[] = [];
  const districtsByRegion = new Map<string, PreparedDistrict[]>();
  for (const row of snapshot.districts ?? []) {
    const name = String(row.name ?? '').trim();
    const sato = cleanSato(row.sato_code);
    const geo = normGeo(name);
    const skeleton = geo.replace(/\s+/g, '');
    const district: PreparedDistrict = {
      id: String(row.id),
      name,
      sato,
      region_id: String(row.region_id),
      geo,
      skeleton,
      skel: geoSkeleton(geo),
      tokens: geo
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter(Boolean),
      aliases: new Set(sato ? (DISTRICT_ALIASES[sato] ?? []) : []),
      kind: districtKind(name, sato),
      regionNamed: REGION_BASE_WORDS.has(geo),
    };
    districts.push(district);
    const bucket = districtsByRegion.get(district.region_id);
    if (bucket) bucket.push(district);
    else districtsByRegion.set(district.region_id, [district]);
  }

  const nameParts = new Set<string>(NAME_PART_FOLDS);
  const folds = districts.map((d) => {
    const official = d.sato ? OFFICIAL_SKEL_BY_SATO.get(d.sato) : undefined;
    if (d.tokens.length > 1) {
      for (const t of d.tokens) nameParts.add(geoFold(geoSkeleton(t)));
    }
    return {
      id: d.id,
      region: d.region_id,
      regionNamed: d.regionNamed,
      forms: [
        ...new Set(
          [d.skel, ...d.aliases, official ?? '']
            .filter((f) => f.length >= 4)
            .map(geoFold),
        ),
      ],
    };
  });
  const idsByFold = new Map<string, Set<string>>();
  const foldsByLen = new Map<number, FoldForm[]>();
  for (const f of folds) {
    for (const g of f.forms) {
      const ids = idsByFold.get(g) ?? new Set<string>();
      ids.add(f.id);
      idsByFold.set(g, ids);
      const bucket = foldsByLen.get(g.length) ?? [];
      bucket.push({
        id: f.id,
        g,
        region: f.region,
        regionNamed: f.regionNamed,
      });
      foldsByLen.set(g.length, bucket);
    }
  }
  const allSkels = new Set([
    ...districts.map((d) => d.skel),
    ...OFFICIAL_SKELS,
  ]);
  // r7 B2: "X t." faqat X tuman/viloyat nomi bo'lsa ("Karimov T." — ism
  // bosh harfi, joy belgisi EMAS).
  // r11: ko'p so'zli nom ("Mirzo Ulug'bek t.", "Sharof Rashidov t.") faqat
  // TO'LIQ holda - oxirgi so'zning o'zi ("Rashidov T.", "Ulug'bek T." -
  // familiya/ism + bosh harf) belgi EMAS. Viloyat asoslari faqat shu nomli
  // tuman/shahar bor viloyatda ("Samarqand t.", "Toshkent t."); "Qashqadaryo
  // t." - tuman emas.
  const tHeads = new Set<string>(allSkels);
  for (const d of districts) {
    for (const a of d.aliases) tHeads.add(a);
  }
  // Viloyat asosi faqat o'zi (yoki qoidaviy varianti: Samarkand -> samarqand)
  // tuman/shahar nomi bo'lsa: "Qashqadaryo t." - tuman emas. Qoidaviy
  // varianti bazadagi nomga yetmaydigan yozuv ("Fergana t.", "Syrdarya t.")
  // ham belgi emas - tur noaniq qoladi (nomzod), avto emas (r12).
  const districtHeads = new Set<string>(tHeads);
  for (const row of REGION_ALIASES) {
    for (const b of row.bases) {
      const sk = geoSkeleton(normGeo(b));
      if ([...geoSpellingVariants(sk)].some((v) => districtHeads.has(v))) {
        tHeads.add(sk);
      }
    }
  }
  const prepared: PreparedSnapshot = {
    regionById,
    regionBySato,
    nullSatoRegionIds,
    districts,
    districtsByRegion,
    neighbourCache: new Map(),
    folds,
    foldById: new Map(folds.map((f) => [f.id, new Set(f.forms)])),
    nameParts,
    idsByFold,
    foldsByLen,
    rivalHits: new Map(),
    allSkels,
    tHeads,
    poolInfo: new WeakMap(),
  };
  PREPARED.set(snapshot, prepared);
  return prepared;
}

/**
 * r14 (S5): `f` ga `min` dan o'xshash (`simRatio`) barcha `geoFold` shakllari
 * - uzunlik farqi chegarasidan tashqaridagi chelaklar umuman ko'rilmaydi.
 * Natija snapshot uchun keshlanadi (yashirin raqib har chaqiruvda emas).
 */
function rivalHitsFor(
  idx: PreparedSnapshot,
  f: string,
  min: number,
): RivalHit[] {
  const key = `${min}:${f}`;
  const cached = idx.rivalHits.get(key);
  if (cached) return cached;
  const hits: RivalHit[] = [];
  for (const [len, forms] of idx.foldsByLen) {
    const m = Math.max(f.length, len);
    if (Math.abs(f.length - len) > (1 - min) * m) continue;
    for (const { id, g, region, regionNamed } of forms) {
      const sim = simRatio(f, g);
      if (sim >= min) hits.push({ id, region, regionNamed, sim });
    }
  }
  if (idx.rivalHits.size >= RIVAL_HITS_MAX) idx.rivalHits.clear();
  idx.rivalHits.set(key, hits);
  return hits;
}

/** r14 (S5): havza skeletlari / id'lari - snapshot va havza uchun bir marta. */
function poolInfoOf(
  idx: PreparedSnapshot,
  pool: readonly PreparedDistrict[],
): PoolInfo {
  let info = idx.poolInfo.get(pool);
  if (!info) {
    info = {
      skels: new Set(pool.map((d) => d.skel)),
      ids: new Set(pool.map((d) => d.id)),
      heads: null,
    };
    idx.poolInfo.set(pool, info);
  }
  return info;
}

/**
 * Viloyat so'zlari (normGeo tokenlari ketma-ketligi): kiritilgan viloyat
 * matni, alias kanonik nomi va qulflangan viloyatning DB nomi.
 */
function collectRegionWords(
  regionName: string,
  regionSato: string | null,
  lockedRegion: PreparedRegion | null,
): string[][] {
  const words = new Set<string>();
  const add = (s: string | null | undefined) => {
    const g = normGeo(s);
    if (g) words.add(g);
  };
  add(regionName);
  if (regionSato) {
    add(REGION_ALIASES.find((r) => r.sato === regionSato)?.canonical);
  }
  if (lockedRegion) add(lockedRegion.name);
  return [...words]
    .map((w) => w.split(' ').filter(Boolean))
    .filter((seq) => seq.length > 0)
    .sort((a, b) => b.length - a.length);
}

/**
 * Tokenlar ichidan viloyat so'zining FAQAT BIRINCHI uchrashini olib
 * tashlaydi (BeePost :1661-1672). Keyingilari SAQLANADI: "Andijon viloyati
 * Andijon tumani" dagi ikkinchi "Andijon" aynan TUMAN.
 */
function stripFirstRegionWord(tokens: string[], seqs: string[][]): string[] {
  for (let i = 0; i < tokens.length; i++) {
    for (const seq of seqs) {
      if (i + seq.length > tokens.length) continue;
      if (seq.every((w, k) => tokens[i + k] === w)) {
        return [...tokens.slice(0, i), ...tokens.slice(i + seq.length)];
      }
    }
  }
  return tokens;
}

/**
 * R2: boshqa viloyatdagi `simRatio(normGeo) >= GEO_FUZZY_MIN` tumanlar
 * (o'xshashlik kamayishi bo'yicha). Snapshot uchun keshlanadi.
 */
function crossRegionNeighbours(
  d: PreparedDistrict,
  idx: PreparedSnapshot,
): PreparedDistrict[] {
  const cached = idx.neighbourCache.get(d.id);
  if (cached) return cached;
  const list = idx.districts
    .filter((o) => o.region_id !== d.region_id)
    .map((o) => ({ o, s: simRatio(o.geo, d.geo) }))
    .filter((x) => x.s >= GEO_FUZZY_MIN)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.o);
  idx.neighbourCache.set(d.id, list);
  return list;
}

/**
 * r14 (S3): tur jo'natish joyidan olinmaydi - "X tumani dan" / "X shahri
 * dan" (ajratib yozilgan "...dan") va rus old qo'shimchasi bilan "из г. X",
 * "с р-на X", "отправитель: г. X" (`RU_FROM_WORDS`) belgisi manzilning
 * turini bildirmaydi: "Shahrisabz tumani dan, Qarshi sh, Navoiy 5" -
 * Qarshi TUMANi emas.
 */
const RU_FROM_LOOKBEHIND =
  '(?<!(?:^|[^a-z])(?:iz|s|ot|otkuda|otpravitel|ryadom|vozle|okolo|bliz)[\\s:,.-]*)';
const WANT_CITY_RE = new RegExp(
  `${RU_FROM_LOOKBEHIND}\\b(?:shahri|shaxri|shahar|gorod)\\b(?![\\s-]*dan\\b)|\\bsh\\.|${RU_FROM_LOOKBEHIND}\\bg\\.`,
);
const WANT_TUMAN_RE = new RegExp(
  `${RU_FROM_LOOKBEHIND}\\b(?:tumani|tuman|rayon|rayoni|raion)\\b(?![\\s-]*dan\\b)|${RU_FROM_LOOKBEHIND}\\br-n\\b`,
);

/**
 * Matn qaysi turni so'rayapti: "shahri/shahar" → shahar, "tumani/tuman" →
 * tuman (BeePost :1703-1719); ikkalasi ham yoki hech biri bo'lmasa null.
 */
function wantedKind(
  markerText: string,
  namedTumanT = false,
): DistrictKind | null {
  const wantsCity = WANT_CITY_RE.test(markerText);
  const wantsTuman = WANT_TUMAN_RE.test(markerText) || namedTumanT;
  if (wantsCity && !wantsTuman) return 'city';
  if (wantsTuman && !wantsCity) return 'tuman';
  return null;
}

/**
 * R1: matn so'ragan turdagi tuman afzal. Tur SOATO 5-belgisidan olinadi.
 * Moslik boshqa turda bo'lsa, shu viloyatdagi o'xshash
 * (`simRatio >= GEO_SUBSTRING_MIN`) kerakli turdagi qo'shni ham qo'shiladi:
 * "Qarshi tumani" → DB'dagi "Karshi" (1710224), "Qarshi shahri" (1710401)
 * EMAS.
 */
function preferCityOrTuman(
  matches: PreparedDistrict[],
  want: DistrictKind | null,
  idx: PreparedSnapshot,
): PreparedDistrict[] {
  if (!want || !matches.length) return matches;

  const expanded: PreparedDistrict[] = [];
  const seen = new Set<string>();
  const push = (d: PreparedDistrict) => {
    if (seen.has(d.id)) return;
    seen.add(d.id);
    expanded.push(d);
  };
  for (const m of matches) {
    push(m);
    if (!m.kind || m.kind === want) continue;
    for (const s of idx.districtsByRegion.get(m.region_id) ?? []) {
      if (s.id !== m.id && s.kind === want) {
        if (simRatio(s.geo, m.geo) >= GEO_SUBSTRING_MIN) push(s);
      }
    }
  }
  const preferred = expanded.filter((d) => d.kind === want);
  return preferred.length ? preferred : matches;
}

type SatoGate = 'ok' | 'mismatch' | 'unverifiable';

/** R3/R4: tuman SOATO kodi o'z viloyati kodi bilan boshlanishi SHART. */
function satoGate(
  d: PreparedDistrict,
  region: PreparedRegion | undefined,
): SatoGate {
  if (!d.sato || !region?.sato) return 'unverifiable';
  return d.sato.startsWith(region.sato) ? 'ok' : 'mismatch';
}

/**
 * Erkin matndan viloyat + tumanni aniqlaydi. SOF funksiya: DB/tarmoq yo'q,
 * kirish qiymatini o'zgartirmaydi, hech qachon xato tashlamaydi (har qanday
 * JSON kirishi `sanitizeDistrictTextQuery` dan o'tadi).
 *
 * `warn` — faqat id/SOATO bilan ogohlantirish (manzil matni HECH QACHON
 * log'ga yozilmaydi: PII).
 */
export function resolveDistrictText(
  input: DistrictTextQuery,
  snapshot: DistrictSnapshot,
  warn: (msg: string) => void,
): DistrictTextResolution {
  const clean = sanitizeDistrictTextQuery(input);
  // r14 (S1): "oluvchi Furqat T." - ism bosh harfi, tuman belgisi emas.
  // r14 (S4): yangi qator / " - " - vergul kabi chegara.
  const q: CleanQuery = {
    ...clean,
    address: dropRecipientInitials(normalizeSeparators(clean.address)),
    full_address: dropRecipientInitials(
      normalizeSeparators(clean.full_address),
    ),
  };
  const idx = prepareSnapshot(snapshot);
  /**
   * r17: nuqtasiz "X sh" dagi X ma'lum joy nomimi (oxirgi 1-3 so'z: tuman,
   * alias, fold shakli yoki viloyat so'zi) - `markNorm`.
   */
  const isPlace = (words: readonly string[]): boolean => {
    for (let k = 1; k <= words.length; k++) {
      const sk = geoSkeleton(words.slice(-k).join(''));
      if (
        idx.tHeads.has(sk) ||
        REGION_SATOS_BY_SKEL.has(sk) ||
        idx.idsByFold.has(foldOf(sk))
      )
        return true;
    }
    return false;
  };
  const destNorm = (s: string): string => markNorm(translit(s), isPlace);
  /** r14 (S1): faqat katta "T." bilan yozilgan nomlar (`capitalAbbrNames`). */
  const capNames = capitalAbbrNames(`${q.full_address}, ${q.address}`);

  // 0. VILOYAT (Elchi): regionAlias → SOATO → shu sato_code'li qator.
  // Yalang'och "Toshkent" → null (NOANIQ) — tuman viloyatni o'zi aniqlaydi.
  const regionSato = regionAlias(q.region_name);
  const regionGiven = regionSato !== null;
  const lockedRegion: PreparedRegion | null = regionSato
    ? (idx.regionBySato.get(regionSato) ?? null)
    : null;
  if (regionSato && !lockedRegion) {
    // ⚠️ Viloyat qatorining sato_code'i NULL bo'lsa unga alias orqali
    // yetib bo'lmaydi. Nom bo'yicha taxmin QILINMAYDI — qulfsiz qidiruv.
    warn(
      `district-resolver: region SOATO ${regionSato} has no regions row (regions with NULL sato_code: ${
        idx.nullSatoRegionIds.join(',') || 'none'
      }); searching without region lock`,
    );
  }

  // searchPool QULFI (BeePost :1571-1574): viloyat aniq bo'lsa qidiruv
  // FAQAT shu viloyat ichida — "Toshkent shahri Xonobod" Andijondagi
  // Xonobod'ni OLMAYDI; tuman bo'sh qoladi, viloyat SAQLANADI.
  // r14 (S5): `allSkels` / `tHeads` so'rovdan mustaqil - `prepareSnapshot`.
  const { allSkels, tHeads } = idx;
  /**
   * `accept` berilsa - "X t." faqat `accept(X)` bo'lsa (r12). r14 (S1):
   * `cap` - X faqat katta "T." bilan yozilgan (`capNames`).
   */
  const namedT = (
    text: string,
    re: RegExp,
    accept?: (head: string, cap: boolean) => boolean,
  ): boolean => {
    const light = lightNorm(text);
    for (const m of light.matchAll(re)) {
      const cap = capNames.has(m[1]);
      const words = light
        .slice(0, (m.index ?? 0) + m[1].length)
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
      for (let k = 1; k <= 3 && k <= words.length; k++) {
        const w = words.slice(-k).join('');
        if (tHeads.has(w) && (!accept || accept(w, cap))) return true;
      }
    }
    return false;
  };
  /**
   * Topilgan tumanlarning nom skeletlari (qo'shimchali belgi egasi) - bazadagi
   * nom, uning so'zlari, alias'lar va rasmiy SOATO nomi (r12).
   */
  const headsOf = (list: readonly PreparedDistrict[]): Set<string> => {
    const heads = new Set<string>();
    for (const d of list) {
      heads.add(d.skel);
      for (const t of d.tokens) heads.add(geoSkeleton(t));
      for (const a of d.aliases) heads.add(a);
      const official = d.sato ? OFFICIAL_SKEL_BY_SATO.get(d.sato) : undefined;
      if (official) heads.add(official);
    }
    return heads;
  };
  /**
   * `heads` berilsa - qo'shimchali belgi faqat shu nomlardan keyin (r13:
   * `geoFold` bo'yicha ham - "Qarshy tumanida").
   */
  const suffixFor = (text: string, heads?: ReadonlySet<string>): boolean => {
    let folds: Set<string> | null = null;
    for (const m of lightNorm(text).matchAll(TUMAN_SUFFIX_RE)) {
      if (!heads) return true;
      const sk = geoSkeleton(m[1] ?? m[2] ?? m[3]);
      if (heads.has(sk)) return true;
      folds ??= new Set([...heads].map(foldOf));
      if (folds.has(foldOf(sk))) return true;
    }
    return false;
  };
  /**
   * r13: "W t." - W topilgan nomning matcher ko'rmaydigan yozuvi bo'lsa ham
   * (`geoFold`: "Termez t.", "Каган t.") - o'sha nomning tuman belgisi.
   */
  const foldAbbrFor = (text: string, heads: ReadonlySet<string>): boolean => {
    const folds = new Set([...heads].map(foldOf));
    for (const m of lightNorm(text).matchAll(TUMAN_T_ABBR_RE)) {
      if (capNames.has(m[1])) continue; // r14 (S1)
      if (folds.has(foldOf(geoSkeleton(m[1])))) return true;
    }
    return false;
  };
  const kindOf = (
    text: string,
    heads?: ReadonlySet<string>,
  ): DistrictKind | null =>
    wantedKind(
      // r16: tur jo'natish joyi / mo'ljal belgisidan olinmaydi
      // ("jo'natuvchi: Kasbi sh." - Qarshi shahri emas).
      stripNonDestClauses(destNorm(text)),
      // r14 (S1): katta "T." ("Furqat T.") turni belgilamaydi.
      namedT(text, TUMAN_T_ABBR_RE, (_w, cap) => !cap) ||
        suffixFor(text, heads) ||
        (!!heads && foldAbbrFor(text, heads)),
    );
  const addressKind = new Map<string, DistrictKind>();
  const streetRejected = new Set<string>();
  const pool = lockedRegion
    ? (idx.districtsByRegion.get(lockedRegion.id) ?? [])
    : idx.districts;

  const regionWords = collectRegionWords(
    q.region_name,
    regionSato,
    lockedRegion,
  );

  // Tuman so'rovi: viloyat so'zining birinchi uchrashi olib tashlanadi
  // (qolgan narsa bo'lsa) — "Andijon xojaobd" Andijon TUMANiga yolg'on
  // mos kelmasin.
  const districtTokens = normGeo(q.district_name).split(' ').filter(Boolean);
  const strippedTokens = stripFirstRegionWord(districtTokens, regionWords);
  const dq = (strippedTokens.length ? strippedTokens : districtTokens).join(
    ' ',
  );

  let matches: PreparedDistrict[] = [];
  let viaFuzzy = false;
  // Topilma faqat NOMZOD (avto-tanlov emas) — sabab `district_ambiguous`.
  let candidateOnly = false;
  // P1-7 (D6): qaysi bosqich topdi — avto-tanlovda `match` uchun.
  let stage: 'exact' | 'word' | 'fuzzy' | 'address' | 'substring' = 'exact';
  let stageScore: number | null = null;
  let regionSwitched = false;
  const dqSkel = geoSkeleton(dq);
  const dqTokens = dq
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);

  /** 1-usul: aniq nom → skelet → SOATO alias → qoidaviy variant. */
  const exactIn = (
    list: PreparedDistrict[],
  ): { found: PreparedDistrict[]; variant: boolean } => {
    if (!dq) return { found: [], variant: false };
    let found = list.filter((d) => d.geo === dq);
    if (!found.length && dqSkel.length >= 3) {
      found = list.filter((d) => d.skel === dqSkel);
    }
    // Alias (SOATO kalitli) aniq nom bilan BIRGA: "Karshi" bazada tuman
    // qatori nomi, lekin rus tilida odatda Qarshi SHAHRI — ikkalasi nomzod.
    if (dqSkel.length >= 3) {
      const byAlias = list.filter(
        (d) => d.aliases.has(dqSkel) && !found.includes(d),
      );
      found = [...found, ...byAlias];
    }
    if (found.length || dqSkel.length < 4) {
      return { found, variant: false };
    }
    const variants = geoSpellingVariants(dqSkel);
    return {
      found: list.filter((d) => variants.has(d.skel)),
      variant: true,
    };
  };

  // 1-usul (BeePost :1576-1589, D3): aniq / skelet / alias / variant.
  if (dq) {
    const exact = exactIn(pool);
    matches = exact.found;
    if (exact.variant && matches.length) viaFuzzy = true;
    // D3: qism-moslik faqat TOKEN chegarasida va faqat NOMZOD ("Yuqori
    // Chirchiq" → Chirchiq shahri emas; "Quvasoy" → Quva emas).
    if (!matches.length) {
      const sub = (a: string[], b: string[]) =>
        a.length < b.length &&
        b.some((_, i) => a.every((w, k) => b[i + k] === w));
      const partial = pool.filter(
        (d) =>
          d.geo.length > 2 &&
          (sub(d.tokens, dqTokens) || sub(dqTokens, d.tokens)) &&
          // Viloyat nomli tuman ("Andijon") qism-moslikda ishtirok etmaydi.
          !d.regionNamed,
      );
      if (partial.length) {
        matches = partial;
        candidateOnly = true;
      }
    }
  }

  // PLACE-SIGNAL (BeePost :1596-1601): "tuman/shahar" so'zi yoki
  // district_name bo'lmasa — oddiy ko'cha so'zi jimgina TUMANga aylanmaydi.
  const placeText = `${q.full_address}, ${q.address}`;
  // r16: jo'natish joyining belgisi ("jo'natuvchi: Kasbi tumani", "из г.
  // Касби") joy belgisi emas - 2b'da ham (r15 da faqat 4-usulda edi).
  const strictPlaceSignal =
    !!q.district_name ||
    PLACE_STRICT_RE.test(stripOriginClauses(destNorm(placeText)));
  /** r16: jo'natish joyi bilan birga (faqat yagona aniq nom uchun, 2b). */
  const strictWithOrigin =
    strictPlaceSignal || PLACE_STRICT_RE.test(destNorm(placeText));
  /**
   * r15/r16: 4-usul uchun - jo'natish joyi va mo'ljal bo'laklarisiz
   * ("Gulzor ko'chasi 1, Шават р-н рядом").
   */
  const strictNoOrigin =
    !!q.district_name ||
    PLACE_STRICT_RE.test(stripNonDestClauses(destNorm(placeText)));
  /**
   * r12: 2b zaif moslik uchun PR'dagi yangi belgilar. "Y tumanida/tum." -
   * faqat Y topilgan nom bo'lsa. "Y t." - Y topilgan nom yoki qidiruv
   * havzasidan TASHQARIDAGI nom (boshqa viloyat - ism bo'lishi mumkin, S2,
   * avvalgidek belgi). Havzadagi, lekin topilmagan tuman ("Yangiyer t." -
   * bazada "Yangier", "Do'stlik T." - "Dustlik", "Djizak t." - alias) - belgi
   * o'sha tumanniki: yalang'och "Navoiy"/"Sirdaryo" avto emas (dev kabi).
   */
  const poolInfo = poolInfoOf(idx, pool);
  /** Havzadagi barcha nom boshlari (`headsOf(pool)`), havza uchun keshda. */
  const poolHeads = (): ReadonlySet<string> =>
    (poolInfo.heads ??= headsOf(pool));
  const placeSignalFor = (
    list: readonly PreparedDistrict[],
    strict = strictPlaceSignal,
  ): 'strict' | 'own' | 'outside' | 'capOwn' | 'capOutside' | null => {
    if (strict) return 'strict';
    const heads = headsOf(list);
    if (suffixFor(placeText, heads)) return 'own';
    const outside = poolHeads();
    // r14 (S1): faqat katta "T." bilan ("Gulistan T.", "Sherin Т.") - ism
    // bosh harfi bo'lishi mumkin: alohida (zaif) belgi, avto emas.
    let capOwn = false;
    let capOutside = false;
    const own = namedT(placeText, TUMAN_T_ABBR_RE, (w, cap) => {
      if (!heads.has(w)) return false;
      if (cap) capOwn = true;
      return !cap;
    });
    if (own) return 'own';
    const out = namedT(placeText, TUMAN_T_ABBR_RE, (w, cap) => {
      if (outside.has(w)) return false;
      if (cap) capOutside = true;
      return !cap;
    });
    if (out) return 'outside';
    if (capOwn) return 'capOwn';
    return capOutside ? 'capOutside' : null;
  };
  /**
   * r13: manzilda matcher ko'rmaydigan BOSHQA joy nomi bormi - qidiruv
   * havzasida aynan yo'q, lekin `geoFold` bilan biror tumanga (alias, rasmiy
   * nom) fuzzy yaqin so'z: "Карши" (Qarshi), "Термез t." (Termiz), "Денау"
   * (Denov), "Yangiyer" (bazada Yangier). Uy raqamli / ko'cha / viloyat /
   * jo'natish joyi ("...dan") so'zi, `own` nomlari va ko'p so'zli nom
   * qismlari ("Rashidov T.", "Ulug'bek T." - ism) raqib EMAS.
   */
  const hiddenRival = (
    infos: readonly AddressTokens[],
    own: readonly PreparedDistrict[],
    opts: {
      hasOrigin: boolean;
      devMarkedOnly?: boolean;
      skipAbbr?: boolean;
      /** "Самарканд, Ургут т." - `leadRegion(li, j)`: j'dan "X t." viloyati. */
      leadRegion?: (li: number, j: number) => string | null;
    },
  ): boolean => {
    const { skels: poolSkels, ids: poolIds } = poolInfo;
    const ownIds = new Set(own.map((d) => d.id));
    const ownFolds = new Set([...headsOf(own)].map(foldOf));
    for (let li = 0; li < infos.length; li++) {
      const { tokens, sepBefore } = infos[li];
      for (let i = 0; i < tokens.length; i++) {
        if (STREET_BEFORE_WORDS.has(tokens[i - 1] ?? '') && !sepBefore.has(i)) {
          continue;
        }
        // 1-2 so'zli nom ("Мирзо Улугбек"); bir harfli token (bosh harf,
        // "t", "g") - nom emas.
        for (let k = 1; k <= 2 && i + k <= tokens.length; k++) {
          const last = tokens[i + k - 1];
          if (
            HIDDEN_SKIP_WORDS.has(last) ||
            /^\d/.test(last) ||
            last.length < 2
          ) {
            break;
          }
          if (k > 1 && sepBefore.has(i + k - 1)) break;
          const w = k > 1 ? tokens[i] + last : last;
          if (w.length < 4 || poolSkels.has(w)) continue;
          if (AMBIGUOUS_REGION_WORDS.has(w)) continue;
          if (opts.hasOrigin && REGION_BASE_SKELS.has(w)) continue;
          // r14 (B2): "из г. X", "с г. X" - jo'natish joyi, raqib emas.
          if (
            ruOriginAt(tokens, i, sepBefore) ||
            senderAt(tokens, i, sepBefore)
          ) {
            break;
          }
          // Vergul bilan ajralgan keyingi so'z bu nomga tegishli emas.
          const joined = !sepBefore.has(i + k);
          const next = joined ? (tokens[i + k] ?? '') : '';
          const afterNext = tokens[i + k + 1];
          // S2: havzadan tashqaridagi "Name T." (ism bo'lishi mumkin) - raqib
          // emas; havzadagi tumanga yaqin "W t." esa raqib.
          const outsideOnly =
            !!opts.skipAbbr &&
            next === 'tumani' &&
            afterNext === TUMAN_T_ABBR_TOKEN;
          if (
            houseNumberAt(tokens, i + k, sepBefore) ||
            (STREET_AFTER_WORDS.has(next) &&
              (next !== 'ul' ||
                afterNext === undefined ||
                /^(?:no?)?\d/.test(afterNext) ||
                UL_HOUSE_WORDS.has(afterNext))) ||
            REGION_AFTER_WORDS.has(next) ||
            ORIGIN_AFTER_WORDS.has(next) ||
            (PLACE_AFTER_WORDS.has(next) && afterNext === 'dan')
          ) {
            continue;
          }
          // dev belgisi (yangi "t." / "tumaniga" emas): "W sh.", "W tumani",
          // "W r-n", "g. W", "р-н W".
          const devMark =
            (PLACE_AFTER_WORDS.has(next) &&
              !NEW_TUMAN_AFTER_WORDS.has(next) &&
              !(next === 'tumani' && afterNext === TUMAN_T_ABBR_TOKEN)) ||
            (next === 'r' && afterNext === 'n') ||
            (!sepBefore.has(i) &&
              ['g', 'gorod', 'rayon', 'raion'].includes(tokens[i - 1] ?? '')) ||
            (!sepBefore.has(i) &&
              tokens[i - 1] === 'n' &&
              tokens[i - 2] === 'r');
          if (opts.devMarkedOnly && !devMark) continue;
          const f = foldOf(w);
          if (ownFolds.has(f) || idx.nameParts.has(f)) continue;
          // Ikki so'zli oyna - qat'iyroq (tasodifiy qo'shilish emas).
          const min = k > 1 ? GEO_SUBSTRING_MIN : GEO_FUZZY_MIN;
          // r14 (S5): `min` dan o'xshash shakllar snapshot keshidan.
          const hits = rivalHitsFor(idx, f, min);
          if (!hits.length) continue;
          // Topilgan nomning o'zi boshqa shaklda ("Каршинский р-н" ->
          // "karshin" ~ Karshi) - raqib faqat boshqa tumanga YAQINROQ bo'lsa.
          let ownSim = 0;
          for (const g of ownFolds) ownSim = Math.max(ownSim, simRatio(f, g));
          // Viloyat konteksti ("Самарканд, Ургут т., ...") - shu viloyatning
          // viloyat nomli tumani raqib emas.
          const lead =
            i === 0 && sepBefore.has(k)
              ? (opts.leadRegion?.(li, k) ?? null)
              : null;
          for (const { id, region, regionNamed, sim } of hits) {
            if (ownIds.has(id)) continue;
            if (outsideOnly && !poolIds.has(id)) continue;
            if (lead && regionNamed && region === lead) continue;
            if (sim > ownSim) return true;
          }
        }
      }
    }
    return false;
  };
  let forceCandidate = false;

  /** Viloyat nomli tuman boshqa topilgan tumandan KEYIN; eng uzun nom. */
  const longestNonRegion = (found: PreparedDistrict[]) => {
    const nonRegion = found.filter((d) => !d.regionNamed);
    const ranked = (nonRegion.length ? nonRegion : found).sort(
      (a, b) => b.geo.length - a.geo.length,
    );
    const maxLen = ranked[0].geo.length;
    return ranked.filter((d) => d.geo.length === maxLen);
  };

  /** r13: shu viloyatda o'xshash nomli BOSHQA turdagi qator bormi (R1). */
  const hasKindTwin = (d: PreparedDistrict): boolean =>
    (idx.districtsByRegion.get(d.region_id) ?? []).some(
      (s) =>
        s.id !== d.id &&
        s.kind !== d.kind &&
        simRatio(s.geo, d.geo) >= GEO_SUBSTRING_MIN,
    );

  // 2a-usul (BeePost :1603-1623): tuman SO'ROVI ichida butun so'z bilan.
  // ⚠️ Elchi: viloyat nomli tuman boshqa topilgan tumandan KEYIN. Aks holda
  // "eng uzun nom" qoidasi bilan "Toshkent Olmazor tumani" → "Toshkent
  // tumani" (1727, BOSHQA viloyat) tanlanardi.
  if (!matches.length && dq) {
    const padded = ` ${dq} `;
    const found = pool.filter(
      (d) => d.geo.length >= 4 && padded.includes(` ${d.geo} `),
    );
    if (found.length) {
      matches = longestNonRegion(found);
      stage = 'word';
    }
  }

  // 3-usul (BeePost :1625-1643): imlo xatosi — simRatio >= GEO_FUZZY_MIN
  // (qoidaviy variantlar bilan eng yaxshisi), g'olibdan GEO_FUZZY_NEAR_DELTA
  // ichidagilar nomzod. D2: manzil korpusidan OLDIN — operator yozgan
  // tuman nomi manzildagi ko'cha nomidan ustun.
  if (!matches.length && dq.length >= 3) {
    const variants = [...geoSpellingVariants(dqSkel)].slice(0, 64);
    const score = (d: PreparedDistrict) =>
      Math.max(
        simRatio(d.geo, dq),
        ...variants.map((v) => simRatio(d.skel, v)),
      );
    const scored = pool
      .map((d) => ({ d, s: score(d) }))
      .filter((x) => x.s >= GEO_FUZZY_MIN)
      .sort((a, b) => b.s - a.s);
    if (scored.length) {
      const fuzzyTop = scored[0].s;
      matches = scored
        .filter((x) => fuzzyTop - x.s < GEO_FUZZY_NEAR_DELTA)
        .slice(0, AI_MAX_CANDIDATES)
        .map((x) => x.d);
      viaFuzzy = true;
      stage = 'fuzzy';
      stageScore = fuzzyTop;
    }
  }

  // D4: Toshkent shahri (1726) va viloyati (1727) ANIQ moslik uchun bitta
  // havza — operatorlar ularni aralashtiradi ("Toshkent shahri Qibray",
  // "Toshkent viloyati Yunusobod"). Faqat nom/skelet/alias (fuzzy emas).
  // ⚠️ Boshqa viloyatlar uchun qulf SAQLANADI (checklist #1: "Toshkent
  // shahri Xonobod" — Andijon nomzodi ko'rsatilmaydi).
  if (
    !matches.length &&
    lockedRegion &&
    dq &&
    isTashkentSato(lockedRegion.sato)
  ) {
    const outside = idx.districts.filter(
      (d) =>
        d.region_id !== lockedRegion.id &&
        // Viloyat nomli tuman ("Toshkent tumani") faqat tur ANIQ yozilganda:
        // "Toshkent shahri" + "Toshkent tumani" → 1727265; yalang'och
        // "Toshkent" esa avvalgidek topilmaydi (#646 review, round 2).
        (!d.regionNamed || kindOf(q.district_name) === d.kind) &&
        isTashkentSato(idx.regionById.get(d.region_id)?.sato),
    );
    matches = exactIn(outside).found.slice(0, AI_MAX_CANDIDATES);
  }

  // P1-7: viloyat matnda AYTILMAGAN (AI tumandan chiqargan) va qulflangan
  // viloyatda yo'q — boshqa viloyatdan ANIQ nom/skelet/alias (variant emas)
  // moslik. Avto-tanlov, lekin `match.region_switched` (preview
  // `district_low_confidence`). Viloyat matnda berilgan bo'lsa — qulf.
  if (!matches.length && lockedRegion && dq && q.region_inferred) {
    const outside = idx.districts.filter(
      (d) => d.region_id !== lockedRegion.id,
    );
    const cross = exactIn(outside);
    if (cross.found.length && !cross.variant) {
      matches = cross.found.slice(0, AI_MAX_CANDIDATES);
      regionSwitched = true;
    }
  }

  const addressTexts = [q.address, q.full_address].filter(Boolean);
  const tokenInfos = addressTexts.map(addressTokens);
  /** r13: 2b ziddiyati - 4-usul topmasa shu nomzodlar. */
  let deferred: PreparedDistrict[] = [];
  /** r15: 2b'da faqat jo'natish joyi sifatida uchragan nomlar (4-usulda ham). */
  const originIds = new Set<string>();
  /** r14 (S2): 2b'da mo'ljal sifatida topilgan nomlar (4-usulda raqib emas). */
  let landmarkList: PreparedDistrict[] = [];
  /**
   * r13: manzilda tilga olingan viloyatlar (asos so'zi, ko'cha nomi emas):
   * "Toshkent, ..., Ширин-T." - Shirin (Sirdaryo) bu viloyatda emas.
   */
  const mentionedRegions = new Set<string>();
  /**
   * r17: shahar belgili viloyat so'zi ("Buxoro sh.", "Toshkent sh" - faqat
   * Toshkent SHAHRI, 1726) - jo'natish joyi qoidasi uchun.
   */
  const cityMarkedRegions = new Set<string>();
  /**
   * r13: belgisiz yalang'och "Toshkent" o'rinlari (2b'da tuman sifatida
   * tanlanmaydi) - yangi belgili tuman uchun yalang'och raqib nom kabi.
   */
  const bareTashkent: { li: number; end: number; lead: boolean }[] = [];
  tokenInfos.forEach(({ tokens, sepBefore }, li) => {
    tokens.forEach((t, j) => {
      const next = sepBefore.has(j + 1) ? '' : (tokens[j + 1] ?? '');
      const prev = sepBefore.has(j) ? '' : (tokens[j - 1] ?? '');
      let satos = REGION_SATOS_BY_SKEL.get(t);
      if (!satos && REGION_AFTER_WORDS.has(next) && t.length >= 4) {
        const s = regionAlias(`${t} ${next}`);
        if (s) satos = new Set([s]);
      }
      if (!satos) return;
      if (CITY_AFTER_WORDS.has(next)) {
        const city = [...satos].filter((x) => x === '1726');
        for (const x of city.length ? city : satos) cityMarkedRegions.add(x);
      }
      if (
        (PLACE_AFTER_WORDS.has(next) && next !== 'sh' && next !== 'g') ||
        (next === 'r' && tokens[j + 2] === 'n')
      ) {
        return;
      }
      if (STREET_AFTER_WORDS.has(next) || STREET_BEFORE_WORDS.has(prev)) return;
      if (houseNumberAt(tokens, j + 1, sepBefore)) return;
      for (const s of satos) mentionedRegions.add(s);
      if (
        AMBIGUOUS_REGION_WORDS.has(t) &&
        !PLACE_AFTER_WORDS.has(next) &&
        !REGION_AFTER_WORDS.has(next) &&
        !(next === 'r' && tokens[j + 2] === 'n') &&
        !kindBefore(tokens, j, sepBefore)
      ) {
        bareTashkent.push({
          li,
          end: j + 1,
          lead: j === 0 && sepBefore.has(j + 1),
        });
      }
    });
  });
  /** r13: matnda jo'natish joyi bor ("X tumanidan", "X tumani dan"). */
  const originInText = tokenInfos.some(({ tokens }) =>
    tokens.some(
      (t, j) =>
        ORIGIN_AFTER_WORDS.has(t) ||
        (PLACE_AFTER_WORDS.has(t) && tokens[j + 1] === 'dan'),
    ),
  );
  /**
   * r13: manzilda dev belgili ("W tumani", "W sh.", "р-н W") BOSHQA ma'lum
   * nom bormi - aniq belgi o'sha tumanniki ("So'x tumani, Navoiy 5,
   * Furqat-T.", "Pop tumani, ..., Do'stlik T. 90...").
   */
  const devOtherName = (list: readonly PreparedDistrict[]): boolean =>
    explicitOtherName(
      tokenInfos.map((t) => t.tokens),
      tHeads,
      headsOf(list),
      poolHeads(),
      new Set<string>(),
      true,
    );
  /**
   * r13: zaif moslik / 4-usul belgisi. Belgi aniq dev so'zi ("tumani",
   * "sh.") bo'lsa - matcher ko'rmaydigan boshqa BELGILI nom ("Янгикурган
   * gorod") bo'lmasin; PR'dagi yangi belgi (topilgan nomning "X t." /
   * "X tumanida") - hech qanday yashirin joy nomi bo'lmasin; havzadan
   * tashqaridagi "Name T." (S2) - havzadagi yashirin nom bo'lmasin.
   */
  const weakSignal = (
    list: readonly PreparedDistrict[],
    allowOutside: boolean,
    /** r14 (S2): mo'ljal nomlari - raqib emas (belgisi ularniki). */
    landmarks: readonly PreparedDistrict[] = [],
    strict = strictPlaceSignal,
  ): 'ok' | 'none' | 'rival' | 'soft' => {
    const signal = placeSignalFor(list, strict);
    const outsideSignal = signal === 'outside' || signal === 'capOutside';
    if (!signal || (outsideSignal && !allowOutside)) return 'none';
    const own = landmarks.length ? [...list, ...landmarks] : list;
    if (signal === 'strict' && devOtherName(own)) return 'rival';
    if (
      hiddenRival(tokenInfos, own, {
        hasOrigin: originInText,
        devMarkedOnly: signal === 'strict',
        skipAbbr: outsideSignal,
      })
    ) {
      return 'rival';
    }
    // r14 (S1): faqat katta "T." belgisi - nomzod (avto emas).
    return signal === 'capOwn' || signal === 'capOutside' ? 'soft' : 'ok';
  };
  // 2b-usul: MANZIL korpusidan butun so'z bilan. D2: nomdan keyin
  // ko'cha/mahalla so'zi kelsa (yoki oldidan "ул.") — RAD; "tumani/shahri"
  // kelsa — kuchli; boshqa holatda operator tuman yozgan bo'lsa faqat nomzod.
  // full_address ham (alohida matn sifatida): "Andijon shahri, Bo'ston
  // ko'chasi" — Bo'ston RAD, "Andijon shahri" kuchli.
  if (!matches.length && addressTexts.length) {
    const tokenLists = tokenInfos.map((t) => t.tokens);
    // Rus yozuvi varianti ("Юнусабадский район" → yunusabad → yunusobod):
    // faqat KUCHLI holatda (keyin "rayon/tumani/shahri") qabul qilinadi.
    const variantCache = new Map<string, Set<string>>();
    const variantsOf = (t: string): Set<string> => {
      let v = variantCache.get(t);
      if (!v) {
        v = t.length >= 4 ? geoSpellingVariants(t) : new Set([t]);
        variantCache.set(t, v);
      }
      return v;
    };
    const strong: PreparedDistrict[] = [];
    const weak: PreparedDistrict[] = [];
    const softTumanT = new Set<string>();
    const exactPoolSkels = poolInfo.skels;
    // r12: PR'dagi yangi belgi ("X t.", "X tumaniga/tumanida/tum.") bilan
    // kuchli tumanning manzildagi so'zi; `devMarked` - dev belgisi bilan.
    const newMarkWord = new Map<string, string>();
    const devMarked = new Set<string>();
    // r12: "X tumanidan / tum-dan / tumani dan" - jo'natish joyi (r7 S3).
    const originMarked = originIds;
    // r12: uy raqamisiz yalang'och moslik ("Qarshi, ..."; "Navoiy 5" emas).
    const plainWeak = new Set<string>();
    // r13: qoidaviy variantsiz (dev ham ko'radigan) moslik.
    const exactSeen = new Set<string>();
    // r14 (B2): faqat geoFold bilan topilgan (dev ko'rmagan yozuv) nomlar.
    const foldSeen = new Set<string>();
    const nonFoldSeen = new Set<string>();
    // r14 (S2): mo'ljal sifatida tilga olingan nomlar (`landmarkAt`).
    const landmarkMarked = new Map<string, PreparedDistrict>();
    // r14 (S1): kuchli belgi faqat katta "T." dan (`capMarked`) yoki boshqa
    // belgidan ham (`firmMarked`).
    const capMarked = new Set<string>();
    const firmMarked = new Set<string>();
    // r13: yalang'och moslik o'rinlari va "X t." moslik boshlanishi.
    const plainAt = new Map<
      string,
      { li: number; i: number; end: number; sep: boolean }[]
    >();
    const abbrAt = new Map<string, { d: PreparedDistrict; last: string }>();
    // r14 (S5): oynalar (2-3 so'z birikmasi, `geoFold` -> tuman id'lari)
    // so'rov uchun BIR MARTA - har tuman uchun qayta yig'ilmaydi. Hech bir
    // oynaga tushmaydigan tuman (birinchi so'zi, birikmasi, qoidaviy varianti
    // yoki fold'i yo'q) umuman aylanmaydi - natija o'zgarmaydi.
    const firstTokens = new Set<string>();
    const joinedSkels = new Set<string>();
    const variantSkels = new Set<string>();
    const foldIds = new Set<string>();
    const windows = tokenInfos.map(({ tokens, sepBefore }) =>
      tokens.map((t, i) => {
        firstTokens.add(t);
        for (const v of variantsOf(t)) variantSkels.add(v);
        const join2 = i + 2 <= tokens.length ? t + tokens[i + 1] : null;
        const join3 =
          join2 !== null && i + 3 <= tokens.length
            ? join2 + tokens[i + 2]
            : null;
        if (join2 !== null) joinedSkels.add(join2);
        if (join3 !== null) joinedSkels.add(join3);
        // r13: `geoFold` tengligi ("Термез", "Ургенч", "Yangiyer", "Навои")
        // - qoidaviy variant kabi, faqat belgi bilan. Havzadagi boshqa
        // tumanning aniq nomi ("Qarshi" - Karshi emas) va viloyat asos
        // so'zi ("Syrdarya t.", r11 B2) bundan mustasno.
        const fold: (ReadonlySet<string> | undefined)[] = [];
        for (let k = 1; k <= 2 && i + k <= tokens.length; k++) {
          if (k > 1 && sepBefore.has(i + k - 1)) break;
          const w = k > 1 ? (join2 ?? '') : t;
          if (exactPoolSkels.has(w) || REGION_BASE_SKELS.has(w)) continue;
          const f = foldOf(w);
          if (COUNTRY_FOLDS.has(f) || f.length < 4) continue;
          const ids = idx.idsByFold.get(f);
          fold[k - 1] = ids;
          for (const id of ids ?? []) foldIds.add(id);
        }
        return { join2, join3, fold };
      }),
    );
    for (const d of pool) {
      if (d.geo.length < 4 || !d.tokens.length) continue;
      if (
        !firstTokens.has(d.tokens[0]) &&
        !joinedSkels.has(d.skel) &&
        !variantSkels.has(d.skel) &&
        !foldIds.has(d.id)
      ) {
        continue;
      }
      let best: 'strong' | 'weak' | null = null;
      for (let li = 0; li < tokenInfos.length; li++) {
        const { tokens, sepBefore } = tokenInfos[li];
        for (let i = 0; i < tokens.length; i++) {
          let len = 0;
          let viaVariant = false;
          let viaFold = false;
          const win = windows[li][i];
          if (d.tokens.every((w, k) => tokens[i + k] === w))
            len = d.tokens.length;
          else if (win.join2 === d.skel) len = 2;
          else if (win.join3 === d.skel) len = 3;
          if (
            !len &&
            tokens[i] !== d.skel &&
            variantsOf(tokens[i]).has(d.skel)
          ) {
            len = 1;
            viaVariant = true;
          }
          for (let k = 1; !len && k <= 2; k++) {
            if (win.fold[k - 1]?.has(d.id)) {
              len = k;
              viaVariant = true;
              viaFold = true;
            }
          }
          if (!len) continue;
          // r13: vergul / nuqtali verguldan keyingi so'z bu nomning belgisi
          // emas ("Namangan, г. Туракурган" - "г." Turakurgan'niki).
          const next = sepBefore.has(i + len) ? '' : (tokens[i + len] ?? '');
          const prev = tokens[i - 1] ?? '';
          // Rus tartibi — belgi nomdan OLDIN: "г. Termiz", "р-н Shahrisabz"
          // (#646 review round 2). r13: vergul orqali emas ("Farg'ona
          // rayon, Quva" - "rayon" Farg'ona'niki).
          const prevKind = kindBefore(tokens, i, sepBefore);
          if (
            viaVariant &&
            !(
              PLACE_AFTER_WORDS.has(next) ||
              (next === 'r' && tokens[i + len + 1] === 'n') ||
              // r13: "р-н Фуркат" (Furqat) - belgi nomdan OLDIN.
              prevKind
            )
          ) {
            continue;
          }
          // Yalang'och "Toshkent" (1726 ham, 1727 ham) — "Toshkent tumani"
          // (1727) uchun dalil faqat ANIQ tuman belgisi bilan: keyin
          // "tumani/t./r-n" yoki oldidan "р-н/rayon". "Toshkent shahri/sh.",
          // "Toshkent shahrida", "g. Toshkent", "Toshkent, Mirobod" — bu
          // VILOYAT (#646 review B1, r4 NEW-B2).
          if (
            d.regionNamed &&
            AMBIGUOUS_REGION_WORDS.has(d.geo) &&
            d.kind !== 'city' &&
            !tumanMarkerAt(tokens, i + len) &&
            kindBefore(tokens, i, sepBefore) !== 'tuman'
          ) {
            // "Toshkent t. Keles" — "t." keyin vergulsiz: tuman belgisi
            // ham, ism bosh harfi ("T. Malik") ham bo'lishi mumkin — faqat
            // NOMZOD (dev bilan bir xil), hech qachon avto emas (r6).
            if (next === 't') {
              softTumanT.add(d.id);
              best = best ?? 'weak';
            }
            continue;
          }
          // part of a longer district name ("Yuqori Chirchiq")
          if (
            (prev && allSkels.has(prev + d.skel)) ||
            (next && allSkels.has(d.skel + next))
          )
            continue;
          // "Sergeli ul. 12" / "Olmazor ul. d. 5" — ko'cha; "Chilonzor ul.
          // Bunyodkor 5" — "ul." keyingi nomga tegishli (r4 S1, r6).
          const afterUl = tokens[i + len + 1];
          const streetAfter =
            STREET_AFTER_WORDS.has(next) &&
            (next !== 'ul' ||
              afterUl === undefined ||
              // "12", "no5", "n5", "№12" (→ "no 12")
              /^(?:no?)?\d/.test(afterUl) ||
              UL_HOUSE_WORDS.has(afterUl));
          if (
            streetAfter ||
            STREET_BEFORE_WORDS.has(prev) ||
            // "Andijon viloyati ..." — bu VILOYAT, tuman emas.
            REGION_AFTER_WORDS.has(next)
          ) {
            if (!AREA_AFTER_WORDS.has(next) && !REGION_AFTER_WORDS.has(next))
              streetRejected.add(d.id);
            continue;
          }
          if (!viaVariant) exactSeen.add(d.id);
          const afterMark =
            PLACE_AFTER_WORDS.has(next) ||
            (next === 'r' && tokens[i + len + 1] === 'n');
          if (viaFold || (viaVariant && !afterMark)) foldSeen.add(d.id);
          else nonFoldSeen.add(d.id);
          // r14 (B2): rus old qo'shimchasi - "из г. X", "с г. X", "рядом с г.
          // X", "отправитель: г. X" - jo'natish joyi / mo'ljal, yetkazish
          // belgisi emas.
          if (
            ruOriginAt(tokens, i, sepBefore) ||
            senderAt(tokens, i, sepBefore)
          ) {
            originMarked.add(d.id);
            continue;
          }
          // r14 (S2): mo'ljal ("X tumaniga burilishda", "mo'ljal: X tumani")
          // - yetkazish manzili emas; boshqa nom bo'lmasa faqat nomzod.
          if (landmarkAt(tokens, i, i + len, sepBefore)) {
            landmarkMarked.set(d.id, d);
            continue;
          }
          const isRn = next === 'r' && tokens[i + len + 1] === 'n';
          // r12: "X tum-dan", "X tumani dan" ("tumanidan" ajratib yozilgan,
          // "...dan kelgan") - yetkazish belgisi EMAS (r7 S3 bilan bir xil).
          const fromPlace =
            PLACE_AFTER_WORDS.has(next) && tokens[i + len + 1] === 'dan';
          if (fromPlace || ORIGIN_AFTER_WORDS.has(next)) originMarked.add(d.id);
          if (!fromPlace && (PLACE_AFTER_WORDS.has(next) || isRn)) {
            const viaAbbr =
              next === 'tumani' && tokens[i + len + 1] === TUMAN_T_ABBR_TOKEN;
            // r14 (S1): katta "T." ("Gulistan T.") - zaif belgi: tur yo'q.
            const capAbbr = viaAbbr && capNames.has(tokens[i + len - 1]);
            if (viaAbbr) {
              abbrAt.set(`${li}:${i}`, { d, last: tokens[i + len - 1] });
            }
            if (viaAbbr || NEW_TUMAN_AFTER_WORDS.has(next)) {
              if (!newMarkWord.has(d.id))
                newMarkWord.set(d.id, tokens.slice(i, i + len).join(''));
            } else devMarked.add(d.id);
            best = 'strong';
            if (capAbbr) capMarked.add(d.id);
            else {
              firmMarked.add(d.id);
              addressKind.set(
                d.id,
                CITY_AFTER_WORDS.has(next) ? 'city' : 'tuman',
              );
            }
            if (viaAbbr) continue;
            break;
          }
          // Rus tartibi — belgi nomdan OLDIN (tur kind_mismatch'ga yetib
          // borsin).
          if (prevKind) {
            best = 'strong';
            firmMarked.add(d.id);
            devMarked.add(d.id);
            addressKind.set(d.id, prevKind);
            break;
          }
          // "X t." dan keyin davom etilgan bo'lsa - kuchli saqlanadi (r11).
          if (best !== 'strong') best = 'weak';
          if (!houseNumberAt(tokens, i + len, sepBefore)) {
            plainWeak.add(d.id);
            const occ = plainAt.get(d.id) ?? [];
            occ.push({ li, i, end: i + len, sep: sepBefore.has(i + len) });
            plainAt.set(d.id, occ);
          }
        }
        if (best === 'strong') break;
      }
      if (best === 'strong') strong.push(d);
      else if (best === 'weak') weak.push(d);
    }
    if (strong.length || weak.length) stage = 'address';
    // r15 (S1): katta "X T." nom bo'yicha qabul qilinadi (r14 da hech qachon
    // emas edi) - agar X keng tarqalgan ism emas (`PERSON_NAME_FOLDS`), oldida
    // oluvchi so'zi yo'q (`dropRecipientInitials` olib tashlagan) va matnda
    // boshqa yalang'och joy nomi yo'q bo'lsa: "Kasbi T., Navoiy 5" - avto,
    // "Furqat T., Navoiy 5" / "Qarshi, Navoiy 5, Kasbi T." - nomzod.
    const acceptedCap = new Set<string>();
    /**
     * r16: 2b qidiruvi 4 harfdan qisqa nomlarni ko'rmaydi ("Pop", "So'x") -
     * yalang'och shunday nom ham boshqa joy nomi ("Мингбулак T., Pop, ...").
     */
    let shortBare: boolean | null = null;
    const shortBareName = (): boolean => {
      if (shortBare !== null) return shortBare;
      const shortSkels = new Set(
        pool
          .filter((o) => o.skel.length >= 2 && o.skel.length < 4)
          .map((o) => o.skel),
      );
      shortBare = tokenInfos.some(({ tokens, sepBefore }) =>
        tokens.some((t, j) => {
          if (!shortSkels.has(t)) return false;
          const next = sepBefore.has(j + 1) ? '' : (tokens[j + 1] ?? '');
          return (
            !STREET_AFTER_WORDS.has(next) &&
            !STREET_BEFORE_WORDS.has(
              sepBefore.has(j) ? '' : (tokens[j - 1] ?? ''),
            ) &&
            !houseNumberAt(tokens, j + 1, sepBefore) &&
            !(next === 'tumani' && tokens[j + 2] === TUMAN_T_ABBR_TOKEN)
          );
        }),
      );
      return shortBare;
    };
    for (const d of strong) {
      if (!capMarked.has(d.id) || firmMarked.has(d.id)) continue;
      const word = newMarkWord.get(d.id) ?? d.skel;
      const lasts = [...abbrAt.values()]
        .filter((a) => a.d === d)
        .map((a) => a.last);
      if (
        PERSON_NAME_FOLDS.has(foldOf(word)) ||
        lasts.some((l) => PERSON_NAME_FOLDS.has(foldOf(l)))
      ) {
        continue;
      }
      const otherBare =
        [...strong, ...weak].some(
          (o) =>
            o !== d &&
            !o.regionNamed &&
            plainWeak.has(o.id) &&
            !originMarked.has(o.id),
        ) || shortBareName();
      if (otherBare) continue;
      firmMarked.add(d.id);
      addressKind.set(d.id, 'tuman');
      for (const l of lasts) {
        capNames.delete(l);
        acceptedCap.add(l);
      }
    }
    const landmarks = [...landmarkMarked.values()].filter(
      (d) => !strong.includes(d) && !weak.includes(d),
    );
    // r12: yalang'och raqib nom - jo'natish joyi ("X tumanidan") va uy raqamli
    // ko'cha ("Navoiy 5") emas. Matnda jo'natish joyi bo'lsa ("...dan Y
    // tumaniga" - Y manzil), viloyat nomli so'z ("Sirdaryo, Guliston shahridan
    // Boyovut tumaniga") raqib emas.
    const bareRival = (d: PreparedDistrict): boolean =>
      plainWeak.has(d.id) &&
      !originMarked.has(d.id) &&
      (!d.regionNamed || (!originMarked.size && !originInText));
    /**
     * r13: "Samarqand, Urgut t., Navoiy 5" - maydon boshidagi viloyat nomli
     * yalang'och so'z, vergul va darhol shu viloyatdagi KICHIK "t." bilan
     * yozilgan tuman - viloyat konteksti, raqib emas. "Navoiy, Navoiy
     * ko'chasi 5, oluvchi Navbahor T." (orada ko'cha, katta "T.") - raqib.
     */
    const lowerAbbr = lowerAbbrNames(addressTexts.join(', '));
    // r16: viloyat konteksti ("Samarqand, Urgut T., ...") - qabul qilingan
    // katta "X T." ham kichik "t." kabi.
    const leadAbbr = new Set([...lowerAbbr, ...acceptedCap]);
    const regionLead = (d: PreparedDistrict): boolean => {
      const occ = plainAt.get(d.id) ?? [];
      return (
        d.regionNamed &&
        occ.length > 0 &&
        occ.every((o) => {
          const a = abbrAt.get(`${o.li}:${o.end}`);
          return (
            o.i === 0 &&
            o.sep &&
            !!a &&
            a.d.region_id === d.region_id &&
            leadAbbr.has(a.last)
          );
        })
      );
    };
    // r12: faqat yangi belgilar bilan kuchli IKKI xil nom ("Qarshi t., ...,
    // Muborak T.", "Qarshi tumaniga Kasbi tumaniga") - eng uzun nom emas,
    // hammasi nomzod (dev'da ular belgi emas edi).
    const newOnlyWords = new Set<string>();
    for (const d of strong) {
      const w = newMarkWord.get(d.id);
      if (w !== undefined && !devMarked.has(d.id)) newOnlyWords.add(w);
    }
    if (strong.some((d) => devMarked.has(d.id))) {
      // r12: dev belgisi ("Kasbi tumani") yangi qo'shimchali belgidan
      // ("Muborak tumaniga" - ko'pincha mo'ljal) ustun - dev bilan bir xil.
      // r13: "X t." / "Name T." ham ("Qarshi sh., Navoiy 5, Muborak T.",
      // "Yangier sh., ..., oluvchi Shirin T.") - aniq belgili tuman, dev kabi.
      const foldOnly = (d: PreparedDistrict) =>
        foldSeen.has(d.id) && !nonFoldSeen.has(d.id);
      const dm = strong.filter((d) => devMarked.has(d.id));
      const dmVisible = dm.filter((d) => !foldOnly(d));
      if (dmVisible.length && dmVisible.length < dm.length) {
        // dev ko'rgan aniq belgili nom bor - dev tanlovi (fold-only raqib emas).
        matches = longestNonRegion(dmVisible);
      } else if (
        !dmVisible.length &&
        ([...strong, ...weak].some(
          (d) =>
            !foldOnly(d) &&
            !dm.includes(d) &&
            !d.regionNamed &&
            !originMarked.has(d.id) &&
            plainWeak.has(d.id),
        ) ||
          (mentionedRegions.size > 0 &&
            dm.some((d) => {
              const sato = idx.regionById.get(d.region_id)?.sato;
              return !!sato && !mentionedRegions.has(sato);
            })))
      ) {
        // fold-only belgili nom + dev ko'rgan boshqa asosiy nom yoki boshqa
        // viloyat - nomzod (dev bu nomni ko'rmasdi).
        matches = [...dm, ...strong, ...weak].slice(0, AI_MAX_CANDIDATES);
        candidateOnly = true;
      } else {
        matches = longestNonRegion(dm);
      }
    } else if (strong.length) {
      // Faqat PR'dagi yangi belgilar ("X t.", "Y tumaniga/tumanida/tum.").
      // Raqib bo'lsa - hammasi nomzod (dev'da ular belgi emas edi):
      //  - ikki xil yangi belgili nom (r12 C5);
      //  - yalang'och raqib nom ("Qarshi, Navoiy 5, Kasbi tumaniga yaqin",
      //    "Qarshi, Navoiy ko'chasi 5, Muborak T." - Y mo'ljal yoki ism);
      //  - topilmagan boshqa belgili nom ("Yangiyer sh.", "Pop-t.", r12 C4);
      //  - matcher ko'rmaydigan yozuvdagi boshqa joy nomi ("Карши, ...",
      //    "Termez t., ..., Nishon-T.", r13);
      //  - belgisiz "Toshkent" yoki matndagi BOSHQA viloyat ("Toshkent, ...,
      //    Мубарак T.", r13).
      // "Samarqand, Urgut t., ..." (viloyat konteksti) - raqib emas.
      const conflict =
        newOnlyWords.size >= 2 ||
        weak.some((d) => bareRival(d) && !regionLead(d)) ||
        bareTashkent.some((o) => {
          const a = o.lead ? abbrAt.get(`${o.li}:${o.end}`) : undefined;
          return !(
            a &&
            leadAbbr.has(a.last) &&
            isTashkentSato(idx.regionById.get(a.d.region_id)?.sato)
          );
        }) ||
        // r13: matndagi viloyat boshqa ("Toshkent, ..., Мубарак T.").
        (mentionedRegions.size > 0 &&
          strong.some((d) => {
            const sato = idx.regionById.get(d.region_id)?.sato;
            return !!sato && !mentionedRegions.has(sato);
          })) ||
        explicitOtherName(
          tokenLists,
          tHeads,
          headsOf(strong),
          poolHeads(),
          lowerAbbr,
        ) ||
        hiddenRival(tokenInfos, strong, {
          hasOrigin: originInText,
          leadRegion: (li, j) => {
            const a = abbrAt.get(`${li}:${j}`);
            return a && leadAbbr.has(a.last) ? a.d.region_id : null;
          },
        });
      if (!conflict) {
        matches = longestNonRegion(strong);
        // r14 (S1): yagona belgi katta "T." ("Gulistan T.") - nomzod.
        if (matches.every((d) => capMarked.has(d.id) && !firmMarked.has(d.id)))
          candidateOnly = true;
      } else {
        // r13: ziddiyatda dev kabi (yangi belgilarsiz): yagona yalang'och nom
        // + aniq dev belgisi ("Toshkent shahri, Uchtepa, ..., Mirobod
        // tumanidagi bozor yonida") - dev'ning avto tanlovi saqlanadi;
        // aks holda hammasi nomzod.
        const devWeak = [...weak, ...strong.filter((d) => exactSeen.has(d.id))];
        const devPick =
          devWeak.filter((d) => !d.regionNamed).length > 1 || !devWeak.length
            ? []
            : longestNonRegion(devWeak);
        const keep =
          devPick.length === 1 &&
          !dq &&
          strictPlaceSignal &&
          !softTumanT.has(devPick[0].id) &&
          !hasKindTwin(devPick[0]) &&
          !devOtherName(devPick) &&
          !hiddenRival(tokenInfos, devPick, {
            hasOrigin: originInText,
            devMarkedOnly: true,
          });
        if (keep) {
          matches = devPick;
        } else if (!devWeak.length) {
          // dev'da 2b hech narsa topmasdi (faqat qoidaviy variantli yangi
          // belgi: "Кува туманига") - 4-usul dev kabi; topilmasa nomzodlar.
          deferred = strong;
        } else {
          matches = [...strong, ...weak].slice(0, AI_MAX_CANDIDATES);
          candidateOnly = true;
        }
      }
    } else if (weak.length) {
      // r13: jo'natish joyi ("Zarbdor tumanidan kelgan") yetkazish manzili
      // emas - boshqa yalang'och (uy raqamisiz) moslik bo'lsa o'shalardan
      // ("Jizzax, ..., Zarbdor tumanidan kelgan"); aks holda dev kabi.
      const dest = weak.filter(
        (d) => !originMarked.has(d.id) && plainWeak.has(d.id),
      );
      const pickFrom =
        dest.length && weak.some((d) => originMarked.has(d.id)) ? dest : weak;
      // Bir nechta zaif moslik — HAMMASI nomzod (eng uzuni emas).
      const weakNonRegion = pickFrom.filter((d) => !d.regionNamed);
      if (weakNonRegion.length > 1) {
        matches = weakNonRegion;
        candidateOnly = true;
      } else {
        matches = longestNonRegion(pickFrom);
      }
      // r12: belgi faqat boshqa nomning "Y t." / "Y tumanida/tum." belgisi
      // bo'lsa (Y topilmagan) - yalang'och moslik avto emas.
      // r13: belgi matcher ko'rmaydigan BOSHQA nomniki bo'lsa ("Янгикурган
      // gorod, ..." / "Termez tumani, ..."), yoki faqat havzadan tashqaridagi
      // "Name T." (S2) va manzilda yashirin joy nomi bo'lsa ("Sirdaryo,
      // Yangiyer, ..., Нишон T.") - avto emas.
      // r16: belgi faqat jo'natish joyiniki ("..., с г. Джамбай") - yagona,
      // uy raqamisiz, turi aniq (shahar/tuman egizagi yo'q) va viloyat nomli
      // bo'lmagan yalang'och nom uchungina belgi (dev kabi: "Payariq, ...").
      // "Qarshi, ..., jo'natuvchi: Kasbi tumani" (Qarshi shahar ham, tuman
      // ham), "Samarqand, ..., jo'natuvchi: X tumani" - avto emas.
      const originOnlySignal =
        !strictPlaceSignal &&
        strictWithOrigin &&
        matches.length === 1 &&
        !matches[0].regionNamed &&
        plainWeak.has(matches[0].id) &&
        !hasKindTwin(matches[0]);
      const signal = weakSignal(
        matches,
        true,
        landmarks,
        strictPlaceSignal || originOnlySignal,
      );
      if (signal === 'none') forceCandidate = true;
      if (signal === 'rival' || signal === 'soft') candidateOnly = true;
      if (matches.some((d) => softTumanT.has(d.id))) candidateOnly = true;
      // r17: faqat jo'natish joyi topildi ("Tayloq tumani dan, Buxoro sh.,
      // ..." - Buxoro boshqa viloyatda): belgi boshqa joyniki - avto emas.
      // Matnda boshqa belgili nom yoki boshqa viloyat ("Buxoro sh.") bo'lsa.
      if (
        matches.every((d) => originMarked.has(d.id)) &&
        (devOtherName(matches) ||
          [mentionedRegions, cityMarkedRegions].some(
            (regions) =>
              regions.size > 0 &&
              matches.every((d) => {
                const sato = idx.regionById.get(d.region_id)?.sato;
                return !!sato && !regions.has(sato);
              }),
          ))
      )
        candidateOnly = true;
      // Operator tuman nomini yozgan, lekin u topilmadi — manzildagi so'z
      // bilan almashtirish TAXMIN.
      if (dq) candidateOnly = true;
      // r14 (S2): dev aynan ko'rgan (`exactSeen`, qoidaviy variantsiz) mo'ljal
      // nomi ("Dustlik tumani tomonga") - dev uchun u ham raqib nom edi;
      // endi ikkalasi nomzod. Dev ko'rmagan yozuv ("Do'stlik tumani tomonga")
      // yoki faqat variant ("Мирабад туманидаги бозор ёнида") esa yalang'och
      // asosiy nomni bosib ketmaydi (B2, r13 F6).
      const devLandmarks = landmarks.filter((d) => exactSeen.has(d.id));
      if (devLandmarks.length) {
        matches = [...matches, ...devLandmarks];
        candidateOnly = true;
        forceCandidate = false;
      }
    } else if (landmarks.length) {
      // r14 (S2): faqat mo'ljal ("X tumaniga ketaverishda") - manzil emas:
      // 4-usul boshqa nom topsa o'sha, mo'ljalning o'zi esa faqat nomzod.
      deferred = [...deferred, ...landmarks];
    }
    landmarkList = landmarks;
  }

  // 4-usul (BeePost :1645-1695): to'liq manzil skeletida fuzzy-substring.
  // Faqat 1-3 topmaganda; korpus kesilgan (CPU).
  let via4 = false;
  if (!matches.length) {
    const corpusTokens = normGeo(
      `${q.district_name} ${q.full_address || q.address}`,
    )
      .split(' ')
      .filter(Boolean);
    const corpus = stripFirstRegionWord(corpusTokens, regionWords)
      .join('')
      .slice(0, DISTRICT_CORPUS_MAX_CHARS);
    if (corpus.length >= 4) {
      const corpusBigrams = new Set(geoBigrams(corpus));
      let bestScore = 0;
      let bestDs: PreparedDistrict[] = [];
      for (const d of pool) {
        if (d.skeleton.length < 4) continue;
        if (!mayReachGeoSubstringMin(corpusBigrams, d.skeleton)) continue;
        const sc = bestSubstringSim(corpus, d.skeleton);
        if (sc > bestScore + 1e-9) {
          bestScore = sc;
          bestDs = [d];
        } else if (Math.abs(sc - bestScore) < 1e-9) {
          bestDs.push(d);
        }
      }
      if (bestScore >= GEO_SUBSTRING_MIN) {
        matches = bestDs.slice(0, AI_MAX_CANDIDATES);
        stage = 'substring';
        stageScore = Math.round(bestScore * 1000) / 1000;
        // r13: belgi topilgan nomniki bo'lsa (yoki aniq dev so'zi) -
        // "Pop-t., ..., Do'stlik T. 90..." dagi "Pop-t." Do'stlik uchun joy
        // belgisi EMAS; havzadan tashqaridagi "Name T." (S2) ham bu yerda
        // belgi emas (dev kabi nomzod); "Пахтаабад, Мархамат туманига
        // яқин" - yashirin boshqa joy nomi bilan avto emas.
        const signal = weakSignal(matches, false, landmarkList, strictNoOrigin);
        // r16: faqat mo'ljalning o'zi topilgan bo'lsa ("Kasbi tumani tomonga")
        // - belgi mo'ljalniki: nomzod (avvalgidek), "belgisiz" emas.
        if (signal === 'none') {
          if (matches.every((d) => landmarkList.includes(d))) {
            candidateOnly = true;
          } else forceCandidate = true;
        }
        if (signal === 'rival' || signal === 'soft') candidateOnly = true;
        // r15: 4-usul jo'natish joyining o'zini ("из г. Карши") topdi - avto
        // emas.
        if (matches.some((d) => originIds.has(d.id))) candidateOnly = true;
        // D3: operator yozgan tuman nomi so'zma-so'z topilmadi — korpus
        // ichidagi qism ("Quvasoy" ichida "Quva") faqat nomzod.
        if (dq) candidateOnly = true;
        // r14 (B3): 2b ziddiyati 4-usulga qoldirilgan bo'lsa - avto emas.
        if (matches.some((d) => deferred.includes(d))) candidateOnly = true;
        if (matches.every((d) => streetRejected.has(d.id) || d.regionNamed))
          candidateOnly = true;
        via4 = true;
        // #646 review B3: avto faqat TOKEN chegarasida ("Quvasoy" ichidagi
        // "Quva", "Verxnechirchik" ichidagi "Chirchiq" — nomzod).
        const ctoks = stripFirstRegionWord(corpusTokens, regionWords)
          .map((t) => geoSkeleton(t))
          .filter(Boolean);
        const aligned = (d: PreparedDistrict): boolean => {
          for (let i = 0; i < ctoks.length; i++) {
            for (let k = 1; k <= 3 && i + k <= ctoks.length; k++) {
              const w = ctoks.slice(i, i + k).join('');
              // Rus sifati / qo'shimcha qoldig'i (<= 2 harf: "Baliqchin-",
              // "Asakada") — mos; 3+ harf ("Quva|soy") — boshqa nom.
              const extra = w.length - d.skel.length;
              const ok =
                simRatio(w, d.skel) >= GEO_SUBSTRING_MIN ||
                (extra >= 1 &&
                  extra <= 2 &&
                  simRatio(w.slice(0, d.skel.length), d.skel) >=
                    GEO_SUBSTRING_MIN);
              if (!ok) continue;
              const prev = ctoks[i - 1] ?? '';
              const next = ctoks[i + k] ?? '';
              if (prev && allSkels.has(prev + w)) continue;
              if (next && allSkels.has(w + next)) continue;
              return true;
            }
          }
          return false;
        };
        if (!matches.every(aligned)) candidateOnly = true;
        // Rus urg'ochi sifati ("Сергелийская ул.") — ko'cha nomi; viloyat
        // ("Ташкентская обл.") bundan mustasno. Tuman — "-ский р-н".
        const feminineStems = [
          ...lightNorm(`${q.full_address} ${q.address}`).matchAll(
            /([a-z']{3,}?)sk(?:aya|aja)\b(?!\s*\.?\s*obl)/g,
          ),
        ].map((m) => geoSkeleton(m[1]));
        if (
          feminineStems.length &&
          matches.some((d) =>
            feminineStems.some(
              (stem) =>
                simRatio(stem.slice(0, d.skel.length), d.skel) >=
                GEO_SUBSTRING_MIN,
            ),
          )
        ) {
          candidateOnly = true;
        }
      }
    }
  }

  if (!matches.length && deferred.length) {
    matches = deferred.slice(0, AI_MAX_CANDIDATES);
    candidateOnly = true;
  }

  // R1: shahar/tuman afzalligi (SOATO turi bo'yicha).
  const markerText = `${q.district_name}, ${q.full_address || q.address}`;
  const want = kindOf(markerText, headsOf(matches));
  matches = preferCityOrTuman(matches, want, idx);
  // r7 B1: vergulsiz "Qarshi t. Mustaqillik" — tur noaniq: shahar/tuman
  // juftligida ikkalasi NOMZOD, hech biri avto emas (yalang'och "Qarshi"
  // shaharga tushib, avto-tanlanardi).
  if (!want && matches.length && namedT(markerText, SOFT_TUMAN_T_RE)) {
    const asTuman = preferCityOrTuman(matches, 'tuman', idx);
    const extra = asTuman.filter((d) => !matches.includes(d));
    if (extra.length || asTuman.length !== matches.length) {
      matches = [...matches, ...extra];
      candidateOnly = true;
    }
  }
  // #646 review B2: R1 toraytirgandan KEYIN ham — 4-usulda faqat ko'cha
  // sifatida rad etilgan yoki viloyat nomli qator qolsa, avto emas.
  if (
    via4 &&
    matches.length &&
    matches.every((d) => streetRejected.has(d.id) || d.regionNamed)
  ) {
    candidateOnly = true;
  }

  const regionFields = (region: PreparedRegion | null | undefined) => ({
    region_id: region?.id ?? null,
    region_label: region?.label ?? null,
    region_name: region?.name ?? null,
  });
  const toCandidate = (d: PreparedDistrict): DistrictCandidate => {
    const region = idx.regionById.get(d.region_id);
    return {
      id: d.id,
      label: region?.label ? `${region.label}, ${d.name}` : d.name,
      region_name: region?.name ?? '',
      district_name: d.name,
    };
  };
  // Tuman aniqlanmadi — viloyat (qulflangan bo'lsa) SAQLANADI.
  const unresolved = (
    list: PreparedDistrict[],
    reason: DistrictResolutionReason,
  ): DistrictTextResolution => {
    const unique: PreparedDistrict[] = [];
    const seen = new Set<string>();
    for (const d of list) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      unique.push(d);
    }
    return {
      ...regionFields(lockedRegion),
      district_id: null,
      district_label: null,
      district_name: null,
      // #649 review (3-davra): almashtirishdan keyin topilmasa ham qulflangan
      // viloyat AI taxmini — "berilgan" emas.
      region_given: regionGiven && !regionSwitched,
      candidates: unique.slice(0, AI_MAX_CANDIDATES).map(toCandidate),
      reason,
    };
  };

  if (matches.length === 1 && !forceCandidate && !candidateOnly) {
    const d = matches[0];
    const region = idx.regionById.get(d.region_id);
    // R2 (qulfsiz): boshqa viloyatdagi o'xshash tuman — jimgina tanlanmaydi.
    // Yalang'och "Toshkent" (1726/1727 noaniq) va tuman shu havzada —
    // boshqa viloyatdagi o'xshash nom ("Mirobod" ↔ Mirzaobod) to'smaydi.
    const tashkentHint =
      !lockedRegion &&
      AMBIGUOUS_REGION_WORDS.has(normGeo(q.region_name)) &&
      isTashkentSato(region?.sato);
    // #649 review: AI taxmin qilgan viloyatdan almashtirilgan tanlov ham R2
    // tekshiruvidan o'tadi — aks holda region_inferred=true matn viloyatsiz
    // matndan EHTIYOTSIZROQ natija olardi (Andijon + Mirobod → Mirzaobod).
    const confusables =
      (lockedRegion && !regionSwitched) || tashkentHint
        ? []
        : crossRegionNeighbours(d, idx);
    // R2 (qulf bor, faqat 3-usul fuzzy): so'rov qulfdan TASHQARIDAGI
    // tumanga kamida shunchalik yaqin ("Qashqadaryo" + "Kogon" → Koson
    // 0.80, lekin Kogon (Buxoro) 1.0) — viloyat yoki tuman xato yozilgan.
    // Nomzodlar baribir faqat qulf ichidan.
    const matchScore = simRatio(d.geo, dq);
    const lockedOutsideCloser =
      !!lockedRegion &&
      viaFuzzy &&
      idx.districts.some(
        (o) =>
          o.region_id !== lockedRegion.id && simRatio(o.geo, dq) >= matchScore,
      );

    const gate = satoGate(d, region);
    if (gate === 'mismatch') {
      return unresolved([d, ...confusables], 'sato_mismatch');
    }
    if (gate === 'unverifiable') {
      // ⚠️ Yangi tuman qo'lda qo'shilganda sato_code ataylab NULL — "kod
      // yo'q → rad et" qilinmaydi (aks holda yangi tuman ishlamay qoladi),
      // lekin qulfsiz holatda avto-tanlanmaydi.
      warn(
        `district-resolver: district ${d.id} (region ${d.region_id}) has no SOATO code on the district or its region; SOATO gate skipped`,
      );
      if (!lockedRegion) {
        return unresolved(
          [d, ...confusables],
          confusables.length ? 'cross_region_confusable' : 'district_ambiguous',
        );
      }
    }
    if (confusables.length || lockedOutsideCloser) {
      return unresolved([d, ...confusables], 'cross_region_confusable');
    }
    // Yalang'och "Toshkent" himoyasi (karta 3-band): viloyat qulflanmagan va
    // topilgan tuman nomi noaniq viloyat so'zining o'zi ("Toshkent" →
    // "Toshkent tumani", 1727) — bu viloyatni TAXMIN qilish bo'lardi
    // ("Toshkent shahar, ..." ham shunga tushardi). Matn turni aniq aytgan
    // bo'lsa ("Toshkent tumani") tanlanadi.
    if (!lockedRegion && AMBIGUOUS_REGION_WORDS.has(d.geo) && d.kind !== want) {
      return unresolved([d], 'region_ambiguous');
    }
    // D1/kind_mismatch: matn turni aniq aytgan ("Farg'ona shahri"), bazada
    // faqat boshqa turdagi qator (1730233 — tuman) — avto-tanlov EMAS,
    // operator tanlaydi (shahar qatori hali qo'shilmagan bo'lishi mumkin).
    // Tur faqat TUMAN maydonidan: full_address'dagi "Toshkent shahri"
    // (viloyat) tumanning turini bildirmaydi.
    const explicitKind =
      kindOf(q.district_name) ??
      addressKind.get(d.id) ??
      // #646 review B4: 4-usul topilmasida manzildagi tur ham hisobga
      // olinadi ("Шахрисабзский р-н" — tuman).
      (via4 && !q.district_name ? want : null);
    if (
      explicitKind &&
      d.kind &&
      d.kind !== explicitKind &&
      officialHasKind(d.sato, d.skel, explicitKind)
    ) {
      return unresolved([d], 'district_ambiguous');
    }
    const match: DistrictMatchInfo = (() => {
      if (stage === 'fuzzy') {
        return { method: 'fuzzy', score: round3(stageScore) };
      }
      if (stage === 'address') return { method: 'address', score: null };
      if (stage === 'substring') {
        return { method: 'address', score: round3(stageScore) };
      }
      if (stage === 'word' || d.geo === dq || d.skel === dqSkel) {
        return { method: 'exact', score: null };
      }
      if (d.aliases.has(dqSkel)) return { method: 'alias', score: null };
      // Qoidaviy variant (а→о, к→q) — imlo moslashuvi.
      return { method: 'fuzzy', score: round3(simRatio(d.skel, dqSkel)) };
    })();
    if (regionSwitched) match.region_switched = true;
    // region_id HAR DOIM tumanning o'zidan (assigned_region EMAS).
    return {
      ...regionFields(region),
      region_id: d.region_id,
      district_id: d.id,
      district_label: region?.label ? `${region.label}, ${d.name}` : d.name,
      district_name: d.name,
      // Almashtirilganda qaytgan viloyat berilgani EMAS — FE "AI taxmin
      // qildi" ishorasini ko'rsatadi.
      region_given: regionGiven && !regionSwitched,
      candidates: [],
      match,
    };
  }

  if (matches.length) {
    return unresolved(
      matches,
      forceCandidate ? 'no_place_signal' : 'district_ambiguous',
    );
  }
  return unresolved(
    [],
    q.region_name && !regionGiven ? 'region_ambiguous' : 'district_not_found',
  );
}

/** Topilmagan element (partiya chegarasidan tashqari yoki kutilmagan xato). */
function emptyResolution(): DistrictTextResolution {
  return {
    region_id: null,
    district_id: null,
    region_label: null,
    district_label: null,
    region_name: null,
    district_name: null,
    region_given: false,
    candidates: [],
    reason: 'district_not_found',
  };
}

export interface DistrictResolveByTextReply {
  statusCode: number;
  message: string;
  data: DistrictTextResolution[];
}

@Injectable()
export class DistrictResolverService {
  private readonly logger = new Logger(DistrictResolverService.name);

  constructor(
    @InjectRepository(Region) private readonly regionRepo: Repository<Region>,
    @InjectRepository(District)
    private readonly districtRepo: Repository<District>,
  ) {}

  /**
   * Partiya: viloyat va tumanlar BIR MARTA yuklanadi (N+1 emas), natija
   * kirish tartibida. `DISTRICT_RESOLVE_MAX_ITEMS` dan ortiq elementlar
   * hisoblanmaydi, lekin javob uzunligi saqlanadi (indeks bo'yicha o'qish
   * siljimasin) — ular "topilmadi" bo'lib qaytadi.
   */
  async resolveBatch(items: unknown): Promise<DistrictResolveByTextReply> {
    const list: unknown[] = Array.isArray(items) ? items : [];
    if (!list.length) return successRes([]) as DistrictResolveByTextReply;

    const [regions, districts] = await Promise.all([
      this.regionRepo.find({
        select: { id: true, name: true, sato_code: true },
        order: { id: 'ASC' },
      }),
      this.districtRepo.find({
        select: { id: true, name: true, sato_code: true, region_id: true },
        order: { id: 'ASC' },
      }),
    ]);
    const snapshot: DistrictSnapshot = {
      regions: regions.map((r) => ({
        id: String(r.id),
        name: r.name,
        sato_code: r.sato_code,
      })),
      districts: districts.map((d) => ({
        id: String(d.id),
        name: d.name,
        sato_code: d.sato_code,
        region_id: String(d.region_id),
      })),
    };

    // Bir xil ogohlantirish partiya ichida bir marta.
    const warned = new Set<string>();
    const warn = (msg: string) => {
      if (warned.has(msg)) return;
      warned.add(msg);
      this.logger.warn(msg);
    };

    if (list.length > DISTRICT_RESOLVE_MAX_ITEMS) {
      this.logger.warn(
        `district-resolver: ${list.length} items received, only the first ${DISTRICT_RESOLVE_MAX_ITEMS} are resolved`,
      );
    }

    const data = list.map((raw, i) => {
      if (i >= DISTRICT_RESOLVE_MAX_ITEMS) return emptyResolution();
      try {
        return resolveDistrictText(raw as DistrictTextQuery, snapshot, warn);
      } catch (err) {
        // ⚠️ Matn log'ga YOZILMAYDI (PII) — faqat indeks va xato.
        this.logger.error(
          `district-resolver: item ${i} failed: ${(err as Error)?.message ?? err}`,
        );
        return emptyResolution();
      }
    });
    return successRes(data) as DistrictResolveByTextReply;
  }
}
