import 'reflect-metadata';
import { RpcException } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import {
  BranchServiceService,
  USER_BRANCH_LOOKUP_MAX,
} from './branch-service.service';
import { BranchServiceController } from './branch-service.controller';

/**
 * YEThmZBn — `branch.user.find_by_user_ids` (GET /users «Filial» ustuni):
 * ruxsat, id'larni tozalash, bitta so'rov va javob shakli. SQL'ning o'zi —
 * `branch-service.user-branches.YEThmZBn.pg.spec.ts` (haqiqiy Postgres).
 */
type Row = Record<string, unknown>;

function makeService(rawRows: Row[] = []) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'leftJoin',
    'select',
    'addSelect',
    'distinctOn',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
  ]) {
    qb[method] = jest.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return qb;
    });
  }
  qb.getRawMany = jest.fn(() => Promise.resolve(rawRows));
  const createQueryBuilder = jest.fn(() => qb);
  const service = Object.create(
    BranchServiceService.prototype,
  ) as BranchServiceService;
  Object.assign(service, { branchUserRepo: { createQueryBuilder } });
  return { service, calls, createQueryBuilder, getRawMany: qb.getRawMany };
}

const rpcError = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as { statusCode?: number };
};

describe('YEThmZBn — findBranchesByUserIds', () => {
  it('⭐ bitta so`rov: so`ralgan har id uchun { user_id, branch }', async () => {
    const { service, createQueryBuilder, getRawMany, calls } = makeService([
      { user_id: '13', branch_id: 15, branch_name: 'Samarqand filiali' },
      { user_id: 21, branch_id: '7', branch_name: 'Andijon filiali' },
      // Eng so'nggi qatorining filiali o'chirilgan — branch null.
      { user_id: '41', branch_id: null, branch_name: null },
    ]);

    const res = await service.findBranchesByUserIds(['21', '13', '41', '99'], {
      id: '1',
      roles: ['superadmin'],
    });

    expect(createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(getRawMany).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual({
      method: 'where',
      args: [
        'bu.user_id = ANY(:userIds)',
        { userIds: ['21', '13', '41', '99'] },
      ],
    });
    expect(calls).toContainEqual({
      method: 'distinctOn',
      args: [['bu.user_id']],
    });
    expect(res).toEqual({
      statusCode: 200,
      message: 'User branches',
      data: [
        { user_id: '21', branch: { id: '7', name: 'Andijon filiali' } },
        { user_id: '13', branch: { id: '15', name: 'Samarqand filiali' } },
        { user_id: '41', branch: null },
        { user_id: '99', branch: null },
      ],
    });
  });

  it('takror va raqamli bo`lmagan id`lar tashlanadi, chegarasi bor', async () => {
    const { service, calls } = makeService();
    const many = Array.from({ length: USER_BRANCH_LOOKUP_MAX + 20 }, (_, i) =>
      String(i + 1),
    );

    await service.findBranchesByUserIds(
      ['5', 5, ' 5 ', 'abc', null, '-1', { id: 1 }, ...many],
      { id: '1', roles: ['admin'] },
    );

    const where = calls.find((c) => c.method === 'where');
    const userIds = (where?.args[1] as { userIds: string[] }).userIds;
    expect(userIds[0]).toBe('5');
    expect(userIds).toHaveLength(USER_BRANCH_LOOKUP_MAX);
    expect(new Set(userIds).size).toBe(userIds.length);
  });

  it('bo`sh / yaroqsiz ro`yxat — so`rov yo`q, bo`sh javob', async () => {
    const { service, createQueryBuilder } = makeService();

    for (const input of [[], ['abc'], undefined, 'not-array']) {
      await expect(
        service.findBranchesByUserIds(input, { id: '1', roles: ['admin'] }),
      ).resolves.toMatchObject({ statusCode: 200, data: [] });
    }
    expect(createQueryBuilder).not.toHaveBeenCalled();
  });

  it('menejer o`qiy oladi; kuryer / registrator / requester`siz — 403', async () => {
    const ok = makeService();
    await expect(
      ok.service.findBranchesByUserIds(['1'], { id: '25', roles: ['manager'] }),
    ).resolves.toMatchObject({ statusCode: 200 });

    for (const requester of [
      { id: '26', roles: ['courier'] },
      { id: '27', roles: ['registrator'] },
      undefined,
    ]) {
      const denied = makeService();
      const err = await rpcError(
        denied.service.findBranchesByUserIds(['1'], requester),
      );
      expect(err.statusCode).toBe(403);
      expect(denied.createQueryBuilder).not.toHaveBeenCalled();
    }
  });
});

describe('YEThmZBn — BranchServiceController branch.user.find_by_user_ids', () => {
  it('cmd metadata; user_ids va requester servisga uzatiladi, ack', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      BranchServiceController.prototype,
      'findBranchesByUserIds',
    );
    const handler = descriptor?.value as object;
    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([
      { cmd: 'branch.user.find_by_user_ids' },
    ]);

    const rmqService = { ack: jest.fn(), nackForError: jest.fn() };
    const branchService = {
      findBranchesByUserIds: jest
        .fn()
        .mockResolvedValue({ statusCode: 200, data: [] }),
    };
    const controller = new BranchServiceController(
      rmqService as never,
      branchService as never,
    );
    const context = {
      getPattern: () => 'branch.user.find_by_user_ids',
      getMessage: () => ({ fields: { redelivered: false } }),
      getChannelRef: () => ({ ack: jest.fn(), nack: jest.fn() }),
    };
    const requester = { id: '1', roles: ['superadmin'] };

    await controller.findBranchesByUserIds(
      { user_ids: ['13'], requester },
      context as never,
    );

    expect(branchService.findBranchesByUserIds).toHaveBeenCalledWith(
      ['13'],
      requester,
    );
    expect(rmqService.ack).toHaveBeenCalledWith(context);
  });
});
