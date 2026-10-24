import { Controller, Logger, Optional } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RealtimeGateway } from './realtime.gateway';
import {
  SessionRevocationService,
  isSessionKickReason,
} from '../auth/session-revocation.service';

/**
 * (Elchi Pochta #3, 2026-10-24) identity gateway so'rov yo'lidan TASHQARIDA
 * yopgan sessiyalar (soatlik tozalash `security_reset`, refresh'da aniqlangan
 * xavfsizlik hodisasi, eskirgan qurilma qatori) — gateway navbatiga
 * `client.emit({ cmd: 'auth.sessions.kick' }, { session_ids, reason })`.
 */
export const SESSIONS_KICK_PATTERN = { cmd: 'auth.sessions.kick' } as const;

/** Bitta xabarda ko'pi bilan shuncha sessiya (identity bo'laklab yuboradi). */
const SESSIONS_KICK_MAX_IDS = 1000;

interface RealtimeNotifyPayload {
  event: string;
  payload?: unknown;
  user_id?: string | null;
  role?: string | null;
  broadcast?: boolean;
}

/**
 * RMQ bridge for server → client push. Any service emits
 * `client.emit({ cmd: 'realtime.notify' }, payload)` to the gateway queue and
 * the connected socket.io clients receive it. Event-based (fire-and-forget):
 * a missing/offline recipient is simply a no-op, never an error to the caller.
 */
@Controller()
export class RealtimeController {
  private readonly logger = new Logger(RealtimeController.name);

  constructor(
    private readonly realtime: RealtimeGateway,
    @Optional() private readonly revocation?: SessionRevocationService,
  ) {}

  /**
   * (Elchi Pochta #3, 2026-10-24) identity yopgan sessiyalar: keshda
   * «yopilgan» + socketlariga `auth:session_revoked` va uzish
   * (`kickSessions`). Noma'lum `reason` — `security_reset`. Event
   * (fire-and-forget), har doim ack.
   */
  @EventPattern(SESSIONS_KICK_PATTERN)
  sessionsKick(
    @Payload() data: { session_ids?: unknown; reason?: unknown },
    @Ctx() context: RmqContext,
  ): void {
    try {
      const ids = Array.isArray(data?.session_ids)
        ? data.session_ids.slice(0, SESSIONS_KICK_MAX_IDS)
        : [];
      if (ids.length && this.revocation) {
        this.revocation.kickSessions(
          ids,
          isSessionKickReason(data?.reason) ? data.reason : 'security_reset',
        );
      }
    } catch (err) {
      this.logger.error(
        `auth.sessions.kick failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      const channel = context.getChannelRef() as {
        ack: (msg: unknown) => void;
      };
      channel.ack(context.getMessage());
    }
  }

  /**
   * (7Ec56EIw #4) notification-service push yuborishdan oldin so'raydi:
   * socket ulangan foydalanuvchiga push emas, realtime yetarli. Faqat
   * berilgan id'lardan onlaynlari qaytadi (ro'yxat oshkor qilinmaydi).
   */
  @MessagePattern({ cmd: 'realtime.presence.check' })
  presenceCheck(
    @Payload() data: { user_ids?: unknown },
    @Ctx() context: RmqContext,
  ): { online: string[] } {
    try {
      const ids = Array.isArray(data?.user_ids) ? data.user_ids : [];
      return {
        online: ids
          .slice(0, 5000)
          .map((id) =>
            typeof id === 'string' || typeof id === 'number' ? String(id) : '',
          )
          .filter((id) => id && this.realtime.isOnline(id)),
      };
    } finally {
      const channel = context.getChannelRef() as {
        ack: (msg: unknown) => void;
      };
      channel.ack(context.getMessage());
    }
  }

  @EventPattern({ cmd: 'realtime.notify' })
  notify(
    @Payload() data: RealtimeNotifyPayload,
    @Ctx() context: RmqContext,
  ): void {
    try {
      const event = String(data?.event ?? '').trim();
      if (event) {
        if (data.user_id) {
          this.realtime.pushToUser(String(data.user_id), event, data.payload);
        }
        if (data.role) {
          this.realtime.pushToRole(String(data.role), event, data.payload);
        }
        if (data.broadcast) {
          this.realtime.broadcast(event, data.payload);
        }
      }
    } catch (err) {
      this.logger.error(
        `realtime.notify failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      // Ack the event so it isn't redelivered — delivery to sockets is
      // best-effort and must not block the broker.
      const channel = context.getChannelRef() as {
        ack: (msg: unknown) => void;
      };
      channel.ack(context.getMessage());
    }
  }
}
