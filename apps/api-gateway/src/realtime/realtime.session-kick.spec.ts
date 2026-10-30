import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Observable, Subject, of, throwError } from 'rxjs';
import { SessionRevocationService } from '../auth/session-revocation.service';
import {
  RealtimeController,
  SESSIONS_KICK_PATTERN,
} from './realtime.controller';
import {
  RealtimeGateway,
  SESSION_KICK_DISCONNECT_DELAY_MS,
  SESSION_RECHECK_DELAY_MS,
  SESSION_REVOKED_EVENT,
} from './realtime.gateway';

/**
 * (Elchi Pochta #3, 2026-10-24) Sessiya yopilganda qurilma SHU ZAHOTI
 * chiqadi — socket qismi (soxta socket.io server bilan; haqiqiy socket.io
 * protokoli: realtime.session-kick.socket.spec.ts):
 *  - `sid` li token: avval `session:<sid>` xonasi, keyin HTTP bilan bir xil
 *    tekshiruv (kesh / identity `session_state`, fail open); yopilgan →
 *    `error { code: 'SESSION_REVOKED' }` + uzish, `user:`/`role:` xonalariga
 *    kirmaydi;
 *  - `kickSessions` → `auth:session_revoked { session_id, reason }` shu
 *    sessiya xonasiga, 250 ms dan KEYIN `disconnectSockets(true)`; boshqa
 *    sessiyalarga tegilmaydi;
 *  - `sid` siz token avvalgidek;
 *  - identity'dan `auth.sessions.kick` (RMQ) → xuddi shu yo'l.
 */
const SECRET = 'realtime-session-kick-secret';
const SID_PHONE = '3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d';
const SID_LAPTOP = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const SID_TABLET = '11111111-2222-4333-8444-555555555555';

type Timeline = Array<
  | { kind: 'emit'; room: string; event: string; data: unknown }
  | { kind: 'disconnect'; rooms: string[]; close: boolean }
>;

describe('Elchi Pochta #3 (2026-10-24) — realtime: yopilgan sessiya socketdan darhol chiqadi', () => {
  const jwt = new JwtService({ secret: SECRET });
  let timeline: Timeline;
  let closed: Set<string>;
  let identityReply: (sessionId: string) => Observable<unknown>;
  let send: jest.Mock;
  let revocation: SessionRevocationService;
  let gateway: RealtimeGateway;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    timeline = [];
    closed = new Set();
    identityReply = (sessionId) => of({ active: !closed.has(sessionId) });
    send = jest.fn((_pattern: unknown, payload: { sessionId: string }) =>
      identityReply(payload.sessionId),
    );
    revocation = new SessionRevocationService(
      { send } as never,
      { get: () => '1h' } as never,
    );
    jest
      .spyOn((revocation as unknown as { logger: Logger }).logger, 'warn')
      .mockImplementation(() => undefined);
    gateway = new RealtimeGateway(jwt, revocation);
    (gateway as unknown as { server: unknown }).server = {
      to: (room: string) => ({
        emit: (event: string, data: unknown) =>
          timeline.push({ kind: 'emit', room, event, data }),
      }),
      in: (rooms: string | string[]) => ({
        disconnectSockets: (close: boolean) =>
          timeline.push({
            kind: 'disconnect',
            rooms: ([] as string[]).concat(rooms),
            close,
          }),
      }),
      emit: jest.fn(),
    };
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const token = (sid?: string | null, sub = '25', roles = ['COURIER']) =>
    jwt.sign({ sub, roles, ...(sid !== undefined ? { sid } : {}) });

  const socket = (tok: string, id = 's1') => {
    const joined: string[] = [];
    const client = {
      id,
      data: {} as Record<string, unknown>,
      disconnected: false,
      handshake: { auth: { token: tok }, headers: {} },
      join: jest.fn((room: string) => {
        joined.push(room);
      }),
      emit: jest.fn(),
      disconnect: jest.fn(() => {
        client.disconnected = true;
      }),
    };
    return { client, joined };
  };

  /**
   * (2026-10-26) Soxta taymerlar bilan ulanish: `rmqSend` qayta urinish
   * kechikishi (rxjs `timer`) ham soxta — tekshiruv tugashi uchun vaqt
   * suriladi (SESSION_RECHECK_DELAY_MS dan ancha kam).
   */
  const RMQ_SETTLE_MS = 5_000;
  const connectWithFakeTimers = async (client: unknown) => {
    const pending = gateway.handleConnection(client as never);
    await jest.advanceTimersByTimeAsync(RMQ_SETTLE_MS);
    await pending;
  };

  describe('ulanish', () => {
    it('⭐ BOT-2: Telegram tokeni (Mini App tg_scan va bot aktori) — socket RAD, hech qaysi xonaga kirmaydi', async () => {
      for (const extra of [
        { auth: 'telegram', scope: 'tg_scan', tg_id: '5550007' },
        { auth: 'telegram', tg_id: '5550007' },
      ]) {
        const { client, joined } = socket(
          jwt.sign({ sub: '25', roles: ['COURIER'], ...extra }),
        );
        await gateway.handleConnection(client as never);
        expect(joined).toEqual([]);
        expect(client.disconnect).toHaveBeenCalled();
        expect(gateway.isOnline('25')).toBe(false);
      }
    });

    it('⭐ ochiq sessiya: avval `session:<sid>`, keyin `user:`/`role:`; `connected` da `session_id`', async () => {
      const { client, joined } = socket(token(SID_PHONE.toUpperCase()));
      await gateway.handleConnection(client as never);
      expect(joined).toEqual([
        `session:${SID_PHONE}`,
        'user:25',
        'role:courier',
      ]);
      expect(client.emit).toHaveBeenCalledWith('connected', {
        user_id: '25',
        roles: ['courier'],
        session_id: SID_PHONE,
      });
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(gateway.isOnline('25')).toBe(true);
      expect(send).toHaveBeenCalledWith(
        { cmd: 'identity.auth.session_state' },
        { userId: '25', sessionId: SID_PHONE },
      );
    });

    it('⭐ yopilgan sessiya (identity `active: false`) — `error` SESSION_REVOKED, uziladi; `user:`/`role:` xonasi va onlayn yo‘q', async () => {
      closed.add(SID_PHONE);
      const { client, joined } = socket(token(SID_PHONE));
      await gateway.handleConnection(client as never);
      expect(client.emit).toHaveBeenCalledTimes(1);
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'Session revoked',
        code: 'SESSION_REVOKED',
      });
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(joined).toEqual([`session:${SID_PHONE}`]);
      expect(client.data.user).toBeUndefined();
      expect(gateway.isOnline('25')).toBe(false);
    });

    it('⭐ chiqarilgan qurilma eski token bilan qayta ulanadi — keshdan rad (identity so‘ralmaydi)', async () => {
      revocation.kickSessions([SID_PHONE], 'revoked_by_owner');
      const { client } = socket(token(SID_PHONE));
      await gateway.handleConnection(client as never);
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'Session revoked',
        code: 'SESSION_REVOKED',
      });
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(send).not.toHaveBeenCalled();
    });

    it('`sid` siz token (Telegram / bot / eski) — avvalgidek: sessiya xonasi va tekshiruv yo‘q', async () => {
      const { client, joined } = socket(token());
      await gateway.handleConnection(client as never);
      expect(joined).toEqual(['user:25', 'role:courier']);
      expect(client.emit).toHaveBeenCalledWith('connected', {
        user_id: '25',
        roles: ['courier'],
        session_id: null,
      });
      expect(send).not.toHaveBeenCalled();
    });

    it('UUID bo‘lmagan `sid` — `sid` siz kabi (HTTP JwtStrategy bilan bir xil)', async () => {
      const { client, joined } = socket(token('legacy-session'));
      await gateway.handleConnection(client as never);
      expect(joined).toEqual(['user:25', 'role:courier']);
      expect(send).not.toHaveBeenCalled();
    });

    it('⭐ (2026-10-26) identity javob bermasa, muhlat yozuvi yo‘q (gateway qayta ishga tushgan) — socket QABUL qilinadi, 30 s dan keyin qayta tekshiriladi; yopilgan bo‘lsa uziladi', async () => {
      jest.useFakeTimers();
      let down = true;
      identityReply = (sessionId) =>
        down
          ? throwError(() => new Error('identity down'))
          : of({ active: !closed.has(sessionId) });
      const { client, joined } = socket(token(SID_PHONE));
      await connectWithFakeTimers(client);
      // Rad etilmadi: `error` yo'q, uzilmadi, odatiy xonalar va `connected`.
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledTimes(1);
      expect(client.emit).toHaveBeenCalledWith(
        'connected',
        expect.objectContaining({ session_id: SID_PHONE }),
      );
      expect(joined).toEqual([
        `session:${SID_PHONE}`,
        'user:25',
        'role:courier',
      ]);
      expect(gateway.isOnline('25')).toBe(true);

      // 30 s: identity hali ham javob bermaydi — uzilmaydi, yana kutadi.
      await jest.advanceTimersByTimeAsync(
        SESSION_RECHECK_DELAY_MS + RMQ_SETTLE_MS,
      );
      expect(client.disconnect).not.toHaveBeenCalled();

      // identity qaytdi, sessiya esa shu orada yopilgan — keyingi tekshiruvda uziladi.
      down = false;
      closed.add(SID_PHONE);
      await jest.advanceTimersByTimeAsync(
        SESSION_RECHECK_DELAY_MS + RMQ_SETTLE_MS,
      );
      expect(client.emit).toHaveBeenCalledWith(SESSION_REVOKED_EVENT, {
        session_id: SID_PHONE,
        reason: 'security_reset',
      });
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'Session revoked',
        code: 'SESSION_REVOKED',
      });
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('(2026-10-26) qayta tekshiruvda sessiya ochiq — socket qoladi, boshqa tekshiruv yo‘q', async () => {
      jest.useFakeTimers();
      let down = true;
      identityReply = () =>
        down
          ? throwError(() => new Error('identity down'))
          : of({ active: true });
      const { client } = socket(token(SID_PHONE));
      await connectWithFakeTimers(client);
      down = false;
      await jest.advanceTimersByTimeAsync(
        SESSION_RECHECK_DELAY_MS + RMQ_SETTLE_MS,
      );
      expect(client.disconnect).not.toHaveBeenCalled();
      const callsAfter = send.mock.calls.length;
      await jest.advanceTimersByTimeAsync(SESSION_RECHECK_DELAY_MS * 3);
      expect(send.mock.calls.length).toBe(callsAfter);
    });

    it('(2026-10-26) socket uzilsa — qayta tekshiruv taymeri bekor', async () => {
      jest.useFakeTimers();
      identityReply = () => throwError(() => new Error('identity down'));
      const { client } = socket(token(SID_PHONE));
      await connectWithFakeTimers(client);
      const callsAfter = send.mock.calls.length;
      client.disconnected = true;
      gateway.handleDisconnect(client as never);
      await jest.advanceTimersByTimeAsync(SESSION_RECHECK_DELAY_MS * 2);
      expect(send.mock.calls.length).toBe(callsAfter);
      expect(gateway.isOnline('25')).toBe(false);
    });

    it('⭐ (2026-10-26) 5 daqiqa ichida tasdiqlangan sessiya — identity ishlamasa ham darhol ulanadi (qayta tekshiruv yo‘q)', async () => {
      let clock = 1_000_000;
      revocation.now = () => clock;
      let down = false;
      identityReply = () =>
        down
          ? throwError(() => new Error('identity down'))
          : of({ active: true });
      const first = socket(token(SID_PHONE), 's1');
      await gateway.handleConnection(first.client as never);
      down = true;
      clock += 4 * 60_000;
      const second = socket(token(SID_PHONE), 's2');
      await gateway.handleConnection(second.client as never);
      expect(second.client.disconnect).not.toHaveBeenCalled();
      expect(second.client.emit).toHaveBeenCalledWith(
        'connected',
        expect.objectContaining({ session_id: SID_PHONE }),
      );
      expect(
        (gateway as unknown as { sessionRechecks: Map<string, unknown> })
          .sessionRechecks.size,
      ).toBe(0);
    });

    it('⭐ (2026-10-26) muhlatda bo‘lsa ham yopilgan sessiya — rad etiladi (SESSION_REVOKED)', async () => {
      let down = false;
      identityReply = () =>
        down
          ? throwError(() => new Error('identity down'))
          : of({ active: true });
      const first = socket(token(SID_PHONE), 's1');
      await gateway.handleConnection(first.client as never);
      down = true;
      revocation.markRevoked([SID_PHONE]);
      const second = socket(token(SID_PHONE), 's2');
      await gateway.handleConnection(second.client as never);
      expect(second.client.emit).toHaveBeenCalledWith('error', {
        message: 'Session revoked',
        code: 'SESSION_REVOKED',
      });
      expect(second.client.disconnect).toHaveBeenCalledWith(true);
    });

    it('⭐ tekshiruv davomida chiqarilsa — hodisa sessiya xonasiga yetadi; kechikkan «active» javobi baribir rad etadi, `user:`/`role:` ga kirmaydi', async () => {
      const reply = new Subject<unknown>();
      identityReply = () => reply;
      const { client, joined } = socket(token(SID_PHONE));
      const pending = gateway.handleConnection(client as never);
      await Promise.resolve();
      expect(joined).toEqual([`session:${SID_PHONE}`]);
      // Kick tekshiruv tugamasdan keldi — socket allaqachon xonada.
      revocation.kickSessions([SID_PHONE], 'revoked_by_owner');
      expect(timeline[0]).toEqual({
        kind: 'emit',
        room: `session:${SID_PHONE}`,
        event: SESSION_REVOKED_EVENT,
        data: { session_id: SID_PHONE, reason: 'revoked_by_owner' },
      });
      reply.next({ active: true });
      reply.complete();
      await pending;
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'Session revoked',
        code: 'SESSION_REVOKED',
      });
      expect(joined).toEqual([`session:${SID_PHONE}`]);
      expect(gateway.isOnline('25')).toBe(false);
    });

    it('tekshiruv davomida mijoz o‘zi uzilsa — `user:`/`role:` ga kirmaydi, `connected` yo‘q', async () => {
      const reply = new Subject<unknown>();
      identityReply = () => reply;
      const { client, joined } = socket(token(SID_PHONE));
      const pending = gateway.handleConnection(client as never);
      await Promise.resolve();
      client.disconnected = true;
      reply.next({ active: true });
      reply.complete();
      await pending;
      expect(joined).toEqual([`session:${SID_PHONE}`]);
      expect(client.emit).not.toHaveBeenCalled();
      expect(gateway.isOnline('25')).toBe(false);
    });

    it('(oFfOWGuo) `presence:list` / `chat:send` olib tashlangan — handler yo‘q', () => {
      const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(gateway));
      expect(proto).not.toContain('handlePresence');
      expect(proto).not.toContain('handleChat');
    });
  });

  describe('chiqarish (kickSessions → socket)', () => {
    it('⭐ hodisa AVVAL (shu zahoti), uzish 250 ms dan KEYIN; faqat o‘sha sessiya xonalari', () => {
      jest.useFakeTimers();
      revocation.kickSessions([SID_PHONE, SID_TABLET], 'revoked_by_owner');
      expect(timeline).toEqual([
        {
          kind: 'emit',
          room: `session:${SID_PHONE}`,
          event: 'auth:session_revoked',
          data: { session_id: SID_PHONE, reason: 'revoked_by_owner' },
        },
        {
          kind: 'emit',
          room: `session:${SID_TABLET}`,
          event: 'auth:session_revoked',
          data: { session_id: SID_TABLET, reason: 'revoked_by_owner' },
        },
      ]);
      jest.advanceTimersByTime(SESSION_KICK_DISCONNECT_DELAY_MS - 1);
      expect(timeline).toHaveLength(2);
      jest.advanceTimersByTime(1);
      expect(timeline[2]).toEqual({
        kind: 'disconnect',
        rooms: [`session:${SID_PHONE}`, `session:${SID_TABLET}`],
        close: true,
      });
      expect(SESSION_KICK_DISCONNECT_DELAY_MS).toBe(250);
      // Noutbuk (joriy) sessiyasi xonasiga hech narsa ketmadi.
      expect(
        timeline.some(
          (entry) =>
            ('room' in entry && entry.room.includes(SID_LAPTOP)) ||
            ('rooms' in entry &&
              entry.rooms.some((room) => room.includes(SID_LAPTOP))),
        ),
      ).toBe(false);
    });

    it.each([
      'revoked_by_owner',
      'password_changed',
      'logout',
      'security_reset',
    ] as const)('reason `%s` payload’da o‘zgarmay', (reason) => {
      revocation.kickSessions([SID_PHONE], reason);
      expect(timeline[0]).toMatchObject({
        data: { session_id: SID_PHONE, reason },
      });
    });

    it('socket server hali yo‘q bo‘lsa — kesh baribir belgilanadi, xato yo‘q', async () => {
      (gateway as unknown as { server: unknown }).server = undefined;
      expect(() =>
        revocation.kickSessions([SID_PHONE], 'logout'),
      ).not.toThrow();
      expect(await revocation.isRevoked('25', SID_PHONE)).toBe(true);
    });

    it('onModuleDestroy — kutilayotgan uzish bekor, keyingi kick socketga tegmaydi', () => {
      jest.useFakeTimers();
      revocation.kickSessions([SID_PHONE], 'logout');
      gateway.onModuleDestroy();
      jest.advanceTimersByTime(SESSION_KICK_DISCONNECT_DELAY_MS * 2);
      expect(timeline.map((entry) => entry.kind)).toEqual(['emit']);
      revocation.kickSessions([SID_TABLET], 'logout');
      expect(timeline).toHaveLength(1);
    });
  });

  describe('identity → gateway `auth.sessions.kick` (RMQ)', () => {
    const ctx = () => {
      const ack = jest.fn();
      return {
        ack,
        context: {
          getChannelRef: () => ({ ack }),
          getMessage: () => ({ id: 'm1' }),
        },
      };
    };

    it('⭐ security_reset: kesh + socket hodisasi, har doim ack', async () => {
      const controller = new RealtimeController(gateway, revocation);
      const { ack, context } = ctx();
      controller.sessionsKick(
        { session_ids: [SID_PHONE.toUpperCase()], reason: 'security_reset' },
        context as never,
      );
      expect(SESSIONS_KICK_PATTERN).toEqual({ cmd: 'auth.sessions.kick' });
      expect(timeline[0]).toMatchObject({
        room: `session:${SID_PHONE}`,
        data: { session_id: SID_PHONE, reason: 'security_reset' },
      });
      expect(await revocation.isRevoked('25', SID_PHONE)).toBe(true);
      expect(ack).toHaveBeenCalledTimes(1);
    });

    it('noma’lum reason → security_reset; bo‘sh / buzuq payload — hech narsa, ack', () => {
      const controller = new RealtimeController(gateway, revocation);
      const first = ctx();
      controller.sessionsKick(
        { session_ids: [SID_PHONE], reason: 'hack' },
        first.context as never,
      );
      expect(timeline[0]).toMatchObject({
        data: { reason: 'security_reset' },
      });
      const second = ctx();
      controller.sessionsKick(
        { session_ids: 'nope' } as never,
        second.context as never,
      );
      controller.sessionsKick(null as never, second.context as never);
      expect(timeline).toHaveLength(1);
      expect(first.ack).toHaveBeenCalledTimes(1);
      expect(second.ack).toHaveBeenCalledTimes(2);
    });

    it('SessionRevocationService yo‘q (eski qurilish) — xato emas, ack', () => {
      const controller = new RealtimeController(gateway);
      const { ack, context } = ctx();
      controller.sessionsKick(
        { session_ids: [SID_PHONE], reason: 'security_reset' },
        context as never,
      );
      expect(timeline).toHaveLength(0);
      expect(ack).toHaveBeenCalledTimes(1);
    });
  });
});
