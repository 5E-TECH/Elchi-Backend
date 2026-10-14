import { RpcException } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { CreatePushSubscriptions1716000000052 } from '../../../../migrations/1716000000052-CreatePushSubscriptions';
import { PushSubscription } from '../entities/push-subscription.entity';
import { PushSubscriptionService } from './push-subscription.service';
import { ChannelPlannerService } from '../channels/channel-planner.service';

/**
 * (kf0uVbyg TC1/TC2/TC3/TC6/TC7/TC8) HAQIQIY Postgres — migratsiya 052 va
 * obuna upsert'i. Unit spec'lar repozitoriyani mock qiladi, shuning uchun
 * UNIQUE indeks va "id o'zgarmaydi" faqat shu yerda haqiqatan tekshiriladi.
 *
 * FAQAT lokal test bazasida (oddiy `jest` va CI'da skip):
 *
 *   NOTIFICATION_PG_TEST_URI=postgres://postgres@127.0.0.1:55443/elchi_c_test \
 *     npx jest apps/notification-service/src/push/push-subscriptions.pg.spec.ts --runInBand
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

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/' + 'a'.repeat(320);

const rpcStatus = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) {
      return (error.getError() as { statusCode?: number }).statusCode;
    }
    throw error;
  }
  return null;
};

(isLocal ? describe : describe.skip)(
  'push_subscriptions — migratsiya 052 + upsert (lokal PG)',
  () => {
    let ds: DataSource;
    let service: PushSubscriptionService;
    const migration = new CreatePushSubscriptions1716000000052();

    beforeAll(async () => {
      ds = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [PushSubscription],
      });
      await ds.initialize();
      await ds.query('CREATE SCHEMA IF NOT EXISTS notification_schema');
      await ds.query(
        'DROP TABLE IF EXISTS notification_schema.push_subscriptions CASCADE',
      );
      const runner = ds.createQueryRunner();
      try {
        await migration.up(runner);
      } finally {
        await runner.release();
      }
      service = new PushSubscriptionService(
        ds.getRepository(PushSubscription),
        { enabled: true, publicKey: 'BPUBLIC' } as never,
      );
    });

    afterAll(async () => {
      if (!ds?.isInitialized) return;
      const runner = ds.createQueryRunner();
      try {
        await migration.down(runner);
      } finally {
        await runner.release();
      }
      await ds.destroy();
    });

    const input = (overrides: Record<string, unknown> = {}) => ({
      user_id: '42',
      endpoint: ENDPOINT,
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      platform: 'android',
      ...overrides,
    });

    it('TC1/TC2: jadval yaratiladi, endpoint ustunida UNIQUE indeks bor (TEXT, kesilmaydi)', async () => {
      const indexes: Array<{ indexname: string; indexdef: string }> =
        await ds.query(
          `SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = 'notification_schema' AND tablename = 'push_subscriptions'`,
        );
      const unique = indexes.find(
        (row) => row.indexname === 'UQ_PUSH_SUBSCRIPTIONS_ENDPOINT',
      );
      expect(unique?.indexdef).toMatch(/UNIQUE INDEX .*\(endpoint\)/);
      expect(indexes.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          'IDX_PUSH_SUBSCRIPTIONS_USER',
          'IDX_PUSH_SUBSCRIPTIONS_USER_LAST_USED',
        ]),
      );
      const [column]: Array<{ data_type: string }> = await ds.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = 'notification_schema'
            AND table_name = 'push_subscriptions' AND column_name = 'endpoint'`,
      );
      expect(column.data_type).toBe('text');
    });

    it('TC3: ayni endpoint 2 marta subscribe — 1 qator, id o‘zgarmaydi, user_id yangilanadi', async () => {
      const first = (await service.subscribe(input())) as {
        data: { id: string };
      };
      const second = (await service.subscribe(
        input({ user_id: '43', keys: { p256dh: 'new-p', auth: 'new-a' } }),
      )) as { data: { id: string } };

      expect(second.data.id).toBe(first.data.id);
      const rows: Array<{ id: string; user_id: string; p256dh: string }> =
        await ds.query(
          'SELECT id, user_id, p256dh FROM notification_schema.push_subscriptions WHERE endpoint = $1',
          [ENDPOINT],
        );
      expect(rows).toEqual([
        { id: first.data.id, user_id: '43', p256dh: 'new-p' },
      ]);
    });

    it('TC7: 256 belgidan uzun user_agent kesilib saqlanadi, xato bermaydi', async () => {
      await service.subscribe(input({ user_agent: 'U'.repeat(900) }));
      const [row]: Array<{ user_agent: string }> = await ds.query(
        'SELECT user_agent FROM notification_schema.push_subscriptions WHERE endpoint = $1',
        [ENDPOINT],
      );
      expect(row.user_agent).toHaveLength(256);
    });

    it('TC8: begona foydalanuvchi o‘chira olmaydi (404), qator joyida qoladi', async () => {
      await service.subscribe(input({ user_id: '42' }));
      expect(
        await rpcStatus(
          service.unsubscribe({ user_id: '999', endpoint: ENDPOINT }),
        ),
      ).toBe(404);
      const [{ count }]: Array<{ count: string }> = await ds.query(
        'SELECT COUNT(*)::text AS count FROM notification_schema.push_subscriptions WHERE endpoint = $1',
        [ENDPOINT],
      );
      expect(count).toBe('1');
    });

    it('Jht84wGp TC3: kanal rejasi obunani BITTA SQL bilan tekshiradi — obunasiz → no_subscription', async () => {
      await service.subscribe(input({ user_id: '42' }));
      const planner = new ChannelPlannerService(
        { mutesFor: jest.fn().mockResolvedValue(new Map()) } as never,
        ds.getRepository(PushSubscription),
        { enabled: true } as never,
        { enabled: false } as never,
        {} as never,
      );
      const plan = await planner.plan({
        type: 'order.manual',
        category: 'order',
        priority: 'normal',
        requested: ['in_app', 'push'],
        recipientIds: ['42', '43'],
      });
      expect(plan.byRecipient.get('42')?.delivery.push).toBe('queued');
      expect(plan.byRecipient.get('43')?.delivery.push).toBe('no_subscription');
    });

    it('TC6: DELETE dan keyin qator o‘chadi va qayta subscribe ishlaydi', async () => {
      await service.unsubscribe({ user_id: '42', endpoint: ENDPOINT });
      const after: unknown[] = await ds.query(
        'SELECT id FROM notification_schema.push_subscriptions WHERE endpoint = $1',
        [ENDPOINT],
      );
      expect(after).toEqual([]);

      const again = (await service.subscribe(input())) as {
        data: { id: string };
      };
      expect(again.data.id).toMatch(/^\d+$/);
      const rows: unknown[] = await ds.query(
        'SELECT id FROM notification_schema.push_subscriptions WHERE endpoint = $1',
        [ENDPOINT],
      );
      expect(rows).toHaveLength(1);
    });
  },
);
