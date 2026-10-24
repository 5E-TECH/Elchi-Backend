import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import { Product } from './entities/product.entity';
import { CatalogServiceService } from './catalog-service.service';
import { ProductNameUniqueActiveOnly1716000000087 } from '../../../migrations/1716000000087-ProductNameUniqueActiveOnly';
import { ProductPrice1716000000116 } from '../../../migrations/1716000000116-ProductPrice';
import { ProductNameCaseInsensitiveUnique1716000000117 } from '../../../migrations/1716000000117-ProductNameCaseInsensitiveUnique';
import { ProductMeasurementsAndCodes1716000000141 } from '../../../migrations/1716000000141-ProductMeasurementsAndCodes';
import { formatProductSkuCode } from '@app/common';

/**
 * As75bkGo (partial unique indeks), 3qDsJpfW / qNwXfqLL (find_all
 * sahifalash/qidiruv), zRqDRLAZ (narx, migratsiya 116), Aws1oApe (registrga
 * befarq nom, migratsiya 117) va MH-3 / hY7uacJu (o'lchov, shtrix kod,
 * Elchi kodi — migratsiya 141) — haqiqiy Postgres'da. Faqat lokal baza (`/elchi_e_test`) bilan ishlaydi:
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
    const measureMigration = new ProductMeasurementsAndCodes1716000000141();

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
        // MH-3: entity endi o'lchov/kod ustunlarini ham o'qiydi.
        await runMigration(measureMigration);
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
        // MH-3: entity endi o'lchov/kod ustunlarini ham o'qiydi.
        await runMigration(measureMigration);
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

    describe('migratsiya 141 (MH-3 o`lchov + hY7uacJu kodlar)', () => {
      const NEW_COLUMNS = [
        'barcode',
        'height_cm',
        'length_cm',
        'sku_code',
        'volumetric_enabled',
        'weight_kg',
        'width_cm',
      ];
      const NEW_CHECKS = [
        'CHK_products_barcode_not_blank',
        'CHK_products_dimensions_all_or_none',
        'CHK_products_dimensions_positive',
        'CHK_products_weight_kg_positive',
      ];
      const NEW_INDEXES = [
        'UQ_products_barcode_user_id',
        'UQ_products_sku_code',
      ];

      const columns = async (): Promise<string[]> => {
        const rows: Array<{ column_name: string }> = await db.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'catalog_schema' AND table_name = 'products'
              AND column_name = ANY($1)
            ORDER BY column_name`,
          [NEW_COLUMNS],
        );
        return rows.map((r) => r.column_name);
      };
      const checks = async (): Promise<string[]> => {
        const rows: Array<{ conname: string }> = await db.query(
          `SELECT conname FROM pg_constraint
            WHERE conrelid = 'catalog_schema.products'::regclass
              AND conname = ANY($1)
            ORDER BY conname`,
          [NEW_CHECKS],
        );
        return rows.map((r) => r.conname);
      };
      const indexes = async (): Promise<
        Array<{ indexname: string; indexdef: string }>
      > =>
        db.query(
          `SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = 'catalog_schema' AND tablename = 'products'
              AND indexname = ANY($1)
            ORDER BY indexname`,
          [NEW_INDEXES],
        );

      beforeEach(async () => {
        await createBaselineTable(db);
        await runUp();
        await runMigration(priceMigration);
        await runMigration(lowerNameMigration);
      });

      it('⭐ CL1 up: 7 ustun; eski qatorda o`lchov NULL, volumetric true; turlar numeric / integer; up ikki marta xatosiz', async () => {
        await db.query(
          `INSERT INTO catalog_schema.products (name, user_id) VALUES ('Eski', $1)`,
          [MARKET],
        );
        await runMigration(measureMigration);
        await expect(runMigration(measureMigration)).resolves.toBeUndefined();

        expect(await columns()).toEqual(NEW_COLUMNS);
        expect(await checks()).toEqual(NEW_CHECKS);
        const idx = await indexes();
        expect(idx.map((i) => i.indexname)).toEqual(NEW_INDEXES);
        const barcodeIdx = idx[0].indexdef;
        expect(barcodeIdx).toContain('UNIQUE');
        expect(barcodeIdx).toContain('(barcode, user_id)');
        expect(barcodeIdx).toContain('is_deleted = false');
        expect(barcodeIdx).toContain('barcode IS NOT NULL');

        await db.query(
          `UPDATE catalog_schema.products SET weight_kg = 1.2, length_cm = 30, width_cm = 22, height_cm = 15`,
        );
        const [row]: Array<Record<string, unknown>> = await db.query(
          `SELECT weight_kg, pg_typeof(weight_kg)::text AS wt,
                  pg_typeof(length_cm)::text AS lt, volumetric_enabled,
                  barcode, sku_code
             FROM catalog_schema.products`,
        );
        expect(row).toMatchObject({
          weight_kg: '1.200',
          wt: 'numeric',
          lt: 'integer',
          volumetric_enabled: true,
          barcode: null,
          sku_code: 'ELC-P-000001',
        });
      });

      it('eski qatorlarda o`lchov NULL bo`lib qoladi (backfill yo`q)', async () => {
        await db.query(
          `INSERT INTO catalog_schema.products (name, user_id) VALUES ('A', $1), ('B', $1)`,
          [MARKET],
        );
        await runMigration(measureMigration);
        const rows: Array<Record<string, unknown>> = await db.query(
          `SELECT weight_kg, length_cm, width_cm, height_cm, volumetric_enabled
             FROM catalog_schema.products ORDER BY id`,
        );
        for (const r of rows) {
          expect(r).toEqual({
            weight_kg: null,
            length_cm: null,
            width_cm: null,
            height_cm: null,
            volumetric_enabled: true,
          });
        }
      });

      it('⭐ sku_code: mavjud qatorlar to`ldiriladi (7 xonali id QISQARMAYDI), yangi qatorga o`zi beriladi, UPDATE — xato', async () => {
        await db.query(
          `INSERT INTO catalog_schema.products (name, user_id) VALUES ('Bir', $1)`,
          [MARKET],
        );
        await db.query(
          `SELECT setval(pg_get_serial_sequence('catalog_schema.products', 'id'), 1234566)`,
        );
        await db.query(
          `INSERT INTO catalog_schema.products (name, user_id) VALUES ('Katta', $1)`,
          [MARKET],
        );
        await runMigration(measureMigration);
        await db.query(
          `INSERT INTO catalog_schema.products (name, user_id) VALUES ('Yangi', $1)`,
          [MARKET],
        );
        const rows: Array<{ id: string; sku_code: string }> = await db.query(
          `SELECT id, sku_code FROM catalog_schema.products ORDER BY id`,
        );
        expect(rows.map((r) => r.sku_code)).toEqual([
          'ELC-P-000001',
          'ELC-P-1234567',
          'ELC-P-1234568',
        ]);
        for (const r of rows) {
          expect(r.sku_code).toBe(formatProductSkuCode(r.id));
        }
        await expect(
          db.query(`UPDATE catalog_schema.products SET sku_code = 'X'`),
        ).rejects.toBeDefined();
      });

      it('CHECK`lar: og`irlik/o`lcham > 0, L/W/H uchalasi yoki hech biri, bo`sh kod — 23514', async () => {
        await runMigration(measureMigration);
        for (const sql of [
          `INSERT INTO catalog_schema.products (name, user_id, weight_kg) VALUES ('a', $1, 0)`,
          `INSERT INTO catalog_schema.products (name, user_id, length_cm, width_cm, height_cm) VALUES ('b', $1, 0, 1, 1)`,
          `INSERT INTO catalog_schema.products (name, user_id, length_cm) VALUES ('c', $1, 10)`,
          `INSERT INTO catalog_schema.products (name, user_id, barcode) VALUES ('d', $1, '   ')`,
        ]) {
          await expect(db.query(sql, [MARKET])).rejects.toMatchObject({
            driverError: { code: '23514' },
          });
        }
        await expect(
          db.query(
            `INSERT INTO catalog_schema.products (name, user_id, weight_kg, length_cm, width_cm, height_cm) VALUES ('ok', $1, 0.001, 1, 1, 1)`,
            [MARKET],
          ),
        ).resolves.toBeDefined();
      });

      it('⭐ CL2 down: 7 ustun, 4 CHECK, 2 indeks yo`qoladi; down → up qayta ishlaydi', async () => {
        await runMigration(measureMigration);
        await runMigration(measureMigration, 'down');
        expect(await columns()).toEqual([]);
        expect(await checks()).toEqual([]);
        expect(await indexes()).toEqual([]);
        await expect(
          runMigration(measureMigration, 'down'),
        ).resolves.toBeUndefined();
        await runMigration(measureMigration);
        expect(await columns()).toEqual(NEW_COLUMNS);
      });

      it('jadval yo`q muhitda (yangi baza) up/down — no-op', async () => {
        await db.query('DROP SCHEMA IF EXISTS catalog_schema CASCADE');
        await db.query('CREATE SCHEMA catalog_schema');
        await expect(runMigration(measureMigration)).resolves.toBeUndefined();
        await expect(
          runMigration(measureMigration, 'down'),
        ).resolves.toBeUndefined();
      });
    });

    describe('MH-3 / hY7uacJu — servis (o`lchov, shtrix kod, by-code)', () => {
      beforeEach(async () => {
        await createBaselineTable(db);
        await runUp();
        await runMigration(priceMigration);
        await runMigration(lowerNameMigration);
        await runMigration(measureMigration);
      });

      const errorOf = async (promise: Promise<unknown>) => {
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

      const MEASURED = {
        weight_kg: '1.2',
        length_cm: '30',
        width_cm: '22',
        height_cm: '15',
      };

      it('⭐ CL3/CL6/CL10: o`lchov RAQAM bo`lib qaytadi, volumetric sukut true, sku_code bor; findAll/findById ham', async () => {
        const svc = makeService();
        const created = await svc.create({
          name: 'Kitob',
          user_id: MARKET,
          ...MEASURED,
        });
        expect(created).toMatchObject({
          weight_kg: 1.2,
          length_cm: 30,
          width_cm: 22,
          height_cm: 15,
          volumetric_enabled: true,
          barcode: null,
          sku_code: formatProductSkuCode(created.id),
        });
        expect(typeof created.weight_kg).toBe('number');

        const fetched = await svc.findById(created.id);
        expect(fetched).toMatchObject({ weight_kg: 1.2, length_cm: 30 });
        const list = await svc.findAll({ user_id: MARKET });
        expect(list.data[0]).toMatchObject({
          weight_kg: 1.2,
          height_cm: 15,
          volumetric_enabled: true,
          sku_code: formatProductSkuCode(created.id),
        });
        expect(list.data[0]).toHaveProperty('barcode', null);
      });

      it('⭐ CL7: volumetric_enabled=false saqlanadi', async () => {
        const svc = makeService();
        const created = await svc.create({
          name: 'Yostiq',
          user_id: MARKET,
          ...MEASURED,
          volumetric_enabled: false,
        });
        expect(created.volumetric_enabled).toBe(false);
        const [row]: Array<{ volumetric_enabled: boolean }> = await db.query(
          `SELECT volumetric_enabled FROM catalog_schema.products WHERE id = $1`,
          [created.id],
        );
        expect(row.volumetric_enabled).toBe(false);
      });

      it('⭐ save() dan keyin darhol sku_code (INSERT RETURNING)', async () => {
        const repo = db.getRepository(Product);
        const saved = await repo.save(
          repo.create({ name: 'Ruchka', user_id: MARKET }),
        );
        expect(saved.sku_code).toBe(formatProductSkuCode(saved.id));
        // Entity orqali sku_code yozilmaydi (`update: false`).
        saved.sku_code = 'ELC-P-999999';
        saved.name = 'Ruchka 2';
        await repo.save(saved);
        const [row]: Array<{ sku_code: string; name: string }> = await db.query(
          `SELECT sku_code, name FROM catalog_schema.products WHERE id = $1`,
          [saved.id],
        );
        expect(row).toEqual({
          sku_code: formatProductSkuCode(saved.id),
          name: 'Ruchka 2',
        });
      });

      it('⭐ ichki yo`l (hamkor `{ name, user_id }`) — o`lchovsiz: NULL, volumetric true, sku_code bor', async () => {
        const svc = makeService();
        const created = await svc.create({ name: 'Hamkor', user_id: MARKET });
        expect(created).toMatchObject({
          weight_kg: null,
          length_cm: null,
          width_cm: null,
          height_cm: null,
          volumetric_enabled: true,
          sku_code: formatProductSkuCode(created.id),
        });
      });

      it('⭐ CL8: PATCH — to`liq o`lchovli mahsulotda height; eski (o`lchovsiz) mahsulotga faqat height → 400; faqat nom — OK', async () => {
        const svc = makeService();
        const measured = await svc.create({
          name: 'Olchovli',
          user_id: MARKET,
          ...MEASURED,
        });
        await expect(
          svc.update(measured.id, { height_cm: 20 }),
        ).resolves.toMatchObject({ height_cm: 20, length_cm: 30 });

        const old = await svc.create({ name: 'Eski', user_id: MARKET });
        expect(
          await errorOf(svc.update(old.id, { height_cm: 20 })),
        ).toMatchObject({ statusCode: 400 });
        await expect(
          svc.update(old.id, { name: 'Eski 2' }),
        ).resolves.toMatchObject({ name: 'Eski 2', height_cm: null });
        await expect(
          svc.update(old.id, {
            weight_kg: 0.5,
            length_cm: 10,
            width_cm: 10,
            height_cm: 10,
          }),
        ).resolves.toMatchObject({ weight_kg: 0.5, height_cm: 10 });
        expect(
          await errorOf(svc.update(measured.id, { weight_kg: null })),
        ).toMatchObject({ statusCode: 400 });
      });

      it('⭐ shtrix kod: bir marketda dublikat 409 (mahsulot nomi bilan, nom xabaridan farqli); boshqa marketda OK; o`chirilgan kod qayta ishlatiladi', async () => {
        const svc = makeService();
        const pepsi = await svc.create({
          name: 'Pepsi 0.5',
          user_id: MARKET,
          barcode: '4780000000007',
        });
        expect(pepsi.barcode).toBe('4780000000007');

        const dup = await errorOf(
          svc.create({
            name: 'Cola',
            user_id: MARKET,
            barcode: '4780000000007',
          }),
        );
        expect(dup.statusCode).toBe(409);
        expect(dup.message).toContain('Pepsi 0.5');
        expect(dup.message).toMatch(/shtrix kod/);

        await expect(
          svc.create({
            name: 'Cola',
            user_id: '999',
            barcode: '4780000000007',
          }),
        ).resolves.toMatchObject({ barcode: '4780000000007' });

        await svc.remove(pepsi.id);
        await expect(
          svc.create({
            name: 'Cola',
            user_id: MARKET,
            barcode: '4780000000007',
          }),
        ).resolves.toMatchObject({ barcode: '4780000000007' });
      });

      it('⭐ poyga: oldindan tekshiruv chetlab o`tilsa — 23505 indeks nomi bo`yicha shtrix kod 409', async () => {
        const svc = makeService();
        await svc.create({
          name: 'Pepsi',
          user_id: MARKET,
          barcode: '4780000000007',
        });
        jest
          .spyOn(svc as any, 'ensureBarcodeAvailable')
          .mockResolvedValue(undefined);
        const error = await errorOf(
          svc.create({
            name: 'Cola',
            user_id: MARKET,
            barcode: '4780000000007',
          }),
        );
        expect(error.statusCode).toBe(409);
        expect(error.message).toMatch(/shtrix kod/);
        expect(error.message).not.toMatch(/nomdagi/);
      });

      it('poyga: Promise.all bilan ikki create — bittasi 201, ikkinchisi 409', async () => {
        const svc = makeService();
        const results = await Promise.allSettled([
          svc.create({ name: 'A1', user_id: MARKET, barcode: '4006381333931' }),
          svc.create({ name: 'A2', user_id: MARKET, barcode: '4006381333931' }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        expect((rejected?.reason as RpcException).getError()).toMatchObject({
          statusCode: 409,
        });
      });

      it('nazorat raqami noto`g`ri EAN — create va PATCH 400; PATCH "" / null — tozalash', async () => {
        const svc = makeService();
        expect(
          await errorOf(
            svc.create({
              name: 'X',
              user_id: MARKET,
              barcode: '4006381333932',
            }),
          ),
        ).toMatchObject({ statusCode: 400 });
        const row = await svc.create({
          name: 'Y',
          user_id: MARKET,
          barcode: '4006381333931',
        });
        expect(
          await errorOf(svc.update(row.id, { barcode: '4006381333932' })),
        ).toMatchObject({ statusCode: 400 });
        await expect(
          svc.update(row.id, { barcode: '' }),
        ).resolves.toMatchObject({ barcode: null });
        await svc.update(row.id, { barcode: '4006381333931' });
        await expect(
          svc.update(row.id, { barcode: null }),
        ).resolves.toMatchObject({ barcode: null });
      });

      it('⭐ by-code: ELC-P (registrga befarq, nolsiz ham) → sku_code; EAN → barcode; begona market / o`chirilgan → []', async () => {
        const svc = makeService();
        const own = await svc.create({
          name: 'Choy',
          user_id: MARKET,
          barcode: '4780000000007',
        });
        const sku = formatProductSkuCode(own.id);

        for (const code of [sku, sku.toLowerCase(), `elc-p-${own.id}`]) {
          const found = await svc.findByCode(code);
          expect(found).toMatchObject({ total: 1, matched_by: 'sku_code' });
          expect(found.data[0]).toMatchObject({
            id: own.id,
            market: { id: MARKET },
          });
        }

        await expect(
          svc.findByCode('4780000000007', MARKET),
        ).resolves.toMatchObject({
          total: 1,
          matched_by: 'barcode',
          data: [expect.objectContaining({ id: own.id })],
        });

        await expect(svc.findByCode(sku, '999')).resolves.toEqual({
          data: [],
          total: 0,
          matched_by: null,
        });
        await expect(svc.findByCode('4006381333931')).resolves.toMatchObject({
          data: [],
          total: 0,
          matched_by: null,
        });

        await svc.remove(own.id);
        await expect(svc.findByCode(sku)).resolves.toMatchObject({
          total: 0,
          data: [],
        });
      });

      it('⭐ by-code: user_id`siz — ikki marketdagi bir xil EAN 2 qator; 12 xonali skan 13 xonali saqlanganini topadi', async () => {
        const svc = makeService();
        await svc.create({
          name: 'Suv',
          user_id: MARKET,
          barcode: '4780000000007',
        });
        await svc.create({
          name: 'Suv',
          user_id: '999',
          barcode: '4780000000007',
        });
        const both = await svc.findByCode('4780000000007');
        expect(both.total).toBe(2);
        expect(both.data.map((p) => p.user_id).sort()).toEqual(['121', '999']);

        // ⭐ UPC-A (12) skani KANONIK 13 xonali shaklda saqlanadi; 12/13/14
        // xonali va DataMatrix skanlari uni topadi.
        const upc = await svc.create({
          name: 'Upc',
          user_id: MARKET,
          barcode: '036000291452',
        });
        expect(upc.barcode).toBe('0036000291452');
        for (const scan of [
          '036000291452',
          '0036000291452',
          '00036000291452',
          ']d20100036000291452215xyz',
        ]) {
          await expect(svc.findByCode(scan, MARKET)).resolves.toMatchObject({
            total: 1,
            matched_by: 'barcode',
            data: [expect.objectContaining({ id: upc.id })],
          });
        }
      });

      it('⭐ bir marketda bitta GTIN`ning UPC-A va EAN-13 / GTIN-14 yozuvlari — ikkinchisi 409; boshqa marketda OK', async () => {
        const svc = makeService();
        await svc.create({
          name: 'Upc',
          user_id: MARKET,
          barcode: '036000291452',
        });
        for (const [name, barcode] of [
          ['Ean', '0036000291452'],
          ['Gtin14', '00036000291452'],
          ['DataMatrix', '(01)00036000291452(21)SN1'],
        ]) {
          const dup = await errorOf(
            svc.create({ name, user_id: MARKET, barcode }),
          );
          expect(dup.statusCode).toBe(409);
          expect(dup.message).toContain('Upc');
        }
        // Oldindan tekshiruv chetlab o'tilsa ham — unique indeks (kanonik
        // qiymat bir xil) ushlaydi.
        jest
          .spyOn(svc as any, 'ensureBarcodeAvailable')
          .mockResolvedValue(undefined);
        const raced = await errorOf(
          svc.create({
            name: 'Ean2',
            user_id: MARKET,
            barcode: '0036000291452',
          }),
        );
        expect(raced.statusCode).toBe(409);
        expect(raced.message).toMatch(/shtrix kod/);

        await expect(
          svc.create({ name: 'Ean', user_id: '999', barcode: '0036000291452' }),
        ).resolves.toMatchObject({ barcode: '0036000291452' });
      });

      it('⭐ UPC-E (8 xona) — kengaytirilgan UPC-A ning kanonik shaklida saqlanadi; 8/12/13/14 xonali skan topadi; UPC-A yozuvi — 409', async () => {
        const svc = makeService();
        const cola = await svc.create({
          name: 'Cola',
          user_id: MARKET,
          barcode: '04963406',
        });
        expect(cola.barcode).toBe('0049000006346');
        for (const scan of [
          '04963406',
          '049000006346',
          '0049000006346',
          '00049000006346',
        ]) {
          await expect(svc.findByCode(scan, MARKET)).resolves.toMatchObject({
            total: 1,
            matched_by: 'barcode',
            data: [expect.objectContaining({ id: cola.id })],
          });
        }
        const dup = await errorOf(
          svc.create({
            name: 'Cola2',
            user_id: MARKET,
            barcode: '049000006346',
          }),
        );
        expect(dup.statusCode).toBe(409);
        expect(dup.message).toContain('Cola');

        // UPC-E / EAN-8 ikkiligi: `1…` kod GTIN-8 bo'lib saqlanadi, uning
        // UPC-A yozuvi (boshqa qiymat) ham band deb topiladi va qidiriladi.
        const dual = await svc.create({
          name: 'Dual',
          user_id: MARKET,
          barcode: '10017265',
        });
        expect(dual.barcode).toBe('10017265');
        await expect(
          svc.findByCode('100172000065', MARKET),
        ).resolves.toMatchObject({
          total: 1,
          data: [expect.objectContaining({ id: dual.id })],
        });
        const dualDup = await errorOf(
          svc.create({
            name: 'Dual2',
            user_id: MARKET,
            barcode: '100172000065',
          }),
        );
        expect(dualDup.statusCode).toBe(409);
        expect(dualDup.message).toContain('Dual');
      });

      it('DB CHECK 23514 — pg `constraint` nomi handleDbError`ga yetadi (aniq xabar)', async () => {
        const repo = db.getRepository(Product);
        const svc = makeService();
        const error: unknown = await repo
          .save(repo.create({ name: 'Chala', user_id: MARKET, length_cm: 10 }))
          .catch((e: unknown) => e);
        expect(error).toMatchObject({
          driverError: {
            code: '23514',
            constraint: 'CHK_products_dimensions_all_or_none',
          },
        });
        let mapped: unknown;
        try {
          (svc as any).handleDbError(error);
        } catch (e) {
          mapped = e;
        }
        expect((mapped as RpcException).getError()).toMatchObject({
          statusCode: 400,
          message: expect.stringMatching(/uchalasi/),
        });
      });

      it('by-code: noto`g`ri ELC-P va bo`sh kod → 400', async () => {
        const svc = makeService();
        expect(await errorOf(svc.findByCode('ELC-P-x'))).toMatchObject({
          statusCode: 400,
        });
        expect(await errorOf(svc.findByCode('  '))).toMatchObject({
          statusCode: 400,
        });
      });

      it('⭐ findAll search: Elchi kodi va EAN bo`yicha ham topadi; nom ILIKE avvalgidek', async () => {
        const svc = makeService();
        await svc.create({ name: 'Birinchi', user_id: MARKET });
        await svc.create({ name: 'Ikkinchi', user_id: MARKET });
        const third = await svc.create({
          name: 'Uchinchi',
          user_id: MARKET,
          barcode: '73513537',
        });

        const bySku = await svc.findAll({
          user_id: MARKET,
          search: formatProductSkuCode(third.id),
        });
        expect(bySku.data.map((p) => p.id)).toEqual([third.id]);

        const byEan = await svc.findAll({
          user_id: MARKET,
          search: '73513537',
        });
        expect(byEan.data.map((p) => p.id)).toEqual([third.id]);

        const byName = await svc.findAll({ user_id: MARKET, search: 'inchi' });
        expect(byName.total).toBe(3);
      });
    });
  },
);
