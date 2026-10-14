import { BadRequestException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Roles, maskPhonesForLog } from '@app/common';

/**
 * (W8aerwL6) notification-service tomonidagi auditoriya qoidalari — identity
 * `identity.audience.resolve` bilan BIR XIL (identity ham o'zi tekshiradi:
 * ikki qatlamli himoya). Bu yerda oldindan tekshirilishi — dispatch/preview/
 * kampaniya identity'ga bormasdan aniq xato matnini qaytaradi.
 *
 * ⚠️ Mijozlar (DIQQAT (b)): `roles:['customer']` faqat `include_customers:
 * true` bilan; `include_customers` esa segment filtri YOKI aniq tasdiq
 * (`confirm_all_customers: true`) bilan.
 */

export const AUDIENCE_RESOLVE_PATTERN = 'identity.audience.resolve';

export const CUSTOMER_TARGETING_HINT =
  'Mijozlarni nishonlash uchun `include_customers: true` va segment filtri ' +
  '(segment.region_id / district_id / market_id / last_order_from / ' +
  'last_order_to / min_orders) bering; segmentsiz BARCHA mijozlarga ' +
  "yuborish uchun qo'shimcha `confirm_all_customers: true` kerak.";

export const ALL_CUSTOMERS_CONFIRM_HINT =
  'Segment filtrisiz `include_customers: true` — BARCHA mijozlar. Bu ataylab ' +
  'ekanini tasdiqlash uchun `confirm_all_customers: true` bering yoki segment ' +
  "filtri qo'shing (region_id / district_id / market_id / last_order_from / " +
  'last_order_to / min_orders).';

export const SEGMENT_WITHOUT_CUSTOMERS_HINT =
  "`segment` faqat mijozlarga qo'llanadi — `include_customers: true` bering.";

export const SEGMENT_KEYS = [
  'region_id',
  'district_id',
  'market_id',
  'last_order_from',
  'last_order_to',
  'min_orders',
] as const;

export interface AudienceSegmentInput {
  region_id?: string | number | null;
  district_id?: string | number | null;
  market_id?: string | number | null;
  last_order_from?: string | null;
  last_order_to?: string | null;
  min_orders?: number | null;
}

/** Rol/broadcast/mijoz nishoni (aniq `recipient_ids` bundan tashqari). */
export interface AudienceTargetInput {
  roles?: string[] | null;
  broadcast?: boolean | null;
  include_customers?: boolean | null;
  confirm_all_customers?: boolean | null;
  segment?: AudienceSegmentInput | null;
}

/** identity'ga ketadigan nishon qismi (sahifa parametrlarisiz). */
export interface IdentityAudienceTarget {
  roles?: string[];
  broadcast?: boolean;
  include_customers?: boolean;
  confirm_all_customers?: boolean;
  segment?: AudienceSegmentInput;
  user_ids?: string[];
}

export interface IdentityAudienceItem {
  id: string | number;
  role?: string | null;
  language?: string | null;
  phone_valid?: boolean;
}

export interface IdentityAudiencePage {
  items: IdentityAudienceItem[];
  total: number | null;
  next_after_id: string | null;
  stats?: { by_role: Record<string, number>; with_valid_phone: number };
}

/** Faqat primitiv qiymat matnga aylanadi (obyekt → bo'sh, `[object Object]` emas). */
export const primitiveText = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint' ||
  typeof value === 'boolean'
    ? String(value)
    : '';

const isBlank = (value: unknown) => primitiveText(value).trim() === '';

/** Segmentda kamida bitta filtr bormi (bo'sh qiymatlar hisobga olinmaydi). */
export function hasSegmentFilter(
  segment: AudienceSegmentInput | null | undefined,
): boolean {
  if (!segment || typeof segment !== 'object') return false;
  return SEGMENT_KEYS.some((key) => !isBlank(segment[key]));
}

const normalizedRoles = (roles: unknown): string[] =>
  Array.isArray(roles)
    ? [
        ...new Set(
          roles
            .map((role) =>
              String(role ?? '')
                .trim()
                .toLowerCase(),
            )
            .filter(Boolean),
        ),
      ]
    : [];

/** Rol/broadcast/mijoz nishoni so'ralganmi. */
export function hasAudienceTarget(input: AudienceTargetInput): boolean {
  return (
    input.broadcast === true ||
    normalizedRoles(input.roles).length > 0 ||
    input.include_customers === true ||
    hasSegmentFilter(input.segment)
  );
}

/**
 * Mijoz qoidalarini qo'llaydi (TC6/TC7) va identity uchun toza nishon
 * qaytaradi. Nishon so'ralmagan bo'lsa `null`.
 */
export function buildAudienceTarget(
  input: AudienceTargetInput,
): IdentityAudienceTarget | null {
  if (!hasAudienceTarget(input)) return null;
  const roles = normalizedRoles(input.roles);
  const includeCustomers = input.include_customers === true;
  const confirmAll = input.confirm_all_customers === true;
  const segmentGiven = hasSegmentFilter(input.segment);

  if (roles.includes(Roles.CUSTOMER) && !includeCustomers) {
    throw new BadRequestException(CUSTOMER_TARGETING_HINT);
  }
  if (segmentGiven && !includeCustomers) {
    throw new BadRequestException(SEGMENT_WITHOUT_CUSTOMERS_HINT);
  }
  if (includeCustomers && !segmentGiven && !confirmAll) {
    throw new BadRequestException(ALL_CUSTOMERS_CONFIRM_HINT);
  }

  const target: IdentityAudienceTarget = {};
  if (input.broadcast === true) target.broadcast = true;
  if (roles.length) target.roles = roles;
  if (includeCustomers) {
    target.include_customers = true;
    if (confirmAll) target.confirm_all_customers = true;
    if (segmentGiven && input.segment) {
      const segment: AudienceSegmentInput = {};
      for (const key of SEGMENT_KEYS) {
        if (!isBlank(input.segment[key])) {
          (segment as Record<string, unknown>)[key] = input.segment[key];
        }
      }
      target.segment = segment;
    }
  }
  return target;
}

/**
 * identity xatosini RPC xatosiga aylantiradi: 4xx — matni bilan (masalan
 * TC7 maslahati), qolgani — 502. ⚠️ Ilgari xato jimgina yutilardi va dispatch
 * yarim auditoriya bilan "muvaffaqiyat" deb ketardi.
 */
export function audienceRpcError(error: unknown): RpcException {
  const raw = error instanceof RpcException ? error.getError() : error;
  const body = (raw ?? {}) as {
    statusCode?: unknown;
    message?: unknown;
    error?: { statusCode?: unknown; message?: unknown };
  };
  const status = Number(body.statusCode ?? body.error?.statusCode);
  const message = primitiveText(
    body.message ?? body.error?.message ?? (raw as Error)?.message,
  );
  if (status >= 400 && status < 500) {
    return new RpcException({ statusCode: status, message });
  }
  return new RpcException({
    statusCode: 502,
    message: `Auditoriyani identity'dan olib bo'lmadi: ${
      maskPhonesForLog(message).slice(0, 200) || 'unknown'
    }`,
  });
}

/** identity javobini (successRes) sahifaga aylantiradi. */
export function toAudiencePage(res: unknown): IdentityAudiencePage {
  const data = ((res as { data?: unknown })?.data ?? res ?? {}) as {
    items?: IdentityAudienceItem[];
    total?: number | null;
    meta?: { total?: number };
    next_after_id?: string | number | null;
    stats?: IdentityAudiencePage['stats'];
  };
  const items = Array.isArray(data.items) ? data.items : [];
  const total =
    data.total !== undefined && data.total !== null
      ? Number(data.total)
      : data.meta?.total !== undefined
        ? Number(data.meta.total)
        : null;
  return {
    items,
    total,
    next_after_id:
      data.next_after_id === undefined || data.next_after_id === null
        ? null
        : String(data.next_after_id),
    ...(data.stats ? { stats: data.stats } : {}),
  };
}
