/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { of } from 'rxjs';
import { DataSource, Logger as TypeOrmLogger } from 'typeorm';
import { Branch } from './entities/branch.entity';
import { BranchUser } from './entities/branch-user.entity';
import { BranchConfig } from './entities/branch-config.entity';
import { BranchServiceService } from './branch-service.service';

/**
 * YEThmZBn — `branch.user.find_by_user_ids` HAQIQIY Postgres'da:
 *   - BITTA SQL (DISTINCT ON + `= ANY`), N+1 yo'q;
 *   - har foydalanuvchi uchun `findUserBranch` bilan AYNI natija (eng so'nggi
 *     faol qator; uning filiali o'chirilgan — null, eskisiga tushmaydi);
 *   - so'ralgan tartib, takror / raqamli bo'lmagan id'lar tashlanadi.
 *
 * Faqat lokal test bazasida (o'z sxemasida — boshqa pg speclar bilan
 * to'qnashmaydi):
 *   BRANCH_PG_TEST_URI=postgres://postgres@127.0.0.1:<port>/elchi_b_branch_test
 */
const uri = process.env.BRANCH_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname.endsWith('_test')
  );
})();

const SCHEMA = 'yethmzbn_user_branches';
const ADMIN = { id: '1', roles: ['admin'] };
const MANAGER = { id: '11', roles: ['manager'] };

(localTestDatabase ? describe : describe.skip)(
  'YEThmZBn — branch.user.find_by_user_ids (haqiqiy Postgres)',
  () => {
    let db: DataSource;
    let service: BranchServiceService;
    const queries: string[] = [];
    const ids: Record<string, string> = {};

    const queryLogger: TypeOrmLogger = {
      logQuery: (query: string) => {
        queries.push(query);
      },
      logQueryError: () => undefined,
      logQuerySlow: () => undefined,
      logSchemaBuild: () => undefined,
      logMigration: () => undefined,
      log: () => undefined,
    };

    beforeAll(async () => {
      const admin = new DataSource({ type: 'postgres', url: uri });
      await admin.initialize();
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
      await admin.destroy();

      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: SCHEMA,
        entities: [Branch, BranchUser, BranchConfig],
        synchronize: true,
        logging: ['query'],
        logger: queryLogger,
      });
      await db.initialize();
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

      const branches = db.getRepository(Branch);
      for (const [key, name, isDeleted] of [
        ['andijon', 'Andijon filiali', false],
        ['buxoro', 'Buxoro filiali', false],
        ['yopilgan', 'Yopilgan filial', true],
      ] as const) {
        const row: any = await branches.save(
          branches.create({
            name,
            type: 'REGIONAL',
            code: key.toUpperCase(),
            isDeleted,
          } as never),
        );
        ids[key] = String(row.id);
      }

      const at = (minute: number) =>
        new Date(`2026-10-01T08:${String(minute).padStart(2, '0')}:00Z`);
      const users = db.getRepository(BranchUser);
      for (const [userId, branch, role, minute, isDeleted] of [
        ['11', 'andijon', 'MANAGER', 1, false],
        ['13', 'andijon', 'COURIER', 2, false],
        // 21: avval Buxoro, keyin Andijon — eng so'nggisi (Andijon).
        ['21', 'buxoro', 'COURIER', 3, false],
        ['21', 'andijon', 'COURIER', 9, false],
        // 31: yagona qatori o'chirilgan — biriktirilmagan.
        ['31', 'andijon', 'COURIER', 4, true],
        // 41: eng so'nggi qatori o'chirilgan filialda — null (Buxoroga
        // "tushib ketmaydi", findUserBranch bilan bir xil).
        ['41', 'buxoro', 'COURIER', 5, false],
        ['41', 'yopilgan', 'COURIER', 8, false],
      ] as const) {
        await users.save(
          users.create({
            user_id: userId,
            branch_id: ids[branch],
            role,
            isDeleted,
            createdAt: at(minute),
          } as never),
        );
      }
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        await db.destroy();
      }
    });

    it('⭐ BITTA SQL bilan har foydalanuvchining filiali, so`ralgan tartibda', async () => {
      queries.length = 0;

      const res: any = await service.findBranchesByUserIds(
        ['99', '21', '11', '13', '31', '41', 'abc', 11, '21'],
        ADMIN,
      );

      expect(res.statusCode).toBe(200);
      expect(res.data).toEqual([
        { user_id: '99', branch: null },
        {
          user_id: '21',
          branch: { id: ids.andijon, name: 'Andijon filiali' },
        },
        {
          user_id: '11',
          branch: { id: ids.andijon, name: 'Andijon filiali' },
        },
        {
          user_id: '13',
          branch: { id: ids.andijon, name: 'Andijon filiali' },
        },
        { user_id: '31', branch: null },
        { user_id: '41', branch: null },
      ]);
      const reads = queries.filter((q) => q.includes('branch_users'));
      expect(reads).toHaveLength(1);
      expect(reads[0]).toContain('DISTINCT ON');
      expect(reads[0]).toContain('= ANY(');
    });

    it('har foydalanuvchi uchun findUserBranch bilan AYNI filial', async () => {
      const batch: any = await service.findBranchesByUserIds(
        ['11', '13', '21', '31', '41', '99'],
        ADMIN,
      );
      for (const row of batch.data) {
        const single: any = await service.findUserBranch(row.user_id, ADMIN);
        const branch = single.data?.branch ?? null;
        expect(row.branch).toEqual(
          branch ? { id: String(branch.id), name: branch.name } : null,
        );
      }
    });

    it('menejer ham o`qiy oladi (GET /users bilan bir xil rollar)', async () => {
      const res: any = await service.findBranchesByUserIds(['13'], MANAGER);
      expect(res.data).toEqual([
        { user_id: '13', branch: { id: ids.andijon, name: 'Andijon filiali' } },
      ]);
    });
  },
);
