import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Roles as RoleEnum } from '@app/common';
import { AuditGatewayController } from './audit-gateway.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { IS_PUBLIC_KEY } from './auth/public.decorator';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';

/**
 * f2Ud5tju TC11 (backend qismi) — audit jurnali IP/qurilma (shaxsiy
 * ma'lumot) va moliyaviy izni ochadi: `/activity-logs` ning BARCHA yo'llari
 * FAQAT SUPERADMIN/ADMIN uchun. Gateway'da audit jurnalini o'qiydigan boshqa
 * HTTP yo'l yo'q (`*.activity_log.find_all|find_by_entity` faqat shu
 * controller'dan yuboriladi).
 *
 * Route ro'yxati prototype'dan olinadi — keyin qo'shilgan yangi yo'l ham
 * avtomatik tekshiruvga tushadi.
 */
describe('AuditGatewayController — ko`rish huquqi (f2Ud5tju TC11)', () => {
  const proto = AuditGatewayController.prototype as unknown as Record<
    string,
    unknown
  >;
  const routeHandlers = Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => ({ name, fn: proto[name] }))
    .filter(
      (h): h is { name: string; fn: (...args: unknown[]) => unknown } =>
        typeof h.fn === 'function' &&
        Reflect.getMetadata(METHOD_METADATA, h.fn) !== undefined,
    );

  const guard = new RolesGuard(new Reflector());
  const ctxFor = (
    handler: (...args: unknown[]) => unknown,
    roles: string[] | undefined,
  ) =>
    ({
      getHandler: () => handler,
      getClass: () => AuditGatewayController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { sub: '1', username: 'u', roles } }),
      }),
    }) as unknown as ExecutionContext;

  it('marshrutlar ro`yxati (yangi yo`l qo`shilsa shu spec yangilanadi)', () => {
    expect(routeHandlers.map((h) => h.name).sort()).toEqual([
      'actions',
      'entityHistory',
      'list',
      'userHistory',
    ]);
  });

  it('controller darajasida JwtAuthGuard + RolesGuard va faqat superadmin/admin', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      AuditGatewayController,
    ) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
    expect(Reflect.getMetadata(ROLES_KEY, AuditGatewayController)).toEqual([
      'superadmin',
      'admin',
    ]);
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, AuditGatewayController),
    ).toBeUndefined();
  });

  it('hech bir yo`l @Roles ni kengaytirmaydi va @Public emas', () => {
    for (const { name, fn } of routeHandlers) {
      // handler darajasidagi @Roles class'nikini USTIDAN yozadi
      // (getAllAndOverride) — shuning uchun umuman bo'lmasligi kerak.
      expect({ name, roles: Reflect.getMetadata(ROLES_KEY, fn) }).toEqual({
        name,
        roles: undefined,
      });
      expect({ name, pub: Reflect.getMetadata(IS_PUBLIC_KEY, fn) }).toEqual({
        name,
        pub: undefined,
      });
    }
  });

  it('har yo`lda: superadmin/admin o`tadi, qolgan BARCHA rollar 403', () => {
    const allowed = [RoleEnum.SUPERADMIN, RoleEnum.ADMIN] as string[];
    const denied = Object.values(RoleEnum).filter((r) => !allowed.includes(r));
    expect(denied.length).toBeGreaterThan(0);

    for (const { name, fn } of routeHandlers) {
      for (const role of allowed) {
        expect({
          name,
          role,
          ok: guard.canActivate(ctxFor(fn, [role])),
        }).toEqual({ name, role, ok: true });
      }
      for (const role of denied) {
        expect({
          name,
          role,
          ok: guard.canActivate(ctxFor(fn, [role])),
        }).toEqual({ name, role, ok: false });
      }
      // rolsiz token ham 403
      expect(guard.canActivate(ctxFor(fn, []))).toBe(false);
      expect(guard.canActivate(ctxFor(fn, undefined))).toBe(false);
    }
  });
});
