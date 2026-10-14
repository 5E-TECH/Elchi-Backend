import { SettlementStatus } from '@app/common';
import { OrderSettlementService } from './settlement/order-settlement.service';

/**
 * gEdrZxMz — CLICK_TO_MARKET kuryer to'lovidan keyin `market_payable`
 * kamayishi: finance `hq_to_market` siljishini (`token:m`) yuboradi, qator
 * MARKET_SETTLED bo'ladi va yig'indi faqat PENDING / COURIER_SETTLED /
 * BRANCH_SETTLED qatorlardan olinadi — ya'ni to'langan buyurtma marketga qarz
 * sifatida sanalmaydi. (Siljishning o'zi — fix3-settlement-advance-reclaim
 * spec'ida.)
 */
describe('gEdrZxMz — market_payable MARKET_SETTLED qatorlarni sanamaydi', () => {
  it('market yig`indisi so`rovi MARKET_SETTLED ni statuslar ro`yxatiga qo`shmaydi', async () => {
    const calls: Array<{ sql: string; params?: Record<string, unknown> }>[] =
      [];
    const makeQb = (rows: unknown[]) => {
      const own: Array<{ sql: string; params?: Record<string, unknown> }> = [];
      calls.push(own);
      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn((sql: string, params?: Record<string, unknown>) => {
          own.push({ sql, params });
          return qb;
        }),
        andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
          own.push({ sql, params });
          return qb;
        }),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      };
      return qb;
    };
    // Click_to_market to'lovidan keyin: 191-marketning faqat to'lanmagan
    // (BRANCH_SETTLED) qatori qolgan — 120 000; to'langani (MARKET_SETTLED)
    // so'rovga kirmaydi.
    const branchQb = makeQb([]);
    const marketQb = makeQb([{ market_id: '191', amount: '120000' }]);
    const repo = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(branchQb)
        .mockReturnValueOnce(marketQb),
    };
    const dataSource = {
      options: { schema: 'order_schema' },
      query: jest.fn().mockResolvedValue([{ t: null }]),
      getRepository: jest.fn(),
    };
    const service = new OrderSettlementService(
      dataSource as never,
      repo as never,
      {} as never,
    );

    const res = (await service.getFinancialBalanceSettlementSummary()) as {
      data: { market_payable: number };
    };

    const marketStatuses = calls[1]
      .map((c) => c.params?.statuses)
      .find(Boolean) as string[];
    expect(marketStatuses).toEqual([
      SettlementStatus.PENDING,
      SettlementStatus.COURIER_SETTLED,
      SettlementStatus.BRANCH_SETTLED,
    ]);
    expect(marketStatuses).not.toContain(SettlementStatus.MARKET_SETTLED);
    expect(res.data.market_payable).toBe(120000);
  });
});
