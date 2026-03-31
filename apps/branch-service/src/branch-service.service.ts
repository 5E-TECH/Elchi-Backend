import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Status } from '@app/common';
import { Branch } from './entities/branch.entity';
import { BranchUser } from './entities/branch-user.entity';
import { BranchConfig } from './entities/branch-config.entity';
import { errorRes, successRes } from '../../../libs/common/helpers/response';

@Injectable()
export class BranchServiceService {
  constructor(
    @InjectRepository(Branch) private readonly branchRepo: Repository<Branch>,
    @InjectRepository(BranchUser) private readonly branchUserRepo: Repository<BranchUser>,
    @InjectRepository(BranchConfig) private readonly branchConfigRepo: Repository<BranchConfig>,
  ) {}

  private notFound(message: string): never {
    throw new RpcException(errorRes(message, 404));
  }

  private badRequest(message: string): never {
    throw new RpcException(errorRes(message, 400));
  }

  private conflict(message: string): never {
    throw new RpcException(errorRes(message, 409));
  }

  private normalizePagination(page?: number, limit?: number) {
    const safePage = Number(page) > 0 ? Number(page) : 1;
    const safeLimit = Number(limit) > 0 ? Math.min(Number(limit), 100) : 10;
    return {
      page: safePage,
      limit: safeLimit,
      skip: (safePage - 1) * safeLimit,
    };
  }

  private parseStatus(status?: string): Status | undefined {
    if (!status) {
      return undefined;
    }

    const normalized = String(status).toLowerCase();
    if (normalized !== Status.ACTIVE && normalized !== Status.INACTIVE) {
      this.badRequest("status must be either 'active' or 'inactive'");
    }
    return normalized as Status;
  }

  private normalizeNullableBigint(value: unknown): string | null {
    if (value === null || typeof value === 'undefined' || value === '') {
      return null;
    }
    return String(value);
  }

  private async getBranchOrThrow(id: string): Promise<Branch> {
    const branch = await this.branchRepo.findOne({
      where: { id: String(id), isDeleted: false },
    });

    if (!branch) {
      this.notFound('Branch not found');
    }

    return branch;
  }

  async createBranch(dto: {
    name?: string;
    location?: string;
    address?: string;
    phone_number?: string;
    region_id?: string | null;
    district_id?: string | null;
    status?: string;
    manager_id?: string | null;
  }) {
    const name = String(dto?.name ?? '').trim();
    if (!name) {
      this.badRequest('name is required');
    }

    const exists = await this.branchRepo.findOne({
      where: { name, isDeleted: false },
    });
    if (exists) {
      this.conflict('Branch with this name already exists');
    }

    const saved = await this.branchRepo.save(
      this.branchRepo.create({
        name,
        address: String(dto?.address ?? dto?.location ?? '').trim() || null,
        phone_number: String(dto?.phone_number ?? '').trim() || null,
        region_id: this.normalizeNullableBigint(dto?.region_id),
        district_id: this.normalizeNullableBigint(dto?.district_id),
        manager_id: this.normalizeNullableBigint(dto?.manager_id),
        status: this.parseStatus(dto?.status) ?? Status.ACTIVE,
      }),
    );

    return successRes(saved, 201, 'Branch created');
  }

  async findAllBranches(query?: {
    search?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const { page, limit, skip } = this.normalizePagination(query?.page, query?.limit);
    const status = this.parseStatus(query?.status);
    const search = String(query?.search ?? '').trim();

    const qb = this.branchRepo
      .createQueryBuilder('branch')
      .where('branch.isDeleted = :isDeleted', { isDeleted: false })
      .orderBy('branch.createdAt', 'DESC');

    if (status) {
      qb.andWhere('branch.status = :status', { status });
    }

    if (search) {
      qb.andWhere(
        '(branch.name ILIKE :search OR branch.address ILIKE :search OR branch.phone_number ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    const [items, total] = await qb.skip(skip).take(limit).getManyAndCount();

    return successRes(
      {
        items,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
      200,
      'Branches list',
    );
  }

  async findBranchById(id: string) {
    const branch = await this.getBranchOrThrow(id);
    return successRes(branch, 200, 'Branch found');
  }

  async updateBranch(
    id: string,
    dto: {
      name?: string;
      location?: string;
      address?: string;
      phone_number?: string;
      region_id?: string | null;
      district_id?: string | null;
      status?: string;
      manager_id?: string | null;
    },
  ) {
    const branch = await this.getBranchOrThrow(id);

    if (typeof dto?.name !== 'undefined') {
      const nextName = String(dto.name).trim();
      if (!nextName) {
        this.badRequest('name cannot be empty');
      }
      if (nextName !== branch.name) {
        const nameExists = await this.branchRepo.findOne({
          where: { name: nextName, isDeleted: false },
        });
        if (nameExists && nameExists.id !== branch.id) {
          this.conflict('Branch with this name already exists');
        }
      }
      branch.name = nextName;
    }

    if (typeof dto?.address !== 'undefined' || typeof dto?.location !== 'undefined') {
      branch.address = String(dto?.address ?? dto?.location ?? '').trim() || null;
    }

    if (typeof dto?.phone_number !== 'undefined') {
      branch.phone_number = String(dto.phone_number ?? '').trim() || null;
    }

    if (typeof dto?.region_id !== 'undefined') {
      branch.region_id = this.normalizeNullableBigint(dto.region_id);
    }

    if (typeof dto?.district_id !== 'undefined') {
      branch.district_id = this.normalizeNullableBigint(dto.district_id);
    }

    if (typeof dto?.manager_id !== 'undefined') {
      branch.manager_id = this.normalizeNullableBigint(dto.manager_id);
    }

    if (typeof dto?.status !== 'undefined') {
      branch.status = this.parseStatus(dto.status) ?? branch.status;
    }

    const saved = await this.branchRepo.save(branch);
    return successRes(saved, 200, 'Branch updated');
  }

  async deleteBranch(id: string) {
    const branch = await this.getBranchOrThrow(id);
    branch.isDeleted = true;
    branch.status = Status.INACTIVE;
    await this.branchRepo.save(branch);
    return successRes({ id }, 200, 'Branch deleted');
  }

  // TODO: BranchUser assign/remove
  // TODO: BranchConfig CRUD
}
