import { DataSource, Repository } from 'typeorm';
import { Roles, Status } from '@app/common';
import { User } from './entities/user.entity';
import { UserServiceService } from './user-service.service';

/**
 * Foydalanuvchilar paketi (batch A, 2026-10-24) — haqiqiy Postgres:
 *   - 2CBnPAeg: menejer ko'lami (`branch_scope`) so'rovda — total va
 *     countsByRole filial doirasida, sahifalashdan oldin.
 *
 * Ishga tushirish (lokal, `_test` bilan tugaydigan baza):
 *   IDENTITY_USERS_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_users_a_test
 */
const uri = process.env.IDENTITY_USERS_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();

type Meta = {
  total: number;
  totalPages: number;
  totalUsers: number;
  countsByRole: Record<string, number>;
};

(localTestDatabase ? describe : describe.skip)(
  'Foydalanuvchilar paketi (batch A) — findAllAdmins (Postgres)',
  () => {
    let db: DataSource;
    let repo: Repository<User>;
    let service: UserServiceService;
    let seq = 0;

    const add = async (role: Roles, extra: Partial<User> = {}) => {
      seq += 1;
      const row = await repo.save(
        repo.create({
          name: `${role}-${seq}`,
          phone_number: `+99891${String(seq).padStart(7, '0')}`,
          username: `a${seq}`,
          password: 'x',
          role,
          status: Status.ACTIVE,
          ...extra,
        }),
      );
      return String(row.id);
    };

    // 2CBnPAeg: menejer filiali — 3 kuryer + 1 filial akkaunti; boshqa
    // filialda — 4 kuryer + 1 filial akkaunti; ko'lamsiz rollar: 2 menejer,
    // 2 market.
    const scoped: string[] = [];
    const outOfScope: string[] = [];

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

      for (let i = 0; i < 3; i += 1) scoped.push(await add(Roles.COURIER));
      scoped.push(await add(Roles.BRANCH));
      for (let i = 0; i < 4; i += 1) outOfScope.push(await add(Roles.COURIER));
      outOfScope.push(await add(Roles.BRANCH));
      const managerIds = [await add(Roles.MANAGER), await add(Roles.MANAGER)];
      scoped.push(managerIds[0]);
      await add(Roles.MARKET);
      await add(Roles.MARKET);
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS identity_schema CASCADE');
        await db.destroy();
      }
    });

    const list = async (query: Record<string, unknown>) =>
      (
        (await service.findAllAdmins(query as never)) as unknown as {
          data: { items: User[]; meta: Meta };
        }
      ).data;

    describe('2CBnPAeg — menejer ko`lami so`rovda', () => {
      it('⭐ rolsiz, limit 2: total/totalUsers — butun ko`lam (sahifa emas)', async () => {
        const res = await list({
          branch_scope: { user_ids: scoped },
          page: 1,
          limit: 2,
        });

        // 3 kuryer + 1 filial + 2 menejer + 2 market = 8.
        expect(res.items).toHaveLength(2);
        expect(res.meta.total).toBe(8);
        expect(res.meta.totalUsers).toBe(8);
        expect(res.meta.totalPages).toBe(4);
        expect(res.meta.countsByRole).toMatchObject({
          [Roles.COURIER]: 3,
          [Roles.BRANCH]: 1,
          [Roles.MANAGER]: 2,
          [Roles.MARKET]: 2,
        });
      });

      it('?role=courier: faqat filial kuryerlari; tab soni = ro`yxat total', async () => {
        const res = await list({
          role: 'courier',
          branch_scope: { user_ids: scoped },
          limit: 100,
        });

        expect(res.items.map((u) => String(u.id)).sort()).toEqual(
          scoped.slice(0, 3).sort(),
        );
        expect(res.meta.total).toBe(3);
        expect(res.meta.countsByRole[Roles.COURIER]).toBe(res.meta.total);
        // Boshqa tablar ham shu doirada.
        expect(res.meta.countsByRole[Roles.MANAGER]).toBe(2);
        expect(res.items.some((u) => outOfScope.includes(String(u.id)))).toBe(
          false,
        );
      });

      it('?role=branch ham ko`lamda (ilgari gateway filtrlamasdi)', async () => {
        const res = await list({
          role: 'branch',
          branch_scope: { user_ids: scoped },
        });
        expect(res.items.map((u) => String(u.id))).toEqual([scoped[3]]);
        expect(res.meta.total).toBe(1);
      });

      it('bo`sh ko`lam — kuryer/filial 0, qolganlar to`liq', async () => {
        const res = await list({ branch_scope: { user_ids: [] } });
        expect(res.meta.countsByRole[Roles.COURIER]).toBe(0);
        expect(res.meta.countsByRole[Roles.BRANCH]).toBe(0);
        expect(res.meta.total).toBe(4);
      });

      it('ko`lamsiz (superadmin) — hammasi: 7 kuryer, 2 filial', async () => {
        const res = await list({});
        expect(res.meta.countsByRole[Roles.COURIER]).toBe(7);
        expect(res.meta.countsByRole[Roles.BRANCH]).toBe(2);
        expect(res.meta.total).toBe(13);
      });
    });
  },
);
