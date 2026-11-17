import { randomUUID } from 'node:crypto';
import { of } from 'rxjs';
import { DataSource, MigrationInterface } from 'typeorm';
import { isOrderCourierServedByBranch } from '@app/common';
import { HqBranchRegion1716000000204 } from '../../../migrations/1716000000204-HqBranchRegion';
import { RestoreHqBranchRegion1716000000233 } from '../../../migrations/1716000000233-RestoreHqBranchRegion';
import { regions as SEED_REGIONS } from '../../logistics-service/src/data/regions-districts.data';
import { Branch } from './entities/branch.entity';
import { BranchUser } from './entities/branch-user.entity';
import { BranchConfig } from './entities/branch-config.entity';
import { BranchServiceService } from './branch-service.service';

/**
 * Migratsiya 233 — HQ filiali viloyatini tiklash, HAQIQIY Postgres.
 *
 * Prod holati (baza tozalanishi, 2026-11-11..14): HQ qatorini branch-service
 * `ensureHqBranch` viloyatsiz qayta yaratadi yoki viloyatlar yangi id bilan
 * qayta seed qilinib HQ eski id'ga ishora qiladi — 204 «bajarilgan», HQ
 * kuryeriga buyurtma berib bo'lmaydi (400 `branch_region_missing`).
 *
 * O'z vaqtinchalik bazasi (oxirida o'chiriladi); `BRANCH_PG_TEST_URI` faqat
 * ulanish uchun (faqat lokal xost).
 */
const pgUri = process.env.BRANCH_PG_TEST_URI;
const localHost = (() => {
  if (!pgUri) return false;
  return ['127.0.0.1', 'localhost'].includes(new URL(pgUri).hostname);
})();
const describePg = localHost ? describe : describe.skip;

type BranchRow = {
  id: string;
  code: string | null;
  type: string;
  region_id: string | null;
  is_deleted: boolean;
  updated: string;
};

describePg('Migratsiya 233 — HQ filiali viloyatini tiklash', () => {
  const dbName = `spec_hqregion_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: BranchServiceService;
  const restore = new RestoreHqBranchRegion1716000000233();

  const dbUrl = () => {
    const url = new URL(pgUri!);
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  /** TypeORM kabi: bitta tranzaksiyada. */
  const runUp = async (migration: MigrationInterface) => {
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
  const runRestore = () => runUp(restore);

  const branches = () =>
    db.query<BranchRow[]>(
      `SELECT "id"::text AS id, "code", "type"::text AS type,
              "region_id"::text AS region_id, "is_deleted",
              "updatedAt"::text AS updated
         FROM "branch_schema"."branches"
        ORDER BY "id"`,
    );

  /** logistics-service `onModuleInit` seed'i kabi: 14 viloyat. */
  const seedRegions = async () => {
    for (const region of SEED_REGIONS) {
      await db.query(
        `INSERT INTO "logistics_schema"."regions" ("name", "sato_code") VALUES ($1, $2)`,
        [region.name.trim(), region.sato_code],
      );
    }
  };
  const regionIdBySato = async (sato: string) => {
    const [row] = await db.query<Array<{ id: string }>>(
      `SELECT "id"::text AS id FROM "logistics_schema"."regions"
        WHERE "sato_code" = $1 AND "is_deleted" = false`,
      [sato],
    );
    if (!row) throw new Error(`SOATO ${sato} viloyati yo'q`);
    return row.id;
  };

  const insertBranch = async (row: {
    name: string;
    type: 'HQ' | 'REGIONAL' | 'PICKUP' | 'HYBRID';
    region_id: string | null;
    code?: string;
    is_deleted?: boolean;
  }) => {
    const [saved] = await db.query<Array<{ id: string }>>(
      `INSERT INTO "branch_schema"."branches" ("name", "type", "region_id", "code", "is_deleted")
       VALUES ($1, $2, $3, $4, $5) RETURNING "id"::text AS id`,
      [
        row.name,
        row.type,
        row.region_id,
        row.code ?? null,
        row.is_deleted ?? false,
      ],
    );
    return saved.id;
  };

  /** Servis javobidagi HQ + logistics qamrov qoidasi (Toshkent shahri tumani). */
  const hqServesTashkent = async () => {
    const res = (await service.findHqBranch()) as {
      data: { id: string; type: string; region_id: string | null };
    };
    const tashkent = await regionIdBySato('1726');
    return {
      region_id:
        res.data.region_id === null ? null : String(res.data.region_id),
      served: isOrderCourierServedByBranch(
        { district: { region_id: tashkent } },
        res.data,
      ),
    };
  };

  /** Prod'dagi tozalash: filiallar o'chadi, branch-service qayta ishga tushadi. */
  const wipeBranchesAndBoot = async () => {
    await db.query(`DELETE FROM "branch_schema"."branch_users"`);
    await db.query(`DELETE FROM "branch_schema"."branches"`);
    await service.onModuleInit();
  };

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);

    db = new DataSource({
      type: 'postgres',
      url: dbUrl(),
      schema: 'branch_schema',
      entities: [Branch, BranchUser, BranchConfig],
      synchronize: false,
    });
    await db.initialize();
    await db.query('CREATE SCHEMA "branch_schema"');
    await db.synchronize();
    // Baseline (1713400000000) shakli — migratsiya o'qiydigan ustunlar.
    await db.query('CREATE SCHEMA "logistics_schema"');
    await db.query(`
      CREATE TABLE "logistics_schema"."regions" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "name" character varying NOT NULL,
        "sato_code" character varying NULL UNIQUE
      )
    `);
    await seedRegions();

    const client = () => ({ send: jest.fn(() => of({ data: [] })) });
    service = new BranchServiceService(
      db.getRepository(Branch),
      db.getRepository(BranchUser),
      db.getRepository(BranchConfig),
      client() as never,
      client() as never,
      client() as never,
      client() as never,
      client() as never,
      { get: (_k: string, fallback?: string) => fallback } as never,
      {
        log: jest.fn().mockResolvedValue(undefined),
        logChange: jest.fn().mockResolvedValue(undefined),
      } as never,
    );

    // Prod tarixi: HQ — ensureHqBranch (viloyatsiz), keyin migratsiya 204.
    await service.onModuleInit();
    await runUp(new HqBranchRegion1716000000204());
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  it("204 yozgan viloyat bor — hech narsa o'zgarmaydi, HQ kuryeri Toshkent buyurtmasini oladi", async () => {
    const before = await branches();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      code: 'HQ-TSHKNT',
      type: 'HQ',
      region_id: await regionIdBySato('1726'),
    });

    await runRestore();

    expect(await branches()).toEqual(before);
    expect(await hqServesTashkent()).toMatchObject({ served: true });
  });

  it('prod holati: HQ qayta yaratilgan (viloyatsiz) — Toshkent shahri qaytadi, boshqa filiallar tegilmaydi', async () => {
    await wipeBranchesAndBoot();
    const samarqand = await regionIdBySato('1718');
    const regionalEmpty = await insertBranch({
      name: 'Viloyatsiz filial',
      type: 'REGIONAL',
      region_id: null,
      code: 'R-EMPTY',
    });
    const regional = await insertBranch({
      name: 'Samarqand filiali',
      type: 'REGIONAL',
      region_id: samarqand,
      code: 'R-SAM',
    });
    expect(await hqServesTashkent()).toEqual({
      region_id: null,
      served: false,
    });

    await runRestore();

    const tashkent = await regionIdBySato('1726');
    expect(await hqServesTashkent()).toEqual({
      region_id: tashkent,
      served: true,
    });
    const after = await branches();
    expect(after.find((b) => b.id === regionalEmpty)?.region_id).toBeNull();
    expect(after.find((b) => b.id === regional)?.region_id).toBe(samarqand);
  });

  it('qayta yurgizish xavfsiz — hech narsa o`zgarmaydi', async () => {
    const before = await branches();
    await runRestore();
    await runRestore();
    expect(await branches()).toEqual(before);
  });

  it("prod holati: viloyatlar yangi id bilan qayta seed qilingan — HQ yangi Toshkent shahriga o'tadi, oddiy filial esa qo'lda qoladi", async () => {
    const oldSamarqand = await regionIdBySato('1718');
    const stale = await insertBranch({
      name: 'Eski viloyatli filial',
      type: 'REGIONAL',
      region_id: oldSamarqand,
      code: 'R-STALE',
    });
    await db.query(`DELETE FROM "logistics_schema"."regions"`);
    await seedRegions();
    const tashkent = await regionIdBySato('1726');
    const hqBefore = await hqServesTashkent();
    expect(hqBefore.region_id).not.toBeNull();
    expect(hqBefore.region_id).not.toBe(tashkent);
    expect(hqBefore.served).toBe(false);

    await runRestore();

    expect(await hqServesTashkent()).toEqual({
      region_id: tashkent,
      served: true,
    });
    expect((await branches()).find((b) => b.id === stale)?.region_id).toBe(
      oldSamarqand,
    );
  });

  it("qo'lda qo'yilgan tirik viloyat va o'chirilgan viloyatga ishora — ustidan yozilmaydi", async () => {
    const samarqand = await regionIdBySato('1718');
    await db.query(
      `UPDATE "branch_schema"."branches" SET "region_id" = $1 WHERE "type" = 'HQ'`,
      [samarqand],
    );
    await runRestore();
    expect((await hqServesTashkent()).region_id).toBe(samarqand);

    await db.query(
      `UPDATE "logistics_schema"."regions" SET "is_deleted" = true WHERE "id" = $1`,
      [samarqand],
    );
    await runRestore();
    expect((await hqServesTashkent()).region_id).toBe(samarqand);
    await db.query(
      `UPDATE "logistics_schema"."regions" SET "is_deleted" = false WHERE "id" = $1`,
      [samarqand],
    );
  });

  it("o'chirilgan HQ qatori tiriltirilmaydi va to'ldirilmaydi", async () => {
    const deletedHq = await insertBranch({
      name: 'Eski HQ',
      type: 'HQ',
      region_id: null,
      code: 'HQ-OLD',
      is_deleted: true,
    });
    await runRestore();
    expect((await branches()).find((b) => b.id === deletedHq)).toMatchObject({
      is_deleted: true,
      region_id: null,
    });
  });

  it("1726 viloyati yo'q (yoki o'chirilgan) — HQ viloyatsiz qoladi", async () => {
    await db.query(
      `UPDATE "branch_schema"."branches" SET "region_id" = NULL WHERE "type" = 'HQ'`,
    );
    await db.query(
      `UPDATE "logistics_schema"."regions" SET "is_deleted" = true WHERE "sato_code" = '1726'`,
    );
    await runRestore();
    const hq = (await branches()).filter(
      (b) => b.type === 'HQ' && !b.is_deleted,
    );
    expect(hq.map((b) => b.region_id)).toEqual([null]);
  });

  it("jadval(lar) yo'q muhitda xatosiz o'tadi", async () => {
    await db.query(`DROP SCHEMA "logistics_schema" CASCADE`);
    await expect(runRestore()).resolves.toBeUndefined();
    await db.query(`DROP SCHEMA "branch_schema" CASCADE`);
    await expect(runRestore()).resolves.toBeUndefined();
  });
});
