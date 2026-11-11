/**
 * y8Tqm9Ap + gWI4gYkw — smena jadvali va hisobot yuborish QOIDALARI (sof
 * funksiyalar, DB'siz test qilinadi). Vaqt zonasi — Asia/Tashkent (UTC+5,
 * yozgi vaqt yo'q).
 */

/** `finance_settings.key` lari. */
export const SHIFT_AUTOMATION_KEYS = {
  autoCloseEnabled: 'shift.auto_close.enabled',
  autoCloseTimes: 'shift.auto_close.times',
  autoCloseScope: 'shift.auto_close.scope',
  autoCloseWarnBeforeMin: 'shift.auto_close.warn_before_min',
  reportRecipients: 'shift.report.recipients',
  reportFormat: 'shift.report.format',
  // «Kun tartibi» (2026-11-11): avtomatik ochish va kechikish xabari.
  autoOpenEnabled: 'shift.auto_open.enabled',
  autoOpenTimes: 'shift.auto_open.times',
  autoOpenScope: 'shift.auto_open.scope',
  lateAlertEnabled: 'shift.late_alert.enabled',
  lateAlertGraceMin: 'shift.late_alert.grace_min',
  lateAlertChannels: 'shift.late_alert.channels',
} as const;

export type AutoCloseScope = 'main' | 'main+branches';
export const AUTO_CLOSE_SCOPES: readonly AutoCloseScope[] = [
  'main',
  'main+branches',
];

export interface AutoCloseSettings {
  enabled: boolean;
  /** `HH:MM` (Toshkent vaqti), o'sish tartibida, takrorsiz. */
  times: string[];
  scope: AutoCloseScope;
  /** 0 — ogohlantirish yo'q. */
  warn_before_min: number;
}

export type ReportRecipientGroup = 'superadmin' | 'couriers' | 'markets';
export const REPORT_RECIPIENT_GROUPS: readonly ReportRecipientGroup[] = [
  'superadmin',
  'couriers',
  'markets',
];

export interface ReportChannels {
  telegram: boolean;
  in_app: boolean;
}

export type ReportFormat = 'pdf' | 'xlsx';
export const REPORT_FORMATS: readonly ReportFormat[] = ['pdf', 'xlsx'];

export interface ReportSettings {
  recipients: Record<ReportRecipientGroup, ReportChannels>;
  format: ReportFormat;
}

/**
 * Sukut: avtomatik yopish O'CHIQ (superadmin yoqadi), vaqt 23:00, faqat MAIN
 * kassa, ogohlantirish 15 daqiqa oldin. Hisobot yuborish ham O'CHIQ —
 * barcha qabul qiluvchi × kanal `false` (reliz-9 qarori): funksiya test
 * qilinmaguncha haqiqiy kuryer / market / superadminga hech narsa ketmaydi
 * (`deliver` → `report_status = 'skipped'`, outbox / fayl yo'q). Superadmin
 * `PATCH /finance/shift/settings` `report.recipients` bilan yoqadi. Format PDF.
 */
export const AUTO_CLOSE_DEFAULTS: AutoCloseSettings = Object.freeze({
  enabled: false,
  times: ['23:00'],
  scope: 'main',
  warn_before_min: 15,
}) as AutoCloseSettings;

export const REPORT_DEFAULTS: ReportSettings = Object.freeze({
  recipients: {
    superadmin: { telegram: false, in_app: false },
    couriers: { telegram: false, in_app: false },
    markets: { telegram: false, in_app: false },
  },
  format: 'pdf',
}) as ReportSettings;

/**
 * «Kun tartibi» (2026-11-11) — belgilangan vaqtda qamrovdagi kassada OCHIQ
 * smena bo'lmasa, tizim uni o'zi ochadi (`opened_by = NULL`,
 * `opened_by_system = true`). `times` / `scope` — `auto_close` qoidalari.
 * Sukut: O'CHIQ, 09:00, faqat MAIN.
 */
export interface AutoOpenSettings {
  enabled: boolean;
  times: string[];
  scope: AutoCloseScope;
}

export const AUTO_OPEN_DEFAULTS: AutoOpenSettings = Object.freeze({
  enabled: false,
  times: ['09:00'],
  scope: 'main',
});

/**
 * «Kun tartibi» (2026-11-11) — KECHIKISH XABARI superadminlarga: ochish
 * vaqtidan (`auto_open.times`) `grace_min` daqiqa o'tib kassada ochiq smena
 * yo'q, yoki yopish vaqtidan (`auto_close.times`) keyin smena hali ochiq.
 * Vaqtlar — jadvalnikidan, avtomatika yoqiq-o'chiqligidan qat'i nazar
 * (o'chiq bo'lsa ham bu kassirning jadvali). Tizimning avtomatik
 * ochishi / yopishi xato bilan tugasa — darhol, sababi bilan. Har slot
 * uchun BIR marta. Sukut: O'CHIQ, 15 daqiqa, faqat ilova ichida.
 */
export interface LateAlertSettings {
  enabled: boolean;
  grace_min: number;
  channels: ReportChannels;
}

export const MAX_LATE_ALERT_GRACE_MIN = 180;

export const LATE_ALERT_DEFAULTS: LateAlertSettings = Object.freeze({
  enabled: false,
  grace_min: 15,
  channels: { telegram: false, in_app: true },
});

/**
 * Ochish va yopish ro'yxatida bir xil vaqt — 400 `SHIFT_SCHEDULE_CONFLICT`
 * (`@app/common` `PUBLIC_ERROR_CODES`, FE `conflictingTimes`).
 */
export class ShiftScheduleConflictError extends Error {
  constructor(readonly times: string[]) {
    super(
      `${times.join(', ')} — ham ochish, ham yopish vaqti. Bittasini o'zgartiring`,
    );
  }
}

export const MAX_AUTO_CLOSE_TIMES = 12;
export const MAX_WARN_BEFORE_MIN = 180;
/**
 * Slot vaqtidan keyin shu oraliqda (daqiqa) ham yopiladi: replika qayta ishga
 * tushgan / tick kechikkan bo'lsa slot o'tkazib yuborilmasin. Undan keyin —
 * eski slot qayta "quvlanmaydi" (keyingi slotgacha kutiladi).
 */
export const AUTO_CLOSE_CATCHUP_MIN = 10;

const TASHKENT_OFFSET_MS = 5 * 3_600_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ShiftSettingsError extends Error {}

export function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value.trim());
}

/** `["23:00", "14:00", "14:00"]` → `["14:00", "23:00"]`; yaroqsiz — xato. */
export function normalizeTimes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ShiftSettingsError("times massiv bo'lishi kerak");
  }
  const result = new Set<string>();
  value.forEach((item, index) => {
    if (!isValidTime(item)) {
      throw new ShiftSettingsError(
        `times[${index}] HH:MM (00:00–23:59) bo'lishi kerak`,
      );
    }
    result.add(String(item).trim());
  });
  if (result.size > MAX_AUTO_CLOSE_TIMES) {
    throw new ShiftSettingsError(
      `kuniga ko'pi bilan ${MAX_AUTO_CLOSE_TIMES} marta`,
    );
  }
  return [...result].sort();
}

/** DB qiymatlaridan (`key → value`) — yaroqsiz qiymat sukutga tushadi. */
export function readAutoCloseSettings(
  map: Map<string, unknown>,
): AutoCloseSettings {
  const enabled = map.get(SHIFT_AUTOMATION_KEYS.autoCloseEnabled);
  const scope = map.get(SHIFT_AUTOMATION_KEYS.autoCloseScope);
  const warn = Number(map.get(SHIFT_AUTOMATION_KEYS.autoCloseWarnBeforeMin));
  let times = AUTO_CLOSE_DEFAULTS.times;
  try {
    const raw = map.get(SHIFT_AUTOMATION_KEYS.autoCloseTimes);
    if (raw !== undefined) times = normalizeTimes(raw);
  } catch {
    times = AUTO_CLOSE_DEFAULTS.times;
  }
  return {
    enabled:
      typeof enabled === 'boolean' ? enabled : AUTO_CLOSE_DEFAULTS.enabled,
    times: [...times],
    scope: AUTO_CLOSE_SCOPES.includes(scope as AutoCloseScope)
      ? (scope as AutoCloseScope)
      : AUTO_CLOSE_DEFAULTS.scope,
    warn_before_min:
      map.has(SHIFT_AUTOMATION_KEYS.autoCloseWarnBeforeMin) &&
      Number.isInteger(warn) &&
      warn >= 0 &&
      warn <= MAX_WARN_BEFORE_MIN
        ? warn
        : AUTO_CLOSE_DEFAULTS.warn_before_min,
  };
}

function readScope(value: unknown, fallback: AutoCloseScope): AutoCloseScope {
  return AUTO_CLOSE_SCOPES.includes(value as AutoCloseScope)
    ? (value as AutoCloseScope)
    : fallback;
}

function readChannels(
  value: unknown,
  fallback: ReportChannels,
): ReportChannels {
  const item =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    telegram:
      typeof item.telegram === 'boolean' ? item.telegram : fallback.telegram,
    in_app: typeof item.in_app === 'boolean' ? item.in_app : fallback.in_app,
  };
}

/** «Kun tartibi» — avtomatik ochish (yaroqsiz qiymat sukutga tushadi). */
export function readAutoOpenSettings(
  map: Map<string, unknown>,
): AutoOpenSettings {
  const enabled = map.get(SHIFT_AUTOMATION_KEYS.autoOpenEnabled);
  let times = AUTO_OPEN_DEFAULTS.times;
  try {
    const raw = map.get(SHIFT_AUTOMATION_KEYS.autoOpenTimes);
    if (raw !== undefined) times = normalizeTimes(raw);
  } catch {
    times = AUTO_OPEN_DEFAULTS.times;
  }
  return {
    enabled:
      typeof enabled === 'boolean' ? enabled : AUTO_OPEN_DEFAULTS.enabled,
    times: [...times],
    scope: readScope(
      map.get(SHIFT_AUTOMATION_KEYS.autoOpenScope),
      AUTO_OPEN_DEFAULTS.scope,
    ),
  };
}

/** «Kun tartibi» — kechikish xabari (yaroqsiz qiymat sukutga tushadi). */
export function readLateAlertSettings(
  map: Map<string, unknown>,
): LateAlertSettings {
  const enabled = map.get(SHIFT_AUTOMATION_KEYS.lateAlertEnabled);
  const grace = Number(map.get(SHIFT_AUTOMATION_KEYS.lateAlertGraceMin));
  return {
    enabled:
      typeof enabled === 'boolean' ? enabled : LATE_ALERT_DEFAULTS.enabled,
    grace_min:
      map.has(SHIFT_AUTOMATION_KEYS.lateAlertGraceMin) &&
      Number.isInteger(grace) &&
      grace >= 0 &&
      grace <= MAX_LATE_ALERT_GRACE_MIN
        ? grace
        : LATE_ALERT_DEFAULTS.grace_min,
    channels: readChannels(
      map.get(SHIFT_AUTOMATION_KEYS.lateAlertChannels),
      LATE_ALERT_DEFAULTS.channels,
    ),
  };
}

export function readReportSettings(map: Map<string, unknown>): ReportSettings {
  const raw = map.get(SHIFT_AUTOMATION_KEYS.reportRecipients);
  const source =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const recipients = {} as Record<ReportRecipientGroup, ReportChannels>;
  for (const group of REPORT_RECIPIENT_GROUPS) {
    const item =
      source[group] && typeof source[group] === 'object'
        ? (source[group] as Record<string, unknown>)
        : {};
    const fallback = REPORT_DEFAULTS.recipients[group];
    recipients[group] = {
      telegram:
        typeof item.telegram === 'boolean' ? item.telegram : fallback.telegram,
      in_app: typeof item.in_app === 'boolean' ? item.in_app : fallback.in_app,
    };
  }
  const format = map.get(SHIFT_AUTOMATION_KEYS.reportFormat);
  return {
    recipients,
    format: REPORT_FORMATS.includes(format as ReportFormat)
      ? (format as ReportFormat)
      : REPORT_DEFAULTS.format,
  };
}

/** Superadmin PATCH qismini tekshiradi; faqat berilgan maydonlar qaytadi. */
export function parseAutoClosePatch(input: unknown): Array<[string, unknown]> {
  if (input === undefined || input === null) return [];
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ShiftSettingsError("auto_close obyekt bo'lishi kerak");
  }
  const raw = input as Record<string, unknown>;
  const out: Array<[string, unknown]> = [];
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      throw new ShiftSettingsError("auto_close.enabled boolean bo'lishi kerak");
    }
    out.push([SHIFT_AUTOMATION_KEYS.autoCloseEnabled, raw.enabled]);
  }
  if (raw.times !== undefined) {
    out.push([SHIFT_AUTOMATION_KEYS.autoCloseTimes, normalizeTimes(raw.times)]);
  }
  if (raw.scope !== undefined) {
    if (!AUTO_CLOSE_SCOPES.includes(raw.scope as AutoCloseScope)) {
      throw new ShiftSettingsError(
        "auto_close.scope 'main' yoki 'main+branches' bo'lishi kerak",
      );
    }
    out.push([SHIFT_AUTOMATION_KEYS.autoCloseScope, raw.scope]);
  }
  if (raw.warn_before_min !== undefined) {
    const warn = Number(raw.warn_before_min);
    if (
      typeof raw.warn_before_min !== 'number' ||
      !Number.isInteger(warn) ||
      warn < 0 ||
      warn > MAX_WARN_BEFORE_MIN
    ) {
      throw new ShiftSettingsError(
        `auto_close.warn_before_min 0–${MAX_WARN_BEFORE_MIN} butun son bo'lishi kerak`,
      );
    }
    out.push([SHIFT_AUTOMATION_KEYS.autoCloseWarnBeforeMin, warn]);
  }
  return out;
}

/** «Kun tartibi» — `auto_open` PATCH qismi; faqat berilgan maydonlar. */
export function parseAutoOpenPatch(input: unknown): Array<[string, unknown]> {
  if (input === undefined || input === null) return [];
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ShiftSettingsError("auto_open obyekt bo'lishi kerak");
  }
  const raw = input as Record<string, unknown>;
  const out: Array<[string, unknown]> = [];
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      throw new ShiftSettingsError("auto_open.enabled boolean bo'lishi kerak");
    }
    out.push([SHIFT_AUTOMATION_KEYS.autoOpenEnabled, raw.enabled]);
  }
  if (raw.times !== undefined) {
    out.push([SHIFT_AUTOMATION_KEYS.autoOpenTimes, normalizeTimes(raw.times)]);
  }
  if (raw.scope !== undefined) {
    if (!AUTO_CLOSE_SCOPES.includes(raw.scope as AutoCloseScope)) {
      throw new ShiftSettingsError(
        "auto_open.scope 'main' yoki 'main+branches' bo'lishi kerak",
      );
    }
    out.push([SHIFT_AUTOMATION_KEYS.autoOpenScope, raw.scope]);
  }
  return out;
}

/** «Kun tartibi» — `late_alert` PATCH qismi; `channels` qisman birlashtiriladi. */
export function parseLateAlertPatch(
  input: unknown,
  current: LateAlertSettings,
): Array<[string, unknown]> {
  if (input === undefined || input === null) return [];
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ShiftSettingsError("late_alert obyekt bo'lishi kerak");
  }
  const raw = input as Record<string, unknown>;
  const out: Array<[string, unknown]> = [];
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      throw new ShiftSettingsError("late_alert.enabled boolean bo'lishi kerak");
    }
    out.push([SHIFT_AUTOMATION_KEYS.lateAlertEnabled, raw.enabled]);
  }
  if (raw.grace_min !== undefined) {
    const grace = Number(raw.grace_min);
    if (
      typeof raw.grace_min !== 'number' ||
      !Number.isInteger(grace) ||
      grace < 0 ||
      grace > MAX_LATE_ALERT_GRACE_MIN
    ) {
      throw new ShiftSettingsError(
        `late_alert.grace_min 0–${MAX_LATE_ALERT_GRACE_MIN} butun son bo'lishi kerak`,
      );
    }
    out.push([SHIFT_AUTOMATION_KEYS.lateAlertGraceMin, grace]);
  }
  if (raw.channels !== undefined) {
    if (
      !raw.channels ||
      typeof raw.channels !== 'object' ||
      Array.isArray(raw.channels)
    ) {
      throw new ShiftSettingsError("late_alert.channels obyekt bo'lishi kerak");
    }
    const channels = raw.channels as Record<string, unknown>;
    for (const key of Object.keys(channels)) {
      if (key !== 'telegram' && key !== 'in_app') {
        throw new ShiftSettingsError(
          `late_alert.channels.${key.slice(0, 40)} noma'lum (telegram | in_app)`,
        );
      }
      if (typeof channels[key] !== 'boolean') {
        throw new ShiftSettingsError(
          `late_alert.channels.${key} boolean bo'lishi kerak`,
        );
      }
    }
    out.push([
      SHIFT_AUTOMATION_KEYS.lateAlertChannels,
      readChannels(channels, current.channels),
    ]);
  }
  return out;
}

/**
 * PATCH dan KEYINGI holat bo'yicha jadval tekshiruvi:
 *  - ochish va yopish ro'yxatida bir xil vaqt — `ShiftScheduleConflictError`;
 *  - avtomatik ochish yoqiq, lekin vaqt yo'q — xato;
 *  - kechikish xabari yoqiq, lekin kanal yo'q — xato.
 */
export function assertShiftScheduleValid(next: {
  auto_open: AutoOpenSettings;
  auto_close: AutoCloseSettings;
  late_alert: LateAlertSettings;
}): void {
  const close = new Set(next.auto_close.times);
  const conflict = next.auto_open.times.filter((time) => close.has(time));
  if (conflict.length) throw new ShiftScheduleConflictError(conflict);
  if (next.auto_open.enabled && !next.auto_open.times.length) {
    throw new ShiftSettingsError('Kamida bitta ochish vaqtini qo`shing');
  }
  if (
    next.late_alert.enabled &&
    !next.late_alert.channels.telegram &&
    !next.late_alert.channels.in_app
  ) {
    throw new ShiftSettingsError(
      'Kechikish xabari uchun kamida bitta kanalni tanlang',
    );
  }
}

/** `key → value` PATCH yozuvlarini joriy xaritaga qo'llaydi (tekshiruv uchun). */
export function applySettingEntries(
  map: Map<string, unknown>,
  entries: Array<[string, unknown]>,
): Map<string, unknown> {
  const next = new Map(map);
  for (const [key, value] of entries) next.set(key, value);
  return next;
}

export function parseReportPatch(
  input: unknown,
  current: ReportSettings,
): Array<[string, unknown]> {
  if (input === undefined || input === null) return [];
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ShiftSettingsError("report obyekt bo'lishi kerak");
  }
  const raw = input as Record<string, unknown>;
  const out: Array<[string, unknown]> = [];
  if (raw.recipients !== undefined) {
    if (
      !raw.recipients ||
      typeof raw.recipients !== 'object' ||
      Array.isArray(raw.recipients)
    ) {
      throw new ShiftSettingsError("report.recipients obyekt bo'lishi kerak");
    }
    const patch = raw.recipients as Record<string, unknown>;
    for (const key of Object.keys(patch)) {
      if (!REPORT_RECIPIENT_GROUPS.includes(key as ReportRecipientGroup)) {
        throw new ShiftSettingsError(
          `report.recipients.${key.slice(0, 40)} noma'lum (superadmin | couriers | markets)`,
        );
      }
    }
    const next = {} as Record<ReportRecipientGroup, ReportChannels>;
    for (const group of REPORT_RECIPIENT_GROUPS) {
      const item = patch[group];
      const base = current.recipients[group];
      if (item === undefined) {
        next[group] = { ...base };
        continue;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new ShiftSettingsError(
          `report.recipients.${group} obyekt bo'lishi kerak`,
        );
      }
      const channels = item as Record<string, unknown>;
      for (const channel of ['telegram', 'in_app'] as const) {
        if (
          channels[channel] !== undefined &&
          typeof channels[channel] !== 'boolean'
        ) {
          throw new ShiftSettingsError(
            `report.recipients.${group}.${channel} boolean bo'lishi kerak`,
          );
        }
      }
      next[group] = {
        telegram:
          typeof channels.telegram === 'boolean'
            ? channels.telegram
            : base.telegram,
        in_app:
          typeof channels.in_app === 'boolean' ? channels.in_app : base.in_app,
      };
    }
    out.push([SHIFT_AUTOMATION_KEYS.reportRecipients, next]);
  }
  if (raw.format !== undefined) {
    if (!REPORT_FORMATS.includes(raw.format as ReportFormat)) {
      throw new ShiftSettingsError(
        "report.format 'pdf' yoki 'xlsx' bo'lishi kerak",
      );
    }
    out.push([SHIFT_AUTOMATION_KEYS.reportFormat, raw.format]);
  }
  return out;
}

// ───────────────────────── vaqt / slot ─────────────────────────

/** UTC lahzasining Toshkent kuni: `YYYY-MM-DD`. */
export function tashkentDay(at: Date): string {
  return new Date(at.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Toshkent vaqti `HH:MM`. */
export function tashkentClock(at: Date | string | null | undefined): string {
  const date = at ? new Date(at) : new Date();
  const safe = Number.isFinite(date.getTime()) ? date : new Date();
  return new Date(safe.getTime() + TASHKENT_OFFSET_MS)
    .toISOString()
    .slice(11, 16);
}

/** `DD.MM.YYYY HH:MM` (Toshkent). */
export function tashkentDateTime(at: Date | string | null | undefined): string {
  const date = at ? new Date(at) : new Date();
  const safe = Number.isFinite(date.getTime()) ? date : new Date();
  const iso = new Date(safe.getTime() + TASHKENT_OFFSET_MS).toISOString();
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
}

/** Toshkent kuni + `HH:MM` → UTC lahza. */
export function slotInstant(day: string, time: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - TASHKENT_OFFSET_MS);
}

export interface ScheduleSlot {
  /** `YYYY-MM-DDTHH:MM` (Toshkent) — idempotent kalit qismi. */
  key: string;
  time: string;
  at: Date;
}

function candidateSlots(now: Date, times: string[]): ScheduleSlot[] {
  const today = tashkentDay(now);
  const yesterday = tashkentDay(new Date(now.getTime() - 86_400_000));
  const tomorrow = tashkentDay(new Date(now.getTime() + 86_400_000));
  const slots: ScheduleSlot[] = [];
  for (const day of [yesterday, today, tomorrow]) {
    for (const time of times) {
      slots.push({ key: `${day}T${time}`, time, at: slotInstant(day, time) });
    }
  }
  return slots;
}

/**
 * Hozir yopilishi kerak bo'lgan slotlar: `slot ≤ now < slot + catch-up`.
 * Yarim tun atrofi (23:55 slot, tick 00:02) ham qamraladi.
 */
export function dueCloseSlots(
  now: Date,
  times: string[],
  catchupMin = AUTO_CLOSE_CATCHUP_MIN,
): ScheduleSlot[] {
  const t = now.getTime();
  return candidateSlots(now, times).filter(
    (slot) =>
      slot.at.getTime() <= t && t < slot.at.getTime() + catchupMin * 60_000,
  );
}

/** Ogohlantirish oynasidagi slotlar: `slot − warn ≤ now < slot`. */
export function dueWarnSlots(
  now: Date,
  times: string[],
  warnBeforeMin: number,
): ScheduleSlot[] {
  if (!warnBeforeMin || warnBeforeMin <= 0) return [];
  const t = now.getTime();
  return candidateSlots(now, times).filter(
    (slot) =>
      slot.at.getTime() - warnBeforeMin * 60_000 <= t && t < slot.at.getTime(),
  );
}

/**
 * Kechikish tekshiruvi oynasi: `slot + grace ≤ now < slot + grace + catch-up`
 * (tick kechiksa ham slot o'tkazib yuborilmasin, eskisi quvlanmasin).
 */
export function dueLateSlots(
  now: Date,
  times: string[],
  graceMin: number,
  catchupMin = AUTO_CLOSE_CATCHUP_MIN,
): ScheduleSlot[] {
  const t = now.getTime();
  const grace = Math.max(0, graceMin) * 60_000;
  return candidateSlots(now, times).filter(
    (slot) =>
      slot.at.getTime() + grace <= t &&
      t < slot.at.getTime() + grace + catchupMin * 60_000,
  );
}

export const autoCloseClaimKey = (shiftId: string, slotKey: string) =>
  `auto_close:${shiftId}:${slotKey}`;
export const warnClaimKey = (shiftId: string, slotKey: string) =>
  `warn:${shiftId}:${slotKey}`;
/** «Kun tartibi»: kassa × slot uchun bitta avtomatik ochish. */
export const autoOpenClaimKey = (cashboxUserId: string, slotKey: string) =>
  `auto_open:${cashboxUserId}:${slotKey}`;
/** Kassa × ochish sloti uchun bitta kechikish xabari (xato yoki muddat). */
export const lateOpenClaimKey = (cashboxUserId: string, slotKey: string) =>
  `late_open:${cashboxUserId}:${slotKey}`;
/** Smena × yopish sloti uchun bitta kechikish xabari (xato yoki muddat). */
export const lateCloseClaimKey = (shiftId: string, slotKey: string) =>
  `late_close:${shiftId}:${slotKey}`;

/** Avtomatik ochilgan smena belgisi (tarix / hisobot). */
export function autoOpenedLabel(openedAt: Date | string | null | undefined) {
  return `Avtomatik ochildi — ${tashkentClock(openedAt)}`;
}

/** Hisobotdagi sariq banner matni (y8Tqm9Ap #3). */
export function autoClosedLabel(closedAt: Date | string | null | undefined) {
  return `Avtomatik yopildi — ${tashkentClock(closedAt)}, kassir yopmagan`;
}
