import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import {
  Brackets,
  DataSource,
  In,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { lastValueFrom, timeout } from 'rxjs';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderHolderType, Order_source } from './entities/order.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { OrderSettlement } from './entities/order-settlement.entity';
import { BranchTransferBatch } from './entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from './entities/branch-transfer-batch-item.entity';
import { BranchTransferBatchHistory } from './entities/branch-transfer-batch-history.entity';
import {
  ActivityLogService,
  ActivityLogQuery,
  BranchTransferBatchStatus,
  Order_status,
  OutboxService,
  Roles,
  Where_deliver,
  rmqSend,
  RMQ_SERVICE_TIMEOUT,
} from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';
import { resolveCourierShare as resolveCourierShareShare } from './domain/order-money';
import { OrderLookupService } from './lookup/order-lookup.service';
import { OrderCustodyService } from './custody/order-custody.service';

@Injectable()
export class OrderServiceService {
  private readonly logger = new Logger(OrderServiceService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepo: Repository<OrderItem>,
    @InjectRepository(OrderTracking)
    private readonly orderTrackingRepo: Repository<OrderTracking>,
    @InjectRepository(OrderCustodyEvent)
    private readonly orderCustodyEventRepo: Repository<OrderCustodyEvent>,
    @InjectRepository(OrderSettlement)
    private readonly orderSettlementRepo: Repository<OrderSettlement>,
    @InjectRepository(BranchTransferBatch)
    private readonly transferBatchRepo: Repository<BranchTransferBatch>,
    @InjectRepository(BranchTransferBatchItem)
    private readonly transferBatchItemRepo: Repository<BranchTransferBatchItem>,
    @InjectRepository(BranchTransferBatchHistory)
    private readonly transferBatchHistoryRepo: Repository<BranchTransferBatchHistory>,
    @Inject('SEARCH') private readonly searchClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('FILE') private readonly fileClient: ClientProxy,
    private readonly outbox: OutboxService,
    private readonly activityLog: ActivityLogService,
    private readonly lookup: OrderLookupService,
    private readonly custody: OrderCustodyService,
  ) {}

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

  private notFound(message: string): never {
    throw new RpcException({ statusCode: 404, message });
  }

  private badRequest(message: string): never {
    throw new RpcException({ statusCode: 400, message });
  }

  private handleDbError(error: unknown): never {
    if (error instanceof QueryFailedError) {
      const pgError = error.driverError as {
        code?: string;
        message?: string;
        column?: string;
        table?: string;
      };
      const rawMessage = pgError?.message ?? '';

      if (rawMessage.includes('orders_status_enum')) {
        throw new RpcException({
          statusCode: 400,
          message: "status noto'g'ri qiymat",
        });
      }
      if (rawMessage.includes('orders_where_deliver_enum')) {
        throw new RpcException({
          statusCode: 400,
          message: "where_deliver noto'g'ri qiymat",
        });
      }
      if (pgError?.code === '22P02') {
        if (rawMessage.includes('bigint')) {
          throw new RpcException({
            statusCode: 400,
            message: "ID qiymatlari raqam ko'rinishida bo'lishi kerak",
          });
        }
        throw new RpcException({
          statusCode: 400,
          message: "Noto'g'ri formatdagi qiymat yuborildi",
        });
      }
      if (pgError?.code === '23502') {
        const column = pgError?.column ?? 'unknown';
        const table = pgError?.table ?? 'unknown';
        throw new RpcException({
          statusCode: 400,
          message: `Majburiy maydon bo'sh yuborildi: ${table}.${column}`,
        });
      }
      if (pgError?.code === '23503') {
        throw new RpcException({
          statusCode: 400,
          message: "Bog'langan ma'lumot topilmadi",
        });
      }
    }
    throw error;
  }

  private extractUserPayload(
    response: unknown,
  ): Record<string, unknown> | null {
    if (!response || typeof response !== 'object') {
      return null;
    }

    const payload = response as Record<string, unknown>;
    const data = payload.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }

    return payload;
  }

  private normalizeTrackingActor(user: Record<string, unknown> | null) {
    if (!user) {
      return null;
    }

    return {
      id: user.id != null ? String(user.id) : null,
      name:
        typeof user.name === 'string'
          ? user.name
          : typeof user.full_name === 'string'
            ? user.full_name
            : null,
      username: typeof user.username === 'string' ? user.username : null,
      phone_number:
        typeof user.phone_number === 'string' ? user.phone_number : null,
      role: typeof user.role === 'string' ? user.role : null,
      status: typeof user.status === 'string' ? user.status : null,
    };
  }

  private async resolveBranchTrackingLabel(
    branchId?: string | null,
    requester?: { id?: string; roles?: string[] } | null,
  ): Promise<string | null> {
    const id = String(branchId ?? '').trim();
    if (!id) {
      return null;
    }

    try {
      const response = await rmqSend<{
        data?: {
          id?: string;
          name?: string | null;
          code?: string | null;
          type?: string | null;
        };
      }>(
        this.branchClient,
        { cmd: 'branch.find_by_id' },
        {
          id,
          requester: requester?.id
            ? { id: String(requester.id), roles: requester.roles ?? [] }
            : { id: 'system', roles: [Roles.SUPERADMIN] },
        },
        { attachRequestId: false, retries: 1 },
      );

      const branch = response?.data;
      if (branch?.name) {
        return branch.code
          ? `${branch.name} (${branch.code}, ID: ${id})`
          : `${branch.name} (ID: ${id})`;
      }
    } catch {
      // Tracking should still be written even if branch-service is unavailable
      // or the requester cannot read the branch.
    }

    return `branch ID: ${id}`;
  }

  private async resolveTrackingActors(actorIds: string[]) {
    const uniqueIds = Array.from(
      new Set(actorIds.filter((id) => id && id !== 'system')),
    );
    const actors = new Map<
      string,
      ReturnType<OrderServiceService['normalizeTrackingActor']>
    >();

    await Promise.all(
      uniqueIds.map(async (id) => {
        try {
          const response = await lastValueFrom(
            this.identityClient
              .send({ cmd: 'identity.user.find_by_id' }, { id })
              .pipe(timeout(RMQ_SERVICE_TIMEOUT)),
          );
          actors.set(
            id,
            this.normalizeTrackingActor(this.extractUserPayload(response)),
          );
        } catch {
          actors.set(id, null);
        }
      }),
    );

    return actors;
  }

  private trackingActorLabel(
    actor: ReturnType<OrderServiceService['normalizeTrackingActor']>,
    fallbackId?: string | null,
  ): string {
    if (!actor) {
      return fallbackId ? `user ID: ${fallbackId}` : 'Nomaʼlum foydalanuvchi';
    }

    const name = actor.name ?? actor.username ?? actor.phone_number;
    const role = actor.role ? `, role: ${actor.role}` : '';
    return name
      ? `${name}${role}, ID: ${actor.id ?? fallbackId ?? '-'}`
      : `user ID: ${actor.id ?? fallbackId ?? '-'}`;
  }

  private custodyHolderLabel(
    holderType: OrderHolderType | null,
    branchId: string | null,
    courierId: string | null,
    branchLabels: Map<string, string>,
    actorMap: Map<
      string,
      ReturnType<OrderServiceService['normalizeTrackingActor']>
    >,
  ): string {
    if (!holderType) {
      return 'tizimdan';
    }

    if (holderType === OrderHolderType.HQ) {
      return 'HQ';
    }

    if (holderType === OrderHolderType.BRANCH) {
      return branchId
        ? (branchLabels.get(String(branchId)) ?? `branch ID: ${branchId}`)
        : 'branch';
    }

    if (holderType === OrderHolderType.COURIER) {
      const courierLabel = courierId
        ? this.trackingActorLabel(
            actorMap.get(String(courierId)) ?? null,
            courierId,
          )
        : 'courier';
      const branchLabel = branchId
        ? (branchLabels.get(String(branchId)) ?? `branch ID: ${branchId}`)
        : null;
      return branchLabel ? `${courierLabel} (${branchLabel})` : courierLabel;
    }

    if (holderType === OrderHolderType.MARKET) {
      return 'market';
    }

    return String(holderType);
  }

  private toUzIsoString(date: Date): string {
    const uzOffsetMs = 5 * 60 * 60 * 1000;
    return new Date(date.getTime() + uzOffsetMs)
      .toISOString()
      .replace('Z', '+05:00');
  }

  private normalizePagination(
    page?: number,
    limit?: number,
    fetchAll?: boolean,
  ) {
    const DEFAULT_LIMIT = 10;
    const MAX_LIMIT = 100;
    const MAX_FETCH_ALL = 5000;
    const parsedPage = Number(page ?? 1);
    const parsedLimit = Number(limit ?? DEFAULT_LIMIT);

    const normalizedLimit =
      fetchAll || parsedLimit === 0
        ? MAX_FETCH_ALL
        : !Number.isFinite(parsedLimit) || parsedLimit < 0
          ? DEFAULT_LIMIT
          : Math.min(parsedLimit, MAX_LIMIT);

    const normalizedPage =
      Number.isFinite(parsedPage) && parsedPage >= 1
        ? Math.floor(parsedPage)
        : 1;

    return {
      page: normalizedPage,
      limit: normalizedLimit,
      total_pages(total: number) {
        return normalizedLimit > 0 ? Math.ceil(total / normalizedLimit) : 0;
      },
    };
  }

  private normalizeStatusFilter(
    status?: Order_status | Order_status[] | string | string[],
  ): Order_status[] | undefined {
    if (status == null) {
      return undefined;
    }

    const rawValues = Array.isArray(status) ? status : [status];
    const flattened = rawValues
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    if (!flattened.length) {
      return undefined;
    }

    const allowedStatuses = new Set(Object.values(Order_status));
    const invalidValues = flattened.filter(
      (value) => !allowedStatuses.has(value as Order_status),
    );
    if (invalidValues.length) {
      this.badRequest(`Invalid status value(s): ${invalidValues.join(', ')}`);
    }

    return Array.from(new Set(flattened)) as Order_status[];
  }

  private normalizeSourceFilter(
    source?: Order_source | 'internal' | 'external' | 'branch' | string,
  ): Order_source | undefined {
    if (source == null) {
      return undefined;
    }

    const normalized = String(source).trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    if (!Object.values(Order_source).includes(normalized as Order_source)) {
      this.badRequest(`Invalid source value: ${source}`);
    }

    return normalized as Order_source;
  }

  // COD share/profit math lives in ./domain/order-money (pure & unit-tested).
  // These thin wrappers keep the existing call sites unchanged.
  private resolveCourierShare(
    courier: { compensation_mode?: string | null } | null | undefined,
    courierTariff: number,
  ): number {
    return resolveCourierShareShare(courier, courierTariff);
  }

  async findAll(query: {
    market_id?: string;
    customer_id?: string;
    customer_ids?: string[];
    post_id?: string;
    post_ids?: string[];
    exclude_statuses?: Order_status[];
    canceled_post_id?: string;
    canceled_post_unassigned?: boolean;
    holder_type?: OrderHolderType;
    qr_code_token?: string;
    status?: Order_status | Order_status[] | string | string[];
    where_deliver?: Where_deliver;
    return_requested?: boolean;
    start_day?: string;
    end_day?: string;
    courier?: string;
    courier_ids?: string[];
    holder_courier_ids?: string[];
    include_courier_history?: boolean | string;
    region_id?: string;
    district_id?: string;
    branch_id?: string;
    source?: Order_source | 'internal' | 'external' | 'branch';
    exclude_sources?: Array<Order_source | 'internal' | 'external' | 'branch'>;
    unbatched_only?: boolean;
    fetch_all?: boolean | string;
    fetchAll?: boolean | string;
    disable_pagination?: boolean;
    page?: number;
    limit?: number;
  }) {
    const {
      market_id,
      customer_id,
      customer_ids,
      post_id,
      post_ids,
      exclude_statuses,
      canceled_post_id,
      canceled_post_unassigned,
      holder_type,
      qr_code_token,
      status,
      where_deliver,
      return_requested,
      start_day,
      end_day,
      courier,
      courier_ids,
      holder_courier_ids,
      include_courier_history,
      region_id,
      district_id,
      branch_id,
      source,
      exclude_sources,
      unbatched_only,
      fetch_all,
      fetchAll,
      disable_pagination,
      page,
      limit,
    } = query;

    const useFetchAll =
      fetch_all === true ||
      fetchAll === true ||
      String(fetch_all).toLowerCase() === 'true' ||
      String(fetchAll).toLowerCase() === 'true';
    const useCourierHistory =
      include_courier_history === true ||
      String(include_courier_history).toLowerCase() === 'true';

    const pagination = this.normalizePagination(page, limit, useFetchAll);
    const statusFilter = this.normalizeStatusFilter(status);
    const sourceFilter = this.normalizeSourceFilter(source);
    const excludeSourceFilters = (exclude_sources ?? [])
      .map((value) => this.normalizeSourceFilter(value))
      .filter((value): value is Order_source => Boolean(value));

    const qb = this.orderRepo
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('order.branch', 'branch')
      .where('order.isDeleted = :isDeleted', { isDeleted: false });

    if (market_id) {
      qb.andWhere('order.market_id = :market_id', { market_id });
    }
    if (customer_ids?.length) {
      qb.andWhere('order.customer_id IN (:...customer_ids)', { customer_ids });
    } else if (customer_id) {
      qb.andWhere('order.customer_id = :customer_id', { customer_id });
    }
    if (post_id) {
      qb.andWhere('order.post_id = :post_id', { post_id });
    }
    if (post_ids?.length) {
      qb.andWhere('order.post_id IN (:...post_ids)', { post_ids });
    }
    if (canceled_post_id) {
      qb.andWhere('order.canceled_post_id = :canceled_post_id', {
        canceled_post_id,
      });
    } else if (canceled_post_unassigned) {
      qb.andWhere('order.canceled_post_id IS NULL');
    }
    if (holder_type) {
      qb.andWhere('order.holder_type = :holder_type', { holder_type });
    }
    if (qr_code_token) {
      qb.andWhere('order.qr_code_token = :qr_code_token', { qr_code_token });
    }
    if (statusFilter?.length) {
      qb.andWhere('order.status IN (:...statuses)', { statuses: statusFilter });
    } else if (exclude_statuses?.length) {
      qb.andWhere('order.status NOT IN (:...exclude_statuses)', {
        exclude_statuses,
      });
    }
    if (where_deliver) {
      qb.andWhere('order.where_deliver = :where_deliver', { where_deliver });
    }
    if (typeof return_requested === 'boolean') {
      qb.andWhere('order.return_requested = :return_requested', {
        return_requested,
      });
    }
    if (region_id) {
      qb.andWhere('order.region_id = :region_id', { region_id });
    }
    if (district_id) {
      qb.andWhere('order.district_id = :district_id', { district_id });
    }
    if (branch_id) {
      qb.andWhere(
        new Brackets((nested) => {
          nested
            .where('order.branch_id = :branch_id', { branch_id })
            .orWhere('order.holder_branch_id = :branch_id', { branch_id })
            .orWhere('order.home_branch_id = :branch_id', { branch_id });
        }),
      );
    }
    if (unbatched_only) {
      qb.andWhere('order.current_batch_id IS NULL');
    }
    if (sourceFilter === Order_source.EXTERNAL) {
      qb.andWhere('(order.source = :source OR order.external_id IS NOT NULL)', {
        source: Order_source.EXTERNAL,
      });
    } else if (sourceFilter === Order_source.INTERNAL) {
      qb.andWhere('(order.source = :source OR order.external_id IS NULL)', {
        source: Order_source.INTERNAL,
      });
    } else if (sourceFilter === Order_source.BRANCH) {
      qb.andWhere('order.source = :source', {
        source: Order_source.BRANCH,
      });
    }
    if (excludeSourceFilters.length) {
      qb.andWhere('order.source NOT IN (:...excludeSourceFilters)', {
        excludeSourceFilters,
      });
    }
    if (courier) {
      qb.andWhere(
        new Brackets((nested) => {
          nested
            .where('order.operator ILIKE :courierLike', {
              courierLike: `%${courier}%`,
            })
            .orWhere('order.post_id = :courierId', { courierId: courier });
        }),
      );
    }
    if (courier_ids?.length) {
      const normalizedCourierIds = courier_ids
        .map((id) => String(id))
        .filter(Boolean);
      if (normalizedCourierIds.length) {
        qb.andWhere(
          new Brackets((nested) => {
            nested
              .where('order.courier_id IN (:...courier_ids)', {
                courier_ids: normalizedCourierIds,
              })
              .orWhere('order.holder_courier_id IN (:...courier_ids)', {
                courier_ids: normalizedCourierIds,
              });
            if (useCourierHistory) {
              nested.orWhere(
                `EXISTS (
                  SELECT 1
                  FROM "order_schema"."order_custody_events" courier_history
                  WHERE courier_history.order_id = "order"."id"
                    AND (
                      courier_history.from_courier_id IN (:...courier_ids)
                      OR courier_history.to_courier_id IN (:...courier_ids)
                    )
                )`,
                { courier_ids: normalizedCourierIds },
              );
            }
          }),
        );
      }
    }
    if (holder_courier_ids?.length) {
      const normalizedHolderCourierIds = holder_courier_ids
        .map((id) => String(id))
        .filter(Boolean);
      if (normalizedHolderCourierIds.length) {
        qb.andWhere('order.holder_courier_id IN (:...holder_courier_ids)', {
          holder_courier_ids: normalizedHolderCourierIds,
        });
      }
    }
    if (start_day) {
      const startDate = new Date(start_day);
      if (Number.isNaN(startDate.getTime())) {
        throw new RpcException({
          statusCode: 400,
          message: "start_day noto'g'ri sana formatida",
        });
      }
      qb.andWhere('order.createdAt >= :startDate', { startDate });
    }
    if (end_day) {
      const endDate = new Date(end_day);
      if (Number.isNaN(endDate.getTime())) {
        throw new RpcException({
          statusCode: 400,
          message: "end_day noto'g'ri sana formatida",
        });
      }
      if (!end_day.includes('T')) {
        endDate.setHours(23, 59, 59, 999);
      }
      qb.andWhere('order.createdAt <= :endDate', { endDate });
    }

    qb.orderBy('order.createdAt', 'DESC');
    if (!disable_pagination) {
      qb.skip((pagination.page - 1) * pagination.limit).take(pagination.limit);
    }

    let data: Order[];
    let total: number;
    try {
      [data, total] = await qb.getManyAndCount();
    } catch (error) {
      this.handleDbError(error);
    }

    if (disable_pagination) {
      return { data, total };
    }

    return {
      data,
      total,
      page: pagination.page,
      limit: pagination.limit,
      total_pages: pagination.total_pages(total),
      totalPages: pagination.total_pages(total),
    };
  }

  async findNewMarkets(branch_id?: string, exclude_branch_source = false) {
    const qb = this.orderRepo
      .createQueryBuilder('order')
      .select('order.market_id', 'market_id')
      .addSelect('COUNT(order.id)', 'orders_count')
      .addSelect('COALESCE(SUM(order.total_price), 0)', 'total_price_sum')
      .where('order.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('order.status = :status', { status: Order_status.NEW })
      .andWhere('order.current_batch_id IS NULL')
      .groupBy('order.market_id')
      .orderBy('orders_count', 'DESC');

    if (branch_id) {
      qb.andWhere('order.branch_id = :branch_id', { branch_id });
    }
    if (exclude_branch_source) {
      qb.andWhere('order.source != :branch_source', {
        branch_source: Order_source.BRANCH,
      });
    }

    let rows: Array<{
      market_id: string;
      orders_count: string;
      total_price_sum: string;
    }>;
    try {
      rows = await qb.getRawMany();
    } catch (error) {
      this.handleDbError(error);
    }

    return rows.map((row) => ({
      market_id: row.market_id,
      orders_count: Number(row.orders_count),
      total_price_sum: Number(row.total_price_sum),
    }));
  }

  async findNewOrdersByMarket(
    market_id: string,
    branch_id?: string,
    exclude_branch_source = false,
  ) {
    return this.findAll({
      market_id,
      branch_id,
      status: Order_status.NEW,
      unbatched_only: true,
      ...(exclude_branch_source
        ? { exclude_sources: [Order_source.BRANCH] }
        : {}),
      disable_pagination: true,
    });
  }

  async findCancelledMarkets(options: {
    market_id?: string;
    branch_id?: string;
    holder_type?: OrderHolderType;
    exclude_branch_source?: boolean;
  }) {
    const qb = this.orderRepo
      .createQueryBuilder('order')
      .select('order.market_id', 'market_id')
      .addSelect('COUNT(order.id)', 'orders_count')
      .addSelect('COALESCE(SUM(order.total_price), 0)', 'total_price_sum')
      .where('order.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('order.status IN (:...statuses)', {
        statuses: [Order_status.CANCELLED],
      })
      .andWhere('order.canceled_post_id IS NULL')
      .groupBy('order.market_id')
      .orderBy('orders_count', 'DESC');

    if (options.market_id) {
      qb.andWhere('order.market_id = :market_id', {
        market_id: options.market_id,
      });
    }
    if (options.holder_type) {
      qb.andWhere('order.holder_type = :holder_type', {
        holder_type: options.holder_type,
      });
    }
    if (options.branch_id) {
      qb.andWhere('order.holder_branch_id = :branch_id', {
        branch_id: options.branch_id,
      });
    }
    if (options.exclude_branch_source) {
      qb.andWhere('order.source != :branch_source', {
        branch_source: Order_source.BRANCH,
      });
    }

    let rows: Array<{
      market_id: string;
      orders_count: string;
      total_price_sum: string;
    }>;
    try {
      rows = await qb.getRawMany();
    } catch (error) {
      this.handleDbError(error);
    }

    return rows.map((row) => ({
      market_id: row.market_id,
      orders_count: Number(row.orders_count),
      total_price_sum: Number(row.total_price_sum),
    }));
  }

  async findCancelledOrdersByMarket(
    market_id: string,
    options: {
      branch_id?: string;
      holder_type?: OrderHolderType;
      exclude_branch_source?: boolean;
    },
  ) {
    return this.findAll({
      market_id,
      branch_id: options.branch_id,
      status: Order_status.CANCELLED,
      holder_type: options.holder_type,
      canceled_post_unassigned: true,
      ...(options.exclude_branch_source
        ? { exclude_sources: [Order_source.BRANCH] }
        : {}),
      disable_pagination: true,
    });
  }

  async findAllExternal(query: {
    market_id?: string;
    status?: Order_status | Order_status[] | string | string[];
    start_day?: string;
    end_day?: string;
    page?: number;
    limit?: number;
  }) {
    return this.findAll({
      ...query,
      source: Order_source.EXTERNAL,
    });
  }

  async findById(id: string) {
    let order: Order | null;
    try {
      order = await this.orderRepo.findOne({
        where: { id, isDeleted: false },
        relations: { items: true, branch: true },
      });
    } catch (error) {
      this.handleDbError(error);
    }
    if (!order) {
      this.notFound(`Order #${id} topilmadi`);
    }
    return order;
  }

  /**
   * Check whether a branch is safe to soft-delete from order-service's perspective:
   * counts active (non-closed) orders and active transfer batches that reference it.
   * branch-service consults this before allowing deleteBranch to proceed.
   */
  async branchCanDelete(branchId: string) {
    const id = String(branchId ?? '').trim();
    if (!id) {
      this.badRequest('branch_id is required');
    }

    const closedOrderStatuses = [
      Order_status.SOLD,
      Order_status.CANCELLED,
      Order_status.RETURNED_TO_MARKET,
      Order_status.PAID,
      Order_status.CLOSED,
    ];

    const activeOrders = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.branch_id = :id', { id })
      .andWhere('o.is_deleted = false')
      .andWhere('o.status NOT IN (:...closed)', { closed: closedOrderStatuses })
      .getCount();

    const activeBatchStatuses = [
      BranchTransferBatchStatus.PENDING,
      BranchTransferBatchStatus.SENT,
    ];

    const activeBatches = await this.transferBatchRepo
      .createQueryBuilder('b')
      .where('b.is_deleted = false')
      .andWhere('b.status IN (:...active)', { active: activeBatchStatuses })
      .andWhere('(b.source_branch_id = :id OR b.destination_branch_id = :id)', {
        id,
      })
      .getCount();

    return successRes(
      {
        branch_id: id,
        active_orders: activeOrders,
        active_batches: activeBatches,
        can_delete: activeOrders === 0 && activeBatches === 0,
      },
      200,
      'Branch delete check',
    );
  }

  async findByQrCode(token: string) {
    let order: Order | null;
    try {
      order = await this.orderRepo.findOne({
        where: { qr_code_token: token, isDeleted: false },
        relations: { items: true, branch: true },
      });
    } catch (error) {
      this.handleDbError(error);
    }
    if (!order) {
      this.notFound('Order not found');
    }
    return successRes(order, 200, 'Order by QR code');
  }

  async findByQrCodeEnriched(token: string) {
    const result = await this.findByQrCode(token);
    const order = (result as { data?: Order })?.data;

    if (!order) {
      return result;
    }

    const enriched = await this.enrichOrders([order]);
    return successRes(enriched[0] ?? order, 200, 'Order by QR code');
  }

  async getTrackingByOrderId(id: string, pageRaw = 1, limitRaw = 20) {
    const orderResult = await this.findById(id);
    const order = (orderResult as { data?: Order })?.data;
    const trackingOrderIds = Array.from(
      new Set(
        [order?.parent_order_id, id]
          .filter((orderId): orderId is string => Boolean(orderId))
          .map((orderId) => String(orderId)),
      ),
    );

    const page = Math.max(1, Number(pageRaw) || 1);
    const limit = Math.min(100, Math.max(1, Number(limitRaw) || 20));

    let rows: OrderTracking[] = [];
    let custodyRows: OrderCustodyEvent[] = [];
    try {
      rows = await this.orderTrackingRepo.find({
        where: { order_id: In(trackingOrderIds) },
        order: { created_at: 'DESC' },
      });
      custodyRows = await this.orderCustodyEventRepo.find({
        where: { order_id: In(trackingOrderIds) },
        order: { created_at: 'DESC' },
      });
    } catch (error) {
      this.handleDbError(error);
    }

    const actorMap = await this.resolveTrackingActors(
      [
        ...rows.map((row) => row.changed_by),
        ...custodyRows.flatMap((row) => [
          row.changed_by,
          row.from_courier_id,
          row.to_courier_id,
        ]),
      ].filter((id): id is string => Boolean(id)),
    );
    const branchIds = Array.from(
      new Set(
        custodyRows
          .flatMap((row) => [row.from_branch_id, row.to_branch_id])
          .filter((branchId): branchId is string => Boolean(branchId)),
      ),
    );
    const branchLabels = new Map<string, string>();
    await Promise.all(
      branchIds.map(async (branchId) => {
        const label = await this.resolveBranchTrackingLabel(branchId);
        branchLabels.set(branchId, label ?? `branch ID: ${branchId}`);
      }),
    );

    const trackingEvents = rows.map((row) => {
      const inferredAction = this.custody.inferTrackingAction(
        row.from_status,
        row.to_status,
        row.note,
      );
      const action =
        ['partly_sold', 'rollback'].includes(inferredAction) || !row.action
          ? inferredAction
          : row.action;
      const actor =
        row.changed_by === 'system'
          ? {
              id: 'system',
              name: 'System',
              username: null,
              phone_number: null,
              role: 'system',
              status: null,
            }
          : (actorMap.get(row.changed_by) ?? null);
      const changedByRole =
        actor?.role && row.changed_by !== 'system'
          ? String(actor.role)
          : row.changed_by_role;
      const noteDescription = this.custody.describeTrackingNote(row.note);

      return {
        id: row.id,
        event_type: 'status',
        order_id: row.order_id,
        action,
        from_status: row.from_status,
        to_status: row.to_status,
        old_value:
          row.old_value ??
          (row.from_status ? { status: row.from_status } : null),
        new_value: row.new_value ?? { status: row.to_status },
        description:
          row.description ??
          noteDescription ??
          this.custody.describeTrackingAction(action, row.from_status, row.to_status),
        changed_by: row.changed_by,
        changed_by_role: changedByRole,
        actor,
        metadata: row.metadata ?? null,
        note: row.note,
        created_at: this.toUzIsoString(row.created_at),
        created_at_ms: row.created_at.getTime(),
      };
    });

    const custodyEvents = custodyRows.map((row) => {
      const actor =
        row.changed_by === 'system'
          ? {
              id: 'system',
              name: 'System',
              username: null,
              phone_number: null,
              role: 'system',
              status: null,
            }
          : (actorMap.get(row.changed_by) ?? null);
      const changedByRole =
        actor?.role && row.changed_by !== 'system'
          ? String(actor.role)
          : row.changed_by_role;
      const noteDescription = this.custody.describeTrackingNote(row.note);
      const fromLabel = this.custodyHolderLabel(
        row.from_holder_type,
        row.from_branch_id,
        row.from_courier_id,
        branchLabels,
        actorMap,
      );
      const toLabel = this.custodyHolderLabel(
        row.to_holder_type,
        row.to_branch_id,
        row.to_courier_id,
        branchLabels,
        actorMap,
      );
      const actorLabel = this.trackingActorLabel(actor, row.changed_by);
      const custodyDescription = `${actorLabel} buyurtmani ${fromLabel}dan ${toLabel}ga o'tkazdi${
        noteDescription ? `. Izoh: ${noteDescription}` : ''
      }`;

      return {
        id: row.id,
        event_type: 'custody',
        order_id: row.order_id,
        action: 'custody_changed',
        from_status: null,
        to_status: null,
        old_value: {
          holder_type: row.from_holder_type,
          holder_branch_id: row.from_branch_id,
          holder_branch: row.from_branch_id
            ? (branchLabels.get(String(row.from_branch_id)) ?? null)
            : null,
          holder_courier_id: row.from_courier_id,
          holder_courier: row.from_courier_id
            ? this.trackingActorLabel(
                actorMap.get(String(row.from_courier_id)) ?? null,
                row.from_courier_id,
              )
            : null,
        },
        new_value: {
          holder_type: row.to_holder_type,
          holder_branch_id: row.to_branch_id,
          holder_branch: row.to_branch_id
            ? (branchLabels.get(String(row.to_branch_id)) ?? null)
            : null,
          holder_courier_id: row.to_courier_id,
          holder_courier: row.to_courier_id
            ? this.trackingActorLabel(
                actorMap.get(String(row.to_courier_id)) ?? null,
                row.to_courier_id,
              )
            : null,
        },
        description: custodyDescription,
        changed_by: row.changed_by,
        changed_by_role: changedByRole,
        actor,
        metadata: {
          from_label: fromLabel,
          to_label: toLabel,
        },
        note: row.note,
        created_at: this.toUzIsoString(row.created_at),
        created_at_ms: row.created_at.getTime(),
      };
    });

    const timeline = [...trackingEvents, ...custodyEvents].sort(
      (a, b) => b.created_at_ms - a.created_at_ms,
    );
    const total = timeline.length;
    const pageData = timeline
      .slice((page - 1) * limit, page * limit)
      .map(({ ...event }) => event);

    return {
      data: pageData,
      total,
      page,
      limit,
    };
  }

  async getCustodyHistoryByOrderId(id: string) {
    await this.findById(id);

    const rows = await this.orderCustodyEventRepo.find({
      where: { order_id: id },
      order: { created_at: 'ASC' },
    });

    return rows.map((row) => ({
      id: row.id,
      order_id: row.order_id,
      from_holder_type: row.from_holder_type,
      to_holder_type: row.to_holder_type,
      from_branch_id: row.from_branch_id,
      to_branch_id: row.to_branch_id,
      from_courier_id: row.from_courier_id,
      to_courier_id: row.to_courier_id,
      changed_by: row.changed_by,
      changed_by_role: row.changed_by_role,
      note: row.note,
      created_at: this.toUzIsoString(row.created_at),
    }));
  }

  private stripRegionDistricts<T>(region: T): T {
    if (!region || typeof region !== 'object') {
      return region;
    }
    const { districts, ...rest } = region as Record<string, unknown>;
    void districts;
    return rest as T;
  }

  private async enrichOrders(rows: Order[]) {
    if (!rows.length) return [];

    const marketIds = [
      ...new Set(rows.map((r) => r.market_id).filter(Boolean)),
    ];
    const customerIds = [
      ...new Set(rows.map((r) => r.customer_id).filter(Boolean)),
    ];
    const districtIds = [
      ...new Set(rows.map((r) => r.district_id).filter(Boolean) as string[]),
    ];
    const regionIds = [
      ...new Set(rows.map((r) => r.region_id).filter(Boolean) as string[]),
    ];
    const productIds = [
      ...new Set(
        rows
          .flatMap((r) => r.items ?? [])
          .map((i) => i.product_id)
          .filter(Boolean),
      ),
    ];

    const [marketsRes, customersRes, districtsRes, regionsRes, productsRes] =
      await Promise.all([
        marketIds.length
          ? rmqSend<{ data: Array<{ id: string; [key: string]: any }> }>(
              this.identityClient,
              { cmd: 'identity.market.find_by_ids' },
              { ids: marketIds },
            ).catch(() => ({ data: [] }))
          : { data: [] as Array<{ id: string; [key: string]: any }> },
        customerIds.length
          ? rmqSend<{ data: Array<{ id: string; [key: string]: any }> }>(
              this.identityClient,
              { cmd: 'identity.customer.find_by_ids' },
              { ids: customerIds },
            ).catch(() => ({ data: [] }))
          : { data: [] as Array<{ id: string; [key: string]: any }> },
        districtIds.length
          ? rmqSend<{ data: Array<{ id: string; [key: string]: any }> }>(
              this.logisticsClient,
              { cmd: 'logistics.district.find_by_ids' },
              { ids: districtIds },
            ).catch(() => ({ data: [] }))
          : { data: [] as Array<{ id: string; [key: string]: any }> },
        regionIds.length
          ? rmqSend<{ data: Array<{ id: string; [key: string]: any }> }>(
              this.logisticsClient,
              { cmd: 'logistics.region.find_by_ids' },
              { ids: regionIds },
            ).catch(() => ({ data: [] }))
          : { data: [] as Array<{ id: string; [key: string]: any }> },
        productIds.length
          ? rmqSend<{ data: Array<{ id: string; [key: string]: any }> }>(
              this.catalogClient,
              { cmd: 'catalog.product.find_by_ids' },
              { ids: productIds },
            ).catch(() => ({ data: [] }))
          : { data: [] },
      ]);

    const toMap = (arr: Array<{ id: string; [key: string]: any }>) =>
      new Map(
        arr.map((item): [string, typeof item] => [String(item.id), item]),
      );

    const marketMap = toMap(marketsRes?.data ?? []);
    const customerMap = toMap(customersRes?.data ?? []);
    const districtMap = toMap(districtsRes?.data ?? []);
    const regionMap = toMap(regionsRes?.data ?? []);
    const productMap = toMap(productsRes?.data ?? []);

    return rows.map((row) => ({
      ...row,
      market: row.market_id ? (marketMap.get(row.market_id) ?? null) : null,
      customer: row.customer_id
        ? {
            ...(customerMap.get(row.customer_id) ?? null),
            district: row.district_id
              ? (districtMap.get(row.district_id) ?? null)
              : null,
            region: row.region_id
              ? this.stripRegionDistricts(regionMap.get(row.region_id) ?? null)
              : null,
          }
        : null,
      district: row.district_id
        ? (districtMap.get(row.district_id) ?? null)
        : null,
      region: row.region_id
        ? this.stripRegionDistricts(regionMap.get(row.region_id) ?? null)
        : null,
      items: (row.items ?? []).map((item) => ({
        ...item,
        product: item.product_id
          ? (productMap.get(item.product_id) ?? null)
          : null,
      })),
    }));
  }

  // ==================== Enriched Endpoints ====================

  async findAllEnriched(query: {
    market_id?: string;
    customer_id?: string;
    post_ids?: string[];
    branch_id?: string;
    canceled_post_unassigned?: boolean;
    holder_type?: OrderHolderType;
    exclude_statuses?: Order_status[];
    status?: Order_status | Order_status[] | string | string[];
    where_deliver?: Where_deliver;
    search?: string;
    start_day?: string;
    end_day?: string;
    courier?: string;
    courier_ids?: string[];
    holder_courier_ids?: string[];
    include_courier_history?: boolean | string;
    region_id?: string;
    district_id?: string;
    page?: number;
    limit?: number;
  }) {
    const { search, ...orderQuery } = query;

    // If search is provided, find matching customer IDs via identity-service
    let customer_ids: string[] | undefined;
    if (search?.trim()) {
      const searchRes = await rmqSend<{ data: Array<{ id: string }> }>(
        this.identityClient,
        { cmd: 'identity.customer.search' },
        { search: search.trim(), limit: 1000 },
      ).catch(() => ({ data: [] }));

      customer_ids = (searchRes?.data ?? []).map((c) => String(c.id));
      if (!customer_ids.length) {
        const pagination = this.normalizePagination(query.page, query.limit);
        return {
          data: [],
          total: 0,
          page: pagination.page,
          limit: pagination.limit,
          total_pages: 0,
          totalPages: 0,
        };
      }
    }

    const result = await this.findAll({ ...orderQuery, customer_ids });
    const enriched = await this.enrichOrders(result.data);

    return {
      data: enriched,
      total: result.total,
      page: result.page,
      limit: result.limit,
      total_pages: result.total_pages ?? 0,
      totalPages: result.totalPages ?? result.total_pages ?? 0,
    };
  }

  async findByIdEnriched(id: string) {
    const order = await this.findById(id);
    const enriched = await this.enrichOrders([order]);
    return enriched[0] ?? order;
  }

  async findNewMarketsEnriched(
    branch_id?: string,
    exclude_branch_source = false,
  ) {
    const rows = await this.findNewMarkets(branch_id, exclude_branch_source);
    const marketIds = rows.map((r) => r.market_id).filter(Boolean);

    if (!marketIds.length) return rows;

    const marketsRes = await rmqSend<{
      data: Array<{ id: string; [key: string]: any }>;
    }>(
      this.identityClient,
      { cmd: 'identity.market.find_by_ids' },
      { ids: marketIds },
    ).catch(() => ({ data: [] as Array<{ id: string; [key: string]: any }> }));

    const marketMap = new Map(
      (marketsRes?.data ?? []).map((m): [string, typeof m] => [
        String(m.id),
        m,
      ]),
    );

    return rows.map((row) => ({
      ...row,
      market: marketMap.get(row.market_id) ?? null,
    }));
  }

  async findNewByMarketEnriched(
    market_id: string,
    branch_id?: string,
    exclude_branch_source = false,
  ) {
    const result = await this.findNewOrdersByMarket(
      market_id,
      branch_id,
      exclude_branch_source,
    );
    const enriched = await this.enrichOrders(result.data);
    return {
      data: enriched,
      total: result.total,
    };
  }

  async findCancelledMarketsEnriched(options: {
    market_id?: string;
    branch_id?: string;
    holder_type?: OrderHolderType;
    exclude_branch_source?: boolean;
  }) {
    const rows = await this.findCancelledMarkets(options);
    const marketIds = rows.map((row) => row.market_id).filter(Boolean);

    if (!marketIds.length) return rows;

    const marketsRes = await rmqSend<{
      data: Array<{ id: string; [key: string]: any }>;
    }>(
      this.identityClient,
      { cmd: 'identity.market.find_by_ids' },
      { ids: marketIds },
    ).catch(() => ({ data: [] as Array<{ id: string; [key: string]: any }> }));

    const marketMap = new Map(
      (marketsRes?.data ?? []).map((market): [string, typeof market] => [
        String(market.id),
        market,
      ]),
    );

    return rows.map((row) => ({
      ...row,
      market: marketMap.get(row.market_id) ?? null,
    }));
  }

  async findCancelledByMarketEnriched(
    market_id: string,
    options: {
      branch_id?: string;
      holder_type?: OrderHolderType;
      exclude_branch_source?: boolean;
    },
  ) {
    const result = await this.findCancelledOrdersByMarket(market_id, options);
    const enriched = await this.enrichOrders(result.data);
    return {
      data: enriched,
      total: result.total,
    };
  }

  normalizeUpdatePayload(dto: Record<string, any>): Record<string, any> {
    const payload = { ...dto };

    if (typeof payload.where_deliver === 'string') {
      const normalized = payload.where_deliver.toLowerCase();
      if (
        normalized === Where_deliver.CENTER ||
        normalized === Where_deliver.ADDRESS
      ) {
        payload.where_deliver = normalized;
      }
    }

    if (typeof payload.status === 'string') {
      const normalized = payload.status.toLowerCase();
      payload.status =
        normalized === Order_status.CREATED ? Order_status.NEW : normalized;
    }

    if (typeof payload.source === 'string') {
      payload.source = payload.source.toLowerCase();
    }

    if (typeof payload.assigned_at === 'string' && payload.assigned_at.trim()) {
      const parsed = new Date(payload.assigned_at);
      if (Number.isNaN(parsed.getTime())) {
        this.badRequest("assigned_at noto'g'ri datetime formatida");
      }
      payload.assigned_at = parsed;
    }

    if (payload.items) {
      payload.items = payload.items.map((item: any) => ({
        product_id: String(item.product_id),
        quantity: item.quantity ?? 1,
      }));
    }

    return payload;
  }

  /**
   * Gather render-ready order data for label / receipt printing.
   *
   * The order schema only stores foreign-key ids, so this resolves the
   * customer + market (identity), district + region (logistics) and product
   * names (catalog) in batch, then returns a flat row per order. Relations are
   * resolved best-effort: any cross-service miss falls back to '-' / '' so the
   * print job never fails on partial data. Rows preserve the requested id
   * order and silently skip ids that match no (non-deleted) order.
   */
  async findOrdersForPrint(orderIds: string[]) {
    const ids = [
      ...new Set((orderIds ?? []).map((x) => String(x)).filter(Boolean)),
    ];
    if (!ids.length) {
      return successRes([], 200);
    }

    const orders = await this.orderRepo.find({
      where: { id: In(ids), isDeleted: false },
      relations: { items: true },
    });
    if (!orders.length) {
      return successRes([], 200);
    }

    const uniq = (xs: Array<string | null | undefined>) => [
      ...new Set(xs.filter((x): x is string => Boolean(x)).map(String)),
    ];
    const customerIds = uniq(orders.map((o) => o.customer_id));
    const marketIds = uniq(orders.map((o) => o.market_id));
    const districtIds = uniq(orders.map((o) => o.district_id));
    const regionIds = uniq(orders.map((o) => o.region_id));
    const productIds = uniq(
      orders.flatMap((o) => (o.items ?? []).map((i) => i.product_id)),
    );

    const safeSend = <T>(
      client: ClientProxy,
      cmd: string,
      payloadIds: string[],
    ): Promise<{ data: T[] }> =>
      payloadIds.length
        ? rmqSend<{ data: T[] }>(client, { cmd }, { ids: payloadIds }).catch(
            () => ({ data: [] as T[] }),
          )
        : Promise.resolve({ data: [] as T[] });

    type NamedPhone = {
      id: string;
      name?: string;
      phone_number?: string;
      extra_number?: string | null;
      address?: string | null;
    };
    type Named = { id: string; name?: string };

    const [customersRes, marketsRes, districtsRes, regionsRes, productsRes] =
      await Promise.all([
        safeSend<NamedPhone>(
          this.identityClient,
          'identity.customer.find_by_ids',
          customerIds,
        ),
        safeSend<NamedPhone>(
          this.identityClient,
          'identity.market.find_by_ids',
          marketIds,
        ),
        safeSend<Named>(
          this.logisticsClient,
          'logistics.district.find_by_ids',
          districtIds,
        ),
        safeSend<Named>(
          this.logisticsClient,
          'logistics.region.find_by_ids',
          regionIds,
        ),
        safeSend<Named>(
          this.catalogClient,
          'catalog.product.find_by_ids',
          productIds,
        ),
      ]);

    const toMap = <T extends { id: string }>(rows: T[] | undefined) =>
      new Map((rows ?? []).map((r) => [String(r.id), r]));
    const customerMap = toMap(customersRes?.data);
    const marketMap = toMap(marketsRes?.data);
    const districtMap = toMap(districtsRes?.data);
    const regionMap = toMap(regionsRes?.data);
    const productMap = toMap(productsRes?.data);
    const orderMap = new Map(orders.map((o) => [String(o.id), o]));

    const rows = ids
      .map((id) => orderMap.get(id))
      .filter((o): o is Order => Boolean(o))
      .map((order) => {
        const customer = customerMap.get(String(order.customer_id));
        const market = marketMap.get(String(order.market_id));
        const district = order.district_id
          ? districtMap.get(String(order.district_id))
          : undefined;
        const region = order.region_id
          ? regionMap.get(String(order.region_id))
          : undefined;
        return {
          id: String(order.id),
          order_number: String(order.id),
          qr_code_token: order.qr_code_token ?? '',
          created_at: order.createdAt
            ? new Date(order.createdAt).getTime()
            : Date.now(),
          where_deliver: order.where_deliver,
          total_price: Number(order.total_price ?? 0),
          comment: order.comment ?? '',
          address: order.address ?? '',
          customer_name: customer?.name ?? 'N/A',
          customer_phone: customer?.phone_number ?? '',
          extra_number: customer?.extra_number ?? '',
          region_name: region?.name ?? '',
          district_name: district?.name ?? 'N/A',
          market_name: market?.name ?? 'N/A',
          market_phone: market?.phone_number ?? '',
          operator: order.operator ?? '',
          products: (order.items ?? []).map((i) => ({
            name: productMap.get(String(i.product_id))?.name ?? 'N/A',
            quantity: i.quantity ?? 1,
          })),
        };
      });

    return successRes(rows, 200);
  }
}
