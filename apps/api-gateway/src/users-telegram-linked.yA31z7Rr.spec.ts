import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';

/**
 * yA31z7Rr — GET /users?telegram_linked=true|false: gateway qiymatni
 * tekshiradi va `identity.user.find_all` ga boolean qilib uzatadi (filtr
 * identity SO'ROVIDA — sahifalash va meta.total to'g'ri). Noto'g'ri qiymat —
 * 400, identity'ga so'rov yo'q.
 */
type Row = Record<string, unknown>;
type Pattern = { cmd: string };

const SUPERADMIN = {
  user: { sub: '1', username: 'sa', roles: ['superadmin'] },
};
const MANAGER = { user: { sub: '25', username: 'mgr', roles: ['manager'] } };

describe('yA31z7Rr — GET /users telegram_linked', () => {
  let controller: ApiGatewayController;
  let identityClient: { send: jest.Mock };
  let branchClient: { send: jest.Mock };

  beforeEach(async () => {
    identityClient = {
      send: jest.fn(() =>
        of({
          statusCode: 200,
          data: { items: [], meta: { page: 1, limit: 10, total: 0 } },
        }),
      ),
    };
    branchClient = {
      send: jest.fn(({ cmd }: Pattern) => {
        if (cmd === 'branch.user.find_by_user') {
          return of({ data: { branch_id: '3', role: 'MANAGER' } });
        }
        if (cmd === 'branch.user.find_by_branch') {
          return of({ data: [{ user_id: '101', role: 'COURIER' }] });
        }
        return of({ data: [] });
      }),
    };
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

  const listUsers = (telegramLinked?: string, req: Row = SUPERADMIN) =>
    controller.getUsers(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '1',
      '10',
      req as never,
      telegramLinked,
    );

  const identityQuery = () =>
    (identityClient.send.mock.calls[0] as [Pattern, { query: Row }])[1].query;

  it.each([
    ['true', true],
    ['false', false],
    ['TRUE', true],
    [' False ', false],
  ])(
    '⭐ ?telegram_linked=%p → identity query.telegram_linked=%p',
    async (raw, expected) => {
      await listUsers(raw);
      expect(identityQuery().telegram_linked).toBe(expected);
    },
  );

  it.each([undefined, ''])('?telegram_linked=%p — filtr yo`q', async (raw) => {
    await listUsers(raw);
    expect(identityQuery().telegram_linked).toBeUndefined();
  });

  it.each(['yes', '1', 'linked'])(
    '?telegram_linked=%p — 400, identity`ga so`rov yo`q',
    async (raw) => {
      await expect(listUsers(raw)).rejects.toBeInstanceOf(BadRequestException);
      expect(identityClient.send).not.toHaveBeenCalled();
    },
  );

  it('menejer: telegram_linked va filial ko`lami birga identity so`rovida', async () => {
    await listUsers('false', MANAGER);
    expect(identityQuery()).toMatchObject({
      telegram_linked: false,
      branch_scope: { user_ids: ['101'] },
    });
  });
});
