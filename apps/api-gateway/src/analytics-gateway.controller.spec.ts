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

type GatewayReq = Parameters<AnalyticsGatewayController['getDashboard']>[0];

describe('6CYRjoZG — GET /analytics/dashboard?branch_id=', () => {
  function setup() {
    const analyticsClient = { send: jest.fn(() => of({ statusCode: 200 })) };
    const controller = new AnalyticsGatewayController(
      analyticsClient as unknown as ConstructorParameters<
        typeof AnalyticsGatewayController
      >[0],
    );
    const req: GatewayReq = {
      user: { sub: '1', username: 'sa', roles: ['superadmin'] },
    };
    return { analyticsClient, controller, req };
  }

  it('⭐ branch_id filter ichida servisga uzatiladi', async () => {
    const { analyticsClient, controller, req } = setup();
    await controller.getDashboard(
      req,
      '2026-10-18',
      '2026-10-24',
      undefined,
      undefined,
      undefined,
      undefined,
      ' 5 ',
    );
    const [pattern, payload] = analyticsClient.send.mock
      .calls[0] as unknown as [
      { cmd: string },
      { filter: Record<string, unknown> },
    ];
    expect(pattern).toEqual({ cmd: 'analytics.dashboard' });
    expect(payload.filter.branch_id).toBe('5');
  });

  it('branch_id yo`q — filter da kalit ham yo`q', async () => {
    const { analyticsClient, controller, req } = setup();
    await controller.getDashboard(req);
    const payload = (analyticsClient.send.mock.calls[0] as unknown[])[1] as {
      filter: Record<string, unknown>;
    };
    expect(payload.filter).not.toHaveProperty('branch_id');
  });

  it('noto`g`ri branch_id — 400, servisga yuborilmaydi', () => {
    const { analyticsClient, controller, req } = setup();
    expect(() =>
      controller.getDashboard(
        req,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'abc',
      ),
    ).toThrow("branch_id noto'g'ri");
    expect(analyticsClient.send).not.toHaveBeenCalled();
  });
});

describe('XdKajqLe — kpi/revenue ?all=true', () => {
  function setup() {
    const analyticsClient = { send: jest.fn(() => of({ statusCode: 200 })) };
    const controller = new AnalyticsGatewayController(
      analyticsClient as unknown as ConstructorParameters<
        typeof AnalyticsGatewayController
      >[0],
    );
    const req: GatewayReq = {
      user: { sub: '1', username: 'sa', roles: ['superadmin'] },
    };
    return { analyticsClient, controller, req };
  }
  const filterOf = (send: jest.Mock) =>
    (
      (send.mock.calls[0] as unknown[])[1] as {
        filter: Record<string, unknown>;
      }
    ).filter;

  it('⭐ kpi all=true → filter.all: true', async () => {
    const { analyticsClient, controller, req } = setup();
    await controller.getKpi(
      req,
      undefined,
      undefined,
      undefined,
      undefined,
      'true',
    );
    expect(filterOf(analyticsClient.send)).toMatchObject({ all: true });
  });

  it('⭐ revenue all=true → filter.all: true', async () => {
    const { analyticsClient, controller, req } = setup();
    await controller.getRevenue(
      req,
      undefined,
      undefined,
      'monthly',
      undefined,
      undefined,
      'true',
    );
    expect(filterOf(analyticsClient.send)).toMatchObject({
      all: true,
      period: 'monthly',
    });
  });

  it('all yo`q — kalit ham yo`q', async () => {
    const { analyticsClient, controller, req } = setup();
    await controller.getKpi(req);
    expect(filterOf(analyticsClient.send)).not.toHaveProperty('all');
  });
});
