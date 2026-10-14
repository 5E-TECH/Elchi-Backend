import 'reflect-metadata';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { of } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import {
  attachRouteRoles,
  collectRouteRoles,
  ROUTE_ROLES_EXTENSION,
} from './auth/route-roles';
import { AuditGatewayController } from './audit-gateway.controller';
import { BranchGatewayController } from './branch-gateway.controller';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * lQP3ojwq / wLNccBkX — ops RBAC: backend ↔ UI.
 *
 * QAROR (backend ruxsatlari O'ZGARMADI — hech kim ruxsat yo'qotmaydi/olmaydi):
 *   - settlement lump-sum oyoqlari (courier-to-branch / branch-to-hq /
 *     hq-to-market) MlVMpsfr/uEPILERk dan beri HAMMA uchun 410 Gone; @Roles
 *     faqat kim 403 va kim 410 olishini belgilaydi;
 *   - transfer-batches/:id/cancel — branch-service'da manba filial
 *     menejeri/registratori bilan cheklangan (yaratish huquqi bilan bir xil);
 *   - /activity-logs — superadmin + admin.
 * Yagona manba: gateway @Roles → openapi `x-roles` (route-roles.ts) →
 * frontend ROUTE_ROLES generatsiyasi va CI drift darvozasi.
 */
const roleGuardUser = {
  canActivate: (ctx: ExecutionContext) => {
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const role = req.headers['x-test-role'];
    if (!role) return false;
    req.user = { sub: '21', username: 'u', roles: [role] };
    return true;
  },
};

describe('lQP3ojwq / wLNccBkX — ops endpointlari: qat’iy status kodlari', () => {
  let app: INestApplication;
  const orderSend = jest.fn(() => of({ statusCode: 200 }));
  const branchSend = jest.fn(() =>
    of({ statusCode: 200, message: 'Transfer batch cancelled', data: {} }),
  );
  const noop = { send: jest.fn(() => of({})) };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrderGatewayController, BranchGatewayController],
      providers: [
        { provide: 'ORDER', useValue: { send: orderSend } },
        { provide: 'IDENTITY', useValue: noop },
        { provide: 'LOGISTICS', useValue: noop },
        { provide: 'BRANCH', useValue: { send: branchSend } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(roleGuardUser)
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    orderSend.mockClear();
    branchSend.mockClear();
  });

  it.each([
    ['registrator', 'courier-to-branch', 410],
    ['manager', 'courier-to-branch', 410],
    ['manager', 'branch-to-hq', 410],
    ['registrator', 'branch-to-hq', 403],
    ['registrator', 'hq-to-market', 403],
    ['manager', 'hq-to-market', 403],
    ['market', 'courier-to-branch', 403],
    ['superadmin', 'hq-to-market', 410],
  ])(
    '%s → POST /orders/settlement/%s → %i (pul yo‘li o‘zgarmaydi)',
    async (role, leg, status) => {
      const res = await request(http())
        .post(`/orders/settlement/${leg}`)
        .set('x-test-role', role)
        .send({});
      expect(res.status).toBe(status);
      expect(orderSend).not.toHaveBeenCalled();
    },
  );

  it.each(['registrator', 'manager', 'branch', 'admin', 'superadmin'])(
    '%s → POST /transfer-batches/:id/cancel RolesGuard dan o‘tadi (201), doira branch-service’da',
    async (role) => {
      const res = await request(http())
        .post('/transfer-batches/5/cancel')
        .set('x-test-role', role)
        .send({ reason: 'Xato partiya yaratilgan edi' });
      expect(res.status).toBe(201);
      expect(branchSend).toHaveBeenCalledWith(
        { cmd: 'branch.transfer_batches.cancel' },
        {
          id: '5',
          dto: { reason: 'Xato partiya yaratilgan edi' },
          requester: { id: '21', roles: [role] },
        },
      );
    },
  );

  it.each(['market', 'courier', 'operator', 'investor', 'logist'])(
    '%s → POST /transfer-batches/:id/cancel → 403, branch-service chaqirilmaydi',
    async (role) => {
      const res = await request(http())
        .post('/transfer-batches/5/cancel')
        .set('x-test-role', role)
        .send({ reason: 'Xato partiya yaratilgan edi' });
      expect(res.status).toBe(403);
      expect(branchSend).not.toHaveBeenCalled();
    },
  );
});

describe('lQP3ojwq / wLNccBkX — route-roles xaritasi (openapi x-roles)', () => {
  const map = collectRouteRoles([
    OrderGatewayController,
    BranchGatewayController,
    AuditGatewayController,
  ]);

  it('ops endpointlarining rollari backend dekoratorlari bilan teng (jadval)', () => {
    expect({
      courierToBranch: map.get(
        'OrderGatewayController_settlementCourierToBranch',
      ),
      branchToHq: map.get('OrderGatewayController_settlementBranchToHq'),
      hqToMarket: map.get('OrderGatewayController_settlementHqToMarket'),
      cancelBatch: map.get('BranchGatewayController_cancelTransferBatch'),
    }).toEqual({
      courierToBranch: ['manager', 'registrator', 'superadmin', 'admin'],
      branchToHq: ['manager', 'superadmin', 'admin'],
      hqToMarket: ['superadmin', 'admin'],
      cancelBatch: ['superadmin', 'admin', 'branch', 'manager', 'registrator'],
    });
  });

  it('class darajasidagi @Roles (activity-logs) handler’ga meros bo‘ladi', () => {
    const auditEntries = Array.from(map.entries()).filter(([key]) =>
      key.startsWith('AuditGatewayController_'),
    );
    expect(auditEntries.length).toBeGreaterThan(0);
    for (const [, roles] of auditEntries) {
      expect(roles).toEqual(['superadmin', 'admin']);
    }
  });

  it('attachRouteRoles operationId bo‘yicha x-roles qo‘shadi; @Roles yo‘q → null', () => {
    const document = {
      paths: {
        '/transfer-batches/{id}/cancel': {
          post: { operationId: 'BranchGatewayController_cancelTransferBatch' },
          parameters: [],
        },
        '/unknown': { get: { operationId: 'Nope_nope' } },
        '/open': { get: { operationId: 'X_open' } },
      },
    };
    const tagged = attachRouteRoles(
      document as never,
      new Map([...map, ['X_open', null]] as Array<[string, string[] | null]>),
    );
    expect(tagged).toBe(2);
    const paths = document.paths as Record<string, Record<string, any>>;
    expect(
      paths['/transfer-batches/{id}/cancel'].post[ROUTE_ROLES_EXTENSION],
    ).toEqual(['superadmin', 'admin', 'branch', 'manager', 'registrator']);
    expect(paths['/open'].get[ROUTE_ROLES_EXTENSION]).toBeNull();
    expect(paths['/unknown'].get[ROUTE_ROLES_EXTENSION]).toBeUndefined();
  });
});
