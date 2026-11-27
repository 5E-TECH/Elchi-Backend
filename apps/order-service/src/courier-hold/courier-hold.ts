import {
  COURIER_HOLD_DEADLINE_HOURS,
  COURIER_HOLD_NEAR_FROM_HOURS,
  COURIER_HOLD_OVER_HOURS,
  Group_type,
  Order_status,
  deterministicUuid,
  escapeTelegramHtml,
  findNotificationType,
  type CourierHoldFilter,
} from '@app/common';
import { orderNumberOf } from '../notification/order-notification.service';
import { inQuietWindow } from '../cancel-return/cancel-return-reminder';

/**
 * onXzDc5n — KURYERDAGI BUYURTMALAR (ega so'rovi 2026-11-27: «72 soatdan
 * oshgan», «48 soatga yaqinlashgan», «kuryerda qolgan jo'natmalar», 72 soat
 * filtri va 48 ga yaqinlashganda kuryer + marketga ogohlantirish).
 *
 * QAYSI BUYURTMA «KURYERDA»: custody egasi kuryer (`holder_type = 'COURIER'`)
 * va holat «Yo'lda» / «Kutilmoqda» / «Mijoz kutilmoqda» (sotilgan, to'langan,
 * bekor, yopilgan, marketga topshirilgan — YO'Q), o'chirilmagan.
 *
 * SOAT QACHONDAN: `last_handover_at` — buyurtma shu kuryer qo'liga o'tgan
 * payt (pochta kuryerga jo'natilganda holder COURIER bo'ladi; kuryer pochtani
 * qabul qilganda holder o'zgarmaydi — soat QAYTA BOSHLANMAYDI, BeePost
 * «Kechikkanlar» kabi: aks holda kuryer pochtani kech qabul qilib soatni
 * cho'zardi). Boshqa kuryerga o'tsa — yangi kuryer uchun qaytadan.
 * Kalendar soat: ish kuni sozlamasi (`businessDayRange`) bu yerga TEGMAYDI.
 *
 * ORALIQLAR (soat = to'liq soatlar emas, aniq vaqt farqi):
 *   under_36  soat < 36
 *   near_48   36 ≤ soat < 48 — «48 soatga yaqinlashgan» (ogohlantirish oynasi)
 *   over_48   48 ≤ soat < 72 — «48 soatdan oshgan»
 *   over_72   soat ≥ 72     — «72 soatdan oshgan»
 *
 * Filtr qiymatlari, chegaralar va rollar — `@app/common` (`order/courier-hold.ts`).
 * Bu faylda: SQL, sozlama, matn, payload.
 */

export {
  COURIER_HOLD_DEADLINE_HOURS,
  COURIER_HOLD_NEAR_FROM_HOURS,
  COURIER_HOLD_OVER_HOURS,
  type CourierHoldFilter,
};

export const COURIER_HOLD_WARNING_TYPE = 'order.courier_hold_warning';

export const HOUR_MS = 60 * 60 * 1000;

/** Kuryer qo'lidagi faol holatlar (DB ENUM qiymatlari). */
export const COURIER_HOLD_STATUSES: readonly Order_status[] = Object.freeze([
  Order_status.ON_THE_ROAD,
  Order_status.WAITING,
  Order_status.WAITING_CUSTOMER,
]);

export type CourierHoldBucket = 'under_36' | 'near_48' | 'over_48' | 'over_72';

const textOf = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/**
 * «Kuryerda» sharti (SQL). Literal holatlar — qism indeks
 * `IDX_orders_courier_hold` sharti bilan bir xil (planner indeksni oladi).
 */
export function courierHoldSql(alias = 'o'): string {
  return (
    `${alias}.holder_type = 'COURIER'` +
    ` AND ${alias}.status IN ('on the road', 'waiting', 'waiting_customer')` +
    ` AND ${alias}.is_deleted = false AND ${alias}.deleted_at IS NULL` +
    ` AND ${alias}.last_handover_at IS NOT NULL`
  );
}

/**
 * Filtr → `last_handover_at` chegaralari: `before` — shu paytdan OLDIN yoki
 * teng (soat ≥ N), `after` — shu paytdan KEYIN (soat < M). `any` — chegarasiz.
 */
export function courierHoldRange(
  filter: CourierHoldFilter,
  now: Date,
): { before?: Date; after?: Date } {
  const ago = (hours: number) => new Date(now.getTime() - hours * HOUR_MS);
  switch (filter) {
    case 'near_48':
      return {
        before: ago(COURIER_HOLD_NEAR_FROM_HOURS),
        after: ago(COURIER_HOLD_DEADLINE_HOURS),
      };
    case 'over_48':
      return {
        before: ago(COURIER_HOLD_DEADLINE_HOURS),
        after: ago(COURIER_HOLD_OVER_HOURS),
      };
    case 'over_72':
      return { before: ago(COURIER_HOLD_OVER_HOURS) };
    default:
      return {};
  }
}

/** Kuryerda necha soat (to'liq soatlar, kamida 0). */
export const courierHoldHours = (since: Date, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - since.getTime()) / HOUR_MS));

export function courierHoldBucketOf(since: Date, now: Date): CourierHoldBucket {
  const hours = (now.getTime() - since.getTime()) / HOUR_MS;
  if (hours >= COURIER_HOLD_OVER_HOURS) return 'over_72';
  if (hours >= COURIER_HOLD_DEADLINE_HOURS) return 'over_48';
  if (hours >= COURIER_HOLD_NEAR_FROM_HOURS) return 'near_48';
  return 'under_36';
}

// ── Ogohlantirish sozlamalari ─────────────────────────────────────────────

export interface CourierHoldWarnConfig {
  /** `COURIER_HOLD_WARN_ENABLED` — sukut YOQIQ; `false` — o'chiq. */
  enabled: boolean;
  /**
   * `COURIER_HOLD_WARN_QUIET_HOURS` (Toshkent, `HH:MM-HH:MM`), sukut
   * `22:00-08:00`. Umumiy `NOTIF_PROMO_QUIET_HOURS` (18:00-09:00) bu yerda
   * ISHLATILMAYDI: 12 soatlik oynadan (36–48) uzun taqiq xabarni 48 dan
   * keyinga surib yuborardi; kuryerlar kechgacha ishlaydi.
   */
  quiet: { start: number; end: number };
}

export const COURIER_HOLD_WARN_DEFAULTS = Object.freeze({
  enabled: true,
  quietHours: '22:00-08:00',
});

const minutesOf = (hhmm: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
};

/** `HH:MM-HH:MM` → daqiqalar; noto'g'ri — `null`. */
function parseWarnQuiet(value: string): { start: number; end: number } | null {
  const [rawStart, rawEnd, extra] = value.replace(/\s+/g, '').split('-');
  if (extra !== undefined) return null;
  const start = minutesOf(rawStart ?? '');
  const end = minutesOf(rawEnd ?? '');
  return start === null || end === null ? null : { start, end };
}

const flagOf = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  const raw = textOf(value).toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'on', 'yes'].includes(raw)) return true;
  if (['false', '0', 'off', 'no'].includes(raw)) return false;
  return fallback;
};

/** Env'dan (har tikda o'qiladi). Noto'g'ri qiymat — sukut. */
export function readCourierHoldWarnConfig(
  get: (key: string) => unknown,
): CourierHoldWarnConfig {
  return {
    enabled: flagOf(
      get('COURIER_HOLD_WARN_ENABLED'),
      COURIER_HOLD_WARN_DEFAULTS.enabled,
    ),
    quiet:
      parseWarnQuiet(textOf(get('COURIER_HOLD_WARN_QUIET_HOURS'))) ??
      (parseWarnQuiet(COURIER_HOLD_WARN_DEFAULTS.quietHours) as {
        start: number;
        end: number;
      }),
  };
}

export const courierHoldInQuiet = (
  now: Date,
  config: CourierHoldWarnConfig,
): boolean => inQuietWindow(now, config.quiet);

// ── Xabar matnlari va payload ─────────────────────────────────────────────

/** Ogohlantiriladigan buyurtma (DB qatoridan). */
export interface CourierHoldDueOrder {
  id: string;
  market_id: string;
  courier_id: string;
  since: Date;
}

export interface CourierHoldNotificationPayload {
  type: typeof COURIER_HOLD_WARNING_TYPE;
  category: string;
  priority: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  link: string;
  recipient_ids: string[];
  channels: string[];
  telegram?: { market_id: string; group_type: Group_type; text: string };
  client_request_id: string;
}

/** Matnda eng ko'pi shuncha buyurtma raqami (qolgani «+N»). */
const MAX_NUMBERS = 30;

const numberOf = (id: string): string => orderNumberOf(id) || id;

const sortedIds = (orders: CourierHoldDueOrder[]): string[] =>
  [...new Set(orders.map((o) => o.id))].sort((a, b) => Number(a) - Number(b));

/** «EL-100001, EL-100002 (+3)» */
function numbersLine(ids: string[]): string {
  const shown = ids.slice(0, MAX_NUMBERS).map(numberOf).join(', ');
  return ids.length > MAX_NUMBERS
    ? `${shown} (+${ids.length - MAX_NUMBERS})`
    : shown;
}

/** Eng uzoq turgani — soat (eng kichik `since`). */
const oldestHours = (orders: CourierHoldDueOrder[], now: Date): number =>
  Math.max(...orders.map((o) => courierHoldHours(o.since, now)));

/** Muddatgacha qolgan eng kam soat (≥ 0). */
const leftHours = (orders: CourierHoldDueOrder[], now: Date): number =>
  Math.max(0, COURIER_HOLD_DEADLINE_HOURS - oldestHours(orders, now));

export const COURIER_HOLD_COURIER_LINK = '/courier-hold?tab=near_48';
export const COURIER_HOLD_MARKET_LINK = '/courier-hold?tab=near_48';

const isId = (value: string) => /^\d+$/.test(value);

/**
 * KURYERGA — bir tikdagi shu kuryerning yangi kesib o'tgan buyurtmalari BITTA
 * xabarda: ilova ichi + realtime + Telegram SHAXSIY chat (`users.telegram_id`;
 * `telegram` guruh nishoni berilmaydi — notification-service DM qiladi, matni
 * `title` + `body`). `client_request_id` — buyurtmalar to'plamidan barqaror
 * (outbox qayta yetkazsa ikkinchisi yuborilmaydi).
 */
export function buildCourierHoldCourierPayload(
  courierId: string,
  orders: CourierHoldDueOrder[],
  now: Date,
): CourierHoldNotificationPayload | null {
  const entry = findNotificationType(COURIER_HOLD_WARNING_TYPE);
  if (!entry || !isId(courierId) || !orders.length) return null;
  const ids = sortedIds(orders);
  const left = leftHours(orders, now);
  return {
    type: COURIER_HOLD_WARNING_TYPE,
    category: entry.category,
    priority: entry.priority,
    title: '⏳ Buyurtmalar 48 soatga yaqinlashdi',
    body:
      `Sizda ${ids.length} ta buyurtma ${COURIER_HOLD_NEAR_FROM_HOURS} soatdan beri turibdi — ` +
      `${left > 0 ? `${left} soat ichida` : 'tezda'} sotish yoki qaytarish kerak.\n` +
      `Buyurtmalar: ${numbersLine(ids)}`,
    data: {
      audience: 'courier',
      courier_id: courierId,
      count: ids.length,
      order_ids: ids,
      order_numbers: ids.map(numberOf),
      deadline_hours: COURIER_HOLD_DEADLINE_HOURS,
      telegram_cabinet_link: true,
    },
    link: COURIER_HOLD_COURIER_LINK,
    recipient_ids: [courierId],
    channels: [...entry.default_channels],
    client_request_id: deterministicUuid(
      `courier-hold-warning:courier:${courierId}:${ids.join(',')}`,
    ),
  };
}

/** Market guruhi matni (HTML, `parse_mode: HTML`). Kuryer telefoni YO'Q. */
export function buildCourierHoldMarketTelegramText(
  orders: CourierHoldDueOrder[],
  now: Date,
): string {
  const ids = sortedIds(orders);
  const left = leftHours(orders, now);
  return [
    '<b>⏳ Buyurtmalar kuryerda 48 soatga yaqinlashdi</b>',
    '',
    `${ids.length} ta buyurtma kuryerda ${COURIER_HOLD_NEAR_FROM_HOURS} soatdan beri turibdi` +
      ` (muddatgacha ${left > 0 ? `${left} soat` : 'oz vaqt'} qoldi).`,
    '',
    `Buyurtmalar: ${escapeTelegramHtml(numbersLine(ids))}`,
    '',
    "Kabinetdagi <b>«Kuryerdagi buyurtmalar»</b> bo'limida ko'rishingiz mumkin.",
  ].join('\n');
}

/**
 * MARKETGA (firma) — bir tikdagi shu marketning yangi kesib o'tgan
 * buyurtmalari BITTA xabarda: ilova ichi + realtime + marketning asosiy
 * («create») Telegram guruhi. PII yo'q (faqat raqamlar).
 */
export function buildCourierHoldMarketPayload(
  marketId: string,
  orders: CourierHoldDueOrder[],
  now: Date,
): CourierHoldNotificationPayload | null {
  const entry = findNotificationType(COURIER_HOLD_WARNING_TYPE);
  if (!entry || !isId(marketId) || !orders.length) return null;
  const ids = sortedIds(orders);
  return {
    type: COURIER_HOLD_WARNING_TYPE,
    category: entry.category,
    priority: entry.priority,
    title: '⏳ Buyurtmalar kuryerda 48 soatga yaqinlashdi',
    body: `${ids.length} ta buyurtma kuryerda ${COURIER_HOLD_NEAR_FROM_HOURS} soatdan beri turibdi: ${numbersLine(ids)}`,
    data: {
      audience: 'market',
      market_id: marketId,
      count: ids.length,
      order_ids: ids,
      order_numbers: ids.map(numberOf),
      deadline_hours: COURIER_HOLD_DEADLINE_HOURS,
    },
    link: COURIER_HOLD_MARKET_LINK,
    recipient_ids: [marketId],
    channels: [...entry.default_channels],
    telegram: {
      market_id: marketId,
      group_type: Group_type.CREATE,
      text: buildCourierHoldMarketTelegramText(orders, now),
    },
    client_request_id: deterministicUuid(
      `courier-hold-warning:market:${marketId}:${ids.join(',')}`,
    ),
  };
}
