import { BadRequestException } from '@nestjs/common';
import { NotificationCategory, TASHKENT_OFFSET_MINUTES } from '@app/common';
import { parseQuietHours } from '../sms/sms-config.service';
import type { QuietHours } from '../sms/sms-config.service';
import type {
  CampaignStatus,
  NotificationCampaign,
} from './notification-campaign.entity';

/**
 * (WIsb9Ytq) Kampaniyani rejalashtirish va reklama tungi taqiq darvozasi.
 *
 * - Vaqt FAQAT Toshkent bo'yicha o'qiladi: `scheduled_at` ISO + ANIQ zona
 *   (`Z` yoki `+05:00`) bilan keladi; zonasiz satr 400 — brauzer mahalliy
 *   vaqti server TZ'ida ikkinchi marta talqin qilinmasin (qo'shaloq
 *   konversiya = taqiq oynasi 5 soatga siljiydi).
 * - Taqiq oynasi `NOTIF_PROMO_QUIET_HOURS` (sukut 18:00-09:00) — SMS
 *   darvozasi bilan BIR xil sozlama, kodga qotirilmagan.
 * - Oyna SQL'da BITTA `AT TIME ZONE 'Asia/Tashkent'` ifodasi bilan
 *   hisoblanadi (Toshkent devor soati), surilish esa `timestamptz + interval`
 *   (O'zbekistonda yozgi vaqt yo'q — interval aniq). Ikkinchi konversiya yo'q.
 * - ⚠️ `libs/common/src/outbox/outbox.service.ts` O'ZGARTIRILMAYDI: navbatdan
 *   olish (`getDuePending`) avvalgidek JS `new Date()` (UTC lahza) bilan —
 *   darvoza faqat `scheduledAt` lahzasini hisoblaydi.
 */
export const CAMPAIGN_TIMEZONE = 'Asia/Tashkent';

/**
 * Reklama/promo kampaniya — katalog kategoriyasi `marketing`
 * (`marketing.promo`, `marketing.manual`). Boshqa kategoriyalar (rol
 * xabari, e'lon, tizim) tranzaksion: tungi oynada ham BLOKLANMAYDI.
 */
export const isPromoCategory = (category: unknown): boolean =>
  category === NotificationCategory.MARKETING;

/** Sozlama → oyna (noto'g'ri qiymat — xavfsiz sukut 18:00-09:00). */
export const campaignQuietHours = (raw: unknown): QuietHours =>
  parseQuietHours(typeof raw === 'string' ? raw : undefined);

const pad = (value: number) => String(value).padStart(2, '0');

/** Daqiqa (00:00 dan) → 'HH:MM'. */
export const formatMinuteOfDay = (minutes: number): string =>
  `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/**
 * Taqiq oynasining tugash lahzasi — SQL'da, BITTA `AT TIME ZONE`.
 * $1 — lahza (timestamptz), $2/$3 — oyna boshi/oxiri (daqiqa, Toshkent).
 * `s` — Toshkent devor soatidagi soniya (00:00 dan). Oyna ichida bo'lsa
 * lahzaga oyna oxirigacha qolgan soniya qo'shiladi (yarim tundan o'tsa ham
 * to'g'ri: modul 86400), aks holda lahza o'zgarmaydi.
 */
export const PROMO_QUIET_RELEASE_SQL = `
  SELECT CASE
           WHEN (CASE WHEN $2::int > $3::int
                      THEN t.s >= $2::int * 60 OR t.s < $3::int * 60
                      ELSE t.s >= $2::int * 60 AND t.s < $3::int * 60
                 END)
           THEN t.at + make_interval(
                  secs => (mod(mod($3::int * 60 - t.s, 86400) + 86400, 86400))::double precision
                )
           ELSE t.at
         END AS "release_at"
    FROM (
      SELECT $1::timestamptz AS at,
             EXTRACT(EPOCH FROM ($1::timestamptz AT TIME ZONE 'Asia/Tashkent')::time) AS s
    ) t`;

export interface SqlRunner {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/**
 * Reklama shu lahzada yuborila oladimi: oyna ichida — oyna tugash lahzasi
 * (ertangi/bugungi 09:00), aks holda `at` ning o'zi. TASHLANMAYDI — suriladi.
 * Natijani o'qib bo'lmasa XATO (fail-closed: tunda yuborib yubormaslik).
 */
export async function promoReleaseAt(
  runner: SqlRunner,
  at: Date,
  window: QuietHours,
): Promise<Date> {
  if (window.start === window.end) return at;
  const rows = (await runner.query(PROMO_QUIET_RELEASE_SQL, [
    at.toISOString(),
    window.start,
    window.end,
  ])) as Array<{ release_at?: unknown }> | undefined;
  const raw = rows?.[0]?.release_at;
  const release =
    raw instanceof Date
      ? raw
      : typeof raw === 'string'
        ? new Date(raw)
        : new Date(NaN);
  if (Number.isNaN(release.getTime())) {
    throw new Error('promo quiet-hours gate: release_at aniqlanmadi');
  }
  return release.getTime() < at.getTime() ? at : release;
}

const ISO_WITH_ZONE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * `scheduled_at` — ISO 8601 + ANIQ zona (`2026-10-20T09:00:00+05:00` yoki
 * `...Z`). Zonasiz (`2026-10-20T09:00`) yoki sanasiz — 400: brauzer mahalliy
 * vaqti serverda boshqa zona deb o'qilmasin.
 */
export function parseZonedInstant(value: string, field = 'scheduled_at'): Date {
  const text = value.trim();
  if (!ISO_WITH_ZONE_RE.test(text)) {
    throw new BadRequestException(
      `${field}: ISO 8601 vaqt ANIQ zona bilan bo'lishi kerak (masalan 2026-10-20T09:00:00+05:00 — Toshkent vaqti, yoki ...Z). Zonasiz vaqt qabul qilinmaydi.`,
    );
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} — yaroqsiz sana`);
  }
  return date;
}

/** Lahzani Toshkent devor soatida ko'rsatadi: 'YYYY-MM-DDTHH:mm:ss+05:00'. */
export function toTashkentIso(date: Date | string | null | undefined) {
  if (!date) return null;
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  const shifted = new Date(value.getTime() + TASHKENT_OFFSET_MINUTES * 60_000);
  return `${shifted.toISOString().slice(0, 19)}+05:00`;
}

/**
 * Ro'yxat uchun holat (karta: rejalashtirilgan / yuborilmoqda / yuborilgan /
 * bekor qilingan; + xato):
 * - `scheduled` — hali boshlanmagan va vaqti (yoki tungi taqiq tugashi)
 *   kelajakda;
 * - `sending`   — navbatda (vaqti kelgan) yoki partiyalar ketmoqda (tungi
 *   taqiqda to'xtagan bo'lsa ham — `paused_until` ko'rsatadi);
 * - `sent` / `failed` / `cancelled` — yakuniy.
 */
export type CampaignDisplayStatus =
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled';

export const CAMPAIGN_DISPLAY_STATUSES: readonly CampaignDisplayStatus[] =
  Object.freeze(['scheduled', 'sending', 'sent', 'failed', 'cancelled']);

/** Faqat yuborilmaguncha bekor qilinadi (yuborilgan — tugma YO'Q, 409). */
export const CAMPAIGN_CANCELLABLE_STATUSES: readonly CampaignStatus[] =
  Object.freeze(['draft', 'queued', 'running']);

const future = (value: Date | string | null | undefined, now: number) =>
  Boolean(value) && new Date(value as Date).getTime() > now;

export function campaignDisplayStatus(
  row: Pick<NotificationCampaign, 'status' | 'scheduled_at'> & {
    paused_until?: Date | null;
  },
  now = Date.now(),
): CampaignDisplayStatus {
  switch (row.status) {
    case 'done':
      return 'sent';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return 'sending';
    default:
      return future(row.scheduled_at, now) || future(row.paused_until, now)
        ? 'scheduled'
        : 'sending';
  }
}
