/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ActivityLog, OutboxEvent } from '@app/common';
import { PostOrderMemberships1716000000201 } from '../../../../migrations/1716000000201-PostOrderMemberships';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { Branch } from '../entities/branch.entity';
import {
  PostMembershipService,
  type PostMembershipRow,
} from './post-membership.service';
import { runPostMembershipBackfill } from './post-membership-backfill.runner';

/**
 * Pochta ↔ buyurtma tarixi HAQIQIY Postgres'da (ORDER_POST_MEMBERSHIP_PG_TEST_URI
 * bo'lmasa skip). O'z vaqtinchalik bazasini yaratadi va oxirida o'chiradi.
 *
 *  • migratsiya 201: seed (o'chirilgan buyurtma ham), qayta yurgizish (FK
 *    bitta), down;
 *  • trigger: INSERT, ko'chish (yopish + ochish), NULL, o'zgarmagan qiymat,
 *    tranzaksiya ichida ketma-ket ko'chish, erta boshlangan tranzaksiya vaqt
 *    tartibi (clock_timestamp), ommaviy UPDATE, TypeORM save / update,
 *    CANCELED alohida, CASCADE;
 *  • `order.post_membership.find` o'qishi;
 *  • backfill: dry-run hech narsa yozmaydi, apply yozadi, qayta apply — 0;
 *    bir buyurtmaning ko'p turishi INSERT bo'laklariga bo'linmaydi.
 */
const pgUri = process.env.ORDER_POST_MEMBERSHIP_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

type Row = {
  order_id: string;
  post_id: string;
  kind: string;
  open: boolean;
  next_post_id: string | null;
  source: string | null;
};

describePg('post_order_memberships — haqiqiy Postgres', () => {
  const dbName = `spec_pom_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  const migration = new PostOrderMemberships1716000000201();

  /** TypeORM kabi: bitta tranzaksiyada. */
  const run = async (direction: 'up' | 'down') => {
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await migration[direction](runner);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };

  const rows = async (orderId: number | string): Promise<Row[]> =>
    db.query<Row[]>(
      `SELECT order_id::text, post_id::text, kind, (left_at IS NULL) AS open,
              next_post_id::text, source
         FROM order_schema.post_order_memberships
        WHERE order_id = $1 ORDER BY id`,
      [String(orderId)],
    );

  const insertOrder = async (
    id: number,
    postId: number | null,
    canceledPostId: number | null = null,
    deleted = false,
  ): Promise<void> => {
    await db.query(
      `INSERT INTO order_schema.orders
         (id, market_id, customer_id, status, source, total_price, branch_id,
          home_branch_id, holder_type, post_id, canceled_post_id, is_deleted)
       VALUES ($1, 500, 77, 'received', 'internal', 1000, 1, 1, 'HQ', $2, $3, $4)`,
      [id, postId, canceledPostId, deleted],
    );
  };

  const at = (iso: string) => new Date(iso);

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri as string);
    url.pathname = `/${dbName}`;
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'order_schema',
      entities: [
        Order,
        OrderItem,
        OrderTracking,
        OrderCustodyEvent,
        Branch,
        OutboxEvent,
        ActivityLog,
      ],
      synchronize: false,
    });
    await db.initialize();
    for (const schema of [
      'order_schema',
      'branch_schema',
      'logistics_schema',
    ]) {
      await db.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    }
    await db.synchronize();
    await db.query(`
      CREATE TABLE logistics_schema.activity_logs (
        id bigserial PRIMARY KEY, entity_type varchar(64) NOT NULL,
        entity_id varchar(100) NOT NULL, action varchar(64) NOT NULL,
        old_value jsonb NULL, new_value jsonb NULL,
        created_at timestamptz NOT NULL DEFAULT now())`);
    await db.query(`
      CREATE TABLE logistics_schema.posts (
        id bigserial PRIMARY KEY, status varchar(32) NOT NULL,
        order_quantity int NOT NULL DEFAULT 0)`);
    await db.query(
      `INSERT INTO branch_schema.branches (id, name) VALUES (1, 'HQ')`,
    );

    // Migratsiyadan OLDIN mavjud buyurtmalar (seed manbasi).
    await insertOrder(1, 10);
    await insertOrder(2, null, 20);
    await insertOrder(3, 11, 21);
    await insertOrder(4, null);
    await insertOrder(5, 12, null, true); // o'chirilgan — baribir kuzatiladi
    // Backfill uchun: tarixi migratsiyadan oldingi buyurtmalar.
    await insertOrder(8, 103);
    await insertOrder(9, null);
    await run('up');
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  describe('migratsiya', () => {
    it('seed: har ko`rsatkichli buyurtmaga bitta ochiq qator (o`chirilgan ham)', async () => {
      const seeded: Array<{ order_id: string; kind: string; post_id: string }> =
        await db.query(
          `SELECT order_id::text, kind, post_id::text
             FROM order_schema.post_order_memberships
            WHERE source = 'seed_current' AND left_at IS NULL
            ORDER BY order_id, kind`,
        );
      expect(seeded).toEqual([
        { order_id: '1', kind: 'DELIVERY', post_id: '10' },
        { order_id: '2', kind: 'CANCELED', post_id: '20' },
        { order_id: '3', kind: 'CANCELED', post_id: '21' },
        { order_id: '3', kind: 'DELIVERY', post_id: '11' },
        { order_id: '5', kind: 'DELIVERY', post_id: '12' },
        { order_id: '8', kind: 'DELIVERY', post_id: '103' },
      ]);
    });

    it('qayta up() — dublikatsiz, trigger bitta', async () => {
      const before = await db.query(
        `SELECT count(*)::int AS n FROM order_schema.post_order_memberships`,
      );
      await run('up');
      const after = await db.query(
        `SELECT count(*)::int AS n FROM order_schema.post_order_memberships`,
      );
      expect(after).toEqual(before);
      const triggers = await db.query(
        `SELECT count(*)::int AS n FROM pg_trigger
          WHERE tgname = 'TRG_ORDERS_TRACK_POST_MEMBERSHIP' AND NOT tgisinternal`,
      );
      expect(triggers).toEqual([{ n: 1 }]);
      // FK seed'dan keyin qo'shiladi — qayta up() da ham bitta, CASCADE.
      const fks = await db.query(
        `SELECT confdeltype AS del,
                (confrelid = 'order_schema.orders'::regclass) AS orders
           FROM pg_constraint
          WHERE conname = 'FK_POST_ORDER_MEMBERSHIP_ORDER'`,
      );
      expect(fks).toEqual([{ del: 'c', orders: true }]);
    });

    it('CHECK (kind) va ochiq qator unikalligi', async () => {
      await expect(
        db.query(
          `INSERT INTO order_schema.post_order_memberships (order_id, post_id, kind)
           VALUES (1, 99, 'OTHER')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query(
          `INSERT INTO order_schema.post_order_memberships (order_id, post_id, kind)
           VALUES (1, 99, 'DELIVERY')`,
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('trigger', () => {
    it('INSERT: pochtali buyurtma — ochiq qator; pochtasiz — hech narsa', async () => {
      await insertOrder(6, 30);
      await insertOrder(7, null);
      expect(await rows(6)).toEqual([
        {
          order_id: '6',
          post_id: '30',
          kind: 'DELIVERY',
          open: true,
          next_post_id: null,
          source: 'trigger',
        },
      ]);
      expect(await rows(7)).toEqual([]);
    });

    it('ko`chish (repository.update): eski yopiladi (next), yangi ochiladi — ayni vaqt', async () => {
      await db.getRepository(Order).update({ id: '1' }, { post_id: '40' });
      expect(await rows(1)).toEqual([
        expect.objectContaining({
          post_id: '10',
          open: false,
          next_post_id: '40',
          source: 'seed_current',
        }),
        expect.objectContaining({
          post_id: '40',
          open: true,
          source: 'trigger',
        }),
      ]);
      const [times] = await db.query(
        `SELECT bool_and(a.left_at = b.joined_at) AS same
           FROM order_schema.post_order_memberships a
           JOIN order_schema.post_order_memberships b
             ON b.order_id = a.order_id AND b.post_id = 40
          WHERE a.order_id = 1 AND a.post_id = 10`,
      );
      expect(times.same).toBe(true);
    });

    it('NULL ga: yopiladi, next=null, ochiq qator qolmaydi', async () => {
      await db.query(
        `UPDATE order_schema.orders SET post_id = NULL WHERE id = 1`,
      );
      const list = await rows(1);
      expect(list.filter((r) => r.open)).toEqual([]);
      expect(list[1]).toMatchObject({ post_id: '40', next_post_id: null });
    });

    it('qiymat o`zgarmasa yoki boshqa ustun — yangi qator yo`q', async () => {
      const before = await rows(6);
      await db.query(
        `UPDATE order_schema.orders SET post_id = post_id WHERE id = 6`,
      );
      await db.query(
        `UPDATE order_schema.orders SET total_price = 2000 WHERE id = 6`,
      );
      expect(await rows(6)).toEqual(before);
    });

    it('CANCELED alohida kuzatiladi, DELIVERY tegilmaydi', async () => {
      await db.query(
        `UPDATE order_schema.orders SET canceled_post_id = 50 WHERE id = 3`,
      );
      const list = await rows(3);
      expect(list.filter((r) => r.kind === 'DELIVERY')).toEqual([
        expect.objectContaining({ post_id: '11', open: true }),
      ]);
      expect(list.filter((r) => r.kind === 'CANCELED')).toEqual([
        expect.objectContaining({
          post_id: '21',
          open: false,
          next_post_id: '50',
        }),
        expect.objectContaining({ post_id: '50', open: true }),
      ]);
    });

    it('bitta tranzaksiyada 60 → 61 → 62: oraliqlar yopiq, vaqt o`sadi va uzluksiz', async () => {
      await db.transaction(async (tx) => {
        for (const post of [60, 61, 62]) {
          await tx.query(
            `UPDATE order_schema.orders SET post_id = $1 WHERE id = 7`,
            [post],
          );
        }
      });
      // clock_timestamp(): now() bo'lsa uchalasi ayni vaqtda (nol uzunlik).
      const list: Array<{
        post_id: string;
        positive: boolean | null;
        chained: boolean | null;
        open: boolean;
      }> = await db.query(
        `SELECT post_id::text, (left_at > joined_at) AS positive,
                (left_at = lead(joined_at) OVER (ORDER BY id)) AS chained,
                (left_at IS NULL) AS open
           FROM order_schema.post_order_memberships
          WHERE order_id = 7 ORDER BY id`,
      );
      expect(list).toEqual([
        { post_id: '60', positive: true, chained: true, open: false },
        { post_id: '61', positive: true, chained: true, open: false },
        { post_id: '62', positive: null, chained: null, open: true },
      ]);
    });

    it('erta boshlangan tranzaksiya keyinroq ko`chirsa — vaqtlar tartibli (now() emas)', async () => {
      await insertOrder(15, 150);
      const t1 = db.createQueryRunner();
      await t1.connect();
      try {
        await t1.startTransaction();
        await t1.query(`SELECT now()`); // T1 tranzaksiya vaqti shu yerda
        // T2 (boshqa ulanish) ko'chiradi va commit qiladi.
        await db.query(
          `UPDATE order_schema.orders SET post_id = 151 WHERE id = 15`,
        );
        await t1.query(
          `UPDATE order_schema.orders SET post_id = 152 WHERE id = 15`,
        );
        await t1.commitTransaction();
      } finally {
        await t1.release();
      }
      const list: Array<{ post_id: string; ok: boolean }> = await db.query(
        `SELECT post_id::text, (left_at IS NULL OR left_at >= joined_at) AS ok
           FROM order_schema.post_order_memberships
          WHERE order_id = 15 ORDER BY joined_at, id`,
      );
      expect(list).toEqual([
        { post_id: '150', ok: true },
        { post_id: '151', ok: true },
        { post_id: '152', ok: true },
      ]);
    });

    it('ommaviy UPDATE (kuryerga biriktirish kabi) — har buyurtma kuzatiladi', async () => {
      await db.query(
        `UPDATE order_schema.orders SET post_id = 70 WHERE id = ANY($1::bigint[])`,
        [['6', '7']],
      );
      for (const id of [6, 7]) {
        const open = (await rows(id)).filter((r) => r.open);
        expect(open).toEqual([expect.objectContaining({ post_id: '70' })]);
      }
    });

    it('repository.save (entity) — kuzatiladi', async () => {
      const repo = db.getRepository(Order);
      const order = await repo.findOneByOrFail({ id: '6' });
      order.post_id = '71';
      await repo.save(order);
      expect((await rows(6)).filter((r) => r.open)).toEqual([
        expect.objectContaining({ post_id: '71' }),
      ]);
    });

    it('buyurtma qattiq o`chsa tarixi ham ketadi (CASCADE)', async () => {
      await insertOrder(90, 91);
      expect(await rows(90)).toHaveLength(1);
      await db.query(`DELETE FROM order_schema.orders WHERE id = 90`);
      expect(await rows(90)).toEqual([]);
    });
  });

  describe('order.post_membership.find', () => {
    it('pochta 10 / 40 tarixi joined_at bo`yicha, ISO vaqtlar', async () => {
      const service = new PostMembershipService(db);
      const res = await service.findByPostIds({ post_ids: ['40', 10] });
      const data = res.data as PostMembershipRow[];
      expect(data.map((r) => [r.order_id, r.post_id, r.kind])).toEqual([
        ['1', '10', 'DELIVERY'],
        ['1', '40', 'DELIVERY'],
      ]);
      expect(res.data[0]).toMatchObject({ next_post_id: '40' });
      expect(res.data[0].left_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
      expect(res.data[1]).toMatchObject({ next_post_id: null });
    });
  });

  describe('backfill', () => {
    beforeAll(async () => {
      const outbox = db.getRepository(OutboxEvent);
      const upsert = (id: string, metadata: Record<string, unknown>) => ({
        source: 'order',
        type: 'order',
        sourceId: id,
        metadata,
      });
      // #8: 101 → (tx: eskirgan 999, keyin 102) → 103 (hozirgi, seed).
      await outbox.insert([
        {
          target: 'SEARCH',
          pattern: 'search.index.upsert',
          payload: upsert('8', { post_id: '101', canceled_post_id: null }),
          created_at: at('2026-01-01T08:00:00.000Z'),
        },
        {
          target: 'SEARCH',
          pattern: 'search.index.upsert',
          payload: upsert('8', { post_id: '999', canceled_post_id: null }),
          created_at: at('2026-01-02T08:00:00.000Z'),
        },
        {
          target: 'SEARCH',
          pattern: 'search.index.upsert',
          payload: upsert('8', { post_id: '102', canceled_post_id: null }),
          created_at: at('2026-01-02T08:00:00.000Z'),
        },
        {
          target: 'SEARCH',
          pattern: 'search.index.upsert',
          payload: upsert('8', { post_id: 103 }),
          created_at: at('2026-01-03T08:00:00.000Z'),
        },
        // Pochta surati — e'tiborsiz.
        {
          target: 'SEARCH',
          pattern: 'search.index.upsert',
          payload: {
            source: 'logistics',
            type: 'post',
            sourceId: '8',
            metadata: { post_id: '555' },
          },
          created_at: at('2026-01-02T09:00:00.000Z'),
        },
        // Kalitsiz surat — "noma'lum", bo'sh emas.
        {
          target: 'SEARCH',
          pattern: 'search.index.upsert',
          payload: upsert('8', { status: 'received' }),
          created_at: at('2026-01-02T10:00:00.000Z'),
        },
      ]);
      // #9: outbox yo'q — jurnallar: qabul (201) → kuryer (202) → qaytarish (null).
      await db.query(
        `INSERT INTO order_schema.activity_logs
           (entity_type, entity_id, action, new_value, created_at)
         VALUES
           ('Order', '9', 'status_change',
            '{"status":"received","post_id":"201"}', '2025-12-01T08:00:00Z'),
           ('Order', '9', 'updated', '{"post_id":null}', '2025-12-09T08:00:00Z')`,
      );
      await db.query(
        `INSERT INTO logistics_schema.activity_logs
           (entity_type, entity_id, action, new_value, created_at)
         VALUES ('Order', '9', 'assign', '{"courier_id":"7","post_id":"202"}',
                 '2025-12-05T08:00:00Z')`,
      );
      await db.query(
        `INSERT INTO logistics_schema.posts (id, status, order_quantity)
         VALUES (101, 'received', 1), (201, 'received', 5), (202, 'received', 0)`,
      );
    });

    const counts = async () =>
      db.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM order_schema.post_order_memberships`,
      );

    it('dry-run: hech narsa yozilmaydi, hisobot rejani ko`rsatadi', async () => {
      const before = await counts();
      const runner = db.createQueryRunner();
      await runner.connect();
      try {
        const report = await runPostMembershipBackfill(runner, {
          apply: false,
          batchSize: 1,
          reportLimit: 50,
        });
        expect(report.apply).toBe(false);
        expect(report.staysPlanned).toBe(4);
        expect(report.staysInserted).toBe(0);
        expect(report.joinedAtFixesPlanned).toBe(1);
        expect(report.staysBySource).toEqual({
          backfill_outbox: 2,
          backfill_order_activity: 1,
          backfill_logistics_activity: 1,
        });
        const byPost = Object.fromEntries(
          report.posts.map((p) => [p.post_id, p]),
        );
        expect(byPost['201']).toMatchObject({
          status: 'received',
          order_quantity: 5,
          members: 1,
          new_members: 1,
        });
        expect(byPost['102']).toMatchObject({ status: null, members: 1 });
        expect(byPost['999']).toBeUndefined();
        expect(byPost['555']).toBeUndefined();
      } finally {
        await runner.release();
      }
      expect(await counts()).toEqual(before);
    });

    it('apply: yopiq turishlar + seed joined_at; qayta apply — 0', async () => {
      const runner = db.createQueryRunner();
      await runner.connect();
      try {
        const report = await runPostMembershipBackfill(runner, {
          apply: true,
          batchSize: 2,
          reportLimit: 50,
        });
        expect(report.staysInserted).toBe(4);
        expect(report.joinedAtFixesApplied).toBe(1);

        const order8: Array<Record<string, unknown>> = await db.query(
          `SELECT post_id::text, joined_at, left_at, next_post_id::text, source
             FROM order_schema.post_order_memberships
            WHERE order_id = 8 ORDER BY joined_at`,
        );
        expect(order8).toEqual([
          {
            post_id: '101',
            joined_at: at('2026-01-01T08:00:00.000Z'),
            left_at: at('2026-01-02T08:00:00.000Z'),
            next_post_id: '102',
            source: 'backfill_outbox',
          },
          {
            post_id: '102',
            joined_at: at('2026-01-02T08:00:00.000Z'),
            left_at: at('2026-01-03T08:00:00.000Z'),
            next_post_id: '103',
            source: 'backfill_outbox',
          },
          {
            post_id: '103',
            joined_at: at('2026-01-03T08:00:00.000Z'),
            left_at: null,
            next_post_id: null,
            source: 'seed_current',
          },
        ]);

        const order9: Array<Record<string, unknown>> = await db.query(
          `SELECT post_id::text, joined_at, left_at, next_post_id::text, source
             FROM order_schema.post_order_memberships
            WHERE order_id = 9 ORDER BY joined_at`,
        );
        expect(order9).toEqual([
          {
            post_id: '201',
            joined_at: at('2025-12-01T08:00:00.000Z'),
            left_at: at('2025-12-05T08:00:00.000Z'),
            next_post_id: '202',
            source: 'backfill_order_activity',
          },
          {
            post_id: '202',
            joined_at: at('2025-12-05T08:00:00.000Z'),
            left_at: at('2025-12-09T08:00:00.000Z'),
            next_post_id: null,
            source: 'backfill_logistics_activity',
          },
        ]);

        const again = await runPostMembershipBackfill(runner, {
          apply: true,
          batchSize: 500,
          reportLimit: 50,
        });
        expect(again.staysPlanned).toBe(0);
        expect(again.staysInserted).toBe(0);
        expect(again.joinedAtFixesPlanned).toBe(0);
      } finally {
        await runner.release();
      }
    });

    it('eski pochta 201 endi o`z buyurtmasini ko`rsatadi (find)', async () => {
      const res = await new PostMembershipService(db).findByPostIds({
        post_ids: ['201'],
      });
      expect(res.data).toEqual([
        {
          order_id: '9',
          post_id: '201',
          kind: 'DELIVERY',
          joined_at: '2025-12-01T08:00:00.000Z',
          left_at: '2025-12-05T08:00:00.000Z',
          next_post_id: '202',
        },
      ]);
    });

    it('bir buyurtmaning ko`p turishi INSERT bo`laklariga bo`linmaydi (insertChunk: 2); qayta — 0', async () => {
      const event = (orderId: string, postId: string, iso: string) => ({
        target: 'SEARCH',
        pattern: 'search.index.upsert',
        payload: {
          source: 'order',
          type: 'order',
          sourceId: orderId,
          metadata: { post_id: postId },
        },
        created_at: at(iso),
      });
      await insertOrder(12, 403); // trigger qatori — seed vaqtidan keyin
      await insertOrder(13, null);
      const history12 = ['401', '402', '401', '402', '401', '402', '401'];
      await db
        .getRepository(OutboxEvent)
        .insert([
          ...history12.map((post, i) =>
            event('12', post, `2025-11-0${i + 1}T08:00:00.000Z`),
          ),
          event('13', '411', '2025-11-10T08:00:00.000Z'),
          event('13', '412', '2025-11-11T08:00:00.000Z'),
        ]);

      const runner = db.createQueryRunner();
      await runner.connect();
      try {
        const report = await runPostMembershipBackfill(runner, {
          apply: true,
          batchSize: 500,
          reportLimit: 50,
          insertChunk: 2,
        });
        // Eski bo'laklash: 2 ta yozilib, #12 ning qolgan 5 tasi tashlanardi.
        expect(report.staysPlanned).toBe(9);
        expect(report.staysInserted).toBe(9);

        const order12: Array<{ post_id: string; source: string }> =
          await db.query(
            `SELECT post_id::text, source
               FROM order_schema.post_order_memberships
              WHERE order_id = 12 ORDER BY joined_at, id`,
          );
        expect(order12.map((r) => r.post_id)).toEqual([...history12, '403']);
        expect(order12.map((r) => r.source)).toEqual([
          ...history12.map(() => 'backfill_outbox'),
          'trigger',
        ]);
        expect(
          (
            await db.query<Array<{ n: number }>>(
              `SELECT count(*)::int AS n FROM order_schema.post_order_memberships
                WHERE order_id = 13`,
            )
          )[0].n,
        ).toBe(2);

        const again = await runPostMembershipBackfill(runner, {
          apply: true,
          batchSize: 500,
          reportLimit: 50,
          insertChunk: 2,
        });
        expect(again.staysPlanned).toBe(0);
        expect(again.staysInserted).toBe(0);
      } finally {
        await runner.release();
      }
    });
  });

  describe('down()', () => {
    it('trigger, funksiya, jadval o`chadi; buyurtma yangilash ishlaydi; qayta up()', async () => {
      await run('down');
      const [state] = await db.query(
        `SELECT to_regclass('order_schema.post_order_memberships') AS t,
                to_regprocedure('order_schema.track_post_membership()') AS f`,
      );
      expect(state).toEqual({ t: null, f: null });
      await db.query(
        `UPDATE order_schema.orders SET post_id = 80 WHERE id = 6`,
      );
      await run('down'); // qayta down — xatosiz
      await run('up');
      expect(await rows(6)).toEqual([
        expect.objectContaining({ post_id: '80', source: 'seed_current' }),
      ]);
    });
  });
});
