import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ActivityAction,
  ActivityLogService,
  ActivityLogQuery,
  BranchTransferDirection,
  BranchType,
  BranchUserRole,
  Cashbox_type,
  Operation_type,
  Order_status,
  Post_status,
  Source_type,
  Status,
  Where_deliver,
} from '@app/common';
import { Branch } from './entities/branch.entity';
import { BranchUser } from './entities/branch-user.entity';
import { BranchConfig } from './entities/branch-config.entity';
import { errorRes, successRes } from '../../../libs/common/helpers/response';
import { lastValueFrom, timeout, TimeoutError } from 'rxjs';

type RequesterContext = {
  id?: string;
  roles?: string[];
  // Optional: JWT carries this for non-system roles. Available for callers
  // that want to skip a BranchUser lookup; resolveAccessScope below still
  // queries the DB to derive role-based scope (manager descendant tree).
  branch_id?: string | null;
};

type BranchAccessScope = {
  readableBranchIds: Set<string>;
  writableBranchIds: Set<string>;
  managerReadableBranchIds: Set<string>;
};

type OrderAnalyticsRow = {
  id: string;
  branch_id: string | null;
  market_id: string | null;
  status: string | null;
  total_price: number;
  current_batch_id: string | null;
  courier_id: string | null;
  createdAt: Date | null;
};

@Injectable()
export class BranchServiceService implements OnModuleInit {
  private readonly logger = new Logger(BranchServiceService.name);
  private readonly hqCode: string;
  private readonly hqName: string;
  private readonly hqAddress: string | null;

  constructor(
    @InjectRepository(Branch) private readonly branchRepo: Repository<Branch>,
    @InjectRepository(BranchUser)
    private readonly branchUserRepo: Repository<BranchUser>,
    @InjectRepository(BranchConfig)
    private readonly branchConfigRepo: Repository<BranchConfig>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('FILE') private readonly fileClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    config: ConfigService,
    private readonly activityLog: ActivityLogService,
  ) {
    this.hqCode = config.get<string>('BRANCH_HQ_CODE', 'HQ-TSHKNT');
    this.hqName = config.get<string>('BRANCH_HQ_NAME', 'HQ Toshkent');
    const addr = config.get<string>('BRANCH_HQ_ADDRESS', 'Toshkent');
    this.hqAddress = addr === '' ? null : addr;
  }

  async onModuleInit() {
    await this.ensureHqBranch();
  }

  private notFound(message: string): never {
    throw new RpcException(errorRes(message, 404));
  }

  private badRequest(message: string): never {
    throw new RpcException(errorRes(message, 400));
  }

  private conflict(message: string): never {
    throw new RpcException(errorRes(message, 409));
  }

  private forbidden(message: string): never {
    throw new RpcException(errorRes(message, 403));
  }

  private auditActor(requester?: { id?: string; roles?: string[] } | null): {
    user_id: string | null;
    user_role: string | null;
  } {
    const roles = requester?.roles ?? [];
    return {
      user_id: requester?.id ? String(requester.id) : null,
      user_role: roles.length ? roles.join(',') : null,
    };
  }

  async auditLogQuery(q: ActivityLogQuery) {
    return this.activityLog.query(q ?? {});
  }

  async auditLogByEntity(
    entity_type: string,
    entity_id: string,
    limit?: number,
  ) {
    return this.activityLog.findByEntity(entity_type, entity_id, limit ?? 50);
  }

  private normalizeBranchUserRole(role?: string | null): BranchUserRole {
    const normalized = String(role ?? BranchUserRole.REGISTRATOR)
      .trim()
      .toUpperCase();
    if (normalized === BranchUserRole.MANAGER) {
      return BranchUserRole.MANAGER;
    }
    if (normalized === BranchUserRole.REGISTRATOR) {
      return BranchUserRole.REGISTRATOR;
    }
    if (normalized === BranchUserRole.COURIER) {
      return BranchUserRole.COURIER;
    }
    this.badRequest('role faqat MANAGER, REGISTRATOR, COURIER bo‘lishi mumkin');
  }

  private isSystemPrivileged(requester?: RequesterContext): boolean {
    const roles = (requester?.roles ?? []).map((role) =>
      String(role).toLowerCase(),
    );
    return roles.includes('superadmin') || roles.includes('admin');
  }

  private async collectDescendantBranchIds(
    rootBranchIds: string[],
  ): Promise<Set<string>> {
    const roots = Array.from(
      new Set(
        rootBranchIds.map((id) => String(id ?? '').trim()).filter(Boolean),
      ),
    );
    if (roots.length === 0) {
      return new Set<string>();
    }

    const tablePath = this.branchRepo.metadata.tablePath;
    const tableRef = tablePath
      .split('.')
      .map((part) => `"${part}"`)
      .join('.');

    const rows: Array<{ id: string }> = await this.branchRepo.manager.query(
      `
        WITH RECURSIVE tree AS (
          SELECT id
          FROM ${tableRef}
          WHERE id = ANY($1::bigint[]) AND is_deleted = false
          UNION ALL
          SELECT b.id
          FROM ${tableRef} b
          INNER JOIN tree t ON b.parent_id = t.id
          WHERE b.is_deleted = false
        )
        SELECT id FROM tree;
      `,
      [roots],
    );

    return new Set<string>(rows.map((row) => String(row.id)));
  }

  private async resolveAccessScope(
    requester?: RequesterContext,
  ): Promise<BranchAccessScope> {
    if (this.isSystemPrivileged(requester)) {
      return {
        readableBranchIds: new Set<string>(),
        writableBranchIds: new Set<string>(),
        managerReadableBranchIds: new Set<string>(),
      };
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const assignments = await this.branchUserRepo.find({
      where: {
        user_id: requesterId,
        isDeleted: false,
      },
      select: ['branch_id', 'role'],
    });

    const ownBranchIds = new Set(
      assignments
        .map((item) => String(item.branch_id))
        .filter((id) => Boolean(id)),
    );

    const managerRoots = assignments
      .filter(
        (item) =>
          this.normalizeBranchUserRole(item.role) === BranchUserRole.MANAGER,
      )
      .map((item) => String(item.branch_id));

    const readableBranchIds = new Set<string>(ownBranchIds);
    const managerTreeIds = await this.collectDescendantBranchIds(managerRoots);
    managerTreeIds.forEach((id) => readableBranchIds.add(id));

    return {
      readableBranchIds,
      writableBranchIds: new Set(managerRoots),
      managerReadableBranchIds: managerTreeIds,
    };
  }

  private async assertCanReadBranch(
    branchId: string,
    requester?: RequesterContext,
  ): Promise<void> {
    if (this.isSystemPrivileged(requester)) {
      return;
    }
    const scope = await this.resolveAccessScope(requester);
    if (!scope.readableBranchIds.has(String(branchId))) {
      this.forbidden('Bu filial ma’lumotini ko‘rishga ruxsat yo‘q');
    }
  }

  private async assertCanWriteBranch(
    branchId: string,
    requester?: RequesterContext,
  ): Promise<void> {
    if (this.isSystemPrivileged(requester)) {
      return;
    }
    const scope = await this.resolveAccessScope(requester);
    if (!scope.writableBranchIds.has(String(branchId))) {
      this.forbidden('Bu filialga yozish/o‘zgartirish ruxsati yo‘q');
    }
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

  private parseBranchType(type?: string): BranchType {
    const normalized = String(type ?? '')
      .trim()
      .toUpperCase();
    if (
      !normalized ||
      !Object.values(BranchType).includes(normalized as BranchType)
    ) {
      this.badRequest(
        `type must be one of: ${Object.values(BranchType).join(', ')}`,
      );
    }
    return normalized as BranchType;
  }

  private normalizeBranchCode(code?: string | null): string {
    const normalized = String(code ?? '')
      .trim()
      .toUpperCase();
    if (!normalized) {
      this.badRequest('code is required');
    }
    if (!/^[A-Z0-9-]{2,32}$/.test(normalized)) {
      this.badRequest('code must match /^[A-Z0-9-]{2,32}$/');
    }
    return normalized;
  }

  private async ensureBranchNameUnique(
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const normalized = name.trim();
    if (!normalized) return;
    const found = await this.branchRepo
      .createQueryBuilder('b')
      .where('LOWER(TRIM(b.name)) = LOWER(:name)', { name: normalized })
      .andWhere('b.is_deleted = false')
      .getOne();
    if (found && (!exceptId || found.id !== exceptId)) {
      this.conflict('Branch with this name already exists');
    }
  }

  private async ensureBranchCodeUnique(
    code: string,
    exceptId?: string,
  ): Promise<void> {
    const exists = await this.branchRepo.findOne({
      where: { code, isDeleted: false },
    });
    if (exists && exists.id !== exceptId) {
      this.conflict('Branch with this code already exists');
    }
  }

  private async getParentBranchOrThrow(parentId: string): Promise<Branch> {
    return this.getBranchOrThrow(parentId);
  }

  private async ensureNotCyclicParent(
    branchId: string,
    parentId: string,
  ): Promise<void> {
    if (branchId === parentId) {
      this.badRequest('Branch cannot be parent of itself');
    }

    const visited = new Set<string>();
    let currentId: string | null = parentId;

    while (currentId) {
      if (currentId === branchId) {
        this.badRequest('Cyclic parent relation is not allowed');
      }
      if (visited.has(currentId)) {
        this.badRequest('Cyclic parent relation is not allowed');
      }
      visited.add(currentId);
      const current = await this.branchRepo.findOne({
        where: { id: currentId, isDeleted: false },
      });
      if (!current) {
        this.notFound('Parent branch not found');
      }
      currentId = current.parent_id ?? null;
    }
  }

  private async hasActiveChildren(branchId: string): Promise<boolean> {
    const childrenCount = await this.branchRepo.count({
      where: { parent_id: branchId, isDeleted: false },
    });
    return childrenCount > 0;
  }

  private async rebalanceDescendantLevels(
    rootBranchId: string,
    rootLevel: number,
  ): Promise<void> {
    const queue: Array<{ branchId: string; level: number }> = [
      { branchId: rootBranchId, level: rootLevel },
    ];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = await this.branchRepo.find({
        where: { parent_id: current.branchId, isDeleted: false },
      });

      for (const child of children) {
        const expectedLevel = current.level + 1;
        if (child.level !== expectedLevel) {
          child.level = expectedLevel;
          await this.branchRepo.save(child);
        }
        queue.push({ branchId: child.id, level: expectedLevel });
      }
    }
  }

  private async getParentsByIds(ids: string[]): Promise<Map<string, Branch>> {
    if (!ids.length) {
      return new Map();
    }

    const parents = await this.branchRepo.find({
      where: { id: In(ids), isDeleted: false },
    });
    return new Map(parents.map((parent) => [parent.id, parent]));
  }

  private async ensureHqBranch(): Promise<void> {
    const hqByCode = await this.branchRepo.findOne({
      where: { code: this.hqCode, isDeleted: false },
    });
    if (hqByCode) {
      if (
        hqByCode.type !== BranchType.HQ ||
        hqByCode.level !== 0 ||
        hqByCode.parent_id !== null
      ) {
        hqByCode.type = BranchType.HQ;
        hqByCode.level = 0;
        hqByCode.parent_id = null;
        await this.branchRepo.save(hqByCode);
      }
      return;
    }

    const anyHq = await this.branchRepo.findOne({
      where: { type: BranchType.HQ, isDeleted: false },
    });
    if (anyHq) {
      if (!anyHq.code) {
        anyHq.code = this.hqCode;
      }
      if (anyHq.parent_id !== null || anyHq.level !== 0) {
        anyHq.parent_id = null;
        anyHq.level = 0;
      }
      await this.branchRepo.save(anyHq);
      return;
    }

    await this.branchRepo.save(
      this.branchRepo.create({
        name: this.hqName,
        address: this.hqAddress,
        phone_number: null,
        region_id: null,
        district_id: null,
        parent_id: null,
        type: BranchType.HQ,
        level: 0,
        code: this.hqCode,
        status: Status.ACTIVE,
        manager_id: null,
      }),
    );
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

  private async ensureUserExists(
    userId: string,
  ): Promise<{ id: string; role?: string | null }> {
    try {
      const res = await lastValueFrom(
        this.identityClient
          .send<{
            data?: { id?: string; role?: string | null };
          }>({ cmd: 'identity.user.find_by_id' }, { id: userId })
          .pipe(timeout(5000)),
      );
      if (!res?.data?.id) {
        this.notFound('User not found');
      }
      return { id: String(res.data.id), role: res.data.role ?? null };
    } catch (error) {
      if (error instanceof RpcException) {
        const err = error.getError() as
          | string
          | {
              statusCode?: number;
              message?: string;
            };
        const statusCode =
          typeof err === 'object' && err ? Number(err.statusCode ?? 500) : 500;
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

  private resolveBranchRoleFromUserRole(
    userRole?: string | null,
  ): BranchUserRole {
    const normalized = String(userRole ?? '')
      .trim()
      .toLowerCase();
    if (normalized === 'manager') {
      return BranchUserRole.MANAGER;
    }
    if (normalized === 'registrator') {
      return BranchUserRole.REGISTRATOR;
    }
    if (normalized === 'courier') {
      return BranchUserRole.COURIER;
    }
    this.badRequest(
      'User roli branchga biriktirish uchun mos emas (faqat manager/registrator/courier)',
    );
  }

  private async getRegionsByIds(
    regionIds: string[],
  ): Promise<Map<string, unknown>> {
    if (!regionIds.length) {
      return new Map();
    }

    try {
      const res = await lastValueFrom(
        this.logisticsClient
          .send<{
            data?: Array<Record<string, unknown>>;
          }>({ cmd: 'logistics.region.find_by_ids' }, { ids: regionIds })
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
    } catch (err) {
      this.logger.warn(
        `logistics.region.find_by_ids failed (ids=${regionIds.length}): ${(err as Error)?.message ?? err}`,
      );
      return new Map();
    }
  }

  private async getDistrictsByIds(
    districtIds: string[],
  ): Promise<Map<string, unknown>> {
    if (!districtIds.length) {
      return new Map();
    }

    try {
      const res = await lastValueFrom(
        this.logisticsClient
          .send<{
            data?: Array<Record<string, unknown>>;
          }>({ cmd: 'logistics.district.find_by_ids' }, { ids: districtIds })
          .pipe(timeout(5000)),
      );

      const items = Array.isArray(res?.data) ? res.data : [];
      const map = new Map<string, unknown>();
      items.forEach((district) => {
        const id = String(district?.id ?? '');
        if (id) {
          map.set(id, district);
        }
      });
      return map;
    } catch (err) {
      this.logger.warn(
        `logistics.district.find_by_ids failed (ids=${districtIds.length}): ${(err as Error)?.message ?? err}`,
      );
      return new Map();
    }
  }

  private async getUsersByIds(
    userIds: string[],
  ): Promise<Map<string, unknown>> {
    if (!userIds.length) {
      return new Map();
    }

    const results = await Promise.all(
      userIds.map(async (id) => {
        try {
          const res = await lastValueFrom(
            this.identityClient
              .send<{
                data?: Record<string, unknown>;
              }>({ cmd: 'identity.user.find_by_id' }, { id })
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

  private toTashkentStartOfDay(date: Date): Date {
    const tzOffsetMs = 5 * 60 * 60 * 1000;
    const shifted = new Date(date.getTime() + tzOffsetMs);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth();
    const day = shifted.getUTCDate();
    return new Date(Date.UTC(year, month, day) - tzOffsetMs);
  }

  private toTashkentStartOfWeek(date: Date): Date {
    const dayStart = this.toTashkentStartOfDay(date);
    const tzOffsetMs = 5 * 60 * 60 * 1000;
    const shifted = new Date(dayStart.getTime() + tzOffsetMs);
    const dayOfWeek = shifted.getUTCDay(); // 0=Sun ... 6=Sat
    const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    return new Date(dayStart.getTime() - diffToMonday * 24 * 60 * 60 * 1000);
  }

  private extractOrderRows(payload: unknown): OrderAnalyticsRow[] {
    const source = payload as any;
    const candidates = [source?.data?.data, source?.data, source];

    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) {
        continue;
      }
      return candidate.map((row: any) => {
        const createdValue = row?.createdAt ?? row?.created_at ?? null;
        const createdAt = createdValue ? new Date(createdValue) : null;
        return {
          id: String(row?.id ?? ''),
          branch_id: row?.branch_id ? String(row.branch_id) : null,
          market_id: row?.market_id ? String(row.market_id) : null,
          status: row?.status ? String(row.status) : null,
          total_price: Number(row?.total_price ?? 0) || 0,
          current_batch_id: row?.current_batch_id
            ? String(row.current_batch_id)
            : null,
          courier_id: row?.courier_id ? String(row.courier_id) : null,
          createdAt:
            createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
        };
      });
    }

    return [];
  }

  private async getOrdersByBranchIds(
    branchIds: string[],
  ): Promise<OrderAnalyticsRow[]> {
    const rows = await Promise.all(
      branchIds.map(async (branchId) => {
        try {
          const response = await lastValueFrom(
            this.orderClient
              .send(
                { cmd: 'order.find_all' },
                {
                  query: {
                    branch_id: branchId,
                    fetch_all: true,
                    limit: 5000,
                  },
                },
              )
              .pipe(timeout(10000)),
          );
          return this.extractOrderRows(response);
        } catch {
          return [];
        }
      }),
    );

    return rows.flat();
  }

  private async resolveAnalyticsBranchIds(
    branchId: string,
    requester?: RequesterContext,
  ): Promise<string[]> {
    await this.getBranchOrThrow(branchId);
    await this.assertCanReadBranch(branchId, requester);

    if (this.isSystemPrivileged(requester)) {
      return Array.from(await this.collectDescendantBranchIds([branchId]));
    }

    const scope = await this.resolveAccessScope(requester);
    if (scope.managerReadableBranchIds.has(String(branchId))) {
      return Array.from(await this.collectDescendantBranchIds([branchId]));
    }

    return [String(branchId)];
  }

  private normalizeTransferDirection(value?: string): BranchTransferDirection {
    const normalized = String(value ?? '')
      .trim()
      .toUpperCase();
    if (
      normalized !== BranchTransferDirection.FORWARD &&
      normalized !== BranchTransferDirection.RETURN
    ) {
      this.badRequest(
        `direction must be one of: ${BranchTransferDirection.FORWARD}, ${BranchTransferDirection.RETURN}`,
      );
    }
    return normalized as BranchTransferDirection;
  }

  private normalizeTransferRequestKey(value?: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      this.badRequest('request_key is required');
    }
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(normalized)) {
      this.badRequest('request_key must match /^[A-Za-z0-9_-]{8,80}$/');
    }
    return normalized;
  }

  private async assertCanCreateTransferBatch(
    branchId: string,
    requester?: RequesterContext,
  ) {
    if (this.isSystemPrivileged(requester)) {
      return;
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const assignments = await this.branchUserRepo.find({
      where: { user_id: requesterId, isDeleted: false },
      select: ['branch_id', 'role'],
    });

    const ownAssignment = assignments.find(
      (item) =>
        String(item.branch_id) === String(branchId) &&
        (this.normalizeBranchUserRole(item.role) ===
          BranchUserRole.REGISTRATOR ||
          this.normalizeBranchUserRole(item.role) === BranchUserRole.MANAGER),
    );
    if (ownAssignment) {
      return;
    }

    const managerRoots = assignments
      .filter(
        (item) =>
          this.normalizeBranchUserRole(item.role) === BranchUserRole.MANAGER,
      )
      .map((item) => String(item.branch_id));

    if (!managerRoots.length) {
      this.forbidden('Transfer batch yaratishga ruxsat yo‘q');
    }

    const managerTree = await this.collectDescendantBranchIds(managerRoots);
    if (!managerTree.has(String(branchId))) {
      this.forbidden('Transfer batch yaratishga ruxsat yo‘q');
    }
  }

  private assertBranchCanCreateBatches(
    branch: Branch,
    operation: 'transfer' | 'return',
  ) {
    if (branch.type === BranchType.REGIONAL) {
      this.forbidden(
        operation === 'return'
          ? 'REGIONAL filial return batch yarata olmaydi'
          : 'REGIONAL filial transfer batch yarata olmaydi',
      );
    }
  }

  private assertBranchCanReceiveBatches(branch: Branch) {
    if (branch.type === BranchType.PICKUP) {
      this.forbidden(
        'PICKUP filial boshqa filialdan kelgan batchni qabul qila olmaydi',
      );
    }
  }

  private extractRpcError(
    error: unknown,
  ): { statusCode: number; message: string } | null {
    const fallback = { statusCode: 500, message: 'Internal service error' };
    const source = error as
      | {
          message?: string;
          error?: { statusCode?: number; message?: string | string[] };
        }
      | undefined;

    const nested = source?.error;
    const nestedMessage = Array.isArray(nested?.message)
      ? nested?.message?.join('. ')
      : nested?.message;
    const topMessage = source?.message;

    const statusCode = Number(nested?.statusCode ?? NaN);
    const message = String(nestedMessage ?? topMessage ?? '').trim();

    if (Number.isFinite(statusCode) && message) {
      return { statusCode, message };
    }
    if (message) {
      return { ...fallback, message };
    }
    return null;
  }

  private async sendOrderCommand<T>(
    cmd: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await lastValueFrom(
        this.orderClient.send<T>({ cmd }, payload).pipe(timeout(15000)),
      );
    } catch (error) {
      const parsed = this.extractRpcError(error);
      if (parsed) {
        throw new RpcException(errorRes(parsed.message, parsed.statusCode));
      }
      throw new RpcException(errorRes('Order service unavailable', 502));
    }
  }

  private async sendLogisticsCommand<T>(
    cmd: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await lastValueFrom(
        this.logisticsClient.send<T>({ cmd }, payload).pipe(timeout(15000)),
      );
    } catch (error) {
      const parsed = this.extractRpcError(error);
      if (parsed) {
        throw new RpcException(errorRes(parsed.message, parsed.statusCode));
      }
      throw new RpcException(errorRes('Logistics service unavailable', 502));
    }
  }

  private async sendFileCommand<T>(
    cmd: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await lastValueFrom(
        this.fileClient.send<T>({ cmd }, payload).pipe(timeout(15000)),
      );
    } catch {
      throw new RpcException(errorRes('File service unavailable', 502));
    }
  }

  private async sendFinanceCommand<T>(
    cmd: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await lastValueFrom(
        this.financeClient.send<T>({ cmd }, payload).pipe(timeout(15000)),
      );
    } catch (error) {
      const parsed = this.extractRpcError(error);
      if (parsed) {
        throw new RpcException(errorRes(parsed.message, parsed.statusCode));
      }
      throw new RpcException(errorRes('Finance service unavailable', 502));
    }
  }

  private async ensureBranchCashbox(branchId: string): Promise<void> {
    try {
      await this.sendFinanceCommand('finance.cashbox.create', {
        user_id: branchId,
        cashbox_type: Cashbox_type.BRANCH,
      });
    } catch (error) {
      const parsed = this.extractRpcError(error);
      if (parsed?.message?.includes('Cashbox already exists')) {
        return;
      }
      throw error;
    }
  }

  async createTransferBatches(
    branchId: string | undefined,
    dto: {
      orderIds?: string[];
      order_ids?: string[];
    },
    requester?: RequesterContext,
  ) {
    let sourceBranchId = String(branchId ?? '').trim();
    if (!sourceBranchId) {
      sourceBranchId =
        await this.resolveRequesterBranchIdForTransfer(requester);
    }

    const sourceBranch = await this.getBranchOrThrow(sourceBranchId);
    this.assertBranchCanCreateBatches(sourceBranch, 'transfer');
    const destinationBranchId = String(sourceBranch.parent_id ?? '').trim();
    if (!destinationBranchId) {
      this.badRequest("Source branch ota branch'i topilmadi");
    }

    await this.getBranchOrThrow(destinationBranchId);
    await this.assertCanCreateTransferBatch(sourceBranchId, requester);

    const orderIds = Array.from(
      new Set(
        (dto?.orderIds ?? dto?.order_ids ?? [])
          .map((id) => String(id ?? '').trim())
          .filter(Boolean),
      ),
    );
    if (!orderIds.length) {
      this.badRequest('order_ids is required');
    }

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const requestKey = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const createRes = await this.sendOrderCommand<{
      statusCode?: number;
      data?: { idempotent?: boolean; batches?: Array<Record<string, any>> };
      message?: string;
    }>('order.transfer_batch.create', {
      source_branch_id: sourceBranchId,
      destination_branch_id: destinationBranchId,
      direction: BranchTransferDirection.FORWARD,
      request_key: requestKey,
      requester_id: requesterId,
      order_ids: orderIds,
    });

    const createdBatches = Array.isArray(createRes?.data?.batches)
      ? createRes.data.batches
      : [];
    const batchIds = createdBatches.map((batch) => String(batch.id));

    if (createRes?.data?.idempotent) {
      return successRes(
        {
          idempotent: true,
          batches: createdBatches,
        },
        200,
        'Transfer batches already exist for this request key',
      );
    }

    const qrFiles: Array<{ batch_id: string; key: string; url: string }> = [];
    const qrErrors: Array<{ batch_id: string; message: string }> = [];
    for (const batch of createdBatches) {
      const batchId = String(batch.id);
      const token = String(batch?.qr_code_token ?? '').trim();
      if (!token) {
        qrErrors.push({
          batch_id: batchId,
          message: 'QR token missing for created batch',
        });
        continue;
      }

      try {
        const qrResponse = await this.sendFileCommand<{
          data?: { key?: string; url?: string };
        }>('file.generate_qr', {
          text: token,
          file_name: `${token}.png`,
          folder: 'branch-transfer-batches',
        });

        await this.sendOrderCommand('order.transfer_batch.history.add', {
          batch_id: batchId,
          user_id: requesterId,
          action: 'CREATED',
          notes: '[STEP] QR_GENERATED',
        });

        qrFiles.push({
          batch_id: batchId,
          key: String(qrResponse?.data?.key ?? ''),
          url: String(qrResponse?.data?.url ?? ''),
        });
      } catch (error) {
        const parsed = this.extractRpcError(error);
        const message =
          parsed?.message ??
          (error instanceof Error ? error.message : 'QR generation failed');
        qrErrors.push({ batch_id: batchId, message });
        try {
          await this.sendOrderCommand('order.transfer_batch.history.add', {
            batch_id: batchId,
            user_id: requesterId,
            action: 'CREATED',
            notes: `[WARN] QR_GENERATION_FAILED: ${message}`,
          });
        } catch {
          // Batch creation must not fail only because warning history failed.
        }
      }
    }

    const qrByBatchId = new Map(qrFiles.map((item) => [item.batch_id, item]));
    const enriched = createdBatches.map((batch) => ({
      ...batch,
      qr_file: qrByBatchId.get(String(batch.id)) ?? null,
    }));

    await this.activityLog.log({
      entity_type: 'TransferBatch',
      entity_id: String(batchIds[0] ?? sourceBranchId),
      action: 'branch.transfer_batch_create',
      metadata: {
        source_branch_id: sourceBranchId,
        destination_branch_id: destinationBranchId,
        order_count: orderIds.length,
        order_ids: orderIds.slice(0, 20),
        batch_ids: batchIds,
        qr_generation_errors: qrErrors,
      },
      ...this.auditActor(requester),
    });

    return successRes(
      {
        idempotent: false,
        batches: enriched,
        qr_generation_errors: qrErrors,
      },
      201,
      qrErrors.length
        ? 'Transfer batches created, but QR file generation failed'
        : 'Transfer batches created',
    );
  }

  private async resolveRequesterBranchIdForTransfer(
    requester?: RequesterContext,
  ): Promise<string> {
    if (this.isSystemPrivileged(requester)) {
      this.badRequest('source branch id is required');
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const assignment = await this.branchUserRepo.findOne({
      where: { user_id: requesterId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });

    if (!assignment?.branch_id) {
      this.forbidden('Branch assignment topilmadi');
    }

    const role = this.normalizeBranchUserRole(assignment.role);
    if (
      role !== BranchUserRole.MANAGER &&
      role !== BranchUserRole.REGISTRATOR
    ) {
      this.forbidden('Transfer batch yaratishga ruxsat yo‘q');
    }

    return String(assignment.branch_id);
  }

  async createReturnBatches(
    branchId: string,
    dto: {
      order_ids?: string[];
      request_key?: string;
      notes?: string | null;
    },
    requester?: RequesterContext,
  ) {
    const sourceBranchId = String(branchId ?? '').trim();
    if (!sourceBranchId) {
      this.badRequest('source branch is required');
    }

    const sourceBranch = await this.getBranchOrThrow(sourceBranchId);
    this.assertBranchCanCreateBatches(sourceBranch, 'return');
    await this.assertCanCreateTransferBatch(sourceBranchId, requester);

    const orderIds = Array.from(
      new Set(
        (dto?.order_ids ?? [])
          .map((id) => String(id ?? '').trim())
          .filter(Boolean),
      ),
    );
    if (!orderIds.length) {
      this.badRequest('order_ids is required');
    }

    const requestKey = this.normalizeTransferRequestKey(dto?.request_key);
    const requesterId = String(requester?.id ?? '').trim() || '0';

    const createRes = await this.sendOrderCommand<{
      data?: { idempotent?: boolean; batches?: Array<Record<string, any>> };
    }>('order.transfer_batch.create_return', {
      source_branch_id: sourceBranchId,
      order_ids: orderIds,
      request_key: requestKey,
      requester_id: requesterId,
      notes: dto?.notes ?? null,
    });

    const createdBatches = Array.isArray(createRes?.data?.batches)
      ? createRes.data.batches
      : [];
    const batchIds = createdBatches.map((batch) => String(batch.id));

    if (createRes?.data?.idempotent) {
      return successRes(
        {
          idempotent: true,
          batches: createdBatches,
        },
        200,
        'Return batches already exist for this request key',
      );
    }

    const qrFiles: Array<{ batch_id: string; key: string; url: string }> = [];
    const qrErrors: Array<{ batch_id: string; message: string }> = [];
    for (const batch of createdBatches) {
      const batchId = String(batch.id);
      const token = String(batch?.qr_code_token ?? '').trim();
      if (!token) {
        qrErrors.push({
          batch_id: batchId,
          message: 'QR token missing for created batch',
        });
        continue;
      }

      try {
        const qrResponse = await this.sendFileCommand<{
          data?: { key?: string; url?: string };
        }>('file.generate_qr', {
          text: token,
          file_name: `${token}.png`,
          folder: 'branch-transfer-batches',
        });

        await this.sendOrderCommand('order.transfer_batch.history.add', {
          batch_id: batchId,
          user_id: requesterId,
          action: 'CREATED',
          notes: '[STEP] QR_GENERATED',
        });

        qrFiles.push({
          batch_id: batchId,
          key: String(qrResponse?.data?.key ?? ''),
          url: String(qrResponse?.data?.url ?? ''),
        });
      } catch (error) {
        const parsed = this.extractRpcError(error);
        const message =
          parsed?.message ??
          (error instanceof Error ? error.message : 'QR generation failed');
        qrErrors.push({ batch_id: batchId, message });
        try {
          await this.sendOrderCommand('order.transfer_batch.history.add', {
            batch_id: batchId,
            user_id: requesterId,
            action: 'CREATED',
            notes: `[WARN] QR_GENERATION_FAILED: ${message}`,
          });
        } catch {
          // Batch creation must not fail only because warning history failed.
        }
      }
    }

    const qrByBatchId = new Map(qrFiles.map((item) => [item.batch_id, item]));
    const enriched = createdBatches.map((batch) => ({
      ...batch,
      qr_file: qrByBatchId.get(String(batch.id)) ?? null,
    }));

    await this.activityLog.log({
      entity_type: 'TransferBatch',
      entity_id: String(batchIds[0] ?? sourceBranchId),
      action: 'branch.return_batch_create',
      metadata: {
        source_branch_id: sourceBranchId,
        order_count: orderIds.length,
        order_ids: orderIds.slice(0, 20),
        batch_ids: batchIds,
        qr_generation_errors: qrErrors,
      },
      ...this.auditActor(requester),
    });

    return successRes(
      {
        idempotent: false,
        batches: enriched,
        qr_generation_errors: qrErrors,
      },
      201,
      qrErrors.length
        ? 'Return batches created, but QR file generation failed'
        : 'Return batches created',
    );
  }

  async sendTransferBatch(
    batchId: string,
    dto: {
      orderIds?: string[];
      order_ids?: string[];
      vehicle_plate?: string;
      driver_name?: string;
      driver_phone?: string;
    },
    requester?: RequesterContext,
  ) {
    const id = String(batchId ?? '').trim();
    if (!id) {
      this.badRequest('batch id is required');
    }

    const orderIds = Array.from(
      new Set(
        (dto?.orderIds ?? dto?.order_ids ?? [])
          .map((value) => String(value ?? '').trim())
          .filter(Boolean),
      ),
    );
    if (!orderIds.length) {
      this.badRequest('orderIds is required');
    }

    const vehiclePlate = String(dto?.vehicle_plate ?? 'N/A').trim() || 'N/A';
    const driverName = String(dto?.driver_name ?? 'N/A').trim() || 'N/A';
    const driverPhone =
      String(dto?.driver_phone ?? '+998000000000').trim() || '+998000000000';

    const batchRes = await this.sendOrderCommand<{
      data?: { source_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id });
    const sourceBranchId = String(
      batchRes?.data?.source_branch_id ?? '',
    ).trim();
    if (!sourceBranchId) {
      this.notFound('Transfer batch not found');
    }

    await this.assertCanCreateTransferBatch(sourceBranchId, requester);

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const sendResult = await this.sendOrderCommand(
      'order.transfer_batch.send',
      {
        batch_id: id,
        order_ids: orderIds,
        vehicle_plate: vehiclePlate,
        driver_name: driverName,
        driver_phone: driverPhone,
        requester_id: requesterId,
        requester_name: requesterId,
        requester_roles: requester?.roles ?? [],
      },
    );

    await this.activityLog.log({
      entity_type: 'TransferBatch',
      entity_id: String(id),
      action: ActivityAction.STATUS_CHANGE,
      metadata: {
        status: 'SENT',
        source_branch_id: sourceBranchId,
        order_count: orderIds.length,
        order_ids: orderIds.slice(0, 20),
      },
      ...this.auditActor(requester),
    });

    return sendResult;
  }

  async findRemainingTransferBatchById(
    id: string,
    requester?: RequesterContext,
  ) {
    const batchId = String(id ?? '').trim();
    if (!batchId) {
      this.badRequest('batch id is required');
    }

    const response = await this.sendOrderCommand<{
      data?: { source_branch_id?: string; destination_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id: batchId });

    const sourceBranchId = String(
      response?.data?.source_branch_id ?? '',
    ).trim();
    const destinationBranchId = String(
      response?.data?.destination_branch_id ?? '',
    ).trim();

    if (sourceBranchId && destinationBranchId) {
      try {
        await this.assertCanReadBranch(sourceBranchId, requester);
      } catch {
        await this.assertCanReadBranch(destinationBranchId, requester);
      }
    } else if (sourceBranchId) {
      await this.assertCanReadBranch(sourceBranchId, requester);
    } else if (destinationBranchId) {
      await this.assertCanReadBranch(destinationBranchId, requester);
    }

    const remainingResponse = await this.sendOrderCommand<{
      data?: Record<string, unknown>;
    }>('order.transfer_batch.find_remaining', { id: batchId });

    const batchData = (remainingResponse as { data?: Record<string, unknown> })
      ?.data;
    if (!batchData || typeof batchData !== 'object') {
      return remainingResponse;
    }

    const batchRecord = batchData as Record<string, unknown>;
    const regionId = String(batchRecord?.target_region_id ?? '').trim();
    const regionMap = await this.getRegionsByIds(regionId ? [regionId] : []);
    const rawItems = Array.isArray(batchRecord?.items)
      ? (batchRecord.items as Array<Record<string, unknown>>)
      : [];

    const enrichedItems = await Promise.all(
      rawItems.map(async (item) => {
        const orderId = String(item?.order_id ?? '').trim();
        if (!orderId) {
          return { ...item, order: null };
        }

        try {
          const orderRes = await this.sendOrderCommand<{
            data?: Record<string, unknown>;
          }>('order.find_by_id_enriched', { id: orderId });
          return {
            ...item,
            order:
              (orderRes as { data?: Record<string, unknown> })?.data ??
              orderRes ??
              null,
          };
        } catch {
          return {
            ...item,
            order: null,
          };
        }
      }),
    );

    return {
      ...batchRecord,
      items: enrichedItems,
      region: regionId ? (regionMap.get(regionId) ?? null) : null,
    };
  }

  async findTransferBatches(
    query: {
      source_branch_id?: string;
      destination_branch_id?: string;
      status?: string;
      direction?: string;
      period?: string;
      date?: string;
      page?: number;
      limit?: number;
    },
    requester?: RequesterContext,
  ) {
    const sourceBranchId = String(query?.source_branch_id ?? '').trim();
    const destinationBranchId = String(
      query?.destination_branch_id ?? '',
    ).trim();

    if (sourceBranchId) {
      await this.assertCanReadBranch(sourceBranchId, requester);
    }
    if (destinationBranchId) {
      await this.assertCanReadBranch(destinationBranchId, requester);
    }

    if (
      !this.isSystemPrivileged(requester) &&
      !sourceBranchId &&
      !destinationBranchId
    ) {
      const requesterId = String(requester?.id ?? '').trim();
      if (!requesterId) {
        this.forbidden('Requester aniqlanmadi');
      }

      const assignment = await this.branchUserRepo.findOne({
        where: { user_id: requesterId, isDeleted: false },
        order: { createdAt: 'DESC' },
      });

      if (!assignment) {
        this.forbidden('Filial biriktirilmagan foydalanuvchi');
      }

      const direction = String(query?.direction ?? '')
        .trim()
        .toUpperCase();
      const assignmentBranchId = String(assignment.branch_id);
      const scopedSourceBranchId =
        direction === BranchTransferDirection.RETURN
          ? undefined
          : assignmentBranchId;
      const scopedDestinationBranchId =
        direction === BranchTransferDirection.RETURN
          ? assignmentBranchId
          : undefined;

      const response = await this.sendOrderCommand(
        'order.transfer_batch.find_all',
        {
          source_branch_id: scopedSourceBranchId,
          destination_branch_id: scopedDestinationBranchId,
          status: query?.status,
          direction: query?.direction,
          period: query?.period,
          date: query?.date,
          page: query?.page,
          limit: query?.limit,
        },
      );
      return this.attachRegionsToTransferBatches(response);
    }

    const response = await this.sendOrderCommand(
      'order.transfer_batch.find_all',
      {
        source_branch_id: sourceBranchId || undefined,
        destination_branch_id: destinationBranchId || undefined,
        status: query?.status,
        direction: query?.direction,
        period: query?.period,
        date: query?.date,
        page: query?.page,
        limit: query?.limit,
      },
    );
    return this.attachRegionsToTransferBatches(response);
  }

  async findBranchesWithSentBatches(
    query: {
      direction?: string;
      side?: 'source' | 'destination' | string;
    },
    requester?: RequesterContext,
  ) {
    const response = await this.sendOrderCommand<{
      data?: {
        side?: 'source' | 'destination';
        direction?: string;
        items?: Array<{
          branch_id?: string;
          sent_batches_count?: number | string;
          sent_total_price?: number | string;
        }>;
      };
    }>('order.transfer_batch.find_branches_with_sent', {
      direction: query?.direction,
      side: query?.side,
    });

    const sideRaw = String(response?.data?.side ?? 'source').toLowerCase();
    const side: 'source' | 'destination' =
      sideRaw === 'destination' ? 'destination' : 'source';
    const aggregates = (response?.data?.items ?? [])
      .map((row) => ({
        branch_id: String(row?.branch_id ?? '').trim(),
        sent_batches_count: Number(row?.sent_batches_count ?? 0),
        sent_total_price: Number(row?.sent_total_price ?? 0),
      }))
      .filter((row) => Boolean(row.branch_id));
    const branchIds = Array.from(
      new Set(aggregates.map((row) => row.branch_id)),
    );

    if (!branchIds.length) {
      return successRes(
        { side, direction: response?.data?.direction, items: [] },
        200,
        'Branches with sent transfer batches found',
      );
    }

    const rows = await this.branchRepo.find({
      where: { id: In(branchIds), isDeleted: false },
      order: { name: 'ASC' },
    });
    const aggregateByBranchId = new Map(
      aggregates.map((row) => [row.branch_id, row]),
    );

    const canRead = async (branchId: string) => {
      try {
        await this.assertCanReadBranch(branchId, requester);
        return true;
      } catch {
        return false;
      }
    };

    const visible: Array<{
      id: string;
      name: string;
      phone_number: string | null;
      sent_batches_count: number;
      sent_total_price: number;
    }> = [];
    for (const row of rows) {
      if (await canRead(String(row.id))) {
        const aggregate = aggregateByBranchId.get(String(row.id));
        visible.push({
          id: String(row.id),
          name: row.name,
          phone_number: row.phone_number ?? null,
          sent_batches_count: Number(aggregate?.sent_batches_count ?? 0),
          sent_total_price: Number(aggregate?.sent_total_price ?? 0),
        });
      }
    }

    return successRes(
      {
        side,
        direction: response?.data?.direction,
        items: visible,
      },
      200,
      'Branches with sent transfer batches found',
    );
  }

  private async attachRegionsToTransferBatches(response: any) {
    const items = Array.isArray(response?.data?.items)
      ? response.data.items
      : [];
    if (!items.length) {
      return response;
    }

    const regionIds: string[] = Array.from(
      new Set(
        items
          .map((batch: Record<string, unknown>) =>
            String(batch?.target_region_id ?? '').trim(),
          )
          .filter(Boolean),
      ),
    );

    const regionMap = await this.getRegionsByIds(regionIds);
    const enrichedItems = items.map((batch: Record<string, unknown>) => {
      const regionId = String(batch?.target_region_id ?? '').trim();
      return {
        ...batch,
        region: regionId ? (regionMap.get(regionId) ?? null) : null,
      };
    });

    return {
      ...response,
      data: {
        ...(response?.data ?? {}),
        items: enrichedItems,
      },
    };
  }

  async findTransferBatchById(id: string, requester?: RequesterContext) {
    const batchId = String(id ?? '').trim();
    if (!batchId) {
      this.badRequest('batch id is required');
    }

    const response = await this.sendOrderCommand<{
      data?: { source_branch_id?: string; destination_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id: batchId });

    const sourceBranchId = String(
      response?.data?.source_branch_id ?? '',
    ).trim();
    const destinationBranchId = String(
      response?.data?.destination_branch_id ?? '',
    ).trim();

    if (sourceBranchId && destinationBranchId) {
      try {
        await this.assertCanReadBranch(sourceBranchId, requester);
      } catch {
        await this.assertCanReadBranch(destinationBranchId, requester);
      }
    } else if (sourceBranchId) {
      await this.assertCanReadBranch(sourceBranchId, requester);
    } else if (destinationBranchId) {
      await this.assertCanReadBranch(destinationBranchId, requester);
    }

    const batchData = (response as { data?: Record<string, unknown> })?.data;
    if (!batchData || typeof batchData !== 'object') {
      return response;
    }

    const batchRecord = batchData as Record<string, unknown>;
    const regionId = String(batchRecord?.target_region_id ?? '').trim();
    const regionMap = await this.getRegionsByIds(regionId ? [regionId] : []);
    const rawItems = Array.isArray(batchRecord?.items)
      ? (batchRecord.items as Array<Record<string, unknown>>)
      : [];

    const enrichedItems = await Promise.all(
      rawItems.map(async (item) => {
        const orderId = String(item?.order_id ?? '').trim();
        if (!orderId) {
          return { ...item, order: null };
        }

        try {
          const orderRes = await this.sendOrderCommand<{
            data?: Record<string, unknown>;
          }>('order.find_by_id_enriched', { id: orderId });
          return {
            ...item,
            order:
              (orderRes as { data?: Record<string, unknown> })?.data ??
              orderRes ??
              null,
          };
        } catch {
          return {
            ...item,
            order: null,
          };
        }
      }),
    );

    return {
      ...batchRecord,
      items: enrichedItems,
      region: regionId ? (regionMap.get(regionId) ?? null) : null,
    };
  }

  private async assertRequesterWorksInBranch(
    branchId: string,
    requester?: RequesterContext,
  ) {
    if (this.isSystemPrivileged(requester)) {
      return;
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const assignment = await this.branchUserRepo.findOne({
      where: {
        user_id: requesterId,
        branch_id: String(branchId),
        isDeleted: false,
      },
      select: ['id'],
    });
    if (!assignment) {
      this.forbidden('Qabul qiluvchi xodim manzil filialga biriktirilmagan');
    }
  }

  async receiveTransferBatch(batchId: string, requester?: RequesterContext) {
    const id = String(batchId ?? '').trim();
    if (!id) {
      this.badRequest('batch id is required');
    }

    const batchRes = await this.sendOrderCommand<{
      data?: { destination_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id });
    const destinationBranchId = String(
      batchRes?.data?.destination_branch_id ?? '',
    ).trim();
    if (!destinationBranchId) {
      this.notFound('Transfer batch not found');
    }
    const destinationBranch = await this.getBranchOrThrow(destinationBranchId);
    this.assertBranchCanReceiveBatches(destinationBranch);

    await this.assertRequesterWorksInBranch(destinationBranchId, requester);

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const receiveResult = await this.sendOrderCommand(
      'order.transfer_batch.receive',
      {
        batch_id: id,
        requester_id: requesterId,
        requester_name: requesterId,
        requester_roles: requester?.roles ?? [],
      },
    );

    await this.activityLog.log({
      entity_type: 'TransferBatch',
      entity_id: String(id),
      action: ActivityAction.STATUS_CHANGE,
      metadata: {
        status: 'RECEIVED',
        destination_branch_id: destinationBranchId,
      },
      ...this.auditActor(requester),
    });

    return receiveResult;
  }

  async receiveTransferBatchOrders(
    batchId: string,
    dto: { orderIds?: string[]; order_ids?: string[] },
    requester?: RequesterContext,
  ) {
    const id = String(batchId ?? '').trim();
    if (!id) {
      this.badRequest('batch id is required');
    }

    const orderIds = Array.from(
      new Set(
        (dto?.orderIds ?? dto?.order_ids ?? [])
          .map((value) => String(value ?? '').trim())
          .filter(Boolean),
      ),
    );
    if (!orderIds.length) {
      this.badRequest("orderIds/order_ids bo'sh bo'lmasligi kerak");
    }

    const uniqueOrderIds = orderIds;

    const batchRes = await this.sendOrderCommand<{
      data?: { destination_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id });
    const destinationBranchId = String(
      batchRes?.data?.destination_branch_id ?? '',
    ).trim();
    if (!destinationBranchId) {
      this.notFound('Transfer batch not found');
    }
    const destinationBranch = await this.getBranchOrThrow(destinationBranchId);
    this.assertBranchCanReceiveBatches(destinationBranch);

    await this.assertRequesterWorksInBranch(destinationBranchId, requester);

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const receiveOrdersResult = await this.sendOrderCommand(
      'order.transfer_batch.receive_orders',
      {
        batch_id: id,
        order_ids: uniqueOrderIds,
        requester_id: requesterId,
        requester_name: requesterId,
        requester_roles: requester?.roles ?? [],
      },
    );

    await this.activityLog.log({
      entity_type: 'TransferBatch',
      entity_id: String(id),
      action: ActivityAction.STATUS_CHANGE,
      metadata: {
        status: 'RECEIVED_ORDERS',
        destination_branch_id: destinationBranchId,
        order_count: uniqueOrderIds.length,
        order_ids: uniqueOrderIds.slice(0, 20),
      },
      ...this.auditActor(requester),
    });

    return receiveOrdersResult;
  }

  async cancelTransferBatch(
    batchId: string,
    dto: {
      reason?: string;
    },
    requester?: RequesterContext,
  ) {
    const id = String(batchId ?? '').trim();
    if (!id) {
      this.badRequest('batch id is required');
    }

    const reason = String(dto?.reason ?? '').trim();
    if (!reason || reason.length < 10) {
      this.badRequest(
        "Bekor qilish sababi kamida 10 ta belgidan iborat bo'lishi kerak",
      );
    }

    const batchRes = await this.sendOrderCommand<{
      data?: { source_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id });
    const sourceBranchId = String(
      batchRes?.data?.source_branch_id ?? '',
    ).trim();
    if (!sourceBranchId) {
      this.notFound('Transfer batch not found');
    }

    await this.assertCanCreateTransferBatch(sourceBranchId, requester);

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const requesterName = requesterId;

    const cancelResult = await this.sendOrderCommand(
      'order.transfer_batch.cancel',
      {
        batch_id: id,
        reason,
        requester_id: requesterId,
        requester_name: requesterName,
        requester_roles: requester?.roles ?? [],
      },
    );

    // Keep compatibility with T13 flow: send explicit unassign command as well.
    // This is safe and idempotent even if orders were already unassigned in cancel command.
    try {
      await this.sendOrderCommand('order.bulk_remove_from_batch', {
        batch_id: id,
        message_id: `cancel_batch_${id}`,
      });
    } catch {
      // Best-effort call; main cancel transaction has already handled unassignment.
    }

    await this.activityLog.log({
      entity_type: 'TransferBatch',
      entity_id: String(id),
      action: ActivityAction.STATUS_CHANGE,
      metadata: {
        status: 'CANCELLED',
        source_branch_id: sourceBranchId,
        reason,
      },
      ...this.auditActor(requester),
    });

    return cancelResult;
  }

  async dispatchPostToBranch(
    sourceBranchIdInput: string,
    postIdInput: string,
    destinationBranchIdInput: string,
    orderIdsInput?: string[],
    requester?: RequesterContext,
  ) {
    const sourceBranchId = String(sourceBranchIdInput ?? '').trim();
    const destinationBranchId = String(destinationBranchIdInput ?? '').trim();
    const postId = String(postIdInput ?? '').trim();

    if (!sourceBranchId || !destinationBranchId || !postId) {
      this.badRequest(
        'source_branch_id, destination_branch_id va post_id majburiy',
      );
    }

    const sourceBranch = await this.getBranchOrThrow(sourceBranchId);
    const destinationBranch = await this.getBranchOrThrow(destinationBranchId);

    if (sourceBranch.type !== BranchType.HQ) {
      this.forbidden("Post dispatch faqat HQ branch'dan ruxsat etilgan");
    }
    await this.assertCanWriteBranch(sourceBranchId, requester);

    const requesterPayload = {
      id: String(requester?.id ?? ''),
      roles: requester?.roles ?? [],
    };

    const postOrdersResponse = await this.sendLogisticsCommand<{
      data?:
        | Array<Record<string, unknown>>
        | { allOrdersByPostId?: Array<Record<string, unknown>> };
    }>('logistics.post.orders_by_post', {
      id: postId,
      requester: requesterPayload,
    });

    const rawData = postOrdersResponse?.data;
    const orders = Array.isArray(rawData)
      ? rawData
      : Array.isArray(rawData?.allOrdersByPostId)
        ? rawData.allOrdersByPostId
        : [];
    if (!orders.length) {
      throw new RpcException(
        errorRes("Post ichida jo'natishga mos order topilmadi", 400, {
          post_id: postId,
          source_branch_id: sourceBranchId,
          destination_branch_id: destinationBranchId,
          total_in_post: 0,
          eligible_orders_count: 0,
          reasons: {
            empty_post: true,
          },
        }),
      );
    }

    const selectedOrderIds = Array.isArray(orderIdsInput)
      ? orderIdsInput.map((id) => String(id ?? '').trim()).filter(Boolean)
      : [];
    if (!selectedOrderIds.length) {
      this.badRequest('order_ids is required');
    }

    const selectedSet = new Set(selectedOrderIds);
    const candidateOrders = orders.filter((order) =>
      selectedSet.has(String(order?.id ?? '').trim()),
    );

    if (!candidateOrders.length) {
      throw new RpcException(
        errorRes('Tanlangan order_ids post ichida topilmadi', 400, {
          post_id: postId,
          source_branch_id: sourceBranchId,
          destination_branch_id: destinationBranchId,
          selected_order_ids: selectedOrderIds,
        }),
      );
    }

    const orderIds = candidateOrders
      .map((order) => String(order?.id ?? ''))
      .filter(Boolean);
    const mismatchedOrders = candidateOrders.filter(
      (order) => String(order?.branch_id ?? '') !== sourceBranchId,
    );
    const deletedOrders = candidateOrders.filter((order) =>
      Boolean(order?.isDeleted ?? order?.is_deleted),
    );
    const blockedStatusOrders = candidateOrders.filter((order) => {
      const status = String(order?.status ?? '')
        .trim()
        .toLowerCase();
      return (
        status === Order_status.CANCELLED || status === Order_status.CLOSED
      );
    });

    const ineligibleOrderIds = new Set(
      [...mismatchedOrders, ...deletedOrders, ...blockedStatusOrders]
        .map((order) => String(order?.id ?? '').trim())
        .filter(Boolean),
    );

    const eligibleOrderIds = orderIds.filter(
      (id) => !ineligibleOrderIds.has(id),
    );

    if (!eligibleOrderIds.length) {
      throw new RpcException(
        errorRes("Post ichida jo'natishga mos order topilmadi", 400, {
          post_id: postId,
          source_branch_id: sourceBranchId,
          destination_branch_id: destinationBranchId,
          total_in_post: orderIds.length,
          eligible_orders_count: 0,
          reasons: {
            branch_mismatch_count: mismatchedOrders.length,
            deleted_count: deletedOrders.length,
            blocked_status_count: blockedStatusOrders.length,
          },
          sample_order_ids: orderIds.slice(0, 10),
        }),
      );
    }

    if (mismatchedOrders.length) {
      throw new RpcException(
        errorRes(
          "Post ichida manba branch'ga tegishli bo'lmagan order bor. Avval postni tozalang yoki to'g'rilang",
          400,
          {
            post_id: postId,
            source_branch_id: sourceBranchId,
            destination_branch_id: destinationBranchId,
            total_in_post: orderIds.length,
            eligible_orders_count: eligibleOrderIds.length,
            reasons: {
              branch_mismatch_count: mismatchedOrders.length,
              deleted_count: deletedOrders.length,
              blocked_status_count: blockedStatusOrders.length,
            },
            mismatched_order_ids: mismatchedOrders
              .map((order) => String(order?.id ?? '').trim())
              .filter(Boolean)
              .slice(0, 20),
          },
        ),
      );
    }

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const note = `Post #${postId} HQ'dan branch #${destinationBranchId} ga dispatch qilindi`;

    const destinationPostAssignmentsRes = await this.sendLogisticsCommand<{
      data?: Array<{ order_id?: string; post_id?: string }>;
    }>('logistics.post.receive_orders', {
      orders: candidateOrders
        .filter((order) => eligibleOrderIds.includes(String(order?.id ?? '')))
        .map((order) => ({
          order_id: String(order?.id ?? ''),
          assigned_region: String(order?.region_id ?? ''),
          assigned_branch: destinationBranchId,
          assigned_post_status: Post_status.SENT,
          total_price: Number(order?.total_price ?? 0),
        })),
    });

    const assignmentMap = new Map<string, string>(
      (destinationPostAssignmentsRes?.data ?? [])
        .map(
          (row) =>
            [String(row?.order_id ?? ''), String(row?.post_id ?? '')] as const,
        )
        .filter(([orderId, postId]) => Boolean(orderId) && Boolean(postId)),
    );

    for (const orderId of eligibleOrderIds) {
      const destinationPostId = assignmentMap.get(orderId) ?? null;
      await this.sendOrderCommand('order.update', {
        id: orderId,
        dto: {
          branch_id: destinationBranchId,
          post_id: destinationPostId,
          current_batch_id: null,
          status: Order_status.ON_THE_ROAD,
        },
        requester: {
          id: requesterId,
          roles: requester?.roles ?? [],
          note,
        },
      });
    }

    const shouldDeletePost = eligibleOrderIds.length === orders.length;
    if (shouldDeletePost) {
      await this.sendLogisticsCommand('logistics.post.delete', { id: postId });
    }

    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: String(postId),
      action: 'branch.post_dispatch',
      metadata: {
        source_branch_id: sourceBranchId,
        destination_branch_id: destinationBranchId,
        order_count: eligibleOrderIds.length,
        order_ids: eligibleOrderIds.slice(0, 20),
        post_deleted: shouldDeletePost,
      },
      ...this.auditActor(requester),
    });

    return successRes(
      {
        source_branch_id: sourceBranchId,
        destination_branch_id: destinationBranchId,
        post_id: postId,
        selected_order_ids: selectedOrderIds,
        moved_orders_count: eligibleOrderIds.length,
        moved_order_ids: eligibleOrderIds,
        post_deleted: shouldDeletePost,
      },
      200,
      'Post HQ dan branchga muvaffaqiyatli dispatch qilindi',
    );
  }

  async findTransferBatchByToken(token: string, requester?: RequesterContext) {
    const normalizedToken = String(token ?? '').trim();
    if (!normalizedToken) {
      this.badRequest('token is required');
    }

    let response: {
      data?: Record<string, unknown>;
      statusCode?: number;
      message?: string;
    };
    try {
      response = await lastValueFrom(
        this.orderClient
          .send(
            { cmd: 'order.transfer_batch.find_by_qr' },
            { token: normalizedToken },
          )
          .pipe(timeout(15000)),
      );
    } catch (error) {
      if (error instanceof TimeoutError) {
        throw new RpcException(errorRes('Order service unavailable', 502));
      }
      throw error;
    }

    const payload = (response?.data ?? null) as {
      source_branch_id?: string;
      destination_branch_id?: string;
    } | null;

    const sourceBranchId = String(payload?.source_branch_id ?? '').trim();
    const destinationBranchId = String(
      payload?.destination_branch_id ?? '',
    ).trim();

    if (sourceBranchId) {
      await this.assertCanReadBranch(sourceBranchId, requester);
    } else if (destinationBranchId) {
      await this.assertCanReadBranch(destinationBranchId, requester);
    }

    return response;
  }

  async createBranch(
    dto: {
      name?: string;
      location?: string;
      address?: string;
      phone_number?: string;
      region_id?: string | null;
      district_id?: string | null;
      parent_id?: string | null;
      type?: BranchType | string;
      code?: string;
      manager_id?: string | null;
    },
    requester?: RequesterContext,
  ) {
    const name = String(dto?.name ?? '').trim();
    if (!name) {
      this.badRequest('name is required');
    }

    await this.ensureBranchNameUnique(name);

    const type = this.parseBranchType(dto?.type);
    const code = this.normalizeBranchCode(dto?.code);
    await this.ensureBranchCodeUnique(code);

    const parentId = this.normalizeNullableBigint(dto?.parent_id);
    let level = 0;

    if (type === BranchType.HQ) {
      if (parentId) {
        this.badRequest('HQ branch cannot have parent_id');
      }
      const existingHq = await this.branchRepo.findOne({
        where: { type: BranchType.HQ, isDeleted: false },
      });
      if (existingHq) {
        this.conflict('Only one HQ branch is allowed');
      }
    } else {
      if (!parentId) {
        this.badRequest('parent_id is required for non-HQ branches');
      }
      const parent = await this.getParentBranchOrThrow(parentId);
      level = Number(parent.level) + 1;
    }

    const saved = await this.branchRepo.save(
      this.branchRepo.create({
        name,
        address: String(dto?.address ?? dto?.location ?? '').trim() || null,
        phone_number: String(dto?.phone_number ?? '').trim() || null,
        region_id: this.normalizeNullableBigint(dto?.region_id),
        district_id: this.normalizeNullableBigint(dto?.district_id),
        parent_id: parentId,
        type,
        level,
        code,
        manager_id: this.normalizeNullableBigint(dto?.manager_id),
        status: Status.ACTIVE,
      }),
    );

    await this.activityLog.log({
      entity_type: 'Branch',
      entity_id: String(saved.id),
      action: ActivityAction.CREATED,
      new_value: saved,
      metadata: {
        parent_id: saved.parent_id ?? null,
        region_id: saved.region_id ?? null,
        district_id: saved.district_id ?? null,
        manager_id: saved.manager_id ?? null,
        type: saved.type,
      },
      ...this.auditActor(requester),
    });

    return successRes(saved, 201, 'Branch created');
  }

  async findAllBranches(
    query?: {
      search?: string;
      status?: string;
      page?: number;
      limit?: number;
    },
    requester?: RequesterContext,
  ) {
    const { page, limit, skip } = this.normalizePagination(
      query?.page,
      query?.limit,
    );
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
        '(branch.name ILIKE :search OR branch.code ILIKE :search OR branch.address ILIKE :search OR branch.phone_number ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (!this.isSystemPrivileged(requester)) {
      const scope = await this.resolveAccessScope(requester);
      const allowedBranchIds = Array.from(scope.readableBranchIds);
      if (!allowedBranchIds.length) {
        return successRes(
          {
            items: [],
            meta: {
              page,
              limit,
              total: 0,
              totalPages: 1,
            },
          },
          200,
          'Branches list',
        );
      }
      qb.andWhere('branch.id IN (:...allowedBranchIds)', { allowedBranchIds });
    }

    const [items, total] = await qb.skip(skip).take(limit).getManyAndCount();

    const regionIds = Array.from(
      new Set(
        items
          .map((item) => item.region_id)
          .filter((regionId): regionId is string => Boolean(regionId)),
      ),
    );
    const districtIds = Array.from(
      new Set(
        items
          .map((item) => item.district_id)
          .filter((districtId): districtId is string => Boolean(districtId)),
      ),
    );
    const parentIds = Array.from(
      new Set(
        items
          .map((item) => item.parent_id)
          .filter((parentId): parentId is string => Boolean(parentId)),
      ),
    );

    const regionMap = await this.getRegionsByIds(regionIds);
    const districtMap = await this.getDistrictsByIds(districtIds);
    const parentMap = await this.getParentsByIds(parentIds);
    const branchIds = items.map((item) => String(item.id)).filter(Boolean);
    const managerAssignments = branchIds.length
      ? await this.branchUserRepo.find({
          where: {
            isDeleted: false,
            role: BranchUserRole.MANAGER,
            branch_id: In(branchIds),
          },
          select: ['branch_id', 'user_id'],
        })
      : [];
    const courierAssignments = branchIds.length
      ? await this.branchUserRepo.find({
          where: {
            isDeleted: false,
            role: BranchUserRole.COURIER,
            branch_id: In(branchIds),
          },
          select: ['branch_id', 'user_id'],
        })
      : [];

    const managerByBranchId = new Map<string, string>();
    for (const assignment of managerAssignments) {
      const branchId = String(assignment.branch_id ?? '').trim();
      const userId = String(assignment.user_id ?? '').trim();
      if (!branchId || !userId || managerByBranchId.has(branchId)) {
        continue;
      }
      managerByBranchId.set(branchId, userId);
    }

    const courierIdsByBranchId = new Map<string, string[]>();
    for (const assignment of courierAssignments) {
      const branchId = String(assignment.branch_id ?? '').trim();
      const userId = String(assignment.user_id ?? '').trim();
      if (!branchId || !userId) continue;
      const existing = courierIdsByBranchId.get(branchId) ?? [];
      if (!existing.includes(userId)) {
        existing.push(userId);
        courierIdsByBranchId.set(branchId, existing);
      }
    }

    const managerIds = Array.from(
      new Set(Array.from(managerByBranchId.values())),
    );
    const managerUsersMap = await this.getUsersByIds(managerIds);
    const paymentByManagerId = new Map<string, unknown>();
    const courierBalanceByUserId = new Map<string, number>();

    await Promise.all(
      managerIds.map(async (managerId) => {
        try {
          const salaryRes = await this.sendFinanceCommand<{ data?: unknown }>(
            'finance.salary.find_by_user',
            { user_id: managerId },
          );
          paymentByManagerId.set(managerId, salaryRes?.data ?? null);
        } catch {
          const managerUser = managerUsersMap.get(managerId) as Record<
            string,
            unknown
          > | null;
          if (managerUser) {
            paymentByManagerId.set(managerId, {
              user_id: managerId,
              salary_amount: Number(managerUser.salary ?? 0),
              payment_day:
                managerUser.payment_day !== undefined &&
                managerUser.payment_day !== null
                  ? Number(managerUser.payment_day)
                  : null,
              tariff_home:
                managerUser.tariff_home !== undefined &&
                managerUser.tariff_home !== null
                  ? Number(managerUser.tariff_home)
                  : null,
              tariff_center:
                managerUser.tariff_center !== undefined &&
                managerUser.tariff_center !== null
                  ? Number(managerUser.tariff_center)
                  : null,
              source: 'identity_fallback',
            });
            return;
          }
          paymentByManagerId.set(managerId, null);
        }
      }),
    );

    const allCourierIds = Array.from(
      new Set(
        Array.from(courierIdsByBranchId.values())
          .flat()
          .map((id) => String(id))
          .filter(Boolean),
      ),
    );

    await Promise.all(
      allCourierIds.map(async (courierId) => {
        try {
          const cashboxRes = await this.sendFinanceCommand<{
            data?: { balance?: number | string };
          }>('finance.cashbox.find_by_user', {
            user_id: courierId,
            cashbox_type: Cashbox_type.FOR_COURIER,
          });
          const rawBalance = Number(cashboxRes?.data?.balance ?? 0);
          courierBalanceByUserId.set(
            courierId,
            Number.isFinite(rawBalance) ? rawBalance : 0,
          );
        } catch {
          courierBalanceByUserId.set(courierId, 0);
        }
      }),
    );

    const payableToHqByBranchId = new Map<string, number>();
    await Promise.all(
      items.map(async (item) => {
        const branchId = String(item.id ?? '').trim();
        const managerId = managerByBranchId.get(branchId);
        if (!branchId || !managerId || item.type === BranchType.HQ) {
          payableToHqByBranchId.set(branchId, 0);
          return;
        }

        const manager = managerUsersMap.get(managerId) as Record<
          string,
          unknown
        > | null;
        const managerTariffHome = Math.max(
          Number(manager?.tariff_home ?? 0),
          0,
        );
        const managerTariffCenter = Math.max(
          Number(manager?.tariff_center ?? 0),
          0,
        );
        const courierIds = courierIdsByBranchId.get(branchId) ?? [];
        const courierUsersMap = await this.getUsersByIds(courierIds);
        const courierTariffMap = new Map(
          courierIds.map((courierId) => {
            const courier = courierUsersMap.get(courierId) as Record<
              string,
              unknown
            > | null;
            return [
              courierId,
              {
                home: Math.max(Number(courier?.tariff_home ?? 0), 0),
                center: Math.max(Number(courier?.tariff_center ?? 0), 0),
              },
            ] as const;
          }),
        );

        const soldOrderQuery = {
          status: [
            Order_status.SOLD,
            Order_status.PAID,
            Order_status.PARTLY_PAID,
          ],
          fetch_all: true,
          page: 1,
          limit: 5000,
        };
        const [branchOrdersResponse, courierOrdersResponse] = await Promise.all(
          [
            this.sendOrderCommand<any>('order.find_all', {
              query: {
                ...soldOrderQuery,
                branch_id: branchId,
              },
            }).catch(() => null),
            courierIds.length
              ? this.sendOrderCommand<any>('order.find_all', {
                  query: {
                    ...soldOrderQuery,
                    courier_ids: courierIds,
                  },
                }).catch(() => null)
              : Promise.resolve(null),
          ],
        );

        const extractOrders = (response: any): any[] => {
          const candidates = [
            response?.data?.data,
            response?.data?.items,
            response?.data,
            response,
          ];
          return candidates.find((candidate) => Array.isArray(candidate)) ?? [];
        };
        const orders = Array.from(
          new Map(
            [
              ...extractOrders(branchOrdersResponse),
              ...extractOrders(courierOrdersResponse),
            ].map((order: any) => [String(order?.id ?? ''), order]),
          ).values(),
        );
        const courierOrders = new Map<string, any[]>();
        let payableToHq = 0;

        const calculateAmounts = (order: any) => {
          const totalPrice = Math.max(Number(order?.total_price ?? 0), 0);
          const isCenter =
            String(order?.where_deliver ?? '').toLowerCase() ===
            String(Where_deliver.CENTER).toLowerCase();
          const managerTariff = isCenter
            ? managerTariffCenter
            : managerTariffHome;
          const courierId = String(order?.courier_id ?? '').trim();
          const courierTariffs = courierTariffMap.get(courierId);
          const savedCourierTariff = Number(order?.courier_tariff ?? NaN);
          const courierTariff = Number.isFinite(savedCourierTariff)
            ? Math.max(savedCourierTariff, 0)
            : isCenter
              ? Number(courierTariffs?.center ?? 0)
              : Number(courierTariffs?.home ?? 0);

          return {
            courierId,
            courierReceivable: Math.max(totalPrice - courierTariff, 0),
            hqPayable: Math.max(totalPrice - managerTariff, 0),
          };
        };

        for (const order of orders) {
          const amounts = calculateAmounts(order);
          if (!amounts.courierId || !courierTariffMap.has(amounts.courierId)) {
            payableToHq += amounts.hqPayable;
            continue;
          }
          const rows = courierOrders.get(amounts.courierId) ?? [];
          rows.push(order);
          courierOrders.set(amounts.courierId, rows);
        }

        for (const [courierId, rows] of courierOrders) {
          const sortedOrders = [...rows].sort(
            (left, right) =>
              new Date(left?.createdAt ?? 0).getTime() -
              new Date(right?.createdAt ?? 0).getTime(),
          );
          const totalCourierReceivable = sortedOrders.reduce(
            (sum, order) => sum + calculateAmounts(order).courierReceivable,
            0,
          );
          let acceptedAmount = Math.max(
            totalCourierReceivable -
              Math.max(Number(courierBalanceByUserId.get(courierId) ?? 0), 0),
            0,
          );

          for (const order of sortedOrders) {
            if (acceptedAmount <= 0) break;
            const amounts = calculateAmounts(order);
            if (amounts.courierReceivable <= 0) {
              payableToHq += amounts.hqPayable;
              continue;
            }
            const allocated = Math.min(
              acceptedAmount,
              amounts.courierReceivable,
            );
            payableToHq +=
              amounts.hqPayable * (allocated / amounts.courierReceivable);
            acceptedAmount -= allocated;
          }
        }

        let paidToHq = 0;
        try {
          const cashboxResponse = await this.sendFinanceCommand<{
            data?: {
              id?: string;
              cashbox?: { id?: string };
            };
          }>('finance.cashbox.find_by_user', {
            user_id: branchId,
            cashbox_type: Cashbox_type.BRANCH,
          });
          const cashboxId = String(
            cashboxResponse?.data?.cashbox?.id ??
              cashboxResponse?.data?.id ??
              '',
          ).trim();

          if (cashboxId) {
            const historyResponse = await this.sendFinanceCommand<{
              data?: {
                items?: Array<{ amount?: number | string }>;
              };
            }>('finance.history.find_all', {
              cashbox_id: cashboxId,
              operation_type: Operation_type.EXPENSE,
              source_type: Source_type.BRANCH_TO_MAIN,
              page: 0,
              limit: 0,
            });
            paidToHq = (historyResponse?.data?.items ?? []).reduce(
              (sum, history) => {
                const amount = Number(history?.amount ?? 0);
                return (
                  sum + (Number.isFinite(amount) && amount > 0 ? amount : 0)
                );
              },
              0,
            );
          }
        } catch {
          paidToHq = 0;
        }

        payableToHqByBranchId.set(
          branchId,
          Math.max(Math.round(payableToHq) - paidToHq, 0),
        );
      }),
    );

    const enrichedItems = items.map((item) => ({
      ...item,
      region: item.region_id ? (regionMap.get(item.region_id) ?? null) : null,
      district: item.district_id
        ? (districtMap.get(item.district_id) ?? null)
        : null,
      parent: item.parent_id ? (parentMap.get(item.parent_id) ?? null) : null,
      olinishi_kerak: (() => {
        if (item.type === BranchType.HQ) {
          const courierIds = courierIdsByBranchId.get(String(item.id)) ?? [];
          return courierIds.reduce((sum, courierId) => {
            const balance = Number(courierBalanceByUserId.get(courierId) ?? 0);
            return balance > 0 ? sum + balance : sum;
          }, 0);
        }
        return Number(payableToHqByBranchId.get(String(item.id)) ?? 0);
      })(),
      payment: (() => {
        const managerId = managerByBranchId.get(String(item.id));
        if (!managerId) return null;
        return paymentByManagerId.get(managerId) ?? null;
      })(),
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

  async findBranchByCode(code: string) {
    const normalized = String(code ?? '')
      .trim()
      .toUpperCase();
    if (!normalized) {
      this.badRequest('code is required');
    }
    const branch = await this.branchRepo.findOne({
      where: { code: normalized, isDeleted: false },
    });
    if (!branch) {
      this.notFound('Branch not found by code');
    }
    return successRes(branch, 200, 'Branch found');
  }

  async findHqBranch() {
    const branch = await this.branchRepo.findOne({
      where: { code: this.hqCode, isDeleted: false },
    });
    if (branch) {
      return successRes(branch, 200, 'HQ branch');
    }
    const fallback = await this.branchRepo.findOne({
      where: { type: BranchType.HQ, isDeleted: false },
    });
    if (!fallback) {
      this.notFound('HQ branch topilmadi');
    }
    return successRes(fallback, 200, 'HQ branch');
  }

  async findBranchById(id: string, requester?: RequesterContext) {
    await this.assertCanReadBranch(id, requester);
    const branch = await this.getBranchOrThrow(id);
    const regionMap = await this.getRegionsByIds(
      branch.region_id ? [branch.region_id] : [],
    );
    const districtMap = await this.getDistrictsByIds(
      branch.district_id ? [branch.district_id] : [],
    );
    const parentMap = await this.getParentsByIds(
      branch.parent_id ? [branch.parent_id] : [],
    );

    return successRes(
      {
        ...branch,
        region: branch.region_id
          ? (regionMap.get(branch.region_id) ?? null)
          : null,
        district: branch.district_id
          ? (districtMap.get(branch.district_id) ?? null)
          : null,
        parent: branch.parent_id
          ? (parentMap.get(branch.parent_id) ?? null)
          : null,
      },
      200,
      'Branch found',
    );
  }

  async findBranchTree() {
    const branches = await this.branchRepo.find({
      where: { isDeleted: false },
      order: { level: 'ASC', createdAt: 'ASC' },
    });

    type BranchTreeNode = Branch & { children: BranchTreeNode[] };
    const nodeMap = new Map<string, BranchTreeNode>();
    const roots: BranchTreeNode[] = [];

    branches.forEach((branch) => {
      nodeMap.set(branch.id, { ...branch, children: [] });
    });

    branches.forEach((branch) => {
      const node = nodeMap.get(branch.id)!;
      const parentId = branch.parent_id ?? null;
      if (!parentId) {
        roots.push(node);
        return;
      }

      const parent = nodeMap.get(parentId);
      if (!parent) {
        // If parent is missing (deleted/inconsistent), treat as root.
        roots.push(node);
        return;
      }

      parent.children.push(node);
    });

    return successRes(roots, 200, 'Branch tree');
  }

  async findBranchDescendants(id: string) {
    const root = await this.getBranchOrThrow(id);
    const branches = await this.branchRepo.find({
      where: { isDeleted: false },
      order: { level: 'ASC', createdAt: 'ASC' },
    });

    const childrenByParent = new Map<string, Branch[]>();
    branches.forEach((branch) => {
      if (!branch.parent_id) {
        return;
      }
      const current = childrenByParent.get(branch.parent_id) ?? [];
      current.push(branch);
      childrenByParent.set(branch.parent_id, current);
    });

    const descendants: Branch[] = [];
    const queue: string[] = [root.id];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = childrenByParent.get(currentId) ?? [];
      for (const child of children) {
        descendants.push(child);
        queue.push(child.id);
      }
    }

    return successRes(descendants, 200, 'Branch descendants');
  }

  async getBranchStats(id: string, requester?: RequesterContext) {
    const targetBranchIds = await this.resolveAnalyticsBranchIds(id, requester);
    const orders = await this.getOrdersByBranchIds(targetBranchIds);
    const requesterBranchRole = await this.resolveRequesterBranchRole(
      targetBranchIds,
      requester,
    );

    const now = new Date();
    const todayStart = this.toTashkentStartOfDay(now);
    const weekStart = this.toTashkentStartOfWeek(now);

    const todayOrdersCount = orders.filter(
      (order) => order.createdAt && order.createdAt >= todayStart,
    ).length;

    const weekOrdersCount = orders.filter(
      (order) => order.createdAt && order.createdAt >= weekStart,
    ).length;
    const todayOrders = orders.filter(
      (order) => order.createdAt && order.createdAt >= todayStart,
    );

    const activeBatchStatuses = new Set<string>([
      Order_status.CREATED,
      Order_status.NEW,
      Order_status.RECEIVED,
      Order_status.ON_THE_ROAD,
      Order_status.WAITING,
      Order_status.WAITING_CUSTOMER,
      Order_status.PARTLY_PAID,
    ]);

    const activeBatchesCount = new Set(
      orders
        .filter(
          (order) =>
            order.current_batch_id &&
            order.status &&
            activeBatchStatuses.has(order.status),
        )
        .map((order) => String(order.current_batch_id)),
    ).size;

    const couriersCount = await this.branchUserRepo.count({
      where: {
        branch_id: In(targetBranchIds),
        role: BranchUserRole.COURIER,
        isDeleted: false,
      },
    });

    const deliveredStatuses = new Set<string>([
      Order_status.WAITING,
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
      Order_status.CLOSED,
    ]);

    const returnedStatuses = new Set<string>([Order_status.RETURNED_TO_MARKET]);

    const ordersCard = {
      total: todayOrders.length,
      new: todayOrders.filter((order) => order.status === Order_status.NEW)
        .length,
      on_the_road: todayOrders.filter(
        (order) => order.status === Order_status.ON_THE_ROAD,
      ).length,
      delivered: todayOrders.filter(
        (order) => order.status && deliveredStatuses.has(order.status),
      ).length,
      returned: todayOrders.filter(
        (order) => order.status && returnedStatuses.has(order.status),
      ).length,
    };

    const marketMap = new Map<
      string,
      { market_id: string; orders_count: number; total_price: number }
    >();
    for (const order of todayOrders) {
      const marketId = String(order.market_id ?? '').trim();
      if (!marketId) continue;
      const current = marketMap.get(marketId) ?? {
        market_id: marketId,
        orders_count: 0,
        total_price: 0,
      };
      current.orders_count += 1;
      current.total_price += Number(order.total_price ?? 0) || 0;
      marketMap.set(marketId, current);
    }

    const marketsCard = Array.from(marketMap.values()).sort(
      (left, right) => right.orders_count - left.orders_count,
    );

    const packagesOnTheWay = new Set(
      orders
        .filter(
          (order) =>
            order.current_batch_id && order.status === Order_status.ON_THE_ROAD,
        )
        .map((order) => String(order.current_batch_id)),
    ).size;

    const waitingForAcceptance = new Set(
      orders
        .filter(
          (order) =>
            order.current_batch_id && order.status === Order_status.RECEIVED,
        )
        .map((order) => String(order.current_batch_id)),
    ).size;

    const packagesCard = {
      on_the_way: packagesOnTheWay,
      waiting_for_acceptance: waitingForAcceptance,
    };

    const activeTodayCouriersCount = new Set(
      todayOrders
        .map((order) => String(order.courier_id ?? '').trim())
        .filter((courierId) => Boolean(courierId)),
    ).size;

    const couriersCard = {
      branch_couriers: couriersCount,
      active_today: activeTodayCouriersCount,
    };

    const canSeeAll =
      requesterBranchRole === 'SUPER' ||
      requesterBranchRole === BranchUserRole.MANAGER;
    const canSeeMarkets = canSeeAll;

    return successRes(
      {
        today_orders_count: todayOrdersCount,
        week_orders_count: weekOrdersCount,
        active_batches_count: activeBatchesCount,
        couriers_count: couriersCount,
        role: requesterBranchRole,
        cards: {
          orders: ordersCard,
          markets: canSeeMarkets ? marketsCard : null,
          packages: packagesCard,
          couriers: canSeeAll ? couriersCard : null,
        },
        visibility: {
          orders: true,
          markets: canSeeMarkets,
          packages: true,
          couriers: canSeeAll,
        },
      },
      200,
      'Branch stats',
    );
  }

  async getBranchMarketsAnalytics(id: string, requester?: RequesterContext) {
    const targetBranchIds = await this.resolveAnalyticsBranchIds(id, requester);
    const orders = await this.getOrdersByBranchIds(targetBranchIds);

    const deliveredStatuses = new Set<string>([
      Order_status.WAITING,
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
      Order_status.CLOSED,
      Order_status.RETURNED_TO_MARKET,
    ]);

    const marketMap = new Map<
      string,
      {
        market_id: string;
        orders_count: number;
        delivered_count: number;
        total_price: number;
      }
    >();

    for (const order of orders) {
      const marketId = String(order.market_id ?? '').trim();
      if (!marketId) {
        continue;
      }

      const current = marketMap.get(marketId) ?? {
        market_id: marketId,
        orders_count: 0,
        delivered_count: 0,
        total_price: 0,
      };

      current.orders_count += 1;
      current.total_price += Number(order.total_price ?? 0) || 0;
      if (order.status && deliveredStatuses.has(order.status)) {
        current.delivered_count += 1;
      }

      marketMap.set(marketId, current);
    }

    const items = Array.from(marketMap.values()).sort(
      (left, right) => right.orders_count - left.orders_count,
    );

    return successRes(items, 200, 'Branch market analytics');
  }

  async getBranchesWithNewOrders(requester?: RequesterContext) {
    const scope = await this.resolveAccessScope(requester);

    const where: Record<string, unknown> = { isDeleted: false };
    if (!this.isSystemPrivileged(requester)) {
      const ids = Array.from(scope.readableBranchIds);
      if (!ids.length) {
        return successRes([], 200, 'Branches with NEW orders');
      }
      where.id = In(ids);
    }

    const branches = await this.branchRepo.find({
      where,
      order: { level: 'ASC', createdAt: 'ASC' },
      select: ['id', 'name', 'type', 'level', 'parent_id', 'code', 'status'],
    });

    const items = await Promise.all(
      branches.map(async (branch) => {
        try {
          const response = await lastValueFrom(
            this.orderClient
              .send(
                { cmd: 'order.find_all' },
                {
                  query: {
                    branch_id: String(branch.id),
                    status: Order_status.NEW,
                    fetch_all: true,
                    limit: 5000,
                  },
                },
              )
              .pipe(timeout(10000)),
          );

          const orders = this.extractOrderRows(response);
          return {
            id: branch.id,
            name: branch.name,
            type: branch.type,
            level: branch.level,
            parent_id: branch.parent_id,
            code: branch.code,
            status: branch.status,
            new_orders_count: orders.length,
          };
        } catch {
          return {
            id: branch.id,
            name: branch.name,
            type: branch.type,
            level: branch.level,
            parent_id: branch.parent_id,
            code: branch.code,
            status: branch.status,
            new_orders_count: 0,
          };
        }
      }),
    );

    return successRes(
      items.filter((item) => item.new_orders_count > 0),
      200,
      'Branches with NEW orders',
    );
  }

  private async resolveRequesterBranchRole(
    targetBranchIds: string[],
    requester?: RequesterContext,
  ): Promise<'SUPER' | BranchUserRole | null> {
    if (this.isSystemPrivileged(requester)) {
      return 'SUPER';
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      return null;
    }

    const assignments = await this.branchUserRepo.find({
      where: {
        user_id: requesterId,
        branch_id: In(targetBranchIds),
        isDeleted: false,
      },
      select: ['role'],
    });

    const roles = assignments.map((assignment) =>
      this.normalizeBranchUserRole(assignment.role),
    );

    if (roles.includes(BranchUserRole.MANAGER)) {
      return BranchUserRole.MANAGER;
    }
    if (roles.includes(BranchUserRole.REGISTRATOR)) {
      return BranchUserRole.REGISTRATOR;
    }
    if (roles.includes(BranchUserRole.COURIER)) {
      return BranchUserRole.COURIER;
    }

    return null;
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
      parent_id?: string | null;
      type?: BranchType | string;
      code?: string;
      status?: string;
      manager_id?: string | null;
    },
    requester?: RequesterContext,
  ) {
    await this.assertCanWriteBranch(id, requester);
    const branch = await this.getBranchOrThrow(id);

    const beforeSnapshot = {
      name: branch.name,
      parent_id: branch.parent_id,
      region_id: branch.region_id,
      district_id: branch.district_id,
      manager_id: branch.manager_id,
      status: branch.status,
      type: branch.type,
    };

    if (typeof dto?.name !== 'undefined') {
      const nextName = String(dto.name).trim();
      if (!nextName) {
        this.badRequest('name cannot be empty');
      }
      if (nextName.toLowerCase() !== (branch.name ?? '').toLowerCase()) {
        await this.ensureBranchNameUnique(nextName, branch.id);
      }
      branch.name = nextName;
    }

    if (
      typeof dto?.address !== 'undefined' ||
      typeof dto?.location !== 'undefined'
    ) {
      branch.address =
        String(dto?.address ?? dto?.location ?? '').trim() || null;
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

    const nextType =
      typeof dto?.type !== 'undefined'
        ? this.parseBranchType(dto.type)
        : branch.type;
    const nextParentId =
      typeof dto?.parent_id !== 'undefined'
        ? this.normalizeNullableBigint(dto.parent_id)
        : branch.parent_id;

    if (typeof dto?.code !== 'undefined') {
      const nextCode = this.normalizeBranchCode(dto.code);
      await this.ensureBranchCodeUnique(nextCode, branch.id);
      branch.code = nextCode;
    }

    if (nextType === BranchType.HQ) {
      if (nextParentId) {
        this.badRequest('HQ branch cannot have parent_id');
      }

      const existingHq = await this.branchRepo.findOne({
        where: { type: BranchType.HQ, isDeleted: false },
      });
      if (existingHq && existingHq.id !== branch.id) {
        this.conflict('Only one HQ branch is allowed');
      }

      branch.parent_id = null;
      branch.level = 0;
    } else {
      if (!nextParentId) {
        this.badRequest('parent_id is required for non-HQ branches');
      }

      await this.ensureNotCyclicParent(branch.id, nextParentId);
      const parent = await this.getParentBranchOrThrow(nextParentId);

      branch.parent_id = parent.id;
      branch.level = Number(parent.level) + 1;
    }

    branch.type = nextType;
    if (typeof dto?.manager_id !== 'undefined') {
      branch.manager_id = this.normalizeNullableBigint(dto.manager_id);
    }

    if (typeof dto?.status !== 'undefined') {
      branch.status = this.parseStatus(dto.status) ?? branch.status;
    }

    const saved = await this.branchRepo.save(branch);
    await this.rebalanceDescendantLevels(saved.id, saved.level);

    await this.activityLog.logChange({
      entity_type: 'Branch',
      entity_id: String(saved.id),
      action: ActivityAction.UPDATED,
      old_value: beforeSnapshot,
      new_value: {
        name: saved.name,
        parent_id: saved.parent_id,
        region_id: saved.region_id,
        district_id: saved.district_id,
        manager_id: saved.manager_id,
        status: saved.status,
        type: saved.type,
      },
      ...this.auditActor(requester),
    });

    return successRes(saved, 200, 'Branch updated');
  }

  async deleteBranch(id: string, requester?: RequesterContext) {
    await this.assertCanWriteBranch(id, requester);
    const branch = await this.getBranchOrThrow(id);

    if (await this.hasActiveChildren(branch.id)) {
      this.badRequest('Cannot delete branch with child branches');
    }

    const activeUsers = await this.branchUserRepo.count({
      where: { branch_id: branch.id, isDeleted: false },
    });
    if (activeUsers > 0) {
      this.badRequest(
        `Cannot delete branch — ${activeUsers} active user(s) assigned. Reassign or remove them first.`,
      );
    }

    type CanDeleteShape = {
      active_orders?: number;
      active_batches?: number;
    };
    let canDelete: CanDeleteShape | null = null;
    try {
      const response = await lastValueFrom(
        this.orderClient
          .send<{
            data?: CanDeleteShape;
          }>({ cmd: 'order.branch_can_delete' }, { branch_id: branch.id })
          .pipe(timeout(5000)),
      );
      canDelete = response?.data ?? null;
    } catch (error) {
      this.badRequest(
        `Cannot verify branch is safe to delete (order-service unreachable): ${(error as Error)?.message ?? 'unknown'}`,
      );
    }

    if (canDelete) {
      const orders = Number(canDelete.active_orders ?? 0);
      const batches = Number(canDelete.active_batches ?? 0);
      if (orders > 0 || batches > 0) {
        this.badRequest(
          `Cannot delete branch — ${orders} active order(s) and ${batches} active transfer batch(es) reference it.`,
        );
      }
    }

    const deletedName = branch.name;
    const deletedCode = branch.code;

    branch.isDeleted = true;
    branch.status = Status.INACTIVE;
    await this.branchRepo.save(branch);

    await this.activityLog.log({
      entity_type: 'Branch',
      entity_id: String(branch.id),
      action: ActivityAction.DELETED,
      old_value: { name: deletedName, code: deletedCode },
      ...this.auditActor(requester),
    });

    return successRes({ id }, 200, 'Branch deleted');
  }

  async assignUserToBranch(
    data: { branch_id?: string; user_id?: string; role?: string },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const userId = String(data?.user_id ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!userId) {
      this.badRequest('user_id is required');
    }

    await this.assertCanWriteBranch(branchId, requester);

    await this.getBranchOrThrow(branchId);
    const user = await this.ensureUserExists(userId);
    const derivedRole = this.resolveBranchRoleFromUserRole(user.role);
    const requestedRole = String(data?.role ?? '').trim()
      ? this.normalizeBranchUserRole(data?.role)
      : null;
    if (requestedRole && requestedRole !== derivedRole) {
      this.badRequest(
        `Berilgan role user roli bilan mos emas. User roli: ${derivedRole}`,
      );
    }
    const role = derivedRole;

    if (role === BranchUserRole.COURIER) {
      const requesterRoles = (requester?.roles ?? []).map((item) =>
        String(item ?? '')
          .trim()
          .toLowerCase(),
      );
      const isSystemPrivileged =
        requesterRoles.includes('superadmin') ||
        requesterRoles.includes('admin');

      const branch = await this.getBranchOrThrow(branchId);
      if (
        branch.type !== BranchType.HQ &&
        branch.type !== BranchType.REGIONAL &&
        branch.type !== BranchType.HYBRID
      ) {
        this.forbidden(
          'Courier faqat HQ, REGIONAL yoki HYBRID branchga biriktirilishi mumkin',
        );
      }

      if (!isSystemPrivileged) {
        const managerAssignment = await this.branchUserRepo.findOne({
          where: {
            user_id: String(requester?.id ?? '').trim(),
            branch_id: branchId,
            isDeleted: false,
          },
          select: ['id', 'role'],
        });

        if (
          !managerAssignment ||
          this.normalizeBranchUserRole(managerAssignment.role) !==
            BranchUserRole.MANAGER
        ) {
          this.forbidden(
            'Courier biriktirish uchun ushbu branchda MANAGER bo‘lish kerak',
          );
        }
      }
    }

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
      if (role === BranchUserRole.MANAGER) {
        await this.ensureBranchCashbox(branchId);
      }
      await this.activityLog.log({
        entity_type: 'BranchUser',
        entity_id: String(branchId),
        action: ActivityAction.ASSIGN,
        metadata: { user_id: userId, role },
        ...this.auditActor(requester),
      });
      return successRes(revived, 200, 'Branch user assigned');
    }

    const saved = await this.branchUserRepo.save(
      this.branchUserRepo.create({
        branch_id: branchId,
        user_id: userId,
        role,
      }),
    );

    if (role === BranchUserRole.MANAGER) {
      await this.ensureBranchCashbox(branchId);
    }
    await this.activityLog.log({
      entity_type: 'BranchUser',
      entity_id: String(branchId),
      action: ActivityAction.ASSIGN,
      metadata: { user_id: userId, role },
      ...this.auditActor(requester),
    });

    return successRes(saved, 201, 'Branch user assigned');
  }

  async removeUserFromBranch(
    data: { branch_id?: string; user_id?: string },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const userId = String(data?.user_id ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!userId) {
      this.badRequest('user_id is required');
    }

    await this.assertCanWriteBranch(branchId, requester);

    const row = await this.branchUserRepo.findOne({
      where: { branch_id: branchId, user_id: userId, isDeleted: false },
    });
    if (!row) {
      this.notFound('Branch user relation not found');
    }

    row.isDeleted = true;
    await this.branchUserRepo.save(row);

    await this.activityLog.log({
      entity_type: 'BranchUser',
      entity_id: String(branchId),
      action: ActivityAction.UNASSIGN,
      metadata: { user_id: userId },
      ...this.auditActor(requester),
    });

    return successRes(
      { branch_id: branchId, user_id: userId },
      200,
      'Branch user removed',
    );
  }

  async findUsersByBranch(branch_id: string, requester?: RequesterContext) {
    const branchId = String(branch_id ?? '').trim();
    if (!branchId) {
      this.badRequest('branch_id is required');
    }

    await this.assertCanReadBranch(branchId, requester);

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

  async findUserBranch(user_id: string, requester?: RequesterContext) {
    const userId = String(user_id ?? '').trim();
    if (!userId) {
      this.badRequest('user_id is required');
    }

    if (!this.isSystemPrivileged(requester)) {
      const requesterId = String(requester?.id ?? '').trim();
      if (!requesterId) {
        this.forbidden('Requester aniqlanmadi');
      }
      if (requesterId !== userId) {
        this.forbidden(
          'Boshqa foydalanuvchining filialini ko‘rishga ruxsat yo‘q',
        );
      }
    }

    const assignment = await this.branchUserRepo.findOne({
      where: { user_id: userId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });

    if (!assignment) {
      return successRes(null, 200, 'User branch assignment');
    }

    await this.assertCanReadBranch(String(assignment.branch_id), requester);

    const branch = await this.branchRepo.findOne({
      where: { id: String(assignment.branch_id), isDeleted: false },
    });

    return successRes(
      {
        ...assignment,
        branch: branch ?? null,
      },
      200,
      'User branch assignment',
    );
  }

  async resolveCashboxBranchForManager(
    requested_id: string,
    requester?: RequesterContext,
  ) {
    const requesterId = String(requester?.id ?? '').trim();
    const requestedId = String(requested_id ?? '').trim();
    if (!requesterId || !requestedId) {
      this.badRequest('requester_id and requested_id are required');
    }

    const requesterRoles = (requester?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    if (!requesterRoles.includes('manager')) {
      this.forbidden('Requester branch manager emas');
    }

    const managerAssignment = await this.branchUserRepo.findOne({
      where: {
        user_id: requesterId,
        isDeleted: false,
      },
      order: { createdAt: 'DESC' },
    });
    const managerBranchId = String(
      requester?.branch_id ?? managerAssignment?.branch_id ?? '',
    ).trim();
    if (!managerBranchId) {
      return successRes(null, 200, 'Manager branch assignment not found');
    }

    const managerBranch = await this.getBranchOrThrow(managerBranchId);
    if (
      requestedId === requesterId ||
      requestedId === String(managerBranch.id)
    ) {
      return successRes(
        { branch_id: String(managerBranch.id) },
        200,
        'Manager cashbox branch resolved',
      );
    }

    const accessibleBranches = new Map<string, Branch>([
      [String(managerBranch.id), managerBranch],
    ]);
    const visitedBranchIds = new Set<string>([String(managerBranch.id)]);
    let ancestorBranchId = String(managerBranch.parent_id ?? '').trim();

    while (ancestorBranchId && !visitedBranchIds.has(ancestorBranchId)) {
      visitedBranchIds.add(ancestorBranchId);
      const ancestorBranch = await this.branchRepo.findOne({
        where: { id: ancestorBranchId, isDeleted: false },
      });
      if (!ancestorBranch) {
        break;
      }

      accessibleBranches.set(String(ancestorBranch.id), ancestorBranch);
      ancestorBranchId = String(ancestorBranch.parent_id ?? '').trim();
    }

    if (accessibleBranches.has(requestedId)) {
      return successRes(
        { branch_id: requestedId },
        200,
        'Manager accessible cashbox branch resolved',
      );
    }

    const requestedUserAssignment = await this.branchUserRepo.findOne({
      where: {
        user_id: requestedId,
        isDeleted: false,
      },
      order: { createdAt: 'DESC' },
    });
    const requestedUserBranchId = String(
      requestedUserAssignment?.branch_id ?? '',
    );
    if (accessibleBranches.has(requestedUserBranchId)) {
      return successRes(
        { branch_id: requestedUserBranchId },
        200,
        'Manager accessible user cashbox branch resolved',
      );
    }

    return successRes(null, 200, 'Manager cashbox branch not resolved');
  }

  async setBranchConfig(
    data: {
      branch_id?: string;
      config_key?: string;
      config_value?: Record<string, unknown> | null;
    },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const configKey = String(data?.config_key ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!configKey) {
      this.badRequest('config_key is required');
    }

    await this.assertCanWriteBranch(branchId, requester);

    await this.getBranchOrThrow(branchId);

    const existing = await this.branchConfigRepo.findOne({
      where: { branch_id: branchId, config_key: configKey },
    });

    const configValue =
      typeof data?.config_value === 'undefined'
        ? null
        : (data.config_value ?? null);

    if (existing) {
      existing.isDeleted = false;
      existing.config_value = configValue;
      const saved = await this.branchConfigRepo.save(existing);
      await this.activityLog.log({
        entity_type: 'BranchConfig',
        entity_id: String(branchId),
        action: 'branch.config_set',
        new_value: saved,
        metadata: { config_key: configKey },
        ...this.auditActor(requester),
      });
      return successRes(saved, 200, 'Branch config saved');
    }

    const saved = await this.branchConfigRepo.save(
      this.branchConfigRepo.create({
        branch_id: branchId,
        config_key: configKey,
        config_value: configValue,
      }),
    );

    await this.activityLog.log({
      entity_type: 'BranchConfig',
      entity_id: String(branchId),
      action: 'branch.config_set',
      new_value: saved,
      metadata: { config_key: configKey },
      ...this.auditActor(requester),
    });

    return successRes(saved, 201, 'Branch config saved');
  }

  async getBranchConfig(branch_id: string, requester?: RequesterContext) {
    const branchId = String(branch_id ?? '').trim();
    if (!branchId) {
      this.badRequest('branch_id is required');
    }

    await this.assertCanReadBranch(branchId, requester);

    await this.getBranchOrThrow(branchId);

    const items = await this.branchConfigRepo.find({
      where: { branch_id: branchId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });

    return successRes(items, 200, 'Branch config list');
  }

  async getBranchConfigByKey(
    data: { branch_id?: string; config_key?: string },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const configKey = String(data?.config_key ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!configKey) {
      this.badRequest('config_key is required');
    }

    await this.assertCanReadBranch(branchId, requester);

    await this.getBranchOrThrow(branchId);

    const item = await this.branchConfigRepo.findOne({
      where: { branch_id: branchId, config_key: configKey, isDeleted: false },
    });

    if (!item) {
      this.notFound('Branch config not found');
    }

    return successRes(item, 200, 'Branch config found');
  }

  async updateBranchConfig(
    data: {
      branch_id?: string;
      config_key?: string;
      config_value?: Record<string, unknown> | null;
    },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const configKey = String(data?.config_key ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!configKey) {
      this.badRequest('config_key is required');
    }

    await this.assertCanWriteBranch(branchId, requester);

    await this.getBranchOrThrow(branchId);

    const item = await this.branchConfigRepo.findOne({
      where: { branch_id: branchId, config_key: configKey, isDeleted: false },
    });
    if (!item) {
      this.notFound('Branch config not found');
    }

    const beforeConfig = { config_value: item.config_value };

    item.config_value =
      typeof data?.config_value === 'undefined'
        ? null
        : (data.config_value ?? null);
    const saved = await this.branchConfigRepo.save(item);

    await this.activityLog.logChange({
      entity_type: 'BranchConfig',
      entity_id: String(branchId),
      action: ActivityAction.UPDATED,
      old_value: beforeConfig,
      new_value: { config_value: saved.config_value },
      metadata: { config_key: configKey },
      ...this.auditActor(requester),
    });

    return successRes(saved, 200, 'Branch config updated');
  }

  async deleteBranchConfig(
    data: { branch_id?: string; config_key?: string },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const configKey = String(data?.config_key ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!configKey) {
      this.badRequest('config_key is required');
    }

    await this.assertCanWriteBranch(branchId, requester);

    await this.getBranchOrThrow(branchId);

    const item = await this.branchConfigRepo.findOne({
      where: { branch_id: branchId, config_key: configKey, isDeleted: false },
    });
    if (!item) {
      this.notFound('Branch config not found');
    }

    item.isDeleted = true;
    await this.branchConfigRepo.save(item);

    await this.activityLog.log({
      entity_type: 'BranchConfig',
      entity_id: String(branchId),
      action: ActivityAction.DELETED,
      old_value: { config_key: configKey, config_value: item.config_value },
      metadata: { config_key: configKey },
      ...this.auditActor(requester),
    });

    return successRes(
      { branch_id: branchId, config_key: configKey },
      200,
      'Branch config deleted',
    );
  }
}
