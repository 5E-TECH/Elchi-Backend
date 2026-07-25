import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { BranchServiceService } from './branch-service.service';

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    Status: {
      ...(actual.Status ?? {}),
      ACTIVE: 'active',
      INACTIVE: 'inactive',
    },
    BranchType: {
      HQ: 'HQ',
      PICKUP: 'PICKUP',
      REGIONAL: 'REGIONAL',
      HYBRID: 'HYBRID',
    },
  };
});

describe('BranchServiceService', () => {
  let service: BranchServiceService;
  let branchRepo: any;
  let branchUserRepo: any;
  let branchConfigRepo: any;
  let identityClient: any;
  let logisticsClient: any;
  let orderClient: any;
  let fileClient: any;
  let financeClient: any;

  beforeEach(() => {
    // Chainable QueryBuilder mock — ensureBranchNameUnique uses
    // createQueryBuilder().where().andWhere().getOne().
    const buildQb = () => {
      const qb: any = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
        getMany: jest.fn().mockResolvedValue([]),
        getRawMany: jest.fn().mockResolvedValue([]),
        getCount: jest.fn().mockResolvedValue(0),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      return qb;
    };

    branchRepo = {
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn(),
      save: jest.fn(),
      create: jest.fn((v) => v),
      createQueryBuilder: jest.fn(() => buildQb()),
      // collectDescendantBranchIds uses raw SQL via the repository manager.
      manager: { query: jest.fn().mockResolvedValue([]) },
      metadata: { tablePath: 'branch_schema.branches' },
    };
    branchUserRepo = {
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn(),
      create: jest.fn((v) => v),
      find: jest.fn(),
    };
    branchConfigRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn((v) => v),
      find: jest.fn(),
    };
    identityClient = {
      send: jest.fn().mockReturnValue(of({ data: { id: 'u1' } })),
    };
    logisticsClient = { send: jest.fn().mockReturnValue(of({ data: [] })) };
    orderClient = { send: jest.fn().mockReturnValue(of({ data: [] })) };
    fileClient = {
      send: jest.fn().mockReturnValue(of({ data: { key: 'k1', url: 'u1' } })),
    };
    financeClient = { send: jest.fn().mockReturnValue(of({ data: {} })) };

    const configService: any = {
      get: jest.fn((key: string, fallback?: string) => fallback),
    };

    const activityLog: any = {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
      query: jest
        .fn()
        .mockResolvedValue({
          items: [],
          meta: { page: 1, limit: 50, total: 0, totalPages: 1 },
        }),
      findByEntity: jest.fn().mockResolvedValue([]),
      findByUser: jest.fn().mockResolvedValue([]),
    };

    service = new BranchServiceService(
      branchRepo,
      branchUserRepo,
      branchConfigRepo,
      identityClient,
      logisticsClient,
      orderClient,
      fileClient,
      financeClient,
      configService,
      activityLog,
    );
  });

  it('createBranch creates new branch', async () => {
    // ensureBranchNameUnique now uses createQueryBuilder (QB mock returns null by default).
    // Sequential findOne calls: ensureBranchCodeUnique → getParentBranchOrThrow.
    branchRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'hq',
        level: 0,
        type: 'HQ',
        isDeleted: false,
      });
    branchRepo.save.mockResolvedValue({ id: 'b1', name: 'Main' });

    const res = await service.createBranch({
      name: 'Main',
      type: 'REGIONAL',
      code: 'SAM',
      parent_id: 'hq',
    } as any);

    expect(res.statusCode).toBe(201);
    expect(res.data.id).toBe('b1');
  });

  it('createBranch throws 400 when name missing', async () => {
    await expect(service.createBranch({} as any)).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('createBranch throws 409 on duplicate name', async () => {
    // Name uniqueness is now enforced via createQueryBuilder().getOne().
    // Make the QB builder return an existing branch so the check fails.
    branchRepo.createQueryBuilder.mockImplementationOnce(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({ id: 'x', name: 'Main' }),
    }));
    await expect(
      service.createBranch({
        name: 'Main',
        type: 'HQ',
        code: 'HQ-TSHKNT',
      } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('updateBranch throws 400 on invalid status', async () => {
    branchRepo.findOne.mockResolvedValue({
      id: 'b1',
      name: 'A',
      status: 'active',
      isDeleted: false,
    });
    await expect(
      service.updateBranch('b1', { status: 'bad' } as any, {
        id: '1',
        roles: ['admin'],
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('assignUserToBranch throws when branch_id is missing', async () => {
    await expect(
      service.assignUserToBranch({ user_id: 'u1' } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('assignUserToBranch throws conflict if user in another branch', async () => {
    branchRepo.findOne.mockResolvedValue({ id: 'b1', isDeleted: false });
    branchUserRepo.findOne.mockResolvedValueOnce({
      branch_id: 'b2',
      user_id: 'u1',
      isDeleted: false,
    });

    await expect(
      service.assignUserToBranch({ branch_id: 'b1', user_id: 'u1' } as any, {
        id: '1',
        roles: ['admin'],
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('setBranchConfig creates config when absent', async () => {
    branchRepo.findOne.mockResolvedValue({ id: 'b1', isDeleted: false });
    branchConfigRepo.findOne.mockResolvedValue(null);
    branchConfigRepo.save.mockResolvedValue({
      id: 'c1',
      branch_id: 'b1',
      config_key: 'working_hours',
    });

    const res = await service.setBranchConfig(
      {
        branch_id: 'b1',
        config_key: 'working_hours',
        config_value: { a: 1 },
      } as any,
      { id: '1', roles: ['admin'] },
    );

    expect(res.statusCode).toBe(201);
    expect(res.data.id).toBe('c1');
  });

  it('deleteBranch marks branch as deleted', async () => {
    branchRepo.findOne.mockResolvedValue({
      id: 'b1',
      status: 'active',
      isDeleted: false,
    });
    branchRepo.save.mockResolvedValue({
      id: 'b1',
      status: 'inactive',
      isDeleted: true,
    });

    const res = await service.deleteBranch('b1', { id: '1', roles: ['admin'] });

    expect(res.statusCode).toBe(200);
    expect(res.data.id).toBe('b1');
  });

  it('onModuleInit auto-creates HQ with HQ-TSHKNT code', async () => {
    branchRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    branchRepo.save.mockResolvedValue({ id: 'hq1' });

    await service.onModuleInit();

    expect(branchRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'HQ',
        level: 0,
        parent_id: null,
        code: 'HQ-TSHKNT',
      }),
    );
  });

  it('createBranch blocks second HQ creation', async () => {
    // findOne calls: code unique (null) → existing HQ lookup
    branchRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'existing-hq',
        type: 'HQ',
        isDeleted: false,
      });

    await expect(
      service.createBranch({
        name: 'HQ2',
        type: 'HQ',
        code: 'HQ-TSHKNT-2',
      } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('createBranch blocks duplicate code', async () => {
    // Single findOne call: code unique check fails first.
    branchRepo.findOne.mockResolvedValueOnce({
      id: 'b1',
      code: 'SAM',
      isDeleted: false,
    });

    await expect(
      service.createBranch({
        name: 'Sam branch',
        type: 'REGIONAL',
        code: 'SAM',
        parent_id: '1',
      } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('updateBranch blocks self-parent to prevent cycle', async () => {
    branchRepo.findOne.mockResolvedValue({
      id: 'b1',
      name: 'A',
      code: 'A1',
      type: 'REGIONAL',
      level: 1,
      parent_id: 'hq',
      status: 'active',
      isDeleted: false,
    });

    await expect(
      service.updateBranch('b1', { parent_id: 'b1', type: 'REGIONAL' } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('updateBranch blocks parent assignment to own child', async () => {
    branchRepo.findOne
      .mockResolvedValueOnce({
        id: 'b1',
        name: 'Root',
        code: 'ROOT',
        type: 'REGIONAL',
        level: 1,
        parent_id: 'hq',
        status: 'active',
        isDeleted: false,
      })
      .mockResolvedValueOnce({
        id: 'child1',
        name: 'Child',
        code: 'CH1',
        type: 'DISTRICT',
        level: 2,
        parent_id: 'b1',
        status: 'active',
        isDeleted: false,
      })
      .mockResolvedValueOnce({
        id: 'b1',
        name: 'Root',
        code: 'ROOT',
        type: 'REGIONAL',
        level: 1,
        parent_id: 'hq',
        status: 'active',
        isDeleted: false,
      });

    await expect(
      service.updateBranch('b1', {
        parent_id: 'child1',
        type: 'REGIONAL',
      } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('createBranch computes level automatically from parent', async () => {
    branchRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'hq',
        level: 0,
        type: 'HQ',
        isDeleted: false,
      });
    branchRepo.save.mockImplementation(async (payload: any) => payload);

    const res = await service.createBranch({
      name: 'Sam branch',
      type: 'REGIONAL',
      code: 'SAM',
      parent_id: 'hq',
      level: 99,
    } as any);

    expect(res.data.level).toBe(1);
  });

  it('findBranchTree returns nested branch tree', async () => {
    branchRepo.find.mockResolvedValue([
      { id: '1', name: 'HQ', parent_id: null, level: 0, isDeleted: false },
      {
        id: '2',
        name: 'Samarqand',
        parent_id: '1',
        level: 1,
        isDeleted: false,
      },
      {
        id: '3',
        name: "Kattaqo'rg'on",
        parent_id: '2',
        level: 2,
        isDeleted: false,
      },
      { id: '4', name: 'Urgut', parent_id: '2', level: 2, isDeleted: false },
    ]);

    const res = await service.findBranchTree();

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data[0].id).toBe('1');
    expect(res.data[0].children[0].id).toBe('2');
    expect(res.data[0].children[0].children).toHaveLength(2);
  });

  it('findBranchDescendants returns flat descendants list', async () => {
    branchRepo.findOne.mockResolvedValueOnce({
      id: '2',
      name: 'Samarqand',
      parent_id: '1',
      level: 1,
      isDeleted: false,
    });
    branchRepo.find.mockResolvedValue([
      { id: '1', name: 'HQ', parent_id: null, level: 0, isDeleted: false },
      {
        id: '2',
        name: 'Samarqand',
        parent_id: '1',
        level: 1,
        isDeleted: false,
      },
      {
        id: '3',
        name: "Kattaqo'rg'on",
        parent_id: '2',
        level: 2,
        isDeleted: false,
      },
      { id: '4', name: 'Urgut', parent_id: '2', level: 2, isDeleted: false },
      { id: '5', name: 'Inner', parent_id: '3', level: 3, isDeleted: false },
    ]);

    const res = await service.findBranchDescendants('2');

    expect(res.statusCode).toBe(200);
    expect(res.data.map((item: any) => item.id)).toEqual(['3', '4', '5']);
  });

  it('manager can read child branch but cannot write to child branch', async () => {
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '100', role: 'MANAGER', isDeleted: false },
    ]);
    branchRepo.find
      .mockResolvedValueOnce([{ id: '200' }])
      .mockResolvedValue([]);
    // Avlod filiallar raw SQL (manager.query) orqali olinadi: root '100' + bola '200'.
    branchRepo.manager.query.mockResolvedValue([{ id: '100' }, { id: '200' }]);
    branchRepo.findOne.mockResolvedValue({
      id: '200',
      name: 'Child branch',
      isDeleted: false,
      region_id: null,
      district_id: null,
      parent_id: '100',
    });

    const readRes = await service.findBranchById('200', {
      id: '10',
      roles: ['branch'],
    });
    expect(readRes.statusCode).toBe(200);

    await expect(
      service.updateBranch('200', { name: 'New child name' } as any, {
        id: '10',
        roles: ['branch'],
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('operator can read only own branch', async () => {
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '300', role: 'OPERATOR', isDeleted: false },
    ]);

    await expect(
      service.findBranchById('400', { id: '11', roles: ['branch'] }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('findUserBranch returns assignment for own requester', async () => {
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '100', role: 'REGISTRATOR', isDeleted: false },
    ]);
    branchUserRepo.findOne.mockResolvedValue({
      id: 'bu1',
      branch_id: '100',
      user_id: 'u1',
      role: 'REGISTRATOR',
      isDeleted: false,
      createdAt: new Date(),
    });
    branchRepo.findOne.mockResolvedValue({
      id: '100',
      name: 'Samarkand',
      isDeleted: false,
    });

    const res = await service.findUserBranch('u1', {
      id: 'u1',
      roles: ['branch'],
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.branch_id).toBe('100');
    expect(res.data.role).toBe('REGISTRATOR');
  });

  it('findUserBranch forbids requesting another user assignment for non-admin', async () => {
    await expect(
      service.findUserBranch('u2', { id: 'u1', roles: ['operator'] }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('getBranchStats returns aggregated branch metrics', async () => {
    const now = new Date();
    branchRepo.findOne.mockResolvedValue({ id: '1', isDeleted: false });
    branchRepo.find
      .mockResolvedValueOnce([{ id: '2' }])
      .mockResolvedValueOnce([]);
    // Analitika doirasi raw SQL orqali: branch '1' + avlodi '2'.
    branchRepo.manager.query.mockResolvedValue([{ id: '1' }, { id: '2' }]);
    branchUserRepo.count.mockResolvedValue(3);
    orderClient.send
      .mockReturnValueOnce(
        of({
          data: [
            {
              id: 'o1',
              branch_id: '1',
              market_id: '10',
              status: 'new',
              total_price: 100000,
              current_batch_id: 'b1',
              createdAt: now.toISOString(),
            },
          ],
        }),
      )
      .mockReturnValueOnce(
        of({
          data: [
            {
              id: 'o2',
              branch_id: '2',
              market_id: '11',
              status: 'waiting',
              total_price: 200000,
              current_batch_id: 'b2',
              createdAt: now.toISOString(),
            },
          ],
        }),
      )
      .mockReturnValue(of({ data: { acceptedCount: 1 } }));

    const res = await service.getBranchStats('1', {
      id: '1',
      roles: ['admin'],
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.today_orders_count).toBe(2);
    expect(res.data.week_orders_count).toBe(2);
    expect(res.data.active_batches_count).toBe(2);
    expect(res.data.couriers_count).toBe(3);
  });

  it('getBranchMarketsAnalytics returns grouped market data', async () => {
    branchRepo.findOne.mockResolvedValue({ id: '1', isDeleted: false });
    branchRepo.find.mockResolvedValueOnce([]);
    branchRepo.manager.query.mockResolvedValue([{ id: '1' }]);
    orderClient.send.mockReturnValueOnce(
      of({
        data: [
          {
            id: 'o1',
            branch_id: '1',
            market_id: '10',
            status: 'waiting',
            total_price: 100000,
            createdAt: new Date().toISOString(),
          },
          {
            id: 'o2',
            branch_id: '1',
            market_id: '10',
            status: 'new',
            total_price: 150000,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );

    const res = await service.getBranchMarketsAnalytics('1', {
      id: '1',
      roles: ['admin'],
    });

    expect(res.statusCode).toBe(200);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).toEqual(
      expect.objectContaining({
        market_id: '10',
        orders_count: 2,
        delivered_count: 1,
        total_price: 250000,
      }),
    );
    expect(res.data[0]).not.toHaveProperty('commission');
    expect(res.data[0]).not.toHaveProperty('payment');
    expect(res.data[0]).not.toHaveProperty('expense');
    expect(res.data[0]).not.toHaveProperty('profit');
  });

  it('manager stats includes own branch and descendants', async () => {
    branchRepo.findOne.mockResolvedValue({ id: '100', isDeleted: false });
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '100', role: 'MANAGER', isDeleted: false },
    ]);
    branchRepo.find.mockResolvedValue([{ id: '200' }]);
    // Avlod filiallar raw SQL (manager.query) orqali: root '100' + bola '200'.
    branchRepo.manager.query.mockResolvedValue([{ id: '100' }, { id: '200' }]);
    branchUserRepo.count.mockResolvedValue(0);
    orderClient.send
      .mockReturnValueOnce(of({ data: [] }))
      .mockReturnValueOnce(of({ data: [] }))
      .mockReturnValue(of({ data: { acceptedCount: 0 } }));

    const res = await service.getBranchStats('100', {
      id: 'u-manager',
      roles: ['branch'],
    });

    expect(res.statusCode).toBe(200);
    const findAllCalls = orderClient.send.mock.calls.filter(
      ([pattern]) => pattern.cmd === 'order.find_all',
    );
    expect(findAllCalls).toHaveLength(2);
    expect(findAllCalls).toEqual(
      expect.arrayContaining([
        [
          { cmd: 'order.find_all' },
          expect.objectContaining({
            query: expect.objectContaining({ branch_id: '100' }),
          }),
        ],
        [
          { cmd: 'order.find_all' },
          expect.objectContaining({
            query: expect.objectContaining({ branch_id: '200' }),
          }),
        ],
      ]),
    );
  });

  it('registrator stats includes only own branch (no descendants)', async () => {
    branchRepo.findOne.mockResolvedValue({ id: '300', isDeleted: false });
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '300', role: 'REGISTRATOR', isDeleted: false },
    ]);
    branchUserRepo.count.mockResolvedValue(0);
    orderClient.send
      .mockReturnValueOnce(of({ data: [] }))
      .mockReturnValue(of({ data: { acceptedCount: 0 } }));

    const res = await service.getBranchStats('300', {
      id: 'u-registrator',
      roles: ['branch'],
    });

    expect(res.statusCode).toBe(200);
    const findAllCalls = orderClient.send.mock.calls.filter(
      ([pattern]) => pattern.cmd === 'order.find_all',
    );
    expect(findAllCalls).toEqual([
      [
        { cmd: 'order.find_all' },
        expect.objectContaining({
          query: expect.objectContaining({ branch_id: '300' }),
        }),
      ],
    ]);
  });

  it('stats and markets analytics respond under 300ms in local unit run', async () => {
    branchRepo.findOne.mockResolvedValue({ id: '1', isDeleted: false });
    branchRepo.find.mockResolvedValueOnce([]);
    branchRepo.find.mockResolvedValueOnce([]);
    branchUserRepo.count.mockResolvedValue(1);
    orderClient.send
      .mockReturnValueOnce(
        of({
          data: [
            {
              id: 'o1',
              branch_id: '1',
              market_id: '11',
              status: 'new',
              total_price: 120000,
              current_batch_id: 'b1',
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      )
      .mockReturnValueOnce(
        of({
          data: [
            {
              id: 'o2',
              branch_id: '1',
              market_id: '11',
              status: 'waiting',
              total_price: 130000,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      );

    const statsStart = Date.now();
    const statsRes = await service.getBranchStats('1', {
      id: '1',
      roles: ['admin'],
    });
    const statsMs = Date.now() - statsStart;

    const marketsStart = Date.now();
    const marketsRes = await service.getBranchMarketsAnalytics('1', {
      id: '1',
      roles: ['admin'],
    });
    const marketsMs = Date.now() - marketsStart;

    expect(statsRes.statusCode).toBe(200);
    expect(marketsRes.statusCode).toBe(200);
    expect(statsMs).toBeLessThan(300);
    expect(marketsMs).toBeLessThan(300);
  });

  it('createTransferBatches creates batches and generates QR files', async () => {
    // Manba filial (10) va uning OTA filiali (1) — destination = parent_id.
    branchRepo.findOne
      .mockResolvedValueOnce({ id: '10', parent_id: '1', isDeleted: false })
      .mockResolvedValueOnce({ id: '1', isDeleted: false });
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '10', role: 'REGISTRATOR', isDeleted: false },
    ]);
    orderClient.send.mockReturnValueOnce(
      of({
        statusCode: 201,
        data: {
          idempotent: false,
          batches: [
            { id: '501', qr_code_token: 'BTB-abc123xy', target_region_id: '6' },
          ],
        },
      }),
    );
    orderClient.send.mockReturnValueOnce(
      of({
        statusCode: 201,
        data: { id: 'h-1' },
      }),
    );
    fileClient.send.mockReturnValueOnce(
      of({
        data: { key: 'branch-transfer-batches-1.png', url: 'https://minio/u1' },
      }),
    );

    const res = await service.createTransferBatches(
      '10',
      { orderIds: ['900'] },
      { id: '77', roles: ['branch'] },
    );

    expect(res.statusCode).toBe(201);
    expect(res.data.batches).toHaveLength(1);
    expect(res.data.batches[0].qr_file).toEqual(
      expect.objectContaining({ key: 'branch-transfer-batches-1.png' }),
    );
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.transfer_batch.create' },
      expect.objectContaining({
        source_branch_id: '10',
        destination_branch_id: '1',
      }),
    );
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.transfer_batch.history.add' },
      expect.objectContaining({
        batch_id: '501',
        notes: '[STEP] QR_GENERATED',
      }),
    );
  });

  it('createTransferBatches keeps batches when QR generation fails', async () => {
    // Manba filial (10) va uning OTA filiali (1) — destination = parent_id.
    branchRepo.findOne
      .mockResolvedValueOnce({ id: '10', parent_id: '1', isDeleted: false })
      .mockResolvedValueOnce({ id: '1', isDeleted: false });
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '10', role: 'REGISTRATOR', isDeleted: false },
    ]);
    orderClient.send
      .mockReturnValueOnce(
        of({
          statusCode: 201,
          data: {
            idempotent: false,
            batches: [
              {
                id: '601',
                qr_code_token: 'BTB-fail9988',
                target_region_id: '6',
              },
            ],
          },
        }),
      )
      .mockReturnValueOnce(of({ statusCode: 201, data: { id: 'h-2' } }));
    fileClient.send.mockImplementation(() => {
      throw new Error('file down');
    });

    const res = await service.createTransferBatches(
      '10',
      { orderIds: ['900'] },
      { id: '77', roles: ['branch'] },
    );

    expect(res.statusCode).toBe(201);
    expect(res.data.batches[0].qr_file).toBeNull();
    expect(res.data.qr_generation_errors).toEqual([
      { batch_id: '601', message: 'file down' },
    ]);
    expect(orderClient.send).not.toHaveBeenCalledWith(
      { cmd: 'order.transfer_batch.cancel_many' },
      expect.anything(),
    );
  });

  it('sendTransferBatch updates batch status to SENT through order service', async () => {
    orderClient.send
      .mockReturnValueOnce(of({ data: { id: '701', source_branch_id: '10' } }))
      .mockReturnValueOnce(
        of({ statusCode: 200, data: { id: '701', status: 'SENT' } }),
      );
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '10', role: 'REGISTRATOR', isDeleted: false },
    ]);

    const res = await service.sendTransferBatch(
      '701',
      {
        orderIds: ['900'],
        vehicle_plate: '01 A 123 AB',
        driver_name: 'Haydovchi',
        driver_phone: '+998901234567',
      },
      { id: '77', roles: ['branch'] },
    );

    expect(res).toEqual(expect.objectContaining({ statusCode: 200 }));
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.transfer_batch.send' },
      expect.objectContaining({
        batch_id: '701',
        vehicle_plate: '01 A 123 AB',
      }),
    );
  });

  it('sendTransferBatch fails when vehicle data is empty', async () => {
    await expect(
      service.sendTransferBatch(
        '701',
        { vehicle_plate: '', driver_name: '', driver_phone: '' },
        { id: '77', roles: ['operator'] },
      ),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('receiveTransferBatch updates batch status to RECEIVED through order service', async () => {
    orderClient.send
      .mockReturnValueOnce(
        of({ data: { id: '801', destination_branch_id: '20' } }),
      )
      .mockReturnValueOnce(
        of({ statusCode: 200, data: { id: '801', status: 'RECEIVED' } }),
      );
    // Manzil filial (destination) getBranchOrThrow orqali branchRepo'dan qidiriladi.
    branchRepo.findOne.mockResolvedValue({ id: '20', isDeleted: false });
    branchUserRepo.findOne.mockResolvedValue({ id: 'bu-1' });

    const res = await service.receiveTransferBatch('801', {
      id: '55',
      roles: ['branch'],
    });

    expect(res).toEqual(expect.objectContaining({ statusCode: 200 }));
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.transfer_batch.receive' },
      expect.objectContaining({ batch_id: '801', requester_id: '55' }),
    );
  });

  it('receiveTransferBatch fails when requester not assigned to destination branch', async () => {
    orderClient.send.mockReturnValueOnce(
      of({ data: { id: '802', destination_branch_id: '30' } }),
    );
    branchUserRepo.findOne.mockResolvedValue(null);

    await expect(
      service.receiveTransferBatch('802', { id: '999', roles: ['operator'] }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('findTransferBatchByToken delegates to order-service', async () => {
    orderClient.send.mockReturnValueOnce(
      of({
        statusCode: 200,
        data: {
          id: '900',
          qr_code_token: 'BTB-a1b2c3',
          source_branch_id: '10',
          destination_branch_id: '1',
        },
      }),
    );

    const res = await service.findTransferBatchByToken('BTB-a1b2c3', {
      id: '1',
      roles: ['admin'],
    });

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.transfer_batch.find_by_qr' },
      { token: 'BTB-a1b2c3' },
    );
    expect(res.statusCode).toBe(200);
    expect((res as any).data.id).toBe('900');
  });

  it('cancelTransferBatch validates reason and calls order-service', async () => {
    orderClient.send
      .mockReturnValueOnce(
        of({
          statusCode: 200,
          data: {
            id: '501',
            source_branch_id: '10',
            status: 'PENDING',
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          statusCode: 200,
          data: { id: '501', status: 'CANCELLED' },
        }),
      )
      .mockReturnValueOnce(of({ statusCode: 200, data: { affected: 2 } }));
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '10', role: 'REGISTRATOR', isDeleted: false },
    ]);

    const res = await service.cancelTransferBatch(
      '501',
      { reason: "noto'g'ri viloyat tanlangan" },
      { id: '77', roles: ['branch'] },
    );

    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.transfer_batch.cancel' },
      expect.objectContaining({
        batch_id: '501',
        reason: "noto'g'ri viloyat tanlangan",
      }),
    );
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.bulk_remove_from_batch' },
      expect.objectContaining({
        batch_id: '501',
        message_id: 'cancel_batch_501',
      }),
    );
    expect(res.statusCode).toBe(200);
  });

  it('cancelTransferBatch rejects short reason', async () => {
    await expect(
      service.cancelTransferBatch(
        '501',
        { reason: 'qisqa' },
        { id: '77', roles: ['operator'] },
      ),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('dispatchPostToBranch rejects destination branch without manager', async () => {
    branchRepo.findOne
      .mockResolvedValueOnce({
        id: '10',
        type: 'HQ',
        status: 'active',
        isDeleted: false,
      })
      .mockResolvedValueOnce({
        id: '20',
        type: 'REGIONAL',
        status: 'active',
        isDeleted: false,
      });
    branchUserRepo.findOne.mockResolvedValueOnce(null);

    await expect(
      service.dispatchPostToBranch(
        '10',
        '900',
        '20',
        ['1001'],
        { id: '1', roles: ['admin'] },
      ),
    ).rejects.toBeInstanceOf(RpcException);

    expect(logisticsClient.send).not.toHaveBeenCalled();
    expect(orderClient.send).not.toHaveBeenCalled();
  });
});
