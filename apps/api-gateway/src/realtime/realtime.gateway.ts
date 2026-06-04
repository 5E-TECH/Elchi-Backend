import { Logger } from '@nestjs/common';
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

interface SocketUser {
  sub: string;
  username?: string;
  roles: string[];
  branch_id?: string | null;
}

/**
 * Realtime gateway (socket.io). Two purposes only (per product decision):
 *   1. server → client notifications, pushed from any service via the
 *      `realtime.notify` RMQ message (see realtime.controller.ts),
 *   2. online client ↔ client messaging (simple chat relay).
 *
 * Every connection is JWT-authenticated with the same ACCESS_TOKEN_KEY the HTTP
 * guards use. On connect the socket joins `user:<sub>` and `role:<role>` rooms,
 * which the push methods target.
 */
@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server!: Server;

  // userId -> set of live socket ids (a user may have several tabs/devices).
  private readonly online = new Map<string, Set<string>>();

  constructor(private readonly jwtService: JwtService) {}

  private getUser(client: Socket): SocketUser | undefined {
    return (client.data as { user?: SocketUser }).user;
  }

  handleConnection(client: Socket) {
    const user = this.authenticate(client);
    if (!user) {
      client.emit('error', { message: 'Unauthorized' });
      client.disconnect(true);
      return;
    }

    (client.data as { user?: SocketUser }).user = user;
    void client.join(`user:${user.sub}`);
    for (const role of user.roles) {
      void client.join(`role:${role}`);
    }

    const set = this.online.get(user.sub) ?? new Set<string>();
    set.add(client.id);
    this.online.set(user.sub, set);

    client.emit('connected', { user_id: user.sub, roles: user.roles });
    this.logger.log(`socket connected: user=${user.sub}`);
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
        branch_id?: string | null;
      }>(raw);
      return {
        sub: String(payload.sub),
        username: payload.username,
        roles: (payload.roles ?? []).map((r) => String(r).toLowerCase()),
        branch_id: payload.branch_id ?? null,
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
  handlePresence(): { online_user_ids: string[] } {
    return { online_user_ids: [...this.online.keys()] };
  }

  // ===== server → client push (called by realtime.controller) =====

  pushToUser(userId: string, event: string, data: unknown): void {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  pushToRole(role: string, event: string, data: unknown): void {
    this.server.to(`role:${String(role).toLowerCase()}`).emit(event, data);
  }

  broadcast(event: string, data: unknown): void {
    this.server.emit(event, data);
  }

  isOnline(userId: string): boolean {
    return this.online.has(String(userId));
  }
}
