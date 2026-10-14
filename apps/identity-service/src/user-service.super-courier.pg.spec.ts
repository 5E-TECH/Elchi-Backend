import { RpcException } from '@nestjs/microservices';
import { DataSource, Repository } from 'typeorm';
import { of, throwError } from 'rxjs';
import { Roles, Status } from '@app/common';
import { User } from './entities/user.entity';
import { CourierRegion } from './entities/courier-region.entity';
import { UserServiceService } from './user-service.service';
import { SuperCourierRegions1716000000089 } from '../../../migrations/1716000000089-SuperCourierRegions';

/**
 * hEjjuJaT — super-kuryer (ko'p viloyat) va viloyat tarifi (haqiqiy Postgres).
 *
 * TC1 — 3 viloyat biriktirilgan super-kuryer uchala viloyat kuryerlari
 *       ro'yxatida (pochta → logistics `identity.courier.find_all {region_id}`).
 * TC2 — A viloyati tariff_home=15000 → shu viloyat bo'yicha 15000 (order-service
 *       sotuvda courier_tariff ga snapshot qiladi — order spec'i).
 * TC3 — B viloyati tarifi NULL → kuryerning umumiy tariff_home.
 * TC4 — serves_all_regions=true — courier_regions qatorisiz HAR viloyatda.
 * TC5 — snapshot: order-service.super-courier-tariff.spec.ts.
 *
 * Ishga tushirish (alohida DB — stats pg spec bilan parallel ishlaganda
 * identity_schema to'qnashmasin): IDENTITY_SUPER_COURIER_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_f4_sc_test
 */
const uri = process.env.IDENTITY_SUPER_COURIER_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();
const maybe = localTestDatabase ? describe : describe.skip;

async function rpcStatus(
  promise: Promise<unknown>,
): Promise<number | undefined> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return ((error as RpcException).getError() as { statusCode?: number })
      .statusCode;
  }
  throw new Error('RpcException kutilgandi');
}

maybe('hEjjuJaT — 1716000000089 migratsiyasi (up/down)', () => {
  let db: DataSource;

  beforeAll(async () => {
    db = new DataSource({ type: 'postgres', url: uri, entities: [] });
    await db.initialize();
    await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
    await db.query('CREATE SCHEMA identity_schema');
    await db.query(
      'CREATE TABLE identity_schema.admins (id BIGSERIAL PRIMARY KEY, name varchar(100))',
    );
    await db.query(`INSERT INTO identity_schema.admins (name) VALUES ('k1')`);
  });

  afterAll(async () => {
    if (db?.isInitialized) {
      await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
      await db.destroy();
    }
  });

  it('up: ustunlar default false, courier_regions UNIQUE + CHECK; down tozalaydi', async () => {
    const migration = new SuperCourierRegions1716000000089();
    const qr = db.createQueryRunner();
    await migration.up(qr);
    // Qayta ishga tushirish xavfsiz (IF NOT EXISTS).
    await migration.up(qr);

    const [admin] = await db.query(
      'SELECT is_super_courier, serves_all_regions FROM identity_schema.admins LIMIT 1',
    );
    expect(admin).toEqual({
      is_super_courier: false,
      serves_all_regions: false,
    });

    await db.query(
      `INSERT INTO identity_schema.courier_regions (courier_id, region_id, tariff_home) VALUES (1, 5, 15000)`,
    );
    await expect(
      db.query(
        `INSERT INTO identity_schema.courier_regions (courier_id, region_id) VALUES (1, 5)`,
      ),
    ).rejects.toThrow(/UQ_COURIER_REGIONS_COURIER_REGION|duplicate/);
    await expect(
      db.query(
        `INSERT INTO identity_schema.courier_regions (courier_id, region_id, tariff_home) VALUES (1, 6, -1)`,
      ),
    ).rejects.toThrow(/CHK_COURIER_REGIONS_TARIFF_NON_NEGATIVE/);

    await migration.down(qr);
    const [tbl] = await db.query(
      `SELECT to_regclass('identity_schema.courier_regions') AS t`,
    );
    expect(tbl.t).toBeNull();
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'identity_schema' AND table_name = 'admins'`,
    );
    expect(
      cols.map((c: { column_name: string }) => c.column_name),
    ).not.toContain('is_super_courier');
    await qr.release();
  });
});

maybe('hEjjuJaT — super-kuryer viloyatlari (identity, Postgres)', () => {
  let db: DataSource;
  let users: Repository<User>;
  let service: UserServiceService;
  const logisticsSend = jest.fn((_p: unknown, payload: { id: string }) =>
    Number(payload.id) >= 1 && Number(payload.id) <= 14
      ? of({ data: { id: payload.id, name: `V-${payload.id}` } })
      : throwError(() => ({ statusCode: 404, message: 'Region not found' })),
  );
  let seq = 0;
  const addCourier = async (over: Partial<User> = {}) => {
    seq += 1;
    const res = await users.insert({
      name: `kuryer-${seq}`,
      phone_number: `+99891${String(seq).padStart(7, '0')}`,
      username: `k${seq}`,
      password: 'x',
      role: Roles.COURIER,
      status: Status.ACTIVE,
      tariff_home: 50000,
      tariff_center: 30000,
      ...over,
    } as never);
    return String(res.identifiers[0].id);
  };
  const regionIdsOf = async (regionId: string) =>
    (
      (await service.findAllCouriers({ region_id: regionId } as never)) as any
    ).data.items.map((c: { id: string }) => String(c.id));

  beforeAll(async () => {
    db = new DataSource({
      type: 'postgres',
      url: uri,
      entities: [User, CourierRegion],
      synchronize: false,
    });
    await db.initialize();
    await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
    await db.query('CREATE SCHEMA identity_schema');
    await db.synchronize();
    users = db.getRepository(User);
    const noop = { send: jest.fn(() => of({})), emit: jest.fn() };
    service = new UserServiceService(
      users as never,
      noop as never, // search
      noop as never, // catalog
      noop as never, // order
      { send: logisticsSend } as never, // logistics
      noop as never, // finance
      noop as never, // branch
      { encrypt: jest.fn(), compare: jest.fn() } as never,
      { get: jest.fn() } as never,
      { log: jest.fn(), logChange: jest.fn() } as never,
    );
  });

  afterAll(async () => {
    if (db?.isInitialized) {
      await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
      await db.destroy();
    }
  });

  it('TC1: 3 viloyat biriktirilgan super-kuryer uchala viloyatda chiqadi, 4-sida yo‘q', async () => {
    const regular = await addCourier({ region_id: '1' } as Partial<User>);
    const superId = await addCourier({ region_id: '1' } as Partial<User>);

    const res: any = await service.setCourierRegions(
      superId,
      {
        is_super_courier: true,
        regions: [
          { region_id: '2', tariff_home: 15000 },
          { region_id: '3' },
          { region_id: '4', tariff_center: 9000 },
        ],
      },
      { id: '1', roles: ['admin'] } as never,
    );
    expect(res.data).toEqual(
      expect.objectContaining({
        is_super_courier: true,
        serves_all_regions: false,
        regions: [
          { region_id: '2', tariff_home: 15000, tariff_center: null },
          { region_id: '3', tariff_home: null, tariff_center: null },
          { region_id: '4', tariff_home: null, tariff_center: 9000 },
        ],
      }),
    );

    for (const regionId of ['2', '3', '4']) {
      expect(await regionIdsOf(regionId)).toContain(superId);
      expect(await regionIdsOf(regionId)).not.toContain(regular);
    }
    expect(await regionIdsOf('1')).toEqual(
      expect.arrayContaining([superId, regular]),
    );
    expect(await regionIdsOf('7')).not.toContain(superId);
  });

  it('TC2/TC3: viloyat tarifi (15000) yoki NULL → yassi (50000); viloyatsiz chaqiruv o‘zgarmaydi', async () => {
    const superId = await addCourier({ region_id: '1' } as Partial<User>);
    await service.setCourierRegions(superId, {
      is_super_courier: true,
      regions: [{ region_id: '5', tariff_home: 15000 }, { region_id: '6' }],
    });

    const inA: any = await service.findCouriersByIds([superId], '5');
    expect(inA.data[0]).toEqual(
      expect.objectContaining({
        tariff_home: 15000,
        tariff_center: 30000,
        tariff_source: 'region',
      }),
    );
    const inB: any = await service.findCouriersByIds([superId], '6');
    expect(inB.data[0]).toEqual(
      expect.objectContaining({
        tariff_home: 50000,
        tariff_center: 30000,
        tariff_source: 'flat',
      }),
    );
    const plain: any = await service.findCouriersByIds([superId]);
    expect(plain.data[0].tariff_home).toBe(50000);
    expect(plain.data[0]).not.toHaveProperty('tariff_source');
  });

  it('oddiy kuryer (is_super_courier=false) uchun courier_regions qatori bo‘lsa ham tarif yassi', async () => {
    const id = await addCourier({ region_id: '1' } as Partial<User>);
    await db.query(
      `INSERT INTO identity_schema.courier_regions (courier_id, region_id, tariff_home) VALUES ($1, 8, 1)`,
      [id],
    );
    const res: any = await service.findCouriersByIds([id], '8');
    expect(res.data[0].tariff_home).toBe(50000);
    expect(await regionIdsOf('8')).not.toContain(id);
  });

  it('TC4: serves_all_regions=true — qatorsiz ham HAR viloyatda', async () => {
    const id = await addCourier({ region_id: '1' } as Partial<User>);
    await service.setCourierRegions(id, {
      is_super_courier: true,
      serves_all_regions: true,
      regions: [],
    });
    for (const regionId of ['9', '10', '14']) {
      expect(await regionIdsOf(regionId)).toContain(id);
    }
  });

  it("is_super_courier=false — viloyatlar tozalanadi, kuryer faqat o'z viloyatida", async () => {
    const id = await addCourier({ region_id: '1' } as Partial<User>);
    await service.setCourierRegions(id, {
      is_super_courier: true,
      serves_all_regions: true,
      regions: [{ region_id: '11' }],
    });
    const res: any = await service.setCourierRegions(id, {
      is_super_courier: false,
    });
    expect(res.data).toEqual(
      expect.objectContaining({
        is_super_courier: false,
        serves_all_regions: false,
        regions: [],
      }),
    );
    expect(await regionIdsOf('11')).not.toContain(id);
    expect(await regionIdsOf('12')).not.toContain(id);
    const left = await db.query(
      'SELECT count(*)::int AS n FROM identity_schema.courier_regions WHERE courier_id = $1',
      [id],
    );
    expect(left[0].n).toBe(0);
  });

  it('validatsiya: takror viloyat / oddiy kuryerga ro‘yxat / serves_all super’siz / noma’lum viloyat → 400; kuryer yo‘q → 404', async () => {
    const id = await addCourier({ region_id: '1' } as Partial<User>);
    expect(
      await rpcStatus(
        service.setCourierRegions(id, {
          is_super_courier: true,
          regions: [{ region_id: '2' }, { region_id: '2' }],
        }),
      ),
    ).toBe(400);
    expect(
      await rpcStatus(
        service.setCourierRegions(id, {
          is_super_courier: false,
          regions: [{ region_id: '2' }],
        }),
      ),
    ).toBe(400);
    expect(
      await rpcStatus(
        service.setCourierRegions(id, {
          is_super_courier: false,
          serves_all_regions: true,
        }),
      ),
    ).toBe(400);
    expect(
      await rpcStatus(
        service.setCourierRegions(id, {
          is_super_courier: true,
          regions: [{ region_id: '999' }],
        }),
      ),
    ).toBe(400);
    expect(
      await rpcStatus(
        service.setCourierRegions(id, {
          is_super_courier: true,
          regions: [{ region_id: '2', tariff_home: -5 }],
        }),
      ),
    ).toBe(400);
    expect(await rpcStatus(service.getCourierRegions('987654'))).toBe(404);
  });

  it('logistics javob bermasa — 503 (fail-closed), hech narsa yozilmaydi', async () => {
    const id = await addCourier({ region_id: '1' } as Partial<User>);
    logisticsSend.mockImplementationOnce(() =>
      throwError(() => new Error('timeout')),
    );
    expect(
      await rpcStatus(
        service.setCourierRegions(id, {
          is_super_courier: true,
          regions: [{ region_id: '2' }],
        }),
      ),
    ).toBe(503);
    const user = await users.findOneByOrFail({ id });
    expect(user.is_super_courier).toBe(false);
  });
});
