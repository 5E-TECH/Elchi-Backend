import { maskPhonesForLog } from '../pii/mask-phones';

/**
 * Sentry event'idan biz tozalaydigan maydonlar. `@sentry/node` ning
 * `ErrorEvent` turi strukturaviy jihatdan shunga mos keladi — bu yerda SDK
 * turiga bog'lanmaymiz, shunda funksiya sof va oson test qilinadi.
 */
export interface ScrubbableSentryEvent {
  message?: string;
  logentry?: { message?: string };
  request?: { url?: string; data?: unknown };
  exception?: { values?: { value?: string }[] };
  extra?: Record<string, unknown>;
}

/**
 * AI buyurtma yo'llari (`/orders/ai-parse`, `/orders/ai-confirm`, ...).
 * Ularning tanasida mijoz matni, ism/telefon/manzil va rasm base64 bor.
 */
const AI_ORDER_ROUTE_RE = /\/orders\/ai-/;

function maskIfString(value: unknown): unknown {
  return typeof value === 'string' ? maskPhonesForLog(value) : value;
}

/**
 * ⚠️ MAXFIYLIK (HD5zOyBp #18): Sentry'ga (tashqi SaaS) to'liq telefon va AI
 * buyurtma tanasi CHIQMASLIGI kerak.
 *
 * - `request.url` AI buyurtma yo'li bo'lsa — `request.data` butunlay olib
 *   tashlanadi (matn, manzil, rasm base64).
 * - `message`, `logentry.message`, `exception.values[].value` va `extra`
 *   ning satr qiymatlaridagi telefonlar `+99890*****67` shakliga keltiriladi
 *   (`maskPhoneForLog`). Narxlar (3-3-3) tegilmaydi.
 *
 * SOF funksiya: kirish event'i o'zgartirilmaydi, tozalangan nusxa qaytadi.
 */
export function scrubSentryEvent<E extends ScrubbableSentryEvent>(event: E): E {
  if (!event || typeof event !== 'object') return event;
  const out: ScrubbableSentryEvent = { ...event };

  if (out.request) {
    const request = { ...out.request };
    if (
      typeof request.url === 'string' &&
      AI_ORDER_ROUTE_RE.test(request.url)
    ) {
      delete request.data;
    }
    out.request = request;
  }

  if (typeof out.message === 'string') {
    out.message = maskPhonesForLog(out.message);
  }

  if (out.logentry && typeof out.logentry.message === 'string') {
    out.logentry = {
      ...out.logentry,
      message: maskPhonesForLog(out.logentry.message),
    };
  }

  if (Array.isArray(out.exception?.values)) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((ex) =>
        typeof ex?.value === 'string'
          ? { ...ex, value: maskPhonesForLog(ex.value) }
          : ex,
      ),
    };
  }

  if (out.extra && typeof out.extra === 'object') {
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out.extra)) {
      extra[key] = maskIfString(value);
    }
    out.extra = extra;
  }

  return out as E;
}
