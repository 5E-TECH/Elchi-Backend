import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PASSWORD_CHANGE_REQUIRED } from '@app/common';
import {
  ALLOW_DURING_PASSWORD_CHANGE_KEY,
  PasswordChangeGuard,
  isPasswordChangeGateEnabled,
} from './password-change.guard';
import { AuthGatewayController } from '../auth-gateway.controller';

/**
 * (NDmZMzCP) `pwd_change` claim'li token: darvoza yoqilganda faqat parol
 * almashtirish oqimi; o'chiq (sukut) — avvalgidek hamma narsa ochiq.
 */
describe('NDmZMzCP — PasswordChangeGuard', () => {
  const ctx = (
    user: Record<string, unknown> | undefined,
    handler: () => void = () => undefined,
  ) =>
    ({
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => class Dummy {},
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  const guard = (gate: string | undefined) =>
    new PasswordChangeGuard(new Reflector(), {
      get: () => gate,
    } as never);

  it('flag yo‘q — har doim o‘tadi (darvoza yoqilgan bo‘lsa ham)', () => {
    expect(guard('on').canActivate(ctx({ sub: '1' }))).toBe(true);
    expect(guard('on').canActivate(ctx(undefined))).toBe(true);
  });

  it('darvoza O‘CHIQ (sukut) — pwd_change bilan ham o‘tadi', () => {
    expect(guard(undefined).canActivate(ctx({ pwd_change: true }))).toBe(true);
    expect(guard('off').canActivate(ctx({ pwd_change: true }))).toBe(true);
  });

  it('darvoza yoqilgan — oddiy route 403 PASSWORD_CHANGE_REQUIRED', () => {
    let error: unknown;
    try {
      guard('on').canActivate(ctx({ pwd_change: true }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      statusCode: 403,
      code: PASSWORD_CHANGE_REQUIRED,
    });
  });

  it('darvoza yoqilgan — @AllowDuringPasswordChange route o‘tadi', () => {
    const handler = () => undefined;
    Reflect.defineMetadata(ALLOW_DURING_PASSWORD_CHANGE_KEY, true, handler);
    expect(guard('on').canActivate(ctx({ pwd_change: true }, handler))).toBe(
      true,
    );
  });

  it('parol almashtirish oqimi route’lari belgilangan: my-profile (GET/PATCH), validate, logout', () => {
    const proto = AuthGatewayController.prototype as unknown as Record<
      string,
      () => void
    >;
    for (const name of ['myProfile', 'updateMyProfile', 'validate', 'logout']) {
      expect(
        Reflect.getMetadata(ALLOW_DURING_PASSWORD_CHANGE_KEY, proto[name]),
      ).toBe(true);
    }
    for (const name of [
      'mySessions',
      'revokeOtherSessions',
      'updateMySettings',
    ]) {
      expect(
        Reflect.getMetadata(ALLOW_DURING_PASSWORD_CHANGE_KEY, proto[name]),
      ).toBeUndefined();
    }
  });

  it('isPasswordChangeGateEnabled: on/true/1/yes', () => {
    for (const value of ['on', 'TRUE', '1', 'yes']) {
      expect(isPasswordChangeGateEnabled(value)).toBe(true);
    }
    for (const value of [undefined, '', 'off', '0', 'false']) {
      expect(isPasswordChangeGateEnabled(value)).toBe(false);
    }
  });
});
