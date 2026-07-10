import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import {
  Brackets,
  DataSource,
  In,
  IsNull,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { lastValueFrom, timeout } from 'rxjs';
import { createHash, randomBytes } from 'node:crypto';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderHolderType, Order_source } from './entities/order.entity';
import { OrderTracking } from './entities/order-tracking.entity';
import { OrderCustodyEvent } from './entities/order-custody-event.entity';
import { OrderSettlement } from './entities/order-settlement.entity';
import { BranchTransferBatch } from './entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from './entities/branch-transfer-batch-item.entity';
import { BranchTransferBatchHistory } from './entities/branch-transfer-batch-history.entity';
import { OrderBatchInboxMessage } from './entities/order-batch-inbox-message.entity';
import { MarketCancelledHandoverSession } from './entities/market-cancelled-handover-session.entity';
import {
  ActivityAction,
  ActivityLogService,
  ActivityLogQuery,
  BranchOwnership,
  BranchType,
  BranchTransferBatchAction,
  BranchTransferBatchStatus,
  BranchTransferDirection,
  Cashbox_type,
  CourierCompensationMode,
  ExpenseProofCondition,
  Operation_type,
  Order_status,
  OutboxService,
  PaymentMethod,
  Post_status,
  Roles,
  SettlementStatus,
  Source_type,
  Where_deliver,
  rmqSend,
  RMQ_SERVICE_TIMEOUT,
} from '@app/common';
import type { EntityManager } from 'typeorm';
import { successRes } from '../../../libs/common/helpers/response';

const CANCELLED_HANDOVER_MANUAL_REASONS = new Set([
  'QR yirtilgan',
  "QR o'qilmayapti",
  "Label yo'qolgan",
  'QR namlangan yoki xiralashgan',
]);
const CANCELLED_HANDOVER_MANUAL_REASON_MAX_LENGTH = 80;

@Injectable()
export class OrderServiceService implements OnModuleInit {
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
  ) {}

  private hqBranchIdCache: string | null = null;

  /**
   * Normalise the RMQ `requester` payload into the actor fields the
   * activity-log expects. `user_name` is not carried in `requester`, so it is
   * left null (the audit table denormalises it but tolerates absence); the
   * user_id + role pair is enough to attribute every action.
   */
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

  async onModuleInit(): Promise<void> {
    // Warm the HQ branch cache up-front. branch-service seeds HQ on its own
    // init, so this should succeed on a healthy stack. If RMQ isn't ready yet
    // (cold-start race) we just log; the first order create will retry.
    try {
      await this.getHqBranchId();
    } catch (err) {
      this.logger.warn(
        `HQ branch warm-up failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * Resolve the branch_id to attach to a new order.
   * Priority: explicit dto.branch_id → requester's assigned branch → HQ fallback.
   * Throws RpcException 500 if all paths fail — refuse to persist an order
   * with NULL branch_id (the audit identified this as a long-term data risk).
   */
  private async resolveBranchIdForOrder(
    explicitBranchId: string | null | undefined,
    requester?: { id: string; roles?: string[]; branch_id?: string | null },
  ): Promise<string> {
    if (explicitBranchId) {
      return String(explicitBranchId);
    }

    // JWT now carries branch_id; prefer it to avoid a per-request RMQ hop to branch-service.
    if (requester?.branch_id) {
      return String(requester.branch_id);
    }

    if (requester?.id) {
      try {
        const response = await rmqSend<{
          data?: { branch_id?: string | null };
        }>(
          this.branchClient,
          { cmd: 'branch.user.find_by_user' },
          { user_id: String(requester.id), requester },
          { attachRequestId: false, retries: 1 },
        );
        const branchId = response?.data?.branch_id;
        if (branchId) {
          return String(branchId);
        }
      } catch {
        // fall through to HQ fallback
      }
    }

    const hqId = await this.getHqBranchId();
    if (hqId) {
      return hqId;
    }

    throw new RpcException({
      statusCode: 500,
      message:
        'Cannot resolve branch_id for order: no explicit/JWT/assigned branch and HQ fallback unavailable',
    });
  }

  /**
   * Queue a search-index upsert via the Outbox. Pass `manager` to enqueue the
   * event inside the same transaction as the order mutation — that way commit
   * is atomic (search event is logged iff the order change persists). If
   * `manager` is omitted, the enqueue runs on the default connection (legacy
   * post-commit pattern, retained only for non-transactional callers).
   */
  private async syncOrderToSearch(
    order: Order,
    manager?: EntityManager,
  ): Promise<void> {
    try {
      await this.outbox.enqueue(
        'SEARCH',
        'search.index.upsert',
        {
          source: 'order',
          type: 'order',
          sourceId: order.id,
          title: `Order #${order.id}`,
          content: [
            order.status,
            order.address,
            order.comment,
            order.market_id,
            order.customer_id,
          ]
            .filter(Boolean)
            .join(' '),
          tags: ['order', order.status, order.where_deliver].filter(Boolean),
          metadata: {
            status: order.status,
            source: order.source,
            market_id: order.market_id,
            customer_id: order.customer_id,
            post_id: order.post_id,
            canceled_post_id: order.canceled_post_id,
            branch_id: order.branch_id,
            current_batch_id: order.current_batch_id,
            courier_id: order.courier_id,
            holder_type: order.holder_type,
            holder_branch_id: order.holder_branch_id,
            holder_courier_id: order.holder_courier_id,
            last_handover_at: order.last_handover_at,
            last_handover_by: order.last_handover_by,
            assigned_at: order.assigned_at,
            return_reason: order.return_reason,
            region_id: order.region_id,
            district_id: order.district_id,
            total_price: order.total_price,
            isDeleted: order.isDeleted,
          },
        },
        { manager },
      );
    } catch (err) {
      // When called inside a TX, re-throw so the surrounding rollback fires;
      // post-commit callers (legacy) ignore enqueue failures as before.
      if (manager) {
        throw err;
      }
    }
  }

  private async removeOrderFromSearch(
    orderId: string,
    manager?: EntityManager,
  ): Promise<void> {
    try {
      await this.outbox.enqueue(
        'SEARCH',
        'search.index.remove',
        {
          source: 'order',
          type: 'order',
          sourceId: orderId,
        },
        { manager },
      );
    } catch (err) {
      if (manager) {
        throw err;
      }
    }
  }

  private notFound(message: string): never {
    throw new RpcException({ statusCode: 404, message });
  }

  private badRequest(message: string): never {
    throw new RpcException({ statusCode: 400, message });
  }

  private forbidden(message: string): never {
    throw new RpcException({ statusCode: 403, message });
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

  private toTrackingRole(roles?: string[]): string {
    const normalized = (roles ?? [])
      .map((role) =>
        String(role ?? '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);

    const priority = [
      Roles.SUPERADMIN,
      Roles.ADMIN,
      Roles.MANAGER,
      Roles.REGISTRATOR,
      Roles.OPERATOR,
      Roles.COURIER,
      Roles.MARKET,
      Roles.MARKET_OPERATOR,
      Roles.BRANCH,
      Roles.INVESTOR,
      Roles.CUSTOMER,
    ].map((role) => String(role).toLowerCase());

    return (
      priority.find((role) => normalized.includes(role)) ??
      normalized[0] ??
      'system'
    );
  }

  private hashHandoverToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private generateHandoverToken(prefix: 'MCR' | 'MHA'): string {
    return `${prefix}-${randomBytes(32).toString('base64url')}`;
  }

  private async assertMarketHandoverHqRequester(requester: {
    id: string;
    roles?: string[];
  }): Promise<void> {
    const roles = new Set(
      (requester.roles ?? []).map((role) =>
        String(role ?? '')
          .trim()
          .toLowerCase(),
      ),
    );

    if (roles.has(Roles.SUPERADMIN) || roles.has(Roles.ADMIN)) {
      return;
    }

    if (!roles.has(Roles.REGISTRATOR)) {
      this.forbidden('QR scan va marketga topshirish faqat HQ xodimlari uchun');
    }

    const response = await rmqSend<{
      data?: {
        branch_id?: string | null;
        branch?: { type?: string | null } | null;
      } | null;
    }>(
      this.branchClient,
      { cmd: 'branch.user.find_by_user' },
      {
        user_id: String(requester.id),
        requester: {
          id: String(requester.id),
          roles: requester.roles ?? [],
        },
      },
      { attachRequestId: false, retries: 1 },
    );

    if (
      String(response?.data?.branch?.type ?? '').toUpperCase() !== BranchType.HQ
    ) {
      this.forbidden('Faqat HQga tegishli registrator QR scan qila oladi');
    }
  }

  private mapInitialStatusForTracking(status: Order_status): Order_status {
    return status === Order_status.NEW ? Order_status.CREATED : status;
  }

  private isValidStatusTransition(
    fromStatus: Order_status,
    toStatus: Order_status,
  ): boolean {
    if (fromStatus === toStatus) return true;

    const transitions: Record<Order_status, Order_status[]> = {
      [Order_status.CREATED]: [
        Order_status.NEW,
        Order_status.RECEIVED,
        Order_status.CANCELLED,
      ],
      [Order_status.NEW]: [Order_status.RECEIVED, Order_status.CANCELLED],
      [Order_status.RECEIVED]: [
        Order_status.ON_THE_ROAD,
        Order_status.WAITING,
        Order_status.CANCELLED,
      ],
      [Order_status.ON_THE_ROAD]: [
        Order_status.WAITING,
        Order_status.WAITING_CUSTOMER,
        Order_status.CANCELLED,
      ],
      [Order_status.WAITING_CUSTOMER]: [
        Order_status.ON_THE_ROAD,
        Order_status.WAITING,
        Order_status.RETURNED_TO_MARKET,
        Order_status.CANCELLED,
      ],
      [Order_status.WAITING]: [
        Order_status.ON_THE_ROAD,
        Order_status.SOLD,
        Order_status.PARTLY_PAID,
        Order_status.PAID,
        Order_status.CANCELLED,
        Order_status.RETURNED_TO_MARKET,
        Order_status.CLOSED,
      ],
      [Order_status.SOLD]: [
        Order_status.PAID,
        Order_status.WAITING,
        Order_status.CLOSED,
      ],
      [Order_status.PARTLY_PAID]: [
        Order_status.PAID,
        Order_status.WAITING,
        Order_status.CLOSED,
      ],
      [Order_status.PAID]: [Order_status.WAITING, Order_status.CLOSED],
      [Order_status.CANCELLED]: [
        Order_status.WAITING,
        Order_status.CANCELLED_SENT,
        Order_status.CLOSED,
      ],
      [Order_status.RETURNED_TO_MARKET]: [],
      [Order_status.CANCELLED_SENT]: [
        Order_status.CANCELLED,
        Order_status.CLOSED,
      ],
      [Order_status.CLOSED]: [Order_status.WAITING],
    };

    return transitions[fromStatus]?.includes(toStatus) ?? false;
  }

  private haveOrderItemsChanged(
    existingItems: Array<{ product_id: string; quantity?: number }>,
    requestedItems: Array<{ product_id: string; quantity?: number }>,
  ): boolean {
    const aggregate = (
      items: Array<{ product_id: string; quantity?: number }>,
    ): Map<string, number> => {
      const result = new Map<string, number>();
      for (const item of items) {
        const productId = String(item.product_id);
        const quantity = Number(item.quantity ?? 1);
        result.set(productId, (result.get(productId) ?? 0) + quantity);
      }
      return result;
    };

    const existing = aggregate(existingItems);
    const requested = aggregate(requestedItems);
    if (existing.size !== requested.size) return true;

    for (const [productId, quantity] of existing) {
      if (requested.get(productId) !== quantity) return true;
    }

    return false;
  }

  private assertCommercialFieldsEditable(
    order: Order,
    dto: {
      total_price?: number;
      items?: Array<{ product_id: string; quantity?: number }>;
    },
  ): void {
    if ([Order_status.CREATED, Order_status.NEW].includes(order.status)) {
      return;
    }

    const totalPriceChanged =
      typeof dto.total_price !== 'undefined' &&
      Number(dto.total_price) !== Number(order.total_price);
    const itemsChanged =
      typeof dto.items !== 'undefined' &&
      this.haveOrderItemsChanged(order.items ?? [], dto.items);

    if (totalPriceChanged || itemsChanged) {
      this.badRequest(
        "HQ qabul qilgan buyurtmaning summasi va mahsulot sonini o'zgartirib bo'lmaydi",
      );
    }
  }

  private async wasSentFromHqToBranch(orderId: string): Promise<boolean> {
    const hqBranchId = await this.getHqBranchId();
    if (!hqBranchId) return false;

    const batchItems = await this.transferBatchItemRepo.find({
      where: { order_id: String(orderId), isDeleted: false },
      relations: { batch: true },
    });

    return batchItems.some(
      (item) =>
        Boolean(item.sent_at) &&
        !item.batch?.isDeleted &&
        item.batch?.direction === BranchTransferDirection.FORWARD &&
        String(item.batch?.source_branch_id ?? '') === hqBranchId &&
        String(item.batch?.destination_branch_id ?? '') !== hqBranchId,
    );
  }

  private async assertDeliveryDetailsEditable(
    order: Order,
    dto: {
      customer_id?: string;
      where_deliver?: Where_deliver;
      district_id?: string | null;
      region_id?: string | null;
      address?: string | null;
    },
  ): Promise<void> {
    const changed =
      (typeof dto.customer_id !== 'undefined' &&
        String(dto.customer_id) !== String(order.customer_id)) ||
      (typeof dto.where_deliver !== 'undefined' &&
        dto.where_deliver !== order.where_deliver) ||
      (typeof dto.district_id !== 'undefined' &&
        String(dto.district_id ?? '') !== String(order.district_id ?? '')) ||
      (typeof dto.region_id !== 'undefined' &&
        String(dto.region_id ?? '') !== String(order.region_id ?? '')) ||
      (typeof dto.address !== 'undefined' &&
        String(dto.address ?? '') !== String(order.address ?? ''));

    if (changed && (await this.wasSentFromHqToBranch(order.id))) {
      this.badRequest(
        "Branchga jo'natilgan buyurtmaning manzili va mijozini o'zgartirib bo'lmaydi",
      );
    }
  }

  private async createTrackingEvent(
    data: {
      order_id: string;
      from_status: Order_status | null;
      to_status: Order_status;
      changed_by: string;
      changed_by_role: string;
      action?: string | null;
      old_value?: Record<string, unknown> | null;
      new_value?: Record<string, unknown> | null;
      description?: string | null;
      metadata?: Record<string, unknown> | null;
      note?: string | null;
    },
    repository?: Repository<OrderTracking>,
  ) {
    const repo = repository ?? this.orderTrackingRepo;
    const action =
      data.action ??
      this.inferTrackingAction(data.from_status, data.to_status, data.note);
    const entity = repo.create({
      order_id: data.order_id,
      from_status: data.from_status,
      to_status: data.to_status,
      action,
      old_value:
        data.old_value ??
        (data.from_status ? { status: data.from_status } : null),
      new_value: data.new_value ?? { status: data.to_status },
      description:
        data.description ??
        this.describeTrackingNote(data.note) ??
        this.describeTrackingAction(action, data.from_status, data.to_status),
      changed_by: data.changed_by,
      changed_by_role: data.changed_by_role,
      metadata: data.metadata ?? null,
      note: data.note ?? null,
    });
    await repo.save(entity);
  }

  private inferTrackingAction(
    fromStatus: Order_status | null,
    toStatus: Order_status,
    note?: string | null,
  ): string {
    const normalizedNote = String(note ?? '').toLowerCase();
    if (normalizedNote.includes('partly')) {
      return 'partly_sold';
    }
    if (normalizedNote.includes('rollback')) {
      return 'rollback';
    }

    if (!fromStatus) {
      return toStatus === Order_status.CREATED || toStatus === Order_status.NEW
        ? 'created'
        : 'status_change';
    }

    if (fromStatus === toStatus) {
      return 'note';
    }

    const byTarget: Partial<Record<Order_status, string>> = {
      [Order_status.CREATED]: 'created',
      [Order_status.NEW]: 'created',
      [Order_status.RECEIVED]: 'received',
      [Order_status.ON_THE_ROAD]: 'sent',
      [Order_status.WAITING]: 'waiting',
      [Order_status.WAITING_CUSTOMER]: 'waiting_customer',
      [Order_status.SOLD]: 'sold',
      [Order_status.PAID]: 'paid',
      [Order_status.PARTLY_PAID]: 'partly_paid',
      [Order_status.CANCELLED]: 'cancelled',
      [Order_status.CANCELLED_SENT]: 'cancelled_sent',
      [Order_status.RETURNED_TO_MARKET]: 'returned_to_market',
      [Order_status.CLOSED]: 'closed',
    };

    return byTarget[toStatus] ?? 'status_change';
  }

  private describeTrackingAction(
    action: string,
    fromStatus: Order_status | null,
    toStatus: Order_status,
  ): string {
    const descriptions: Record<string, string> = {
      created: 'Buyurtma yaratildi',
      received: 'Buyurtma qabul qilindi',
      sent: "Buyurtma yo'lga chiqdi",
      waiting: 'Buyurtma kutilmoqda holatiga qaytarildi',
      waiting_customer: "Mijoz kutilmoqda holatiga o'tkazildi",
      sold: 'Buyurtma sotildi',
      paid: "Buyurtma to'landi",
      partly_sold: 'Buyurtma qisman sotildi',
      partly_paid: 'Buyurtma qisman sotildi',
      cancelled: 'Buyurtma bekor qilindi',
      cancelled_sent: "Bekor qilingan buyurtma jo'natildi",
      returned_to_market: 'Buyurtma marketga qaytarildi',
      closed: 'Buyurtma yopildi',
      rollback: 'Buyurtma oldingi holatga qaytarildi',
      note: 'Buyurtma trackingiga izoh yozildi',
    };

    return (
      descriptions[action] ??
      `${fromStatus ?? 'empty'} holatidan ${toStatus} holatiga o'zgartirildi`
    );
  }

  private describeTrackingNote(note?: string | null): string | null {
    const normalized = String(note ?? '')
      .trim()
      .toLowerCase();
    if (!normalized) return null;

    const descriptions: Record<string, string> = {
      'order created': 'Buyurtma yaratildi',
      'order sold': 'Buyurtma sotildi',
      'order partly sold': 'Buyurtma qisman sotildi',
      'order canceled': 'Buyurtma bekor qilindi',
      'rollback to waiting': 'Buyurtma kutilmoqda holatiga qaytarildi',
      'rollback to cancelled': 'Buyurtma bekor qilingan holatiga qaytarildi',
      'rollback to cancelled_sent': "Buyurtma bekor qilinib pochtaga qo'shildi",
      'order assigned to post': 'Buyurtma pochtaga biriktirildi',
      'branch canceled post sent to hq':
        "Branch bekor qilingan pochtani HQga jo'natdi",
      'canceled order received by hq and held for market handover':
        'HQ bekor qilingan pochtani qabul qildi',
      'canceled order received by branch manager':
        'Branch manager bekor qilingan pochtani qabul qildi',
      'canceled post created':
        "Courier bekor qilingan pochtani branchga jo'natdi",
      'partly-sell unsold items canceled':
        'Qisman sotishdan qolgan mahsulotlar bekor qilindi',
      'partly-sell canceled items custody assigned':
        'Qisman sotishdan bekor qilingan buyurtma egasi belgilandi',
    };

    return descriptions[normalized] ?? note ?? null;
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

  private async getHqBranchId(): Promise<string | null> {
    if (this.hqBranchIdCache) {
      return this.hqBranchIdCache;
    }

    try {
      const response = await rmqSend<{ data?: { id?: string } }>(
        this.branchClient,
        { cmd: 'branch.find_hq' },
        {},
        { attachRequestId: false, retries: 1 },
      );
      const hqId = response?.data?.id;
      if (hqId) {
        this.hqBranchIdCache = String(hqId);
      }
    } catch {
      return null;
    }

    return this.hqBranchIdCache;
  }

  private async resolveHolderFromState(
    branchId: string | null | undefined,
    courierId: string | null | undefined,
  ): Promise<{
    holder_type: OrderHolderType;
    holder_branch_id: string | null;
    holder_courier_id: string | null;
  }> {
    const normalizedBranchId = branchId ? String(branchId) : null;
    const normalizedCourierId = courierId ? String(courierId) : null;

    if (normalizedCourierId) {
      return {
        holder_type: OrderHolderType.COURIER,
        holder_branch_id: normalizedBranchId,
        holder_courier_id: normalizedCourierId,
      };
    }

    const hqBranchId = await this.getHqBranchId();
    if (normalizedBranchId && normalizedBranchId !== hqBranchId) {
      return {
        holder_type: OrderHolderType.BRANCH,
        holder_branch_id: normalizedBranchId,
        holder_courier_id: null,
      };
    }

    return {
      holder_type: OrderHolderType.HQ,
      holder_branch_id: null,
      holder_courier_id: null,
    };
  }

  private async createCustodyEvent(
    data: {
      order_id: string;
      from_holder_type: OrderHolderType | null;
      to_holder_type: OrderHolderType;
      from_branch_id: string | null;
      to_branch_id: string | null;
      from_courier_id: string | null;
      to_courier_id: string | null;
      changed_by: string;
      changed_by_role: string;
      note?: string | null;
    },
    repository?: Repository<OrderCustodyEvent>,
  ) {
    const repo = repository ?? this.orderCustodyEventRepo;
    const entity = repo.create({
      order_id: data.order_id,
      from_holder_type: data.from_holder_type,
      to_holder_type: data.to_holder_type,
      from_branch_id: data.from_branch_id,
      to_branch_id: data.to_branch_id,
      from_courier_id: data.from_courier_id,
      to_courier_id: data.to_courier_id,
      changed_by: data.changed_by,
      changed_by_role: data.changed_by_role,
      note: data.note ?? null,
    });
    await repo.save(entity);
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

  private normalizeDateTimeInput(value?: string | Date | null): Date | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const dateValue = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(dateValue.getTime())) {
      this.badRequest("assigned_at noto'g'ri datetime formatida");
    }
    return dateValue;
  }

  private analyticsDateRange(startDate?: string, endDate?: string) {
    const UZB_OFFSET_MS = 5 * 60 * 60 * 1000;

    const parseUzDate = (value: string, endOfDay: boolean): Date | null => {
      const parts = value.split('-').map(Number);
      if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
        return null;
      }
      const [year, month, day] = parts;
      const utcMs = Date.UTC(
        year,
        month - 1,
        day,
        endOfDay ? 23 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 999 : 0,
      );
      return new Date(utcMs - UZB_OFFSET_MS);
    };

    const parseDateInput = (value: string, endOfDay: boolean) => {
      if (/^\d+$/.test(value)) {
        return new Date(Number(value));
      }
      if (value.includes('T')) {
        return new Date(value);
      }
      const parsedUz = parseUzDate(value, endOfDay);
      return parsedUz ?? new Date(value);
    };

    const hasStart = Boolean(startDate && String(startDate).trim().length > 0);
    const hasEnd = Boolean(endDate && String(endDate).trim().length > 0);

    let start: Date;
    let end: Date;

    if (!hasStart || !hasEnd) {
      const uzNow = new Date(Date.now() + UZB_OFFSET_MS);
      const year = uzNow.getUTCFullYear();
      const month = String(uzNow.getUTCMonth() + 1).padStart(2, '0');
      const day = String(uzNow.getUTCDate()).padStart(2, '0');
      const dateKey = `${year}-${month}-${day}`;
      start = parseUzDate(dateKey, false)!;
      end = parseUzDate(dateKey, true)!;
    } else {
      start = parseDateInput(String(startDate), false);
      end = parseDateInput(String(endDate), true);
    }

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new RpcException({
        statusCode: 400,
        message: 'Sana formati noto‘g‘ri',
      });
    }

    return { start, end };
  }

  private soldStatuses() {
    return [Order_status.SOLD, Order_status.PAID, Order_status.PARTLY_PAID];
  }

  private activeMarketStatuses() {
    return [
      Order_status.CREATED,
      Order_status.NEW,
      Order_status.RECEIVED,
      Order_status.ON_THE_ROAD,
      Order_status.WAITING,
      Order_status.WAITING_CUSTOMER,
    ];
  }

  private async countHistoricallyCancelledOrders(
    range: { start: Date; end: Date } | null,
    branchId?: string,
    courierId?: string,
    postIds: string[] = [],
  ) {
    const statuses = [Order_status.CANCELLED, Order_status.CANCELLED_SENT];
    const custodySubQuery = this.orderCustodyEventRepo
      .createQueryBuilder('oce')
      .select('1')
      .where('oce.order_id = o.id')
      .andWhere(
        '(oce.from_branch_id = :analyticsBranchId OR oce.to_branch_id = :analyticsBranchId)',
      )
      .getQuery();

    const query = this.orderTrackingRepo
      .createQueryBuilder('t')
      .innerJoin(Order, 'o', 'o.id = t.order_id')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('t.to_status IN (:...statuses)', { statuses })
      .select('COUNT(DISTINCT t.order_id)', 'count');

    if (branchId) {
      query.andWhere(
        `(
          o.branch_id = :analyticsBranchId
          OR o.holder_branch_id = :analyticsBranchId
          OR EXISTS (${custodySubQuery})
        )`,
        { analyticsBranchId: branchId },
      );
    }

    if (courierId) {
      const courierCustodySubQuery = this.orderCustodyEventRepo
        .createQueryBuilder('oce_courier')
        .select('1')
        .where('oce_courier.order_id = o.id')
        .andWhere(
          '(oce_courier.from_courier_id = :analyticsCourierId OR oce_courier.to_courier_id = :analyticsCourierId)',
        )
        .getQuery();
      const hasPostScope = postIds.length > 0;

      query.andWhere(
        `(
          o.courier_id = :analyticsCourierId
          OR o.holder_courier_id = :analyticsCourierId
          ${hasPostScope ? 'OR o.post_id IN (:...analyticsPostIds)' : ''}
          OR EXISTS (${courierCustodySubQuery})
        )`,
        {
          analyticsCourierId: courierId,
          ...(hasPostScope ? { analyticsPostIds: postIds } : {}),
        },
      );
    }

    if (range) {
      query.andWhere('t.created_at BETWEEN :start AND :end', range);
    }

    const row = await query.getRawOne<{ count?: string | number }>();
    return Number(row?.count ?? 0);
  }

  private applyAnalyticsBranchScope<
    T extends { andWhere: (...args: any[]) => T },
  >(query: T, branchId?: string): T {
    if (!branchId) {
      return query;
    }
    const custodySubQuery = this.orderCustodyEventRepo
      .createQueryBuilder('oce')
      .select('1')
      .where('oce.order_id = o.id')
      .andWhere(
        '(oce.from_branch_id = :analyticsBranchId OR oce.to_branch_id = :analyticsBranchId)',
      )
      .getQuery();

    return query.andWhere(
      `(
        o.branch_id = :analyticsBranchId
        OR o.holder_branch_id = :analyticsBranchId
        OR EXISTS (${custodySubQuery})
      )`,
      { analyticsBranchId: branchId },
    );
  }

  private applyAnalyticsCourierScope<
    T extends { andWhere: (...args: any[]) => T },
  >(query: T, courierId: string, postIds: string[] = []): T {
    const custodySubQuery = this.orderCustodyEventRepo
      .createQueryBuilder('oce')
      .select('1')
      .where('oce.order_id = o.id')
      .andWhere(
        '(oce.from_courier_id = :analyticsCourierId OR oce.to_courier_id = :analyticsCourierId)',
      )
      .getQuery();
    const hasPostScope = postIds.length > 0;

    return query.andWhere(
      `(
        o.courier_id = :analyticsCourierId
        OR o.holder_courier_id = :analyticsCourierId
        ${hasPostScope ? 'OR o.post_id IN (:...analyticsPostIds)' : ''}
        OR EXISTS (${custodySubQuery})
      )`,
      {
        analyticsCourierId: courierId,
        ...(hasPostScope ? { analyticsPostIds: postIds } : {}),
      },
    );
  }

  private dateKey(date: Date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tashkent',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  private dateLabel(date: Date) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tashkent',
      day: '2-digit',
      month: '2-digit',
    })
      .format(date)
      .replace('/', '.')
      .replace('/', '.');
  }

  private normalizeRevenuePeriod(
    period?: string,
  ): 'daily' | 'weekly' | 'monthly' | 'yearly' {
    const normalized = String(period ?? 'daily').toLowerCase();
    if (
      normalized === 'daily' ||
      normalized === 'weekly' ||
      normalized === 'monthly' ||
      normalized === 'yearly'
    ) {
      return normalized;
    }
    throw new RpcException({
      statusCode: 400,
      message: 'period must be one of: daily, weekly, monthly, yearly',
    });
  }

  private periodStart(
    date: Date,
    period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);

    if (period === 'daily') return d;
    if (period === 'monthly') {
      d.setDate(1);
      return d;
    }
    if (period === 'yearly') {
      d.setMonth(0, 1);
      return d;
    }

    // weekly (week starts on Monday)
    const day = d.getDay(); // 0=Sun..6=Sat
    const diffToMonday = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diffToMonday);
    return d;
  }

  private nextPeriodStart(
    date: Date,
    period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): Date {
    const d = new Date(date);
    if (period === 'daily') d.setDate(d.getDate() + 1);
    else if (period === 'weekly') d.setDate(d.getDate() + 7);
    else if (period === 'monthly') d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  private periodKey(
    date: Date,
    period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): string {
    const d = this.periodStart(date, period);
    if (period === 'daily') {
      return this.dateKey(d);
    }
    if (period === 'weekly') {
      return `W:${this.dateKey(d)}`;
    }
    if (period === 'monthly') {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      return `M:${y}-${m}`;
    }
    return `Y:${d.getFullYear()}`;
  }

  private periodLabel(
    date: Date,
    period: 'daily' | 'weekly' | 'monthly' | 'yearly',
  ): string {
    const d = this.periodStart(date, period);
    if (period === 'daily') {
      return this.dateLabel(d);
    }
    if (period === 'weekly') {
      const end = new Date(d);
      end.setDate(end.getDate() + 6);
      return `${this.dateLabel(d)}-${this.dateLabel(end)}`;
    }
    if (period === 'monthly') {
      const m = String(d.getMonth() + 1).padStart(2, '0');
      return `${m}.${d.getFullYear()}`;
    }
    return String(d.getFullYear());
  }

  private generateSaleComment(
    orderComment?: string | null,
    dtoComment?: string | null,
    extraCost?: number,
    notes: string[] = [],
  ) {
    const parts: string[] = [];

    if (orderComment?.trim()) parts.push(orderComment.trim());
    if (dtoComment?.trim()) parts.push(dtoComment.trim());
    if ((extraCost ?? 0) > 0) {
      parts.push(
        `!!! Bu buyurtmadan qo'shimcha ${extraCost} miqdorda pul ushlab qolingan`,
      );
    }

    for (const note of notes) {
      if (note?.trim()) parts.push(`!!! ${note.trim()}`);
    }

    return parts.join('\n');
  }

  private async getPostsByIds(ids: string[]) {
    if (!ids.length) return [];
    const response = await rmqSend<{
      data?: Array<{ id: string; courier_id?: string | null }>;
    }>(
      this.logisticsClient,
      { cmd: 'logistics.post.find_by_ids' },
      { ids },
    ).catch(() => ({ data: [] }));
    return response?.data ?? [];
  }

  private async getAllPostsForAnalytics() {
    const limit = 100;
    let page = 1;
    let totalPages = 1;
    const rows: Array<{
      id: string;
      courier_id?: string | null;
      updatedAt?: string | Date | null;
    }> = [];

    while (page <= totalPages) {
      const response = await rmqSend<{
        data?: {
          data?: Array<{
            id: string;
            courier_id?: string | null;
            updatedAt?: string | Date | null;
          }>;
          totalPages?: number;
        };
      }>(
        this.logisticsClient,
        { cmd: 'logistics.post.find_all' },
        { query: { page, limit } },
      ).catch(() => ({ data: { data: [], totalPages: 1 } }));

      rows.push(...(response?.data?.data ?? []));
      totalPages = Math.max(1, Number(response?.data?.totalPages ?? 1));
      page += 1;
    }

    return rows;
  }

  private async getMarketsByIds(ids: string[]) {
    if (!ids.length) return [];
    const response = await rmqSend<{
      data?: Array<{
        id: string;
        name?: string;
        tariff_home?: number;
        tariff_center?: number;
        expense_proof_conditions?: ExpenseProofCondition[] | null;
        cancelled_handover_qr_required?: boolean | null;
      }>;
    }>(
      this.identityClient,
      { cmd: 'identity.market.find_by_ids' },
      { ids },
    ).catch(() => ({ data: [] }));
    return response?.data ?? [];
  }

  private async getCouriersByIds(ids: string[]) {
    if (!ids.length) return [];
    const response = await rmqSend<{
      data?: Array<{
        id: string;
        name?: string;
        tariff_home?: number;
        tariff_center?: number;
        compensation_mode?: string | null;
      }>;
    }>(
      this.identityClient,
      { cmd: 'identity.courier.find_by_ids' },
      { ids },
    ).catch(() => ({ data: [] }));
    return response?.data ?? [];
  }

  private async getBranchesByIds(ids: string[]) {
    const uniqueIds = Array.from(
      new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean)),
    );
    if (!uniqueIds.length) return [];

    const rows = await Promise.all(
      uniqueIds.map((id) =>
        rmqSend<{
          data?: {
            id?: string;
            name?: string | null;
            code?: string | null;
          };
        }>(
          this.branchClient,
          { cmd: 'branch.find_by_id' },
          { id, requester: { id: 'system', roles: [Roles.SUPERADMIN] } },
          { attachRequestId: false, retries: 1 },
        )
          .then((response) => response?.data ?? null)
          .catch(() => null),
      ),
    );

    return rows
      .filter((row): row is { id?: string; name?: string | null; code?: string | null } =>
        Boolean(row?.id),
      )
      .map((row) => ({
        id: String(row.id),
        name: row.name ?? null,
        code: row.code ?? null,
      }));
  }

  private async getUserById(id: string) {
    const response = await rmqSend<{
      data?: {
        id: string;
        name?: string;
        tariff_home?: number;
        tariff_center?: number;
        compensation_mode?: string | null;
      };
    }>(
      this.identityClient,
      { cmd: 'identity.user.find_by_id' },
      { id: String(id) },
    ).catch(() => ({ data: undefined }));

    return response?.data;
  }

  private async getAllOperatorUsers() {
    const limit = 200;
    let page = 1;
    let totalPages = 1;
    const items: Array<{
      id?: string;
      name?: string;
      username?: string;
      market_id?: string;
    }> = [];

    while (page <= totalPages) {
      const response = await rmqSend<any>(
        this.identityClient,
        { cmd: 'identity.user.find_all' },
        { query: { role: Roles.MARKET_OPERATOR, page, limit } },
      ).catch(() => null);

      const payload = response?.data ?? response ?? {};
      const batch = Array.isArray(payload?.items) ? payload.items : [];
      items.push(...batch);

      const pages = Number(payload?.meta?.totalPages ?? 1);
      totalPages = Number.isFinite(pages) && pages > 0 ? pages : 1;
      page += 1;
      if (page > 100) break;
    }

    return items;
  }

  private async getCashboxByUser(userId: string, cashboxType: Cashbox_type) {
    const response = await rmqSend<{ data?: { id: string; balance?: number } }>(
      this.financeClient,
      { cmd: 'finance.cashbox.find_by_user' },
      { user_id: userId, cashbox_type: cashboxType },
    ).catch(() => ({ data: undefined }));

    return response?.data;
  }

  /**
   * Resolve the non-HQ branch a sale should settle through, or null for HQ /
   * unknown. Branches are separate cash owners: COD collected by a branch's
   * courier rolls courier → branch → HQ. The branch a sale belongs to is where
   * custody currently sits (holder branch, falling back to the order branch).
   */
  private async resolveSettlementBranchId(order: {
    holder_branch_id?: string | null;
    branch_id?: string | null;
  }): Promise<string | null> {
    const branchId = String(
      order.holder_branch_id ?? order.branch_id ?? '',
    ).trim();
    if (!branchId) {
      return null;
    }
    const hqId = String((await this.getHqBranchId()) ?? '').trim();
    return branchId === hqId ? null : branchId;
  }

  /**
   * Ensure a branch's BRANCH-type cashbox exists before we post to it (the
   * finance balance update throws if the cashbox is missing). Idempotent — a
   * pre-existing cashbox returns an "already exists" error we deliberately
   * swallow.
   */
  private async ensureBranchCashbox(branchId: string): Promise<void> {
    await rmqSend(
      this.financeClient,
      { cmd: 'finance.cashbox.create' },
      { user_id: String(branchId), cashbox_type: Cashbox_type.BRANCH },
    ).catch(() => undefined);
  }

  /**
   * The per-order amount a branch KEEPS for a sold order: its configured
   * per_order_share when the branch is PARTNER-owned, otherwise 0 (OWNED
   * branches remit everything to HQ). Returns 0 for HQ / unknown branch.
   */
  private async resolveBranchShare(branchId: string | null): Promise<number> {
    if (!branchId) {
      return 0;
    }
    const res = await rmqSend<{
      data?: { ownership?: string; per_order_share?: number | string };
    }>(
      this.branchClient,
      { cmd: 'branch.find_by_id' },
      { id: String(branchId) },
    ).catch(() => ({ data: undefined }));
    const branch = res?.data;
    if (!branch || branch.ownership !== BranchOwnership.PARTNER) {
      return 0;
    }
    const share = Number(branch.per_order_share ?? 0);
    return Number.isFinite(share) && share > 0 ? share : 0;
  }

  /**
   * The per-order amount a courier KEEPS, per their compensation mode:
   * SALARY_ONLY keeps nothing (0); PER_ORDER / SALARY_PLUS_PER_ORDER keep the
   * configured tariff. Defaults to keeping the tariff when the mode is unknown
   * (back-compatible with couriers created before the mode existed).
   */
  private resolveCourierShare(
    courier: { compensation_mode?: string | null } | null | undefined,
    courierTariff: number,
  ): number {
    if (courier?.compensation_mode === CourierCompensationMode.SALARY_ONLY) {
      return 0;
    }
    return courierTariff;
  }

  private resolveSaleActorShare(
    isManagerSale: boolean,
    financialActor: { compensation_mode?: string | null } | null | undefined,
    tariff: number,
  ): number {
    return isManagerSale
      ? tariff
      : this.resolveCourierShare(financialActor, tariff);
  }

  private resolveBranchCashboxSaleAmount(
    totalPrice: number,
    branchPayable: number,
    isManagerSale: boolean,
  ): number {
    return isManagerSale ? totalPrice : branchPayable;
  }

  /**
   * Create/refresh the per-order settlement row at sale time (inside the sale
   * transaction). Status starts at PENDING, but legs with no participant are
   * auto-advanced: a branch-direct sale (no courier) starts COURIER_SETTLED
   * (cash already at the branch); an HQ-direct sale (no courier, no branch)
   * starts BRANCH_SETTLED (cash already at HQ). BRANCH_SETTLED uniformly means
   * "money has reached HQ" — the point past which rollback is forbidden.
   */
  private async recordSaleSettlement(
    manager: EntityManager,
    data: {
      order_id: string;
      courier_id: string | null;
      branch_id: string | null;
      market_id: string | null;
      courier_amount: number;
      branch_amount: number;
      market_amount: number;
      hasCourier: boolean;
    },
  ): Promise<void> {
    const repo = manager.getRepository(OrderSettlement);
    const isBranchSale = Boolean(data.branch_id);
    const now = new Date();

    let status = SettlementStatus.PENDING;
    let courier_to_branch_at: Date | null = null;
    let branch_to_hq_at: Date | null = null;
    if (!data.hasCourier) {
      courier_to_branch_at = now;
      if (isBranchSale) {
        status = SettlementStatus.COURIER_SETTLED;
      } else {
        status = SettlementStatus.BRANCH_SETTLED;
        branch_to_hq_at = now;
      }
    }

    const fields = {
      order_id: String(data.order_id),
      courier_id: data.courier_id ? String(data.courier_id) : null,
      branch_id: data.branch_id ? String(data.branch_id) : null,
      market_id: data.market_id ? String(data.market_id) : null,
      courier_amount: Math.max(data.courier_amount, 0),
      branch_amount: Math.max(data.branch_amount, 0),
      market_amount: Math.max(data.market_amount, 0),
      status,
      courier_to_branch_at,
      courier_to_branch_by: null,
      branch_to_hq_at,
      branch_to_hq_by: null,
      hq_to_market_at: null,
      hq_to_market_by: null,
      isDeleted: false,
    };

    const existing = await repo.findOne({
      where: { order_id: String(data.order_id) },
    });
    if (existing) {
      await repo.update({ id: existing.id }, fields);
    } else {
      await repo.save(repo.create(fields));
    }
  }

  /**
   * Whether an order's COD has reached HQ (the point past which a rollback is
   * forbidden). True once the row is BRANCH_SETTLED or MARKET_SETTLED.
   */
  private isSettledToHq(status?: SettlementStatus | null): boolean {
    return (
      status === SettlementStatus.BRANCH_SETTLED ||
      status === SettlementStatus.MARKET_SETTLED
    );
  }

  /**
   * Stable per-request dedup token for a money operation's cashbox legs.
   *
   * Derived from the caller's `request_id` (minted once per HTTP request at the
   * gateway) so an RMQ redelivery / idempotency-retry of the SAME operation
   * reuses the SAME `dedup_epoch`; finance's unique idempotency index then
   * collapses the duplicate and the cash is never posted twice — INDEPENDENTLY
   * of the controller-level idempotency cache (defense in depth).
   *
   * A genuinely new operation on the same order (e.g. a re-sell after a
   * rollback) arrives with a fresh `request_id` → a fresh epoch → it correctly
   * re-applies. The dedup tuple for a sell leg is
   * (cashbox, source_type, order_id, operation_type, dedup_epoch); for a re-sell
   * every field but the epoch is identical, so the epoch MUST differ between
   * attempts and MUST be stable across retries — exactly what request_id gives.
   *
   * Falls back to a wall-clock value ONLY when no request_id is supplied
   * (idempotency disabled), preserving the previous behaviour with no regression.
   * NOTE: this is the dedup discriminator only — it is NOT a timestamp. Use a
   * separate `Date.now()` value for `sold_at` (read as a number by analytics).
   */
  private resolveDedupEpoch(requestId?: string): string {
    const id = String(requestId ?? '').trim();
    return id.length > 0 ? `req:${id}` : String(Date.now());
  }

  /**
   * Path A retired (Faza 2b). The legacy `order.settlement.{courier_to_branch,
   * branch_to_hq,hq_to_market}` handlers used to MOVE cashbox money themselves
   * (posting legs keyed by source_id = order_id, no dedup_epoch). That
   * duplicated the production `finance.cashbox.payment_*` path (which posts legs
   * keyed by source_id = actor_id + a dedup token) — different keys, so finance's
   * idempotency index could NOT collapse them and one physical handover posted
   * twice (double-debit). Cash now moves ONLY through the finance payment
   * endpoints, which advance the per-order settlement ledger via the
   * transactional outbox (Faza 2a). These endpoints are disabled so the two
   * money-movers can never both run for the same handover.
   */
  private deprecatedSettlementPath(level: string): never {
    this.badRequest(
      `order.settlement.${level} endi qo'llab-quvvatlanmaydi (Faza 2b): ` +
        `pul faqat cashbox to'lov endpointlari orqali ko'chiriladi, ular ` +
        `settlement'ni outbox orqali avtomatik advance qiladi.`,
    );
  }

  /**
   * Reset an order's settlement row on rollback (it returns to an unsold state).
   * Only callable while the order has NOT reached HQ (guarded by the caller).
   */
  private async resetSettlementOnRollback(
    manager: EntityManager,
    orderId: string,
  ): Promise<void> {
    const repo = manager.getRepository(OrderSettlement);
    await repo
      .createQueryBuilder()
      .update(OrderSettlement)
      .set({
        status: SettlementStatus.PENDING,
        courier_to_branch_at: null,
        courier_to_branch_by: null,
        branch_to_hq_at: null,
        branch_to_hq_by: null,
        hq_to_market_at: null,
        hq_to_market_by: null,
        courier_amount: 0,
        branch_amount: 0,
        market_amount: 0,
        isDeleted: true,
      })
      .where('order_id = :orderId', { orderId: String(orderId) })
      .execute();
  }

  /**
   * Lock an order row FOR UPDATE inside a transaction and assert it is still in
   * WAITING before any money is posted. Serializes concurrent sell/cancel/
   * partly-sell on the same order and makes a redelivered RMQ message a no-op
   * (the WAITING→terminal status flip is the idempotency key). (Audit P0-2.)
   */
  private async lockWaitingOrder(
    tx: EntityManager,
    orderId: string,
  ): Promise<void> {
    const locked = await tx.getRepository(Order).findOne({
      where: { id: String(orderId) },
      lock: { mode: 'pessimistic_write' },
    });
    if (!locked || locked.status !== Order_status.WAITING) {
      this.badRequest('Order not found or not in waiting status');
    }
  }

  private async updateCashboxBalance(
    data: {
      user_id: string;
      cashbox_type: Cashbox_type;
      amount: number;
      operation_type: Operation_type;
      source_type: Source_type;
      source_id?: string;
      source_user_id?: string;
      comment?: string;
      created_by?: string;
      proof_files?: string[];
      // Per-attempt idempotency token (see CashboxHistory.dedup_epoch). Set by
      // sell/partly-sell/cancel/rollback so a sell → rollback → sell cycle
      // re-applies money instead of being deduped against the prior attempt.
      dedup_epoch?: string;
    },
    manager?: EntityManager,
  ) {
    if (data.amount <= 0) {
      return;
    }

    await this.outbox.enqueue(
      'FINANCE',
      'finance.cashbox.update_balance',
      { ...data, payment_method: PaymentMethod.CASH },
      { manager },
    );
  }

  /**
   * Compute which proof conditions a given sell/cancel operation satisfies.
   * The market's enabled set is checked against this; any overlap → proof
   * required. Extend here (plus the ExpenseProofCondition enum) to add new
   * situations.
   */
  private matchExpenseProofConditions(ctx: {
    action: 'sell' | 'cancel';
    extraCost: number;
    totalPrice: number;
  }): Set<ExpenseProofCondition> {
    const matched = new Set<ExpenseProofCondition>();
    const hasExtra = ctx.extraCost > 0;
    const isZeroTotal = !(ctx.totalPrice > 0);

    if (ctx.action === 'cancel') {
      matched.add(ExpenseProofCondition.CANCEL_ANY);
      if (hasExtra) matched.add(ExpenseProofCondition.CANCEL_EXTRA_COST);
      if (isZeroTotal) matched.add(ExpenseProofCondition.CANCEL_ZERO_TOTAL);
    } else {
      // partly-sell is a sell variant → uses SELL_* conditions
      matched.add(ExpenseProofCondition.SELL_ANY);
      if (hasExtra) matched.add(ExpenseProofCondition.SELL_EXTRA_COST);
      if (isZeroTotal) matched.add(ExpenseProofCondition.SELL_ZERO_TOTAL);
    }
    return matched;
  }

  /**
   * Enforce a market's configurable proof policy for a sell/cancel operation.
   * If the operation matches ANY proof condition the market enabled, the courier
   * MUST attach valid file proof (image/video) — each submitted key must point
   * to a really-uploaded object (so a fabricated key can't satisfy it). Returns
   * the validated, de-duplicated proof keys to persist on the order (and on the
   * expense row, when one exists).
   *
   * Throws (rejecting the whole operation) when proof is required but missing or
   * invalid, per product decision: no proof → no operation.
   */
  private async enforceOperationProof(params: {
    market?: { expense_proof_conditions?: ExpenseProofCondition[] | null };
    action: 'sell' | 'cancel';
    extraCost: number;
    totalPrice: number;
    proofFileKeys?: string[];
    forceRequired?: boolean;
    proofFileKeysVerified?: boolean;
  }): Promise<string[]> {
    const {
      market,
      action,
      extraCost,
      totalPrice,
      proofFileKeys,
      forceRequired = false,
      proofFileKeysVerified = false,
    } = params;

    const keys = Array.from(
      new Set(
        (proofFileKeys ?? [])
          .map((k) => String(k ?? '').trim())
          .filter((k) => k.length > 0),
      ),
    );

    const enabled = Array.isArray(market?.expense_proof_conditions)
      ? market!.expense_proof_conditions!
      : [];
    if (enabled.length === 0 && !forceRequired) {
      // Market never requires proof; still persist any keys the courier sent.
      return keys;
    }

    const matched = this.matchExpenseProofConditions({
      action,
      extraCost,
      totalPrice,
    });
    const required = forceRequired || enabled.some((c) => matched.has(c));
    if (!required) {
      return keys;
    }

    if (keys.length === 0) {
      this.badRequest(
        'Bu amal uchun rasm yoki video isbot majburiy. Iltimos, isbot fayl(lar)ini biriktiring.',
      );
    }

    if (!proofFileKeysVerified) {
      // Verify every key actually points to an uploaded object.
      const checks = await Promise.all(
        keys.map((key) =>
          rmqSend<{ data?: { exists?: boolean } }>(
            this.fileClient,
            { cmd: 'file.exists' },
            { key },
          )
            .then((res) => Boolean(res?.data?.exists))
            .catch(() => false),
        ),
      );
      if (checks.some((ok) => !ok)) {
        this.badRequest(
          'Isbot fayl topilmadi yoki yuklanmagan. Iltimos, isbotni qaytadan yuklang.',
        );
      }
    }

    return keys;
  }

  /**
   * Enqueue finance events triggered by an order's status change. Called from
   * the central status-change path (writeOrderChanges) inside its transaction,
   * so every event is durable iff the order change commits.
   *
   * On entering a sold state (SOLD/PAID/PARTLY_PAID):
   *   - operator commission earning (only if the order has an operator)
   *   - SELL_PROFIT ledger entry (market_tariff - courier_tariff), always
   * On rollback to WAITING:
   *   - operator earning removal
   *
   * finance-service dedupes both on order_id, so re-delivery or a status
   * bounce is safe. We deliberately do NOT auto-reverse SELL_PROFIT on
   * rollback — the ledger is append-only and the SELL_PROFIT row is recorded
   * once per order; an operator can post a manual CORRECTION if a confirmed
   * sale is undone.
   */
  private async enqueueFinanceOnStatusChange(
    order: Order,
    oldStatus: Order_status,
    manager: EntityManager,
  ): Promise<void> {
    const soldStates = [
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
    ];
    const enteredSold =
      soldStates.includes(order.status) && !soldStates.includes(oldStatus);
    const leftSold =
      order.status === Order_status.WAITING && soldStates.includes(oldStatus);

    if (enteredSold) {
      if (order.operator_id) {
        await this.outbox.enqueue(
          'FINANCE',
          'finance.operator.earning.record',
          {
            order_id: String(order.id),
            operator_id: String(order.operator_id),
            market_id: order.market_id ? String(order.market_id) : null,
            total_price: Number(order.total_price ?? 0),
          },
          { manager },
        );
      }

      // Company (HQ) profit on this order = market tariff minus what the courier
      // keeps minus what a PARTNER branch keeps. Shares are snapshotted at sale;
      // fall back to the tariff for the courier when no share was recorded.
      const courierShareSnap = Number(
        order.courier_share ?? order.courier_tariff ?? 0,
      );
      const branchShareSnap = Number(order.branch_share ?? 0);
      const sellProfit =
        Number(order.market_tariff ?? 0) - courierShareSnap - branchShareSnap;
      if (sellProfit !== 0) {
        await this.outbox.enqueue(
          'FINANCE',
          'finance.financial_balance.record',
          {
            amount: sellProfit,
            source_type: 'sell_profit',
            order_id: String(order.id),
            related_user_id: order.market_id ? String(order.market_id) : null,
            comment: `Order #${order.id} sell profit`,
          },
          { manager },
        );
      }
    } else if (leftSold && order.operator_id) {
      await this.outbox.enqueue(
        'FINANCE',
        'finance.operator.earning.remove',
        { order_id: String(order.id) },
        { manager },
      );
    }
  }

  private hasRole(requester: { roles?: string[] } | undefined, role: Roles) {
    return (requester?.roles ?? []).some(
      (item) => String(item).toLowerCase() === String(role).toLowerCase(),
    );
  }

  /**
   * Normalize a courier id, treating the '0' sentinel (and blanks) as "no
   * courier". Unassigned posts are created with courier_id='0' (see
   * logistics-service), and '0' is truthy in JS — without this, an unassigned
   * order would resolve its actor courier to the non-existent user '0', so the
   * courier-side cashbox movement was silently skipped and the SELL_PROFIT
   * ledger over/under-counted. Normalizing lets the manager fallback take over.
   */
  private normalizeCourierId(value?: string | null): string {
    const normalized = String(value ?? '').trim();
    return normalized === '0' ? '' : normalized;
  }

  private resolveActorCourierId(
    requester: { id: string; roles?: string[]; branch_id?: string | null },
    order: {
      branch_id?: string | null;
      holder_branch_id?: string | null;
      courier_id?: string | null;
      holder_courier_id?: string | null;
    },
    post: { courier_id?: string | null } | null | undefined,
  ): string {
    const isSuperAdmin = this.hasRole(requester, Roles.SUPERADMIN);
    const isCourier = this.hasRole(requester, Roles.COURIER);
    const isManager = this.hasRole(requester, Roles.MANAGER);
    const postCourierId = this.normalizeCourierId(post?.courier_id);
    const holderCourierId = this.normalizeCourierId(order?.holder_courier_id);
    const orderCourierId = this.normalizeCourierId(order?.courier_id);
    const resolvedCourierId =
      postCourierId || holderCourierId || orderCourierId;

    if (isCourier) {
      const requesterId = String(requester.id ?? '').trim();
      const isAssignedToRequester =
        requesterId &&
        (postCourierId === requesterId ||
          holderCourierId === requesterId ||
          orderCourierId === requesterId);

      if (!isAssignedToRequester) {
        this.badRequest('Order is not assigned to this courier');
      }
      return requesterId;
    }

    if (isManager) {
      const requesterBranchId = String(requester?.branch_id ?? '').trim();
      const orderHolderBranchId = String(order?.holder_branch_id ?? '').trim();
      const orderBranchId = String(order?.branch_id ?? '').trim();
      if (
        !requesterBranchId ||
        (requesterBranchId !== orderHolderBranchId &&
          requesterBranchId !== orderBranchId)
      ) {
        this.badRequest('Order is not assigned to this manager branch');
      }
      return resolvedCourierId || String(requester.id);
    }

    if (isSuperAdmin) {
      if (!resolvedCourierId) {
        this.badRequest('Order has no courier assigned');
      }
      return resolvedCourierId;
    }

    this.badRequest('Forbidden resource');
  }

  private async findLatestHistoryBySource(data: {
    user_id: string;
    source_type: Source_type;
    source_id: string;
  }) {
    const response = await rmqSend<{
      data?: { items?: Array<{ amount?: number; createdAt?: string }> };
    }>(
      this.financeClient,
      { cmd: 'finance.history.find_all' },
      {
        user_id: data.user_id,
        source_type: data.source_type,
        source_id: data.source_id,
        page: 1,
        limit: 1,
      },
    ).catch(() => ({ data: { items: [] } }));

    return response?.data?.items?.[0];
  }

  private isNearInTime(
    left?: string | Date | null,
    right?: string | Date | null,
    maxDiffMs = 5000,
  ) {
    if (!left || !right) {
      return false;
    }

    const leftTime = new Date(left).getTime();
    const rightTime = new Date(right).getTime();

    if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
      return false;
    }

    return Math.abs(leftTime - rightTime) <= maxDiffMs;
  }

  /** Return the per-order settlement row (status + leg stamps) for one order. */
  async getSettlementByOrderId(orderId: string) {
    const id = String(orderId ?? '').trim();
    if (!id) {
      this.badRequest('order id is required');
    }
    const settlement = await this.orderSettlementRepo.findOne({
      where: { order_id: id },
    });
    return successRes(settlement ?? null, 200, 'Order settlement');
  }

  async getFinancialBalanceSettlementSummary() {
    const activeStatuses = [
      SettlementStatus.PENDING,
      SettlementStatus.COURIER_SETTLED,
      SettlementStatus.BRANCH_SETTLED,
    ];
    const branchReceivableStatuses = [
      SettlementStatus.PENDING,
      SettlementStatus.COURIER_SETTLED,
    ];

    const [branchRows, marketRows] = await Promise.all([
      this.orderSettlementRepo
        .createQueryBuilder('settlement')
        .select('settlement.branch_id', 'branch_id')
        .addSelect('COALESCE(SUM(settlement.branch_amount), 0)', 'amount')
        .where('settlement.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('settlement.branch_id IS NOT NULL')
        .andWhere('settlement.status IN (:...statuses)', {
          statuses: branchReceivableStatuses,
        })
        .groupBy('settlement.branch_id')
        .getRawMany<{ branch_id: string; amount: string }>(),
      this.orderSettlementRepo
        .createQueryBuilder('settlement')
        .select('settlement.market_id', 'market_id')
        .addSelect('COALESCE(SUM(settlement.market_amount), 0)', 'amount')
        .where('settlement.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('settlement.market_id IS NOT NULL')
        .andWhere('settlement.status IN (:...statuses)', {
          statuses: activeStatuses,
        })
        .groupBy('settlement.market_id')
        .getRawMany<{ market_id: string; amount: string }>(),
    ]);

    const branches = branchRows.map((row) => ({
      branch_id: String(row.branch_id),
      amount: Math.max(Number(row.amount) || 0, 0),
    }));
    const markets = marketRows.map((row) => ({
      market_id: String(row.market_id),
      amount: Math.max(Number(row.amount) || 0, 0),
    }));

    return successRes(
      {
        branch_receivable: branches.reduce((sum, row) => sum + row.amount, 0),
        market_payable: markets.reduce((sum, row) => sum + row.amount, 0),
        branches,
        markets,
      },
      200,
      'Financial balance settlement summary',
    );
  }

  private static readonly MAIN_CASHBOX_USER_ID = '0';

  /** Ensure the singleton MAIN (HQ) cashbox exists before posting to it. */
  private async ensureMainCashbox(): Promise<void> {
    await rmqSend(
      this.financeClient,
      { cmd: 'finance.cashbox.create' },
      {
        user_id: OrderServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
      },
    ).catch(() => undefined);
  }

  /**
   * FIFO-allocate a lump-sum settlement payment to the oldest unsettled orders
   * for one participant, advancing each fully-covered order to the next leg and
   * posting its cashbox movements (atomic with the status update via outbox).
   * Whole-order allocation: an order is only settled when the remaining lump-sum
   * covers its full leg amount; the unallocated remainder is reported back.
   */
  private async runFifoSettlement(params: {
    matchColumn: 'courier_id' | 'branch_id' | 'market_id';
    matchValue: string;
    fromStatus: SettlementStatus;
    toStatus: SettlementStatus;
    amountField: 'courier_amount' | 'branch_amount' | 'market_amount';
    lumpSum: number;
    requesterId: string;
    postLeg: (
      manager: EntityManager,
      settlement: OrderSettlement,
      amount: number,
    ) => Promise<void>;
    stamp: (now: Date) => Partial<OrderSettlement>;
  }): Promise<{
    settled_order_ids: string[];
    allocated: number;
    leftover: number;
  }> {
    const lumpSum = Math.max(Number(params.lumpSum) || 0, 0);
    if (!params.matchValue || lumpSum <= 0) {
      return { settled_order_ids: [], allocated: 0, leftover: lumpSum };
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    const settledOrderIds: string[] = [];
    let allocated = 0;
    try {
      const tx = queryRunner.manager;
      const repo = tx.getRepository(OrderSettlement);
      const candidates = await repo.find({
        where: {
          [params.matchColumn]: params.matchValue,
          status: params.fromStatus,
          isDeleted: false,
        } as Record<string, unknown>,
        order: { createdAt: 'ASC' },
      });

      let remaining = lumpSum;
      const now = new Date();
      for (const settlement of candidates) {
        const legAmount = Math.max(
          Number(settlement[params.amountField] ?? 0),
          0,
        );
        // Strict FIFO (Faza 4 / Audit I16): if the OLDEST still-unsettled order's
        // leg does not fully fit in the remaining lump-sum, STOP — never skip
        // ahead to settle a newer, smaller order before an older one. Skipping
        // violates oldest-first accounting and lets a deliberate resubmit
        // over-allocate to the next orders. Zero-amount legs (nothing owed at
        // this hop) still advance for free without consuming the lump-sum.
        if (legAmount > remaining && legAmount > 0) {
          break;
        }
        await repo.update(
          { id: settlement.id },
          { status: params.toStatus, ...params.stamp(now) },
        );
        if (legAmount > 0) {
          await params.postLeg(tx, settlement, legAmount);
          remaining -= legAmount;
          allocated += legAmount;
        }
        settledOrderIds.push(String(settlement.order_id));
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof RpcException) {
        throw error;
      }
      this.handleDbError(error);
      throw new RpcException({
        statusCode: 500,
        message:
          error instanceof Error ? error.message : 'Internal server error',
      });
    } finally {
      await queryRunner.release();
    }

    return {
      settled_order_ids: settledOrderIds,
      allocated,
      leftover: Math.max(lumpSum - allocated, 0),
    };
  }

  /**
   * Advance the per-order FIFO settlement ledger WITHOUT posting any cashbox leg.
   * The production cash path (finance.cashbox.payment_courier/branch_to_main/
   * market) already moves the cashbox balances; this keeps order_settlement in
   * lock-step so that (a) the settlement-aware rollback guard (isSettledToHq)
   * actually reflects real-world cash position in production, and (b) the legacy
   * order.settlement.* cashbox path becomes a no-op for already-advanced rows
   * (its candidates are filtered by fromStatus), so the two paths can never
   * double-post the same handover. (Audit I1/I2.)
   */
  async advanceSettlement(data: {
    level: 'courier_to_branch' | 'branch_to_hq' | 'hq_to_market';
    match_value: string;
    amount: number;
    requester_id?: string;
  }) {
    const requesterId = String(data?.requester_id ?? 'system');
    const matchValue = String(data?.match_value ?? '').trim();
    const amount = Number(data?.amount ?? 0);
    if (!matchValue || !(amount > 0)) {
      return successRes(
        { settled_order_ids: [], allocated: 0, leftover: amount },
        200,
        'No settlement to advance',
      );
    }

    // State-only: the cashbox was already moved by the finance payment path.
    const noPost = async (): Promise<void> => {};

    const configs = {
      courier_to_branch: {
        matchColumn: 'courier_id' as const,
        fromStatus: SettlementStatus.PENDING,
        toStatus: SettlementStatus.COURIER_SETTLED,
        amountField: 'courier_amount' as const,
        stamp: (now: Date) => ({
          courier_to_branch_at: now,
          courier_to_branch_by: requesterId,
        }),
      },
      branch_to_hq: {
        matchColumn: 'branch_id' as const,
        fromStatus: SettlementStatus.COURIER_SETTLED,
        toStatus: SettlementStatus.BRANCH_SETTLED,
        amountField: 'branch_amount' as const,
        stamp: (now: Date) => ({
          branch_to_hq_at: now,
          branch_to_hq_by: requesterId,
        }),
      },
      hq_to_market: {
        matchColumn: 'market_id' as const,
        fromStatus: SettlementStatus.BRANCH_SETTLED,
        toStatus: SettlementStatus.MARKET_SETTLED,
        amountField: 'market_amount' as const,
        stamp: (now: Date) => ({
          hq_to_market_at: now,
          hq_to_market_by: requesterId,
        }),
      },
    };
    const cfg = configs[data.level];
    if (!cfg) {
      this.badRequest(`Invalid settlement level: ${String(data?.level)}`);
    }

    const result = await this.runFifoSettlement({
      matchColumn: cfg.matchColumn,
      matchValue,
      fromStatus: cfg.fromStatus,
      toStatus: cfg.toStatus,
      amountField: cfg.amountField,
      lumpSum: amount,
      requesterId,
      postLeg: noPost,
      stamp: cfg.stamp,
    });
    return successRes(result, 200, 'Settlement advanced');
  }

  /**
   * Courier hands a lump sum to the branch — FIFO-settles the courier's oldest
   * PENDING orders (courier → branch). Only reduces the courier's owed balance;
   * the branch was already credited at sale time.
   */
  async settleCourierToBranch(
    _requester: { id: string; roles?: string[] },
    _dto: { courier_id: string; amount: number },
  ) {
    return this.deprecatedSettlementPath('courier_to_branch');
  }

  /**
   * Branch remits a lump sum to HQ — FIFO-settles the branch's oldest
   * COURIER_SETTLED orders (branch → HQ): branch owed-balance down, MAIN up.
   */
  async settleBranchToHq(
    _requester: { id: string; roles?: string[] },
    _dto: { branch_id: string; amount: number },
  ) {
    return this.deprecatedSettlementPath('branch_to_hq');
  }

  /**
   * HQ pays a market a lump sum — FIFO-settles the market's oldest
   * BRANCH_SETTLED orders (HQ → market): MAIN down, market owed-balance down.
   */
  async settleHqToMarket(
    _requester: { id: string; roles?: string[] },
    _dto: { market_id: string; amount: number },
  ) {
    return this.deprecatedSettlementPath('hq_to_market');
  }

  async rollbackOrderToWaiting(
    requester: { id: string; roles?: string[]; branch_id?: string | null },
    id: string,
    dto?: { target_status?: 'waiting' | 'cancelled' | 'cancelled_sent' },
    requestId?: string,
  ) {
    const rollbackTarget = String(dto?.target_status ?? 'waiting')
      .trim()
      .toLowerCase() as 'waiting' | 'cancelled' | 'cancelled_sent';
    if (!['waiting', 'cancelled', 'cancelled_sent'].includes(rollbackTarget)) {
      this.badRequest(
        `Invalid rollback target: ${String(dto?.target_status ?? '')}`,
      );
    }

    const isManagerRequester =
      this.hasRole(requester, Roles.MANAGER) &&
      !this.hasRole(requester, Roles.COURIER);
    const order = await this.findById(id);
    const originalStatus = order.status;
    const isSuperAdmin = this.hasRole(requester, Roles.SUPERADMIN);
    const isCourier = this.hasRole(requester, Roles.COURIER);
    const isManager = this.hasRole(requester, Roles.MANAGER);

    if (rollbackTarget === 'cancelled_sent' && !isCourier) {
      this.badRequest(
        'cancelled_sent rollback faqat courier uchun ruxsat etilgan',
      );
    }

    if (
      isCourier &&
      ![Order_status.SOLD, Order_status.CANCELLED].includes(order.status)
    ) {
      this.badRequest(`Rollback mumkin emas (status: ${order.status})`);
    }

    if (
      isSuperAdmin &&
      ![
        Order_status.SOLD,
        Order_status.CANCELLED,
        Order_status.CLOSED,
        Order_status.PAID,
        Order_status.PARTLY_PAID,
      ].includes(order.status)
    ) {
      this.badRequest(`Rollback mumkin emas (status: ${order.status})`);
    }

    if (!isCourier && !isSuperAdmin && !isManager) {
      this.badRequest('Rollback uchun ruxsat yo‘q');
    }

    // Merge note (dev↔shodiyor): post is optional (a manager can roll back an
    // order that isn't on a courier post yet), but a courier may only roll back
    // a post assigned to them. Both actor checks are kept.
    const rollbackPostRes = order.post_id
      ? await rmqSend<{ data?: { id: string; courier_id?: string | null } }>(
          this.logisticsClient,
          { cmd: 'logistics.post.find_by_id' },
          { id: String(order.post_id) },
        ).catch(() => ({ data: undefined }))
      : { data: undefined };
    const post = rollbackPostRes?.data;

    if (
      isCourier &&
      !isSuperAdmin &&
      String(post?.courier_id ?? '') !== String(requester.id)
    ) {
      this.badRequest('Order is not assigned to this courier');
    }

    if (isManager && !isSuperAdmin) {
      const requesterBranchId = String(requester?.branch_id ?? '').trim();
      const orderHolderBranchId = String(order?.holder_branch_id ?? '').trim();
      const orderBranchId = String(order?.branch_id ?? '').trim();
      if (
        !requesterBranchId ||
        (requesterBranchId !== orderHolderBranchId &&
          requesterBranchId !== orderBranchId)
      ) {
        this.badRequest('Order is not assigned to this manager branch');
      }
    }

    // Settlement-aware guard: a branch/courier may roll back only while the
    // order's COD has NOT yet reached HQ. Once branch→HQ is settled the money
    // has moved up the chain and the order must not be reverted here.
    const existingSettlement = await this.orderSettlementRepo.findOne({
      where: { order_id: String(id), isDeleted: false },
    });
    if (existingSettlement && this.isSettledToHq(existingSettlement.status)) {
      this.badRequest(
        "Bu buyurtma summasi bosh ofisga to'langan — rollback mumkin emas",
      );
    }

    const courierId = this.resolveActorCourierId(requester, order, post);
    if (!courierId) {
      this.notFound('Courier not found');
    }

    const [market, financialActor] = await Promise.all([
      this.getMarketsByIds([String(order.market_id)]).then((rows) => rows[0]),
      isManagerRequester
        ? this.getUserById(String(requester.id))
        : this.getCouriersByIds([courierId]).then((rows) => rows[0]),
    ]);
    if (!market) {
      this.notFound('Market not found');
    }
    if (!financialActor) {
      this.notFound(
        isManagerRequester ? 'Manager not found' : 'Courier not found',
      );
    }

    const [marketCashbox, courierCashbox] = await Promise.all([
      this.getCashboxByUser(String(order.market_id), Cashbox_type.FOR_MARKET),
      isManagerRequester
        ? Promise.resolve(null)
        : this.getCashboxByUser(courierId, Cashbox_type.FOR_COURIER).catch(
            () => null,
          ),
    ]);
    if (!marketCashbox) {
      this.notFound('Market cashbox not found');
    }
    if (!courierCashbox && !isManagerRequester) {
      this.notFound('Courier cashbox not found');
    }

    // Prefer the tariffs snapshotted on the order at sale time so the reversal
    // mirrors the original sale exactly, even if the market/courier tariff has
    // since changed. Fall back to live tariffs for orders sold before snapshots
    // were recorded.
    const marketTariff =
      order.market_tariff != null
        ? Number(order.market_tariff)
        : order.where_deliver === Where_deliver.CENTER
          ? Number(market.tariff_center ?? 0)
          : Number(market.tariff_home ?? 0);
    const courierTariff =
      order.courier_tariff != null
        ? Number(order.courier_tariff)
        : order.where_deliver === Where_deliver.CENTER
          ? Number(financialActor?.tariff_center ?? 0)
          : Number(financialActor?.tariff_home ?? 0);
    const rollbackComment = `[ROLLBACK] ${order.comment || ''}`.trim();
    const totalPrice = Number(order.total_price ?? 0);
    const actorExpenseUserId = isManagerRequester
      ? String(requester.branch_id ?? '')
      : courierId;
    const actorExpenseCashboxType = isManagerRequester
      ? Cashbox_type.BRANCH
      : Cashbox_type.FOR_COURIER;
    if (isManagerRequester && !actorExpenseUserId) {
      this.badRequest('Manager branch not found');
    }
    if (isManagerRequester) {
      await this.ensureBranchCashbox(actorExpenseUserId);
    }
    const actorExpenseCashbox = isManagerRequester
      ? await this.getCashboxByUser(
          actorExpenseUserId,
          Cashbox_type.BRANCH,
        ).catch(() => null)
      : courierCashbox;
    const [marketExtraCost, courierExtraCost] = await Promise.all([
      this.findLatestHistoryBySource({
        user_id: String(order.market_id),
        source_type: Source_type.EXTRA_COST,
        source_id: String(order.id),
      }),
      this.findLatestHistoryBySource({
        user_id: actorExpenseUserId,
        source_type: Source_type.EXTRA_COST,
        source_id: String(order.id),
      }),
    ]);

    const soldAt = order.sold_at ? Number(order.sold_at) : NaN;
    const orderUpdatedAt = order.updatedAt ? new Date(order.updatedAt) : null;
    const marketExtraCostCreatedAt = marketExtraCost?.createdAt ?? null;
    const courierExtraCostCreatedAt = courierExtraCost?.createdAt ?? null;
    const shouldRollbackMarketExtraCost =
      !!marketExtraCost &&
      Number(marketExtraCost.amount ?? 0) > 0 &&
      ([
        Order_status.SOLD,
        Order_status.PAID,
        Order_status.PARTLY_PAID,
      ].includes(originalStatus)
        ? Number.isFinite(soldAt) &&
          this.isNearInTime(new Date(soldAt), marketExtraCostCreatedAt)
        : [Order_status.CANCELLED, Order_status.CLOSED].includes(originalStatus)
          ? this.isNearInTime(orderUpdatedAt, marketExtraCostCreatedAt)
          : false);
    const shouldRollbackCourierExtraCost =
      !!courierExtraCost &&
      Number(courierExtraCost.amount ?? 0) > 0 &&
      ([
        Order_status.SOLD,
        Order_status.PAID,
        Order_status.PARTLY_PAID,
      ].includes(originalStatus)
        ? Number.isFinite(soldAt) &&
          this.isNearInTime(new Date(soldAt), courierExtraCostCreatedAt)
        : [Order_status.CANCELLED, Order_status.CLOSED].includes(originalStatus)
          ? this.isNearInTime(orderUpdatedAt, courierExtraCostCreatedAt)
          : false);

    // Atomic rollback (Audit P0-1/P0-2). Previously the cashbox reversals,
    // settlement reset, and status flip ran WITHOUT a transaction, so a
    // mid-rollback crash could leave cashboxes reversed while the order stayed
    // SOLD (split state), and a redelivered/concurrent call could double-reverse.
    // Now everything commits together, under a row lock, with an in-transaction
    // status re-check that makes the reversal idempotent.
    // Stable per-request dedup token: a redelivery / retry of THIS rollback
    // reuses the same epoch so finance dedupes the correction legs; the
    // per-leg `:seq` suffix keeps the multiple reversal legs distinct.
    const rollbackEpoch = this.resolveDedupEpoch(requestId);
    let rollbackSeq = 0;
    let finalStatus: Order_status = Order_status.WAITING;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const tx = queryRunner.manager;

      // Lock the order row and re-assert it is still in the state we validated
      // against. A concurrent sell/cancel/rollback (or a redelivered RMQ
      // message) blocks here, then fails this guard — so the reversal is applied
      // at most once (the status transition is the idempotency key).
      const locked = await tx.getRepository(Order).findOne({
        where: { id: String(order.id) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || locked.status !== originalStatus) {
        this.badRequest(
          `Rollback holati o'zgargan (status: ${locked?.status ?? "yo'q"})`,
        );
      }

      // Per-rollback idempotency epoch on every CORRECTION posting: a second
      // rollback of the same order (after a re-sell) is not deduped against the
      // first; a per-posting sequence suffix avoids in-run index collisions.
      const pay = (
        data: Parameters<typeof this.updateCashboxBalance>[0],
      ): Promise<void> =>
        this.updateCashboxBalance(
          { ...data, dedup_epoch: `${rollbackEpoch}:${rollbackSeq++}` },
          tx,
        );

      if (
        [
          Order_status.SOLD,
          Order_status.PAID,
          Order_status.PARTLY_PAID,
        ].includes(originalStatus)
      ) {
        if (shouldRollbackMarketExtraCost) {
          await pay({
            user_id: String(order.market_id),
            cashbox_type: Cashbox_type.FOR_MARKET,
            amount: Number(marketExtraCost?.amount ?? 0),
            operation_type: Operation_type.INCOME,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: "Qo'shimcha xarajat orqaga qaytarildi",
          });
        }

        if (shouldRollbackCourierExtraCost && actorExpenseCashbox) {
          await pay({
            user_id: actorExpenseUserId,
            cashbox_type: actorExpenseCashboxType,
            amount: Number(courierExtraCost?.amount ?? 0),
            operation_type: Operation_type.INCOME,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: "Qo'shimcha xarajat orqaga qaytarildi",
          });
        }

        const rolledBackExtraCost = Math.max(
          shouldRollbackMarketExtraCost
            ? Number(marketExtraCost?.amount ?? 0)
            : 0,
          shouldRollbackCourierExtraCost
            ? Number(courierExtraCost?.amount ?? 0)
            : 0,
        );
        if (rolledBackExtraCost > 0) {
          await this.outbox.enqueue(
            'FINANCE',
            'finance.financial_balance.record',
            {
              amount: rolledBackExtraCost,
              source_type: 'correction',
              order_id: String(order.id),
              related_user_id: order.market_id ? String(order.market_id) : null,
              comment: `Order #${order.id} extra cost rollback`,
            },
            { manager: tx },
          );
        }
      }

      // Reverse the sale's cashbox legs EXACTLY (decoupled, snapshot-based) — the
      // mirror image of the 3-leg sale model:
      //   market : reverse (total − marketTariff)
      //   courier: reverse (total − courierShare)
      //   branch : reverse the exact amount credited to its cashbox at sale time
      // Applies to SOLD/PAID always, and PARTLY_PAID for superadmin.
      const doSaleReversal =
        [Order_status.SOLD, Order_status.PAID].includes(originalStatus) ||
        (originalStatus === Order_status.PARTLY_PAID && isSuperAdmin);
      if (doSaleReversal) {
        const courierShareRb =
          order.courier_share != null
            ? Number(order.courier_share)
            : courierTariff;
        const branchShareRb =
          order.branch_share != null ? Number(order.branch_share) : 0;

        const saleMarketIncome = Math.max(totalPrice - marketTariff, 0);
        const saleMarketExpense = Math.max(marketTariff - totalPrice, 0);
        const saleCourierIncome = Math.max(totalPrice - courierShareRb, 0);
        const saleCourierExpense = Math.max(courierShareRb - totalPrice, 0);
        const saleBranchNet = totalPrice - courierShareRb - branchShareRb;
        const saleBranchCashboxAmount =
          order.branch_cashbox_amount != null
            ? Number(order.branch_cashbox_amount)
            : saleBranchNet;

        const rbBranchId = await this.resolveSettlementBranchId(order);
        if (rbBranchId) {
          await this.ensureBranchCashbox(rbBranchId);
        }
        const rbBranchCashbox = rbBranchId
          ? await this.getCashboxByUser(rbBranchId, Cashbox_type.BRANCH).catch(
              () => null,
            )
          : null;

        // market leg (reverse)
        if (saleMarketIncome > 0) {
          await pay({
            user_id: String(order.market_id),
            cashbox_type: Cashbox_type.FOR_MARKET,
            amount: saleMarketIncome,
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: rollbackComment,
          });
        } else if (saleMarketExpense > 0) {
          await pay({
            user_id: String(order.market_id),
            cashbox_type: Cashbox_type.FOR_MARKET,
            amount: saleMarketExpense,
            operation_type: Operation_type.INCOME,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: rollbackComment,
          });
        }

        // courier leg (reverse)
        if (courierCashbox) {
          if (saleCourierIncome > 0) {
            await pay({
              user_id: courierId,
              cashbox_type: Cashbox_type.FOR_COURIER,
              amount: saleCourierIncome,
              operation_type: Operation_type.EXPENSE,
              source_type: Source_type.CORRECTION,
              source_id: String(order.id),
              created_by: String(requester.id),
              comment: rollbackComment,
            });
          } else if (saleCourierExpense > 0) {
            await pay({
              user_id: courierId,
              cashbox_type: Cashbox_type.FOR_COURIER,
              amount: saleCourierExpense,
              operation_type: Operation_type.INCOME,
              source_type: Source_type.CORRECTION,
              source_id: String(order.id),
              created_by: String(requester.id),
              comment: rollbackComment,
            });
          }
        }

        // branch leg (reverse) — non-HQ branch only
        if (rbBranchCashbox && rbBranchId) {
          if (saleBranchCashboxAmount > 0) {
            await pay({
              user_id: rbBranchId,
              cashbox_type: Cashbox_type.BRANCH,
              amount: saleBranchCashboxAmount,
              operation_type: Operation_type.EXPENSE,
              source_type: Source_type.CORRECTION,
              source_id: String(order.id),
              created_by: String(requester.id),
              comment: rollbackComment,
            });
          } else if (saleBranchCashboxAmount < 0) {
            await pay({
              user_id: rbBranchId,
              cashbox_type: Cashbox_type.BRANCH,
              amount: -saleBranchCashboxAmount,
              operation_type: Operation_type.INCOME,
              source_type: Source_type.CORRECTION,
              source_id: String(order.id),
              created_by: String(requester.id),
              comment: rollbackComment,
            });
          }
        }
      }

      // The order is being reverted out of its sold state — clear its settlement
      // row (guaranteed not yet settled-to-HQ by the guard above), in the same tx.
      await this.resetSettlementOnRollback(tx, id);

      if (
        shouldRollbackMarketExtraCost &&
        [Order_status.CANCELLED, Order_status.CLOSED].includes(originalStatus)
      ) {
        await pay({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: Number(marketExtraCost.amount),
          operation_type: Operation_type.INCOME,
          source_type: Source_type.CORRECTION,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: [Order_status.CANCELLED, Order_status.CLOSED].includes(
            originalStatus,
          )
            ? "Bekor qilingan buyurtmaga yozilgan qo'shimcha xarajat orqaga qaytarildi"
            : "Qo'shimcha xarajat orqaga qaytarildi",
        });
      }

      if (
        shouldRollbackCourierExtraCost &&
        actorExpenseCashbox &&
        [Order_status.CANCELLED, Order_status.CLOSED].includes(originalStatus)
      ) {
        await pay({
          user_id: actorExpenseUserId,
          cashbox_type: actorExpenseCashboxType,
          amount: Number(courierExtraCost.amount),
          operation_type: Operation_type.INCOME,
          source_type: Source_type.CORRECTION,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: [Order_status.CANCELLED, Order_status.CLOSED].includes(
            originalStatus,
          )
            ? "Bekor qilingan buyurtmaga yozilgan qo'shimcha xarajat orqaga qaytarildi"
            : "Qo'shimcha xarajat orqaga qaytarildi",
        });
      }

      // Single final status write inside the transaction, then commit.
      if (
        rollbackTarget === 'cancelled' ||
        rollbackTarget === 'cancelled_sent'
      ) {
        finalStatus = Order_status.CANCELLED;
        await this.updateFull(
          id,
          {
            status: Order_status.CANCELLED,
            canceled_post_id: null,
            return_requested: false,
            sold_at: null,
          },
          {
            id: requester.id,
            roles: requester.roles,
            note: `Rollback to ${rollbackTarget}`,
            audit: false,
          },
          tx,
        );
      } else if (
        isSuperAdmin &&
        [Order_status.PAID, Order_status.PARTLY_PAID].includes(originalStatus)
      ) {
        finalStatus = Order_status.WAITING;
        await this.updateFull(
          id,
          { status: Order_status.WAITING, paid_amount: 0, sold_at: null },
          {
            id: requester.id,
            roles: requester.roles,
            note: 'Rollback to waiting',
            audit: false,
          },
          tx,
        );
      } else {
        finalStatus = Order_status.WAITING;
        await this.updateFull(
          id,
          { status: Order_status.WAITING, to_be_paid: 0, sold_at: null },
          {
            id: requester.id,
            roles: requester.roles,
            note: 'Rollback to waiting',
            audit: false,
          },
          tx,
        );
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof RpcException) {
        throw error;
      }
      this.handleDbError(error);
      throw new RpcException({
        statusCode: 500,
        message:
          error instanceof Error ? error.message : 'Internal server error',
      });
    } finally {
      await queryRunner.release();
    }

    // Post-commit side-effects (non-DB). The reversal + status flip are already
    // durable; these are best-effort follow-ups and must not roll back money.
    if (rollbackTarget === 'cancelled_sent') {
      await rmqSend(
        this.logisticsClient,
        { cmd: 'logistics.post.cancel.create' },
        {
          dto: { order_ids: [String(id)] },
          requester: { id: String(requester.id), roles: requester.roles ?? [] },
        },
      );
    }

    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: String(order.id),
      action: 'order.rollback',
      old_value: { status: originalStatus },
      new_value: { status: finalStatus },
      ...this.auditActor(requester),
      metadata: { rollback_target: rollbackTarget },
    });

    if (rollbackTarget === 'cancelled') {
      return successRes({}, 200, 'Order CANCELLED holatiga qaytarildi');
    }
    if (rollbackTarget === 'cancelled_sent') {
      return successRes({}, 200, "Order bekor qilinib pochtaga qo'shildi");
    }
    return successRes({}, 200, 'Order WAITING holatiga qaytarildi');
  }

  async initiateReturn(
    requester: { id: string; roles?: string[] },
    id: string,
    dto: { reason?: string },
  ) {
    const reason = String(dto?.reason ?? '').trim();
    if (!reason) {
      this.badRequest('reason is required');
    }

    const order = await this.findById(id);
    if (
      order.status === Order_status.SOLD ||
      order.status === Order_status.PAID ||
      order.status === Order_status.PARTLY_PAID ||
      order.status === Order_status.RETURNED_TO_MARKET ||
      order.status === Order_status.CLOSED ||
      order.status === Order_status.CANCELLED
    ) {
      this.badRequest("Bu holatdagi orderni qaytarishni boshlab bo'lmaydi");
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const orderRepo = queryRunner.manager.getRepository(Order);
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);

      order.return_reason = reason;
      order.return_requested = true;
      await orderRepo.save(order);

      await this.createTrackingEvent(
        {
          order_id: order.id,
          from_status: order.status,
          to_status: order.status,
          changed_by: String(requester?.id ?? 'system'),
          changed_by_role: requester?.id
            ? this.toTrackingRole(requester.roles)
            : 'system',
          note: `Return initiated: ${reason}`,
        },
        trackingRepo,
      );

      await this.syncOrderToSearch(order, queryRunner.manager);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.handleDbError(error);
    } finally {
      await queryRunner.release();
    }

    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: String(order.id),
      action: 'order.initiate_return',
      old_value: { return_requested: false },
      new_value: { return_requested: true, return_reason: reason },
      ...this.auditActor(requester),
      metadata: { status: order.status },
    });

    const updated = await this.findById(id);
    return successRes(updated, 200, 'Order return initiated');
  }

  async markReturnedToMarket(
    requester: { id: string; roles?: string[] },
    id: string,
  ) {
    const order = await this.findById(id);
    if (order.status === Order_status.RETURNED_TO_MARKET) {
      this.badRequest('Order allaqachon RETURNED_TO_MARKET holatida');
    }
    // A money-bearing order (COD collected) must be rolled back FIRST — which
    // reverses the sale's cashbox legs + settlement — before it can be returned
    // to the market. Otherwise the collected cash would be left owed up the
    // chain while the parcel is marked returned. (Audit I11.)
    if (
      [Order_status.SOLD, Order_status.PAID, Order_status.PARTLY_PAID].includes(
        order.status,
      )
    ) {
      this.badRequest(
        "Sotilgan/to'langan buyurtmani to'g'ridan-to'g'ri marketga qaytarib bo'lmaydi — avval rollback qiling (pul qaytariladi), keyin qaytaring",
      );
    }

    // A returned order may be handed to the market at HQ or at its home
    // (owning) branch. Two physical paths reach a valid handover point:
    //   1) cross-branch: the order was shipped back in a RECEIVED return batch
    //      (its destination branch is now where custody sits), or
    //   2) direct: the home branch's own courier returned it straight to the
    //      home branch, so custody already sits with the home branch.
    // Both converge on "custody is held by HQ or the home branch", which the
    // holder model now tracks. We keep the explicit return-batch check too, for
    // legacy orders whose holder fields predate custody tracking.
    const hqBranchId = await this.getHqBranchId();
    const homeBranchId = String(order.home_branch_id ?? '').trim();
    const holderBranchId = String(order.holder_branch_id ?? '').trim();

    const validHandoverBranches = new Set(
      [hqBranchId, homeBranchId].filter(Boolean).map(String),
    );
    const heldByHqOrHome =
      order.holder_type === OrderHolderType.BRANCH &&
      validHandoverBranches.has(holderBranchId);

    // Direct path: the home branch's OWN courier may return straight to the home
    // branch, collapsing courier→branch→market into one handover — but only when
    // the order is held by a courier of its home branch (per the product rule).
    const heldByHomeBranchCourier =
      order.holder_type === OrderHolderType.COURIER &&
      homeBranchId.length > 0 &&
      holderBranchId === homeBranchId;

    const receivedReturnBatchItem = await this.transferBatchItemRepo
      .createQueryBuilder('item')
      .innerJoin(
        BranchTransferBatch,
        'batch',
        'batch.id = item.batch_id AND batch.is_deleted = false',
      )
      .where('item.order_id = :orderId', { orderId: String(order.id) })
      .andWhere('item.is_deleted = false')
      .andWhere('batch.direction = :direction', {
        direction: BranchTransferDirection.RETURN,
      })
      .andWhere('batch.status = :status', {
        status: BranchTransferBatchStatus.RECEIVED,
      })
      .andWhere('batch.destination_branch_id = :branchId', {
        branchId: String(order.branch_id ?? ''),
      })
      .select(['item.id'])
      .getRawOne();

    // The direct path requires an explicit return intent (return_requested),
    // so an order merely sitting at its branch awaiting delivery can't be
    // wrongly marked as handed back to the market.
    const directHandoverAllowed =
      Boolean(order.return_requested) &&
      (heldByHqOrHome || heldByHomeBranchCourier);

    if (!receivedReturnBatchItem && !directHandoverAllowed) {
      this.badRequest(
        "Order HQ yoki o'z filialiga qaytarib qabul qilingan bo'lishi kerak (return paket yoki to'g'ridan-to'g'ri topshirish orqali)",
      );
    }

    const oldStatus = order.status;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const orderRepo = queryRunner.manager.getRepository(Order);
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);
      const custodyRepo = queryRunner.manager.getRepository(OrderCustodyEvent);

      // Capture the prior custody holder before closing the chain.
      const priorHolderType = order.holder_type ?? null;
      const priorHolderBranchId = order.holder_branch_id ?? null;
      const priorHolderCourierId = order.holder_courier_id ?? null;

      order.status = Order_status.RETURNED_TO_MARKET;
      order.return_requested = false;
      // Close the custody chain: the goods are back with the market. (Audit I10.)
      order.holder_type = OrderHolderType.MARKET;
      order.holder_branch_id = null;
      order.holder_courier_id = null;
      await orderRepo.save(order);

      await this.createTrackingEvent(
        {
          order_id: order.id,
          from_status: oldStatus,
          to_status: Order_status.RETURNED_TO_MARKET,
          changed_by: String(requester?.id ?? 'system'),
          changed_by_role: requester?.id
            ? this.toTrackingRole(requester.roles)
            : 'system',
          note: `Xodim ${String(requester?.id ?? 'unknown')} market egasiga topshirdi`,
        },
        trackingRepo,
      );

      // Closing custody event: parcel handed back to the market.
      await this.createCustodyEvent(
        {
          order_id: String(order.id),
          from_holder_type: priorHolderType,
          to_holder_type: OrderHolderType.MARKET,
          from_branch_id: priorHolderBranchId,
          to_branch_id: null,
          from_courier_id: priorHolderCourierId,
          to_courier_id: null,
          changed_by: String(requester?.id ?? 'system'),
          changed_by_role: requester?.id
            ? this.toTrackingRole(requester.roles)
            : 'system',
          note: 'Market egasiga qaytarib topshirildi',
        },
        custodyRepo,
      );

      await this.syncOrderToSearch(order, queryRunner.manager);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.handleDbError(error);
    } finally {
      await queryRunner.release();
    }

    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: String(order.id),
      action: ActivityAction.STATUS_CHANGE,
      old_value: { status: oldStatus },
      new_value: { status: Order_status.RETURNED_TO_MARKET },
      ...this.auditActor(requester),
      metadata: { market_id: order.market_id },
    });

    const updated = await this.findById(id);
    return successRes(updated, 200, 'Order marked as returned to market');
  }

  async createMarketCancelledHandoverQr(input: {
    market_id: string;
    requester: { id: string; roles?: string[] };
  }) {
    const marketId = String(input?.market_id ?? '').trim();
    const requesterId = String(input?.requester?.id ?? '').trim();
    const roles = new Set(
      (input?.requester?.roles ?? []).map((role) =>
        String(role ?? '')
          .trim()
          .toLowerCase(),
      ),
    );

    if (!marketId || !requesterId) {
      this.badRequest('market_id va requester majburiy');
    }
    if (!roles.has(Roles.MARKET) || requesterId !== marketId) {
      this.forbidden('Market faqat o‘zi uchun QR yarata oladi');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 2 * 60 * 1000);
    const qrToken = this.generateHandoverToken('MCR');
    const sessionRepo = this.dataSource.getRepository(
      MarketCancelledHandoverSession,
    );

    await sessionRepo
      .createQueryBuilder()
      .update(MarketCancelledHandoverSession)
      .set({ isDeleted: true })
      .where('market_id = :marketId', { marketId })
      .andWhere('scanned_at IS NULL')
      .andWhere('is_deleted = false')
      .execute();

    const session = sessionRepo.create({
      market_id: marketId,
      qr_token_hash: this.hashHandoverToken(qrToken),
      qr_expires_at: expiresAt,
      scanned_at: null,
      scanned_by_user_id: null,
      authorization_token_hash: null,
      authorization_expires_at: null,
      consumed_at: null,
    });
    await sessionRepo.save(session);

    return successRes(
      {
        market_id: marketId,
        qr_token: qrToken,
        qr_expires_at: expiresAt.toISOString(),
        qr_ttl_seconds: 120,
      },
      201,
      'Market canceled handover QR yaratildi',
    );
  }

  async scanMarketCancelledHandoverQr(input: {
    qr_token: string;
    requester: { id: string; roles?: string[] };
  }) {
    const qrToken = String(input?.qr_token ?? '').trim();
    const requesterId = String(input?.requester?.id ?? '').trim();
    if (!qrToken.startsWith('MCR-') || !requesterId) {
      this.badRequest('QR token yoki requester noto‘g‘ri');
    }

    await this.assertMarketHandoverHqRequester(input.requester);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const sessionRepo = queryRunner.manager.getRepository(
        MarketCancelledHandoverSession,
      );
      const session = await sessionRepo.findOne({
        where: {
          qr_token_hash: this.hashHandoverToken(qrToken),
          isDeleted: false,
        },
        lock: { mode: 'pessimistic_write' },
      });

      if (!session) {
        this.badRequest('QR topilmadi yoki yangilangan');
      }

      const now = new Date();
      if (session.qr_expires_at.getTime() <= now.getTime()) {
        this.badRequest('QR muddati tugagan');
      }
      if (session.scanned_at || session.authorization_token_hash) {
        this.badRequest('QR allaqachon ishlatilgan');
      }

      const authorizationToken = this.generateHandoverToken('MHA');
      const authorizationExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);

      session.scanned_at = now;
      session.scanned_by_user_id = requesterId;
      session.authorization_token_hash =
        this.hashHandoverToken(authorizationToken);
      session.authorization_expires_at = authorizationExpiresAt;
      await sessionRepo.save(session);
      await queryRunner.commitTransaction();

      return successRes(
        {
          market_id: String(session.market_id),
          authorized: true,
          authorization_token: authorizationToken,
          authorized_at: now.toISOString(),
          expires_at: authorizationExpiresAt.toISOString(),
          remaining_seconds: 300,
        },
        200,
        'Marketga topshirish uchun 5 daqiqalik ruxsat ochildi',
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.handleDbError(error);
    } finally {
      await queryRunner.release();
    }
  }

  async completeMarketCancelledHandover(input: {
    market_id: string;
    order_ids: string[];
    authorization_token?: string;
    manual_overrides?: Array<{ order_id: string; reason: string }>;
    requester: { id: string; roles?: string[] };
  }) {
    const marketId = String(input?.market_id ?? '').trim();
    const requesterId = String(input?.requester?.id ?? '').trim();
    const authorizationToken = String(input?.authorization_token ?? '').trim();
    const orderIds = Array.from(
      new Set(
        (input?.order_ids ?? []).map((id) => String(id).trim()).filter(Boolean),
      ),
    );
    const manualOverrides = (input?.manual_overrides ?? [])
      .map((item) => ({
        order_id: String(item?.order_id ?? '').trim(),
        reason: String(item?.reason ?? '').trim(),
      }))
      .filter((item) => item.order_id && item.reason);
    const manualOverrideByOrderId = new Map(
      manualOverrides.map((item) => [item.order_id, item.reason]),
    );

    if (!marketId || !requesterId) {
      this.badRequest('market_id va requester majburiy');
    }
    if (!orderIds.length) {
      this.badRequest('order_ids is required');
    }
    if (manualOverrideByOrderId.size !== manualOverrides.length) {
      this.badRequest('manual_overrides ichida takror order bor');
    }
    const invalidManualOverrideReasons = manualOverrides.filter(
      (item) =>
        item.reason.length > CANCELLED_HANDOVER_MANUAL_REASON_MAX_LENGTH ||
        !CANCELLED_HANDOVER_MANUAL_REASONS.has(item.reason),
    );
    if (invalidManualOverrideReasons.length) {
      this.badRequest(
        'manual_overrides.reason noto‘g‘ri yoki juda uzun',
      );
    }
    const invalidManualOverrideIds = [...manualOverrideByOrderId.keys()].filter(
      (orderId) => !orderIds.includes(orderId),
    );
    if (invalidManualOverrideIds.length) {
      this.badRequest(
        `manual_overrides faqat tanlangan orderlar uchun bo'lishi kerak: ${invalidManualOverrideIds.join(', ')}`,
      );
    }

    await this.assertMarketHandoverHqRequester(input.requester);

    const [market] = await this.getMarketsByIds([marketId]);
    if (!market) {
      this.badRequest('Market topilmadi');
    }
    const isQrRequired = market?.cancelled_handover_qr_required !== false;
    if (isQrRequired && !authorizationToken) {
      this.badRequest('authorization_token majburiy');
    }
    if (isQrRequired && !authorizationToken.startsWith('MHA-')) {
      this.badRequest('authorization_token noto‘g‘ri');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let handedOverOrders: Order[] = [];
    try {
      const sessionRepo = queryRunner.manager.getRepository(
        MarketCancelledHandoverSession,
      );
      const orderRepo = queryRunner.manager.getRepository(Order);
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);
      const custodyRepo = queryRunner.manager.getRepository(OrderCustodyEvent);

      const now = new Date();
      let session: MarketCancelledHandoverSession | null = null;
      if (isQrRequired) {
        session = await sessionRepo.findOne({
          where: {
            authorization_token_hash: this.hashHandoverToken(
              authorizationToken!,
            ),
            isDeleted: false,
          },
          lock: { mode: 'pessimistic_write' },
        });

        if (!session || !session.authorization_expires_at) {
          this.forbidden('Topshirish ruxsati topilmadi');
        }
        if (String(session.market_id) !== marketId) {
          this.forbidden('Ruxsat boshqa market uchun berilgan');
        }
        if (String(session.scanned_by_user_id ?? '') !== requesterId) {
          this.forbidden('Ruxsat boshqa xodimga tegishli');
        }
        if (session.consumed_at) {
          this.forbidden('Topshirish ruxsati allaqachon ishlatilgan');
        }
        if (session.authorization_expires_at.getTime() <= now.getTime()) {
          this.forbidden('5 daqiqalik topshirish ruxsati tugagan');
        }
      }

      handedOverOrders = await orderRepo.find({
        where: {
          id: In(orderIds),
          market_id: marketId,
          status: In([Order_status.CANCELLED, Order_status.CANCELLED_SENT]),
          holder_type: OrderHolderType.HQ,
          canceled_post_id: IsNull(),
          isDeleted: false,
        },
        lock: { mode: 'pessimistic_write' },
      });

      if (handedOverOrders.length !== orderIds.length) {
        this.badRequest(
          'Tanlangan orderlarning ayrimlari marketga tegishli emas, CANCELLED emas yoki HQda turmagan',
        );
      }

      for (const order of handedOverOrders) {
        const manualOverrideReason = manualOverrideByOrderId.get(
          String(order.id),
        );
        const previousStatus = order.status;
        const previousHolderType = order.holder_type ?? null;
        const previousHolderBranchId = order.holder_branch_id ?? null;
        const previousHolderCourierId = order.holder_courier_id ?? null;

        order.status = Order_status.CLOSED;
        order.holder_type = OrderHolderType.MARKET;
        order.holder_branch_id = null;
        order.holder_courier_id = null;
        order.return_requested = false;
        order.last_handover_at = now;
        order.last_handover_by = requesterId;
        await orderRepo.save(order);

        await this.createTrackingEvent(
          {
            order_id: String(order.id),
            from_status: previousStatus,
            to_status: Order_status.CLOSED,
            changed_by: requesterId,
            changed_by_role: this.toTrackingRole(input.requester.roles),
            note: manualOverrideReason
              ? `Bekor qilingan order market ${marketId}ga QR buzilgani sabab qo'lda tasdiqlanib topshirildi: ${manualOverrideReason}`
              : isQrRequired
                ? `Bekor qilingan order market ${marketId}ga QR tasdiqi bilan topshirildi`
                : `Bekor qilingan order market ${marketId}ga QR talab qilinmasdan topshirildi`,
            action: manualOverrideReason
              ? 'cancelled_market_handover_manual'
              : undefined,
            metadata: manualOverrideReason
              ? {
                  manual_override: true,
                  manual_reason: manualOverrideReason,
                  market_id: marketId,
                }
              : undefined,
          },
          trackingRepo,
        );

        await this.createCustodyEvent(
          {
            order_id: String(order.id),
            from_holder_type: previousHolderType,
            to_holder_type: OrderHolderType.MARKET,
            from_branch_id: previousHolderBranchId,
            to_branch_id: null,
            from_courier_id: previousHolderCourierId,
            to_courier_id: null,
            changed_by: requesterId,
            changed_by_role: this.toTrackingRole(input.requester.roles),
            note: manualOverrideReason
              ? `Bekor qilingan order market ${marketId}ga qo'lda tasdiqlanib topshirildi: ${manualOverrideReason}`
              : `Bekor qilingan order market ${marketId}ga topshirildi`,
          },
          custodyRepo,
        );

        await this.syncOrderToSearch(order, queryRunner.manager);
      }

      if (session) {
        session.consumed_at = now;
        await sessionRepo.save(session);
      }
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.handleDbError(error);
    } finally {
      await queryRunner.release();
    }

    await this.activityLog.log({
      entity_type: 'Market',
      entity_id: marketId,
      action: ActivityAction.STATUS_CHANGE,
      old_value: { status: Order_status.CANCELLED },
      new_value: { status: Order_status.CLOSED },
      ...this.auditActor(input.requester),
      metadata: {
        handover_type: isQrRequired
          ? 'market_cancelled_qr'
          : 'market_cancelled_without_qr',
        qr_required: isQrRequired,
        order_count: handedOverOrders.length,
        manual_override_count: manualOverrideByOrderId.size,
        manual_overrides: [...manualOverrideByOrderId.entries()].map(
          ([order_id, reason]) => ({ order_id, reason }),
        ),
        order_ids: handedOverOrders
          .slice(0, 20)
          .map((order) => String(order.id)),
      },
    });

    return successRes(
      {
        market_id: marketId,
        closed_count: handedOverOrders.length,
        order_ids: handedOverOrders.map((order) => String(order.id)),
      },
      200,
      'Bekor qilingan buyurtmalar marketga topshirildi va yopildi',
    );
  }

  private async replaceOrderItems(
    orderId: string,
    items?: Array<{ product_id: string; quantity?: number }>,
  ): Promise<number> {
    try {
      await this.orderItemRepo.delete({ order_id: orderId });
    } catch (error) {
      this.handleDbError(error);
    }

    const normalizedItems = (items ?? []).map((item) => ({
      product_id: item.product_id,
      quantity: item.quantity ?? 1,
      order_id: orderId,
    }));

    if (!normalizedItems.length) {
      return 0;
    }

    try {
      // Use explicit insert so order_id is always written and never treated as DEFAULT/null.
      await this.orderItemRepo
        .createQueryBuilder()
        .insert()
        .values(normalizedItems)
        .execute();
    } catch (error) {
      this.handleDbError(error);
    }

    return normalizedItems.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
  }

  async create(
    dto: {
      market_id: string;
      customer_id: string;
      where_deliver?: Where_deliver;
      total_price?: number;
      to_be_paid?: number;
      paid_amount?: number;
      status?: Order_status;
      comment?: string | null;
      operator?: string | null;
      operator_id?: string | null;
      post_id?: string | null;
      canceled_post_id?: string | null;
      sold_at?: string | null;
      branch_id?: string | null;
      home_branch_id?: string | null;
      current_batch_id?: string | null;
      courier_id?: string | null;
      assigned_at?: string | Date | null;
      return_reason?: string | null;
      district_id?: string | null;
      region_id?: string | null;
      address?: string | null;
      qr_code_token?: string | null;
      parent_order_id?: string | null;
      external_id?: string | null;
      source?: Order_source;
      items?: Array<{ product_id: string; quantity?: number }>;
    },
    requester?: { id: string; roles?: string[] },
  ) {
    const roles = new Set(
      (requester?.roles ?? []).map((role) => String(role).toLowerCase()),
    );
    const isOperatorRequester =
      roles.has(Roles.REGISTRATOR) || roles.has(Roles.MARKET_OPERATOR);
    const operatorId =
      dto.operator_id ?? (isOperatorRequester ? (requester?.id ?? null) : null);

    const resolvedBranchId = await this.resolveBranchIdForOrder(
      dto.branch_id,
      requester,
    );
    const resolvedHolder = await this.resolveHolderFromState(
      resolvedBranchId,
      dto.courier_id ?? null,
    );

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let savedId = '';
    try {
      const orderRepo = queryRunner.manager.getRepository(Order);
      const orderItemRepo = queryRunner.manager.getRepository(OrderItem);
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);
      const custodyRepo = queryRunner.manager.getRepository(OrderCustodyEvent);

      const order = orderRepo.create({
        market_id: dto.market_id,
        customer_id: dto.customer_id,
        where_deliver: dto.where_deliver ?? Where_deliver.CENTER,
        total_price: dto.total_price ?? 0,
        to_be_paid: dto.to_be_paid ?? 0,
        paid_amount: dto.paid_amount ?? 0,
        status: dto.status ?? Order_status.NEW,
        comment: dto.comment ?? null,
        operator: dto.operator ?? null,
        operator_id: operatorId,
        post_id: dto.post_id ?? null,
        canceled_post_id: dto.canceled_post_id ?? null,
        sold_at: dto.sold_at ?? null,
        branch_id: resolvedBranchId,
        // Home (owning) branch — set once, never overwritten. Defaults to the
        // creating branch when not explicitly provided (e.g. partly-sell child
        // orders pass the parent's home branch).
        home_branch_id: dto.home_branch_id ?? resolvedBranchId,
        current_batch_id: dto.current_batch_id ?? null,
        courier_id: dto.courier_id ?? null,
        assigned_at: this.normalizeDateTimeInput(dto.assigned_at),
        holder_type: resolvedHolder.holder_type,
        holder_branch_id: resolvedHolder.holder_branch_id,
        holder_courier_id: resolvedHolder.holder_courier_id,
        last_handover_at: new Date(),
        last_handover_by: requester?.id ? String(requester.id) : null,
        return_reason: dto.return_reason ?? null,
        district_id: dto.district_id ?? null,
        region_id: dto.region_id ?? null,
        address: dto.address ?? null,
        qr_code_token: dto.qr_code_token ?? this.generateCustomToken(),
        parent_order_id: dto.parent_order_id ?? null,
        external_id: dto.external_id ?? null,
        source: dto.source ?? Order_source.INTERNAL,
        isDeleted: false,
      });

      const saved = await orderRepo.save(order);
      savedId = saved.id;

      const normalizedItems = (dto.items ?? []).map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity ?? 1,
        order_id: saved.id,
      }));
      if (normalizedItems.length) {
        await orderItemRepo
          .createQueryBuilder()
          .insert()
          .values(normalizedItems)
          .execute();
      }

      const productQuantity = normalizedItems.reduce(
        (sum, item) => sum + (item.quantity ?? 1),
        0,
      );
      if (saved.product_quantity !== productQuantity) {
        await orderRepo.update(
          { id: saved.id },
          { product_quantity: productQuantity },
        );
      }

      await this.createTrackingEvent(
        {
          order_id: saved.id,
          from_status: null,
          to_status: this.mapInitialStatusForTracking(saved.status),
          changed_by: String(requester?.id ?? 'system'),
          changed_by_role: requester?.id
            ? this.toTrackingRole(requester.roles)
            : 'system',
          note: 'Order created',
        },
        trackingRepo,
      );

      await this.createCustodyEvent(
        {
          order_id: saved.id,
          from_holder_type: null,
          to_holder_type: resolvedHolder.holder_type,
          from_branch_id: null,
          to_branch_id: resolvedHolder.holder_branch_id,
          from_courier_id: null,
          to_courier_id: resolvedHolder.holder_courier_id,
          changed_by: String(requester?.id ?? 'system'),
          changed_by_role: requester?.id
            ? this.toTrackingRole(requester.roles)
            : 'system',
          note: 'Initial custody assigned',
        },
        custodyRepo,
      );

      await this.syncOrderToSearch(saved, queryRunner.manager);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.handleDbError(error);
    } finally {
      await queryRunner.release();
    }

    if (savedId) {
      await this.activityLog.log({
        entity_type: 'Order',
        entity_id: savedId,
        action: ActivityAction.CREATED,
        new_value: {
          status: dto.status ?? Order_status.NEW,
          market_id: dto.market_id,
          customer_id: dto.customer_id,
          total_price: dto.total_price ?? 0,
          branch_id: resolvedBranchId,
          source: dto.source ?? Order_source.INTERNAL,
        },
        ...this.auditActor(requester),
        metadata: { operator_id: operatorId },
      });
    }

    const fullOrder = await this.findById(savedId);
    return fullOrder;
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
    return_requested?: boolean;
    start_day?: string;
    end_day?: string;
    courier?: string;
    courier_ids?: string[];
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
      return_requested,
      start_day,
      end_day,
      courier,
      courier_ids,
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
            .orWhere('order.holder_branch_id = :branch_id', { branch_id });
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
          }),
        );
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
        statuses: [Order_status.CANCELLED, Order_status.CANCELLED_SENT],
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
      status: [Order_status.CANCELLED, Order_status.CANCELLED_SENT],
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

  async createExternalOrder(dto: {
    market_id: string;
    customer_id: string;
    where_deliver?: Where_deliver;
    total_price?: number;
    to_be_paid?: number;
    paid_amount?: number;
    status?: Order_status;
    comment?: string | null;
    operator?: string | null;
    post_id?: string | null;
    district_id?: string | null;
    region_id?: string | null;
    address?: string | null;
    qr_code_token?: string | null;
    external_id?: string | null;
    items?: Array<{ product_id: string; quantity?: number }>;
  }) {
    return this.create({
      ...dto,
      source: Order_source.EXTERNAL,
      operator: dto.operator ?? 'external_manual',
      status: dto.status ?? Order_status.NEW,
    });
  }

  private generateCustomToken(length = 24): string {
    const chars = 'abcdef0123456789';
    let token = '';
    for (let i = 0; i < length; i += 1) {
      token += chars[Math.floor(Math.random() * chars.length)];
    }
    return token;
  }

  private getFieldValue(obj: any, fieldPath?: string | null): any {
    if (!obj || !fieldPath) return undefined;
    return fieldPath.split('.').reduce((acc, key) => acc?.[key], obj);
  }

  private async getIntegrationById(
    integrationId: string,
  ): Promise<Record<string, any>> {
    const response = await rmqSend<{ data?: Record<string, any> }>(
      this.integrationClient,
      { cmd: 'integration.find_by_id' },
      { id: integrationId },
    ).catch(() => ({ data: undefined }));

    const integration = response?.data;
    if (!integration) {
      this.notFound('Integration not found');
    }
    return integration;
  }

  private async getDefaultDistrictId(): Promise<string> {
    const response = await rmqSend<{
      data?: { items?: Array<{ id: string }> } | Array<{ id: string }>;
    }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_all' },
      { query: { page: 1, limit: 1 } },
    ).catch(() => ({ data: [] }));

    const rows = Array.isArray(response?.data)
      ? response.data
      : ((response?.data as any)?.items ?? []);

    const districtId = rows?.[0]?.id ? String(rows[0].id) : '';
    if (!districtId) {
      this.notFound('No district found for external order import');
    }
    return districtId;
  }

  private async resolveDistrictId(
    externalDistrictValue: unknown,
    fallbackDistrictId: string,
  ): Promise<string> {
    const raw =
      externalDistrictValue == null ? '' : String(externalDistrictValue).trim();
    if (!raw) return fallbackDistrictId;

    const bySato = await rmqSend<{ data?: { id?: string } }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_by_sato' },
      { satoCode: raw },
    ).catch(() => ({ data: undefined }));
    if (bySato?.data?.id) {
      return String(bySato.data.id);
    }

    const byId = await rmqSend<{ data?: { id?: string } }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_by_id' },
      { id: raw },
    ).catch(() => ({ data: undefined }));
    if (byId?.data?.id) {
      return String(byId.data.id);
    }

    return fallbackDistrictId;
  }

  private async queueExternalStatusSync(
    order: Order,
    action: 'sold' | 'canceled' | 'paid' | 'rollback' | 'waiting',
    old_status: string,
    new_status: string,
  ) {
    if (!order.external_id || !order.operator?.startsWith('external_')) {
      return;
    }

    await rmqSend(
      this.integrationClient,
      { cmd: 'integration.sync.enqueue' },
      {
        order_id: order.id,
        external_order_id: order.external_id,
        operator: order.operator,
        action,
        old_status,
        new_status,
      },
    ).catch(() => undefined);
  }

  private resolveSyncAction(
    oldStatus: string,
    newStatus: string,
  ): 'sold' | 'canceled' | 'paid' | 'rollback' | 'waiting' | null {
    if (newStatus === Order_status.CANCELLED) {
      return 'canceled';
    }

    if (
      newStatus === Order_status.PAID ||
      newStatus === Order_status.PARTLY_PAID
    ) {
      return 'paid';
    }

    if (newStatus === Order_status.SOLD) {
      return 'sold';
    }

    if (newStatus === Order_status.WAITING) {
      if (
        [
          Order_status.CANCELLED,
          Order_status.CLOSED,
          Order_status.SOLD,
          Order_status.PAID,
          Order_status.PARTLY_PAID,
        ].includes(oldStatus as Order_status)
      ) {
        return 'rollback';
      }
      return 'waiting';
    }

    return null;
  }

  async receiveNewOrders(orderIds: string[], search?: string) {
    const uniqueOrderIds = Array.from(
      new Set((orderIds ?? []).filter(Boolean)),
    );
    if (!uniqueOrderIds.length) {
      this.badRequest('order_ids is required');
    }

    // 1. Fetch orders from own schema only (no cross-schema queries)
    let orders = await this.orderRepo.find({
      where: {
        id: In(uniqueOrderIds),
        isDeleted: false,
        status: Order_status.NEW,
      },
    });

    if (!orders.length) {
      this.notFound('No orders found!');
    }

    // 2. Validate customers via RMQ (batch)
    const customerIds = [
      ...new Set(orders.map((o) => o.customer_id).filter(Boolean)),
    ];
    const customersRes = await rmqSend<{
      data: Array<{ id: string; name?: string; phone_number?: string }>;
    }>(
      this.identityClient,
      { cmd: 'identity.customer.find_by_ids' },
      { ids: customerIds },
    );
    const customerMap = new Map(
      (customersRes?.data ?? []).map((c) => [String(c.id), c]),
    );

    // 3. Optional search filter on customer name/phone (via identity-service DB, not in-memory)
    if (search?.trim()) {
      const searchRes = await rmqSend<{ data: Array<{ id: string }> }>(
        this.identityClient,
        { cmd: 'identity.customer.search' },
        { search: search.trim(), limit: 1000 },
      );
      const matchingIds = new Set(
        (searchRes?.data ?? []).map((c) => String(c.id)),
      );
      orders = orders.filter((o) => matchingIds.has(o.customer_id));
      if (!orders.length) {
        this.notFound('No orders found matching search criteria');
      }
    }

    if (orders.length !== uniqueOrderIds.length && !search?.trim()) {
      this.badRequest('Some orders are not found or not in NEW status');
    }

    // 4. Validate customers exist
    for (const order of orders) {
      if (!customerMap.has(order.customer_id)) {
        this.notFound(`Customer not found for order #${order.id}`);
      }
    }

    // 5. Fetch district data via RMQ (batch) to get assigned_region
    const districtIds = [
      ...new Set(orders.map((o) => o.district_id).filter(Boolean) as string[]),
    ];
    const districtsRes = await rmqSend<{
      data: Array<{
        id: string;
        assigned_region?: string;
        assignedToRegion?: { id: string };
      }>;
    }>(
      this.logisticsClient,
      { cmd: 'logistics.district.find_by_ids' },
      { ids: districtIds },
    );
    const districtMap = new Map(
      (districtsRes?.data ?? []).map((d) => [String(d.id), d]),
    );

    // 6. Build payload for logistics post assignment
    const logisticsPayload: Array<{
      order_id: string;
      assigned_region: string;
      assigned_branch?: string;
      total_price: number;
    }> = [];
    for (const order of orders) {
      const district = districtMap.get(order.district_id!);
      const assignedRegion =
        district?.assigned_region ??
        (district?.assignedToRegion as { id?: string } | undefined)?.id ??
        null;
      if (!assignedRegion) {
        this.notFound(
          `District/assigned region not found for order #${order.id}`,
        );
      }
      logisticsPayload.push({
        order_id: order.id,
        assigned_region: assignedRegion,
        assigned_branch: order.branch_id ? String(order.branch_id) : undefined,
        total_price: Number(order.total_price ?? 0),
      });
    }

    // 7. Delegate post creation/update to logistics-service via RMQ
    const postAssignments = await rmqSend<{
      data: Array<{ order_id: string; post_id: string }>;
    }>(
      this.logisticsClient,
      { cmd: 'logistics.post.receive_orders' },
      { orders: logisticsPayload },
      { timeoutMs: RMQ_SERVICE_TIMEOUT },
    );

    const assignmentMap = new Map(
      (postAssignments?.data ?? []).map((a) => [a.order_id, a.post_id]),
    );

    // 8. Update order statuses + enqueue search sync (single TX)
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);
      for (const order of orders) {
        const postId = assignmentMap.get(order.id);
        const previousStatus = order.status;
        const nextStatus = Order_status.RECEIVED;
        await queryRunner.manager
          .createQueryBuilder()
          .update(Order)
          .set({
            status: nextStatus,
            post_id: postId ?? null,
          })
          .where('id = :id', { id: order.id })
          .execute();

        if (previousStatus !== nextStatus) {
          await this.createTrackingEvent(
            {
              order_id: order.id,
              from_status: previousStatus,
              to_status: nextStatus,
              changed_by: 'system',
              changed_by_role: 'system',
              note: 'Order assigned to post',
            },
            trackingRepo,
          );
        }
        order.status = nextStatus;
        order.post_id = postId ?? null;
        await this.syncOrderToSearch(order, queryRunner.manager);
      }
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof RpcException) {
        throw error;
      }
      try {
        this.handleDbError(error);
      } catch (mappedError) {
        if (mappedError instanceof RpcException) {
          throw mappedError;
        }
      }
      throw new RpcException({
        statusCode: 500,
        message:
          error instanceof Error ? error.message : 'Internal server error',
      });
    } finally {
      await queryRunner.release();
    }

    for (const order of orders) {
      await this.activityLog.log({
        entity_type: 'Order',
        entity_id: String(order.id),
        action: ActivityAction.STATUS_CHANGE,
        old_value: { status: Order_status.NEW },
        new_value: { status: Order_status.RECEIVED, post_id: order.post_id },
      });
    }

    return successRes({}, 200, 'Orders received');
  }

  async receiveExternalOrders(dto: { integration_id: string; orders: any[] }) {
    const integration = await this.getIntegrationById(
      String(dto.integration_id),
    );
    if (integration?.is_active === false) {
      this.badRequest('Integration is inactive');
    }

    const fieldMapping = (integration?.field_mapping ?? {}) as Record<
      string,
      string
    >;
    const marketId = integration?.market_id
      ? String(integration.market_id)
      : '';
    if (!marketId) {
      this.badRequest('integration.market_id is required');
    }

    const items = Array.isArray(dto.orders) ? dto.orders : [];
    if (!items.length) {
      this.badRequest('orders is required');
    }

    const fallbackDistrictId = await this.getDefaultDistrictId();
    const created: Array<{
      id: string;
      external_id: string | null;
      status: Order_status;
    }> = [];
    const skipped: Array<{ external_id: string | null; reason: string }> = [];

    for (const ext of items) {
      const externalIdRaw = this.getFieldValue(
        ext,
        fieldMapping.id_field ?? 'id',
      );
      const externalId = externalIdRaw == null ? null : String(externalIdRaw);
      const operator = `external_${integration.slug}`;

      if (externalId) {
        const existing = await this.orderRepo.findOne({
          where: {
            external_id: externalId,
            operator,
            isDeleted: false,
          },
        });
        if (existing) {
          skipped.push({ external_id: externalId, reason: 'already_exists' });
          continue;
        }
      }

      const customerName = String(
        this.getFieldValue(
          ext,
          fieldMapping.customer_name_field ?? 'full_name',
        ) ?? 'External customer',
      );
      const phoneRaw = String(
        this.getFieldValue(ext, fieldMapping.phone_field ?? 'phone') ?? '',
      );
      const normalizedDigits = phoneRaw.replace(/\D/g, '');
      const phone =
        normalizedDigits.length === 12 && normalizedDigits.startsWith('998')
          ? `+${normalizedDigits}`
          : normalizedDigits.length === 9
            ? `+998${normalizedDigits}`
            : phoneRaw;
      if (!phone?.trim()) {
        skipped.push({ external_id: externalId, reason: 'phone_missing' });
        continue;
      }

      const districtExternal = this.getFieldValue(
        ext,
        fieldMapping.district_code_field ?? 'district',
      );
      const districtId = await this.resolveDistrictId(
        districtExternal,
        fallbackDistrictId,
      );
      const regionExternal = this.getFieldValue(
        ext,
        fieldMapping.region_code_field ?? 'region',
      );

      const customerResponse = await rmqSend<{ data?: { id?: string } }>(
        this.identityClient,
        { cmd: 'identity.customer.create' },
        {
          dto: {
            market_id: marketId,
            name: customerName,
            phone_number: phone,
            district_id: districtId,
            extra_number:
              this.getFieldValue(
                ext,
                fieldMapping.extra_phone_field ?? 'additional_phone',
              ) ?? undefined,
            address:
              this.getFieldValue(
                ext,
                fieldMapping.address_field ?? 'address',
              ) ?? undefined,
          },
        },
      );

      const customerId = customerResponse?.data?.id
        ? String(customerResponse.data.id)
        : '';
      if (!customerId) {
        skipped.push({
          external_id: externalId,
          reason: 'customer_create_failed',
        });
        continue;
      }

      const totalPrice = Number(
        this.getFieldValue(
          ext,
          fieldMapping.total_price_field ?? 'total_price',
        ) ?? 0,
      );
      const deliveryPrice = Number(
        this.getFieldValue(
          ext,
          fieldMapping.delivery_price_field ?? 'delivery_price',
        ) ?? 0,
      );
      const finalPrice = Math.max(totalPrice, 0) + Math.max(deliveryPrice, 0);
      const qrCode =
        this.getFieldValue(ext, fieldMapping.qr_code_field ?? 'qr_code') ??
        this.generateCustomToken();

      const createdOrder = await this.create({
        market_id: marketId,
        customer_id: customerId,
        where_deliver: Where_deliver.CENTER,
        total_price: finalPrice,
        to_be_paid: 0,
        paid_amount: 0,
        status: Order_status.RECEIVED,
        comment:
          this.getFieldValue(ext, fieldMapping.comment_field ?? 'comment') ??
          null,
        operator,
        district_id: districtId,
        region_id: regionExternal == null ? null : String(regionExternal),
        address:
          this.getFieldValue(ext, fieldMapping.address_field ?? 'address') ??
          null,
        qr_code_token: qrCode == null ? null : String(qrCode),
        external_id: externalId,
        source: Order_source.EXTERNAL,
      });

      created.push({
        id: createdOrder.id,
        external_id: createdOrder.external_id ?? null,
        status: createdOrder.status,
      });
    }

    return {
      statusCode: 201,
      message: `${created.length} ta external order qabul qilindi`,
      data: {
        integration: {
          id: integration.id,
          slug: integration.slug,
          name: integration.name,
        },
        created,
        skipped,
      },
    };
  }

  async sellOrder(
    requester: { id: string; roles?: string[]; branch_id?: string | null },
    id: string,
    dto: {
      comment?: string;
      extraCost?: number;
      paidAmount?: number;
      proofFileKeys?: string[];
      proofFileKeysVerified?: boolean;
    },
    requestId?: string,
  ) {
    const order = await this.findById(id);
    if (order.status !== Order_status.WAITING) {
      this.badRequest('Order not found or not in waiting status');
    }
    if (!order.post_id) {
      this.badRequest('Order has no post');
    }

    const postRes = await rmqSend<{
      data?: { id: string; courier_id?: string | null };
    }>(
      this.logisticsClient,
      { cmd: 'logistics.post.find_by_id' },
      { id: String(order.post_id) },
    ).catch(() => ({ data: undefined }));
    const post = postRes?.data;
    const actorCourierId = this.resolveActorCourierId(requester, order, post);
    const isManagerRequester =
      this.hasRole(requester, Roles.MANAGER) &&
      !this.hasRole(requester, Roles.COURIER);

    const [market, financialActor] = await Promise.all([
      this.getMarketsByIds([String(order.market_id)]).then((rows) => rows[0]),
      isManagerRequester
        ? this.getUserById(String(requester.id))
        : this.getCouriersByIds([actorCourierId]).then((rows) => rows[0]),
    ]);
    if (!market) {
      this.notFound('Market not found');
    }
    if (!financialActor) {
      this.notFound(
        isManagerRequester ? 'Manager not found' : 'Courier not found',
      );
    }

    const [marketCashbox, courierCashbox] = await Promise.all([
      this.getCashboxByUser(String(order.market_id), Cashbox_type.FOR_MARKET),
      isManagerRequester
        ? Promise.resolve(null)
        : this.getCashboxByUser(actorCourierId, Cashbox_type.FOR_COURIER).catch(
            () => null,
          ),
    ]);
    if (!marketCashbox) {
      this.notFound('Market cashbox not found');
    }
    if (!courierCashbox && !isManagerRequester) {
      this.notFound('Courier cashbox not found');
    }

    // Branch settlement: a non-HQ branch is a separate cash owner. Mirror the
    // courier-side COD entry onto the branch's cashbox (courier → branch → HQ)
    // so HQ can see what the branch owes and settle it later
    // (paymentFromBranchToMain). Ensure the cashbox exists before posting.
    const settlementBranchId = await this.resolveSettlementBranchId(order);
    if (settlementBranchId) {
      await this.ensureBranchCashbox(settlementBranchId);
    }
    const branchCashbox = settlementBranchId
      ? await this.getCashboxByUser(
          settlementBranchId,
          Cashbox_type.BRANCH,
        ).catch(() => null)
      : null;
    // branchShare = what a PARTNER branch keeps per order (0 for OWNED / HQ).
    const branchShare = settlementBranchId
      ? await this.resolveBranchShare(settlementBranchId)
      : 0;

    const marketBalanceBefore = Number(marketCashbox.balance ?? 0);

    const marketTariff =
      order.where_deliver === Where_deliver.CENTER
        ? Number(market.tariff_center ?? 0)
        : Number(market.tariff_home ?? 0);
    const courierTariff =
      order.where_deliver === Where_deliver.CENTER
        ? Number(financialActor?.tariff_center ?? 0)
        : Number(financialActor?.tariff_home ?? 0);
    // courierShare = what the courier keeps (0 for salary-only couriers).
    const courierShare = this.resolveSaleActorShare(
      isManagerRequester,
      financialActor,
      courierTariff,
    );
    const actorExpenseUserId = isManagerRequester
      ? String(requester.branch_id ?? '')
      : actorCourierId;
    const actorExpenseCashboxType = isManagerRequester
      ? Cashbox_type.BRANCH
      : Cashbox_type.FOR_COURIER;
    const actorExpenseCashbox = isManagerRequester
      ? branchCashbox
      : courierCashbox;

    const totalPrice = Number(order.total_price ?? 0);
    const extraCost = Math.max(Number(dto?.extraCost ?? 0), 0);
    // Reject up front (before the transaction) if this market's proof policy is
    // triggered by this sell and the courier didn't attach valid file proof.
    const proofFiles = await this.enforceOperationProof({
      market,
      action: 'sell',
      extraCost,
      totalPrice,
      proofFileKeys: dto?.proofFileKeys,
      proofFileKeysVerified: dto?.proofFileKeysVerified,
    });
    const finalComment = this.generateSaleComment(
      order.comment,
      dto?.comment,
      extraCost,
    );

    // Decoupled COD legs — each independent of the others' thresholds:
    //   market : HQ owes market (total − marketTariff); reversed if total < marketTariff
    //   courier: courier owes branch (total − courierShare); HQ tops up if total < courierShare
    //   branch payable: branch owes HQ (total − courierShare − branchShare)
    //   branch cashbox: manager-direct sales receive the full collected amount
    const marketIncome = Math.max(totalPrice - marketTariff, 0);
    const marketExpense = Math.max(marketTariff - totalPrice, 0);
    const courierIncome = Math.max(totalPrice - courierShare, 0);
    const courierExpense = Math.max(courierShare - totalPrice, 0);
    const branchNet = totalPrice - courierShare - branchShare;
    const branchCashboxAmount = this.resolveBranchCashboxSaleAmount(
      totalPrice,
      branchNet,
      isManagerRequester,
    );
    const saleComment =
      totalPrice === 0
        ? "0 so'mlik mahsulot sotuvi"
        : totalPrice < marketTariff
          ? `${totalPrice} so'mlik mahsulot sotuvi`
          : finalComment;

    const toBePaid = marketIncome;
    const netToBePaid = Math.max(Number(toBePaid) || 0, 0);
    const requestedPaidAmount = Number(
      dto?.paidAmount ?? order.paid_amount ?? 0,
    );
    if (!Number.isFinite(requestedPaidAmount) || requestedPaidAmount < 0) {
      this.badRequest('paidAmount must be a non-negative number');
    }
    if (requestedPaidAmount > netToBePaid) {
      this.badRequest(
        `paidAmount (${requestedPaidAmount}) qoldiq summa (${netToBePaid}) dan oshmasligi kerak`,
      );
    }
    const currentPaid = Math.min(Math.max(requestedPaidAmount, 0), netToBePaid);
    const remainingBeforeDebt = netToBePaid - currentPaid;
    const debtBeforeSale =
      marketBalanceBefore < 0 ? Math.abs(marketBalanceBefore) : 0;
    const autoPay = Math.min(remainingBeforeDebt, debtBeforeSale);
    const paidAfter = Math.min(netToBePaid, currentPaid + autoPay);
    const remaining = Math.max(netToBePaid - paidAfter, 0);
    const nextStatus =
      remaining === 0 && paidAfter > 0
        ? Order_status.PAID
        : paidAfter > 0
          ? Order_status.PARTLY_PAID
          : Order_status.SOLD;

    // Stable per-request dedup token: an RMQ redelivery / retry of THIS sell
    // reuses the same epoch so finance dedupes it; a re-sell after rollback
    // arrives with a new request_id → new epoch → re-applies. See
    // resolveDedupEpoch + CashboxHistory.dedup_epoch.
    const dedupEpoch = this.resolveDedupEpoch(requestId);
    // sold_at is a real wall-clock timestamp (read as a number by analytics) —
    // kept separate from the dedup token above.
    const soldAt = String(Date.now());

    // Atomic block: outbox enqueues for cashbox updates + order status save must
    // commit together. Otherwise a crash between them produces missing finance
    // events or an order in WAITING when the cashboxes were already credited.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const tx = queryRunner.manager;
      await this.lockWaitingOrder(tx, id);
      const pay = (
        data: Parameters<typeof this.updateCashboxBalance>[0],
      ): Promise<void> =>
        this.updateCashboxBalance({ ...data, dedup_epoch: dedupEpoch }, tx);

      // ---- Market leg (HQ ↔ market) ----
      if (marketIncome > 0) {
        await pay({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: marketIncome,
          operation_type: Operation_type.INCOME,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: saleComment,
        });
      } else if (marketExpense > 0) {
        await pay({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: marketExpense,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: saleComment,
        });
      }

      // ---- Courier leg (courier ↔ branch) ----
      if (courierCashbox) {
        if (courierIncome > 0) {
          await pay({
            user_id: actorCourierId,
            cashbox_type: Cashbox_type.FOR_COURIER,
            amount: courierIncome,
            operation_type: Operation_type.INCOME,
            source_type: Source_type.SELL,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: saleComment,
          });
        } else if (courierExpense > 0) {
          await pay({
            user_id: actorCourierId,
            cashbox_type: Cashbox_type.FOR_COURIER,
            amount: courierExpense,
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.SELL,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: saleComment,
          });
        }
      }

      // ---- Branch leg (branch ↔ HQ) — only for non-HQ branch sales ----
      if (branchCashbox && settlementBranchId) {
        if (branchCashboxAmount > 0) {
          await pay({
            user_id: settlementBranchId,
            cashbox_type: Cashbox_type.BRANCH,
            amount: branchCashboxAmount,
            operation_type: Operation_type.INCOME,
            source_type: Source_type.SELL,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: saleComment,
          });
        } else if (branchCashboxAmount < 0) {
          await pay({
            user_id: settlementBranchId,
            cashbox_type: Cashbox_type.BRANCH,
            amount: -branchCashboxAmount,
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.SELL,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: saleComment,
          });
        }
      }

      if (extraCost > 0) {
        await pay({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: extraCost,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.EXTRA_COST,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
          proof_files: proofFiles.length ? proofFiles : undefined,
        });
        if (actorExpenseCashbox) {
          await pay({
            user_id: actorExpenseUserId,
            cashbox_type: actorExpenseCashboxType,
            amount: extraCost,
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.EXTRA_COST,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: finalComment,
            proof_files: proofFiles.length ? proofFiles : undefined,
          });
        }

        await this.outbox.enqueue(
          'FINANCE',
          'finance.financial_balance.record',
          {
            amount: -extraCost,
            source_type: 'sell_extra_cost',
            order_id: String(order.id),
            related_user_id: order.market_id ? String(order.market_id) : null,
            comment: `Order #${order.id} sell extra cost`,
          },
          { manager: tx },
        );
      }

      await this.updateFull(
        id,
        {
          status: nextStatus,
          to_be_paid: netToBePaid,
          paid_amount: paidAfter,
          sold_at: soldAt,
          // Snapshot tariffs + the actually-kept shares so SELL_PROFIT
          // (marketTariff − courierShare − branchShare) and rollback are exact.
          market_tariff: order.market_tariff ?? marketTariff,
          courier_tariff: order.courier_tariff ?? courierTariff,
          courier_share: courierShare,
          branch_share: branchShare,
          branch_cashbox_amount: branchCashboxAmount,
          comment: finalComment || null,
          ...(proofFiles.length ? { proof_files: proofFiles } : {}),
        },
        { id: requester.id, roles: requester.roles, note: 'Order sold' },
        tx,
      );

      // Open the per-order settlement row (PENDING) inside the same tx.
      await this.recordSaleSettlement(tx, {
        order_id: String(order.id),
        courier_id: courierCashbox ? actorCourierId : null,
        branch_id: settlementBranchId,
        market_id: order.market_id ? String(order.market_id) : null,
        courier_amount: courierIncome,
        branch_amount: Math.max(branchNet, 0),
        market_amount: marketIncome,
        hasCourier: Boolean(courierCashbox),
      });

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof RpcException) {
        throw error;
      }
      this.handleDbError(error);
      throw new RpcException({
        statusCode: 500,
        message:
          error instanceof Error ? error.message : 'Internal server error',
      });
    } finally {
      await queryRunner.release();
    }

    // Post-commit external integration sync (non-DB side effect; outbox handles
    // search). Failure here is non-fatal — DB and search are already consistent.
    try {
      const updated = await this.findById(id);
      const action = this.resolveSyncAction(Order_status.WAITING, nextStatus);
      if (action) {
        void this.queueExternalStatusSync(
          updated,
          action,
          Order_status.WAITING,
          nextStatus,
        );
      }
    } catch {
      // External sync is best-effort.
    }

    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: String(order.id),
      action: 'order.sell',
      old_value: { status: Order_status.WAITING },
      new_value: {
        status: nextStatus,
        to_be_paid: netToBePaid,
        paid_amount: paidAfter,
        extra_cost: extraCost,
      },
      ...this.auditActor(requester),
      metadata: {
        market_id: order.market_id,
        courier_id: courierCashbox ? actorCourierId : null,
        branch_id: settlementBranchId,
        total_price: totalPrice,
      },
    });

    return successRes({}, 200, 'Order sold');
  }

  async cancelOrder(
    requester: { id: string; roles?: string[]; branch_id?: string | null },
    id: string,
    dto: {
      comment?: string;
      extraCost?: number;
      proofFileKeys?: string[];
      proofFileKeysVerified?: boolean;
    },
    requestId?: string,
  ) {
    const isManagerRequester =
      this.hasRole(requester, Roles.MANAGER) &&
      !this.hasRole(requester, Roles.COURIER);
    const order = await this.findById(id);
    if (order.status !== Order_status.WAITING) {
      this.badRequest('Order not found or not in waiting status');
    }
    if (!order.post_id) {
      this.badRequest('Order has no post');
    }

    const postRes = await rmqSend<{
      data?: { id: string; courier_id?: string | null };
    }>(
      this.logisticsClient,
      { cmd: 'logistics.post.find_by_id' },
      { id: String(order.post_id) },
    ).catch(() => ({ data: undefined }));
    const post = postRes?.data;
    const actorCourierId = this.resolveActorCourierId(requester, order, post);

    const extraCost = Math.max(Number(dto?.extraCost ?? 0), 0);
    const totalPrice = Number(order.total_price ?? 0);
    const finalComment = this.generateSaleComment(
      order.comment,
      dto?.comment,
      extraCost,
    );

    // The market is needed for the proof policy regardless of extra cost, since
    // some conditions (e.g. cancelling a zero-total order) apply with no expense.
    const market = await this.getMarketsByIds([String(order.market_id)]).then(
      (rows) => rows[0],
    );

    // Reject the cancel up front if this market's proof policy is triggered and
    // the courier didn't attach valid file proof.
    const proofFiles = await this.enforceOperationProof({
      market,
      action: 'cancel',
      extraCost,
      totalPrice,
      proofFileKeys: dto?.proofFileKeys,
      proofFileKeysVerified: dto?.proofFileKeysVerified,
    });

    // Look up cashboxes (remote reads) before opening the transaction.
    let actorExpenseCashbox:
      | { id: string; balance?: number }
      | null
      | undefined;
    const actorExpenseUserId = isManagerRequester
      ? String(requester.branch_id ?? '')
      : actorCourierId;
    const actorExpenseCashboxType = isManagerRequester
      ? Cashbox_type.BRANCH
      : Cashbox_type.FOR_COURIER;
    if (isManagerRequester && !actorExpenseUserId) {
      this.badRequest('Manager branch not found');
    }
    if (extraCost > 0) {
      if (isManagerRequester) {
        await this.ensureBranchCashbox(actorExpenseUserId);
      }
      const [marketCashbox, fetchedActorExpenseCashbox] = await Promise.all([
        this.getCashboxByUser(String(order.market_id), Cashbox_type.FOR_MARKET),
        this.getCashboxByUser(
          actorExpenseUserId,
          actorExpenseCashboxType,
        ).catch(() => null),
      ]);
      if (!marketCashbox) {
        this.notFound('Market cashbox not found');
      }
      if (!fetchedActorExpenseCashbox) {
        this.notFound(
          isManagerRequester
            ? 'Branch cashbox not found'
            : 'Courier cashbox not found',
        );
      }
      actorExpenseCashbox = fetchedActorExpenseCashbox;
    }

    // Atomic block: the extra-cost cashbox movements (outbox enqueues) and the
    // status flip to CANCELLED must commit together — otherwise a crash could
    // charge the extra cost while leaving the order in WAITING.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    // Stable per-request dedup token so a redelivery / retry of THIS cancel
    // reuses the same epoch (finance dedupes the extra-cost expense), while a
    // cancel after rollback gets a fresh request_id → fresh epoch → re-applies.
    const dedupEpoch = this.resolveDedupEpoch(requestId);

    try {
      const tx = queryRunner.manager;
      await this.lockWaitingOrder(tx, id);
      const pay = (
        data: Parameters<typeof this.updateCashboxBalance>[0],
      ): Promise<void> =>
        this.updateCashboxBalance({ ...data, dedup_epoch: dedupEpoch }, tx);

      if (extraCost > 0) {
        await pay({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: extraCost,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.EXTRA_COST,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
          proof_files: proofFiles.length ? proofFiles : undefined,
        });
        if (actorExpenseCashbox) {
          await pay({
            user_id: actorExpenseUserId,
            cashbox_type: actorExpenseCashboxType,
            amount: extraCost,
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.EXTRA_COST,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: finalComment,
            proof_files: proofFiles.length ? proofFiles : undefined,
          });
        }

        await this.outbox.enqueue(
          'FINANCE',
          'finance.financial_balance.record',
          {
            amount: -extraCost,
            source_type: 'cancel_extra_cost',
            order_id: String(order.id),
            related_user_id: order.market_id ? String(order.market_id) : null,
            comment: `Order #${order.id} cancel extra cost`,
          },
          { manager: tx },
        );
      }

      await this.updateFull(
        id,
        {
          status: Order_status.CANCELLED,
          comment: finalComment || null,
          sold_at: null,
          ...(proofFiles.length ? { proof_files: proofFiles } : {}),
        },
        { id: requester.id, roles: requester.roles, note: 'Order canceled' },
        tx,
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof RpcException) {
        throw error;
      }
      this.handleDbError(error);
      throw new RpcException({
        statusCode: 500,
        message:
          error instanceof Error ? error.message : 'Internal server error',
      });
    } finally {
      await queryRunner.release();
    }

    // Post-commit: external status sync (updateFull skips it when handed an
    // external manager) — best-effort.
    try {
      const updated = await this.findById(id);
      const action = this.resolveSyncAction(
        Order_status.WAITING,
        Order_status.CANCELLED,
      );
      if (action) {
        void this.queueExternalStatusSync(
          updated,
          action,
          Order_status.WAITING,
          Order_status.CANCELLED,
        );
      }
    } catch {
      // External sync is best-effort.
    }

    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: String(order.id),
      action: 'order.cancel',
      old_value: { status: Order_status.WAITING },
      new_value: { status: Order_status.CANCELLED, extra_cost: extraCost },
      ...this.auditActor(requester),
      metadata: { market_id: order.market_id, courier_id: actorCourierId },
    });

    return successRes({ id }, 200, 'Order canceled');
  }

  async couldNotDeliverOrder(
    requester: { id: string; roles?: string[]; branch_id?: string | null },
    id: string,
    dto: { reason?: string },
  ) {
    const reason = String(dto?.reason ?? '').trim();
    if (reason.length < 10) {
      this.badRequest('reason must be at least 10 characters');
    }

    const order = await this.findById(id);
    if (order.status !== Order_status.ON_THE_ROAD) {
      this.badRequest('Order not found or not in on the road status');
    }
    if (!order.post_id) {
      this.badRequest('Order has no post');
    }

    const postRes = await rmqSend<{
      data?: { id: string; courier_id?: string | null };
    }>(
      this.logisticsClient,
      { cmd: 'logistics.post.find_by_id' },
      { id: String(order.post_id) },
    ).catch(() => ({ data: undefined }));
    const post = postRes?.data;
    this.resolveActorCourierId(requester, order, post);

    const trackingNote = `Courier ${String(requester.id)} yetkaza olmadi. Sabab: ${reason}`;
    await this.updateFull(
      id,
      {
        status: Order_status.WAITING_CUSTOMER,
      },
      {
        id: requester.id,
        roles: requester.roles,
        note: trackingNote,
        audit: false,
      },
    );

    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: String(order.id),
      action: ActivityAction.STATUS_CHANGE,
      old_value: { status: Order_status.ON_THE_ROAD },
      new_value: { status: Order_status.WAITING_CUSTOMER },
      ...this.auditActor(requester),
      metadata: { reason },
    });

    return successRes(
      { id },
      200,
      "Order WAITING_CUSTOMER holatiga o'tkazildi",
    );
  }

  /**
   * Apply a terminal status reported by an external delivery provider.
   *
   * STATUS-ONLY by design: this moves the order to the mapped status and
   * records a tracking event, but performs NO cashbox / profit / commission
   * movement. Provider-delivered orders settle financially via a separate
   * provider-reconciliation flow (the provider collects COD and remits to us),
   * which is intentionally not modelled here. We therefore bypass the finance
   * emit path (enqueueFinanceOnStatusChange) entirely.
   *
   * action → status: sell → SOLD, cancel → CANCELLED, return → CLOSED.
   * Idempotent: an order already in (or past) the target terminal state is a
   * no-op, so a duplicate or out-of-order webhook can't double-apply.
   */
  async markByProvider(input: {
    order_id: string;
    action: 'sell' | 'cancel' | 'return';
    provider_slug?: string | null;
    external_ref?: string | null;
  }) {
    const order = await this.findById(input.order_id);
    const oldStatus = order.status;

    const targetStatus =
      input.action === 'sell'
        ? Order_status.SOLD
        : input.action === 'cancel'
          ? Order_status.CANCELLED
          : Order_status.CLOSED;

    // Idempotency: skip if the order is already in a terminal state that the
    // action would (re)apply. Selling an already-sold order, cancelling an
    // already-cancelled one, etc., is a no-op.
    const soldStates = [
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
    ];
    const cancelStates = [
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
      Order_status.CLOSED,
    ];
    const alreadyApplied =
      (input.action === 'sell' && soldStates.includes(oldStatus)) ||
      (input.action === 'cancel' && cancelStates.includes(oldStatus)) ||
      (input.action === 'return' && oldStatus === Order_status.CLOSED);

    if (alreadyApplied) {
      return successRes(
        { id: order.id, status: oldStatus, skipped: true },
        200,
        'order already in target state (idempotent)',
      );
    }

    const note =
      `Provider ${input.provider_slug ?? 'external'} → ${input.action}` +
      (input.external_ref ? ` (ref: ${input.external_ref})` : '');

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const orderRepo = queryRunner.manager.getRepository(Order);
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);

      order.status = targetStatus;
      if (input.action === 'sell') {
        order.sold_at = order.sold_at ?? String(Date.now());
      }
      await orderRepo.save(order);

      await this.createTrackingEvent(
        {
          order_id: order.id,
          from_status: oldStatus,
          to_status: targetStatus,
          changed_by: 'system',
          changed_by_role: 'system',
          note,
        },
        trackingRepo,
      );

      // Keep search in sync; deliberately NO finance emit (status-only).
      await this.syncOrderToSearch(order, queryRunner.manager);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.handleDbError(error);
    } finally {
      await queryRunner.release();
    }

    const updated = await this.findById(order.id);
    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: String(updated.id),
      action: ActivityAction.WEBHOOK_RECEIVED,
      old_value: { status: oldStatus },
      new_value: { status: updated.status },
      metadata: {
        provider_slug: input.provider_slug ?? null,
        external_ref: input.external_ref ?? null,
        provider_action: input.action,
      },
    });
    return successRes(
      {
        id: updated.id,
        status: updated.status,
        // Surfaced for provider COD reconciliation (integration-service records
        // the receivable from this amount on a provider 'sell').
        total_price: Number(updated.total_price ?? 0),
      },
      200,
      `order marked ${input.action} by provider`,
    );
  }

  async partlySellOrder(
    requester: { id: string; roles?: string[]; branch_id?: string | null },
    id: string,
    dto: {
      order_item_info: Array<{ product_id: string; quantity: number }>;
      totalPrice: number;
      extraCost?: number;
      comment?: string;
      proofFileKeys?: string[];
      proofFileKeysVerified?: boolean;
    },
    requestId?: string,
  ) {
    const isManagerRequester =
      this.hasRole(requester, Roles.MANAGER) &&
      !this.hasRole(requester, Roles.COURIER);
    const order = await this.findById(id);
    const oldTotalPrice = Number(order.total_price ?? 0);
    if (order.status !== Order_status.WAITING) {
      this.badRequest('Order not found or not in waiting status');
    }
    if (!order.post_id) {
      this.badRequest('Order has no post');
    }

    const postRes = await rmqSend<{
      data?: { id: string; courier_id?: string | null };
    }>(
      this.logisticsClient,
      { cmd: 'logistics.post.find_by_id' },
      { id: String(order.post_id) },
    ).catch(() => ({ data: undefined }));
    const post = postRes?.data;
    const actorCourierId = this.resolveActorCourierId(requester, order, post);

    if (!dto?.order_item_info?.length) {
      this.badRequest('order_item_info is required');
    }

    const price = Number(dto.totalPrice ?? 0);
    if (!Number.isFinite(price) || price < 0) {
      this.badRequest('totalPrice must be a non-negative number');
    }

    const [market, financialActor] = await Promise.all([
      this.getMarketsByIds([String(order.market_id)]).then((rows) => rows[0]),
      isManagerRequester
        ? this.getUserById(String(requester.id))
        : this.getCouriersByIds([actorCourierId]).then((rows) => rows[0]),
    ]);
    if (!market) {
      this.notFound('Market not found');
    }
    if (!financialActor) {
      this.notFound(
        isManagerRequester ? 'Manager not found' : 'Courier not found',
      );
    }

    const [marketCashbox, courierCashbox] = await Promise.all([
      this.getCashboxByUser(String(order.market_id), Cashbox_type.FOR_MARKET),
      isManagerRequester
        ? Promise.resolve(null)
        : this.getCashboxByUser(actorCourierId, Cashbox_type.FOR_COURIER).catch(
            () => null,
          ),
    ]);
    if (!marketCashbox) {
      this.notFound('Market cashbox not found');
    }
    if (!courierCashbox && !isManagerRequester) {
      this.notFound('Courier cashbox not found');
    }

    // Branch settlement mirror (courier → branch → HQ) for non-HQ branch sales.
    const settlementBranchId = await this.resolveSettlementBranchId(order);
    if (settlementBranchId) {
      await this.ensureBranchCashbox(settlementBranchId);
    }
    const branchCashbox = settlementBranchId
      ? await this.getCashboxByUser(
          settlementBranchId,
          Cashbox_type.BRANCH,
        ).catch(() => null)
      : null;
    const branchShare = settlementBranchId
      ? await this.resolveBranchShare(settlementBranchId)
      : 0;

    const marketBalanceBefore = Number(marketCashbox.balance ?? 0);
    const marketTariff =
      order.market_tariff != null
        ? Number(order.market_tariff)
        : order.where_deliver === Where_deliver.CENTER
          ? Number(market.tariff_center ?? 0)
          : Number(market.tariff_home ?? 0);
    const courierTariff =
      order.courier_tariff != null
        ? Number(order.courier_tariff)
        : order.where_deliver === Where_deliver.CENTER
          ? Number(financialActor?.tariff_center ?? 0)
          : Number(financialActor?.tariff_home ?? 0);
    const courierShare = this.resolveSaleActorShare(
      isManagerRequester,
      financialActor,
      courierTariff,
    );
    const actorExpenseUserId = isManagerRequester
      ? String(requester.branch_id ?? '')
      : actorCourierId;
    const actorExpenseCashboxType = isManagerRequester
      ? Cashbox_type.BRANCH
      : Cashbox_type.FOR_COURIER;
    const actorExpenseCashbox = isManagerRequester
      ? branchCashbox
      : courierCashbox;

    const extraCost = Math.max(Number(dto?.extraCost ?? 0), 0);
    // Partly-sell is a sell variant → evaluated against SELL_* conditions, with
    // the new (partial) price as the operation total.
    const proofFiles = await this.enforceOperationProof({
      market,
      action: 'sell',
      extraCost,
      totalPrice: price,
      proofFileKeys: dto?.proofFileKeys,
      proofFileKeysVerified: dto?.proofFileKeysVerified,
    });
    const finalComment = this.generateSaleComment(
      order.comment,
      dto?.comment,
      extraCost,
      ['Buyurtma arzonroqqa sotildi!'],
    );

    const existingItems = await this.orderItemRepo.find({
      where: { order_id: String(order.id) },
      order: { createdAt: 'ASC' },
    });

    const oldQty = existingItems.reduce(
      (sum, item) => sum + Number(item.quantity ?? 0),
      0,
    );
    const newQty = dto.order_item_info.reduce((sum, item) => {
      const qty = Number(item.quantity ?? 0);
      if (!Number.isFinite(qty) || qty < 0) {
        this.badRequest('Item quantity must be a non-negative number');
      }
      return sum + qty;
    }, 0);

    if (newQty > oldQty) {
      this.badRequest('Partly sell quantity cannot exceed original quantity');
    }

    for (const existingItem of existingItems) {
      const dtoItem = dto.order_item_info.find(
        (item) => String(item.product_id) === String(existingItem.product_id),
      );
      if (!dtoItem) {
        this.notFound(
          `Product not found in request: ${existingItem.product_id}`,
        );
      }
      if (Number(dtoItem.quantity) > Number(existingItem.quantity)) {
        this.badRequest(
          `Quantity cannot exceed original amount for product ${existingItem.product_id}`,
        );
      }
    }

    for (const dtoItem of dto.order_item_info) {
      const existingItem = existingItems.find(
        (item) => String(item.product_id) === String(dtoItem.product_id),
      );
      if (!existingItem) {
        this.notFound(`Product not found in order: ${dtoItem.product_id}`);
      }
    }

    const cancelledItems = existingItems
      .map((existingItem) => {
        const dtoItem = dto.order_item_info.find(
          (item) => String(item.product_id) === String(existingItem.product_id),
        );
        if (!dtoItem) return null;

        const diff = Number(existingItem.quantity) - Number(dtoItem.quantity);
        return diff > 0
          ? { product_id: String(existingItem.product_id), quantity: diff }
          : null;
      })
      .filter(
        (item): item is { product_id: string; quantity: number } =>
          item !== null,
      );

    if (!cancelledItems.length) {
      this.badRequest(
        'Qisman sotishda kamida bitta mahsulot soni kamaytirilishi kerak',
      );
    }
    const cancelledTotalPrice = Math.max(oldTotalPrice - price, 0);
    const cancelledBranchId = String(
      order.holder_branch_id ??
        order.branch_id ??
        order.home_branch_id ??
        requester.branch_id ??
        '',
    ).trim();
    if (!cancelledBranchId) {
      this.badRequest('Qisman bekor qilingan order uchun branch aniqlanmadi');
    }
    const cancelledCourierId = isManagerRequester ? null : actorCourierId;
    const cancelledHolder = await this.resolveHolderFromState(
      cancelledBranchId,
      cancelledCourierId,
    );

    // Decoupled COD legs (partial price as the operation total). See sellOrder
    // for the model: market / courier / branch each settle independently.
    const marketIncome = Math.max(price - marketTariff, 0);
    const marketExpense = Math.max(marketTariff - price, 0);
    const courierIncome = Math.max(price - courierShare, 0);
    const courierExpense = Math.max(courierShare - price, 0);
    const branchNet = price - courierShare - branchShare;
    const branchCashboxAmount = this.resolveBranchCashboxSaleAmount(
      price,
      branchNet,
      isManagerRequester,
    );
    const saleComment =
      price === 0
        ? "0 so'mlik mahsulot qisman sotuvi"
        : price < marketTariff
          ? `${price} so'mlik mahsulot qisman sotuvi`
          : finalComment;

    const toBePaid = marketIncome;
    const netToBePaid = Math.max(Number(toBePaid) || 0, 0);
    const currentPaid = Math.min(
      Math.max(Number(order.paid_amount ?? 0), 0),
      netToBePaid,
    );
    const remainingBeforeDebt = netToBePaid - currentPaid;
    const debtBeforeSale =
      marketBalanceBefore < 0 ? Math.abs(marketBalanceBefore) : 0;
    const autoPay = Math.min(remainingBeforeDebt, debtBeforeSale);
    const paidAfter = Math.min(netToBePaid, currentPaid + autoPay);
    const remainingAfter = netToBePaid - paidAfter;
    const nextStatus =
      remainingAfter === 0 && paidAfter > 0
        ? Order_status.PAID
        : paidAfter > 0
          ? Order_status.PARTLY_PAID
          : Order_status.SOLD;

    // Stable per-request dedup token so a redelivery / retry of THIS partly-sell
    // reuses the same epoch (finance dedupes it), while a re-sell after rollback
    // gets a fresh request_id → fresh epoch → re-applies. See resolveDedupEpoch.
    const dedupEpoch = this.resolveDedupEpoch(requestId);
    // sold_at is a real wall-clock timestamp (analytics reads it as a number).
    const soldAt = String(Date.now());

    // Atomic block: item-quantity reduction, cashbox movements (outbox enqueues)
    // and the order status flip must commit together. Previously these ran
    // outside any transaction, so a crash mid-way could move money while leaving
    // the order in WAITING — and the idempotency layer caches the failure, so it
    // never auto-recovered. A single connection can't run queries in parallel,
    // so all enqueues run sequentially here (no Promise.all).
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const tx = queryRunner.manager;
      await this.lockWaitingOrder(tx, id);
      const txOrderItemRepo = tx.getRepository(OrderItem);
      const pay = (
        data: Parameters<typeof this.updateCashboxBalance>[0],
      ): Promise<void> =>
        this.updateCashboxBalance({ ...data, dedup_epoch: dedupEpoch }, tx);

      // Persist the reduced quantities for partially-returned line items.
      for (const existingItem of existingItems) {
        const dtoItem = dto.order_item_info.find(
          (item) => String(item.product_id) === String(existingItem.product_id),
        );
        if (!dtoItem) continue;

        const nextQty = Number(dtoItem.quantity);
        if (nextQty < Number(existingItem.quantity)) {
          existingItem.quantity = nextQty;
          await txOrderItemRepo.save(existingItem);
        }
      }

      // ---- Market leg ----
      if (marketIncome > 0) {
        await pay({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: marketIncome,
          operation_type: Operation_type.INCOME,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: saleComment,
        });
      } else if (marketExpense > 0) {
        await pay({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: marketExpense,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: saleComment,
        });
      }

      // ---- Courier leg ----
      if (courierCashbox) {
        if (courierIncome > 0) {
          await pay({
            user_id: actorCourierId,
            cashbox_type: Cashbox_type.FOR_COURIER,
            amount: courierIncome,
            operation_type: Operation_type.INCOME,
            source_type: Source_type.SELL,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: saleComment,
          });
        } else if (courierExpense > 0) {
          await pay({
            user_id: actorCourierId,
            cashbox_type: Cashbox_type.FOR_COURIER,
            amount: courierExpense,
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.SELL,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: saleComment,
          });
        }
      }

      // ---- Branch leg (non-HQ branch only) ----
      if (branchCashbox && settlementBranchId) {
        if (branchCashboxAmount > 0) {
          await pay({
            user_id: settlementBranchId,
            cashbox_type: Cashbox_type.BRANCH,
            amount: branchCashboxAmount,
            operation_type: Operation_type.INCOME,
            source_type: Source_type.SELL,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: saleComment,
          });
        } else if (branchCashboxAmount < 0) {
          await pay({
            user_id: settlementBranchId,
            cashbox_type: Cashbox_type.BRANCH,
            amount: -branchCashboxAmount,
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.SELL,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: saleComment,
          });
        }
      }

      if (extraCost > 0) {
        await pay({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: extraCost,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.EXTRA_COST,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: finalComment,
          proof_files: proofFiles.length ? proofFiles : undefined,
        });
        if (actorExpenseCashbox) {
          await pay({
            user_id: actorExpenseUserId,
            cashbox_type: actorExpenseCashboxType,
            amount: extraCost,
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.EXTRA_COST,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: finalComment,
            proof_files: proofFiles.length ? proofFiles : undefined,
          });
        }

        await this.outbox.enqueue(
          'FINANCE',
          'finance.financial_balance.record',
          {
            amount: -extraCost,
            source_type: 'sell_extra_cost',
            order_id: String(order.id),
            related_user_id: order.market_id ? String(order.market_id) : null,
            comment: `Order #${order.id} sell extra cost`,
          },
          { manager: tx },
        );
      }

      await this.updateFull(
        id,
        {
          status: nextStatus,
          to_be_paid: netToBePaid,
          paid_amount: paidAfter,
          sold_at: order.sold_at ?? soldAt,
          total_price: price,
          market_tariff: order.market_tariff ?? marketTariff,
          courier_tariff: order.courier_tariff ?? courierTariff,
          courier_share: courierShare,
          branch_share: branchShare,
          branch_cashbox_amount: branchCashboxAmount,
          return_requested: false,
          comment: finalComment || null,
          ...(proofFiles.length ? { proof_files: proofFiles } : {}),
        },
        { id: requester.id, roles: requester.roles, note: 'Order partly sold' },
        tx,
      );

      // product_quantity reflects only the sold portion. updateFull's save wrote
      // the stale (pre-sale) value, so overwrite it within the same tx.
      await tx
        .getRepository(Order)
        .update({ id: String(order.id) }, { product_quantity: newQty });

      // Open the per-order settlement row (PENDING) inside the same tx.
      await this.recordSaleSettlement(tx, {
        order_id: String(order.id),
        courier_id: courierCashbox ? actorCourierId : null,
        branch_id: settlementBranchId,
        market_id: order.market_id ? String(order.market_id) : null,
        courier_amount: courierIncome,
        branch_amount: Math.max(branchNet, 0),
        market_amount: marketIncome,
        hasCourier: Boolean(courierCashbox),
      });

      const cancelledOrderRepo = tx.getRepository(Order);
      const cancelledOrderItemRepo = tx.getRepository(OrderItem);
      const cancelledTrackingRepo = tx.getRepository(OrderTracking);
      const cancelledCustodyRepo = tx.getRepository(OrderCustodyEvent);
      const cancelledOrder = await cancelledOrderRepo.save(
        cancelledOrderRepo.create({
          market_id: String(order.market_id),
          customer_id: String(order.customer_id),
          where_deliver: order.where_deliver,
          total_price: cancelledTotalPrice,
          to_be_paid: 0,
          paid_amount: 0,
          status: Order_status.CANCELLED,
          comment: 'Qisman bekor qilingan mahsulotlar',
          operator: order.operator ?? null,
          operator_id: order.operator_id ?? null,
          post_id: order.post_id ?? null,
          canceled_post_id: null,
          branch_id: cancelledBranchId,
          home_branch_id: order.home_branch_id ?? order.branch_id ?? null,
          courier_id: cancelledCourierId,
          assigned_at: cancelledCourierId
            ? (order.assigned_at ?? new Date())
            : null,
          holder_type: cancelledHolder.holder_type,
          holder_branch_id: cancelledHolder.holder_branch_id,
          holder_courier_id: cancelledHolder.holder_courier_id,
          last_handover_at: new Date(),
          last_handover_by: String(requester.id),
          district_id: order.district_id ?? null,
          region_id: order.region_id ?? null,
          address: order.address ?? null,
          qr_code_token: `CANCEL-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
          parent_order_id: String(order.id),
          source: order.source,
          product_quantity: cancelledItems.reduce(
            (sum, item) => sum + item.quantity,
            0,
          ),
          isDeleted: false,
        }),
      );
      await cancelledOrderItemRepo
        .createQueryBuilder()
        .insert()
        .values(
          cancelledItems.map((item) => ({
            order_id: cancelledOrder.id,
            product_id: item.product_id,
            quantity: item.quantity,
          })),
        )
        .execute();
      await this.createTrackingEvent(
        {
          order_id: cancelledOrder.id,
          from_status: null,
          to_status: Order_status.CANCELLED,
          changed_by: String(requester.id),
          changed_by_role: this.toTrackingRole(requester.roles),
          note: 'Partly-sell unsold items canceled',
        },
        cancelledTrackingRepo,
      );
      await this.createCustodyEvent(
        {
          order_id: cancelledOrder.id,
          from_holder_type: null,
          to_holder_type: cancelledHolder.holder_type,
          from_branch_id: null,
          to_branch_id: cancelledHolder.holder_branch_id,
          from_courier_id: null,
          to_courier_id: cancelledHolder.holder_courier_id,
          changed_by: String(requester.id),
          changed_by_role: this.toTrackingRole(requester.roles),
          note: 'Partly-sell canceled items custody assigned',
        },
        cancelledCustodyRepo,
      );
      await this.syncOrderToSearch(cancelledOrder, tx);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof RpcException) {
        throw error;
      }
      this.handleDbError(error);
      throw new RpcException({
        statusCode: 500,
        message:
          error instanceof Error ? error.message : 'Internal server error',
      });
    } finally {
      await queryRunner.release();
    }

    // Post-commit: external status sync (updateFull skips it when handed an
    // external manager) — best-effort, DB/search are already consistent.
    try {
      const updated = await this.findById(id);
      const action = this.resolveSyncAction(Order_status.WAITING, nextStatus);
      if (action) {
        void this.queueExternalStatusSync(
          updated,
          action,
          Order_status.WAITING,
          nextStatus,
        );
      }
    } catch {
      // External sync is best-effort.
    }

    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: String(order.id),
      action: 'order.partly_sell',
      old_value: { status: Order_status.WAITING, total_price: oldTotalPrice },
      new_value: { status: nextStatus, total_price: price },
      ...this.auditActor(requester),
      metadata: {
        market_id: order.market_id,
        courier_id: courierCashbox ? actorCourierId : null,
        cancelled_items: cancelledItems.length,
      },
    });

    return successRes({}, 200, 'Order qisman sotildi');
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
    await this.findById(id);

    const page = Math.max(1, Number(pageRaw) || 1);
    const limit = Math.min(100, Math.max(1, Number(limitRaw) || 20));

    let rows: OrderTracking[] = [];
    let custodyRows: OrderCustodyEvent[] = [];
    try {
      rows = await this.orderTrackingRepo.find({
        where: { order_id: id },
        order: { created_at: 'DESC' },
      });
      custodyRows = await this.orderCustodyEventRepo.find({
        where: { order_id: id },
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
      const inferredAction = this.inferTrackingAction(
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
      const noteDescription = this.describeTrackingNote(row.note);

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
          this.describeTrackingAction(action, row.from_status, row.to_status),
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
      const noteDescription = this.describeTrackingNote(row.note);
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
      .map(({ created_at_ms, ...event }) => event);

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

  async update(
    id: string,
    dto: {
      market_id?: string;
      customer_id?: string;
      where_deliver?: Where_deliver;
      total_price?: number;
      market_tariff?: number | null;
      courier_tariff?: number | null;
      courier_share?: number | null;
      branch_share?: number | null;
      branch_cashbox_amount?: number | null;
      to_be_paid?: number;
      paid_amount?: number;
      status?: Order_status;
      return_requested?: boolean;
      comment?: string | null;
      operator?: string | null;
      post_id?: string | null;
      canceled_post_id?: string | null;
      sold_at?: string | null;
      branch_id?: string | null;
      current_batch_id?: string | null;
      courier_id?: string | null;
      assigned_at?: string | Date | null;
      return_reason?: string | null;
      district_id?: string | null;
      region_id?: string | null;
      address?: string | null;
      qr_code_token?: string | null;
      external_id?: string | null;
      source?: Order_source;
      items?: Array<{ product_id: string; quantity?: number }>;
    },
    requester?: { id?: string; roles?: string[]; note?: string | null },
  ) {
    return this.updateFull(id, dto, requester);
  }

  async updateFull(
    id: string,
    dto: {
      market_id?: string;
      customer_id?: string;
      where_deliver?: Where_deliver;
      total_price?: number;
      market_tariff?: number | null;
      courier_tariff?: number | null;
      courier_share?: number | null;
      branch_share?: number | null;
      branch_cashbox_amount?: number | null;
      to_be_paid?: number;
      paid_amount?: number;
      status?: Order_status;
      return_requested?: boolean;
      comment?: string | null;
      operator?: string | null;
      post_id?: string | null;
      canceled_post_id?: string | null;
      sold_at?: string | null;
      branch_id?: string | null;
      current_batch_id?: string | null;
      courier_id?: string | null;
      assigned_at?: string | Date | null;
      return_reason?: string | null;
      district_id?: string | null;
      region_id?: string | null;
      address?: string | null;
      qr_code_token?: string | null;
      external_id?: string | null;
      source?: Order_source;
      proof_files?: string[] | null;
      items?: Array<{ product_id: string; quantity?: number }>;
    },
    requester?: {
      id?: string;
      roles?: string[];
      note?: string | null;
      // Internal callers that already emit their own domain audit event
      // (sell/cancel/rollback) set this to false to avoid a duplicate
      // generic UPDATED row. Public edits leave it unset → audited.
      audit?: boolean;
    },
    externalManager?: EntityManager,
  ) {
    const order = await this.findById(id);
    if (!externalManager) {
      this.assertCommercialFieldsEditable(order, dto);
      await this.assertDeliveryDetailsEditable(order, dto);
    }
    const oldStatus = order.status;
    const previousCanceledPostId = order.canceled_post_id;
    const previousHolderType = order.holder_type;
    const previousHolderBranchId = order.holder_branch_id;
    const previousHolderCourierId = order.holder_courier_id;

    Object.assign(order, {
      market_id: dto.market_id ?? order.market_id,
      customer_id: dto.customer_id ?? order.customer_id,
      where_deliver: dto.where_deliver ?? order.where_deliver,
      total_price: dto.total_price ?? order.total_price,
      market_tariff:
        typeof dto.market_tariff !== 'undefined'
          ? dto.market_tariff
          : order.market_tariff,
      courier_tariff:
        typeof dto.courier_tariff !== 'undefined'
          ? dto.courier_tariff
          : order.courier_tariff,
      courier_share:
        typeof dto.courier_share !== 'undefined'
          ? dto.courier_share
          : order.courier_share,
      branch_share:
        typeof dto.branch_share !== 'undefined'
          ? dto.branch_share
          : order.branch_share,
      branch_cashbox_amount:
        typeof dto.branch_cashbox_amount !== 'undefined'
          ? dto.branch_cashbox_amount
          : order.branch_cashbox_amount,
      to_be_paid: dto.to_be_paid ?? order.to_be_paid,
      paid_amount: dto.paid_amount ?? order.paid_amount,
      status: dto.status ?? order.status,
      return_requested:
        typeof dto.return_requested !== 'undefined'
          ? dto.return_requested
          : order.return_requested,
      comment: dto.comment ?? order.comment,
      operator: dto.operator ?? order.operator,
      post_id: typeof dto.post_id !== 'undefined' ? dto.post_id : order.post_id,
      canceled_post_id:
        typeof dto.canceled_post_id !== 'undefined'
          ? dto.canceled_post_id
          : order.canceled_post_id,
      sold_at: typeof dto.sold_at !== 'undefined' ? dto.sold_at : order.sold_at,
      branch_id:
        typeof dto.branch_id !== 'undefined' ? dto.branch_id : order.branch_id,
      current_batch_id:
        typeof dto.current_batch_id !== 'undefined'
          ? dto.current_batch_id
          : order.current_batch_id,
      courier_id:
        typeof dto.courier_id !== 'undefined'
          ? dto.courier_id
          : order.courier_id,
      assigned_at:
        typeof dto.assigned_at !== 'undefined'
          ? this.normalizeDateTimeInput(dto.assigned_at)
          : order.assigned_at,
      return_reason:
        typeof dto.return_reason !== 'undefined'
          ? dto.return_reason
          : order.return_reason,
      district_id: dto.district_id ?? order.district_id,
      region_id: dto.region_id ?? order.region_id,
      address: dto.address ?? order.address,
      qr_code_token: dto.qr_code_token ?? order.qr_code_token,
      external_id:
        typeof dto.external_id !== 'undefined'
          ? dto.external_id
          : order.external_id,
      source: dto.source ?? order.source ?? Order_source.INTERNAL,
      proof_files:
        typeof dto.proof_files !== 'undefined'
          ? dto.proof_files
          : order.proof_files,
    });

    const shouldRecalculateHolder =
      typeof dto.branch_id !== 'undefined' ||
      typeof dto.courier_id !== 'undefined';
    if (shouldRecalculateHolder) {
      const resolvedHolder = await this.resolveHolderFromState(
        order.branch_id,
        order.courier_id,
      );
      order.holder_type = resolvedHolder.holder_type;
      order.holder_branch_id = resolvedHolder.holder_branch_id;
      order.holder_courier_id = resolvedHolder.holder_courier_id;
    }

    const custodyChanged =
      previousHolderType !== order.holder_type ||
      String(previousHolderBranchId ?? '') !==
        String(order.holder_branch_id ?? '') ||
      String(previousHolderCourierId ?? '') !==
        String(order.holder_courier_id ?? '');

    if (custodyChanged) {
      order.last_handover_at = new Date();
      order.last_handover_by = requester?.id ? String(requester.id) : null;
    }

    if (
      oldStatus !== order.status &&
      !this.isValidStatusTransition(oldStatus, order.status)
    ) {
      this.badRequest(
        `Invalid status transition: ${oldStatus} -> ${order.status}`,
      );
    }

    if (dto.items) {
      order.product_quantity = await this.replaceOrderItems(
        order.id,
        dto.items,
      );
    }

    // Prevent TypeORM cascade on stale one-to-many relation from nulling order_id.
    delete (order as Partial<Order> & { items?: OrderItem[] }).items;

    const writeOrderChanges = async (manager: EntityManager): Promise<void> => {
      const orderRepo = manager.getRepository(Order);
      const trackingRepo = manager.getRepository(OrderTracking);
      const custodyRepo = manager.getRepository(OrderCustodyEvent);
      await orderRepo.save(order);

      const canceledPostAccepted =
        oldStatus === Order_status.CANCELLED_SENT &&
        order.status === Order_status.CANCELLED_SENT &&
        previousCanceledPostId &&
        typeof dto.canceled_post_id !== 'undefined' &&
        dto.canceled_post_id === null;
      const canceledPostSourceBranchLabel = canceledPostAccepted
        ? await this.resolveBranchTrackingLabel(
            previousHolderBranchId,
            requester,
          )
        : null;
      const canceledPostDestinationBranchLabel = canceledPostAccepted
        ? await this.resolveBranchTrackingLabel(
            order.holder_branch_id,
            requester,
          )
        : null;
      const canceledPostAcceptedByHq =
        canceledPostAccepted &&
        (requester?.note ?? '').toLowerCase().includes('hq');
      const canceledPostSource = canceledPostSourceBranchLabel ?? 'branch';
      const canceledPostDestination = canceledPostAcceptedByHq
        ? 'HQ'
        : (canceledPostDestinationBranchLabel ?? 'branch');
      const canceledPostDescription = canceledPostAccepted
        ? `${canceledPostDestination} bekor qilingan pochtani ${canceledPostSource}dan qabul qildi`
        : undefined;

      if (oldStatus !== order.status || canceledPostAccepted) {
        await this.createTrackingEvent(
          {
            order_id: order.id,
            from_status: oldStatus,
            to_status: order.status,
            changed_by: String(requester?.id ?? 'system'),
            changed_by_role: requester?.id
              ? this.toTrackingRole(requester.roles)
              : 'system',
            action: canceledPostAccepted
              ? 'cancelled_post_received'
              : undefined,
            description: canceledPostDescription,
            old_value: canceledPostAccepted
              ? {
                  status: oldStatus,
                  canceled_post_id: previousCanceledPostId,
                  holder_type: previousHolderType,
                  holder_branch_id: previousHolderBranchId,
                  holder_courier_id: previousHolderCourierId,
                }
              : undefined,
            new_value: canceledPostAccepted
              ? {
                  status: order.status,
                  canceled_post_id: order.canceled_post_id,
                  holder_type: order.holder_type,
                  holder_branch_id: order.holder_branch_id,
                  holder_courier_id: order.holder_courier_id,
                }
              : undefined,
            metadata: canceledPostAccepted
              ? {
                  canceled_post_id: previousCanceledPostId,
                  source_branch_id: previousHolderBranchId,
                  source_branch: canceledPostSourceBranchLabel,
                  destination_branch_id: order.holder_branch_id,
                  destination_branch: canceledPostDestinationBranchLabel,
                  received_by_hq: canceledPostAcceptedByHq,
                }
              : undefined,
            note: requester?.note ?? null,
          },
          trackingRepo,
        );
      }

      if (custodyChanged) {
        await this.createCustodyEvent(
          {
            order_id: order.id,
            from_holder_type: previousHolderType ?? null,
            to_holder_type: order.holder_type,
            from_branch_id: previousHolderBranchId ?? null,
            to_branch_id: order.holder_branch_id ?? null,
            from_courier_id: previousHolderCourierId ?? null,
            to_courier_id: order.holder_courier_id ?? null,
            changed_by: String(requester?.id ?? 'system'),
            changed_by_role: requester?.id
              ? this.toTrackingRole(requester.roles)
              : 'system',
            note: requester?.note ?? 'Order custody changed',
          },
          custodyRepo,
        );
      }

      // Atomic search index update: enqueue the outbox event in the same
      // transaction so the search publisher only sees committed state.
      await this.syncOrderToSearch(order, manager);

      // Finance events on status change: operator commission earning + the
      // SELL_PROFIT ledger entry on entering a sold state, earning removal on
      // rollback. Enqueued in this transaction so events are durable iff the
      // order change commits; finance-service dedupes on order_id.
      if (oldStatus !== order.status) {
        await this.enqueueFinanceOnStatusChange(order, oldStatus, manager);
      }
    };

    if (externalManager) {
      // Caller owns the transaction; just apply writes within it and return.
      // Post-commit side-effects (search sync, external status sync) must be
      // triggered by the caller after their own commit completes.
      try {
        await writeOrderChanges(externalManager);
      } catch (error) {
        this.handleDbError(error);
      }
      return order;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await writeOrderChanges(queryRunner.manager);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.handleDbError(error);
    } finally {
      await queryRunner.release();
    }

    const updated = await this.findById(order.id);
    const newStatus = updated.status;
    if (oldStatus !== newStatus) {
      const action = this.resolveSyncAction(oldStatus, newStatus);
      if (action) {
        void this.queueExternalStatusSync(
          updated,
          action,
          oldStatus,
          newStatus,
        );
      }
    }

    // Generic edit audit. Skipped when an internal caller already recorded a
    // richer domain event (audit: false). `items` is summarised to a count so
    // a large line-item array doesn't bloat the audit row.
    if (requester?.audit !== false) {
      const { items, proof_files, ...scalarChanges } = dto;
      const changeSet: Record<string, unknown> = { ...scalarChanges };
      if (items) changeSet.items_count = items.length;
      if (typeof proof_files !== 'undefined')
        changeSet.proof_files_count = proof_files?.length ?? 0;
      await this.activityLog.log({
        entity_type: 'Order',
        entity_id: String(order.id),
        action:
          oldStatus !== newStatus
            ? ActivityAction.STATUS_CHANGE
            : ActivityAction.UPDATED,
        old_value: oldStatus !== newStatus ? { status: oldStatus } : null,
        new_value: changeSet,
        ...this.auditActor(requester),
        metadata: requester?.note ? { note: requester.note } : null,
      });
    }
    return updated;
  }

  async remove(id: string, requester?: { id?: string; roles?: string[] }) {
    const order = await this.findById(id);

    const requesterId = String(requester?.id ?? '');
    const isSuperAdmin = this.hasRole(requester, Roles.SUPERADMIN);
    const isAdmin = this.hasRole(requester, Roles.ADMIN);
    const isRegistrator = this.hasRole(requester, Roles.REGISTRATOR);
    const isMarket = this.hasRole(requester, Roles.MARKET);

    if (order.status === Order_status.CREATED) {
      const isOwnerMarket =
        isMarket && requesterId === String(order.market_id ?? '');
      if (!isOwnerMarket) {
        this.forbidden(
          "Faqat order egasi bo'lgan market 'created' holatdagi buyurtmani o‘chira oladi",
        );
      }
    } else if (order.status === Order_status.NEW) {
      const canDeleteNew = isSuperAdmin || isAdmin || isRegistrator || isMarket;
      if (!canDeleteNew) {
        this.forbidden(
          "Faqat superadmin/admin/registrator/market 'new' holatdagi buyurtmani o‘chira oladi",
        );
      }
    } else if (order.status === Order_status.RECEIVED) {
      if (!isSuperAdmin) {
        this.forbidden(
          "Faqat superadmin 'received' holatdagi buyurtmani o‘chira oladi",
        );
      }
    } else {
      this.badRequest(
        "Faqat 'created', 'new' yoki 'received' holatdagi buyurtmani o‘chirish mumkin",
      );
    }

    await this.dataSource.transaction(async (tx) => {
      order.isDeleted = true;
      await tx.getRepository(Order).save(order);
      await this.removeOrderFromSearch(id, tx);
    });

    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: String(id),
      action: ActivityAction.DELETED,
      old_value: { status: order.status, market_id: order.market_id },
      ...this.auditActor(requester),
    });

    return successRes({}, 200, `Order #${id} o'chirildi`);
  }

  // ==================== Enrichment Helpers ====================

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
    search?: string;
    start_day?: string;
    end_day?: string;
    courier?: string;
    courier_ids?: string[];
    region_id?: string;
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

  async getOverviewStats(
    startDate?: string,
    endDate?: string,
    branchId?: string,
    all = false,
  ) {
    const range = all ? null : this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();

    const acceptedQuery = this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false }),
      branchId,
    );
    const soldOrdersQuery = this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses }),
      branchId,
    ).select([
      'o.id',
      'o.market_id',
      'o.post_id',
      'o.where_deliver',
      'o.total_price',
    ]);

    if (range) {
      const startMs = String(range.start.getTime());
      const endMs = String(range.end.getTime());
      acceptedQuery.andWhere('o.createdAt BETWEEN :start AND :end', range);
      soldOrdersQuery.andWhere('o.sold_at BETWEEN :startMs AND :endMs', {
        startMs,
        endMs,
      });
    }

    const [acceptedCount, cancelled, soldOrders] = await Promise.all([
      acceptedQuery.getCount(),
      this.countHistoricallyCancelledOrders(range, branchId),
      soldOrdersQuery.getMany(),
    ]);
    const soldAndPaid = soldOrders.length;

    const marketIds = [
      ...new Set(soldOrders.map((o) => o.market_id).filter(Boolean)),
    ];
    const postIds = [
      ...new Set(soldOrders.map((o) => o.post_id).filter(Boolean) as string[]),
    ];
    const [markets, posts] = await Promise.all([
      this.getMarketsByIds(marketIds),
      this.getPostsByIds(postIds),
    ]);
    const courierIds = [
      ...new Set(posts.map((p) => p.courier_id).filter(Boolean) as string[]),
    ];
    const couriers = await this.getCouriersByIds(courierIds);

    const marketMap = new Map(markets.map((m) => [String(m.id), m]));
    const postMap = new Map(posts.map((p) => [String(p.id), p]));
    const courierMap = new Map(couriers.map((c) => [String(c.id), c]));

    let profit = 0;
    let totalRevenue = 0;
    for (const order of soldOrders) {
      totalRevenue += Number(order.total_price ?? 0);
      const market = marketMap.get(String(order.market_id));
      const courierId = order.post_id
        ? postMap.get(String(order.post_id))?.courier_id
        : null;
      const courier = courierId ? courierMap.get(String(courierId)) : null;
      if (order.where_deliver === Where_deliver.ADDRESS) {
        profit +=
          Number(market?.tariff_home ?? 0) - Number(courier?.tariff_home ?? 0);
      } else {
        profit +=
          Number(market?.tariff_center ?? 0) -
          Number(courier?.tariff_center ?? 0);
      }
    }

    return {
      acceptedCount,
      cancelled,
      soldAndPaid,
      profit,
      totalRevenue,
      from: range?.start.getTime(),
      to: range?.end.getTime(),
    };
  }

  async getMarketStats(
    startDate?: string,
    endDate?: string,
    branchId?: string,
  ) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());

    const totalsRaw = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .select('o.market_id', 'market_id')
        .addSelect('COUNT(*)', 'total')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.createdAt BETWEEN :start AND :end', { start, end })
        .andWhere('o.market_id IS NOT NULL'),
      branchId,
    )
      .groupBy('o.market_id')
      .getRawMany<{ market_id: string; total: string }>();

    const soldsRaw = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .select('o.market_id', 'market_id')
        .addSelect('COUNT(*)', 'sold')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
        .andWhere('o.market_id IS NOT NULL'),
      branchId,
    )
      .groupBy('o.market_id')
      .getRawMany<{ market_id: string; sold: string }>();

    const totalsMap = new Map(
      totalsRaw.map((r) => [String(r.market_id), Number(r.total)]),
    );
    const soldsMap = new Map(
      soldsRaw.map((r) => [String(r.market_id), Number(r.sold)]),
    );
    const marketIds = Array.from(
      new Set([...totalsMap.keys(), ...soldsMap.keys()]),
    );
    const markets = await this.getMarketsByIds(marketIds);

    const result = markets.map((market) => {
      const totalOrders = totalsMap.get(String(market.id)) ?? 0;
      const soldOrders = soldsMap.get(String(market.id)) ?? 0;
      const sellingRate =
        totalOrders > 0
          ? Number(((soldOrders * 100) / totalOrders).toFixed(2))
          : 0;
      return { market, totalOrders, soldOrders, sellingRate };
    });

    result.sort((a, b) => b.sellingRate - a.sellingRate);
    return result;
  }

  async getCourierStats(
    startDate?: string,
    endDate?: string,
    branchId?: string,
  ) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = start.getTime();
    const endMs = end.getTime();
    const postRows = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .select('o.post_id', 'post_id')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.updatedAt BETWEEN :start AND :end', { start, end })
        .andWhere('o.post_id IS NOT NULL'),
      branchId,
    )
      .groupBy('o.post_id')
      .getRawMany<{ post_id: string }>();
    const postIds = postRows.map((row) => String(row.post_id)).filter(Boolean);

    if (!postIds.length) {
      return [];
    }

    const posts = await this.getPostsByIds(postIds);

    const orders = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.post_id IN (:...postIds)', {
          postIds,
        })
        .andWhere('o.updatedAt BETWEEN :start AND :end', { start, end }),
      branchId,
    )
      .select(['o.id', 'o.status', 'o.post_id', 'o.sold_at'])
      .getMany();

    const postMap = new Map<string, { id: string; courier_id?: string | null }>(
      posts.map((post) => [String(post.id), post]),
    );
    const courierIds = [
      ...new Set(
        posts.map((post) => post.courier_id).filter(Boolean) as string[],
      ),
    ];
    const couriers = await this.getCouriersByIds(courierIds);

    const statsByCourier = new Map<string, { total: number; sold: number }>();
    for (const order of orders) {
      const courierId = order.post_id
        ? postMap.get(String(order.post_id))?.courier_id
        : null;
      if (!courierId) continue;
      const current = statsByCourier.get(String(courierId)) ?? {
        total: 0,
        sold: 0,
      };
      current.total += 1;
      const soldAt = order.sold_at ? Number(order.sold_at) : null;
      if (
        soldStatuses.includes(order.status) &&
        soldAt &&
        soldAt >= startMs &&
        soldAt <= endMs
      ) {
        current.sold += 1;
      }
      statsByCourier.set(String(courierId), current);
    }

    const result = couriers.map((courier) => {
      const stats = statsByCourier.get(String(courier.id)) ?? {
        total: 0,
        sold: 0,
      };
      const successRate =
        stats.total > 0
          ? Number(((stats.sold * 100) / stats.total).toFixed(2))
          : 0;
      return {
        courier,
        totalOrders: stats.total,
        soldOrders: stats.sold,
        successRate,
      };
    });

    result.sort((a, b) => b.successRate - a.successRate);
    return result;
  }

  async getTopMarkets(limit = 10, branchId?: string) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const totalsRaw = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .select('o.market_id', 'market_id')
        .addSelect('COUNT(*)', 'total_orders')
        .addSelect(
          `SUM(CASE WHEN o.status IN (:...statuses) THEN 1 ELSE 0 END)`,
          'successful_orders',
        )
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.createdAt >= :lastMonth', { lastMonth })
        .andWhere('o.market_id IS NOT NULL'),
      branchId,
    )
      .setParameter('statuses', soldStatuses)
      .groupBy('o.market_id')
      .getRawMany<{
        market_id: string;
        total_orders: string;
        successful_orders: string;
      }>();

    const markets = await this.getMarketsByIds(
      totalsRaw.map((r) => String(r.market_id)),
    );
    const marketMap = new Map(markets.map((m) => [String(m.id), m]));

    const result = totalsRaw
      .filter((row) => Number(row.total_orders) >= 30)
      .map((row) => {
        const totalOrders = Number(row.total_orders);
        const successfulOrders = Number(row.successful_orders);
        const successRate =
          totalOrders > 0
            ? Number(((successfulOrders * 100) / totalOrders).toFixed(2))
            : 0;
        const market = marketMap.get(String(row.market_id));
        return {
          market_id: row.market_id,
          market_name: market?.name ?? null,
          total_orders: totalOrders,
          successful_orders: successfulOrders,
          success_rate: successRate,
        };
      })
      .sort((a, b) => b.success_rate - a.success_rate)
      .slice(0, limit);

    return result;
  }

  async getTopCouriers(limit = 10, branchId?: string) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const orders = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.createdAt >= :lastMonth', { lastMonth })
        .andWhere('o.post_id IS NOT NULL'),
      branchId,
    )
      .select(['o.post_id', 'o.status'])
      .getMany();

    const posts = await this.getPostsByIds([
      ...new Set(orders.map((o) => o.post_id).filter(Boolean) as string[]),
    ]);
    const postMap = new Map(posts.map((p) => [String(p.id), p]));
    const courierIds = [
      ...new Set(posts.map((p) => p.courier_id).filter(Boolean) as string[]),
    ];
    const couriers = await this.getCouriersByIds(courierIds);
    const courierMap = new Map(couriers.map((c) => [String(c.id), c]));

    const stats = new Map<string, { total: number; successful: number }>();
    for (const order of orders) {
      const courierId = order.post_id
        ? postMap.get(String(order.post_id))?.courier_id
        : null;
      if (!courierId) continue;
      const current = stats.get(String(courierId)) ?? {
        total: 0,
        successful: 0,
      };
      current.total += 1;
      if (soldStatuses.includes(order.status)) {
        current.successful += 1;
      }
      stats.set(String(courierId), current);
    }

    return Array.from(stats.entries())
      .map(([courierId, current]) => {
        const courier = courierMap.get(courierId);
        const successRate =
          current.total > 0
            ? Number(((current.successful * 100) / current.total).toFixed(2))
            : 0;
        return {
          courier_id: courierId,
          courier_name: courier?.name ?? null,
          total_orders: current.total,
          successful_orders: current.successful,
          success_rate: successRate,
        };
      })
      .filter((row) => row.total_orders >= 30)
      .sort((a, b) => b.success_rate - a.success_rate)
      .slice(0, limit);
  }

  async getTopBranches(limit = 10, branchId?: string) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const branchExpression =
      'COALESCE(o.home_branch_id, o.branch_id, o.holder_branch_id)';
    const rows = await this.applyAnalyticsBranchScope(
      this.orderRepo
        .createQueryBuilder('o')
        .select(branchExpression, 'branch_id')
        .addSelect('COUNT(*)', 'total_orders')
        .addSelect(
          `SUM(CASE WHEN o.status IN (:...statuses) THEN 1 ELSE 0 END)`,
          'successful_orders',
        )
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.createdAt >= :lastMonth', { lastMonth })
        .andWhere(
          '(o.home_branch_id IS NOT NULL OR o.branch_id IS NOT NULL OR o.holder_branch_id IS NOT NULL)',
        ),
      branchId,
    )
      .setParameter('statuses', soldStatuses)
      .groupBy(branchExpression)
      .getRawMany<{
        branch_id: string;
        total_orders: string;
        successful_orders: string;
      }>();

    const branches = await this.getBranchesByIds(
      rows.map((row) => String(row.branch_id)),
    );
    const branchMap = new Map(branches.map((branch) => [String(branch.id), branch]));

    return rows
      .filter((row) => Number(row.total_orders) >= 30)
      .map((row) => {
        const totalOrders = Number(row.total_orders) || 0;
        const successfulOrders = Number(row.successful_orders) || 0;
        const successRate =
          totalOrders > 0
            ? Number(((successfulOrders * 100) / totalOrders).toFixed(2))
            : 0;
        const branch = branchMap.get(String(row.branch_id));
        const branchName = branch?.code
          ? `${branch.name ?? `Filial ${row.branch_id}`} (${branch.code})`
          : branch?.name;

        return {
          branch_id: String(row.branch_id),
          branch_name: branchName ?? `Filial ${row.branch_id}`,
          total_orders: totalOrders,
          successful_orders: successfulOrders,
          success_rate: successRate,
        };
      })
      .sort((a, b) => b.success_rate - a.success_rate)
      .slice(0, limit);
  }

  async getTopOperatorsByMarket(marketId: string, limit = 10) {
    const soldStatuses = this.soldStatuses();
    const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const rows = await this.orderRepo
      .createQueryBuilder('o')
      .select('o.operator_id', 'operator_id')
      .addSelect('COUNT(*)', 'total_orders')
      .addSelect(
        `SUM(CASE WHEN o.status IN (:...statuses) THEN 1 ELSE 0 END)`,
        'successful_orders',
      )
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.market_id = :marketId', { marketId })
      .andWhere('o.createdAt >= :lastMonth', { lastMonth })
      .andWhere('o.operator_id IS NOT NULL')
      .setParameter('statuses', soldStatuses)
      .groupBy('o.operator_id')
      .getRawMany<{
        operator_id: string;
        total_orders: string;
        successful_orders: string;
      }>();

    if (!rows.length) {
      return [];
    }

    const operators = await this.getAllOperatorUsers();
    const byId = new Map<string, any>();

    for (const operator of operators) {
      if (marketId && String(operator?.market_id ?? '') !== String(marketId)) {
        continue;
      }
      const idKey = String(operator?.id ?? '').trim();
      if (idKey) byId.set(idKey, operator);
    }

    return rows
      .map((row) => {
        const totalOrders = Number(row.total_orders) || 0;
        const successfulOrders = Number(row.successful_orders) || 0;
        const successRate =
          totalOrders > 0
            ? Number(((successfulOrders * 100) / totalOrders).toFixed(2))
            : 0;
        const operatorId = String(row.operator_id ?? '').trim();
        const matched = byId.get(operatorId) ?? null;

        return {
          operator_id: operatorId || null,
          operator_name: matched?.name ?? matched?.username ?? null,
          total_orders: totalOrders,
          successful_orders: successfulOrders,
          success_rate: successRate,
        };
      })
      .sort((a, b) => b.success_rate - a.success_rate)
      .slice(0, limit);
  }

  async getCourierStat(
    courierId: string,
    startDate?: string,
    endDate?: string,
    all = false,
  ) {
    const range = all ? null : this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const courierPosts = (await this.getAllPostsForAnalytics()).filter(
      (post) => {
        return String(post.courier_id) === String(courierId);
      },
    );

    const postIds = courierPosts.map((post) => post.id);
    const totalOrdersQuery = this.applyAnalyticsCourierScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false }),
      courierId,
      postIds,
    );
    const soldOrdersQuery = this.applyAnalyticsCourierScope(
      this.orderRepo
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses }),
      courierId,
      postIds,
    );

    if (range) {
      const startMs = String(range.start.getTime());
      const endMs = String(range.end.getTime());
      totalOrdersQuery.andWhere('o.updatedAt BETWEEN :start AND :end', range);
      soldOrdersQuery.andWhere('o.sold_at BETWEEN :startMs AND :endMs', {
        startMs,
        endMs,
      });
    }

    const [totalOrders, canceledOrders, soldOrderEntities] = await Promise.all([
      totalOrdersQuery.getCount(),
      this.countHistoricallyCancelledOrders(range, undefined, courierId, postIds),
      soldOrdersQuery.getMany(),
    ]);
    const soldOrders = soldOrderEntities.length;

    const couriers = await this.getCouriersByIds([courierId]);
    const courier = couriers[0];

    let profit = 0;
    for (const order of soldOrderEntities) {
      profit +=
        order.where_deliver === Where_deliver.ADDRESS
          ? Number(courier?.tariff_home ?? 0)
          : Number(courier?.tariff_center ?? 0);
    }

    const successRate =
      totalOrders > 0
        ? Number(((soldOrders * 100) / totalOrders).toFixed(2))
        : 0;

    return {
      totalOrders,
      soldOrders,
      canceledOrders,
      profit,
      successRate,
    };
  }

  async getMarketStat(marketId: string, startDate?: string, endDate?: string) {
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());

    const allOrders = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.createdAt BETWEEN :start AND :end', { start, end })
      .andWhere('o.market_id = :marketId', { marketId })
      .getMany();

    if (!allOrders.length) {
      return {
        totalOrders: 0,
        soldOrders: 0,
        canceledOrders: 0,
        inProgress: 0,
        profit: 0,
        successRate: 0,
      };
    }

    const orderIds = allOrders.map((order) => order.id);

    const activeStatuses = this.activeMarketStatuses();
    const [soldOrders, canceledOrders, inProgress, soldOrderEntities] =
      await Promise.all([
        this.orderRepo
          .createQueryBuilder('o')
          .where('o.isDeleted = :isDeleted', { isDeleted: false })
          .andWhere('o.id IN (:...orderIds)', { orderIds })
          .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
          .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
          .getCount(),
        this.orderRepo
          .createQueryBuilder('o')
          .where('o.isDeleted = :isDeleted', { isDeleted: false })
          .andWhere('o.id IN (:...orderIds)', { orderIds })
          .andWhere('o.updatedAt BETWEEN :start AND :end', { start, end })
          .andWhere('o.status = :status', { status: Order_status.CANCELLED })
          .getCount(),
        this.orderRepo
          .createQueryBuilder('o')
          .where('o.isDeleted = :isDeleted', { isDeleted: false })
          .andWhere('o.id IN (:...orderIds)', { orderIds })
          .andWhere('o.status IN (:...statuses)', { statuses: activeStatuses })
          .getCount(),
        this.orderRepo
          .createQueryBuilder('o')
          .where('o.isDeleted = :isDeleted', { isDeleted: false })
          .andWhere('o.id IN (:...orderIds)', { orderIds })
          .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
          .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
          .getMany(),
      ]);

    const profit = soldOrderEntities.reduce(
      (sum, order) => sum + Number(order.to_be_paid ?? 0),
      0,
    );
    const successRate =
      allOrders.length > 0
        ? Number(((soldOrders * 100) / allOrders.length).toFixed(2))
        : 0;

    return {
      totalOrders: allOrders.length,
      soldOrders,
      canceledOrders,
      inProgress,
      profit,
      successRate,
    };
  }

  async getRevenueStats(
    startDate?: string,
    endDate?: string,
    period = 'daily',
  ) {
    const normalizedPeriod = this.normalizeRevenuePeriod(period);
    const { start, end } = this.analyticsDateRange(startDate, endDate);
    const soldStatuses = this.soldStatuses();
    const startMs = String(start.getTime());
    const endMs = String(end.getTime());

    const soldOrders = await this.orderRepo
      .createQueryBuilder('o')
      .where('o.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('o.sold_at BETWEEN :startMs AND :endMs', { startMs, endMs })
      .andWhere('o.status IN (:...statuses)', { statuses: soldStatuses })
      .select(['o.id', 'o.total_price', 'o.sold_at'])
      .getMany();

    const buckets = new Map<
      string,
      { period: string; label: string; ordersCount: number; revenue: number }
    >();
    let cursor = this.periodStart(start, normalizedPeriod);
    const endCursor = this.periodStart(end, normalizedPeriod);

    while (cursor <= endCursor) {
      const key = this.periodKey(cursor, normalizedPeriod);
      buckets.set(key, {
        period: key,
        label: this.periodLabel(cursor, normalizedPeriod),
        ordersCount: 0,
        revenue: 0,
      });
      cursor = this.nextPeriodStart(cursor, normalizedPeriod);
    }

    for (const order of soldOrders) {
      if (!order.sold_at) continue;
      const soldDate = new Date(Number(order.sold_at));
      const key = this.periodKey(soldDate, normalizedPeriod);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.ordersCount += 1;
      bucket.revenue += Number(order.total_price ?? 0);
    }

    const data = Array.from(buckets.values());
    const totalRevenue = data.reduce((sum, row) => sum + row.revenue, 0);
    const totalOrders = data.reduce((sum, row) => sum + row.ordersCount, 0);
    const avgRevenue = data.length ? Math.round(totalRevenue / data.length) : 0;

    return {
      data,
      summary: {
        totalRevenue,
        totalOrders,
        avgRevenue,
      },
    };
  }

  private transferTokenPrefix(
    direction: BranchTransferDirection,
  ): 'BTB' | 'BTR' {
    return direction === BranchTransferDirection.RETURN ? 'BTR' : 'BTB';
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

  private normalizeInboxMessageId(value?: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      this.badRequest('message_id is required');
    }
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(normalized)) {
      this.badRequest('message_id must match /^[A-Za-z0-9:_-]{8,128}$/');
    }
    return normalized;
  }

  private isDuplicateMessageError(error: unknown): boolean {
    const code = (
      error as { code?: string; driverError?: { code?: string } } | null
    )?.code;
    const driverCode = (error as { driverError?: { code?: string } } | null)
      ?.driverError?.code;
    return code === '23505' || driverCode === '23505';
  }

  private async generateTransferQrToken(
    repo: Repository<BranchTransferBatch>,
    direction: BranchTransferDirection,
  ): Promise<string> {
    const prefix = this.transferTokenPrefix(direction);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const suffix =
        `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
      const candidate = `${prefix}-${suffix}`;
      const exists = await repo.findOne({
        where: {
          qr_code_token: candidate,
          isDeleted: false,
        },
        select: ['id'],
      });
      if (!exists) {
        return candidate;
      }
    }
    throw new RpcException({
      statusCode: 500,
      message: 'QR token generate failed',
    });
  }

  private async listBatchesWithItems(batchIds: string[]) {
    if (!batchIds.length) {
      return [];
    }

    const batches = await this.transferBatchRepo.find({
      where: { id: In(batchIds), isDeleted: false },
      order: { createdAt: 'ASC' },
    });
    const items = await this.transferBatchItemRepo.find({
      where: { batch_id: In(batchIds), isDeleted: false },
      order: { createdAt: 'ASC' },
    });

    const itemsByBatch = new Map<string, BranchTransferBatchItem[]>();
    for (const item of items) {
      const list = itemsByBatch.get(String(item.batch_id)) ?? [];
      list.push(item);
      itemsByBatch.set(String(item.batch_id), list);
    }

    return batches.map((batch) => ({
      ...batch,
      items: (itemsByBatch.get(String(batch.id)) ?? []).map((item) => ({
        id: item.id,
        order_id: item.order_id,
        snapshot_price: item.snapshot_price,
        snapshot_market_id: item.snapshot_market_id,
      })),
    }));
  }

  async createBranchTransferBatches(input: {
    source_branch_id: string;
    destination_branch_id: string;
    order_ids?: string[];
    direction?: BranchTransferDirection | string;
    request_key?: string;
    requester_id?: string;
  }) {
    const sourceBranchId = String(input?.source_branch_id ?? '').trim();
    const destinationBranchId = String(
      input?.destination_branch_id ?? '',
    ).trim();
    const requesterId = String(input?.requester_id ?? '').trim() || '0';
    const direction = this.normalizeTransferDirection(input?.direction);
    const requestKey = this.normalizeTransferRequestKey(input?.request_key);
    const maxRegionalPendingBatches = 13;

    if (!sourceBranchId || !destinationBranchId) {
      this.badRequest(
        'source_branch_id and destination_branch_id are required',
      );
    }

    const existing = await this.transferBatchRepo.find({
      where: {
        source_branch_id: sourceBranchId,
        request_key: requestKey,
        status: In([
          BranchTransferBatchStatus.PENDING,
          BranchTransferBatchStatus.SENT,
          BranchTransferBatchStatus.RECEIVED,
        ]),
        isDeleted: false,
      },
      order: { createdAt: 'ASC' },
    });

    if (existing.length) {
      const existingList = await this.listBatchesWithItems(
        existing.map((batch) => String(batch.id)),
      );
      return successRes(
        {
          idempotent: true,
          batches: existingList,
        },
        200,
        'Branch transfer batches (idempotent)',
      );
    }

    const selectedOrderIds = Array.from(
      new Set(
        (input?.order_ids ?? [])
          .map((id) => String(id ?? '').trim())
          .filter(Boolean),
      ),
    );
    const whereClause: {
      branch_id: string;
      current_batch_id: ReturnType<typeof IsNull>;
      isDeleted: false;
      status: Order_status;
      id?: ReturnType<typeof In>;
    } = {
      branch_id: sourceBranchId,
      current_batch_id: IsNull(),
      isDeleted: false,
      status: Order_status.NEW,
    };
    if (selectedOrderIds.length) {
      whereClause.id = In(selectedOrderIds);
    }

    const unassignedOrders = await this.orderRepo.find({
      where: whereClause,
      select: ['id', 'region_id', 'market_id', 'total_price'],
      order: { createdAt: 'ASC' },
    });

    if (
      selectedOrderIds.length &&
      unassignedOrders.length !== selectedOrderIds.length
    ) {
      this.badRequest(
        'Some orders are not found, not NEW, or already assigned to another batch',
      );
    }

    const candidateOrders = unassignedOrders.filter((order) =>
      Boolean(order.region_id),
    );
    if (!candidateOrders.length) {
      this.badRequest('Unassigned orders for transfer not found');
    }

    const grouped = new Map<string, Order[]>();
    for (const order of candidateOrders) {
      const regionId = String(order.region_id);
      const list = grouped.get(regionId) ?? [];
      list.push(order);
      grouped.set(regionId, list);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const batchRepo = queryRunner.manager.getRepository(BranchTransferBatch);
      const batchItemRepo = queryRunner.manager.getRepository(
        BranchTransferBatchItem,
      );
      const batchHistoryRepo = queryRunner.manager.getRepository(
        BranchTransferBatchHistory,
      );
      const orderRepo = queryRunner.manager.getRepository(Order);

      const pendingBatches = await batchRepo.find({
        where: {
          source_branch_id: sourceBranchId,
          destination_branch_id: destinationBranchId,
          direction,
          status: BranchTransferBatchStatus.PENDING,
          isDeleted: false,
        },
        order: { createdAt: 'ASC' },
      });

      const batchByRegion = new Map<string, BranchTransferBatch>();
      for (const batch of pendingBatches) {
        const regionId = String(batch.target_region_id ?? '').trim();
        if (regionId && !batchByRegion.has(regionId)) {
          batchByRegion.set(regionId, batch);
        }
      }

      const missingRegionIds = Array.from(grouped.keys()).filter(
        (regionId) => !batchByRegion.has(regionId),
      );
      const currentPendingRegionsCount = batchByRegion.size;
      if (
        currentPendingRegionsCount + missingRegionIds.length >
        maxRegionalPendingBatches
      ) {
        this.badRequest(
          `Maximum ${maxRegionalPendingBatches} ta pending transfer batch bo‘lishi mumkin`,
        );
      }

      const newBatchEntities: BranchTransferBatch[] = [];
      for (const regionId of missingRegionIds) {
        const qrToken = await this.generateTransferQrToken(
          batchRepo,
          direction,
        );
        newBatchEntities.push(
          batchRepo.create({
            qr_code_token: qrToken,
            request_key: requestKey,
            source_branch_id: sourceBranchId,
            destination_branch_id: destinationBranchId,
            direction,
            target_region_id: regionId,
            status: BranchTransferBatchStatus.PENDING,
            order_count: 0,
            total_price: 0,
            vehicle_plate: null,
            driver_name: null,
            driver_phone: null,
            sent_at: null,
            received_at: null,
            cancelled_at: null,
          }),
        );
      }

      const savedNewBatches = newBatchEntities.length
        ? await batchRepo.save(newBatchEntities)
        : [];
      for (const batch of savedNewBatches) {
        batchByRegion.set(String(batch.target_region_id), batch);
      }

      const itemEntities: BranchTransferBatchItem[] = [];
      const historyEntities: BranchTransferBatchHistory[] = [];
      const touchedBatchIds = new Set<string>();

      for (const [regionId, orders] of grouped.entries()) {
        const batch = batchByRegion.get(regionId);
        if (!batch) {
          throw new RpcException({
            statusCode: 500,
            message: 'Batch create failed',
          });
        }
        touchedBatchIds.add(String(batch.id));

        const orderIds = orders.map((order) => String(order.id));
        const updateResult = await orderRepo
          .createQueryBuilder()
          .update(Order)
          .set({ current_batch_id: String(batch.id) })
          .where('id IN (:...orderIds)', { orderIds })
          .andWhere('"current_batch_id" IS NULL')
          .andWhere('"is_deleted" = false')
          .execute();

        if (Number(updateResult.affected ?? 0) !== orderIds.length) {
          throw new RpcException({
            statusCode: 409,
            message: 'Some orders are already assigned to another batch',
          });
        }

        const regionTotalPrice = orders.reduce(
          (sum, order) => sum + Number(order.total_price ?? 0),
          0,
        );
        batch.order_count = Number(batch.order_count ?? 0) + orders.length;
        batch.total_price = Number(batch.total_price ?? 0) + regionTotalPrice;
        await batchRepo.save(batch);

        for (const order of orders) {
          itemEntities.push(
            batchItemRepo.create({
              batch_id: String(batch.id),
              order_id: String(order.id),
              snapshot_price: Number(order.total_price ?? 0),
              snapshot_market_id: String(order.market_id),
            }),
          );
        }

        historyEntities.push(
          batchHistoryRepo.create({
            batch_id: String(batch.id),
            user_id: requesterId,
            action: BranchTransferBatchAction.CREATED,
            notes: missingRegionIds.includes(regionId)
              ? '[STEP] BATCH_CREATED'
              : '[STEP] BATCH_REUSED',
          }),
        );
        historyEntities.push(
          batchHistoryRepo.create({
            batch_id: String(batch.id),
            user_id: requesterId,
            action: BranchTransferBatchAction.CREATED,
            notes: '[STEP] ORDERS_ASSIGNED',
          }),
        );
      }

      await batchItemRepo.save(itemEntities);
      await batchHistoryRepo.save(historyEntities);
      await queryRunner.commitTransaction();

      const touchedBatchIdList = Array.from(touchedBatchIds);
      await this.activityLog.log({
        entity_type: 'BranchTransferBatch',
        entity_id: touchedBatchIdList[0] ?? sourceBranchId,
        action: ActivityAction.CREATED,
        ...this.auditActor({ id: requesterId }),
        metadata: {
          source_branch_id: sourceBranchId,
          destination_branch_id: destinationBranchId,
          direction,
          batch_ids: touchedBatchIdList,
          order_count: candidateOrders.length,
          order_ids: candidateOrders.slice(0, 20).map((o) => String(o.id)),
        },
      });

      const batches = await this.listBatchesWithItems(touchedBatchIdList);
      return successRes(
        {
          idempotent: false,
          batches,
        },
        201,
        'Branch transfer batches created',
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async createBranchReturnBatches(input: {
    source_branch_id: string;
    order_ids: string[];
    request_key?: string;
    requester_id?: string;
    notes?: string | null;
  }) {
    const sourceBranchId = String(input?.source_branch_id ?? '').trim();
    const requesterId = String(input?.requester_id ?? '').trim() || '0';
    const requestKey = this.normalizeTransferRequestKey(input?.request_key);
    const direction = BranchTransferDirection.RETURN;
    const orderIds = Array.from(
      new Set(
        (input?.order_ids ?? [])
          .map((id) => String(id ?? '').trim())
          .filter(Boolean),
      ),
    );

    if (!sourceBranchId) {
      this.badRequest('source_branch_id is required');
    }
    if (!orderIds.length) {
      this.badRequest('order_ids is required');
    }

    const existing = await this.transferBatchRepo.find({
      where: {
        source_branch_id: sourceBranchId,
        request_key: requestKey,
        status: In([
          BranchTransferBatchStatus.PENDING,
          BranchTransferBatchStatus.SENT,
          BranchTransferBatchStatus.RECEIVED,
        ]),
        isDeleted: false,
      },
      order: { createdAt: 'ASC' },
    });

    if (existing.length) {
      const existingList = await this.listBatchesWithItems(
        existing.map((batch) => String(batch.id)),
      );
      return successRes(
        {
          idempotent: true,
          batches: existingList,
        },
        200,
        'Branch return batches (idempotent)',
      );
    }

    const orders = await this.orderRepo.find({
      where: {
        id: In(orderIds),
        current_batch_id: IsNull(),
        isDeleted: false,
      },
      select: [
        'id',
        'branch_id',
        'home_branch_id',
        'region_id',
        'market_id',
        'total_price',
        'status',
      ],
    });

    if (orders.length !== orderIds.length) {
      this.badRequest(
        'Some orders are not found or already assigned to another batch',
      );
    }

    // Status eligibility (Audit I11): money-bearing (SOLD/PAID/PARTLY_PAID) and
    // already-terminal (RETURNED_TO_MARKET/CLOSED) orders must NOT enter a RETURN
    // batch — a sold order would otherwise reach RETURNED_TO_MARKET with its
    // collected COD still owed up the chain. Roll such orders back first.
    const ineligibleReturn = orders.filter((order) =>
      [
        Order_status.SOLD,
        Order_status.PAID,
        Order_status.PARTLY_PAID,
        Order_status.RETURNED_TO_MARKET,
        Order_status.CLOSED,
      ].includes(order.status),
    );
    if (ineligibleReturn.length) {
      this.badRequest(
        `Quyidagi buyurtmalar holati return paketiga mos emas (avval rollback qiling): ${ineligibleReturn
          .map((order) => String(order.id))
          .join(', ')}`,
      );
    }

    // A return ships goods from where they currently are (source) back to the
    // order's HOME (owning) branch. If an order's home IS the source branch it
    // is already home — it must be handed to the market directly, not via a
    // cross-branch return batch (which can't target its own source).
    const resolveReturnDestination = (order: {
      home_branch_id?: string | null;
      branch_id?: string | null;
    }): string => String(order.home_branch_id ?? order.branch_id ?? '').trim();

    const invalidSourceOrder = orders.find(
      (order) => resolveReturnDestination(order) === sourceBranchId,
    );
    if (invalidSourceOrder) {
      this.badRequest(
        "Bu order allaqachon o'z (home) filialida — uni return paket bilan emas, to'g'ridan-to'g'ri market egasiga topshiring",
      );
    }

    const groupedByDestinationBranch = new Map<string, Order[]>();
    for (const order of orders) {
      const destinationBranchId = resolveReturnDestination(order);
      if (!destinationBranchId) {
        this.badRequest(`Order ${String(order.id)} has no home branch_id`);
      }
      const list = groupedByDestinationBranch.get(destinationBranchId) ?? [];
      list.push(order);
      groupedByDestinationBranch.set(destinationBranchId, list);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const batchRepo = queryRunner.manager.getRepository(BranchTransferBatch);
      const batchItemRepo = queryRunner.manager.getRepository(
        BranchTransferBatchItem,
      );
      const batchHistoryRepo = queryRunner.manager.getRepository(
        BranchTransferBatchHistory,
      );
      const orderRepo = queryRunner.manager.getRepository(Order);

      const newlyCreatedBatchEntities: BranchTransferBatch[] = [];
      const batchByDestinationBranch = new Map<string, BranchTransferBatch>();
      for (const [
        destinationBranchId,
        branchOrders,
      ] of groupedByDestinationBranch.entries()) {
        const totalPrice = branchOrders.reduce(
          (sum, order) => sum + Number(order.total_price ?? 0),
          0,
        );
        const targetRegionId = String(branchOrders[0]?.region_id ?? '').trim();
        if (!targetRegionId) {
          this.badRequest(
            `Orders for destination branch ${destinationBranchId} must have region_id`,
          );
        }

        const existingPendingBatch = await batchRepo.findOne({
          where: {
            source_branch_id: sourceBranchId,
            destination_branch_id: destinationBranchId,
            direction,
            target_region_id: targetRegionId,
            status: BranchTransferBatchStatus.PENDING,
            isDeleted: false,
          },
          order: { createdAt: 'DESC' },
        });

        if (existingPendingBatch) {
          existingPendingBatch.order_count =
            Number(existingPendingBatch.order_count ?? 0) + branchOrders.length;
          existingPendingBatch.total_price =
            Number(existingPendingBatch.total_price ?? 0) + totalPrice;
          await batchRepo.save(existingPendingBatch);
          batchByDestinationBranch.set(
            destinationBranchId,
            existingPendingBatch,
          );
          continue;
        }

        const qrToken = await this.generateTransferQrToken(
          batchRepo,
          direction,
        );
        const newBatch = batchRepo.create({
          qr_code_token: qrToken,
          request_key: requestKey,
          source_branch_id: sourceBranchId,
          destination_branch_id: destinationBranchId,
          direction,
          target_region_id: targetRegionId,
          status: BranchTransferBatchStatus.PENDING,
          order_count: branchOrders.length,
          total_price: totalPrice,
          vehicle_plate: null,
          driver_name: null,
          driver_phone: null,
          sent_at: null,
          received_at: null,
          cancelled_at: null,
        });
        const savedNewBatch = await batchRepo.save(newBatch);
        newlyCreatedBatchEntities.push(savedNewBatch);
        batchByDestinationBranch.set(destinationBranchId, savedNewBatch);
      }

      const itemEntities: BranchTransferBatchItem[] = [];
      const historyEntities: BranchTransferBatchHistory[] = [];

      for (const [
        destinationBranchId,
        branchOrders,
      ] of groupedByDestinationBranch.entries()) {
        const batch = batchByDestinationBranch.get(destinationBranchId);
        if (!batch) {
          throw new RpcException({
            statusCode: 500,
            message: 'Return batch create failed',
          });
        }

        const branchOrderIds = branchOrders.map((order) => String(order.id));
        const updateResult = await orderRepo
          .createQueryBuilder()
          .update(Order)
          .set({ current_batch_id: String(batch.id) })
          .where('id IN (:...orderIds)', { orderIds: branchOrderIds })
          .andWhere('"current_batch_id" IS NULL')
          .andWhere('"is_deleted" = false')
          .execute();

        if (Number(updateResult.affected ?? 0) !== branchOrderIds.length) {
          throw new RpcException({
            statusCode: 409,
            message: 'Some orders are already assigned to another batch',
          });
        }

        for (const order of branchOrders) {
          itemEntities.push(
            batchItemRepo.create({
              batch_id: String(batch.id),
              order_id: String(order.id),
              snapshot_price: Number(order.total_price ?? 0),
              snapshot_market_id: String(order.market_id),
            }),
          );
        }

        historyEntities.push(
          batchHistoryRepo.create({
            batch_id: String(batch.id),
            user_id: requesterId,
            action: BranchTransferBatchAction.CREATED,
            notes: newlyCreatedBatchEntities.some(
              (created) => String(created.id) === String(batch.id),
            )
              ? `[STEP] RETURN_BATCH_CREATED${input?.notes ? ` | ${String(input.notes).trim()}` : ''}`
              : `[STEP] RETURN_BATCH_APPENDED${input?.notes ? ` | ${String(input.notes).trim()}` : ''}`,
          }),
        );
        historyEntities.push(
          batchHistoryRepo.create({
            batch_id: String(batch.id),
            user_id: requesterId,
            action: BranchTransferBatchAction.CREATED,
            notes: '[STEP] ORDERS_ASSIGNED',
          }),
        );
      }

      await batchItemRepo.save(itemEntities);
      await batchHistoryRepo.save(historyEntities);
      await queryRunner.commitTransaction();

      const affectedBatchIds = [
        ...new Set(
          [...batchByDestinationBranch.values()].map((batch) =>
            String(batch.id),
          ),
        ),
      ];
      await this.activityLog.log({
        entity_type: 'BranchTransferBatch',
        entity_id: affectedBatchIds[0] ?? sourceBranchId,
        action: ActivityAction.CREATED,
        ...this.auditActor({ id: requesterId }),
        metadata: {
          source_branch_id: sourceBranchId,
          direction,
          batch_ids: affectedBatchIds,
          order_count: orders.length,
          order_ids: orders.slice(0, 20).map((o) => String(o.id)),
        },
      });
      const batches = await this.listBatchesWithItems(affectedBatchIds);
      return successRes(
        {
          idempotent: false,
          batches,
        },
        201,
        'Branch return batches created',
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async cancelBranchTransferBatches(input: {
    batch_ids: string[];
    remove_order_bindings?: boolean;
    requester_id?: string;
    notes?: string | null;
  }) {
    const batchIds = Array.from(
      new Set(
        (input?.batch_ids ?? []).map((id) => String(id).trim()).filter(Boolean),
      ),
    );
    if (!batchIds.length) {
      this.badRequest('batch_ids is required');
    }

    const requesterId = String(input?.requester_id ?? '').trim() || '0';
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const batchRepo = queryRunner.manager.getRepository(BranchTransferBatch);
      const batchHistoryRepo = queryRunner.manager.getRepository(
        BranchTransferBatchHistory,
      );
      const orderRepo = queryRunner.manager.getRepository(Order);

      const now = new Date();
      await batchRepo
        .createQueryBuilder()
        .update(BranchTransferBatch)
        .set({
          status: BranchTransferBatchStatus.CANCELLED,
          cancelled_at: now,
        })
        .where('id IN (:...batchIds)', { batchIds })
        .andWhere('"is_deleted" = false')
        .execute();

      let unboundOrderCount = 0;
      if (input?.remove_order_bindings) {
        const unbindResult = await orderRepo
          .createQueryBuilder()
          .update(Order)
          .set({ current_batch_id: null })
          .where('"current_batch_id" IN (:...batchIds)', { batchIds })
          .andWhere('"is_deleted" = false')
          .execute();
        unboundOrderCount = Number(unbindResult.affected ?? 0);
      }

      const histories = batchIds.map((batchId) =>
        batchHistoryRepo.create({
          batch_id: batchId,
          user_id: requesterId,
          action: BranchTransferBatchAction.CANCELLED,
          notes: input?.notes?.trim() || null,
        }),
      );
      await batchHistoryRepo.save(histories);

      await queryRunner.commitTransaction();
      await this.activityLog.log({
        entity_type: 'BranchTransferBatch',
        entity_id: batchIds[0],
        action: ActivityAction.STATUS_CHANGE,
        new_value: { status: BranchTransferBatchStatus.CANCELLED },
        ...this.auditActor({ id: requesterId }),
        metadata: {
          batch_ids: batchIds,
          order_count: unboundOrderCount,
          remove_order_bindings: Boolean(input?.remove_order_bindings),
        },
      });
      return successRes(
        { batch_ids: batchIds },
        200,
        'Branch transfer batches cancelled',
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async bulkAssignBatch(input: {
    batch_id?: string;
    order_ids?: string[];
    message_id?: string;
  }) {
    const batchId = String(input?.batch_id ?? '').trim();
    if (!batchId) {
      this.badRequest('batch_id is required');
    }

    const messageId = this.normalizeInboxMessageId(input?.message_id);
    const orderIds = Array.from(
      new Set(
        (input?.order_ids ?? []).map((id) => String(id).trim()).filter(Boolean),
      ),
    );

    if (!orderIds.length) {
      this.badRequest('order_ids is required');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const inboxRepo = queryRunner.manager.getRepository(
        OrderBatchInboxMessage,
      );
      const orderRepo = queryRunner.manager.getRepository(Order);

      try {
        await inboxRepo.insert(
          inboxRepo.create({
            command: 'order.bulk_assign_batch',
            message_id: messageId,
          }),
        );
      } catch (error) {
        if (this.isDuplicateMessageError(error)) {
          await queryRunner.rollbackTransaction();
          return successRes(
            {
              idempotent: true,
              message_id: messageId,
              batch_id: batchId,
            },
            200,
            'Bulk assign already processed',
          );
        }
        throw error;
      }

      // current_batch_id IS NULL guards against concurrent batches racing for
      // the same order (each batch insert here is atomic; affected-count
      // mismatch below triggers rollback if any order was already taken).
      const result = await orderRepo
        .createQueryBuilder()
        .update(Order)
        .set({ current_batch_id: batchId })
        .where('id IN (:...orderIds)', { orderIds })
        .andWhere('"is_deleted" = false')
        .andWhere('current_batch_id IS NULL')
        .execute();

      if (Number(result.affected ?? 0) !== orderIds.length) {
        throw new RpcException({
          statusCode: 409,
          message:
            'Some orders are not found or already assigned to another batch',
        });
      }

      await queryRunner.commitTransaction();
      await this.activityLog.log({
        entity_type: 'Order',
        entity_id: batchId,
        action: ActivityAction.ASSIGN,
        metadata: {
          batch_id: batchId,
          message_id: messageId,
          order_count: orderIds.length,
          order_ids: orderIds.slice(0, 20),
        },
      });
      return successRes(
        {
          idempotent: false,
          message_id: messageId,
          batch_id: batchId,
          affected: Number(result.affected ?? 0),
        },
        200,
        'Orders assigned to batch',
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async bulkRemoveFromBatch(input: { batch_id?: string; message_id?: string }) {
    const batchId = String(input?.batch_id ?? '').trim();
    if (!batchId) {
      this.badRequest('batch_id is required');
    }

    const messageId = this.normalizeInboxMessageId(input?.message_id);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const inboxRepo = queryRunner.manager.getRepository(
        OrderBatchInboxMessage,
      );
      const orderRepo = queryRunner.manager.getRepository(Order);

      try {
        await inboxRepo.insert(
          inboxRepo.create({
            command: 'order.bulk_remove_from_batch',
            message_id: messageId,
          }),
        );
      } catch (error) {
        if (this.isDuplicateMessageError(error)) {
          await queryRunner.rollbackTransaction();
          return successRes(
            {
              idempotent: true,
              message_id: messageId,
              batch_id: batchId,
            },
            200,
            'Bulk remove already processed',
          );
        }
        throw error;
      }

      const result = await orderRepo
        .createQueryBuilder()
        .update(Order)
        .set({ current_batch_id: null })
        .where('"current_batch_id" = :batchId', { batchId })
        .andWhere('"is_deleted" = false')
        .execute();

      await queryRunner.commitTransaction();
      await this.activityLog.log({
        entity_type: 'Order',
        entity_id: batchId,
        action: ActivityAction.UNASSIGN,
        metadata: {
          batch_id: batchId,
          message_id: messageId,
          order_count: Number(result.affected ?? 0),
        },
      });
      return successRes(
        {
          idempotent: false,
          message_id: messageId,
          batch_id: batchId,
          affected: Number(result.affected ?? 0),
        },
        200,
        'Orders removed from batch',
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async addBranchTransferBatchHistory(input: {
    batch_id?: string;
    user_id?: string;
    action?: BranchTransferBatchAction | string;
    notes?: string | null;
  }) {
    const batchId = String(input?.batch_id ?? '').trim();
    if (!batchId) {
      this.badRequest('batch_id is required');
    }

    const userId = String(input?.user_id ?? '').trim() || '0';
    const actionRaw = String(input?.action ?? BranchTransferBatchAction.CREATED)
      .trim()
      .toUpperCase();
    const allowedActions = new Set<string>(
      Object.values(BranchTransferBatchAction),
    );
    if (!allowedActions.has(actionRaw)) {
      this.badRequest(
        `action must be one of: ${Object.values(BranchTransferBatchAction).join(', ')}`,
      );
    }

    const batch = await this.transferBatchRepo.findOne({
      where: { id: batchId, isDeleted: false },
      select: ['id'],
    });
    if (!batch) {
      this.notFound('Transfer batch not found');
    }

    const entity = this.transferBatchHistoryRepo.create({
      batch_id: batchId,
      user_id: userId,
      action: actionRaw as BranchTransferBatchAction,
      notes: input?.notes?.trim() || null,
    });
    await this.transferBatchHistoryRepo.save(entity);
    await this.activityLog.log({
      entity_type: 'BranchTransferBatchHistory',
      entity_id: batchId,
      action: ActivityAction.CREATED,
      ...this.auditActor({ id: userId }),
      metadata: { batch_id: batchId, action_in_history: actionRaw },
    });
    return successRes(entity, 201, 'Transfer batch history added');
  }

  async findBranchTransferBatchById(batchId: string) {
    const id = String(batchId ?? '').trim();
    if (!id) {
      this.badRequest('batch_id is required');
    }

    const batch = await this.transferBatchRepo.findOne({
      where: { id, isDeleted: false },
    });
    if (!batch) {
      this.notFound('Transfer batch not found');
    }

    const items = await this.transferBatchItemRepo.find({
      where: { batch_id: String(batch.id), isDeleted: false },
      order: { createdAt: 'ASC' },
    });

    return successRes(
      {
        ...batch,
        items: items.map((item) => ({
          id: item.id,
          order_id: item.order_id,
          snapshot_price: item.snapshot_price,
          snapshot_market_id: item.snapshot_market_id,
          sent_at: item.sent_at,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
      },
      200,
      'Transfer batch found',
    );
  }

  async findBranchTransferBatches(input: {
    source_branch_id?: string;
    destination_branch_id?: string;
    status?: string;
    direction?: string;
    period?: string;
    date?: string;
    page?: number;
    limit?: number;
  }) {
    const sourceBranchId = String(input?.source_branch_id ?? '').trim();
    const destinationBranchId = String(
      input?.destination_branch_id ?? '',
    ).trim();
    const statusRaw = String(input?.status ?? '')
      .trim()
      .toUpperCase();
    const directionRaw = String(input?.direction ?? '')
      .trim()
      .toUpperCase();
    const periodRaw = String(input?.period ?? '')
      .trim()
      .toLowerCase();
    const dateRaw = String(input?.date ?? '').trim();

    const page = Number(input?.page) > 0 ? Number(input?.page) : 1;
    const limit =
      Number(input?.limit) > 0 ? Math.min(Number(input?.limit), 100) : 20;
    const skip = (page - 1) * limit;

    const qb = this.transferBatchRepo
      .createQueryBuilder('batch')
      .where('batch.isDeleted = :isDeleted', { isDeleted: false });

    if (sourceBranchId) {
      qb.andWhere('batch.source_branch_id = :sourceBranchId', {
        sourceBranchId,
      });
    }

    if (destinationBranchId) {
      qb.andWhere('batch.destination_branch_id = :destinationBranchId', {
        destinationBranchId,
      });
    }

    if (statusRaw) {
      if (
        !Object.values(BranchTransferBatchStatus).includes(
          statusRaw as BranchTransferBatchStatus,
        )
      ) {
        this.badRequest(
          `status must be one of: ${Object.values(BranchTransferBatchStatus).join(', ')}`,
        );
      }
      qb.andWhere('batch.status = :status', { status: statusRaw });
    }

    if (directionRaw) {
      if (
        !Object.values(BranchTransferDirection).includes(
          directionRaw as BranchTransferDirection,
        )
      ) {
        this.badRequest(
          `direction must be one of: ${Object.values(BranchTransferDirection).join(', ')}`,
        );
      }
      qb.andWhere('batch.direction = :direction', { direction: directionRaw });
    }

    const parseDate = (value: string, field: 'date') => {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        this.badRequest(`${field} is invalid date format`);
      }
      return parsed;
    };

    const getUzNow = () => {
      const now = new Date();
      return new Date(now.getTime() + 5 * 60 * 60 * 1000);
    };

    const uzToUtc = (uzDate: Date) =>
      new Date(uzDate.getTime() - 5 * 60 * 60 * 1000);

    if (dateRaw) {
      const parsedDate = parseDate(dateRaw, 'date');
      const dayStart = new Date(parsedDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(parsedDate);
      dayEnd.setHours(23, 59, 59, 999);
      qb.andWhere('batch.createdAt BETWEEN :dayStart AND :dayEnd', {
        dayStart,
        dayEnd,
      });
    } else if (periodRaw) {
      const allowedPeriods = new Set(['today', 'week', 'month']);
      if (!allowedPeriods.has(periodRaw)) {
        this.badRequest('period must be one of: today, week, month');
      }

      const uzNow = getUzNow();
      const periodStartUz = new Date(uzNow);
      periodStartUz.setHours(0, 0, 0, 0);
      let periodEndUz = new Date(uzNow);
      periodEndUz.setHours(23, 59, 59, 999);

      if (periodRaw === 'week') {
        const day = periodStartUz.getDay(); // Sunday=0
        const diffToMonday = day === 0 ? 6 : day - 1;
        periodStartUz.setDate(periodStartUz.getDate() - diffToMonday);
      }

      if (periodRaw === 'month') {
        periodStartUz.setDate(1);
        periodEndUz = new Date(
          periodStartUz.getFullYear(),
          periodStartUz.getMonth() + 1,
          0,
          23,
          59,
          59,
          999,
        );
      }

      const periodStart = uzToUtc(periodStartUz);
      const periodEnd = uzToUtc(periodEndUz);
      qb.andWhere('batch.createdAt BETWEEN :periodStart AND :periodEnd', {
        periodStart,
        periodEnd,
      });
    }

    const [rows, total] = await qb
      .orderBy('batch.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const batchIds = rows.map((row) => String(row.id));
    const items = batchIds.length
      ? await this.transferBatchItemRepo.find({
          where: { batch_id: In(batchIds), isDeleted: false },
          order: { createdAt: 'ASC' },
        })
      : [];

    const itemsByBatch = new Map<string, BranchTransferBatchItem[]>();
    for (const item of items) {
      const key = String(item.batch_id);
      const list = itemsByBatch.get(key) ?? [];
      list.push(item);
      itemsByBatch.set(key, list);
    }

    const mappedRows = rows.map((batch) => {
      const mappedItems = (itemsByBatch.get(String(batch.id)) ?? []).map(
        (item) => ({
          id: item.id,
          order_id: item.order_id,
          snapshot_price: item.snapshot_price,
          snapshot_market_id: item.snapshot_market_id,
          sent_at: item.sent_at,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        }),
      );

      if (batch.status !== BranchTransferBatchStatus.PENDING) {
        return {
          ...batch,
          items: mappedItems,
        };
      }

      const remainingItems = mappedItems.filter((item) => !item.sent_at);
      const remainingCount = remainingItems.length;
      const remainingTotalPrice = remainingItems.reduce(
        (sum, item) => sum + Number(item.snapshot_price ?? 0),
        0,
      );

      return {
        ...batch,
        order_count: remainingCount,
        total_price: remainingTotalPrice,
        items: remainingItems,
      };
    });

    const shouldCollapsePending =
      !statusRaw || statusRaw === BranchTransferBatchStatus.PENDING;

    const resultRows = shouldCollapsePending
      ? mappedRows.filter((candidate, index, all) => {
          if (candidate.status !== BranchTransferBatchStatus.PENDING) {
            return true;
          }

          const key = [
            String(candidate.source_branch_id ?? ''),
            String(candidate.destination_branch_id ?? ''),
            String(candidate.direction ?? ''),
            String(candidate.target_region_id ?? ''),
          ].join('|');

          const firstPending = all.find((row) => {
            if (row.status !== BranchTransferBatchStatus.PENDING) {
              return false;
            }
            const rowKey = [
              String(row.source_branch_id ?? ''),
              String(row.destination_branch_id ?? ''),
              String(row.direction ?? ''),
              String(row.target_region_id ?? ''),
            ].join('|');
            return rowKey === key;
          });

          return firstPending
            ? String(firstPending.id) === String(candidate.id)
            : index === 0;
        })
      : mappedRows;

    return successRes(
      {
        items: resultRows,
        meta: {
          page,
          limit,
          total: shouldCollapsePending ? resultRows.length : total,
          totalPages: shouldCollapsePending
            ? Math.max(1, Math.ceil(resultRows.length / limit))
            : Math.max(1, Math.ceil(total / limit)),
        },
      },
      200,
      'Transfer batches found',
    );
  }

  async findBranchesWithSentTransferBatches(input?: {
    direction?: string;
    side?: 'source' | 'destination' | string;
  }) {
    const directionRaw = String(input?.direction ?? '')
      .trim()
      .toUpperCase();
    const sideRaw = String(input?.side ?? 'source')
      .trim()
      .toLowerCase();
    const side: 'source' | 'destination' =
      sideRaw === 'destination' ? 'destination' : 'source';
    const column =
      side === 'destination' ? 'destination_branch_id' : 'source_branch_id';

    if (directionRaw) {
      if (
        !Object.values(BranchTransferDirection).includes(
          directionRaw as BranchTransferDirection,
        )
      ) {
        this.badRequest(
          `direction must be one of: ${Object.values(BranchTransferDirection).join(', ')}`,
        );
      }
    }

    const qb = this.transferBatchRepo
      .createQueryBuilder('batch')
      .select(`batch.${column}`, 'branch_id')
      .addSelect('COUNT(*)::int', 'sent_batches_count')
      .addSelect(
        'COALESCE(SUM(batch.total_price), 0)::bigint',
        'sent_total_price',
      )
      .where('batch.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('batch.status = :status', {
        status: BranchTransferBatchStatus.SENT,
      })
      .andWhere(`batch.${column} IS NOT NULL`);

    if (directionRaw) {
      qb.andWhere('batch.direction = :direction', { direction: directionRaw });
    }

    const rows = await qb
      .groupBy(`batch.${column}`)
      .orderBy(`batch.${column}`, 'ASC')
      .getRawMany<{
        branch_id: string;
        sent_batches_count: string | number;
        sent_total_price: string | number;
      }>();

    const items = rows
      .map((row) => ({
        branch_id: String(row?.branch_id ?? '').trim(),
        sent_batches_count: Number(row?.sent_batches_count ?? 0),
        sent_total_price: Number(row?.sent_total_price ?? 0),
      }))
      .filter((row) => Boolean(row.branch_id));

    return successRes(
      {
        side,
        direction: directionRaw || undefined,
        items,
      },
      200,
      'Branches with sent transfer batches found',
    );
  }

  async findRemainingBranchTransferBatchItems(batchId: string) {
    const id = String(batchId ?? '').trim();
    if (!id) {
      this.badRequest('batch_id is required');
    }

    const batch = await this.transferBatchRepo.findOne({
      where: { id, isDeleted: false },
    });
    if (!batch) {
      this.notFound('Transfer batch not found');
    }

    const items = await this.transferBatchItemRepo.find({
      where: { batch_id: id, isDeleted: false },
      order: { createdAt: 'ASC' },
    });

    const remainingItems = items.filter((item) => !item.sent_at);
    return successRes(
      {
        ...batch,
        items: remainingItems.map((item) => ({
          id: item.id,
          order_id: item.order_id,
          snapshot_price: item.snapshot_price,
          snapshot_market_id: item.snapshot_market_id,
          sent_at: item.sent_at,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
      },
      200,
      'Remaining transfer batch items found',
    );
  }

  async findBranchTransferBatchByQrToken(token: string) {
    const normalizedToken = String(token ?? '').trim();
    if (!normalizedToken) {
      this.badRequest('token is required');
    }

    const batch = await this.transferBatchRepo.findOne({
      where: { qr_code_token: normalizedToken, isDeleted: false },
    });
    if (!batch) {
      this.notFound('Transfer batch not found');
    }

    const items = await this.transferBatchItemRepo.find({
      where: { batch_id: String(batch.id), isDeleted: false },
      order: { createdAt: 'ASC' },
    });

    return successRes(
      {
        ...batch,
        items: items.map((item) => ({
          id: item.id,
          order_id: item.order_id,
          snapshot_price: item.snapshot_price,
          snapshot_market_id: item.snapshot_market_id,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
      },
      200,
      'Transfer batch found',
    );
  }

  async sendBranchTransferBatch(input: {
    batch_id?: string;
    order_ids?: string[];
    orderIds?: string[];
    vehicle_plate?: string;
    driver_name?: string;
    driver_phone?: string;
    requester_id?: string;
    requester_name?: string;
    requester_roles?: string[];
  }) {
    const batchId = String(input?.batch_id ?? '').trim();
    const vehiclePlate = String(input?.vehicle_plate ?? '').trim();
    const driverName = String(input?.driver_name ?? '').trim();
    const driverPhone = String(input?.driver_phone ?? '').trim();

    if (!batchId) {
      this.badRequest('batch_id is required');
    }

    const orderIds = Array.from(
      new Set(
        (input?.orderIds ?? input?.order_ids ?? [])
          .map((id) => String(id ?? '').trim())
          .filter(Boolean),
      ),
    );
    if (!orderIds.length) {
      this.badRequest('orderIds is required');
    }

    if (!vehiclePlate || !driverName || !driverPhone) {
      this.badRequest("Avtomobil ma'lumotlari majburiy");
    }
    const requesterId = String(input?.requester_id ?? '').trim() || '0';
    const requesterRole = this.toTrackingRole(input?.requester_roles);

    const batch = await this.transferBatchRepo.findOne({
      where: { id: batchId, isDeleted: false },
    });
    if (!batch) {
      this.notFound('Transfer batch not found');
    }

    if (batch.status === BranchTransferBatchStatus.CANCELLED) {
      this.badRequest("Bekor qilingan paketni jo'natib bo'lmaydi");
    }
    if (batch.status === BranchTransferBatchStatus.RECEIVED) {
      this.badRequest("Qabul qilingan paketni qayta jo'natib bo'lmaydi");
    }
    if (
      ![
        BranchTransferBatchStatus.PENDING,
        BranchTransferBatchStatus.SENT,
      ].includes(batch.status)
    ) {
      this.badRequest(
        `Paketni jo'natib bo'lmaydi. Current status: ${batch.status}`,
      );
    }

    const batchItems = await this.transferBatchItemRepo.find({
      where: { batch_id: batchId, isDeleted: false },
    });
    const itemByOrderId = new Map(
      batchItems.map((item) => [String(item.order_id), item]),
    );
    const selectedItems = orderIds
      .map((orderId) => itemByOrderId.get(orderId))
      .filter((item): item is BranchTransferBatchItem => Boolean(item));

    if (selectedItems.length !== orderIds.length) {
      this.badRequest('Some orderIds are not part of this batch');
    }

    const now = new Date();
    const toMark = selectedItems.filter((item) => !item.sent_at);
    if (!toMark.length) {
      this.badRequest("Tanlangan orderlar allaqachon jo'natilgan");
    }
    toMark.forEach((item) => {
      item.sent_at = now;
    });
    await this.transferBatchItemRepo.save(toMark);

    const toMarkOrderIds = toMark.map((item) => String(item.order_id));
    const priorOrders = await this.orderRepo.find({
      where: { id: In(toMarkOrderIds), isDeleted: false },
      select: ['id', 'status'],
    });
    const priorById = new Map(
      priorOrders.map((order) => [String(order.id), order.status]),
    );

    const refreshedItems = await this.transferBatchItemRepo.find({
      where: { batch_id: batchId, isDeleted: false },
    });
    const allSent =
      refreshedItems.length > 0 &&
      refreshedItems.every((item) => Boolean(item.sent_at));

    let sentBatch = batch;
    if (!allSent) {
      const sentTotalPrice = toMark.reduce(
        (sum, item) => sum + Number(item.snapshot_price ?? 0),
        0,
      );
      const sentQrToken = await this.generateTransferQrToken(
        this.transferBatchRepo,
        batch.direction,
      );
      sentBatch = await this.transferBatchRepo.save(
        this.transferBatchRepo.create({
          qr_code_token: sentQrToken,
          request_key: `split_send_${batchId}_${Date.now()}_${randomBytes(4).toString('hex')}`,
          source_branch_id: batch.source_branch_id,
          destination_branch_id: batch.destination_branch_id,
          direction: batch.direction,
          target_region_id: batch.target_region_id,
          status: BranchTransferBatchStatus.SENT,
          order_count: toMark.length,
          total_price: sentTotalPrice,
          vehicle_plate: vehiclePlate,
          driver_name: driverName,
          driver_phone: driverPhone,
          sent_at: now,
          received_at: null,
          cancelled_at: null,
        }),
      );

      await this.transferBatchItemRepo
        .createQueryBuilder()
        .update(BranchTransferBatchItem)
        .set({ batch_id: String(sentBatch.id) })
        .where('batch_id = :batchId', { batchId })
        .andWhere('order_id IN (:...orderIds)', { orderIds: toMarkOrderIds })
        .andWhere('"is_deleted" = false')
        .execute();

      const remainingItems = refreshedItems.filter((item) => !item.sent_at);
      batch.status = BranchTransferBatchStatus.PENDING;
      batch.sent_at = null;
      batch.order_count = remainingItems.length;
      batch.total_price = remainingItems.reduce(
        (sum, item) => sum + Number(item.snapshot_price ?? 0),
        0,
      );
      batch.vehicle_plate = null;
      batch.driver_name = null;
      batch.driver_phone = null;
      await this.transferBatchRepo.save(batch);
    } else {
      batch.status = BranchTransferBatchStatus.SENT;
      batch.sent_at = now;
      batch.vehicle_plate = vehiclePlate;
      batch.driver_name = driverName;
      batch.driver_phone = driverPhone;
      sentBatch = await this.transferBatchRepo.save(batch);
    }

    const sentBatchId = String(sentBatch.id);
    if (toMarkOrderIds.length) {
      await this.orderRepo
        .createQueryBuilder()
        .update(Order)
        .set(
          batch.direction === BranchTransferDirection.FORWARD
            ? {
                current_batch_id: sentBatchId,
                status: Order_status.ON_THE_ROAD,
              }
            : { current_batch_id: sentBatchId },
        )
        .where('id IN (:...orderIds)', { orderIds: toMarkOrderIds })
        .andWhere('"current_batch_id" = :batchId', { batchId })
        .andWhere('"is_deleted" = false')
        .execute();
    }

    if (
      batch.direction === BranchTransferDirection.FORWARD &&
      toMarkOrderIds.length
    ) {
      for (const orderId of toMarkOrderIds) {
        const fromStatus = priorById.get(orderId);
        if (!fromStatus || fromStatus === Order_status.ON_THE_ROAD) {
          continue;
        }
        await this.createTrackingEvent({
          order_id: orderId,
          from_status: fromStatus,
          to_status: Order_status.ON_THE_ROAD,
          changed_by: requesterId,
          changed_by_role: requesterRole,
          action: 'branch_batch_sent',
          description: `Pochta #${sentBatchId} filialdan jo'natildi`,
          note: `Batch #${sentBatchId} jo'natildi`,
        });
      }
    }

    const actor =
      String(input?.requester_name ?? '').trim() ||
      String(input?.requester_id ?? '').trim() ||
      'unknown';
    await this.transferBatchHistoryRepo.save(
      this.transferBatchHistoryRepo.create({
        batch_id: sentBatchId,
        user_id: String(input?.requester_id ?? '').trim() || '0',
        action: BranchTransferBatchAction.SENT,
        notes: `Operator ${actor} paketni jo'natdi. Avtomobil: ${vehiclePlate}`,
      }),
    );

    await this.activityLog.log({
      entity_type: 'BranchTransferBatch',
      entity_id: sentBatchId,
      action: ActivityAction.STATUS_CHANGE,
      new_value: { status: sentBatch.status },
      ...this.auditActor({ id: String(input?.requester_id ?? '').trim() }),
      metadata: {
        batch_id: sentBatchId,
        source_batch_id: batchId,
        order_count: toMark.length,
        order_ids: orderIds.slice(0, 20),
      },
    });

    return successRes(sentBatch, 200, 'Transfer batch sent');
  }

  async receiveBranchTransferBatch(input: {
    batch_id?: string;
    requester_id?: string;
    requester_name?: string;
    requester_roles?: string[];
  }) {
    const batchId = String(input?.batch_id ?? '').trim();
    if (!batchId) {
      this.badRequest('batch_id is required');
    }

    const requesterId = String(input?.requester_id ?? '').trim() || '0';
    const requesterName =
      String(input?.requester_name ?? '').trim() || requesterId || 'unknown';
    const requesterRole = this.toTrackingRole(input?.requester_roles);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const batchRepo = queryRunner.manager.getRepository(BranchTransferBatch);
      const batchItemRepo = queryRunner.manager.getRepository(
        BranchTransferBatchItem,
      );
      const orderRepo = queryRunner.manager.getRepository(Order);
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);
      const custodyRepo = queryRunner.manager.getRepository(OrderCustodyEvent);
      const historyRepo = queryRunner.manager.getRepository(
        BranchTransferBatchHistory,
      );

      const batch = await batchRepo.findOne({
        where: { id: batchId, isDeleted: false },
      });
      if (!batch) {
        this.notFound('Transfer batch not found');
      }

      if (batch.status === BranchTransferBatchStatus.RECEIVED) {
        this.badRequest('Bu paket allaqachon qabul qilingan');
      }
      if (batch.status === BranchTransferBatchStatus.PENDING) {
        this.badRequest("Hali jo'natilmagan paketni qabul qilib bo'lmaydi");
      }
      if (batch.status === BranchTransferBatchStatus.CANCELLED) {
        this.badRequest("Bekor qilingan paketni qabul qilib bo'lmaydi");
      }
      if (batch.status !== BranchTransferBatchStatus.SENT) {
        this.badRequest(
          `Paketni qabul qilib bo'lmaydi. Current status: ${batch.status}`,
        );
      }

      const items = await batchItemRepo.find({
        where: { batch_id: String(batch.id), isDeleted: false },
      });

      const orderIds = items.map((item) => String(item.order_id));

      batch.status = BranchTransferBatchStatus.RECEIVED;
      batch.received_at = new Date();
      batch.received_by_user_id = requesterId;
      const savedBatch = await batchRepo.save(batch);

      if (orderIds.length) {
        const destinationBranchId = String(batch.destination_branch_id);
        const handoverAt = new Date();

        // Capture prior status/holder BEFORE overwriting, so tracking + custody
        // reflect the real previous state. (Audit I9 — the whole-batch receive
        // used to set only branch_id, leaving holder_branch_id stale at the
        // source and writing no custody event, which mis-scoped bulk assign.)
        const orders = await orderRepo.find({
          where: { id: In(orderIds), isDeleted: false },
          select: [
            'id',
            'region_id',
            'status',
            'holder_type',
            'holder_branch_id',
            'holder_courier_id',
          ],
        });

        await orderRepo
          .createQueryBuilder()
          .update(Order)
          .set({
            current_batch_id: null,
            branch_id: destinationBranchId,
            // Custody moves to the receiving branch (mirror of the per-order
            // receive path) — the goods physically arrived here.
            holder_type: OrderHolderType.BRANCH,
            holder_branch_id: destinationBranchId,
            holder_courier_id: null,
            last_handover_at: handoverAt,
            last_handover_by: requesterId,
          })
          .where('id IN (:...orderIds)', { orderIds })
          .andWhere('"is_deleted" = false')
          .execute();

        const localOrderIds = orders
          .filter(
            (order) =>
              String(order.region_id ?? '') === String(batch.target_region_id),
          )
          .map((order) => String(order.id));
        const transitOrderIds = orders
          .filter(
            (order) =>
              String(order.region_id ?? '') !== String(batch.target_region_id),
          )
          .map((order) => String(order.id));

        if (localOrderIds.length) {
          await orderRepo
            .createQueryBuilder()
            .update(Order)
            .set({ status: Order_status.RECEIVED })
            .where('id IN (:...localOrderIds)', { localOrderIds })
            .andWhere('"is_deleted" = false')
            .execute();
        }

        if (transitOrderIds.length) {
          await orderRepo
            .createQueryBuilder()
            .update(Order)
            .set({ status: Order_status.NEW })
            .where('id IN (:...transitOrderIds)', { transitOrderIds })
            .andWhere('"is_deleted" = false')
            .execute();
        }

        const ordersById = new Map(
          orders.map((order) => [String(order.id), order]),
        );
        for (const localOrderId of localOrderIds) {
          const order = ordersById.get(String(localOrderId));
          const fromStatus = order?.status;
          if (!fromStatus) continue;
          if (fromStatus !== Order_status.RECEIVED) {
            await this.createTrackingEvent(
              {
                order_id: String(localOrderId),
                from_status: fromStatus,
                to_status: Order_status.RECEIVED,
                changed_by: requesterId,
                changed_by_role: requesterRole,
                action: 'branch_batch_received',
                description: `Pochta #${batchId} filial tomonidan qabul qilindi`,
                note: `Batch #${batchId} qabul qilindi`,
              },
              trackingRepo,
            );
          }
        }

        for (const transitOrderId of transitOrderIds) {
          const order = ordersById.get(String(transitOrderId));
          const fromStatus = order?.status;
          if (!fromStatus) continue;
          if (fromStatus !== Order_status.NEW) {
            await this.createTrackingEvent(
              {
                order_id: String(transitOrderId),
                from_status: fromStatus,
                to_status: Order_status.NEW,
                changed_by: requesterId,
                changed_by_role: requesterRole,
                action: 'branch_batch_requeued',
                description: `Pochta #${batchId} tranzit uchun qayta navbatga qo'yildi`,
                note: `Batch #${batchId} tranzit uchun qayta navbatga qo'yildi`,
              },
              trackingRepo,
            );
          }
        }

        // Custody handover into the receiving branch for ALL received orders
        // (local + transit — transit orders are physically here until re-sent).
        for (const order of orders) {
          const fromHolderType = order.holder_type ?? null;
          const fromBranchId = order.holder_branch_id ?? null;
          const fromCourierId = order.holder_courier_id ?? null;
          const custodyChanged =
            fromHolderType !== OrderHolderType.BRANCH ||
            String(fromBranchId ?? '') !== destinationBranchId ||
            Boolean(fromCourierId);
          if (custodyChanged) {
            await this.createCustodyEvent(
              {
                order_id: String(order.id),
                from_holder_type: fromHolderType,
                to_holder_type: OrderHolderType.BRANCH,
                from_branch_id: fromBranchId,
                to_branch_id: destinationBranchId,
                from_courier_id: fromCourierId,
                to_courier_id: null,
                changed_by: requesterId,
                changed_by_role: requesterRole,
                note: `Batch #${batchId} dan filialga qabul qilindi`,
              },
              custodyRepo,
            );
          }
        }
      }

      await historyRepo.save(
        historyRepo.create({
          batch_id: batchId,
          user_id: requesterId,
          action: BranchTransferBatchAction.RECEIVED,
          notes: `Xodim ${requesterName} paketni qabul qildi`,
        }),
      );

      await queryRunner.commitTransaction();
      await this.activityLog.log({
        entity_type: 'BranchTransferBatch',
        entity_id: batchId,
        action: ActivityAction.STATUS_CHANGE,
        new_value: { status: BranchTransferBatchStatus.RECEIVED },
        ...this.auditActor({ id: requesterId }),
        metadata: {
          batch_id: batchId,
          order_count: orderIds.length,
          order_ids: orderIds.slice(0, 20),
        },
      });
      return successRes(savedBatch, 200, 'Transfer batch received');
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async receiveBranchTransferBatchOrders(input: {
    batch_id?: string;
    order_ids?: string[];
    requester_id?: string;
    requester_name?: string;
    requester_roles?: string[];
  }) {
    const batchId = String(input?.batch_id ?? '').trim();
    if (!batchId) {
      this.badRequest('batch_id is required');
    }

    const orderIds = Array.isArray(input?.order_ids)
      ? input.order_ids
          .map((value) => String(value ?? '').trim())
          .filter(Boolean)
      : [];
    if (!orderIds.length) {
      this.badRequest("order_ids bo'sh bo'lmasligi kerak");
    }
    const uniqueOrderIds = [...new Set(orderIds)];

    const requesterId = String(input?.requester_id ?? '').trim() || '0';
    const requesterName =
      String(input?.requester_name ?? '').trim() || requesterId || 'unknown';
    const requesterRole = this.toTrackingRole(input?.requester_roles);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    let remainingOrderIdsForRequeue: string[] = [];
    try {
      const batchRepo = queryRunner.manager.getRepository(BranchTransferBatch);
      const batchItemRepo = queryRunner.manager.getRepository(
        BranchTransferBatchItem,
      );
      const orderRepo = queryRunner.manager.getRepository(Order);
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);
      const custodyRepo = queryRunner.manager.getRepository(OrderCustodyEvent);
      const historyRepo = queryRunner.manager.getRepository(
        BranchTransferBatchHistory,
      );

      const batch = await batchRepo.findOne({
        where: { id: batchId, isDeleted: false },
      });
      if (!batch) {
        this.notFound('Transfer batch not found');
      }

      if (batch.status === BranchTransferBatchStatus.RECEIVED) {
        this.badRequest('Bu paket allaqachon qabul qilingan');
      }
      if (batch.status === BranchTransferBatchStatus.PENDING) {
        this.badRequest("Hali jo'natilmagan paketdan qabul qilib bo'lmaydi");
      }
      if (batch.status === BranchTransferBatchStatus.CANCELLED) {
        this.badRequest("Bekor qilingan paketdan qabul qilib bo'lmaydi");
      }
      if (batch.status !== BranchTransferBatchStatus.SENT) {
        this.badRequest(
          `Paketdan qabul qilib bo'lmaydi. Current status: ${batch.status}`,
        );
      }

      const selectedItems = await batchItemRepo.find({
        where: {
          batch_id: batchId,
          isDeleted: false,
          order_id: In(uniqueOrderIds),
        },
      });
      if (!selectedItems.length) {
        this.badRequest('Berilgan orderlar bu batch ichida topilmadi');
      }

      const selectedOrderIds = selectedItems.map((item) =>
        String(item.order_id),
      );
      const missingOrderIds = uniqueOrderIds.filter(
        (id) => !selectedOrderIds.includes(id),
      );
      if (missingOrderIds.length) {
        this.badRequest(
          `Quyidagi orderlar batch ichida yo'q: ${missingOrderIds.join(', ')}`,
        );
      }

      const notSentOrderIds = selectedItems
        .filter((item) => !item.sent_at)
        .map((item) => String(item.order_id));
      if (notSentOrderIds.length) {
        this.badRequest(
          `Quyidagi orderlar hali jo'natilmagan: ${notSentOrderIds.join(', ')}`,
        );
      }

      // Capture prior status + custody BEFORE overwriting, so tracking and
      // custody events reflect the real previous state. (Previously this was
      // read AFTER the update, so from_status was always RECEIVED and no
      // tracking event was ever written.)
      const priorOrders = await orderRepo.find({
        where: { id: In(selectedOrderIds), isDeleted: false },
        select: [
          'id',
          'status',
          'holder_type',
          'holder_branch_id',
          'holder_courier_id',
        ],
      });
      const priorById = new Map(
        priorOrders.map((order) => [String(order.id), order]),
      );

      const destinationBranchId = String(batch.destination_branch_id);
      const handoverAt = new Date();

      await orderRepo
        .createQueryBuilder()
        .update(Order)
        .set({
          current_batch_id: null,
          branch_id: destinationBranchId,
          status: Order_status.RECEIVED,
          // Custody now sits with the receiving branch — the goods physically
          // arrived. Keeps the holder model in sync with the batch movement.
          holder_type: OrderHolderType.BRANCH,
          holder_branch_id: destinationBranchId,
          holder_courier_id: null,
          last_handover_at: handoverAt,
          last_handover_by: requesterId,
        })
        .where('id IN (:...orderIds)', { orderIds: selectedOrderIds })
        .andWhere('"is_deleted" = false')
        .execute();

      for (const selectedOrderId of selectedOrderIds) {
        const prior = priorById.get(String(selectedOrderId));
        const fromStatus = prior?.status;
        if (fromStatus && fromStatus !== Order_status.RECEIVED) {
          await this.createTrackingEvent(
            {
              order_id: String(selectedOrderId),
              from_status: fromStatus,
              to_status: Order_status.RECEIVED,
              changed_by: requesterId,
              changed_by_role: requesterRole,
              action: 'branch_batch_received',
              description: `Pochta #${batchId} dan tanlangan buyurtma qabul qilindi`,
              note: `Batch #${batchId} dan qabul qilindi`,
            },
            trackingRepo,
          );
        }

        // Record the custody handover into the receiving branch.
        const fromHolderType = prior?.holder_type ?? null;
        const fromBranchId = prior?.holder_branch_id ?? null;
        const fromCourierId = prior?.holder_courier_id ?? null;
        const custodyChanged =
          fromHolderType !== OrderHolderType.BRANCH ||
          String(fromBranchId ?? '') !== destinationBranchId ||
          Boolean(fromCourierId);
        if (custodyChanged) {
          await this.createCustodyEvent(
            {
              order_id: String(selectedOrderId),
              from_holder_type: fromHolderType,
              to_holder_type: OrderHolderType.BRANCH,
              from_branch_id: fromBranchId,
              to_branch_id: destinationBranchId,
              from_courier_id: fromCourierId,
              to_courier_id: null,
              changed_by: requesterId,
              changed_by_role: requesterRole,
              note: `Batch #${batchId} dan filialga qabul qilindi`,
            },
            custodyRepo,
          );
        }
      }

      await batchItemRepo
        .createQueryBuilder()
        .update(BranchTransferBatchItem)
        .set({ isDeleted: true })
        .where('batch_id = :batchId', { batchId })
        .andWhere('order_id IN (:...orderIds)', { orderIds: selectedOrderIds })
        .andWhere('"is_deleted" = false')
        .execute();

      const remainingItems = await batchItemRepo.find({
        where: { batch_id: batchId, isDeleted: false },
      });

      if (remainingItems.length) {
        const remainingOrderIds = remainingItems.map((item) =>
          String(item.order_id),
        );
        const remainingPriorOrders =
          batch.direction === BranchTransferDirection.FORWARD
            ? await orderRepo.find({
                where: { id: In(remainingOrderIds), isDeleted: false },
                select: ['id', 'status'],
              })
            : [];

        // FORWARD: un-received orders go back to NEW so they re-enter the
        // assignable pool. RETURN: returning orders must NOT be reset to NEW
        // (that would drop them into the new-orders flow and reverse their
        // direction) — only detach them from the batch and keep their status.
        const remainingUpdate: {
          current_batch_id: null;
          status?: Order_status;
        } =
          batch.direction === BranchTransferDirection.RETURN
            ? { current_batch_id: null }
            : { current_batch_id: null, status: Order_status.NEW };

        await orderRepo
          .createQueryBuilder()
          .update(Order)
          .set(remainingUpdate)
          .where('id IN (:...orderIds)', { orderIds: remainingOrderIds })
          .andWhere('"is_deleted" = false')
          .execute();

        for (const remainingOrder of remainingPriorOrders) {
          if (remainingOrder.status === Order_status.NEW) continue;
          await this.createTrackingEvent(
            {
              order_id: String(remainingOrder.id),
              from_status: remainingOrder.status,
              to_status: Order_status.NEW,
              changed_by: requesterId,
              changed_by_role: requesterRole,
              action: 'branch_batch_requeued',
              description: `Pochta #${batchId} qisman qabul qilindi, buyurtma jo'natuvchiga qaytarildi`,
              note: `Batch #${batchId} qisman qabul qilindi, order qayta navbatga qo'yildi`,
            },
            trackingRepo,
          );
        }

        await batchItemRepo
          .createQueryBuilder()
          .update(BranchTransferBatchItem)
          .set({ isDeleted: true })
          .where('batch_id = :batchId', { batchId })
          .andWhere('order_id IN (:...orderIds)', {
            orderIds: remainingOrderIds,
          })
          .andWhere('"is_deleted" = false')
          .execute();

        remainingOrderIdsForRequeue = remainingOrderIds;
      }

      batch.order_count = selectedItems.length;
      batch.total_price = selectedItems.reduce(
        (acc, item) => acc + Number(item.snapshot_price ?? 0),
        0,
      );
      batch.status = BranchTransferBatchStatus.RECEIVED;
      batch.received_at = new Date();
      batch.received_by_user_id = requesterId;

      const savedBatch = await batchRepo.save(batch);

      await historyRepo.save(
        historyRepo.create({
          batch_id: batchId,
          user_id: requesterId,
          action: BranchTransferBatchAction.RECEIVED,
          notes:
            remainingOrderIdsForRequeue.length > 0
              ? `Xodim ${requesterName} batchdan ${selectedOrderIds.length} ta order qabul qildi, ${remainingOrderIdsForRequeue.length} ta order qayta batchlandi`
              : `Xodim ${requesterName} batchdan ${selectedOrderIds.length} ta order qabul qildi`,
        }),
      );

      await queryRunner.commitTransaction();

      if (remainingOrderIdsForRequeue.length > 0) {
        // Re-batch the un-received orders preserving the original direction —
        // returns stay returns, forwards stay forwards.
        if (batch.direction === BranchTransferDirection.RETURN) {
          await this.createBranchReturnBatches({
            source_branch_id: String(batch.source_branch_id),
            order_ids: remainingOrderIdsForRequeue,
            request_key: `rtn_from_partial_receive_${batchId}_${Date.now()}`,
            requester_id: requesterId,
          });
        } else {
          await this.createBranchTransferBatches({
            source_branch_id: String(batch.source_branch_id),
            destination_branch_id: String(batch.destination_branch_id),
            direction: BranchTransferDirection.FORWARD,
            order_ids: remainingOrderIdsForRequeue,
            request_key: `fwd_from_partial_receive_${batchId}_${Date.now()}`,
            requester_id: requesterId,
          });
        }
      }

      await this.activityLog.log({
        entity_type: 'BranchTransferBatch',
        entity_id: batchId,
        action: ActivityAction.STATUS_CHANGE,
        new_value: { status: BranchTransferBatchStatus.RECEIVED },
        ...this.auditActor({ id: requesterId }),
        metadata: {
          batch_id: batchId,
          order_count: selectedOrderIds.length,
          order_ids: selectedOrderIds.slice(0, 20),
          requeued_count: remainingOrderIdsForRequeue.length,
        },
      });

      return successRes(
        savedBatch,
        200,
        'Selected transfer batch orders received',
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async cancelBranchTransferBatch(input: {
    batch_id?: string;
    reason?: string;
    requester_id?: string;
    requester_name?: string;
    requester_roles?: string[];
  }) {
    const batchId = String(input?.batch_id ?? '').trim();
    if (!batchId) {
      this.badRequest('batch_id is required');
    }

    const reason = String(input?.reason ?? '').trim();
    if (!reason || reason.length < 10) {
      this.badRequest(
        "Bekor qilish sababi kamida 10 ta belgidan iborat bo'lishi kerak",
      );
    }

    const requesterId = String(input?.requester_id ?? '').trim() || '0';
    const requesterName =
      String(input?.requester_name ?? '').trim() || requesterId || 'unknown';
    const requesterRole = this.toTrackingRole(input?.requester_roles);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const batchRepo = queryRunner.manager.getRepository(BranchTransferBatch);
      const orderRepo = queryRunner.manager.getRepository(Order);
      const historyRepo = queryRunner.manager.getRepository(
        BranchTransferBatchHistory,
      );

      const batch = await batchRepo.findOne({
        where: { id: batchId, isDeleted: false },
      });
      if (!batch) {
        this.notFound('Transfer batch not found');
      }

      if (batch.status === BranchTransferBatchStatus.RECEIVED) {
        this.badRequest("RECEIVED paketni bekor qilib bo'lmaydi");
      }
      if (batch.status === BranchTransferBatchStatus.CANCELLED) {
        this.badRequest("Bekor qilingan paketni qayta bekor qilib bo'lmaydi");
      }
      if (
        batch.status !== BranchTransferBatchStatus.PENDING &&
        batch.status !== BranchTransferBatchStatus.SENT
      ) {
        this.badRequest(
          `Paketni bekor qilib bo'lmaydi. Current status: ${batch.status}`,
        );
      }

      batch.status = BranchTransferBatchStatus.CANCELLED;
      batch.cancelled_at = new Date();
      const savedBatch = await batchRepo.save(batch);

      const batchOrders = await orderRepo.find({
        where: { current_batch_id: String(batch.id), isDeleted: false },
        select: ['id', 'status'],
      });
      const batchOrderIds = batchOrders.map((order) => String(order.id));
      const shouldRequeueForwardOrders =
        batch.direction === BranchTransferDirection.FORWARD &&
        batchOrderIds.length > 0;

      await orderRepo
        .createQueryBuilder()
        .update(Order)
        .set(
          shouldRequeueForwardOrders
            ? { current_batch_id: null, status: Order_status.NEW }
            : { current_batch_id: null },
        )
        .where('"current_batch_id" = :batchId', { batchId: String(batch.id) })
        .andWhere('"is_deleted" = false')
        .execute();

      if (shouldRequeueForwardOrders) {
        const trackingRepo = queryRunner.manager.getRepository(OrderTracking);
        for (const order of batchOrders) {
          if (order.status === Order_status.NEW) {
            continue;
          }
          await this.createTrackingEvent(
            {
              order_id: String(order.id),
              from_status: order.status,
              to_status: Order_status.NEW,
              changed_by: requesterId,
              changed_by_role: requesterRole,
              action: 'branch_batch_cancelled',
              description: `Pochta #${batchId} bekor qilindi, buyurtma qayta yangi holatga qaytarildi`,
              note: `Batch #${batchId} bekor qilindi`,
            },
            trackingRepo,
          );
        }
      }

      await historyRepo.save(
        historyRepo.create({
          batch_id: String(batch.id),
          user_id: requesterId,
          action: BranchTransferBatchAction.CANCELLED,
          notes: `Operator ${requesterName} paketni bekor qildi. Sabab: ${reason}`,
        }),
      );

      await queryRunner.commitTransaction();
      await this.activityLog.log({
        entity_type: 'BranchTransferBatch',
        entity_id: batchId,
        action: ActivityAction.STATUS_CHANGE,
        new_value: { status: BranchTransferBatchStatus.CANCELLED },
        ...this.auditActor({ id: requesterId }),
        metadata: { batch_id: batchId, reason },
      });
      return successRes(savedBatch, 200, 'Transfer batch cancelled');
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
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
