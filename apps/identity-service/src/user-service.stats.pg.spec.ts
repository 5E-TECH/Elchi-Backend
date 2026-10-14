import { DataSource, Repository } from 'typeorm';
import { Roles, Status } from '@app/common';
import { User } from './entities/user.entity';
import { UserServiceService } from './user-service.service';

/**
 * nFmup26a — /all-users statistika kartalari (haqiqiy Postgres).
 *
 * Avval totalEmployees faqat ADMIN + REGISTRATOR + COURIER ni sanardi:
 * 11 menejer (va operator/branch/investor/logist) hech bir kartaga tushmay,
 * Marketlar + Xodimlar ≠ Barcha foydalanuvchilar edi. Invariant:
 * totalMarket + totalEmployees === totalUsers; meta.countsByRole — Roles
 * enum'ining har bir qiymati.
 *
 * Ishga tushirish: IDENTITY_STATS_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_f4_test
 */
const uri = process.env.IDENTITY_STATS_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();

(localTestDatabase ? describe : describe.skip)(
  'nFmup26a — findAllAdmins meta invarianti (Postgres)',
  () => {
    let db: DataSource;
    let repo: Repository<User>;
    let service: UserServiceService;
    let seq = 0;

    const addUsers = async (
      role: Roles,
      count: number,
      extra: Partial<User> = {},
    ) => {
      for (let i = 0; i < count; i += 1) {
        seq += 1;
        await repo.insert({
          name: `${role}-${seq}`,
          phone_number: `+99890${String(seq).padStart(7, '0')}`,
          username: `u${seq}`,
          password: 'x',
          role,
          status: Status.ACTIVE,
          ...extra,
        } as never);
      }
    };

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        entities: [User],
        synchronize: false,
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
      await db.query('CREATE SCHEMA identity_schema');
      await db.synchronize();
      repo = db.getRepository(User);
      const noopClient = { send: jest.fn(), emit: jest.fn() };
      service = new UserServiceService(
        repo as never,
        noopClient as never, // search
        noopClient as never, // catalog
        noopClient as never, // order
        noopClient as never, // logistics
        noopClient as never, // finance
        noopClient as never, // branch
        { encrypt: jest.fn(), compare: jest.fn() } as never,
        { get: jest.fn() } as never,
        { log: jest.fn(), logChange: jest.fn() } as never,
      );

      // Jonli kesim (kartadagi dalil): market 11, manager 11, courier 10,
      // registrator 2, admin 1 = 35.
      await addUsers(Roles.MARKET, 11);
      await addUsers(Roles.MANAGER, 11);
      await addUsers(Roles.COURIER, 10, { region_id: '5' } as Partial<User>);
      await addUsers(Roles.REGISTRATOR, 2);
      await addUsers(Roles.ADMIN, 1);
      // Ro'yxatga kirmaydiganlar: superadmin, mijoz, o'chirilgan.
      await addUsers(Roles.SUPERADMIN, 1);
      await addUsers(Roles.CUSTOMER, 2);
      await addUsers(Roles.MANAGER, 1, { isDeleted: true } as Partial<User>);
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
        await db.destroy();
      }
    });

    const metaOf = async (query: Record<string, unknown> = {}) =>
      ((await service.findAllAdmins(query as never)) as any).data.meta as {
        totalMarket: number;
        totalEmployees: number;
        totalUsers: number;
        countsByRole: Record<string, number>;
      };

    it('35 foydalanuvchi: totalMarket + totalEmployees === totalUsers (11 + 24 = 35)', async () => {
      const meta = await metaOf();
      expect(meta.totalUsers).toBe(35);
      expect(meta.totalMarket).toBe(11);
      expect(meta.totalEmployees).toBe(24);
      expect(meta.totalMarket + meta.totalEmployees).toBe(meta.totalUsers);
    });

    it('countsByRole barcha Roles enum qiymatlarini qamraydi', async () => {
      const meta = await metaOf();
      expect(Object.keys(meta.countsByRole).sort()).toEqual(
        Object.values(Roles).map(String).sort(),
      );
      expect(meta.countsByRole).toEqual(
        expect.objectContaining({
          [Roles.MARKET]: 11,
          [Roles.MANAGER]: 11,
          [Roles.COURIER]: 10,
          [Roles.REGISTRATOR]: 2,
          [Roles.ADMIN]: 1,
          [Roles.SUPERADMIN]: 0,
          [Roles.CUSTOMER]: 0,
        }),
      );
      const sum = Object.values(meta.countsByRole).reduce((a, b) => a + b, 0);
      expect(sum).toBe(meta.totalUsers);
    });

    it('yangi rollar (branch/investor/logist/operator/market_operator) qo‘shilganda ham invariant saqlanadi', async () => {
      await addUsers(Roles.BRANCH, 1);
      await addUsers(Roles.INVESTOR, 1);
      await addUsers(Roles.LOGIST, 1);
      await addUsers(Roles.OPERATOR, 1);
      await addUsers(Roles.MARKET_OPERATOR, 1);

      const meta = await metaOf();
      expect(meta.totalUsers).toBe(40);
      expect(meta.totalEmployees).toBe(29);
      expect(meta.totalMarket + meta.totalEmployees).toBe(meta.totalUsers);
      expect(meta.countsByRole[Roles.LOGIST]).toBe(1);
    });

    it('filtr (region_id) bilan ham invariant saqlanadi; role filtri kartalarni o‘zgartirmaydi', async () => {
      const byRegion = await metaOf({ region_id: '5' });
      expect(byRegion.totalUsers).toBe(10);
      expect(byRegion.totalEmployees).toBe(10);
      expect(byRegion.totalMarket + byRegion.totalEmployees).toBe(
        byRegion.totalUsers,
      );

      const all = await metaOf();
      const byRole = await metaOf({ role: Roles.MANAGER });
      expect(byRole.totalUsers).toBe(all.totalUsers);
      expect(byRole.totalEmployees).toBe(all.totalEmployees);
    });
  },
);
