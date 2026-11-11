/**
 * (SPEC v2, 2026-11-12) Kechiktirilgan qo'shimcha xarajat — unit spec'lar.
 *
 * Dilshod: «buyurtma joyida sotildi yoki bekor bo'ldi bo'lsin, ortiqcha
 * harajatini o'zi kutilmoqda bo'ladi — alohida tranzaksiya, qaysi tovar
 * uchunligi ko'rinsin».
 *
 *  • amal paytida: E = 0 bilan bajariladi (kassa / settlement / daftar /
 *    `extra_cost`), E — `pending` + `mode = 'deferred'` so'rov (tovarlar va
 *    snapshot bilan), javob 200 + `extra_cost_request` (HECH QACHON 202);
 *  • tasdiq: E alohida — oyoqlar, daftar, ikki settlement qatori,
 *    `extra_cost`, ortiqcha hodisasi, turtki; ikkinchi urinish 409;
 *  • rad etish: pul yo'q, xabar matni kechiktirilgan variantda;
 *  • hamkor buyurtmasi va tasdiqsiz market — avvalgi yo'llar.
 *
 * Haqiqiy Postgres'dagi pul invarianti (crit-money a, b, b′, c, d, i),
 * rollback va kuryer o'tkazish tekshiruvi —
 * `order-service.extra-cost-deferred.pg.spec.ts`.
 */
import { of } from 'rxjs';
import { RpcException } from '@nestjs/microservices';
import {
  Cashbox_type,
  Order_status,
  SettlementStatus,
  Where_deliver,
} from '@app/common';
import { OrderLifecycleService } from './order-lifecycle.service';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderSettlement } from '../entities/order-settlement.entity';
import {
  ExtraCostApprovalItem,
  ExtraCostDeferredSnapshot,
  OrderExtraCostApproval,
} from '../entities/order-extra-cost-approval.entity';
import {
  ExtraCostApprovalTable,
  extraCostApprovalTable,
} from '../testing/extra-cost-kit-spec';
import {
  computeDeferredExtraCostOrderState,
  extraCostItemsFromOrderItems,
  extraCostItemsFromPartlySell,
  formatExtraCostItems,
  isDeferredExtraCostFamilyStatus,
  isPartnerSyncedOrder,
  legacyExtraCostItems,
  withExtraCostItemNames,
} from './extra-cost-deferred';
import { buildExtraCostDecisionNotice } from '../notification/extra-cost-notifications';
import { EXTRA_COST_CLOSE_REASON } from './order-lifecycle.service';

type Row = Record<string, any>;

const E = 20000;

const ITEMS = [
  {
    id: '5501',
    product_id: '88',
    product_name: 'Telefon g‘ilofi',
    quantity: 1,
  },
  { id: '5502', product_id: null, product_name: null, quantity: 2 },
];

const ORDER = {
  id: '7001',
  status: Order_status.WAITING,
  post_id: '9001',
  market_id: '501',
  customer_id: '801',
  total_price: 200000,
  paid_online_amount: 0,
  paid_amount: 0,
  where_deliver: Where_deliver.CENTER,
  branch_id: '77',
  home_branch_id: '77',
  holder_branch_id: '77',
  comment: null,
  external_id: null,
  items: ITEMS,
} as unknown as Order;

async function expectRpc(promise: Promise<unknown>, code: number) {
  try {
    await promise;
    throw new Error('expected RpcException');
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    expect(((error as RpcException).getError() as Row)?.statusCode).toBe(code);
  }
}

/** Kit qatori bilan bog'langan QueryRunner (rollback — jadval holati qaytadi). */
function runnerFor(table: ExtraCostApprovalTable, manager: unknown) {
  let rollback: (() => void) | null = null;
  const runner = {
    manager,
    isTransactionActive: false,
    connect: jest.fn(),
    startTransaction: jest.fn(() => {
      rollback = table.begin();
      runner.isTransactionActive = true;
    }),
    commitTransaction: jest.fn(() => {
      rollback = null;
      runner.isTransactionActive = false;
    }),
    rollbackTransaction: jest.fn(() => {
      rollback?.();
      rollback = null;
      runner.isTransactionActive = false;
    }),
    release: jest.fn(),
  };
  return runner;
}

// ---------------------------------------------------------------------------
// Sof yordamchilar
// ---------------------------------------------------------------------------

describe('SPEC v2 — kechiktirilgan E: sof yordamchilar', () => {
  it('amal oilasi: sotuv — SOLD/PAID/PARTLY_PAID/CLOSED; bekor — CANCELLED va keyingi bosqichlar', () => {
    for (const status of [
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
      Order_status.CLOSED,
    ]) {
      expect(isDeferredExtraCostFamilyStatus('sell', status)).toBe(true);
      expect(isDeferredExtraCostFamilyStatus('partly_sell', status)).toBe(true);
    }
    expect(isDeferredExtraCostFamilyStatus('sell', Order_status.WAITING)).toBe(
      false,
    );
    expect(
      isDeferredExtraCostFamilyStatus('sell', Order_status.CANCELLED),
    ).toBe(false);
    for (const status of [
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
      Order_status.CLOSED,
      Order_status.RETURNED_TO_MARKET,
    ]) {
      expect(isDeferredExtraCostFamilyStatus('cancel', status)).toBe(true);
    }
    expect(isDeferredExtraCostFamilyStatus('cancel', Order_status.SOLD)).toBe(
      false,
    );
    expect(isDeferredExtraCostFamilyStatus('cancel', null)).toBe(false);
  });

  it('hamkor buyurtmasi — bo‘sh bo‘lmagan `external_id`', () => {
    expect(isPartnerSyncedOrder({ external_id: 'BP-1' })).toBe(true);
    expect(isPartnerSyncedOrder({ external_id: '  ' })).toBe(false);
    expect(isPartnerSyncedOrder({ external_id: null })).toBe(false);
    expect(isPartnerSyncedOrder({})).toBe(false);
  });

  it('tovarlar: sotuv/bekor — hamma qatorlar; qisman sotuv — sotilgan va qaytgan miqdor', () => {
    expect(extraCostItemsFromOrderItems(ITEMS)).toEqual([
      {
        order_item_id: '5501',
        product_id: '88',
        product_name: 'Telefon g‘ilofi',
        quantity: 1,
      },
      {
        order_item_id: '5502',
        product_id: null,
        product_name: null,
        quantity: 2,
      },
    ]);
    expect(
      extraCostItemsFromPartlySell([
        { item: ITEMS[0], quantity: 1 },
        { item: ITEMS[1], quantity: 0 },
      ]),
    ).toEqual([
      expect.objectContaining({
        order_item_id: '5501',
        quantity: 1,
        sold_quantity: 1,
        returned_quantity: 0,
      }),
      expect.objectContaining({
        order_item_id: '5502',
        quantity: 0,
        sold_quantity: 0,
        returned_quantity: 2,
      }),
    ]);
  });

  it('nomlar: katalog → qatordagi nom → «Tovar #id»; matn «+N» bilan qisqaradi', () => {
    const named = withExtraCostItemNames(
      extraCostItemsFromOrderItems([
        ...ITEMS,
        { id: '5503', product_id: '90', product_name: 'eski nom', quantity: 1 },
      ]),
      new Map([['90', 'Zaryadka']]),
    );
    expect(named.map((item) => item.product_name)).toEqual([
      'Telefon g‘ilofi',
      'Tovar #5502',
      'Zaryadka',
    ]);
    expect(formatExtraCostItems(named)).toBe(
      'Telefon g‘ilofi ×1, Tovar #5502 ×2, Zaryadka ×1',
    );
    expect(formatExtraCostItems(named, 2)).toBe(
      'Telefon g‘ilofi ×1, Tovar #5502 ×2, +1',
    );
    // Qisman sotuvda faqat sotilganlari ko'rinadi.
    expect(
      formatExtraCostItems([
        { ...named[0], quantity: 1 },
        { ...named[1], quantity: 0 },
      ] as ExtraCostApprovalItem[]),
    ).toBe('Telefon g‘ilofi ×1');
    expect(formatExtraCostItems([])).toBe('');
  });

  it('eski qator (items yo‘q): qisman sotuvda `order_item_info`, aks holda buyurtma qatorlari', () => {
    expect(
      legacyExtraCostItems({
        action: 'partly_sell',
        payload: { order_item_info: [{ order_item_id: '5501', quantity: 1 }] },
        orderItems: ITEMS,
      }),
    ).toEqual([
      {
        order_item_id: '5501',
        product_id: '88',
        product_name: 'Telefon g‘ilofi',
        quantity: 1,
        sold_quantity: 1,
      },
    ]);
    expect(
      legacyExtraCostItems({ action: 'sell', payload: {}, orderItems: ITEMS }),
    ).toHaveLength(2);
  });

  describe('tasdiqdagi market buyurtmasi holati (crit-money d/k)', () => {
    const state = (status: string, paidAmount: number, extraCost = E) =>
      computeDeferredExtraCostOrderState({
        status,
        toBePaid: 170000,
        paidAmount,
        extraCost,
      });

    it('SOLD, to‘lanmagan — holat o‘zgarmaydi, FIFO keyin yopadi', () => {
      expect(state(Order_status.SOLD, 0)).toEqual({
        status: Order_status.SOLD,
        paidAmount: 0,
        overage: 0,
      });
    });

    it('⭐ PAID (HQ allaqachon to‘lagan) — PAID qoladi, ortiqcha = E', () => {
      expect(state(Order_status.PAID, 170000)).toEqual({
        status: Order_status.PAID,
        paidAmount: 170000,
        overage: E,
      });
    });

    it('⭐ PARTLY_PAID 160 000 — PAID, paid_amount = to_be_paid, ortiqcha 10 000', () => {
      expect(state(Order_status.PARTLY_PAID, 160000)).toEqual({
        status: Order_status.PAID,
        paidAmount: 170000,
        overage: 10000,
      });
    });

    it('⭐ X = C − T − E (sotuvda marketga) — PARTLY_PAID → PAID, ortiqcha 0', () => {
      expect(state(Order_status.PARTLY_PAID, 150000)).toEqual({
        status: Order_status.PAID,
        paidAmount: 170000,
        overage: 0,
      });
    });

    it('PARTLY_PAID 100 000 — qoldiq bor, holat o‘zgarmaydi', () => {
      expect(state(Order_status.PARTLY_PAID, 100000)).toEqual({
        status: Order_status.PARTLY_PAID,
        paidAmount: 100000,
        overage: 0,
      });
    });

    it('bekor / CLOSED — faqat `extra_cost` (holat va to‘lov o‘zgarmaydi)', () => {
      expect(state(Order_status.CANCELLED, 0)).toEqual({
        status: Order_status.CANCELLED,
        paidAmount: 0,
        overage: 0,
      });
      expect(state(Order_status.CLOSED, 170000).overage).toBe(0);
    });
  });

  describe('qaror xabari matni', () => {
    const approval = {
      id: '41',
      order_id: '7001',
      market_id: '501',
      requested_by_user_id: '301',
      action: 'sell',
      amount: E,
    };

    it('⭐ kechiktirilgan tasdiq — tovarlar va «keyingi topshirishda hisobga olinadi»', () => {
      const notice = buildExtraCostDecisionNotice({
        kind: 'approved',
        approval: { ...approval, mode: 'deferred' },
        products: 'Telefon g‘ilofi ×1',
      });
      expect(notice.body).toMatch(/tasdiqlandi \(Telefon g‘ilofi ×1\)/);
      expect(notice.body).toMatch(/keyingi topshirishda hisobga olinadi/);
      expect(notice.status).toBe('approved');
    });

    it('⭐ kechiktirilgan rad — «sotilgan / bekor qilingan holida qoladi», qayta sotishga undamaydi', () => {
      const sold = buildExtraCostDecisionNotice({
        kind: 'rejected',
        approval: { ...approval, mode: 'deferred' },
        rejectLabel: 'Kelishilmagan',
        products: 'Telefon g‘ilofi ×1',
      });
      expect(sold.body).toMatch(
        /rad etildi \(Kelishilmagan\) \(Telefon g‘ilofi ×1\)/,
      );
      expect(sold.body).toMatch(
        /buyurtma sotilgan holida qoladi, naqdni to'liq topshirasiz/,
      );
      expect(sold.body).not.toMatch(/kutilmoqda/);
      const cancelled = buildExtraCostDecisionNotice({
        kind: 'rejected',
        approval: { ...approval, action: 'cancel', mode: 'deferred' },
      });
      expect(cancelled.body).toMatch(/bekor qilingan holida qoladi/);
    });

    it('eski (replay) matnlar o‘zgarmagan', () => {
      const replay = buildExtraCostDecisionNotice({
        kind: 'approved',
        approval,
        products: 'Telefon g‘ilofi ×1',
      });
      expect(replay.body).not.toMatch(/Telefon/);
      expect(replay.body).not.toMatch(/keyingi topshirishda/);
    });
  });
});

// ---------------------------------------------------------------------------
// Amal paytida (sotish / bekor / qisman sotish)
// ---------------------------------------------------------------------------

/**
 * `order-service.extra-cost-settlement.spec.ts` uslubi: pul mantig'i
 * haqiqiy, RMQ/TypeORM qatlami eng kichik ko'rinishda. So'rovlar jadvali
 * bitta (kit) — kechiktirilgan qator shu yerga yoziladi.
 */
function makeSale(
  opts: {
    approvalRequired?: boolean;
    externalId?: string | null;
    isManager?: boolean;
    marketBalance?: number;
    /** Jadvaldagi oldindan bor so'rovlar (masalan, deploydan oldingi replay). */
    seed?: Row[];
  } = {},
) {
  const table = extraCostApprovalTable(opts.seed ?? []);
  const saved: Row[] = [];
  const cashboxLegs: Row[] = [];
  const enqueued: Array<{ pattern: string; payload: Row }> = [];
  const updates: Row[] = [];
  const settlementRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: Row) => row),
    save: jest.fn((row: Row) => {
      saved.push(row);
      return Promise.resolve(row);
    }),
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
  const queryRunner = runnerFor(table, tx);
  const order = { ...ORDER, external_id: opts.externalId ?? null };

  // Xususiy a'zolar (stub / josus) — spec'da `any` sifatida.
  const s: Row = Object.create(OrderLifecycleService.prototype);
  Object.assign(s, {
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '301' } })),
    },
    outbox: {
      enqueue: jest.fn((_target: string, pattern: string, payload: Row) => {
        enqueued.push({ pattern, payload });
        return Promise.resolve(undefined);
      }),
    },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
    orderItemRepo: { find: jest.fn().mockResolvedValue([]) },
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    lookup: {
      getMarketsByIds: jest.fn().mockResolvedValue([
        {
          id: '501',
          tariff_center: 30000,
          tariff_home: 70000,
          expense_proof_conditions: [],
          extra_cost_enabled: true,
          extra_cost_requires_approval: opts.approvalRequired ?? true,
        },
      ]),
      getCouriersByIds: jest.fn().mockResolvedValue([
        {
          id: '301',
          tariff_center: 0,
          tariff_home: 50000,
          can_add_extra_cost: true,
          can_sell_cancel: true,
        },
      ]),
      getUserById: jest.fn().mockResolvedValue({
        id: '201',
        branch_id: '77',
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
      resolveSettlementBranchId: jest.fn().mockResolvedValue('77'),
      resolveBranchShare: jest.fn().mockResolvedValue(10000),
    },
    findById: jest.fn().mockResolvedValue(order),
    enforceOperationProof: jest.fn().mockResolvedValue(['proof/receipt.jpg']),
    // Eski 202 yo'li — chaqirilganini tekshirish uchun josus.
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    updateFull: jest.fn((_id: string, dto: Row) => {
      updates.push(dto);
      return Promise.resolve(undefined);
    }),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
    updateCashboxBalance: jest.fn((leg: Row) => {
      cashboxLegs.push(leg);
      return Promise.resolve(undefined);
    }),
  });

  const requester = opts.isManager
    ? { id: '201', roles: ['manager'], branch_id: '77' }
    : { id: '301', roles: ['courier'], branch_id: '77' };
  return {
    s,
    requester,
    table,
    saved,
    cashboxLegs,
    enqueued,
    updates,
    queryRunner,
  };
}

const extraCostLegs = (legs: Row[]) =>
  legs.filter((leg) => leg.source_type === 'extra_cost');
const ledgerKinds = (enqueued: Array<{ pattern: string; payload: Row }>) =>
  enqueued
    .filter((e) => e.pattern === 'finance.financial_balance.record')
    .map((e) => e.payload.source_type);

describe('SPEC v2 — amal paytida E kechiktiriladi', () => {
  it('⭐ sotuv: 200 + `extra_cost_request`, E pulida HECH NARSA yo‘q, so‘rov — tovarlar va snapshot bilan', async () => {
    const t = makeSale();

    const res: Row = await t.s.sellOrder(
      t.requester,
      '7001',
      { extraCost: E, comment: 'Yo‘l xarajati' },
      'sell-1',
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.approval_required).toBeUndefined();
    expect(res.data.status).toBe(Order_status.SOLD);
    expect(res.data.extra_cost_request).toMatchObject({
      id: 'approval-new',
      status: 'pending',
      mode: 'deferred',
      action: 'sell',
      amount: E,
      immediate: false,
      items: [
        expect.objectContaining({
          product_name: 'Telefon g‘ilofi',
          quantity: 1,
        }),
        expect.objectContaining({ product_name: 'Tovar #5502', quantity: 2 }),
      ],
    });
    expect(t.s.requestExtraCostApprovalIfNeeded).not.toHaveBeenCalled();
    expect(t.queryRunner.commitTransaction).toHaveBeenCalled();

    // E = 0: kassa oyog'i, daftar, settlement, `extra_cost`, izoh.
    expect(extraCostLegs(t.cashboxLegs)).toEqual([]);
    expect(ledgerKinds(t.enqueued)).not.toContain('sell_extra_cost');
    expect(t.saved).toHaveLength(1);
    expect(t.saved[0]).toMatchObject({
      courier_amount: 200000,
      branch_amount: 190000,
      market_amount: 170000,
    });
    expect(t.updates[0]).toMatchObject({
      status: Order_status.SOLD,
      extra_cost: 0,
      to_be_paid: 170000,
      paid_amount: 0,
    });
    expect(String(t.updates[0].comment ?? '')).not.toMatch(/20000|20 000/);

    // So'rov qatori: bitta, kutilmoqda, kechiktirilgan.
    expect(t.table.rows).toHaveLength(1);
    const row = t.table.rows[0];
    expect(row).toMatchObject({
      order_id: '7001',
      market_id: '501',
      requested_by_user_id: '301',
      requested_by_role: 'courier',
      action: 'sell',
      amount: E,
      status: 'pending',
      mode: 'deferred',
      proof_file_keys: ['proof/receipt.jpg'],
      operation_payload: expect.objectContaining({
        extraCost: E,
        proofFileKeys: ['proof/receipt.jpg'],
      }),
      items: extraCostItemsFromOrderItems(ITEMS),
    });
    expect(row.deferred_snapshot as ExtraCostDeferredSnapshot).toMatchObject({
      charged_cashbox_type: Cashbox_type.FOR_COURIER,
      charged_user_id: '301',
      courier_id: '301',
      branch_id: '77',
      market_id: '501',
      legs: { courier: E, branch: E, market: E },
      chain_start_status: SettlementStatus.PENDING,
      ledger_kind: 'sell_extra_cost',
      operation_at: expect.any(String),
    });

    // Market egasiga xabar: allaqachon sotilgan, tovarlar, oqibat.
    const notice = JSON.stringify(
      t.enqueued.filter((e) => !e.pattern.startsWith('finance.')),
    );
    expect(notice).toMatch(/allaqachon sotildi/);
    expect(notice).toMatch(/Telefon g‘ilofi ×1/);
    expect(notice).toMatch(/rad etilsa — yozilmaydi/);
  });

  it('⭐ menejer sotuvi: snapshot — filial kassasi (requester.branch_id), zanjir COURIER_SETTLED dan', async () => {
    const t = makeSale({ isManager: true });

    const res: Row = await t.s.sellOrder(t.requester, '7001', { extraCost: E });

    expect(res.data.extra_cost_request).toMatchObject({ mode: 'deferred' });
    expect(extraCostLegs(t.cashboxLegs)).toEqual([]);
    expect(t.table.rows[0].deferred_snapshot).toMatchObject({
      charged_cashbox_type: Cashbox_type.BRANCH,
      charged_user_id: '77',
      courier_id: null,
      branch_id: '77',
      legs: { courier: 0, branch: E, market: E },
      chain_start_status: SettlementStatus.COURIER_SETTLED,
    });
  });

  it('⭐ X chegarasi so‘ralgan E bilan: X ≤ C − T − E; holat esa E = 0 bilan (PARTLY_PAID)', async () => {
    const over = makeSale();
    await expectRpc(
      over.s.sellOrder(over.requester, '7001', {
        extraCost: E,
        paidAmount: 150001,
      }),
      400,
    );
    expect(over.table.rows).toHaveLength(0);
    expect(over.cashboxLegs).toEqual([]);

    const t = makeSale();
    const res: Row = await t.s.sellOrder(t.requester, '7001', {
      extraCost: E,
      paidAmount: 150000,
    });
    // E = 0 bilan: 150 000 / 170 000 — PARTLY_PAID (E bilan PAID bo'lardi).
    expect(res.data).toMatchObject({
      status: Order_status.PARTLY_PAID,
      paid_amount: 150000,
      sale_market_paid_amount: 150000,
    });
    expect(res.data.extra_cost_request).toMatchObject({ mode: 'deferred' });
  });

  it('⭐ bekor qilish: 200 + `{ id, extra_cost_request }`, pul / kredit qatori yo‘q', async () => {
    const t = makeSale();
    // Bekor qilishda chegara — kuryer markaz tarifi.
    t.s.lookup.getCouriersByIds.mockResolvedValue([
      {
        id: '301',
        tariff_center: E,
        tariff_home: 50000,
        can_add_extra_cost: true,
        can_sell_cancel: true,
      },
    ]);

    const res: Row = await t.s.cancelOrder(t.requester, '7001', {
      extraCost: E,
      comment: 'Mijoz olmadi',
    });

    expect(res.statusCode).toBe(200);
    expect(res.data).toMatchObject({
      id: '7001',
      extra_cost_request: {
        status: 'pending',
        mode: 'deferred',
        action: 'cancel',
      },
    });
    expect(t.cashboxLegs).toEqual([]);
    expect(ledgerKinds(t.enqueued)).toEqual([]);
    expect(t.saved).toEqual([]);
    expect(t.updates[0]).toMatchObject({
      status: Order_status.CANCELLED,
      extra_cost: 0,
    });
    expect(t.table.rows[0]).toMatchObject({
      action: 'cancel',
      mode: 'deferred',
      status: 'pending',
      deferred_snapshot: expect.objectContaining({
        charged_cashbox_type: Cashbox_type.FOR_COURIER,
        courier_id: '301',
        legs: { courier: E, branch: E, market: E },
        chain_start_status: SettlementStatus.PENDING,
        ledger_kind: 'cancel_extra_cost',
      }),
    });
  });

  it('⭐ hamkor buyurtmasi — eski (replay) yo‘l: kechiktirilmaydi', async () => {
    const t = makeSale({ externalId: 'BP-7001' });
    t.s.requestExtraCostApprovalIfNeeded.mockResolvedValue({
      statusCode: 202,
      data: { approval_required: true },
    });

    const res: Row = await t.s.sellOrder(t.requester, '7001', { extraCost: E });

    expect(res.statusCode).toBe(202);
    expect(t.s.requestExtraCostApprovalIfNeeded).toHaveBeenCalled();
    expect(t.table.rows).toHaveLength(0);
  });

  it('⭐ market tasdig‘i o‘chiq — bugungi darhol yo‘l (E pul bilan), `immediate` qatorida tovarlar', async () => {
    const t = makeSale({ approvalRequired: false });

    const res: Row = await t.s.sellOrder(t.requester, '7001', { extraCost: E });

    expect(res.data.extra_cost_request).toBeUndefined();
    expect(extraCostLegs(t.cashboxLegs).map((leg) => leg.cashbox_type)).toEqual(
      [Cashbox_type.FOR_MARKET, Cashbox_type.FOR_COURIER],
    );
    expect(ledgerKinds(t.enqueued)).toContain('sell_extra_cost');
    expect(t.saved[0]).toMatchObject({
      courier_amount: 180000,
      branch_amount: 170000,
      market_amount: 150000,
    });
    expect(t.updates[0]).toMatchObject({ extra_cost: E });
    expect(t.table.rows).toHaveLength(1);
    expect(t.table.rows[0]).toMatchObject({
      status: 'approved',
      immediate: true,
      items: extraCostItemsFromOrderItems(ITEMS),
    });
    expect(t.table.rows[0].mode).toBeUndefined();
  });

  it('qayta ijro (tasdiq bilan bajarilayotgan amal) hech qachon kechiktirilmaydi', () => {
    const t = makeSale();
    const defer = (options?: Row) =>
      t.s.shouldDeferExtraCost({
        extraCost: E,
        market: { extra_cost_requires_approval: true },
        order: { market_id: '501', external_id: null },
        requester: { id: '301', roles: ['courier'] },
        options,
      });
    expect(defer()).toBe(true);
    expect(defer({ extraCostApproval: { id: '1', patch: {} } })).toBe(false);
    // Admin/superadmin — eski yo'l (kuryer/menejer emas).
    expect(
      t.s.shouldDeferExtraCost({
        extraCost: E,
        market: { extra_cost_requires_approval: true },
        order: { market_id: '501' },
        requester: { id: '1', roles: ['superadmin'] },
      }),
    ).toBe(false);
  });
});

describe('SPEC v2 — qisman sotuvda E kechiktiriladi', () => {
  /** `order-service.extra-cost-immediate.GykuOz8f.spec.ts` dagi qisman sotuv uslubi. */
  function partly(seed: Row[] = []) {
    const table = extraCostApprovalTable(seed);
    const cashboxLegs: Row[] = [];
    const enqueued: Array<{ pattern: string; payload: Row }> = [];
    const updates: Row[] = [];
    const settlementSaves: Row[] = [];
    const manager = {
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
    };
    const queryRunner = runnerFor(table, manager);
    // Xususiy a'zolar (stub / josus) — spec'da `any` sifatida.
    const s: Row = Object.create(OrderLifecycleService.prototype);
    const noop = () => Promise.resolve(undefined);
    const items = [
      {
        id: '5501',
        product_id: '88',
        product_name: 'Telefon g‘ilofi',
        quantity: 2,
      },
      { id: '5502', product_id: null, product_name: 'Zaryadka', quantity: 1 },
    ];
    Object.assign(s, {
      findById: jest.fn().mockResolvedValue({
        ...ORDER,
        id: '120',
        total_price: 1000000,
        items,
      }),
      logisticsClient: {
        send: () => of({ data: { id: '9001', courier_id: '301' } }),
      },
      resolveActorCourierId: () => '301',
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
            extra_cost_requires_approval: true,
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
      enforceOperationProof: jest.fn().mockResolvedValue([]),
      requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
      orderItemRepo: { find: jest.fn().mockResolvedValue(items) },
      resolveHolderFromState: jest.fn().mockResolvedValue({
        holder_type: 'COURIER',
        holder_branch_id: '77',
        holder_courier_id: '301',
      }),
      dataSource: { createQueryRunner: () => queryRunner },
      lockWaitingOrder: noop,
      updateCashboxBalance: jest.fn((leg: Row) => {
        cashboxLegs.push(leg);
        return Promise.resolve(undefined);
      }),
      updateFull: jest.fn((_id: string, dto: Row) => {
        updates.push(dto);
        return Promise.resolve(undefined);
      }),
      recordSaleSettlement: jest.fn((_tx: unknown, row: Row) => {
        settlementSaves.push(row);
        return Promise.resolve(undefined);
      }),
      custody: {
        createTrackingEvent: noop,
        createCustodyEvent: noop,
        toTrackingRole: () => 'courier',
        auditActor: () => ({}),
      },
      syncOrderToSearch: noop,
      resolveSyncAction: () => null,
      outbox: {
        enqueue: jest.fn((_target: string, pattern: string, payload: Row) => {
          enqueued.push({ pattern, payload });
          return Promise.resolve(undefined);
        }),
      },
      activityLog: { log: noop },
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    });
    const run = (requestId?: string, options?: Row) =>
      s.partlySellOrder(
        { id: '301', roles: ['courier'], branch_id: '77' },
        '120',
        {
          order_item_info: [
            { order_item_id: '5501', quantity: 1 },
            { order_item_id: '5502', quantity: 0 },
          ] as never,
          totalPrice: 500000,
          extraCost: 6000,
        },
        requestId,
        options,
      );
    return { s, run, table, cashboxLegs, enqueued, updates, settlementSaves };
  }

  it('⭐ qisman sotuv: 200 + `{ extra_cost_request }`, E puli yo‘q, tovarlarda sotilgan / qaytgan miqdor', async () => {
    const t = partly();

    const res: Row = await t.run();

    expect(res.statusCode).toBe(200);
    expect(res.data.extra_cost_request).toMatchObject({
      status: 'pending',
      mode: 'deferred',
      action: 'partly_sell',
      amount: 6000,
    });
    expect(t.s.requestExtraCostApprovalIfNeeded).not.toHaveBeenCalled();
    expect(extraCostLegs(t.cashboxLegs)).toEqual([]);
    expect(ledgerKinds(t.enqueued)).not.toContain('sell_extra_cost');
    expect(t.settlementSaves).toHaveLength(1);
    for (const row of t.settlementSaves) {
      // Qisman sotuv qatori E siz (kuryer ulushi 30 000 dan tashqari).
      expect(row.market_amount).toBe(500000 - 45000);
    }
    expect(t.table.rows).toHaveLength(1);
    expect(t.table.rows[0]).toMatchObject({
      action: 'partly_sell',
      mode: 'deferred',
      status: 'pending',
      amount: 6000,
      items: [
        expect.objectContaining({
          order_item_id: '5501',
          quantity: 1,
          sold_quantity: 1,
          returned_quantity: 1,
        }),
        expect.objectContaining({
          order_item_id: '5502',
          quantity: 0,
          sold_quantity: 0,
          returned_quantity: 1,
        }),
      ],
      deferred_snapshot: expect.objectContaining({
        ledger_kind: 'sell_extra_cost',
        legs: expect.objectContaining({ market: 6000 }),
      }),
    });
    // Xabarda faqat sotilgan tovar.
    const notice = JSON.stringify(
      t.enqueued.filter((e) => !e.pattern.startsWith('finance.')),
    );
    expect(notice).toMatch(/allaqachon qisman sotildi/);
    expect(notice).toMatch(/Telefon g‘ilofi ×1/);
    expect(notice).not.toMatch(/Zaryadka/);
  });

  it('⭐ D5 qisman sotuv: replay tasdig‘i — E hozir (`sell_extra_cost`), yangi deferred qator yo‘q', async () => {
    const t = partly([replayRow('7', 'partly_sell', 6000, '120')]);
    useRealReplayGate(t.s);

    const res: Row = await t.run('extra-cost-approval:7', replayOptions('7'));

    expect(res.statusCode).toBe(200);
    expect(res.data.extra_cost_request).toBeUndefined();
    expect(extraCostLegs(t.cashboxLegs).map((leg) => leg.cashbox_type)).toEqual(
      [Cashbox_type.FOR_MARKET, Cashbox_type.FOR_COURIER],
    );
    expect(ledgerKinds(t.enqueued)).toContain('sell_extra_cost');
    expect(t.table.rows).toHaveLength(1);
    expect(t.table.row('7')).toMatchObject({
      status: 'approved',
      mode: 'replay',
    });
    expect(requestedNotices(t.enqueued)).toEqual([]);
  });

  it('§1 qisman sotuv: kutilmoqda turgan replay qatori `void`, javob 200 + deferred', async () => {
    const t = partly([replayRow('6', 'partly_sell', 5000, '120')]);

    const res: Row = await t.run();

    expect(res.statusCode).toBe(200);
    expect(res.data.extra_cost_request).toMatchObject({
      status: 'pending',
      mode: 'deferred',
      action: 'partly_sell',
    });
    expect(t.s.requestExtraCostApprovalIfNeeded).not.toHaveBeenCalled();
    expect(t.table.row('6')).toMatchObject({
      status: 'void',
      closed_reason: EXTRA_COST_CLOSE_REASON.executed,
    });
    expect(
      t.table.rows
        .filter((row) => row.status === 'pending')
        .map((row) => row.mode),
    ).toEqual(['deferred']);
  });
});

// ---------------------------------------------------------------------------
// Eski (replay) so'rovlar — D5 qo'riqchisi va SPEC §1 (tasdiq YOQIQ, oddiy
// buyurtma, HAQIQIY sotish / bekor / qisman sotish)
// ---------------------------------------------------------------------------

/** Deploydan oldingi `pending` replay so'rovi (migratsiya 219 dan oldin). */
const replayRow = (
  id: string,
  action: string,
  amount: number,
  orderId: string,
) => ({
  id,
  order_id: orderId,
  market_id: '501',
  requested_by_user_id: '301',
  requested_by_role: 'courier',
  requester_branch_id: '77',
  action,
  amount,
  status: 'pending',
  mode: 'replay',
  proof_file_keys: [],
  operation_payload: { extraCost: amount },
});

/** `approveExtraCostApproval` qayta ijroga beradigan 5-parametr. */
const replayOptions = (id: string) => ({
  extraCostApproval: {
    id,
    patch: {
      decided_by_user_id: '501',
      decided_at: new Date('2026-11-12T09:00:00.000Z'),
      decision_comment: null,
      auto_approved: false,
    },
  },
});

/**
 * HAQIQIY D5 qo'riqchisi: `requestExtraCostApprovalIfNeeded` stub EMAS
 * (prototipdagisi), qayta ijro darvozasi (`order_tracking`) — «holat
 * o'zgarmagan».
 */
const useRealReplayGate = (s: Row) => {
  delete s.requestExtraCostApprovalIfNeeded;
  s.extraCostStatusChangedSince = jest.fn().mockResolvedValue(null);
};

const requestedNotices = (enqueued: Array<{ pattern: string; payload: Row }>) =>
  JSON.stringify(enqueued).match(/order\.extra_cost_requested/g) ?? [];

describe('SPEC v2 — eski (replay) so‘rov: tasdiq yoqiq, oddiy buyurtma (D5 / §1)', () => {
  it('⭐ D5 sotuv: replay qatori tasdig‘i — E HOZIR yoziladi, yangi deferred qator OCHILMAYDI', async () => {
    const t = makeSale({ seed: [replayRow('7', 'sell', E, '7001')] });
    useRealReplayGate(t.s);

    const res: Row = await t.s.sellOrder(
      t.requester,
      '7001',
      { extraCost: E },
      'extra-cost-approval:7',
      replayOptions('7'),
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.extra_cost_request).toBeUndefined();
    expect(res.data.approval_required).toBeUndefined();
    expect(extraCostLegs(t.cashboxLegs).map((leg) => leg.cashbox_type)).toEqual(
      [Cashbox_type.FOR_MARKET, Cashbox_type.FOR_COURIER],
    );
    expect(ledgerKinds(t.enqueued)).toContain('sell_extra_cost');
    expect(t.updates[0]).toMatchObject({
      status: Order_status.SOLD,
      extra_cost: E,
    });
    expect(t.saved[0]).toMatchObject({
      courier_amount: 180000,
      branch_amount: 170000,
      market_amount: 150000,
    });
    expect(t.table.rows).toHaveLength(1);
    expect(t.table.row('7')).toMatchObject({
      status: 'approved',
      mode: 'replay',
      decided_by_user_id: '501',
    });
    expect(requestedNotices(t.enqueued)).toEqual([]);
  });

  it('⭐ D5 bekor qilish: replay tasdig‘i — `cancel_extra_cost` hozir, yangi qator yo‘q', async () => {
    const t = makeSale({ seed: [replayRow('7', 'cancel', E, '7001')] });
    useRealReplayGate(t.s);
    t.s.lookup.getCouriersByIds.mockResolvedValue([
      {
        id: '301',
        tariff_center: E,
        tariff_home: 50000,
        can_add_extra_cost: true,
        can_sell_cancel: true,
      },
    ]);

    const res: Row = await t.s.cancelOrder(
      t.requester,
      '7001',
      { extraCost: E, comment: 'Mijoz olmadi' },
      'extra-cost-approval:7',
      replayOptions('7'),
    );

    expect(res.statusCode).toBe(200);
    expect(res.data.extra_cost_request).toBeUndefined();
    expect(extraCostLegs(t.cashboxLegs).map((leg) => leg.cashbox_type)).toEqual(
      [Cashbox_type.FOR_MARKET, Cashbox_type.FOR_COURIER],
    );
    expect(ledgerKinds(t.enqueued)).toContain('cancel_extra_cost');
    expect(t.updates[0]).toMatchObject({
      status: Order_status.CANCELLED,
      extra_cost: E,
    });
    expect(t.table.rows).toHaveLength(1);
    expect(t.table.row('7')).toMatchObject({
      status: 'approved',
      mode: 'replay',
    });
    expect(requestedNotices(t.enqueued)).toEqual([]);
  });

  it('⭐ §1 sotuv: kutilmoqda turgan replay qatori `void` (executed), 202 / almashtirish yo‘li yo‘q — 200 + deferred', async () => {
    const t = makeSale({ seed: [replayRow('6', 'sell', 15000, '7001')] });

    const res: Row = await t.s.sellOrder(t.requester, '7001', {
      extraCost: E,
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.approval_required).toBeUndefined();
    expect(res.data.extra_cost_request).toMatchObject({
      status: 'pending',
      mode: 'deferred',
      amount: E,
    });
    expect(t.s.requestExtraCostApprovalIfNeeded).not.toHaveBeenCalled();
    expect(t.table.row('6')).toMatchObject({
      status: 'void',
      closed_reason: EXTRA_COST_CLOSE_REASON.executed,
    });
    // Ochiq so'rov bitta — yangi kechiktirilgan qator.
    expect(
      t.table.rows
        .filter((row) => row.status === 'pending')
        .map((row) => row.mode),
    ).toEqual(['deferred']);
    expect(extraCostLegs(t.cashboxLegs)).toEqual([]);
  });

  it('§1 bekor qilish: kutilmoqda turgan replay qatori `void`, javob 200 + deferred', async () => {
    const t = makeSale({ seed: [replayRow('6', 'cancel', 15000, '7001')] });
    t.s.lookup.getCouriersByIds.mockResolvedValue([
      {
        id: '301',
        tariff_center: E,
        tariff_home: 50000,
        can_add_extra_cost: true,
        can_sell_cancel: true,
      },
    ]);

    const res: Row = await t.s.cancelOrder(t.requester, '7001', {
      extraCost: E,
      comment: 'Mijoz olmadi',
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.extra_cost_request).toMatchObject({
      status: 'pending',
      mode: 'deferred',
      action: 'cancel',
    });
    expect(t.s.requestExtraCostApprovalIfNeeded).not.toHaveBeenCalled();
    expect(t.table.row('6')).toMatchObject({
      status: 'void',
      closed_reason: EXTRA_COST_CLOSE_REASON.executed,
    });
    expect(
      t.table.rows
        .filter((row) => row.status === 'pending')
        .map((row) => row.mode),
    ).toEqual(['deferred']);
  });
});

// ---------------------------------------------------------------------------
// Tasdiq / rad etish
// ---------------------------------------------------------------------------

const SNAPSHOT: ExtraCostDeferredSnapshot = {
  charged_cashbox_type: Cashbox_type.FOR_COURIER,
  charged_user_id: '301',
  courier_id: '301',
  branch_id: '77',
  market_id: '501',
  legs: { courier: E, branch: E, market: E },
  chain_start_status: SettlementStatus.PENDING,
  ledger_kind: 'sell_extra_cost',
  operation_at: '2026-11-12T08:00:00.000Z',
  order_number: null,
};

function makeDecision(
  opts: {
    order?: Row | null;
    approval?: Row;
    marketCashbox?: boolean;
  } = {},
) {
  const table = extraCostApprovalTable([
    {
      id: '41',
      order_id: '7001',
      market_id: '501',
      requested_by_user_id: '301',
      requested_by_role: 'courier',
      requester_branch_id: '77',
      action: 'sell',
      amount: E,
      status: 'pending',
      mode: 'deferred',
      proof_file_keys: ['proof/receipt.jpg'],
      operation_payload: { extraCost: E },
      items: extraCostItemsFromOrderItems(ITEMS),
      deferred_snapshot: SNAPSHOT,
      ...opts.approval,
    },
  ]);
  const order =
    opts.order === null
      ? null
      : {
          id: '7001',
          status: Order_status.SOLD,
          to_be_paid: 170000,
          paid_amount: 0,
          isDeleted: false,
          ...opts.order,
        };
  const settlementRows: Row[] = [];
  const cashboxLegs: Row[] = [];
  const enqueued: Array<{ pattern: string; payload: Row }> = [];
  const updates: Row[] = [];
  const settlementRepo = {
    create: jest.fn((row: Row) => row),
    save: jest.fn((row: Row) => {
      settlementRows.push(row);
      return Promise.resolve(row);
    }),
  };
  const orderLockRepo = {
    findOne: jest.fn(() => Promise.resolve(order ? { ...order } : null)),
  };
  const tx = {
    getRepository: jest.fn((entity: unknown) =>
      entity === OrderExtraCostApproval
        ? table
        : entity === OrderSettlement
          ? settlementRepo
          : entity === Order
            ? orderLockRepo
            : {},
    ),
  };
  const queryRunner = runnerFor(table, tx);
  const nudge = jest.fn().mockResolvedValue(undefined);

  // Xususiy a'zolar (stub / josus) — spec'da `any` sifatida.
  const s: Row = Object.create(OrderLifecycleService.prototype);
  Object.assign(s, {
    extraCostApprovalRepo: table,
    dataSource: {
      createQueryRunner: jest.fn(() => queryRunner),
      transaction: jest.fn(<T>(work: (m: unknown) => Promise<T>) =>
        table.transaction(() => work(tx)),
      ),
    },
    outbox: {
      enqueue: jest.fn((_target: string, pattern: string, payload: Row) => {
        enqueued.push({ pattern, payload });
        return Promise.resolve(undefined);
      }),
    },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    identityClient: { send: jest.fn(() => of({ data: [] })) },
    orderItemRepo: { find: jest.fn().mockResolvedValue([]) },
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    lookup: {
      getCashboxByUser: jest.fn((_id: string, type: Cashbox_type) =>
        Promise.resolve(
          type === Cashbox_type.FOR_MARKET && opts.marketCashbox === false
            ? null
            : { id: `${type}-cashbox`, balance: 0 },
        ),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
    },
    updateCashboxBalance: jest.fn((leg: Row) => {
      cashboxLegs.push(leg);
      return Promise.resolve(undefined);
    }),
    updateFull: jest.fn((_id: string, dto: Row) => {
      updates.push(dto);
      return Promise.resolve(undefined);
    }),
    settlementService: { nudgeExtraCostSettlement: nudge },
  });
  return {
    s,
    table,
    queryRunner,
    settlementRows,
    cashboxLegs,
    enqueued,
    updates,
    nudge,
  };
}

const MARKET_OWNER = { id: '501', roles: ['market'] };

describe('SPEC v2 — kechiktirilgan E tasdig‘i', () => {
  it('⭐ tasdiq: market −E va kuryer −E (tovarlar izohda), daftar −E, ikki settlement qatori, `extra_cost`, turtki', async () => {
    const t = makeDecision();

    const res: Row = await t.s.approveExtraCostApproval(MARKET_OWNER, '41');

    expect(t.queryRunner.commitTransaction).toHaveBeenCalled();
    expect(t.table.row('41')).toMatchObject({
      status: 'approved',
      decided_by_user_id: '501',
      auto_approved: false,
    });
    expect(t.cashboxLegs).toEqual([
      expect.objectContaining({
        user_id: '501',
        cashbox_type: Cashbox_type.FOR_MARKET,
        amount: E,
        operation_type: 'expense',
        source_type: 'extra_cost',
        source_id: '7001',
        created_by: '301',
        dedup_epoch: 'extra-cost:41',
        proof_files: ['proof/receipt.jpg'],
        comment: expect.stringMatching(
          /^Qo'shimcha xarajat — №.+ · Telefon g‘ilofi ×1, Tovar #5502 ×2$/,
        ),
      }),
      expect.objectContaining({
        user_id: '301',
        cashbox_type: Cashbox_type.FOR_COURIER,
        amount: E,
        dedup_epoch: 'extra-cost:41',
      }),
    ]);
    expect(
      t.enqueued.find((e) => e.pattern === 'finance.financial_balance.record')
        ?.payload,
    ).toMatchObject({
      amount: -E,
      source_type: 'sell_extra_cost',
      order_id: '7001',
      dedup_key: 'extra-cost:41',
    });
    expect(t.settlementRows).toEqual([
      expect.objectContaining({
        kind: 'extra_cost_chain',
        extra_cost_approval_id: '41',
        courier_id: '301',
        branch_id: '77',
        market_id: '501',
        courier_amount: -E,
        branch_amount: -E,
        market_amount: 0,
        status: SettlementStatus.PENDING,
      }),
      expect.objectContaining({
        kind: 'extra_cost_market',
        extra_cost_approval_id: '41',
        courier_amount: 0,
        branch_amount: 0,
        market_amount: -E,
        status: SettlementStatus.BRANCH_SETTLED,
      }),
    ]);
    // SOLD, to'lanmagan — faqat `extra_cost` (holat FIFO'da yopiladi).
    expect(t.updates).toEqual([{ extra_cost: E }]);
    expect(
      t.enqueued.some((e) => e.pattern === 'finance.market.extra_cost_overage'),
    ).toBe(false);
    expect(t.nudge).toHaveBeenCalledWith({
      courier_id: '301',
      branch_id: '77',
      market_id: '501',
      requester_id: '501',
    });
    // Kuryerga «tasdiqlandi» — kechiktirilgan matn.
    expect(JSON.stringify(t.enqueued)).toMatch(
      /keyingi topshirishda hisobga olinadi/,
    );
    expect(res.data.operation).toEqual({
      mode: 'deferred',
      order_id: '7001',
      extra_cost: E,
      status: Order_status.SOLD,
      overage: 0,
    });
    expect(res.data.approval).toMatchObject({
      status: 'approved',
      mode: 'deferred',
      items: [
        expect.objectContaining({ product_name: 'Telefon g‘ilofi' }),
        expect.objectContaining({ product_name: 'Tovar #5502' }),
      ],
    });
  });

  it('⭐ HQ marketga to‘lab bo‘lgan (PAID) — ortiqcha hodisasi (outbox), holat PAID', async () => {
    const t = makeDecision({
      order: { status: Order_status.PAID, paid_amount: 170000 },
    });

    const res: Row = await t.s.approveExtraCostApproval(MARKET_OWNER, '41');

    expect(t.updates).toEqual([{ extra_cost: E }]);
    // FOR_MARKET −E alohida oyoq EMAS — ortiqcha hodisasi ichida (finance uni
    // ortiqchani qo'llagandan KEYIN yozadi); kuryer oyog'i odatdagidek.
    expect(t.cashboxLegs.map((leg) => leg.cashbox_type)).toEqual([
      Cashbox_type.FOR_COURIER,
    ]);
    expect(
      t.enqueued.find((e) => e.pattern === 'finance.market.extra_cost_overage')
        ?.payload,
    ).toEqual({
      market_id: '501',
      amount: E,
      approval_id: '41',
      order_id: '7001',
      dedup_key: 'extra-cost-overage:41',
      market_leg: expect.objectContaining({
        user_id: '501',
        cashbox_type: Cashbox_type.FOR_MARKET,
        amount: E,
        operation_type: 'expense',
        source_type: 'extra_cost',
        source_id: '7001',
        dedup_epoch: 'extra-cost:41',
        payment_method: 'cash',
        allow_negative: true,
      }),
    });
    // Ortiqcha hodisasi boshqa finance hodisalaridan OLDIN navbatda.
    expect(
      t.enqueued.filter((e) => e.pattern.startsWith('finance.'))[0]?.pattern,
    ).toBe('finance.market.extra_cost_overage');
    expect(res.data.operation).toMatchObject({
      status: Order_status.PAID,
      overage: E,
    });
  });

  it('PARTLY_PAID 160 000 — PAID, paid_amount = to_be_paid, ortiqcha 10 000', async () => {
    const t = makeDecision({
      order: { status: Order_status.PARTLY_PAID, paid_amount: 160000 },
    });

    await t.s.approveExtraCostApproval(MARKET_OWNER, '41');

    expect(t.updates).toEqual([
      { extra_cost: E, status: Order_status.PAID, paid_amount: 170000 },
    ]);
    expect(
      t.enqueued.find((e) => e.pattern === 'finance.market.extra_cost_overage')
        ?.payload.amount,
    ).toBe(10000);
  });

  it('HQ menejeri sotuvi (kassa yo‘q, oyoqlar 0) — faqat market oyog‘i va market qatori', async () => {
    const t = makeDecision({
      approval: {
        requested_by_user_id: '202',
        requested_by_role: 'manager',
        deferred_snapshot: {
          ...SNAPSHOT,
          charged_cashbox_type: null,
          charged_user_id: null,
          courier_id: null,
          branch_id: null,
          legs: { courier: 0, branch: 0, market: E },
          chain_start_status: SettlementStatus.BRANCH_SETTLED,
        },
      },
    });

    await t.s.approveExtraCostApproval(MARKET_OWNER, '41');

    expect(t.cashboxLegs.map((leg) => leg.cashbox_type)).toEqual([
      Cashbox_type.FOR_MARKET,
    ]);
    expect(t.settlementRows.map((row) => row.kind)).toEqual([
      'extra_cost_market',
    ]);
  });

  it('bekor qilish tasdig‘i — `cancel_extra_cost`, faqat `extra_cost`', async () => {
    const t = makeDecision({
      order: { status: Order_status.CANCELLED, to_be_paid: 0 },
      approval: {
        action: 'cancel',
        deferred_snapshot: { ...SNAPSHOT, ledger_kind: 'cancel_extra_cost' },
      },
    });

    await t.s.approveExtraCostApproval(MARKET_OWNER, '41');

    expect(
      t.enqueued.find((e) => e.pattern === 'finance.financial_balance.record')
        ?.payload.source_type,
    ).toBe('cancel_extra_cost');
    expect(t.updates).toEqual([{ extra_cost: E }]);
  });

  it('⭐ ikkinchi tasdiq — 409 «allaqachon yakunlangan», pul ikkinchi marta yozilmaydi', async () => {
    const t = makeDecision();
    await t.s.approveExtraCostApproval(MARKET_OWNER, '41');
    const legs = t.cashboxLegs.length;

    await expect(
      t.s.approveExtraCostApproval(MARKET_OWNER, '41'),
    ).rejects.toMatchObject({
      error: expect.objectContaining({
        statusCode: 409,
        message: expect.stringMatching(/allaqachon yakunlangan/),
      }),
    });
    expect(t.cashboxLegs).toHaveLength(legs);
  });

  it('⭐ parallel qaror: shartli UPDATE o‘tmadi — 409, tranzaksiya qaytadi, pul yo‘q', async () => {
    const t = makeDecision();
    // Tezkor o'qish `pending` ko'rdi, lekin qulf ostida qator allaqachon rad etilgan.
    const pending = { ...t.table.row('41') };
    t.table.row('41')!.status = 'rejected';
    t.s.extraCostApprovalRepo = {
      ...t.table,
      findOne: jest.fn().mockResolvedValue(pending),
    };

    await expectRpc(t.s.approveExtraCostApproval(MARKET_OWNER, '41'), 409);
    expect(t.queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(t.cashboxLegs).toEqual([]);
    expect(t.settlementRows).toEqual([]);
    expect(t.nudge).not.toHaveBeenCalled();
  });

  it('⭐ darvoza: buyurtma amal oilasidan chiqqan (WAITING) — so‘rov void + 409, pul yo‘q', async () => {
    const t = makeDecision({ order: { status: Order_status.WAITING } });

    await expectRpc(t.s.approveExtraCostApproval(MARKET_OWNER, '41'), 409);
    expect(t.table.row('41')).toMatchObject({ status: 'void' });
    expect(t.cashboxLegs).toEqual([]);
    expect(t.settlementRows).toEqual([]);
  });

  it('darvoza: buyurtma o‘chirilgan — void + 409', async () => {
    const t = makeDecision({ order: null });

    await expectRpc(t.s.approveExtraCostApproval(MARKET_OWNER, '41'), 409);
    expect(t.table.row('41')).toMatchObject({ status: 'void' });
  });

  it('⭐ biznes xatosi (market kassasi yo‘q) — so‘rov PENDING qoladi (kuryer E ni yo‘qotmaydi)', async () => {
    const t = makeDecision({ marketCashbox: false });

    await expectRpc(t.s.approveExtraCostApproval(MARKET_OWNER, '41'), 404);
    expect(t.table.row('41')).toMatchObject({ status: 'pending' });
    expect(t.queryRunner.startTransaction).not.toHaveBeenCalled();
    expect(t.cashboxLegs).toEqual([]);
  });

  it('avtomatik tasdiq — `auto_approved`, qaror egasi yo‘q, turtki «system»', async () => {
    const t = makeDecision();

    await t.s.approveExtraCostApproval(null, '41', undefined, { auto: true });

    expect(t.table.row('41')).toMatchObject({
      status: 'approved',
      auto_approved: true,
      decided_by_user_id: null,
    });
    expect(t.nudge).toHaveBeenCalledWith(
      expect.objectContaining({ requester_id: 'system' }),
    );
  });

  it('⭐ rad etish: pul yo‘q, buyurtmaga tegilmaydi, kuryerga kechiktirilgan rad matni (tovarlar bilan)', async () => {
    const t = makeDecision();

    await t.s.rejectExtraCostApproval(MARKET_OWNER, '41', {
      comment: 'Kelishilmagan',
    });

    expect(t.table.row('41')).toMatchObject({ status: 'rejected' });
    expect(t.cashboxLegs).toEqual([]);
    expect(t.settlementRows).toEqual([]);
    expect(t.updates).toEqual([]);
    const notice = JSON.stringify(t.enqueued);
    expect(notice).toMatch(/Telefon g‘ilofi ×1/);
    expect(notice).toMatch(/buyurtma sotilgan holida qoladi/);
    expect(notice).not.toMatch(/kutilmoqda holatida/);
  });
});
