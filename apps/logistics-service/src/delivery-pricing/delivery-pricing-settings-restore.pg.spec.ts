import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { DeliveryPricingEngine1716000000142 } from '../../../../migrations/1716000000142-DeliveryPricingEngine';
import { DeliveryPricingVolumetricFromKg1716000000154 } from '../../../../migrations/1716000000154-DeliveryPricingVolumetricFromKg';
import { DeliveryPricingSaleGates1716000000183 } from '../../../../migrations/1716000000183-DeliveryPricingSaleGates';
import { RestoreDeliveryPricingSettings1716000000231 } from '../../../../migrations/1716000000231-RestoreDeliveryPricingSettings';
import { DeliveryTariffCancelScheduled1716000000235 } from '../../../../migrations/1716000000235-DeliveryTariffCancelScheduled';
import { DeliveryPricingService } from './delivery-pricing.service';
import { DeliveryTariff } from '../entities/delivery-tariff.entity';
import { DeliveryPricingSettings } from '../entities/delivery-pricing-settings.entity';
import { Region } from '../entities/region.entity';
import { District } from '../entities/district.entity';

/**
 * Migratsiya 231 — «Hisob qoidalari» faol qatorini tiklash, HAQIQIY Postgres.
 *
 * Prod holati (2026-11-17): baza tozalanganda `delivery_pricing_settings`
 * qatorlari ketgan, 142 «bajarilgan» — `GET`/`PATCH /delivery/pricing-settings`
 * 409 («… migratsiya 1716000000142 yurgizilmagan?»), «necha kg dan keyin
 * qo'shimcha haq» (`first_kg_included`) ni ekrandan kiritib bo'lmaydi.
 *
 * O'z vaqtinchalik bazasi (oxirida o'chiriladi); `DELIVERY_PRICING_PG_TEST_URI`
 * faqat ulanish uchun.
 */
const pgUri = process.env.DELIVERY_PRICING_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const ADMIN = { id: '7', roles: ['superadmin'] };

describePg('Migratsiya 231 — yetkazish narxi sozlamasini tiklash', () => {
  const dbName = `spec_dpset_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let service: DeliveryPricingService;
  const restore = new RestoreDeliveryPricingSettings1716000000231();

  const dbUrl = () => {
    const url = new URL(pgUri!);
    url.pathname = `/${dbName}`;
    return url.toString();
  };

  const runRestore = async () => {
    const runner = db.createQueryRunner();
    try {
      await restore.up(runner);
    } finally {
      await runner.release();
    }
  };

  type SettingsRow = {
    id: string;
    is_active: boolean;
    is_deleted: boolean;
    created_by: string | null;
    volumetric_divisor: number;
    first_kg: number;
    min_kg: number;
    step_kg: number;
    round_to: number;
    pickup_fee: number;
    pickup_free_from_count: number | null;
    express: number;
    vol_from: number;
    min_price: number | null;
    extra_limit: number | null;
  };

  const rows = () =>
    db.query<SettingsRow[]>(
      `SELECT "id", "is_active", "is_deleted", "created_by",
              "volumetric_divisor", "first_kg_included"::float AS first_kg,
              "min_billable_kg"::float AS min_kg, "billable_step_kg"::float AS step_kg,
              "round_to", "pickup_fee"::float AS pickup_fee,
              "pickup_free_from_count", "express_multiplier"::float AS express,
              "volumetric_from_kg"::float AS vol_from,
              "min_delivery_price"::float AS min_price,
              "extra_cost_limit_amount"::float AS extra_limit
         FROM "logistics_schema"."delivery_pricing_settings"
        ORDER BY "id"`,
    );

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
    const runner = db.createQueryRunner();
    try {
      await new DeliveryPricingEngine1716000000142().up(runner);
      await new DeliveryPricingVolumetricFromKg1716000000154().up(runner);
      await new DeliveryPricingSaleGates1716000000183().up(runner);
      // B0ILd7YI: entity `cancelled_at` / `cancelled_by` ni o'qiydi.
      await new DeliveryTariffCancelScheduled1716000000235().up(runner);
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

  it("faol qator bor — hech narsa o'zgarmaydi (admin sozlamasiga tegilmaydi)", async () => {
    await service.updateSettings({ first_kg_included: 2 }, ADMIN);
    const before = await rows();
    expect(before.filter((r) => r.is_active)).toHaveLength(1);

    await runRestore();

    expect(await rows()).toEqual(before);
  });

  it("prod holati: qatorlar o'chib ketgan — 142 seed'i faol qator bo'lib qaytadi, ekran va hisob ishlaydi", async () => {
    await db.query(
      `DELETE FROM "logistics_schema"."delivery_pricing_settings"`,
    );
    const failure = await service
      .getSettings()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RpcException);
    expect((failure as RpcException).getError()).toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('sozlamalari topilmadi'),
    });

    await runRestore();

    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      is_active: true,
      is_deleted: false,
      created_by: null,
      volumetric_divisor: 5000,
      first_kg: 1,
      min_kg: 0.1,
      step_kg: 0.1,
      round_to: 500,
      pickup_fee: 20000,
      pickup_free_from_count: 10,
      express: 1.4,
      vol_from: 0,
      min_price: null,
      extra_limit: null,
    });

    const res = (await service.getSettings()) as {
      data: { first_kg_included: number | string };
    };
    expect(Number(res.data.first_kg_included)).toBe(1);

    // «Necha kg dan keyin qo'shimcha haq» endi ekrandan o'zgartiriladi.
    await service.updateSettings({ first_kg_included: 3 }, ADMIN);
    const edited = await rows();
    expect(edited.filter((r) => r.is_active)).toHaveLength(1);
    expect(edited.find((r) => r.is_active)?.first_kg).toBe(3);
  });

  it('qayta yurgizish xavfsiz — dublikat faol qator yaratilmaydi', async () => {
    const before = await rows();
    await runRestore();
    await runRestore();
    expect(await rows()).toEqual(before);
  });

  it("faqat nofaol versiyalar qolgan — eng so'nggisi qiymatlari bilan yangi faol qator", async () => {
    await db.query(
      `UPDATE "logistics_schema"."delivery_pricing_settings"
          SET "is_active" = false`,
    );
    // Eng katta id — o'chirilgan (is_deleted) qator: manba bo'lmasligi kerak.
    await db.query(
      `INSERT INTO "logistics_schema"."delivery_pricing_settings"
         ("volumetric_divisor", "first_kg_included", "min_billable_kg",
          "billable_step_kg", "round_to", "pickup_fee", "express_multiplier",
          "is_active", "is_deleted", "createdAt")
       VALUES (6000, 9, 0.1, 0.1, 500, 1000, 1.2, false, true,
               now() - interval '1 day')`,
    );
    const history = await rows();
    const latest = history.filter((r) => !r.is_deleted).pop()!;
    expect(history.every((r) => !r.is_active)).toBe(true);
    expect(history[history.length - 1].first_kg).toBe(9);

    await runRestore();

    const after = await rows();
    expect(after).toHaveLength(history.length + 1);
    // Tarix o'zgarmagan.
    expect(after.slice(0, history.length)).toEqual(history);
    const restored = after[after.length - 1];
    expect({ ...restored, id: latest.id }).toEqual({
      ...latest,
      is_active: true,
      created_by: null,
    });
    expect(restored.first_kg).toBe(3);

    // Yangi versiya — hozirgi vaqt bilan (eski sana nusxalanmaydi).
    const [stamps] = await db.query<
      Array<{ restored_fresh: boolean; updated_fresh: boolean }>
    >(
      `SELECT r."createdAt" > l."createdAt" AS restored_fresh,
              r."updatedAt" > l."updatedAt" AS updated_fresh
         FROM "logistics_schema"."delivery_pricing_settings" r,
              "logistics_schema"."delivery_pricing_settings" l
        WHERE r."id" = $1 AND l."id" = $2`,
      [restored.id, latest.id],
    );
    expect(stamps).toEqual({ restored_fresh: true, updated_fresh: true });
  });

  it("o'chirilgan (is_deleted) qatorlar hisobga olinmaydi — seed qaytadi", async () => {
    await db.query(
      `UPDATE "logistics_schema"."delivery_pricing_settings"
          SET "is_active" = false, "is_deleted" = true`,
    );

    await runRestore();

    const active = (await rows()).filter((r) => r.is_active && !r.is_deleted);
    expect(active).toHaveLength(1);
    expect(active[0].first_kg).toBe(1);
    expect(active[0].volumetric_divisor).toBe(5000);
  });

  it("jadval yo'q muhitda xatosiz o'tadi", async () => {
    const runner = db.createQueryRunner();
    try {
      await runner.query(`DROP SCHEMA "logistics_schema" CASCADE`);
      await expect(restore.up(runner)).resolves.toBeUndefined();
    } finally {
      await runner.release();
    }
  });
});
