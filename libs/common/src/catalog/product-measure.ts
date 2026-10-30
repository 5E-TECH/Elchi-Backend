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

/**
 * 6tGZzupr — «o'lchov kutilmoqda». Saqlanmaydi, o'lchovdan KELIB CHIQADI: narx
 * dvigatelining `estimated` qoidasi bilan AYNI (og'irlik yo'q yoki hajm yoqiq
 * va L/W/H yo'q). Shuning uchun xodim o'lchov kiritishi bilan holat o'zi
 * tushadi. Ro'yxat filtri — catalog-service `PRODUCT_NEEDS_MEASUREMENT_SQL`.
 */
export function productNeedsMeasurement(row: {
  weight_kg?: number | string | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  volumetric_enabled?: boolean | null;
}): boolean {
  const missing = (value: unknown) => value === null || value === undefined;
  if (missing(row.weight_kg)) return true;
  if (row.volumetric_enabled === false) return false;
  return PRODUCT_DIMENSION_FIELDS.some((field) => missing(row[field]));
}

/** 6tGZzupr: `catalog.product.create` / `fill_missing_measure` chaqiruvchisi. */
export interface ProductRequester {
  id: string;
  roles: string[];
  /** Ichki yo'l qayerdan kelgani (jurnal uchun), masalan `partner:7`. */
  via?: string;
}

/** Odam emas, tizim: hamkor posilkasidan avtomatik mahsulot. */
export const PRODUCT_SYSTEM_ROLE = 'system';

export function productSystemRequester(via: string): ProductRequester {
  return { id: PRODUCT_SYSTEM_ROLE, roles: [PRODUCT_SYSTEM_ROLE], via };
}
