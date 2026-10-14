import { RpcException } from '@nestjs/microservices';
import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

describe('analytics downstream failures', () => {
  const requester = { id: '1', roles: ['superadmin'] };
  const make = () =>
    new AnalyticsServiceService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  beforeEach(() => {
    rmqSendMock
      .mockReset()
      .mockImplementation((_client: unknown, pattern: { cmd: string }) => {
        if (pattern.cmd === 'order.analytics.overview') {
          return Promise.resolve({ data: { acceptedCount: 4 } });
        }
        return Promise.resolve({ data: [] });
      });
  });

  it('returns 503 when the dashboard overview is unavailable', async () => {
    rmqSendMock.mockImplementation(
      (_client: unknown, pattern: { cmd: string }) =>
        pattern.cmd === 'order.analytics.overview'
          ? Promise.reject(new Error('order down'))
          : Promise.resolve({ data: [] }),
    );
    await expect(make().getDashboard(requester, {})).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('identifies failed optional parts instead of presenting false zeroes', async () => {
    rmqSendMock.mockImplementation(
      (_client: unknown, pattern: { cmd: string }) =>
        pattern.cmd === 'order.analytics.market_stats'
          ? Promise.reject(new Error('markets down'))
          : Promise.resolve({ data: [] }),
    );
    const response = await make().getDashboard(requester, {});
    expect(response.data).toMatchObject({
      degraded: true,
      failed_parts: ['markets'],
    });
    const call = rmqSendMock.mock.calls.find(
      ([, pattern]: [unknown, { cmd: string }]) =>
        pattern.cmd === 'order.analytics.overview',
    );
    expect(call?.[3]).toEqual({
      timeoutMs: 2500,
      retries: 0,
      deadlineMs: 2500,
    });
  });

  // (VkwhHqvW) Rol doirasi aniqlanmasa soxta raqam emas — 503.
  it('menejer filiali aniqlanmasa (branch-service xatosi) — kompaniya bo`yicha raqam EMAS, 503', async () => {
    rmqSendMock.mockImplementation(
      (_client: unknown, pattern: { cmd: string }) =>
        pattern.cmd === 'branch.user.find_by_user'
          ? Promise.reject(new Error('branch down'))
          : Promise.resolve({ data: { acceptedCount: 99 } }),
    );
    await expect(
      make().getDashboard({ id: '2', roles: ['manager'] }, {}),
    ).rejects.toMatchObject({ error: { statusCode: 503 } });
    expect(
      rmqSendMock.mock.calls.some(
        ([, pattern]: [unknown, { cmd: string }]) =>
          pattern.cmd === 'order.analytics.overview',
      ),
    ).toBe(false);
  });

  it('market operatorining marketi aniqlanmasa (identity xatosi) — soxta nollar EMAS, 503', async () => {
    rmqSendMock.mockImplementation(
      (_client: unknown, pattern: { cmd: string }) =>
        pattern.cmd === 'identity.user.find_by_id'
          ? Promise.reject(new Error('identity down'))
          : Promise.resolve({ data: { totalOrders: 0 } }),
    );
    await expect(
      make().getDashboard({ id: '4', roles: ['market_operator'] }, {}),
    ).rejects.toMatchObject({ error: { statusCode: 503 } });
  });

  it('filial dashboard`i tushsa — branchDashboard failed_parts da, qolgani 200', async () => {
    rmqSendMock.mockImplementation(
      (_client: unknown, pattern: { cmd: string }) =>
        pattern.cmd === 'branch.dashboard'
          ? Promise.reject(new Error('branch down'))
          : Promise.resolve(
              pattern.cmd === 'order.analytics.overview'
                ? { acceptedCount: 4 }
                : { data: [] },
            ),
    );
    const response = await make().getDashboard(
      { id: '3', roles: ['registrator'], branch_id: '16' },
      {},
    );
    expect(response.data).toMatchObject({
      degraded: true,
      failed_parts: ['branchDashboard'],
      branchDashboard: null,
    });
  });

  it('kuryer reytingi tushsa — myStat bor, failed_parts: [topCouriers]', async () => {
    rmqSendMock.mockImplementation(
      (_client: unknown, pattern: { cmd: string }) =>
        pattern.cmd === 'order.analytics.top_couriers'
          ? Promise.reject(new Error('timeout'))
          : Promise.resolve({ data: { totalOrders: 3, soldOrders: 2 } }),
    );
    const response = await make().getDashboard(
      { id: '6', roles: ['courier'] },
      {},
    );
    expect(response.data).toMatchObject({
      degraded: true,
      failed_parts: ['topCouriers'],
      topCouriers: [],
      myRank: null,
    });
  });
});
