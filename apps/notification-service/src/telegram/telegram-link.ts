import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * (rCFZAmOz #1) Shaxsiy Telegram'ni ulash tokeni — `t.me/<bot>?start=<token>`.
 *
 * Holatsiz (DB/migratsiya yo'q): `l<userId36>_<exp36>_<imzo>`. Imzo —
 * HMAC-SHA256(kalit, `tg-link:<userId>:<exp>`), base64url 22 belgi. Kalit —
 * `TELEGRAM_LINK_SECRET`, bo'lmasa bot tokenidan hosil qilinadi (bot tokeni
 * baribir maxfiy; almashsa eski havolalar o'ladi — 15 daqiqalik bo'lgani uchun
 * muammo emas). Telegram `/start` parametri: ≤64 belgi, `[A-Za-z0-9_-]`.
 *
 * ⚠️ Token faqat TIZIMGA KIRGAN foydalanuvchiga o'zi uchun beriladi
 * (gateway JWT'dan `user_id`) — begona akkauntga chat ulab bo'lmaydi.
 */
export const TELEGRAM_LINK_TTL_SECONDS = 15 * 60;
const SIG_LENGTH = 22;
const TOKEN_RE = /^l([0-9a-z]{1,13})_([0-9a-z]{1,9})_([A-Za-z0-9_-]{22})$/;

const linkKey = (secret: string) =>
  createHash('sha256').update(`tg-link-key:${secret}`).digest();

const sign = (secret: string, userId: string, exp: number) =>
  createHmac('sha256', linkKey(secret))
    .update(`tg-link:${userId}:${exp}`)
    .digest('base64url')
    .slice(0, SIG_LENGTH);

export function createTelegramLinkToken(
  userId: string,
  secret: string,
  now = new Date(),
  ttlSeconds = TELEGRAM_LINK_TTL_SECONDS,
): { token: string; expires_at: Date } {
  if (!/^\d{1,19}$/.test(userId)) throw new Error('user_id');
  if (!secret) throw new Error('secret');
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const id36 = BigInt(userId).toString(36);
  const token = `l${id36}_${exp.toString(36)}_${sign(secret, userId, exp)}`;
  return { token, expires_at: new Date(exp * 1000) };
}

/** To'g'ri va muddati o'tmagan bo'lsa — `user_id`, aks holda null. */
export function verifyTelegramLinkToken(
  token: string,
  secret: string,
  now = new Date(),
): string | null {
  if (!secret) return null;
  const match = TOKEN_RE.exec(String(token ?? '').trim());
  if (!match) return null;
  let userId: string;
  try {
    userId = [...match[1]]
      .reduce(
        (acc, ch) => acc * BigInt(36) + BigInt(parseInt(ch, 36)),
        BigInt(0),
      )
      .toString();
  } catch {
    return null;
  }
  const exp = parseInt(match[2], 36);
  if (!Number.isFinite(exp) || exp * 1000 <= now.getTime()) return null;
  const expected = Buffer.from(sign(secret, userId, exp));
  const actual = Buffer.from(match[3]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return null;
  return userId;
}
