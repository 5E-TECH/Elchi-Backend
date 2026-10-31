import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramBotAction } from '../entities/telegram-bot-action.entity';
import { TELEGRAM_LIMITS, utf8Bytes } from './bot-transport.service';
import { assertNoPii } from './bot-session.service';

/** `callback_data` = `a:<16 belgi>` — 18 bayt, 64 bayt chegarasidan ancha past. */
export const ACTION_CALLBACK_RE = /^a:([A-Za-z0-9_-]{16})$/;
/** Sukut: tugma 24 soat yashaydi. */
export const BOT_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export type ActionLookup =
  | { status: 'ok'; action: TelegramBotAction }
  | { status: 'expired' | 'consumed'; action: TelegramBotAction }
  | { status: 'unknown' };

export interface CreateActionInput {
  chatId: string;
  action: string;
  actorUserId?: string | null;
  orderId?: string | null;
  payload?: Record<string, unknown>;
  oneShot?: boolean;
  ttlMs?: number;
}

export function newActionId(): string {
  return randomBytes(12).toString('base64url');
}

/**
 * (Pq2dFj8A / UQlmQiGT #3) Inline tugma holati DB'da: `callback_data` faqat
 * `a:<action_id>`, qolgan hammasi `telegram_bot_actions` qatoridan. Restart
 * yoki boshqa replika tugmani "o'ldirmaydi".
 */
@Injectable()
export class BotActionsService {
  now: () => Date = () => new Date();

  constructor(
    @InjectRepository(TelegramBotAction)
    private readonly actions: Repository<TelegramBotAction>,
  ) {}

  /** Yangi amal → `callback_data` (`a:<id>`). Payload'da PII bo'lmaydi. */
  async create(input: CreateActionInput): Promise<string> {
    const payload = input.payload ?? {};
    assertNoPii(payload, 'payload');
    const actionId = newActionId();
    await this.actions.insert({
      action_id: actionId,
      chat_id: input.chatId,
      action: input.action,
      actor_user_id: input.actorUserId ?? null,
      order_id: input.orderId ?? null,
      payload: payload as never,
      one_shot: input.oneShot ?? true,
      expires_at: new Date(
        this.now().getTime() + (input.ttlMs ?? BOT_ACTION_TTL_MS),
      ),
      consumed_at: null,
      message_id: null,
    });
    const data = `a:${actionId}`;
    if (utf8Bytes(data) > TELEGRAM_LIMITS.CALLBACK_DATA_MAX_BYTES) {
      throw new Error('callback_data 64 baytdan oshdi');
    }
    return data;
  }

  /** `callback_data` → amal holati (o'qish, band qilmaydi). */
  async lookup(callbackData: string | undefined): Promise<ActionLookup> {
    const match = ACTION_CALLBACK_RE.exec(String(callbackData ?? ''));
    if (!match) return { status: 'unknown' };
    const action = await this.actions.findOne({
      where: { action_id: match[1] },
    });
    if (!action) return { status: 'unknown' };
    if (action.consumed_at) return { status: 'consumed', action };
    if (action.expires_at.getTime() <= this.now().getTime()) {
      return { status: 'expired', action };
    }
    return { status: 'ok', action };
  }

  /**
   * Bir martalik amalni ATOMIK band qiladi (`consumed_at IS NULL AND
   * expires_at > now()`). Ikki marta bosishda faqat bittasi `true` oladi.
   */
  async consume(actionId: string): Promise<boolean> {
    const result = await this.actions
      .createQueryBuilder()
      .update(TelegramBotAction)
      .set({ consumed_at: this.now() })
      .where(
        'action_id = :actionId AND consumed_at IS NULL AND expires_at > :now',
        { actionId, now: this.now() },
      )
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /**
   * (BOT-3d) Handler xato berdi — bir martalik tugma qayta ochiladi (amal
   * bajarilmagan; «✅ Ha» ni qayta bosish ishlaydi). Muddati o'tgan tugma
   * ochilmaydi.
   */
  async release(actionId: string): Promise<void> {
    await this.actions
      .createQueryBuilder()
      .update(TelegramBotAction)
      .set({ consumed_at: null })
      .where('action_id = :actionId AND expires_at > :now', {
        actionId,
        now: this.now(),
      })
      .execute();
  }

  /** Tugmalar yuborilgan xabar id'si (keyin tahrirlash uchun). */
  async attachMessage(callbackData: string[], messageId: number | string) {
    const ids = callbackData
      .map((data) => ACTION_CALLBACK_RE.exec(data)?.[1])
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return;
    await this.actions
      .createQueryBuilder()
      .update(TelegramBotAction)
      .set({ message_id: String(messageId) })
      .whereInIds(ids)
      .execute();
  }
}
