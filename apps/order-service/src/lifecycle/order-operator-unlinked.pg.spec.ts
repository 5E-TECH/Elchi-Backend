import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Branch } from '../entities/branch.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { Order } from '../entities/order.entity';
import { findUnlinkedOperatorGroups } from './order-operator-unlinked';

/**
 * 2026-11-20 — operator ismi faqat MATN bo'lib qolgan (operator_id siz) eski
 * buyurtmalar, ism bo'yicha guruhlar — haqiqiy Postgres'da (SQL kaliti:
 * `#`, katta-kichik harf, bo'shliqlar; integratsiya `external_*` kirmaydi;
 * operator_id bor, o'chirilgan, boshqa market — kirmaydi).
 *
 * Spec o'z VAQTINCHALIK BAZASINI yaratadi va oxirida o'chiradi
 * (ORDER_MARKET_STAT_PG_TEST_URI bo'lmasa skip — CI'da bor).
 */
const pgUri = process.env.ORDER_MARKET_STAT_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('findUnlinkedOperatorGroups (Postgres)', () => {
  const dbName = `spec_unlinked_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  const MARKET = '10';
  const OTHER_MARKET = '11';
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

    const rows: Array<{
      tag: string;
      market: string;
      operator: string | null;
      operatorId: string | null;
      status: string;
      deleted?: boolean;
    }> = [
      // «Sevinch» — 3 ta yozilish varianti bitta guruhda; 2 tasi sotilgan.
      {
        tag: 's1',
        market: MARKET,
        operator: '#sevinch',
        operatorId: null,
        status: 'sold',
      },
      {
        tag: 's2',
        market: MARKET,
        operator: 'Sevinch',
        operatorId: null,
        status: 'paid',
      },
      {
        tag: 's3',
        market: MARKET,
        operator: '  SEVINCH ',
        operatorId: null,
        status: 'new',
      },
      // «Bekzod Aliyev» — ikki bo'shliq bilan ham bitta guruh.
      {
        tag: 'b1',
        market: MARKET,
        operator: 'Bekzod  Aliyev',
        operatorId: null,
        status: 'cancelled',
      },
      {
        tag: 'b2',
        market: MARKET,
        operator: 'bekzod aliyev',
        operatorId: null,
        status: 'new',
      },
      // Kirmaydiganlar.
      {
        tag: 'x1',
        market: MARKET,
        operator: 'Sevinch',
        operatorId: '501',
        status: 'sold',
      },
      {
        tag: 'x2',
        market: MARKET,
        operator: 'external_uzum',
        operatorId: null,
        status: 'new',
      },
      {
        tag: 'x3',
        market: MARKET,
        operator: '   ',
        operatorId: null,
        status: 'new',
      },
      {
        tag: 'x4',
        market: MARKET,
        operator: null,
        operatorId: null,
        status: 'new',
      },
      {
        tag: 'x5',
        market: MARKET,
        operator: 'Sevinch',
        operatorId: null,
        status: 'sold',
        deleted: true,
      },
      {
        tag: 'x6',
        market: OTHER_MARKET,
        operator: 'Sevinch',
        operatorId: null,
        status: 'sold',
      },
      {
        tag: 'x7',
        market: MARKET,
        operator: '#',
        operatorId: null,
        status: 'new',
      },
    ];
    for (const row of rows) {
      const [inserted] = await db.query<Array<{ id: string }>>(
        `INSERT INTO order_schema.orders
           (market_id, customer_id, status, operator, operator_id, is_deleted)
         VALUES ($1, 2, $2, $3, $4, $5) RETURNING id`,
        [
          row.market,
          row.status,
          row.operator,
          row.operatorId,
          row.deleted === true,
        ],
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

  it('⭐ ism bo`yicha guruhlar: variantlar birlashadi, eng ko`pi birinchi; faqat shu market, operatorsiz, tirik', async () => {
    const res = await findUnlinkedOperatorGroups(
      db.getRepository(Order),
      MARKET,
    );

    expect(res.total_orders).toBe(5);
    expect(res.groups).toEqual([
      {
        key: 'sevinch',
        // Eng yangi buyurtmadagi yozuv (bo'shliqlarsiz).
        name: 'SEVINCH',
        total_orders: 3,
        sold_orders: 2,
        order_ids: [ids.s3, ids.s2, ids.s1],
      },
      {
        key: 'bekzod aliyev',
        name: 'bekzod aliyev',
        total_orders: 2,
        sold_orders: 0,
        order_ids: [ids.b2, ids.b1],
      },
    ]);
  });

  it('boshqa market — o`z guruhlari; buyurtmasiz market — bo`sh', async () => {
    const other = await findUnlinkedOperatorGroups(
      db.getRepository(Order),
      OTHER_MARKET,
    );
    expect(other.groups).toEqual([
      expect.objectContaining({
        key: 'sevinch',
        total_orders: 1,
        order_ids: [ids.x6],
      }),
    ]);
    expect(
      await findUnlinkedOperatorGroups(db.getRepository(Order), '999'),
    ).toEqual({ groups: [], total_orders: 0 });
  });
});
