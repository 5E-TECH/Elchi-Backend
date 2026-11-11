import { DataSource, SelectQueryBuilder } from 'typeorm';
import { Roles } from '@app/common';
import { User } from './entities/user.entity';
import { UserServiceService } from './user-service.service';

/**
 * 2026-11-12 (Dilshod: «Qabul va aralash managerlar market yarata olsin va
 * o'zi yaratgan marketlarni foydalanuvchilar ro'yxatida ko'rib tursin»):
 * `branch_scope.market_owner_id` — filial a'zolari YOKI
 * `role = market AND created_by = market_owner_id`. Ro'yxat va countsByRole
 * bir xil shart bilan. Haqiqiy TypeORM (bazasiz) SQL'i tekshiriladi.
 */
type Captured = { kind: string; sql: string; params: unknown[] };

describe('2026-11-12 — menejer o`zi yaratgan marketlar (findAllAdmins SQL)', () => {
  let dataSource: DataSource;
  let captured: Captured[];

  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', entities: [User] });
    await (
      dataSource as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();
  });

  beforeEach(() => {
    captured = [];
    const capture = (kind: string, result: unknown) =>
      function (this: SelectQueryBuilder<User>) {
        const [sql, params] = this.getQueryAndParameters();
        captured.push({ kind, sql, params });
        return Promise.resolve(result);
      };
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getManyAndCount')
      .mockImplementation(capture('list', [[], 0]) as never);
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getRawMany')
      .mockImplementation(capture('counts', []) as never);
    jest
      .spyOn(SelectQueryBuilder.prototype, 'getMany')
      .mockImplementation(capture('many', []) as never);
  });

  afterEach(() => jest.restoreAllMocks());

  const makeService = () => {
    const noopClient = { send: jest.fn(), emit: jest.fn() };
    return new UserServiceService(
      dataSource.getRepository(User) as never,
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
  };

  const OWN_MARKET_SQL =
    /\("admin"\."role" = \$\d+ AND "admin"\."created_by" = \$\d+\)/;

  it('⭐ a`zolar OR o`zi yaratgan marketlar — ro`yxat va sonlarda bir xil', async () => {
    await makeService().findAllAdmins({
      branch_scope: { user_ids: ['101', '300'], market_owner_id: '25' },
    });

    for (const kind of ['list', 'counts']) {
      const { sql, params } = captured.find((c) => c.kind === kind)!;
      expect(sql).toMatch(
        /\("admin"\."id" IN \(\$\d+, \$\d+\) OR \("admin"\."role" = \$\d+ AND "admin"\."created_by" = \$\d+\)\)/,
      );
      expect(params).toEqual(
        expect.arrayContaining(['101', '300', Roles.MARKET, '25']),
      );
    }
  });

  it('?role=market — faqat o`zi yaratgan marketlar (a`zolar bilan OR, rol filtri AND)', async () => {
    await makeService().findAllAdmins({
      role: 'market',
      branch_scope: { user_ids: ['101'], market_owner_id: '25' },
    });

    const list = captured.find((c) => c.kind === 'list')!;
    expect(list.sql).toMatch(OWN_MARKET_SQL);
    expect(list.sql).toContain('"admin"."role" = $');
    expect(list.params).toEqual(expect.arrayContaining([Roles.MARKET, '25']));
  });

  it('⭐ filialda hech kim yo`q / biriktirilmagan — faqat o`zi yaratgan marketlar (1 = 0 emas)', async () => {
    await makeService().findAllAdmins({
      branch_scope: { user_ids: [], market_owner_id: '25' },
    });

    for (const kind of ['list', 'counts']) {
      const { sql } = captured.find((c) => c.kind === kind)!;
      expect(sql).toMatch(OWN_MARKET_SQL);
      expect(sql).not.toContain('1 = 0');
      expect(sql).not.toMatch(/"admin"\."id" IN/);
    }
  });

  it.each([["1' OR 1=1"], [''], ['abc'], [undefined]])(
    'market_owner_id = %p (raqam emas) — e`tiborsiz, eski qat`iy ko`lam',
    async (owner) => {
      await makeService().findAllAdmins({
        branch_scope: { user_ids: [], market_owner_id: owner as never },
      });

      const list = captured.find((c) => c.kind === 'list')!;
      expect(list.sql).toContain('1 = 0');
      expect(list.sql).not.toMatch(/"admin"\."created_by" = /);
      expect(list.params).not.toContain("1' OR 1=1");
    },
  );

  it('branch_scope yo`q (superadmin/admin) — shart yo`q', async () => {
    await makeService().findAllAdmins({});

    const list = captured.find((c) => c.kind === 'list')!;
    expect(list.sql).not.toMatch(/"admin"\."created_by" = /);
    expect(list.sql).not.toContain('1 = 0');
  });
});
