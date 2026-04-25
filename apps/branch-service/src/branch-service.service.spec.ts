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
    await expect(service.updateBranch('b1', { status: 'bad' } as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('assignUserToBranch throws when branch_id is missing', async () => {
    await expect(service.assignUserToBranch({ user_id: 'u1' } as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('assignUserToBranch throws conflict if user in another branch', async () => {
    branchRepo.findOne.mockResolvedValue({ id: 'b1', isDeleted: false });
    branchUserRepo.findOne.mockResolvedValueOnce({ branch_id: 'b2', user_id: 'u1', isDeleted: false });

    await expect(service.assignUserToBranch({ branch_id: 'b1', user_id: 'u1' } as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('setBranchConfig creates config when absent', async () => {
    branchRepo.findOne.mockResolvedValue({ id: 'b1', isDeleted: false });
    branchConfigRepo.findOne.mockResolvedValue(null);
    branchConfigRepo.save.mockResolvedValue({ id: 'c1', branch_id: 'b1', config_key: 'working_hours' });

    const res = await service.setBranchConfig({ branch_id: 'b1', config_key: 'working_hours', config_value: { a: 1 } } as any);

    expect(res.statusCode).toBe(201);
    expect(res.data.id).toBe('c1');
  });

  it('deleteBranch marks branch as deleted', async () => {
    branchRepo.findOne.mockResolvedValue({ id: 'b1', status: 'active', isDeleted: false });
    branchRepo.save.mockResolvedValue({ id: 'b1', status: 'inactive', isDeleted: true });

    const res = await service.deleteBranch('b1');

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
      .mockResolvedValueOnce(null) // name check
      .mockResolvedValueOnce(null) // code check
      .mockResolvedValueOnce({ id: 'existing-hq', type: 'HQ', isDeleted: false }); // existing HQ

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
      .mockResolvedValueOnce(null) // name check
      .mockResolvedValueOnce({ id: 'b1', code: 'SAM', isDeleted: false }); // code check

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
      }) // getBranchOrThrow(id)
      .mockResolvedValueOnce({
        id: 'child1',
        name: 'Child',
        code: 'CH1',
        type: 'DISTRICT',
        level: 2,
        parent_id: 'b1',
        status: 'active',
        isDeleted: false,
      }) // ensureNotCyclicParent: currentId=child1
      .mockResolvedValueOnce({
        id: 'b1',
        name: 'Root',
        code: 'ROOT',
        type: 'REGIONAL',
        level: 1,
        parent_id: 'hq',
        status: 'active',
        isDeleted: false,
      }); // ensureNotCyclicParent: currentId=b1 -> cycle

    await expect(
      service.updateBranch('b1', { parent_id: 'child1', type: 'REGIONAL' } as any),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('createBranch computes level automatically from parent', async () => {
    branchRepo.findOne
      .mockResolvedValueOnce(null) // name check
      .mockResolvedValueOnce(null) // code check
      .mockResolvedValueOnce({ id: 'hq', level: 0, type: 'HQ', isDeleted: false }); // parent check
    branchRepo.save.mockImplementation(async (payload: any) => payload);

    const res = await service.createBranch({
      name: 'Sam branch',
      type: 'REGIONAL',
      code: 'SAM',
      parent_id: 'hq',
      level: 99, // should be ignored
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
});
