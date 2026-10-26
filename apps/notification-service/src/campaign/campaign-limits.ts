import { NotificationChannel } from '@app/common';

/**
 * (xHPdpj0W) Kampaniya navbati chegaralari.
 *
 * Partiya hajmi KICHIK (200): notification-service ichida ikkita Telegram bot
 * long-polling qiladi va inbox o'qishlari ham shu jarayonda — bitta partiya
 * (~7,4 ms/qabul qiluvchi, 2026-09-19 o'lchovi) ~1,5 s dan oshmasin.
 * Partiyalar KETMA-KET: har partiya keyingisini outbox'ga yozadi, outbox
 * publisher 1 s da bir poll qiladi — progress "real vaqtda" emas, ~2-3 s
 * qadam bilan yangilanadi.
 */
export const CAMPAIGN_BATCH_PATTERN = 'notification.campaign.batch';
export const CAMPAIGN_BATCH_SIZE = 200;
/** Bir partiya shuncha marta yiqilsa kampaniya `failed` (cheksiz qayta urinish yo'q). */
export const CAMPAIGN_MAX_BATCH_ATTEMPTS = 3;
/**
 * Kampaniya auditoriyasi chegarasi — sinxron dispatch'ning MAX_FANOUT (5000)
 * dan alohida va yuqori (W8aerwL6 #6). Env: NOTIFICATION_CAMPAIGN_MAX_FANOUT.
 * Oshsa — XATO (jimgina kesilmaydi).
 */
export const CAMPAIGN_MAX_FANOUT_DEFAULT = 20_000;
export const CAMPAIGN_MAX_FANOUT_CEILING = 100_000;
/** `scheduled_at` ko'pi bilan shuncha kun oldinga. */
export const CAMPAIGN_MAX_SCHEDULE_DAYS = 90;
/** identity `user_ids` filtri chegarasi bilan bir xil. */
export const CAMPAIGN_MAX_RECIPIENT_IDS = 5000;

/**
 * Kampaniyada ruxsat etilgan kanallar. (9D1Gl9MS) SMS — REAL PUL: kampaniyada
 * DOIM reklama (`promo`) — rozilik darvozasi, 18:00–09:00 taqiq, opt-out
 * havolasi, kunlik kvota (`SMS_DAILY_CAP`) va SMS_MAX_FANOUT chegarasi.
 * Telegram — market guruhi relay'i (qabul qiluvchi bo'yicha emas), email —
 * provayder yo'q.
 */
export const CAMPAIGN_ALLOWED_CHANNELS: readonly NotificationChannel[] =
  Object.freeze([
    NotificationChannel.IN_APP,
    NotificationChannel.REALTIME,
    NotificationChannel.PUSH,
    NotificationChannel.SMS,
  ]);

export function campaignMaxFanout(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return CAMPAIGN_MAX_FANOUT_DEFAULT;
  return Math.min(Math.floor(value), CAMPAIGN_MAX_FANOUT_CEILING);
}
