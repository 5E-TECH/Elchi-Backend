import { DataSource } from 'typeorm';
import { UserTempPasswordSms1716000000191 } from '../../../../migrations/1716000000191-UserTempPasswordSms';
import { SmsTempPasswordTemplate1716000000192 } from '../../../../migrations/1716000000192-SmsTempPasswordTemplate';

/**
 * (aidsxJ2H) 191/192 migratsiyalari — haqiqiy Postgres: qayta yurgizish
 * xavfsiz, mavjud foydalanuvchilar darvozaga tushmaydi, SMS jurnalida parol
 * ustuni yo'q, shablon tasdiqlanmagan, `down()` ochiq parol qoldirmaydi.
 * Faqat lokal baza (`/elchi_tmppw_test`):
 *   TEMP_PASSWORD_PG_TEST_URI=postgres://postgres@127.0.0.1:55530/elchi_tmppw_test
 */
const uri = process.env.TEMP_PASSWORD_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_tmppw_test'
  );
})();

(localTestDatabase ? describe : describe.skip)(
  'aidsxJ2H — 191/192 migratsiyalari (lokal Postgres)',
  () => {
    jest.setTimeout(30_000);
    let db: DataSource;

    const run = async (
      migration: {
        up: (runner: never) => Promise<void>;
        down: (runner: never) => Promise<void>;
      },
      direction: 'up' | 'down',
    ) => {
      const runner = db.createQueryRunner();
      try {
        await migration[direction](runner as never);
      } finally {
        await runner.release();
      }
    };

    beforeAll(async () => {
      db = new DataSource({ type: 'postgres', url: uri });
      await db.initialize();
      await db.query(`
        DROP SCHEMA IF EXISTS identity_schema CASCADE;
        DROP SCHEMA IF EXISTS notification_schema CASCADE;
        CREATE SCHEMA identity_schema;
        CREATE SCHEMA notification_schema;
        CREATE TABLE identity_schema.admins (
          id BIGSERIAL PRIMARY KEY,
          password VARCHAR(255) NOT NULL,
          must_change_password boolean NOT NULL DEFAULT false
        );
        INSERT INTO identity_schema.admins (password) VALUES ('hash');
        CREATE TABLE notification_schema.sms_outbox (
          id BIGSERIAL PRIMARY KEY,
          status varchar(20) NOT NULL DEFAULT 'pending',
          text text NOT NULL,
          next_retry_at timestamptz NULL,
          last_error text NULL
        );
        CREATE TABLE notification_schema.sms_templates (
          id BIGSERIAL PRIMARY KEY,
          code varchar(64) NOT NULL,
          message_class varchar(16) NOT NULL,
          lang varchar(2) NOT NULL DEFAULT 'uz',
          text text NOT NULL,
          required_vars text[] NOT NULL DEFAULT '{}',
          provider_template_id varchar(64) NULL,
          is_active boolean NOT NULL DEFAULT true
        );
        CREATE UNIQUE INDEX "UQ_SMS_TEMPLATE_CODE_LANG"
          ON notification_schema.sms_templates (code, lang);
      `);
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query(`
          DROP SCHEMA IF EXISTS identity_schema CASCADE;
          DROP SCHEMA IF EXISTS notification_schema CASCADE;
        `);
        await db.destroy();
      }
    });

    it('191: qayta yurgizish xatosiz; mavjud foydalanuvchi — forced false; jurnalda parol ustuni yo‘q', async () => {
      const migration = new UserTempPasswordSms1716000000191();
      await run(migration, 'up');
      await run(migration, 'up');

      const [admin] = await db.query<
        Array<{ password_change_forced: boolean }>
      >(`SELECT password_change_forced FROM identity_schema.admins`);
      expect(admin.password_change_forced).toBe(false);

      const columns = await db.query<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'identity_schema' AND table_name = 'user_password_sms'`,
      );
      const names = columns.map((row) => row.column_name);
      expect(names).toEqual(
        expect.arrayContaining(['user_id', 'client_message_id', 'status']),
      );
      expect(names.filter((name) => /pass|text|secret/i.test(name))).toEqual(
        [],
      );

      await expect(
        db.query(
          `INSERT INTO identity_schema.user_password_sms
             (user_id, client_message_id, reason, status)
           VALUES (1, 'tmppw-x', 'create', 'unknown')`,
        ),
      ).rejects.toThrow(/CHK_USER_PASSWORD_SMS_STATUS/);
    });

    it('192: shablon tasdiqlanmagan, mavjudiga tegmaydi, redacted_text ustuni', async () => {
      const migration = new SmsTempPasswordTemplate1716000000192();
      await run(migration, 'up');
      await run(migration, 'up');
      const rows = await db.query<Array<Record<string, unknown>>>(
        `SELECT message_class, lang, required_vars, provider_template_id, is_active
           FROM notification_schema.sms_templates WHERE code = 'user.temp_password'`,
      );
      expect(rows).toEqual([
        {
          message_class: 'security',
          lang: 'uz',
          required_vars: ['login', 'password'],
          provider_template_id: null,
          is_active: true,
        },
      ]);

      await db.query(
        `UPDATE notification_schema.sms_templates SET text = 'operator matni {{login}} {{password}}'`,
      );
      await run(migration, 'up');
      const [template] = await db.query<Array<{ text: string }>>(
        `SELECT text FROM notification_schema.sms_templates`,
      );
      expect(template.text).toBe('operator matni {{login}} {{password}}');
    });

    it('192 down(): yuborilmagan parol SMS’i maskalanib yopiladi, tasdiqlangan shablon qoladi', async () => {
      const migration = new SmsTempPasswordTemplate1716000000192();
      await db.query(`
        INSERT INTO notification_schema.sms_outbox (status, text, redacted_text) VALUES
          ('pending', 'parol: Ab3dEf7hJk9m .', 'parol: •••• .'),
          ('sent', 'parol: •••• .', 'parol: •••• .'),
          ('pending', 'Buyurtma yetkazildi', NULL)
      `);
      await db.query(
        `UPDATE notification_schema.sms_templates SET provider_template_id = 'esk-1'`,
      );
      await run(migration, 'down');

      const rows = await db.query<Array<{ status: string; text: string }>>(
        `SELECT status, text FROM notification_schema.sms_outbox ORDER BY id`,
      );
      expect(rows).toEqual([
        { status: 'failed', text: 'parol: •••• .' },
        { status: 'sent', text: 'parol: •••• .' },
        { status: 'pending', text: 'Buyurtma yetkazildi' },
      ]);
      const templates = await db.query<unknown[]>(
        `SELECT code FROM notification_schema.sms_templates`,
      );
      expect(templates).toHaveLength(1);

      await run(migration, 'up');
    });

    it('191 down(): ustun va jadval o‘chadi, up qayta ishlaydi', async () => {
      const migration = new UserTempPasswordSms1716000000191();
      await run(migration, 'down');
      const [state] = await db.query<
        Array<{ tbl: string | null; col: number }>
      >(
        `SELECT to_regclass('identity_schema.user_password_sms') AS tbl,
                (SELECT COUNT(*)::int FROM information_schema.columns
                  WHERE table_schema = 'identity_schema'
                    AND column_name = 'password_change_forced') AS col`,
      );
      expect(state).toEqual({ tbl: null, col: 0 });
      await run(migration, 'up');
    });
  },
);
