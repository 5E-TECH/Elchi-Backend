import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BranchTransferDirection, BranchType, BranchUserRole, Order_status, Status } from '@app/common';
import { Branch } from './entities/branch.entity';
import { BranchUser } from './entities/branch-user.entity';
import { BranchConfig } from './entities/branch-config.entity';
import { errorRes, successRes } from '../../../libs/common/helpers/response';
import { lastValueFrom, timeout, TimeoutError } from 'rxjs';

type RequesterContext = {
  id?: string;
  roles?: string[];
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
  private static readonly HQ_CODE = 'HQ-TSHKNT';

  constructor(
    @InjectRepository(Branch) private readonly branchRepo: Repository<Branch>,
    @InjectRepository(BranchUser) private readonly branchUserRepo: Repository<BranchUser>,
    @InjectRepository(BranchConfig) private readonly branchConfigRepo: Repository<BranchConfig>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('FILE') private readonly fileClient: ClientProxy,
  ) {}

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

  private normalizeBranchUserRole(role?: string | null): BranchUserRole {
    const normalized = String(role ?? BranchUserRole.OPERATOR).trim().toUpperCase();
    if (normalized === BranchUserRole.MANAGER) {
      return BranchUserRole.MANAGER;
    }
    if (normalized === BranchUserRole.OPERATOR) {
      return BranchUserRole.OPERATOR;
    }
    if (normalized === BranchUserRole.COURIER) {
      return BranchUserRole.COURIER;
    }
    this.badRequest('role faqat MANAGER, OPERATOR, COURIER bo‘lishi mumkin');
  }

  private isSystemPrivileged(requester?: RequesterContext): boolean {
    const roles = (requester?.roles ?? []).map((role) => String(role).toLowerCase());
    return roles.includes('superadmin') || roles.includes('admin');
  }

  private async collectDescendantBranchIds(rootBranchIds: string[]): Promise<Set<string>> {
    const visited = new Set<string>(rootBranchIds.map((id) => String(id)));
    let frontier = Array.from(visited);

    while (frontier.length > 0) {
      const children = await this.branchRepo.find({
        where: {
          parent_id: In(frontier),
          isDeleted: false,
        },
        select: ['id'],
      });

      const next: string[] = [];
      for (const child of children) {
        const id = String(child.id);
        if (!visited.has(id)) {
          visited.add(id);
          next.push(id);
        }
      }
      frontier = next;
    }

    return visited;
  }

  private async resolveAccessScope(requester?: RequesterContext): Promise<BranchAccessScope> {
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
      .filter((item) => this.normalizeBranchUserRole(item.role) === BranchUserRole.MANAGER)
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

  private async assertCanReadBranch(branchId: string, requester?: RequesterContext): Promise<void> {
    if (this.isSystemPrivileged(requester)) {
      return;
    }
    const scope = await this.resolveAccessScope(requester);
    if (!scope.readableBranchIds.has(String(branchId))) {
      this.forbidden('Bu filial ma’lumotini ko‘rishga ruxsat yo‘q');
    }
  }

  private async assertCanWriteBranch(branchId: string, requester?: RequesterContext): Promise<void> {
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
    const normalized = String(type ?? '').trim().toUpperCase();
    if (!normalized || !Object.values(BranchType).includes(normalized as BranchType)) {
      this.badRequest(`type must be one of: ${Object.values(BranchType).join(', ')}`);
    }
    return normalized as BranchType;
  }

  private normalizeBranchCode(code?: string | null): string {
    const normalized = String(code ?? '').trim().toUpperCase();
    if (!normalized) {
      this.badRequest('code is required');
    }
    if (!/^[A-Z0-9-]{2,32}$/.test(normalized)) {
      this.badRequest('code must match /^[A-Z0-9-]{2,32}$/');
    }
    return normalized;
  }

  private async ensureBranchCodeUnique(code: string, exceptId?: string): Promise<void> {
    const exists = await this.branchRepo.findOne({
      where: { code, isDeleted: false },
    });
    if (exists && exists.id !== exceptId) {
      this.conflict('Branch with this code already exists');
    }
  }

  private async getParentBranchOrThrow(parentId: string): Promise<Branch> {
    const parent = await this.getBranchOrThrow(parentId);
    if (parent.type === BranchType.DISTRICT) {
      this.badRequest('DISTRICT branch cannot be a parent branch');
    }
    return parent;
  }

  private async ensureNotCyclicParent(branchId: string, parentId: string): Promise<void> {
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

  private async rebalanceDescendantLevels(rootBranchId: string, rootLevel: number): Promise<void> {
    const queue: Array<{ branchId: string; level: number }> = [{ branchId: rootBranchId, level: rootLevel }];
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
      where: { code: BranchServiceService.HQ_CODE, isDeleted: false },
    });
    if (hqByCode) {
      if (hqByCode.type !== BranchType.HQ || hqByCode.level !== 0 || hqByCode.parent_id !== null) {
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
        anyHq.code = BranchServiceService.HQ_CODE;
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
        name: 'HQ Toshkent',
        address: 'Toshkent',
        phone_number: null,
        region_id: null,
        district_id: null,
        parent_id: null,
        type: BranchType.HQ,
        level: 0,
        code: BranchServiceService.HQ_CODE,
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

  private async getDistrictsByIds(districtIds: string[]): Promise<Map<string, unknown>> {
    if (!districtIds.length) {
      return new Map();
    }

    try {
      const res = await lastValueFrom(
        this.logisticsClient
          .send<{ data?: Array<Record<string, unknown>> }>(
            { cmd: 'logistics.district.find_by_ids' },
            { ids: districtIds },
          )
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
    const candidates = [
      source?.data?.data,
      source?.data,
      source,
    ];

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
          current_batch_id: row?.current_batch_id ? String(row.current_batch_id) : null,
          courier_id: row?.courier_id ? String(row.courier_id) : null,
          createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
        };
      });
    }

    return [];
  }

  private async getOrdersByBranchIds(branchIds: string[]): Promise<OrderAnalyticsRow[]> {
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
    const normalized = String(value ?? '').trim().toUpperCase();
    if (normalized !== BranchTransferDirection.FORWARD && normalized !== BranchTransferDirection.RETURN) {
      this.badRequest(`direction must be one of: ${BranchTransferDirection.FORWARD}, ${BranchTransferDirection.RETURN}`);
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

  private async assertCanCreateTransferBatch(branchId: string, requester?: RequesterContext) {
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
        (this.normalizeBranchUserRole(item.role) === BranchUserRole.OPERATOR ||
          this.normalizeBranchUserRole(item.role) === BranchUserRole.MANAGER),
    );
    if (ownAssignment) {
      return;
    }

    const managerRoots = assignments
      .filter((item) => this.normalizeBranchUserRole(item.role) === BranchUserRole.MANAGER)
      .map((item) => String(item.branch_id));

    if (!managerRoots.length) {
      this.forbidden('Transfer batch yaratishga ruxsat yo‘q');
    }

    const managerTree = await this.collectDescendantBranchIds(managerRoots);
    if (!managerTree.has(String(branchId))) {
      this.forbidden('Transfer batch yaratishga ruxsat yo‘q');
    }
  }

  private async sendOrderCommand<T>(cmd: string, payload: Record<string, unknown>): Promise<T> {
    try {
      return await lastValueFrom(
        this.orderClient
          .send<T>({ cmd }, payload)
          .pipe(timeout(15000)),
      );
    } catch {
      throw new RpcException(errorRes('Order service unavailable', 502));
    }
  }

  private async sendFileCommand<T>(cmd: string, payload: Record<string, unknown>): Promise<T> {
    try {
      return await lastValueFrom(
        this.fileClient
          .send<T>({ cmd }, payload)
          .pipe(timeout(15000)),
      );
    } catch {
      throw new RpcException(errorRes('File service unavailable', 502));
    }
  }

  async createTransferBatches(
    branchId: string,
    dto: {
      destination_branch_id?: string;
      direction?: string;
      request_key?: string;
      vehicle_plate?: string | null;
      driver_name?: string | null;
      driver_phone?: string | null;
      notes?: string | null;
    },
    requester?: RequesterContext,
  ) {
    const sourceBranchId = String(branchId ?? '').trim();
    const destinationBranchId = String(dto?.destination_branch_id ?? '').trim();
    if (!sourceBranchId || !destinationBranchId) {
      this.badRequest('source branch and destination_branch_id are required');
    }

    await this.getBranchOrThrow(sourceBranchId);
    await this.getBranchOrThrow(destinationBranchId);
    await this.assertCanCreateTransferBatch(sourceBranchId, requester);

    const direction = this.normalizeTransferDirection(dto?.direction);
    const requestKey = this.normalizeTransferRequestKey(dto?.request_key);
    const requesterId = String(requester?.id ?? '').trim() || '0';

    const createRes = await this.sendOrderCommand<{
      statusCode?: number;
      data?: { idempotent?: boolean; batches?: Array<Record<string, any>> };
      message?: string;
    }>('order.transfer_batch.create', {
      source_branch_id: sourceBranchId,
      destination_branch_id: destinationBranchId,
      direction,
      request_key: requestKey,
      requester_id: requesterId,
      vehicle_plate: dto?.vehicle_plate ?? null,
      driver_name: dto?.driver_name ?? null,
      driver_phone: dto?.driver_phone ?? null,
      notes: dto?.notes ?? null,
    });

    const createdBatches = Array.isArray(createRes?.data?.batches) ? createRes.data.batches : [];
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
    try {
      for (const batch of createdBatches) {
        const token = String(batch?.qr_code_token ?? '').trim();
        if (!token) {
          throw new RpcException(errorRes('QR token missing for created batch', 500));
        }
        const qrResponse = await this.sendFileCommand<{
          data?: { key?: string; url?: string };
        }>('file.generate_qr', {
          text: token,
          file_name: `${token}.png`,
          folder: 'branch-transfer-batches',
        });

        await this.sendOrderCommand('order.transfer_batch.history.add', {
          batch_id: String(batch.id),
          user_id: requesterId,
          action: 'CREATED',
          notes: '[STEP] QR_GENERATED',
        });

        qrFiles.push({
          batch_id: String(batch.id),
          key: String(qrResponse?.data?.key ?? ''),
          url: String(qrResponse?.data?.url ?? ''),
        });
      }
    } catch (error) {
      await Promise.all(
        qrFiles
          .filter((file) => Boolean(file.key))
          .map(async (file) => {
            try {
              await this.sendFileCommand('file.delete', { key: file.key });
            } catch {
              return null;
            }
            return null;
          }),
      );

      if (batchIds.length) {
        await this.sendOrderCommand('order.transfer_batch.cancel_many', {
          batch_ids: batchIds,
          remove_order_bindings: true,
          requester_id: requesterId,
          notes: '[AUTO_ROLLBACK] QR generation failed',
        });
      }
      throw error;
    }

    const qrByBatchId = new Map(qrFiles.map((item) => [item.batch_id, item]));
    const enriched = createdBatches.map((batch) => ({
      ...batch,
      qr_file: qrByBatchId.get(String(batch.id)) ?? null,
    }));

    return successRes(
      {
        idempotent: false,
        batches: enriched,
      },
      201,
      'Transfer batches created',
    );
  }

  async sendTransferBatch(
    batchId: string,
    dto: {
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

    const vehiclePlate = String(dto?.vehicle_plate ?? '').trim();
    const driverName = String(dto?.driver_name ?? '').trim();
    const driverPhone = String(dto?.driver_phone ?? '').trim();

    if (!vehiclePlate || !driverName || !driverPhone) {
      this.badRequest("Avtomobil ma'lumotlari majburiy");
    }

    const batchRes = await this.sendOrderCommand<{
      data?: { source_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id });
    const sourceBranchId = String(batchRes?.data?.source_branch_id ?? '').trim();
    if (!sourceBranchId) {
      this.notFound('Transfer batch not found');
    }

    await this.assertCanCreateTransferBatch(sourceBranchId, requester);

    const requesterId = String(requester?.id ?? '').trim() || '0';
    return this.sendOrderCommand('order.transfer_batch.send', {
      batch_id: id,
      vehicle_plate: vehiclePlate,
      driver_name: driverName,
      driver_phone: driverPhone,
      requester_id: requesterId,
      requester_name: requesterId,
    });
  }

  private async assertRequesterWorksInBranch(branchId: string, requester?: RequesterContext) {
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
      this.forbidden("Qabul qiluvchi xodim manzil filialga biriktirilmagan");
    }
  }

  async receiveTransferBatch(
    batchId: string,
    requester?: RequesterContext,
  ) {
    const id = String(batchId ?? '').trim();
    if (!id) {
      this.badRequest('batch id is required');
    }

    const batchRes = await this.sendOrderCommand<{
      data?: { destination_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id });
    const destinationBranchId = String(batchRes?.data?.destination_branch_id ?? '').trim();
    if (!destinationBranchId) {
      this.notFound('Transfer batch not found');
    }

    await this.assertRequesterWorksInBranch(destinationBranchId, requester);

    const requesterId = String(requester?.id ?? '').trim() || '0';
    return this.sendOrderCommand('order.transfer_batch.receive', {
      batch_id: id,
      requester_id: requesterId,
      requester_name: requesterId,
    });
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
      this.badRequest("Bekor qilish sababi kamida 10 ta belgidan iborat bo'lishi kerak");
    }

    const batchRes = await this.sendOrderCommand<{
      data?: { source_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id });
    const sourceBranchId = String(batchRes?.data?.source_branch_id ?? '').trim();
    if (!sourceBranchId) {
      this.notFound('Transfer batch not found');
    }

    await this.assertCanCreateTransferBatch(sourceBranchId, requester);

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const requesterName = requesterId;

    const cancelResult = await this.sendOrderCommand('order.transfer_batch.cancel', {
      batch_id: id,
      reason,
      requester_id: requesterId,
      requester_name: requesterName,
    });

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

    return cancelResult;
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

    const payload = (response?.data ?? null) as
      | { source_branch_id?: string; destination_branch_id?: string }
      | null;

    const sourceBranchId = String(payload?.source_branch_id ?? '').trim();
    const destinationBranchId = String(payload?.destination_branch_id ?? '').trim();

    if (sourceBranchId) {
      await this.assertCanReadBranch(sourceBranchId, requester);
    } else if (destinationBranchId) {
      await this.assertCanReadBranch(destinationBranchId, requester);
    }

    return response;
  }

  async createBranch(dto: {
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
  }, requester?: RequesterContext) {
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

    const enrichedItems = items.map((item) => ({
      ...item,
      region: item.region_id ? (regionMap.get(item.region_id) ?? null) : null,
      district: item.district_id ? (districtMap.get(item.district_id) ?? null) : null,
      parent: item.parent_id ? (parentMap.get(item.parent_id) ?? null) : null,
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
        region: branch.region_id ? (regionMap.get(branch.region_id) ?? null) : null,
        district: branch.district_id ? (districtMap.get(branch.district_id) ?? null) : null,
        parent: branch.parent_id ? (parentMap.get(branch.parent_id) ?? null) : null,
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

    const now = new Date();
    const todayStart = this.toTashkentStartOfDay(now);
    const weekStart = this.toTashkentStartOfWeek(now);

    const todayOrdersCount = orders.filter(
      (order) => order.createdAt && order.createdAt >= todayStart,
    ).length;

    const weekOrdersCount = orders.filter(
      (order) => order.createdAt && order.createdAt >= weekStart,
    ).length;

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

    return successRes(
      {
        today_orders_count: todayOrdersCount,
        week_orders_count: weekOrdersCount,
        active_batches_count: activeBatchesCount,
        couriers_count: couriersCount,
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
      { market_id: string; orders_count: number; delivered_count: number; total_price: number }
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
    if (roles.includes(BranchUserRole.OPERATOR)) {
      return BranchUserRole.OPERATOR;
    }
    if (roles.includes(BranchUserRole.COURIER)) {
      return BranchUserRole.COURIER;
    }

    return null;
  }

  async getBranchDashboard(id: string, requester?: RequesterContext) {
    const targetBranchIds = await this.resolveAnalyticsBranchIds(id, requester);
    const orders = await this.getOrdersByBranchIds(targetBranchIds);

    const requesterBranchRole = await this.resolveRequesterBranchRole(
      targetBranchIds,
      requester,
    );

    const now = new Date();
    const todayStart = this.toTashkentStartOfDay(now);
    const todayOrders = orders.filter(
      (order) => order.createdAt && order.createdAt >= todayStart,
    );

    const deliveredStatuses = new Set<string>([
      Order_status.WAITING,
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
      Order_status.CLOSED,
    ]);

    const returnedStatuses = new Set<string>([
      Order_status.RETURNED_TO_MARKET,
    ]);

    const ordersCard = {
      total: todayOrders.length,
      new: todayOrders.filter((order) => order.status === Order_status.NEW).length,
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
            order.current_batch_id &&
            order.status === Order_status.ON_THE_ROAD,
        )
        .map((order) => String(order.current_batch_id)),
    ).size;

    const waitingForAcceptance = new Set(
      orders
        .filter(
          (order) =>
            order.current_batch_id &&
            order.status === Order_status.RECEIVED,
        )
        .map((order) => String(order.current_batch_id)),
    ).size;

    const packagesCard = {
      on_the_way: packagesOnTheWay,
      waiting_for_acceptance: waitingForAcceptance,
    };

    const branchCouriersCount = await this.branchUserRepo.count({
      where: {
        branch_id: In(targetBranchIds),
        role: BranchUserRole.COURIER,
        isDeleted: false,
      },
    });

    const activeTodayCouriersCount = new Set(
      todayOrders
        .map((order) => String(order.courier_id ?? '').trim())
        .filter((courierId) => Boolean(courierId)),
    ).size;

    const couriersCard = {
      branch_couriers: branchCouriersCount,
      active_today: activeTodayCouriersCount,
    };

    const canSeeAll =
      requesterBranchRole === 'SUPER' || requesterBranchRole === BranchUserRole.MANAGER;
    const canSeeMarkets = canSeeAll;

    return successRes(
      {
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
      'Branch dashboard',
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

    const nextType = typeof dto?.type !== 'undefined' ? this.parseBranchType(dto.type) : branch.type;
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

    if (nextType === BranchType.DISTRICT && (await this.hasActiveChildren(branch.id))) {
      this.badRequest('DISTRICT branch cannot have child branches');
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
    return successRes(saved, 200, 'Branch updated');
  }

  async deleteBranch(id: string, requester?: RequesterContext) {
    await this.assertCanWriteBranch(id, requester);
    const branch = await this.getBranchOrThrow(id);
    if (await this.hasActiveChildren(branch.id)) {
      this.badRequest('Cannot delete branch with child branches');
    }
    branch.isDeleted = true;
    branch.status = Status.INACTIVE;
    await this.branchRepo.save(branch);
    return successRes({ id }, 200, 'Branch deleted');
  }

  async assignUserToBranch(
    data: { branch_id?: string; user_id?: string; role?: string },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const userId = String(data?.user_id ?? '').trim();
    const role = this.normalizeBranchUserRole(data?.role);

    if (!branchId) {
      this.badRequest('branch_id is required');
    }
    if (!userId) {
      this.badRequest('user_id is required');
    }

    await this.assertCanWriteBranch(branchId, requester);

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

    return successRes({ branch_id: branchId, user_id: userId }, 200, 'Branch user removed');
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
        this.forbidden('Boshqa foydalanuvchining filialini ko‘rishga ruxsat yo‘q');
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

  async setBranchConfig(data: {
    branch_id?: string;
    config_key?: string;
    config_value?: Record<string, unknown> | null;
  }, requester?: RequesterContext) {
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

  async updateBranchConfig(data: {
    branch_id?: string;
    config_key?: string;
    config_value?: Record<string, unknown> | null;
  }, requester?: RequesterContext) {
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

    item.config_value = typeof data?.config_value === 'undefined' ? null : (data.config_value ?? null);
    const saved = await this.branchConfigRepo.save(item);

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

    return successRes({ branch_id: branchId, config_key: configKey }, 200, 'Branch config deleted');
  }
}
