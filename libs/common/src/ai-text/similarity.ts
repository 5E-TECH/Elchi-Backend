/**
 * Deterministik matn o'xshashligi: Levenshtein, `simRatio`, fuzzy-substring
 * va so'z darajasidagi fuzzy.
 *
 * Manba: BeePost `ai-order.service.ts` (origin/dev) — `levenshtein` :1884-1899,
 * `simRatio` :1872-1882, `bestSubstringSim` :1852-1870, `tokenFuzzy`
 * :1832-1850. Mantiq 1:1; farqlar:
 *   - bo'sag'alar kodga yozib qo'yilmagan — nomli konstanta sifatida
 *     eksport qilinadi (tuman va mahsulot rezolverlari ularni Elchi
 *     ma'lumotiga qarab sozlaydi);
 *   - `tokenFuzzy` satr ham qabul qiladi (bo'shliq bo'yicha bo'linadi).
 *
 * LLM'siz, DB'siz, tarmoqsiz — CI'da bepul va tez testlanadi.
 */

/**
 * `simRatio` uzunlik qat'iyligi: qisqa satr uzunining shu ulushidan kam
 * bo'lsa, Levenshtein hisoblanmaydi — natija 0.
 *
 * ⚠️ `PRODUCT_CANDIDATE_MIN` bilan qiymati bir xil (0.4), lekin ma'nosi
 * boshqa — ATAYLAB alohida konstanta. Birini sozlash ikkinchisini
 * o'zgartirib yubormasin.
 */
export const SIM_LENGTH_RATIO_MIN = 0.4;

/**
 * `bestSubstringSim` uchun ignaning (needle) minimal uzunligi. Undan qisqa
 * (1-3 harfli) nom manzil matni ichida tasodifan juda ko'p joyda "topilib"
 * qoladi.
 */
export const SUBSTRING_MIN_NEEDLE = 4;

/**
 * Operatorga ko'rsatiladigan nomzodlarning (tuman yoki mahsulot) maksimal
 * soni. BeePost'da `MAX_CANDIDATE_BUTTONS = 5`.
 */
export const AI_MAX_CANDIDATES = 5;

/** Klassik Levenshtein masofasi (ikki qatorli DP, O(m·n) vaqt, O(n) xotira). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Levenshtein nisbati (0..1) — IKKI QAT'IY himoya bilan.
 *
 * ⚠️ RAQAM QAT'IYLIGI: satrlardan birida raqam bo'lsa (o'lcham/model:
 * "700 gr", "a51") faqat ANIQ tenglik 1 beradi, qolgani 0. Aks holda
 * "700"->"500", "a51"->"a50" fuzzy bilan avto-tanlanib, boshqa SKU/narxdagi
 * mahsulot jimgina buyurtmaga tushadi. BeePost'da eng ko'p pul yo'qotgan xato
 * shu edi — bu qoidani OLIB TASHLAMANG.
 *
 * ⚠️ UZUNLIK QAT'IYLIGI: qisqa satr uzunning `SIM_LENGTH_RATIO_MIN` ulushidan
 * kam bo'lsa — Levenshteinsiz 0 ("olma" vs "olma va uzum sharbati").
 */
export function simRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (/\d/.test(a) || /\d/.test(b)) return 0;
  const m = Math.max(a.length, b.length);
  if (Math.min(a.length, b.length) < m * SIM_LENGTH_RATIO_MIN) return 0;
  return m ? 1 - levenshtein(a, b) / m : 0;
}

/**
 * `needle`ning `hay` ichidagi ENG YAXSHI fuzzy-substring mosligi (0..1).
 * Manzil matni ichidan tuman nomini (imlo xato bilan) topish uchun —
 * odatda bo'shliqsiz skeletlar ustida chaqiriladi.
 *
 * Oyna uzunligi `needle` uzunligi ±1 (bitta harf tushib qolgan yoki
 * ortiqcha bo'lgan imlo xatosi). Ignasi `SUBSTRING_MIN_NEEDLE` dan qisqa
 * bo'lsa 0.
 *
 * ⚠️ Bu yerda raqam/uzunlik qat'iyligi YO'Q (BeePost bilan bir xil) —
 * chaqiruvchi o'z bo'sag'asini (`GEO_SUBSTRING_MIN`) qo'llaydi.
 */
export function bestSubstringSim(hay: string, needle: string): number {
  const n = needle.length;
  if (n < SUBSTRING_MIN_NEEDLE) return 0;
  if (hay.length <= n) {
    const m = Math.max(hay.length, n);
    return m ? 1 - levenshtein(hay, needle) / m : 0;
  }
  let best = 0;
  for (let len = n - 1; len <= n + 1; len++) {
    if (len < SUBSTRING_MIN_NEEDLE) continue;
    for (let i = 0; i + len <= hay.length; i++) {
      const win = hay.slice(i, i + len);
      const r = 1 - levenshtein(win, needle) / Math.max(len, n);
      if (r > best) best = r;
      if (best === 1) return 1;
    }
  }
  return best;
}

function toTokens(v: string | readonly string[]): string[] {
  const list = typeof v === 'string' ? v.split(/\s+/) : v;
  return list.filter(Boolean);
}

/**
 * Har bir so'rov so'ziga eng yaqin mahsulot so'zini (`simRatio`) topib,
 * o'rtacha o'xshashlik — so'z SONI farqiga jarima bilan.
 *
 * ⚠️ Jarima (`min(soni)/max(soni)`) OLIB TASHLANMASIN: "olma sharbat" va
 * "olma va uzum sharbat" (superset — boshqa SKU/narx) so'zma-so'z to'liq mos
 * keladi, jarimasiz natija 1 bo'lib, jimgina avto-tanlanardi. Jarima bilan
 * 1 × 2/4 = 0.5.
 *
 * Satr berilsa bo'shliq (`/\s+/`) bo'yicha bo'linadi; normalizatsiya
 * QILINMAYDI — chaqiruvchi avval `normalizeProduct` / `normGeo` qo'llaydi.
 */
export function tokenFuzzy(
  q: string | readonly string[],
  p: string | readonly string[],
): number {
  const qTokens = toTokens(q);
  const pTokens = toTokens(p);
  if (!qTokens.length || !pTokens.length) return 0;
  let sum = 0;
  for (const qt of qTokens) {
    let best = 0;
    for (const pt of pTokens) {
      const r = simRatio(qt, pt);
      if (r > best) best = r;
    }
    sum += best;
  }
  const avg = sum / qTokens.length;
  const countPenalty =
    Math.min(qTokens.length, pTokens.length) /
    Math.max(qTokens.length, pTokens.length);
  return avg * countPenalty;
}
