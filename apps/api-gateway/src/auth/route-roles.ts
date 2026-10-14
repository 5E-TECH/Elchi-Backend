import { ROLES_KEY } from './roles.decorator';

/**
 * lQP3ojwq / wLNccBkX — RBAC'ning YAGONA manbasi: gateway `@Roles`.
 *
 * Frontend ops marshrutlarini (`canViewOpsPages`, menyu) qo'lda yozilgan rol
 * ro'yxatlari bilan qulflardi va backend dekoratorlaridan jimgina siljib
 * ketardi. Endi `npm run openapi:generate` har operatsiyaga `x-roles`
 * kengaytmasini qo'shadi (shu yerdagi xarita); frontend ROUTE_ROLES ni
 * openapi.json dan generatsiya qiladi va CI'da farq bo'lsa build yiqiladi.
 *
 * Kalit — Nest swagger'ning standart operationId'si: `<Controller>_<method>`.
 * Qiymat — handler'dagi `@Roles` (bo'lmasa class'dagi; RolesGuard'ning
 * `getAllAndOverride` tartibi bilan bir xil), kichik harfda. `null` —
 * `@Roles` yo'q: RolesGuard bunday marshrutni HAR QANDAY autentifikatsiyadan
 * o'tgan foydalanuvchiga ochadi.
 */
export const ROUTE_ROLES_EXTENSION = 'x-roles';

type ControllerClass = { name: string; prototype: object };

const normalizeRoles = (roles: unknown): string[] | null => {
  if (!Array.isArray(roles) || roles.length === 0) {
    return null;
  }
  return Array.from(
    new Set(
      roles
        .map((role) =>
          String(role ?? '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  );
};

export function collectRouteRoles(
  controllers: ControllerClass[],
): Map<string, string[] | null> {
  const map = new Map<string, string[] | null>();
  for (const controller of controllers) {
    const classRoles: unknown = Reflect.getMetadata(ROLES_KEY, controller);
    const proto = controller.prototype as Record<string, unknown>;
    for (const methodName of Object.getOwnPropertyNames(proto)) {
      if (methodName === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, methodName);
      if (typeof descriptor?.value !== 'function') continue;
      const handlerRoles: unknown = Reflect.getMetadata(
        ROLES_KEY,
        descriptor.value as object,
      );
      map.set(
        `${controller.name}_${methodName}`,
        normalizeRoles(handlerRoles) ?? normalizeRoles(classRoles),
      );
    }
  }
  return map;
}

type OpenApiLike = {
  paths?: Record<string, Record<string, unknown> | undefined>;
};

const HTTP_METHODS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
]);

/**
 * Har operatsiyaga `x-roles: string[] | null` qo'shadi. Qaytaradi: nechta
 * operatsiya belgilandi (operationId xaritada topilgani).
 */
export function attachRouteRoles(
  document: OpenApiLike,
  routeRoles: Map<string, string[] | null>,
): number {
  let tagged = 0;
  for (const pathItem of Object.values(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method) || !operation) continue;
      const op = operation as Record<string, unknown>;
      const operationId =
        typeof op.operationId === 'string' ? op.operationId : '';
      if (!routeRoles.has(operationId)) continue;
      op[ROUTE_ROLES_EXTENSION] = routeRoles.get(operationId) ?? null;
      tagged += 1;
    }
  }
  return tagged;
}
