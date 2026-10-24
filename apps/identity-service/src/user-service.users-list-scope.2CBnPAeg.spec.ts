import { DataSource, SelectQueryBuilder } from 'typeorm';
import { Roles } from '@app/common';
import { User } from './entities/user.entity';
import { UserServiceService } from './user-service.service';

/**
 * 2CBnPAeg — menejer ko'lami `identity.user.find_all` SO'ROVIDA
 * (`query.branch_scope.user_ids`): kuryer / filial roli faqat menejer
 * filialiga biriktirilganlar, boshqa rollar cheklanmaydi. Shart `baseQb` da —
 * ro'yxat SQL'i ham, `countsByRole` (GROUP BY) SQL'i ham bir xil doirada.
 * Haqiqiy TypeORM (bazasiz, faqat metadata) SQL'i tekshiriladi; semantika —
 * user-service.users-batch-a.pg.spec.ts (haqiqiy Postgres).
 */
type Captured = { kind: string; sql: string; params: unknown[] };

describe('2CBnPAeg — findAllAdmins branch_scope (SQL)', () => {
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

  const SCOPE_SQL =
    /\("admin"\."role" NOT IN \(\$\d+, \$\d+\) OR "admin"\."id" IN \(\$\d+, \$\d+\)\)/;

  it('⭐ ro`yxat va countsByRole SQL`i bir xil ko`lam sharti bilan', async () => {
    await makeService().findAllAdmins({
      role: 'courier',
      branch_scope: { user_ids: ['101', '300'] },
    });

    const list = captured.find((c) => c.kind === 'list')!;
    const counts = captured.find((c) => c.kind === 'counts')!;
    expect(list.sql).toMatch(SCOPE_SQL);
    expect(counts.sql).toMatch(SCOPE_SQL);
    expect(counts.sql).toContain('GROUP BY "admin"."role"');
    // Rol filtri faqat ro'yxatda (tab sonlari barcha rollar uchun).
    expect(list.sql).toContain('"admin"."role" = $');
    expect(counts.sql).not.toMatch(/"admin"\."role" = \$/);
    for (const { params } of [list, counts]) {
      expect(params).toEqual(
        expect.arrayContaining([Roles.COURIER, Roles.BRANCH, '101', '300']),
      );
    }
  });

  it('filialda hech kim yo`q — faqat NOT IN (kuryer/filial umuman chiqmaydi)', async () => {
    await makeService().findAllAdmins({ branch_scope: { user_ids: [] } });

    for (const kind of ['list', 'counts']) {
      const { sql } = captured.find((c) => c.kind === kind)!;
      expect(sql).toMatch(/"admin"\."role" NOT IN \(\$\d+, \$\d+\)/);
      expect(sql).not.toMatch(/"admin"\."id" IN/);
    }
  });

  it('raqam bo`lmagan id`lar tashlanadi (SQL`ga yetmaydi)', async () => {
    await makeService().findAllAdmins({
      branch_scope: { user_ids: ['101', "1' OR 1=1", '', 'abc'] },
    });

    const list = captured.find((c) => c.kind === 'list')!;
    expect(list.sql).toMatch(/"admin"\."id" IN \(\$\d+\)\)/);
    expect(list.params).toContain('101');
    expect(list.params).not.toContain("1' OR 1=1");
  });

  it('branch_scope yo`q (superadmin/admin, ichki chaqiruvlar) — shart yo`q', async () => {
    await makeService().findAllAdmins({ role: 'courier' });

    for (const { sql } of captured) {
      expect(sql).not.toContain('NOT IN');
    }
  });
});
