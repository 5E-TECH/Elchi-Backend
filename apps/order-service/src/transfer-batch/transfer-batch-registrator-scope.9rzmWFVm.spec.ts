import { BranchTransferBatchService } from './branch-transfer-batch.service';

/**
 * 9rzmWFVm — registrator «Filial paketlari» doirasi: `destination_branch_ids`
 * (branch-service registratorning o'z filiallarini uzatadi).
 *  - `undefined` — filtr yo'q (superadmin/admin va boshqa rollar — o'zgarmagan);
 *  - massiv — faqat shu manzil filiallarga kelgan paketlar;
 *  - bo'sh yoki faqat buzuq id — HECH NARSA (fail-closed).
 */
describe('9rzmWFVm — transfer batch manzil filial doirasi', () => {
  function setup() {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([
          { branch_id: '7', sent_batches_count: 2, sent_total_price: '500' },
        ]),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    const sub = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getQuery: jest.fn().mockReturnValue('SELECT 1 FROM newer_sql'),
    };
    const transferBatchRepo = {
      createQueryBuilder: jest.fn((alias: string) =>
        alias === 'newer' ? sub : qb,
      ),
    };
    const service = new BranchTransferBatchService(
      {} as never,
      transferBatchRepo as never,
      {
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn(() => sub),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const scopeCalls = () =>
      (qb.andWhere.mock.calls as unknown[][]).filter(
        ([sql]) =>
          typeof sql === 'string' &&
          (sql.includes('scopedDestinationIds') || sql === '1 = 0'),
      );
    return { service, qb, scopeCalls };
  }

  describe('find_branches_with_sent', () => {
    it('massiv — manzil filtri qo‘shiladi, buzuq id va takrorlar tashlanadi', async () => {
      const { service, scopeCalls } = setup();
      const res = (await service.findBranchesWithSentTransferBatches({
        direction: 'FORWARD',
        side: 'source',
        destination_branch_ids: ['1', ' 1 ', 'abc', '1; DROP'],
      })) as { data: { items: unknown[] } };
      expect(scopeCalls()).toEqual([
        [
          'batch.destination_branch_id IN (:...scopedDestinationIds)',
          { scopedDestinationIds: ['1'] },
        ],
      ]);
      expect(res.data.items).toEqual([
        { branch_id: '7', sent_batches_count: 2, sent_total_price: 500 },
      ]);
    });

    it('bo‘sh massiv — hech narsa (1 = 0)', async () => {
      const { service, scopeCalls } = setup();
      await service.findBranchesWithSentTransferBatches({
        direction: 'FORWARD',
        destination_branch_ids: [],
      });
      expect(scopeCalls()).toEqual([['1 = 0']]);
    });

    it('filtr berilmasa — doira yo‘q (superadmin/admin xulqi o‘zgarmagan)', async () => {
      const { service, scopeCalls } = setup();
      await service.findBranchesWithSentTransferBatches({
        direction: 'FORWARD',
        side: 'source',
      });
      expect(scopeCalls()).toEqual([]);
    });
  });

  describe('find_all', () => {
    it('massiv — manzil filtri; berilmasa — yo‘q', async () => {
      const scoped = setup();
      await scoped.service.findBranchTransferBatches({
        source_branch_id: '7',
        status: 'SENT',
        direction: 'FORWARD',
        destination_branch_ids: ['1', '4'],
      });
      expect(scoped.scopeCalls()).toEqual([
        [
          'batch.destination_branch_id IN (:...scopedDestinationIds)',
          { scopedDestinationIds: ['1', '4'] },
        ],
      ]);

      const plain = setup();
      await plain.service.findBranchTransferBatches({
        source_branch_id: '7',
        status: 'SENT',
        direction: 'FORWARD',
      });
      expect(plain.scopeCalls()).toEqual([]);
    });

    it('faqat buzuq id — hech narsa (fail-closed)', async () => {
      const { service, scopeCalls } = setup();
      await service.findBranchTransferBatches({
        status: 'SENT',
        destination_branch_ids: ['x', ''],
      });
      expect(scopeCalls()).toEqual([['1 = 0']]);
    });
  });
});
