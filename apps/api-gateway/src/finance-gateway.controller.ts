import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  Headers,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { Roles } from './auth/roles.decorator';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Public } from './auth/public.decorator';
import { RolesGuard } from './auth/roles.guard';
import { projectOrderPayloadForRoles } from './auth/order-role-projection';
import {
  Cashbox_type,
  FinancialSource_type,
  Operation_type,
  PaymentMethod,
  Roles as RoleEnum,
  Source_type,
  matchesDeclaredType,
  stripImageMetadata,
  toPublicUserSummary,
  type AiBalanceScreenshotMediaType,
  type AiBalanceScreenshotResponse,
} from '@app/common';
import {
  CashboxAllInfoQueryDto,
  CloseShiftRequestDto,
  ShiftAccountPhotoRequestDto,
  ShiftAccountPhotoSwaggerDto,
  ShiftSettingsQueryDto,
  UpdateShiftSettingsRequestDto,
  CreateCashboxRequestDto,
  CreateOperatorPaymentRequestDto,
  CreateSalaryRequestDto,
  CurrentShiftQueryDto,
  RecordFinancialBalanceRequestDto,
  FindCashboxByUserQueryDto,
  FindHistoryQueryDto,
  FinancialBalanceDailyQueryDto,
  HistoryDailyQueryDto,
  PaymentsMetaQueryDto,
  FindShiftQueryDto,
  HqCourierReceivablesResponseDto,
  MainCashboxFilterQueryDto,
  MainCashboxManualRequestDto,
  MainCashboxSpendRequestDto,
  CreateCashboxExpenseCategoryRequestDto,
  UpdateCashboxExpenseCategoryRequestDto,
  OpenShiftRequestDto,
  ConvertCashboxCardRequestDto,
  CreateCashboxCardRequestDto,
  UpdateCashboxCardRequestDto,
  SetCashboxCardStatusRequestDto,
  TransferCashboxCardRequestDto,
  PaymentBranchToMainRequestDto,
  PaymentFromCourierRequestDto,
  CourierPaymentAckRequestDto,
  PaymentToMarketRequestDto,
  UpdateCashboxBalanceRequestDto,
  UpdateSalaryRequestDto,
} from './dto/finance.swagger.dto';
import { resolveFinancialActors } from './financial-balance/financial-balance.util';
import {
  buildFileLinkUrl,
  FILE_LINK_TTL_SECONDS,
  type OriginRequest,
} from './file-link';
import {
  buildXlsx,
  excelDate,
  excelNumber,
  type ExcelColumn,
} from './excel/excel.util';

/** (kiZgTybn) Smena yopish: karta qoldig'i rasmi chegaralari. */
const SHIFT_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const SHIFT_PHOTO_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);
/**
 * Imzolangan havola muddati (s) — qisqa: rasm shaxsiy (PII). Havola gateway
 * orqali ochiladi (`files/signed/:token`, `file-link.ts`) — MinIO ichki manzili
 * brauzerga chiqmaydi.
 */
const SHIFT_PHOTO_URL_TTL_SECONDS = FILE_LINK_TTL_SECONDS;
/** Yopish AI natijasini 30 s gacha kutadi (+ zaxira). */
const SHIFT_CLOSE_TIMEOUT_MS = 45000;
const SHIFT_AI_TIMEOUT_MS = 60000;

interface JwtUser {
  sub: string;
  role?: string;
  roles?: string[];
  branch_id?: string | null;
}

/** `order.settlement.courier_scope` javobi (B4, order-service). */
interface CourierSettlementScope {
  hq_pending_count: number;
  hq_pending_amount: number;
  branch_pending_count: number;
  branch_pending_amount: number;
  branch_ids: string[];
  carry_amount: number;
}

/** Kuryer kassasi sahifasi uchun foydalanuvchi qisqa ma'lumoti (C3). */
interface UserSummary {
  id: string;
  name: string;
  phone_number: string | null;
  role: string | null;
  status: string | null;
}

/**
 * `identity.user.find_by_id` natijasi. `not_found` — identity 404 (odatda
 * soft-delete qilingan foydalanuvchi); `unavailable` — timeout, 5xx yoki
 * bo'sh javob (holat noma'lum).
 */
type UserLookup =
  | { kind: 'found'; user: UserSummary; isCourier: boolean }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

/** Foydalanuvchining joriy (oxirgi faol) `branch_users` qatori (C3/C4). */
interface BranchAssignment {
  branch_id: string;
  /** `branch_users.role` katta harfda (COURIER / MANAGER / REGISTRATOR) yoki ''. */
  role: string;
  /** Qatorga qo'shilgan foydalanuvchi ma'lumoti (`row.user`) — bo'lsa. */
  name: string;
  phone_number: string | null;
}

/** C3 — superadmin/admin kuryer kassasi sahifasiga qo'shiladigan maydonlar. */
interface CourierReceiveInfo {
  user: UserSummary | null;
  /** null — filial yoki ledger tekshiruvi javob bermadi. */
  is_hq_courier: boolean | null;
  /** null — filial yoki ledger tekshiruvi javob bermadi. */
  can_receive: boolean | null;
  olinishi_kerak: number;
  receive_check_failed: boolean;
  counterparty: 'HQ';
}

/** RPC yukidagi primitiv qiymat → matn (obyekt, null, undefined → ''). */
function toText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

/**
 * RPC xatosining HTTP holat kodi. Mikroservisdagi `RpcException(errorRes(...))`
 * gateway'ga oddiy `{ statusCode, message }` obyekti bo'lib keladi; gateway'ning
 * o'z `HttpException`i ham hisobga olinadi. Aniqlanmasa — null.
 */
function rpcErrorStatus(error: unknown): number | null {
  if (error instanceof HttpException) {
    return error.getStatus();
  }
  if (!error || typeof error !== 'object') {
    return null;
  }
  const obj = error as {
    statusCode?: unknown;
    status?: unknown;
    response?: unknown;
  };
  const nested =
    obj.response && typeof obj.response === 'object'
      ? (obj.response as { statusCode?: unknown })
      : null;
  for (const candidate of [obj.statusCode, obj.status, nested?.statusCode]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * RPC 404 xatosi → gateway `NotFoundException` (xabari saqlanadi). HTTP
 * javobi xom RPC obyekti uzatilgandagi bilan bir xil: 404 + o'sha matn.
 */
function toNotFoundException(
  error: unknown,
  fallbackMessage: string,
): NotFoundException {
  const message =
    error && typeof error === 'object'
      ? toText((error as { message?: unknown }).message)
      : '';
  return new NotFoundException(message || fallbackMessage);
}

/**
 * 32Sw3DfC — superadmin/admin filial kassasi sahifasida, filial smenasi
 * ochilmagan bo'lsa (ular filial smenasini ochmaydi — faqat menejer).
 */
export const BRANCH_SHIFT_MANAGER_ONLY_MESSAGE =
  'Filial menejeri smenani ochishi kerak';

/** Smena kassasi: markaziy asosiy (MAIN) kassa `user_id` si. */
const MAIN_SHIFT_CASHBOX_USER_ID = '0';

/** IjqTYQks — filial puli HQ'ga faqat HQ (superadmin/admin) qabul qilganda o'tadi (ega qarori #7). */
/** Zv3MLn0a — menejer boshqa filial kassasi kartalarini so'radi. */
export const CARD_OTHER_BRANCH_MESSAGE =
  "Siz faqat o'z filialingiz kassasi kartalarini ko'ra olasiz";
/** Zv3MLn0a — smena sozlamalari faqat superadmin. */
export const CARD_SHIFT_SETTINGS_SUPERADMIN_MESSAGE =
  "Smena sozlamalarini (rasm / AI tekshiruvi) faqat superadmin o'zgartiradi";

/** Zv3MLn0a — karta ko'chirmasi Excel ustunlari. */
const CARD_LEDGER_EXCEL_COLUMNS: ExcelColumn[] = [
  { header: 'Sana', key: 'date', width: 20 },
  { header: 'Amal', key: 'kind', width: 22 },
  { header: 'Summa', key: 'amount', width: 14 },
  { header: "O'zgarish", key: 'delta', width: 14 },
  { header: 'Qoldiq', key: 'balance_after', width: 14 },
  { header: "To'lov usuli", key: 'payment_method', width: 14 },
  { header: 'Manba', key: 'source_type', width: 18 },
  { header: 'Qarshi karta ID', key: 'counterparty_card_id', width: 14 },
  { header: 'Izoh', key: 'comment', width: 30 },
  { header: 'Kiritgan (ID)', key: 'created_by', width: 14 },
];

const CARD_LEDGER_KIND_LABEL: Record<string, string> = {
  income: 'Kirim',
  expense: 'Chiqim',
  transfer_in: "Kartaga o'tkazma",
  transfer_out: "Kartadan o'tkazma",
  cash_to_card: 'Naqddan kartaga',
  card_to_cash: 'Kartadan naqdga',
};

export const BRANCH_TO_MAIN_HQ_ONLY_MESSAGE =
  "Filial pulini HQ (superadmin yoki admin) o'zi qabul qiladi — menejer HQ'ga pul o'tkazmaydi";

@ApiTags('Finance')
@Controller('finance')
export class FinanceGatewayController {
  constructor(
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    // (kiZgTybn) Smena yopishda karta qoldig'i rasmi (file-service) va AI
    // tekshiruvi (ai-service). Ixtiyoriy: eski spec'lar usiz quradi.
    @Optional() @Inject('FILE') private readonly fileClient?: ClientProxy,
    @Optional() @Inject('AI') private readonly aiClient?: ClientProxy,
    // (gWI4gYkw) Smena hisoboti yetkazish holati — FAQAT o'qish
    // (`notification.delivery.by_dispatch`). Ixtiyoriy: eski spec'lar usiz.
    @Optional()
    @Inject('NOTIFICATION')
    private readonly notificationClient?: ClientProxy,
  ) {}

  private readonly shiftCheckLogger = new Logger('FinanceShiftCheck');

  /**
   * Xom RPC yuklaridagi rol qiymati `unknown` bo'ladi va odatda matn. Obyekt
   * kelib qolsa `String(...)` "[object Object]" beradi — shu bois faqat
   * primitivlarni matnga aylantiramiz (xulq o'zgarmaydi).
   */
  private roleToString(value: unknown): string {
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

  private async send<T = any>(
    pattern: object,
    payload: object,
    timeoutMs = 8000,
  ): Promise<T> {
    return firstValueFrom(
      this.financeClient.send(pattern, payload).pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Finance service response timeout');
      }
      throw error;
    });
  }

  private async sendIdentity<T = any>(
    pattern: object,
    payload: object,
    timeoutMs = 8000,
  ): Promise<T> {
    return firstValueFrom(
      this.identityClient.send(pattern, payload).pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Identity service response timeout');
      }
      throw error;
    });
  }

  private async sendOrder<T = any>(
    pattern: object,
    payload: object,
    timeoutMs = 8000,
  ): Promise<T> {
    return firstValueFrom(
      this.orderClient.send(pattern, payload).pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Order service response timeout');
      }
      throw error;
    });
  }

  private async sendBranch<T = any>(
    pattern: object,
    payload: object,
    timeoutMs = 8000,
  ): Promise<T> {
    return firstValueFrom(
      this.branchClient.send(pattern, payload).pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Branch service response timeout');
      }
      throw error;
    });
  }

  private async attachCreatedByUsersToHistory(response: any) {
    const histories = Array.isArray(response?.data?.cashboxHistory)
      ? response.data.cashboxHistory
      : response?.data?.history;
    if (!Array.isArray(histories) || !histories.length) {
      return response;
    }

    const enrichedHistories = await this.attachCreatedByUsers(histories);
    response.data.cashboxHistory = enrichedHistories;
    if (Array.isArray(response?.data?.history)) {
      response.data.history = enrichedHistories;
    }

    return response;
  }

  private async attachCreatedByUsers(histories: any[]) {
    if (!Array.isArray(histories) || !histories.length) {
      return histories;
    }

    const createdByIds = Array.from(
      new Set(
        histories
          .map((item: any) => String(item?.created_by ?? ''))
          .filter(Boolean),
      ),
    );
    if (!createdByIds.length) {
      return histories;
    }

    // vf4513Zn — to'liq identity yozuvi EMAS: `{id, name, role,
    // phone_number}`. Ilgari market o'z kassasida kuryerning tarifi/maoshini,
    // kuryer menejer/market moliyasini ko'rardi. `getMainCashbox` filtri
    // `createdByUser.role` ni o'qiydi — u saqlanadi.
    const users = await Promise.all(
      createdByIds.map(async (id) => {
        try {
          const userResponse = await this.sendIdentity<{
            data?: Record<string, any>;
          }>({ cmd: 'identity.user.find_by_id' }, { id });
          return [id, toPublicUserSummary(userResponse?.data, id)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );

    const usersMap = new Map(users);
    return histories.map((item: any) => ({
      ...item,
      createdByUser: usersMap.get(String(item?.created_by ?? '')) ?? null,
      created_by_user: usersMap.get(String(item?.created_by ?? '')) ?? null,
    }));
  }

  /**
   * Moliyaviy daftar (financial balance) qatorlariga KIM kiritganini qo'shadi
   * (4WeT0Tv5). ⚠️ To'liq identity yozuvi EMAS — faqat `{ id, name, role }`:
   * javob jadval va Excelga chiqadi, foydalanuvchining boshqa maydonlari
   * (telefon, token, tarif) bu yerga kerak emas. Avtomatik yozuvlarda
   * (`created_by` yo'q) — `null`.
   */
  private async attachFinancialActors(response: any) {
    const data = response?.data;
    const rows: unknown = data?.items ?? data?.rows ?? data?.history;
    if (!Array.isArray(rows) || !rows.length) {
      return response;
    }

    const actors = await resolveFinancialActors(
      rows.map((row: { created_by?: unknown }) => row?.created_by),
      (id) =>
        this.sendIdentity<{ data?: unknown }>(
          { cmd: 'identity.user.find_by_id' },
          { id },
        ),
    );
    const enriched = rows.map((row: Record<string, unknown>) => ({
      ...row,
      created_by_user:
        actors.get(String((row?.created_by as string | number) ?? '')) ?? null,
    }));
    for (const key of ['items', 'rows', 'history'] as const) {
      if (Array.isArray(data[key])) data[key] = enriched;
    }
    return response;
  }

  private async attachCreatedByUsersToHistoryResponse(response: any) {
    const data = response?.data;
    if (!data || typeof data !== 'object') {
      return response;
    }

    if (Array.isArray(data.items)) {
      data.items = await this.attachCreatedByUsers(data.items);
    }
    if (Array.isArray(data.history)) {
      data.history = await this.attachCreatedByUsers(data.history);
    }
    if (Array.isArray(data.cashboxHistory)) {
      data.cashboxHistory = await this.attachCreatedByUsers(
        data.cashboxHistory,
      );
    }
    if (Array.isArray(data.allCashboxHistories)) {
      data.allCashboxHistories = await this.attachCreatedByUsers(
        data.allCashboxHistories,
      );
    }

    return response;
  }

  private getUserRoles(user: JwtUser | undefined) {
    return Array.from(
      new Set(
        [...(Array.isArray(user?.roles) ? user.roles : []), user?.role]
          .map((item) =>
            String(item ?? '')
              .trim()
              .toLowerCase(),
          )
          .filter(Boolean),
      ),
    );
  }

  private hasRole(user: JwtUser | undefined, role: RoleEnum) {
    return this.getUserRoles(user).some(
      (item) => String(item ?? '').toLowerCase() === String(role).toLowerCase(),
    );
  }

  private isPrivileged(user: JwtUser | undefined) {
    return (
      this.hasRole(user, RoleEnum.SUPERADMIN) ||
      this.hasRole(user, RoleEnum.ADMIN)
    );
  }

  private isManager(user: JwtUser | undefined) {
    return this.hasRole(user, RoleEnum.MANAGER) && !this.isPrivileged(user);
  }

  private extractBranchId(user: Record<string, any> | JwtUser | undefined) {
    return String(
      (user as any)?.branch_id ??
        (user as any)?.branchId ??
        (user as any)?.branch?.id ??
        (user as any)?.branch?.branch_id ??
        '',
    );
  }

  private toRequester(user: JwtUser | undefined) {
    return {
      id: String(user?.sub ?? ''),
      roles: this.getUserRoles(user),
      branch_id: user?.branch_id ?? null,
    };
  }

  /**
   * Foydalanuvchining joriy (oxirgi faol) `branch_users` qatori — filial VA
   * rol bilan. `branch.user.find_by_user` faqat `branch_users` ni o'qiydi
   * (identity'ga qaramaydi), shuning uchun identity'da soft-delete qilingan
   * kuryerning qatori ham qaytadi (o'chirish `branch_users` ga tegmaydi).
   * Xatoni YUTMAYDI: pul tekshiruvida "filial xizmati javob bermadi" bilan
   * "filialga biriktirilmagan" farqlanishi shart. Biriktiruv yo'q → null.
   */
  private async findBranchAssignmentOrThrow(
    userId: string,
    requester?: JwtUser,
  ): Promise<BranchAssignment | null> {
    const response = await this.sendBranch<{
      data?: Record<string, any> | null;
    }>(
      { cmd: 'branch.user.find_by_user' },
      { user_id: userId, requester: this.toRequester(requester) },
    );
    const row = response?.data;
    const branchId = row ? this.extractBranchId(row) : '';
    if (!row || !branchId) {
      return null;
    }
    const rowUser =
      row.user && typeof row.user === 'object'
        ? (row.user as Record<string, unknown>)
        : null;
    return {
      branch_id: branchId,
      role: toText(row.role).trim().toUpperCase(),
      name: toText(rowUser?.name),
      phone_number: toText(rowUser?.phone_number) || null,
    };
  }

  /**
   * Foydalanuvchining joriy (oxirgi faol `branch_users` qatori) filiali.
   * Xatoni YUTMAYDI. Biriktiruv yo'q → ''.
   */
  private async findBranchIdByUserIdOrThrow(
    userId: string,
    requester?: JwtUser,
  ): Promise<string> {
    const assignment = await this.findBranchAssignmentOrThrow(
      userId,
      requester,
    );
    return assignment?.branch_id ?? '';
  }

  private async resolveBranchIdByUserId(
    userId: string,
    requester?: JwtUser,
  ): Promise<string> {
    try {
      return await this.findBranchIdByUserIdOrThrow(userId, requester);
    } catch {
      return '';
    }
  }

  /** So'rovchining o'z filiali: JWT'dagi `branch_id`, bo'lmasa branch_users. */
  private async resolveOwnBranchId(user: JwtUser): Promise<string> {
    return (
      this.extractBranchId(user) ||
      (await this.resolveBranchIdByUserId(String(user.sub), user))
    );
  }

  /**
   * Superadmin/admin kuryerdan naqd olishidagi rad javoblari (C4). Matnlar
   * frontend va E2E bilan kelishilgan — o'zgartirilmasin.
   */
  private static readonly NOT_A_COURIER_MESSAGE =
    'Bu foydalanuvchi courier emas';
  private static readonly BRANCH_COURIER_NOT_RECEIVABLE_MESSAGE =
    'Bu kuryer filialga tegishli — pulni filial menejeri qabul qiladi (kuryer → filial → HQ)';
  private static readonly RECEIVE_CHECK_UNAVAILABLE_MESSAGE =
    "Tekshiruv xizmati javob bermadi, keyinroq urinib ko'ring";
  /** C3 — menejer boshqa filial (HQ, ota filial) kuryeridan naqd olmoqchi. */
  private static readonly COURIER_NOT_IN_MANAGER_BRANCH_MESSAGE =
    'Bu kuryer sizning filialingizga tegishli emas';
  /** Audit M4 — "Marketga o'tkazma" filial kassasi orqali taqiqlangan. */
  private static readonly MANAGER_CLICK_TO_MARKET_MESSAGE =
    "Marketga o'tkazma (click_to_market) faqat HQ kassasi orqali (superadmin/admin) qabul qilinadi";

  /** `branch_users.role` dagi kuryer qiymati (BranchUserRole.COURIER). */
  private static readonly COURIER_BRANCH_ROLE = 'COURIER';
  /** C3: identity'da soft-delete qilingan (404) foydalanuvchi holati. */
  private static readonly DELETED_USER_STATUS = 'deleted';

  /** HQ id si o'zgarmaydi (tizimda bitta HQ) — qisqa kesh yetarli. */
  private static readonly HQ_BRANCH_CACHE_TTL_MS = 60_000;
  private hqBranchIdCache: { id: string; at: number } | null = null;

  /**
   * HQ filial id si (`branch.find_hq`), 60 s keshlanadi. Xato YUTILMAYDI —
   * chaqiruvchi hal qiladi (to'lov tekshiruvi 503 qaytaradi).
   */
  private async resolveHqBranchId(): Promise<string> {
    const cached = this.hqBranchIdCache;
    if (
      cached &&
      Date.now() - cached.at < FinanceGatewayController.HQ_BRANCH_CACHE_TTL_MS
    ) {
      return cached.id;
    }
    const response = await this.sendBranch<{
      data?: { id?: string | number } | null;
    }>({ cmd: 'branch.find_hq' }, {});
    const hqBranchId = String(response?.data?.id ?? '').trim();
    if (!hqBranchId) {
      throw new NotFoundException('HQ filial topilmadi');
    }
    this.hqBranchIdCache = { id: hqBranchId, at: Date.now() };
    return hqBranchId;
  }

  /** Identity foydalanuvchisi kuryermi (`roles[]` yoki `role`). */
  private isCourierIdentity(user: Record<string, any>): boolean {
    const roleList = Array.isArray(user.roles)
      ? user.roles
      : user.role
        ? [user.role]
        : [];
    return roleList.some(
      (role: unknown) =>
        this.roleToString(role).toLowerCase() === RoleEnum.COURIER,
    );
  }

  /**
   * `courier_id` haqiqatan kuryer foydalanuvchimi (identity). Menejer va
   * superadmin/admin to'lov yo'llari uchun BITTA tekshiruv (C4). Identity
   * xatolari (404, timeout) o'zgarishsiz uzatiladi — soft-delete (404) ni
   * faqat superadmin/admin yo'li (`assertHqCourierReceivable`) hal qiladi.
   */
  private async assertCourierUser(courierId: string): Promise<void> {
    const courierResponse = await this.sendIdentity<{
      data?: Record<string, any>;
    }>({ cmd: 'identity.user.find_by_id' }, { id: courierId });
    const courier = courierResponse?.data;
    if (!courier) {
      throw new ForbiddenException('Courier topilmadi');
    }
    if (!this.isCourierIdentity(courier)) {
      throw new ForbiddenException(
        FinanceGatewayController.NOT_A_COURIER_MESSAGE,
      );
    }
  }

  /**
   * HQ filial id si va kuryerning joriy (oxirgi faol) filial qatori —
   * parallel. Xatolar YUTILMAYDI (C4 → 503, C3 → receive_check_failed).
   */
  private async loadCourierPlacement(
    courierId: string,
    requester?: JwtUser,
  ): Promise<{ hqBranchId: string; assignment: BranchAssignment | null }> {
    const [hqBranchId, assignment] = await Promise.all([
      this.resolveHqBranchId(),
      this.findBranchAssignmentOrThrow(courierId, requester),
    ]);
    return { hqBranchId, assignment };
  }

  /**
   * C3 (defense in depth) — menejer naqd qabul qilishidan OLDINGI qat'iy
   * tekshiruv: kuryerning FAOL `branch_users` qatori AYNAN menejerning
   * filialida bo'lishi shart. Ajdod filiallar (HQ, ota filial) hisobga
   * OLINMAYDI — branch-service resolver'iga (`resolve_for_manager`)
   * bog'liq emas.
   *
   * ⚠️ NEGA. Ilgari yagona tekshiruv `canManagerAccessUser` edi: u
   * resolver'ning ajdodlar bo'ylab yurishiga tayanardi va zanjir doim HQ'ga
   * yetgani uchun istalgan menejer HQ kuryerining naqdini o'z filial
   * kassasiga "qabul qila olardi"; FIFO esa HQ qatorlarini BRANCH_SETTLED
   * ("naqd HQ'da") qilardi — pul HQ daftaridan yo'qolardi (audit M7/RBAC-07).
   *
   * `branch.user.find_by_user` menejerga boshqa foydalanuvchining qatorini
   * bermaydi (403), shuning uchun menejerning O'Z filiali qatorlari
   * o'qiladi. Filial xizmati javob bermasa pul KO'CHIRILMAYDI (503); 4xx →
   * 403 (kuryer bu filialda emas).
   */
  private async assertCourierInManagerBranch(
    courierId: string,
    managerBranchId: string,
    manager: JwtUser,
  ): Promise<void> {
    let rows: unknown[];
    try {
      const response = await this.sendBranch<{ data?: unknown }>(
        { cmd: 'branch.user.find_by_branch' },
        { branch_id: managerBranchId, requester: this.toRequester(manager) },
      );
      rows = Array.isArray(response?.data) ? response.data : [];
    } catch (error) {
      const status = rpcErrorStatus(error);
      if (status !== null && status >= 400 && status < 500) {
        throw new ForbiddenException(
          FinanceGatewayController.COURIER_NOT_IN_MANAGER_BRANCH_MESSAGE,
        );
      }
      throw new ServiceUnavailableException(
        FinanceGatewayController.RECEIVE_CHECK_UNAVAILABLE_MESSAGE,
      );
    }
    const assigned = rows.some((row) => {
      if (!row || typeof row !== 'object') {
        return false;
      }
      const record = row as Record<string, unknown>;
      const rowBranchId = toText(record.branch_id);
      return (
        toText(record.user_id) === String(courierId) &&
        record.isDeleted !== true &&
        (!rowBranchId || rowBranchId === String(managerBranchId))
      );
    });
    if (!assigned) {
      throw new ForbiddenException(
        FinanceGatewayController.COURIER_NOT_IN_MANAGER_BRANCH_MESSAGE,
      );
    }
  }

  /**
   * O'chirilgan kuryer uchun isbot: FOR_COURIER kassasi bormi. 404 → false;
   * boshqa xato (timeout, 5xx) → 503 — tekshirib bo'lmadi, pul KO'CHIRILMAYDI.
   */
  private async courierCashboxExists(courierId: string): Promise<boolean> {
    try {
      const response = await this.send<{ data?: { id?: unknown } | null }>(
        { cmd: 'finance.cashbox.find_by_user' },
        { user_id: courierId, cashbox_type: Cashbox_type.FOR_COURIER },
      );
      return Boolean(toText(response?.data?.id));
    } catch (error) {
      if (rpcErrorStatus(error) === 404) {
        return false;
      }
      throw new ServiceUnavailableException(
        FinanceGatewayController.RECEIVE_CHECK_UNAVAILABLE_MESSAGE,
      );
    }
  }

  /**
   * B4 — kuryerning PENDING savdosi HQ / filial kesimida (order-service).
   * `.catch` YO'Q: xato va timeout chaqiruvchiga chiqadi. Javob shakli buzuq
   * bo'lsa ham xato — "filial qatori yo'q" deb taxmin QILINMAYDI.
   */
  private async loadCourierSettlementScope(
    courierId: string,
  ): Promise<CourierSettlementScope> {
    const response = await this.sendOrder<{
      data?: Partial<CourierSettlementScope> | null;
    }>({ cmd: 'order.settlement.courier_scope' }, { courier_id: courierId });
    const data = response?.data;
    const branchPendingCount = Number(data?.branch_pending_count);
    if (!data || !Number.isFinite(branchPendingCount)) {
      throw new Error("order.settlement.courier_scope: javob shakli noto'g'ri");
    }
    return {
      hq_pending_count: Number(data.hq_pending_count ?? 0) || 0,
      hq_pending_amount: Number(data.hq_pending_amount ?? 0) || 0,
      branch_pending_count: branchPendingCount,
      branch_pending_amount: Number(data.branch_pending_amount ?? 0) || 0,
      branch_ids: Array.isArray(data.branch_ids)
        ? data.branch_ids.map((id) => String(id))
        : [],
      carry_amount: Number(data.carry_amount ?? 0) || 0,
    };
  }

  /**
   * C4 — superadmin/admin kuryerdan naqdni FAQAT HQ kuryeridan va faqat
   * kuryerda filialga tegishli topshirilmagan savdo bo'lmasa oladi (naqd
   * to'g'ridan-to'g'ri MAIN'ga tushadi).
   *
   * ⚠️ NEGA. Filial kuryerining naqdi zanjir bo'ylab keladi: kuryer →
   * filial menejeri → HQ. Superadmin undan to'g'ridan-to'g'ri olsa FIFO
   * filial qatorlarini COURIER_SETTLED qiladi, naqd esa MAIN'da bo'ladi —
   * filialda hech qachon yopilmaydigan soxta qarz paydo bo'ladi (jonli
   * tasdiqlangan). Summa chegarasi — kuryer kassasi (finance-service).
   * Tekshiruv xizmatlaridan biri javob bermasa pul KO'CHIRILMAYDI (503).
   *
   * O'CHIRILGAN (soft-delete) KURYER. Identity uni 404 bilan rad etadi, lekin
   * `branch_users` qatori ham, FOR_COURIER kassasidagi naqd ham joyida qoladi.
   * 404 da to'xtasak bu naqd hech qachon olinmaydi. Shuning uchun kuryerlikni
   * identity o'rniga joriy filial qatori (roli COURIER, filiali HQ) va kuryer
   * kassasining mavjudligi isbotlaydi; filialga tegishli PENDING tekshiruvi
   * odatdagidek. Isbot bo'lmasa — avvalgi javob: faol qator yoki kassa yo'q →
   * identity'ning 404 i, qator boshqa rolda → 403, filialda → 403. Tirik,
   * lekin kuryer bo'lmagan foydalanuvchi — avvalgidek 403.
   */
  private async assertHqCourierReceivable(
    courierId: string,
    requester: JwtUser,
  ): Promise<void> {
    // 1) Identity. Tirik foydalanuvchi kuryer bo'lmasa 403 (filialga
    //    bormaymiz). 404 — soft-delete: qaror filial qatoriga o'tadi. Boshqa
    //    xatolar (timeout, 5xx) avvalgidek o'zgarishsiz uzatiladi.
    let deletedUserError: NotFoundException | null = null;
    try {
      await this.assertCourierUser(courierId);
    } catch (error) {
      if (rpcErrorStatus(error) !== 404) {
        throw error;
      }
      deletedUserError = toNotFoundException(error, 'User topilmadi');
    }

    // 2) Filial: kuryerning joriy qatori HQ'da bo'lishi shart.
    let placement: { hqBranchId: string; assignment: BranchAssignment | null };
    try {
      placement = await this.loadCourierPlacement(courierId, requester);
    } catch {
      throw new ServiceUnavailableException(
        FinanceGatewayController.RECEIVE_CHECK_UNAVAILABLE_MESSAGE,
      );
    }
    const { hqBranchId, assignment } = placement;
    if (deletedUserError) {
      if (!assignment) {
        throw deletedUserError;
      }
      if (assignment.role !== FinanceGatewayController.COURIER_BRANCH_ROLE) {
        throw new ForbiddenException(
          FinanceGatewayController.NOT_A_COURIER_MESSAGE,
        );
      }
    }
    if (!assignment || assignment.branch_id !== hqBranchId) {
      throw new ForbiddenException(
        FinanceGatewayController.BRANCH_COURIER_NOT_RECEIVABLE_MESSAGE,
      );
    }
    if (deletedUserError && !(await this.courierCashboxExists(courierId))) {
      throw deletedUserError;
    }

    // 3) Ledger: filialga tegishli topshirilmagan savdo bo'lmasligi shart.
    let scope: CourierSettlementScope;
    try {
      scope = await this.loadCourierSettlementScope(courierId);
    } catch {
      throw new ServiceUnavailableException(
        FinanceGatewayController.RECEIVE_CHECK_UNAVAILABLE_MESSAGE,
      );
    }
    if (scope.branch_pending_count > 0) {
      throw new BadRequestException(
        `Kuryerda filialga tegishli ${scope.branch_pending_count} ta topshirilmagan savdo bor — ularni filial menejeri qabul qiladi`,
      );
    }
  }

  /**
   * Foydalanuvchi qisqa ma'lumoti (identity) va holati: topildi / 404
   * (soft-delete qilingan) / javob yo'q (timeout, 5xx, bo'sh javob).
   */
  private async lookupUserSummary(userId: string): Promise<UserLookup> {
    let user: Record<string, any> | null | undefined;
    try {
      const response = await this.sendIdentity<{
        data?: Record<string, any> | null;
      }>({ cmd: 'identity.user.find_by_id' }, { id: userId });
      user = response?.data;
    } catch (error) {
      return rpcErrorStatus(error) === 404
        ? { kind: 'not_found' }
        : { kind: 'unavailable' };
    }
    if (!user) {
      return { kind: 'unavailable' };
    }
    return {
      kind: 'found',
      user: {
        id: toText(user.id) || userId,
        name: toText(user.name),
        phone_number: toText(user.phone_number) || null,
        role: this.roleToString(user.role) || null,
        status: toText(user.status) || null,
      },
      isCourier: this.isCourierIdentity(user),
    };
  }

  /** Foydalanuvchi qisqa ma'lumoti (identity). Xato yoki topilmasa — null. */
  private async loadUserSummary(userId: string): Promise<UserSummary | null> {
    const lookup = await this.lookupUserSummary(userId);
    return lookup.kind === 'found' ? lookup.user : null;
  }

  /**
   * C3 — identity'da soft-delete qilingan (404) kuryer uchun `user`. Identity
   * endi hech narsa bermaydi: ism va telefon — filial qatorida bo'lsa o'sha
   * yerdan, aks holda '' / null.
   */
  private deletedCourierSummary(
    courierId: string,
    assignment: BranchAssignment | null,
  ): UserSummary {
    return {
      id: courierId,
      name: assignment?.name ?? '',
      phone_number: assignment?.phone_number ?? null,
      role: RoleEnum.COURIER,
      status: FinanceGatewayController.DELETED_USER_STATUS,
    };
  }

  /**
   * C3 — superadmin/admin uchun kuryer kassasi sahifasi (`cashbox_type=couriers`):
   * ism-familiya va "Qabul qilinishi kerak" summasi router state'siz (F5,
   * ulashilgan havola) ham to'g'ri chiqishi uchun. Qoidalar C4 bilan BIR XIL:
   *   • is_hq_courier — kuryer (tirik bo'lsa identity roli; soft-delete —
   *     identity 404 — bo'lsa filial qatori roli COURIER) va joriy filial
   *     qatori HQ'da;
   *   • can_receive — HQ kuryeri VA filialga tegishli PENDING savdo yo'q;
   *   • olinishi_kerak — can_receive bo'lsa kassadagi musbat balans, aks holda 0;
   *   • receive_check_failed — filial yoki ledger (order) tekshiruvi javob
   *     bermadi: is_hq_courier va can_receive = null (noma'lum),
   *     olinishi_kerak = musbat balans. Frontend formani ogohlantirish bilan
   *     ko'rsatadi, to'lovning o'zi C4 da 503 matni bilan to'xtaydi — sahifa
   *     jimgina "0 / olib bo'lmaydi" demaydi.
   * Identity javob bermasa `user` null va rol `couriers` kassasining o'zidan
   * (kuryer) olinadi; 404 bo'lsa `user.status = 'deleted'`.
   */
  private async buildCourierReceiveInfo(
    courierId: string,
    cashbox: { balance?: unknown } | null | undefined,
    requester?: JwtUser,
  ): Promise<CourierReceiveInfo> {
    const [identity, placement] = await Promise.all([
      this.lookupUserSummary(courierId),
      this.loadCourierPlacement(courierId, requester).catch(() => null),
    ]);
    const isDeletedUser = identity.kind === 'not_found';
    const user =
      identity.kind === 'found'
        ? identity.user
        : isDeletedUser
          ? this.deletedCourierSummary(courierId, placement?.assignment ?? null)
          : null;
    const balance = Number(cashbox?.balance ?? 0);
    const positiveBalance = Number.isFinite(balance) ? Math.max(0, balance) : 0;
    const checked = (
      isHqCourier: boolean,
      canReceive: boolean,
    ): CourierReceiveInfo => ({
      user,
      is_hq_courier: isHqCourier,
      can_receive: canReceive,
      olinishi_kerak: canReceive ? positiveBalance : 0,
      receive_check_failed: false,
      counterparty: 'HQ',
    });
    const checkFailed = (): CourierReceiveInfo => ({
      user,
      is_hq_courier: null,
      can_receive: null,
      olinishi_kerak: positiveBalance,
      receive_check_failed: true,
      counterparty: 'HQ',
    });

    // Tirik, lekin kuryer emas — HQ kuryeri emas (C4: 403); filial natijasi
    // bu yerda ahamiyatsiz.
    if (identity.kind === 'found' && !identity.isCourier) {
      return checked(false, false);
    }
    if (!placement) {
      return checkFailed();
    }
    const { hqBranchId, assignment } = placement;
    const isHqCourier =
      assignment !== null &&
      assignment.branch_id === hqBranchId &&
      (!isDeletedUser ||
        assignment.role === FinanceGatewayController.COURIER_BRANCH_ROLE);
    if (!isHqCourier) {
      return checked(false, false);
    }
    try {
      const scope = await this.loadCourierSettlementScope(courierId);
      return checked(true, scope.branch_pending_count === 0);
    } catch {
      return checkFailed();
    }
  }

  /**
   * Kuryerlarning identity ma'lumoti BITTA so'rovda
   * (`identity.courier.find_by_ids`). Xato bo'lsa bo'sh Map — chaqiruvchi
   * filial qatori ma'lumotiga tushadi. Soft-delete qilingan kuryer bu
   * javobda bo'lmaydi (identity faqat `isDeleted=false` ni qaytaradi).
   */
  private async loadCourierIdentities(
    ids: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const byId = new Map<string, Record<string, unknown>>();
    if (!ids.length) {
      return byId;
    }
    try {
      const response = await this.sendIdentity<{ data?: unknown }>(
        { cmd: 'identity.courier.find_by_ids' },
        { ids },
      );
      const users: unknown[] = Array.isArray(response?.data)
        ? response.data
        : [];
      for (const user of users) {
        if (!user || typeof user !== 'object') {
          continue;
        }
        const record = user as Record<string, unknown>;
        const id = toText(record.id).trim();
        if (id) {
          byId.set(id, record);
        }
      }
    } catch {
      // Identity javob bermadi — ism/telefon filial qatoridan olinadi.
    }
    return byId;
  }

  /**
   * C1 — HQ kuryerlari va ularning kassasidagi naqd (superadmin/admin
   * "Qabul qilinishi kerak" oynasi uchun).
   *
   * ⚠️ GET /couriers ustiga QURILMAYDI: u identity'da 100 talik sahifani
   * filial filtridan OLDIN oladi, ya'ni HQ kuryerlari ro'yxatdan jimgina
   * tushib qolardi. Bu yerda manba — HQ'ning faol `branch_users` qatorlari.
   * Ism/telefon/status: identity (bitta batch so'rov, bo'lsa) → branch_users
   * qatori ma'lumoti (`row.user`) → ''. Soft-delete qilingan kuryerni
   * identity bermaydi, lekin uning qatori va puli qoladi — u ro'yxatda
   * (odatda ismsiz) ko'rinadi va C4 orqali qabul qilinadi. Bloklangan/nofaol
   * kuryer ham qoladi: puli bor ekan, u ko'rinishi shart. Kassa xato bersa
   * balans 0.
   */
  private async buildHqCourierReceivables(requester?: JwtUser) {
    type BranchUserRow = {
      user_id?: string | number | null;
      role?: string | null;
      user?: {
        name?: unknown;
        phone_number?: unknown;
        status?: unknown;
      } | null;
    };
    type CourierCashbox = {
      id?: string | number | null;
      balance?: unknown;
      balance_cash?: unknown;
      balance_card?: unknown;
    };

    const hqBranchId = await this.resolveHqBranchId();
    const branchUsersResponse = await this.sendBranch<{
      data?: BranchUserRow[];
    }>(
      { cmd: 'branch.user.find_by_branch' },
      { branch_id: hqBranchId, requester: this.toRequester(requester) },
    );
    const branchUsers = Array.isArray(branchUsersResponse?.data)
      ? branchUsersResponse.data
      : [];

    const seen = new Set<string>();
    const courierIds: Array<{ userId: string; row: BranchUserRow }> = [];
    for (const row of branchUsers) {
      const userId = String(row?.user_id ?? '').trim();
      if (
        userId &&
        !seen.has(userId) &&
        String(row?.role ?? '').toUpperCase() ===
          FinanceGatewayController.COURIER_BRANCH_ROLE
      ) {
        seen.add(userId);
        courierIds.push({ userId, row });
      }
    }

    const toAmount = (value: unknown) => {
      const amount = Number(value ?? 0);
      return Number.isFinite(amount) ? amount : 0;
    };
    const [identityUsers, cashboxes] = await Promise.all([
      this.loadCourierIdentities(courierIds.map(({ userId }) => userId)),
      Promise.all(
        courierIds.map(({ userId }) =>
          this.send<{ data?: CourierCashbox | null }>(
            { cmd: 'finance.cashbox.find_by_user' },
            { user_id: userId, cashbox_type: Cashbox_type.FOR_COURIER },
          )
            .then((response) => response?.data ?? null)
            .catch(() => null),
        ),
      ),
    ]);
    const items = courierIds.map(({ userId, row }, index) => {
      const cashbox = cashboxes[index];
      // Manba tartibi: identity → branch_users qatori ma'lumoti → ''.
      const identityUser = identityUsers.get(userId) ?? null;
      const rowUser = row?.user ?? null;
      const balance = cashbox?.id ? toAmount(cashbox.balance) : 0;
      return {
        id: userId,
        name: toText(identityUser?.name) || toText(rowUser?.name),
        phone_number:
          toText(identityUser?.phone_number) ||
          toText(rowUser?.phone_number) ||
          null,
        status: toText(identityUser?.status) || toText(rowUser?.status),
        balance,
        cashbox: {
          id: String(cashbox?.id ?? ''),
          balance,
          balance_cash: toAmount(cashbox?.balance_cash),
          balance_card: toAmount(cashbox?.balance_card),
        },
      };
    });

    const receivable = items
      .filter((item) => item.balance > 0)
      .sort((a, b) => b.balance - a.balance || Number(a.id) - Number(b.id));

    return {
      items: receivable,
      total: receivable.length,
      hq_branch_id: hqBranchId,
    };
  }

  private async resolveManagerBranchCashboxId(
    manager: JwtUser | undefined,
    requestedId: string,
  ): Promise<string> {
    if (!manager?.sub) {
      return '';
    }

    const response = await this.sendBranch<{
      data?: { branch_id?: string } | null;
    }>(
      { cmd: 'branch.cashbox.resolve_for_manager' },
      {
        requested_id: requestedId,
        requester: this.toRequester(manager),
      },
    );
    const resolvedBranchId = String(response?.data?.branch_id ?? '');

    const managerBranchId =
      this.extractBranchId(manager) ||
      (await this.resolveBranchIdByUserId(String(manager.sub), manager));
    if (!managerBranchId) {
      return '';
    }

    /**
     * C3 (defense in depth): resolver javobi faqat menejerning O'Z filiali
     * bo'lsa qabul qilinadi. Eski resolver ajdod filiallarni (zanjir doim
     * HQ'ga yetadi) ham qaytarardi — HQ kuryeri id si bilan menejer HQ filial
     * kassasini ko'rardi va naqdini "qabul qila olardi" (audit M7/RBAC-07).
     */
    if (resolvedBranchId) {
      return resolvedBranchId === String(managerBranchId)
        ? resolvedBranchId
        : '';
    }

    /**
     * C3 (audit M7/RBAC-07): FAQAT menejerning o'zi yoki o'z filiali. Ilgari
     * bu yerda ota filial (id si yoki uning menejeri id si) ham ochilardi —
     * ya'ni menejer ota filial (oxir-oqibat HQ) kassasini ko'ra olardi va
     * kuryer id si ota filial id si bilan raqamda mos kelsa, unga kirish
     * berilardi. Ajdodlar endi hisobga olinmaydi.
     */
    if (
      String(requestedId) === String(manager.sub) ||
      String(requestedId) === String(managerBranchId)
    ) {
      return managerBranchId;
    }

    return '';
  }

  private async isUserAssignedToBranch(
    branchId: string,
    userId: string,
    requester?: JwtUser,
  ): Promise<boolean> {
    if (!branchId || !userId) {
      return false;
    }
    try {
      const branchUsersResponse = await this.sendBranch<{ data?: any[] }>(
        { cmd: 'branch.user.find_by_branch' },
        { branch_id: branchId, requester: this.toRequester(requester) },
      );
      const branchUsers = Array.isArray(branchUsersResponse?.data)
        ? branchUsersResponse.data
        : [];
      return branchUsers.some(
        (row: any) => String(row?.user_id ?? '') === String(userId),
      );
    } catch {
      return false;
    }
  }

  private async canManagerAccessUser(
    manager: JwtUser | undefined,
    userId: string,
  ) {
    if (!manager?.sub) {
      return false;
    }
    if (String(userId) === String(manager.sub)) {
      return true;
    }

    const accessibleBranchId = await this.resolveManagerBranchCashboxId(
      manager,
      userId,
    );
    if (accessibleBranchId) {
      return true;
    }

    try {
      let managerBranchId = this.extractBranchId(manager);
      if (!managerBranchId) {
        managerBranchId = await this.resolveBranchIdByUserId(
          String(manager.sub),
          manager,
        );
      }
      if (!managerBranchId) {
        try {
          const managerResponse = await this.sendIdentity<{
            data?: Record<string, any>;
          }>({ cmd: 'identity.user.find_by_id' }, { id: manager.sub });
          managerBranchId = this.extractBranchId(managerResponse?.data);
        } catch {
          managerBranchId = '';
        }
      }
      if (managerBranchId && String(userId) === String(managerBranchId)) {
        return true;
      }

      const userResponse = await this.sendIdentity<{
        data?: Record<string, any>;
      }>({ cmd: 'identity.user.find_by_id' }, { id: userId });
      const targetUser = userResponse?.data;
      if (!targetUser) {
        return false;
      }

      let targetBranchId = this.extractBranchId(targetUser);
      if (!targetBranchId) {
        targetBranchId = await this.resolveBranchIdByUserId(
          String(userId),
          manager,
        );
      }

      if (
        managerBranchId &&
        targetBranchId &&
        managerBranchId === targetBranchId
      ) {
        return true;
      }

      if (managerBranchId) {
        const assigned = await this.isUserAssignedToBranch(
          managerBranchId,
          String(userId),
          manager,
        );
        if (assigned) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  private async loadCashboxHistory(
    cashboxId: string,
    query: {
      page?: number;
      limit?: number;
      sourceTypes?: string;
      source_types?: string;
      fromDate?: string;
      toDate?: string;
    },
  ): Promise<any[]> {
    if (!cashboxId) {
      return [];
    }
    const historyResponse = await this.send(
      { cmd: 'finance.history.find_all' },
      {
        cashbox_id: cashboxId,
        page: query.page,
        limit: query.limit,
        sourceTypes: query.sourceTypes,
        source_types: query.source_types,
        // FE-PAY-04 / C2: sana filtri (Toshkent kuni — finance'da).
        from_date: query.fromDate,
        to_date: query.toDate,
      },
    );
    const histories = historyResponse?.data?.items ?? [];
    return this.attachCreatedByUsers(histories);
  }

  private async buildManagerSettlement(
    user: JwtUser,
    query?: { fromDate?: string; toDate?: string },
  ) {
    let managerBranchId = this.extractBranchId(user);
    if (!managerBranchId) {
      managerBranchId = await this.resolveBranchIdByUserId(
        String(user.sub),
        user,
      );
    }

    const ownCashboxResponse = await this.send(
      { cmd: 'finance.cashbox.my' },
      {
        user_id: user.sub,
        branch_id: managerBranchId || null,
        roles: user.roles ?? [],
        ...query,
      },
    );
    const ownCashbox =
      ownCashboxResponse?.data?.cashbox ?? ownCashboxResponse?.data ?? null;
    const kassa = Number(ownCashbox?.balance ?? 0);

    const managerProfileRes = await this.sendIdentity<{
      data?: Record<string, any>;
    }>({ cmd: 'identity.user.find_by_id' }, { id: user.sub });
    const managerProfile = managerProfileRes?.data ?? {};
    if (!managerBranchId) {
      managerBranchId = this.extractBranchId(managerProfile);
    }

    /**
     * ⚠️ AUDIT C1/C2 — BU BLOK QAYTA YOZILDI.
     *
     * Ilgari bu yerda: har bir kuryer uchun alohida identity chaqiruvi, har
     * biri uchun yana alohida kassa chaqiruvi (20 kuryerli filialda ~45 RMQ
     * borib-kelishi), so'ng `order.find_all` ni IKKI marta 5 000 qator bilan
     * chaqirib (~6 MB ma'lumot) JS'da qo'shib chiqish bor edi. Ikki oqibati:
     *   • sekin — va u order-service bilan bitta event loop'ni bo'lishgani
     *     uchun sotuv kechikishini ham oshirardi;
     *   • NOTO'G'RI — filialning jamlanma buyurtmalari 5 000 dan oshgan kuni
     *     summa jimgina qirqilib, KAM ko'rsata boshlardi.
     *
     * Endi: bitta `identity.courier.find_by_ids` (ro'yxat uchun) va bitta
     * `order.settlement.branch_summary` (yig'indilar bazada SQL SUM bilan).
     */
    let courierIds: string[] = [];
    if (managerBranchId) {
      try {
        const branchUsersResponse = await this.sendBranch<{ data?: any[] }>(
          { cmd: 'branch.user.find_by_branch' },
          { branch_id: managerBranchId, requester: this.toRequester(user) },
        );
        const branchUsers = Array.isArray(branchUsersResponse?.data)
          ? branchUsersResponse.data
          : [];
        courierIds = branchUsers
          .filter(
            (item: any) =>
              String(item?.role ?? '').toUpperCase() === 'COURIER' &&
              item?.user_id,
          )
          .map((item: any) => String(item.user_id));
      } catch {
        // fallthrough: ro'yxatsiz ham yig'indilar filial bo'yicha chiqadi
      }
    }

    const couriers: any[] = courierIds.length
      ? ((
          await this.sendIdentity<{ data?: any[] }>(
            { cmd: 'identity.courier.find_by_ids' },
            { ids: courierIds },
          ).catch(() => null)
        )?.data ?? [])
      : [];

    const settlementSummary = await this.sendOrder<{
      data?: { branch_payable?: number; courier_receivable?: number };
    }>(
      { cmd: 'order.settlement.branch_summary' },
      { branch_id: managerBranchId || null, courier_ids: courierIds },
    ).catch(() => null);

    // Kuryerlar filialga qancha qarz (hali topshirmagan naqd).
    const olinishiKerak = Math.max(
      Number(settlementSummary?.data?.courier_receivable ?? 0),
      0,
    );
    /**
     * Filial HQ'ga qancha qarz. Ledger faqat HQ'ga YETIB KELMAGAN
     * buyurtmalarni sanaydi (topshirilganlari BRANCH_SETTLED bo'lib chiqib
     * ketadi), shuning uchun ilgarigidek "to'langanini ayirish" kerak emas —
     * o'sha ayirish sana oynasiga bog'liq edi va noto'g'ri natija berardi.
     */
    const berilishiKerak = Math.max(
      Number(settlementSummary?.data?.branch_payable ?? 0),
      0,
    );

    const branchToMainHistoryResponse = ownCashbox?.id
      ? await this.send<{
          data?: {
            items?: Array<{
              amount?: number | string;
            }>;
          };
        }>(
          { cmd: 'finance.history.find_all' },
          {
            cashbox_id: String(ownCashbox.id),
            operation_type: Operation_type.EXPENSE,
            source_type: Source_type.BRANCH_TO_MAIN,
            from_date: query?.fromDate,
            to_date: query?.toDate,
            page: 0,
            limit: 0,
          },
        ).catch(() => null)
      : null;
    const paidToHq = (branchToMainHistoryResponse?.data?.items ?? []).reduce(
      (sum, history) => {
        const amount = Number(history?.amount ?? 0);
        return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
      },
      0,
    );
    return {
      kassa,
      olinishi_kerak: olinishiKerak,
      berilishi_kerak: berilishiKerak,
      // Tanlangan davrda HQ'ga topshirilgan summa — ma'lumot uchun.
      hq_ga_tollangan: paidToHq,
      counterparty: 'HQ',
      cashbox: ownCashbox,
      couriers,
    };
  }

  /**
   * j8qCkJhV — filial kassasi ekranidagi hisob-kitob maydonlari BITTA joydan.
   *
   * Ilgari bu blok uch joyda qo'lda takrorlangan va ikkitasida
   * `olinishi_kerak` ga `berilishi_kerak` qiymati yozilgan edi (copy-paste):
   * "kuryerlardan olinishi kerak" ekranda "HQ'ga berilishi kerak" summasini
   * ko'rsatardi. Ikkalasi `buildManagerSettlement` da ALOHIDA hisoblanadi
   * (courier_receivable va branch_payable).
   */
  private toBranchSettlementFields(
    kassadagiSumma: unknown,
    settlement: {
      berilishi_kerak?: unknown;
      olinishi_kerak?: unknown;
      hq_ga_tollangan?: unknown;
      counterparty?: string;
    } | null,
  ) {
    return {
      kassadagi_summa: Number(kassadagiSumma ?? 0),
      berilishi_kerak: Number(settlement?.berilishi_kerak ?? 0),
      olinishi_kerak: Number(settlement?.olinishi_kerak ?? 0),
      hq_ga_tollangan: Number(settlement?.hq_ga_tollangan ?? 0),
      counterparty: settlement?.counterparty ?? 'HQ',
    };
  }

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Finance service health check' })
  health() {
    return this.send({ cmd: 'finance.health' }, {});
  }

  @Post('cashbox')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create cashbox' })
  @ApiBody({ type: CreateCashboxRequestDto })
  createCashbox(@Body() dto: CreateCashboxRequestDto) {
    return this.send({ cmd: 'finance.cashbox.create' }, dto);
  }

  /**
   * C1 — HQ kuryerlari (superadmin/admin ularning naqdini to'g'ridan-to'g'ri
   * Asosiy kassaga qabul qiladi). Statik segment: boshqa `cashbox/...` GET
   * marshrutlaridan OLDIN e'lon qilingan — kelajakda `cashbox/:id` qo'shilsa
   * ham uni tutib qolmasligi uchun.
   */
  @Get('cashbox/hq-couriers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'HQ kuryerlari va kassasidagi naqd (superadmin/admin qabul qiladi)',
  })
  @ApiOkResponse({ type: HqCourierReceivablesResponseDto })
  async hqCourierReceivables(@Req() req: { user: JwtUser }) {
    const data = await this.buildHqCourierReceivables(req?.user);
    return {
      statusCode: 200,
      message: 'HQ kuryerlari (qabul qilinishi kerak)',
      data,
    };
  }

  /**
   * uzWcMR1C — /payments KPI meta sanoqlari (maket «5 ta filial · 2 ta HQ
   * kuryeri», «6 ta marketga» + top-market segbar). 10 000 lik ro'yxat
   * so'ralmaydi: filiallar — `all-info` bilan AYNI manba (`branch.find_all`,
   * faol, HQ bo'lmagan, `olinishi_kerak > 0`), HQ kuryerlari — `hq-couriers`
   * oynasi bilan AYNI to'plam (HQ filialidagi COURIER, kassasi musbat),
   * marketlar — `berilishi_kerak` bilan AYNI qoida (faqat musbat kassalar,
   * audit M16), SQL COUNT/SUM + top N. Faqat o'qish.
   */
  @Get('cashbox/payments-meta')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "To'lovlar KPI meta: filiallar / HQ kuryerlari / qarzdor marketlar soni, top-market taqsimoti",
    description:
      'uzWcMR1C. `receivable.branches` — `all-info.branch_managers_receivable` bilan bir manba (Σ amount teng); ' +
      "`receivable.hq_couriers` — `GET /finance/cashbox/hq-couriers` ro'yxati bilan bir to'plam (count == total); " +
      '`payable` — `all-info.berilishi_kerak` bilan bir qoida (faqat musbat market kassalari): ' +
      '`markets_count`, `amount`, `top_markets[]` (kamayish tartibida, `share` — % ulush), `others` («Yana N ta»). ' +
      'Manba javob bermasa tegishli blok `null` (sahifa ishlayveradi).',
  })
  @ApiOkResponse({
    schema: {
      example: {
        statusCode: 200,
        message: "To'lovlar KPI meta",
        data: {
          receivable: {
            amount: 9870000,
            branches: { count: 5, amount: 8770000 },
            hq_couriers: { count: 2, amount: 1100000 },
          },
          payable: {
            markets_count: 6,
            amount: 13458000,
            top_markets: [
              {
                market_id: '101',
                cashbox_id: '55',
                name: 'Baraka Shop',
                amount: 4800000,
                share: 35.7,
              },
            ],
            others: { count: 3, amount: 3200000, share: 23.8 },
          },
        },
      },
    },
  })
  async paymentsMeta(
    @Query() query: PaymentsMetaQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    const requester = this.toRequester(req?.user);
    const [branchesResponse, hqCourierIds] = await Promise.all([
      this.sendBranch<{
        data?: {
          items?: Array<{ type?: string; olinishi_kerak?: number | string }>;
        };
      }>(
        { cmd: 'branch.find_all' },
        { requester, query: { status: 'active', page: 1, limit: 1000 } },
      ).catch(() => null),
      this.resolveHqBranchId()
        .then((hqBranchId) =>
          this.sendBranch<{
            data?: Array<{
              user_id?: string | number | null;
              role?: string | null;
            }>;
          }>(
            { cmd: 'branch.user.find_by_branch' },
            { branch_id: hqBranchId, requester },
          ),
        )
        .then((response) =>
          Array.from(
            new Set(
              (Array.isArray(response?.data) ? response.data : [])
                .filter(
                  (row) =>
                    String(row?.role ?? '').toUpperCase() ===
                    FinanceGatewayController.COURIER_BRANCH_ROLE,
                )
                .map((row) => String(row?.user_id ?? '').trim())
                .filter(Boolean),
            ),
          ),
        )
        .catch(() => null),
    ]);

    const financeResponse = await this.send<{
      data?: {
        payable?: unknown;
        hq_couriers?: { count?: number; amount?: number };
      };
    }>(
      { cmd: 'finance.cashbox.payments_meta' },
      { hq_courier_ids: hqCourierIds ?? [], top: query?.top ?? 3 },
    );

    let branches: { count: number; amount: number } | null = null;
    if (branchesResponse) {
      branches = { count: 0, amount: 0 };
      for (const branch of branchesResponse?.data?.items ?? []) {
        if (String(branch?.type ?? '').toUpperCase() === 'HQ') continue;
        const amount = Number(branch?.olinishi_kerak ?? 0);
        if (Number.isFinite(amount) && amount > 0) {
          branches.count += 1;
          branches.amount += amount;
        }
      }
      branches.amount = Math.round(branches.amount * 100) / 100;
    }
    const hqCouriers =
      hqCourierIds === null
        ? null
        : {
            count: Number(financeResponse?.data?.hq_couriers?.count ?? 0),
            amount: Number(financeResponse?.data?.hq_couriers?.amount ?? 0),
          };

    return {
      statusCode: 200,
      message: "To'lovlar KPI meta",
      data: {
        receivable: {
          amount:
            Math.round(
              ((branches?.amount ?? 0) + (hqCouriers?.amount ?? 0)) * 100,
            ) / 100,
          branches,
          hq_couriers: hqCouriers,
        },
        payable: financeResponse?.data?.payable ?? null,
      },
    };
  }

  @Get('cashbox/user/:user_id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.MARKET,
    RoleEnum.COURIER,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find cashbox(es) by user' })
  @ApiParam({ name: 'user_id', description: 'User id (bigint string)' })
  @ApiQuery({ name: 'cashbox_type', required: false })
  @ApiQuery({ name: 'with_history', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'fromDate', required: false, example: '2026-10-01' })
  @ApiQuery({ name: 'toDate', required: false, example: '2026-10-01' })
  async findCashboxByUser(
    @Param('user_id') user_id: string,
    @Query() query: FindCashboxByUserQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    const managerBranchCashboxId =
      this.isManager(req?.user) && !this.isPrivileged(req?.user)
        ? await this.resolveManagerBranchCashboxId(req.user, user_id)
        : '';

    if (!this.isPrivileged(req?.user)) {
      if (this.isManager(req?.user)) {
        const managerCanAccess =
          Boolean(managerBranchCashboxId) ||
          (await this.canManagerAccessUser(req?.user, user_id));
        if (!managerCanAccess) {
          throw new ForbiddenException(
            "Siz bu foydalanuvchi kassasini ko'ra olmaysiz",
          );
        }
      } else if (String(user_id) !== String(req?.user?.sub ?? '')) {
        throw new ForbiddenException(
          "Siz faqat o'zingizning kassangizni ko'ra olasiz",
        );
      }
    }
    let isPrivilegedBranchView = false;
    let privilegedBranchSettlement: Awaited<
      ReturnType<FinanceGatewayController['buildManagerSettlement']>
    > | null = null;
    let isPrivilegedMarketView = false;
    let requestQuery: FindCashboxByUserQueryDto = query;
    let requestUserId = user_id;
    if (this.isManager(req?.user) && !this.isPrivileged(req?.user)) {
      /**
       * BE-PAY-14: menejer KURYER kassasini so'rasa (`cashbox_type=couriers`,
       * id — menejerning o'zi ham, filiali ham emas) filial kassasiga
       * ALMASHTIRILMAYDI. Ilgari resolver filialdagi kuryer uchun ham filial
       * id sini qaytargani sababli kuryer sahifasida FILIAL kassasi (barcha
       * kuryer to'lovlari, filial chiqimlari) shu kuryerniki bo'lib
       * ko'rinardi. Kirish huquqi yuqorida allaqachon tekshirilgan.
       */
      const requestsCourierCashbox =
        query.cashbox_type === Cashbox_type.FOR_COURIER &&
        String(user_id) !== String(req.user.sub) &&
        String(user_id) !== String(managerBranchCashboxId);
      if (managerBranchCashboxId && !requestsCourierCashbox) {
        requestUserId = managerBranchCashboxId;
        requestQuery = {
          ...query,
          cashbox_type: Cashbox_type.BRANCH,
        };
      } else if (!query.cashbox_type) {
        requestQuery = {
          ...query,
          cashbox_type: Cashbox_type.FOR_COURIER,
        };
      }
    }
    // j8qCkJhV: prod frontend filial kassasini `cashbox_type=branch` bilan
    // so'raydi — filial hisob-kitob maydonlari shu holda ham qo'shilsin.
    const explicitBranchView = query.cashbox_type === Cashbox_type.BRANCH;
    if (
      this.isPrivileged(req?.user) &&
      (!query.cashbox_type || explicitBranchView)
    ) {
      try {
        await this.sendBranch(
          { cmd: 'branch.find_by_id' },
          { id: user_id, requester: this.toRequester(req.user) },
        );
        isPrivilegedBranchView = true;
        requestQuery = {
          ...query,
          cashbox_type: Cashbox_type.BRANCH,
        };

        const branchUsersResponse = await this.sendBranch<{ data?: any[] }>(
          { cmd: 'branch.user.find_by_branch' },
          {
            branch_id: user_id,
            requester: this.toRequester(req.user),
          },
        );
        const managerAssignment = (
          Array.isArray(branchUsersResponse?.data)
            ? branchUsersResponse.data
            : []
        ).find(
          (item: any) =>
            String(item?.role ?? '').toUpperCase() === 'MANAGER' &&
            item?.user_id,
        );
        if (managerAssignment?.user_id) {
          privilegedBranchSettlement = await this.buildManagerSettlement({
            sub: String(managerAssignment.user_id),
            roles: [RoleEnum.MANAGER],
            branch_id: user_id,
          });
        }
      } catch {
        isPrivilegedBranchView = false;
        privilegedBranchSettlement = null;
        if (explicitBranchView) {
          // Aniq `branch` so'ralgan — market ko'rinishiga o'tkazilmaydi.
          requestQuery = query;
        } else {
          try {
            const userResponse = await this.sendIdentity<{
              data?: Record<string, any>;
            }>({ cmd: 'identity.user.find_by_id' }, { id: user_id });
            const targetRoles = Array.isArray(userResponse?.data?.roles)
              ? userResponse.data.roles
              : userResponse?.data?.role
                ? [userResponse.data.role]
                : [];
            isPrivilegedMarketView = targetRoles.some(
              (role: unknown) =>
                this.roleToString(role).toLowerCase() === RoleEnum.MARKET,
            );
            if (isPrivilegedMarketView) {
              requestQuery = {
                ...query,
                cashbox_type: Cashbox_type.FOR_MARKET,
              };
            }
          } catch {
            isPrivilegedMarketView = false;
          }
        }
      }
    }

    const response = await this.send(
      { cmd: 'finance.cashbox.find_by_user' },
      {
        user_id: requestUserId,
        ...requestQuery,
        history_source_types:
          requestQuery.sourceTypes ?? requestQuery.source_types,
      },
    );

    const withHistory = query.with_history ?? true;
    if (!withHistory) {
      if (isPrivilegedBranchView && response?.data) {
        response.data = {
          cashbox: response.data,
          ...this.toBranchSettlementFields(
            response.data?.balance,
            privilegedBranchSettlement,
          ),
        };
      }
      return response;
    }

    if (Array.isArray(response?.data)) {
      response.data = await Promise.all(
        response.data.map(async (cashbox: any) => ({
          ...cashbox,
          cashboxHistory: await this.loadCashboxHistory(
            String(cashbox?.id ?? ''),
            query,
          ),
        })),
      );
      if (
        this.isManager(req?.user) &&
        String(user_id) === String(req?.user?.sub ?? '')
      ) {
        try {
          const couriersResponse = await this.sendIdentity<{
            data?: { items?: any[] };
          }>(
            { cmd: 'identity.user.find_all' },
            { query: { role: RoleEnum.COURIER, limit: 500, page: 1 } },
          );
          const allCouriers = couriersResponse?.data?.items ?? [];
          response.meta = {
            ...(response.meta ?? {}),
            couriers: allCouriers.filter((courier) => {
              const sameCreator =
                String(courier?.created_by ?? '') === String(req.user.sub);
              const sameBranch =
                String(courier?.branch_id ?? '') &&
                String(courier?.branch_id ?? '') ===
                  String(req.user.branch_id ?? '');
              return sameCreator || sameBranch;
            }),
          };
        } catch {
          response.meta = { ...(response.meta ?? {}), couriers: [] };
        }
      }
      return response;
    }

    if (response?.data?.cashbox && Array.isArray(response?.data?.history)) {
      if (isPrivilegedBranchView) {
        Object.assign(
          response.data,
          this.toBranchSettlementFields(
            response.data.cashbox?.balance,
            privilegedBranchSettlement,
          ),
        );
      }
      // C3: kuryer kassasi sahifasi router state'siz ham ism va summani
      // ko'rsatishi uchun.
      if (requestQuery.cashbox_type === Cashbox_type.FOR_COURIER) {
        if (this.isPrivileged(req?.user)) {
          Object.assign(
            response.data,
            await this.buildCourierReceiveInfo(
              requestUserId,
              response.data.cashbox,
              req.user,
            ),
          );
        } else if (this.isManager(req?.user)) {
          // Menejerga FAQAT `user`: `olinishi_kerak` qo'shilsa cashDetail
          // sahifasidagi menejer balansi hisobi buziladi.
          response.data.user = await this.loadUserSummary(requestUserId);
        }
      }
      const enrichedHistory = await this.attachCreatedByUsers(
        response.data.history,
      );
      response.data.history = enrichedHistory;
      response.data.cashboxHistory = enrichedHistory;
      return response;
    }

    if (
      Array.isArray(response?.data?.cashboxes) &&
      Array.isArray(response?.data?.history)
    ) {
      const enrichedHistory = await this.attachCreatedByUsers(
        response.data.history,
      );
      response.data.history = enrichedHistory;
      response.data.cashboxHistory = enrichedHistory;
      return response;
    }

    if (Array.isArray(response?.data?.history)) {
      response.data.cashboxHistory = await this.attachCreatedByUsers(
        response.data.history,
      );
      return response;
    }

    if (response?.data?.id) {
      response.data.cashboxHistory = await this.loadCashboxHistory(
        String(response.data.id),
        query,
      );
      if (
        this.isManager(req?.user) &&
        String(user_id) === String(req?.user?.sub ?? '')
      ) {
        try {
          const couriersResponse = await this.sendIdentity<{
            data?: { items?: any[] };
          }>(
            { cmd: 'identity.user.find_all' },
            { query: { role: RoleEnum.COURIER, limit: 500, page: 1 } },
          );
          const allCouriers = couriersResponse?.data?.items ?? [];
          response.meta = {
            ...(response.meta ?? {}),
            couriers: allCouriers.filter((courier) => {
              const sameCreator =
                String(courier?.created_by ?? '') === String(req.user.sub);
              const sameBranch =
                String(courier?.branch_id ?? '') &&
                String(courier?.branch_id ?? '') ===
                  String(req.user.branch_id ?? '');
              return sameCreator || sameBranch;
            }),
          };
        } catch {
          response.meta = { ...(response.meta ?? {}), couriers: [] };
        }
      }
      return response;
    }

    return response;
  }

  @Patch('cashbox/balance')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update cashbox balance and create history' })
  @ApiBody({ type: UpdateCashboxBalanceRequestDto })
  updateCashboxBalance(@Body() dto: UpdateCashboxBalanceRequestDto) {
    // (i75GDixP) Qo'lda tuzatish — filial kassasi manfiyga tushmaydi, hatto
    // `source_type: correction/sell` yuborilsa ham. Manfiy ruxsatni faqat
    // order-service outbox'i (`allow_negative: true`) beradi; bu maydon
    // gateway DTO'sida yo'q (forbidNonWhitelisted), shu yerda doim `false`.
    return this.send(
      { cmd: 'finance.cashbox.update_balance' },
      { ...dto, allow_negative: false },
    );
  }

  @Get('cashbox/main')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get main cashbox summary' })
  async getMainCashbox(
    @Query() query: MainCashboxFilterQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    if (this.isManager(req?.user)) {
      const branchId =
        this.extractBranchId(req.user) ||
        (await this.resolveBranchIdByUserId(String(req.user.sub), req.user));
      if (!branchId) {
        throw new ForbiddenException("Managerning branch'i topilmadi");
      }
      return this.send(
        { cmd: 'finance.cashbox.user_by_id' },
        { id: branchId, cashbox_type: Cashbox_type.BRANCH, ...query },
      );
    }

    const response = await this.send({ cmd: 'finance.cashbox.main' }, query);
    const histories = await this.attachCreatedByUsers(
      response?.data?.cashboxHistory ?? [],
    );
    const visibleHistories = histories.filter((history: any) => {
      if (
        String(history?.source_type ?? '') !==
        String(Source_type.COURIER_PAYMENT)
      ) {
        return true;
      }

      const creatorRoles = Array.isArray(history?.createdByUser?.roles)
        ? history.createdByUser.roles
        : history?.createdByUser?.role
          ? [history.createdByUser.role]
          : [];
      return !creatorRoles.some(
        (role: unknown) =>
          this.roleToString(role).toLowerCase() === RoleEnum.MANAGER,
      );
    });

    if (response?.data) {
      response.data.cashboxHistory = visibleHistories;
      response.data.income = visibleHistories.reduce(
        (sum: number, history: any) =>
          String(history?.operation_type ?? '') ===
          String(Operation_type.INCOME)
            ? sum + Number(history?.amount ?? 0)
            : sum,
        0,
      );
      response.data.outcome = visibleHistories.reduce(
        (sum: number, history: any) =>
          String(history?.operation_type ?? '') ===
          String(Operation_type.EXPENSE)
            ? sum + Number(history?.amount ?? 0)
            : sum,
        0,
      );
    }

    return response;
  }

  @Get('cashbox/user/:id/main')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get cashbox by user ID with date filters' })
  @ApiParam({ name: 'id', description: 'User ID (bigint string)' })
  async cashboxByUserId(
    @Param('id') id: string,
    @Query() query: MainCashboxFilterQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    const managerBranchCashboxId =
      this.isManager(req?.user) && !this.isPrivileged(req?.user)
        ? await this.resolveManagerBranchCashboxId(req.user, id)
        : '';

    if (!this.isPrivileged(req?.user)) {
      if (this.isManager(req?.user)) {
        const managerCanAccess =
          Boolean(managerBranchCashboxId) ||
          (await this.canManagerAccessUser(req?.user, id));
        if (!managerCanAccess) {
          throw new ForbiddenException(
            "Siz bu foydalanuvchi kassasini ko'ra olmaysiz",
          );
        }
      } else if (String(id) !== String(req?.user?.sub ?? '')) {
        throw new ForbiddenException(
          "Siz faqat o'zingizning kassangizni ko'ra olasiz",
        );
      }
    }
    if (this.isManager(req?.user) && !this.isPrivileged(req?.user)) {
      if (managerBranchCashboxId) {
        return this.send(
          { cmd: 'finance.cashbox.user_by_id' },
          {
            id: managerBranchCashboxId,
            cashbox_type: Cashbox_type.BRANCH,
            ...query,
          },
        );
      }
      return this.send(
        { cmd: 'finance.cashbox.user_by_id' },
        { id, cashbox_type: Cashbox_type.FOR_COURIER, ...query },
      );
    }
    return this.send({ cmd: 'finance.cashbox.user_by_id' }, { id, ...query });
  }

  @Get('cashbox/my-cashbox')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MARKET, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my cashbox (courier/market)' })
  async myCashbox(
    @Req() req: { user: JwtUser },
    @Query() query: MainCashboxFilterQueryDto,
  ) {
    const isMarket = this.hasRole(req?.user, RoleEnum.MARKET);
    const isManager = this.isManager(req?.user);
    const cashboxType = isMarket
      ? Cashbox_type.FOR_MARKET
      : isManager
        ? Cashbox_type.BRANCH
        : Cashbox_type.FOR_COURIER;
    const branchId = this.isManager(req?.user)
      ? this.extractBranchId(req.user) ||
        (await this.resolveBranchIdByUserId(String(req.user.sub), req.user))
      : null;
    const response = await this.send(
      { cmd: 'finance.cashbox.my' },
      {
        user_id: req.user.sub,
        branch_id: branchId,
        roles: this.getUserRoles(req.user),
        cashbox_type: cashboxType,
        ...query,
      },
    );

    return this.attachCreatedByUsersToHistory(response);
  }

  /**
   * (TMgL1zvq / FJVqcUTv) Mijozning `Idempotency-Key` sarlavhasi — trim
   * qilingan; bo'sh bo'lsa ''. 255 belgidan uzun kalit — 400 (u kassa
   * tarixining dedup ustuniga yoziladi).
   */
  private readIdempotencyKey(idempotencyKey?: string): string {
    const key = String(idempotencyKey ?? '').trim();
    if (key.length > 255) {
      throw new BadRequestException(
        'Idempotency-Key 255 belgidan oshmasligi kerak',
      );
    }
    return key;
  }

  /**
   * (TMgL1zvq) Qo'lda pul o'tkazmasining dedup tokeni.
   *
   * • Kalit bor — aynan shu kalit: ikki marta bosish / retry pulni bir marta
   *   o'tkazadi, takroriy javobda `data.idempotent: true`.
   * • Kalit yo'q — HAR HTTP so'rov uchun YANGI tasodifiy token. Ilgari bu
   *   yerda `floor(Date.now()/30 s)` li barmoq izi edi: ikki HAQIQIY bir xil
   *   to'lov bitta 30 s oynasiga tushsa ikkinchisi jimgina yutilardi (pul
   *   kirmasdi, javob 200). Endi kalitsiz ikki so'rov — ikki alohida to'lov,
   *   soatga bog'liq emas.
   *   Bo'sh token ('') EMAS: u (a) gateway→finance RMQ xabarining qayta
   *   yetkazilishini dedup qilmay qo'yardi (P0-3 himoyasi yo'qolardi),
   *   (b) kassa tarixida `source_id` ni NULL qilardi (unique indeks
   *   himoyasidan chiqib), (c) hamkor daftariga `market:<payment_date>`
   *   kaliti ketib, bir kunlik ikki to'lovdan biri yutilardi.
   */
  private resolveTransferToken(idempotencyKey?: string): string {
    const key = this.readIdempotencyKey(idempotencyKey);
    return key.length > 0 ? key : `gw:${randomUUID()}`;
  }

  // NOTE: the per-order FIFO settlement advance is no longer triggered from the
  // gateway. finance-service now enqueues `order.settlement.advance` via the
  // transactional outbox INSIDE the cashbox-move transaction (Faza 2a), so the
  // advance has at-least-once, retried, DLQ-backed delivery instead of the old
  // best-effort fire-and-forget that silently lost it on any failure.

  @Post('cashbox/payment/courier')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Accept payment from courier' })
  @ApiBody({ type: PaymentFromCourierRequestDto })
  async paymentFromCourier(
    @Req() req: { user: JwtUser },
    @Body() dto: PaymentFromCourierRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const isManager = this.isManager(req?.user);
    let receiverBranchId = '';
    if (isManager) {
      // Audit M4: filial kassasi orqali "Marketga o'tkazma" soxta filial
      // qarzini qoldiradi — menejer bu usulni ishlata olmaydi.
      if (dto.payment_method === PaymentMethod.CLICK_TO_MARKET) {
        throw new ForbiddenException(
          FinanceGatewayController.MANAGER_CLICK_TO_MARKET_MESSAGE,
        );
      }
      receiverBranchId =
        this.extractBranchId(req.user) ||
        (await this.resolveBranchIdByUserId(String(req.user.sub), req.user));
      if (!receiverBranchId) {
        throw new ForbiddenException("Managerning branch'i topilmadi");
      }
      await this.assertCourierUser(dto.courier_id);

      const managerCanAccess = await this.canManagerAccessUser(
        req?.user,
        dto.courier_id,
      );
      if (!managerCanAccess) {
        throw new ForbiddenException(
          "Siz faqat o'z branch'ingiz courieridan to'lov qabul qilasiz",
        );
      }
      // C3: qat'iy — kuryerning faol qatori AYNAN shu filialda.
      await this.assertCourierInManagerBranch(
        dto.courier_id,
        receiverBranchId,
        req.user,
      );
    } else {
      // C4: superadmin/admin — faqat HQ kuryeridan, naqd MAIN'ga (pastda
      // receiver_user_id YUBORILMAYDI). Filial kuryeri → 403. Kuryerlik
      // tekshiruvi (identity; soft-delete bo'lsa filial qatori) shu ichida.
      await this.assertHqCourierReceivable(dto.courier_id, req.user);
    }

    const token = this.resolveTransferToken(idempotencyKey);
    const result = await this.send(
      { cmd: 'finance.cashbox.payment_courier' },
      {
        ...dto,
        created_by: req.user.sub,
        dedup_epoch: token,
        ...(isManager
          ? {
              receiver_user_id: receiverBranchId,
              receiver_cashbox_type: Cashbox_type.BRANCH,
            }
          : {}),
      },
    );
    // courier → branch settlement advance is enqueued by finance-service via the
    // transactional outbox in the same tx as the cashbox move (Faza 2a).
    return result;
  }

  /**
   * (2crjWf7v #4) Kuryer kvitansiyaga javob beradi ("👍 Tasdiqlayman" /
   * "❗️ Noto'g'ri", bot tugmalari). FAQAT audit yozuvi
   * (`finance_schema.courier_payment_acks`) — kassa qoldig'i O'ZGARMAYDI,
   * pul yozuvi yaratilmaydi. Kuryer faqat O'Z kvitansiyasiga (boshqasi 404).
   * Bir kvitansiyaga bitta javob: takror → 200 `already: true`.
   * "disputed" — qabul qilgan xodim + kuryer filiali boshlig'iga bildirishnoma.
   */
  @Post('cashbox/payment/courier/:id/ack')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Kuryer to'lov kvitansiyasiga javob (faqat audit, kassaga ta'sir yo'q)",
  })
  @ApiParam({
    name: 'id',
    description: "Kuryer kassasidagi to'lov (cashbox_history) id si",
  })
  @ApiBody({ type: CourierPaymentAckRequestDto })
  async courierPaymentAck(
    @Req() req: { user: JwtUser },
    @Param('id') id: string,
    @Body() dto: CourierPaymentAckRequestDto,
  ) {
    if (!/^\d{1,20}$/.test(String(id ?? ''))) {
      throw new BadRequestException("To'lov id si noto'g'ri");
    }
    const courierId = String(req.user.sub);
    const notify =
      dto.ack === 'disputed'
        ? await this.courierBranchManagerIds(req.user)
        : [];
    return this.send(
      { cmd: 'finance.cashbox.courier_payment_ack' },
      {
        payment_id: String(id),
        courier_id: courierId,
        ack: dto.ack,
        ...(dto.comment ? { comment: dto.comment } : {}),
        notify_user_ids: notify,
      },
    );
  }

  /**
   * (2crjWf7v) Kuryer filialining boshlig'i (`branches.manager_id`) — kuryerning
   * o'z doirasida (o'z filiali o'qiladi); xato / filialsiz — [].
   */
  private async courierBranchManagerIds(courier: JwtUser): Promise<string[]> {
    try {
      const branchId = await this.resolveOwnBranchId(courier);
      if (!branchId) return [];
      const res = await this.sendBranch<{ data?: { manager_id?: unknown } }>(
        { cmd: 'branch.find_by_id' },
        { id: branchId, requester: this.toRequester(courier) },
        3000,
      );
      const managerId = res?.data?.manager_id;
      return typeof managerId === 'string' || typeof managerId === 'number'
        ? /^\d+$/.test(String(managerId))
          ? [String(managerId)]
          : []
        : [];
    } catch {
      return [];
    }
  }

  @Post('cashbox/payment/market')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Payment to market' })
  @ApiBody({ type: PaymentToMarketRequestDto })
  async paymentToMarket(
    @Req() req: { user: JwtUser },
    @Body() dto: PaymentToMarketRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const token = this.resolveTransferToken(idempotencyKey);
    // (3PE0B03q) "O'tkazma manbasi" finance'ga `transfer_source_user_id`
    // bo'lib boradi — `source_user_id` (kontragent = market) bilan aralashmasin.
    const { source_user_id: transferSourceUserId, ...payment } = dto;
    const result = await this.send(
      { cmd: 'finance.cashbox.payment_market' },
      {
        ...payment,
        created_by: req.user.sub,
        dedup_epoch: token,
        ...(transferSourceUserId
          ? { transfer_source_user_id: transferSourceUserId }
          : {}),
      },
    );
    // HQ → market settlement advance is enqueued by finance-service via the
    // transactional outbox in the same tx as the cashbox move (Faza 2a).
    return result;
  }

  @Post('cashbox/payment/branch-to-main')
  @UseGuards(JwtAuthGuard, RolesGuard)
  // IjqTYQks — ega qarori #7 (2026-10-25 da qayta tasdiqlandi): menejer filial pulini HQ'ga O'TKAZMAYDI, HQ
  // (superadmin/admin) uni «Pul qabul qilish» orqali o'zi oladi. Ilgari MANAGER ham ro'yxatda edi va qaror faqat
  // frontendda bajarilardi (BACKEND_MAP «enforced only by the FE»).
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'HQ receives branch cashbox money into the main cashbox (superadmin/admin only — owner decision #7: managers do not remit to HQ)',
  })
  @ApiBody({ type: PaymentBranchToMainRequestDto })
  async paymentBranchToMain(
    @Req() req: { user: JwtUser },
    @Body() dto: PaymentBranchToMainRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // Guard'ni chetlab o'tadigan chaqiruvlar (unit, ichki) uchun ham — faqat HQ.
    if (!this.isPrivileged(req?.user)) {
      throw new ForbiddenException(BRANCH_TO_MAIN_HQ_ONLY_MESSAGE);
    }
    const branchId = String(dto.branch_id ?? '').trim();

    if (!branchId) {
      throw new ForbiddenException('branch_id yuborilishi shart');
    }

    await this.sendBranch(
      { cmd: 'branch.find_by_id' },
      { id: branchId, requester: this.toRequester(req.user) },
    );

    const token = this.resolveTransferToken(idempotencyKey);
    const result = await this.send(
      { cmd: 'finance.cashbox.payment_branch_main' },
      {
        branch_id: branchId,
        amount: dto.amount,
        payment_method: dto.payment_method,
        payment_date: dto.payment_date,
        comment: dto.comment,
        created_by: req.user.sub,
        dedup_epoch: token,
        // (3PE0B03q) "O'tkazma manbasi" — faqat audit.
        ...(dto.source_user_id
          ? { transfer_source_user_id: dto.source_user_id }
          : {}),
        // 3PE0B03q — CLICK pul asosiy kassaning qaysi nomli kartasiga.
        ...(dto.card_id ? { card_id: dto.card_id } : {}),
        // Zv3MLn0a — CLICK pul filial kassasining qaysi kartasidan chiqdi.
        ...(dto.branch_card_id ? { branch_card_id: dto.branch_card_id } : {}),
      },
    );
    // branch → HQ settlement advance is enqueued by finance-service via the
    // transactional outbox in the same tx as the cashbox move (Faza 2a).
    return result;
  }

  @Get('cashbox/all-info')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all cashboxes total info' })
  async allCashboxesInfo(
    @Query() query: CashboxAllInfoQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    if (this.isManager(req?.user)) {
      const settlement = await this.buildManagerSettlement(req.user, {
        fromDate: (query as any)?.fromDate,
        toDate: (query as any)?.toDate,
      });
      const ownHistoryResponse = await this.send(
        { cmd: 'finance.history.find_all' },
        {
          user_id: settlement.cashbox?.user_id ?? '',
          cashbox_type: Cashbox_type.BRANCH,
          operation_type: query.operationType,
          source_type: query.sourceType,
          created_by: query.createdBy,
          from_date: query.fromDate,
          to_date: query.toDate,
          page: query.page,
          limit: query.limit,
        },
      );
      const page = Number(query?.page ?? 1);
      const limit = Number(query?.limit ?? 20);

      return {
        statusCode: 200,
        message: "Manager cashbox info (faqat o'ziga tegishli)",
        data: {
          ...this.toBranchSettlementFields(settlement.kassa, settlement),
          mainCashboxTotal: 0,
          courierCashboxTotal: settlement.kassa,
          marketCashboxTotal: 0,
          allCashboxHistories: ownHistoryResponse?.data?.items ?? [],
          couriers: settlement.couriers,
          pagination: ownHistoryResponse?.data?.pagination ?? {
            total: Number(ownHistoryResponse?.data?.total ?? 0),
            page,
            limit,
            totalPages: Number(ownHistoryResponse?.data?.totalPages ?? 0),
          },
        },
      };
    }

    const [financeResponse, branchesResponse] = await Promise.all([
      this.send(
        { cmd: 'finance.cashbox.all_info' },
        {
          ...query,
          cashboxType: Cashbox_type.MAIN,
        },
      ),
      this.sendBranch<{
        data?: {
          items?: Array<{
            type?: string;
            olinishi_kerak?: number | string;
          }>;
        };
      }>(
        { cmd: 'branch.find_all' },
        {
          requester: this.toRequester(req.user),
          query: {
            status: 'active',
            page: 1,
            limit: 1000,
          },
        },
      ).catch(() => null),
    ]);

    /**
     * C2 — "Qabul qilinishi kerak" kartasi = filial menejerlari + HQ
     * kuryerlari. HQ qatorining `olinishi_kerak` i branch-service'da
     * HQ kuryerlari kassalarining MUSBAT balanslari yig'indisi sifatida
     * allaqachon hisoblangan (hq-couriers oynasi bilan bir xil formula) —
     * shuning uchun yangi chaqiruv yo'q, /payments sekinlashmaydi.
     */
    const branches = branchesResponse?.data?.items ?? [];
    let branchManagersReceivable = 0;
    let hqCouriersReceivable = 0;
    for (const branch of branches) {
      const amount = Number(branch?.olinishi_kerak ?? 0);
      const positive = Number.isFinite(amount) && amount > 0 ? amount : 0;
      if (String(branch?.type ?? '').toUpperCase() === 'HQ') {
        hqCouriersReceivable += positive;
      } else {
        branchManagersReceivable += positive;
      }
    }
    const totalReceivable = branchManagersReceivable + hqCouriersReceivable;

    if (financeResponse?.data) {
      financeResponse.data.kassadagi_summa = Number(
        financeResponse.data.mainCashboxTotal ?? 0,
      );
      // Audit M16: "Berilishi kerak" — faqat MUSBAT market kassalari (HQ
      // to'lashi kerak). Imzoli `marketCashboxTotal` HQ'ga qarzdor marketlarni
      // boshqa marketlarga qarzdan ayirib, kartani kam ko'rsatardi. Eski
      // finance javobida maydon bo'lmasa — avvalgi qiymat.
      financeResponse.data.berilishi_kerak = Number(
        financeResponse.data.marketPayableTotal ??
          financeResponse.data.marketCashboxTotal ??
          0,
      );
      financeResponse.data.branch_managers_receivable =
        branchManagersReceivable;
      financeResponse.data.hq_couriers_receivable = hqCouriersReceivable;
      financeResponse.data.olinishi_kerak = totalReceivable;
      financeResponse.data.courierCashboxTotal = totalReceivable;
    }

    return financeResponse;
  }

  @Get('cashbox/manager/settlement')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Manager cashbox settlement (HQ bilan hisob-kitob)',
  })
  async managerSettlement(
    @Req() req: { user: JwtUser },
    @Query() query: MainCashboxFilterQueryDto,
  ) {
    const settlement = await this.buildManagerSettlement(req.user, query);
    const cash = Number(settlement?.cashbox?.balance_cash ?? 0);
    const card = Number(settlement?.cashbox?.balance_card ?? 0);

    return {
      statusCode: 200,
      message: 'Manager settlement (HQ bilan) hisoblandi',
      data: {
        counterparty: settlement.counterparty,
        kassa: { cash, card, total: settlement.kassa },
        berilishi_kerak: settlement.berilishi_kerak,
        olinishi_kerak: settlement.olinishi_kerak,
        // j8qCkJhV — hisoblangan, lekin ilgari javobdan tashlab yuborilardi.
        hq_ga_tollangan: settlement.hq_ga_tollangan,
        cashbox: settlement.cashbox,
      },
    };
  }

  @Get('cashbox/manager/payable-to-hq')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Managerdan HQga berilishi kerak summa' })
  async managerPayableToHq(
    @Req() req: { user: JwtUser },
    @Query() query: MainCashboxFilterQueryDto,
  ) {
    const settlement = await this.buildManagerSettlement(req.user, query);

    return {
      statusCode: 200,
      message: 'Manager -> HQ berilishi kerak summa',
      data: {
        counterparty: settlement.counterparty,
        berilishi_kerak: settlement.berilishi_kerak,
      },
    };
  }

  /**
   * ⚠️ KOMPANIYA HOLATI FAQAT finance-service'da hisoblanadi (AUDIT M1/M5).
   *
   * Ilgari (2026-06-12) bu yerda gateway'ning o'z formulasi bor edi:
   * `main + faol HQ bo'lmagan filiallar olinishi_kerak − market qarzi`.
   * Unda HQ kuryerlaridagi naqd (masalan #109 — 44 980 000 kuryer 119 da)
   * va kargo qarzi umuman sanalmasdi, marketga qarz esa sotuv paytidayoq
   * yozilardi — balans yo'q qarz bilan manfiyga og'ardi. "Kuryerlar"
   * kartasiga ham filial qarzi yozilardi.
   *
   * finance-service `main + chain_receivable + provider_receivable −
   * market_cashbox_payable` ni har buyurtmani BIR MARTA sanab hisoblaydi va
   * `couriers.couriersTotalBalanse` ga kuryer kassalarining haqiqiy
   * yig'indisini beradi. Ikki raqobatdosh nusxa bo'lmasligi uchun gateway
   * faqat uzatadi.
   */
  @Get('cashbox/financial-balanse')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get financial balance' })
  financialBalance() {
    // G1 / financial-balance-lists — sahifa "Marketlar" va "Kuryerlar"
    // ro'yxatlarini chizadi (`markets.allMarketCashboxes`,
    // `couriers.allCourierCashboxes`); ular faqat shu flag bilan to'ldiriladi.
    return this.send(
      { cmd: 'finance.cashbox.financial_balance' },
      { include_party_lists: true },
    );
  }

  // --- Financial balance ledger (company-wide P&L history) ---

  @Post('financial-balance/entries')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Record a manual financial ledger entry (income/expense/bills/salary/correction)',
  })
  @ApiBody({ type: RecordFinancialBalanceRequestDto })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ description: 'Ledger entry recorded' })
  @ApiOkResponse({ description: 'Zero amount skipped; no ledger entry' })
  recordFinancialBalance(
    @Body() dto: RecordFinancialBalanceRequestDto,
    @Req() req: { user?: JwtUser },
    @Headers('idempotency-key') idempotencyKey?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const clientKey = String(idempotencyKey ?? '').trim();
    if (!clientKey || clientKey.length > 255) {
      throw new BadRequestException('Idempotency-Key must be 1-255 characters');
    }
    const actorId = String(req.user?.sub ?? '');
    return this.send<{ statusCode?: number; data?: unknown }>(
      { cmd: 'finance.financial_balance.record' },
      {
        ...dto,
        created_by: req.user?.sub ?? null,
        // (cSNJN7GP) Mijoz kaliti tizim kalitlari (`investor-profit:<id>`,
        // `operator-payment:<id>` — ular ham buyurtmasiz, ayni
        // (source_type, dedup_key) unikal indeksida) bilan to'qnashmasin:
        // aks holda admin yuborgan kalit investor to'lovining P&L yozuvini
        // "takroriy" deb yutib yuborishi mumkin edi. Aktor bo'yicha nom
        // fazosi — boshqa adminning kaliti ham to'qnashmaydi.
        dedup_key: `manual-entry:${actorId}:${clientKey}`,
      },
    ).then((result) => {
      // (cSNJN7GP) Nol summa (yozuv yo'q) va takroriy kalit (mavjud yozuv
      // qaytadi) — finance 200; HTTP ham 200 (yangi yozuv — 201).
      if (result?.statusCode === 200) {
        res?.status(200);
      }
      return result;
    });
  }

  @Get('financial-balance/history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List financial balance ledger entries + current balance',
  })
  @ApiQuery({
    name: 'source_type',
    required: false,
    enum: FinancialSource_type,
  })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'fromDate', required: false })
  @ApiQuery({ name: 'toDate', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  async financialBalanceHistory(
    @Query(
      'source_type',
      new ParseEnumPipe(FinancialSource_type, { optional: true }),
    )
    source_type?: FinancialSource_type,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const normalizedLimit = limit ? Number(limit) : undefined;
    const normalizedPage = page ? Math.max(Number(page), 1) : undefined;
    const normalizedOffset = offset
      ? Number(offset)
      : normalizedPage && normalizedLimit
        ? (normalizedPage - 1) * normalizedLimit
        : undefined;

    const response = await this.send(
      { cmd: 'finance.financial_balance.history' },
      {
        source_type,
        from_date: from_date ?? fromDate,
        to_date: to_date ?? toDate,
        limit: normalizedLimit,
        offset: normalizedOffset,
      },
    );
    return this.attachFinancialActors(response);
  }

  @Get('financial-balance/analytics')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get financial balance analytics and impact analysis',
  })
  @ApiQuery({ name: 'fromDate', required: false })
  @ApiQuery({ name: 'toDate', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  financialBalanceAnalytics(
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
  ) {
    return this.send(
      { cmd: 'finance.financial_balance.analytics' },
      {
        from_date: from_date ?? fromDate,
        to_date: to_date ?? toDate,
      },
    );
  }

  @Get('financial-balance/top-impacts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Paginated top-impact financial balance transactions',
    description:
      'guzrGySp — `data.items[]` qatorlarida `created_by_user` (`{ id, name, role }` yoki avtomatik yozuvda `null`) — `financial-balance/history` bilan bir xil.',
  })
  @ApiQuery({ name: 'fromDate', required: false })
  @ApiQuery({ name: 'toDate', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async financialBalanceTopImpacts(
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const response = await this.send<unknown>(
      { cmd: 'finance.financial_balance.top_impacts' },
      {
        from_date: from_date ?? fromDate,
        to_date: to_date ?? toDate,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      },
    );
    // (guzrGySp) «Kiritgan» ustuni — history bilan bir xil minimal aktor.
    return (await this.attachFinancialActors(response)) as unknown;
  }

  /**
   * qzjTMWPb — Balans sahifasi: KPI kartalari (Kassa, Yo'ldagi pul, Marketlar
   * qarzi, Umumiy balans) uchun kunlik snapshot qatori («kechaga nisbatan»,
   * 14 kunlik chiziq) + P&L daftarining kunlik kirim/chiqim va kun oxiri
   * qoldig'i («Daftar qoldig'i», «Davr boshida», «Eng yuqori», waterfall
   * «Davr boshi» o'tgan davr uchun ham). Rollar — boshqa
   * `financial-balance/*` bilan AYNI (superadmin, admin). Faqat o'qish.
   */
  @Get('financial-balance/daily')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Balans: kunlik snapshot va daftar qoldig'i",
    description:
      'qzjTMWPb. `days[].snapshot` — kun OXIRIDAGI kompaniya holati (bugun uchun `null`: jonli qiymat ' +
      "`GET /finance/cashbox/financial-balanse` dan). Kartalar: Kassa = `main_balance`, Yo'ldagi pul = `in_transit` " +
      '(`chain_receivable + provider_receivable`), Marketlar qarzi = `markets_debt` (= −`market_cashbox_total`), ' +
      'Umumiy balans = `current_situation`. `source: backfill` kunlarida (tarixdan qayta qurilgan) `chain_receivable`, ' +
      "`provider_receivable`, `in_transit`, `current_situation` = `null` — ularni tarixdan tiklab bo'lmaydi; kassa " +
      "yig'indilari aniq. «Kechaga nisbatan» = jonli − `days[kecha].snapshot`. `previous_day` — `from_date` dan oldingi " +
      "kun snapshot'i. `days[].ledger` — P&L daftari: `opening_balance`/`closing_balance` (kun boshi/oxiri), " +
      "`income`/`expense`/`net`/`count`; `ledger.opening_balance` — davr boshi, `ledger.peak` — eng yuqori kun oxiri qoldig'i.",
  })
  @ApiOkResponse({
    schema: {
      example: {
        statusCode: 200,
        message: 'Kunlik moliyaviy balans',
        data: {
          timezone: 'Asia/Tashkent',
          from: '2026-10-01',
          to: '2026-10-08',
          last_snapshot_date: '2026-10-07',
          previous_day: { date: '2026-09-30', snapshot: null },
          ledger: {
            opening_balance: 7507000,
            closing_balance: 8437500,
            income: 9836500,
            expense: 8906000,
            net: 930500,
            count: 186,
            peak: { date: '2026-10-06', balance: 15805000 },
          },
          days: [
            {
              date: '2026-10-07',
              snapshot: {
                source: 'live',
                captured_at: '2026-10-07T19:05:00.000Z',
                main_balance: 23700000,
                main_balance_cash: 17500000,
                main_balance_card: 6200000,
                chain_receivable: 11000000,
                provider_receivable: 1150000,
                in_transit: 12150000,
                market_cashbox_total: 12300000,
                market_payable_total: 12400000,
                markets_debt: -12300000,
                courier_cashbox_total: 3100000,
                branch_cashbox_total: 2400000,
                current_situation: 23550000,
                ledger_balance: 8410500,
              },
              ledger: {
                opening_balance: 11878500,
                closing_balance: 8410500,
                income: 32000,
                expense: 3500000,
                net: -3468000,
                count: 2,
              },
            },
          ],
        },
      },
    },
  })
  financialBalanceDaily(@Query() query: FinancialBalanceDailyQueryDto) {
    return this.send(
      { cmd: 'finance.financial_balance.daily' },
      {
        from_date: query?.from_date ?? query?.fromDate,
        to_date: query?.to_date ?? query?.toDate,
      },
    );
  }

  @Patch('cashbox/spend')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Spend money from main cashbox',
    description:
      "Elchi Pochta №1 — `expense_category_id` MAJBURIY (`GET /finance/cashbox/expense-categories`, raqamli satr): yo'q/bo'sh/raqam emas → 400 «Xarajat kategoriyasini tanlang»; mavjud va o'chirilmagan bo'lishi shart (aks holda 400). `comment` ixtiyoriy. `data.history` va kassa tarixi qatorlarida `expense_category_id` + `expense_category_name` (snapshot).",
  })
  @ApiBody({ type: MainCashboxSpendRequestDto })
  async spendMoney(
    @Req() req: { user: JwtUser },
    @Body() dto: MainCashboxSpendRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const isManager = this.isManager(req?.user);
    const branchId = isManager
      ? this.extractBranchId(req.user) ||
        (await this.resolveBranchIdByUserId(String(req.user.sub), req.user))
      : '';
    if (isManager && !branchId) {
      throw new ForbiddenException("Managerning branch'i topilmadi");
    }
    const targetUserId = isManager ? branchId : req.user.sub;
    const token = this.resolveTransferToken(idempotencyKey);
    return this.send(
      { cmd: 'finance.cashbox.spend' },
      {
        ...dto,
        user_id: targetUserId,
        created_by: req.user.sub,
        dedup_epoch: token,
        ...(isManager ? { cashbox_type: Cashbox_type.BRANCH } : {}),
        // IgR4FVsR — qo'lda operatsiya P&L daftariga AYNI tranzaksiyada
        // yoziladi (alohida POST /financial-balance/entries KERAK EMAS).
        financial_ledger: true,
      },
    );
  }

  @Patch('cashbox/fill')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Fill main cashbox' })
  @ApiBody({ type: MainCashboxManualRequestDto })
  async fillCashbox(
    @Req() req: { user: JwtUser },
    @Body() dto: MainCashboxManualRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const isManager = this.isManager(req?.user);
    const branchId = isManager
      ? this.extractBranchId(req.user) ||
        (await this.resolveBranchIdByUserId(String(req.user.sub), req.user))
      : '';
    if (isManager && !branchId) {
      throw new ForbiddenException("Managerning branch'i topilmadi");
    }
    const targetUserId = isManager ? branchId : req.user.sub;
    const token = this.resolveTransferToken(idempotencyKey);
    return this.send(
      { cmd: 'finance.cashbox.fill' },
      {
        ...dto,
        user_id: targetUserId,
        created_by: req.user.sub,
        dedup_epoch: token,
        ...(isManager ? { cashbox_type: Cashbox_type.BRANCH } : {}),
        // IgR4FVsR — qo'lda operatsiya P&L daftariga AYNI tranzaksiyada
        // yoziladi (alohida POST /financial-balance/entries KERAK EMAS).
        financial_ledger: true,
      },
    );
  }

  @Get('history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
    RoleEnum.COURIER,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Find cashbox history list',
    description:
      'GaBIPi3Z (2-band): `data.counts` — `{ all, income, expense }` tab sonlari («Barchasi / Kirim / Chiqim»): ' +
      'AYNI filtrlar va rol doirasi (kassa, kassa turi, manba, sana, foydalanuvchi), faqat `operation_type` SIZ — ' +
      "tanlangan tabdan qat'i nazar. `all = income + expense`. `pagination.total` — joriy (tabli) ro'yxat jami.",
  })
  @ApiOkResponse({
    schema: {
      example: {
        statusCode: 200,
        message: 'Cashbox histories',
        data: {
          items: [],
          counts: { all: 11, income: 9, expense: 2 },
          pagination: { total: 2, page: 1, limit: 20, totalPages: 1 },
        },
      },
    },
  })
  @ApiQuery({ name: 'cashbox_id', required: false })
  @ApiQuery({ name: 'user_id', required: false })
  @ApiQuery({
    name: 'cashbox_type',
    required: false,
    enum: Cashbox_type,
  })
  @ApiQuery({
    name: 'cashboxType',
    required: false,
    enum: Cashbox_type,
  })
  @ApiQuery({ name: 'operation_type', required: false })
  @ApiQuery({ name: 'source_type', required: false })
  @ApiQuery({ name: 'source_id', required: false })
  @ApiQuery({ name: 'source_user_id', required: false })
  @ApiQuery({ name: 'created_by', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async findHistory(
    @Query() query: FindHistoryQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    if (
      this.hasRole(req?.user, RoleEnum.MARKET) &&
      !this.isPrivileged(req?.user)
    ) {
      return this.attachCreatedByUsersToHistoryResponse(
        await this.send(
          { cmd: 'finance.history.find_all' },
          {
            ...query,
            user_id: String(req.user.sub),
            cashbox_type: Cashbox_type.FOR_MARKET,
          },
        ),
      );
    }

    if (
      this.hasRole(req?.user, RoleEnum.COURIER) &&
      !this.isPrivileged(req?.user)
    ) {
      return this.attachCreatedByUsersToHistoryResponse(
        await this.send(
          { cmd: 'finance.history.find_all' },
          {
            ...query,
            user_id: String(req.user.sub),
            cashbox_type: Cashbox_type.FOR_COURIER,
          },
        ),
      );
    }

    if (
      this.hasRole(req?.user, RoleEnum.MANAGER) &&
      !this.isPrivileged(req?.user)
    ) {
      const branchId =
        this.extractBranchId(req.user) ||
        (await this.resolveBranchIdByUserId(String(req.user.sub), req.user));
      if (!branchId) {
        throw new ForbiddenException("Managerning branch'i topilmadi");
      }
      const isBranchToMainHistory =
        String(query?.source_type ?? '') === String(Source_type.BRANCH_TO_MAIN);

      const historyResponse = await this.send(
        { cmd: 'finance.history.find_all' },
        isBranchToMainHistory
          ? {
              ...query,
              user_id: branchId,
              cashbox_type: Cashbox_type.BRANCH,
              source_type: Source_type.BRANCH_TO_MAIN,
              operation_type: Operation_type.EXPENSE,
            }
          : {
              ...query,
              user_id: branchId,
              cashbox_type: Cashbox_type.BRANCH,
            },
      );

      const items = historyResponse?.data?.items;
      if (isBranchToMainHistory && Array.isArray(items) && items.length === 0) {
        const settlement = await this.buildManagerSettlement(req.user, {
          fromDate: query?.from_date,
          toDate: query?.to_date,
        });
        const pendingAmount = Number(settlement?.berilishi_kerak ?? 0);
        if (pendingAmount > 0) {
          historyResponse.data.items = [
            {
              id: `pending-branch-to-hq-${branchId}`,
              is_virtual: true,
              status: 'pending',
              operation_type: Operation_type.EXPENSE,
              cashbox_id: settlement?.cashbox?.id ?? null,
              source_type: Source_type.BRANCH_TO_MAIN,
              source_id: null,
              source_user_id: branchId,
              amount: pendingAmount,
              balance_after: settlement?.cashbox?.balance ?? 0,
              balance_cash_after: settlement?.cashbox?.balance_cash ?? null,
              balance_card_after: settlement?.cashbox?.balance_card ?? null,
              payment_method: null,
              comment: 'HQ ga berilishi kerak',
              created_by: req.user.sub,
              payment_date: null,
              cashbox: settlement?.cashbox ?? null,
            },
          ];
          historyResponse.data.pagination = {
            ...(historyResponse.data.pagination ?? {}),
            total: 1,
            page: Number(query?.page ?? 1),
            limit: Number(query?.limit ?? 20),
            totalPages: 1,
          };
        }
      }

      return this.attachCreatedByUsersToHistoryResponse(historyResponse);
    }

    /**
     * CODE-08 (C11): registrator FAQAT o'z filiali kassasining tarixini
     * ko'radi. Ilgari u quyidagi umumiy yo'lga tushardi va istalgan kassa
     * (MAIN, kuryer, market, boshqa filiallar) tarixini o'qiy olardi.
     */
    if (
      this.hasRole(req?.user, RoleEnum.REGISTRATOR) &&
      !this.isPrivileged(req?.user)
    ) {
      const branchId = await this.resolveOwnBranchId(req.user);
      if (!branchId) {
        throw new ForbiddenException('Registratorning filiali topilmadi');
      }
      return this.attachCreatedByUsersToHistoryResponse(
        await this.send(
          { cmd: 'finance.history.find_all' },
          {
            ...query,
            user_id: branchId,
            cashbox_type: Cashbox_type.BRANCH,
          },
        ),
      );
    }

    const hasCashboxSelector = Boolean(
      query.cashbox_id ||
      query.user_id ||
      query.cashbox_type ||
      query.cashboxType,
    );

    return this.attachCreatedByUsersToHistoryResponse(
      await this.send(
        { cmd: 'finance.history.find_all' },
        hasCashboxSelector
          ? query
          : { ...query, cashbox_type: Cashbox_type.MAIN },
      ),
    );
  }

  /**
   * qzjTMWPb — kunlik kirim/chiqim agregati + kun boshi / oxiri qoldig'i
   * (maket «Pul oqimi», «Kassa oqimi», «Balans dinamikasi», «kechaga
   * nisbatan», sparkline; M5 — kassa tafsilotidagi «Davr boshida» server
   * tomonidan, 100 qatorga bog'liq emas).
   *
   * ROL DOIRASI — `GET /finance/history` bilan AYNI: market / kuryer — faqat
   * o'z kassasi; menejer / registrator — o'z filiali kassasi; superadmin /
   * admin — istalgan tanlov (`cashbox_id` / `user_id` / `cashbox_type`),
   * hech biri bo'lmasa Asosiy kassa. Menejer `cashbox_type=couriers&user_id=`
   * bilan o'z filiali kuryerining kassasini ham so'ray oladi —
   * `GET /finance/cashbox/user/:user_id` bilan AYNI ruxsat tekshiruvi.
   * LOGIST va boshqa rollar — 403 (RolesGuard). Faqat o'qish.
   *
   * ⚠️ `history/:id` dan OLDIN e'lon qilingan (aks holda 'daily' id deb
   * tutilardi).
   */
  @Get('history/daily')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
    RoleEnum.COURIER,
    RoleEnum.MARKET,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Kassa: kunlik kirim/chiqim va kun boshi/oxiri qoldig'i",
    description:
      "qzjTMWPb. Toshkent kunlari bo'yicha `days[]`: `income`, `expense`, `net`, `income_count`, `expense_count` " +
      "(cashbox_history'dan jonli, filtrlar bilan — /finance/history bilan bir xil filtr ma'nosi) va " +
      "`opening_balance` / `closing_balance` (kassa doirasining kun boshi/oxiri qoldig'i — manba/tur/yaratgan filtriga " +
      "BOG'LIQ EMAS). `opening_balance` (davr boshi) = `from_date` dan oldingi kun oxiri; `closing_balance` = oxirgi " +
      "o'tgan kun yoki bugun (jonli). Kelajak kunlari qoldig'i `null`. `balance_status`: `ok`; `pending` — kunlik " +
      'snapshot hali qurilmagan (deploydan keyingi birinchi daqiqalar) — qoldiqlar `null`, oqimlar bor; `partial` — ' +
      'snapshot orqada (catch-up davom etyapti). «Kechaga nisbatan» = bugungi `closing_balance` − kechagi `closing_balance`. ' +
      "Sukut oraliq — oxirgi 14 kun; ko'pi bilan 366 kun.",
  })
  @ApiOkResponse({
    schema: {
      example: {
        statusCode: 200,
        message: 'Kunlik kirim/chiqim',
        data: {
          timezone: 'Asia/Tashkent',
          from: '2026-10-01',
          to: '2026-10-08',
          scope: { cashbox_type: 'main', cashbox_ids: null },
          filtered: false,
          balance_status: 'ok',
          last_snapshot_date: '2026-10-07',
          opening_balance: 7507000,
          closing_balance: 24615000,
          totals: {
            income: 41260000,
            expense: 23940000,
            net: 17320000,
            income_count: 71,
            expense_count: 57,
          },
          days: [
            {
              date: '2026-10-08',
              income: 6970000,
              expense: 2400000,
              net: 4570000,
              income_count: 9,
              expense_count: 3,
              opening_balance: 20045000,
              closing_balance: 24615000,
            },
          ],
        },
      },
    },
  })
  async historyDaily(
    @Query() query: HistoryDailyQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    const user = req?.user;
    const filters = {
      from_date: query?.from_date ?? query?.fromDate,
      to_date: query?.to_date ?? query?.toDate,
      operation_type: query?.operation_type,
      source_type: query?.source_type,
      source_types: query?.source_types ?? query?.sourceTypes,
      source_user_id: query?.source_user_id,
      created_by: query?.created_by,
    };
    const send = (scope: Record<string, unknown>) =>
      this.send({ cmd: 'finance.history.daily' }, { ...filters, ...scope });

    if (!this.isPrivileged(user)) {
      if (this.hasRole(user, RoleEnum.MARKET)) {
        return send({
          user_id: String(user.sub),
          cashbox_type: Cashbox_type.FOR_MARKET,
        });
      }
      if (this.hasRole(user, RoleEnum.COURIER)) {
        return send({
          user_id: String(user.sub),
          cashbox_type: Cashbox_type.FOR_COURIER,
        });
      }
      if (this.hasRole(user, RoleEnum.MANAGER)) {
        const requestedType = query?.cashbox_type ?? query?.cashboxType;
        if (
          requestedType === Cashbox_type.FOR_COURIER &&
          query?.user_id &&
          String(query.user_id) !== String(user.sub)
        ) {
          if (!(await this.canManagerAccessUser(user, query.user_id))) {
            throw new ForbiddenException(
              "Siz bu foydalanuvchi kassasini ko'ra olmaysiz",
            );
          }
          return send({
            user_id: String(query.user_id),
            cashbox_type: Cashbox_type.FOR_COURIER,
          });
        }
        const branchId =
          this.extractBranchId(user) ||
          (await this.resolveBranchIdByUserId(String(user.sub), user));
        if (!branchId) {
          throw new ForbiddenException("Managerning branch'i topilmadi");
        }
        return send({ user_id: branchId, cashbox_type: Cashbox_type.BRANCH });
      }
      if (this.hasRole(user, RoleEnum.REGISTRATOR)) {
        const branchId = await this.resolveOwnBranchId(user);
        if (!branchId) {
          throw new ForbiddenException('Registratorning filiali topilmadi');
        }
        return send({ user_id: branchId, cashbox_type: Cashbox_type.BRANCH });
      }
      throw new ForbiddenException("Bu ma'lumot sizga ruxsat etilmagan");
    }

    const cashboxType = query?.cashbox_type ?? query?.cashboxType;
    const hasSelector = Boolean(
      query?.cashbox_id || query?.user_id || cashboxType,
    );
    return send(
      hasSelector
        ? {
            cashbox_id: query?.cashbox_id,
            user_id: query?.user_id,
            cashbox_type: cashboxType,
          }
        : { cashbox_type: Cashbox_type.MAIN },
    );
  }

  @Get('history/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.COURIER,
    RoleEnum.MARKET,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find cashbox history detail by id' })
  @ApiParam({ name: 'id', description: 'History id (bigint string)' })
  async findHistoryById(
    @Param('id') id: string,
    @Req() req: { user: JwtUser },
  ) {
    const response = await this.send(
      { cmd: 'finance.history.find_by_id' },
      { id },
    );

    if (this.isPrivileged(req?.user)) {
      return response;
    }

    const cashbox = response?.data?.cashbox;
    if (this.isManager(req?.user)) {
      if (cashbox?.cashbox_type === Cashbox_type.FOR_COURIER) {
        // (2crjWf7v) menejer o'z filiali kuryerining kassa yozuvini ochadi — ro'yxat
        // (`GET cashbox/user/:id?cashbox_type=couriers`) bilan bir xil qoida
        // (`canManagerAccessUser`). Ilgari ro'yxat ochilib, yozuv tafsiloti 403 edi.
        const courierId = String(cashbox?.user_id ?? '');
        if (
          !courierId ||
          !(await this.canManagerAccessUser(req.user, courierId))
        ) {
          throw new ForbiddenException(
            "Siz faqat o'z filialingiz kuryerlari tarixini ko'ra olasiz",
          );
        }
      } else {
        const branchId =
          this.extractBranchId(req.user) ||
          (await this.resolveBranchIdByUserId(String(req.user.sub), req.user));
        if (
          !branchId ||
          String(cashbox?.user_id ?? '') !== String(branchId) ||
          cashbox?.cashbox_type !== Cashbox_type.BRANCH
        ) {
          throw new ForbiddenException(
            "Siz faqat o'z branch'ingiz tarixini ko'ra olasiz",
          );
        }
      }
    } else if (
      this.hasRole(req?.user, RoleEnum.COURIER) ||
      this.hasRole(req?.user, RoleEnum.MARKET)
    ) {
      const expectedCashboxType = this.hasRole(req?.user, RoleEnum.MARKET)
        ? Cashbox_type.FOR_MARKET
        : Cashbox_type.FOR_COURIER;

      if (
        String(cashbox?.user_id ?? '') !== String(req.user.sub) ||
        cashbox?.cashbox_type !== expectedCashboxType
      ) {
        throw new ForbiddenException(
          "Siz faqat o'zingizning kassa tarixingizni ko'ra olasiz",
        );
      }
    } else if (this.hasRole(req?.user, RoleEnum.REGISTRATOR)) {
      // CODE-08 (C11): registrator — faqat o'z filiali kassasi yozuvi.
      const branchId = await this.resolveOwnBranchId(req.user);
      if (
        !branchId ||
        String(cashbox?.user_id ?? '') !== String(branchId) ||
        cashbox?.cashbox_type !== Cashbox_type.BRANCH
      ) {
        throw new ForbiddenException(
          "Siz faqat o'z filialingiz kassa tarixini ko'ra olasiz",
        );
      }
    } else {
      // Boshqa (kutilmagan) rol — yopiq: begona kassa yozuvi qaytmaydi.
      throw new ForbiddenException("Siz bu kassa tarixini ko'ra olmaysiz");
    }

    // kH2zZsz3 (tekshiruv #1): SELL/CANCEL/EXTRA_COST/CORRECTION yozuvi
    // `data.order` ga `order.find_by_id_enriched` qatorini TO'LIQ qo'shadi —
    // ilgari kuryer o'z kassasi yozuvi orqali market tarifi/filial ulushini,
    // market esa kuryer tarifi/ulushini olardi. GET /orders/:id bilan AYNI
    // rol proyeksiyasi (filial xodimlari — o'zgarishsiz).
    return projectOrderPayloadForRoles(req?.user?.roles, response);
  }

  /**
   * R6 (QTCUUgjA — "shu kassaga biriktirilgan ochiq smena") — menejer
   * smenani faqat O'Z filiali kassasida ochadi/yopadi/ko'radi: kassa doirasi
   * (`cashbox_user_id` = filial ID) JWT'dan majburlanadi. Superadmin/admin/
   * registrator — avvalgidek markaziy MAIN kassa (doira yuborilmaydi).
   */
  private async resolveShiftCashboxScope(
    user: JwtUser,
  ): Promise<{ cashbox_user_id?: string }> {
    if (!this.isManager(user) || this.isPrivileged(user)) {
      return {};
    }
    const branchId =
      this.extractBranchId(user) ||
      (await this.resolveBranchIdByUserId(String(user.sub), user));
    if (!branchId) {
      throw new ForbiddenException("Managerning branch'i topilmadi");
    }
    return { cashbox_user_id: String(branchId) };
  }

  @Post('shift/open')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Open shift',
    description:
      "Superadmin/admin/registrator — MAIN kassa smenasi; menejer — o'z filiali kassasi smenasi (R6).",
  })
  @ApiBody({ type: OpenShiftRequestDto })
  async openShift(
    @Req() req: { user: JwtUser },
    @Body() dto: OpenShiftRequestDto,
  ) {
    // (kfdfYDik) Smenani ochgan odam — JWT'dan (body'dagi `opened_by`
    // e'tiborga olinmaydi: boshqa odam nomidan smena ochib bo'lmaydi).
    // Bo'sh body bilan ham ochiladi (BeePost naqshi: `@CurrentUser()`).
    const scope = await this.resolveShiftCashboxScope(req.user);
    return this.send(
      { cmd: 'finance.shift.open' },
      { ...dto, opened_by: String(req.user.sub), ...scope },
    );
  }

  @Post('shift/close')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Close shift',
    description:
      "Menejer faqat o'z filiali kassasining smenasini yopadi (boshqa kassa smenasi — 404) (R6). (8OYPuz7J, ega S5) `closing_balance_cash` (sanalgan naqd) MAJBURIY — yuborilmasa 400; `closing_balance_card` ixtiyoriy.",
  })
  @ApiBody({ type: CloseShiftRequestDto })
  async closeShift(
    @Req() req: { user: JwtUser },
    @Body() dto: CloseShiftRequestDto,
  ) {
    // (kfdfYDik) `closed_by` — JWT'dan (ilgari body'da MAJBURIY edi va
    // frontend yuboradigan `{ comment }` har doim 400 olardi). shift_id /
    // opened_by berilmasa finance o'zining, bo'lmasa MAIN kassaning ochiq
    // smenasini yopadi. R6: menejer uchun doira — o'z filiali kassasi.
    const scope = await this.resolveShiftCashboxScope(req.user);
    // (kiZgTybn) Yopish AI natijasini 30 s gacha kutishi mumkin.
    return this.send(
      { cmd: 'finance.shift.close' },
      { ...dto, closed_by: String(req.user.sub), ...scope },
      SHIFT_CLOSE_TIMEOUT_MS,
    );
  }

  /**
   * (kiZgTybn) Kassa doirasi smena tekshiruvi uchun: menejer — o'z filiali,
   * registrator — MAIN ('0'), superadmin/admin — cheklovsiz.
   */
  private async resolveShiftCheckScope(
    user: JwtUser,
  ): Promise<{ cashbox_user_id?: string }> {
    if (this.isPrivileged(user)) return {};
    if (this.isManager(user)) return this.resolveShiftCashboxScope(user);
    return { cashbox_user_id: MAIN_SHIFT_CASHBOX_USER_ID };
  }

  private async sendFile<T = any>(
    pattern: object,
    payload: object,
    timeoutMs = 15000,
  ): Promise<T> {
    if (!this.fileClient) {
      throw new ServiceUnavailableException('File service is not configured');
    }
    return firstValueFrom(
      this.fileClient.send(pattern, payload).pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('File service response timeout');
      }
      throw error;
    });
  }

  /**
   * Shaxsiy kalit → brauzer ochadigan qisqa muddatli havola (300 s) yoki null.
   *
   * (kiZgTybn, prod 2026-10-26) Ilgari `file.get_url` — file-service S3
   * havolasini ICHKI `MINIO_ENDPOINT` bilan imzolardi (`http://minio:9000/…`),
   * brauzer uni ocha olmasdi. Endi gateway o'zi imzolaydi va baytlarni
   * `GET files/signed/:token` orqali beradi (dalil fayllari kabi `file.read`).
   * Havola faqat shu yerda — kassa doirasi tekshirilgan javoblarda — yaratiladi.
   */
  private shiftFileUrl(req: OriginRequest, key: unknown): string | null {
    return buildFileLinkUrl(req, key);
  }

  /** Hisobot / javobdagi karta qatori: kalit o'rniga imzolangan havola. */
  private withPhotoUrl(
    req: OriginRequest,
    row: Record<string, unknown>,
    includeAiRaw: boolean,
  ): Record<string, unknown> {
    const { photo_file_key: key, ai_raw: aiRaw, ...rest } = row;
    const photoUrl = this.shiftFileUrl(req, key);
    return {
      ...rest,
      has_photo: Boolean(key),
      photo_url: photoUrl,
      photo_url_expires_in: photoUrl ? SHIFT_PHOTO_URL_TTL_SECONDS : null,
      ...(includeAiRaw ? { ai_raw: aiRaw ?? null } : {}),
    };
  }

  @Post('shift/account-photo')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: ShiftAccountPhotoSwaggerDto })
  @ApiOperation({
    summary: "(kiZgTybn) Smena yopish: karta qoldig'i skrinshotini yuklash",
    description:
      "`photo` — jpeg / png / webp, ≤ 5 MB, haqiqiy turi magic-bytes bilan tekshiriladi, EXIF/XMP tozalanadi, shaxsiy (private) saqlanadi. Faqat OCHIQ smena; menejer — o'z filiali kassasi kartasi, registrator — asosiy kassa. Javob: `data.check` (qoralama qatori, `ai_status`), `data.photo_url` — brauzer to'g'ridan-to'g'ri ochadigan qisqa muddatli havola, 300 s: `https://<api>/files/signed/<token>` (gateway orqali; MinIO ichki manzili emas, JWT shart emas). AI yoqilgan kartada (`shift.ai_check.enabled` + karta `ai_check_enabled`) `ai_status = pending`; natija realtime `finance.shift.account_checked` bilan keladi.",
  })
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: memoryStorage(),
      limits: { fileSize: SHIFT_PHOTO_MAX_BYTES, files: 1 },
    }),
  )
  async uploadShiftAccountPhoto(
    @Req() req: { user: JwtUser } & OriginRequest,
    @Body() dto: ShiftAccountPhotoRequestDto,
    @UploadedFile()
    photo: { buffer?: Buffer; mimetype?: string; size?: number } | undefined,
  ) {
    const mime = String(photo?.mimetype ?? '').toLowerCase();
    const buffer = photo?.buffer;
    if (!buffer || !buffer.length) {
      throw new BadRequestException('photo fayli majburiy');
    }
    if (!SHIFT_PHOTO_MIME_TYPES.has(mime)) {
      throw new BadRequestException(
        'Faqat jpeg, png yoki webp rasm qabul qilinadi',
      );
    }
    if (buffer.length > SHIFT_PHOTO_MAX_BYTES) {
      throw new BadRequestException('Rasm hajmi 5 MB dan oshmasligi kerak');
    }
    if (!matchesDeclaredType(buffer, mime)) {
      throw new BadRequestException(
        "Fayl mazmuni e'lon qilingan turga mos emas",
      );
    }
    const clean = stripImageMetadata(buffer, mime);
    if (!clean) {
      throw new BadRequestException("Rasm buzilgan yoki o'qib bo'lmaydi");
    }
    const scope = await this.resolveShiftCheckScope(req.user);
    const ext =
      mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';

    const uploaded = await this.sendFile<{ data?: { key?: unknown } }>(
      { cmd: 'file.upload' },
      {
        file_name: `balance.${ext}`,
        mime_type: mime,
        file_base64: clean.toString('base64'),
        folder: 'shift-check',
      },
      30000,
    );
    const key =
      typeof uploaded?.data?.key === 'string' ? uploaded.data.key.trim() : '';
    if (!key) {
      throw new BadRequestException(
        'Rasm saqlanmadi (file-service kalit qaytarmadi)',
      );
    }

    let attached: {
      data?: {
        check?: Record<string, unknown>;
        shift_id?: string;
        ai_enabled?: boolean;
        ai_request_id?: string | null;
        previous_photo_file_key?: string | null;
      };
    };
    try {
      attached = await this.send(
        { cmd: 'finance.shift.account_check.attach_photo' },
        {
          shift_id: dto.shift_id,
          card_id: dto.card_id,
          entered_balance: dto.entered_balance,
          comment: dto.comment,
          photo_file_key: key,
          requester_id: String(req.user.sub),
          ...scope,
        },
      );
    } catch (error) {
      // Rad etildi (smena yopiq, begona karta …) — yetim fayl qolmasin.
      void this.sendFile({ cmd: 'file.delete' }, { key }).catch(
        () => undefined,
      );
      throw error;
    }
    const data = attached?.data ?? {};
    const previousKey = data.previous_photo_file_key;
    if (previousKey) {
      void this.sendFile({ cmd: 'file.delete' }, { key: previousKey }).catch(
        () => undefined,
      );
    }
    if (data.ai_enabled && data.ai_request_id && data.shift_id) {
      // Fon vazifasi: javob kutilmaydi (natija realtime orqali keladi).
      void this.runBalanceAiCheck({
        shift_id: String(data.shift_id),
        card_id: String(dto.card_id),
        ai_request_id: String(data.ai_request_id),
        image: clean,
        media_type: (mime === 'image/jpg'
          ? 'image/jpeg'
          : mime) as AiBalanceScreenshotMediaType,
        user: req.user,
      });
    }
    return {
      statusCode: 201,
      message: 'Shift account photo uploaded',
      data: {
        shift_id: data.shift_id ?? null,
        ai_enabled: Boolean(data.ai_enabled),
        check: data.check ? this.withPhotoUrl(req, data.check, false) : null,
        photo_url: this.shiftFileUrl(req, key),
        photo_url_expires_in: SHIFT_PHOTO_URL_TTL_SECONDS,
      },
    };
  }

  /**
   * (kiZgTybn) AI tekshiruvi — fon vazifasi, HECH QACHON throw qilmaydi.
   * Natija (yoki xato → `error`) finance'ga yoziladi; finance realtime
   * `finance.shift.account_checked` ni chiqaradi. Logga faqat ID'lar
   * (rasm / karta raqami YO'Q).
   */
  async runBalanceAiCheck(input: {
    shift_id: string;
    card_id: string;
    ai_request_id: string;
    image: Buffer;
    media_type: AiBalanceScreenshotMediaType;
    user: JwtUser;
  }): Promise<void> {
    let result: AiBalanceScreenshotResponse = { ok: false, reason: 'disabled' };
    if (this.aiClient) {
      try {
        result = await firstValueFrom(
          this.aiClient
            .send<AiBalanceScreenshotResponse>(
              { cmd: 'ai.finance.balance_screenshot' },
              {
                image_base64: input.image.toString('base64'),
                media_type: input.media_type,
                shift_id: input.shift_id,
                card_id: input.card_id,
                requester: {
                  id: String(input.user?.sub ?? ''),
                  roles: this.getUserRoles(input.user),
                },
                deadline_at: Date.now() + SHIFT_AI_TIMEOUT_MS - 5000,
              },
            )
            .pipe(timeout(SHIFT_AI_TIMEOUT_MS)),
        );
      } catch (error) {
        this.shiftCheckLogger.warn(
          `AI balans tekshiruvi xatosi shift=${input.shift_id} card=${input.card_id}: ${
            error instanceof TimeoutError ? 'timeout' : 'rpc_error'
          }`,
        );
        result = { ok: false, reason: 'network' };
      }
    }
    try {
      await this.send(
        { cmd: 'finance.shift.account_check.ai_result' },
        {
          shift_id: input.shift_id,
          card_id: input.card_id,
          ai_request_id: input.ai_request_id,
          result,
        },
      );
    } catch {
      this.shiftCheckLogger.warn(
        `AI natijasi yozilmadi shift=${input.shift_id} card=${input.card_id}`,
      );
    }
  }

  @Get('shift/settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: "(kiZgTybn) Smena yopish sozlamalari (global + karta bo'yicha)",
    description:
      "Global `account_check_enabled` / `photo_required` / `ai_check_enabled` va kassa kartalari: `require_photo_on_shift_close`, `ai_check_enabled`, hisoblangan `photo_required` / `ai_enabled` (smena yopish oynasi uchun). O'qish — yopuvchi rollar (menejer — o'z filiali, registrator — '0'); o'zgartirish — faqat superadmin (PATCH).",
  })
  async getShiftSettings(
    @Req() req: { user: JwtUser },
    @Query() query: ShiftSettingsQueryDto,
  ) {
    const scope = await this.resolveShiftCheckScope(req.user);
    const requested = query?.cashbox_user_id
      ? String(query.cashbox_user_id)
      : null;
    if (
      scope.cashbox_user_id &&
      requested &&
      requested !== scope.cashbox_user_id
    ) {
      throw new ForbiddenException(
        "Siz faqat o'z kassangiz sozlamalarini ko'ra olasiz",
      );
    }
    return this.send(
      { cmd: 'finance.shift.settings.get' },
      {
        cashbox_user_id:
          scope.cashbox_user_id ?? requested ?? MAIN_SHIFT_CASHBOX_USER_ID,
      },
    );
  }

  @Patch('shift/settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiBody({ type: UpdateShiftSettingsRequestDto })
  @ApiOperation({
    summary:
      "(kiZgTybn) Smena yopish sozlamalarini o'zgartirish — FAQAT superadmin",
    description:
      "Global kalitlar va `cards[]` (karta bo'yicha `require_photo_on_shift_close`, `ai_check_enabled`; AI faqat rasm talab qilinganda — aks holda 400). Activity-log: `finance.shift_settings_updated`.",
  })
  async updateShiftSettings(
    @Req() req: { user: JwtUser },
    @Body() dto: UpdateShiftSettingsRequestDto,
  ) {
    return this.send(
      { cmd: 'finance.shift.settings.update' },
      {
        ...dto,
        requester_id: String(req.user.sub),
        requester_roles: this.getUserRoles(req.user),
      },
    );
  }

  @Get('shift/:id/report')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Smena ID si' })
  @ApiOperation({
    summary: "(kiZgTybn) Smena hisoboti: naqd + kartalar bo'yicha natijalar",
    description:
      "(y8Tqm9Ap / gWI4gYkw) `data.close_reason` (manual | auto | null — ochiq), `data.closed_by_system`, `data.auto_close` (`{ closed_at, label: 'Avtomatik yopildi — HH:MM, kassir yopmagan' }` yoki null — sariq banner), `data.report` (`status`: pending | processing | sent | skipped | failed, `round`, `file_format`, `has_file`, `file_url` — faqat superadmin, 300 s), `data.deliveries[]` — «Hisobot kimlarga yuborildi» (faqat superadmin; boshqalarga bo'sh). `data.cash` / `data.card` — ochilish, kirim, chiqim, kutilgan, sanalgan, farq; `data.accounts[]` — har karta: kutilgan (snapshot), kiritilgan, farq, `ai_status` (not_required | pending | match | mismatch | unreadable | disabled | error), `ai_entered_ok`, `ai_read_balance`, `ai_last4_detected`, `comment`, `comment_required`, `photo_url` (gateway havolasi `…/files/signed/<token>`, 300 s); `ai_raw` — faqat superadmin. `data.accounts_summary` — holatlar soni; `data.operations[]` — smena oynasidagi kassa operatsiyalari (tur × to'lov usuli: soni, summa). Menejer — faqat o'z filiali, registrator — asosiy kassa (boshqasi 404).",
  })
  async shiftReport(
    @Req() req: { user: JwtUser } & OriginRequest,
    @Param('id') id: string,
  ) {
    if (!/^\d+$/.test(String(id ?? ''))) {
      throw new BadRequestException("Smena ID si noto'g'ri");
    }
    const scope = await this.resolveShiftCheckScope(req.user);
    const response = await this.send<{
      statusCode?: number;
      message?: string;
      data?: { accounts?: Array<Record<string, unknown>> } & Record<
        string,
        unknown
      >;
    }>({ cmd: 'finance.shift.report' }, { shift_id: String(id), ...scope });
    const data = response?.data;
    if (!data || !Array.isArray(data.accounts)) return response;
    const isSuperadmin = this.hasRole(req.user, RoleEnum.SUPERADMIN);
    const accounts = data.accounts.map((row) =>
      this.withPhotoUrl(req, row, isSuperadmin),
    );
    // (gWI4gYkw) «Hisobot kimlarga yuborildi» va hisobot fayli — faqat
    // superadmin (kuryer / market ro'yxati boshqa rollarga chiqmaydi).
    const { deliveries, report, ...rest } = data as Record<string, unknown> & {
      deliveries?: unknown;
      report?: { file_key?: unknown } & Record<string, unknown>;
    };
    const { file_key: fileKey, ...reportRest } =
      report ?? ({} as Record<string, unknown>);
    const fileUrl = isSuperadmin ? this.shiftFileUrl(req, fileKey) : null;
    return {
      ...response,
      data: {
        ...rest,
        accounts,
        report: report
          ? {
              ...reportRest,
              has_file: Boolean(fileKey),
              file_url: fileUrl,
              file_url_expires_in: fileUrl ? SHIFT_PHOTO_URL_TTL_SECONDS : null,
            }
          : null,
        deliveries:
          isSuperadmin && Array.isArray(deliveries)
            ? (
                await this.syncShiftReportDeliveries(
                  String(id),
                  deliveries as Array<Record<string, unknown>>,
                )
              ).map((row) => {
                const copy = { ...row };
                delete copy.dispatch_id;
                return copy;
              })
            : [],
      },
    };
  }

  /**
   * (gWI4gYkw) `queued` yetkazishlar — notification-service'dagi haqiqiy holat
   * (`delivery.telegram` sent / failed / «Telegram ulanmagan») o'qiladi va
   * finance'ga saqlash uchun beriladi. Fail-open: xato / javob yo'q — finance
   * ro'yxati o'zgarmasdan qaytadi (3 s chegara).
   */
  private async syncShiftReportDeliveries(
    shiftId: string,
    deliveries: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const dispatchIds = [
      ...new Set(
        deliveries
          .filter((row) => row.status === 'queued' && row.dispatch_id)
          .map((row) => String(row.dispatch_id)),
      ),
    ].slice(0, 500);
    if (!dispatchIds.length || !this.notificationClient) return deliveries;
    try {
      const lookup = await firstValueFrom(
        this.notificationClient
          .send(
            { cmd: 'notification.delivery.by_dispatch' },
            { dispatch_ids: dispatchIds },
          )
          .pipe(timeout(3000)),
      );
      const found = (lookup as { data?: unknown } | null)?.data;
      if (!Array.isArray(found) || !found.length) return deliveries;
      const synced = await this.send<{
        data?: { deliveries?: Array<Record<string, unknown>> };
      }>(
        { cmd: 'finance.shift.report.deliveries.sync' },
        { shift_id: shiftId, found },
        5000,
      );
      return Array.isArray(synced?.data?.deliveries)
        ? synced.data.deliveries
        : deliveries;
    } catch (error) {
      this.shiftCheckLogger.warn(
        `smena #${shiftId} hisobot holati sinxronlanmadi: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return deliveries;
    }
  }

  @Post('shift/:id/report/resend')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiParam({ name: 'id', description: 'Smena ID si (yopilgan)' })
  @ApiOperation({
    summary: '(gWI4gYkw) Smena hisobotini qayta yuborish — FAQAT superadmin',
    description:
      "Yangi raund: superadmin(lar)ga to'liq hisobot (+ PDF/XLSX), kuryerlarga faqat o'z topshiruvlari, marketlarga faqat o'z to'lovlari (sozlamadagi kanallar bo'yicha). Javob: `data.round`, `data.status` (sent | skipped), `data.deliveries[]` (recipient_kind, channel, status: queued | sent | failed | skipped, failed_reason — masalan «Telegram ulanmagan»). Ochiq smena — 400; hozir yuborilayotgan — 400.",
  })
  async resendShiftReport(
    @Req() req: { user: JwtUser },
    @Param('id') id: string,
  ) {
    if (!/^\d+$/.test(String(id ?? ''))) {
      throw new BadRequestException("Smena ID si noto'g'ri");
    }
    return this.send(
      { cmd: 'finance.shift.report.resend' },
      {
        shift_id: String(id),
        requester_id: String(req.user.sub),
        requester_roles: this.getUserRoles(req.user),
      },
    );
  }

  @Get('shift/current')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Kassaning joriy ochiq smenasi (MAIN; menejer — o'z filiali)",
    description:
      "(kfdfYDik) `data.shift` — ochiq smena yoki null; `data.required` — shu kassada smenasiz pul operatsiyalari bloklanadimi (FINANCE_REQUIRE_OPEN_SHIFT: MAIN — main/all, filial — all). R6: menejer — o'z filiali kassasi. (8OYPuz7J) `data.last_closed` — shu kassaning eng oxirgi yopilgan smenasi (closed_at DESC, to'liq qator) yoki null; smena qatorlarida `opened_by_name` / `closed_by_name`. (32Sw3DfC) `?cashbox_user_id=` — superadmin/admin filial kassasi sahifasida shu filial smenasi va `required` (FAQAT o'qish; mavjud bo'lmagan filial — 404). `data.can_open` — so'rovchi shu kassada smena ocha oladimi (superadmin/admin filialda — yo'q: filial smenasini menejer ochadi); smena yo'q va ocha olmasa `data.lock_message` = «Filial menejeri smenani ochishi kerak», aks holda null. Menejer `?cashbox_user_id=0` — HQ asosiy kassa smenasi HOLATI (`status_only: true`; pul maydonlarisiz, `last_closed` yo'q).",
  })
  async currentShift(
    @Req() req: { user: JwtUser },
    @Query() query?: CurrentShiftQueryDto,
  ) {
    const user = req?.user;
    const requested =
      query?.cashbox_user_id != null && String(query.cashbox_user_id) !== ''
        ? String(query.cashbox_user_id)
        : null;

    // (32Sw3DfC) Superadmin/admin — istalgan filial smenasini O'QIYDI
    // (filial kassasi sahifasi `/payments/cash-detail/:id`). Ochish/yopish
    // doirasi o'zgarmagan: ular faqat MAIN smenasini ochadi.
    if (this.isPrivileged(user)) {
      if (requested && requested !== MAIN_SHIFT_CASHBOX_USER_ID) {
        // Faqat mavjud filial: yo'q bo'lsa branch-service 404 qaytaradi.
        await this.sendBranch(
          { cmd: 'branch.find_by_id' },
          { id: requested, requester: this.toRequester(user) },
        );
        return this.withShiftAccess(
          await this.send(
            { cmd: 'finance.shift.current' },
            { cashbox_user_id: requested },
          ),
          false,
        );
      }
      return this.withShiftAccess(
        await this.send({ cmd: 'finance.shift.current' }, {}),
        true,
      );
    }

    const scope = await this.resolveShiftCashboxScope(user);
    if (scope.cashbox_user_id) {
      // Menejer. N20 — HQ asosiy kassa smenasi HOLATI (faqat status).
      if (requested === MAIN_SHIFT_CASHBOX_USER_ID) {
        return this.mainShiftStatusOnly(
          await this.send({ cmd: 'finance.shift.current' }, {}),
        );
      }
      if (requested && requested !== scope.cashbox_user_id) {
        throw new ForbiddenException(
          "Siz faqat o'z filialingiz kassasi smenasini ko'ra olasiz",
        );
      }
      return this.withShiftAccess(
        await this.send({ cmd: 'finance.shift.current' }, scope),
        true,
      );
    }

    // Registrator — avvalgidek faqat MAIN.
    if (requested && requested !== MAIN_SHIFT_CASHBOX_USER_ID) {
      throw new ForbiddenException(
        "Siz faqat asosiy kassa smenasini ko'ra olasiz",
      );
    }
    return this.withShiftAccess(
      await this.send({ cmd: 'finance.shift.current' }, {}),
      true,
    );
  }

  /**
   * (32Sw3DfC) `can_open` — so'rovchi shu kassada smenani ocha oladimi;
   * ocha olmasa va ochiq smena yo'q bo'lsa — qulf matni (ega: menejer yo'q
   * paytda ham superadmin filial smenasini OCHMAYDI).
   */
  private withShiftAccess<T>(response: T, canOpen: boolean): T {
    const data = (response as { data?: unknown } | null)?.data;
    if (!data || typeof data !== 'object') {
      return response;
    }
    const record = data as Record<string, unknown>;
    record.can_open = canOpen;
    record.lock_message =
      !canOpen && !record.shift ? BRANCH_SHIFT_MANAGER_ONLY_MESSAGE : null;
    return response;
  }

  /**
   * (32Sw3DfC, N20) Menejerga HQ asosiy kassa smenasining faqat HOLATI:
   * ochiqmi, qachon va kim ochgan. Pul maydonlari (ochilish qoldig'i, yopilgan
   * smena natijasi) chiqmaydi — bu HQ kassasi ma'lumoti.
   */
  private mainShiftStatusOnly<T>(response: T): T {
    const holder = response as { data?: unknown } | null;
    const data =
      holder?.data && typeof holder.data === 'object'
        ? (holder.data as Record<string, unknown>)
        : null;
    if (!holder || !data) {
      return response;
    }
    const shift =
      data.shift && typeof data.shift === 'object'
        ? (data.shift as Record<string, unknown>)
        : null;
    holder.data = {
      shift: shift
        ? {
            id: shift.id ?? null,
            status: shift.status ?? null,
            cashbox_user_id: MAIN_SHIFT_CASHBOX_USER_ID,
            opened_at: shift.opened_at ?? null,
            opened_by_name: shift.opened_by_name ?? null,
          }
        : null,
      required: data.required === true,
      cashbox_user_id: MAIN_SHIFT_CASHBOX_USER_ID,
      status_only: true,
      can_open: false,
      lock_message: null,
    };
    return response;
  }

  // ───────── 3PE0B03q — asosiy kassa NOMLI kartalari (BeePost cashbox_card) ─────────

  private assertCardId(value: string, field = 'id'): string {
    const id = String(value ?? '').trim();
    if (!/^\d+$/.test(id)) {
      throw new BadRequestException(`${field} raqamli ID bo'lishi kerak`);
    }
    return id;
  }

  /**
   * Zv3MLn0a — kartalar amalining kassa doirasi (`branch_id`):
   *   • MENEJER — DOIM o'z filiali (JWT / branch_users); boshqa `branch_id`
   *     so'ralsa 403; filiali topilmasa 403;
   *   • superadmin/admin — `branch_id` ixtiyoriy (yo'q — asosiy kassa; id
   *     bo'yicha amallarda kassa kartaning o'zidan olinadi).
   * Natija finance'ga `branch_id` bo'lib boradi (menejerda — majburiy doira).
   */
  private async resolveCardScope(
    user: JwtUser | undefined,
    requested?: string,
  ): Promise<{ branch_id?: string }> {
    const raw = String(requested ?? '').trim();
    if (raw && !/^\d+$/.test(raw)) {
      throw new BadRequestException("branch_id raqamli ID bo'lishi kerak");
    }
    if (!this.isManager(user)) {
      return raw ? { branch_id: raw } : {};
    }
    const own = user ? await this.resolveOwnBranchId(user) : '';
    if (!own) {
      throw new ForbiddenException("Managerning branch'i topilmadi");
    }
    if (raw && raw !== own) {
      throw new ForbiddenException(CARD_OTHER_BRANCH_MESSAGE);
    }
    return { branch_id: own };
  }

  /**
   * Zv3MLn0a — smena sozlamalari (`require_photo_on_shift_close`,
   * `ai_check_enabled`) faqat SUPERADMIN: ADMIN yuborsa 403. Ruxsat
   * finance'ga `allow_shift_settings` bo'lib boradi (servis ham tekshiradi).
   */
  private cardShiftSettingsFlag(
    user: JwtUser | undefined,
    dto: { require_photo_on_shift_close?: unknown; ai_check_enabled?: unknown },
  ): { allow_shift_settings?: true } {
    const touches =
      dto.require_photo_on_shift_close !== undefined ||
      dto.ai_check_enabled !== undefined;
    const isSuperadmin = this.hasRole(user, RoleEnum.SUPERADMIN);
    if (touches && !isSuperadmin) {
      throw new ForbiddenException(CARD_SHIFT_SETTINGS_SUPERADMIN_MESSAGE);
    }
    return touches ? { allow_shift_settings: true } : {};
  }

  @Get('cashbox/cards')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Kassa kartalari va hisob raqamlari (balanslar, moslik nazorati) — asosiy yoki filial kassasi',
    description:
      "3PE0B03q / Zv3MLn0a — `data.cards` (Asosiy karta birinchi, balansi = balance_card − Σ nomli kartalar; har kartada `kind`, `bank_name`, `card_network`, `last4`, `holder_name`, `note`, `require_photo_on_shift_close`, `ai_check_enabled`), `balance_card`, `total_card` (== balance_card), `in_sync`, `cashbox_id`, `cashbox_type` (main|branch), `branch_id`. `branch_id` — filial kassasi (superadmin/admin); MENEJER doim o'z filiali kassasini oladi, boshqa `branch_id` → 403.",
  })
  @ApiQuery({ name: 'include_inactive', required: false, type: Boolean })
  @ApiQuery({
    name: 'branch_id',
    required: false,
    description: "Filial ID (yo'q — asosiy kassa; menejer — o'z filiali)",
  })
  async listCashboxCards(
    @Req() req: { user: JwtUser },
    @Query('include_inactive') includeInactive?: string,
    @Query('branch_id') branchId?: string,
  ) {
    const scope = await this.resolveCardScope(req?.user, branchId);
    return this.send(
      { cmd: 'finance.cashbox.cards.list' },
      {
        include_inactive: includeInactive === 'true' || includeInactive === '1',
        ...scope,
      },
    );
  }

  @Post('cashbox/cards')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Yangi karta yoki hisob raqam (balans 0)',
    description:
      'Zv3MLn0a — `branch_id` bilan filial kassasiga. `last4` — faqat 4 raqam (uzunroq → 400). Smena sozlamalari (`require_photo_on_shift_close`, `ai_check_enabled`) — FAQAT superadmin (admin → 403). `make_default: true` — darhol Asosiy karta.',
  })
  @ApiBody({ type: CreateCashboxCardRequestDto })
  createCashboxCard(
    @Req() req: { user: JwtUser },
    @Body() dto: CreateCashboxCardRequestDto,
  ) {
    return this.send(
      { cmd: 'finance.cashbox.cards.create' },
      {
        ...dto,
        ...this.cardShiftSettingsFlag(req?.user, dto),
        created_by: String(req.user.sub),
      },
    );
  }

  @Get('cashbox/cards/movements')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Kartalararo o'tkazma / konvertatsiya jurnali",
    description:
      "Zv3MLn0a — kassa doirasida: `branch_id` (yo'q — asosiy kassa; menejer — o'z filiali). `card_id` — o'sha karta (boshqa filial kartasi → 403).",
  })
  @ApiQuery({ name: 'card_id', required: false })
  @ApiQuery({ name: 'branch_id', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listCashboxCardMovements(
    @Req() req: { user: JwtUser },
    @Query('card_id') cardId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('branch_id') branchId?: string,
  ) {
    const parsedCardId = cardId
      ? this.assertCardId(cardId, 'card_id')
      : undefined;
    const scope = await this.resolveCardScope(req?.user, branchId);
    return this.send(
      { cmd: 'finance.cashbox.cards.movements' },
      {
        ...(parsedCardId ? { card_id: parsedCardId } : {}),
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
        ...scope,
      },
    );
  }

  @Get('cashbox/cards/:id/ledger')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Karta ko'chirmasi (kirim/chiqim + ichki harakatlar, har qatordan keyingi balans)",
    description:
      "Zv3MLn0a — asosiy yoki filial kassasi kartasi; menejer faqat o'z filiali kartasi (boshqasi → 403).",
  })
  @ApiParam({ name: 'id', description: 'Karta ID' })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getCashboxCardLedger(
    @Req() req: { user: JwtUser },
    @Param('id') id: string,
    @Query('from_date') fromDate?: string,
    @Query('to_date') toDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const cardId = this.assertCardId(id);
    const scope = await this.resolveCardScope(req?.user);
    return this.send(
      { cmd: 'finance.cashbox.cards.ledger' },
      {
        id: cardId,
        from_date: fromDate,
        to_date: toDate,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
        ...scope,
      },
    );
  }

  @Get('cashbox/cards/:id/ledger/export')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Karta ko'chirmasi — Excel (.xlsx)",
    description:
      "Zv3MLn0a — `GET /cashbox/cards/:id/ledger` bilan bir xil qatorlar (oraliqdagi HAMMASI, sahifasiz; 2000 dan ortiq bo'lsa 400 — `from_date` bilan qisqartiring). Menejer — faqat o'z filiali kartasi.",
  })
  @ApiParam({ name: 'id', description: 'Karta ID' })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  async exportCashboxCardLedger(
    @Req() req: { user: JwtUser },
    @Res() res: Response,
    @Param('id') id: string,
    @Query('from_date') fromDate?: string,
    @Query('to_date') toDate?: string,
  ): Promise<void> {
    const cardId = this.assertCardId(id);
    const scope = await this.resolveCardScope(req?.user);
    const result = await this.send<{
      data?: {
        card?: Record<string, unknown>;
        items?: Array<Record<string, unknown>>;
      };
    }>(
      { cmd: 'finance.cashbox.cards.ledger' },
      {
        id: cardId,
        from_date: fromDate,
        to_date: toDate,
        all: true,
        ...scope,
      },
    );
    const items = result?.data?.items ?? [];
    const buffer = await buildXlsx(
      "Karta ko'chirmasi",
      CARD_LEDGER_EXCEL_COLUMNS,
      items.map((row) => ({
        date: excelDate(row.created_at),
        kind: CARD_LEDGER_KIND_LABEL[toText(row.kind)] ?? toText(row.kind),
        amount: excelNumber(row.amount),
        delta: excelNumber(row.delta),
        balance_after: excelNumber(row.balance_after),
        payment_method: toText(row.payment_method),
        source_type: toText(row.source_type),
        counterparty_card_id: toText(row.counterparty_card_id),
        comment: toText(row.comment),
        created_by: toText(row.created_by),
      })),
    );
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="karta-${cardId}-kochirma.xlsx"`,
    });
    res.send(buffer);
  }

  @Patch('cashbox/cards/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Karta nomi va tafsilotlarini o`zgartirish',
    description:
      "Zv3MLn0a — `name`, `kind`, `bank_name`, `card_network`, `last4` (faqat 4 raqam), `holder_name`, `note`, `sort_order` (hammasi ixtiyoriy). Asosiy kartada ham ishlaydi — faqat Asosiy kartaning NOMI o'zgarmaydi (400). Smena sozlamalari — faqat superadmin (admin → 403).",
  })
  @ApiParam({ name: 'id', description: 'Karta ID' })
  @ApiBody({ type: UpdateCashboxCardRequestDto })
  renameCashboxCard(
    @Req() req: { user: JwtUser },
    @Param('id') id: string,
    @Body() dto: UpdateCashboxCardRequestDto,
  ) {
    const cardId = this.assertCardId(id);
    const shiftFlag = this.cardShiftSettingsFlag(req?.user, dto);
    const keys = Object.keys(dto).filter(
      (key) => (dto as Record<string, unknown>)[key] !== undefined,
    );
    if (!keys.length) {
      throw new BadRequestException("O'zgartirish uchun maydon yuborilmadi");
    }
    // Faqat nom — eski `rename` buyrug'i (kontrakt o'zgarmagan).
    if (keys.length === 1 && keys[0] === 'name') {
      return this.send(
        { cmd: 'finance.cashbox.cards.rename' },
        { id: cardId, name: dto.name, updated_by: String(req.user.sub) },
      );
    }
    return this.send(
      { cmd: 'finance.cashbox.cards.update' },
      {
        ...dto,
        ...shiftFlag,
        id: cardId,
        updated_by: String(req.user.sub),
      },
    );
  }

  @Post('cashbox/cards/:id/make-default')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Kartani kassaning Asosiy kartasi qilish',
    description:
      "Zv3MLn0a — kassa qulfi ostida, pul harakatlanmaydi: eski Asosiy karta nomli bo'lib joriy qoldig'ini saqlaydi, tanlangan karta Asosiy bo'ladi (karta tanlanmagan to'lovlar endi shu kartaga). Σ kartalar == balance_card o'zgarmaydi. Arxivlangan karta yoki Asosiy karta balansi manfiy (moslik buzilgan) → 400.",
  })
  @ApiParam({ name: 'id', description: 'Karta ID' })
  makeCashboxCardDefault(
    @Req() req: { user: JwtUser },
    @Param('id') id: string,
  ) {
    return this.send(
      { cmd: 'finance.cashbox.cards.make_default' },
      { id: this.assertCardId(id), updated_by: String(req.user.sub) },
    );
  }

  @Patch('cashbox/cards/:id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Kartani faollashtirish / arxivlash (balans 0 bo`lishi shart)',
  })
  @ApiParam({ name: 'id', description: 'Karta ID' })
  @ApiBody({ type: SetCashboxCardStatusRequestDto })
  setCashboxCardStatus(
    @Req() req: { user: JwtUser },
    @Param('id') id: string,
    @Body() dto: SetCashboxCardStatusRequestDto,
  ) {
    return this.send(
      { cmd: 'finance.cashbox.cards.set_active' },
      {
        id: this.assertCardId(id),
        is_active: dto.is_active,
        updated_by: String(req.user.sub),
      },
    );
  }

  @Post('cashbox/cards/transfer')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Kartadan kartaga o'tkazma (balance_card o'zgarmaydi)",
    description:
      "Idempotency-Key sarlavhasi bilan takroriy so'rov ikkinchi o'tkazma yozmaydi.",
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiBody({ type: TransferCashboxCardRequestDto })
  transferCashboxCards(
    @Req() req: { user: JwtUser },
    @Body() dto: TransferCashboxCardRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = this.readIdempotencyKey(idempotencyKey);
    return this.send(
      { cmd: 'finance.cashbox.cards.transfer' },
      {
        ...dto,
        created_by: String(req.user.sub),
        ...(key ? { dedup_epoch: key } : {}),
      },
    );
  }

  @Post('cashbox/cards/convert')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Karta↔naqd konvertatsiya (kassaning umumiy balansi o`zgarmaydi)',
    description:
      "Idempotency-Key sarlavhasi bilan takroriy so'rov ikkinchi konvertatsiya yozmaydi.",
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiBody({ type: ConvertCashboxCardRequestDto })
  convertCashboxCard(
    @Req() req: { user: JwtUser },
    @Body() dto: ConvertCashboxCardRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = this.readIdempotencyKey(idempotencyKey);
    return this.send(
      { cmd: 'finance.cashbox.cards.convert' },
      {
        ...dto,
        created_by: String(req.user.sub),
        ...(key ? { dedup_epoch: key } : {}),
      },
    );
  }

  // ───────── Elchi Pochta №1 — kassa xarajatlari kategoriyalari ─────────

  @Get('cashbox/expense-categories')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Kassa xarajatlari kategoriyalari (chiqim oynasidagi tanlov)',
    description:
      "`data.items` — `{ id, name, description, sort_order, is_deleted, created_by, updated_by, created_at, updated_at }`, `sort_order` bo'yicha. Kassadan chiqim qila oladigan hamma (superadmin, admin, menejer) ko'radi. `include_deleted=true` — o'chirilganlar ham (oxirida); faqat superadmin uchun, boshqalarda e'tiborsiz.",
  })
  @ApiQuery({ name: 'include_deleted', required: false, type: Boolean })
  listCashboxExpenseCategories(
    @Req() req: { user: JwtUser },
    @Query('include_deleted') includeDeleted?: string,
  ) {
    const wantsDeleted = includeDeleted === 'true' || includeDeleted === '1';
    return this.send(
      { cmd: 'finance.cashbox.expense_categories.list' },
      {
        include_deleted:
          wantsDeleted && this.hasRole(req?.user, RoleEnum.SUPERADMIN),
      },
    );
  }

  @Post('cashbox/expense-categories')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Yangi xarajat kategoriyasi (faqat superadmin; nom takrori — 409)',
  })
  @ApiBody({ type: CreateCashboxExpenseCategoryRequestDto })
  createCashboxExpenseCategory(
    @Req() req: { user: JwtUser },
    @Body() dto: CreateCashboxExpenseCategoryRequestDto,
  ) {
    return this.send(
      { cmd: 'finance.cashbox.expense_categories.create' },
      { ...dto, created_by: String(req.user.sub) },
    );
  }

  @Patch('cashbox/expense-categories/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Xarajat kategoriyasini tahrirlash (faqat superadmin; topilmasa — 404, nom takrori — 409)',
    description:
      "Kamida bitta maydon: `name`, `description` (`null` — tozalash), `sort_order`. Eski tarix qatorlari yozilgan paytdagi nomni (snapshot) ko'rsatishda davom etadi.",
  })
  @ApiParam({ name: 'id', description: 'Kategoriya ID' })
  @ApiBody({ type: UpdateCashboxExpenseCategoryRequestDto })
  updateCashboxExpenseCategory(
    @Req() req: { user: JwtUser },
    @Param('id') id: string,
    @Body() dto: UpdateCashboxExpenseCategoryRequestDto,
  ) {
    return this.send(
      { cmd: 'finance.cashbox.expense_categories.update' },
      {
        ...dto,
        id: this.assertCardId(id),
        updated_by: String(req.user.sub),
      },
    );
  }

  @Delete('cashbox/expense-categories/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Xarajat kategoriyasini o'chirish (soft; faqat superadmin)",
    description:
      "Tanlov ro'yxatidan yo'qoladi va yangi chiqimda berilsa 400; mavjud tarix qatorlari nomini (snapshot) saqlaydi. Topilmasa yoki allaqachon o'chirilgan — 404.",
  })
  @ApiParam({ name: 'id', description: 'Kategoriya ID' })
  deleteCashboxExpenseCategory(
    @Req() req: { user: JwtUser },
    @Param('id') id: string,
  ) {
    return this.send(
      { cmd: 'finance.cashbox.expense_categories.delete' },
      { id: this.assertCardId(id), deleted_by: String(req.user.sub) },
    );
  }

  @Get('shift')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Find shifts with filters',
    description:
      "(8OYPuz7J) `cashbox_user_id` ('0' — MAIN, aks holda filial ID si), `sort_by=opened_at|closed_at` + `sort_dir=asc|desc` (sukut opened_at desc). Qatorlarda `opened_by_name` / `closed_by_name`. Menejer — faqat o'z filiali kassasi smenalari (boshqa `cashbox_user_id` — 403).",
  })
  @ApiQuery({ name: 'opened_by', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async findShifts(
    @Req() req: { user: JwtUser },
    @Query() query: FindShiftQueryDto,
  ) {
    // (8OYPuz7J) Menejer: doira JWT'dan (o'z filiali kassasi) majburlanadi —
    // aks holda boshqa filiallarning kassa natijalari (kamomad) ko'rinardi.
    const scope = await this.resolveShiftCashboxScope(req?.user);
    if (scope.cashbox_user_id) {
      if (
        query?.cashbox_user_id != null &&
        String(query.cashbox_user_id) !== scope.cashbox_user_id
      ) {
        throw new ForbiddenException(
          "Siz faqat o'z filialingiz kassasi smenalarini ko'ra olasiz",
        );
      }
      return this.send(
        { cmd: 'finance.shift.find_all' },
        { ...query, cashbox_user_id: scope.cashbox_user_id },
      );
    }
    return this.send({ cmd: 'finance.shift.find_all' }, query);
  }

  @Post('salary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create salary row for user' })
  @ApiBody({ type: CreateSalaryRequestDto })
  createSalary(@Body() dto: CreateSalaryRequestDto) {
    return this.send({ cmd: 'finance.salary.create' }, dto);
  }

  @Patch('salary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update salary row for user' })
  @ApiBody({ type: UpdateSalaryRequestDto })
  updateSalary(@Body() dto: UpdateSalaryRequestDto) {
    return this.send({ cmd: 'finance.salary.update' }, dto);
  }

  @Get('salary/:user_id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find salary by user id' })
  @ApiParam({ name: 'user_id', description: 'User id (bigint string)' })
  findSalaryByUser(@Param('user_id') user_id: string) {
    return this.send({ cmd: 'finance.salary.find_by_user' }, { user_id });
  }

  // --- Operator earnings & payments ---

  @Post('operator-payments')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Record a payout to an operator' })
  @ApiBody({ type: CreateOperatorPaymentRequestDto })
  @ApiHeader({
    name: 'idempotency-key',
    required: false,
    description:
      "Har to'lov uchun bitta kalit (retry'da ayni kalit). Takroriy so'rov 200 va data.idempotent: true qaytaradi (FJVqcUTv).",
  })
  createOperatorPayment(
    @Body() dto: CreateOperatorPaymentRequestDto,
    @Req() req: { user?: JwtUser },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // (FJVqcUTv) Kalit ixtiyoriy (FE hali yubormaydi); bo'lsa ikki marta
    // bosilgan "To'lovni saqlash" operatorga ikki marta to'lamaydi.
    const key = this.readIdempotencyKey(idempotencyKey);
    return this.send(
      { cmd: 'finance.operator.payment.create' },
      {
        ...dto,
        paid_by_id: req.user?.sub ?? null,
        ...(key ? { idempotency_key: key } : {}),
      },
    );
  }

  // ───────── E6iEOAVs — market operatori O'Z daromadi (MO-S2 «Daromadim») ─────────
  // ⚠️ `operators/:operator_id/*` dan OLDIN e'lon qilinadi: aks holda 'me'
  // operator_id sifatida o'sha marshrutga tushardi. operator_id FAQAT
  // JWT'dan (`sub`) — path/query'dagi id qabul qilinmaydi.

  /** limit/offset query → son yoki undefined (raqam bo'lmasa — sukut). */
  private static toPageNumber(value?: string): number | undefined {
    if (value == null || String(value).trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  @Get('operators/me/balance')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET_OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Market operatori: o'z daromadi/to'lovi/balansi (E6iEOAVs)",
    description:
      '`GET operators/:operator_id/balance` bilan AYNI shakl `{ operator_id, earned, paid, balance }`, operator_id — JWT. Komissiya belgilanmagan operator — 0/0/0 (403 emas).',
  })
  findMyOperatorBalance(@Req() req: { user: JwtUser }) {
    return this.send(
      { cmd: 'finance.operator.balance.find' },
      { operator_id: String(req.user.sub) },
    );
  }

  @Get('operators/me/earnings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET_OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Market operatori: o'z daromad yozuvlari (E6iEOAVs)",
    description:
      "`GET operators/:operator_id/earnings` bilan AYNI shakl `{ rows, total, limit, offset }` (limit 1–200, sukut 50), faqat o'z yozuvlari. Komissiyasiz operator — bo'sh ro'yxat.",
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  listMyOperatorEarnings(
    @Req() req: { user: JwtUser },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.send(
      { cmd: 'finance.operator.earning.list' },
      {
        operator_id: String(req.user.sub),
        limit: FinanceGatewayController.toPageNumber(limit),
        offset: FinanceGatewayController.toPageNumber(offset),
      },
    );
  }

  @Get('operators/me/payments')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.MARKET_OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Market operatori: unga qilingan to'lovlar (E6iEOAVs)",
    description:
      "`GET operators/:operator_id/payments` bilan AYNI shakl `{ rows, total, limit, offset }`, faqat o'z to'lovlari.",
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  listMyOperatorPayments(
    @Req() req: { user: JwtUser },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.send(
      { cmd: 'finance.operator.payment.list' },
      {
        operator_id: String(req.user.sub),
        limit: FinanceGatewayController.toPageNumber(limit),
        offset: FinanceGatewayController.toPageNumber(offset),
      },
    );
  }

  @Get('operators/:operator_id/balance')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Operator earned/paid/balance summary' })
  @ApiParam({
    name: 'operator_id',
    description: 'Operator user id (bigint string)',
  })
  findOperatorBalance(@Param('operator_id') operator_id: string) {
    return this.send({ cmd: 'finance.operator.balance.find' }, { operator_id });
  }

  @Get('operators/:operator_id/earnings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List an operator earnings' })
  @ApiParam({
    name: 'operator_id',
    description: 'Operator user id (bigint string)',
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  listOperatorEarnings(
    @Param('operator_id') operator_id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.send(
      { cmd: 'finance.operator.earning.list' },
      {
        operator_id,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      },
    );
  }

  @Get('operators/:operator_id/payments')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List an operator payouts' })
  @ApiParam({
    name: 'operator_id',
    description: 'Operator user id (bigint string)',
  })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  listOperatorPayments(
    @Param('operator_id') operator_id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.send(
      { cmd: 'finance.operator.payment.list' },
      {
        operator_id,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      },
    );
  }
}
