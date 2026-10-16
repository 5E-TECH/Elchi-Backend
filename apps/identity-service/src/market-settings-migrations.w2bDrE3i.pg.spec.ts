import { DataSource } from 'typeorm';
import { OrderOperatorPhones1716000000113 } from '../../../migrations/1716000000113-OrderOperatorPhones';
import { MarketExtraCostAndOperatorPhone1716000000114 } from '../../../migrations/1716000000114-MarketExtraCostAndOperatorPhone';

/**
 * w2bDrE3i / VRyloH62 — migratsiyalar 113 va 114 HAQIQIY Postgres'da.
 *
 * w2bDrE3i TC6 (ortga-moslik): MAVJUD marketlarda qo'shimcha xarajat OCHIQ
 * qoladi (avval darvoza yo'q edi), YANGI qatorlar sukuti — YOPIQ. Bu
 * backfill UPDATE'siz, faqat "fast default" + `SET DEFAULT false` bilan.
 *
 * Faqat lokal baza (`/elchi_o2_test`):
 *   O2_PG_TEST_URI=postgres://postgres@127.0.0.1:55495/elchi_o2_test
 */
const uri = process.env.O2_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_o2_test'
  );
})();

type Row = Record<string, unknown>;

(localTestDatabase ? describe : describe.skip)(
  'w2bDrE3i / VRyloH62 — migratsiya 113, 114 (pg)',
  () => {
    let db: DataSource;

    const run = async (
      m: { up(r: unknown): Promise<void>; down(r: unknown): Promise<void> },
      direction: 'up' | 'down' = 'up',
    ) => {
      const runner = db.createQueryRunner();
      try {
        await m[direction](runner);
      } finally {
        await runner.release();
      }
    };

    beforeAll(async () => {
      db = new DataSource({ type: 'postgres', url: uri });
      await db.initialize();
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
        await db.query('DROP SCHEMA IF EXISTS order_schema CASCADE');
        await db.destroy();
      }
    });

    beforeEach(async () => {
      await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
      await db.query('DROP SCHEMA IF EXISTS order_schema CASCADE');
      await db.query('CREATE SCHEMA identity_schema');
      await db.query('CREATE SCHEMA order_schema');
      await db.query(
        `CREATE TABLE identity_schema.admins (
           id bigserial PRIMARY KEY, role varchar NOT NULL, name varchar)`,
      );
      await db.query(
        `CREATE TABLE order_schema.orders (id bigserial PRIMARY KEY, market_id bigint)`,
      );
    });

    it('⭐ 114: mavjud marketlar — extra_cost ochiq + tasdiq; YANGI qator — yopiq; operator raqami sukuti', async () => {
      await db.query(
        `INSERT INTO identity_schema.admins (role, name)
         VALUES ('market', 'Eski market'), ('courier', 'Kuryer')`,
      );
      await run(new MarketExtraCostAndOperatorPhone1716000000114());

      const old: Row[] = await db.query(
        `SELECT name, extra_cost_enabled, extra_cost_requires_approval,
                require_operator_phone, default_operator_phone
           FROM identity_schema.admins ORDER BY id`,
      );
      expect(old[0]).toEqual({
        name: 'Eski market',
        extra_cost_enabled: true,
        extra_cost_requires_approval: true,
        require_operator_phone: false,
        default_operator_phone: null,
      });

      await db.query(
        `INSERT INTO identity_schema.admins (role, name) VALUES ('market', 'Yangi market')`,
      );
      const [fresh]: Row[] = await db.query(
        `SELECT extra_cost_enabled, extra_cost_requires_approval
           FROM identity_schema.admins WHERE name = 'Yangi market'`,
      );
      expect(fresh).toEqual({
        extra_cost_enabled: false,
        extra_cost_requires_approval: true,
      });
    });

    it('114: qayta yurgizish mavjud qiymatlarni o`zgartirmaydi; down/up ishlaydi', async () => {
      await db.query(
        `INSERT INTO identity_schema.admins (role, name) VALUES ('market', 'M')`,
      );
      const migration = new MarketExtraCostAndOperatorPhone1716000000114();
      await run(migration);
      await db.query(
        `UPDATE identity_schema.admins SET extra_cost_enabled = false WHERE name = 'M'`,
      );
      await run(migration);
      const [row]: Row[] = await db.query(
        `SELECT extra_cost_enabled FROM identity_schema.admins WHERE name = 'M'`,
      );
      expect(row.extra_cost_enabled).toBe(false);

      await run(migration, 'down');
      const cols: Row[] = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'identity_schema' AND table_name = 'admins'
          ORDER BY column_name`,
      );
      expect(cols.map((c) => c.column_name)).toEqual(['id', 'name', 'role']);
      await run(migration);
    });

    it('113: orders ga operator_phone, secondary_operator_phone (NULL); idempotent; down', async () => {
      await db.query(`INSERT INTO order_schema.orders (market_id) VALUES (37)`);
      const migration = new OrderOperatorPhones1716000000113();
      await run(migration);
      await run(migration);
      const rows: Row[] = await db.query(
        `SELECT operator_phone, secondary_operator_phone FROM order_schema.orders`,
      );
      expect(rows).toEqual([
        { operator_phone: null, secondary_operator_phone: null },
      ]);
      await run(migration, 'down');
      const cols: Row[] = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'order_schema' AND table_name = 'orders'
            AND column_name LIKE '%operator_phone'`,
      );
      expect(cols).toEqual([]);
    });
  },
);
