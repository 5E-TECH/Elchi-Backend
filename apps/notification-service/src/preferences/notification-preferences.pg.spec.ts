import { RpcException } from '@nestjs/microservices';
import { DataSource, Logger as TypeOrmLogger } from 'typeorm';
import { NotificationCategory, NotificationPriority } from '@app/common';
import { CreateNotificationPreferences1716000000075 } from '../../../../migrations/1716000000075-CreateNotificationPreferences';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { NotificationPreferencesService } from './notification-preferences.service';

/**
 * (mP1WGG1W TC1–TC3, TC7) HAQIQIY Postgres: migratsiya 075, UNIQUE
 * (user_id, scope, channel), upsert va dispatch filtri SQL'i.
 *
 *   NOTIFICATION_PG_TEST_URI=postgres://postgres@127.0.0.1:55443/elchi_c_test \
 *     npx jest apps/notification-service/src/preferences/notification-preferences.pg.spec.ts --runInBand
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

class SelectCounter implements TypeOrmLogger {
  selects: string[] = [];
  logQuery(query: string) {
    if (/^\s*SELECT .*notification_preferences/is.test(query)) {
      this.selects.push(query);
    }
  }
  logQueryError() {}
  logQuerySlow() {}
  logSchemaBuild() {}
  logMigration() {}
  log() {}
}

(isLocal ? describe : describe.skip)(
  'notification_preferences — migratsiya 075 (lokal PG)',
  () => {
    let ds: DataSource;
    let service: NotificationPreferencesService;
    const counter = new SelectCounter();
    const migration = new CreateNotificationPreferences1716000000075();

    beforeAll(async () => {
      ds = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [NotificationPreference],
        logging: true,
        logger: counter,
      });
      await ds.initialize();
      await ds.query(
        'DROP TABLE IF EXISTS notification_schema.notification_preferences',
      );
      const runner = ds.createQueryRunner();
      try {
        await migration.up(runner);
      } finally {
        await runner.release();
      }
      service = new NotificationPreferencesService(
        ds.getRepository(NotificationPreference),
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

    it('TC1/TC2: jadval, is_deleted (isDeleted EMAS), UNIQUE va IDX_NOTIF_PREF_USER', async () => {
      const columns: Array<{ column_name: string }> = await ds.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'notification_schema' AND table_name = 'notification_preferences'`,
      );
      const names = columns.map((c) => c.column_name);
      expect(names).toEqual(
        expect.arrayContaining([
          'is_deleted',
          'createdAt',
          'updatedAt',
          'user_id',
          'scope',
          'channel',
          'enabled',
        ]),
      );
      expect(names).not.toContain('isDeleted');
      const indexes: Array<{ indexname: string }> = await ds.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'notification_schema' AND tablename = 'notification_preferences'`,
      );
      expect(indexes.map((i) => i.indexname)).toEqual(
        expect.arrayContaining([
          'IDX_NOTIF_PREF_USER',
          'UQ_NOTIF_PREF_USER_SCOPE_CHANNEL',
        ]),
      );
    });

    it('TC3: UNIQUE (user_id, scope, channel) — to‘g‘ridan-to‘g‘ri dublikat INSERT rad etiladi', async () => {
      await ds.query(
        `INSERT INTO notification_schema.notification_preferences (user_id, scope, channel, enabled)
         VALUES (1, 'order', 'push', false)`,
      );
      await expect(
        ds.query(
          `INSERT INTO notification_schema.notification_preferences (user_id, scope, channel, enabled)
           VALUES (1, 'order', 'push', true)`,
        ),
      ).rejects.toThrow(/duplicate key|UQ_NOTIF_PREF_USER_SCOPE_CHANNEL/);
    });

    it('PATCH upsert: ikkinchi marta — yangi qator emas, mavjud yangilanadi; null — soft-delete', async () => {
      await service.update({
        user_id: '42',
        items: [{ scope: 'order', channel: 'push', enabled: false }],
      });
      await service.update({
        user_id: '42',
        items: [
          { scope: 'order', channel: 'push', enabled: true },
          { scope: 'marketing', channel: 'all', enabled: true },
        ],
      });
      const rows: Array<{
        scope: string;
        enabled: boolean;
        is_deleted: boolean;
      }> = await ds.query(
        `SELECT scope, enabled, is_deleted FROM notification_schema.notification_preferences
            WHERE user_id = 42 ORDER BY scope`,
      );
      expect(rows).toEqual([
        { scope: 'marketing', enabled: true, is_deleted: false },
        { scope: 'order', enabled: true, is_deleted: false },
      ]);

      await service.update({
        user_id: '42',
        items: [{ scope: 'marketing', channel: 'all', enabled: null }],
      });
      const res: any = await service.get({ user_id: '42' });
      expect(res.data.items.map((i: any) => i.scope)).toEqual(['order']);

      // Soft-delete qilingan qatorni qayta yoqish — UNIQUE to'qnashmaydi.
      await service.update({
        user_id: '42',
        items: [{ scope: 'marketing', channel: 'all', enabled: true }],
      });
      const again: any = await service.get({ user_id: '42' });
      expect(again.data.items.map((i: any) => i.scope)).toEqual([
        'marketing',
        'order',
      ]);
    });

    it('TC11: critical turni o‘chirish — 400, DB o‘zgarmaydi', async () => {
      let caught: unknown;
      try {
        await service.update({
          user_id: '42',
          items: [
            {
              scope: 'account.login_new_device',
              channel: 'all',
              enabled: false,
            },
          ],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RpcException);
      const [{ count }]: Array<{ count: string }> = await ds.query(
        `SELECT COUNT(*)::text AS count FROM notification_schema.notification_preferences
          WHERE scope = 'account.login_new_device'`,
      );
      expect(count).toBe('0');
    });

    it('TC7: 1000 qabul qiluvchi — filtr uchun ATIGI 1 ta SQL, soft-delete qatori filtrlamaydi', async () => {
      await ds.query(
        `INSERT INTO notification_schema.notification_preferences (user_id, scope, channel, enabled, is_deleted)
         VALUES (500, 'order', 'all', false, false), (501, 'order', 'all', false, true)`,
      );
      const ids = Array.from({ length: 1000 }, (_, i) => String(i + 1));
      counter.selects = [];
      const mutes = await service.mutesFor(ids, {
        type: 'order.sold',
        category: NotificationCategory.ORDER,
        priority: NotificationPriority.NORMAL,
        channels: ['in_app', 'realtime'],
      });
      expect(counter.selects).toHaveLength(1);
      expect(mutes.get('500')).toBe('all');
      expect(mutes.has('501')).toBe(false);
      // TC3 dagi (1, order, push=false): push so'ralmagan — ta'sir yo'q.
      expect(mutes.has('1')).toBe(false);
      expect(mutes.size).toBe(1);
    });
  },
);
