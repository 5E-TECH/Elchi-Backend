import { TASHKENT_OFFSET_MINUTES, startOfTashkentDay } from '@app/common';

/**
 * TINCH SOATLAR (mP1WGG1W #3/#6) — foydalanuvchi profilida
 * `user.settings.notifications.quiet_hours = { from: '22:00', to: '08:00' }`.
 *
 * ⚠️ Hisob FAQAT Toshkent vaqtida (UTC+5, yozgi vaqt yo'q — umumiy
 * `@app/common` tashkent-time qoidasi, SQL'dagi `AT TIME ZONE
 * 'Asia/Tashkent'` bilan teng). UTC'da hisoblansa oyna 5 soatga siljib,
 * aynan tunda yuborilardi. Server TZ'iga bog'liq emas.
 */
export interface QuietWindow {
  /** Daqiqa (00:00 dan), Toshkent vaqti. */
  start: number;
  end: number;
}

const MINUTE_MS = 60 * 1000;
const DAY_MINUTES = 24 * 60;
const DAY_MS = DAY_MINUTES * MINUTE_MS;

const toMinutes = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

/**
 * `{ from, to }` → oyna; noto'g'ri / bo'sh / from === to → `null` (tinch soat yo'q).
 * Frontend sozlamalari `{ enabled, from, to }` yozadi: `enabled: false` —
 * soatlar saqlangan bo'lsa ham tinch soat O'CHIQ. `enabled` yo'q — eski shakl,
 * from/to bo'yicha.
 */
export function parseQuietWindow(value: unknown): QuietWindow | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { enabled?: unknown; from?: unknown; to?: unknown };
  if (raw.enabled === false) return null;
  const start = toMinutes(raw.from);
  const end = toMinutes(raw.to);
  if (start === null || end === null || start === end) return null;
  return { start, end };
}

/**
 * Identity kontaktidan tinch soatlarni oladi. Qo'llab-quvvatlanadigan
 * shakllar: `quiet_hours`, `notifications.quiet_hours`,
 * `settings.notifications.quiet_hours`.
 */
export function quietWindowFromContact(contact: unknown): QuietWindow | null {
  if (!contact || typeof contact !== 'object') return null;
  const c = contact as {
    quiet_hours?: unknown;
    notifications?: { quiet_hours?: unknown } | null;
    settings?: { notifications?: { quiet_hours?: unknown } | null } | null;
  };
  return parseQuietWindow(
    c.quiet_hours ??
      c.notifications?.quiet_hours ??
      c.settings?.notifications?.quiet_hours,
  );
}

/** Toshkent kunidagi daqiqa (0..1439). */
export function tashkentMinuteOfDay(now: Date): number {
  const minutes =
    Math.floor(now.getTime() / MINUTE_MS) + TASHKENT_OFFSET_MINUTES;
  return ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

/**
 * `now` tinch oynaga tushsa — oyna TUGAYDIGAN lahza (UTC `Date`), aks holda
 * `null`. Oyna `[start, end)`; `start > end` — yarim tundan o'tadi
 * (22:00–08:00).
 */
export function quietWindowEnd(now: Date, window: QuietWindow): Date | null {
  const minute = tashkentMinuteOfDay(now);
  const { start, end } = window;
  const wraps = start > end;
  const inside = wraps
    ? minute >= start || minute < end
    : minute >= start && minute < end;
  if (!inside) return null;
  const dayStart = startOfTashkentDay(now).getTime();
  // Yarim tundan o'tuvchi oynaning kechki qismida tugash — ERTANGI kun.
  const endDay = wraps && minute >= start ? dayStart + DAY_MS : dayStart;
  return new Date(endDay + end * MINUTE_MS);
}
