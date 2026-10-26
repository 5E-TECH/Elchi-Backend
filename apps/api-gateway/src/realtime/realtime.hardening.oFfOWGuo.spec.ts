import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RealtimeGateway, realtimeAllowRequest } from './realtime.gateway';

/**
 * (oFfOWGuo, xavfsizlik P2) realtime: chat:send / presence:list yo'q,
 * CORS_ORIGINS (HTTP bilan bir xil) va token muddati tugaganda uzish.
 */
describe('oFfOWGuo — realtime gateway yuzasi', () => {
  const jwt = new JwtService({ secret: 'oFfOWGuo-realtime-secret' });
  let gateway: RealtimeGateway;
  const envBackup = { ...process.env };

  const socket = (tok: string, id = 's1') => {
    const client = {
      id,
      data: {} as Record<string, unknown>,
      disconnected: false,
      handshake: { auth: { token: tok }, headers: {} },
      join: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(() => {
        client.disconnected = true;
      }),
    };
    return client;
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    gateway = new RealtimeGateway(jwt);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
    process.env = { ...envBackup };
  });

  describe('token muddati (exp) — ulanishdan keyin ham tekshiriladi', () => {
    it('⭐ exp kelganda `error` TOKEN_EXPIRED va server uzadi; oldin — uzilmaydi', async () => {
      jest.useFakeTimers();
      const client = socket(
        jwt.sign({ sub: '25', roles: ['COURIER'] }, { expiresIn: 60 }),
      );
      await gateway.handleConnection(client as never);
      expect(client.emit).toHaveBeenCalledWith('connected', expect.anything());
      expect(gateway.isOnline('25')).toBe(true);

      await jest.advanceTimersByTimeAsync(58_000);
      expect(client.disconnect).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(3_000);
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'Token expired',
        code: 'TOKEN_EXPIRED',
      });
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('socket oldin uzilsa taymer bekor — keyin hech narsa emit qilinmaydi', async () => {
      jest.useFakeTimers();
      const client = socket(
        jwt.sign({ sub: '25', roles: [] }, { expiresIn: 60 }),
      );
      await gateway.handleConnection(client as never);
      client.disconnected = true;
      gateway.handleDisconnect(client as never);
      client.emit.mockClear();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(client.emit).not.toHaveBeenCalled();
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(gateway.isOnline('25')).toBe(false);
    });

    it('`exp` siz token — taymer yo‘q (avvalgidek ulanib turadi)', async () => {
      jest.useFakeTimers();
      const client = socket(jwt.sign({ sub: '7', roles: [] }));
      await gateway.handleConnection(client as never);
      await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(gateway.isOnline('7')).toBe(true);
    });

    it('muddati o‘tgan token bilan ulanish — UNAUTHORIZED (avvalgidek)', async () => {
      const client = socket(
        jwt.sign({ sub: '25', exp: Math.floor(Date.now() / 1000) - 10 }),
      );
      await gateway.handleConnection(client as never);
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });
  });

  it('chat:send / presence:list handlerlari yo‘q (FE ishlatmaydi)', () => {
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(gateway));
    expect(proto).not.toContain('handleChat');
    expect(proto).not.toContain('handlePresence');
  });

  describe('Origin — HTTP CORS_ORIGINS bilan bir xil (ilgari origin: true)', () => {
    const check = (origin: string | undefined) =>
      new Promise<{ err: string | null | undefined; ok: boolean }>((resolve) =>
        realtimeAllowRequest(
          { headers: origin === undefined ? {} : { origin } },
          (err, ok) => resolve({ err, ok }),
        ),
      );

    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS =
        'https://admin.elchipochta.uz, https://elchipochta.uz';
    });

    it('ro‘yxatdagi origin — ruxsat', async () => {
      await expect(check('https://admin.elchipochta.uz')).resolves.toEqual({
        err: null,
        ok: true,
      });
    });

    it('begona origin va prodda localhost — rad', async () => {
      await expect(check('https://evil.example')).resolves.toEqual({
        err: 'origin not allowed',
        ok: false,
      });
      await expect(check('http://localhost:5173')).resolves.toMatchObject({
        ok: false,
      });
    });

    it('Origin yo‘q (brauzer emas) — ruxsat', async () => {
      await expect(check(undefined)).resolves.toMatchObject({ ok: true });
    });

    it('@WebSocketGateway: origin: true emas', () => {
      const options = Reflect.getMetadata(
        'websockets:gateway_options',
        RealtimeGateway,
      ) as { cors?: { origin?: unknown }; allowRequest?: unknown };
      expect(options.cors?.origin).not.toBe(true);
      expect(typeof options.cors?.origin).toBe('function');
      expect(options.allowRequest).toBe(realtimeAllowRequest);
    });
  });
});
