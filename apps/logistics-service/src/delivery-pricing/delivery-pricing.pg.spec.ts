import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { DeliveryPricingEngine1716000000142 } from '../../../../migrations/1716000000142-DeliveryPricingEngine';
import { DeliveryPricingVolumetricFromKg1716000000154 } from '../../../../migrations/1716000000154-DeliveryPricingVolumetricFromKg';
import { DeliveryPricingSaleGates1716000000183 } from '../../../../migrations/1716000000183-DeliveryPricingSaleGates';
import { DeliveryPricingService } from './delivery-pricing.service';
import { DeliveryTariff } from '../entities/delivery-tariff.entity';
import { DeliveryPricingSettings } from '../entities/delivery-pricing-settings.entity';
import { Region } from '../entities/region.entity';
import { District } from '../entities/district.entity';

/**
 * DAqXPeSy — yetkazish narxi HAQIQIY Postgres'da: migratsiya 142 up/down
 * (seed, CHECK'lar, yagona faol sozlama, `is_city_zone` SOATO bo'yicha,
 * qayta yurgizish xavfsizligi) va servisning SQL'i (faol versiya
 * `valid_from <= now()`, rejalashtirilgan versiya, sozlama versiyalash +
 * advisory qulf, kesh yo'qligi). AQ9lkgVB: migratsiya 154
 * (`volumetric_from_kg`, CHECK, up/down) 142 dan keyin birga yuradi.
 *
 * FAQAT lokal test bazasi va FAQAT `logistics_schema` (boshida qayta
 * yaratiladi, oxirida o'chiriladi):
 *   DELIVERY_PRICING_PG_TEST_URI=postgres://postgres:root@127.0.0.1:5432/elchi_e_test
 */
const uri = process.env.DELIVERY_PRICING_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_e_test'
  );
})();

const ITEM = { weight_kg: 1.2, length_cm: 30, width_cm: 22, height_cm: 15 };
const ADMIN = { id: '1', roles: ['superadmin'] };

(localTestDatabase ? describe : describe.skip)(
  'DAqXPeSy — yetkazish narxi (haqiqiy Postgres, logistics_schema)',
  () => {
    let db: DataSource;
    const migration = new DeliveryPricingEngine1716000000142();
    const fromKgMigration = new DeliveryPricingVolumetricFromKg1716000000154();
    // KmWO9gTA: entity endi `min_delivery_price` / `extra_cost_limit_amount` ni o'qiydi.
    const saleGatesMigration = new DeliveryPricingSaleGates1716000000183();
    const activityLog = { log: jest.fn(), logChange: jest.fn() };
    const catalogClient = { send: jest.fn(() => of({ data: [] })) };
    let service: DeliveryPricingService;

    /** 142 + 154 + 183 birga (down — teskari tartibda). */
    const run = async (direction: 'up' | 'down') => {
      const runner = db.createQueryRunner();
      try {
        if (direction === 'up') {
          await migration.up(runner);
          await fromKgMigration.up(runner);
          await saleGatesMigration.up(runner);
        } else {
          await saleGatesMigration.down(runner);
          await fromKgMigration.down(runner);
          await migration.down(runner);
        }
      } finally {
        await runner.release();
      }
    };

    const scalar = async <T = string>(sql: string, params: unknown[] = []) => {
      const rows: Array<{ v: T }> = await db.query(sql, params);
      return rows[0]?.v;
    };

    const quoteTotal = async (payload: Record<string, unknown>) =>
      (
        (await service.quote({
          items: [ITEM],
          where_deliver: 'center',
          ...payload,
        } as never)) as { data: { total: number; tariffId: string } }
      ).data;

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'logistics_schema',
        entities: [Region, District, DeliveryTariff, DeliveryPricingSettings],
        synchronize: false,
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS logistics_schema CASCADE');
      await db.query('CREATE SCHEMA logistics_schema');
      // Baseline (1713400000000) + keyingi migratsiyalardagi regions/districts.
      await db.query(`
        CREATE TABLE logistics_schema.regions (
          "id" BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "is_deleted" boolean NOT NULL DEFAULT false,
          "name" character varying NOT NULL,
          "sato_code" character varying NULL UNIQUE,
          "logist_id" bigint NULL
        )
      `);
      await db.query(`
        CREATE TABLE logistics_schema.districts (
          "id" BIGSERIAL PRIMARY KEY,
          "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
          "is_deleted" boolean NOT NULL DEFAULT false,
          "name" character varying NOT NULL,
          "sato_code" character varying NULL,
          "region_id" bigint NOT NULL REFERENCES logistics_schema.regions(id),
          "assigned_region" bigint NULL REFERENCES logistics_schema.regions(id)
        )
      `);
      // Prod'dagi nomlar: Toshkent VILOYATI — "Toshkent" (SOATO 1727).
      await db.query(`
        INSERT INTO logistics_schema.regions (id, name, sato_code) VALUES
          (1, 'Toshkent shahri', '1726'),
          (2, 'Toshkent', '1727'),
          (3, 'Samarqand', '1718'),
          (4, '  Toshkent sh. ', NULL),
          (5, 'Toshkent viloyati', NULL)
      `);
      await db.query(`
        INSERT INTO logistics_schema.districts (id, name, region_id, assigned_region) VALUES
          (10, 'Chilonzor', 1, NULL),
          (11, 'Yunusobod', 1, NULL),
          (20, 'Zangiota', 2, 1),
          (30, 'Samarqand tumani', 3, NULL)
      `);

      service = new DeliveryPricingService(
        db.getRepository(DeliveryTariff),
        db.getRepository(DeliveryPricingSettings),
        db.getRepository(Region),
        db.getRepository(District),
        catalogClient as never,
        activityLog as never,
      );
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS logistics_schema CASCADE');
        await db.destroy();
      }
    });

    it('up(): seed landing bilan AYNI, pul numeric(14,2)', async () => {
      await run('up');
      const tariffs: Array<Record<string, string>> = await db.query(`
        SELECT tariff_id, base_price, extra_per_kg, days_min, days_max,
               is_active, to_char(valid_from AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') AS vf
          FROM logistics_schema.delivery_tariffs ORDER BY id`);
      expect(tariffs).toEqual([
        {
          tariff_id: 'city',
          base_price: '35000.00',
          extra_per_kg: '4000.00',
          days_min: 1,
          days_max: 1,
          is_active: true,
          vf: '2026-10-08 00:00',
        },
        {
          tariff_id: 'center',
          base_price: '40000.00',
          extra_per_kg: '4000.00',
          days_min: 1,
          days_max: 2,
          is_active: true,
          vf: '2026-10-08 00:00',
        },
        {
          tariff_id: 'address',
          base_price: '60000.00',
          extra_per_kg: '5000.00',
          days_min: 2,
          days_max: 3,
          is_active: true,
          vf: '2026-10-08 00:00',
        },
      ]);
      const settings = await db.query(`
        SELECT volumetric_divisor, volumetric_from_kg, first_kg_included,
               min_billable_kg, billable_step_kg, round_to, pickup_fee,
               pickup_free_from_count, express_multiplier, is_active
          FROM logistics_schema.delivery_pricing_settings`);
      expect(settings).toEqual([
        {
          volumetric_divisor: 5000,
          volumetric_from_kg: '0.000',
          first_kg_included: '1.000',
          min_billable_kg: '0.100',
          billable_step_kg: '0.100',
          round_to: 500,
          pickup_fee: '20000.00',
          pickup_free_from_count: 10,
          express_multiplier: '1.400',
          is_active: true,
        },
      ]);
    });

    it('is_city_zone — faqat Toshkent SHAHRI (SOATO 1726 yoki aniq nom); "Toshkent" (viloyat) — false', async () => {
      const rows: Array<{ id: string; is_city_zone: boolean }> = await db.query(
        'SELECT id, is_city_zone FROM logistics_schema.regions ORDER BY id',
      );
      expect(rows.map((r) => [r.id, r.is_city_zone])).toEqual([
        ['1', true],
        ['2', false],
        ['3', false],
        ['4', true],
        ['5', false],
      ]);
    });

    it('qayta up(): dublikat seed yo`q, admin o`zgartirgan is_city_zone ustidan yozilmaydi', async () => {
      await db.query(
        'UPDATE logistics_schema.regions SET is_city_zone = false WHERE id = 4',
      );
      await run('up');
      expect(
        await scalar(
          'SELECT count(*)::int AS v FROM logistics_schema.delivery_tariffs',
        ),
      ).toBe(3);
      expect(
        await scalar(
          'SELECT count(*)::int AS v FROM logistics_schema.delivery_pricing_settings',
        ),
      ).toBe(1);
      expect(
        await scalar(
          'SELECT is_city_zone AS v FROM logistics_schema.regions WHERE id = 4',
        ),
      ).toBe(false);
    });

    it('CHECK va yagona faol sozlama DB darajasida', async () => {
      await expect(
        db.query(
          `INSERT INTO logistics_schema.delivery_tariffs (tariff_id, base_price, extra_per_kg, days_min, days_max)
           VALUES ('express', 1, 1, 1, 1)`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query(
          `INSERT INTO logistics_schema.delivery_tariffs (tariff_id, base_price, extra_per_kg, days_min, days_max)
           VALUES ('city', -1, 1, 1, 1)`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.query(
          `INSERT INTO logistics_schema.delivery_tariffs (tariff_id, base_price, extra_per_kg, days_min, days_max)
           VALUES ('city', 1, 1, 3, 2)`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const settingsInsert = (multiplier: number) =>
        db.query(
          `INSERT INTO logistics_schema.delivery_pricing_settings
             (volumetric_divisor, first_kg_included, min_billable_kg, billable_step_kg,
              round_to, pickup_fee, pickup_free_from_count, express_multiplier)
           VALUES (5000, 1, 0.1, 0.1, 500, 0, NULL, $1)`,
          [multiplier],
        );
      await expect(settingsInsert(0.5)).rejects.toMatchObject({
        code: '23514',
      });
      // Ikkinchi FAOL qator — unique partial indeks.
      await expect(settingsInsert(1.4)).rejects.toMatchObject({
        code: '23505',
      });
      // AQ9lkgVB: chegara 0..1000 (nofaol qator — unique indeksga tushmaydi).
      for (const fromKg of [-1, 1000.001]) {
        await expect(
          db.query(
            `INSERT INTO logistics_schema.delivery_pricing_settings
               (volumetric_divisor, first_kg_included, min_billable_kg, billable_step_kg,
                round_to, pickup_fee, express_multiplier, is_active, volumetric_from_kg)
             VALUES (5000, 1, 0.1, 0.1, 500, 0, 1.4, false, $1)`,
            [fromKg],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      }
    });

    it('quote: shahar ichi — city; shahar → viloyat (Zangiota, shahar filialiga biriktirilgan) — center', async () => {
      const city = await quoteTotal({
        from_district_id: '10',
        to_district_id: '11',
        where_deliver: 'address',
      });
      expect(city.tariffId).toBe('city');
      expect(city.total).toBe(39000);
      const toRegion = await quoteTotal({
        from_region_id: '1',
        to_district_id: '20',
      });
      expect(toRegion.tariffId).toBe('center');
      expect(toRegion.total).toBe(44000);
      const address = await quoteTotal({
        from_region_id: '1',
        to_district_id: '30',
        where_deliver: 'address',
      });
      expect(address.total).toBe(65000);
    });

    it('yangi tarif versiyasi darhol amal qiladi (kesh yo`q); kelajakdagisi hali yo`q', async () => {
      await service.createTariff(
        {
          tariff_id: 'center',
          base_price: 42000,
          extra_per_kg: 4500,
          days_min: 1,
          days_max: 2,
        },
        ADMIN,
      );
      expect(
        (await quoteTotal({ from_region_id: '1', to_region_id: '3' })).total,
      ).toBe(46500);

      const future = new Date(Date.now() + 86_400_000).toISOString();
      await service.createTariff(
        {
          tariff_id: 'center',
          base_price: 99000,
          extra_per_kg: 9000,
          days_min: 1,
          days_max: 2,
          valid_from: future,
        },
        ADMIN,
      );
      expect(
        (await quoteTotal({ from_region_id: '1', to_region_id: '3' })).total,
      ).toBe(46500);

      const list = (await service.listTariffs({ tariff_id: 'center' })) as {
        data: {
          current: Record<string, DeliveryTariff | null>;
          versions: Array<
            DeliveryTariff & { is_current: boolean; is_scheduled: boolean }
          >;
        };
      };
      expect(list.data.current.center?.base_price).toBe(42000);
      expect(list.data.current.city?.base_price).toBe(35000);
      expect(
        list.data.versions.map((v) => [
          v.base_price,
          v.is_current,
          v.is_scheduled,
        ]),
      ).toEqual([
        [99000, false, true],
        [42000, true, false],
        [40000, false, false],
      ]);
      // Eski qatorlar o'chirilmagan.
      expect(
        await scalar(
          `SELECT count(*)::int AS v FROM logistics_schema.delivery_tariffs WHERE tariff_id = 'center'`,
        ),
      ).toBe(3);
      expect(activityLog.log).toHaveBeenCalledTimes(2);
    });

    it('sozlama: yangi versiya, eskisi nofaol; o`zgarishsiz PATCH — versiya ham, jurnal ham yo`q', async () => {
      await service.updateSettings({ round_to: 1000 }, ADMIN);
      // 46 500 → 1000 ga: 47 000
      expect(
        (await quoteTotal({ from_region_id: '1', to_region_id: '3' })).total,
      ).toBe(47000);
      const rows: Array<{
        round_to: number;
        is_active: boolean;
        created_by: string | null;
      }> = await db.query(
        'SELECT round_to, is_active, created_by FROM logistics_schema.delivery_pricing_settings ORDER BY id',
      );
      expect(rows).toEqual([
        { round_to: 500, is_active: false, created_by: null },
        { round_to: 1000, is_active: true, created_by: '1' },
      ]);
      expect(activityLog.logChange).toHaveBeenCalledTimes(1);
      expect(activityLog.logChange.mock.calls[0][0]).toMatchObject({
        entity_type: 'DeliveryPricingSettings',
        action: 'logistics.delivery_pricing_settings_updated',
        old_value: { round_to: 500, pickup_free_from_count: 10 },
        new_value: { round_to: 1000, pickup_free_from_count: 10 },
      });

      await service.updateSettings({ round_to: 1000 }, ADMIN);
      expect(
        await scalar(
          'SELECT count(*)::int AS v FROM logistics_schema.delivery_pricing_settings',
        ),
      ).toBe(2);
      expect(activityLog.logChange).toHaveBeenCalledTimes(1);

      // NULL → NULL ham "o'zgarish" emas.
      await service.updateSettings({ pickup_free_from_count: null }, ADMIN);
      await service.updateSettings({ pickup_free_from_count: null }, ADMIN);
      expect(
        await scalar(
          'SELECT count(*)::int AS v FROM logistics_schema.delivery_pricing_settings',
        ),
      ).toBe(3);
    });

    it('AQ9lkgVB: volumetric_from_kg PATCH — yangi versiya, quote darhol chegarani oladi, tarixda bor', async () => {
      const SMALL = {
        weight_kg: 0.5,
        length_cm: 20,
        width_cm: 20,
        height_cm: 20,
      };
      const quote = async () =>
        (
          (await service.quote({
            items: [SMALL],
            from_region_id: '1',
            to_region_id: '3',
            where_deliver: 'center',
          } as never)) as { data: Record<string, unknown> }
        ).data;
      // Chegara 0 — hajm 1,6 kg qo'llanadi.
      expect(await quote()).toMatchObject({
        volumetricApplied: true,
        billableKg: 1.6,
      });
      const res = (await service.updateSettings(
        { volumetric_from_kg: 3 },
        ADMIN,
      )) as { data: { volumetric_from_kg: number } };
      expect(res.data.volumetric_from_kg).toBe(3);
      expect(await quote()).toMatchObject({
        volumetricKg: 1.6,
        volumetricFromKg: 3,
        volumetricApplied: false,
        billableKg: 0.5,
        basis: 'weight',
      });
      const history = (await service.listSettingsHistory({ limit: 2 })) as {
        data: {
          versions: Array<{ volumetric_from_kg: number; is_active: boolean }>;
        };
      };
      expect(
        history.data.versions.map((v) => [v.volumetric_from_kg, v.is_active]),
      ).toEqual([
        [3, true],
        [0, false],
      ]);
      // Keyingi testlar oldingi kutilmalar bilan: chegarani 0 ga qaytarish.
      await service.updateSettings({ volumetric_from_kg: 0 }, ADMIN);
    });

    it('ikki admin bir vaqtda — ikkalasi ham o`tadi (advisory qulf), faol qator bitta', async () => {
      await Promise.all([
        service.updateSettings({ pickup_fee: 15000 }, ADMIN),
        service.updateSettings({ express_multiplier: 1.5 }, ADMIN),
        service.updateSettings({ round_to: 500 }, ADMIN),
      ]);
      const active: Array<Record<string, string | number>> = await db.query(
        `SELECT pickup_fee, express_multiplier, round_to
           FROM logistics_schema.delivery_pricing_settings WHERE is_active`,
      );
      expect(active).toEqual([
        { pickup_fee: '15000.00', express_multiplier: '1.500', round_to: 500 },
      ]);
      expect(
        await scalar(
          'SELECT count(*)::int AS v FROM logistics_schema.delivery_pricing_settings',
        ),
      ).toBe(8);
    });

    it('down(): jadvallar va is_city_zone o`chadi; qayta up() — toza seed', async () => {
      await run('down');
      expect(
        await scalar(
          `SELECT to_regclass('logistics_schema.delivery_tariffs')::text AS v`,
        ),
      ).toBeNull();
      expect(
        await scalar(
          `SELECT to_regclass('logistics_schema.delivery_pricing_settings')::text AS v`,
        ),
      ).toBeNull();
      expect(
        await scalar(
          `SELECT count(*)::int AS v FROM information_schema.columns
            WHERE table_schema = 'logistics_schema' AND table_name = 'regions'
              AND column_name = 'is_city_zone'`,
        ),
      ).toBe(0);
      await run('down'); // ikkinchi down — xatosiz

      // 154 ning o'zi: up — ustun sukut 0 bilan, down — ustun o'chadi.
      await run('up');
      const columnCount = () =>
        scalar(
          `SELECT count(*)::int AS v FROM information_schema.columns
            WHERE table_schema = 'logistics_schema'
              AND table_name = 'delivery_pricing_settings'
              AND column_name = 'volumetric_from_kg'`,
        );
      expect(await columnCount()).toBe(1);
      const runner = db.createQueryRunner();
      try {
        await fromKgMigration.up(runner); // qayta up — xatosiz
        await fromKgMigration.down(runner);
        expect(await columnCount()).toBe(0);
        await fromKgMigration.down(runner); // ikkinchi down — xatosiz
      } finally {
        await runner.release();
      }
      await run('down');

      await run('up');
      expect(
        await scalar(
          'SELECT count(*)::int AS v FROM logistics_schema.delivery_tariffs',
        ),
      ).toBe(3);
      expect(
        await scalar(
          'SELECT is_city_zone AS v FROM logistics_schema.regions WHERE id = 1',
        ),
      ).toBe(true);
      expect(
        (await quoteTotal({ from_region_id: '1', to_region_id: '3' })).total,
      ).toBe(44000);
    });
  },
);
