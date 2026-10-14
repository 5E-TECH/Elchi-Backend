import { SettlementStatus } from '@app/common';
import { OrderSettlementService } from './settlement/order-settlement.service';

/**
 * DxdZFdIk — kargo to'lovi bekor qilinganda `markProviderSettledToHq` ning
 * teskarisi: faqat o'sha yo'l o'zgartirgan (kuryersiz, filialsiz,
 * BRANCH_SETTLED) qatorlar PENDING ga qaytadi; marketga to'langanlari
 * (MARKET_SETTLED) o'zgarmaydi va javobda ko'rsatiladi.
 */
type Row = Record<string, unknown>;

function makeService(marketSettled: Row[] = []) {
  const setCalls: Row[] = [];
  const whereCalls: Array<[string, Row | undefined]> = [];
  const qb = {
    update: jest.fn(() => qb),
    set: jest.fn((patch: Row) => {
      setCalls.push(patch);
      return qb;
    }),
    where: jest.fn((sql: string, params?: Row) => {
      whereCalls.push([sql, params]);
      return qb;
    }),
    andWhere: jest.fn((sql: string, params?: Row) => {
      whereCalls.push([sql, params]);
      return qb;
    }),
    execute: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    find: jest.fn(() => Promise.resolve(marketSettled)),
  };
  const service = new OrderSettlementService(
    {} as never,
    repo as never,
    {} as never,
  );
  return { service, setCalls, whereCalls, repo, qb };
}

describe('DxdZFdIk — revertProviderSettledToHq', () => {
  it('⭐ BRANCH_SETTLED (kuryersiz, filialsiz) → PENDING, HQ belgilari tozalanadi', async () => {
    const h = makeService([{ order_id: '1002' }]);

    const res = (await h.service.revertProviderSettledToHq({
      order_ids: ['1001', '1002'],
      requester_id: '9',
    })) as { data: Row };

    expect(h.setCalls[0]).toEqual({
      status: SettlementStatus.PENDING,
      courier_to_branch_at: null,
      branch_to_hq_at: null,
      branch_to_hq_by: null,
    });
    const sqls = h.whereCalls.map(([sql]) => sql);
    expect(sqls).toEqual(
      expect.arrayContaining([
        'order_id IN (:...orderIds)',
        'status = :status',
        'courier_id IS NULL',
        'branch_id IS NULL',
      ]),
    );
    expect(
      h.whereCalls.find(([sql]) => sql === 'status = :status')?.[1],
    ).toEqual({ status: SettlementStatus.BRANCH_SETTLED });
    expect(res.data).toEqual({
      reverted_order_ids: ['1001', '1002'],
      affected: 1,
      market_settled_order_ids: ['1002'],
    });
  });

  it('bo`sh / raqam bo`lmagan id — so`rov yuborilmaydi', async () => {
    const h = makeService();

    const res = (await h.service.revertProviderSettledToHq({
      order_ids: ['', 'abc'],
    })) as { data: Row };

    expect(h.repo.createQueryBuilder).not.toHaveBeenCalled();
    expect(res.data.affected).toBe(0);
  });
});
