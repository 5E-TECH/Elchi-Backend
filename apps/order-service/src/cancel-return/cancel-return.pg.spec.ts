/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { OrderServiceService } from '../order-service.service';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import { CancelReturnMarketHandover1716000000154 } from '../../../../migrations/1716000000154-CancelReturnMarketHandover';
import {
  CANCEL_RETURN_STAGES,
  resolveCancelReturnStage,
} from './cancel-return';

/**
 * Bekor holatlari (BG1 5Yy6r6UI, BG2 fL79tFbs) — HAQIQIY Postgres'da:
 *   - migratsiya 154: ustunlar, CHECK, indeks, eski topshirishlar backfill'i
 *     (vaqt/xodim/usul tracking'dan, joy custody'dan; ombor qaytishi va hali
 *     topshirilmaganlar tegilmaydi), qayta yurgizish, down;
 *   - GET /orders yo'li (`findAllEnriched`): `return_stage` / `cancel_return`
 *     — joy nomi `branch_schema.branches` dan, qabul vaqti tracking'dan;
 *   - M0EPcJVf (BG3): bosqich SQL sharti JS qoidasi bilan bir xil qatorlarni
 *     tanlaydi (har bosqich), `market` sana oralig'i, boshqa market chiqmaydi,
 *     `stage` siz — eski HQ ro'yxati o'zgarmagan.
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

const ORDER = `crt_order_${process.pid}`;
const BRANCH = 'branch_schema';
const HQ_ID = '1';

(localTestDatabase ? describe : describe.skip)(
  'Bekor holatlari — haqiqiy Postgres (pg)',
  () => {
    let db: DataSource;
    let service: OrderServiceService;
    const migration = new CancelReturnMarketHandover1716000000154(
      ORDER,
      BRANCH,
    );

    const q = async (sql: string, params?: unknown[]): Promise<Row[]> => {
      const rows: Row[] = await db.query(sql, params);
      return rows;
    };

    const insertOrder = async (values: Row): Promise<string> => {
      const row = {
        market_id: '16',
        customer_id: '500',
        status: 'cancelled',
        holder_type: 'HQ',
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

    const track = (orderId: string, values: Row) => {
      const row = {
        order_id: orderId,
        changed_by: '9',
        changed_by_role: 'admin',
        ...values,
      };
      const keys = Object.keys(row);
      return q(
        `INSERT INTO "${ORDER}"."order_tracking" (${keys.map((k) => `"${k}"`).join(', ')})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        keys.map((k) =>
          k === 'metadata' && row[k] ? JSON.stringify(row[k]) : row[k],
        ),
      );
    };

    const custody = (orderId: string, values: Row) => {
      const row = {
        order_id: orderId,
        to_holder_type: 'MARKET',
        changed_by: '9',
        changed_by_role: 'admin',
        ...values,
      };
      const keys = Object.keys(row);
      return q(
        `INSERT INTO "${ORDER}"."order_custody_events" (${keys.map((k) => `"${k}"`).join(', ')})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        keys.map((k) => row[k]),
      );
    };

    const handover = async (id: string) => {
      const [row] = await q(
        `SELECT "market_handover_at", "market_handover_by"::text AS "by",
                "market_handover_method" AS "method",
                "market_handover_branch_id"::text AS "branch_id"
           FROM "${ORDER}"."orders" WHERE "id" = $1`,
        [id],
      );
      return row;
    };

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: ORDER,
        entities: [Order, OrderItem, OrderTracking, OrderCustodyEvent, Branch],
        synchronize: false,
      });
      await db.initialize();
      await db.query(`CREATE SCHEMA IF NOT EXISTS "${ORDER}"`);
      await db.query(`CREATE SCHEMA IF NOT EXISTS "${BRANCH}"`);
      // enrichOrders pochta kuryerini shu jadvaldan o'qiydi (bu yerda bo'sh).
      await db.query(`CREATE SCHEMA IF NOT EXISTS "logistics_schema"`);
      await db.query(
        `CREATE TABLE IF NOT EXISTS "logistics_schema"."posts" ("id" bigint PRIMARY KEY, "courier_id" bigint)`,
      );
      await db.synchronize();
      // order-service `Branch` faqat `name` ni biladi — HQ qidiruvi `type` ni ham o'qiydi.
      await db.query(
        `ALTER TABLE "${BRANCH}"."branches" ADD COLUMN IF NOT EXISTS "type" varchar NOT NULL DEFAULT 'REGIONAL'`,
      );
      await db.query(`DELETE FROM "${BRANCH}"."branches"`);
      await db.query(
        `INSERT INTO "${BRANCH}"."branches" ("id", "name", "type") VALUES
           (${HQ_ID}, 'Toshkent HQ', 'HQ'), (10, 'Urgut filiali', 'REGIONAL'),
           (12, 'Andijon filiali', 'REGIONAL')`,
      );
      const rmq = { send: jest.fn(() => of({ data: [] })) };
      const none = {} as never;
      service = new OrderServiceService(
        db,
        db.getRepository(Order),
        db.getRepository(OrderItem),
        db.getRepository(OrderTracking),
        db.getRepository(OrderCustodyEvent),
        none,
        none,
        none,
        none,
        none,
        rmq as never, // identity
        rmq as never, // logistics
        rmq as never, // catalog
        none,
        none,
        none,
        none,
        none,
        none,
        { getHqBranchId: () => Promise.resolve(HQ_ID) } as never, // lookup
        none,
      );
    });

    afterAll(async () => {
      if (!db?.isInitialized) return;
      await db.query(`DROP SCHEMA IF EXISTS "${ORDER}" CASCADE`);
      await db.query(`DROP SCHEMA IF EXISTS "${BRANCH}" CASCADE`);
      await db.query(`DROP SCHEMA IF EXISTS "logistics_schema" CASCADE`);
      await db.destroy();
    });

    describe('migratsiya 154 (fL79tFbs)', () => {
      const ids: Record<string, string> = {};

      beforeAll(async () => {
        // Eski holat: ustunlarsiz jadval, tarixda topshirishlar bor.
        await migration.down(db.createQueryRunner());
        const t0 = Date.parse('2026-10-10T08:00:00Z');
        const at = (minutes: number) => new Date(t0 + minutes * 60_000);

        // A — HQ'dan QR bilan (bulk complete izohi).
        ids.qr = await insertOrder({
          status: 'returned_to_market',
          holder_type: 'MARKET',
        });
        await track(ids.qr, {
          from_status: 'cancelled (sent)',
          to_status: 'cancelled',
          created_at: at(0),
        });
        await track(ids.qr, {
          from_status: 'cancelled',
          to_status: 'returned_to_market',
          note: 'Bekor qilingan order market 16ga QR tasdiqi bilan topshirildi',
          created_at: at(30),
        });
        await custody(ids.qr, { from_holder_type: 'HQ', created_at: at(30) });

        // B — qo'lda tasdiq, filial 12 qo'lidan.
        ids.manual = await insertOrder({
          status: 'returned_to_market',
          holder_type: 'MARKET',
        });
        await track(ids.manual, {
          from_status: 'cancelled',
          to_status: 'returned_to_market',
          action: 'cancelled_market_handover_manual',
          metadata: { manual_override: true, manual_reason: 'QR yirtilgan' },
          changed_by: '31',
          created_at: at(40),
        });
        await custody(ids.manual, {
          from_holder_type: 'BRANCH',
          from_branch_id: '12',
          created_at: at(40),
        });

        // C — F4 dan oldingi: CLOSED + MARKET, QR talab qilinmasdan.
        ids.noQr = await insertOrder({
          status: 'closed',
          holder_type: 'MARKET',
        });
        await track(ids.noQr, {
          from_status: 'cancelled',
          to_status: 'closed',
          note: 'Bekor qilingan order market 16ga QR talab qilinmasdan topshirildi',
          changed_by: 'partner:1',
          created_at: at(50),
        });

        // D — eski mark-returned-to-market izohi (usul noma'lum), kuryer qo'lidan.
        ids.legacy = await insertOrder({
          status: 'returned_to_market',
          holder_type: 'MARKET',
        });
        await track(ids.legacy, {
          from_status: 'received',
          to_status: 'returned_to_market',
          note: 'Xodim 9 market egasiga topshirdi',
          created_at: at(60),
        });
        await custody(ids.legacy, {
          from_holder_type: 'COURIER',
          from_branch_id: '10',
          from_courier_id: '26',
          created_at: at(60),
        });

        // E — ombor qaytishi (marketga topshirish EMAS).
        ids.warehouse = await insertOrder({
          status: 'returned_to_market',
          holder_type: 'MARKET',
          fulfillment_source: 'WAREHOUSE',
          warehouse_id: '5',
        });
        await track(ids.warehouse, {
          from_status: 'cancelled',
          to_status: 'returned_to_market',
          action: 'warehouse_returned',
          created_at: at(70),
        });

        // F — hali HQ'da (topshirilmagan).
        ids.atHq = await insertOrder({
          status: 'cancelled',
          holder_type: 'HQ',
          post_id: '41',
        });
        await track(ids.atHq, {
          from_status: 'cancelled (sent)',
          to_status: 'cancelled',
          action: 'cancelled_post_received',
          created_at: at(80),
        });
      });

      it('up: eski topshirishlar to`ldiriladi — vaqt, xodim, usul (aniq bo`lsa), joy', async () => {
        await migration.up(db.createQueryRunner());

        const qr = await handover(ids.qr);
        expect(new Date(qr.market_handover_at).toISOString()).toBe(
          '2026-10-10T08:30:00.000Z',
        );
        expect(qr).toEqual(
          expect.objectContaining({ by: '9', method: 'qr', branch_id: HQ_ID }),
        );

        expect(await handover(ids.manual)).toEqual(
          expect.objectContaining({
            by: '31',
            method: 'manual',
            branch_id: '12',
          }),
        );
        // `partner:1` — raqam emas → xodim NULL; custody yo'q → joy NULL.
        expect(await handover(ids.noQr)).toEqual(
          expect.objectContaining({
            by: null,
            method: 'no_qr',
            branch_id: null,
          }),
        );
        expect((await handover(ids.noQr)).market_handover_at).not.toBeNull();
        // Usul noma'lum — taxmin qilinmaydi.
        expect(await handover(ids.legacy)).toEqual(
          expect.objectContaining({ by: '9', method: null, branch_id: '10' }),
        );
        for (const untouched of [ids.warehouse, ids.atHq]) {
          expect(await handover(untouched)).toEqual({
            market_handover_at: null,
            by: null,
            method: null,
            branch_id: null,
          });
        }
      });

      it('up qayta yurgizilsa xato yo`q va yangi topshirish ustidan yozilmaydi', async () => {
        await q(
          `UPDATE "${ORDER}"."orders"
              SET "market_handover_at" = '2026-10-20T10:00:00Z',
                  "market_handover_method" = 'manual'
            WHERE "id" = $1`,
          [ids.qr],
        );
        await migration.up(db.createQueryRunner());
        const qr = await handover(ids.qr);
        expect(new Date(qr.market_handover_at).toISOString()).toBe(
          '2026-10-20T10:00:00.000Z',
        );
        expect(qr.method).toBe('manual');
      });

      it('CHECK: noma`lum usul rad etiladi, indeks bor', async () => {
        await expect(
          q(
            `UPDATE "${ORDER}"."orders" SET "market_handover_method" = 'sms' WHERE "id" = $1`,
            [ids.qr],
          ),
        ).rejects.toThrow(/CHK_orders_market_handover_method/);
        const [index] = await q(
          `SELECT indexdef FROM pg_indexes
            WHERE schemaname = $1 AND indexname = 'IDX_orders_market_handover'`,
          [ORDER],
        );
        expect(index.indexdef).toMatch(/market_id, market_handover_at/);
        expect(index.indexdef).toMatch(
          /WHERE \(market_handover_at IS NOT NULL\)/,
        );
      });

      it('down: ustunlar va cheklov olib tashlanadi, up qayta ishlaydi', async () => {
        await migration.down(db.createQueryRunner());
        const columns = await q(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'orders'
              AND column_name LIKE 'market_handover%'`,
          [ORDER],
        );
        expect(columns).toEqual([]);
        await migration.up(db.createQueryRunner());
        expect((await handover(ids.manual)).method).toBe('manual');
      });
    });

    describe('GET /orders boyitishi (5Yy6r6UI)', () => {
      const MARKET = '777';
      const ids: Record<string, string> = {};
      const at = (iso: string) => new Date(iso);

      beforeAll(async () => {
        ids.hq = await insertOrder({
          market_id: MARKET,
          status: 'cancelled',
          holder_type: 'HQ',
          post_id: '41',
          branch_id: HQ_ID,
          last_handover_at: at('2026-10-21T10:00:00Z'),
        });
        await track(ids.hq, {
          from_status: 'cancelled (sent)',
          to_status: 'cancelled',
          action: 'cancelled_post_received',
          created_at: at('2026-10-15T08:00:00Z'),
        });
        await track(ids.hq, {
          from_status: 'cancelled (sent)',
          to_status: 'cancelled',
          action: 'cancelled_post_received',
          created_at: at('2026-10-22T06:30:00Z'),
        });
        ids.branch = await insertOrder({
          market_id: MARKET,
          status: 'cancelled',
          holder_type: 'BRANCH',
          holder_branch_id: '12',
          post_id: '41',
          branch_id: '12',
          last_handover_at: at('2026-10-23T08:00:00Z'),
        });
        ids.market = await insertOrder({
          market_id: MARKET,
          status: 'returned_to_market',
          holder_type: 'MARKET',
          branch_id: '12',
          market_handover_at: at('2026-10-24T12:00:00Z'),
          market_handover_method: 'qr',
          market_handover_branch_id: HQ_ID,
        });
        ids.preDelivery = await insertOrder({
          market_id: MARKET,
          status: 'cancelled',
          holder_type: 'HQ',
        });
      });

      it('ro`yxat qatorlarida bosqich, joy nomi va vaqtlar', async () => {
        const result = await service.findAllEnriched({
          market_id: MARKET,
          disable_pagination: true,
        });
        const byId = new Map<string, Row>(
          (result.data as Row[]).map((row) => [String(row.id), row]),
        );

        expect(byId.get(ids.hq)).toEqual(
          expect.objectContaining({
            return_stage: 'hq',
            cancel_return: expect.objectContaining({
              place_type: 'HQ',
              place_id: HQ_ID,
              place_name: 'Toshkent HQ',
              received_at: '2026-10-22T06:30:00.000Z',
            }),
          }),
        );
        expect(byId.get(ids.branch)?.cancel_return).toEqual(
          expect.objectContaining({
            stage: 'branch',
            place_name: 'Andijon filiali',
            received_at: '2026-10-23T08:00:00.000Z',
          }),
        );
        expect(byId.get(ids.market)?.cancel_return).toEqual(
          expect.objectContaining({
            stage: 'market',
            place_type: 'HQ',
            place_name: 'Toshkent HQ',
            handed_over_at: '2026-10-24T12:00:00.000Z',
            handover_method: 'qr',
          }),
        );
        expect(byId.get(ids.preDelivery)).toEqual(
          expect.objectContaining({ return_stage: null, cancel_return: null }),
        );
      });
    });

    describe('market bekorlari bosqich bo`yicha (M0EPcJVf)', () => {
      const MARKET = '888';
      const ids: Record<string, string> = {};
      const at = (iso: string) => new Date(iso);

      beforeAll(async () => {
        const rows: Record<string, Row> = {
          courier: {
            status: 'cancelled',
            holder_type: 'COURIER',
            holder_courier_id: '26',
            post_id: '41',
          },
          transitHq: {
            status: 'cancelled (sent)',
            holder_type: 'HQ',
            canceled_post_id: '5',
            branch_id: HQ_ID,
          },
          transitBranch: {
            status: 'cancelled (sent)',
            holder_type: 'BRANCH',
            holder_branch_id: '12',
            canceled_post_id: '6',
          },
          branch: {
            status: 'cancelled',
            holder_type: 'BRANCH',
            holder_branch_id: '12',
            post_id: '41',
          },
          branchInPost: {
            status: 'cancelled',
            holder_type: 'BRANCH',
            holder_branch_id: '12',
            post_id: '41',
            canceled_post_id: '6',
          },
          hq: { status: 'cancelled', holder_type: 'HQ', post_id: '41' },
          hqByCancelledPost: {
            status: 'cancelled',
            holder_type: 'HQ',
            canceled_post_id: '5',
          },
          preDelivery: { status: 'cancelled', holder_type: 'HQ' },
          marketOct10: {
            status: 'returned_to_market',
            holder_type: 'MARKET',
            market_handover_at: at('2026-10-10T12:00:00Z'),
          },
          marketOct20: {
            status: 'returned_to_market',
            holder_type: 'MARKET',
            market_handover_at: at('2026-10-20T12:00:00Z'),
          },
          legacyClosed: {
            status: 'closed',
            holder_type: 'MARKET',
            last_handover_at: at('2026-10-05T09:00:00Z'),
          },
          cancelledMarket: { status: 'cancelled', holder_type: 'MARKET' },
          sold: { status: 'sold', holder_type: 'COURIER' },
        };
        for (const [key, values] of Object.entries(rows)) {
          ids[key] = await insertOrder({ market_id: MARKET, ...values });
        }
        // Boshqa market — hech qaysi bosqichda chiqmasligi kerak.
        ids.otherMarket = await insertOrder({
          market_id: '999',
          status: 'cancelled',
          holder_type: 'HQ',
          post_id: '41',
        });
      });

      const fetchIds = async (options: Record<string, unknown>) => {
        const result: Row = await service.findCancelledByMarketEnriched(
          MARKET,
          options,
        );
        return (result.data as Row[]).map((row) => String(row.id)).sort();
      };

      it.each(CANCEL_RETURN_STAGES.map((stage) => [stage]))(
        '%s: SQL sharti JS qoidasi bilan bir xil qatorlar',
        async (stage) => {
          const all = await db
            .getRepository(Order)
            .find({ where: { market_id: MARKET } });
          const expected = all
            .filter((row) => resolveCancelReturnStage(row) === stage)
            .map((row) => String(row.id))
            .sort();
          expect(expected.length).toBeGreaterThan(0);
          const result: Row = await service.findCancelledByMarketEnriched(
            MARKET,
            { stages: [stage] },
          );
          expect(
            (result.data as Row[]).map((row) => String(row.id)).sort(),
          ).toEqual(expected);
          for (const row of result.data as Row[]) {
            expect(row.return_stage).toBe(stage);
          }
        },
      );

      it('kutilgan to`plamlar (aniq): yo`lda, HQ, topshirilgan', async () => {
        expect(await fetchIds({ stages: ['in_transit'] })).toEqual(
          [ids.transitHq, ids.transitBranch].sort(),
        );
        expect(await fetchIds({ stages: ['hq'] })).toEqual(
          [ids.hq, ids.hqByCancelledPost].sort(),
        );
        expect(await fetchIds({ stages: ['market'] })).toEqual(
          [
            ids.marketOct10,
            ids.marketOct20,
            ids.legacyClosed,
            ids.cancelledMarket,
          ].sort(),
        );
      });

      it('sana oralig`i faqat `market` bosqichiga (topshirish vaqti, eski — custody vaqti)', async () => {
        expect(
          await fetchIds({
            stages: ['market'],
            start_day: '2026-10-09',
            end_day: '2026-10-15',
          }),
        ).toEqual([ids.marketOct10]);
        expect(
          await fetchIds({
            stages: ['market'],
            start_day: '2026-10-01',
            end_day: '2026-10-06',
          }),
        ).toEqual([ids.legacyClosed]);
        // HQ bosqichi sanaga bog'liq emas.
        expect(
          await fetchIds({
            stages: ['hq', 'market'],
            start_day: '2026-10-19',
          }),
        ).toEqual([ids.hq, ids.hqByCancelledPost, ids.marketOct20].sort());
      });

      it('`stage` siz — eski topshirish ro`yxati (HQ, pochtaga biriktirilmagan) o`zgarmagan', async () => {
        expect(await fetchIds({ holder_type: 'HQ' })).toEqual(
          [ids.hq, ids.preDelivery].sort(),
        );
      });

      it('noma`lum bosqich va noto`g`ri sana — 400', async () => {
        await expect(
          service.findCancelledByMarketEnriched(MARKET, {
            stages: ['yolda' as never],
          }),
        ).rejects.toMatchObject({ error: { statusCode: 400 } });
        await expect(
          service.findCancelledByMarketEnriched(MARKET, {
            stages: ['market'],
            start_day: '2026-13-45',
          }),
        ).rejects.toMatchObject({ error: { statusCode: 400 } });
      });
    });
  },
);
