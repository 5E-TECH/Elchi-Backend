import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { RpcException } from '@nestjs/microservices';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { Order, OrderHolderType } from '../entities/order.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { BranchTransferBatch } from '../entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from '../entities/branch-transfer-batch-item.entity';
import { BranchTransferBatchHistory } from '../entities/branch-transfer-batch-history.entity';
import { OrderBatchInboxMessage } from '../entities/order-batch-inbox-message.entity';
import {
  ActivityAction,
  ActivityLogService,
  BranchTransferBatchAction,
  BranchTransferBatchStatus,
  BranchTransferDirection,
  Order_status,
  Roles,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';

/**
 * Branch transfer-batch orchestration, extracted from the OrderServiceService
 * god object (Audit: "single-class god object with no domain layer"). This is
 * a self-contained workflow: every method opens its OWN queryRunner from the
 * DataSource (no shared/external transaction is ever passed in) and it is never
 * called from outside the cluster, so it moves as a pure, behaviour-preserving
 * unit — the safest first split before the money-critical settlement/lifecycle.
 *
 * The tiny leaf helpers (badRequest/notFound/auditActor/toTrackingRole and the
 * tracking/custody event writers) are DUPLICATED from OrderServiceService rather
 * than shared, following the OrderAnalyticsService precedent — a pure move with
 * no change to the god object.
 * TODO: consolidate createTrackingEvent/createCustodyEvent into a shared
 * OrderCustodyService, and the shared lookup resolvers into OrderLookupService.
 */
@Injectable()
export class BranchTransferBatchService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(BranchTransferBatch)
    private readonly transferBatchRepo: Repository<BranchTransferBatch>,
    @InjectRepository(BranchTransferBatchItem)
    private readonly transferBatchItemRepo: Repository<BranchTransferBatchItem>,
    @InjectRepository(BranchTransferBatchHistory)
    private readonly transferBatchHistoryRepo: Repository<BranchTransferBatchHistory>,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderTracking)
    private readonly orderTrackingRepo: Repository<OrderTracking>,
    @InjectRepository(OrderCustodyEvent)
    private readonly orderCustodyEventRepo: Repository<OrderCustodyEvent>,
    private readonly activityLog: ActivityLogService,
  ) {}

  // ===== leaf helpers duplicated from OrderServiceService (see class doc) =====

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


  private notFound(message: string): never {
    throw new RpcException({ statusCode: 404, message });
  }


  private badRequest(message: string): never {
    throw new RpcException({ statusCode: 400, message });
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


  // ===== transfer-batch cluster (moved verbatim from the god object) =====
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
}
