import { Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import {
  SessionKickReason,
  SessionRevocationService,
  sessionIdClaim,
} from '../auth/session-revocation.service';

interface SocketUser {
  sub: string;
  username?: string;
  roles: string[];
  branch_id?: string | null;
  /** (Elchi Pochta #3) Access token `sid` i; Telegram / eski tokenlarda `null`. */
  sid: string | null;
}

/** (Elchi Pochta #3, 2026-10-24) Sessiya yopilganda socketga hodisa. */
export const SESSION_REVOKED_EVENT = 'auth:session_revoked';

/**
 * `auth:session_revoked` emit qilingandan keyin socketlar shuncha ms o'tib
 * uziladi — hodisa mijozga albatta yetib borsin (emit va uzish bir tick'da
 * bo'lmasin; polling transportida ham navbatdagi javobda keladi).
 */
export const SESSION_KICK_DISCONNECT_DELAY_MS = 250;

/** Sessiya xonasi: shu sessiya (`sid`) bilan ulangan barcha tab/socketlar. */
export const sessionRoom = (sessionId: string): string =>
  `session:${sessionId.toLowerCase()}`;

/** Foydalanuvchining barcha tab/qurilmalari. */
export const userRoom = (userId: string): string => `user:${userId}`;

/** Rol xonasi — shu roldagi HAMMA foydalanuvchi (filialdan qat'i nazar). */
export const roleRoom = (role: string): string =>
  `role:${String(role).toLowerCase()}`;

/**
 * (rWdLuoP3, 2026-10-25) Filial + rol xonasi: faqat shu filialdagi shu roldagi
 * foydalanuvchilar (masalan filial kassasi smenasi — o'sha filial
 * menejerlari). Socket JWT'dagi `branch_id` bo'yicha kiradi; `branch_id`
 * siz token (superadmin/admin, filial topilmagan) hech qaysi filial xonasiga
 * kirmaydi — boshqa filial hodisasi unga yetmaydi.
 */
export const branchRoleRoom = (branchId: string, role: string): string =>
  `branch:${branchId}:role:${String(role).toLowerCase()}`;

/** Ulanish rad etilganda `error` hodisasi (keyin server uzadi). */
export interface RealtimeConnectError {
  message: string;
  code: 'UNAUTHORIZED' | 'SESSION_REVOKED';
}

/**
 * Realtime gateway (socket.io). Two purposes only (per product decision):
 *   1. server → client notifications, pushed from any service via the
 *      `realtime.notify` RMQ message (see realtime.controller.ts),
 *   2. online client ↔ client messaging (simple chat relay).
 *
 * Every connection is JWT-authenticated with the same ACCESS_TOKEN_KEY the HTTP
 * guards use. On connect the socket joins `user:<sub>` and `role:<role>` rooms,
 * which the push methods target. (rWdLuoP3) JWT'da `branch_id` bo'lsa —
 * qo'shimcha `branch:<branch_id>:role:<role>` (filial doirasidagi hodisalar:
 * filial kassasi smenasi faqat o'sha filial menejerlariga).
 *
 * (Elchi Pochta #3, 2026-10-24) Sessiyalar: `sid` li token bilan ulanish
 * HTTP bilan BIR XIL qoida bo'yicha tekshiriladi (`SessionRevocationService`
 * — kesh / identity `session_state`, identity javob bermasa fail open):
 * yopilgan sessiya → `error` `{ code: 'SESSION_REVOKED' }` va uziladi
 * (chiqarilgan qurilma eski token bilan qayta ulana olmaydi). Ochiq sessiya
 * socketi qo'shimcha `session:<sid>` xonasiga kiradi; sessiya yopilganda
 * (`SessionRevocationService.kickSessions`) shu xonaga `auth:session_revoked`
 * `{ session_id, reason }` ketadi va 250 ms dan keyin socketlar server
 * tomonidan uziladi. `sid` siz tokenlar avvalgidek.
 */
@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server!: Server;

  // userId -> set of live socket ids (a user may have several tabs/devices).
  private readonly online = new Map<string, Set<string>>();

  /** Kutilayotgan (emit'dan keyingi) uzishlar — modul yopilganda tozalanadi. */
  private readonly pendingKicks = new Set<ReturnType<typeof setTimeout>>();
  private readonly unsubscribeKicks?: () => void;

  constructor(
    private readonly jwtService: JwtService,
    /**
     * (Elchi Pochta #3) Ixtiyoriy — spec'lar gateway'ni usiz quradi; u holda
     * sessiya tekshiruvi va chiqarish yo'q (avvalgidek faqat imzo/muddat).
     */
    @Optional() private readonly revocation?: SessionRevocationService,
  ) {
    this.unsubscribeKicks = revocation?.onKick((ids, reason) =>
      this.disconnectSessions(ids, reason),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribeKicks?.();
    for (const timer of this.pendingKicks) clearTimeout(timer);
    this.pendingKicks.clear();
  }

  private getUser(client: Socket): SocketUser | undefined {
    return (client.data as { user?: SocketUser }).user;
  }

  async handleConnection(client: Socket): Promise<void> {
    const user = this.authenticate(client);
    if (!user) {
      this.reject(client, { message: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    if (user.sid) {
      // (Elchi Pochta #3) Avval FAQAT sessiya xonasi: tekshiruv davomida
      // kelgan chiqarish (`kickSessions`) ham bu socketga yetadi. `user:` /
      // `role:` xonalari — tekshiruvdan keyin (yopilgan sessiya bildirishnoma
      // olmasin).
      await client.join(sessionRoom(user.sid));
      if (await this.isSessionRevoked(user.sub, user.sid)) {
        this.reject(client, {
          message: 'Session revoked',
          code: 'SESSION_REVOKED',
        });
        this.logger.log(
          `socket rejected: user=${user.sub} session revoked (${user.sid})`,
        );
        return;
      }
      // Tekshiruv davomida chiqarilgan yoki mijoz o'zi uzilgan.
      if (client.disconnected) return;
    }

    (client.data as { user?: SocketUser }).user = user;
    void client.join(userRoom(user.sub));
    for (const role of user.roles) {
      void client.join(roleRoom(role));
    }
    // (rWdLuoP3) Filial doirasidagi hodisalar (filial kassasi smenasi).
    if (user.branch_id) {
      for (const role of user.roles) {
        void client.join(branchRoleRoom(user.branch_id, role));
      }
    }

    const set = this.online.get(user.sub) ?? new Set<string>();
    set.add(client.id);
    this.online.set(user.sub, set);

    client.emit('connected', {
      user_id: user.sub,
      roles: user.roles,
      session_id: user.sid,
    });
    this.logger.log(`socket connected: user=${user.sub}`);
  }

  /** Rad etish: `error` hodisasi, keyin server uzadi (hodisa avval yetadi). */
  private reject(client: Socket, error: RealtimeConnectError): void {
    client.emit('error', error);
    client.disconnect(true);
  }

  /** HTTP `JwtStrategy` bilan bir xil: identity javob bermasa — ruxsat. */
  private async isSessionRevoked(
    userId: string,
    sessionId: string,
  ): Promise<boolean> {
    if (!this.revocation) return false;
    try {
      return await this.revocation.isRevoked(userId, sessionId);
    } catch {
      return false;
    }
  }

  /**
   * (Elchi Pochta #3, 2026-10-24) `SessionRevocationService.kickSessions`
   * tinglovchisi: har sessiya xonasiga `auth:session_revoked`
   * `{ session_id, reason }`, keyin SESSION_KICK_DISCONNECT_DELAY_MS dan
   * so'ng o'sha xonalardagi socketlar server tomonidan uziladi
   * (`disconnectSockets(true)` — mijoz «io server disconnect» oladi va o'zi
   * qayta ulanmaydi; ulansa ham rad etiladi). Boshqa sessiyalar socketlariga
   * tegilmaydi. Socket server hali yo'q bo'lsa — hech narsa.
   */
  disconnectSessions(sessionIds: string[], reason: SessionKickReason): void {
    const server = this.server;
    if (!server || !sessionIds.length) return;
    const rooms = sessionIds.map(sessionRoom);
    for (const sessionId of sessionIds) {
      server.to(sessionRoom(sessionId)).emit(SESSION_REVOKED_EVENT, {
        session_id: sessionId.toLowerCase(),
        reason,
      });
    }
    const timer = setTimeout(() => {
      this.pendingKicks.delete(timer);
      try {
        server.in(rooms).disconnectSockets(true);
      } catch (error) {
        this.logger.warn(
          `session sockets disconnect failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, SESSION_KICK_DISCONNECT_DELAY_MS);
    timer.unref?.();
    this.pendingKicks.add(timer);
    this.logger.log(
      `sessions kicked (${reason}): ${sessionIds.length} — ${sessionIds.join(', ')}`,
    );
  }

  handleDisconnect(client: Socket) {
    const user = this.getUser(client);
    if (!user) return;
    const set = this.online.get(user.sub);
    if (set) {
      set.delete(client.id);
      if (!set.size) {
        this.online.delete(user.sub);
      }
    }
  }

  private authenticate(client: Socket): SocketUser | null {
    try {
      const raw =
        (client.handshake.auth?.token as string | undefined) ??
        this.bearerFromHeader(client.handshake.headers.authorization);
      if (!raw) return null;
      const payload = this.jwtService.verify<{
        sub: string;
        username?: string;
        roles?: string[];
        branch_id?: string | number | null;
        sid?: string | null;
      }>(raw);
      const branchId =
        payload.branch_id == null ? '' : String(payload.branch_id).trim();
      return {
        sub: String(payload.sub),
        username: payload.username,
        roles: (payload.roles ?? []).map((r) => String(r).toLowerCase()),
        branch_id: branchId || null,
        sid: sessionIdClaim(payload.sid),
      };
    } catch {
      return null;
    }
  }

  private bearerFromHeader(header?: string): string | undefined {
    if (!header) return undefined;
    const [scheme, token] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' ? token : undefined;
  }

  // ===== client → client messaging =====

  @SubscribeMessage('chat:send')
  handleChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { to_user_id?: string; text?: string },
  ): { ok: boolean; error?: string } {
    const user = this.getUser(client);
    if (!user) return { ok: false, error: 'unauthorized' };
    const to = String(body?.to_user_id ?? '').trim();
    const text = String(body?.text ?? '').trim();
    if (!to || !text)
      return { ok: false, error: 'to_user_id and text required' };

    const message = {
      from_user_id: user.sub,
      to_user_id: to,
      text,
      ts: Date.now(),
    };
    // deliver to recipient's room and echo back to the sender's other tabs
    this.server.to(`user:${to}`).emit('chat:message', message);
    this.server.to(`user:${user.sub}`).emit('chat:message', message);
    return { ok: true };
  }

  @SubscribeMessage('presence:list')
  handlePresence(@ConnectedSocket() client: Socket): {
    online_user_ids: string[];
  } {
    // (Elchi Pochta #3) Sessiya tekshiruvi tugamagan / rad etilgan socket
    // ro'yxatni olmaydi.
    if (!this.getUser(client)) return { online_user_ids: [] };
    return { online_user_ids: [...this.online.keys()] };
  }

  // ===== server → client push (called by realtime.controller) =====

  pushToUser(userId: string, event: string, data: unknown): void {
    this.server.to(userRoom(userId)).emit(event, data);
  }

  pushToRole(role: string, event: string, data: unknown): void {
    this.server.to(roleRoom(role)).emit(event, data);
  }

  /**
   * (rWdLuoP3) Bir nechta xonaga BITTA emit: bir nechta xonada turgan socket
   * (masalan `user:<id>` va `role:admin`) hodisani bir marta oladi.
   */
  pushToRooms(rooms: readonly string[], event: string, data: unknown): void {
    if (!this.server || !rooms.length) return;
    this.server.to([...rooms]).emit(event, data);
  }

  broadcast(event: string, data: unknown): void {
    this.server.emit(event, data);
  }

  isOnline(userId: string): boolean {
    return this.online.has(String(userId));
  }
}
