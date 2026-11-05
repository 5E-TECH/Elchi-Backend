/**
 * GykuOz8f — tasdiqsiz yozilgan qo'shimcha xarajat ham «Qo'shimcha xarajatli
 * buyurtmalar» sahifasida ko'rinadi.
 *
 * Market tasdig'i o'chiq (`extra_cost_requires_approval: false`) yoki qayta
 * ijro bo'lmagan har qanday yo'l: sotish / bekor qilish / qisman sotish
 * `order_extra_cost_approvals` ga `approved` + `immediate` qatorini PUL
 * YOZUVLARI BILAN BITTA tranzaksiyada yozadi. Pul yozuvi yiqilsa — qator
 * ham qaytadi. Market tasdig'ini qayta ijro — qo'shimcha qator yo'q.
 * Haqiqiy Postgres tranzaksiyasi — `extra-cost-page.GykuOz8f.pg.spec.ts`.
 */
import { of } from 'rxjs';
import { Cashbox_type, Order_status, Where_deliver } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderSettlement } from './entities/order-settlement.entity';
import { OrderExtraCostApproval } from './entities/order-extra-cost-approval.entity';
import {
  ExtraCostApprovalTable,
  extraCostApprovalTable,
} from './testing/extra-cost-kit-spec';

type Row = Record<string, unknown>;

const ORDER = {
  id: '7001',
  status: Order_status.WAITING,
  post_id: '9001',
  market_id: '501',
  customer_id: '801',
  total_price: 250000,
  paid_online_amount: 0,
  where_deliver: Where_deliver.CENTER,
  branch_id: '77',
  home_branch_id: '77',
  holder_branch_id: '77',
  comment: null,
} as unknown as Order;

/**
 * `order-service.extra-cost-settlement.spec.ts` uslubi; so'rovlar jadvali
 * tranzaksiya bilan bog'langan: `rollbackTransaction` — jadval holati
 * tranzaksiya boshidagidek.
 */
function makeService(
  opts: {
    table?: ExtraCostApprovalTable;
    failMoney?: boolean;
    proofFiles?: string[];
  } = {},
) {
  const table = opts.table ?? extraCostApprovalTable();
  let rollback: (() => void) | null = null;
  const settlementRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: Row) => row),
    save: jest.fn((row: Row) => Promise.resolve(row)),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const tx = {
    getRepository: jest.fn((entity: unknown) =>
      entity === OrderExtraCostApproval
        ? table
        : entity === OrderSettlement
          ? settlementRepo
          : { update: jest.fn() },
    ),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(() => {
      rollback = table.begin();
    }),
    commitTransaction: jest.fn(() => {
      rollback = null;
    }),
    rollbackTransaction: jest.fn(() => {
      rollback?.();
      rollback = null;
    }),
    release: jest.fn(),
    manager: tx,
  };

  const s = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService & Record<string, any>;
  Object.assign(s, {
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '301' } })),
    },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
    orderItemRepo: { find: jest.fn().mockResolvedValue([]) },
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    lookup: {
      getMarketsByIds: jest.fn().mockResolvedValue([
        {
          id: '501',
          tariff_center: 45000,
          tariff_home: 70000,
          expense_proof_conditions: [],
          extra_cost_enabled: true,
          extra_cost_requires_approval: false,
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
      getCashboxByUser: jest.fn((_id: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-cashbox`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue('77'),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
    },
    findById: jest.fn().mockResolvedValue(ORDER),
    enforceOperationProof: jest
      .fn()
      .mockResolvedValue(opts.proofFiles ?? ['proof/receipt.jpg']),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    updateFull: jest.fn().mockResolvedValue(undefined),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
    updateCashboxBalance: jest.fn(() =>
      opts.failMoney
        ? Promise.reject(new Error('kassa yozuvi yiqildi'))
        : Promise.resolve(undefined),
    ),
  });
  const requester = { id: '301', roles: ['courier'], branch_id: '77' };
  return { s, requester, table, queryRunner };
}

describe('GykuOz8f — tasdiqsiz xarajat qatori (sotish / bekor qilish)', () => {
  it('⭐ market tasdig‘i o‘chiq: sotuv — `approved` + `immediate` qatori, isbot va yuklama bilan', async () => {
    const { s, requester, table, queryRunner } = makeService();

    await s.sellOrder(requester, '7001', {
      extraCost: 5000,
      comment: 'Yo`l xarajati',
    });

    expect(queryRunner.commitTransaction).toHaveBeenCalled();
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({
      order_id: '7001',
      market_id: '501',
      requested_by_user_id: '301',
      requested_by_role: 'courier',
      requester_branch_id: '77',
      action: 'sell',
      amount: 5000,
      proof_file_keys: ['proof/receipt.jpg'],
      operation_payload: expect.objectContaining({
        extraCost: 5000,
        comment: 'Yo`l xarajati',
        proofFileKeys: ['proof/receipt.jpg'],
      }),
      status: 'approved',
      immediate: true,
      auto_approved: false,
      decided_by_user_id: null,
      decided_at: expect.any(Date),
    });
  });

  it('⭐ bekor qilish — `cancel` amali bilan qator', async () => {
    const { s, requester, table } = makeService({ proofFiles: [] });

    await s.cancelOrder(requester, '7001', {
      extraCost: 7000,
      comment: 'Mijoz olmadi',
    });

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({
      action: 'cancel',
      amount: 7000,
      proof_file_keys: [],
      status: 'approved',
      immediate: true,
    });
  });

  it('xarajatsiz sotuv / bekor — qator yozilmaydi', async () => {
    const { s, requester, table } = makeService();

    await s.sellOrder(requester, '7001', { comment: 'Sotildi' });
    await s.cancelOrder(requester, '7001', { comment: 'Mijoz olmadi' });

    expect(table.rows).toHaveLength(0);
  });

  it('⭐ pul yozuvi yiqildi — tranzaksiya qaytadi, tasdiqsiz qator ham yo‘q', async () => {
    const { s, requester, table, queryRunner } = makeService({
      failMoney: true,
    });

    await expect(
      s.sellOrder(requester, '7001', { extraCost: 5000 }),
    ).rejects.toBeDefined();

    // Qator pul yozuvidan OLDIN yozilgan edi — tranzaksiya bilan qaytdi.
    expect(table.save).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(table.rows).toHaveLength(0);
  });

  it('⭐ market tasdig‘ini qayta ijro — so‘rovning o‘zi tasdiqlanadi, qo‘shimcha qator YO‘Q', async () => {
    const table = extraCostApprovalTable([
      {
        id: '7',
        order_id: '7001',
        market_id: '501',
        requested_by_user_id: '301',
        requested_by_role: 'courier',
        action: 'sell',
        amount: 5000,
        status: 'pending',
      },
    ]);
    const { s, requester } = makeService({ table });
    // Darvoza: so'rovdan keyin buyurtma holati o'zgarmagan.
    s.extraCostStatusChangedSince = jest.fn().mockResolvedValue(null);

    await s.sellOrder(
      requester,
      '7001',
      { extraCost: 5000, extraCostApproved: true },
      'extra-cost-approval:7',
      {
        extraCostApproval: {
          id: '7',
          patch: {
            decided_by_user_id: '501',
            decided_at: new Date('2026-11-05T09:00:00Z'),
            decision_comment: null,
            auto_approved: false,
          },
        },
      },
    );

    expect(table.rows).toHaveLength(1);
    expect(table.row('7')).toMatchObject({ status: 'approved' });
    expect(table.row('7')!.immediate).toBeUndefined();
  });
});

describe('GykuOz8f — tasdiqsiz xarajat qatori (qisman sotuv)', () => {
  function partly(opts: { failMoney?: boolean } = {}) {
    const table = extraCostApprovalTable();
    let rollback: (() => void) | null = null;
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(() => {
        rollback = table.begin();
      }),
      commitTransaction: jest.fn(() => {
        rollback = null;
      }),
      rollbackTransaction: jest.fn(() => {
        rollback?.();
        rollback = null;
      }),
      release: jest.fn(),
      manager: {
        getRepository: (entity: unknown) => {
          if (entity === OrderExtraCostApproval) return table;
          if (entity === OrderItem) {
            return {
              save: jest.fn((row: Row) => Promise.resolve(row)),
              createQueryBuilder: () => ({
                insert: () => ({
                  values: () => ({ execute: () => Promise.resolve({}) }),
                }),
              }),
            };
          }
          if (entity === Order) {
            return {
              create: (value: Row) => value,
              save: (value: Row) => Promise.resolve({ id: '9900', ...value }),
              update: () => Promise.resolve({ affected: 1 }),
            };
          }
          return {};
        },
      },
    };
    const s = Object.create(
      OrderLifecycleService.prototype,
    ) as OrderLifecycleService & Record<string, any>;
    const noop = () => Promise.resolve(undefined);
    Object.assign(s, {
      findById: jest.fn().mockResolvedValue({
        ...ORDER,
        id: '120',
        total_price: 1000000,
      }),
      logisticsClient: {
        send: () => of({ data: { id: '9001', courier_id: '301' } }),
      },
      resolveActorCourierId: () => '301',
      hasRole: () => false,
      // Ruxsat / chegara tekshiruvlari alohida spec'larda.
      assertMarketExtraCostEnabled: () => undefined,
      assertCanAddExtraCost: noop,
      assertExtraCostWithinLimit: () => undefined,
      lookup: {
        getMarketsByIds: jest.fn().mockResolvedValue([
          {
            id: '501',
            tariff_center: 45000,
            tariff_home: 70000,
            extra_cost_requires_approval: false,
          },
        ]),
        getCouriersByIds: jest
          .fn()
          .mockResolvedValue([
            { id: '301', tariff_center: 30000, tariff_home: 50000 },
          ]),
        getCashboxByUser: jest.fn().mockResolvedValue({ id: 'c', balance: 0 }),
        resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
        ensureBranchCashbox: noop,
        resolveBranchShare: jest.fn().mockResolvedValue(0),
      },
      enforceOperationProof: jest.fn().mockResolvedValue(['proof/p.jpg']),
      orderItemRepo: {
        find: jest
          .fn()
          .mockResolvedValue([
            { id: '5501', product_id: null, product_name: 'tv', quantity: 2 },
          ]),
      },
      resolveHolderFromState: jest.fn().mockResolvedValue({
        holder_type: 'COURIER',
        holder_branch_id: '77',
        holder_courier_id: '301',
      }),
      dataSource: { createQueryRunner: () => queryRunner },
      lockWaitingOrder: noop,
      updateCashboxBalance: opts.failMoney
        ? () => Promise.reject(new Error('kassa yozuvi yiqildi'))
        : noop,
      updateFull: noop,
      recordSaleSettlement: noop,
      custody: {
        createTrackingEvent: noop,
        createCustodyEvent: noop,
        toTrackingRole: () => 'courier',
        auditActor: () => ({}),
      },
      syncOrderToSearch: noop,
      resolveSyncAction: () => null,
      outbox: { enqueue: noop },
      activityLog: { log: noop },
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    });
    const run = () =>
      s.partlySellOrder(
        { id: '301', roles: ['courier'], branch_id: '77' },
        '120',
        {
          order_item_info: [{ order_item_id: '5501', quantity: 1 }] as never,
          totalPrice: 500000,
          extraCost: 6000,
        },
      );
    return { run, table, queryRunner };
  }

  it('⭐ qisman sotuv — `partly_sell` qatori', async () => {
    const t = partly();

    await t.run();

    expect(t.queryRunner.commitTransaction).toHaveBeenCalled();
    expect(t.table.rows).toHaveLength(1);
    expect(t.table.rows[0]).toMatchObject({
      order_id: '120',
      market_id: '501',
      requested_by_user_id: '301',
      action: 'partly_sell',
      amount: 6000,
      proof_file_keys: ['proof/p.jpg'],
      status: 'approved',
      immediate: true,
    });
  });

  it('pul yozuvi yiqildi — qator qaytadi', async () => {
    const t = partly({ failMoney: true });

    await expect(t.run()).rejects.toBeDefined();

    expect(t.table.save).toHaveBeenCalledTimes(1);
    expect(t.queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(t.table.rows).toHaveLength(0);
  });
});
