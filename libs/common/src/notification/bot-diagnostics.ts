/**
 * (BOT-DIAG-BE) «Tizim holati»: Telegram bot nosozligining ANIQ sababi —
 * faqat superadmin. Kontrakt: gateway `GET /health/notification-bot` va
 * `POST /health/notification-bot/recheck` ↔ notification-service
 * `notification.health` (o'qish) va `notification.bot.recheck`.
 *
 * ⚠️ Bu maydonlar ochiq (`@Public`) javoblarga CHIQMAYDI: readiness faqat
 * `reported degraded` matnini beradi, `GET /notifications/health` esa eski
 * maydonlar bilan cheklanadi (`BOT_HEALTH_PUBLIC_FIELDS`) — oFfOWGuo P2.
 * Bot tokeni hech qaysi maydonda bo'lmaydi (notification-service
 * `redactToken` bilan yashiradi).
 */
export const NOTIFICATION_BOT_RECHECK_PATTERN = 'notification.bot.recheck';

/**
 * Oxirgi `getMe` tekshiruvi xatosining turi:
 *  - `token_rejected` — Telegram 401/404: token buzuq yoki bekor qilingan;
 *    qayta tekshirish befoyda — yangi token bilan restart kerak;
 *  - `timeout` — Telegram belgilangan vaqtda javob bermadi;
 *  - `network` — Telegram'ga ulanib bo'lmadi (DNS, rad etildi, uzildi …);
 *  - `telegram_error` — Telegram boshqa xato qaytardi (`error_status`: 429,
 *    5xx …);
 *  - `unknown` — kutilmagan xato (amalda uchramasligi kerak).
 * Sog' bo'lsa yoki hali tekshirilmagan bo'lsa — `null`.
 */
export const BOT_CHECK_ERROR_KINDS = [
  'token_rejected',
  'timeout',
  'network',
  'telegram_error',
  'unknown',
] as const;

export type BotCheckErrorKind = (typeof BOT_CHECK_ERROR_KINDS)[number];

export function isBotCheckErrorKind(
  value: unknown,
): value is BotCheckErrorKind {
  return (
    typeof value === 'string' &&
    (BOT_CHECK_ERROR_KINDS as readonly string[]).includes(value)
  );
}

/** `error_text` chegarasi (belgi). */
export const BOT_CHECK_ERROR_TEXT_MAX = 200;

/** `GET /notifications/health` (@Public) dagi `bot` — faqat shu maydonlar. */
export const BOT_HEALTH_PUBLIC_FIELDS = [
  'enabled',
  'mode',
  'healthy',
  'username',
  'reason',
] as const;
