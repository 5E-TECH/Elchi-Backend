import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { FindOptionsWhere, In, IsNull, Not, Repository } from 'typeorm';
import { lastValueFrom, timeout } from 'rxjs';
import { Post } from './entities/post.entity';
import { Region } from './entities/region.entity';
import { District } from './entities/district.entity';
import { regions } from './data/regions-districts.data';
import { CreateDistrictDto } from './dto/create-district.dto';
import { UpdateDistrictDto } from './dto/update-district.dto';
import { UpdateDistrictNameDto } from './dto/update-district-name.dto';
import { UpdateDistrictSatoCodeDto } from './dto/update-district-sato-code.dto';
import { CreateRegionDto } from './dto/create-region.dto';
import { UpdateRegionDto } from './dto/update-region.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { ReceivePostDto } from './dto/receive-post.dto';
import { SendPostDto } from './dto/send-post.dto';
import { PostIdDto } from './dto/post-id.dto';
import { errorRes, successRes } from '../../../libs/common/helpers/response';
import { matchDistricts } from './utils/sato-matcher';
import { assessHqCourierScan } from './utils/scan-assign-eligibility';
import { LogisticsNotificationService } from './notification/logistics-notification.service';
import {
  ActivityAction,
  ActivityLogService,
  ActivityLogQuery,
  BranchType,
  Order_status,
  Post_status,
  Roles,
  Status,
  Where_deliver,
} from '@app/common';

interface RequesterContext {
  id: string;
  roles?: string[];
  branch_id?: string | null;
  note?: string | null;
}

interface OrderRow {
  id: string;
  total_price?: number;
  status?: Order_status;
  return_requested?: boolean;
  post_id?: string | null;
  canceled_post_id?: string | null;
  branch_id?: string | null;
  holder_type?: 'HQ' | 'BRANCH' | 'COURIER' | null;
  holder_branch_id?: string | null;
  holder_courier_id?: string | null;
  courier_id?: string | null;
  assigned_at?: string | Date | null;
  region_id?: string | null;
  district_id?: string | null;
  customer_id?: string;
  where_deliver?: Where_deliver;
  qr_code_token?: string | null;
  current_batch_id?: string | null;
  // order-service Order_source: 'internal' | 'external' | 'branch'.
  source?: string | null;
}

interface CourierRow {
  id: string;
  region_id?: string | null;
  role?: string;
}

interface BranchAssignmentRow {
  branch_id?: string | null;
  role?: string | null;
}

/**
 * Pochta → Qaytarish ko'rinish doirasi. `branchId` — so'rovlarni ko'rib
 * chiqadigan ombor (HQ doirasida u HQ ning o'zi).
 */
type ReturnRequestScope = {
  type: 'HQ' | 'BRANCH';
  branchId: string;
  hqBranchId: string;
};

/**
 * Kuryer qaytarish so'rovi holatlari. WAITING — eski (PCS) oqim; ON_THE_ROAD —
 * yagona web-manba: kuryer pochtani qisman qabul qilganda qolgan buyurtmalar
 * `ON_THE_ROAD + return_requested` bo'lib qoladi (receivePost).
 */
const RETURN_REQUEST_STATUSES: Order_status[] = [
  Order_status.WAITING,
  Order_status.ON_THE_ROAD,
];

/** findOrders ning odatiy order.find_all kutish vaqti. */
const FIND_ORDERS_TIMEOUT_MS = 5000;

/**
 * CODE-10 — Qaytarish tasdiqlash/rad etishda bir vaqtda yuboriladigan
 * order.update soni. Har bir chaqiruv alohida buyurtma (order-service da
 * alohida tranzaksiya), shuning uchun parallel xavfsiz; chegara order-service
 * ni bosib qo'ymaslik uchun.
 */
const RETURN_REQUEST_UPDATE_CONCURRENCY = 5;

/**
 * logistics.post.open_return_posts_for_courier: har bir pochtaning
 * order.find_all kutish vaqti. Chaqiruvchi (branch-service loadCourierHoldings)
 * 5000 ms kutadi — bitta DB so'rovi + parallel 3500 ms chaqiruvlar shu
 * byudjetga sig'adi (har bir qatlam o'zidan pastdagidan uzoqroq kutadi).
 */
const OPEN_RETURN_POSTS_ORDER_TIMEOUT_MS = 3500;
const OPEN_RETURN_POSTS_UNAVAILABLE_MESSAGE =
  "Bekor qilingan pochtalarni tekshirib bo'lmadi — birozdan so'ng qayta urinib ko'ring";

/**
 * (dzyVftBx) Viloyatga logist biriktirishda identity tekshiruvi. Identity
 * javob bermasa — fail-closed: tekshirilmagan id viloyatga yozilmaydi.
 */
const LOGIST_CHECK_TIMEOUT_MS = 5000;
export const LOGIST_CHECK_UNAVAILABLE_MESSAGE =
  "Logistni tekshirib bo'lmadi — viloyat o'zgarmadi. Birozdan so'ng qayta urinib ko'ring";
export const LOGIST_NOT_FOUND_MESSAGE = 'Logist topilmadi';
export const LOGIST_INACTIVE_MESSAGE =
  "Logist faol emas (bloklangan) — viloyatga biriktirib bo'lmaydi";

const PG_BIGINT_MAX = BigInt('9223372036854775807');

/**
 * (dzyVftBx) bigint id'ning kanonik ko'rinishi ('05' → '5') yoki `null`
 * (raqam emas, 0 yoki Postgres bigint'dan katta — aks holda 22P02/22003 →
 * 500 bo'lardi).
 */
function canonicalBigintId(value: unknown): string | null {
  let raw = '';
  if (typeof value === 'string') {
    raw = value.trim();
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    raw = String(value);
  }
  if (!/^\d{1,19}$/.test(raw)) {
    return null;
  }
  const parsed = BigInt(raw);
  if (parsed <= BigInt(0) || parsed > PG_BIGINT_MAX) {
    return null;
  }
  return parsed.toString();
}

/**
 * oNAE3LW9 — tuman/viloyat boshqa servislarda qayerda ishlatilyapti (FK yo'q —
 * har biri o'z sxemasida, RPC bilan sanaladi).
 */
type GeoUsage = {
  orders: number;
  users: number;
  branches: number;
  /** `order_schema.branch_transfer_batches.target_region_id` — faqat viloyat. */
  transfer_batches: number;
};
type GeoMoveKind = 'orders' | 'users' | 'branches';
type GeoMoveStep = {
  kind: GeoMoveKind;
  /** "5 ta buyurtma" */
  label: string;
  /** "buyurtmalar ko'chirilmadi" */
  plural: string;
  client: ClientProxy;
  cmd: string;
};
/** Bitta servis ko'chirgan qatorlar — kompensatsiya AYNAN shularni qaytaradi. */
type GeoMoved = {
  ids: string[];
  previous_regions: Array<{ region_id: string | null; ids: string[] }>;
};
/** Kompensatsiyadan keyin ham A ga qaytmagan qatorlar (qo'lda tuzatish). */
type GeoStranded = {
  kind: GeoMoveKind;
  /** Qatorlar hozir turgan tuman (B); `null` — aniqlanmadi. */
  district_id: string | null;
  /** `null` — ID'lar noma'lum (javob kelmagan bosqich). */
  ids: string[] | null;
  reason: string;
};
/** Ko'chirish/kompensatsiya RPC'si uchun vaqt chegarasi. */
const GEO_MOVE_TIMEOUT_MS = 15000;
/** Xato matnida har tur uchun ko'rsatiladigan ID'lar soni (to'liq ro'yxat — activity log). */
const GEO_STRANDED_PREVIEW = 50;

/** oNAE3LW9 — birlashtirish tekshiruvi mos kelmadi (logistics tranzaksiyasi rollback). */
class GeoMergeCheckError extends Error {}

@Injectable()
export class LogisticsServiceService implements OnModuleInit {
  private readonly logger = new Logger(LogisticsServiceService.name);

  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    @InjectRepository(Region) private readonly regionRepo: Repository<Region>,
    @InjectRepository(District)
    private readonly districtRepo: Repository<District>,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('SEARCH') private readonly searchClient: ClientProxy,
    private readonly activityLog: ActivityLogService,
    // (ePpLHPX2) Pochta filialga qabul qilindi → bildirishnoma (FAQAT outbox,
    // pochta holati yozuvi bilan bitta tranzaksiyada). Ixtiyoriy: eski
    // spec'lar servisni 8 argument bilan quradi — u holda bildirishnoma yo'q.
    @Optional()
    private readonly logisticsNotifications?: LogisticsNotificationService,
  ) {}

  /**
   * Normalise the RMQ `requester` payload into the actor fields the
   * activity-log expects. user_id + role pair is enough to attribute every
   * action; user_name is resolved by the gateway during enrichment.
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

  private notFound(message: string): never {
    throw new RpcException(errorRes(message, 404));
  }

  private badRequest(message: string): never {
    throw new RpcException(errorRes(message, 400));
  }

  private forbidden(message: string): never {
    throw new RpcException(errorRes(message, 403));
  }

  private conflict(message: string): never {
    throw new RpcException(errorRes(message, 409));
  }

  private getOrderBranchScope(order: {
    holder_branch_id?: string | null;
    branch_id?: string | null;
  }): string {
    return String(order?.holder_branch_id ?? order?.branch_id ?? '').trim();
  }

  private isSystemPrivileged(requester?: RequesterContext): boolean {
    const roles = (requester?.roles ?? []).map((role) =>
      String(role ?? '').toLowerCase(),
    );
    return roles.includes(Roles.SUPERADMIN) || roles.includes(Roles.ADMIN);
  }

  private async resolveScopedBranchId(
    requester?: RequesterContext,
  ): Promise<string | null> {
    if (this.isSystemPrivileged(requester)) {
      return null;
    }

    const jwtBranchId = String(requester?.branch_id ?? '').trim();
    if (jwtBranchId) {
      return jwtBranchId;
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Foydalanuvchi aniqlanmadi');
    }

    const assignment = await this.findBranchAssignmentByUserId(requesterId, {
      id: requesterId,
      roles: requester?.roles ?? [],
    });
    const branchId = String(assignment?.branch_id ?? '').trim();
    if (!branchId) {
      this.forbidden('Foydalanuvchi branchga biriktirilmagan');
    }
    return branchId;
  }

  private generateToken(): string {
    return `POST-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async syncPostToSearch(post: Post): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.upsert' },
            {
              source: 'logistics',
              type: 'post',
              sourceId: post.id,
              title: `Post #${post.id}`,
              content: [
                post.qr_code_token,
                post.region_id,
                post.courier_id,
                post.status,
              ]
                .filter(Boolean)
                .join(' '),
              tags: ['logistics', 'post', post.status].filter(Boolean),
              metadata: {
                region_id: post.region_id,
                courier_id: post.courier_id,
                order_quantity: post.order_quantity,
                post_total_price: post.post_total_price,
                status: post.status,
              },
            },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.upsert (post ${post.id}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async removePostFromSearch(post: Post): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.remove' },
            { source: 'logistics', type: 'post', sourceId: post.id },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.remove (post ${post.id}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async syncRegionToSearch(region: Region): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.upsert' },
            {
              source: 'logistics',
              type: 'region',
              sourceId: region.id,
              title: region.name,
              content: region.sato_code,
              tags: ['logistics', 'region'],
              metadata: {
                sato_code: region.sato_code,
              },
            },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.upsert (region ${region.id}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async removeRegionFromSearch(region: Region): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.remove' },
            { source: 'logistics', type: 'region', sourceId: region.id },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.remove (region ${region.id}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async syncDistrictToSearch(district: District): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.upsert' },
            {
              source: 'logistics',
              type: 'district',
              sourceId: district.id,
              title: district.name,
              content: [
                district.sato_code,
                district.region_id,
                district.assigned_region,
              ]
                .filter(Boolean)
                .join(' '),
              tags: ['logistics', 'district'],
              metadata: {
                sato_code: district.sato_code,
                region_id: district.region_id,
                assigned_region: district.assigned_region,
              },
            },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.upsert (district ${district.id}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async removeDistrictFromSearch(district: District): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.remove' },
            { source: 'logistics', type: 'district', sourceId: district.id },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.remove (district ${district.id}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async findOrderById(id: string): Promise<OrderRow> {
    try {
      return await lastValueFrom(
        this.orderClient
          .send({ cmd: 'order.find_by_id' }, { id })
          .pipe(timeout(5000)),
      );
    } catch (error) {
      const downstreamError =
        error instanceof RpcException ? error.getError() : error;
      if (
        downstreamError &&
        typeof downstreamError === 'object' &&
        Number((downstreamError as { statusCode?: number }).statusCode) >= 400
      ) {
        throw new RpcException(downstreamError);
      }
      throw new RpcException(errorRes(`Order #${id} lookup failed`, 502));
    }
  }

  private normalizeOrderStatus(status?: Order_status | string | null): string {
    return String(status ?? '')
      .trim()
      .toLowerCase()
      .replaceAll('_', ' ')
      .replace('canceled', 'cancelled');
  }

  private isCancelledOrder(status?: Order_status | string | null): boolean {
    return this.normalizeOrderStatus(status) === Order_status.CANCELLED;
  }

  private isCancelledSentOrder(status?: Order_status | string | null): boolean {
    const normalizedStatus = this.normalizeOrderStatus(status);
    return (
      normalizedStatus === Order_status.CANCELLED_SENT ||
      normalizedStatus === 'cancelled sent'
    );
  }

  private isCancelledPostEligibleOrder(
    status?: Order_status | string | null,
  ): boolean {
    return this.isCancelledOrder(status) || this.isCancelledSentOrder(status);
  }

  private isCancelledOrderOwnedByCourier(
    order: OrderRow,
    courierId: string,
    branchId: string,
  ): boolean {
    const requesterCourierId = String(courierId).trim();
    const holderCourierId = String(order.holder_courier_id ?? '').trim();
    const assignedCourierId = String(order.courier_id ?? '').trim();
    const holderType = String(order.holder_type ?? '')
      .trim()
      .toUpperCase();

    if (holderCourierId) {
      return (
        holderCourierId === requesterCourierId &&
        (!holderType || holderType === 'COURIER')
      );
    }

    if (assignedCourierId !== requesterCourierId) return false;
    if (holderType && holderType !== 'COURIER') return false;

    const orderBranchId = this.getOrderBranchScope(order);
    return !orderBranchId || orderBranchId === String(branchId);
  }

  private isActiveCanceledPostForTarget(
    post: Post | null | undefined,
    courierId: string,
    branchId: string,
  ): post is Post {
    return (
      !!post &&
      String(post.status) === Post_status.CANCELED &&
      String(post.courier_id) === String(courierId) &&
      String(post.branch_id) === String(branchId)
    );
  }

  private async isOrderInActiveCanceledPost(
    order: OrderRow,
    activePost: Post | null,
    courierId: string,
    branchId: string,
  ): Promise<boolean> {
    if (!this.isCancelledSentOrder(order.status) || !order.canceled_post_id) {
      return false;
    }

    if (
      activePost &&
      String(order.canceled_post_id) === String(activePost.id)
    ) {
      return this.isActiveCanceledPostForTarget(
        activePost,
        courierId,
        branchId,
      );
    }

    const existingPost = await this.postRepo.findOne({
      where: {
        id: order.canceled_post_id,
        status: Post_status.CANCELED,
      },
    });

    return this.isActiveCanceledPostForTarget(
      existingPost,
      courierId,
      branchId,
    );
  }

  private shouldRepairCanceledPostOrderHolder(
    order: OrderRow,
    branchId: string,
  ): boolean {
    if (String(order.branch_id ?? '') !== String(branchId)) return true;
    if (order.courier_id) return true;
    if (order.holder_type && order.holder_type !== 'BRANCH') return true;
    if (String(order.holder_branch_id ?? '') !== String(branchId)) {
      return true;
    }
    if (order.holder_courier_id) return true;
    return false;
  }

  private async findOrders(
    query: {
      post_id?: string;
      post_ids?: string[];
      canceled_post_id?: string;
      status?: Order_status | Order_status[] | string | string[];
      return_requested?: boolean;
      // order.find_all o'zi filtrlaydi (order.holder_type = :holder_type).
      holder_type?: 'HQ' | 'BRANCH' | 'COURIER';
      customer_id?: string;
      qr_code_token?: string;
      start_day?: string;
      end_day?: string;
      fetch_all?: boolean;
      page?: number;
      limit?: number;
    },
    // Byudjeti tor chaqiruvchi o'z kutish vaqtini beradi; berilmasa — odatiy
    // FIND_ORDERS_TIMEOUT_MS (boshqa chaqiruvchilar uchun o'zgarmaydi).
    options?: { timeoutMs?: number },
  ): Promise<OrderRow[]> {
    try {
      const requestedLimit = Number(query.limit ?? 100);
      const allowedLimits = [10, 25, 50, 100];
      const normalizedLimit = allowedLimits.includes(requestedLimit)
        ? requestedLimit
        : 100;

      const useFetchAll = query.fetch_all === true || requestedLimit > 100;

      const res = await lastValueFrom(
        this.orderClient
          .send(
            { cmd: 'order.find_all' },
            {
              query: {
                ...query,
                fetch_all: useFetchAll,
                page: query.page ?? 1,
                limit: normalizedLimit,
              },
            },
          )
          .pipe(timeout(options?.timeoutMs ?? FIND_ORDERS_TIMEOUT_MS)),
      );

      // Support multiple RMQ response shapes:
      // 1) { statusCode, message, data: { data: OrderRow[], ... } }
      // 2) { statusCode, message, data: OrderRow[] }
      // 3) { data: { data: OrderRow[], ... } } or { data: OrderRow[] }
      // 4) OrderRow[]
      const candidates = [
        res?.data?.data?.data,
        res?.data?.data,
        res?.data,
        res,
      ];

      for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
          return candidate;
        }
        if (
          candidate &&
          Array.isArray((candidate as { data?: unknown }).data)
        ) {
          return (candidate as { data: OrderRow[] }).data;
        }
      }

      throw new RpcException(
        errorRes('Order service returned an invalid order list', 502),
      );
    } catch (error) {
      const downstreamError =
        error instanceof RpcException ? error.getError() : error;
      if (
        downstreamError &&
        typeof downstreamError === 'object' &&
        Number((downstreamError as { statusCode?: number }).statusCode) >= 400
      ) {
        throw new RpcException(downstreamError);
      }
      throw new RpcException(errorRes('Order list request failed', 502));
    }
  }

  private async findCanceledPostGroup(sourcePost: Post): Promise<{
    posts: Post[];
    orders: OrderRow[];
  }> {
    const candidatePosts = await this.postRepo.find({
      where: {
        courier_id: sourcePost.courier_id,
        status: Post_status.CANCELED,
      },
    });
    const sourceBranchId = String(sourcePost.branch_id ?? '').trim();
    const sourceRegionId = String(sourcePost.region_id ?? '').trim();
    const postsById = new Map<string, Post>([
      [String(sourcePost.id), sourcePost],
    ]);

    for (const candidate of candidatePosts) {
      const candidateBranchId = String(candidate.branch_id ?? '').trim();
      const candidateRegionId = String(candidate.region_id ?? '').trim();
      const sameBranch =
        !sourceBranchId ||
        !candidateBranchId ||
        candidateBranchId === sourceBranchId;
      const sameRegion =
        !sourceRegionId ||
        !candidateRegionId ||
        candidateRegionId === sourceRegionId;

      if (sameBranch && sameRegion) {
        postsById.set(String(candidate.id), candidate);
      }
    }

    const posts = [...postsById.values()];
    const orderGroups = await Promise.all(
      posts.map((candidate) =>
        this.findOrders({
          canceled_post_id: String(candidate.id),
          status: Order_status.CANCELLED_SENT,
          fetch_all: true,
          page: 1,
          limit: 100,
        }),
      ),
    );
    const ordersById = new Map<string, OrderRow>();

    for (const order of orderGroups.flat()) {
      ordersById.set(String(order.id), order);
    }

    return { posts, orders: [...ordersById.values()] };
  }

  /**
   * P1b — kuryer skani orqali buyurtmani o'z filialiga qabul qilish.
   *
   * `received: true` — qabul qilindi (buyurtma endi kuryer filialida, `RECEIVED`).
   * `received: false` — bu yo'l qo'llanmaydi: buyurtma paketda yo'lda emas
   *           (`no_batch`) yoki paket boshqa filialga atalgan (`other_branch`).
   *           Chaqiruvchi o'zining odatdagi "boshqa filial" xatosini beradi.
   *           `reason: 'transit'` (fix3b) — buyurtma filialga qabul qilindi,
   *           lekin boshqa hudud uchun: `NEW` bo'lib qayta jo'natiladi,
   *           kuryerga berilmaydi.
   *
   * Guard xatolari (paket hali jo'natilmagan, bekor qilingan, qaytarish paketi)
   * ATAYLAB yuqoriga uzatiladi — kuryer sababini bilishi kerak, umumiy
   * "boshqa filial orderi" xabari bu yerda chalg'ituvchi bo'lardi.
   */
  private async receiveOrderIntoBranchByScan(
    orderId: string,
    courierBranchId: string,
    requester: RequesterContext,
  ): Promise<{ received: boolean; reason: string }> {
    let res: { data?: { received?: boolean; reason?: string } } | undefined;
    try {
      res = await lastValueFrom(
        this.orderClient
          .send<{ data?: { received?: boolean; reason?: string } }>(
            { cmd: 'order.transfer_batch.receive_one_by_scan' },
            {
              order_id: orderId,
              courier_branch_id: courierBranchId,
              requester_id: String(requester.id),
              requester_roles: requester.roles ?? [],
            },
          )
          .pipe(timeout(8000)),
      );
    } catch (error: unknown) {
      // CODE-13 / C12 — RPC xatosi transportda oddiy obyekt bo'lib keladi
      // (RpcException emas). O'ralmasa kuryer 400/404 o'rniga 500 olardi va
      // executeAndAck xabarni qayta navbatga qo'yardi (skan ikki marta
      // bajarilardi). updateOrder bilan bir xil: >= 400 holati saqlanadi,
      // qolgani (timeout va h.k.) — 502.
      const downstreamError: unknown =
        error instanceof RpcException ? error.getError() : error;
      if (
        downstreamError &&
        typeof downstreamError === 'object' &&
        Number((downstreamError as { statusCode?: number }).statusCode) >= 400
      ) {
        throw new RpcException(downstreamError);
      }
      throw new RpcException(
        errorRes(
          "Buyurtmani skan orqali filialga qabul qilib bo'lmadi — birozdan so'ng qayta urinib ko'ring",
          502,
        ),
      );
    }
    return {
      received: Boolean(res?.data?.received),
      reason: String(res?.data?.reason ?? ''),
    };
  }

  private async updateOrder(
    id: string,
    dto: Record<string, unknown>,
    requester?: { id: string; roles?: string[]; note?: string | null },
  ): Promise<void> {
    try {
      await lastValueFrom(
        this.orderClient
          .send({ cmd: 'order.update' }, { id, dto, requester })
          .pipe(timeout(5000)),
      );
    } catch (error) {
      const downstreamError =
        error instanceof RpcException ? error.getError() : error;
      if (
        downstreamError &&
        typeof downstreamError === 'object' &&
        Number((downstreamError as { statusCode?: number }).statusCode) >= 400
      ) {
        throw new RpcException(downstreamError);
      }
      throw new RpcException(errorRes(`Order #${id} update failed`, 502));
    }
  }

  private async collapseDuplicateNewPosts(posts: Post[]): Promise<Post[]> {
    const byRegion = new Map<string, Post[]>();
    for (const post of posts) {
      const regionId = String(post.region_id ?? '').trim();
      if (!regionId) {
        continue;
      }
      const group = byRegion.get(regionId) ?? [];
      group.push(post);
      byRegion.set(regionId, group);
    }

    const removedPostIds = new Set<string>();

    for (const regionPosts of byRegion.values()) {
      const sorted = [...regionPosts].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      const canonical = sorted[0];

      if (String(canonical.branch_id ?? '').trim()) {
        canonical.branch_id = null;
      }

      if (sorted.length > 1) {
        const duplicateIds = sorted.slice(1).map((post) => String(post.id));
        if (!duplicateIds.length) {
          continue;
        }

        const duplicateOrders = await this.findOrders({
          post_ids: duplicateIds,
          fetch_all: true,
          limit: 1000,
        });
        for (const order of duplicateOrders) {
          await this.updateOrder(order.id, { post_id: canonical.id });
        }

        // LOG-01: ko'chirish davomida HQ qabuli dublikatga yangi buyurtma
        // yozgan bo'lishi mumkin. O'chirishdan oldin qayta tekshiriladi:
        // kechikkanlar ham ko'chiriladi, hali ishora qilinayotgan dublikat
        // esa o'chirilmaydi (keyingi yuklashda birlashtiriladi).
        const duplicates = sorted.slice(1);
        for (const duplicate of duplicates) {
          const lateOrders = await this.findOrders({
            post_ids: [String(duplicate.id)],
            fetch_all: true,
            limit: 1000,
          });
          for (const order of lateOrders) {
            await this.updateOrder(order.id, { post_id: canonical.id });
          }
          const stillReferenced = lateOrders.length
            ? await this.findOrders({
                post_ids: [String(duplicate.id)],
                fetch_all: true,
                limit: 1,
              })
            : [];
          if (stillReferenced.length) {
            continue;
          }
          await this.postRepo.remove(duplicate);
          void this.removePostFromSearch(duplicate);
          removedPostIds.add(String(duplicate.id));
        }

        const canonicalOrders = await this.findOrders({
          post_ids: [String(canonical.id)],
          fetch_all: true,
          limit: 1000,
        });
        canonical.order_quantity = canonicalOrders.length;
        canonical.post_total_price = canonicalOrders.reduce(
          (sum, order) => sum + Number(order.total_price ?? 0),
          0,
        );
      }

      const savedCanonical = await this.postRepo.save(canonical);
      void this.syncPostToSearch(savedCanonical);
    }

    return posts.filter((post) => !removedPostIds.has(String(post.id)));
  }

  private async findOrderByQrToken(qrToken: string): Promise<OrderRow> {
    let response: any;

    try {
      response = await lastValueFrom(
        this.orderClient
          .send({ cmd: 'order.find_by_qr' }, { token: qrToken })
          .pipe(timeout(5000)),
      );
    } catch (error) {
      const downstreamError =
        error instanceof RpcException ? error.getError() : error;
      if (
        downstreamError &&
        typeof downstreamError === 'object' &&
        Number((downstreamError as { statusCode?: number }).statusCode) >= 400
      ) {
        throw new RpcException(downstreamError);
      }
      throw new RpcException(errorRes('Order QR lookup failed', 502));
    }

    const candidates = [response?.data?.data, response?.data, response];

    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'object' && 'id' in candidate) {
        return candidate as OrderRow;
      }
    }

    this.notFound('Order topilmadi');
  }

  /**
   * Kuryerning filial biriktiruvi: filial id + filial turi.
   *
   * `branch.user.find_by_user` javobi `branch` qatorini ham olib keladi
   * (`type` bilan) — HQ kuryerini aniqlash uchun qo'shimcha RPC kerak emas.
   * Filial qatori yo'q bo'lsa (eski javob yoki o'chirilgan filial) `branchType`
   * `null` bo'ladi va HQ aniqlash `isHqCourierAssignment` zaxira yo'liga o'tadi.
   */
  private async findCourierAssignment(
    requester: RequesterContext,
  ): Promise<{ branchId: string; branchType: string | null }> {
    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Courier aniqlanmadi');
    }

    try {
      const response = await lastValueFrom(
        this.branchClient
          .send<{
            data?: {
              branch_id?: string | null;
              branch?: { type?: string | null } | null;
            } | null;
          }>(
            { cmd: 'branch.user.find_by_user' },
            {
              user_id: requesterId,
              requester: {
                id: requesterId,
                roles: requester.roles ?? [Roles.COURIER],
              },
            },
          )
          .pipe(timeout(5000)),
      );

      const branchId = String(response?.data?.branch_id ?? '').trim();
      if (!branchId) {
        this.forbidden('Courier filialga biriktirilmagan');
      }

      const branchType =
        String(response?.data?.branch?.type ?? '')
          .trim()
          .toUpperCase() || null;

      return { branchId, branchType };
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }
      this.forbidden("Courier filialini aniqlab bo'lmadi");
    }
  }

  private async findCourierBranchId(
    requester: RequesterContext,
  ): Promise<string> {
    return (await this.findCourierAssignment(requester)).branchId;
  }

  /**
   * HQ kuryerimi? Odatda `branch.type` yetarli. Tur noma'lum bo'lsa filial id
   * `branch.find_hq` bilan solishtiriladi — bu so'rov yiqilsa xato YUQORIGA
   * ketadi (fail closed): HQ kuryerini jimgina filial kuryeri deb hisoblab,
   * uning qoidalarini chetlab o'tib bo'lmaydi.
   */
  private async isHqCourierAssignment(assignment: {
    branchId: string;
    branchType: string | null;
  }): Promise<boolean> {
    if (assignment.branchType) {
      return assignment.branchType === String(BranchType.HQ);
    }
    return (await this.findHqBranchId()) === assignment.branchId;
  }

  private async findHqBranchId(): Promise<string> {
    try {
      const response = await lastValueFrom(
        this.branchClient
          .send({ cmd: 'branch.find_hq' }, {})
          .pipe(timeout(5000)),
      );
      const branchId = String(response?.data?.id ?? '').trim();
      if (!branchId) {
        this.notFound('HQ branch topilmadi');
      }
      return branchId;
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }
      this.forbidden("HQ branchini aniqlab bo'lmadi");
    }
  }

  private async findBranchAssignmentByUserId(
    userId: string,
    requester: RequesterContext,
  ): Promise<BranchAssignmentRow | null> {
    const normalizedUserId = String(userId ?? '').trim();
    if (!normalizedUserId) {
      this.badRequest('user_id is required');
    }

    try {
      const response = await lastValueFrom(
        this.branchClient
          .send(
            { cmd: 'branch.user.find_by_user' },
            {
              user_id: normalizedUserId,
              requester: {
                id: requester.id,
                roles: requester.roles ?? [Roles.BRANCH],
              },
            },
          )
          .pipe(timeout(5000)),
      );

      return (response?.data ?? null) as BranchAssignmentRow | null;
    } catch {
      return null;
    }
  }

  private async findBranchUsersByBranchId(
    branchId: string,
    requester: RequesterContext,
  ): Promise<Array<{ user_id?: string; role?: string }>> {
    const normalizedBranchId = String(branchId ?? '').trim();
    if (!normalizedBranchId) {
      return [];
    }

    try {
      const response = await lastValueFrom(
        this.branchClient
          .send(
            { cmd: 'branch.user.find_by_branch' },
            {
              branch_id: normalizedBranchId,
              requester: {
                id: requester.id,
                roles: requester.roles ?? [Roles.BRANCH],
              },
            },
          )
          .pipe(timeout(5000)),
      );

      const rows = response?.data;
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  private async listCouriers(
    search?: string,
  ): Promise<Array<Record<string, unknown>>> {
    try {
      const res = await lastValueFrom(
        this.identityClient
          .send(
            { cmd: 'identity.courier.find_all' },
            { query: { search, page: 1, limit: 1000 } },
          )
          .pipe(timeout(5000)),
      );

      return res?.data?.items ?? [];
    } catch {
      return [];
    }
  }

  private async listCouriersByRegion(
    regionId: string,
  ): Promise<Array<Record<string, unknown>>> {
    try {
      const res = await lastValueFrom(
        this.identityClient
          .send(
            { cmd: 'identity.courier.find_all' },
            { query: { region_id: regionId, page: 1, limit: 1000 } },
          )
          .pipe(timeout(5000)),
      );

      return res?.data?.items ?? [];
    } catch {
      return [];
    }
  }

  private async findCourierById(id: string): Promise<CourierRow | null> {
    try {
      const res = await lastValueFrom(
        this.identityClient
          .send({ cmd: 'identity.courier.find_by_ids' }, { ids: [id] })
          .pipe(timeout(5000)),
      );

      const rows = res?.data ?? [];
      return Array.isArray(rows) && rows.length
        ? (rows[0] as CourierRow)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * CODE-11 — kuryer identity'da qanday holatda.
   *
   * - `{ found: false }` — identity javob berdi, lekin bunday (o'chirilmagan)
   *   kuryer yo'q: identity `deleteUser` branch_users qatorini o'chirmaydi,
   *   shuning uchun filial a'zoligi tekshiruvi o'chirilgan kuryerni o'tkazib
   *   yuborardi;
   * - `{ found: true, status }` — 'active' / 'inactive' (kichik harfda);
   * - `null` — identity javob bermadi yoki javob shakli noma'lum: chaqiruvchi
   *   tekshiruvni o'tkazib yuboradi (bu yangi qo'shimcha to'siq, filial
   *   a'zoligi allaqachon tekshirilgan).
   */
  private async findCourierStatus(
    courierId: string,
  ): Promise<{ found: false } | { found: true; status: string } | null> {
    try {
      const res = await lastValueFrom(
        this.identityClient
          .send<{
            data?: unknown;
          }>({ cmd: 'identity.courier.find_by_ids' }, { ids: [courierId] })
          .pipe(timeout(5000)),
      );
      if (!Array.isArray(res?.data)) {
        return null;
      }
      const rows: unknown[] = res.data;
      const row = rows.find(
        (item): item is { id: string | number; status?: unknown } => {
          if (!item || typeof item !== 'object') {
            return false;
          }
          const id = (item as { id?: unknown }).id;
          return (
            (typeof id === 'string' || typeof id === 'number') &&
            String(id) === String(courierId)
          );
        },
      );
      if (!row) {
        return { found: false };
      }
      const rawStatus = row.status;
      return {
        found: true,
        status:
          typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '',
      };
    } catch (error) {
      this.logger.warn(
        `findCourierStatus(${courierId}) failed: ${(error as Error)?.message ?? error}`,
      );
      return null;
    }
  }

  private async findCouriersByIds(
    ids: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (!uniqueIds.length) {
      return new Map();
    }

    try {
      const res = await lastValueFrom(
        this.identityClient
          .send({ cmd: 'identity.courier.find_by_ids' }, { ids: uniqueIds })
          .pipe(timeout(5000)),
      );

      const rows = Array.isArray(res?.data) ? res.data : [];
      return new Map(
        rows
          .filter((item) => item && typeof item === 'object' && 'id' in item)
          .map((item) => [
            String((item as { id: string }).id),
            item as Record<string, unknown>,
          ]),
      );
    } catch {
      return new Map();
    }
  }

  /**
   * Hudud seedi.
   *
   * ⚠️ SOXTA SOATO YASALMAYDI. Avval kodlar massiv indeksidan tuzilardi
   * (`REG-01`, `REG-01-DIS-01`) va bu jimgina zarar keltirardi: hamkor
   * tizimlar SOATO bo'yicha avtomatik moslashga uringanda hech narsa mos
   * kelmasdi, chunki bir tomonda haqiqiy `1703224`, bizda esa o'ylab
   * topilgan satr turardi.
   *
   * Endi kod FAQAT ma'lumot faylidan olinadi. Noma'lum bo'lsa `null`
   * qoladi — bu halol holat va uni panelda ko'rish mumkin; soxta kod esa
   * haqiqiydek ko'rinib, xatoni yashirardi.
   */
  async onModuleInit() {
    for (const regionData of regions) {
      const regionName = regionData.name.trim();
      let regionEntity = await this.regionRepo.findOne({
        where: { name: regionName },
      });

      if (!regionEntity) {
        regionEntity = await this.regionRepo.save(
          this.regionRepo.create({
            name: regionName,
            sato_code: regionData.sato_code,
          }),
        );
        void this.syncRegionToSearch(regionEntity);
      }

      for (const districtData of regionData.districts) {
        const districtName = districtData.name.trim();
        const exists = await this.districtRepo.findOne({
          where: { name: districtName, region_id: regionEntity.id },
        });

        if (exists) {
          continue;
        }

        const district = this.districtRepo.create({
          name: districtName,
          sato_code: districtData.sato_code,
          region_id: regionEntity.id,
          assigned_region: regionEntity.id,
        });
        const savedDistrict = await this.districtRepo.save(district);
        void this.syncDistrictToSearch(savedDistrict);
      }
    }
  }

  async createPost(dto: CreatePostDto) {
    if (!dto.courier_id?.trim()) {
      this.badRequest('courier_id is required');
    }

    const uniqueOrderIds = [...new Set((dto.orderIDs ?? []).filter(Boolean))];
    let totalPrice = 0;
    let regionId: string | null = null;
    let branchIdFromOrders: string | null = null;

    for (const orderId of uniqueOrderIds) {
      const order = await this.findOrderById(orderId);
      totalPrice += Number(order?.total_price ?? 0);
      if (!regionId && order?.region_id) {
        regionId = String(order.region_id);
      }
      if (!branchIdFromOrders && order?.branch_id) {
        branchIdFromOrders = String(order.branch_id);
      }
    }

    const courierAssignment = await this.findBranchAssignmentByUserId(
      dto.courier_id,
      { id: dto.courier_id, roles: [Roles.COURIER] },
    );
    const branchId =
      (courierAssignment?.branch_id
        ? String(courierAssignment.branch_id)
        : null) ?? branchIdFromOrders;

    let post = regionId
      ? await this.postRepo.findOne({
          where: { region_id: regionId, status: Post_status.NEW },
        })
      : null;

    if (!post) {
      post = this.postRepo.create({
        courier_id: dto.courier_id,
        qr_code_token: dto.qr_code_token?.trim() || this.generateToken(),
        region_id: regionId,
        branch_id: null,
        post_total_price: 0,
        order_quantity: 0,
        status: Post_status.NEW,
      });
    }

    post.branch_id = null;
    post.post_total_price = Number(post.post_total_price ?? 0) + totalPrice;
    post.order_quantity =
      Number(post.order_quantity ?? 0) + uniqueOrderIds.length;

    const savedPost = await this.postRepo.save(post);
    void this.syncPostToSearch(savedPost);

    for (const orderId of uniqueOrderIds) {
      await this.updateOrder(orderId, {
        post_id: savedPost.id,
        status: Order_status.RECEIVED,
      });
    }

    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: String(savedPost.id),
      action: ActivityAction.CREATED,
      metadata: {
        courier_id: dto.courier_id,
        order_count: uniqueOrderIds.length,
        order_ids: uniqueOrderIds.slice(0, 10),
        branch_id: branchId,
        region_id: regionId,
      },
    });

    return successRes(savedPost, 201, 'Post created');
  }

  async findAllPosts(
    page = 1,
    limit = 8,
    filters?: { branch_id?: string; status?: string },
    requester?: RequesterContext,
  ) {
    const take = limit > 100 ? 100 : Math.max(1, limit);
    const skip = (Math.max(1, page) - 1) * take;

    const scopedBranchId = await this.resolveScopedBranchId(requester);
    const branchId =
      scopedBranchId ??
      (filters?.branch_id ? String(filters.branch_id).trim() : '');
    const status = filters?.status
      ? String(filters.status).trim().toLowerCase()
      : '';
    const where: Record<string, unknown> = { status: Not(Post_status.NEW) };
    if (branchId) {
      where.branch_id = branchId;
    }
    if (status) {
      const allowedStatuses = new Set<string>([
        Post_status.NEW,
        Post_status.SENT,
        Post_status.RECEIVED,
        Post_status.CANCELED,
        Post_status.CANCELED_RECEIVED,
      ]);
      if (allowedStatuses.has(status)) {
        where.status = status;
      }
    }
    if (status === Post_status.CANCELED && this.isSystemPrivileged(requester)) {
      where.branch_id = await this.findHqBranchId();
    }
    if (branchId && (!status || status === Post_status.SENT)) {
      await this.repairSentPostBranchAssignments(branchId);
    }
    let queryWhere: Record<string, unknown> | Record<string, unknown>[] = where;
    if (!status && this.isSystemPrivileged(requester)) {
      const hqBranchId = await this.findHqBranchId();
      queryWhere = [
        { status: Not(In([Post_status.NEW, Post_status.CANCELED])) },
        { status: Post_status.CANCELED, branch_id: hqBranchId },
      ];
    }

    const [data, total] = await this.postRepo.findAndCount({
      where: queryWhere,
      relations: ['region'],
      order: { createdAt: 'DESC' },
      skip,
      take,
    });

    return successRes(
      {
        data,
        total,
        page: Math.max(1, page),
        totalPages: Math.max(1, Math.ceil(total / take)),
        limit: take,
      },
      200,
      'All posts (paginated)',
    );
  }

  private async repairSentPostBranchAssignments(
    branchId: string,
  ): Promise<void> {
    const normalizedBranchId = String(branchId ?? '').trim();
    if (!normalizedBranchId) return;

    const candidatePosts = await this.postRepo.find({
      where: {
        status: Post_status.SENT,
      },
      take: 100,
    });
    if (!candidatePosts.length) return;

    for (const post of candidatePosts) {
      const courierId = String(post.courier_id ?? '').trim();
      if (courierId && courierId !== '0') continue;
      if (String(post.branch_id ?? '').trim() === normalizedBranchId) continue;

      const orders = await this.findOrders({
        post_id: String(post.id),
        fetch_all: true,
        limit: 1000,
      });
      const branchIds = new Set(
        orders.map((order) => this.getOrderBranchScope(order)).filter(Boolean),
      );

      if (branchIds.size === 1 && branchIds.has(normalizedBranchId)) {
        post.branch_id = normalizedBranchId;
        const saved = await this.postRepo.save(post);
        void this.syncPostToSearch(saved);
      }
    }
  }

  /**
   * LC-03 — buyurtma HQ omborida turibdimi (custody bo'yicha)?
   *
   * Doira getPostOrders/receivePost bilan AYNAN bir xil hisoblanadi
   * (`holder_branch_id ?? branch_id`), aks holda HQ hudud pochtasi aralash
   * doiraga ega bo'lib, HQ registratori uni ocha olmasdi (403). Kuryerdagi
   * (COURIER) yoki marketga qaytgan (MARKET) buyurtma HQ omborida emas.
   * Doirasiz eski qator — HQ (resolveReturnCustodyBranchId bilan bir xil).
   */
  private isInHqCustody(order: OrderRow, hqBranchId: string): boolean {
    const holderType = String(order.holder_type ?? '')
      .trim()
      .toUpperCase();
    if (holderType && holderType !== 'HQ' && holderType !== 'BRANCH') {
      return false;
    }
    const scope = this.getOrderBranchScope(order);
    return !scope || scope === hqBranchId;
  }

  /**
   * LC-03 — newPosts faqat HQ omboridagi yetim buyurtmalarni HQ hudud
   * pochtasiga oladi. Ilgari filial (REGIONAL/HYBRID ota filial) paketni qabul
   * qilgan, hali kuryerga bermagan RECEIVED buyurtmalar ham olinardi va HQ
   * pochtasi ochilmay qolardi. HQ aniqlanmasa — hech narsa olinmaydi (fail
   * closed), ro'yxat esa baribir qaytadi.
   */
  private async filterHqCustodyOrphans(
    orders: OrderRow[],
  ): Promise<OrderRow[]> {
    if (!orders.length) {
      return [];
    }
    let hqBranchId: string;
    try {
      hqBranchId = await this.findHqBranchId();
    } catch (error) {
      this.logger.warn(
        `newPosts: HQ filiali aniqlanmadi — yetim buyurtmalar pochtaga biriktirilmadi: ${(error as Error)?.message ?? error}`,
      );
      return [];
    }
    return orders.filter((order) => this.isInHqCustody(order, hqBranchId));
  }

  async newPosts(query?: { search?: string }, requester?: RequesterContext) {
    const orphanOrders = await this.findOrders({
      status: Order_status.RECEIVED,
      page: 1,
      limit: 1000,
    });
    // LOG-01: o'chirilgan pochtaga ishora qiladigan RECEIVED buyurtma ham
    // yetim. Dublikat pochta birlashtirilayotganda HQ qabuli unga yangi
    // buyurtma yozib ulgursa, pochta o'chgach buyurtma hech bir kartada
    // ko'rinmay, jo'natib ham bo'lmay qolardi — endi keyingi yuklashda
    // o'z hudud pochtasiga qaytadi.
    const referencedPostIds = Array.from(
      new Set(
        orphanOrders
          .map((order) => String(order.post_id ?? '').trim())
          .filter(Boolean),
      ),
    );
    const existingPostIds = new Set(
      referencedPostIds.length
        ? (
            await this.postRepo.find({
              where: { id: In(referencedPostIds) },
              select: ['id'],
            })
          ).map((post) => String(post.id))
        : [],
    );
    const candidates = await this.filterHqCustodyOrphans(
      orphanOrders.filter((order) => {
        const postId = String(order.post_id ?? '').trim();
        return (
          Boolean(order.region_id) && (!postId || !existingPostIds.has(postId))
        );
      }),
    );

    const byRegion = new Map<
      string,
      { regionId: string; branchIds: Set<string>; ids: string[]; total: number }
    >();

    for (const order of candidates) {
      const regionId = String(order.region_id);
      const current = byRegion.get(regionId) ?? {
        regionId,
        branchIds: new Set<string>(),
        ids: [],
        total: 0,
      };
      const branchId = String(order.branch_id ?? '').trim();
      if (branchId) {
        current.branchIds.add(branchId);
      }
      current.ids.push(order.id);
      current.total += Number(order.total_price ?? 0);
      byRegion.set(regionId, current);
    }

    const touchedBranchIds = new Set<string>();
    const touchedRegionIds = new Set<string>();
    let assignedOrderCount = 0;

    for (const payload of byRegion.values()) {
      let post = await this.postRepo.findOne({
        where: {
          region_id: payload.regionId,
          status: Post_status.NEW,
        },
      });

      if (post && String(post.branch_id ?? '').trim()) {
        post.branch_id = null;
        post = await this.postRepo.save(post);
        void this.syncPostToSearch(post);
      }

      if (!post) {
        post = await this.postRepo.save(
          this.postRepo.create({
            courier_id: '0',
            qr_code_token: this.generateToken(),
            region_id: payload.regionId,
            branch_id: null,
            status: Post_status.NEW,
            post_total_price: 0,
            order_quantity: 0,
          }),
        );
        void this.syncPostToSearch(post);
      }

      for (const orderId of payload.ids) {
        await this.updateOrder(orderId, { post_id: post.id });
      }

      // Atomic increment — avoids lost-update if newPosts is invoked
      // concurrently for the same region.
      const incrementCount = payload.ids.length;
      const incrementTotal = Number.isFinite(payload.total) ? payload.total : 0;
      await this.postRepo
        .createQueryBuilder()
        .update(Post)
        .set({
          order_quantity: () => `order_quantity + ${incrementCount}`,
          post_total_price: () => `post_total_price + ${incrementTotal}`,
        })
        .where('id = :id', { id: post.id })
        .execute();
      const refreshedPost = await this.postRepo.findOne({
        where: { id: post.id },
      });
      if (refreshedPost) {
        void this.syncPostToSearch(refreshedPost);
      }
      for (const branchId of payload.branchIds) {
        touchedBranchIds.add(branchId);
      }
      touchedRegionIds.add(payload.regionId);
      assignedOrderCount += payload.ids.length;
    }

    if (byRegion.size > 0) {
      await this.activityLog.log({
        entity_type: 'Post',
        entity_id: 'auto_batch',
        action: 'logistics.post_auto_batch',
        ...this.auditActor(requester),
        metadata: {
          branch_id: Array.from(touchedBranchIds).slice(0, 10),
          region_id: Array.from(touchedRegionIds).slice(0, 10),
          post_count: byRegion.size,
          order_count: assignedOrderCount,
        },
      });
    }

    let allPosts = await this.postRepo.find({
      where: { status: Post_status.NEW },
      relations: ['region'],
      order: { createdAt: 'DESC' },
    });
    allPosts = await this.collapseDuplicateNewPosts(allPosts);

    const postIds = allPosts.map((post) => String(post.id)).filter(Boolean);
    const postOrders = postIds.length
      ? await this.findOrders({
          post_ids: postIds,
          fetch_all: true,
          limit: 100,
        })
      : [];
    const orderStatsByPostId = new Map<
      string,
      { count: number; total: number }
    >();
    for (const order of postOrders) {
      const postId = String(order.post_id ?? '').trim();
      if (!postId) {
        continue;
      }
      const current = orderStatsByPostId.get(postId) ?? { count: 0, total: 0 };
      current.count += 1;
      current.total += Number(order.total_price ?? 0);
      orderStatsByPostId.set(postId, current);
    }

    const regionIds = Array.from(
      new Set(
        allPosts
          .map((post) => post.region_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const regionsById = new Map<string, Region>();
    if (regionIds.length) {
      const linkedRegions = await this.regionRepo.find({
        where: { id: In(regionIds) },
      });
      for (const region of linkedRegions) {
        regionsById.set(region.id, region);
      }
    }

    const postsWithRegion = allPosts.map((post) => ({
      ...post,
      order_quantity: orderStatsByPostId.get(String(post.id))?.count ?? 0,
      post_total_price: orderStatsByPostId.get(String(post.id))?.total ?? 0,
      region: post.region_id ? (regionsById.get(post.region_id) ?? null) : null,
    }));

    const searchFilter = query?.search?.trim().toLowerCase();

    const filteredPosts = postsWithRegion.filter((post) => {
      if (searchFilter) {
        const regionName = String(post.region?.name ?? '').toLowerCase();
        if (!regionName.includes(searchFilter)) {
          return false;
        }
      }

      return true;
    });

    return successRes(filteredPosts, 200, 'All new posts');
  }

  async rejectedPosts(requester?: RequesterContext) {
    const scopedBranchId = await this.resolveScopedBranchId(requester);
    const where: Record<string, unknown> = { status: Post_status.CANCELED };
    if (scopedBranchId) {
      where.branch_id = scopedBranchId;
    } else if (this.isSystemPrivileged(requester)) {
      where.branch_id = await this.findHqBranchId();
    }

    const allPosts = await this.postRepo.find({
      where,
      relations: ['region'],
      order: { createdAt: 'DESC' },
    });
    const courierMap = await this.findCouriersByIds(
      allPosts.map((post) => post.courier_id).filter(Boolean),
    );
    const enrichedPosts = await Promise.all(
      allPosts.map(async (post) => {
        const { orders } = await this.findCanceledPostGroup(post);
        return {
          ...post,
          order_quantity: orders.length,
          post_total_price: orders.reduce(
            (sum, order) => sum + Number(order.total_price ?? 0),
            0,
          ),
          courier: post.courier_id
            ? (courierMap.get(post.courier_id) ?? null)
            : null,
        };
      }),
    );
    return successRes(enrichedPosts, 200, 'All rejected posts');
  }

  async onTheRoadPosts(requester: RequesterContext) {
    const allPosts = await this.postRepo.find({
      where: { status: Post_status.SENT, courier_id: requester.id },
      relations: ['region'],
      order: { createdAt: 'DESC' },
    });
    return successRes(allPosts, 200, 'All on-the-road posts');
  }

  async oldPostsForCourier(
    page: number,
    limit: number,
    requester: RequesterContext,
  ) {
    const take = limit > 100 ? 100 : Math.max(1, limit);
    const skip = (Math.max(1, page) - 1) * take;

    const [data, total] = await this.postRepo.findAndCount({
      where: {
        courier_id: requester.id,
        status: Not(In([Post_status.SENT, Post_status.NEW])),
      },
      relations: ['region'],
      order: { createdAt: 'DESC' },
      skip,
      take,
    });

    return successRes(
      {
        data,
        total,
        page: Math.max(1, page),
        totalPages: Math.max(1, Math.ceil(total / take)),
        limit: take,
      },
      200,
      'All old posts',
    );
  }

  async rejectedPostsForCourier(requester: RequesterContext) {
    const rows = await this.postRepo.find({
      where: { status: Post_status.CANCELED, courier_id: requester.id },
      relations: ['region'],
      order: { createdAt: 'DESC' },
    });
    const courierMap = await this.findCouriersByIds(
      rows.map((post) => post.courier_id).filter(Boolean),
    );
    const enrichedRows = await Promise.all(
      rows.map(async (post) => {
        const { orders } = await this.findCanceledPostGroup(post);
        return {
          ...post,
          order_quantity: orders.length,
          post_total_price: orders.reduce(
            (sum, order) => sum + Number(order.total_price ?? 0),
            0,
          ),
          courier: post.courier_id
            ? (courierMap.get(post.courier_id) ?? null)
            : null,
        };
      }),
    );
    return successRes(enrichedRows, 200, 'All rejected posts for courier');
  }

  /**
   * Kuryer ko'chirish/o'chirish tekshiruvi (branch-service
   * loadCourierHoldings) uchun: kuryer topshirgan, filial hali qabul qilmagan
   * bekor (CANCELED) pochtalar.
   *
   * rejectedPostsForCourier dan farqi (u o'zgarmaydi — kuryer ekrani uni
   * o'qiydi):
   * - identity boyitish YO'Q: tekshiruv uni o'qimaydi, u esa 5 s kutishi mumkin;
   * - `order_quantity` — pochtaning O'Z buyurtmalari (canceled_post_id =
   *   post.id, CANCELLED_SENT), guruh soni EMAS: findCanceledPostGroup
   *   ishlatilmaydi. Bo'sh pochta 0 oladi — iste'molchi faqat > 0 larini
   *   sanaydi;
   * - har bir pochtaga bitta order.find_all, parallel, 3500 ms dan — butun
   *   javob chaqiruvchining 5000 ms byudjetiga sig'adi. Pochta yo'q — order
   *   chaqiruvi ham yo'q.
   *
   * Xato doim RpcException: noto'g'ri courier_id — 400, qolgan har qanday
   * xato — 503 (xom xato executeAndAck da xabarni qayta navbatga qo'yardi).
   */
  async openReturnPostsForCourier(courierId?: string | null) {
    const normalizedCourierId = String(courierId ?? '').trim();
    if (!/^\d+$/.test(normalizedCourierId)) {
      this.badRequest("courier_id noto'g'ri");
    }

    try {
      const posts = await this.postRepo.find({
        where: {
          status: Post_status.CANCELED,
          courier_id: normalizedCourierId,
        },
        order: { createdAt: 'DESC' },
      });

      const rows = await Promise.all(
        posts.map(async (post) => {
          const orders = await this.findOrders(
            {
              canceled_post_id: String(post.id),
              status: Order_status.CANCELLED_SENT,
              fetch_all: true,
              page: 1,
              limit: 100,
            },
            { timeoutMs: OPEN_RETURN_POSTS_ORDER_TIMEOUT_MS },
          );
          return {
            id: String(post.id),
            branch_id: String(post.branch_id ?? '').trim() || null,
            order_quantity: orders.length,
          };
        }),
      );

      return successRes(
        rows,
        200,
        'Kuryerning qabul qilinmagan bekor pochtalari',
      );
    } catch (error) {
      this.logger.warn(
        `openReturnPostsForCourier failed (courier=${normalizedCourierId}): ${(error as Error)?.message ?? error}`,
      );
      throw new RpcException(
        errorRes(OPEN_RETURN_POSTS_UNAVAILABLE_MESSAGE, 503),
      );
    }
  }

  async myPostsForCourier(
    page: number,
    limit: number,
    requester: RequesterContext,
  ) {
    const take = limit > 100 ? 100 : Math.max(1, limit);
    const skip = (Math.max(1, page) - 1) * take;

    const [data, total] = await this.postRepo.findAndCount({
      where: { courier_id: requester.id },
      relations: ['region'],
      order: { createdAt: 'DESC' },
      skip,
      take,
    });

    return successRes(
      {
        data,
        total,
        page: Math.max(1, page),
        totalPages: Math.max(1, Math.ceil(total / take)),
        limit: take,
      },
      200,
      'All my posts',
    );
  }

  async findPostById(id: string, requester?: RequesterContext) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }
    const scopedBranchId = await this.resolveScopedBranchId(requester);
    let belongsToScopedBranch = false;
    if (scopedBranchId && String(post.branch_id ?? '') !== scopedBranchId) {
      const orders = await this.findOrders({
        post_id: id,
        page: 1,
        limit: 1000,
      });
      const orderBranchIds = new Set(
        orders.map((order) => this.getOrderBranchScope(order)).filter(Boolean),
      );
      belongsToScopedBranch =
        orderBranchIds.size === 1 && orderBranchIds.has(String(scopedBranchId));
    }

    if (
      scopedBranchId &&
      String(post.branch_id ?? '') !== scopedBranchId &&
      !belongsToScopedBranch
    ) {
      this.forbidden("Siz bu branch pochtasini ko'ra olmaysiz");
    }
    const isBranchTransferPost =
      !String(post.courier_id ?? '').trim() ||
      String(post.courier_id ?? '').trim() === '0';
    if (
      scopedBranchId &&
      belongsToScopedBranch &&
      isBranchTransferPost &&
      String(post.branch_id ?? '').trim() !== scopedBranchId
    ) {
      post.branch_id = scopedBranchId;
      const saved = await this.postRepo.save(post);
      void this.syncPostToSearch(saved);
      return successRes(saved, 200, 'Post found');
    }
    return successRes(post, 200, 'Post found');
  }

  async deletePost(id: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }

    const deletedSnapshot = {
      courier_id: post.courier_id,
      status: post.status,
      branch_id: post.branch_id,
      region_id: post.region_id,
      order_quantity: post.order_quantity,
    };

    await this.postRepo.remove(post);
    void this.removePostFromSearch(post);

    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: String(id),
      action: ActivityAction.DELETED,
      old_value: deletedSnapshot,
      metadata: {
        courier_id: deletedSnapshot.courier_id,
        branch_id: deletedSnapshot.branch_id,
      },
    });

    return successRes({ id }, 200, 'Post deleted');
  }

  async findPostsByIds(ids: string[]) {
    if (!ids.length) {
      return successRes([], 200, 'Posts found');
    }

    const posts = await this.postRepo.find({
      where: { id: In(ids) },
    });

    return successRes(posts, 200, 'Posts found');
  }

  async findPostWithQr(token: string) {
    const post = await this.postRepo.findOne({
      where: { qr_code_token: token },
    });
    if (!post) {
      this.notFound('Post not found');
    }
    return successRes(post, 200, 'Post found');
  }

  async findAllCouriersByPostId(id: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }

    const couriers = post.region_id
      ? await this.listCouriersByRegion(post.region_id)
      : await this.listCouriers();
    if (!couriers.length) {
      this.notFound('There are not any couriers for this region');
    }

    return successRes(
      {
        moreThanOneCourier: couriers.length > 1,
        couriers,
      },
      200,
      'Couriers for this post',
    );
  }

  async getPostOrders(id: string, requester: RequesterContext) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }
    const isCourier = (requester.roles ?? []).some(
      (role) => String(role).toLowerCase() === Roles.COURIER,
    );
    const isOwnCourierPost =
      isCourier && String(post.courier_id ?? '') === String(requester.id ?? '');

    const scopedBranchId = await this.resolveScopedBranchId(requester);
    const [ordersByPostId, ordersByCanceledPostId] = await Promise.all([
      this.findOrders({
        post_id: id,
        page: 1,
        limit: 1000,
      }),
      post.status === Post_status.CANCELED
        ? this.findCanceledPostGroup(post).then(({ orders }) => orders)
        : this.findOrders({
            canceled_post_id: id,
            page: 1,
            limit: 1000,
          }),
    ]);
    const orderBranchIds = new Set(
      [...ordersByPostId, ...ordersByCanceledPostId]
        .map((order) => this.getOrderBranchScope(order))
        .filter(Boolean),
    );
    const belongsToScopedBranch =
      Boolean(scopedBranchId) &&
      orderBranchIds.size === 1 &&
      orderBranchIds.has(String(scopedBranchId));

    if (
      scopedBranchId &&
      String(post.branch_id ?? '') !== scopedBranchId &&
      !belongsToScopedBranch &&
      !isOwnCourierPost
    ) {
      this.forbidden("Siz bu branch pochtasidagi orderlarni ko'ra olmaysiz");
    }

    const isBranchTransferPost =
      !String(post.courier_id ?? '').trim() ||
      String(post.courier_id ?? '').trim() === '0';
    if (
      belongsToScopedBranch &&
      isBranchTransferPost &&
      String(post.branch_id ?? '').trim() !== scopedBranchId
    ) {
      post.branch_id = scopedBranchId;
      const saved = await this.postRepo.save(post);
      void this.syncPostToSearch(saved);
    }

    const orderMap = new Map<string, OrderRow>();
    for (const order of [...ordersByPostId, ...ordersByCanceledPostId]) {
      orderMap.set(String(order.id), order);
    }

    let orders = Array.from(orderMap.values());

    if (post.status === Post_status.SENT && isCourier) {
      orders = orders.filter(
        (order) => order.status === Order_status.ON_THE_ROAD,
      );
    }

    let homeOrders = 0;
    let centerOrders = 0;
    let homeOrdersTotalPrice = 0;
    let centerOrdersTotalPrice = 0;

    for (const order of orders) {
      if (order.where_deliver === Where_deliver.ADDRESS) {
        homeOrders += 1;
        homeOrdersTotalPrice += Number(order.total_price ?? 0);
      } else {
        centerOrders += 1;
        centerOrdersTotalPrice += Number(order.total_price ?? 0);
      }
    }

    return successRes(
      {
        allOrdersByPostId: orders,
        homeOrders: { homeOrders, homeOrdersTotalPrice },
        centerOrders: { centerOrders, centerOrdersTotalPrice },
      },
      200,
      'All orders by post id',
    );
  }

  async getCourierSentPostOrders(id: string, requester: RequesterContext) {
    const post = await this.postRepo.findOne({
      where: { id, courier_id: requester.id },
    });
    if (!post) {
      this.notFound('Post not found');
    }
    if (post.status !== Post_status.SENT) {
      this.badRequest('Only sent posts are available for courier');
    }

    return this.getPostOrders(id, requester);
  }

  async getRejectedPostOrders(id: string, requester?: RequesterContext) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }
    const isCourier = (requester?.roles ?? []).some(
      (role) => String(role).toLowerCase() === Roles.COURIER,
    );
    const isOwnCourierPost =
      isCourier &&
      String(post.courier_id ?? '') === String(requester?.id ?? '');
    const scopedBranchId = await this.resolveScopedBranchId(requester);
    if (
      scopedBranchId &&
      String(post.branch_id ?? '') !== scopedBranchId &&
      !isOwnCourierPost
    ) {
      this.forbidden(
        "Siz bu branch pochtasidagi rejected orderlarni ko'ra olmaysiz",
      );
    }

    const orders = await this.findOrders({
      canceled_post_id: id,
      page: 1,
      limit: 1000,
    });
    return successRes(orders, 200, 'All rejected orders by post id');
  }

  async checkPost(qrToken: string, dto: PostIdDto) {
    if (!dto.postId) {
      this.badRequest('Post not found');
    }

    const orders = await this.findOrders({
      post_id: dto.postId,
      status: Order_status.RECEIVED,
      qr_code_token: qrToken,
      page: 1,
      limit: 1,
    });

    if (!orders.length) {
      this.notFound('Order not found');
    }

    return successRes(
      { order: { id: orders[0].id } },
      200,
      "Order checked and it's exist",
    );
  }

  async checkCancelPost(qrToken: string, dto: PostIdDto) {
    if (!dto.postId) {
      this.badRequest('Post not found');
    }

    const orders = await this.findOrders({
      canceled_post_id: dto.postId,
      status: Order_status.CANCELLED_SENT,
      qr_code_token: qrToken,
      page: 1,
      limit: 1,
    });

    if (!orders.length) {
      this.notFound('Order not found');
    }

    return successRes(
      { order: { id: orders[0].id } },
      200,
      "Order checked and it's exist",
    );
  }

  async sendPost(id: string, dto: SendPostDto, requester?: RequesterContext) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }

    const courier = await this.findCourierById(dto.courierId);
    if (!courier) {
      this.notFound('Courier not found');
    }

    if (!dto.orderIds?.length) {
      this.badRequest('You can not send an empty post');
    }

    const currentOrders = await this.findOrders({
      post_id: id,
      page: 1,
      limit: 1000,
    });
    if (!currentOrders.length) {
      this.badRequest('Post has no orders');
    }

    const currentIds = currentOrders.map((o) => o.id);
    const selectedIds = [...new Set(dto.orderIds.filter(Boolean))];
    const invalidIds = selectedIds.filter(
      (orderId) => !currentIds.includes(orderId),
    );
    if (invalidIds.length) {
      this.badRequest('Some selected orders are not inside this post');
    }
    const remainingIds = currentIds.filter(
      (orderId) => !selectedIds.includes(orderId),
    );
    const trackingNote =
      dto.description?.trim() ||
      "Post jo'natildi: status received dan on_the_road ga o'tdi";
    const trackingRequester =
      requester && requester.id
        ? { id: requester.id, roles: requester.roles ?? [], note: trackingNote }
        : { id: 'system', roles: [], note: trackingNote };

    let selectedTotal = 0;
    let regionId = post.region_id;
    const selectedOrders: OrderRow[] = [];
    for (const orderId of selectedIds) {
      const order = await this.findOrderById(orderId);
      selectedOrders.push(order);
      selectedTotal += Number(order.total_price ?? 0);
      if (!regionId && order.region_id) {
        regionId = String(order.region_id);
      }
    }

    // If we send a subset, keep remaining orders in old NEW post and create a fresh SENT post.
    if (remainingIds.length > 0) {
      let remainingTotal = 0;
      for (const orderId of remainingIds) {
        const order = currentOrders.find((item) => item.id === orderId);
        remainingTotal += Number(order?.total_price ?? 0);
        await this.updateOrder(orderId, {
          post_id: post.id,
          status: Order_status.RECEIVED,
        });
      }

      const sentPost = await this.postRepo.save(
        this.postRepo.create({
          courier_id: dto.courierId,
          qr_code_token: this.generateToken(),
          region_id: regionId,
          status: Post_status.SENT,
          post_total_price: selectedTotal,
          order_quantity: selectedIds.length,
        }),
      );

      for (const orderId of selectedIds) {
        await this.updateOrder(
          orderId,
          {
            post_id: sentPost.id,
            status: Order_status.ON_THE_ROAD,
            // Hand custody to the courier so the order's holder becomes COURIER
            // (the parcel is now on the road with them). (Audit I12.)
            courier_id: dto.courierId,
          },
          trackingRequester,
        );
      }

      post.courier_id = '0';
      post.status = Post_status.NEW;
      post.order_quantity = remainingIds.length;
      post.post_total_price = remainingTotal;
      post.region_id = regionId;
      const sourcePost = await this.postRepo.save(post);

      void this.syncPostToSearch(sourcePost);
      void this.syncPostToSearch(sentPost);

      await this.activityLog.log({
        entity_type: 'Post',
        entity_id: String(sentPost.id),
        action: ActivityAction.STATUS_CHANGE,
        new_value: { status: Post_status.SENT },
        ...this.auditActor(requester),
        metadata: {
          courier_id: dto.courierId,
          order_count: selectedIds.length,
          order_ids: selectedIds.slice(0, 10),
          source_post_id: String(sourcePost.id),
        },
      });

      return successRes(
        {
          updatedPost: sentPost,
          sourcePost,
          newOrders: selectedOrders,
          postTotalInfo: {
            total: selectedIds.length,
            sum: selectedTotal,
          },
        },
        200,
        'Post sent successfully',
      );
    }

    // If all orders selected, send current post as before.
    for (const orderId of selectedIds) {
      await this.updateOrder(
        orderId,
        {
          post_id: id,
          status: Order_status.ON_THE_ROAD,
          // Hand custody to the courier (holder → COURIER). (Audit I12.)
          courier_id: dto.courierId,
        },
        trackingRequester,
      );
    }

    post.courier_id = dto.courierId;
    post.status = Post_status.SENT;
    post.order_quantity = selectedIds.length;
    post.post_total_price = selectedTotal;
    post.region_id = regionId;

    const updatedPost = await this.postRepo.save(post);
    void this.syncPostToSearch(updatedPost);

    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: String(updatedPost.id),
      action: ActivityAction.STATUS_CHANGE,
      new_value: { status: Post_status.SENT },
      ...this.auditActor(requester),
      metadata: {
        courier_id: dto.courierId,
        order_count: selectedIds.length,
        order_ids: selectedIds.slice(0, 10),
      },
    });

    return successRes(
      {
        updatedPost,
        newOrders: selectedOrders,
        postTotalInfo: {
          total: selectedIds.length,
          sum: selectedTotal,
        },
      },
      200,
      'Post sent successfully',
    );
  }

  async receivePost(
    requester: RequesterContext,
    id: string,
    dto: ReceivePostDto,
  ) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }
    const requesterRoles = (requester?.roles ?? []).map((role) =>
      String(role ?? '').toLowerCase(),
    );
    const requesterId = String(requester?.id ?? '').trim();
    const requesterIsCourier = requesterRoles.includes(Roles.COURIER);
    const isOwnCourierPost =
      requesterIsCourier && String(post.courier_id ?? '') === requesterId;

    const waitingOrderIds = [
      ...new Set((dto.order_ids ?? []).map((orderId) => String(orderId))),
    ];
    const waitingOrderIdSet = new Set(waitingOrderIds);
    const allOrders = await this.findOrders({
      post_id: id,
      page: 1,
      limit: 1000,
    });
    const scopedBranchId = await this.resolveScopedBranchId(requester);
    const orderBranchIds = new Set(
      allOrders.map((order) => this.getOrderBranchScope(order)).filter(Boolean),
    );
    const belongsToScopedBranch =
      Boolean(scopedBranchId) &&
      orderBranchIds.size === 1 &&
      orderBranchIds.has(String(scopedBranchId));

    if (
      scopedBranchId &&
      String(post.branch_id ?? '') !== scopedBranchId &&
      !belongsToScopedBranch &&
      !isOwnCourierPost
    ) {
      this.forbidden('Siz bu branch pochtasini qabul qila olmaysiz');
    }

    if (
      requesterIsCourier &&
      !this.isSystemPrivileged(requester) &&
      requesterId &&
      String(post.courier_id ?? '') !== requesterId
    ) {
      this.forbidden(
        "Courier faqat o'ziga biriktirilgan pochtani qabul qilishi mumkin",
      );
    }

    const orderById = new Map(
      allOrders.map((order) => [String(order.id), order]),
    );
    const selectedOrders = waitingOrderIds
      .map((orderId) => orderById.get(orderId))
      .filter((order): order is OrderRow => Boolean(order));
    const selectedHasReceivableOrder = selectedOrders.some(
      (order) => order.status === Order_status.ON_THE_ROAD,
    );

    if (
      post.status !== Post_status.SENT &&
      !(post.status === Post_status.RECEIVED && selectedHasReceivableOrder)
    ) {
      this.badRequest('Cannot receive post with this status');
    }

    const isBranchTransferPost =
      !String(post.courier_id ?? '').trim() ||
      String(post.courier_id ?? '').trim() === '0';
    if (
      scopedBranchId &&
      belongsToScopedBranch &&
      isBranchTransferPost &&
      String(post.branch_id ?? '').trim() !== scopedBranchId
    ) {
      post.branch_id = scopedBranchId;
    }

    const targetBranchId =
      String(post.branch_id ?? '').trim() ||
      (belongsToScopedBranch ? String(scopedBranchId) : '') ||
      undefined;

    // (ePpLHPX2) Filiallararo pochta manzil filialga keldi — bildirishnoma
    // nishoni (filial xodimlari). Qidiruv tranzaksiyadan OLDIN va order
    // yangilashlari bilan PARALLEL boshlanadi; qisqa timeout + kesh, hech
    // qachon reject bo'lmaydi (fail-open → bo'sh ro'yxat). Kuryerning o'z
    // pochtasini qabul qilishi — filialga kelish EMAS.
    const arrivalStaffIds: Promise<string[]> | null =
      this.logisticsNotifications && isBranchTransferPost && targetBranchId
        ? this.logisticsNotifications.resolveBranchStaffIds(
            targetBranchId,
            requester,
          )
        : null;

    // receivePost spans multiple updateOrder RMQ calls + a local postRepo.save
    // across two services — no atomic TX possible. Track which transitions
    // succeeded so partial failures are visible in logs rather than silent.
    const failures: Array<{ order_id: string; error: string }> = [];
    // LC-11 — tanlangan, lekin WAITING ga o'tkazib bo'lmagan buyurtmalar.
    const failedSelectedOrderIds: string[] = [];

    for (const orderId of waitingOrderIds) {
      const target = orderById.get(orderId);
      if (target && target.status !== Order_status.WAITING) {
        try {
          await this.updateOrder(orderId, {
            status: Order_status.WAITING,
            return_requested: false,
            ...(targetBranchId ? { branch_id: targetBranchId } : {}),
          });
        } catch (err) {
          failures.push({
            order_id: String(orderId),
            error: (err as Error)?.message ?? String(err),
          });
          failedSelectedOrderIds.push(String(orderId));
        }
      }
    }

    const remaining = allOrders.filter(
      (o) =>
        !waitingOrderIdSet.has(String(o.id)) &&
        o.status === Order_status.ON_THE_ROAD,
    );

    if (remaining.length) {
      for (const order of remaining) {
        try {
          await this.updateOrder(order.id, {
            status: Order_status.ON_THE_ROAD,
            return_requested: true,
            ...(targetBranchId ? { branch_id: targetBranchId } : {}),
          });
        } catch (err) {
          failures.push({
            order_id: String(order.id),
            error: (err as Error)?.message ?? String(err),
          });
        }
      }
    }

    if (targetBranchId) {
      for (const order of allOrders) {
        if (String(order.branch_id ?? '').trim() === targetBranchId) {
          continue;
        }
        try {
          await this.updateOrder(order.id, {
            branch_id: targetBranchId,
          });
        } catch (err) {
          failures.push({
            order_id: String(order.id),
            error: (err as Error)?.message ?? String(err),
          });
        }
      }
    }

    if (failures.length > 0) {
      this.logger.warn(
        `receivePost partial failure for post=${id}: ${failures.length} order update(s) failed — operator should reconcile. Sample: ${failures
          .slice(0, 3)
          .map((f) => `${f.order_id}:${f.error}`)
          .join(' | ')}`,
      );
    }

    // LC-11 — pochta holati so'rov boshidagi suratdan EMAS, yozuvlardan keyingi
    // haqiqiy holatdan tanlanadi: yangilanmay qolgan tanlangan buyurtma yoki
    // shu orada HQ dispatch qo'shgan buyurtma hamon ON_THE_ROAD bo'lsa, pochta
    // SENT qoladi (RECEIVED pochta FE da faqat ko'rish rejimida ochiladi va
    // qolgan posilkalarni qabul qilib bo'lmay qolardi). Qayta tekshiruv
    // yiqilsa — surat + yiqilgan tanlov bo'yicha (SENT tomonga, xavfsiz).
    const stillOnTheRoadIds = await this.findOnTheRoadOrderIdsInPost(id);
    const notReceivedOrderIds = failedSelectedOrderIds.filter(
      (orderId) => !stillOnTheRoadIds || stillOnTheRoadIds.has(orderId),
    );
    const hasRemainingReceivableOrders = stillOnTheRoadIds
      ? stillOnTheRoadIds.size > 0
      : remaining.length > 0 || notReceivedOrderIds.length > 0;
    post.status = hasRemainingReceivableOrders
      ? Post_status.SENT
      : Post_status.RECEIVED;
    const failedSelectedSet = new Set(failedSelectedOrderIds);
    const savedPost = await this.savePostWithArrivalNotification(
      post,
      arrivalStaffIds
        ? {
            staffIds: arrivalStaffIds,
            branch_id: targetBranchId ?? null,
            received_count: selectedOrders.filter(
              (order) => !failedSelectedSet.has(String(order.id)),
            ).length,
            order_count: allOrders.length,
          }
        : null,
    );
    void this.syncPostToSearch(savedPost);

    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: String(savedPost.id),
      action: ActivityAction.STATUS_CHANGE,
      new_value: { status: savedPost.status },
      ...this.auditActor(requester),
      metadata: {
        order_count: allOrders.length,
        branch_id: targetBranchId ?? null,
        courier_id: savedPost.courier_id,
        failed_order_count: failures.length,
        not_received_order_ids: notReceivedOrderIds.slice(0, 10),
      },
    });

    const waitingOrders = waitingOrderIds.length
      ? await Promise.all(
          waitingOrderIds.map((orderId) => this.findOrderById(orderId)),
        )
      : [];

    // `data` shakli o'zgarmaydi (qabul qilingan buyurtmalar ro'yxati).
    // `not_received_order_ids` — tanlangan, lekin hamon yo'lda qolgan
    // buyurtmalar: FE ularni "qabul qilindi" deb yashirmasligi kerak.
    return {
      ...successRes(
        waitingOrders,
        200,
        notReceivedOrderIds.length
          ? `Pochta qisman qabul qilindi: ${notReceivedOrderIds.length} ta buyurtmani qabul qilib bo'lmadi — qayta urinib ko'ring`
          : 'Post received successfully',
      ),
      failures,
      not_received_order_ids: notReceivedOrderIds,
    };
  }

  /**
   * (ePpLHPX2) Pochta holatini saqlaydi; filialga kelish bo'lsa
   * `logistics.batch_arrived` bildirishnomasini AYNAN shu tranzaksiyada
   * outbox'ga yozadi (rollback bo'lsa xabar ham yo'q).
   *
   * Bildirishnoma bo'lmasa (notifier ulanmagan, nishon yo'q, hech narsa
   * qabul qilinmagan) — avvalgidek oddiy `postRepo.save`.
   *
   * FAIL-OPEN. Tranzaksiya bildirishnoma tufayli yiqilsa (masalan
   * `outbox_events` yozilmadi) — u to'liq rollback qilinadi va pochta holati
   * bildirishnomasiz QAYTA saqlanadi: order yangilashlari allaqachon
   * bajarilgan, pochta holati esa bildirishnoma uchun qurbon qilinmaydi.
   * Xato pochta yozuvining o'zida bo'lsa — qayta urinish ham o'sha xatoni
   * qaytaradi (xulq avvalgidek).
   */
  private async savePostWithArrivalNotification(
    post: Post,
    arrival: {
      staffIds: Promise<string[]>;
      branch_id: string | null;
      received_count: number;
      order_count: number;
    } | null,
  ): Promise<Post> {
    const notifier = this.logisticsNotifications;
    const recipientIds = arrival ? await arrival.staffIds : [];
    if (
      !notifier ||
      !arrival ||
      arrival.received_count <= 0 ||
      !recipientIds.length
    ) {
      return this.postRepo.save(post);
    }

    try {
      return await this.postRepo.manager.transaction(async (manager) => {
        const saved = await manager.getRepository(Post).save(post);
        await notifier.onBatchArrived(
          {
            post_id: saved.id,
            branch_id: arrival.branch_id,
            received_count: arrival.received_count,
            order_count: arrival.order_count,
            status: saved.status,
            recipient_ids: recipientIds,
          },
          manager,
        );
        return saved;
      });
    } catch (err) {
      this.logger.warn(
        `receivePost: post=${post.id} bildirishnoma bilan saqlanmadi (rollback) — bildirishnomasiz qayta saqlanadi: ${
          (err as Error)?.message ?? err
        }`,
      );
      return this.postRepo.save(post);
    }
  }

  /**
   * LC-11 — pochtada hozir ON_THE_ROAD turgan buyurtmalar id lari. Yiqilsa
   * `null` (chaqiruvchi zaxira qoidaga o'tadi, javob yiqilmaydi).
   */
  private async findOnTheRoadOrderIdsInPost(
    postId: string,
  ): Promise<Set<string> | null> {
    try {
      const rows = await this.findOrders({
        post_id: postId,
        status: Order_status.ON_THE_ROAD,
        fetch_all: true,
        page: 1,
        limit: 1000,
      });
      return new Set(rows.map((order) => String(order.id)));
    } catch (error) {
      this.logger.warn(
        `receivePost: post=${postId} qayta tekshiruvi yiqildi — holat surat bo'yicha tanlandi: ${(error as Error)?.message ?? error}`,
      );
      return null;
    }
  }

  async reassignCourier(postId: string, courierId: string) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) {
      this.notFound('Post not found');
    }
    if (post.status !== Post_status.SENT) {
      this.badRequest('Only sent post can be reassigned');
    }
    if (post.courier_id === courierId) {
      this.badRequest('Post already assigned to this courier');
    }

    const courier = await this.findCourierById(courierId);
    if (!courier) {
      this.notFound('Courier not found');
    }

    const oldCourierId = post.courier_id;
    post.courier_id = courierId;
    const updatedPost = await this.postRepo.save(post);
    void this.syncPostToSearch(updatedPost);

    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: String(updatedPost.id),
      action: ActivityAction.ASSIGN,
      old_value: { courier_id: oldCourierId },
      new_value: { courier_id: courierId },
      metadata: {
        courier_id: courierId,
        old_courier_id: oldCourierId,
      },
    });

    return successRes(
      {
        post_id: updatedPost.id,
        old_courier_id: oldCourierId,
        new_courier_id: courierId,
      },
      200,
      'Post reassigned successfully',
    );
  }

  // ===== Pochta → Qaytarish (kuryer qaytarish so'rovlari) =====
  //
  // Qaytarish so'rovi — kuryer o'z pochtasidan QABUL QILMAGAN buyurtma
  // ("bu posilka menga yetib kelmadi"). Uni kuryer turgan ombor ko'rib
  // chiqadi: filial menejeri/registratori — o'z filiali kuryerlarini;
  // superadmin/admin va HQ registratori — HQ kuryerlarini. "Rad etilgan"
  // pochtalar bilan bir xil qoida: posilka javonga qaytdi deb tasdiqlovchi
  // odam javon turgan joyda bo'lishi kerak.

  private async resolveReturnRequestScope(
    requester?: RequesterContext,
  ): Promise<ReturnRequestScope> {
    if (this.isSystemPrivileged(requester)) {
      const hqBranchId = await this.findHqBranchId();
      return { type: 'HQ', branchId: hqBranchId, hqBranchId };
    }

    // Bitta filial, daraxtsiz: kuryer faqat HQ/REGIONAL/HYBRID filialda
    // bo'ladi va uning buyurtmalari o'z filialida turadi.
    const scopedBranchId = String(
      (await this.resolveScopedBranchId(requester)) ?? '',
    ).trim();
    if (!scopedBranchId) {
      this.forbidden('Foydalanuvchi branchga biriktirilmagan');
    }

    const hqBranchId = await this.findHqBranchId();
    return scopedBranchId === hqBranchId
      ? { type: 'HQ', branchId: hqBranchId, hqBranchId }
      : { type: 'BRANCH', branchId: scopedBranchId, hqBranchId };
  }

  /** Buyurtma turgan ombor: custody filiali (`holder_branch_id ?? branch_id`), bo'sh bo'lsa HQ. */
  private resolveReturnCustodyBranchId(
    order: OrderRow,
    hqBranchId: string,
  ): string {
    return this.getOrderBranchScope(order) || hqBranchId;
  }

  /**
   * Ko'rib chiqilmagan KURYER qaytarish so'rovi. Kuryersiz qatorlar
   * (HQ → filial pochtasining filial qabul qilmagan qoldig'i, HQ/filialdagi
   * initiate-return belgisi) bu ro'yxatga kirmaydi.
   */
  private isPendingCourierReturnRequest(order: OrderRow): boolean {
    return (
      order?.return_requested === true &&
      RETURN_REQUEST_STATUSES.some((status) => status === order.status) &&
      String(order.holder_type ?? '')
        .trim()
        .toUpperCase() === 'COURIER'
    );
  }

  /**
   * Har bir tanlangan buyurtma HECH NARSA yozilishidan OLDIN doiraga
   * tekshiriladi: bitta begona id — butun so'rov 403 (fail closed). Doira
   * so'rov belgisidan qat'i nazar tekshiriladi, shuning uchun begona buyurtmada
   * so'rov bor-yo'qligi oshkor bo'lmaydi.
   */
  private assertReturnRequestsInScope(
    orders: OrderRow[],
    scope: ReturnRequestScope,
  ): void {
    const hasForeignOrder = orders.some(
      (order) =>
        this.resolveReturnCustodyBranchId(order, scope.hqBranchId) !==
        scope.branchId,
    );
    if (!hasForeignOrder) {
      return;
    }

    this.forbidden(
      scope.type === 'HQ'
        ? "Bu buyurtma filial kuryerida — qaytarish so'rovini shu filial menejeri ko'rib chiqadi"
        : "Siz faqat o'z filialingiz kuryerlarining qaytarish so'rovlarini ko'rib chiqa olasiz",
    );
  }

  private normalizeReturnRequestOrderIds(dto?: ReceivePostDto): string[] {
    const orderIds = [
      ...new Set(
        (Array.isArray(dto?.order_ids) ? dto.order_ids : [])
          .map((id) => String(id ?? '').trim())
          .filter(Boolean),
      ),
    ];
    if (!orderIds.length) {
      this.badRequest("Qaytarish so'rovi uchun buyurtma tanlanmagan");
    }
    return orderIds;
  }

  /**
   * Tasdiqlangan buyurtmalar kuryerning manba pochtasidan chiqadi: hisoblagich
   * kamayadi (`GREATEST(..., 0)` — manfiyga tushmaydi). Pochta SENT bo'lib, unda
   * qabul qilinadigan (ON_THE_ROAD) buyurtma qolmagan bo'lsa — RECEIVED
   * (`receiveOrderWithScannerCourier` qoidasi). Aks holda kuryer pochtasi
   * abadiy SENT va shishgan hisob bilan qolardi.
   *
   * HAR BIR pochta ishlanadi: bitta pochtaning xatosi (xom DB xatosi ham,
   * order.find_all RpcException i ham) log qilinadi va qolganlari baribir
   * yangilanadi — qayta urinish ularni tuzata olmaydi (buyurtmalar endi
   * kutilayotgan so'rov emas, 404). Oxirida BITTA RpcException faqat yiqilgan
   * pochtalarni nomlaydi; xom xato tashqariga chiqmaydi, aks holda
   * executeAndAck xabarni qayta navbatga qo'yardi.
   */
  private async releaseReturnSourcePosts(
    deltas: Map<string, { count: number; total: number }>,
  ): Promise<void> {
    const failedPostIds: string[] = [];

    for (const [postId, delta] of deltas) {
      try {
        const count = Number.isFinite(delta.count) ? delta.count : 0;
        const total = Number.isFinite(delta.total) ? delta.total : 0;
        await this.postRepo
          .createQueryBuilder()
          .update(Post)
          .set({
            order_quantity: () => `GREATEST(order_quantity - ${count}, 0)`,
            post_total_price: () => `GREATEST(post_total_price - ${total}, 0)`,
          })
          .where('id = :id', { id: postId })
          .execute();

        const post = await this.postRepo.findOne({ where: { id: postId } });
        if (!post) {
          continue;
        }

        if (post.status === Post_status.SENT) {
          const remaining = await this.findOrders({
            post_id: postId,
            status: Order_status.ON_THE_ROAD,
            page: 1,
            limit: 10,
          });
          if (!remaining.length) {
            post.status = Post_status.RECEIVED;
            const savedPost = await this.postRepo.save(post);
            void this.syncPostToSearch(savedPost);
            continue;
          }
        }

        void this.syncPostToSearch(post);
      } catch (error) {
        this.logger.error(
          `releaseReturnSourcePosts failed for post=${postId}: ${(error as Error)?.message ?? error}`,
        );
        failedPostIds.push(postId);
      }
    }

    if (failedPostIds.length) {
      throw new RpcException(
        errorRes(
          `Buyurtmalar omborga qaytarildi, lekin kuryer pochtasi ${failedPostIds.map((id) => `#${id}`).join(', ')} hisobini yangilab bo'lmadi — administrator tekshirishi kerak`,
          500,
        ),
      );
    }
  }

  async getReturnRequests(requester?: RequesterContext) {
    const scope = await this.resolveReturnRequestScope(requester);
    const candidates = await this.findOrders({
      status: RETURN_REQUEST_STATUSES,
      return_requested: true,
      holder_type: 'COURIER',
      fetch_all: true,
      page: 1,
      limit: 1000,
    });

    // Doira shu yerda, custody bo'yicha: order.find_all ning `branch_id`
    // filtri (branch_id / holder_branch_id / home_branch_id — OR) kengroq.
    const orders = candidates.filter(
      (order) =>
        this.isPendingCourierReturnRequest(order) &&
        this.resolveReturnCustodyBranchId(order, scope.hqBranchId) ===
          scope.branchId,
    );

    // Kuryer — buyurtmani ushlab turgan kuryer (`holder_courier_id`). U yo'q
    // eski qatorlar uchun zaxira — buyurtma pochtasining kuryeri.
    const fallbackPostIds = [
      ...new Set(
        orders
          .filter((order) => !String(order.holder_courier_id ?? '').trim())
          .map((order) => String(order.post_id ?? '').trim())
          .filter(Boolean),
      ),
    ];
    const postCourierById = new Map<string, string>();
    if (fallbackPostIds.length) {
      try {
        const posts = await this.postRepo.find({
          where: { id: In(fallbackPostIds) },
        });
        for (const post of posts) {
          postCourierById.set(
            String(post.id),
            String(post.courier_id ?? '').trim(),
          );
        }
      } catch (error) {
        this.logger.error(
          `getReturnRequests post lookup failed: ${(error as Error)?.message ?? error}`,
        );
        throw new RpcException(
          errorRes(
            "Qaytarish so'rovlari pochtalarini o'qib bo'lmadi — birozdan so'ng qayta urinib ko'ring",
            503,
          ),
        );
      }
    }

    const courierIdOf = (order: OrderRow): string | null => {
      const courierId =
        String(order.holder_courier_id ?? '').trim() ||
        postCourierById.get(String(order.post_id ?? '').trim()) ||
        '';
      // '0' — filial/hudud pochtasi (kuryersiz).
      return courierId && courierId !== '0' ? courierId : null;
    };

    const courierMap = await this.findCouriersByIds(
      orders
        .map((order) => courierIdOf(order))
        .filter((id): id is string => Boolean(id)),
    );

    const groups = new Map<
      string,
      {
        courier: Record<string, unknown> | null;
        courier_id: string | null;
        orders: OrderRow[];
      }
    >();

    for (const order of orders) {
      const courierId = courierIdOf(order);
      const key = courierId ?? 'unknown';
      const group = groups.get(key) ?? {
        courier: courierId ? (courierMap.get(courierId) ?? null) : null,
        courier_id: courierId,
        orders: [],
      };
      group.orders.push(order);
      groups.set(key, group);
    }

    return successRes(
      {
        total: orders.length,
        scope: { type: scope.type, branch_id: scope.branchId },
        groups: Array.from(groups.values()),
      },
      200,
      "Qaytarish so'rovlari",
    );
  }

  /**
   * Tasdiqlash — buyurtma kuryerdan o'z omboriga qaytadi:
   * WAITING + kuryersiz + pochtasiz, `branch_id` = custody filiali. updateFull
   * shunda holder'ni BRANCH (filial) yoki HQ qiladi va COURIER → BRANCH/HQ
   * custody hodisasini yozadi. Bu filial HQ pochtasini qabul qilgandagi
   * holatning aynan o'zi — /dispatch uni qayta biriktira oladi.
   *
   * RECEIVED EMAS: WAITING/ON_THE_ROAD dan RECEIVED ga qonuniy o'tish yo'q.
   * Hudud NEW pochtasi EMAS: NEW pochtadagi WAITING buyurtma sendPost va
   * dispatchPostToBranch ni buzardi. `post_id: null` — eski kuryer nomidan
   * kutilayotgan sotuv/bekor tasdig'i keyin ishlab ketmasin.
   */
  async approveReturnRequests(
    dto: ReceivePostDto,
    requester?: RequesterContext,
  ) {
    const orderIds = this.normalizeReturnRequestOrderIds(dto);
    const scope = await this.resolveReturnRequestScope(requester);
    const orders = await Promise.all(
      orderIds.map((orderId) => this.findOrderById(orderId)),
    );
    this.assertReturnRequestsInScope(orders, scope);

    const eligibleOrders = orders.filter((order) =>
      this.isPendingCourierReturnRequest(order),
    );
    // Eskirgan tanlov (ikki marta bosish, kuryer shu orada qabul qilgan) —
    // o'tkazib yuboriladi va javobda qaytariladi.
    const skippedOrderIds = orders
      .filter((order) => !this.isPendingCourierReturnRequest(order))
      .map((order) => String(order.id));
    if (!eligibleOrders.length) {
      this.notFound(
        "Tanlangan buyurtmalarda ko'rib chiqilmagan qaytarish so'rovi topilmadi",
      );
    }

    const note =
      requester?.note ??
      (scope.type === 'HQ'
        ? "Qaytarish so'rovi tasdiqlandi — buyurtma kuryerdan HQ omboriga qaytarildi"
        : "Qaytarish so'rovi tasdiqlandi — buyurtma kuryerdan filial omboriga qaytarildi");
    const approvedOrderIds: string[] = [];
    const destinationBranchIds = new Set<string>();
    const postDeltas = new Map<string, { count: number; total: number }>();
    let updateError: RpcException | null = null;

    // CODE-10 — yangilanishlar RETURN_REQUEST_UPDATE_CONCURRENCY tadan
    // parallel (har biri alohida buyurtma, order-service da alohida
    // tranzaksiya). Ketma-ket 100+ buyurtma gateway'ning 8 s chegarasidan
    // oshib 504 berardi, ish esa orqada davom etardi.
    for (
      let start = 0;
      start < eligibleOrders.length && !updateError;
      start += RETURN_REQUEST_UPDATE_CONCURRENCY
    ) {
      const chunk = eligibleOrders.slice(
        start,
        start + RETURN_REQUEST_UPDATE_CONCURRENCY,
      );
      const custodyBranchIds = chunk.map((order) =>
        this.resolveReturnCustodyBranchId(order, scope.hqBranchId),
      );
      const results = await Promise.allSettled(
        chunk.map((order, index) =>
          this.updateOrder(
            String(order.id),
            {
              status: Order_status.WAITING,
              return_requested: false,
              courier_id: null,
              assigned_at: null,
              post_id: null,
              branch_id: custodyBranchIds[index],
            },
            {
              id: requester?.id ?? 'system',
              roles: requester?.roles ?? [],
              note,
            },
          ),
        ),
      );

      for (let index = 0; index < chunk.length; index += 1) {
        const order = chunk[index];
        const result = results[index];
        if (result.status === 'rejected') {
          // Bir nechta RPC — atomik emas. Shu bo'lakdan keyin to'xtaymiz,
          // lekin allaqachon qaytarilganlarning pochta hisobi pastda baribir
          // yangilanadi (aks holda qayta urinish ularni o'tkazib yuborib, hisob
          // abadiy noto'g'ri qolardi). Birinchi xato qaytadi; updateOrder faqat
          // RpcException tashlaydi, boshqasi ham o'raladi — xabar qayta
          // navbatga tushmasin.
          if (!updateError) {
            updateError =
              result.reason instanceof RpcException
                ? result.reason
                : new RpcException(
                    errorRes(`Order #${String(order.id)} update failed`, 502),
                  );
          }
          continue;
        }

        approvedOrderIds.push(String(order.id));
        destinationBranchIds.add(custodyBranchIds[index]);
        const sourcePostId = String(order.post_id ?? '').trim();
        if (sourcePostId) {
          const delta = postDeltas.get(sourcePostId) ?? { count: 0, total: 0 };
          delta.count += 1;
          delta.total += Number(order.total_price ?? 0);
          postDeltas.set(sourcePostId, delta);
        }
      }
    }

    if (approvedOrderIds.length) {
      await this.activityLog.log({
        // Subject is the returned Order(s); entity_id must be an Order id
        // (mirrors rejectReturnRequests). Source posts go in metadata.
        entity_type: 'Order',
        entity_id: approvedOrderIds[0],
        action: 'logistics.return_approve',
        ...this.auditActor(requester),
        metadata: {
          order_count: approvedOrderIds.length,
          order_ids: approvedOrderIds.slice(0, 10),
          source_post_ids: [...postDeltas.keys()].slice(0, 10),
          destination_branch_ids: [...destinationBranchIds],
          scope: scope.type,
        },
      });

      if (updateError) {
        // Asosiy xato muhimroq — hisoblagich xatosi uni yashirmasin (u
        // releaseReturnSourcePosts ichida log qilinadi).
        await this.releaseReturnSourcePosts(postDeltas).catch(() => undefined);
      } else {
        await this.releaseReturnSourcePosts(postDeltas);
      }
    }

    if (updateError) {
      throw updateError;
    }

    return successRes(
      {
        approved: approvedOrderIds.length,
        order_ids: approvedOrderIds,
        skipped_order_ids: skippedOrderIds,
      },
      200,
      "Qaytarish so'rovlari tasdiqlandi — buyurtmalar omborga qaytarildi",
    );
  }

  /**
   * Rad etish — buyurtma kuryerda qoladi: faqat belgi olinadi, holat va
   * custody o'zgarmaydi. ON_THE_ROAD qoldiq kuryerning SENT pochtasida qoladi
   * va kuryer uni baribir qabul qilishi kerak.
   */
  async rejectReturnRequests(
    dto: ReceivePostDto,
    requester?: RequesterContext,
  ) {
    const orderIds = this.normalizeReturnRequestOrderIds(dto);
    const scope = await this.resolveReturnRequestScope(requester);
    const orders = await Promise.all(
      orderIds.map((orderId) => this.findOrderById(orderId)),
    );
    this.assertReturnRequestsInScope(orders, scope);

    const eligibleOrders = orders.filter((order) =>
      this.isPendingCourierReturnRequest(order),
    );
    const skippedOrderIds = orders
      .filter((order) => !this.isPendingCourierReturnRequest(order))
      .map((order) => String(order.id));
    if (!eligibleOrders.length) {
      this.notFound(
        "Tanlangan buyurtmalarda ko'rib chiqilmagan qaytarish so'rovi topilmadi",
      );
    }

    const rejectedOrderIds: string[] = [];
    // CODE-10 — tasdiqlash bilan bir xil: bo'laklab parallel; birinchi xato
    // shu bo'lakdan keyin qaytadi (avvalgidek log yozilmaydi).
    for (
      let start = 0;
      start < eligibleOrders.length;
      start += RETURN_REQUEST_UPDATE_CONCURRENCY
    ) {
      const chunk = eligibleOrders.slice(
        start,
        start + RETURN_REQUEST_UPDATE_CONCURRENCY,
      );
      const results = await Promise.allSettled(
        chunk.map((order) =>
          this.updateOrder(
            String(order.id),
            { return_requested: false },
            {
              id: requester?.id ?? 'system',
              roles: requester?.roles ?? [],
              note:
                requester?.note ??
                "Qaytarish so'rovi rad etildi — buyurtma kuryerda qoldi",
            },
          ),
        ),
      );
      const failedIndex = results.findIndex(
        (result) => result.status === 'rejected',
      );
      if (failedIndex >= 0) {
        const reason = (results[failedIndex] as PromiseRejectedResult)
          .reason as unknown;
        throw reason instanceof RpcException
          ? reason
          : new RpcException(
              errorRes(
                `Order #${String(chunk[failedIndex].id)} update failed`,
                502,
              ),
            );
      }
      rejectedOrderIds.push(...chunk.map((order) => String(order.id)));
    }

    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: rejectedOrderIds[0],
      action: 'logistics.return_reject',
      ...this.auditActor(requester),
      metadata: {
        order_count: rejectedOrderIds.length,
        order_ids: rejectedOrderIds.slice(0, 10),
        scope: scope.type,
      },
    });

    return successRes(
      {
        rejected: rejectedOrderIds.length,
        order_ids: rejectedOrderIds,
        skipped_order_ids: skippedOrderIds,
      },
      200,
      "Qaytarish so'rovlari rad etildi — buyurtmalar kuryerda qoldi",
    );
  }

  async receivePostWithScanner(requester: RequesterContext, token: string) {
    const post = await this.postRepo.findOne({
      where: { qr_code_token: token, courier_id: requester.id },
    });
    if (!post) {
      this.notFound('Post not found');
    }
    if (post.status !== Post_status.SENT) {
      this.badRequest('Post can not be received');
    }

    const orders = await this.findOrders({
      post_id: post.id,
      status: Order_status.ON_THE_ROAD,
      page: 1,
      limit: 1000,
    });

    if (!orders.length) {
      this.notFound('There are not orders in this post');
    }

    // CODE-09 / C13 — skan bilan qabul qilingan posilka kuryer qo'lida:
    // eski qaytarish so'rovi belgisi tozalanadi (receivePost bilan bir xil),
    // aks holda u menejerning "Qaytarish" ro'yxatida so'rov bo'lib chiqib,
    // tasdiqlansa custody kuryerdan filialga o'tib ketardi.
    for (const order of orders) {
      await this.updateOrder(order.id, {
        status: Order_status.WAITING,
        return_requested: false,
      });
    }

    post.status = Post_status.RECEIVED;
    const savedPost = await this.postRepo.save(post);
    void this.syncPostToSearch(savedPost);

    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: String(savedPost.id),
      action: ActivityAction.STATUS_CHANGE,
      new_value: { status: Post_status.RECEIVED },
      ...this.auditActor(requester),
      metadata: {
        courier_id: savedPost.courier_id,
        order_count: orders.length,
      },
    });

    return successRes({}, 200, 'Post received successfully');
  }

  async receiveOrderWithScannerCourier(
    requester: RequesterContext,
    orderId: string,
  ) {
    const order = await this.findOrderById(orderId);
    if (!order.post_id) {
      this.notFound('Order has no post');
    }

    const post = await this.postRepo.findOne({
      where: { id: String(order.post_id), courier_id: requester.id },
    });
    if (!post) {
      this.notFound('Post not found or not assigned to this courier');
    }

    // CODE-09 / C13 — qaytarish so'rovi belgisi tozalanadi (yuqoriga qarang).
    await this.updateOrder(order.id, {
      status: Order_status.WAITING,
      return_requested: false,
    });

    const remaining = await this.findOrders({
      post_id: post.id,
      status: Order_status.ON_THE_ROAD,
      page: 1,
      limit: 1,
    });

    let postReceived = false;
    if (!remaining.length) {
      post.status = Post_status.RECEIVED;
      const savedPost = await this.postRepo.save(post);
      void this.syncPostToSearch(savedPost);
      postReceived = true;
    }

    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: String(order.id),
      action: ActivityAction.STATUS_CHANGE,
      new_value: { status: Order_status.WAITING },
      ...this.auditActor(requester),
      metadata: {
        courier_id: post.courier_id,
        post_id: String(post.id),
        post_received: postReceived,
      },
    });

    return successRes({}, 200, 'Order received');
  }

  /**
   * CODE-25 — buyurtma HQ hudud NEW pochtasidan kuryer pochtasiga o'tdi: NEW
   * pochtaning saqlangan hisobi kamayadi (`GREATEST(..., 0)`, atomik). Faqat
   * NEW pochta — SENT/RECEIVED pochtaning hisobi tarix (necha posilka shu
   * pochtada kelgan) va o'zgarmaydi. Xato skan natijasini buzmaydi: buyurtma
   * allaqachon kuryerda, hisob esa order.post_id dan qayta hisoblanadi.
   */
  private async releaseOrderFromNewRegionPost(order: OrderRow): Promise<void> {
    const oldPostId = String(order.post_id ?? '').trim();
    if (!oldPostId) {
      return;
    }
    try {
      const oldPost = await this.postRepo.findOne({ where: { id: oldPostId } });
      if (!oldPost || oldPost.status !== Post_status.NEW) {
        return;
      }
      const delta = Number(order.total_price ?? 0);
      await this.postRepo
        .createQueryBuilder()
        .update(Post)
        .set({
          order_quantity: () => 'GREATEST(order_quantity - 1, 0)',
          post_total_price: () =>
            `GREATEST(post_total_price - ${Number.isFinite(delta) ? delta : 0}, 0)`,
        })
        .where('id = :id', { id: oldPostId })
        .execute();
    } catch (err) {
      this.logger.warn(
        `NEW post counter release failed for post=${oldPostId} order=${order.id}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  async scanAssignOrder(
    requester: RequesterContext,
    dto: { qr_token: string },
  ) {
    const qrToken = String(dto?.qr_token ?? '').trim();
    if (!qrToken) {
      this.badRequest('qr_token is required');
    }

    let order = await this.findOrderByQrToken(qrToken);
    const courierAssignment = await this.findCourierAssignment(requester);
    const courierBranchId = courierAssignment.branchId;
    let orderBranchId = String(order.branch_id ?? '').trim();

    if (!orderBranchId) {
      this.badRequest('Order filialga biriktirilmagan');
    }

    const requesterId = String(requester.id);
    const isHqCourier = await this.isHqCourierAssignment(courierAssignment);

    if (isHqCourier) {
      // ITEM 5 — HQ KURYERI FAQAT HQ QABUL QILGAN, HQ DA TURGAN BUYURTMANI OLADI.
      //
      // Tekshiruv HAR QANDAY yozuvdan OLDIN: NEW buyurtma NEW bo'lib qoladi
      // (status, pochta, hisoblagich, log — hech biri yozilmaydi). Pastdagi
      // NEW → RECEIVED avto-qabul HQ kuryeriga yetib bormaydi, P1b esa HQ
      // kuryeri uchun umuman chaqirilmaydi: HQ ga kelgan paketni HQ xodimi
      // qabul qiladi, kuryer skani emas.
      const orderPost = order.post_id
        ? await this.postRepo.findOne({ where: { id: String(order.post_id) } })
        : null;
      const rejection = assessHqCourierScan({
        order,
        orderPost,
        hqBranchId: courierBranchId,
        requesterId,
      });
      if (rejection) {
        throw new RpcException(
          errorRes(rejection.message, rejection.statusCode),
        );
      }
    } else if (orderBranchId !== courierBranchId) {
      // P1b — SKAN BILAN AVTOMATIK FILIAL QABULI (faqat filial kuryeri;
      // HQ kuryeri bu yo'ldan hech qachon foydalanmaydi — yuqoriga qarang).
      //
      // Buyurtma HQ'dan kuryer filialiga paket bilan jo'natilgan bo'lsa, uning
      // `branch_id`'si HAMON jo'natuvchi filial bo'ladi (u faqat filial paketni
      // qabul qilganda o'zgaradi). Ilgari kuryer bunday buyurtmani skan qilsa
      // "boshqa filial orderi" xatosini olardi va filial menejeri paketni qabul
      // qilmaguncha ishlay olmasdi.
      //
      // Endi skanning o'zi filial qabulini ham bajaradi — bitta amal, lekin
      // daftarda IKKI bo'g'in (HQ → FILIAL → KURYER), ya'ni mas'uliyat zanjiri
      // uzilmaydi. Guardlar order-service tomonida (paket SENT, manzil = shu
      // filial, yo'nalish FORWARD) — busiz kuryer yetib kelmagan posilkani
      // o'ziga yozib olishi mumkin bo'lardi.
      const scanReceive = await this.receiveOrderIntoBranchByScan(
        String(order.id),
        courierBranchId,
        requester,
      );
      if (!scanReceive.received) {
        if (scanReceive.reason === 'transit') {
          this.badRequest(
            "Bu buyurtma boshqa hudud uchun (tranzit) — u filialga qabul qilindi, lekin kuryerga berilmaydi: filial uni o'sha hududga qayta jo'natadi",
          );
        }
        this.forbidden('Boshqa filial orderi — qabul qila olmaysiz');
      }

      // Qabuldan keyin status va filial o'zgardi — yangi holatni O'QISH SHART,
      // aks holda quyidagi status guardi eski `ON_THE_ROAD`ni ko'radi.
      //
      // ATAYLAB `findOrderByQrToken` (o'sha token bilan), `findOrderById` EMAS:
      // faqat birinchisida javob qobig'ini ochish mantiqi bor
      // (`data.data` / `data` / xom), ikkinchisi xom javobni qaytaradi.
      order = await this.findOrderByQrToken(qrToken);
      orderBranchId = String(order.branch_id ?? '').trim();
      if (orderBranchId !== courierBranchId) {
        this.forbidden('Boshqa filial orderi — qabul qila olmaysiz');
      }
    }

    const currentCourierId = String(order.courier_id ?? '').trim();
    if (currentCourierId && currentCourierId !== requesterId) {
      this.badRequest('Order allaqachon boshqa courierga biriktirilgan');
    }

    const currentStatus = order.status;
    const isAlreadyAssignedToCurrentCourier =
      currentCourierId === requesterId &&
      currentStatus === Order_status.ON_THE_ROAD;

    if (!isAlreadyAssignedToCurrentCourier) {
      if (
        currentStatus !== Order_status.NEW &&
        currentStatus !== Order_status.RECEIVED &&
        currentStatus !== Order_status.WAITING_CUSTOMER
      ) {
        this.badRequest(
          "Order holati noto'g'ri: faqat NEW, RECEIVED yoki WAITING_CUSTOMER bo'lishi kerak",
        );
      }
    }

    let targetPost: Post | null = null;
    if (order.post_id) {
      targetPost = await this.postRepo.findOne({
        where: { id: String(order.post_id), courier_id: requesterId },
      });
    }

    if (!targetPost) {
      targetPost = await this.postRepo.findOne({
        where: { courier_id: requesterId, status: Post_status.SENT },
        order: { createdAt: 'DESC' },
      });
    }

    // CODE-25 — idempotent javob pochta YARATILISHIDAN OLDIN qaytadi. Ilgari
    // kuryerda SENT pochta bo'lmasa, qayta skan bo'sh SENT pochta yaratib
    // qo'yardi (buyurtma unga biriktirilmasdi — abadiy bo'sh pochta).
    if (isAlreadyAssignedToCurrentCourier) {
      return successRes(
        {
          idempotent: true,
          order_id: String(order.id),
          post_id:
            targetPost?.id ?? (String(order.post_id ?? '').trim() || null),
          post_created: false,
        },
        200,
        'Order already assigned to this courier',
      );
    }

    const createdNewPost = !targetPost;
    if (!targetPost) {
      const created = this.postRepo.create({
        courier_id: requesterId,
        region_id: order.region_id ? String(order.region_id) : null,
        order_quantity: 0,
        post_total_price: 0,
        qr_code_token: this.generateToken(),
        status: Post_status.SENT,
      });
      targetPost = await this.postRepo.save(created);
      void this.syncPostToSearch(targetPost);
    }

    if (currentStatus === Order_status.NEW) {
      await this.updateOrder(
        String(order.id),
        { status: Order_status.RECEIVED },
        {
          id: requesterId,
          roles: requester.roles ?? [Roles.COURIER],
          note: "Order skan orqali courierga biriktirish oldidan RECEIVED holatiga o'tkazildi",
        },
      );
    }

    await this.updateOrder(
      String(order.id),
      {
        courier_id: requesterId,
        assigned_at: new Date().toISOString(),
        status: Order_status.ON_THE_ROAD,
        post_id: targetPost.id,
      },
      {
        id: requesterId,
        roles: requester.roles ?? [Roles.COURIER],
        note: 'Order skan orqali courierga biriktirildi',
      },
    );

    const alreadyInTargetPost =
      String(order.post_id ?? '') === String(targetPost.id);
    if (!alreadyInTargetPost) {
      // Atomic UPDATE — read-modify-write would lose increments under
      // concurrent scans for the same post (two couriers, two QR scans).
      const delta = Number(order.total_price ?? 0);
      try {
        await this.postRepo
          .createQueryBuilder()
          .update(Post)
          .set({
            order_quantity: () => 'order_quantity + 1',
            post_total_price: () =>
              `post_total_price + ${Number.isFinite(delta) ? delta : 0}`,
          })
          .where('id = :id', { id: targetPost.id })
          .execute();
        const refreshedPost = await this.postRepo.findOne({
          where: { id: targetPost.id },
        });
        if (refreshedPost) {
          void this.syncPostToSearch(refreshedPost);
        }
      } catch (err) {
        // Order has already been transitioned to ON_THE_ROAD; counter drift
        // here is recoverable from order.post_id (computed on demand). Log
        // so ops can spot persistent failures.
        this.logger.warn(
          `Post counter update failed for post=${targetPost.id} order=${order.id}: ${(err as Error)?.message ?? err}`,
        );
      }
      await this.releaseOrderFromNewRegionPost(order);
    }

    await this.activityLog.log({
      entity_type: 'Order',
      entity_id: String(order.id),
      action: ActivityAction.ASSIGN,
      new_value: { courier_id: requesterId, post_id: String(targetPost.id) },
      ...this.auditActor(requester),
      metadata: {
        courier_id: requesterId,
        post_id: String(targetPost.id),
        branch_id: orderBranchId,
        post_created: createdNewPost,
      },
    });

    return successRes(
      {
        idempotent: false,
        order_id: String(order.id),
        post_id: targetPost.id,
        post_created: createdNewPost,
      },
      200,
      'Order courierga biriktirildi',
    );
  }

  async assignOrdersToCourier(
    requester: RequesterContext,
    dto: { order_ids: string[]; courier_id: string },
  ) {
    const orderIds = Array.from(
      new Set(
        (dto?.order_ids ?? []).map((id) => String(id).trim()).filter(Boolean),
      ),
    );
    const courierId = String(dto?.courier_id ?? '').trim();

    if (!orderIds.length) {
      this.badRequest('order_ids bo‘sh bo‘lishi mumkin emas');
    }
    if (!courierId) {
      this.badRequest('courier_id is required');
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const requesterAssignment = await this.findBranchAssignmentByUserId(
      requesterId,
      requester,
    );
    const requesterBranchId = String(
      requesterAssignment?.branch_id ?? '',
    ).trim();
    const requesterBranchRole = String(requesterAssignment?.role ?? '')
      .trim()
      .toUpperCase();

    if (!requesterBranchId) {
      this.forbidden('Manager yoki registrator filialga biriktirilmagan');
    }
    if (
      requesterBranchRole !== 'MANAGER' &&
      requesterBranchRole !== 'REGISTRATOR'
    ) {
      this.forbidden(
        'Faqat MANAGER yoki REGISTRATOR orderlarni courierga ommaviy biriktira oladi',
      );
    }

    const branchUsers = await this.findBranchUsersByBranchId(
      requesterBranchId,
      requester,
    );
    const courierInBranch = branchUsers.find(
      (item) =>
        String(item?.user_id ?? '').trim() === courierId &&
        String(item?.role ?? '')
          .trim()
          .toUpperCase() === 'COURIER',
    );

    if (!courierInBranch) {
      this.badRequest(
        'Courier ushbu filialga COURIER sifatida biriktirilmagan',
      );
    }

    const orders = await Promise.all(
      orderIds.map((id) => this.findOrderById(id)),
    );

    const resolveOrderBranchScope = (order: {
      holder_branch_id?: string | null;
      branch_id?: string | null;
    }) => String(order?.holder_branch_id ?? order?.branch_id ?? '').trim();

    const firstBranchId = resolveOrderBranchScope(orders[0]);
    if (!firstBranchId) {
      this.badRequest('Order(lar) filialga biriktirilmagan');
    }

    if (firstBranchId !== requesterBranchId) {
      this.forbidden(
        "Manager/registrator faqat o'z filiali orderlarini biriktira oladi",
      );
    }

    const hasMixedBranch = orders.some(
      (order) => resolveOrderBranchScope(order) !== firstBranchId,
    );
    if (hasMixedBranch) {
      this.badRequest(
        'Orderlar aralash filialdan: faqat bitta filial orderlarini tanlang',
      );
    }

    const invalidStatusOrder = orders.find(
      (order) =>
        order.status !== Order_status.NEW &&
        order.status !== Order_status.RECEIVED &&
        order.status !== Order_status.WAITING,
    );
    if (invalidStatusOrder) {
      this.badRequest(
        `Order #${invalidStatusOrder.id} holati noto'g'ri: faqat NEW, RECEIVED yoki WAITING bo'lishi kerak`,
      );
    }

    const assignedToAnotherCourier = orders.find((order) => {
      const currentCourierId = String(order?.courier_id ?? '').trim();
      return currentCourierId && currentCourierId !== courierId;
    });
    if (assignedToAnotherCourier) {
      this.badRequest(
        `Order #${assignedToAnotherCourier.id} allaqachon boshqa courierga biriktirilgan`,
      );
    }

    // CODE-11 — tashqi manbadan (hamkor) kelgan NEW posilka bu yerda avto-qabul
    // (NEW → RECEIVED) qilinmaydi: u faqat skan bilan qabul qilinadi (HQ
    // intake'dagi qoida bilan bir xil). Aks holda skan darvozasi chetlab
    // o'tilardi. Tekshiruv HECH NARSA yozilmasdan oldin.
    const unscannedExternalOrder = orders.find(
      (order) =>
        order.status === Order_status.NEW &&
        String(order.source ?? '')
          .trim()
          .toLowerCase() === 'external',
    );
    if (unscannedExternalOrder) {
      this.badRequest(
        `Order #${unscannedExternalOrder.id} tashqi manbadan kelgan va hali qabul qilinmagan — avval skanerlab qabul qiling (Kiruvchi posilkalar ekrani)`,
      );
    }

    // CODE-11 — o'chirilgan yoki faol bo'lmagan (bloklangan) kuryerga buyurtma
    // berilmaydi: u ilovaga kira olmaydi va posilkalar unda qotib qolardi.
    // Identity javob bermasa tekshiruv o'tkazib yuboriladi (filial a'zoligi
    // yuqorida allaqachon tekshirilgan) — bu yangi qo'shimcha to'siq.
    const courierStatus = await this.findCourierStatus(courierId);
    if (courierStatus && !courierStatus.found) {
      this.badRequest(
        "Kuryer topilmadi yoki o'chirilgan — unga buyurtma biriktirib bo'lmaydi",
      );
    }
    if (
      courierStatus?.found &&
      courierStatus.status &&
      courierStatus.status !== 'active'
    ) {
      this.badRequest("Kuryer faol emas — unga buyurtma biriktirib bo'lmaydi");
    }

    let targetPost = await this.postRepo.findOne({
      where: { courier_id: courierId, status: Post_status.SENT },
      order: { createdAt: 'DESC' },
    });

    const createdNewPost = !targetPost;
    if (!targetPost) {
      targetPost = await this.postRepo.save(
        this.postRepo.create({
          courier_id: courierId,
          region_id: orders[0]?.region_id ? String(orders[0].region_id) : null,
          order_quantity: 0,
          post_total_price: 0,
          qr_code_token: this.generateToken(),
          status: Post_status.SENT,
        }),
      );
      void this.syncPostToSearch(targetPost);
    }

    const updatedOrderSnapshots: Array<{
      id: string;
      previous: {
        courier_id: string | null;
        assigned_at: string | Date | null;
        status: Order_status | undefined;
        post_id: string | null;
      };
    }> = [];

    let affectedCount = 0;
    let affectedTotal = 0;

    try {
      for (const order of orders) {
        const orderId = String(order.id);
        const previous = {
          courier_id: order.courier_id ?? null,
          assigned_at: order.assigned_at ?? null,
          status: order.status,
          post_id: order.post_id ?? null,
        };

        if (order.status === Order_status.NEW) {
          await this.updateOrder(
            orderId,
            { status: Order_status.RECEIVED },
            {
              id: requesterId,
              roles: requester.roles ?? [Roles.BRANCH],
              note: 'Bulk assign oldidan NEW -> RECEIVED',
            },
          );
        }

        await this.updateOrder(
          orderId,
          {
            courier_id: courierId,
            assigned_at: new Date().toISOString(),
            status: Order_status.ON_THE_ROAD,
            post_id: targetPost.id,
          },
          {
            id: requesterId,
            roles: requester.roles ?? [Roles.BRANCH],
            note: 'Manager tomonidan ommaviy courier biriktirish',
          },
        );

        updatedOrderSnapshots.push({ id: orderId, previous });
        affectedCount += 1;
        affectedTotal += Number(order.total_price ?? 0);
      }

      targetPost.order_quantity =
        Number(targetPost.order_quantity ?? 0) + affectedCount;
      targetPost.post_total_price =
        Number(targetPost.post_total_price ?? 0) + affectedTotal;
      const savedPost = await this.postRepo.save(targetPost);
      void this.syncPostToSearch(savedPost);
    } catch (error) {
      for (const snapshot of updatedOrderSnapshots) {
        try {
          await this.updateOrder(
            snapshot.id,
            {
              courier_id: snapshot.previous.courier_id,
              assigned_at: snapshot.previous.assigned_at,
              status: snapshot.previous.status,
              post_id: snapshot.previous.post_id,
            },
            {
              id: requesterId,
              roles: requester.roles ?? [Roles.BRANCH],
              note: 'Bulk assign rollback',
            },
          );
        } catch {
          // best effort rollback
        }
      }

      if (createdNewPost && targetPost?.id) {
        try {
          await this.postRepo.remove(targetPost);
        } catch {
          // ignore cleanup failures
        }
      }

      throw error;
    }

    await this.activityLog.log({
      // The post is the single mutated aggregate here; the assigned orders live
      // in metadata. entity_id is a Post id, so entity_type must be 'Post'.
      entity_type: 'Post',
      entity_id: String(targetPost.id),
      action: ActivityAction.ASSIGN,
      ...this.auditActor(requester),
      metadata: {
        courier_id: courierId,
        order_count: orderIds.length,
        order_ids: orderIds.slice(0, 10),
        branch_id: requesterBranchId,
        post_id: String(targetPost.id),
        post_created: createdNewPost,
      },
    });

    return successRes(
      {
        order_ids: orderIds,
        courier_id: courierId,
        post_id: targetPost.id,
        post_created: createdNewPost,
        assigned_count: orderIds.length,
      },
      200,
      'Orderlar courierga biriktirildi',
    );
  }

  async createCanceledPost(requester: RequesterContext, dto: ReceivePostDto) {
    const isManager = (requester.roles ?? []).some(
      (role) => String(role).toLowerCase() === Roles.MANAGER,
    );
    if (isManager) {
      return this.createCanceledPostToHq(requester, dto);
    }

    const orderIds = [...new Set(dto.order_ids ?? [])];
    if (!orderIds.length) {
      this.badRequest('No orders provided');
    }
    const courierBranchId = await this.findCourierBranchId(requester);
    let canceledPost = await this.postRepo.findOne({
      where: {
        courier_id: requester.id,
        branch_id: courierBranchId,
        status: Post_status.CANCELED,
      },
    });

    const orders: OrderRow[] = [];
    for (const orderId of orderIds) {
      const order = await this.findOrderById(orderId);
      if (!this.isCancelledPostEligibleOrder(order.status)) {
        this.badRequest('Some orders are not in CANCELED status');
      }
      if (
        this.isCancelledOrder(order.status) &&
        !this.isCancelledOrderOwnedByCourier(
          order,
          requester.id,
          courierBranchId,
        )
      ) {
        this.forbidden(
          'Courier faqat o‘ziga biriktirilgan bekor qilingan orderlarni jo‘nata oladi',
        );
      }
      orders.push(order);
    }

    const ordersToSend: OrderRow[] = [];
    const ordersToRepair: OrderRow[] = [];
    for (const order of orders) {
      const alreadyInActivePost = await this.isOrderInActiveCanceledPost(
        order,
        canceledPost,
        requester.id,
        courierBranchId,
      );
      if (!alreadyInActivePost) {
        ordersToSend.push(order);
      } else if (
        this.shouldRepairCanceledPostOrderHolder(order, courierBranchId)
      ) {
        ordersToRepair.push(order);
      }
    }

    for (const order of ordersToRepair) {
      await this.updateOrder(
        order.id,
        {
          canceled_post_id: canceledPost?.id ?? order.canceled_post_id,
          status: Order_status.CANCELLED_SENT,
          branch_id: courierBranchId,
          courier_id: null,
          assigned_at: null,
        },
        {
          id: requester.id,
          roles: requester.roles ?? [Roles.COURIER],
          note: 'Canceled post holder repaired',
        },
      );
    }

    if (!ordersToSend.length) {
      return successRes(
        {
          post_id:
            canceledPost?.id ??
            orders.find((order) => order.canceled_post_id)?.canceled_post_id ??
            null,
          order_ids: orderIds,
        },
        200,
        'Canceled orders already sent to courier branch',
      );
    }

    if (!canceledPost) {
      canceledPost = await this.postRepo.save(
        this.postRepo.create({
          courier_id: requester.id,
          branch_id: courierBranchId,
          region_id: orders.find((o) => o.region_id)?.region_id ?? null,
          post_total_price: 0,
          order_quantity: 0,
          qr_code_token: this.generateToken(),
          status: Post_status.CANCELED,
        }),
      );
      void this.syncPostToSearch(canceledPost);
    }

    let addedTotal = 0;
    for (const order of ordersToSend) {
      await this.updateOrder(
        order.id,
        {
          canceled_post_id: canceledPost.id,
          status: Order_status.CANCELLED_SENT,
          branch_id: courierBranchId,
          courier_id: null,
          assigned_at: null,
        },
        {
          id: requester.id,
          roles: requester.roles ?? [Roles.COURIER],
          note: 'Canceled post created',
        },
      );
      addedTotal += Number(order.total_price ?? 0);
    }

    canceledPost.order_quantity =
      Number(canceledPost.order_quantity ?? 0) + ordersToSend.length;
    canceledPost.post_total_price =
      Number(canceledPost.post_total_price ?? 0) + addedTotal;
    const savedCanceledPost = await this.postRepo.save(canceledPost);
    void this.syncPostToSearch(savedCanceledPost);

    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: String(savedCanceledPost.id),
      action: ActivityAction.CREATED,
      ...this.auditActor(requester),
      metadata: {
        courier_id: requester?.id ?? null,
        order_count: orders.length,
        order_ids: orderIds.slice(0, 10),
        canceled: true,
        branch_id: courierBranchId,
      },
    });

    return successRes(
      { post_id: canceledPost.id, order_ids: orderIds },
      200,
      'Canceled orders successfully sent to courier branch',
    );
  }

  async createCanceledPostToHq(
    requester: RequesterContext,
    dto: ReceivePostDto,
  ) {
    const isManager = (requester.roles ?? []).some(
      (role) => String(role).toLowerCase() === Roles.MANAGER,
    );
    if (!isManager) {
      this.forbidden('Canceled postni HQga faqat manager jo‘nata oladi');
    }

    const sourceBranchId = await this.resolveScopedBranchId(requester);
    if (!sourceBranchId) {
      this.forbidden('Manager branchga biriktirilmagan');
    }
    const hqBranchId = await this.findHqBranchId();
    if (sourceBranchId === hqBranchId) {
      this.badRequest('HQ manager canceled postni o‘ziga jo‘nata olmaydi');
    }

    const orderIds = [...new Set(dto.order_ids ?? [])];
    if (!orderIds.length) {
      this.badRequest('No orders provided');
    }

    let canceledPost = await this.postRepo.findOne({
      where: {
        courier_id: requester.id,
        branch_id: hqBranchId,
        status: Post_status.CANCELED,
      },
    });

    const orders: OrderRow[] = [];
    for (const orderId of orderIds) {
      const order = await this.findOrderById(orderId);
      if (!this.isCancelledPostEligibleOrder(order.status)) {
        this.badRequest('Some orders are not in CANCELED status');
      }
      if (
        this.isCancelledOrder(order.status) &&
        (String(order.holder_branch_id ?? order.branch_id ?? '').trim() !==
          sourceBranchId ||
          (order.holder_type && order.holder_type !== 'BRANCH'))
      ) {
        this.forbidden(
          'Manager faqat o‘z branchidagi bekor qilingan orderlarni HQga jo‘nata oladi',
        );
      }
      if (
        this.isCancelledSentOrder(order.status) &&
        !(await this.isOrderInActiveCanceledPost(
          order,
          canceledPost,
          requester.id,
          hqBranchId,
        ))
      ) {
        this.forbidden(
          'Jo‘natilgan bekor order managerning faol HQ postiga tegishli emas',
        );
      }
      orders.push(order);
    }

    const ordersToSend: OrderRow[] = [];
    const ordersToRepair: OrderRow[] = [];
    for (const order of orders) {
      const alreadyInActivePost = await this.isOrderInActiveCanceledPost(
        order,
        canceledPost,
        requester.id,
        hqBranchId,
      );
      if (!alreadyInActivePost) {
        ordersToSend.push(order);
      } else if (this.shouldRepairCanceledPostOrderHolder(order, hqBranchId)) {
        ordersToRepair.push(order);
      }
    }

    for (const order of ordersToRepair) {
      await this.updateOrder(
        order.id,
        {
          canceled_post_id: canceledPost?.id ?? order.canceled_post_id,
          status: Order_status.CANCELLED_SENT,
          branch_id: hqBranchId,
          courier_id: null,
          assigned_at: null,
        },
        {
          id: requester.id,
          roles: requester.roles ?? [Roles.MANAGER],
          note: 'Canceled post holder repaired',
        },
      );
    }

    if (!ordersToSend.length) {
      return successRes(
        {
          post_id:
            canceledPost?.id ??
            orders.find((order) => order.canceled_post_id)?.canceled_post_id ??
            null,
          order_ids: orderIds,
        },
        200,
        'Canceled orders already sent to HQ',
      );
    }

    if (!canceledPost) {
      canceledPost = await this.postRepo.save(
        this.postRepo.create({
          courier_id: requester.id,
          branch_id: hqBranchId,
          region_id: orders.find((order) => order.region_id)?.region_id ?? null,
          post_total_price: 0,
          order_quantity: 0,
          qr_code_token: this.generateToken(),
          status: Post_status.CANCELED,
        }),
      );
    }

    let addedTotal = 0;
    for (const order of ordersToSend) {
      await this.updateOrder(
        order.id,
        {
          canceled_post_id: canceledPost.id,
          status: Order_status.CANCELLED_SENT,
          branch_id: hqBranchId,
          courier_id: null,
          assigned_at: null,
        },
        {
          id: requester.id,
          roles: requester.roles ?? [Roles.MANAGER],
          note: 'Branch canceled post sent to HQ',
        },
      );
      addedTotal += Number(order.total_price ?? 0);
    }

    canceledPost.order_quantity =
      Number(canceledPost.order_quantity ?? 0) + ordersToSend.length;
    canceledPost.post_total_price =
      Number(canceledPost.post_total_price ?? 0) + addedTotal;
    const savedPost = await this.postRepo.save(canceledPost);
    void this.syncPostToSearch(savedPost);

    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: String(savedPost.id),
      action: ActivityAction.CREATED,
      ...this.auditActor(requester),
      metadata: {
        source_branch_id: sourceBranchId,
        destination_branch_id: hqBranchId,
        order_count: orders.length,
        order_ids: orderIds.slice(0, 10),
        canceled: true,
      },
    });

    return successRes(
      {
        post_id: savedPost.id,
        order_ids: orderIds,
        source_branch_id: sourceBranchId,
        destination_branch_id: hqBranchId,
      },
      200,
      'Canceled orders sent to HQ post',
    );
  }

  private async requeueUnreceivedCanceledOrders(params: {
    sourcePost: Post;
    orders: OrderRow[];
    targetBranchId: string;
    fallbackBranchId?: string | null;
    isHqReceipt: boolean;
    /**
     * Qabul qilinmagan posilka jo'natuvchi KURYERGA qaytadimi (custody =
     * kuryer). Filial qabulida — doim (kuryer → filial pochtasi). HQ qabulida —
     * faqat jo'natuvchi HQ kuryeri bo'lsa; menejer jo'natgan bo'lsa posilka
     * uning filialiga qaytadi, kuryer biriktirilmaydi.
     */
    returnToCourier: boolean;
    requester: RequesterContext;
  }): Promise<string[]> {
    const {
      sourcePost,
      orders,
      targetBranchId,
      fallbackBranchId,
      isHqReceipt,
      returnToCourier,
      requester,
    } = params;
    const requeuedPostIds = new Set<string>();
    const groups = new Map<
      string,
      {
        branchId: string;
        regionId: string | null;
        orders: OrderRow[];
      }
    >();

    for (const order of orders) {
      const regionId =
        String(order.region_id ?? sourcePost.region_id ?? '').trim() || null;
      // LC-06 — HQ ga yuborilgan bekor pochta JO'NATILGANDA buyurtma allaqachon
      // HQ ga yoziladi (branch_id = HQ, holder HQ). Shuning uchun HQ doirasi
      // jo'natuvchini ko'rsatmaydi: qabul qilinmagan posilka jo'natuvchining
      // filialiga (fallbackBranchId) qaytadi. Buyurtmada HQ dan boshqa filial
      // doirasi bo'lsa (jo'natishdan oldingi eski holat) — u ustun, avvalgidek.
      // Jo'natuvchi aniqlanmasa — HQ da qoladi (avvalgi xatti-harakat).
      const orderScope = this.getOrderBranchScope(order);
      const orderNonHqScope =
        orderScope && orderScope !== String(targetBranchId).trim()
          ? orderScope
          : '';
      const branchId = isHqReceipt
        ? String(
            orderNonHqScope ||
              String(fallbackBranchId ?? '').trim() ||
              sourcePost.branch_id ||
              targetBranchId,
          ).trim()
        : String(sourcePost.branch_id ?? targetBranchId).trim();
      if (!branchId) {
        this.badRequest(
          'Qolgan bekor qilingan orderlarni qaytarish uchun branch aniqlanmadi',
        );
      }
      const key = `${branchId || 'none'}:${regionId || 'none'}`;
      const group = groups.get(key) ?? { branchId, regionId, orders: [] };
      group.orders.push(order);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      let returnPost = await this.postRepo.findOne({
        where: {
          id: Not(sourcePost.id),
          courier_id: sourcePost.courier_id,
          branch_id: group.branchId,
          region_id: group.regionId,
          status: Post_status.CANCELED,
        } as any,
      });

      if (!returnPost) {
        returnPost = await this.postRepo.save(
          this.postRepo.create({
            courier_id: sourcePost.courier_id,
            branch_id: group.branchId,
            region_id: group.regionId,
            post_total_price: 0,
            order_quantity: 0,
            qr_code_token: this.generateToken(),
            status: Post_status.CANCELED,
          }),
        );
      }

      let returnedTotal = 0;
      for (const order of group.orders) {
        await this.updateOrder(
          order.id,
          {
            status: Order_status.CANCELLED_SENT,
            branch_id: group.branchId,
            courier_id: returnToCourier ? sourcePost.courier_id : null,
            assigned_at: null,
            canceled_post_id: returnPost.id,
          },
          {
            id: requester.id,
            roles: requester.roles ?? [Roles.MANAGER],
            note: isHqReceipt
              ? returnToCourier
                ? 'Canceled order returned to courier after partial HQ receive'
                : 'Canceled order returned to branch after partial HQ receive'
              : 'Canceled order returned to courier after partial branch receive',
          },
        );
        returnedTotal += Number(order.total_price ?? 0);
      }

      returnPost.order_quantity =
        Number(returnPost.order_quantity ?? 0) + group.orders.length;
      returnPost.post_total_price =
        Number(returnPost.post_total_price ?? 0) + returnedTotal;
      const savedReturnPost = await this.postRepo.save(returnPost);
      void this.syncPostToSearch(savedReturnPost);
      requeuedPostIds.add(String(savedReturnPost.id));
    }

    return Array.from(requeuedPostIds);
  }

  async receiveCanceledPost(
    requester: RequesterContext,
    id: string,
    dto: ReceivePostDto,
  ) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }
    if (post.status !== Post_status.CANCELED) {
      this.badRequest('Post with this status can not be received');
    }
    const scopedBranchId = await this.resolveScopedBranchId(requester);
    const targetBranchId =
      String(post.branch_id ?? '').trim() ||
      (await this.findCourierBranchId({
        id: String(post.courier_id),
        roles: [Roles.COURIER],
      }));
    const hqBranchId = await this.findHqBranchId();
    const isHqReceipt = targetBranchId === hqBranchId;
    if (this.isSystemPrivileged(requester) && !isHqReceipt) {
      this.forbidden(
        'HQ xodimi faqat HQga yuborilgan bekor qilingan pochtani qabul qila oladi',
      );
    }
    if (scopedBranchId && scopedBranchId !== targetBranchId) {
      this.forbidden(
        'Siz boshqa branchning bekor qilingan pochtasini qabul qila olmaysiz',
      );
    }
    if (!post.branch_id) {
      post.branch_id = targetBranchId;
    }

    const { posts: groupedCanceledPosts, orders: allOrders } =
      await this.findCanceledPostGroup(post);

    const canceledOrderIds = [...new Set(dto.order_ids ?? [])];
    const allOrderIdsForPost = allOrders.map((o) => o.id);
    const invalidIds = canceledOrderIds.filter(
      (orderId) => !allOrderIdsForPost.includes(orderId),
    );

    if (invalidIds.length) {
      this.badRequest(
        `Some order_ids do not belong to this post: ${invalidIds.join(', ')}`,
      );
    }

    for (const orderId of canceledOrderIds) {
      await this.updateOrder(
        orderId,
        {
          status: Order_status.CANCELLED,
          branch_id: targetBranchId,
          courier_id: null,
          assigned_at: null,
          canceled_post_id: null,
        },
        {
          id: requester.id,
          roles: requester.roles ?? [Roles.MANAGER],
          note: isHqReceipt
            ? 'Canceled order received by HQ and held for market handover'
            : 'Canceled order received by branch manager',
        },
      );
    }

    const remainingOrderIds = allOrderIdsForPost.filter(
      (orderId) => !canceledOrderIds.includes(orderId),
    );
    const remainingOrders = allOrders.filter((order) =>
      remainingOrderIds.includes(String(order.id)),
    );
    let savedPost = post;
    for (const groupedPost of groupedCanceledPosts) {
      groupedPost.order_quantity = 0;
      groupedPost.post_total_price = 0;
      groupedPost.status = Post_status.CANCELED_RECEIVED;
      let savedGroupedPost: Post;

      try {
        savedGroupedPost = await this.postRepo.save(groupedPost);
      } catch (error) {
        this.logger.warn(
          `post ${groupedPost.id} save failed after grouped canceled receive, retrying minimal update: ${
            (error as Error)?.message ?? error
          }`,
        );
        await this.postRepo.update(groupedPost.id, {
          order_quantity: 0,
          post_total_price: 0,
          status: Post_status.CANCELED_RECEIVED,
        });
        savedGroupedPost =
          (await this.postRepo.findOne({
            where: { id: groupedPost.id },
          })) ?? groupedPost;
      }

      if (String(groupedPost.id) === String(post.id)) {
        savedPost = savedGroupedPost;
      }
      void this.syncPostToSearch(savedGroupedPost);
    }

    let requeuedPostIds: string[] = [];
    if (remainingOrders.length) {
      // LC-06 — pochta egasi (post.courier_id) kim: kuryermi yoki menejermi.
      // Qabul qilinmagan posilka shu jo'natuvchiga qaytadi. Qidiruv yiqilsa
      // (null) — avvalgi xatti-harakat: filial qabulida kuryerga, HQ qabulida
      // HQ da, kuryersiz.
      const senderAssignment = await this.findBranchAssignmentByUserId(
        String(post.courier_id),
        {
          id: String(post.courier_id),
          roles: [Roles.MANAGER],
        },
      );
      const senderRole = String(senderAssignment?.role ?? '')
        .trim()
        .toUpperCase();
      const fallbackReturnBranchId = isHqReceipt
        ? String(senderAssignment?.branch_id ?? '').trim()
        : targetBranchId;
      const returnToCourier = senderRole
        ? senderRole === 'COURIER'
        : !isHqReceipt;
      requeuedPostIds = await this.requeueUnreceivedCanceledOrders({
        sourcePost: post,
        orders: remainingOrders,
        targetBranchId,
        fallbackBranchId: fallbackReturnBranchId,
        isHqReceipt,
        returnToCourier,
        requester,
      });
    }

    await Promise.resolve(
      this.activityLog.log({
        entity_type: 'Post',
        entity_id: String(savedPost.id),
        action: ActivityAction.STATUS_CHANGE,
        new_value: { status: savedPost.status },
        metadata: {
          order_count: canceledOrderIds.length,
          order_ids: canceledOrderIds.slice(0, 10),
          remaining_order_count: remainingOrderIds.length,
          requeued_post_ids: requeuedPostIds,
          grouped_post_ids: groupedCanceledPosts.map(({ id }) => String(id)),
          branch_id: targetBranchId,
          courier_id: savedPost.courier_id,
        },
      }),
    ).catch(() => undefined);

    return successRes(
      {
        order_ids: canceledOrderIds,
        remaining_order_ids: remainingOrderIds,
        requeued_post_ids: requeuedPostIds,
        grouped_post_ids: groupedCanceledPosts.map(({ id }) => String(id)),
        branch_id: targetBranchId,
      },
      200,
      isHqReceipt
        ? 'Canceled orders received by HQ'
        : 'Canceled orders received by branch',
    );
  }

  async createDistrict(dto: CreateDistrictDto) {
    const region = await this.regionRepo.findOne({
      where: { id: dto.region_id },
    });
    if (!region) {
      this.notFound('Region not found');
    }

    const trimmedName = dto.name.trim();
    const satoCode = dto.sato_code?.trim() ?? '';

    const exists = await this.districtRepo.findOne({
      where: { name: trimmedName, region_id: dto.region_id },
    });
    if (exists) {
      this.conflict('District already exists in this region');
    }

    if (satoCode) {
      const existingBySato = await this.districtRepo.findOne({
        where: { sato_code: satoCode },
      });
      if (existingBySato) {
        this.conflict('District sato_code already exists');
      }
    }

    const district = this.districtRepo.create({
      name: trimmedName,
      sato_code: satoCode,
      region_id: dto.region_id,
      assigned_region: dto.region_id,
    });
    const saved = await this.districtRepo.save(district);
    void this.syncDistrictToSearch(saved);

    await this.activityLog.log({
      entity_type: 'District',
      entity_id: String(saved.id),
      action: ActivityAction.CREATED,
      new_value: {
        name: saved.name,
        sato_code: saved.sato_code,
        region_id: saved.region_id,
      },
      metadata: { region_id: dto.region_id },
    });

    return successRes(saved, 201, 'New district added');
  }

  async findAllDistricts(regionId?: string) {
    const normalizedRegionId = String(regionId ?? '').trim();
    const districts = await this.districtRepo.find({
      where: normalizedRegionId ? { region_id: normalizedRegionId } : {},
      relations: ['region', 'assignedToRegion'],
      order: { createdAt: 'DESC' },
    });
    return successRes(districts);
  }

  async findDistrictById(id: string) {
    const district = await this.districtRepo.findOne({
      where: { id },
      relations: ['region', 'assignedToRegion'],
    });
    if (!district) {
      this.notFound('District not found');
    }
    return successRes(district);
  }

  async findDistrictsByIds(ids: string[]) {
    if (!ids.length) {
      return successRes([]);
    }
    const districts = await this.districtRepo.find({
      where: { id: In(ids) },
      relations: ['region', 'assignedToRegion'],
    });
    return successRes(districts);
  }

  async updateDistrict(
    id: string,
    dto: UpdateDistrictDto,
    requester?: RequesterContext,
  ) {
    // LC-08 / RBAC-06 — tumanni boshqa hududga biriktirish HQ intake'dagi
    // hudud pochtasini o'zgartiradi (butun kompaniya bo'yicha). Faqat
    // superadmin/admin; gateway ham shuni talab qiladi (ikkinchi qatlam).
    if (!this.isSystemPrivileged(requester)) {
      this.forbidden(
        'Tumanni boshqa viloyatga faqat admin yoki superadmin biriktira oladi',
      );
    }

    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('District not found');
    }

    const before = { assigned_region: district.assigned_region };

    if (district.assigned_region === dto.assigned_region) {
      this.badRequest('The district already assigned to this region');
    }

    const assigningRegion = await this.regionRepo.findOne({
      where: { id: dto.assigned_region },
    });
    if (!assigningRegion) {
      this.notFound('The region you are trying to assign does not exist');
    }

    district.assigned_region = assigningRegion.id;
    district.assignedToRegion = assigningRegion;

    const saved = await this.districtRepo.save(district);
    void this.syncDistrictToSearch(saved);

    await this.activityLog.logChange({
      entity_type: 'District',
      entity_id: String(saved.id),
      action: ActivityAction.UPDATED,
      old_value: before,
      new_value: { assigned_region: saved.assigned_region },
      ...this.auditActor(requester),
    });

    return successRes(saved, 200, 'District assigned to new region');
  }

  async updateDistrictName(id: string, dto: UpdateDistrictNameDto) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('District not found');
    }

    const before = { name: district.name };

    const trimmedName = dto.name.trim();
    if (!trimmedName) {
      this.badRequest('District name is required');
    }

    const duplicate = await this.districtRepo.findOne({
      where: { name: trimmedName, region_id: district.region_id },
    });
    if (duplicate && duplicate.id !== district.id) {
      this.conflict('District name already exists in this region');
    }

    district.name = trimmedName;
    const savedDistrict = await this.districtRepo.save(district);
    void this.syncDistrictToSearch(savedDistrict);

    await this.activityLog.logChange({
      entity_type: 'District',
      entity_id: String(savedDistrict.id),
      action: ActivityAction.UPDATED,
      old_value: before,
      new_value: { name: savedDistrict.name },
    });

    return successRes({}, 200, 'District name updated');
  }

  async updateDistrictSatoCode(id: string, dto: UpdateDistrictSatoCodeDto) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('District not found');
    }

    const before = { sato_code: district.sato_code };

    const satoCode = dto.sato_code.trim();
    if (!satoCode) {
      this.badRequest('District sato_code is required');
    }

    const existingWithCode = await this.districtRepo.findOne({
      where: { sato_code: satoCode },
    });
    if (existingWithCode && existingWithCode.id !== id) {
      this.conflict('District sato_code already exists');
    }

    district.sato_code = satoCode;
    const savedDistrict = await this.districtRepo.save(district);
    void this.syncDistrictToSearch(savedDistrict);

    await this.activityLog.logChange({
      entity_type: 'District',
      entity_id: String(savedDistrict.id),
      action: ActivityAction.UPDATED,
      old_value: before,
      new_value: { sato_code: savedDistrict.sato_code },
    });

    return successRes(savedDistrict, 200, 'District sato_code updated');
  }

  async findDistrictBySatoCode(satoCode: string) {
    const district = await this.districtRepo.findOne({
      where: { sato_code: satoCode },
      relations: ['region', 'assignedToRegion'],
    });
    if (!district) {
      this.notFound('District not found');
    }
    return successRes(district);
  }

  async matchDistrictSatoCodes() {
    const dbDistricts = await this.districtRepo.find({
      relations: ['region'],
    });

    return successRes(
      matchDistricts(dbDistricts),
      200,
      'SATO matching natijasi',
    );
  }

  async applyDistrictSatoCodes() {
    const dbDistricts = await this.districtRepo.find({
      relations: ['region'],
    });
    const matchResult = matchDistricts(dbDistricts);

    let appliedCount = 0;
    const applied: Array<{ id: string; name: string; sato_code: string }> = [];

    for (const match of matchResult.matched) {
      if (match.satoName !== '(allaqachon mavjud)') {
        await this.districtRepo.update(match.dbId, {
          sato_code: match.satoCode,
        });
        applied.push({
          id: match.dbId,
          name: match.dbName,
          sato_code: match.satoCode,
        });
        appliedCount++;
      }
    }

    const updatedIds = applied.map((item) => item.id);
    if (updatedIds.length) {
      const updatedDistricts = await this.districtRepo.find({
        where: { id: In(updatedIds) },
      });
      updatedDistricts.forEach((district) => {
        void this.syncDistrictToSearch(district);
      });
    }

    if (appliedCount > 0) {
      await this.activityLog.log({
        entity_type: 'District',
        entity_id: 'bulk',
        action: 'logistics.sato_bulk_apply',
        metadata: {
          applied_count: appliedCount,
          district_ids: updatedIds.slice(0, 10),
        },
      });
    }

    return successRes(
      {
        applied,
        appliedCount,
        unmatched: matchResult.unmatched,
        duplicates: matchResult.duplicates,
        stats: matchResult.stats,
      },
      200,
      appliedCount + " ta tumanga SATO code qo'shildi",
    );
  }

  /**
   * oNAE3LW9 — hudud boshqa servislarda ishlatilyaptimi. Buyurtma (va viloyat
   * bo'yicha filiallararo jo'natma), foydalanuvchi (mijoz/kuryer/market) va
   * filial boshqa sxemalarda — FK yo'q, shuning uchun har biridan RPC bilan
   * sanaladi. Bittasi javob bermasa — FAIL-CLOSED (503): tekshiruvsiz
   * o'chirish buyurtmalarni yetim qoldirishi mumkin.
   */
  private async collectGeoUsage(
    where: { district_id?: string; region_id?: string },
    purpose = "o'chirish",
  ): Promise<GeoUsage> {
    const ask = async (
      client: ClientProxy,
      cmd: string,
      fields: Array<keyof GeoUsage>,
    ): Promise<Partial<GeoUsage>> => {
      try {
        const res = await lastValueFrom(
          client.send({ cmd }, where).pipe(timeout(8000)),
        );
        const data = (res as { data?: Record<string, unknown> })?.data ?? {};
        const out: Partial<GeoUsage> = {};
        for (const field of fields) {
          const raw = data[field];
          const value = Number(raw);
          // Eski versiya maydonni qaytarmasa ham FAIL-CLOSED (0 deb olinmaydi).
          if (raw === undefined || raw === null || !Number.isFinite(value)) {
            throw new Error(`${cmd}: noto'g'ri javob (${field})`);
          }
          out[field] = value;
        }
        return out;
      } catch (error) {
        this.logger.error(
          `geo usage check failed (${cmd}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw new RpcException(
          errorRes(
            `Hudud ishlatilishini tekshirib bo'lmadi — ${purpose} to'xtatildi, keyinroq qayta urinib ko'ring`,
            503,
          ),
        );
      }
    };
    const byRegion = !where.district_id && Boolean(where.region_id);
    const [order, identity, branch] = await Promise.all([
      ask(
        this.orderClient,
        'order.geo.usage',
        byRegion ? ['orders', 'transfer_batches'] : ['orders'],
      ),
      ask(this.identityClient, 'identity.user.geo_usage', ['users']),
      ask(this.branchClient, 'branch.geo_usage', ['branches']),
    ]);
    return {
      orders: order.orders ?? 0,
      users: identity.users ?? 0,
      branches: branch.branches ?? 0,
      transfer_batches: order.transfer_batches ?? 0,
    };
  }

  private geoUsageTotal(usage: GeoUsage): number {
    return usage.orders + usage.users + usage.branches + usage.transfer_batches;
  }

  private describeGeoUsage(usage: GeoUsage): string {
    const parts: string[] = [];
    if (usage.orders) parts.push(`${usage.orders} ta buyurtma`);
    if (usage.users)
      parts.push(`${usage.users} ta foydalanuvchi (mijoz/kuryer/market)`);
    if (usage.branches) parts.push(`${usage.branches} ta filial`);
    if (usage.transfer_batches)
      parts.push(`${usage.transfer_batches} ta filiallararo jo'natma`);
    return parts.join(', ');
  }

  /**
   * oNAE3LW9 — Soft delete EMAS: karta TC2 "buyurtmasi yo'q tuman DELETE →
   * 200 va DB dan yo'qoladi" — bog'lanishi bo'lmagan tuman qattiq o'chadi,
   * bog'langani esa umuman o'chirilmaydi (400).
   */
  async deleteDistrict(id: string) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('District not found');
    }
    // oNAE3LW9: ilgari hech narsa tekshirilmasdan `remove` qilinardi.
    const usage = await this.collectGeoUsage({ district_id: String(id) });
    if (this.geoUsageTotal(usage) > 0) {
      this.badRequest(
        `Bu tumanda ${this.describeGeoUsage(usage)} bor. Avval tumanni boshqasiga birlashtiring (POST /district/${id}/merge) yoki ularni ko'chiring.`,
      );
    }

    const deletedSnapshot = {
      name: district.name,
      sato_code: district.sato_code,
      region_id: district.region_id,
    };
    // oNAE3LW9: TypeORM `remove` dan keyin entity `id` si undefined bo'ladi —
    // qidiruv indeksidan o'chirish uchun nusxa OLDIN olinadi.
    const searchRef = { ...district };

    await this.districtRepo.remove(district);
    void this.removeDistrictFromSearch(searchRef);

    await this.activityLog.log({
      entity_type: 'District',
      entity_id: String(id),
      action: ActivityAction.DELETED,
      old_value: deletedSnapshot,
      metadata: { region_id: deletedSnapshot.region_id },
    });

    return successRes({ id }, 200, 'District deleted');
  }

  async createRegion(dto: CreateRegionDto) {
    const name = dto.name.trim();
    const satoCode = dto.sato_code.trim();

    if (!name || !satoCode) {
      this.badRequest('name and sato_code are required');
    }

    const existingByName = await this.regionRepo.findOne({ where: { name } });
    if (existingByName) {
      this.conflict('Region name already exists');
    }

    const existingBySato = await this.regionRepo.findOne({
      where: { sato_code: satoCode },
    });
    if (existingBySato) {
      this.conflict('Region sato_code already exists');
    }

    const region = this.regionRepo.create({ name, sato_code: satoCode });
    const saved = await this.regionRepo.save(region);
    void this.syncRegionToSearch(saved);

    await this.activityLog.log({
      entity_type: 'Region',
      entity_id: String(saved.id),
      action: ActivityAction.CREATED,
      new_value: { name: saved.name, sato_code: saved.sato_code },
    });

    return successRes(saved, 201, 'Region created');
  }

  async findAllRegions() {
    const rows = await this.regionRepo.find({
      relations: ['districts'],
      order: { createdAt: 'DESC' },
    });
    return successRes(rows);
  }

  async getAllRegionsStats(startDate?: string, endDate?: string) {
    const regions = await this.regionRepo.find({
      relations: ['districts'],
      order: { name: 'ASC' },
    });

    const regionIds = regions.map((region) => String(region.id));
    const regionIdSet = new Set(regionIds);

    const orders = await this.findOrders({
      fetch_all: true,
      start_day: startDate,
      end_day: endDate,
      limit: 100,
    });

    const deliveredStatuses = new Set<Order_status>([
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
    ]);
    const cancelledStatuses = new Set<Order_status>([
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
    ]);

    const statsByRegion = new Map<
      string,
      {
        totalOrders: number;
        deliveredOrders: number;
        cancelledOrders: number;
        revenue: number;
      }
    >();

    for (const regionId of regionIds) {
      statsByRegion.set(regionId, {
        totalOrders: 0,
        deliveredOrders: 0,
        cancelledOrders: 0,
        revenue: 0,
      });
    }

    for (const order of orders) {
      const regionId = String(order.region_id ?? '').trim();
      if (!regionId || !regionIdSet.has(regionId)) {
        continue;
      }

      const stats = statsByRegion.get(regionId);
      if (!stats) {
        continue;
      }

      const status = order.status;
      const price = Number(order.total_price ?? 0);

      stats.totalOrders += 1;

      if (status && deliveredStatuses.has(status)) {
        stats.deliveredOrders += 1;
        stats.revenue += Number.isFinite(price) ? price : 0;
      }

      if (status && cancelledStatuses.has(status)) {
        stats.cancelledOrders += 1;
      }
    }

    const rows = regions.map((region) => {
      const stats = statsByRegion.get(String(region.id)) ?? {
        totalOrders: 0,
        deliveredOrders: 0,
        cancelledOrders: 0,
        revenue: 0,
      };

      return {
        id: region.id,
        name: region.name,
        sato_code: region.sato_code,
        // (dzyVftBx) biriktirilgan logist (yo'q bo'lsa null) — xarita/
        // statistika sahifasida ko'rsatish uchun.
        logist_id: region.logist_id ?? null,
        districts_count: Array.isArray(region.districts)
          ? region.districts.length
          : 0,
        ...stats,
      };
    });

    const summary = rows.reduce(
      (acc, row) => {
        acc.totalRegions += 1;
        acc.totalOrders += row.totalOrders;
        acc.deliveredOrders += row.deliveredOrders;
        acc.cancelledOrders += row.cancelledOrders;
        acc.totalRevenue += row.revenue;
        return acc;
      },
      {
        totalRegions: 0,
        totalOrders: 0,
        deliveredOrders: 0,
        cancelledOrders: 0,
        totalRevenue: 0,
      },
    );

    return successRes(
      {
        regions: rows,
        summary,
      },
      200,
      'Region stats',
    );
  }

  async getRegionDetailedStats(
    id: string,
    startDate?: string,
    endDate?: string,
  ) {
    const regionId = String(id ?? '').trim();
    if (!regionId) {
      this.badRequest('Region id is required');
    }

    const region = await this.regionRepo.findOne({
      where: { id: regionId },
      relations: ['districts'],
    });

    if (!region) {
      this.notFound('Region not found');
    }

    const orders = await this.findOrders({
      fetch_all: true,
      start_day: startDate,
      end_day: endDate,
      limit: 100,
    });

    const deliveredStatuses = new Set<Order_status>([
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
    ]);
    const cancelledStatuses = new Set<Order_status>([
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
    ]);

    const regionOrders = orders.filter(
      (order) => String(order.region_id ?? '').trim() === regionId,
    );

    const summarizeOrders = (rows: OrderRow[]) => {
      let totalOrders = 0;
      let deliveredOrders = 0;
      let cancelledOrders = 0;
      let totalRevenue = 0;

      for (const order of rows) {
        totalOrders += 1;
        const status = order.status;
        const price = Number(order.total_price ?? 0);

        if (status && deliveredStatuses.has(status)) {
          deliveredOrders += 1;
          totalRevenue += Number.isFinite(price) ? price : 0;
        }

        if (status && cancelledStatuses.has(status)) {
          cancelledOrders += 1;
        }
      }

      const pendingOrders = Math.max(
        0,
        totalOrders - deliveredOrders - cancelledOrders,
      );
      const successRate =
        totalOrders > 0 ? Math.round((deliveredOrders / totalOrders) * 100) : 0;

      return {
        totalOrders,
        deliveredOrders,
        cancelledOrders,
        pendingOrders,
        totalRevenue,
        successRate,
      };
    };

    const couriersRaw = await this.listCouriersByRegion(regionId);
    const couriers = couriersRaw.map((courier) => {
      const courierId = String(
        (courier?.id as string | number | undefined) ?? '',
      ).trim();
      const courierOrders = regionOrders.filter(
        (order) => String(order.courier_id ?? '').trim() === courierId,
      );
      const stats = summarizeOrders(courierOrders);
      const districtId = String(
        (courier?.district_id as string | number | undefined) ?? '',
      ).trim();

      return {
        id: courierId || null,
        name: String((courier?.name as string | number | undefined) ?? ''),
        phoneNumber: String(
          (courier?.phone_number as string | number | undefined) ??
            (courier?.phoneNumber as string | number | undefined) ??
            '',
        ),
        status: courier?.status ?? null,
        districtId: districtId || null,
        totalOrders: stats.totalOrders,
        deliveredOrders: stats.deliveredOrders,
        cancelledOrders: stats.cancelledOrders,
        totalRevenue: stats.totalRevenue,
        successRate: stats.successRate,
      };
    });

    const districts = (
      Array.isArray(region.districts) ? region.districts : []
    ).map((district) => {
      const districtId = String(district.id);
      const districtOrders = regionOrders.filter(
        (order) => String(order.district_id ?? '').trim() === districtId,
      );
      const stats = summarizeOrders(districtOrders);
      const districtCouriers = couriers
        .filter((courier) => String(courier.districtId ?? '') === districtId)
        .map((courier) => ({
          id: courier.id,
          name: courier.name,
          phone_number: courier.phoneNumber,
        }));

      return {
        id: district.id,
        name: district.name,
        satoCode: district.sato_code,
        couriers: districtCouriers,
        totalOrders: stats.totalOrders,
        deliveredOrders: stats.deliveredOrders,
        cancelledOrders: stats.cancelledOrders,
        totalRevenue: stats.totalRevenue,
        successRate: stats.successRate,
      };
    });

    const summary = summarizeOrders(regionOrders);
    const activeCouriers = couriers.filter(
      (courier) =>
        String(
          (courier.status as string | number | undefined) ?? '',
        ).toLowerCase() === 'active',
    ).length;

    const topCourier = couriers
      .slice()
      .sort((a, b) => b.deliveredOrders - a.deliveredOrders)[0];

    return successRes(
      {
        region: {
          id: region.id,
          name: region.name,
          satoCode: region.sato_code,
          mainCourier: topCourier
            ? {
                id: topCourier.id,
                name: topCourier.name,
                phone_number: topCourier.phoneNumber,
              }
            : null,
        },
        summary: {
          totalOrders: summary.totalOrders,
          deliveredOrders: summary.deliveredOrders,
          cancelledOrders: summary.cancelledOrders,
          pendingOrders: summary.pendingOrders,
          totalRevenue: summary.totalRevenue,
          successRate: summary.successRate,
          totalCouriers: couriers.length,
          activeCouriers,
          totalDistricts: districts.length,
        },
        couriers: couriers.sort(
          (a, b) => b.deliveredOrders - a.deliveredOrders,
        ),
        districts: districts.sort((a, b) => b.totalOrders - a.totalOrders),
      },
      200,
      'Region detailed stats',
    );
  }

  async findRegionById(id: string) {
    const region = await this.regionRepo.findOne({
      where: { id },
      relations: ['districts'],
    });
    if (!region) {
      this.notFound('Region not found');
    }
    return successRes(region);
  }

  async receiveOrdersIntoPosts(
    orders: Array<{
      order_id: string;
      assigned_region: string;
      total_price: number;
      assigned_branch?: string;
      assigned_post_status?: Post_status;
    }>,
  ) {
    if (!orders.length) {
      return successRes([]);
    }

    const byRegionStatus = new Map<
      string,
      Array<{
        order_id: string;
        total_price: number;
        assigned_region: string;
        assigned_branch?: string;
        assigned_post_status?: Post_status;
      }>
    >();
    for (const order of orders) {
      const regionId = String(order.assigned_region ?? '').trim();
      const targetPostStatus = order.assigned_post_status ?? Post_status.NEW;
      const assignedBranch = String(order.assigned_branch ?? '').trim();
      const key = `${targetPostStatus}:${regionId}:${assignedBranch}`;
      const group = byRegionStatus.get(key) ?? [];
      group.push({
        order_id: order.order_id,
        total_price: order.total_price,
        assigned_region: regionId,
        assigned_branch: assignedBranch,
        assigned_post_status: targetPostStatus,
      });
      byRegionStatus.set(key, group);
    }

    const assignments: Array<{ order_id: string; post_id: string }> = [];
    const touchedPostIds: string[] = [];

    for (const regionOrders of byRegionStatus.values()) {
      const first = regionOrders[0];
      const regionId = String(first?.assigned_region ?? '').trim();
      const targetPostStatus = first?.assigned_post_status ?? Post_status.NEW;
      const assignedBranch = String(first?.assigned_branch ?? '').trim();
      let post = await this.postRepo.findOne({
        where: {
          region_id: regionId,
          status: targetPostStatus,
          branch_id: assignedBranch || IsNull(),
        },
      });

      if (
        post &&
        targetPostStatus === Post_status.NEW &&
        String(post.branch_id ?? '').trim()
      ) {
        post.branch_id = null;
        post = await this.postRepo.save(post);
        void this.syncPostToSearch(post);
      }

      if (!post) {
        post = this.postRepo.create({
          courier_id: '0',
          qr_code_token: this.generateToken(),
          region_id: regionId,
          branch_id: assignedBranch || null,
          status: targetPostStatus,
          post_total_price: 0,
          order_quantity: 0,
        });
        post = await this.postRepo.save(post);
        void this.syncPostToSearch(post);
      }

      if (
        assignedBranch &&
        String(post.branch_id ?? '').trim() !== assignedBranch
      ) {
        post.branch_id = assignedBranch;
      }

      let addedTotal = 0;
      for (const ro of regionOrders) {
        assignments.push({ order_id: ro.order_id, post_id: post.id });
        addedTotal += Number(ro.total_price ?? 0);
      }

      post.order_quantity =
        Number(post.order_quantity ?? 0) + regionOrders.length;
      post.post_total_price = Number(post.post_total_price ?? 0) + addedTotal;
      const saved = await this.postRepo.save(post);
      void this.syncPostToSearch(saved);
      touchedPostIds.push(String(saved.id));
    }

    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: String(touchedPostIds[0] ?? 'bulk'),
      action: 'logistics.post_assign_orders',
      metadata: {
        order_count: assignments.length,
        order_ids: assignments.slice(0, 10).map((a) => a.order_id),
        post_ids: touchedPostIds.slice(0, 10),
        post_count: touchedPostIds.length,
      },
    });

    return successRes(assignments, 200, 'Posts assigned');
  }

  async findRegionsByIds(ids: string[]) {
    if (!ids.length) {
      return successRes([]);
    }
    const regions = await this.regionRepo.find({
      where: { id: In(ids) },
    });
    return successRes(regions);
  }

  async updateRegion(id: string, dto: UpdateRegionDto) {
    const region = await this.regionRepo.findOne({ where: { id } });
    if (!region) {
      this.notFound('Region not found');
    }

    const before = { name: region.name, sato_code: region.sato_code };

    if (typeof dto.name !== 'undefined') {
      const nextName = dto.name.trim();
      if (!nextName) {
        this.badRequest('name cannot be empty');
      }
      const existing = await this.regionRepo.findOne({
        where: { name: nextName },
      });
      if (existing && existing.id !== id) {
        this.conflict('Region name already exists');
      }
      region.name = nextName;
    }

    if (typeof dto.sato_code !== 'undefined') {
      const nextSato = dto.sato_code.trim();
      if (!nextSato) {
        this.badRequest('sato_code cannot be empty');
      }
      const existing = await this.regionRepo.findOne({
        where: { sato_code: nextSato },
      });
      if (existing && existing.id !== id) {
        this.conflict('Region sato_code already exists');
      }
      region.sato_code = nextSato;
    }

    const saved = await this.regionRepo.save(region);
    void this.syncRegionToSearch(saved);

    await this.activityLog.logChange({
      entity_type: 'Region',
      entity_id: String(saved.id),
      action: ActivityAction.UPDATED,
      old_value: before,
      new_value: { name: saved.name, sato_code: saved.sato_code },
    });

    return successRes(saved, 200, 'Region updated');
  }

  /** oNAE3LW9 — birlashtirish bosqichlari (ketma-ket; kompensatsiya — teskari). */
  private geoMoveSteps(): GeoMoveStep[] {
    return [
      {
        kind: 'orders',
        label: 'buyurtma',
        plural: 'buyurtmalar',
        client: this.orderClient,
        cmd: 'order.geo.reassign_district',
      },
      {
        kind: 'users',
        label: 'foydalanuvchi',
        plural: 'foydalanuvchilar',
        client: this.identityClient,
        cmd: 'identity.user.reassign_district',
      },
      {
        kind: 'branches',
        label: 'filial',
        plural: 'filiallar',
        client: this.branchClient,
        cmd: 'branch.reassign_district',
      },
    ];
  }

  /**
   * oNAE3LW9 — masofadagi servis qaytargan xato statusi. `undefined` —
   * timeout/ulanish xatosi yoki statussiz xato: natija NOANIQ.
   */
  private geoRemoteStatus(error: unknown): number | undefined {
    if (error instanceof Error) return undefined;
    const status = (error as { statusCode?: unknown } | null)?.statusCode;
    return typeof status === 'number' ? status : undefined;
  }

  private geoErrorText(error: unknown): string {
    if (error instanceof Error) {
      return error.name === 'TimeoutError'
        ? 'javob kelmadi (timeout)'
        : error.message;
    }
    const message = (error as { message?: unknown } | null)?.message;
    if (Array.isArray(message)) return message.map(String).join('. ');
    if (typeof message === 'string' && message) return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  /** oNAE3LW9 — `*.reassign_district` javobi: ko'chgan ID'lar + eski viloyatlar. */
  private parseGeoMoved(res: unknown, cmd: string): GeoMoved {
    const data = (
      res as { data?: { ids?: unknown; previous_regions?: unknown } } | null
    )?.data;
    if (!data || !Array.isArray(data.ids)) {
      throw new Error(`${cmd}: javobda ko'chgan ID'lar (ids) yo'q`);
    }
    const toIds = (list: unknown): string[] =>
      Array.isArray(list) ? list.map((value) => String(value)) : [];
    const groups: unknown[] = Array.isArray(data.previous_regions)
      ? (data.previous_regions as unknown[])
      : [];
    return {
      ids: toIds(data.ids),
      previous_regions: groups.map((group) => {
        const g = group as { region_id?: unknown; ids?: unknown } | null;
        return {
          region_id:
            g?.region_id === undefined || g?.region_id === null
              ? null
              : String(g.region_id as string | number),
          ids: toIds(g?.ids),
        };
      }),
    };
  }

  private geoPreviewIds(ids: string[]): string {
    const head = ids.slice(0, GEO_STRANDED_PREVIEW).join(', ');
    return ids.length > GEO_STRANDED_PREVIEW
      ? `${head} … (+${ids.length - GEO_STRANDED_PREVIEW} ta)`
      : head;
  }

  /**
   * oNAE3LW9 — kompensatsiya: allaqachon ko'chirilganlar AYNAN o'sha ID'lar
   * bo'yicha B → A qaytariladi (teskari tartibda), `region_id` lari ham eski
   * qiymatiga. ID rejimi idempotent: faqat hali B da turgan shu ID'lar
   * ko'chadi. Qaytmaganlari ro'yxat bo'lib qaytadi (qo'lda tuzatish uchun).
   */
  private async compensateDistrictMerge(
    fromId: string,
    toId: string,
    done: Array<{ step: GeoMoveStep; moved: GeoMoved }>,
  ): Promise<GeoStranded[]> {
    const stranded: GeoStranded[] = [];
    for (const { step, moved } of [...done].reverse()) {
      if (!moved.ids.length) continue;
      try {
        const res = await lastValueFrom(
          step.client
            .send(
              { cmd: step.cmd },
              {
                from_district_id: toId,
                to_district_id: fromId,
                ids: moved.ids,
                restore_regions: moved.previous_regions,
              },
            )
            .pipe(timeout(GEO_MOVE_TIMEOUT_MS)),
        );
        const back = new Set(this.parseGeoMoved(res, step.cmd).ids);
        const lost = moved.ids.filter((rowId) => !back.has(rowId));
        if (lost.length) {
          stranded.push({
            kind: step.kind,
            district_id: null,
            ids: lost,
            reason: `B tumanda (#${toId}) topilmadi — kompensatsiya paytida boshqa joyga o'zgargan`,
          });
        }
      } catch (error) {
        stranded.push({
          kind: step.kind,
          district_id: toId,
          ids: moved.ids,
          reason: `A ga qaytarib bo'lmadi: ${this.geoErrorText(error)}`,
        });
      }
    }
    return stranded;
  }

  /**
   * oNAE3LW9 — javobi kelmagan (timeout/ulanish) bosqich: servis ko'chirib
   * ulgurganmi? A dagi son OLDINGIDAN kam bo'lsa — qatorlar B ga ketgan, lekin
   * ID'lari noma'lum (qo'lda tuzatish). Servis `deadline_at` dan keyin
   * ko'chirmaydi, shuning uchun bu juda kam holat.
   */
  private async checkUncertainGeoStep(
    fromId: string,
    toId: string,
    step: GeoMoveStep,
    beforeA: GeoUsage,
  ): Promise<GeoStranded | null> {
    try {
      const nowA = await this.collectGeoUsage(
        { district_id: fromId },
        'birlashtirish',
      );
      if (nowA[step.kind] >= beforeA[step.kind]) return null;
      return {
        kind: step.kind,
        district_id: toId,
        ids: null,
        reason: `${step.cmd} javobi kelmadi, lekin A dagi ${step.plural} ${beforeA[step.kind]} → ${nowA[step.kind]} ga kamaydi — B tumanga (#${toId}) ko'chgan bo'lishi mumkin`,
      };
    } catch (error) {
      return {
        kind: step.kind,
        district_id: null,
        ids: null,
        reason: `${step.cmd} natijasi noaniq va A ni qayta sanab bo'lmadi: ${this.geoErrorText(error)}`,
      };
    }
  }

  /**
   * oNAE3LW9 — birlashtirishni BEKOR qilish: kompensatsiya, A o'chirilmaydi,
   * aniq xato (409/503). Kompensatsiya to'liq bo'lmasa — ERROR log, activity
   * log (`district.merge_compensation_failed`, to'liq ID ro'yxati) va xato
   * matnida qaysi ID'lar qayerda qolgani.
   */
  private async abortDistrictMerge(ctx: {
    fromId: string;
    toId: string;
    done: Array<{ step: GeoMoveStep; moved: GeoMoved }>;
    beforeA: GeoUsage;
    status: 409 | 503;
    reason: string;
    uncertain?: GeoMoveStep;
  }): Promise<never> {
    const { fromId, toId, done, status, reason } = ctx;
    const stranded = await this.compensateDistrictMerge(fromId, toId, done);
    if (ctx.uncertain) {
      const check = await this.checkUncertainGeoStep(
        fromId,
        toId,
        ctx.uncertain,
        ctx.beforeA,
      );
      if (check) stranded.push(check);
    }
    const rolledBack: Partial<Record<GeoMoveKind, number>> = {};
    for (const { step, moved } of done) {
      const lost =
        stranded.find((s) => s.kind === step.kind && s.ids !== null)?.ids
          ?.length ?? 0;
      rolledBack[step.kind] = moved.ids.length - lost;
    }
    const details = {
      from_district_id: fromId,
      to_district_id: toId,
      rolled_back: rolledBack,
    };

    if (!stranded.length) {
      this.logger.warn(
        `mergeDistricts ${fromId} → ${toId} bekor qilindi (${reason}); kompensatsiya OK: ${JSON.stringify(rolledBack)}`,
      );
      throw new RpcException(
        errorRes(
          `Birlashtirish bekor qilindi: ${reason}. Ko'chirilganlar A tumanga (#${fromId}) qaytarildi, tuman o'chirilmadi — qayta urinib ko'ring.`,
          status,
          details,
        ),
      );
    }

    const steps = new Map(this.geoMoveSteps().map((s) => [s.kind, s]));
    const where = stranded
      .map((s) => {
        const place = s.district_id
          ? `B tumanda (#${s.district_id}) qoldi`
          : 'joyi aniqlanmadi';
        const ids =
          s.ids === null ? "ID'lar noma'lum" : this.geoPreviewIds(s.ids);
        return `${steps.get(s.kind)?.plural ?? s.kind}: ${place} — ${ids} (${s.reason})`;
      })
      .join('; ');
    this.logger.error(
      `mergeDistricts ${fromId} → ${toId}: KOMPENSATSIYA TO'LIQ EMAS — qo'lda tuzatish kerak. Sabab: ${reason}. Qolganlar: ${JSON.stringify(stranded)}`,
    );
    await this.activityLog.log({
      entity_type: 'District',
      entity_id: fromId,
      action: 'district.merge_compensation_failed',
      new_value: { target_district_id: toId },
      metadata: { reason, rolled_back: rolledBack, stranded },
    });
    throw new RpcException(
      errorRes(
        `Birlashtirish bekor qilindi: ${reason}. DIQQAT — kompensatsiya to'liq bo'lmadi, QO'LDA TUZATING: ${where}. A tuman (#${fromId}) o'chirilmadi; to'liq ro'yxat — activity log (District #${fromId}, district.merge_compensation_failed).`,
        status,
        { ...details, stranded },
      ),
    );
  }

  /** oNAE3LW9 — A bo'sh va B = eski B + ko'chirilgan (BeePost :434-446, :495-497). */
  private districtMergeMismatches(
    beforeB: GeoUsage,
    afterA: GeoUsage,
    afterB: GeoUsage,
    moved: Record<GeoMoveKind, number>,
  ): string[] {
    const problems: string[] = [];
    for (const step of this.geoMoveSteps()) {
      const kind = step.kind;
      if (afterA[kind] > 0) {
        problems.push(`A tumanda hali ${afterA[kind]} ta ${step.label} qoldi`);
      }
      const expected = beforeB[kind] + moved[kind];
      if (afterB[kind] !== expected) {
        problems.push(
          `B tumandagi ${step.plural} soni ${afterB[kind]}, kutilgan ${beforeB[kind]} + ${moved[kind]} = ${expected}`,
        );
      }
    }
    return problems;
  }

  /**
   * oNAE3LW9 TC5 — tumanlarni BIRLASHTIRISH: A (`id`) dagi buyurtma,
   * foydalanuvchi va filiallar B (`target_district_id`) ga (va B ning
   * viloyatiga) ko'chadi, so'ng A o'chadi.
   *
   * Ma'lumot uch xil servis sxemasida — servislararo DB tranzaksiyasi yo'q,
   * shuning uchun KOMPENSATSIYA:
   *  1. OLDIN A va B dagi sonlar olinadi (BeePost district.service.ts naqshi).
   *  2. Har servis O'Z tranzaksiyasida A → B ko'chiradi va ko'chgan ID'larni
   *     (eski `region_id` bilan) qaytaradi.
   *  3. A logistics tranzaksiyasida o'chiriladi va COMMIT'dan OLDIN qayta
   *     sanaladi: A da 0 qolgan va B = eski B + ko'chirilgan (BeePost
   *     :434-446, :495-497). Mos kelmasa — rollback (A qoladi).
   *  4. Istalgan bosqich yiqilsa — allaqachon ko'chirilganlar AYNAN o'sha
   *     ID'lar bo'yicha A ga qaytariladi, A o'chirilmaydi, 409/503
   *     (`abortDistrictMerge`).
   */
  async mergeDistricts(id: string, targetDistrictId: string) {
    const fromId = String(id ?? '').trim();
    const toId = String(targetDistrictId ?? '').trim();
    if (!fromId || !toId) {
      this.badRequest('id va target_district_id majburiy');
    }
    if (fromId === toId) {
      this.badRequest("Tumanni o'ziga birlashtirib bo'lmaydi");
    }
    const [from, to] = await Promise.all([
      this.districtRepo.findOne({ where: { id: fromId } }),
      this.districtRepo.findOne({ where: { id: toId } }),
    ]);
    if (!from) this.notFound('District not found');
    if (!to) this.notFound('Target district not found');

    // 1. OLDIN: A va B sanog'i (B ning eski soni — 3-bosqichda tasdiqlanadi).
    const [beforeA, beforeB] = await Promise.all([
      this.collectGeoUsage({ district_id: fromId }, 'birlashtirish'),
      this.collectGeoUsage({ district_id: toId }, 'birlashtirish'),
    ]);
    const done: Array<{ step: GeoMoveStep; moved: GeoMoved }> = [];
    const abort = (
      status: 409 | 503,
      reason: string,
      uncertain?: GeoMoveStep,
    ): Promise<never> =>
      this.abortDistrictMerge({
        fromId,
        toId,
        done,
        beforeA,
        status,
        reason,
        uncertain,
      });

    // 2. Ko'chirish — ketma-ket, har servis o'z tranzaksiyasida.
    for (const step of this.geoMoveSteps()) {
      let res: unknown;
      try {
        res = await lastValueFrom(
          step.client
            .send(
              { cmd: step.cmd },
              {
                from_district_id: fromId,
                to_district_id: toId,
                ...(to.region_id ? { to_region_id: String(to.region_id) } : {}),
                // Servis shu paytdan keyin ko'chirmaydi — timeout bilan voz
                // kechib kompensatsiya qilgandan keyin "kech" ko'chish yo'q.
                deadline_at: Date.now() + GEO_MOVE_TIMEOUT_MS - 2000,
              },
            )
            .pipe(timeout(GEO_MOVE_TIMEOUT_MS)),
        );
      } catch (error) {
        // Masofadagi xato (statusCode bor) — uning tranzaksiyasi rollback;
        // timeout/ulanish — natija noaniq (qayta sanab tekshiriladi).
        const remote = this.geoRemoteStatus(error);
        return abort(
          remote !== undefined && remote < 500 ? 409 : 503,
          `${step.plural} ko'chirilmadi (${this.geoErrorText(error)})`,
          remote === undefined ? step : undefined,
        );
      }
      let moved: GeoMoved;
      try {
        moved = this.parseGeoMoved(res, step.cmd);
      } catch (error) {
        return abort(
          503,
          `${step.plural} ko'chirish javobi noto'g'ri (${this.geoErrorText(error)})`,
          step,
        );
      }
      done.push({ step, moved });
    }
    const movedCounts: Record<GeoMoveKind, number> = {
      orders: 0,
      users: 0,
      branches: 0,
    };
    for (const { step, moved } of done) {
      movedCounts[step.kind] = moved.ids.length;
    }

    // 3. A ni o'chirish + tasdiqlash (COMMIT'dan OLDIN) — mos kelmasa rollback.
    const snapshot = {
      name: from.name,
      sato_code: from.sato_code,
      region_id: from.region_id,
    };
    const searchRef = { ...from };
    let after: { from: GeoUsage; to: GeoUsage };
    try {
      after = await this.districtRepo.manager.transaction(async (manager) => {
        await manager.remove(from);
        const [afterA, afterB] = await Promise.all([
          this.collectGeoUsage({ district_id: fromId }, 'birlashtirish'),
          this.collectGeoUsage({ district_id: toId }, 'birlashtirish'),
        ]);
        const problems = this.districtMergeMismatches(
          beforeB,
          afterA,
          afterB,
          movedCounts,
        );
        if (problems.length) {
          throw new GeoMergeCheckError(problems.join('; '));
        }
        return { from: afterA, to: afterB };
      });
    } catch (error) {
      if (error instanceof GeoMergeCheckError) {
        return abort(409, `tekshiruv mos kelmadi — ${error.message}`);
      }
      return abort(
        503,
        `tumanni o'chirib/qayta sanab bo'lmadi (${this.geoErrorText(error)})`,
      );
    }

    void this.removeDistrictFromSearch(searchRef);
    await this.activityLog.log({
      entity_type: 'District',
      entity_id: fromId,
      action: ActivityAction.DELETED,
      old_value: snapshot,
      new_value: { merged_into: toId },
      metadata: {
        moved: movedCounts,
        source_before: beforeA,
        target_before: beforeB,
        target_after: after.to,
      },
    });
    return successRes(
      {
        from_district_id: fromId,
        to_district_id: toId,
        moved: movedCounts,
        target_before: beforeB,
        target_after: after.to,
      },
      200,
      'District merged',
    );
  }

  /**
   * oNAE3LW9 — Soft delete EMAS (karta TC2/TC3 — bog'lanishsiz hudud qattiq
   * o'chadi, bog'langani umuman o'chirilmaydi).
   */
  async deleteRegion(id: string) {
    const region = await this.regionRepo.findOne({ where: { id } });
    if (!region) {
      this.notFound('Region not found');
    }
    /**
     * oNAE3LW9: `District.region_id` `onDelete: CASCADE` — viloyat o'chsa
     * uning BARCHA tumanlari jimgina o'chardi. Endi tumani bor viloyat
     * o'chirilmaydi; viloyatga to'g'ridan-to'g'ri bog'langan BARCHA yozuvlar
     * ham tekshiriladi: buyurtma va filiallararo jo'natma
     * (`order_schema.branch_transfer_batches.target_region_id`),
     * foydalanuvchi, filial va pochta.
     */
    const districtCount = await this.districtRepo.count({
      where: { region_id: String(id) },
    });
    if (districtCount > 0) {
      this.badRequest(
        `Bu viloyatda ${districtCount} ta tuman bor — avval tumanlarni o'chiring yoki boshqa viloyatga birlashtiring.`,
      );
    }
    const usage = await this.collectGeoUsage({ region_id: String(id) });
    const posts = await this.postRepo.count({
      where: { region_id: String(id) },
    });
    if (this.geoUsageTotal(usage) + posts > 0) {
      const details = [
        this.describeGeoUsage(usage),
        posts ? `${posts} ta pochta` : '',
      ]
        .filter(Boolean)
        .join(', ');
      this.badRequest(
        `Bu viloyatga ${details} bog'langan — o'chirib bo'lmaydi.`,
      );
    }

    const deletedSnapshot = { name: region.name, sato_code: region.sato_code };
    // `remove` dan keyin `id` undefined bo'ladi — qidiruv uchun nusxa oldin.
    const searchRef = { ...region };

    await this.regionRepo.remove(region);
    void this.removeRegionFromSearch(searchRef);

    await this.activityLog.log({
      entity_type: 'Region',
      entity_id: String(id),
      action: ActivityAction.DELETED,
      old_value: deletedSnapshot,
    });

    return successRes({ id }, 200, 'Region deleted');
  }

  // ==================== Logist biriktirish (dzyVftBx) ====================

  /**
   * (dzyVftBx) `logist_id` faqat identity'dagi HAQIQIY, o'chirilmagan va FAOL
   * LOGIST bo'lishi mumkin (`identity.logist.find_by_ids` faqat
   * `role = logist, is_deleted = false` qatorlarini qaytaradi; rol bu yerda
   * ham qayta tekshiriladi).
   *
   * - topilmadi / boshqa rol → 404;
   * - bloklangan (status ≠ active) → 400;
   * - identity javob bermadi yoki javob shakli buzuq → 503 (fail-closed).
   */
  private async resolveActiveLogist(
    logistId: string,
  ): Promise<{ id: string; name: string | null }> {
    let rows: unknown;
    try {
      const res = await lastValueFrom(
        this.identityClient
          .send<{
            data?: unknown;
          }>({ cmd: 'identity.logist.find_by_ids' }, { ids: [logistId] })
          .pipe(timeout(LOGIST_CHECK_TIMEOUT_MS)),
      );
      rows = res?.data;
    } catch (error) {
      this.logger.warn(
        `identity.logist.find_by_ids(${logistId}) failed: ${(error as Error)?.message ?? error}`,
      );
      throw new RpcException(errorRes(LOGIST_CHECK_UNAVAILABLE_MESSAGE, 503));
    }
    if (!Array.isArray(rows)) {
      throw new RpcException(errorRes(LOGIST_CHECK_UNAVAILABLE_MESSAGE, 503));
    }

    const list: unknown[] = rows;
    const row = list.find(
      (
        item,
      ): item is {
        id: string | number;
        role?: unknown;
        status?: unknown;
        name?: unknown;
      } => {
        if (!item || typeof item !== 'object') {
          return false;
        }
        return canonicalBigintId((item as { id?: unknown }).id) === logistId;
      },
    );
    const role = typeof row?.role === 'string' ? row.role.toLowerCase() : '';
    if (!row || role !== Roles.LOGIST) {
      this.notFound(LOGIST_NOT_FOUND_MESSAGE);
    }
    const status =
      typeof row.status === 'string' ? row.status.trim().toLowerCase() : '';
    if (status !== Status.ACTIVE) {
      this.badRequest(LOGIST_INACTIVE_MESSAGE);
    }
    return {
      id: logistId,
      name: typeof row.name === 'string' ? row.name : null,
    };
  }

  /** `logist_id` maydoni: `null` — olib tashlash; yo'q yoki buzuq → 400. */
  private parseLogistIdField(value: unknown): string | null {
    if (value === null) {
      return null;
    }
    if (value === undefined) {
      this.badRequest('logist_id majburiy (olib tashlash uchun null yuboring)');
    }
    const logistId = canonicalBigintId(value);
    if (!logistId) {
      this.badRequest("logist_id noto'g'ri");
    }
    return logistId;
  }

  /**
   * (dzyVftBx) PATCH /region/:id/logist — bitta viloyatga logist biriktirish
   * yoki `logist_id: null` bilan olib tashlash. Viloyatda bitta logist
   * (`regions.logist_id`); boshqa logistning viloyatiga biriktirilsa, u
   * yangi logistga o'tadi. Faqat superadmin/admin (gateway ham shuni talab
   * qiladi — ikkinchi qatlam).
   */
  async assignRegionLogist(
    id: string,
    logistIdInput: unknown,
    requester?: RequesterContext,
  ) {
    if (!this.isSystemPrivileged(requester)) {
      this.forbidden(
        'Viloyatga logistni faqat admin yoki superadmin biriktira oladi',
      );
    }

    const regionId = canonicalBigintId(id);
    if (!regionId) {
      this.badRequest("Region id noto'g'ri");
    }
    const logistId = this.parseLogistIdField(logistIdInput);

    const region = await this.regionRepo.findOne({ where: { id: regionId } });
    if (!region) {
      this.notFound('Region not found');
    }

    const logist = logistId ? await this.resolveActiveLogist(logistId) : null;

    const previousLogistId = canonicalBigintId(region.logist_id);
    region.logist_id = logistId;
    const saved = await this.regionRepo.save(region);

    await this.activityLog.logChange({
      entity_type: 'Region',
      entity_id: String(saved.id),
      action: logistId ? ActivityAction.ASSIGN : ActivityAction.UNASSIGN,
      old_value: { logist_id: previousLogistId },
      new_value: { logist_id: logistId },
      metadata: logist?.name ? { logist_name: logist.name } : null,
      ...this.auditActor(requester),
    });

    return successRes(
      saved,
      200,
      logistId ? 'Logist biriktirildi' : 'Logist olib tashlandi',
    );
  }

  /**
   * (dzyVftBx) POST /region/logist/bulk — BeePost `bulkAssignLogist`
   * semantikasi:
   *
   * - `logist_id` berilsa: `region_ids` dagi viloyatlar shu logistga o'tadi
   *   (boshqa logistdagi viloyat ham), logistning `region_ids` da YO'Q
   *   viloyatlaridan u olib tashlanadi (`logist_id = NULL`). `region_ids: []`
   *   — logist hamma viloyatdan olinadi. Boshqa logistlarning qolgan
   *   viloyatlari o'zgarmaydi.
   * - `logist_id: null`: faqat `region_ids` dagi viloyatlardan logist olinadi.
   *
   * Ikkala UPDATE bitta tranzaksiyada — yarim holat qolmaydi. Viloyatlar va
   * logist yozuvdan OLDIN tekshiriladi: biror id topilmasa hech narsa
   * o'zgarmaydi.
   */
  async bulkAssignRegionLogist(
    logistIdInput: unknown,
    regionIdsInput: unknown,
    requester?: RequesterContext,
  ) {
    if (!this.isSystemPrivileged(requester)) {
      this.forbidden(
        'Viloyatga logistni faqat admin yoki superadmin biriktira oladi',
      );
    }

    const logistId = this.parseLogistIdField(logistIdInput);

    if (!Array.isArray(regionIdsInput)) {
      this.badRequest("region_ids massiv bo'lishi kerak");
    }
    const rawRegionIds: unknown[] = regionIdsInput;
    const regionIds: string[] = [];
    const invalidRegionIds: string[] = [];
    for (const raw of rawRegionIds) {
      const regionId = canonicalBigintId(raw);
      if (!regionId) {
        invalidRegionIds.push(
          typeof raw === 'string' || typeof raw === 'number'
            ? String(raw)
            : typeof raw,
        );
      } else if (!regionIds.includes(regionId)) {
        regionIds.push(regionId);
      }
    }
    if (invalidRegionIds.length) {
      this.badRequest(`region_ids noto'g'ri: ${invalidRegionIds.join(', ')}`);
    }
    if (logistId === null && !regionIds.length) {
      this.badRequest(
        "Logist olib tashlanadigan viloyatlar (region_ids) ko'rsatilmagan",
      );
    }

    if (regionIds.length) {
      const existing = await this.regionRepo.find({
        where: { id: In(regionIds) },
      });
      const existingIds = new Set(existing.map((region) => String(region.id)));
      const missing = regionIds.filter((id) => !existingIds.has(id));
      if (missing.length) {
        this.notFound(`Viloyat topilmadi: ${missing.join(', ')}`);
      }
    }

    const logist = logistId ? await this.resolveActiveLogist(logistId) : null;

    const changes = await this.regionRepo.manager.transaction(
      async (manager) => {
        const repo = manager.getRepository(Region);
        // Tegiladigan viloyatlar: tanlanganlar + logistning hozirgilari
        // (audit uchun "oldin" holati). Kamida bittasi bor — yuqorida
        // `logist_id: null` + bo'sh `region_ids` rad etilgan.
        const touchedWhere: FindOptionsWhere<Region>[] = [];
        if (regionIds.length) {
          touchedWhere.push({ id: In(regionIds) });
        }
        if (logistId) {
          touchedWhere.push({ logist_id: logistId });
        }
        const touched = await repo.find({ where: touchedWhere });
        const before = new Map(
          touched.map((region) => [
            String(region.id),
            canonicalBigintId(region.logist_id),
          ]),
        );

        if (logistId) {
          // Logistning tanlanmagan viloyatlari — bitta UPDATE, shuning uchun
          // parallel biriktirish bilan poyga oynasi yo'q.
          await repo.update(
            regionIds.length
              ? { logist_id: logistId, id: Not(In(regionIds)) }
              : { logist_id: logistId },
            { logist_id: null },
          );
        }
        if (regionIds.length) {
          await repo.update({ id: In(regionIds) }, { logist_id: logistId });
        }

        const selected = new Set(regionIds);
        return Array.from(before.entries())
          .map(([regionId, previous]) => ({
            region_id: regionId,
            previous_logist_id: previous,
            logist_id: selected.has(regionId) ? logistId : null,
          }))
          .filter((change) => change.previous_logist_id !== change.logist_id);
      },
    );

    for (const change of changes) {
      await this.activityLog.logChange({
        entity_type: 'Region',
        entity_id: change.region_id,
        action: change.logist_id
          ? ActivityAction.ASSIGN
          : ActivityAction.UNASSIGN,
        old_value: { logist_id: change.previous_logist_id },
        new_value: { logist_id: change.logist_id },
        metadata: {
          source: 'bulk',
          ...(logist?.name ? { logist_name: logist.name } : {}),
        },
        ...this.auditActor(requester),
      });
    }

    const removedRegionIds = changes
      .filter((change) => change.logist_id === null)
      .map((change) => change.region_id);
    const reassignedFrom = changes
      .filter(
        (change) =>
          change.logist_id !== null && change.previous_logist_id !== null,
      )
      .map((change) => ({
        region_id: change.region_id,
        logist_id: change.previous_logist_id,
      }));

    return successRes(
      {
        logist_id: logistId,
        region_ids: regionIds,
        removed_region_ids: removedRegionIds,
        reassigned_from: reassignedFrom,
      },
      200,
      logistId
        ? `Logist ${regionIds.length} ta viloyatga biriktirildi`
        : `${regionIds.length} ta viloyatdan logist olib tashlandi`,
    );
  }

  /**
   * (dzyVftBx, TC4) ICHKI: logist o'chirilganda uning BARCHA viloyatlarida
   * `logist_id = NULL` — DB'dagi `ON DELETE SET NULL` ning ilova qatlamidagi
   * o'rnini bosuvchi (user soft-delete bo'ladi va sxemalararo FK yo'q).
   * Viloyatning o'zi o'chmaydi. Identity `deleteUser` chaqiradi (gateway
   * route'i yo'q); idempotent — qayta chaqirish xavfsiz.
   */
  async clearLogistFromRegions(
    logistIdInput: unknown,
    requester?: RequesterContext,
  ) {
    const logistId = canonicalBigintId(logistIdInput);
    if (!logistId) {
      this.badRequest("logist_id noto'g'ri");
    }

    const regions = await this.regionRepo.find({
      where: { logist_id: logistId },
    });
    if (regions.length) {
      await this.regionRepo.update(
        { logist_id: logistId },
        { logist_id: null },
      );
      for (const region of regions) {
        await this.activityLog.logChange({
          entity_type: 'Region',
          entity_id: String(region.id),
          action: ActivityAction.UNASSIGN,
          old_value: { logist_id: logistId },
          new_value: { logist_id: null },
          metadata: { reason: 'logist_deleted' },
          ...this.auditActor(requester),
        });
      }
    }

    return successRes(
      {
        logist_id: logistId,
        region_ids: regions.map((region) => String(region.id)),
      },
      200,
      'Logist viloyatlardan ajratildi',
    );
  }
}
