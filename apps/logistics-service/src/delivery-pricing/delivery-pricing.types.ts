/**
 * DAqXPeSy — yetkazish narxi RPC kontrakti (logistics-service).
 *
 *   logistics.delivery.quote             — hisob (hech narsa yozmaydi)
 *   logistics.delivery.tariffs.find_all  — hozirgi tariflar + versiyalar tarixi
 *   logistics.delivery.tariffs.create    — yangi tarif versiyasi
 *   logistics.delivery.settings.get      — faol sozlama
 *   logistics.delivery.settings.update   — sozlama (yangi versiya)
 *   logistics.delivery.settings.history  — sozlama versiyalari (yangisi tepada)
 */
export const DELIVERY_PRICING_PATTERNS = {
  QUOTE: 'logistics.delivery.quote',
  QUOTE_BY_TARIFF: 'logistics.delivery.quote_by_tariff',
  TARIFFS_FIND_ALL: 'logistics.delivery.tariffs.find_all',
  TARIFFS_CREATE: 'logistics.delivery.tariffs.create',
  SETTINGS_GET: 'logistics.delivery.settings.get',
  SETTINGS_UPDATE: 'logistics.delivery.settings.update',
  SETTINGS_HISTORY: 'logistics.delivery.settings.history',
} as const;

/** Bitta hisobdagi elementlar chegarasi (gateway DTO bilan AYNI). */
export const DELIVERY_QUOTE_MAX_ITEMS = 200;

/** `delivery_pricing_settings` ning formula ustunlari (PATCH oq ro'yxati). */
export const DELIVERY_PRICING_SETTINGS_FIELDS = [
  'volumetric_divisor',
  'first_kg_included',
  'min_billable_kg',
  'billable_step_kg',
  'round_to',
  'pickup_fee',
  'pickup_free_from_count',
  'express_multiplier',
] as const;

export type DeliveryPricingSettingsField =
  (typeof DELIVERY_PRICING_SETTINGS_FIELDS)[number];

export interface DeliveryPricingRequester {
  id: string;
  roles?: string[];
}

export interface DeliveryQuoteItemPayload {
  /** Berilsa o'lchov catalog'dan olinadi (o'lchov maydonlari bilan birga — 400). */
  product_id?: string | number | null;
  weight_kg?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  volumetric_enabled?: boolean | null;
  quantity?: number | null;
}

/**
 * `logistics.delivery.quote_by_tariff` — yo'nalishsiz: bir xil elementlar uchun
 * UCHALA tarif (city / center / address) bo'yicha narx. Mahsulot formasidagi
 * «Taxminiy yetkazish narxi» bloki uchun (6FLyjO6j) — hudud hali ma'lum emas.
 */
export interface DeliveryQuoteByTariffPayload {
  items: DeliveryQuoteItemPayload[];
  express?: boolean;
  requester?: DeliveryPricingRequester;
}

export interface DeliveryQuotePayload {
  items: DeliveryQuoteItemPayload[];
  from_region_id?: string | null;
  from_district_id?: string | null;
  to_region_id?: string | null;
  to_district_id?: string | null;
  where_deliver: string;
  express?: boolean;
  /** Bitta pickup tashrifidagi posilkalar soni; pickup narxi `total` ga kirmaydi. */
  pickup_count?: number;
  requester?: DeliveryPricingRequester;
}

export interface ListDeliveryTariffsPayload {
  tariff_id?: string;
  limit?: number;
}

export interface CreateDeliveryTariffPayload {
  tariff_id: string;
  base_price: number;
  extra_per_kg: number;
  days_min: number;
  days_max: number;
  /** ISO sana-vaqt; berilmasa — hozir. O'tmish — 400. */
  valid_from?: string | null;
}

export type UpdateDeliveryPricingSettingsPayload = Partial<
  Record<DeliveryPricingSettingsField, number | null>
>;
