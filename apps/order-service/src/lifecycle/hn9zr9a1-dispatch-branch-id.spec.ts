/**
 * hn9zr9A1 — dispatch / receivePost'da `order.branch_id` filialga o'tadi.
 *
 * MUAMMO (jonli E2E, buyurtma #31). Dispatch (`branch.post.dispatch`) va
 * filial qabuli (`logistics receivePost`) `order.update` ga
 * `branch_id: '15'` yuborardi. `holder_branch_id` 15 ga o'tardi, `branch_id`
 * esa HQ (1) da qolardi. Sabab: `findById` buyurtmani `branch` relatsiyasi
 * bilan yuklaydi; `branch_id` — shu relatsiyaning JoinColumn'i, va TypeORM
 * `save()` da ustun qiymatini relatsiya OBYEKTIDAN oladi
 * (`ColumnMetadata.getEntityValue`). Endi `branch_id` o'zgarganda eski
 * relatsiya olib tashlanadi.
 *
 * Bu spec bazasiz: saqlanayotgan entity'dan TypeORM'ning O'ZI qaysi
 * `branch_id` ni yozishini haqiqiy entity metadata'si bilan o'qiydi. Haqiqiy
 * Postgres bilan — `dispatch-branch-id.pg.spec.ts`.
 */
import { DataSource } from 'typeorm';
import { Order_status } from '@app/common';
import { Order, OrderHolderType } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { OrderLifecycleService } from './order-lifecycle.service';

const HQ_ID = '1';
const DEST_ID = '15';

describe('hn9zr9A1 — dispatch/receivePost: order.branch_id filialga yoziladi', () => {
  let metadataSource: DataSource;

  beforeAll(async () => {
    // Faqat metadata (ulanishsiz) — TypeORM save qaysi qiymatni yozishini
    // aynan o'zining ColumnMetadata'si bilan hisoblash uchun.
    metadataSource = new DataSource({
      type: 'postgres',
      entities: [Order, OrderItem, OrderTracking, OrderCustodyEvent, Branch],
    });
    await (
      metadataSource as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();
  });

  /** TypeORM UPDATE'da `branch_id` ustuniga yozadigan qiymat. */
  const persistedBranchId = (entity: unknown): unknown =>
    metadataSource
      .getMetadata(Order)
      .findColumnWithPropertyName('branch_id')!
      .getEntityValue(entity as Order);

  const storedOrder = (over: Record<string, unknown> = {}) => {
    const order = Object.assign(new Order(), {
      id: '31',
      market_id: '500',
      customer_id: '77',
      status: Order_status.RECEIVED,
      total_price: 100000,
      paid_online_amount: 0,
      branch_id: HQ_ID,
      home_branch_id: HQ_ID,
      holder_type: OrderHolderType.HQ,
      holder_branch_id: null,
      holder_courier_id: null,
      courier_id: null,
      post_id: '48',
      region_id: '13',
      items: [],
      ...over,
    });
    // findById: relations { items: true, branch: true } — HQ yuklangan.
    order.branch = Object.assign(new Branch(), { id: HQ_ID, name: 'HQ' });
    return order;
  };

  function makeSvc(stored: Order) {
    const saved: Order[] = [];
    const orderRepoInTx = {
      save: jest.fn((entity: Order) => {
        // save chaqirilgan PAYTDAGI holat (keyin obyekt o'zgarishi mumkin).
        saved.push(
          Object.assign(Object.create(Order.prototype) as Order, entity),
        );
        return Promise.resolve(entity);
      }),
    };
    const manager = {
      getRepository: jest.fn((target: unknown) =>
        target === Order ? orderRepoInTx : {},
      ),
    };
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager,
    };
    const s = Object.create(OrderLifecycleService.prototype) as Record<
      string,
      any
    >;
    Object.assign(s, {
      findById: jest.fn().mockResolvedValue(stored),
      dataSource: { createQueryRunner: jest.fn(() => queryRunner) },
      lookup: { getHqBranchId: jest.fn().mockResolvedValue(HQ_ID) },
      custody: {
        createTrackingEvent: jest.fn().mockResolvedValue(undefined),
        createCustodyEvent: jest.fn().mockResolvedValue(undefined),
        toTrackingRole: jest.fn(() => 'registrator'),
        auditActor: jest.fn(() => ({})),
      },
      syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
      enqueueFinanceOnStatusChange: jest.fn().mockResolvedValue(undefined),
      queueExternalStatusSync: jest.fn().mockResolvedValue(undefined),
      activityLog: { log: jest.fn().mockResolvedValue(undefined) },
    });
    return { svc: s as unknown as OrderLifecycleService, saved, s };
  }

  const REQUESTER = { id: '301', roles: ['registrator'], note: 'dispatch' };

  // branch-service dispatchPostToBranch yuboradigan AYNAN shu dto.
  const DISPATCH_DTO = {
    branch_id: DEST_ID,
    holder_type: 'BRANCH',
    holder_branch_id: DEST_ID,
    holder_courier_id: null,
    post_id: '777',
    current_batch_id: null,
    status: Order_status.ON_THE_ROAD,
  };

  it('⭐ TC2: dispatch dto — saqlanayotgan entity branch_id=15 yozadi (HQ emas)', async () => {
    const h = makeSvc(storedOrder());

    await h.svc.updateFull('31', DISPATCH_DTO as never, REQUESTER);

    expect(h.saved).toHaveLength(1);
    const entity = h.saved[0];
    expect(entity.branch_id).toBe(DEST_ID);
    // Eski HQ relatsiyasi yo'q — TypeORM ustun qiymatini yozadi.
    expect(entity).not.toHaveProperty('branch');
    expect(persistedBranchId(entity)).toBe(DEST_ID);
  });

  it('⭐ TC3 (pul oqimi): holder_* avvalgidek manzil filialga — settlement o`qiydigan maydon o`zgarmagan', async () => {
    const h = makeSvc(storedOrder());

    await h.svc.updateFull('31', DISPATCH_DTO as never, REQUESTER);

    const entity = h.saved[0];
    expect(entity.holder_type).toBe(OrderHolderType.BRANCH);
    expect(entity.holder_branch_id).toBe(DEST_ID);
    expect(entity.holder_courier_id).toBeNull();
    // Uy filiali (home) HQ'da qoladi — HQ ro'yxatida tarix ko'rinadi.
    expect(entity.home_branch_id).toBe(HQ_ID);
  });

  it('⭐ receivePost: faqat { branch_id } — branch_id=15 yoziladi', async () => {
    const h = makeSvc(
      storedOrder({
        status: Order_status.ON_THE_ROAD,
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: DEST_ID,
      }),
    );

    await h.svc.updateFull('31', { branch_id: DEST_ID }, REQUESTER);

    expect(persistedBranchId(h.saved[0])).toBe(DEST_ID);
  });

  it('regressiya: branch_id yuborilmasa relatsiya joyida, branch_id o`zgarmaydi', async () => {
    const h = makeSvc(storedOrder());

    await h.svc.updateFull('31', { comment: 'izoh' }, REQUESTER);

    const entity = h.saved[0];
    expect(entity.branch).toEqual(
      expect.objectContaining({ id: HQ_ID, name: 'HQ' }),
    );
    expect(persistedBranchId(entity)).toBe(HQ_ID);
  });

  it('regressiya: branch_id=null (filialdan chiqarish) — null yoziladi', async () => {
    const h = makeSvc(storedOrder());

    await h.svc.updateFull('31', { branch_id: null }, REQUESTER);

    expect(persistedBranchId(h.saved[0])).toBeNull();
  });

  it('TypeORM xulqi (sabab): eski relatsiya qolsa ustun qiymati e`tiborsiz qoladi', () => {
    const stale = storedOrder();
    stale.branch_id = DEST_ID;

    // Aynan shu sabab #31 HQ'da qolgan edi.
    expect(persistedBranchId(stale)).toBe(HQ_ID);
  });
});
