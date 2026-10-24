import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';

/**
 * 2CBnPAeg — menejerning GET /users ro'yxati: filial ko'lami endi identity
 * SO'ROVIDA (`query.branch_scope.user_ids`). Ilgari gateway sahifani olib,
 * keyin kuryer/filial qatorlarini olib tashlardi va `meta.total` /
 * `totalUsers` ni sahifada qolgan qatorlar soniga tenglardi (10 tadan 2 tasi
 * qolsa total = 2), `countsByRole` esa ko'lamsiz edi. Endi gateway identity
 * javobiga TEGMAYDI — total va countsByRole identity'dan, filial doirasida.
 */
type Row = Record<string, unknown>;
type Pattern = { cmd: string };

const MANAGER = { user: { sub: '25', username: 'mgr', roles: ['manager'] } };
const SUPERADMIN = {
  user: { sub: '1', username: 'sa', roles: ['superadmin'] },
};
const ADMIN = { user: { sub: '2', username: 'ad', roles: ['admin'] } };

const IDENTITY_META = {
  page: 1,
  limit: 2,
  total: 37,
  totalPages: 19,
  totalUsers: 37,
  totalMarket: 11,
  totalEmployees: 26,
  countsByRole: { courier: 3, manager: 11, market: 11 },
};

describe('2CBnPAeg — menejer ro`yxati: ko`lam identity so`rovida', () => {
  let controller: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let branchClient: { send: jest.Mock };

  const branchReplies = (
    assignment: Row | null,
    branchUsers: Row[],
    hq: Row | null = null,
  ) =>
    branchClient.send.mockImplementation(({ cmd }: Pattern) => {
      if (cmd === 'branch.user.find_by_user') return of({ data: assignment });
      if (cmd === 'branch.find_hq') return of({ data: hq });
      if (cmd === 'branch.user.find_by_branch') {
        return of({ data: branchUsers });
      }
      return of({ data: [] });
    });

  beforeEach(async () => {
    identityClient = {
      send: jest.fn(() =>
        of({
          statusCode: 200,
          data: {
            // Boshqa filial kuryeri (999) identity'dan kelsa ham gateway uni
            // endi olib tashlamaydi — ko'lam identity'ning ishi.
            items: [
              { id: '101', role: 'courier' },
              { id: '999', role: 'courier' },
            ],
            meta: { ...IDENTITY_META },
          },
        }),
      ),
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
  });

  const listUsers = (req: Row, role?: string) =>
    controller.getUsers(
      undefined,
      role,
      undefined,
      undefined,
      undefined,
      '1',
      '2',
      req as never,
    ) as Promise<{ data: { items: Row[]; meta: Row } }>;

  const identityQuery = () =>
    (identityClient.send.mock.calls[0] as [Pattern, { query: Row }])[1].query;

  it('⭐ menejer (rolsiz): branch_scope = filialga biriktirilgan BARCHA user_id; meta identity`dan o`zgarmay', async () => {
    branchReplies({ branch_id: '3', role: 'MANAGER' }, [
      { user_id: '101', role: 'COURIER' },
      { user_id: '25', role: 'MANAGER' },
      { user_id: '300', role: 'REGISTRATOR' },
      { user_id: '101', role: 'COURIER' },
    ]);

    const res = await listUsers(MANAGER);

    expect(identityQuery().branch_scope).toEqual({
      user_ids: ['101', '25', '300'],
    });
    expect(identityQuery()).not.toHaveProperty('user_ids');
    // Sahifadan keyingi filtr yo'q: total sahifa uzunligi (2) EMAS.
    expect(res.data.meta).toMatchObject({
      total: 37,
      totalUsers: 37,
      totalPages: 19,
      countsByRole: { courier: 3, manager: 11, market: 11 },
    });
    expect(res.data.items.map((row) => row.id)).toEqual(['101', '999']);
  });

  it('menejer ?role=courier — xuddi shu branch_scope (tab soni = ro`yxat)', async () => {
    branchReplies({ branch_id: '3', role: 'MANAGER' }, [
      { user_id: '101', role: 'COURIER' },
      { user_id: '25', role: 'MANAGER' },
    ]);

    await listUsers(MANAGER, 'courier');

    expect(identityQuery()).toMatchObject({
      role: 'courier',
      branch_scope: { user_ids: ['101', '25'] },
    });
    expect(identityQuery().user_ids).toBeUndefined();
  });

  it('filialida hech kim yo`q — branch_scope bo`sh massiv (kuryer/filial chiqmaydi)', async () => {
    branchReplies({ branch_id: '3', role: 'MANAGER' }, []);

    await listUsers(MANAGER);

    expect(identityQuery().branch_scope).toEqual({ user_ids: [] });
  });

  it('biriktirilmagan menejer — HQ filiali ko`lami', async () => {
    branchReplies(null, [{ user_id: '7', role: 'COURIER' }], { id: '1' });

    await listUsers(MANAGER);

    expect(branchClient.send).toHaveBeenCalledWith(
      { cmd: 'branch.user.find_by_branch' },
      expect.objectContaining({ branch_id: '1' }),
    );
    expect(identityQuery().branch_scope).toEqual({ user_ids: ['7'] });
  });

  it('biriktirilmagan menejer va HQ yo`q — 403 (avvalgidek), identity`ga so`rov yo`q', async () => {
    branchReplies(null, [], null);

    await expect(listUsers(MANAGER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(identityClient.send).not.toHaveBeenCalled();
  });

  it.each([
    ['superadmin', SUPERADMIN],
    ['admin', ADMIN],
  ])(
    '%s — ko`lam yo`q (branch_scope yo`q, filial so`rovi yo`q)',
    async (_l, req) => {
      branchClient.send.mockReturnValue(of({ data: [] }));

      const res = await listUsers(req);

      expect(identityQuery().branch_scope).toBeUndefined();
      const cmds = branchClient.send.mock.calls.map(([p]: [Pattern]) => p.cmd);
      expect(cmds).not.toContain('branch.user.find_by_branch');
      expect(res.data.meta.total).toBe(37);
    },
  );
});
