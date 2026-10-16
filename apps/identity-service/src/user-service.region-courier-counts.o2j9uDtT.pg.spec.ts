/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { of } from 'rxjs';
import { DataSource, Repository } from 'typeorm';
import { Roles, Status } from '@app/common';
import { User } from './entities/user.entity';
import { CourierRegion } from './entities/courier-region.entity';
import { UserServiceService } from './user-service.service';

/**
 * o2j9uDtT — `identity.courier.region_counts` (HAQIQIY Postgres).
 *
 * GET /region/stats/all xarita tooltipi uchun har viloyatda kuryerlar soni
 * BITTA SQL'da. Tegishlilik qoidasi GET /region/stats/:id dagi
 * `findAllCouriers({ region_id })` bilan AYNAN bir xil bo'lishi shart —
 * spec har viloyat uchun ikkalasini solishtiradi: oddiy kuryer, nofaol,
 * o'chirilgan, super-kuryer (courier_regions), serves_all_regions,
 * kuryer bo'lmagan foydalanuvchi.
 *
 * Faqat lokal test bazasida:
 *   IDENTITY_REGION_COUNTS_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_b_identity_test
 */
const uri = process.env.IDENTITY_REGION_COUNTS_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();

(localTestDatabase ? describe : describe.skip)(
  'o2j9uDtT — countCouriersByRegion (identity, Postgres)',
  () => {
    let db: DataSource;
    let users: Repository<User>;
    let service: UserServiceService;
    let seq = 0;
    const addUser = async (over: Record<string, unknown>) => {
      seq += 1;
      const res = await users.insert({
        name: `u-${seq}`,
        phone_number: `+99893${String(seq).padStart(7, '0')}`,
        username: `u${seq}`,
        password: 'x',
        role: Roles.COURIER,
        status: Status.ACTIVE,
        ...over,
      } as never);
      return String(res.identifiers[0].id);
    };

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
        noop as never,
        noop as never,
        noop as never,
        noop as never,
        noop as never,
        noop as never,
        { encrypt: jest.fn(), compare: jest.fn() } as never,
        { get: jest.fn() } as never,
        { log: jest.fn(), logChange: jest.fn() } as never,
      );

      // 1-viloyat: faol + nofaol + o'chirilgan kuryer + kuryer bo'lmagan.
      await addUser({ region_id: '1' });
      await addUser({ region_id: '1', status: Status.INACTIVE });
      await addUser({ region_id: '1', isDeleted: true });
      await addUser({ region_id: '1', role: Roles.MANAGER });
      // Super-kuryer: o'z viloyati 3, courier_regions orqali 2 va 3 (dublikat
      // emas — 3 da bir marta sanaladi).
      const superId = await addUser({ region_id: '3', is_super_courier: true });
      // Bayroqsiz courier_regions qatori — hisobga OLINMAYDI (find_all kabi).
      const plainId = await addUser({ region_id: '4' });
      // Hamma viloyatga xizmat qiluvchi NOFAOL super-kuryer.
      await addUser({
        region_id: '4',
        is_super_courier: true,
        serves_all_regions: true,
        status: Status.INACTIVE,
      });
      const regions = db.getRepository(CourierRegion);
      await regions.insert([
        { courier_id: superId, region_id: '2' },
        { courier_id: superId, region_id: '3' },
        { courier_id: plainId, region_id: '5' },
      ] as never);
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
        await db.destroy();
      }
    });

    it('⭐ har viloyat: total/active — GET /region/stats/:id (findAllCouriers) bilan AYNAN bir xil', async () => {
      const regionIds = ['1', '2', '3', '4', '5', '6'];
      const res: any = await service.countCouriersByRegion(regionIds);

      expect(res.data.map((r: any) => r.region_id)).toEqual(regionIds);
      for (const regionId of regionIds) {
        const listed: any = await service.findAllCouriers({
          region_id: regionId,
          limit: 1000,
        } as never);
        const items = listed.data.items as Array<{ status: string }>;
        const row = res.data.find((r: any) => r.region_id === regionId);
        expect({ regionId, total: row.total, active: row.active }).toEqual({
          regionId,
          total: items.length,
          active: items.filter((c) => c.status === 'active').length,
        });
      }
    });

    it('⭐ aniq qiymatlar: nofaol/o`chirilgan/kuryer bo`lmagan faollarga kirmaydi', async () => {
      const res: any = await service.countCouriersByRegion([
        '1',
        '2',
        '3',
        '6',
      ]);
      expect(res.data).toEqual([
        // faol + nofaol + serves_all (nofaol)
        { region_id: '1', total: 3, active: 1 },
        // super-kuryer (faol) + serves_all
        { region_id: '2', total: 2, active: 1 },
        { region_id: '3', total: 2, active: 1 },
        // faqat serves_all (nofaol)
        { region_id: '6', total: 1, active: 0 },
      ]);
    });

    it('bo`sh / yaroqsiz ro`yxat — so`rovsiz bo`sh javob', async () => {
      await expect(service.countCouriersByRegion([])).resolves.toMatchObject({
        data: [],
      });
      await expect(
        service.countCouriersByRegion(['abc', '', null] as never),
      ).resolves.toMatchObject({ data: [] });
    });
  },
);
