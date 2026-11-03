/**
 * Buyurtma ↔ filial qamrovi — butun backend uchun YAGONA qoida.
 *
 * VILOYAT qoidasi (ega qarori, Trello anKpzwxk, 2026-11-03 — #617 dagi
 * «tuman → filial» qoidasi o'rniga):
 *
 * Qoida (`isOrderServedByBranch`):
 *  1. HQ filiali — cheklanmaydi (markaziy ombor hamma viloyatni ko'radi).
 *  2. Boshqa filial buyurtmaga xizmat qiladi ⇔ buyurtmaning XIZMAT viloyati
 *     (`effectiveOrderRegionId`: tuman qatori bor — `assigned_region ??
 *     region_id`, LC-13; tuman qatori yo'q — `order.region_id`) filial
 *     viloyatiga (`branches.region_id`) teng. Bir viloyatdagi HAR QANDAY
 *     filial shu viloyat buyurtmasiga xizmat qiladi (masalan Urgut tumani
 *     buyurtmasi — «Samarqand filiali» ham, «Urgut filiali» ham).
 *  3. Filial viloyati yo'q — hech narsaga xizmat qilmaydi (fail-closed).
 *  Buyurtma viloyati aniqlanmasa — `false` (fail-closed).
 *
 * `districts.serving_branch_id` endi HISOBGA OLINMAYDI (ustun qoladi;
 * `PUT /branches/:id/districts` chaqirilaveradi, lekin qamrovga ta'sir
 * qilmaydi — keyin tozalanadi).
 *
 * Sof funksiya: DB/RMQ yo'q. Tuman qatori `logistics.district.find_by_ids`
 * javobi shaklida (ustun yoki relation) kelishi mumkin.
 */

export interface CoverageDistrict {
  id?: unknown;
  region_id?: unknown;
  region?: { id?: unknown } | null;
  assigned_region?: unknown;
  assignedToRegion?: { id?: unknown } | null;
  /** Endi qamrovga ta'sir qilmaydi (faqat audit / eski javoblar uchun). */
  serving_branch_id?: unknown;
}

export interface CoverageBranch {
  id?: unknown;
  type?: unknown;
  region_id?: unknown;
}

const asId = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return /^\d{1,19}$/.test(trimmed) && !/^0+$/.test(trimmed)
      ? trimmed.replace(/^0+/, '')
      : null;
  }
  return null;
};

/** Tumanning xizmat viloyati: assigned_region → assignedToRegion.id → region_id → region.id. */
export function effectiveDistrictRegionId(
  district: CoverageDistrict | null | undefined,
): string | null {
  if (!district) return null;
  return (
    asId(district.assigned_region) ??
    asId(district.assignedToRegion?.id) ??
    asId(district.region_id) ??
    asId(district.region?.id)
  );
}

/**
 * Buyurtmaning xizmat viloyati: tuman qatori bor — uning xizmat viloyati
 * (`effectiveDistrictRegionId`); tuman qatori yo'q — `orderRegionId`.
 * Aniqlanmasa — `null`.
 */
export function effectiveOrderRegionId(input: {
  district?: CoverageDistrict | null;
  orderRegionId?: unknown;
}): string | null {
  return input.district
    ? effectiveDistrictRegionId(input.district)
    : asId(input.orderRegionId);
}

/**
 * Tumanga biriktirilgan xizmat filiali (yo'q — null). Endi qamrovga ta'sir
 * QILMAYDI — faqat audit / javoblar uchun.
 */
export function districtServingBranchId(
  district: CoverageDistrict | null | undefined,
): string | null {
  return asId(district?.serving_branch_id);
}

export function isHqBranch(branch: CoverageBranch | null | undefined): boolean {
  return (
    String(branch?.type ?? '')
      .trim()
      .toUpperCase() === 'HQ'
  );
}

/**
 * Buyurtma shu filial qamroviga kiradimi (yuqoridagi viloyat qoidasi).
 * `district` — buyurtma tumani qatori (yo'q bo'lsa `null`).
 */
export function isOrderServedByBranch(
  input: { district?: CoverageDistrict | null; orderRegionId?: unknown },
  branch: CoverageBranch | null | undefined,
): boolean {
  if (!branch) return false;
  if (isHqBranch(branch)) return true;
  const branchRegionId = asId(branch.region_id);
  if (!branchRegionId) return false;
  const regionId = effectiveOrderRegionId(input);
  return !!regionId && regionId === branchRegionId;
}
