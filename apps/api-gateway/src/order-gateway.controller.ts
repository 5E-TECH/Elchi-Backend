import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  GatewayTimeoutException,
  GoneException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
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
  ApiConflictResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { SCAN_THROTTLE } from './auth/scan-throttle';
import { Throttle } from '@nestjs/throttler';
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
  aiStableRequestId,
  buildPreviewSnapshots,
  computeEditedFields,
} from './ai-order/ai-edited-fields';
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
  CancelOrderRequestDto,
  UpdateOrderByIdRequestDto,
} from './dto/order.swagger.dto';
import {
  AI_IMAGE_MAX_BYTES,
  AI_MAX_IMAGES,
  AI_RPC_TIMEOUT_MS,
  AI_TEXT_MAX_CHARS,
  CANCEL_RETURN_STAGES,
  FULFILLMENT_SOURCES,
  Order_status,
  parseCancelReturnStages,
  RMQ_FIRE_AND_FORGET_TIMEOUT,
  Roles as RoleEnum,
  Where_deliver,
  matchesDeclaredType,
  normalizeUzPhone,
  parseUzPhoneSearch,
  recordReceiveByScanOutcome,
  requestContext,
  type AiAuditedField,
  type AiDraftConfirmContext,
  type AiDraftLinkItem,
  type AiDraftTrace,
  type AiHealthState,
  type AiOrderExtractRequest,
  type AiOrderExtractResponse,
  type OrderFulfillmentMode,
} from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  ORDER_QR_LOOKUP_ROLES,
  assertQrOrderVisible,
} from './auth/order-qr-visibility';
import { projectOrderPayloadForRoles } from './auth/order-role-projection';
import { projectOrderTrackingForRoles } from './auth/order-tracking-projection';
import {
  LogistRegionScopeService,
  isLogistRequester,
  isRowInLogistRegions,
  projectLogistPayload,
  resolveLogistRegionFilter,
} from './auth/logist-scope';
import {
  mapOrderCreateInProgress,
  resolveOrderCreateRequestId,
} from './order-create/order-create-idempotency';
import {
  assertOrderCreateContent,
  orderCreateDistrictId,
} from './order-create/order-create-content';
import {
  resolveOrderOperatorPhones,
  type OrderMarketPhonePolicy,
} from './order-create/order-operator-phone';
import { isOrderQrLightView, sendOrderQrLight } from './order-qr-light-view';
import { scanOrderSummary } from './order-scan-summary';
import {
  ORDER_EXPORT_PAGE_SIZE,
  ORDER_EXPORT_PAGE_TIMEOUT_MS,
  streamOrdersXlsx,
  type OrderExportPage,
} from './order-export/orders-xlsx.export';

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

/** GET /orders filtrlari (sahifalashsiz) — findAll va eksport uchun umumiy. */
type OrderListFilters = {
  market_id?: string;
  customer_id?: string;
  status?: string | string[];
  search?: string;
  start_day?: string;
  end_day?: string;
  courier?: string;
  region_id?: string;
  district_id?: string;
  branch_id?: string;
  courier_ids?: string | string[];
  fetch_all?: string;
  source?: string;
  courier_id?: string;
  where_deliver?: string;
  sort_by?: string;
  sort_dir?: string;
  cancelled_inventory?: string;
  /** 6kHnNH9j: «Ombordan» filtri — HQ | WAREHOUSE. */
  fulfillment_source?: string;
  /**
   * LFNLeSpu (BG4): bekor bosqichi filtri — `courier,in_transit,branch,hq,market`
   * (vergul yoki massiv, OR). Ta'rif BG1 `return_stage` bilan AYNAN bir xil.
   */
  cancel_stage?: string | string[];
};

type OrderListRequest =
  | {
      kind: 'courier_cancelled';
      roles: string[];
      pagination: { page: number; limit: number };
      filters: Record<string, unknown>;
    }
  | {
      kind: 'query';
      roles: string[];
      pagination: { page: number; limit: number };
      query: Record<string, unknown>;
      /** 4BftLLnc: logist doirasi — javob qatorlari shu to'plam bilan qayta tekshiriladi. */
      logistRegionIds?: string[];
    }
  | {
      // 4BftLLnc: viloyat biriktirilmagan logist — bo'sh ro'yxat (403 emas).
      kind: 'empty';
      roles: string[];
      pagination: { page: number; limit: number };
    };

type UploadedProofFile = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

const PROOF_OPERATION_TIMEOUT_MS = 60000;

/**
 * 5Yy6r6UI (BG1) — buyurtma javobidagi bekor bosqichi (Swagger tavsifi).
 * Hisob order-service `cancel-return/cancel-return.ts` da.
 */
const CANCEL_RETURN_RESPONSE_DOC =
  '5Yy6r6UI (BG1): every order row has `return_stage` (`courier` | `in_transit` | `branch` | `hq` | `market` | null) ' +
  'and `cancel_return` (null unless the order is cancelled / returned to market): ' +
  '`{ stage, place_type: "COURIER" | "BRANCH" | "HQ" | null, place_id, place_name, received_at, sent_at, ' +
  'handed_over_at, handover_method: "qr" | "manual" | "no_qr" | "pin" | null }`. ' +
  'Place = where the parcel is now (courier name / branch or HQ name); `in_transit` — destination; `market` — where it ' +
  'was handed over. `received_at` (branch/hq) — since when it is at that place (last cancelled-post receipt, else ' +
  'custody time); `sent_at` (in_transit); `handed_over_at` + `handover_method` (market, fL79tFbs BG2; null method = ' +
  'legacy/unknown). Cancelled before intake (never left the market) — both null. No money fields; same for every role.';

/**
 * LFNLeSpu (BG4) — GET /orders (va eksport) `cancel_stage` filtri (Swagger).
 */
const CANCEL_STAGE_QUERY_DOC =
  'LFNLeSpu (BG4): cancel-return stage filter — comma list (or repeated param) of ' +
  '`courier`, `in_transit`, `branch`, `hq`, `market` (OR, case-insensitive). Same definition as the row `return_stage` ' +
  '(filter == badge): courier = cancelled + held by courier; in_transit = `cancelled (sent)`; branch = cancelled + held ' +
  'by branch (received, not in a return post); hq = cancelled + held by HQ; market = handed over to market ' +
  '(`returned_to_market`, warehouse returns excluded). Combined with all other filters and the role scope (AND); with ' +
  '`cancel_stage` the implicit cancelled-inventory tab mode is off. Unknown value — 400.';

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
  /**
   * Cp2v3ZJ7 #3: faqat `ok:true` da — `true` bo'lsa buyurtma AVVAL (shu
   * draft bandi bilan) yaratilgan, bu chaqiruv uni qayta YARATMADI.
   */
  idempotent_replay?: boolean;
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
  /**
   * Cp2v3ZJ7: `ai:<market>:<draft>:<idx>` — draft_id va ai_item_index bo'lsa;
   * aks holda null (eski `ai-dedupe:<imzo>` yo'li).
   */
  stableRequestId: string | null;
  /** vncdmXOy: activity_log metadata'si (server tomonda yig'ilgan). */
  aiAudit: Record<string, unknown> | null;
  /** Server hisoblagan o'zgargan maydonlar; preview topilmasa null. */
  editedFields: AiAuditedField[] | null;
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
/** vncdmXOy: `ai.draft.confirm_context` — audit uchun, yaratishni kechiktirmasin. */
const AI_DRAFT_CONTEXT_TIMEOUT_MS = 3_000;
/** vncdmXOy: `GET /orders/:id/ai-trace` → `ai.draft.trace_by_order`. */
const AI_DRAFT_TRACE_TIMEOUT_MS = 8_000;

/**
 * BUYURTMA YARATISHDA MIJOZ YUBORA OLMAYDIGAN MAYDONLAR (fix3 C6; RBAC-05,
 * LC-07). Holat va saqlash (custody) zanjiri faqat hayot sikli amallari
 * (HQ qabuli, jo'natish, skan, sotish) orqali o'zgaradi. Market yoki filial
 * xodimi `status:'received'` / `courier_id` / `post_id` yuborib HQ qabulini
 * chetlab o'tardi, `status:'sold'` + rollback esa kassaga soxta chiqim
 * yozdirardi. SUPERADMIN/ADMIN dan boshqa barcha yaratuvchilar uchun bu
 * maydonlar JIMGINA olib tashlanadi (order-service sukuti: NEW, kuryersiz).
 * DTO'da yo'q maydonlar (holder_*, sold_at, ...) ham himoya uchun ro'yxatda:
 * ichki chaqiruvchilar (bot, ai-confirm) ValidationPipe'dan o'tmaydi.
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
  'qr_code_token',
  'operator_id',
] as const;

/**
 * Joylashuv maydonlari: filial xodimida server ularni MAJBURAN qo'yadi
 * (o'z filiali, source='branch'), SUPERADMIN/ADMIN dan boshqa yaratuvchida
 * esa olib tashlanadi — market o'z buyurtmasini istalgan filialga yoki
 * `source:'branch'` bilan HQ ro'yxatidan yashira olmasin.
 */
const CREATE_PLACEMENT_FIELDS = ['branch_id', 'source'] as const;

/**
 * PATCH /orders/:id orqali HECH KIM (superadmin ham) o'zgartira olmaydigan
 * maydonlar (fix3 C6; M11, CODE-03): holat faqat sotish/bekor qilish/
 * qaytarish amallari orqali o'zgaradi — aks holda kassa oyoqlari va
 * hisob-kitob qatori yozilmay qolardi (WAITING→SOLD, SOLD→WAITING), market
 * esa sotilgan buyurtmada almashsa pul eski marketda qolardi.
 */
const PATCH_FORBIDDEN_FIELDS = [
  'status',
  'market_id',
  'to_be_paid',
  'paid_amount',
] as const;

/**
 * PATCH'da faqat SUPERADMIN o'zgartira oladigan maydonlar (CODE-03): pochta,
 * mijoz, QR yorlig'i va manba — saqlash zanjiri va ro'yxatlarga ta'sir
 * qiladi. Frontend ularni hech qachon yubormaydi (UpdateNewOrderPayload).
 */
const PATCH_SUPERADMIN_ONLY_FIELDS = [
  'post_id',
  'customer_id',
  'qr_code_token',
  'source',
] as const;

/** HQ filial id si o'zgarmaydi (tizimda bitta HQ) — qisqa kesh yetarli. */
const HQ_BRANCH_CACHE_TTL_MS = 60_000;

class ReceiveExternalOrdersDto {
  @IsString()
  @IsNotEmpty()
  integration_id!: string;

  @IsArray()
  orders!: any[];
}

/**
 * Lump-sum settlement oyoqlari (kuryer→filial, filial→HQ, HQ→market) Faza 2b
 * da olib tashlangan — pul faqat kassa to'lov endpointlari orqali ko'chadi va
 * settlement'ni o'zi ilgari suradi (MlVMpsfr).
 */
export const SETTLEMENT_LUMP_SUM_GONE_MESSAGE =
  "Bu hisob-kitob yo'li o'chirilgan (Faza 2b). Pulni kassa to'lovlari orqali ko'chiring: " +
  'POST /finance/cashbox/payment/courier (kuryer→filial), ' +
  'POST /finance/cashbox/payment/branch-to-main (filial→HQ), ' +
  'POST /finance/cashbox/payment/market (HQ→market) — settlement avtomatik ilgari suriladi';

/** Umumiy ro'yxatlar uchun ruxsat etilgan `limit` qiymatlari. */
const DEFAULT_ALLOWED_LIMITS = [10, 25, 50, 100] as const;
/**
 * `GET /orders/external` — kiruvchi posilkalar skan ekrani (PEc4BjVX):
 * frontend butun qopni `limit=200` bilan oladi; ilgari bu 400 qaytarib,
 * skan ekrani 100% o'lik edi.
 */
export const EXTERNAL_ALLOWED_LIMITS = [10, 25, 50, 100, 200] as const;

/**
 * (lQjt6sKP) RMQ javobidagi ID → satr. Faqat satr/son qabul qilinadi; boshqa
 * qiymat (obyekt va h.k.) bo'sh satr — `[object Object]` ID bo'lib ketmasin.
 */
function replacementIdText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
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
    // 4BftLLnc — logist viloyatlari (umumiy kesh). Yo'q bo'lsa (eski
    // spec'lar) — shu kontrollerning LOGISTICS mijozi bilan lokal nusxa.
    @Optional() private readonly logistScope?: LogistRegionScopeService,
  ) {}

  private readonly logger = new Logger(OrderGatewayController.name);

  private logistScopeFallback?: LogistRegionScopeService;

  /** 4BftLLnc: logistning viloyat id'lari (xato — 503, fail-closed). */
  private logistRegionIds(user: JwtUser | undefined): Promise<string[]> {
    const scope =
      this.logistScope ??
      (this.logistScopeFallback ??= new LogistRegionScopeService(
        this.logisticsClient,
      ));
    return scope.regionIds(user?.sub);
  }

  private hqBranchIdCache: { id: string; at: number } | null = null;

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
    page: number,
    limit: number,
  ): Promise<{ data: Array<Record<string, unknown>>; total: number }> {
    const requesterId = String(reqUser?.sub ?? '').trim();
    if (!requesterId) {
      return { data: [], total: 0 };
    }

    // (9Rdi2gJF) Kuryerning bekor tabi order-service'da SQL sahifalanadi.
    const response: unknown = await this.sendOrderWithTimeout(
      { cmd: 'order.find_all_enriched' },
      {
        query: {
          ...filters,
          status: [Order_status.CANCELLED],
          courier_ids: [requesterId],
          holder_courier_ids: [requesterId],
          courier_scope: 'any',
          courier_post_history: true,
          courier_cancelled_tab: true,
          page,
          limit,
        },
      },
    );
    const outer =
      response && typeof response === 'object'
        ? (response as Record<string, unknown>)
        : {};
    const nested = outer.data;
    const body =
      nested && typeof nested === 'object' && !Array.isArray(nested)
        ? (nested as Record<string, unknown>)
        : outer;
    return {
      data: this.extractRows(body).map((row) =>
        this.normalizeCourierCancelledRowForDisplay(row),
      ),
      total: Number(body?.total ?? 0),
    };
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
    // ⚠️ OPERATOR va MARKET_OPERATOR bu yerdan OLIB TASHLANDI (fix3 C11,
    // CODE-04): ular har qanday buyurtmaning mijoz ma'lumotini o'qiy olardi.
    if (roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN)) {
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
    if (roles.includes(RoleEnum.MARKET_OPERATOR)) {
      // Operator faqat o'zi biriktirilgan marketning buyurtmasini ko'radi.
      const operatorMarketId = await this.resolveMarketOperatorMarketId(
        reqUser as JwtUser,
      );
      return operatorMarketId && field('market_id') === operatorMarketId
        ? undefined
        : denied();
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
      if (branchId && orderBranches.includes(branchId)) {
        return;
      }
      // HQ xodimi HQ qo'lidagi buyurtmani ko'radi (holder_type HQ,
      // holder_branch_id NULL — masalan filialdan qaytgan bekor qilinganlar).
      return (await this.isHqHeldOrderForBranch(branchId, field('holder_type')))
        ? undefined
        : denied();
    }
    // 4BftLLnc (LG-S3): logist — faqat o'z viloyatidagi buyurtma.
    if (isLogistRequester(roles)) {
      const regionIds = await this.logistRegionIds(reqUser);
      return isRowInLogistRegions(order, regionIds) ? undefined : denied();
    }
    // operator / investor / unknown roles: no per-order access.
    return denied();
  }

  /**
   * HQ filial id si (`branch.find_hq`), 60 s keshlanadi. Xato chaqiruvchiga
   * uzatiladi — har bir chaqiruvchi o'zi fail-closed qaror qiladi.
   */
  private async resolveHqBranchId(): Promise<string> {
    const cached = this.hqBranchIdCache;
    if (cached && Date.now() - cached.at < HQ_BRANCH_CACHE_TTL_MS) {
      return cached.id;
    }
    const response: unknown = await this.sendBranchWithTimeout(
      { cmd: 'branch.find_hq' },
      {},
    );
    const hqBranchId = this.asStr(
      (response as { data?: { id?: unknown } } | null)?.data?.id,
    ).trim();
    if (hqBranchId) {
      this.hqBranchIdCache = { id: hqBranchId, at: Date.now() };
    }
    return hqBranchId;
  }

  /** `branchId` — HQ filiali. HQ aniqlanmasa (xato) — false (fail-closed). */
  private async isHqBranchId(branchId: string): Promise<boolean> {
    if (!branchId) {
      return false;
    }
    const hqBranchId = await this.resolveHqBranchId().catch(() => '');
    return Boolean(hqBranchId) && hqBranchId === branchId;
  }

  /** Buyurtma HQ qo'lida va so'rovchi filial xodimi HQ'ga biriktirilgan. */
  private async isHqHeldOrderForBranch(
    branchId: string,
    holderType: string,
  ): Promise<boolean> {
    return (
      holderType.trim().toUpperCase() === 'HQ' &&
      (await this.isHqBranchId(branchId))
    );
  }

  /**
   * HQ filialiga biriktirilgan REGISTRATOR (fix3 C4). Bekor qilingan mollar
   * HQ qo'lida (holder_type HQ, holder_branch_id NULL) turadi, shuning uchun
   * uning ro'yxatlari SA/admin ro'yxati bilan bir xil bo'lishi kerak —
   * aks holda topshirish ekrani doim bo'sh qolardi.
   */
  private async isHqRegistrator(
    roles: string[],
    assignment: BranchAssignment | null,
  ): Promise<boolean> {
    if (!roles.includes(RoleEnum.REGISTRATOR)) {
      return false;
    }
    return this.isHqBranchId(this.asStr(assignment?.branch_id).trim());
  }

  /**
   * MARKET_OPERATOR biriktirilgan market (identity `user.market_id`).
   * Topilmasa yoki identity javob bermasa — '' (chaqiruvchi rad etadi).
   */
  private async resolveMarketOperatorMarketId(user: JwtUser): Promise<string> {
    const profile: unknown = await this.sendIdentityWithTimeout(
      { cmd: 'identity.user.find_by_id' },
      { id: user?.sub },
    ).catch(() => null);
    return this.asStr(
      (profile as { data?: { market_id?: unknown } } | null)?.data?.market_id,
    ).trim();
  }

  /**
   * Filial xodimi (REGISTRATOR) faqat o'z filiali doirasidagi buyurtmani
   * o'zgartiradi/o'chiradi (fix3 C6, CODE-03). Doira — ko'rish qoidasi bilan
   * AYNI: branch_id / holder_branch_id / home_branch_id. Buyurtma topilmasa
   * order-service'ning o'z 404 xatosi qaytadi.
   */
  private async assertOrderInRequesterBranch(
    reqUser: JwtUser,
    orderId: string,
    deniedMessage: string,
  ): Promise<void> {
    const assignment = await this.resolveBranchAssignment(reqUser);
    const branchId = this.asStr(assignment?.branch_id).trim();
    if (!this.isBranchStaffAssignment(assignment) || !branchId) {
      throw new ForbiddenException(
        'Filial xodimi hech qaysi filialga biriktirilmagan',
      );
    }
    const order = await this.findOrderRowForScope(orderId);
    if (!order) {
      return;
    }
    const orderBranches = ['branch_id', 'holder_branch_id', 'home_branch_id']
      .map((key) => this.asStr(order[key] ?? order[this.toCamelKey(key)]))
      .map((value) => value.trim());
    if (!orderBranches.includes(branchId)) {
      throw new ForbiddenException(deniedMessage);
    }
  }

  /**
   * Doira tekshiruvi uchun buyurtma qatori (`order.find_by_id`).
   *
   * fix3b: order-service `findById` buyurtma qatorini O'RAMSIZ qaytaradi
   * (`{ data }` emas). Ilgari faqat `.data` o'qilardi — prod'da u doim
   * `undefined` edi, ya'ni qator "topilmadi" deb hisoblanib, filial va
   * market egasi tekshiruvlari jimgina o'tkazib yuborilardi. Endi ikkala
   * ko'rinish ham qabul qilinadi (eski `{ data }` o'rami ham).
   */
  private async findOrderRowForScope(
    orderId: string,
  ): Promise<Record<string, unknown> | null> {
    const response: unknown = await this.sendOrderWithTimeout(
      { cmd: 'order.find_by_id' },
      { id: orderId },
    );
    const row = this.unwrapOrderRow(response);
    return row && this.asStr(row.id).trim() ? row : null;
  }

  /**
   * `order.find_by_id(_enriched)` javobidagi buyurtma qatori. order-service
   * qatorni O'RAMSIZ qaytaradi; eski `{ data }` o'rami ham qabul qilinadi.
   * Ilgari GET /orders/:id va /:id/tracking faqat `.data` ni tekshiruvga
   * berardi — prod'da u doim `undefined` bo'lib, ko'rish tekshiruvlari
   * umuman ishlamasdi (istalgan rol istalgan buyurtmani o'qirdi).
   */
  private unwrapOrderRow(response: unknown): Record<string, any> | null {
    if (!response || typeof response !== 'object') {
      return null;
    }
    const wrapped = (response as { data?: unknown }).data;
    return (
      wrapped && typeof wrapped === 'object' ? wrapped : response
    ) as Record<string, any>;
  }

  /** `value` dan `fields` ni olib tashlangan nusxa (asl obyekt o'zgarmaydi). */
  private omitFields<T extends object>(value: T, fields: readonly string[]): T {
    const copy = { ...value } as Record<string, unknown>;
    for (const key of fields) {
      delete copy[key];
    }
    return copy as T;
  }

  /** `dto` da haqiqatan yuborilgan (undefined emas) maydonlar. */
  private presentFields(dto: unknown, fields: readonly string[]): string[] {
    const record = (dto ?? {}) as Record<string, unknown>;
    return fields.filter((key) => record[key] !== undefined);
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

    // Ho5qcDn4 TC9: market faqat O'Z buyurtmasining tarixini ko'radi
    // (GET /orders/:id bilan ayni qoida — `market_id === sub`).
    if (roles.includes(RoleEnum.MARKET)) {
      return sub && field('market_id') === sub ? undefined : denied();
    }

    if (
      roles.includes(RoleEnum.BRANCH) ||
      roles.includes(RoleEnum.MANAGER) ||
      roles.includes(RoleEnum.REGISTRATOR)
    ) {
      // fix3 RBAC-15: ilgari faqat `holder_type BRANCH` + o'z filiali o'tardi —
      // HQ registratori HECH QACHON (HQ qo'lidagi buyurtma holder_branch_id
      // NULL), filial xodimi esa buyurtma kuryerga o'tishi bilan 403 olardi.
      // Endi doira buyurtmani ko'rish qoidasi bilan AYNI.
      const assignment = await this.resolveBranchAssignment(reqUser as JwtUser);
      const branchId = String(assignment?.branch_id ?? '').trim();
      const orderBranches = [
        field('branch_id'),
        field('holder_branch_id'),
        field('home_branch_id'),
      ];
      if (branchId && orderBranches.includes(branchId)) {
        return;
      }
      return (await this.isHqHeldOrderForBranch(branchId, holderType))
        ? undefined
        : denied();
    }

    // 4BftLLnc (LG-S1/LG-S3): logist — o'z viloyatidagi buyurtma tarixi.
    if (isLogistRequester(roles)) {
      const regionIds = await this.logistRegionIds(reqUser);
      return isRowInLogistRegions(order, regionIds) ? undefined : denied();
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

  private parsePaginationQuery(
    page?: string,
    limit?: string,
    allowedLimits: readonly number[] = DEFAULT_ALLOWED_LIMITS,
  ) {
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

  /**
   * UER0MpMX — `POST /orders` (va ai-confirm) da market va mahsulot egaligi
   * SERVER tomonda. Ilgari: mavjud bo'lmagan `market_id` bilan yetim buyurtma
   * yaratilardi; A marketning `product_id` si B marketning buyurtmasiga
   * yozilardi (IDOR — yorliq/chekda begona mahsulot); nofaol market va
   * `add_order=false` market ham buyurtma yaratardi (faqat frontend to'sardi).
   *  - market yo'q / market emas → 404 (identity o'zi tashlaydi);
   *  - market nofaol → 400;
   *  - market / market_operator roli va `add_order=false` → 400 (admin,
   *    registrator va filial xodimi market nomidan yaratishda davom etadi);
   *  - har `product_id` shu marketniki bo'lishi shart → 404.
   *
   * NFiXfmq6: tekshirilgan market yozuvi qaytariladi — ai-confirm undagi
   * `ai_price_per_order` ni (qo'shimcha RPC'siz) narx qaydi uchun oladi.
   */
  private async assertOrderMarket(
    marketId: string | undefined,
    roles: string[],
  ): Promise<
    (OrderMarketPhonePolicy & { ai_price_per_order?: unknown }) | null
  > {
    const id = String(marketId ?? '').trim();
    if (!id) {
      return null;
    }
    const response = await this.sendIdentityWithTimeout(
      { cmd: 'identity.market.find_by_id' },
      { id },
    );
    const market =
      (
        response as {
          data?: {
            id?: string;
            status?: string;
            add_order?: boolean;
            require_operator_phone?: boolean | null;
            default_operator_phone?: string | null;
            ai_price_per_order?: unknown;
          };
        } | null
      )?.data ?? null;
    if (!market) {
      throw new NotFoundException('Market topilmadi');
    }
    if (String(market.status ?? '').toLowerCase() !== 'active') {
      throw new BadRequestException(
        "Market faol emas — unga buyurtma yaratib bo'lmaydi",
      );
    }
    const isMarketSide =
      roles.includes(RoleEnum.MARKET) ||
      roles.includes(RoleEnum.MARKET_OPERATOR);
    if (isMarketSide && market.add_order === false) {
      throw new BadRequestException(
        "Bu marketga o'zi buyurtma yaratish ruxsat etilmagan (add_order o'chiq)",
      );
    }
    // VRyloH62: operator raqami sozlamasi — `createOrderInternal` qayta
    // so'ramasligi uchun shu javobdan qaytariladi.
    // NFiXfmq6: AI buyurtma narxi ham shu yozuvdan (ai-confirm narx qaydi).
    return {
      require_operator_phone: market.require_operator_phone === true,
      default_operator_phone: market.default_operator_phone ?? null,
      ai_price_per_order: market.ai_price_per_order,
    };
  }

  /**
   * VRyloH62 — registrator/market operatori `operator` maydonini bo'sh
   * qoldirsa (forma, bot, AI), buyurtmaga uning ISMI yoziladi (BeePost
   * `order.service.ts:362-365` kabi). Ilgari faqat `operator_id` yozilardi,
   * ko'rinadigan `operator` matni bo'sh qolardi.
   *
   * Qaytaradi: to'ldiriladigan ism yoki `null` (to'ldirish kerak emas —
   * matn yozilgan, rol boshqa yoki ism olinmadi). Ism olinmasa buyurtma
   * TO'XTAMAYDI (fail-open): bu faqat ko'rinadigan yorliq matni.
   */
  private async resolveCreateOperatorName(
    typed: unknown,
    roles: string[],
    user: JwtUser,
    preloaded: string | null | undefined,
  ): Promise<string | null> {
    if (this.asStr(typed).trim()) {
      return null;
    }
    if (
      !roles.includes(RoleEnum.REGISTRATOR) &&
      !roles.includes(RoleEnum.MARKET_OPERATOR)
    ) {
      return null;
    }
    if (preloaded !== undefined) {
      return preloaded || null;
    }
    return this.loadRequesterName(user?.sub);
  }

  /** So'rovchi ismi (identity) — 3 s, xato/timeout'da `null`. */
  private async loadRequesterName(userId: unknown): Promise<string | null> {
    const id = this.asStr(userId).trim();
    if (!id) return null;
    const profile: unknown = await firstValueFrom(
      this.identityClient
        .send({ cmd: 'identity.user.find_by_id' }, { id })
        .pipe(timeout(3000)),
    ).catch(() => null);
    const name = (profile as { data?: { name?: unknown } } | null)?.data?.name;
    return this.asStr(name).trim() || null;
  }

  /**
   * NFiXfmq6: market yozuvidagi AI buyurtma narxi (so'm) — nomanfiy son yoki
   * null (bo'sh / eski identity → ai-service global `AI_PRICE_PER_ORDER`).
   */
  private aiPricePerOrderOf(
    market: { ai_price_per_order?: unknown } | null,
  ): number | null {
    const raw = market?.ai_price_per_order;
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  /** UER0MpMX: har `product_id` aynan shu marketniki bo'lishi shart (IDOR). */
  private async assertOrderProductsOwned(
    marketId: string | undefined,
    items: Array<{ product_id?: string | null }>,
  ): Promise<void> {
    const id = String(marketId ?? '').trim();
    const productIds = this.distinctIds(items.map((item) => item?.product_id));
    if (!id || !productIds.length || !this.catalogClient) {
      return;
    }
    let lookup: unknown;
    try {
      lookup = await this.findAiConfirmProducts(productIds);
    } catch {
      // Fail-closed: tekshiruvsiz begona mahsulot yozilmasin.
      throw new ServiceUnavailableException(
        "Mahsulotlarni tekshirib bo'lmadi — keyinroq qayta urinib ko'ring",
      );
    }
    const rows = this.extractRows(lookup);
    const ownerById = new Map(
      rows
        .filter((row) => !this.isDeletedRow(row))
        .map((row) => [
          this.asStr(row?.id).trim(),
          this.asStr(row?.user_id ?? row?.market_id).trim(),
        ]),
    );
    for (const productId of productIds) {
      if (ownerById.get(productId) !== id) {
        throw new NotFoundException(`Mahsulot topilmadi: ${productId}`);
      }
    }
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
      /** VRyloH62: partiya boshida olingan market profili. */
      marketProfile?: OrderMarketPhonePolicy | null;
      /** VRyloH62: partiya boshida olingan so'rovchi ismi. */
      operatorName?: string | null;
      includeMarketId: boolean;
      branchAssignment: BranchAssignment | null;
      /** 6kHnNH9j: so'rov darajasidagi manba tanlovi. */
      fulfillment?: OrderFulfillmentMode;
    },
  ): Promise<AiConfirmResult> {
    const { order, index } = item;
    const mapped: CreateOrderRequestDto = {
      // 6kHnNH9j: buyurtma → so'rov → sukut `auto` (createOrderInternal).
      ...((order.fulfillment ?? ctx.fulfillment)
        ? { fulfillment: order.fulfillment ?? ctx.fulfillment }
        : {}),
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
      // txmkXVBa: «Kartani ham yangilash» (berilmasa — karta o'zgarmaydi).
      ...(order.update_customer_card === true
        ? { update_customer_card: true }
        : {}),
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

    // Cp2v3ZJ7: draft_id + ai_item_index bo'lsa BARQAROR kalit
    // (`ai:<market>:<draft>:<idx>`, ⚠️ request_id payloadga shu yerda ANIQ
    // yoziladi — aks holda rmqSend/withRequestId random UUID qo'yib himoyani
    // jimgina o'chirardi), mazmun imzosi esa ichki 2-qatlam (`ai_signature`).
    // Bo'lmasa — eski yo'l: request_id = `ai-dedupe:<imzo>` (10 daqiqa).
    const response: unknown = await this.createOrderInternal(mapped, req, {
      requestId: item.stableRequestId ?? `${AI_DEDUPE_PREFIX}${item.signature}`,
      ...(item.stableRequestId ? { aiSignature: item.signature } : {}),
      aiAudit: item.aiAudit,
      marketId: ctx.marketId,
      marketProfile: ctx.marketProfile ?? null,
      operatorName: ctx.operatorName ?? null,
      branchAssignment: ctx.branchAssignment,
    });
    const body = (response ?? {}) as {
      id?: unknown;
      data?: { id?: unknown } | null;
      idempotent_replay?: unknown;
    };
    const orderId = this.asStr(body.data?.id ?? body.id).trim();

    // Cp2v3ZJ7 TC2: AYNI draft bandi avval yaratilgan — o'sha buyurtma
    // qaytdi (yangisi yaratilmadi). Bu MUVAFFAQIYAT: UI kartani qulflaydi.
    if (item.stableRequestId && body.idempotent_replay === true) {
      return {
        index,
        ok: true,
        ...(orderId ? { order_id: orderId } : {}),
        idempotent_replay: true,
      };
    }

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
    return {
      index,
      ok: true,
      ...(orderId ? { order_id: orderId } : {}),
      idempotent_replay: false,
    };
  }

  /**
   * AI xarajatini (ai_usage_log) yaratilgan buyurtmalarga bog'laydi — har
   * `draft_id` uchun BITTA `ai.usage.link_orders` (lYVuADRE #18).
   * vncdmXOy: shu xabarda `items` (order_id, item_index, server hisoblagan
   * edited_fields) va `confirmed_by` — ai-service `ai_order_draft_item` ga
   * yozadi (draft ↔ buyurtma bog'lanishining asosiy manbai).
   * Fire-and-forget: javob kutilmaydi, xato faqat WARN — buyurtma natijasiga
   * TA'SIR QILMAYDI. ⚠️ Qayta urinish YO'Q (ai.* RPC).
   * Cp2v3ZJ7: `idempotent_replay` (avval yaratilgan) natijalar QAYTA
   * bog'lanmaydi — ular birinchi chaqiruvda bog'langan.
   * NFiXfmq6: `ai_price_per_order` — market yozuvidagi narx (null — global);
   * ai-service uni har YANGI bog'langan buyurtmaga muzlatadi (`order_id`
   * UNIQUE — ikki marta chaqiruvda narx faqat bir marta qayd qilinadi).
   */
  private linkAiUsageOrders(
    orders: AiConfirmOrderDto[],
    results: Map<number, AiConfirmResult>,
    marketId: string,
    eligible: EligibleAiOrder[] = [],
    confirmedBy?: string,
    aiPricePerOrder: number | null = null,
  ): void {
    if (!this.aiClient) return;
    const editedByIndex = new Map(
      eligible.map((item) => [item.index, item.editedFields]),
    );
    const byDraft = new Map<
      string,
      { orderIds: string[]; items: AiDraftLinkItem[] }
    >();
    orders.forEach((order, index) => {
      const result = results.get(index);
      const draftId = this.asStr(order?.draft_id).trim();
      if (!result?.ok || !result.order_id || !draftId) return;
      if (result.idempotent_replay === true) return;
      const entry = byDraft.get(draftId) ?? { orderIds: [], items: [] };
      entry.orderIds.push(result.order_id);
      entry.items.push({
        item_index:
          typeof order.ai_item_index === 'number' ? order.ai_item_index : null,
        order_id: result.order_id,
        edited_fields: editedByIndex.get(index) ?? null,
      });
      byDraft.set(draftId, entry);
    });
    const confirmer = this.asStr(confirmedBy).trim();
    for (const [draftId, entry] of byDraft) {
      void firstValueFrom(
        this.aiClient
          .send(
            { cmd: 'ai.usage.link_orders' },
            {
              draft_id: draftId,
              order_ids: entry.orderIds,
              market_id: marketId,
              items: entry.items,
              ...(confirmer ? { confirmed_by: confirmer } : {}),
              ai_price_per_order: aiPricePerOrder,
            },
          )
          .pipe(timeout(RMQ_FIRE_AND_FORGET_TIMEOUT)),
      ).catch((error: unknown) => {
        this.logger.warn(
          `ai.usage.link_orders yuborilmadi (draft ${draftId}): ${this.errorName(error)}`,
        );
      });
    }
  }

  /**
   * vncdmXOy: partiyadagi draft'lar konteksti (`ai.draft.confirm_context`) —
   * BITTA RPC, qisqa timeout. Xato/timeout/AI o'chiq → bo'sh Map (yaratish
   * to'xtamaydi). Faqat shu marketning draft'lari qaytadi (ai-service sharti).
   */
  private async loadAiDraftContexts(
    marketId: string,
    draftIds: string[],
  ): Promise<Map<string, AiDraftConfirmContext>> {
    const out = new Map<string, AiDraftConfirmContext>();
    if (!this.aiClient || draftIds.length === 0) return out;
    try {
      const response: unknown = await firstValueFrom(
        this.aiClient
          .send<unknown>(
            { cmd: 'ai.draft.confirm_context' },
            { market_id: marketId, draft_ids: draftIds },
          )
          .pipe(timeout(AI_DRAFT_CONTEXT_TIMEOUT_MS)),
      );
      const drafts = (response as { drafts?: unknown } | null)?.drafts;
      for (const d of Array.isArray(drafts) ? drafts : []) {
        const ctx = d as AiDraftConfirmContext;
        if (typeof ctx?.draft_id === 'string') out.set(ctx.draft_id, ctx);
      }
    } catch (error: unknown) {
      this.logger.warn(
        `ai.draft.confirm_context ishlamadi (${this.errorName(error)}) — audit metadata qisqartirilgan`,
      );
    }
    return out;
  }

  /**
   * vncdmXOy #2: har eligible buyurtmaga `aiAudit` (activity_log metadata) va
   * SERVER tomonda hisoblangan `editedFields`. draft_id bo'lmasa — audit yo'q
   * (oddiy qo'lda kiritilgan buyurtma kabi).
   */
  private async attachAiAudit(
    eligible: EligibleAiOrder[],
    marketId: string,
  ): Promise<void> {
    const draftIds = this.distinctIds(
      eligible.map((item) => item.order.draft_id),
    );
    if (draftIds.length === 0) return;
    const contexts = await this.loadAiDraftContexts(marketId, draftIds);
    for (const item of eligible) {
      const draftId = this.asStr(item.order.draft_id).trim();
      if (!draftId) continue;
      const ctx = contexts.get(draftId) ?? null;
      const itemIndex =
        typeof item.order.ai_item_index === 'number'
          ? item.order.ai_item_index
          : null;
      const preview =
        ctx?.previews && itemIndex !== null
          ? (ctx.previews.find((p) => p.index === itemIndex) ?? null)
          : null;
      item.editedFields = preview
        ? computeEditedFields(preview, {
            customer: item.order.customer,
            district_id: item.districtId,
            region_id: item.regionId,
            address: item.order.address,
            total_price: item.order.total_price,
            where_deliver: item.order.where_deliver,
            comment: item.order.comment,
            operator: item.order.operator,
            items: item.order.items,
          })
        : null;
      const draftCostUzs = ctx ? Number(ctx.cost_uzs) || 0 : null;
      item.aiAudit = {
        ai: true,
        ai_draft_id: draftId,
        ai_item_index: itemIndex,
        // draft shu marketniki va ai-service'da topildi.
        ai_draft_verified: ctx !== null,
        model: ctx?.model ?? null,
        prompt_version: ctx?.prompt_version ?? null,
        ai_draft_cost_uzs: draftCostUzs,
        // Buyurtma ulushi: draft xarajati / AI taklif qilgan buyurtmalar soni.
        ai_cost_uzs:
          draftCostUzs === null
            ? null
            : Math.round(
                (draftCostUzs / Math.max(1, Number(ctx?.preview_count) || 1)) *
                  100,
              ) / 100,
        edited_fields: item.editedFields,
      };
    }
  }

  /**
   * vncdmXOy: AI TAKLIFI snapshot'i ai-service'ga (`ai_order_draft.
   * resolved_preview`) — fire-and-forget, javobga ta'sir qilmaydi. Telefon
   * faqat maskalangan + sha256 (`buildPreviewSnapshots`).
   */
  private attachAiDraftPreview(
    draftId: string,
    marketId: string,
    previews: unknown[],
  ): void {
    if (!this.aiClient || previews.length === 0) return;
    try {
      void firstValueFrom(
        this.aiClient
          .send(
            { cmd: 'ai.draft.attach_preview' },
            {
              draft_id: draftId,
              market_id: marketId,
              previews: buildPreviewSnapshots(previews),
            },
          )
          .pipe(timeout(RMQ_FIRE_AND_FORGET_TIMEOUT)),
      ).catch((error: unknown) => {
        this.logger.warn(
          `ai.draft.attach_preview yuborilmadi (draft ${draftId}): ${this.errorName(error)}`,
        );
      });
    } catch (error: unknown) {
      this.logger.warn(
        `ai.draft.attach_preview yuborilmadi (draft ${draftId}): ${this.errorName(error)}`,
      );
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
    // (OfRSoRUX, ega qarori 2026-10-19 MO-S3) market operatori qo'lda ham
    // yaratadi. Mantiq `createOrderInternal` da (AI yo'li bilan AYNI): market —
    // identity `user.market_id` (tanadagi market_id E'TIBORSIZ), `operator_id`
    // — operatorning o'zi, `operator` bo'sh bo'lsa — uning ismi.
    RoleEnum.MARKET_OPERATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create order',
    description:
      "gpCIsGjH: `Idempotency-Key` sarlavhasi bilan takroriy so'rov (ikki marta bosish, retry) ikkinchi buyurtma yaratmaydi — " +
      "keshlangan javob `idempotent_replay: true` bilan qaytadi; birinchisi hali bajarilayotgan bo'lsa 409. " +
      'Kalitsiz — har so`rov alohida buyurtma (avvalgidek). ' +
      'OfRSoRUX: MARKET_OPERATOR ham yaratadi — market server tomonda (operator biriktirilgan market; ' +
      "tanadagi `market_id` e'tiborsiz, marketga biriktirilmagan operator — 400), `operator` bo'sh bo'lsa " +
      'operator ismi yoziladi, javob market proyeksiyasida (kuryer tarifi/ulushi va filial ulushisiz).',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      "Forma sessiyasi davomida barqaror kalit (≤255 belgi). Foydalanuvchi bo'yicha ajratiladi.",
  })
  @ApiBody({ type: CreateOrderRequestDto })
  async create(
    @Body() dto: CreateOrderRequestDto,
    @Req() req: { user: JwtUser },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // gpCIsGjH: request_id DOIM — kalit bo'lsa `idem:<user>:<sha256>`,
    // bo'lmasa har so'rovga yangi UUID (RMQ qayta yetkazishiga himoya).
    const requestId = resolveOrderCreateRequestId(
      req?.user?.sub,
      idempotencyKey,
    );
    // kH2zZsz3 (tekshiruv #4): yaratilgan buyurtma qatori (order-service
    // `findById`) — market/market operatori kuryer tarifi/ulushi va filial
    // ulushi kalitlarini ko'rmaydi (GET /orders/:id bilan AYNI proyeksiya).
    const response: unknown = await this.createOrderInternal(dto, req, {
      requestId,
    }).catch((error: unknown) => {
      throw mapOrderCreateInProgress(error);
    });
    return projectOrderPayloadForRoles(req?.user?.roles, response);
  }

  private hasCustomerIdValue(value: unknown): boolean {
    return (
      (typeof value === 'string' || typeof value === 'number') &&
      String(value).trim() !== ''
    );
  }

  /**
   * hiqRNhkI TC3 + WCuZzUCv — admin bo'lmagan rol yuborgan `customer_id`.
   *
   * Qoida `GET /customers/suggest` bilan AYNAN bir xil (ega qarori
   * 2026-10-19 S3 — mijoz kartasi marketlar orasida umumiy):
   *  - mijozning SHU marketda (o'chirilmagan) buyurtmasi bor
   *    (`order.customer.market_summary`) → qabul, `inMarket: true`;
   *  - aks holda (boshqa market mijozi) — identity'da CUSTOMER rolida va
   *    o'chirilmagan karta bo'lsa VA so'rovdagi `customer.phone_number`
   *    kartadagi asosiy telefonga TO'LIQ mos kelsa → qabul,
   *    `inMarket: false`. Telefon talabi — RBAC-01: ketma-ket id yuborib
   *    boshqa marketlar mijozlarini sanab chiqib bo'lmaydi (suggest ham
   *    begona mijozni faqat to'liq telefon bilan ko'rsatadi).
   *
   * Qaytaradi: qabul qilingan id yoki `null`. Xulosa olinmasa (timeout/xato)
   * va `customer` obyekti bor bo'lsa — `null` (avvalgi telefon yo'li); obyekt
   * yo'q bo'lsa xato yuqoriga otiladi (fail-closed).
   */
  private async resolveScopedCustomerId(
    marketId: string | undefined,
    rawCustomerId: unknown,
    customer: { phone_number?: unknown } | undefined,
  ): Promise<{ id: string; inMarket: boolean } | null> {
    const customerId = this.asStr(rawCustomerId).trim();
    const market = String(marketId ?? '').trim();
    if (!/^\d+$/.test(customerId) || !/^\d+$/.test(market)) {
      return null;
    }
    let summary: unknown;
    try {
      summary = await this.sendOrderWithTimeout(
        { cmd: 'order.customer.market_summary' },
        { market_id: market, customer_ids: [customerId] },
      );
    } catch (error) {
      if (customer) {
        return null;
      }
      throw error;
    }
    const items = (summary as { data?: { items?: unknown } } | null)?.data
      ?.items;
    const inScope =
      Array.isArray(items) &&
      items.some(
        (item) =>
          this.asStr((item as { customer_id?: unknown })?.customer_id) ===
          customerId,
      );
    if (inScope) {
      return { id: customerId, inMarket: true };
    }

    // WCuZzUCv: boshqa market mijozi — faqat to'liq telefon mos kelsa.
    const requestPhone = normalizeUzPhone(customer?.phone_number);
    if (!requestPhone) {
      return null;
    }
    const card: unknown = await this.sendIdentityWithTimeout(
      { cmd: 'identity.customer.find_by_id' },
      { id: customerId },
    ).catch(() => null);
    const cardPhone = normalizeUzPhone(
      (card as { data?: { phone_number?: unknown } } | null)?.data
        ?.phone_number,
    );
    if (!cardPhone || cardPhone !== requestPhone) {
      return null;
    }
    this.logger.log(
      `order.create out-of-market customer_id accepted: market=${market} customer_id=${customerId}`,
    );
    return { id: customerId, inMarket: false };
  }

  /**
   * `POST /orders` ning butun mantig'i — `create()` va `ai-confirm` ikkalasi
   * shu yerdan o'tadi (yangi yaratish mantig'i YOZILMAYDI, wgqxS0Cp #4).
   *
   * `opts` berilmasa filial va market odatdagidek aniqlanadi. gpCIsGjH:
   * `order.create` payloadida `request_id` DOIM bor — `opts.requestId`
   * (create(): `Idempotency-Key` dan, ai-confirm: AI kalitlari), bo'lmasa
   * (bot yo'li) har chaqiruvga yangi `randomUUID()` — RMQ xabari qayta
   * yetkazilsa ikkinchi buyurtma yaratilmaydi. Ilgari `request_id`
   * yuborilmasdi va order-service'dagi idempotentlik o'lik kod edi.
   *
   * VRyloH62: `operator` bo'sh bo'lsa registrator/market operatori o'z ismi
   * bilan to'ldiriladi; operator raqamlari (`operator_phone` 1-raqam,
   * `secondary_operator_phone` 2-raqam) market sozlamasi bo'yicha SHU YERDA
   * hal qilinadi (`resolveOrderOperatorPhones`) — mijoz DTO'sidagi qiymat
   * to'g'ridan-to'g'ri yozilmaydi.
   *
   * `opts` faqat ai-confirm uchun:
   *  - `marketId` — partiya uchun BIR MARTA aniqlangan market; rolga qarab
   *    qayta qidirilmaydi;
   *  - `marketProfile` — o'sha market profili (operator raqami sozlamasi);
   *  - `operatorName` — partiya uchun BIR MARTA olingan so'rovchi ismi;
   *  - `branchAssignment` — partiya uchun BIR MARTA aniqlangan filial
   *    (`null` ham qiymat: "filial yo'q"); `undefined` bo'lsa odatiy yo'l;
   *  - `requestId` — `'ai-dedupe:<sha256>'`: order-service uni 10 daqiqalik
   *    idempotentlik kaliti sifatida ishlatadi (takror yuborish — dublikat emas).
   *
   * `opts.createdVia` (Celz3rKJ) — faqat bot yo'li (`botOrderCreate`):
   * `order.create` payloadining YUQORI darajasida `created_via` bo'lib ketadi
   * (mijoz DTO'sida emas — `POST /orders` uni bera olmaydi). Qolgan xulq
   * `opts` siz yo'l bilan bir xil.
   */
  private async createOrderInternal(
    dto: CreateOrderRequestDto,
    req: { user: JwtUser },
    opts?: {
      requestId?: string;
      /** Cp2v3ZJ7: barqaror kalit bilan mazmun imzosi (2-qatlam). */
      aiSignature?: string;
      /** vncdmXOy: activity_log CREATED metadata'siga AI belgisi. */
      aiAudit?: Record<string, unknown> | null;
      marketId?: string;
      /** VRyloH62: ai-confirm — partiya boshida olingan market profili. */
      marketProfile?: OrderMarketPhonePolicy | null;
      /** VRyloH62: ai-confirm — partiya boshida olingan so'rovchi ismi. */
      operatorName?: string | null;
      branchAssignment?: BranchAssignment | null;
      /** Celz3rKJ: yaratish kanali (hozir faqat bot). */
      createdVia?: 'bot';
    },
  ): Promise<unknown> {
    // IR2OHIiN: mahsulotsiz / tumansiz buyurtma — hech narsa (mijoz ham)
    // yaratilmasidan OLDIN 400. Bot va AI yo'llari DTO'ni ichkarida yig'adi.
    assertOrderCreateContent(dto);
    const {
      customer,
      update_customer_card: updateCustomerCardFlag,
      ...orderDto
    } = dto;
    const roles = this.normalizeRoles(req.user.roles);
    // txmkXVBa (ega qarori S5): «Mijoz kartasi ham yangilansinmi?» — faqat
    // qo'lda yaratish formasi (POST /orders) va ai-confirm. Bot yo'li (va
    // alohida handlerlardagi hamkor / tashqi import) avvalgidek: identity
    // telefon bo'yicha topilgan kartani yangilaydi (j70YS4zJ).
    const manualForm = opts?.createdVia !== 'bot';
    const updateCustomerCard = manualForm && updateCustomerCardFlag === true;
    const isSystemPrivileged =
      roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN);
    // fix3 RBAC-01: tayyor `customer_id` ni SUPERADMIN/ADMIN dan boshqasi
    // ixtiyoriy qabul qila olmaydi — market ketma-ket id yuborib boshqa
    // marketlar mijozlarining ism/telefon/manzilini o'z buyurtmasi orqali
    // o'qiy olardi. hiqRNhkI TC3 + WCuZzUCv: boshqa rollar ham
    // `GET /customers/suggest` tanlagan mijozni `customer_id` bilan yuboradi:
    // shu marketda buyurtmasi bor mijoz, yoki boshqa market mijozi — faqat
    // `customer.phone_number` kartaga to'liq mos kelsa. Pastda, market
    // aniqlangandan keyin (`resolveScopedCustomerId`).
    let customerId = isSystemPrivileged ? dto.customer_id : undefined;
    // fix3 C6: hayot sikli/saqlash maydonlari faqat SUPERADMIN/ADMIN dan.
    const safeOrderDto = isSystemPrivileged
      ? orderDto
      : this.omitFields(orderDto, [
          ...CREATE_LIFECYCLE_FIELDS,
          ...CREATE_PLACEMENT_FIELDS,
        ]);
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

    // VRyloH62: so'rovchi ismi (registrator/market operatori `operator`
    // maydonini bo'sh qoldirsa). `undefined` — hali olinmagan.
    let requesterName: string | null | undefined = opts?.operatorName;
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
        (
          operatorProfile as {
            data?: { market_id?: string | null; name?: string | null };
          }
        )?.data ?? null;
      resolvedMarketId =
        String(operatorData?.market_id ?? '').trim() || undefined;
      if (!resolvedMarketId) {
        throw new BadRequestException(
          "Operator hech qaysi marketga biriktirilmagan — buyurtma yaratib bo'lmaydi",
        );
      }
      requesterName = this.asStr(operatorData?.name).trim() || null;
    } else if (
      (roles.includes(RoleEnum.ADMIN) ||
        roles.includes(RoleEnum.SUPERADMIN) ||
        roles.includes(RoleEnum.REGISTRATOR)) &&
      !resolvedMarketId
    ) {
      throw new BadRequestException('market_id is required');
    }
    // UER0MpMX: mijoz yaratilishidan OLDIN — rad etilsa yetim mijoz qolmaydi.
    // ai-confirm (opts.marketId) marketni partiya boshida, mahsulot egaligini
    // esa o'z lookup'ida allaqachon tekshirgan — takrorlanmaydi.
    let marketProfile: OrderMarketPhonePolicy | null =
      opts?.marketProfile ?? null;
    if (!opts?.marketId) {
      marketProfile = await this.assertOrderMarket(resolvedMarketId, roles);
      await this.assertOrderProductsOwned(resolvedMarketId, dto.items ?? []);
    }
    // VRyloH62: operator raqamlari va ismi — mijoz yaratilishidan OLDIN
    // (raqam majburiy bo'lsa 400 yetim mijoz qoldirmaydi). Bot formasida
    // raqam maydoni yo'q — u yerda 400 berilmaydi (BeePost bot yo'li kabi).
    const operatorPhones = resolveOrderOperatorPhones({
      market: marketProfile,
      operatorPhone: dto.operator_phone,
      secondaryOperatorPhone: dto.secondary_operator_phone,
      strict: opts?.createdVia !== 'bot',
    });
    const filledOperatorName = await this.resolveCreateOperatorName(
      safeOrderDto.operator,
      roles,
      req.user,
      requesterName,
    );

    // txmkXVBa: mavjud kartaning shu marketda buyurtmasi bormi (customer_id
    // yo'lida doira tekshiruvidan ma'lum; telefon yo'lida — kerak bo'lsa
    // pastda so'raladi) va karta shu so'rovda YANGI yaratildimi.
    let customerInMarket: boolean | null = null;
    let customerCreatedNow = false;
    if (!isSystemPrivileged && this.hasCustomerIdValue(dto.customer_id)) {
      const scoped = await this.resolveScopedCustomerId(
        resolvedMarketId,
        dto.customer_id,
        customer,
      );
      if (scoped) {
        customerId = scoped.id;
        customerInMarket = scoped.inMarket;
      } else if (!customer) {
        // Tasdiqlanmagan id + mijoz obyekti yo'q — rad (RBAC-01 himoyasi).
        // Obyekt bo'lsa — avvalgidek telefon bo'yicha aniqlanadi.
        throw new ForbiddenException(
          "customer_id qabul qilinmadi: boshqa market mijozi uchun customer.phone_number mijoz telefoniga to'liq mos kelishi kerak (GET /customers/suggest taklifi). Yangi mijoz uchun customer obyekti (ism, telefon, tuman) yuboring",
        );
      }
    }

    if (!customerId) {
      if (!customer) {
        throw new BadRequestException(
          'customer_id yoki customer obyekt yuborilishi shart',
        );
      }

      const customerResponse = await firstValueFrom(
        this.identityClient
          .send(
            { cmd: 'identity.customer.create' },
            // txmkXVBa: qo'lda forma / ai-confirm — mavjud karta jimgina
            // yozilmaydi (yangilash faqat `update_customer_card: true` bilan,
            // buyurtmadan keyin `identity.customer.update`).
            manualForm
              ? { dto: customer, update_existing: false }
              : { dto: customer },
          )
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
      customerCreatedNow =
        Number((customerResponse as { statusCode?: unknown })?.statusCode) ===
        201;
    }
    const finalCustomerId = customerId;

    // txmkXVBa #3: market / market operatori umumiy kartani faqat o'z
    // marketida buyurtmasi bor mijoz uchun yangilay oladi (admin, HQ va
    // filial xodimlari — cheklovsiz). Buyurtma yaratilishidan OLDIN —
    // yaratilgach mijoz shu marketniki bo'lib qolardi.
    const marketSide =
      !isSystemPrivileged &&
      (roles.includes(RoleEnum.MARKET) ||
        roles.includes(RoleEnum.MARKET_OPERATOR));
    if (updateCustomerCard && !customerCreatedNow && marketSide) {
      const inMarket =
        customerInMarket ??
        (await this.customerHasOrdersInMarket(
          resolvedMarketId,
          String(finalCustomerId),
        ));
      if (!inMarket) {
        throw new ForbiddenException(
          "Mijoz kartasini yangilab bo'lmaydi: bu mijozning sizning marketingizda buyurtmasi yo'q (karta boshqa marketlar bilan umumiy). «Faqat shu buyurtmada» ni tanlang",
        );
      }
    }

    const createResponse: unknown = await firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.create' },
          {
            dto: {
              // VRyloH62: mijoz yuborgan raqamlar to'g'ridan-to'g'ri
              // yozilmaydi — faqat yuqorida hal qilingan qiymatlar.
              ...this.omitFields(safeOrderDto, [
                'operator_phone',
                'secondary_operator_phone',
              ]),
              ...(filledOperatorName ? { operator: filledOperatorName } : {}),
              ...(operatorPhones.operator_phone
                ? { operator_phone: operatorPhones.operator_phone }
                : {}),
              ...(operatorPhones.secondary_operator_phone
                ? {
                    secondary_operator_phone:
                      operatorPhones.secondary_operator_phone,
                  }
                : {}),
              market_id: resolvedMarketId,
              customer_id: finalCustomerId,
              // txmkXVBa: qo'lda forma — formadagi manzil va qo'shimcha raqam
              // buyurtmaning O'Z ustunlariga (karta yangilansa ham, yo'q ham).
              ...(manualForm
                ? {
                    address: orderDto.address ?? customer?.address ?? null,
                    extra_number: customer?.extra_number ?? null,
                  }
                : {}),
              // IR2OHIiN: tuman buyurtmaga DOIM yoziladi — o'zida bo'lmasa
              // inline mijozniki (bot, filial); mavjud mijozniki va viloyat —
              // order-service'da.
              district_id: orderCreateDistrictId(dto),
              operator_id:
                roles.includes(RoleEnum.REGISTRATOR) ||
                roles.includes(RoleEnum.MARKET_OPERATOR)
                  ? req.user.sub
                  : null,
              // Filial xodimi — o'z filiali; SUPERADMIN/ADMIN — so'raganicha;
              // qolganlar (market, operator) — null: order-service o'zi
              // aniqlaydi (HQ).
              branch_id: isBranchStaff
                ? assignedBranchId
                : isSystemPrivileged
                  ? (orderDto.branch_id ?? null)
                  : null,
              source: isBranchStaff
                ? 'branch'
                : isSystemPrivileged
                  ? orderDto.source
                  : undefined,
              // 6kHnNH9j: qo'lda va AI tasdiqlash — sukut `auto` (ombor yoki
              // HQ); bot yo'li — doim HQ (kontraktda yo'q).
              fulfillment:
                opts?.createdVia === 'bot'
                  ? 'hq'
                  : (orderDto.fulfillment ?? 'auto'),
            },
            requester: { id: req.user.sub, roles },
            // gpCIsGjH: DOIM — order-service `executeIdempotent` endi
            // chetlab o'tilmaydi (RMQ qayta yetkazishi dublikat yaratmaydi).
            request_id: opts?.requestId || randomUUID(),
            ...(opts?.aiSignature ? { ai_signature: opts.aiSignature } : {}),
            ...(opts?.aiAudit ? { ai_audit: opts.aiAudit } : {}),
            ...(opts?.createdVia ? { created_via: opts.createdVia } : {}),
          },
        )
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });

    if (!manualForm) {
      return createResponse;
    }
    const cardResult = updateCustomerCard
      ? await this.applyCustomerCardUpdate({
          createResponse,
          customerId: String(finalCustomerId),
          customer,
          marketId: resolvedMarketId,
          customerCreatedNow,
        })
      : { updated: false, changedFields: [] as string[] };
    // txmkXVBa #4: natija toast'i uchun.
    return createResponse && typeof createResponse === 'object'
      ? {
          ...(createResponse as Record<string, unknown>),
          customer_card_updated: cardResult.updated,
          customer_card_changed_fields: cardResult.changedFields,
        }
      : createResponse;
  }

  /**
   * txmkXVBa: mijozning SHU marketda (o'chirilmagan) buyurtmasi bormi
   * (`order.customer.market_summary`). Xato yuqoriga otiladi (fail-closed).
   */
  private async customerHasOrdersInMarket(
    marketId: string | undefined,
    customerId: string,
  ): Promise<boolean> {
    const market = String(marketId ?? '').trim();
    if (!/^\d+$/.test(market) || !/^\d+$/.test(customerId)) {
      return false;
    }
    const summary = await this.sendOrderWithTimeout(
      { cmd: 'order.customer.market_summary' },
      { market_id: market, customer_ids: [customerId] },
    );
    const items = (summary as { data?: { items?: unknown } } | null)?.data
      ?.items;
    return (
      Array.isArray(items) &&
      items.some(
        (item) =>
          this.asStr((item as { customer_id?: unknown })?.customer_id) ===
          customerId,
      )
    );
  }

  /**
   * txmkXVBa «Kartani ham yangilash»: buyurtma yaratilgandan KEYIN (activity
   * log'ga buyurtma id si yoziladi) formadagi maydonlar bilan
   * `identity.customer.update`. Yangi yaratilgan mijoz (karta formadan
   * olingan) va idempotent takror javob — chaqirilmaydi. Xato buyurtmani
   * bekor qilmaydi (u allaqachon yaratilgan) — `updated: false` va jurnal.
   */
  private async applyCustomerCardUpdate(input: {
    createResponse: unknown;
    customerId: string;
    customer: CreateOrderRequestDto['customer'];
    marketId: string | undefined;
    customerCreatedNow: boolean;
  }): Promise<{ updated: boolean; changedFields: string[] }> {
    const none = { updated: false, changedFields: [] as string[] };
    const body = (input.createResponse ?? {}) as {
      id?: unknown;
      data?: { id?: unknown } | null;
      idempotent_replay?: unknown;
    };
    const orderId = this.asStr(body.data?.id ?? body.id).trim();
    if (
      input.customerCreatedNow ||
      !input.customer ||
      !orderId ||
      body.idempotent_replay === true
    ) {
      return none;
    }
    try {
      const res = (await this.sendIdentityWithTimeout(
        { cmd: 'identity.customer.update' },
        {
          id: input.customerId,
          dto: {
            name: input.customer.name ?? null,
            district_id: input.customer.district_id ?? null,
            address: input.customer.address ?? null,
            extra_number: input.customer.extra_number ?? null,
          },
          order_id: orderId,
          market_id: input.marketId ?? null,
        },
      )) as { data?: { changed_fields?: unknown } } | null;
      const changed = Array.isArray(res?.data?.changed_fields)
        ? res.data.changed_fields.map((field) => this.asStr(field))
        : [];
      return { updated: changed.length > 0, changedFields: changed };
    } catch (error) {
      this.logger.warn(
        `identity.customer.update failed (order=${orderId}, customer=${input.customerId}): ${(error as Error)?.message ?? 'unknown'}`,
      );
      return none;
    }
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
    // fix3 LC-14: `status` YUBORILMAYDI — buyurtma sukutdagi NEW bo'ladi.
    // Ilgari CREATED edi va hech narsa uni NEW ga o'tkazmasdi: bot
    // buyurtmasi HQ "Yangi buyurtmalar" ekraniga hech qachon chiqmasdi.
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
      comment: dto.comment ?? null,
      operator: dto.operator ?? null,
      items: dto.order_item_info,
    };

    // Celz3rKJ: bot kanali belgisi (`created_via: 'bot'`) — "AI xarajat"
    // panelidagi buyurtma manbasida `bot` ulushi. Javob `POST /orders` bilan
    // AYNI rol proyeksiyasidan o'tadi.
    const response: unknown = await this.createOrderInternal(mappedDto, req, {
      createdVia: 'bot',
    });
    return projectOrderPayloadForRoles(req?.user?.roles, response);
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

    // vncdmXOy: AI taklifi audit izi uchun (fire-and-forget).
    this.attachAiDraftPreview(draftId, market.marketId, previews);
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
   * vncdmXOy #5: AI buyurtma AUDIT IZI — qaysi matndan (maskalangan,
   * `[TEL_n]`), qaysi model/prompt bilan, AI nimani taklif qildi (telefon
   * faqat maskalangan), operator nimani o'zgartirdi (server hisoblagan
   * `edited_fields`), kim tasdiqladi va xarajat (`ai_usage_log` JOIN).
   *
   * ⚠️ Faqat SUPERADMIN/ADMIN — matnda mijoz PII'si bor. Buyurtma AI'dan
   * yaratilmagan bo'lsa 404. Anthropic CHAQIRILMAYDI.
   */
  @Get(':id/ai-trace')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', example: '1024' })
  @ApiOperation({
    summary:
      'AI buyurtma audit izi: maskalangan matn, model, AI taklifi, edited_fields, xarajat',
  })
  async aiTrace(
    @Param('id') id: string,
  ): Promise<AiSuccessEnvelope<AiDraftTrace>> {
    const orderId = this.asStr(id).trim();
    if (!/^\d{1,19}$/.test(orderId)) {
      throw new BadRequestException("Buyurtma ID raqam bo'lishi kerak");
    }
    if (!this.aiClient) {
      throw new ServiceUnavailableException('AI servis ulanmagan');
    }
    let trace: AiDraftTrace | null;
    try {
      trace = await firstValueFrom(
        this.aiClient
          .send<AiDraftTrace | null>(
            { cmd: 'ai.draft.trace_by_order' },
            { order_id: orderId },
          )
          .pipe(timeout(AI_DRAFT_TRACE_TIMEOUT_MS)),
      );
    } catch (error: unknown) {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('AI service javob bermadi');
      }
      throw error;
    }
    if (!trace || typeof trace !== 'object') {
      throw new NotFoundException(
        'Bu buyurtma uchun AI audit izi topilmadi (AI orqali yaratilmagan)',
      );
    }
    return successRes(trace);
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
    // UER0MpMX: partiya uchun BIR MARTA — market mavjud, faol, add_order.
    // VRyloH62: shu javobdagi operator raqami sozlamasi ham partiyaga bir marta.
    // NFiXfmq6: ayni yozuvdan AI buyurtma narxi (qo'shimcha RPC yo'q).
    const marketProfile = await this.assertOrderMarket(marketId, roles);
    const aiPricePerOrder = this.aiPricePerOrderOf(marketProfile);
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
        stableRequestId: aiStableRequestId(
          marketId,
          order.draft_id,
          order.ai_item_index,
        ),
        aiAudit: null,
        editedFields: null,
      });
    });

    // vncdmXOy: audit metadata (model, prompt versiyasi, xarajat, server
    // hisoblagan edited_fields). ai-service ishlamasa ham yaratish TO'XTAMAYDI
    // — metadata faqat draft_id/ai_item_index bilan qoladi.
    await this.attachAiAudit(eligible, marketId);

    // 4) Yaratish — cheklangan parallellik, telefon bo'yicha yo'laklar.
    // VRyloH62: registrator/market operatori ismi — partiyaga BIR MARTA
    // (AI `operator` bermasa bandlarga yoziladi).
    const operatorName =
      roles.includes(RoleEnum.REGISTRATOR) ||
      roles.includes(RoleEnum.MARKET_OPERATOR)
        ? await this.loadRequesterName(req.user?.sub)
        : null;
    const ctx = {
      marketId,
      marketProfile,
      operatorName,
      includeMarketId: !roles.includes(RoleEnum.MARKET),
      branchAssignment,
      fulfillment: dto?.fulfillment,
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

    this.linkAiUsageOrders(
      orders,
      results,
      marketId,
      eligible,
      req.user?.sub,
      aiPricePerOrder,
    );

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
  // R6R8BLGA: qabul skaneri — filial bitta IP, yuqoriroq per-IP limit.
  @Throttle(SCAN_THROTTLE)
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
  // Yangi resurs yaratilmaydi — 201 emas, 200. Tana ichidagi `statusCode` ham
  // 200, ya'ni HTTP va tana bir xil signal beradi; natija `data.ok` da
  // (n9o0KYd5).
  @HttpCode(200)
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
    )
      .then((response: { data?: { ok?: boolean; partial?: boolean } }) => {
        // HTTP 200 "hech narsa qabul qilinmadi"ni ajratmaydi — alert uchun
        // `receive_by_scan_total{outcome}` (n9o0KYd5).
        recordReceiveByScanOutcome(response?.data);
        return response;
      })
      .catch((error: unknown) => {
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
    enum: [10, 25, 50, 100, 200],
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

    // PEc4BjVX: skan ekrani butun qopni bitta so'rovda oladi (limit=200);
    // umumiy ro'yxatlar 100 bilan chegaralangan qoladi.
    const pagination = this.parsePaginationQuery(
      page,
      limit,
      EXTERNAL_ALLOWED_LIMITS,
    );

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
      .then((response) =>
        // kH2zZsz3: market — kuryer tarifi/ulushi va filial ulushisiz.
        projectOrderPayloadForRoles(
          roles,
          this.withPaginationMeta(response, pagination),
        ),
      );
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
    // IR2OHIiN: `POST /orders` bilan AYNI qoida — mijoz yaratilishidan OLDIN.
    assertOrderCreateContent(dto);
    const { customer, external_id, ...rawOrderDto } = dto;
    const roles = this.normalizeRoles(req.user.roles);
    const isSystemPrivileged =
      roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN);
    // fix3 C6 / RBAC-01 — `createOrderInternal` bilan AYNI qoida: hayot sikli,
    // saqlash va joylashuv maydonlari hamda tayyor `customer_id` faqat
    // SUPERADMIN/ADMIN dan.
    const orderDto = isSystemPrivileged
      ? rawOrderDto
      : this.omitFields(rawOrderDto, [
          ...CREATE_LIFECYCLE_FIELDS,
          ...CREATE_PLACEMENT_FIELDS,
        ]);
    let customerId = isSystemPrivileged ? dto.customer_id : undefined;

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
    // UER0MpMX: mijoz yaratilishidan OLDIN — rad etilsa yetim mijoz qolmaydi.
    await this.assertOrderMarket(resolvedMarketId, roles);
    await this.assertOrderProductsOwned(resolvedMarketId, dto.items ?? []);

    if (!customerId) {
      if (!customer) {
        throw new BadRequestException(
          isSystemPrivileged || !dto.customer_id
            ? 'customer_id yoki customer obyekt yuborilishi shart'
            : "Mijoz ma'lumoti (customer: ism, telefon, tuman) yuborilishi shart — customer_id faqat admin uchun",
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
              // IR2OHIiN: tuman buyurtmaga yoziladi (inline mijozdan ham).
              district_id: orderCreateDistrictId(dto),
            },
            // fix3 C6: so'rovchi DOIM uzatiladi — order-service ham xuddi
            // shu qoidani o'zi qo'llaydi (himoya chuqurligi).
            requester: { id: req.user.sub, roles },
          },
        )
        .pipe(timeout(8000)),
    )
      .then((response: unknown) =>
        // kH2zZsz3 (tekshiruv #4): market — kuryer tarifi/ulushi va filial
        // ulushi kalitlarisiz (GET /orders/:id bilan AYNI proyeksiya).
        projectOrderPayloadForRoles(req?.user?.roles, response),
      )
      .catch((error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException('Order service response timeout');
        }
        throw error;
      });
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List orders with filters',
    description:
      CANCEL_RETURN_RESPONSE_DOC +
      '\n\n' +
      "4BftLLnc — LOGIST: faqat o'ziga biriktirilgan viloyatlar (regions.logist_id = me) buyurtmalari, pul maydonlarisiz " +
      '(total_price, sale_collectible_amount, paid_online_amount, extra_cost, tariflar, ulushlar). `region_id` faqat o‘z ' +
      "viloyatlaridan biri bo'lishi mumkin (boshqasi — 400). Viloyat biriktirilmagan logist — 200 va bo'sh ro'yxat.",
  })
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
      'FoCaUF10 (owner rule 2026-10-25). Visible order number "EL-N" (also "#EL-N", "№EL-N", "el N", ' +
      'case-insensitive) → ONLY order id = N − 100000, no customer search. Any other text → customer name, ' +
      'main phone AND extra phone (extra_number), plus order id when the text is a number (internal id; a ' +
      '6–8 digit number also as visible number N − 100000). ' +
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
  @ApiQuery({
    name: 'fulfillment_source',
    required: false,
    enum: FULFILLMENT_SOURCES,
    description:
      '6kHnNH9j: «Ombordan» — WAREHOUSE (viloyat ombori), HQ — hozirgi oqim. Javob qatorida `fulfillment_source` va `warehouse: { id, name, branch_id } | null`.',
  })
  @ApiQuery({
    name: 'cancelled_inventory',
    required: false,
    type: Boolean,
    description:
      "Bekor qilingan posilka INVENTARI rejimi (qo'ldagi, qaytarish pochtasiga biriktirilmagan; holder HQ/BRANCH). " +
      'Berilmasa: SA/admin uchun oddiy status filtri, filial xodimi/HQ registratori uchun inventar (onzwA7CQ).',
  })
  @ApiQuery({
    name: 'cancel_stage',
    required: false,
    type: String,
    description: CANCEL_STAGE_QUERY_DOC,
    example: 'branch,hq',
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
    @Query('cancelled_inventory') cancelled_inventory?: string,
    @Query('fulfillment_source') fulfillment_source?: string,
    @Query('cancel_stage') cancel_stage?: string | string[],
  ) {
    const request = await this.resolveOrderListRequest(
      {
        market_id,
        customer_id,
        status,
        search,
        start_day,
        end_day,
        courier,
        region_id,
        district_id,
        branch_id,
        courier_ids,
        fetch_all,
        source,
        courier_id,
        where_deliver,
        sort_by,
        sort_dir,
        cancelled_inventory,
        fulfillment_source,
        cancel_stage,
      },
      req?.user,
      page,
      limit,
    );
    const { roles, pagination } = request;

    if (request.kind === 'empty') {
      // 4BftLLnc: viloyat biriktirilmagan logist — 200, bo'sh ro'yxat.
      return {
        data: [],
        total: 0,
        page: pagination.page,
        limit: pagination.limit,
        ...this.buildPaginationMeta(0, pagination.page, pagination.limit),
      };
    }

    if (request.kind === 'courier_cancelled') {
      const { data, total } = await this.findCourierCancelledRows(
        req?.user,
        request.filters,
        pagination.page,
        pagination.limit,
      );
      const paginationMeta = this.buildPaginationMeta(
        total,
        pagination.page,
        pagination.limit,
      );

      // kH2zZsz3: kuryer ro'yxati — market tarifi/filial ulushisiz.
      return projectOrderPayloadForRoles(roles, {
        data,
        total,
        page: pagination.page,
        limit: pagination.limit,
        ...paginationMeta,
      });
    }

    const payload = {
      query: {
        ...request.query,
        page: pagination.page,
        limit: pagination.limit,
      },
    };

    return this.sendOrderWithFallback(
      { cmd: 'order.find_all_enriched' },
      { cmd: 'order.find_all' },
      payload,
    ).then((response) => {
      // kH2zZsz3: ro'yxat qatorlari ham detal bilan AYNI rol proyeksiyasida.
      return projectOrderPayloadForRoles(
        roles,
        this.withPaginationMeta(
          request.logistRegionIds
            ? this.keepLogistRegionRows(response, request.logistRegionIds)
            : response,
          pagination,
        ),
      );
    });
  }

  /**
   * 4BftLLnc — himoya qatlami: order-service `region_ids` filtrini bilmasa
   * (deploy tartibi) ham logistga o'z viloyatidan tashqari qator chiqmaydi.
   */
  private keepLogistRegionRows(
    response: unknown,
    regionIds: readonly string[],
  ): unknown {
    if (!response || typeof response !== 'object') {
      return response;
    }
    const body = response as Record<string, unknown>;
    const rows = Array.isArray(response)
      ? (response as unknown[])
      : Array.isArray(body.data)
        ? (body.data as unknown[])
        : null;
    if (!rows) {
      return response;
    }
    const kept = rows.filter((row) => isRowInLogistRegions(row, regionIds));
    if (kept.length === rows.length) {
      return response;
    }
    this.logger.warn(
      `GET /orders (logist): ${rows.length - kept.length} ta begona viloyat qatori olib tashlandi — order-service region_ids filtrini qo'llamadi`,
    );
    return Array.isArray(response) ? kept : { ...body, data: kept };
  }

  /**
   * xWsCAA5N: buyurtmalar ro'yxatining HAQIQIY .xlsx eksporti — BITTA HTTP
   * so'rov. Filtrlar va doira GET /orders bilan AYNAN bir xil
   * (`resolveOrderListRequest`); `page`/`limit`/`fetch_all` yo'q — filtrga
   * mos HAMMA qator (ORDER_EXPORT_MAX_ROWS gacha). Chegaradan oshsa
   * `X-Export-Truncated: true` + faylda "DIQQAT" qatori — jimgina kesilmaydi.
   * ⚠️ `@Get(':id')` dan OLDIN e'lon qilingan.
   */
  @Get('export/excel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.BRANCH,
    RoleEnum.MARKET,
    RoleEnum.MARKET_OPERATOR,
    RoleEnum.COURIER,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Buyurtmalar ro'yxatini .xlsx ga eksport (GET /orders filtrlari bilan, bitta so'rov)",
    description:
      'Javob: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet. ' +
      "Sarlavhalar: X-Export-Total (filtr bo'yicha jami), X-Export-Limit, " +
      'X-Export-Truncated (true — fayl chegaraga yetib kesilgan, faylda DIQQAT qatori bor). ' +
      "Oxirgi qatorlar: «Jami» (soni va narx yig'indisi).",
  })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({ name: 'customer_id', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: Order_status,
    isArray: true,
  })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'start_day', required: false, type: String })
  @ApiQuery({ name: 'end_day', required: false, type: String })
  @ApiQuery({ name: 'courier', required: false, type: String })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiQuery({ name: 'district_id', required: false, type: String })
  @ApiQuery({ name: 'branch_id', required: false, type: String })
  @ApiQuery({ name: 'courier_id', required: false, type: String })
  @ApiQuery({ name: 'where_deliver', required: false, enum: Where_deliver })
  @ApiQuery({
    name: 'sort_by',
    required: false,
    enum: ['created_at', 'total_price', 'status'],
  })
  @ApiQuery({ name: 'sort_dir', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'source',
    required: false,
    enum: ['internal', 'external', 'branch'],
  })
  @ApiQuery({ name: 'cancelled_inventory', required: false, type: Boolean })
  @ApiQuery({
    name: 'fulfillment_source',
    required: false,
    enum: FULFILLMENT_SOURCES,
  })
  @ApiQuery({
    name: 'cancel_stage',
    required: false,
    type: String,
    description: CANCEL_STAGE_QUERY_DOC,
    example: 'branch,hq',
  })
  async exportOrdersExcel(
    @Res() res: Response,
    @Req() req: { user: JwtUser },
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
    @Query('source') source?: string,
    @Query('courier_id') courier_id?: string,
    @Query('where_deliver') where_deliver?: string,
    @Query('sort_by') sort_by?: string,
    @Query('sort_dir') sort_dir?: string,
    @Query('cancelled_inventory') cancelled_inventory?: string,
    @Query('fulfillment_source') fulfillment_source?: string,
    @Query('cancel_stage') cancel_stage?: string | string[],
  ): Promise<void> {
    const request = await this.resolveOrderListRequest(
      {
        market_id,
        customer_id,
        status,
        search,
        start_day,
        end_day,
        courier,
        region_id,
        district_id,
        branch_id,
        courier_ids,
        source,
        courier_id,
        where_deliver,
        sort_by,
        sort_dir,
        cancelled_inventory,
        fulfillment_source,
        cancel_stage,
      },
      req?.user,
    );
    const { roles } = request;

    const fetchPage = async (page: number): Promise<OrderExportPage> => {
      if (request.kind === 'empty') {
        return { rows: [], total: 0 };
      }
      if (request.kind === 'courier_cancelled') {
        const { data, total } = await this.findCourierCancelledRows(
          req?.user,
          request.filters,
          page,
          100,
        );
        const projected = projectOrderPayloadForRoles(roles, { data });
        return { rows: projected.data, total };
      }
      // Ro'yxatdagi fallback (find_all, boyitishsiz) bu yerda ATAYLAB yo'q:
      // u market/mijoz/kuryer ustunlarini jimgina bo'sh qoldirardi.
      const response: unknown = await firstValueFrom(
        this.orderClient
          .send(
            { cmd: 'order.find_all_enriched' },
            {
              query: {
                ...request.query,
                fetch_all: undefined,
                page,
                limit: ORDER_EXPORT_PAGE_SIZE,
                max_limit: ORDER_EXPORT_PAGE_SIZE,
              },
            },
          )
          .pipe(timeout(ORDER_EXPORT_PAGE_TIMEOUT_MS)),
      ).catch((error: unknown) => {
        if (error instanceof TimeoutError) {
          throw new GatewayTimeoutException('Order service response timeout');
        }
        throw error;
      });
      const body =
        response && typeof response === 'object'
          ? (response as Record<string, unknown>)
          : {};
      const rows = this.extractRows(body).map((row) =>
        this.normalizeOrderStatusForDisplay(row),
      );
      const projected = projectOrderPayloadForRoles(roles, { data: rows });
      return {
        rows: projected.data,
        total: Number(body.total ?? rows.length) || 0,
        searchTruncated: body.search_truncated === true,
      };
    };

    const result = await streamOrdersXlsx(res, fetchPage);
    if (result.status === 'aborted') {
      this.logger.error(
        `Buyurtmalar eksporti uzildi: ${result.written}/${result.total} qator yozilgan`,
        result.error instanceof Error
          ? result.error.stack
          : String(result.error),
      );
    }
  }

  /**
   * xWsCAA5N: GET /orders va GET /orders/export/excel uchun BITTA doira
   * (rol, market/operator, filial, kuryer, bekor tab) — eksport ro'yxatda
   * ko'rinmaydigan buyurtmani hech qachon bermasin. Mantiq findAll dan
   * o'zgarishsiz ko'chirilgan (tartib ham: 403 → 400 → pagination).
   */
  private async resolveOrderListRequest(
    filters: OrderListFilters,
    user: JwtUser | undefined,
    page?: string,
    limit?: string,
  ): Promise<OrderListRequest> {
    const {
      market_id,
      customer_id,
      status,
      search,
      start_day,
      end_day,
      courier,
      region_id,
      district_id,
      branch_id,
      courier_ids,
      fetch_all,
      source,
      courier_id,
      where_deliver,
      sort_by,
      sort_dir,
      cancelled_inventory,
      fulfillment_source,
      cancel_stage,
    } = filters;
    // 6kHnNH9j: «Ombordan» filtri — noto'g'ri qiymat 400 (order-service'ga yetmaydi).
    const normalizedFulfillmentSource = fulfillment_source
      ? String(fulfillment_source).trim().toUpperCase()
      : undefined;
    if (
      normalizedFulfillmentSource &&
      !(FULFILLMENT_SOURCES as readonly string[]).includes(
        normalizedFulfillmentSource,
      )
    ) {
      throw new BadRequestException(
        `Noto'g'ri fulfillment_source qiymati: ${fulfillment_source} (HQ yoki WAREHOUSE)`,
      );
    }
    // LFNLeSpu (BG4): bekor bosqichi — noto'g'ri qiymat 400 (order-service'ga yetmaydi).
    const parsedCancelStages = parseCancelReturnStages(cancel_stage);
    if (parsedCancelStages.invalid.length) {
      throw new BadRequestException(
        `cancel_stage noto'g'ri: ${parsedCancelStages.invalid.join(', ')} (ruxsat: ${CANCEL_RETURN_STAGES.join(', ')})`,
      );
    }
    const cancelStages = parsedCancelStages.stages;
    const roles = user?.roles ?? [];
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
    const isCustomer =
      !isSystemPrivilegedRequester &&
      normalizedRoles.includes(RoleEnum.CUSTOMER);
    const isMarketOperator =
      !isSystemPrivilegedRequester &&
      !isMarket &&
      normalizedRoles.includes(RoleEnum.MARKET_OPERATOR);
    // 4BftLLnc (LG-S1/LG-S3): logist — faqat o'z viloyatlari (regions.logist_id
    // = me), faqat o'qish. Boshqa doirali rol bilan kelsa o'sha rol ustun.
    const isLogist = isLogistRequester(normalizedRoles);
    const requesterId = user?.sub;

    // fix3 C11 / CODE-04: OPERATOR, INVESTOR va noma'lum rollar uchun doira
    // yo'q edi — ular BARCHA buyurtmani mijoz ma'lumoti bilan o'qirdi.
    if (
      !isSystemPrivilegedRequester &&
      !isMarket &&
      !isCourier &&
      !isBranchScopedRequester &&
      !isCustomer &&
      !isMarketOperator &&
      !isLogist
    ) {
      throw new ForbiddenException(
        "Buyurtmalar ro'yxatini ko'rishga ruxsat yo'q",
      );
    }

    // 4BftLLnc: doira SERVERDA — `region_id` filtri faqat o'z to'plami ichida
    // (boshqa viloyat — 400). Logistics javob bermasa — 503 (fail-closed).
    let logistRegionIds: string[] | undefined;
    let logistRegionFilter: string | null = null;
    if (isLogist) {
      logistRegionIds = await this.logistRegionIds(user);
      logistRegionFilter = resolveLogistRegionFilter(
        region_id,
        logistRegionIds,
      );
    }

    if (
      isMarket &&
      market_id &&
      requesterId &&
      String(market_id) !== String(requesterId)
    ) {
      throw new BadRequestException('market role cannot query other market_id');
    }

    let resolvedMarketId = isMarket && requesterId ? requesterId : market_id;
    if (isMarketOperator && user) {
      // Operator — faqat o'zi biriktirilgan market (server tomonda).
      const operatorMarketId = await this.resolveMarketOperatorMarketId(user);
      if (!operatorMarketId) {
        throw new ForbiddenException(
          'Operator hech qaysi marketga biriktirilmagan',
        );
      }
      // WWbdu8ya TC3: boshqa marketni so'rash market roli bilan bir xil
      // ochiq 400 — jimgina o'z marketiga almashtirilmaydi.
      if (market_id && String(market_id) !== String(operatorMarketId)) {
        throw new BadRequestException(
          'market_operator role cannot query other market_id',
        );
      }
      resolvedMarketId = operatorMarketId;
    }
    // Mijoz — faqat o'z buyurtmalari.
    const resolvedCustomerId =
      isCustomer && requesterId ? String(requesterId) : customer_id;
    let resolvedBranchId = branch_id;
    let branchAssignment: BranchAssignment | null = null;

    if (isBranchScopedRequester && user) {
      branchAssignment = await this.resolveBranchAssignment(user);
      if (
        !this.isBranchStaffAssignment(branchAssignment) ||
        !branchAssignment?.branch_id
      ) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      resolvedBranchId = String(branchAssignment.branch_id);
    }

    const pagination = this.parsePaginationQuery(page, limit);
    if (logistRegionIds && !logistRegionIds.length) {
      // «Sizga hali viloyat biriktirilmagan» — 200 va bo'sh ro'yxat.
      return { kind: 'empty', roles, pagination };
    }
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
    const onlyCancelledStatuses =
      Boolean(statuses?.length) &&
      statuses!.every(
        (value) =>
          value === Order_status.CANCELLED ||
          value === Order_status.CANCELLED_SENT,
      );
    /**
     * onzwA7CQ: "bekor qilingan posilka INVENTARI" (qo'ldagi, qaytarish
     * pochtasiga biriktirilmagan, holder HQ/BRANCH) — alohida rejim. Ilgari u
     * oddiy `status=cancelled` filtriga JIMGINA ulanardi: superadmin
     * "Bekor qilingan" ni tanlasa 24 tadan 4 tasi chiqardi, `cancelled (sent)`
     * esa `cancelled` ga qayta yozilardi. Endi:
     *   - `cancelled_inventory=true|false` — aniq tanlov;
     *   - berilmasa: SA/admin uchun ODDIY filtr (hamma bekor qilinganlar),
     *     filial xodimi / HQ registratori uchun avvalgi inventar (ularning
     *     "Bekor" tabi shunga tayanadi; kuryer tabi alohida yo'l).
     */
    const explicitInventory =
      cancelled_inventory === undefined || cancelled_inventory === ''
        ? undefined
        : String(cancelled_inventory).toLowerCase() === 'true';
    // LFNLeSpu (BG4): `cancel_stage` berilsa bekor qismi AYNAN bosqich bilan
    // tanlanadi — inventar/kuryer-bekor tab rejimi yoqilmaydi (aks holda
    // `holder_type`/`canceled_post_unassigned` qotirmasi bosqich bilan AND
    // bo'lib, masalan `in_transit` doim bo'sh chiqardi). Rol doirasi (market,
    // operator, filial, kuryer, logist, mijoz) o'zgarishsiz qo'llanadi.
    const isCancelledTab =
      !cancelStages &&
      onlyCancelledStatuses &&
      (isCourier || (explicitInventory ?? !isSystemPrivilegedRequester));
    // fix3 C4: HQ registratori bekor qilinganlar tabida SA/admin bilan AYNI
    // ro'yxatni ko'radi (HQ qo'lidagi, filial filtrsiz) — aks holda doim bo'sh.
    const isHqRegistratorCancelledTab =
      isBranchScopedRequester &&
      isCancelledTab &&
      (await this.isHqRegistrator(normalizedRoles, branchAssignment));
    if (isHqRegistratorCancelledTab) {
      resolvedBranchId = undefined;
    }
    const isBranchCancelledTab =
      isBranchScopedRequester && isCancelledTab && !isHqRegistratorCancelledTab;
    const isHqCancelledTab =
      (isSystemPrivilegedRequester || isHqRegistratorCancelledTab) &&
      isCancelledTab;
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
      return {
        kind: 'courier_cancelled',
        roles,
        pagination,
        filters: {
          market_id: resolvedMarketId,
          customer_id,
          search,
          start_day,
          end_day,
          region_id,
          district_id,
          source,
        },
      };
    }

    return {
      kind: 'query',
      roles,
      pagination,
      query: {
        market_id: resolvedMarketId,
        customer_id: resolvedCustomerId,
        status: resolvedStatuses,
        where_deliver: normalizedWhereDeliver as Where_deliver | undefined,
        search,
        start_day,
        end_day,
        courier,
        courier_ids: resolvedCourierIds,
        fetch_all: useFetchAll || undefined,
        region_id: isLogist ? (logistRegionFilter ?? undefined) : region_id,
        // 4BftLLnc: logist doirasi (order-service: region_id IN (...)).
        ...(logistRegionIds ? { region_ids: logistRegionIds } : {}),
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
        ...(normalizedFulfillmentSource
          ? { fulfillment_source: normalizedFulfillmentSource }
          : {}),
        // LFNLeSpu (BG4): order-service `findAll` — `cancelReturnStageSql` (OR).
        ...(cancelStages ? { cancel_stages: cancelStages } : {}),
      },
      ...(logistRegionIds ? { logistRegionIds } : {}),
    };
  }

  // fix3 RBAC-03: ilgari faqat JwtAuthGuard — kuryer (va operator/mijoz/
  // investor) har marketning BARCHA buyurtmasini mijoz ma'lumoti bilan
  // varaqlay olardi. UI bu marshrutni ishlatmaydi; market — faqat o'zinikini.
  @Get('market/:marketId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MARKET)
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
    ).then((response) =>
      // kH2zZsz3: market — kuryer tarifi/ulushi va filial ulushisiz.
      projectOrderPayloadForRoles(
        req?.user?.roles,
        this.withPaginationMeta(response, pagination),
      ),
    );
  }

  /**
   * 0d11ewk7 — kuryer tablari badge'i: «Kutilayotgan» (waiting), «Hammasi»
   * (all), «Bekor qilingan» (cancelled) sonlari bitta so'rovda (BeePost
   * `courier/orders/counts` bilan bir xil shakl).
   *
   * Pochtalar ro'yxati GET /orders/courier/orders bilan AYNI yo'l
   * (findAllCourierPostIds), sanash esa order-service'da o'sha findAll
   * so'rovlari bilan — badge va ro'yxat `total`i bir-biridan farq qilmaydi.
   * Faqat COURIER: doira — JWT `sub`, query'dan id olinmaydi.
   */
  @Get('courier/orders/counts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Courier tab counts (waiting / all / cancelled)',
  })
  @ApiOkResponse({
    schema: {
      example: {
        statusCode: 200,
        message: 'Courier order counts',
        data: { waiting: 12, all: 340, cancelled: 3 },
      },
    },
  })
  async courierOrderCounts(@Req() req: { user: JwtUser }) {
    const courierId = String(req?.user?.sub ?? '').trim();
    const postIds = await this.findAllCourierPostIds(req?.user);
    const counts = (await this.sendOrderWithTimeout(
      { cmd: 'order.courier_counts' },
      { courier_id: courierId, post_ids: postIds },
    )) as Partial<Record<'waiting' | 'all' | 'cancelled', unknown>> | null;
    const toCount = (value: unknown) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
    };
    return successRes(
      {
        waiting: toCount(counts?.waiting),
        all: toCount(counts?.all),
        cancelled: toCount(counts?.cancelled),
      },
      200,
      'Courier order counts',
    );
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
      const { data, total } = await this.findCourierCancelledRows(
        req?.user,
        { search, start_day: startDate, end_day: endDate },
        pagination.page,
        pagination.limit,
      );
      const legacyData = this.toLegacyShape(data).map((row) =>
        this.normalizeLegacyOrderRow(row),
      );
      const paginationMeta = this.buildPaginationMeta(
        total,
        pagination.page,
        pagination.limit,
      );

      // kH2zZsz3: kuryerning bekor qilinganlar tabi — market tarifisiz.
      return projectOrderPayloadForRoles(
        req?.user?.roles,
        successRes(
          {
            data: legacyData,
            total,
            page: pagination.page,
            limit: pagination.limit,
            ...paginationMeta,
          },
          200,
          'All my orders',
        ),
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

    // kH2zZsz3: kuryer ro'yxati — market tarifi/filial ulushisiz.
    return projectOrderPayloadForRoles(
      req?.user?.roles,
      successRes(
        {
          data: legacyData,
          total,
          page: currentPage,
          limit: currentLimit,
          ...paginationMeta,
        },
        200,
        'All my orders',
      ),
    );
  }

  /**
   * CU4zfcds — market yangi/bekor ro'yxatlari filtrlari: bo'sh qiymat
   * yuborilmaydi (eski payload bilan AYNI qoladi).
   */
  private marketListFilters(
    search?: string,
    startDay?: string,
    endDay?: string,
  ): { search?: string; start_day?: string; end_day?: string } {
    const out: { search?: string; start_day?: string; end_day?: string } = {};
    if (typeof search === 'string' && search.trim()) {
      out.search = search.trim().slice(0, 100);
    }
    if (typeof startDay === 'string' && startDay.trim()) {
      out.start_day = startDay.trim();
    }
    if (typeof endDay === 'string' && endDay.trim()) {
      out.end_day = endDay.trim();
    }
    return out;
  }

  // fix3 RBAC-03 / CODE-04: ilgari faqat JwtAuthGuard — kuryer har marketning
  // NEW buyurtmalarini ko'rardi. Market esa BARCHA marketlar qatorini (market
  // profili bilan) olardi; endi faqat o'z qatorini.
  @Get('markets/new')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
    RoleEnum.BRANCH,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Markets with NEW orders' })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'CU4zfcds: market nomi yoki telefoni bo‘yicha (qism)',
  })
  @ApiQuery({
    name: 'start_day',
    required: false,
    type: String,
    description:
      'CU4zfcds: yaratilgan sana boshi (YYYY-MM-DD, Toshkent kuni; GET /orders bilan bir xil)',
  })
  @ApiQuery({
    name: 'end_day',
    required: false,
    type: String,
    description:
      'CU4zfcds: yaratilgan sana oxiri (YYYY-MM-DD, Toshkent kuni, kun oxirigacha)',
  })
  async findNewMarkets(
    @Req() req?: { user: JwtUser },
    @Query('search') search?: string,
    @Query('start_day') startDay?: string,
    @Query('end_day') endDay?: string,
  ) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    const ownMarketId =
      normalizedRoles.includes(RoleEnum.MARKET) &&
      !normalizedRoles.includes(RoleEnum.SUPERADMIN) &&
      !normalizedRoles.includes(RoleEnum.ADMIN)
        ? String(req?.user?.sub ?? '').trim()
        : null;
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

    const rawResult: unknown = await this.sendOrderWithFallback(
      { cmd: 'order.find_new_markets_enriched' },
      { cmd: 'order.find_new_markets' },
      {
        branch_id: resolvedBranchId,
        exclude_branch_source: excludeBranchSource,
        ...this.marketListFilters(search, startDay, endDay),
      },
    );
    const result =
      ownMarketId === null
        ? rawResult
        : this.filterRowsByMarket(rawResult, ownMarketId);

    if (!Array.isArray(result)) {
      return result;
    }

    return this.enrichMarketRows(result as Array<Record<string, any>>);
  }

  /**
   * Faqat `marketId` qatorlari. Massiv yoki `{data: []}` shakli; tanilmagan
   * shakl — bo'sh massiv (fail-closed: boshqa market qatori sizmasin).
   */
  private filterRowsByMarket(payload: unknown, marketId: string): unknown {
    const keep = (row: unknown) =>
      Boolean(marketId) &&
      this.asStr(
        (row as Record<string, unknown> | null)?.market_id ??
          (row as Record<string, unknown> | null)?.marketId,
      ).trim() === marketId;
    if (Array.isArray(payload)) {
      return payload.filter(keep);
    }
    const body = payload as { data?: unknown } | null;
    if (body && typeof body === 'object' && Array.isArray(body.data)) {
      return { ...body, data: body.data.filter(keep) };
    }
    return [];
  }

  /**
   * BEKOR QILISH SABABLARI STATISTIKASI (PUvKXWVw).
   *
   * Market faqat o'z buyurtmalarini, filial xodimi faqat o'z filialini
   * ko'radi — doira so'rov parametridan EMAS, tokendan olinadi.
   */
  @Get('cancel-reasons/stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Bekor qilish sabablari kesimida statistika',
    description:
      "by_reason — yopiq ro'yxatning HAR sababi ({reason, label, count}, 0 bo'lsa ham; sababi qayd etilmagan eski bekorlar — UNKNOWN); " +
      'group_by berilsa rows — sabab × market/hudud/kuryer. Sana oynasi asl bekor qilish vaqtiga, TOSHKENT kuni bo`yicha ' +
      "(YYYY-MM-DD → 00:00–23:59:59 +05:00) qo'llanadi; javobda applied_range. Rollback qilib sotilgan, qaytarish so'rovi bilan " +
      'marketga qaytgan (bekor qilinmagan) buyurtmalar sanalmaydi; marketga topshirilgan bekorlar (RETURNED_TO_MARKET / CLOSED) sanaladi.',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'YYYY-MM-DD (Toshkent kuni boshi), ISO vaqt yoki epoch ms',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description:
      'YYYY-MM-DD (Toshkent kuni oxiri — kun o`zi kiradi), ISO vaqt yoki epoch ms',
  })
  @ApiQuery({ name: 'market_id', required: false, type: String })
  @ApiQuery({ name: 'branch_id', required: false, type: String })
  @ApiQuery({
    name: 'group_by',
    required: false,
    enum: ['market', 'region', 'courier'],
  })
  async cancelReasonStats(
    @Req() req: { user: JwtUser },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('market_id') marketIdQuery?: string,
    @Query('branch_id') branchIdQuery?: string,
    @Query('group_by') groupBy?: string,
  ) {
    const roles = this.normalizeRoles(req?.user?.roles ?? []);
    let marketId = marketIdQuery?.trim() || undefined;
    let branchId = branchIdQuery?.trim() || undefined;
    if (roles.includes(RoleEnum.MARKET)) {
      marketId = String(req.user.sub);
    } else if (
      roles.includes(RoleEnum.MANAGER) &&
      !roles.includes(RoleEnum.SUPERADMIN) &&
      !roles.includes(RoleEnum.ADMIN)
    ) {
      const assignment = await this.resolveBranchAssignment(req.user);
      if (!this.isBranchStaffAssignment(assignment) || !assignment?.branch_id) {
        throw new BadRequestException('Branch user branchga biriktirilmagan');
      }
      branchId = String(assignment.branch_id);
    }
    return this.sendOrderWithTimeout(
      { cmd: 'order.analytics.cancel_reasons' },
      {
        startDate,
        endDate,
        market_id: marketId,
        branch_id: branchId,
        group_by: groupBy?.trim() || undefined,
      },
    );
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
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'CU4zfcds: market nomi yoki telefoni bo‘yicha (qism)',
  })
  @ApiQuery({
    name: 'start_day',
    required: false,
    type: String,
    description:
      'CU4zfcds: yaratilgan sana boshi (YYYY-MM-DD, Toshkent kuni; GET /orders bilan bir xil)',
  })
  @ApiQuery({
    name: 'end_day',
    required: false,
    type: String,
    description:
      'CU4zfcds: yaratilgan sana oxiri (YYYY-MM-DD, Toshkent kuni, kun oxirigacha)',
  })
  async findCancelledMarkets(
    @Req() req?: { user: JwtUser },
    @Query('search') search?: string,
    @Query('start_day') startDay?: string,
    @Query('end_day') endDay?: string,
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
      // fix3 C4: HQ registratori — SA/admin bilan AYNI (HQ qo'lidagilar).
      if (!(await this.isHqRegistrator(normalizedRoles, assignment))) {
        branchId = String(assignment.branch_id);
        holderType = 'BRANCH';
      }
      excludeBranchSource = false;
    }

    return this.sendOrderWithTimeout(
      { cmd: 'order.find_cancelled_markets_enriched' },
      {
        market_id: marketId,
        branch_id: branchId,
        holder_type: holderType,
        exclude_branch_source: excludeBranchSource,
        ...this.marketListFilters(search, startDay, endDay),
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

  // fix3 RBAC-03 / CODE-04: kuryer, operator, mijoz va investor endi kira
  // olmaydi (ilgari har marketning NEW buyurtmalarini mijoz PII bilan olardi).
  // (nCAFnqIe) MARKET_OPERATOR — faqat o'zi biriktirilgan market (identity
  // `user.market_id`); boshqa market id si yoki biriktirilmagan — 403.
  @Get('markets/:marketId/new')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
    RoleEnum.BRANCH,
    RoleEnum.MARKET,
    RoleEnum.MARKET_OPERATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'NEW orders by market id',
    description:
      "(nCAFnqIe) MARKET_OPERATOR — faqat o'zi biriktirilgan market (`:marketId` = operator marketi); " +
      'boshqa market yoki marketga biriktirilmagan operator — 403. Javob market roli bilan bir xil ' +
      "(kuryer tarifi/ulushi va filial ulushisiz, `source='branch'` buyurtmalarsiz).",
  })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'CU4zfcds: mijoz ismi/telefoni yoki «EL-…» buyurtma raqami (GET /orders bilan bir xil)',
  })
  @ApiQuery({
    name: 'start_day',
    required: false,
    type: String,
    description:
      'CU4zfcds: yaratilgan sana boshi (YYYY-MM-DD, Toshkent kuni; GET /orders bilan bir xil)',
  })
  @ApiQuery({
    name: 'end_day',
    required: false,
    type: String,
    description:
      'CU4zfcds: yaratilgan sana oxiri (YYYY-MM-DD, Toshkent kuni, kun oxirigacha)',
  })
  async findNewOrdersByMarket(
    @Param('marketId') marketId: string,
    @Req() req?: { user: JwtUser },
    @Query('search') search?: string,
    @Query('start_day') startDay?: string,
    @Query('end_day') endDay?: string,
  ) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    if (
      normalizedRoles.includes(RoleEnum.MARKET) &&
      String(req?.user?.sub ?? '') !== String(marketId)
    ) {
      throw new ForbiddenException('market role cannot query other market_id');
    }
    if (
      normalizedRoles.includes(RoleEnum.MARKET_OPERATOR) &&
      !normalizedRoles.includes(RoleEnum.MARKET) &&
      !normalizedRoles.includes(RoleEnum.SUPERADMIN) &&
      !normalizedRoles.includes(RoleEnum.ADMIN)
    ) {
      // (nCAFnqIe) operator marketi SERVER tomonda aniqlanadi.
      const operatorMarketId = await this.resolveMarketOperatorMarketId(
        req?.user as JwtUser,
      );
      if (!operatorMarketId) {
        throw new ForbiddenException(
          'Operator hech qaysi marketga biriktirilmagan',
        );
      }
      if (operatorMarketId !== String(marketId ?? '').trim()) {
        throw new ForbiddenException(
          'market_operator role cannot query other market_id',
        );
      }
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
      ...this.marketListFilters(search, startDay, endDay),
    };

    const response: unknown = await this.sendOrderWithFallback(
      { cmd: 'order.find_new_by_market_enriched' },
      { cmd: 'order.find_new_by_market' },
      payload,
    );
    // kH2zZsz3: market — kuryer tarifi/ulushi va filial ulushisiz.
    return projectOrderPayloadForRoles(roles, response);
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
  @ApiOperation({
    summary: 'CANCELLED orders by market id',
    description:
      'Default (no `stage`): cancelled orders ready for handover — HQ-held (SA/admin, HQ registrator, market) or held ' +
      "by the requester's branch (branch staff). " +
      "M0EPcJVf (BG3): MARKET role may pass `stage` to see ALL stages of its own cancellations (tabs «HQ'da», " +
      "«Yo'lda», «Olganlarim»): any of `courier,in_transit,branch,hq,market` (comma list). With `stage`, HQ/branch " +
      'pinning is dropped (still only this market). `start_day`/`end_day` (YYYY-MM-DD, Tashkent day) filter ONLY the ' +
      '`market` stage by handover time (`market_handover_at`, legacy: `last_handover_at`). Unknown stage — 400. ' +
      'For other roles `stage`/`start_day`/`end_day` are ignored (handover list unchanged). Rows carry `return_stage` ' +
      'and `cancel_return` (see GET /orders). Response `{ data, total, truncated? }` (max 5000 rows).',
  })
  @ApiParam({ name: 'marketId', description: 'Market ID (id)' })
  @ApiQuery({
    name: 'stage',
    required: false,
    type: String,
    description: `MARKET role only. Comma list of: ${CANCEL_RETURN_STAGES.join(', ')}`,
  })
  @ApiQuery({
    name: 'start_day',
    required: false,
    type: String,
    description: 'MARKET + stage=market: handover date from (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'end_day',
    required: false,
    type: String,
    description: 'MARKET + stage=market: handover date to (YYYY-MM-DD)',
  })
  async findCancelledOrdersByMarket(
    @Param('marketId') marketId: string,
    @Req() req?: { user: JwtUser },
    @Query('stage') stage?: string | string[],
    @Query('start_day') start_day?: string,
    @Query('end_day') end_day?: string,
  ) {
    const roles = req?.user?.roles ?? [];
    const normalizedRoles = this.normalizeRoles(roles);
    const isMarket = normalizedRoles.includes(RoleEnum.MARKET);
    const parsedStages = parseCancelReturnStages(stage);
    if (parsedStages.invalid.length) {
      throw new BadRequestException(
        `stage noto'g'ri: ${parsedStages.invalid.join(', ')} (ruxsat: ${CANCEL_RETURN_STAGES.join(', ')})`,
      );
    }
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
      // fix3 C4: HQ registratori — SA/admin bilan AYNI (HQ qo'lidagilar).
      if (!(await this.isHqRegistrator(normalizedRoles, assignment))) {
        branchId = String(assignment.branch_id);
        holderType = 'BRANCH';
      }
      excludeBranchSource = false;
    }

    // M0EPcJVf (BG3): market o'z bekorlarining HAMMA bosqichini ko'radi —
    // `stage` berilsa HQ qotirmasi olinadi (doira baribir faqat o'z marketi,
    // yuqorida tekshirildi). Boshqa rollar uchun topshirish ro'yxati o'zgarmaydi.
    const marketStages = isMarket ? parsedStages.stages : null;
    const response: unknown = await this.sendOrderWithTimeout(
      { cmd: 'order.find_cancelled_by_market_enriched' },
      {
        market_id: marketId,
        branch_id: marketStages ? undefined : branchId,
        holder_type: marketStages ? undefined : holderType,
        exclude_branch_source: excludeBranchSource,
        ...(marketStages
          ? {
              stages: marketStages,
              start_day: start_day?.trim() || undefined,
              end_day: end_day?.trim() || undefined,
            }
          : {}),
      },
    );
    // kH2zZsz3: market — kuryer tarifi/ulushi va filial ulushisiz.
    return projectOrderPayloadForRoles(roles, response);
  }

  @Post('markets/:marketId/cancelled/qr')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Market canceled order handover uchun 2 daqiqalik QR olish',
    description:
      "Javob: `{ market_id, qr_token: 'MCR-…', qr_expires_at, qr_ttl_seconds: 120, pin: '042917', pin_expires_at, pin_max_attempts: 5 }`. " +
      'zkRab9M2 (BG6): `pin` — QR yonida ko‘rsatiladigan 6 xonali kod; xodim QR o‘rniga uni `POST /scan/market-cancelled { market_id, pin }` bilan yozadi. ' +
      'Bazada faqat xeshi; muddat QR bilan bir xil. Yangi QR eski QR va kodni yaroqsiz qiladi.',
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
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
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

  /**
   * (lQjt6sKP) ALMASHTIRISH (kafolat-swap) — buyurtma yaratish formasida
   * eski (YETKAZILGAN) buyurtmani tanlash. Market — faqat o'z buyurtmalari;
   * boshqa yaratuvchi rollar `market_id` beradi (POST /orders bilan AYNI
   * doira). `q`: 1–6 raqam — buyurtma ID; telefon — shu marketdagi mijoz;
   * boshqa matn — izoh yoki mahsulot nomi.
   * ⚠️ `@Get(':id')` dan OLDIN e'lon qilingan.
   */
  @Get('replaceable')
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
  @ApiOperation({
    summary: 'Almashtirishga tanlanadigan (yetkazilgan) buyurtmalar',
    description:
      "Yangi buyurtmani shu ro'yxatdagi eski buyurtma o'rniga yaratish uchun (`POST /orders` → `replaced_order_id`). " +
      'Faqat sold/paid/partly_paid va hali almashtirilmagan buyurtmalar. Har qatorda mijoz, mahsulotlar, narx, izoh.',
  })
  @ApiQuery({ name: 'market_id', required: false, example: '3' })
  @ApiQuery({ name: 'customer_id', required: false, example: '120' })
  @ApiQuery({ name: 'q', required: false, example: '901234567' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  async listReplaceableOrders(
    @Query('market_id') marketIdRaw: string | undefined,
    @Query('customer_id') customerIdRaw: string | undefined,
    @Query('q') qRaw: string | undefined,
    @Query('page') page: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: { user: JwtUser },
  ) {
    const roles = this.normalizeRoles(req.user.roles);
    const marketId = roles.includes(RoleEnum.MARKET)
      ? String(req.user.sub)
      : String(marketIdRaw ?? '').trim();
    if (!/^\d{1,18}$/.test(marketId)) {
      throw new BadRequestException(
        'market_id majburiy — almashtirish faqat shu market buyurtmalari ichidan',
      );
    }
    const customerId = String(customerIdRaw ?? '').trim();
    if (customerId && !/^\d{1,18}$/.test(customerId)) {
      throw new BadRequestException("customer_id noto'g'ri");
    }
    const q = typeof qRaw === 'string' ? qRaw.trim().slice(0, 100) : '';
    let customerIds: string[] | undefined;
    let textQuery: string | undefined = q || undefined;
    if (q && !/^\d{1,6}$/.test(q) && parseUzPhoneSearch(q)) {
      // Telefon — mijozni identity'dan topib, shu market buyurtmalarida
      // (order-service `market_id` filtri) qidiramiz.
      const found = (await this.sendIdentityWithTimeout(
        { cmd: 'identity.customer.search' },
        { search: q, limit: 50 },
      )) as { data?: Array<{ id?: unknown }> } | null;
      customerIds = (Array.isArray(found?.data) ? found.data : [])
        .map((row) => replacementIdText(row?.id))
        .filter((id) => /^\d{1,18}$/.test(id));
      textQuery = undefined;
    }
    const response = (await this.sendOrderWithTimeout(
      { cmd: 'order.replaceable' },
      {
        market_id: marketId,
        ...(customerId ? { customer_id: customerId } : {}),
        ...(customerIds ? { customer_ids: customerIds } : {}),
        ...(textQuery ? { q: textQuery } : {}),
        page: Number(page) || 1,
        limit: Number(limit) || 20,
      },
    )) as {
      data?: { items?: Array<Record<string, unknown>> };
    } | null;
    return this.attachReplacementCustomers(response);
  }

  /**
   * (lQjt6sKP) Almashtirishga tanlangan ESKI buyurtmalar — mahsuloti
   * mijozdan qaytarib olinadi. `state`: awaiting_old_pickup | old_collected |
   * old_returned. Market — faqat o'zinikilar.
   * ⚠️ `@Get(':id')` dan OLDIN e'lon qilingan.
   */
  @Get('replacement/returns')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Almashtirish qaytarmalari (eski mahsulot qaytariladigan buyurtmalar)',
  })
  @ApiQuery({ name: 'market_id', required: false, example: '3' })
  @ApiQuery({
    name: 'state',
    required: false,
    enum: ['awaiting_old_pickup', 'old_collected', 'old_returned'],
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  async listReplacementReturns(
    @Query('market_id') marketIdRaw: string | undefined,
    @Query('state') state: string | undefined,
    @Query('page') page: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: { user: JwtUser },
  ) {
    const roles = this.normalizeRoles(req.user.roles);
    const marketId = roles.includes(RoleEnum.MARKET)
      ? String(req.user.sub)
      : String(marketIdRaw ?? '').trim();
    if (marketId && !/^\d{1,18}$/.test(marketId)) {
      throw new BadRequestException("market_id noto'g'ri");
    }
    const response = (await this.sendOrderWithTimeout(
      { cmd: 'order.replacement.returns' },
      {
        ...(marketId ? { market_id: marketId } : {}),
        ...(state ? { state } : {}),
        page: Number(page) || 1,
        limit: Number(limit) || 20,
      },
    )) as {
      data?: { items?: Array<Record<string, unknown>> };
    } | null;
    return this.attachReplacementCustomers(response);
  }

  /** (lQjt6sKP) Qatorlarga mijoz ismi/telefoni (identity, bitta so'rov). */
  private async attachReplacementCustomers<
    T extends { data?: { items?: Array<Record<string, unknown>> } } | null,
  >(response: T): Promise<T> {
    const items = response?.data?.items;
    if (!Array.isArray(items) || !items.length) return response;
    const ids = [
      ...new Set(
        items
          .map((row) => replacementIdText(row.customer_id))
          .filter((id) => /^\d{1,18}$/.test(id)),
      ),
    ];
    if (!ids.length) return response;
    const customers = (await this.sendIdentityWithTimeout(
      { cmd: 'identity.customer.find_by_ids' },
      { ids },
    ).catch(() => null)) as {
      data?: Array<{
        id?: unknown;
        name?: string | null;
        phone_number?: string | null;
      }>;
    } | null;
    const byId = new Map(
      (Array.isArray(customers?.data) ? customers.data : []).map((c) => [
        replacementIdText(c?.id),
        { name: c?.name ?? null, phone_number: c?.phone_number ?? null },
      ]),
    );
    for (const row of items) {
      const customerId = replacementIdText(row.customer_id);
      const c = byId.get(customerId);
      row.customer = c
        ? { id: customerId, ...c }
        : { id: customerId, name: null, phone_number: null };
    }
    return response;
  }

  /**
   * ⚠️ `@Get(':id')` dan OLDIN (PINtZcLj): Nest/Express marshrutni e'lon
   * tartibida moslaydi — ilgari `GET /orders/extra-cost-approvals`
   * buyurtma-ID handleriga tushib 400 ("ID qiymatlari raqam ko'rinishida
   * bo'lishi kerak") qaytarardi: market kuryerning qo'shimcha xarajat
   * so'rovini hech qachon ko'rmas, buyurtma 202 holatida muzlab qolardi.
   */
  @Get('extra-cost-approvals')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.MARKET,
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    // (6QLF7nst) faqat O'QISH: o'zi biriktirilgan market so'rovlari.
    // Tasdiqlash/rad etish (`:id/approve|reject`) operatorga YOPIQ.
    RoleEnum.MARKET_OPERATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List extra cost approval requests',
    description:
      '(0Ngp09FG) Har bir so\'rovda `order_number` ("EL-…", mijozga ko\'rinadigan raqam) va ' +
      "`requested_by: { id, name }` (so'rovchi ismi; identity javob bermasa `name: null`). " +
      'Eski maydonlar (`order_id`, `requested_by_user_id`, `requested_by_role`) o`zgarmagan. ' +
      "(6QLF7nst) MARKET_OPERATOR — faqat o'qish, faqat o'zi biriktirilgan market so'rovlari " +
      "(marketga biriktirilmagan bo'lsa 403); approve/reject operatorga 403.",
  })
  @ApiQuery({
    name: 'status',
    required: false,
    example: 'pending',
    enum: ['pending', 'approved', 'rejected'],
  })
  @ApiQuery({
    name: 'auto_approved',
    required: false,
    example: 'true',
    description:
      "(1tnpaIqd) true — faqat muddat o'tib AVTOMATIK tasdiqlanganlar (e'tiroz/rollback uchun alohida filtr)",
  })
  async listExtraCostApprovals(
    @Query('status') status: string | undefined,
    @Req() req: { user: JwtUser },
    @Query('auto_approved') autoApproved?: string,
  ) {
    const roles = this.normalizeRoles(req.user.roles);
    // (6QLF7nst) operator marketi SERVER tomonda (identity `user.market_id`),
    // so'rovdan olinmaydi. Market/SA/admin uchun o'zgarishsiz.
    let operatorMarketId: string | undefined;
    if (
      roles.includes(RoleEnum.MARKET_OPERATOR) &&
      !roles.includes(RoleEnum.MARKET) &&
      !roles.includes(RoleEnum.SUPERADMIN) &&
      !roles.includes(RoleEnum.ADMIN)
    ) {
      operatorMarketId = await this.resolveMarketOperatorMarketId(req.user);
      if (!operatorMarketId) {
        throw new ForbiddenException(
          'Operator hech qaysi marketga biriktirilmagan',
        );
      }
    }
    const response: unknown = await this.sendOrderWithTimeout(
      { cmd: 'order.extra_cost_approval.list' },
      {
        status,
        auto_approved:
          autoApproved === 'true'
            ? true
            : autoApproved === 'false'
              ? false
              : undefined,
        requester: {
          id: req.user.sub,
          roles,
          ...(operatorMarketId ? { market_id: operatorMarketId } : {}),
        },
      },
    );
    return response;
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get order by ID',
    description:
      CANCEL_RETURN_RESPONSE_DOC +
      '\n\n' +
      "4BftLLnc — LOGIST: buyurtma o'z viloyatida bo'lsa (aks holda 403), pul maydonlarisiz.",
  })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  async findById(@Param('id') id: string, @Req() req?: { user: JwtUser }) {
    const response = await this.sendOrderWithFallback(
      { cmd: 'order.find_by_id_enriched' },
      { cmd: 'order.find_by_id' },
      { id },
    );
    await this.assertCanViewOrder(req?.user, this.unwrapOrderRow(response));
    // kH2zZsz3: kuryer — market tarifi/filial ulushisiz, market — kuryer
    // tarifi/ulushi va filial ulushisiz (auth/order-role-projection).
    return projectOrderPayloadForRoles(req?.user?.roles, response);
  }

  @Get('qr-code/:token')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ORDER_QR_LOOKUP_ROLES)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order by QR code (Post Control style)' })
  @ApiParam({ name: 'token', description: 'Order QR token' })
  @ApiQuery({
    name: 'view',
    required: false,
    enum: ['light'],
    description:
      "D148eHMA: `light` — skaner uchun yengil javob (faqat skaner ekrani maydonlari). Berilmasa — to'liq buyurtma (o'zgarmagan).",
  })
  async findByQrCode(
    @Param('token') token: string,
    @Req() req?: { user: JwtUser },
    @Query('view') view?: string,
  ) {
    // D148eHMA — `?view=light` OPT-IN: parametrsiz so'rov AYNAN avvalgidek.
    const response: unknown = isOrderQrLightView(view)
      ? await sendOrderQrLight(
          (pattern) => this.sendOrderWithTimeout(pattern, { token }),
          { cmd: 'order.find_by_qr_enriched' },
        )
      : await this.sendOrderWithFallback(
          { cmd: 'order.find_by_qr_enriched' },
          { cmd: 'order.find_by_qr' },
          { token },
        );
    // fix3 C11 (CODE-04): market faqat o'z posilkasini (auth/order-qr-visibility).
    assertQrOrderVisible(
      req?.user,
      (response as { data?: unknown } | null)?.data,
    );
    // kH2zZsz3: QR orqali ham AYNI rol proyeksiyasi (detal bilan bir xil).
    return projectOrderPayloadForRoles(req?.user?.roles, response);
  }

  @Post('scan-assign')
  // R6R8BLGA: kuryer skaneri — filial bitta IP, yuqoriroq per-IP limit.
  @Throttle(SCAN_THROTTLE)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Scan QR and assign order to current courier. MWYaqprw: muvaffaqiyatli javobda `data.order` — { id, order_number, status, total_price, address, district, region, market, customer: { name, phone_number } } (skaner ekrani uchun; olinmasa maydon bo'lmaydi, skan baribir o'tgan).",
  })
  @ApiBody({ type: ScanAssignOrderRequestDto })
  async scanAssignOrder(
    @Body() dto: ScanAssignOrderRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    const response: unknown = await this.sendLogisticsWithTimeout(
      { cmd: 'logistics.order.scan_assign' },
      {
        dto,
        requester: {
          id: req.user.sub,
          roles: this.normalizeRoles(req.user.roles),
        },
      },
    );
    return this.withScanOrderSummary(response, dto.qr_token);
  }

  /**
   * (MWYaqprw #5) Skan muvaffaqiyatli bo'lsa javobga tuman/mijoz qo'shiladi
   * (`order.find_by_qr_light`). Bu FAQAT qo'shimcha: qidiruv yiqilsa yoki
   * kechiksa skan javobi o'zgarishsiz qaytadi — biriktirish allaqachon bo'lgan.
   */
  private async withScanOrderSummary(
    response: unknown,
    qrToken: unknown,
  ): Promise<unknown> {
    const envelope = response as { data?: unknown } | null;
    const data = envelope?.data;
    const token = typeof qrToken === 'string' ? qrToken.trim() : '';
    if (!token || !data || typeof data !== 'object' || Array.isArray(data)) {
      return response;
    }
    try {
      const light = await sendOrderQrLight(
        (pattern) => this.sendOrderWithTimeout(pattern, { token }),
        { cmd: 'order.find_by_qr_enriched' },
      );
      const order = scanOrderSummary(light);
      return order ? { ...envelope, data: { ...data, order } } : response;
    } catch (error) {
      this.logger.warn(
        `scan-assign: buyurtma xulosasi olinmadi — ${error instanceof Error ? error.message : String(error)}`,
      );
      return response;
    }
  }

  @Post('assign-to-courier')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    // (1gxmqLj5, (a) yo'l) SA/admin — istalgan filial posilkalarini o'sha
    // filial kuryeriga (doira logistics-service'da buyurtmalardan olinadi).
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Manager bulk-assign orders to one courier',
    description:
      "(1gxmqLj5) SUPERADMIN/ADMIN ham biriktiradi: barcha orderlar BITTA filialda bo'lishi, kuryer shu filialning " +
      "COURIER a'zosi bo'lishi shart (aks holda 400). `branch_id` (ixtiyoriy) — UI'dagi filial tanlovi: berilsa " +
      "orderlar filialiga mos bo'lishi kerak (400). Menejer/registrator uchun o'zgarishsiz (o'z filiali, `branch_id` e'tiborsiz).",
  })
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
    // Ho5qcDn4 TC9: market — faqat o'z buyurtmasi (assertCanViewOrderTracking),
    // xodim `actor` i qisqartirilgan (projectOrderTrackingForRoles).
    RoleEnum.MARKET,
    // 4BftLLnc (LG-S1): logist — faqat o'z viloyatidagi buyurtma, pulsiz.
    RoleEnum.LOGIST,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get order tracking history by ID',
    description:
      "4BftLLnc — LOGIST: o'z viloyatidagi buyurtma tarixi (boshqasi — 403), hodisalarda pul maydonlari yo'q.",
  })
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
    await this.assertCanViewOrderTracking(
      req?.user,
      this.unwrapOrderRow(order),
    );
    const tracking: unknown = await firstValueFrom(
      this.orderClient
        .send({ cmd: 'order.tracking' }, { id, page, limit })
        .pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
    // 4BftLLnc: logistga tarix hodisalaridagi pul maydonlari ham chiqmaydi.
    return projectLogistPayload(
      req?.user?.roles,
      projectOrderTrackingForRoles(req?.user?.roles, tracking),
    );
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
  @ApiBody({ type: CancelOrderRequestDto })
  @UseInterceptors(
    FileInterceptor('proof', {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async cancelOrder(
    @Param('id') id: string,
    @Body() dto: CancelOrderRequestDto,
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
  settlementCourierToBranch(): never {
    // MlVMpsfr: ochiq turgan o'lik marshrut yangi chaqiruvchini tuzoqqa
    // tortardi (order-service 400 qaytarardi). Endi aniq 410 Gone.
    throw new GoneException(SETTLEMENT_LUMP_SUM_GONE_MESSAGE);
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
  settlementBranchToHq(): never {
    // MlVMpsfr: ochiq turgan o'lik marshrut yangi chaqiruvchini tuzoqqa
    // tortardi (order-service 400 qaytarardi). Endi aniq 410 Gone.
    throw new GoneException(SETTLEMENT_LUMP_SUM_GONE_MESSAGE);
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
  settlementHqToMarket(): never {
    // MlVMpsfr: ochiq turgan o'lik marshrut yangi chaqiruvchini tuzoqqa
    // tortardi (order-service 400 qaytarardi). Endi aniq 410 Gone.
    throw new GoneException(SETTLEMENT_LUMP_SUM_GONE_MESSAGE);
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
  async getOrderSettlement(
    @Param('id') id: string,
    @Req() req: { user: JwtUser },
  ) {
    // fix3b: MANAGER/REGISTRATOR faqat o'z filiali doirasidagi buyurtmaning
    // hisob-kitob holatini (pul summalari) o'qiydi — PATCH/DELETE bilan AYNI
    // doira (branch_id / holder_branch_id / home_branch_id). SA/ADMIN — cheklovsiz.
    const roles = this.normalizeRoles(req.user.roles);
    if (
      !roles.includes(RoleEnum.SUPERADMIN) &&
      !roles.includes(RoleEnum.ADMIN)
    ) {
      await this.assertOrderInRequesterBranch(
        req.user,
        id,
        "Bu buyurtma sizning filialingizga tegishli emas — hisob-kitobini ko'ra olmaysiz",
      );
    }
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
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Mark order as returned to market — MARKET QR MAJBURIY (authorization_token)',
  })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['authorization_token'],
      properties: {
        authorization_token: {
          type: 'string',
          description: 'Market QR skanidan olingan ruxsat (MHA-...)',
        },
      },
    },
  })
  markReturnedToMarket(
    @Param('id') id: string,
    @Body() body: { authorization_token?: string },
    @Req() req: { user: JwtUser },
  ) {
    return firstValueFrom(
      this.orderClient
        .send(
          { cmd: 'order.mark_returned_to_market' },
          {
            id,
            authorization_token: body?.authorization_token,
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
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order (full fields, including items)' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  @ApiBody({ type: UpdateOrderByIdRequestDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOrderByIdRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.updateOrderGuarded(id, dto, req);
  }

  @Patch(':id/full')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order by id (full fields)' })
  @ApiParam({ name: 'id', description: 'Order ID (uuid)' })
  @ApiBody({ type: UpdateOrderByIdRequestDto })
  updateFull(
    @Param('id') id: string,
    @Body() dto: UpdateOrderByIdRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.updateOrderGuarded(id, dto, req);
  }

  /**
   * PATCH /orders/:id va /:id/full — umumiy yo'l (fix3 C6; M11, CODE-03).
   *
   *  1. `status`, `market_id`, `to_be_paid`, `paid_amount` — HECH KIMGA
   *     (superadmin ham): holat faqat sotish/bekor qilish/qaytarish
   *     amallari orqali o'zgaradi, aks holda kassa oyoqlari va hisob-kitob
   *     qatori yozilmaydi.
   *  2. `post_id`, `customer_id`, `qr_code_token`, `source` — faqat
   *     SUPERADMIN.
   *  3. REGISTRATOR — faqat o'z filiali doirasidagi buyurtma.
   *
   * fix3b (M11/CODE-03): faqat shu HTTP PATCH yo'li ALOHIDA
   * `order.update_from_api` pattern'iga boradi — order-service uni
   * `updateFromApi` ga ulaydi (xuddi shu qoidalar xizmat qatlamida ham).
   * `order.update`, `order.update_full`, `order.update_normalized` ichki
   * chaqiruvchilar (filial jo'natmasi, logistika, finance to'lov yozuvi)
   * uchun avvalgidek oddiy `updateFull` da qoladi — ularga bu taqiqlar
   * qo'llanmasligi SHART.
   */
  private async updateOrderGuarded(
    id: string,
    dto: UpdateOrderByIdRequestDto,
    req: { user: JwtUser },
  ) {
    const roles = this.normalizeRoles(req.user.roles);
    const forbidden = this.presentFields(dto, PATCH_FORBIDDEN_FIELDS);
    if (forbidden.length) {
      throw new BadRequestException(
        `Bu maydonlarni PATCH orqali o'zgartirib bo'lmaydi: ${forbidden.join(', ')}. ` +
          "Holat sotish, bekor qilish va qaytarish amallari orqali o'zgaradi",
      );
    }
    if (!roles.includes(RoleEnum.SUPERADMIN)) {
      const superadminOnly = this.presentFields(
        dto,
        PATCH_SUPERADMIN_ONLY_FIELDS,
      );
      if (superadminOnly.length) {
        throw new ForbiddenException(
          `Bu maydonlarni faqat superadmin o'zgartira oladi: ${superadminOnly.join(', ')}`,
        );
      }
    }
    if (
      !roles.includes(RoleEnum.SUPERADMIN) &&
      !roles.includes(RoleEnum.ADMIN)
    ) {
      await this.assertOrderInRequesterBranch(
        req.user,
        id,
        "Bu buyurtma sizning filialingizga tegishli emas — uni o'zgartira olmaysiz",
      );
    }

    return firstValueFrom(
      this.orderClient
        .send<unknown>(
          { cmd: 'order.update_from_api' },
          {
            id,
            dto,
            requester: {
              id: req.user.sub,
              roles,
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
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete order (status-based role rules)' })
  @ApiOkResponse({ description: 'Order deleted' })
  @ApiConflictResponse({
    description:
      'A post-linked order can only be deleted before dispatch, without payment or an active return/batch',
  })
  @ApiParam({ name: 'id', description: 'Order ID (bigint)' })
  async remove(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    const roles = this.normalizeRoles(req.user.roles);
    const isSystemPrivileged =
      roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN);

    // fix3 C6 (RBAC-04, CODE-01, CODE-03): market faqat O'Z buyurtmasini,
    // registrator faqat o'z filiali doirasidagisini o'chiradi. Holat
    // qoidalari (NEW/CREATED/RECEIVED) order-service'da qoladi.
    if (!isSystemPrivileged && roles.includes(RoleEnum.MARKET)) {
      const order = await this.findOrderRowForScope(id);
      const ownerMarketId = this.asStr(
        order?.market_id ?? order?.marketId,
      ).trim();
      if (order && ownerMarketId !== String(req.user.sub ?? '').trim()) {
        throw new ForbiddenException(
          "Market faqat o'z buyurtmasini o'chira oladi",
        );
      }
    } else if (!isSystemPrivileged && roles.includes(RoleEnum.REGISTRATOR)) {
      await this.assertOrderInRequesterBranch(
        req.user,
        id,
        "Bu buyurtma sizning filialingizga tegishli emas — uni o'chira olmaysiz",
      );
    }

    return firstValueFrom(
      this.orderClient
        .send<unknown>(
          { cmd: 'order.delete' },
          {
            id,
            requester: {
              id: req.user.sub,
              roles,
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
}
