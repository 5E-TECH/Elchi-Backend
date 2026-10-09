import { Roles as RoleEnum } from '@app/common';

/**
 * kH2zZsz3 — BUYURTMA JAVOBINING ROL BO'YICHA MOLIYAVIY PROYEKSIYASI.
 *
 * Ilgari GET /orders/:id (va ro'yxatlar, QR, skan) javobi rolga qaramay
 * BIR XIL edi: kuryer (TEST Claude Kuryer, order 25) `market_tariff:20000`,
 * `branch_share`, `order.market.tariff_center` ni, market esa kuryer
 * tarifi/ulushi va filial ulushini ko'rardi. UI ularni yashirsa ham API'da
 * maxfiylik yo'q edi. Karta talabi: superadmin/menejer — hammasi; market —
 * faqat market tarifi; kuryer — faqat kuryer tarifi.
 *
 * Qoidalar:
 *   - SUPERADMIN/ADMIN va filial xodimlari (MANAGER/BRANCH/REGISTRATOR) —
 *     o'zgarishsiz (to'liq ko'rinish);
 *   - MARKET / MARKET_OPERATOR — kuryer tarifi/ulushi va filial ulushi
 *     (`branch_share`, `branch_cashbox_amount`) YO'Q;
 *   - COURIER — market tarifi, filial ulushi va `order.market` profilidagi
 *     market tariflari/komissiyasi YO'Q. Kuryerga kerakli maydonlar
 *     (o'z tarifi/ulushi, `total_price`, `sale_collectible_amount`,
 *     `paid_online_amount`) qoladi;
 *   - QOLGAN HAR QANDAY ROL (CUSTOMER, OPERATOR, INVESTOR, LOGIST, noma'lum
 *     yoki bo'sh rollar) — FAIL-CLOSED (kH2zZsz3 tekshiruvi #3): barcha ichki
 *     moliyaviy maydonlar (tariflar, ulushlar, `to_be_paid`/`paid_amount`)
 *     va market profili tariflari YO'Q. Ilgari ro'yxatda yo'q rol to'liq
 *     ko'rinish olardi — mijoz o'z buyurtmasida market tarifi va kuryer/filial
 *     ulushini ko'rardi. Yangi rolga ko'proq maydon kerak bo'lsa — u shu
 *     faylda ANIQ ro'yxatga qo'shiladi.
 *
 * ⚠️ OCHIQ QAROR — `to_be_paid` / `paid_amount` (marketga to'lanadigan /
 * market qarzining to'langan qismi) kuryerdan HOZIRCHA olib tashlanmaydi:
 * Elchi-Frontend buyurtma detali (new_orderUpdate.tsx getPaymentRows,
 * 323-324 qatorlar) ularni BARCHA rolga, jumladan kuryerga ko'rsatadi —
 * maydon yo'qolsa ekranda "NaN so'm" chiqadi. Ta'rif bo'yicha
 * `to_be_paid = total_price − market_tariff` (order-lifecycle.service.ts),
 * ya'ni shu ikki maydon qolguncha kuryer market tarifini HISOBLAB oladi —
 * kuryerda `market_tariff` ni yashirish to'liq emas. Frontend kuryer uchun
 * bu qatorlarni yashirgach, ularni `COURIER_HIDDEN_ORDER_FIELDS` ga qo'shish
 * kifoya.
 *
 * Maydon O'CHIRILADI (null qilinmaydi). Elchi-Frontend bilan moslik
 * (src/widgets/order-meta/model/orderMeta.ts, 373f07d): `readOrderMeta`
 * `market_tariff`/`courier_tariff`/`courier_share`/`branch_share` ni o'qiydi,
 * lekin `visibleTariffs(role)` faqat rolga ruxsat etilganini chizadi —
 * superadmin/admin/manager: hammasi, market: `marketTariff`, kuryer:
 * `courierTariff`, qolganlar: hech narsa. Backend aynan shu maydonlarni
 * qoldiradi, demak FE sinmaydi (yo'q maydon `null` → "—", u ham chizilmaydi).
 */

/** Market va uning operatori ko'rmaydigan buyurtma maydonlari. */
export const MARKET_HIDDEN_ORDER_FIELDS: readonly string[] = [
  'courier_tariff',
  'courier_share',
  'branch_share',
  'branch_cashbox_amount',
];

/** Kuryer ko'rmaydigan buyurtma maydonlari. */
export const COURIER_HIDDEN_ORDER_FIELDS: readonly string[] = [
  'market_tariff',
  'branch_share',
  'branch_cashbox_amount',
];

/**
 * Kuryer (va fail-closed rollar) ko'rmaydigan `order.market` (market profili)
 * moliyaviy maydonlari: `tariff_center`/`tariff_home` — aynan market tarifi
 * (order.market_tariff shulardan olinadi). Frontend `order.market` dan faqat
 * nom/telefon/rol, `expense_proof_conditions`, `add_order`,
 * `cancelled_handover_qr_required` ni o'qiydi — ular saqlanadi.
 */
export const COURIER_HIDDEN_MARKET_PROFILE_FIELDS: readonly string[] = [
  'tariff_home',
  'tariff_center',
  'salary',
  'payment_day',
  'compensation_mode',
  'commission_type',
  'commission_value',
];

/**
 * kH2zZsz3 (tekshiruv #3) — ro'yxatda yo'q rollar (CUSTOMER, OPERATOR,
 * INVESTOR, LOGIST, noma'lum/bo'sh) ko'rmaydigan buyurtma maydonlari:
 * market VA kuryer ko'rmaydiganlarning birlashmasi + market moliyasi
 * (`to_be_paid`, `paid_amount` — ular orqali market tarifi hisoblanadi).
 * `total_price`, `sale_collectible_amount`, `paid_online_amount`,
 * `extra_cost` qoladi.
 */
export const RESTRICTED_HIDDEN_ORDER_FIELDS: readonly string[] = Array.from(
  new Set([
    ...MARKET_HIDDEN_ORDER_FIELDS,
    ...COURIER_HIDDEN_ORDER_FIELDS,
    'to_be_paid',
    'paid_amount',
  ]),
);

/** To'liq ko'rinishli rollar — proyeksiya qo'llanmaydi. */
const FULL_VIEW_ROLES: readonly string[] = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.MANAGER,
  RoleEnum.BRANCH,
  RoleEnum.REGISTRATOR,
];

/** Javob daraxtining xavfsizlik chegarasi (RMQ JSON'da sikl bo'lmaydi). */
const MAX_DEPTH = 32;

export type OrderProjection = {
  orderFields: ReadonlySet<string>;
  marketProfileFields: ReadonlySet<string>;
};

const normalizeRoles = (roles?: string[]): string[] =>
  (roles ?? [])
    .map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);

const toCamelKey = (snake: string): string =>
  snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** snake_case maydonlar + ularning camelCase ko'rinishi (eski shakllar uchun). */
const withCamelVariants = (fields: readonly string[]): string[] =>
  fields.flatMap((field) => [field, toCamelKey(field)]);

/**
 * So'rovchi rollari uchun proyeksiya. `null` — to'liq ko'rinish
 * (proyeksiya yo'q). Bir nechta cheklangan rol bo'lsa (masalan kuryer va
 * market) — yashiriladigan maydonlar BIRLASHADI. Ro'yxatda yo'q rol yoki
 * rollar umuman bo'lmasa — FAIL-CLOSED: `RESTRICTED_HIDDEN_ORDER_FIELDS`
 * (kH2zZsz3 tekshiruvi #3; ilgari bunday rol to'liq ko'rinish olardi).
 */
export function resolveOrderProjection(
  roles?: string[],
): OrderProjection | null {
  const normalized = normalizeRoles(roles);
  if (normalized.some((role) => FULL_VIEW_ROLES.includes(role))) {
    return null;
  }

  const orderFields = new Set<string>();
  const marketProfileFields = new Set<string>();
  const hide = (fields: readonly string[], target: Set<string>) =>
    withCamelVariants(fields).forEach((field) => target.add(field));

  // Bo'sh rollar ro'yxati ham noma'lum rol kabi — fail-closed.
  for (const role of normalized.length ? normalized : ['']) {
    if (role === RoleEnum.MARKET || role === RoleEnum.MARKET_OPERATOR) {
      hide(MARKET_HIDDEN_ORDER_FIELDS, orderFields);
    } else if (role === RoleEnum.COURIER) {
      hide(COURIER_HIDDEN_ORDER_FIELDS, orderFields);
      hide(COURIER_HIDDEN_MARKET_PROFILE_FIELDS, marketProfileFields);
    } else {
      hide(RESTRICTED_HIDDEN_ORDER_FIELDS, orderFields);
      hide(COURIER_HIDDEN_MARKET_PROFILE_FIELDS, marketProfileFields);
    }
  }

  return { orderFields, marketProfileFields };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** `market` bolasi buyurtma qatoriga tegishlimi (market_id bor obyekt). */
const hasMarketId = (row: Record<string, unknown>): boolean =>
  'market_id' in row || 'marketId' in row;

/** `fields` olib tashlangan nusxa; hech narsa o'zgarmasa — ASL obyekt. */
const omitKeys = (
  row: Record<string, unknown>,
  fields: ReadonlySet<string>,
): Record<string, unknown> => {
  if (!Object.keys(row).some((key) => fields.has(key))) {
    return row;
  }
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !fields.has(key)),
  );
};

/**
 * Javob daraxtini aylanib chiqadi (konvert `{statusCode,data}`, `data:[]`,
 * `allOrdersByPostId`, `items` — shakl muhim emas). Yashiriladigan buyurtma
 * maydonlari HAR QANDAY obyektdan olib tashlanadi (ularning nomi faqat
 * buyurtma pul snapshotiga xos), market profili maydonlari esa faqat
 * buyurtma qatorining (`market_id` bor obyekt) `market` bolasidan.
 *
 * Copy-on-write: hech narsa o'zgarmagan tarmoq ASL havolani qaytaradi.
 */
function projectValue(
  value: unknown,
  projection: OrderProjection,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const projected = projectValue(item, projection, depth + 1);
      changed = changed || projected !== item;
      return projected;
    });
    return changed ? next : value;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const isOrderRow = hasMarketId(value);
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (projection.orderFields.has(key)) {
      changed = true;
      continue;
    }
    let projected: unknown;
    if (
      isOrderRow &&
      key === 'market' &&
      isPlainObject(nested) &&
      projection.marketProfileFields.size
    ) {
      projected = omitKeys(nested, projection.marketProfileFields);
    } else {
      projected = projectValue(nested, projection, depth + 1);
    }
    changed = changed || projected !== nested;
    next[key] = projected;
  }
  return changed ? next : value;
}

/**
 * Buyurtma qaytaruvchi javobni so'rovchi roliga moslab qisqartiradi
 * (kH2zZsz3). To'liq ko'rinishli rol yoki o'zgarish yo'q bo'lsa — ASL javob.
 */
export function projectOrderPayloadForRoles<T>(
  roles: string[] | undefined,
  payload: T,
): T {
  const projection = resolveOrderProjection(roles);
  if (!projection) {
    return payload;
  }
  return projectValue(payload, projection, 0) as T;
}
