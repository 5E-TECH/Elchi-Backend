import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { NEVER, Observable, of, throwError } from 'rxjs';
import { IS_PUBLIC_KEY } from './auth/public.decorator';
import { ROLES_KEY } from './auth/roles.decorator';
import {
  BOT_HEALTH_TIMEOUT_MS,
  BOT_HEALTH_UNAVAILABLE_TEXT,
  BOT_RECHECK_TIMEOUT_MS,
  NotificationBotHealthController,
  toBotDiagnostics,
  toPublicNotificationHealth,
} from './notification-bot-health.controller';

/**
 * BOT-DIAG-BE — gateway: `GET /health/notification-bot` va
 * `POST /health/notification-bot/recheck` (faqat superadmin). HTTP darajasi
 * (401/403/200, haqiqiy global guard'lar) — test/notification-bot-health.e2e-spec.ts.
 */
const BOT = {
  enabled: true,
  mode: 'webhook',
  healthy: false,
  username: 'elchi_bot',
  reason: 'webhook (secret_token bilan)',
  checked_at: '2026-11-17T21:05:00.000Z',
  error_kind: 'network',
  error_status: null,
  error_text: 'Telegram getMe failed (0): fetch failed (ENOTFOUND)',
  restart_required: false,
};

const HEALTH_REPLY = {
  service: 'notification-service',
  status: 'degraded',
  bot: BOT,
  timestamp: '2026-11-17T21:05:01.000Z',
};

const make = (reply: () => Observable<unknown>) => {
  const send = jest.fn(() => reply());
  const controller = new NotificationBotHealthController({
    send,
  } as unknown as ClientProxy);
  return { controller, send };
};

describe('BOT-DIAG-BE — NotificationBotHealthController', () => {
  it('⭐ ikkala marshrut faqat superadmin, @Public EMAS (global JWT majburiy)', () => {
    const proto =
      NotificationBotHealthController.prototype as unknown as Record<
        string,
        object
      >;
    for (const handler of ['notificationBot', 'recheckNotificationBot']) {
      expect(Reflect.getMetadata(ROLES_KEY, proto[handler])).toEqual([
        'superadmin',
      ]);
      expect(
        Reflect.getMetadata(IS_PUBLIC_KEY, proto[handler]),
      ).toBeUndefined();
    }
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, NotificationBotHealthController),
    ).toBeUndefined();
  });

  it('GET: notification.health → status + oq ro‘yxatdagi bot maydonlari', async () => {
    const { controller, send } = make(() =>
      of({ ...HEALTH_REPLY, bot: { ...BOT, internal_secret: 'x' } }),
    );

    const body = await controller.notificationBot();

    expect(send).toHaveBeenCalledWith({ cmd: 'notification.health' }, {});
    expect(body).toEqual({
      status: 'degraded',
      bot: BOT,
      timestamp: HEALTH_REPLY.timestamp,
    });
    expect(body.bot).not.toHaveProperty('internal_secret');
  });

  it('POST recheck: notification.bot.recheck → yangi holat + rechecked', async () => {
    const { controller, send } = make(() =>
      of({
        ...HEALTH_REPLY,
        status: 'ok',
        bot: {
          ...BOT,
          healthy: true,
          error_kind: null,
          error_text: null,
        },
        rechecked: true,
      }),
    );

    const body = await controller.recheckNotificationBot();

    expect(send).toHaveBeenCalledWith({ cmd: 'notification.bot.recheck' }, {});
    expect(body).toMatchObject({
      status: 'ok',
      rechecked: true,
      bot: { healthy: true, error_kind: null, error_text: null },
    });
  });

  it('POST recheck: token rad etilgan → rechecked false, restart_required true', async () => {
    const { controller } = make(() =>
      of({
        ...HEALTH_REPLY,
        bot: {
          ...BOT,
          mode: 'off',
          error_kind: 'token_rejected',
          error_status: 401,
          restart_required: true,
        },
        rechecked: false,
      }),
    );
    const body = await controller.recheckNotificationBot();
    expect(body).toMatchObject({
      status: 'degraded',
      rechecked: false,
      bot: {
        error_kind: 'token_rejected',
        error_status: 401,
        restart_required: true,
      },
    });
  });

  describe('xizmat javob bermasa — 503, o‘zbekcha matn', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it.each([
      ['notificationBot', BOT_HEALTH_TIMEOUT_MS],
      ['recheckNotificationBot', BOT_RECHECK_TIMEOUT_MS],
    ] as const)('⭐ %s: %i ms timeout → 503', async (handler, ms) => {
      expect(ms).toBeGreaterThanOrEqual(3_000);
      expect(ms).toBeLessThanOrEqual(5_000);
      const { controller } = make(() => NEVER);

      let done = false;
      let error: unknown = null;
      void controller[handler]().then(
        () => {
          done = true;
        },
        (e: unknown) => {
          done = true;
          error = e;
        },
      );
      await jest.advanceTimersByTimeAsync(ms - 1);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
      expect((error as ServiceUnavailableException).message).toBe(
        BOT_HEALTH_UNAVAILABLE_TEXT.timeout,
      );
    });
  });

  it('RPC xatosi → 503 «bog‘lanib bo‘lmadi»; xom matn javobda yo‘q', async () => {
    const { controller } = make(() =>
      throwError(() => new Error('connect ECONNREFUSED 172.18.0.5:5672')),
    );
    const error = await controller.notificationBot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(
      JSON.stringify((error as ServiceUnavailableException).getResponse()),
    ).not.toContain('ECONNREFUSED');
    expect((error as ServiceUnavailableException).message).toBe(
      BOT_HEALTH_UNAVAILABLE_TEXT.down,
    );
  });

  it.each([[null], ['Hammasi chotki ishlayapti!'], [{ status: 'ok' }]])(
    'kutilmagan javob shakli (%j) → 503',
    async (reply) => {
      const { controller } = make(() => of(reply));
      await expect(controller.notificationBot()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    },
  );
});

describe('BOT-DIAG-BE — toBotDiagnostics (oq ro‘yxat)', () => {
  it('eski notification-service (diagnostikasiz) → null/false', () => {
    expect(
      toBotDiagnostics({
        enabled: true,
        mode: 'webhook',
        healthy: true,
        username: 'elchi_bot',
        reason: 'webhook (secret_token bilan)',
      }),
    ).toEqual({
      enabled: true,
      mode: 'webhook',
      healthy: true,
      username: 'elchi_bot',
      reason: 'webhook (secret_token bilan)',
      checked_at: null,
      error_kind: null,
      error_status: null,
      error_text: null,
      restart_required: false,
    });
  });

  it('noma’lum error_kind → null; error_text ≤ 200; noto‘g‘ri turlar tashlanadi', () => {
    const out = toBotDiagnostics({
      ...BOT,
      error_kind: 'something_else',
      error_status: '500',
      error_text: 'y'.repeat(500),
      restart_required: 'yes',
    });
    expect(out.error_kind).toBeNull();
    expect(out.error_status).toBeNull();
    expect(out.error_text).toHaveLength(200);
    expect(out.restart_required).toBe(false);
  });
});

describe('BOT-DIAG-BE — GET /notifications/health (@Public) diagnostikani sizdirmaydi', () => {
  it('⭐ bot — faqat eski maydonlar; service/status/timestamp o‘zgarishsiz', () => {
    expect(toPublicNotificationHealth(HEALTH_REPLY)).toEqual({
      service: 'notification-service',
      status: 'degraded',
      bot: {
        enabled: true,
        mode: 'webhook',
        healthy: false,
        username: 'elchi_bot',
        reason: 'webhook (secret_token bilan)',
      },
      timestamp: HEALTH_REPLY.timestamp,
    });
    const json = JSON.stringify(toPublicNotificationHealth(HEALTH_REPLY));
    for (const field of [
      'checked_at',
      'error_kind',
      'error_status',
      'error_text',
      'restart_required',
      'ENOTFOUND',
    ]) {
      expect(json).not.toContain(field);
    }
  });

  it('bot yo‘q / obyekt emas — o‘zgarishsiz', () => {
    expect(toPublicNotificationHealth('ok')).toBe('ok');
    expect(toPublicNotificationHealth({ status: 'ok' })).toEqual({
      status: 'ok',
    });
  });
});
