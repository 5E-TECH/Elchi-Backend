/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OutboxEvent, OutboxService } from '@app/common';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { CancelReturnHandoverReminder1716000000174 } from '../../../../migrations/1716000000174-CancelReturnHandoverReminder';
import { CancelReturnReminderService } from './cancel-return-reminder.service';
import { resolveCancelReturnStage } from './cancel-return';

/**
 * vNKGbg5q (BG7) — eslatma / eskalatsiya HAQIQIY Postgres'da:
 *   - migratsiya 174: ustunlar + qism indeks, qayta yurgizish, down;
 *   - kim tanlanadi: BG1 `hq` / `branch` bosqichi, `received_at` (oxirgi
 *     `cancelled_post_received` yoki custody vaqti) chegaradan eski; kuryerda,
 *     yo'lda, marketda, ombor buyurtmasi, qabulgacha bekor, o'chirilgan — YO'Q;
 *   - market bo'yicha BITTA outbox yozuvi (`notification.dispatch`, CANCEL
 *     guruhi), eskalatsiya — buyurtma bo'yicha, admin rollari;
 *   - IDEMPOTENT: ikkinchi yugurish hech narsa yozmaydi; ikki «replika»
 *     PARALLEL yugursa ham har buyurtma bir marta belgilanadi;
 *   - outbox yozuvi yiqilsa — belgi ham qaytadi (rollback).
 *
 * Faqat lokal `/elchi_cancel_test`:
 *   CANCEL_RETURN_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_cancel_test
 */
const uri = process.env.CANCEL_RETURN_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_cancel_test'
  );
})();

type Row = Record<string, any>;

const ORDER = `crr_order_${process.pid}`;
const BRANCH = 'branch_schema';
const HQ_ID = '1';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-26T05:00:00Z'); // 10:00 Toshkent
const REMIND_CUTOFF = new Date(NOW.getTime() - 3 * DAY);
const ESCALATE_CUTOFF = new Date(NOW.getTime() - 7 * DAY);
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

(localTestDatabase ? describe : describe.skip)(
  'vNKGbg5q BG7 — bekor eslatmasi/eskalatsiyasi (pg)',
  () => {
    let db: DataSource;
    const migration = new CancelReturnHandoverReminder1716000000174(ORDER);

    const q = async (sql: string, params?: unknown[]): Promise<Row[]> => {
      const rows: Row[] = await db.query(sql, params);
      return rows;
    };

    const insertOrder = async (values: Row): Promise<string> => {
      const row = {
        market_id: '37',
        customer_id: '500',
        status: 'cancelled',
        holder_type: 'HQ',
        post_id: '900',
        last_handover_at: daysAgo(4),
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

    const received = (orderId: string, at: Date) =>
      q(
        `INSERT INTO "${ORDER}"."order_tracking"
           ("order_id", "to_status", "action", "changed_by", "changed_by_role", "created_at")
         VALUES ($1, 'cancelled', 'cancelled_post_received', '9', 'admin', $2)`,
        [orderId, at],
      );

    const flags = async (id: string) => {
      const [row] = await q(
        `SELECT "handover_notified_at", "handover_escalated_at"
           FROM "${ORDER}"."orders" WHERE "id" = $1`,
        [id],
      );
      return row;
    };

    const outboxRows = () =>
      q(
        `SELECT "target", "pattern", "payload" FROM "${ORDER}"."outbox_events" ORDER BY "id"`,
      );

    const makeService = (outbox?: OutboxService) =>
      new CancelReturnReminderService(
        db.getRepository(Order),
        db.getRepository(OrderTracking),
        outbox ?? new OutboxService(db.getRepository(OutboxEvent)),
        { getHqBranchId: () => Promise.resolve(HQ_ID) } as never,
      );

    const reset = async () => {
      await q(`DELETE FROM "${ORDER}"."outbox_events"`);
      await q(`DELETE FROM "${ORDER}"."order_tracking"`);
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
      await db.query(`DELETE FROM "${BRANCH}"."branches"`);
      await db.query(
        `INSERT INTO "${BRANCH}"."branches" ("id", "name") VALUES
           (${HQ_ID}, 'Toshkent <HQ>'), (10, 'Urgut filiali')`,
      );
    });

    afterAll(async () => {
      jest.restoreAllMocks();
      if (!db?.isInitialized) return;
      await db.query(`DROP SCHEMA IF EXISTS "${ORDER}" CASCADE`);
      await db.query(`DROP SCHEMA IF EXISTS "${BRANCH}" CASCADE`);
      await db.destroy();
    });

    describe('migratsiya 174', () => {
      const columns = () =>
        q(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'orders'
              AND column_name IN ('handover_notified_at', 'handover_escalated_at')
            ORDER BY column_name`,
          [ORDER],
        );
      const index = () =>
        q(
          `SELECT indexdef FROM pg_indexes
            WHERE schemaname = $1 AND indexname = 'IDX_orders_cancel_return_waiting'`,
          [ORDER],
        );

      it('down → ustunlar va indeks yo‘q; up (2 marta) → bor, qism indeks sharti to‘g‘ri', async () => {
        await migration.down(db.createQueryRunner());
        expect(await columns()).toEqual([]);
        expect(await index()).toEqual([]);

        await migration.up(db.createQueryRunner());
        await migration.up(db.createQueryRunner());
        expect((await columns()).map((r) => r.column_name)).toEqual([
          'handover_escalated_at',
          'handover_notified_at',
        ]);
        const [idx] = await index();
        expect(idx.indexdef).toContain('(market_id)');
        expect(idx.indexdef).toContain("status = 'cancelled'");
        expect(idx.indexdef).toContain('handover_escalated_at IS NULL');
      });
    });

    describe('eslatma (D+3) va eskalatsiya (D+7)', () => {
      const ids: Record<string, string> = {};

      beforeEach(async () => {
        await reset();
        // Tanlanadiganlar (market 37):
        ids.hq4 = await insertOrder({ last_handover_at: daysAgo(4) });
        // Filialda: custody 6 kun oldin, qabul hodisasi 5 kun oldin → 5 kun.
        ids.branch5 = await insertOrder({
          holder_type: 'BRANCH',
          holder_branch_id: '10',
          last_handover_at: daysAgo(6),
        });
        await received(ids.branch5, daysAgo(5));
        // 8 kun: eslatma ham, eskalatsiya ham.
        ids.hq8 = await insertOrder({ last_handover_at: daysAgo(8) });
        // Boshqa market (38) — alohida xabar.
        ids.m38 = await insertOrder({
          market_id: '38',
          last_handover_at: daysAgo(3.5),
        });

        // Tanlanmaydiganlar:
        // 2 kun — hali erta.
        ids.fresh = await insertOrder({ last_handover_at: daysAgo(2) });
        // Custody eski, lekin qabul hodisasi yangi (1 kun) — BG1 received_at = 1 kun.
        ids.reReceived = await insertOrder({ last_handover_at: daysAgo(9) });
        await received(ids.reReceived, daysAgo(1));
        // Kuryerda / yo'lda / marketga topshirilgan.
        ids.courier = await insertOrder({
          holder_type: 'COURIER',
          holder_courier_id: '26',
          last_handover_at: daysAgo(9),
        });
        ids.transit = await insertOrder({
          status: 'cancelled (sent)',
          last_handover_at: daysAgo(9),
        });
        ids.market = await insertOrder({
          status: 'returned_to_market',
          holder_type: 'MARKET',
          market_handover_at: daysAgo(1),
          last_handover_at: daysAgo(9),
        });
        // Ombor buyurtmasi — omborga qaytadi, marketga eslatma yo'q.
        ids.warehouse = await insertOrder({
          fulfillment_source: 'WAREHOUSE',
          last_handover_at: daysAgo(9),
        });
        // Qabulgacha bekor (post_id yo'q) — bosqich null.
        ids.preReceive = await insertOrder({
          post_id: null,
          last_handover_at: daysAgo(9),
        });
        // O'chirilgan.
        ids.deleted = await insertOrder({
          is_deleted: true,
          last_handover_at: daysAgo(9),
        });
        // Vaqt umuman yo'q — taxmin qilinmaydi.
        ids.noTime = await insertOrder({ last_handover_at: null });
      });

      it('BG1 bosqichi bilan mos: tanlanganlar — faqat hq/branch', async () => {
        const rows = await q(
          `SELECT "id"::text AS id, "status", "holder_type", "holder_courier_id",
                  "post_id", "canceled_post_id", "fulfillment_source", "market_handover_at"
             FROM "${ORDER}"."orders" WHERE "id" = ANY($1::bigint[])`,
          [[ids.hq4, ids.branch5, ids.courier, ids.transit, ids.market]],
        );
        const stage = new Map(
          rows.map((row) => [row.id, resolveCancelReturnStage(row)]),
        );
        expect(stage.get(ids.hq4)).toBe('hq');
        expect(stage.get(ids.branch5)).toBe('branch');
        expect(stage.get(ids.courier)).toBe('courier');
        expect(stage.get(ids.transit)).toBe('in_transit');
        expect(stage.get(ids.market)).toBe('market');
      });

      it('TC1: D+3 — market bo‘yicha BITTA outbox yozuvi (CANCEL guruhi), belgilar qo‘yiladi', async () => {
        const service = makeService();
        const res = await service.remindMarkets(REMIND_CUTOFF, NOW);
        expect(res).toEqual({
          locked: true,
          orders: 4,
          notifications: 2,
          hit_limit: false,
        });

        const events = await outboxRows();
        expect(events).toHaveLength(2);
        for (const event of events) {
          expect(event.target).toBe('NOTIFICATION');
          expect(event.pattern).toBe('notification.dispatch');
          expect(event.payload.type).toBe('order.cancel_return_reminder');
          expect(event.payload.telegram.group_type).toBe('cancel');
        }
        const m37 = events.find((e) => e.payload.telegram.market_id === '37');
        expect(m37.payload.recipient_ids).toEqual(['37']);
        expect(m37.payload.data.order_ids).toEqual(
          [ids.hq4, ids.branch5, ids.hq8].sort((a, b) => Number(a) - Number(b)),
        );
        expect(m37.payload.data.oldest_days).toBe(8);
        // Joy nomlari branch_schema'dan, HTML-escape bilan.
        expect(m37.payload.telegram.text).toContain(
          '• Toshkent &lt;HQ&gt; — 2 ta',
        );
        expect(m37.payload.telegram.text).toContain('• Urgut filiali — 1 ta');
        expect(m37.payload.telegram.text).toContain(
          '⏳ Qaytarishlaringiz markazda kutmoqda',
        );

        for (const id of [ids.hq4, ids.branch5, ids.hq8, ids.m38]) {
          expect((await flags(id)).handover_notified_at).toEqual(NOW);
        }
        for (const id of [
          ids.fresh,
          ids.reReceived,
          ids.courier,
          ids.transit,
          ids.market,
          ids.warehouse,
          ids.preReceive,
          ids.deleted,
          ids.noTime,
        ]) {
          expect((await flags(id)).handover_notified_at).toBeNull();
        }
        // Holat o'zgarmaydi.
        const [status] = await q(
          `SELECT "status"::text AS status, "holder_type"::text AS holder
             FROM "${ORDER}"."orders" WHERE "id" = $1`,
          [ids.hq4],
        );
        expect(status).toEqual({ status: 'cancelled', holder: 'HQ' });
      });

      it('TC2: idempotent — ikkinchi yugurish (qayta ishga tushish) hech narsa yubormaydi', async () => {
        const service = makeService();
        await service.remindMarkets(REMIND_CUTOFF, NOW);
        const again = await service.remindMarkets(
          REMIND_CUTOFF,
          new Date(NOW.getTime() + 2 * DAY),
        );
        expect(again).toEqual({
          locked: true,
          orders: 0,
          notifications: 0,
          hit_limit: false,
        });
        expect(await outboxRows()).toHaveLength(2);
      });

      it('TC3: ikki replika PARALLEL — har buyurtma bir marta, xabarlar takrorlanmaydi', async () => {
        const results = await Promise.all([
          makeService().remindMarkets(REMIND_CUTOFF, NOW),
          makeService().remindMarkets(REMIND_CUTOFF, NOW),
          makeService().remindMarkets(REMIND_CUTOFF, NOW),
        ]);
        expect(results.reduce((sum, r) => sum + r.orders, 0)).toBe(4);
        const events = await outboxRows();
        const ordered = events.flatMap((e) => e.payload.data.order_ids);
        expect(ordered.sort()).toEqual(
          [ids.hq4, ids.branch5, ids.hq8, ids.m38].sort(),
        );
        expect(new Set(ordered).size).toBe(ordered.length);
      });

      it('TC4: partiya chegarasi — qolgani keyingi yugurishda, takrorsiz', async () => {
        const service = makeService();
        const first = await service.remindMarkets(REMIND_CUTOFF, NOW, 2);
        expect(first).toEqual(
          expect.objectContaining({ orders: 2, hit_limit: true }),
        );
        const second = await service.remindMarkets(REMIND_CUTOFF, NOW, 2);
        expect(second).toEqual(
          expect.objectContaining({ orders: 2, hit_limit: true }),
        );
        const third = await service.remindMarkets(REMIND_CUTOFF, NOW, 2);
        expect(third).toEqual(
          expect.objectContaining({ orders: 0, hit_limit: false }),
        );
        const ordered = (await outboxRows()).flatMap(
          (e) => e.payload.data.order_ids,
        );
        expect(ordered).toHaveLength(4);
        expect(new Set(ordered).size).toBe(4);
      });

      it('TC5: outbox yozuvi yiqilsa — belgi ham qaytadi (rollback), keyin qayta urinadi', async () => {
        const broken = {
          enqueue: jest.fn().mockRejectedValue(new Error('outbox down')),
        } as unknown as OutboxService;
        await expect(
          makeService(broken).remindMarkets(REMIND_CUTOFF, NOW),
        ).rejects.toThrow('outbox down');
        expect((await flags(ids.hq4)).handover_notified_at).toBeNull();

        const res = await makeService().remindMarkets(REMIND_CUTOFF, NOW);
        expect(res.orders).toBe(4);
      });

      it('TC6: D+7 — faqat 7 kundan eskilar, buyurtma bo‘yicha admin navbatiga, idempotent', async () => {
        const service = makeService();
        const res = await service.escalateStale(ESCALATE_CUTOFF, NOW);
        expect(res).toEqual({
          locked: true,
          orders: 1,
          notifications: 1,
          hit_limit: false,
        });
        const [event] = await outboxRows();
        expect(event.payload).toEqual(
          expect.objectContaining({
            type: 'order.cancel_return_escalated',
            roles: ['admin', 'superadmin'],
            channels: ['in_app', 'realtime'],
            link: `/orders/edit/${ids.hq8}`,
          }),
        );
        expect(event.payload.body).toBe(
          `Buyurtma #EL-${Number(ids.hq8) + 100000} markazda 8 kundan beri turibdi — market olib ketmadi`,
        );
        expect(event.payload.telegram).toBeUndefined();
        expect((await flags(ids.hq8)).handover_escalated_at).toEqual(NOW);
        expect((await flags(ids.hq4)).handover_escalated_at).toBeNull();

        expect((await service.escalateStale(ESCALATE_CUTOFF, NOW)).orders).toBe(
          0,
        );
        expect(await outboxRows()).toHaveLength(1);
      });

      it('TC7: boshqa tranzaksiya qulfni ushlab tursa — qadam o‘tkazib yuboriladi', async () => {
        const runner = db.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
          await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
            'order:cancel_return:remind',
          ]);
          const res = await makeService().remindMarkets(REMIND_CUTOFF, NOW);
          expect(res).toEqual({
            locked: false,
            orders: 0,
            notifications: 0,
            hit_limit: false,
          });
        } finally {
          await runner.rollbackTransaction();
          await runner.release();
        }
        expect((await flags(ids.hq4)).handover_notified_at).toBeNull();
      });
    });
  },
);
