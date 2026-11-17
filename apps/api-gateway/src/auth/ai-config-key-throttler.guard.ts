import { ExecutionContext, Injectable } from '@nestjs/common';
import {
  ClientIpThrottlerGuard,
  resolveTrustedClientIp,
} from './client-ip-throttler.guard';

/**
 * `/ai/config/key*` yozuvlari uchun qo'shimcha cheklov (be-brief §8):
 * foydalanuvchi (`sub`) bo'yicha 10/daqiqa VA ishonchli IP bo'yicha
 * 30/daqiqa — ortiqcha urinish RMQ'ga yetib bormaydi. ai-service'dagi DB
 * cheklovi (5/daqiqa/foydalanuvchi, 30/soat/muhit) — asosiy, bu esa erta
 * to'siq. Global `default` (60/IP) o'zgarmaydi (alohida nomlar).
 *
 * Hisoblagich jarayon xotirasida (UserThrottlerGuard bilan bir xil cheklov).
 */
export const AI_CONFIG_KEY_THROTTLE = {
  user: { name: 'ai-config-user', limit: 10, ttl: 60_000 },
  ip: { name: 'ai-config-ip', limit: 30, ttl: 60_000 },
} as const;

@Injectable()
export class AiConfigKeyThrottlerGuard extends ClientIpThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    for (const t of [AI_CONFIG_KEY_THROTTLE.user, AI_CONFIG_KEY_THROTTLE.ip]) {
      const byUser = t.name === AI_CONFIG_KEY_THROTTLE.user.name;
      await this.handleRequest({
        context,
        limit: t.limit,
        ttl: t.ttl,
        blockDuration: t.ttl,
        throttler: { name: t.name, limit: t.limit, ttl: t.ttl },
        getTracker: (req: Record<string, any>) =>
          Promise.resolve(byUser ? userTracker(req) : ipTracker(req)),
        // Hamma /ai/config/key* route'lari UMUMIY hisoblagich (route bo'yicha emas).
        generateKey: (_ctx: ExecutionContext, tracker: string, name: string) =>
          `ai-config-key:${name}:${tracker}`,
      });
    }
    return true;
  }
}

function ipTracker(req: Record<string, any>): string {
  return `ip-${resolveTrustedClientIp(req) ?? 'unknown'}`;
}

function userTracker(req: Record<string, any>): string {
  const sub = (req as { user?: { sub?: unknown } | null }).user?.sub;
  return typeof sub === 'string' || typeof sub === 'number'
    ? `user-${String(sub)}`
    : ipTracker(req);
}
