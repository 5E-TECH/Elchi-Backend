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
 * (`resolveDistrictIdOrNull`) bu yerga ULANMAYDI: hamkor importining qat'iy
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
 */
const PLACE_WORD_RE =
  /\b(tumani|tuman|shahri|shaxri|shahar|shaharcha|shaharchasi|rayon|rayoni|raion|gorod)\b|\br-n\b|\b(sh|g|tum)\.|\btuman(ida|idagi|iga)\b/;
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
 * PLACE_WORD_RE / TUMAN_WORD_RE dan olib tashlangan.
 */
const TUMAN_T_ABBR_RE = /([a-z]{2,})\s+t\.(?=\s*(?:[,;]|$))/g;
const TUMAN_WORD_RE =
  /\b(tumani|tuman|tumanida|tumanidagi|tumaniga|rayon|rayoni|raion)\b|\btum\.|\br-n\b/;
/**
 * r7 B1: vergulsiz "X t. <so'z|uy raqami>" ("Qarshi t. Mustaqillik", "Qarshi
 * T.Malik", "Qarshi t. 5-uy") — tuman belgisi ham, ism bosh harfi / boshqa
 * narsa ham bo'lishi mumkin. Telefon ("t. 90 123 ...", "t. 901234567",
 * "t.: ", "t. +998", "t. (90)"), "t.y." va "[TEL_1]" bundan mustasno.
 */
const SOFT_TUMAN_T_RE =
  /([a-z]{2,})\s+t\.(?!\s*(?:[,;:+([]|$|y\b|y\.|\d{2}\s*\d{3}|\d{5,}))/g;

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

/** `tokens[j]` dan aniq tuman belgisi boshlanadimi ("tumani", "t.", "r-n"). */
function tumanMarkerAt(tokens: string[], j: number): boolean {
  const w = tokens[j] ?? '';
  return TUMAN_AFTER_WORDS.has(w) || (w === 'r' && tokens[j + 1] === 'n');
}

/** Nomdan OLDIN tuman belgisi — rus tartibi ("р-н X", "rayon X"). */
function tumanMarkerBefore(tokens: string[], i: number): boolean {
  const prev = tokens[i - 1] ?? '';
  return (
    prev === 'rayon' ||
    prev === 'raion' ||
    (prev === 'n' && tokens[i - 2] === 'r')
  );
}

/**
 * Manzil tokenlari: `normGeo` qo'shimchalarini SAQLAB (tumani, shahri).
 * Nomdan keyingi "t." (`TUMAN_T_ABBR_RE`) — "tumani" tokeni; telefon,
 * "t.y." yoki ism bosh harfidagi "t." esa oddiy "t" bo'lib qoladi.
 */
function addressTokens(text: string): string[] {
  return (
    lightNorm(text)
      // "№12": translit (kichik harf) dan keyin NFKC "№" → "No" (katta N) —
      // `[^a-z0-9]` uni o'chirib "o12" qoldirardi (r7 B3).
      .replace(/No(?=\s*\d)/g, ' no ')
      .replace(TUMAN_T_ABBR_RE, '$1 tumani ')
      .replace(RU_ADJ_SUFFIX_RE, '$1')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(Boolean)
  );
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
}

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

  const prepared: PreparedSnapshot = {
    regionById,
    regionBySato,
    nullSatoRegionIds,
    districts,
    districtsByRegion,
    neighbourCache: new Map(),
  };
  PREPARED.set(snapshot, prepared);
  return prepared;
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
 * Matn qaysi turni so'rayapti: "shahri/shahar" → shahar, "tumani/tuman" →
 * tuman (BeePost :1703-1719); ikkalasi ham yoki hech biri bo'lmasa null.
 */
function wantedKind(
  markerText: string,
  namedTumanT = false,
): DistrictKind | null {
  const wantsCity = CITY_WORD_RE.test(markerText);
  const wantsTuman = TUMAN_WORD_RE.test(markerText) || namedTumanT;
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
  const q = sanitizeDistrictTextQuery(input);
  const idx = prepareSnapshot(snapshot);

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
  const allSkels = new Set([
    ...idx.districts.map((d) => d.skel),
    ...OFFICIAL_SKELS,
  ]);
  // r7 B2: "X t." faqat X tuman/viloyat nomi bo'lsa ("Karimov T." — ism
  // bosh harfi, joy belgisi EMAS).
  const tHeads = new Set<string>(allSkels);
  for (const d of idx.districts) {
    const last = d.tokens[d.tokens.length - 1];
    if (last) tHeads.add(geoSkeleton(last));
    for (const a of d.aliases) tHeads.add(a);
  }
  for (const row of REGION_ALIASES) {
    for (const b of row.bases) tHeads.add(geoSkeleton(normGeo(b)));
  }
  const namedT = (text: string, re: RegExp): boolean => {
    for (const m of lightNorm(text).matchAll(re)) {
      if (tHeads.has(geoSkeleton(m[1]))) return true;
    }
    return false;
  };
  const kindOf = (text: string): DistrictKind | null =>
    wantedKind(translit(text), namedT(text, TUMAN_T_ABBR_RE));
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
  const hasPlaceSignal =
    !!q.district_name ||
    PLACE_WORD_RE.test(translit(`${q.full_address}, ${q.address}`)) ||
    namedT(`${q.full_address}, ${q.address}`, TUMAN_T_ABBR_RE);
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

  // 2b-usul: MANZIL korpusidan butun so'z bilan. D2: nomdan keyin
  // ko'cha/mahalla so'zi kelsa (yoki oldidan "ул.") — RAD; "tumani/shahri"
  // kelsa — kuchli; boshqa holatda operator tuman yozgan bo'lsa faqat nomzod.
  // full_address ham (alohida matn sifatida): "Andijon shahri, Bo'ston
  // ko'chasi" — Bo'ston RAD, "Andijon shahri" kuchli.
  const addressTexts = [q.address, q.full_address].filter(Boolean);
  if (!matches.length && addressTexts.length) {
    const tokenLists = addressTexts.map(addressTokens);
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
    for (const d of pool) {
      if (d.geo.length < 4 || !d.tokens.length) continue;
      let best: 'strong' | 'weak' | null = null;
      for (const tokens of tokenLists) {
        for (let i = 0; i < tokens.length; i++) {
          let len = 0;
          let viaVariant = false;
          if (d.tokens.every((w, k) => tokens[i + k] === w))
            len = d.tokens.length;
          else {
            for (let k = 2; k <= 3 && i + k <= tokens.length; k++) {
              if (tokens.slice(i, i + k).join('') === d.skel) {
                len = k;
                break;
              }
            }
          }
          if (
            !len &&
            tokens[i] !== d.skel &&
            variantsOf(tokens[i]).has(d.skel)
          ) {
            len = 1;
            viaVariant = true;
          }
          if (!len) continue;
          const next = tokens[i + len] ?? '';
          const prev = tokens[i - 1] ?? '';
          if (
            viaVariant &&
            !(
              PLACE_AFTER_WORDS.has(next) ||
              (next === 'r' && tokens[i + len + 1] === 'n')
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
            !tumanMarkerBefore(tokens, i)
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
          const isRn = next === 'r' && tokens[i + len + 1] === 'n';
          if (PLACE_AFTER_WORDS.has(next) || isRn) {
            best = 'strong';
            addressKind.set(
              d.id,
              CITY_AFTER_WORDS.has(next) ? 'city' : 'tuman',
            );
            break;
          }
          // Rus tartibi — belgi nomdan OLDIN: "г. Termiz", "р-н Shahrisabz"
          // (#646 review round 2: tur kind_mismatch'ga yetib borsin).
          const prevKind: DistrictKind | null =
            prev === 'g' || prev === 'gorod'
              ? 'city'
              : (prev === 'n' && tokens[i - 2] === 'r') ||
                  prev === 'rayon' ||
                  prev === 'raion'
                ? 'tuman'
                : null;
          if (prevKind) {
            best = 'strong';
            addressKind.set(d.id, prevKind);
            break;
          }
          best = 'weak';
        }
        if (best === 'strong') break;
      }
      if (best === 'strong') strong.push(d);
      else if (best === 'weak') weak.push(d);
    }
    if (strong.length || weak.length) stage = 'address';
    if (strong.length) {
      matches = longestNonRegion(strong);
    } else if (weak.length) {
      // Bir nechta zaif moslik — HAMMASI nomzod (eng uzuni emas).
      const weakNonRegion = weak.filter((d) => !d.regionNamed);
      if (weakNonRegion.length > 1) {
        matches = weakNonRegion;
        candidateOnly = true;
      } else {
        matches = longestNonRegion(weak);
      }
      if (!hasPlaceSignal) forceCandidate = true;
      if (matches.some((d) => softTumanT.has(d.id))) candidateOnly = true;
      // Operator tuman nomini yozgan, lekin u topilmadi — manzildagi so'z
      // bilan almashtirish TAXMIN.
      if (dq) candidateOnly = true;
    }
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
        if (!hasPlaceSignal) forceCandidate = true;
        // D3: operator yozgan tuman nomi so'zma-so'z topilmadi — korpus
        // ichidagi qism ("Quvasoy" ichida "Quva") faqat nomzod.
        if (dq) candidateOnly = true;
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

  // R1: shahar/tuman afzalligi (SOATO turi bo'yicha).
  const markerText = `${q.district_name}, ${q.full_address || q.address}`;
  const want = kindOf(markerText);
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
