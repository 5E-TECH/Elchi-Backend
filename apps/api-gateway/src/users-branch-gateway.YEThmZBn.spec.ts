import { Test, TestingModule } from '@nestjs/testing';
import { NEVER, of, throwError } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';

/**
 * YEThmZBn — GET /users «Filial» ustuni: har qatorda `branch: { id, name } |
 * null`. Filial xizmatiga sahifadagi filial-rolli foydalanuvchilar uchun
 * BITTA so'rov (N+1 yo'q); xizmat ishlamasa ro'yxat yiqilmaydi (branch: null).
 */
type Row = Record<string, unknown>;
type Pattern = { cmd: string };

const SUPERADMIN = {
  user: { sub: '1', username: 'sa', roles: ['superadmin'] },
};

const PAGE: Row[] = [
  { id: '26', name: 'TEST Claude Kuryer', role: 'courier' },
  { id: '25', name: 'Menejer', role: 'manager' },
  { id: '27', name: 'Registrator', role: 'registrator' },
  { id: '37', name: 'TEST Market', role: 'market' },
  { id: '40', name: 'Admin', role: 'admin' },
  { id: '28', name: 'Biriktirilmagan kuryer', role: 'courier' },
];

describe('YEThmZBn — GET /users filial bilan boyitiladi', () => {
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

  const listUsers = (req: Row = SUPERADMIN) =>
    controller.getUsers(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
      '10',
      req as never,
    ) as Promise<{ statusCode: number; data: { items: Row[] } }>;

  const branchCalls = () =>
    branchClient.send.mock.calls.filter(
      ([pattern]: [Pattern]) => pattern.cmd === 'branch.user.find_by_user_ids',
    ) as Array<[Pattern, { user_ids: string[]; requester: Row }]>;

  it('⭐ bitta so`rov, faqat sahifadagi filial-rolli id`lar; har qatorda branch', async () => {
    branchClient.send.mockReturnValue(
      of({
        statusCode: 200,
        data: [
          { user_id: '26', branch: { id: '15', name: 'Samarqand filiali' } },
          { user_id: '25', branch: { id: '15', name: 'Samarqand filiali' } },
          { user_id: '27', branch: { id: '1', name: 'Bosh ofis' } },
          { user_id: '28', branch: null },
        ],
      }),
    );

    const res = await listUsers();

    expect(branchCalls()).toHaveLength(1);
    const [[, payload]] = branchCalls();
    expect(payload.user_ids).toEqual(['26', '25', '27', '28']);
    expect(payload.requester).toEqual({ id: '1', roles: ['superadmin'] });
    expect(res.statusCode).toBe(200);
    expect(
      res.data.items.map((row) => [
        row.id,
        'branch' in row ? row.branch : 'MISSING',
      ]),
    ).toEqual([
      ['26', { id: '15', name: 'Samarqand filiali' }],
      ['25', { id: '15', name: 'Samarqand filiali' }],
      ['27', { id: '1', name: 'Bosh ofis' }],
      ['37', null],
      ['40', null],
      ['28', null],
    ]);
  });

  it.each([
    ['xato (RpcException)', () => throwError(() => new Error('branch down'))],
    ['javobsiz qoladi (timeout)', () => NEVER],
    ['buzuq javob', () => of({ ok: true })],
  ])(
    'filial xizmati %s — ro`yxat 200, hamma qatorda branch: null',
    async (_label, reply) => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      try {
        branchClient.send.mockImplementation(reply);

        const pending = listUsers();
        await jest.advanceTimersByTimeAsync(5000);
        const res = await pending;

        expect(res.statusCode).toBe(200);
        expect(res.data.items).toHaveLength(PAGE.length);
        expect(res.data.items.every((row) => row.branch === null)).toBe(true);
        expect(branchCalls()).toHaveLength(1);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('sahifada filial-rolli foydalanuvchi yo`q — filial xizmatiga so`rov yo`q', async () => {
    identityClient.send.mockReturnValue(
      of({
        statusCode: 200,
        data: {
          items: [
            { id: '37', role: 'market' },
            { id: '40', role: 'admin' },
          ],
          meta: { page: 1, limit: 10, total: 2 },
        },
      }),
    );

    const res = await listUsers();

    expect(branchClient.send).not.toHaveBeenCalled();
    expect(res.data.items).toEqual([
      { id: '37', role: 'market', branch: null },
      { id: '40', role: 'admin', branch: null },
    ]);
  });

  it('identity so`rovi o`zgarmagan (ichki find_all shakli)', async () => {
    branchClient.send.mockReturnValue(of({ data: [] }));

    await listUsers();

    expect(identityClient.send).toHaveBeenCalledTimes(1);
    const [pattern, payload] = identityClient.send.mock.calls[0] as [
      Pattern,
      { query: Row },
    ];
    expect(pattern).toEqual({ cmd: 'identity.user.find_all' });
    expect(Object.keys(payload)).toEqual(['query']);
  });
});
