import { satoRegions, type SatoRegion } from '../data/sato-codes';

/**
 * Nomni normalizatsiya qilish (solishtirishda ishlatiladi)
 * keepSuffix = true bo'lsa, "shahri", "viloyati" kabi qo'shimchalarni saqlaydi
 */
function normalizeName(name: string, keepSuffix = false): string {
  // Ko'rinmas belgilarni va maxsus unicode belgilarni olib tashlash
  let normalized = name
    .toLowerCase()
    .trim()
    .normalize('NFKC') // Unicode normalizatsiya
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width belgilarni olib tashlash
    .replace(/'/g, "'") // Turli apostrof variantlarini standartlashtirish
    .replace(/'/g, "'")
    .replace(/`/g, "'");

  if (!keepSuffix) {
    // "viloyati", "tumani", "respublikasi" so'zlarini olib tashlash
    // LEKIN "shahri" ni saqlaymiz chunki Toshkent shahri va Toshkent viloyati farqlanishi kerak
    normalized = normalized
      .replace(/\s*(viloyati|tumani|respublikasi)\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return normalized;
}

/**
 * Dublikat tekshirish uchun maxsus normalizatsiya
 * Bu funksiya "shahri" va "viloyati" ni farqlaydi
 */
function normalizeForDuplicateCheck(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/'/g, "'")
    .replace(/'/g, "'")
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ');
}

/**
 * Ikki nomning o'xshashligini tekshirish
 */
function namesMatch(name1: string, name2: string): boolean {
  // Ko'rinmas belgilarni tozalash
  const cleanName = (s: string) =>
    s
      .toLowerCase()
      .trim()
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/'/g, "'")
      .replace(/'/g, "'")
      .replace(/`/g, "'");

  const n1Lower = cleanName(name1);
  const n2Lower = cleanName(name2);

  // To'liq mos kelish (normalizatsiyasiz)
  if (n1Lower === n2Lower) return true;

  // ========== MUHIM: "shahri" va "tumani" ni aniq farqlash ==========
  // Agar bitta nomda "shahri" bo'lsa va ikkinchisida bo'lmasa - ular MOS EMAS
  const hasShahri1 = n1Lower.includes('shahri') || n1Lower.includes('shahar');
  const hasShahri2 = n2Lower.includes('shahri') || n2Lower.includes('shahar');
  const hasTumani1 = n1Lower.includes('tumani') || n1Lower.includes('tuman');
  const hasTumani2 = n2Lower.includes('tumani') || n2Lower.includes('tuman');

  // Agar biri shahri, ikkinchisi tumani bo'lsa - MOS EMAS
  if ((hasShahri1 && hasTumani2) || (hasTumani1 && hasShahri2)) {
    return false;
  }

  // Agar biri shahri bo'lsa, ikkinchisi ham shahri bo'lishi kerak (yoki ikkalasida ham bo'lmasligi kerak)
  if (hasShahri1 !== hasShahri2) {
    return false;
  }

  // Agar biri tumani bo'lsa, ikkinchisi ham tumani bo'lishi kerak (yoki ikkalasida ham bo'lmasligi kerak)
  if (hasTumani1 !== hasTumani2) {
    return false;
  }

  // ========== Toshkent shahri va Toshkent viloyati ni aniq farqlash ==========
  const isToshkentShahri1 = n1Lower.includes('toshkent') && hasShahri1;
  const isToshkentShahri2 = n2Lower.includes('toshkent') && hasShahri2;
  const isToshkentViloyati1 =
    n1Lower.includes('toshkent') &&
    (n1Lower.includes('viloyati') || n1Lower.includes('viloyat'));
  const isToshkentViloyati2 =
    n2Lower.includes('toshkent') &&
    (n2Lower.includes('viloyati') || n2Lower.includes('viloyat'));

  // Agar biri Toshkent shahri, ikkinchisi Toshkent viloyati bo'lsa - mos emas
  if (
    (isToshkentShahri1 && isToshkentViloyati2) ||
    (isToshkentViloyati1 && isToshkentShahri2)
  ) {
    return false;
  }

  // Toshkent shahri faqat Toshkent shahri bilan mos keladi
  if (isToshkentShahri1 || isToshkentShahri2) {
    return isToshkentShahri1 && isToshkentShahri2;
  }

  // Toshkent viloyati faqat Toshkent viloyati bilan mos keladi
  if (isToshkentViloyati1 || isToshkentViloyati2) {
    return isToshkentViloyati1 && isToshkentViloyati2;
  }

  // ========== Normalizatsiya qilingan versiyalar ==========
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);

  // To'liq mos kelish
  if (n1 === n2) return true;

  // Bir nomi boshqasini o'z ichiga olishi
  // LEKIN faqat "shahri" va "tumani" allaqachon tekshirilgandan keyin
  if (n1.includes(n2) || n2.includes(n1)) return true;

  // Maxsus holatlar (Toshkent bundan mustasno - yuqorida hal qilindi)
  const specialMatches: Record<string, string[]> = {
    andijon: ['andijon viloyati', 'andijon v'],
    "farg'ona": ['fargona', 'fergana'],
    namangan: ['namangan viloyati'],
    samarqand: ['samarkand'],
    buxoro: ['bukhara', 'buxara'],
    navoiy: ['navoi'],
    xorazm: ['khorezm', 'xorezm'],
    surxondaryo: ['surkhandarya'],
    qashqadaryo: ['kashkadarya'],
    jizzax: ['jizzakh', 'djizak'],
    sirdaryo: ['syrdarya'],
    "qoraqalpog'iston": ['karakalpakstan', 'qoraqalpogiston'],
    khiva: ['xiva'],
    khojaobod: ["xo'jaobod"],
  };

  for (const [key, variants] of Object.entries(specialMatches)) {
    if (
      (n1.includes(key) || variants.some((v) => n1.includes(v))) &&
      (n2.includes(key) || variants.some((v) => n2.includes(v)))
    ) {
      return true;
    }
  }

  return false;
}

export interface MatchResult {
  // Muvaffaqiyatli moslanganlar
  matched: {
    dbId: string;
    dbName: string;
    satoCode: string;
    satoName: string;
  }[];

  // Mos kelmagan DB yozuvlari (SATO da yo'q)
  unmatched: {
    dbId: string;
    dbName: string;
    regionName?: string;
    /** Faqat tumanlar uchun (SlMjauWC): nega kod berilmadi. */
    reason?: DistrictUnmatchedReason;
  }[];

  // Dublikat yozuvlar (bir xil nom bir necha marta)
  duplicates: {
    name: string;
    entries: { id: string; regionName?: string }[];
  }[];

  // SATO da bor, lekin DB da yo'q
  missingSatoEntries: {
    satoCode: string;
    satoName: string;
    regionName?: string;
  }[];

  // Statistika
  stats: {
    totalDb: number;
    totalSato: number;
    matchedCount: number;
    unmatchedCount: number;
    duplicatesCount: number;
    missingCount: number;
  };
}

/**
 * Viloyatlarni SATO kodlari bilan moslashtirish
 */
export function matchRegions(
  dbRegions: { id: string; name: string; sato_code?: string | null }[],
): MatchResult {
  const result: MatchResult = {
    matched: [],
    unmatched: [],
    duplicates: [],
    missingSatoEntries: [],
    stats: {
      totalDb: dbRegions.length,
      totalSato: satoRegions.length,
      matchedCount: 0,
      unmatchedCount: 0,
      duplicatesCount: 0,
      missingCount: 0,
    },
  };

  // Dublikatlarni topish
  // normalizeForDuplicateCheck ishlatamiz - "shahri" va "viloyati" farqlanadi
  const nameCount = new Map<string, { id: string; name: string }[]>();
  const duplicateIds = new Set<string>(); // Dublikat ID larni saqlash

  for (const region of dbRegions) {
    const normalized = normalizeForDuplicateCheck(region.name);
    if (!nameCount.has(normalized)) {
      nameCount.set(normalized, []);
    }
    nameCount.get(normalized)!.push({ id: region.id, name: region.name });
  }

  for (const [, entries] of nameCount) {
    if (entries.length > 1) {
      result.duplicates.push({
        name: entries[0].name,
        entries: entries.map((e) => ({ id: e.id })),
      });
      result.stats.duplicatesCount += entries.length;
      // Dublikat ID larni belgilash
      entries.forEach((e) => duplicateIds.add(e.id));
    }
  }

  // SATO bilan moslashtirish
  const usedSatoCodes = new Set<string>();

  for (const dbRegion of dbRegions) {
    const isDuplicate = duplicateIds.has(dbRegion.id);

    // Allaqachon SATO code bor bo'lsa
    if (dbRegion.sato_code) {
      usedSatoCodes.add(dbRegion.sato_code);
      if (!isDuplicate) {
        result.matched.push({
          dbId: dbRegion.id,
          dbName: dbRegion.name,
          satoCode: dbRegion.sato_code,
          satoName: '(allaqachon mavjud)',
        });
        result.stats.matchedCount++;
      }
      continue;
    }

    let found = false;
    for (const satoRegion of satoRegions) {
      if (namesMatch(dbRegion.name, satoRegion.name)) {
        // MUHIM: Har doim usedSatoCodes ga qo'shish (dublikat bo'lsa ham)
        usedSatoCodes.add(satoRegion.sato_code);
        if (!isDuplicate) {
          result.matched.push({
            dbId: dbRegion.id,
            dbName: dbRegion.name,
            satoCode: satoRegion.sato_code,
            satoName: satoRegion.name,
          });
          result.stats.matchedCount++;
        }
        found = true;
        break;
      }
    }

    // Dublikat bo'lmasa va topilmasa - unmatched ga qo'shish
    if (!found && !isDuplicate) {
      result.unmatched.push({
        dbId: dbRegion.id,
        dbName: dbRegion.name,
      });
      result.stats.unmatchedCount++;
    }
  }

  // SATO da bor, lekin DB da yo'q
  for (const satoRegion of satoRegions) {
    if (!usedSatoCodes.has(satoRegion.sato_code)) {
      result.missingSatoEntries.push({
        satoCode: satoRegion.sato_code,
        satoName: satoRegion.name,
      });
      result.stats.missingCount++;
    }
  }

  return result;
}

/**
 * SlMjauWC (N5) — tumanga kod nega berilmadi:
 *   - `region_not_found` — tumanning viloyati SATO ro'yxatida topilmadi;
 *   - `not_found_in_region` — viloyat ichida mos nom yo'q (boshqa viloyatdan
 *     qidirilmaydi);
 *   - `code_taken` — mos kod boshqa tumanda allaqachon bor;
 *   - `ambiguous` — bir nechta mos kod yoki bitta kodga bir nechta tuman.
 */
export type DistrictUnmatchedReason =
  | 'region_not_found'
  | 'not_found_in_region'
  | 'code_taken'
  | 'ambiguous';

/**
 * Tumanning viloyatini SATO ro'yxatidan topish: avval DB viloyatining rasmiy
 * kodi bo'yicha (aniq), bo'lmasa nomi bo'yicha.
 */
function findSatoRegionFor(
  region?: { name?: string | null; sato_code?: string | null } | null,
): SatoRegion | undefined {
  if (!region) return undefined;
  const code = region.sato_code?.trim();
  if (code) {
    const byCode = satoRegions.find((r) => r.sato_code === code);
    if (byCode) return byCode;
  }
  if (!region.name) return undefined;
  return satoRegions.find((r) => namesMatch(r.name, region.name!));
}

/**
 * Tuman kodi viloyat prefiksi bilan boshlanishi shart (SOATO darvozasi):
 * SATO viloyati kodi va — DB viloyatida rasmiy kod bo'lsa — uning kodi.
 */
export function districtCodeFitsRegion(
  districtCode: string,
  satoRegion: { sato_code: string },
  dbRegion?: { sato_code?: string | null } | null,
): boolean {
  if (!districtCode.startsWith(satoRegion.sato_code)) return false;
  const dbCode = dbRegion?.sato_code?.trim();
  if (dbCode && !districtCode.startsWith(dbCode)) return false;
  return true;
}

/**
 * Tumanlarni SATO kodlari bilan moslashtirish
 */
export function matchDistricts(
  dbDistricts: {
    id: string;
    name: string;
    sato_code?: string | null;
    region?: { id: string; name: string; sato_code?: string | null };
  }[],
): MatchResult {
  const result: MatchResult = {
    matched: [],
    unmatched: [],
    duplicates: [],
    missingSatoEntries: [],
    stats: {
      totalDb: dbDistricts.length,
      totalSato: satoRegions.reduce((sum, r) => sum + r.districts.length, 0),
      matchedCount: 0,
      unmatchedCount: 0,
      duplicatesCount: 0,
      missingCount: 0,
    },
  };

  // Dublikatlarni topish - BARCHA viloyatlar bo'yicha bir xil nomli tumanlar
  // normalizeForDuplicateCheck ishlatamiz - "shahri" va "tumani" farqlanadi
  const districtNameCount = new Map<
    string,
    { id: string; name: string; regionName: string; regionId: string }[]
  >();
  const duplicateIds = new Set<string>(); // Dublikat ID larni saqlash

  for (const district of dbDistricts) {
    // Viloyat ID siz key - barcha viloyatlar bo'yicha dublikat tekshirish
    const key = normalizeForDuplicateCheck(district.name);
    if (!districtNameCount.has(key)) {
      districtNameCount.set(key, []);
    }
    districtNameCount.get(key)!.push({
      id: district.id,
      name: district.name,
      regionName: district.region?.name || "Noma'lum",
      regionId: district.region?.id || 'unknown',
    });
  }

  for (const [, entries] of districtNameCount) {
    if (entries.length > 1) {
      // Turli viloyatlardagi dublikatlarni ko'rsatish
      const regionNames = [...new Set(entries.map((e) => e.regionName))].join(
        ', ',
      );
      result.duplicates.push({
        name: `${entries[0].name} (${regionNames})`,
        entries: entries.map((e) => ({ id: e.id, regionName: e.regionName })),
      });
      result.stats.duplicatesCount += entries.length;
      // Dublikat ID larni belgilash
      entries.forEach((e) => duplicateIds.add(e.id));
    }
  }

  // SATO bilan moslashtirish
  const usedSatoCodes = new Set<string>();

  /**
   * SlMjauWC (N5): bitta kod = bitta tuman.
   *
   * 1) Allaqachon kodi bor tumanlar kodni «egallaydi» (`takenBy`) — bu kod
   *    boshqa tumanga BERILMAYDI (ro'yxatdagi tartibdan qat'i nazar).
   * 2) Kod faqat tumanning O'Z viloyati ichidan qidiriladi; boshqa viloyatlar
   *    bo'yicha fallback olib tashlandi (u boshqa viloyat tumanining kodini
   *    berardi). Tuman kodi viloyat SATO prefiksi bilan boshlanishi shart.
   * 3) Aniq nom mosligi substring mosligidan ustun; bitta kodga bir nechta
   *    tuman da'vo qilsa — hech biriga berilmaydi (`unmatched`, sabab bilan).
   */
  const takenBy = new Map<string, string>();
  for (const dbDistrict of dbDistricts) {
    if (dbDistrict.sato_code && !takenBy.has(dbDistrict.sato_code)) {
      takenBy.set(dbDistrict.sato_code, dbDistrict.id);
    }
  }

  const candidates: {
    dbDistrict: (typeof dbDistricts)[number];
    isDuplicate: boolean;
    satoCode: string;
    satoName: string;
    satoRegionName: string;
  }[] = [];

  const pushUnmatched = (
    dbDistrict: (typeof dbDistricts)[number],
    reason: DistrictUnmatchedReason,
  ) => {
    result.unmatched.push({
      dbId: dbDistrict.id,
      dbName: dbDistrict.name,
      regionName: dbDistrict.region?.name,
      reason,
    });
    result.stats.unmatchedCount++;
  };

  for (const dbDistrict of dbDistricts) {
    const isDuplicate = duplicateIds.has(dbDistrict.id);

    // Allaqachon SATO code bor bo'lsa
    if (dbDistrict.sato_code) {
      usedSatoCodes.add(dbDistrict.sato_code);
      if (!isDuplicate) {
        result.matched.push({
          dbId: dbDistrict.id,
          dbName: dbDistrict.name,
          satoCode: dbDistrict.sato_code,
          satoName: '(allaqachon mavjud)',
        });
        result.stats.matchedCount++;
      }
      continue;
    }

    const satoRegion = findSatoRegionFor(dbDistrict.region);
    if (!satoRegion) {
      if (!isDuplicate) pushUnmatched(dbDistrict, 'region_not_found');
      continue;
    }

    const inRegion = satoRegion.districts.filter((d) =>
      districtCodeFitsRegion(d.sato_code, satoRegion, dbDistrict.region),
    );
    const exact = inRegion.filter(
      (d) => normalizeName(d.name) === normalizeName(dbDistrict.name),
    );
    const pool = exact.length
      ? exact
      : inRegion.filter((d) => namesMatch(dbDistrict.name, d.name));
    const free = pool.filter((d) => {
      const owner = takenBy.get(d.sato_code);
      return !owner || owner === dbDistrict.id;
    });

    // MUHIM: topilgan kod (dublikat bo'lsa ham) «SATO da bor, DB da yo'q»
    // ro'yxatidan chiqariladi — eski xulq.
    pool.forEach((d) => usedSatoCodes.add(d.sato_code));

    if (!pool.length) {
      if (!isDuplicate) pushUnmatched(dbDistrict, 'not_found_in_region');
      continue;
    }
    if (!free.length) {
      if (!isDuplicate) pushUnmatched(dbDistrict, 'code_taken');
      continue;
    }
    if (free.length > 1) {
      if (!isDuplicate) pushUnmatched(dbDistrict, 'ambiguous');
      continue;
    }
    candidates.push({
      dbDistrict,
      isDuplicate,
      satoCode: free[0].sato_code,
      satoName: free[0].name,
      satoRegionName: satoRegion.name,
    });
  }

  // Bitta kodga bir nechta tuman da'vo qilsa — hech biriga berilmaydi.
  const claims = new Map<string, number>();
  for (const c of candidates) {
    claims.set(c.satoCode, (claims.get(c.satoCode) ?? 0) + 1);
  }
  for (const c of candidates) {
    if (c.isDuplicate) continue;
    if ((claims.get(c.satoCode) ?? 0) > 1) {
      pushUnmatched(c.dbDistrict, 'ambiguous');
      continue;
    }
    result.matched.push({
      dbId: c.dbDistrict.id,
      dbName: `${c.dbDistrict.name} (${c.dbDistrict.region?.name || "Noma'lum"})`,
      satoCode: c.satoCode,
      satoName: `${c.satoName} (${c.satoRegionName})`,
    });
    result.stats.matchedCount++;
  }

  // SATO da bor, lekin DB da yo'q
  for (const satoRegion of satoRegions) {
    for (const satoDistrict of satoRegion.districts) {
      if (!usedSatoCodes.has(satoDistrict.sato_code)) {
        result.missingSatoEntries.push({
          satoCode: satoDistrict.sato_code,
          satoName: satoDistrict.name,
          regionName: satoRegion.name,
        });
        result.stats.missingCount++;
      }
    }
  }

  return result;
}
