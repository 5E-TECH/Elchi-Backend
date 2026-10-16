import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreateOrderExtraCostApprovals1716000000026 } from '../../../../migrations/1716000000026-CreateOrderExtraCostApprovals';
import { ExtraCostAutoApprove1716000000123 } from '../../../../migrations/1716000000123-ExtraCostAutoApprove';
import { OrderExtraCostApproval } from '../entities/order-extra-cost-approval.entity';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * 1tnpaIqd — atomik qaror HAQIQIY Postgres'da (faqat lokal test bazasi):
 * migratsiya 026 + 123, ikki parallel approve / approve+reject — faqat
 * bittasi o'tadi, biznes amali bir marta.
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

(localTestDatabase ? describe : describe.skip)(
  'extra-cost qarori — lokal Postgres (1tnpaIqd)',
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
        entities: [OrderExtraCostApproval],
        extra: { max: 10 },
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS order_schema CASCADE');
      await db.query('CREATE SCHEMA order_schema');
      const runner = db.createQueryRunner();
      try {
        await new CreateOrderExtraCostApprovals1716000000026().up(runner);
        await new ExtraCostAutoApprove1716000000123().up(runner);
        await new ExtraCostAutoApprove1716000000123().up(runner);
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

    const insert = async () => {
      const [row]: Array<{ id: string }> = await db.query(
        `INSERT INTO order_schema.order_extra_cost_approvals
           (order_id, market_id, requested_by_user_id, requested_by_role, action, amount, operation_payload, status)
         VALUES (7001, 501, 301, 'courier', 'sell', 12000, '{}'::jsonb, 'pending')
         RETURNING id`,
      );
      return String(row.id);
    };

    const makeService = () => {
      const svc = Object.create(
        OrderLifecycleService.prototype,
      ) as OrderLifecycleService;
      Object.assign(svc, {
        extraCostApprovalRepo: db.getRepository(OrderExtraCostApproval),
        outbox: { enqueue: jest.fn() },
        activityLog: { log: jest.fn().mockResolvedValue(undefined) },
        logger: { warn: jest.fn(), log: jest.fn() },
      });
      const sellOrder = jest
        .spyOn(svc, 'sellOrder')
        .mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { statusCode: 200 } as never;
        });
      return { svc, sellOrder };
    };

    it('⭐ ikki parallel approve — bittasi o‘tadi, sellOrder BIR marta (real UPDATE … WHERE status=pending)', async () => {
      const id = await insert();
      const { svc, sellOrder } = makeService();
      const market = { id: '501', roles: ['market'] };
      const results = await Promise.allSettled([
        svc.approveExtraCostApproval(market, id),
        svc.approveExtraCostApproval(market, id),
        svc.approveExtraCostApproval(market, id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(sellOrder).toHaveBeenCalledTimes(1);
      const [row]: Array<{ status: string; auto_approved: boolean }> =
        await db.query(
          `SELECT status, auto_approved FROM order_schema.order_extra_cost_approvals WHERE id = $1`,
          [id],
        );
      expect(row).toEqual({ status: 'approved', auto_approved: false });
    });

    it('⭐ approve + reject bir vaqtda — faqat bittasi, holat aralashmaydi', async () => {
      const id = await insert();
      const { svc, sellOrder } = makeService();
      const market = { id: '501', roles: ['market'] };
      const results = await Promise.allSettled([
        svc.rejectExtraCostApproval(market, id, { reason: 'DUPLICATE' }),
        svc.approveExtraCostApproval(market, id),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [row]: Array<{ status: string }> = await db.query(
        `SELECT status FROM order_schema.order_extra_cost_approvals WHERE id = $1`,
        [id],
      );
      expect(sellOrder).toHaveBeenCalledTimes(
        row.status === 'approved' ? 1 : 0,
      );
    });
  },
);
