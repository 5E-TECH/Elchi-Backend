import { Roles } from '../../enums';

/**
 * onXzDc5n — «KURYERDAGI BUYURTMALAR» umumiy qoidalari (gateway va
 * order-service bir xil o'qisin): filtr qiymatlari, soat chegaralari va kim
 * ko'radi.
 *
 * Soat — buyurtma kuryer qo'liga o'tgan paytdan (`orders.last_handover_at`,
 * holder COURIER), kalendar soat. Oraliqlar:
 *   near_48  36 ≤ soat < 48 — «48 soatga yaqinlashgan»
 *   over_48  48 ≤ soat < 72 — «48 soatdan oshgan»
 *   over_72  soat ≥ 72     — «72 soatdan oshgan»
 *   any      kuryerdagi hammasi
 */
export const COURIER_HOLD_FILTERS = [
  'any',
  'near_48',
  'over_48',
  'over_72',
] as const;
export type CourierHoldFilter = (typeof COURIER_HOLD_FILTERS)[number];

/** «48 soatga yaqinlashgan» oynasining boshi (soat). */
export const COURIER_HOLD_NEAR_FROM_HOURS = 36;
/** Muddat (soat). */
export const COURIER_HOLD_DEADLINE_HOURS = 48;
/** «72 soatdan oshgan» chegarasi (soat). */
export const COURIER_HOLD_OVER_HOURS = 72;

/**
 * Ko'ra oladigan rollar: superadmin/admin — hammasi; menejer — o'z filiali;
 * kuryer — o'zi; market — o'zi. Registrator, operator, market operatori,
 * logist, investor, mijoz — YO'Q (403).
 */
export const COURIER_HOLD_ROLES: readonly Roles[] = Object.freeze([
  Roles.SUPERADMIN,
  Roles.ADMIN,
  Roles.MANAGER,
  Roles.COURIER,
  Roles.MARKET,
]);

export const COURIER_HOLD_FORBIDDEN_MESSAGE =
  "Kuryerdagi buyurtmalar ro'yxatini ko'rishga ruxsat yo'q";

export function canViewCourierHold(
  roles: readonly string[] | undefined,
): boolean {
  const list = (roles ?? []).map((role) => String(role).trim().toLowerCase());
  return COURIER_HOLD_ROLES.some((role) => list.includes(role));
}

/**
 * `?courier_hold=` qiymati. Bo'sh — filtr yo'q (`null`); noma'lum — `invalid`
 * (gateway 400 beradi). Massiv kelsa — birinchisi.
 */
export function parseCourierHoldFilter(value: unknown): {
  filter: CourierHoldFilter | null;
  invalid: boolean;
} {
  const raw: unknown = Array.isArray(value) ? value[0] : value;
  const text =
    typeof raw === 'string' || typeof raw === 'number'
      ? String(raw).trim().toLowerCase()
      : '';
  if (!text) return { filter: null, invalid: false };
  return (COURIER_HOLD_FILTERS as readonly string[]).includes(text)
    ? { filter: text as CourierHoldFilter, invalid: false }
    : { filter: null, invalid: true };
}
