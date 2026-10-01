import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  Headers,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { Roles } from './auth/roles.decorator';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Public } from './auth/public.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Roles as RoleEnum,
  Source_type,
} from '@app/common';
import {
  CashboxAllInfoQueryDto,
  CloseShiftRequestDto,
  CreateCashboxRequestDto,
  CreateOperatorPaymentRequestDto,
  CreateSalaryRequestDto,
  RecordFinancialBalanceRequestDto,
  FindCashboxByUserQueryDto,
  FindHistoryQueryDto,
  FindShiftQueryDto,
  HqCourierReceivablesResponseDto,
  MainCashboxFilterQueryDto,
  MainCashboxManualRequestDto,
  OpenShiftRequestDto,
  PaymentBranchToMainRequestDto,
  PaymentFromCourierRequestDto,
  PaymentToMarketRequestDto,
  UpdateCashboxBalanceRequestDto,
  UpdateSalaryRequestDto,
} from './dto/finance.swagger.dto';

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

@ApiTags('Finance')
@Controller('finance')
export class FinanceGatewayController {
  constructor(
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
  ) {}

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

    const users = await Promise.all(
      createdByIds.map(async (id) => {
        try {
          const userResponse = await this.sendIdentity<{
            data?: Record<string, any>;
          }>({ cmd: 'identity.user.find_by_id' }, { id });
          const user = userResponse?.data ?? null;
          return [id, user] as const;
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
    if (this.isPrivileged(req?.user) && !query.cashbox_type) {
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
          kassadagi_summa: Number(response.data?.balance ?? 0),
          berilishi_kerak: Number(
            privilegedBranchSettlement?.berilishi_kerak ?? 0,
          ),
          olinishi_kerak: Number(
            privilegedBranchSettlement?.berilishi_kerak ?? 0,
          ),
          counterparty: 'HQ',
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
        response.data.kassadagi_summa = Number(
          response.data.cashbox?.balance ?? 0,
        );
        response.data.berilishi_kerak = Number(
          privilegedBranchSettlement?.berilishi_kerak ?? 0,
        );
        response.data.olinishi_kerak = Number(
          privilegedBranchSettlement?.berilishi_kerak ?? 0,
        );
        response.data.counterparty = 'HQ';
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
    return this.send({ cmd: 'finance.cashbox.update_balance' }, dto);
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

  // Window in which an identical manual transfer with no client Idempotency-Key
  // is treated as an accidental resubmit (double-click / retry) and deduped.
  // A deliberate identical transfer in a later window is still allowed.
  private static readonly MANUAL_TRANSFER_DEDUP_WINDOW_MS = 30_000;

  /**
   * Resolve the idempotency token for a manual cash transfer.
   *
   * Prefers a client-supplied `Idempotency-Key` header so a UI double-click /
   * accidental resubmit of the SAME logical payment reuses the SAME token and
   * finance dedupes it (the cash is moved at most once).
   *
   * When the client sends NO key we no longer mint a random UUID (which made
   * every HTTP submit unique and left a real double-submit UNPROTECTED — Audit
   * money P1). Instead we derive a DETERMINISTIC token from the payment's
   * identity (actor + kind + payload) plus a coarse time bucket, so two
   * identical submits within the window collapse to the same token and finance
   * moves the cash at most once, while an intentional identical transfer in a
   * later window still goes through.
   */
  private resolveTransferToken(
    idempotencyKey: string | undefined,
    fingerprint: { actorId: string; kind: string; payload: unknown },
  ): string {
    const key = String(idempotencyKey ?? '').trim();
    if (key.length > 0) {
      return key;
    }
    const bucket = Math.floor(
      Date.now() / FinanceGatewayController.MANUAL_TRANSFER_DEDUP_WINDOW_MS,
    );
    return createHash('sha256')
      .update(
        [
          'manual-transfer',
          fingerprint.kind,
          fingerprint.actorId,
          JSON.stringify(fingerprint.payload ?? null),
          String(bucket),
        ].join('|'),
      )
      .digest('hex');
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

    // Idempotency token: prefer the client's Idempotency-Key (stops a UI
    // double-click double-paying); fall back to a fresh UUID. A redelivered RMQ
    // message reuses it so the cash transfer is applied at most once (P0-3), and
    // the settlement advance reuses the same token so it dedupes too (I1/I2).
    const token = this.resolveTransferToken(idempotencyKey, {
      actorId: String(req.user.sub),
      kind: 'payment_courier',
      payload: dto,
    });
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
    // C1 / audit M2: kalit bo'lmasa zaxira barmoq izi FAQAT to'lovning o'zidan
    // (market, summa, usul). Ilgari butun dto (`payment_date`, `comment`)
    // olinardi — frontend har bosishda yangi `payment_date` yuborgani uchun
    // 504 dan keyingi qayta bosish hech qachon bir xil token bermasdi va
    // to'lov IKKI MARTA yozilardi.
    const token = this.resolveTransferToken(idempotencyKey, {
      actorId: String(req.user.sub),
      kind: 'payment_market',
      payload: {
        market_id: dto.market_id,
        amount: dto.amount,
        payment_method: dto.payment_method,
      },
    });
    const result = await this.send(
      { cmd: 'finance.cashbox.payment_market' },
      { ...dto, created_by: req.user.sub, dedup_epoch: token },
    );
    // HQ → market settlement advance is enqueued by finance-service via the
    // transactional outbox in the same tx as the cashbox move (Faza 2a).
    return result;
  }

  @Post('cashbox/payment/branch-to-main')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Transfer money from branch manager cashbox to HQ main cashbox',
  })
  @ApiBody({ type: PaymentBranchToMainRequestDto })
  async paymentBranchToMain(
    @Req() req: { user: JwtUser },
    @Body() dto: PaymentBranchToMainRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    let branchId = String(dto.branch_id ?? '').trim();

    // A manager may remit ONLY their own branch's cash to HQ — force the branch
    // to their assignment and reject any attempt to remit another branch.
    // (Audit I5: managers now have a real branch→HQ settle action.)
    if (this.isManager(req?.user) && !this.isPrivileged(req?.user)) {
      const managerBranchId =
        this.extractBranchId(req.user) ||
        (await this.resolveBranchIdByUserId(String(req.user.sub), req.user));
      if (!managerBranchId) {
        throw new ForbiddenException("Managerning branch'i topilmadi");
      }
      if (branchId && branchId !== String(managerBranchId)) {
        throw new ForbiddenException(
          "Siz faqat o'z branch'ingiz pulini HQ ga topshira olasiz",
        );
      }
      branchId = String(managerBranchId);
    }

    if (!branchId) {
      throw new ForbiddenException('branch_id yuborilishi shart');
    }

    await this.sendBranch(
      { cmd: 'branch.find_by_id' },
      { id: branchId, requester: this.toRequester(req.user) },
    );

    // C1 / audit M2: zaxira barmoq izida `payment_date` YO'Q (har bosishda
    // yangi bo'lgani uchun qayta bosish dedup qilinmasdi).
    const token = this.resolveTransferToken(idempotencyKey, {
      actorId: String(req.user.sub),
      kind: 'payment_branch_main',
      payload: {
        branch_id: branchId,
        amount: dto.amount,
        payment_method: dto.payment_method,
      },
    });
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
          kassadagi_summa: settlement.kassa,
          berilishi_kerak: settlement.berilishi_kerak,
          olinishi_kerak: settlement.olinishi_kerak,
          counterparty: settlement.counterparty,
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
    return this.send({ cmd: 'finance.cashbox.financial_balance' }, {});
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
  recordFinancialBalance(
    @Body() dto: RecordFinancialBalanceRequestDto,
    @Req() req: { user?: JwtUser },
  ) {
    return this.send(
      { cmd: 'finance.financial_balance.record' },
      { ...dto, created_by: req.user?.sub ?? null },
    );
  }

  @Get('financial-balance/history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List financial balance ledger entries + current balance',
  })
  @ApiQuery({ name: 'source_type', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'fromDate', required: false })
  @ApiQuery({ name: 'toDate', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  financialBalanceHistory(
    @Query('source_type') source_type?: string,
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

    return this.send(
      { cmd: 'finance.financial_balance.history' },
      {
        source_type,
        from_date: from_date ?? fromDate,
        to_date: to_date ?? toDate,
        limit: normalizedLimit,
        offset: normalizedOffset,
      },
    );
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
  })
  @ApiQuery({ name: 'fromDate', required: false })
  @ApiQuery({ name: 'toDate', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  financialBalanceTopImpacts(
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.send(
      { cmd: 'finance.financial_balance.top_impacts' },
      {
        from_date: from_date ?? fromDate,
        to_date: to_date ?? toDate,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      },
    );
  }

  @Patch('cashbox/spend')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Spend money from main cashbox' })
  @ApiBody({ type: MainCashboxManualRequestDto })
  async spendMoney(
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
    const token = this.resolveTransferToken(idempotencyKey, {
      actorId: String(req.user.sub),
      kind: 'cashbox_spend',
      payload: { target: targetUserId, dto },
    });
    return this.send(
      { cmd: 'finance.cashbox.spend' },
      {
        ...dto,
        user_id: targetUserId,
        created_by: req.user.sub,
        dedup_epoch: token,
        ...(isManager ? { cashbox_type: Cashbox_type.BRANCH } : {}),
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
    const token = this.resolveTransferToken(idempotencyKey, {
      actorId: String(req.user.sub),
      kind: 'cashbox_fill',
      payload: { target: targetUserId, dto },
    });
    return this.send(
      { cmd: 'finance.cashbox.fill' },
      {
        ...dto,
        user_id: targetUserId,
        created_by: req.user.sub,
        dedup_epoch: token,
        ...(isManager ? { cashbox_type: Cashbox_type.BRANCH } : {}),
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
  @ApiOperation({ summary: 'Find cashbox history list' })
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

    return response;
  }

  @Post('shift/open')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Open shift' })
  @ApiBody({ type: OpenShiftRequestDto })
  openShift(@Body() dto: OpenShiftRequestDto) {
    return this.send({ cmd: 'finance.shift.open' }, dto);
  }

  @Post('shift/close')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Close shift' })
  @ApiBody({ type: CloseShiftRequestDto })
  closeShift(@Body() dto: CloseShiftRequestDto) {
    return this.send({ cmd: 'finance.shift.close' }, dto);
  }

  @Get('shift')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find shifts with filters' })
  @ApiQuery({ name: 'opened_by', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findShifts(@Query() query: FindShiftQueryDto) {
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
  createOperatorPayment(
    @Body() dto: CreateOperatorPaymentRequestDto,
    @Req() req: { user?: JwtUser },
  ) {
    return this.send(
      { cmd: 'finance.operator.payment.create' },
      { ...dto, paid_by_id: req.user?.sub ?? null },
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
