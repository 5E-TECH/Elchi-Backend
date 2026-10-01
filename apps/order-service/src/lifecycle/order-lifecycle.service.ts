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
import { OrderSettlementCarry } from '../entities/order-settlement-carry.entity';
import { BranchTransferBatch } from '../entities/branch-transfer-batch.entity';
import { BranchTransferBatchItem } from '../entities/branch-transfer-batch-item.entity';
import { MarketCancelledHandoverSession } from '../entities/market-cancelled-handover-session.entity';
import {
  ExtraCostApprovalAction,
  OrderExtraCostApproval,
} from '../entities/order-extra-cost-approval.entity';
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
  computeRollbackCourierCashboxDelta,
  computeSellProfit,
  computeTariffShortfall,
  isCourierRemittedSettlement,
  resolveOrderTariff,
  resolveRollbackReversalActor,
  resolveSaleActorShare as resolveSaleActorShareAmount,
} from '../domain/order-money';
import { OrderLookupService } from '../lookup/order-lookup.service';
import { OrderCustodyService } from '../custody/order-custody.service';
import {
  matchPartlySellItems,
  type PartlySellRequestItem,
} from './partly-sell-items';

const CANCELLED_HANDOVER_MANUAL_REASONS = new Set([
  'QR yirtilgan',
  "QR o'qilmayapti",
  "Label yo'qolgan",
  'QR namlangan yoki xiralashgan',
]);
const CANCELLED_HANDOVER_MANUAL_REASON_MAX_LENGTH = 80;

/**
 * BUYURTMA YARATISHDA FAQAT SUPERADMIN/ADMIN BERA OLADIGAN MAYDONLAR
 * (fix3 C6; RBAC-05, LC-07, LC-14). Gateway'dagi `CREATE_LIFECYCLE_FIELDS`
 * bilan AYNI ro'yxat — bu himoya chuqurligi.
 *
 * Holat va saqlash (custody) zanjiri faqat hayot sikli amallari (HQ qabuli,
 * jo'natish, skan, sotish) orqali o'zgaradi. Market yoki filial xodimi
 * `status:'received'` / `courier_id` / `post_id` yuborib HQ qabulini chetlab
 * o'tardi, `status:'sold'` + rollback esa kassaga soxta chiqim yozdirardi.
 * Boshqa yaratuvchilar uchun bu maydonlar JIMGINA olib tashlanadi: buyurtma
 * sukutdagi NEW, kuryersiz va pochtasiz yaratiladi.
 */
const CREATE_LIFECYCLE_FIELDS = [
  'status',
  'post_id',
  'courier_id',
  'current_batch_id',
  'assigned_at',
  'return_reason',
  'sold_at',
  'canceled_post_id',
  'holder_type',
  'holder_branch_id',
  'holder_courier_id',
  'home_branch_id',
  'parent_order_id',
  'to_be_paid',
  'paid_amount',
  /**
   * fix3b: mijoz OLDINDAN to'lagan qism (hamkor prepaid posilkasi). Kuryer
   * shuncha kam naqd yig'adi (`resolveCollectibleAmount`), ya'ni bu pul
   * maydoni — faqat SUPERADMIN/ADMIN, hamkor (tizim, superadmin roli) va
   * so'rovchisiz ichki chaqiruvlardan. Market va filial xodimida olib
   * tashlanadi: aks holda market "oldindan to'langan" deb kuryerni naqddan
   * ozod qilib, marketga qarzni yo'qotardi.
   */
  'paid_online_amount',
  'qr_code_token',
  'operator_id',
] as const;

/**
 * Joylashuv maydonlari: market (va uning operatori/boti) o'z buyurtmasini
 * istalgan filialga yoki `source:'branch'` bilan SA/admin "Yangi buyurtmalar"
 * ro'yxatidan yashira olmasin. Filial xodimida esa gateway ularni o'zi
 * majburan qo'yadi (o'z filiali, `source='branch'`).
 */
const CREATE_PLACEMENT_FIELDS = ['branch_id', 'source'] as const;

/**
 * PATCH /orders/:id orqali HECH KIM (superadmin ham) o'zgartira olmaydigan
 * maydonlar (fix3 C6; M11, CODE-03). Birinchi to'rttasi gateway'dagi
 * `PATCH_FORBIDDEN_FIELDS` bilan AYNI; qolganlari gateway DTO'sida umuman yo'q
 * (whitelist ularni 400 bilan rad etadi) — bu yerda himoya chuqurligi uchun.
 *
 * Holat faqat sotish / bekor qilish / qaytarish amallari orqali o'zgaradi:
 * PATCH bilan WAITING→SOLD bo'lsa kassa oyoqlari va hisob-kitob qatori
 * yozilmasdi, SOLD→WAITING esa faqat foydani teskari qilardi. Sotilgan
 * buyurtmada market almashsa pul eski marketda qolib, rollback yangisini
 * teskari yozardi.
 */
const API_UPDATE_FORBIDDEN_FIELDS = [
  'status',
  'market_id',
  'to_be_paid',
  'paid_amount',
  'courier_id',
  'branch_id',
  'current_batch_id',
  'assigned_at',
  'canceled_post_id',
  'sold_at',
  'return_requested',
  'return_reason',
  'market_tariff',
  'courier_tariff',
  'courier_share',
  'branch_share',
  'branch_cashbox_amount',
  'sale_collectible_amount',
  'extra_cost',
  'proof_files',
  'external_id',
] as const;

/**
 * PATCH'da faqat SUPERADMIN o'zgartira oladigan maydonlar (CODE-03) —
 * gateway'dagi `PATCH_SUPERADMIN_ONLY_FIELDS` bilan AYNI: pochta, mijoz, QR
 * yorlig'i va manba saqlash zanjiri va ro'yxatlarga ta'sir qiladi.
 */
const API_UPDATE_SUPERADMIN_ONLY_FIELDS = [
  'post_id',
  'customer_id',
  'qr_code_token',
  'source',
] as const;

/** `value` dan `fields` olib tashlangan nusxa (asl obyekt o'zgarmaydi). */
function omitFields<T extends object>(value: T, fields: readonly string[]): T {
  const copy = { ...value } as Record<string, unknown>;
  for (const key of fields) {
    delete copy[key];
  }
  return copy as T;
}

/** `dto` da haqiqatan yuborilgan (undefined emas) maydonlar. */
function presentFields(dto: object, fields: readonly string[]): string[] {
  const record = dto as Record<string, unknown>;
  return fields.filter((key) => record[key] !== undefined);
}

/** Pul summasi tiyinda (numeric(14,2) — suzuvchi nuqta qoldig'isiz solishtirish). */
const toTiyin = (value: unknown): number =>
  Math.round((Number(value) || 0) * 100);

/**
 * fix3b (M6) — superadmin kuryer topshirib bo'lgan (COURIER_SETTLED) sotuvni
 * qaytarganda kuryerning `courier_to_branch` qoldig'iga yoziladigan kredit.
 * Tranzaksiyadan OLDIN tekshirilib yig'iladi, ichida esa qulf ostida qayta
 * tasdiqlanadi (`creditRemittedCourierCarry`).
 */
interface RemittedCourierCredit {
  courierId: string;
  branchId: string;
  /** Qatorning `courier_amount` i — musbat, so'm. */
  amount: number;
  /** Tekshirilgan qator holati (qulf ostida o'zgarmagan bo'lishi shart). */
  status: SettlementStatus;
}

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
    @InjectRepository(OrderExtraCostApproval)
    private readonly extraCostApprovalRepo: Repository<OrderExtraCostApproval>,
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

  /**
   * Tashqi manbadan kelgan `region` qiymatini XAVFSIZ o'qish.
   *
   * `region_id` — bigint FK. Sayt u yerga matn yuborsa Postgres tip xatosi
   * beradi va import partiyasi yarim yo'lda uziladi. Shu bois faqat butun
   * son qabul qilinadi.
   */
  private numericRegionId(value: unknown): string | null {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'bigint' &&
      typeof value !== 'boolean'
    ) {
      return null;
    }
    const raw = String(value).trim();
    if (!raw) return null;
    return /^\d+$/.test(raw) ? raw : null;
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

  /**
   * `last_handover_by` uchun aktyor id'si — FAQAT raqamli bo'lsa.
   *
   * ⚠️ NEGA KERAK. Ustun `bigint`, lekin aktyor har doim ham haqiqiy
   * foydalanuvchi emas: hamkor (Partner API) oqimi sun'iy id yuboradi
   * (`partner:1`), chunki uning ortida foydalanuvchi turmaydi. Bunday satr
   * bigint ustunga yozilganda Postgres `22P02` beradi va BUTUN buyurtma
   * yaratish tranzaksiyasi qaytadi.
   *
   * Aynan shu sabab hamkordan kelgan birinchi posilka yaratilmadi: xato
   * "ID qiymatlari raqam ko'rinishida bo'lishi kerak" bo'lib chiqardi va
   * qaysi maydon aybdor ekani ko'rinmasdi.
   *
   * Audit izi YO'QOLMAYDI: `order_tracking.changed_by` va
   * `order_custody_events.changed_by` — `varchar`, ular sun'iy id'ni o'z
   * holicha saqlaydi. Bu yerda esa "foydalanuvchi yo'q" degani `null`.
   */
  private numericActorId(actorId?: string | number | null): string | null {
    const raw = String(actorId ?? '').trim();
    return /^\d+$/.test(raw) ? raw : null;
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

  /**
   * QABUL QILISH uchun FILIAL DOIRASI.
   *
   * Qoida (foydalanuvchi qarori 2026-09-10): menejer va registrator faqat
   * O'Z filialidagi buyurtmalar ustida amal bajaradi. superadmin/admin —
   * cheklovsiz.
   *
   * Qaytaradi: cheklov uchun `branch_id`, yoki cheklovsiz bo'lsa `null`.
   *
   * ⚠️ FAIL-CLOSED. Filiali aniqlanmagan menejer/registrator hech nima qabul
   * qila olmaydi. Aks holda "filiali yo'q" foydalanuvchi CHEKLOVSIZ bo'lib
   * qolardi — ya'ni tekshiruvni chetlab o'tishning eng oson yo'li filialni
   * o'chirib qo'yish bo'lardi.
   */
  private async resolveReceiveBranchScope(
    requester?: {
      id?: string;
      roles?: string[];
    } | null,
  ): Promise<string | null> {
    const roles = new Set(
      (requester?.roles ?? []).map((role) =>
        String(role ?? '')
          .trim()
          .toLowerCase(),
      ),
    );

    if (roles.has(Roles.SUPERADMIN) || roles.has(Roles.ADMIN)) {
      return null;
    }

    if (!roles.has(Roles.MANAGER) && !roles.has(Roles.REGISTRATOR)) {
      this.forbidden('Buyurtmani qabul qilishga ruxsat yo‘q');
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Foydalanuvchi aniqlanmadi');
    }

    const response = await rmqSend<{
      data?: { branch_id?: string | null } | null;
    }>(
      this.branchClient,
      { cmd: 'branch.user.find_by_user' },
      {
        user_id: requesterId,
        requester: { id: requesterId, roles: requester?.roles ?? [] },
      },
      { attachRequestId: false, retries: 1 },
    );

    const branchId = String(response?.data?.branch_id ?? '').trim();
    if (!branchId) {
      this.forbidden(
        'Sizga filial biriktirilmagan — buyurtma qabul qilib bo‘lmaydi',
      );
    }

    return branchId;
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
    existingItems: Array<{
      product_id?: string | null;
      product_name?: string | null;
      quantity?: number;
    }>,
    requestedItems: Array<{
      product_id?: string | null;
      product_name?: string | null;
      quantity?: number;
    }>,
  ): boolean {
    const aggregate = (
      items: Array<{
        product_id?: string | null;
        product_name?: string | null;
        quantity?: number;
      }>,
    ): Map<string, number> => {
      const result = new Map<string, number>();
      for (const item of items) {
        const itemKey = item.product_id
          ? `product:${String(item.product_id)}`
          : `external:${String(item.product_name ?? '').trim()}`;
        const quantity = Number(item.quantity ?? 1);
        result.set(itemKey, (result.get(itemKey) ?? 0) + quantity);
      }
      return result;
    };

    const existing = aggregate(existingItems);
    const requested = aggregate(requestedItems);
    if (existing.size !== requested.size) return true;

    for (const [itemKey, quantity] of existing) {
      if (requested.get(itemKey) !== quantity) return true;
    }

    return false;
  }

  private assertCommercialFieldsEditable(
    order: Order,
    dto: {
      total_price?: number;
      items?: Array<{
        product_id?: string | null;
        product_name?: string | null;
        quantity?: number;
      }>;
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

  /**
   * MENEJER SOTUVIDA NAQD FILIAL QO'LIDA — filial kassasiga kirim summasi.
   *
   * Audit M3 dan beri filial kassasi = filial jismonan ushlab turgan naqd, va
   * u faqat kuryerdan pul qabul qilinganda ko'payadi. Menejer buyurtmani
   * O'ZI sotganda esa kuryer yo'q: naqd to'g'ridan-to'g'ri menejer qo'lida,
   * ya'ni hech qachon "kuryerdan qabul qilinmaydi". Shu kirim yozilmasa
   * filial kassasida bu pul umuman yo'q bo'lib qolardi: `branch-to-main`
   * "Insufficient cash balance" bilan rad etardi, daftar esa filialdan uni
   * abadiy talab qilardi (E2E 30-09: 150 000 lik menejer sotuvi, 140 000
   * HQ'ga topshirib bo'lmadi).
   *
   * Summa kuryer sotuvidagi kuryer kassasi kirimi bilan AYNI
   * (`yig'ilgan − menejer ulushi`): qo'shimcha xarajat keyin alohida chiqim
   * bo'lib filial kassasidan yechiladi. HQ menejeri (filial yo'q) va
   * yig'ilgan pul ulushdan kam bo'lgan holat o'zgarmaydi — 0 qaytadi.
   */
  private resolveManagerSaleBranchCash(params: {
    isManagerRequester: boolean;
    settlementBranchId: string | null;
    hasBranchCashbox: boolean;
    courierIncome: number;
  }): number {
    if (
      !params.isManagerRequester ||
      !params.settlementBranchId ||
      !params.hasBranchCashbox
    ) {
      return 0;
    }
    return Math.max(Number(params.courierIncome) || 0, 0);
  }

  private resolveSaleActorShare(
    isManagerSale: boolean,
    financialActor: { compensation_mode?: string | null } | null | undefined,
    tariff: number,
  ): number {
    return resolveSaleActorShareAmount(isManagerSale, financialActor, tariff);
  }

  /**
   * TARIF QO'RIQCHISI: market tarifi kuryer (+ hamkor filial) ulushini qoplashi
   * SHART, aks holda sotuv rad etiladi.
   *
   * NEGA BLOKLANADI. COD zanjiri marketga `total − marketTariff` to'laydi,
   * lekin yuqoriga faqat `total − courierShare − branchShare` ko'tariladi.
   * Market tarifi ikki ulushni qoplamasa, HQ marketga OLGANIDAN KO'P to'lashga
   * majbur bo'ladi — 500 000 so'mlik buyurtmada kuryer 25 000 ni o'ziga oladi,
   * 475 000 topshiradi, market tarifi 20 000 bo'lsa marketga 480 000 to'lanadi,
   * ya'ni har buyurtmada 5 000 so'm HQ kissasidan ketadi. Bu xato hech qanday
   * xatolik chiqarmasdi: faqat `sell_profit` manfiy bo'lib yozilardi va
   * raqamlar jimgina buzilardi (aynan shu turdagi xato eng qimmat).
   *
   * Odatiy sabab — marketning `tariff_home`/`tariff_center`idan biri 0 yoki
   * kuryer tarifidan kichik, buyurtma esa aynan shu `where_deliver` bilan
   * kelgan. Yechim tarifni to'g'rilash, shuning uchun xato xabari raqamlarni
   * ko'rsatadi.
   */
  private assertTariffCoversShares(params: {
    marketTariff: number;
    courierShare: number;
    branchShare: number;
  }): void {
    const shortfall = computeTariffShortfall(
      params.marketTariff,
      params.courierShare,
      params.branchShare,
    );
    if (shortfall <= 0) {
      return;
    }
    const branchPart =
      params.branchShare > 0
        ? ` va filial ulushi (${params.branchShare} so'm)`
        : '';
    this.badRequest(
      `Market tarifi (${params.marketTariff} so'm) kuryer ulushi ` +
        `(${params.courierShare} so'm)${branchPart}ni qoplamaydi: ` +
        `bu buyurtmada kompaniya ${shortfall} so'm zarar ko'radi va marketga ` +
        `olgan puldan ko'p to'lashga majbur bo'ladi. Sotuv to'xtatildi — ` +
        `market yoki kuryer tarifini to'g'rilab, so'ng qaytadan urinib ko'ring.`,
    );
  }

  /**
   * Qo'shimcha xarajat settlement daftariga QANCHA kamaytirish yozishini
   * hisoblaydi.
   *
   * ⚠️ NEGA KERAK BO'LDI (jonli E2E, Andijon). Qo'shimcha xarajat KASSANI
   * kamaytiradi (kuryer yoki filial kassasidan EXPENSE), lekin `order_settlement`
   * ga tegmasdi. Natijada ikki daftar ajralib ketardi: kuryer kassasida
   * 205 000 so'm, ledger esa 210 000 talab qilardi — FIFO birinchi ikkita
   * buyurtmani yopib, uchinchisiga AYNAN 5 000 so'm yetmay, buyurtma abadiy
   * PENDING bo'lib qotib qolardi.
   *
   * Qoida: xarajat QAYSI kassadan yechilgan bo'lsa, o'sha bo'g'in va undan
   * YUQORIDAGI bo'g'inlar daftarda shuncha kam qarzdor bo'ladi — chunki naqd
   * zanjir bo'ylab aynan shuncha kam ko'tariladi. `market_amount` bu ayirmani
   * allaqachon hisobga olgan (audit M8), bu yerda qolgan ikki oyoq tenglashadi.
   */
  private resolveExtraCostSettlementLegs(params: {
    extraCost: number;
    /** Xarajat AYNAN yozilgan kassa turi; yozilmagan bo'lsa `null`. */
    chargedCashboxType: Cashbox_type | null;
  }): { courier: number; branch: number } {
    const amount = Math.max(Number(params.extraCost) || 0, 0);
    if (amount <= 0 || !params.chargedCashboxType) {
      return { courier: 0, branch: 0 };
    }
    // Kuryer to'lagan bo'lsa: kuryer filialga, filial HQ'ga shuncha kam
    // ko'taradi. Filial (manager sotuvi) to'lagan bo'lsa kuryer oyog'i
    // umuman yo'q, faqat filial oyog'i kamayadi.
    return params.chargedCashboxType === Cashbox_type.FOR_COURIER
      ? { courier: amount, branch: amount }
      : { courier: 0, branch: amount };
  }

  /**
   * Create/refresh the per-order settlement row at sale time (inside the sale
   * transaction). Status starts at PENDING, but legs with no participant are
   * auto-advanced: a branch-direct sale (no courier) starts COURIER_SETTLED
   * (cash already at the branch); an HQ-direct sale (no courier, no branch)
   * starts BRANCH_SETTLED (cash already at HQ). BRANCH_SETTLED uniformly means
   * "money has reached HQ" — the point past which rollback is forbidden.
   *
   * Bekor qilingan buyurtma uchun ham chaqiriladi: unda faqat qo'shimcha
   * xarajat KREDITI yoziladi (manfiy oyoqlar) — `cancelOrder` ga qarang.
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
      /**
       * Naqd UCHINCHI TOMONDA (kargoda) — audit M5. Kuryer ham, filial ham
       * yo'q, lekin pul HQ'ga yetib kelmagan: u kargo hisob-kitob qilgandan
       * keyin keladi. Bunday qator PENDING bo'lib turadi va remittance
       * kelganda BRANCH_SETTLED ga o'tkaziladi.
       */
      cashHeldByProvider?: boolean;
    },
  ): Promise<void> {
    const repo = manager.getRepository(OrderSettlement);
    const isBranchSale = Boolean(data.branch_id);
    const now = new Date();

    let status = SettlementStatus.PENDING;
    let courier_to_branch_at: Date | null = null;
    let branch_to_hq_at: Date | null = null;
    if (!data.hasCourier && !data.cashHeldByProvider) {
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
      /**
       * ISHORALI (signed) saqlanadi — audit M10. Ilgari uchala summa ham
       * `Math.max(x, 0)` bilan qirqilardi, ya'ni arzon mahsulot holatida
       * (masalan 5 000 so'mlik buyurtma, kuryer tarifi 25 000) ledger 0 yozar,
       * kassa esa teskari yo'nalishda real oyoq yozardi: HQ'ning kuryerga
       * ustama to'lovi va marketning HQ oldidagi qarzi ledgerdan butunlay
       * tushib qolardi. FIFO hisob-kitobi manfiy oyoqni "qarz yo'q" deb
       * bepul o'tkazadi, shuning uchun qirqishning keragi yo'q.
       */
      courier_amount: data.courier_amount,
      branch_amount: data.branch_amount,
      market_amount: data.market_amount,
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
    const parentOrder =
      (await orderRepo.findOne({ where: { id: String(order.id) } })) ?? order;
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
      where: { order_id: String(parentOrder.id) },
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
            order_id: String(parentOrder.id),
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

    parentOrder.total_price =
      Number(parentOrder.total_price ?? 0) + restoredPrice;
    parentOrder.product_quantity =
      Number(parentOrder.product_quantity ?? 0) + restoredQty;
    await orderRepo.save(parentOrder);
    await this.syncOrderToSearch(parentOrder, manager);

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
      ? market.expense_proof_conditions
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

  private isExtraCostApprovalRequired(params: { extraCost: number }) {
    return params.extraCost > 0;
  }

  private serializeExtraCostApproval(approval: OrderExtraCostApproval) {
    return {
      id: String(approval.id),
      order_id: String(approval.order_id),
      market_id: String(approval.market_id),
      requested_by_user_id: String(approval.requested_by_user_id),
      requested_by_role: approval.requested_by_role,
      requester_branch_id: approval.requester_branch_id
        ? String(approval.requester_branch_id)
        : null,
      action: approval.action,
      amount: Number(approval.amount ?? 0),
      proof_file_keys: approval.proof_file_keys ?? [],
      status: approval.status,
      decided_by_user_id: approval.decided_by_user_id
        ? String(approval.decided_by_user_id)
        : null,
      decided_at: approval.decided_at,
      decision_comment: approval.decision_comment,
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
    };
  }

  private requesterPrimaryRole(requester: { roles?: string[] }) {
    const roles = requester.roles ?? [];
    if (roles.some((role) => String(role).toLowerCase() === Roles.MANAGER)) {
      return Roles.MANAGER;
    }
    if (roles.some((role) => String(role).toLowerCase() === Roles.COURIER)) {
      return Roles.COURIER;
    }
    return roles[0] ? String(roles[0]).toLowerCase() : null;
  }

  /**
   * Tasdiq so'rovining PULGA ta'sir qiladigan "barmoq izi" (audit M3): amal,
   * xarajat summasi va amalning summalari — qisman sotuvda yangi narx va
   * qatorlar, sotuvda `paidAmount`. Izoh va dalil fayllari kirmaydi: ular
   * bajariladigan pul amalini o'zgartirmaydi.
   */
  private extraCostRequestFingerprint(
    action: ExtraCostApprovalAction,
    amount: unknown,
    payload: Record<string, unknown> | null | undefined,
  ): string {
    const source = payload ?? {};
    const toNumberOrNull = (value: unknown): number | null =>
      value === undefined || value === null || value === ''
        ? null
        : Number(value);
    const toKeyPart = (value: unknown): string =>
      typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
    const items = Array.isArray(source.order_item_info)
      ? (source.order_item_info as Array<Record<string, unknown> | null>)
          .map((item) =>
            [
              toKeyPart(item?.order_item_id),
              toKeyPart(item?.product_id),
              Number(item?.quantity ?? 0),
            ].join(':'),
          )
          .sort()
      : [];
    return JSON.stringify({
      action,
      amount: Number(amount ?? 0),
      totalPrice:
        action === 'partly_sell' ? toNumberOrNull(source.totalPrice) : null,
      paidAmount: action === 'sell' ? toNumberOrNull(source.paidAmount) : null,
      items: action === 'partly_sell' ? items : [],
    });
  }

  private async requestExtraCostApprovalIfNeeded(params: {
    order: Order;
    requester: { id: string; roles?: string[]; branch_id?: string | null };
    action: ExtraCostApprovalAction;
    extraCost: number;
    proofFiles: string[];
    dto: Record<string, unknown>;
  }) {
    const { order, requester, action, extraCost, proofFiles, dto } = params;
    if (
      Boolean(dto.extraCostApproved) ||
      !this.isExtraCostApprovalRequired({ extraCost })
    ) {
      return null;
    }

    const existing = await this.extraCostApprovalRepo.findOne({
      where: {
        order_id: String(order.id),
        status: 'pending',
        isDeleted: false,
      },
      order: { createdAt: 'DESC' },
    });
    if (existing) {
      /**
       * ⚠️ ESKI SO'ROV FAQAT AYNAN SHU SO'ROV BO'LSA QAYTARILADI (audit M3).
       *
       * Ilgari kutilayotgan so'rov faqat `order_id` bo'yicha topilib, yangi
       * so'rov (boshqa amal yoki summa) jimgina tashlab yuborilardi. Kuryer
       * SOTISH (xarajat 5 000) so'rovidan keyin mijoz rad etib BEKOR (xarajat
       * 3 000) yuborsa, unga eski #1 qaytardi; market #1 ni tasdiqlaganda
       * `sellOrder` bajarilardi — qaytayotgan tovar uchun soxta sotuv
       * (kuryerga yig'ilmagan naqd qarzi, marketga kirim). Teskarisi ham:
       * bekor kutilayotganda sotuv so'rovi BEKORni bajartirardi.
       *
       * Endi: amal, summa va amalning pul maydonlari bir xil bo'lsa — takroriy
       * yuborish, eski so'rov qaytadi. Farq qilsa — kuryerning OXIRGI niyati
       * ustun: eski so'rov yopiladi (`rejected`, izoh bilan) va yangisi
       * ochiladi. Market faqat oxirgi so'rovni ko'radi va tasdiqlaydi.
       */
      const isSameRequest =
        this.extraCostRequestFingerprint(
          existing.action,
          existing.amount,
          existing.operation_payload,
        ) === this.extraCostRequestFingerprint(action, extraCost, dto);
      if (isSameRequest) {
        return successRes(
          {
            approval_required: true,
            approval: this.serializeExtraCostApproval(existing),
          },
          202,
          "Market tasdig'i kutilmoqda",
        );
      }
      existing.status = 'rejected';
      existing.decided_by_user_id = String(requester.id);
      existing.decided_at = new Date();
      existing.decision_comment =
        `Yangi so'rov bilan almashtirildi (${action}, ${extraCost} so'm) — ` +
        `eski ${existing.action} so'rovi bekor qilindi`;
      await this.extraCostApprovalRepo.save(existing);
    }

    const approval = this.extraCostApprovalRepo.create({
      order_id: String(order.id),
      market_id: String(order.market_id),
      requested_by_user_id: String(requester.id),
      requested_by_role: this.requesterPrimaryRole(requester),
      requester_branch_id: requester.branch_id
        ? String(requester.branch_id)
        : null,
      action,
      amount: extraCost,
      proof_file_keys: proofFiles,
      operation_payload: {
        ...dto,
        extraCost,
        proofFileKeys: proofFiles,
        proofFileKeysVerified: true,
      },
      status: 'pending',
    });
    const saved = await this.extraCostApprovalRepo.save(approval);
    return successRes(
      {
        approval_required: true,
        approval: this.serializeExtraCostApproval(saved),
      },
      202,
      "Market tasdig'i kutilmoqda",
    );
  }

  private assertCanDecideExtraCostApproval(
    requester: { id: string; roles?: string[] },
    approval: OrderExtraCostApproval,
  ) {
    if (
      this.hasRole(requester, Roles.SUPERADMIN) ||
      this.hasRole(requester, Roles.ADMIN)
    ) {
      return;
    }
    if (
      this.hasRole(requester, Roles.MARKET) &&
      String(requester.id) === String(approval.market_id)
    ) {
      return;
    }
    this.forbidden("Bu qo'shimcha xarajat so'rovini tasdiqlash mumkin emas");
  }

  async listExtraCostApprovals(
    requester: { id: string; roles?: string[] },
    filters?: { status?: string },
  ) {
    const status = String(filters?.status ?? 'pending').toLowerCase();
    const where: Record<string, unknown> = {
      status,
      isDeleted: false,
    };
    if (
      !this.hasRole(requester, Roles.SUPERADMIN) &&
      !this.hasRole(requester, Roles.ADMIN)
    ) {
      if (!this.hasRole(requester, Roles.MARKET)) {
        this.forbidden("Qo'shimcha xarajat tasdiqlarini ko'rish mumkin emas");
      }
      where.market_id = String(requester.id);
    }
    const approvals = await this.extraCostApprovalRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return successRes(
      approvals.map((approval) => this.serializeExtraCostApproval(approval)),
      200,
      'Extra cost approvals',
    );
  }

  async approveExtraCostApproval(
    requester: { id: string; roles?: string[] },
    approvalId: string,
    dto?: { comment?: string },
  ) {
    const approval = await this.extraCostApprovalRepo.findOne({
      where: { id: String(approvalId), isDeleted: false },
    });
    if (!approval) {
      this.notFound('Extra cost approval not found');
    }
    this.assertCanDecideExtraCostApproval(requester, approval);
    if (approval.status !== 'pending') {
      this.badRequest("Bu so'rov allaqachon yakunlangan");
    }

    const actor = {
      id: String(approval.requested_by_user_id),
      roles: approval.requested_by_role ? [approval.requested_by_role] : [],
      branch_id: approval.requester_branch_id,
    };
    const payload = {
      ...(approval.operation_payload ?? {}),
      extraCostApproved: true,
    } as any;

    let result: unknown;
    if (approval.action === 'cancel') {
      result = await this.cancelOrder(
        actor,
        String(approval.order_id),
        payload,
        `extra-cost-approval:${approval.id}`,
      );
    } else if (approval.action === 'partly_sell') {
      result = await this.partlySellOrder(
        actor,
        String(approval.order_id),
        payload,
        `extra-cost-approval:${approval.id}`,
      );
    } else {
      result = await this.sellOrder(
        actor,
        String(approval.order_id),
        payload,
        `extra-cost-approval:${approval.id}`,
      );
    }

    approval.status = 'approved';
    approval.decided_by_user_id = String(requester.id);
    approval.decided_at = new Date();
    approval.decision_comment = dto?.comment ?? null;
    await this.extraCostApprovalRepo.save(approval);
    return successRes(
      {
        approval: this.serializeExtraCostApproval(approval),
        operation: result,
      },
      200,
      "Qo'shimcha xarajat tasdiqlandi",
    );
  }

  async rejectExtraCostApproval(
    requester: { id: string; roles?: string[] },
    approvalId: string,
    dto?: { comment?: string },
  ) {
    const approval = await this.extraCostApprovalRepo.findOne({
      where: { id: String(approvalId), isDeleted: false },
    });
    if (!approval) {
      this.notFound('Extra cost approval not found');
    }
    this.assertCanDecideExtraCostApproval(requester, approval);
    if (approval.status !== 'pending') {
      this.badRequest("Bu so'rov allaqachon yakunlangan");
    }
    approval.status = 'rejected';
    approval.decided_by_user_id = String(requester.id);
    approval.decided_at = new Date();
    approval.decision_comment = dto?.comment ?? null;
    await this.extraCostApprovalRepo.save(approval);
    return successRes(
      { approval: this.serializeExtraCostApproval(approval) },
      200,
      "Qo'shimcha xarajat rad etildi",
    );
  }

  /**
   * QO'SHIMCHA XARAJAT SUMMASI CHEGARASI.
   *
   * Ilgari Elchi'da faqat "KIM yozishi mumkin" tekshirilardi
   * (`assertCanAddExtraCost`), "QANCHA" esa UMUMAN tekshirilmasdi — kuryer
   * istagan summani yozib market kassasidan shuncha pul yechib olardi.
   * Yetkazish turi ham hisobga olinmasdi.
   *
   * QOIDA BeePost bilan bir xil (`server/src/api/order/utils/
   * extra-cost-limit.util.ts`) — ikki tizim ajralsa, kuryer eng bo'sh yo'lni
   * topib ishlatadi va chegara amalda eng bo'sh joyi bo'yicha ishlaydi.
   *
   * SOTUV (va qisman sotuv):
   *   1. UYGA yetkazishda xarajat YOZILMAYDI — uy tarifi allaqachon yuqori,
   *      ustiga xarajat yozish ikki marta to'lash bo'lardi.
   *   2. MARKAZGA: xarajat + markaz tarifi UY tarifidan oshmasin, ya'ni
   *      maksimum `tariff_home − tariff_center`. Kuryer markazga olib borib
   *      ustiga xarajat yozsa ham, uyga yetkazishdan qimmatga tushmasin.
   *   3. Tariflar TENG bo'lsa 2-qoida 0 beradi va bunday kuryer umuman
   *      xarajat yoza olmasdi. Bunda maksimum — o'z tarifining 50%i (to'liq
   *      tarif ruxsat etilsa xizmat haqi ikki baravar bo'lib ketardi).
   *
   * BEKOR QILISH — ataylab boshqa qoida: kuryer borib qaytdi, vaqt-yoqilg'i
   * sarfladi, lekin yetkazmadi. Maksimum = o'sha buyurtma kuryer tarifi,
   * uyga/markazga ajratilmaydi.
   */
  private assertExtraCostWithinLimit(params: {
    extraCost: number;
    mode: 'sell' | 'cancel';
    whereDeliver: Where_deliver | null | undefined;
    tariffCenter: number;
    tariffHome: number;
    /**
     * Manager kuryer emas — unda tarif tushunchasi YO'Q (`tariff_*` = 0).
     * Tarifga asoslangan chegarani unga qo'llasak, maksimum 0 chiqib manager
     * umuman xarajat yoza olmasdi. Manager uchun nazorat boshqa: uning
     * xarajati TASDIQLASH oqimidan o'tadi
     * (`requestExtraCostApprovalIfNeeded`).
     */
    isManager?: boolean;
  }): void {
    const { extraCost, mode, whereDeliver } = params;
    if (!(extraCost > 0)) return;
    if (params.isManager) return;

    const center = Math.max(0, Number(params.tariffCenter) || 0);
    const home = Math.max(0, Number(params.tariffHome) || 0);

    if (mode === 'cancel') {
      const tariff = whereDeliver === Where_deliver.CENTER ? center : home;
      const max = Math.floor(tariff);
      if (extraCost > max) {
        this.badRequest(
          `Qo'shimcha xarajat o'z xizmat haqqingizdan (${max} so'm) ` +
            `oshmasligi kerak`,
        );
      }
      return;
    }

    if (whereDeliver !== Where_deliver.CENTER) {
      this.badRequest(
        "Uyga yetkaziladigan buyurtmalarda qo'shimcha xarajat yozish mumkin " +
          'emas — uy tarifi allaqachon yuqori',
      );
    }

    const diff = home - center;
    // `Math.floor` — chegara butun so'm bo'lsin, kasrli chegara xato
    // xabarida tushunarsiz ko'rinadi.
    const max = diff > 0 ? Math.floor(diff) : Math.floor(center / 2);
    if (extraCost > max) {
      this.badRequest(
        `Qo'shimcha xarajat maksimal ${max} so'm bo'lishi mumkin ` +
          `(markaz tarifi: ${center}, uy tarifi: ${home})`,
      );
    }
  }

  private async assertCanAddExtraCost(params: {
    actor: { can_add_extra_cost?: boolean | null } | undefined;
    requester: { id: string; roles?: string[]; branch_id?: string | null };
    order: {
      branch_id?: string | null;
      home_branch_id?: string | null;
      holder_branch_id?: string | null;
    };
  }): Promise<void> {
    const { actor, requester, order } = params;
    if (actor?.can_add_extra_cost) {
      return;
    }

    const isCourierRequester = this.hasRole(requester, Roles.COURIER);
    if (!isCourierRequester) {
      this.forbidden(
        "Bu foydalanuvchiga qo'shimcha xarajat yozish ruxsati berilmagan",
      );
    }

    const assignment = await this.lookup.getBranchAssignmentByUser(
      String(requester.id),
    );
    const courierBranchId = String(assignment?.branch_id ?? '').trim();
    if (!courierBranchId) {
      this.forbidden(
        "Bu courier filialga biriktirilmagan, qo'shimcha xarajat yozish mumkin emas",
      );
    }

    const orderBranchIds = new Set(
      [order.branch_id, order.home_branch_id, order.holder_branch_id]
        .map((id) => String(id ?? '').trim())
        .filter(Boolean),
    );
    if (!orderBranchIds.has(courierBranchId)) {
      this.forbidden(
        "Courier bu buyurtmaning filialiga tegishli emas, qo'shimcha xarajat yozish mumkin emas",
      );
    }

    const branchUsers = await this.lookup.getBranchUsers(courierBranchId);
    const branchManagerAllows = branchUsers.some((item) => {
      const role = String(item?.role ?? item?.user?.role ?? '')
        .trim()
        .toUpperCase();
      return role === 'MANAGER' && Boolean(item?.user?.can_add_extra_cost);
    });
    if (!branchManagerAllows) {
      this.forbidden(
        "Bu filial manageriga qo'shimcha xarajat ruxsati berilmagan",
      );
    }
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
   * finance-service dedupes on (source_type, order_id, dedup_key), so
   * re-delivery or a status bounce is safe.
   *
   * ⚠️ ROLLBACKDA FOYDA ENDI QAYTARILADI (audit M4). Ilgari `sell_profit`
   * ataylab qaytarilmasdi ("daftar append-only"), lekin yozuv
   * `(source_type, order_id)` bo'yicha yagona edi — ya'ni ikki xato birga
   * yurardi: (a) buyurtma qaytarilib boshqa sotilmasa, olinmagan foyda
   * daftarda abadiy qolardi; (b) boshqa narxda qayta sotilsa, ESKI foyda
   * qolib, yangisi jimgina o'tkazib yuborilardi. Endi rollback teskari
   * CORRECTION yozuvini qo'yadi, har sotuv urinishi esa o'z `dedup_key`si
   * bilan keladi (`sold_at` — urinish boshiga yangi), shuning uchun qayta
   * sotuvning foydasi to'g'ri yoziladi.
   */
  private async enqueueFinanceOnStatusChange(
    order: Order,
    oldStatus: Order_status,
    manager: EntityManager,
    /** Rollbackdan OLDINGI `sold_at` — qaytariladigan sotuvning tokeni. */
    previousSoldAt?: string | null,
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
            // Urinish tokeni: `sold_at` har sotuvda yangidan yoziladi, ya'ni
            // qayta sotuv yangi yozuv ochadi, takroriy yetkazish esa ayni
            // token bilan kelib bir marta yoziladi.
            dedup_key: this.saleLedgerKey(order.sold_at),
          },
          { manager },
        );
      }
    } else if (leftSold) {
      if (order.operator_id) {
        await this.outbox.enqueue(
          'FINANCE',
          'finance.operator.earning.remove',
          { order_id: String(order.id) },
          { manager },
        );
      }

      // Sotuv foydasini teskari qilish. Summalar buyurtmadagi snapshotlardan
      // olinadi (rollback ularni o'chirmaydi), ya'ni tarif keyin o'zgargan
      // bo'lsa ham aynan yozilgani qaytariladi.
      const rolledBackProfit = computeSellProfit(
        Number(order.market_tariff ?? 0),
        Number(order.courier_share ?? order.courier_tariff ?? 0),
        Number(order.branch_share ?? 0),
      );
      if (rolledBackProfit !== 0) {
        await this.outbox.enqueue(
          'FINANCE',
          'finance.financial_balance.record',
          {
            amount: -rolledBackProfit,
            source_type: 'correction',
            order_id: String(order.id),
            related_user_id: order.market_id ? String(order.market_id) : null,
            comment: `Order #${order.id} sell profit rollback`,
            dedup_key: `rollback:${this.saleLedgerKey(previousSoldAt)}`,
          },
          { manager },
        );
      }
    }
  }

  /**
   * Sotuv urinishining daftar tokeni. `sold_at` har sotuvda yangidan yoziladi
   * (wall-clock), shuning uchun u urinishlarni ajratish uchun yetarli. Qiymat
   * bo'lmasa (juda eski buyurtmalar) bo'sh token qaytadi — u holda eski,
   * "buyurtma boshiga bitta yozuv" qoidasi ishlaydi.
   */
  private saleLedgerKey(soldAt?: string | null): string {
    const value = String(soldAt ?? '').trim();
    return value ? `sale:${value}` : '';
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

  /** SUPERADMIN yoki ADMIN (tizim darajasidagi xodim). */
  private isSystemPrivilegedRequester(
    requester: { roles?: string[] } | null | undefined,
  ): boolean {
    return (
      this.hasRole(requester ?? undefined, Roles.SUPERADMIN) ||
      this.hasRole(requester ?? undefined, Roles.ADMIN)
    );
  }

  /**
   * Posilka KURYER QO'LIDAMI (custody). `'0'` — tayinlanmagan pochta
   * sentineli, kuryer emas.
   */
  private isHeldByCourier(order: {
    holder_type?: OrderHolderType | string | null;
    holder_courier_id?: string | null;
    courier_id?: string | null;
  }): boolean {
    return (
      String(order.holder_type ?? '').toUpperCase() ===
        String(OrderHolderType.COURIER) ||
      Boolean(this.normalizeCourierId(order.holder_courier_id)) ||
      Boolean(this.normalizeCourierId(order.courier_id))
    );
  }

  /**
   * ⚠️ KURYERDAGI BUYURTMANI MENEJER SOTMAYDI (audit LC-04).
   *
   * Menejer sotuvining pul modeli "kuryer yo'q, naqd filialning o'zida":
   * moliyaviy aktyor menejer, kuryer oyog'i yozilmaydi, butun naqd FILIAL
   * kassasiga kirim bo'ladi va settlement qatori darhol COURIER_SETTLED.
   * Posilka (va mijoz naqdi) kuryer qo'lida bo'lsa bu noto'g'ri: daftar
   * kuryerda yo'q qarzni, filial kassasida esa menejerda yo'q naqdni
   * ko'rsatardi, kuryer o'z ulushini yo'qotardi, filial → HQ topshirishi
   * esa menejerda yo'q pulni kutardi. Bunday buyurtmani kuryerning o'zi
   * sotadi (kuryer yo'li — kuryer kassasi va qarzi bilan).
   */
  private assertManagerSaleNotCourierHeld(
    isManagerRequester: boolean,
    order: {
      holder_type?: OrderHolderType | string | null;
      holder_courier_id?: string | null;
      courier_id?: string | null;
    },
  ): void {
    if (isManagerRequester && this.isHeldByCourier(order)) {
      this.badRequest(
        "Bu buyurtma kuryer qo'lida — uni kuryerning o'zi sotadi. " +
          'Menejer faqat filialda turgan buyurtmani sota oladi',
      );
    }
  }

  /**
   * FILIAL XODIMI DOIRASI (fix3 C6/C13; CODE-03, CODE-09): buyurtma so'rovchi
   * filialiga tegishlimi. Doira gateway bilan AYNI — `branch_id`,
   * `holder_branch_id` yoki `home_branch_id` xodim filialiga teng (HQ
   * registratori uchun bu HQ'da yaratilgan barcha market buyurtmalari).
   *
   * ⚠️ FAIL-CLOSED: filial aniqlanmasa (biriktirilmagan yoki branch-service
   * javob bermadi) — 403. Aks holda "filiali yo'q" xodim cheklovsiz bo'lib
   * qolardi.
   */
  private async assertOrderInRequesterBranchScope(
    requester: { id?: string | null } | null | undefined,
    order: {
      branch_id?: string | null;
      holder_branch_id?: string | null;
      home_branch_id?: string | null;
    },
    deniedMessage: string,
  ): Promise<void> {
    const requesterId = String(requester?.id ?? '').trim();
    const assignment = requesterId
      ? await this.lookup.getBranchAssignmentByUser(requesterId)
      : null;
    const branchId = String(assignment?.branch_id ?? '').trim();
    if (!branchId) {
      this.forbidden(
        "Filialingiz aniqlanmadi — amal bajarilmadi. Filialga biriktirilganingizni tekshiring yoki qayta urinib ko'ring",
      );
    }
    const orderBranchIds = [
      order.branch_id,
      order.holder_branch_id,
      order.home_branch_id,
    ]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);
    if (!orderBranchIds.includes(branchId)) {
      this.forbidden(deniedMessage);
    }
  }

  /**
   * YARATISH SO'ROVINI SO'ROVCHIGA QARAB TOZALASH (fix3 C6; RBAC-05, LC-07,
   * LC-14) — gateway qoidasining xizmat qatlamidagi nusxasi.
   *
   *  - so'rovchi yo'q → ichki ishonchli chaqiruv (tashqi import,
   *    `createExternalOrder` — u o'zi tozalaydi): o'zgarishsiz;
   *  - SUPERADMIN/ADMIN → o'zgarishsiz;
   *  - qolganlar → hayot sikli/saqlash maydonlari olib tashlanadi (buyurtma
   *    DOIM NEW: market, bot va filial xodimi buyurtmasi HQ/filial qabulidan
   *    o'tadi);
   *  - market va market operatori (bot) → `branch_id` va `source` ham;
   *  - boshqa (filial xodimi) → `source` faqat `'branch'` bo'lishi mumkin.
   */
  private sanitizeCreateDtoForRequester<T extends object>(
    dto: T,
    requester?: { id?: string; roles?: string[] } | null,
  ): T {
    if (!requester || this.isSystemPrivilegedRequester(requester)) {
      return dto;
    }
    const isMarketScoped =
      this.hasRole(requester, Roles.MARKET) ||
      this.hasRole(requester, Roles.MARKET_OPERATOR);
    const sanitized = omitFields(dto, [
      ...CREATE_LIFECYCLE_FIELDS,
      ...(isMarketScoped ? CREATE_PLACEMENT_FIELDS : []),
    ]) as T & { source?: unknown };
    if (
      sanitized.source !== undefined &&
      sanitized.source !== null &&
      String(sanitized.source as string).toLowerCase() !==
        String(Order_source.BRANCH)
    ) {
      delete sanitized.source;
    }
    return sanitized;
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

  /**
   * RPC xatosidan foydalanuvchiga ko'rsatiladigan qisqa sabab. Mikroservis
   * xatosi `RpcException`, xom `{ statusCode, message }` obyekt yoki oddiy
   * `Error` bo'lib kelishi mumkin.
   */
  private describeRpcError(error: unknown): string {
    const payload: unknown =
      error instanceof RpcException ? error.getError() : error;
    if (typeof payload === 'string' && payload.trim()) {
      return payload.trim();
    }
    if (payload && typeof payload === 'object') {
      const message = (payload as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
      if (Array.isArray(message) && message.length) {
        return message
          .filter((item): item is string => typeof item === 'string')
          .join(', ');
      }
    }
    return 'logistika xizmati javob bermadi';
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

    /**
     * MENEJER HAM FAQAT SOTILGAN / BEKOR QILINGAN BUYURTMANI QAYTARADI
     * (audit RBAC-20). Ilgari status ro'yxati faqat kuryer va superadmin
     * uchun bor edi: menejer API orqali CLOSED (tovar marketga qaytgan),
     * RECEIVED yoki ON_THE_ROAD buyurtmani WAITING ga majburlay olardi —
     * keyingi sotuv market qo'lidagi tovar uchun pul yozardi. UI ham
     * rollbackni faqat shu ikki holatda ko'rsatadi.
     */
    if (
      isManager &&
      !isSuperAdmin &&
      !isCourier &&
      ![Order_status.SOLD, Order_status.CANCELLED].includes(order.status)
    ) {
      this.badRequest(`Rollback mumkin emas (status: ${order.status})`);
    }

    /**
     * ⚠️ KURYER FAQAT O'Z QO'LIDAGI BEKOR BUYURTMANI TIKLAYDI (audit LC-05).
     *
     * Bekor qilingan buyurtma kuryerning eski yetkazish pochtasida (`post_id`
     * hech qachon tozalanmaydi) qoladi, shuning uchun kuryer uni filial yoki
     * HQ qabul qilib bo'lganidan keyin ham "Barchasi" tabida ko'rib,
     * "Tiklash" bosa olardi. Natija: buyurtma WAITING bo'lib (holder HQ yoki
     * filial qolgan holda) HQ/market bekor ro'yxati va QR topshirishdan
     * chiqib ketardi, kuryerda esa "Sotish" tugmasi bilan qaytib chiqardi —
     * HQ javonidagi tovar uchun kuryerga naqd qarz yozilardi. Endi kuryer
     * faqat posilka hali o'zida turganda (holder = shu kuryer) tiklaydi.
     */
    if (isCourier && originalStatus === Order_status.CANCELLED) {
      // `holder_courier_id` faqat holder = COURIER bo'lganda to'ldiriladi
      // (`resolveHolderFromState`); filial/HQ/market holderida u null.
      const holderType = String(order.holder_type ?? '').toUpperCase();
      const holderCourierId = this.normalizeCourierId(order.holder_courier_id);
      const heldByRequester =
        (!holderType || holderType === String(OrderHolderType.COURIER)) &&
        Boolean(holderCourierId) &&
        holderCourierId === String(requester.id ?? '').trim();
      if (!heldByRequester) {
        this.badRequest(
          "Topshirilgan bekor buyurtmani qaytarib bo'lmaydi — posilka endi " +
            "filial yoki HQ qo'lida",
        );
      }
    }

    /**
     * ⚠️ SOTUV QAYDISIZ "SOTILGAN" BUYURTMA ROLLBACK QILINMAYDI (RBAC-05,
     * himoya chuqurligi).
     *
     * Har haqiqiy sotuv (`sellOrder`, `partlySellOrder`, kargo
     * `markByProvider`) `sold_at` ni yozadi, PATCH va yaratish DTO'lari esa
     * uni bera olmaydi. `sold_at` siz SOLD/PAID/PARTLY_PAID — sotish amalidan
     * o'tmagan (masalan to'g'ridan-to'g'ri `status:'sold'` bilan yaratilgan
     * yoki PATCH qilingan) buyurtma: uning kassa oyoqlari umuman YOZILMAGAN.
     * Rollback esa `sale_collectible_amount` bo'lmasa `total_price` bo'yicha
     * teskari oyoqlarni yozardi — market va filial/kuryer kassasiga hech
     * qachon kirmagan pul uchun CHIQIM (filialda "yo'qolgan" naqd, kuryerning
     * qarzi esa o'chib ketardi).
     */
    if (
      [Order_status.SOLD, Order_status.PAID, Order_status.PARTLY_PAID].includes(
        originalStatus,
      ) &&
      !String(order.sold_at ?? '').trim()
    ) {
      this.badRequest(
        "Bu buyurtma sotish amali orqali sotilmagan (sotuv vaqti yo'q) — " +
          'rollback kassaga teskari yozuv qila olmaydi. Superadminga murojaat qiling',
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
    /**
     * Kuryer pulni filialga topshirgan qator (audit M6) — `isCourierRemittedSettlement`
     * izohiga qarang. Kuryer va menejer uchun YOPIQ (avvalgidek).
     *
     * fix3b — SUPERADMIN tuzatish roli (hujjat: rollback chegarasi HQ —
     * "HQ'ga yetgach taqiqlanadi"; HQ'ga yetgan qator yuqorida hamma uchun
     * yopiq qoladi). Superadmin qaytarganda kuryer topshirgan summa
     * yo'qolmaydi: tranzaksiya ichida, `runFifoSettlement` dagi AYNI qoldiq
     * qulfi ostida qatorning `courier_amount` i kuryerning `courier_to_branch`
     * qoldig'iga qo'shiladi — u kuryerning KEYINGI topshirig'iga kredit
     * bo'ladi. So'ng oyoqlar kutilayotgan (PENDING) sotuvdagidek teskari
     * yoziladi. Xavfsiz bo'lmagan holatlar (manfiy/kredit qator, filialsiz
     * yoki HQ qatori, kuryer boshqa filialga o'tgan, qoldiq jadvali yo'q,
     * snapshot mos emas) aniq xabar bilan rad etiladi.
     */
    let remittedCourierCredit: RemittedCourierCredit | null = null;
    if (isCourierRemittedSettlement(existingSettlement)) {
      if (!isSuperAdmin) {
        this.badRequest(
          "Kuryer bu buyurtma pulini filialga topshirib bo'lgan — rollback " +
            'mumkin emas, aks holda kuryer hisob-kitobi buziladi. ' +
            'Tuzatishni faqat superadmin qila oladi',
        );
      }
      remittedCourierCredit =
        await this.prepareRemittedCourierCredit(existingSettlement);
    }

    const courierId = this.resolveActorCourierId(requester, order, post);
    if (!courierId) {
      this.notFound('Courier not found');
    }

    /**
     * ⚠️ TESKARI OYOQLAR SOTUV YOZGANIDAN OLINADI, SO'ROVCHIDAN EMAS
     * (audit M1/LC-01 — prod'da 289-kuryerda 140 000 soxta qarz qoldirgan).
     *
     * Ilgari menejer bosgan rollback moliyaviy aktyor sifatida MENEJERNI
     * olardi: kuryer kassasi umuman qaralmasdi, qo'shimcha xarajat esa filial
     * id si bilan qidirilardi. Kuryer sotgan buyurtmani menejer qaytarsa market
     * oyog'i va settlement qatori qaytarilardi, kuryer kassasidagi kirim esa
     * qolib ketardi. Endi kuryer oyog'i va xarajat egasi `order_settlement`
     * qatoridan olinadi — kuryerning o'z rollbacki (to'g'ri ishlaydigan yo'l)
     * bilan AYNAN bir xil oyoqlar, kim bosganidan qat'i nazar.
     */
    const reversalActor = resolveRollbackReversalActor({
      settlement: existingSettlement,
      legacy: {
        isManagerRequester,
        courierId,
        requesterBranchId: requester.branch_id ?? null,
      },
    });
    const saleCourierId = reversalActor.saleCourierId;

    const [market, financialActor] = await Promise.all([
      this.lookup
        .getMarketsByIds([String(order.market_id)])
        .then((rows) => rows[0]),
      saleCourierId
        ? this.lookup.getCouriersByIds([saleCourierId]).then((rows) => rows[0])
        : isManagerRequester
          ? this.lookup.getUserById(String(requester.id))
          : this.lookup.getCouriersByIds([courierId]).then((rows) => rows[0]),
    ]);
    if (!market) {
      this.notFound('Market not found');
    }
    if (!financialActor) {
      this.notFound(
        !saleCourierId && isManagerRequester
          ? 'Manager not found'
          : 'Courier not found',
      );
    }

    const [marketCashbox, courierCashbox] = await Promise.all([
      this.lookup.getCashboxByUser(
        String(order.market_id),
        Cashbox_type.FOR_MARKET,
      ),
      saleCourierId
        ? this.lookup
            .getCashboxByUser(saleCourierId, Cashbox_type.FOR_COURIER)
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    if (!marketCashbox) {
      this.notFound('Market cashbox not found');
    }
    if (saleCourierId && !courierCashbox) {
      this.notFound('Courier cashbox not found');
    }

    // Prefer the tariffs snapshotted on the order at sale time so the reversal
    // mirrors the original sale exactly, even if the market/courier tariff has
    // since changed. Fall back to live tariffs for orders sold before snapshots
    // were recorded.
    const marketTariff = resolveOrderTariff({
      snapshot: order.market_tariff,
      isCenter: order.where_deliver === Where_deliver.CENTER,
      centerTariff: market.tariff_center,
      homeTariff: market.tariff_home,
    });
    const courierTariff = resolveOrderTariff({
      snapshot: order.courier_tariff,
      isCenter: order.where_deliver === Where_deliver.CENTER,
      centerTariff: financialActor?.tariff_center,
      homeTariff: financialActor?.tariff_home,
    });
    const rollbackComment = `[ROLLBACK] ${order.comment || ''}`.trim();
    const totalPrice = Number(order.total_price ?? 0);

    /**
     * ⚠️ QO'SHIMCHA XARAJAT DETERMINISTIK QAYTARILADI (audit M5).
     *
     * Ilgari qaytarish faqat finance tarixidagi EXTRA_COST yozuvi `sold_at`
     * (bekorda `updatedAt`) dan 5 soniya ichida yaratilgan bo'lsagina
     * bajarilardi. U yozuv esa outbox relay orqali kechikib yoziladi:
     * tezkor rollbackda u hali yo'q, navbat to'lganda 5 soniyadan kech,
     * bekor qilingan buyurtmada `updatedAt` esa har yangilanishda siljiydi.
     * Settlement qatori esa baribir o'chirilardi — kuryer/filial va market
     * kassasida −E daftarsiz qolib, FIFO ni AYNAN E so'mga qotirardi.
     *
     * Endi summa — buyurtmaning o'zidagi snapshot (`extra_cost`, sotuv /
     * qisman sotuv / bekor qilishda yoziladi, rollbackda nolga tushadi),
     * egasi — settlement qatori (`resolveRollbackReversalActor`). Teskari
     * yozuv o'sha outbox navbatiga asl yozuvdan KEYIN qo'yiladi; asl yozuv
     * hali qayta urinishda bo'lsa ham natija o'zgarmaydi — ikkalasi ham tizim
     * oyog'i (EXTRA_COST / CORRECTION), finance ularni balans manfiyligidan
     * qat'i nazar qo'llaydi, ya'ni yig'indi aynan 0.
     */
    const extraCostRefundStatuses = [
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
      Order_status.CANCELLED,
      Order_status.CLOSED,
    ];
    const extraCostAmount = extraCostRefundStatuses.includes(originalStatus)
      ? Math.max(Number(order.extra_cost ?? 0) || 0, 0)
      : 0;
    const extraCostParty =
      extraCostAmount > 0 ? reversalActor.extraCostParty : null;
    if (extraCostParty?.cashbox_type === Cashbox_type.BRANCH) {
      await this.lookup.ensureBranchCashbox(extraCostParty.user_id);
    }
    const extraCostPartyCashbox = !extraCostParty
      ? null
      : extraCostParty.cashbox_type === Cashbox_type.FOR_COURIER &&
          extraCostParty.user_id === saleCourierId
        ? courierCashbox
        : await this.lookup
            .getCashboxByUser(
              extraCostParty.user_id,
              extraCostParty.cashbox_type,
            )
            .catch(() => null);
    if (extraCostParty && !extraCostPartyCashbox) {
      // Jimgina o'tkazib yuborilmaydi: aks holda settlement qatori o'chib,
      // xarajat egasi kassasida −E daftarsiz qolardi.
      this.notFound(
        extraCostParty.cashbox_type === Cashbox_type.BRANCH
          ? 'Filial kassasi topilmadi'
          : 'Courier cashbox not found',
      );
    }
    const isCancelledOriginal = [
      Order_status.CANCELLED,
      Order_status.CLOSED,
    ].includes(originalStatus);

    /**
     * fix3b (M6) — kredit yo'li uchun daftar ↔ kassa mosligi. Kuryer kassasi
     * pastdagi oyoqlar bilan AYNAN `courier_amount` ga kamayishi kerak, chunki
     * qoldiqqa aynan shu summa kredit yoziladi. Formulalar tranzaksiyadagi
     * kuryer oyoqlari bilan bir xil (`computeRollbackCourierCashboxDelta`).
     */
    if (remittedCourierCredit) {
      const courierCashboxDelta = computeRollbackCourierCashboxDelta({
        reverseSale:
          [Order_status.SOLD, Order_status.PAID].includes(originalStatus) ||
          (originalStatus === Order_status.PARTLY_PAID && isSuperAdmin),
        saleCollectible:
          order.sale_collectible_amount != null
            ? Number(order.sale_collectible_amount)
            : totalPrice,
        courierShare:
          order.courier_share != null
            ? Number(order.courier_share)
            : courierTariff,
        extraCostRefund:
          extraCostParty?.cashbox_type === Cashbox_type.FOR_COURIER &&
          extraCostParty.user_id === remittedCourierCredit.courierId
            ? extraCostAmount
            : 0,
      });
      if (
        saleCourierId !== remittedCourierCredit.courierId ||
        toTiyin(courierCashboxDelta) !== -toTiyin(remittedCourierCredit.amount)
      ) {
        this.badRequest(
          'Kuryer hisob-kitob qatori sotuv summalariga mos kelmaydi ' +
            `(qator: ${remittedCourierCredit.amount}, kassa qaytimi: ${-courierCashboxDelta}) — ` +
            'rollback kuryer daftarini buzadi, bajarilmadi. Buxgalteriya tuzatishi kerak',
        );
      }
    }

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

      // fix3b (M6): superadmin kredit yo'li — qoldiq QULFI ostida, oyoqlardan
      // OLDIN (qator qayta tekshiriladi; o'zgargan bo'lsa hech narsa yozilmaydi).
      if (remittedCourierCredit) {
        await this.creditRemittedCourierCarry(
          tx,
          String(order.id),
          remittedCourierCredit,
        );
      }

      // Per-rollback idempotency epoch on every CORRECTION posting: a second
      // rollback of the same order (after a re-sell) is not deduped against the
      // first; a per-posting sequence suffix avoids in-run index collisions.
      const pay = (
        // Sinf nomi orqali: `typeof this.…` bu metodda TS 5.9 da hal bo'lmaydi
        // (`partlySellOrder` dagi izohga qarang) — ma'nosi bir xil.
        data: Parameters<OrderLifecycleService['updateCashboxBalance']>[0],
      ): Promise<void> =>
        this.updateCashboxBalance(
          { ...data, dedup_epoch: `${rollbackEpoch}:${rollbackSeq++}` },
          tx,
        );

      /**
       * Qo'shimcha xarajatni qaytarish (audit M5) — sotuv oyoqlarini teskari
       * yozishdan OLDIN (avvalgi tartib: kuryer kassasi kirimni chiqimdan oldin
       * ko'radi). Sotilgan va bekor qilingan buyurtma uchun bitta yo'l.
       */
      if (extraCostAmount > 0) {
        const extraCostComment = isCancelledOriginal
          ? "Bekor qilingan buyurtmaga yozilgan qo'shimcha xarajat orqaga qaytarildi"
          : "Qo'shimcha xarajat orqaga qaytarildi";
        await pay({
          user_id: String(order.market_id),
          cashbox_type: Cashbox_type.FOR_MARKET,
          amount: extraCostAmount,
          operation_type: Operation_type.INCOME,
          source_type: Source_type.CORRECTION,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: extraCostComment,
        });
        if (extraCostParty && extraCostPartyCashbox) {
          await pay({
            user_id: extraCostParty.user_id,
            cashbox_type: extraCostParty.cashbox_type,
            amount: extraCostAmount,
            operation_type: Operation_type.INCOME,
            source_type: Source_type.CORRECTION,
            source_id: String(order.id),
            created_by: String(requester.id),
            comment: extraCostComment,
          });
        }

        /**
         * Moliyaviy balans: `sell_extra_cost` / `cancel_extra_cost` ning
         * teskarisi. ⚠️ `dedup_key` SHART (audit M13): busiz yozuv
         * (correction, order, '') bo'yicha bitta bo'lardi va ikkinchi
         * sotuv → rollback zanjirida jimgina tashlab yuborilardi. Ilgari
         * bekor qilingan buyurtmani qaytarishda bu yozuv umuman yo'q edi —
         * kassa qaytardi, balans esa −E da qolardi.
         */
        await this.outbox.enqueue(
          'FINANCE',
          'finance.financial_balance.record',
          {
            amount: extraCostAmount,
            source_type: 'correction',
            order_id: String(order.id),
            related_user_id: order.market_id ? String(order.market_id) : null,
            comment: `Order #${order.id} extra cost rollback`,
            dedup_key: `rollback-extra:${rollbackEpoch}`,
          },
          { manager: tx },
        );
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

        /**
         * ⚠️ SOTUVDA ISHLATILGAN NAQD — SNAPSHOTDAN, QAYTA HISOBLANMAYDI.
         *
         * Sotuv oyoqlari `total_price − paid_online_amount` bo'yicha yozilgan.
         * `paid_online_amount` esa sotuvdan KEYIN ham o'zgaradi: qaytarish
         * webhooki uni kamaytiradi. Shu bois bu yerda qayta hisoblansa
         * rollback BOSHQA summani teskari yozardi va kassada farq qolardi —
         * aynan `courier_share` va `branch_cashbox_amount` snapshot qilingan
         * sabab.
         *
         * `null` — bu ustundan OLDIN sotilgan buyurtma. Unda naqd oyoqlari
         * `total_price` bilan yozilgan, ya'ni zaxira ham aynan o'sha bo'lishi
         * kerak. Aks holda eski buyurtmani qaytarish kassani buzardi.
         */
        const saleCollectible =
          order.sale_collectible_amount != null
            ? Number(order.sale_collectible_amount)
            : totalPrice;

        const saleMarketIncome = Math.max(saleCollectible - marketTariff, 0);
        const saleMarketExpense = Math.max(marketTariff - saleCollectible, 0);
        const saleCourierIncome = Math.max(saleCollectible - courierShareRb, 0);
        const saleCourierExpense = Math.max(
          courierShareRb - saleCollectible,
          0,
        );
        const saleBranchNet = saleCollectible - courierShareRb - branchShareRb;
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

        // courier leg (reverse) — FAQAT sotuv kuryer kassasiga yozgan bo'lsa
        // va AYNAN o'sha kuryerda (audit M1/LC-01): so'rovchi menejer bo'lsa
        // ham kuryer oyog'i qaytariladi, menejer sotuvida esa yozilmagan oyoq
        // teskari yozilmaydi.
        if (saleCourierId && courierCashbox) {
          if (saleCourierIncome > 0) {
            await pay({
              user_id: saleCourierId,
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
              user_id: saleCourierId,
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

      // Qo'shimcha xarajat yuqorida qaytarildi — buyurtmadagi snapshot ham
      // nolga tushadi. Qolsa, keyingi rollback (qayta sotuv/bekordan keyin)
      // o'sha eski summani yana qaytarardi (audit M5).
      const extraCostReset = extraCostAmount > 0 ? { extra_cost: 0 } : {};

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
            ...extraCostReset,
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
          {
            status: Order_status.WAITING,
            paid_amount: 0,
            sold_at: null,
            ...extraCostReset,
          },
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
          {
            status: Order_status.WAITING,
            to_be_paid: 0,
            sold_at: null,
            // Sotuv bekor qilindi — snapshot ham tozalanadi. Qolsa, keyingi
            // sotuvda ESKI naqd bilan rollback qilinardi.
            sale_collectible_amount: null,
            ...extraCostReset,
          },
          {
            id: requester.id,
            roles: requester.roles,
            note: 'Rollback to waiting',
            audit: false,
          },
          tx,
        );
      }

      mergedPartialChildren = await this.mergePartialChildrenBack(tx, order);

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
    /**
     * ⚠️ BEKOR POCHTASI XATOSI ROLLBACKNI 500 GA AYLANTIRMAYDI (CODE-14).
     * Ilgari bu chaqiruv try/catch siz edi: rollback allaqachon commit
     * bo'lgan, mijoz esa 500 olib qayta urinardi (endi "status o'zgargan"
     * xatosini olardi). Endi muvaffaqiyat qaytadi, ogohlantirish bilan —
     * buyurtma CANCELLED holatida, pochtaga qo'lda qo'shiladi.
     */
    let cancelPostWarning: string | null = null;
    if (rollbackTarget === 'cancelled_sent') {
      try {
        await rmqSend(
          this.logisticsClient,
          { cmd: 'logistics.post.cancel.create' },
          {
            dto: { order_ids: [String(id)] },
            requester: {
              id: String(requester.id),
              roles: requester.roles ?? [],
            },
          },
        );
      } catch (error) {
        const reason = this.describeRpcError(error);
        this.logger.warn(
          `rollback ${String(id)}: bekor qilinganlar pochtasi yaratilmadi — ${reason}`,
        );
        cancelPostWarning =
          `Buyurtma bekor qilindi, lekin bekor qilinganlar pochtasiga ` +
          `qo'shilmadi (${reason}). Uni pochtaga qo'lda qo'shing.`;
      }
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
        // Qaysi kassalar teskari yozildi — sotuv yozgan oyoqlar (M1/LC-01).
        reversal_courier_id: saleCourierId,
        reversal_source: reversalActor.source,
        extra_cost_refunded: extraCostAmount,
        extra_cost_party: extraCostParty,
        ...(cancelPostWarning
          ? { cancel_post_warning: cancelPostWarning }
          : {}),
        // fix3b (M6): superadmin tuzatishi — kuryer qoldig'iga yozilgan kredit.
        ...(remittedCourierCredit
          ? {
              courier_credit_carried: remittedCourierCredit.amount,
              courier_credit_courier_id: remittedCourierCredit.courierId,
              courier_credit_branch_id: remittedCourierCredit.branchId,
            }
          : {}),
      },
    });

    // G3 — TASHQI SINXRON. Avval rollback HECH QANDAY signal yubormasdi: Elchi
    // sotilgan buyurtmani orqaga qaytarsa, hamkor tomonda u SOTILGAN bo'lib
    // qolardi va pul desinxron bo'lardi. Endi har rollback yo'nalishi uchun
    // signal chiqadi (waiting / cancelled / cancelled_sent).
    //
    // `order` — rollbackdan OLDINGI snapshot; bu yerda faqat `external_id` kerak
    // (u o'zgarmaydi). `cod_collected` esa terminal bo'lmagan statusда baribir
    // 0'ga majburlanadi, shuning uchun eski `paid_amount` zarar qilmaydi.
    try {
      const syncAction = this.resolveSyncAction(originalStatus, finalStatus);
      if (syncAction) {
        void this.queueExternalStatusSync(
          order,
          syncAction,
          originalStatus,
          finalStatus,
        );
      }
    } catch {
      // Tashqi sinxron best-effort — rollbackning o'zi allaqachon durable.
    }

    // fix3b (M6): superadmin tuzatishida kuryer krediti haqida aniq xabar.
    const courierCreditNote = remittedCourierCredit
      ? `. Kuryer filialga topshirgan ${remittedCourierCredit.amount} so'm ` +
        "uning keyingi topshirig'iga hisoblanadi"
      : '';
    if (rollbackTarget === 'cancelled') {
      return successRes(
        {},
        200,
        `Order CANCELLED holatiga qaytarildi${courierCreditNote}`,
      );
    }
    if (rollbackTarget === 'cancelled_sent') {
      if (cancelPostWarning) {
        return successRes(
          { cancel_post_created: false, warning: cancelPostWarning },
          200,
          cancelPostWarning,
        );
      }
      return successRes({}, 200, "Order bekor qilinib pochtaga qo'shildi");
    }
    return successRes(
      {},
      200,
      `Order WAITING holatiga qaytarildi${courierCreditNote}`,
    );
  }

  /**
   * fix3b (M6) — superadmin kredit yo'lining TRANZAKSIYADAN OLDINGI
   * tekshiruvi. Faqat xavfsiz holat o'tadi, aks holda aniq sabab bilan 400
   * (yoki ma'lumot o'qib bo'lmasa 503); yarim ishlaydigan yo'l yo'q.
   */
  private async prepareRemittedCourierCredit(
    settlement: OrderSettlement | null,
  ): Promise<RemittedCourierCredit> {
    const courierId = this.normalizeCourierId(settlement?.courier_id);
    const branchId = String(settlement?.branch_id ?? '').trim();
    const amount = Number(settlement?.courier_amount ?? 0) || 0;
    if (!settlement || !courierId) {
      this.badRequest(
        'Kuryer hisob-kitob qatori topilmadi — rollback bajarilmadi',
      );
    }
    // Manfiy (kredit) qator: qoldiq manfiy bo'la olmaydi (FIFO uni 0 deb
    // o'qiydi), ya'ni teskari yozuvni daftarda ifodalab bo'lmaydi.
    if (toTiyin(amount) <= 0) {
      this.badRequest(
        "Kuryer bu buyurtmaning manfiy (kredit) summasini topshiriqda ishlatib bo'lgan — " +
          "rollback kuryer qoldig'ini manfiy qilardi, superadmin ham qaytara olmaydi. " +
          'Buxgalteriya tuzatishi kerak',
      );
    }
    if (!branchId) {
      this.badRequest(
        "Kuryer to'lovi filialsiz qatorda — rollback mumkin emas (naqd HQ'da)",
      );
    }

    const hqBranchId = String((await this.lookup.getHqBranchId()) ?? '').trim();
    if (!hqBranchId) {
      throw new RpcException({
        statusCode: 503,
        message:
          "Bosh ofis filialini aniqlab bo'lmadi — birozdan so'ng qayta urinib ko'ring",
      });
    }
    if (branchId === hqBranchId) {
      // HQ qatorida kuryer naqdi MAIN'da; qoldiq esa filial kuryeri deb
      // yozilib, moliyaviy balansni og'dirardi.
      this.badRequest(
        "Bu qator HQ filialiga yozilgan — kuryer kreditini avtomatik yozib bo'lmaydi, " +
          'rollback bajarilmadi',
      );
    }

    if (!(await this.isSettlementCarryTablePresent())) {
      this.badRequest(
        "Hisob-kitob qoldig'i jadvali topilmadi — kuryer kreditini yozib bo'lmaydi, " +
          'rollback bajarilmadi',
      );
    }

    // Kredit AYNAN o'sha filialda sarflanishi kerak: kuryer keyingi pulni o'z
    // filialiga topshiradi, topshirilgan naqd esa shu qator filialida turibdi.
    let assignment: { branch_id?: string | null } | null;
    try {
      assignment = await this.lookup.getBranchAssignmentByUserStrict(courierId);
    } catch {
      throw new RpcException({
        statusCode: 503,
        message:
          "Kuryer filialini aniqlab bo'lmadi — birozdan so'ng qayta urinib ko'ring",
      });
    }
    if (String(assignment?.branch_id ?? '').trim() !== branchId) {
      this.badRequest(
        'Kuryer endi boshqa filialda (yoki filialga biriktirilmagan) — topshirilgan ' +
          "summani uning hisobiga o'tkazib bo'lmaydi, rollback bajarilmadi",
      );
    }

    return {
      courierId,
      branchId,
      amount: toTiyin(amount) / 100,
      status: settlement.status,
    };
  }

  /** `order_settlement_carry` jadvali bormi (migratsiya ishlaganmi). */
  private async isSettlementCarryTablePresent(): Promise<boolean> {
    try {
      const schema =
        (this.dataSource.options as { schema?: string } | undefined)?.schema ||
        'public';
      const rows: Array<{ t: string | null }> = await this.dataSource.query(
        'SELECT to_regclass($1) AS t',
        [`${schema}.order_settlement_carry`],
      );
      return Boolean(rows?.[0]?.t);
    } catch {
      return false;
    }
  }

  /**
   * fix3b (M6) — kuryer kreditini rollback tranzaksiyasi ICHIDA yozish.
   *
   * Qulf tartibi `runFifoSettlement` bilan mos: avval qoldiq qatori
   * (`INSERT … ON CONFLICT DO NOTHING` + `pessimistic_write`), keyin
   * settlement qatori. Ikkala qoldiq qulflanadi:
   *   • kuryer (`courier_to_branch`) — kuryerning parallel to'lovi shu
   *     qoldiqni o'qib-yozadi, ikkalasi navbatga turadi;
   *   • filial (`branch_to_hq`) — filial → HQ FIFO aynan shu COURIER_SETTLED
   *     qatorni BRANCH_SETTLED qilishi mumkin; u ham shu qulfni oladi, ya'ni
   *     yo u avval tugaydi (qator HQ'ga yetgan → pastda rad), yo bu rollback
   *     commit bo'lgach o'chirilgan qatorni ko'rmaydi.
   * Qulf ostida qator qayta o'qiladi: holati yoki summasi o'zgargan bo'lsa
   * 400, hech narsa yozilmaydi (tranzaksiya qaytadi).
   */
  private async creditRemittedCourierCarry(
    tx: EntityManager,
    orderId: string,
    credit: RemittedCourierCredit,
  ): Promise<void> {
    const carryRepo = tx.getRepository(OrderSettlementCarry);
    await carryRepo
      .createQueryBuilder()
      .insert()
      .values({
        level: 'courier_to_branch',
        party_id: credit.courierId,
        branch_id: credit.branchId,
        amount: 0,
      })
      .orIgnore()
      .execute();
    const courierCarry = await carryRepo.findOne({
      where: { level: 'courier_to_branch', party_id: credit.courierId },
      lock: { mode: 'pessimistic_write' },
    });
    await carryRepo
      .createQueryBuilder()
      .insert()
      .values({
        level: 'branch_to_hq',
        party_id: credit.branchId,
        branch_id: null,
        amount: 0,
      })
      .orIgnore()
      .execute();
    await carryRepo.findOne({
      where: { level: 'branch_to_hq', party_id: credit.branchId },
      lock: { mode: 'pessimistic_write' },
    });

    const row = await tx.getRepository(OrderSettlement).findOne({
      where: { order_id: String(orderId), isDeleted: false },
      lock: { mode: 'pessimistic_write' },
    });
    if (row && this.isSettledToHq(row.status)) {
      this.badRequest(
        "Bu buyurtma summasi bosh ofisga to'langan — rollback mumkin emas",
      );
    }
    if (
      !row ||
      row.status !== credit.status ||
      this.normalizeCourierId(row.courier_id) !== credit.courierId ||
      String(row.branch_id ?? '').trim() !== credit.branchId ||
      toTiyin(row.courier_amount) !== toTiyin(credit.amount)
    ) {
      this.badRequest(
        "Rollback holati o'zgargan (hisob-kitob qatori yangilangan) — qayta urinib ko'ring",
      );
    }
    if (!courierCarry) {
      this.badRequest(
        "Kuryer qoldig'i qatorini qulflab bo'lmadi — rollback bajarilmadi",
      );
    }

    const existingAmount = Number(courierCarry.amount ?? 0) || 0;
    const existingBranchId = String(courierCarry.branch_id ?? '').trim();
    if (toTiyin(existingAmount) > 0 && existingBranchId !== credit.branchId) {
      this.badRequest(
        'Kuryerda boshqa filialga tegishli qoldiq bor — rollback bajarilmadi',
      );
    }
    await carryRepo.update(
      { id: courierCarry.id },
      {
        amount:
          (Math.max(toTiyin(existingAmount), 0) + toTiyin(credit.amount)) / 100,
        branch_id: credit.branchId,
      },
    );
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
    /**
     * fix3 C13 (CODE-09): qaytarishni SA/admin istalgan buyurtmada, registrator
     * esa FAQAT o'z filiali doirasidagisida boshlaydi. Ilgari doira yo'q edi:
     * istalgan filial registratori boshqa filial buyurtmasiga "qaytarish
     * so'rovi" belgisini qo'ya olardi — u menejerning "Qaytarish" ro'yxatida
     * chiqib, tasdiqlansa custody kuryerdan filialga o'tib ketardi.
     */
    if (!this.isSystemPrivilegedRequester(requester)) {
      if (!this.hasRole(requester, Roles.REGISTRATOR)) {
        this.forbidden("Qaytarishni boshlashga ruxsat yo'q");
      }
      await this.assertOrderInRequesterBranchScope(
        requester,
        order,
        'Bu buyurtma sizning filialingizga tegishli emas — uni qaytarishni boshlay olmaysiz',
      );
    }
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

    // G4 — TASHQI SINXRON. Bu funksiya `updateFull`dan o'tmaydi (statusni
    // to'g'ridan-to'g'ri tranzaksiya ichida yozadi), shuning uchun signal
    // ALOHIDA chiqariladi — aks holda hamkor posilkaning qaytganini bilmaydi.
    try {
      const syncAction = this.resolveSyncAction(
        oldStatus,
        Order_status.RETURNED_TO_MARKET,
      );
      if (syncAction) {
        void this.queueExternalStatusSync(
          updated,
          syncAction,
          oldStatus,
          Order_status.RETURNED_TO_MARKET,
        );
      }
    } catch {
      // Best-effort: qaytarishning o'zi allaqachon durable.
    }

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
            authorization_token_hash:
              this.hashHandoverToken(authorizationToken),
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

    // G4 — TASHQI SINXRON. Bekor qilingan mol jismonan marketga qaytdi;
    // hamkor (BeePost) buni bilishi uchun ALOHIDA signal chiqariladi. Elchining
    // o'z statusi CLOSED qoladi (rollback/return shartlari CLOSED'ga bog'liq),
    // lekin hamkorga `returned_to_market` yuboriladi — BeePost uni
    // CANCELLED_SENT + 'return' amaliga xaritalaydi. Dedup (partner_id,
    // order_id, new_status) to'smaydi: oldin 'cancelled' ketgan, bu boshqa status.
    for (const order of handedOverOrders) {
      try {
        void this.queueExternalStatusSync(
          order,
          'canceled',
          Order_status.CANCELLED,
          Order_status.RETURNED_TO_MARKET,
        );
      } catch {
        // Best-effort: topshirishning o'zi allaqachon durable (commit bo'lgan).
      }
    }

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

  /**
   * Yaratishdagi `paid_online_amount` (fix3b): berilmasa 0; berilsa son,
   * 0 ≤ qiymat ≤ total_price (tiyin aniqligida). Aks holda 400 — yozilsa
   * sotuv kuryerdan yig'ilmaydigan naqdni noto'g'ri hisoblardi.
   */
  private resolveCreatePaidOnlineAmount(
    raw: number | string | null | undefined,
    totalPrice: number | undefined,
  ): number {
    if (raw === undefined || raw === null || raw === '') {
      return 0;
    }
    const amount = typeof raw === 'number' ? raw : Number(String(raw).trim());
    const total = Number(totalPrice ?? 0);
    if (
      !Number.isFinite(amount) ||
      !Number.isFinite(total) ||
      toTiyin(amount) < 0 ||
      toTiyin(amount) > toTiyin(total)
    ) {
      this.badRequest(
        `paid_online_amount (${String(raw)}) 0 dan kichik yoki buyurtma ` +
          `summasidan (${String(totalPrice ?? 0)}) katta bo'lmasligi kerak`,
      );
    }
    return toTiyin(amount) / 100;
  }

  async create(
    rawDto: {
      market_id: string;
      customer_id: string;
      where_deliver?: Where_deliver;
      total_price?: number;
      to_be_paid?: number;
      paid_amount?: number;
      /**
       * Mijoz oldindan (onlayn / hamkor orqali) to'lagan qism — fix3b.
       * `createPartnerShipment` `subtotal − cod_amount` ni yuboradi.
       * 0 ≤ qiymat ≤ total_price; faqat imtiyozli/ichki chaqiruvdan.
       */
      paid_online_amount?: number | string | null;
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
      /** Kiruvchi qop (batch) — hamkor yuborgan guruh ma'lumoti. */
      external_batch_ref?: string | null;
      external_batch_token?: string | null;
      external_batch_size?: number | null;
      source?: Order_source;
      items?: Array<{
        product_id?: string | null;
        product_name?: string | null;
        quantity?: number;
      }>;
    },
    requester?: { id: string; roles?: string[] },
  ) {
    // fix3 C6 (RBAC-05, LC-07, LC-14): SUPERADMIN/ADMIN dan boshqa
    // yaratuvchining hayot sikli/saqlash maydonlari olib tashlanadi —
    // buyurtma DOIM NEW, kuryersiz va pochtasiz.
    const dto = this.sanitizeCreateDtoForRequester(rawDto, requester);
    // fix3b: hamkor prepaid summasi endi SAQLANADI (tozalashdan keyin —
    // market/filial xodimidan kelgani allaqachon olib tashlangan).
    const paidOnlineAmount = this.resolveCreatePaidOnlineAmount(
      dto.paid_online_amount,
      dto.total_price,
    );
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
        /**
         * ⚠️ fix3b — HAMKOR PREPAID PUL XATOSI (HIGH, fix3 dan oldingi).
         * `createPartnerShipment` `subtotal − cod_amount` ni yuborardi, bu
         * yer esa uni yozmasdi (ustun sukuti 0): sotuv `total_price` ni to'liq
         * naqd deb hisoblab, kuryerni olMAGAN pul uchun qarzdor, marketni esa
         * marketpleys allaqachon olgan pul uchun haqdor qilardi.
         */
        paid_online_amount: paidOnlineAmount,
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
        last_handover_by: this.numericActorId(requester?.id),
        return_reason: dto.return_reason ?? null,
        district_id: dto.district_id ?? null,
        region_id: dto.region_id ?? null,
        address: dto.address ?? null,
        qr_code_token: dto.qr_code_token ?? this.generateCustomToken(),
        parent_order_id: dto.parent_order_id ?? null,
        external_id: dto.external_id ?? null,
        /**
         * KIRUVCHI QOP — hamkor bir qopda yuborgan posilkalar guruhi.
         * Kiruvchi ekranda guruhlash va qop yorlig'ini skanerlash uchun.
         */
        external_batch_ref: dto.external_batch_ref ?? null,
        external_batch_token: dto.external_batch_token ?? null,
        external_batch_size: dto.external_batch_size ?? null,
        source: dto.source ?? Order_source.INTERNAL,
        isDeleted: false,
      });

      const saved = await orderRepo.save(order);
      savedId = saved.id;

      const normalizedItems = (dto.items ?? []).map((item) => {
        const productId = item.product_id
          ? String(item.product_id).trim()
          : null;
        const productName = item.product_name?.trim() || null;
        if (!productId && !productName) {
          this.badRequest('Item uchun product_id yoki product_name majburiy');
        }
        return {
          product_id: productId,
          product_name: productName,
          quantity: item.quantity ?? 1,
          order_id: saved.id,
        };
      });
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

  /**
   * POST /orders/external.
   *
   * fix3 C6 (RBAC-05, LC-07): hayot sikli/saqlash va joylashuv maydonlari
   * (status, post_id, courier_id, branch_id, ...) faqat SUPERADMIN/ADMIN dan
   * qabul qilinadi; qolganlar uchun buyurtma DOIM NEW. ⚠️ FAIL-CLOSED:
   * so'rovchi uzatilmasa (eski chaqiruvchi) ham imtiyozsiz deb hisoblanadi —
   * bu yo'lning yagona chaqiruvchisi gateway, frontend esa uni ishlatmaydi.
   * `create()` ga so'rovchi ATAYLAB uzatilmaydi (u `source` ni
   * `EXTERNAL` dan tozalab yuborardi): audit avvalgidek 'system'.
   *
   * fix3b: filial xodimi (registrator/menejer/filial) — buyurtma o'z
   * biriktirilgan filialida yaratiladi, `createOrderInternal` (POST /orders)
   * bilan AYNI qoida; `source` EXTERNAL bo'lib qoladi. Market va boshqalar —
   * avvalgidek HQ.
   */
  async createExternalOrder(
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
      post_id?: string | null;
      district_id?: string | null;
      region_id?: string | null;
      address?: string | null;
      qr_code_token?: string | null;
      external_id?: string | null;
      items?: Array<{
        product_id?: string | null;
        product_name?: string | null;
        quantity?: number;
      }>;
    },
    requester?: {
      id?: string;
      roles?: string[];
      branch_id?: string | null;
    } | null,
  ) {
    const isPrivileged = this.isSystemPrivilegedRequester(requester);
    const safeDto = isPrivileged
      ? dto
      : omitFields(dto, [
          ...CREATE_LIFECYCLE_FIELDS,
          ...CREATE_PLACEMENT_FIELDS,
        ]);
    const staffBranchId = isPrivileged
      ? null
      : await this.resolveExternalCreateStaffBranchId(requester);
    return this.create({
      ...safeDto,
      ...(staffBranchId ? { branch_id: staffBranchId } : {}),
      source: Order_source.EXTERNAL,
      operator: safeDto.operator ?? 'external_manual',
      status: isPrivileged
        ? (dto.status ?? Order_status.NEW)
        : Order_status.NEW,
    });
  }

  /**
   * POST /orders/external — filial xodimining filiali (fix3b).
   * `createOrderInternal` (gateway) bilan AYNI qoida:
   *   - rolda registrator/menejer/filial yo'q → `null` (avvalgidek HQ);
   *   - JWT `branch_id` bo'lsa → o'sha (RMQ'siz);
   *   - aks holda branch_users biriktiruvi: roli MANAGER/REGISTRATOR/BRANCH
   *     bo'lsa uning filiali (filialsiz bo'lsa 400), biriktiruv yo'q → `null`.
   * ⚠️ branch-service javob bermasa — 503 (fail-closed): filial xodimi
   * buyurtmasi jimgina HQ ga tushib qolmasin (gateway ham shu holatda
   * so'rovni yiqitadi).
   */
  private async resolveExternalCreateStaffBranchId(
    requester:
      | { id?: string; roles?: string[]; branch_id?: string | null }
      | null
      | undefined,
  ): Promise<string | null> {
    const isStaffRole =
      this.hasRole(requester ?? undefined, Roles.REGISTRATOR) ||
      this.hasRole(requester ?? undefined, Roles.MANAGER) ||
      this.hasRole(requester ?? undefined, Roles.BRANCH);
    const requesterId = String(requester?.id ?? '').trim();
    if (!isStaffRole || !requesterId) {
      return null;
    }
    const jwtBranchId = String(requester?.branch_id ?? '').trim();
    if (jwtBranchId) {
      return jwtBranchId;
    }

    let assignment: { branch_id?: string | null; role?: string | null } | null;
    try {
      assignment =
        await this.lookup.getBranchAssignmentByUserStrict(requesterId);
    } catch (error) {
      const rawMessage = (error as { message?: unknown } | null)?.message;
      const reason =
        error instanceof Error
          ? error.message
          : typeof rawMessage === 'string'
            ? rawMessage
            : '';
      this.logger.warn(
        `createExternalOrder: filial biriktiruvi o'qilmadi (user=${requesterId}): ${reason}`,
      );
      throw new RpcException({
        statusCode: 503,
        message:
          "Filialingizni aniqlab bo'lmadi — birozdan so'ng qayta urinib ko'ring",
      });
    }
    const assignmentRole = String(assignment?.role ?? '').toUpperCase();
    if (!['MANAGER', 'REGISTRATOR', 'BRANCH'].includes(assignmentRole)) {
      return null;
    }
    const assignedBranchId = String(assignment?.branch_id ?? '').trim();
    if (!assignedBranchId) {
      this.badRequest('Filial xodimi hech qaysi filialga biriktirilmagan');
    }
    return assignedBranchId;
  }

  private generateCustomToken(length = 24): string {
    const chars = 'abcdef0123456789';
    let token = '';
    for (let i = 0; i < length; i += 1) {
      token += chars[Math.floor(Math.random() * chars.length)];
    }
    return token;
  }

  /**
   * Tashqi tizimdan kelgan pul qiymatini XAVFSIZ o'qish.
   *
   * `null` qaytsa — qiymat SON EMAS va qator tashlanishi kerak.
   * Berilmagan (`null`/`undefined`/bo'sh satr) esa 0 — bu qonuniy holat
   * (bepul yoki oldindan to'langan posilka).
   *
   * ⚠️ `Number('250 000')` → `NaN`, `Number('')` → `0`, `Number([])` → `0`.
   * Oxirgi ikkisi tuzoq: bo'sh massiv "narx yo'q" degani, 0 emas — shu
   * bois faqat son va satr qabul qilinadi.
   */
  private safeExternalAmount(value: unknown): number | null {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== 'string') return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
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
    // C2.3 — Elchi Partner API chiquvchi webhook. Bu YO'L `operator='external_'`
    // shartiga bog'liq EMAS (partner order'larda operator boshqacha) — barcha
    // external_id'li order uchun signal yuboriladi; integration-service
    // partner_shipment_ref bo'yicha filtrlaydi (partner emas → no-op).
    // ⚠️ `paid_amount` — "kuryer yig'gan pul" EMAS (avval shunday yozilgan edi).
    // U `to_be_paid` (= total_price − market_tariff) QARZINING allaqachon
    // to'langan qismi; oddiy sotuvda 0 bo'lib qoladi. Hamkorga `cod_collected`
    // nomi bilan boradi — nom tarixiy, semantikasi shu.
    /**
     * HAMKORGA YUBORILADIGAN HAQIQIY PUL QIYMATLARI (audit M2).
     *
     * Uchalasi SNAPSHOTDAN olinadi, qayta hisoblanmaydi: sotuvdan keyin
     * `paid_online_amount` (qaytarish webhooki) yoki tarif o'zgarishi
     * mumkin, qayta hisob esa hamkorga BOSHQA raqam yuborardi va ikki
     * daftar jimgina ajralib qolardi.
     *
     * `null` — buyurtma hali sotilmagan (yoki rollback qilingan). Bu
     * ATAYLAB: 0 yuborish "yig'ildi, lekin hech narsa emas" degan ma'noli
     * da'vo bo'lardi va hamkor uni qarz hisobiga qo'shardi.
     */
    const collectedFromCustomer =
      order.sale_collectible_amount != null
        ? Number(order.sale_collectible_amount)
        : null;
    const elchiFee =
      order.market_tariff != null ? Number(order.market_tariff) : null;
    /** Elchi hamkorga qarzi: yig'ilgan naqd minus bizning tarifimiz. */
    const marketAmount =
      collectedFromCustomer != null && elchiFee != null
        ? collectedFromCustomer - elchiFee
        : null;

    if (order.external_id) {
      await rmqSend(
        this.integrationClient,
        { cmd: 'integration.partner.webhook.enqueue' },
        {
          order_id: order.id,
          external_order_id: order.external_id,
          action,
          old_status,
          new_status,
          /**
           * ⚠️ NOMI TARIXIY VA CHALG'ITADI (audit F1).
           *
           * `paid_amount` — MIJOZDAN yig'ilgan pul EMAS. U market qarzining
           * (`total_price − market_tariff`) darhol to'langan qismi. Oddiy
           * sotuvda u 0 bo'lib qoladi.
           *
           * Nom hamkor kontraktida allaqachon e'lon qilingan, shuning uchun
           * uni olib tashlamaymiz — lekin yoniga ANIQ NOMLI maydonlar
           * qo'shildi (`market_paid_amount`, `cod_amount`).
           */
          cod_collected: Number(order.paid_amount ?? 0),
          /** Yuqoridagi qiymatning to'g'ri nomi. */
          market_paid_amount: Number(order.paid_amount ?? 0),
          /*
            ⚠️ `cod_amount` ATAYLAB YUBORILMAYDI.

            Uni `order.to_be_paid` dan olish MANTIQIY ko'rinadi, lekin bu
            ustun IKKI XIL ma'noda ishlatiladi:
              • hamkor posilkasi yaratilganda — mijozdan yig'ilishi kerak
                bo'lgan COD (`createPartnerShipment` shunday yozadi);
              • ichki buyurtmada sukut bo'yicha 0, va SOTUVDAN KEYIN
                `netToBePaid` (= total_price − market_tariff) bilan ustiga
                yoziladi (`:4081`, `:4153`, `:5200`).

            Ya'ni sotuvdan keyin qiymat butunlay boshqa narsani bildiradi va
            hamkorga yuborilsa YOLG'ON bo'lardi. Hamkor o'zi yuborgan
            `cod_amount`ni biladi; bizda esa uni ishonchli saqlaydigan joy
            yo'q. Bu audit F2 ning bir qismi va alohida qaror talab qiladi.
          */
          /**
           * HAQIQIY PUL MAYDONLARI (audit M2).
           *
           * ⚠️ NEGA KERAK BO'LDI. Yuqoridagi `cod_collected` nomi yolg'on va
           * hamkor tomonida JIM buzilish keltirgan: BeePost uni "Elchi
           * yig'gan pul" deb o'qib, hisob-kitob panelida uch xato
           * ko'rsatkich chiqargan — "Elchi bizga qarz" MANFIY, "Elchi
           * ushlagan" esa tarif o'rniga BUTUN COD.
           *
           * Endi uchta ANIQ maydon yuboriladi. Ularning manbasi taxmin emas:
           *   `sale_collectible_amount` — sotuvda kuryer yig'gan naqd
           *     (snapshot, `total_price − paid_online_amount`);
           *   `market_tariff` — sotuvda ishlatilgan tarif snapshoti.
           *
           * ⚠️ SOTILMAGAN BUYURTMADA `null`, 0 EMAS. 0 — "hech narsa
           * yig'ilmadi" degan MA'NOLI da'vo va hamkor uni qarz hisobiga
           * qo'shib yuborardi. `null` esa "hali hisoblanmagan" deydi.
           */
          collected_from_customer: collectedFromCustomer,
          elchi_fee: elchiFee,
          market_amount: marketAmount,
          // Hamkor o'z tomonida ham narx/xarajatni qo'llashi uchun.
          total_price: Number(order.total_price ?? 0),
          extra_cost: Number(order.extra_cost ?? 0),
        },
      ).catch(() => undefined);
    }

    // Eski ExternalIntegration sync yo'li (o'zgarmagan).
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
    // CANCELLED_SENT ("bekor qilinib pochtaga qo'shildi") tashqi tizim uchun ham
    // BEKOR QILISH: posilka mijozga bormaydi. Avval bu holat null qaytarardi va
    // hech qanday signal chiqmasdi — hamkor buyurtmani kutilmoqdada deb o'ylardi.
    if (
      newStatus === Order_status.CANCELLED ||
      newStatus === Order_status.CANCELLED_SENT
    ) {
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

    // G4 — posilka MARKETGA qaytarildi. Tashqi tizim uchun bu bekor qilish:
    // mijozga yetkazilmadi va posilka egasiga qaytdi. Avval bu holat null
    // qaytarardi va hamkor buyurtmani hamon yo'lda deb hisoblardi.
    if (newStatus === Order_status.RETURNED_TO_MARKET) {
      return 'canceled';
    }

    // G4 — kuryer yetkaza olmadi (mijoz javob bermadi/keyinga qoldirdi).
    // Bu TERMINAL EMAS: buyurtma hamon kutmoqda, shu bois 'waiting'. Avval
    // signal chiqmasdi va hamkor tomonda buyurtma "yo'lda" holatida QOTIB
    // qolardi — hech qachon yangilanmaydigan holat.
    if (newStatus === Order_status.WAITING_CUSTOMER) {
      return 'waiting';
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

  async receiveNewOrders(
    orderIds: string[],
    search?: string,
    requester?: { id?: string; roles?: string[] } | null,
    /**
     * ⚠️ FAQAT ICHKI CHAQIRUV UCHUN. `order.receive` message pattern'i bu
     * argumentni UZATMAYDI (`order-service.controller.ts`), ya'ni tashqaridan
     * berib bo'lmaydi. Uni faqat `receiveExternalByScan` beradi — u tokenni
     * allaqachon tekshirgan bo'ladi.
     */
    internal?: { scanVerified?: boolean },
  ) {
    const uniqueOrderIds = Array.from(
      new Set((orderIds ?? []).filter(Boolean)),
    );
    if (!uniqueOrderIds.length) {
      this.badRequest('order_ids is required');
    }

    // 0. Filial doirasi — menejer/registrator faqat o'z filialida ishlaydi.
    const scopeBranchId = await this.resolveReceiveBranchScope(requester);

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

    /**
     * ⚠️ TASHQI POSILKA FAQAT SKANERLAB QABUL QILINADI (audit K2).
     *
     * MUAMMO. Bu metod faqat `status = NEW` va filial doirasini tekshirardi —
     * `source` haqida shart YO'Q edi. Natijada hamkor/sayt posilkalari oddiy
     * "Marketlar" ro'yxatida market buyurtmalari bilan ARALASH turardi va
     * operator ularni bitta tugma bilan OMMAVIY qabul qilardi.
     *
     * Oqibati javobgarlik (custody) buzilishi: posilka hali hamkor omborida
     * bo'lishi mumkin, Elchi esa uni "qabul qildim" deb yozib qo'yadi.
     * Yo'qolsa kim aybdor — aniqlanmaydi.
     *
     * Skan darvozasi ILGARI FAQAT FRONTENDDA edi, ya'ni boshqa ekrandan
     * yoki to'g'ridan-to'g'ri API'dan chetlab o'tish mumkin edi. Endi
     * chegara SERVERDA.
     *
     * Butun so'rov rad etiladi, qolganini jimgina qabul qilmaymiz — aks
     * holda operator hammasini qabul qildim deb o'ylardi.
     */
    if (!internal?.scanVerified) {
      const externalOrders = orders.filter(
        (order) => order.source === Order_source.EXTERNAL,
      );
      if (externalOrders.length) {
        this.badRequest(
          `${externalOrders.length} ta posilka tashqi manbadan keldi — ` +
            'ular faqat skanerlab qabul qilinadi (Kiruvchi posilkalar ekrani)',
        );
      }
    }

    /**
     * ⚠️ fix3b (LC-03 alomati) — HQ QABULI FILIALDA TURGAN BUYURTMANI OLMAYDI.
     *
     * SA/ADMIN (doira yo'q) va HQ registratori qabuli — HQ qabuli: buyurtma
     * HQ hudud pochtasiga tushadi. Saqlanishi (custody) HQ'dan boshqa
     * filialda bo'lgan NEW buyurtma (filial xodimi yaratgan) shu yo'l bilan
     * qabul qilinsa, u HQ hudud pochtasiga yopishib qolardi — filial doirasi
     * esa uni HQ registratoriga 403 bilan ko'rsatmasdi (jonli: #65). Bunday
     * buyurtmani o'sha filial o'zi qabul qiladi. Butun so'rov rad etiladi.
     *
     * HQ id faqat filialda turgan buyurtma bo'lsagina so'raladi; HQ
     * aniqlanmasa ham `BRANCH` ushlovchi baribir HQ emas (`resolveHolderFromState`
     * uni faqat HQ'dan boshqa filial uchun qo'yadi).
     */
    const branchHeldOrders = orders.filter(
      (order) =>
        String(order.holder_type ?? '').toUpperCase() ===
          String(OrderHolderType.BRANCH) &&
        Boolean(String(order.holder_branch_id ?? '').trim()),
    );
    if (branchHeldOrders.length) {
      const hqBranchId = String(
        (await this.lookup.getHqBranchId()) ?? '',
      ).trim();
      const isHqIntake =
        !scopeBranchId || (Boolean(hqBranchId) && scopeBranchId === hqBranchId);
      const atNonHqBranch = isHqIntake
        ? branchHeldOrders.filter(
            (order) => String(order.holder_branch_id).trim() !== hqBranchId,
          )
        : [];
      if (atNonHqBranch.length) {
        this.badRequest(
          "Bu buyurtma filialda turibdi — uni o'sha filial qabul qiladi " +
            `(${atNonHqBranch.map((order) => `#${order.id}`).join(', ')})`,
        );
      }
    }

    /**
     * Begona filial buyurtmasi bo'lsa BUTUN so'rov rad etiladi — jimgina
     * filtrlab qolganini qabul qilmaymiz. Sabab: operator tanlaganini qabul
     * qildim deb o'ylaydi, aslida bir qismi tushib qolgan bo'lardi va
     * farqni hech kim sezmasdi.
     */
    if (scopeBranchId) {
      const foreign = orders.filter(
        (order) => String(order.branch_id ?? '') !== scopeBranchId,
      );
      if (foreign.length) {
        this.forbidden(
          `${foreign.length} ta buyurtma boshqa filialga tegishli — ` +
            'faqat o‘z filialingiz buyurtmalarini qabul qila olasiz',
        );
      }
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

  /**
   * TASHQI POSILKANI SKANERLAB QABUL QILISH.
   *
   * Operator posilkani qo'lida ushlab yorliqdagi QR'ni skanerlaydi. Server
   * tokenni BUYURTMAGA moslaydi — ya'ni "qabul qildim" degan yozuv faqat
   * jismonan qo'lda bo'lgan posilka uchun paydo bo'ladi.
   *
   * NEGA TOKEN, ID EMAS. Ilgari frontend skanerlagan tokenni o'zi
   * buyurtmaga moslab, serverga `order_ids` yuborardi. Ya'ni server
   * skanerlash bo'lgan-bo'lmaganini BILMASDI va darvozani chetlab o'tish
   * mumkin edi (audit K2). Token serverga kelganda dalil serverda bo'ladi.
   *
   * ⚠️ TOPILMAGAN TOKENLAR JIMGINA TASHLANMAYDI — javobda qaytadi.
   * Operator nechta posilka qabul qilinmaganini va nima uchun bilishi kerak,
   * aks holda qolib ketgan posilkani hech kim sezmaydi.
   */
  async receiveExternalByScan(input: {
    tokens: string[];
    requester?: { id?: string; roles?: string[] } | null;
  }) {
    const tokens = Array.from(
      new Set(
        (input.tokens ?? []).map((t) => String(t ?? '').trim()).filter(Boolean),
      ),
    );
    if (!tokens.length) {
      this.badRequest('tokens is required');
    }
    /**
     * Bir so'rovda qabul qilinadigan posilka soni chegaralangan: skaner
     * sessiyasi odatda o'nlab posilka, mingtalik so'rov esa tranzaksiyani
     * uzoq ushlab turardi.
     */
    if (tokens.length > 200) {
      this.badRequest('bir so‘rovda 200 tadan ko‘p token yuborib bo‘lmaydi');
    }

    /**
     * QOP YORLIG'I — BITTA SKAN, BUTUN QOP.
     *
     * ⚠️ NEGA KERAK. Hamkor 12 posilkani bitta qopda yuboradi va qop ustida
     * UMUMIY yorliq bo'ladi. Ilgari operator 12 posilkani BITTALAB
     * skanerlashi kerak edi — sekin, va bittasi o'tkazib yuborilsa
     * jimgina qabul qilinmay qolardi.
     *
     * Endi skanerlangan token QOP yorlig'i bo'lsa, u o'sha qopdagi BARCHA
     * posilka tokenlariga ochiladi va qolgan mantiq (javobgarlik, filial,
     * pochtaga ajratish) O'ZGARISHSIZ ishlaydi.
     *
     * ⚠️ FAQAT `NEW` va `EXTERNAL` olinadi. Qopning bir qismi avval
     * bittalab skanerlangan bo'lishi mumkin — ularni qayta olish
     * `receiveNewOrders` ni ikki marta chaqirib javobgarlik yozuvini
     * IKKILANTIRARDI.
     */
    const batchMembers = await this.orderRepo.find({
      where: {
        external_batch_token: In(tokens),
        isDeleted: false,
        status: Order_status.NEW,
        source: Order_source.EXTERNAL,
      },
      select: ['qr_code_token', 'external_batch_token'],
    });
    /** Qaysi skanerlangan token QOP bo'lib chiqdi — javobda aytiladi. */
    const batchTokens = new Set(
      batchMembers
        .map((o) => String(o.external_batch_token ?? ''))
        .filter(Boolean),
    );
    const expandedTokens = Array.from(
      new Set([
        ...tokens,
        ...batchMembers
          .map((o) => String(o.qr_code_token ?? ''))
          .filter(Boolean),
      ]),
    );

    const orders = await this.orderRepo.find({
      where: {
        qr_code_token: In(expandedTokens),
        isDeleted: false,
        status: Order_status.NEW,
        source: Order_source.EXTERNAL,
      },
    });

    /**
     * Topilmagan tokenlar SABABI bilan ajratiladi. Bitta umumiy "topilmadi"
     * xabari operatorni ko'r qoldirardi: token boshqa manbadan bo'lishi,
     * allaqachon qabul qilingan bo'lishi yoki umuman tizimda bo'lmasligi
     * mumkin — bular uch xil harakat talab qiladi.
     */
    const matched = new Map(orders.map((o) => [String(o.qr_code_token), o]));
    const unmatched: Array<{ token: string; reason: string }> = [];
    for (const token of tokens) {
      if (matched.has(token)) continue;
      /**
       * ⚠️ QOP TOKENI "topilmadi" EMAS. U posilka tokeni bo'lmagani uchun
       * `matched` da yo'q, lekin o'z qopidagi posilkalarni ochib berdi —
       * ya'ni skan MUVAFFAQIYATLI. Bu tekshiruvsiz operator har qop
       * skanidan keyin "topilmadi" xatosini ko'rardi.
       */
      if (batchTokens.has(token)) continue;
      const anyOrder = await this.orderRepo.findOne({
        where: { qr_code_token: token, isDeleted: false },
      });
      if (!anyOrder) {
        unmatched.push({ token, reason: 'tizimda topilmadi' });
      } else if (anyOrder.source !== Order_source.EXTERNAL) {
        unmatched.push({ token, reason: 'tashqi posilka emas' });
      } else if (anyOrder.status !== Order_status.NEW) {
        unmatched.push({
          token,
          reason: `allaqachon '${anyOrder.status}' holatida`,
        });
      } else {
        unmatched.push({ token, reason: 'qabul qilib bo‘lmadi' });
      }
    }

    if (!orders.length) {
      return successRes(
        { received: 0, unmatched },
        200,
        'No scannable parcels matched',
      );
    }

    /**
     * Qabul qilishning O'ZI mavjud yo'ldan o'tadi — filial doirasi, mijoz
     * tekshiruvi, tuman→viloyat xaritasi va POCHTAGA AJRATISH allaqachon
     * o'sha yerda. Nusxa ko'chirsak ikki yo'l asta bir-biridan farq qila
     * boshlardi.
     *
     * `scanVerified` — skanerlash DALILI serverda tekshirilgani belgisi.
     */
    const result = await this.receiveNewOrders(
      orders.map((o) => o.id),
      undefined,
      input.requester,
      { scanVerified: true },
    );

    return successRes(
      {
        received: orders.length,
        unmatched,
        /**
         * Qaysi skan QOP bo'lib chiqdi — operator "bitta skanerlaganimda
         * 12 ta qabul qilindi" degan natijani TUSHUNISHI kerak.
         */
        batch_tokens: Array.from(batchTokens),
        detail: (result as { data?: unknown })?.data ?? null,
      },
      200,
      'Scanned parcels received',
    );
  }

  /**
   * TASHQI BUYURTMANI QABUL QILISH.
   *
   * `options.strict` — CHAQIRUVCHI TAXMIN QILISHNI TAQIQLAYDI.
   *
   * ⚠️ NEGA KERAK BO'LDI (adversarial tekshiruv). Tortib olish yo'lida
   * importni operator qo'lda ishga tushiradi va natijani ko'radi. CRM
   * webhooki esa to'xtovsiz keladi va hech kim qaramaydi — shu bois
   * "aniqlanmasa taxmin qil" xatti-harakati o'sha yerda xavfli:
   *
   *   • tuman mos kelmasa zaxira = JADVALDAGI BIRINCHI tuman, ya'ni posilka
   *     jimgina boshqa viloyatga ketardi (tuman tarifni ham belgilaydi);
   *   • narx kaliti mos kelmasa 0, ya'ni COD 0 bo'lib pul yo'qolardi.
   *
   * `strict: true` bo'lsa bunday qator YARATILMAYDI — `skipped` ga aniq
   * sabab bilan tushadi va webhook jurnalida ko'rinadi.
   */
  /**
   * MIJOZDAN YIG'ILADIGAN NAQD.
   *
   * Kassa matematikasining BIRINCHI raqami. Shu paytgacha uning o'rnida
   * `total_price` turardi, ya'ni "mijoz qancha to'lasa kuryer shuncha naqd
   * yig'di" deb hisoblanardi. Ikki holatda bu yolg'on:
   *
   *   • mijoz onlayn to'lagan (`paid_online_amount > 0`) — pul MARKETGA
   *     tushadi, pochta unga aralashmaydi (foydalanuvchi qarori 2026-09-14);
   *   • hamkor `cod_amount: 0` bilan prepaid posilka yuborgan — bu
   *     `createPartnerShipment` da hujjatlashtirilgan holat.
   *
   * Ikkalasida ham kuryer NAQD YIG'MAYDI, lekin majburiyatlar qoladi:
   * marketdan yetkazish haqi olinishi, kuryerga ulushi to'lanishi kerak.
   * `total_price − paid_online_amount` aynan shuni beradi va qolgan
   * formulalar (`marketExpense`, `courierExpense`) o'zgarishsiz to'g'ri
   * ishlaydi — ular allaqachon 0 so'mlik buyurtma uchun yozilgan.
   */
  private resolveCollectibleAmount(order: Order): number {
    const total = Number(order.total_price ?? 0);
    const online = Number(order.paid_online_amount ?? 0);
    return Math.max(total - online, 0);
  }

  /**
   * ONLAYN TO'LOVNI BUYURTMAGA QAYD ETISH (7-bosqich).
   *
   * ⚠️ PULNI KASSAGA KO'CHIRMAYDI. Foydalanuvchi qarori (2026-09-13):
   * onlayn pul hozircha kassaga yozilmaydi, faqat daftarga. Bu metod
   * buyurtmadagi IKKI maydonni yangilaydi va shu bilan tugaydi —
   * `markByProvider` dagi ayni naqsh ("status-only, moliya emitsiz").
   *
   * ⚠️ NEGA BITTA METOD. Buyurtmani topish, summani tekshirish va yozish —
   * uchalasi ayni yerda, order-service ichida. Ular integration-service'ga
   * bo'linsa, "topdim → boshqa jarayon o'zgartirdi → yozdim" poygasi
   * paydo bo'lardi. Dublikatning qat'iy to'sig'i esa chaqiruvchida
   * (`payment_transactions` UNIQUE).
   */
  async recordOnlinePayment(input: {
    integration_slug?: string;
    provider_transaction_id?: string;
    /**
     * Ulanish bog'langan market (bo'lsa). Berilgan bo'lsa buyurtma AYNI
     * marketga tegishli bo'lishi shart — aks holda bir marketning to'lov
     * tizimi boshqa marketning buyurtmasini "to'langan" deb belgilay olardi.
     */
    integration_market_id?: string | null;
    order_ref?: string;
    /** Havola qaysi maydonga tegishli. Sukut: buyurtma raqami. */
    /**
     * Havola qaysi maydonga tegishli.
     *
     * ⚠️ ELCHI'DA `order_number` USTUNI YO'Q — buyurtma raqami `id`ning
     * O'ZI (`order-service.service.ts` — `order_number: String(order.id)`).
     * PCS/BeePost'da alohida `order_number` ketma-ketligi bor, bu yerda
     * esa yo'q; ikkisini aralashtirmaslik kerak.
     */
    order_ref_field?: 'id' | 'external_id' | 'qr_code_token';
    amount?: unknown;
    currency?: string;
    /** BIZNING holat: provayderning xom holati chaqiruvchida xaritalanadi. */
    status?: string;
  }) {
    const ref = String(input?.order_ref ?? '').trim();
    if (!ref) {
      return successRes(
        { outcome: 'order_ref_missing' },
        200,
        'to‘lov havolasi yo‘q',
      );
    }

    /**
     * FAQAT `succeeded` va `refunded` buyurtmaga tegadi.
     *
     * `pending` — pul hali kelmagan (to'lov tizimi tranzaksiyani band
     * qilgan). Uni "to'langan" deb belgilash eng xavfli xato bo'lardi:
     * kuryer naqd yig'masdi, pul esa kelmasdi.
     * `failed` — yozuv sifatida saqlanadi, lekin qo'llanmaydi.
     */
    const status = String(input?.status ?? '').toLowerCase();
    if (status !== 'succeeded' && status !== 'refunded') {
      return successRes(
        { outcome: 'ignored_status', status },
        200,
        'to‘lov holati qo‘llanmadi',
      );
    }

    const amount = this.safeExternalAmount(input?.amount);
    if (amount === null || amount <= 0) {
      this.logger.warn(
        `online payment REFUSED: summa yaroqsiz (${String(input?.amount)})`,
      );
      return successRes(
        { outcome: 'amount_invalid' },
        200,
        'to‘lov summasi yaroqsiz',
      );
    }

    const field = input?.order_ref_field ?? 'id';
    /**
     * ⚠️ Maydon nomi FOYDALANUVCHI SOZLAMASIDAN keladi — uni
     * to'g'ridan-to'g'ri `where` ga qo'yish mumkin emas. Faqat oq ro'yxat.
     */
    const where: Record<string, unknown> = { isDeleted: false };
    if (field === 'external_id') {
      where.external_id = ref;
    } else if (field === 'qr_code_token') {
      where.qr_code_token = ref;
    } else {
      /**
       * `id` — bigint. Son bo'lmagan havolani `where` ga qo'ysak Postgres
       * `22P02` tip xatosi beradi va webhook 500 bilan yiqilardi; provayder
       * esa qayta-qayta yuborishni boshlardi.
       */
      if (!/^\d+$/.test(ref)) {
        return successRes(
          { outcome: 'order_not_found', reason: 'id son emas' },
          200,
          'buyurtma topilmadi',
        );
      }
      where.id = ref;
    }

    /**
     * ⚠️ IKKITA QATOR TOPILSA RAD ETILADI (adversarial topilma).
     *
     * `external_id` va `qr_code_token` ustunlari UNIQUE EMAS
     * (`order.entity.ts` — indeks ataylab unique qilinmagan, chunki eski
     * ma'lumotda dublikat bor). `findOne` esa tartibsiz BITTASINI oladi —
     * ya'ni to'lov BOSHQA mijozning buyurtmasiga yozilishi mumkin edi va
     * u posilka "to'langan" bo'lib ketardi.
     *
     * Ikkitani so'raymiz: bittadan ko'p bo'lsa qaysi biri ekani NOMA'LUM
     * va taxmin qilish pul bilan qilinadigan eng yomon ish.
     */
    const matches = await this.orderRepo.find({ where, take: 2 });
    if (matches.length > 1) {
      this.logger.warn(
        `online payment REFUSED: ${field}=${ref} bo‘yicha ${matches.length} ` +
          'buyurtma topildi — qaysi biri ekani noma‘lum',
      );
      return successRes(
        { outcome: 'order_ref_ambiguous', matches: matches.length },
        200,
        'havola bir nechta buyurtmaga mos keldi',
      );
    }
    const order = matches[0];
    if (!order) {
      this.logger.warn(
        `online payment: buyurtma topilmadi (${field}=${ref}) — ` +
          'pul keldi, lekin bog‘lanmadi',
      );
      return successRes(
        { outcome: 'order_not_found' },
        200,
        'buyurtma topilmadi',
      );
    }

    /**
     * ⚠️ YOPILGAN BUYURTMAGA QO'LLANMAYDI.
     *
     * Buyurtma allaqachon sotilgan bo'lsa, kuryer naqd pulni YIG'IB
     * BO'LGAN. Ustiga onlayn to'lovni qo'shsak, mijoz IKKI MARTA to'lagan
     * bo'lib chiqadi va tizim buni "hammasi joyida" deb ko'rsatardi.
     * Bu holat qaytarish (refund) talab qiladi — bu ODAM qarori, avtomatik
     * hal qilinmaydi. Shu bois natija KO'RINADIGAN qilinadi.
     */
    /**
     * ⚠️ TENANT DARVOZASI (adversarial topilma).
     *
     * Ulanish ma'lum bir marketga bog'langan bo'lsa (`market_id`), to'lov
     * FAQAT o'sha marketning buyurtmasiga yozilishi mumkin. Busiz bir
     * marketning to'lov tizimi (yoki uning kaliti qo'lga tushgan odam)
     * tizimdagi ISTALGAN buyurtmani "to'langan" deb belgilab, kuryerni
     * naqd yig'ishdan to'sib qo'yardi.
     *
     * Ulanishda market bog'lanmagan bo'lsa (kompaniya umumiy merchant
     * akkaunti) tekshiruv o'tkazib yuboriladi — bu qonuniy holat.
     */
    const tenantMarket = String(input?.integration_market_id ?? '').trim();
    if (tenantMarket && String(order.market_id) !== tenantMarket) {
      this.logger.warn(
        `online payment REFUSED for order ${order.id}: ulanish marketi ` +
          `${tenantMarket}, buyurtma marketi ${order.market_id}`,
      );
      await this.activityLog.log({
        entity_type: 'Order',
        entity_id: String(order.id),
        action: ActivityAction.PAYMENT,
        new_value: {
          outcome: 'market_mismatch',
          integration_market_id: tenantMarket,
          order_market_id: String(order.market_id),
          provider: input?.integration_slug ?? null,
        },
      });
      return successRes(
        {
          outcome: 'market_mismatch',
          order_id: String(order.id),
        },
        200,
        'to‘lov boshqa marketning buyurtmasiga tegishli',
      );
    }

    /**
     * ⚠️ QAYTARISH YOPILGAN BUYURTMADA HAM QAYD ETILADI (adversarial topilma).
     *
     * Ilgari "yopilgan" darvozasi qaytarishdan OLDIN turardi, ya'ni bekor
     * qilingan yoki qaytarilgan buyurtmaning qaytarilgan puli
     * STRUKTURAVIY ravishda yozib bo'lmasdi — aynan eng kerakli holat.
     *
     * Qaytarish majburiyat YARATMAYDI, u `paid_online_amount` ni
     * KAMAYTIRADI; shu bois yopilgan buyurtmada ham xavfsiz.
     */
    const isRefund = status === 'refunded';

    const CLOSED_STATES: string[] = [
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
      Order_status.RETURNED_TO_MARKET,
      Order_status.CLOSED,
    ];
    if (!isRefund && CLOSED_STATES.includes(order.status)) {
      this.logger.warn(
        `online payment REFUSED for order ${order.id}: ` +
          `status=${order.status} — kuryer naqd yig‘gan bo‘lishi mumkin, ` +
          'qo‘lda ko‘rib chiqish kerak',
      );
      await this.activityLog.log({
        entity_type: 'Order',
        entity_id: String(order.id),
        action: ActivityAction.PAYMENT,
        new_value: {
          outcome: 'order_already_closed',
          order_status: order.status,
          amount,
          provider: input?.integration_slug ?? null,
          provider_transaction_id: input?.provider_transaction_id ?? null,
        },
      });
      return successRes(
        {
          outcome: 'order_already_closed',
          order_id: String(order.id),
          order_number: order.id,
          order_status: order.status,
        },
        200,
        'buyurtma yopilgan — to‘lov qo‘llanmadi',
      );
    }

    const before = Number(order.paid_online_amount ?? 0);
    const total = Number(order.total_price ?? 0);

    if (isRefund) {
      /**
       * Qaytarish — `paid_online_amount` kamayadi, 0 dan pastga tushmaydi.
       * Manfiy qoldiq "biz mijozga qarzdormiz" degan MA'NOSI boshqa narsa
       * va u bu maydonda ifodalanmasligi kerak.
       */
      const after = Math.max(before - amount, 0);
      await this.applyOnlinePaymentToOrder(order, after, total, {
        status,
        amount,
        input,
        before,
      });
      return successRes(
        {
          outcome: 'recorded',
          order_id: String(order.id),
          order_number: order.id,
          paid_online_amount: after,
          payment_status: this.derivePaymentState(after, total),
        },
        200,
        'qaytarish qayd etildi',
      );
    }

    const after = before + amount;
    /**
     * ⚠️ ORTIQCHA TO'LOV QO'LLANMAYDI.
     *
     * Summa buyurtma narxidan oshsa, eng ehtimolli sabab — to'lov
     * NOTO'G'RI buyurtmaga moslashtirilgan (havola takrorlangan yoki
     * provayder boshqa raqam yubordi). Uni qabul qilsak, mijoz to'lamagan
     * buyurtma "to'langan" bo'lib qolardi va kuryer puldan qaytardi.
     *
     * 1 so'm bag'rikenglik — tiyin yumaloqlanishi uchun.
     */
    if (after > total + 1) {
      this.logger.warn(
        `online payment REFUSED for order ${order.id}: ` +
          `${after} > total ${total} — noto‘g‘ri moslashtirish ehtimoli`,
      );
      await this.activityLog.log({
        entity_type: 'Order',
        entity_id: String(order.id),
        action: ActivityAction.PAYMENT,
        new_value: {
          outcome: 'amount_exceeds_total',
          amount,
          already_paid_online: before,
          total_price: total,
          provider: input?.integration_slug ?? null,
          provider_transaction_id: input?.provider_transaction_id ?? null,
        },
      });
      return successRes(
        {
          outcome: 'amount_exceeds_total',
          order_id: String(order.id),
          order_number: order.id,
          total_price: total,
          already_paid_online: before,
        },
        200,
        'to‘lov summasi buyurtma narxidan oshdi',
      );
    }

    const applied = await this.applyOnlinePaymentToOrder(order, after, total, {
      status,
      amount,
      input,
      before,
    });
    /**
     * Poygada chegara buzilgan — boshqa to'lov bir vaqtda o'tib ketgan.
     * Natija ortiqcha to'lov bilan AYNI: summa sig'maydi.
     */
    if (!applied) {
      return successRes(
        {
          outcome: 'amount_exceeds_total',
          order_id: String(order.id),
          order_number: order.id,
          total_price: total,
          already_paid_online: before,
          race: true,
        },
        200,
        'to‘lov summasi buyurtma narxidan oshdi (poyga)',
      );
    }

    return successRes(
      {
        outcome: 'recorded',
        order_id: String(order.id),
        order_number: order.id,
        paid_online_amount: after,
        payment_status: this.derivePaymentState(after, total),
      },
      200,
      'to‘lov qayd etildi',
    );
  }

  /**
   * Onlayn to'lov holatini summadan kelib chiqib aniqlash.
   *
   * ⚠️ `Order_status.PAID`/`PARTLY_PAID` BILAN ARALASHTIRMANG — ular market
   * bilan hisob-kitob haqida, bu esa MIJOZNING to'lovi haqida.
   */
  private derivePaymentState(paidOnline: number, total: number): string | null {
    if (paidOnline <= 0) return null;
    // 1 so'm bag'rikenglik — tiyin yumaloqlanishi uchun.
    return paidOnline + 1 >= total ? 'paid' : 'partly';
  }

  /**
   * To'lovni buyurtmaga ATOMIK yozish.
   *
   * ⚠️ NEGA `update({ paid_online_amount: after })` YETMAYDI (adversarial
   * topilma). U "o'qi → hisobla → yoz" ketma-ketligi: bir buyurtmaga ikki
   * to'lov bir vaqtda kelsa (qismiy to'lovlar, turli tranzaksiyalar)
   * ikkisi ham ayni `before` ni o'qib, biri ikkinchisini USTIGA yozardi —
   * ya'ni bitta to'lov JIMGINA yo'qolardi.
   *
   * Endi qiymat SQL ichida oshiriladi (`paid_online_amount + :amt`) va
   * chegara `WHERE` ichida tekshiriladi — ya'ni tekshiruv va yozish bitta
   * atomik amalda. `affected === 0` bo'lsa chegara buzilgan (poyga ichida
   * boshqa to'lov o'tib ketgan).
   *
   * `payment_status` ham SQL ichida hisoblanadi: uni JS'da hisoblab
   * yuborsak, yana eskirgan qiymatga tayangan bo'lardik.
   */
  private async applyOnlinePaymentToOrder(
    order: Order,
    after: number,
    total: number,
    ctx: {
      status: string;
      amount: number;
      before: number;
      input: { integration_slug?: string; provider_transaction_id?: string };
    },
  ): Promise<boolean> {
    const isRefund = ctx.status === 'refunded';
    const nextState = this.derivePaymentState(after, total);

    /**
     * Yangi qiymat ifodasi. Qaytarishda 0 dan pastga tushmaydi
     * (`GREATEST`), to'lovda esa oddiy qo'shish.
     */
    const nextAmountSql = isRefund
      ? 'GREATEST("paid_online_amount" - :amt, 0)'
      : '"paid_online_amount" + :amt';

    /**
     * Holat AYNI ifodadan hisoblanadi. 1 so'm bag'rikenglik tiyin
     * yumaloqlanishi uchun — `derivePaymentState` bilan bir xil qoida.
     */
    const nextStateSql =
      `CASE WHEN ${nextAmountSql} <= 0 THEN NULL ` +
      `WHEN ${nextAmountSql} + 1 >= "total_price" THEN 'paid' ` +
      `ELSE 'partly' END`;

    const qb = this.orderRepo
      .createQueryBuilder()
      .update(Order)
      .set({
        paid_online_amount: () => nextAmountSql,
        payment_status: () => nextStateSql,
      })
      .where('id = :id', { id: order.id })
      .setParameter('amt', ctx.amount);

    /**
     * ⚠️ CHEGARA FAQAT TO'LOVDA. Qaytarish summani kamaytiradi — u yerda
     * "narxdan oshmasin" sharti ma'nosiz va qaytarishni bloklardi.
     */
    if (!isRefund) {
      qb.andWhere('"paid_online_amount" + :amt <= "total_price" + 1');
    }

    const result = await qb.execute();
    if (!result.affected) {
      this.logger.warn(
        `online payment LOST RACE for order ${order.id}: chegara buzilgan ` +
          '(bir vaqtda boshqa to‘lov o‘tib ketgan)',
      );
      return false;
    }

    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: String(order.id),
      action: ActivityAction.PAYMENT,
      old_value: {
        paid_online_amount: ctx.before,
        payment_status: order.payment_status ?? null,
      },
      new_value: {
        paid_online_amount: after,
        payment_status: nextState,
        event: ctx.status,
        amount: ctx.amount,
        provider: ctx.input.integration_slug ?? null,
        provider_transaction_id: ctx.input.provider_transaction_id ?? null,
      },
      metadata: { order_number: order.id },
    });
    return true;
  }

  async receiveExternalOrders(dto: {
    integration_id: string;
    orders: any[];
    options?: { strict?: boolean };
  }) {
    const strict = Boolean(dto?.options?.strict);
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

      /**
       * Tashqi yozuvdan mahsulot qatorlarini o'qish.
       *
       * `items_field` — massiv qaysi maydonda; `item_name_field` /
       * `item_qty_field` — massiv ichidagi element maydonlari. Uchalasi ham
       * sozlanadi, chunki har sayt boshqacha nomlaydi.
       *
       * Massiv bo'lmasa yoki nom bo'sh bo'lsa qator TASHLANADI — yarim
       * to'ldirilgan qator buyurtmani buzardi.
       */
      const rawItems = this.getFieldValue(
        ext,
        fieldMapping.items_field ?? 'items',
      );
      const mappedItems = (Array.isArray(rawItems) ? rawItems : [])
        .map((row: unknown) => {
          const name = String(
            this.getFieldValue(row, fieldMapping.item_name_field ?? 'name') ??
              '',
          ).trim();
          const qtyRaw = Number(
            this.getFieldValue(
              row,
              fieldMapping.item_qty_field ?? 'quantity',
            ) ?? 1,
          );
          return {
            product_id: null,
            product_name: name,
            quantity: Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1,
          };
        })
        .filter((item) => item.product_name.length > 0);

      const districtExternal = this.getFieldValue(
        ext,
        fieldMapping.district_code_field ?? 'district',
      );
      /**
       * ⚠️ Qat'iy rejimda ANIQLANGAN tuman talab qilinadi. Moslik faqat
       * SOATO kodi yoki ichki ID bo'yicha izlanadi — NOM bo'yicha emas,
       * ya'ni "Chilonzor" deb yuborgan tizim hech qachon mos kelmaydi va
       * zaxira tuman ishlatilardi.
       */
      const resolvedDistrict =
        await this.lookup.resolveDistrictIdOrNull(districtExternal);
      if (strict && !resolvedDistrict) {
        skipped.push({
          external_id: externalId,
          reason: 'district_unresolved',
        });
        continue;
      }
      const districtId = resolvedDistrict ?? fallbackDistrictId;
      const regionExternal = this.getFieldValue(
        ext,
        fieldMapping.region_code_field ?? 'region',
      );
      /**
       * ⚠️ fix3b (LC-13) — `region_id` BO'SH QOLMAYDI. Sayt viloyatni
       * yubormasa (yoki matn yuborsa) u ilgari NULL yozilardi; filial
       * dispatch esa buyurtmaning `region_id` siga tayanadi va NULL da
       * Postgres 22P02 bilan yarim yo'lda yiqilardi. Endi tumandan olinadi
       * (`assigned_region`, bo'lmasa tumanning o'z viloyati). Baribir
       * aniqlanmasa — qator yaratilMAYDI va `skipped` da aniq sabab bilan
       * qaytadi (partiya yarim yo'lda uzilmasin: 400 butun importni
       * to'xtatardi). Mijoz yaratilishidan OLDIN — yetim mijoz qolmasin.
       */
      const regionId =
        this.numericRegionId(regionExternal) ??
        (await this.lookup.resolveRegionIdForDistrict(districtId));
      if (!regionId) {
        skipped.push({
          external_id: externalId,
          reason: 'region_unresolved',
        });
        continue;
      }

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

      /**
       * ⚠️ NARX — `Number()` NI XOM ISHLATISH MUMKIN EMAS (adversarial
       * tekshiruv, kritik).
       *
       * `Number('250 000')` → `NaN`, `Math.max(NaN, 0)` → `NaN`. Postgres
       * `numeric` ustuni `NaN` ni QABUL QILADI, ya'ni xato chiqmaydi:
       * buyurtma yaratiladi va undan keyin market hisobi, kassa yig'indisi,
       * dashboard — hammasi `NaN` bo'lib qoladi. Bu eng yomon turdagi
       * xato: jimgina va butun moliyani zaharlaydi.
       *
       * Endi son bo'lmagan qiymat qatorni TASHLAYDI (har qanday
       * chaqiruvchida — `NaN` narx hech kim uchun to'g'ri emas).
       */
      const priceRaw = this.getFieldValue(
        ext,
        fieldMapping.total_price_field ?? 'total_price',
      );
      const deliveryRaw = this.getFieldValue(
        ext,
        fieldMapping.delivery_price_field ?? 'delivery_price',
      );
      const totalPrice = this.safeExternalAmount(priceRaw);
      const deliveryPrice = this.safeExternalAmount(deliveryRaw);
      if (totalPrice === null || deliveryPrice === null) {
        skipped.push({ external_id: externalId, reason: 'price_invalid' });
        continue;
      }
      /**
       * Qat'iy rejimda NARX BERILGAN bo'lishi shart. Kalit mos kelmasa
       * `undefined` → 0 bo'lib ketardi, ya'ni COD 0: kuryer puldan
       * qaytardi va hech kim sababini bilmasdi.
       */
      if (strict && (priceRaw == null || priceRaw === '')) {
        skipped.push({ external_id: externalId, reason: 'price_missing' });
        continue;
      }
      const finalPrice = Math.max(totalPrice, 0) + Math.max(deliveryPrice, 0);

      /**
       * SKAN TOKENI — TO'QNASHUV TEKSHIRUVI (adversarial tekshiruv).
       *
       * `qr_code_field` ATAYLAB qoladi: tashqi sayt o'z shtrix-kodini
       * posilkaga bosib chiqaradi va pochta AYNI o'sha kodni skaner qiladi
       * (foydalanuvchi so'ragan oqim). Lekin token skanerlab qabul qilish
       * darvozasining KALITI — dublikat bo'lsa skanerlash BOSHQA
       * buyurtmaga tushib ketardi.
       */
      const qrRaw = this.getFieldValue(
        ext,
        fieldMapping.qr_code_field ?? 'qr_code',
      );
      const providedQr = qrRaw == null ? '' : String(qrRaw).trim();
      if (providedQr) {
        const clash = await this.orderRepo.findOne({
          where: { qr_code_token: providedQr, isDeleted: false },
          select: { id: true },
        });
        if (clash) {
          skipped.push({ external_id: externalId, reason: 'qr_code_conflict' });
          continue;
        }
      }
      const qrCode = providedQr || this.generateCustomToken();

      const createdOrder = await this.create({
        market_id: marketId,
        customer_id: customerId,
        where_deliver: Where_deliver.CENTER,
        total_price: finalPrice,
        to_be_paid: 0,
        paid_amount: 0,
        /**
         * ⚠️ ILGARI `RECEIVED` EDI va bu buyurtmani ORALIQDA qoldirardi
         * (audit EI-05): "Kiruvchi posilkalar" ekrani `NEW` so'raydi, ya'ni
         * import qilingan buyurtma skanerlash ro'yxatida KO'RINMASDI; pochta
         * ham tayinlanmasdi (bu metod post yozmaydi). Natijada buyurtma
         * bazada bor, operator uchun esa mavjud emas.
         *
         * Endi `NEW`: posilka jismonan kelganda skanerlanadi va aynan
         * o'shanda pochtaga ajratiladi (`receiveNewOrders` → post assign).
         */
        status: Order_status.NEW,
        comment:
          this.getFieldValue(ext, fieldMapping.comment_field ?? 'comment') ??
          null,
        operator,
        district_id: districtId,
        /**
         * ⚠️ ILGARI TASHQI QIYMAT XOM YOZILARDI va bu 500 berardi (audit
         * EI-06): `region_id` — bigint FK, sayt esa u yerga "Toshkent" yoki
         * "TSH" kabi matn yuborishi mumkin. Postgres tip xatosi
         * (`22P02`) chiqarardi va import BITTALAB ketgani uchun partiya
         * YARIM YO'LDA uzilardi — bir qismi yaratilib, qolgani yo'q.
         *
         * Endi faqat SON qabul qilinadi. Matn yoki bo'sh bo'lsa (fix3b,
         * LC-13) tumandan aniqlangan viloyat yoziladi — yuqoridagi izoh:
         * HQ qabuli `assigned_region` bo'yicha ishlasa ham, filial dispatch
         * buyurtmaning `region_id` siga tayanadi.
         */
        region_id: regionId,
        address:
          this.getFieldValue(ext, fieldMapping.address_field ?? 'address') ??
          null,
        qr_code_token: qrCode == null ? null : String(qrCode),
        external_id: externalId,
        source: Order_source.EXTERNAL,
        /**
         * MAHSULOT QATORLARI (audit EI-12).
         *
         * Ilgari import qilingan buyurtmada item UMUMAN yo'q edi: operator
         * narxi bor, lekin ichida NIMA borligi ko'rinmaydigan posilkani
         * ko'rardi. Qisman sotishda esa qatorsiz buyurtma bilan ishlab
         * bo'lmaydi.
         *
         * ⚠️ KATALOGGA BOG'LANMAYDI (`product_id: null`). Kichik saytlar
         * uchun ataylab shunday: ularning mahsulot id'lari bizning
         * katalogimizga mos kelmaydi va har nomni katalogda yaratish
         * katalogni axlatga to'ldirardi. Nom va soni yetarli.
         */
        items: mappedItems,
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
      extraCostApproved?: boolean;
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

    /**
     * ONLAYN TO'LANGAN BUYURTMA — NAQD YIG'ILMAYDI, LEKIN SOTUV O'TADI.
     *
     * Ilgari bu yerda darvoza turardi va bunday buyurtmani sotib
     * BO'LMASDI: kuryer yetkazib berardi, "Sotildi" bosganda xato olardi,
     * buyurtma `WAITING` da qotardi. Darvoza ataylab qo'yilgan edi — pul
     * modeli kelishilmaguncha noto'g'ri hisoblashdan ko'ra to'xtash
     * xavfsizroq edi.
     *
     * Model kelishildi (foydalanuvchi qarori 2026-09-14): ONLAYN PULNI
     * MARKET OLADI, pochta unga aralashmaydi. Demak bizning kitobimizda
     * bunday buyurtma 0 so'mlik buyurtma bilan AYNI:
     *
     *   market bizga yetkazish haqini qarzdor  (`marketExpense`)
     *   kuryerga ulushini HQ to'laydi          (`courierExpense`)
     *   kompaniya tarif − ulush foyda ko'radi
     *
     * Shuning uchun darvoza OLIB TASHLANDI va uning o'rniga naqd oyoqlari
     * `collectible` ga o'tkazildi (pastda).
     */

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
    this.assertManagerSaleNotCourierHeld(isManagerRequester, order);

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
    /**
     * ⚠️ MENEJER SOTUVIDA FILIAL KASSASI SHART (audit M15).
     *
     * Menejer sotuvida naqd filial kassasiga kirim bo'lib yoziladi
     * (`resolveManagerSaleBranchCash`), qo'shimcha xarajat ham shu kassadan
     * yechiladi. Kassa topilmasa (finance RPC vaqt tugashi — `getCashboxByUser`
     * xatoni yutadi) ilgari sotuv BARIBIR o'tardi: filial kassasiga hech narsa
     * yozilmas, daftar esa filialdan to'liq `branch_amount` ni talab qilardi —
     * qo'lda "to'ldirish" bilangina tuzaladigan soxta qarz. Kuryer va market
     * kassasi bilan bir xil: kassa yo'q — sotuv yo'q.
     */
    if (isManagerRequester && settlementBranchId && !branchCashbox) {
      this.notFound(
        "Filial kassasi topilmadi — sotuv to'xtatildi, qaytadan urinib ko'ring",
      );
    }
    // branchShare = what a PARTNER branch keeps per order (0 for OWNED / HQ).
    const branchShare = settlementBranchId
      ? await this.lookup.resolveBranchShare(settlementBranchId)
      : 0;

    const marketBalanceBefore = Number(marketCashbox.balance ?? 0);

    // Tariflar `resolveOrderTariff` orqali — buyurtmadagi override birinchi
    // o'rinda. Ilgari AYNAN bu yo'l override'ni inkor qilib faqat live profildan
    // olardi (partlySell va rollback esa snapshotni ustun qo'yardi), ya'ni kassa
    // oyog'i bir tarif bilan, `sell_profit` va rollback boshqa tarif bilan
    // hisoblanardi.
    const marketTariff = resolveOrderTariff({
      snapshot: order.market_tariff,
      isCenter: order.where_deliver === Where_deliver.CENTER,
      centerTariff: market.tariff_center,
      homeTariff: market.tariff_home,
    });
    const courierTariff = resolveOrderTariff({
      snapshot: order.courier_tariff,
      isCenter: order.where_deliver === Where_deliver.CENTER,
      centerTariff: financialActor?.tariff_center,
      homeTariff: financialActor?.tariff_home,
    });
    // courierShare = what the courier keeps (0 for salary-only couriers).
    const courierShare = this.resolveSaleActorShare(
      isManagerRequester,
      financialActor,
      courierTariff,
    );
    // Tarif qoplamasa sotuv shu yerda to'xtaydi — tranzaksiyadan OLDIN, ya'ni
    // hech bir kassa oyog'i yozilmaydi.
    this.assertTariffCoversShares({ marketTariff, courierShare, branchShare });
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
    if (extraCost > 0) {
      await this.assertCanAddExtraCost({
        actor: financialActor,
        requester,
        order,
      });
      // Ruxsatdan KEYIN summa chegarasi: "kim yozadi" va "qancha yozadi" —
      // ikki xil savol, ikkinchisi ilgari umuman tekshirilmasdi.
      this.assertExtraCostWithinLimit({
        extraCost,
        mode: 'sell',
        whereDeliver: order.where_deliver,
        tariffCenter: Number(financialActor?.tariff_center ?? 0),
        tariffHome: Number(financialActor?.tariff_home ?? 0),
        isManager:
          this.hasRole(requester, Roles.MANAGER) &&
          !this.hasRole(requester, Roles.COURIER),
      });
    }
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
    const pendingApproval = await this.requestExtraCostApprovalIfNeeded({
      order,
      requester,
      action: 'sell',
      extraCost,
      proofFiles,
      dto: dto ?? {},
    });
    if (pendingApproval) {
      return pendingApproval;
    }
    const finalComment = this.generateSaleComment(
      order.comment,
      dto?.comment,
      extraCost,
    );

    // Qo'shimcha xarajat AYNAN qaysi kassadan yechiladi — daftar oyoqlari ham
    // shuncha kamayadi (pastda `recordSaleSettlement` ga uzatiladi).
    const extraCostLegs = this.resolveExtraCostSettlementLegs({
      extraCost,
      chargedCashboxType: actorExpenseCashbox ? actorExpenseCashboxType : null,
    });

    // Decoupled COD legs — each independent of the others' thresholds:
    //   market : HQ owes market (total − marketTariff); reversed if total < marketTariff
    //   courier: courier owes branch (total − courierShare); HQ tops up if total < courierShare
    //   branch payable: branch owes HQ (total − courierShare − branchShare)
    //   branch cashbox: branch receives its tariff-adjusted payable share
    /**
     * ⚠️ NAQD OYOQLARI `totalPrice` DAN EMAS, YIG'ILGAN NAQDDAN hisoblanadi.
     *
     * Mijoz onlayn to'lagan bo'lsa pul MARKETGA tushadi va kuryer qo'liga
     * hech narsa olmaydi. `totalPrice` bilan hisoblansa kuryer yig'MAGAN
     * pulni topshirgandek, biz esa olMAGAN pulni marketga qarzdek yozardik.
     *
     * Qolgan formulalar o'zgarmadi: ular `collectible < tarif` holatini
     * allaqachon to'g'ri ishlaydi (0 so'mlik buyurtma yo'li) — market
     * bizga qarzdor bo'ladi, kuryer ulushini esa HQ to'laydi.
     */
    const collectible = this.resolveCollectibleAmount(order);
    const marketIncome = Math.max(collectible - marketTariff, 0);
    const marketExpense = Math.max(marketTariff - collectible, 0);
    const courierIncome = Math.max(collectible - courierShare, 0);
    const managerBranchCash = this.resolveManagerSaleBranchCash({
      isManagerRequester,
      settlementBranchId,
      hasBranchCashbox: Boolean(branchCashbox),
      courierIncome,
    });
    const courierExpense = Math.max(courierShare - collectible, 0);
    const branchNet = collectible - courierShare - branchShare;
    const saleComment =
      collectible === 0
        ? totalPrice > 0
          ? `${totalPrice} so'mlik buyurtma — mijoz oldindan to'lagan, naqd yig'ilmadi`
          : "0 so'mlik mahsulot sotuvi"
        : collectible < marketTariff
          ? `${collectible} so'mlik mahsulot sotuvi`
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

      /**
       * ---- Filial oyog'i SOTUVDA YOZILMAYDI (audit M3) ----
       *
       * Ilgari bu yerda filial kassasiga `total − courierShare − branchShare`
       * INCOME qilib yozilardi. Ayni summa kuryer kassasiga ham yozilardi, va
       * keyin manager kuryerdan naqdni qabul qilganda filialga YANA yozilardi
       * (`finance.cashbox.payment_courier`, qabul qiluvchi = BRANCH) — hech
       * qanday kompensatsiya oyog'isiz. Natijada bitta pul filial kassasida
       * ikki marta turardi: yo filial qarzi cheksiz shishardi, yo
       * "filial → MAIN" o'tkazmasi MAIN'ga mavjud bo'lmagan pulni yozardi.
       *
       * Endi ma'no bitta: BRANCH kassa qoldig'i = FILIAL JISMONAN USHLAB
       * TURGAN NAQD. U faqat kuryerdan pul qabul qilinganda ko'payadi va
       * HQ'ga topshirilganda kamayadi — ya'ni managerning sanab topshiradigan
       * pulini bildiradi. "Filial HQ'ga qancha qarz" degan savolga esa
       * `order_settlement.branch_amount` javob beradi (buyurtma boshiga bir
       * marta, qaysi bo'g'inda turganidan qat'i nazar).
       *
       * ISTISNO — menejer sotuvi: kuryer yo'q, naqd filialning o'zida
       * (`resolveManagerSaleBranchCash`). Qo'shimcha xarajatdan OLDIN
       * yoziladi: filial kassasi manfiyga tushishi mumkin emas.
       */
      if (managerBranchCash > 0 && settlementBranchId) {
        await pay({
          user_id: settlementBranchId,
          cashbox_type: Cashbox_type.BRANCH,
          amount: managerBranchCash,
          operation_type: Operation_type.INCOME,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: saleComment,
        });
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
            // Urinish tokeni (audit M13): busiz rollback → qayta sotuvdagi
            // xarajat (sell_extra_cost, order, '') bo'yicha jimgina
            // tashlab yuborilardi. `sell_profit` bilan bir xil token.
            dedup_key: this.saleLedgerKey(soldAt),
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
          // Buyurtmada SAQLANADI: ilgari faqat kassa tarixida qolardi va
          // hamkorga (BeePost) umuman yetib bormasdi.
          extra_cost: extraCost,
          sold_at: soldAt,
          // fix3 C13 (CODE-09): sotilgan buyurtmada eski "qaytarish so'rovi"
          // belgisi qolmaydi (qisman sotuv ham tozalaydi). Qolsa, u
          // menejerning "Qaytarish" ro'yxatida so'rov bo'lib chiqardi.
          return_requested: false,
          // Snapshot tariffs + the actually-kept shares so SELL_PROFIT
          // (marketTariff − courierShare − branchShare) and rollback are exact.
          // AYNAN kassa oyoqlarida ishlatilgan qiymat yoziladi (override bo'lsa
          // `marketTariff` allaqachon undan olingan) — snapshot va yozilgan oyoq
          // har doim bitta tarifga tayanadi.
          market_tariff: marketTariff,
          courier_tariff: courierTariff,
          courier_share: courierShare,
          branch_share: branchShare,
          // Kuryer sotuvida filial kassasiga oyoq yozilmaydi (audit M3) —
          // 0. Menejer sotuvida esa naqd filialda, yozilgan kirim AYNAN shu
          // yerga snapshot qilinadi va rollback uni teskari qiladi. Eski
          // buyurtmalarda bu ustun real qiymat bilan to'lgan — rollback
          // o'shani ham aynan teskari qiladi.
          branch_cashbox_amount: managerBranchCash,
          // Naqd oyoqlari AYNAN shu summa bilan yozildi. Rollback uni qayta
          // hisoblamasligi kerak: `paid_online_amount` sotuvdan keyin ham
          // o'zgaradi (qaytarish webhooki), ya'ni qayta hisob boshqa raqam
          // berardi va kassada farq qolardi.
          sale_collectible_amount: collectible,
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
        // Ishorali summalar (audit M10) + marketning qo'shimcha xarajati
        // (audit M8): u sotuvda market kassasidan yechiladi, demak marketga
        // qoladigan haqiqiy summa aynan shuncha kam. Ilgari ledger buni
        // ko'rmasdi va solishtirish skripti farqni "extra-cost shovqini" deb
        // kechirardi — ya'ni haqiqiy nomuvofiqlik ham o'sha bag'rikenglik
        // ichida yashirinardi.
        // ⚠️ `collectible`, `totalPrice` EMAS — daftar kassa bilan AYNI
        // summalarni ko'rsatishi kerak. Aks holda onlayn to'langan har bir
        // buyurtma solishtiruv skriptida "nomuvofiqlik" bo'lib chiqardi.
        // ⚠️ Qo'shimcha xarajat kuryer/filial kassasidan ham yechiladi, demak
        // o'sha bo'g'inlar zanjir bo'ylab shuncha kam naqd ko'taradi — aks
        // holda FIFO daftardan ko'p pul talab qilib qotib qolardi.
        courier_amount: collectible - courierShare - extraCostLegs.courier,
        branch_amount: branchNet - extraCostLegs.branch,
        market_amount: collectible - marketTariff - extraCost,
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
      extraCostApproved?: boolean;
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
    if (extraCost > 0) {
      if (!financialActor) {
        this.notFound(
          isManagerRequester ? 'Manager not found' : 'Courier not found',
        );
      }
      await this.assertCanAddExtraCost({
        actor: financialActor,
        requester,
        order,
      });
      // Ruxsatdan KEYIN summa chegarasi: "kim yozadi" va "qancha yozadi" —
      // ikki xil savol, ikkinchisi ilgari umuman tekshirilmasdi.
      this.assertExtraCostWithinLimit({
        extraCost,
        mode: 'cancel',
        whereDeliver: order.where_deliver,
        tariffCenter: Number(financialActor?.tariff_center ?? 0),
        tariffHome: Number(financialActor?.tariff_home ?? 0),
        isManager:
          this.hasRole(requester, Roles.MANAGER) &&
          !this.hasRole(requester, Roles.COURIER),
      });
    }

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
    const pendingApproval = await this.requestExtraCostApprovalIfNeeded({
      order,
      requester,
      action: 'cancel',
      extraCost,
      proofFiles,
      dto: dto ?? {},
    });
    if (pendingApproval) {
      return pendingApproval;
    }

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

    // Qo'shimcha xarajat daftar oyoqlari + bekor qilingan buyurtma zanjirdagi
    // qaysi filialga tegishli ekani (kredit qatorini ochish uchun).
    const extraCostLegs = this.resolveExtraCostSettlementLegs({
      extraCost,
      chargedCashboxType: actorExpenseCashbox ? actorExpenseCashboxType : null,
    });
    const settlementBranchId =
      extraCost > 0 ? await this.lookup.resolveSettlementBranchId(order) : null;

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
            // Urinish tokeni (audit M13): rollbackdan keyingi qayta bekor
            // qilish yangi yozuv ochadi, takroriy yetkazish esa bitta qoladi.
            dedup_key: `cancel:${dedupEpoch}`,
          },
          { manager: tx },
        );

        /**
         * ⚠️ KREDIT QATORI — SETTLEMENT DAFTARI KASSA BILAN TENGLASHADI.
         *
         * Bekor qilingan buyurtmada sotuv yo'q, demak daftarda qator ham
         * yo'q edi. Lekin qo'shimcha xarajat kuryer (yoki filial) kassasidan
         * YECHILADI — ya'ni u topshiradigan naqd aynan shuncha kam bo'ladi,
         * daftar esa to'liq summani talab qilaverardi. Jonli E2E'da aynan
         * shu 5 000 so'm yetmay, uchinchi buyurtma abadiy PENDING bo'lib
         * qotib qolgan edi.
         *
         * Endi bekor qilingan buyurtma uchun ham qator ochiladi, faqat
         * MANFIY (kredit) oyoqlar bilan: FIFO uni kerak bo'lganda lump-sum
         * ustiga qo'shadi va ikki daftar bir-biriga mos keladi.
         */
        await this.recordSaleSettlement(tx, {
          order_id: String(order.id),
          courier_id: extraCostLegs.courier > 0 ? actorCourierId : null,
          branch_id: settlementBranchId,
          market_id: order.market_id ? String(order.market_id) : null,
          courier_amount: extraCostLegs.courier ? -extraCostLegs.courier : 0,
          branch_amount: extraCostLegs.branch ? -extraCostLegs.branch : 0,
          market_amount: -extraCost,
          hasCourier: extraCostLegs.courier > 0,
        });
      }

      await this.updateFull(
        id,
        {
          status: Order_status.CANCELLED,
          comment: finalComment || null,
          sold_at: null,
          /**
           * ⚠️ `extra_cost` BEKOR YO'LIDA ENTITY'GA YOZILISHI SHART.
           *
           * Ilgari bu yo'q edi: `cancelOrder` qo'shimcha xarajatni kassadan
           * yechardi va `order_settlement`ga MANFIY oyoq yozardi (yuqoriga
           * qarang), LEKIN buyurtma entity'siga `extra_cost`ni umuman
           * yozmasdi — natijada bekor qilingan buyurtmada `extra_cost=0`
           * qolardi. `sellOrder` esa uni yozardi (assimetriya).
           *
           * Oqibati integration yo'lida ko'rinardi: `GET /partner/shipments/:id`
           * `extra_cost`ni order entity'sidan o'qiydi — 0 bo'lgani uchun BeePost
           * bekor qilingan buyurtmaning qo'shimcha xarajatini HECH QACHON
           * ko'rmasdi. Jonli E2E (1251174 extra=5000, 1251175 extra=4000) da
           * kassadan pul yechilgan, settlement daftariga tushgan, lekin
           * GET /orders/:id.extra_cost=0 edi.
           *
           * `updateFull` whitelist'i (2093e41) `extra_cost`ni `typeof` bilan
           * o'tkazadi, shuning uchun uni bu yerda uzatish yetarli. `extraCost`
           * bu yerda 0 bo'lsa ham xavfsiz: 0 yozadi (default bilan bir xil).
           */
          extra_cost: extraCost,
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
   * YETKAZISHDAN OLDIN bekor qilish — hamkor (Partner API) uchun tor yo'l.
   *
   * MUAMMO (audit F4). `cancelOrder` `WAITING` holat va `post_id` ni TALAB
   * qiladi (`:4167`, `:4170`), chunki u pochta/kuryer/kassa qaytarishini
   * bajaradi. Hamkor posilkasi esa yaratilgandan keyin `NEW` da turadi
   * (skanerlanmaguncha) va mijoz aynan shu oynada buyurtmani bekor qiladi.
   * O'sha holda `cancelOrder` xato berardi, `rmqRequest` esa uni yutib
   * hamkorga **502** qaytarardi — ya'ni bekor qilishning eng ko'p
   * uchraydigan holati umuman ishlamasdi.
   *
   * NEGA ALOHIDA METOD. `cancelOrder`ni yumshatish butun ilovaga ta'sir
   * qiladi: u pochta soni, kuryer qarzi va kassa harakati bilan bog'langan.
   * Bu metod esa FAQAT pul va pochta hali tegmagan holatlarda ishlaydi,
   * shuning uchun qaytariladigan hech narsa yo'q.
   *
   * ⚠️ RUXSAT ETILGAN HOLATLAR ATAYLAB `CREATED` va `NEW` bilan
   * CHEKLANGAN. `RECEIVED` bo'lsa buyurtma allaqachon POCHTAGA qo'shilgan
   * (`receiveNewOrders` `post_id` yozadi) va uni bekor qilish pochta sonini
   * ham tuzatishni talab qiladi — bu boshqa ish. Shu bois `RECEIVED` va
   * undan keyingi holatlarda bu metod ATAYLAB rad etadi va chaqiruvchi
   * hamkorga aniq sabab qaytaradi.
   *
   * Idempotent: allaqachon bekor qilingan bo'lsa xato bermaydi.
   */
  async cancelPreDeliveryOrder(input: {
    order_id: string;
    reason?: string | null;
    /** Jurnalda kim bekor qilganini ko'rsatish uchun. */
    actor?: string | null;
  }) {
    const order = await this.findById(String(input.order_id));
    const oldStatus = order.status;

    // Idempotentlik — qayta chaqirilsa muvaffaqiyat qaytadi.
    if (
      oldStatus === Order_status.CANCELLED ||
      oldStatus === Order_status.CANCELLED_SENT
    ) {
      return successRes(
        { id: order.id, status: order.status, idempotent: true },
        200,
        'Order already cancelled',
      );
    }

    const allowed = [Order_status.CREATED, Order_status.NEW];
    if (!allowed.includes(oldStatus)) {
      /**
       * 409 — "holat mos emas", 400 emas: so'rov to'g'ri, lekin buyurtma
       * boshqa bosqichda. Hamkor shu farqni ko'rishi kerak, aks holda
       * so'rovni takrorlab yurardi.
       */
      throw new RpcException({
        statusCode: 409,
        message:
          `Buyurtma '${oldStatus}' holatida — yetkazishdan oldin bekor ` +
          'qilish faqat qabul qilinmagan posilkada mumkin',
      });
    }

    const note =
      `Yetkazishdan oldin bekor qilindi` +
      (input.reason ? `: ${input.reason}` : '') +
      (input.actor ? ` (${input.actor})` : '');

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const orderRepo = queryRunner.manager.getRepository(Order);
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);

      order.status = Order_status.CANCELLED;
      /**
       * ⚠️ PUL VA POCHTA TEGILMAYDI va bu ataylab: `CREATED`/`NEW` holatda
       * na kassa harakati, na `post_id` mavjud. Moliya emit yo'li ham
       * chaqirilmaydi — qaytariladigan harakat yo'q.
       */
      await orderRepo.save(order);

      await this.custody.createTrackingEvent(
        {
          order_id: order.id,
          from_status: oldStatus,
          to_status: Order_status.CANCELLED,
          changed_by: 'system',
          changed_by_role: 'system',
          note,
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
      action: ActivityAction.STATUS_CHANGE,
      old_value: { status: oldStatus },
      new_value: { status: Order_status.CANCELLED },
      metadata: { reason: input.reason ?? null, actor: input.actor ?? null },
    });

    /**
     * Tashqi tizimga signal — hamkor o'z tomonida ham bekor qilganini
     * ko'rishi kerak. `queueExternalStatusSync` `external_id` bo'lmasa
     * o'zi hech narsa qilmaydi.
     */
    await this.queueExternalStatusSync(
      order,
      'canceled',
      oldStatus,
      Order_status.CANCELLED,
    ).catch(() => undefined);

    return successRes(
      { id: order.id, status: Order_status.CANCELLED },
      200,
      'Order cancelled',
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

    /**
     * ⚠️ SOTILGAN BUYURTMANI KARGO WEBHOOKI BEKOR QILA OLMAYDI (audit C5).
     *
     * MUAMMO. `cancelStates` ro'yxatida `SOLD`/`PAID`/`PARTLY_PAID` YO'Q,
     * ya'ni ichki oqimda sotilgan buyurtma uchun kechikkan yoki takroriy
     * `cancel` webhooki `alreadyApplied` ni false qoldirib statusni
     * `CANCELLED` ga o'zgartirardi.
     *
     * Bu metod esa ATAYLAB status-only: kassani qaytarmaydi. Natijada
     * buyurtma "bekor qilingan" bo'lib turadi, pul esa sotuv sifatida
     * kassada qoladi — status va daftar JIMGINA ajraladi va farqni hech
     * narsa ko'rsatmaydi.
     *
     * ⚠️ XATO TASHLAMAYMIZ: chaqiruvchi (`applyWebhookToShipment`) bu
     * chaqiruvni "best-effort" qiladi va xato webhookni yiqitmaydi —
     * ya'ni tashlangan xato JIMGINA yutilardi. Shu bois status
     * O'ZGARTIRILMAYDI, hodisa esa audit jurnaliga ANIQ sabab bilan
     * yoziladi: farqni odam ko'rib qaror qilishi kerak.
     *
     * Nega avtomatik qaytarmaymiz: pulni teskari aylantirish kassa, kuryer
     * qarzi va operator daromadiga tegadi — buni webhook qaroriga
     * qoldirish xavfli.
     */
    if (input.action === 'cancel' && soldStates.includes(oldStatus)) {
      this.logger.warn(
        `provider cancel REFUSED for order ${order.id}: ` +
          `buyurtma '${oldStatus}' holatida (sotilgan). Status o'zgartirilmadi.`,
      );
      await this.activityLog.log({
        entity_type: 'Order',
        entity_id: String(order.id),
        action: ActivityAction.EXTERNAL_SYNC,
        old_value: { status: oldStatus },
        new_value: { status: oldStatus, provider_action: 'cancel_refused' },
        metadata: {
          provider_slug: input.provider_slug ?? null,
          external_ref: input.external_ref ?? null,
          reason:
            'sotilgan buyurtmani kargo webhooki bekor qila olmaydi — ' +
            "pul qaytarish qo'lda ko'rib chiqilishi kerak",
        },
      });
      return successRes(
        {
          id: order.id,
          status: oldStatus,
          skipped: true,
          refused: true,
          reason: 'sold_cannot_be_cancelled_by_provider',
        },
        200,
        'provider cancel refused: order already sold',
      );
    }

    const note =
      `Provider ${input.provider_slug ?? 'external'} → ${input.action}` +
      (input.external_ref ? ` (ref: ${input.external_ref})` : '');

    // Kargo sotuvi uchun pul summalari (audit M5). Tranzaksiyadan OLDIN
    // hisoblanadi: market ma'lumoti tashqi (RMQ) chaqiruv talab qiladi.
    let providerMarketTariff = 0;
    let providerMarketAmount = 0;
    /**
     * fix3c (MONEY-01) — OYOQLAR KARGO YIG'ADIGAN NAQDDAN, `total_price`
     * DAN EMAS.
     *
     * Hamkorning prepaid posilkasida `paid_online_amount` (= subtotal −
     * cod_amount) endi saqlanadi va dispatch kargoga AYNAN `total −
     * paid_online_amount` ni yig'ishni aytadi. Ilgari oyoqlar `total_price`
     * dan yozilardi: to'liq prepaid (COD 0) posilkada HQ marketga hech kim
     * yig'MAGAN `total − tarif` ni qarzdor bo'lib qolardi (SA uni MAIN dan
     * to'lab yuborardi), kargoning `total` lik qarzi esa abadiy ochiq
     * turardi. Qoida `sellOrder` dagi bilan AYNI (`resolveCollectibleAmount`):
     * onlayn to'langan qism marketga to'g'ridan-to'g'ri tushgan, pochta unga
     * aralashmaydi. Kuryer/filial oyoqlari o'rnida kargo qarzi turadi — u ham
     * shu summa (javobdagi `cod_collected`).
     */
    const providerCollectible = this.resolveCollectibleAmount(order);
    if (input.action === 'sell' && order.market_id) {
      const market = await this.lookup
        .getMarketsByIds([String(order.market_id)])
        .then((rows) => rows[0])
        .catch(() => undefined);
      providerMarketTariff = resolveOrderTariff({
        snapshot: order.market_tariff,
        isCenter: order.where_deliver === Where_deliver.CENTER,
        centerTariff: market?.tariff_center,
        homeTariff: market?.tariff_home,
      });
      providerMarketAmount = providerCollectible - providerMarketTariff;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const orderRepo = queryRunner.manager.getRepository(Order);
      const trackingRepo = queryRunner.manager.getRepository(OrderTracking);

      order.status = targetStatus;
      if (input.action === 'sell') {
        order.sold_at = order.sold_at ?? String(Date.now());
        // Tariflar sotuv paytida qotiriladi — keyin tarif o'zgarsa ham
        // hisob-kitob va rollback aynan shu qiymatlar bilan ishlaydi.
        order.market_tariff = order.market_tariff ?? providerMarketTariff;
        order.courier_share = 0;
        order.branch_share = 0;
        // fix3c: `sellOrder` dagi `netToBePaid` kabi manfiy bo'lmaydi —
        // prepaid posilkada tarif market QARZI (FOR_MARKET chiqimi), marketga
        // to'lanadigan qism esa 0.
        order.to_be_paid = Math.max(providerMarketAmount, 0);
        /**
         * fix3b (L1 ochiq masalasi) — ROLLBACK UCHUN SNAPSHOT. Kargo sotuvi
         * filial kassasiga hech narsa yozmaydi (pastda faqat market oyog'i),
         * naqd esa kargoda — yig'iladigan qism (fix3c: `total_price −
         * paid_online_amount`, prepaid posilkada 0). Bu ikki ustun yozilmasa
         * rollback `null` zaxirasiga tushib, filialda turgan buyurtma uchun
         * HECH QACHON yozilmagan filial oyog'ini (`saleBranchNet`) teskari
         * yozardi.
         */
        order.branch_cashbox_amount = 0;
        order.sale_collectible_amount = providerCollectible;
      }
      await orderRepo.save(order);

      /**
       * ⚠️ KARGO SOTUVI ENDI KASSAGA HAM YOZILADI (audit M5).
       *
       * Ilgari bu yo'l ATAYLAB "status-only" edi: marketga qarz yozilmasdi,
       * `order_settlement` qatori yaratilmasdi, `sell_profit` va operator
       * komissiyasi ham yo'q edi. Kargoning qarzi esa butunlay boshqa
       * jadvalda (`provider_receivables`) turardi va kassaga umuman
       * bog'lanmasdi. Natijada marketga to'lov qo'lda, hech qanday
       * bog'lanishsiz qilinardi — ikki marta to'lash yoki umuman to'lamaslik
       * daftarda ko'rinmasdi.
       *
       * Model: kargo mijozdan naqdni yig'adi (shuning uchun settlement qatori
       * PENDING bo'lib turadi), Elchi esa marketga `yig'iladigan naqd −
       * market_tariff` qarzdor bo'lib qoladi (fix3c; manfiy bo'lsa — prepaid
       * posilka — tarifni market qarz). Kargo hisob-kitob qilganda
       * (`integration.provider.remittance`) MAIN kassaga kirim yoziladi va
       * qator BRANCH_SETTLED ga o'tadi.
       *
       * ⚠️ KARGONING O'Z HAQI HALI MODELLASHTIRILMAGAN: kodda kargo uchun
       * tarif maydoni yo'q. U kelguncha kargoga to'lov qo'lda chiqim sifatida
       * yoziladi va bu yerdagi foyda faqat market tarifi bo'lib qoladi.
       */
      if (input.action === 'sell') {
        const pay = (
          data: Parameters<typeof this.updateCashboxBalance>[0],
        ): Promise<void> =>
          this.updateCashboxBalance(
            { ...data, dedup_epoch: `provider-sell:${String(order.id)}` },
            queryRunner.manager,
          );

        if (order.market_id) {
          if (providerMarketAmount > 0) {
            await pay({
              user_id: String(order.market_id),
              cashbox_type: Cashbox_type.FOR_MARKET,
              amount: providerMarketAmount,
              operation_type: Operation_type.INCOME,
              source_type: Source_type.SELL,
              source_id: String(order.id),
              created_by: 'system',
              comment: note,
            });
          } else if (providerMarketAmount < 0) {
            await pay({
              user_id: String(order.market_id),
              cashbox_type: Cashbox_type.FOR_MARKET,
              amount: -providerMarketAmount,
              operation_type: Operation_type.EXPENSE,
              source_type: Source_type.SELL,
              source_id: String(order.id),
              created_by: 'system',
              comment: note,
            });
          }
        }

        await this.recordSaleSettlement(queryRunner.manager, {
          order_id: String(order.id),
          courier_id: null,
          branch_id: null,
          market_id: order.market_id ? String(order.market_id) : null,
          courier_amount: 0,
          // fix3c: HQ'ga kargodan keladigan naqd = kargo qarzi (yig'ilgan
          // qism, `sellOrder` dagi `branchNet` ning ulushsiz ko'rinishi).
          // Prepaid posilkada 0 — qarz yozilmaydi.
          branch_amount: providerCollectible,
          market_amount: providerMarketAmount,
          hasCourier: false,
          // Naqd kargoda — HQ'ga hali yetib kelmagan.
          cashHeldByProvider: true,
        });

        // Foyda + operator komissiyasi. `orderRepo.save` `updateFull` dan
        // o'tmagani uchun bu ilgak qo'lda chaqiriladi.
        await this.enqueueFinanceOnStatusChange(
          order,
          oldStatus,
          queryRunner.manager,
        );
      }

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
        // Moslik uchun qoladi: eski integration-service kargo qarzini shu
        // summadan yozardi.
        total_price: Number(updated.total_price ?? 0),
        /**
         * fix3c (MONEY-01) — KARGO HAQIQATAN YIG'GAN NAQD (COD): sotuv
         * snapshoti `sale_collectible_amount` bilan bir xil, dispatchda
         * kargoga aytilgan summa. integration-service kargo qarzini
         * (`provider_receivables`) SHUNDAN yozadi; prepaid posilkada 0 — qarz
         * yozilmaydi. ⚠️ Hamkor kontraktidagi eski `cod_collected`
         * (= `paid_amount`) bilan aralashtirilmasin — bu boshqa RPC javobi.
         */
        ...(input.action === 'sell'
          ? { cod_collected: providerCollectible }
          : {}),
      },
      200,
      `order marked ${input.action} by provider`,
    );
  }

  async partlySellOrder(
    requester: { id: string; roles?: string[]; branch_id?: string | null },
    id: string,
    dto: {
      order_item_info: PartlySellRequestItem[];
      totalPrice: number;
      extraCost?: number;
      comment?: string;
      proofFileKeys?: string[];
      proofFileKeysVerified?: boolean;
      extraCostApproved?: boolean;
    },
    requestId?: string,
  ) {
    const isManagerRequester =
      this.hasRole(requester, Roles.MANAGER) &&
      !this.hasRole(requester, Roles.COURIER);
    const order = await this.findById(id);
    /**
     * ⚠️ QISMAN SOTUV HAM TO'SILADI (adversarial topilma, kritik).
     *
     * Ilgari darvoza faqat `sellOrder` da bor edi, `partlySellOrder` esa
     * AYNI kassa matematikasini bajaradi (kuryer, market, filial oyoqlari)
     * — ya'ni darvozani chetlab o'tishning tayyor yo'li qolgan edi.
     */
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
    this.assertManagerSaleNotCourierHeld(isManagerRequester, order);

    if (!dto?.order_item_info?.length) {
      this.badRequest('order_item_info is required');
    }

    const price = Number(dto.totalPrice ?? 0);
    if (!Number.isFinite(price) || price < 0) {
      this.badRequest('totalPrice must be a non-negative number');
    }
    /**
     * ⚠️ QISMAN SOTUV SUMMASI BUYURTMA SUMMASIDAN OSHMAYDI (audit M10).
     *
     * Ilgari faqat manfiy emasligi tekshirilardi: 150 000 lik buyurtmaga
     * 1 500 000 yozilsa market va kuryer kassasi, daftar va `total_price`
     * shunga shishardi, bekor qilingan qism esa `max(eski − narx, 0)` = 0
     * bo'lib qolardi — rollback asl summani tiklay olmasdi (eski = narx +
     * bekor qism). Chegara bilan bekor qism doim `eski − narx` va rollback
     * aynan eski summani qaytaradi.
     */
    if (price > oldTotalPrice) {
      this.badRequest(
        `Qisman sotuv summasi (${price} so'm) buyurtma summasidan ` +
          `(${oldTotalPrice} so'm) oshmasligi kerak`,
      );
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
    // Menejer sotuvida filial kassasi SHART — `sellOrder` dagi izohga qarang
    // (audit M15).
    if (isManagerRequester && settlementBranchId && !branchCashbox) {
      this.notFound(
        "Filial kassasi topilmadi — sotuv to'xtatildi, qaytadan urinib ko'ring",
      );
    }
    const branchShare = settlementBranchId
      ? await this.lookup.resolveBranchShare(settlementBranchId)
      : 0;

    const marketBalanceBefore = Number(marketCashbox.balance ?? 0);
    const marketTariff = resolveOrderTariff({
      snapshot: order.market_tariff,
      isCenter: order.where_deliver === Where_deliver.CENTER,
      centerTariff: market.tariff_center,
      homeTariff: market.tariff_home,
    });
    const courierTariff = resolveOrderTariff({
      snapshot: order.courier_tariff,
      isCenter: order.where_deliver === Where_deliver.CENTER,
      centerTariff: financialActor?.tariff_center,
      homeTariff: financialActor?.tariff_home,
    });
    const courierShare = this.resolveSaleActorShare(
      isManagerRequester,
      financialActor,
      courierTariff,
    );
    // Qisman sotuvda ham kuryer to'liq tarifini oladi va market to'liq tarif
    // bilan hisoblanadi, ya'ni tarif qoplamaslik zarari bu yo'lda ham xuddi
    // shunday yuzaga keladi — sellOrder bilan bir xil qo'riqchi.
    this.assertTariffCoversShares({ marketTariff, courierShare, branchShare });
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
    if (extraCost > 0) {
      await this.assertCanAddExtraCost({
        actor: financialActor,
        requester,
        order,
      });
      // Ruxsatdan KEYIN summa chegarasi: "kim yozadi" va "qancha yozadi" —
      // ikki xil savol, ikkinchisi ilgari umuman tekshirilmasdi.
      this.assertExtraCostWithinLimit({
        extraCost,
        mode: 'sell',
        whereDeliver: order.where_deliver,
        tariffCenter: Number(financialActor?.tariff_center ?? 0),
        tariffHome: Number(financialActor?.tariff_home ?? 0),
        isManager:
          this.hasRole(requester, Roles.MANAGER) &&
          !this.hasRole(requester, Roles.COURIER),
      });
    }
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
    const pendingApproval = await this.requestExtraCostApprovalIfNeeded({
      order,
      requester,
      action: 'partly_sell',
      extraCost,
      proofFiles,
      dto: dto ?? {},
    });
    if (pendingApproval) {
      return pendingApproval;
    }
    const finalComment = this.generateSaleComment(
      order.comment,
      dto?.comment,
      extraCost,
      ['Buyurtma arzonroqqa sotildi!'],
    );

    // Qo'shimcha xarajat AYNAN qaysi kassadan yechiladi — daftar oyoqlari ham
    // shuncha kamayadi (`sellOrder` bilan bir xil).
    const extraCostLegs = this.resolveExtraCostSettlementLegs({
      extraCost,
      chargedCashboxType: actorExpenseCashbox ? actorExpenseCashboxType : null,
    });

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

    const { matches: itemMatches, cancelledItems } = matchPartlySellItems(
      existingItems,
      dto.order_item_info,
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
    /**
     * ⚠️ QISMAN SOTUVDA HAM NAQD — `price` DAN EMAS, YIG'ILGANIDAN.
     *
     * Mijoz to'liq summani oldindan to'lagan, kuryer esa faqat bir qismini
     * sotgan bo'lishi mumkin. Bunda kuryer HECH NARSA yig'maydi, ortiqcha
     * to'lovni esa MARKET mijozga qaytaradi — pul ularda (foydalanuvchi
     * qarori 2026-09-14). Bizning kitobimizda faqat ikki narsa qoladi:
     * market yetkazish haqini qarzdor, kuryer ulushini HQ to'laydi.
     *
     * Bu yo'l `sellOrder` dan ALOHIDA e'tibor talab qiladi: ilgari darvoza
     * faqat `sellOrder` da bo'lgani uchun uni chetlab o'tish yo'li qolgan
     * edi (adversarial topilma). Endi ikkala yo'l ayni formulani ishlatadi.
     */
    const collectible = Math.max(
      price - Number(order.paid_online_amount ?? 0),
      0,
    );
    const marketIncome = Math.max(collectible - marketTariff, 0);
    const marketExpense = Math.max(marketTariff - collectible, 0);
    const courierIncome = Math.max(collectible - courierShare, 0);
    const managerBranchCash = this.resolveManagerSaleBranchCash({
      isManagerRequester,
      settlementBranchId,
      hasBranchCashbox: Boolean(branchCashbox),
      courierIncome,
    });
    const courierExpense = Math.max(courierShare - collectible, 0);
    const branchNet = collectible - courierShare - branchShare;
    const saleComment =
      collectible === 0
        ? price > 0
          ? `${price} so'mlik qisman sotuv — mijoz oldindan to'lagan, naqd yig'ilmadi`
          : "0 so'mlik mahsulot qisman sotuvi"
        : collectible < marketTariff
          ? `${collectible} so'mlik mahsulot qisman sotuvi`
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
    // Buyurtmaga yoziladigan `sold_at` — P&L tokeni ham AYNAN shundan olinadi.
    const partlySoldAt = order.sold_at ?? soldAt;

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
        // `typeof this.…` bu yerda TS 5.9 da hal bo'lmaydi (metodda boshqa
        // `this` tip so'rovi qolmagach) — sinf nomi orqali, ma'nosi bir xil.
        data: Parameters<OrderLifecycleService['updateCashboxBalance']>[0],
      ): Promise<void> =>
        this.updateCashboxBalance({ ...data, dedup_epoch: dedupEpoch }, tx);

      // Persist the reduced quantities for partially-returned line items.
      for (const { item: existingItem, quantity: nextQty } of itemMatches) {
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

      /**
       * ---- Filial oyog'i SOTUVDA YOZILMAYDI (audit M3) ----
       *
       * Ilgari bu yerda filial kassasiga `total − courierShare − branchShare`
       * INCOME qilib yozilardi. Ayni summa kuryer kassasiga ham yozilardi, va
       * keyin manager kuryerdan naqdni qabul qilganda filialga YANA yozilardi
       * (`finance.cashbox.payment_courier`, qabul qiluvchi = BRANCH) — hech
       * qanday kompensatsiya oyog'isiz. Natijada bitta pul filial kassasida
       * ikki marta turardi: yo filial qarzi cheksiz shishardi, yo
       * "filial → MAIN" o'tkazmasi MAIN'ga mavjud bo'lmagan pulni yozardi.
       *
       * Endi ma'no bitta: BRANCH kassa qoldig'i = FILIAL JISMONAN USHLAB
       * TURGAN NAQD. U faqat kuryerdan pul qabul qilinganda ko'payadi va
       * HQ'ga topshirilganda kamayadi — ya'ni managerning sanab topshiradigan
       * pulini bildiradi. "Filial HQ'ga qancha qarz" degan savolga esa
       * `order_settlement.branch_amount` javob beradi (buyurtma boshiga bir
       * marta, qaysi bo'g'inda turganidan qat'i nazar).
       *
       * ISTISNO — menejer sotuvi: kuryer yo'q, naqd filialning o'zida
       * (`resolveManagerSaleBranchCash`). Qo'shimcha xarajatdan OLDIN
       * yoziladi: filial kassasi manfiyga tushishi mumkin emas.
       */
      if (managerBranchCash > 0 && settlementBranchId) {
        await pay({
          user_id: settlementBranchId,
          cashbox_type: Cashbox_type.BRANCH,
          amount: managerBranchCash,
          operation_type: Operation_type.INCOME,
          source_type: Source_type.SELL,
          source_id: String(order.id),
          created_by: String(requester.id),
          comment: saleComment,
        });
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
            // Urinish tokeni (audit M13) — `sellOrder` dagi kabi.
            dedup_key: this.saleLedgerKey(partlySoldAt),
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
          sold_at: partlySoldAt,
          total_price: price,
          /**
           * ⚠️ Qisman sotuvda ham xarajat buyurtmaga yoziladi (audit M5).
           * Rollback xarajatni aynan shu snapshotdan qaytaradi; ilgari bu
           * yo'l uni yozmasdi — rollback eski (yoki 0) qiymatni ko'rardi.
           */
          extra_cost: extraCost,
          market_tariff: marketTariff,
          courier_tariff: courierTariff,
          courier_share: courierShare,
          branch_share: branchShare,
          // Kuryer sotuvida filial kassasiga oyoq yozilmaydi (audit M3) —
          // 0. Menejer sotuvida esa naqd filialda, yozilgan kirim AYNAN shu
          // yerga snapshot qilinadi va rollback uni teskari qiladi. Eski
          // buyurtmalarda bu ustun real qiymat bilan to'lgan — rollback
          // o'shani ham aynan teskari qiladi.
          branch_cashbox_amount: managerBranchCash,
          // Qisman sotuvda ham naqd oyoqlari AYNAN shu summa bilan yozildi —
          // rollback qayta hisoblamasligi uchun snapshot qilinadi
          // (`sellOrder` dagi bilan bir xil sabab).
          sale_collectible_amount: collectible,
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
        // Ishorali summalar + extra_cost ayirmasi — sellOrder bilan bir xil
        // (audit M8/M10).
        // ⚠️ `collectible` — kassa oyoqlari bilan AYNI summa (sellOrder'dagi
        // kabi). `price` bilan yozilsa onlayn to'langan qisman sotuv daftarda
        // kassadan farq qilardi.
        courier_amount: collectible - courierShare - extraCostLegs.courier,
        branch_amount: branchNet - extraCostLegs.branch,
        market_amount: collectible - marketTariff - extraCost,
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
          last_handover_by: this.numericActorId(requester.id),
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
            product_name: item.product_name,
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
      /** Sotuvda mijozdan yig'ilgan naqd (snapshot) — rollback shunga tayanadi. */
      sale_collectible_amount?: number | null;
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

  /**
   * PATCH /orders/:id va /:id/full — FAQAT `order.update_from_api` RPC ning
   * (gateway HTTP tahrir yo'li) xizmat qatlamidagi qoidasi (fix3 C6; M11,
   * CODE-03). Gateway bilan AYNI, himoya chuqurligi uchun:
   *
   *  1. PATCH faqat SA/ADMIN/REGISTRATOR uchun — boshqa rollar 403;
   *  2. `status`, `market_id`, `to_be_paid`, `paid_amount` va hayot sikli /
   *     snapshot maydonlari — HECH KIMGA (superadmin ham), 400: holat faqat
   *     sotish, bekor qilish va qaytarish amallari orqali o'zgaradi;
   *  3. `post_id`, `customer_id`, `qr_code_token`, `source` — faqat
   *     SUPERADMIN, aks holda 403;
   *  4. REGISTRATOR — faqat o'z filiali doirasidagi buyurtma (403).
   *
   * ⚠️ Ichki oqimlar bu metodga KELMAYDI (fix3b): filial dispatch, logistika
   * va finance `writeOrderPayment` `order.update` / `order.update_full` /
   * `order.update_normalized` orqali to'g'ridan-to'g'ri `updateFull` ga
   * boradi. Shuning uchun so'rovchisiz chaqiruv bu yerda TIZIM chaqiruvi
   * EMAS, balki noto'g'ri chaqiruv — FAIL-CLOSED 403 (qoidalarni chetlab
   * o'tadigan yo'l qolmasin).
   */
  async updateFromApi(
    id: string,
    dto: Record<string, unknown>,
    requester?: { id?: string; roles?: string[]; note?: string | null },
  ) {
    type UpdateFullDto = Parameters<OrderLifecycleService['updateFull']>[1];
    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden(
        "So'rovchi aniqlanmadi — buyurtmani tahrirlashga ruxsat yo'q",
      );
    }

    const isSuperAdmin = this.hasRole(requester, Roles.SUPERADMIN);
    const isAdmin = this.hasRole(requester, Roles.ADMIN);
    const isRegistrator = this.hasRole(requester, Roles.REGISTRATOR);
    if (!isSuperAdmin && !isAdmin && !isRegistrator) {
      this.forbidden("Buyurtmani tahrirlashga ruxsat yo'q");
    }

    const forbidden = presentFields(dto, API_UPDATE_FORBIDDEN_FIELDS);
    if (forbidden.length) {
      this.badRequest(
        `Bu maydonlarni PATCH orqali o'zgartirib bo'lmaydi: ${forbidden.join(', ')}. ` +
          "Holat sotish, bekor qilish va qaytarish amallari orqali o'zgaradi",
      );
    }

    if (!isSuperAdmin) {
      const superadminOnly = presentFields(
        dto,
        API_UPDATE_SUPERADMIN_ONLY_FIELDS,
      );
      if (superadminOnly.length) {
        this.forbidden(
          `Bu maydonlarni faqat superadmin o'zgartira oladi: ${superadminOnly.join(', ')}`,
        );
      }
    }
    if (!isSuperAdmin && !isAdmin) {
      const order = await this.findById(id);
      await this.assertOrderInRequesterBranchScope(
        requester,
        order,
        "Bu buyurtma sizning filialingizga tegishli emas — uni o'zgartira olmaysiz",
      );
    }

    return this.updateFull(id, dto as UpdateFullDto, requester);
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
      /** Sotuvda mijozdan yig'ilgan naqd (snapshot) — rollback shunga tayanadi. */
      sale_collectible_amount?: number | null;
      to_be_paid?: number;
      paid_amount?: number;
      /** Kuryer yozgan qo'shimcha xarajat — buyurtmada saqlanadi. */
      extra_cost?: number;
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
    // Rollback `sold_at` ni null qiladi, foydani teskari yozish esa
    // qaytarilayotgan sotuvning tokenini talab qiladi — shuning uchun
    // o'zgarishlar qo'llanishidan OLDIN saqlab qo'yamiz (audit M4).
    const previousSoldAt = order.sold_at;
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
      /**
       * ⚠️ BU IKKI MAYDON DTO'DA BOR EDI, LEKIN BU YERGA KO'CHIRILMASDI —
       * ya'ni `sellOrder`/`partlySellOrder` ularni uzatardi, `updateFull` esa
       * jimgina tashlab yuborardi va entity'ga hech qachon yozilmasdi.
       *
       * Oqibati jonli E2E'da (BeePost↔Elchi, Andijon) ko'rindi: hamkor API
       * `collected_from_customer` ni aynan `sale_collectible_amount` ustunidan
       * oladi (integration-service.service.ts), u esa DOIM `null` bo'lardi —
       * natijada BeePost hisob-kitob paneli "Elchi bizga qarz: 0" deb turardi,
       * aslida pul yig'ilgan bo'lsa ham. `extra_cost` ham xuddi shunday: kassada
       * ko'rinardi, buyurtmada `0` bo'lib qolardi.
       *
       * `??` EMAS, `typeof` ishlatiladi: `0` va `null` HAQIQIY qiymat —
       * `??` ularning birini (0 ni emas, null ni) jimgina eskisiga almashtirardi.
       */
      sale_collectible_amount:
        typeof dto.sale_collectible_amount !== 'undefined'
          ? dto.sale_collectible_amount
          : order.sale_collectible_amount,
      extra_cost:
        typeof dto.extra_cost !== 'undefined'
          ? dto.extra_cost
          : order.extra_cost,
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
      // Faqat courier_id o'zgarganda mavjud custody filialini (holder_branch_id)
      // saqlaymiz — aks holda stale order.branch_id (masalan HQ) holderni HQ ga
      // tortib, filial oyog'ini va uning naqdini yo'qotadi. branch_id aniq
      // uzatilganda (dispatch/receivePost) esa yangi filial ustun bo'ladi.
      const custodyBranchId =
        typeof dto.branch_id !== 'undefined'
          ? order.branch_id
          : (order.holder_branch_id ?? order.branch_id);
      const resolvedHolder = await this.resolveHolderFromState(
        custodyBranchId,
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
      order.last_handover_by = this.numericActorId(requester?.id);
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
        await this.enqueueFinanceOnStatusChange(
          order,
          oldStatus,
          manager,
          previousSoldAt,
        );
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
      const isPrivileged = isSuperAdmin || isAdmin;
      const canDeleteNew = isPrivileged || isRegistrator || isMarket;
      if (!canDeleteNew) {
        this.forbidden(
          "Faqat superadmin/admin/registrator/market 'new' holatdagi buyurtmani o‘chira oladi",
        );
      }
      /**
       * fix3 C6 (RBAC-04, CODE-01): market faqat O'Z buyurtmasini o'chiradi.
       * Ilgari egalik faqat CREATED uchun tekshirilardi — istalgan market
       * ketma-ket id'lar bo'yicha boshqa marketlarning HQ qabulini kutayotgan
       * NEW buyurtmalarini o'chirib yubora olardi (tiklash faqat SQL bilan).
       */
      if (
        !isPrivileged &&
        !isRegistrator &&
        (!requesterId || requesterId !== String(order.market_id ?? ''))
      ) {
        this.forbidden("Market faqat o'z buyurtmasini o'chira oladi");
      }
      // fix3 C6 (CODE-03): registrator — faqat o'z filiali doirasidagisini.
      if (!isPrivileged && isRegistrator) {
        await this.assertOrderInRequesterBranchScope(
          requester,
          order,
          "Bu buyurtma sizning filialingizga tegishli emas — uni o'chira olmaysiz",
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
