/**
 * Mahsulot nomini katalog bilan taqqoslash uchun normalizatsiya va
 * mahsulot tanlash bo'sag'alari.
 *
 * Manba: BeePost `ai-order.service.ts` (origin/dev) — `normalizeProduct`
 * :1919-1924 (1:1); bo'sag'alar `rankProducts` :1794-1830 va avto-tanlash
 * qoidasi :1774-1779 dan nomli konstantaga chiqarilgan.
 */
import { translit } from './uz-translit';

/** Normallangan nom katalogdagi nom bilan AYNAN teng — eng yuqori bal. */
export const PRODUCT_EXACT_SCORE = 1;

/**
 * Biri ikkinchisining ichida (substring). ⚠️ `PRODUCT_AUTO_MIN` dan PAST
 * ATAYLAB: qo'shimcha so'z boshqa SKU bo'lishi mumkin — nomzod sifatida
 * ko'rinadi, lekin avto-tanlanmaydi.
 */
export const PRODUCT_SUBSTRING_SCORE = 0.8;

/**
 * Avto-tanlash uchun minimal bal (aniq tenglikdan tashqari hollarda).
 * Undan pastini operator tasdiqlaydi — semantik xato mahsulot jimgina
 * buyurtmaga tushmasin.
 */
export const PRODUCT_AUTO_MIN = 0.85;

/**
 * Avto-tanlashda g'olib ikkinchi nomzoddan kamida shuncha oldinda bo'lishi
 * shart (`PRODUCT_AUTO_MIN` bilan birga).
 */
export const PRODUCT_AUTO_MARGIN = 0.2;

/**
 * Nomzodlar ro'yxatiga kirish uchun minimal bal.
 *
 * ⚠️ `SIM_LENGTH_RATIO_MIN` bilan qiymati bir xil (0.4), lekin ma'nosi
 * boshqa — ATAYLAB alohida konstanta.
 */
export const PRODUCT_CANDIDATE_MIN = 0.4;

/**
 * Mahsulot nomini taqqoslanadigan skeletga keltiradi: `translit`, so'ng
 * miqdor so'zlari (dona, ta, pcs, sht, shtuk) alohida so'z sifatida olib
 * tashlanadi va bo'shliqlar tekislanadi.
 *
 * ⚠️ Raqamlar SAQLANADI ("700 gr", "a51") — ular `simRatio` raqam
 * qat'iyligi uchun kerak.
 */
export function normalizeProduct(s: string | null | undefined): string {
  return translit(s)
    .replace(/\b(dona|ta|pcs|sht|shtuk)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
