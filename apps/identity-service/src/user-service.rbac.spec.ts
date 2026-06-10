import { RpcException } from '@nestjs/microservices';
import { Cashbox_type, Roles } from '@app/common';
import { UserServiceService } from './user-service.service';
import type { RequesterContext } from './contracts/user.payloads';

/**
 * Focused unit tests for the service-level RBAC guards added during the audit
 * (defense-in-depth alongside the gateway @Roles) and the manager↔courier
 * cashbox-type alignment. The guards run first, so a forbidden requester
 * short-circuits before any repository / RMQ call.
 */
function makeService() {
  const repo = {
    findOne: jest.fn(),
    create: jest.fn((value) => ({ id: 'created-user', ...value })),
    save: jest.fn(async (value) => ({ id: 'created-user', ...value })),
  };
  const noopClient = { send: jest.fn(), emit: jest.fn() };
  const bcrypt = { encrypt: jest.fn(), compare: jest.fn() };
  const config = { get: jest.fn() };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({
      items: [],
      meta: { page: 1, limit: 50, total: 0, totalPages: 1 },
    }),
    findByEntity: jest.fn().mockResolvedValue([]),
    findByUser: jest.fn().mockResolvedValue([]),
  };

  const service = new UserServiceService(
    repo as any,

    noopClient as any, // search

    noopClient as any, // catalog

    noopClient as any, // order

    noopClient as any, // logistics

    noopClient as any, // finance

    noopClient as any, // branch

    bcrypt as any,

    config as any,

    activityLog as any,
  );
  return { service, repo };
}

function requester(roles: string[]): RequesterContext {
  return { id: 'req-1', roles };
}

/** Extract the HTTP status code from a thrown RpcException's error payload. */
function statusOf(err: unknown): number | undefined {
  const payload = (err as RpcException)?.getError?.();
  return (payload as { statusCode?: number })?.statusCode;
}

describe('UserServiceService — role-create RBAC guards', () => {
  it('createCourier: a COURIER requester is forbidden (403) and never hits the DB', async () => {
    const { service, repo } = makeService();
    await expect(
      service.createCourier(
        { region_id: '1' } as never,
        requester(['courier']),
      ),
    ).rejects.toMatchObject({});
    await service
      .createCourier({ region_id: '1' } as never, requester(['courier']))
      .catch((e) => expect(statusOf(e)).toBe(403));
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('createCourier: a MANAGER requester passes the guard (allowed role)', async () => {
    const { service, repo } = makeService();
    // Manager is allowed → guard passes → flow proceeds to region validation
    // (logistics client). We only assert the guard did NOT throw 403.
    repo.findOne.mockResolvedValue(null);
    await service
      .createCourier({ region_id: '1' } as never, requester(['manager']))
      .catch((e) => expect(statusOf(e)).not.toBe(403));
  });

  it('createManager: a MANAGER requester is forbidden (only SUPERADMIN/ADMIN)', async () => {
    const { service, repo } = makeService();
    await service
      .createManager({} as never, requester(['manager']))
      .catch((e) => expect(statusOf(e)).toBe(403));
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('createManager: an ADMIN requester passes the guard', async () => {
    const { service, repo } = makeService();
    repo.findOne.mockResolvedValue(null);
    await service
      .createManager({} as never, requester(['admin']))
      .catch((e) => expect(statusOf(e)).not.toBe(403));
  });

  it('createMarket: a REGISTRATOR requester is forbidden', async () => {
    const { service, repo } = makeService();
    await service
      .createMarket({} as never, requester(['registrator']))
      .catch((e) => expect(statusOf(e)).toBe(403));
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('createMarket: an absent requester (trusted internal call) is allowed', async () => {
    const { service, repo } = makeService();
    repo.findOne.mockResolvedValue(null);
    await service
      .createMarket({ username: 'm', phone_number: '+998901112233' } as never)
      .catch((e) => expect(statusOf(e)).not.toBe(403));
    // Guard passed → uniqueness check ran.
    expect(repo.findOne).toHaveBeenCalled();
  });
});

describe('UserServiceService — roleToCashboxType', () => {
  it('maps only COURIER and MARKET to user cashboxes', () => {
    const { service } = makeService();

    const map = (role: Roles) => (service as any).roleToCashboxType(role);
    expect(map(Roles.MANAGER)).toBeNull();
    expect(map(Roles.COURIER)).toBe(Cashbox_type.FOR_COURIER);
    expect(map(Roles.MARKET)).toBe(Cashbox_type.FOR_MARKET);
    expect(map(Roles.ADMIN)).toBeNull();
  });
});
