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
  const lockCalls: string[] = [];
  const qb = {
    select: jest.fn(() => qb),
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
    orderBy: jest.fn(() => qb),
    addOrderBy: jest.fn(() => qb),
    setLock: jest.fn((mode: string) => {
      lockCalls.push(mode);
      return qb;
    }),
    // T6: avval qatorlar FOR UPDATE bilan tanlanadi (deadlock'siz tartib).
    getMany: jest.fn(() => Promise.resolve([{ id: '7' }])),
    execute: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const tx = {
    getRepository: jest.fn(() => ({ createQueryBuilder: jest.fn(() => qb) })),
    createQueryBuilder: jest.fn(() => qb),
  };
  const dataSource = {
    transaction: jest.fn((cb: (manager: typeof tx) => unknown) => cb(tx)),
  };
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    find: jest.fn(() => Promise.resolve(marketSettled)),
  };
  const service = new OrderSettlementService(
    dataSource as never,
    repo as never,
    {} as never,
  );
  return { service, setCalls, whereCalls, lockCalls, repo, qb, dataSource };
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
        's.order_id IN (:...orderIds)',
        's.status = :status',
        's.courier_id IS NULL',
        's.branch_id IS NULL',
        'id IN (:...ids)',
        'status = :status',
      ]),
    );
    expect(h.lockCalls).toEqual(['pessimistic_write']);
    expect(
      h.whereCalls.find(([sql]) => sql === 's.status = :status')?.[1],
    ).toEqual({ status: SettlementStatus.BRANCH_SETTLED });
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

    expect(h.dataSource.transaction).not.toHaveBeenCalled();
    expect(res.data.affected).toBe(0);
  });
});
