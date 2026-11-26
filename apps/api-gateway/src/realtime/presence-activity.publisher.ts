import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { timeout } from 'rxjs';

/**
 * (pe71yf8L) Oxirgi socket uzilgach foydalanuvchi shuncha vaqt «Online»
 * hisoblanadi (faqat KO'RSATISH uchun — `RealtimeGateway.isPresent`). FE
 * socketi access token yangilanganda (soatda ~1) va sahifa qayta
 * yuklanganda uzilib qayta ulanadi — shu oraliqda «Offline» ga sakramasin.
 * Push qarori (`isOnline`, `realtime.presence.check`) bu kutishsiz.
 */
export const PRESENCE_GRACE_MS = 45_000;

const SEEN_TIMEOUT_MS = 5_000;

/**
 * (pe71yf8L) Gateway `/realtime` → identity `user_activity.last_seen_at`:
 * foydalanuvchi online bo'lganda (birinchi socket) va oxirgi socketi
 * uzilganda (`PRESENCE_GRACE_MS` dan keyin, vaqti — uzilish vaqti).
 * Kutilmaydi: xato faqat logga, socket oqimiga ta'sir qilmaydi.
 */
@Injectable()
export class PresenceActivityPublisher {
  private readonly logger = new Logger(PresenceActivityPublisher.name);

  constructor(@Inject('IDENTITY') private readonly identity: ClientProxy) {}

  seen(userId: string, at: Date): void {
    this.identity
      .send(
        { cmd: 'identity.user.activity.seen' },
        { user_id: userId, at: at.toISOString() },
      )
      .pipe(timeout(SEEN_TIMEOUT_MS))
      .subscribe({
        error: (error: unknown) =>
          this.logger.warn(
            `activity.seen user=${userId} yuborilmadi: ${error instanceof Error ? error.message : String(error)}`,
          ),
      });
  }
}
