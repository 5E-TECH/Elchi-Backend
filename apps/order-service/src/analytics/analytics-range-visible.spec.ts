import { OrderAnalyticsService } from './order-analytics.service';

describe('order analytics applied range', () => {
  const service = new OrderAnalyticsService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const ranges = service as unknown as {
    analyticsDateRange: (
      start: string,
      end: string,
      unbounded?: boolean,
    ) => {
      start: Date;
      end: Date;
      applied_range: {
        clamped: boolean;
        applied_from: string;
        max_span_days: number | null;
      };
    };
    resolveAnalyticsRange: (
      start: string | undefined,
      end: string | undefined,
      all: boolean,
    ) => {
      start: Date;
      end: Date;
      applied_range: {
        clamped: boolean;
        applied_from: string;
        max_span_days: number | null;
      };
    };
  };

  it('does not silently clamp a requested calendar year to 180 days', () => {
    const range = ranges.analyticsDateRange('2026-01-01', '2026-12-31');
    expect(range.start.toISOString()).toBe('2025-12-31T19:00:00.000Z');
    expect(range.applied_range.clamped).toBe(false);
  });

  it('all=true covers the whole history without the 366-day cap (uN1tjjGu)', () => {
    const range = ranges.resolveAnalyticsRange(undefined, undefined, true);
    expect(range.applied_range.clamped).toBe(false);
    expect(range.start.toISOString()).toBe('1969-12-31T19:00:00.000Z');
    expect(range.applied_range.applied_from).toBe(range.start.toISOString());
    expect(range.applied_range.max_span_days).toBeNull();
  });

  it('does not cap the all-time market/courier/ranking SQL range', () => {
    const range = ranges.analyticsDateRange('1970-01-01', '2026-10-12', true);
    expect(range.start.toISOString()).toBe('1969-12-31T19:00:00.000Z');
    expect(range.applied_range.clamped).toBe(false);
  });

  it('starts a clamped window at a full Tashkent day, without a 1-ms chart bucket', () => {
    const range = ranges.analyticsDateRange('1970-01-01', '2026-10-12');
    expect(range.start.toISOString()).toBe('2025-10-11T19:00:00.000Z');
    expect(range.applied_range.clamped).toBe(true);
  });
});
