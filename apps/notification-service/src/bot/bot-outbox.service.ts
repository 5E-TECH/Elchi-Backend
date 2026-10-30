import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { TelegramOutbox } from '../entities/telegram-outbox.entity';
import { resolveBotConfig } from './bot-config';
import {
  BotTransportService,
  TelegramApiError,
  assertCallbackDataFits,
} from './bot-transport.service';
import { BotChannelService } from './bot-channel.service';
import type { InlineKeyboardMarkup, TelegramParseMode } from './telegram.types';

/** Sukut: 5 urinish, keyin dead-letter. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** `sending` holatida qolib ketgan qator (jarayon yiqildi) qayta olinadi. */
const STALE_SENDING_MS = 2 * 60_000;
const BATCH = 25;
const ERROR_MAX = 300;

export interface OutboxMessage {
  chatId: string;
  text: string;
  parse_mode?: TelegramParseMode;
  reply_markup?: InlineKeyboardMarkup;
  disable_web_page_preview?: boolean;
  /** Kim yubordi (`notification.send`, `bot.reply`, …) — kuzatuv uchun. */
  source: string;
  maxAttempts?: number;
  /**
   * (BOT-3c) Yakuniy natija (`sent` / `dead`) shu inbox qatorlarining
   * `delivery.telegram` iga yoziladi — `queued` / `retrying` jim qolmaydi.
   */
  notificationIds?: string[];
}

type OutboxRow = {
  id: string;
  chat_id: string;
  payload: Record<string, unknown>;
  retry_count: number;
  max_attempts: number;
  notification_ids?: string[] | null;
};

export type OutboxSendStatus = 'sent' | 'queued' | 'dead';

export interface OutboxSendResult {
  id: string;
  status: OutboxSendStatus;
  error?: string;
  /** Telegram `sendMessage` natijasi (sent bo'lsa). */
  result?: { message_id?: number } | null;
}

/** Keyingi urinish vaqti: 429 → `retry_after`, aks holda 5s × 2^n (≤10 daqiqa). */
export function nextAttemptDelayMs(error: unknown, retryCount: number): number {
  if (error instanceof TelegramApiError) {
    if (error.kind === 'rate_limited') {
      return Math.max(1, error.retryAfterSec ?? 1) * 1000;
    }
    if (error.kind === 'unauthorized') return 5 * 60_000;
  }
  return Math.min(5_000 * 2 ** retryCount, 10 * 60_000);
}

/** 403/400 — qayta urinish befoyda (dead-letter darhol). */
export function isPermanentSendError(error: unknown): boolean {
  return (
    error instanceof TelegramApiError &&
    (error.kind === 'blocked' || error.kind === 'bad_request')
  );
}

/**
 * (9HIaV80X #2-#3) Chiquvchi outbox. Xabar AVVAL `telegram_outbox` ga
 * yoziladi (`sending` — shu jarayon da'vo qilgan), so'ng darhol bir marta
 * yuboriladi:
 *  - muvaffaqiyat → `sent`;
 *  - 429 / 5xx / tarmoq → `pending`, `retry_count + 1`, `next_attempt_at`
 *    (429 da `retry_after`) — worker (har 5 s) qayta yuboradi; `max_attempts`
 *    tugasa `dead`;
 *  - 403 (bloklangan / chiqarilgan) va 400 → darhol `dead`, QAYTA URINILMAYDI;
 *    403 da kanal nofaol qilinadi (`BotChannelService`).
 * Servis yiqilsa ham xabar yo'qolmaydi: `sending` da qolgan qator 2 daqiqadan
 * keyin worker tomonidan qayta olinadi.
 */
@Injectable()
export class BotOutboxService implements OnModuleDestroy {
  private readonly logger = new Logger(BotOutboxService.name);
  private readonly botSlug: string;
  private draining = false;
  private stopped = false;

  constructor(
    @InjectRepository(TelegramOutbox)
    private readonly outbox: Repository<TelegramOutbox>,
    private readonly transport: BotTransportService,
    private readonly channels: BotChannelService,
    config: ConfigService,
  ) {
    this.botSlug = resolveBotConfig((key) => config.get(key)).slug;
  }

  onModuleDestroy() {
    this.stopped = true;
  }

  /** Yozish + darhol bitta urinish. Throw qilmaydi (natija holatda). */
  async send(message: OutboxMessage): Promise<OutboxSendResult> {
    const row = await this.insertRow(this.outbox, message, 'sending');
    return this.attempt(row);
  }

  /**
   * (BOT-3c) Chaqiruvchi TRANZAKSIYASI ichida navbatga (`pending`, darhol
   * muddati kelgan): rollback → xabar yo'q; commit'dan keyin servis yiqilsa
   * ham worker yuboradi. Commit'dan keyin `sendNow` bilan darhol urinish.
   */
  async enqueue(
    manager: EntityManager,
    message: OutboxMessage,
  ): Promise<string> {
    const row = await this.insertRow(
      manager.getRepository(TelegramOutbox),
      message,
      'pending',
    );
    return row.id;
  }

  /**
   * (BOT-3c) `enqueue` qilingan qatorlarni darhol bir marta yuborish (worker
   * kutmasdan). Faqat hali urinilmagan `pending` qatorlar da'vo qilinadi —
   * worker allaqachon olgan yoki 429 dan keyin qayta urinish navbatidagi
   * qator takror yuborilmaydi (natija `queued`).
   */
  async sendNow(ids: string[]): Promise<OutboxSendResult[]> {
    if (!ids.length) return [];
    let rows: OutboxRow[] = [];
    try {
      const claimed: unknown = await this.outbox.query(
        `UPDATE "notification_schema"."telegram_outbox"
            SET "status" = 'sending', "updated_at" = now()
          WHERE "id" = ANY($1::bigint[]) AND "status" = 'pending'
            AND "retry_count" = 0
        RETURNING "id", "chat_id", "payload", "retry_count", "max_attempts",
                  "notification_ids"`,
        [ids],
      );
      rows = rowsOf<OutboxRow>(claimed);
    } catch (error) {
      this.logger.warn(
        `telegram_outbox sendNow: ${this.transport.describe(error)} — worker yuboradi`,
      );
    }
    const results: OutboxSendResult[] = [];
    for (const row of rows) {
      results.push(await this.attempt({ ...row, id: String(row.id) }));
    }
    const done = new Set(results.map((result) => result.id));
    for (const id of ids) {
      if (!done.has(String(id))) {
        results.push({ id: String(id), status: 'queued' });
      }
    }
    return results;
  }

  private async insertRow(
    repo: Repository<TelegramOutbox>,
    message: OutboxMessage,
    status: 'sending' | 'pending',
  ): Promise<OutboxRow> {
    // Dasturchi xatosi (64 baytdan uzun callback_data) navbatga tushmasin.
    assertCallbackDataFits(message.reply_markup);
    const payload: Record<string, unknown> = { text: message.text };
    if (message.parse_mode) payload.parse_mode = message.parse_mode;
    if (message.reply_markup) payload.reply_markup = message.reply_markup;
    if (message.disable_web_page_preview !== undefined) {
      payload.disable_web_page_preview = message.disable_web_page_preview;
    }
    const maxAttempts = Math.max(1, message.maxAttempts ?? OUTBOX_MAX_ATTEMPTS);
    const notificationIds = message.notificationIds?.length
      ? message.notificationIds.map(String)
      : null;
    const inserted = await repo.insert({
      bot_slug: this.botSlug,
      chat_id: message.chatId,
      method: 'sendMessage',
      payload: payload as never,
      status,
      retry_count: 0,
      max_attempts: maxAttempts,
      source: message.source.slice(0, 48),
      ...(notificationIds ? { notification_ids: notificationIds } : {}),
    });
    const id = String(
      (inserted.identifiers[0] as { id?: string } | undefined)?.id ?? '',
    );
    return {
      id,
      chat_id: message.chatId,
      payload,
      retry_count: 0,
      max_attempts: maxAttempts,
      notification_ids: notificationIds,
    };
  }

  /** Worker: muddati kelgan `pending` va qolib ketgan `sending` qatorlar. */
  @Interval('telegram-outbox', 5_000)
  async processDue(): Promise<number> {
    if (this.draining || this.stopped) return 0;
    this.draining = true;
    try {
      const claimed: OutboxRow[] = await this.outbox.query(
        `UPDATE "notification_schema"."telegram_outbox" o
            SET "status" = 'sending', "updated_at" = now()
          WHERE o."id" IN (
                SELECT "id" FROM "notification_schema"."telegram_outbox"
                 WHERE ("status" = 'pending' AND "next_attempt_at" <= now())
                    OR ("status" = 'sending' AND "updated_at" < now() - ($1::int * interval '1 millisecond'))
                 ORDER BY "id"
                 LIMIT ${BATCH}
                 FOR UPDATE SKIP LOCKED)
        RETURNING o."id", o."chat_id", o."payload", o."retry_count", o."max_attempts",
                  o."notification_ids"`,
        [STALE_SENDING_MS],
      );
      const rows = Array.isArray(claimed[0])
        ? (claimed[0] as unknown as typeof claimed)
        : claimed;
      for (const row of rows) {
        await this.attempt({ ...row, id: String(row.id) });
      }
      return rows.length;
    } catch (error) {
      this.logger.error(
        `telegram_outbox worker: ${this.transport.describe(error)}`,
      );
      return 0;
    } finally {
      this.draining = false;
    }
  }

  private async attempt(row: OutboxRow): Promise<OutboxSendResult> {
    const payload = row.payload as {
      text?: string;
      parse_mode?: TelegramParseMode;
      reply_markup?: InlineKeyboardMarkup;
      disable_web_page_preview?: boolean;
    };
    try {
      const result = (await this.transport.sendMessage(
        row.chat_id,
        String(payload.text ?? ''),
        {
          parse_mode: payload.parse_mode,
          reply_markup: payload.reply_markup,
          disable_web_page_preview: payload.disable_web_page_preview,
        },
        // Outbox o'zi qayta uradi — so'rov ichida 60 s kutib turilmaydi.
        { maxAttempts: 1 },
      )) as { message_id?: number } | null;
      await this.outbox.update(
        { id: row.id },
        {
          status: 'sent',
          sent_at: new Date(),
          updated_at: new Date(),
          last_error: null,
        },
      );
      await this.settle(row.notification_ids, 'sent', null);
      return { id: row.id, status: 'sent', result };
    } catch (error) {
      const reason = this.transport.describe(error).slice(0, ERROR_MAX);
      const retryCount = row.retry_count + 1;
      // Token umuman sozlanmagan — restartsiz tuzalmaydi: qayta urinilmaydi.
      const permanent =
        isPermanentSendError(error) || !this.transport.defaultToken;
      const dead = permanent || retryCount >= row.max_attempts;
      await this.outbox.update(
        { id: row.id },
        {
          status: dead ? 'dead' : 'pending',
          retry_count: retryCount,
          last_error: reason,
          next_attempt_at: new Date(
            Date.now() + nextAttemptDelayMs(error, row.retry_count),
          ),
          updated_at: new Date(),
        },
      );
      if (error instanceof TelegramApiError && error.kind === 'blocked') {
        await this.channels
          .markInactive(
            row.chat_id,
            this.botSlug,
            /chat not found/i.test(error.description)
              ? 'chat_not_found'
              : 'blocked_on_send',
          )
          .catch((markError: unknown) =>
            this.logger.error(
              `kanalni nofaol qilib bo'lmadi: ${this.transport.describe(markError)}`,
            ),
          );
      }
      if (dead) {
        await this.settle(row.notification_ids, 'dead', reason);
        this.logger.warn(
          `telegram_outbox #${row.id} dead-letter (${retryCount} urinish, chat ${row.chat_id}): ${reason}`,
        );
      }
      return { id: row.id, status: dead ? 'dead' : 'queued', error: reason };
    }
  }

  /**
   * (BOT-3c) Inbox qatorlarining yakuniy `delivery.telegram` i — faqat hali
   * oraliq holatda (`queued` / `retrying` / `sending`) bo'lganlari: bir
   * nechta guruhga relay'da birinchi yakun qoladi, yakunlangan qayta yozilmaydi.
   * Best-effort: xato — faqat log (xabar baribir ketgan / dead).
   */
  private async settle(
    notificationIds: string[] | null | undefined,
    outcome: 'sent' | 'dead',
    reason: string | null,
  ): Promise<void> {
    if (!notificationIds?.length) return;
    const patch =
      outcome === 'sent'
        ? { telegram: 'sent' }
        : {
            telegram: 'failed',
            telegram_error: (reason ?? 'telegram_failed').slice(0, 200),
          };
    try {
      await this.outbox.query(
        `UPDATE "notification_schema"."notifications"
            SET "delivery" = (COALESCE("delivery", '{}'::jsonb) - 'telegram_error') || $2::jsonb
          WHERE "id" = ANY($1::bigint[])
            AND "delivery"->>'telegram' IN ('queued', 'retrying', 'sending')`,
        [notificationIds, JSON.stringify(patch)],
      );
    } catch (error) {
      this.logger.error(
        `telegram_outbox: inbox holati yozilmadi (${notificationIds.length} qator): ${this.transport.describe(error)}`,
      );
    }
  }
}

const rowsOf = <T>(result: unknown): T[] => {
  if (!Array.isArray(result)) return [];
  // pg UPDATE … RETURNING: TypeORM `query` → [rows, count].
  if (Array.isArray(result[0])) return result[0] as T[];
  return result as T[];
};
