import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { rmqSend } from '@app/common';

/** identity ichki pattern'i: `{ user_id, telegram_id, role }` → `{ active }`. */
export const TELEGRAM_TOKEN_STATE_PATTERN = {
  cmd: 'identity.auth.telegram_token_state',
} as const;

/** Natija shuncha saqlanadi — nofaol / uzilgan xodim tokeni ≤ 60 s da 401. */
export const TELEGRAM_TOKEN_STATE_TTL_MS = 60_000;
/** identity javob bermasa — «noma'lum» shuncha saqlanadi (fail closed, 503). */
export const TELEGRAM_TOKEN_UNKNOWN_TTL_MS = 5_000;
/**
 * identity javob bermaganda yaqinda «faol» tasdiqlangan token o'tadi —
 * lekin TTL dan uzoq EMAS: «nofaol / uzilgan xodim ≤ 60 s da 401» kontrakti
 * identity sekin bo'lganda ham buzilmaydi.
 */
export const TELEGRAM_TOKEN_ACTIVE_GRACE_MS = TELEGRAM_TOKEN_STATE_TTL_MS;
const TELEGRAM_TOKEN_STATE_TIMEOUT_MS = 1_500;
const TELEGRAM_TOKEN_CACHE_MAX = 10_000;

export type TelegramTokenState = 'active' | 'revoked' | 'unknown';

interface Entry {
  state: TelegramTokenState;
  until: number;
}

/**
 * (BOT-2 #2c) Telegram tokeni (Mini App va bot aktori, `auth: 'telegram'`)
 * `sid` siz — sessiya emas, shuning uchun ilgari umuman tekshirilmasdi:
 * nofaol qilingan yoki Telegram'ni uzgan xodim tokeni 30 daqiqa ishlayverardi.
 * Endi har so'rovda identity'dan (≤60 s kesh): xodim faol, roli tokendagidek
 * va Telegram hamon SHU `tg_id` ga ulangan. Bir xil kalitning bir vaqtdagi
 * so'rovlari bitta RMQ chaqiruvini kutadi.
 */
@Injectable()
export class TelegramTokenStateService {
  private readonly logger = new Logger(TelegramTokenStateService.name);
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<TelegramTokenState>>();
  private readonly lastActiveAt = new Map<string, number>();

  /** Soat — spec'lar vaqtni boshqarishi uchun. */
  now: () => number = () => Date.now();

  constructor(@Inject('IDENTITY') private readonly identity: ClientProxy) {}

  async state(input: {
    userId: string;
    telegramId: string | null;
    role: string | null;
  }): Promise<TelegramTokenState> {
    const key = `${input.userId}|${input.telegramId ?? ''}|${input.role ?? ''}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > this.now()) return cached.state;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.lookup(key, input).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async lookup(
    key: string,
    input: { userId: string; telegramId: string | null; role: string | null },
  ): Promise<TelegramTokenState> {
    let state: TelegramTokenState;
    try {
      const res = await rmqSend<{ active?: unknown }>(
        this.identity,
        TELEGRAM_TOKEN_STATE_PATTERN,
        {
          user_id: input.userId,
          telegram_id: input.telegramId,
          role: input.role,
        },
        {
          timeoutMs: TELEGRAM_TOKEN_STATE_TIMEOUT_MS,
          retries: 1,
          attachRequestId: false,
        },
      );
      state = res?.active === true ? 'active' : 'revoked';
    } catch (error) {
      this.logger.warn(
        `Telegram token holatini tekshirib bo'lmadi: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const last = this.lastActiveAt.get(key) ?? 0;
      state =
        last && this.now() - last <= TELEGRAM_TOKEN_ACTIVE_GRACE_MS
          ? 'active'
          : 'unknown';
      this.write(key, state, TELEGRAM_TOKEN_UNKNOWN_TTL_MS);
      return state;
    }
    // delete + set: Map oxiriga ko'chadi — hajm chegarasida eng ESKI chiqadi.
    this.lastActiveAt.delete(key);
    if (state === 'active') this.lastActiveAt.set(key, this.now());
    this.write(key, state, TELEGRAM_TOKEN_STATE_TTL_MS);
    return state;
  }

  private write(key: string, state: TelegramTokenState, ttl: number): void {
    if (this.cache.size >= TELEGRAM_TOKEN_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    if (this.lastActiveAt.size >= TELEGRAM_TOKEN_CACHE_MAX) {
      const oldest = this.lastActiveAt.keys().next().value;
      if (oldest !== undefined) this.lastActiveAt.delete(oldest);
    }
    this.cache.delete(key);
    this.cache.set(key, { state, until: this.now() + ttl });
  }
}
