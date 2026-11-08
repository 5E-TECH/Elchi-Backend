import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import { DistrictCoverageExemptions1716000000203 } from '../../../migrations/1716000000203-DistrictCoverageExemptions';
import {
  HQ_COURIER_COVERAGE_GRANDFATHER_SOURCE,
  HQ_COURIER_COVERAGE_GRANDFATHER_UP_SQL,
  HqCourierCoverageGrandfather1716000000211,
} from '../../../migrations/1716000000211-HqCourierCoverageGrandfather';

/**
 * Migratsiya 211 — HQ kuryeri viloyat qoidasi (ega qarori 6) deploy
 * paytidagi «Eski filialda tugasin» backfill'i haqiqiy Postgres'da
 * (LOGISTICS_COVERAGE_EXEMPTION_PG_TEST_URI — faqat lokal *_test baza;
 * bo'lmasa skip). Migratsiya sxemalarga qattiq bog'langan, shu bois o'z
 * vaqtinchalik `*_test` bazasini yaratadi (order/branch/logistics jadvallari
 * — migratsiya o'qiydigan ustunlar, enum turlari bilan) va oxirida o'chiradi.
 *
 *  • kiradi: `on the road` / `waiting` / `waiting_customer`, HQ mas'ul (HQ
 *    qo'lida, HQ kuryerida, HQ ga ketayotgan SENT partiya), XIZMAT viloyati
 *    (tuman `assigned_region ?? region_id`, tumansiz — `orders.region_id`,
 *    noma'lum ham) HQ viloyatidan boshqa; `district_id` — hozirgi tuman;
 *  • kirmaydi: RECEIVED / NEW / bekor, boshqa filial, HQ viloyatida, MARKET
 *    qo'lida, o'chirilgan buyurtma, o'chirilgan HQ, filialga ketayotgan SENT
 *    partiya (partiya manzili ustun), PENDING partiya (manzil hisobga
 *    olinmaydi);
 *  • 203 bilan bitta tranzaksiyada ishlaydi; qayta yurgizish xatosiz va
 *    dublikatsiz, mavjud qator (boshqa manba) tegilmaydi;
 *  • HQ viloyati yo'q — barcha shunday HQ buyurtmalari;
 *  • jadval yo'q — jim o'tkazib yuboriladi;
 *  • down() faqat shu manbali qatorlarni o'chiradi (qayta yurgizish xatosiz);
 *  • deploy oynasidan keyin `HQ_COURIER_COVERAGE_GRANDFATHER_UP_SQL` ni
 *    psql kabi (migratsiyasiz) bir marta qayta yurgizish — oraliqda eski
 *    kod HQ kuryeriga bergan buyurtmani qo'shadi, mavjudlarga tegmaydi.
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

const TOSHKENT = 14;
const SAMARQAND = 8;

// Postgres'siz ham yuradi: deploy yo'riqnomasidagi «psql bilan qayta
// yurgizish» uchun UP SQL tayyor matn — shablon qoldig'i yo'q, manba yozma.
describe('migratsiya 211 — UP SQL psql uchun tayyor matn', () => {
  it('manba qiymati yozma (`hq_region_rule_deploy`), `${…}` shablon qoldig‘i yo‘q', () => {
    expect(HQ_COURIER_COVERAGE_GRANDFATHER_SOURCE).toBe(
      'hq_region_rule_deploy',
    );
    expect(HQ_COURIER_COVERAGE_GRANDFATHER_UP_SQL).toContain(
      `'${HQ_COURIER_COVERAGE_GRANDFATHER_SOURCE}'`,
    );
    expect(HQ_COURIER_COVERAGE_GRANDFATHER_UP_SQL).not.toContain('${');
  });
});

(localTestDatabase ? describe : describe.skip)(
  'migratsiya 211 — HQ kuryeri qamrovi grandfather (haqiqiy Postgres)',
  () => {
    const dbName = `spec_hq_gf_${randomUUID().replace(/-/g, '').slice(0, 12)}_test`;
    let admin: DataSource;
    let db: DataSource;
    const tableMigration = new DistrictCoverageExemptions1716000000203();
    const migration = new HqCourierCoverageGrandfather1716000000211();

    /** TypeORM kabi: hammasi BITTA tranzaksiyada, ketma-ket. */
    const inTransaction = async (
      ...steps: Array<(runner: QueryRunner) => Promise<unknown>>
    ) => {
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        for (const step of steps) {
          await step(runner);
        }
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    };
    const up = (runner: QueryRunner) => migration.up(runner);
    const down = (runner: QueryRunner) => migration.down(runner);

    /** Imtiyozlar: `order@branch#district:source`, tartiblangan. */
    const exemptions = async (): Promise<string[]> => {
      const rows: Array<{ pair: string }> = await db.query(
        `SELECT order_id::text || '@' || branch_id::text || '#' ||
                COALESCE(district_id::text, '-') || ':' || source AS "pair"
           FROM "logistics_schema"."district_coverage_exemptions"
          ORDER BY order_id, branch_id`,
      );
      return rows.map((row) => row.pair);
    };
    const gf = (orderId: number, districtId: number | null) =>
      `${orderId}@1#${districtId ?? '-'}:${HQ_COURIER_COVERAGE_GRANDFATHER_SOURCE}`;

    type OrderSeed = {
      id: number;
      status: string;
      holder_type?: string;
      holder_branch_id?: number | null;
      branch_id?: number | null;
      current_batch_id?: number | null;
      district_id?: number | null;
      region_id?: number | null;
      is_deleted?: boolean;
      deleted_at?: string | null;
    };
    const insertOrder = (seed: OrderSeed) =>
      db.query(
        `INSERT INTO "order_schema"."orders"
           ("id", "status", "holder_type", "holder_branch_id", "branch_id",
            "current_batch_id", "district_id", "region_id", "is_deleted",
            "deleted_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          seed.id,
          seed.status,
          seed.holder_type ?? 'HQ',
          seed.holder_branch_id ?? null,
          seed.branch_id === undefined ? 1 : seed.branch_id,
          seed.current_batch_id ?? null,
          seed.district_id === undefined ? 50 : seed.district_id,
          seed.region_id === undefined ? SAMARQAND : seed.region_id,
          seed.is_deleted ?? false,
          seed.deleted_at ?? null,
        ],
      );

    beforeAll(async () => {
      admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${dbName}"`);
      const url = new URL(uri as string);
      url.pathname = `/${dbName}`;
      db = new DataSource({
        type: 'postgres',
        url: url.toString(),
        synchronize: false,
      });
      await db.initialize();
      for (const schema of [
        'logistics_schema',
        'order_schema',
        'branch_schema',
      ]) {
        await db.query(`CREATE SCHEMA "${schema}"`);
      }
      // Migratsiya o'qiydigan ustunlar — haqiqiy turlari (enum'lar) bilan.
      await db.query(`
        CREATE TYPE "order_schema"."orders_status_enum" AS ENUM (
          'created', 'new', 'received', 'on the road', 'waiting',
          'waiting_customer', 'sold', 'cancelled', 'returned_to_market',
          'paid', 'partly_paid', 'cancelled (sent)', 'closed');
        CREATE TYPE "order_schema"."orders_holder_type_enum" AS ENUM (
          'HQ', 'BRANCH', 'COURIER', 'MARKET');
        CREATE TYPE "order_schema"."branch_transfer_batch_status_enum" AS ENUM (
          'PENDING', 'SENT', 'RECEIVED', 'CANCELLED');
        CREATE TYPE "branch_schema"."branches_type_enum" AS ENUM (
          'HQ', 'PICKUP', 'REGIONAL', 'HYBRID');
        CREATE TABLE "order_schema"."orders" (
          "id" bigint PRIMARY KEY,
          "status" "order_schema"."orders_status_enum" NOT NULL DEFAULT 'new',
          "holder_type" "order_schema"."orders_holder_type_enum" NOT NULL DEFAULT 'HQ',
          "holder_branch_id" bigint NULL,
          "branch_id" bigint NULL,
          "current_batch_id" bigint NULL,
          "district_id" bigint NULL,
          "region_id" bigint NULL,
          "is_deleted" boolean NOT NULL DEFAULT false,
          "deleted_at" timestamptz NULL
        );
        CREATE TABLE "order_schema"."branch_transfer_batches" (
          "id" bigint PRIMARY KEY,
          "destination_branch_id" bigint NOT NULL,
          "status" "order_schema"."branch_transfer_batch_status_enum" NOT NULL
        );
        CREATE TABLE "branch_schema"."branches" (
          "id" bigint PRIMARY KEY,
          "type" "branch_schema"."branches_type_enum" NOT NULL,
          "region_id" bigint NULL,
          "is_deleted" boolean NOT NULL DEFAULT false
        );
        CREATE TABLE "logistics_schema"."districts" (
          "id" bigint PRIMARY KEY,
          "region_id" bigint NOT NULL,
          "assigned_region" bigint NULL,
          "is_deleted" boolean NOT NULL DEFAULT false
        );
      `);
      // Filiallar: 1 — HQ (Toshkent), 10 — Samarqand filiali, 2 — o'chirilgan HQ.
      await db.query(`
        INSERT INTO "branch_schema"."branches" ("id", "type", "region_id", "is_deleted")
        VALUES (1, 'HQ', ${TOSHKENT}, false),
               (10, 'REGIONAL', ${SAMARQAND}, false),
               (2, 'HQ', ${TOSHKENT}, true);
        -- 50 — Samarqand; 51 — Toshkentdan Samarqandga biriktirilgan;
        -- 52 — Samarqanddan Toshkentga biriktirilgan; 53 — Toshkent.
        INSERT INTO "logistics_schema"."districts" ("id", "region_id", "assigned_region")
        VALUES (50, ${SAMARQAND}, NULL),
               (51, ${TOSHKENT}, ${SAMARQAND}),
               (52, ${SAMARQAND}, ${TOSHKENT}),
               (53, ${TOSHKENT}, NULL);
        -- 900 — 10 → HQ (SENT), 901 — HQ → 10 (SENT), 902 — 10 → HQ (PENDING).
        INSERT INTO "order_schema"."branch_transfer_batches" ("id", "destination_branch_id", "status")
        VALUES (900, 1, 'SENT'), (901, 10, 'SENT'), (902, 1, 'PENDING');
      `);
      const seeds: OrderSeed[] = [
        // ✔ HQ kuryeri qo'lida (yo'lda), Samarqand tumani.
        {
          id: 101,
          status: 'on the road',
          holder_type: 'COURIER',
          holder_branch_id: 1,
        },
        // ✔ Qaytarilgan (WAITING) — tuman Samarqandga biriktirilgan (XIZMAT viloyati).
        { id: 102, status: 'waiting', district_id: 51, region_id: TOSHKENT },
        // ✔ Tumansiz, HQ kuryerida, buyurtma viloyati — Samarqand.
        {
          id: 103,
          status: 'waiting_customer',
          holder_type: 'COURIER',
          holder_branch_id: 1,
          district_id: null,
        },
        // ✘ HQ omboridagi RECEIVED / NEW — yangi qoidaga bo'ysunadi.
        { id: 104, status: 'received' },
        { id: 105, status: 'new' },
        // ✘ Boshqa filial.
        {
          id: 106,
          status: 'waiting',
          holder_type: 'BRANCH',
          holder_branch_id: 10,
          branch_id: 10,
        },
        // ✘ HQ viloyatida: Toshkent tumani; Toshkentga biriktirilgan tuman.
        { id: 107, status: 'waiting', district_id: 53, region_id: TOSHKENT },
        { id: 108, status: 'waiting', district_id: 52 },
        // ✘ MARKET qo'lida; o'chirilgan (ikkala yo'l).
        { id: 109, status: 'waiting', holder_type: 'MARKET' },
        { id: 110, status: 'waiting', is_deleted: true },
        { id: 111, status: 'waiting', deleted_at: '2026-11-01T00:00:00Z' },
        // ✔ 10 → HQ partiyasi yo'lda (SENT) — partiya manzili (HQ) ustun.
        {
          id: 112,
          status: 'waiting',
          holder_type: 'BRANCH',
          holder_branch_id: 10,
          branch_id: 10,
          current_batch_id: 900,
        },
        // ✘ HQ → 10 partiyasi yo'lda (SENT) — mas'ul 10, HQ emas.
        { id: 113, status: 'on the road', current_batch_id: 901 },
        // ✘ PENDING partiya — manzil hisobga olinmaydi, mas'ul 10.
        {
          id: 114,
          status: 'waiting',
          holder_type: 'BRANCH',
          holder_branch_id: 10,
          branch_id: 10,
          current_batch_id: 902,
        },
        // ✘ O'chirilgan HQ (2).
        { id: 115, status: 'waiting', branch_id: 2 },
        // ✔ HQ qo'lida — holder_branch_id hisobga olinmaydi, branch_id (HQ).
        { id: 116, status: 'waiting', holder_branch_id: 10 },
        // ✔ Bekor / sotilgan — WAITING ga qaytarilishi mumkin (rollback).
        { id: 117, status: 'cancelled' },
        {
          id: 121,
          status: 'sold',
          holder_type: 'COURIER',
          holder_branch_id: 1,
        },
        // ✘ Marketga qaytarilgan (ro'yxatda yo'q holat).
        { id: 120, status: 'returned_to_market' },
        // ✔ Viloyati noma'lum (tumansiz, region_id yo'q) — HQ viloyati emas.
        { id: 118, status: 'waiting', district_id: null, region_id: null },
      ];
      for (const seed of seeds) {
        await insertOrder(seed);
      }
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.destroy();
      }
    });

    it('jadval yo‘q — jim o‘tkazib yuboriladi (up ham, down ham)', async () => {
      await inTransaction(up, down);
      const [row]: Array<{ oid: string | null }> = await db.query(
        `SELECT to_regclass('"logistics_schema"."district_coverage_exemptions"')::text AS "oid"`,
      );
      expect(row.oid).toBeNull();
    });

    it('⭐ 203 bilan BITTA tranzaksiyada: kiruvchi holatlar / mas‘ul HQ / viloyatdan tashqari — imtiyoz; qolganlari — yo‘q', async () => {
      // 101 uchun oldindan (tuman ko'chishidan) qator bor — DO NOTHING.
      await inTransaction(
        (runner) => tableMigration.up(runner),
        (runner) =>
          runner.query(
            `INSERT INTO "logistics_schema"."district_coverage_exemptions"
               ("order_id", "branch_id", "district_id", "source")
             VALUES (101, 1, 50, 'district_update')`,
          ),
        up,
      );

      expect(await exemptions()).toEqual([
        '101@1#50:district_update',
        gf(102, 51),
        gf(103, null),
        gf(112, 50),
        gf(116, 50),
        gf(117, 50),
        gf(118, null),
        gf(121, 50),
      ]);
    });

    it('qayta yurgizish (bitta tranzaksiyada ikki marta va alohida) — xatosiz, dublikatsiz, qatorlar tegilmaydi', async () => {
      const before: Array<{ id: string; created_at: Date }> = await db.query(
        `SELECT id::text, created_at FROM "logistics_schema"."district_coverage_exemptions" ORDER BY id`,
      );

      await inTransaction(up, up);
      await inTransaction(up);

      expect(
        await db.query(
          `SELECT id::text, created_at FROM "logistics_schema"."district_coverage_exemptions" ORDER BY id`,
        ),
      ).toEqual(before);
      expect(await exemptions()).toHaveLength(8);
    });

    it('filial jadvali yo‘q — jim o‘tkazib yuboriladi (hech narsa yozilmaydi)', async () => {
      const runner = db.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await runner.query(
          `DELETE FROM "logistics_schema"."district_coverage_exemptions"`,
        );
        await runner.query(
          `ALTER TABLE "branch_schema"."branches" RENAME TO "branches_hidden"`,
        );
        await migration.up(runner);
        const [count] = (await runner.query(
          `SELECT count(*)::text AS "count" FROM "logistics_schema"."district_coverage_exemptions"`,
        )) as Array<{ count: string }>;
        expect(count.count).toBe('0');
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }
      expect(await exemptions()).toHaveLength(8);
    });

    it('⭐ HQ viloyati hali yo‘q — barcha yo‘ldagi / kutilayotgan HQ buyurtmalari (ops viloyatni belgilagach ishlaydi)', async () => {
      await db.query(
        `UPDATE "branch_schema"."branches" SET "region_id" = NULL WHERE "id" = 1`,
      );
      try {
        // Toza holatdan (oldingi testlar yozgan qatorlarsiz) — 118 (viloyati
        // noma'lum) ham shu yo'l bilan yozilishi kerak.
        await inTransaction(down, up);
        expect(await exemptions()).toEqual([
          '101@1#50:district_update',
          gf(102, 51),
          gf(103, null),
          gf(107, 53),
          gf(108, 52),
          gf(112, 50),
          gf(116, 50),
          gf(117, 50),
          gf(118, null),
          gf(121, 50),
        ]);
      } finally {
        await db.query(
          `UPDATE "branch_schema"."branches" SET "region_id" = ${TOSHKENT} WHERE "id" = 1`,
        );
      }
    });

    it('down() — faqat shu manbali qatorlar o‘chadi; qayta yurgizish xatosiz; keyin up() qayta yozadi', async () => {
      await inTransaction(down, down);
      expect(await exemptions()).toEqual(['101@1#50:district_update']);

      await inTransaction(up);
      expect(await exemptions()).toEqual([
        '101@1#50:district_update',
        gf(102, 51),
        gf(103, null),
        gf(112, 50),
        gf(116, 50),
        gf(117, 50),
        gf(118, null),
        gf(121, 50),
      ]);
    });

    it('⭐ deploy oynasi: servislar yangilangach UP SQL psql kabi qayta yurgiziladi — oraliqda HQ kuryeriga berilgan buyurtma qo‘shiladi, qolganlari tegilmaydi', async () => {
      const before: Array<{ id: string; created_at: Date }> = await db.query(
        `SELECT id::text, created_at FROM "logistics_schema"."district_coverage_exemptions" ORDER BY id`,
      );
      // Migratsiyadan keyin, eski logistics-service hali ishlayotganda HQ
      // kuryeriga berilgan Samarqand buyurtmasi.
      await insertOrder({
        id: 119,
        status: 'on the road',
        holder_type: 'COURIER',
        holder_branch_id: 1,
      });
      try {
        await db.query(HQ_COURIER_COVERAGE_GRANDFATHER_UP_SQL);
        await db.query(HQ_COURIER_COVERAGE_GRANDFATHER_UP_SQL);

        expect(await exemptions()).toEqual([
          '101@1#50:district_update',
          gf(102, 51),
          gf(103, null),
          gf(112, 50),
          gf(116, 50),
          gf(117, 50),
          gf(118, null),
          gf(119, 50),
          gf(121, 50),
        ]);
        expect(
          await db.query(
            `SELECT id::text, created_at FROM "logistics_schema"."district_coverage_exemptions"
              WHERE order_id <> 119 ORDER BY id`,
          ),
        ).toEqual(before);
      } finally {
        await db.query(
          `DELETE FROM "logistics_schema"."district_coverage_exemptions" WHERE order_id = 119`,
        );
        await db.query(`DELETE FROM "order_schema"."orders" WHERE id = 119`);
      }
    });
  },
);
