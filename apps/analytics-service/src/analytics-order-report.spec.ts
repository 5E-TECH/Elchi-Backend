import { Order_status } from '@app/common';
import {
  AnalyticsServiceService,
  REPORT_READ_OPTIONS,
} from './analytics-service.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

/**
 * (W20LoskP) `/analytics/reports/orders` — status taqsimoti, viloyat va top
 * mahsulotlar order-service'dagi SQL GROUP BY agregatlaridan; `order.find_all`
 * sahifalash (100 sahifa → 10 000 qatorda JIM kesilish) YO'Q.
 */
const ADMIN = { id: '1', roles: ['admin'] };

/** 2026-01-01..2026-09-18 o'lchovidagi holat (kartadagi raqamlar). */
const DISTRIBUTION = {
  created: 3,
  new: 24,
  received: 9,
  'on the road': 5,
  waiting: 18,
  waiting_customer: 1,
  sold: 27,
  paid: 14,
  partly_paid: 0,
  cancelled: 11,
  'cancelled (sent)': 13,
  returned_to_market: 0,
  closed: 10,
};
const ACCEPTED = Object.values(DISTRIBUTION).reduce((a, b) => a + b, 0);

type Overrides = Partial<Record<string, unknown>>;

function route(overrides: Overrides = {}) {
  rmqSendMock.mockImplementation(
    (_client: unknown, pattern: { cmd: string }) => {
      if (pattern.cmd in overrides) {
        const value = overrides[pattern.cmd];
        return value instanceof Error
          ? Promise.reject(value)
          : Promise.resolve(value);
      }
      switch (pattern.cmd) {
        case 'order.analytics.overview':
          return Promise.resolve({ acceptedCount: ACCEPTED, total: ACCEPTED });
        case 'order.analytics.top_markets':
          return Promise.resolve({ items: [], min_orders: 1, filtered_out: 0 });
        case 'order.analytics.status_distribution':
          return Promise.resolve({
            distribution: DISTRIBUTION,
            total: ACCEPTED,
            applied_range: { clamped: false, max_span_days: 366 },
          });
        case 'order.analytics.by_region':
          return Promise.resolve({
            items: [
              { region_id: '7', total_orders: 12_000 },
              { region_id: 'unknown', total_orders: 50 },
            ],
            total: 12_050,
          });
        case 'order.analytics.top_products':
          return Promise.resolve({
            items: [{ product_id: '42', total_quantity: 30_000 }],
            limit: 10,
          });
        case 'order.find_all':
          throw new Error('hisobot order.find_all ni chaqirmasligi kerak');
        default:
          return Promise.resolve(null);
      }
    },
  );
}

const make = () =>
  new AnalyticsServiceService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

const cmds = () =>
  rmqSendMock.mock.calls.map(
    ([, pattern]: [unknown, { cmd: string }]) => pattern.cmd,
  );

describe('W20LoskP — buyurtmalar hisoboti SQL agregatlaridan', () => {
  beforeEach(() => rmqSendMock.mockReset());

  it('⭐ TC1: statusDistribution.waiting = 18 (ilgari kalit umuman yo`q edi)', async () => {
    route();
    const res: any = await make().getOrderReport(ADMIN, {
      fromDate: '2026-01-01',
      toDate: '2026-09-18',
    });
    expect(res.data.statusDistribution.waiting).toBe(18);
  });

  it('⭐ TC2: statusDistribution yig`indisi = overview.acceptedCount', async () => {
    route();
    const res: any = await make().getOrderReport(ADMIN, {
      fromDate: '2026-01-01',
      toDate: '2026-09-18',
    });
    const sum = Object.values(
      res.data.statusDistribution as Record<string, number>,
    ).reduce((a, b) => a + b, 0);
    expect(sum).toBe(res.data.overview.acceptedCount);
    expect(res.data.statusDistributionTotal).toBe(ACCEPTED);
  });

  it('⭐ TC3: Order_status enumidagi HAR BIR kalit bor (order-service bermasa ham 0)', async () => {
    route({
      'order.analytics.status_distribution': {
        distribution: { waiting: 18 },
        total: 18,
      },
    });
    const res: any = await make().getOrderReport(ADMIN, {});
    const keys = Object.keys(res.data.statusDistribution).sort();
    expect(keys).toEqual([...Object.values(Order_status)].sort());
    expect(res.data.statusDistribution.waiting).toBe(18);
    expect(res.data.statusDistribution[Order_status.CREATED]).toBe(0);
    expect(res.data.statusDistribution[Order_status.RETURNED_TO_MARKET]).toBe(
      0,
    );
  });

  it('⭐ TC4: byRegion / topProducts 10 000 dan katta qiymatlarni kesmaydi', async () => {
    route();
    const res: any = await make().getOrderReport(ADMIN, {});
    expect(res.data.byRegion).toEqual([
      { region_id: '7', total_orders: 12_000 },
      { region_id: 'unknown', total_orders: 50 },
    ]);
    expect(res.data.topProducts).toEqual([
      { product_id: '42', total_quantity: 30_000 },
    ]);
    expect(res.data.degraded).toBe(false);
  });

  it('⭐ TC5: order-service ga ≤ 5 ta RMQ chaqiruv (ilgari 9 + 100 gacha), hammasi parallel, find_all YO`Q', async () => {
    route();
    await make().getOrderReport(ADMIN, {
      fromDate: '2026-01-01',
      toDate: '2026-09-18',
    });
    expect(cmds().length).toBeLessThanOrEqual(5);
    expect(cmds()).not.toContain('order.find_all');
    expect(cmds().sort()).toEqual(
      [
        'order.analytics.by_region',
        'order.analytics.overview',
        'order.analytics.status_distribution',
        'order.analytics.top_markets',
        'order.analytics.top_products',
      ].sort(),
    );
    // Har biri bitta urinish, 8 s < gateway timeout(12000).
    for (const call of rmqSendMock.mock.calls) {
      expect(call[3]).toEqual(REPORT_READ_OPTIONS);
    }
    expect(REPORT_READ_OPTIONS.deadlineMs).toBeLessThan(12_000);
    // Oyna Toshkent kuni chegaralari bilan uzatiladi.
    const statusCall = rmqSendMock.mock.calls.find(
      ([, p]: [unknown, { cmd: string }]) =>
        p.cmd === 'order.analytics.status_distribution',
    );
    expect(statusCall?.[2]).toEqual({
      startDate: '2025-12-31T19:00:00.000Z',
      endDate: '2026-09-18T18:59:59.999Z',
    });
  });

  it('TC5: 5 ta chaqiruv KETMA-KET emas — sekin order-service bilan ham bitta bosqich', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    rmqSendMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return {};
    });
    await make().getOrderReport(ADMIN, {});
    expect(maxInFlight).toBe(5);
  });

  it('bo`lak olinmasa — jim nollar EMAS: statusDistribution null, degraded + failed_parts', async () => {
    route({
      'order.analytics.status_distribution': new Error('timeout'),
      'order.analytics.by_region': new Error('timeout'),
    });
    const res: any = await make().getOrderReport(ADMIN, {});
    expect(res.statusCode).toBe(200);
    expect(res.data.statusDistribution).toBeNull();
    expect(res.data.statusDistributionTotal).toBeNull();
    expect(res.data.byRegion).toEqual([]);
    expect(res.data.degraded).toBe(true);
    expect(res.data.failed_parts).toEqual(['byRegion', 'statusDistribution']);
  });

  it('applied_range (366 kunlik oyna) javobda ko`rinadi', async () => {
    route();
    const res: any = await make().getOrderReport(ADMIN, {});
    expect(res.data.applied_range).toEqual({
      clamped: false,
      max_span_days: 366,
    });
  });
});
