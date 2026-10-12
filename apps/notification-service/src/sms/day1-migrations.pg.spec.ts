import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { SmsCredentialCipher } from './sms-credential.cipher';
import { EncryptSmsSender1716000000068 } from '../../../../migrations/1716000000068-EncryptSmsSender';
import { SmsOutboxConsentIdentity1716000000069 } from '../../../../migrations/1716000000069-SmsOutboxConsentIdentity';
import { ManualFinancialBalanceIdempotency1716000000071 } from '../../../../migrations/1716000000071-ManualFinancialBalanceIdempotency';

const uri = process.env.DAY1_MIGRATIONS_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_day1_test'
  );
})();

(localTestDatabase ? describe : describe.skip)(
  '1-kun migratsiyalari, faqat lokal Postgres',
  () => {
    let db: DataSource;
    let schemasCreated = false;
    const oldSecret = process.env.SMS_CREDENTIAL_SECRET;

    beforeAll(async () => {
      db = new DataSource({ type: 'postgres', url: uri });
      await db.initialize();
      await db.query('CREATE SCHEMA notification_schema');
      await db.query('CREATE SCHEMA finance_schema');
      schemasCreated = true;
    });

    afterAll(async () => {
      if (oldSecret === undefined) delete process.env.SMS_CREDENTIAL_SECRET;
      else process.env.SMS_CREDENTIAL_SECRET = oldSecret;
      if (db?.isInitialized) {
        if (schemasCreated) {
          await db.query('DROP SCHEMA notification_schema CASCADE');
          await db.query('DROP SCHEMA finance_schema CASCADE');
        }
        await db.destroy();
      }
    });

    it('068 eski sender qiymatini shifrlaydi va down qaytaradi', async () => {
      process.env.SMS_CREDENTIAL_SECRET = randomBytes(32).toString('hex');
      await db.query(`
        CREATE TABLE notification_schema.sms_provider_accounts (
          id BIGSERIAL PRIMARY KEY, sender VARCHAR(32) NOT NULL
        )
      `);
      await db.query(
        'INSERT INTO notification_schema.sms_provider_accounts (sender) VALUES ($1)',
        ['TEST_SENDER'],
      );
      const migration = new EncryptSmsSender1716000000068();
      const runner = db.createQueryRunner();
      try {
        await migration.up(runner);
        const [row]: Array<{ sender_enc: string }> = await db.query(
          'SELECT sender_enc FROM notification_schema.sms_provider_accounts',
        );
        expect(row.sender_enc).not.toContain('TEST_SENDER');
        expect(
          new SmsCredentialCipher(process.env.SMS_CREDENTIAL_SECRET).decrypt(
            row.sender_enc,
          ),
        ).toBe('TEST_SENDER');
        await migration.down(runner);
        expect(
          await db.query(
            'SELECT sender FROM notification_schema.sms_provider_accounts',
          ),
        ).toEqual([{ sender: 'TEST_SENDER' }]);
      } finally {
        await runner.release();
      }
    });

    it("069 sms_outbox ga customer_id qo'shadi va down qaytaradi", async () => {
      await db.query(
        'CREATE TABLE notification_schema.sms_outbox (id BIGSERIAL PRIMARY KEY)',
      );
      const migration = new SmsOutboxConsentIdentity1716000000069();
      const runner = db.createQueryRunner();
      try {
        await migration.up(runner);
        await db.query(
          'INSERT INTO notification_schema.sms_outbox (customer_id) VALUES ($1)',
          ['42'],
        );
        expect(
          await db.query(
            'SELECT customer_id FROM notification_schema.sms_outbox',
          ),
        ).toEqual([{ customer_id: '42' }]);
        await migration.down(runner);
        const rows: unknown[] = await db.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'notification_schema'
             AND table_name = 'sms_outbox' AND column_name = 'customer_id'`,
        );
        expect(rows).toHaveLength(0);
      } finally {
        await runner.release();
      }
    });

    it('071 buyurtmasiz ayni manba/kalit dublikatini bazada rad etadi', async () => {
      await db.query(`
        CREATE TABLE finance_schema.financial_balance_history (
          id BIGSERIAL PRIMARY KEY,
          source_type TEXT NOT NULL,
          dedup_key TEXT NOT NULL,
          order_id BIGINT
        )
      `);
      const migration = new ManualFinancialBalanceIdempotency1716000000071();
      const runner = db.createQueryRunner();
      try {
        await migration.up(runner);
        const insert =
          'INSERT INTO finance_schema.financial_balance_history (source_type, dedup_key, order_id) VALUES ($1, $2, $3)';
        await db.query(insert, ['manual_expense', 'same-key', null]);
        await expect(
          db.query(insert, ['manual_expense', 'same-key', null]),
        ).rejects.toMatchObject({ code: '23505' });
        await db.query(insert, ['manual_income', 'same-key', null]);
        await db.query(insert, ['manual_expense', '', null]);
        await db.query(insert, ['manual_expense', '', null]);
        await migration.down(runner);
        await db.query(insert, ['manual_expense', 'same-key', null]);
      } finally {
        await runner.release();
      }
    });
  },
);
