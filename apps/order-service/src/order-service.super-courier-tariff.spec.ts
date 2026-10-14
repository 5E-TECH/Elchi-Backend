/**
 * hEjjuJaT — super-kuryerning viloyat tarifi sotuvda `orders.courier_tariff`
 * ga SNAPSHOT bo'ladi.
 *
 * Elchi modeli saqlandi: kuryer tarifi pochta jo'natishda emas, SOTUVDA
 * snapshot qilinadi (BeePost — jo'natishda). order-service kuryerni
 * buyurtma viloyati bilan so'raydi (`getCouriersByIds(ids, { region_id })`);
 * identity super-kuryer uchun courier_regions tarifini (yoki yassi
 * fallback'ni) qaytaradi — bu qism identity pg spec'ida.
 *
 * `sellOrder` HAQIQIY; faqat tashqi RPC/DB yo'llari stub (money-conservation
 * ledger spec'i uslubida).
 */
import { of } from 'rxjs';
import { Cashbox_type, Order_status, Where_deliver } from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { OrderSettlement } from './entities/order-settlement.entity';

type Row = Record<string, any>;

const MARKET = {
  id: '121',
  tariff_center: 45000,
  tariff_home: 70000,
  expense_proof_conditions: [],
};
const SUPER_COURIER_ID = '301';
const COURIER = { id: SUPER_COURIER_ID, roles: ['courier'], branch_id: null };

const order = (id: string, regionId: string, over: Row = {}): Row => ({
  id,
  status: Order_status.WAITING,
  post_id: `P-${SUPER_COURIER_ID}`,
  market_id: '121',
  region_id: regionId,
  total_price: 150000,
  paid_online_amount: 0,
  paid_amount: 0,
  where_deliver: Where_deliver.ADDRESS,
  branch_id: null,
  comment: null,
  ...over,
});

/**
 * identity'ning `findCouriersByIds(ids, regionId)` natijasi simulyatsiyasi:
 * viloyat qatori bo'lsa — uning tarifi ?? yassi; bo'lmasa — yassi.
 */
function makeIdentity() {
  const flat = { tariff_home: 50000, tariff_center: 30000 };
  const regionTariffs = new Map<
    string,
    { tariff_home: number | null; tariff_center: number | null }
  >();
  return {
    flat,
    regionTariffs,
    getCouriersByIds: jest.fn(
      (ids: string[], opts?: { region_id?: string | null }) => {
        const row = opts?.region_id
          ? regionTariffs.get(String(opts.region_id))
          : undefined;
        return Promise.resolve(
          ids.map((id) => ({
            id,
            can_add_extra_cost: true,
            can_sell_cancel: true,
            tariff_home: row?.tariff_home ?? flat.tariff_home,
            tariff_center: row?.tariff_center ?? flat.tariff_center,
          })),
        );
      },
    ),
  };
}

function makeService(orders: Row[], identity = makeIdentity()) {
  const db = new Map(orders.map((o) => [String(o.id), { ...o }]));
  const createQueryRunner = () => {
    const ops: Array<() => void> = [];
    const settlementRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: Row) => ({ ...row })),
      save: jest.fn((row: Row) => Promise.resolve({ id: 'S1', ...row })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === OrderSettlement ? settlementRepo : { update: jest.fn() },
      ),
      __ops: ops,
    };
    return {
      manager,
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(() => {
        ops.splice(0).forEach((apply) => apply());
        return Promise.resolve();
      }),
      rollbackTransaction: jest.fn(() => {
        ops.splice(0);
        return Promise.resolve();
      }),
      release: jest.fn(),
    };
  };

  const s = Object.create(OrderLifecycleService.prototype) as Row;
  Object.assign(s, {
    dataSource: { createQueryRunner: jest.fn(createQueryRunner) },
    logisticsClient: {
      send: jest.fn((_p: unknown, payload: { id: string }) =>
        of({ data: { id: payload.id, courier_id: SUPER_COURIER_ID } }),
      ),
    },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    custody: { auditActor: jest.fn(() => ({})) },
    lookup: {
      getMarketsByIds: jest.fn((ids: string[]) =>
        Promise.resolve(ids.map(() => MARKET)),
      ),
      getCouriersByIds: identity.getCouriersByIds,
      getUserById: jest.fn().mockResolvedValue(null),
      getCashboxByUser: jest.fn((id: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-${id}`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue(null),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
    },
    findById: jest.fn((id: string) =>
      Promise.resolve({ ...db.get(String(id)) }),
    ),
    updateFull: jest.fn(
      (id: string, patch: Row, _actor: unknown, manager?: Row) => {
        const apply = () => Object.assign(db.get(String(id)) ?? {}, patch);
        if (manager?.__ops) manager.__ops.push(apply);
        else apply();
        return Promise.resolve(undefined);
      },
    ),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
  });
  return { s, db, identity };
}

describe('hEjjuJaT — super-kuryer viloyat tarifi sotuvda snapshot', () => {
  it('kuryer buyurtma viloyati bilan so‘raladi (getCouriersByIds(ids, { region_id }))', async () => {
    const { s, identity } = makeService([order('9001', '5')]);
    await s.sellOrder(COURIER, '9001', {});
    expect(identity.getCouriersByIds).toHaveBeenCalledWith([SUPER_COURIER_ID], {
      region_id: '5',
    });
  });

  it('TC2: A viloyati uchun tariff_home=15000 → A dagi buyurtmada courier_tariff=15000', async () => {
    const identity = makeIdentity();
    identity.regionTariffs.set('5', {
      tariff_home: 15000,
      tariff_center: null,
    });
    const { s, db } = makeService([order('9001', '5')], identity);

    await s.sellOrder(COURIER, '9001', {});

    expect(db.get('9001')).toMatchObject({
      status: Order_status.SOLD,
      courier_tariff: 15000,
      courier_share: 15000,
    });
  });

  it('TC3: B viloyati tarifi NULL → kuryerning umumiy tariff_home (50000)', async () => {
    const identity = makeIdentity();
    identity.regionTariffs.set('6', { tariff_home: null, tariff_center: null });
    const { s, db } = makeService([order('9002', '6')], identity);

    await s.sellOrder(COURIER, '9002', {});

    expect(db.get('9002')).toMatchObject({ courier_tariff: 50000 });
  });

  it('TC5: tarif keyin o‘zgarsa eski buyurtmaning courier_tariff i o‘zgarmaydi', async () => {
    const identity = makeIdentity();
    identity.regionTariffs.set('5', {
      tariff_home: 15000,
      tariff_center: null,
    });
    const { s, db } = makeService(
      [order('9001', '5'), order('9003', '5')],
      identity,
    );

    await s.sellOrder(COURIER, '9001', {});
    // Admin A viloyati tarifini o'zgartirdi.
    identity.regionTariffs.set('5', {
      tariff_home: 20000,
      tariff_center: null,
    });
    await s.sellOrder(COURIER, '9003', {});

    expect(db.get('9001')?.courier_tariff).toBe(15000);
    expect(db.get('9003')?.courier_tariff).toBe(20000);
  });

  it('buyurtmada snapshot/override bo‘lsa viloyat tarifi uni bosmaydi', async () => {
    const identity = makeIdentity();
    identity.regionTariffs.set('5', {
      tariff_home: 15000,
      tariff_center: null,
    });
    const { s, db } = makeService(
      [order('9004', '5', { courier_tariff: 11000 })],
      identity,
    );

    await s.sellOrder(COURIER, '9004', {});

    expect(db.get('9004')?.courier_tariff).toBe(11000);
  });
});
