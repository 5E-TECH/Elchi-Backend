import { Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import {
  SESSION_CHECK_UNAVAILABLE,
  SessionKickReason,
  SessionRevocationService,
  type SessionState,
  sessionIdClaim,
} from '../auth/session-revocation.service';
import type { IncomingMessage } from 'http';
import { corsOriginCallback, isAllowedCorsOrigin } from '../gateway-http.setup';

interface SocketUser {
  sub: string;
  username?: string;
  roles: string[];
  branch_id?: string | null;
  /** (Elchi Pochta #3) Access token `sid` i; Telegram / eski tokenlarda `null`. */
  sid: string | null;
  /** (oFfOWGuo) JWT `exp` (unix soniya) — shu paytda socket uziladi. */
  exp?: number;
}

/**
 * (oFfOWGuo) setTimeout chegarasi (~24.8 kun); undan uzoq `exp` — taymer
 * zanjiri bilan.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** (Elchi Pochta #3, 2026-10-24) Sessiya yopilganda socketga hodisa. */
export const SESSION_REVOKED_EVENT = 'auth:session_revoked';

/**
 * `auth:session_revoked` emit qilingandan keyin socketlar shuncha ms o'tib
 * uziladi — hodisa mijozga albatta yetib borsin (emit va uzish bir tick'da
 * bo'lmasin; polling transportida ham navbatdagi javobda keladi).
 */
export const SESSION_KICK_DISCONNECT_DELAY_MS = 250;

/**
 * (2026-10-26) identity javob bermay (va 5 daqiqalik «oxirgi tasdiq»
 * muhlati ham yo'q — masalan gateway endigina qayta ishga tushgan) ulangan
 * socket shuncha ms dan keyin qayta tekshiriladi: yopilgan bo'lsa uziladi,
 * identity hali ham javob bermasa — yana shuncha kutiladi.
 */
export const SESSION_RECHECK_DELAY_MS = 30_000;

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
  code:
    | 'UNAUTHORIZED'
    | 'SESSION_REVOKED'
    | 'TOKEN_EXPIRED'
    | typeof SESSION_CHECK_UNAVAILABLE;
}

/**
 * (oFfOWGuo) socket.io `allowRequest`: Origin — HTTP CORS bilan bir xil
 * qoida (`CORS_ORIGINS`; localhost faqat dev'da; Origin'siz — ruxsat).
 */
export function realtimeAllowRequest(
  req: Pick<IncomingMessage, 'headers'>,
  callback: (err: string | null | undefined, success: boolean) => void,
): void {
  const allowed = isAllowedCorsOrigin(req.headers.origin);
  callback(allowed ? null : 'origin not allowed', allowed);
}

/**
 * Realtime gateway (socket.io) — FAQAT server → client bildirishnomalar
 * (any service pushes via the `realtime.notify` RMQ message, see
 * realtime.controller.ts). (oFfOWGuo, xavfsizlik P2) client → client
 * `chat:send` (istalgan userga cheksiz matn) va `presence:list` (online
 * id'lar ro'yxati) OLIB TASHLANDI — Elchi-Frontend ularni ishlatmaydi.
 * CORS — HTTP bilan BIR XIL `CORS_ORIGINS` qoidasi (ilgari `origin: true`).
 * Token muddati (`exp`) tugaganda socket `error` `{ code: 'TOKEN_EXPIRED' }`
 * bilan uziladi — FE yangilangan token bilan qayta ulanadi.
 *
 * Every connection is JWT-authenticated with the same ACCESS_TOKEN_KEY the HTTP
 * guards use. On connect the socket joins `user:<sub>` and `role:<role>` rooms,
 * which the push methods target. (rWdLuoP3) JWT'da `branch_id` bo'lsa —
 * qo'shimcha `branch:<branch_id>:role:<role>` (filial doirasidagi hodisalar:
 * filial kassasi smenasi faqat o'sha filial menejerlariga).
 *
 * (Elchi Pochta #3, 2026-10-24) Sessiyalar: `sid` li token bilan ulanish
 * HTTP bilan BIR XIL qoida bo'yicha tekshiriladi (`SessionRevocationService`
 * — kesh / identity `session_state`; identity javob bermasa: 5 daqiqa ichida
 * tasdiqlangan sessiya o'tadi, aks holda socket qabul qilinib 30 s dan keyin
 * qayta tekshiriladi):
 * yopilgan sessiya → `error` `{ code: 'SESSION_REVOKED' }` va uziladi
 * (chiqarilgan qurilma eski token bilan qayta ulana olmaydi). Ochiq sessiya
 * socketi qo'shimcha `session:<sid>` xonasiga kiradi; sessiya yopilganda
 * (`SessionRevocationService.kickSessions`) shu xonaga `auth:session_revoked`
 * `{ session_id, reason }` ketadi va 250 ms dan keyin socketlar server
 * tomonidan uziladi. `sid` siz tokenlar avvalgidek.
 */
@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: corsOriginCallback, credentials: true },
  // (oFfOWGuo) `cors` faqat polling so'rovlariga ta'sir qiladi; WebSocket
  // upgrade'da brauzer CORS'ni tekshirmaydi — Origin shu yerda ham
  // `CORS_ORIGINS` bo'yicha tekshiriladi (Origin'siz mijoz — ruxsat).
  allowRequest: realtimeAllowRequest,
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
  /** (2026-10-26) socket id → sessiyani qayta tekshirish taymeri. */
  private readonly sessionRechecks = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** (oFfOWGuo) socket id → token muddati (`exp`) taymeri. */
  private readonly tokenExpiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
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
    for (const timer of this.sessionRechecks.values()) clearTimeout(timer);
    this.sessionRechecks.clear();
    for (const timer of this.tokenExpiryTimers.values()) clearTimeout(timer);
    this.tokenExpiryTimers.clear();
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
      const state = await this.sessionState(user.sub, user.sid);
      if (state === 'revoked') {
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
      // (2026-10-26) identity javob bermadi va 5 daqiqalik «oxirgi tasdiq»
      // muhlati ham yo'q (masalan gateway qayta ishga tushgan / deploy).
      // Rad etilsa socket.io o'zi qayta ulanmaydi — shuning uchun socket
      // QABUL QILINADI va SESSION_RECHECK_DELAY_MS dan keyin qayta
      // tekshiriladi: faqat yopilgan bo'lsa uziladi. Yopilish (kick) bu
      // vaqtda ham `session:<sid>` xonasi orqali darhol yetadi.
      if (state === 'unknown') {
        this.logger.warn(
          `socket allowed without session check: user=${user.sub} identity unavailable (${user.sid}), re-check in ${SESSION_RECHECK_DELAY_MS} ms`,
        );
        this.scheduleSessionRecheck(client, user.sub, user.sid);
      }
    }

    (client.data as { user?: SocketUser }).user = user;
    this.scheduleTokenExpiry(client, user);
    if (client.disconnected) return;
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

  /**
   * (2026-10-26) Tekshirilmay qabul qilingan socket sessiyasini keyinroq
   * qayta tekshirish. Yopilgan (identity `active: false` / kesh) —
   * `auth:session_revoked` + `error` SESSION_REVOKED, uziladi; hali ham
   * noma'lum — yana kutiladi; ochiq — tamom. Socket uzilsa taymer bekor.
   */
  private scheduleSessionRecheck(
    client: Socket,
    userId: string,
    sessionId: string,
  ): void {
    const previous = this.sessionRechecks.get(client.id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.sessionRechecks.delete(client.id);
      void this.recheckSession(client, userId, sessionId);
    }, SESSION_RECHECK_DELAY_MS);
    timer.unref?.();
    this.sessionRechecks.set(client.id, timer);
  }

  private async recheckSession(
    client: Socket,
    userId: string,
    sessionId: string,
  ): Promise<void> {
    if (client.disconnected) return;
    const state = await this.sessionState(userId, sessionId);
    if (client.disconnected) return;
    if (state === 'unknown') {
      this.scheduleSessionRecheck(client, userId, sessionId);
      return;
    }
    if (state !== 'revoked') return;
    client.emit(SESSION_REVOKED_EVENT, {
      session_id: sessionId,
      reason: 'security_reset',
    });
    this.reject(client, {
      message: 'Session revoked',
      code: 'SESSION_REVOKED',
    });
    this.logger.log(
      `socket disconnected on re-check: user=${userId} session revoked (${sessionId})`,
    );
  }

  /**
   * (oFfOWGuo) Ulanishdan keyingi muddat tekshiruvi: ilgari token faqat
   * ulanishda tekshirilardi — muddati o'tgan token bilan ochilgan socket
   * cheksiz yashardi. `exp` kelganda `error` `{ code: 'TOKEN_EXPIRED' }` va
   * server uzadi. `exp` siz token — taymer yo'q (avvalgidek).
   */
  private scheduleTokenExpiry(client: Socket, user: SocketUser): void {
    if (typeof user.exp !== 'number' || !Number.isFinite(user.exp)) return;
    const previous = this.tokenExpiryTimers.get(client.id);
    if (previous) clearTimeout(previous);
    const remaining = user.exp * 1000 - Date.now();
    if (remaining <= 0) {
      this.expireSocket(client, user);
      return;
    }
    const timer = setTimeout(
      () => {
        this.tokenExpiryTimers.delete(client.id);
        if (client.disconnected) return;
        if (user.exp! * 1000 > Date.now()) {
          this.scheduleTokenExpiry(client, user);
          return;
        }
        this.expireSocket(client, user);
      },
      Math.min(remaining, MAX_TIMER_MS),
    );
    timer.unref?.();
    this.tokenExpiryTimers.set(client.id, timer);
  }

  private expireSocket(client: Socket, user: SocketUser): void {
    this.reject(client, { message: 'Token expired', code: 'TOKEN_EXPIRED' });
    this.logger.log(`socket disconnected: user=${user.sub} token expired`);
  }

  /** Rad etish: `error` hodisasi, keyin server uzadi (hodisa avval yetadi). */
  private reject(client: Socket, error: RealtimeConnectError): void {
    client.emit('error', error);
    client.disconnect(true);
  }

  /**
   * HTTP `JwtStrategy` bilan bir xil (5 daqiqalik «oxirgi tasdiq» muhlati
   * servisning o'zida). identity javob bermasa / xato — `unknown`
   * (2026-10-26: socket qabul qilinadi, 30 s dan keyin qayta tekshiriladi).
   */
  private async sessionState(
    userId: string,
    sessionId: string,
  ): Promise<SessionState> {
    if (!this.revocation) return 'active';
    try {
      return await this.revocation.state(userId, sessionId);
    } catch {
      return 'unknown';
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
    const recheck = this.sessionRechecks.get(client.id);
    if (recheck) {
      clearTimeout(recheck);
      this.sessionRechecks.delete(client.id);
    }
    const expiry = this.tokenExpiryTimers.get(client.id);
    if (expiry) {
      clearTimeout(expiry);
      this.tokenExpiryTimers.delete(client.id);
    }
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
        exp?: number;
      }>(raw);
      const branchId =
        payload.branch_id == null ? '' : String(payload.branch_id).trim();
      return {
        sub: String(payload.sub),
        username: payload.username,
        roles: (payload.roles ?? []).map((r) => String(r).toLowerCase()),
        branch_id: branchId || null,
        sid: sessionIdClaim(payload.sid),
        exp: typeof payload.exp === 'number' ? payload.exp : undefined,
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
