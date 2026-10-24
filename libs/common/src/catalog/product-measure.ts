/**
 * MH-3 (9fHyFp3y): mahsulot o'lchovi chegaralari — gateway DTO va
 * catalog-service AYNI qiymatlardan foydalanadi (bitta manba).
 *
 * Birliklar (karta qarori): og'irlik — KG, kasrli (`numeric(10,3)`);
 * o'lchamlar — SM, butun son (`integer`). DB'da faqat `> 0` CHECK bor —
 * yuqori chegara ilova darajasida (ega tasdiqlaguncha TAKLIF: 1000 kg,
 * 1000 sm; o'zgartirish uchun shu fayl kifoya).
 */
export const PRODUCT_WEIGHT_KG_MIN = 0.001;
export const PRODUCT_WEIGHT_KG_MAX = 1000;
/** `numeric(10,3)` — ko'pi bilan 3 kasr (gramm aniqligi). */
export const PRODUCT_WEIGHT_KG_DECIMALS = 3;

export const PRODUCT_DIMENSION_CM_MIN = 1;
export const PRODUCT_DIMENSION_CM_MAX = 1000;

/** hY7uacJu: zavod shtrix kodi / QR matni — `character varying(512)`. */
export const PRODUCT_BARCODE_MAX_LENGTH = 512;

/** O'lchov maydonlari (DTO, entity, audit va qidiruv indeksida bir xil nom). */
export const PRODUCT_MEASURE_FIELDS = [
  'weight_kg',
  'length_cm',
  'width_cm',
  'height_cm',
  'volumetric_enabled',
] as const;

/** L × W × H — narx dvigateli (DAqXPeSy) uchun «uchalasi yoki hech biri». */
export const PRODUCT_DIMENSION_FIELDS = [
  'length_cm',
  'width_cm',
  'height_cm',
] as const;

export type ProductDimensionField = (typeof PRODUCT_DIMENSION_FIELDS)[number];
