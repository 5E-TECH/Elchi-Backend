import { RpcException } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { Product } from '../entities/product.entity';
import { WarehouseModule1716000000143 } from '../../../../migrations/1716000000143-WarehouseModule';
import { MarketOperatorWarehouseAccess1716000000152 } from '../../../../migrations/1716000000152-MarketOperatorWarehouseAccess';
import {
  Warehouse,
  WAREHOUSE_ENTITIES,
  WarehouseService,
  WarehouseStockService,
} from './index';
import type { WarehouseDirectoryService } from './warehouse-directory.service';

/**
 * hY7uacJu — ombor moduli haqiqiy Postgres'da: migratsiya 143 (qayta
 * yurgizish, down), DB CHECK/trigger'lar, kirim/inventarizatsiya
 * idempotentligi, buyurtma RPC'lari (reserve/release/out/return — takroriy
 * chaqiruv qoldiqni ikki marta o'zgartirmaydi), PARALLEL band (manfiy
 * qoldiq / ortiqcha band yo'q), manba tanlovi va market IDOR.
 *
 * Faqat lokal `/elchi_e_test` bazasi:
 *   CATALOG_PG_TEST_URI=postgres://postgres:root@127.0.0.1:5432/elchi_e_test
 * Alohida sxemalar (`wh_pg_catalog_<pid>`, `wh_pg_identity_<pid>`) — boshqa
 * spec'lar `catalog_schema` ni tashlab yuborishi bilan to'qnashmaydi.
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

const CATALOG = `wh_pg_catalog_${process.pid}`;
const IDENTITY = `wh_pg_identity_${process.pid}`;
const MARKET_A = '501';
const MARKET_B = '502';
const BRANCH_SAM = '11';
const BRANCH_FAR = '12';
const BRANCH_HQ = '1';
const REGION_SAM = '7';
const REGION_FAR = '8';
const ADMIN = { id: '2', roles: ['admin'] };
const COURIER = { id: '77', role: 'courier' };

const createBaseTables = async (db: DataSource) => {
  await db.query(`DROP SCHEMA IF EXISTS "${CATALOG}" CASCADE`);
  await db.query(`DROP SCHEMA IF EXISTS "${IDENTITY}" CASCADE`);
  await db.query(`CREATE SCHEMA "${CATALOG}"`);
  await db.query(`CREATE SCHEMA "${IDENTITY}"`);
  // products — baseline + 116 (narx) + 141 (o'lchov, kodlar).
  await db.query(`
    CREATE TABLE "${CATALOG}".products (
      "id" BIGSERIAL PRIMARY KEY,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "is_deleted" boolean NOT NULL DEFAULT false,
      "name" character varying NOT NULL,
      "user_id" bigint NOT NULL,
      "image_url" character varying,
      "price" numeric(14,2),
      "weight_kg" numeric(10,3),
      "length_cm" integer,
      "width_cm" integer,
      "height_cm" integer,
      "volumetric_enabled" boolean NOT NULL DEFAULT true,
      "barcode" character varying(512),
      "sku_code" character varying(32) GENERATED ALWAYS AS (
        'ELC-P-' || lpad("id"::text, GREATEST(6, length("id"::text)), '0')
      ) STORED
    )`);
  await db.query(`
    CREATE TABLE "${IDENTITY}".admins (
      "id" BIGSERIAL PRIMARY KEY,
      "name" character varying NOT NULL
    )`);
  await db.query(
    `INSERT INTO "${IDENTITY}".admins (name) VALUES ('Baraka Shop')`,
  );
};

const errorOf = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as Record<string, unknown>;
};

const pgCode = async (promise: Promise<unknown>) => {
  const error = (await promise.then(
    () => null,
    (e: unknown) => e,
  )) as { driverError?: { code?: string }; code?: string } | null;
  return error?.driverError?.code ?? error?.code ?? null;
};

(localTestDatabase ? describe : describe.skip)(
  'Ombor moduli — haqiqiy Postgres (hY7uacJu, migratsiya 143)',
  () => {
    let db: DataSource;
    const migration = new WarehouseModule1716000000143(CATALOG, IDENTITY);

    const runMigration = async (direction: 'up' | 'down' = 'up') => {
      const runner = db.createQueryRunner();
      try {
        await migration[direction](runner);
      } finally {
        await runner.release();
      }
    };

    const branches: Record<
      string,
      { region_id: string; name: string; eligible: boolean }
    > = {
      [BRANCH_SAM]: {
        region_id: REGION_SAM,
        name: 'Samarqand filiali',
        eligible: true,
      },
      [BRANCH_FAR]: {
        region_id: REGION_FAR,
        name: "Farg'ona filiali",
        eligible: true,
      },
      [BRANCH_HQ]: { region_id: '1', name: 'HQ', eligible: false },
    };
    const marketFlags: Record<string, boolean> = {
      [MARKET_A]: true,
      [MARKET_B]: false,
    };

    const directory = {
      getBranch: jest.fn((id: string) => {
        const branch = branches[id];
        return Promise.resolve(
          branch
            ? {
                id,
                name: branch.name,
                type: branch.eligible ? 'REGIONAL' : 'HQ',
                status: 'active',
                address: `${branch.name} manzili`,
                region_id: branch.region_id,
                region: {
                  id: branch.region_id,
                  name: `Viloyat ${branch.region_id}`,
                },
                eligible: branch.eligible,
              }
            : null,
        );
      }),
      getBranches: jest.fn(async (ids: string[]) => {
        const map = new Map();
        for (const id of ids) map.set(id, await directory.getBranch(id));
        return map;
      }),
      getBranchManagerIds: jest.fn(() => Promise.resolve(['31'])),
      // XtcEyQjb: mas'ul xodim tanlanmasa — birinchi faol menejer.
      getFirstActiveBranchManagerId: jest.fn(
        (): Promise<string | null> => Promise.resolve('31'),
      ),
      regionForDistrict: jest.fn((id: string) =>
        Promise.resolve(id === '700' ? REGION_SAM : null),
      ),
      getUsers: jest.fn((ids: string[]) =>
        Promise.resolve(
          new Map(
            ids.map((id) => [
              id,
              {
                id,
                name: `User ${id}`,
                phone_number: '+998900000000',
                role: 'manager',
              },
            ]),
          ),
        ),
      ),
      getUserSummaries: jest.fn((ids: string[]) =>
        Promise.resolve(
          new Map(
            ids.map((id) => [
              id,
              { id, name: `User ${id}`, phone_number: null, role: 'admin' },
            ]),
          ),
        ),
      ),
      getMarkets: jest.fn((ids: string[]) =>
        Promise.resolve(
          new Map(
            ids.map((id) => [
              id,
              {
                id,
                name: `Market ${id}`,
                status: 'active',
                can_order_from_warehouse: !!marketFlags[id],
              },
            ]),
          ),
        ),
      ),
      getMarket: jest.fn((id: string) =>
        Promise.resolve({
          id,
          name: `Market ${id}`,
          status: 'active',
          can_order_from_warehouse: !!marketFlags[id],
        }),
      ),
    };
    const activityLog = { log: jest.fn(), logChange: jest.fn() };

    let warehouses: WarehouseService;
    let stock: WarehouseStockService;

    const addProduct = async (
      name: string,
      market = MARKET_A,
      extra: Record<string, unknown> = {},
    ): Promise<{ id: string; sku_code: string }> => {
      const columns = ['name', 'user_id', ...Object.keys(extra)];
      const values = [name, market, ...Object.values(extra)];
      const rows: Array<{ id: string; sku_code: string }> = await db.query(
        `INSERT INTO "${CATALOG}".products (${columns.map((c) => `"${c}"`).join(', ')})
         VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})
         RETURNING id::text AS id, sku_code`,
        values,
      );
      return rows[0];
    };

    const stockRow = async (warehouseId: string, productId: string) => {
      const rows: Array<{ on_hand: number; reserved: number }> = await db.query(
        `SELECT on_hand, reserved FROM "${CATALOG}".warehouse_stock
          WHERE warehouse_id = $1 AND product_id = $2`,
        [warehouseId, productId],
      );
      return rows[0] ?? null;
    };

    const movementCount = async (warehouseId: string) => {
      const rows: Array<{ n: number }> = await db.query(
        `SELECT count(*)::int AS n FROM "${CATALOG}".stock_movements WHERE warehouse_id = $1`,
        [warehouseId],
      );
      return rows[0].n;
    };

    let key = 0;
    const nextKey = () => `test-key-${process.pid}-${++key}`;

    const openWarehouse = async (branchId = BRANCH_SAM) =>
      warehouses.create({ branch_id: branchId, manager_user_id: '31' }, ADMIN);

    const stockIn = (
      warehouseId: string,
      lines: unknown[],
      idempotencyKey = nextKey(),
    ) =>
      stock.stockIn({
        warehouse_id: warehouseId,
        lines,
        idempotency_key: idempotencyKey,
        actor: ADMIN,
      });

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: CATALOG,
        entities: [Product, ...WAREHOUSE_ENTITIES],
        extra: { max: 20 },
      });
      await db.initialize();
      warehouses = new WarehouseService(
        db.getRepository(Warehouse),
        db,
        directory as unknown as WarehouseDirectoryService,
        activityLog as never,
      );
      stock = new WarehouseStockService(db, activityLog as never);
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query(`DROP SCHEMA IF EXISTS "${CATALOG}" CASCADE`);
        await db.query(`DROP SCHEMA IF EXISTS "${IDENTITY}" CASCADE`);
        await db.destroy();
      }
    });

    describe('migratsiya 143', () => {
      beforeEach(async () => {
        await createBaseTables(db);
      });

      it('up ikki marta xatosiz; down tozalaydi; qayta up — ishlaydi', async () => {
        await runMigration('up');
        await expect(runMigration('up')).resolves.toBeUndefined();
        const tables: Array<{ table_name: string }> = await db.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`,
          [CATALOG],
        );
        expect(tables.map((t) => t.table_name)).toEqual([
          'products',
          'stock_movements',
          'stock_reservations',
          'warehouse_stock',
          'warehouses',
        ]);
        const [column]: Array<{ column_default: string; is_nullable: string }> =
          await db.query(
            `SELECT column_default, is_nullable FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'admins' AND column_name = 'can_order_from_warehouse'`,
            [IDENTITY],
          );
        expect(column).toEqual({ column_default: 'false', is_nullable: 'NO' });
        const [admin]: Array<{ can_order_from_warehouse: boolean }> =
          await db.query(
            `SELECT can_order_from_warehouse FROM "${IDENTITY}".admins LIMIT 1`,
          );
        expect(admin.can_order_from_warehouse).toBe(false);

        await runMigration('down');
        const after: Array<{ table_name: string }> = await db.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
          [CATALOG],
        );
        expect(after.map((t) => t.table_name)).toEqual(['products']);
        await expect(runMigration('down')).resolves.toBeUndefined();
        await expect(runMigration('up')).resolves.toBeUndefined();
      });

      it('identity jadvali yo`q muhitda — catalog qismi baribir yaratiladi', async () => {
        await db.query(`DROP TABLE "${IDENTITY}".admins`);
        await expect(runMigration('up')).resolves.toBeUndefined();
      });
    });

    describe('migratsiya 152 (XtcEyQjb)', () => {
      const access = new MarketOperatorWarehouseAccess1716000000152(IDENTITY);
      const runAccess = async (direction: 'up' | 'down') => {
        const runner = db.createQueryRunner();
        try {
          await access[direction](runner);
        } finally {
          await runner.release();
        }
      };
      const column = async () => {
        const rows: Array<{ column_default: string; is_nullable: string }> =
          await db.query(
            `SELECT column_default, is_nullable FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'admins'
                AND column_name = 'can_view_warehouse_stock'`,
            [IDENTITY],
          );
        return rows[0] ?? null;
      };

      beforeEach(async () => {
        await createBaseTables(db);
      });

      it('⭐ up ikki marta xatosiz; mavjud qatorlar — false (sukut); down — ustun yo`q; admins yo`q muhit — o`tkaziladi', async () => {
        await runAccess('up');
        await expect(runAccess('up')).resolves.toBeUndefined();
        expect(await column()).toEqual({
          column_default: 'false',
          is_nullable: 'NO',
        });
        const rows: Array<{ can_view_warehouse_stock: boolean }> =
          await db.query(
            `SELECT can_view_warehouse_stock FROM "${IDENTITY}".admins`,
          );
        expect(rows.map((row) => row.can_view_warehouse_stock)).toEqual([
          false,
        ]);
        await db.query(
          `INSERT INTO "${IDENTITY}".admins (name) VALUES ('Yangi operator')`,
        );
        const [fresh]: Array<{ can_view_warehouse_stock: boolean }> =
          await db.query(
            `SELECT can_view_warehouse_stock FROM "${IDENTITY}".admins ORDER BY id DESC LIMIT 1`,
          );
        expect(fresh.can_view_warehouse_stock).toBe(false);

        await runAccess('down');
        expect(await column()).toBeNull();
        await expect(runAccess('down')).resolves.toBeUndefined();

        await db.query(`DROP TABLE "${IDENTITY}".admins`);
        await expect(runAccess('up')).resolves.toBeUndefined();
        await expect(runAccess('down')).resolves.toBeUndefined();
      });

      it('noto`g`ri sxema nomi — konstruktorda xato', () => {
        expect(
          () => new MarketOperatorWarehouseAccess1716000000152('x"; DROP'),
        ).toThrow();
      });
    });

    describe('servis', () => {
      beforeEach(async () => {
        await createBaseTables(db);
        await runMigration('up');
        jest.clearAllMocks();
      });

      describe('DB himoyasi', () => {
        it('⭐ CHECK: manfiy qoldiq, reserved > on_hand — DB rad etadi; jurnal UPDATE/DELETE — trigger rad etadi', async () => {
          const w = await openWarehouse();
          const p = await addProduct('Olma');
          await stockIn(w.id, [{ product_id: p.id, qty: 2 }]);
          expect(
            await pgCode(
              db.query(
                `UPDATE "${CATALOG}".warehouse_stock SET on_hand = -1 WHERE product_id = $1`,
                [p.id],
              ),
            ),
          ).toBe('23514');
          expect(
            await pgCode(
              db.query(
                `UPDATE "${CATALOG}".warehouse_stock SET reserved = 3 WHERE product_id = $1`,
                [p.id],
              ),
            ),
          ).toBe('23514');
          expect(
            await pgCode(
              db.query(`UPDATE "${CATALOG}".stock_movements SET qty = 5`),
            ),
          ).toBe('55000');
          expect(
            await pgCode(db.query(`DELETE FROM "${CATALOG}".stock_movements`)),
          ).toBe('55000');
          expect(await movementCount(w.id)).toBe(1);
          // qty ishorasi tur bo'yicha.
          expect(
            await pgCode(
              db.query(
                `INSERT INTO "${CATALOG}".stock_movements
                   (warehouse_id, product_id, market_id, type, qty, on_hand_after, reserved_after, idempotency_key)
                 VALUES ($1, $2, $3, 'OUT', 1, 1, 0, 'bad-sign')`,
                [w.id, p.id, MARKET_A],
              ),
            ),
          ).toBe('23514');
        });

        it('bitta filial — bitta ombor (409); HQ filialida ombor ochilmaydi (400); pauza CHECK', async () => {
          await openWarehouse();
          expect(await errorOf(openWarehouse())).toMatchObject({
            statusCode: 409,
          });
          expect(await errorOf(openWarehouse(BRANCH_HQ))).toMatchObject({
            statusCode: 400,
          });
          expect(
            await pgCode(
              db.query(
                `UPDATE "${CATALOG}".warehouses SET status = 'PAUSED' WHERE branch_id = $1`,
                [BRANCH_SAM],
              ),
            ),
          ).toBe('23514');
        });

        it('⭐ XtcEyQjb: mas`ul xodim tanlanmasa — filialning birinchi faol menejeri; `null` bilan tahrir — qayta tanlanadi; menejer yo`q — null', async () => {
          directory.getFirstActiveBranchManagerId.mockResolvedValueOnce('31');
          const created = await warehouses.create(
            { branch_id: BRANCH_SAM },
            ADMIN,
          );
          expect(created.manager_user_id).toBe('31');
          expect(directory.getFirstActiveBranchManagerId).toHaveBeenCalledWith(
            BRANCH_SAM,
          );

          directory.getFirstActiveBranchManagerId.mockResolvedValueOnce(null);
          const far = await warehouses.create(
            { branch_id: BRANCH_FAR, manager_user_id: null },
            ADMIN,
          );
          expect(far.manager_user_id).toBeNull();

          // Aniq tanlov — avtomatik tanlov chaqirilmaydi.
          directory.getFirstActiveBranchManagerId.mockClear();
          const renamed = await warehouses.update(
            created.id,
            { name: 'Yangi nom' },
            ADMIN,
          );
          expect(renamed.manager_user_id).toBe('31');
          expect(
            directory.getFirstActiveBranchManagerId,
          ).not.toHaveBeenCalled();

          directory.getFirstActiveBranchManagerId.mockResolvedValueOnce('44');
          const reset = await warehouses.update(
            created.id,
            { manager_user_id: null },
            ADMIN,
          );
          expect(reset.manager_user_id).toBe('44');

          directory.getFirstActiveBranchManagerId.mockResolvedValueOnce(null);
          const cleared = await warehouses.update(
            created.id,
            { manager_user_id: null },
            ADMIN,
          );
          expect(cleared.manager_user_id).toBeNull();
        });

        it('mas`ul xodim filial menejeri bo`lmasa — 400', async () => {
          expect(
            await errorOf(
              warehouses.create(
                { branch_id: BRANCH_SAM, manager_user_id: '999' },
                ADMIN,
              ),
            ),
          ).toMatchObject({ statusCode: 400 });
        });
      });

      describe('kirim va inventarizatsiya', () => {
        it('⭐ kirim: product_id, Elchi kodi va shtrix kod bo`yicha; bir mahsulot qatorlari qo`shiladi', async () => {
          const w = await openWarehouse();
          const a = await addProduct('Quvvatlagich', MARKET_A, {
            barcode: '4780123450017',
          });
          const b = await addProduct('Shapka');
          const result = await stockIn(w.id, [
            { code: '4780123450017', qty: 3 },
            { code: b.sku_code, qty: 5 },
            { product_id: a.id, qty: 2 },
          ]);
          expect(result).toMatchObject({
            replayed: false,
            positions: 2,
            total_qty: 10,
          });
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 5,
            reserved: 0,
          });
          expect(await stockRow(w.id, b.id)).toEqual({
            on_hand: 5,
            reserved: 0,
          });
          expect(activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
              action: 'warehouse.stock_in',
              entity_id: w.id,
            }),
          );
        });

        it('⭐ takroriy kirim (AYNI Idempotency-Key) qoldiqni ikki marta oshirmaydi; boshqa tarkib — 409', async () => {
          const w = await openWarehouse();
          const p = await addProduct('Termos');
          const k = nextKey();
          await stockIn(w.id, [{ product_id: p.id, qty: 40 }], k);
          const again = await stockIn(w.id, [{ product_id: p.id, qty: 40 }], k);
          expect(again.replayed).toBe(true);
          expect(await stockRow(w.id, p.id)).toEqual({
            on_hand: 40,
            reserved: 0,
          });
          expect(await movementCount(w.id)).toBe(1);
          expect(
            await errorOf(stockIn(w.id, [{ product_id: p.id, qty: 41 }], k)),
          ).toMatchObject({
            statusCode: 409,
            code: 'WAREHOUSE_IDEMPOTENCY_CONFLICT',
          });
          // Parallel takror ham bitta yozuv.
          const k2 = nextKey();
          await Promise.all(
            Array.from({ length: 5 }, () =>
              stockIn(w.id, [{ product_id: p.id, qty: 1 }], k2),
            ),
          );
          expect(await stockRow(w.id, p.id)).toEqual({
            on_hand: 41,
            reserved: 0,
          });
        });

        it('topilmagan kod yoki begona market — 400, hech narsa yozilmaydi', async () => {
          const w = await openWarehouse();
          const p = await addProduct('Choynak');
          const foreign = await addProduct('Soat', MARKET_B);
          const error = await errorOf(
            stockIn(w.id, [
              { product_id: p.id, qty: 1 },
              { code: 'ELC-P-999999', qty: 1 },
            ]),
          );
          expect(error).toMatchObject({ statusCode: 400 });
          expect(String(error.message)).toContain('ELC-P-999999');
          expect(
            await errorOf(
              stock.stockIn({
                warehouse_id: w.id,
                market_id: MARKET_A,
                lines: [{ product_id: foreign.id, qty: 1 }],
                idempotency_key: nextKey(),
                actor: ADMIN,
              }),
            ),
          ).toMatchObject({ statusCode: 400 });
          expect(await movementCount(w.id)).toBe(0);
          expect(await stockRow(w.id, p.id)).toBeNull();
        });

        it('bir xil EAN ikki marketda: market tanlanmasa — 400, tanlansa — o`sha market', async () => {
          const w = await openWarehouse();
          await addProduct('Pepsi A', MARKET_A, { barcode: '4780000000007' });
          const b = await addProduct('Pepsi B', MARKET_B, {
            barcode: '4780000000007',
          });
          expect(
            await errorOf(stockIn(w.id, [{ code: '4780000000007', qty: 1 }])),
          ).toMatchObject({ statusCode: 400 });
          await stock.stockIn({
            warehouse_id: w.id,
            market_id: MARKET_B,
            lines: [{ code: '4780000000007', qty: 2 }],
            idempotency_key: nextKey(),
            actor: ADMIN,
          });
          expect(await stockRow(w.id, b.id)).toEqual({
            on_hand: 2,
            reserved: 0,
          });
        });

        it('⭐ XtcEyQjb: to`xtatilgan omborga kirim — 409 WAREHOUSE_PAUSED, hech narsa yozilmaydi; inventarizatsiya — ruxsat; takroriy kalit — avvalgi natija', async () => {
          const w = await openWarehouse();
          const a = await addProduct('Shapka');
          const firstKey = nextKey();
          await stockIn(w.id, [{ product_id: a.id, qty: 5 }], firstKey);
          await warehouses.setStatus(w.id, 'PAUSED', ADMIN);
          const before = await movementCount(w.id);

          expect(
            await errorOf(stockIn(w.id, [{ product_id: a.id, qty: 3 }])),
          ).toMatchObject({ statusCode: 409, code: 'WAREHOUSE_PAUSED' });
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 5,
            reserved: 0,
          });
          expect(await movementCount(w.id)).toBe(before);

          // Pauzadan oldin yozilgan AYNI so'rov — qayta yozilmaydi, natija qaytadi.
          const replay = await stockIn(
            w.id,
            [{ product_id: a.id, qty: 5 }],
            firstKey,
          );
          expect(replay).toMatchObject({ replayed: true });
          expect(await movementCount(w.id)).toBe(before);

          // Inventarizatsiya to'xtatilgan omborda ham ishlaydi.
          const counted = await stock.inventory({
            warehouse_id: w.id,
            lines: [{ product_id: a.id, counted: 4 }],
            reason: 'Sanash',
            idempotency_key: nextKey(),
            actor: ADMIN,
          });
          expect(counted).toMatchObject({ changed: 1 });
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 4,
            reserved: 0,
          });

          await warehouses.setStatus(w.id, 'ACTIVE', ADMIN);
          await stockIn(w.id, [{ product_id: a.id, qty: 3 }]);
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 7,
            reserved: 0,
          });
        });

        it('Idempotency-Key majburiy', async () => {
          const w = await openWarehouse();
          const p = await addProduct('Kalit');
          expect(
            await errorOf(
              stock.stockIn({
                warehouse_id: w.id,
                lines: [{ product_id: p.id, qty: 1 }],
                actor: ADMIN,
              }),
            ),
          ).toMatchObject({ statusCode: 400 });
        });

        it('⭐ inventarizatsiya: sabab majburiy, farq ADJUST bo`lib yoziladi, band qilingandan kam — 409, takror — no-op', async () => {
          const w = await openWarehouse();
          const p = await addProduct('Sumka');
          const q = await addProduct('Kurtka');
          await stockIn(w.id, [
            { product_id: p.id, qty: 8 },
            { product_id: q.id, qty: 4 },
          ]);
          await stock.reserve({
            order_id: '9001',
            warehouse_id: w.id,
            items: [{ product_id: q.id, quantity: 3 }],
          });

          expect(
            await errorOf(
              stock.inventory({
                warehouse_id: w.id,
                lines: [{ product_id: p.id, counted: 6 }],
                idempotency_key: nextKey(),
                actor: ADMIN,
              }),
            ),
          ).toMatchObject({ statusCode: 400 });
          expect(
            await errorOf(
              stock.inventory({
                warehouse_id: w.id,
                lines: [{ product_id: q.id, counted: 2 }],
                reason: 'Sanash',
                idempotency_key: nextKey(),
                actor: ADMIN,
              }),
            ),
          ).toMatchObject({ statusCode: 409 });

          const k = nextKey();
          const result = await stock.inventory({
            warehouse_id: w.id,
            lines: [
              { product_id: p.id, counted: 6 },
              { product_id: q.id, counted: 4 },
            ],
            reason: 'Oylik inventarizatsiya',
            idempotency_key: k,
            actor: ADMIN,
          });
          expect(result).toMatchObject({ changed: 1, unchanged: 1 });
          expect(
            result.lines.find((line) => line.product_id === p.id),
          ).toMatchObject({
            before: 8,
            after: 6,
            delta: -2,
          });
          // Orada qoldiq o'zgarsa ham, AYNI kalit qayta qo'llanmaydi.
          await stockIn(w.id, [{ product_id: p.id, qty: 1 }]);
          const replay = await stock.inventory({
            warehouse_id: w.id,
            lines: [
              { product_id: p.id, counted: 6 },
              { product_id: q.id, counted: 4 },
            ],
            reason: 'Oylik inventarizatsiya',
            idempotency_key: k,
            actor: ADMIN,
          });
          expect(replay.replayed).toBe(true);
          expect(await stockRow(w.id, p.id)).toEqual({
            on_hand: 7,
            reserved: 0,
          });
          const [movement]: Array<{ type: string; qty: number; note: string }> =
            await db.query(
              `SELECT type, qty, note FROM "${CATALOG}".stock_movements WHERE ref_type = 'inventory'`,
            );
          expect(movement).toEqual({
            type: 'ADJUST',
            qty: -2,
            note: 'Oylik inventarizatsiya',
          });
        });

        it('chegara: mahsulot bo`yicha o`rnatiladi va null — ombor sukutiga qaytadi', async () => {
          const w = await openWarehouse();
          const p = await addProduct('Quloqchin');
          await stockIn(w.id, [{ product_id: p.id, qty: 9 }]);
          await expect(
            stock.setThreshold({
              warehouse_id: w.id,
              product_id: p.id,
              low_stock_threshold: 10,
              actor: ADMIN,
            }),
          ).resolves.toMatchObject({ effective_threshold: 10 });
          const list = await warehouses.listStock(w.id, { level: 'low' });
          expect(list.data.map((row) => row.product.id)).toEqual([p.id]);
          await expect(
            stock.setThreshold({
              warehouse_id: w.id,
              product_id: p.id,
              low_stock_threshold: null,
              actor: ADMIN,
            }),
          ).resolves.toMatchObject({ effective_threshold: 5 });
        });
      });

      describe('buyurtma RPC`lari', () => {
        const setup = async (onHand = 10) => {
          const w = await openWarehouse();
          const a = await addProduct('Smartfon');
          const b = await addProduct('G`ilof');
          await stockIn(w.id, [
            { product_id: a.id, qty: onHand },
            { product_id: b.id, qty: onHand },
          ]);
          return { w, a, b };
        };

        it('⭐ reserve → takror → out → takror → return → takror: har biri qoldiqni BIR marta o`zgartiradi', async () => {
          const { w, a, b } = await setup(10);
          const items = [
            { product_id: a.id, quantity: 2 },
            { product_id: b.id, quantity: 1 },
          ];
          const first = await stock.reserve({
            order_id: '100',
            warehouse_id: w.id,
            items,
            actor: ADMIN,
          });
          expect(first).toMatchObject({ already: false, status: 'RESERVED' });
          const second = await stock.reserve({
            order_id: '100',
            warehouse_id: w.id,
            items,
            actor: ADMIN,
          });
          expect(second).toMatchObject({ already: true });
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 10,
            reserved: 2,
          });

          await expect(
            stock.out({ order_id: '100', actor: COURIER }),
          ).resolves.toMatchObject({ changed: true, status: 'OUT' });
          await expect(
            stock.out({ order_id: '100', actor: COURIER }),
          ).resolves.toMatchObject({ changed: false, status: 'OUT' });
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 8,
            reserved: 0,
          });
          expect(await stockRow(w.id, b.id)).toEqual({
            on_hand: 9,
            reserved: 0,
          });

          // OUT dan keyin release — 409 (return ishlatiladi).
          expect(
            await errorOf(stock.release({ order_id: '100' })),
          ).toMatchObject({
            statusCode: 409,
            code: 'WAREHOUSE_ORDER_ALREADY_OUT',
          });

          const back = await stock.return({ order_id: '100', actor: COURIER });
          expect(back.returned).toHaveLength(2);
          const again = await stock.return({ order_id: '100', actor: COURIER });
          expect(again).toMatchObject({ changed: false, status: 'RETURNED' });
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 10,
            reserved: 0,
          });
          expect(await stockRow(w.id, b.id)).toEqual({
            on_hand: 10,
            reserved: 0,
          });

          const types: Array<{ type: string; n: number }> = await db.query(
            `SELECT type, count(*)::int AS n FROM "${CATALOG}".stock_movements
              WHERE ref_type = 'order' AND ref_id = '100' GROUP BY type ORDER BY type`,
          );
          expect(types).toEqual([
            { type: 'OUT', n: 2 },
            { type: 'RESERVE', n: 2 },
            { type: 'RETURN', n: 2 },
          ]);
        });

        it('⭐ reserve → release → takror release: band bir marta bo`shaydi; bo`shatilgan buyurtma kuryerga berilmaydi', async () => {
          const { w, a } = await setup(5);
          await stock.reserve({
            order_id: '200',
            warehouse_id: w.id,
            items: [{ product_id: a.id, quantity: 3 }],
          });
          await expect(
            stock.release({ order_id: '200' }),
          ).resolves.toMatchObject({ changed: true, status: 'RELEASED' });
          await expect(
            stock.release({ order_id: '200' }),
          ).resolves.toMatchObject({ changed: false, status: 'RELEASED' });
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 5,
            reserved: 0,
          });
          expect(await errorOf(stock.out({ order_id: '200' }))).toMatchObject({
            statusCode: 409,
            code: 'WAREHOUSE_ORDER_RELEASED',
          });
          // Bandi yo'q (HQ) buyurtma — xato emas.
          await expect(
            stock.release({ order_id: '201' }),
          ).resolves.toMatchObject({ status: 'NONE', changed: false });
          await expect(stock.out({ order_id: '201' })).resolves.toMatchObject({
            status: 'NONE',
          });
          await expect(
            stock.return({ order_id: '201' }),
          ).resolves.toMatchObject({ status: 'NONE' });
          // Bo'shatilgandan keyin qayta band qilish mumkin (manba qayta tanlandi).
          await expect(
            stock.reserve({
              order_id: '200',
              warehouse_id: w.id,
              items: [{ product_id: a.id, quantity: 1 }],
            }),
          ).resolves.toMatchObject({ already: false });
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 5,
            reserved: 1,
          });
        });

        it('kuryerga berilmagan buyurtma return — band bo`shaydi (o`sha omborda qoladi)', async () => {
          const { w, a } = await setup(5);
          await stock.reserve({
            order_id: '250',
            warehouse_id: w.id,
            items: [{ product_id: a.id, quantity: 2 }],
          });
          const result = await stock.return({ order_id: '250' });
          expect(result.released).toHaveLength(1);
          expect(result.returned).toHaveLength(0);
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 5,
            reserved: 0,
          });
        });

        it('⭐ qisman qaytish (qisman sotuv): faqat qaytgan dona, takror — skipped; ortiqcha — 400', async () => {
          const { w, a, b } = await setup(10);
          await stock.reserve({
            order_id: '300',
            warehouse_id: w.id,
            items: [
              { product_id: a.id, quantity: 3 },
              { product_id: b.id, quantity: 1 },
            ],
          });
          await stock.out({ order_id: '300' });
          expect(
            await errorOf(
              stock.return({
                order_id: '300',
                items: [{ product_id: a.id, quantity: 4 }],
              }),
            ),
          ).toMatchObject({ statusCode: 400 });
          const partial = await stock.return({
            order_id: '300',
            items: [{ product_id: a.id, quantity: 1 }],
          });
          expect(partial.returned).toEqual([
            expect.objectContaining({ product_id: a.id, quantity: 1 }),
          ]);
          const dup = await stock.return({
            order_id: '300',
            items: [{ product_id: a.id, quantity: 1 }],
          });
          expect(dup.returned).toEqual([]);
          expect(dup.skipped).toEqual([{ product_id: a.id, quantity: 1 }]);
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 8,
            reserved: 0,
          });
          // Ikkinchi qisman qaytish — alohida kalit bilan.
          await stock.return({
            order_id: '300',
            items: [{ product_id: a.id, quantity: 1 }],
            idempotency_key: 'second-return-300',
          });
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 9,
            reserved: 0,
          });
          const state = await stock.orderState({ order_id: '300' });
          expect(state.status).toBe('OUT');
          expect(
            state.reservations.find((r) => r.product_id === a.id),
          ).toMatchObject({ qty: 3, returned_qty: 2 });
        });

        it('⭐ chala qoldiq — 409, HECH NARSA band qilinmaydi (bo`linmaydi)', async () => {
          const { w, a, b } = await setup(2);
          const error = await errorOf(
            stock.reserve({
              order_id: '400',
              warehouse_id: w.id,
              items: [
                { product_id: a.id, quantity: 1 },
                { product_id: b.id, quantity: 3 },
              ],
            }),
          );
          expect(error).toMatchObject({
            statusCode: 409,
            code: 'WAREHOUSE_STOCK_INSUFFICIENT',
          });
          expect(error.shortages).toEqual([
            expect.objectContaining({
              product_id: b.id,
              required: 3,
              available: 2,
            }),
          ]);
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 2,
            reserved: 0,
          });
          expect((await stock.orderState({ order_id: '400' })).status).toBe(
            'NONE',
          );
        });

        it('boshqa tarkib bilan qayta reserve — 409; to`xtatilgan ombor — 409', async () => {
          const { w, a } = await setup(5);
          await stock.reserve({
            order_id: '500',
            warehouse_id: w.id,
            items: [{ product_id: a.id, quantity: 1 }],
          });
          expect(
            await errorOf(
              stock.reserve({
                order_id: '500',
                warehouse_id: w.id,
                items: [{ product_id: a.id, quantity: 2 }],
              }),
            ),
          ).toMatchObject({
            statusCode: 409,
            code: 'WAREHOUSE_ORDER_ALREADY_RESERVED',
          });
          await warehouses.setStatus(w.id, 'PAUSED', ADMIN);
          expect(
            await errorOf(
              stock.reserve({
                order_id: '501',
                warehouse_id: w.id,
                items: [{ product_id: a.id, quantity: 1 }],
              }),
            ),
          ).toMatchObject({ statusCode: 409, code: 'WAREHOUSE_PAUSED' });
          // Mavjud band to'xtatilgan omborda ham ishlayveradi.
          await expect(stock.out({ order_id: '500' })).resolves.toMatchObject({
            changed: true,
          });
        });

        it('⭐ PARALLEL: 20 ta buyurtma 7 donaga — aynan 7 tasi band, manfiy/ortiqcha band yo`q', async () => {
          const { w, a } = await setup(7);
          const results = await Promise.allSettled(
            Array.from({ length: 20 }, (_, i) =>
              stock.reserve({
                order_id: String(1000 + i),
                warehouse_id: w.id,
                items: [{ product_id: a.id, quantity: 1 }],
              }),
            ),
          );
          const ok = results.filter((r) => r.status === 'fulfilled');
          const rejected = results.filter((r) => r.status === 'rejected');
          expect(ok).toHaveLength(7);
          expect(rejected).toHaveLength(13);
          for (const r of rejected) {
            expect((r.reason as RpcException).getError()).toMatchObject({
              code: 'WAREHOUSE_STOCK_INSUFFICIENT',
            });
          }
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 7,
            reserved: 7,
          });
        });

        it('⭐ PARALLEL: bitta buyurtmaga 10 ta takroriy reserve/out — bitta band, bitta chiqim', async () => {
          const { w, a } = await setup(10);
          const items = [{ product_id: a.id, quantity: 2 }];
          await Promise.all(
            Array.from({ length: 10 }, () =>
              stock.reserve({ order_id: '600', warehouse_id: w.id, items }),
            ),
          );
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 10,
            reserved: 2,
          });
          await Promise.all(
            Array.from({ length: 10 }, () => stock.out({ order_id: '600' })),
          );
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 8,
            reserved: 0,
          });
          await Promise.all(
            Array.from({ length: 10 }, () => stock.return({ order_id: '600' })),
          );
          expect(await stockRow(w.id, a.id)).toEqual({
            on_hand: 10,
            reserved: 0,
          });
        });

        it('PARALLEL: pauza va band — pauzadan keyin band tushmaydi', async () => {
          const { w, a } = await setup(50);
          const reserves = Array.from({ length: 10 }, (_, i) =>
            stock.reserve({
              order_id: String(2000 + i),
              warehouse_id: w.id,
              items: [{ product_id: a.id, quantity: 1 }],
            }),
          );
          const pause = warehouses.setStatus(w.id, 'PAUSED', ADMIN);
          const results = await Promise.allSettled([...reserves, pause]);
          const succeeded = results
            .slice(0, 10)
            .filter((r) => r.status === 'fulfilled').length;
          const row = await stockRow(w.id, a.id);
          expect(row?.reserved).toBe(succeeded);
          await expect(
            stock.reserve({
              order_id: '2999',
              warehouse_id: w.id,
              items: [{ product_id: a.id, quantity: 1 }],
            }),
          ).rejects.toBeInstanceOf(RpcException);
        });
      });

      describe('manba tanlovi (resolve_source)', () => {
        it('⭐ hamma mahsulot yetarli — ombor; chala — HQ (shortages); to`xtatilgan — HQ; ombori yo`q hudud — HQ', async () => {
          const w = await openWarehouse();
          const a = await addProduct('Quloqchin');
          const b = await addProduct('Shapka');
          await stockIn(w.id, [
            { product_id: a.id, qty: 30 },
            { product_id: b.id, qty: 1 },
          ]);
          const ok = await warehouses.resolveSource({
            district_id: '700',
            items: [
              { product_id: a.id, quantity: 2 },
              { product_id: b.id, quantity: 1 },
            ],
          });
          expect(ok).toMatchObject({
            source: 'WAREHOUSE',
            reason: 'OK',
            region_id: REGION_SAM,
          });
          expect(ok.warehouse).toMatchObject({
            id: w.id,
            branch_id: BRANCH_SAM,
          });

          const short = await warehouses.resolveSource({
            region_id: REGION_SAM,
            items: [{ product_id: b.id, quantity: 2 }],
          });
          expect(short).toMatchObject({
            source: 'HQ',
            reason: 'INSUFFICIENT_STOCK',
          });
          expect(short.shortages).toEqual([
            expect.objectContaining({
              product_id: b.id,
              required: 2,
              available: 1,
            }),
          ]);

          expect(
            await warehouses.resolveSource({
              region_id: REGION_FAR,
              items: [{ product_id: a.id, quantity: 1 }],
            }),
          ).toMatchObject({ source: 'HQ', reason: 'NO_WAREHOUSE' });
          expect(
            await warehouses.resolveSource({
              district_id: '999',
              items: [{ product_id: a.id, quantity: 1 }],
            }),
          ).toMatchObject({ source: 'HQ', reason: 'NO_REGION' });

          await warehouses.setStatus(w.id, 'PAUSED', ADMIN);
          expect(
            await warehouses.resolveSource({
              region_id: REGION_SAM,
              items: [{ product_id: a.id, quantity: 1 }],
            }),
          ).toMatchObject({
            source: 'HQ',
            reason: 'WAREHOUSE_PAUSED',
            warehouse: { id: w.id },
          });
        });

        it('market yaratuvchi: kalit o`chiq — HQ (MARKET_NOT_ALLOWED), yoqiq — ombor; begona mahsulot — HQ', async () => {
          const w = await openWarehouse();
          const a = await addProduct('Choynak', MARKET_A);
          const foreign = await addProduct('Soat', MARKET_B);
          await stockIn(w.id, [{ product_id: a.id, qty: 5 }]);
          const itemsA = [{ product_id: a.id, quantity: 1 }];
          expect(
            await warehouses.resolveSource({
              region_id: REGION_SAM,
              items: itemsA,
              market_id: MARKET_B,
              requester: { id: MARKET_B, roles: ['market'] },
            }),
          ).toMatchObject({ source: 'HQ', reason: 'MARKET_NOT_ALLOWED' });
          expect(
            await warehouses.resolveSource({
              region_id: REGION_SAM,
              items: itemsA,
              market_id: MARKET_A,
              requester: { id: MARKET_A, roles: ['market'] },
            }),
          ).toMatchObject({ source: 'WAREHOUSE' });
          expect(
            await warehouses.resolveSource({
              region_id: REGION_SAM,
              items: [{ product_id: foreign.id, quantity: 1 }],
              market_id: MARKET_A,
            }),
          ).toMatchObject({ source: 'HQ', reason: 'PRODUCT_INVALID' });
          // Registrator — kalit tekshirilmaydi.
          expect(
            await warehouses.resolveSource({
              region_id: REGION_SAM,
              items: itemsA,
              market_id: MARKET_A,
              requester: { id: '5', roles: ['registrator'] },
            }),
          ).toMatchObject({ source: 'WAREHOUSE' });
        });

        it('availability: hudud omboridagi mavjud dona (band ayirilgan)', async () => {
          const w = await openWarehouse();
          const a = await addProduct('Termos');
          await stockIn(w.id, [{ product_id: a.id, qty: 4 }]);
          await stock.reserve({
            order_id: '800',
            warehouse_id: w.id,
            items: [{ product_id: a.id, quantity: 1 }],
          });
          const result = await warehouses.availability({
            district_id: '700',
            market_id: MARKET_A,
          });
          expect(result.warehouse).toMatchObject({
            id: w.id,
            status: 'ACTIVE',
          });
          expect(result.items).toEqual([
            { product_id: a.id, on_hand: 4, reserved: 1, available: 3 },
          ]);
        });
      });

      describe('o`qish', () => {
        it('⭐ ro`yxat va tafsilot: jami/band/kam qolgan/tugagan, faol buyurtmalar soni, oxirgi harakat; filial doirasi', async () => {
          const w = await openWarehouse();
          await openWarehouse(BRANCH_FAR);
          const a = await addProduct('Quloqchin', MARKET_A, {
            weight_kg: 0.2,
            length_cm: 10,
            width_cm: 10,
            height_cm: 10,
          });
          const b = await addProduct('Kir yuvish mashinasi', MARKET_B, {
            weight_kg: 30,
            length_cm: 60,
            width_cm: 60,
            height_cm: 85,
          });
          const c = await addProduct('Kabel');
          await stockIn(w.id, [
            { product_id: a.id, qty: 9 },
            { product_id: b.id, qty: 4 },
            { product_id: c.id, qty: 1 },
          ]);
          await stock.reserve({
            order_id: '900',
            warehouse_id: w.id,
            items: [{ product_id: c.id, quantity: 1 }],
          });
          await stock.reserve({
            order_id: '901',
            warehouse_id: w.id,
            items: [{ product_id: a.id, quantity: 1 }],
          });

          const list = await warehouses.findAll({});
          expect(list.summary).toMatchObject({
            warehouses: 2,
            active: 2,
            paused: 0,
            on_hand: 14,
            reserved: 2,
            reserved_orders: 2,
          });
          const row = list.data.find((item) => item.id === w.id)!;
          expect(row.summary).toMatchObject({
            positions: 3,
            markets: 2,
            on_hand: 14,
            reserved: 2,
            available: 12,
            out_count: 1,
            low_count: 1,
          });
          expect(row.last_movement).toMatchObject({
            type: 'RESERVE',
            ref_id: '901',
          });
          expect(row.region).toEqual({
            id: REGION_SAM,
            name: `Viloyat ${REGION_SAM}`,
          });
          expect(row.manager).toMatchObject({ id: '31', name: 'User 31' });

          const filtered = await warehouses.findAll({ region_id: REGION_FAR });
          expect(filtered.data).toHaveLength(1);
          expect(filtered.counts).toEqual({ all: 1, active: 1, paused: 0 });

          // Filial menejeri — faqat o'z filiali; begona ombor — 404.
          const scoped = await warehouses.findAll(
            {},
            { branch_id: BRANCH_SAM },
          );
          expect(scoped.data.map((item) => item.id)).toEqual([w.id]);
          expect(
            await errorOf(
              warehouses.findOne(list.data.find((x) => x.id !== w.id)!.id, {
                branch_id: BRANCH_SAM,
              }),
            ),
          ).toMatchObject({
            statusCode: 404,
          });

          const detail = await warehouses.findOne(w.id, {
            branch_id: BRANCH_SAM,
          });
          expect(detail.movements_count).toBe(5);
          expect(detail.effective_address).toBe('Samarqand filiali manzili');

          const stockList = await warehouses.listStock(w.id, {});
          expect(stockList.data.map((item) => item.product.name)).toEqual([
            'Kabel',
            'Kir yuvish mashinasi',
            'Quloqchin',
          ]);
          const washer = stockList.data.find(
            (item) => item.product.id === b.id,
          )!;
          expect(washer).toMatchObject({
            on_hand: 4,
            reserved: 0,
            available: 4,
            threshold: 5,
            level: 'low',
          });
          expect(washer.product).toMatchObject({
            chargeable_weight_kg: 61.2,
            chargeable_basis: 'volumetric',
            code: { kind: 'sku', format: 'ELC' },
          });
          expect(
            stockList.data.find((item) => item.product.id === c.id),
          ).toMatchObject({ level: 'out', available: 0 });
          expect(stockList.facets.levels).toEqual({
            all: 3,
            ok: 1,
            low: 1,
            out: 1,
          });
          expect(stockList.facets.markets).toHaveLength(2);
          const onlyB = await warehouses.listStock(w.id, {
            market_id: MARKET_B,
          });
          expect(onlyB.data.map((item) => item.product.id)).toEqual([b.id]);
          const searched = await warehouses.listStock(w.id, {
            search: 'kabel',
          });
          expect(searched.total).toBe(1);

          const movements = await warehouses.listMovements(w.id, {
            type: 'RESERVE',
          });
          expect(movements.total).toBe(2);
          expect(movements.data[0]).toMatchObject({
            type: 'RESERVE',
            order_id: '901',
            qty: 1,
          });
          const page = await warehouses.listMovements(w.id, {
            limit: 2,
            page: 2,
          });
          expect(page.data).toHaveLength(2);
          expect(page.total).toBe(5);
          const admin = await warehouses.listMovements(w.id, { type: 'IN' });
          expect(admin.data[0].actor).toMatchObject({
            id: '2',
            name: 'User 2',
            role: 'admin',
          });

          const scan = await warehouses.lookup(w.id, { code: a.sku_code });
          expect(scan.data[0]).toMatchObject({
            stock: { on_hand: 9, reserved: 1, available: 8 },
          });
          const unknown = await warehouses.lookup(w.id, {
            code: '4780000000007',
          });
          expect(unknown).toMatchObject({ data: [], matched_by: null });
        });

        it('⭐ IDOR: market qoldig`i faqat o`z mahsulotlari; jami — faqat FAOL omborlar', async () => {
          const sam = await openWarehouse();
          const far = await openWarehouse(BRANCH_FAR);
          const a = await addProduct('Shapka', MARKET_A);
          const foreign = await addProduct('Begona', MARKET_B);
          await addProduct('Omborda yo`q', MARKET_A);
          await stockIn(sam.id, [
            { product_id: a.id, qty: 10 },
            { product_id: foreign.id, qty: 99 },
          ]);
          await stockIn(far.id, [{ product_id: a.id, qty: 6 }]);
          await warehouses.setStatus(far.id, 'PAUSED', ADMIN);

          const view = await warehouses.marketStock(MARKET_A, {});
          expect(view.data.map((item) => item.product.id)).toEqual([a.id]);
          expect(JSON.stringify(view)).not.toContain('Begona');
          expect(view.data[0]).toMatchObject({
            total_available: 10,
            total_on_hand: 16,
          });
          expect(view.summary).toMatchObject({
            products_total: 2,
            products_in_warehouses: 1,
            total_available: 10,
            warehouses_total: 2,
            warehouses_active: 1,
            warehouses_paused: 1,
          });
          expect(view.warehouses.map((w) => w.status).sort()).toEqual([
            'ACTIVE',
            'PAUSED',
          ]);
        });
      });
    });
  },
);
