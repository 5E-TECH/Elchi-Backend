import { Roles as RoleEnum } from '@app/common';

/**
 * (Ho5qcDn4 TC9) Market o'z buyurtmasining tarixini (`GET /orders/:id/tracking`)
 * ko'radi. Tarixdagi `actor` — Elchi xodimi (superadmin, menejer, kuryer):
 * order-service unga `username` va `phone_number` ni ham qo'shadi. Tashqi
 * market akkauntiga xodimning login va shaxsiy raqami kerak emas — unga faqat
 * KIM (ism) va qaysi ROLDA ekani qoladi. Ichki rollar (admin, filial, kuryer)
 * javobni avvalgidek oladi.
 */
export const MARKET_TRACKING_ACTOR_FIELDS: readonly string[] = [
  'id',
  'name',
  'role',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const MARKET_ROLES: readonly string[] = [
  RoleEnum.MARKET,
  RoleEnum.MARKET_OPERATOR,
];
const STAFF_ROLES: readonly string[] = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.MANAGER,
  RoleEnum.BRANCH,
  RoleEnum.REGISTRATOR,
  RoleEnum.COURIER,
];

const isMarketOnly = (roles?: string[]): boolean => {
  const normalized = (roles ?? []).map((role) =>
    String(role).trim().toLowerCase(),
  );
  return (
    normalized.some((role) => MARKET_ROLES.includes(role)) &&
    !normalized.some((role) => STAFF_ROLES.includes(role))
  );
};

const projectActor = (actor: unknown): unknown => {
  if (!isRecord(actor)) return actor;
  return Object.fromEntries(
    MARKET_TRACKING_ACTOR_FIELDS.filter((key) => key in actor).map((key) => [
      key,
      actor[key],
    ]),
  );
};

/**
 * `order.tracking` javobi (`{ data: event[], meta }` yoki xom massiv) — market
 * rolida har hodisaning `actor` i qisqartiriladi. Boshqa rollarda va tanilmagan
 * shaklda javob o'zgarmaydi (asl obyekt mutatsiya qilinmaydi).
 */
export function projectOrderTrackingForRoles(
  roles: string[] | undefined,
  response: unknown,
): unknown {
  if (!isMarketOnly(roles)) return response;
  const projectEvents = (events: unknown[]) =>
    events.map((event) =>
      isRecord(event) && 'actor' in event
        ? { ...event, actor: projectActor(event.actor) }
        : event,
    );
  if (Array.isArray(response)) return projectEvents(response);
  if (isRecord(response) && Array.isArray(response.data)) {
    return { ...response, data: projectEvents(response.data) };
  }
  return response;
}
