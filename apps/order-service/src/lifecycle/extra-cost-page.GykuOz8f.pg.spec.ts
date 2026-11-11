import { randomUUID } from 'node:crypto';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { Order_status } from '@app/common';
import { CreateOrderExtraCostApprovals1716000000026 } from '../../../../migrations/1716000000026-CreateOrderExtraCostApprovals';
import { ExtraCostAutoApprove1716000000123 } from '../../../../migrations/1716000000123-ExtraCostAutoApprove';
import { ExtraCostApprovalVoidReversed1716000000206 } from '../../../../migrations/1716000000206-ExtraCostApprovalVoidReversed';
import { ExtraCostAutoApproveFrom1716000000208 } from '../../../../migrations/1716000000208-ExtraCostAutoApproveFrom';
import { ExtraCostImmediateRows1716000000210 } from '../../../../migrations/1716000000210-ExtraCostImmediateRows';
import { ExtraCostDeferred1716000000219 } from '../../../../migrations/1716000000219-ExtraCostDeferred';
import { Branch } from '../entities/branch.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { OrderExtraCostApproval } from '../entities/order-extra-cost-approval.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { Order } from '../entities/order.entity';
import { OrderServiceService } from '../order-service.service';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * GykuOz8f — «Qo'shimcha xarajatli buyurtmalar» SQL'i haqiqiy Postgres'da
 * (BOT_PG_TEST_URI — faqat lokal baza; o'z vaqtinchalik bazasi, migratsiya
 * 026 + 123 + 206 + 208 + 210):
 *
 *  - har rol doirasi (kuryer, menejer filial qoidasi, market, operator);
 *  - tablar va `counts` (bitta GROUP BY), `createdAt` DESC, id DESC,
 *    100 dan ortiq qatorda haqiqiy sahifalash;
 *  - o'chirilgan so'rov va o'chirilgan (is_deleted / deleted_at) buyurtma
 *    ko'rinmaydi;
 *  - isbot ko'rinishi; buyurtma javobidagi `pending_extra_cost_approval` SQL'i;
 *  - tasdiqsiz qator haqiqiy tranzaksiyada: ROLLBACK — yo'q, COMMIT — bor,
 *    orqaga qaytarishda `reversed`.
 */
const uri = process.env.BOT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return ['127.0.0.1', 'localhost'].includes(url.hostname);
})();

type Item = Record<string, unknown> & { id: string; order_id: string };
type PageRes = {
  data: {
    items: Item[];
    total: number;
    page: number;
    limit: number;
    counts: Record<string, number>;
  };
};

const T = (minute: number) => new Date(Date.UTC(2026, 10, 1, 8, minute, 0));

(localTestDatabase ? describe : describe.skip)(
  'GykuOz8f — qo‘shimcha xarajatli buyurtmalar SQL (haqiqiy Postgres)',
  () => {
    jest.setTimeout(30_000);
    const dbName = `spec_xc_page_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    let log: jest.SpyInstance;
    const ids: Record<string, string> = {};

    const COURIER = { id: '301', roles: ['courier'], branch_id: '77' };
    const MANAGER = { id: '201', roles: ['manager'], branch_id: '77' };
    const MARKET = { id: '501', roles: ['market'] };

    const lifecycle = () => {
      const svc = Object.create(
        OrderLifecycleService.prototype,
      ) as OrderLifecycleService;
      Object.assign(svc, {
        extraCostApprovalRepo: db.getRepository(OrderExtraCostApproval),
        dataSource: db,
        identityClient: { send: jest.fn(() => of({ data: [] })) },
        outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
        logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
      });
      return svc;
    };

    const page = async (
      requester: Parameters<OrderLifecycleService['pageExtraCosts']>[0],
      query: { tab?: string; page?: number; limit?: number } = {},
    ) =>
      (await lifecycle().pageExtraCosts(requester, {
        limit: 100,
        ...query,
      })) as PageRes;

    const orderIds = (res: PageRes) =>
      res.data.items.map((item) => item.order_id);

    let nextOrder = 100;
    const order = async (
      overrides: {
        id?: number;
        status?: string;
        isDeleted?: boolean;
        deletedAt?: Date | null;
        customerId?: number | null;
        extraNumber?: string | null;
      } = {},
    ) => {
      const id = overrides.id ?? ++nextOrder;
      await db.query(
        `INSERT INTO order_schema.orders
           (id, status, is_deleted, deleted_at, market_id, customer_id, extra_number)
         VALUES ($1, $2, $3, $4, 501, $5, $6)`,
        [
          id,
          overrides.status ?? 'waiting',
          overrides.isDeleted ?? false,
          overrides.deletedAt ?? null,
          overrides.customerId ?? null,
          overrides.extraNumber ?? null,
        ],
      );
      return String(id);
    };

    const approval = async (row: {
      order: string;
      by: string;
      role?: string;
      branch?: string | null;
      market?: string;
      status?: string;
      minute?: number;
      createdAt?: Date;
      isDeleted?: boolean;
      immediate?: boolean;
      proofs?: string[];
    }) => {
      const [saved]: Array<{ id: string }> = await db.query(
        `INSERT INTO order_schema.order_extra_cost_approvals
           (order_id, market_id, requested_by_user_id, requested_by_role, requester_branch_id,
            action, amount, proof_file_keys, operation_payload, status, immediate, is_deleted,
            "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'sell', 10000, $6::jsonb, '{}'::jsonb, $7, $8, $9, $10, $10)
         RETURNING id::text AS id`,
        [
          row.order,
          row.market ?? '501',
          row.by,
          row.role ?? 'courier',
          row.branch === undefined ? '77' : row.branch,
          JSON.stringify(row.proofs ?? []),
          row.status ?? 'approved',
          row.immediate ?? false,
          row.isDeleted ?? false,
          row.createdAt ?? T(row.minute ?? 0),
        ],
      );
      return saved.id;
    };

    beforeAll(async () => {
      log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      const url = new URL(uri!);
      url.pathname = `/${dbName}`;
      db = new DataSource({
        type: 'postgres',
        url: url.toString(),
        schema: 'order_schema',
        // `innerJoin(Order, …)` va tracking join'i uchun metadata (jadval
        // yaratilmaydi — o'zimiz quramiz).
        entities: [
          OrderExtraCostApproval,
          OrderTracking,
          Order,
          OrderItem,
          OrderCustodyEvent,
          Branch,
        ],
        extra: { max: 5 },
      });
      await db.initialize();
      await db.query('CREATE SCHEMA order_schema');
      const statuses = Object.values(Order_status)
        .map((status) => `'${status}'`)
        .join(', ');
      await db.query(
        `CREATE TYPE order_schema.orders_status_enum AS ENUM (${statuses})`,
      );
      // Sahifa o'qiydigan va migratsiya 206 / 210 tegadigan ustunlar.
      await db.query(`
        CREATE TABLE order_schema.orders (
          id bigint PRIMARY KEY,
          status order_schema.orders_status_enum NOT NULL DEFAULT 'waiting',
          is_deleted boolean NOT NULL DEFAULT false,
          deleted_at timestamptz NULL,
          market_id bigint NULL,
          customer_id bigint NULL,
          extra_number varchar NULL,
          extra_cost int NOT NULL DEFAULT 0,
          proof_files jsonb NULL
        )`);
      await db.query(`
        CREATE TABLE order_schema.order_tracking (
          id bigserial PRIMARY KEY,
          order_id bigint NOT NULL,
          from_status order_schema.orders_status_enum,
          to_status order_schema.orders_status_enum NOT NULL,
          action varchar(64) NULL,
          changed_by varchar(64) NOT NULL DEFAULT 'system',
          changed_by_role varchar(32) NOT NULL DEFAULT 'system',
          note text NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )`);
      const runner = db.createQueryRunner();
      try {
        await new CreateOrderExtraCostApprovals1716000000026().up(runner);
        await new ExtraCostAutoApprove1716000000123().up(runner);
        await new ExtraCostApprovalVoidReversed1716000000206().up(runner);
        await new ExtraCostAutoApproveFrom1716000000208().up(runner);
        await new ExtraCostImmediateRows1716000000210().up(runner);
        // (SPEC v2) `mode` / `items` / `deferred_snapshot` ustunlari —
        // migratsiya 219 `order_settlement` ga ham tegadi, shuning uchun
        // eski unikal indeksli minimal jadval.
        await runner.query(`
          CREATE TABLE order_schema.order_settlement (
            id bigserial PRIMARY KEY,
            order_id bigint NOT NULL
          )`);
        await runner.query(
          'CREATE UNIQUE INDEX "IDX_order_settlement_order_id" ON order_schema.order_settlement (order_id)',
        );
        await new ExtraCostDeferred1716000000219().up(runner);
      } finally {
        await runner.release();
      }

      // Kuryer 301 (filial 77): har holatdan bittadan.
      ids.pending301 = await approval({
        order: await order({ id: 1, customerId: 801 }),
        by: '301',
        status: 'pending',
        minute: 10,
        proofs: ['proof/a.jpg', 'proof/b.mp4'],
      });
      ids.immediate301 = await approval({
        order: await order({ id: 2, status: 'sold' }),
        by: '301',
        immediate: true,
        minute: 9,
      });
      ids.rejected301 = await approval({
        order: await order({ id: 3 }),
        by: '301',
        status: 'rejected',
        minute: 8,
      });
      ids.void301 = await approval({
        order: await order({ id: 4, status: 'sold' }),
        by: '301',
        status: 'void',
        minute: 7,
      });
      ids.reversed301 = await approval({
        order: await order({ id: 5 }),
        by: '301',
        status: 'reversed',
        minute: 6,
      });
      // Boshqa kuryer, shu filial.
      ids.pending302 = await approval({
        order: await order({ id: 6 }),
        by: '302',
        status: 'pending',
        minute: 5,
      });
      // Boshqa filial kuryeri.
      ids.other303 = await approval({
        order: await order({ id: 7, status: 'sold' }),
        by: '303',
        branch: '88',
        minute: 4,
      });
      // Menejer 201 o'zi yozgan va boshqa menejer (shu filial).
      ids.manager201 = await approval({
        order: await order({ id: 8, status: 'sold' }),
        by: '201',
        role: 'manager',
        minute: 3,
      });
      ids.manager202 = await approval({
        order: await order({ id: 9, status: 'sold' }),
        by: '202',
        role: 'manager',
        minute: 2,
      });
      // 301 avval boshqa filialda edi — so'rov paytidagi filial 66.
      ids.oldBranch301 = await approval({
        order: await order({ id: 10, status: 'sold' }),
        by: '301',
        branch: '66',
        minute: 1,
      });
      // Boshqa market.
      ids.market502 = await approval({
        order: await order({ id: 11, status: 'sold' }),
        by: '301',
        market: '502',
        minute: 11,
      });
      // Ko'rinmaydiganlar: o'chirilgan so'rov, o'chirilgan buyurtma (ikki usul).
      await approval({
        order: await order({ id: 12 }),
        by: '301',
        status: 'void',
        isDeleted: true,
        minute: 12,
      });
      await approval({
        order: await order({ id: 13, isDeleted: true }),
        by: '301',
        minute: 13,
      });
      await approval({
        order: await order({ id: 14, deletedAt: T(14) }),
        by: '301',
        minute: 14,
      });
    });

    afterAll(async () => {
      log?.mockRestore();
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        await admin.destroy();
      }
    });

    it('⭐ kuryer — faqat o‘zi yozganlari (eski filialdagisi ham), eng yangisi tepada; o‘chirilganlar yo‘q', async () => {
      const res = await page(COURIER);

      expect(orderIds(res)).toEqual(['11', '1', '2', '3', '4', '5', '10']);
      // reversed (5) — faqat «all» da.
      expect(res.data.counts).toEqual({
        all: 7,
        pending: 1,
        approved: 3,
        cancelled: 2,
      });
      expect(res.data.total).toBe(7);
      expect(res.data.items[1]).toMatchObject({
        id: ids.pending301,
        status: 'pending',
        order_status: 'waiting',
        proof_count: 2,
        immediate: false,
      });
      expect(res.data.items[2]).toMatchObject({
        id: ids.immediate301,
        immediate: true,
        order_status: 'sold',
      });
    });

    it('⭐ menejer — filial kuryerlari (so‘rov paytidagi filial) + o‘zi; boshqa filial / boshqa menejer / eski filial yo‘q', async () => {
      const res = await page(MANAGER);

      expect(orderIds(res)).toEqual(['11', '1', '2', '3', '4', '5', '6', '8']);
      expect(res.data.items.map((item) => item.id)).not.toContain(ids.other303);
      expect(res.data.items.map((item) => item.id)).not.toContain(
        ids.manager202,
      );
      expect(res.data.items.map((item) => item.id)).not.toContain(
        ids.oldBranch301,
      );

      const noBranch = await page({ id: '201', roles: ['manager'] });
      expect(orderIds(noBranch)).toEqual(['8']);
    });

    it('⭐ market — o‘z marketi; operator — biriktirilgan market', async () => {
      const market = await page(MARKET);
      expect(orderIds(market)).toEqual([
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        '10',
      ]);
      expect(market.data.counts).toEqual({
        all: 10,
        pending: 2,
        approved: 5,
        cancelled: 2,
      });

      const operator = await page({
        id: '26',
        roles: ['market_operator'],
        market_id: '502',
      });
      expect(orderIds(operator)).toEqual(['11']);
    });

    it('⭐ tablar: pending / approved (tasdiqsiz ham) / cancelled (rejected + void); reversed faqat all da', async () => {
      expect(orderIds(await page(COURIER, { tab: 'pending' }))).toEqual(['1']);
      expect(orderIds(await page(COURIER, { tab: 'approved' }))).toEqual([
        '11',
        '2',
        '10',
      ]);
      const cancelled = await page(COURIER, { tab: 'cancelled' });
      expect(orderIds(cancelled)).toEqual(['3', '4']);
      expect(cancelled.data.total).toBe(2);
      expect(cancelled.data.counts.all).toBe(7);
    });

    it('⭐ 100 dan ortiq qator — haqiqiy sahifalash, bir xil vaqtda id DESC', async () => {
      const created: string[] = [];
      for (let i = 0; i < 130; i += 1) {
        created.push(
          await approval({
            order: await order({ id: 1000 + i, status: 'sold' }),
            by: '304',
            branch: '99',
            // Har 10 tasi bir xil vaqtda.
            createdAt: T(100 + Math.floor(i / 10)),
          }),
        );
      }
      const expected = created
        .map((id, i) => ({ id, group: Math.floor(i / 10) }))
        .sort((a, b) => b.group - a.group || Number(b.id) - Number(a.id))
        .map((row) => row.id);
      const courier = { id: '304', roles: ['courier'] };

      const first = await page(courier, { page: 1, limit: 100 });
      const second = await page(courier, { page: 2, limit: 100 });
      const beyond = await page(courier, { page: 3, limit: 100 });

      expect(first.data.total).toBe(130);
      expect(first.data.items).toHaveLength(100);
      expect(second.data.items).toHaveLength(30);
      expect(beyond.data.items).toHaveLength(0);
      expect([
        ...first.data.items.map((item) => item.id),
        ...second.data.items.map((item) => item.id),
      ]).toEqual(expected);
    });

    it('⭐ isbot — ro‘yxat bilan AYNI ko‘rish qoidasi', async () => {
      const svc = lifecycle();
      const keyOf = async (
        requester: Parameters<OrderLifecycleService['extraCostProofKey']>[0],
        index: number,
      ) => {
        try {
          const res = (await svc.extraCostProofKey(
            requester,
            ids.pending301,
            index,
          )) as { data: { key: string } };
          return res.data.key;
        } catch (error) {
          return (error as RpcException).getError();
        }
      };

      expect(await keyOf(COURIER, 1)).toBe('proof/b.mp4');
      expect(await keyOf(MANAGER, 0)).toBe('proof/a.jpg');
      expect(await keyOf(MARKET, 0)).toBe('proof/a.jpg');
      expect(
        await keyOf(
          { id: '26', roles: ['market_operator'], market_id: '501' },
          0,
        ),
      ).toBe('proof/a.jpg');
      for (const stranger of [
        { id: '302', roles: ['courier'] },
        { id: '502', roles: ['market'] },
        { id: '205', roles: ['manager'], branch_id: '88' },
      ]) {
        expect(await keyOf(stranger, 0)).toEqual({
          statusCode: 404,
          message: "So'rov topilmadi",
        });
      }
      expect(await keyOf(COURIER, 2)).toEqual({
        statusCode: 404,
        message: 'Isbot fayli topilmadi',
      });
    });

    it('⭐ pending_extra_cost_approval SQL — faqat kutilayotgan buyurtma va ochiq so‘rov', async () => {
      const service = Object.create(
        OrderServiceService.prototype,
      ) as OrderServiceService;
      Object.assign(service, {
        dataSource: db,
        logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
      });
      // 3 — rad etilgan so'rov (ochiq emas); 2 — sotilgan buyurtma.
      const pending = await (
        service as unknown as {
          loadPendingExtraCostApprovals: (
            rows: Array<{ id: string; status: string }>,
          ) => Promise<Map<string, Record<string, unknown>>>;
        }
      ).loadPendingExtraCostApprovals([
        { id: '1', status: Order_status.WAITING },
        { id: '6', status: Order_status.WAITING },
        { id: '3', status: Order_status.WAITING },
        { id: '2', status: Order_status.SOLD },
      ]);

      expect([...pending.keys()].sort()).toEqual(['1', '6']);
      expect(pending.get('1')).toEqual({
        id: ids.pending301,
        action: 'sell',
        amount: 10000,
        created_at: T(10).toISOString(),
        auto_approve_at: expect.any(String),
      });
      expect(
        (service as unknown as { logger: { warn: jest.Mock } }).logger.warn,
      ).not.toHaveBeenCalled();
    });

    describe('tasdiqsiz qator — haqiqiy tranzaksiya', () => {
      type Private = {
        applyExtraCostApprovalsOnExecution: (
          ...args: unknown[]
        ) => Promise<void>;
        closeExtraCostApprovalsOnRollback: (
          ...args: unknown[]
        ) => Promise<void>;
      };
      const write = {
        action: 'cancel',
        amount: 7000,
        marketId: '501',
        proofFiles: ['proof/c.jpg'],
        payload: { extraCost: 7000, comment: 'Mijoz olmadi' },
      };
      const rowsOf = (orderId: string) =>
        db.query<Array<Record<string, unknown>>>(
          `SELECT status, immediate, auto_approved, decided_by_user_id, decided_at,
                  requested_by_user_id::text AS requested_by_user_id, requested_by_role,
                  requester_branch_id::text AS requester_branch_id, action,
                  amount::text AS amount, proof_file_keys, operation_payload
             FROM order_schema.order_extra_cost_approvals
            WHERE order_id = $1`,
          [orderId],
        );

      const inTransaction = async (
        work: (manager: unknown, helpers: Private) => Promise<void>,
        commit: boolean,
      ) => {
        const helpers = lifecycle() as unknown as Private;
        const runner = db.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        try {
          await work(runner.manager, helpers);
          if (commit) await runner.commitTransaction();
          else await runner.rollbackTransaction();
        } finally {
          await runner.release();
        }
      };

      it('⭐ pul yozuvi qaytsa (ROLLBACK) — qator yo‘q; COMMIT — `approved` + `immediate`', async () => {
        const orderId = await order({ id: 2001 });
        const requester = { id: '301', roles: ['courier'], branch_id: '77' };

        await inTransaction(
          (manager, helpers) =>
            helpers.applyExtraCostApprovalsOnExecution(
              manager,
              orderId,
              requester,
              undefined,
              write,
            ),
          false,
        );
        expect(await rowsOf(orderId)).toEqual([]);

        await inTransaction(
          (manager, helpers) =>
            helpers.applyExtraCostApprovalsOnExecution(
              manager,
              orderId,
              requester,
              undefined,
              write,
            ),
          true,
        );
        expect(await rowsOf(orderId)).toEqual([
          {
            status: 'approved',
            immediate: true,
            auto_approved: false,
            decided_by_user_id: null,
            decided_at: expect.any(Date),
            requested_by_user_id: '301',
            requested_by_role: 'courier',
            requester_branch_id: '77',
            action: 'cancel',
            amount: '7000.00',
            proof_file_keys: ['proof/c.jpg'],
            operation_payload: { extraCost: 7000, comment: 'Mijoz olmadi' },
          },
        ]);
        // Yangi qator «approved» tabida (tasdiqsiz yozildi).
        const listed = await page(COURIER, { tab: 'approved' });
        expect(
          listed.data.items.find((item) => item.order_id === orderId),
        ).toMatchObject({ status: 'approved', immediate: true });

        // Orqaga qaytarish — `reversed`.
        await inTransaction(
          (manager, helpers) =>
            helpers.closeExtraCostApprovalsOnRollback(manager, orderId, {
              id: '1',
            }),
          true,
        );
        expect(await rowsOf(orderId)).toEqual([
          expect.objectContaining({ status: 'reversed', immediate: true }),
        ]);
      });
    });
  },
);
