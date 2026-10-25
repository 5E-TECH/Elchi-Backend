import { Controller, Logger, Optional } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import {
  RealtimeGateway,
  branchRoleRoom,
  roleRoom,
  userRoom,
} from './realtime.gateway';
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

/**
 * (rWdLuoP3, 2026-10-25) Bitta nishon: `user_id` — shu foydalanuvchi;
 * `role` — shu rol (hamma filial); `role` + `branch_id` — faqat shu filialdagi
 * shu rol. `branch_id` rolsiz — e'tiborsiz (butun filialga hodisa yo'q).
 */
export interface RealtimeNotifyTarget {
  user_id?: string | number | null;
  role?: string | null;
  branch_id?: string | number | null;
}

interface RealtimeNotifyPayload {
  event: string;
  payload?: unknown;
  user_id?: string | null;
  role?: string | null;
  broadcast?: boolean;
  /**
   * (rWdLuoP3) Bir nechta nishon — hammasi BITTA emit (bir nechta xonadagi
   * socket hodisani bir marta oladi). `user_id` / `role` bilan birga
   * ishlatmang (ular alohida emit — avvalgidek).
   */
  targets?: RealtimeNotifyTarget[];
}

/** Bitta xabarda ko'pi bilan shuncha nishon. */
export const REALTIME_NOTIFY_MAX_TARGETS = 50;

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ROLE_PATTERN = /^[a-z_]{1,32}$/;

/** Skalyar id (satr/son) → xona qismi; boshqa narsa (obyekt, `:`) — null. */
function roomId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return ROOM_ID_PATTERN.test(text) ? text : null;
}

function roomRole(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const role = value.trim().toLowerCase();
  return ROLE_PATTERN.test(role) ? role : null;
}

/**
 * (rWdLuoP3) `targets` → socket.io xonalari (takrorsiz). Noto'g'ri nishon
 * (yaroqsiz id/rol, rolsiz filial) tashlab yuboriladi — boshqa nishonlarga
 * ta'sir qilmaydi.
 */
export function resolveTargetRooms(targets: unknown): string[] {
  if (!Array.isArray(targets)) return [];
  const rooms = new Set<string>();
  for (const target of targets.slice(0, REALTIME_NOTIFY_MAX_TARGETS)) {
    if (!target || typeof target !== 'object') continue;
    const { user_id, role, branch_id } = target as RealtimeNotifyTarget;
    const userId = roomId(user_id);
    if (userId) rooms.add(userRoom(userId));
    const roleName = roomRole(role);
    if (!roleName) continue;
    if (branch_id == null || branch_id === '') {
      rooms.add(roleRoom(roleName));
      continue;
    }
    const branchId = roomId(branch_id);
    // Yaroqsiz filial id — rolning HAMMA filialiga EMAS, hech kimga.
    if (branchId) rooms.add(branchRoleRoom(branchId, roleName));
  }
  return [...rooms];
}

/**
 * RMQ bridge for server → client push. Any service emits
 * `client.emit({ cmd: 'realtime.notify' }, payload)` to the gateway queue and
 * the connected socket.io clients receive it. Event-based (fire-and-forget):
 * a missing/offline recipient is simply a no-op, never an error to the caller.
 *
 * (rWdLuoP3, 2026-10-25) `targets` — filial doirasidagi nishonlar
 * (`role` + `branch_id`) va bir nechta nishonga bitta emit; finance-service
 * smena / kassa kartasi hodisalari shu yo'l bilan (outbox orqali) keladi.
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
        const rooms = resolveTargetRooms(data.targets);
        if (rooms.length) {
          this.realtime.pushToRooms(rooms, event, data.payload);
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
