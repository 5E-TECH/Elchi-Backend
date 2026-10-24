import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock(
  '@app/common',
  (): Record<string, unknown> => ({
    ...jest.requireActual<Record<string, unknown>>('@app/common'),
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  }),
);

/**
 * (yrLt5oMi) KPI javobida `onTimeRate` bilan birga `deliveryCount`:
 * yetkazish bo'lmagan davrda FE «0% · past» emas, «O'lchanmagan» chizadi.
 */
const make = () =>
  new AnalyticsServiceService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

function route(fulfillment: unknown) {
  rmqSendMock.mockImplementation(
    (_client: unknown, pattern: { cmd: string }) => {
      if (pattern.cmd === 'order.analytics.overview') {
        return Promise.resolve({ acceptedCount: 5, soldAndPaid: 0 });
      }
      if (pattern.cmd === 'order.analytics.fulfillment_stats') {
        return fulfillment instanceof Error
          ? Promise.reject(fulfillment)
          : Promise.resolve(fulfillment);
      }
      return Promise.resolve({ data: [] });
    },
  );
}

describe('yrLt5oMi — KPI deliveryCount', () => {
  beforeEach(() => rmqSendMock.mockReset());

  it('yetkazish bor — deliveryCount va onTimeRate birga', async () => {
    route({ deliveredCount: 4, deliveryMsTotal: 43200000, onTimeCount: 3 });
    const res = (await make().getKpiStats(
      { id: '1', roles: ['admin'] },
      { startDate: '2026-10-01', endDate: '2026-10-07' },
    )) as { data: Record<string, unknown> };
    expect(res.data).toMatchObject({ deliveryCount: 4, onTimeRate: 75 });
  });

  it('⭐ yetkazish yo`q — deliveryCount: 0 (FE «O`lchanmagan»), onTimeRate raqamligicha 0', async () => {
    route({ deliveredCount: 0, deliveryMsTotal: 0, onTimeCount: 0 });
    const res = (await make().getKpiStats(
      { id: '1', roles: ['superadmin'] },
      {},
    )) as { data: Record<string, unknown> };
    expect(res.data.deliveryCount).toBe(0);
    expect(res.data.onTimeRate).toBe(0);
  });

  it('fulfillment bo`lagi tushsa — deliveryCount 0, degraded', async () => {
    route(new Error('timeout'));
    const res = (await make().getKpiStats(
      { id: '1', roles: ['admin'] },
      {},
    )) as { data: Record<string, unknown> };
    expect(res.data).toMatchObject({
      deliveryCount: 0,
      degraded: true,
      failed_parts: ['fulfillment'],
    });
  });

  it('rol: market KPI ni ololmaydi (403)', async () => {
    route({ deliveredCount: 1, deliveryMsTotal: 1, onTimeCount: 1 });
    await expect(
      make().getKpiStats({ id: '9', roles: ['market'] }, {}),
    ).rejects.toBeDefined();
  });
});
