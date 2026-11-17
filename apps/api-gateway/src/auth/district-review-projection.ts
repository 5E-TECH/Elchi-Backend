import { Roles as RoleEnum } from '@app/common';

/**
 * D1 (round 3, S7): tuman qatoridagi `assignment_*` maydonlari (D1
 * «tekshirilmagan» belgisi, sabab, kim/qachon tasdiqladi —
 * `assignment_confirmed_by` ichki admin id'si) — faqat SUPERADMIN/ADMIN
 * uchun. `GET /district`, `GET /district/:id`, `GET /district/sato/:code`,
 * `GET /region`, `GET /region/:id` MARKET, COURIER, MARKET_OPERATOR va filial
 * xodimlariga ham ochiq — ularga bu maydonlar kesib beriladi.
 *
 * Javob shakllari: `data` — tuman, tumanlar massivi, viloyat (`districts`,
 * `assignedDistricts`) yoki viloyatlar massivi. Viloyat ichidagi
 * `districts[].region` kabi chuqur ichma-ich obyektlar ham ko'rib chiqiladi
 * (chuqurlik cheklangan). Asl javob o'zgartirilmaydi — nusxa qaytadi.
 */
const DISTRICT_REVIEW_FIELD = /^assignment_/;
const MAX_DEPTH = 4;

export function canSeeDistrictReviewFields(roles?: readonly unknown[]) {
  return (roles ?? []).some((role) => {
    const value = typeof role === 'string' ? role.trim().toLowerCase() : '';
    return value === RoleEnum.SUPERADMIN || value === RoleEnum.ADMIN;
  });
}

function strip(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map((item) => strip(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DISTRICT_REVIEW_FIELD.test(key)) continue;
    out[key] = strip(item, depth + 1);
  }
  return out;
}

/** `{ statusCode, message, data }` javobidan admin bo'lmaganlarga `assignment_*` ni kesadi. */
export function projectDistrictReviewFields<T>(
  response: T,
  roles?: readonly unknown[],
): T {
  if (canSeeDistrictReviewFields(roles)) return response;
  if (!response || typeof response !== 'object' || !('data' in response)) {
    return response;
  }
  const { data } = response as { data?: unknown };
  return { ...response, data: strip(data, 0) } as T;
}
