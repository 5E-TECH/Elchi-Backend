import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Branch } from '../entities/branch.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { Order } from '../entities/order.entity';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * 2026-11-20 — `order.operator.sold_orders`: komissiya «o'tgan sotuvlarga
 * hisoblash» uchun shu marketda shu operatorning HOZIR sotilgan buyurtmalari
 * (haqiqiy Postgres). Boshqa operator / market / holat / o'chirilgani kirmaydi.
 * Env bo'lmasa skip (CI'da `ORDER_MARKET_STAT_PG_TEST_URI` bor).
 */
const pgUri = process.env.ORDER_MARKET_STAT_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('getOperatorSoldOrders (Postgres)', () => {
  const dbName = `spec_opsold_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let analytics: OrderAnalyticsService;
  const MARKET = '10';
  const OTHER_MARKET = '11';
  const OPERATOR = '501';
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri as string);
    url.pathname = `/${dbName}`;
    const bootstrap = new DataSource({ type: 'postgres', url: url.toString() });
    await bootstrap.initialize();
    for (const schema of ['order_schema', 'branch_schema']) {
      await bootstrap.query(`CREATE SCHEMA "${schema}"`);
    }
    await bootstrap.destroy();
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'order_schema',
      entities: [Order, OrderItem, OrderTracking, OrderCustodyEvent, Branch],
      synchronize: true,
    });
    await db.initialize();
    analytics = new OrderAnalyticsService(
      db.getRepository(Order),
      db.getRepository(OrderTracking),
      db.getRepository(OrderCustodyEvent),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const rows: Array<{
      tag: string;
      market: string;
      operator: string | null;
      status: string;
      price: number;
      deleted?: boolean;
    }> = [
      {
        tag: 'sold',
        market: MARKET,
        operator: OPERATOR,
        status: 'sold',
        price: 200000,
      },
      {
        tag: 'paid',
        market: MARKET,
        operator: OPERATOR,
        status: 'paid',
        price: 150000,
      },
      {
        tag: 'partly',
        market: MARKET,
        operator: OPERATOR,
        status: 'partly_paid',
        price: 90000,
      },
      {
        tag: 'new',
        market: MARKET,
        operator: OPERATOR,
        status: 'new',
        price: 50000,
      },
      {
        tag: 'cancel',
        market: MARKET,
        operator: OPERATOR,
        status: 'cancelled',
        price: 50000,
      },
      {
        tag: 'other-op',
        market: MARKET,
        operator: '502',
        status: 'sold',
        price: 70000,
      },
      {
        tag: 'no-op',
        market: MARKET,
        operator: null,
        status: 'sold',
        price: 70000,
      },
      {
        tag: 'other-mk',
        market: OTHER_MARKET,
        operator: OPERATOR,
        status: 'sold',
        price: 70000,
      },
      {
        tag: 'deleted',
        market: MARKET,
        operator: OPERATOR,
        status: 'sold',
        price: 70000,
        deleted: true,
      },
    ];
    for (const row of rows) {
      const [inserted] = await db.query<Array<{ id: string }>>(
        `INSERT INTO order_schema.orders
           (market_id, customer_id, status, operator_id, total_price, is_deleted)
         VALUES ($1, 2, $2, $3, $4, $5) RETURNING id`,
        [row.market, row.status, row.operator, row.price, row.deleted === true],
      );
      ids[row.tag] = String(inserted.id);
    }
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.destroy();
    }
  });

  it('⭐ faqat shu market, shu operator, hozir sotilgan (sold / paid / partly_paid), tirik — id o`sish tartibida', async () => {
    const res = await analytics.getOperatorSoldOrders(MARKET, OPERATOR);
    expect(res).toEqual({
      items: [
        { order_id: ids.sold, total_price: 200000, market_id: MARKET },
        { order_id: ids.paid, total_price: 150000, market_id: MARKET },
        { order_id: ids.partly, total_price: 90000, market_id: MARKET },
      ],
      truncated: false,
      next_after_id: null,
      cursor: 'id_asc',
    });
  });

  it('buyurtmasiz operator — bo`sh; yaroqsiz id — 400', async () => {
    expect(await analytics.getOperatorSoldOrders(MARKET, '999')).toEqual({
      items: [],
      truncated: false,
      next_after_id: null,
      cursor: 'id_asc',
    });
    await expect(
      analytics.getOperatorSoldOrders(MARKET, 'abc'),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 }),
    });
  });

  it('audit 2026-11-22 #9: sahifa to`lsa `next_after_id`, keyingisi `after_id` dan keyin — eskilari ham chiqadi, takror yo`q', async () => {
    const first = await analytics.getOperatorSoldOrders(MARKET, OPERATOR, {
      pageSize: 2,
    });
    expect(first.items.map((item) => item.order_id)).toEqual([
      ids.sold,
      ids.paid,
    ]);
    expect(first).toMatchObject({ truncated: true, next_after_id: ids.paid });

    const second = await analytics.getOperatorSoldOrders(MARKET, OPERATOR, {
      pageSize: 2,
      afterId: first.next_after_id,
    });
    expect(second.items.map((item) => item.order_id)).toEqual([ids.partly]);
    expect(second).toMatchObject({ truncated: false, next_after_id: null });
  });

  it('audit #8: `order_ids` — faqat shulardan hozir sotilganlari (boshqa operator / holat / o`chirilgan kirmaydi)', async () => {
    const res = await analytics.getOperatorSoldOrders(MARKET, OPERATOR, {
      orderIds: [
        ids.sold,
        ids.new,
        ids['other-op'],
        ids.deleted,
        ids.partly,
        'abc',
      ],
    });
    expect(res.items.map((item) => item.order_id)).toEqual([
      ids.sold,
      ids.partly,
    ]);
    expect(res).toMatchObject({ truncated: false, filtered_by_ids: true });

    expect(
      await analytics.getOperatorSoldOrders(MARKET, OPERATOR, {
        orderIds: [],
      }),
    ).toMatchObject({ items: [], filtered_by_ids: true });
  });

  it('yaroqsiz `after_id` / `order_ids` — 400', async () => {
    for (const options of [{ afterId: '0' }, { orderIds: 'x' }]) {
      await expect(
        analytics.getOperatorSoldOrders(MARKET, OPERATOR, options),
      ).rejects.toMatchObject({
        error: expect.objectContaining({ statusCode: 400 }),
      });
    }
  });
});
