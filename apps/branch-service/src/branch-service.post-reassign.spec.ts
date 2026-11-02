import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { BranchServiceService } from './branch-service.service';

/**
 * Jo'natilgan pochtani boshqa filialga o'tkazish (`reassignPostToBranch`):
 * Samarqandda 2 filial, HQ pochtani adashib 1-filialga (#20) jo'natgan —
 * 1-filial hali qabul qilmagan pochta 2-filialga (#22) o'tadi. Pochta VA
 * buyurtmalar birga ko'chadi (avval buyurtmalar, oxirida pochta).
 */
type RepoMock = {
  findOne: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
  manager?: unknown;
  metadata?: unknown;
};
type WhereArg = {
  where?: { id?: unknown; role?: unknown; branch_id?: unknown };
};
type RpcPayload = {
  id?: string;
  ids?: string[];
  dto?: Record<string, unknown>;
  requester?: Record<string, unknown>;
  query?: { user_ids?: string[] };
};
type RpcError = {
  statusCode?: number;
  message?: string;
  data?: Record<string, unknown>;
};

describe("reassignPostToBranch — pochtani boshqa filialga o'tkazish", () => {
  let service: BranchServiceService;
  let branchRepo: RepoMock;
  let branchUserRepo: RepoMock;
  let identityClient: { send: jest.Mock };
  let logisticsClient: { send: jest.Mock };
  let orderClient: { send: jest.Mock };
  let activityLog: { log: jest.Mock; logChange: jest.Mock };
  let branchesById: Record<string, Record<string, unknown>>;
  let postRow: Record<string, unknown>;
  let postOrders: Array<Record<string, unknown>>;
  let districtsById: Record<string, Record<string, unknown>>;
  let orderUpdate: (payload: RpcPayload) => unknown;
  let reassignReply: () => unknown;

  const ADMIN = { id: '1', roles: ['admin'] };

  const onTheRoad = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    status: 'on the road',
    branch_id: '20',
    holder_type: 'BRANCH',
    holder_branch_id: '20',
    holder_courier_id: null,
    courier_id: null,
    return_requested: false,
    region_id: '14',
    district_id: '1401',
    ...extra,
  });

  beforeEach(() => {
    branchRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      create: jest.fn((row: unknown) => row),
      manager: { query: jest.fn().mockResolvedValue([]) },
      metadata: { tablePath: 'branch_schema.branches' },
    };
    branchUserRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn(({ where }: WhereArg) =>
        Promise.resolve(
          where?.role === 'MANAGER'
            ? [
                {
                  branch_id: String(where?.branch_id),
                  user_id: '198',
                  role: 'MANAGER',
                },
              ]
            : [],
        ),
      ),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
      create: jest.fn((row: unknown) => row),
    };
    identityClient = {
      send: jest.fn(({ cmd }: { cmd: string }, payload: RpcPayload) =>
        cmd === 'identity.user.find_all'
          ? of({
              data: {
                items: (payload?.query?.user_ids ?? []).map((id) => ({
                  id,
                  role: 'manager',
                  status: 'active',
                })),
              },
            })
          : of({ data: null }),
      ),
    };
    branchesById = {
      '10': { id: '10', type: 'HQ', status: 'active', isDeleted: false },
      '20': {
        id: '20',
        name: 'Samarqand 1',
        type: 'REGIONAL',
        status: 'active',
        region_id: '14',
        isDeleted: false,
      },
      '22': {
        id: '22',
        name: 'Samarqand 2',
        type: 'REGIONAL',
        status: 'active',
        region_id: '14',
        isDeleted: false,
      },
      '30': {
        id: '30',
        name: 'Buxoro',
        type: 'REGIONAL',
        status: 'active',
        region_id: '15',
        isDeleted: false,
      },
    };
    branchRepo.findOne.mockImplementation(({ where }: WhereArg) =>
      Promise.resolve(branchesById[String(where?.id)] ?? null),
    );
    postRow = {
      id: '900',
      courier_id: '0',
      status: 'sent',
      branch_id: '20',
      region_id: '14',
      order_quantity: 2,
    };
    postOrders = [onTheRoad('501'), onTheRoad('502')];
    districtsById = {
      '1401': {
        id: '1401',
        region_id: '14',
        assigned_region: null,
        serving_branch_id: null,
      },
    };
    orderUpdate = () => of({ data: {} });
    reassignReply = () => of({ data: {} });
    logisticsClient = {
      send: jest.fn(({ cmd }: { cmd: string }, payload: RpcPayload) => {
        if (cmd === 'logistics.post.find_by_ids')
          return of({ data: [postRow] });
        if (cmd === 'logistics.post.orders_by_post')
          return of({ data: postOrders });
        if (cmd === 'logistics.district.find_by_ids')
          return of({
            data: (payload?.ids ?? [])
              .map((id) => districtsById[id])
              .filter(Boolean),
          });
        if (cmd === 'logistics.post.reassign_branch') return reassignReply();
        return of({ data: {} });
      }),
    };
    orderClient = {
      send: jest.fn(({ cmd }: { cmd: string }, payload: RpcPayload) =>
        cmd === 'order.update' ? orderUpdate(payload) : of({ data: {} }),
      ),
    };
    activityLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    };
    service = new BranchServiceService(
      branchRepo as never,
      branchUserRepo as never,
      {} as never,
      identityClient as never,
      logisticsClient as never,
      orderClient as never,
      { send: jest.fn().mockReturnValue(of({ data: {} })) } as never,
      { send: jest.fn().mockReturnValue(of({ data: {} })) } as never,
      { get: jest.fn((_key: string, fallback?: string) => fallback) } as never,
      activityLog as never,
    );
    jest
      .spyOn((service as unknown as { logger: Logger }).logger, 'error')
      .mockImplementation(() => undefined);
    jest
      .spyOn((service as unknown as { logger: Logger }).logger, 'warn')
      .mockImplementation(() => undefined);
  });

  const rpcErrorOf = async (promise: Promise<unknown>): Promise<RpcError> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as RpcError;
    }
    throw new Error('chaqiruv rad etilishi kutilgandi');
  };
  const callsOf = (client: { send: jest.Mock }, cmd: string) =>
    client.send.mock.calls
      .filter(([pattern]) => (pattern as { cmd: string }).cmd === cmd)
      .map(([, payload]) => payload as RpcPayload);
  const sequence = () =>
    [...logisticsClient.send.mock.calls, ...orderClient.send.mock.calls]
      .map((call, index) => ({
        cmd: (call[0] as { cmd: string }).cmd,
        order:
          index < logisticsClient.send.mock.calls.length
            ? logisticsClient.send.mock.invocationCallOrder[index]
            : orderClient.send.mock.invocationCallOrder[
                index - logisticsClient.send.mock.calls.length
              ],
      }))
      .sort((a, b) => a.order - b.order)
      .map((row) => row.cmd);

  it('⭐ pochta va har bir buyurtma 2-filialga o`tadi: avval buyurtmalar, oxirida pochta', async () => {
    const res = (await service.reassignPostToBranch('900', '22', ADMIN)) as {
      data: Record<string, unknown>;
      message: string;
    };

    const updates = callsOf(orderClient, 'order.update');
    expect(updates.map((u) => [u.id, u.dto])).toEqual([
      ['501', { branch_id: '22' }],
      ['502', { branch_id: '22' }],
    ]);
    expect(updates[0].requester).toMatchObject({
      id: '1',
      roles: ['admin'],
      post_branch_reassign: {
        post_id: '900',
        from_branch_id: '20',
        from_branch_name: 'Samarqand 1',
        to_branch_id: '22',
        to_branch_name: 'Samarqand 2',
      },
    });
    expect(callsOf(logisticsClient, 'logistics.post.reassign_branch')).toEqual([
      {
        post_id: '900',
        from_branch_id: '20',
        to_branch_id: '22',
        expected_order_quantity: 2,
      },
    ]);
    const seq = sequence().filter(
      (cmd) =>
        cmd === 'order.update' || cmd === 'logistics.post.reassign_branch',
    );
    expect(seq).toEqual([
      'order.update',
      'order.update',
      'logistics.post.reassign_branch',
    ]);
    expect(res.data).toMatchObject({
      post_id: '900',
      source_branch_id: '20',
      destination_branch_id: '22',
      destination_branch_name: 'Samarqand 2',
      moved_orders_count: 2,
      moved_order_ids: ['501', '502'],
    });
    expect(res.message).toBe("Pochta Samarqand 2 filialiga o'tkazildi");
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Post',
        entity_id: '900',
        action: 'branch.post_reassign',
      }),
    );
  });

  it('faqat superadmin/admin: menejer 403, hech narsa o`qilmaydi', async () => {
    const err = await rpcErrorOf(
      service.reassignPostToBranch('900', '22', {
        id: '5',
        roles: ['manager'],
      }),
    );
    expect(err.statusCode).toBe(403);
    expect(logisticsClient.send).not.toHaveBeenCalled();
    expect(orderClient.send).not.toHaveBeenCalled();
  });

  it.each([
    ['received', 'filialda qabul qilingan'],
    ['new', "hali jo'natilmagan"],
    ['canceled', 'faqat filialga jo'],
  ])('pochta holati %s — 409, hech narsa yozilmaydi', async (status, text) => {
    postRow.status = status;
    const err = await rpcErrorOf(
      service.reassignPostToBranch('900', '22', ADMIN),
    );
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain(text);
    expect(err.data?.reasons).toEqual({ post_not_sent: true });
    expect(callsOf(orderClient, 'order.update')).toHaveLength(0);
  });

  it('kuryer pochtasi — 400', async () => {
    postRow.courier_id = '77';
    const err = await rpcErrorOf(
      service.reassignPostToBranch('900', '22', ADMIN),
    );
    expect(err.statusCode).toBe(400);
    expect(err.data?.reasons).toEqual({ post_has_courier: true });
  });

  it('o`sha filialning o`zi — 400', async () => {
    const err = await rpcErrorOf(
      service.reassignPostToBranch('900', '20', ADMIN),
    );
    expect(err.statusCode).toBe(400);
    expect(err.data?.reasons).toEqual({ same_branch: true });
  });

  it('boshqa viloyat filiali — 400 region_mismatch', async () => {
    const err = await rpcErrorOf(
      service.reassignPostToBranch('900', '30', ADMIN),
    );
    expect(err.statusCode).toBe(400);
    expect(err.data?.reasons).toEqual({ region_mismatch: true });
    expect(callsOf(orderClient, 'order.update')).toHaveLength(0);
  });

  it('nofaol yoki HQ filial — 400 (jo`natish qoidasi)', async () => {
    branchesById['22'].status = 'inactive';
    const err = await rpcErrorOf(
      service.reassignPostToBranch('900', '22', ADMIN),
    );
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('faol emas');
  });

  it.each([
    ['qabul qilingan (waiting)', { status: 'waiting' }],
    ['kuryerga berilgan', { courier_id: '77' }],
    ['«kelmadi» deb belgilangan', { return_requested: true }],
    ['boshqa filialda', { holder_branch_id: '40', branch_id: '40' }],
  ])(
    'bitta buyurtma %s — butun so`rov 409, hech narsa ko`chmaydi',
    async (_label, extra) => {
      postOrders = [onTheRoad('501'), onTheRoad('502', extra)];
      const err = await rpcErrorOf(
        service.reassignPostToBranch('900', '22', ADMIN),
      );
      expect(err.statusCode).toBe(409);
      expect(err.data).toMatchObject({
        blocked_order_ids: ['502'],
        reasons: { post_partly_received: true },
      });
      expect(callsOf(orderClient, 'order.update')).toHaveLength(0);
      expect(
        callsOf(logisticsClient, 'logistics.post.reassign_branch'),
      ).toHaveLength(0);
    },
  );

  it('tuman 2-filial qamrovida emas (1-filialga biriktirilgan) — 409, hech narsa ko`chmaydi', async () => {
    districtsById['1401'].serving_branch_id = '20';
    const err = await rpcErrorOf(
      service.reassignPostToBranch('900', '22', ADMIN),
    );
    expect(err.statusCode).toBe(409);
    expect(callsOf(orderClient, 'order.update')).toHaveLength(0);
  });

  it('qayta urinish: 2-filialga o`tib bo`lgan buyurtma qayta yozilmaydi', async () => {
    postOrders = [
      onTheRoad('501', { holder_branch_id: '22', branch_id: '22' }),
      onTheRoad('502'),
    ];
    await service.reassignPostToBranch('900', '22', ADMIN);
    expect(callsOf(orderClient, 'order.update').map((u) => u.id)).toEqual([
      '502',
    ]);
    expect(
      callsOf(logisticsClient, 'logistics.post.reassign_branch'),
    ).toHaveLength(1);
  });

  it('yarmida yiqilsa — ko`chganlar (javobsiz qolgani ham) 1-filialga qaytadi, pochta tegilmaydi, 503', async () => {
    orderUpdate = (payload) =>
      payload.id === '502' && payload.dto?.branch_id === '22'
        ? throwError(() => ({ statusCode: 500, message: 'db down' }))
        : of({ data: {} });
    const err = await rpcErrorOf(
      service.reassignPostToBranch('900', '22', ADMIN),
    );
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain("Hech narsa o'tkazilmadi");
    const updates = callsOf(orderClient, 'order.update');
    expect(updates.map((u) => [u.id, u.dto?.branch_id])).toEqual([
      ['501', '22'],
      ['502', '22'],
      ['502', '20'],
      ['501', '20'],
    ]);
    expect(updates[3].requester).toMatchObject({
      post_branch_reassign: { from_branch_id: '22', to_branch_id: '20' },
    });
    expect(
      callsOf(logisticsClient, 'logistics.post.reassign_branch'),
    ).toHaveLength(0);
    expect(activityLog.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'branch.post_reassign' }),
    );
  });

  it('buyurtma shu paytda qabul qilingan (order-service 409) — u tegilmaydi, ko`chganlar qaytadi, 409', async () => {
    orderUpdate = (payload) =>
      payload.id === '502' && payload.dto?.branch_id === '22'
        ? throwError(() => ({
            statusCode: 409,
            message: "Buyurtma #502 holati o'zgardi",
          }))
        : of({ data: {} });
    const err = await rpcErrorOf(
      service.reassignPostToBranch('900', '22', ADMIN),
    );
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain("shu paytda o'zgardi");
    expect(
      callsOf(orderClient, 'order.update').map((u) => [u.id, u.dto?.branch_id]),
    ).toEqual([
      ['501', '22'],
      ['502', '22'],
      ['501', '20'],
    ]);
    expect(
      callsOf(logisticsClient, 'logistics.post.reassign_branch'),
    ).toHaveLength(0);
  });

  it('pochta qadami javob bermadi, lekin pochta 2-filialda — muvaffaqiyat, buyurtmalar qaytarilmaydi', async () => {
    reassignReply = () => {
      postRow = { ...postRow, branch_id: '22' };
      return throwError(() => ({ statusCode: 500, message: 'timeout' }));
    };
    const res = (await service.reassignPostToBranch('900', '22', ADMIN)) as {
      data: Record<string, unknown>;
    };
    expect(res.data).toMatchObject({ moved_orders_count: 2 });
    expect(
      callsOf(orderClient, 'order.update').map((u) => u.dto?.branch_id),
    ).toEqual(['22', '22']);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'branch.post_reassign' }),
    );
  });

  it('qaytarishda 409 (shu orada qabul qilingan) — «qaytmadi» ro`yxatiga kirmaydi', async () => {
    orderUpdate = (payload) =>
      payload.id === '501' && payload.dto?.branch_id === '20'
        ? throwError(() => ({ statusCode: 409, message: 'qabul qilingan' }))
        : of({ data: {} });
    reassignReply = () =>
      throwError(() => ({ statusCode: 500, message: 'logistics down' }));
    const err = await rpcErrorOf(
      service.reassignPostToBranch('900', '22', ADMIN),
    );
    expect(err.statusCode).toBe(503);
    expect(err.data?.not_reverted_order_ids).toEqual([]);
  });

  it('pochta shu paytda qabul qilingan (logistics 409) — buyurtmalar qaytadi, 409', async () => {
    reassignReply = () =>
      throwError(() => ({ statusCode: 409, message: "Pochta o'zgargan" }));
    const err = await rpcErrorOf(
      service.reassignPostToBranch('900', '22', ADMIN),
    );
    expect(err.statusCode).toBe(409);
    expect(err.message).toContain("shu paytda o'zgardi");
    expect(
      callsOf(orderClient, 'order.update').map((u) => [u.id, u.dto?.branch_id]),
    ).toEqual([
      ['501', '22'],
      ['502', '22'],
      ['502', '20'],
      ['501', '20'],
    ]);
  });

  it('qaytarish ham yiqilsa — qolgan id`lar xabarda (qayta urinish tugatadi)', async () => {
    orderUpdate = (payload) =>
      payload.dto?.branch_id === '20'
        ? throwError(() => ({ statusCode: 500, message: 'db down' }))
        : of({ data: {} });
    reassignReply = () =>
      throwError(() => ({ statusCode: 500, message: 'logistics down' }));
    const err = await rpcErrorOf(
      service.reassignPostToBranch('900', '22', ADMIN),
    );
    expect(err.statusCode).toBe(503);
    expect(err.data?.not_reverted_order_ids).toEqual(['502', '501']);
    expect(err.message).toContain('qayta urinish');
  });
});
