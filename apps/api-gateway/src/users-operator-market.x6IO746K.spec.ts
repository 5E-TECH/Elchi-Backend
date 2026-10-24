import { Test, TestingModule } from '@nestjs/testing';
import { of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';

/**
 * x6IO746K — GET /users: market operatori qatoridagi `market: { id, name }`
 * identity'dan keladi; gateway uni (filial boyitishi bilan birga) o'zgarmay
 * uzatadi va market uchun qo'shimcha so'rov YUBORMAYDI (N+1 yo'q).
 */
type Row = Record<string, unknown>;
type Pattern = { cmd: string };

describe('x6IO746K — GET /users operator marketi gateway`da', () => {
  let controller: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let branchClient: { send: jest.Mock };

  beforeEach(async () => {
    identityClient = {
      send: jest.fn(() =>
        of({
          statusCode: 200,
          data: {
            items: [
              {
                id: '201',
                role: 'market_operator',
                market_id: '37',
                market: { id: '37', name: 'Baraka Shop' },
              },
              {
                id: '203',
                role: 'market_operator',
                market_id: '50',
                market: null,
              },
              { id: '26', role: 'courier' },
            ],
            meta: { page: 1, limit: 10, total: 3 },
          },
        }),
      ),
    };
    branchClient = { send: jest.fn(() => of({ data: [] })) };
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

  it('⭐ market o`zgarmay qaytadi; identity`ga bitta so`rov', async () => {
    const res = (await controller.getUsers(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
      '10',
      { user: { sub: '1', username: 'sa', roles: ['superadmin'] } } as never,
    )) as { data: { items: Row[] } };

    expect(res.data.items.map((row) => [row.id, row.market])).toEqual([
      ['201', { id: '37', name: 'Baraka Shop' }],
      ['203', null],
      ['26', undefined],
    ]);
    expect(identityClient.send).toHaveBeenCalledTimes(1);
    const calls = (identityClient.send.mock.calls as Array<[Pattern]>).concat(
      branchClient.send.mock.calls as Array<[Pattern]>,
    );
    const cmds = calls.map(([p]) => p.cmd);
    expect(cmds.filter((cmd) => cmd.includes('market'))).toEqual([]);
  });
});
