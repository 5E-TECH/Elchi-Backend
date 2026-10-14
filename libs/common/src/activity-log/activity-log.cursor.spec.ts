import { ActivityLogService } from './activity-log.service';

/**
 * 8eYmt4NV — `ActivityLogService.query` kursor yo'li (gateway k-way merge).
 *
 * ⚠️ ORQAGA MOSLIK: kursor parametrlari (`before_ts`, `before_id`,
 * `before_inclusive`, `keys_only`, `with_total`) BERILMASA — eski zanjir
 * AYNAN avvalgidek (`getManyAndCount`, `cursor_ts` yo'q). Haqiqiy Postgres
 * semantikasi — `activity-log.cursor.pg.spec.ts`.
 */
function makeService(
  opts: {
    entities?: Array<Record<string, unknown>>;
    raw?: Array<Record<string, unknown>>;
    count?: number;
  } = {},
) {
  const calls: Array<[string, unknown[]]> = [];
  const rec =
    (name: string, ret?: unknown) =>
    (...args: unknown[]) => {
      calls.push([name, args]);
      return ret === undefined ? qb : ret;
    };
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'andWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
    'select',
    'addSelect',
    'offset',
    'limit',
  ]) {
    qb[m] = jest.fn(rec(m));
  }
  qb.getManyAndCount = jest.fn(
    rec('getManyAndCount', Promise.resolve([opts.entities ?? [], 0])),
  );
  qb.getCount = jest.fn(rec('getCount', Promise.resolve(opts.count ?? 0)));
  qb.getRawAndEntities = jest.fn(
    rec(
      'getRawAndEntities',
      Promise.resolve({ entities: opts.entities ?? [], raw: opts.raw ?? [] }),
    ),
  );
  qb.getRawMany = jest.fn(rec('getRawMany', Promise.resolve(opts.raw ?? [])));
  const repo = { createQueryBuilder: jest.fn(() => qb) };
  const service = new ActivityLogService(repo as never, 'order-service');
  const names = () => calls.map(([n]) => n);
  const where = () =>
    calls.filter(([n]) => n === 'andWhere').map(([, a]) => a as [string, any]);
  return { service, qb, calls, names, where };
}

describe('ActivityLogService.query — eski yo`l o`zgarmagan (8eYmt4NV)', () => {
  it('⭐ kursor parametrlarisiz: AYNAN getManyAndCount zanjiri, cursor_ts/COUNT yo`q', async () => {
    const { service, names } = makeService({ entities: [{ id: '1' }] });

    const res = await service.query({ page: 3, limit: 20, action: 'login' });

    expect(names()).toEqual([
      'andWhere',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
      'getManyAndCount',
    ]);
    expect(res.items).toEqual([{ id: '1' }]);
    expect(res.meta).toEqual({ page: 3, limit: 20, total: 0, totalPages: 1 });
  });
});

describe('ActivityLogService.query — kursor yo`li', () => {
  it('with_total: har qatorga µs cursor_ts, jami kursor shartidan OLDIN sanaladi', async () => {
    const { service, names, qb } = makeService({
      entities: [{ id: '9' }, { id: '8' }],
      raw: [
        { a_id: '8', a_cursor_ts: '2026-10-14T09:10:19.064122Z' },
        { a_id: '9', a_cursor_ts: '2026-10-14T09:10:19.064123Z' },
      ],
      count: 42,
    });

    const res = await service.query({
      page: 1,
      limit: 2,
      with_total: true,
      before_ts: '2026-10-14T09:10:20.000000Z',
    });

    expect(res.items).toEqual([
      { id: '9', cursor_ts: '2026-10-14T09:10:19.064123Z' },
      { id: '8', cursor_ts: '2026-10-14T09:10:19.064122Z' },
    ]);
    expect(res.meta.total).toBe(42);
    // getCount — kursor sharti (andWhere) qo'shilishidan OLDIN.
    const n = names();
    expect(n.indexOf('getCount')).toBeLessThan(n.lastIndexOf('andWhere'));
    expect(qb.addSelect.mock.calls[0][0]).toContain(
      `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`,
    );
  });

  it.each([
    [
      { before_ts: '2026-10-14T09:10:19.064123Z', before_id: '77' },
      '(a.created_at < CAST(:bts AS timestamptz) OR (a.created_at = CAST(:bts AS timestamptz) AND a.id < CAST(:bid AS bigint)))',
      { bts: '2026-10-14T09:10:19.064123Z', bid: '77' },
    ],
    [
      { before_ts: '2026-10-14T09:10:19.064123Z', before_inclusive: true },
      'a.created_at <= CAST(:bts AS timestamptz)',
      { bts: '2026-10-14T09:10:19.064123Z' },
    ],
    [
      { before_ts: '2026-10-14T09:10:19.064123Z', before_inclusive: false },
      'a.created_at < CAST(:bts AS timestamptz)',
      { bts: '2026-10-14T09:10:19.064123Z' },
    ],
  ])('keyset sharti %j', async (params, sql, bind) => {
    const { service, where } = makeService();
    await service.query({ ...params, with_total: false });
    expect(where()).toContainEqual([sql, bind]);
  });

  it('noto`g`ri before_ts / before_id e`tiborsiz (so`rov yiqilmaydi)', async () => {
    const { service, where } = makeService();
    await service.query({
      before_ts: "1'; DROP TABLE x;--",
      with_total: false,
    });
    await service.query({
      before_ts: '2026-10-14T09:10:19.064123Z',
      before_id: 'abc',
    });
    const sqls = where().map(([s]) => s);
    expect(sqls.some((s) => s.includes('DROP'))).toBe(false);
    // before_id yaroqsiz → id siz (eksklyuziv) shart.
    expect(sqls).toContain('a.created_at < CAST(:bts AS timestamptz)');
  });

  it('keys_only: faqat id + cursor_ts (getRawMany), limit 10 100 gacha', async () => {
    const { service, qb, names } = makeService({
      raw: [{ id: 5, cursor_ts: '2026-10-14T09:10:19.064123Z' }],
      count: 9000,
    });

    const res = await service.query({
      keys_only: true,
      with_total: true,
      limit: 50_000,
    });

    expect(qb.select).toHaveBeenCalledWith('a.id', 'id');
    expect(qb.limit).toHaveBeenCalledWith(10_100);
    expect(names()).toContain('getRawMany');
    expect(names()).not.toContain('getRawAndEntities');
    expect(res.items).toEqual([
      { id: '5', cursor_ts: '2026-10-14T09:10:19.064123Z' },
    ]);
    expect(res.meta.total).toBe(9000);
  });

  it('with_total=false — COUNT bajarilmaydi; oddiy rejim limiti 500 da qoladi', async () => {
    const { service, qb, names } = makeService();
    await service.query({ with_total: false, limit: 5000 });
    expect(names()).not.toContain('getCount');
    expect(qb.take).toHaveBeenCalledWith(500);
  });
});
