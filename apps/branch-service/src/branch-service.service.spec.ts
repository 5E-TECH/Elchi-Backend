import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
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
      query: jest.fn().mockResolvedValue({
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
    branchRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
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
    branchRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
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
    branchRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'hq',
      level: 0,
      type: 'HQ',
      isDeleted: false,
    });
    branchRepo.save.mockImplementation((payload: any) =>
      Promise.resolve(payload),
    );

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

  /**
   * SCALE 1-BOSQICH. Ilgari bu panel har filial uchun alohida
   * `order.find_all` chaqirib, 5 000 tagacha buyurtmani tortib olib JS'da
   * sanardi. Endi bitta `order.analytics.branch_dashboard` chaqiruvi tayyor
   * yig'indilarni qaytaradi — buyurtma qatorlari umuman tashilmaydi.
   */
  const dashboardStats = (overrides: Record<string, unknown> = {}) => ({
    today_orders_count: 2,
    week_orders_count: 2,
    selected_orders_count: 2,
    active_batches_count: 2,
    orders_card: {
      total: 2,
      new: 1,
      on_the_road: 0,
      delivered: 1,
      returned: 0,
      cancelled: 0,
    },
    markets: [
      {
        market_id: '10',
        market_name: 'Yandex',
        orders_count: 2,
        delivered_count: 1,
        total_price: 250000,
      },
    ],
    packages: { on_the_way: 0, waiting_for_acceptance: 0 },
    active_couriers: 1,
    ...overrides,
  });

  it('getBranchStats returns aggregated branch metrics', async () => {
    branchRepo.findOne.mockResolvedValue({ id: '1', isDeleted: false });
    branchRepo.find
      .mockResolvedValueOnce([{ id: '2' }])
      .mockResolvedValueOnce([]);
    branchRepo.manager.query.mockResolvedValue([{ id: '1' }, { id: '2' }]);
    branchUserRepo.find.mockResolvedValue([
      { user_id: 'c1' },
      { user_id: 'c2' },
      { user_id: 'c3' },
    ]);
    orderClient.send.mockReturnValue(of({ data: dashboardStats() }));

    const res = await service.getBranchStats('1', {
      id: '1',
      roles: ['admin'],
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.today_orders_count).toBe(2);
    expect(res.data.week_orders_count).toBe(2);
    expect(res.data.active_batches_count).toBe(2);
    expect(res.data.couriers_count).toBe(3);

    // Buyurtma qatorlari endi umuman so'ralmaydi.
    const cmds = orderClient.send.mock.calls.map(
      ([pattern]: [{ cmd: string }]) => pattern.cmd,
    );
    expect(cmds).toContain('order.analytics.branch_dashboard');
    expect(cmds).not.toContain('order.find_all');
  });

  /**
   * Menejer statistikasi (harakat sanasi bo'yicha): order-service yangi
   * `orders_card.cancelled` va `markets[].market_name` ni beradi — filial
   * servisi ularni O'ZGARTIRMASDAN uzatadi (market qatori ham, token ham emas —
   * faqat nom).
   */
  it("getBranchStats: cancelled va market_name o'zgarmasdan uzatiladi", async () => {
    branchRepo.findOne.mockResolvedValue({ id: '1', isDeleted: false });
    branchRepo.find
      .mockResolvedValueOnce([{ id: '2' }])
      .mockResolvedValueOnce([]);
    branchRepo.manager.query.mockResolvedValue([{ id: '1' }, { id: '2' }]);
    branchUserRepo.find.mockResolvedValue([
      { user_id: 'c1' },
      { user_id: 'c2' },
      { user_id: 'c3' },
    ]);
    orderClient.send.mockReturnValue(
      of({
        data: dashboardStats({
          orders_card: {
            total: 8,
            new: 1,
            on_the_road: 2,
            delivered: 6,
            returned: 0,
            cancelled: 2,
          },
          markets: [
            {
              market_id: '10',
              market_name: 'Yandex',
              orders_count: 2,
              delivered_count: 1,
              total_price: 250000,
            },
          ],
        }),
      }),
    );

    const res = await service.getBranchStats('1', {
      id: '1',
      roles: ['admin'],
    });

    expect(res.data.cards.orders).toEqual(
      expect.objectContaining({ delivered: 6, cancelled: 2 }),
    );
    // delivered_count avvalgidek tashlab yuboriladi; market_name qo'shiladi.
    expect(res.data.cards.markets).toEqual([
      {
        market_id: '10',
        market_name: 'Yandex',
        orders_count: 2,
        total_price: 250000,
      },
    ]);
    expect(res.data.cards.couriers).toEqual({
      branch_couriers: 3,
      active_today: 1,
    });
  });

  it('getBranchStats: eski order-service market_name bermasa — null', async () => {
    branchRepo.findOne.mockResolvedValue({ id: '1', isDeleted: false });
    branchRepo.find.mockResolvedValueOnce([]);
    branchRepo.manager.query.mockResolvedValue([{ id: '1' }]);
    branchUserRepo.find.mockResolvedValue([{ user_id: 'c1' }]);
    orderClient.send.mockReturnValue(
      of({
        data: dashboardStats({
          markets: [
            {
              market_id: '10',
              orders_count: 2,
              delivered_count: 1,
              total_price: 250000,
            },
          ],
        }),
      }),
    );

    const res = await service.getBranchStats('1', {
      id: '1',
      roles: ['admin'],
    });

    expect(res.data.cards.markets).toEqual([
      {
        market_id: '10',
        market_name: null,
        orders_count: 2,
        total_price: 250000,
      },
    ]);
  });

  it('getBranchStats: order-service ishlamasa — nollar, cancelled ham 0', async () => {
    branchRepo.findOne.mockResolvedValue({ id: '1', isDeleted: false });
    branchRepo.find.mockResolvedValueOnce([]);
    branchRepo.manager.query.mockResolvedValue([{ id: '1' }]);
    branchUserRepo.find.mockResolvedValue([{ user_id: 'c1' }]);
    orderClient.send.mockReturnValue(throwError(() => new Error('down')));

    const res = await service.getBranchStats('1', {
      id: '1',
      roles: ['admin'],
    });

    expect(res.statusCode).toBe(200);
    expect(res.data.cards.orders).toEqual({
      total: 0,
      new: 0,
      on_the_road: 0,
      delivered: 0,
      returned: 0,
      cancelled: 0,
    });
    expect(res.data.cards.markets).toEqual([]);
  });

  it('getBranchMarketsAnalytics returns grouped market data', async () => {
    branchRepo.findOne.mockResolvedValue({ id: '1', isDeleted: false });
    branchRepo.find.mockResolvedValueOnce([]);
    branchRepo.manager.query.mockResolvedValue([{ id: '1' }]);
    branchUserRepo.find.mockResolvedValue([]);
    orderClient.send.mockReturnValue(of({ data: dashboardStats() }));

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
    branchRepo.manager.query.mockResolvedValue([{ id: '100' }, { id: '200' }]);
    branchUserRepo.count.mockResolvedValue(0);
    orderClient.send.mockReturnValue(of({ data: dashboardStats() }));

    const res = await service.getBranchStats('100', {
      id: 'u-manager',
      roles: ['branch'],
    });

    expect(res.statusCode).toBe(200);
    // Bitta chaqiruv, ichida ikkala filial ham bor (ilgari — ikki chaqiruv).
    const dashboardCalls = orderClient.send.mock.calls.filter(
      ([pattern]: [{ cmd: string }]) =>
        pattern.cmd === 'order.analytics.branch_dashboard',
    );
    expect(dashboardCalls).toHaveLength(1);
    expect(dashboardCalls[0][1].branch_ids).toEqual(
      expect.arrayContaining(['100', '200']),
    );
  });

  it('registrator stats includes only own branch (no descendants)', async () => {
    branchRepo.findOne.mockResolvedValue({ id: '300', isDeleted: false });
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '300', role: 'REGISTRATOR', isDeleted: false },
    ]);
    branchUserRepo.count.mockResolvedValue(0);
    orderClient.send.mockReturnValue(of({ data: dashboardStats() }));

    const res = await service.getBranchStats('300', {
      id: 'u-registrator',
      roles: ['branch'],
    });

    expect(res.statusCode).toBe(200);
    const dashboardCalls = orderClient.send.mock.calls.filter(
      ([pattern]: [{ cmd: string }]) =>
        pattern.cmd === 'order.analytics.branch_dashboard',
    );
    expect(dashboardCalls).toHaveLength(1);
    expect(dashboardCalls[0][1].branch_ids).toEqual(['300']);
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
    // The raw downstream error ("file down") is intentionally sanitised to a
    // generic message so internal failure detail is not surfaced to clients.
    expect(res.data.qr_generation_errors).toEqual([
      { batch_id: '601', message: 'File service unavailable' },
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
      service.dispatchPostToBranch('10', '900', '20', ['1001'], {
        id: '1',
        roles: ['admin'],
      }),
    ).rejects.toBeInstanceOf(RpcException);

    expect(logisticsClient.send).not.toHaveBeenCalled();
    expect(orderClient.send).not.toHaveBeenCalled();
  });

  /** Rad etilgan chaqiruvdan RpcException yukini ({statusCode, message}) oladi. */
  const rpcErrorOf = async (
    promise: Promise<unknown>,
  ): Promise<{ statusCode?: number; message?: string }> => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as {
        statusCode?: number;
        message?: string;
      };
    }
    throw new Error('chaqiruv rad etilishi kutilgandi');
  };

  const HQ_MANAGER_MESSAGE =
    "HQ (bosh ofis) ga menejer biriktirib bo'lmaydi. HQ ishlarini superadmin, admin va registratorlar bajaradi.";
  const adminRequester = { id: '1', roles: ['admin'] };

  /**
   * C8 — HQ'da menejer bo'lmaydi. POST /branches/:id/users ham, identity
   * createManager saga'si ham shu assignUserToBranch'dan o'tadi.
   */
  describe("HQ'da menejer yo'q (assignUserToBranch / updateBranch)", () => {
    const hqRow = () => ({
      id: '1',
      name: 'HQ Toshkent',
      code: 'HQ-TSHKNT',
      type: 'HQ',
      level: 0,
      parent_id: null,
      status: 'active',
      manager_id: null,
      isDeleted: false,
    });

    const identityUser = (id: string, role: string) =>
      identityClient.send.mockReturnValue(of({ data: { id, role } }));

    it("MANAGER → HQ: 400 o'zbekcha xabar bilan; qator ham, kassa ham yaratilmaydi", async () => {
      branchRepo.findOne.mockResolvedValue(hqRow());
      identityUser('u9', 'manager');

      const err = await rpcErrorOf(
        service.assignUserToBranch(
          { branch_id: '1', user_id: 'u9' },
          adminRequester,
        ),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: HQ_MANAGER_MESSAGE,
        }),
      );
      // Tekshiruv qator qidiruvi/tiklash va ensureBranchCashbox'dan OLDIN.
      expect(branchUserRepo.findOne).not.toHaveBeenCalled();
      expect(branchUserRepo.save).not.toHaveBeenCalled();
      expect(financeClient.send).not.toHaveBeenCalled();
    });

    it("HQ'dagi o'chirilgan MANAGER qatori qayta tiklanmaydi", async () => {
      branchRepo.findOne.mockResolvedValue(hqRow());
      identityUser('u9', 'manager');
      branchUserRepo.findOne.mockResolvedValue({
        id: 'bu-old',
        branch_id: '1',
        user_id: 'u9',
        role: 'MANAGER',
        isDeleted: true,
      });

      const err = await rpcErrorOf(
        service.assignUserToBranch(
          { branch_id: '1', user_id: 'u9', role: 'MANAGER' },
          adminRequester,
        ),
      );

      expect(err.statusCode).toBe(400);
      expect(branchUserRepo.save).not.toHaveBeenCalled();
      expect(financeClient.send).not.toHaveBeenCalled();
    });

    it('REGISTRATOR → HQ ruxsat etiladi (201), filial kassasi yaratilmaydi', async () => {
      branchRepo.findOne.mockResolvedValue(hqRow());
      identityUser('u5', 'registrator');
      branchUserRepo.findOne.mockResolvedValue(null);
      branchUserRepo.save.mockImplementation((row: any) =>
        Promise.resolve({ id: 'bu-new', ...row }),
      );

      const res = await service.assignUserToBranch(
        { branch_id: '1', user_id: 'u5' },
        adminRequester,
      );

      expect(res.statusCode).toBe(201);
      expect(branchUserRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          branch_id: '1',
          user_id: 'u5',
          role: 'REGISTRATOR',
        }),
      );
      expect(financeClient.send).not.toHaveBeenCalled();
    });

    it('COURIER → HQ ruxsat etiladi (201)', async () => {
      branchRepo.findOne.mockResolvedValue(hqRow());
      identityUser('263', 'courier');
      branchUserRepo.findOne.mockResolvedValue(null);
      branchUserRepo.save.mockImplementation((row: any) =>
        Promise.resolve({ id: 'bu-new', ...row }),
      );

      const res = await service.assignUserToBranch(
        { branch_id: '1', user_id: '263' },
        adminRequester,
      );

      expect(res.statusCode).toBe(201);
      expect(branchUserRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          branch_id: '1',
          user_id: '263',
          role: 'COURIER',
        }),
      );
    });

    it("MANAGER → REGIONAL o'zgarmagan: 201 va filial kassasi yaratiladi", async () => {
      branchRepo.findOne.mockResolvedValue({
        id: '20',
        type: 'REGIONAL',
        status: 'active',
        isDeleted: false,
      });
      identityUser('u9', 'manager');
      branchUserRepo.findOne.mockResolvedValue(null);
      branchUserRepo.save.mockImplementation((row: any) =>
        Promise.resolve({ id: 'bu-new', ...row }),
      );

      const res = await service.assignUserToBranch(
        { branch_id: '20', user_id: 'u9' },
        adminRequester,
      );

      expect(res.statusCode).toBe(201);
      expect(financeClient.send).toHaveBeenCalledWith(
        { cmd: 'finance.cashbox.create' },
        { user_id: '20', cashbox_type: 'branch' },
      );
    });

    it("updateBranch: HQ turini boshqa turga o'zgartirib bo'lmaydi (400)", async () => {
      branchRepo.findOne.mockResolvedValue(hqRow());

      const err = await rpcErrorOf(
        service.updateBranch(
          '1',
          { type: 'REGIONAL', parent_id: '5' } as any,
          adminRequester,
        ),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: "HQ filial turini o'zgartirib bo'lmaydi",
        }),
      );
      expect(branchRepo.save).not.toHaveBeenCalled();
    });

    it("updateBranch: HQ'ga manager_id yozib bo'lmaydi (400)", async () => {
      branchRepo.findOne.mockResolvedValue(hqRow());

      const err = await rpcErrorOf(
        service.updateBranch('1', { manager_id: '5' } as any, adminRequester),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: HQ_MANAGER_MESSAGE,
        }),
      );
      expect(branchRepo.save).not.toHaveBeenCalled();
    });

    it("updateBranch: HQ'da manager_id: null ruxsat (legacy ko'rsatkichni tozalash)", async () => {
      branchRepo.findOne.mockResolvedValue({ ...hqRow(), manager_id: '7' });
      branchRepo.find.mockResolvedValue([]);
      branchRepo.save.mockImplementation((row: any) => Promise.resolve(row));

      const res = await service.updateBranch(
        '1',
        { type: 'HQ', manager_id: null } as any,
        adminRequester,
      );

      expect(res.statusCode).toBe(200);
      expect(res.data.type).toBe('HQ');
      expect(res.data.manager_id).toBeNull();
    });
  });

  /**
   * C6 — HQ registratori pochtani filialga jo'nata oladi. Ruxsat faqat
   * dispatch uchun alohida helper orqali (assertCanWriteBranch kengaytirilmaydi).
   */
  describe('dispatchPostToBranch — HQ registratori va manzil tekshiruvi', () => {
    const branchesById: Record<string, Record<string, unknown>> = {
      '10': { id: '10', type: 'HQ', status: 'active', isDeleted: false },
      '20': { id: '20', type: 'REGIONAL', status: 'active', isDeleted: false },
      '21': { id: '21', type: 'HYBRID', status: 'active', isDeleted: false },
      '40': { id: '40', type: 'PICKUP', status: 'active', isDeleted: false },
      '50': {
        id: '50',
        type: 'REGIONAL',
        status: 'inactive',
        isDeleted: false,
      },
      '60': { id: '60', type: 'HQ', status: 'active', isDeleted: false },
    };
    const hqRegistrator = { id: '269', roles: ['registrator'] };

    /** HQ'da qabul qilingan (kuryerga berilmagan) buyurtma. */
    const hqOrder = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      branch_id: '10',
      status: 'received',
      region_id: '14',
      total_price: 150000,
      courier_id: null,
      holder_type: 'HQ',
      holder_courier_id: null,
      ...extra,
    });

    // Testlar bularni almashtiradi: logistics.post.find_by_ids va
    // logistics.post.orders_by_post javoblari.
    let postRow: Record<string, unknown> | null;
    let postOrders: Array<Record<string, unknown>>;

    beforeEach(() => {
      // Kuryersiz HQ pochtasi: logistics uni courier_id = '0' bilan yaratadi.
      postRow = { id: '900', courier_id: '0', status: 'new', branch_id: null };
      postOrders = [hqOrder('1001')];
      branchRepo.findOne.mockImplementation(({ where }: any) =>
        Promise.resolve(branchesById[String(where?.id)] ?? null),
      );
      // Manzilda menejer bor (assertBranchHasManager).
      branchUserRepo.findOne.mockResolvedValue({ id: 'manager-row' });
      logisticsClient.send.mockImplementation(
        ({ cmd }: { cmd: string }, payload: any) => {
          if (cmd === 'logistics.post.find_by_ids') {
            return of({
              statusCode: 200,
              message: 'Posts found',
              data: postRow ? [postRow] : [],
            });
          }
          if (cmd === 'logistics.post.orders_by_post') {
            return of({ data: postOrders });
          }
          if (cmd === 'logistics.post.receive_orders') {
            return of({
              data: (payload?.orders ?? []).map((row: any) => ({
                order_id: row.order_id,
                post_id: '777',
              })),
            });
          }
          return of({ data: {} });
        },
      );
      orderClient.send.mockReturnValue(of({ data: {} }));
    });

    const registratorOnHq = () =>
      branchUserRepo.find.mockResolvedValue([
        { branch_id: '10', role: 'REGISTRATOR' },
      ]);

    const updatedOrderIds = () =>
      orderClient.send.mock.calls
        .filter(
          ([pattern]: [{ cmd: string }]) => pattern.cmd === 'order.update',
        )
        .map(([, payload]: [unknown, { id: string }]) => payload.id);

    const logisticsCmds = () =>
      logisticsClient.send.mock.calls.map(
        ([pattern]: [{ cmd: string }]) => pattern.cmd,
      );

    it("HQ registratori menejeri bor REGIONAL filialga jo'nata oladi", async () => {
      branchUserRepo.find.mockResolvedValue([
        { branch_id: '10', role: 'REGISTRATOR' },
      ]);

      const res = await service.dispatchPostToBranch(
        '10',
        '900',
        '20',
        ['1001'],
        hqRegistrator,
      );

      expect(res.statusCode).toBe(200);
      // Ruxsat — so'rovchining AYNAN manba filialdagi faol qatori bo'yicha.
      expect(branchUserRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user_id: '269', branch_id: '10', isDeleted: false },
        }),
      );
      // Pochta avval (buyurtmalardan oldin) faqat-o'qish chaqiruvi bilan
      // tekshiriladi, keyin buyurtmalar o'qiladi va ko'chiriladi.
      expect(logisticsCmds()).toEqual([
        'logistics.post.find_by_ids',
        'logistics.post.orders_by_post',
        'logistics.post.receive_orders',
        'logistics.post.delete',
      ]);
      expect(logisticsClient.send).toHaveBeenCalledWith(
        { cmd: 'logistics.post.find_by_ids' },
        { ids: ['900'] },
      );
      expect(orderClient.send).toHaveBeenCalledWith(
        { cmd: 'order.update' },
        expect.objectContaining({
          id: '1001',
          dto: expect.objectContaining({
            branch_id: '20',
            holder_branch_id: '20',
            holder_courier_id: null,
            status: 'on the road',
          }),
        }),
      );
      expect(res.data).toEqual(
        expect.objectContaining({
          moved_orders_count: 1,
          moved_order_ids: ['1001'],
          post_deleted: true,
        }),
      );
    });

    it("HQ registratori HYBRID filialga ham jo'nata oladi", async () => {
      branchUserRepo.find.mockResolvedValue([
        { branch_id: '10', role: 'registrator' },
      ]);

      const res = await service.dispatchPostToBranch(
        '10',
        '900',
        '21',
        ['1001'],
        hqRegistrator,
      );

      expect(res.statusCode).toBe(200);
    });

    it("HQ'dagi MANAGER qatori 403 (faqat REGISTRATOR qatori jo'nata oladi; HQ'da menejer yo'q)", async () => {
      branchUserRepo.find.mockResolvedValue([
        { branch_id: '10', role: 'MANAGER' },
      ]);

      const err = await rpcErrorOf(
        service.dispatchPostToBranch('10', '900', '20', ['1001'], {
          id: '198',
          roles: ['manager'],
        }),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 403,
          message: "Bu filialdan pochta jo'natishga ruxsat yo'q",
        }),
      );
      expect(logisticsClient.send).not.toHaveBeenCalled();
      expect(orderClient.send).not.toHaveBeenCalled();
    });

    it("o'chirilgan REGISTRATOR qatori hisobga olinmaydi (so'rov faqat faol qatorlar bo'yicha)", async () => {
      // Repo so'rovi isDeleted: false bilan ketadi — o'chirilgan qator kelmaydi.
      branchUserRepo.find.mockResolvedValue([]);

      const err = await rpcErrorOf(
        service.dispatchPostToBranch(
          '10',
          '900',
          '20',
          ['1001'],
          hqRegistrator,
        ),
      );

      expect(err.statusCode).toBe(403);
      expect(branchUserRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isDeleted: false }),
        }),
      );
    });

    it('boshqa filial registratori 403; logistics/order chaqirilmaydi', async () => {
      branchUserRepo.find.mockResolvedValue([
        { branch_id: '30', role: 'REGISTRATOR' },
      ]);

      const err = await rpcErrorOf(
        service.dispatchPostToBranch('10', '900', '20', ['1001'], {
          id: '301',
          roles: ['registrator'],
        }),
      );

      expect(err.statusCode).toBe(403);
      expect(logisticsClient.send).not.toHaveBeenCalled();
      expect(orderClient.send).not.toHaveBeenCalled();
    });

    it("HQ'dagi COURIER qatori 403", async () => {
      branchUserRepo.find.mockResolvedValue([
        { branch_id: '10', role: 'COURIER' },
      ]);

      const err = await rpcErrorOf(
        service.dispatchPostToBranch('10', '900', '20', ['1001'], {
          id: '263',
          roles: ['courier'],
        }),
      );

      expect(err.statusCode).toBe(403);
      expect(logisticsClient.send).not.toHaveBeenCalled();
    });

    it("ruxsatsiz so'rovchi + menejersiz manzil → 403 (400 emas): ruxsat oldin tekshiriladi", async () => {
      branchUserRepo.find.mockResolvedValue([]);
      branchUserRepo.findOne.mockResolvedValue(null);

      const err = await rpcErrorOf(
        service.dispatchPostToBranch('10', '900', '20', ['1001'], {
          id: '301',
          roles: ['registrator'],
        }),
      );

      expect(err.statusCode).toBe(403);
    });

    it.each([
      [
        'PICKUP',
        '40',
        "Pochta faqat REGIONAL yoki HYBRID filialga jo'natiladi (manzil filial turi: PICKUP)",
      ],
      [
        'HQ',
        '60',
        "Pochta faqat REGIONAL yoki HYBRID filialga jo'natiladi (manzil filial turi: HQ)",
      ],
      [
        'nofaol',
        '50',
        "Manzil filial faol emas — nofaol filialga pochta jo'natib bo'lmaydi",
      ],
      [
        "manbaning o'zi",
        '10',
        "Pochtani manba filialning o'ziga jo'natib bo'lmaydi — boshqa filialni tanlang",
      ],
    ])(
      'manzil %s → 400; jo‘natish boshlanmaydi',
      async (_label, destinationId, message) => {
        branchUserRepo.find.mockResolvedValue([
          { branch_id: '10', role: 'REGISTRATOR' },
        ]);

        const err = await rpcErrorOf(
          service.dispatchPostToBranch(
            '10',
            '900',
            destinationId,
            ['1001'],
            hqRegistrator,
          ),
        );

        expect(err).toEqual(
          expect.objectContaining({ statusCode: 400, message }),
        );
        // Manzil tekshiruvi menejer tekshiruvidan ham, jo'natishdan ham oldin.
        expect(branchUserRepo.findOne).not.toHaveBeenCalled();
        expect(logisticsClient.send).not.toHaveBeenCalled();
        expect(orderClient.send).not.toHaveBeenCalled();
      },
    );

    it("superadmin ham PICKUP'ga jo'nata olmaydi (400)", async () => {
      const err = await rpcErrorOf(
        service.dispatchPostToBranch('10', '900', '40', ['1001'], {
          id: '1',
          roles: ['superadmin'],
        }),
      );

      expect(err.statusCode).toBe(400);
      expect(logisticsClient.send).not.toHaveBeenCalled();
    });

    /** Hech narsa ko'chirilmaganini tekshiradi (logistics ham, order ham). */
    const expectNothingMoved = () => {
      expect(logisticsCmds()).not.toContain('logistics.post.receive_orders');
      expect(logisticsCmds()).not.toContain('logistics.post.delete');
      expect(orderClient.send).not.toHaveBeenCalled();
    };

    it("holati 'new' bo'lgan HQ buyurtmasi ham jo'natiladi", async () => {
      registratorOnHq();
      postOrders = [hqOrder('1001', { status: 'new' })];

      const res = await service.dispatchPostToBranch(
        '10',
        '900',
        '20',
        ['1001'],
        hqRegistrator,
      );

      expect(res.statusCode).toBe(200);
      expect(updatedOrderIds()).toEqual(['1001']);
    });

    it("registrator kuryerdagi buyurtmani jo'natsa → 400, xabarda id bor; hech narsa ko'chirilmaydi", async () => {
      registratorOnHq();
      postOrders = [
        hqOrder('1001'),
        hqOrder('1002', {
          status: 'on the road',
          courier_id: '263',
          holder_type: 'COURIER',
          holder_courier_id: '263',
        }),
      ];

      const err = await rpcErrorOf(
        service.dispatchPostToBranch(
          '10',
          '900',
          '20',
          ['1001', '1002'],
          hqRegistrator,
        ),
      );

      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('#1002');
      expect(err.message).not.toContain('#1001');
      expect(err.message).toContain("jo'natib bo'lmaydi");
      expect((err as any).data).toEqual(
        expect.objectContaining({
          non_dispatchable_order_ids: ['1002'],
          reasons: { wrong_status_count: 1, courier_held_count: 1 },
        }),
      );
      expectNothingMoved();
    });

    it.each([
      [
        "holati 'received', lekin holder_courier_id bor",
        { holder_courier_id: '263' },
      ],
      [
        "holati 'new', lekin courier_id bor",
        { status: 'new', courier_id: '263' },
      ],
    ])(
      '%s → 400 (kuryer izi holatdan qat’iy nazar taqiqlanadi)',
      async (_label, extra) => {
        registratorOnHq();
        postOrders = [hqOrder('1003', extra)];

        const err = await rpcErrorOf(
          service.dispatchPostToBranch(
            '10',
            '900',
            '20',
            ['1003'],
            hqRegistrator,
          ),
        );

        expect(err.statusCode).toBe(400);
        expect(err.message).toContain('#1003');
        expect((err as any).data.reasons).toEqual({
          wrong_status_count: 0,
          courier_held_count: 1,
        });
        expectNothingMoved();
      },
    );

    it("sotilgan buyurtma → 400 (kuryer izi bo'lmasa ham); hech narsa ko'chirilmaydi", async () => {
      registratorOnHq();
      postOrders = [hqOrder('1001'), hqOrder('1004', { status: 'sold' })];

      const err = await rpcErrorOf(
        service.dispatchPostToBranch(
          '10',
          '900',
          '20',
          ['1001', '1004'],
          hqRegistrator,
        ),
      );

      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('#1004');
      expect((err as any).data).toEqual(
        expect.objectContaining({
          non_dispatchable_order_ids: ['1004'],
          reasons: { wrong_status_count: 1, courier_held_count: 0 },
        }),
      );
      expectNothingMoved();
    });

    it.each([['superadmin'], ['admin']])(
      "%s ham sotilgan/kuryerdagi buyurtmani jo'nata olmaydi (400)",
      async (role) => {
        postOrders = [
          hqOrder('1004', { status: 'sold', courier_id: '263' }),
          hqOrder('1005', { status: 'waiting', holder_courier_id: '263' }),
        ];

        const err = await rpcErrorOf(
          service.dispatchPostToBranch('10', '900', '20', ['1004', '1005'], {
            id: '1',
            roles: [role],
          }),
        );

        expect(err.statusCode).toBe(400);
        expect(err.message).toContain('#1004, #1005');
        expectNothingMoved();
      },
    );

    it.each([
      [
        'kuryer pochtasi (courier_id bor, holati sent)',
        { courier_id: '263', status: 'sent' },
        'kuryerga biriktirilgan (kuryer #263)',
      ],
      [
        "kuryer pochtasi (courier_id bor, holati 'new')",
        { courier_id: '263', status: 'new' },
        'kuryerga biriktirilgan (kuryer #263)',
      ],
      [
        "kuryersiz, lekin 'sent' pochta",
        { courier_id: '0', status: 'sent' },
        'holati "sent"',
      ],
      [
        "kuryersiz, lekin 'received' pochta",
        { courier_id: null, status: 'received' },
        'holati "received"',
      ],
    ])(
      "%s → butun so'rov 400; buyurtmalar o'qilmaydi",
      async (_label, overrides, messagePart) => {
        registratorOnHq();
        postRow = { ...(postRow as Record<string, unknown>), ...overrides };

        const err = await rpcErrorOf(
          service.dispatchPostToBranch(
            '10',
            '900',
            '20',
            ['1001'],
            hqRegistrator,
          ),
        );

        expect(err.statusCode).toBe(400);
        expect(err.message).toContain('Pochta #900');
        expect(err.message).toContain(messagePart);
        // Faqat pochta o'qildi: orders_by_post ham, ko'chirish ham yo'q.
        expect(logisticsCmds()).toEqual(['logistics.post.find_by_ids']);
        expect(orderClient.send).not.toHaveBeenCalled();
      },
    );

    it("superadmin ham kuryer pochtasini jo'nata olmaydi (400)", async () => {
      postRow = { id: '900', courier_id: '263', status: 'sent' };

      const err = await rpcErrorOf(
        service.dispatchPostToBranch('10', '900', '20', ['1001'], {
          id: '1',
          roles: ['superadmin'],
        }),
      );

      expect(err.statusCode).toBe(400);
      expect(logisticsCmds()).toEqual(['logistics.post.find_by_ids']);
      expect(orderClient.send).not.toHaveBeenCalled();
    });

    it("pochta topilmasa → 404; buyurtmalar o'qilmaydi", async () => {
      registratorOnHq();
      postRow = null;

      const err = await rpcErrorOf(
        service.dispatchPostToBranch(
          '10',
          '900',
          '20',
          ['1001'],
          hqRegistrator,
        ),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 404,
          message: 'Pochta #900 topilmadi',
        }),
      );
      expect(logisticsCmds()).toEqual(['logistics.post.find_by_ids']);
    });

    it("CANCELLED/CLOSED avvalgidek jimgina chetlab o'tiladi (kuryer izi bo'lsa ham) — qolgani jo'natiladi", async () => {
      registratorOnHq();
      postOrders = [
        hqOrder('1001'),
        hqOrder('1006', { status: 'cancelled', courier_id: '263' }),
        hqOrder('1007', { status: 'closed', holder_courier_id: '263' }),
      ];

      const res = await service.dispatchPostToBranch(
        '10',
        '900',
        '20',
        ['1001', '1006', '1007'],
        hqRegistrator,
      );

      expect(res.statusCode).toBe(200);
      expect(res.data.moved_order_ids).toEqual(['1001']);
      expect(updatedOrderIds()).toEqual(['1001']);
      // Postda ko'chirilmagan buyurtmalar qoldi — post o'chirilmaydi.
      expect(res.data.post_deleted).toBe(false);
      expect(logisticsCmds()).not.toContain('logistics.post.delete');
    });

    it("faqat CANCELLED/CLOSED tanlansa — avvalgi 400 (mos order yo'q)", async () => {
      registratorOnHq();
      postOrders = [
        hqOrder('1006', { status: 'cancelled', courier_id: '263' }),
      ];

      const err = await rpcErrorOf(
        service.dispatchPostToBranch(
          '10',
          '900',
          '20',
          ['1006'],
          hqRegistrator,
        ),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: "Post ichida jo'natishga mos order topilmadi",
        }),
      );
      expectNothingMoved();
    });

    it('ko\'p buyurtma: xabarda 20 ta id, qolgani "+N ta"; data\'da hammasi', async () => {
      registratorOnHq();
      const soldIds = Array.from({ length: 23 }, (_, i) => String(2000 + i));
      postOrders = soldIds.map((id) => hqOrder(id, { status: 'sold' }));

      const err = await rpcErrorOf(
        service.dispatchPostToBranch('10', '900', '20', soldIds, hqRegistrator),
      );

      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('23 ta buyurtmani');
      expect(err.message).toContain('#2019 (+3 ta)');
      expect(err.message).not.toContain('#2020');
      expect((err as any).data.non_dispatchable_order_ids).toEqual(soldIds);
      expectNothingMoved();
    });

    it('regressiya: HQ registratori filialga yozish amallarida hamon 403 oladi', async () => {
      branchUserRepo.find.mockResolvedValue([
        { branch_id: '10', role: 'REGISTRATOR', isDeleted: false },
      ]);

      const attempts = [
        () =>
          service.assignUserToBranch(
            { branch_id: '10', user_id: '500' },
            hqRegistrator,
          ),
        () =>
          service.removeUserFromBranch(
            { branch_id: '10', user_id: '500' },
            hqRegistrator,
          ),
        () =>
          service.setBranchConfig(
            { branch_id: '10', config_key: 'k', config_value: { a: 1 } },
            hqRegistrator,
          ),
      ];
      for (const attempt of attempts) {
        const err = await rpcErrorOf(attempt());
        expect(err.statusCode).toBe(403);
      }
      expect(branchUserRepo.save).not.toHaveBeenCalled();
      expect(branchConfigRepo.save).not.toHaveBeenCalled();
    });
  });

  /**
   * C5 — pochta jo'natish oynasi uchun manzil filiallar (pul maydonlarisiz).
   */
  describe('findDispatchDestinations', () => {
    const destinationRows = [
      {
        id: '14',
        name: 'E2E Filial Sirdaryo',
        code: 'SIR',
        type: 'REGIONAL',
        status: 'active',
        phone_number: '+998712000014',
        region_id: '7',
        manager_id: null,
        ownership: 'partner',
        per_order_share: 5000,
        isDeleted: false,
      },
      {
        id: '17',
        name: 'Hybrid filial',
        code: 'HYB',
        type: 'HYBRID',
        status: 'active',
        phone_number: null,
        region_id: null,
        manager_id: null,
        isDeleted: false,
      },
    ];

    const assignmentsByUser: Record<string, Array<Record<string, unknown>>> = {
      // HQ registratori
      '269': [{ branch_id: '1', role: 'REGISTRATOR' }],
      // REGIONAL filial registratori
      '301': [{ branch_id: '20', role: 'REGISTRATOR' }],
      // HQ kuryeri
      '263': [{ branch_id: '1', role: 'COURIER' }],
    };

    beforeEach(() => {
      branchRepo.find.mockResolvedValue(destinationRows);
      // HQ tekshiruvi: branchRepo.findOne({ id: In([...]), type: HQ }).
      branchRepo.findOne.mockImplementation(({ where }: any) => {
        const ids: string[] = where?.id?.value ?? [];
        return Promise.resolve(
          where?.type === 'HQ' && ids.includes('1') ? { id: '1' } : null,
        );
      });
      branchUserRepo.find.mockImplementation(({ where }: any) => {
        if (where?.role === 'MANAGER') {
          return Promise.resolve([
            { id: 'bu-m', branch_id: '14', user_id: '198' },
          ]);
        }
        return Promise.resolve(assignmentsByUser[String(where?.user_id)] ?? []);
      });
      identityClient.send.mockImplementation(({ cmd }: { cmd: string }) => {
        if (cmd === 'identity.user.find_all') {
          return of({
            data: {
              items: [
                {
                  id: '198',
                  name: 'Sirdaryo menejeri',
                  phone_number: '+998903009002',
                  role: 'manager',
                  salary: 3000000,
                },
              ],
            },
          });
        }
        return of({ data: null });
      });
      logisticsClient.send.mockImplementation(({ cmd }: { cmd: string }) => {
        if (cmd === 'logistics.region.find_by_ids') {
          return of({
            data: [{ id: '7', name: 'Sirdaryo viloyati', sato_code: '1724' }],
          });
        }
        return of({ data: [] });
      });
    });

    const expectedItems = [
      {
        id: '14',
        name: 'E2E Filial Sirdaryo',
        code: 'SIR',
        type: 'REGIONAL',
        status: 'active',
        phone_number: '+998712000014',
        region_id: '7',
        region: { id: '7', name: 'Sirdaryo viloyati' },
        has_manager: true,
        manager: {
          id: '198',
          name: 'Sirdaryo menejeri',
          phone_number: '+998903009002',
        },
      },
      {
        id: '17',
        name: 'Hybrid filial',
        code: 'HYB',
        type: 'HYBRID',
        status: 'active',
        phone_number: null,
        region_id: null,
        region: null,
        has_manager: false,
        manager: null,
      },
    ];

    it('superadmin: faol REGIONAL/HYBRID filiallar menejeri bilan; pul maydonlari yo‘q', async () => {
      const res = await service.findDispatchDestinations(
        {},
        { id: '1', roles: ['superadmin'] },
      );

      expect(res.statusCode).toBe(200);
      expect(res.data).toEqual({ items: expectedItems, total: 2 });

      const [{ where }] = branchRepo.find.mock.calls[0];
      expect(where).toEqual(
        expect.objectContaining({ isDeleted: false, status: 'active' }),
      );
      expect(where.type.value).toEqual(['REGIONAL', 'HYBRID']);
      expect(where).not.toHaveProperty('region_id');

      for (const item of res.data.items) {
        for (const key of [
          'payment',
          'olinishi_kerak',
          'berilishi_kerak',
          'per_order_share',
          'ownership',
          'cashbox',
        ]) {
          expect(item).not.toHaveProperty(key);
        }
      }
      expect(financeClient.send).not.toHaveBeenCalled();
      expect(orderClient.send).not.toHaveBeenCalled();

      // Menejer profillari BITTA identity chaqiruvida (filial boshiga emas).
      const identityCalls = identityClient.send.mock.calls;
      expect(identityCalls).toHaveLength(1);
      expect(identityCalls[0][0]).toEqual({ cmd: 'identity.user.find_all' });
      expect(identityCalls[0][1]).toEqual({
        query: { user_ids: ['198'], page: 1, limit: 100 },
      });
    });

    it('HQ registratori xuddi shu ro‘yxatni oladi', async () => {
      const res = await service.findDispatchDestinations(
        {},
        { id: '269', roles: ['registrator'] },
      );

      expect(res.statusCode).toBe(200);
      expect(res.data.items).toEqual(expectedItems);
    });

    it('region_id filtri so‘rovga qo‘shiladi', async () => {
      await service.findDispatchDestinations(
        { region_id: '7' },
        { id: '1', roles: ['admin'] },
      );

      const [{ where }] = branchRepo.find.mock.calls[0];
      expect(where.region_id).toBe('7');
    });

    it("noto'g'ri region_id → 400", async () => {
      const err = await rpcErrorOf(
        service.findDispatchDestinations(
          { region_id: 'abc' },
          { id: '1', roles: ['admin'] },
        ),
      );

      expect(err.statusCode).toBe(400);
      expect(branchRepo.find).not.toHaveBeenCalled();
    });

    it.each([
      ['REGIONAL filial registratori', { id: '301', roles: ['registrator'] }],
      ['HQ kuryeri', { id: '263', roles: ['courier'] }],
      ['biriktirilmagan foydalanuvchi', { id: '999', roles: ['registrator'] }],
    ])('%s → 403', async (_label, requester) => {
      const err = await rpcErrorOf(
        service.findDispatchDestinations({}, requester),
      );

      expect(err.statusCode).toBe(403);
      expect(branchRepo.find).not.toHaveBeenCalled();
    });

    it("identity javob bermasa ham ro'yxat qaytadi (menejer id bilan, ismsiz)", async () => {
      identityClient.send.mockImplementation(() => {
        throw new Error('identity down');
      });

      const res = await service.findDispatchDestinations(
        {},
        { id: '1', roles: ['admin'] },
      );

      expect(res.statusCode).toBe(200);
      expect(res.data.items[0]).toEqual(
        expect.objectContaining({
          has_manager: true,
          manager: { id: '198', name: '', phone_number: null },
        }),
      );
    });
  });
});
