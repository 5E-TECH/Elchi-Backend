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
      CITY: 'CITY',
      REGIONAL: 'REGIONAL',
      DISTRICT: 'DISTRICT',
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

  beforeEach(() => {
    branchRepo = {
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn(),
      save: jest.fn(),
      create: jest.fn((v) => v),
      createQueryBuilder: jest.fn(),
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
    identityClient = { send: jest.fn().mockReturnValue(of({ data: { id: 'u1' } })) };
    logisticsClient = { send: jest.fn().mockReturnValue(of({ data: [] })) };
    orderClient = { send: jest.fn().mockReturnValue(of({ data: [] })) };
    fileClient = { send: jest.fn().mockReturnValue(of({ data: { key: 'k1', url: 'u1' } })) };

    service = new BranchServiceService(
      branchRepo,
      branchUserRepo,
      branchConfigRepo,
      identityClient,
      logisticsClient,
      orderClient,
      fileClient,
    );
  });

  it('createBranch creates new branch', async () => {
    branchRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'hq', level: 0, type: 'HQ', isDeleted: false });
    branchRepo.save.mockResolvedValue({ id: 'b1', name: 'Main' });

    const res = await service.createBranch({ name: 'Main', type: 'REGIONAL', code: 'SAM', parent_id: 'hq' } as any);

    expect(res.statusCode).toBe(201);
    expect(res.data.id).toBe('b1');
  });

  it('createBranch throws 400 when name missing', async () => {
    await expect(service.createBranch({} as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('createBranch throws 409 on duplicate name', async () => {
    branchRepo.findOne.mockResolvedValue({ id: 'x' });
    await expect(service.createBranch({ name: 'Main', type: 'HQ', code: 'HQ-TSHKNT' } as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('updateBranch throws 400 on invalid status', async () => {
    branchRepo.findOne.mockResolvedValue({ id: 'b1', name: 'A', status: 'active', isDeleted: false });
    await expect(
      service.updateBranch('b1', { status: 'bad' } as any, { id: '1', roles: ['admin'] }),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('assignUserToBranch throws when branch_id is missing', async () => {
    await expect(service.assignUserToBranch({ user_id: 'u1' } as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('assignUserToBranch throws conflict if user in another branch', async () => {
    branchRepo.findOne.mockResolvedValue({ id: 'b1', isDeleted: false });
    branchUserRepo.findOne.mockResolvedValueOnce({ branch_id: 'b2', user_id: 'u1', isDeleted: false });

    await expect(
      service.assignUserToBranch(
        { branch_id: 'b1', user_id: 'u1' } as any,
        { id: '1', roles: ['admin'] },
      ),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('setBranchConfig creates config when absent', async () => {
    branchRepo.findOne.mockResolvedValue({ id: 'b1', isDeleted: false });
    branchConfigRepo.findOne.mockResolvedValue(null);
    branchConfigRepo.save.mockResolvedValue({ id: 'c1', branch_id: 'b1', config_key: 'working_hours' });

    const res = await service.setBranchConfig(
      { branch_id: 'b1', config_key: 'working_hours', config_value: { a: 1 } } as any,
      { id: '1', roles: ['admin'] },
    );

    expect(res.statusCode).toBe(201);
    expect(res.data.id).toBe('c1');
  });

  it('deleteBranch marks branch as deleted', async () => {
    branchRepo.findOne.mockResolvedValue({ id: 'b1', status: 'active', isDeleted: false });
    branchRepo.save.mockResolvedValue({ id: 'b1', status: 'inactive', isDeleted: true });

    const res = await service.deleteBranch('b1', { id: '1', roles: ['admin'] });

    expect(res.statusCode).toBe(200);
    expect(res.data.id).toBe('b1');
  });

  it('onModuleInit auto-creates HQ with HQ-TSHKNT code', async () => {
    branchRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
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
    branchRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'existing-hq', type: 'HQ', isDeleted: false });

    await expect(
      service.createBranch({
        name: 'HQ2',
        type: 'HQ',
        code: 'HQ-TSHKNT-2',
      } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('createBranch blocks duplicate code', async () => {
    branchRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'b1', code: 'SAM', isDeleted: false });

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
      service.updateBranch('b1', { parent_id: 'child1', type: 'REGIONAL' } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('createBranch computes level automatically from parent', async () => {
    branchRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'hq', level: 0, type: 'HQ', isDeleted: false });
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
      { id: '2', name: 'Samarqand', parent_id: '1', level: 1, isDeleted: false },
      { id: '3', name: "Kattaqo'rg'on", parent_id: '2', level: 2, isDeleted: false },
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
      { id: '2', name: 'Samarqand', parent_id: '1', level: 1, isDeleted: false },
      { id: '3', name: "Kattaqo'rg'on", parent_id: '2', level: 2, isDeleted: false },
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
    branchRepo.findOne.mockResolvedValue({
      id: '200',
      name: 'Child branch',
      isDeleted: false,
      region_id: null,
      district_id: null,
      parent_id: '100',
    });

    const readRes = await service.findBranchById('200', { id: '10', roles: ['branch'] });
    expect(readRes.statusCode).toBe(200);

    await expect(
      service.updateBranch('200', { name: 'New child name' } as any, { id: '10', roles: ['branch'] }),
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
      { branch_id: '100', role: 'OPERATOR', isDeleted: false },
    ]);
    branchUserRepo.findOne.mockResolvedValue({
      id: 'bu1',
      branch_id: '100',
      user_id: 'u1',
      role: 'OPERATOR',
      isDeleted: false,
      createdAt: new Date(),
    });
    branchRepo.findOne.mockResolvedValue({
      id: '100',
      name: 'Samarkand',
      isDeleted: false,
    });

    const res = await service.findUserBranch('u1', { id: 'u1', roles: ['operator'] });

    expect(res.statusCode).toBe(200);
    expect(res.data.branch_id).toBe('100');
    expect(res.data.role).toBe('OPERATOR');
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
      );

    const res = await service.getBranchStats('1', { id: '1', roles: ['admin'] });

    expect(res.statusCode).toBe(200);
    expect(res.data.today_orders_count).toBe(2);
    expect(res.data.week_orders_count).toBe(2);
    expect(res.data.active_batches_count).toBe(2);
    expect(res.data.couriers_count).toBe(3);
  });

  it('getBranchMarketsAnalytics returns grouped market data', async () => {
    branchRepo.findOne.mockResolvedValue({ id: '1', isDeleted: false });
    branchRepo.find.mockResolvedValueOnce([]);
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

    const res = await service.getBranchMarketsAnalytics('1', { id: '1', roles: ['admin'] });

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
    branchUserRepo.count.mockResolvedValue(0);
    orderClient.send
      .mockReturnValueOnce(of({ data: [] }))
      .mockReturnValueOnce(of({ data: [] }));

    const res = await service.getBranchStats('100', { id: 'u-manager', roles: ['branch'] });

    expect(res.statusCode).toBe(200);
    expect(orderClient.send).toHaveBeenCalledTimes(2);
    expect(orderClient.send).toHaveBeenNthCalledWith(
      1,
      { cmd: 'order.find_all' },
      expect.objectContaining({ query: expect.objectContaining({ branch_id: '100' }) }),
    );
    expect(orderClient.send).toHaveBeenNthCalledWith(
      2,
      { cmd: 'order.find_all' },
      expect.objectContaining({ query: expect.objectContaining({ branch_id: '200' }) }),
    );
  });

  it('operator stats includes only own branch (no descendants)', async () => {
    branchRepo.findOne.mockResolvedValue({ id: '300', isDeleted: false });
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '300', role: 'OPERATOR', isDeleted: false },
    ]);
    branchUserRepo.count.mockResolvedValue(0);
    orderClient.send.mockReturnValueOnce(of({ data: [] }));

    const res = await service.getBranchStats('300', { id: 'u-operator', roles: ['operator'] });

    expect(res.statusCode).toBe(200);
    expect(orderClient.send).toHaveBeenCalledTimes(1);
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.find_all' },
      expect.objectContaining({ query: expect.objectContaining({ branch_id: '300' }) }),
    );
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
    const statsRes = await service.getBranchStats('1', { id: '1', roles: ['admin'] });
    const statsMs = Date.now() - statsStart;

    const marketsStart = Date.now();
    const marketsRes = await service.getBranchMarketsAnalytics('1', { id: '1', roles: ['admin'] });
    const marketsMs = Date.now() - marketsStart;

    expect(statsRes.statusCode).toBe(200);
    expect(marketsRes.statusCode).toBe(200);
    expect(statsMs).toBeLessThan(300);
    expect(marketsMs).toBeLessThan(300);
  });

  it('createTransferBatches creates batches and generates QR files', async () => {
    branchRepo.findOne
      .mockResolvedValueOnce({ id: '10', isDeleted: false })
      .mockResolvedValueOnce({ id: '1', isDeleted: false });
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '10', role: 'OPERATOR', isDeleted: false },
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
      of({ data: { key: 'branch-transfer-batches-1.png', url: 'https://minio/u1' } }),
    );

    const res = await service.createTransferBatches(
      '10',
      {
        destination_branch_id: '1',
        direction: 'FORWARD',
        request_key: 'req_create_batch_001',
      },
      { id: '77', roles: ['operator'] },
    );

    expect(res.statusCode).toBe(201);
    expect(res.data.batches).toHaveLength(1);
    expect(res.data.batches[0].qr_file).toEqual(
      expect.objectContaining({ key: 'branch-transfer-batches-1.png' }),
    );
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.transfer_batch.create' },
      expect.objectContaining({ source_branch_id: '10', destination_branch_id: '1' }),
    );
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.transfer_batch.history.add' },
      expect.objectContaining({ batch_id: '501', notes: '[STEP] QR_GENERATED' }),
    );
  });

  it('createTransferBatches rollbacks batches when QR generation fails', async () => {
    branchRepo.findOne
      .mockResolvedValueOnce({ id: '10', isDeleted: false })
      .mockResolvedValueOnce({ id: '1', isDeleted: false });
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '10', role: 'OPERATOR', isDeleted: false },
    ]);
    orderClient.send
      .mockReturnValueOnce(
        of({
          statusCode: 201,
          data: {
            idempotent: false,
            batches: [{ id: '601', qr_code_token: 'BTB-fail9988', target_region_id: '6' }],
          },
        }),
      )
      .mockReturnValueOnce(of({ statusCode: 201, data: { id: 'h-2' } }))
      .mockReturnValueOnce(of({ statusCode: 200, data: { batch_ids: ['601'] } }));
    fileClient.send.mockImplementation(() => {
      throw new Error('file down');
    });

    await expect(
      service.createTransferBatches(
        '10',
        {
          destination_branch_id: '1',
          direction: 'FORWARD',
          request_key: 'req_create_batch_002',
        },
        { id: '77', roles: ['operator'] },
      ),
    ).rejects.toBeInstanceOf(RpcException);

    expect(orderClient.send).toHaveBeenNthCalledWith(
      2,
      { cmd: 'order.transfer_batch.cancel_many' },
      expect.objectContaining({ batch_ids: ['601'], remove_order_bindings: true }),
    );
  });

  it('sendTransferBatch updates batch status to SENT through order service', async () => {
    orderClient.send
      .mockReturnValueOnce(of({ data: { id: '701', source_branch_id: '10' } }))
      .mockReturnValueOnce(of({ statusCode: 200, data: { id: '701', status: 'SENT' } }));
    branchUserRepo.find.mockResolvedValue([
      { branch_id: '10', role: 'OPERATOR', isDeleted: false },
    ]);

    const res = await service.sendTransferBatch(
      '701',
      {
        vehicle_plate: '01 A 123 AB',
        driver_name: 'Haydovchi',
        driver_phone: '+998901234567',
      },
      { id: '77', roles: ['operator'] },
    );

    expect(res).toEqual(expect.objectContaining({ statusCode: 200 }));
    expect(orderClient.send).toHaveBeenCalledWith(
      { cmd: 'order.transfer_batch.send' },
      expect.objectContaining({ batch_id: '701', vehicle_plate: '01 A 123 AB' }),
    );
  });

  it("sendTransferBatch fails when vehicle data is empty", async () => {
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
      .mockReturnValueOnce(of({ data: { id: '801', destination_branch_id: '20' } }))
      .mockReturnValueOnce(of({ statusCode: 200, data: { id: '801', status: 'RECEIVED' } }));
    branchUserRepo.findOne.mockResolvedValue({ id: 'bu-1' });

    const res = await service.receiveTransferBatch(
      '801',
      { id: '55', roles: ['operator'] },
    );

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
      service.receiveTransferBatch(
        '802',
        { id: '999', roles: ['operator'] },
      ),
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
});
