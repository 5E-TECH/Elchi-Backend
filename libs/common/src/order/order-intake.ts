import { RpcException } from '@nestjs/microservices';
import { TASHKENT_OFFSET_MINUTES } from '../time/tashkent-time';

/**
 * BUGUNGI QABUL VAQTI + KUN ALMASHISH SOATI (ega 2026-11-09, FE kontrakti
 * Elchi-Frontend `entities/order-intake/model.ts`; Trello #756).
 *
 * Superadmin BUGUNGI ish kuni uchun qabul tugash vaqtini qo'yadi (masalan
 * `10:00`): shu lahzadan KUN ALMASHGUNCHA hech qanday yangi buyurtma
 * yaratilmaydi — qo'lda (POST /orders), bot, AI tasdiqlash, tashqi import,
 * CRM webhook va hamkor API. Kun almashganda cheklov O'ZI bekor bo'ladi
 * (u faqat o'sha ish kuni oynasiga bog'langan).
 *
 * ISH KUNI — Toshkent vaqti bo'yicha «kun almashish soati»dan (sukut `00:00`)
 * keyingi kun almashish soatigacha bo'lgan 24 soatlik oyna. Masalan kun
 * `18:00` da almashsa, 9-noyabr 18:00 → 10-noyabr 18:00 bitta ish kuni.
 *
 * ⚠️ Kun almashish soati hozircha FAQAT shu qabul oynasini belgilaydi.
 * Hisobotlar, kunlik pochtalar, smena va moliya kunlari avvalgidek
 * Toshkent 00:00 bo'yicha (`time/tashkent-time.ts`).
 *
 * Bu modul TOZA (DB / RMQ yo'q): vaqt hisobi va xato shakli shu yerda, DB
 * o'qish/yozish — order-service `intake/order-intake.service.ts`.
 */

/** Xato kodi — 409; `PUBLIC_ERROR_CODES` da `reopens_at`, `cutoff_time` bilan. */
export const ORDER_INTAKE_CLOSED = 'ORDER_INTAKE_CLOSED';

/** Kun almashish soati berilmagan / buzilgan bo'lsa — Toshkent yarim tuni. */
export const ORDER_INTAKE_DEFAULT_DAY_CHANGE_TIME = '00:00';

/** `order_schema.order_settings.key` qiymatlari. */
export const ORDER_INTAKE_SETTING_KEYS = Object.freeze({
  /** `{ time: 'HH:MM' }` — doimiy sozlama. */
  dayChangeTime: 'intake.day_change_time',
  /** `{ window_start: ISO, date: 'YYYY-MM-DD', cutoff_time: 'HH:MM' | null }`. */
  cutoff: 'intake.cutoff',
});

/** order-service RMQ naqshlari. */
export const ORDER_INTAKE_RPC = Object.freeze({
  /** `{}` → `OrderIntakeState` (har rol o'qiydi). */
  STATE: 'order.intake.state',
  /** `{ cutoff_time?, day_change_time?, requester }` — faqat SUPERADMIN. */
  UPDATE: 'order.intake.update',
});

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DAY_MINUTES = 24 * 60;
const TASHKENT_OFFSET_MS = TASHKENT_OFFSET_MINUTES * MINUTE_MS;
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** `ORDER_INTAKE_DEFAULT_DAY_CHANGE_TIME` (`00:00`) — daqiqalarda. */
const DEFAULT_DAY_CHANGE_MINUTES = 0;

/** Manfiy songa ham to'g'ri qoldiq (`-1 mod 1440 = 1439`). */
function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Qat'iy `HH:MM` (00:00–23:59) → kun boshidan daqiqalar. Boshqa har qanday
 * qiymat (`'9:00'`, `'24:00'`, `'10:00:00'`, son, null) → `null`.
 */
export function parseClockTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = CLOCK_RE.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Daqiqalar → `HH:MM`. */
export function formatClockTime(minutes: number): string {
  const normalized = mod(Math.trunc(minutes), DAY_MINUTES);
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
}

/** UTC lahza → Toshkent `DD.MM.YYYY HH:MM` (xato matnlari uchun). */
export function formatTashkentDateTime(date: Date): string {
  const local = new Date(date.getTime() + TASHKENT_OFFSET_MS);
  return (
    `${pad2(local.getUTCDate())}.${pad2(local.getUTCMonth() + 1)}.` +
    `${local.getUTCFullYear()} ${pad2(local.getUTCHours())}:` +
    `${pad2(local.getUTCMinutes())}`
  );
}

export interface OrderIntakeWindow {
  /** Ish kuni boshi — oxirgi kun almashish lahzasi (≤ now). */
  start: Date;
  /** Keyingi kun almashish lahzasi (start + 24 soat). */
  end: Date;
  /**
   * Ish kunining sanasi (`YYYY-MM-DD`) — oynaning KO'P qismi tushgan Toshkent
   * kalendar kuni (start + 12 soat). `00:00` da: o'sha kun; `18:00` da:
   * ertangi kun (kechqurun 18:00 dan keyin yangi kun boshlangan);
   * `05:00` da: o'sha kun.
   */
  date: string;
}

/** `now` tushgan ish kuni oynasi (kun almashish soati — daqiqalarda). */
export function resolveOrderIntakeWindow(
  now: Date,
  dayChangeMinutes: number,
): OrderIntakeWindow {
  const change = mod(Math.trunc(dayChangeMinutes), DAY_MINUTES);
  // "Mahalliy" ms — Toshkent devor soati UTC maydonlarida.
  const localMs = now.getTime() + TASHKENT_OFFSET_MS;
  const localMidnightMs = localMs - mod(localMs, DAY_MS);
  let startLocalMs = localMidnightMs + change * MINUTE_MS;
  // Bugungi kun almashish soati hali kelmagan — oyna kechadan boshlangan.
  // Aynan o'sha daqiqada — yangi kun (`>` emas, `>=` chegara: start = now).
  if (startLocalMs > localMs) startLocalMs -= DAY_MS;
  const start = new Date(startLocalMs - TASHKENT_OFFSET_MS);
  const label = new Date(startLocalMs + 12 * HOUR_MS);
  return {
    start,
    end: new Date(start.getTime() + DAY_MS),
    date:
      `${label.getUTCFullYear()}-${pad2(label.getUTCMonth() + 1)}-` +
      `${pad2(label.getUTCDate())}`,
  };
}

/** `intake.cutoff` sozlamasining DB'dagi shakli. */
export interface StoredOrderIntakeCutoff {
  window_start: string;
  date: string;
  cutoff_time: string | null;
}

/**
 * Saqlangan cheklov AYNAN shu ish kuni oynasiga tegishli bo'lsagina amal
 * qiladi (`window_start` mos kelishi shart). Kecha qo'yilgan cheklov, yoki
 * kun almashish soati o'zgargandan keyin eski oynaniki — hisobga olinmaydi.
 */
export function activeOrderIntakeCutoff(
  stored: unknown,
  window: OrderIntakeWindow,
): string | null {
  if (!stored || typeof stored !== 'object') return null;
  const value = stored as Partial<StoredOrderIntakeCutoff>;
  if (typeof value.window_start !== 'string') return null;
  const storedStart = Date.parse(value.window_start);
  if (!Number.isFinite(storedStart)) return null;
  if (storedStart !== window.start.getTime()) return null;
  return parseClockTime(value.cutoff_time) === null
    ? null
    : String(value.cutoff_time).trim();
}

/** `GET /orders/intake-settings` javobi (FE `normalizeOrderIntake`). */
export interface OrderIntakeState {
  /** Bugungi qabul tugash vaqti yoki `null` — cheklovsiz. */
  cutoff_time: string | null;
  /** Ish kuni sanasi (`YYYY-MM-DD`). */
  date: string;
  is_open: boolean;
  /** Qabul yopiladigan / yopilgan lahza (ISO) yoki `null`. */
  closes_at: string | null;
  /** Cheklov bo'lsa — keyingi kun almashishi (ISO), bo'lmasa `null`. */
  reopens_at: string | null;
  /** Kun almashish soati (`HH:MM`, Toshkent). */
  day_change_time: string;
  /** Joriy ish kuni boshlangan lahza (ISO). */
  day_started_at: string;
  /** Keyingi kun almashish lahzasi (ISO) — cheklovdan qat'i nazar. */
  next_day_change_at: string;
}

/**
 * Sozlamalar + hozirgi vaqt → holat. Cheklov vaqti ish kuni ICHIDAGI
 * birinchi shu soat: kun `18:00` da almashsa va cheklov `10:00` bo'lsa —
 * ertalabki 10:00 (oyna boshidan 16 soat keyin). Cheklov kun almashish
 * soatiga teng bo'lsa — oyna boshida, ya'ni butun ish kuni yopiq.
 */
export function resolveOrderIntakeState(input: {
  now: Date;
  dayChangeTime?: unknown;
  cutoff?: unknown;
}): OrderIntakeState {
  const dayChangeMinutes =
    parseClockTime(input.dayChangeTime) ?? DEFAULT_DAY_CHANGE_MINUTES;
  const window = resolveOrderIntakeWindow(input.now, dayChangeMinutes);
  const cutoffTime = activeOrderIntakeCutoff(input.cutoff, window);
  const cutoffMinutes = parseClockTime(cutoffTime);
  const closesAt =
    cutoffMinutes === null
      ? null
      : new Date(
          window.start.getTime() +
            mod(cutoffMinutes - dayChangeMinutes, DAY_MINUTES) * MINUTE_MS,
        );
  return {
    cutoff_time: cutoffMinutes === null ? null : cutoffTime,
    date: window.date,
    is_open: closesAt === null || input.now.getTime() < closesAt.getTime(),
    closes_at: closesAt ? closesAt.toISOString() : null,
    reopens_at: closesAt ? window.end.toISOString() : null,
    day_change_time: formatClockTime(dayChangeMinutes),
    day_started_at: window.start.toISOString(),
    next_day_change_at: window.end.toISOString(),
  };
}

/** Yopiq qabul xatosining tanasi (`RpcException` ga beriladi). */
export interface OrderIntakeClosedError {
  statusCode: 409;
  message: string;
  code: typeof ORDER_INTAKE_CLOSED;
  reopens_at: string | null;
  cutoff_time: string | null;
}

export function orderIntakeClosedMessage(state: {
  cutoff_time: string | null;
  reopens_at: string | null;
}): string {
  const until = state.cutoff_time ? ` (${state.cutoff_time} gacha edi)` : '';
  const reopen = state.reopens_at
    ? ` — ${formatTashkentDateTime(new Date(state.reopens_at))} dan`
    : '';
  return (
    `Bugungi buyurtma qabuli yopilgan${until}. ` +
    `Yangi buyurtmani kun almashgach${reopen} yaratish mumkin`
  );
}

export function orderIntakeClosedError(
  state: Pick<OrderIntakeState, 'cutoff_time' | 'reopens_at'>,
): OrderIntakeClosedError {
  return {
    statusCode: 409,
    message: orderIntakeClosedMessage(state),
    code: ORDER_INTAKE_CLOSED,
    reopens_at: state.reopens_at,
    cutoff_time: state.cutoff_time,
  };
}

/**
 * Hamkor API (`/partner/*`) uchun inglizcha matn — hamkor xabarlari o'zbekcha
 * EMAS (ZDweRm02 istisnosi).
 */
export function orderIntakeClosedPartnerMessage(state: {
  cutoff_time: string | null;
  reopens_at: string | null;
}): string {
  const cutoff = state.cutoff_time
    ? ` (cutoff ${state.cutoff_time} Asia/Tashkent)`
    : '';
  const reopen = state.reopens_at
    ? ` New shipments are accepted again from ${state.reopens_at}.`
    : '';
  return `Order intake is closed for today${cutoff}.${reopen}`;
}

/**
 * Xato (RMQ'dan kelgan oddiy obyekt, `RpcException`, yoki `{ error: {...} }`)
 * yopiq qabul xatosimi. Ha bo'lsa — `reopens_at` / `cutoff_time` / `message`.
 */
export function readOrderIntakeClosed(error: unknown): {
  message: string | null;
  reopens_at: string | null;
  cutoff_time: string | null;
} | null {
  if (!error || typeof error !== 'object') return null;
  const source: unknown =
    error instanceof RpcException ? error.getError() : error;
  if (!source || typeof source !== 'object') return null;
  const candidates = [
    source as Record<string, unknown>,
    (source as { error?: unknown }).error,
    (source as { response?: unknown }).response,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    if (record.code !== ORDER_INTAKE_CLOSED) continue;
    const text = (value: unknown) =>
      typeof value === 'string' && value.trim() ? value : null;
    return {
      message: text(record.message),
      reopens_at: text(record.reopens_at),
      cutoff_time: text(record.cutoff_time),
    };
  }
  return null;
}
