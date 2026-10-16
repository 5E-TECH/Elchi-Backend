/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { RpcException } from '@nestjs/microservices';
import { from, of } from 'rxjs';
import { DataSource } from 'typeorm';
import { Branch } from './entities/branch.entity';
import { BranchUser } from './entities/branch-user.entity';
import { BranchConfig } from './entities/branch-config.entity';
import { BranchServiceService } from './branch-service.service';
import { OrderLookupService } from '../../order-service/src/lookup/order-lookup.service';

/**
 * 8jtzNlFt + cI5gqN90 — HAQIQIY Postgres (entity sinxron):
 *   - createBranch(partner, '5000') → numeric(14,2) ustunga yoziladi va
 *     findBranchById 5000 (son) qaytaradi; order-service `resolveBranchShare`
 *     shu javobdan 5000, OWNED filialdan 0 oladi;
 *   - employees_count — haqiqiy `branch_users` (In + isDeleted) so'rovi,
 *     detal jadvali (findUsersByBranch) bilan teng; created_at = createdAt.
 *
 * Faqat lokal test bazasida:
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

const ADMIN = { id: '1', roles: ['admin'] };

(localTestDatabase ? describe : describe.skip)(
  '8jtzNlFt + cI5gqN90 — branch-service haqiqiy Postgres',
  () => {
    let db: DataSource;
    let service: BranchServiceService;

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        entities: [Branch, BranchUser, BranchConfig],
        synchronize: false,
      });
      await db.initialize();
      await db.query('DROP TABLE IF EXISTS branch_users CASCADE');
      await db.query('DROP TABLE IF EXISTS branch_configs CASCADE');
      await db.query('DROP TABLE IF EXISTS branches CASCADE');
      await db.synchronize();
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
    }, 60_000);

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP TABLE IF EXISTS branch_users CASCADE');
        await db.query('DROP TABLE IF EXISTS branch_configs CASCADE');
        await db.query('DROP TABLE IF EXISTS branches CASCADE');
        await db.destroy();
      }
    });

    it('⭐ partner/5000 — Postgres numeric → GET 5000; resolveBranchShare 5000 / OWNED 0', async () => {
      const hq: any = await service.createBranch(
        { name: 'Bosh ofis', type: 'HQ', code: 'HQ' },
        ADMIN,
      );
      const partner: any = await service.createBranch(
        {
          name: 'Hamkor Samarqand',
          type: 'REGIONAL',
          code: 'SAM-P',
          parent_id: String(hq.data.id),
          ownership: 'partner',
          per_order_share: '5000',
        },
        ADMIN,
      );
      const owned: any = await service.createBranch(
        {
          name: 'Andijon',
          type: 'REGIONAL',
          code: 'AND',
          parent_id: String(hq.data.id),
        },
        ADMIN,
      );
      expect(partner.statusCode).toBe(201);

      const [raw] = await db.query(
        'SELECT ownership, per_order_share FROM branches WHERE id = $1',
        [partner.data.id],
      );
      expect(raw).toEqual({ ownership: 'partner', per_order_share: '5000.00' });

      const byId: any = await service.findBranchById(
        String(partner.data.id),
        ADMIN,
      );
      expect(byId.data).toMatchObject({
        ownership: 'partner',
        per_order_share: 5000,
      });

      const lookup = new OrderLookupService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
          send: (_pattern: unknown, payload: any) =>
            from(
              service
                .findBranchById(payload.id, payload.requester)
                .catch((error: unknown) => {
                  throw error instanceof RpcException
                    ? error.getError()
                    : error;
                }),
            ),
        } as never,
      );
      await expect(
        lookup.resolveBranchShare(String(partner.data.id)),
      ).resolves.toBe(5000);
      await expect(
        lookup.resolveBranchShare(String(owned.data.id)),
      ).resolves.toBe(0);
    });

    it('⭐ employees_count (haqiqiy SQL) = detal jadvali qatorlari; created_at = createdAt', async () => {
      const list0: any = await service.findAllBranches({ limit: 100 }, ADMIN);
      const andijon = list0.data.items.find((r: any) => r.code === 'AND');
      const repo = db.getRepository(BranchUser);
      for (const [userId, role, isDeleted] of [
        ['11', 'MANAGER', false],
        ['12', 'REGISTRATOR', false],
        ['13', 'COURIER', false],
        ['14', 'COURIER', true],
      ] as const) {
        await repo.save(
          repo.create({
            branch_id: String(andijon.id),
            user_id: userId,
            role: role as never,
            isDeleted,
          }),
        );
      }

      const list: any = await service.findAllBranches({ limit: 100 }, ADMIN);
      const row = list.data.items.find((r: any) => r.code === 'AND');
      expect(row.employees_count).toBe(3);
      expect(
        list.data.items.find((r: any) => r.code === 'SAM-P').employees_count,
      ).toBe(0);
      expect(row.created_at).toBeInstanceOf(Date);
      expect(row.created_at).toEqual(row.createdAt);

      const detail: any = await service.findBranchById(
        String(andijon.id),
        ADMIN,
      );
      const users: any = await service.findUsersByBranch(
        String(andijon.id),
        ADMIN,
      );
      expect(detail.data.employees_count).toBe(3);
      expect(users.data).toHaveLength(3);
    });
  },
);
