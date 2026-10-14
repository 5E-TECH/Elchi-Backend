import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTH_THROTTLE,
  AuthGatewayController,
} from './auth-gateway.controller';
import { IS_PUBLIC_KEY } from './auth/public.decorator';

/**
 * rkz0yBxr #3(b) — OTP endpointlarining IP limiti: YANGI guard yozilmagan,
 * mavjud global ClientIpThrottlerGuard + login'dagi AUTH_THROTTLE naqshi.
 * (Raqam bo'yicha limit — identity-service otp.service.spec.ts.)
 */
describe('OTP endpointlari — IP rate-limit (rkz0yBxr TC5)', () => {
  const handler = (name: keyof AuthGatewayController): object =>
    Object.getOwnPropertyDescriptor(AuthGatewayController.prototype, name)
      ?.value as object;
  const meta = (name: keyof AuthGatewayController, key: string): unknown =>
    Reflect.getMetadata(`THROTTLER:${key}default`, handler(name));

  it.each(['otpRequest', 'otpVerify'] as const)(
    '%s — login bilan bir xil AUTH_THROTTLE (limit + ttl), @Public',
    (name) => {
      expect(meta(name, 'LIMIT')).toBe(AUTH_THROTTLE.default.limit);
      expect(meta(name, 'TTL')).toBe(AUTH_THROTTLE.default.ttl);
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler(name))).toBe(true);
    },
  );

  it('IP tracker — global APP_GUARD sifatida mavjud ClientIpThrottlerGuard (CF-Connecting-IP)', () => {
    // Modulni import qilish env validatsiyasini ishga tushiradi — statik tekshiruv.
    const source = readFileSync(
      join(__dirname, 'api-gateway.module.ts'),
      'utf8',
    );
    expect(source).toMatch(
      /\{\s*provide:\s*APP_GUARD,\s*useClass:\s*ClientIpThrottlerGuard\s*\}/,
    );
    const guard = readFileSync(
      join(__dirname, 'auth', 'client-ip-throttler.guard.ts'),
      'utf8',
    );
    expect(guard).toMatch(/cf-connecting-ip/i);
  });
});
