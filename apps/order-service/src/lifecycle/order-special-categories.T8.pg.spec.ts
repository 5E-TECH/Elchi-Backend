import { randomUUID } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import {
  ActivityLog,
  ActivityLogService,
  Order_status,
  OutboxEvent,
  OutboxService,
} from '@app/common';
import { OrderSpecialCategories1716000000187 } from '../../../../migrations/1716000000187-OrderSpecialCategories';
import { OrderCustodyService } from '../custody/order-custody.service';
import { Branch } from '../entities/branch.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { Order } from '../entities/order.entity';
import { ORDER_SCAN_LIGHT_SELECT } from '../lookup/order-scan-light.view';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * T8 (0OUcHZ7R) — maxsus belgilar, haqiqiy Postgres
 * (ORDER_T8_PG_TEST_URI bo'lmasa skip). Migratsiya `order_schema` ga yozadi,
 * shuning uchun spec o'z VAQTINCHALIK BAZASINI yaratadi va oxirida o'chiradi.
 *
 *  • 1716000000187 up (ikki marta — xatosiz), CHECK noma'lum kodni rad etadi,
 *    down ustun va CHECK'ni olib tashlaydi, qayta up — ishlaydi;
 *  • `setSpecialCategories` — FOR UPDATE, tracking + jurnal, `changed:false`,
 *    409 qulf, parallel ikki so'rov — ikkalasi ham yoziladi, ketma-ket;
 *  • skaner yengil `select`i ustunni o'qiydi.
 *
 * Lokal: ORDER_T8_PG_TEST_URI=postgres://postgres@127.0.0.1:5432/postgres
 */
const pgUri = process.env.ORDER_T8_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('T8 maxsus belgilar — haqiqiy Postgres', () => {
  const dbName = `spec_t8_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: OrderLifecycleService;
  const migration = new OrderSpecialCategories1716000000187();

  const runMigration = async (direction: 'up' | 'down') => {
    const runner = db.createQueryRunner();
    try {
      await migration[direction](runner);
    } finally {
      await runner.release();
    }
  };

  const columnExists = async () =>
    (
      await db.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'order_schema' AND table_name = 'orders'
            AND column_name = 'special_categories'`,
      )
    ).length === 1;

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri as string);
    url.pathname = `/${dbName}`;
    const bootstrap = new DataSource({ type: 'postgres', url: url.toString() });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA order_schema');
    await bootstrap.query('CREATE SCHEMA branch_schema');
    await bootstrap.destroy();
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'order_schema',
      entities: [
        Order,
        OrderItem,
        OrderTracking,
        OrderCustodyEvent,
        Branch,
        OutboxEvent,
        ActivityLog,
      ],
      synchronize: true,
    });
    await db.initialize();
    const custody = new OrderCustodyService(
      db.getRepository(OrderTracking),
      db.getRepository(OrderCustodyEvent),
    );
    service = new OrderLifecycleService(
      db,
      db.getRepository(Order),
      db.getRepository(OrderItem),
      db.getRepository(OrderTracking),
      db.getRepository(OrderCustodyEvent),
      {} as never, // OrderSettlement
      {} as never, // OrderExtraCostApproval
      {} as never, // BranchTransferBatchItem
      {} as never, // IDENTITY
      {} as never, // LOGISTICS
      {} as never, // FINANCE
      {} as never, // INTEGRATION
      {} as never, // BRANCH
      {} as never, // FILE
      new OutboxService(db.getRepository(OutboxEvent)),
      new ActivityLogService(db.getRepository(ActivityLog), 'order-service'),
      {} as never, // lookup
      custody,
    );
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  let seq = 0;
  const insertOrder = async (
    status: Order_status,
    special: string[] = [],
    marketId = '501',
  ) => {
    seq += 1;
    const saved = await db.getRepository(Order).save(
      db.getRepository(Order).create({
        market_id: marketId,
        customer_id: '801',
        status,
        qr_code_token: `t8-${seq}-${randomUUID()}`,
        special_categories: special,
      }),
    );
    return String(saved.id);
  };

  const rowOf = async (id: string) =>
    db.getRepository(Order).findOneByOrFail({ id });

  const trackingOf = (id: string) =>
    db.getRepository(OrderTracking).find({
      where: { order_id: id, action: 'special_categories_changed' },
      order: { created_at: 'ASC' },
    });

  const auditOf = (id: string) =>
    db.getRepository(ActivityLog).find({
      where: {
        entity_id: id,
        action: 'order.special_categories_changed',
      } as never,
    });

  it('migratsiya: up ikki marta xatosiz; CHECK noma`lum kodni rad etadi', async () => {
    await runMigration('up');
    await runMigration('up');
    expect(await columnExists()).toBe(true);

    const id = await insertOrder(Order_status.NEW);
    expect((await rowOf(id)).special_categories).toEqual([]);
    await expect(
      db.query(
        `UPDATE order_schema.orders SET special_categories = ARRAY['glass']::varchar[] WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/CHK_orders_special_categories/);
    await db.query(
      `UPDATE order_schema.orders SET special_categories = ARRAY['fragile','documents']::varchar[] WHERE id = $1`,
      [id],
    );
    expect((await rowOf(id)).special_categories).toEqual([
      'fragile',
      'documents',
    ]);
  });

  it('migratsiya: down ustun va CHECK`ni olib tashlaydi; qayta up — mavjud qatorlar `{}`', async () => {
    await runMigration('down');
    expect(await columnExists()).toBe(false);
    const constraints = await db.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'CHK_orders_special_categories'`,
    );
    expect(constraints).toHaveLength(0);
    await runMigration('down'); // qayta down ham xatosiz

    await runMigration('up');
    expect(await columnExists()).toBe(true);
    const rows = await db.query(
      `SELECT DISTINCT special_categories FROM order_schema.orders`,
    );
    expect(rows).toEqual([{ special_categories: [] }]);
  });

  it('⭐ market @ new: changed:true + tracking + jurnal; o`sha to`plam — changed:false', async () => {
    const id = await insertOrder(Order_status.NEW);
    const market = { id: '501', roles: ['market'], market_id: '501' };

    const first = await service.setSpecialCategories(
      id,
      ['liquid', 'fragile'],
      market,
    );
    expect(first.data).toEqual({
      id,
      special_categories: ['fragile', 'liquid'],
      changed: true,
    });
    expect((await rowOf(id)).special_categories).toEqual(['fragile', 'liquid']);
    const tracking = await trackingOf(id);
    expect(tracking).toHaveLength(1);
    expect(tracking[0]).toMatchObject({
      from_status: Order_status.NEW,
      to_status: Order_status.NEW,
      old_value: { special_categories: [] },
      new_value: { special_categories: ['fragile', 'liquid'] },
      changed_by: '501',
    });
    expect(await auditOf(id)).toHaveLength(1);

    const again = await service.setSpecialCategories(
      id,
      ['fragile', 'liquid'],
      market,
    );
    expect(again.data.changed).toBe(false);
    expect(await trackingOf(id)).toHaveLength(1);
    expect(await auditOf(id)).toHaveLength(1);
  });

  it('market @ received → 409; admin @ sold → 409, @ cancelled → 200', async () => {
    const lockedFor = async (
      status: Order_status,
      requester: Parameters<OrderLifecycleService['setSpecialCategories']>[2],
    ) => {
      const id = await insertOrder(status);
      const error = await service
        .setSpecialCategories(id, ['fragile'], requester)
        .catch((e: unknown) => e);
      return { id, error };
    };
    const market = { id: '501', roles: ['market'], market_id: '501' };
    const adminUser = { id: '2', roles: ['admin'] };

    for (const [status, requester] of [
      [Order_status.RECEIVED, market],
      [Order_status.SOLD, adminUser],
    ] as const) {
      const { id, error } = await lockedFor(status, requester);
      expect(error).toBeInstanceOf(RpcException);
      expect((error as RpcException).getError()).toMatchObject({
        statusCode: 409,
        code: 'SPECIAL_CATEGORIES_LOCKED',
      });
      expect((await rowOf(id)).special_categories).toEqual([]);
      expect(await trackingOf(id)).toHaveLength(0);
    }

    const cancelled = await insertOrder(Order_status.CANCELLED);
    const res = await service.setSpecialCategories(
      cancelled,
      ['battery'],
      adminUser,
    );
    expect(res.data.changed).toBe(true);
  });

  it('begona market → 403; o`chirilgan buyurtma → 404', async () => {
    const id = await insertOrder(Order_status.NEW, [], '777');
    const error = await service
      .setSpecialCategories(id, ['fragile'], {
        id: '501',
        roles: ['market'],
        market_id: '501',
      })
      .catch((e: unknown) => e);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 403,
    });

    await db.query(
      `UPDATE order_schema.orders SET is_deleted = true, deleted_at = now() WHERE id = $1`,
      [id],
    );
    const gone = await service
      .setSpecialCategories(id, ['fragile'], { id: '2', roles: ['admin'] })
      .catch((e: unknown) => e);
    expect((gone as RpcException).getError()).toMatchObject({
      statusCode: 404,
    });
  });

  it('parallel ikki so`rov — FOR UPDATE ketma-ket qiladi, tarix izchil', async () => {
    const id = await insertOrder(Order_status.NEW);
    const adminUser = { id: '2', roles: ['admin'] };
    await Promise.all([
      service.setSpecialCategories(id, ['fragile'], adminUser),
      service.setSpecialCategories(id, ['heavy'], adminUser),
    ]);
    const tracking = await trackingOf(id);
    const final = (await rowOf(id)).special_categories;
    // Har yozuvning `old_value` i oldingisining `new_value` i — yo'qolgan
    // yangilanish yo'q.
    expect(tracking.length).toBeGreaterThanOrEqual(1);
    expect(tracking[0].old_value).toEqual({ special_categories: [] });
    for (let i = 1; i < tracking.length; i += 1) {
      expect(tracking[i].old_value).toEqual(tracking[i - 1].new_value);
    }
    expect(tracking[tracking.length - 1].new_value).toEqual({
      special_categories: final,
    });
  });

  it('skaner yengil select ustunni o`qiydi', async () => {
    const id = await insertOrder(Order_status.ON_THE_ROAD, ['perishable']);
    const row = await db.getRepository(Order).findOne({
      where: { id },
      select: ORDER_SCAN_LIGHT_SELECT,
      relations: { items: true },
    });
    expect(row?.special_categories).toEqual(['perishable']);
  });
});
