import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';
import { BranchGatewayController } from './branch-gateway.controller';
import { ROLES_KEY } from './auth/roles.decorator';

/**
 * KQINMdeQ (ega, 2026-11-17) — menejer o'z filiali xodimlarini boshqaradi:
 * huquq nishonning HOZIRGI filiali bo'yicha (`branch_users`, har so'rovda),
 * `created_by` emas. Gateway qavati:
 *  - PATCH /users/:id, resend-sms, sms-status: filialdagi boshqa MENEJER —
 *    403, identity'ga so'rov ketmaydi; boshqa filial (IDOR) — 403;
 *    branch-service xatosi — 403 (500 emas);
 *  - GET /users/:id: filial a'zosi (boshqa menejer ham) ko'rinadi, IDOR —
 *    403; javobda `can_manage`;
 *  - GET /users: har qatorda `can_manage` (ro'yxat ko'lami o'zgarmagan);
 *  - menejerga yopiq amallar (@Roles) o'zgarmagan.
 */
type Row = Record<string, unknown>;
type Pattern = { cmd: string };

const MANAGER = { user: { sub: '25', username: 'mgr', roles: ['manager'] } };
const ADMIN = { user: { sub: '2', username: 'ad', roles: ['admin'] } };
const SUPERADMIN = {
  user: { sub: '1', username: 'sa', roles: ['superadmin'] },
};

/** Menejer 25 filiali (3) a'zolari: o'zi, boshqa menejer, kuryer, ro'yxatchi. */
const OWN_BRANCH_MEMBERS: Row[] = [
  { user_id: '25', role: 'MANAGER' },
  { user_id: '26', role: 'MANAGER' },
  { user_id: '101', role: 'COURIER' },
  { user_id: '300', role: 'REGISTRATOR' },
];

/** identity.user.find_by_id javobi — id bo'yicha. */
const USERS: Record<string, Row> = {
  '25': { id: '25', role: 'manager', created_by: '1' },
  '26': { id: '26', role: 'manager', created_by: '1' },
  '101': { id: '101', role: 'courier', created_by: '1' },
  '300': { id: '300', role: 'registrator', created_by: null },
  '500': { id: '500', role: 'courier', created_by: '25' },
  '700': { id: '700', role: 'market', created_by: '25' },
};

describe('KQINMdeQ — menejer huquqi hozirgi filial bo`yicha (gateway)', () => {
  let controller: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let branchClient: { send: jest.Mock };
  let listItems: Row[];

  const branchReplies = (
    assignment: Row | null,
    branchUsers: Row[] | (() => unknown),
  ) =>
    branchClient.send.mockImplementation(({ cmd }: Pattern) => {
      if (cmd === 'branch.user.find_by_user') return of({ data: assignment });
      if (cmd === 'branch.user.find_by_branch') {
        return typeof branchUsers === 'function'
          ? branchUsers()
          : of({ data: branchUsers });
      }
      return of({ data: [] });
    });

  beforeEach(async () => {
    listItems = [];
    identityClient = {
      send: jest.fn(({ cmd }: Pattern, payload: Row) => {
        if (cmd === 'identity.user.find_by_id') {
          return of({
            statusCode: 200,
            data: USERS[String(payload.id)] ?? null,
          });
        }
        if (cmd === 'identity.user.find_all') {
          return of({
            statusCode: 200,
            data: {
              items: listItems.map((row) => ({ ...row })),
              meta: { total: listItems.length },
            },
          });
        }
        return of({ statusCode: 200, data: { id: 'ok' } });
      }),
    };
    branchClient = { send: jest.fn() };
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: identityClient },
        { provide: 'FINANCE', useValue: { send: jest.fn() } },
        { provide: 'BRANCH', useValue: branchClient },
      ],
    }).compile();
    controller = app.get(ApiGatewayController);
    jest
      .spyOn(
        (controller as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
  });

  const identityWrites = () =>
    identityClient.send.mock.calls.filter(
      ([p]: [Pattern]) => p.cmd !== 'identity.user.find_by_id',
    );

  const mutations: Array<[string, (id: string, req: Row) => Promise<unknown>]> =
    [
      [
        'PATCH /users/:id',
        (id, req) =>
          controller.updateUser(id, { name: 'Yangi Ism' }, req as never),
      ],
      [
        'POST /users/:id/password/resend-sms',
        (id, req) => controller.resendTempPasswordSms(id, req as never),
      ],
      [
        'GET /users/:id/password/sms-status',
        (id, req) => controller.tempPasswordSmsStatus(id, req as never),
      ],
    ];

  describe.each(mutations)('%s', (_label, call) => {
    it('⭐ shu filialdagi boshqa menejer (26) — 403, identity`ga so`rov yo`q', async () => {
      branchReplies({ branch_id: '3' }, OWN_BRANCH_MEMBERS);

      await expect(call('26', MANAGER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(identityClient.send).not.toHaveBeenCalled();
    });

    it.each([['101'], ['300']])(
      '⭐ o`z filiali kuryeri / ro`yxatchisi (%s, admin yaratgan) — identity`ga uzatiladi',
      async (id) => {
        branchReplies({ branch_id: '3' }, OWN_BRANCH_MEMBERS);

        await call(id, MANAGER);

        expect(identityClient.send).toHaveBeenCalledTimes(1);
        expect(identityClient.send.mock.calls[0][1]).toMatchObject({
          id,
          requester: { id: '25', roles: ['manager'] },
        });
      },
    );

    it('⭐ IDOR: boshqa filial foydalanuvchisi (500) — 403, identity`ga so`rov yo`q', async () => {
      branchReplies({ branch_id: '3' }, OWN_BRANCH_MEMBERS);

      await expect(call('500', MANAGER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(identityClient.send).not.toHaveBeenCalled();
    });

    it.each([
      ['find_by_branch xatosi', () => throwError(() => new Error('timeout'))],
      ['find_by_branch data massiv emas', () => of({ data: null })],
    ])(
      '⭐ branch-service: %s — 403 (500 emas), identity`ga so`rov yo`q',
      async (_l, reply) => {
        branchReplies({ branch_id: '3' }, reply);

        await expect(call('101', MANAGER)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(identityClient.send).not.toHaveBeenCalled();
      },
    );

    it('branch-service: find_by_user xatosi — 403', async () => {
      branchClient.send.mockImplementation(() =>
        throwError(() => new Error('rabbit down')),
      );

      await expect(call('101', MANAGER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(identityClient.send).not.toHaveBeenCalled();
    });
  });

  describe('GET /users/:id', () => {
    const getUser = async (id: string, req: Row) =>
      ((await controller.getUserById(id, req)) as { data: Row }).data;

    it('⭐ admin yaratgan kuryer menejer filialida — ko`rinadi, can_manage: true', async () => {
      branchReplies({ branch_id: '3' }, OWN_BRANCH_MEMBERS);

      await expect(getUser('101', MANAGER)).resolves.toMatchObject({
        id: '101',
        can_manage: true,
      });
    });

    it('created_by = NULL ro`yxatchi — can_manage: true', async () => {
      branchReplies({ branch_id: '3' }, OWN_BRANCH_MEMBERS);

      await expect(getUser('300', MANAGER)).resolves.toMatchObject({
        id: '300',
        can_manage: true,
      });
    });

    it('⭐ shu filialdagi boshqa menejer — ko`rinadi, lekin can_manage: false', async () => {
      branchReplies({ branch_id: '3' }, OWN_BRANCH_MEMBERS);

      await expect(getUser('26', MANAGER)).resolves.toMatchObject({
        id: '26',
        can_manage: false,
      });
    });

    it('o`zi — can_manage: true (allowSelf)', async () => {
      branchReplies({ branch_id: '3' }, OWN_BRANCH_MEMBERS);

      await expect(getUser('25', MANAGER)).resolves.toMatchObject({
        id: '25',
        can_manage: true,
      });
    });

    it('⭐ IDOR / boshqa filialga o`tkazilgan (500, o`zi yaratgan) — 403', async () => {
      branchReplies({ branch_id: '3' }, OWN_BRANCH_MEMBERS);

      await expect(getUser('500', MANAGER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it.each([['PICKUP'], ['REGIONAL'], ['HYBRID'], [null]])(
      'filial turi %s — qoida bir xil (3-savol sukuti)',
      async (type) => {
        branchReplies(
          { branch_id: '3', branch: { id: '3', type } },
          OWN_BRANCH_MEMBERS,
        );

        await expect(getUser('101', MANAGER)).resolves.toMatchObject({
          id: '101',
          can_manage: true,
        });
      },
    );

    it('filialga biriktirilmagan menejer — 403', async () => {
      branchReplies(null, OWN_BRANCH_MEMBERS);

      await expect(getUser('101', MANAGER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('branch-service xatosi — 403 (500 emas)', async () => {
      branchReplies({ branch_id: '3' }, () =>
        throwError(() => new Error('timeout')),
      );

      await expect(getUser('101', MANAGER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it.each([
      ['superadmin → menejer', SUPERADMIN, '26', true],
      ['admin → kuryer', ADMIN, '101', true],
      ['admin → menejer', ADMIN, '26', true],
    ])('%s — can_manage: %s', async (_l, req, id, expected) => {
      branchClient.send.mockReturnValue(of({ data: [] }));

      await expect(getUser(id, req)).resolves.toMatchObject({
        can_manage: expected,
      });
    });

    it('admin → boshqa admin — can_manage: false', async () => {
      identityClient.send.mockImplementation(() =>
        of({ statusCode: 200, data: { id: '9', role: 'admin' } }),
      );

      await expect(getUser('9', ADMIN)).resolves.toMatchObject({
        can_manage: false,
      });
    });
  });

  describe('GET /users — har qatorda can_manage', () => {
    const listUsers = async (req: Row) =>
      (
        (await controller.getUsers(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          '1',
          '20',
          req as never,
        )) as { data: { items: Row[] } }
      ).data.items;

    const byId = (items: Row[]) =>
      Object.fromEntries(items.map((row) => [row.id, row.can_manage]));

    it('⭐ menejer: o`zi, filial kuryeri/ro`yxatchisi — true; boshqa menejer, o`zi yaratgan market — false', async () => {
      branchReplies({ branch_id: '3' }, OWN_BRANCH_MEMBERS);
      listItems = [
        USERS['25'],
        USERS['26'],
        USERS['101'],
        USERS['300'],
        USERS['700'],
      ];

      const items = await listUsers(MANAGER);

      expect(byId(items)).toEqual({
        '25': true,
        '26': false,
        '101': true,
        '300': true,
        '700': false,
      });
      // Ro'yxat ko'lami o'zgarmagan: filial a'zolari + o'zi yaratgan marketlar.
      const query = (
        identityClient.send.mock.calls.find(
          ([p]: [Pattern]) => p.cmd === 'identity.user.find_all',
        ) as [Pattern, { query: Row }]
      )[1].query;
      expect(query.branch_scope).toEqual({
        user_ids: ['25', '26', '101', '300'],
        market_owner_id: '25',
      });
    });

    it('identity filial a`zosi bo`lmagan kuryerni qaytarsa ham — can_manage: false', async () => {
      branchReplies({ branch_id: '3' }, OWN_BRANCH_MEMBERS);
      listItems = [USERS['500']];

      expect(byId(await listUsers(MANAGER))).toEqual({ '500': false });
    });

    it('admin: admin/superadmin — false, o`zi va qolganlar — true', async () => {
      branchClient.send.mockReturnValue(of({ data: [] }));
      listItems = [
        { id: '2', role: 'admin' },
        { id: '9', role: 'admin' },
        { id: '1', role: 'superadmin' },
        USERS['26'],
        USERS['101'],
        USERS['700'],
      ];

      expect(byId(await listUsers(ADMIN))).toEqual({
        '2': true,
        '9': false,
        '1': false,
        '26': true,
        '101': true,
        '700': true,
      });
    });

    it('superadmin — hammasi true', async () => {
      branchClient.send.mockReturnValue(of({ data: [] }));
      listItems = [{ id: '9', role: 'admin' }, USERS['26'], USERS['700']];

      expect(byId(await listUsers(SUPERADMIN))).toEqual({
        '9': true,
        '26': true,
        '700': true,
      });
    });
  });

  it('regressiya: menejerga yopiq amallar @Roles da o`zgarmagan', () => {
    const api = ApiGatewayController.prototype as unknown as Record<
      string,
      object
    >;
    const branch = BranchGatewayController.prototype as unknown as Record<
      string,
      object
    >;
    const rolesOf = (handler: object) =>
      Reflect.getMetadata(ROLES_KEY, handler) as string[];

    for (const handler of [
      'deleteUser',
      'updateUserStatus',
      'getCourierRegions',
      'setCourierRegions',
    ]) {
      expect(rolesOf(api[handler])).toEqual(['superadmin', 'admin']);
    }
    expect(rolesOf(api.changeUserRole)).toEqual(['superadmin']);
    for (const handler of [
      'assignUserToBranch',
      'removeUserFromBranch',
      'courierTransferCheck',
      'transferCourierBranch',
    ]) {
      expect(rolesOf(branch[handler])).toEqual(['superadmin', 'admin']);
    }
    // Menejer ochiq qolgan (filial qoidasi bilan) amallar.
    for (const handler of [
      'updateUser',
      'resendTempPasswordSms',
      'tempPasswordSmsStatus',
      'getUserById',
      'getUsers',
    ]) {
      expect(rolesOf(api[handler])).toContain('manager');
    }
    expect(identityWrites()).toHaveLength(0);
  });
});
