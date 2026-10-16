/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { Order_status } from '@app/common';
import { OrderAnalyticsService } from './order-analytics.service';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';

/**
 * juZFa64U — kuryerlar hisoboti: yangi to'plamli SQL
 * (`getCourierReportDetails` / `getCourierStats(includeDetail)`) ESKI
 * per-kuryer yo'l (`getCourierStat` — analytics-service har kuryer uchun
 * alohida `order.analytics.courier_stat` yuborardi) bilan HAQIQIY
 * Postgres'da AYNAN bir xil `canceledOrders` va `profit` beradi.
 *
 * Doiraning hamma shoxlari qamralgan: courier_id, holder_courier_id,
 * kuryer pochtasi (post_id, boshqa kuryerning buyurtmasi ham), custody
 * hodisasi (from/to), o'chirilgan buyurtma, oynadan tashqari sold_at /
 * tracking, 'cancelled_post_received' istisnosi, bir buyurtmaning bir necha
 * bekor tracking qatori (DISTINCT), courier_share NULL → courier_tariff.
 *
 * Faqat lokal test bazasida:
 *   ORDER_COURIER_REPORT_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_b_courier_report_test
 */
const uri = process.env.ORDER_COURIER_REPORT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();

const START = '2026-06-01';
const END = '2026-06-30';
const IN_RANGE = '2026-06-10T08:00:00.000Z';
const BEFORE = '2026-05-20T08:00:00.000Z';
const ms = (iso: string) => String(new Date(iso).getTime());

// Pochtalar (logistics.post.find_all): P1, P3 — kuryer 301; P2 — 302.
const POSTS = [
  { id: '1', courier_id: '301' },
  { id: '2', courier_id: '302' },
  { id: '3', courier_id: '301' },
  { id: '4', courier_id: '0' },
];

(localTestDatabase ? describe : describe.skip)(
  'juZFa64U — kuryerlar hisoboti: to`plamli SQL == eski per-kuryer yo`l (Postgres)',
  () => {
    let db: DataSource;
    let analytics: OrderAnalyticsService;
    const logisticsSend = jest.fn((pattern: { cmd: string }, payload: any) => {
      if (pattern.cmd === 'logistics.post.find_all') {
        return of({ data: { data: POSTS, totalPages: 1 } });
      }
      if (pattern.cmd === 'logistics.post.find_by_ids') {
        const ids = new Set((payload.ids as string[]).map(String));
        return of({ data: POSTS.filter((p) => ids.has(p.id)) });
      }
      return of({ data: null });
    });

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'order_schema',
        entities: [Order, OrderItem, OrderTracking, OrderCustodyEvent, Branch],
        synchronize: false,
      });
      await db.initialize();
      for (const schema of ['order_schema', 'branch_schema']) {
        await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db.query(`CREATE SCHEMA "${schema}"`);
      }
      await db.synchronize();
      analytics = new OrderAnalyticsService(
        db.getRepository(Order),
        db.getRepository(OrderTracking),
        db.getRepository(OrderCustodyEvent),
        {} as never,
        {} as never,
        { send: logisticsSend } as never,
        {
          getCouriersByIds: (ids: string[]) =>
            Promise.resolve(ids.map((id) => ({ id, name: `K-${id}` }))),
        } as never,
      );
      await seed();
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        for (const schema of ['order_schema', 'branch_schema']) {
          await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
        await db.destroy();
      }
      jest.restoreAllMocks();
    });

    async function order(o: {
      courier_id?: string | null;
      holder_courier_id?: string | null;
      post_id?: string | null;
      status: string;
      sold_at?: string | null;
      courier_share?: number | null;
      courier_tariff?: number | null;
      is_deleted?: boolean;
    }): Promise<string> {
      const [row] = await db.query(
        `INSERT INTO order_schema.orders
           (market_id, customer_id, status, courier_id, holder_courier_id,
            post_id, sold_at, courier_share, courier_tariff, is_deleted,
            "createdAt", assigned_at)
         VALUES (1, 2, $1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         RETURNING id`,
        [
          o.status,
          o.courier_id ?? null,
          o.holder_courier_id ?? null,
          o.post_id ?? null,
          o.sold_at ?? null,
          o.courier_share ?? null,
          o.courier_tariff ?? null,
          o.is_deleted ?? false,
          IN_RANGE,
        ],
      );
      return String(row.id);
    }

    async function tracking(
      orderId: string,
      toStatus: string,
      createdAt: string,
      action: string | null = null,
    ) {
      await db.query(
        `INSERT INTO order_schema.order_tracking
           (order_id, to_status, action, changed_by, changed_by_role, created_at)
         VALUES ($1, $2, $3, '1', 'courier', $4)`,
        [orderId, toStatus, action, createdAt],
      );
    }

    async function custody(
      orderId: string,
      from: string | null,
      to: string | null,
    ) {
      await db.query(
        `INSERT INTO order_schema.order_custody_events
           (order_id, to_holder_type, from_courier_id, to_courier_id,
            changed_by, changed_by_role)
         VALUES ($1, 'COURIER', $2, $3, '1', 'manager')`,
        [orderId, from, to],
      );
    }

    async function seed() {
      // 301: o'z buyurtmalari.
      await order({
        courier_id: '301',
        post_id: '1',
        status: 'sold',
        sold_at: ms(IN_RANGE),
        courier_share: 30000,
        courier_tariff: 99999,
      });
      await order({
        courier_id: '301',
        post_id: '1',
        status: 'paid',
        sold_at: ms(IN_RANGE),
        courier_share: null,
        courier_tariff: 25000,
      });
      // 302 ning buyurtmasi, lekin 301 ning pochtasida — IKKALASIGA tegishli.
      await order({
        courier_id: '302',
        post_id: '1',
        status: 'partly_paid',
        sold_at: ms(IN_RANGE),
        courier_share: 20000,
      });
      // holder_courier_id 302 — bekor (oynada).
      const o4 = await order({ holder_courier_id: '302', status: 'cancelled' });
      await tracking(o4, 'cancelled', IN_RANGE);
      // 301: cancelled_post_received istisno, closed esa sanaladi (1 marta).
      const o5 = await order({ courier_id: '301', status: 'closed' });
      await tracking(o5, 'cancelled', IN_RANGE, 'cancelled_post_received');
      await tracking(o5, 'closed', IN_RANGE);
      // 301: oynadan tashqari sotuv — daromadga kirmaydi.
      await order({
        courier_id: '301',
        post_id: '3',
        status: 'sold',
        sold_at: ms(BEFORE),
        courier_share: 70000,
      });
      // 301: o'chirilgan — hech qayerga kirmaydi.
      const o7 = await order({
        courier_id: '301',
        status: 'sold',
        sold_at: ms(IN_RANGE),
        courier_share: 50000,
        is_deleted: true,
      });
      await tracking(o7, 'cancelled', IN_RANGE);
      // Custody: 304 → 302 (buyurtmada courier_id yo'q).
      const o8 = await order({ status: Order_status.CANCELLED_SENT });
      await custody(o8, '304', '302');
      await tracking(o8, Order_status.CANCELLED_SENT, IN_RANGE);
      // 301: ikki bekor tracking — DISTINCT bitta.
      const o9 = await order({
        courier_id: '301',
        post_id: '3',
        status: 'cancelled',
      });
      await tracking(o9, 'cancelled', IN_RANGE);
      await tracking(o9, Order_status.CANCELLED_SENT, IN_RANGE);
      // 302: oynadan tashqari bekor.
      const o10 = await order({
        courier_id: '302',
        post_id: '2',
        status: 'cancelled',
      });
      await tracking(o10, 'cancelled', BEFORE);
      // 302 pochtasidagi sotuv (P2).
      await order({
        post_id: '2',
        status: 'sold',
        sold_at: ms(IN_RANGE),
        courier_share: 15000,
      });
    }

    const COURIERS = ['301', '302', '303', '304'];

    it('⭐ har kuryer uchun canceledOrders/profit — eski getCourierStat bilan AYNAN teng', async () => {
      const batch = await analytics.getCourierReportDetails(
        COURIERS,
        START,
        END,
      );

      for (const courierId of COURIERS) {
        const legacy = await analytics.getCourierStat(courierId, START, END);
        expect({ courierId, ...batch.get(courierId) }).toEqual({
          courierId,
          canceledOrders: legacy.canceledOrders,
          profit: legacy.profit,
        });
      }
      // Ma'lumot ataylab bo'sh emas (solishtirish ma'noli bo'lsin).
      expect(batch.get('301')).toEqual({ canceledOrders: 2, profit: 75000 });
      expect(batch.get('302')).toEqual({ canceledOrders: 2, profit: 35000 });
      expect(batch.get('303')).toEqual({ canceledOrders: 0, profit: 0 });
      expect(batch.get('304')).toEqual({ canceledOrders: 1, profit: 0 });
    });

    it('⭐ pochtalar BIR marta yuklanadi (kuryerlar soniga bog`liq emas)', async () => {
      logisticsSend.mockClear();

      await analytics.getCourierReportDetails(COURIERS, START, END);

      const findAll = logisticsSend.mock.calls.filter(
        ([pattern]: any[]) => pattern.cmd === 'logistics.post.find_all',
      );
      expect(findAll).toHaveLength(1);
    });

    it('getCourierStats(includeDetail) — har qatorda eski courier_stat raqamlari', async () => {
      const rows: any[] = await analytics.getCourierStats(
        START,
        END,
        undefined,
        false,
        true,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const legacy = await analytics.getCourierStat(
          String(row.courier.id),
          START,
          END,
        );
        expect({
          id: String(row.courier.id),
          canceledOrders: row.canceledOrders,
          profit: row.profit,
        }).toEqual({
          id: String(row.courier.id),
          canceledOrders: legacy.canceledOrders,
          profit: legacy.profit,
        });
      }
      // includeDetail'siz — eski shakl (dashboard chaqiruvlari o'zgarmagan).
      const plain: any[] = await analytics.getCourierStats(START, END);
      expect(Object.keys(plain[0]).sort()).toEqual(
        ['courier', 'soldOrders', 'successRate', 'totalOrders'].sort(),
      );
    });

    it("kuryersiz / bo'sh davr — xatosiz", async () => {
      await expect(
        analytics.getCourierReportDetails([], START, END),
      ).resolves.toEqual(new Map());
      const empty = await analytics.getCourierReportDetails(
        ['301'],
        '2030-01-01',
        '2030-01-02',
      );
      expect(empty.get('301')).toEqual({ canceledOrders: 0, profit: 0 });
      await expect(
        analytics.getCourierStats(
          '2030-01-01',
          '2030-01-02',
          undefined,
          false,
          true,
        ),
      ).resolves.toEqual([]);
    });

    /**
     * Kesh bo'sh holatdagi vaqt: 60 kuryer, har birining pochtasi va
     * buyurtmalari. Eski yo'l = har kuryerga `getCourierStat` (pochtalar
     * qayta yuklanadi + 3 so'rov); yangi = bitta `getCourierReportDetails`.
     * RMQ kechikishisiz ham (prod'da har RPC ~160 ms qo'shardi) yangi yo'l
     * tezroq va natija bir xil.
     */
    it('⭐ sovuq kesh vaqti: 60 kuryer — yangi yo`l eskisidan tez, natija bir xil', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 60; i++) {
        const courierId = String(1000 + i);
        const postId = String(5000 + i);
        ids.push(courierId);
        POSTS.push({ id: postId, courier_id: courierId });
        for (let k = 0; k < 5; k++) {
          const id = await order({
            courier_id: courierId,
            post_id: postId,
            status: k % 2 ? Order_status.SOLD : Order_status.CANCELLED,
            sold_at: k % 2 ? ms(IN_RANGE) : null,
            courier_share: 10000 + i,
          });
          if (!(k % 2)) await tracking(id, Order_status.CANCELLED, IN_RANGE);
        }
      }

      logisticsSend.mockClear();
      const legacyStarted = Date.now();
      const legacy = new Map<
        string,
        { canceledOrders: number; profit: number }
      >();
      for (const id of ids) {
        const stat = await analytics.getCourierStat(id, START, END);
        legacy.set(id, {
          canceledOrders: stat.canceledOrders,
          profit: stat.profit,
        });
      }
      const legacyMs = Date.now() - legacyStarted;
      const legacyPostLoads = logisticsSend.mock.calls.length;

      logisticsSend.mockClear();
      const batchStarted = Date.now();
      const batch = await analytics.getCourierReportDetails(ids, START, END);
      const batchMs = Date.now() - batchStarted;

      expect(batch).toEqual(legacy);
      expect(legacyPostLoads).toBe(60);
      expect(logisticsSend.mock.calls.length).toBe(1);
      expect(batchMs).toBeLessThan(legacyMs);
      process.stdout.write(
        `juZFa64U: 60 kuryer — eski ${legacyMs} ms (${legacyPostLoads} pochta yuklash + 180 SQL), yangi ${batchMs} ms (1 yuklash + 1 SQL)\n`,
      );
    }, 60_000);
  },
);
