import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { rmqSend } from '@app/common';

/**
 * (BOT-3d) identity-service javob bermadi — odam bog'lanmagan EMAS, tizim
 * vaqtincha ishlamayapti (router aniq matn bilan javob beradi; «avval
 * ulang» deyilmaydi). Ma'lumot baribir berilmaydi (fail-closed).
 */
export class BotIdentityUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      `identity.telegram.resolve javob bermadi: ${cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''}`,
    );
    this.name = 'BotIdentityUnavailableError';
  }
}

export interface BotActor {
  user_id: string;
  role: string;
  status: string;
  market_id: string | null;
  region_id: string | null;
}

/**
 * (3ZfiXuaW #1) Aktor darvozasi: `from.id` → `identity.telegram.resolve` →
 * odam. Huquq CHAT bo'yicha emas, ODAM bo'yicha (guruhdagi tugmada ham
 * `callback_query.from.id`). FAIL-CLOSED: yechilmasa — `null`; identity
 * javob bermasa — `BotIdentityUnavailableError` (BOT-3d: «avval ulang» emas,
 * «tizim vaqtincha ishlamayapti»; hech qanday ma'lumot berilmaydi).
 *
 * Kesh YO'Q: rol/holat o'zgarishi (bloklash, rol almashishi) darhol amal
 * qiladi; bog'lanish manbai — `users.telegram_id` (restartdan keyin ham).
 */
@Injectable()
export class BotActorService {
  private readonly logger = new Logger(BotActorService.name);

  constructor(@Inject('IDENTITY') private readonly identity: ClientProxy) {}

  async resolve(fromId: string | null | undefined): Promise<BotActor | null> {
    const id = String(fromId ?? '').trim();
    if (!/^\d{1,20}$/.test(id)) return null;
    try {
      const response = await rmqSend<{ data?: BotActor | null }>(
        this.identity,
        { cmd: 'identity.telegram.resolve' },
        { telegram_id: id },
        { timeoutMs: 5_000, retries: 1 },
      );
      const actor = response?.data ?? null;
      return actor?.user_id ? actor : null;
    } catch (error) {
      this.logger.warn(
        `identity.telegram.resolve javob bermadi — fail-closed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BotIdentityUnavailableError(error);
    }
  }
}
