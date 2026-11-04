import { Test, TestingModule } from '@nestjs/testing';
import { of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';

/**
 * 2026-11-04 — GET /couriers fail-closed. Filialga biriktirilmagan
 * menejer / registrator / filial roli ilgari klient `branch_id` si bilan
 * istalgan filial kuryerlarini (yoki `branch_id` siz — BARCHA kuryerlarni,
 * menejerga kassa balanslari bilan) olardi. Endi: bo'sh sahifa (avvalgi
 * «kuryeri yo'q filial» shakli), identity / finance chaqirilmaydi.
 * Biriktirilgan so'rovchida klient `branch_id` e'tiborsiz — doim o'z filiali.
 * SUPERADMIN/ADMIN — `branch_id` filtri ishlaydi (o'zgarmagan).
 */
type Row = Record<string, unknown>;
type Pattern = { cmd: string };

describe('GET /couriers — biriktirilmagan so`rovchi: bo`sh sahifa (2026-11-04)', () => {
  let controller: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let branchClient: { send: jest.Mock };
  let financeClient: { send: jest.Mock };

  const branchReplies = (
    assignment: Row | null,
    usersByBranch: Record<string, Row[]> = {},
  ) =>
    branchClient.send.mockImplementation(
      ({ cmd }: Pattern, payload: { branch_id?: string }) => {
        if (cmd === 'branch.user.find_by_user') {
          return of({ data: assignment });
        }
        if (cmd === 'branch.user.find_by_branch') {
          return of({ data: usersByBranch[String(payload?.branch_id)] ?? [] });
        }
        return of({ data: null });
      },
    );

  beforeEach(async () => {
    identityClient = {
      send: jest.fn(() =>
        of({
          statusCode: 200,
          message: 'success',
          data: {
            items: [
              { id: '263', name: 'Filial 1 kuryeri', role: 'courier' },
              { id: '777', name: 'Filial 9 kuryeri', role: 'courier' },
            ],
            meta: { page: 1, limit: 10, total: 2, totalPages: 1 },
          },
        }),
      ),
    };
    branchClient = { send: jest.fn() };
    financeClient = {
      send: jest.fn(() => of({ data: { balance: 500000 } })),
    };
    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        { provide: 'IDENTITY', useValue: identityClient },
        { provide: 'FINANCE', useValue: financeClient },
        { provide: 'BRANCH', useValue: branchClient },
      ],
    }).compile();
    controller = app.get(ApiGatewayController);
  });

  const listCouriers = (
    user: Row,
    branchId?: string,
    page?: string,
    limit?: string,
  ) =>
    controller.getCouriers(
      undefined,
      undefined,
      undefined,
      undefined,
      branchId,
      page,
      limit,
      { user } as never,
    ) as Promise<{ data: { items: Row[]; meta: Row } }>;

  const branchCmds = () =>
    branchClient.send.mock.calls.map(([p]: [Pattern]) => p.cmd);

  it.each([['manager'], ['registrator'], ['branch']])(
    '⭐ %s, filialsiz, branch_id siz — BARCHA kuryerlar EMAS: bo`sh sahifa',
    async (role) => {
      branchReplies(null);

      const res = await listCouriers({ sub: '500', roles: [role] });

      expect(res.data).toEqual({
        items: [],
        meta: { page: 1, limit: 10, total: 0, totalPages: 1 },
      });
      expect(identityClient.send).not.toHaveBeenCalled();
      expect(financeClient.send).not.toHaveBeenCalled();
    },
  );

  it.each([['manager'], ['registrator']])(
    '⭐ %s, filialsiz — klient branch_id e`tiborsiz (begona filial kuryerlari chiqmaydi)',
    async (role) => {
      branchReplies(null, { '9': [{ user_id: '777', role: 'COURIER' }] });

      const res = await listCouriers({ sub: '500', roles: [role] }, '9');

      expect(res.data.items).toEqual([]);
      expect(res.data.meta.total).toBe(0);
      expect(branchCmds()).not.toContain('branch.user.find_by_branch');
      expect(identityClient.send).not.toHaveBeenCalled();
    },
  );

  it('bo`sh sahifa meta`si so`ralgan page/limit bilan (limit ≤ 100)', async () => {
    branchReplies(null);

    const res = await listCouriers(
      { sub: '500', roles: ['manager'] },
      undefined,
      '3',
      '500',
    );

    expect(res.data.meta).toEqual({
      page: 3,
      limit: 100,
      total: 0,
      totalPages: 1,
    });
  });

  it('tokenda `sub` yo`q — ko`lamsiz EMAS, bo`sh sahifa', async () => {
    branchReplies({ branch_id: '1' });

    const res = await listCouriers({ roles: ['manager'] }, '9');

    expect(res.data.items).toEqual([]);
    expect(branchClient.send).not.toHaveBeenCalled();
    expect(identityClient.send).not.toHaveBeenCalled();
  });

  it('biriktirilgan registrator klient branch_id=9 yuborsa ham — o`z filiali (1)', async () => {
    branchReplies(
      { branch_id: '1', role: 'REGISTRATOR' },
      {
        '1': [{ user_id: '263', role: 'COURIER' }],
        '9': [{ user_id: '777', role: 'COURIER' }],
      },
    );

    const res = await listCouriers({ sub: '500', roles: ['registrator'] }, '9');

    const branchCalls = branchClient.send.mock.calls.filter(
      ([p]: [Pattern]) => p.cmd === 'branch.user.find_by_branch',
    ) as Array<[Pattern, { branch_id: string }]>;
    expect(branchCalls.map(([, payload]) => payload.branch_id)).toEqual(
      expect.arrayContaining(['1']),
    );
    expect(branchCalls.map(([, payload]) => payload.branch_id)).not.toContain(
      '9',
    );
    const [, identityPayload] = identityClient.send.mock.calls[0] as [
      Pattern,
      { query: Row },
    ];
    expect(identityPayload.query.user_ids).toEqual(['263']);
    expect(res.data.items.map((row) => row.id)).toEqual(['263']);
  });

  it.each([['superadmin'], ['admin']])(
    '%s: branch_id filtri ishlaydi, filialga biriktirish so`ralmaydi',
    async (role) => {
      branchReplies(null, { '9': [{ user_id: '777', role: 'COURIER' }] });

      const res = await listCouriers({ sub: '1', roles: [role] }, '9');

      expect(branchCmds()).not.toContain('branch.user.find_by_user');
      expect(res.data.items.map((row) => row.id)).toEqual(['777']);
    },
  );

  it.each([['superadmin'], ['admin']])(
    '%s: branch_id siz — barcha kuryerlar (o`zgarmagan)',
    async (role) => {
      branchReplies(null);

      const res = await listCouriers({ sub: '1', roles: [role] });

      expect(branchClient.send).not.toHaveBeenCalled();
      expect(res.data.items.map((row) => row.id)).toEqual(['263', '777']);
    },
  );
});
