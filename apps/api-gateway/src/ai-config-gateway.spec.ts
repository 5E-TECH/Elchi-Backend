import 'reflect-metadata';
import {
  GatewayTimeoutException,
  HttpException,
  RequestMethod,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ClientProxy } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { NEVER, of, throwError } from 'rxjs';
import {
  AI_CONFIG_ERROR_CODES,
  AI_CONFIG_ERROR_STATUS,
  RMQ_GATEWAY_TIMEOUT,
  publicErrorFields,
  requestContext,
} from '@app/common';
import { scrubSentryEvent } from '@app/common/sentry/scrub-pii';
import { AiConfigGatewayController } from './ai-config-gateway.controller';
import { AiConfigKeyThrottlerGuard } from './auth/ai-config-key-throttler.guard';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { AiKeySetDto } from './dto/ai-config.dto';
import { CORS_ALLOWED_HEADERS } from './gateway-http.setup';
import type { AiStatusPoller } from './ai/ai-status.poller';

/** be-brief §8 / §12 — `/ai/config*` gateway. Kalitlar soxta. */
const FAKE_KEY = 'sk-ant-api03-' + 'x'.repeat(40);
const B64 = (n: number) => 'A'.repeat(n);
const ENVELOPE = {
  v: 1,
  kid: '0123456789abcdef',
  alg: 'RSA-OAEP-256+A256GCM',
  ek: B64(512),
  iv: B64(16),
  ct: B64(80),
};
const req = { user: { sub: 7, roles: ['SUPERADMIN'] } };

function make(send: jest.Mock) {
  const poller = { refreshNow: jest.fn() };
  const ctl = new AiConfigGatewayController(
    { send } as unknown as ClientProxy,
    poller as unknown as AiStatusPoller,
  );
  return { ctl, poller };
}

const routes: Array<[string, RequestMethod, string, boolean]> = [
  ['get', RequestMethod.GET, '/', false],
  ['setKey', RequestMethod.PUT, 'key', true],
  ['verifyKey', RequestMethod.POST, 'key/verify', true],
  ['restoreKey', RequestMethod.POST, 'key/restore-previous', true],
  ['deactivateKey', RequestMethod.POST, 'key/deactivate', true],
  ['forgetPrevious', RequestMethod.DELETE, 'key/previous', true],
  ['history', RequestMethod.GET, 'history', false],
];

describe('AiConfigGatewayController', () => {
  it('marshrutlar: ai/config, FAQAT superadmin (ADMIN 403), Jwt + Roles; kalit yo‘llarida throttle', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiConfigGatewayController)).toBe(
      'ai/config',
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AiConfigGatewayController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, AiConfigGatewayController)).toEqual([
      'superadmin',
    ]);
    const proto = AiConfigGatewayController.prototype as unknown as Record<
      string,
      object
    >;
    for (const [name, method, path, throttled] of routes) {
      const h = proto[name];
      expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, h)).toBe(path);
      expect(Reflect.getMetadata(ROLES_KEY, h)).toBeUndefined(); // sinf darajasi qo'llanadi
      const guards = (Reflect.getMetadata(GUARDS_METADATA, h) ??
        []) as unknown[];
      expect(guards.includes(AiConfigKeyThrottlerGuard)).toBe(throttled);
    }
    expect(CORS_ALLOWED_HEADERS).toContain('X-Step-Up-Token');
  });

  it('PUT key: payload — requester, konvert, sent_at; api_key maydoni YO‘Q; javob {statusCode,message,data}; refreshNow', async () => {
    const send = jest.fn().mockReturnValue(of({ ok: true, data: { v: 1 } }));
    const { ctl, poller } = make(send);
    const dto = plainToInstance(AiKeySetDto, {
      key_envelope: ENVELOPE,
      label: 'Staging',
      version: 3,
    });
    const before = Date.now();
    const out = await requestContext.run(
      { traceId: 't', userName: 'Ega' },
      () => ctl.setKey(dto, req),
    );
    expect(out).toEqual({
      statusCode: 200,
      message: 'success',
      data: { v: 1 },
    });
    const [pattern, payload] = send.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(pattern).toEqual({ cmd: 'ai.config.key.set' });
    expect(payload).toMatchObject({
      requester: { id: '7', roles: ['superadmin'], name: 'Ega' },
      key_envelope: ENVELOPE,
      label: 'Staging',
      version: 3,
      step_up: false,
    });
    expect(payload.sent_at).toBeGreaterThanOrEqual(before);
    expect(JSON.stringify(payload)).not.toContain('api_key');
    expect(poller.refreshNow).toHaveBeenCalledTimes(1);
  });

  it('GET: refreshNow chaqirilmaydi; history limit/cursor uzatiladi', async () => {
    const send = jest.fn().mockReturnValue(of({ ok: true, data: {} }));
    const { ctl, poller } = make(send);
    await ctl.get(req);
    await ctl.history(req, '5', 'abc');
    expect(poller.refreshNow).not.toHaveBeenCalled();
    expect(send.mock.calls[1][1]).toMatchObject({ limit: 5, cursor: 'abc' });
  });

  it('{ok:false} → HttpException: status, code va FAQAT oq ro‘yxat maydonlari', async () => {
    const send = jest.fn().mockReturnValue(
      of({
        ok: false,
        error: {
          statusCode: 409,
          message: 'Versiya',
          code: 'AI_CONFIG_CONFLICT',
          version: 5,
          secret_enc: 'enc:gcm:v1:zz',
          field: 'x',
        },
      }),
    );
    const { ctl, poller } = make(send);
    const err = await ctl
      .restoreKey({ version: 1 }, req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    const http = err as HttpException;
    expect(http.getStatus()).toBe(409);
    expect(http.getResponse()).toEqual({
      statusCode: 409,
      message: 'Versiya',
      code: 'AI_CONFIG_CONFLICT',
      version: 5,
    });
    expect(publicErrorFields(http.getResponse())).toEqual({
      code: 'AI_CONFIG_CONFLICT',
      version: 5,
    });
    expect(poller.refreshNow).not.toHaveBeenCalled();
  });

  it('hech bir kod 401 bilan chiqmaydi; noma’lum kod/401 → 500 kodsiz', async () => {
    for (const code of Object.values(AI_CONFIG_ERROR_CODES)) {
      expect(AI_CONFIG_ERROR_STATUS[code]).not.toBe(401);
    }
    for (const error of [
      { statusCode: 401, message: 'x', code: 'AI_KEY_REJECTED' },
      { statusCode: 400, message: 'x', code: 'PG_23505' },
      {},
    ]) {
      const send = jest.fn().mockReturnValue(of({ ok: false, error }));
      const err = (await make(send)
        .ctl.get(req)
        .catch((e: unknown) => e)) as HttpException;
      expect(err.getStatus()).not.toBe(401);
      const body = err.getResponse() as Record<string, unknown>;
      if (error.code !== 'AI_KEY_REJECTED') expect(body.code).toBeUndefined();
    }
  });

  it('timeout → 504 kodsiz (RMQ_GATEWAY_TIMEOUT), qayta yuborish yo‘q', async () => {
    jest.useFakeTimers();
    try {
      const send = jest.fn().mockReturnValue(NEVER);
      const p = make(send)
        .ctl.verifyKey(req)
        .catch((e: unknown) => e);
      jest.advanceTimersByTime(RMQ_GATEWAY_TIMEOUT + 1);
      const err = await p;
      expect(err).toBeInstanceOf(GatewayTimeoutException);
      expect((err as HttpException).getResponse()).not.toHaveProperty('code');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('transport xatosi → 502 (xabar matni tashqariga chiqmaydi)', async () => {
    const send = jest
      .fn()
      .mockReturnValue(throwError(() => new Error(`boom ${FAKE_KEY}`)));
    const err = (await make(send)
      .ctl.get(req)
      .catch((e: unknown) => e)) as HttpException;
    expect(err.getStatus()).toBe(502);
    expect(JSON.stringify(err.getResponse())).not.toContain(FAKE_KEY);
  });

  it('DTO: shakl/hajm; noma’lum maydon (api_key) rad; xabarlar qiymatni takrorlamaydi', async () => {
    const ok = await validate(
      plainToInstance(AiKeySetDto, { key_envelope: ENVELOPE, version: 1 }),
      {
        whitelist: true,
        forbidNonWhitelisted: true,
      },
    );
    expect(ok).toEqual([]);
    for (const body of [
      { key_envelope: { ...ENVELOPE, ek: B64(10) }, version: 1 },
      { key_envelope: { ...ENVELOPE, iv: 'a+b/' + B64(12) }, version: 1 },
      { key_envelope: { ...ENVELOPE, alg: 'RSA1_5' }, version: 1 },
      { key_envelope: { ...ENVELOPE, v: 2 }, version: 1 },
      { key_envelope: ENVELOPE, version: 0 },
      { key_envelope: ENVELOPE, version: 1, api_key: FAKE_KEY },
      { key_envelope: { ...ENVELOPE, api_key: FAKE_KEY }, version: 1 },
      { key_envelope: ENVELOPE, version: 1, label: FAKE_KEY + 'x'.repeat(30) },
    ]) {
      const errors = await validate(plainToInstance(AiKeySetDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errors.length).toBeGreaterThan(0);
      const text = JSON.stringify(
        errors.map((e) => [
          e.constraints,
          e.children?.map((c) => c.constraints),
        ]),
      );
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain('sk-ant-');
    }
  });

  it('Sentry: majburiy 502/503/504 da PUT /ai/config/key tanasi va sk-ant- chiqmaydi', () => {
    for (const status of [502, 503, 504]) {
      const event = scrubSentryEvent({
        message: `HTTP ${status} on PUT /ai/config/key ${FAKE_KEY}`,
        request: {
          url: 'https://api.elchi.uz/v1/ai/config/key',
          data: { key_envelope: ENVELOPE, label: FAKE_KEY },
        },
        exception: { values: [{ value: `upstream ${status} ${FAKE_KEY}` }] },
        extra: { body: { key_envelope: ENVELOPE } },
      });
      const out = JSON.stringify(event);
      expect(out).not.toContain(FAKE_KEY);
      expect(event.request).not.toHaveProperty('data');
    }
  });
});
