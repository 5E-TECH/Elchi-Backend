import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import {
  Brackets,
  DataSource,
  In,
  QueryFailedError,
  Repository,
  SelectQueryBuilder,
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
  FULFILLMENT_SOURCES,
  Order_status,
  OutboxService,
  Roles,
  Where_deliver,
  rmqSend,
  RMQ_SERVICE_TIMEOUT,
  tashkentDayRange,
} from '@app/common';
import { errorRes, successRes } from '../../../libs/common/helpers/response';
import {
  computeSaleMarketPaidMax,
  resolveCourierShare as resolveCourierShareShare,
} from './domain/order-money';
import { OrderLookupService } from './lookup/order-lookup.service';
import {
  ORDER_SCAN_LIGHT_SELECT,
  toOrderScanLightView,
} from './lookup/order-scan-light.view';
import { OrderCustodyService } from './custody/order-custody.service';
import {
  OrderWarehouseService,
  warehouseRefOf,
  type WarehouseRef,
} from './warehouse/order-warehouse.service';

/** Qidiruvda identity-service'dan olinadigan mijozlar chegarasi. */
const CUSTOMER_SEARCH_LIMIT = 1000;
const MAX_FETCH_ALL = 5000;

/**
 * Qidiruv matni buyurtma raqamimi (Elchida buyurtma raqami = `id`)? Faqat
 * raqamlar; bigint chegarasidan uzuni — yo'q (so'rov bazada yiqilmasin).
 */
export const parseOrderNumberSearch = (search: string): string | null =>
  /^\d{1,18}$/.test(search) ? search : null;

/**
 * GET /orders SARALASHI. Ilgari ro'yxat doim `createdAt DESC` edi va frontend
 * faqat ochilgan sahifa ichida saralardi — 2-sahifadagi eng qimmat buyurtma
 * 1-sahifaga chiqmasdi.
 *
 * SQL'ga foydalanuvchi matni TUSHMAYDI: kalit faqat shu oq ro'yxatdan olinadi.
 */
export const ORDER_LIST_SORT_FIELDS = [
  'created_at',
  'total_price',
  'status',
] as const;
export type OrderListSortField = (typeof ORDER_LIST_SORT_FIELDS)[number];
export type OrderListSort = {
  field: OrderListSortField;
  dir: 'ASC' | 'DESC';
};

/**
 * Holat bo'yicha saralash — alifbo emas, hayot tsikli tartibi (frontenddagi
 * `ORDER_STATUS_RANK` bilan bir xil). Ro'yxatda yo'q holatlar oxirida.
 */
const ORDER_STATUS_SORT_ORDER: Order_status[] = [
  Order_status.CREATED,
  Order_status.NEW,
  Order_status.RECEIVED,
  Order_status.ON_THE_ROAD,
  Order_status.WAITING,
  Order_status.SOLD,
  Order_status.PAID,
  Order_status.PARTLY_PAID,
  Order_status.CLOSED,
  Order_status.CANCELLED,
  Order_status.CANCELLED_SENT,
];
const ORDER_STATUS_SORT_SQL = `CASE order.status ${ORDER_STATUS_SORT_ORDER.map(
  (status, rank) => `WHEN '${status}' THEN ${rank}`,
).join(' ')} ELSE ${ORDER_STATUS_SORT_ORDER.length} END`;
const ORDER_STATUS_SORT_ALIAS = 'order_status_rank';

/**
 * `sort_by`/`sort_dir` ni tekshiradi. Parametr berilmasa — `null` (avvalgidek
 * createdAt DESC). Oq ro'yxatda yo'q qiymat — 400.
 */
export const parseOrderListSort = (
  sort_by?: string,
  sort_dir?: string,
): OrderListSort | null => {
  if (!sort_by && !sort_dir) return null;
  if (!ORDER_LIST_SORT_FIELDS.includes(sort_by as OrderListSortField)) {
    throw new RpcException({
      statusCode: 400,
      message: `sort_by faqat ${ORDER_LIST_SORT_FIELDS.join(', ')} bo'lishi mumkin`,
    });
  }
  if (sort_dir && sort_dir !== 'asc' && sort_dir !== 'desc') {
    throw new RpcException({
      statusCode: 400,
      message: "sort_dir faqat asc yoki desc bo'lishi mumkin",
    });
  }
  return {
    field: sort_by as OrderListSortField,
    dir: sort_dir === 'asc' ? 'ASC' : 'DESC',
  };
};

/** `findSummariesByIds` — bitta jadval sahifasidan ortiq emas. */
const ORDER_SUMMARY_MAX_IDS = 100;
/** Tashqi posilkalar ro'yxati sahifa chegarasi (PEc4BjVX). */
const EXTERNAL_LIST_MAX_LIMIT = 200;

/**
 * oNAE3LW9 — `order.geo.reassign_district` kirishi (order/identity/branch dagi
 * `*.reassign_district` bilan bir xil shakl).
 */
export interface GeoReassignInput {
  from_district_id?: string;
  to_district_id?: string;
  /** Ko'chgan qatorlarning `region_id` si shunga o'rnatiladi; bo'sh — tegilmaydi. */
  to_region_id?: string | null;
  /**
   * ID rejimi: faqat shu qatorlar (va faqat hali `from_district_id` da
   * turganlari) ko'chadi — birlashtirish KOMPENSATSIYASI (B → A) uchun.
   */
  ids?: Array<string | number> | null;
  /** Kompensatsiya: `region_id` ni qator bo'yicha AYNAN tiklash. */
  restore_regions?: Array<{
    region_id: string | number | null;
    ids: Array<string | number>;
  }> | null;
  /**
   * Muddat (epoch ms): logistics shu paytgacha javob kutadi. Undan keyin
   * ko'chirish BAJARILMAYDI (boshida va COMMIT'dan oldin tekshiriladi) —
   * logistics timeout bilan voz kechib kompensatsiya qilgandan keyin "kech"
   * ko'chish bo'lmasin.
   */
  deadline_at?: number | null;
}

/** oNAE3LW9 — bigint ID (musbat butun son, ko'pi bilan 19 xona). */
const GEO_ID_PATTERN = /^\d{1,19}$/;

/**
 * oNAE3LW9 (prod 2-tur) — O'CHIRILMAGAN buyurtma: o'chirishning ikkala yo'li
 * ham hisobga olinadi — `deleteOrder` faqat `is_deleted` ni qo'yadi, qisman
 * sotuvni qaytarish esa `deleted_at` ni ham (`order-lifecycle`).
 */
const GEO_LIVE_ORDER = 'o.is_deleted = false AND o.deleted_at IS NULL';

/** oNAE3LW9 — `COUNT(*) FILTER` natijasi (pg bigint — matn bo'lib keladi). */
type GeoCountRow = {
  live: string | number | null;
  deleted: string | number | null;
};

const geoBadRequest = (message: string) =>
  new RpcException(errorRes(message, 400));

/** oNAE3LW9 — `deadline_at` o'tgan bo'lsa ko'chirish bajarilmaydi (409). */
function assertGeoDeadline(deadlineAt: number | null): void {
  if (deadlineAt !== null && Date.now() > deadlineAt) {
    throw new RpcException(
      errorRes(
        "Ko'chirish muddati o'tdi (logistics javobni kutmay qo'ydi) — bajarilmadi",
        409,
      ),
    );
  }
}

/** oNAE3LW9 — `reassignDistrict` kirishini tekshiradi va normallashtiradi. */
function parseGeoReassignInput(input: GeoReassignInput) {
  const from = String(input?.from_district_id ?? '').trim();
  const to = String(input?.to_district_id ?? '').trim();
  if (!GEO_ID_PATTERN.test(from) || !GEO_ID_PATTERN.test(to) || from === to) {
    throw geoBadRequest(
      "from_district_id va to_district_id majburiy va har xil bo'lishi kerak",
    );
  }
  const toRegionId = String(input?.to_region_id ?? '').trim() || null;
  const isId = (value: unknown) =>
    (typeof value === 'string' || typeof value === 'number') &&
    GEO_ID_PATTERN.test(String(value).trim());
  let ids: string[] | null = null;
  if (input?.ids !== undefined && input?.ids !== null) {
    if (!Array.isArray(input.ids) || !input.ids.every(isId)) {
      throw geoBadRequest("ids — musbat butun sonlar ro'yxati bo'lishi kerak");
    }
    ids = [...new Set(input.ids.map((value) => String(value).trim()))];
  }
  const restoreRegions: Array<{ region_id: string | null; ids: string[] }> = [];
  if (input?.restore_regions !== undefined && input?.restore_regions !== null) {
    if (!Array.isArray(input.restore_regions)) {
      throw geoBadRequest("restore_regions ro'yxat bo'lishi kerak");
    }
    for (const group of input.restore_regions) {
      const regionId = String(group?.region_id ?? '').trim() || null;
      if (
        (regionId !== null && !isId(regionId)) ||
        !Array.isArray(group?.ids) ||
        !group.ids.every(isId)
      ) {
        throw geoBadRequest("restore_regions elementi noto'g'ri");
      }
      restoreRegions.push({
        region_id: regionId,
        ids: group.ids.map((value) => String(value).trim()),
      });
    }
  }
  const deadline = Number(input?.deadline_at);
  const deadlineAt =
    Number.isFinite(deadline) && deadline > 0 ? deadline : null;
  return { from, to, toRegionId, ids, restoreRegions, deadlineAt };
}

/**
 * oNAE3LW9 — ko'chirish javobi: ko'chgan ID'lar, ularning ESKI `region_id`
 * guruhlari (kompensatsiya aynan tiklashi uchun) va ID rejimida topilmagan
 * (A da yo'q) ID'lar.
 */
/**
 * (vsmpTweI) Raw `live` ustuni (`boolean`; drayverga qarab `'t'`/`'true'`) —
 * qator o'chirilmaganmi.
 */
function geoRowLive(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

function geoReassignResult(
  req: { from: string; to: string; ids: string[] | null },
  rows: Array<{ id: string; region_id: string | null; live?: unknown }>,
) {
  const ids = rows.map((row) => String(row.id));
  const groups = new Map<string, { region_id: string | null; ids: string[] }>();
  for (const row of rows) {
    const regionId = row.region_id == null ? null : String(row.region_id);
    const key = regionId ?? '';
    const group = groups.get(key) ?? { region_id: regionId, ids: [] };
    group.ids.push(String(row.id));
    groups.set(key, group);
  }
  const movedSet = new Set(ids);
  return {
    from_district_id: req.from,
    to_district_id: req.to,
    moved: ids.length,
    // (vsmpTweI) ko'chganlardan TIRIK (o'chirilmagan) lari — logistics
    // birlashtirish natijasidagi «Ko'chirildi» (`moved_live`) shundan.
    moved_live: rows.filter((row) => geoRowLive(row.live)).length,
    ids,
    previous_regions: [...groups.values()],
    missing_ids: (req.ids ?? []).filter((id) => !movedSet.has(id)),
  };
}

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
    // 6kHnNH9j: `warehouse: { id, name, branch_id }` boyitishi (ixtiyoriy).
    @Optional() private readonly orderWarehouse?: OrderWarehouseService,
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
      id:
        typeof user.id === 'string' || typeof user.id === 'number'
          ? String(user.id)
          : null,
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

  /**
   * Ro'yxat tartibi. Saralashda ikkinchi kalit `order.id` — barqaror tartib.
   *
   * ⚠️ Holat CASE ifodasi `addSelect` + alias orqali saralanadi: skip/take
   * join bilan birga kelganda TypeORM DISTINCT ichki so'rov quradi va
   * orderBy'dagi xom ifodani u yerga ko'chira olmaydi, alias'ni esa ko'chiradi.
   */
  private applyOrderListSort(
    qb: SelectQueryBuilder<Order>,
    sort: OrderListSort | null,
  ) {
    if (!sort) {
      qb.orderBy('order.createdAt', 'DESC');
      qb.addOrderBy('order.id', 'DESC');
      return;
    }
    if (sort.field === 'status') {
      qb.addSelect(ORDER_STATUS_SORT_SQL, ORDER_STATUS_SORT_ALIAS).orderBy(
        ORDER_STATUS_SORT_ALIAS,
        sort.dir,
      );
    } else {
      qb.orderBy(
        sort.field === 'total_price' ? 'order.total_price' : 'order.createdAt',
        sort.dir,
      );
    }
    qb.addOrderBy('order.id', sort.dir);
  }

  private normalizePagination(
    page?: number,
    limit?: number,
    fetchAll?: boolean,
    maxLimit?: number,
  ) {
    const DEFAULT_LIMIT = 10;
    // Sukut 100; ichki chaqiruvchi (masalan tashqi posilkalar skan ekrani —
    // PEc4BjVX) 500 gacha ko'tara oladi.
    const MAX_LIMIT =
      Number.isFinite(Number(maxLimit)) && Number(maxLimit) > 100
        ? Math.min(Number(maxLimit), 500)
        : 100;
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
    source?: Order_source | string,
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
    /** Qidiruvdagi buyurtma raqami — mijoz qidiruvi bilan OR qilinadi. */
    search_order_id?: string;
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
    courier_scope?: 'any';
    courier_post_history?: boolean;
    courier_cancelled_tab?: boolean;
    include_courier_history?: boolean | string;
    region_id?: string;
    district_id?: string;
    branch_id?: string;
    source?: Order_source | 'internal' | 'external' | 'branch';
    exclude_sources?: Array<Order_source | 'internal' | 'external' | 'branch'>;
    /** 6kHnNH9j: `HQ` | `WAREHOUSE` (gateway tekshiradi). */
    fulfillment_source?: string;
    unbatched_only?: boolean;
    fetch_all?: boolean | string;
    fetchAll?: boolean | string;
    disable_pagination?: boolean;
    /** GET /orders saralashi — `parseOrderListSort` oq ro'yxati. */
    sort_by?: string;
    sort_dir?: string;
    page?: number;
    limit?: number;
    /** Ichki: sahifa yuqori chegarasi (sukut 100) — PEc4BjVX. */
    max_limit?: number;
  }) {
    const {
      market_id,
      customer_id,
      customer_ids,
      search_order_id,
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
      courier_scope,
      courier_post_history,
      courier_cancelled_tab,
      include_courier_history,
      region_id,
      district_id,
      branch_id,
      source,
      exclude_sources,
      fulfillment_source,
      unbatched_only,
      fetch_all,
      fetchAll,
      disable_pagination,
      sort_by,
      sort_dir,
      page,
      limit,
      max_limit,
    } = query;
    // So'rov qurilishidan OLDIN — noto'g'ri qiymat bazaga yetib bormaydi.
    const sort = parseOrderListSort(sort_by, sort_dir);

    const useFetchAll =
      fetch_all === true ||
      fetchAll === true ||
      String(fetch_all).toLowerCase() === 'true' ||
      String(fetchAll).toLowerCase() === 'true';
    const useCourierHistory =
      include_courier_history === true ||
      String(include_courier_history).toLowerCase() === 'true';

    const pagination = this.normalizePagination(
      page,
      limit,
      useFetchAll,
      max_limit,
    );
    const statusFilter = this.normalizeStatusFilter(status);
    const sourceFilter = this.normalizeSourceFilter(source);
    const excludeSourceFilters = (exclude_sources ?? [])
      .map((value) => this.normalizeSourceFilter(value))
      .filter((value): value is Order_source => Boolean(value));

    /**
     * ⚠️ JOIN'LAR ATAYLAB OXIRIDA QO'SHILADI (Scale 1 — o'lchov asosida).
     *
     * `getManyAndCount()` bitta qurilmadan ikkita so'rov yasaydi va join
     * bo'lsa hisobni `COUNT(DISTINCT order.id)` ko'rinishida quradi — ya'ni
     * `orders ⋈ order_items` ni to'liq skanerlab, takrorlarni yo'q qilishi
     * kerak bo'ladi. Produksiyada 501 000 buyurtmali bazada o'lchandi:
     *
     *     COUNT(DISTINCT ...) join bilan : 1 222 ms
     *     COUNT(*)            join'siz   :    43 ms
     *
     * Sahifaning O'ZI esa 74 ms. Ya'ni ro'yxat ekranining vaqtining 90% dan
     * ko'pi faqat "jami nechta" degan raqamga ketardi. Filtrlarning
     * BIRORTASI ham `items`/`branch` aliasiga tayanmaydi (tekshirilgan),
     * shuning uchun hisobni join'siz bajarish natijani o'zgartirmaydi.
     */
    const qb = this.orderRepo
      .createQueryBuilder('order')
      .where('order.isDeleted = :isDeleted', { isDeleted: false });

    if (market_id) {
      qb.andWhere('order.market_id = :market_id', { market_id });
    }
    if (search_order_id) {
      // Qidiruv: buyurtma raqami YOKI mos mijozlarning buyurtmalari. Boshqa
      // filtrlar (market, filial, status...) baribir AND bilan qo'llanadi.
      qb.andWhere(
        new Brackets((w) => {
          w.where('order.id = :search_order_id', { search_order_id });
          if (customer_ids?.length) {
            w.orWhere('order.customer_id IN (:...customer_ids)', {
              customer_ids,
            });
          }
        }),
      );
    } else if (customer_ids?.length) {
      qb.andWhere('order.customer_id IN (:...customer_ids)', { customer_ids });
    } else if (customer_id) {
      qb.andWhere('order.customer_id = :customer_id', { customer_id });
    }
    if (post_id) {
      qb.andWhere('order.post_id = :post_id', { post_id });
    }
    if (post_ids?.length && courier_scope !== 'any') {
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
    // 6kHnNH9j: «Ombordan» filtri. Noto'g'ri qiymat — 400 (bazaga yetmaydi).
    const fulfillmentFilter = String(fulfillment_source ?? '')
      .trim()
      .toUpperCase();
    if (fulfillmentFilter) {
      if (
        !(FULFILLMENT_SOURCES as readonly string[]).includes(fulfillmentFilter)
      ) {
        this.badRequest('fulfillment_source — HQ yoki WAREHOUSE');
      }
      qb.andWhere('order.fulfillment_source = :fulfillment_source', {
        fulfillment_source: fulfillmentFilter,
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
    const normalizedCourierIds = (courier_ids ?? [])
      .map((id) => String(id).trim())
      .filter(Boolean);
    const normalizedHolderCourierIds = (holder_courier_ids ?? [])
      .map((id) => String(id).trim())
      .filter(Boolean);
    // (9Rdi2gJF) Bekor tabida kuryer, ushlab turgan kuryer va eski pochta
    // doiralari bitta SQL OR bo'ladi; COUNT va sahifalash ham shu doirada.
    if (courier_scope === 'any') {
      if (!normalizedCourierIds.length && !normalizedHolderCourierIds.length) {
        this.badRequest('courier_scope requires a courier id');
      }
      if (
        courier_cancelled_tab &&
        (!normalizedCourierIds.length || !normalizedHolderCourierIds.length)
      ) {
        this.badRequest('courier_cancelled_tab requires both courier scopes');
      }
      qb.andWhere(
        new Brackets((nested) => {
          if (normalizedCourierIds.length) {
            nested.where('order.courier_id IN (:...courier_ids)', {
              courier_ids: normalizedCourierIds,
            });
          }
          if (normalizedHolderCourierIds.length) {
            nested.orWhere(
              'order.holder_courier_id IN (:...holder_courier_ids)',
              {
                holder_courier_ids: normalizedHolderCourierIds,
              },
            );
          }
          if (post_ids?.length) {
            nested.orWhere('order.post_id IN (:...post_ids)', { post_ids });
          }
          if (courier_post_history && normalizedCourierIds.length) {
            nested.orWhere(
              `EXISTS (
                SELECT 1 FROM "logistics_schema"."posts" courier_posts
                WHERE courier_posts.id = "order"."post_id"
                  AND courier_posts.courier_id IN (:...courier_ids)
              )`,
              { courier_ids: normalizedCourierIds },
            );
          }
        }),
      );
      if (courier_cancelled_tab) {
        qb.andWhere(
          new Brackets((nested) => {
            nested
              .where(
                `order.holder_type IS NULL AND (
                  (order.courier_id IS NULL AND order.holder_courier_id IS NULL)
                  OR order.courier_id IN (:...courier_ids)
                  OR order.holder_courier_id IN (:...holder_courier_ids)
                )`,
                {
                  courier_ids: normalizedCourierIds,
                  holder_courier_ids: normalizedHolderCourierIds,
                },
              )
              .orWhere(
                `order.holder_type NOT IN ('COURIER', 'BRANCH', 'HQ') AND (
                  order.courier_id IN (:...courier_ids)
                  OR order.holder_courier_id IN (:...holder_courier_ids)
                )`,
                {
                  courier_ids: normalizedCourierIds,
                  holder_courier_ids: normalizedHolderCourierIds,
                },
              )
              .orWhere(
                `order.holder_type = 'COURIER' AND (
                  order.courier_id IN (:...courier_ids)
                  OR order.holder_courier_id IN (:...holder_courier_ids)
                )`,
                {
                  courier_ids: normalizedCourierIds,
                  holder_courier_ids: normalizedHolderCourierIds,
                },
              )
              .orWhere(
                `order.holder_type IN ('BRANCH', 'HQ')
                  AND order.parent_order_id IS NOT NULL
                  AND order.canceled_post_id IS NULL`,
              );
          }),
        );
      }
    } else if (courier_ids?.length) {
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
    if (courier_scope !== 'any' && holder_courier_ids?.length) {
      if (normalizedHolderCourierIds.length) {
        qb.andWhere('order.holder_courier_id IN (:...holder_courier_ids)', {
          holder_courier_ids: normalizedHolderCourierIds,
        });
      }
    }
    // Sana filtri — Toshkent kuni, dashboard bilan AYNI qoida (SqVMuhKo).
    // Ilgari 'YYYY-MM-DD' UTC yarim tuni + server TZ'idagi setHours edi: prod
    // konteyner UTC'da, ya'ni "1-oktabr" Toshkentda 05:00 dan ertasi 04:59
    // gacha bo'lardi. To'liq ISO qiymat (analytics shunday yuboradi)
    // o'zgarishsiz ishlatiladi.
    const dayRange = tashkentDayRange(start_day, end_day);
    if (dayRange.start) {
      const startDate = dayRange.start;
      if (Number.isNaN(startDate.getTime())) {
        throw new RpcException({
          statusCode: 400,
          message: "start_day noto'g'ri sana formatida",
        });
      }
      qb.andWhere('order.createdAt >= :startDate', { startDate });
    }
    if (dayRange.end) {
      const endDate = dayRange.end;
      if (Number.isNaN(endDate.getTime())) {
        throw new RpcException({
          statusCode: 400,
          message: "end_day noto'g'ri sana formatida",
        });
      }
      qb.andWhere('order.createdAt <= :endDate', { endDate });
    }

    // Hisob join'lardan OLDIN nusxalanadi — shunda u oddiy `COUNT(*)`
    // bo'lib qoladi (yuqoridagi izohga qarang).
    const countQb = qb.clone();

    qb.leftJoinAndSelect('order.items', 'items').leftJoinAndSelect(
      'order.branch',
      'branch',
    );
    this.applyOrderListSort(qb, sort);
    if (disable_pagination) {
      qb.take(MAX_FETCH_ALL);
    } else {
      qb.skip((pagination.page - 1) * pagination.limit).take(pagination.limit);
    }

    let data: Order[];
    let total: number;
    try {
      [data, total] = await Promise.all([qb.getMany(), countQb.getCount()]);
    } catch (error) {
      this.handleDbError(error);
    }

    if (disable_pagination) {
      return { data, total, truncated: total > MAX_FETCH_ALL };
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
    fetch_all?: boolean | string;
    page?: number;
    limit?: number;
  }) {
    /**
     * ⚠️ ENRICH YO'LI (DL6FCdrh). Ilgari `findAll` chaqirilardi — u mijoz va
     * tuman relationlarini JOIN qilmaydi, natijada skanerlash ekranida mijoz
     * ismi va tumani '—' bo'lib qolardi (faqat xom customer_id/district_id
     * qaytardi). `findAllEnriched` mijoz (identity) + tuman ma'lumotini
     * qo'shadi — oddiy /orders sahifasi ishlatadigan AYNI yo'l.
     */
    return this.findAllEnriched({
      ...query,
      source: Order_source.EXTERNAL,
      // PEc4BjVX: skan ekrani butun qopni oladi (gateway limit=200 ga ruxsat beradi).
      max_limit: EXTERNAL_LIST_MAX_LIMIT,
    });
  }

  /**
   * 0d11ewk7 — kuryer tablari badge'i: «Kutilayotgan» / «Hammasi» /
   * «Bekor qilingan» sonlari BITTA so'rovda.
   *
   * ⚠️ Sonlar ro'yxat bilan AYNAN bir xil bo'lishi shart — shuning uchun
   * alohida COUNT SQL yozilmadi: har tab gateway'dagi GET
   * /orders/courier/orders yuboradigan AYNI `findAll` so'rovi bilan
   * (limit 1) sanaladi, `total` — o'sha `countQb.getCount()`:
   * - waiting   — post_ids + status WAITING;
   * - all       — post_ids, CREATED/NEW/RECEIVED/ON_THE_ROAD dan tashqari;
   * - cancelled — findCourierCancelledRows doirasi (9Rdi2gJF: kuryer /
   *   ushlab turgan kuryer / eski pochta, courier_cancelled_tab).
   * Pochtasi yo'q kuryer: waiting/all = 0 (ro'yxat ham bo'sh), cancelled —
   * baribir sanaladi (bekor tabi post_ids ga bog'liq emas).
   */
  async courierOrderCounts(payload: {
    courier_id?: string;
    post_ids?: string[];
  }): Promise<{ waiting: number; all: number; cancelled: number }> {
    const courierId = String(payload?.courier_id ?? '').trim();
    if (!/^\d+$/.test(courierId) || courierId === '0') {
      this.badRequest("courier_id noto'g'ri");
    }
    const postIds = [
      ...new Set(
        (Array.isArray(payload?.post_ids) ? payload.post_ids : [])
          .map((id) => String(id ?? '').trim())
          .filter((id) => /^\d+$/.test(id)),
      ),
    ];
    const countOf = async (query: Parameters<typeof this.findAll>[0]) =>
      Number((await this.findAll({ ...query, page: 1, limit: 1 })).total ?? 0);

    const [waiting, all, cancelled] = await Promise.all([
      postIds.length
        ? countOf({ post_ids: postIds, status: [Order_status.WAITING] })
        : 0,
      postIds.length
        ? countOf({
            post_ids: postIds,
            exclude_statuses: [
              Order_status.CREATED,
              Order_status.NEW,
              Order_status.RECEIVED,
              Order_status.ON_THE_ROAD,
            ],
          })
        : 0,
      countOf({
        status: [Order_status.CANCELLED],
        courier_ids: [courierId],
        holder_courier_ids: [courierId],
        courier_scope: 'any',
        courier_post_history: true,
        courier_cancelled_tab: true,
      }),
    ]);
    return { waiting, all, cancelled };
  }

  async findById(id: string, requester?: OrderLookupRequester | null) {
    let order: Order | null;
    try {
      order = await this.orderRepo.findOne({
        where: { id, isDeleted: false },
        relations: { items: true, branch: true },
      });
    } catch (error) {
      this.handleDbError(error);
    }
    // (3ZfiXuaW #3 / 5i3UZjiF #4) `requester` berilsa doira SERVER tomonda:
    // doiradan tashqari buyurtma "topilmadi" (mavjudligi ham oshkor emas).
    if (!order || (requester && !orderVisibleTo(order, requester))) {
      this.notFound(`Order #${id} topilmadi`);
    }
    return order;
  }

  /**
   * Dalil faylining EGASINI topadi (audit S5).
   *
   * ⚠️ NEGA KERAK. Fayl kaliti — o'zi bir "bearer" imkoniyat: kalitni bilgan
   * har kim signed URL so'ray olardi. Himoya faqat prefiks + rol evristikasi
   * edi, ya'ni bitta market boshqa marketning moliyaviy dalilini, bitta
   * kuryer boshqa kuryerning isbotini bemalol ochishi mumkin edi — rol
   * "market"/"courier" bo'lishining o'zi yetarli edi.
   *
   * Haqiqiy egalik munosabati allaqachon bazada bor: dalil fayllari
   * buyurtmaning `proof_files` ro'yxatida saqlanadi. Shu bois yangi jadval
   * kerak emas — kalit bo'yicha buyurtmani topib, so'rovchi o'sha buyurtmani
   * ko'rish huquqiga egami degan savolga javob beriladi.
   */
  async findOwnerByProofFile(key: string) {
    const objectKey = String(key ?? '').trim();
    if (!objectKey) {
      return successRes(null, 200, 'Proof file owner');
    }

    const order = await this.orderRepo
      .createQueryBuilder('order')
      .select([
        'order.id',
        'order.market_id',
        'order.courier_id',
        'order.holder_courier_id',
        'order.branch_id',
        'order.holder_branch_id',
        'order.home_branch_id',
      ])
      .where('order.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('order.proof_files @> :key::jsonb', {
        key: JSON.stringify([objectKey]),
      })
      .getOne();

    return successRes(
      order
        ? {
            order_id: String(order.id),
            market_id: order.market_id ? String(order.market_id) : null,
            courier_id: order.courier_id ? String(order.courier_id) : null,
            holder_courier_id: order.holder_courier_id
              ? String(order.holder_courier_id)
              : null,
            branch_id: order.branch_id ? String(order.branch_id) : null,
            holder_branch_id: order.holder_branch_id
              ? String(order.holder_branch_id)
              : null,
            home_branch_id: order.home_branch_id
              ? String(order.home_branch_id)
              : null,
          }
        : null,
      200,
      'Proof file owner',
    );
  }

  /**
   * oNAE3LW9 — hududni o'chirishdan OLDIN: shu tuman/viloyatga ishora qilgan
   * buyurtmalar soni. Buyurtmalar boshqa sxemada (FK yo'q) — ilgari tuman
   * o'chsa `order.district_id` mavjud bo'lmagan ID ga ishora qilib qolardi va
   * hudud kesimidagi hisobotlar buzilardi.
   *
   * oNAE3LW9 (2026-10-09 prod, 2-tur): `orders` — faqat O'CHIRILMAGAN
   * buyurtmalar (`is_deleted = false` VA `deleted_at IS NULL`), himoya faqat
   * shularga qaraydi. Ilgari o'chirilganlar ham sanalardi: TEST buyurtma
   * o'chirilgandan keyin ham tuman "1 ta buyurtma bor" deb 400 qaytarardi,
   * vaholanki o'chirilgan buyurtmani foydalanuvchi ko'rmaydi (404), ko'chira
   * olmaydi, hisobotlar ham uni sanamaydi (`order-analytics` —
   * `isDeleted = false`) — tumanni o'chirishning iloji qolmasdi.
   * O'chirilganlar alohida `deleted_orders` da qaytadi: logistics ularni
   * birlashtirishda ham ko'chiradi (`reassignDistrict`) va tasdiqlashda
   * (A bo'sh, B = eski B + ko'chgan) hisobga oladi. Ikkala son BITTA
   * so'rovda — bir xil holat ustida — olinadi.
   */
  async countGeoUsage(input: { district_id?: string; region_id?: string }) {
    const districtId = String(input?.district_id ?? '').trim();
    const regionId = String(input?.region_id ?? '').trim();
    if (!districtId && !regionId) {
      this.badRequest('district_id yoki region_id majburiy');
    }
    // `withDeleted` — `deleted_at` qo'yilgan qatorlar TypeORM tomonidan
    // avtomatik chiqarib tashlanmasin: ular `deleted_orders` da sanaladi.
    const qb = this.orderRepo
      .createQueryBuilder('o')
      .withDeleted()
      .select(`COUNT(*) FILTER (WHERE ${GEO_LIVE_ORDER})`, 'live')
      .addSelect(`COUNT(*) FILTER (WHERE NOT (${GEO_LIVE_ORDER}))`, 'deleted');
    if (districtId) {
      qb.where('o.district_id = :districtId', { districtId });
    } else {
      qb.where('o.region_id = :regionId', { regionId });
    }
    const orderCounts = await qb.getRawOne<GeoCountRow>();
    // oNAE3LW9: filiallararo jo'natmalar ham viloyatga bog'langan
    // (`branch_transfer_batches.target_region_id`, shu sxemada, FK yo'q) —
    // viloyat o'chsa ular ham mavjud bo'lmagan ID ga ishora qilib qolardi.
    // Tumanga bog'lanmagan (district ustuni yo'q) — tuman so'rovida 0.
    // O'chirilgan (is_deleted) jo'natmalar himoyada sanalmaydi — alohida.
    const batchCounts: GeoCountRow | undefined =
      !districtId && regionId
        ? await this.transferBatchRepo
            .createQueryBuilder('b')
            .select('COUNT(*) FILTER (WHERE b.is_deleted = false)', 'live')
            .addSelect('COUNT(*) FILTER (WHERE b.is_deleted = true)', 'deleted')
            .where('b.target_region_id = :regionId', { regionId })
            .getRawOne<GeoCountRow>()
        : undefined;
    return successRes(
      {
        district_id: districtId || null,
        region_id: regionId || null,
        orders: Number(orderCounts?.live ?? 0),
        deleted_orders: Number(orderCounts?.deleted ?? 0),
        transfer_batches: Number(batchCounts?.live ?? 0),
        deleted_transfer_batches: Number(batchCounts?.deleted ?? 0),
      },
      200,
      'Geo usage',
    );
  }

  /**
   * oNAE3LW9 — tumanlarni birlashtirish (logistics `mergeDistricts`):
   * buyurtmalar A → B tumaniga (va B ning viloyatiga). O'chirilganlari ham
   * (`is_deleted` / `deleted_at`) — `countGeoUsage` ning `orders` +
   * `deleted_orders` jamiga mos (oNAE3LW9 prod 2-tur).
   *
   * ID rejimi (`ids`): faqat shu qatorlar va faqat hali A da turganlari —
   * logistics KOMPENSATSIYASI (B → A); `restore_regions` bilan `region_id`
   * ham qator bo'yicha AYNAN eski qiymatiga qaytadi.
   *
   * BITTA tranzaksiyada: qatorlar `FOR UPDATE` bilan qulflanib ID va ESKI
   * `region_id` olinadi, so'ng aynan shu ID'lar yangilanadi. Javobdagi `ids`
   * + `previous_regions` bo'yicha logistics keyingi bosqich yiqilsa AYNAN
   * shu qatorlarni A ga qaytaradi (servislararo umumiy tranzaksiya yo'q).
   * `deadline_at` dan keyin ko'chirish bajarilmaydi (kech ko'chish yo'q).
   */
  async reassignDistrict(input: GeoReassignInput) {
    const req = parseGeoReassignInput(input);
    assertGeoDeadline(req.deadlineAt);
    let rows: Array<{ id: string; region_id: string | null; live?: unknown }>;
    try {
      rows = await this.orderRepo.manager.transaction(async (manager) => {
        if (req.ids && !req.ids.length) return [];
        // oNAE3LW9 (prod 2-tur): O'CHIRILGAN buyurtmalar ham ko'chadi — A
        // o'chgandan keyin ular mavjud bo'lmagan `district_id` ga ishora
        // qilib qolmasin. `is_deleted` lilar avvaldan ko'chardi, lekin
        // `deleted_at` lilarni TypeORM SELECT dan avtomatik chiqarardi —
        // `withDeleted` bo'lmasa ular A da yetim qolardi (logistics sanog'i
        // ham ularni ko'rmagani uchun tekshiruv buni ushlamasdi).
        const select = manager
          .getRepository(Order)
          .createQueryBuilder('t')
          .withDeleted()
          .select('t.id', 'id')
          .addSelect('t.region_id', 'region_id')
          // (vsmpTweI) tirikmi — `moved_live` uchun.
          .addSelect('(t.is_deleted = false AND t.deleted_at IS NULL)', 'live')
          .where('t.district_id = :from', { from: req.from });
        if (req.ids) {
          select.andWhere('t.id = ANY(:ids)', { ids: req.ids });
        }
        const locked = await select.setLock('pessimistic_write').getRawMany<{
          id: string;
          region_id: string | null;
          live: unknown;
        }>();
        const ids = locked.map((row) => String(row.id));
        if (!ids.length) return locked;
        await manager
          .createQueryBuilder()
          .update(Order)
          .set(
            req.toRegionId
              ? { district_id: req.to, region_id: req.toRegionId }
              : { district_id: req.to },
          )
          .where('id = ANY(:ids)', { ids })
          .execute();
        const movedSet = new Set(ids);
        for (const group of req.restoreRegions) {
          const groupIds = group.ids.filter((id) => movedSet.has(id));
          if (!groupIds.length) continue;
          await manager
            .createQueryBuilder()
            .update(Order)
            .set({ region_id: group.region_id })
            .where('id = ANY(:ids)', { ids: groupIds })
            .execute();
        }
        // Muddat COMMIT'dan OLDIN yana: logistics voz kechgan bo'lsa — rollback.
        assertGeoDeadline(req.deadlineAt);
        return locked;
      });
    } catch (error) {
      if (error instanceof RpcException) throw error;
      // Kutilmagan (DB) xato RpcException'ga o'raladi: aks holda RMQ xabarni
      // QAYTA navbatga qo'yadi va logistics kompensatsiya qilgandan keyin
      // ko'chirish takror bajarilib qolishi mumkin edi.
      throw new RpcException(
        errorRes(
          `Tuman bo'yicha ko'chirib bo'lmadi: ${
            error instanceof Error ? error.message : String(error)
          }`,
          503,
        ),
      );
    }
    return successRes(geoReassignResult(req, rows), 200, 'Orders reassigned');
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

  /**
   * D148eHMA — skaner uchun YENGIL javob (`order.find_by_qr_light`, gateway
   * `?view=light`). Maydonlar ro'yxati va sababi: `lookup/order-scan-light.view`.
   *
   * ⚠️ OPT-IN: `findByQrCode` / `findByQrCodeEnriched` O'ZGARMADI — mavjud
   * iste'molchilar (to'liq javobni kutadiganlar) sinmaydi. Qidiruv sharti
   * ham AYNI (`qr_code_token` + `isDeleted=false`), ya'ni yengil va to'liq
   * javob bir xil buyurtmani topadi.
   */
  async findByQrCodeLight(token: string) {
    const qrToken = typeof token === 'string' ? token : '';
    // Bo'sh token DB'ga bormaydi: TypeORM `undefined` shartni tashlab
    // yuboradi va IXTIYORIY buyurtmani qaytarishi mumkin edi.
    if (!qrToken.trim()) {
      this.notFound('Order not found');
    }
    let order: Order | null = null;
    try {
      order = await this.orderRepo.findOne({
        where: { qr_code_token: qrToken, isDeleted: false },
        select: ORDER_SCAN_LIGHT_SELECT,
        relations: { items: true },
      });
    } catch (error) {
      this.handleDbError(error);
    }
    if (!order) {
      this.notFound('Order not found');
    }
    // Nomlar (mijoz, market, tuman/viloyat, mahsulot) — to'liq javobdagi
    // AYNI manbadan; keyin faqat oq ro'yxatdagi maydonlar qoldiriladi.
    const enriched = await this.enrichOrders([order]);
    return successRes(
      toOrderScanLightView(enriched[0] ?? order),
      200,
      'Order by QR code (light)',
    );
  }

  /**
   * QOP (`external_batch_token`) bo'yicha a'zo posilkalarni qaytaradi (CyCV4XHR).
   *
   * NEGA KERAK. BeePost qopni BITTA yorliq bilan chiqaradi, lekin qop yorlig'i
   * ORD-/BTB- prefiksiz `external_batch_token` bo'lib keladi. Elchi skaneri uni
   * `order.find_by_qr` bilan izlardi va posilka emasligi uchun 404 olardi — qop
   * umuman TANILMASDI. Bu yo'l qop tokenini a'zo posilkalariga ochadi; qabul
   * qilishning O'ZI mavjud receive-scan kengaytmasi orqali davom etadi.
   *
   * Faqat qisqa, xavfsiz maydonlar qaytadi (mijoz PII EMAS) — ro'yxat qopni
   * tasdiqlash + qabul uchun yetarli; har bir posilkaning batafsil ma'lumoti
   * alohida ko'rinish tekshiruvidan (visibility) o'tadi.
   */
  async findBatchByExternalToken(token: string) {
    const t = String(token ?? '').trim();
    if (!t) {
      this.notFound('Batch not found');
    }
    let members: Order[] = [];
    try {
      members = await this.orderRepo.find({
        where: { external_batch_token: t, isDeleted: false },
        select: [
          'id',
          'qr_code_token',
          'status',
          'source',
          'external_batch_token',
        ],
        order: { createdAt: 'ASC' },
        take: 500,
      });
    } catch (error) {
      this.handleDbError(error);
    }
    if (!members.length) {
      this.notFound('Batch not found');
    }
    return successRes(
      {
        external_batch_token: t,
        is_external_batch: true,
        count: members.length,
        members,
      },
      200,
      'Batch by external token',
    );
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
          this.custody.describeTrackingAction(
            action,
            row.from_status,
            row.to_status,
          ),
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

  /**
   * Mijozga ko'rinadigan buyurtma raqami (chek + QR yorlig'i): "EL-" + (id +
   * 100000) — masalan id=81 → "EL-100081". Printer `#${order_number}` qo'shadi →
   * "#EL-100081". id'dan hosil qilinadi (migration shart emas), deterministik va
   * noyob. Noto'g'ri/bo'sh id → '' (yorliqda raqam ko'rsatilmaydi).
   */
  private formatOrderNumber(id: string | number | null | undefined): string {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return '';
    return 'EL-' + (n + 100000);
  }

  /**
   * BUYURTMA XULOSALARI id ro'yxati bo'yicha (tokhPLMP — integratsiya
   * posilkalar jadvali). Bitta sahifa (≤100) uchun BITTA so'rov: N+1 emas.
   *
   * ⚠️ Faqat jadvalga kerakli maydonlar — to'liq buyurtma, mahsulotlar va
   * market yozuvi (token/tarif) qaytarilmaydi.
   */
  async findSummariesByIds(ids: unknown) {
    const unique = Array.from(
      new Set(
        (Array.isArray(ids) ? ids : [])
          .map((id) =>
            typeof id === 'string' || typeof id === 'number'
              ? String(id).trim()
              : '',
          )
          .filter((id) => /^\d+$/.test(id)),
      ),
    ).slice(0, ORDER_SUMMARY_MAX_IDS);
    if (!unique.length) {
      return successRes([], 200, 'Order summaries');
    }

    const rows = await this.orderRepo.find({
      where: { id: In(unique), isDeleted: false },
    });
    const enriched = await this.enrichOrders(rows);
    const text = (value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : null;

    return successRes(
      enriched.map((order) => {
        const customer = (order.customer ?? {}) as {
          name?: unknown;
          phone_number?: unknown;
        };
        return {
          id: String(order.id),
          order_number: order.order_number,
          status: order.status,
          total_price: Number(order.total_price ?? 0),
          customer_name: text(customer.name),
          customer_phone: text(customer.phone_number),
          region_name: text(order.region?.name),
          district_name: text(order.district?.name),
        };
      }),
      200,
      'Order summaries',
    );
  }

  /** (xWsCAA5N) Haqiqiy kuryer id'si; `'0'` — filial/hudud pochtasi (kuryersiz). */
  private realCourierId(value: unknown): string | null {
    const id =
      typeof value === 'string' || typeof value === 'number'
        ? String(value).trim()
        : '';
    return /^\d+$/.test(id) && id !== '0' ? id : null;
  }

  /**
   * (xWsCAA5N) Pochta → kuryer id (`logistics_schema.posts.courier_id`).
   *
   * Bitta PK so'rovi (RMQ emas): natija identity so'rovidan OLDIN kerak —
   * RMQ ketma-ket ikkinchi aylanma beradi. Sxemalararo o'qish bu servisda
   * allaqachon bor (`findAll` → `courier_post_history`). Xato boyitishni
   * yiqitmaydi — kuryer `courier_id` bo'yicha qoladi.
   */
  private async loadPostCourierIds(
    postIds: string[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(postIds.filter((id) => /^\d+$/.test(id)))];
    if (!ids.length) return new Map();
    try {
      const rows: Array<{ id: unknown; courier_id: unknown }> =
        await this.dataSource.query(
          `SELECT "id"::text AS "id", "courier_id"::text AS "courier_id"
           FROM "logistics_schema"."posts"
           WHERE "id" = ANY($1::bigint[])`,
          [ids],
        );
      const result = new Map<string, string>();
      for (const row of rows ?? []) {
        const courierId = this.realCourierId(row?.courier_id);
        if (courierId) result.set(String(row.id), courierId);
      }
      return result;
    } catch (error) {
      this.logger.warn(
        `enrichOrders: pochta kuryerlarini o'qib bo'lmadi: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Map();
    }
  }

  /**
   * (xWsCAA5N) Kuryer xulosasi — `identity.user.find_by_ids` (tor select),
   * 500 talik bo'laklarda (identity shu chegarani qo'yadi). Javobga faqat
   * `{id, name, phone_number}` chiqadi. Xato — bo'sh xarita.
   */
  private async loadCourierSummaries(
    courierIds: string[],
  ): Promise<
    Map<
      string,
      { id: string; name: string | null; phone_number: string | null }
    >
  > {
    const result = new Map<
      string,
      { id: string; name: string | null; phone_number: string | null }
    >();
    if (!courierIds.length) return result;

    const chunks: string[][] = [];
    for (let i = 0; i < courierIds.length; i += 500) {
      chunks.push(courierIds.slice(i, i + 500));
    }
    const responses = await Promise.all(
      chunks.map((ids) =>
        rmqSend<{ data?: Array<Record<string, unknown>> }>(
          this.identityClient,
          { cmd: 'identity.user.find_by_ids' },
          { ids },
        ).catch(() => ({ data: [] })),
      ),
    );
    const text = (value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : null;
    for (const res of responses) {
      for (const user of Array.isArray(res?.data) ? res.data : []) {
        const id = this.realCourierId(user?.id);
        if (!id) continue;
        result.set(id, {
          id,
          name: text(user.name),
          phone_number: text(user.phone_number),
        });
      }
    }
    return result;
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

    // (xWsCAA5N) Kuryer: `order.courier_id`, bo'sh bo'lsa (bekor qilish
    // oqimi uni null qiladi) — buyurtma pochtasining kuryeri.
    const postCourierByPostId = await this.loadPostCourierIds(
      rows
        .filter((r) => !this.realCourierId(r.courier_id))
        .map((r) => String(r.post_id ?? '').trim()),
    );
    const courierIdOf = (row: Order): string | null =>
      this.realCourierId(row.courier_id) ??
      postCourierByPostId.get(String(row.post_id ?? '').trim()) ??
      null;
    const courierIds = [
      ...new Set(
        rows.map(courierIdOf).filter((id): id is string => Boolean(id)),
      ),
    ];

    const [
      marketsRes,
      customersRes,
      districtsRes,
      regionsRes,
      productsRes,
      couriers,
      warehouseRefs,
    ] = await Promise.all([
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
      this.loadCourierSummaries(courierIds),
      // 6kHnNH9j: faqat ombor buyurtmalari bo'lsa catalog'ga boriladi.
      this.orderWarehouse
        ? this.orderWarehouse.loadWarehouseRefs(
            rows.map((row) => row.warehouse_id),
          )
        : Promise.resolve(new Map<string, WarehouseRef>()),
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

    // (uguUEhin) Sotish oynasidagi «Marketga to'langan summa» chegarasi —
    // faqat sotiladigan (WAITING) buyurtmada; sotuvgacha `to_be_paid` 0 turadi.
    const saleMarketPaidMaxOf = (row: Order): number | null => {
      if (row.status !== Order_status.WAITING) return null;
      const market = row.market_id ? marketMap.get(row.market_id) : undefined;
      return computeSaleMarketPaidMax({
        totalPrice: row.total_price,
        paidOnlineAmount: row.paid_online_amount,
        paidAmount: row.paid_amount,
        marketTariffSnapshot: row.market_tariff,
        isCenter: row.where_deliver === Where_deliver.CENTER,
        centerTariff: market?.tariff_center as number | null | undefined,
        homeTariff: market?.tariff_home as number | null | undefined,
      });
    };

    return rows.map((row) => ({
      ...row,
      // Mijozga ko'rinadigan raqam (chek/ro'yxat/detal) — frontend shuni ko'rsatadi.
      order_number: this.formatOrderNumber(row.id),
      sale_market_paid_max: saleMarketPaidMaxOf(row),
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
      // (xWsCAA5N) Faqat {id, name, phone_number} — maosh/tarif/login yo'q.
      courier: (() => {
        const courierId = courierIdOf(row);
        return courierId ? (couriers.get(courierId) ?? null) : null;
      })(),
      items: (row.items ?? []).map((item) => ({
        ...item,
        product: item.product_id
          ? (productMap.get(item.product_id) ?? null)
          : null,
      })),
      // 6kHnNH9j: `fulfillment_source` — ustun (HQ | WAREHOUSE); ombor — ref.
      warehouse: warehouseRefOf(row, warehouseRefs),
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
    courier_scope?: 'any';
    courier_post_history?: boolean;
    courier_cancelled_tab?: boolean;
    include_courier_history?: boolean | string;
    region_id?: string;
    district_id?: string;
    sort_by?: string;
    sort_dir?: string;
    // `source`/`fetch_all` — tashqi (EXTERNAL) posilkalar ro'yxati uchun
    // (findAllExternal shu yo'lni ishlatadi, DL6FCdrh). findAll ularni
    // qo'llab-quvvatlaydi; bu yerda faqat tip ochiladi.
    source?: Order_source | 'internal' | 'external' | 'branch';
    /** 6kHnNH9j: HQ | WAREHOUSE — `findAll` ga o'tadi. */
    fulfillment_source?: string;
    fetch_all?: boolean | string;
    disable_pagination?: boolean;
    page?: number;
    limit?: number;
    max_limit?: number;
  }) {
    const { search, ...orderQuery } = query;
    const trimmedSearch = search?.trim() ?? '';

    // Qidiruv: (1) mijoz ismi/telefoni — identity-service orqali; (2) buyurtma
    // raqami (id). Ilgari faqat (1) bor edi va raqam bilan hech narsa
    // topilmasdi.
    let customer_ids: string[] | undefined;
    let search_truncated = false;
    const search_order_id = parseOrderNumberSearch(trimmedSearch);
    if (trimmedSearch) {
      // Bittasini ortiqcha so'raymiz: chegaradan oshgani shundan bilinadi.
      // Ilgari 1000 tadan keyingi mijozlar JIMGINA tushib qolardi.
      const searchRes = await rmqSend<{ data: Array<{ id: string }> }>(
        this.identityClient,
        { cmd: 'identity.customer.search' },
        { search: trimmedSearch, limit: CUSTOMER_SEARCH_LIMIT + 1 },
      ).catch(() => ({ data: [] }));

      const ids = (searchRes?.data ?? []).map((c) => String(c.id));
      search_truncated = ids.length > CUSTOMER_SEARCH_LIMIT;
      customer_ids = ids.slice(0, CUSTOMER_SEARCH_LIMIT);
      if (!customer_ids.length && !search_order_id) {
        const pagination = this.normalizePagination(query.page, query.limit);
        return {
          data: [],
          total: 0,
          page: pagination.page,
          limit: pagination.limit,
          total_pages: 0,
          totalPages: 0,
          search_truncated,
        };
      }
    }

    const result = await this.findAll({
      ...orderQuery,
      customer_ids,
      search_order_id: search_order_id ?? undefined,
    });
    const enriched = await this.enrichOrders(result.data);

    return {
      data: enriched,
      total: result.total,
      page: result.page,
      limit: result.limit,
      total_pages: result.total_pages ?? 0,
      totalPages: result.totalPages ?? result.total_pages ?? 0,
      search_truncated,
      ...(result.truncated === undefined
        ? {}
        : { truncated: result.truncated }),
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

  /**
   * KIRUVCHI POSILKALARNING MANBALARI — qabul qilishni kutayotgan tashqi
   * buyurtmalar manba bo'yicha guruhlangan.
   *
   * NEGA KERAK BO'LDI. "Kiruvchi posilkalar" ekrani BARCHA tashqi buyurtmani
   * bitta ro'yxatda ko'rsatardi. Amalda faqat bitta hamkor (BeePost) yuborgani
   * uchun ekran o'sha hamkorga moslangandek ko'rinardi, lekin ikkinchi manba
   * qo'shilishi bilan ikki xil joydan kelgan posilkalar aralashib ketardi:
   * operator qo'lida BeePost qopi turib, ro'yxatda Uzum posilkasini ham
   * ko'rardi va qaysi biri qo'lida borligini faqat skanerlab bilardi.
   *
   * Endi avval MANBA tanlanadi, keyin o'sha manbaning posilkalari skanerlanadi.
   *
   * ⚠️ GURUHLASH KALITI — `market_id`, va bu tasodif emas: hamkor posilka
   * yaratganda `elchi_market_id` MAJBURIY (`createPartnerShipment`), ya'ni
   * Elchi modelida kiruvchi buyurtma aynan shu marketning buyurtmasi bo'ladi
   * va puli ham shu marketga hisoblanadi. Buyurtma yozuvida "qaysi tashqi
   * tizimdan keldi" degan alohida maydon YO'Q (`source` faqat
   * internal/external/branch, hamkor buyurtmalarida `operator` esa null).
   *
   * ⚠️ CHEKLOV — AGAR ikki hamkor AYNI Elchi marketiga bog'langan bo'lsa,
   * ular bu ro'yxatda BITTA guruh bo'lib ko'rinadi. Hozircha bunday sozlama
   * yo'q; aniq hamkor bog'lanishi `partner_shipment_ref` da va uni bu yerda
   * ishlatish integration-service'ga cross-schema so'rov talab qiladi (order
   * service faqat o'z sxemasidan o'qiydi). Qabul skaneri ishida bu aniq
   * bog'lanish qo'shiladi — reja: docs/integrations/08-qabul-skaneri.md.
   *
   * `oldest_at` — eng eski kutayotgan posilka sanasi. Uni qo'shdim, chunki
   * unutilib qolgan manba aks holda hech qayerda ko'rinmaydi: soni kichik
   * bo'lsa ro'yxat oxirida turib e'tibordan chetda qolardi.
   */
  async findExternalSources(branch_id?: string) {
    const qb = this.orderRepo
      .createQueryBuilder('order')
      .select('order.market_id', 'market_id')
      .addSelect('COUNT(order.id)', 'orders_count')
      .addSelect('COALESCE(SUM(order.total_price), 0)', 'total_price_sum')
      .addSelect('MIN(order.createdAt)', 'oldest_at')
      .where('order.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('order.status = :status', { status: Order_status.NEW })
      .andWhere('order.source = :source', { source: Order_source.EXTERNAL })
      // Pochtaga qo'shilgan posilka qabul qilishni kutmaydi — `findNewMarkets`
      // bilan ayni shart, aks holda ikki ekran boshqa son ko'rsatardi.
      .andWhere('order.current_batch_id IS NULL')
      .groupBy('order.market_id')
      .orderBy('orders_count', 'DESC');

    if (branch_id) {
      qb.andWhere('order.branch_id = :branch_id', { branch_id });
    }

    let rows: Array<{
      market_id: string;
      orders_count: string;
      total_price_sum: string;
      oldest_at: Date | null;
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
      oldest_at: row.oldest_at ? new Date(row.oldest_at).toISOString() : null,
    }));
  }

  /** Yuqoridagi ro'yxat + market nomlari (ekranda nom ko'rsatiladi). */
  async findExternalSourcesEnriched(branch_id?: string) {
    const rows = await this.findExternalSources(branch_id);
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

    /**
     * Nom topilmasa ham qator TUSHIB QOLMAYDI (`market: null`). Posilkalar
     * haqiqatan kutib turadi — nomi yechilmagani uchun ularni yashirish
     * qabul qilishni imkonsiz qilardi va sababi ko'rinmasdi.
     */
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
      truncated: result.truncated,
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

    if (Array.isArray(payload.items)) {
      // (52NJNGaH) Ilgari `String(item.product_id)` tashqi (katalogsiz) satrni
      // "null"/"undefined" matniga aylantirar va `product_name` ni tashlab
      // yuborardi. Endi null saqlanadi, nom uzatiladi; to'liq tekshiruv —
      // `updateFull` (normalizeReplacementItems).
      payload.items = payload.items.map((item: any) => ({
        product_id:
          item?.product_id === null ||
          typeof item?.product_id === 'undefined' ||
          String(item.product_id).trim() === ''
            ? null
            : String(item.product_id).trim(),
        product_name:
          typeof item?.product_name === 'string' ? item.product_name : null,
        quantity: item?.quantity ?? 1,
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
          // Chek + QR yorlig'ida mijozga ko'rinadigan raqam: #EL-100081
          // (ilgari xom tartib raqam — #81). Vertikal QR-yonidagi ko'rinish ham
          // shu qiymatni oladi (printer.util order-no-v / aylantirilgan matn).
          order_number: this.formatOrderNumber(order.id),
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
          // VRyloH62: chekdagi "Muammo bo'lsa" — 1- va 2-operator raqami.
          operator_phone: order.operator_phone ?? '',
          secondary_operator_phone: order.secondary_operator_phone ?? '',
          products: (order.items ?? []).map((i) => ({
            name: productMap.get(String(i.product_id))?.name ?? 'N/A',
            quantity: i.quantity ?? 1,
          })),
        };
      });

    return successRes(rows, 200);
  }
}

/**
 * `order.find_by_id` ning ixtiyoriy so'rovchisi (bot / ichki chaqiruvchi).
 * Gateway HTTP yo'li o'z `assertCanViewOrder` iga ega; bu — RMQ orqali
 * to'g'ridan-to'g'ri o'qiydiganlar uchun bir xil qoida.
 */
export interface OrderLookupRequester {
  id?: string | number | null;
  roles?: string[] | null;
  market_id?: string | number | null;
}

/**
 * Doira (gateway assertCanViewOrder bilan bir xil asosiy qoidalar):
 * superadmin/admin — hammasi; market — o'z `market_id`; market operatori —
 * biriktirilgan market; kuryer — `courier_id` yoki `holder_courier_id`;
 * boshqa rollar — yo'q (fail-closed).
 */
export function orderVisibleTo(
  order: {
    market_id?: unknown;
    courier_id?: unknown;
    holder_courier_id?: unknown;
  },
  requester: OrderLookupRequester,
): boolean {
  const roles = (requester.roles ?? []).map((role) =>
    String(role).toLowerCase(),
  );
  const text = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  const id = text(requester.id);
  if (roles.includes('superadmin') || roles.includes('admin')) return true;
  if (roles.includes('market')) return !!id && text(order.market_id) === id;
  if (roles.includes('market_operator')) {
    const marketId = text(requester.market_id);
    return !!marketId && text(order.market_id) === marketId;
  }
  if (roles.includes('courier')) {
    return (
      !!id &&
      (text(order.courier_id) === id || text(order.holder_courier_id) === id)
    );
  }
  return false;
}
