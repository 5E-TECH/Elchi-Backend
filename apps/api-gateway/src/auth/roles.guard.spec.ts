import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from './roles.decorator';

// Audit P1 (Testing): RolesGuard is the single authorization enforcement point
// for the whole gateway, yet it previously had no test and no gateway test ever
// executed its canActivate. These tests cover the decision matrix directly.
describe('RolesGuard', () => {
  const makeContext = (user: unknown): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as unknown as ExecutionContext;

  const makeGuard = (requiredRoles: string[] | undefined) => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) =>
        key === ROLES_KEY ? requiredRoles : undefined,
      ),
    } as unknown as Reflector;
    return new RolesGuard(reflector);
  };

  it('allows the route when no roles are required (open route)', () => {
    expect(makeGuard(undefined).canActivate(makeContext(undefined))).toBe(true);
    expect(makeGuard([]).canActivate(makeContext({ roles: [] }))).toBe(true);
  });

  it('denies when the route requires a role but the user has none', () => {
    expect(makeGuard(['admin']).canActivate(makeContext(undefined))).toBe(
      false,
    );
    expect(makeGuard(['admin']).canActivate(makeContext({ roles: [] }))).toBe(
      false,
    );
  });

  it('allows when the user holds a required role (case/space-insensitive)', () => {
    expect(
      makeGuard(['admin']).canActivate(makeContext({ roles: ['  ADMIN '] })),
    ).toBe(true);
    expect(
      makeGuard(['superadmin', 'admin']).canActivate(
        makeContext({ roles: ['manager', 'admin'] }),
      ),
    ).toBe(true);
  });

  it('denies when the user holds only non-matching roles', () => {
    expect(
      makeGuard(['superadmin', 'admin']).canActivate(
        makeContext({ roles: ['courier', 'market'] }),
      ),
    ).toBe(false);
  });
});
