/// <reference types="jest" />
import { Order_status } from '@app/common';
import { Order_source } from '../entities/order.entity';
import { OrderLifecycleService } from '../lifecycle/order-lifecycle.service';
import { OrderServiceService } from '../order-service.service';
import {
  countExternalBatches,
  toScannedBatch,
  uniqueBatchTokens,
} from './external-batch-counts';

/**
 * Sm3LZ6EN — qop sonlari (SQL'siz qism). So'rovning haqiqiy natijasi
 * `order-service.external-batches.Sm3LZ6EN.pg.spec.ts` da; bu yerda doira
 * parametrlari, javob shakli va skan yo'lidagi xulq.
 */
type RawRow = Record<string, unknown>;

function fakeRepo(rawRows: RawRow[]) {
  const wheres: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const params: Record<string, unknown> = {};
  const record = (sql: string, p?: Record<string, unknown>) => {
    wheres.push({ sql, params: p });
    Object.assign(params, p ?? {});
  };
  const qb: Record<string, jest.Mock> = {};
  const chain = (fn: (...args: any[]) => void = () => undefined) =>
    jest.fn((...args: any[]) => {
      fn(...args);
      return qb;
    });
  Object.assign(qb, {
    where: chain(record),
    andWhere: chain(record),
    select: chain(),
    addSelect: chain(),
    groupBy: chain(),
    setParameters: chain((p: Record<string, unknown>) =>
      Object.assign(params, p),
    ),
    getRawMany: jest.fn(() => Promise.resolve(rawRows)),
  });
  return {
    repo: { createQueryBuilder: jest.fn(() => qb) } as any,
    qb,
    wheres,
    params,
  };
}

describe('uniqueBatchTokens (Sm3LZ6EN)', () => {
  it('bo`sh tokenlarni tashlaydi, takrorni bitta qiladi, tartibni saqlaydi', () => {
    expect(
      uniqueBatchTokens([
        { external_batch_token: 'B' },
        { external_batch_token: null },
        { external_batch_token: 'A' },
        { external_batch_token: '' },
        { external_batch_token: 'B' },
        {},
      ]),
    ).toEqual(['B', 'A']);
  });
});

describe('countExternalBatches (Sm3LZ6EN)', () => {
  it('token yo`q — so`rov ketmaydi', async () => {
    const { repo } = fakeRepo([]);
    await expect(countExternalBatches(repo, [], {})).resolves.toEqual([]);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('⭐ raw qatorlarni sonlarga aylantiradi va BITTA GROUP BY quradi', async () => {
    const { repo, qb } = fakeRepo([
      {
        external_batch_token: 'A',
        external_batch_ref: 'BP-1',
        external_batch_size: 3,
        received_count: '1',
        pending_count: '1',
      },
    ]);

    const res = await countExternalBatches(repo, ['A'], {});

    expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(qb.groupBy).toHaveBeenCalledTimes(1);
    expect(qb.groupBy).toHaveBeenCalledWith('order.external_batch_token');
    expect(res).toEqual([
      {
        external_batch_token: 'A',
        external_batch_ref: 'BP-1',
        external_batch_size: 3,
        received_count: 1,
        pending_count: 1,
      },
    ]);
  });

  it('natija tokenlar tartibida qaytadi (ro`yxatdagi tartib)', async () => {
    const row = (token: string) => ({
      external_batch_token: token,
      external_batch_ref: null,
      external_batch_size: null,
      received_count: '0',
      pending_count: '1',
    });
    const { repo } = fakeRepo([row('A'), row('B')]);

    const res = await countExternalBatches(repo, ['B', 'A'], {});

    expect(res.map((r) => r.external_batch_token)).toEqual(['B', 'A']);
  });

  it('⭐ doira: market + filial so`rovga tushadi, bo`sh doira qo`shilmaydi', async () => {
    const scoped = fakeRepo([]);
    await countExternalBatches(scoped.repo, ['A'], {
      market_id: '121',
      branch_id: '11',
    });
    expect(scoped.params).toMatchObject({
      batch_tokens: ['A'],
      batch_market_id: '121',
      batch_branch_id: '11',
      batch_source: Order_source.EXTERNAL,
    });
    expect(scoped.wheres[0].sql).toBe('order.isDeleted = false');

    const open = fakeRepo([]);
    await countExternalBatches(open.repo, ['A'], {});
    expect(open.params).not.toHaveProperty('batch_market_id');
    expect(open.params).not.toHaveProperty('batch_branch_id');
  });

  it('filial sharti ro`yxatdagidek — branch, holder_branch, home_branch', async () => {
    const { repo, wheres } = fakeRepo([]);
    await countExternalBatches(repo, ['A'], { branch_id: '11' });
    const branchWhere = wheres.find((w) => /branch_id/.test(w.sql));
    expect(branchWhere?.sql).toContain('order.branch_id');
    expect(branchWhere?.sql).toContain('order.holder_branch_id');
    expect(branchWhere?.sql).toContain('order.home_branch_id');
  });
});

describe('toScannedBatch (Sm3LZ6EN)', () => {
  it('kartadagi `size` nomi bilan, skan sonini qo`shadi', () => {
    expect(
      toScannedBatch(
        {
          external_batch_token: 'A',
          external_batch_ref: 'BP-1',
          external_batch_size: 3,
          received_count: 2,
          pending_count: 0,
        },
        1,
      ),
    ).toEqual({
      external_batch_token: 'A',
      size: 3,
      received_count: 2,
      pending_count: 0,
      scanned_count: 1,
    });
  });
});

describe('findAllExternal — meta.batches (Sm3LZ6EN)', () => {
  const build = (rows: RawRow[], rawCounts: RawRow[] = []) => {
    const { repo, params } = fakeRepo(rawCounts);
    const svc: any = Object.create(OrderServiceService.prototype);
    svc.orderRepo = repo;
    svc.findAllEnriched = jest.fn().mockResolvedValue({
      data: rows,
      total: rows.length,
      page: 1,
      limit: 10,
    });
    return { svc, repo, params };
  };

  it('⭐ sahifa javobi o`zgarmaydi, ustiga `meta.batches` qo`shiladi', async () => {
    const { svc } = build(
      [{ id: '1', external_batch_token: 'A' }],
      [
        {
          external_batch_token: 'A',
          external_batch_ref: null,
          external_batch_size: 3,
          received_count: '1',
          pending_count: '1',
        },
      ],
    );

    const res = await svc.findAllExternal({ market_id: '121', status: 'new' });

    expect(res.total).toBe(1);
    expect(res.data).toHaveLength(1);
    expect(res.meta.batches).toEqual([
      {
        external_batch_token: 'A',
        external_batch_ref: null,
        external_batch_size: 3,
        received_count: 1,
        pending_count: 1,
      },
    ]);
  });

  it('⭐ son doirasi — market + filial; status/sana/sahifa KIRMAYDI', async () => {
    const { svc, params } = build([{ id: '1', external_batch_token: 'A' }]);

    await svc.findAllExternal({
      market_id: '121',
      branch_id: '11',
      status: 'new',
      start_day: '2026-10-01',
      end_day: '2026-10-01',
      page: 2,
      limit: 10,
    });

    expect(params).toMatchObject({
      batch_market_id: '121',
      batch_branch_id: '11',
    });
    expect(Object.values(params)).not.toContain('2026-10-01');
  });

  it('qopsiz sahifa — bo`sh ro`yxat, bazaga bormaydi', async () => {
    const { svc, repo } = build([{ id: '1', external_batch_token: null }]);

    const res = await svc.findAllExternal({ market_id: '121' });

    expect(res.meta.batches).toEqual([]);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('receiveExternalByScan — `batch` (Sm3LZ6EN)', () => {
  const parcel = (token: string, id: string, batch = 'QOP-1') => ({
    id,
    qr_code_token: token,
    external_batch_token: batch,
    status: Order_status.NEW,
    source: Order_source.EXTERNAL,
  });

  const build = (opts: {
    members: Array<Record<string, unknown>>;
    rawCounts?: RawRow[];
    scopeBranchId?: string | null;
  }) => {
    const { repo, params, qb } = fakeRepo(opts.rawCounts ?? []);
    const svc: any = Object.create(OrderLifecycleService.prototype);
    svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    let call = 0;
    repo.find = jest.fn(() => {
      call += 1;
      return Promise.resolve(opts.members);
    });
    repo.findOne = jest.fn(() => Promise.resolve(null));
    svc.orderRepo = repo;
    svc.receiveNewOrders = jest.fn(() => Promise.resolve({ data: {} }));
    svc.resolveReceiveBranchScope = jest.fn(() =>
      Promise.resolve(opts.scopeBranchId ?? null),
    );
    return { svc, repo, params, qb, findCalls: () => call };
  };

  const counted = (token: string, received: string, pending = '0') => ({
    external_batch_token: token,
    external_batch_ref: 'BP-1',
    external_batch_size: 3,
    received_count: received,
    pending_count: pending,
  });

  it('⭐ chala qop: 1 tasi avval qabul qilingan, 1 tasi shu skanda => 2/3', async () => {
    const { svc } = build({
      members: [parcel('P-2', '2')],
      rawCounts: [counted('QOP-1', '2')],
    });

    const res: any = await svc.receiveExternalByScan({ tokens: ['QOP-1'] });

    expect(res.data.ok).toBe(true);
    expect(res.data.batch).toEqual({
      external_batch_token: 'QOP-1',
      size: 3,
      received_count: 2,
      pending_count: 0,
      scanned_count: 1,
    });
    expect(res.data.batches).toEqual([res.data.batch]);
  });

  it('⭐ filial doirasi `resolveReceiveBranchScope` dan', async () => {
    const { svc, params } = build({
      members: [parcel('P-2', '2')],
      rawCounts: [counted('QOP-1', '1')],
      scopeBranchId: '11',
    });

    await svc.receiveExternalByScan({
      tokens: ['QOP-1'],
      requester: { id: '5', roles: ['manager'] },
    });

    expect(params).toMatchObject({ batch_branch_id: '11' });
  });

  it('ikki qop: `batch` null, `batches` da ikkalasi', async () => {
    const { svc } = build({
      members: [parcel('P-1', '1', 'QOP-1'), parcel('P-2', '2', 'QOP-2')],
      rawCounts: [counted('QOP-1', '1'), counted('QOP-2', '1')],
    });

    const res: any = await svc.receiveExternalByScan({
      tokens: ['QOP-1', 'QOP-2'],
    });

    expect(res.data.batch).toBeNull();
    expect(res.data.batches.map((b: any) => b.scanned_count)).toEqual([1, 1]);
  });

  it('qop skanlanmagan (posilka tokeni): bazaga bormaydi, `batch` null', async () => {
    const { svc, repo } = build({ members: [] });
    repo.find = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([parcel('P-1', '1')]);

    const res: any = await svc.receiveExternalByScan({ tokens: ['P-1'] });

    expect(res.data.ok).toBe(true);
    expect(res.data.batch).toBeNull();
    expect(res.data.batches).toEqual([]);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('⭐ son olinmasa ham qabul natijasi yo`qolmaydi (posilkalar allaqachon qabul qilingan)', async () => {
    const { svc, qb } = build({ members: [parcel('P-2', '2')] });
    qb.getRawMany.mockRejectedValue(new Error('db down'));

    const res: any = await svc.receiveExternalByScan({ tokens: ['QOP-1'] });

    expect(res.data.ok).toBe(true);
    expect(res.data.received).toBe(1);
    expect(res.data.batch).toBeNull();
    expect(res.data.batches).toEqual([]);
    expect(svc.logger.warn).toHaveBeenCalled();
  });
});
