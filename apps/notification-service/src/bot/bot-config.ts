/**
 * (Mvx0h1Fv / uCrzrElu / ZlpXb4Wh) Bot ish rejimi va doimiylar.
 *
 * EGA QARORI (ZlpXb4Wh, 2026-09-20): bitta bot, bitta token
 * (`TELEGRAM_BOT_TOKEN`), bitta yadro. `botSlug` — webhook URL'idagi nom
 * (`TELEGRAM_BOT_SLUG`, sukut `elchi`); boshqa slug bilan kelgan update jim
 * tashlanadi.
 *
 * Rejim (`TELEGRAM_BOT_MODE`, sukut `auto`):
 *  - `off`     — kiruvchi update qabul qilinmaydi (chiquvchi xabarlar ishlaydi);
 *  - `webhook` — faqat `POST /telegram/webhook/:botSlug`; getUpdates HECH QACHON;
 *  - `polling` — zaxira: FAQAT `BOT_POLLING_LEADER=true` konteynerda;
 *  - `auto`    — token + `TELEGRAM_WEBHOOK_SECRET` bor → webhook; token bor,
 *                secret yo'q, leader → polling; aks holda off.
 * Token yo'q yoki placeholder (`replace_me`) → har doim `off` (prodda kuniga
 * ~28 800 muvaffaqiyatsiz so'rov qaytmasin).
 */
export type BotMode = 'webhook' | 'polling' | 'off';

/** `allowed_updates` — setWebhook ham, getUpdates ham shu ro'yxat bilan. */
export const TELEGRAM_ALLOWED_UPDATES: readonly string[] = Object.freeze([
  'message',
  'callback_query',
  'my_chat_member',
]);

export const DEFAULT_BOT_SLUG = 'elchi';
export const BOT_SLUG_RE = /^[a-z0-9_-]{1,32}$/;
export const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{16,256}$/;

/** RMQ hodisasi: gateway webhook → notification-service (yagona manba — libs/common). */
export { TELEGRAM_UPDATE_EVENT } from '@app/common';

export interface BotRuntimeConfig {
  mode: BotMode;
  /** Nima uchun shu rejim tanlangani — log va health uchun. */
  reason: string;
  slug: string;
  token: string;
  webhookSecret: string;
  pollingLeader: boolean;
}

type Get = (key: string) => unknown;

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

const truthy = (value: unknown): boolean =>
  value === true || ['1', 'true', 'yes'].includes(text(value).toLowerCase());

/** `replace_me` va shu kabi placeholder tokenlar ishlatilmaydi. */
export function isUsableBotToken(token: unknown): boolean {
  const value = text(token);
  if (!value || !value.includes(':')) return false;
  return !/replace|change|placeholder|your[_-]?token|example|xxx/i.test(value);
}

export function resolveBotConfig(get: Get): BotRuntimeConfig {
  const rawToken = text(get('TELEGRAM_BOT_TOKEN'));
  const token = isUsableBotToken(rawToken) ? rawToken : '';
  const slugRaw = text(get('TELEGRAM_BOT_SLUG')).toLowerCase();
  const slug = BOT_SLUG_RE.test(slugRaw) ? slugRaw : DEFAULT_BOT_SLUG;
  const secretRaw = text(get('TELEGRAM_WEBHOOK_SECRET'));
  const webhookSecret = WEBHOOK_SECRET_RE.test(secretRaw) ? secretRaw : '';
  const pollingLeader = truthy(get('BOT_POLLING_LEADER'));
  const requested = text(get('TELEGRAM_BOT_MODE')).toLowerCase() || 'auto';
  const base = { slug, token, webhookSecret, pollingLeader };

  if (!token) {
    return {
      ...base,
      mode: 'off',
      reason: rawToken
        ? 'TELEGRAM_BOT_TOKEN placeholder qiymatida'
        : 'TELEGRAM_BOT_TOKEN berilmagan',
    };
  }
  if (requested === 'off') {
    return { ...base, mode: 'off', reason: 'TELEGRAM_BOT_MODE=off' };
  }
  if (requested === 'webhook' || (requested === 'auto' && webhookSecret)) {
    if (!webhookSecret) {
      return {
        ...base,
        mode: 'off',
        reason:
          'webhook rejimi TELEGRAM_WEBHOOK_SECRET siz ishlamaydi (secret_token yagona himoya)',
      };
    }
    return { ...base, mode: 'webhook', reason: 'webhook (secret_token bilan)' };
  }
  if (requested === 'polling' || requested === 'auto') {
    if (!pollingLeader) {
      return {
        ...base,
        mode: 'off',
        reason:
          requested === 'auto'
            ? "TELEGRAM_WEBHOOK_SECRET yo'q va BOT_POLLING_LEADER o'rnatilmagan — kiruvchi update o'chiq"
            : 'polling faqat BOT_POLLING_LEADER=true konteynerda',
      };
    }
    return { ...base, mode: 'polling', reason: 'polling (leader)' };
  }
  return {
    ...base,
    mode: 'off',
    reason: `noma'lum TELEGRAM_BOT_MODE=${requested}`,
  };
}
