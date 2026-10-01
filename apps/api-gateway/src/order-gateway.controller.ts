import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  HttpCode,
  Inject,
  Logger,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { IsArray, IsNotEmpty, IsString } from 'class-validator';
import { ClientProxy } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { BodyStatusCodeInterceptor } from './body-status-code.interceptor';
import { AiStatusPoller } from './ai/ai-status.poller';
import { verifyAiOrders } from './ai-order/verify-ai-orders';
import {
  AI_CONFIRM_CONCURRENCY,
  AI_CONFIRM_DEADLINE_MS,
  AI_CONFIRM_REASON_TEXT,
  AI_DEDUPE_PREFIX,
  AI_PARSE_TOTAL_BUDGET_MS,
  AI_RESOLVE_TIMEOUT_MS,
  aiOrderSignature,
  runInLanes,
  toConfirmFailure,
  toParseFailure,
  type AiParseFailureReason,
} from './ai-order/ai-order.helpers';
import {
  AiConfirmOrderDto,
  AiConfirmRequestDto,
  AiParseRequestDto,
} from './dto/ai-order.swagger.dto';
import {
  AssignOrdersToCourierRequestDto,
  CouldNotDeliverOrderRequestDto,
  CreateOrderByTelegramBotRequestDto,
  CreateExternalOrderRequestDto,
  ExtraCostApprovalDecisionDto,
  InitiateOrderReturnRequestDto,
  CreateOrderRequestDto,
  HandoverCancelledOrdersToMarketRequestDto,
  OrdersArrayDto,
  ReceiveByScanDto,
  PartlySellOrderRequestDto,
  RollbackOrderRequestDto,
  ScanAssignOrderRequestDto,
  SellOrderRequestDto,
  SettlementBranchToHqDto,
  SettlementCourierToBranchDto,
  SettlementHqToMarketDto,
  UpdateOrderByIdRequestDto,
} from './dto/order.swagger.dto';
import {
  AI_IMAGE_MAX_BYTES,
  AI_MAX_IMAGES,
  AI_RPC_TIMEOUT_MS,
  AI_TEXT_MAX_CHARS,
  Order_status,
  RMQ_FIRE_AND_FORGET_TIMEOUT,
  Roles as RoleEnum,
  Where_deliver,
  matchesDeclaredType,
  requestContext,
  type AiHealthState,
  type AiOrderExtractRequest,
  type AiOrderExtractResponse,
} from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';

interface JwtUser {
  sub: string;
  username: string;
  roles: string[];
  branch_id?: string | null;
}

type BranchAssignment = {
  branch_id?: string | null;
  role?: string | null;
};

type UploadedProofFile = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

const PROOF_OPERATION_TIMEOUT_MS = 60000;

/** ai-parse rasmi (multer memoryStorage) — faqat RAM'da, hech qayerga yozilmaydi. */
type UploadedAiImage = {
  originalname?: string;
  mimetype: string;
  size?: number;
  buffer: Buffer;
};

/** ai-confirm natijasi — har kiruvchi buyurtmaga AYNAN bitta, `index` bo'yicha. */
type AiConfirmResult = {
  index: number;
  ok: boolean;
  order_id?: string;
  /** Odam o'qiydigan o'zbekcha sabab — frontend uni o'zgartirmasdan ko'rsatadi. */
  reason?: string;
  /** Mashina kaliti (district_not_found, duplicate_recent, ...). */
  code?: string;
};

/**
 * `successRes` konverti (`{statusCode, message, data}`). `successRes` o'zi
 * `data: any` qaytaradi — AI endpointlari javobi shu tip bilan aniq
 * ko'rsatiladi (frontend shartnomasi kompilyator nazoratida bo'lsin).
 */
type AiSuccessEnvelope<T> = { statusCode: number; message: string; data: T };

/**
 * ai-parse javobi — Elchi-Frontend `AiParseResponse`
 * (src/entities/ai-order/types.ts) bilan AYNAN bir xil YASSI shakl:
 * muvaffaqiyatda `{ok:true, orders, draft_id}`, AI holatlarida
 * `{ok:false, reason, message, scope?, reset_at?}` (`toParseFailure`).
 */
type AiParseResponseData = {
  ok: boolean;
  /** order-service'ning `AiOrderPreview[]` i — gateway o'zgartirmasdan uzatadi. */
  orders?: unknown[];
  draft_id?: string;
  reason?: AiParseFailureReason;
  message?: string;
  scope?: 'global';
  reset_at?: string;
};

/** Tekshiruvdan o'tgan, yaratishga navbatdagi AI buyurtma. */
type EligibleAiOrder = {
  index: number;
  order: AiConfirmOrderDto;
  signature: string;
  /** DB'dagi tuman yozuvidan — mijoz yuborgan qiymat EMAS. */
  districtId: string;
  regionId: string;
};

/**
 * ai-parse rasm turlari — faqat JPEG va PNG. Frontend rasmni canvas orqali
 * JPEG'ga o'giradi; webp/gif file-service'da ham yo'q.
 */
const AI_IMAGE_MIME_ALLOWLIST = new Set(['image/jpeg', 'image/png']);
/**
 * multer'ning o'z chegarasi ATAYLAB 2 MB dan katta: 2..8 MB li rasmni handler
 * tushunarli 400 ("Rasm 2 MB dan katta") bilan rad etadi, multer esa 413
 * qaytarardi.
 */
const AI_MULTER_FILE_SIZE_LIMIT = 8 * 1024 * 1024;
/**
 * multer `memoryStorage` — ai-parse rasmi faqat RAM'dagi Buffer'da qoladi
 * (diskka/MinIO'ga YOZILMAYDI). `multer` paketida TS tiplari yo'q
 * (@types/multer o'rnatilmagan), shu sabab imzo shu yerda aniq berilgan —
 * aks holda chaqiruv tiplanmagan (`any`) qiymat bo'lib qoladi.
 */
const createAiImageMemoryStorage = memoryStorage as () => unknown;
/** Preview uchun shundan kam vaqt qolsa order-service chaqirilmaydi. */
const AI_MIN_PREVIEW_BUDGET_MS = 5_000;
/** ai-confirm'dagi find_by_ids tekshiruvlari (partiyaga BITTADAN). */
const AI_CONFIRM_LOOKUP_TIMEOUT_MS = 8_000;

class ReceiveExternalOrdersDto {
  @IsString()
  @IsNotEmpty()
  integration_id!: string;

  @IsArray()
  orders!: any[];
}

@ApiTags('Orders')
@Controller('orders')
// Javob tanasidagi statusCode (masalan 202 — market tasdig'i kutilmoqda) HTTP
// holatiga ham chiqsin; aks holda POST doim 201 qaytarardi.
@UseInterceptors(BodyStatusCodeInterceptor)
export class OrderGatewayController {
  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Optional() @Inject('FILE') private readonly fileClient?: ClientProxy,
    // ⚠️ AI bog'liqliklari OXIRIGA va @Optional qo'shilgan: mavjud spec'lar
    // kontrollerni pozitsion argumentlar bilan quradi va o'zgarmasdan
    // kompilyatsiya bo'lishi shart.
    @Optional() @Inject('AI') private readonly aiClient?: ClientProxy,
    @Optional() @Inject('CATALOG') private readonly catalogClient?: ClientProxy,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly aiStatus?: AiStatusPoller,
  ) {}

  private readonly logger = new Logger(OrderGatewayController.name);

  private normalizeRoles(roles?: string[]) {
    const normalized = new Set<string>();
    for (const rawRole of roles ?? []) {
      const role = String(rawRole ?? '')
        .trim()
        .toLowerCase();
      if (!role) {
        continue;
      }
      normalized.add(role);
    }
    return Array.from(normalized);
  }

  private toSnakeCaseKey(value: string) {
    return value
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/-/g, '_')
      .toLowerCase();
  }

  private toLegacyShape<T>(value: T): T {
    if (Array.isArray(value)) {
      return value.map((item) => this.toLegacyShape(item)) as T;
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([key, nestedValue]) => [
            this.toSnakeCaseKey(key),
            this.toLegacyShape(nestedValue),
          ],
        ),
      ) as T;
    }

    return value;
  }

  private async sendOrderWithTimeout(
    pattern: { cmd: string },
    payload: object,
  ) {
    return firstValueFrom(
      this.orderClient.send(pattern, payload).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  private async sendOrderWithFallback(
    primary: { cmd: string },
    fallback: { cmd: string },
    payload: object,
  ) {
    try {
      return await this.sendOrderWithTimeout(primary, payload);
    } catch (error) {
      if (error instanceof GatewayTimeoutException) {
        throw error;
      }
      return this.sendOrderWithTimeout(fallback, payload);
    }
  }

  private async sendIdentityWithTimeout(
    pattern: { cmd: string },
    payload: object,
  ) {
    return firstValueFrom(
      this.identityClient.send(pattern, payload).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Identity service response timeout');
      }
      throw error;
    });
  }

  private async sendLogisticsWithTimeout(
    pattern: { cmd: string },
    payload: object,
  ) {
    return firstValueFrom(
      this.logisticsClient.send(pattern, payload).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Logistics service response timeout');
      }
      throw error;
    });
  }

  private async findAllCourierPostIds(reqUser?: JwtUser): Promise<string[]> {
    const requester = {
      id: reqUser?.sub,
      roles: reqUser?.roles ?? [],
    };
    const firstResponse = await this.sendLogisticsWithTimeout(
      { cmd: 'logistics.post.my_for_courier' },
      { page: 1, limit: 100, requester },
    );
    const firstBody = firstResponse?.data ?? firstResponse;
    const posts = this.extractRows(firstBody);
    const totalPages = Math.max(
      1,
      Number(firstBody?.totalPages ?? firstBody?.total_pages ?? 1),
    );

    if (totalPages > 1) {
      const remainingResponses = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, index) => index + 2).map(
          (postPage) =>
            this.sendLogisticsWithTimeout(
              { cmd: 'logistics.post.my_for_courier' },
              { page: postPage, limit: 100, requester },
            ),
        ),
      );
      remainingResponses.forEach((response) => {
        posts.push(...this.extractRows(response?.data ?? response));
      });
    }

    return Array.from(
      new Set(posts.map((post) => this.asStr(post?.id)).filter(Boolean)),
    );
  }

  private async findCourierCancelledRows(
    reqUser: JwtUser | undefined,
    filters: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    const requesterId = String(reqUser?.sub ?? '').trim();
    if (!requesterId) {
      return [];
    }

    const courierPostIds = await this.findAllCourierPostIds(reqUser).catch(
      () => [],
    );
    const courierPostIdSet = new Set(courierPostIds);
    const baseQuery = {
      ...filters,
      status: [Order_status.CANCELLED, Order_status.CANCELLED_SENT],
      fetch_all: true,
      disable_pagination: true,
      page: undefined,
      limit: undefined,
    };
    const requests = [
      this.sendOrderWithFallback(
        { cmd: 'order.find_all_enriched' },
        { cmd: 'order.find_all' },
        { query: { ...baseQuery, courier_ids: [requesterId] } },
      ),
      this.sendOrderWithFallback(
        { cmd: 'order.find_all_enriched' },
        { cmd: 'order.find_all' },
        { query: { ...baseQuery, holder_courier_ids: [requesterId] } },
      ),
    ];

    if (courierPostIds.length) {
      requests.push(
        this.sendOrderWithFallback(
          { cmd: 'order.find_all_enriched' },
          { cmd: 'order.find_all' },
          { query: { ...baseQuery, post_ids: courierPostIds } },
        ),
      );
    }

    const responses = await Promise.all(requests);
    const postHistoryRowIds = new Set(
      (courierPostIds.length
        ? this.extractRows(responses[2]?.data ?? responses[2])
        : []
      )
        .map((row) => this.asStr(row?.id).trim())
        .filter(Boolean),
    );
    const uniqueRows = new Map<string, Record<string, unknown>>();
    responses
      .flatMap((response) => this.extractRows(response?.data ?? response))
      .filter((row) => {
        const holderType = this.asStr(row?.holder_type ?? row?.holderType)
          .trim()
          .toUpperCase();
        const courierId = this.asStr(row?.courier_id ?? row?.courierId).trim();
        const holderCourierId = this.asStr(
          row?.holder_courier_id ?? row?.holderCourierId,
        ).trim();
        const status = this.asStr(row?.status).trim().toLowerCase();
        const transportStatus = this.asStr(
          row?.transport_status ?? row?.transportStatus,
        )
          .trim()
          .toLowerCase();
        const canceledPostId = this.asStr(
          row?.canceled_post_id ?? row?.canceledPostId,
        ).trim();
        const parentOrderId = this.asStr(
          row?.parent_order_id ?? row?.parentOrderId,
        ).trim();
        const postId = this.asStr(row?.post_id ?? row?.postId).trim();

        if (
          status === Order_status.CANCELLED_SENT ||
          transportStatus === Order_status.CANCELLED_SENT
        ) {
          return false;
        }
        if (holderType === 'COURIER') {
          return holderCourierId === requesterId || courierId === requesterId;
        }
        if (holderType === 'BRANCH' || holderType === 'HQ') {
          return (
            Boolean(parentOrderId) &&
            !canceledPostId &&
            (courierId === requesterId ||
              holderCourierId === requesterId ||
              (courierPostIdSet.has(postId) &&
                postHistoryRowIds.has(this.asStr(row?.id).trim())))
          );
        }
        if (!holderType && !courierId && !holderCourierId) {
          return true;
        }
        return courierId === requesterId || holderCourierId === requesterId;
      })
      .forEach((row) => {
        const id = this.asStr(row?.id).trim();
        if (id) {
          uniqueRows.set(id, row);
        }
      });
    return Array.from(uniqueRows.values()).map((row) =>
      this.normalizeCourierCancelledRowForDisplay(row),
    );
  }

  private normalizeProofFileKeys(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .flatMap((item) => this.normalizeProofFileKeys(item))
        .filter(Boolean);
    }
    if (typeof value !== 'string') return [];

    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return this.normalizeProofFileKeys(parsed);
    } catch {
      // Keep plain form-data values such as "key1,key2" supported.
    }
    return trimmed
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);
  }

  private async uploadProofFile(file?: UploadedProofFile): Promise<string[]> {
    if (!file) return [];
    if (!this.fileClient) {
      throw new BadRequestException('File service is not configured');
    }

    const response = await firstValueFrom(
      this.fileClient
        .send(
          { cmd: 'file.upload' },
          {
            file_name: file.originalname,
            mime_type: file.mimetype,
            file_base64: file.buffer.toString('base64'),
            folder: 'proof',
          },
        )
        .pipe(timeout(PROOF_OPERATION_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('File service response timeout');
      }
      throw error;
    });

    const key = this.asStr(
      (response as { data?: { key?: unknown }; key?: unknown })?.data?.key ??
        (response as { key?: unknown })?.key,
    ).trim();
    if (!key) {
      throw new BadRequestException('Proof file upload did not return a key');
    }
    return [key];
  }

  private async withUploadedProof<
    T extends { proofFileKeys?: string[]; proofFileKeysVerified?: boolean },
  >(dto: T, file?: UploadedProofFile): Promise<T> {
    const existingKeys = this.normalizeProofFileKeys(dto?.proofFileKeys);
    const uploadedKeys = await this.uploadProofFile(file);
    return {
      ...dto,
      proofFileKeys: Array.from(new Set([...existingKeys, ...uploadedKeys])),
      proofFileKeysVerified:
        uploadedKeys.length > 0 && existingKeys.length === 0,
    };
  }

  private async sendBranchWithTimeout(
    pattern: { cmd: string },
    payload: object,
  ) {
    return firstValueFrom(
      this.branchClient.send(pattern, payload).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Branch service response timeout');
      }
      throw error;
    });
  }

  private isBranchStaffAssignment(
    assignment?: BranchAssignment | null,
  ): boolean {
    const role = String(assignment?.role ?? '').toUpperCase();
    return role === 'MANAGER' || role === 'REGISTRATOR' || role === 'BRANCH';
  }

  /**
   * Object-level authorization for reading a SINGLE order (find_by_id, tracking).
   * Order ids are sequential bigints, so without this any authenticated account
   * could enumerate every order's financials + customer PII (IDOR). Mirrors the
   * list-endpoint scoping. Throws ForbiddenException when not allowed.
   */
  private async assertCanViewOrder(
    reqUser: JwtUser | undefined,
    order: Record<string, any> | null | undefined,
  ): Promise<void> {
    if (!order || typeof order !== 'object') {
      return; // nothing fetched (not-found) — let the normal response through
    }
    const roles = this.normalizeRoles(reqUser?.roles);
    // Internal full-access staff (consistent with the unscoped list endpoint).
    if (
      roles.includes(RoleEnum.SUPERADMIN) ||
      roles.includes(RoleEnum.ADMIN) ||
      roles.includes(RoleEnum.OPERATOR) ||
      roles.includes(RoleEnum.MARKET_OPERATOR)
    ) {
      return;
    }
    const sub = String(reqUser?.sub ?? '').trim();
    const field = (key: string): string =>
      String(order?.[key] ?? order?.[this.toCamelKey(key)] ?? '').trim();
    const denied = (): never => {
      throw new ForbiddenException("Bu buyurtmani ko'rishga ruxsat yo'q");
    };

    if (roles.includes(RoleEnum.MARKET)) {
      return sub && field('market_id') === sub ? undefined : denied();
    }
    if (roles.includes(RoleEnum.CUSTOMER)) {
      return sub && field('customer_id') === sub ? undefined : denied();
    }
    if (roles.includes(RoleEnum.COURIER)) {
      return sub &&
        (field('courier_id') === sub || field('holder_courier_id') === sub)
        ? undefined
        : denied();
    }
    if (
      roles.includes(RoleEnum.BRANCH) ||
      roles.includes(RoleEnum.MANAGER) ||
      roles.includes(RoleEnum.REGISTRATOR)
    ) {
      const assignment = await this.resolveBranchAssignment(reqUser as JwtUser);
      const branchId = String(assignment?.branch_id ?? '').trim();
      const orderBranches = [
        field('branch_id'),
        field('holder_branch_id'),
        field('home_branch_id'),
      ];
      return branchId && orderBranches.includes(branchId)
        ? undefined
        : denied();
    }
    // investor / unknown roles: no per-order access.
    return denied();
  }

  private async assertCanViewOrderTracking(
    reqUser: JwtUser | undefined,
    order: Record<string, any> | null | undefined,
  ): Promise<void> {
    if (!order || typeof order !== 'object') {
      return;
    }

    const roles = this.normalizeRoles(reqUser?.roles);
    if (roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN)) {
      return;
    }

    const sub = String(reqUser?.sub ?? '').trim();
    const field = (key: string): string =>
      String(order?.[key] ?? order?.[this.toCamelKey(key)] ?? '').trim();
    const holderType = field('holder_type').toUpperCase();
    const denied = (): never => {
      throw new ForbiddenException(
        "Bu buyurtma trackingini ko'rishga ruxsat yo'q",
      );
    };

    if (roles.includes(RoleEnum.COURIER)) {
      return sub &&
        holderType === 'COURIER' &&
        field('holder_courier_id') === sub
        ? undefined
        : denied();
    }

    if (
      roles.includes(RoleEnum.BRANCH) ||
      roles.includes(RoleEnum.MANAGER) ||
      roles.includes(RoleEnum.REGISTRATOR)
    ) {
      const assignment = await this.resolveBranchAssignment(reqUser as JwtUser);
      const branchId = String(assignment?.branch_id ?? '').trim();
      return branchId &&
        holderType === 'BRANCH' &&
        field('holder_branch_id') === branchId
        ? undefined
        : denied();
    }

    return denied();
  }

  private toCamelKey(snake: string): string {
    return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }

  private async resolveBranchAssignment(
    reqUser: JwtUser,
  ): Promise<BranchAssignment | null> {
    const normalizedRoles = this.normalizeRoles(reqUser.roles);
    const jwtBranchId = String(reqUser?.branch_id ?? '').trim();
    const canUseJwtBranch =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);

    if (canUseJwtBranch && jwtBranchId) {
      const inferredRole =
        normalizedRoles.find((role) =>
          [RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR].includes(
            role as RoleEnum,
          ),
        ) ?? RoleEnum.BRANCH;
      return {
        branch_id: jwtBranchId,
        role: inferredRole.toUpperCase(),
      };
    }

    const response = await this.sendBranchWithTimeout(
      { cmd: 'branch.user.find_by_user' },
      {
        user_id: reqUser.sub,
        requester: { id: reqUser.sub, roles: reqUser.roles ?? [] },
      },
    );

    return (response?.data ?? null) as BranchAssignment | null;
  }

  private normalizeLegacyOrderRow(row: Record<string, unknown>) {
    const normalized = { ...row };
    if ('is_deleted' in normalized) {
      normalized.deleted = normalized.is_deleted;
      delete normalized.is_deleted;
    }
    return this.normalizeOrderStatusForDisplay(normalized);
  }

  private normalizeOrderStatusForDisplay(row: Record<string, unknown>) {
    const normalized = { ...row };
    if (this.asStr(normalized.status) === Order_status.CANCELLED_SENT) {
      normalized.status = Order_status.CANCELLED;
      normalized.transport_status = Order_status.CANCELLED_SENT;
    }
    return normalized;
  }

  private normalizeCourierCancelledRowForDisplay(row: Record<string, unknown>) {
    const normalized = this.normalizeOrderStatusForDisplay(row);
    const parentOrderId = this.asStr(
      normalized.parent_order_id ?? normalized.parentOrderId,
    ).trim();

    if (!parentOrderId) {
      return normalized;
    }

    return {
      ...normalized,
      partial_parent_order_id: parentOrderId,
      partialParentOrderId: parentOrderId,
      parent_order_id: null,
      parentOrderId: null,
    };
  }

  private extractRows(payload: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(payload)) {
      return payload as Array<Record<string, unknown>>;
    }
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (Array.isArray(obj.data)) {
        return obj.data as Array<Record<string, unknown>>;
      }
    }
    return [];
  }

  /**
   * Xom RPC natijalari `unknown`/`any` bo'ladi; id/status kabi maydonlar odatda
   * matn yoki son. Obyekt kelib qolsa `String(...)` "[object Object]" beradi —
   * shu bois obyektni bo'sh matnga aylantiramiz, primitivlarni esa avvalgidek
   * `String(...)` bilan (xulq o'zgarmaydi).
   */
  private asStr(value: unknown): string {
    if (typeof value === 'string') return value;
    if (
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'boolean'
    ) {
      return String(value);
    }
    return '';
  }

  private parsePaginationQuery(page?: string, limit?: string) {
    const allowedLimits = [10, 25, 50, 100];
    const parsedLimit = Number(limit ?? 10);
    if (!Number.isFinite(parsedLimit) || !allowedLimits.includes(parsedLimit)) {
      throw new BadRequestException(
        `limit faqat ${allowedLimits.join(', ')} bo'lishi mumkin`,
      );
    }

    const parsedPage = Number(page ?? 1);
    const normalizedPage =
      Number.isFinite(parsedPage) && parsedPage >= 1
        ? Math.floor(parsedPage)
        : 1;

    return { page: normalizedPage, limit: parsedLimit };
  }

  private parseStatusQuery(status?: string | string[]) {
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
      throw new BadRequestException(
        `Noto'g'ri status qiymati: ${invalidValues.join(', ')}`,
      );
    }

    const statuses = flattened;

    return Array.from(new Set(statuses)) as Order_status[];
  }

  private withPaginationMeta(
    payload: unknown,
    fallback: { page: number; limit: number },
  ) {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }
    const body = payload as Record<string, unknown>;
    const rows = this.extractRows(body);
    const total = Number(body.total ?? rows.length ?? 0);
    const page = Number(body.page ?? fallback.page);
    const limit = Number(body.limit ?? fallback.limit);
    const paginationMeta = this.buildPaginationMeta(total, page, limit);

    return {
      ...body,
      data: (Array.isArray(body.data) ? body.data : rows).map((row) =>
        row && typeof row === 'object'
          ? this.normalizeOrderStatusForDisplay(row as Record<string, unknown>)
          : row,
      ),
      total,
      page,
      limit,
      ...paginationMeta,
    };
  }

  private buildPaginationMeta(total: number, page: number, limit: number) {
    const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeLimit =
      Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
    const totalPages = safeLimit > 0 ? Math.ceil(safeTotal / safeLimit) : 0;
    const from = safeTotal === 0 ? 0 : (safePage - 1) * safeLimit + 1;
    const to = Math.min(safeTotal, safePage * safeLimit);

    return {
      total_pages: totalPages,
      totalPages,
      from,
      to,
      has_next: safePage < totalPages,
      hasNext: safePage < totalPages,
      has_prev: safePage > 1 && totalPages > 0,
      hasPrev: safePage > 1 && totalPages > 0,
    };
  }

  private toManagerCancelledTabResponse(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    const body = payload as Record<string, unknown>;
    const rows = this.extractRows(body);
    const data = rows.map((row) => {
      const realStatus = this.asStr(row.status);
      if (realStatus !== Order_status.CANCELLED_SENT) {
        return row;
      }

      return {
        ...row,
        status: Order_status.CANCELLED,
        transport_status: Order_status.CANCELLED_SENT,
      };
    });

    return { ...body, data };
  }

  private async enrichMarketRows(rows: Array<Record<string, any>>) {
    const marketIds = Array.from(
      new Set(rows.map((row) => String(row?.market_id ?? '')).filter(Boolean)),
    );

    if (!marketIds.length) {
      return rows;
    }

    const marketsResponse = await this.sendIdentityWithTimeout(
      { cmd: 'identity.market.find_by_ids' },
      { ids: marketIds },
    );
    const markets = marketsResponse?.data ?? [];
    const marketMap = new Map(
      markets.map((market: Record<string, any>) => [String(market.id), market]),
    );

    return rows.map((row) => ({
      ...row,
      market: marketMap.get(String(row.market_id)) ?? null,
    }));
  }

  // ─── AI buyurtma yordamchilari (ai-parse / ai-confirm / ai-availability) ───

  /**
   * `AI_ORDER_ENABLED` — operatsion o'chirgich. ConfigService Joi'dan o'tgan
   * boolean qaytaradi; ehtiyot uchun satr ko'rinishi ham tushuniladi.
   * Config yo'q bo'lsa (masalan spec) — o'chiq.
   */
  private isAiOrderEnabled(): boolean {
    const raw: unknown = this.config?.get<unknown>('AI_ORDER_ENABLED');
    if (typeof raw === 'boolean') return raw;
    return ['true', '1', 'yes'].includes(this.asStr(raw).trim().toLowerCase());
  }

  /**
   * AI oqimi uchun market SERVER tomonda aniqlanadi (mijozga ishonilmaydi):
   *  - MARKET — token `sub`; tanadagi market_id E'TIBORSIZ;
   *  - MARKET_OPERATOR — identity `user.market_id`; bo'lmasa `{noMarket}`
   *    (parse → 200 no_market, confirm → 400);
   *  - SUPERADMIN / ADMIN / REGISTRATOR / MANAGER — tanadagi market_id
   *    majburiy, aks holda 400.
   */
  private async resolveAiMarket(
    user: JwtUser,
    bodyMarketId?: string,
  ): Promise<{ marketId: string } | { noMarket: true }> {
    const roles = this.normalizeRoles(user?.roles);
    if (roles.includes(RoleEnum.MARKET)) {
      const marketId = this.asStr(user?.sub).trim();
      return marketId ? { marketId } : { noMarket: true };
    }
    if (roles.includes(RoleEnum.MARKET_OPERATOR)) {
      const operatorProfile: unknown = await this.sendIdentityWithTimeout(
        { cmd: 'identity.user.find_by_id' },
        { id: user.sub },
      ).catch(() => null);
      const marketId = this.asStr(
        (operatorProfile as { data?: { market_id?: unknown } } | null)?.data
          ?.market_id,
      ).trim();
      return marketId ? { marketId } : { noMarket: true };
    }
    const marketId = this.asStr(bodyMarketId).trim();
    if (!marketId) {
      throw new BadRequestException('market_id majburiy');
    }
    return { marketId };
  }

  /**
   * ai-parse kiritmasini Claude'ga BORISHDAN OLDIN tekshiradi — xato 400.
   * Tartib: bo'sh kiritish → matn uzunligi → rasm soni → har rasm uchun
   * tur (allowlist) → hajm (2 MB) → haqiqiy imzo (magic bytes).
   */
  private assertAiParseInput(text: string, images: UploadedAiImage[]): void {
    if (!text && !images.length) {
      throw new BadRequestException('Matn yoki rasm yuboring');
    }
    if (text.length > AI_TEXT_MAX_CHARS) {
      throw new BadRequestException(
        `Matn ${AI_TEXT_MAX_CHARS} belgidan oshmasligi kerak`,
      );
    }
    if (images.length > AI_MAX_IMAGES) {
      throw new BadRequestException(
        `Ko'pi bilan ${AI_MAX_IMAGES} ta rasm yuborish mumkin`,
      );
    }
    for (const image of images) {
      const mime = this.asStr(image?.mimetype).toLowerCase();
      if (!AI_IMAGE_MIME_ALLOWLIST.has(mime)) {
        throw new BadRequestException('Faqat JPEG yoki PNG rasm');
      }
      const buffer = image.buffer;
      const size = Math.max(Number(image.size) || 0, buffer?.length ?? 0);
      if (size > AI_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Rasm 2 MB dan katta');
      }
      // `mimetype` ni MIJOZ yozadi — haqiqiy imzo tekshiriladi (audit S8).
      if (!Buffer.isBuffer(buffer) || !matchesDeclaredType(buffer, mime)) {
        throw new BadRequestException('Rasm fayli buzilgan yoki turi mos emas');
      }
    }
  }

  /**
   * AI RPC xatosini sababga o'giradi: timeout → 'network' (frontend
   * "Qayta urinib ko'ring"), boshqa har qanday xato → 'ai_error'.
   * ⚠️ Faqat xato TURI log qilinadi — payload/matn HECH QACHON.
   */
  private aiRpcFailureReason(
    error: unknown,
    cmd: string,
  ): 'network' | 'ai_error' {
    if (error instanceof TimeoutError) {
      this.logger.warn(`${cmd}: javob kelmadi (timeout) — reason=network`);
      return 'network';
    }
    this.logger.warn(
      `${cmd}: RPC xatosi (${this.errorName(error)}) — reason=ai_error`,
    );
    return 'ai_error';
  }

  private errorName(error: unknown): string {
    if (error instanceof Error) return error.name || 'Error';
    return typeof error;
  }

  /** `order.ai_resolve_preview` javobidan preview massivi; shakl buzuq bo'lsa null. */
  private extractAiPreviews(response: unknown): unknown[] | null {
    const body = response as {
      previews?: unknown;
      data?: { previews?: unknown };
    } | null;
    if (Array.isArray(body?.previews)) return body.previews as unknown[];
    if (Array.isArray(body?.data?.previews)) {
      return body.data.previews as unknown[];
    }
    return null;
  }

  private distinctIds(values: unknown[]): string[] {
    return Array.from(
      new Set(values.map((value) => this.asStr(value).trim()).filter(Boolean)),
    );
  }

  private isDeletedRow(row: Record<string, unknown>): boolean {
    return row?.isDeleted === true || row?.is_deleted === true;
  }

  private async findAiConfirmProducts(ids: string[]): Promise<unknown> {
    if (!this.catalogClient) {
      throw new Error('CATALOG client sozlanmagan');
    }
    return firstValueFrom(
      this.catalogClient
        .send<unknown>({ cmd: 'catalog.product.find_by_ids' }, { ids })
        .pipe(timeout(AI_CONFIRM_LOOKUP_TIMEOUT_MS)),
    );
  }

  /**
   * ai-confirm SERVER TOMONDA QAYTA TEKSHIRUVI uchun ma'lumot: partiyadagi
   * barcha tumanlar BITTA `logistics.district.find_by_ids`, barcha mahsulotlar
   * BITTA `catalog.product.find_by_ids` bilan o'qiladi (wgqxS0Cp #11).
   * Istalgan biri ishlamasa `null` — chaqiruvchi hamma buyurtmani
   * `validation_unavailable` qiladi (tekshiruvsiz yaratish YO'Q).
   */
  private async loadAiConfirmLookups(orders: AiConfirmOrderDto[]): Promise<{
    districts: Array<Record<string, unknown>>;
    products: Array<Record<string, unknown>>;
  } | null> {
    const districtIds = this.distinctIds(
      orders.flatMap((order) => [
        order?.district_id,
        order?.customer?.district_id,
      ]),
    );
    const productIds = this.distinctIds(
      orders.flatMap((order) =>
        (Array.isArray(order?.items) ? order.items : []).map(
          (item) => item?.product_id,
        ),
      ),
    );
    try {
      const [districtResponse, productResponse]: [unknown, unknown] =
        await Promise.all([
          districtIds.length
            ? firstValueFrom(
                this.logisticsClient
                  .send<unknown>(
                    { cmd: 'logistics.district.find_by_ids' },
                    { ids: districtIds },
                  )
                  .pipe(timeout(AI_CONFIRM_LOOKUP_TIMEOUT_MS)),
              )
            : Promise.resolve([]),
          productIds.length
            ? this.findAiConfirmProducts(productIds)
            : Promise.resolve([]),
        ]);
      return {
        districts: this.extractRows(districtResponse).filter(
          (row) => !this.isDeletedRow(row),
        ),
        products: this.extractRows(productResponse),
      };
    } catch (error: unknown) {
      this.logger.warn(
        `ai-confirm: tuman/mahsulot tekshiruvi ishlamadi (${this.errorName(error)}) — validation_unavailable`,
      );
      return null;
    }
  }

  /**
   * Bitta tasdiqlangan AI buyurtmani mavjud `POST /orders` yo'li
   * (`createOrderInternal`) bilan yaratadi.
   *
   * ⚠️ `status`, `source`, `branch_id` YUBORILMAYDI: holat sukutdagi NEW
   * ("Yangi buyurtmalar" ekranida ko'rinadi — bot yo'lidagi CREATED tuzog'i
   * takrorlanmaydi), filial esa rol bo'yicha `createOrderInternal` da
   * qo'yiladi. `region_id` — DB'dagi tuman yozuvidan. `operator` — FAQAT
   * matn; `operator_id` `createOrderInternal` da faqat ROLDAN qo'yiladi
   * (MARKET → null, MARKET_OPERATOR/REGISTRATOR → sub), matndan HECH QACHON.
   */
  private async createAiOrder(
    item: EligibleAiOrder,
    req: { user: JwtUser },
    ctx: {
      marketId: string;
      includeMarketId: boolean;
      branchAssignment: BranchAssignment | null;
    },
  ): Promise<AiConfirmResult> {
    const { order, index } = item;
    const mapped: CreateOrderRequestDto = {
      customer: {
        name: order.customer.name,
        phone_number: order.customer.phone_number,
        district_id: item.districtId,
        ...(order.customer.extra_number
          ? { extra_number: order.customer.extra_number }
          : {}),
        ...(order.customer.address ? { address: order.customer.address } : {}),
      },
      ...(ctx.includeMarketId ? { market_id: ctx.marketId } : {}),
      district_id: item.districtId,
      region_id: item.regionId,
      address: order.address ?? order.customer.address ?? null,
      where_deliver: order.where_deliver,
      total_price: order.total_price,
      comment: order.comment ?? null,
      operator: order.operator ?? null,
      items: order.items.map((orderItem) =>
        orderItem.product_id
          ? {
              product_id: String(orderItem.product_id),
              quantity: orderItem.quantity,
            }
          : {
              product_name: this.asStr(orderItem.product_name),
              quantity: orderItem.quantity,
            },
      ),
    };

    const response: unknown = await this.createOrderInternal(mapped, req, {
      requestId: `${AI_DEDUPE_PREFIX}${item.signature}`,
      marketId: ctx.marketId,
      branchAssignment: ctx.branchAssignment,
    });
    const body = (response ?? {}) as {
      id?: unknown;
      data?: { id?: unknown } | null;
      idempotent_replay?: unknown;
    };
    const orderId = this.asStr(body.data?.id ?? body.id).trim();

    // order.create keshdan qaytdi — xuddi shu buyurtma 10 daqiqa ichida
    // allaqachon yaratilgan; yangisi YARATILMADI (wgqxS0Cp #13).
    if (body.idempotent_replay === true) {
      return {
        index,
        ok: false,
        code: 'duplicate_recent',
        ...(orderId ? { order_id: orderId } : {}),
        reason: `Bu buyurtma 10 daqiqa ichida allaqachon yaratilgan${
          orderId ? ` (#${orderId})` : ''
        } — takror yaratilmadi`,
      };
    }
    return { index, ok: true, ...(orderId ? { order_id: orderId } : {}) };
  }

  /**
   * AI xarajatini (ai_usage_log) yaratilgan buyurtmalarga bog'laydi — har
   * `draft_id` uchun BITTA `ai.usage.link_orders` (lYVuADRE #18).
   * Fire-and-forget: javob kutilmaydi, xato faqat WARN — buyurtma natijasiga
   * TA'SIR QILMAYDI. ⚠️ Qayta urinish YO'Q (ai.* RPC).
   */
  private linkAiUsageOrders(
    orders: AiConfirmOrderDto[],
    results: Map<number, AiConfirmResult>,
    marketId: string,
  ): void {
    if (!this.aiClient) return;
    const orderIdsByDraft = new Map<string, string[]>();
    orders.forEach((order, index) => {
      const result = results.get(index);
      const draftId = this.asStr(order?.draft_id).trim();
      if (!result?.ok || !result.order_id || !draftId) return;
      orderIdsByDraft.set(draftId, [
        ...(orderIdsByDraft.get(draftId) ?? []),
        result.order_id,
      ]);
    });
    for (const [draftId, orderIds] of orderIdsByDraft) {
      void firstValueFrom(
        this.aiClient
          .send(
            { cmd: 'ai.usage.link_orders' },
            { draft_id: draftId, order_ids: orderIds, market_id: marketId },
          )
          .pipe(timeout(RMQ_FIRE_AND_FORGET_TIMEOUT)),
      ).catch((error: unknown) => {
        this.logger.warn(
          `ai.usage.link_orders yuborilmadi (draft ${draftId}): ${this.errorName(error)}`,
        );
      });
    }
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
    RoleEnum.MANAGER,
    RoleEnum.BRANCH,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create order' })
  @ApiBody({ type: CreateOrderRequestDto })
  async create(
    @Body() dto: CreateOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.createOrderInternal(dto, req);
  }

  /**
   * `POST /orders` ning butun mantig'i — `create()` va `ai-confirm` ikkalasi
   * shu yerdan o'tadi (yangi yaratish mantig'i YOZILMAYDI, wgqxS0Cp #4).
   *
   * ⚠️ `opts` berilmasa xulq `create()` ning avvalgi tanasi bilan AYNAN bir
   * xil (baytma-bayt): filial va market odatdagidek aniqlanadi, `order.create`
   * payloadiga `request_id` QO'SHILMAYDI.
   *
   * `opts` faqat ai-confirm uchun:
   *  - `marketId` — partiya uchun BIR MARTA aniqlangan market; rolga qarab
   *    qayta qidirilmaydi;
   *  - `branchAssignment` — partiya uchun BIR MARTA aniqlangan filial
   *    (`null` ham qiymat: "filial yo'q"); `undefined` bo'lsa odatiy yo'l;
   *  - `requestId` — `'ai-dedupe:<sha256>'`: order-service uni 10 daqiqalik
   *    idempotentlik kaliti sifatida ishlatadi (takror yuborish — dublikat emas).
   */
  private async createOrderInternal(
    dto: CreateOrderRequestDto,
    req: { user: JwtUser },
    opts?: {
      requestId?: string;
      marketId?: string;
      branchAssignment?: BranchAssignment | null;
    },
  ): Promise<unknown> {
    const { customer, ...orderDto } = dto;
    let customerId = dto.customer_id;
    const roles = this.normalizeRoles(req.user.roles);
    const shouldResolveBranchAssignment =
      roles.includes(RoleEnum.BRANCH) ||
      roles.includes(RoleEnum.MANAGER) ||
      roles.includes(RoleEnum.REGISTRATOR);
    const branchAssignment =
      opts?.branchAssignment !== undefined
        ? opts.branchAssignment
        : shouldResolveBranchAssignment
          ? await this.resolveBranchAssignment(req.user)
          : null;
    const isBranchStaff = this.isBranchStaffAssignment(branchAssignment);
    const assignedBranchId = branchAssignment?.branch_id
      ? String(branchAssignment.branch_id)
      : null;

    if (isBranchStaff && !assignedBranchId) {
      throw new BadRequestException(
        'Filial xodimi hech qaysi filialga biriktirilmagan',
      );
    }

    if (
      isBranchStaff &&
      orderDto.branch_id &&
      String(orderDto.branch_id) !== assignedBranchId
    ) {
      throw new BadRequestException(
        'Filial xodimi boshqa filial uchun order yarata olmaydi',
      );
    }

    if (
      isBranchStaff &&
      typeof orderDto.source !== 'undefined' &&
      String(orderDto.source).toLowerCase() !== 'branch'
    ) {
      throw new BadRequestException(
        "Filial xodimi uchun source faqat 'branch' bo'lishi mumkin",
      );
    }

    let resolvedMarketId = orderDto.market_id;
    if (opts?.marketId) {
      // ai-confirm: market partiya boshida `resolveAiMarket` bilan aniqlangan.
      resolvedMarketId = opts.marketId;
    } else if (roles.includes(RoleEnum.MARKET)) {
      resolvedMarketId = req.user.sub;
    } else if (roles.includes(RoleEnum.MARKET_OPERATOR)) {
      // An operator (incl. the telegram bot) is linked to a market via
      // user.market_id — resolve it server-side. The bot DTO carries no
      // market_id, so without this the order.create insert hit a NOT-NULL
      // violation and orphaned the just-created customer. Resolving BEFORE the
      // customer is created also avoids the orphan on failure. (Audit I6.)
      const operatorProfile = await this.sendIdentityWithTimeout(
        { cmd: 'identity.user.find_by_id' },
        { id: req.user.sub },
      ).catch(() => null);
      const operatorData =
        (operatorProfile as { data?: { market_id?: string | null } })?.data ??
        null;
      resolvedMarketId =
        String(operatorData?.market_id ?? '').trim() || undefined;
      if (!resolvedMarketId) {
        throw new BadRequestException(
          "Operator hech qaysi marketga biriktirilmagan — buyurtma yaratib bo'lmaydi",
        );
      }
    } else if (
      (roles.includes(RoleEnum.ADMIN) ||
        roles.includes(RoleEnum.SUPERADMIN) ||
        roles.includes(RoleEnum.REGISTRATOR)) &&
      !resolvedMarketId
    ) {
      throw new BadRequestException('market_id is required');
    }

    if (!customerId) {
      if (!customer) {
        throw new BadRequestException(
          'customer_id yoki customer obyekt yuborilishi shart',
        );
      }

      const customerResponse = await firstValueFrom(
        this.identityClient
          .send({ cmd: 'identity.customer.create' }, { dto: customer })
          .pipe(timeout(8000)),
      ).catch((error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException(
            'Identity service response timeout',
          );
        }
        throw error;
      });

      const createdCustomer = customerResponse?.data ?? customerResponse;
      customerId = createdCustomer?.id;
      if (!customerId) {
        throw new BadRequestException('Customer yaratildi, lekin id qaytmadi');
      }
    }
    const finalCustomerId = customerId;

    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.create' },
          {
            dto: {
              ...orderDto,
              market_id: resolvedMarketId,
              customer_id: finalCustomerId,
              operator_id:
                roles.includes(RoleEnum.REGISTRATOR) ||
                roles.includes(RoleEnum.MARKET_OPERATOR)
                  ? req.user.sub
                  : null,
              branch_id: isBranchStaff
                ? assignedBranchId
                : (orderDto.branch_id ?? null),
              source: isBranchStaff ? 'branch' : orderDto.source,
            },
            requester: { id: req.user.sub, roles },
            ...(opts?.requestId ? { request_id: opts.requestId } : {}),
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('telegram/bot/create')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET_OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create order by telegram bot' })
  @ApiBody({ type: CreateOrderByTelegramBotRequestDto })
  async botOrderCreate(
    @Body() dto: CreateOrderByTelegramBotRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    const mappedDto: CreateOrderRequestDto = {
      customer: {
        name: dto.name,
        phone_number: dto.phone_number,
        district_id: dto.district_id,
        extra_number: dto.extra_number,
        address: dto.address,
      },
      where_deliver: dto.where_deliver ?? Where_deliver.CENTER,
      total_price: dto.total_price,
      status: Order_status.CREATED,
      comment: dto.comment ?? null,
      operator: dto.operator ?? null,
      items: dto.order_item_info,
    };

    return this.create(mappedDto, req);
  }

  /**
   * AI BUYURTMA — 1-QADAM: matn va/yoki rasmdan preview (NsxoDSmm).
   * HECH NARSA YARATMAYDI.
   *
   * Oqim: gateway → ai-service `ai.order.extract` (xom JSON) → order-service
   * `order.ai_resolve_preview` (tuman/mahsulot/tarif) → javob.
   *
   * Javob AI holatlarida DOIM HTTP 200 va bitta envelope:
   *  - `successRes({ ok: true, orders: AiPreviewOrder[], draft_id })`
   *  - `successRes({ ok: false, reason, message, scope?, reset_at? })`,
   *    reason ∈ disabled | refused | truncated | network | ai_error |
   *    no_market | cap_exceeded — har biriga frontend BOSHQA harakat
   *    ko'rsatadi (bVeyEuIR). ClaudeService'ning `invalid_json` i `ai_error`.
   * Faqat validatsiya xatolari 400: bo'sh kiritish, >4000 belgi, 4-rasm,
   * noto'g'ri tur/hajm/imzo, admin/menejerda market_id yo'q.
   *
   * ⚠️ MAXFIYLIK (HD5zOyBp): mijoz matni va rasmi Anthropic'ga faqat
   * ai-service orqali ketadi (telefonlar u yerda [TEL_n] bilan maskalanadi).
   * Bu yerda rasm buffer'dan TO'G'RIDAN base64'ga o'giriladi va faqat RAM'da
   * yashaydi: MinIO'ga (`file.upload`), diskka yoki DB'ga YOZILMAYDI —
   * `fileClient` bu endpointda umuman chaqirilmaydi. Matn, rasm va
   * buyurtmalar (telefon/manzil) HECH QACHON log qilinmaydi — faqat sabab.
   *
   * ⚠️ TIMEOUT: `ai.order.extract` — `timeout(AI_RPC_TIMEOUT_MS)` (60s), preview
   * — min(25s, 85s − o'tgan vaqt). QAYTA URINISH YO'Q: kechikkan so'rov
   * ai-service'da baribir bajariladi, har qayta urinish Anthropic'ni yana
   * chaqirib pul yechardi. RMQ_RPC_TTL_MS ga TEGILMAYDI.
   */
  @Post('ai-parse')
  @HttpCode(200)
  // Global per-IP limit (ClientIpThrottlerGuard) O'ZGARMAYDI; ustiga
  // foydalanuvchi (JWT sub) bo'yicha alohida 'ai-user' limiti. ⚠️
  // @Throttle({default}) ham, @SkipThrottle ham ATAYLAB YO'Q.
  @UseGuards(JwtAuthGuard, RolesGuard, UserThrottlerGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
    RoleEnum.MARKET,
    RoleEnum.MARKET_OPERATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'AI: matn/rasmdan buyurtma preview (hech narsa yaratmaydi)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          maxLength: AI_TEXT_MAX_CHARS,
          description: 'Buyurtma matni. Matn yoki kamida bitta rasm majburiy.',
        },
        market_id: {
          type: 'string',
          example: '12',
          description:
            'Faqat admin/superadmin/registrator/menejer uchun majburiy.',
        },
        images: {
          type: 'array',
          maxItems: AI_MAX_IMAGES,
          items: { type: 'string', format: 'binary' },
          description: 'JPEG yoki PNG, har biri 2 MB gacha, ko‘pi bilan 3 ta.',
        },
      },
    },
  })
  @UseInterceptors(
    FilesInterceptor('images', AI_MAX_IMAGES, {
      storage: createAiImageMemoryStorage(),
      limits: {
        files: AI_MAX_IMAGES,
        fileSize: AI_MULTER_FILE_SIZE_LIMIT,
        fields: 4,
        fieldSize: 64 * 1024,
      },
    }),
  )
  async aiParse(
    @Body() dto: AiParseRequestDto,
    @UploadedFiles() files: UploadedAiImage[] | undefined,
    @Req() req: { user: JwtUser },
  ): Promise<AiSuccessEnvelope<AiParseResponseData>> {
    if (!this.isAiOrderEnabled() || !this.aiClient) {
      return successRes(toParseFailure({ reason: 'disabled' }));
    }

    const text = typeof dto?.text === 'string' ? dto.text.trim() : '';
    const images = Array.isArray(files) ? files : [];
    this.assertAiParseInput(text, images);

    const market = await this.resolveAiMarket(req.user, dto?.market_id);
    if ('noMarket' in market) {
      return successRes(toParseFailure({ reason: 'no_market' }));
    }

    const draftId = randomUUID();
    const traceId = requestContext.getTraceId() ?? null;
    const requester = {
      id: this.asStr(req.user.sub),
      roles: this.normalizeRoles(req.user.roles),
    };
    const startedAt = Date.now();

    // MAXFIYLIK: rasm faqat base64 ko'rinishida RPC payloadiga tushadi.
    const extractRequest: AiOrderExtractRequest = {
      text,
      images: images.map((image) => ({
        media_type: this.asStr(image.mimetype).toLowerCase() as
          | 'image/jpeg'
          | 'image/png',
        data_base64: image.buffer.toString('base64'),
      })),
      market_id: market.marketId,
      requester,
      trace_id: traceId,
      draft_id: draftId,
      deadline_at: startedAt + AI_RPC_TIMEOUT_MS - 2_000,
    };

    let extracted: AiOrderExtractResponse | null;
    try {
      extracted = await firstValueFrom(
        this.aiClient
          .send<AiOrderExtractResponse>(
            { cmd: 'ai.order.extract' },
            extractRequest,
          )
          .pipe(timeout(AI_RPC_TIMEOUT_MS)),
      );
    } catch (error: unknown) {
      return successRes(
        toParseFailure({
          reason: this.aiRpcFailureReason(error, 'ai.order.extract'),
        }),
      );
    }

    if (!extracted || typeof extracted !== 'object') {
      return successRes(toParseFailure({ reason: 'ai_error' }));
    }
    if (extracted.ok !== true) {
      return successRes(toParseFailure(extracted));
    }
    if (!Array.isArray(extracted.orders)) {
      return successRes(toParseFailure({ reason: 'ai_error' }));
    }
    if (!extracted.orders.length) {
      return successRes({ ok: true, orders: [], draft_id: draftId });
    }

    const previewTimeoutMs = Math.min(
      AI_RESOLVE_TIMEOUT_MS,
      AI_PARSE_TOTAL_BUDGET_MS - (Date.now() - startedAt),
    );
    if (previewTimeoutMs < AI_MIN_PREVIEW_BUDGET_MS) {
      return successRes(toParseFailure({ reason: 'network' }));
    }

    let previews: unknown[] | null;
    try {
      const previewResponse: unknown = await firstValueFrom(
        this.orderClient
          .send(
            { cmd: 'order.ai_resolve_preview' },
            {
              raw_orders: extracted.orders,
              market_id: market.marketId,
              requester,
              request_id: randomUUID(),
              trace_id: traceId,
              draft_id: draftId,
              deadline_at: Date.now() + previewTimeoutMs - 1_000,
            },
          )
          .pipe(timeout(previewTimeoutMs)),
      );
      previews = this.extractAiPreviews(previewResponse);
    } catch (error: unknown) {
      return successRes(
        toParseFailure({
          reason: this.aiRpcFailureReason(error, 'order.ai_resolve_preview'),
        }),
      );
    }
    if (!previews) {
      return successRes(toParseFailure({ reason: 'ai_error' }));
    }

    return successRes({ ok: true, orders: previews, draft_id: draftId });
  }

  /**
   * AI tabini ko'rsatish kerakmi (HD5zOyBp #9). `enabled` — AI_ORDER_ENABLED
   * o'chirgichi; `state` — AiStatusPoller keshidan (RMQ KUTILMAYDI):
   * enabled | disabled | cap_exceeded | unknown.
   *
   * ⚠️ `@Get(':id')` dan OLDIN e'lon qilingan — aks holda 'ai-availability'
   * buyurtma ID'si deb ushlanadi.
   */
  @Get('ai-availability')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
    RoleEnum.MARKET,
    RoleEnum.MARKET_OPERATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'AI buyurtma mavjudligi: {enabled, state}' })
  aiAvailability(): AiSuccessEnvelope<{
    enabled: boolean;
    state: AiHealthState;
  }> {
    return successRes({
      enabled: this.isAiOrderEnabled(),
      state: this.aiStatus?.getState() ?? 'unknown',
    });
  }

  /**
   * AI BUYURTMA — 2-QADAM: operator tasdiqlagan buyurtmalarni yaratish
   * (wgqxS0Cp). Bu endpoint AI xatosining bazaga kirishiga OXIRGI to'siq.
   *
   * ⚠️ AI_ORDER_ENABLED ga BOG'LANMAGAN — AI o'chiq bo'lsa ham qo'lda
   * tahrirlangan buyurtmalarni qabul qilish to'xtamasligi kerak.
   *
   * Tartib:
   *  1) Partiya darajasi (HECH NARSA yaratilishidan OLDIN, xato → 4xx):
   *     market (`resolveAiMarket`) va filial BIR MARTA aniqlanadi.
   *  2) Server tomonda qayta tekshiruv: tumanlar va mahsulotlar partiyaga
   *     BITTADAN RPC bilan o'qiladi; region_id DB'dagi tumandan, mahsulot
   *     tanlangan marketniki bo'lishi shart. Istalgan RPC ishlamasa — hamma
   *     buyurtma `validation_unavailable` (tekshiruvsiz yaratish YO'Q).
   *  3) Dublikat: partiya ichida imzo bo'yicha (`duplicate_in_batch`),
   *     so'rovlar orasida `request_id='ai-dedupe:<sha256>'` — order-service
   *     10 daqiqa ichidagi takrorni yaratmaydi (`duplicate_recent`).
   *  4) Yaratish: 3 ta yo'lak (bir telefon — bitta yo'lak, ketma-ket),
   *     75s muddat; har buyurtma o'z try/catch'i bilan — biri yiqilsa
   *     qolganlari yaratiladi.
   * Javob: `successRes({results})` — har kiruvchi buyurtmaga AYNAN bitta
   * natija, `index` bo'yicha tartiblangan.
   */
  @Post('ai-confirm')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
    RoleEnum.MARKET,
    RoleEnum.MARKET_OPERATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'AI: tasdiqlangan buyurtmalarni yaratish (har buyurtmaga alohida natija)',
  })
  @ApiBody({ type: AiConfirmRequestDto })
  async aiConfirm(
    @Body() dto: AiConfirmRequestDto,
    @Req() req: { user: JwtUser },
  ): Promise<AiSuccessEnvelope<{ results: AiConfirmResult[] }>> {
    const startedAt = Date.now();
    const orders: AiConfirmOrderDto[] = Array.isArray(dto?.orders)
      ? dto.orders
      : [];

    // 1) Partiya darajasi — market va filial BIR MARTA.
    const market = await this.resolveAiMarket(req.user, dto?.market_id);
    if ('noMarket' in market) {
      throw new BadRequestException(
        'Operator hech qaysi marketga biriktirilmagan',
      );
    }
    const { marketId } = market;
    const roles = this.normalizeRoles(req.user.roles);
    const branchAssignment =
      roles.includes(RoleEnum.BRANCH) ||
      roles.includes(RoleEnum.MANAGER) ||
      roles.includes(RoleEnum.REGISTRATOR)
        ? await this.resolveBranchAssignment(req.user)
        : null;
    if (
      this.isBranchStaffAssignment(branchAssignment) &&
      !this.asStr(branchAssignment?.branch_id).trim()
    ) {
      throw new BadRequestException(
        'Filial xodimi hech qaysi filialga biriktirilmagan',
      );
    }

    const results = new Map<number, AiConfirmResult>();

    // 2) Server tomonda qayta tekshiruv (mijozga ishonilmaydi).
    const lookups = await this.loadAiConfirmLookups(orders);
    if (!lookups) {
      return successRes({
        results: orders.map(
          (_order, index): AiConfirmResult => ({
            index,
            ok: false,
            code: 'validation_unavailable',
            reason: AI_CONFIRM_REASON_TEXT.validation_unavailable,
          }),
        ),
      });
    }
    const verdicts = verifyAiOrders(orders, {
      marketId,
      districts: lookups.districts,
      products: lookups.products,
    });

    // 3) Partiya ichidagi dublikat — bir xil imzoli ikkinchi buyurtma.
    const seenSignatures = new Set<string>();
    const eligible: EligibleAiOrder[] = [];
    orders.forEach((order, index) => {
      const verdict = verdicts[index];
      if (!verdict) {
        results.set(index, {
          index,
          ok: false,
          code: 'validation_unavailable',
          reason: AI_CONFIRM_REASON_TEXT.validation_unavailable,
        });
        return;
      }
      if (!verdict.ok) {
        results.set(index, {
          index,
          ok: false,
          code: verdict.code,
          reason: verdict.reason,
        });
        return;
      }
      const signature = aiOrderSignature(marketId, order);
      if (seenSignatures.has(signature)) {
        results.set(index, {
          index,
          ok: false,
          code: 'duplicate_in_batch',
          reason: AI_CONFIRM_REASON_TEXT.duplicate_in_batch,
        });
        return;
      }
      seenSignatures.add(signature);
      eligible.push({
        index,
        order,
        signature,
        districtId: this.asStr(verdict.district_id),
        regionId: this.asStr(verdict.region_id),
      });
    });

    // 4) Yaratish — cheklangan parallellik, telefon bo'yicha yo'laklar.
    const ctx = {
      marketId,
      includeMarketId: !roles.includes(RoleEnum.MARKET),
      branchAssignment,
    };
    const outcomes = await runInLanes(
      eligible,
      (item: EligibleAiOrder) => item.order.customer.phone_number,
      AI_CONFIRM_CONCURRENCY,
      startedAt + AI_CONFIRM_DEADLINE_MS,
      (item: EligibleAiOrder) => this.createAiOrder(item, req, ctx),
    );
    outcomes.forEach((outcome, position) => {
      const { index } = eligible[position];
      if (outcome.status === 'done') {
        results.set(index, outcome.value);
      } else if (outcome.status === 'error') {
        results.set(index, {
          index,
          ok: false,
          ...toConfirmFailure(outcome.error),
        });
      } else {
        results.set(index, {
          index,
          ok: false,
          code: 'not_started',
          reason: AI_CONFIRM_REASON_TEXT.not_started,
        });
      }
    });

    this.linkAiUsageOrders(orders, results, marketId);

    return successRes({
      results: orders.map(
        (_order, index): AiConfirmResult =>
          results.get(index) ?? {
            index,
            ok: false,
            code: 'create_failed',
            reason: AI_CONFIRM_REASON_TEXT.create_failed,
          },
      ),
    });
  }

  /**
   * Buyurtmalarni qabul qilish.
   *
   * MANAGER 2026-09-10 da qo'shildi: hamkordan (BeePost) kelgan posilkalar
   * HQ da qabul qilinadi va buni HQ menejeri bajaradi.
   *
   * ⚠️ Rol o'zi yetarli EMAS — menejer va registrator faqat O'Z filialidagi
   * buyurtmani qabul qila oladi. Chegara order-service ichida qo'yiladi
   * (`resolveReceiveBranchScope`), shu bois bu yerda `requester` uzatiladi.
   * Filialsiz foydalanuvchi hech nima qabul qila olmaydi (fail-closed).
   */
  @Post('receive')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive new orders (branch-scoped for staff)' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiBody({ type: OrdersArrayDto })
  receiveNewOrders(
    @Body() dto: OrdersArrayDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
    @Query('search') search?: string,
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.receive' },
          {
            order_ids: dto.order_ids,
            search,
            requester: {
              id: req.user?.sub,
              roles: req.user?.roles ?? [],
            },
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  /**
   * TASHQI POSILKANI SKANERLAB QABUL QILISH (audit K2).
   *
   * Operator yorliqdagi QR'ni skanerlaydi, server tokenni buyurtmaga
   * MOSLAYDI. Ilgari frontend tokenni o'zi moslab serverga `order_ids`
   * yuborardi — ya'ni server skanerlash bo'lgan-bo'lmaganini bilmasdi va
   * darvozani boshqa ekrandan yoki to'g'ridan-to'g'ri API'dan chetlab
   * o'tish mumkin edi.
   *
   * ⚠️ ROLLAR `/orders/receive` BILAN BIR XIL (MANAGER bor, MARKET yo'q) —
   * market posilka qabul qilmaydi.
   */
  @Post('external/receive-by-scan')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Receive external parcels by scanned label tokens',
  })
  @ApiBody({ type: ReceiveByScanDto })
  receiveExternalByScan(
    @Body() dto: ReceiveByScanDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.receive_by_scan' },
          {
            tokens: dto.tokens,
            requester: { id: req.user?.sub, roles: req.user?.roles ?? [] },
          },
        )
        .pipe(timeout(15000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('external/receive')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive orders from external integration payload' })
  @ApiBody({ type: ReceiveExternalOrdersDto })
  receiveExternalOrders(@Body() dto: ReceiveExternalOrdersDto) {
    return firstValueFrom(
      this.orderClient
        .send({ cmd: 'order.receive_external' }, dto)
        .pipe(timeout(15000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  /**
   * KIRUVCHI POSILKALARNING MANBALARI.
   *
   * "Kiruvchi posilkalar" ekrani ilgari BARCHA tashqi buyurtmani bitta
   * ro'yxatda ko'rsatardi. Ikkinchi manba qo'shilishi bilan operator qo'lida
   * bir manbaning qopi turib, ro'yxatda boshqasining posilkasini ham
   * ko'rardi. Endi avval manba tanlanadi.
   *
   * ⚠️ ROLLAR `/orders/receive` BILAN BIR XIL (MANAGER bor, MARKET yo'q).
   * `/orders/external` da MARKET ham bor, lekin market posilka QABUL
   * QILMAYDI — unga manba tanlagichini ko'rsatish hech qayerga olib
   * bormaydigan ekran bo'lardi.
   *
   * ⚠️ FILIAL DOIRASI `markets/new` BILAN AYNI. Buni tushirib qoldirib
   * bo'lmaydi: `order.receive` ichida `resolveReceiveBranchScope` begona
   * filial buyurtmasi bo'lsa BUTUN so'rovni rad etadi. Ya'ni doirasiz
   * sanalgan son menejerga "12 posilka bor" deb ko'rsatib, qabul qilishda
   * to'liq xato berardi — va sabab ekranda ko'rinmasdi.
   */
  @Get('external/sources')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Incoming parcel sources (grouped external NEW orders)',
  })
  async findExternalSources(@Req() req?: { user: JwtUser }) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    const isBranchScopedRequester =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);

    let resolvedBranchId: string | undefined;
    if (isBranchScopedRequester && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      resolvedBranchId = String(assignment.branch_id);
    }

    const result = await firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.find_external_sources' },
          { branch_id: resolvedBranchId },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });

    // Order service nomni o'zi qo'shadi; qo'shmagan bo'lsa (eski versiya)
    // gateway to'ldiradi — ekran nomsiz qolmasin.
    if (!Array.isArray(result)) {
      return result;
    }
    return this.enrichMarketRows(result);
  }

  /**
   * ⚠️ MANAGER 2026-09-13 da QO'SHILDI (audit K1).
   *
   * `external/sources` MANAGER'ga ruxsat berardi, bu ro'yxat esa BERMASDI:
   * menejer manba kartasini ko'rib, ustiga bosib 403 olardi — ekran esa
   * xatoni ko'rsatmaydigan shox tanlab "posilka yo'q" deb yozardi. Ya'ni
   * HQ menejeri uchun butun oqim ishlamasdi, sababi ham ko'rinmasdi.
   */
  @Get('external')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List external orders with filters' })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: Order_status,
    isArray: true,
  })
  @ApiQuery({
    name: 'date',
    required: false,
    type: String,
    description: 'Single day filter (YYYY-MM-DD)',
  })
  @ApiQuery({ name: 'start_day', required: false, type: String })
  @ApiQuery({ name: 'end_day', required: false, type: String })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    schema: { default: 1, minimum: 1 } as any,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    enum: [10, 25, 50, 100],
    schema: { default: 10 } as any,
  })
  @ApiQuery({ name: 'fetch_all', required: false, type: Boolean })
  async findAllExternal(
    @Query('market_id') market_id?: string,
    @Query('status') status?: string | string[],
    @Query('date') date?: string,
    @Query('start_day') start_day?: string,
    @Query('end_day') end_day?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('fetch_all') fetch_all?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const roles = req?.user?.roles ?? [];
    const isMarket = roles.includes(RoleEnum.MARKET);
    const requesterId = req?.user?.sub;

    if (
      isMarket &&
      market_id &&
      requesterId &&
      String(market_id) !== String(requesterId)
    ) {
      throw new BadRequestException('market role cannot query other market_id');
    }

    const resolvedMarketId = isMarket && requesterId ? requesterId : market_id;
    const resolvedStartDay = start_day ?? date;
    const resolvedEndDay = end_day ?? date;

    const pagination = this.parsePaginationQuery(page, limit);

    const statuses = this.parseStatusQuery(status);

    /**
     * ⚠️ FILIAL DOIRASI (audit K8).
     *
     * Manba KARTALARI (`external/sources`) filial bo'yicha sanaladi, bu
     * ro'yxat esa cheklanmagan edi: menejer 12 posilka ko'rsatilgan kartani
     * ochib, ichida BEGONA filial posilkalarini ham ko'rardi. Ularni
     * skanerlab qabul qilmoqchi bo'lsa `receiveNewOrders` BUTUN so'rovni rad
     * etadi (`resolveReceiveBranchScope`) — ya'ni bitta begona posilka
     * butun sessiyani buzardi va sabab ekranda ko'rinmasdi.
     *
     * Doira `markets/new` va `external/sources` bilan AYNI qoidada.
     */
    const normalizedRoles = this.normalizeRoles(roles);
    const isBranchScoped =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);

    let resolvedBranchId: string | undefined;
    if (isBranchScoped && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      resolvedBranchId = String(assignment.branch_id);
    }

    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.external.find_all' },
          {
            query: {
              market_id: resolvedMarketId,
              branch_id: resolvedBranchId,
              status: statuses,
              start_day: resolvedStartDay,
              end_day: resolvedEndDay,
              fetch_all:
                String(fetch_all ?? '').toLowerCase() === 'true' || undefined,
              page: pagination.page,
              limit: pagination.limit,
            },
          },
        )
        .pipe(timeout(8000)),
    )
      .catch((error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException('Order service response timeout');
        }
        throw error;
      })
      .then((response) => this.withPaginationMeta(response, pagination));
  }

  @Post('external')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create external order' })
  @ApiBody({ type: CreateExternalOrderRequestDto })
  async createExternal(
    @Body() dto: CreateExternalOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    const { customer, external_id, ...orderDto } = dto;
    let customerId = dto.customer_id;
    const roles = this.normalizeRoles(req.user.roles);

    let resolvedMarketId = orderDto.market_id;
    if (roles.includes(RoleEnum.MARKET)) {
      resolvedMarketId = req.user.sub;
    } else if (
      (roles.includes(RoleEnum.ADMIN) ||
        roles.includes(RoleEnum.SUPERADMIN) ||
        roles.includes(RoleEnum.REGISTRATOR)) &&
      !resolvedMarketId
    ) {
      throw new BadRequestException('market_id is required');
    }

    if (!customerId) {
      if (!customer) {
        throw new BadRequestException(
          'customer_id yoki customer obyekt yuborilishi shart',
        );
      }

      const customerPayload = {
        ...customer,
        market_id: customer.market_id ?? resolvedMarketId,
      };

      const customerResponse = await firstValueFrom(
        this.identityClient
          .send({ cmd: 'identity.customer.create' }, { dto: customerPayload })
          .pipe(timeout(8000)),
      ).catch((error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException(
            'Identity service response timeout',
          );
        }
        throw error;
      });

      const createdCustomer = customerResponse?.data ?? customerResponse;
      customerId = createdCustomer?.id;
      if (!customerId) {
        throw new BadRequestException('Customer yaratildi, lekin id qaytmadi');
      }
    }

    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.external.create' },
          {
            dto: {
              ...orderDto,
              external_id: external_id ?? null,
              market_id: resolvedMarketId,
              customer_id: customerId,
            },
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List orders with filters' })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({ name: 'customer_id', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: Order_status,
    isArray: true,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Customer name/phone search, or order number (order id, e.g. 1251175). ' +
      'Response has search_truncated=true when more than 1000 customers match.',
  })
  @ApiQuery({
    name: 'start_day',
    required: false,
    type: String,
    description: 'Start date (YYYY-MM-DD or ISO)',
  })
  @ApiQuery({
    name: 'end_day',
    required: false,
    type: String,
    description: 'End date (YYYY-MM-DD or ISO)',
  })
  @ApiQuery({
    name: 'courier',
    required: false,
    type: String,
    description: 'Courier (operator text or post_id)',
  })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({ name: 'district_id', required: false, type: String })
  @ApiQuery({ name: 'branch_id', required: false, type: String })
  @ApiQuery({ name: 'courier_id', required: false, type: String })
  @ApiQuery({
    name: 'where_deliver',
    required: false,
    enum: Where_deliver,
  })
  @ApiQuery({
    name: 'sort_by',
    required: false,
    enum: ['created_at', 'total_price', 'status'],
    description:
      'Server-side sort across all pages (default created_at desc). ' +
      'status sorts by lifecycle order, not alphabetically.',
  })
  @ApiQuery({
    name: 'sort_dir',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Default desc',
  })
  @ApiQuery({
    name: 'source',
    required: false,
    enum: ['internal', 'external', 'branch'],
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    schema: { default: 1, minimum: 1 } as any,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    enum: [10, 25, 50, 100],
    schema: { default: 10 } as any,
  })
  async findAll(
    @Query('market_id') market_id?: string,
    @Query('customer_id') customer_id?: string,
    @Query('status') status?: string | string[],
    @Query('search') search?: string,
    @Query('start_day') start_day?: string,
    @Query('end_day') end_day?: string,
    @Query('courier') courier?: string,
    @Query('region_id') region_id?: string,
    @Query('district_id') district_id?: string,
    @Query('branch_id') branch_id?: string,
    @Query('courier_ids') courier_ids?: string | string[],
    @Query('fetch_all') fetch_all?: string,
    @Query('source') source?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
    @Query('courier_id') courier_id?: string,
    @Query('where_deliver') where_deliver?: string,
    @Query('sort_by') sort_by?: string,
    @Query('sort_dir') sort_dir?: string,
  ) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    const isMarket = normalizedRoles.includes(RoleEnum.MARKET);
    const isCourier = normalizedRoles.includes(RoleEnum.COURIER);
    const isSystemPrivilegedRequester =
      normalizedRoles.includes(RoleEnum.ADMIN) ||
      normalizedRoles.includes(RoleEnum.SUPERADMIN);
    const isBranchScopedRequester =
      !isCourier &&
      (normalizedRoles.includes(RoleEnum.BRANCH) ||
        normalizedRoles.includes(RoleEnum.MANAGER) ||
        normalizedRoles.includes(RoleEnum.REGISTRATOR));
    const requesterId = req?.user?.sub;

    if (
      isMarket &&
      market_id &&
      requesterId &&
      String(market_id) !== String(requesterId)
    ) {
      throw new BadRequestException('market role cannot query other market_id');
    }

    const resolvedMarketId = isMarket && requesterId ? requesterId : market_id;
    let resolvedBranchId = branch_id;

    if (isBranchScopedRequester && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      resolvedBranchId = String(assignment.branch_id);
    }

    const pagination = this.parsePaginationQuery(page, limit);
    const normalizedCourierIds = (
      Array.isArray(courier_ids)
        ? courier_ids
        : courier_ids
          ? [courier_ids]
          : []
    )
      .concat(courier_id ? [courier_id] : [])
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim())
      .filter(Boolean);
    const useFetchAll = String(fetch_all ?? '').toLowerCase() === 'true';

    const statuses = this.parseStatusQuery(status);
    const normalizedWhereDeliver = where_deliver
      ? String(where_deliver).trim().toLowerCase()
      : undefined;
    if (
      normalizedWhereDeliver &&
      !Object.values(Where_deliver).includes(
        normalizedWhereDeliver as Where_deliver,
      )
    ) {
      throw new BadRequestException(
        `Noto'g'ri where_deliver qiymati: ${where_deliver}`,
      );
    }
    const isCancelledTab =
      Boolean(statuses?.length) &&
      statuses!.every(
        (value) =>
          value === Order_status.CANCELLED ||
          value === Order_status.CANCELLED_SENT,
      );
    const isBranchCancelledTab = isBranchScopedRequester && isCancelledTab;
    const isHqCancelledTab = isSystemPrivilegedRequester && isCancelledTab;
    const resolvedStatuses =
      (isCourier || isBranchCancelledTab || isHqCancelledTab) && isCancelledTab
        ? [Order_status.CANCELLED]
        : statuses;
    const resolvedCourierIds =
      isCourier && requesterId
        ? [String(requesterId)]
        : normalizedCourierIds.length
          ? normalizedCourierIds
          : undefined;

    if (isCourier && isCancelledTab) {
      const allCancelledRows = await this.findCourierCancelledRows(req?.user, {
        market_id: resolvedMarketId,
        customer_id,
        search,
        start_day,
        end_day,
        region_id,
        district_id,
        source,
      });
      const total = allCancelledRows.length;
      const offset = (pagination.page - 1) * pagination.limit;
      const data = allCancelledRows.slice(offset, offset + pagination.limit);
      const paginationMeta = this.buildPaginationMeta(
        total,
        pagination.page,
        pagination.limit,
      );

      return {
        data,
        total,
        page: pagination.page,
        limit: pagination.limit,
        ...paginationMeta,
      };
    }

    const payload = {
      query: {
        market_id: resolvedMarketId,
        customer_id,
        status: resolvedStatuses,
        where_deliver: normalizedWhereDeliver as Where_deliver | undefined,
        search,
        start_day,
        end_day,
        courier,
        courier_ids: resolvedCourierIds,
        fetch_all: useFetchAll || undefined,
        region_id,
        district_id,
        branch_id: resolvedBranchId,
        holder_type: isHqCancelledTab
          ? 'HQ'
          : isBranchCancelledTab
            ? 'BRANCH'
            : undefined,
        canceled_post_unassigned:
          isHqCancelledTab || isBranchCancelledTab ? true : undefined,
        source,
        sort_by,
        sort_dir,
        page: pagination.page,
        limit: pagination.limit,
      },
    };

    return this.sendOrderWithFallback(
      { cmd: 'order.find_all_enriched' },
      { cmd: 'order.find_all' },
      payload,
    ).then((response) => {
      return this.withPaginationMeta(response, pagination);
    });
  }

  @Get('market/:marketId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List orders by market ID with pagination' })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  @ApiQuery({ name: 'branch_id', required: false, type: String })
  @ApiQuery({
    name: 'courier_ids',
    required: false,
    type: String,
    isArray: true,
  })
  @ApiQuery({ name: 'fetch_all', required: false, type: Boolean })
  @ApiQuery({
    name: 'source',
    required: false,
    enum: ['internal', 'external', 'branch'],
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    schema: { default: 1, minimum: 1 } as any,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    enum: [10, 25, 50, 100],
    schema: { default: 10 } as any,
  })
  findAllByMarket(
    @Param('marketId') marketId: string,
    @Query('branch_id') branch_id?: string,
    @Query('source') source?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    // A market role may only list its OWN orders — block cross-market reads.
    const roles = this.normalizeRoles(req?.user?.roles);
    if (
      roles.includes(RoleEnum.MARKET) &&
      String(req?.user?.sub ?? '') !== String(marketId)
    ) {
      throw new ForbiddenException('market role cannot query other market_id');
    }
    const pagination = this.parsePaginationQuery(page, limit);

    return this.sendOrderWithFallback(
      { cmd: 'order.find_all_enriched' },
      { cmd: 'order.find_all' },
      {
        query: {
          market_id: marketId,
          branch_id,
          source,
          page: pagination.page,
          limit: pagination.limit,
        },
      },
    ).then((response) => this.withPaginationMeta(response, pagination));
  }

  @Get('courier/orders')
  @Get('courier-orders')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Legacy courier orders list endpoint' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: Order_status,
    isArray: true,
  })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'Legacy start date (YYYY-MM-DD or ISO)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description: 'Legacy end date (YYYY-MM-DD or ISO)',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    schema: { default: 1, minimum: 1 } as any,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    enum: [10, 25, 50, 100],
    schema: { default: 10 } as any,
  })
  async findCourierOrdersLegacy(
    @Query('status') status?: string | string[],
    @Query('search') search?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const pagination = this.parsePaginationQuery(page, limit);
    const statuses = this.parseStatusQuery(status);
    const normalizedRoles = this.normalizeRoles(req?.user?.roles);
    const isBranchScopedRequester =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);
    const cancelledTabStatuses = [
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
    ];
    const isCancelledTab =
      Boolean(statuses?.length) &&
      statuses!.every((value) => cancelledTabStatuses.includes(value));
    if (isCancelledTab) {
      const allCancelledRows = await this.findCourierCancelledRows(req?.user, {
        search,
        start_day: startDate,
        end_day: endDate,
      });
      const total = allCancelledRows.length;
      const offset = (pagination.page - 1) * pagination.limit;
      const pageRows = allCancelledRows.slice(
        offset,
        offset + pagination.limit,
      );
      const legacyData = this.toLegacyShape(pageRows).map((row) =>
        this.normalizeLegacyOrderRow(row),
      );
      const paginationMeta = this.buildPaginationMeta(
        total,
        pagination.page,
        pagination.limit,
      );

      return successRes(
        {
          data: legacyData,
          total,
          page: pagination.page,
          limit: pagination.limit,
          ...paginationMeta,
        },
        200,
        'All my orders',
      );
    }

    if (isBranchScopedRequester && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }

      const payload = {
        query: {
          branch_id: String(assignment.branch_id),
          status: statuses,
          exclude_statuses: statuses?.length
            ? undefined
            : [
                Order_status.CREATED,
                Order_status.NEW,
                Order_status.RECEIVED,
                Order_status.ON_THE_ROAD,
              ],
          search,
          start_day: startDate,
          end_day: endDate,
          page: pagination.page,
          limit: pagination.limit,
        },
      };
      const result = await this.sendOrderWithFallback(
        { cmd: 'order.find_all_enriched' },
        { cmd: 'order.find_all' },
        payload,
      );
      const rows = this.extractRows(result?.data ?? result);
      const total = Number(result?.total ?? rows.length);
      const currentPage = Number(result?.page ?? pagination.page);
      const currentLimit = Number(result?.limit ?? pagination.limit);
      const legacyData = this.toLegacyShape(rows).map((row) =>
        this.normalizeLegacyOrderRow(row),
      );
      const paginationMeta = this.buildPaginationMeta(
        total,
        currentPage,
        currentLimit,
      );

      return successRes(
        {
          data: legacyData,
          total,
          page: currentPage,
          limit: currentLimit,
          ...paginationMeta,
        },
        200,
        'All my orders',
      );
    }

    const courierPostIds = await this.findAllCourierPostIds(req?.user);
    if (!courierPostIds.length) {
      return successRes(
        {
          data: [],
          total: 0,
          page: pagination.page,
          limit: pagination.limit,
          total_pages: 0,
          totalPages: 0,
        },
        200,
        'All my orders',
      );
    }

    let currentPage = pagination.page;
    let currentLimit = pagination.limit;

    const payload = {
      query: {
        post_ids: courierPostIds,
        status: statuses,
        exclude_statuses: statuses?.length
          ? undefined
          : [
              Order_status.CREATED,
              Order_status.NEW,
              Order_status.RECEIVED,
              Order_status.ON_THE_ROAD,
            ],
        search,
        start_day: startDate,
        end_day: endDate,
        page: pagination.page,
        limit: pagination.limit,
      },
    };

    const result = await this.sendOrderWithFallback(
      { cmd: 'order.find_all_enriched' },
      { cmd: 'order.find_all' },
      payload,
    );
    const resultRows = this.extractRows(result?.data ?? result);
    const filteredRows = resultRows.filter((row) =>
      courierPostIds.includes(this.asStr(row?.post_id ?? row?.postId)),
    );
    const total = Number(result?.total ?? filteredRows.length);
    currentPage = Number(result?.page ?? pagination.page);
    currentLimit = Number(result?.limit ?? pagination.limit);

    const legacyData = this.toLegacyShape(filteredRows).map((row) =>
      this.normalizeLegacyOrderRow(row),
    );
    const paginationMeta = this.buildPaginationMeta(
      total,
      currentPage,
      currentLimit,
    );

    return successRes(
      {
        data: legacyData,
        total,
        page: currentPage,
        limit: currentLimit,
        ...paginationMeta,
      },
      200,
      'All my orders',
    );
  }

  @Get('markets/new')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Markets with NEW orders' })
  async findNewMarkets(@Req() req?: { user: JwtUser }) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    const isBranchScopedRequester =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);

    let resolvedBranchId: string | undefined;
    let excludeBranchSource = false;

    if (isBranchScopedRequester && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      resolvedBranchId = String(assignment.branch_id);
    } else {
      excludeBranchSource = true;
    }

    const result = await this.sendOrderWithFallback(
      { cmd: 'order.find_new_markets_enriched' },
      { cmd: 'order.find_new_markets' },
      {
        branch_id: resolvedBranchId,
        exclude_branch_source: excludeBranchSource,
      },
    );

    if (!Array.isArray(result)) {
      return result;
    }

    return this.enrichMarketRows(result);
  }

  @Get('markets/cancelled')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Markets with CANCELLED orders' })
  async findCancelledMarkets(@Req() req?: { user: JwtUser }) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    const isMarket = normalizedRoles.includes(RoleEnum.MARKET);
    const isBranchScopedRequester =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);

    let branchId: string | undefined;
    let holderType: 'HQ' | 'BRANCH' | undefined = 'HQ';
    let excludeBranchSource = false;
    let marketId: string | undefined;

    if (isMarket) {
      if (!req?.user?.sub) {
        throw new BadRequestException('Market aniqlanmadi');
      }
      marketId = String(req.user.sub);
      holderType = undefined;
      excludeBranchSource = false;
    } else if (isBranchScopedRequester && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      branchId = String(assignment.branch_id);
      holderType = 'BRANCH';
      excludeBranchSource = false;
    }

    return this.sendOrderWithTimeout(
      { cmd: 'order.find_cancelled_markets_enriched' },
      {
        market_id: marketId,
        branch_id: branchId,
        holder_type: holderType,
        exclude_branch_source: excludeBranchSource,
      },
    );
  }

  @Get('branch/orders')
  @Get('branch/cancelled')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Branch tomonidan qabul qilingan va hali HQga yuborilmagan canceled orderlar',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [Order_status.CANCELLED],
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    schema: { default: 1, minimum: 1 } as any,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    enum: [10, 25, 50, 100],
    schema: { default: 10 } as any,
  })
  async findBranchCancelledOrders(
    @Query('status') status?: string | string[],
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user: JwtUser },
  ) {
    if (!req?.user) {
      throw new BadRequestException('Foydalanuvchi aniqlanmadi');
    }

    const assignment = await this.resolveBranchAssignment(req.user);
    if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
      throw new BadRequestException('Branch user branchga biriktirilmagan');
    }

    const pagination = this.parsePaginationQuery(page, limit);
    const statuses = this.parseStatusQuery(status);
    if (
      statuses?.length &&
      !statuses.every((value) => value === Order_status.CANCELLED)
    ) {
      throw new BadRequestException(
        'Branch canceled orders endpoint faqat cancelled status uchun',
      );
    }
    const payload = {
      query: {
        branch_id: String(assignment.branch_id),
        status: [Order_status.CANCELLED],
        holder_type: 'BRANCH',
        canceled_post_unassigned: true,
        page: pagination.page,
        limit: pagination.limit,
      },
    };

    return this.sendOrderWithFallback(
      { cmd: 'order.find_all_enriched' },
      { cmd: 'order.find_all' },
      payload,
    ).then((response) =>
      this.toManagerCancelledTabResponse(
        this.withPaginationMeta(response, pagination),
      ),
    );
  }

  @Get('markets/:marketId/new')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'NEW orders by market id' })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  async findNewOrdersByMarket(
    @Param('marketId') marketId: string,
    @Req() req?: { user: JwtUser },
  ) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    if (
      normalizedRoles.includes(RoleEnum.MARKET) &&
      String(req?.user?.sub ?? '') !== String(marketId)
    ) {
      throw new ForbiddenException('market role cannot query other market_id');
    }
    const isBranchScopedRequester =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);

    let resolvedBranchId: string | undefined;
    let excludeBranchSource = false;

    if (isBranchScopedRequester && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      resolvedBranchId = String(assignment.branch_id);
    } else {
      excludeBranchSource = true;
    }

    const payload = {
      market_id: marketId,
      branch_id: resolvedBranchId,
      exclude_branch_source: excludeBranchSource,
    };

    return this.sendOrderWithFallback(
      { cmd: 'order.find_new_by_market_enriched' },
      { cmd: 'order.find_new_by_market' },
      payload,
    );
  }

  @Get('markets/:marketId/cancelled')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'CANCELLED orders by market id' })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  async findCancelledOrdersByMarket(
    @Param('marketId') marketId: string,
    @Req() req?: { user: JwtUser },
  ) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    const isMarket = normalizedRoles.includes(RoleEnum.MARKET);
    const isBranchScopedRequester =
      normalizedRoles.includes(RoleEnum.BRANCH) ||
      normalizedRoles.includes(RoleEnum.MANAGER) ||
      normalizedRoles.includes(RoleEnum.REGISTRATOR);

    let branchId: string | undefined;
    let holderType: 'HQ' | 'BRANCH' | undefined = 'HQ';
    let excludeBranchSource = false;

    if (isMarket) {
      if (!req?.user?.sub || String(req.user.sub) !== String(marketId)) {
        throw new ForbiddenException(
          'Market faqat o‘zining canceled orderlarini ko‘ra oladi',
        );
      }
      excludeBranchSource = false;
    } else if (isBranchScopedRequester && req?.user) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      branchId = String(assignment.branch_id);
      holderType = 'BRANCH';
      excludeBranchSource = false;
    }

    return this.sendOrderWithTimeout(
      { cmd: 'order.find_cancelled_by_market_enriched' },
      {
        market_id: marketId,
        branch_id: branchId,
        holder_type: holderType,
        exclude_branch_source: excludeBranchSource,
      },
    );
  }

  @Post('markets/:marketId/cancelled/qr')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Market canceled order handover uchun 2 daqiqalik QR olish',
  })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  async createCancelledMarketHandoverQr(
    @Param('marketId') marketId: string,
    @Req() req: { user: JwtUser },
  ) {
    if (String(req.user.sub) !== String(marketId)) {
      throw new ForbiddenException('Market faqat o‘zi uchun QR yarata oladi');
    }

    return this.sendOrderWithTimeout(
      { cmd: 'order.market_cancelled_handover.create_qr' },
      {
        market_id: marketId,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
  }

  @Post('markets/:marketId/cancelled/handover')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Selected CANCELLED orderlarni QR ruxsati bilan marketga topshirish',
  })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  @ApiBody({ type: HandoverCancelledOrdersToMarketRequestDto })
  handoverCancelledOrdersToMarket(
    @Param('marketId') marketId: string,
    @Body() dto: HandoverCancelledOrdersToMarketRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendOrderWithTimeout(
      { cmd: 'order.market_cancelled_handover.complete' },
      {
        market_id: marketId,
        order_ids: dto.order_ids,
        authorization_token: dto.authorization_token,
        manual_overrides: dto.manual_overrides,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order by ID' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  async findById(@Param('id') id: string, @Req() req?: { user: JwtUser }) {
    const response = await this.sendOrderWithFallback(
      { cmd: 'order.find_by_id_enriched' },
      { cmd: 'order.find_by_id' },
      { id },
    );
    await this.assertCanViewOrder(req?.user, response?.data);
    return response;
  }

  @Get('qr-code/:token')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.COURIER,
    RoleEnum.MARKET,
    RoleEnum.REGISTRATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order by QR code (Post Control style)' })
  @ApiParam({ name: 'token', description: 'Order QR token' })
  findByQrCode(@Param('token') token: string) {
    return this.sendOrderWithFallback(
      { cmd: 'order.find_by_qr_enriched' },
      { cmd: 'order.find_by_qr' },
      { token },
    );
  }

  @Post('scan-assign')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Scan QR and assign order to current courier' })
  @ApiBody({ type: ScanAssignOrderRequestDto })
  scanAssignOrder(
    @Body() dto: ScanAssignOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendLogisticsWithTimeout(
      { cmd: 'logistics.order.scan_assign' },
      {
        dto,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
  }

  @Post('assign-to-courier')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Manager bulk-assign orders to one courier' })
  @ApiBody({ type: AssignOrdersToCourierRequestDto })
  assignOrdersToCourier(
    @Body() dto: AssignOrdersToCourierRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendLogisticsWithTimeout(
      { cmd: 'logistics.order.assign_to_courier' },
      {
        dto,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
  }

  @Get('extra-cost-approvals')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET, RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List extra cost approval requests' })
  @ApiQuery({
    name: 'status',
    required: false,
    example: 'pending',
    enum: ['pending', 'approved', 'rejected'],
  })
  listExtraCostApprovals(
    @Query('status') status: string | undefined,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendOrderWithTimeout(
      { cmd: 'order.extra_cost_approval.list' },
      {
        status,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
  }

  @Post('extra-cost-approvals/:id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET, RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve extra cost request' })
  @ApiParam({ name: 'id', description: 'Extra cost approval ID' })
  @ApiBody({ type: ExtraCostApprovalDecisionDto, required: false })
  approveExtraCostApproval(
    @Param('id') id: string,
    @Body() dto: ExtraCostApprovalDecisionDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendOrderWithTimeout(
      { cmd: 'order.extra_cost_approval.approve' },
      {
        id,
        dto,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
  }

  @Post('extra-cost-approvals/:id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET, RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reject extra cost request' })
  @ApiParam({ name: 'id', description: 'Extra cost approval ID' })
  @ApiBody({ type: ExtraCostApprovalDecisionDto, required: false })
  rejectExtraCostApproval(
    @Param('id') id: string,
    @Body() dto: ExtraCostApprovalDecisionDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendOrderWithTimeout(
      { cmd: 'order.extra_cost_approval.reject' },
      {
        id,
        dto,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
  }

  @Get(':id/tracking')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.COURIER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order tracking history by ID' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  async getTracking(
    @Param('id') id: string,
    @Query('page') pageRaw?: string,
    @Query('limit') limitRaw?: string,
    @Req() req?: { user: JwtUser },
  ) {
    const page = Math.max(1, Number(pageRaw) || 1);
    const limit = Math.min(100, Math.max(1, Number(limitRaw) || 20));

    // Authorize against the order itself before exposing its movement history.
    const order = await this.sendOrderWithFallback(
      { cmd: 'order.find_by_id_enriched' },
      { cmd: 'order.find_by_id' },
      { id },
    );
    await this.assertCanViewOrderTracking(req?.user, order?.data);
    return firstValueFrom(
      this.orderClient
        .send({ cmd: 'order.tracking' }, { id, page, limit })
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('sell/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sell order (courier)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({ type: SellOrderRequestDto })
  @UseInterceptors(
    FileInterceptor('proof', {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async sellOrder(
    @Param('id') id: string,
    @Body() dto: SellOrderRequestDto,
    @UploadedFile() proof: UploadedProofFile | undefined,
    @Req() req: { user: JwtUser },
  ) {
    const dtoWithProof = await this.withUploadedProof(dto, proof);
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.sell' },
          {
            id,
            dto: dtoWithProof,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: randomUUID(),
          },
        )
        .pipe(timeout(PROOF_OPERATION_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('cancel/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel order (courier)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({ type: SellOrderRequestDto })
  @UseInterceptors(
    FileInterceptor('proof', {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async cancelOrder(
    @Param('id') id: string,
    @Body() dto: SellOrderRequestDto,
    @UploadedFile() proof: UploadedProofFile | undefined,
    @Req() req: { user: JwtUser },
  ) {
    const dtoWithProof = await this.withUploadedProof(dto, proof);
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.cancel' },
          {
            id,
            dto: dtoWithProof,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: randomUUID(),
          },
        )
        .pipe(timeout(PROOF_OPERATION_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  /**
   * HISOB-KITOB IDEMPOTENTLIGI (5hBeDuyn). Ilgari har so'rovda yangi
   * `randomUUID()` edi — javob 8 s dan kechiksa operator qayta bosar va
   * `runIdempotent` buni ushlamay, bitta pul ikki marta FIFO taqsimlanardi.
   * Frontend forma ochilganda bitta kalit yaratib, muvaffaqiyatgacha shu
   * kalitni `Idempotency-Key` sarlavhasida yuboradi. Boshqa foydalanuvchi
   * kaliti bilan to'qnashmasligi uchun foydalanuvchi ID si bilan bog'lanadi;
   * kalit bo'lmasa yoki noto'g'ri bo'lsa — avvalgidek tasodifiy.
   */
  private settlementRequestId(req: {
    user: JwtUser;
    headers?: Record<string, string | string[] | undefined>;
  }) {
    const raw = req.headers?.['idempotency-key'];
    const key = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
    return /^[A-Za-z0-9_-]{8,64}$/.test(key)
      ? `${req.user.sub}:${key}`
      : randomUUID();
  }

  @Post('settlement/courier-to-branch')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({
    deprecated: true,
    summary:
      'DEPRECATED (410 Gone): lump-sum settlement olib tashlandi — endi har-buyurtma FIFO ledger ishlaydi. Bu yo’l 410 qaytaradi (uEPILERk).',
  })
  settlementCourierToBranch(
    @Body() dto: SettlementCourierToBranchDto,
    @Req()
    req: {
      user: JwtUser;
      headers?: Record<string, string | string[] | undefined>;
    },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.settlement.courier_to_branch' },
          {
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: this.settlementRequestId(req),
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('settlement/branch-to-hq')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MANAGER, RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    deprecated: true,
    summary:
      'DEPRECATED (410 Gone): lump-sum remittance olib tashlandi — FIFO ledger ishlaydi. 410 qaytaradi (uEPILERk).',
  })
  settlementBranchToHq(
    @Body() dto: SettlementBranchToHqDto,
    @Req()
    req: {
      user: JwtUser;
      headers?: Record<string, string | string[] | undefined>;
    },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.settlement.branch_to_hq' },
          {
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: this.settlementRequestId(req),
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('settlement/hq-to-market')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    deprecated: true,
    summary:
      'DEPRECATED (410 Gone): HQ lump-sum payment olib tashlandi — FIFO ledger ishlaydi. 410 qaytaradi (uEPILERk).',
  })
  settlementHqToMarket(
    @Body() dto: SettlementHqToMarketDto,
    @Req()
    req: {
      user: JwtUser;
      headers?: Record<string, string | string[] | undefined>;
    },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.settlement.hq_to_market' },
          {
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: this.settlementRequestId(req),
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Get(':id/settlement')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the per-order settlement state' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  getOrderSettlement(@Param('id') id: string) {
    return firstValueFrom(
      this.orderClient
        .send({ cmd: 'order.settlement.find_by_order' }, { id })
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post(':id/could-not-deliver')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Mark order as couldn't deliver (courier)" })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiBody({ type: CouldNotDeliverOrderRequestDto })
  couldNotDeliverOrder(
    @Param('id') id: string,
    @Body() dto: CouldNotDeliverOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.could_not_deliver' },
          {
            id,
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: randomUUID(),
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('partly-sell/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Partly sell order (courier)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({ type: PartlySellOrderRequestDto })
  @UseInterceptors(
    FileInterceptor('proof', {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async partlySellOrder(
    @Param('id') id: string,
    @Body() dto: PartlySellOrderRequestDto,
    @UploadedFile() proof: UploadedProofFile | undefined,
    @Req() req: { user: JwtUser },
  ) {
    const dtoWithProof = await this.withUploadedProof(dto, proof);
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.partly_sell' },
          {
            id,
            dto: dtoWithProof,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            request_id: randomUUID(),
          },
        )
        .pipe(timeout(PROOF_OPERATION_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post('rollback/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MANAGER, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Rollback sold/cancelled order to waiting/cancelled/cancelled_sent',
  })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiBody({ type: RollbackOrderRequestDto, required: false })
  rollbackOrder(
    @Param('id') id: string,
    @Body() dto: RollbackOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.rollback_waiting' },
          {
            id,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
              branch_id: req.user.branch_id ?? null,
            },
            dto,
            request_id: randomUUID(),
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post(':id/initiate-return')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Initiate order return (HQ)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiBody({ type: InitiateOrderReturnRequestDto })
  initiateReturn(
    @Param('id') id: string,
    @Body() dto: InitiateOrderReturnRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.initiate_return' },
          {
            id,
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
            },
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Post(':id/mark-returned-to-market')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark order as returned to market (branch)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  markReturnedToMarket(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.mark_returned_to_market' },
          {
            id,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
            },
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  // Full order edit (money/status fields) — SUPERADMIN/ADMIN/REGISTRATOR only
  // (audit 2026-06-07: was JwtAuthGuard-only, letting any role rewrite any order).
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order (full fields, including items)' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  @ApiBody({ type: UpdateOrderByIdRequestDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOrderByIdRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.update_normalized' },
          {
            id,
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
            },
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Patch(':id/full')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order by id (full fields)' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  @ApiBody({ type: UpdateOrderByIdRequestDto })
  updateFull(
    @Param('id') id: string,
    @Body() dto: UpdateOrderByIdRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.update_normalized' },
          {
            id,
            dto,
            requester: {
              id: req.user.sub,
              roles: this.normalizeRoles(req.user.roles),
            },
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete order (status-based role rules)' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  remove(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return this.orderClient
      .send(
        { cmd: 'order.delete' },
        {
          id,
          requester: {
            id: req.user.sub,
            roles: this.normalizeRoles(req.user.roles),
          },
        },
      )
      .pipe(timeout(8000));
  }
}
