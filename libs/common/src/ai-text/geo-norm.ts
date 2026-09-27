/**
 * Geografik nomlarni (viloyat, tuman) taqqoslash uchun normalizatsiya va
 * viloyat nomi -> SOATO alias jadvali.
 *
 * Manba: BeePost `ai-order.service.ts` (origin/dev) — `lightNorm` :1950-1953,
 * `normGeo` :1955-1969 (1:1). `regionAlias` / `REGION_ALIASES` — Elchi uchun
 * YANGI (BeePost'dagi "0-qadam" viloyat qidiruvi :1514-1560 o'rniga).
 *
 * NEGA YANGI: Elchi `GET /region` nomlari YALANG'OCH — "Toshkent" (id=2,
 * sato 1727 = VILOYAT) va "Toshkent shahri" (id=1, sato 1726). Seed faylida
 * (`apps/logistics-service/src/data/regions-districts.data.ts`) esa 11 ta
 * nom ortiqcha probel bilan ("Toshkent ", "Andijon ", ...). Shuning uchun
 * viloyat DB nomi bo'yicha emas, SOATO kodi bo'yicha qulflanadi.
 */
import { simRatio } from './similarity';
import { translit } from './uz-translit';

/**
 * Tuman/viloyat fuzzy (Levenshtein) mosligining minimal bali. BeePost
 * :1550 (viloyat) va :1635 (tuman, 3-usul).
 */
export const GEO_FUZZY_MIN = 0.72;

/**
 * Fuzzy g'olibdan shu farqdan kam orqada qolgan tumanlar ham "yaqin" —
 * bitta avto-tanlov o'rniga nomzodlar ro'yxati ko'rsatiladi. BeePost :1639.
 */
export const GEO_FUZZY_NEAR_DELTA = 0.08;

/**
 * Viloyat fuzzy g'olibi ikkinchi o'rindan kamida shuncha oldinda bo'lishi
 * shart; aks holda viloyat NOANIQ qoladi. BeePost :1551.
 */
export const GEO_REGION_FUZZY_MARGIN = 0.1;

/**
 * Manzil matni ichidan tuman nomini fuzzy-substring (`bestSubstringSim`)
 * bilan topishning minimal bali. BeePost :1690 (4-usul).
 */
export const GEO_SUBSTRING_MIN = 0.82;

/**
 * Yengil normalizatsiya — geografik qo'shimchalarni (shahri/viloyati)
 * SAQLAYDI. "Toshkent shahri" != "Toshkent viloyati" farqi yo'qolmasin.
 * `translit` (kirill->lotin + diakritik + apostrof) + "kh" = "x".
 */
export function lightNorm(s: string | null | undefined): string {
  return translit(s).replace(/kh/g, 'x').replace(/\s+/g, ' ').trim();
}

/**
 * Geografik nomni BASE holatga keltiradi: tumani/tuman/shahri/shahar/
 * shaharcha/viloyati/viloyat/respublikasi, "sh." va "t." qo'shimchalarini
 * olib tashlaydi (operator odatda qo'shimcha yozmaydi, DB nomida esa bor).
 *
 * ⚠️ Qo'shimchalar faqat ALOHIDA so'z sifatida olib tashlanadi (so'z
 * chegarasi `\b`): "Shahrixon" / "Shahrisabz" ichidagi "shahri" TEGILMAYDI.
 * Natijada "Toshkent shahri" va "Toshkent viloyati" ikkalasi "toshkent"
 * bo'ladi — ularni ajratish uchun `lightNorm` yoki `regionAlias` ishlating.
 */
export function normGeo(s: string | null | undefined): string {
  return (
    translit(s)
      // Transliteratsiya: "kh" = "x" (Khiva=Xiva, Khorazm=Xorazm).
      .replace(/kh/g, 'x')
      .replace(
        /\s*(\b(?:tumani|tuman|shahri|shahar|shaharcha|viloyati|viloyat|respublikasi)\b|\b(?:sh|t)\.)\s*/g,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** `REGION_ALIASES` qatori: bitta viloyat (yoki Toshkent shahri). */
export interface RegionAliasRow {
  /** Viloyat SOATO kodi (4 raqam) — `regions.sato_code` bilan bir xil. */
  readonly sato: string;
  /**
   * Rasmiy nom — `apps/logistics-service/src/data/sato-codes.ts` dan.
   * Nomzod yorlig'ida ishlatiladi ("Toshkent viloyati, Chirchiq").
   */
  readonly canonical: string;
  /**
   * Viloyatning ASOS nomlari: o'zbek lotin, o'zbek kirill (translit'dan
   * keyingi ko'rinishi) va rus/ingliz shakllari. Taqqoslashdan oldin
   * `normGeo` bilan normallanadi, ya'ni "khorezm" -> "xorezm",
   * "farg'ona" -> "fargona" avtomatik mos keladi.
   */
  readonly bases: readonly string[];
}

const TOSHKENT_CITY_SATO = '1726';
const TOSHKENT_REGION_SATO = '1727';

/**
 * 14 viloyat (Toshkent shahri alohida) -> SOATO. Rus/ingliz shakllari
 * `apps/logistics-service/src/utils/sato-matcher.ts:129-144` dagi
 * `specialMatches` ro'yxatidan literal ko'chirilgan (u yerdagi `khiva` va
 * `khojaobod` — TUMAN, viloyat emas, shuning uchun bu yerga kirmagan).
 *
 * ⚠️ "Toshkent shahri" (1726) va "Toshkent viloyati" (1727) ASOSI BIR XIL
 * ("toshkent") — ular faqat shahar/viloyat markeri bilan ajraladi, markersiz
 * yalang'och "Toshkent" ATAYLAB noaniq (`regionAlias` null qaytaradi).
 */
export const REGION_ALIASES: ReadonlyArray<RegionAliasRow> = Object.freeze(
  [
    {
      sato: '1703',
      canonical: 'Andijon viloyati',
      bases: ['andijon', 'andijan', 'andijon viloyati', 'andijon v'],
    },
    {
      sato: '1706',
      canonical: 'Buxoro viloyati',
      bases: ['buxoro', 'bukhara', 'buxara'],
    },
    {
      sato: '1708',
      canonical: 'Jizzax viloyati',
      bases: ['jizzax', 'jizzakh', 'djizak'],
    },
    {
      sato: '1710',
      canonical: 'Qashqadaryo viloyati',
      bases: ['qashqadaryo', 'kashkadarya'],
    },
    {
      sato: '1712',
      canonical: 'Navoiy viloyati',
      bases: ['navoiy', 'navoi'],
    },
    {
      sato: '1714',
      canonical: 'Namangan viloyati',
      bases: ['namangan', 'namangan viloyati'],
    },
    {
      sato: '1718',
      canonical: 'Samarqand viloyati',
      bases: ['samarqand', 'samarkand'],
    },
    {
      sato: '1722',
      canonical: 'Surxondaryo viloyati',
      bases: ['surxondaryo', 'surkhandarya'],
    },
    {
      sato: '1724',
      canonical: 'Sirdaryo viloyati',
      bases: ['sirdaryo', 'syrdarya', 'sirdarya'],
    },
    {
      sato: TOSHKENT_CITY_SATO,
      canonical: 'Toshkent shahri',
      bases: ['toshkent', 'tashkent'],
    },
    {
      sato: TOSHKENT_REGION_SATO,
      canonical: 'Toshkent viloyati',
      bases: ['toshkent', 'tashkent'],
    },
    {
      sato: '1730',
      canonical: "Farg'ona viloyati",
      bases: ["farg'ona", 'fargona', 'fergana'],
    },
    {
      sato: '1733',
      canonical: 'Xorazm viloyati',
      bases: ['xorazm', 'khorezm', 'xorezm'],
    },
    {
      sato: '1735',
      canonical: "Qoraqalpog'iston Respublikasi",
      bases: ["qoraqalpog'iston", 'karakalpakstan', 'qoraqalpogiston'],
    },
  ].map((row) => Object.freeze({ ...row, bases: Object.freeze(row.bases) })),
);

/**
 * Shahar markeri: shahri | shahar | sh | sh. | city | gorod. `lightNorm`
 * natijasida (ya'ni translit'dan KEYIN) qidiriladi: "Тошкент шаҳри" ham
 * topiladi. Alohida so'z bo'lishi shart — "Shahrixon" marker emas.
 */
const CITY_MARKER_RE =
  /(?<![\p{L}\p{N}])(?:shahri|shahar|sh|city|gorod)(?![\p{L}\p{N}])/u;

/** Viloyat markeri: viloyati | viloyat | vil | vil. | oblast | obl | obl. */
const REGION_MARKER_RE =
  /(?<![\p{L}\p{N}])(?:viloyati|viloyat|vil|oblast|obl)(?![\p{L}\p{N}])/u;

/**
 * `normGeo` bilmaydigan marker qisqartmalari (vil., obl., oblast, city,
 * gorod, nuqtasiz sh). Ular ASOSdan olib tashlanadi — aks holda
 * "Toshkent vil." markerni topsa ham asosi "toshkent vil." bo'lib qolardi.
 */
const EXTRA_MARKER_RE =
  /(?<![\p{L}\p{N}])(?:oblast|obl|vil|city|gorod|sh)(?![\p{L}\p{N}])\.?/gu;

/**
 * Viloyat nomining taqqoslanadigan asosi: `normGeo`, so'ng qo'shimcha marker
 * qisqartmalari va tinish belgilari olib tashlanadi.
 */
function regionBase(s: string | null | undefined): string {
  return normGeo(s)
    .replace(EXTRA_MARKER_RE, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normallangan asos -> SOATO (Toshkent asoslaridan tashqari). */
const BASE_TO_SATO = new Map<string, string>();
/** Toshkent shahri va viloyatining umumiy asoslari — faqat marker hal qiladi. */
const TOSHKENT_BASES = new Set<string>();
/** Fuzzy qidiruv korpusi (Toshkent qatorlari ATAYLAB kiritilmagan). */
const FUZZY_ROWS: { sato: string; bases: string[] }[] = [];

for (const row of REGION_ALIASES) {
  const bases = [...new Set(row.bases.map(regionBase).filter(Boolean))];
  const isToshkent =
    row.sato === TOSHKENT_CITY_SATO || row.sato === TOSHKENT_REGION_SATO;
  for (const base of bases) {
    if (isToshkent) TOSHKENT_BASES.add(base);
    else BASE_TO_SATO.set(base, row.sato);
  }
  if (!isToshkent) FUZZY_ROWS.push({ sato: row.sato, bases });
}

/**
 * Viloyat nomini (AI yoki operator yozgan) viloyat SOATO kodiga
 * aylantiradi; aniqlab bo'lmasa `null`.
 *
 * Algoritm:
 *   1. `lightNorm` (translit'dan keyin) ustida shahar yoki viloyat markeri
 *      qidiriladi.
 *   2. Asos = `normGeo` (+ marker qisqartmalari va tinish belgilarisiz).
 *   3. Asos "toshkent"/"tashkent" bo'lsa — FAQAT marker hal qiladi:
 *      shahar markeri -> 1726, viloyat markeri -> 1727, markersiz yoki
 *      ikkalasi bo'lsa -> null.
 *   4. Asos jadvalda aniq bo'lsa — o'sha SOATO.
 *   5. Aks holda fuzzy: `simRatio >= GEO_FUZZY_MIN` va ikkinchi o'rindan
 *      kamida `GEO_REGION_FUZZY_MARGIN` oldinda bo'lsa. Toshkentga fuzzy
 *      HECH QACHON qo'llanmaydi.
 *
 * ⚠️ Yalang'och "Toshkent" ATAYLAB null: Elchi'da u ham viloyat (DB nomi
 * "Toshkent", sato 1727), ham operatorlar tilida shahar. Taxmin qilingan
 * noto'g'ri viloyat tuman qidiruvini noto'g'ri hovuzga qulflab qo'yadi —
 * null bo'lsa tuman viloyatni o'zi aniqlaydi.
 */
export function regionAlias(name: string | null | undefined): string | null {
  const light = lightNorm(name);
  if (!light) return null;
  const hasCityMarker = CITY_MARKER_RE.test(light);
  const hasRegionMarker = REGION_MARKER_RE.test(light);

  const base = regionBase(name);
  if (!base) return null;

  if (TOSHKENT_BASES.has(base)) {
    if (hasCityMarker && !hasRegionMarker) return TOSHKENT_CITY_SATO;
    if (hasRegionMarker && !hasCityMarker) return TOSHKENT_REGION_SATO;
    return null;
  }

  const exact = BASE_TO_SATO.get(base);
  if (exact) return exact;

  // FUZZY: imlo xatosi ("Andijn" -> "Andijon"). Faqat aniq g'olib bo'lsa;
  // teng raqobatda (ikki viloyatga bir xil yaqin) null.
  if (base.length < 3) return null;
  const scored = FUZZY_ROWS.map((row) => ({
    sato: row.sato,
    s: Math.max(...row.bases.map((b) => simRatio(base, b))),
  }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  if (
    scored.length &&
    scored[0].s >= GEO_FUZZY_MIN &&
    (scored.length === 1 ||
      scored[0].s - scored[1].s >= GEO_REGION_FUZZY_MARGIN)
  ) {
    return scored[0].sato;
  }
  return null;
}
