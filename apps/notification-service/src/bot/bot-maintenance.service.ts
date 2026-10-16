import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

export interface BotPruneResult {
  sessions: number;
  actions: number;
  rateLimits: number;
  outbox: number;
}

const rowCount = (result: unknown): number => {
  // pg DELETE: TypeORM `query` → [rows, count].
  if (Array.isArray(result) && typeof result[1] === 'number') return result[1];
  return 0;
};

/**
 * (UQlmQiGT #2) Bot jadvallarini tozalash — har soat:
 *  - `telegram_sessions`: `expires_at` o'tgan (24 soat TTL); `expires_at IS
 *    NULL` (tizim qatori — polling offset) TEGILMAYDI;
 *  - `telegram_bot_actions`: muddati o'tganiga 1 kun bo'lgan tugmalar;
 *  - `telegram_rate_limits`: 1 kundan eski va blokda bo'lmagan hisoblagichlar;
 *  - `telegram_outbox`: `sent` — 3 kundan, `dead` — 30 kundan eski.
 * DELETE idempotent — ko'p replikada ham xavfsiz.
 */
@Injectable()
export class BotMaintenanceService {
  private readonly logger = new Logger(BotMaintenanceService.name);

  constructor(private readonly dataSource: DataSource) {}

  @Cron('17 * * * *', { name: 'telegram-bot-prune' })
  async prune(): Promise<BotPruneResult> {
    const result: BotPruneResult = {
      sessions: 0,
      actions: 0,
      rateLimits: 0,
      outbox: 0,
    };
    try {
      result.sessions = rowCount(
        await this.dataSource.query(
          `DELETE FROM "notification_schema"."telegram_sessions"
            WHERE "expires_at" IS NOT NULL AND "expires_at" < now()`,
        ),
      );
      result.actions = rowCount(
        await this.dataSource.query(
          `DELETE FROM "notification_schema"."telegram_bot_actions"
            WHERE "expires_at" < now() - interval '1 day'`,
        ),
      );
      result.rateLimits = rowCount(
        await this.dataSource.query(
          `DELETE FROM "notification_schema"."telegram_rate_limits"
            WHERE "updated_at" < now() - interval '1 day'
              AND ("blocked_until" IS NULL OR "blocked_until" < now())`,
        ),
      );
      result.outbox = rowCount(
        await this.dataSource.query(
          `DELETE FROM "notification_schema"."telegram_outbox"
            WHERE ("status" = 'sent' AND "created_at" < now() - interval '3 days')
               OR ("status" = 'dead' AND "created_at" < now() - interval '30 days')`,
        ),
      );
      if (result.sessions || result.actions || result.outbox) {
        this.logger.log(
          `telegram bot prune: sessiya ${result.sessions}, tugma ${result.actions}, limit ${result.rateLimits}, outbox ${result.outbox}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `telegram bot prune: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return result;
  }
}
