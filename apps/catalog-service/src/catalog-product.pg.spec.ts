import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { Product } from './entities/product.entity';
import { CatalogServiceService } from './catalog-service.service';
import { ProductNameUniqueActiveOnly1716000000087 } from '../../../migrations/1716000000087-ProductNameUniqueActiveOnly';
import { ProductPrice1716000000116 } from '../../../migrations/1716000000116-ProductPrice';
import { ProductNameCaseInsensitiveUnique1716000000117 } from '../../../migrations/1716000000117-ProductNameCaseInsensitiveUnique';

/**
 * As75bkGo (partial unique indeks), 3qDsJpfW / qNwXfqLL (find_all
 * sahifalash/qidiruv), zRqDRLAZ (narx, migratsiya 116) va Aws1oApe (registrga
 * befarq nom, migratsiya 117) — haqiqiy Postgres'da. Faqat lokal baza (`/elchi_e_test`) bilan ishlaydi:
 *   CATALOG_PG_TEST_URI=postgres://postgres@127.0.0.1:55465/elchi_e_test
 */
const uri = process.env.CATALOG_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_e_test'
  );
})();

const MARKET = '121';

/** Baseline (1713400000000) dagi jadval + TO'LIQ unique indeks. */
const createBaselineTable = async (db: DataSource) => {
  await db.query('DROP SCHEMA IF EXISTS catalog_schema CASCADE');
  await db.query('CREATE SCHEMA catalog_schema');
  await db.query(`
    CREATE TABLE catalog_schema.products (
      "id" BIGSERIAL NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "is_deleted" boolean NOT NULL DEFAULT false,
      "name" character varying NOT NULL,
      "user_id" bigint NOT NULL,
      "image_url" character varying,
      CONSTRAINT "PK_products_id" PRIMARY KEY ("id")
    )
  `);
  await db.query(
    `CREATE UNIQUE INDEX "IDX_products_name_user_id" ON catalog_schema.products ("name","user_id")`,
  );
};

const nameIndexDefs = async (db: DataSource): Promise<string[]> => {
  const rows: Array<{ indexdef: string }> = await db.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'catalog_schema' AND tablename = 'products'
        AND indexdef ILIKE '%(name, user_id)%'
      ORDER BY indexname`,
  );
  return rows.map((row) => row.indexdef);
};

(localTestDatabase ? describe : describe.skip)(
  'Mahsulot katalogi — haqiqiy Postgres (As75bkGo, 3qDsJpfW)',
  () => {
    let db: DataSource;
    const migration = new ProductNameUniqueActiveOnly1716000000087();

    const runUp = async () => {
      const runner = db.createQueryRunner();
      try {
        await migration.up(runner);
      } finally {
        await runner.release();
      }
    };
    const runDown = async () => {
      const runner = db.createQueryRunner();
      try {
        await migration.down(runner);
      } finally {
        await runner.release();
      }
    };

    const runMigration = async (
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
    const priceMigration = new ProductPrice1716000000116();
    const lowerNameMigration =
      new ProductNameCaseInsensitiveUnique1716000000117();

    const lowerIndexDefs = async (): Promise<string[]> => {
      const rows: Array<{ indexdef: string }> = await db.query(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'catalog_schema'
            AND indexname = 'IDX_products_lower_name_user_id'`,
      );
      return rows.map((row) => row.indexdef);
    };

    const makeService = () => {
      const svc = new CatalogServiceService(
        db.getRepository(Product),
        { send: jest.fn(() => of({ success: true })) } as any,
        {
          send: jest.fn((pattern: { cmd: string }) =>
            of(
              pattern.cmd === 'identity.market.find_by_ids'
                ? { data: [{ id: MARKET, name: 'TEST market' }] }
                : { success: true, data: { id: MARKET, name: 'TEST market' } },
            ),
          ),
        } as any,
        { log: jest.fn(), logChange: jest.fn() } as any,
      );
      return svc;
    };

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'catalog_schema',
        entities: [Product],
      });
      await db.initialize();
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS catalog_schema CASCADE');
        await db.destroy();
      }
    });

    describe('migratsiya 087', () => {
      beforeEach(async () => {
        await createBaselineTable(db);
      });

      it('⭐ TC3: up — indeks `WHERE (is_deleted = false)` bilan, TypeORM xesh nomli to`liq indeks ham o`chadi; down — to`liq indeks qaytadi', async () => {
        // Ehtimoliy synchronize qoldig'i: boshqa nomli ikkinchi to'liq indeks.
        await db.query(
          `CREATE UNIQUE INDEX "IDX_6f7b2c0d1e8a9b3c4d5e6f7a8b" ON catalog_schema.products ("user_id","name")`,
        );
        await runUp();
        const defs = await nameIndexDefs(db);
        expect(defs).toHaveLength(1);
        expect(defs[0]).toContain('"IDX_products_name_user_id"');
        expect(defs[0]).toContain('UNIQUE');
        expect(defs[0]).toContain('WHERE (is_deleted = false)');

        await runDown();
        const after = await nameIndexDefs(db);
        expect(after).toHaveLength(1);
        expect(after[0]).toContain('UNIQUE');
        expect(after[0]).not.toContain('WHERE');
      });

      it('up ikki marta — xatosiz (idempotent)', async () => {
        await runUp();
        await expect(runUp()).resolves.toBeUndefined();
        expect(await nameIndexDefs(db)).toHaveLength(1);
      });

      it('up: indeks yo`q va FAOL dublikatlar bor — YIQILMAYDI, unique indeks yaratilmaydi', async () => {
        await db.query('DROP INDEX catalog_schema."IDX_products_name_user_id"');
        await db.query(
          `INSERT INTO catalog_schema.products (name, user_id) VALUES ('Dup', $1), ('Dup', $1)`,
          [MARKET],
        );
        await expect(runUp()).resolves.toBeUndefined();
        expect(await nameIndexDefs(db)).toEqual([]);
      });

      it('down: o`chirilgan dublikatlar bor — yiqilmaydi, partial indeks qoladi', async () => {
        await runUp();
        await db.query(
          `INSERT INTO catalog_schema.products (name, user_id, is_deleted) VALUES ('Eski', $1, true), ('Eski', $1, true)`,
          [MARKET],
        );
        await expect(runDown()).resolves.toBeUndefined();
        const defs = await nameIndexDefs(db);
        expect(defs).toHaveLength(1);
        expect(defs[0]).toContain('WHERE (is_deleted = false)');
      });
    });

    describe('servis (migratsiyadan keyin)', () => {
      beforeEach(async () => {
        await createBaselineTable(db);
        await runUp();
        await runMigration(priceMigration);
        await runMigration(lowerNameMigration);
      });

      it('⭐ TC1: yaratish -> o`chirish -> AYNI nom bilan qayta yaratish muvaffaqiyatli', async () => {
        const svc = makeService();
        const first = await svc.create({ name: 'TEST', user_id: MARKET });
        await svc.remove(first.id, { id: MARKET, roles: ['market'] });
        const again = await svc.create({ name: 'TEST', user_id: MARKET });
        expect(again.id).not.toBe(first.id);
        expect(again.name).toBe('TEST');
      });

      it('⭐ TC2: faol bir xil nomli ikkinchi mahsulot hamon 409', async () => {
        const svc = makeService();
        await svc.create({ name: 'Olma', user_id: MARKET });
        const error: unknown = await svc
          .create({ name: 'Olma', user_id: MARKET })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RpcException);
        expect((error as RpcException).getError()).toMatchObject({
          statusCode: 409,
        });
      });

      it('⭐ TC4: bir xil nomli ikkita O`CHIRILGAN mahsulot yonma-yon yashaydi', async () => {
        const svc = makeService();
        for (let i = 0; i < 2; i += 1) {
          const row = await svc.create({ name: 'Nok', user_id: MARKET });
          await svc.remove(row.id, { id: MARKET, roles: ['market'] });
        }
        const [{ count }]: Array<{ count: string }> = await db.query(
          `SELECT count(*) FROM catalog_schema.products WHERE name = 'Nok' AND is_deleted = true`,
        );
        expect(Number(count)).toBe(2);
      });

      it('o`chirilgan mahsulotni qayta nomlash (update) ham bloklanmaydi, faolga moslash 409', async () => {
        const svc = makeService();
        const a = await svc.create({ name: 'A', user_id: MARKET });
        const b = await svc.create({ name: 'B', user_id: MARKET });
        const error: unknown = await svc
          .update(b.id, { name: 'A' })
          .catch((e: unknown) => e);
        expect((error as RpcException).getError()).toMatchObject({
          statusCode: 409,
        });
        await svc.remove(a.id);
        await expect(svc.update(b.id, { name: 'A' })).resolves.toMatchObject({
          name: 'A',
        });
      });

      it('⭐ 3qDsJpfW TC1/TC2/TC3: 14 mahsulot — limit sukuti 10, page=2 qolganini, search 2-sahifadagini topadi, limit=50 total/limit to`g`ri', async () => {
        const svc = makeService();
        for (let i = 1; i <= 14; i += 1) {
          await svc.create({
            name: `Mahsulot ${String(i).padStart(2, '0')}`,
            user_id: MARKET,
          });
        }
        await svc.create({ name: 'Begona', user_id: '999' });

        const firstPage = await svc.findAll({ user_id: MARKET });
        expect(firstPage).toMatchObject({ total: 14, page: 1, limit: 10 });
        expect(firstPage.data).toHaveLength(10);

        const secondPage = await svc.findAll({
          user_id: MARKET,
          page: 2,
          limit: 10,
        });
        expect(secondPage).toMatchObject({ total: 14, page: 2, limit: 10 });
        expect(secondPage.data).toHaveLength(4);
        const firstIds = new Set(firstPage.data.map((p) => p.id));
        expect(secondPage.data.every((p) => !firstIds.has(p.id))).toBe(true);

        // Eng eski (2-sahifadagi) mahsulot nomi bilan qidiruv.
        const oldest = secondPage.data[secondPage.data.length - 1];
        const found = await svc.findAll({
          user_id: MARKET,
          search: oldest.name,
        });
        expect(found.total).toBe(1);
        expect(found.data[0].id).toBe(oldest.id);

        const all = await svc.findAll({ user_id: MARKET, limit: 50 });
        expect(all).toMatchObject({ total: 14, page: 1, limit: 50 });
        expect(all.data).toHaveLength(14);
        expect(all.data.every((p) => p.user_id === MARKET)).toBe(true);
      });
    });

    describe('migratsiya 116 (zRqDRLAZ narx) va 117 (Aws1oApe registrga befarq nom)', () => {
      beforeEach(async () => {
        await createBaselineTable(db);
        await runUp();
      });

      it("116: price ustuni NULL bilan qo'shiladi, mavjud qatorlar o'zgarmaydi, manfiy narx CHECK bilan rad; up ikki marta, down/up", async () => {
        await db.query(
          `INSERT INTO catalog_schema.products (name, user_id) VALUES ('Eski', $1)`,
          [MARKET],
        );
        await runMigration(priceMigration);
        await runMigration(priceMigration);
        const rows: Array<{ name: string; price: string | null }> =
          await db.query(`SELECT name, price FROM catalog_schema.products`);
        expect(rows).toEqual([{ name: 'Eski', price: null }]);
        await expect(
          db.query(
            `INSERT INTO catalog_schema.products (name, user_id, price) VALUES ('Manfiy', $1, -1)`,
            [MARKET],
          ),
        ).rejects.toMatchObject({ driverError: { code: '23514' } });
        await runMigration(priceMigration, 'down');
        const cols: Array<{ column_name: string }> = await db.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'catalog_schema' AND table_name = 'products'
              AND column_name = 'price'`,
        );
        expect(cols).toEqual([]);
        await runMigration(priceMigration);
      });

      it('117: indeks lower(btrim(name)) + user_id, faqat faol qatorlar; up ikki marta xatosiz', async () => {
        await runMigration(lowerNameMigration);
        await runMigration(lowerNameMigration);
        const defs = await lowerIndexDefs();
        expect(defs).toHaveLength(1);
        expect(defs[0]).toContain('UNIQUE');
        expect(defs[0]).toMatch(/lower\(btrim\(\(?name/);
        expect(defs[0]).toContain('WHERE (is_deleted = false)');
        // Registr va bo'shliq farqi bilan ikkinchi faol qator — 23505.
        await db.query(
          `INSERT INTO catalog_schema.products (name, user_id) VALUES ('Telefon', $1)`,
          [MARKET],
        );
        await expect(
          db.query(
            `INSERT INTO catalog_schema.products (name, user_id) VALUES ('  TELEFON ', $1)`,
            [MARKET],
          ),
        ).rejects.toMatchObject({ driverError: { code: '23505' } });
      });

      it("117: faol registrga befarq dublikatlar bor — YIQILMAYDI, indeks yaratilmaydi, ma'lumot o'zgarmaydi", async () => {
        await db.query(
          `INSERT INTO catalog_schema.products (name, user_id) VALUES ('test', $1), ('TEST', $1)`,
          [MARKET],
        );
        await expect(runMigration(lowerNameMigration)).resolves.toBeUndefined();
        expect(await lowerIndexDefs()).toEqual([]);
        const rows: Array<{ name: string }> = await db.query(
          `SELECT name FROM catalog_schema.products ORDER BY id`,
        );
        expect(rows.map((r) => r.name)).toEqual(['test', 'TEST']);
      });
    });

    describe('Aws1oApe va zRqDRLAZ — servis', () => {
      beforeEach(async () => {
        await createBaselineTable(db);
        await runUp();
        await runMigration(priceMigration);
        await runMigration(lowerNameMigration);
      });

      const conflictOf = async (promise: Promise<unknown>) => {
        const error: unknown = await promise.then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(RpcException);
        return (error as RpcException).getError() as {
          statusCode?: number;
          message?: string;
        };
      };

      it('⭐ Aws1oApe TC1: "Telefon" bor — "telefon" va "  Telefon  " → 409', async () => {
        const svc = makeService();
        await svc.create({ name: 'Telefon', user_id: MARKET });
        for (const name of ['telefon', '  Telefon  ', 'TELEFON']) {
          expect(
            await conflictOf(svc.create({ name, user_id: MARKET })),
          ).toMatchObject({ statusCode: 409 });
        }
        // Boshqa marketda shu nom — ruxsat.
        await expect(
          svc.create({ name: 'telefon', user_id: '999' }),
        ).resolves.toMatchObject({ name: 'telefon' });
      });

      it("⭐ Aws1oApe TC2: nom ASL registrda saqlanadi, chetdagi va ichki ortiqcha bo'shliqlar qisqaradi", async () => {
        const svc = makeService();
        const created = await svc.create({
          name: '  Samsung   Galaxy A15 ',
          user_id: MARKET,
        });
        expect(created.name).toBe('Samsung Galaxy A15');
        const [row]: Array<{ name: string }> = await db.query(
          `SELECT name FROM catalog_schema.products WHERE id = $1`,
          [created.id],
        );
        expect(row.name).toBe('Samsung Galaxy A15');
      });

      it("⭐ Aws1oApe TC4: PATCH bilan nomni boshqa mavjud mahsulot nomiga (registr farqi bilan) o'zgartirish → 409", async () => {
        const svc = makeService();
        await svc.create({ name: 'Olma', user_id: MARKET });
        const pear = await svc.create({ name: 'Nok', user_id: MARKET });
        expect(
          await conflictOf(svc.update(pear.id, { name: 'OLMA' })),
        ).toMatchObject({ statusCode: 409 });
        expect(
          await conflictOf(svc.updateOwn(pear.id, MARKET, { name: ' olma ' })),
        ).toMatchObject({ statusCode: 409 });
        // O'z nomining registrini o'zgartirish — ruxsat.
        await expect(
          svc.update(pear.id, { name: 'NOK' }),
        ).resolves.toMatchObject({ name: 'NOK' });
      });

      it("bo'sh nom → 400", async () => {
        const svc = makeService();
        expect(
          await conflictOf(svc.create({ name: '   ', user_id: MARKET })),
        ).toMatchObject({ statusCode: 400 });
      });

      it("⭐ zRqDRLAZ: narx saqlanadi va javobda son bo'lib qaytadi; narxsiz — null; tozalash va noto'g'ri narx", async () => {
        const svc = makeService();
        const withPrice = await svc.create({
          name: 'Futbolka',
          user_id: MARKET,
          price: '125000.50',
        });
        expect(withPrice.price).toBe(125000.5);
        const fetched = await svc.findById(withPrice.id);
        expect(fetched).toMatchObject({ price: 125000.5 });
        expect(fetched).toHaveProperty('image_url');

        const noPrice = await svc.create({ name: 'Viva', user_id: MARKET });
        expect(noPrice.price).toBeNull();

        await expect(
          svc.update(withPrice.id, { price: null }),
        ).resolves.toMatchObject({ price: null });
        await expect(
          svc.update(noPrice.id, { price: 99000 }),
        ).resolves.toMatchObject({ price: 99000 });

        for (const bad of [-1, '12.345', 'abc']) {
          expect(
            await conflictOf(
              svc.create({
                name: `X${String(bad)}`,
                user_id: MARKET,
                price: bad,
              }),
            ),
          ).toMatchObject({ statusCode: 400 });
        }

        const list = await svc.findAll({ user_id: MARKET, limit: 50 });
        expect(list.data.find((p) => p.id === noPrice.id)).toMatchObject({
          price: 99000,
        });
      });
    });
  },
);
