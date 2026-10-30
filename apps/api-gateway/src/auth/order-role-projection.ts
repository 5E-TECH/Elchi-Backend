import { Roles as RoleEnum } from '@app/common';
import { projectOrderContactsForRoles } from './order-contact-projection';

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
 *   - LOGIST (4BftLLnc, ega LG-S1 — "moliyaga aralashmaydi") — HECH QANDAY
 *     pul maydoni yo'q: `LOGIST_HIDDEN_ORDER_FIELDS` (cheklangan ro'yxat +
 *     `total_price`, `sale_collectible_amount`, `paid_online_amount`,
 *     `extra_cost`, market tariflari) va nomi pulga xos HAR QANDAY kalit
 *     (`LOGIST_MONEY_KEY_PATTERN`: narx, summa, tarif, tushum, maosh, balans,
 *     kassa, komissiya, to'lov/to'langan, xarajat, ulush, qarz, yig'im...) —
 *     javob daraxtining istalgan joyida, `order.market` profili ICHIDA ham
 *     (pochta, paket, kuryer, statistika javoblari ham shu proyeksiyadan
 *     o'tadi);
 *   - QOLGAN HAR QANDAY ROL (CUSTOMER, OPERATOR, INVESTOR, noma'lum
 *     yoki bo'sh rollar) — FAIL-CLOSED (kH2zZsz3 tekshiruvi #3): barcha ichki
 *     moliyaviy maydonlar (tariflar, ulushlar, `to_be_paid`/`paid_amount`)
 *     va market profili tariflari YO'Q. Ilgari ro'yxatda yo'q rol to'liq
 *     ko'rinish olardi — mijoz o'z buyurtmasida market tarifi va kuryer/filial
 *     ulushini ko'rardi. Yangi rolga ko'proq maydon kerak bo'lsa — u shu
 *     faylda ANIQ ro'yxatga qo'shiladi;
 *   - BARCHA cheklangan rollarda (yuqoridagi hammasi) buyurtmaning
 *     `customer` obyekti — faqat mijoz ko'rinishi (`CUSTOMER_VIEW_FIELDS`,
 *     vf4513Zn): identity foydalanuvchi yozuvining xodim/pul maydonlari
 *     (`salary`, `tariff_*`, `commission_*`, `username`, `settings`...) yo'q.
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
  // KmWO9gTA: ochilgandagi taxminiy market tarifi — `market_tariff` bilan bir xil.
  'quoted_market_tariff',
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
  // Market AI hisob-kitob narxi (pul) — kuryer/logist ko'rmaydi (review 2026-10-25).
  'ai_price_per_order',
];

/**
 * kH2zZsz3 (tekshiruv #3) — ro'yxatda yo'q rollar (CUSTOMER, OPERATOR,
 * INVESTOR, noma'lum/bo'sh; LOGIST — undan ham qattiqroq, pastda) ko'rmaydigan buyurtma maydonlari:
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
    // T0UGh8bL: sotuvda marketga berilgan naqd — `paid_amount` ning qismi.
    'sale_market_paid_amount',
    // uguUEhin: sotish oynasi chegarasi (WAITING) = summa − onlayn − to'langan
    // − MARKET TARIFI; `to_be_paid` kabi market tarifini ochadi (4BftLLnc prod
    // testi: logistga 30 000 chiqdi). Kuryer (SellModal `readMarketPaidBase`)
    // va market uni oladi — ular bu ro'yxatda emas.
    'sale_market_paid_max',
  ]),
);

/**
 * 4BftLLnc — logist ko'rmaydigan buyurtma maydonlari (karta 4-band):
 * cheklangan ro'yxat + mijoz to'lovi/summa maydonlari + market tariflari.
 * Kartadagi aniq ro'yxat; nomi pulga xos qolgan kalitlarni
 * `LOGIST_MONEY_KEY_PATTERN` qamraydi.
 */
export const LOGIST_HIDDEN_ORDER_FIELDS: readonly string[] = Array.from(
  new Set([
    ...RESTRICTED_HIDDEN_ORDER_FIELDS,
    'total_price',
    'sale_collectible_amount',
    'paid_online_amount',
    'extra_cost',
    'market_tariff',
    'tariff_home',
    'tariff_center',
    // Pochta / paket / kuryer / statistika javoblaridagi pul maydonlari.
    'post_total_price',
    'snapshot_price',
    'salary',
    'payment_day',
    'compensation_mode',
    'commission_type',
    'commission_value',
    'revenue',
    'pickup_fee',
  ]),
);

/**
 * 4BftLLnc — logist uchun nomi pulga xos HAR QANDAY kalit (ro'yxatda
 * unutilgan yangi maydon ham sizmasin): `*price*` (`homeOrdersTotalPrice`,
 * `sent_total_price`, `ai_price_per_order`), `*amount*` (`amount_total`),
 * `*tariff*` (`default_tariff`), `*revenue*` (`totalRevenue`), `*salary*`,
 * `*balance*`, `*cashbox*`, `*commission*`, `*profit*`, `*earning*`,
 * `*income*`, `*paid*` (`to_be_paid`, `paid_amount`, `sale_market_paid_max`,
 * `already_paid_online`, `is_paid`), `*payment*` (`payment_status`,
 * `payment_day`), `*cost*` (`extra_cost`, `extra_cost_party`,
 * `extra_cost_enabled`), `*cashback*`, `*debt*`, `*share*` (kuryer/filial
 * ulushi), `*fee*` (`pickup_fee`; `feed*` emas), `*compensation*`,
 * `*payout*`, `*payable*` / `*receivable*`, `*money*`, `*wage*`, `*bonus*`,
 * `*penalty*`, `*leftover*`. Logist ko'radigan operatsion kalitlar
 * (`status`, `orders_total`, `totalOrders`, `activeCouriers`, ism/telefon)
 * bularga mos EMAS.
 */
export const LOGIST_MONEY_KEY_PATTERN =
  /(price|amount|tariff|revenue|salary|balance|cashbox|commission|profit|earning|income|paid|payment|cost|cashback|debt|share|fee(?!d)|compensation|payout|payable|receivable|money|wage|bonus|penalty|leftover)/i;

/**
 * vf4513Zn (prod tester, 2026-10-26) — buyurtma javobidagi `customer`
 * obyektining MIJOZ KO'RINISHI (allowlist). Order-service `enrichOrders`
 * mijozni identity'ning TO'LIQ foydalanuvchi yozuvi sifatida qo'shadi
 * (`identity.customer.find_by_ids` → `sanitize`): `salary`, `payment_day`,
 * `tariff_*`, `commission_*`, `compensation_mode`, `ai_price_per_order`,
 * `username`, `telegram_username`, `settings`... (mijozda qiymatlari null/0,
 * lekin xodim profili sxemasi ochiladi). Kuryer 26 buni `GET /orders/67` da va
 * `GET /finance/history/114` ning `data.order.customer` ida (33 qatorning
 * hammasida) ko'rardi.
 *
 * Elchi-Frontend (origin/main 8f81309a) buyurtmaning `customer` idan faqat
 * shularni o'qiydi: buyurtma tafsiloti (`orderDetailModel`, `CustomerCard` —
 * id, ism, telefon), kassa tarixi tafsiloti (`FinanceHistoryDetailPopup` —
 * telefon / qo'shimcha raqam, manzil, `district.name`, `region.name`),
 * kuryer/pochta kartalari (`entities/mails`, `orders/list/courier`,
 * `scanBatchView`, `tgScanApi` — ism, telefon, `extra_number`).
 * `district_id` / `region_id` / `status` — joylashuv va holat (pul/xodim
 * maydoni emas). Boshqa maydon kerak bo'lsa — shu yerga ANIQ qo'shiladi.
 */
export const CUSTOMER_VIEW_FIELDS: readonly string[] = [
  'id',
  'name',
  'phone_number',
  'extra_number',
  'address',
  'district_id',
  'region_id',
  'district',
  'region',
  'status',
];

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
  /**
   * vf4513Zn: `customer` obyektida QOLADIGAN maydonlar (allowlist,
   * `CUSTOMER_VIEW_FIELDS` + camelCase). Barcha cheklangan rollarda bor.
   */
  customerFields: ReadonlySet<string>;
  /** 4BftLLnc: LOGIST — nomi shu naqshga mos kalit ham olib tashlanadi. */
  keyPattern?: RegExp;
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

/** vf4513Zn: barcha cheklangan rollar uchun bitta (o'zgarmas) to'plam. */
const CUSTOMER_VIEW_KEYS: ReadonlySet<string> = new Set(
  withCamelVariants(CUSTOMER_VIEW_FIELDS),
);

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
  let keyPattern: RegExp | undefined;
  const hide = (fields: readonly string[], target: Set<string>) =>
    withCamelVariants(fields).forEach((field) => target.add(field));

  // Bo'sh rollar ro'yxati ham noma'lum rol kabi — fail-closed.
  for (const role of normalized.length ? normalized : ['']) {
    if (role === RoleEnum.MARKET || role === RoleEnum.MARKET_OPERATOR) {
      hide(MARKET_HIDDEN_ORDER_FIELDS, orderFields);
    } else if (role === RoleEnum.COURIER) {
      hide(COURIER_HIDDEN_ORDER_FIELDS, orderFields);
      hide(COURIER_HIDDEN_MARKET_PROFILE_FIELDS, marketProfileFields);
    } else if (role === RoleEnum.LOGIST) {
      // 4BftLLnc (LG-S1): logist — hech qanday pul maydoni.
      hide(LOGIST_HIDDEN_ORDER_FIELDS, orderFields);
      hide(COURIER_HIDDEN_MARKET_PROFILE_FIELDS, marketProfileFields);
      keyPattern = LOGIST_MONEY_KEY_PATTERN;
    } else {
      hide(RESTRICTED_HIDDEN_ORDER_FIELDS, orderFields);
      hide(COURIER_HIDDEN_MARKET_PROFILE_FIELDS, marketProfileFields);
    }
  }

  const customerFields = CUSTOMER_VIEW_KEYS;
  return keyPattern
    ? { orderFields, marketProfileFields, customerFields, keyPattern }
    : { orderFields, marketProfileFields, customerFields };
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

/** Faqat `fields` dagi kalitlar qolgan nusxa; hammasi ruxsatli — ASL obyekt. */
const pickKeys = (
  row: Record<string, unknown>,
  fields: ReadonlySet<string>,
): Record<string, unknown> => {
  if (Object.keys(row).every((key) => fields.has(key))) {
    return row;
  }
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => fields.has(key)),
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
    if (
      projection.orderFields.has(key) ||
      (projection.keyPattern && projection.keyPattern.test(key))
    ) {
      changed = true;
      continue;
    }
    // Buyurtma qatorining `market` bolasidan avval market profili moliyasi
    // olib tashlanadi, so'ng u ham odatdagidek aylanadi — 4BftLLnc: logist
    // `LOGIST_MONEY_KEY_PATTERN` i market profili ICHIDA ham ishlaydi
    // (`default_tariff`, `extra_cost_*`; ilgari market bolasi aylanmasdi).
    // vf4513Zn: `customer` (buyurtma mijozi; `market_id` siz buyurtma
    // xulosalarida ham — paket/pochta/skan) — faqat mijoz ko'rinishi
    // (`CUSTOMER_VIEW_FIELDS`), identity'ning to'liq yozuvi emas.
    const child =
      isOrderRow &&
      key === 'market' &&
      isPlainObject(nested) &&
      projection.marketProfileFields.size
        ? omitKeys(nested, projection.marketProfileFields)
        : key === 'customer' && isPlainObject(nested)
          ? pickKeys(nested, projection.customerFields)
          : nested;
    const projected = projectValue(child, projection, depth + 1);
    changed = changed || projected !== nested;
    next[key] = projected;
  }
  return changed ? next : value;
}

/**
 * Buyurtma qaytaruvchi javobni so'rovchi roliga moslab qisqartiradi
 * (kH2zZsz3). To'liq ko'rinishli rol yoki o'zgarish yo'q bo'lsa — ASL javob.
 *
 * T7 (QPq2C1co, B3): pul proyeksiyasidan KEYIN market/operator telefonlari
 * ham (`order-contact-projection.ts`, alohida rol qoidasi — menejer pulni
 * to'liq ko'radi, market telefonini esa yo'q).
 */
export function projectOrderPayloadForRoles<T>(
  roles: string[] | undefined,
  payload: T,
): T {
  const projection = resolveOrderProjection(roles);
  const projected = projection
    ? (projectValue(payload, projection, 0) as T)
    : payload;
  return projectOrderContactsForRoles(roles, projected);
}
