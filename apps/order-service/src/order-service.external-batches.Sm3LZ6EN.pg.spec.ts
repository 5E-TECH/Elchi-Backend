import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { OrderServiceService } from './order-service.service';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { Branch } from './entities/branch.entity';

/**
 * Sm3LZ6EN — `GET orders/external` `meta.batches` va `GET /scan/:token`
 * `batch` HAQIQIY Postgres'da (GROUP BY, FILTER, enum/bigint ustunlar):
 *   - kartadagi misol: qop 3, 1 qabul qilingan, 1 ro'yxatda, 1 kelmagan;
 *   - son sahifa, status va sana filtrlari bilan kesilmaydi;
 *   - bitta GROUP BY (N+1 yo'q);
 *   - market va filial doirasi ro'yxat bilan bir xil;
 *   - qabuldan OLDIN bekor qilingan a'zo «qabul qilingan» emas.
 *
 * Faqat lokal `/elchi_e_test`:
 *   ORDER_WAREHOUSE_PG_TEST_URI=postgres://postgres:root@127.0.0.1:5432/elchi_e_test
 */
const uri = process.env.ORDER_WAREHOUSE_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_e_test'
  );
})();

const SCHEMA = `sm3_batches_${process.pid}`;
const MARKET_A = '121';
const MARKET_B = '122';
const BRANCH_HQ = '1';
const BRANCH_SAM = '11';

type Member = {
  token: string | null;
  status?: string;
  market?: string;
  size?: number | null;
  ref?: string | null;
  post?: string | null;
  branch?: string | null;
  holderBranch?: string | null;
  homeBranch?: string | null;
  deleted?: boolean;
  createdAt?: string;
};

type BatchRow = {
  external_batch_token: string;
  external_batch_ref: string | null;
  external_batch_size: number | null;
  received_count: number;
  pending_count: number;
};

(localTestDatabase ? describe : describe.skip)(
  'Sm3LZ6EN — qop sonlari, haqiqiy Postgres (pg)',
  () => {
    let db: DataSource;
    let service: OrderServiceService;
    const queries: string[] = [];

    const insert = async (member: Member) => {
      await db.query(
        `INSERT INTO "${SCHEMA}".orders
           (market_id, customer_id, status, source, external_batch_token,
            external_batch_ref, external_batch_size, post_id, branch_id,
            holder_branch_id, home_branch_id, is_deleted, "createdAt")
         VALUES ($1, 801, $2, 'external', $3, $4, $5, $6, $7, $8, $9, $10,
                 COALESCE($11::timestamptz, now()))`,
        [
          member.market ?? MARKET_A,
          member.status ?? 'new',
          member.token,
          member.ref ?? null,
          member.size ?? null,
          member.post ?? null,
          member.branch ?? BRANCH_HQ,
          member.holderBranch ?? null,
          member.homeBranch ?? null,
          member.deleted ?? false,
          member.createdAt ?? null,
        ],
      );
    };

    const list = async (query: Record<string, unknown>) => {
      const res = await service.findAllExternal({ limit: 100, ...query });
      return res as unknown as {
        data: Array<{ id: string }>;
        total: number;
        meta: { batches: BatchRow[] };
      };
    };

    const batchOf = (batches: BatchRow[], token: string) =>
      batches.find((row) => row.external_batch_token === token);

    const groupByQueries = () =>
      queries.filter(
        (sql) => /GROUP BY/i.test(sql) && /external_batch/.test(sql),
      );

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: SCHEMA,
        entities: [Order, OrderItem, OrderTracking, OrderCustodyEvent, Branch],
        logging: ['query'],
      });
      await db.initialize();
      await db.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await db.query(`CREATE SCHEMA "${SCHEMA}"`);
      await db.query('CREATE SCHEMA IF NOT EXISTS "branch_schema"');
      await db.synchronize();
      jest.spyOn(db.logger, 'logQuery').mockImplementation((sql) => {
        queries.push(sql);
      });

      service = Object.create(
        OrderServiceService.prototype,
      ) as OrderServiceService;
      Object.assign(service as object, {
        orderRepo: db.getRepository(Order),
        logger: new Logger('spec'),
      });
      // Boyitish RMQ'ga boradi — bu yerda faqat SQL tekshiriladi.
      jest
        .spyOn(service as never, 'enrichOrders' as never)
        .mockImplementation(((rows: Order[]) =>
          Promise.resolve(rows)) as never);
    }, 30_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        await db.destroy();
      }
    });

    beforeEach(async () => {
      await db.query(`TRUNCATE "${SCHEMA}".orders CASCADE`);
      queries.length = 0;
    });

    it('⭐ TC: qop 3 — 1 qabul qilingan, 1 ro`yxatda, 1 kelmagan => received 1, pending 1, size 3', async () => {
      await insert({
        token: 'QOP-TC',
        ref: 'BP-24817',
        size: 3,
        status: 'received',
        post: '700',
      });
      await insert({ token: 'QOP-TC', ref: 'BP-24817', size: 3 });

      const res = await list({ market_id: MARKET_A, status: 'new' });

      // Ro'yxatda faqat NEW a'zo, lekin son butun qop bo'yicha.
      expect(res.data).toHaveLength(1);
      expect(res.meta.batches).toEqual([
        {
          external_batch_token: 'QOP-TC',
          external_batch_ref: 'BP-24817',
          external_batch_size: 3,
          received_count: 1,
          pending_count: 1,
        },
      ]);
    });

    it('⭐ sahifalash: boshqa sahifadagi a`zolar ham sanaladi', async () => {
      for (let i = 0; i < 5; i += 1) {
        await insert({ token: 'QOP-PAGE', size: 7 });
      }

      const res = await list({ market_id: MARKET_A, status: 'new', limit: 2 });

      expect(res.data).toHaveLength(2);
      expect(res.total).toBe(5);
      expect(res.meta.batches).toHaveLength(1);
      expect(res.meta.batches[0].pending_count).toBe(5);
    });

    it('⭐ sana filtri sonni kesmaydi: eski a`zo ham sanaladi', async () => {
      await insert({
        token: 'QOP-DAY',
        size: 2,
        status: 'waiting',
        post: '700',
        createdAt: '2026-01-05T08:00:00Z',
      });
      await insert({
        token: 'QOP-DAY',
        size: 2,
        createdAt: '2026-10-20T08:00:00Z',
      });

      const res = await list({
        market_id: MARKET_A,
        start_day: '2026-10-20',
        end_day: '2026-10-20',
      });

      expect(res.data).toHaveLength(1);
      expect(batchOf(res.meta.batches, 'QOP-DAY')).toMatchObject({
        received_count: 1,
        pending_count: 1,
      });
    });

    it('⭐ N+1 yo`q: bir nechta qop — BITTA GROUP BY so`rovi', async () => {
      for (let i = 0; i < 6; i += 1) {
        await insert({ token: `QOP-${i}`, size: 2 });
      }

      const res = await list({ market_id: MARKET_A, status: 'new' });

      expect(res.meta.batches).toHaveLength(6);
      expect(groupByQueries()).toHaveLength(1);
    });

    it('qopsiz sahifa: `meta.batches` bo`sh va so`rov ketmaydi', async () => {
      await insert({ token: null });

      const res = await list({ market_id: MARKET_A, status: 'new' });

      expect(res.data).toHaveLength(1);
      expect(res.meta.batches).toEqual([]);
      expect(groupByQueries()).toHaveLength(0);
    });

    it('⭐ tenant: boshqa marketning AYNI tokenli qopi sanalmaydi', async () => {
      // Token bazada noyob emas — ikki hamkor bir xil qiymat yuborishi mumkin.
      await insert({ token: 'QOP-SAME', ref: 'A-1', size: 2 });
      await insert({
        token: 'QOP-SAME',
        market: MARKET_B,
        ref: 'Z-9',
        size: 50,
        status: 'sold',
        post: '701',
      });
      await insert({
        token: 'QOP-SAME',
        market: MARKET_B,
        ref: 'Z-9',
        size: 50,
      });

      const res = await list({ market_id: MARKET_A, status: 'new' });

      expect(res.meta.batches).toEqual([
        {
          external_batch_token: 'QOP-SAME',
          external_batch_ref: 'A-1',
          external_batch_size: 2,
          received_count: 0,
          pending_count: 1,
        },
      ]);
    });

    it('⭐ filial doirasi ro`yxat bilan bir xil: begona filial a`zosi sanalmaydi', async () => {
      await insert({ token: 'QOP-BR', size: 4, branch: BRANCH_SAM });
      // Ro'yxat doirasi: branch / holder_branch / home_branch — uchalasi.
      await insert({
        token: 'QOP-BR',
        size: 4,
        status: 'received',
        post: '700',
        branch: BRANCH_HQ,
        holderBranch: BRANCH_SAM,
      });
      await insert({
        token: 'QOP-BR',
        size: 4,
        status: 'sold',
        post: '700',
        branch: BRANCH_HQ,
        homeBranch: BRANCH_SAM,
      });
      // Begona filial.
      await insert({ token: 'QOP-BR', size: 4, branch: BRANCH_HQ });

      const res = await list({ branch_id: BRANCH_SAM, status: 'new' });

      expect(res.data).toHaveLength(1);
      expect(batchOf(res.meta.batches, 'QOP-BR')).toMatchObject({
        received_count: 2,
        pending_count: 1,
      });
    });

    it('o`chirilgan a`zo sanalmaydi', async () => {
      await insert({ token: 'QOP-DEL', size: 3 });
      await insert({ token: 'QOP-DEL', size: 3, deleted: true });
      await insert({
        token: 'QOP-DEL',
        size: 3,
        status: 'received',
        post: '700',
        deleted: true,
      });

      const res = await list({ market_id: MARKET_A, status: 'new' });

      expect(batchOf(res.meta.batches, 'QOP-DEL')).toMatchObject({
        received_count: 0,
        pending_count: 1,
      });
    });

    it('⭐ qabuldan OLDIN bekor qilingan a`zo keldi deb sanalmaydi, qabuldan keyingisi sanaladi', async () => {
      await insert({ token: 'QOP-CAN', size: 4 });
      // `cancelPreDeliveryOrder`: NEW -> CANCELLED, pochta YO'Q.
      await insert({ token: 'QOP-CAN', size: 4, status: 'cancelled' });
      // `cancelOrder`: faqat pochtadagi WAITING dan — posilka qabul qilingan.
      await insert({
        token: 'QOP-CAN',
        size: 4,
        status: 'cancelled',
        post: '700',
      });
      // Tasdiqlanmagan (`created`) — hali kelmagan ham, kutilmayapti ham.
      await insert({ token: 'QOP-CAN', size: 4, status: 'created' });

      const res = await list({ market_id: MARKET_A, status: 'new' });

      expect(batchOf(res.meta.batches, 'QOP-CAN')).toMatchObject({
        received_count: 1,
        pending_count: 1,
      });
    });

    it('`external_batch_size` a`zolarda farq qilsa eng kattasi olinadi', async () => {
      await insert({ token: 'QOP-SZ', size: 2 });
      await insert({ token: 'QOP-SZ', size: 5 });
      await insert({ token: 'QOP-SZ', size: null });

      const res = await list({ market_id: MARKET_A, status: 'new' });

      expect(res.meta.batches[0].external_batch_size).toBe(5);
    });

    describe('GET /scan/:token (order.find_batch_by_external_token)', () => {
      const scan = async (
        token: string,
        scope?: { market_id?: string; branch_id?: string },
      ) => {
        const res = await service.findBatchByExternalToken(token, scope);
        return (
          res as unknown as {
            data: {
              count: number;
              members: unknown[];
              batch: Record<string, unknown> | null;
            };
          }
        ).data;
      };

      it('⭐ `batch`: size + received + pending + scanned', async () => {
        await insert({ token: 'QOP-SCAN', size: 3 });
        await insert({
          token: 'QOP-SCAN',
          size: 3,
          status: 'received',
          post: '700',
        });

        const data = await scan('QOP-SCAN');

        expect(data.count).toBe(2);
        expect(data.batch).toEqual({
          external_batch_token: 'QOP-SCAN',
          size: 3,
          received_count: 1,
          pending_count: 1,
          scanned_count: 1,
        });
      });

      it('⭐ market faqat o`z a`zolarini ko`radi, begona qop — 404', async () => {
        await insert({ token: 'QOP-MIX', size: 3 });
        await insert({
          token: 'QOP-MIX',
          market: MARKET_B,
          size: 3,
          status: 'sold',
          post: '701',
        });

        const own = await scan('QOP-MIX', { market_id: MARKET_A });
        expect(own.count).toBe(1);
        expect(own.batch).toMatchObject({
          received_count: 0,
          pending_count: 1,
        });

        await expect(
          scan('QOP-MIX', { market_id: '999' }),
        ).rejects.toBeInstanceOf(RpcException);
      });

      it('filial doirasi: son doiradagi a`zolar bo`yicha, a`zolar ro`yxati xodimga o`zgarmaydi', async () => {
        await insert({ token: 'QOP-FIL', size: 3, branch: BRANCH_SAM });
        await insert({ token: 'QOP-FIL', size: 3, branch: BRANCH_HQ });

        const data = await scan('QOP-FIL', { branch_id: BRANCH_SAM });

        expect(data.count).toBe(2);
        expect(data.batch).toMatchObject({
          received_count: 0,
          pending_count: 1,
        });

        const foreign = await scan('QOP-FIL', { branch_id: '77' });
        expect(foreign.count).toBe(2);
        expect(foreign.batch).toBeNull();
      });
    });
  },
);
