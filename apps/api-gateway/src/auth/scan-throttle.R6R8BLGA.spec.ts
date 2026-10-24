import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  THROTTLER_SKIP,
  ThrottlerException,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import { OrderGatewayController } from '../order-gateway.controller';
import { ScanGatewayController } from '../scan-gateway.controller';
import { gatewayValidationSchema } from '@app/common';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';
import {
  SCAN_THROTTLE,
  SCAN_THROTTLE_LIMIT_DEFAULT,
  scanThrottleConfig,
} from './scan-throttle';

/**
 * R6R8BLGA — skaner route'lari: filial bitta IP ortida, ketma-ket kamera
 * skanida global 60/daqiqa/IP 429 berardi. Shu uch route'da 'default'
 * (per-IP) limiti yuqoriroq; @SkipThrottle YO'Q — anonim trafik ham cheklangan.
 */
/** Route handler (metama'lumoti bilan) — `this` siz, faqat kalit uchun. */
const handlerOf = (cls: { prototype: object }, name: string): object =>
  Object.getOwnPropertyDescriptor(cls.prototype, name)?.value as object;

describe('scanThrottleConfig (R6R8BLGA)', () => {
  it('sukut: 300 / 60 000 ms', () => {
    expect(scanThrottleConfig({})).toEqual({
      default: { limit: SCAN_THROTTLE_LIMIT_DEFAULT, ttl: 60_000 },
    });
    expect(SCAN_THROTTLE_LIMIT_DEFAULT).toBe(300);
  });

  it('SCAN_THROTTLE_LIMIT / SCAN_THROTTLE_TTL_MS env bilan', () => {
    expect(
      scanThrottleConfig({
        SCAN_THROTTLE_LIMIT: '500',
        SCAN_THROTTLE_TTL_MS: '30000',
      }),
    ).toEqual({ default: { limit: 500, ttl: 30_000 } });
  });

  it('global THROTTLE_LIMIT dan HECH QACHON past emas; TTL sukuti — global', () => {
    expect(
      scanThrottleConfig({
        THROTTLE_LIMIT: '1000',
        THROTTLE_TTL_MS: '120000',
        SCAN_THROTTLE_LIMIT: '200',
      }),
    ).toEqual({ default: { limit: 1000, ttl: 120_000 } });
  });

  it('bo‘sh / noto‘g‘ri qiymat — sukut', () => {
    for (const raw of ['', 'abc', '0', '-5']) {
      expect(
        scanThrottleConfig({ SCAN_THROTTLE_LIMIT: raw }).default.limit,
      ).toBe(300);
    }
  });
});

describe('gatewayValidationSchema — SCAN_THROTTLE_* (R6R8BLGA)', () => {
  const validate = (env: Record<string, unknown>) => {
    const result = gatewayValidationSchema.validate(env, {
      abortEarly: false,
      allowUnknown: true,
    });
    return {
      error: result.error,
      value: result.value as Record<string, unknown>,
    };
  };
  const scanErrors = (env: Record<string, unknown>) =>
    (validate(env).error?.details ?? []).filter((d) =>
      String(d.path[0]).startsWith('SCAN_'),
    );

  it('sukut 300 (kod bilan AYNI); qiymatsiz kalit boot’ni yiqitmaydi', () => {
    expect(validate({}).value.SCAN_THROTTLE_LIMIT).toBe(
      SCAN_THROTTLE_LIMIT_DEFAULT,
    );
    expect(
      scanErrors({ SCAN_THROTTLE_LIMIT: '', SCAN_THROTTLE_TTL_MS: '' }),
    ).toEqual([]);
    expect(
      validate({ SCAN_THROTTLE_LIMIT: '' }).value.SCAN_THROTTLE_LIMIT,
    ).toBe(300);
  });

  it('noto‘g‘ri qiymat — validatsiya xatosi', () => {
    expect(scanErrors({ SCAN_THROTTLE_LIMIT: '0' })).toHaveLength(1);
    expect(scanErrors({ SCAN_THROTTLE_TTL_MS: '10' })).toHaveLength(1);
  });
});

describe('skaner route’lari metama’lumoti (R6R8BLGA)', () => {
  const routes: Array<[string, object]> = [
    ['GET /scan/:token', handlerOf(ScanGatewayController, 'scan')],
    [
      'POST /orders/receive',
      handlerOf(OrderGatewayController, 'receiveNewOrders'),
    ],
    [
      'POST /orders/scan-assign',
      handlerOf(OrderGatewayController, 'scanAssignOrder'),
    ],
  ];

  it.each(routes)(
    '%s — SCAN_THROTTLE (per-IP, default), @SkipThrottle yo‘q',
    (_, handler) => {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(
        SCAN_THROTTLE.default.limit,
      );
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(
        SCAN_THROTTLE.default.ttl,
      );
      expect(
        Reflect.getMetadata(`${THROTTLER_SKIP}default`, handler),
      ).toBeUndefined();
    },
  );

  it('skaner kontrollerining boshqa route’lari global limitda qoladi', () => {
    const unrelated = Object.getOwnPropertyNames(
      ScanGatewayController.prototype,
    )
      .filter((name) => name !== 'scan' && name !== 'constructor')
      .map(
        (name) =>
          Object.getOwnPropertyDescriptor(ScanGatewayController.prototype, name)
            ?.value as object,
      )
      .filter((fn) => typeof fn === 'function');
    for (const fn of unrelated) {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', fn)).toBeUndefined();
    }
  });
});

describe('global ClientIpThrottlerGuard bilan (haqiqiy hisoblagich)', () => {
  const res = { header: jest.fn() };
  const makeGuard = async () => {
    const guard = new ClientIpThrottlerGuard(
      { throttlers: [{ name: 'default', ttl: 60_000, limit: 60 }] },
      new ThrottlerStorageService(),
      new Reflector(),
    );
    await guard.onModuleInit();
    return guard;
  };
  const ctx = (handler: object, ip: string): ExecutionContext =>
    ({
      getClass: () => ScanGatewayController,
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'cf-connecting-ip': ip }, ip }),
        getResponse: () => res,
      }),
    }) as unknown as ExecutionContext;

  it('⭐ bitta filial IP: 61-skan endi 429 emas; SCAN limitidan oshsa — 429', async () => {
    const guard = await makeGuard();
    const scan = handlerOf(ScanGatewayController, 'scan');
    for (let i = 0; i < SCAN_THROTTLE.default.limit; i++) {
      await expect(guard.canActivate(ctx(scan, '203.0.113.7'))).resolves.toBe(
        true,
      );
    }
    await expect(
      guard.canActivate(ctx(scan, '203.0.113.7')),
    ).rejects.toBeInstanceOf(ThrottlerException);
    // Boshqa IP — o'z hisoblagichi.
    await expect(guard.canActivate(ctx(scan, '198.51.100.9'))).resolves.toBe(
      true,
    );
  });

  it('skaner bo‘lmagan route — global 60/IP o‘zgarmagan', async () => {
    const guard = await makeGuard();
    const other = handlerOf(
      ScanGatewayController,
      'scanMarketCancelledHandover',
    );
    for (let i = 0; i < 60; i++) {
      await expect(guard.canActivate(ctx(other, '203.0.113.7'))).resolves.toBe(
        true,
      );
    }
    await expect(
      guard.canActivate(ctx(other, '203.0.113.7')),
    ).rejects.toBeInstanceOf(ThrottlerException);
  });
});
