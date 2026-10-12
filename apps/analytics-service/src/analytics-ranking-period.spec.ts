import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

describe('analytics ranking period propagation', () => {
  beforeEach(() => {
    rmqSendMock
      .mockReset()
      .mockImplementation(() => Promise.resolve({ data: [] }));
  });

  it('passes KPI range to top markets instead of asking for the last 30 days', async () => {
    const service = new AnalyticsServiceService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await service.getKpiStats(
      { id: '1', roles: ['superadmin'] },
      { startDate: '2026-01-01', endDate: '2026-01-31' },
    );
    expect(rmqSendMock).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.analytics.top_markets' },
      expect.objectContaining({
        startDate: expect.any(String),
        endDate: expect.any(String),
      }),
      { timeoutMs: 2500, retries: 0, deadlineMs: 2500 },
    );
  });
});
