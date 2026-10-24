import { of, throwError } from 'rxjs';
import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * kGIjOciz — GET /users/:id (gateway `include_branch`): `branch: { id, name }
 * | null` bilan birga `branch_id: string | null`. Ichki (flagsiz)
 * `identity.user.find_by_id` shakli o'zgarmagan — `branch_id` kaliti yo'q.
 */
type Row = Record<string, unknown>;

const userRow = (over: Row = {}): Row => ({
  id: '26',
  role: Roles.COURIER,
  name: 'TEST Claude Kuryer',
  phone_number: '+998887009102',
  status: Status.ACTIVE,
  isDeleted: false,
  region_id: '3',
  password: 'hash',
  refresh_token: 'rt',
  ...over,
});

function makeService(target: Row, branchReply: () => unknown) {
  const send = jest.fn((pattern: { cmd: string }) => {
    if (pattern.cmd === 'branch.user.find_by_user') {
      try {
        return of(branchReply());
      } catch (error: unknown) {
        return throwError(() => error);
      }
    }
    return of({ data: { id: '3', name: 'Andijon' } });
  });
  const service = Object.create(UserServiceService.prototype) as Row &
    UserServiceService;
  Object.assign(service, {
    users: { findOne: jest.fn(() => Promise.resolve({ ...target })) },
    branchClient: { send },
    logisticsClient: { send },
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
  });
  return { service, send };
}

const assignment = (branch: Row | null) => ({
  data: { id: '900', user_id: '26', branch_id: '15', branch },
});

describe('kGIjOciz — GET /users/:id branch_id', () => {
  it('⭐ kuryer: branch_id = branch.id', async () => {
    const { service } = makeService(userRow(), () =>
      assignment({ id: '15', name: 'Samarqand filiali' }),
    );

    const res = (await service.findUserById('26', {
      includeBranch: true,
    })) as { data: Row };

    expect(res.data.branch_id).toBe('15');
    expect(res.data.branch).toStrictEqual({
      id: '15',
      name: 'Samarqand filiali',
    });
  });

  it.each([
    ['biriktirilmagan', () => ({ data: null })],
    ['filial o`chirilgan', () => assignment(null)],
    [
      'filial xizmati xato',
      () => {
        throw new Error('timeout');
      },
    ],
  ])('%s — branch_id: null, branch: null', async (_label, reply) => {
    const { service } = makeService(userRow(), reply);

    const res = (await service.findUserById('26', {
      includeBranch: true,
    })) as { statusCode: number; data: Row };

    expect(res.statusCode).toBe(200);
    expect(res.data).toHaveProperty('branch_id', null);
    expect(res.data.branch).toBeNull();
  });

  it('filialsiz rol (market) — branch_id: null, filial so`ralmaydi', async () => {
    const { service, send } = makeService(
      userRow({ role: Roles.MARKET, region_id: null }),
      () => assignment({ id: '15', name: 'S' }),
    );

    const res = (await service.findUserById('26', {
      includeBranch: true,
    })) as { data: Row };

    expect(res.data).toHaveProperty('branch_id', null);
    expect(
      send.mock.calls.map(([p]: [{ cmd: string }]) => p.cmd),
    ).not.toContain('branch.user.find_by_user');
  });

  it('ichki chaqiruv (flagsiz) — branch_id kaliti yo`q', async () => {
    const { service } = makeService(userRow(), () =>
      assignment({ id: '15', name: 'S' }),
    );

    const res = (await service.findUserById('26')) as { data: Row };

    expect(res.data).not.toHaveProperty('branch_id');
    expect(res.data).not.toHaveProperty('branch');
  });
});
