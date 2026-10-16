import { createHmac, timingSafeEqual } from 'node:crypto';

/** (xC88d8kH #1) initData 5 daqiqadan eski bo'lsa — rad. */
export const TELEGRAM_INIT_DATA_MAX_AGE_SEC = 300;

export type InitDataFailure =
  | 'empty'
  | 'no_hash'
  | 'bad_hash'
  | 'no_auth_date'
  | 'expired'
  | 'no_user'
  | 'no_bot_token';

export type InitDataResult =
  | {
      ok: true;
      user: { id: string; username: string | null; first_name: string | null };
      auth_date: number;
    }
  | { ok: false; reason: InitDataFailure };

/**
 * Telegram Mini App `initData` imzosini tekshiradi (Bot API hujjati):
 *   secret = HMAC_SHA256(key = "WebAppData", data = bot_token)
 *   hash   = hex(HMAC_SHA256(key = secret, data = data_check_string))
 * `data_check_string` — `hash` dan tashqari barcha juftliklar, kalit bo'yicha
 * saralangan, `key=value` qatorlari `\n` bilan. Solishtirish doimiy vaqtli.
 * `auth_date` `maxAgeSec` dan eski (yoki kelajakda) bo'lsa — `expired`.
 * Bot tokeni hech qachon natijada yoki xato matnida qaytmaydi.
 */
export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSec: number = TELEGRAM_INIT_DATA_MAX_AGE_SEC,
  nowSec: number = Math.floor(Date.now() / 1000),
): InitDataResult {
  if (!botToken) return { ok: false, reason: 'no_bot_token' };
  const raw = typeof initData === 'string' ? initData.trim() : '';
  if (!raw) return { ok: false, reason: 'empty' };
  const params = new URLSearchParams(raw);
  const hash = params.get('hash') ?? '';
  if (!/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'no_hash' };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret)
    .update(dataCheckString)
    .digest();
  const provided = Buffer.from(hash.toLowerCase(), 'hex');
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return { ok: false, reason: 'bad_hash' };
  }
  const authDate = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    return { ok: false, reason: 'no_auth_date' };
  }
  if (nowSec - authDate > maxAgeSec || authDate - nowSec > 60) {
    return { ok: false, reason: 'expired' };
  }
  const user = parseInitUser(params.get('user'));
  const id =
    typeof user?.id === 'number' || typeof user?.id === 'string'
      ? String(user.id)
      : '';
  if (!/^\d{1,20}$/.test(id)) return { ok: false, reason: 'no_user' };
  return {
    ok: true,
    user: {
      id,
      username: typeof user?.username === 'string' ? user.username : null,
      first_name: typeof user?.first_name === 'string' ? user.first_name : null,
    },
    auth_date: authDate,
  };
}

type InitUser = { id?: unknown; username?: unknown; first_name?: unknown };

function parseInitUser(raw: string | null): InitUser | null {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    return value && typeof value === 'object' ? (value as InitUser) : null;
  } catch {
    return null;
  }
}

/** Testlar va mini-app simulyatsiyasi uchun: imzolangan initData yasaydi. */
export function signTelegramInitData(
  fields: Record<string, string>,
  botToken: string,
): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set(
    'hash',
    createHmac('sha256', secret).update(dataCheckString).digest('hex'),
  );
  return params.toString();
}
