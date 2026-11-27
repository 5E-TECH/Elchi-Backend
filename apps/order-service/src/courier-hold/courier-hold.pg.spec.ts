/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OutboxEvent, OutboxService } from '@app/common';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { CourierHoldWarning1716000000254 } from '../../../../migrations/1716000000254-CourierHoldWarning';
import { CourierHoldService } from './courier-hold.service';
import { courierHoldRange, courierHoldSql } from './courier-hold';

/**
 * onXzDc5n — kuryerdagi buyurtmalar HAQIQIY Postgres'da:
 *   - migratsiya 254: ustun + qism indeks, qayta yurgizish, down;
 *   - GET /orders filtri (`courierHoldSql` + `courierHoldRange`) TypeORM
 *     `order` aliasi bilan: near_48 / over_48 / over_72 / any chegaralari,
 *     sotilgan/bekor/HQ/filial/o'chirilgan kirmaydi;
 *   - kuryer jamlamasi: oraliqlar, bekor-qaytarilmagan, doira (market,
 *     filial, kuryer), eng eski birinchi;
 *   - ogohlantirish: faqat 36–48 oynasi, kuryer bo'yicha bitta + market
 *     bo'yicha bitta outbox, IDEMPOTENT (ikkinchi yugurish — hech narsa;
 *     PARALLEL ikki «replika» — bir marta), boshqa kuryerga o'tsa yana bir
 *     marta, qaytarish so'ralgani — xabarsiz, outbox yiqilsa belgi qaytadi.
 *
 * Faqat lokal `/elchi_courier_hold_test`:
 *   COURIER_HOLD_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_courier_hold_test
 */
const uri = process.env.COURIER_HOLD_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_courier_hold_test'
  );
})();

type Row = Record<string, any>;

const ORDER = `chold_order_${process.pid}`;
const BRANCH = 'branch_schema';
const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-11-27T07:00:00Z'); // 12:00 Toshkent
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * HOUR);

(localTestDatabase ? describe : describe.skip)(
  'onXzDc5n — kuryerdagi buyurtmalar (pg)',
  () => {
    let db: DataSource;
    const migration = new CourierHoldWarning1716000000254(ORDER);

    const q = async (sql: string, params?: unknown[]): Promise<Row[]> => {
      const rows: Row[] = await db.query(sql, params);
      return rows;
    };

    const insertOrder = async (values: Row): Promise<string> => {
      const row = {
        market_id: '37',
        customer_id: '500',
        status: 'waiting',
        holder_type: 'COURIER',
        holder_courier_id: '26',
        courier_id: '26',
        holder_branch_id: '10',
        branch_id: '10',
        post_id: '900',
        last_handover_at: hoursAgo(10),
        ...values,
      };
      const keys = Object.keys(row);
      const [inserted] = await q(
        `INSERT INTO "${ORDER}"."orders" (${keys.map((k) => `"${k}"`).join(', ')})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING "id"::text AS "id"`,
        keys.map((k) => row[k]),
      );
      return String(inserted.id);
    };

    const warnedAt = async (id: string) => {
      const [row] = await q(
        `SELECT "courier_hold_warned_at" FROM "${ORDER}"."orders" WHERE "id" = $1`,
        [id],
      );
      return row?.courier_hold_warned_at ?? null;
    };

    const outboxRows = () =>
      q(
        `SELECT "target", "pattern", "payload" FROM "${ORDER}"."outbox_events" ORDER BY "id"`,
      );

    const makeService = (outbox?: OutboxService) =>
      new CourierHoldService(
        db.getRepository(Order),
        outbox ?? new OutboxService(db.getRepository(OutboxEvent)),
      );

    /** GET /orders filtrining o'zi (`buildOrderListQuery` dagi kabi). */
    const listIds = async (
      filter: 'any' | 'near_48' | 'over_48' | 'over_72',
    ): Promise<string[]> => {
      const qb = db
        .getRepository(Order)
        .createQueryBuilder('order')
        .where(courierHoldSql('order'));
      const range = courierHoldRange(filter, NOW);
      if (range.before) {
        qb.andWhere('order.last_handover_at <= :courier_hold_before', {
          courier_hold_before: range.before,
        });
      }
      if (range.after) {
        qb.andWhere('order.last_handover_at > :courier_hold_after', {
          courier_hold_after: range.after,
        });
      }
      qb.orderBy('order.last_handover_at', 'ASC').addOrderBy('order.id', 'ASC');
      return (await qb.getMany()).map((o) => String(o.id));
    };

    const reset = async () => {
      await q(`DELETE FROM "${ORDER}"."outbox_events"`);
      await q(`DELETE FROM "${ORDER}"."orders"`);
    };

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: ORDER,
        entities: [
          Order,
          OrderItem,
          OrderTracking,
          OrderCustodyEvent,
          Branch,
          OutboxEvent,
        ],
        synchronize: false,
        extra: { max: 6 },
      });
      await db.initialize();
      await db.query(`CREATE SCHEMA IF NOT EXISTS "${ORDER}"`);
      await db.query(`CREATE SCHEMA IF NOT EXISTS "${BRANCH}"`);
      await db.synchronize();
    });

    afterAll(async () => {
      jest.restoreAllMocks();
      if (!db?.isInitialized) return;
      await db.query(`DROP SCHEMA IF EXISTS "${ORDER}" CASCADE`);
      await db.query(`DROP SCHEMA IF EXISTS "${BRANCH}" CASCADE`);
      await db.destroy();
    });

    describe('migratsiya 254', () => {
      const columns = () =>
        q(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'orders'
              AND column_name = 'courier_hold_warned_at'`,
          [ORDER],
        );
      const index = () =>
        q(
          `SELECT indexdef FROM pg_indexes
            WHERE schemaname = $1 AND indexname = 'IDX_orders_courier_hold'`,
          [ORDER],
        );

      it('down → ustun va indeks yo‘q; up (2 marta) → bor, qism indeks sharti to‘g‘ri', async () => {
        await migration.down(db.createQueryRunner());
        expect(await columns()).toEqual([]);
        expect(await index()).toEqual([]);

        await migration.up(db.createQueryRunner());
        await migration.up(db.createQueryRunner());
        expect(await columns()).toEqual([
          { column_name: 'courier_hold_warned_at' },
        ]);
        const [idx] = await index();
        expect(idx.indexdef).toContain('(last_handover_at)');
        expect(idx.indexdef).toContain("holder_type = 'COURIER'");
        expect(idx.indexdef).toMatch(/on the road.*waiting.*waiting_customer/);
        expect(idx.indexdef).toContain('is_deleted = false');
      });
    });

    describe('ro‘yxat filtri va jamlama', () => {
      const ids: Record<string, string> = {};

      beforeAll(async () => {
        await reset();
        // Kuryer 26 (filial 10, market 37):
        ids.h10 = await insertOrder({ last_handover_at: hoursAgo(10) });
        ids.h35 = await insertOrder({ last_handover_at: hoursAgo(35.9) });
        ids.h36 = await insertOrder({ last_handover_at: hoursAgo(36) });
        ids.h47 = await insertOrder({
          status: 'on the road',
          last_handover_at: hoursAgo(47.9),
        });
        ids.h48 = await insertOrder({
          status: 'waiting_customer',
          last_handover_at: hoursAgo(48),
        });
        ids.h71 = await insertOrder({ last_handover_at: hoursAgo(71.9) });
        ids.h72 = await insertOrder({ last_handover_at: hoursAgo(72) });
        ids.h100 = await insertOrder({
          market_id: '38',
          last_handover_at: hoursAgo(100),
        });
        // Kuryer 27 (filial 11, market 38):
        ids.c27 = await insertOrder({
          holder_courier_id: '27',
          courier_id: '27',
          holder_branch_id: '11',
          branch_id: '11',
          market_id: '38',
          last_handover_at: hoursAgo(80),
        });
        // Kuryerda turgan bekor (qaytarilmagan) — ro'yxatlarga kirmaydi, jamlamada alohida.
        ids.cancelHeld = await insertOrder({
          status: 'cancelled',
          last_handover_at: hoursAgo(90),
        });
        // Kirmaydiganlar: sotilgan, to'langan, HQ'da, filialda, o'chirilgan, custody vaqtisiz.
        await insertOrder({ status: 'sold', last_handover_at: hoursAgo(90) });
        await insertOrder({ status: 'paid', last_handover_at: hoursAgo(90) });
        await insertOrder({
          holder_type: 'HQ',
          holder_courier_id: null,
          status: 'waiting',
          last_handover_at: hoursAgo(90),
        });
        await insertOrder({
          holder_type: 'BRANCH',
          holder_courier_id: null,
          status: 'received',
          last_handover_at: hoursAgo(90),
        });
        await insertOrder({ is_deleted: true, last_handover_at: hoursAgo(90) });
        await insertOrder({ last_handover_at: null });
      });

      it('⭐ near_48 = 36 ≤ soat < 48; over_48 = 48–72; over_72 ≥ 72 (eng eskisi birinchi); any — hammasi', async () => {
        expect(await listIds('near_48')).toEqual([ids.h47, ids.h36]);
        expect(await listIds('over_48')).toEqual([ids.h71, ids.h48]);
        expect(await listIds('over_72')).toEqual([ids.h100, ids.c27, ids.h72]);
        expect(await listIds('any')).toEqual([
          ids.h100,
          ids.c27,
          ids.h72,
          ids.h71,
          ids.h48,
          ids.h47,
          ids.h36,
          ids.h35,
          ids.h10,
        ]);
      });

      it('⭐ jamlama: kuryer bo‘yicha oraliqlar, bekor-qaytarilmagan, eng eski birinchi', async () => {
        const summary = await makeService().summary({}, NOW);
        expect(summary.couriers).toEqual([
          {
            courier_id: '26',
            total: 8,
            under_36: 2,
            near_48: 2,
            over_48: 2,
            over_72: 2,
            oldest_since: hoursAgo(100).toISOString(),
            oldest_hours: 100,
            cancelled_held: 1,
          },
          {
            courier_id: '27',
            total: 1,
            under_36: 0,
            near_48: 0,
            over_48: 0,
            over_72: 1,
            oldest_since: hoursAgo(80).toISOString(),
            oldest_hours: 80,
            cancelled_held: 0,
          },
        ]);
        expect(summary.totals).toEqual({
          couriers: 2,
          total: 9,
          under_36: 2,
          near_48: 2,
          over_48: 2,
          over_72: 3,
          oldest_hours: 100,
          cancelled_held: 1,
        });
      });

      it('⭐ doira: market, filial (branch/holder/home), kuryer; bo‘sh kuryer to‘plami — hech narsa', async () => {
        const service = makeService();
        const market38 = await service.summary({ market_id: '38' }, NOW);
        expect(market38.couriers.map((c) => [c.courier_id, c.total])).toEqual([
          ['26', 1],
          ['27', 1],
        ]);
        const branch11 = await service.summary({ branch_id: '11' }, NOW);
        expect(branch11.couriers.map((c) => c.courier_id)).toEqual(['27']);
        const courier26 = await service.summary({ courier_ids: ['26'] }, NOW);
        expect(courier26.couriers.map((c) => c.courier_id)).toEqual(['26']);
        const none = await service.summary({ courier_ids: [] }, NOW);
        expect(none.couriers).toEqual([]);
        expect(none.totals.total).toBe(0);
      });
    });

    describe('36 soatlik ogohlantirish', () => {
      const ids: Record<string, string> = {};

      beforeEach(async () => {
        await reset();
        ids.a36 = await insertOrder({ last_handover_at: hoursAgo(36.5) });
        ids.a40 = await insertOrder({ last_handover_at: hoursAgo(40) });
        ids.b40 = await insertOrder({
          holder_courier_id: '27',
          courier_id: '27',
          market_id: '38',
          last_handover_at: hoursAgo(40),
        });
        // Oynadan tashqari / istisnolar:
        ids.early = await insertOrder({ last_handover_at: hoursAgo(35) });
        ids.late = await insertOrder({ last_handover_at: hoursAgo(49) });
        ids.returnReq = await insertOrder({
          status: 'on the road',
          return_requested: true,
          last_handover_at: hoursAgo(40),
        });
        ids.sold = await insertOrder({
          status: 'sold',
          last_handover_at: hoursAgo(40),
        });
      });

      it('⭐ faqat 36–48 oynasi; kuryer bo‘yicha bitta + market bo‘yicha bitta outbox', async () => {
        const result = await makeService().warnDue(NOW);
        expect(result).toEqual({
          locked: true,
          orders: 3,
          notifications: 4,
          hit_limit: false,
        });
        for (const id of [ids.a36, ids.a40, ids.b40]) {
          expect(await warnedAt(id)).toEqual(NOW);
        }
        for (const id of [ids.early, ids.late, ids.returnReq, ids.sold]) {
          expect(await warnedAt(id)).toBeNull();
        }
        const rows = await outboxRows();
        expect(rows.map((r) => [r.target, r.pattern])).toEqual(
          Array.from({ length: 4 }, () => [
            'NOTIFICATION',
            'notification.dispatch',
          ]),
        );
        const payloads = rows.map((r) => r.payload);
        const courier26 = payloads.find(
          (p) => p.data.audience === 'courier' && p.data.courier_id === '26',
        );
        expect(courier26).toMatchObject({
          type: 'order.courier_hold_warning',
          recipient_ids: ['26'],
          data: {
            count: 2,
            order_ids: [ids.a36, ids.a40].sort((a, b) => Number(a) - Number(b)),
          },
        });
        expect(courier26).not.toHaveProperty('telegram');
        const market37 = payloads.find(
          (p) => p.data.audience === 'market' && p.data.market_id === '37',
        );
        expect(market37).toMatchObject({
          recipient_ids: ['37'],
          telegram: { market_id: '37', group_type: 'create' },
          data: { count: 2 },
        });
        expect(
          payloads
            .filter((p) => p.data.audience === 'courier')
            .map((p) => p.recipient_ids[0])
            .sort(),
        ).toEqual(['26', '27']);
        expect(
          payloads
            .filter((p) => p.data.audience === 'market')
            .map((p) => p.recipient_ids[0])
            .sort(),
        ).toEqual(['37', '38']);
      });

      it('⭐ IDEMPOTENT: ikkinchi yugurish (keyingi tik) — hech narsa', async () => {
        const service = makeService();
        await service.warnDue(NOW);
        const later = new Date(NOW.getTime() + 10 * 60 * 1000);
        await expect(service.warnDue(later)).resolves.toMatchObject({
          locked: true,
          orders: 0,
          notifications: 0,
        });
        expect(await outboxRows()).toHaveLength(4);
        expect(await warnedAt(ids.a40)).toEqual(NOW);
      });

      it('⭐ PARALLEL ikki «replika» — har buyurtma bir marta, xabarlar takrorlanmaydi', async () => {
        const results = await Promise.all([
          makeService().warnDue(NOW),
          makeService().warnDue(NOW),
        ]);
        expect(results.reduce((acc, r) => acc + r.orders, 0)).toBe(3);
        expect(await outboxRows()).toHaveLength(4);
      });

      it('⭐ boshqa kuryerga o‘tsa (yangi last_handover_at) — yangi oynada yana BIR marta', async () => {
        const service = makeService();
        await service.warnDue(NOW);
        // 26 → 27: ogohlantirishdan 1 soat keyin boshqa kuryerga topshirildi.
        const handover = new Date(NOW.getTime() + HOUR);
        await q(
          `UPDATE "${ORDER}"."orders"
              SET "holder_courier_id" = 27, "courier_id" = 27, "last_handover_at" = $2
            WHERE "id" = $1`,
          [ids.a40, handover],
        );
        // Yangi kuryerda 35 soat — hali yo'q; 37 soat — bir marta.
        await expect(
          service.warnDue(new Date(handover.getTime() + 35 * HOUR)),
        ).resolves.toMatchObject({ orders: 0 });
        const later = new Date(handover.getTime() + 37 * HOUR);
        await expect(service.warnDue(later)).resolves.toMatchObject({
          orders: 1,
        });
        expect(await warnedAt(ids.a40)).toEqual(later);
        await expect(
          service.warnDue(new Date(later.getTime() + HOUR)),
        ).resolves.toMatchObject({ orders: 0 });
      });

      it('partiya chegarasi — hit_limit; qolgani keyingi yugurishda', async () => {
        const service = makeService();
        await expect(service.warnDue(NOW, 2)).resolves.toMatchObject({
          orders: 2,
          hit_limit: true,
        });
        await expect(service.warnDue(NOW, 2)).resolves.toMatchObject({
          orders: 1,
          hit_limit: false,
        });
      });

      it('outbox yozuvi yiqilsa — belgi ham qaytadi (rollback), keyin qayta urinadi', async () => {
        const failing = {
          enqueue: jest.fn().mockRejectedValue(new Error('outbox down')),
        } as unknown as OutboxService;
        await expect(makeService(failing).warnDue(NOW)).rejects.toThrow(
          'outbox down',
        );
        expect(await warnedAt(ids.a40)).toBeNull();
        await expect(makeService().warnDue(NOW)).resolves.toMatchObject({
          orders: 3,
        });
      });
    });
  },
);
