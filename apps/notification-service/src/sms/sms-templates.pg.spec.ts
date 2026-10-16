import { Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateSmsProviderTemplatesConsent1716000000055 } from '../../../../migrations/1716000000055-CreateSmsProviderTemplatesConsent';
import { AddUserLanguageAndOtpCodes1716000000056 } from '../../../../migrations/1716000000056-AddUserLanguageAndOtpCodes';
import { SmsTemplate } from '../entities/sms-template.entity';
import { SmsTemplateService } from './sms-template.service';

/**
 * nkhURiKX TC1/TC2 — HAQIQIY Postgres (faqat lokal test bazasi):
 * 056 `users.language` (identity_schema.admins) mavjud qatorlar bilan,
 * 055 `sms_templates` UNIQUE (code, lang) + CHECK, servis upsert/resolve
 * real DB'da.
 *
 *   SMS_TEMPLATES_PG_TEST_URI=postgres://postgres@127.0.0.1:55493/elchi_sms_templates_test \
 *     npx jest sms-templates.pg
 */
const uri = process.env.SMS_TEMPLATES_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_sms_templates_test'
  );
})();

const LANGUAGE_COLUMN = `SELECT data_type, character_maximum_length, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'identity_schema' AND table_name = 'admins'
   AND column_name = 'language'`;

(localTestDatabase ? describe : describe.skip)(
  'sms_templates + users.language — lokal Postgres (nkhURiKX)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;
    const run = async (work: (runner: QueryRunner) => Promise<void>) => {
      const runner = db.createQueryRunner();
      try {
        await work(runner);
      } finally {
        await runner.release();
      }
    };

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [SmsTemplate],
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
      await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
      await db.query('CREATE SCHEMA identity_schema');
      // 056 dan OLDINGI holat: admins da language yo'q, jonli qatorlar bor.
      await db.query(`
        CREATE TABLE identity_schema.admins (
          id BIGSERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          phone_number VARCHAR(32),
          role VARCHAR(32) NOT NULL,
          settings JSONB,
          "isDeleted" BOOLEAN NOT NULL DEFAULT FALSE
        )
      `);
      await db.query(`
        INSERT INTO identity_schema.admins (name, phone_number, role, settings) VALUES
          ('Mijoz A', '+998901111111', 'customer', NULL),
          ('Kuryer B', '+998902222222', 'courier', '{"appearance": {"language": "ru"}}'),
          ('Market C', '+998903333333', 'market', '{}')
      `);
      await run((runner) =>
        new CreateSmsProviderTemplatesConsent1716000000055().up(runner),
      );
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
        await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
        await db.destroy();
      }
    });

    it('TC1 (056): users.language — NOT NULL, sukut uz, mavjud qatorlar buzilmaydi; qayta up xatosiz; down/up', async () => {
      const select = `SELECT id, name, phone_number, role, settings, "isDeleted"
        FROM identity_schema.admins ORDER BY id`;
      const before: Array<Record<string, unknown>> = await db.query(select);
      await run((r) => new AddUserLanguageAndOtpCodes1716000000056().up(r));

      const [column]: Array<Record<string, unknown>> =
        await db.query(LANGUAGE_COLUMN);
      expect(column).toMatchObject({
        data_type: 'character varying',
        character_maximum_length: 2,
        is_nullable: 'NO',
      });
      expect(String(column.column_default)).toContain("'uz'");

      const after: Array<Record<string, unknown>> = await db.query(
        `SELECT id, name, phone_number, role, settings, "isDeleted", language
           FROM identity_schema.admins ORDER BY id`,
      );
      // Boshqa ustunlar AYNAN o'zgarmagan; hammasiga sukut uz.
      const withoutLanguage = after.map((row) => {
        const rest = { ...row };
        delete rest.language;
        return rest;
      });
      expect(withoutLanguage).toEqual(before);
      expect(after.map((row) => row.language)).toEqual(['uz', 'uz', 'uz']);
      // Xodim tili jsonb da qoladi (SQL fallback manbai) — tegilmagan.
      expect(after[1].settings).toEqual({ appearance: { language: 'ru' } });

      const [fresh]: Array<{ language: string }> = await db.query(
        `INSERT INTO identity_schema.admins (name, role)
         VALUES ('Yangi mijoz', 'customer') RETURNING language`,
      );
      expect(fresh.language).toBe('uz');
      await expect(
        db.query(
          `UPDATE identity_schema.admins SET language = NULL WHERE name = 'Mijoz A'`,
        ),
      ).rejects.toMatchObject({ code: '23502' });
      await db.query(
        `UPDATE identity_schema.admins SET language = 'ru' WHERE name = 'Mijoz A'`,
      );

      // Qayta up (IF NOT EXISTS) — xatosiz va mavjud qiymat o'zgarmaydi.
      await run((r) => new AddUserLanguageAndOtpCodes1716000000056().up(r));
      const [mijoz]: Array<{ language: string }> = await db.query(
        `SELECT language FROM identity_schema.admins WHERE name = 'Mijoz A'`,
      );
      expect(mijoz.language).toBe('ru');

      // down → ustun olib tashlanadi, qatorlar joyida; up qayta ishlaydi.
      await run((r) => new AddUserLanguageAndOtpCodes1716000000056().down(r));
      expect(await db.query(LANGUAGE_COLUMN)).toHaveLength(0);
      expect(
        await db.query('SELECT count(*)::int AS n FROM identity_schema.admins'),
      ).toEqual([{ n: 4 }]);
      await run((r) => new AddUserLanguageAndOtpCodes1716000000056().up(r));
      expect(await db.query(LANGUAGE_COLUMN)).toHaveLength(1);
    });

    it('TC2 (055): sms_templates (code, lang) UNIQUE; boshqa til ruxsat; lang/message_class CHECK', async () => {
      const insert = `INSERT INTO notification_schema.sms_templates
        (code, message_class, lang, text) VALUES ($1, $2, $3, $4)`;
      await db.query(insert, [
        'order.delivered',
        'transactional',
        'uz',
        'Buyurtma yetkazildi',
      ]);
      await expect(
        db.query(insert, ['order.delivered', 'transactional', 'uz', 'Takror']),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'UQ_SMS_TEMPLATE_CODE_LANG',
      });
      await db.query(insert, [
        'order.delivered',
        'transactional',
        'ru',
        'Заказ доставлен',
      ]);
      await expect(
        db.query(insert, ['order.delivered', 'transactional', 'de', 'x']),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query(insert, ['order.x', 'spam', 'uz', 'x']),
      ).rejects.toMatchObject({ code: '23514' });
      const [defaults]: Array<Record<string, unknown>> = await db.query(
        `INSERT INTO notification_schema.sms_templates (code, message_class, text)
         VALUES ('order.y', 'promo', 'x')
         RETURNING lang, required_vars, provider_template_id, is_active`,
      );
      expect(defaults).toEqual({
        lang: 'uz',
        required_vars: [],
        provider_template_id: null,
        is_active: true,
      });
      await db.query('TRUNCATE notification_schema.sms_templates');
    });

    it("servis real DB da: upsert ikki marta → bitta qator; matn o'zgarsa provider_template_id NULL; ru tanlanadi, yo'q bo'lsa uz + log", async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const service = new SmsTemplateService(db.getRepository(SmsTemplate));
      const base = {
        code: 'order.delivered',
        message_class: 'transactional',
        lang: 'uz',
        text: 'Buyurtma #{{order_number}} yetkazildi',
      };
      const created = await service.upsert(base);
      await service.markApproved(created.id, 'ESKIZ-1');
      const same = await service.upsert({ ...base, is_active: true });
      expect(same).toMatchObject({
        id: created.id,
        provider_template_id: 'ESKIZ-1',
        needs_provider_approval: false,
      });
      const edited = await service.upsert({
        ...base,
        text: 'Buyurtma #{{order_number}} topshirildi',
      });
      expect(edited).toMatchObject({
        id: created.id,
        provider_template_id: null,
        needs_provider_approval: true,
        required_vars: ['order_number'],
      });
      const rows: Array<{ provider_template_id: string | null }> =
        await db.query(
          'SELECT provider_template_id FROM notification_schema.sms_templates',
        );
      expect(rows).toEqual([{ provider_template_id: null }]);

      expect((await service.resolve('order.delivered', 'ru'))?.lang).toBe('uz');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("'uz' ga fallback"),
      );
      await service.upsert({
        ...base,
        lang: 'ru',
        text: 'Заказ #{{order_number}} доставлен',
      });
      expect((await service.resolve('order.delivered', 'ru'))?.text).toBe(
        'Заказ #{{order_number}} доставлен',
      );
      warn.mockRestore();
    });
  },
);
