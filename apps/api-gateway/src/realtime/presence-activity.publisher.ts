import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';

/**
 * (pe71yf8L) Oxirgi socket uzilgach foydalanuvchi shuncha vaqt «Online»
 * hisoblanadi (faqat KO'RSATISH uchun — `RealtimeGateway.isPresent`). FE
 * socketi access token yangilanganda (soatda ~1) va sahifa qayta
 * yuklanganda uzilib qayta ulanadi — shu oraliqda «Offline» ga sakramasin.
 * Push qarori (`isOnline`, `realtime.presence.check`) bu kutishsiz.
 */
export const PRESENCE_GRACE_MS = 45_000;

const SEEN_TIMEOUT_MS = 5_000;

/** Modul yopilayotganda yozuvlarni kutish chegarasi (deploy to'xtab qolmasin). */
export const PRESENCE_FLUSH_TIMEOUT_MS = 3_000;

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
    void this.send(userId, at, SEEN_TIMEOUT_MS);
  }

  /**
   * Gateway yopilmoqda (deploy / qayta ishga tushish): kutilayotgan
   * uzilishlar va hali ulangan foydalanuvchilar `last_seen_at` i shu yerda
   * yoziladi — aks holda unref qilingan taymerlar bilan birga yo'qoladi.
   * Javoblar ko'pi bilan `PRESENCE_FLUSH_TIMEOUT_MS` kutiladi; xato
   * otilmaydi.
   */
  async flush(entries: ReadonlyArray<{ userId: string; at: Date }>) {
    await Promise.all(
      entries.map(({ userId, at }) =>
        this.send(userId, at, PRESENCE_FLUSH_TIMEOUT_MS),
      ),
    );
  }

  private async send(userId: string, at: Date, ms: number): Promise<void> {
    try {
      await lastValueFrom(
        this.identity
          .send(
            { cmd: 'identity.user.activity.seen' },
            { user_id: userId, at: at.toISOString() },
          )
          .pipe(timeout(ms)),
        { defaultValue: undefined },
      );
    } catch (error) {
      this.logger.warn(
        `activity.seen user=${userId} yuborilmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
