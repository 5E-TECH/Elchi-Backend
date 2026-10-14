import { RpcException } from '@nestjs/microservices';
import type { RmqContext } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Roles } from '@app/common';
import { LogisticsServiceController } from './logistics-service.controller';
import { LogisticsServiceService } from './logistics-service.service';
import type { DistrictResolverService } from './district-resolver/district-resolver.service';

/**
 * YfrqN70i + kA70Rban — pochta ro'yxati filtrlari va limit shifti (unit,
 * bazasiz). Haqiqiy SQL natijasi — *.post-list-filters.pg.spec.ts.
 */
type FindAndCountArgs = {
  where: Record<string, unknown> | Record<string, unknown>[];
  skip: number;
  take: number;
};

const superadmin = { id: '1', roles: [Roles.SUPERADMIN] };

const build = () => {
  const postRepo = {
    findAndCount: jest.fn(
      (): Promise<[unknown[], number]> => Promise.resolve([[], 0]),
    ),
    find: jest.fn(() => Promise.resolve([])),
  };
  const branchClient = { send: jest.fn(() => of({ data: { id: '1' } })) };
  const service = new LogisticsServiceService(
    postRepo as never,
    {} as never,
    {} as never,
    { send: jest.fn(() => of({ data: [] })) } as never,
    branchClient as never,
    { send: jest.fn(() => of({})) } as never,
    { send: jest.fn(() => of({})) } as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never,
  );
  const lastArgs = () =>
    (
      postRepo.findAndCount.mock.calls.at(-1) as unknown as [FindAndCountArgs]
    )[0];
  return { service, postRepo, lastArgs };
};

const operatorValue = (value: unknown) =>
  (value as { _type: string; _value: unknown })?._type
    ? {
        type: (value as { _type: string })._type,
        value: (value as { _value: unknown })._value,
      }
    : value;

const rpcStatus = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
  }
  throw new Error('RpcException kutilgan edi');
};

describe('YfrqN70i — findAllPosts filtrlari where ga yetadi', () => {
  it("region_id/courier_id/sana/has_orders — superadmin'ning ikkala OR tarmog'iga ham", async () => {
    const { service, lastArgs } = build();
    await service.findAllPosts(
      1,
      20,
      {
        region_id: '05',
        courier_id: '119',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        has_orders: 'true',
      },
      superadmin,
    );
    const where = lastArgs().where as Record<string, unknown>[];
    expect(Array.isArray(where)).toBe(true);
    expect(where).toHaveLength(2);
    for (const clause of where) {
      expect(clause.region_id).toBe('5');
      expect(clause.courier_id).toBe('119');
      // Toshkent kuni: 1-avgust 00:00 (+05) .. 31-avgust 23:59:59.999 (+05).
      expect(operatorValue(clause.createdAt)).toEqual({
        type: 'between',
        value: [
          new Date('2026-07-31T19:00:00.000Z'),
          new Date('2026-08-31T18:59:59.999Z'),
        ],
      });
      expect(operatorValue(clause.order_quantity)).toEqual({
        type: 'moreThan',
        value: 0,
      });
    }
  });

  it('faqat startDate → MoreThanOrEqual, faqat endDate → LessThanOrEqual', async () => {
    const { service, lastArgs } = build();
    await service.findAllPosts(
      1,
      8,
      { status: 'received', startDate: '2026-08-01' },
      superadmin,
    );
    expect(
      operatorValue((lastArgs().where as Record<string, unknown>).createdAt),
    ).toEqual({
      type: 'moreThanOrEqual',
      value: new Date('2026-07-31T19:00:00.000Z'),
    });
    await service.findAllPosts(
      1,
      8,
      { status: 'received', endDate: '2026-08-31' },
      superadmin,
    );
    expect(
      operatorValue((lastArgs().where as Record<string, unknown>).createdAt),
    ).toEqual({
      type: 'lessThanOrEqual',
      value: new Date('2026-08-31T18:59:59.999Z'),
    });
  });

  it("raqam bo'lmagan region_id (UUID) → bazaga so'rovsiz bo'sh sahifa", async () => {
    const { service, postRepo } = build();
    const res = await service.findAllPosts(
      1,
      5,
      { region_id: '99999999-9999-9999-9999-999999999999' },
      superadmin,
    );
    expect(postRepo.findAndCount).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({ data: [], total: 0, totalPages: 1 });
  });

  it.each([
    [{ startDate: 'abc' }, "startDate noto'g'ri (YYYY-MM-DD kutiladi)"],
    [{ endDate: '2026-13-45' }, "endDate noto'g'ri (YYYY-MM-DD kutiladi)"],
    [
      { startDate: '2026-09-01', endDate: '2026-08-01' },
      "startDate endDate dan keyin bo'lmasligi kerak",
    ],
  ])('yaroqsiz sana %j → 400', async (filters, message) => {
    const { service, postRepo } = build();
    const error = await rpcStatus(
      service.findAllPosts(1, 8, filters, superadmin),
    );
    expect(error).toMatchObject({ statusCode: 400, message });
    expect(postRepo.findAndCount).not.toHaveBeenCalled();
  });
});

describe('kA70Rban — limit shifti jimgina emas', () => {
  it('limit=10000 → take 100, javobda limit 100 + limit_capped: true', async () => {
    const { service, postRepo, lastArgs } = build();
    postRepo.findAndCount.mockResolvedValueOnce([[], 150]);
    const res = await service.findAllPosts(1, 10000, {}, superadmin);
    expect(lastArgs()).toMatchObject({ take: 100, skip: 0 });
    expect(res.data).toMatchObject({
      limit: 100,
      limit_capped: true,
      max_limit: 100,
      total: 150,
      totalPages: 2,
    });
  });

  it('page=2, limit=100 → skip 100 (101-200), limit_capped: false', async () => {
    const { service, postRepo, lastArgs } = build();
    postRepo.findAndCount.mockResolvedValueOnce([[], 150]);
    const res = await service.findAllPosts(2, 100, {}, superadmin);
    expect(lastArgs()).toMatchObject({ take: 100, skip: 100 });
    expect(res.data).toMatchObject({
      page: 2,
      limit: 100,
      limit_capped: false,
      totalPages: 2,
    });
  });

  it("NaN limit/page → standart 8 / 1 (avval take NaN bo'lardi)", async () => {
    const { service, lastArgs } = build();
    await service.findAllPosts(Number('x'), Number('y'), {}, superadmin);
    expect(lastArgs()).toMatchObject({ take: 8, skip: 0 });
  });

  it('kuryer eski va barcha pochtalari ham limit_capped qaytaradi', async () => {
    const { service, lastArgs } = build();
    const courier = { id: '119', roles: [Roles.COURIER] };
    const old = await service.oldPostsForCourier(1, 500, courier);
    expect(lastArgs()).toMatchObject({ take: 100 });
    expect(old.data).toMatchObject({ limit: 100, limit_capped: true });
    const mine = await service.myPostsForCourier(1, 20, courier);
    expect(mine.data).toMatchObject({ limit: 20, limit_capped: false });
  });

  it("kuryer eski pochtalari: courier_id doim JWT, eski bo'lmagan status → bo'sh", async () => {
    const { service, postRepo, lastArgs } = build();
    const courier = { id: '119', roles: [Roles.COURIER] };
    await service.oldPostsForCourier(1, 8, courier, {
      region_id: '3',
      status: 'canceled',
    });
    expect(lastArgs().where).toMatchObject({
      courier_id: '119',
      region_id: '3',
      status: 'canceled',
    });
    postRepo.findAndCount.mockClear();
    const sent = await service.oldPostsForCourier(1, 8, courier, {
      status: 'sent',
    });
    expect(postRepo.findAndCount).not.toHaveBeenCalled();
    expect(sent.data).toMatchObject({ total: 0, data: [] });
  });
});

describe('YfrqN70i — RMQ controller filtrlarni servisga uzatadi', () => {
  const context = {
    getChannelRef: () => ({ ack: jest.fn() }),
    getMessage: () => ({}),
  } as unknown as RmqContext;

  it('logistics.post.find_all va old_for_courier', async () => {
    const service = {
      findAllPosts: jest.fn().mockResolvedValue({ ok: true }),
      oldPostsForCourier: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new LogisticsServiceController(
      { ack: jest.fn() } as never,
      service as unknown as LogisticsServiceService,
      {} as DistrictResolverService,
    );
    await controller.findAllPosts(
      {
        query: {
          page: 1,
          limit: 8,
          region_id: '3',
          courier_id: '119',
          startDate: '2026-08-01',
          endDate: '2026-08-31',
          has_orders: 'true',
        },
        requester: { id: '1', roles: ['superadmin'] },
      },
      context,
    );
    expect(service.findAllPosts).toHaveBeenCalledWith(
      1,
      8,
      {
        branch_id: undefined,
        status: undefined,
        region_id: '3',
        courier_id: '119',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        has_orders: 'true',
      },
      { id: '1', roles: ['superadmin'] },
    );

    await controller.oldPostsForCourier(
      {
        page: 2,
        limit: 8,
        region_id: '3',
        status: 'received',
        startDate: '2026-08-01',
        requester: { id: '119', roles: ['courier'] },
      },
      context,
    );
    expect(service.oldPostsForCourier).toHaveBeenCalledWith(
      2,
      8,
      { id: '119', roles: ['courier'] },
      {
        region_id: '3',
        status: 'received',
        startDate: '2026-08-01',
        endDate: undefined,
        has_orders: undefined,
      },
    );
  });
});
