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
  regionAlias,
  simRatio,
  translit,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { Region } from '../entities/region.entity';
import { District } from '../entities/district.entity';
import type {
  DistrictCandidate,
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

/** Matnda joy belgisi bormi — BeePost :1596-1601 (hasPlaceSignal). */
const PLACE_WORD_RE = /\b(tumani|tuman|shahri|shahar|shaharcha)\b/;
/** Shahar afzalligi belgisi — BeePost :1708-1709. */
const CITY_WORD_RE = /\b(shahri|shahar)\b/;
/** Tuman afzalligi belgisi — BeePost :1708-1709. */
const TUMAN_WORD_RE = /\b(tumani|tuman)\b/;

type DistrictKind = 'city' | 'tuman';

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
function wantedKind(markerText: string): DistrictKind | null {
  const wantsCity = CITY_WORD_RE.test(markerText);
  const wantsTuman = TUMAN_WORD_RE.test(markerText);
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

  // 1-usul (BeePost :1576-1589): aniq base-nom, keyin qism-mos.
  if (dq) {
    matches = pool.filter((d) => d.geo === dq);
    if (!matches.length) {
      matches = pool.filter(
        (d) => d.geo.length > 2 && (d.geo.includes(dq) || dq.includes(d.geo)),
      );
    }
  }

  // PLACE-SIGNAL (BeePost :1596-1601): "tuman/shahar" so'zi yoki
  // district_name bo'lmasa — oddiy ko'cha so'zi jimgina TUMANga aylanmaydi.
  const hasPlaceSignal =
    !!q.district_name ||
    PLACE_WORD_RE.test(translit(`${q.full_address} ${q.address}`));
  let forceCandidate = false;

  // 2-usul (BeePost :1603-1623): tuman so'rovi + address korpusidan butun
  // so'z bilan, eng uzun nom. region_name QO'SHILMAYDI.
  if (!matches.length) {
    const corpus = [dq, normGeo(q.address)].filter(Boolean).join(' ');
    if (corpus) {
      const padded = ` ${corpus} `;
      const found = pool
        .filter((d) => d.geo.length >= 4 && padded.includes(` ${d.geo} `))
        .sort((a, b) => b.geo.length - a.geo.length);
      if (found.length) {
        // ⚠️ Elchi: viloyat nomli tuman boshqa topilgan tumandan KEYIN.
        // Aks holda "eng uzun nom" qoidasi bilan "Toshkent Olmazor tumani"
        // → "Toshkent tumani" (1727, BOSHQA viloyat), "Samarqand Urgut
        // tumani" → "Samarqand" tanlanardi. Faqat viloyat nomli moslik
        // qolsa ("Andijon tumani, Oq yer MFY") — o'sha ishlatiladi.
        const nonRegion = found.filter((d) => !d.regionNamed);
        const ranked = nonRegion.length ? nonRegion : found;
        const maxLen = ranked[0].geo.length;
        matches = ranked.filter((d) => d.geo.length === maxLen);
        if (!hasPlaceSignal) forceCandidate = true;
      }
    }
  }

  // 3-usul (BeePost :1625-1643): imlo xatosi — simRatio >= GEO_FUZZY_MIN,
  // g'olibdan GEO_FUZZY_NEAR_DELTA ichidagilar nomzod.
  if (!matches.length && dq.length >= 3) {
    const scored = pool
      .map((d) => ({ d, s: simRatio(d.geo, dq) }))
      .filter((x) => x.s >= GEO_FUZZY_MIN)
      .sort((a, b) => b.s - a.s);
    if (scored.length) {
      const fuzzyTop = scored[0].s;
      matches = scored
        .filter((x) => fuzzyTop - x.s < GEO_FUZZY_NEAR_DELTA)
        .slice(0, AI_MAX_CANDIDATES)
        .map((x) => x.d);
      viaFuzzy = true;
    }
  }

  // 4-usul (BeePost :1645-1695): to'liq manzil skeletida fuzzy-substring.
  // Faqat 1-3 topmaganda; korpus kesilgan (CPU).
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
        if (!hasPlaceSignal) forceCandidate = true;
      }
    }
  }

  // R1: shahar/tuman afzalligi (SOATO turi bo'yicha).
  const want = wantedKind(
    translit(`${q.district_name} ${q.full_address || q.address}`),
  );
  matches = preferCityOrTuman(matches, want, idx);

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
      region_given: regionGiven,
      candidates: unique.slice(0, AI_MAX_CANDIDATES).map(toCandidate),
      reason,
    };
  };

  if (matches.length === 1 && !forceCandidate) {
    const d = matches[0];
    const region = idx.regionById.get(d.region_id);
    // R2 (qulfsiz): boshqa viloyatdagi o'xshash tuman — jimgina tanlanmaydi.
    const confusables = lockedRegion ? [] : crossRegionNeighbours(d, idx);
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
    // region_id HAR DOIM tumanning o'zidan (assigned_region EMAS).
    return {
      ...regionFields(region),
      region_id: d.region_id,
      district_id: d.id,
      district_label: region?.label ? `${region.label}, ${d.name}` : d.name,
      district_name: d.name,
      region_given: regionGiven,
      candidates: [],
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
