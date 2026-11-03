import { OrderServiceService } from './order-service.service';

/**
 * Egasi qarori (2026-11-03): HQ ro'yxatchisi (yoki menejeri) market uchun
 * yaratgan buyurtma `source = branch`, `branch_id = HQ` bo'ladi. HQ ning
 * «Qabul va yaratish → Marketlar» ro'yxati (superadmin/admin —
 * `exclude_branch_source`) uni avval yashirardi; endi faqat HQ dan boshqa
 * filialda yaratilganlar yashiriladi (ular «Filial paketlari» bilan keladi).
 */
describe('HQ ro‘yxatchisi yaratgan YANGI buyurtma — HQ «Qabul va yaratish»da', () => {
  const HQ_CONDITION =
    '(order.source != :branch_source_excluded OR order.branch_id = :branch_source_hq_id)';

  function setup(hqBranchId: string | null) {
    const qb: Record<string, jest.Mock> = {};
    for (const m of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'groupBy',
      'orderBy',
    ]) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    const service: any = Object.create(OrderServiceService.prototype);
    service.orderRepo = { createQueryBuilder: jest.fn(() => qb) };
    service.lookup = {
      getHqBranchId: jest.fn().mockResolvedValue(hqBranchId),
    };
    return { service, qb };
  }

  it('Marketlar ro‘yxati (SA/admin): HQ filialiniki ko‘rinadi, boshqa filialniki — yo‘q', async () => {
    const { service, qb } = setup('1');
    await service.findNewMarkets(undefined, true);
    expect(qb.andWhere).toHaveBeenCalledWith(HQ_CONDITION, {
      branch_source_excluded: 'branch',
      branch_source_hq_id: '1',
    });
  });

  it('HQ id aniqlanmasa — avvalgidek filial manbali hammasi yashiriladi', async () => {
    const { service, qb } = setup(null);
    await service.findNewMarkets(undefined, true);
    expect(qb.andWhere).toHaveBeenCalledWith(
      'order.source != :branch_source_excluded',
      { branch_source_excluded: 'branch' },
    );
    expect(qb.andWhere).not.toHaveBeenCalledWith(
      HQ_CONDITION,
      expect.anything(),
    );
  });

  it('filial xodimi (branch_id) — manba filtri yo‘q', async () => {
    const { service, qb } = setup('1');
    await service.findNewMarkets('7', false);
    expect(qb.andWhere).toHaveBeenCalledWith('order.branch_id = :branch_id', {
      branch_id: '7',
    });
    expect(
      qb.andWhere.mock.calls.some(([sql]) =>
        String(sql).includes('branch_source_excluded'),
      ),
    ).toBe(false);
  });

  it('market ichidagi ro‘yxat: findAll HQ id bilan quriladi', async () => {
    const { service } = setup('1');
    const built: Array<Record<string, unknown>> = [];
    service.buildOrderListQuery = jest.fn((query: Record<string, unknown>) => {
      built.push(query);
      const qb: Record<string, jest.Mock> = {};
      for (const m of [
        'clone',
        'skip',
        'take',
        'leftJoinAndSelect',
        'orderBy',
        'addOrderBy',
      ]) {
        qb[m] = jest.fn(() => qb);
      }
      qb.getCount = jest.fn().mockResolvedValue(0);
      qb.getMany = jest.fn().mockResolvedValue([]);
      return qb;
    });
    await service
      .findNewOrdersByMarket('389', undefined, true)
      .catch(() => undefined);
    expect(built[0]).toEqual(
      expect.objectContaining({
        market_id: '389',
        status: 'new',
        exclude_branch_source_except_hq: true,
        branch_source_hq_branch_id: '1',
      }),
    );
    expect(built[0]).not.toHaveProperty('exclude_sources');
  });
});
