import { RpcException } from '@nestjs/microservices';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { User } from './entities/user.entity';
import { UserServiceService } from './user-service.service';

/**
 * yA31z7Rr — GET /users `telegram_linked` filtri server tomonda
 * (`identity.user.find_all`): true — `telegram_id` bor, false — yo'q;
 * javobdagi `telegram_linked` (`Boolean(telegram_id)`) bilan bir xil qoida
 * (bo'sh satr ham «ulanmagan»). Shart `baseQb` da — total ham, countsByRole
 * ham filtrdan keyin. Haqiqiy TypeORM SQL'i (bazasiz); semantika —
 * user-service.users-batch-a.pg.spec.ts.
 */
type Captured = { kind: string; sql: string; params: unknown[] };

describe('yA31z7Rr — findAllAdmins telegram_linked (SQL)', () => {
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

  it.each([
    [true, `COALESCE("admin"."telegram_id", '') <> ''`],
    ['true', `COALESCE("admin"."telegram_id", '') <> ''`],
    [false, `COALESCE("admin"."telegram_id", '') = ''`],
    ['false', `COALESCE("admin"."telegram_id", '') = ''`],
  ])(
    '⭐ telegram_linked=%p — ro`yxat va countsByRole SQL`ida: %s',
    async (value, fragment) => {
      await makeService().findAllAdmins({
        telegram_linked: value,
        role: 'courier',
        status: 'active',
      });

      expect(captured.map((c) => c.kind).sort()).toEqual(['counts', 'list']);
      for (const { sql } of captured) {
        expect(sql).toContain(fragment);
        // Boshqa filtrlar bilan AND.
        expect(sql).toContain('"admin"."status" = $');
      }
    },
  );

  it.each([undefined, null, ''])(
    'telegram_linked=%p — filtr yo`q',
    async (value) => {
      await makeService().findAllAdmins({ telegram_linked: value });
      expect(captured).toHaveLength(2);
      for (const { sql } of captured) {
        expect(sql).not.toContain('COALESCE("admin"."telegram_id"');
      }
    },
  );

  it.each(['yes', '1', 1, 'TRUE '])(
    'telegram_linked=%p — 400, bazaga so`rov yo`q',
    async (value) => {
      const error = await makeService()
        .findAllAdmins({ telegram_linked: value as never })
        .then(
          () => null,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(RpcException);
      expect(
        ((error as RpcException).getError() as { statusCode?: number })
          .statusCode,
      ).toBe(400);
      expect(captured).toHaveLength(0);
    },
  );

  it('2CBnPAeg menejer ko`lami bilan birga — ikkala shart ham', async () => {
    await makeService().findAllAdmins({
      telegram_linked: false,
      branch_scope: { user_ids: ['101'] },
    });
    for (const { sql } of captured) {
      expect(sql).toContain(`COALESCE("admin"."telegram_id", '') = ''`);
      expect(sql).toContain('"admin"."role" NOT IN (');
    }
  });
});
