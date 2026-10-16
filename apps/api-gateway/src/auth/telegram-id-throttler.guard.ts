import { ExecutionContext, Injectable } from '@nestjs/common';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';

/** Alohida throttler nomi — global 'default' (per-IP) hisoblagichiga tegmaydi. */
export const TELEGRAM_ID_THROTTLER_NAME = 'telegram-id';
export const TELEGRAM_AUTH_LIMIT = 5;
export const TELEGRAM_AUTH_TTL_MS = 60_000;

/**
 * (xC88d8kH DIQQAT) `POST /auth/telegram` uchun Telegram foydalanuvchisi
 * (`initData.user.id`) bo'yicha 5/daqiqa — IP bo'yicha global limit
 * (ClientIpThrottlerGuard + AUTH_THROTTLE) ustidan. Kalit imzo
 * tekshirilishidan OLDIN olinadi: soxta id faqat o'sha soxta kalitni
 * "yeydi", haqiqiy foydalanuvchiga ta'sir qilmaydi. initData'da user
 * bo'lmasa — mijoz IP'si.
 *
 * Hisoblagich jarayon xotirasida (UserThrottlerGuard bilan bir xil cheklov).
 */
@Injectable()
export class TelegramIdThrottlerGuard extends ClientIpThrottlerGuard {
  canActivate(context: ExecutionContext): Promise<boolean> {
    return this.handleRequest({
      context,
      limit: TELEGRAM_AUTH_LIMIT,
      ttl: TELEGRAM_AUTH_TTL_MS,
      blockDuration: TELEGRAM_AUTH_TTL_MS,
      throttler: {
        name: TELEGRAM_ID_THROTTLER_NAME,
        limit: TELEGRAM_AUTH_LIMIT,
        ttl: TELEGRAM_AUTH_TTL_MS,
      },
      getTracker: (req: Record<string, any>) => this.getTracker(req),
      generateKey: (ctx: ExecutionContext, tracker: string, name: string) =>
        this.generateKey(ctx, tracker, name),
    });
  }

  protected getTracker(req: Record<string, any>): Promise<string> {
    const body = (req as { body?: { init_data?: unknown } }).body;
    const raw = typeof body?.init_data === 'string' ? body.init_data : '';
    const id = telegramUserIdOf(raw);
    return id ? Promise.resolve(`tg-${id}`) : super.getTracker(req);
  }
}

/** initData dagi `user.id` (imzosiz, faqat throttle kaliti uchun). */
export function telegramUserIdOf(initData: string): string | null {
  try {
    const user = JSON.parse(
      new URLSearchParams(initData).get('user') ?? 'null',
    ) as { id?: unknown } | null;
    const id =
      typeof user?.id === 'number' || typeof user?.id === 'string'
        ? String(user.id)
        : '';
    return /^\d{1,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
