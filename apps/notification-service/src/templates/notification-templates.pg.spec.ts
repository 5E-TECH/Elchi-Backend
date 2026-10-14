/* eslint-disable @typescript-eslint/require-await -- spec mock'lari: async soxta implementatsiyalar */
import { DataSource } from 'typeorm';
import { UserLanguageCheck1716000000085 } from '../../../../migrations/1716000000085-UserLanguageCheck';
import { CreateNotificationTemplatesAndSegments1716000000086 } from '../../../../migrations/1716000000086-CreateNotificationTemplatesAndSegments';
import { NotificationTemplate } from './notification-template.entity';
import { NotificationTemplateService } from './notification-template.service';

/**
 * C4R3YyvH — HAQIQIY Postgres (faqat lokal test bazasi): migratsiya 085
 * (users.language CHECK uz/ru/en) va 086 (notification_templates, UNIQUE
 * (code, lang, channel) — NULL kanal ham) up/down, servis upsert/forDispatch.
 *
 *   NOTIFICATION_TEMPLATES_PG_TEST_URI=postgres://postgres@127.0.0.1:55464/elchi_templates_test \
 *     npx jest apps/notification-service/src/templates/notification-templates.pg.spec.ts
 */
const uri = process.env.NOTIFICATION_TEMPLATES_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_templates_test'
  );
})();

(localTestDatabase ? describe : describe.skip)(
  'notification_templates + users.language — lokal Postgres (C4R3YyvH)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;
    let service: NotificationTemplateService;

    const run = async (
      fn: (
        runner: ReturnType<DataSource['createQueryRunner']>,
      ) => Promise<void>,
    ) => {
      const runner = db.createQueryRunner();
      try {
        await fn(runner);
      } finally {
        await runner.release();
      }
    };

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [NotificationTemplate],
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
      await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
      // 085 mavjud `admins` jadvaliga tegadi — minimal nusxa (056 holati).
      await db.query('CREATE SCHEMA identity_schema');
      await db.query(`
        CREATE TABLE identity_schema.admins (
          id BIGSERIAL PRIMARY KEY,
          name VARCHAR,
          language VARCHAR(2) NOT NULL DEFAULT 'uz'
        )`);
      await db.query(
        `INSERT INTO identity_schema.admins (name, language) VALUES ('a', 'uz'), ('b', 'ru'), ('c', 'xx')`,
      );
      await run(async (runner) => {
        await new UserLanguageCheck1716000000085().up(runner);
        await new CreateNotificationTemplatesAndSegments1716000000086().up(
          runner,
        );
      });
      service = new NotificationTemplateService(
        db.getRepository(NotificationTemplate),
      );
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
        await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
        await db.destroy();
      }
    });

    it('085: noto‘g‘ri eski qiymat uz ga normallashdi; CHECK faqat uz/ru/en; sukut uz; NOT NULL', async () => {
      const rows: Array<{ name: string; language: string }> = await db.query(
        'SELECT name, language FROM identity_schema.admins ORDER BY id',
      );
      expect(rows.map((r) => r.language)).toEqual(['uz', 'ru', 'uz']);
      await expect(
        db.query(
          `UPDATE identity_schema.admins SET language = 'de' WHERE name = 'a'`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query(
          `UPDATE identity_schema.admins SET language = NULL WHERE name = 'a'`,
        ),
      ).rejects.toMatchObject({ code: '23502' });
      const [fresh] = await db.query(
        `INSERT INTO identity_schema.admins (name) VALUES ('d') RETURNING language`,
      );
      expect(fresh.language).toBe('uz');
      // Qayta up — idempotent (constraint ikki marta qo'shilmaydi).
      await run((runner) => new UserLanguageCheck1716000000085().up(runner));
    });

    it('086: UNIQUE (code, lang, channel) — NULL kanal ham takrorlanmaydi; lang CHECK', async () => {
      const insert = (channel: string | null, lang = 'uz') =>
        db.query(
          `INSERT INTO notification_schema.notification_templates (code, lang, channel, title)
           VALUES ('order.sold', $1, $2, 't')`,
          [lang, channel],
        );
      await insert(null);
      await expect(insert(null)).rejects.toMatchObject({ code: '23505' });
      await insert('sms');
      await expect(insert('sms')).rejects.toMatchObject({ code: '23505' });
      await insert(null, 'ru');
      await expect(insert(null, 'de')).rejects.toMatchObject({ code: '23514' });
      await expect(insert('fax')).rejects.toMatchObject({ code: '23514' });
      const [{ is_deleted }] = await db.query(
        `SELECT column_name AS is_deleted FROM information_schema.columns
          WHERE table_schema = 'notification_schema' AND table_name = 'notification_templates'
            AND column_name = 'is_deleted'`,
      );
      expect(is_deleted).toBe('is_deleted');
      await db.query('TRUNCATE notification_schema.notification_templates');
    });

    it('servis: upsert ikki marta (NULL kanal) — bitta qator yangilanadi; forDispatch til zanjiri', async () => {
      const first = (await service.upsert({
        code: 'order.sold',
        lang: 'ru',
        title: 'Продан #{{order_number}}',
      })) as { statusCode: number };
      const second = (await service.upsert({
        code: 'order.sold',
        lang: 'ru',
        title: 'Заказ #{{order_number}} продан',
      })) as { statusCode: number };
      expect([first.statusCode, second.statusCode]).toEqual([201, 200]);
      await service.upsert({
        code: 'order.sold',
        lang: 'uz',
        title: 'Sotildi #{{order_number}}',
      });
      const [{ n }] = await db.query(
        `SELECT COUNT(*)::int AS n FROM notification_schema.notification_templates`,
      );
      expect(n).toBe(2);

      const texts = await service.forDispatch(
        'order.sold',
        { order_number: '9' },
        ['1', '2'],
        async () =>
          new Map([
            ['1', 'ru'],
            ['2', 'en'],
          ]),
      );
      expect(texts?.textFor('1')?.title).toBe('Заказ #9 продан');
      expect(texts?.textFor('2')?.title).toBe('Sotildi #9');
    });

    it('ebSV5oyP (086): saqlangan segment nomi — katta-kichik harfsiz UNIQUE, o‘chirilgandan keyin qayta ishlatiladi', async () => {
      const insert = (name: string) =>
        db.query(
          `INSERT INTO notification_schema.notification_audience_segments (name, audience)
           VALUES ($1, '{"roles":["courier"]}') RETURNING id`,
          [name],
        );
      const [first] = await insert('Faol mijozlar');
      await expect(insert('faol MIJOZLAR')).rejects.toMatchObject({
        code: '23505',
      });
      await db.query(
        `UPDATE notification_schema.notification_audience_segments SET is_deleted = true WHERE id = $1`,
        [first.id],
      );
      await expect(insert('Faol mijozlar')).resolves.toBeDefined();
    });

    it('down(): 086 jadvalni, 085 constraint’ni olib tashlaydi; up qayta ishlaydi', async () => {
      await run(async (runner) => {
        await new CreateNotificationTemplatesAndSegments1716000000086().down(
          runner,
        );
        await new UserLanguageCheck1716000000085().down(runner);
      });
      const [tbl] = await db.query(
        `SELECT COUNT(*)::int AS n FROM information_schema.tables
          WHERE table_schema = 'notification_schema'
            AND table_name IN ('notification_templates', 'notification_audience_segments')`,
      );
      const [chk] = await db.query(
        `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = 'CHK_ADMINS_LANGUAGE'`,
      );
      expect([tbl.n, chk.n]).toEqual([0, 0]);
      await run(async (runner) => {
        await new UserLanguageCheck1716000000085().up(runner);
        await new CreateNotificationTemplatesAndSegments1716000000086().up(
          runner,
        );
      });
    });
  },
);
