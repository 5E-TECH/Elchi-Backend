import { Inject, Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Status } from '@app/common';
import { Branch } from './entities/branch.entity';
import { BranchUser } from './entities/branch-user.entity';
import { BranchConfig } from './entities/branch-config.entity';
import { errorRes, successRes } from '../../../libs/common/helpers/response';
import { lastValueFrom, timeout } from 'rxjs';

@Injectable()
export class BranchServiceService {
  constructor(
    @InjectRepository(Branch) private readonly branchRepo: Repository<Branch>,
    @InjectRepository(BranchUser) private readonly branchUserRepo: Repository<BranchUser>,
    @InjectRepository(BranchConfig) private readonly branchConfigRepo: Repository<BranchConfig>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
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

  private async ensureUserExists(userId: string): Promise<void> {
    try {
      const res = await lastValueFrom(
        this.identityClient
          .send<{ data?: { id?: string } }>({ cmd: 'identity.user.find_by_id' }, { id: userId })
          .pipe(timeout(5000)),
      );
      if (!res?.data?.id) {
        this.notFound('User not found');
      }
    } catch (error) {
      if (error instanceof RpcException) {
        const err = error.getError() as
          | string
          | {
              statusCode?: number;
              message?: string;
            };
        const statusCode =
          typeof err === 'object' && err
            ? Number(err.statusCode ?? 500)
            : 500;
        if (statusCode === 404) {
          this.notFound('User not found');
        }
        throw error;
      }
      if (
        typeof error === 'object' &&
        error &&
        'statusCode' in error &&
        Number((error as { statusCode?: number }).statusCode) === 404
      ) {
        this.notFound('User not found');
      }
      throw new RpcException(errorRes('Identity service unavailable', 502));
    }
  }

  private async getRegionsByIds(regionIds: string[]): Promise<Map<string, unknown>> {
    if (!regionIds.length) {
      return new Map();
    }

    try {
      const res = await lastValueFrom(
        this.logisticsClient
          .send<{ data?: Array<Record<string, unknown>> }>(
            { cmd: 'logistics.region.find_by_ids' },
            { ids: regionIds },
          )
          .pipe(timeout(5000)),
      );

      const items = Array.isArray(res?.data) ? res.data : [];
      const map = new Map<string, unknown>();
      items.forEach((region) => {
        const id = String(region?.id ?? '');
        if (id) {
          map.set(id, region);
        }
      });
      return map;
    } catch {
      return new Map();
    }
  }

  private async getUsersByIds(userIds: string[]): Promise<Map<string, unknown>> {
    if (!userIds.length) {
      return new Map();
    }

    const results = await Promise.all(
      userIds.map(async (id) => {
        try {
          const res = await lastValueFrom(
            this.identityClient
              .send<{ data?: Record<string, unknown> }>(
                { cmd: 'identity.user.find_by_id' },
                { id },
              )
              .pipe(timeout(5000)),
          );
          return [id, res?.data ?? null] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );

    return new Map(results);
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

    const regionIds = Array.from(
      new Set(
        items
          .map((item) => item.region_id)
          .filter((regionId): regionId is string => Boolean(regionId)),
      ),
    );
    const regionMap = await this.getRegionsByIds(regionIds);

    const enrichedItems = items.map((item) => ({
      ...item,
      region: item.region_id ? (regionMap.get(item.region_id) ?? null) : null,
    }));

    return successRes(
      {
        items: enrichedItems,
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
    const regionMap = await this.getRegionsByIds(
      branch.region_id ? [branch.region_id] : [],
    );
    return successRes(
      {
        ...branch,
        region: branch.region_id ? (regionMap.get(branch.region_id) ?? null) : null,
      },
      200,
      'Branch found',
    );
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

  async assignUserToBranch(data: { branch_id?: string; user_id?: string; role?: string }) {
    const branchId = String(data?.branch_id ?? '').trim();
    const userId = String(data?.user_id ?? '').trim();
    const role = data?.role ? String(data.role).trim() : null;

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!userId) {
      this.badRequest('user_id is required');
    }

    await this.getBranchOrThrow(branchId);
    await this.ensureUserExists(userId);

    const anotherBranch = await this.branchUserRepo.findOne({
      where: {
        user_id: userId,
        isDeleted: false,
      },
    });
    if (anotherBranch && anotherBranch.branch_id !== branchId) {
      this.conflict('User already assigned to another branch');
    }

    const existing = await this.branchUserRepo.findOne({
      where: { branch_id: branchId, user_id: userId },
    });

    if (existing && !existing.isDeleted) {
      this.conflict('User already assigned to branch');
    }

    if (existing) {
      existing.isDeleted = false;
      existing.role = role;
      const revived = await this.branchUserRepo.save(existing);
      return successRes(revived, 200, 'Branch user assigned');
    }

    const saved = await this.branchUserRepo.save(
      this.branchUserRepo.create({
        branch_id: branchId,
        user_id: userId,
        role,
      }),
    );

    return successRes(saved, 201, 'Branch user assigned');
  }

  async removeUserFromBranch(data: { branch_id?: string; user_id?: string }) {
    const branchId = String(data?.branch_id ?? '').trim();
    const userId = String(data?.user_id ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!userId) {
      this.badRequest('user_id is required');
    }

    const row = await this.branchUserRepo.findOne({
      where: { branch_id: branchId, user_id: userId, isDeleted: false },
    });
    if (!row) {
      this.notFound('Branch user relation not found');
    }

    row.isDeleted = true;
    await this.branchUserRepo.save(row);

    return successRes({ branch_id: branchId, user_id: userId }, 200, 'Branch user removed');
  }

  async findUsersByBranch(branch_id: string) {
    const branchId = String(branch_id ?? '').trim();
    if (!branchId) {
      this.badRequest('branch_id is required');
    }

    await this.getBranchOrThrow(branchId);

    const users = await this.branchUserRepo.find({
      where: { branch_id: branchId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });

    const userIds = Array.from(
      new Set(
        users
          .map((item) => item.user_id)
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    const userMap = await this.getUsersByIds(userIds);

    const enrichedUsers = users.map((item) => {
      const user = userMap.get(item.user_id) as Record<string, unknown> | null;
      return {
        ...item,
        role: item.role ?? (typeof user?.role === 'string' ? user.role : null),
        user,
      };
    });

    return successRes(enrichedUsers, 200, 'Branch users');
  }

  async setBranchConfig(data: {
    branch_id?: string;
    config_key?: string;
    config_value?: Record<string, unknown> | null;
  }) {
    const branchId = String(data?.branch_id ?? '').trim();
    const configKey = String(data?.config_key ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!configKey) {
      this.badRequest('config_key is required');
    }

    await this.getBranchOrThrow(branchId);

    const existing = await this.branchConfigRepo.findOne({
      where: { branch_id: branchId, config_key: configKey },
    });

    const configValue =
      typeof data?.config_value === 'undefined' ? null : (data.config_value ?? null);

    if (existing) {
      existing.isDeleted = false;
      existing.config_value = configValue;
      const saved = await this.branchConfigRepo.save(existing);
      return successRes(saved, 200, 'Branch config saved');
    }

    const saved = await this.branchConfigRepo.save(
      this.branchConfigRepo.create({
        branch_id: branchId,
        config_key: configKey,
        config_value: configValue,
      }),
    );

    return successRes(saved, 201, 'Branch config saved');
  }

  async getBranchConfig(branch_id: string) {
    const branchId = String(branch_id ?? '').trim();
    if (!branchId) {
      this.badRequest('branch_id is required');
    }

    await this.getBranchOrThrow(branchId);

    const items = await this.branchConfigRepo.find({
      where: { branch_id: branchId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });

    return successRes(items, 200, 'Branch config list');
  }

  async getBranchConfigByKey(data: { branch_id?: string; config_key?: string }) {
    const branchId = String(data?.branch_id ?? '').trim();
    const configKey = String(data?.config_key ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!configKey) {
      this.badRequest('config_key is required');
    }

    await this.getBranchOrThrow(branchId);

    const item = await this.branchConfigRepo.findOne({
      where: { branch_id: branchId, config_key: configKey, isDeleted: false },
    });

    if (!item) {
      this.notFound('Branch config not found');
    }

    return successRes(item, 200, 'Branch config found');
  }

  async updateBranchConfig(data: {
    branch_id?: string;
    config_key?: string;
    config_value?: Record<string, unknown> | null;
  }) {
    const branchId = String(data?.branch_id ?? '').trim();
    const configKey = String(data?.config_key ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!configKey) {
      this.badRequest('config_key is required');
    }

    await this.getBranchOrThrow(branchId);

    const item = await this.branchConfigRepo.findOne({
      where: { branch_id: branchId, config_key: configKey, isDeleted: false },
    });
    if (!item) {
      this.notFound('Branch config not found');
    }

    item.config_value = typeof data?.config_value === 'undefined' ? null : (data.config_value ?? null);
    const saved = await this.branchConfigRepo.save(item);

    return successRes(saved, 200, 'Branch config updated');
  }

  async deleteBranchConfig(data: { branch_id?: string; config_key?: string }) {
    const branchId = String(data?.branch_id ?? '').trim();
    const configKey = String(data?.config_key ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!configKey) {
      this.badRequest('config_key is required');
    }

    await this.getBranchOrThrow(branchId);

    const item = await this.branchConfigRepo.findOne({
      where: { branch_id: branchId, config_key: configKey, isDeleted: false },
    });
    if (!item) {
      this.notFound('Branch config not found');
    }

    item.isDeleted = true;
    await this.branchConfigRepo.save(item);

    return successRes({ branch_id: branchId, config_key: configKey }, 200, 'Branch config deleted');
  }
}
