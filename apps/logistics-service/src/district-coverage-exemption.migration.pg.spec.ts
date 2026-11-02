import { randomUUID } from 'node:crypto';
import { DataSource, In, IsNull } from 'typeorm';
import { DistrictCoverageExemptions1716000000203 } from '../../../migrations/1716000000203-DistrictCoverageExemptions';
import { DistrictCoverageExemption } from './entities/district-coverage-exemption.entity';
import {
  coverageExemptionDeleteQuery,
  coverageExemptionInsertQuery,
  coverageExemptionRetargetQuery,
} from './coverage/district-coverage-exemption';

/**
 * Tuman qamrovi imtiyozlari — migratsiya 203 haqiqiy Postgres'da
 * (LOGISTICS_COVERAGE_EXEMPTION_PG_TEST_URI — faqat lokal *_test baza;
 * bo'lmasa skip). Migratsiya `logistics_schema` ga qattiq bog'langan, shu
 * bois o'z vaqtinchalik `*_test` bazasini yaratadi va oxirida o'chiradi.
 *
 *  • up() jadval + UNIQUE (order_id, branch_id) + branch_id indeksini
 *    yaratadi; bitta tranzaksiyada ikki marta yurgizish xatosiz;
 *  • servis yozish so'rovi (`ON CONFLICT … DO UPDATE … WHERE … RETURNING`)
 *    qayta yozishda dublikat ham, xato ham bermaydi — faqat yangilar
 *    qaytadi; boshqa tuman — qator yangi tumanga qayta yo'naltiriladi,
 *    bekor qilingani tiklanadi; aynan bir xil qator tegilmaydi;
 *  • entity ustunlari jadvalga mos: qamrov to'sig'idagi so'rov (In / IsNull,
 *    `district_id` bilan) ishlaydi;
 *  • birlashtirish so'rovlari: A tumanli qatorlar faqat ko'chgan buyurtmalar
 *    uchun B ga o'tadi; bekor bo'lganda faqat berilgan juft + tuman + manba
 *    qatorlari o'chadi;
 *  • down() jadvalni o'chiradi (qayta yurgizish xatosiz).
 */
const uri = process.env.LOGISTICS_COVERAGE_EXEMPTION_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();

(localTestDatabase ? describe : describe.skip)(
  'migratsiya 203 — district_coverage_exemptions (haqiqiy Postgres)',
  () => {
    const dbName = `spec_cov_exempt_${randomUUID().replace(/-/g, '').slice(0, 12)}_test`;
    let admin: DataSource;
    let db: DataSource;
    const migration = new DistrictCoverageExemptions1716000000203();

    /** TypeORM kabi: bitta tranzaksiyada (`times` marta ketma-ket). */
    const run = async (direction: 'up' | 'down', times = 1) => {
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        for (let index = 0; index < times; index += 1) {
          await migration[direction](runner);
        }
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    };

    const tableExists = async (): Promise<boolean> => {
      const [row]: Array<{ oid: string | null }> = await db.query(
        `SELECT to_regclass('"logistics_schema"."district_coverage_exemptions"')::text AS "oid"`,
      );
      return row?.oid !== null && row?.oid !== undefined;
    };

    const indexes = async (): Promise<Record<string, string>> => {
      const rows: Array<{ indexname: string; indexdef: string }> =
        await db.query(
          `SELECT "indexname", "indexdef" FROM pg_indexes
            WHERE schemaname = 'logistics_schema'
              AND tablename = 'district_coverage_exemptions'`,
        );
      return Object.fromEntries(
        rows.map((row) => [row.indexname, row.indexdef]),
      );
    };

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      const url = new URL(uri as string);
      url.pathname = `/${dbName}`;
      db = new DataSource({
        type: 'postgres',
        url: url.toString(),
        schema: 'logistics_schema',
        entities: [DistrictCoverageExemption],
        synchronize: false,
      });
      await db.initialize();
      await db.query(`CREATE SCHEMA "logistics_schema"`);
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.destroy();
      }
    });

    it('up() — jadval va indekslar; bitta tranzaksiyada ikki marta xatosiz', async () => {
      await run('up', 2);
      // Alohida qayta yurgizish ham xatosiz.
      await run('up');

      expect(await tableExists()).toBe(true);
      const columns: Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }> = await db.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'logistics_schema'
            AND table_name = 'district_coverage_exemptions'
          ORDER BY ordinal_position`,
      );
      expect(
        columns.map((column) => [
          column.column_name,
          column.data_type,
          column.is_nullable,
        ]),
      ).toEqual([
        ['id', 'bigint', 'NO'],
        ['order_id', 'bigint', 'NO'],
        ['branch_id', 'bigint', 'NO'],
        ['district_id', 'bigint', 'YES'],
        ['source', 'character varying', 'NO'],
        ['created_at', 'timestamp with time zone', 'NO'],
        ['revoked_at', 'timestamp with time zone', 'YES'],
      ]);
      expect(
        columns.find((column) => column.column_name === 'created_at')
          ?.column_default,
      ).toBe('now()');

      const defs = await indexes();
      expect(defs.UQ_DISTRICT_COVERAGE_EXEMPTION_ORDER_BRANCH).toMatch(
        /CREATE UNIQUE INDEX .* \(order_id, branch_id\)/,
      );
      expect(defs.IDX_DISTRICT_COVERAGE_EXEMPTION_BRANCH).toMatch(
        /CREATE INDEX .* \(branch_id\)/,
      );
      // FK yo'q (boshqa sxemalar).
      const [fk]: Array<{ count: string }> = await db.query(
        `SELECT count(*)::text AS "count" FROM pg_constraint
          WHERE contype = 'f'
            AND conrelid = '"logistics_schema"."district_coverage_exemptions"'::regclass`,
      );
      expect(fk.count).toBe('0');
    });

    it('ON CONFLICT yozish — qayta yozishda dublikat ham, xato ham yo‘q', async () => {
      const first = coverageExemptionInsertQuery(
        [
          { order_id: '101', branch_id: '10', district_id: '5' },
          { order_id: '102', branch_id: '10', district_id: null },
        ],
        'district_update',
      );
      const created: Array<{
        order_id: string;
        branch_id: string;
        district_id: string | null;
      }> = await db.manager.query(first.sql, first.params);
      expect(created).toEqual([
        { order_id: '101', branch_id: '10', district_id: '5' },
        { order_id: '102', branch_id: '10', district_id: null },
      ]);

      // Takror + bitta yangi (boshqa filial) — faqat yangisi qaytadi.
      const again = coverageExemptionInsertQuery(
        [
          { order_id: '101', branch_id: '10', district_id: '5' },
          { order_id: '101', branch_id: '11', district_id: '5' },
        ],
        'set_serving_branch',
      );
      expect(await db.manager.query(again.sql, again.params)).toEqual([
        { order_id: '101', branch_id: '11', district_id: '5' },
      ]);

      const rows: Array<{
        order_id: string;
        branch_id: string;
        source: string;
      }> = await db.query(
        `SELECT order_id::text, branch_id::text, source
           FROM "logistics_schema"."district_coverage_exemptions"
          ORDER BY order_id, branch_id`,
      );
      expect(rows).toEqual([
        { order_id: '101', branch_id: '10', source: 'district_update' },
        { order_id: '101', branch_id: '11', source: 'set_serving_branch' },
        { order_id: '102', branch_id: '10', source: 'district_update' },
      ]);

      // UNIQUE — oddiy INSERT takrorni rad etadi.
      await expect(
        db.query(
          `INSERT INTO "logistics_schema"."district_coverage_exemptions"
             ("order_id", "branch_id", "source") VALUES (101, 10, 'x')`,
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('entity mos: qamrov to‘sig‘i so‘rovi (In / IsNull, revoked_at)', async () => {
      await db.query(
        `UPDATE "logistics_schema"."district_coverage_exemptions"
            SET "revoked_at" = now()
          WHERE "order_id" = 102 AND "branch_id" = 10`,
      );
      const found = await db.getRepository(DistrictCoverageExemption).find({
        select: { order_id: true, district_id: true },
        where: {
          order_id: In(['101', '102', '103']),
          branch_id: '10',
          revoked_at: IsNull(),
        },
      });
      expect(
        found.map((row) => [String(row.order_id), row.district_id]),
      ).toEqual([['101', '5']]);
    });

    it('⭐ ON CONFLICT DO UPDATE — boshqa tuman: qayta yo‘naltiriladi; bekor qilingan: tiklanadi; aynan bir xil: tegilmaydi', async () => {
      // Holat: 101@10 (tuman 5), 101@11 (tuman 5), 102@10 (tumansiz, bekor
      // qilingan — oldingi test).
      const retarget = coverageExemptionInsertQuery(
        [
          { order_id: '101', branch_id: '10', district_id: '6' },
          { order_id: '102', branch_id: '10', district_id: null },
          { order_id: '101', branch_id: '11', district_id: '5' },
        ],
        'district_merge',
      );
      const changed: Array<{ branch_id: string; district_id: string | null }> =
        await db.manager.query(retarget.sql, retarget.params);
      expect(
        changed
          .map((row) => `${row.branch_id}#${row.district_id ?? '-'}`)
          .sort(),
      ).toEqual(['10#-', '10#6']);

      const rows: Array<{
        order_id: string;
        branch_id: string;
        district_id: string | null;
        source: string;
        revoked: boolean;
      }> = await db.query(
        `SELECT order_id::text, branch_id::text, district_id::text, source,
                revoked_at IS NOT NULL AS "revoked"
           FROM "logistics_schema"."district_coverage_exemptions"
          ORDER BY order_id, branch_id`,
      );
      expect(rows).toEqual([
        {
          order_id: '101',
          branch_id: '10',
          district_id: '6',
          source: 'district_merge',
          revoked: false,
        },
        {
          order_id: '101',
          branch_id: '11',
          district_id: '5',
          source: 'set_serving_branch',
          revoked: false,
        },
        {
          order_id: '102',
          branch_id: '10',
          district_id: null,
          source: 'district_merge',
          revoked: false,
        },
      ]);

      // Takror (qayta snapshot) — hech narsa o'zgarmaydi va qaytmaydi.
      expect(await db.manager.query(retarget.sql, retarget.params)).toEqual([]);
    });

    it('⭐ birlashtirish: A tumanli qatorlar faqat ko‘chgan buyurtmalar uchun B ga; bekor bo‘lganda faqat juft + tuman + manba o‘chadi', async () => {
      await db.query(
        `DELETE FROM "logistics_schema"."district_coverage_exemptions"`,
      );
      const seed = coverageExemptionInsertQuery(
        [
          { order_id: '201', branch_id: '10', district_id: '5' },
          { order_id: '202', branch_id: '10', district_id: '5' },
          { order_id: '203', branch_id: '10', district_id: '7' },
        ],
        'set_serving_branch',
      );
      await db.manager.query(seed.sql, seed.params);

      // 201 va 203 ko'chdi (203 A da emas — tegilmaydi), 202 ko'chmadi.
      const moved = coverageExemptionRetargetQuery('5', '6', ['201', '203']);
      expect(await db.manager.query(moved.sql, moved.params)).toEqual([
        [{ order_id: '201' }],
        1,
      ]);

      // Bekor bo'lgan birlashtirish (B = 6) yozgan qatorlar.
      const merge = coverageExemptionInsertQuery(
        [
          { order_id: '301', branch_id: '10', district_id: '6' },
          { order_id: '302', branch_id: '10', district_id: '6' },
        ],
        'district_merge',
      );
      await db.manager.query(merge.sql, merge.params);
      const drop = coverageExemptionDeleteQuery(
        [
          { order_id: '301', branch_id: '10' },
          // Boshqa manba (201@10, tuman 6) — tegilmaydi.
          { order_id: '201', branch_id: '10' },
          // Yo'q juft — xatosiz.
          { order_id: '399', branch_id: '10' },
        ],
        '6',
        'district_merge',
      );
      expect(await db.manager.query(drop.sql, drop.params)).toEqual([
        [{ order_id: '301' }],
        1,
      ]);

      const rows: Array<{ pair: string }> = await db.query(
        `SELECT order_id::text || '@' || branch_id::text || '#' ||
                district_id::text AS "pair"
           FROM "logistics_schema"."district_coverage_exemptions"
          ORDER BY order_id, branch_id`,
      );
      expect(rows.map((row) => row.pair)).toEqual([
        '201@10#6',
        '202@10#5',
        '203@10#7',
        '302@10#6',
      ]);
    });

    it('down() — jadval o‘chadi; qayta yurgizish xatosiz', async () => {
      await run('down', 2);
      expect(await tableExists()).toBe(false);
      expect(await indexes()).toEqual({});
    });
  },
);
