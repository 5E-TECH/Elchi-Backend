import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { OperatorFinanceMarketBackfill1716000000257 } from '../../../../migrations/1716000000257-OperatorFinanceMarketBackfill';

/**
 * Migratsiya 257 — operator daromad va to'lovlarining `market_id` NULL
 * qatorlarini marketga biriktirish (bitta operator — bir nechta market,
 * 3-bosqich). HAQIQIY Postgres, o'z vaqtinchalik bazasi (sxemalar migratsiyada
 * qattiq yozilgan — `finance_schema`, `order_schema`, `identity_schema`).
 *
 * Talablar:
 *  - daromad — buyurtmaning marketiga; to'lov — operatorning marketiga;
 *  - faqat NULL qatorlar va faqat `market_id` (summa, holat, bekor qilish
 *    o'zgarmaydi), mavjud `market_id` tegilmaydi;
 *  - biriktirib bo'lmaydiganlar NULL qoladi;
 *  - qayta yurgizish xavfsiz; jadval yo'q muhitda xatosiz.
 *
 * Env (`FINANCE_PG_TEST_URI`) bo'lmasa skip.
 */
const pgUri = process.env.FINANCE_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

type Row = Record<string, unknown>;

describePg('migratsiya 257 — operator moliyasi market bo`yicha (pg)', () => {
  const dbName = `spec_ofmb_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  const migration = new OperatorFinanceMarketBackfill1716000000257();

  const dbUrl = () => {
    const url = new URL(pgUri!);
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  const up = async () => {
    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      await migration.up(runner);
    } finally {
      await runner.release();
    }
  };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    db = new DataSource({ type: 'postgres', url: dbUrl() });
    await db.initialize();
  });

  afterAll(async () => {
    await db?.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    for (const schema of [
      'finance_schema',
      'order_schema',
      'identity_schema',
    ]) {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  const createSchemas = async () => {
    await db.query('CREATE SCHEMA identity_schema');
    await db.query('CREATE SCHEMA order_schema');
    await db.query('CREATE SCHEMA finance_schema');
    await db.query(
      `CREATE TABLE identity_schema.admins (
         id bigint PRIMARY KEY, role varchar NOT NULL, market_id bigint NULL)`,
    );
    await db.query(
      `CREATE TABLE order_schema.orders (
         id bigint PRIMARY KEY, market_id bigint NOT NULL)`,
    );
    await db.query(
      `CREATE TABLE finance_schema.operator_earnings (
         id bigserial PRIMARY KEY, operator_id bigint NOT NULL,
         order_id bigint NOT NULL, market_id bigint NULL,
         amount numeric(14,2) NOT NULL, is_deleted boolean NOT NULL DEFAULT false)`,
    );
    await db.query(
      `CREATE TABLE finance_schema.operator_payments (
         id bigserial PRIMARY KEY, operator_id bigint NOT NULL,
         market_id bigint NULL, amount numeric(14,2) NOT NULL,
         source varchar(16) NOT NULL DEFAULT 'elchi',
         cancelled_at timestamptz NULL)`,
    );
  };

  it('daromad — buyurtma marketiga, to`lov — operator marketiga; mavjud market_id tegilmaydi; biriktirib bo`lmaydigan — NULL; qayta yurgizish o`zgartirmaydi', async () => {
    await createSchemas();
    await db.query(
      `INSERT INTO identity_schema.admins (id, role, market_id) VALUES
         (10, 'market', NULL), (20, 'market', NULL),
         (42, 'market_operator', 10), (43, 'market_operator', NULL)`,
    );
    await db.query(
      `INSERT INTO order_schema.orders (id, market_id) VALUES (7001, 10), (7002, 20)`,
    );
    await db.query(
      `INSERT INTO finance_schema.operator_earnings
         (operator_id, order_id, market_id, amount, is_deleted) VALUES
         (42, 7001, NULL, 1500, false),   -- → 10 (buyurtmadan)
         (42, 7002, NULL, 900, true),     -- → 20 (o'chirilgan ham — tarix)
         (42, 7001, 20, 100, false),      -- mavjud — tegilmaydi
         (42, 9999, NULL, 50, false)      -- buyurtma yo'q — NULL qoladi`,
    );
    await db.query(
      `INSERT INTO finance_schema.operator_payments
         (operator_id, market_id, amount, source, cancelled_at) VALUES
         (42, NULL, 2000, 'elchi', NULL),       -- → 10 (operator marketi)
         (42, NULL, 300, 'elchi', now()),       -- bekor qilingan ham → 10
         (42, 20, 700, 'market', NULL),         -- mavjud — tegilmaydi
         (43, NULL, 400, 'elchi', NULL)         -- operatorda market yo'q — NULL`,
    );

    await up();
    const earnings = await db.query<Row[]>(
      `SELECT order_id::text, market_id::text, amount::text, is_deleted
         FROM finance_schema.operator_earnings ORDER BY id`,
    );
    expect(earnings).toEqual([
      {
        order_id: '7001',
        market_id: '10',
        amount: '1500.00',
        is_deleted: false,
      },
      { order_id: '7002', market_id: '20', amount: '900.00', is_deleted: true },
      {
        order_id: '7001',
        market_id: '20',
        amount: '100.00',
        is_deleted: false,
      },
      { order_id: '9999', market_id: null, amount: '50.00', is_deleted: false },
    ]);
    const payments = await db.query<Row[]>(
      `SELECT operator_id::text, market_id::text, amount::text, source,
              cancelled_at IS NOT NULL AS cancelled
         FROM finance_schema.operator_payments ORDER BY id`,
    );
    expect(payments).toEqual([
      {
        operator_id: '42',
        market_id: '10',
        amount: '2000.00',
        source: 'elchi',
        cancelled: false,
      },
      {
        operator_id: '42',
        market_id: '10',
        amount: '300.00',
        source: 'elchi',
        cancelled: true,
      },
      {
        operator_id: '42',
        market_id: '20',
        amount: '700.00',
        source: 'market',
        cancelled: false,
      },
      {
        operator_id: '43',
        market_id: null,
        amount: '400.00',
        source: 'elchi',
        cancelled: false,
      },
    ]);

    await up();
    expect(
      await db.query<Row[]>(
        `SELECT order_id::text, market_id::text, amount::text, is_deleted
           FROM finance_schema.operator_earnings ORDER BY id`,
      ),
    ).toEqual(earnings);
  });

  it('jadvallar / sxemalar yo`q muhitda — xatosiz o`tadi; down() — no-op', async () => {
    await expect(up()).resolves.toBeUndefined();
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
