/**
 * QO'SHIMCHA XARAJAT IKKALA DAFTARGA HAM TUSHADI (kassa + order_settlement).
 *
 * ⚠️ NEGA. Qo'shimcha xarajat kuryer (yoki filial) kassasidan EXPENSE qilib
 * yechiladi, ya'ni kuryer topshiradigan naqd shuncha KAM bo'ladi. Ilgari
 * `order_settlement` bunga umuman tegmasdi: bekor qilingan buyurtmada qator
 * ochilmasdi, sotuvda esa faqat `market_amount` ayirilardi. Natijada FIFO
 * kassadagidan KO'P pul talab qilardi.
 *
 * Jonli E2E (BeePost↔Elchi, Andijon): kuryer kassasi +30 000 +110 000 +70 000
 * = 210 000, keyin bekor qilingan buyurtmadan −5 000 → qoldiq 205 000. Ledger
 * 210 000 talab qildi, uchinchi buyurtmaga AYNAN 5 000 so'm yetmadi va u
 * abadiy PENDING bo'lib qotib qoldi. FIFO tomoni
 * `order-service.settlement.spec.ts` da sinaladi; bu yerda daftarga YOZILADIGAN
 * summalar tekshiriladi.
 */
import { of } from 'rxjs';
import {
  Cashbox_type,
  Order_status,
  SettlementStatus,
  Where_deliver,
} from '@app/common';
import { OrderLifecycleService } from './lifecycle/order-lifecycle.service';
import { Order } from './entities/order.entity';
import { OrderSettlement } from './entities/order-settlement.entity';

type SettlementRow = Record<string, unknown>;

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

/**
 * Faqat pul mantig'i kerak — RMQ/TypeORM qatlami eng kichik ko'rinishda
 * taqlid qilinadi (`order-service.online-payment.spec.ts` bilan bir uslub).
 * `recordSaleSettlement` ATAYLAB haqiqiy qoladi: tekshiriladigan narsa aynan
 * uning yozgan qatori.
 */
function makeService(opts: { isManager?: boolean } = {}) {
  const saved: SettlementRow[] = [];
  const cashboxLegs: Record<string, unknown>[] = [];

  const settlementRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: SettlementRow) => row),
    save: jest.fn((row: SettlementRow) => {
      saved.push(row);
      return Promise.resolve(row);
    }),
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
        },
      ]),
      getUserById: jest.fn().mockResolvedValue({
        id: '201',
        branch_id: '77',
        can_add_extra_cost: true,
        tariff_center: 0,
        tariff_home: 0,
      }),
      getCashboxByUser: jest.fn((_id: string, type: Cashbox_type) =>
        Promise.resolve({ id: `${type}-cashbox`, balance: 0 }),
      ),
      ensureBranchCashbox: jest.fn().mockResolvedValue(undefined),
      resolveSettlementBranchId: jest.fn().mockResolvedValue('77'),
      resolveBranchShare: jest.fn().mockResolvedValue(0),
    },
    // Stublar: tekshirilayotgan mantiqdan tashqaridagi yo'llar.
    findById: jest.fn().mockResolvedValue(ORDER),
    enforceOperationProof: jest.fn().mockResolvedValue([]),
    requestExtraCostApprovalIfNeeded: jest.fn().mockResolvedValue(null),
    lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
    updateFull: jest.fn().mockResolvedValue(undefined),
    queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
    updateCashboxBalance: jest.fn((leg: Record<string, unknown>) => {
      cashboxLegs.push(leg);
      return Promise.resolve(undefined);
    }),
  });

  const requester = opts.isManager
    ? { id: '201', roles: ['manager'], branch_id: '77' }
    : { id: '301', roles: ['courier'], branch_id: '77' };

  return { s, requester, saved, cashboxLegs };
}

const row = (saved: SettlementRow[]): SettlementRow => {
  expect(saved).toHaveLength(1);
  return saved[0];
};

describe("sotuvda qo'shimcha xarajat daftardan ham ayiriladi", () => {
  it('⭐ kuryer to`lasa kuryer VA filial oyoqlari ham kamayadi', async () => {
    const { s, requester, saved, cashboxLegs } = makeService();

    await s.sellOrder(requester, '7001', {
      extraCost: 5000,
      extraCostApproved: true,
      comment: 'Yo`l xarajati',
    });

    // Kassa: kuryerdan 5 000 EXPENSE yozilgan — daftar ham shuni ko'rsin.
    expect(
      cashboxLegs.some(
        (leg) =>
          leg.cashbox_type === Cashbox_type.FOR_COURIER &&
          leg.source_type === 'extra_cost' &&
          leg.amount === 5000,
      ),
    ).toBe(true);

    const settlement = row(saved);
    // collectible 250 000, kuryer ulushi 30 000, xarajat 5 000.
    expect(settlement.courier_amount).toBe(215000);
    // branchNet 220 000 − 5 000: filial ham shuncha kam naqd ko'taradi.
    expect(settlement.branch_amount).toBe(215000);
    // market_amount ilgari ham ayirardi (audit M8) — o'zgarmadi.
    expect(settlement.market_amount).toBe(200000);
  });

  it('xarajat bo`lmasa summalar o`zgarmaydi (regressiya qo`riqchisi)', async () => {
    const { s, requester, saved } = makeService();

    await s.sellOrder(requester, '7001', { comment: 'Sotildi' });

    const settlement = row(saved);
    expect(settlement.courier_amount).toBe(220000);
    expect(settlement.branch_amount).toBe(220000);
    expect(settlement.market_amount).toBe(205000);
  });

  it('manager to`lasa kuryer oyog`i tegilmaydi, faqat filial oyog`i kamayadi', async () => {
    const { s, requester, saved } = makeService({ isManager: true });

    await s.sellOrder(requester, '7001', {
      extraCost: 5000,
      extraCostApproved: true,
    });

    const settlement = row(saved);
    // Manager sotuvida kuryer umuman yo'q — uning oyog'i tarifsiz qoladi.
    expect(settlement.courier_amount).toBe(250000);
    expect(settlement.branch_amount).toBe(245000);
    expect(settlement.market_amount).toBe(200000);
  });
});

describe("bekor qilingan buyurtmaning qo'shimcha xarajati", () => {
  it('⭐ daftarga KREDIT qatori sifatida tushadi', async () => {
    const { s, requester, saved, cashboxLegs } = makeService();

    await s.cancelOrder(requester, '7001', {
      extraCost: 5000,
      extraCostApproved: true,
      comment: 'Mijoz olmadi',
    });

    // Kassadan 5 000 yechildi...
    expect(
      cashboxLegs.some(
        (leg) =>
          leg.cashbox_type === Cashbox_type.FOR_COURIER &&
          leg.source_type === 'extra_cost' &&
          leg.amount === 5000,
      ),
    ).toBe(true);

    // ...demak daftarda ham shuncha kredit turishi SHART: aks holda FIFO
    // kassadagidan 5 000 ko'p talab qilib buyurtmani qotirib qo'yardi.
    const settlement = row(saved);
    expect(settlement.order_id).toBe('7001');
    expect(settlement.courier_id).toBe('301');
    expect(settlement.branch_id).toBe('77');
    expect(settlement.courier_amount).toBe(-5000);
    expect(settlement.branch_amount).toBe(-5000);
    expect(settlement.market_amount).toBe(-5000);
    // Kredit hozircha kuryerda — u topshirganda zanjir bo'ylab ko'tariladi.
    expect(settlement.status).toBe(SettlementStatus.PENDING);
  });

  it('xarajatsiz bekor qilishda daftarga hech narsa yozilmaydi', async () => {
    const { s, requester, saved } = makeService();

    await s.cancelOrder(requester, '7001', { comment: 'Mijoz olmadi' });

    expect(saved).toHaveLength(0);
  });

  it('manager to`lasa kredit filial bo`g`inida boshlanadi', async () => {
    const { s, requester, saved } = makeService({ isManager: true });

    await s.cancelOrder(requester, '7001', {
      extraCost: 5000,
      extraCostApproved: true,
    });

    const settlement = row(saved);
    expect(settlement.courier_id).toBeNull();
    expect(settlement.courier_amount).toBe(0);
    expect(settlement.branch_amount).toBe(-5000);
    // Kuryer bo'g'ini yo'q — naqd allaqachon filialda.
    expect(settlement.status).toBe(SettlementStatus.COURIER_SETTLED);
  });
});
