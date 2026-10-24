import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';

/**
 * (Elchi Pochta #3, 2026-10-24) gateway navbatidagi pattern — gateway
 * `RealtimeController.sessionsKick` qabul qiladi (`realtime.notify` bilan
 * bir xil yo'l).
 */
export const SESSIONS_KICK_PATTERN = { cmd: 'auth.sessions.kick' } as const;

/** Bitta xabarda ko'pi bilan shuncha id (gateway ham shu chegarani qo'yadi). */
export const SESSIONS_KICK_CHUNK = 500;

/** Sekin / javobsiz broker chaqiruvchini (cron, refresh) to'xtatmasin. */
const SESSIONS_KICK_TIMEOUT_MS = 2_000;

/**
 * (Elchi Pochta #3, 2026-10-24) identity gateway SO'ROV YO'LIDAN TASHQARIDA
 * yopgan sessiyalarni gateway'ga e'lon qiladi — o'sha qurilmalarning ochiq
 * socketlari `auth:session_revoked` (`security_reset`) olib shu zahoti
 * uziladi, access tokeni ham shu gateway keshida darhol «yopilgan»:
 *
 *  - soatlik tozalash (`AuthSessionService.cleanup`) — epoch'i eskirgan
 *    (parol/telefon/rol almashgan, bloklangan, o'chirilgan) ochiq qatorlar;
 *  - refresh'da aniqlangan xavfsizlik hodisasi (`revokeOwn` +
 *    `security_reset`);
 *  - qurilma qayta kirganda epoch'i eskirgan eski qatori.
 *
 * Revoke endpointlari, logout va parol almashtirish bu yerdan O'TMAYDI —
 * ular id larni javobda qaytaradi, gateway o'zi chiqaradi.
 *
 * Fire-and-forget: `RABBITMQ_GATEWAY_QUEUE` sozlanmagan bo'lsa — hech
 * narsa; broker xatosi — faqat ogohlantirish (sessiya baribir yopilgan,
 * HTTP'da ≤ 30 soniyada 401).
 */
@Injectable()
export class SessionKickPublisher {
  private readonly logger = new Logger(SessionKickPublisher.name);
  private readonly enabled: boolean;

  constructor(
    @Optional()
    @Inject('GATEWAY')
    private readonly gateway?: ClientProxy,
    @Optional() config?: ConfigService,
  ) {
    this.enabled = Boolean(
      gateway && String(config?.get('RABBITMQ_GATEWAY_QUEUE') ?? '').trim(),
    );
  }

  /** Kutilmaydi (xatosi ham chaqiruvchiga chiqmaydi). */
  publish(sessionIds: readonly string[], reason: 'security_reset'): void {
    void this.send(sessionIds, reason);
  }

  /** Spec'lar uchun kutiladigan variant. */
  async send(
    sessionIds: readonly string[],
    reason: 'security_reset',
  ): Promise<void> {
    if (!this.enabled || !this.gateway) return;
    const ids = [
      ...new Set(
        sessionIds
          .filter((id) => typeof id === 'string' && id)
          .map((id) => id.toLowerCase()),
      ),
    ];
    for (let start = 0; start < ids.length; start += SESSIONS_KICK_CHUNK) {
      const chunk = ids.slice(start, start + SESSIONS_KICK_CHUNK);
      try {
        await lastValueFrom(
          this.gateway
            .emit(SESSIONS_KICK_PATTERN, { session_ids: chunk, reason })
            .pipe(timeout(SESSIONS_KICK_TIMEOUT_MS)),
          { defaultValue: null },
        );
      } catch (error) {
        this.logger.warn(
          `auth.sessions.kick yuborilmadi (${chunk.length} ta, ${reason}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
