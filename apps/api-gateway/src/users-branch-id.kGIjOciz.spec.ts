import { Test, TestingModule } from '@nestjs/testing';
import { of, throwError } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';

/**
 * kGIjOciz — GET /users va GET /users/:id: filial `branch: { id, name } |
 * null` (YEThmZBn) bilan birga `branch_id: string | null` ham. Ro'yxatda
 * qiymat o'sha bitta `branch.user.find_by_user_ids` so'rovidan (N+1 yo'q);
 * filial xizmati ishlamasa — `branch_id: null`, ro'yxat 200.
 */
type Row = Record<string, unknown>;
type Pattern = { cmd: string };

const SUPERADMIN = {
  user: { sub: '1', username: 'sa', roles: ['superadmin'] },
};

const PAGE: Row[] = [
  { id: '26', name: 'TEST Claude Kuryer', role: 'courier' },
  { id: '25', name: 'Menejer', role: 'manager' },
  { id: '37', name: 'TEST Market', role: 'market' },
  { id: '28', name: 'Biriktirilmagan kuryer', role: 'courier' },
];

describe('kGIjOciz — GET /users qatorida branch_id', () => {
  let controller: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let branchClient: { send: jest.Mock };

  beforeEach(async () => {
    identityClient = {
      send: jest.fn(() =>
        of({
          statusCode: 200,
          data: {
            items: PAGE.map((row) => ({ ...row })),
            meta: { page: 1, limit: 10, total: PAGE.length },
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

  const listUsers = () =>
    controller.getUsers(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
      '10',
      SUPERADMIN as never,
    ) as Promise<{ statusCode: number; data: { items: Row[] } }>;

  it('⭐ har qatorda branch_id = branch.id; biriktirilmagan / boshqa rol — null', async () => {
    branchClient.send.mockReturnValue(
      of({
        statusCode: 200,
        data: [
          { user_id: '26', branch: { id: '15', name: 'Samarqand filiali' } },
          { user_id: '25', branch: { id: '1', name: 'Bosh ofis' } },
          { user_id: '28', branch: null },
        ],
      }),
    );

    const res = await listUsers();

    expect(
      res.data.items.map((row) => [row.id, row.branch_id, row.branch]),
    ).toEqual([
      ['26', '15', { id: '15', name: 'Samarqand filiali' }],
      ['25', '1', { id: '1', name: 'Bosh ofis' }],
      ['37', null, null],
      ['28', null, null],
    ]);
    // Bitta filial so'rovi — N+1 yo'q.
    expect(
      branchClient.send.mock.calls.filter(
        ([pattern]: [Pattern]) =>
          pattern.cmd === 'branch.user.find_by_user_ids',
      ),
    ).toHaveLength(1);
  });

  it('filial xizmati xato bersa — 200, hamma qatorda branch_id: null', async () => {
    branchClient.send.mockReturnValue(throwError(() => new Error('down')));

    const res = await listUsers();

    expect(res.statusCode).toBe(200);
    expect(res.data.items.every((row) => row.branch_id === null)).toBe(true);
    expect(res.data.items.every((row) => 'branch_id' in row)).toBe(true);
  });

  it('GET /users/:id — identity`ga include_branch bilan so`raladi (branch_id u yerda qo`shiladi)', async () => {
    identityClient.send.mockReturnValue(
      of({
        statusCode: 200,
        data: { id: '26', branch_id: '15', branch: { id: '15', name: 'S' } },
      }),
    );

    const res = (await controller.getUserById('26', SUPERADMIN as never)) as {
      data: Row;
    };

    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      { id: '26', include_branch: true },
    );
    expect(res.data.branch_id).toBe('15');
  });
});
