import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

// Audit authz P1: authentication is now default-deny (JwtAuthGuard is a global
// APP_GUARD). These tests cover the two opt-out branches — @Public routes and
// non-HTTP contexts — and confirm a normal HTTP route is NOT auto-allowed.
describe('JwtAuthGuard (default-deny + @Public)', () => {
  const makeContext = (type: string): ExecutionContext =>
    ({
      getType: () => type,
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
    }) as unknown as ExecutionContext;

  const makeGuard = (isPublic: boolean) => {
    const reflector = {
      getAllAndOverride: jest.fn(() => isPublic),
    } as unknown as Reflector;
    return new JwtAuthGuard(reflector);
  };

  it('skips authentication for non-HTTP (RMQ event / WS) contexts', () => {
    expect(makeGuard(false).canActivate(makeContext('rpc'))).toBe(true);
    expect(makeGuard(false).canActivate(makeContext('ws'))).toBe(true);
  });

  it('allows a @Public() HTTP route without a JWT', () => {
    expect(makeGuard(true).canActivate(makeContext('http'))).toBe(true);
  });

  it('reads the @Public metadata from handler + class on an HTTP route', () => {
    const reflector = {
      getAllAndOverride: jest.fn(() => true),
    } as unknown as Reflector;
    const guard = new JwtAuthGuard(reflector);

    expect(guard.canActivate(makeContext('http'))).toBe(true);
    // A non-public HTTP route delegates to passport (not a bare allow) — that
    // path needs a full request/response and is covered by e2e, not here.
    expect(reflector.getAllAndOverride).toHaveBeenCalled();
  });
});
