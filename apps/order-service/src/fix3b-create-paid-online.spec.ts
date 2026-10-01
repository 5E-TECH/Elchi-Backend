/**
 * fix3b — HAMKOR PREPAID PUL XATOSI (HIGH, fix3 dan oldingi).
 *
 * `createPartnerShipment` `order.create` ga `paid_online_amount =
 * subtotal − cod_amount` yuborardi, `create()` esa uni YOZMASDI (ustun
 * sukuti 0). Sotuv `total − paid_online_amount` ni naqd deb hisoblaydi —
 * ya'ni prepaid posilkada kuryer olMAGAN pul uchun qarzdor, market esa
 * marketpleys allaqachon olgan pul uchun haqdor bo'lardi.
 *
 * Endi:
 *   • SA/ADMIN/hamkor (tizim, superadmin roli) va so'rovchisiz ichki
 *     chaqiruvdan kelgan qiymat SAQLANADI, 0 ≤ qiymat ≤ total_price;
 *   • market va filial xodimidan kelgani olib tashlanadi (0);
 *   • ⭐ prepaid posilka (cod 0) sotilganda kuryer 0 naqd yig'adi.
 */
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import {
  Cashbox_type,
  Operation_type,
  Order_status,
  SettlementStatus,
  Where_deliver,
} from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order, Order_source } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderSettlement } from './entities/order-settlement.entity';

type Row = Record<string, unknown>;
type Svc = OrderLifecycleService & Record<string, any>;
type RpcBody = { statusCode?: number; message?: string };

const HQ_ID = '1';
/** `createPartnerShipment` yuboradigan so'rovchi. */
const PARTNER = { id: 'partner:7', roles: ['superadmin'] };
const ADMIN = { id: '2', roles: ['admin'] };
const MARKET = { id: '501', roles: ['market'] };
const MANAGER = { id: '201', roles: ['manager'], branch_id: '22' };
const COURIER = { id: '289', roles: ['courier'], branch_id: '22' };

async function rpcError(promise: Promise<unknown>): Promise<RpcBody> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return error.getError() as RpcBody;
    }
    throw error;
  }
  throw new Error('RpcException kutilgan edi');
}

// ───────────────────────── yaratish ─────────────────────────

function makeCreateHarness() {
  const mocks = {
    orderCreate: jest.fn((value: Row) => value),
    orderSave: jest.fn((value: Row) =>
      Promise.resolve({ id: '900', product_quantity: 0, ...value }),
    ),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      getRepository: jest.fn((entity: unknown) =>
        entity === Order
          ? {
              create: mocks.orderCreate,
              save: mocks.orderSave,
              update: jest.fn(),
            }
          : {},
      ),
    },
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    branchClient: { send: jest.fn(() => of({ data: null })) },
    lookup: {
      getHqBranchId: jest.fn().mockResolvedValue(HQ_ID),
      getBranchAssignmentByUserStrict: jest.fn().mockResolvedValue(null),
    },
    custody: {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'system'),
      auditActor: jest.fn(() => ({})),
    },
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    findById: jest.fn().mockResolvedValue({ id: '900' }),
  });
  const createdRow = (): Row => {
    expect(mocks.orderCreate).toHaveBeenCalledTimes(1);
    return mocks.orderCreate.mock.calls[0][0];
  };
  return { s, mocks, createdRow };
}

type CreateDto = Parameters<OrderLifecycleService['create']>[0];

/** Hamkor prepaid posilkasi: subtotal 200 000, cod 0. */
const PREPAID_DTO = {
  market_id: '501',
  customer_id: '801',
  total_price: 200000,
  to_be_paid: 0,
  paid_online_amount: 200000,
  source: Order_source.EXTERNAL,
  external_id: 'ord-9',
} as CreateDto;

describe('fix3b — create() paid_online_amount ni saqlaydi', () => {
  it('⭐ hamkor (tizim, superadmin roli): prepaid summa yoziladi', async () => {
    const h = makeCreateHarness();

    await h.s.create(PREPAID_DTO, PARTNER);

    expect(h.createdRow()).toMatchObject({
      total_price: 200000,
      paid_online_amount: 200000,
      source: Order_source.EXTERNAL,
    });
  });

  it('qisman prepaid (subtotal 200 000, cod 50 000) — 150 000', async () => {
    const h = makeCreateHarness();

    await h.s.create({ ...PREPAID_DTO, paid_online_amount: 150000 }, PARTNER);

    expect(h.createdRow().paid_online_amount).toBe(150000);
  });

  it('admin ham bera oladi; satrdagi son (tiyin bilan) qabul qilinadi', async () => {
    const h = makeCreateHarness();

    await h.s.create(
      {
        ...PREPAID_DTO,
        paid_online_amount: '120000.50' as unknown as number,
      },
      ADMIN,
    );

    expect(h.createdRow().paid_online_amount).toBe(120000.5);
  });

  it('so`rovchisiz ichki chaqiruv — saqlanadi', async () => {
    const h = makeCreateHarness();

    await h.s.create({ ...PREPAID_DTO, paid_online_amount: 80000 });

    expect(h.createdRow().paid_online_amount).toBe(80000);
  });

  it('berilmasa — 0 (oddiy COD, avvalgidek)', async () => {
    const h = makeCreateHarness();
    const { paid_online_amount: _omit, ...cod } = PREPAID_DTO;
    void _omit;

    await h.s.create(cod as CreateDto, PARTNER);

    expect(h.createdRow().paid_online_amount).toBe(0);
  });

  it.each([
    ['market', MARKET],
    ['filial xodimi (menejer)', MANAGER],
  ])(
    '⭐ %s yuborsa olib tashlanadi — 0 (kuryerni naqddan ozod qila olmaydi)',
    async (_label, requester) => {
      const h = makeCreateHarness();

      await h.s.create(PREPAID_DTO, requester);

      expect(h.createdRow().paid_online_amount).toBe(0);
    },
  );

  it('POST /orders/external (imtiyozsiz so`rovchi) ham olib tashlaydi', async () => {
    const h = makeCreateHarness();

    await h.s.createExternalOrder(
      PREPAID_DTO as Parameters<
        OrderLifecycleService['createExternalOrder']
      >[0],
      MARKET,
    );

    expect(h.createdRow().paid_online_amount).toBe(0);
  });

  it.each([
    ['manfiy', -1],
    ['summadan katta', 200000.01],
    ['son emas', 'abc'],
    ['NaN', Number.NaN],
  ])('⭐ %s qiymat — 400, buyurtma yaratilmaydi', async (_label, value) => {
    const h = makeCreateHarness();

    const error = await rpcError(
      h.s.create(
        { ...PREPAID_DTO, paid_online_amount: value as number },
        PARTNER,
      ),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('paid_online_amount');
    expect(h.mocks.orderCreate).not.toHaveBeenCalled();
  });

  it('chegaraviy: aynan total_price ga teng — ruxsat', async () => {
    const h = makeCreateHarness();

    await h.s.create({ ...PREPAID_DTO, paid_online_amount: 200000 }, PARTNER);

    expect(h.createdRow().paid_online_amount).toBe(200000);
  });
});

// ───────────────────────── sotuv: kuryer 0 naqd yig'adi ─────────────────────────

function makeSellHarness(order: Row) {
  const legs: Row[] = [];
  const settlements: Row[] = [];
  const updates: Row[] = [];
  const settlementRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: Row) => row),
    save: jest.fn((row: Row) => {
      settlements.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const tx = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity === OrderSettlement) return settlementRepo;
      if (entity === OrderItem) return {};
      return {};
    }),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: tx,
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '289' } })),
    },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
    lookup: {
      getMarketsByIds: jest.fn().mockResolvedValue([
        {
          id: '501',
          tariff_center: 30000,
          tariff_home: 45000,
          expense_proof_conditions: [],
        },
      ]),
      getCouriersByIds: jest
        .fn()
        .mockResolvedValue([
          { id: '289', tariff_center: 25000, tariff_home: 35000 },
        ]),
      getCashboxByUser: jest.fn((userId: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-${userId}`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue('22'),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
      getHqBranchId: jest.fn().mockResolvedValue(HQ_ID),
    },
    findById: jest.fn().mockResolvedValue(order),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    updateFull: jest.fn((_id: string, dto: Row) => {
      updates.push(dto);
      return Promise.resolve(order);
    }),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
    updateCashboxBalance: jest.fn((leg: Row) => {
      legs.push(leg);
      return Promise.resolve();
    }),
  });
  return { s, legs, settlements, updates };
}

describe('⭐ fix3b — prepaid posilka (cod 0): kuryer 0 naqd yig`adi', () => {
  it('yaratilgan qator → sotuv: kuryerga KIRIM yo`q, daftarda kuryer qarzi yo`q (kredit = ulush)', async () => {
    // 1) Hamkor posilkasi yaratiladi — prepaid summa SAQLANADI.
    const create = makeCreateHarness();
    await create.s.create(PREPAID_DTO, PARTNER);
    const created = create.createdRow();
    expect(created.paid_online_amount).toBe(200000);

    // 2) Kuryer posilkani yetkazib "Sotildi" bosadi.
    const order: Row = {
      ...created,
      id: '900',
      status: Order_status.WAITING,
      post_id: '9001',
      where_deliver: Where_deliver.CENTER,
      branch_id: '22',
      holder_branch_id: '22',
      holder_courier_id: '289',
      courier_id: '289',
      comment: null,
      sold_at: null,
    };
    const sale = makeSellHarness(order);
    await sale.s.sellOrder(COURIER, '900', {});

    const courierLegs = sale.legs.filter(
      (leg) => leg.cashbox_type === Cashbox_type.FOR_COURIER,
    );
    // Kuryer HECH QANDAY naqd yig'magan: kirim (qarz) yozilmaydi. Uning
    // ulushini (25 000) HQ to'laydi — kuryer kassasidan CHIQIM (kredit).
    expect(
      courierLegs.filter((leg) => leg.operation_type === Operation_type.INCOME),
    ).toEqual([]);
    expect(courierLegs.map((leg) => [leg.operation_type, leg.amount])).toEqual([
      [Operation_type.EXPENSE, 25000],
    ]);

    // Market oyog'i: naqd yo'q, yetkazish haqi (30 000) marketdan olinadi.
    expect(
      sale.legs
        .filter((leg) => leg.cashbox_type === Cashbox_type.FOR_MARKET)
        .map((leg) => [leg.operation_type, leg.amount]),
    ).toEqual([[Operation_type.EXPENSE, 30000]]);

    // Snapshot: yig'ilgan naqd 0.
    expect(sale.updates[0]).toMatchObject({ sale_collectible_amount: 0 });

    // Daftar: kuryer filialga 0 − 25 000 = −25 000 (kredit) "qarzdor".
    expect(sale.settlements).toHaveLength(1);
    expect(sale.settlements[0]).toMatchObject({
      courier_id: '289',
      courier_amount: -25000,
      market_amount: -30000,
      status: SettlementStatus.PENDING,
    });
  });

  it('taqqoslash: prepaid summa yozilmaganda (eski xato) kuryer 200 000 dan 175 000 qarzdor bo`lardi', async () => {
    const order: Row = {
      ...PREPAID_DTO,
      paid_online_amount: 0,
      id: '901',
      status: Order_status.WAITING,
      post_id: '9001',
      where_deliver: Where_deliver.CENTER,
      branch_id: '22',
      holder_branch_id: '22',
      holder_courier_id: '289',
      courier_id: '289',
      comment: null,
      sold_at: null,
    };
    const sale = makeSellHarness(order);
    await sale.s.sellOrder(COURIER, '901', {});

    expect(
      sale.legs
        .filter((leg) => leg.cashbox_type === Cashbox_type.FOR_COURIER)
        .map((leg) => [leg.operation_type, leg.amount]),
    ).toEqual([[Operation_type.INCOME, 175000]]);
  });
});
