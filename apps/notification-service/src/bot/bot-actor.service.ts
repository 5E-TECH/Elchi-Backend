import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { rmqSend } from '@app/common';

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
 * `callback_query.from.id`). FAIL-CLOSED: yechilmasa yoki identity javob
 * bermasa — `null` (hech qanday ma'lumot berilmaydi).
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
      return null;
    }
  }
}
