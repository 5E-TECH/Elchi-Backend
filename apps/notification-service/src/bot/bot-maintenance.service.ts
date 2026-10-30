import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

export interface BotPruneResult {
  sessions: number;
  actions: number;
  rateLimits: number;
  outbox: number;
  /** (rzGKtE9N) `notification_dispatch_keys` — 7 kundan eski dedup kalitlari. */
  dispatchKeys: number;
  /** (e7KhaeOO) muddati o'tgan AI qoralamalari — mijoz PII si o'chadi. */
  aiDrafts: number;
  /** (BOT-2 #4) 30 kundan eski bog'lash kodlari. */
  linkTokens: number;
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
 *  - `telegram_outbox`: `sent` — 3 kundan, `dead` — 7 kundan eski (BOT-2:
 *    yuborilgan qatorning matni yuborilganda o'chiriladi, `dead` da matn
 *    qayta yuborish / tahlil uchun 7 kun qoladi);
 *  - `telegram_link_tokens`: 30 kundan eski bog'lash kodlari (BOT-2);
 *  - `notification_dispatch_keys`: 7 kundan eski dispatch dedup kalitlari;
 *  - `telegram_ai_drafts`: `expires_at` (24 soat) o'tgan qoralamalar (PII).
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
      dispatchKeys: 0,
      aiDrafts: 0,
      linkTokens: 0,
    };
    // (BOT-2 #4) Har qadam ALOHIDA: bitta jadval xatosi qolgan tozalashni
    // (masalan bog'lash kodlari yoki PII li qoralamalar) to'xtatmasin.
    const steps: Array<[keyof BotPruneResult, string]> = [
      [
        'sessions',
        `DELETE FROM "notification_schema"."telegram_sessions"
          WHERE "expires_at" IS NOT NULL AND "expires_at" < now()`,
      ],
      [
        'actions',
        `DELETE FROM "notification_schema"."telegram_bot_actions"
          WHERE "expires_at" < now() - interval '1 day'`,
      ],
      [
        'rateLimits',
        `DELETE FROM "notification_schema"."telegram_rate_limits"
          WHERE "updated_at" < now() - interval '1 day'
            AND ("blocked_until" IS NULL OR "blocked_until" < now())`,
      ],
      [
        'outbox',
        `DELETE FROM "notification_schema"."telegram_outbox"
          WHERE ("status" = 'sent' AND "created_at" < now() - interval '3 days')
             OR ("status" = 'dead' AND "created_at" < now() - interval '7 days')`,
      ],
      [
        'dispatchKeys',
        `DELETE FROM "notification_schema"."notification_dispatch_keys"
          WHERE "created_at" < now() - interval '7 days'`,
      ],
      [
        'aiDrafts',
        `DELETE FROM "notification_schema"."telegram_ai_drafts"
          WHERE "expires_at" < now()`,
      ],
      [
        'linkTokens',
        `DELETE FROM "notification_schema"."telegram_link_tokens"
          WHERE "created_at" < now() - interval '30 days'`,
      ],
    ];
    for (const [key, sql] of steps) {
      try {
        result[key] = rowCount(await this.dataSource.query(sql));
      } catch (error) {
        this.logger.error(
          `telegram bot prune (${key}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (Object.values(result).some((count) => count > 0)) {
      this.logger.log(
        `telegram bot prune: sessiya ${result.sessions}, tugma ${result.actions}, limit ${result.rateLimits}, outbox ${result.outbox}, dedup ${result.dispatchKeys}, ai-draft ${result.aiDrafts}, ulash kodi ${result.linkTokens}`,
      );
    }
    return result;
  }
}
