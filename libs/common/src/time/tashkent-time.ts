/**
 * Toshkent kun chegarasi — butun backend uchun YAGONA qoida (Trello SqVMuhKo).
 *
 * ⚠️ NEGA KERAK. Prod konteynerlar UTC'da ishlaydi (docker-compose.prod.yml da
 * TZ yo'q). `new Date('YYYY-MM-DD')` — UTC yarim tuni, `setHours(23, 59, 59,
 * 999)` esa server TZ'ida ishlaydi. Natijada "1-oktabr" Toshkent bo'yicha
 * 05:00 dan ertasi 04:59 gacha bo'lib qolardi: 00:00-05:00 oralig'idagi
 * buyurtma ro'yxatda oldingi kunga, dashboardda esa to'g'ri kunga tushardi.
 *
 * `TZ=Asia/Tashkent` qo'yish YETARLI EMAS (va tavsiya etilmaydi):
 * `new Date('YYYY-MM-DD')` baribir UTC yarim tuni bo'lib qoladi. Shu sababli
 * bu modul faqat `Date.UTC` va `getUTC*` bilan ishlaydi — natija server
 * TZ'iga bog'liq emas.
 *
 * O'zbekiston 1991 yildan beri doimiy UTC+5 (yozgi vaqt YO'Q) — sobit +5 soat
 * siljish to'g'ri.
 *
 * ⚠️ Yangi kodda qo'lda `+5 soat`, `setHours` yoki `new Date('YYYY-MM-DD')`
 * kun chegarasi sifatida YOZILMASIN — shu funksiyalardan foydalaning.
 */

/** Toshkentning UTC'dan siljishi, daqiqada (UTC+5, yozgi vaqt yo'q). */
export const TASHKENT_OFFSET_MINUTES = 5 * 60;

const TASHKENT_OFFSET_MS = TASHKENT_OFFSET_MINUTES * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `date` tushgan Toshkent kunining 00:00:00.000 (yoki `isEnd` bo'lsa
 * 23:59:59.999) lahzasi, UTC sifatida. Analytics'dagi asl mantiq — o'zgarishsiz
 * ko'chirilgan (dashboard raqamlari o'zgarmasin).
 */
function tashkentBoundaryToUtc(date: Date, isEnd: boolean): Date {
  const shifted = new Date(date.getTime() + TASHKENT_OFFSET_MS);

  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();

  const utcMs =
    Date.UTC(
      y,
      m,
      d,
      isEnd ? 23 : 0,
      isEnd ? 59 : 0,
      isEnd ? 59 : 0,
      isEnd ? 999 : 0,
    ) - TASHKENT_OFFSET_MS;

  return new Date(utcMs);
}

/** `date` tushgan Toshkent kalendar kunining boshi — 00:00:00.000. */
export function startOfTashkentDay(date: Date): Date {
  return tashkentBoundaryToUtc(date, false);
}

/** `date` tushgan Toshkent kalendar kunining oxiri — 23:59:59.999. */
export function endOfTashkentDay(date: Date): Date {
  return tashkentBoundaryToUtc(date, true);
}

/** `date` tushgan Toshkent haftasining boshi — dushanba 00:00. */
export function startOfTashkentWeek(date: Date): Date {
  const shifted = new Date(date.getTime() + TASHKENT_OFFSET_MS);
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7;
  return new Date(
    startOfTashkentDay(date).getTime() - daysSinceMonday * DAY_MS,
  );
}

/** `date` tushgan Toshkent oyining boshi — 1-kun 00:00. */
export function startOfTashkentMonth(date: Date): Date {
  const shifted = new Date(date.getTime() + TASHKENT_OFFSET_MS);
  const daysSinceMonthStart = shifted.getUTCDate() - 1;
  return new Date(
    startOfTashkentDay(date).getTime() - daysSinceMonthStart * DAY_MS,
  );
}

/** `date` tushgan Toshkent oyining oxiri — oxirgi kun 23:59:59.999. */
export function endOfTashkentMonth(date: Date): Date {
  const shifted = new Date(date.getTime() + TASHKENT_OFFSET_MS);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) -
      TASHKENT_OFFSET_MS -
      1,
  );
}

/**
 * Faqat aniq 'YYYY-MM-DD' (bo'shliqlar kesiladi) → o'sha kalendar kunining
 * 12:00 UTC lahzasi (kun ichidagi "xavfsiz" nuqta). Boshqa har qanday qiymat
 * (to'liq ISO, '2026-1-5', bo'sh satr) → null.
 *
 * Analytics'dagi asl qoida: oydan oshgan kun oldinga suriladi
 * ('2026-02-30' → 2-mart), bu ataylab saqlangan.
 */
export function parseDateOnly(value?: string | null): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const match = DATE_ONLY_RE.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function toTashkentBound(
  value: string | null | undefined,
  boundary: (date: Date) => Date,
): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  // Yaroqsiz qiymat o'zgarishsiz qaytadi — chaqiruvchi o'zining 400 xabarini
  // tashlaydi (har bir endpoint'ning xato matni avvalgidek qoladi).
  if (Number.isNaN(parsed.getTime())) return parsed;
  const dateOnly = parseDateOnly(value);
  return dateOnly ? boundary(dateOnly) : parsed;
}

/**
 * API sana filtri chegaralari (start_day/end_day, fromDate/toDate,
 * from_date/to_date) — dashboard bilan AYNI qoida:
 * - bo'sh qiymat → undefined (filtr yo'q, ya'ni barcha vaqt);
 * - `new Date(v)` yaroqsiz → o'sha Invalid Date (chaqiruvchi 400 tashlaydi);
 * - aniq 'YYYY-MM-DD' → Toshkent kunining 00:00:00.000 / 23:59:59.999;
 * - boshqa qiymat (to'liq ISO va h.k.) → `new Date(v)` o'zgarishsiz.
 *
 * Masalan: ('2026-10-01', '2026-10-01') →
 * [2026-09-30T19:00:00.000Z, 2026-10-01T18:59:59.999Z].
 */
export function tashkentDayRange(
  start?: string | null,
  end?: string | null,
): { start?: Date; end?: Date } {
  return {
    start: toTashkentBound(start, startOfTashkentDay),
    end: toTashkentBound(end, endOfTashkentDay),
  };
}
