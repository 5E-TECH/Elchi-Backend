import { DataSource, type QueryRunner } from 'typeorm';
import { CreateCarrierAccounts1716000000218 } from '../../../../migrations/1716000000218-CreateCarrierAccounts';
import { CarrierRollbackToggle1716000000223 } from '../../../../migrations/1716000000223-CarrierRollbackToggle';
import { CarrierAccount } from '../entities/carrier-account.entity';

/**
 * Migratsiya 223 HAQIQIY Postgres'da (yashirin rollback toggle'i).
 *
 * Hammasi BITTA tranzaksiyada va oxirida ROLLBACK — bazada iz qolmaydi
 * (umumiy lokal test bazasida ham xavfsiz). Faqat lokal host va nomida
 * `test` bo'lgan baza:
 *   CARRIER_PG_TEST_URI=postgres://<user>@localhost:5432/<..._test> \
 *     NODE_ENV=test npx jest carrier-rollback-toggle.migration.pg
 *
 *  • up(): mavjud (migratsiyadan oldingi) akkaunt → `rollback_enabled =
 *    false`; ustun NOT NULL DEFAULT false; qayta yurgizish xatosiz;
 *  • yangi akkaunt (entity orqali, maydon berilmasa) → false;
 *  • down(): ustun yo'qoladi, qayta yurgizish xatosiz.
 */
const uri = process.env.CARRIER_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    /test/i.test(url.pathname)
  );
})();

(localTestDatabase ? describe : describe.skip)(
  'CarrierRollbackToggle1716000000223 — haqiqiy Postgres',
  () => {
    let db: DataSource;
    let qr: QueryRunner;

    const column = async () => {
      const rows = (await qr.query(
        `SELECT is_nullable, column_default, data_type
           FROM information_schema.columns
          WHERE table_schema = 'integration_schema'
            AND table_name = 'carrier_accounts'
            AND column_name = 'rollback_enabled'`,
      )) as Array<{
        is_nullable: string;
        column_default: string;
        data_type: string;
      }>;
      return rows[0];
    };

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'integration_schema',
        entities: [CarrierAccount],
        synchronize: false,
      });
      await db.initialize();
      qr = db.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      await qr.query('CREATE SCHEMA IF NOT EXISTS "integration_schema"');
      await new CreateCarrierAccounts1716000000218().up(qr);
      // Migratsiyadan OLDINGI holat (baza allaqachon ko'chirilgan bo'lsa ham).
      await qr.query(
        `ALTER TABLE "integration_schema"."carrier_accounts"
           DROP COLUMN IF EXISTS "rollback_enabled"`,
      );
    }, 60_000);

    afterAll(async () => {
      if (qr?.isTransactionActive) await qr.rollbackTransaction();
      await qr?.release();
      await db?.destroy();
    });

    it('up → mavjud akkaunt o‘chiq; yangi akkaunt o‘chiq; down → ustun yo‘q', async () => {
      const [{ id: existingId }] = (await qr.query(
        `INSERT INTO "integration_schema"."carrier_accounts"
           (name, courier_user_id, api_key_hash, is_active)
         VALUES ('Eski kompaniya', 990001, 'hash-rollback-toggle-1', true)
         RETURNING id`,
      )) as Array<{ id: string }>;
      expect(await column()).toBeUndefined();

      const migration = new CarrierRollbackToggle1716000000223();
      await migration.up(qr);
      await migration.up(qr); // qayta yurgizish — xatosiz

      expect(await column()).toEqual({
        is_nullable: 'NO',
        column_default: 'false',
        data_type: 'boolean',
      });
      const [existing] = (await qr.query(
        `SELECT rollback_enabled FROM "integration_schema"."carrier_accounts" WHERE id = $1`,
        [existingId],
      )) as Array<{ rollback_enabled: boolean }>;
      expect(existing.rollback_enabled).toBe(false);

      // Yangi akkaunt — entity orqali, maydon berilmaydi.
      const repo = qr.manager.getRepository(CarrierAccount);
      const created = await repo.save(
        repo.create({
          name: 'Yangi kompaniya',
          courier_user_id: '990002',
          api_key_hash: 'hash-rollback-toggle-2',
          ip_allowlist: null,
          is_active: true,
        }),
      );
      const reread = await repo.findOneByOrFail({ id: created.id });
      expect(reread.rollback_enabled).toBe(false);

      // Toggle round-trip (faqat shu ustun).
      await repo.update({ id: created.id }, { rollback_enabled: true });
      expect(
        (await repo.findOneByOrFail({ id: created.id })).rollback_enabled,
      ).toBe(true);

      await migration.down(qr);
      await migration.down(qr); // qayta yurgizish — xatosiz
      expect(await column()).toBeUndefined();
    });
  },
);
