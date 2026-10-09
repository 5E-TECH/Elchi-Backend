/**
 * 2WRzdWpZ — buyurtma jurnal qatorlarida o'zbekcha gap (description).
 *
 * Harness `order-service.extra-cost-settlement.spec.ts` bilan bir uslub: faqat
 * jurnal yozuvi tekshiriladi, pul mantig'i o'sha spec'da.
 */
import { of } from 'rxjs';
import { Cashbox_type, Order_status, Where_deliver } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order } from './entities/order.entity';
import { OrderSettlement } from './entities/order-settlement.entity';

const ORDER = {
  id: '7001',
  status: Order_status.WAITING,
  post_id: '9001',
  market_id: '501',
  total_price: 250000,
  paid_online_amount: 0,
  where_deliver: Where_deliver.CENTER,
  branch_id: '77',
  home_branch_id: '77',
  holder_branch_id: '77',
  comment: null,
} as unknown as Order;

function makeService() {
  const settlementRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: unknown) => row),
    save: jest.fn((row: unknown) => Promise.resolve(row)),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const tx = {
    getRepository: jest.fn((entity: unknown) =>
      entity === OrderSettlement ? settlementRepo : { update: jest.fn() },
    ),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: tx,
  };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };

  const s = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService & Record<string, any>;
  Object.assign(s, {
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '301' } })),
    },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog,
    custody: { auditActor: jest.fn(() => ({})) },
    orderItemRepo: { find: jest.fn().mockResolvedValue([]) },
    lookup: {
      getMarketsByIds: jest.fn().mockResolvedValue([
        {
          id: '501',
          tariff_center: 45000,
          tariff_home: 70000,
          expense_proof_conditions: [],
        },
      ]),
      getCouriersByIds: jest.fn().mockResolvedValue([
        {
          id: '301',
          tariff_center: 30000,
          tariff_home: 50000,
          can_add_extra_cost: true,
          can_sell_cancel: true,
        },
      ]),
      getUserById: jest.fn().mockResolvedValue(null),
      getCashboxByUser: jest.fn((_id: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-cashbox`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue('77'),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
    },
    findById: jest.fn().mockResolvedValue(ORDER),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    updateFull: jest.fn().mockResolvedValue(undefined),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
    updateCashboxBalance: jest.fn().mockResolvedValue(undefined),
  });
  const requester = { id: '301', roles: ['courier'], branch_id: '77' };
  const entry = (action: string) =>
    activityLog.log.mock.calls
      .map((call: unknown[]) => call[0] as Record<string, unknown>)
      .find((e: Record<string, unknown>) => e.action === action);
  return { s, requester, entry };
}

/** Mijozga tegishli PII — gapga TUSHMASLIGI shart (TC6). */
const PII_COMMENT =
  'Mijoz Dilnoza +998 90 123 45 67, Chilonzor 9-kvartal 12-uy';

describe('buyurtma jurnal gaplari (2WRzdWpZ)', () => {
  it('TC3 bekor qilishda o`zbekcha gap va buyurtma raqami bor', async () => {
    const { s, requester, entry } = makeService();
    await s.cancelOrder(requester, '7001', { comment: PII_COMMENT });
    expect(entry('order.cancel')?.description).toBe(
      'Buyurtma #7001 bekor qilindi',
    );
  });

  it('TC6 izohdagi mijoz ismi/telefoni/manzili gapga TUSHMAYDI', async () => {
    const { s, requester, entry } = makeService();
    await s.cancelOrder(requester, '7001', { comment: PII_COMMENT });
    await s.sellOrder(requester, '7001', { comment: PII_COMMENT });
    for (const action of ['order.cancel', 'order.sell']) {
      const description = entry(action)?.description;
      expect(typeof description).toBe('string');
      expect(description).not.toMatch(/Dilnoza|123 45 67|Chilonzor|kvartal/);
    }
  });

  it('sotuvda summa ming ajratgichi bilan', async () => {
    const { s, requester, entry } = makeService();
    await s.sellOrder(requester, '7001', { comment: 'ok' });
    expect(entry('order.sell')?.description).toBe(
      "Buyurtma #7001 sotildi — 250 000 so'm",
    );
  });
});
