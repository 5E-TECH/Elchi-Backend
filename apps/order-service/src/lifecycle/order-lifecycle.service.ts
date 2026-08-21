import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { DataSource, In, IsNull, QueryFailedError, Repository } from 'typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderHolderType, Order_source } from '../entities/order.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { OrderSettlement } from '../entities/order-settlement.entity';
import { BranchTransferBatch } from '../entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from '../entities/branch-transfer-batch-item.entity';
import { MarketCancelledHandoverSession } from '../entities/market-cancelled-handover-session.entity';
import {
  ActivityAction,
  ActivityLogService,
  BranchType,
  BranchTransferBatchStatus,
  BranchTransferDirection,
  Cashbox_type,
  ExpenseProofCondition,
  Operation_type,
  Order_status,
  OutboxService,
  PaymentMethod,
  Roles,
  SettlementStatus,
  Source_type,
  Where_deliver,
  rmqSend,
  RMQ_SERVICE_TIMEOUT,
} from '@app/common';
import type { EntityManager } from 'typeorm';
import { successRes } from '../../../../libs/common/helpers/response';
import {
  isValidStatusTransition as isValidOrderStatusTransition,
  mapInitialStatusForTracking as mapInitialOrderStatusForTracking,
} from '../domain/order-status.machine';
import {
  computeSellProfit,
  resolveSaleActorShare as resolveSaleActorShareAmount,
  resolveBranchCashboxSaleAmount as resolveBranchCashboxSaleAmountValue,
} from '../domain/order-money';
import { OrderLookupService } from '../lookup/order-lookup.service';
import { OrderCustodyService } from '../custody/order-custody.service';

const CANCELLED_HANDOVER_MANUAL_REASONS = new Set([
  'QR yirtilgan',
  "QR o'qilmayapti",
  "Label yo'qolgan",
  'QR namlangan yoki xiralashgan',
]);
const CANCELLED_HANDOVER_MANUAL_REASON_MAX_LENGTH = 80;

/**
 * Order lifecycle: the write/mutation core (create/receive/sell/partly-sell/
 * cancel/could-not-deliver/rollback/return/provider-mark/market-cancelled
 * handover/update/delete) plus the settlement WRITE helpers that run inside its
 * transactions (recordSaleSettlement/resetSettlementOnRollback). Final god-object
 * decomposition step; OrderServiceService is now the read/query surface. Shared
 * resolvers come from the injected OrderLookupService; a few pure leaf helpers
 * (badRequest/notFound/findById/handleDbError/tracking renderers/
 * resolveBranchTrackingLabel) are duplicated (used by both halves).
 */
@Injectable()
export class OrderLifecycleService {
  private readonly logger = new Logger(OrderLifecycleService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepo: Repository<OrderItem>,
    @InjectRepository(OrderTracking)
    private readonly orderTrackingRepo: Repository<OrderTracking>,
    @InjectRepository(OrderCustodyEvent)
    private readonly orderCustodyEventRepo: Repository<OrderCustodyEvent>,
    @InjectRepository(OrderSettlement)
    private readonly orderSettlementRepo: Repository<OrderSettlement>,
    @InjectRepository(BranchTransferBatchItem)
    private readonly transferBatchItemRepo: Repository<BranchTransferBatchItem>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('FILE') private readonly fileClient: ClientProxy,
    private readonly outbox: OutboxService,
    private readonly activityLog: ActivityLogService,
    private readonly lookup: OrderLookupService,
    private readonly custody: OrderCustodyService,
  ) {}

  // ===== leaf helpers duplicated from OrderServiceService =====

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

    const hqId = await this.lookup.getHqBranchId();
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

  private forbidden(message: string): never {
    throw new RpcException({ statusCode: 403, message });
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

  // Status-transition rules live in ./domain/order-status.machine (pure &
  // unit-tested). These thin wrappers keep the existing call sites unchanged.
  private mapInitialStatusForTracking(status: Order_status): Order_status {
    return mapInitialOrderStatusForTracking(status);
  }

  private isValidStatusTransition(
    fromStatus: Order_status,
    toStatus: Order_status,
  ): boolean {
    return isValidOrderStatusTransition(fromStatus, toStatus);
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
    const hqBranchId = await this.lookup.getHqBranchId();
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

    const hqBranchId = await this.lookup.getHqBranchId();
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

  private resolveSaleActorShare(
    isManagerSale: boolean,
    financialActor: { compensation_mode?: string | null } | null | undefined,
    tariff: number,
  ): number {
    return resolveSaleActorShareAmount(isManagerSale, financialActor, tariff);
  }

  private resolveBranchCashboxSaleAmount(
    totalPrice: number,
    branchPayable: number,
    isManagerSale: boolean,
  ): number {
    return resolveBranchCashboxSaleAmountValue(
      totalPrice,
      branchPayable,
      isManagerSale,
    );
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
   * When a partly-sold parent order is rolled back, re-attach the child rows
   * created for the unsold items. This also covers the operator flow where the
   * cancelled child was rolled back to WAITING first, then the sold parent was
   * rolled back afterwards. Money-bearing child statuses are intentionally not
   * merged here.
   */
  private async mergePartialChildrenBack(
    manager: EntityManager,
    order: Order,
  ): Promise<number> {
    const orderRepo = manager.getRepository(Order);
    const itemRepo = manager.getRepository(OrderItem);
    const children = await orderRepo.find({
      where: {
        parent_order_id: String(order.id),
        status: In([Order_status.CANCELLED, Order_status.WAITING]),
        isDeleted: false,
      },
      order: { createdAt: 'ASC' },
    });

    if (!children.length) {
      return 0;
    }

    const parentItems = await itemRepo.find({
      where: { order_id: String(order.id) },
    });
    const parentItemByProduct = new Map<string, OrderItem>();
    for (const item of parentItems) {
      parentItemByProduct.set(String(item.product_id), item);
    }

    let restoredPrice = 0;
    let restoredQty = 0;
    for (const child of children) {
      restoredPrice += Number(child.total_price ?? 0);
      restoredQty += Number(child.product_quantity ?? 0);

      const childItems = await itemRepo.find({
        where: { order_id: String(child.id) },
      });
      for (const childItem of childItems) {
        const productId = String(childItem.product_id);
        const parentItem = parentItemByProduct.get(productId);
        if (parentItem) {
          parentItem.quantity =
            Number(parentItem.quantity ?? 0) + Number(childItem.quantity ?? 0);
          await itemRepo.save(parentItem);
          continue;
        }

        const recreated = await itemRepo.save(
          itemRepo.create({
            order_id: String(order.id),
            product_id: productId,
            quantity: Number(childItem.quantity ?? 0),
          }),
        );
        parentItemByProduct.set(productId, recreated);
      }

      child.isDeleted = true;
      child.deleted_at = new Date();
      await orderRepo.save(child);
      await this.removeOrderFromSearch(String(child.id), manager);
    }

    order.total_price = Number(order.total_price ?? 0) + restoredPrice;
    order.product_quantity = Number(order.product_quantity ?? 0) + restoredQty;
    await orderRepo.save(order);
    await this.syncOrderToSearch(order, manager);

    return children.length;
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
      const sellProfit = computeSellProfit(
        Number(order.market_tariff ?? 0),
        courierShareSnap,
        branchShareSnap,
      );
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

    // Reversing a PARTLY_PAID sale's cashbox legs is only implemented for
    // superadmin (see `doSaleReversal` below). Letting a courier/manager roll a
    // PARTLY_PAID order back to WAITING would flip the status WITHOUT reversing
    // the already-credited market/courier/branch cash — a double-credit that is
    // realised when the order is re-sold (Audit money P1). Enforce the same
    // superadmin-only boundary at the permission layer.
    if (originalStatus === Order_status.PARTLY_PAID && !isSuperAdmin) {
      this.badRequest(
        "Qisman to'langan buyurtmani faqat superadmin WAITING holatiga qaytara oladi",
      );
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
      this.lookup
        .getMarketsByIds([String(order.market_id)])
        .then((rows) => rows[0]),
      isManagerRequester
        ? this.lookup.getUserById(String(requester.id))
        : this.lookup.getCouriersByIds([courierId]).then((rows) => rows[0]),
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
      this.lookup.getCashboxByUser(
        String(order.market_id),
        Cashbox_type.FOR_MARKET,
      ),
      isManagerRequester
        ? Promise.resolve(null)
        : this.lookup
            .getCashboxByUser(courierId, Cashbox_type.FOR_COURIER)
            .catch(() => null),
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
      await this.lookup.ensureBranchCashbox(actorExpenseUserId);
    }
    const actorExpenseCashbox = isManagerRequester
      ? await this.lookup
          .getCashboxByUser(actorExpenseUserId, Cashbox_type.BRANCH)
          .catch(() => null)
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
    let mergedPartialChildren = 0;
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

        const rbBranchId = await this.lookup.resolveSettlementBranchId(order);
        if (rbBranchId) {
          await this.lookup.ensureBranchCashbox(rbBranchId);
        }
        const rbBranchCashbox = rbBranchId
          ? await this.lookup
              .getCashboxByUser(rbBranchId, Cashbox_type.BRANCH)
              .catch(() => null)
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
      mergedPartialChildren = await this.mergePartialChildrenBack(tx, order);

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
      ...this.custody.auditActor(requester),
      metadata: {
        rollback_target: rollbackTarget,
        merged_partial_children: mergedPartialChildren,
      },
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

      await this.custody.createTrackingEvent(
        {
          order_id: order.id,
          from_status: order.status,
          to_status: order.status,
          changed_by: String(requester?.id ?? 'system'),
          changed_by_role: requester?.id
            ? this.custody.toTrackingRole(requester.roles)
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
      ...this.custody.auditActor(requester),
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
    const hqBranchId = await this.lookup.getHqBranchId();
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

      await this.custody.createTrackingEvent(
        {
          order_id: order.id,
          from_status: oldStatus,
          to_status: Order_status.RETURNED_TO_MARKET,
          changed_by: String(requester?.id ?? 'system'),
          changed_by_role: requester?.id
            ? this.custody.toTrackingRole(requester.roles)
            : 'system',
          note: `Xodim ${String(requester?.id ?? 'unknown')} market egasiga topshirdi`,
        },
        trackingRepo,
      );

      // Closing custody event: parcel handed back to the market.
      await this.custody.createCustodyEvent(
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
            ? this.custody.toTrackingRole(requester.roles)
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
      ...this.custody.auditActor(requester),
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
      this.badRequest('manual_overrides.reason noto‘g‘ri yoki juda uzun');
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

    const [market] = await this.lookup.getMarketsByIds([marketId]);
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
          status: Order_status.CANCELLED,
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

        await this.custody.createTrackingEvent(
          {
            order_id: String(order.id),
            from_status: previousStatus,
            to_status: Order_status.CLOSED,
            changed_by: requesterId,
            changed_by_role: this.custody.toTrackingRole(input.requester.roles),
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

        await this.custody.createCustodyEvent(
          {
            order_id: String(order.id),
            from_holder_type: previousHolderType,
            to_holder_type: OrderHolderType.MARKET,
            from_branch_id: previousHolderBranchId,
            to_branch_id: null,
            from_courier_id: previousHolderCourierId,
            to_courier_id: null,
            changed_by: requesterId,
            changed_by_role: this.custody.toTrackingRole(input.requester.roles),
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
      ...this.custody.auditActor(input.requester),
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

      await this.custody.createTrackingEvent(
        {
          order_id: saved.id,
          from_status: null,
          to_status: this.mapInitialStatusForTracking(saved.status),
          changed_by: String(requester?.id ?? 'system'),
          changed_by_role: requester?.id
            ? this.custody.toTrackingRole(requester.roles)
            : 'system',
          note: 'Order created',
        },
        trackingRepo,
      );

      await this.custody.createCustodyEvent(
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
            ? this.custody.toTrackingRole(requester.roles)
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
        ...this.custody.auditActor(requester),
        metadata: { operator_id: operatorId },
      });
    }

    const fullOrder = await this.findById(savedId);
    return fullOrder;
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
          await this.custody.createTrackingEvent(
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
    const integration = await this.lookup.getIntegrationById(
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

    const fallbackDistrictId = await this.lookup.getDefaultDistrictId();
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
      const districtId = await this.lookup.resolveDistrictId(
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
      this.lookup
        .getMarketsByIds([String(order.market_id)])
        .then((rows) => rows[0]),
      isManagerRequester
        ? this.lookup.getUserById(String(requester.id))
        : this.lookup
            .getCouriersByIds([actorCourierId])
            .then((rows) => rows[0]),
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
      this.lookup.getCashboxByUser(
        String(order.market_id),
        Cashbox_type.FOR_MARKET,
      ),
      isManagerRequester
        ? Promise.resolve(null)
        : this.lookup
            .getCashboxByUser(actorCourierId, Cashbox_type.FOR_COURIER)
            .catch(() => null),
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
    const settlementBranchId =
      await this.lookup.resolveSettlementBranchId(order);
    if (settlementBranchId) {
      await this.lookup.ensureBranchCashbox(settlementBranchId);
    }
    const branchCashbox = settlementBranchId
      ? await this.lookup
          .getCashboxByUser(settlementBranchId, Cashbox_type.BRANCH)
          .catch(() => null)
      : null;
    // branchShare = what a PARTNER branch keeps per order (0 for OWNED / HQ).
    const branchShare = settlementBranchId
      ? await this.lookup.resolveBranchShare(settlementBranchId)
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
    //   branch cashbox: branch receives its tariff-adjusted payable share
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
      ...this.custody.auditActor(requester),
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
    const market = await this.lookup
      .getMarketsByIds([String(order.market_id)])
      .then((rows) => rows[0]);

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
        await this.lookup.ensureBranchCashbox(actorExpenseUserId);
      }
      const [marketCashbox, fetchedActorExpenseCashbox] = await Promise.all([
        this.lookup.getCashboxByUser(
          String(order.market_id),
          Cashbox_type.FOR_MARKET,
        ),
        this.lookup
          .getCashboxByUser(actorExpenseUserId, actorExpenseCashboxType)
          .catch(() => null),
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
      ...this.custody.auditActor(requester),
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
      ...this.custody.auditActor(requester),
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

      await this.custody.createTrackingEvent(
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
      this.lookup
        .getMarketsByIds([String(order.market_id)])
        .then((rows) => rows[0]),
      isManagerRequester
        ? this.lookup.getUserById(String(requester.id))
        : this.lookup
            .getCouriersByIds([actorCourierId])
            .then((rows) => rows[0]),
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
      this.lookup.getCashboxByUser(
        String(order.market_id),
        Cashbox_type.FOR_MARKET,
      ),
      isManagerRequester
        ? Promise.resolve(null)
        : this.lookup
            .getCashboxByUser(actorCourierId, Cashbox_type.FOR_COURIER)
            .catch(() => null),
    ]);
    if (!marketCashbox) {
      this.notFound('Market cashbox not found');
    }
    if (!courierCashbox && !isManagerRequester) {
      this.notFound('Courier cashbox not found');
    }

    // Branch settlement mirror (courier → branch → HQ) for non-HQ branch sales.
    const settlementBranchId =
      await this.lookup.resolveSettlementBranchId(order);
    if (settlementBranchId) {
      await this.lookup.ensureBranchCashbox(settlementBranchId);
    }
    const branchCashbox = settlementBranchId
      ? await this.lookup
          .getCashboxByUser(settlementBranchId, Cashbox_type.BRANCH)
          .catch(() => null)
      : null;
    const branchShare = settlementBranchId
      ? await this.lookup.resolveBranchShare(settlementBranchId)
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
      await this.custody.createTrackingEvent(
        {
          order_id: cancelledOrder.id,
          from_status: null,
          to_status: Order_status.CANCELLED,
          changed_by: String(requester.id),
          changed_by_role: this.custody.toTrackingRole(requester.roles),
          note: 'Partly-sell unsold items canceled',
        },
        cancelledTrackingRepo,
      );
      await this.custody.createCustodyEvent(
        {
          order_id: cancelledOrder.id,
          from_holder_type: null,
          to_holder_type: cancelledHolder.holder_type,
          from_branch_id: null,
          to_branch_id: cancelledHolder.holder_branch_id,
          from_courier_id: null,
          to_courier_id: cancelledHolder.holder_courier_id,
          changed_by: String(requester.id),
          changed_by_role: this.custody.toTrackingRole(requester.roles),
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
      ...this.custody.auditActor(requester),
      metadata: {
        market_id: order.market_id,
        courier_id: courierCashbox ? actorCourierId : null,
        cancelled_items: cancelledItems.length,
      },
    });

    return successRes({}, 200, 'Order qisman sotildi');
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
        order.status === Order_status.CANCELLED &&
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
        await this.custody.createTrackingEvent(
          {
            order_id: order.id,
            from_status: oldStatus,
            to_status: order.status,
            changed_by: String(requester?.id ?? 'system'),
            changed_by_role: requester?.id
              ? this.custody.toTrackingRole(requester.roles)
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
        await this.custody.createCustodyEvent(
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
              ? this.custody.toTrackingRole(requester.roles)
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
        ...this.custody.auditActor(requester),
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
      ...this.custody.auditActor(requester),
    });

    return successRes({}, 200, `Order #${id} o'chirildi`);
  }

  // ==================== Enrichment Helpers ====================
}
