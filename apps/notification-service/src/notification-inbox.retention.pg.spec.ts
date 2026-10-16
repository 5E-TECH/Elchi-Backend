import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { DataSource, Logger as TypeOrmLogger } from 'typeorm';
import { Order_status } from '@app/common';
import { CreateNotifications1716000000008 } from '../../../migrations/1716000000008-CreateNotifications';
import { CreateNotificationDispatches1716000000084 } from '../../../migrations/1716000000084-CreateNotificationDispatches';
import { NotificationRetentionIndex1716000000108 } from '../../../migrations/1716000000108-NotificationRetentionIndex';
import { Notification } from './entities/notification.entity';
import { NotificationInboxService } from './notification-inbox.service';
import { InboxPolicyService } from './retention/inbox-policy.service';
import {
  NOTIF_RETENTION_LOCK_NAME,
  NotificationRetentionService,
} from './retention/notification-retention.service';
import { buildOrderNotificationPayload } from '../../order-service/src/notification/order-notification.service';

/**
 * A1HzKEby — HAQIQIY Postgres:
 * - unreadCount 100 000 qatorli jadvalda EXPLAIN bo'yicha IDX_NOTIF_RECIPIENT_READ;
 * - markAllRead — query logda BITTA UPDATE;
 * - retention: partiyali DELETE (har biri LIMIT bilan), critical o'chmaydi,
 *   o'qilmaganlar uzoqroq turadi, dry run hech narsa o'chirmaydi,
 *   IDX_NOTIF_RETENTION ishlatiladi (migratsiya 1716000000108);
 * - soatlik chegara (DISTINCT ON + COUNT OVER) va 5 status → 1 qator haqiqiy SQL'da;
 * - group_key NULL eski qatorlar ro'yxat/filtr/sanoqlarda.
 *
 *   NOTIFICATION_PG_TEST_URI=postgres://postgres@127.0.0.1:55492/elchi_n2_test \
 *     npx jest apps/notification-service/src/notification-inbox.retention.pg.spec.ts --runInBand
 *
 * ⚠️ FAQAT lokal test bazasi (127.0.0.1 / localhost).
 */
const uri = process.env.NOTIFICATION_PG_TEST_URI;
const isLocal = (() => {
  if (!uri) return false;
  try {
    return ['127.0.0.1', 'localhost'].includes(new URL(uri).hostname);
  } catch {
    return false;
  }
})();

/** Test qatorlari shu oraliqda — boshqa ma'lumot bilan to'qnashmaydi. */
const BASE = 881_000_000_000;
const BIG_BASE = 882_000_000_000;
const T = 'notification_schema.notifications';

class QueryLog implements TypeOrmLogger {
  entries: Array<{ query: string; parameters?: unknown[] }> = [];
  reset() {
    this.entries = [];
  }
  logQuery(query: string, parameters?: unknown[]) {
    this.entries.push({ query, parameters });
  }
  logQueryError() {}
  logQuerySlow() {}
  logSchemaBuild() {}
  logMigration() {}
  log() {}
}

const policyWith = (env: Record<string, unknown>) =>
  new InboxPolicyService({
    get: (key: string) => env[key],
  } as unknown as ConfigService);

(isLocal ? describe : describe.skip)(
  'A1HzKEby — inbox retention, indekslar va bo‘ron chegarasi (haqiqiy PG)',
  () => {
    let ds: DataSource;
    const sql = new QueryLog();

    const inbox = (policy?: InboxPolicyService) =>
      new NotificationInboxService(
        ds.getRepository(Notification),
        { send: jest.fn() } as never,
        { emit: jest.fn(() => of(null)) } as never,
        { sendNotification: jest.fn() } as never,
        { log: jest.fn().mockResolvedValue(undefined) } as never,
        { enqueue: jest.fn().mockResolvedValue(undefined) } as never,
        { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        policy,
      );

    const retention = (env: Record<string, unknown> = {}) =>
      new NotificationRetentionService(
        policyWith({
          NOTIF_RETENTION_ENABLED: 'true',
          NOTIF_RETENTION_BATCH_SIZE: 100,
          NOTIF_RETENTION_MAX_BATCHES: 1000,
          ...env,
        }),
        ds.getRepository(Notification),
        { addCronJob: jest.fn() } as never,
        ds,
      );

    /** Yoshi `days` kun bo'lgan `n` ta qator. */
    const seed = async (
      n: number,
      opts: { days: number; read: boolean; priority?: string; rid?: number },
    ) =>
      ds.query(
        'INSERT INTO ' +
          T +
          ' (recipient_id, type, title, priority, is_read, "createdAt") ' +
          "SELECT $1::bigint, 'x.retention', 'eski', $2::notification_schema.notifications_priority_enum, $3, now() - make_interval(days => $4::int) " +
          'FROM generate_series(1, $5::int)',
        [opts.rid ?? BASE, opts.priority ?? 'normal', opts.read, opts.days, n],
      );

    const countWhere = async (where: string, params: unknown[] = []) =>
      Number(
        (
          await ds.query(
            'SELECT count(*)::int AS c FROM ' + T + ' WHERE ' + where,
            params,
          )
        )[0].c,
      );

    const explain = async (query: string, parameters: unknown[] = []) =>
      (await ds.query('EXPLAIN ' + query, parameters))
        .map((row) => row['QUERY PLAN'])
        .join('\n');

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      ds = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [Notification],
        logging: ['query'],
        logger: sql,
      });
      await ds.initialize();
      const runner = ds.createQueryRunner();
      try {
        await new CreateNotifications1716000000008().up(runner);
        await new CreateNotificationDispatches1716000000084().up(runner);
        await new NotificationRetentionIndex1716000000108().up(runner);
      } finally {
        await runner.release();
      }
      await ds.query(
        'DELETE FROM ' + T + ' WHERE recipient_id >= $1 AND recipient_id < $2',
        [BASE, BIG_BASE + 1_000_000],
      );
      // 100 000 qator: 2000 qabul qiluvchi × 50, har birida 10 tasi o'qilmagan.
      await ds.query(
        'INSERT INTO ' +
          T +
          ' (recipient_id, type, title, is_read, group_key) ' +
          "SELECT $1::bigint + (g % 2000), 'x.big', 'fon', ((g / 2000) % 5) <> 0, NULL " +
          'FROM generate_series(1, 100000) AS g',
        [BIG_BASE],
      );
      await ds.query('ANALYZE ' + T);
    }, 120_000);

    afterAll(async () => {
      if (ds?.isInitialized) {
        await ds.query(
          'DELETE FROM ' +
            T +
            ' WHERE recipient_id >= $1 AND recipient_id < $2',
          [BASE, BIG_BASE + 1_000_000],
        );
        await ds.destroy();
      }
      jest.restoreAllMocks();
    });

    beforeEach(async () => {
      await ds.query(
        'DELETE FROM ' + T + ' WHERE recipient_id >= $1 AND recipient_id < $2',
        [BASE, BIG_BASE],
      );
      sql.reset();
    });

    it('migratsiya 1716000000108: qisman indeks (is_read, createdAt) WHERE priority <> critical; qayta up/down xavfsiz', async () => {
      const def = async () =>
        (
          await ds.query(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'notification_schema' AND indexname = 'IDX_NOTIF_RETENTION'",
          )
        )[0]?.indexdef;
      const indexdef = await def();
      expect(indexdef).toContain('(is_read, "createdAt")');
      expect(indexdef).toContain("WHERE (priority <> 'critical'");
      const runner = ds.createQueryRunner();
      try {
        const mig = new NotificationRetentionIndex1716000000108();
        await mig.up(runner);
        await mig.down(runner);
        expect(await def()).toBeUndefined();
        await mig.up(runner);
      } finally {
        await runner.release();
      }
      expect(await def()).toBeDefined();
    });

    it('unreadCount: 100 000 qatorli jadvalda EXPLAIN — IDX_NOTIF_RECIPIENT_READ', async () => {
      expect(await countWhere('recipient_id >= $1', [BIG_BASE])).toBe(100000);
      const service = inbox();
      sql.reset();
      const res: any = await service.unreadCount(String(BIG_BASE + 7));
      expect(res.data.unread).toBe(10);
      const select = sql.entries.find((e) => /^SELECT/i.test(e.query.trim()));
      expect(select).toBeDefined();
      const plan = await explain(select!.query, select!.parameters);
      expect(plan).toContain('IDX_NOTIF_RECIPIENT_READ');
      expect(plan).not.toMatch(/Seq Scan/);
    });

    it('markAllRead — query logda BITTA UPDATE (SELECT/sikl yo‘q)', async () => {
      const rid = String(BIG_BASE + 11);
      expect(
        await countWhere('recipient_id = $1 AND is_read = false', [rid]),
      ).toBe(10);
      const service = inbox();
      sql.reset();
      const res: any = await service.markAllRead(rid);
      const queries = sql.entries.map((e) => e.query.trim());
      expect(queries).toHaveLength(1);
      expect(queries[0]).toMatch(/^UPDATE/i);
      expect(res.data.updated).toBe(10);
      expect(
        await countWhere('recipient_id = $1 AND is_read = false', [rid]),
      ).toBe(0);
      // Boshqa foydalanuvchiga tegmaydi.
      expect(
        await countWhere('recipient_id = $1 AND is_read = false', [
          String(BIG_BASE + 12),
        ]),
      ).toBe(10);
    });

    const seedRetentionSet = async () => {
      await seed(250, { days: 61, read: true }); // o'chadi
      await seed(30, { days: 30, read: true }); // qoladi (yosh)
      await seed(120, { days: 100, read: false }); // qoladi: o'qilmagan < 180
      await seed(130, { days: 200, read: false }); // o'chadi
      await seed(40, { days: 400, read: true, priority: 'critical' }); // qoladi
      await seed(20, { days: 400, read: false, priority: 'critical' }); // qoladi
    };
    const mine = () => countWhere('recipient_id = $1', [BASE]);

    it('dry run: faqat sanaydi (SELECT count), hech narsa o‘chirilmaydi', async () => {
      await seedRetentionSet();
      sql.reset();
      const res = await retention({ NOTIF_RETENTION_DRY_RUN: 'true' }).prune();
      expect(res.dry_run).toBe(true);
      expect(res.eligible).toEqual({ read: 250, unread: 130 });
      expect(res.deleted).toEqual({ read: 0, unread: 0 });
      expect(await mine()).toBe(590);
      expect(sql.entries.some((e) => /^DELETE/i.test(e.query.trim()))).toBe(
        false,
      );
    });

    it('partiyalab (LIMIT) o‘chiradi: o‘qilgan > 60 kun, o‘qilmagan > 180 kun; critical va yoshlar qoladi', async () => {
      await seedRetentionSet();
      sql.reset();
      const res = await retention().prune();
      expect(res.deleted).toEqual({ read: 250, unread: 130 });
      expect(res.stopped).toBe('done');
      const deletes = sql.entries.filter((e) =>
        /^DELETE/i.test(e.query.trim()),
      );
      // 250 → 100+100+50, 130 → 100+30: bitta katta DELETE YO'Q.
      expect(deletes).toHaveLength(5);
      expect(res.batches).toBe(5);
      for (const d of deletes) expect(d.query).toMatch(/LIMIT 100/);
      expect(await mine()).toBe(30 + 120 + 40 + 20);
      expect(
        await countWhere("recipient_id = $1 AND priority = 'critical'", [BASE]),
      ).toBe(60);
      expect(
        await countWhere('recipient_id = $1 AND is_read = false', [BASE]),
      ).toBe(120 + 20);
      // 100 000 ta yangi fon qatoriga tegmagan.
      expect(await countWhere('recipient_id >= $1', [BIG_BASE])).toBe(100000);
    });

    it('DELETE partiyasi IDX_NOTIF_RETENTION qisman indeksidan foydalanadi (to‘liq skan emas)', async () => {
      await seedRetentionSet();
      await ds.query('ANALYZE ' + T);
      sql.reset();
      await retention({ NOTIF_RETENTION_MAX_BATCHES: 1 }).prune();
      const del = sql.entries.find((e) => /^DELETE/i.test(e.query.trim()))!;
      const plan = await explain(del.query, del.parameters);
      expect(plan).toContain('IDX_NOTIF_RETENTION');
    });

    it('bitta ishga tushishda max partiya chegarasi — qolgani keyingi kunga', async () => {
      await seed(250, { days: 61, read: true });
      const res = await retention({ NOTIF_RETENTION_MAX_BATCHES: 2 }).prune();
      expect(res.deleted.read).toBe(200);
      expect(res.stopped).toBe('max_batches');
      expect(await mine()).toBe(50);
    });

    it('tick: advisory lock — boshqa replika ishlayotgan bo‘lsa o‘tkazib yuboradi', async () => {
      await seed(10, { days: 61, read: true });
      const holder = ds.createQueryRunner();
      await holder.connect();
      try {
        await holder.query('SELECT pg_advisory_lock(hashtext($1))', [
          NOTIF_RETENTION_LOCK_NAME,
        ]);
        expect(await retention().tick()).toBeNull();
        expect(await mine()).toBe(10);
      } finally {
        await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [
          NOTIF_RETENTION_LOCK_NAME,
        ]);
        await holder.release();
      }
      const res = await retention().tick();
      expect(res?.deleted.read).toBe(10);
      expect(await mine()).toBe(0);
    });

    it('soatlik chegara haqiqiy SQL’da (DISTINCT ON + COUNT OVER): 5 xabar, chegara 3 → 3 qator, oxirgisida count 3', async () => {
      const service = inbox(policyWith({ NOTIF_HOURLY_CAP_PER_TYPE: 3 }));
      for (let n = 1; n <= 5; n += 1) {
        await service.dispatch({
          recipient_id: String(BASE + 1),
          type: 'system.manual',
          title: 'Xabar ' + n,
          data: { n },
          request_id: 'pg-cap-' + n,
        } as never);
      }
      const rows = await ds.query(
        'SELECT title, data, group_key FROM ' +
          T +
          ' WHERE recipient_id = $1 ORDER BY "createdAt" DESC, id DESC',
        [BASE + 1],
      );
      expect(rows).toHaveLength(3);
      expect(rows[0].title).toBe('Xabar 5');
      expect(rows[0].data).toEqual({ n: 5, count: 3 });
    });

    it('bitta buyurtma 5 status → har qabul qiluvchida 1 qator, data.count = 5 (haqiqiy PG)', async () => {
      const service = inbox(policyWith({}));
      const order = (status: Order_status) =>
        ({
          id: '81',
          market_id: String(BASE + 5),
          operator_id: String(BASE + 9),
          status,
          total_price: 1000,
          address: 'x',
          comment: null,
          return_reason: null,
        }) as never;
      const chain: Array<[string, Order_status, Order_status | null]> = [
        ['order.created', Order_status.NEW, null],
        ['order.accepted', Order_status.RECEIVED, Order_status.NEW],
        ['order.on_way', Order_status.ON_THE_ROAD, Order_status.RECEIVED],
        [
          'order.not_accepted',
          Order_status.WAITING_CUSTOMER,
          Order_status.ON_THE_ROAD,
        ],
        ['order.sold', Order_status.SOLD, Order_status.WAITING_CUSTOMER],
      ];
      for (const [type, status, from] of chain) {
        await service.dispatch({
          ...buildOrderNotificationPayload(type as never, order(status), from)!,
          request_id: 'pg-' + type,
        } as never);
      }
      const rows = await ds.query(
        'SELECT recipient_id, type, group_key, data FROM ' +
          T +
          ' WHERE recipient_id IN ($1, $2) ORDER BY recipient_id',
        [BASE + 5, BASE + 9],
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.type).toBe('order.sold');
        expect(row.group_key).toBe('order:81:status');
        expect(row.data.count).toBe(5);
      }
    });

    it('group_key NULL eski qatorlar ro‘yxat, filtr va sanoqlarda xatosiz', async () => {
      const rid = String(BASE + 20);
      await ds.query(
        'INSERT INTO ' +
          T +
          ' (recipient_id, type, category, priority, title, is_read, group_key) VALUES ' +
          "($1, 'order.sold', 'order', 'high', 'eski-1', false, NULL), " +
          "($1, 'finance.payment_received', 'finance', 'normal', 'eski-2', true, NULL)",
        [rid],
      );
      const service = inbox();
      await service.dispatch({
        recipient_id: rid,
        type: 'order.sold',
        title: 'yangi',
        data: { order_id: 7 },
      } as never);
      const all: any = await service.list({ recipient_id: rid } as never);
      expect(all.data.meta.total).toBe(3);
      const unreadOrders: any = await service.list({
        recipient_id: rid,
        is_read: false,
        category: 'order',
        type: 'order.sold',
      } as never);
      expect(unreadOrders.data.items.map((i: any) => i.title).sort()).toEqual([
        'eski-1',
        'yangi',
      ]);
      const important: any = await service.list({
        recipient_id: rid,
        important: true,
      } as never);
      expect(important.data.items.map((i: any) => i.title)).toEqual(['eski-1']);
      const counts: any = await service.counts(rid);
      expect(counts.data.categories.order).toEqual({ total: 2, unread: 2 });
      expect(counts.data.categories.finance).toEqual({ total: 1, unread: 0 });
      const unread: any = await service.unreadCount(rid);
      expect(unread.data.unread).toBe(2);
    });
  },
);
