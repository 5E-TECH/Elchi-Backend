/**
 * (dzyVftBx) Viloyat ↔ logist biriktirish RPC payloadlari.
 *
 * HTTP validatsiyasi gateway'da (`AssignRegionLogistRequestDto`,
 * `BulkAssignRegionLogistRequestDto`); servis id'larni baribir o'zi qayta
 * tekshiradi (ichki chaqiruvchilar uchun).
 */
export interface RegionLogistRequester {
  id?: string;
  roles?: string[];
}

/** logistics.region.assign_logist — `logist_id: null` — olib tashlash. */
export interface AssignRegionLogistPayload {
  id: string;
  logist_id?: string | null;
  requester?: RegionLogistRequester;
}

/**
 * logistics.region.bulk_assign_logist — `region_ids` dagi viloyatlar shu
 * logistga o'tadi, logistning BOSHQA viloyatlaridan u olib tashlanadi.
 * `logist_id: null` — faqat `region_ids` dagi viloyatlardan logist olinadi.
 */
export interface BulkAssignRegionLogistPayload {
  logist_id?: string | null;
  region_ids?: unknown;
  requester?: RegionLogistRequester;
}

/**
 * logistics.region.clear_logist — ICHKI (gateway route'i yo'q). Identity
 * `deleteUser` logistni o'chirishdan oldin chaqiradi: uning barcha
 * viloyatlarida `logist_id = NULL`. Idempotent.
 */
export interface ClearRegionLogistPayload {
  logist_id?: string;
  requester?: RegionLogistRequester;
}
