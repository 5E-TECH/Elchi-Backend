/**
 * Tuman ↔ filial qamrovi — butun backend uchun YAGONA qoida (ega qarori,
 * 2026-11-02): «filialga biriktirilmagan tuman buyurtmasi o'sha filial
 * kuryeriga berilmasin va o'sha filialga jo'natilmasin».
 *
 * Qoida (`isOrderServedByBranch`):
 *  1. HQ filiali — cheklanmaydi (markaziy ombor hamma tumanni ko'radi).
 *  2. Tumanda `serving_branch_id` bo'lsa — FAQAT o'sha filial xizmat qiladi
 *     (bir viloyatda bir nechta filial bo'lsa tumanlar shu bilan bo'linadi).
 *  3. Tumanga filial biriktirilmagan bo'lsa (o'tish davri) — tumanning XIZMAT
 *     viloyati (`assigned_region ?? region_id`, LC-13) filial viloyatiga
 *     (`branches.region_id`) teng bo'lsa. Filial viloyati yo'q — xizmat qilmaydi.
 *  4. Buyurtmada tuman yo'q — buyurtma viloyati (`order.region_id`) bilan 3-band.
 *  Hech narsa aniqlanmasa — `false` (fail-closed).
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

/** Tumanga biriktirilgan xizmat filiali (yo'q — null). */
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
 * Buyurtma (tumani yoki viloyati) shu filial qamroviga kiradimi. Yuqoridagi
 * qoida; `district` — buyurtma tumani qatori (yo'q bo'lsa `null`).
 */
export function isOrderServedByBranch(
  input: { district?: CoverageDistrict | null; orderRegionId?: unknown },
  branch: CoverageBranch | null | undefined,
): boolean {
  if (!branch) return false;
  if (isHqBranch(branch)) return true;
  const branchId = asId(branch.id);
  const servingBranchId = districtServingBranchId(input.district);
  if (servingBranchId) {
    return !!branchId && servingBranchId === branchId;
  }
  const branchRegionId = asId(branch.region_id);
  if (!branchRegionId) return false;
  const regionId = input.district
    ? effectiveDistrictRegionId(input.district)
    : asId(input.orderRegionId);
  return !!regionId && regionId === branchRegionId;
}
