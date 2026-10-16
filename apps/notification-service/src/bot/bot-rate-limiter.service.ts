import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramRateLimit } from '../entities/telegram-rate-limit.entity';

/**
 * (GL2GgtEc #1) Bot cheklovlari — `chat_id` / `from.id` bo'yicha, Postgres'da
 * (replikalararo). Gateway IP-throttleri bu yerda yaramaydi: webhook'da
 * hamma so'rov Telegram IP'laridan keladi.
 */
export const BOT_RATE_LIMITS = {
  /** Kiruvchi: chat bo'yicha 20 update/daqiqa; oshgani JIM tashlanadi. */
  inbound: { limit: 20, windowMs: 60_000 },
  /** Bog'lash kodi: 5 urinish/daqiqa (BeePost), 6-chisida 15 daqiqa blok. */
  link: { limit: 5, windowMs: 60_000, blockMs: 15 * 60_000 },
} as const;

export interface RateDecision {
  allowed: boolean;
  /** Blok yozildi yoki hali amalda. */
  blocked: boolean;
  hits: number;
}

interface HitOptions {
  limit: number;
  windowMs: number;
  blockMs?: number;
  /** DB xatosida: `true` — o'tkazib yuborish (kiruvchi), `false` — rad (xavfsizlik). */
  failOpen: boolean;
}

@Injectable()
export class BotRateLimiterService {
  private readonly logger = new Logger(BotRateLimiterService.name);

  constructor(
    @InjectRepository(TelegramRateLimit)
    private readonly limits: Repository<TelegramRateLimit>,
  ) {}

  /** Kiruvchi update: chat bo'yicha 20/daqiqa. */
  inbound(chatId: string): Promise<RateDecision> {
    return this.hit(`in:${chatId}`, {
      ...BOT_RATE_LIMITS.inbound,
      failOpen: true,
    });
  }

  /** Bog'lash kodi urinishi: odam (`from.id`) bo'yicha 5/daqiqa → 15 daqiqa blok. */
  linkAttempt(fromId: string): Promise<RateDecision> {
    return this.hit(`link:${fromId}`, {
      ...BOT_RATE_LIMITS.link,
      failOpen: false,
    });
  }

  /**
   * (Pq2dFj8A) Har update BIR marta: Telegram qayta yuborishi yoki RMQ qayta
   * yetkazishi takror ishlov bermaydi. Qator 1 kundan keyin tozalanadi.
   * DB xatosida — o'tkaziladi (update yo'qolmasin).
   */
  async firstSeen(updateId: number): Promise<boolean> {
    try {
      const rows: unknown[] = await this.limits.query(
        `INSERT INTO "notification_schema"."telegram_rate_limits"
                ("bucket", "window_start", "hits", "updated_at")
         VALUES ($1, now(), 1, now())
         ON CONFLICT ("bucket") DO NOTHING
         RETURNING "bucket"`,
        [`upd:${updateId}`],
      );
      return Array.isArray(rows) && rows.length > 0;
    } catch (error) {
      this.logger.error(
        `update dedup: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
  }

  /**
   * Bitta atomik so'rov: oyna o'tgan bo'lsa hisob 1 dan boshlanadi, aks
   * holda +1. `blocked_until` kelajakda bo'lsa — rad. Limitdan oshsa va
   * `blockMs` berilgan bo'lsa — blok YOZILADI.
   */
  async hit(bucket: string, options: HitOptions): Promise<RateDecision> {
    try {
      const rows: Array<{ hits: number; blocked: boolean }> =
        await this.limits.query(
          `INSERT INTO "notification_schema"."telegram_rate_limits" AS r
                  ("bucket", "window_start", "hits", "updated_at")
           VALUES ($1, now(), 1, now())
           ON CONFLICT ("bucket") DO UPDATE SET
             "hits" = CASE WHEN r."window_start" <= now() - ($2::int * interval '1 millisecond')
                           THEN 1 ELSE r."hits" + 1 END,
             "window_start" = CASE WHEN r."window_start" <= now() - ($2::int * interval '1 millisecond')
                           THEN now() ELSE r."window_start" END,
             "updated_at" = now()
           RETURNING "hits", COALESCE("blocked_until" > now(), false) AS "blocked"`,
          [bucket, options.windowMs],
        );
      const row = Array.isArray(rows) ? rows[0] : undefined;
      const hits = Number(row?.hits ?? 0);
      if (row?.blocked) return { allowed: false, blocked: true, hits };
      if (hits <= options.limit) return { allowed: true, blocked: false, hits };
      if (options.blockMs) {
        await this.limits.query(
          `UPDATE "notification_schema"."telegram_rate_limits"
              SET "blocked_until" = now() + ($2::int * interval '1 millisecond'),
                  "updated_at" = now()
            WHERE "bucket" = $1`,
          [bucket, options.blockMs],
        );
        this.logger.warn(
          `Bot cheklovi: ${bucket.split(':')[0]} — ${hits}-urinish, ${Math.round(options.blockMs / 60_000)} daqiqa blok yozildi`,
        );
        return { allowed: false, blocked: true, hits };
      }
      return { allowed: false, blocked: false, hits };
    } catch (error) {
      this.logger.error(
        `telegram_rate_limits (${bucket.split(':')[0]}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return { allowed: options.failOpen, blocked: false, hits: 0 };
    }
  }
}
