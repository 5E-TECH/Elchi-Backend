import 'reflect-metadata';
import { of } from 'rxjs';

jest.mock('@app/common', () => ({
  Roles: {
    SUPERADMIN: 'superadmin',
    ADMIN: 'admin',
  },
}));

import { AnalyticsGatewayController } from './analytics-gateway.controller';

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
    });
  });
});
