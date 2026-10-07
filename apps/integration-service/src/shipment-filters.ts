import { Order_status } from '@app/common';

/**
 * POSILKALAR PILLARI (tokhPLMP) — `provider_shipments` filtrlari.
 *
 * Har filtr SQL bo'lagi sifatida BIR joyda: ro'yxat filtri ham, bitta
 * agregat so'rovdagi `COUNT(*) FILTER (WHERE …)` sanoqlari ham shu
 * matnlardan foydalanadi — pill sanog'i va bosilgandagi ro'yxat ajralib
 * ketmaydi.
 */

export type ShipmentFilter =
  | 'all'
  | 'not_sent'
  | 'failed'
  | 'delivered'
  | 'mismatch';

export const SHIPMENT_FILTERS = new Set<ShipmentFilter>([
  'all',
  'not_sent',
  'failed',
  'delivered',
  'mismatch',
]);

/** Pul/yetkazish yakunlangan ichki holatlar. */
export const SHIPMENT_DELIVERED_STATUSES: readonly string[] = [
  Order_status.SOLD,
  Order_status.PAID,
  Order_status.PARTLY_PAID,
  Order_status.CLOSED,
];

/**
 * ⚠️ `:status_map` — `{ "PROVIDER_STATUS_UPPER": "internal_status" }` JSON
 * matni; tashuvchi statusi katta harf bilan solishtiriladi (`mapProviderStatus`
 * bilan bir xil: registrga sezgir emas). Xaritada yo'q status nomuvofiqlik
 * EMAS — u "noma'lum" (oraliq yoki sozlanmagan).
 */
const MAPPED = `(CAST(:status_map AS jsonb) ->> UPPER(s.provider_status))`;

export const SHIPMENT_FILTER_SQL: Record<
  Exclude<ShipmentFilter, 'all'>,
  string
> = {
  // Tashuvchiga hali qabul qilinmagan va xato ham yo'q (navbatda).
  not_sent:
    's.external_ref IS NULL AND s.tracking_number IS NULL AND s.last_error IS NULL',
  // Xato MATNI bor — "yiqilgan" ning yagona ishonchli belgisi.
  failed: 's.last_error IS NOT NULL',
  delivered: 's.internal_status IN (:...delivered)',
  mismatch: `s.provider_status IS NOT NULL AND ${MAPPED} IS NOT NULL AND ${MAPPED} IS DISTINCT FROM s.internal_status`,
};

/**
 * `inbound_status_mapping` (`{ DELIVERED: { status: 'sold', action } }`) →
 * `{ DELIVERED: 'sold' }`. Holati yo'q yozuvlar tashlanadi.
 */
export const normalizeInboundStatusMap = (
  mapping:
    | Record<string, { status?: unknown } | null | undefined>
    | null
    | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping ?? {})) {
    const status = typeof value?.status === 'string' ? value.status.trim() : '';
    const code = key.trim().toUpperCase();
    if (code && status) out[code] = status;
  }
  return out;
};
