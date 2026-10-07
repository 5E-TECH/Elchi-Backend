import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Brackets, In, Repository } from 'typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';
import { randomBytes } from 'crypto';
import { BcryptEncryption } from '../../../libs/common/helpers/bcrypt';
import { User } from './entities/user.entity';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';
import { CreateCourierDto } from './dto/create-courier.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { CreateManagerDto } from './dto/create-manager.dto';
import { UserFilterQuery } from './contracts/user.payloads';
import {
  ActivityAction,
  ActivityLogService,
  Cashbox_type,
  Roles,
  Status,
  rmqSend,
} from '@app/common';
import type { ActivityLogQuery } from '@app/common';
import {
  catchError,
  errorRes,
  successRes,
} from '../../../libs/common/helpers/response';
import { RequesterContext } from './contracts/user.payloads';

/**
 * HQ (bosh ofis) da MENEJER bo'lmaydi. Matn branch-service
 * `assignUserToBranch` dagi bilan BIR XIL — POST /managers va
 * POST /branches/:id/users mijozga aynan bitta xabarni qaytaradi.
 */
const HQ_MANAGER_FORBIDDEN_MESSAGE =
  "HQ (bosh ofis) ga menejer biriktirib bo'lmaydi. HQ ishlarini superadmin, admin va registratorlar bajaradi.";

/**
 * Kuryerni o'chirish qo'riqchisi (deleteUser → branch.user.courier_transfer_check).
 * O'chirilgan filial kuryerining pulini hech kim qabul qila olmaydi (identity
 * uni 404 qiladi), qo'lidagi buyurtmalar esa osilib qoladi — shuning uchun
 * kuryerda pul yoki buyurtma bo'lsa o'chirish rad etiladi (409), tekshiruvning
 * o'zi bajarilmasa ham rad etiladi (503, fail-closed).
 *
 * Vaqt byudjeti: branch tekshiruvi ≈ ensureUserExists 5 s + parallel
 * finance/order/logistics 5 s ≈ 10 s < shu 12 s < gateway DELETE /users/:id
 * 15 s. Qayta urinish YO'Q (retries 0): tekshiruv o'zi 3 ta servisga boradi.
 */
const COURIER_DELETE_BLOCKED_PREFIX = "Kuryerni o'chirib bo'lmaydi: ";
const COURIER_DELETE_CHECK_UNAVAILABLE =
  "Kuryer kassasi va qo'lidagi buyurtmalarni tekshirib bo'lmadi — kuryer o'chirilmadi. Birozdan so'ng qayta urinib ko'ring.";
const COURIER_DELETE_CHECK_TIMEOUT_MS = 12_000;

/**
 * identity.courier.set_region'da DB xatosi. Xom xato qayta navbatga qo'yilib,
 * handler branch-service o'tkazishni bekor qilganidan KEYIN yangi hududni
 * yozib qo'yishi mumkin edi — shuning uchun u RpcException bo'lib ketadi.
 */
const COURIER_REGION_SAVE_FAILED =
  "Kuryer hududini saqlashda ma'lumotlar bazasi xatosi — hudud o'zgarmadi. Qayta urinib ko'ring.";

/**
 * identity.courier.set_region `deadline_at` dan KEYIN keldi (yoki qulfni
 * kutib turib o'tkazib yubordi): chaqiruvchi (branch-service) vaqt tugaganini
 * ko'rib o'tkazishni allaqachon qaytargan — kech yozuv kuryerni eski filialda
 * yangi filial hududi bilan qoldirardi. RpcException: navbatga qayta qo'yilmaydi.
 */
const COURIER_REGION_DEADLINE_PASSED =
  "Kuryer hududini yangilash muddati o'tdi — hudud o'zgarmadi";

/**
 * Boshqa servisning rad javobini YAKUNIY mijoz xatosiga aylantiradi.
 *
 * RabbitMQ orqali kelgan xato hech qachon RpcException nusxasi emas — u oddiy
 * `{statusCode, message, data}` obyekti bo'lib keladi. Uni xom holda qayta
 * otsak, executeAndAck (nackForError) uni "vaqtinchalik" deb navbatga qayta
 * qo'yadi: handler (masalan createCourier) IKKINCHI marta ishlab, yana bitta
 * user yaratadi va o'chiradi; Nest esa xatoni 'Internal server error' bilan
 * almashtiradi — mijoz aniq 4xx o'rniga HTTP 500 oladi.
 *
 * 4xx — biznes rad javobi, qayta urinish natijani o'zgartirmaydi. Shuning
 * uchun u RpcException'ga o'raladi: xabar navbatga qayta qo'yilmaydi, status
 * va matn mijozga o'zgarishsiz yetadi. RpcException, 5xx, timeout va boshqa
 * xatolar O'ZGARISHSIZ qaytariladi — mavjud vaqtinchalik qayta urinish
 * saqlanadi. Xuddi shu andoza: logistics-service `updateOrder`.
 */
function toFinalClientError(error: unknown): unknown {
  if (error instanceof RpcException || !error || typeof error !== 'object') {
    return error;
  }
  const statusCode = Number((error as { statusCode?: unknown }).statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 499) {
    return error;
  }
  return new RpcException({
    ...(error as Record<string, unknown>),
    statusCode,
  });
}

/** RpcException yoki RMQ orqali kelgan oddiy xato obyektining statusi. */
function sagaErrorStatus(error: unknown): number | null {
  const payload = error instanceof RpcException ? error.getError() : error;
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const statusCode = Number((payload as { statusCode?: unknown }).statusCode);
  return Number.isInteger(statusCode) ? statusCode : null;
}

/**
 * CODE-26: saga qadami (masalan branch.user.assign) xato bersa ham yozilib
 * ulgurgan bo'lishi mumkinmi: 409 (qayta yuborishdagi "allaqachon
 * biriktirilgan") yoki 4xx bo'lmagan har qanday xato (timeout, 5xx).
 */
function sagaStepMayHaveCommitted(error: unknown): boolean {
  const statusCode = sagaErrorStatus(error);
  if (statusCode === null) {
    return true;
  }
  return statusCode === 409 || statusCode < 400 || statusCode > 499;
}

/** string/number qiymatning matni; boshqa har qanday qiymat — ''. */
function primitiveText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function describeSagaError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    const { statusCode, message } = error as {
      statusCode?: unknown;
      message?: unknown;
    };
    return `${primitiveText(statusCode) || '?'} ${primitiveText(message)}`.trim();
  }
  return primitiveText(error) || 'unknown error';
}

/** Ikki id bir xilmi ('01' ≡ '1' — raqamli id'lar kanonik solishtiriladi). */
function sameEntityId(left: unknown, right: unknown): boolean {
  const a = primitiveText(left).trim();
  const b = primitiveText(right).trim();
  if (!a || !b) {
    return false;
  }
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    return BigInt(a) === BigInt(b);
  }
  return a === b;
}

@Injectable()
export class UserServiceService implements OnModuleInit {
  private readonly logger = new Logger(UserServiceService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @Inject('SEARCH') private readonly searchClient: ClientProxy,
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    private readonly bcryptEncryption: BcryptEncryption,
    private readonly configService: ConfigService,
    private readonly activityLog: ActivityLogService,
  ) {}

  /**
   * Umumiy RPC javoblariga HECH QACHON kirmaydigan maydonlar:
   * - password — bcrypt hash;
   * - refresh_token — faol refresh JWT'ning sha256 hashi;
   * - market_tg_token — marketning Telegram bot/guruh kaliti (bearer).
   *
   * market_tg_token ilgari order/analytics/finance/catalog/branch javoblaridagi
   * market obyektlari orqali menejer, registrator, kuryer va boshqa
   * marketlarga ham yetib borardi. Endi u faqat sanitizeWithTgToken orqali
   * qaytadi — superadmin/admin market profilini ochganda (GET /users/:id).
   */
  private sanitize(
    user: User,
  ): Omit<User, 'password' | 'refresh_token' | 'market_tg_token'> {
    const safeUser = { ...user };
    delete (safeUser as { password?: unknown }).password;
    delete (safeUser as { refresh_token?: unknown }).refresh_token;
    delete (safeUser as { market_tg_token?: unknown }).market_tg_token;
    return safeUser;
  }

  /**
   * sanitize() bilan bir xil, lekin market_tg_token SAQLANADI. Faqat
   * identity.user.find_by_id `include_tg_token === true` bilan va faqat market
   * qatori uchun ishlatiladi. Gateway bu flagni faqat SUPERADMIN/ADMIN
   * so'rovida yuboradi — admin tokenni marketga shu sahifadan beradi.
   */
  private sanitizeWithTgToken(
    user: User,
  ): Omit<User, 'password' | 'refresh_token'> {
    const safeUser = { ...user };
    delete (safeUser as { password?: unknown }).password;
    delete (safeUser as { refresh_token?: unknown }).refresh_token;
    return safeUser;
  }

  /** Normalise the RMQ requester into activity-log actor fields. */
  private auditActor(requester?: RequesterContext): {
    user_id: string | null;
    user_role: string | null;
  } {
    const roles = (requester as { roles?: string[] } | undefined)?.roles ?? [];
    const id = (requester as { id?: string } | undefined)?.id;
    return {
      user_id: id ? String(id) : null,
      user_role: roles.length ? roles.join(',') : null,
    };
  }

  /**
   * Assign a freshly-created user to a branch. On failure, compensate by
   * soft-deleting the user (with mangled phone/username so uniqueness is
   * preserved for a retry). Previously this saga lived in the API gateway,
   * which left orphaned users when the gateway crashed mid-flight; centralising
   * it here keeps the user lifecycle owned by identity-service and preserves
   * the audit trail that hard-delete would erase.
   */
  private async assignUserToBranchOrCompensate(
    userId: string,
    branchId: string,
    branchRole: 'REGISTRATOR' | 'COURIER' | 'MANAGER',
    requester?: RequesterContext,
  ): Promise<void> {
    try {
      await rmqSend(
        this.branchClient,
        { cmd: 'branch.user.assign' },
        {
          requester,
          dto: {
            branch_id: String(branchId),
            user_id: String(userId),
            role: branchRole,
          },
        },
        { attachRequestId: false, retries: 1, timeoutMs: 5000 },
      );
    } catch (assignError) {
      // CODE-26: birinchi urinish timeout bo'lib, lekin branch-service'da
      // yozilib ulgurgan bo'lsa, rmqSend qayta yuboradi va 409 "allaqachon
      // biriktirilgan" (yoki yana timeout) oladi. Biriktirish HAQIQATAN bor —
      // userni o'chirish yetim branch_users qatorini va mijozga 409 ni
      // qoldirardi. Tekshiruv faqat 409 va 4xx bo'lmagan xatolarda: boshqa 4xx
      // (403/400/404) da branch-service hech narsa yozmagan.
      if (
        sagaStepMayHaveCommitted(assignError) &&
        (await this.isUserAssignedToBranch(userId, branchId))
      ) {
        this.logger.warn(
          `branch.user.assign failed (${describeSagaError(assignError)}), but user ${userId} is assigned to branch ${branchId} — keeping the user`,
        );
        return;
      }
      await this.compensateCreatedUser(userId);
      // 4xx rad javobi (masalan PICKUP filialiga kuryer — 403) RpcException
      // bo'lib ketadi: mijoz aniq xabarni oladi, xabar qayta navbatga
      // qo'yilmaydi va user ikkinchi marta yaratilmaydi.
      throw toFinalClientError(assignError);
    }
  }

  /**
   * CODE-26: user haqiqatan shu filialga biriktirilganmi (saga xatosidan
   * keyingi solishtirish). Ichki o'qish — auth.service bilan bir xil tizim
   * requester'i. Tekshirib bo'lmasa — false (kompensatsiya avvalgidek).
   */
  private async isUserAssignedToBranch(
    userId: string,
    branchId: string,
  ): Promise<boolean> {
    try {
      const response = await rmqSend<{
        data?: { branch_id?: string | number | null } | null;
      }>(
        this.branchClient,
        { cmd: 'branch.user.find_by_user' },
        {
          user_id: String(userId),
          requester: { id: String(userId), roles: [Roles.SUPERADMIN] },
        },
        { attachRequestId: false, retries: 0, timeoutMs: 3000 },
      );
      return sameEntityId(response?.data?.branch_id, branchId);
    } catch {
      return false;
    }
  }

  /**
   * Saga kompensatsiyasi: yangi userni soft-delete. CODE-26: ilgari xatosi
   * jimgina yutilardi — faol, filialsiz yoki kassasiz "arvoh" user qolardi.
   * Endi xato ERROR darajasida loglanadi (qo'lda tozalash uchun user id).
   */
  private async compensateCreatedUser(userId: string): Promise<void> {
    try {
      await this.softCompensateUser(userId);
    } catch (error) {
      this.logger.error(
        `Saga compensation failed: user ${userId} was NOT soft-deleted (${describeSagaError(error)}) — remove it manually`,
      );
    }
  }

  /**
   * CODE-26: yangi user kassasini yaratish. Ilgari xato xom holda otilardi:
   * kuryer faol va filialga biriktirilgan, lekin kassasiz qolardi (keyingi
   * pul amallari 'Cashbox not found'), mijoz esa 500 ko'rardi; qayta urinish
   * esa 409 "telefon band" bilan tugardi. Endi kassa yaratilmasa saga orqaga
   * qaytariladi — filial qatori (bo'lsa) best-effort olib tashlanadi, user
   * soft-delete — va xato biriktirish bosqichidagi kabi qaytariladi (4xx →
   * RpcException; timeout/5xx o'zgarishsiz, mavjud bir martalik qayta navbat
   * saqlanadi — telefon endi bo'sh, shuning uchun qayta ishlash toza).
   */
  private async ensureCreatedUserCashboxOrCompensate(params: {
    userId: string;
    cashboxUserId: string;
    cashboxType: Cashbox_type;
    branchId?: string | null;
    requester?: RequesterContext;
  }): Promise<void> {
    try {
      await this.ensureUserCashbox(params.cashboxUserId, params.cashboxType);
    } catch (cashboxError) {
      this.logger.error(
        `finance.cashbox.create (${params.cashboxType}) failed for new user ${params.userId}: ${describeSagaError(cashboxError)} — rolling the user back`,
      );
      if (params.branchId) {
        await this.unassignCreatedUser(
          params.userId,
          params.branchId,
          params.requester,
        );
      }
      await this.compensateCreatedUser(params.userId);
      throw toFinalClientError(cashboxError);
    }
  }

  /** Kompensatsiya: yangi userning branch_users qatorini olib tashlash. */
  private async unassignCreatedUser(
    userId: string,
    branchId: string,
    requester?: RequesterContext,
  ): Promise<void> {
    try {
      await rmqSend(
        this.branchClient,
        { cmd: 'branch.user.remove' },
        {
          requester,
          branch_id: String(branchId),
          user_id: String(userId),
        },
        { attachRequestId: false, retries: 0, timeoutMs: 5000 },
      );
    } catch (error) {
      this.logger.error(
        `Saga compensation: branch_users row (branch ${branchId}, user ${userId}) was NOT removed (${describeSagaError(error)}) — remove it manually`,
      );
    }
  }

  /**
   * Soft-delete a freshly-created user when a downstream saga step fails.
   * Mirrors the soft-delete shape used by deleteUser() — phone/username are
   * mangled so the original values are free for a retry, but the row remains
   * for audit. Skips the side effects (search sync, catalog cleanup) that
   * are pointless for a never-activated user.
   */
  private async softCompensateUser(userId: string): Promise<void> {
    const admin = await this.users.findOne({
      where: { id: String(userId), isDeleted: false },
    });
    if (!admin) {
      return;
    }
    const ts = Date.now();
    admin.isDeleted = true;
    admin.status = Status.INACTIVE;
    admin.phone_number = `${admin.phone_number}-d${ts % 100000}`.slice(0, 20);
    if (admin.username?.length) {
      admin.username = `${admin.username}#del#${ts % 100000}`.slice(0, 60);
    }
    await this.users.save(admin);
  }

  /**
   * Day-of-month in Toshkent timezone, used as the salary payment day
   * fallback. The server may run in UTC; `new Date().getDate()` would then
   * return the UTC day, which drifts off by ±1 around midnight Toshkent
   * time and makes the first/last day of the month flicker.
   */
  private getBusinessPaymentDay(): number {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tashkent',
      day: 'numeric',
    }).format(new Date());
    const day = Number.parseInt(formatted, 10);
    return Number.isFinite(day) ? day : new Date().getUTCDate();
  }

  private notFound(message: string): never {
    throw new RpcException(errorRes(message, 404));
  }

  private badRequest(message: string): never {
    throw new RpcException(errorRes(message, 400));
  }

  private conflict(message: string): never {
    throw new RpcException(errorRes(message, 409));
  }

  private forbidden(message: string): never {
    throw new RpcException(errorRes(message, 403));
  }

  private hasRole(
    requester: RequesterContext | undefined,
    role: Roles,
  ): boolean {
    return requester?.roles?.includes(role) ?? false;
  }

  private isSelfRequester(
    requester: RequesterContext | undefined,
    targetUserId: string,
  ): boolean {
    return Boolean(
      requester?.id && String(requester.id) === String(targetUserId),
    );
  }

  private assertRequesterCanCreateAdmin(requester?: RequesterContext) {
    if (!requester) {
      return;
    }

    if (this.hasRole(requester, Roles.SUPERADMIN)) {
      return;
    }

    if (this.hasRole(requester, Roles.ADMIN)) {
      this.forbidden('Admin admin yarata olmaydi');
    }

    this.forbidden('Bu amal uchun ruxsat yoq');
  }

  private assertRequesterCanCreateRegistrator(requester?: RequesterContext) {
    if (!requester) {
      return;
    }

    if (
      this.hasRole(requester, Roles.SUPERADMIN) ||
      this.hasRole(requester, Roles.ADMIN) ||
      this.hasRole(requester, Roles.MANAGER)
    ) {
      return;
    }

    this.forbidden('Bu amal uchun ruxsat yoq');
  }

  /**
   * Service-level RBAC for the role-create flows, mirroring the gateway
   * `@Roles(...)` on each route. Defense-in-depth: an absent `requester`
   * (trusted internal call) is allowed; an authenticated caller is checked.
   * Courier/Market: SUPERADMIN | ADMIN | MANAGER. Manager: SUPERADMIN | ADMIN.
   */
  private assertRequesterCanCreateCourier(requester?: RequesterContext) {
    if (!requester) {
      return;
    }

    if (
      this.hasRole(requester, Roles.SUPERADMIN) ||
      this.hasRole(requester, Roles.ADMIN) ||
      this.hasRole(requester, Roles.MANAGER)
    ) {
      return;
    }

    this.forbidden('Bu amal uchun ruxsat yoq');
  }

  private assertRequesterCanCreateManager(requester?: RequesterContext) {
    if (!requester) {
      return;
    }

    if (
      this.hasRole(requester, Roles.SUPERADMIN) ||
      this.hasRole(requester, Roles.ADMIN)
    ) {
      return;
    }

    this.forbidden('Bu amal uchun ruxsat yoq');
  }

  private assertRequesterCanCreateMarket(requester?: RequesterContext) {
    if (!requester) {
      return;
    }

    if (
      this.hasRole(requester, Roles.SUPERADMIN) ||
      this.hasRole(requester, Roles.ADMIN) ||
      this.hasRole(requester, Roles.MANAGER)
    ) {
      return;
    }

    this.forbidden('Bu amal uchun ruxsat yoq');
  }

  private assertRequesterCanMutateUser(
    requester: RequesterContext | undefined,
    targetUserId: string,
    targetRole: Roles,
    options: {
      allowSelf?: boolean;
      // fix #3: manager faqat UPDATE oqimida — va faqat O'ZI YARATGAN
      // (created_by) userlarni tahrirlay oladi. Delete/status oqimlari bu
      // bayroqni BERMAYDI, shuning uchun manager u yerda ruxsatsiz qoladi
      // (admin/superadmin-only). targetCreatedBy — nishon userning created_by'si.
      allowManagerOwnership?: boolean;
      targetCreatedBy?: string | null;
    } = {},
  ) {
    if (!requester) {
      return;
    }

    if (this.hasRole(requester, Roles.SUPERADMIN)) {
      return;
    }

    // RBAC-19: o'z profilini/parolini tahrirlash (PATCH /auth/my-profile).
    // Ilgari ADMIN shoxi o'zini ham "admin" deb 403 qilardi — admin o'z
    // (standart 0990) parolini almashtira olmasdi. Faqat updateUser yoqadi:
    // u o'z-o'zini tahrirlashda status, maosh, to'lov kuni, add_order va
    // komissiyani baribir o'zgartirmaydi, rol esa DTO'da yo'q. O'chirish va
    // statusni o'zgartirish uchun xulq O'ZGARMAGAN.
    if (options.allowSelf && this.isSelfRequester(requester, targetUserId)) {
      return;
    }

    if (this.hasRole(requester, Roles.ADMIN)) {
      if (targetRole === Roles.SUPERADMIN || targetRole === Roles.ADMIN) {
        this.forbidden('Admin admin yoki superadminni boshqara olmaydi');
      }
      return;
    }

    if (this.isSelfRequester(requester, targetUserId)) {
      return;
    }

    if (this.hasRole(requester, Roles.MANAGER)) {
      if (
        targetRole === Roles.SUPERADMIN ||
        targetRole === Roles.ADMIN ||
        targetRole === Roles.MANAGER
      ) {
        this.forbidden('Manager admin/superadmin/managerni boshqara olmaydi');
      }

      // fix #3: delete/status oqimlari managerga ruxsat bermaydi
      // (admin/superadmin-only). Faqat UPDATE oqimi allowManagerOwnership
      // beradi; u yerda ham egalik created_by bo'yicha tekshiriladi.
      if (!options.allowManagerOwnership) {
        this.forbidden('Bu amal uchun ruxsat yoq');
      }

      // fix #3: branch_users (allowed_user_ids) o'rniga — manager faqat O'ZI
      // YARATGAN userni (created_by === requester.id) tahrirlay oladi.
      const targetCreatedBy = String(options.targetCreatedBy ?? '').trim();
      if (
        !targetCreatedBy ||
        targetCreatedBy !== String(requester.id ?? '').trim()
      ) {
        this.forbidden("Manager faqat o'zi yaratgan userlarni yangilay oladi");
      }
      return;
    }

    this.forbidden('Bu amal uchun ruxsat yoq');
  }

  /**
   * Legacy role alias the admin panel still sends: market accounts are
   * labelled "marketing" in the UI, and the user list fires one request per
   * alias and merges them. The DB column is an enum that only knows `market`.
   */
  private static readonly ROLE_ALIASES: Record<string, Roles> = {
    marketing: Roles.MARKET,
  };

  /**
   * `role` and `status` land in the query builder as enum literals, so an
   * unknown value reaches Postgres as an invalid enum input (22P02) and turns
   * a bad filter into a 500. Resolve the aliases and reject the rest here.
   */
  private normalizeEnumFilter<T extends string>(
    value: string | undefined,
    allowed: readonly T[],
    label: string,
    aliases: Record<string, T> = {},
  ): T | undefined {
    if (!value) {
      return undefined;
    }

    const alias = aliases[value];
    if (alias) {
      return alias;
    }

    if (!allowed.includes(value as T)) {
      this.badRequest(`Noto'g'ri ${label}: ${value}`);
    }

    return value as T;
  }

  private normalizeQuery(query: UserFilterQuery = {}) {
    const page = Number(query.page) > 0 ? Number(query.page) : 1;
    const limit =
      Number(query.limit) > 0 ? Math.min(Number(query.limit), 100) : 10;

    return {
      search: query.search?.trim(),
      role: this.normalizeEnumFilter(
        query.role?.trim(),
        Object.values(Roles),
        'role',
        UserServiceService.ROLE_ALIASES,
      ),
      status: this.normalizeEnumFilter(
        query.status?.trim(),
        Object.values(Status),
        'status',
      ),
      region_id: query.region_id?.trim(),
      user_ids: Array.isArray(query.user_ids)
        ? query.user_ids.map((id) => String(id ?? '').trim()).filter(Boolean)
        : [],
      page,
      limit,
      skip: (page - 1) * limit,
    };
  }

  private async ensurePhoneUnique(phone: string, exceptId?: string) {
    const found = await this.users.findOne({
      where: { phone_number: phone, isDeleted: false },
    });

    if (found && found.id !== exceptId) {
      this.conflict('Bu telefon raqam allaqachon mavjud');
    }
  }

  private async ensureUsernameUnique(username: string, exceptId?: string) {
    const found = await this.users.findOne({
      where: { username, isDeleted: false },
    });

    if (found && found.id !== exceptId) {
      this.conflict('Bu username allaqachon mavjud');
    }
  }

  private async validateRegionExists(regionId: string): Promise<void> {
    try {
      const res = await lastValueFrom(
        this.logisticsClient
          .send({ cmd: 'logistics.region.find_by_id' }, { id: regionId })
          .pipe(timeout(5000)),
      );
      const region = res?.data ?? res ?? null;
      if (!region) {
        this.badRequest('Region not found');
      }
    } catch {
      this.badRequest('Region not found');
    }
  }

  private async getRegionsByIds(
    regionIds: string[],
  ): Promise<Map<string, unknown>> {
    if (!regionIds.length) {
      return new Map();
    }

    const resolved = await Promise.all(
      regionIds.map(async (id) => {
        try {
          const res = await lastValueFrom(
            this.logisticsClient
              .send({ cmd: 'logistics.region.find_by_id' }, { id })
              .pipe(timeout(5000)),
          );
          const region = this.stripRegionDistricts(res?.data ?? res ?? null);
          return [id, region] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );

    return new Map(resolved);
  }

  private async getRegionById(regionId?: string | null): Promise<unknown> {
    if (!regionId) {
      return null;
    }

    try {
      const res = await lastValueFrom(
        this.logisticsClient
          .send({ cmd: 'logistics.region.find_by_id' }, { id: regionId })
          .pipe(timeout(5000)),
      );
      return this.stripRegionDistricts(res?.data ?? res ?? null);
    } catch {
      return null;
    }
  }

  private async getUserBranchAssignment(userId: string, role: Roles) {
    try {
      const response = await lastValueFrom(
        this.branchClient
          .send(
            { cmd: 'branch.user.find_by_user' },
            {
              user_id: userId,
              requester: { id: userId, roles: [String(role).toLowerCase()] },
            },
          )
          .pipe(timeout(5000)),
      );
      return response?.data ?? null;
    } catch {
      return null;
    }
  }

  private shouldAttachBranchRelation(
    role: Roles | string | null | undefined,
  ): boolean {
    const normalized = String(role ?? '')
      .trim()
      .toLowerCase();
    return (
      normalized === Roles.MANAGER ||
      normalized === Roles.COURIER ||
      normalized === Roles.BRANCH ||
      normalized === Roles.REGISTRATOR ||
      normalized === 'branch_admin'
    );
  }

  private stripRegionDistricts<T>(region: T): T {
    if (!region || typeof region !== 'object') {
      return region;
    }

    const rest = { ...(region as Record<string, unknown>) };
    delete rest.districts;
    return rest as T;
  }

  private roleToCashboxType(role: Roles): Cashbox_type | null {
    if (role === Roles.MARKET) {
      return Cashbox_type.FOR_MARKET;
    }
    if (role === Roles.COURIER) {
      return Cashbox_type.FOR_COURIER;
    }
    return null;
  }

  private async syncUserToSearch(user: User): Promise<void> {
    try {
      const safe = this.sanitize(user) as User;
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.upsert' },
            {
              source: 'identity',
              type: safe.role,
              sourceId: safe.id,
              title: safe.name,
              content: [safe.phone_number, safe.username]
                .filter(Boolean)
                .join(' '),
              tags: ['identity', safe.role, safe.status].filter(Boolean),
              metadata: {
                role: safe.role,
                status: safe.status,
                phone_number: safe.phone_number,
                username: safe.username,
                region_id: safe.region_id,
                isDeleted: safe.isDeleted,
              },
            },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      // Search sync should not block identity flows, but a persistent silent
      // failure here drifts the search index out of sync with identity DB.
      this.logger.warn(
        `search.index.upsert failed for user ${user.id}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async removeUserFromSearch(user: User): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.remove' },
            { source: 'identity', type: user.role, sourceId: user.id },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.remove failed for user ${user.id}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async ensureUserCashbox(userId: string, cashboxType: Cashbox_type) {
    try {
      await rmqSend(
        this.financeClient,
        { cmd: 'finance.cashbox.create' },
        {
          user_id: userId,
          cashbox_type: cashboxType,
          balance_cash: 0,
          balance_card: 0,
        },
      );
    } catch (error) {
      if (error instanceof RpcException) {
        const payload = (error as any).error;
        const message =
          typeof payload === 'object' && payload?.message
            ? String(payload.message)
            : error.message;
        if (message.includes('Cashbox already exists')) {
          return;
        }
      }
      throw error;
    }
  }

  private generateGroupToken(): string {
    return `group_token-${randomBytes(16).toString('hex')}`;
  }

  async onModuleInit() {
    const config = {
      ADMIN_NAME: this.configService.get<string>('SUPERADMIN_NAME'),
      ADMIN_PHONE_NUMBER: this.configService.get<string>(
        'SUPERADMIN_PHONE_NUMBER',
      ),
      ADMIN_PASSWORD: this.configService.get<string>('SUPERADMIN_PASSWORD'),
    };

    if (
      !config.ADMIN_NAME ||
      !config.ADMIN_PHONE_NUMBER ||
      !config.ADMIN_PASSWORD
    ) {
      throw new RpcException(
        errorRes(
          'SUPERADMIN_NAME, SUPERADMIN_PHONE_NUMBER, SUPERADMIN_PASSWORD .env da bo‘lishi shart',
          500,
        ),
      );
    }

    try {
      const isSuperAdmin = await this.users.findOne({
        where: { role: Roles.SUPERADMIN, isDeleted: false },
      });

      if (!isSuperAdmin) {
        const hashedPassword = await this.bcryptEncryption.encrypt(
          config.ADMIN_PASSWORD,
        );
        const superAdminThis = this.users.create({
          name: config.ADMIN_NAME,
          phone_number: config.ADMIN_PHONE_NUMBER,
          username: null,
          password: hashedPassword,
          role: Roles.SUPERADMIN,
          status: Status.ACTIVE,
          isDeleted: false,
        });
        const savedSuperAdmin = await this.users.save(superAdminThis);
        void this.syncUserToSearch(savedSuperAdmin);
      }
    } catch (error) {
      return catchError(error);
    }
  }

  async createAdmin(dto: CreateAdminDto, requester?: RequesterContext) {
    this.assertRequesterCanCreateAdmin(requester);

    await this.ensurePhoneUnique(dto.phone_number);

    const hashedPassword = await this.bcryptEncryption.encrypt(dto.password);

    const admin = this.users.create({
      name: dto.name,
      phone_number: dto.phone_number,
      username: null,
      password: hashedPassword,
      salary: dto.salary ?? 0,
      payment_day: dto.payment_day ?? this.getBusinessPaymentDay(),
      role: Roles.ADMIN,
      status: Status.ACTIVE,
      // fix #3: yaratuvchini yozamiz — manager keyinchalik FAQAT o'zi yaratgan
      // (created_by) userlarni tahrirlay oladi. requester bo'lmasa (ishonchli
      // ichki chaqiruv) null qoladi.
      created_by: requester?.id ? String(requester.id) : null,
      isDeleted: false,
    });

    const saved = await this.users.save(admin);
    void this.syncUserToSearch(saved);
    await this.activityLog.log({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.CREATED,
      new_value: {
        name: saved.name,
        phone_number: saved.phone_number,
        role: saved.role,
      },
      ...this.auditActor(requester),
    });
    return successRes(this.sanitize(saved), 201, 'Admin yaratildi');
  }

  async createRegistrator(dto: CreateAdminDto, requester?: RequesterContext) {
    this.assertRequesterCanCreateRegistrator(requester);

    await this.ensurePhoneUnique(dto.phone_number);

    const hashedPassword = await this.bcryptEncryption.encrypt(dto.password);

    const registrator = this.users.create({
      name: dto.name,
      phone_number: dto.phone_number,
      username: null,
      password: hashedPassword,
      salary: dto.salary,
      payment_day: dto.payment_day ?? this.getBusinessPaymentDay(),
      role: Roles.REGISTRATOR,
      status: Status.ACTIVE,
      // fix #3: created_by — manager egaligi uchun.
      created_by: requester?.id ? String(requester.id) : null,
      isDeleted: false,
    });

    const saved = await this.users.save(registrator);

    if (dto.branch_id) {
      await this.assignUserToBranchOrCompensate(
        saved.id,
        dto.branch_id,
        'REGISTRATOR',
        requester,
      );
    }

    void this.syncUserToSearch(saved);
    await this.activityLog.log({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.CREATED,
      new_value: {
        name: saved.name,
        phone_number: saved.phone_number,
        role: saved.role,
      },
      ...this.auditActor(requester),
      metadata: dto.branch_id ? { branch_id: dto.branch_id } : null,
    });
    return successRes(this.sanitize(saved), 201, "Ro'yxatchi yaratildi");
  }

  async updateAdmin(id: string, dto: UpdateUserDto) {
    return this.updateUser(id, dto);
  }

  async updateUser(
    id: string,
    dto: UpdateUserDto,
    requester?: RequesterContext,
  ) {
    const admin = await this.users.findOne({
      where: { id, isDeleted: false },
    });

    if (!admin) {
      this.notFound('User topilmadi');
    }
    this.assertRequesterCanMutateUser(requester, id, admin.role, {
      allowSelf: true,
      // fix #3: UPDATE oqimi — manager faqat o'zi yaratgan userni tahrirlay
      // oladi; egalik nishon userning created_by'si bo'yicha aniqlanadi.
      allowManagerOwnership: true,
      targetCreatedBy: admin.created_by,
    });

    const auditBefore = {
      name: admin.name,
      phone_number: admin.phone_number,
      status: admin.status,
      salary: admin.salary,
      payment_day: admin.payment_day,
      tariff_home: admin.tariff_home,
      tariff_center: admin.tariff_center,
      default_tariff: admin.default_tariff,
      commission_type: admin.commission_type,
      commission_value: admin.commission_value,
      add_order: admin.add_order,
      can_add_extra_cost: admin.can_add_extra_cost,
      can_sell_cancel: admin.can_sell_cancel,
      password_changed: false,
    };

    const requesterIsSelf = this.isSelfRequester(requester, id);
    const requesterIsPrivileged =
      this.hasRole(requester, Roles.SUPERADMIN) ||
      this.hasRole(requester, Roles.ADMIN);

    if (dto.phone_number && dto.phone_number !== admin.phone_number) {
      await this.ensurePhoneUnique(dto.phone_number, id);
      admin.phone_number = dto.phone_number;
      // RBAC-09: login (telefon) o'zgardi — eski sessiyalar yopiladi.
      admin.refresh_token = null;
    }

    if (dto.password) {
      admin.password = await this.bcryptEncryption.encrypt(dto.password);
      // RBAC-09: parol almashtirilsa (o'g'irlangan telefon, ishdan
      // bo'shatilgan kuryer) allaqachon kirgan qurilma 7 kungacha refresh
      // qila olardi. Saqlangan refresh hashi o'chiriladi — keyingi refresh
      // 401, qurilma qayta login (yangi parol bilan) qiladi. Access token
      // ko'pi bilan 15 daqiqa yashaydi.
      admin.refresh_token = null;
    }

    if (typeof dto.name !== 'undefined') {
      admin.name = dto.name;
    }

    if (dto.status && !requesterIsSelf) {
      admin.status = dto.status;
    }

    if (typeof dto.salary !== 'undefined' && !requesterIsSelf) {
      admin.salary = dto.salary;
    }

    if (typeof dto.payment_day !== 'undefined' && !requesterIsSelf) {
      admin.payment_day = dto.payment_day;
    }

    if (
      typeof dto.tariff_home !== 'undefined' &&
      (requesterIsPrivileged || !requesterIsSelf)
    ) {
      admin.tariff_home = dto.tariff_home;
    }

    if (
      typeof dto.tariff_center !== 'undefined' &&
      (requesterIsPrivileged || !requesterIsSelf)
    ) {
      admin.tariff_center = dto.tariff_center;
    }

    if (typeof dto.add_order !== 'undefined' && !requesterIsSelf) {
      admin.add_order = dto.add_order;
    }

    if (typeof dto.can_add_extra_cost !== 'undefined') {
      if (!requesterIsPrivileged) {
        this.forbidden(
          "Qo'shimcha xarajat ruxsatini faqat admin yoki superadmin o'zgartira oladi",
        );
      }
      if (![Roles.COURIER, Roles.MANAGER].includes(admin.role)) {
        this.badRequest(
          "Qo'shimcha xarajat ruxsati faqat courier yoki manager uchun",
        );
      }
      admin.can_add_extra_cost = dto.can_add_extra_cost;
    }

    // #4 — Sotish/bekor ruxsati: faqat admin/superadmin bera/ola oladi va faqat
    // manager rol uchun. HYBRID filial menejeri bu bayroqsiz sell/cancel qila
    // olmaydi (backend 403 + frontend tugma yashirin).
    if (typeof dto.can_sell_cancel !== 'undefined') {
      if (!requesterIsPrivileged) {
        this.forbidden(
          "Sotish/bekor ruxsatini faqat admin yoki superadmin o'zgartira oladi",
        );
      }
      if (admin.role !== Roles.MANAGER) {
        this.badRequest('Sotish/bekor ruxsati faqat manager uchun');
      }
      admin.can_sell_cancel = dto.can_sell_cancel;
    }

    if (
      typeof dto.default_tariff !== 'undefined' &&
      (requesterIsPrivileged || !requesterIsSelf)
    ) {
      admin.default_tariff = dto.default_tariff;
    }

    // Commission config: only an admin/superadmin may set it, never self-edit
    // (an operator must not raise their own commission).
    if (
      typeof dto.commission_type !== 'undefined' &&
      requesterIsPrivileged &&
      !requesterIsSelf
    ) {
      admin.commission_type = dto.commission_type;
    }

    if (
      typeof dto.commission_value !== 'undefined' &&
      requesterIsPrivileged &&
      !requesterIsSelf
    ) {
      admin.commission_value = dto.commission_value;
    }

    const saved = await this.users.save(admin);
    void this.syncUserToSearch(saved);
    await this.activityLog.logChange({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.UPDATED,
      old_value: auditBefore,
      new_value: {
        name: saved.name,
        phone_number: saved.phone_number,
        status: saved.status,
        salary: saved.salary,
        payment_day: saved.payment_day,
        tariff_home: saved.tariff_home,
        tariff_center: saved.tariff_center,
        default_tariff: saved.default_tariff,
        commission_type: saved.commission_type,
        commission_value: saved.commission_value,
        add_order: saved.add_order,
        can_add_extra_cost: saved.can_add_extra_cost,
        can_sell_cancel: saved.can_sell_cancel,
        // Surface that the password was rotated without ever logging its value.
        password_changed: Boolean(dto.password),
      },
      ...this.auditActor(requester),
    });
    return successRes(this.sanitize(saved), 200, 'User yangilandi');
  }

  /**
   * identity.courier.set_region — kuryer boshqa filialga o'tkazilganda uning
   * hududini yangi filial hududiga moslaydi. Chaqiruvchi: branch-service
   * (o'tkazish; bekor qilinganda eski hudud ham shu yo'l bilan tiklanadi).
   *
   * Masofaviy chaqiruv YO'Q (validateRegionExists ishlatilmaydi): u logistics'ni
   * 5 s gacha kutadi, branch-service esa set_region'ni 5 s, tiklashni 3 s
   * kutadi — sekin logistics'da o'tkazish bekor qilinib bo'lgach, identity
   * yangi hududni baribir yozib qo'yardi. region_id filial qatoridan
   * (branches.region_id) keladi va HQ'da bo'sh bo'lishi mumkin, shuning uchun
   * faqat raqamli qiymat yoki null qabul qilinadi.
   *
   * Idempotent: hudud o'zgarmagan va tuman allaqachon bo'sh bo'lsa, saqlamasdan
   * 200 qaytadi. district_id har doim tozalanadi — eski tuman yangi hududga
   * tegishli emas.
   *
   * O'qish va yozish BITTA tranzaksiyada, qator `FOR UPDATE` qulfi bilan:
   * o'tkazishdagi set_region(yangi) va uni tiklash (eski) bir vaqtda kelsa,
   * ular ketma-ket bajariladi. `deadlineAt` (epoch ms) QULF OLINGANDAN keyin
   * tekshiriladi: muddat o'tgan bo'lsa — hech narsa yozilmaydi, 409. Shunda
   * kech kelgan set_region(yangi) tiklashdan keyin hech qachon yozilmaydi:
   * tiklash undan oldin bajarilsa — u muddati o'tganini ko'radi; u yarim
   * yo'lda bo'lsa — tiklash qulfni kutib, uning ustidan yozadi. Tiklash va
   * qayta moslash muddatsiz keladi.
   */
  async setCourierRegion(
    id: string,
    regionId: string | null,
    requester?: RequesterContext,
    deadlineAt?: number,
  ) {
    if (
      requester &&
      !this.hasRole(requester, Roles.SUPERADMIN) &&
      !this.hasRole(requester, Roles.ADMIN)
    ) {
      this.forbidden(
        "Kuryer hududini faqat superadmin yoki admin o'zgartira oladi",
      );
    }

    let nextRegionId: string | null = null;
    if (regionId !== null && regionId !== undefined) {
      const rawRegionId = String(regionId);
      if (!/^\d+$/.test(rawRegionId)) {
        this.badRequest("region_id noto'g'ri");
      }
      // Kanonik ko'rinish ('013' ≡ '13') — bigint ustun ham shunday saqlaydi.
      nextRegionId = BigInt(rawRegionId).toString();
    }

    const userId = String(id ?? '');
    if (!/^\d+$/.test(userId)) {
      // Raqamli bo'lmagan id hech qaysi userga mos kelmaydi (bigint PK).
      this.notFound('User topilmadi');
    }

    try {
      const outcome = await this.users.manager.transaction(
        async (entityManager) => {
          const repo = entityManager.getRepository(User);
          const user = await repo.findOne({
            where: { id: userId, isDeleted: false },
            lock: { mode: 'pessimistic_write' },
          });
          if (!user) {
            this.notFound('User topilmadi');
          }
          if (user.role !== Roles.COURIER) {
            this.badRequest(
              "Faqat kuryer hududi shu yo'l bilan o'zgartiriladi",
            );
          }
          // Muddat qulfdan KEYIN: qulfni kutish paytida o'tib ketgan muddat
          // ham ushlanadi. Muddati o'tgan xabar hech narsa yozmaydi (o'zgarmas
          // qiymatda ham — eskirgan xabar hech qachon ishlamaydi).
          if (
            typeof deadlineAt === 'number' &&
            Number.isFinite(deadlineAt) &&
            Date.now() > deadlineAt
          ) {
            throw new RpcException(
              errorRes(COURIER_REGION_DEADLINE_PASSED, 409),
            );
          }

          const previousRegionId =
            user.region_id === null || user.region_id === undefined
              ? null
              : String(user.region_id);
          const previousDistrictId =
            user.district_id === null || user.district_id === undefined
              ? null
              : String(user.district_id);
          if (
            previousRegionId === nextRegionId &&
            previousDistrictId === null
          ) {
            return {
              userId: user.id,
              previousRegionId,
              previousDistrictId,
              saved: null,
            };
          }

          user.region_id = nextRegionId;
          user.district_id = null;
          return {
            userId: user.id,
            previousRegionId,
            previousDistrictId,
            saved: await repo.save(user),
          };
        },
      );

      // Qidiruv va audit — commit'dan KEYIN (qulf ushlab turilmaydi).
      if (outcome.saved) {
        void this.syncUserToSearch(outcome.saved);
        await this.activityLog.logChange({
          entity_type: 'User',
          entity_id: outcome.saved.id,
          action: ActivityAction.UPDATED,
          old_value: {
            region_id: outcome.previousRegionId,
            district_id: outcome.previousDistrictId,
          },
          new_value: { region_id: nextRegionId, district_id: null },
          metadata: { reason: 'courier_transfer' },
          ...this.auditActor(requester),
        });
      }

      return successRes(
        {
          id: outcome.userId,
          region_id: nextRegionId,
          previous_region_id: outcome.previousRegionId,
          district_id: null,
        },
        200,
        'Kuryer hududi yangilandi',
      );
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }
      this.logger.error(
        `identity.courier.set_region failed for user ${userId}: ${(error as Error)?.message ?? error}`,
      );
      throw new RpcException(errorRes(COURIER_REGION_SAVE_FAILED, 503));
    }
  }

  /**
   * Kuryer o'chirilishidan OLDIN: branch.user.courier_transfer_check (o'tkazish
   * bilan bir xil tekshiruv — kassa, hisob-kitob, qo'ldagi buyurtmalar,
   * qaytarilmagan pochtalar, xarajat so'rovlari).
   * - sabablar bor → 409 "Kuryerni o'chirib bo'lmaydi: " + sabablar;
   * - tekshiruv xato bersa, javob bermasa yoki javob buzuq bo'lsa → 503
   *   (fail-closed: ishonch bo'lmasa, kuryer o'chirilmaydi).
   * Kuryerni bloklash (status → inactive) bu tekshiruvdan o'tmaydi: u filial
   * va kassani o'zgartirmaydi, pulni esa baribir qabul qilish mumkin.
   */
  private async assertCourierCanBeDeleted(
    courierId: string,
    requester?: RequesterContext,
  ): Promise<void> {
    let reasons: unknown;
    try {
      const response = await rmqSend<{ data?: { reasons?: unknown } }>(
        this.branchClient,
        { cmd: 'branch.user.courier_transfer_check' },
        { user_id: courierId, requester },
        {
          attachRequestId: false,
          retries: 0,
          timeoutMs: COURIER_DELETE_CHECK_TIMEOUT_MS,
        },
      );
      reasons = response?.data?.reasons;
    } catch (error) {
      this.logger.warn(
        `branch.user.courier_transfer_check failed for courier ${courierId}: ${(error as Error)?.message ?? error}`,
      );
      throw new RpcException(errorRes(COURIER_DELETE_CHECK_UNAVAILABLE, 503));
    }

    if (
      !Array.isArray(reasons) ||
      !reasons.every((reason) => typeof reason === 'string')
    ) {
      throw new RpcException(errorRes(COURIER_DELETE_CHECK_UNAVAILABLE, 503));
    }
    if (reasons.length) {
      this.conflict(COURIER_DELETE_BLOCKED_PREFIX + reasons.join(' '));
    }
  }

  async deleteAdmin(id: string) {
    return this.deleteUser(id);
  }

  async deleteUser(id: string, requester?: RequesterContext) {
    const admin = await this.users.findOne({
      where: { id, isDeleted: false },
    });
    if (!admin) {
      this.notFound('User topilmadi');
    }
    this.assertRequesterCanMutateUser(requester, id, admin.role);

    if (admin.role === Roles.SUPERADMIN) {
      this.badRequest('Superadminni o‘chirib bo‘lmaydi');
    }

    // Kuryerda pul yoki buyurtma qolgan bo'lsa o'chirilmaydi — HECH QANDAY
    // o'zgarishdan oldin (branch_users qatori va kassa o'z holicha qoladi).
    if (admin.role === Roles.COURIER) {
      await this.assertCourierCanBeDeleted(String(admin.id), requester);
    }

    if (admin.role === Roles.MARKET) {
      try {
        await lastValueFrom(
          this.catalogClient
            .send(
              { cmd: 'catalog.product.delete_by_market' },
              { user_id: admin.id },
            )
            .pipe(timeout(5000)),
        );
      } catch {
        throw new RpcException(
          errorRes('Marketga tegishli productlarni o‘chirishda xatolik', 502),
        );
      }
    }

    const ts = Date.now();
    const deletedPhone = `${admin.phone_number}-d${ts % 100000}`.slice(0, 20);
    const deletedUsername = admin.username?.length
      ? `${admin.username}#del#${ts % 100000}`.slice(0, 60)
      : null;

    admin.isDeleted = true;
    admin.status = Status.INACTIVE;
    admin.username = deletedUsername;
    admin.phone_number = deletedPhone;

    const saved = await this.users.save(admin);
    void this.removeUserFromSearch(saved);

    // fix3b (CODE-07): o'chirilgan menejer/registratorning faol branch_users
    // qatori ham olib tashlanadi (best-effort, user baribir o'chirilgan).
    // Kuryer yo'li o'zgarmagan: uni yuqoridagi assertCourierCanBeDeleted
    // qo'riqlaydi.
    if (admin.role === Roles.MANAGER || admin.role === Roles.REGISTRATOR) {
      await this.unassignDeletedStaffFromBranch(String(admin.id), requester);
    }

    await this.activityLog.log({
      entity_type: 'User',
      entity_id: id,
      action: ActivityAction.DELETED,
      old_value: { name: admin.name, role: admin.role },
      ...this.auditActor(requester),
    });

    return successRes({ id }, 200, 'User o‘chirildi');
  }

  /**
   * fix3b (CODE-07): o'chirilgan menejer/registratorning FAOL branch_users
   * qatorini soft-delete qiladi (`branch.user.remove`, so'rovchi bilan).
   * Ilgari qator qolardi: filial "menejeri bor" deb hisoblanib, unga pochta
   * jo'natilardi. Branch-service o'qishlari o'chirilgan/bloklangan menejerni
   * identity orqali allaqachon chetlab o'tadi — bu tozalash, shuning uchun
   * BEST-EFFORT: xato yoki timeout faqat WARN log, o'chirish to'xtamaydi.
   * Byudjet: 3 s + 5 s, gateway DELETE /users/:id (15 s) ichida.
   */
  private async unassignDeletedStaffFromBranch(
    userId: string,
    requester?: RequesterContext,
  ): Promise<void> {
    let branchId = '';
    try {
      const response = await rmqSend<{
        data?: { branch_id?: string | number | null } | null;
      }>(
        this.branchClient,
        { cmd: 'branch.user.find_by_user' },
        {
          user_id: userId,
          // Ichki o'qish — isUserAssignedToBranch bilan bir xil tizim requester'i.
          requester: { id: userId, roles: [Roles.SUPERADMIN] },
        },
        { attachRequestId: false, retries: 0, timeoutMs: 3000 },
      );
      branchId = String(response?.data?.branch_id ?? '').trim();
    } catch (error) {
      this.logger.warn(
        `deleteUser: branch.user.find_by_user failed for user ${userId} (${describeSagaError(error)}) — its branch_users row (if any) was NOT removed`,
      );
      return;
    }
    if (!branchId) {
      return;
    }

    try {
      await rmqSend(
        this.branchClient,
        { cmd: 'branch.user.remove' },
        { requester, branch_id: branchId, user_id: userId },
        { attachRequestId: false, retries: 0, timeoutMs: 5000 },
      );
    } catch (error) {
      this.logger.warn(
        `deleteUser: branch_users row (branch ${branchId}, user ${userId}) was NOT removed (${describeSagaError(error)}) — remove it manually`,
      );
    }
  }

  async findUserById(id: string, options: { includeTgToken?: boolean } = {}) {
    const user = await this.users.findOne({
      where: { id, isDeleted: false },
    });
    if (!user) {
      this.notFound('User topilmadi');
    }

    // market_tg_token faqat aniq `true` flag bilan VA faqat market qatorida
    // qaytadi — xodim qatorida qolib ketgan eski qiymat ham chiqmaydi.
    const safeUser =
      options?.includeTgToken === true && user.role === Roles.MARKET
        ? this.sanitizeWithTgToken(user)
        : this.sanitize(user);
    const profileRegion = await this.getRegionById(safeUser.region_id);
    return successRes({
      ...safeUser,
      region: profileRegion,
    });
  }

  async findOwnProfile(id: string) {
    const user = await this.users.findOne({
      where: { id, isDeleted: false },
    });
    if (!user) {
      this.notFound('User topilmadi');
    }

    const safeUser = this.sanitize(user);
    const profileRegion = await this.getRegionById(safeUser.region_id);
    const profileBranch = this.shouldAttachBranchRelation(safeUser.role)
      ? await this.getUserBranchAssignment(String(safeUser.id), safeUser.role)
      : null;

    return successRes({
      ...safeUser,
      region: profileRegion,
      branch: profileBranch,
    });
  }

  /**
   * Update the requester's OWN UI preferences (theme, language, dashboard
   * widget visibility, ...). Stored opaquely; the frontend owns the shape and
   * sends the full settings object on each save.
   */
  async updateOwnSettings(
    id: string,
    settings: Record<string, unknown> | null,
  ) {
    const user = await this.users.findOne({
      where: { id, isDeleted: false },
    });
    if (!user) {
      this.notFound('User topilmadi');
    }
    user.settings = settings && typeof settings === 'object' ? settings : null;
    await this.users.save(user);
    await this.activityLog.log({
      entity_type: 'User',
      entity_id: id,
      action: ActivityAction.UPDATED,
      user_id: id,
      // Never log the settings values themselves (UI prefs may carry tokens
      // in future); only which keys changed.
      metadata: {
        changed_keys:
          user.settings && typeof user.settings === 'object'
            ? Object.keys(user.settings)
            : [],
      },
    });
    return successRes({ settings: user.settings }, 200, 'Settings updated');
  }

  async findCustomerById(id: string) {
    const user = await this.users.findOne({
      where: { id, role: Roles.CUSTOMER, isDeleted: false },
    });
    if (!user) {
      this.notFound('Customer topilmadi');
    }

    return successRes(this.sanitize(user));
  }

  async findAdminById(id: string) {
    return this.findUserById(id);
  }

  async findAllAdmins(query: UserFilterQuery = {}) {
    const { search, role, status, region_id, user_ids, page, limit, skip } =
      this.normalizeQuery(query);

    const baseQb = this.users
      .createQueryBuilder('admin')
      .where('admin.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('admin.role != :superadminRole', {
        superadminRole: Roles.SUPERADMIN,
      })
      .andWhere('admin.role != :customerRole', {
        customerRole: Roles.CUSTOMER,
      });

    if (search) {
      baseQb.andWhere(
        new Brackets((nested) => {
          nested
            .where('admin.name ILIKE :search', { search: `%${search}%` })
            .orWhere('admin.phone_number ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere('admin.username ILIKE :search', { search: `%${search}%` });
        }),
      );
    }

    if (status) {
      baseQb.andWhere('admin.status = :status', { status });
    }

    if (region_id) {
      baseQb.andWhere('admin.region_id = :region_id', { region_id });
    }

    if (user_ids.length) {
      baseQb.andWhere('admin.id IN (:...user_ids)', { user_ids });
    }

    const listQb = baseQb.clone();
    if (role) {
      listQb.andWhere('admin.role = :role', { role });
    }

    const [rows, total] = await listQb
      .clone()
      .orderBy('admin.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const [totalMarket, totalEmployees, totalUsers] = await Promise.all([
      baseQb
        .clone()
        .andWhere('admin.role = :marketRole', { marketRole: Roles.MARKET })
        .getCount(),
      baseQb
        .clone()
        .andWhere('admin.role IN (:...employeeRoles)', {
          employeeRoles: [Roles.ADMIN, Roles.REGISTRATOR, Roles.COURIER],
        })
        .getCount(),
      baseQb.clone().getCount(),
    ]);

    return successRes({
      items: rows.map((row) => this.sanitize(row)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        totalMarket,
        totalEmployees,
        totalUsers,
      },
    });
  }

  async findAllCouriers(query: UserFilterQuery = {}) {
    const { search, status, region_id, user_ids, page, limit, skip } =
      this.normalizeQuery(query);

    const qb = this.users
      .createQueryBuilder('courier')
      .where('courier.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('courier.role = :role', { role: Roles.COURIER });

    if (search) {
      qb.andWhere(
        new Brackets((nested) => {
          nested
            .where('courier.name ILIKE :search', { search: `%${search}%` })
            .orWhere('courier.phone_number ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere('courier.username ILIKE :search', {
              search: `%${search}%`,
            });
        }),
      );
    }

    if (status) {
      qb.andWhere('courier.status = :status', { status });
    }

    if (region_id) {
      qb.andWhere('courier.region_id = :region_id', { region_id });
    }

    // Gateway filial kuryerlarini (branch_users) oldindan beradi — filtr
    // SAHIFALASHDAN OLDIN qo'llanadi, shuning uchun meta.total ham to'g'ri.
    if (user_ids.length) {
      qb.andWhere('courier.id IN (:...user_ids)', { user_ids });
    }

    const [rows, total] = await qb
      .orderBy('courier.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const regionIds = Array.from(
      new Set(
        rows
          .map((row) => row.region_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const regionsById = await this.getRegionsByIds(regionIds);

    return successRes({
      items: rows.map((row) => ({
        ...this.sanitize(row),
        region: row.region_id ? (regionsById.get(row.region_id) ?? null) : null,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  }

  async createMarket(dto: CreateMarketDto, requester?: RequesterContext) {
    this.assertRequesterCanCreateMarket(requester);
    if (
      typeof dto.expense_proof_conditions !== 'undefined' &&
      !this.hasRole(requester, Roles.SUPERADMIN) &&
      !this.hasRole(requester, Roles.ADMIN)
    ) {
      this.forbidden(
        "Market rasm/video isbot sozlamasini faqat admin yoki superadmin o'zgartira oladi",
      );
    }

    await this.ensurePhoneUnique(dto.phone_number);
    await this.ensureUsernameUnique(dto.username);

    const hashedPassword = await this.bcryptEncryption.encrypt(dto.password);

    const market = this.users.create({
      name: dto.name,
      phone_number: dto.phone_number,
      username: dto.username,
      address: dto.address ?? null,
      password: hashedPassword,
      salary: 0,
      payment_day: undefined,
      market_tg_token: this.generateGroupToken(),
      market_id: null,
      telegram_id: null,
      avatar_id: null,
      role: Roles.MARKET,
      status: Status.ACTIVE,
      // fix #3: created_by — manager egaligi uchun.
      created_by: requester?.id ? String(requester.id) : null,
      tariff_home: dto.tariff_home,
      tariff_center: dto.tariff_center,
      add_order: dto.add_order ?? false,
      cancelled_handover_qr_required:
        dto.cancelled_handover_qr_required ?? true,
      expense_proof_conditions: dto.expense_proof_conditions ?? null,
      default_tariff: dto.default_tariff,
      isDeleted: false,
    });

    const saved = await this.users.save(market);
    await this.ensureCreatedUserCashboxOrCompensate({
      userId: saved.id,
      cashboxUserId: saved.id,
      cashboxType: Cashbox_type.FOR_MARKET,
      requester,
    });
    void this.syncUserToSearch(saved);
    await this.activityLog.log({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.CREATED,
      new_value: {
        name: saved.name,
        username: saved.username,
        role: saved.role,
      },
      ...this.auditActor(requester),
    });
    return successRes(this.sanitize(saved), 201, 'Market yaratildi');
  }

  async createCourier(dto: CreateCourierDto, requester?: RequesterContext) {
    this.assertRequesterCanCreateCourier(requester);

    await this.validateRegionExists(dto.region_id);
    await this.ensurePhoneUnique(dto.phone_number);

    const hashedPassword = await this.bcryptEncryption.encrypt(dto.password);

    const courier = this.users.create({
      name: dto.name,
      phone_number: dto.phone_number,
      username: null,
      password: hashedPassword,
      salary: dto.salary,
      payment_day: dto.payment_day ?? this.getBusinessPaymentDay(),
      region_id: dto.region_id,
      role: Roles.COURIER,
      status: Status.ACTIVE,
      // fix #3: created_by — manager egaligi uchun.
      created_by: requester?.id ? String(requester.id) : null,
      tariff_home: dto.tariff_home ?? 0,
      tariff_center: dto.tariff_center ?? 0,
      add_order: false,
      can_add_extra_cost: false,
      default_tariff: null,
      isDeleted: false,
    });

    const saved = await this.users.save(courier);

    if (dto.branch_id) {
      await this.assignUserToBranchOrCompensate(
        saved.id,
        dto.branch_id,
        'COURIER',
        requester,
      );
    }

    await this.ensureCreatedUserCashboxOrCompensate({
      userId: saved.id,
      cashboxUserId: saved.id,
      cashboxType: Cashbox_type.FOR_COURIER,
      branchId: dto.branch_id,
      requester,
    });
    void this.syncUserToSearch(saved);
    await this.activityLog.log({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.CREATED,
      new_value: {
        name: saved.name,
        phone_number: saved.phone_number,
        role: saved.role,
      },
      ...this.auditActor(requester),
      metadata: dto.branch_id ? { branch_id: dto.branch_id } : null,
    });
    return successRes(this.sanitize(saved), 201, 'Courier yaratildi');
  }

  /**
   * HQ'ga menejer biriktirilmaydi — user yaratilishidan OLDIN tekshiriladi.
   *
   * Nega bu yerda ham (branch-service assignUserToBranch ham rad etadi):
   * saga (assignUserToBranchOrCompensate) 4xx rad javobini endi
   * toFinalClientError orqali aniq status bilan qaytaradi, lekin u user
   * SAQLANGANIDAN keyin keladi — user yoziladi, so'ng soxta telefon bilan
   * o'chiriladi. Bu yerda — RpcException 400, hech qanday user yozilmaydi,
   * parol hashlanmaydi.
   *
   * branch.find_hq xato bersa — 502 (fail-closed: HQ'ni aniqlay olmasak,
   * menejer yaratilmaydi). Timeout 3s × (1 + 1 retry) ≈ 6.2s — gateway'ning
   * 8s byudjetidan kichik, shuning uchun mijoz gateway timeout'i emas, aniq
   * 502 xabarini oladi (find_hq — bitta indeksli o'qish).
   *
   * branch_id FAQAT raqamlardan iborat bo'lishi shart, aks holda 400
   * "branch_id noto'g'ri". Sabab: Postgres '+1', ' 1 ', '0x1' kabi satrlarni
   * ham bigint 1 ga (HQ'ga) aylantiradi, satr sifatida esa ular HQ id'siga
   * teng chiqmasdi — tekshiruv chetlab o'tilardi. Trim ATAYLAB yo'q:
   * createManager xom dto.branch_id'ni saga va kassa chaqiruvlariga
   * uzatadi; gateway DTO'si (@Matches(/^\d+$/)) ham aynan shularni rad etadi.
   * Solishtirish kanonik ko'rinishda (BigInt(x).toString()): '01' ≡ '1'.
   */
  private async assertManagerBranchIsNotHq(branchId?: string | null) {
    if (branchId === undefined || branchId === null || branchId === '') {
      // Filialsiz so'rov: createManager ham hech qayerga biriktirmaydi.
      return;
    }
    const rawBranchId = String(branchId);
    if (!/^\d+$/.test(rawBranchId)) {
      this.badRequest("branch_id noto'g'ri");
    }
    const targetBranchId = BigInt(rawBranchId).toString();

    let hqBranchId = '';
    try {
      const response = await rmqSend<{ data?: { id?: string | number } }>(
        this.branchClient,
        { cmd: 'branch.find_hq' },
        {},
        { attachRequestId: false, retries: 1, timeoutMs: 3000 },
      );
      const rawHqId = String(response?.data?.id ?? '').trim();
      // Raqamli bo'lmagan HQ id'si — HQ aniqlanmadi deb hisoblanadi (502).
      hqBranchId = /^\d+$/.test(rawHqId) ? BigInt(rawHqId).toString() : '';
    } catch {
      hqBranchId = '';
    }
    if (!hqBranchId) {
      throw new RpcException(errorRes('Filial xizmati javob bermadi', 502));
    }

    if (hqBranchId === targetBranchId) {
      this.badRequest(HQ_MANAGER_FORBIDDEN_MESSAGE);
    }
  }

  async createManager(dto: CreateManagerDto, requester?: RequesterContext) {
    this.assertRequesterCanCreateManager(requester);

    await this.assertManagerBranchIsNotHq(dto?.branch_id);

    await this.ensurePhoneUnique(dto.phone_number);

    const hashedPassword = await this.bcryptEncryption.encrypt(dto.password);

    const manager = this.users.create({
      name: dto.name,
      phone_number: dto.phone_number,
      username: null,
      password: hashedPassword,
      salary: dto.salary ?? 0,
      payment_day: dto.payment_day ?? this.getBusinessPaymentDay(),
      role: Roles.MANAGER,
      status: Status.ACTIVE,
      // fix #3: created_by — manager egaligi uchun.
      created_by: requester?.id ? String(requester.id) : null,
      tariff_home: dto.tariff_home ?? null,
      tariff_center: dto.tariff_center ?? null,
      add_order: false,
      can_add_extra_cost: false,
      default_tariff: null,
      isDeleted: false,
    });

    const saved = await this.users.save(manager);

    if (dto.branch_id) {
      await this.assignUserToBranchOrCompensate(
        saved.id,
        dto.branch_id,
        'MANAGER',
        requester,
      );
      await this.ensureCreatedUserCashboxOrCompensate({
        userId: saved.id,
        cashboxUserId: dto.branch_id,
        cashboxType: Cashbox_type.BRANCH,
        branchId: dto.branch_id,
        requester,
      });
    }

    void this.syncUserToSearch(saved);
    await this.activityLog.log({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.CREATED,
      new_value: {
        name: saved.name,
        phone_number: saved.phone_number,
        role: saved.role,
      },
      ...this.auditActor(requester),
      metadata: dto.branch_id ? { branch_id: dto.branch_id } : null,
    });
    return successRes(this.sanitize(saved), 201, 'Manager yaratildi');
  }

  async createCustomer(dto: CreateCustomerDto) {
    const existing = await this.users.findOne({
      where: [{ phone_number: dto.phone_number, isDeleted: false }],
    });

    if (existing) {
      if (existing.role !== Roles.CUSTOMER) {
        this.conflict('Bu telefon raqam boshqa rolda allaqachon mavjud');
      }

      /**
       * MAVJUD MIJOZNI YANGILASH (j70YS4zJ).
       *
       * Elchi mijozni telefon bo'yicha topsa, ilgari mavjud yozuvni HECH
       * NARSA yangilamasdan qaytarardi — kuryer esa eski (ehtimol noto'g'ri)
       * ism/tumanni ko'rib qolardi. Endi berilgan va FARQ QILADIGAN
       * maydonlarni yozamiz.
       *
       * ⚠️ FAQAT berilgan (non-null) qiymatlar yoziladi — bo'sh/kelmagan DTO
       * eski ism/tuman/manzilni O'CHIRMASLIGI kerak.
       */
      const patch: Partial<User> = {};
      if (dto.name != null && dto.name !== existing.name) {
        patch.name = dto.name;
      }
      if (dto.district_id != null && dto.district_id !== existing.district_id) {
        patch.district_id = dto.district_id;
      }
      if (dto.address != null && dto.address !== existing.address) {
        patch.address = dto.address;
      }
      if (
        dto.extra_number != null &&
        dto.extra_number !== existing.extra_number
      ) {
        patch.extra_number = dto.extra_number;
      }

      if (Object.keys(patch).length > 0) {
        Object.assign(existing, patch);
        const updated = await this.users.save(existing);
        void this.syncUserToSearch(updated);
        return successRes(this.sanitize(updated), 200, 'Customer yangilandi');
      }

      return successRes(
        this.sanitize(existing),
        200,
        'Customer allaqachon mavjud',
      );
    }

    // Crypto-strong throwaway password. Customers authenticate by phone/OTP, not
    // this value, but it must not be guessable if a password path is ever enabled.
    const generatedPassword = `cust_${randomBytes(12).toString('hex')}`;
    const customer = this.users.create({
      name: dto.name,
      phone_number: dto.phone_number,
      extra_number: dto.extra_number ?? null,
      address: dto.address ?? null,
      district_id: dto.district_id,
      username: null,
      password: await this.bcryptEncryption.encrypt(generatedPassword),
      salary: 0,
      payment_day: undefined,
      role: Roles.CUSTOMER,
      status: Status.ACTIVE,
      tariff_home: null,
      tariff_center: null,
      add_order: false,
      can_add_extra_cost: false,
      default_tariff: null,
      isDeleted: false,
    });

    const saved = await this.users.save(customer);
    void this.syncUserToSearch(saved);
    await this.activityLog.log({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.CREATED,
      new_value: {
        name: saved.name,
        phone_number: saved.phone_number,
        role: saved.role,
      },
    });
    return successRes(this.sanitize(saved), 201, 'Customer yaratildi');
  }

  async updateMarket(
    id: string,
    dto: UpdateMarketDto,
    requester?: RequesterContext,
  ) {
    const market = await this.users.findOne({
      where: { id, role: Roles.MARKET, isDeleted: false },
    });

    if (!market) {
      this.notFound('Market topilmadi');
    }

    const auditBefore = {
      name: market.name,
      phone_number: market.phone_number,
      address: market.address,
      status: market.status,
      tariff_home: market.tariff_home,
      tariff_center: market.tariff_center,
      default_tariff: market.default_tariff,
      add_order: market.add_order,
      cancelled_handover_qr_required: market.cancelled_handover_qr_required,
      expense_proof_conditions: market.expense_proof_conditions,
      password_changed: false,
    };

    if (dto.phone_number && dto.phone_number !== market.phone_number) {
      await this.ensurePhoneUnique(dto.phone_number, id);
      market.phone_number = dto.phone_number;
      // RBAC-09: login (telefon) o'zgardi — eski sessiyalar yopiladi.
      market.refresh_token = null;
    }

    if (dto.password) {
      market.password = await this.bcryptEncryption.encrypt(dto.password);
      // RBAC-09: yangi parol — eski qurilmalar endi refresh qila olmaydi.
      market.refresh_token = null;
    }

    if (typeof dto.name !== 'undefined') {
      market.name = dto.name;
    }

    if (typeof dto.address !== 'undefined') {
      market.address = dto.address;
    }

    if (typeof dto.status !== 'undefined') {
      market.status = dto.status;
    }

    if (typeof dto.tariff_home !== 'undefined') {
      market.tariff_home = dto.tariff_home;
    }

    if (typeof dto.tariff_center !== 'undefined') {
      market.tariff_center = dto.tariff_center;
    }

    if (typeof dto.default_tariff !== 'undefined') {
      market.default_tariff = dto.default_tariff;
    }

    if (typeof dto.add_order !== 'undefined') {
      market.add_order = dto.add_order;
    }

    if (typeof dto.cancelled_handover_qr_required !== 'undefined') {
      market.cancelled_handover_qr_required =
        dto.cancelled_handover_qr_required;
    }

    if (typeof dto.expense_proof_conditions !== 'undefined') {
      const requesterIsPrivileged =
        this.hasRole(requester, Roles.SUPERADMIN) ||
        this.hasRole(requester, Roles.ADMIN);
      if (!requesterIsPrivileged) {
        this.forbidden(
          "Market rasm/video isbot sozlamasini faqat admin yoki superadmin o'zgartira oladi",
        );
      }
      // De-dupe; empty array clears the policy (proof never required).
      market.expense_proof_conditions = Array.from(
        new Set(dto.expense_proof_conditions),
      );
    }

    const saved = await this.users.save(market);
    void this.syncUserToSearch(saved);
    await this.activityLog.logChange({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.UPDATED,
      old_value: auditBefore,
      new_value: {
        name: saved.name,
        phone_number: saved.phone_number,
        address: saved.address,
        status: saved.status,
        tariff_home: saved.tariff_home,
        tariff_center: saved.tariff_center,
        default_tariff: saved.default_tariff,
        add_order: saved.add_order,
        cancelled_handover_qr_required: saved.cancelled_handover_qr_required,
        expense_proof_conditions: saved.expense_proof_conditions,
        password_changed: Boolean(dto.password),
      },
    });
    return successRes(this.sanitize(saved), 200, 'Market yangilandi');
  }

  async deleteMarket(id: string) {
    const market = await this.users.findOne({
      where: { id, role: Roles.MARKET, isDeleted: false },
    });
    if (!market) {
      this.notFound('Market topilmadi');
    }

    try {
      await lastValueFrom(
        this.catalogClient
          .send({ cmd: 'catalog.product.delete_by_market' }, { user_id: id })
          .pipe(timeout(5000)),
      );
    } catch {
      throw new RpcException(
        errorRes('Marketga tegishli productlarni o‘chirishda xatolik', 502),
      );
    }

    const ts = Date.now();
    const deletedPhone = `${market.phone_number}-d${ts % 100000}`.slice(0, 20);
    const deletedUsername = market.username?.length
      ? `${market.username}#del#${ts % 100000}`.slice(0, 60)
      : null;

    market.isDeleted = true;
    market.status = Status.INACTIVE;
    market.username = deletedUsername;
    market.phone_number = deletedPhone;

    const saved = await this.users.save(market);
    void this.removeUserFromSearch(saved);

    await this.activityLog.log({
      entity_type: 'User',
      entity_id: id,
      action: ActivityAction.DELETED,
      old_value: { name: market.name, role: Roles.MARKET },
    });

    return successRes({ id }, 200, 'Market o‘chirildi');
  }

  async findMarketById(id: string) {
    const market = await this.users.findOne({
      where: { id, role: Roles.MARKET, isDeleted: false },
    });
    if (!market) {
      this.notFound('Market topilmadi yoki faol emas');
    }

    return {
      success: true,
      data: this.sanitize(market),
    };
  }

  async findMarketByTelegramToken(market_tg_token: string) {
    const token = String(market_tg_token ?? '').trim();
    if (!token) {
      throw new RpcException(errorRes('market_tg_token is required', 400));
    }

    // Backward compatible, but still restricts to expected token-like shape.
    if (!/^group_token-[a-z0-9]{14,64}$/i.test(token)) {
      throw new RpcException(
        errorRes('market_tg_token format is invalid', 400),
      );
    }

    const market = await this.users.findOne({
      where: {
        market_tg_token: token,
        role: Roles.MARKET,
        isDeleted: false,
      },
    });

    if (!market) {
      this.notFound('Market topilmadi yoki token noto‘g‘ri');
    }

    return {
      success: true,
      data: this.sanitize(market),
    };
  }

  /**
   * market_tg_token'ni QAYTARADIGAN yagona RPC (identity.market.rotate_tg_token).
   * Faqat ichki. fix3b: notification-service uni endi CHAQIRMAYDI — guruh
   * ulangandan keyin token almashtirilmaydi (u marketning order-bot kaliti).
   * RPC o'zgarmagan holda qoldirildi (hozir chaqiruvchisi yo'q). Gateway'da bu RPC'ga olib boradigan
   * HTTP route bo'lmasligi SHART — aks holda token yana ochiq qoladi.
   */
  async rotateMarketTelegramToken(id: string) {
    const market = await this.users.findOne({
      where: { id, role: Roles.MARKET, isDeleted: false },
    });

    if (!market) {
      this.notFound('Market topilmadi');
    }

    market.market_tg_token = this.generateGroupToken();
    const saved = await this.users.save(market);

    await this.activityLog.log({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.UPDATED,
      // Credential rotation: record only that it happened, NEVER the token value.
      metadata: { rotated: true, market_id: saved.id },
    });

    return successRes(
      {
        id: saved.id,
        market_tg_token: saved.market_tg_token,
      },
      200,
      'Market telegram token yangilandi',
    );
  }

  async findMarketsByIds(ids: string[]) {
    if (!ids.length) {
      return { success: true, data: [] };
    }

    const markets = await this.users.find({
      where: {
        id: In(ids),
        role: Roles.MARKET,
        isDeleted: false,
      },
    });

    return {
      success: true,
      data: markets.map((m) => this.sanitize(m)),
    };
  }

  async findAllMarkets(query: UserFilterQuery = {}) {
    const { search, status, page, limit, skip } = this.normalizeQuery(query);

    const qb = this.users
      .createQueryBuilder('market')
      .where('market.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('market.role = :role', { role: Roles.MARKET });

    if (search) {
      qb.andWhere(
        new Brackets((nested) => {
          nested
            .where('market.name ILIKE :search', { search: `%${search}%` })
            .orWhere('market.phone_number ILIKE :search', {
              search: `%${search}%`,
            })
            .orWhere('market.username ILIKE :search', {
              search: `%${search}%`,
            });
        }),
      );
    }

    if (status) {
      qb.andWhere('market.status = :status', { status });
    }

    const [rows, total] = await qb
      .orderBy('market.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return successRes({
      items: rows.map((row) => this.sanitize(row)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  }

  async setUserStatus(
    id: string,
    status: Status,
    requester?: RequesterContext,
  ) {
    const user = await this.users.findOne({
      where: { id, isDeleted: false },
    });

    if (!user) {
      this.notFound('User topilmadi');
    }
    this.assertRequesterCanMutateUser(requester, id, user.role);

    const previousStatus = user.status;
    user.status = status;
    const saved = await this.users.save(user);
    void this.syncUserToSearch(saved);

    await this.activityLog.log({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.STATUS_CHANGE,
      old_value: { status: previousStatus },
      new_value: { status: saved.status },
      ...this.auditActor(requester),
    });

    return successRes(this.sanitize(saved), 200, 'User status yangilandi');
  }

  async findCustomersByIds(ids: string[]) {
    if (!ids.length) {
      return { success: true, data: [] };
    }

    const customers = await this.users.find({
      where: {
        id: In(ids),
        role: Roles.CUSTOMER,
        isDeleted: false,
      },
    });

    return {
      success: true,
      data: customers.map((c) => this.sanitize(c)),
    };
  }

  async findCouriersByIds(ids: string[]) {
    if (!ids.length) {
      return { success: true, data: [] };
    }

    const couriers = await this.users.find({
      where: {
        id: In(ids),
        role: Roles.COURIER,
        isDeleted: false,
      },
    });

    return {
      success: true,
      data: couriers.map((c) => this.sanitize(c)),
    };
  }

  async searchCustomers(search: string, limit = 1000) {
    if (!search?.trim()) {
      return { success: true, data: [] };
    }

    const qb = this.users
      .createQueryBuilder('u')
      .where('u.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('u.role = :role', { role: Roles.CUSTOMER })
      .andWhere(
        new Brackets((q) => {
          q.where('u.name ILIKE :s', { s: `%${search.trim()}%` }).orWhere(
            'u.phone_number ILIKE :s',
            { s: `%${search.trim()}%` },
          );
        }),
      )
      // Barqaror tartib: limitdan oshganda qaysi mijozlar qaytishi tasodifiy
      // bo'lmasin (eng yangilari birinchi).
      .orderBy('u.id', 'DESC')
      .take(limit);

    const rows = await qb.getMany();
    return {
      success: true,
      data: rows.map((r) => this.sanitize(r)),
    };
  }

  async findByUsernameForAuth(username: string) {
    return this.users.findOne({
      where: { username, isDeleted: false, status: Status.ACTIVE },
    });
  }

  async findByPhoneForAuth(phone_number: string) {
    return this.users.findOne({
      where: { phone_number, isDeleted: false, status: Status.ACTIVE },
    });
  }

  /**
   * SMS/push yetkazish uchun kontaktlar (bir so'rovda): telefon, rol, til.
   * O'chirilgan foydalanuvchilar qaytmaydi. Til: mijoz — `language` ustuni,
   * xodim — `settings.appearance.language` (bo'lmasa ustun).
   */
  async contactsByIds(ids: unknown) {
    const clean = [
      ...new Set(
        (Array.isArray(ids) ? ids : [])
          .map((id) => String(id ?? '').trim())
          .filter((id) => /^\d+$/.test(id)),
      ),
    ].slice(0, 5000);
    if (!clean.length) return successRes([]);
    const rows = await this.users.find({
      where: { id: In(clean), isDeleted: false },
      select: ['id', 'phone_number', 'role', 'language', 'settings'],
    });
    return successRes(
      rows.map((row) => {
        const appearance = (
          row.settings as { appearance?: { language?: unknown } } | null
        )?.appearance;
        const staffLanguage =
          typeof appearance?.language === 'string' ? appearance.language : null;
        return {
          id: String(row.id),
          phone_number: row.phone_number,
          role: row.role,
          language:
            row.role === Roles.CUSTOMER
              ? row.language
              : (staffLanguage ?? row.language),
        };
      }),
    );
  }

  async findByIdForAuth(id: string) {
    return this.users.findOne({
      where: { id, isDeleted: false, status: Status.ACTIVE },
    });
  }

  async createUserForAuth(
    username: string,
    password: string,
    phone_number?: string,
  ) {
    await this.ensureUsernameUnique(username);
    await this.ensurePhoneUnique(phone_number ?? username);

    const user = this.users.create({
      name: username,
      username,
      phone_number: phone_number ?? username,
      password: await this.bcryptEncryption.encrypt(password),
      salary: 0,
      payment_day: undefined,
      role: Roles.CUSTOMER,
      status: Status.ACTIVE,
      isDeleted: false,
    });

    const saved = await this.users.save(user);
    void this.syncUserToSearch(saved);
    return saved;
  }

  // ==================== Activity log (read) ====================

  /** Paginated activity-log query (gateway fan-in). */
  async auditLogQuery(q: ActivityLogQuery) {
    return this.activityLog.query(q ?? {});
  }

  /** Activity-log rows for a single entity (gateway fan-in). */
  async auditLogByEntity(
    entity_type: string,
    entity_id: string,
    limit?: number,
  ) {
    return this.activityLog.findByEntity(entity_type, entity_id, limit ?? 50);
  }
}
