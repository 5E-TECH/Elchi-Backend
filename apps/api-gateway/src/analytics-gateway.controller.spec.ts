import 'reflect-metadata';
import { of } from 'rxjs';

jest.mock('@app/common', () => ({
  Roles: {
    SUPERADMIN: 'superadmin',
    ADMIN: 'admin',
    COURIER: 'courier',
    REGISTRATOR: 'registrator',
    MARKET: 'market',
    CUSTOMER: 'customer',
    OPERATOR: 'operator',
    MARKET_OPERATOR: 'market_operator',
    MANAGER: 'manager',
    BRANCH: 'branch',
    INVESTOR: 'investor',
  },
}));

import { AnalyticsGatewayController } from './analytics-gateway.controller';
import { RolesGuard } from './auth/roles.guard';
import { ROLES_KEY } from './auth/roles.decorator';

describe('GET /analytics/dashboard — RolesGuard (ukulko6O, EgizXSKW)', () => {
  const handler = Object.getOwnPropertyDescriptor(
    AnalyticsGatewayController.prototype,
    'getDashboard',
  )?.value as object;

  it('⭐ RolesGuard ulangan (faqat JwtAuthGuard emas)', () => {
    const guards = Reflect.getMetadata('__guards__', handler) as unknown[];
    expect(guards).toContain(RolesGuard);
  });

  it('⭐ investor va customer ro`yxatda yo`q (→ 403), ish rollari bor', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[];
    expect(roles).not.toContain('investor');
    expect(roles).not.toContain('customer');
    expect(roles).toEqual(
      expect.arrayContaining([
        'superadmin',
        'admin',
        'manager',
        'registrator',
        'courier',
        'market',
        'market_operator',
      ]),
    );
  });
});

describe('AnalyticsGatewayController', () => {
  function setup() {
    const analyticsClient = { send: jest.fn() };
    const controller = new AnalyticsGatewayController(analyticsClient as any);
    analyticsClient.send.mockReturnValue(of({ statusCode: 200 }));
    const req = {
      user: {
        sub: '2',
        username: 'manager',
        roles: ['manager'],
        branch_id: '16',
      },
    } as any;

    return { analyticsClient, controller, req };
  }

  it('maps start_day and end_day aliases for dashboard', async () => {
    const { analyticsClient, controller, req } = setup();

    await controller.getDashboard(
      req,
      undefined,
      undefined,
      undefined,
      '2026-06-08',
      '2026-06-11',
    );

    expect(analyticsClient.send).toHaveBeenCalledWith(
      { cmd: 'analytics.dashboard' },
      {
        requester: {
          id: '2',
          roles: ['manager'],
          branch_id: '16',
        },
        filter: {
          startDate: '2026-06-08',
          endDate: '2026-06-11',
          period: undefined,
          all: false,
        },
      },
    );
  });

  it('prefers startDate and endDate over snake_case aliases', async () => {
    const { analyticsClient, controller, req } = setup();

    await controller.getDashboard(
      req,
      '2026-06-01',
      '2026-06-02',
      undefined,
      '2026-06-08',
      '2026-06-11',
    );

    expect(analyticsClient.send.mock.calls[0][1].filter).toEqual({
      startDate: '2026-06-01',
      endDate: '2026-06-02',
      period: undefined,
      all: false,
    });
  });
});
