import { Roles as RoleEnum } from '@app/common';

/**
 * T7 (QPq2C1co, B3) — MARKET TELEFONINI MENEJER / KURYERDAN YASHIRISH.
 *
 * Ega qarori (2026-10-29): kuryer va filial menejeri marketga to'g'ridan-
 * to'g'ri qo'ng'iroq qilmaydi — ular viloyat logistiga (`problem_contacts`)
 * bog'lanadi. Mijoz telefoni QOLADI.
 *
 * Pul proyeksiyasidan (`order-role-projection.ts`, `FULL_VIEW_ROLES`)
 * ALOHIDA: u yerda menejer to'liq ko'rinishli, bu yerda esa yo'q.
 *
 * Qoida: so'rovchida SUPERADMIN / ADMIN / REGISTRATOR / LOGIST YO'Q va
 * MANAGER / BRANCH / COURIER dan biri BOR bo'lsa (bir nechta rolli
 * so'rovchida to'liq ko'rinishli rol ustun):
 *   - javob daraxtining ISTALGAN joyidan `operator_phone`,
 *     `secondary_operator_phone` (operator raqami — marketniki);
 *   - `market` obyektidan (buyurtma qatori, «Yangi buyurtmalar» market
 *     qatorlari, ...) `phone_number`, `extra_number`,
 *     `default_operator_phone`, `username`
 * O'CHIRILADI (null emas). `customer`, `courier` obyektlariga tegilmaydi.
 * Boshqa rollar (market — o'ziniki, operator, investor...) — o'zgarishsiz.
 */

/** Market telefonini ko'radigan rollar (to'liq ko'rinish). */
const CONTACT_FULL_VIEW_ROLES: readonly string[] = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.REGISTRATOR,
  RoleEnum.LOGIST,
];

/** Market telefoni yashiriladigan rollar. */
const CONTACT_RESTRICTED_ROLES: readonly string[] = [
  RoleEnum.MANAGER,
  RoleEnum.BRANCH,
  RoleEnum.COURIER,
];

/** Javob daraxtining istalgan joyidan olib tashlanadigan kalitlar. */
export const HIDDEN_OPERATOR_PHONE_FIELDS: readonly string[] = [
  'operator_phone',
  'secondary_operator_phone',
  'operatorPhone',
  'secondaryOperatorPhone',
];

/** `market` obyektidan olib tashlanadigan kalitlar. */
export const HIDDEN_MARKET_CONTACT_FIELDS: readonly string[] = [
  'phone_number',
  'extra_number',
  'default_operator_phone',
  'username',
  // Telegram manzili ham aloqa kanali (FE uni faqat o'z profilida o'qiydi).
  'telegram_username',
  'telegramUsername',
  'phoneNumber',
  'extraNumber',
  'defaultOperatorPhone',
];

/** Buyurtma ichidagi market obyekti kalitlari. */
const MARKET_KEYS: ReadonlySet<string> = new Set(['market']);

const MAX_DEPTH = 32;

const normalizeRoles = (roles?: string[]): string[] =>
  (roles ?? [])
    .map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);

/** So'rovchidan market telefoni yashirilsinmi. */
export function shouldHideMarketContacts(roles?: string[]): boolean {
  const normalized = normalizeRoles(roles);
  if (normalized.some((role) => CONTACT_FULL_VIEW_ROLES.includes(role))) {
    return false;
  }
  return normalized.some((role) => CONTACT_RESTRICTED_ROLES.includes(role));
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const OPERATOR_KEYS: ReadonlySet<string> = new Set(
  HIDDEN_OPERATOR_PHONE_FIELDS,
);
const MARKET_CONTACT_KEYS: ReadonlySet<string> = new Set(
  HIDDEN_MARKET_CONTACT_FIELDS,
);

/**
 * Elchi mas'uli maydonlari — faqat SUPERADMIN / ADMIN ga (market qatorida
 * ham, buyurtmadagi `market` obyektida ham; registrator, logist, market...
 * ko'rmaydi — market o'z mas'ulini `GET /users/me/contacts` dan oladi).
 */
const RESPONSIBLE_KEYS: ReadonlySet<string> = new Set([
  'responsible',
  'responsible_source',
  'market_responsible_id',
]);

/** So'rovchi SUPERADMIN yoki ADMIN mi (mas'ul maydonlarini ko'radi). */
const isSystemAdmin = (roles?: string[]): boolean => {
  const normalized = normalizeRoles(roles);
  return (
    normalized.includes(RoleEnum.SUPERADMIN) ||
    normalized.includes(RoleEnum.ADMIN)
  );
};

/** Aylanish rejimi: qaysi kalitlar olib tashlanadi. */
type ContactProjection = {
  /** Javobning istalgan joyidan (operator telefonlari) — yoki null. */
  anywhere: ReadonlySet<string> | null;
  /** `market` obyektidan. */
  market: ReadonlySet<string>;
};

/** `fields` olib tashlangan nusxa; hech narsa o'zgarmasa — ASL obyekt. */
const omitKeys = (
  row: Record<string, unknown>,
  fields: ReadonlySet<string>,
): Record<string, unknown> =>
  Object.keys(row).some((key) => fields.has(key))
    ? Object.fromEntries(
        Object.entries(row).filter(([key]) => !fields.has(key)),
      )
    : row;

/** Copy-on-write aylanish: o'zgarmagan tarmoq ASL havolani qaytaradi. */
function projectValue(
  value: unknown,
  mode: ContactProjection,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const projected = projectValue(item, mode, depth + 1);
      changed = changed || projected !== item;
      return projected;
    });
    return changed ? next : value;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (mode.anywhere?.has(key)) {
      changed = true;
      continue;
    }
    // customer / courier — tegilmaydi (mijoz telefoni qoladi).
    if (key === 'customer' || key === 'courier') {
      next[key] = nested;
      continue;
    }
    const child =
      MARKET_KEYS.has(key) && isPlainObject(nested)
        ? omitKeys(nested, mode.market)
        : nested;
    const projected = projectValue(child, mode, depth + 1);
    changed = changed || projected !== nested;
    next[key] = projected;
  }
  return changed ? next : value;
}

const HIDE_CONTACTS_MODE: ContactProjection = {
  anywhere: OPERATOR_KEYS,
  market: new Set([...MARKET_CONTACT_KEYS, ...RESPONSIBLE_KEYS]),
};
const HIDE_RESPONSIBLE_MODE: ContactProjection = {
  anywhere: null,
  market: RESPONSIBLE_KEYS,
};

/**
 * Buyurtma qaytaruvchi javobdan market/operator telefonlarini so'rovchi
 * roliga ko'ra olib tashlaydi; `market` obyektidagi Elchi mas'uli
 * (`responsible`, `responsible_source`, `market_responsible_id`) —
 * SUPERADMIN / ADMIN dan boshqa HAMMAGA olib tashlanadi. SA/admin — ASL javob.
 */
export function projectOrderContactsForRoles<T>(
  roles: string[] | undefined,
  payload: T,
): T {
  if (shouldHideMarketContacts(roles)) {
    return projectValue(payload, HIDE_CONTACTS_MODE, 0) as T;
  }
  if (isSystemAdmin(roles)) {
    return payload;
  }
  return projectValue(payload, HIDE_RESPONSIBLE_MODE, 0) as T;
}

/**
 * Market QATORINING o'zidan (GET /markets, GET /users/:id — market) telefon
 * maydonlarini olib tashlaydi. To'liq ko'rinishli rol — ASL qator.
 */
export function projectMarketRowContactsForRoles<T>(
  roles: string[] | undefined,
  row: T,
): T {
  if (!shouldHideMarketContacts(roles) || !isPlainObject(row)) {
    return row;
  }
  return omitKeys(omitKeys(row, MARKET_CONTACT_KEYS), OPERATOR_KEYS) as T;
}

/** Foydalanuvchi yozuvi market tomoniga tegishlimi (market yoki uning operatori). */
const MARKET_SIDE_ROLES: ReadonlySet<string> = new Set([
  RoleEnum.MARKET,
  RoleEnum.MARKET_OPERATOR,
]);

/**
 * Foydalanuvchi QATORI (GET /users ro'yxati, GET /users/:id): market yoki
 * market operatori yozuvi bo'lsa — menejer/filial/kuryerga telefon va login
 * maydonlarisiz; Elchi mas'uli (`responsible`, `responsible_source`,
 * `market_responsible_id`) SUPERADMIN / ADMIN dan boshqasiga berilmaydi.
 * Boshqa rollar qatori — ASL.
 */
export function projectUserRowContactsForRoles<T>(
  roles: string[] | undefined,
  row: T,
): T {
  if (!isPlainObject(row)) {
    return row;
  }
  const role = typeof row.role === 'string' ? row.role.toLowerCase() : '';
  if (!MARKET_SIDE_ROLES.has(role)) {
    return row;
  }
  let next: Record<string, unknown> = projectMarketRowContactsForRoles(
    roles,
    row,
  );
  if (!isSystemAdmin(roles)) {
    next = omitKeys(next, RESPONSIBLE_KEYS);
  }
  return next as T;
}
