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
 *
 * 2026-11-04: ko'lam QAT'IY — identity faqat `branch_scope.user_ids` ni
 * qaytaradi (har qanday rol; market/admin/boshqa filial xodimi yo'q).
 * Biriktirilmagan menejer: HQ'ga fallback ham, 403 ham yo'q — bo'sh ko'lam.
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

    // 2026-11-12: + o'zi yaratgan marketlar (`market_owner_id` = menejer id).
    expect(identityQuery().branch_scope).toEqual({
      user_ids: ['101', '25', '300'],
      market_owner_id: '25',
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
      branch_scope: { user_ids: ['101', '25'], market_owner_id: '25' },
    });
    expect(identityQuery().user_ids).toBeUndefined();
  });

  it('filialida hech kim yo`q — branch_scope bo`sh massiv (kuryer/filial chiqmaydi)', async () => {
    branchReplies({ branch_id: '3', role: 'MANAGER' }, []);

    await listUsers(MANAGER);

    expect(identityQuery().branch_scope).toEqual({
      user_ids: [],
      market_owner_id: '25',
    });
  });

  it('menejer ?role=market — ko`lam + o`zi yaratgan marketlar (2026-11-12)', async () => {
    branchReplies({ branch_id: '3', role: 'MANAGER' }, [
      { user_id: '101', role: 'COURIER' },
    ]);

    await listUsers(MANAGER, 'market');

    expect(identityQuery()).toMatchObject({
      role: 'market',
      branch_scope: { user_ids: ['101'], market_owner_id: '25' },
    });
  });

  it('⭐ biriktirilmagan menejer — HQ`ga fallback YO`Q, 403 emas: bo`sh ko`lam', async () => {
    branchReplies(null, [{ user_id: '7', role: 'COURIER' }], { id: '1' });

    const res = await listUsers(MANAGER);

    const cmds = branchClient.send.mock.calls.map(([p]: [Pattern]) => p.cmd);
    expect(cmds).not.toContain('branch.find_hq');
    expect(cmds).not.toContain('branch.user.find_by_branch');
    // Filial a'zolari yo'q; faqat o'zi yaratgan marketlar (2026-11-12).
    expect(identityQuery().branch_scope).toEqual({
      user_ids: [],
      market_owner_id: '25',
    });
    // Javob shakli identity'dan (bo'sh sahifa, meta va countsByRole bilan).
    expect(res.data).toHaveProperty('meta');
  });

  it('biriktirilmagan menejer va HQ yo`q — ham bo`sh ko`lam (avvalgi 403 emas)', async () => {
    branchReplies(null, [], null);

    await expect(listUsers(MANAGER)).resolves.toBeDefined();
    expect(identityQuery().branch_scope).toEqual({
      user_ids: [],
      market_owner_id: '25',
    });
  });

  it('menejer tokenida `sub` yo`q — ko`lamsiz EMAS, bo`sh ko`lam', async () => {
    branchReplies({ branch_id: '3', role: 'MANAGER' }, [
      { user_id: '101', role: 'COURIER' },
    ]);

    await listUsers({ user: { roles: ['manager'] } });

    const cmds = branchClient.send.mock.calls.map(([p]: [Pattern]) => p.cmd);
    expect(cmds).not.toContain('branch.user.find_by_user');
    expect(cmds).not.toContain('branch.user.find_by_branch');
    expect(identityQuery().branch_scope).toEqual({ user_ids: [] });
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

/**
 * 2026-11-04 — menejer faqat O'Z FILIALINING faol a'zosini boshqaradi:
 * PATCH /users/:id, POST /users/:id/password/resend-sms va GET
 * /users/:id/password/sms-status. Ilgari («fix #3») faqat identity'dagi
 * `created_by` tekshirilardi: menejer A filialida kuryer 263 ni yaratib,
 * admin uni B filialiga o'tkazgandan keyin ham GET /users/263 — 403, lekin
 * PATCH /users/263 {password} bilan parolni almashtirib, B filiali kuryeri
 * sifatida kira olardi (maosh, telefon, to'liq qator ham ochiq edi).
 */
describe('2026-11-04 — menejer tahrirlash / parol SMS: faqat o`z filiali a`zosi', () => {
  let controller: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let branchClient: { send: jest.Mock };

  const OWN_BRANCH_MEMBERS: Row[] = [
    { user_id: '25', role: 'MANAGER' },
    { user_id: '101', role: 'COURIER' },
    { user_id: '300', role: 'REGISTRATOR' },
  ];

  const branchReplies = (assignment: Row | null, branchUsers: Row[]) =>
    branchClient.send.mockImplementation(({ cmd }: Pattern) => {
      if (cmd === 'branch.user.find_by_user') return of({ data: assignment });
      if (cmd === 'branch.user.find_by_branch') {
        return of({ data: branchUsers });
      }
      return of({ data: [] });
    });

  beforeEach(async () => {
    identityClient = {
      send: jest.fn(() => of({ statusCode: 200, data: { id: 'ok' } })),
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

  const identityCmds = () =>
    identityClient.send.mock.calls.map(([p]: [Pattern]) => p.cmd);

  const routes: Array<[string, (id: string, req: Row) => Promise<unknown>]> = [
    [
      'PATCH /users/:id',
      (id, req) =>
        controller.updateUser(
          id,
          { password: 'Yangi-parol-123' },
          req as never,
        ),
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

  describe.each(routes)('%s', (_label, call) => {
    it('⭐ o`zi yaratgan, lekin boshqa filialga o`tkazilgan kuryer (263) — 403, identity`ga so`rov yo`q', async () => {
      branchReplies({ branch_id: '3', role: 'MANAGER' }, OWN_BRANCH_MEMBERS);

      await expect(call('263', MANAGER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(identityClient.send).not.toHaveBeenCalled();
      expect(branchClient.send).toHaveBeenCalledWith(
        { cmd: 'branch.user.find_by_branch' },
        expect.objectContaining({ branch_id: '3' }),
      );
    });

    it('o`z filiali kuryeri (101) — identity`ga uzatiladi (created_by qarori identity`da)', async () => {
      branchReplies({ branch_id: '3', role: 'MANAGER' }, OWN_BRANCH_MEMBERS);

      await call('101', MANAGER);

      expect(identityClient.send).toHaveBeenCalledTimes(1);
      expect(identityClient.send.mock.calls[0][1]).toMatchObject({
        id: '101',
        requester: { id: '25', roles: ['manager'] },
      });
    });

    it('filialga biriktirilmagan menejer — 403, identity`ga so`rov yo`q', async () => {
      branchReplies(null, []);

      await expect(call('101', MANAGER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(identityClient.send).not.toHaveBeenCalled();
      const cmds = branchClient.send.mock.calls.map(([p]: [Pattern]) => p.cmd);
      expect(cmds).not.toContain('branch.user.find_by_branch');
    });

    it.each([
      ['superadmin', SUPERADMIN],
      ['admin', ADMIN],
    ])(
      '%s — filial tekshiruvi yo`q, to`g`ridan-to`g`ri identity`ga',
      async (_l, req) => {
        await call('263', req);

        expect(branchClient.send).not.toHaveBeenCalled();
        expect(identityCmds()).toHaveLength(1);
      },
    );
  });

  it('menejer o`zini PATCH qiladi — filial tekshiruvisiz (identity allowSelf)', async () => {
    await controller.updateUser('25', { name: 'Shodiyor' }, MANAGER);

    expect(branchClient.send).not.toHaveBeenCalled();
    expect(identityCmds()).toEqual(['identity.user.update']);
  });
});
