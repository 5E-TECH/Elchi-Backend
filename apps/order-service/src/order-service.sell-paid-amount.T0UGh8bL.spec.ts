/**
 * T0UGh8bL — `sell {paidAmount}` (ZsPLevZZ (a) yo'li): sotuvchi (kuryer yoki
 * menejer sotuvida filial) yig'ilgan naqddan marketga TO'G'RIDAN-TO'G'RI
 * bergan X shu sotuv tranzaksiyasida to'liq yoziladi.
 *
 *   • market kassasi −X (MARKET_PAYMENT), sotuvchi kassasi −X;
 *   • settlement: market_amount, courier_amount, branch_amount −X;
 *   • holat: sof qarz (to_be_paid − xarajat) yopilsa PAID, aks holda
 *     PARTLY_PAID; X = 0 — ilgarigidek (regressiya);
 *   • chegaralar: butun son ≥ 0; ≤ buyurtma bo'yicha sof qarz va market
 *     kassasidagi qarz; hamkor (tashqi) buyurtmasi va HQ menejeri sotuvida
 *     X > 0 — 400. Hammasi tranzaksiya va tasdiq so'rovidan OLDIN.
 *
 * Pul mantig'i (`updateCashboxBalance`, `recordSaleSettlement` va domen
 * formulalari) HAQIQIY — faqat RMQ/TypeORM eng kichik ko'rinishda.
 */
import { of } from 'rxjs';
import { RpcException } from '@nestjs/microservices';
import { Cashbox_type, Order_status, Where_deliver } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderSettlement } from './entities/order-settlement.entity';
import {
  computeSaleMarketPaymentLimit,
  computeSalePaymentState,
} from './domain/order-money';

type Row = Record<string, any>;

const ORDER: Row = {
  id: '7001',
  status: Order_status.WAITING,
  post_id: '9001',
  market_id: '501',
  total_price: 250000,
  paid_online_amount: 0,
  paid_amount: 0,
  where_deliver: Where_deliver.CENTER,
  branch_id: '77',
  home_branch_id: '77',
  holder_branch_id: '77',
  external_id: null,
  comment: null,
};

const COURIER = { id: '301', roles: ['courier'], branch_id: '77' };
const MANAGER = { id: '201', roles: ['manager'], branch_id: '77' };

async function rpcError(
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; message?: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as { statusCode?: number; message?: string };
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

function makeService(
  opts: {
    order?: Row;
    marketBalance?: number;
    settlementBranchId?: string | null;
  } = {},
) {
  const order = { ...ORDER, ...(opts.order ?? {}) };
  const outboxed: Row[] = [];
  const settlements: Row[] = [];
  const settlementRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: Row) => row),
    save: jest.fn((row: Row) => {
      settlements.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: unknown) =>
        entity === OrderSettlement ? settlementRepo : { update: jest.fn() },
      ),
    },
  };
  const mocks = {
    createQueryRunner: jest.fn(() => queryRunner),
    requestApproval: jest.fn().mockResolvedValue(null),
    updateFull: jest.fn().mockResolvedValue(undefined),
  };

  const s = Object.create(OrderLifecycleService.prototype) as Row;
  Object.assign(s, {
    dataSource: { createQueryRunner: mocks.createQueryRunner },
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '301' } })),
    },
    outbox: {
      enqueue: jest.fn((_t: string, pattern: string, payload: Row) => {
        if (pattern === 'finance.cashbox.update_balance') {
          outboxed.push(payload);
        }
        return Promise.resolve(undefined);
      }),
    },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
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
      getUserById: jest.fn().mockResolvedValue({
        id: '201',
        can_add_extra_cost: true,
        can_sell_cancel: true,
        tariff_center: 0,
        tariff_home: 0,
      }),
      getCashboxByUser: jest.fn((_id: string, type: Cashbox_type) =>
        Promise.resolve({
          id: `${type}-cashbox`,
          balance:
            type === Cashbox_type.FOR_MARKET ? (opts.marketBalance ?? 0) : 0,
        }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest
        .fn()
        .mockResolvedValue(
          opts.settlementBranchId === undefined
            ? '77'
            : opts.settlementBranchId,
        ),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
    },
    findById: jest.fn().mockResolvedValue(order),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: mocks.requestApproval,
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    updateFull: mocks.updateFull,
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
  });

  const patch = () => mocks.updateFull.mock.calls[0]?.[1] as Row | undefined;
  return {
    sell: (requester: Row, dto: Row) =>
      (s as unknown as OrderLifecycleService).sellOrder(
        requester as never,
        '7001',
        dto,
        'req-1',
      ),
    mocks,
    outboxed,
    settlements,
    patch,
  };
}

const legs = (outboxed: Row[], type: Cashbox_type) =>
  outboxed
    .filter((leg) => leg.cashbox_type === type)
    .map((leg) => [leg.operation_type, leg.source_type, leg.amount]);

describe('T0UGh8bL — domen: computeSaleMarketPaymentLimit', () => {
  it.each([
    // [izoh, kirish, kutilgan chegara]
    [
      'oddiy: 250 000 − 45 000',
      {
        collectible: 250000,
        marketTariff: 45000,
        extraCost: 0,
        currentPaid: 0,
        marketBalanceBefore: 0,
      },
      205000,
    ],
    [
      'xarajat ayiriladi (finance marketOrderRemaining bilan bir xil)',
      {
        collectible: 250000,
        marketTariff: 45000,
        extraCost: 5000,
        currentPaid: 0,
        marketBalanceBefore: 0,
      },
      200000,
    ],
    [
      'market bizga qarzdor (−50 000) — avval qarz yopiladi',
      {
        collectible: 250000,
        marketTariff: 45000,
        extraCost: 0,
        currentPaid: 0,
        marketBalanceBefore: -50000,
      },
      155000,
    ],
    [
      'tarifdan arzon (yig`ilgan < tarif) — 0',
      {
        collectible: 20000,
        marketTariff: 45000,
        extraCost: 0,
        currentPaid: 0,
        marketBalanceBefore: 1000000,
      },
      0,
    ],
    [
      'onlayn to`langan (yig`ilgan 0) — 0',
      {
        collectible: 0,
        marketTariff: 45000,
        extraCost: 0,
        currentPaid: 0,
        marketBalanceBefore: 0,
      },
      0,
    ],
  ])('%s', (_label, input, expected) => {
    expect(computeSaleMarketPaymentLimit(input)).toBe(expected);
  });
});

describe('T0UGh8bL — domen: computeSalePaymentState', () => {
  it('X = 0 — ilgarigi formula: qarzsiz SOLD, qarz to`liq yopsa PAID, qisman PARTLY_PAID', () => {
    const base = {
      netToBePaid: 205000,
      currentPaid: 0,
      marketPaidAtSale: 0,
      extraCost: 0,
    };
    expect(computeSalePaymentState({ ...base, debtBeforeSale: 0 })).toEqual({
      paidAfter: 0,
      autoPay: 0,
      status: Order_status.SOLD,
    });
    expect(
      computeSalePaymentState({ ...base, debtBeforeSale: 300000 }).status,
    ).toBe(Order_status.PAID);
    expect(
      computeSalePaymentState({ ...base, debtBeforeSale: 1000 }).status,
    ).toBe(Order_status.PARTLY_PAID);
    // Regressiya: X siz xarajat holatga ta'sir qilmaydi (ilgarigidek).
    expect(
      computeSalePaymentState({
        ...base,
        extraCost: 5000,
        debtBeforeSale: 200000,
      }).status,
    ).toBe(Order_status.PARTLY_PAID);
  });

  it('X > 0 — sof qarz (to_be_paid − xarajat) yopilsa PAID, aks holda PARTLY_PAID; autoPay qolganiga', () => {
    expect(
      computeSalePaymentState({
        netToBePaid: 205000,
        currentPaid: 0,
        marketPaidAtSale: 200000,
        debtBeforeSale: 0,
        extraCost: 5000,
      }),
    ).toEqual({ paidAfter: 200000, autoPay: 0, status: Order_status.PAID });
    expect(
      computeSalePaymentState({
        netToBePaid: 205000,
        currentPaid: 0,
        marketPaidAtSale: 155000,
        debtBeforeSale: 50000,
        extraCost: 0,
      }),
    ).toEqual({ paidAfter: 205000, autoPay: 50000, status: Order_status.PAID });
    expect(
      computeSalePaymentState({
        netToBePaid: 205000,
        currentPaid: 0,
        marketPaidAtSale: 1,
        debtBeforeSale: 0,
        extraCost: 0,
      }).status,
    ).toBe(Order_status.PARTLY_PAID);
  });
});

describe('T0UGh8bL — sellOrder {paidAmount}', () => {
  it('⭐ kuryer, to`liq X — PAID; market income + teng expense; kuryer −X; settlement −X', async () => {
    const h = makeService();

    const res = await h.sell(COURIER, { paidAmount: 205000 });

    expect((res as Row).data).toMatchObject({
      status: Order_status.PAID,
      paid_amount: 205000,
      to_be_paid: 205000,
      sale_market_paid_amount: 205000,
    });
    expect(legs(h.outboxed, Cashbox_type.FOR_MARKET)).toEqual([
      ['income', 'sell', 205000],
      ['expense', 'market_payment', 205000],
    ]);
    expect(legs(h.outboxed, Cashbox_type.FOR_COURIER)).toEqual([
      ['income', 'sell', 220000],
      ['expense', 'courier_payment', 205000],
    ]);
    // X oyoqlari ham sotuv tokeni bilan (qayta yetkazishda finance dedup).
    expect(
      h.outboxed
        .filter((leg) => leg.source_type !== 'sell')
        .every(
          (leg) =>
            leg.source_id === '7001' &&
            typeof leg.dedup_epoch === 'string' &&
            leg.dedup_epoch.length > 0,
        ),
    ).toBe(true);
    expect(h.settlements[0]).toMatchObject({
      courier_amount: 15000,
      branch_amount: 15000,
      market_amount: 0,
    });
  });

  it('⭐ menejer sotuvi (filial kassasi) — X filial kassasidan yechiladi, courier_amount o`zgarmaydi', async () => {
    const h = makeService({ order: { courier_id: null } });

    await h.sell(MANAGER, { paidAmount: 100000 });

    expect(h.patch()).toMatchObject({
      status: Order_status.PARTLY_PAID,
      paid_amount: 100000,
      sale_market_paid_amount: 100000,
    });
    expect(legs(h.outboxed, Cashbox_type.BRANCH)).toEqual([
      ['income', 'sell', 250000],
      ['expense', 'market_payment', 100000],
    ]);
    expect(legs(h.outboxed, Cashbox_type.FOR_COURIER)).toEqual([]);
    expect(h.settlements[0]).toMatchObject({
      courier_id: null,
      courier_amount: 250000,
      branch_amount: 150000,
      market_amount: 105000,
    });
  });

  it('xarajat bilan sof qarz to`liq yopilsa — PAID (finance FIFO bilan bir xil)', async () => {
    const h = makeService();

    await h.sell(COURIER, {
      paidAmount: 200000,
      extraCost: 5000,
      extraCostApproved: true,
    });

    expect(h.patch()).toMatchObject({
      status: Order_status.PAID,
      paid_amount: 200000,
      extra_cost: 5000,
    });
    expect(h.settlements[0]).toMatchObject({ market_amount: 0 });
  });

  it('market qarzdor (−50 000): X ≤ 155 000; 155 000 bilan autoPay qolganini yopadi — PAID', async () => {
    const over = makeService({ marketBalance: -50000 });
    const error = await rpcError(over.sell(COURIER, { paidAmount: 155001 }));
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('(155000)');
    expect(over.outboxed).toHaveLength(0);

    const h = makeService({ marketBalance: -50000 });
    await h.sell(COURIER, { paidAmount: 155000 });
    expect(h.patch()).toMatchObject({
      status: Order_status.PAID,
      paid_amount: 205000,
      sale_market_paid_amount: 155000,
    });
    expect(h.settlements[0]).toMatchObject({ market_amount: 50000 });
  });

  it.each([
    ['chegaradan oshgan', { paidAmount: 205001 }, '(205000)'],
    ['kasr', { paidAmount: 1500.5 }, 'butun'],
    ['manfiy', { paidAmount: -1 }, 'manfiy'],
    ['son emas', { paidAmount: 'abc' }, 'butun'],
  ])(
    '%s — 400, tranzaksiya/tasdiq ochilmaydi, oyoq yozilmaydi',
    async (_label, dto, fragment) => {
      const h = makeService();
      const error = await rpcError(h.sell(COURIER, dto));
      expect(error.statusCode).toBe(400);
      expect(error.message).toContain('paidAmount');
      expect(error.message).toContain(fragment);
      expect(h.mocks.createQueryRunner).not.toHaveBeenCalled();
      expect(h.mocks.requestApproval).not.toHaveBeenCalled();
      expect(h.outboxed).toHaveLength(0);
    },
  );

  it('⭐ hamkor (tashqi) buyurtmasi — 400 (hamkor daftari faqat payment/market webhooki bilan)', async () => {
    const h = makeService({ order: { external_id: 'BP-123' } });
    const error = await rpcError(h.sell(COURIER, { paidAmount: 1000 }));
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('hamkor');
    expect(h.outboxed).toHaveLength(0);

    // X siz hamkor buyurtmasi avvalgidek sotiladi.
    const ok = makeService({ order: { external_id: 'BP-123' } });
    await ok.sell(COURIER, { paidAmount: 0 });
    expect(ok.patch()).toMatchObject({ status: Order_status.SOLD });
  });

  it('⭐ HQ menejeri (filial kassasi yo`q) — X > 0 — 400; X siz avvalgidek', async () => {
    const h = makeService({
      order: { courier_id: null },
      settlementBranchId: null,
    });
    const error = await rpcError(h.sell(MANAGER, { paidAmount: 1000 }));
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('HQ sotuvi');
    expect(h.outboxed).toHaveLength(0);

    const ok = makeService({
      order: { courier_id: null },
      settlementBranchId: null,
    });
    await ok.sell(MANAGER, {});
    expect(ok.patch()).toMatchObject({ status: Order_status.SOLD });
  });

  it('regressiya: {paidAmount: 0} va {} — AYNAN bir xil oyoqlar, SOLD, snapshot null', async () => {
    const a = makeService();
    const b = makeService();
    await a.sell(COURIER, { paidAmount: 0 });
    await b.sell(COURIER, {});
    const strip = (rows: Row[]) =>
      rows.map((leg) => {
        const copy = { ...leg };
        delete copy.dedup_epoch;
        return copy;
      });
    expect(strip(a.outboxed)).toEqual(strip(b.outboxed));
    expect(a.patch()).toMatchObject({
      status: Order_status.SOLD,
      paid_amount: 0,
      sale_market_paid_amount: null,
    });
    expect(a.settlements).toEqual(b.settlements);
  });

  it('tasdiq (extra-cost approval) talab qilinsa — X chegarasi undan OLDIN tekshiriladi', async () => {
    const h = makeService();
    h.mocks.requestApproval.mockResolvedValue({ pending: true });

    const error = await rpcError(
      h.sell(COURIER, { paidAmount: 999999, extraCost: 5000 }),
    );
    expect(error.statusCode).toBe(400);
    expect(h.mocks.requestApproval).not.toHaveBeenCalled();

    // To'g'ri X bilan tasdiq so'rovi ochiladi (X payload ichida saqlanadi).
    const ok = makeService();
    ok.mocks.requestApproval.mockResolvedValue({ pending: true });
    await ok.sell(COURIER, { paidAmount: 100000, extraCost: 5000 });
    expect(ok.mocks.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        dto: expect.objectContaining({ paidAmount: 100000 }),
      }),
    );
    expect(ok.outboxed).toHaveLength(0);
  });
});
