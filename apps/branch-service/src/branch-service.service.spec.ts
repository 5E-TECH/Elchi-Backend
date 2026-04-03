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
  };
});

describe('BranchServiceService', () => {
  let service: BranchServiceService;
  let branchRepo: any;
  let branchUserRepo: any;
  let branchConfigRepo: any;
  let identityClient: any;

  beforeEach(() => {
    branchRepo = {
      findOne: jest.fn(),
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

    service = new BranchServiceService(branchRepo, branchUserRepo, branchConfigRepo, identityClient);
  });

  it('createBranch creates new branch', async () => {
    branchRepo.findOne.mockResolvedValueOnce(null);
    branchRepo.save.mockResolvedValue({ id: 'b1', name: 'Main' });

    const res = await service.createBranch({ name: 'Main' } as any);

    expect(res.statusCode).toBe(201);
    expect(res.data.id).toBe('b1');
  });

  it('createBranch throws 400 when name missing', async () => {
    await expect(service.createBranch({} as any)).rejects.toBeInstanceOf(RpcException);
  });

  it('createBranch throws 409 on duplicate name', async () => {
    branchRepo.findOne.mockResolvedValue({ id: 'x' });
    await expect(service.createBranch({ name: 'Main' } as any)).rejects.toBeInstanceOf(RpcException);
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
});
