import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TelegramLinkToken,
  type TelegramLinkPurpose,
  type TelegramLinkScope,
} from '../entities/telegram-link-token.entity';

/** (6jXw0DDr #5) TTL — 10 daqiqa, bir martalik. */
export const LINK_TOKEN_TTL_MS = 10 * 60_000;
/** randomBytes(32) → base64url, 43 belgi (Telegram `start` parametri ≤64, [A-Za-z0-9_-]). */
export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const hashLinkToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export interface IssueLinkTokenInput {
  purpose: TelegramLinkPurpose;
  owner_type: string;
  owner_id: string;
  group_type?: string | null;
  created_by?: string | null;
  created_ip?: string | null;
}

export type LinkClaim =
  | { status: 'ok'; token: TelegramLinkToken }
  | { status: 'invalid' | 'used' | 'expired' | 'wrong_scope' };

/**
 * (6jXw0DDr / 4TfLyTrL / 9uNhwTZp) Bir martalik bog'lash kodlari:
 * `issue` — panel (JWT) so'raydi; `claim` — bot `/start <kod>` da ATOMIK
 * band qiladi (`used_at IS NULL AND expires_at > now()`), ikki parallel
 * urinishdan faqat bittasi `ok` oladi. Kodning o'zi DB'da saqlanmaydi.
 */
@Injectable()
export class TelegramLinkService {
  now: () => Date = () => new Date();

  constructor(
    @InjectRepository(TelegramLinkToken)
    private readonly tokens: Repository<TelegramLinkToken>,
  ) {}

  async issue(
    input: IssueLinkTokenInput,
  ): Promise<{ token: string; expires_at: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + LINK_TOKEN_TTL_MS);
    await this.tokens.insert({
      token_hash: hashLinkToken(token),
      purpose: input.purpose,
      owner_type: input.owner_type,
      owner_id: input.owner_id,
      chat_scope: input.purpose === 'market_group' ? 'group' : 'private',
      group_type: input.group_type ?? null,
      expires_at: expiresAt,
      used_at: null,
      used_chat_id: null,
      created_by: input.created_by ?? null,
      created_ip: input.created_ip ? input.created_ip.slice(0, 64) : null,
      isDeleted: false,
    });
    return { token, expires_at: expiresAt };
  }

  async claim(
    token: string,
    scope: TelegramLinkScope,
    chatId: string,
  ): Promise<LinkClaim> {
    const value = String(token ?? '').trim();
    if (!LINK_TOKEN_RE.test(value)) return { status: 'invalid' };
    const hash = hashLinkToken(value);
    const rows: unknown = await this.tokens.query(
      `UPDATE "notification_schema"."telegram_link_tokens"
          SET "used_at" = now(), "used_chat_id" = $3
        WHERE "token_hash" = $1
          AND "chat_scope" = $2
          AND "used_at" IS NULL
          AND "expires_at" > now()
          AND "is_deleted" = false
      RETURNING "token_hash", "purpose", "owner_type", "owner_id",
                "chat_scope", "group_type", "created_by"`,
      [hash, scope, chatId],
    );
    const claimed = firstRow<TelegramLinkToken>(rows);
    if (claimed) return { status: 'ok', token: claimed };

    const existing = await this.tokens.findOne({
      where: { token_hash: hash, isDeleted: false },
    });
    if (!existing) return { status: 'invalid' };
    if (existing.used_at) return { status: 'used' };
    if (existing.expires_at.getTime() <= this.now().getTime()) {
      return { status: 'expired' };
    }
    return { status: 'wrong_scope' };
  }
}

/** pg `UPDATE … RETURNING` → TypeORM: `[rows, count]` yoki `rows`. */
function firstRow<T>(result: unknown): T | null {
  if (!Array.isArray(result)) return null;
  const rows: unknown = Array.isArray(result[0]) ? result[0] : result;
  return Array.isArray(rows) && rows.length ? (rows[0] as T) : null;
}
