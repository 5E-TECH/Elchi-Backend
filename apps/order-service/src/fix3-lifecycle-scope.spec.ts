/**
 * fix3 L2 — order-lifecycle xizmat qatlamidagi doira va suiiste'mol
 * qoidalari (CONTRACTS C6, C13). Gateway (A2) bilan AYNI qoidalar, himoya
 * chuqurligi uchun:
 *
 *   RBAC-05 / LC-07 / LC-14 — yaratishda hayot sikli / saqlash maydonlari
 *                             faqat SUPERADMIN/ADMIN dan; qolganlar DOIM NEW;
 *   RBAC-04 / CODE-01       — market faqat O'Z NEW buyurtmasini o'chiradi;
 *   CODE-03 / M11           — registrator faqat o'z filiali doirasida o'chiradi
 *                             va tahrirlaydi; PATCH status/market_id/to'lov
 *                             maydonlarini hech kimga o'zgartirtirmaydi;
 *   LC-04                   — menejer kuryer qo'lidagi buyurtmani sotmaydi;
 *   LC-05                   — kuryer topshirilgan bekor buyurtmani tiklamaydi;
 *   RBAC-05 (himoya)        — `sold_at` siz "sotilgan" buyurtma rollback
 *                             qilinmaydi (kassaga soxta teskari yozuv yo'q);
 *   M3                      — kutilayotgan tasdiq faqat AYNAN shu so'rov
 *                             bo'lsa qayta ishlatiladi, aks holda almashtiriladi;
 *   CODE-09                 — sotuv `return_requested` ni tozalaydi,
 *                             initiate-return filial doirasida.
 */
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Cashbox_type, Order_status, Where_deliver } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order, OrderHolderType, Order_source } from './entities/order.entity';
import { OrderSettlement } from './entities/order-settlement.entity';

type Row = Record<string, unknown>;
type Svc = OrderLifecycleService & Record<string, any>;
type RpcBody = { statusCode?: number; message?: string };

const HQ_ID = '1';

const MARKET = { id: '501', roles: ['market'] };
const OTHER_MARKET = { id: '502', roles: ['market'] };
const BOT = { id: '77', roles: ['market_operator'] };
const MANAGER = { id: '201', roles: ['manager'], branch_id: '77' };
const COURIER = { id: '289', roles: ['courier'], branch_id: '77' };
const REGISTRATOR = { id: '301', roles: ['registrator'] };
const ADMIN = { id: '2', roles: ['admin'] };
const SUPERADMIN = { id: '1', roles: ['superadmin'] };

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

// ───────────────────────── yaratish (create) ─────────────────────────

/** Buyurtma tanasidagi yaratish oqimi — faqat `orderRepo.create` ushlanadi. */
function makeCreateHarness() {
  const mocks = {
    orderCreate: jest.fn((value: Row) => value),
    orderSave: jest.fn((value: Row) =>
      Promise.resolve({ id: '900', product_quantity: 0, ...value }),
    ),
    branchSend: jest.fn(() => of({ data: null })),
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
    // Filial biriktirilmagan foydalanuvchi (market) — HQ ga tushadi.
    branchClient: { send: mocks.branchSend },
    lookup: { getHqBranchId: jest.fn().mockResolvedValue(HQ_ID) },
    custody: {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      createCustodyEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'market'),
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

const BASE = { market_id: '501', customer_id: '801', total_price: 150000 };

/** Audit stsenariysidagi "suiiste'mol" maydonlari (RBAC-05, LC-07). */
const ABUSE_FIELDS = {
  status: Order_status.SOLD,
  post_id: '9001',
  courier_id: '289',
  current_batch_id: '33',
  assigned_at: '2026-10-01T09:00:00+05:00',
  sold_at: '1759300000000',
  canceled_post_id: '9002',
  return_reason: 'eski qaytarish',
  home_branch_id: '22',
  parent_order_id: '700',
  to_be_paid: 100000,
  paid_amount: 100000,
  qr_code_token: 'boshqa-posilka-tokeni',
  operator_id: '5',
};

type CreateDto = Parameters<OrderLifecycleService['create']>[0];
type ExternalDto = Parameters<OrderLifecycleService['createExternalOrder']>[0];

describe('RBAC-05 / LC-07 / LC-14 — yaratishda hayot sikli maydonlari', () => {
  it('⭐ market: status/kuryer/pochta/partiya/to`lov maydonlari olib tashlanadi — buyurtma NEW, HQ`da, kuryersiz', async () => {
    const h = makeCreateHarness();

    await h.s.create(
      {
        ...BASE,
        ...ABUSE_FIELDS,
        branch_id: '22',
        source: Order_source.BRANCH,
      } as CreateDto,
      MARKET,
    );

    const row = h.createdRow();
    expect(row).toMatchObject({
      status: Order_status.NEW,
      post_id: null,
      courier_id: null,
      current_batch_id: null,
      assigned_at: null,
      sold_at: null,
      canceled_post_id: null,
      return_reason: null,
      parent_order_id: null,
      to_be_paid: 0,
      paid_amount: 0,
      operator_id: null,
      // Joylashuv: market o'zini filialga qo'ya olmaydi va HQ ro'yxatidan
      // `source:'branch'` bilan yashira olmaydi.
      branch_id: HQ_ID,
      home_branch_id: HQ_ID,
      source: Order_source.INTERNAL,
      holder_type: OrderHolderType.HQ,
      holder_courier_id: null,
    });
    expect(row.qr_code_token).not.toBe('boshqa-posilka-tokeni');
  });

  it('⭐ bot (market operatori): CREATED o`rniga NEW (LC-14), operator — operatorning o`zi', async () => {
    const h = makeCreateHarness();

    await h.s.create(
      {
        ...BASE,
        status: Order_status.CREATED,
        operator_id: '5',
      } as CreateDto,
      BOT,
    );

    expect(h.createdRow()).toMatchObject({
      status: Order_status.NEW,
      operator_id: '77',
      source: Order_source.INTERNAL,
      branch_id: HQ_ID,
    });
  });

  it('filial xodimi: gateway qo`ygan filial va source=`branch` qoladi, hayot sikli maydonlari ketadi', async () => {
    const h = makeCreateHarness();

    await h.s.create(
      {
        ...BASE,
        ...ABUSE_FIELDS,
        branch_id: '22',
        source: Order_source.BRANCH,
      } as CreateDto,
      MANAGER,
    );

    expect(h.createdRow()).toMatchObject({
      status: Order_status.NEW,
      branch_id: '22',
      home_branch_id: '22',
      source: Order_source.BRANCH,
      courier_id: null,
      post_id: null,
      holder_type: OrderHolderType.BRANCH,
      holder_branch_id: '22',
      holder_courier_id: null,
    });
  });

  it('filial xodimida source faqat `branch` bo`lishi mumkin — boshqasi tashlanadi', async () => {
    const h = makeCreateHarness();

    await h.s.create(
      { ...BASE, branch_id: '22', source: Order_source.EXTERNAL } as CreateDto,
      REGISTRATOR,
    );

    expect(h.createdRow()).toMatchObject({
      source: Order_source.INTERNAL,
      branch_id: '22',
    });
  });

  it.each([
    ['admin', ADMIN],
    ['superadmin', SUPERADMIN],
  ])(
    '%s: maydonlar avvalgidek qabul qilinadi (regressiya)',
    async (_label, requester) => {
      const h = makeCreateHarness();

      await h.s.create(
        {
          ...BASE,
          status: Order_status.RECEIVED,
          courier_id: '289',
          post_id: '9001',
          branch_id: '22',
        } as CreateDto,
        requester,
      );

      expect(h.createdRow()).toMatchObject({
        status: Order_status.RECEIVED,
        courier_id: '289',
        post_id: '9001',
        branch_id: '22',
        holder_type: OrderHolderType.COURIER,
        holder_courier_id: '289',
      });
    },
  );

  it('so`rovchisiz ichki chaqiruv (tashqi import) o`zgarmaydi', async () => {
    const h = makeCreateHarness();

    await h.s.create({
      ...BASE,
      status: Order_status.NEW,
      source: Order_source.EXTERNAL,
      external_id: 'ext-1',
    });

    expect(h.createdRow()).toMatchObject({
      status: Order_status.NEW,
      source: Order_source.EXTERNAL,
      external_id: 'ext-1',
    });
  });
});

describe('RBAC-05 / LC-07 — POST /orders/external (createExternalOrder)', () => {
  const abusive = {
    ...BASE,
    status: Order_status.RECEIVED,
    post_id: '9001',
    courier_id: '289',
    branch_id: '22',
    external_id: 'ext-7',
  } as unknown as ExternalDto;

  it('⭐ so`rovchi uzatilmasa ham (fail-closed) status NEW, pochta/kuryer/filial olib tashlanadi', async () => {
    const h = makeCreateHarness();

    await h.s.createExternalOrder(abusive);

    expect(h.createdRow()).toMatchObject({
      status: Order_status.NEW,
      post_id: null,
      courier_id: null,
      branch_id: HQ_ID,
      source: Order_source.EXTERNAL,
      external_id: 'ext-7',
      operator: 'external_manual',
      holder_type: OrderHolderType.HQ,
    });
  });

  it('market so`rovchi: xuddi shunday NEW', async () => {
    const h = makeCreateHarness();

    await h.s.createExternalOrder(abusive, MARKET);

    expect(h.createdRow()).toMatchObject({
      status: Order_status.NEW,
      post_id: null,
      courier_id: null,
    });
  });

  it('superadmin so`rovchi: status saqlanadi (regressiya)', async () => {
    const h = makeCreateHarness();

    await h.s.createExternalOrder(abusive, SUPERADMIN);

    expect(h.createdRow()).toMatchObject({
      status: Order_status.RECEIVED,
      post_id: '9001',
      source: Order_source.EXTERNAL,
    });
  });
});

// ───────────────────────── o'chirish (remove) ─────────────────────────

const NEW_HQ_ORDER: Row = {
  id: '700',
  status: Order_status.NEW,
  market_id: '501',
  branch_id: HQ_ID,
  home_branch_id: HQ_ID,
  holder_branch_id: null,
};

function makeRemoveHarness(
  order: Row,
  assignment: Row | null = { branch_id: '10' },
) {
  const mocks = {
    save: jest.fn((value: Row) => Promise.resolve(value)),
    transaction: jest.fn(),
    getBranchAssignmentByUser: jest.fn().mockResolvedValue(assignment),
  };
  const tx = { getRepository: jest.fn(() => ({ save: mocks.save })) };
  mocks.transaction.mockImplementation(
    (fn: (manager: unknown) => Promise<unknown>) => fn(tx),
  );
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    findById: jest.fn().mockResolvedValue({ ...order }),
    dataSource: { transaction: mocks.transaction },
    removeOrderFromSearch: jest.fn().mockResolvedValue(undefined),
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
    lookup: { getBranchAssignmentByUser: mocks.getBranchAssignmentByUser },
  });
  return { s, mocks };
}

describe('RBAC-04 / CODE-01 / CODE-03 — NEW buyurtmani o`chirish doirasi', () => {
  it('⭐ market boshqa marketning NEW buyurtmasini o`chira olmaydi — 403, hech narsa yozilmaydi', async () => {
    const h = makeRemoveHarness(NEW_HQ_ORDER);

    const error = await rpcError(h.s.remove('700', OTHER_MARKET));

    expect(error).toMatchObject({
      statusCode: 403,
      message: "Market faqat o'z buyurtmasini o'chira oladi",
    });
    expect(h.mocks.transaction).not.toHaveBeenCalled();
  });

  it('market o`z NEW buyurtmasini avvalgidek o`chiradi', async () => {
    const h = makeRemoveHarness(NEW_HQ_ORDER);

    await expect(h.s.remove('700', MARKET)).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(h.mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '700', isDeleted: true }),
    );
  });

  it('⭐ registrator boshqa filial buyurtmasini o`chira olmaydi — 403', async () => {
    const h = makeRemoveHarness(NEW_HQ_ORDER, { branch_id: '10' });

    const error = await rpcError(h.s.remove('700', REGISTRATOR));

    expect(error.statusCode).toBe(403);
    expect(error.message).toContain('filialingizga tegishli emas');
    expect(h.mocks.getBranchAssignmentByUser).toHaveBeenCalledWith('301');
    expect(h.mocks.transaction).not.toHaveBeenCalled();
  });

  it('HQ registratori HQ`dagi NEW buyurtmani o`chiradi', async () => {
    const h = makeRemoveHarness(NEW_HQ_ORDER, { branch_id: HQ_ID });

    await expect(h.s.remove('700', REGISTRATOR)).resolves.toMatchObject({
      statusCode: 200,
    });
  });

  it('filiali aniqlanmagan registrator — 403 (fail-closed)', async () => {
    const h = makeRemoveHarness(NEW_HQ_ORDER, null);

    const error = await rpcError(h.s.remove('700', REGISTRATOR));

    expect(error.statusCode).toBe(403);
    expect(h.mocks.transaction).not.toHaveBeenCalled();
  });

  it('superadmin cheklovsiz (filial so`ralmaydi)', async () => {
    const h = makeRemoveHarness(NEW_HQ_ORDER);

    await expect(h.s.remove('700', SUPERADMIN)).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(h.mocks.getBranchAssignmentByUser).not.toHaveBeenCalled();
  });
});

// ───────────────────────── PATCH (updateFromApi) ─────────────────────────

function makeUpdateHarness(assignment: Row | null = { branch_id: '10' }) {
  const mocks = {
    updateFull: jest.fn().mockResolvedValue({ id: '700' }),
    getBranchAssignmentByUser: jest.fn().mockResolvedValue(assignment),
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    updateFull: mocks.updateFull,
    findById: jest.fn().mockResolvedValue({
      id: '700',
      status: Order_status.WAITING,
      branch_id: '10',
      home_branch_id: HQ_ID,
      holder_branch_id: '10',
    }),
    lookup: { getBranchAssignmentByUser: mocks.getBranchAssignmentByUser },
  });
  return { s, mocks };
}

describe('M11 / CODE-03 — PATCH /orders/:id xizmat qatlamida', () => {
  it.each([
    ['status', { status: Order_status.SOLD }],
    ['market_id', { market_id: '502' }],
    ['to_be_paid', { to_be_paid: 0 }],
    ['paid_amount', { paid_amount: 150000 }],
    ['courier_id', { courier_id: '289' }],
    ['sold_at', { sold_at: '1759300000000' }],
    ['branch_cashbox_amount', { branch_cashbox_amount: 0 }],
  ])(
    '⭐ %s ni hech kim (superadmin ham) PATCH bilan o`zgartira olmaydi — 400',
    async (field, dto) => {
      const h = makeUpdateHarness();

      const error = await rpcError(h.s.updateFromApi('700', dto, SUPERADMIN));

      expect(error.statusCode).toBe(400);
      expect(error.message).toContain(field);
      expect(h.mocks.updateFull).not.toHaveBeenCalled();
    },
  );

  it('post_id/customer_id/qr_code_token/source — admin uchun 403, superadmin uchun o`tadi', async () => {
    const asAdmin = makeUpdateHarness();
    const error = await rpcError(
      asAdmin.s.updateFromApi('700', { post_id: '9001' }, ADMIN),
    );
    expect(error.statusCode).toBe(403);
    expect(asAdmin.mocks.updateFull).not.toHaveBeenCalled();

    const asSuperadmin = makeUpdateHarness();
    await asSuperadmin.s.updateFromApi('700', { post_id: '9001' }, SUPERADMIN);
    expect(asSuperadmin.mocks.updateFull).toHaveBeenCalledWith(
      '700',
      { post_id: '9001' },
      SUPERADMIN,
    );
  });

  it('⭐ registrator boshqa filial buyurtmasini tahrirlay olmaydi — 403', async () => {
    const h = makeUpdateHarness({ branch_id: '20' });

    const error = await rpcError(
      h.s.updateFromApi('700', { address: 'yangi manzil' }, REGISTRATOR),
    );

    expect(error.statusCode).toBe(403);
    expect(error.message).toContain('filialingizga tegishli emas');
    expect(h.mocks.updateFull).not.toHaveBeenCalled();
  });

  it('registrator o`z filiali buyurtmasining manzilini tahrirlaydi', async () => {
    const h = makeUpdateHarness({ branch_id: '10' });

    await h.s.updateFromApi('700', { address: 'yangi manzil' }, REGISTRATOR);

    expect(h.mocks.updateFull).toHaveBeenCalledWith(
      '700',
      { address: 'yangi manzil' },
      REGISTRATOR,
    );
  });

  // #2 — menejer endi o'z filialidagi buyurtmani tahrirlay oladi (registrator
  // bilan bir xil: rol darvozasidan o'tadi, filial doirasi yagona egalik
  // tekshiruvi). Kuryer/market esa avvalgidek PATCH qila olmaydi.
  it.each([
    ['kuryer', COURIER],
    ['market', MARKET],
  ])('%s PATCH qila olmaydi — 403', async (_label, requester) => {
    const h = makeUpdateHarness();

    const error = await rpcError(
      h.s.updateFromApi('700', { comment: 'x' }, requester),
    );

    expect(error.statusCode).toBe(403);
    expect(h.mocks.updateFull).not.toHaveBeenCalled();
  });

  it('menejer o`z filiali buyurtmasining manzilini tahrirlaydi (#2)', async () => {
    const h = makeUpdateHarness({ branch_id: '10' });

    await h.s.updateFromApi('700', { address: 'yangi manzil' }, MANAGER);

    expect(h.mocks.updateFull).toHaveBeenCalledWith(
      '700',
      { address: 'yangi manzil' },
      MANAGER,
    );
  });

  it('menejer boshqa filial buyurtmasini tahrirlay olmaydi — 403 (#2)', async () => {
    const h = makeUpdateHarness({ branch_id: '99' });

    const error = await rpcError(
      h.s.updateFromApi('700', { address: 'yangi manzil' }, MANAGER),
    );

    expect(error.statusCode).toBe(403);
    expect(error.message).toContain('filialingizga tegishli emas');
    expect(h.mocks.updateFull).not.toHaveBeenCalled();
  });

  /**
   * fix3b: `updateFromApi` endi FAQAT `order.update_from_api` (HTTP PATCH)
   * yo'li. Finance market to'lovi so'rovchisiz `order.update_normalized` →
   * to'g'ridan-to'g'ri `updateFull` orqali o'tadi (fix3b-order-update-routing
   * specida qulflangan), shuning uchun bu yerda so'rovchisiz chaqiruv —
   * fail-closed 403.
   */
  it('fix3b: so`rovchisiz chaqiruv — 403, updateFull chaqirilmaydi (fail-closed)', async () => {
    const h = makeUpdateHarness();
    const dto = { status: Order_status.PAID, paid_amount: 120000 };

    const error = await rpcError(h.s.updateFromApi('700', dto));

    expect(error.statusCode).toBe(403);
    expect(h.mocks.updateFull).not.toHaveBeenCalled();
    expect(h.mocks.getBranchAssignmentByUser).not.toHaveBeenCalled();
  });
});

// ───────────────────────── sotuv (LC-04, CODE-09) ─────────────────────────

/** Filialda turgan WAITING buyurtma (menejer sotuvi uchun to'g'ri holat). */
const BRANCH_HELD_WAITING: Row = {
  id: '7001',
  status: Order_status.WAITING,
  post_id: '9001',
  market_id: '501',
  customer_id: '801',
  total_price: 150000,
  paid_online_amount: 0,
  where_deliver: Where_deliver.CENTER,
  branch_id: '77',
  home_branch_id: '77',
  holder_type: OrderHolderType.BRANCH,
  holder_branch_id: '77',
  holder_courier_id: null,
  courier_id: null,
  return_requested: true,
  comment: null,
  sold_at: null,
};

const COURIER_HELD: Row = {
  holder_type: OrderHolderType.COURIER,
  holder_courier_id: '289',
  courier_id: '289',
};

function makeSellHarness(orderOver: Row = {}) {
  const order: Row = { ...BRANCH_HELD_WAITING, ...orderOver };
  const updates: Row[] = [];
  const settlementRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: Row) => row),
    save: jest.fn((row: Row) => Promise.resolve(row)),
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
        entity === OrderSettlement ? settlementRepo : {},
      ),
    },
  };
  const mocks = {
    createQueryRunner: jest.fn(() => queryRunner),
    getMarketsByIds: jest.fn().mockResolvedValue([
      {
        id: '501',
        tariff_center: 45000,
        tariff_home: 70000,
        expense_proof_conditions: [],
      },
    ]),
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
    dataSource: { createQueryRunner: mocks.createQueryRunner },
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '289' } })),
    },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
    orderItemRepo: { find: jest.fn().mockResolvedValue([]) },
    lookup: {
      getMarketsByIds: mocks.getMarketsByIds,
      getCouriersByIds: jest.fn().mockResolvedValue([
        {
          id: '289',
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
      getCashboxByUser: jest.fn((userId: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-${userId}`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue('77'),
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
    updateCashboxBalance: jest.fn().mockResolvedValue(undefined),
  });
  return { s, mocks, updates };
}

describe('LC-04 — menejer kuryer qo`lidagi buyurtmani sotmaydi', () => {
  it.each([
    ['holder COURIER + courier_id', COURIER_HELD],
    ['faqat holder_type COURIER', { holder_type: OrderHolderType.COURIER }],
    ['faqat courier_id', { courier_id: '289' }],
    ['faqat holder_courier_id', { holder_courier_id: '289' }],
  ])(
    '⭐ sellOrder (%s): 400, pul hisoblanmaydi, tranzaksiya ochilmaydi',
    async (_label, over) => {
      const h = makeSellHarness(over);

      const error = await rpcError(h.s.sellOrder(MANAGER, '7001', {}));

      expect(error.statusCode).toBe(400);
      expect(error.message).toContain("kuryer qo'lida");
      expect(h.mocks.getMarketsByIds).not.toHaveBeenCalled();
      expect(h.mocks.createQueryRunner).not.toHaveBeenCalled();
    },
  );

  it('⭐ partlySellOrder ham to`siladi', async () => {
    const h = makeSellHarness(COURIER_HELD);

    const error = await rpcError(
      h.s.partlySellOrder(MANAGER, '7001', {
        order_item_info: [{ product_id: '4', quantity: 1 }],
        totalPrice: 100000,
      }),
    );

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain("kuryer qo'lida");
    expect(h.mocks.getMarketsByIds).not.toHaveBeenCalled();
    expect(h.mocks.createQueryRunner).not.toHaveBeenCalled();
  });

  it('menejer filialda turgan buyurtmani avvalgidek sotadi (`0` — kuryer emas)', async () => {
    const h = makeSellHarness({ courier_id: '0' });

    await expect(h.s.sellOrder(MANAGER, '7001', {})).resolves.toMatchObject({
      statusCode: 200,
    });
  });

  it('⭐ menejer can_sell_cancel=false bo`lsa sotolmaydi — 403 (#4)', async () => {
    const h = makeSellHarness({ courier_id: '0' });
    (
      h.s as unknown as { lookup: { getUserById: jest.Mock } }
    ).lookup.getUserById.mockResolvedValue({
      id: '201',
      can_sell_cancel: false,
      tariff_center: 0,
      tariff_home: 0,
    });

    const error = await rpcError(h.s.sellOrder(MANAGER, '7001', {}));
    expect(error.statusCode).toBe(403);
  });

  it('kuryer o`z qo`lidagi buyurtmani avvalgidek sotadi', async () => {
    const h = makeSellHarness(COURIER_HELD);

    await expect(
      h.s.sellOrder(COURIER, '7001', { comment: 'Sotildi' }),
    ).resolves.toMatchObject({ statusCode: 200 });
  });
});

describe('CODE-09 — sotuv eski qaytarish so`rovi belgisini tozalaydi', () => {
  it('⭐ sellOrder: return_requested=false yoziladi', async () => {
    const h = makeSellHarness();

    await h.s.sellOrder(MANAGER, '7001', {});

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      status: Order_status.SOLD,
      return_requested: false,
    });
  });
});

// ───────────────────────── rollback (LC-05, RBAC-05) ─────────────────────────

/**
 * Rollback qo'riqchilari pul hisobidan OLDIN ishlaydi. "O'tdi" degan holatni
 * isbotlash uchun keyingi qadam (settlement qatorini o'qish) sentinel xato
 * bilan to'xtatiladi.
 */
function makeRollbackHarness(order: Row) {
  const mocks = {
    settlementFindOne: jest.fn().mockRejectedValue(new Error('DOWNSTREAM')),
    createQueryRunner: jest.fn(),
  };
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    findById: jest.fn().mockResolvedValue({ ...order }),
    logisticsClient: {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '289' } })),
    },
    orderSettlementRepo: { findOne: mocks.settlementFindOne },
    dataSource: { createQueryRunner: mocks.createQueryRunner },
  });
  return { s, mocks };
}

/** Kuryer bekor qilgan, eski yetkazish pochtasi (`post_id`) saqlanib qolgan. */
const CANCELLED_ORDER: Row = {
  id: '7001',
  status: Order_status.CANCELLED,
  post_id: '9001',
  market_id: '501',
  branch_id: '77',
  home_branch_id: HQ_ID,
  holder_branch_id: '77',
  sold_at: null,
};

describe('LC-05 — kuryer topshirilgan bekor buyurtmani tiklamaydi', () => {
  it.each([
    [
      'filial qabul qilgan (holder BRANCH)',
      {
        holder_type: OrderHolderType.BRANCH,
        holder_courier_id: null,
        courier_id: null,
      },
    ],
    [
      'HQ qabul qilgan (holder HQ)',
      {
        holder_type: OrderHolderType.HQ,
        holder_branch_id: null,
        holder_courier_id: null,
        courier_id: null,
        branch_id: HQ_ID,
      },
    ],
    [
      'boshqa kuryer qo`lida',
      {
        holder_type: OrderHolderType.COURIER,
        holder_courier_id: '300',
        courier_id: '300',
      },
    ],
    [
      'marketga qaytarilgan (holder MARKET)',
      {
        holder_type: OrderHolderType.MARKET,
        holder_branch_id: null,
        holder_courier_id: null,
      },
    ],
  ])('⭐ %s — 400, hech narsa o`qilmaydi/yozilmaydi', async (_label, over) => {
    const h = makeRollbackHarness({ ...CANCELLED_ORDER, ...over });

    const error = await rpcError(h.s.rollbackOrderToWaiting(COURIER, '7001'));

    expect(error.statusCode).toBe(400);
    expect(error.message).toContain('Topshirilgan bekor buyurtmani');
    expect(h.mocks.settlementFindOne).not.toHaveBeenCalled();
    expect(h.mocks.createQueryRunner).not.toHaveBeenCalled();
  });

  it('posilka hali kuryerning o`zida bo`lsa tiklash avvalgidek davom etadi', async () => {
    const h = makeRollbackHarness({ ...CANCELLED_ORDER, ...COURIER_HELD });

    await expect(h.s.rollbackOrderToWaiting(COURIER, '7001')).rejects.toThrow(
      'DOWNSTREAM',
    );
  });

  it('menejerning o`z filialidagi bekor buyurtmani qaytarishi o`zgarmaydi', async () => {
    const h = makeRollbackHarness({
      ...CANCELLED_ORDER,
      holder_type: OrderHolderType.BRANCH,
      holder_courier_id: null,
      courier_id: null,
    });

    await expect(h.s.rollbackOrderToWaiting(MANAGER, '7001')).rejects.toThrow(
      'DOWNSTREAM',
    );
  });
});

describe('RBAC-05 (himoya chuqurligi) — sotuv qaydisiz "sotilgan" buyurtma', () => {
  const forgedSold: Row = {
    ...CANCELLED_ORDER,
    ...COURIER_HELD,
    status: Order_status.SOLD,
    total_price: 1500000,
    sold_at: null,
  };

  it.each([
    ['kuryer', Order_status.SOLD, COURIER],
    ['menejer', Order_status.SOLD, MANAGER],
    ['superadmin', Order_status.SOLD, SUPERADMIN],
    ['superadmin', Order_status.PAID, SUPERADMIN],
    ['superadmin', Order_status.PARTLY_PAID, SUPERADMIN],
  ])(
    '⭐ %s, %s (sold_at yo`q) — 400, kassaga teskari yozuv yo`q',
    async (_label, status, requester) => {
      const h = makeRollbackHarness({ ...forgedSold, status });

      const error = await rpcError(
        h.s.rollbackOrderToWaiting(requester, '7001'),
      );

      expect(error.statusCode).toBe(400);
      expect(error.message).toContain('sotish amali orqali sotilmagan');
      expect(h.mocks.settlementFindOne).not.toHaveBeenCalled();
      expect(h.mocks.createQueryRunner).not.toHaveBeenCalled();
    },
  );

  it('haqiqiy sotuv (sold_at bor) — qo`riqchi o`tkazadi', async () => {
    const h = makeRollbackHarness({
      ...forgedSold,
      sold_at: '1759300000000',
    });

    await expect(h.s.rollbackOrderToWaiting(COURIER, '7001')).rejects.toThrow(
      'DOWNSTREAM',
    );
  });
});

// ───────────────────────── M3 — tasdiq so'rovlari ─────────────────────────

/**
 * `order-service.extra-cost-approval.spec.ts` dagi kabi haqiqiy servis
 * (konstruktor orqali) — sotuv/bekor tasdiq so'rovigacha boradi.
 */
function makeApprovalService(pendingApproval: Row | null) {
  const order = {
    id: '7001',
    status: Order_status.WAITING,
    post_id: '9001',
    market_id: '501',
    total_price: 250000,
    where_deliver: 'center',
    branch_id: '77',
    home_branch_id: '77',
    holder_branch_id: '77',
    comment: null,
  };
  const saved: Row[] = [];
  const extraCostApprovalRepo = {
    findOne: jest
      .fn()
      .mockResolvedValue(pendingApproval ? { ...pendingApproval } : null),
    create: jest.fn((entity: Row) => entity),
    save: jest.fn((entity: Row) => {
      saved.push({ ...entity });
      return Promise.resolve({
        id: entity.id ?? 'approval-new',
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        updatedAt: new Date('2026-10-01T10:00:00.000Z'),
        isDeleted: false,
        ...entity,
      });
    }),
  };
  const lookup = {
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
      branch_id: '77',
      can_add_extra_cost: true,
      can_sell_cancel: true,
      tariff_center: 0,
      tariff_home: 0,
    }),
    getCashboxByUser: jest.fn((_id: string, type: Cashbox_type) =>
      Promise.resolve({ id: `${type}-cashbox`, balance: 0 }),
    ),
    resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
    ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
    resolveBranchShare: jest.fn().mockResolvedValue(0),
    getBranchAssignmentByUser: jest.fn().mockResolvedValue({ branch_id: '77' }),
    getBranchUsers: jest.fn().mockResolvedValue([]),
    getHqBranchId: jest.fn().mockResolvedValue(HQ_ID),
  };
  const service = new OrderLifecycleService(
    {} as never,
    { findOne: jest.fn().mockResolvedValue(order) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    extraCostApprovalRepo as never,
    {} as never,
    {} as never,
    {
      send: jest.fn(() => of({ data: { id: '9001', courier_id: '301' } })),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    { send: jest.fn(() => of({ data: { exists: true } })) } as never,
    { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never,
    lookup as never,
    {} as never,
  );
  return { service, saved, save: extraCostApprovalRepo.save };
}

const APPROVAL_COURIER = { id: '301', roles: ['courier'], branch_id: '77' };
const APPROVAL_MANAGER = { id: '201', roles: ['manager'], branch_id: '77' };

const pending = (over: Row): Row => ({
  id: 'approval-1',
  order_id: '7001',
  market_id: '501',
  requested_by_user_id: '301',
  requested_by_role: 'courier',
  requester_branch_id: '77',
  proof_file_keys: [],
  status: 'pending',
  isDeleted: false,
  ...over,
});

type ApprovalResponse = {
  statusCode: number;
  data: { approval: { id: string; action: string; amount: number } };
};

describe('M3 — kutilayotgan tasdiq faqat AYNAN shu so`rov bo`lsa qaytariladi', () => {
  it('⭐ SOTISH kutilayotganda BEKOR yuborilsa — eski yopiladi, yangi BEKOR so`rovi ochiladi', async () => {
    const h = makeApprovalService(
      pending({
        action: 'sell',
        amount: 12000,
        operation_payload: { extraCost: 12000, comment: 'Yo`l xarajati' },
      }),
    );

    const res = (await h.service.cancelOrder(APPROVAL_COURIER, '7001', {
      extraCost: 15000,
      comment: 'Mijoz rad etdi',
    })) as ApprovalResponse;

    expect(res.statusCode).toBe(202);
    expect(res.data.approval).toMatchObject({
      action: 'cancel',
      amount: 15000,
    });
    expect(h.saved).toHaveLength(2);
    // 1) eski SOTISH so'rovi endi kutilmaydi — market uni tasdiqlay olmaydi.
    expect(h.saved[0]).toMatchObject({
      id: 'approval-1',
      action: 'sell',
      status: 'rejected',
      decided_by_user_id: '301',
    });
    expect(h.saved[0].decided_at).toBeInstanceOf(Date);
    expect(String(h.saved[0].decision_comment)).toContain('almashtirildi');
    // 2) yangi BEKOR so'rovi — o'z summasi bilan.
    expect(h.saved[1]).toMatchObject({
      action: 'cancel',
      amount: 15000,
      status: 'pending',
    });
  });

  it('⭐ teskarisi: BEKOR kutilayotganda SOTISH yuborilsa — yangi SOTISH so`rovi', async () => {
    const h = makeApprovalService(
      pending({
        action: 'cancel',
        amount: 15000,
        operation_payload: { extraCost: 15000 },
      }),
    );

    const res = (await h.service.sellOrder(APPROVAL_COURIER, '7001', {
      extraCost: 12000,
    })) as ApprovalResponse;

    expect(res.data.approval).toMatchObject({ action: 'sell', amount: 12000 });
    expect(h.saved.map((row) => [row.action, row.status])).toEqual([
      ['cancel', 'rejected'],
      ['sell', 'pending'],
    ]);
  });

  it('summa farq qilsa (12 000 → 8 000) — eski yopiladi, yangisi ochiladi', async () => {
    const h = makeApprovalService(
      pending({
        action: 'sell',
        amount: 12000,
        operation_payload: { extraCost: 12000 },
      }),
    );

    const res = (await h.service.sellOrder(APPROVAL_COURIER, '7001', {
      extraCost: 8000,
    })) as ApprovalResponse;

    expect(res.data.approval).toMatchObject({ action: 'sell', amount: 8000 });
    expect(h.saved.map((row) => row.status)).toEqual(['rejected', 'pending']);
  });

  it('aynan shu so`rov qayta yuborilsa (izoh boshqa) — eski so`rov qaytadi, yangisi ochilmaydi', async () => {
    const h = makeApprovalService(
      pending({
        action: 'sell',
        amount: 12000,
        operation_payload: { extraCost: 12000, comment: 'birinchi' },
      }),
    );

    const res = (await h.service.sellOrder(APPROVAL_COURIER, '7001', {
      extraCost: 12000,
      comment: 'ikkinchi',
    })) as ApprovalResponse;

    expect(res.statusCode).toBe(202);
    expect(res.data.approval.id).toBe('approval-1');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('qisman sotuvda yangi narx farq qilsa — yangi so`rov (eski narx bilan tasdiqlanmaydi)', async () => {
    const h = makeApprovalService(
      pending({
        requested_by_user_id: '201',
        requested_by_role: 'manager',
        action: 'partly_sell',
        amount: 9000,
        operation_payload: {
          extraCost: 9000,
          totalPrice: 180000,
          order_item_info: [{ product_id: 'p-1', quantity: 1 }],
        },
      }),
    );

    const res = (await h.service.partlySellOrder(APPROVAL_MANAGER, '7001', {
      extraCost: 9000,
      totalPrice: 150000,
      order_item_info: [{ product_id: 'p-1', quantity: 1 }],
    })) as ApprovalResponse;

    expect(res.data.approval.id).toBe('approval-new');
    expect(h.saved.map((row) => [row.action, row.status])).toEqual([
      ['partly_sell', 'rejected'],
      ['partly_sell', 'pending'],
    ]);
  });

  it('qisman sotuvda qatorlar tartibi boshqacha, lekin bir xil — eski so`rov qaytadi', async () => {
    const h = makeApprovalService(
      pending({
        requested_by_user_id: '201',
        requested_by_role: 'manager',
        action: 'partly_sell',
        amount: 9000,
        operation_payload: {
          extraCost: 9000,
          totalPrice: 180000,
          order_item_info: [
            { product_id: 'p-1', quantity: 1 },
            { product_id: 'p-2', quantity: 2 },
          ],
        },
      }),
    );

    const res = (await h.service.partlySellOrder(APPROVAL_MANAGER, '7001', {
      extraCost: 9000,
      totalPrice: 180000,
      order_item_info: [
        { product_id: 'p-2', quantity: 2 },
        { product_id: 'p-1', quantity: 1 },
      ],
    })) as ApprovalResponse;

    expect(res.data.approval.id).toBe('approval-1');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('almashtirilgan (yopilgan) so`rovni market tasdiqlay olmaydi — eski amal bajarilmaydi', async () => {
    const h = makeApprovalService(
      pending({
        action: 'sell',
        amount: 12000,
        status: 'rejected',
        operation_payload: { extraCost: 12000 },
      }),
    );
    const sellSpy = jest.spyOn(h.service, 'sellOrder');

    const error = await rpcError(
      h.service.approveExtraCostApproval(
        { id: '501', roles: ['market'] },
        'approval-1',
      ),
    );

    expect(error.statusCode).toBe(400);
    expect(sellSpy).not.toHaveBeenCalled();
  });
});

// ───────────────────────── CODE-09 — initiate-return ─────────────────────────

function makeReturnHarness(assignment: Row | null) {
  const mocks = {
    createQueryRunner: jest.fn(),
    save: jest.fn((value: Row) => Promise.resolve(value)),
    getBranchAssignmentByUser: jest.fn().mockResolvedValue(assignment),
  };
  const queryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: { getRepository: jest.fn(() => ({ save: mocks.save })) },
  };
  mocks.createQueryRunner.mockReturnValue(queryRunner);
  const s = Object.create(OrderLifecycleService.prototype) as Svc;
  Object.assign(s, {
    findById: jest.fn().mockResolvedValue({
      id: '101',
      status: Order_status.WAITING,
      branch_id: '10',
      home_branch_id: HQ_ID,
      holder_type: OrderHolderType.COURIER,
      holder_branch_id: '10',
      holder_courier_id: '289',
      return_requested: false,
    }),
    dataSource: { createQueryRunner: mocks.createQueryRunner },
    custody: {
      createTrackingEvent: jest.fn().mockResolvedValue(undefined),
      toTrackingRole: jest.fn(() => 'registrator'),
      auditActor: jest.fn(() => ({})),
    },
    syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    lookup: { getBranchAssignmentByUser: mocks.getBranchAssignmentByUser },
  });
  return { s, mocks };
}

const RETURN_DTO = { reason: 'Mijoz manzilda yo`q' };

describe('CODE-09 — initiate-return filial doirasida', () => {
  it('⭐ boshqa filial registratori qaytarishni boshlay olmaydi — 403, hech narsa yozilmaydi', async () => {
    const h = makeReturnHarness({ branch_id: '20' });

    const error = await rpcError(
      h.s.initiateReturn(REGISTRATOR, '101', RETURN_DTO),
    );

    expect(error.statusCode).toBe(403);
    expect(error.message).toContain('filialingizga tegishli emas');
    expect(h.mocks.createQueryRunner).not.toHaveBeenCalled();
  });

  it.each([
    ['o`z filiali (branch_id)', '10'],
    ['HQ (home_branch_id = HQ)', HQ_ID],
  ])('%s registratori boshlaydi', async (_label, branchId) => {
    const h = makeReturnHarness({ branch_id: branchId });

    await h.s.initiateReturn(REGISTRATOR, '101', RETURN_DTO);

    expect(h.mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ return_requested: true }),
    );
  });

  it('menejer — 403 (endpoint faqat SA/admin/registrator uchun)', async () => {
    const h = makeReturnHarness({ branch_id: '10' });

    const error = await rpcError(
      h.s.initiateReturn(MANAGER, '101', RETURN_DTO),
    );

    expect(error.statusCode).toBe(403);
    expect(h.mocks.getBranchAssignmentByUser).not.toHaveBeenCalled();
    expect(h.mocks.createQueryRunner).not.toHaveBeenCalled();
  });

  it('admin cheklovsiz (filial so`ralmaydi)', async () => {
    const h = makeReturnHarness(null);

    await h.s.initiateReturn(ADMIN, '101', RETURN_DTO);

    expect(h.mocks.getBranchAssignmentByUser).not.toHaveBeenCalled();
    expect(h.mocks.save).toHaveBeenCalled();
  });
});
