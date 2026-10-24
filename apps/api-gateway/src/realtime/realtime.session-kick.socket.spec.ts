import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import WebSocket from 'ws';
import { SessionRevocationService } from '../auth/session-revocation.service';
import {
  RealtimeGateway,
  SESSION_KICK_DISCONNECT_DELAY_MS,
} from './realtime.gateway';

/**
 * (Elchi Pochta #3, 2026-10-24) HAQIQIY socket.io serveri (Nest IoAdapter,
 * `/realtime` namespace) va xom socket.io v4 protokolli mijoz (`ws` ustida —
 * loyihada socket.io-client yo'q). Mijoz ko'radigan TARTIB tekshiriladi:
 *
 *   `auth:session_revoked` hodisasi → server DISCONNECT paketi
 *   («io server disconnect» — socket.io-client o'zi qayta ulanmaydi) →
 *   transport yopiladi;
 *
 * boshqa sessiya va `sid` siz socketlar ulanganicha qoladi; eski token bilan
 * qayta ulanish `error { code: 'SESSION_REVOKED' }` bilan rad etiladi.
 */
const SECRET = 'realtime-socket-kick-secret';
const SID_PHONE = '3f2b8c1e-6a4d-4e7b-9c10-2d5f7a8b9c0d';
const SID_LAPTOP = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const SID_CLOSED = '11111111-2222-4333-8444-555555555555';
const NSP = '/realtime';

type Frame =
  | { kind: 'connect' }
  | { kind: 'event'; name: string; data: unknown; at: number }
  | { kind: 'disconnect'; at: number }
  | { kind: 'close'; at: number };

/** Minimal socket.io v4 (Engine.IO 4, websocket transport) mijozi. */
class RawSocketIoClient {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;
  private readonly token: string;
  private waiters: Array<() => void> = [];

  constructor(port: number, token: string) {
    this.token = token;
    this.ws = new WebSocket(
      `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`,
    );
    this.ws.on('message', (raw: WebSocket.RawData) =>
      this.onFrame(String(raw)),
    );
    this.ws.on('close', () => this.push({ kind: 'close', at: Date.now() }));
  }

  private onFrame(text: string): void {
    const engineType = text[0];
    if (engineType === '0') {
      // Engine.IO open → namespace'ga CONNECT (auth bilan).
      this.ws.send(`40${NSP},${JSON.stringify({ token: this.token })}`);
      return;
    }
    if (engineType === '2') {
      this.ws.send('3');
      return;
    }
    if (engineType !== '4') return;
    const packet = text.slice(1);
    const type = packet[0];
    const body = packet.slice(1);
    if (!body.startsWith(`${NSP},`) && body !== NSP) return;
    const payload = body.slice(NSP.length + 1);
    if (type === '0') this.push({ kind: 'connect' });
    else if (type === '1') this.push({ kind: 'disconnect', at: Date.now() });
    else if (type === '2') {
      const [name, data] = JSON.parse(payload) as [string, unknown];
      this.push({ kind: 'event', name, data, at: Date.now() });
    }
  }

  private push(frame: Frame): void {
    this.frames.push(frame);
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((wake) => wake());
  }

  events(name?: string): Array<{ name: string; data: unknown; at: number }> {
    return this.frames.filter(
      (f): f is Extract<Frame, { kind: 'event' }> =>
        f.kind === 'event' && (name === undefined || f.name === name),
    );
  }

  get closed(): boolean {
    return this.frames.some((f) => f.kind === 'close');
  }

  async waitFor(
    predicate: (client: RawSocketIoClient) => boolean,
    timeoutMs = 3000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this)) {
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(
          `timeout; frames: ${JSON.stringify(this.frames.map((f) => f.kind))}`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  waitEvent(name: string): Promise<void> {
    return this.waitFor((c) => c.events(name).length > 0);
  }

  waitClosed(): Promise<void> {
    return this.waitFor((c) => c.closed);
  }

  terminate(): void {
    this.ws.terminate();
  }
}

describe('Elchi Pochta #3 (2026-10-24) — haqiqiy socket.io: chiqarilgan sessiya socketdan darhol chiqadi', () => {
  let app: INestApplication;
  let port: number;
  let revocation: SessionRevocationService;
  let gateway: RealtimeGateway;
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '1h' } });
  const closedInIdentity = new Set<string>([SID_CLOSED]);
  const identitySend = jest.fn(
    (_pattern: { cmd: string }, payload: { sessionId: string }) =>
      of({ active: !closedInIdentity.has(payload.sessionId) }),
  );
  const clients: RawSocketIoClient[] = [];

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        RealtimeGateway,
        SessionRevocationService,
        { provide: JwtService, useValue: jwt },
        { provide: 'IDENTITY', useValue: { send: identitySend } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => ({ ACCESS_TOKEN_TIME: '1h' })[key],
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer() as { address(): AddressInfo }).address().port;
    revocation = app.get(SessionRevocationService);
    gateway = app.get(RealtimeGateway);
  });

  afterEach(() => {
    while (clients.length) clients.pop()?.terminate();
  });

  afterAll(async () => {
    if (app) await app.close();
    jest.restoreAllMocks();
  });

  const token = (sid?: string) =>
    jwt.sign({ sub: '25', roles: ['COURIER'], ...(sid ? { sid } : {}) });

  const connect = async (sid?: string) => {
    const client = new RawSocketIoClient(port, token(sid));
    clients.push(client);
    await client.waitFor(
      (c) => c.events('connected').length > 0 || c.events('error').length > 0,
    );
    return client;
  };

  it('⭐ telefon chiqarildi: ikkala tabi hodisani OLDIN oladi, keyin server DISCONNECT va transport yopiladi; noutbuk va `sid` siz socket ulanganicha, push ularga yetadi', async () => {
    const phoneTab1 = await connect(SID_PHONE);
    const phoneTab2 = await connect(SID_PHONE);
    const laptop = await connect(SID_LAPTOP);
    const telegram = await connect();
    expect(phoneTab1.events('connected')[0].data).toEqual({
      user_id: '25',
      roles: ['courier'],
      session_id: SID_PHONE,
    });
    expect(telegram.events('connected')[0].data).toMatchObject({
      session_id: null,
    });

    const kickedAt = Date.now();
    // HTTP handler (DELETE /auth/sessions/:id) aynan shuni chaqiradi.
    revocation.kickSessions([SID_PHONE], 'revoked_by_owner');

    for (const tab of [phoneTab1, phoneTab2]) {
      await tab.waitClosed();
      const kinds = tab.frames.map((f) =>
        f.kind === 'event' ? `event:${f.name}` : f.kind,
      );
      expect(kinds.slice(-3)).toEqual([
        'event:auth:session_revoked',
        'disconnect',
        'close',
      ]);
      const revoked = tab.events('auth:session_revoked')[0];
      expect(revoked.data).toEqual({
        session_id: SID_PHONE,
        reason: 'revoked_by_owner',
      });
      // Hodisa darhol; uzish ~250 ms dan keyin (bir tick'da emas).
      expect(revoked.at - kickedAt).toBeLessThan(
        SESSION_KICK_DISCONNECT_DELAY_MS,
      );
      const disconnect = tab.frames.find((f) => f.kind === 'disconnect') as {
        at: number;
      };
      expect(disconnect.at - kickedAt).toBeGreaterThanOrEqual(
        SESSION_KICK_DISCONNECT_DELAY_MS - 20,
      );
    }

    // Boshqa sessiyalar tegilmagan va hali ham push oladi.
    gateway.pushToUser('25', 'notification:new', { id: 'n1' });
    await laptop.waitEvent('notification:new');
    await telegram.waitEvent('notification:new');
    expect(laptop.closed).toBe(false);
    expect(telegram.closed).toBe(false);
    expect(laptop.events('auth:session_revoked')).toEqual([]);
    expect(telegram.events('auth:session_revoked')).toEqual([]);
    expect(phoneTab1.events('notification:new')).toEqual([]);
  });

  it('⭐ chiqarilgan telefon eski token bilan qayta ulanadi — `error` SESSION_REVOKED, keyin uziladi (identity so‘ralmaydi — kesh)', async () => {
    revocation.kickSessions([SID_PHONE], 'revoked_by_owner');
    identitySend.mockClear();
    const again = await connect(SID_PHONE);
    await again.waitClosed();
    expect(again.events().map((e) => e.name)).toEqual(['error']);
    expect(again.events('error')[0].data).toEqual({
      message: 'Session revoked',
      code: 'SESSION_REVOKED',
    });
    const kinds = again.frames.map((f) => f.kind);
    expect(kinds.indexOf('event')).toBeLessThan(kinds.indexOf('disconnect'));
    expect(identitySend).not.toHaveBeenCalled();
  });

  it('identity’da yopilgan sessiya (boshqa instans / tozalash) bilan ulanish — rad etiladi', async () => {
    const client = await connect(SID_CLOSED);
    await client.waitClosed();
    expect(client.events('error')[0].data).toEqual({
      message: 'Session revoked',
      code: 'SESSION_REVOKED',
    });
    expect(client.events('connected')).toEqual([]);
  });

  it('soxta token — avvalgidek `error` (UNAUTHORIZED) va uziladi', async () => {
    const client = new RawSocketIoClient(port, `${token(SID_LAPTOP)}x`);
    clients.push(client);
    await client.waitClosed();
    expect(client.events('error')[0].data).toEqual({
      message: 'Unauthorized',
      code: 'UNAUTHORIZED',
    });
  });
});
