import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

describe('dashboard all-time range', () => {
  beforeEach(() => {
    rmqSendMock
      .mockReset()
      .mockImplementation((_client: unknown, pattern: { cmd: string }) => {
        const responses: Record<string, unknown> = {
          'order.analytics.overview': {
            acceptedCount: 118,
            applied_range: {
              clamped: false,
              applied_from: '1969-12-31T19:00:00.000Z',
              applied_to: '2026-10-12T08:00:00.000Z',
            },
          },
          'order.analytics.market_stats': [
            { market: { id: '1', name: 'Market' }, totalOrders: 4 },
          ],
          'order.analytics.courier_stats': [
            { courier: { id: '2', name: 'Courier' }, totalOrders: 3 },
          ],
        };
        return Promise.resolve(responses[pattern.cmd] ?? []);
      });
  });

  it('returns market/courier rows and the full-history window for all=true', async () => {
    const service = new AnalyticsServiceService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const response = await service.getDashboard(
      { id: '1', roles: ['superadmin'] },
      { all: true },
    );
    const data = response.data as Record<string, unknown>;
    expect(data.markets).toHaveLength(1);
    expect(data.couriers).toHaveLength(1);
    expect(data.clamped).toBe(false);
    expect(data.effective_from).toBe('1969-12-31T19:00:00.000Z');
    expect(rmqSendMock).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.analytics.overview' },
      expect.objectContaining({ all: true }),
      { timeoutMs: 2500, retries: 0, deadlineMs: 2500 },
    );
    expect(response.message).toMatch(/barcha tarix/i);
  });
});
