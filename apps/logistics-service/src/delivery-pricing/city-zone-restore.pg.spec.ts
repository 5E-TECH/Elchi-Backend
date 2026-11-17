import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { DeliveryPricingEngine1716000000142 } from '../../../../migrations/1716000000142-DeliveryPricingEngine';
import { DeliveryPricingVolumetricFromKg1716000000154 } from '../../../../migrations/1716000000154-DeliveryPricingVolumetricFromKg';
import { DeliveryPricingSaleGates1716000000183 } from '../../../../migrations/1716000000183-DeliveryPricingSaleGates';
import { RestoreTashkentCityZone1716000000232 } from '../../../../migrations/1716000000232-RestoreTashkentCityZone';
import { regions as SEED_REGIONS } from '../data/regions-districts.data';
import { DeliveryPricingService } from './delivery-pricing.service';
import { DeliveryTariff } from '../entities/delivery-tariff.entity';
import { DeliveryPricingSettings } from '../entities/delivery-pricing-settings.entity';
import { Region } from '../entities/region.entity';
import { District } from '../entities/district.entity';

/**
 * Migratsiya 232 — Toshkent shahri `is_city_zone` belgisini tiklash, HAQIQIY
 * Postgres.
 *
 * Prod holati (baza tozalanishi, 2026-11-11..14): viloyatlarni logistics-service
 * `onModuleInit` seed'i qayta yaratadi (`name` + `sato_code`), belgi esa ustun
 * sukuti `false` bo'lib qoladi — 142 qayta yurmaydi, API/ekran yozolmaydi.
 * Toshkent ichidagi yetkazish jimgina «center» bilan hisoblanadi.
 *
 * O'z vaqtinchalik bazasi (oxirida o'chiriladi); `DELIVERY_PRICING_PG_TEST_URI`
 * faqat ulanish uchun (faqat lokal xost).
 */
const pgUri = process.env.DELIVERY_PRICING_PG_TEST_URI;
const localHost = (() => {
  if (!pgUri) return false;
  return ['127.0.0.1', 'localhost'].includes(new URL(pgUri).hostname);
})();
const describePg = localHost ? describe : describe.skip;

/** 1 kg — birinchi kg bazada: narx = tarif bazasi (city 35 000, center 40 000). */
const ITEM = { weight_kg: 1 };

describePg('Migratsiya 232 — Toshkent shahri shahar zonasini tiklash', () => {
  const dbName = `spec_cityzone_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: DeliveryPricingService;
  const restore = new RestoreTashkentCityZone1716000000232();

  const dbUrl = () => {
    const url = new URL(pgUri!);
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  const runRestore = async () => {
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await restore.up(runner);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };

  type RegionRow = {
    id: string;
    name: string;
    sato_code: string | null;
    is_deleted: boolean;
    is_city_zone: boolean;
    updated: string;
  };
  const rows = () =>
    db.query<RegionRow[]>(
      `SELECT "id"::text AS id, "name", "sato_code", "is_deleted", "is_city_zone",
              "updatedAt"::text AS updated
         FROM "logistics_schema"."regions"
        ORDER BY "id"`,
    );
  const zones = async () =>
    (await rows()).filter((r) => r.is_city_zone).map((r) => r.sato_code);
  const idBySato = async (sato: string) => {
    const row = (await rows()).find(
      (r) => r.sato_code === sato && !r.is_deleted,
    );
    if (!row) throw new Error(`SOATO ${sato} viloyati yo'q`);
    return row.id;
  };

  /** Prod'dagi baza tozalanishi + logistics-service `onModuleInit` seed'i. */
  const wipeAndReseed = async () => {
    await db.query(`DELETE FROM "logistics_schema"."regions"`);
    const repo = db.getRepository(Region);
    for (const region of SEED_REGIONS) {
      await repo.save(
        repo.create({ name: region.name.trim(), sato_code: region.sato_code }),
      );
    }
  };

  const quote = async (fromId: string, toId: string) =>
    (
      (await service.quote({
        items: [ITEM],
        from_region_id: fromId,
        to_region_id: toId,
        where_deliver: 'center',
      })) as {
        data: {
          total: number;
          tariffId: string;
          route: { city_route: boolean };
        };
      }
    ).data;

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);

    db = new DataSource({
      type: 'postgres',
      url: dbUrl(),
      schema: 'logistics_schema',
      entities: [Region, District, DeliveryTariff, DeliveryPricingSettings],
      synchronize: false,
    });
    await db.initialize();
    await db.query('CREATE SCHEMA "logistics_schema"');
    // Baseline (1713400000000) + 060 (logist_id) — 142 gacha bo'lgan shakl.
    await db.query(`
      CREATE TABLE "logistics_schema"."regions" (
        "id" BIGSERIAL PRIMARY KEY,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "is_deleted" boolean NOT NULL DEFAULT false,
        "name" character varying NOT NULL,
        "sato_code" character varying NULL UNIQUE,
        "logist_id" bigint NULL
      )
    `);
    for (const region of SEED_REGIONS) {
      await db.query(
        `INSERT INTO "logistics_schema"."regions" ("name", "sato_code") VALUES ($1, $2)`,
        [region.name.trim(), region.sato_code],
      );
    }
    const runner = db.createQueryRunner();
    try {
      await new DeliveryPricingEngine1716000000142().up(runner);
      await new DeliveryPricingVolumetricFromKg1716000000154().up(runner);
      await new DeliveryPricingSaleGates1716000000183().up(runner);
    } finally {
      await runner.release();
    }

    service = new DeliveryPricingService(
      db.getRepository(DeliveryTariff),
      db.getRepository(DeliveryPricingSettings),
      db.getRepository(Region),
      db.getRepository(District),
      { send: jest.fn(() => of({ data: [] })) } as never,
      { log: jest.fn(), logChange: jest.fn() } as never,
    );
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  it("142 seed'i bor — hech narsa o'zgarmaydi, Toshkent ichida «city»", async () => {
    expect(await zones()).toEqual(['1726']);
    const before = await rows();

    await runRestore();

    expect(await rows()).toEqual(before);
    const tashkent = await idBySato('1726');
    const city = await quote(tashkent, tashkent);
    expect(city).toMatchObject({ tariffId: 'city', total: 35_000 });
    expect(city.route.city_route).toBe(true);
  });

  it('prod holati: viloyatlar qayta seed qilingan — belgi faqat Toshkent SHAHRIGA qaytadi, narx «city»', async () => {
    await wipeAndReseed();
    expect(await zones()).toEqual([]);
    const tashkent = await idBySato('1726');
    const broken = await quote(tashkent, tashkent);
    expect(broken).toMatchObject({ tariffId: 'center', total: 40_000 });
    expect(broken.route.city_route).toBe(false);

    await runRestore();

    // Toshkent VILOYATI (`Toshkent`, 1727) — shahar zonasi emas.
    expect(await zones()).toEqual(['1726']);
    const fixed = await quote(tashkent, tashkent);
    expect(fixed).toMatchObject({ tariffId: 'city', total: 35_000 });
    expect(fixed.route.city_route).toBe(true);
    // Shahar → viloyat — avvalgidek `where_deliver`.
    const toRegion = await quote(tashkent, await idBySato('1727'));
    expect(toRegion.tariffId).toBe('center');
  });

  it('qayta yurgizish xavfsiz — hech narsa o`zgarmaydi', async () => {
    const before = await rows();
    await runRestore();
    await runRestore();
    expect(await rows()).toEqual(before);
  });

  it("zona boshqa qatorda (qo'lda, SQL) — ustidan yozilmaydi", async () => {
    await db.query(
      `UPDATE "logistics_schema"."regions"
          SET "is_city_zone" = ("sato_code" = '1718')`,
    );
    await runRestore();
    expect(await zones()).toEqual(['1718']);
  });

  it("o'chirilgan qatordagi belgi ham seed belgisi — tegilmaydi", async () => {
    await db.query(
      `UPDATE "logistics_schema"."regions" SET "is_city_zone" = false`,
    );
    await db.query(
      `UPDATE "logistics_schema"."regions"
          SET "is_city_zone" = true, "is_deleted" = true
        WHERE "sato_code" = '1735'`,
    );
    await runRestore();
    expect(await zones()).toEqual(['1735']);
    await db.query(
      `UPDATE "logistics_schema"."regions"
          SET "is_city_zone" = false, "is_deleted" = false`,
    );
  });

  it("o'chirilgan Toshkent shahri qatori tiriltirilmaydi va belgi olmaydi", async () => {
    await db.query(
      `UPDATE "logistics_schema"."regions" SET "is_deleted" = true
        WHERE "sato_code" = '1726'`,
    );
    await runRestore();
    expect(await zones()).toEqual([]);
    const [{ deleted }] = await db.query<Array<{ deleted: boolean }>>(
      `SELECT "is_deleted" AS deleted FROM "logistics_schema"."regions"
        WHERE "sato_code" = '1726'`,
    );
    expect(deleted).toBe(true);
  });

  it("SOATO'siz qator — faqat aniq nom bilan (1726 qatori yo'q bo'lsa)", async () => {
    await db.query(`DELETE FROM "logistics_schema"."regions"
                     WHERE "sato_code" IN ('1726', '1727')`);
    await db.query(
      `INSERT INTO "logistics_schema"."regions" ("name", "sato_code") VALUES
         ('  Toshkent sh. ', NULL), ('Toshkent', NULL), ('Toshkent viloyati', NULL)`,
    );
    await runRestore();
    const flagged = (await rows())
      .filter((r) => r.is_city_zone)
      .map((r) => r.name);
    expect(flagged).toEqual(['  Toshkent sh. ']);
  });

  it("ustun yoki jadval yo'q muhitda xatosiz o'tadi", async () => {
    await db.query(
      `ALTER TABLE "logistics_schema"."regions" DROP COLUMN "is_city_zone"`,
    );
    await expect(runRestore()).resolves.toBeUndefined();
    await db.query(`DROP SCHEMA "logistics_schema" CASCADE`);
    await expect(runRestore()).resolves.toBeUndefined();
  });
});
