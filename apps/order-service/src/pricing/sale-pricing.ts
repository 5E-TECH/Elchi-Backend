import { ClientProxy } from '@nestjs/microservices';
import { rmqSend, Where_deliver } from '@app/common';
import type { SaleEngineQuote } from '../domain/order-money';

/**
 * KmWO9gTA — YETKAZISH NARXI DVIGATELINI SOTUV OQIMIGA ULASH (sozlama + RPC).
 *
 * HISOB bu yerda EMAS: vazn/hajm qo'shimchasi logistics-service'da
 * `computeDeliveryQuote` (yagona manba, DAqXPeSy) bilan hisoblanadi, market
 * tarifi esa `order-money.ts` `resolveOrderTariffDetailed` da yig'iladi. Bu
 * fayl faqat (1) dvigatel YOQILGANMI degan qarorni va (2) logistics'dan
 * natijani olishni bilardi.
 *
 * DARVOZALAR (prod xulqi o'zgarmasligi uchun HAMMASI sukut bo'yicha yopiq):
 *   • `SALE_PRICING_ENGINE` — `on` bo'lmaguncha (sukut `off`) hech bir
 *     buyurtma dvigateldan narx olmaydi: market tarifi avvalgidek profildan
 *     (`tariff_home` / `tariff_center`), pul oyoqlari baytma-bayt AYNI.
 *     Ega rejasi (2026-10-19): avval bayroq hamma marketda TRUE holda, lekin
 *     dvigatel ULANMAGAN holda chiqariladi, so'ng dvigatel ulanadi.
 *   • `SALE_PRICING_ENGINE_MARKET_IDS` — bo'sh bo'lmasa dvigatel FAQAT shu
 *     marketlarda (vergul bilan id'lar). Prod'da avval TEST marketda
 *     tekshirish uchun.
 *   • Market `weight_volume_pricing` (identity, sukut TRUE) — FALSE bo'lsa
 *     (kelishuvli market) market tarifi = faqat standart narx, ya'ni hozirgi
 *     xulq.
 *
 * Snapshot (`orders.market_tariff`) bor buyurtmada dvigatel UMUMAN
 * chaqirilmaydi — eski / sotilgan buyurtmaning narxi orqaga o'zgarmaydi.
 */

export const SALE_QUOTE_PATTERN = 'logistics.delivery.sale_quote';

export interface SalePricingConfig {
  enabled: boolean;
  /** NULL — barcha marketlar; aks holda faqat shu id'lar (canary). */
  marketIds: ReadonlySet<string> | null;
}

export function readSalePricingConfig(
  env: Record<string, string | undefined> = process.env,
): SalePricingConfig {
  const raw = String(env.SALE_PRICING_ENGINE ?? '')
    .trim()
    .toLowerCase();
  const ids = String(env.SALE_PRICING_ENGINE_MARKET_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d{1,18}$/.test(id));
  return {
    enabled: raw === 'on',
    marketIds: ids.length ? new Set(ids) : null,
  };
}

/**
 * Shu market buyurtmasi dvigateldan narx oladimi. `weight_volume_pricing`
 * berilmagan (eski identity javobi) — DB sukuti kabi TRUE.
 */
export function isSalePricingEngineActive(
  config: SalePricingConfig,
  marketId: string | number | null | undefined,
  market: { weight_volume_pricing?: boolean | null } | null | undefined,
): boolean {
  if (!config.enabled) return false;
  const id = String(marketId ?? '').trim();
  if (!id) return false;
  if (config.marketIds && !config.marketIds.has(id)) return false;
  return market?.weight_volume_pricing !== false;
}

export interface SaleQuoteItemPayload {
  product_id: string | null;
  quantity: number;
}

export interface SaleQuotePayload {
  where_deliver: string;
  /** Jo'natuvchi — market profilidagi viloyat/tuman (bo'lmasa shahar emas). */
  from_region_id?: string | null;
  from_district_id?: string | null;
  /** Qabul qiluvchi — buyurtmaning viloyat/tumani. */
  to_region_id?: string | null;
  to_district_id?: string | null;
  items: SaleQuoteItemPayload[];
}

/** `logistics.delivery.sale_quote` javobi (`data`). */
export interface SaleDeliveryQuote {
  tariff_id: string;
  tariff_row_id: string | null;
  base_price: number;
  extra_per_kg: number;
  extra: number;
  extraKg: number;
  billableKg: number;
  actualKg: number;
  volumetricKg: number;
  basis: 'weight' | 'volume' | null;
  estimated: boolean;
  unmeasuredItems: number;
  missingDimensionItems: number;
  settings_id: string | null;
  min_delivery_price: number | null;
  extra_cost_limit_amount: number | null;
  center_base: number;
  address_base: number;
}

const toNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
/** Id / kod — faqat satr yoki son (obyekt `[object Object]` bo'lib ketmasin). */
const toIdOrNull = (value: unknown): string | null =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : null;
const toNullable = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Buyurtma elementlari → dvigatel elementlari. Bir mahsulot bir necha
 * qatorda bo'lsa soni QO'SHILADI (bitta jo'natma). Katalogsiz element
 * (`product_id` NULL, tashqi buyurtma) o'lchovsiz bo'lib kiradi —
 * logistics uni `unmeasuredItems` da sanaydi, narx jimgina 0 ga tushmaydi.
 */
export function buildSaleQuoteItems(
  items:
    | ReadonlyArray<{
        product_id?: string | number | null;
        quantity?: number | string | null;
      }>
    | null
    | undefined,
): SaleQuoteItemPayload[] {
  const byProduct = new Map<string, number>();
  let unmeasured = 0;
  for (const item of items ?? []) {
    const qty = Math.max(Math.trunc(Number(item?.quantity ?? 1)) || 0, 0);
    if (qty < 1) continue;
    const productId =
      item?.product_id == null ? '' : String(item.product_id).trim();
    if (productId) {
      byProduct.set(productId, (byProduct.get(productId) ?? 0) + qty);
    } else {
      unmeasured += qty;
    }
  }
  const result: SaleQuoteItemPayload[] = [...byProduct.entries()].map(
    ([product_id, quantity]) => ({ product_id, quantity }),
  );
  if (unmeasured > 0) {
    result.push({ product_id: null, quantity: unmeasured });
  }
  return result;
}

/** Jo'natuvchi — market profili, qabul qiluvchi — buyurtma hududi. */
export function buildSaleQuotePayload(
  order: {
    where_deliver?: Where_deliver | string | null;
    region_id?: string | null;
    district_id?: string | null;
    items?: ReadonlyArray<{
      product_id?: string | number | null;
      quantity?: number | string | null;
    }> | null;
  },
  market:
    | { region_id?: string | null; district_id?: string | null }
    | null
    | undefined,
): SaleQuotePayload {
  return {
    where_deliver:
      order.where_deliver === Where_deliver.ADDRESS ? 'address' : 'center',
    from_region_id: market?.region_id ?? null,
    from_district_id: market?.district_id ?? null,
    to_region_id: order.region_id ?? null,
    to_district_id: order.district_id ?? null,
    items: buildSaleQuoteItems(order.items),
  };
}

const SALE_QUOTE_RPC_OPTIONS = Object.freeze({
  timeoutMs: 5000,
  retries: 1,
  deadlineMs: 9000,
});

/** Logistics'dan sotuv narxi. Xato — chaqiruvchiga (u zaxira yo'lni tanlaydi). */
export async function fetchSaleDeliveryQuote(
  client: ClientProxy,
  payload: SaleQuotePayload,
): Promise<SaleDeliveryQuote> {
  const response = await rmqSend<{ data?: Record<string, unknown> }>(
    client,
    { cmd: SALE_QUOTE_PATTERN },
    payload,
    SALE_QUOTE_RPC_OPTIONS,
  );
  const data = response?.data;
  if (!data || typeof data !== 'object') {
    throw new Error("logistics.delivery.sale_quote: bo'sh javob");
  }
  const basis = data.basis;
  return {
    tariff_id: toIdOrNull(data.tariff_id) ?? '',
    tariff_row_id: toIdOrNull(data.tariff_row_id),
    base_price: toNumber(data.base_price),
    extra_per_kg: toNumber(data.extra_per_kg),
    extra: toNumber(data.extra),
    extraKg: toNumber(data.extraKg),
    billableKg: toNumber(data.billableKg),
    actualKg: toNumber(data.actualKg),
    volumetricKg: toNumber(data.volumetricKg),
    basis: basis === 'weight' || basis === 'volume' ? basis : null,
    estimated: data.estimated === true,
    unmeasuredItems: toNumber(data.unmeasuredItems),
    missingDimensionItems: toNumber(data.missingDimensionItems),
    settings_id: toIdOrNull(data.settings_id),
    min_delivery_price: toNullable(data.min_delivery_price),
    extra_cost_limit_amount: toNullable(data.extra_cost_limit_amount),
    center_base: toNumber(data.center_base),
    address_base: toNumber(data.address_base),
  };
}

export function toSaleEngineQuote(quote: SaleDeliveryQuote): SaleEngineQuote {
  return {
    surcharge: quote.extra,
    tableBase: quote.base_price,
    minDeliveryPrice: quote.min_delivery_price,
  };
}
