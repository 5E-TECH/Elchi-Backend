import { computeDiff } from './diff';

describe('computeDiff', () => {
  it('returns empty diff when nothing changed', () => {
    const d = computeDiff(
      { id: '1', status: 'NEW', amount: 100 },
      { id: '1', status: 'NEW', amount: 100 },
    );
    expect(d).toEqual({ before: {}, after: {} });
  });

  it('captures only the changed fields', () => {
    const d = computeDiff(
      { id: '1', status: 'NEW', amount: 100, courier_id: null },
      { id: '1', status: 'SOLD', amount: 100, courier_id: 'c1' },
    );
    expect(d).toEqual({
      before: { status: 'NEW', courier_id: null },
      after: { status: 'SOLD', courier_id: 'c1' },
    });
  });

  it('ignores updatedAt / createdAt by default — silent saves stay quiet', () => {
    const t1 = new Date('2026-01-01T00:00:00Z');
    const t2 = new Date('2026-01-02T00:00:00Z');
    const d = computeDiff(
      { status: 'NEW', updatedAt: t1, createdAt: t1 },
      { status: 'NEW', updatedAt: t2, createdAt: t1 },
    );
    expect(d.before).toEqual({});
    expect(d.after).toEqual({});
  });

  it('respects the ignore list for domain-specific noise fields', () => {
    const d = computeDiff(
      { status: 'NEW', _internal_version: 1 },
      { status: 'NEW', _internal_version: 2 },
      ['_internal_version'],
    );
    expect(d).toEqual({ before: {}, after: {} });
  });

  it('detects added and removed keys', () => {
    const d = computeDiff({ a: 1 }, { a: 1, b: 2 });
    expect(d.before).toEqual({ b: undefined });
    expect(d.after).toEqual({ b: 2 });
  });

  it('handles nested objects via deep comparison', () => {
    const d = computeDiff(
      { meta: { tariff: 5000 } },
      { meta: { tariff: 6000 } },
    );
    expect(d.before).toEqual({ meta: { tariff: 5000 } });
    expect(d.after).toEqual({ meta: { tariff: 6000 } });
  });

  it('treats two Date instances with the same epoch as equal', () => {
    const t = Date.now();
    const d = computeDiff({ paid_at: new Date(t) }, { paid_at: new Date(t) });
    expect(d).toEqual({ before: {}, after: {} });
  });

  it('tolerates null / undefined snapshots', () => {
    expect(computeDiff(null, null)).toEqual({ before: {}, after: {} });
    expect(computeDiff(undefined, { a: 1 })).toEqual({
      before: { a: undefined },
      after: { a: 1 },
    });
  });
});
