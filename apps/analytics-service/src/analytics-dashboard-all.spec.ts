import { AnalyticsServiceService } from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

/**
 * (uN1tjjGu) "Barchasi" (`all=true`): (1) marketlar va kuryerlar jadvali
 * BO'SH qotirilmaydi; (2) order-service butun davrni eng so'nggi 366 kunga
 * qisqartiradi (audit C3) — javob buni `clamped`/`effective_*` va xabar bilan
 * aytadi, "butun davr" demaydi.
 */
const CLAMPED_ALL_RANGE = {
  requested_from: null,
  requested_to: null,
  applied_from: '2025-10-11T19:00:00.000Z',
  applied_to: '2026-10-12T08:00:00.000Z',
  clamped: true,
  max_span_days: 366,
};

describe('dashboard all-time range (uN1tjjGu)', () => {
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
        const responses: Record<string, unknown> = {
          'order.analytics.overview': {
            acceptedCount: 118,
            applied_range: CLAMPED_ALL_RANGE,
          },
          'order.analytics.market_stats': [
            { market: { id: '1', name: 'Market' }, totalOrders: 4 },
          ],
          'order.analytics.courier_stats': [
            { courier: { id: '2', name: 'Courier' }, totalOrders: 3 },
          ],
          'order.analytics.courier_stat': {
            totalOrders: 3,
            soldOrders: 2,
            applied_range: CLAMPED_ALL_RANGE,
          },
          'order.analytics.market_stat': {
            totalOrders: 4,
            applied_range: CLAMPED_ALL_RANGE,
          },
        };
        return Promise.resolve(responses[pattern.cmd] ?? []);
      });
  });

  it('⭐ TC1: all=true market va kuryer qatorlarini qaytaradi (literal [] emas)', async () => {
    const response = await make().getDashboard(
      { id: '1', roles: ['superadmin'] },
      { all: true },
    );
    const data = response.data as Record<string, unknown>;
    expect(data.markets).toHaveLength(1);
    expect(data.couriers).toHaveLength(1);
  });

  it('⭐ TC2/TC4: all=true — clamped/effective_* meta, xabar "oxirgi 366 kun" (butun davr EMAS)', async () => {
    const response = await make().getDashboard(
      { id: '1', roles: ['superadmin'] },
      { all: true },
    );
    const data = response.data as Record<string, unknown>;
    expect(data).toMatchObject({
      clamped: true,
      effective_from: CLAMPED_ALL_RANGE.applied_from,
      effective_to: CLAMPED_ALL_RANGE.applied_to,
      max_span_days: 366,
    });
    expect(response.message).toBe('Dashboard infos (oxirgi 366 kun)');
    expect(response.message).not.toMatch(/all time|barcha tarix/i);
  });

  it('all=true bayrog`i har bir order-service bo`lagiga uzatiladi (bir xil oyna)', async () => {
    await make().getDashboard(
      { id: '1', roles: ['superadmin'] },
      { all: true },
    );
    for (const cmd of [
      'order.analytics.overview',
      'order.analytics.market_stats',
      'order.analytics.courier_stats',
      'order.analytics.top_markets',
      'order.analytics.top_branches',
    ]) {
      expect(rmqSendMock).toHaveBeenCalledWith(
        expect.anything(),
        { cmd },
        expect.objectContaining({ all: true }),
        { timeoutMs: 2500, retries: 0, deadlineMs: 2500 },
      );
    }
  });

  it('kuryer va market dashboardi ham all=true da qisqartirishni aytadi', async () => {
    const courier = await make().getDashboard(
      { id: '2', roles: ['courier'] },
      { all: true },
    );
    expect(courier.data).toMatchObject({
      clamped: true,
      effective_from: CLAMPED_ALL_RANGE.applied_from,
    });
    expect(courier.message).toBe('Dashboard infos (oxirgi 366 kun)');

    const market = await make().getDashboard(
      { id: '1', roles: ['market'] },
      { all: true },
    );
    expect(market.data).toMatchObject({
      clamped: true,
      effective_to: CLAMPED_ALL_RANGE.applied_to,
    });
    expect(market.message).toBe('Dashboard infos (oxirgi 366 kun)');
  });

  it('oddiy sana oralig`ida all-time meta qo`shilmaydi (kontrakt o`zgarmagan)', async () => {
    const response = await make().getDashboard(
      { id: '1', roles: ['superadmin'] },
      { startDate: '2026-09-01', endDate: '2026-09-18' },
    );
    const data = response.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('clamped');
    expect(data).not.toHaveProperty('effective_from');
    expect(response.message).toBe('Dashboard infos');
  });
});
