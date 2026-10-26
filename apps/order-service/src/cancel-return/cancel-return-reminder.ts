import {
  Group_type,
  NotificationChannel,
  deterministicUuid,
  escapeTelegramHtml,
  findNotificationType,
  renderNotificationGroupKey,
  startOfTashkentDay,
} from '@app/common';
import {
  orderDetailLink,
  orderNumberOf,
} from '../notification/order-notification.service';
import { cancelReturnStageSql } from './cancel-return';

/**
 * vNKGbg5q (BG7) — BEKOR POSILKA UZOQ OLIB KETILMASA: eslatma va eskalatsiya
 * (ega qarori 2026-10-19; BeePost `market-handover.cron.ts` naqshi).
 *
 *   D+3  marketga eslatma — in-app + marketning «bekor» Telegram guruhi
 *        (`order.cancel_return_reminder`, market bo'yicha BITTA xabar),
 *        `orders.handover_notified_at`;
 *   D+7  admin navbatiga eskalatsiya — admin/superadmin inbox'i
 *        (`order.cancel_return_escalated`, buyurtma bo'yicha),
 *        `orders.handover_escalated_at`.
 *
 * QAYSI BUYURTMA: BG1 bosqichi `hq` yoki `branch` (status `cancelled`, holder
 * HQ/BRANCH, joyda qabul qilingan) — `cancelReturnStageSql` bilan AYNAN bir
 * xil; ombor buyurtmasi (`fulfillment_source = 'WAREHOUSE'`) — YO'Q (u marketga
 * emas, omborga qaytadi; ombor kodi o'qilmaydi ham). «D» — BG1 `received_at`:
 * joydagi oxirgi `cancelled_post_received` hodisasi va custody vaqtining
 * kattasi (`buildCancelReturnView` bilan bir xil).
 *
 * ⚠️ HOLAT O'ZGARMAYDI — faqat belgi qo'yiladi (BeePost: avto-yopish yo'q).
 * Bu faylda faqat sof qoidalar (sozlama, vaqt oynasi, SQL, matn, payload).
 */

export const CANCEL_RETURN_REMINDER_TYPE = 'order.cancel_return_reminder';
export const CANCEL_RETURN_ESCALATED_TYPE = 'order.cancel_return_escalated';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const TASHKENT_OFFSET_MS = 5 * 60 * MINUTE_MS;

/** Telegram xabarida eng ko'pi shuncha buyurtma raqami (qolgani «+N»). */
const TELEGRAM_MAX_NUMBERS = 30;
/** Telegram xabarida eng ko'pi shuncha joy qatori. */
const TELEGRAM_MAX_PLACES = 10;

export interface CancelReturnReminderConfig {
  /** `CANCEL_RETURN_REMINDER_ENABLED` — sukut YOQIQ (ega qarori: 3/7 kun — ha). */
  enabled: boolean;
  /** `CANCEL_RETURN_REMIND_AFTER_DAYS` — sukut 3. */
  remindAfterDays: number;
  /** `CANCEL_RETURN_ESCALATE_AFTER_DAYS` — sukut 7. */
  escalateAfterDays: number;
  /** `CANCEL_RETURN_REMINDER_HOUR` — kunlik yugurish soati (Toshkent), sukut 10. */
  runHour: number;
  /**
   * Tungi taqiq (daqiqa, Toshkent): bildirishnoma tizimining umumiy
   * `NOTIF_PROMO_QUIET_HOURS` (sukut `18:00-09:00`) — shu oynada hech narsa
   * yuborilmaydi (Telegram guruh relay'ida o'z taqiqi yo'q).
   */
  quiet: { start: number; end: number };
}

export const CANCEL_RETURN_REMINDER_DEFAULTS = Object.freeze({
  enabled: true,
  remindAfterDays: 3,
  escalateAfterDays: 7,
  runHour: 10,
  quietHours: '18:00-09:00',
});

const textOf = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

const flagOf = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;
  const raw = textOf(value).toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'on', 'yes'].includes(raw)) return true;
  if (['false', '0', 'off', 'no'].includes(raw)) return false;
  return fallback;
};

const intOf = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = textOf(value);
  const num = raw ? Number(raw) : NaN;
  return Number.isInteger(num) && num >= min && num <= max ? num : fallback;
};

const minutesOf = (hhmm: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

/** `HH:MM-HH:MM` (notification-service `parseQuietHours` bilan bir xil). */
export function parseQuietWindow(value: unknown): {
  start: number;
  end: number;
} {
  const [rawStart, rawEnd] = (
    textOf(value) || CANCEL_RETURN_REMINDER_DEFAULTS.quietHours
  ).split('-');
  const start = minutesOf(rawStart ?? '');
  const end = minutesOf(rawEnd ?? '');
  if (start === null || end === null) {
    return parseQuietWindow(CANCEL_RETURN_REMINDER_DEFAULTS.quietHours);
  }
  return { start, end };
}

/**
 * Env'dan (har tikda o'qiladi). Noto'g'ri qiymat — sukut (servis yiqilmaydi).
 */
export function readCancelReturnReminderConfig(
  get: (key: string) => unknown,
): CancelReturnReminderConfig {
  return {
    enabled: flagOf(
      get('CANCEL_RETURN_REMINDER_ENABLED'),
      CANCEL_RETURN_REMINDER_DEFAULTS.enabled,
    ),
    remindAfterDays: intOf(
      get('CANCEL_RETURN_REMIND_AFTER_DAYS'),
      CANCEL_RETURN_REMINDER_DEFAULTS.remindAfterDays,
      1,
      60,
    ),
    escalateAfterDays: intOf(
      get('CANCEL_RETURN_ESCALATE_AFTER_DAYS'),
      CANCEL_RETURN_REMINDER_DEFAULTS.escalateAfterDays,
      1,
      90,
    ),
    runHour: intOf(
      get('CANCEL_RETURN_REMINDER_HOUR'),
      CANCEL_RETURN_REMINDER_DEFAULTS.runHour,
      0,
      23,
    ),
    quiet: parseQuietWindow(get('NOTIF_PROMO_QUIET_HOURS')),
  };
}

const tashkentMinuteOfDay = (now: Date): number => {
  const shifted = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

const isQuietMinute = (
  minute: number,
  quiet: { start: number; end: number },
): boolean => {
  if (quiet.start === quiet.end) return false;
  return quiet.start > quiet.end
    ? minute >= quiet.start || minute < quiet.end
    : minute >= quiet.start && minute < quiet.end;
};

export function inQuietWindow(
  now: Date,
  quiet: { start: number; end: number },
): boolean {
  return isQuietMinute(tashkentMinuteOfDay(now), quiet);
}

export interface CancelReturnReminderSlot {
  /** Toshkent kuni `YYYY-MM-DD`. */
  day: string;
  /** Shu kunning yugurish lahzasi (`runHour:00` Toshkent; taqiqqa tushsa — taqiq oxiri). */
  runAt: Date;
  /** `received_at <= remindCutoff` — eslatma vaqti kelgan. */
  remindCutoff: Date;
  /** `received_at <= escalateCutoff` — eskalatsiya vaqti kelgan. */
  escalateCutoff: Date;
}

/**
 * Kunlik yugurish oynasi: Toshkent vaqti `runHour:00` dan keyin VA tungi
 * taqiqdan tashqarida. Chegaralar KUN BO'YI bir xil (`runAt` dan sanaladi):
 * kun ichidagi keyingi tiklar (yoki boshqa replika) shu kunning o'zida
 * chegarani yangi kesib o'tgan posilka uchun ikkinchi xabar yubormaydi —
 * u ertangi yugurishga qoladi (market guruhi kuniga ko'pi bilan bir marta).
 */
export function cancelReturnReminderSlot(
  now: Date,
  config: CancelReturnReminderConfig,
): CancelReturnReminderSlot | null {
  if (inQuietWindow(now, config.quiet)) return null;
  // Soat tungi taqiqqa tushsa (masalan 20) — taqiq tugashida (09:00).
  const runMinute = isQuietMinute(config.runHour * 60, config.quiet)
    ? config.quiet.end
    : config.runHour * 60;
  if (tashkentMinuteOfDay(now) < runMinute) return null;
  const dayStart = startOfTashkentDay(now).getTime();
  const runAt = dayStart + runMinute * MINUTE_MS;
  return {
    day: new Date(dayStart + TASHKENT_OFFSET_MS).toISOString().slice(0, 10),
    runAt: new Date(runAt),
    remindCutoff: new Date(runAt - config.remindAfterDays * DAY_MS),
    escalateCutoff: new Date(runAt - config.escalateAfterDays * DAY_MS),
  };
}

/** `"schema"."table"` — TypeORM `metadata.tablePath` dan. */
export const quoteTablePath = (tablePath: string): string =>
  tablePath
    .split('.')
    .map((part) => `"${part.replace(/"/g, '')}"`)
    .join('.');

/**
 * Kutayotgan bekor (BG1 `hq` | `branch` bosqichi, ombor buyurtmasi emas,
 * o'chirilmagan) — SQL sharti. `alias` — so'rov aliasi.
 */
export function cancelReturnAwaitingSql(alias = 'o'): string {
  return (
    `(${cancelReturnStageSql('hq', alias)} OR ${cancelReturnStageSql('branch', alias)})` +
    ` AND ${alias}.fulfillment_source IS DISTINCT FROM 'WAREHOUSE'` +
    ` AND ${alias}.is_deleted = false AND ${alias}.deleted_at IS NULL`
  );
}

/**
 * BG1 `received_at` (joyda qachondan beri) — SQL ifodasi: oxirgi
 * `cancelled_post_received` hodisasi va custody vaqtining (`last_handover_at`)
 * kattasi; `GREATEST` NULL'ni e'tiborsiz qoldiradi — ikkalasi ham bo'lmasa
 * NULL (bunday buyurtmaga eslatma ketmaydi: vaqtni taxmin qilmaymiz).
 */
export function cancelReturnReceivedAtSql(
  trackingTable: string,
  alias = 'o',
): string {
  return (
    `GREATEST(${alias}.last_handover_at, (SELECT MAX(t.created_at) FROM ${trackingTable} t` +
    ` WHERE t.order_id = ${alias}.id AND t.action = 'cancelled_post_received'))`
  );
}

/** Eslatma/eskalatsiya uchun belgilangan buyurtma (DB qatoridan). */
export interface CancelReturnDueOrder {
  id: string;
  market_id: string;
  /** `hq` | `branch` — BG1 bosqichi. */
  stage: 'hq' | 'branch';
  place_id: string | null;
  place_name: string | null;
  received_at: Date;
}

export interface CancelReturnNotificationPayload {
  type:
    | typeof CANCEL_RETURN_REMINDER_TYPE
    | typeof CANCEL_RETURN_ESCALATED_TYPE;
  category: string;
  priority: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  link: string;
  recipient_ids?: string[];
  roles?: string[];
  group_key?: string;
  channels: string[];
  telegram?: { market_id: string; group_type: Group_type; text: string };
  client_request_id: string;
}

/** Joyda necha to'liq kun (kamida 0). */
export const daysSince = (from: Date, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));

const placeLabel = (order: CancelReturnDueOrder): string =>
  order.place_name ?? (order.stage === 'hq' ? 'HQ' : 'Filial');

/** «HQ'da» / «filialda (Nom)» — eskalatsiya jumlasi uchun. */
const placePhrase = (order: CancelReturnDueOrder): string =>
  order.stage === 'hq'
    ? 'markazda'
    : order.place_name
      ? `filialda (${order.place_name})`
      : 'filialda';

/** Buyurtma raqami: «EL-…», bo'lmasa ichki id. */
const numberOf = (id: string): string => orderNumberOf(id) || id;

/** Market guruhi uchun eslatma matni (HTML, `parse_mode: HTML`). */
export function buildCancelReturnReminderTelegramText(
  orders: CancelReturnDueOrder[],
  now: Date,
): string {
  const oldest = Math.max(...orders.map((o) => daysSince(o.received_at, now)));
  const places = new Map<string, number>();
  for (const order of orders) {
    const label = placeLabel(order);
    places.set(label, (places.get(label) ?? 0) + 1);
  }
  const placeLines = [...places]
    .slice(0, TELEGRAM_MAX_PLACES)
    .map(([label, count]) => `• ${escapeTelegramHtml(label)} — ${count} ta`);
  if (places.size > TELEGRAM_MAX_PLACES) {
    placeLines.push(`• … yana ${places.size - TELEGRAM_MAX_PLACES} joy`);
  }
  const numbers = orders
    .slice(0, TELEGRAM_MAX_NUMBERS)
    .map((o) => numberOf(o.id));
  const more =
    orders.length > TELEGRAM_MAX_NUMBERS
      ? ` (+${orders.length - TELEGRAM_MAX_NUMBERS})`
      : '';
  return [
    '<b>⏳ Qaytarishlaringiz markazda kutmoqda</b>',
    '',
    `${orders.length} ta bekor qilingan buyurtma olib ketilishini kutmoqda (eng keksasi ${oldest} kun):`,
    ...placeLines,
    '',
    `Buyurtmalar: ${escapeTelegramHtml(numbers.join(', '))}${more}`,
    '',
    "Kabinetdagi <b>«Bekor qilingan buyurtmalar»</b> bo'limidan topshirishga ruxsat berib (QR yoki 6 xonali kod), posilkalarni olib keting.",
  ].join('\n');
}

/**
 * Market bo'yicha BITTA eslatma payload'i (`notification.dispatch`). Nishon —
 * market useri (in-app) + marketning «bekor» Telegram guruhi. PII yo'q (faqat
 * buyurtma raqamlari va joy nomlari). `client_request_id` — buyurtmalar
 * to'plamidan barqaror: outbox qayta yetkazsa notification-service dedup'i
 * ikkinchisini yubormaydi.
 */
export function buildCancelReturnReminderPayload(
  marketId: string,
  orders: CancelReturnDueOrder[],
  now: Date,
): CancelReturnNotificationPayload | null {
  const entry = findNotificationType(CANCEL_RETURN_REMINDER_TYPE);
  if (!entry || !/^\d+$/.test(marketId) || !orders.length) return null;
  const ids = [...new Set(orders.map((o) => o.id))].sort(
    (a, b) => Number(a) - Number(b),
  );
  const oldest = Math.max(...orders.map((o) => daysSince(o.received_at, now)));
  const data: Record<string, unknown> = {
    market_id: marketId,
    count: ids.length,
    oldest_days: oldest,
    order_ids: ids,
    order_numbers: ids.map(numberOf),
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);
  return {
    type: CANCEL_RETURN_REMINDER_TYPE,
    category: entry.category,
    priority: entry.priority,
    title: '⏳ Bekor buyurtmalarni olib keting',
    body: `${ids.length} ta bekor qilingan buyurtma olib ketilishini kutmoqda (eng keksasi ${oldest} kun).`,
    data,
    link: `/new-orders/cancelled/${marketId}`,
    recipient_ids: [marketId],
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: [...entry.default_channels],
    telegram: {
      market_id: marketId,
      group_type: Group_type.CANCEL,
      text: buildCancelReturnReminderTelegramText(orders, now),
    },
    client_request_id: deterministicUuid(
      `cancel-return-reminder:${marketId}:${ids.join(',')}`,
    ),
  };
}

/**
 * Buyurtma bo'yicha eskalatsiya payload'i — admin/superadmin inbox'i (in-app +
 * realtime). Matn kartadagidek: «Buyurtma #N markazda 7 kundan beri turibdi —
 * market olib ketmadi» (filialda bo'lsa — «filialda (Nom)»).
 */
export function buildCancelReturnEscalationPayload(
  order: CancelReturnDueOrder,
  now: Date,
): CancelReturnNotificationPayload | null {
  const entry = findNotificationType(CANCEL_RETURN_ESCALATED_TYPE);
  if (!entry || !/^\d+$/.test(order.id)) return null;
  const days = daysSince(order.received_at, now);
  const number = numberOf(order.id);
  const data: Record<string, unknown> = {
    order_id: order.id,
    order_number: number,
    market_id: order.market_id,
    stage: order.stage,
    place_id: order.place_id,
    place_name: order.place_name,
    received_at: order.received_at.toISOString(),
    days,
  };
  const groupKey = renderNotificationGroupKey(entry.group_key_pattern, data);
  return {
    type: CANCEL_RETURN_ESCALATED_TYPE,
    category: entry.category,
    priority: entry.priority,
    title: 'Bekor buyurtma olib ketilmadi',
    body: `Buyurtma #${number} ${placePhrase(order)} ${days} kundan beri turibdi — market olib ketmadi`,
    data,
    link: orderDetailLink(order.id),
    roles: ['admin', 'superadmin'],
    ...(groupKey ? { group_key: groupKey } : {}),
    channels: entry.default_channels.filter(
      (channel) => channel !== NotificationChannel.TELEGRAM,
    ),
    client_request_id: deterministicUuid(`cancel-return-escalated:${order.id}`),
  };
}
