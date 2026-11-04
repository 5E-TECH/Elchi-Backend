import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { HqBranchRegion1716000000204 } from '../../../migrations/1716000000204-HqBranchRegion';

/**
 * anKpzwxk 4-qarori — migratsiya 204 haqiqiy Postgres'da
 * (LOGISTICS_POST_LIST_PG_TEST_URI — faqat lokal *_test baza; bo'lmasa skip).
 * Migratsiya `branch_schema` / `logistics_schema` ga qattiq bog'langan, shu
 * bois o'z vaqtinchalik bazasini yaratadi va oxirida o'chiradi.
 *
 *  • viloyati bo'sh HQ — Toshkent shahri (SOATO 1726);
 *  • viloyati bor HQ, oddiy filiallar, o'chirilgan HQ — tegilmaydi;
 *  • qayta yurgizish hech narsani o'zgartirmaydi;
 *  • 1726 viloyati yo'q yoki jadvallar yo'q — xatosiz, hech narsa qilmaydi.
 */
const uri = process.env.LOGISTICS_POST_LIST_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();

(localTestDatabase ? describe : describe.skip)(
  'migratsiya 204 — HQ filialiga Toshkent shahri (haqiqiy Postgres)',
  () => {
    const dbName = `spec_hq_region_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    let admin: DataSource;
    let db: DataSource;
    const migration = new HqBranchRegion1716000000204();

    /** TypeORM kabi: bitta tranzaksiyada. */
    const runUp = async () => {
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await migration.up(runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    };

    const regionOf = async (branchId: string): Promise<string | null> => {
      const [row]: Array<{ region_id: string | null }> = await db.query(
        `SELECT "region_id"::text AS "region_id" FROM "branch_schema"."branches" WHERE "id" = $1`,
        [branchId],
      );
      return row?.region_id ?? null;
    };

    const insertBranch = async (row: {
      type: 'HQ' | 'REGIONAL' | 'PICKUP' | 'HYBRID';
      region_id: string | null;
      is_deleted?: boolean;
    }): Promise<string> => {
      const [saved]: Array<{ id: string }> = await db.query(
        `INSERT INTO "branch_schema"."branches" ("name", "type", "region_id", "is_deleted")
         VALUES ($1, $2, $3, $4) RETURNING "id"::text AS "id"`,
        [`B-${randomUUID()}`, row.type, row.region_id, row.is_deleted ?? false],
      );
      return saved.id;
    };

    const insertRegion = async (
      name: string,
      sato: string | null,
      isDeleted = false,
    ): Promise<string> => {
      const [saved]: Array<{ id: string }> = await db.query(
        `INSERT INTO "logistics_schema"."regions" ("name", "sato_code", "is_deleted")
         VALUES ($1, $2, $3) RETURNING "id"::text AS "id"`,
        [name, sato, isDeleted],
      );
      return saved.id;
    };

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      const url = new URL(uri as string);
      url.pathname = `/${dbName}`;
      db = new DataSource({ type: 'postgres', url: url.toString() });
      await db.initialize();
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.destroy();
      }
    });

    it('jadvallar yo`q — xatosiz, hech narsa qilmaydi', async () => {
      await expect(runUp()).resolves.toBeUndefined();
    });

    describe('jadvallar bor', () => {
      beforeAll(async () => {
        // Asosiy migratsiyalardagi shakl (faqat migratsiya o'qiydigan ustunlar).
        await db.query(`CREATE SCHEMA "logistics_schema"`);
        await db.query(`
          CREATE TABLE "logistics_schema"."regions" (
            "id" BIGSERIAL PRIMARY KEY,
            "is_deleted" boolean NOT NULL DEFAULT false,
            "name" varchar NOT NULL,
            "sato_code" varchar UNIQUE
          )
        `);
        await db.query(`CREATE SCHEMA "branch_schema"`);
        await db.query(
          `CREATE TYPE "branch_schema"."branches_type_enum" AS ENUM ('HQ', 'PICKUP', 'REGIONAL', 'HYBRID')`,
        );
        await db.query(`
          CREATE TABLE "branch_schema"."branches" (
            "id" BIGSERIAL PRIMARY KEY,
            "is_deleted" boolean NOT NULL DEFAULT false,
            "name" varchar NOT NULL,
            "type" "branch_schema"."branches_type_enum" NOT NULL DEFAULT 'PICKUP',
            "region_id" bigint
          )
        `);
      });

      beforeEach(async () => {
        await db.query(
          `TRUNCATE "branch_schema"."branches", "logistics_schema"."regions" RESTART IDENTITY`,
        );
      });

      it("1726 viloyati yo'q — HQ viloyatsiz qoladi", async () => {
        await insertRegion('Toshkent', '1727');
        const hq = await insertBranch({ type: 'HQ', region_id: null });
        await runUp();
        expect(await regionOf(hq)).toBeNull();
      });

      it("bo'sh HQ — Toshkent shahri; boshqalar tegilmaydi; qayta yurgizish xavfsiz", async () => {
        const toshkentViloyati = await insertRegion('Toshkent', '1727');
        // Nomi boshqa bo'lsa ham — SOATO bo'yicha.
        const toshkentShahri = await insertRegion('Toshkent sh.', '1726');
        const samarqand = await insertRegion('Samarqand', '1718');

        const hq = await insertBranch({ type: 'HQ', region_id: null });
        const deletedHq = await insertBranch({
          type: 'HQ',
          region_id: null,
          is_deleted: true,
        });
        const regionalNoRegion = await insertBranch({
          type: 'REGIONAL',
          region_id: null,
        });
        const regional = await insertBranch({
          type: 'REGIONAL',
          region_id: samarqand,
        });

        await runUp();
        expect(await regionOf(hq)).toBe(toshkentShahri);
        expect(await regionOf(deletedHq)).toBeNull();
        expect(await regionOf(regionalNoRegion)).toBeNull();
        expect(await regionOf(regional)).toBe(samarqand);
        expect(toshkentViloyati).not.toBe(toshkentShahri);

        await runUp();
        expect(await regionOf(hq)).toBe(toshkentShahri);
        expect(await regionOf(regionalNoRegion)).toBeNull();
      });

      it("qo'lda qo'yilgan HQ viloyati ustidan yozilmaydi", async () => {
        await insertRegion('Toshkent shahri', '1726');
        const samarqand = await insertRegion('Samarqand', '1718');
        const hq = await insertBranch({ type: 'HQ', region_id: samarqand });
        await runUp();
        expect(await regionOf(hq)).toBe(samarqand);
      });

      it("o'chirilgan 1726 viloyati olinmaydi", async () => {
        await insertRegion('Toshkent shahri', '1726', true);
        const hq = await insertBranch({ type: 'HQ', region_id: null });
        await runUp();
        expect(await regionOf(hq)).toBeNull();
      });
    });
  },
);
