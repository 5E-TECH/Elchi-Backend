import { BranchTransferBatchService } from './branch-transfer-batch.service';

type ListResult = {
  data: {
    items: Array<{ id: string }>;
    meta: { page: number; limit: number; total: number; totalPages: number };
  };
};

/**
 * 15N7AHkp (unit) — PENDING yig'ish SQL shartiga ko'chdi, `meta.total` —
 * COUNT (sahifadagi qatorlar soni emas). Haqiqiy SQL xulqi:
 * `transfer-batch-list-total.15N7AHkp.pg.spec.ts`.
 */
describe('15N7AHkp — transfer-batches meta.total haqiqiy', () => {
  function setup(rows: Array<Record<string, unknown>>, total: number) {
    const sub = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getQuery: jest.fn().mockReturnValue('SELECT 1 FROM newer_sql'),
    };
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([rows, total]),
    };
    const transferBatchRepo = {
      createQueryBuilder: jest.fn((alias: string) =>
        alias === 'newer' ? sub : qb,
      ),
    };
    const service = new BranchTransferBatchService(
      {} as never,
      transferBatchRepo as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const collapseCalls = () =>
      (qb.andWhere.mock.calls as unknown[][]).filter(
        ([sql]) => typeof sql === 'string' && sql.includes('NOT (batch.status'),
      );
    return { service, qb, sub, collapseCalls };
  }

  const pending = (id: string) => ({
    id,
    status: 'PENDING',
    source_branch_id: '10',
    destination_branch_id: '20',
    direction: 'FORWARD',
    target_region_id: '1',
  });

  it.each([[undefined], ['PENDING'], ['pending']])(
    'status=%s — yig‘ish SQL’da (NOT EXISTS yangiroq PENDING), total = COUNT',
    async (status) => {
      // Ilgari: 2 qator sahifada → total 1 (yig'ilgan), totalPages 1.
      const { service, collapseCalls, sub } = setup(
        [pending('9'), pending('8')],
        57,
      );

      const res = (await service.findBranchTransferBatches({
        status,
        page: 1,
        limit: 20,
      })) as ListResult;

      expect(collapseCalls()).toEqual([
        [
          'NOT (batch.status = :collapseStatus AND EXISTS (SELECT 1 FROM newer_sql))',
          { collapseStatus: 'PENDING' },
        ],
      ]);
      expect(sub.andWhere).toHaveBeenCalledWith(
        'newer.target_region_id = batch.target_region_id',
      );
      // Xotirada qayta yig'ilmaydi — SQL nima bersa, shu.
      expect(res.data.items.map((item) => item.id)).toEqual(['9', '8']);
      expect(res.data.meta).toEqual({
        page: 1,
        limit: 20,
        total: 57,
        totalPages: 3,
      });
    },
  );

  it('status=SENT — yig‘ish sharti qo‘shilmaydi, total avvalgidek COUNT', async () => {
    const { service, collapseCalls, sub } = setup([], 41);

    const res = (await service.findBranchTransferBatches({
      status: 'SENT',
      limit: 20,
    })) as ListResult;

    expect(collapseCalls()).toHaveLength(0);
    expect(sub.select).not.toHaveBeenCalled();
    expect(res.data.meta).toMatchObject({ total: 41, totalPages: 3 });
  });

  it('date filtri — yangiroq PENDING ham AYNI oynadan', async () => {
    const { service, sub } = setup([], 0);

    await service.findBranchTransferBatches({ date: '2026-10-21' });

    expect(sub.andWhere).toHaveBeenCalledWith(
      'newer.createdAt BETWEEN :dayStart AND :dayEnd',
    );
  });

  it('barqaror tartib: createdAt DESC, keyin id DESC', async () => {
    const { service, qb } = setup([], 0);

    await service.findBranchTransferBatches({});

    expect(qb.orderBy).toHaveBeenCalledWith('batch.createdAt', 'DESC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('batch.id', 'DESC');
  });
  // Z3pUOxou — logist doirasi va N17 maqsad viloyat filtri.
  it('target_region_ids: faqat shu maqsad viloyatlari (buzuq qiymat tashlanadi)', async () => {
    const { service, qb } = setup([], 0);

    await service.findBranchTransferBatches({
      target_region_ids: ['5', '9', '9', "1'; --", ''],
    });

    expect(qb.andWhere).toHaveBeenCalledWith(
      'batch.target_region_id IN (:...scopedTargetRegionIds)',
      { scopedTargetRegionIds: ['5', '9'] },
    );
    expect(qb.andWhere).not.toHaveBeenCalledWith('1 = 0');
  });

  it('target_region_ids: bo‘sh to‘plam — hech qanday qator (fail-closed)', async () => {
    const { service, qb } = setup([], 0);

    await service.findBranchTransferBatches({ target_region_ids: [] });

    expect(qb.andWhere).toHaveBeenCalledWith('1 = 0');
  });

  it('target_region_id filtri; buzuq id — 400; berilmasa — filtr yo‘q', async () => {
    const { service, qb } = setup([], 0);
    await service.findBranchTransferBatches({ target_region_id: ' 5 ' });
    expect(qb.andWhere).toHaveBeenCalledWith(
      'batch.target_region_id = :targetRegionId',
      { targetRegionId: '5' },
    );

    await expect(
      service.findBranchTransferBatches({ target_region_id: 'abc' }),
    ).rejects.toBeDefined();

    const plain = setup([], 0);
    await plain.service.findBranchTransferBatches({});
    const sqls = (plain.qb.andWhere.mock.calls as unknown[][]).map(
      ([sql]) => sql,
    );
    expect(sqls).not.toContain('batch.target_region_id = :targetRegionId');
    expect(sqls).not.toContain(
      'batch.target_region_id IN (:...scopedTargetRegionIds)',
    );
  });
});
