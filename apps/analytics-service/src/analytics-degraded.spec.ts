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
});
