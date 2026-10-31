import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { FinancialSource_type, Operation_type, Source_type } from '@app/common';
import { PickupVisits1716000000198 } from '../../../../migrations/1716000000198-PickupVisits';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinancialBalanceHistory } from '../entities/financial-balance-history.entity';
import { PickupVisit } from '../entities/pickup-visit.entity';

/**
 * B824gOu5 — migratsiya 198 haqiqiy Postgres'da (FINANCE_T3_PG_TEST_URI
 * bo'lmasa skip). Migratsiya `finance_schema` ga qattiq bog'langan, shu bois
 * o'z vaqtinchalik bazasini yaratadi va oxirida o'chiradi.
 *
 *  • ikki enum'ga `pickup_fee` qo'shiladi, jadval entity bilan mos;
 *  • qayta yurgizish xatosiz;
 *  • down() xatosiz, qayta down() ham; `pickup_fee` tarix qatorlari qoladi;
 *  • down() dan keyin up() yana ishlaydi.
 */
const pgUri = process.env.FINANCE_T3_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const ENUMS = [
  'cashbox_history_source_type_enum',
  'financial_balance_history_source_type_enum',
];

describePg('B824gOu5 migratsiya 198 — haqiqiy Postgres', () => {
  const dbName = `spec_pickup_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  const migration = new PickupVisits1716000000198();

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

  const enumHasValue = async (typeName: string) => {
    const rows: unknown[] = await db.query(
      `SELECT 1 FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'finance_schema' AND t.typname = $1
          AND e.enumlabel = 'pickup_fee'`,
      [typeName],
    );
    return rows.length > 0;
  };

  const tableExists = async () => {
    const [{ t }]: Array<{ t: string | null }> = await db.query(
      `SELECT to_regclass('finance_schema.pickup_visits')::text AS t`,
    );
    return Boolean(t);
  };

  /** Migratsiyadan OLDINGI enum: `pickup_fee` qiymatisiz qayta quriladi. */
  const dropEnumValue = async (table: string, typeName: string) => {
    const labels: Array<{ enumlabel: string }> = await db.query(
      `SELECT e.enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'finance_schema' AND t.typname = $1
          AND e.enumlabel <> 'pickup_fee'
        ORDER BY e.enumsortorder`,
      [typeName],
    );
    const list = labels.map((row) => `'${row.enumlabel}'`).join(', ');
    await db.query(
      `ALTER TYPE "finance_schema"."${typeName}" RENAME TO "${typeName}_old"`,
    );
    await db.query(
      `CREATE TYPE "finance_schema"."${typeName}" AS ENUM (${list})`,
    );
    await db.query(
      `ALTER TABLE "finance_schema"."${table}"
         ALTER COLUMN "source_type" TYPE "finance_schema"."${typeName}"
         USING "source_type"::text::"finance_schema"."${typeName}"`,
    );
    await db.query(`DROP TYPE "finance_schema"."${typeName}_old"`);
  };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri as string);
    url.pathname = `/${dbName}`;
    const bootstrap = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities: [Cashbox, CashboxHistory, FinancialBalanceHistory],
      synchronize: false,
    });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA finance_schema');
    await bootstrap.synchronize();
    await bootstrap.destroy();
    // `pickup_visits` — MIGRATSIYADAN (entity ↔ migratsiya mosligi shu bilan).
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'finance_schema',
      entities: [Cashbox, CashboxHistory, FinancialBalanceHistory, PickupVisit],
      synchronize: false,
    });
    await db.initialize();
    await dropEnumValue('cashbox_history', ENUMS[0]);
    await dropEnumValue('financial_balance_history', ENUMS[1]);
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  it('up: ikki enum va jadval; qayta yurgizish xatosiz', async () => {
    await expect(enumHasValue(ENUMS[0])).resolves.toBe(false);
    await expect(enumHasValue(ENUMS[1])).resolves.toBe(false);
    await expect(tableExists()).resolves.toBe(false);

    await run('up');
    await run('up');

    await expect(enumHasValue(ENUMS[0])).resolves.toBe(true);
    await expect(enumHasValue(ENUMS[1])).resolves.toBe(true);
    await expect(tableExists()).resolves.toBe(true);
  });

  it('entity jadvalga mos; CHECK va UNIQUE ishlaydi', async () => {
    const repo = db.getRepository(PickupVisit);
    const row = {
      market_id: '1',
      courier_id: '2',
      parcel_count: 9,
      fee: 20000,
      is_free: false,
      created_by: '3',
      occurred_at: new Date(),
      idempotency_key: 'k-1',
    };
    const saved = await repo.save(repo.create(row));
    expect(saved.id).toBeDefined();
    await expect(repo.save(repo.create(row))).rejects.toThrow(/UQ_PICKUP/);
    await expect(
      repo.save(repo.create({ ...row, idempotency_key: 'k-2', is_free: true })),
    ).rejects.toThrow(/CHK_PICKUP_VISITS_FREE/);
    await expect(
      repo.save(
        repo.create({ ...row, idempotency_key: 'k-3', parcel_count: 0 }),
      ),
    ).rejects.toThrow(/CHK_PICKUP_VISITS_PARCELS/);
    await expect(
      repo.save(
        repo.create({
          ...row,
          idempotency_key: 'k-4',
          fee: 0,
          is_free: true,
          parcel_count: 10,
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('down: xatosiz, ikki marta ham; pul qatorlari qoladi; up yana ishlaydi', async () => {
    const cashbox = await db.getRepository(Cashbox).save(
      db.getRepository(Cashbox).create({
        user_id: '1',
        cashbox_type: 'markets' as never,
        balance: -20000,
        balance_cash: -20000,
        balance_card: 0,
      }),
    );
    await db.getRepository(CashboxHistory).save(
      db.getRepository(CashboxHistory).create({
        operation_type: Operation_type.EXPENSE,
        cashbox_id: cashbox.id,
        source_type: Source_type.PICKUP_FEE,
        source_id: '1',
        amount: 20000,
        balance_after: -20000,
      }),
    );
    await db.getRepository(FinancialBalanceHistory).save(
      db.getRepository(FinancialBalanceHistory).create({
        amount: 20000,
        balance_before: 0,
        balance_after: 20000,
        source_type: FinancialSource_type.PICKUP_FEE,
        dedup_key: 'pickup-visit:1',
      }),
    );

    await run('down');
    await run('down');

    await expect(tableExists()).resolves.toBe(false);
    // Revert pulni o'zgartirmaydi: qator ham, enum qiymati ham joyida.
    await expect(
      db.getRepository(CashboxHistory).countBy({
        source_type: Source_type.PICKUP_FEE,
      }),
    ).resolves.toBe(1);
    await expect(enumHasValue(ENUMS[0])).resolves.toBe(true);

    await run('up');
    await expect(tableExists()).resolves.toBe(true);
  });
});
