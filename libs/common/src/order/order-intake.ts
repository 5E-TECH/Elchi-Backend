import { RpcException } from '@nestjs/microservices';
import { TASHKENT_OFFSET_MINUTES } from '../time/tashkent-time';

/**
 * «KUN TARTIBI» — BUYURTMA YARATISH / QABUL QILISH CHEGARALARI + KUN ALMASHISH
 * SOATI (ega 2026-11-09 / 2026-11-11, FE kontrakti Elchi-Frontend
 * `entities/order-intake/model.ts`; Trello #756).
 *
 * Ikkala chegara ham DOIMIY — HAR ISH KUNI takrorlanadi, superadmin boshqa
 * vaqtga o'zgartirmaguncha yoki olib tashlamaguncha (ega 2026-11-11; avval
 * yaratish chegarasi faqat joriy ish kuni uchun edi):
 *  - `cutoff_time` (masalan `10:00`) — shu lahzadan KUN ALMASHGUNCHA hech
 *    qanday yangi buyurtma YARATILMAYDI: qo'lda (POST /orders), bot, AI
 *    tasdiqlash, tashqi import, CRM webhook va hamkor API → 409
 *    `ORDER_INTAKE_CLOSED`;
 *  - `receive_cutoff_time` (masalan `16:00`) — yaratilgan buyurtmalarni HQ
 *    QABUL QILISHI (`order.receive`, `order.receive_by_scan`) kun almashguncha
 *    to'xtaydi → 409 `ORDER_RECEIVE_CLOSED`.
 * Kun almashganda yangi ish kuni ochiq boshlanadi va chegara yana shu soatda
 * yopadi.
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

/**
 * Xato kodi — 409 (buyurtmani qabul qilish vaqti tugagan); `PUBLIC_ERROR_CODES`
 * da `reopens_at`, `receive_cutoff_time` bilan.
 */
export const ORDER_RECEIVE_CLOSED = 'ORDER_RECEIVE_CLOSED';

/** Kun almashish soati berilmagan / buzilgan bo'lsa — Toshkent yarim tuni. */
export const ORDER_INTAKE_DEFAULT_DAY_CHANGE_TIME = '00:00';

/** `order_schema.order_settings.key` qiymatlari. */
export const ORDER_INTAKE_SETTING_KEYS = Object.freeze({
  /** `{ time: 'HH:MM' }` — doimiy sozlama. */
  dayChangeTime: 'intake.day_change_time',
  /**
   * Yaratish chegarasi — `{ cutoff_time: 'HH:MM' | null }`, DOIMIY. 2026-11-09
   * dagi eski shakl (`window_start`, `date` bilan) ham o'qiladi — qo'shimcha
   * maydonlar e'tiborsiz, ya'ni u ham har kungi bo'lib qoladi.
   */
  cutoff: 'intake.cutoff',
  /** Qabul qilish chegarasi — `{ cutoff_time: 'HH:MM' | null }`, DOIMIY. */
  receiveCutoff: 'intake.receive_cutoff',
});

/** order-service RMQ naqshlari. */
export const ORDER_INTAKE_RPC = Object.freeze({
  /** `{}` → `OrderIntakeState` (har rol o'qiydi). */
  STATE: 'order.intake.state',
  /**
   * `{ cutoff_time?, receive_cutoff_time?, day_change_time?, requester }` —
   * faqat SUPERADMIN; bir nechta maydon birga.
   */
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

/** `intake.cutoff` / `intake.receive_cutoff` sozlamasining DB'dagi shakli. */
export interface StoredOrderIntakeCutoff {
  cutoff_time: string | null;
}

/**
 * Saqlangan DOIMIY chegara (`HH:MM`) yoki `null` — cheklovsiz / buzuq qiymat.
 * Eski (2026-11-09) shakldagi `window_start` / `date` e'tiborsiz: chegara har
 * ish kuniga tegishli.
 */
export function storedCutoffTime(stored: unknown): string | null {
  if (!stored || typeof stored !== 'object') return null;
  const value = (stored as Partial<StoredOrderIntakeCutoff>).cutoff_time;
  return parseClockTime(value) === null ? null : String(value).trim();
}

/**
 * Ish kuni ICHIDAGI birinchi `cutoff` soati: kun `18:00` da almashsa va
 * chegara `10:00` bo'lsa — ertalabki 10:00 (oyna boshidan 16 soat keyin).
 * Chegara kun almashish soatiga teng — oyna boshi, ya'ni butun ish kuni yopiq.
 */
export function cutoffInstant(
  window: OrderIntakeWindow,
  cutoffMinutes: number,
  dayChangeMinutes: number,
): Date {
  return new Date(
    window.start.getTime() +
      mod(cutoffMinutes - dayChangeMinutes, DAY_MINUTES) * MINUTE_MS,
  );
}

/** `GET /orders/intake-settings` javobi (FE `normalizeOrderIntake`). */
export interface OrderIntakeState {
  /** Buyurtma YARATISH chegarasi (har kuni) yoki `null` — cheklovsiz. */
  cutoff_time: string | null;
  /** Ish kuni sanasi (`YYYY-MM-DD`). */
  date: string;
  is_open: boolean;
  /** Yaratish yopiladigan / yopilgan lahza (ISO) yoki `null`. */
  closes_at: string | null;
  /** Chegara bo'lsa — keyingi kun almashishi (ISO), bo'lmasa `null`. */
  reopens_at: string | null;
  /**
   * Buyurtmalarni QABUL QILISH chegarasi (har kuni) yoki `null`. Kalit HAR
   * DOIM bor — FE shu bo'yicha yangi backendni taniydi (`receiveSupported`).
   */
  receive_cutoff_time: string | null;
  receive_is_open: boolean;
  receive_closes_at: string | null;
  receive_reopens_at: string | null;
  /** Kun almashish soati (`HH:MM`, Toshkent). */
  day_change_time: string;
  /** Joriy ish kuni boshlangan lahza (ISO). */
  day_started_at: string;
  /** Keyingi kun almashish lahzasi (ISO) — chegaralardan qat'i nazar. */
  next_day_change_at: string;
}

/** Sozlamalar + hozirgi vaqt → holat (ikkala chegara ham shu ish kuni uchun). */
export function resolveOrderIntakeState(input: {
  now: Date;
  dayChangeTime?: unknown;
  cutoff?: unknown;
  receiveCutoff?: unknown;
}): OrderIntakeState {
  const dayChangeMinutes =
    parseClockTime(input.dayChangeTime) ?? DEFAULT_DAY_CHANGE_MINUTES;
  const window = resolveOrderIntakeWindow(input.now, dayChangeMinutes);
  const gate = (stored: unknown) => {
    const time = storedCutoffTime(stored);
    const minutes = parseClockTime(time);
    const closesAt =
      minutes === null
        ? null
        : cutoffInstant(window, minutes, dayChangeMinutes);
    return {
      time: minutes === null ? null : time,
      isOpen: closesAt === null || input.now.getTime() < closesAt.getTime(),
      closesAt: closesAt ? closesAt.toISOString() : null,
      reopensAt: closesAt ? window.end.toISOString() : null,
    };
  };
  const create = gate(input.cutoff);
  const receive = gate(input.receiveCutoff);
  return {
    cutoff_time: create.time,
    date: window.date,
    is_open: create.isOpen,
    closes_at: create.closesAt,
    reopens_at: create.reopensAt,
    receive_cutoff_time: receive.time,
    receive_is_open: receive.isOpen,
    receive_closes_at: receive.closesAt,
    receive_reopens_at: receive.reopensAt,
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

/** Qabul qilish yopiq xatosining tanasi (`RpcException` ga beriladi). */
export interface OrderReceiveClosedError {
  statusCode: 409;
  message: string;
  code: typeof ORDER_RECEIVE_CLOSED;
  reopens_at: string | null;
  receive_cutoff_time: string | null;
}

export function orderReceiveClosedMessage(state: {
  receive_cutoff_time: string | null;
  receive_reopens_at: string | null;
}): string {
  const until = state.receive_cutoff_time
    ? ` (${state.receive_cutoff_time} gacha edi)`
    : '';
  const reopen = state.receive_reopens_at
    ? ` — ${formatTashkentDateTime(new Date(state.receive_reopens_at))} dan`
    : '';
  return (
    `Bugungi buyurtma qabul qilish vaqti tugagan${until}. ` +
    `Buyurtmalarni kun almashgach${reopen} qabul qilish mumkin`
  );
}

export function orderReceiveClosedError(
  state: Pick<OrderIntakeState, 'receive_cutoff_time' | 'receive_reopens_at'>,
): OrderReceiveClosedError {
  return {
    statusCode: 409,
    message: orderReceiveClosedMessage(state),
    code: ORDER_RECEIVE_CLOSED,
    reopens_at: state.receive_reopens_at,
    receive_cutoff_time: state.receive_cutoff_time,
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
