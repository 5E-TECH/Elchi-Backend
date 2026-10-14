import { ClientProxy, RpcException } from '@nestjs/microservices';
import { Brackets, Repository, SelectQueryBuilder } from 'typeorm';
import { Roles, rmqSend } from '@app/common';
import { errorRes, successRes } from '../../../../libs/common/helpers/response';
import { User } from '../entities/user.entity';

/**
 * AUDITORIYA RESOLVERI (W8aerwL6) — bildirishnoma / kampaniya nishoni uchun
 * ICHKI RMQ pattern: `{ cmd: 'identity.audience.resolve' }`.
 *
 * NEGA ALOHIDA. `identity.user.find_all` (`findAllAdmins`) superadmin va
 * mijozni ATAYLAB chiqarib tashlaydi — u foydalanuvchilar ro'yxati (GET
 * /users) uchun xavfsizlik filtri va unga TEGILMAYDI (kartaning 1-bandi).
 * Shu sabab `roles:['customer']` / `roles:['superadmin']` dispatch'i 0 qabul
 * qiluvchi bilan 400 qaytarardi. Bu resolverda rol filtri YO'Q: superadmin ham,
 * mijoz ham chiqadi — lekin mijozlar faqat aniq so'ralganda (pastga qarang).
 *
 * ⚠️ PII. Javobda ism va TELEFON bo'lishi mumkin (`fields: 'contact'`), rol
 * tekshiruvi yo'q — shuning uchun gateway'da HTTP orqali OCHILMAYDI (faqat
 * servis→servis RMQ). Inbox yig'uvchisi `fields: 'minimal'` (id, rol, til)
 * so'raydi: telefonlar notification-service xotirasiga umuman tushmaydi
 * (faqat `phone_valid` bayrog'i — preview'da SMS'ga yaroqlilar soni uchun).
 *
 * MIJOZLAR (kartaning DIQQAT (b) bandi): mijozlar bazasi xodimlarnikidan
 * ancha katta, shuning uchun:
 *   • `roles` ichida `customer` — `include_customers: true` siz 400 (tushunarli
 *     matn bilan, jim 0 emas);
 *   • `include_customers: true` — kamida bitta segment filtri YOKI aniq
 *     tasdiq `confirm_all_customers: true` bo'lmasa 400;
 *   • segment faqat mijozlar qismiga qo'llanadi (xodim rollariga emas).
 *
 * SEGMENT buyurtmalar bo'yicha (hudud/tuman/market/oxirgi buyurtma/soni) —
 * order-service `order.customer.segment` (sVByLMnt) dan mijoz id'lari olinadi.
 * U ko'pi bilan 5000 ta qaytaradi; ko'proq bo'lsa (`truncated`) — XATO,
 * jimgina kesilmaydi (DIQQAT (c)).
 *
 * SAHIFALASH: `ORDER BY id` — barqaror. `after_id` (keyset) berilsa `page`
 * e'tiborsiz: kampaniya partiyalari sahifalar orasida foydalanuvchi qo'shilsa
 * yoki o'chirilsa ham takrorlanmaydi va tushib qolmaydi.
 */

export const AUDIENCE_RESOLVE_PATTERN = 'identity.audience.resolve';
export const AUDIENCE_DEFAULT_LIMIT = 100;
export const AUDIENCE_MAX_LIMIT = 1000;
/** order-service `order.customer.segment` ning MAX_LIMIT i bilan bir xil. */
export const AUDIENCE_SEGMENT_MAX = 5000;
/** Bitta so'rovdagi `user_ids` (cheklovchi filtr) yuqori chegarasi. */
export const AUDIENCE_USER_IDS_MAX = 5000;

/** TC7: `roles:['customer']` bayroqsiz kelganda — nima qilish kerakligi. */
export const CUSTOMER_TARGETING_HINT =
  'Mijozlarni nishonlash uchun `include_customers: true` va segment filtri ' +
  '(segment.region_id / district_id / market_id / last_order_from / ' +
  'last_order_to / min_orders) bering; segmentsiz BARCHA mijozlarga ' +
  "yuborish uchun qo'shimcha `confirm_all_customers: true` kerak.";

/** TC6: segmentsiz `include_customers: true` — majburiy tasdiq. */
export const ALL_CUSTOMERS_CONFIRM_HINT =
  'Segment filtrisiz `include_customers: true` — BARCHA mijozlar. Bu ataylab ' +
  'ekanini tasdiqlash uchun `confirm_all_customers: true` bering yoki segment ' +
  "filtri qo'shing (region_id / district_id / market_id / last_order_from / " +
  'last_order_to / min_orders).';

export const SEGMENT_WITHOUT_CUSTOMERS_HINT =
  "`segment` faqat mijozlarga qo'llanadi — `include_customers: true` bering.";

const ROLE_ALIASES: Record<string, Roles> = { marketing: Roles.MARKET };
const ID_RE = /^\d{1,19}$/;
const SEGMENT_ID_KEYS = ['region_id', 'district_id', 'market_id'] as const;
/** Kanonik telefon (normalizeUzPhone natijasi) — SMS'ga yaroqli. */
const VALID_UZ_PHONE_SQL = `u.phone_number ~ '^\\+998[0-9]{9}$'`;

export interface AudienceSegment {
  region_id?: string;
  district_id?: string;
  market_id?: string;
  last_order_from?: string;
  last_order_to?: string;
  min_orders?: number;
}

export type AudienceFields = 'minimal' | 'contact';

export interface AudienceResolveInput {
  roles?: unknown;
  /** Barcha xodimlar (mijozdan boshqa HAR rol, superadmin ham). */
  broadcast?: unknown;
  /** Cheklovchi filtr: boshqa shartlar bilan AND; yolg'iz — aynan shu userlar. */
  user_ids?: unknown;
  include_customers?: unknown;
  confirm_all_customers?: unknown;
  segment?: unknown;
  page?: unknown;
  limit?: unknown;
  /** Keyset kursor: `id > after_id` (kampaniya partiyalari). */
  after_id?: unknown;
  /** `false` — COUNT so'rovi o'tkazib yuboriladi (partiyalar uchun). */
  with_total?: unknown;
  /** `true` — rollar kesimi va yaroqli telefonlar soni (preview). */
  with_stats?: unknown;
  /** `minimal` — id/role/language; `contact` (sukut) — + name/phone. */
  fields?: unknown;
}

export interface AudienceItem {
  id: string;
  role: string;
  language: string | null;
  /** Telefon kanonik (+998XXXXXXXXX) — SMS'ga yaroqli. Raqamning o'zi emas. */
  phone_valid: boolean;
  name?: string | null;
  phone?: string | null;
}

export interface NormalizedAudience {
  staffRoles: string[];
  broadcast: boolean;
  includeCustomers: boolean;
  confirmAllCustomers: boolean;
  segment: AudienceSegment | null;
  userIds: string[];
  page: number;
  limit: number;
  afterId: string | null;
  withTotal: boolean;
  withStats: boolean;
  fields: AudienceFields;
}

const badRequest = (message: string): never => {
  throw new RpcException(errorRes(message, 400));
};

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** Bo'sh (berilmagan) qiymat — `undefined`/`null`/bo'sh satr. */
const isBlank = (value: unknown) =>
  value === undefined || value === null || text(value) === '';

/**
 * Segmentni tekshiradi (RMQ'da ValidationPipe yo'q — FAIL-CLOSED). Hech bir
 * filtr berilmagan bo'lsa `null` (segment YO'Q).
 */
export function normalizeAudienceSegment(raw: unknown): AudienceSegment | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return badRequest("segment obyekt bo'lishi kerak");
  }
  const input = raw as Record<string, unknown>;
  const allowed = new Set<string>([
    ...SEGMENT_ID_KEYS,
    'last_order_from',
    'last_order_to',
    'min_orders',
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) badRequest(`segment.${key} — noma'lum filtr`);
  }
  const segment: AudienceSegment = {};
  for (const key of SEGMENT_ID_KEYS) {
    if (isBlank(input[key])) continue;
    const value = text(input[key]);
    if (!ID_RE.test(value)) badRequest(`segment.${key} noto'g'ri: ${value}`);
    segment[key] = value;
  }
  for (const key of ['last_order_from', 'last_order_to'] as const) {
    if (isBlank(input[key])) continue;
    const value = text(input[key]);
    if (Number.isNaN(new Date(value).getTime())) {
      badRequest(`segment.${key} — sana noto'g'ri (YYYY-MM-DD yoki ISO)`);
    }
    segment[key] = value;
  }
  if (!isBlank(input.min_orders)) {
    const minOrders = Number(input.min_orders);
    if (!Number.isInteger(minOrders) || minOrders < 1) {
      badRequest("segment.min_orders — musbat butun son bo'lishi kerak");
    }
    segment.min_orders = minOrders;
  }
  return Object.keys(segment).length ? segment : null;
}

function normalizeRoles(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return badRequest("roles massiv bo'lishi kerak");
  const known = new Set<string>(Object.values(Roles));
  const roles = new Set<string>();
  for (const item of raw) {
    const value = text(item).toLowerCase();
    if (!value) continue;
    const role = ROLE_ALIASES[value] ?? value;
    if (!known.has(role)) badRequest(`Noma'lum rol: ${value}`);
    roles.add(role);
  }
  return [...roles];
}

function normalizeUserIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return badRequest("user_ids massiv bo'lishi kerak");
  const ids = [...new Set(raw.map((id) => text(id)).filter(Boolean))];
  const invalid = ids.find(
    (id) => !ID_RE.test(id) || BigInt(id) > BigInt('9223372036854775807'),
  );
  if (invalid) badRequest(`user_ids noto'g'ri: ${invalid}`);
  if (ids.length > AUDIENCE_USER_IDS_MAX) {
    badRequest(`user_ids ${AUDIENCE_USER_IDS_MAX} tadan ko'p`);
  }
  return ids;
}

/** Kiruvchi so'rovni tekshiradi va mijoz qoidalarini qo'llaydi (TC6/TC7). */
export function normalizeAudienceInput(
  input: AudienceResolveInput = {},
): NormalizedAudience {
  const roles = normalizeRoles(input.roles);
  const includeCustomers = input.include_customers === true;
  const confirmAllCustomers = input.confirm_all_customers === true;
  const segment = normalizeAudienceSegment(input.segment);

  if (roles.includes(Roles.CUSTOMER) && !includeCustomers) {
    badRequest(CUSTOMER_TARGETING_HINT);
  }
  if (segment && !includeCustomers) badRequest(SEGMENT_WITHOUT_CUSTOMERS_HINT);
  if (includeCustomers && !segment && !confirmAllCustomers) {
    badRequest(ALL_CUSTOMERS_CONFIRM_HINT);
  }

  const broadcast = input.broadcast === true;
  const staffRoles = roles.filter((role) => role !== Roles.CUSTOMER);
  const userIds = normalizeUserIds(input.user_ids);
  if (
    !broadcast &&
    !staffRoles.length &&
    !includeCustomers &&
    !userIds.length
  ) {
    badRequest(
      "Auditoriya bo'sh: roles, broadcast, include_customers yoki user_ids bering",
    );
  }

  const page = Number(input.page) > 0 ? Math.floor(Number(input.page)) : 1;
  const limit =
    Number(input.limit) > 0
      ? Math.min(Math.floor(Number(input.limit)), AUDIENCE_MAX_LIMIT)
      : AUDIENCE_DEFAULT_LIMIT;
  const afterRaw = text(input.after_id);
  if (afterRaw && !ID_RE.test(afterRaw)) badRequest("after_id noto'g'ri");

  return {
    staffRoles,
    broadcast,
    includeCustomers,
    confirmAllCustomers,
    segment,
    userIds,
    page,
    limit,
    afterId: afterRaw || null,
    withTotal: input.with_total !== false,
    withStats: input.with_stats === true,
    fields: input.fields === 'minimal' ? 'minimal' : 'contact',
  };
}

/**
 * Segment → mijoz id'lari (order-service). Chegaradan oshsa XATO (jimgina
 * kesilmaydi). `order.customer.segment` tushunmaydigan hech narsa yuborilmaydi.
 */
async function segmentCustomerIds(
  orderClient: ClientProxy,
  segment: AudienceSegment,
): Promise<string[]> {
  let res: {
    data?: { items?: Array<{ customer_id?: unknown }>; truncated?: boolean };
  } | null;
  try {
    res = await rmqSend(
      orderClient,
      { cmd: 'order.customer.segment' },
      { ...segment, limit: AUDIENCE_SEGMENT_MAX },
    );
  } catch (error) {
    const reason =
      error instanceof RpcException
        ? text((error.getError() as { message?: unknown })?.message)
        : error instanceof Error
          ? error.message
          : '';
    throw new RpcException(
      errorRes(
        `Mijoz segmentini olib bo'lmadi (order-service): ${reason || 'unknown'}`,
        502,
      ),
    );
  }
  if (res?.data?.truncated) {
    badRequest(
      `Segment ${AUDIENCE_SEGMENT_MAX} tadan ko'p mijozni qamraydi — filtrni ` +
        'toraytiring (jimgina kesilmaydi).',
    );
  }
  return [
    ...new Set(
      (res?.data?.items ?? [])
        .map((item) => text(item?.customer_id))
        .filter((id) => ID_RE.test(id)),
    ),
  ];
}

/** Rol/mijoz/user_ids shartlari — COUNT, stats va sahifa uchun bitta asos. */
function scopeQuery(
  users: Repository<User>,
  audience: NormalizedAudience,
  segmentIds: string[] | null,
): SelectQueryBuilder<User> {
  const qb = users
    .createQueryBuilder('u')
    .where('u.isDeleted = :isDeleted', { isDeleted: false });

  const roleScoped =
    audience.broadcast ||
    audience.staffRoles.length > 0 ||
    audience.includeCustomers;
  if (roleScoped) {
    qb.andWhere(
      new Brackets((scope) => {
        const parts: Array<[string, Record<string, unknown>]> = [];
        if (audience.broadcast) {
          parts.push([
            'u.role <> :audienceCustomerRole',
            { audienceCustomerRole: Roles.CUSTOMER },
          ]);
        } else if (audience.staffRoles.length) {
          parts.push([
            'u.role IN (:...audienceStaffRoles)',
            { audienceStaffRoles: audience.staffRoles },
          ]);
        }
        if (audience.includeCustomers) {
          if (segmentIds === null) {
            parts.push([
              'u.role = :audienceCustomerRole',
              { audienceCustomerRole: Roles.CUSTOMER },
            ]);
          } else if (segmentIds.length) {
            parts.push([
              '(u.role = :audienceCustomerRole AND u.id IN (:...audienceSegmentIds))',
              {
                audienceCustomerRole: Roles.CUSTOMER,
                audienceSegmentIds: segmentIds,
              },
            ]);
          }
        }
        if (!parts.length) {
          // Faqat mijozlar so'ralgan, segment esa bo'sh — hech kim.
          scope.where('1 = 0');
          return;
        }
        parts.forEach(([sql, params], index) =>
          index === 0 ? scope.where(sql, params) : scope.orWhere(sql, params),
        );
      }),
    );
  }

  if (audience.userIds.length) {
    qb.andWhere('u.id IN (:...audienceUserIds)', {
      audienceUserIds: audience.userIds,
    });
  }
  return qb;
}

/**
 * Til: mijoz — `language` ustuni, xodim — `settings.appearance.language`
 * (bo'lmasa ustun). `contactsByIds` bilan bir xil qoida (shablon kartasi).
 */
const LANGUAGE_SQL = `COALESCE(CASE WHEN u.role = '${Roles.CUSTOMER}' THEN NULL ELSE u.settings #>> '{appearance,language}' END, u.language)`;

export async function resolveAudience(
  users: Repository<User>,
  orderClient: ClientProxy,
  input: AudienceResolveInput = {},
) {
  const audience = normalizeAudienceInput(input ?? {});
  const segmentIds =
    audience.includeCustomers && audience.segment
      ? await segmentCustomerIds(orderClient, audience.segment)
      : null;

  const base = scopeQuery(users, audience, segmentIds);

  const pageQb = base
    .clone()
    .select('u.id', 'id')
    .addSelect('u.role', 'role')
    .addSelect(LANGUAGE_SQL, 'language')
    .addSelect(`(${VALID_UZ_PHONE_SQL})`, 'phone_valid');
  if (audience.fields === 'contact') {
    pageQb.addSelect('u.name', 'name').addSelect('u.phone_number', 'phone');
  }
  if (audience.afterId) {
    pageQb.andWhere('u.id > :audienceAfterId', {
      audienceAfterId: audience.afterId,
    });
  } else {
    pageQb.offset((audience.page - 1) * audience.limit);
  }
  const rows = await pageQb
    .orderBy('u.id', 'ASC')
    .limit(audience.limit)
    .getRawMany<{
      id: string | number;
      role: string;
      language: string | null;
      phone_valid: boolean | null;
      name?: string | null;
      phone?: string | null;
    }>();

  const items: AudienceItem[] = rows.map((row) => ({
    id: String(row.id),
    role: String(row.role),
    language: row.language ?? null,
    phone_valid: row.phone_valid === true,
    ...(audience.fields === 'contact'
      ? { name: row.name ?? null, phone: row.phone ?? null }
      : {}),
  }));

  const total = audience.withTotal ? await base.clone().getCount() : null;

  let stats: {
    by_role: Record<string, number>;
    with_valid_phone: number;
  } | null = null;
  if (audience.withStats) {
    const byRole = await base
      .clone()
      .select('u.role', 'role')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('u.role')
      .getRawMany<{ role: string; count: number | string }>();
    const withPhone = await base
      .clone()
      .andWhere(VALID_UZ_PHONE_SQL)
      .getCount();
    stats = {
      by_role: Object.fromEntries(
        byRole.map((row) => [String(row.role), Number(row.count)]),
      ),
      with_valid_phone: withPhone,
    };
  }

  const last = items[items.length - 1];
  return successRes(
    {
      items,
      total,
      page: audience.afterId ? null : audience.page,
      limit: audience.limit,
      // Keyingi partiya uchun kursor; to'liq bo'lmagan sahifa — oxiri.
      next_after_id: items.length === audience.limit && last ? last.id : null,
      ...(stats ? { stats } : {}),
    },
    200,
    'Audience',
  );
}
