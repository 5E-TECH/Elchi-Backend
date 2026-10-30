import { BadRequestException } from '@nestjs/common';
import {
  PRODUCT_DIMENSION_CM_MAX,
  PRODUCT_DIMENSION_CM_MIN,
  PRODUCT_DIMENSION_FIELDS,
  PRODUCT_WEIGHT_KG_MIN,
  type MarketTariffSource,
  type ProductDimensionField,
  toSaleEngineQuote,
} from '@app/common';
import { toPublicQuote } from './public-delivery-pricing/public-delivery-pricing';

/**
 * 6tGZzupr — `GET /partner/tariff`: sof yordamchilar (Nest controller'siz,
 * alohida test qilinadi).
 *
 * HISOB BU YERDA EMAS: narx logistics-service'dagi `computeDeliveryQuote` da,
 * market tarifi `@app/common` `resolveOrderTariffDetailed` da. Bu fayl faqat
 * query'ni tekshiradi va RPC yuki / javob shaklini yig'adi.
 */

/**
 * Query JAMI posilka uchun (bir nechta mahsulot — yig'indi), shuning uchun
 * og'irlik chegarasi bitta mahsulotnikidan (`PRODUCT_WEIGHT_KG_MAX`) katta.
 */
export const PARTNER_TARIFF_WEIGHT_KG_MAX = 10_000;

const DECIMAL_KG = /^\d+(?:\.\d{1,3})?$/;
const WHOLE_NUMBER = /^\d+$/;
const ID_PATTERN = /^\d{1,18}$/;

/** `@Query()` — xom qiymatlar (bir kalit ikki marta kelsa massiv bo'ladi). */
export type PartnerTariffQuery = Record<string, unknown>;

export interface PartnerParcelMeasure {
  weight_kg?: number;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
}

export interface PartnerTariffInput {
  /** NULL — o'lchov berilmagan. */
  measure: PartnerParcelMeasure | null;
  express: boolean;
  pickup: boolean;
  regionId: string | null;
  districtId: string | null;
}

export interface PartnerTariffPayload {
  elchi_market_id: string;
  where_deliver: string;
  /** Elchi sotuvda oladigan summa (`resolveOrderTariffDetailed`). */
  market_tariff: number;
  tariff_source: MarketTariffSource;
  /** O'lchov yo'q yoki chala — narx baza tarif, taxminiy. */
  estimated: boolean;
  /** Dvigatel hisobi; so'ralmagan yoki javob bermagan bo'lsa — null. */
  quote: Record<string, unknown> | null;
}

const fail = (message: string): never => {
  throw new BadRequestException(message);
};

const readText = (
  query: PartnerTariffQuery | undefined,
  field: string,
): string | undefined => {
  const raw = query?.[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    return fail(`${field} — bitta qiymat bo'lishi kerak`);
  }
  return raw.trim() || undefined;
};

const readWeight = (query?: PartnerTariffQuery): number | undefined => {
  const text = readText(query, 'weight_kg');
  if (text === undefined) return undefined;
  const value = DECIMAL_KG.test(text) ? Number(text) : Number.NaN;
  if (!(
    value >= PRODUCT_WEIGHT_KG_MIN && value <= PARTNER_TARIFF_WEIGHT_KG_MAX
  )) {
    return fail(
      `weight_kg — 0 dan katta, ko'pi bilan 3 kasrli son (kg), ${PARTNER_TARIFF_WEIGHT_KG_MAX} kg gacha`,
    );
  }
  return value;
};

const readDimension = (
  query: PartnerTariffQuery | undefined,
  field: ProductDimensionField,
): number | undefined => {
  const text = readText(query, field);
  if (text === undefined) return undefined;
  const value = WHOLE_NUMBER.test(text) ? Number(text) : Number.NaN;
  if (!(
    value >= PRODUCT_DIMENSION_CM_MIN && value <= PRODUCT_DIMENSION_CM_MAX
  )) {
    return fail(
      `${field} — ${PRODUCT_DIMENSION_CM_MIN} dan ${PRODUCT_DIMENSION_CM_MAX} gacha butun son (sm)`,
    );
  }
  return value;
};

const readFlag = (query: PartnerTariffQuery | undefined, field: string) => {
  const text = readText(query, field)?.toLowerCase();
  if (text === undefined || text === 'false' || text === '0') return false;
  if (text === 'true' || text === '1') return true;
  return fail(`${field} — true yoki false bo'lishi kerak`);
};

const readId = (query: PartnerTariffQuery | undefined, field: string) => {
  const text = readText(query, field);
  if (text === undefined) return null;
  return ID_PATTERN.test(text)
    ? text
    : fail(`${field} — raqamli id bo'lishi kerak`);
};

/** Yangi query'lar ixtiyoriy; noto'g'ri qiymat — 400 (jimgina 0 emas). */
export function parsePartnerTariffQuery(
  query?: PartnerTariffQuery,
): PartnerTariffInput {
  const measure: PartnerParcelMeasure = {};
  const weight = readWeight(query);
  if (weight !== undefined) measure.weight_kg = weight;
  for (const field of PRODUCT_DIMENSION_FIELDS) {
    const value = readDimension(query, field);
    if (value !== undefined) measure[field] = value;
  }
  const dimensions = PRODUCT_DIMENSION_FIELDS.filter(
    (field) => measure[field] !== undefined,
  ).length;
  if (dimensions !== 0 && dimensions !== PRODUCT_DIMENSION_FIELDS.length) {
    fail('length_cm, width_cm, height_cm uchalasi birga yuboriladi');
  }
  return {
    measure: Object.keys(measure).length ? measure : null,
    express: readFlag(query, 'express'),
    pickup: readFlag(query, 'pickup'),
    regionId: readId(query, 'region_id'),
    districtId: readId(query, 'district_id'),
  };
}

/**
 * `logistics.delivery.sale_quote` yuki: jo'natuvchi — market profili,
 * qabul qiluvchi — so'rovdagi hudud (sotuvdagi `buildSaleQuotePayload` bilan
 * bir xil). O'lchovsiz — bitta katalogsiz element (`unmeasuredItems`).
 */
export function buildPartnerQuotePayload(
  mode: 'center' | 'address',
  market: { region_id?: string | null; district_id?: string | null },
  input: PartnerTariffInput,
) {
  return {
    where_deliver: mode,
    from_region_id: market.region_id ?? null,
    from_district_id: market.district_id ?? null,
    to_region_id: input.regionId,
    to_district_id: input.districtId,
    items: [
      input.measure
        ? { ...input.measure, quantity: 1 }
        : { product_id: null, quantity: 1 },
    ],
    express: input.express,
    pickup_count: input.pickup ? 1 : 0,
  };
}

/** `sale_quote` javobi → `resolveOrderTariffDetailed` kirishi. */
export function toPartnerEngineQuote(data: Record<string, unknown>) {
  const min = data.min_delivery_price;
  return toSaleEngineQuote({
    extra: Number(data.extra) || 0,
    base_price: Number(data.base_price) || 0,
    min_delivery_price: min === null || min === undefined ? null : Number(min),
  });
}

/**
 * Hamkorga — ochiq kalkulyator bilan AYNI hisob shakli (`toPublicQuote`):
 * tarif qatori va sozlama id'lari chiqmaydi.
 */
export function toPartnerQuote(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return toPublicQuote({ ...data, route: { city_route: data.city_route } });
}
