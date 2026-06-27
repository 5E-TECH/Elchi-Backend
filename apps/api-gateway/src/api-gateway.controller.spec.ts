import { Test, TestingModule } from '@nestjs/testing';
import { of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';

describe('ApiGatewayController', () => {
  let apiGatewayController: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let financeClient: { send: jest.Mock };
  let branchClient: { send: jest.Mock };

  beforeEach(async () => {
    identityClient = {
      send: jest.fn().mockReturnValue(of({ ok: true })),
    };
    financeClient = {
      send: jest.fn().mockReturnValue(of({ ok: true })),
    };
    branchClient = {
      send: jest.fn().mockReturnValue(of({ ok: true })),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [ApiGatewayController],
      providers: [
        {
          provide: 'IDENTITY',
          useValue: identityClient,
        },
        {
          provide: 'FINANCE',
          useValue: financeClient,
        },
        {
          provide: 'BRANCH',
          useValue: branchClient,
        },
      ],
    }).compile();

    apiGatewayController = app.get<ApiGatewayController>(ApiGatewayController);
  });

  it('should define controller', () => {
    expect(apiGatewayController).toBeDefined();
  });

  it('returns branch managers enriched with branch and branch cashbox info', async () => {
    identityClient.send.mockReturnValueOnce(
      of({
        data: {
          items: [{ id: '9', name: 'Asosiy filial manager', role: 'manager' }],
          meta: { total: 1, page: 1, limit: 10000, totalPages: 1 },
        },
      }),
    );
    branchClient.send.mockReturnValueOnce(
      of({
        data: {
          items: [
            {
              id: '16',
              name: 'Asosiy filial',
              manager_id: '9',
              olinishi_kerak: 24830000,
            },
          ],
        },
      }),
    );
    financeClient.send.mockReturnValueOnce(
      of({
        data: {
          id: 'cashbox-16',
          user_id: '16',
          cashbox_type: 'branch',
          balance: 0,
        },
      }),
    );

    const response = await apiGatewayController.getManagers(
      undefined,
      'active',
      undefined,
      '10000',
      { user: { sub: '1', username: 'admin', roles: ['admin'] } },
    );

    expect(identityClient.send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_all' },
      expect.objectContaining({
        query: expect.objectContaining({ role: 'manager', status: 'active' }),
      }),
    );
    expect(response.data.items).toEqual([
      expect.objectContaining({
        id: '9',
        role: 'manager',
        branch_id: '16',
        payable_to_hq: 24830000,
        berilishi_kerak: 24830000,
        branch: expect.objectContaining({ name: 'Asosiy filial' }),
        cashbox: expect.objectContaining({ user_id: '16' }),
      }),
    ]);
  });
});
