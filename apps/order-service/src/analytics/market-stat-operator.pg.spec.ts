import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Branch } from '../entities/branch.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { Order } from '../entities/order.entity';
import { OrderAnalyticsService } from './order-analytics.service';

/**
 * Market operatori dashboardi (ega 2026-11-11: «operator dashboardida
 * o'ziniki emas, u tegishli marketning umumiy statistikasi ko'rinyapti») —
 * `getMarketStat(marketId, …, operatorId)` haqiqiy Postgres'da.
 *
 *  • `operatorId` berilsa — faqat `operator_id` shu operator bo'lgan
 *    buyurtmalar (jami / sotilgan / bekor / jarayonda / sof foyda / foiz);
 *  • berilmasa yoki bo'sh — butun market (market dashboardi o'zgarmagan);
 *  • market doirasi saqlanadi: operatorning boshqa marketdagi buyurtmasi
 *    hisobga tushmaydi; operatorsiz buyurtma hech bir operatorga tushmaydi.
 *
 * Spec o'z VAQTINCHALIK BAZASINI yaratadi va oxirida o'chiradi
 * (ORDER_MARKET_STAT_PG_TEST_URI bo'lmasa skip).
 * Lokal: ORDER_MARKET_STAT_PG_TEST_URI=postgres://postgres@127.0.0.1:5432/postgres
 */
const pgUri = process.env.ORDER_MARKET_STAT_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg(
  'Operator dashboardi — getMarketStat operator doirasi (Postgres)',
  () => {
    const dbName = `spec_mstat_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    let analytics: OrderAnalyticsService;

    const MARKET = '10';
    const OTHER_MARKET = '11';
    const OPERATOR_A = '501';
    const OPERATOR_B = '502';

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: pgUri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      const url = new URL(pgUri as string);
      url.pathname = `/${dbName}`;
      const bootstrap = new DataSource({
        type: 'postgres',
        url: url.toString(),
      });
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
        {
          getMarketsByIds: jest.fn().mockResolvedValue([]),
          getCouriersByIds: jest.fn().mockResolvedValue([]),
        } as never,
      );

      const soldAt = String(Date.now() - 60_000);
      const rows: Array<{
        market: string;
        operator: string | null;
        status: string;
        toBePaid: number;
        sold: boolean;
      }> = [
        // Operator A — 3 ta: sotilgan, bekor, yangi.
        {
          market: MARKET,
          operator: OPERATOR_A,
          status: 'sold',
          toBePaid: 100_000,
          sold: true,
        },
        {
          market: MARKET,
          operator: OPERATOR_A,
          status: 'cancelled',
          toBePaid: 0,
          sold: false,
        },
        {
          market: MARKET,
          operator: OPERATOR_A,
          status: 'new',
          toBePaid: 0,
          sold: false,
        },
        // Operator B — 2 ta: sotilgan, to'langan.
        {
          market: MARKET,
          operator: OPERATOR_B,
          status: 'sold',
          toBePaid: 50_000,
          sold: true,
        },
        {
          market: MARKET,
          operator: OPERATOR_B,
          status: 'paid',
          toBePaid: 70_000,
          sold: true,
        },
        // Operatorsiz (market o'zi yaratgan, operator tanlamagan).
        {
          market: MARKET,
          operator: null,
          status: 'sold',
          toBePaid: 30_000,
          sold: true,
        },
        // Operator A ning BOSHQA marketdagi buyurtmasi — hisobga tushmaydi.
        {
          market: OTHER_MARKET,
          operator: OPERATOR_A,
          status: 'sold',
          toBePaid: 999_000,
          sold: true,
        },
      ];
      for (const row of rows) {
        await db.query(
          `INSERT INTO order_schema.orders
           (market_id, customer_id, status, operator_id, to_be_paid, sold_at)
         VALUES ($1, 2, $2, $3, $4, $5)`,
          [
            row.market,
            row.status,
            row.operator,
            row.toBePaid,
            row.sold ? soldAt : null,
          ],
        );
      }
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        await admin.destroy();
      }
    });

    const pick = (stat: Record<string, unknown>) => ({
      totalOrders: stat.totalOrders,
      soldOrders: stat.soldOrders,
      canceledOrders: stat.canceledOrders,
      inProgress: stat.inProgress,
      profit: stat.profit,
      successRate: stat.successRate,
    });

    it('operatorsiz chaqiruv — butun market (market dashboardi o`zgarmagan)', async () => {
      const stat = await analytics.getMarketStat(
        MARKET,
        undefined,
        undefined,
        true,
      );
      expect(pick(stat)).toEqual({
        totalOrders: 6,
        soldOrders: 4,
        canceledOrders: 1,
        inProgress: 1,
        profit: 250_000,
        successRate: 66.67,
      });
    });

    it('⭐ operator A — faqat o`z buyurtmalari (boshqa market va operatorsizlar kirmaydi)', async () => {
      const stat = await analytics.getMarketStat(
        MARKET,
        undefined,
        undefined,
        true,
        OPERATOR_A,
      );
      expect(pick(stat)).toEqual({
        totalOrders: 3,
        soldOrders: 1,
        canceledOrders: 1,
        inProgress: 1,
        profit: 100_000,
        successRate: 33.33,
      });
    });

    it('⭐ operator B — faqat o`z buyurtmalari, sof foyda ham faqat uniki', async () => {
      const stat = await analytics.getMarketStat(
        MARKET,
        undefined,
        undefined,
        true,
        OPERATOR_B,
      );
      expect(pick(stat)).toEqual({
        totalOrders: 2,
        soldOrders: 2,
        canceledOrders: 0,
        inProgress: 0,
        profit: 120_000,
        successRate: 100,
      });
    });

    it('bo`sh operator id — butun market (filtr qo`yilmaydi)', async () => {
      const stat = await analytics.getMarketStat(
        MARKET,
        undefined,
        undefined,
        true,
        '  ',
      );
      expect(stat.totalOrders).toBe(6);
    });

    it('buyurtmasi yo`q operator — nollar', async () => {
      const stat = await analytics.getMarketStat(
        MARKET,
        undefined,
        undefined,
        true,
        '777',
      );
      expect(pick(stat)).toEqual({
        totalOrders: 0,
        soldOrders: 0,
        canceledOrders: 0,
        inProgress: 0,
        profit: 0,
        successRate: 0,
      });
    });
  },
);
