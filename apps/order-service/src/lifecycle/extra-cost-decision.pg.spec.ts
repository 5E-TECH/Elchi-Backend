import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { DataSource, QueryFailedError } from 'typeorm';
import { Order_status } from '@app/common';
import { CreateOrderExtraCostApprovals1716000000026 } from '../../../../migrations/1716000000026-CreateOrderExtraCostApprovals';
import { ExtraCostAutoApprove1716000000123 } from '../../../../migrations/1716000000123-ExtraCostAutoApprove';
import { ExtraCostApprovalVoidReversed1716000000206 } from '../../../../migrations/1716000000206-ExtraCostApprovalVoidReversed';
import { ExtraCostAutoApproveFrom1716000000208 } from '../../../../migrations/1716000000208-ExtraCostAutoApproveFrom';
import { Branch } from '../entities/branch.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import {
  EXTRA_COST_PENDING_UNIQUE_INDEX,
  OrderExtraCostApproval,
} from '../entities/order-extra-cost-approval.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { Order } from '../entities/order.entity';
import {
  ExtraCostExecutionOptions,
  OrderLifecycleService,
} from './order-lifecycle.service';

/**
 * 1tnpaIqd + hwTkXsGi + AFZaUUi5 — atomik qaror HAQIQIY Postgres'da (faqat
 * lokal test bazasi): migratsiya 026 + 123 + 206 + 208.
 *
 *  - ikki parallel approve / approve+reject — faqat bittasi o'tadi, sotuv
 *    bir marta;
 *  - «tasdiqlandi» (claim) sotuv bilan BITTA tranzaksiyada: sotuv yiqilsa
 *    claim ham qaytadi (real ROLLBACK);
 *  - darvoza `order_tracking` dan (so'rovdan keyin holat o'zgargan) — void;
 *  - void / reversed SQL'i, partial unique indeks (23505);
 *  - avtomatik tasdiq skanerining SQL'i: `auto_approve_from` dan sanash,
 *    `auto_retry_at` kechiktirish, eslatma.
 *
 * Qayta ijro (`sellOrder`) soxta, lekin uning tranzaksiyasi HAQIQIY:
 * haqiqiy `applyExtraCostApprovalsOnExecution` + (soxta) pul, so'ng COMMIT.
 *
 *   BOT_PG_TEST_URI=postgres://postgres@127.0.0.1:55443/elchi_bot_test npx jest extra-cost-decision.pg
 * (spec yonma-yon `elchi_extra_cost_test` bazasini yaratadi.)
 */
const uri = process.env.BOT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return ['127.0.0.1', 'localhost'].includes(url.hostname);
})();
const DB = 'elchi_extra_cost_test';

type ApprovalRow = {
  status: string;
  auto_approved: boolean;
  decided_at: Date | null;
  closed_reason: string | null;
  closed_at: Date | null;
  closed_by_user_id: string | null;
};

(localTestDatabase ? describe : describe.skip)(
  'extra-cost qarori — lokal Postgres (1tnpaIqd + hwTkXsGi + AFZaUUi5)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      const exists: unknown[] = await admin.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [DB],
      );
      if (!exists.length) await admin.query(`CREATE DATABASE ${DB}`);
      await admin.destroy();
      const url = new URL(uri!);
      url.pathname = `/${DB}`;
      db = new DataSource({
        type: 'postgres',
        url: url.toString(),
        schema: 'order_schema',
        // Darvoza so'rovi OrderTracking ↔ OrderExtraCostApproval join'i —
        // metadata uchun bog'liq entity'lar (jadval yaratilmaydi).
        entities: [
          OrderExtraCostApproval,
          OrderTracking,
          Order,
          OrderItem,
          OrderCustodyEvent,
          Branch,
        ],
        extra: { max: 10 },
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS order_schema CASCADE');
      await db.query('CREATE SCHEMA order_schema');
      const statuses = Object.values(Order_status)
        .map((status) => `'${status}'`)
        .join(', ');
      await db.query(
        `CREATE TYPE order_schema.orders_status_enum AS ENUM (${statuses})`,
      );
      // Prod'dagi ustun turlari (enum) bilan, faqat migratsiya 206 va
      // darvoza o'qiydigan ustunlar.
      await db.query(`
        CREATE TABLE order_schema.orders (
          id bigint PRIMARY KEY,
          status order_schema.orders_status_enum NOT NULL DEFAULT 'waiting',
          is_deleted boolean NOT NULL DEFAULT false
        )`);
      await db.query(`
        CREATE TABLE order_schema.order_tracking (
          id bigserial PRIMARY KEY,
          order_id bigint NOT NULL,
          from_status order_schema.orders_status_enum,
          to_status order_schema.orders_status_enum NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )`);
      const runner = db.createQueryRunner();
      try {
        await new CreateOrderExtraCostApprovals1716000000026().up(runner);
        await new ExtraCostAutoApprove1716000000123().up(runner);
        await new ExtraCostAutoApprove1716000000123().up(runner);
        await new ExtraCostApprovalVoidReversed1716000000206().up(runner);
        await new ExtraCostAutoApproveFrom1716000000208().up(runner);
      } finally {
        await runner.release();
      }
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS order_schema CASCADE');
        await db.destroy();
      }
      jest.restoreAllMocks();
    });

    let nextOrder = 7000;
    const insert = async (
      overrides: { orderId?: number; status?: string } = {},
    ) => {
      const orderId = overrides.orderId ?? ++nextOrder;
      const [row]: Array<{ id: string }> = await db.query(
        `INSERT INTO order_schema.order_extra_cost_approvals
           (order_id, market_id, requested_by_user_id, requested_by_role, action, amount, operation_payload, status)
         VALUES ($1, 501, 301, 'courier', 'sell', 12000, '{}'::jsonb, $2)
         RETURNING id`,
        [orderId, overrides.status ?? 'pending'],
      );
      return { id: String(row.id), orderId: String(orderId) };
    };

    const read = async (id: string): Promise<ApprovalRow> => {
      const [row]: ApprovalRow[] = await db.query(
        `SELECT status, auto_approved, decided_at, closed_reason, closed_at,
                closed_by_user_id::text AS closed_by_user_id
           FROM order_schema.order_extra_cost_approvals WHERE id = $1`,
        [id],
      );
      return row;
    };

    type Private = {
      applyExtraCostApprovalsOnExecution: (...args: unknown[]) => Promise<void>;
      closeExtraCostApprovalsOnRollback: (...args: unknown[]) => Promise<void>;
      isUniqueViolation: (error: unknown, constraint: string) => boolean;
    };

    /** `failure` — claim'dan keyin, pul yozilayotganda chiqadigan xato. */
    const makeService = (failure?: Error) => {
      const svc = Object.create(
        OrderLifecycleService.prototype,
      ) as OrderLifecycleService;
      Object.assign(svc, {
        extraCostApprovalRepo: db.getRepository(OrderExtraCostApproval),
        orderRepo: {
          findOne: jest.fn().mockResolvedValue({
            id: '0',
            status: Order_status.WAITING,
            isDeleted: false,
          }),
        },
        dataSource: db,
        outbox: { enqueue: jest.fn() },
        activityLog: { log: jest.fn().mockResolvedValue(undefined) },
        logger: { warn: jest.fn(), log: jest.fn() },
      });
      const executed: string[] = [];
      const sellOrder = jest
        .spyOn(svc, 'sellOrder')
        .mockImplementation(
          async (
            actor: { id: string },
            orderId: string,
            _payload: unknown,
            _requestId?: string,
            options?: ExtraCostExecutionOptions,
          ) => {
            const runner = db.createQueryRunner();
            await runner.connect();
            await runner.startTransaction();
            try {
              await (
                svc as unknown as Private
              ).applyExtraCostApprovalsOnExecution(
                runner.manager,
                orderId,
                actor,
                options,
              );
              // Pul yozuvlari vaqti — parallel claim'lar shu payt kutadi.
              await new Promise((resolve) => setTimeout(resolve, 50));
              if (failure) throw failure;
              executed.push(orderId);
              await runner.commitTransaction();
              return { statusCode: 200 } as never;
            } catch (error) {
              await runner.rollbackTransaction();
              throw error;
            } finally {
              await runner.release();
            }
          },
        );
      return {
        svc,
        /** Tranzaksiya ichidagi yordamchilar (private). */
        helpers: svc as unknown as Private,
        sellOrder,
        executed,
      };
    };

    const market = { id: '501', roles: ['market'] };
    const errorOf = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: unknown) => (error as RpcException).getError(),
      );

    it('⭐ uch parallel approve — bittasi o‘tadi, sotuv BIR marta, qolgani 409 (real UPDATE … WHERE status=pending, bitta tranzaksiyada)', async () => {
      const { id } = await insert();
      const { svc, executed } = makeService();
      const results = await Promise.allSettled([
        svc.approveExtraCostApproval(market, id),
        svc.approveExtraCostApproval(market, id),
        svc.approveExtraCostApproval(market, id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results.filter((r) => r.status === 'rejected')) {
        expect((result.reason as RpcException).getError()).toEqual({
          statusCode: 409,
          message: "Bu so'rov allaqachon yakunlangan",
        });
      }
      expect(executed).toHaveLength(1);
      expect(await read(id)).toMatchObject({
        status: 'approved',
        auto_approved: false,
        decided_at: expect.any(Date),
        closed_reason: null,
      });
    });

    it('⭐ approve + reject bir vaqtda — faqat bittasi, holat aralashmaydi', async () => {
      const { id } = await insert();
      const { svc, executed } = makeService();
      const results = await Promise.allSettled([
        svc.rejectExtraCostApproval(market, id, { reason: 'DUPLICATE' }),
        svc.approveExtraCostApproval(market, id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const row = await read(id);
      expect(['approved', 'rejected']).toContain(row.status);
      expect(executed).toHaveLength(row.status === 'approved' ? 1 : 0);
    });

    it('⭐ TC8: sotuv tranzaksiyasi claim’dan keyin yiqilsa (infra) — real ROLLBACK, so‘rov pending, qaror yozilmagan', async () => {
      const { id } = await insert();
      const timeout = new Error('RMQ timeout');
      const { svc } = makeService(timeout);
      await expect(svc.approveExtraCostApproval(market, id)).rejects.toBe(
        timeout,
      );
      expect(await read(id)).toMatchObject({
        status: 'pending',
        decided_at: null,
        closed_reason: null,
      });
    });

    it('⭐ qayta ijro biznes xatosi — so‘rov void (sabab, vaqt, kim), 409', async () => {
      const { id } = await insert();
      const { svc } = makeService(
        new RpcException({ statusCode: 400, message: 'Kuryer bloklangan' }),
      );
      expect(await errorOf(svc.approveExtraCostApproval(market, id))).toEqual({
        statusCode: 409,
        message:
          "Bu so'rov allaqachon yakunlangan — amalni bajarib bo'lmadi: Kuryer bloklangan",
      });
      expect(await read(id)).toMatchObject({
        status: 'void',
        decided_at: null,
        closed_reason: "amalni bajarib bo'lmadi: Kuryer bloklangan",
        closed_at: expect.any(Date),
        closed_by_user_id: '501',
      });
    });

    it('⭐ TC6 darvoza: so‘rovdan keyin buyurtma sotilib qaytarilgan (order_tracking) — void + 409, sotuv yo‘q', async () => {
      const { id, orderId } = await insert();
      // So'rovdan keyin: sotildi, keyin orqaga qaytarildi — buyurtma yana WAITING.
      await db.query(
        `INSERT INTO order_schema.order_tracking (order_id, from_status, to_status, created_at)
         VALUES ($1, 'waiting', 'sold', now() + interval '1 second'),
                ($1, 'sold', 'waiting', now() + interval '2 second'),
                ($1, 'waiting', 'waiting', now() + interval '3 second')`,
        [orderId],
      );
      // Boshqa buyurtmaning tarixi hisobga olinmaydi.
      const other = await insert();
      await db.query(
        `INSERT INTO order_schema.order_tracking (order_id, from_status, to_status, created_at)
         VALUES ($1, 'waiting', 'sold', now() + interval '1 second')`,
        [Number(other.orderId) + 1000],
      );
      const { svc, executed } = makeService();

      expect(await errorOf(svc.approveExtraCostApproval(market, id))).toEqual({
        statusCode: 409,
        message:
          "Bu so'rov allaqachon yakunlangan — so'rov ochilgandan keyin buyurtma holati o'zgargan (sold)",
      });
      expect(await read(id)).toMatchObject({ status: 'void' });

      // Faqat from = to yozuvi (masalan pochta o'zgarishi) — darvoza o'tadi.
      const sameStatus = await insert();
      await db.query(
        `INSERT INTO order_schema.order_tracking (order_id, from_status, to_status, created_at)
         VALUES ($1, 'waiting', 'waiting', now() + interval '1 second')`,
        [sameStatus.orderId],
      );
      await svc.approveExtraCostApproval(market, sameStatus.id);
      expect(await read(sameStatus.id)).toMatchObject({ status: 'approved' });
      expect(executed).toEqual([sameStatus.orderId]);
    });

    it('⭐ TC1 haqiqiy amal: ochiq so‘rov void (real UPDATE … RETURNING), hamkor amali — yopuvchi NULL', async () => {
      const own = await insert();
      const partner = await insert();
      const { helpers } = makeService();

      await helpers.applyExtraCostApprovalsOnExecution(
        db.manager,
        own.orderId,
        {
          id: '289',
        },
      );
      await helpers.applyExtraCostApprovalsOnExecution(
        db.manager,
        partner.orderId,
        { id: 'partner:4' },
      );

      expect(await read(own.id)).toMatchObject({
        status: 'void',
        closed_reason:
          "Buyurtma boshqa so'rov bilan yakunlandi — eski so'rov yopildi",
        closed_at: expect.any(Date),
        closed_by_user_id: '289',
      });
      expect(await read(partner.id)).toMatchObject({
        status: 'void',
        closed_by_user_id: null,
      });
    });

    it('⭐ TC6/TC7 orqaga qaytarish: pending → void, approved → reversed', async () => {
      const approved = await insert({ status: 'approved' });
      const pending = await insert({ orderId: Number(approved.orderId) });
      const { helpers } = makeService();

      await helpers.closeExtraCostApprovalsOnRollback(
        db.manager,
        approved.orderId,
        { id: '1' },
      );

      expect(await read(pending.id)).toMatchObject({
        status: 'void',
        closed_reason: 'Buyurtma orqaga qaytarildi',
      });
      expect(await read(approved.id)).toMatchObject({
        status: 'reversed',
        closed_reason:
          'Buyurtma orqaga qaytarildi — tasdiqlangan xarajat teskari yozildi',
        closed_by_user_id: '1',
      });
    });

    it('⭐ TC9: bitta buyurtmada ikkinchi ochiq so‘rov — 23505 partial unique indeksda (tanib olinadi)', async () => {
      const first = await insert();
      const error = await insert({ orderId: Number(first.orderId) }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(QueryFailedError);
      const { helpers } = makeService();
      expect(
        helpers.isUniqueViolation(error, EXTRA_COST_PENDING_UNIQUE_INDEX),
      ).toBe(true);
      // Yopilgan (void) yonida yangi ochiq so'rov — mumkin.
      await db.query(
        `UPDATE order_schema.order_extra_cost_approvals SET status = 'void' WHERE id = $1`,
        [first.id],
      );
      await expect(
        insert({ orderId: Number(first.orderId) }),
      ).resolves.toBeDefined();
    });

    describe('AFZaUUi5 — avtomatik tasdiq skaneri (haqiqiy SQL)', () => {
      type AutoRow = {
        status: string;
        auto_approved: boolean;
        auto_approve_from: Date | null;
        reminder_sent_at: Date | null;
        auto_attempts: number;
        auto_retry_at: Date | null;
      };
      const H = 60 * 60_000;
      const now = new Date();
      const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
      const run = (svc: OrderLifecycleService, when = now, limit?: number) =>
        svc.runExtraCostAutoApproval({
          minutes: 1440,
          reminderMinutes: 10,
          now: when,
          limit,
        });
      /** Muddatdan 10 daqiqa oldin (skaner eslatmani shu paytda yuboradi). */
      const remindedFor = (createdAt: Date) =>
        new Date(createdAt.getTime() + 24 * H - 10 * 60_000);
      /** So'rov vaqti / muddat boshi / eslatma / keyingi urinish — SQL bilan. */
      const seed = async (row: {
        createdAt: Date;
        /** `null` — skaner hali belgilamagan. */
        from?: Date | null;
        remindedAt?: Date | null;
        retryAt?: Date;
        status?: string;
        isDeleted?: boolean;
      }) => {
        const saved = await insert({ status: row.status });
        await db.query(
          `UPDATE order_schema.order_extra_cost_approvals
              SET "createdAt" = $2, auto_approve_from = $3, auto_retry_at = $4, is_deleted = $5,
                  reminder_sent_at = $6
            WHERE id = $1`,
          [
            saved.id,
            row.createdAt,
            'from' in row ? row.from : row.createdAt,
            row.retryAt ?? null,
            row.isDeleted ?? false,
            row.remindedAt ?? null,
          ],
        );
        return saved;
      };
      const readAuto = async (id: string): Promise<AutoRow> => {
        const [row]: AutoRow[] = await db.query(
          `SELECT status, auto_approved, auto_approve_from, reminder_sent_at, auto_attempts, auto_retry_at
             FROM order_schema.order_extra_cost_approvals WHERE id = $1`,
          [id],
        );
        return row;
      };
      /** Oldingi testlar qoldirgan ochiq so'rovlar skanerga aralashmasin. */
      beforeEach(async () => {
        await db.query(
          `UPDATE order_schema.order_extra_cost_approvals SET status = 'void'
            WHERE status = 'pending'`,
        );
      });

      it('⭐ TC1/TC3/TC5/TC6: 24 soat o‘tgani tasdiqlanadi; yoqilgan paytdan sanalayotgan eski so‘rov, yopilgan va o‘chirilgan — yo‘q', async () => {
        const expired = await seed({
          createdAt: at(-25 * H),
          remindedAt: remindedFor(at(-25 * H)),
        });
        // 3 kunlik so'rov: skaner muddat boshini 1 soat oldin (yoqilganda) belgilagan.
        const anchored = await seed({
          createdAt: at(-72 * H),
          from: at(-1 * H),
        });
        const rejected = await seed({
          createdAt: at(-25 * H),
          status: 'rejected',
        });
        const voided = await seed({ createdAt: at(-25 * H), status: 'void' });
        const deleted = await seed({
          createdAt: at(-25 * H),
          isDeleted: true,
        });
        const { svc, executed } = makeService();

        expect(await run(svc)).toEqual({
          reminded: 0,
          approved: 1,
          failed: 0,
          deferred: 0,
        });
        expect(executed).toEqual([expired.orderId]);
        expect(await readAuto(expired.id)).toMatchObject({
          status: 'approved',
          auto_approved: true,
        });
        expect(await readAuto(anchored.id)).toMatchObject({
          status: 'pending',
          reminder_sent_at: null,
        });
        expect((await readAuto(rejected.id)).status).toBe('rejected');
        expect((await readAuto(voided.id)).status).toBe('void');
        expect((await readAuto(deleted.id)).status).toBe('pending');

        // Yoqilgan paytdan 24 soat o'tdi — eslatma 10 daqiqa oldin, keyin tasdiq.
        expect(await run(svc, at(23 * H - 10 * 60_000))).toMatchObject({
          reminded: 1,
          approved: 0,
        });
        expect(await run(svc, at(23 * H + 1000))).toMatchObject({
          approved: 1,
        });
        expect(await readAuto(anchored.id)).toMatchObject({
          status: 'approved',
          auto_approved: true,
        });
      });

      it('⭐ TC5 muddat boshi skanerda (haqiqiy SQL): eski ochiq so‘rov — tik vaqti, eslatma qaytadan; yoshi — createdAt; bir marta', async () => {
        const stale = await seed({ createdAt: at(-72 * H), from: null });
        await db.query(
          `UPDATE order_schema.order_extra_cost_approvals SET reminder_sent_at = $2 WHERE id = $1`,
          [stale.id, at(-48 * H)],
        );
        const nearDue = await seed({
          createdAt: at(-(24 * H - 5 * 60_000)),
          from: null,
        });
        const young = await seed({ createdAt: at(-2 * H), from: null });
        // Yopilgan / o'chirilgan qatorlar belgilanmaydi.
        const closed = await seed({
          createdAt: at(-72 * H),
          from: null,
          status: 'rejected',
        });
        const deleted = await seed({
          createdAt: at(-72 * H),
          from: null,
          isDeleted: true,
        });
        const { svc, executed } = makeService();

        expect(await run(svc)).toEqual({
          reminded: 1,
          approved: 0,
          failed: 0,
          deferred: 0,
        });
        expect(executed).toEqual([]);
        expect(await readAuto(stale.id)).toMatchObject({
          status: 'pending',
          auto_approve_from: now,
          reminder_sent_at: null,
        });
        expect(await readAuto(nearDue.id)).toMatchObject({
          auto_approve_from: at(-(24 * H - 5 * 60_000)),
          reminder_sent_at: now,
        });
        expect((await readAuto(young.id)).auto_approve_from).toEqual(
          at(-2 * H),
        );
        expect((await readAuto(closed.id)).auto_approve_from).toBeNull();
        expect((await readAuto(deleted.id)).auto_approve_from).toBeNull();

        // Keyingi tik muddat boshini o'zgartirmaydi. 5 daqiqadan keyin
        // 24 soat to'ldi, lekin eslatmaga 10 daqiqa bo'lmagan — tasdiq yo'q;
        // 10 daqiqadan keyin — tasdiq, eskisi — yo'q.
        expect(await run(svc, at(5 * 60_000))).toMatchObject({ approved: 0 });
        expect(await run(svc, at(10 * 60_000))).toMatchObject({ approved: 1 });
        expect(executed).toEqual([nearDue.orderId]);
        expect(await readAuto(stale.id)).toMatchObject({
          status: 'pending',
          auto_approve_from: now,
        });
        // Eskisi — belgilangan paytdan 24 soat (eslatma 10 daqiqa oldin).
        expect(await run(svc, at(24 * H - 10 * 60_000))).toMatchObject({
          reminded: 2,
          approved: 0,
        });
        expect(await run(svc, at(24 * H))).toMatchObject({ approved: 2 });
        expect(executed).toEqual([
          nearDue.orderId,
          young.orderId,
          stale.orderId,
        ]);
        expect(await readAuto(stale.id)).toMatchObject({
          status: 'approved',
          auto_approved: true,
        });
      });

      it('⭐ TC2: eslatma muddatdan 10 daqiqa oldin, bir marta', async () => {
        const soon = await seed({ createdAt: at(-(24 * H - 9 * 60_000)) });
        const early = await seed({ createdAt: at(-(24 * H - 11 * 60_000)) });
        const { svc } = makeService();

        expect(await run(svc)).toMatchObject({ reminded: 1, approved: 0 });
        expect((await readAuto(soon.id)).reminder_sent_at).toEqual(now);
        expect((await readAuto(early.id)).reminder_sent_at).toBeNull();
        expect(await run(svc)).toMatchObject({ reminded: 0 });
      });

      it('⭐ infratuzilma xatosi: so‘rov pending, keyingi urinish 15 → 30 daqiqadan keyin, oraliqda urinilmaydi', async () => {
        const { id, orderId } = await seed({
          createdAt: at(-25 * H),
          remindedAt: remindedFor(at(-25 * H)),
        });
        const { svc: down } = makeService(new Error('RMQ timeout'));

        expect(await run(down)).toMatchObject({ approved: 0, deferred: 1 });
        expect(await readAuto(id)).toEqual({
          status: 'pending',
          auto_approved: false,
          auto_approve_from: at(-25 * H),
          reminder_sent_at: remindedFor(at(-25 * H)),
          auto_attempts: 1,
          auto_retry_at: at(15 * 60_000),
        });
        // Keyingi daqiqalar — urinish yo'q.
        for (const minute of [1, 5, 14]) {
          expect(await run(down, at(minute * 60_000))).toEqual({
            reminded: 0,
            approved: 0,
            failed: 0,
            deferred: 0,
          });
        }
        expect(await run(down, at(15 * 60_000))).toMatchObject({
          deferred: 1,
        });
        expect(await readAuto(id)).toMatchObject({
          auto_attempts: 2,
          auto_retry_at: at(45 * 60_000),
        });

        // Tizim tiklandi — navbatdagi urinishda tasdiqlanadi.
        const { svc: up, executed } = makeService();
        expect(await run(up, at(45 * 60_000))).toMatchObject({ approved: 1 });
        expect(executed).toEqual([orderId]);
        expect(await readAuto(id)).toMatchObject({
          status: 'approved',
          auto_approved: true,
        });
      });

      it('⭐ TC7: biznes xatosi — void, keyingi daqiqalarda qayta urinilmaydi', async () => {
        const { id } = await seed({
          createdAt: at(-25 * H),
          remindedAt: remindedFor(at(-25 * H)),
        });
        const { svc, sellOrder } = makeService(
          new RpcException({ statusCode: 400, message: 'Kuryer bloklangan' }),
        );

        expect(await run(svc)).toMatchObject({ approved: 0, failed: 1 });
        expect(await readAuto(id)).toMatchObject({
          status: 'void',
          auto_attempts: 0,
          auto_retry_at: null,
        });
        expect(await run(svc, at(60_000))).toMatchObject({ failed: 0 });
        expect(sellOrder).toHaveBeenCalledTimes(1);
      });

      it('kechiktirilgan so‘rov navbat boshini egallamaydi (limit 1)', async () => {
        const waiting = await seed({
          createdAt: at(-30 * H),
          remindedAt: remindedFor(at(-30 * H)),
          retryAt: at(30 * 60_000),
        });
        const next = await seed({
          createdAt: at(-25 * H),
          remindedAt: remindedFor(at(-25 * H)),
        });
        const { svc, executed } = makeService();

        expect(await run(svc, now, 1)).toMatchObject({ approved: 1 });
        expect(executed).toEqual([next.orderId]);
        expect((await readAuto(waiting.id)).status).toBe('pending');
      });

      it('⭐ muddati o‘tgan, eslatma olmagan so‘rov (eski kodga qaytib, keyin qayta yoqilganda) — avval eslatma, tasdiq 10 daqiqadan keyin', async () => {
        const { id, orderId } = await seed({
          createdAt: at(-72 * H),
          from: at(-48 * H),
        });
        const { svc, executed } = makeService();

        expect(await run(svc)).toEqual({
          reminded: 1,
          approved: 0,
          failed: 0,
          deferred: 0,
        });
        expect(await readAuto(id)).toMatchObject({
          status: 'pending',
          reminder_sent_at: now,
        });
        expect(await run(svc, at(9 * 60_000))).toMatchObject({
          reminded: 0,
          approved: 0,
        });
        expect(executed).toEqual([]);
        expect(await run(svc, at(10 * 60_000))).toMatchObject({
          approved: 1,
        });
        expect(executed).toEqual([orderId]);
      });
    });
  },
);
