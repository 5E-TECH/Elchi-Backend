import { DataSource } from 'typeorm';
import { NotificationDispatchKeys1716000000124 } from '../../../../migrations/1716000000124-NotificationDispatchKeys';
import { Notification } from '../entities/notification.entity';
import { DispatchDedupService } from './dispatch-dedup.service';

/**
 * rzGKtE9N TC5 — dispatch dedup kaliti HAQIQIY Postgres'da (faqat lokal test
 * bazasi): migratsiya 124 (qayta ishga tushirish xavfsiz), parallel egallash
 * — faqat bittasi, rollback — kalit ham qaytadi.
 *
 *   BOT_PG_TEST_URI=postgres://postgres@127.0.0.1:55443/elchi_bot_test npx jest dispatch-dedup.pg
 * (spec yonma-yon `elchi_dispatch_dedup_test` bazasini yaratadi.)
 */
const uri = process.env.BOT_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return ['127.0.0.1', 'localhost'].includes(url.hostname);
})();
const DB = 'elchi_dispatch_dedup_test';

(localTestDatabase ? describe : describe.skip)(
  'dispatch dedup — lokal Postgres (rzGKtE9N TC5)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;
    let dedup: DispatchDedupService;

    beforeAll(async () => {
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
        schema: 'notification_schema',
        entities: [Notification],
        extra: { max: 10 },
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
      await db.query('CREATE SCHEMA notification_schema');
      const runner = db.createQueryRunner();
      try {
        await new NotificationDispatchKeys1716000000124().up(runner);
        await new NotificationDispatchKeys1716000000124().up(runner);
      } finally {
        await runner.release();
      }
      dedup = new DispatchDedupService(db.getRepository(Notification));
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
        await db.destroy();
      }
    });

    it('⭐ bir kalitni 5 ta parallel tranzaksiya egallaydi — faqat BITTASI yutadi', async () => {
      const key = DispatchDedupService.key('finance.payment_received', 'req-1');
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          db.transaction((manager) => dedup.claim(manager, key)),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await dedup.seen(key)).toBe(true);
    });

    it('tranzaksiya rollback — kalit ham qaytadi (qayta urinish yo‘qolmaydi)', async () => {
      const key = DispatchDedupService.key('order.cancelled', 'req-rollback');
      await expect(
        db.transaction(async (manager) => {
          expect(await dedup.claim(manager, key)).toBe(true);
          throw new Error('inbox INSERT yiqildi');
        }),
      ).rejects.toThrow('inbox INSERT yiqildi');
      expect(await dedup.seen(key)).toBe(false);
      expect(await db.transaction((manager) => dedup.claim(manager, key))).toBe(
        true,
      );
    });

    it('7 kundan eski kalitlar tozalash so‘rovi bilan o‘chadi', async () => {
      await db.query(
        `INSERT INTO notification_schema.notification_dispatch_keys ("key", "created_at")
         VALUES ('old:1', now() - interval '8 days'), ('new:1', now())`,
      );
      await db.query(
        `DELETE FROM "notification_schema"."notification_dispatch_keys"
          WHERE "created_at" < now() - interval '7 days'`,
      );
      expect(await dedup.seen('old:1')).toBe(false);
      expect(await dedup.seen('new:1')).toBe(true);
    });

    it('down() jadvalni olib tashlaydi', async () => {
      const runner = db.createQueryRunner();
      try {
        await new NotificationDispatchKeys1716000000124().down(runner);
        const [row]: Array<{ name: string | null }> = await db.query(
          `SELECT to_regclass('notification_schema.notification_dispatch_keys')::text AS name`,
        );
        expect(row.name).toBeNull();
        await new NotificationDispatchKeys1716000000124().up(runner);
      } finally {
        await runner.release();
      }
    });
  },
);
