import { RpcException } from '@nestjs/microservices';
import { Roles } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * The admin/courier/market list filters feed `role` and `status` straight into
 * an enum column, so an unknown value used to reach Postgres as an invalid
 * enum literal (22P02) and surface as a 500. These cover the normalisation
 * that keeps a bad filter a 400 — and the legacy `marketing` alias the admin
 * panel still sends for market accounts.
 */
type QbCall = [string, Record<string, unknown> | undefined];

function makeService() {
  const calls: QbCall[] = [];
  const qb: Record<string, unknown> = {};
  const record =
    () =>
    (...args: unknown[]) => {
      calls.push([
        String(args[0]),
        args[1] as Record<string, unknown> | undefined,
      ]);
      return qb;
    };
  Object.assign(qb, {
    where: record(),
    andWhere: record(),
    orderBy: () => qb,
    skip: () => qb,
    take: () => qb,
    clone: () => qb,
    getManyAndCount: () => Promise.resolve([[], 0]),
    getCount: () => Promise.resolve(0),
  });

  const repo = { createQueryBuilder: jest.fn(() => qb) };
  const noopClient = { send: jest.fn(), emit: jest.fn() };
  const service = new UserServiceService(
    repo as never,
    noopClient as never, // search
    noopClient as never, // catalog
    noopClient as never, // order
    noopClient as never, // logistics
    noopClient as never, // finance
    noopClient as never, // branch
    { encrypt: jest.fn(), compare: jest.fn() } as never,
    { get: jest.fn() } as never,
    { log: jest.fn(), logChange: jest.fn() } as never,
  );
  return { service, repo, calls };
}

/** Extract the HTTP status code from a thrown RpcException's error payload. */
function statusOf(err: unknown): number | undefined {
  const payload = (err as RpcException)?.getError?.();
  return (payload as { statusCode?: number })?.statusCode;
}

describe('UserServiceService — list filter normalisation', () => {
  it('findAllAdmins: an unknown role is a 400 and never reaches the DB', async () => {
    const { service, repo } = makeService();
    await service
      .findAllAdmins({ role: 'not-a-role' })
      .then(() => {
        throw new Error('expected findAllAdmins to reject');
      })
      .catch((e) => expect(statusOf(e)).toBe(400));
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('findAllAdmins: an unknown status is a 400 and never reaches the DB', async () => {
    const { service, repo } = makeService();
    await service
      .findAllAdmins({ status: 'archived' })
      .then(() => {
        throw new Error('expected findAllAdmins to reject');
      })
      .catch((e) => expect(statusOf(e)).toBe(400));
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('findAllAdmins: the legacy "marketing" alias filters on the market role', async () => {
    const { service, calls } = makeService();
    await service.findAllAdmins({ role: 'marketing' });

    const roleFilter = calls.find(([sql]) => sql === 'admin.role = :role');
    expect(roleFilter?.[1]).toEqual({ role: Roles.MARKET });
  });

  it('findAllAdmins: a known role is passed through unchanged', async () => {
    const { service, calls } = makeService();
    await service.findAllAdmins({ role: Roles.COURIER });

    const roleFilter = calls.find(([sql]) => sql === 'admin.role = :role');
    expect(roleFilter?.[1]).toEqual({ role: Roles.COURIER });
  });
});
