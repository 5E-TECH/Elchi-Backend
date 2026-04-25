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

    service = new BranchServiceService(
      branchRepo,
      branchUserRepo,
      branchConfigRepo,
      identityClient,
      logisticsClient,
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
});
