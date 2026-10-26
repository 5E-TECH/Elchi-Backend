import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import {
  Brackets,
  ILike,
  In,
  QueryFailedError,
  Raw,
  Repository,
  WhereExpressionBuilder,
} from 'typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';
import { randomBytes } from 'crypto';
import { BcryptEncryption } from '../../../libs/common/helpers/bcrypt';
import { User } from './entities/user.entity';
import { CourierRegion } from './entities/courier-region.entity';
import { invalidateAllSessions, isSessionId } from './auth/session-security';
import { AuthSessionService } from './auth/auth-session.service';
import {
  CHANGEABLE_ROLES,
  ROLE_CATALOG,
  roleCatalogEntry,
} from './roles/role-catalog';
import { CreateAdminDto } from './dto/create-admin.dto';
import {
  AI_PRICE_PER_ORDER_MAX_UZS,
  USER_LANGUAGES,
  UpdateUserDto,
} from './dto/update-user.dto';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';
import { CreateCourierDto } from './dto/create-courier.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { CreateManagerDto } from './dto/create-manager.dto';
import {
  UpdateCustomerCardPayload,
  UserFilterQuery,
} from './contracts/user.payloads';
import { MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM } from './contracts/market.payloads';
import {
  CreateMarketOperatorDto,
  UpdateMarketOperatorCommissionDto,
} from './dto/market-operator.dto';
import type { MarketOperatorFilterQuery } from './contracts/market-operator.payloads';
import {
  ActivityAction,
  ActivityDescribeUz,
  ActivityLogService,
  Cashbox_type,
  Commission_type,
  Roles,
  Status,
  normalizeUzPhone,
  parseUzPhoneSearch,
  rmqSend,
  uzPhoneDigitsLikeSql,
} from '@app/common';
import type { ActivityLogQuery, UzPhoneSearch } from '@app/common';
import {
  catchError,
  errorRes,
  successRes,
} from '../../../libs/common/helpers/response';
import { RequesterContext } from './contracts/user.payloads';
import {
  resolveAudience,
  type AudienceResolveInput,
} from './audience/audience-resolver';

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
 * (dzyVftBx, TC4) Logistni o'chirish: avval uning viloyatlari bo'shatiladi
 * (`logistics.region.clear_logist` → `regions.logist_id = NULL`), keyin user
 * soft-delete qilinadi. Sxemalararo FK yo'q va user soft-delete bo'ladi —
 * `ON DELETE SET NULL` ni shu qadam bajaradi. Bo'shatib bo'lmasa logist
 * O'CHIRILMAYDI (503, fail-closed): aks holda viloyat o'chirilgan userga
 * ishora qilib qolardi.
 *
 * Qadam idempotent, shuning uchun bitta qayta urinish bor: 2 × 5 s + kechikish
 * < gateway DELETE /users/:id 15 s.
 */
export const LOGIST_DELETE_RELEASE_FAILED =
  "Logistni viloyatlardan ajratib bo'lmadi — logist o'chirilmadi. Birozdan so'ng qayta urinib ko'ring.";
const LOGIST_RELEASE_TIMEOUT_MS = 5000;

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
 * Market operatorlari (i76gGjyq): boshqa marketning operatori ham, umuman
 * yo'q id ham BIR XIL 404 oladi — 403 id mavjudligini oshkor qilardi.
 */
const MARKET_OPERATOR_NOT_FOUND = 'Operator topilmadi yoki sizga tegishli emas';

/**
 * Operator komissiyasi chegaralari (i76gGjyq, BeePost bilan bir xil):
 * PERCENT — total_price foizi (0..100), FIXED — sotilgan buyurtma uchun
 * so'm (0..1 000 000). Undan kattasi deyarli albatta klaviatura xatosi —
 * finance har sotuvda shu qiymatdan daromad yozadi.
 */
const MARKET_OPERATOR_PERCENT_MAX = 100;
const MARKET_OPERATOR_FIXED_MAX = 1_000_000;

/**
 * (GvL6ZFAd) market_tg_token — bearer sir: uni order-bot yoki bildirishnoma
 * botiga yuborgan HAR KIM o'sha marketni o'z chatiga bog'laydi. Ko'rish va
 * almashtirish FAQAT SUPERADMIN (gateway RolesGuard + shu servisdagi qayta
 * tekshiruv). Jurnalga faqat amal yoziladi — token QIYMATI hech qachon.
 */
const MARKET_TG_TOKEN_FORBIDDEN =
  "Market Telegram tokenini faqat superadmin ko'ra va almashtira oladi";
const MARKET_TG_TOKEN_MARKET_NOT_FOUND = 'Market topilmadi';
const MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM_REQUIRED = `Barcha market tokenlarini almashtirish uchun so'rov tanasida confirm: '${MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM}' yuboring`;
const MARKET_TG_TOKEN_ROTATE_FAILED =
  "Market Telegram tokenini almashtirib bo'lmadi — hech bir token o'zgarmadi. Qayta urinib ko'ring.";

export const MARKET_TG_TOKEN_AUDIT_ACTION = {
  VIEWED: 'market.tg_token_viewed',
  ROTATED: 'market.tg_token_rotated',
  ROTATED_ALL: 'market.tg_token_rotated_all',
} as const;

/** rotate-all jurnal qatorining entity_id si (bitta qator — barcha marketlar). */
export const MARKET_TG_TOKEN_ROTATE_ALL_ENTITY_ID = 'all_markets';

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

/**
 * Mijozning ESKI (normallashtirilmagan) yozuv shakllari (zfPNDCCr).
 *
 * Normallashtirishdan oldin mijoz telefoni XOM satr bilan yozilardi (prod
 * E2E: "900000001", "+998 90 000 00 01"). Ma'lumot migratsiyasisiz yangi
 * buyurtma o'sha mijozga tushishi uchun kanonik raqamdan keyin shu shakllar
 * bo'yicha ham izlanadi (unique indeks — `IN (...)`, jadval to'liq
 * skanerlanmaydi). Ro'yxatdagi HAR shakl `normalizeUzPhone` da AYNI kanonik
 * raqamga qaytadi — begona odamning raqami hech qachon tushmaydi.
 *
 * `rawPhone` — kiritilgan xom satr (o'sha odam avval aynan shu shaklda
 * yozilgan bo'lsa). Kanonikning o'zi bu yerda yo'q — u 1-qadamda tekshiriladi.
 */
function legacyCustomerPhoneForms(phone: string, rawPhone: string): string[] {
  const n = phone.slice(4); // milliy 9 raqam
  const spaced = `+998 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5, 7)} ${n.slice(7)}`;
  return [
    ...new Set([`998${n}`, n, `0${n}`, `8${n}`, spaced, rawPhone]),
  ].filter(
    (form) =>
      form.length > 0 &&
      form.length <= 20 &&
      form !== phone &&
      normalizeUzPhone(form) === phone,
  );
}

/**
 * Batch `*.find_by_ids` uchun id ro'yxatini tozalaydi: takrorsiz, faqat
 * bigint chegarasidagi musbat butun sonlar (aks holda Postgres xatosi — 500),
 * ko'pi bilan 500 ta.
 */
function cleanBigintIds(ids: unknown): string[] {
  return [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((id) => primitiveText(id).trim())
        .filter(
          (id) =>
            /^\d{1,19}$/.test(id) &&
            BigInt(id) <= BigInt('9223372036854775807'),
        ),
    ),
  ].slice(0, 500);
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

/**
 * oNAE3LW9 — `identity.user.reassign_district` kirishi (order/identity/branch dagi
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

/** (C4R3YyvH) Mijoz tili: faqat uz/ru/en, aks holda null (o'zgartirilmaydi). */
function customerLanguage(value: unknown): 'uz' | 'ru' | 'en' | null {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (USER_LANGUAGES as readonly string[]).includes(text)
    ? (text as 'uz' | 'ru' | 'en')
    : null;
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
    /**
     * (Elchi Pochta #3, 2026-10-23) Parol almashganda sessiyalarni DARHOL
     * yopish (`afterPasswordChange`). Ixtiyoriy: spec'lar servisni usiz
     * quradi — u holda avvalgidek faqat epoch (hammasi, refresh paytida).
     */
    @Optional() private readonly authSessions?: AuthSessionService,
  ) {}

  /**
   * Umumiy RPC javoblariga HECH QACHON kirmaydigan maydonlar:
   * - password — bcrypt hash;
   * - refresh_token — eski (bitta sessiya) refresh JWT'ning sha256 hashi;
   * - session_epoch — sessiyalar davri (ichki xavfsizlik hisoblagichi);
   * - market_tg_token — marketning Telegram bot/guruh kaliti (bearer);
   * - telegram_id — shaxsiy chat manzili (td89SKXQ): o'rniga `telegram_linked`.
   *
   * market_tg_token ilgari order/analytics/finance/catalog/branch javoblaridagi
   * market obyektlari orqali menejer, registrator, kuryer va boshqa
   * marketlarga ham yetib borardi.
   *
   * (GvL6ZFAd) ISTISNO YO'Q: token hech bir umumiy javobda (GET /users,
   * GET /users/:id — SUPERADMIN uchun ham, GET /markets, profil, market
   * qidiruvi) qaytmaydi. Uni ko'rish va almashtirish faqat SUPERADMIN-only
   * maxsus RPC'lar orqali: identity.market.get_tg_token,
   * identity.market.rotate_tg_token, identity.market.rotate_all_tg_tokens.
   * Avvalgi `include_tg_token` / sanitizeWithTgToken yo'li olib tashlandi.
   */
  private sanitize(
    user: User,
  ): Omit<
    User,
    | 'password'
    | 'refresh_token'
    | 'session_epoch'
    | 'market_tg_token'
    | 'telegram_id'
  > & { telegram_linked?: boolean } {
    const safeUser: Partial<User> & { telegram_linked?: boolean } = {
      ...user,
    };
    delete safeUser.password;
    delete safeUser.refresh_token;
    delete safeUser.session_epoch;
    delete safeUser.market_tg_token;
    // (td89SKXQ #5 / 4TfLyTrL) telegram_id — chat manzili, javobga chiqmaydi;
    // o'rniga faqat holat (profil "ulangan/ulanmagan", admin ro'yxati).
    if ('telegram_id' in safeUser) {
      safeUser.telegram_linked = Boolean(safeUser.telegram_id);
      delete safeUser.telegram_id;
    }
    return safeUser as Omit<
      User,
      | 'password'
      | 'refresh_token'
      | 'session_epoch'
      | 'market_tg_token'
      | 'telegram_id'
    > & { telegram_linked?: boolean };
  }

  /** Normalise the RMQ requester into activity-log actor fields. */
  /**
   * `users.created_by` — bigint ustun. Ichki servislar so'rovchini raqam
   * bo'lmagan id bilan yuborishi mumkin (integration partner market
   * provisioning: `partner:2`) — uni yozish Postgres xatosi bilan butun
   * yaratishni yiqitardi (POST /partner/markets → 502). Faqat raqamli id
   * yoziladi, qolganida egalik yo'q (null).
   */
  private createdByOf(requester?: RequesterContext): string | null {
    const raw = (requester as { id?: string | number | null } | undefined)?.id;
    const id = raw === undefined || raw === null ? '' : String(raw).trim();
    return /^\d+$/.test(id) ? id : null;
  }

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

  /** vpKijXce: investor logini — SUPERADMIN | ADMIN (gateway POST /investor-users bilan bir xil). */
  private assertRequesterCanCreateInvestorUser(requester?: RequesterContext) {
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

  /** (dzyVftBx) Logist: SUPERADMIN | ADMIN (gateway POST /logists bilan bir xil). */
  private assertRequesterCanCreateLogist(requester?: RequesterContext) {
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
      // 2CBnPAeg: `null` — ko'lam yo'q; massiv (bo'sh ham) — ko'lam bor.
      branch_scope_user_ids:
        query.branch_scope && typeof query.branch_scope === 'object'
          ? (Array.isArray(query.branch_scope.user_ids)
              ? query.branch_scope.user_ids
              : []
            )
              .map((id) => primitiveText(id).trim())
              .filter((id) => /^\d{1,19}$/.test(id))
          : null,
      telegram_linked: this.normalizeTelegramLinkedFilter(
        query.telegram_linked,
      ),
      page,
      limit,
      skip: (page - 1) * limit,
    };
  }

  /**
   * yA31z7Rr — RMQ'da ValidationPipe yo'q: `true`/`false` (yoki shu matnlar);
   * berilmagan / bo'sh — filtr yo'q; boshqa qiymat — 400 (SQL'ga yetmaydi).
   */
  private normalizeTelegramLinkedFilter(value: unknown): boolean | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    this.badRequest("telegram_linked faqat true yoki false bo'lishi mumkin");
  }

  /**
   * zfPNDCCr: qidiruv matni telefonga o'xshasa (`parseUzPhoneSearch`),
   * `<alias>.phone_number` ning FAQAT RAQAMLARI ichidan milliy 9 raqam
   * (qisman raqamda — kiritilgan raqamlar) izlanadi: "0330991009" yoki
   * "+998 33 099 10 09" bilan "+998330991009" (va eski "998330991009",
   * "+998 33 099 10 09") topiladi. Telefon bo'lmasa hech narsa qo'shilmaydi.
   */
  private orWherePhoneDigits(
    q: WhereExpressionBuilder,
    alias: string,
    phoneSearch: UzPhoneSearch | null,
  ) {
    if (!phoneSearch) return;
    q.orWhere(uzPhoneDigitsLikeSql(`${alias}.phone_number`), {
      phoneDigits: `%${phoneSearch.digits}%`,
    });
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
      created_by: this.createdByOf(requester),
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
      created_by: this.createdByOf(requester),
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

  /**
   * (dzyVftBx) Logist yaratish — admin/registrator naqshi (ism, telefon,
   * parol, maosh, to'lov kuni). Logist filial xodimi emas: `branch_id`
   * e'tiborga olinmaydi (gateway DTO'sida u umuman yo'q), kassa ham
   * ochilmaydi (roleToCashboxType → null). Viloyatlar keyin
   * PATCH /region/:id/logist yoki POST /region/logist/bulk bilan beriladi.
   */
  async createLogist(dto: CreateAdminDto, requester?: RequesterContext) {
    this.assertRequesterCanCreateLogist(requester);

    await this.ensurePhoneUnique(dto.phone_number);

    const hashedPassword = await this.bcryptEncryption.encrypt(dto.password);

    const logist = this.users.create({
      name: dto.name,
      phone_number: dto.phone_number,
      username: null,
      password: hashedPassword,
      salary: dto.salary ?? 0,
      payment_day: dto.payment_day ?? this.getBusinessPaymentDay(),
      role: Roles.LOGIST,
      status: Status.ACTIVE,
      created_by: this.createdByOf(requester),
      isDeleted: false,
    });

    const saved = await this.users.save(logist);
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
    return successRes(this.sanitize(saved), 201, 'Logist yaratildi');
  }

  /**
   * vpKijXce — INVESTOR LOGINI (BeePost `POST /users/investor` naqshi).
   *
   * Elchida investor roli, `/investors/me` marshrutlari va investor
   * yozuvidagi `user_id` bor edi, lekin investor rolli foydalanuvchini
   * yaratishning birorta yo'li yo'q edi — `/investors/me` ni hech kim
   * ishlata olmasdi. Faqat kirish uchun: ism, telefon, parol. Maosh, to'lov
   * kuni, filial, kassa YO'Q (roleToCashboxType → null). Kapital/ulush/foyda
   * investor-service'da; login `PATCH /investors/:id {user_id}` bilan
   * bog'lanadi.
   */
  async createInvestorUser(
    dto: { name: string; phone_number: string; password: string },
    requester?: RequesterContext,
  ) {
    this.assertRequesterCanCreateInvestorUser(requester);

    const name = String(dto?.name ?? '').trim();
    const phoneNumber = String(dto?.phone_number ?? '').trim();
    const password = String(dto?.password ?? '');
    if (!name || !phoneNumber || !password) {
      this.badRequest('name, phone_number va password majburiy');
    }

    await this.ensurePhoneUnique(phoneNumber);

    const hashedPassword = await this.bcryptEncryption.encrypt(password);

    const investorUser = this.users.create({
      name,
      phone_number: phoneNumber,
      username: null,
      password: hashedPassword,
      salary: 0,
      role: Roles.INVESTOR,
      status: Status.ACTIVE,
      created_by: this.createdByOf(requester),
      isDeleted: false,
    });

    const saved = await this.users.save(investorUser);
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
    return successRes(this.sanitize(saved), 201, 'Investor login yaratildi');
  }

  /**
   * (dzyVftBx) logistics-service viloyatga logist biriktirishdan oldin
   * chaqiradi: faqat o'chirilmagan LOGIST qatorlari (status bilan — faolligini
   * logistics tekshiradi). findCouriersByIds bilan bir xil shakl.
   */
  async findLogistsByIds(ids: unknown) {
    const clean = cleanBigintIds(ids);
    if (!clean.length) {
      return { success: true, data: [] };
    }

    const logists = await this.users.find({
      where: {
        id: In(clean),
        role: Roles.LOGIST,
        isDeleted: false,
      },
    });

    return {
      success: true,
      data: logists.map((row) => this.sanitize(row)),
    };
  }

  async updateAdmin(id: string, dto: UpdateUserDto) {
    return this.updateUser(id, dto);
  }

  async updateUser(
    id: string,
    dto: UpdateUserDto,
    requester?: RequesterContext,
    /**
     * (Elchi Pochta #3) So'rov yuborgan sessiya (gateway: JWT `sid`) — parolni
     * o'zi almashtirsa shu sessiya saqlanadi. Faqat gateway uzatadi.
     */
    options: { currentSessionId?: string | null } = {},
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
      language: admin.language,
      ai_price_per_order: admin.ai_price_per_order ?? null,
      can_order_from_warehouse: admin.can_order_from_warehouse ?? false,
      district_id: admin.district_id ?? null,
      password_changed: false,
    };

    const requesterIsSelf = this.isSelfRequester(requester, id);
    const requesterIsPrivileged =
      this.hasRole(requester, Roles.SUPERADMIN) ||
      this.hasRole(requester, Roles.ADMIN);
    const epochBefore = Number(admin.session_epoch) || 0;

    if (dto.phone_number && dto.phone_number !== admin.phone_number) {
      await this.ensurePhoneUnique(dto.phone_number, id);
      admin.phone_number = dto.phone_number;
      // RBAC-09: login (telefon) o'zgardi — eski sessiyalar yopiladi
      // (Elchi Pochta #3: HAMMA qurilmalardagi sessiyalar).
      invalidateAllSessions(admin);
    }

    let passwordChanged = false;
    if (dto.password) {
      admin.password = await this.bcryptEncryption.encrypt(dto.password);
      // RBAC-09: parol almashtirilsa (o'g'irlangan telefon, ishdan
      // bo'shatilgan kuryer) boshqa qurilmalar DARHOL chiqariladi.
      // (Elchi Pochta #3, 2026-10-23) Qaysi sessiya qolishi — saqlashdan
      // oldin `preparePasswordChangeSessions`, yopish — saqlangandan keyin.
      passwordChanged = true;
    }

    if (typeof dto.name !== 'undefined') {
      admin.name = dto.name;
    }

    // (C4R3YyvH) Til — o'zi ham (profil), admin ham o'zgartira oladi. RMQ'da
    // ValidationPipe yo'q — ruxsat etilgan qiymat shu yerda ham tekshiriladi.
    if (typeof dto.language !== 'undefined') {
      if (
        !(USER_LANGUAGES as readonly string[]).includes(String(dto.language))
      ) {
        this.badRequest(`language: ${USER_LANGUAGES.join(', ')}`);
      }
      admin.language = dto.language;
    }

    if (dto.status && !requesterIsSelf) {
      admin.status = dto.status;
      // (Elchi Pochta #3) Bloklash — barcha sessiyalar yopiladi: blokdan
      // chiqarilganda eski qurilmalar o'z-o'zidan qaytib kirmaydi.
      if (dto.status !== Status.ACTIVE) {
        invalidateAllSessions(admin);
      }
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

    // NFiXfmq6 — market AI buyurtma narxi: faqat SUPERADMIN/ADMIN (market
    // o'z narxini o'zgartira olmaydi), faqat MARKET yozuvida. RMQ'da
    // ValidationPipe yo'q — qiymat shu yerda ham tekshiriladi. Eski AI
    // buyurtmalar qayta hisoblanmaydi (narx har buyurtmada muzlatilgan).
    if (typeof dto.ai_price_per_order !== 'undefined') {
      if (!requesterIsPrivileged || requesterIsSelf) {
        this.forbidden(
          "AI buyurtma narxini faqat admin yoki superadmin o'zgartira oladi",
        );
      }
      if (admin.role !== Roles.MARKET) {
        this.badRequest('AI buyurtma narxi faqat market uchun');
      }
      admin.ai_price_per_order = this.normalizeAiPricePerOrder(
        dto.ai_price_per_order,
      );
    }

    // hY7uacJu — «Ombordan buyurtma yaratish»: faqat SUPERADMIN/ADMIN, faqat
    // MARKET yozuvida; RMQ'da ValidationPipe yo'q — qiymat boolean bo'lsin.
    if (typeof dto.can_order_from_warehouse !== 'undefined') {
      if (!requesterIsPrivileged || requesterIsSelf) {
        this.forbidden(
          "«Ombordan buyurtma yaratish» ruxsatini faqat admin yoki superadmin o'zgartira oladi",
        );
      }
      if (admin.role !== Roles.MARKET) {
        this.badRequest(
          '«Ombordan buyurtma yaratish» ruxsati faqat market uchun',
        );
      }
      if (typeof dto.can_order_from_warehouse !== 'boolean') {
        this.badRequest(
          "can_order_from_warehouse boolean (true/false) bo'lishi kerak",
        );
      }
      admin.can_order_from_warehouse = dto.can_order_from_warehouse;
    }

    /**
     * YEThmZBn — tuman (`district_id`). Ilgari DTO'da yo'q edi: PATCH
     * forbidNonWhitelisted tufayli 400 qaytarardi. Tuman mavjud va
     * foydalanuvchining viloyatiga (`region_id`) tegishli bo'lishi shart;
     * viloyati yo'q foydalanuvchida (mijoz) — faqat mavjudligi. `null` —
     * tozalash. Viloyat bu yerda O'ZGARMAYDI (kuryer hududi faqat «Boshqa
     * filialga o'tkazish» orqali). Tarif bilan bir xil qoida: o'zini
     * tahrirlayotgan oddiy foydalanuvchi o'zgartira olmaydi.
     */
    if (
      typeof dto.district_id !== 'undefined' &&
      (requesterIsPrivileged || !requesterIsSelf)
    ) {
      admin.district_id = await this.resolveUserDistrictId(
        dto.district_id,
        admin.region_id,
      );
    }

    const keepSessionId = passwordChanged
      ? this.preparePasswordChangeSessions(admin, {
          epochBefore,
          isSelf: requesterIsSelf,
          currentSessionId: options.currentSessionId,
        })
      : null;

    const saved = await this.users.save(admin);
    const revokedSessionIds = passwordChanged
      ? await this.revokeSessionsAfterPasswordChange(saved, {
          keepSessionId,
          isSelf: requesterIsSelf,
          requester,
        })
      : null;
    // (NDmZMzCP) Bloklash / telefon almashishi — sessiyalar DARHOL yopiladi.
    await this.revokeSessionsAfterSecurityChange(saved, epochBefore);
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
        language: saved.language,
        ai_price_per_order: saved.ai_price_per_order ?? null,
        can_order_from_warehouse: saved.can_order_from_warehouse ?? false,
        district_id: saved.district_id ?? null,
        // Surface that the password was rotated without ever logging its value.
        password_changed: Boolean(dto.password),
      },
      ...this.auditActor(requester),
    });
    return {
      ...successRes(this.sanitize(saved), 200, 'User yangilandi'),
      ...this.passwordChangeReply(revokedSessionIds),
    };
  }

  /**
   * (Elchi Pochta #3, 2026-10-23) Parol almashtirilganda — SAQLASHDAN OLDIN
   * (AYNI `users.save()` ga tushadi). Qaysi sessiya qoladi:
   *  - foydalanuvchi parolni O'ZI almashtirdi, so'rov `sid` li sessiyadan va
   *    shu so'rovda boshqa xavfsizlik hodisasi yo'q (telefon / bloklash —
   *    epoch oshmagan) → JORIY sessiya qoladi: epoch OSHIRILMAYDI (joriy
   *    sessiya epoch'i yaroqli qolsin; boshqalarini parol izi baribir rad
   *    etadi va saqlangandan keyin ular aniq yopiladi). Eski
   *    `refresh_token` ustuni tozalanadi — deploy'dan oldingi token yangi
   *    parol izi bilan `adoptLegacy` orqali tirilmasin;
   *  - aks holda (admin/menejer boshqa foydalanuvchi parolini tiklayapti,
   *    `sid` siz token, telefon ham almashdi, sessiyalar servisi yo'q) →
   *    `invalidateAllSessions` — HAMMASI, avvalgidek atomar.
   * Qaytadi — saqlanadigan sessiya id si yoki `null`.
   */
  private preparePasswordChangeSessions(
    user: User,
    input: {
      epochBefore: number;
      isSelf: boolean;
      currentSessionId?: string | null;
    },
  ): string | null {
    const epochBumped = (Number(user.session_epoch) || 0) !== input.epochBefore;
    if (
      this.authSessions &&
      input.isSelf &&
      !epochBumped &&
      isSessionId(input.currentSessionId)
    ) {
      user.refresh_token = null;
      return input.currentSessionId.toLowerCase();
    }
    if (!epochBumped) invalidateAllSessions(user);
    return null;
  }

  /**
   * (Elchi Pochta #3, 2026-10-23) SAQLANGANDAN KEYIN: sessiyalar
   * `password_changed` bilan DARHOL yopiladi (48 soatlik qulfga bog'liq
   * emas) va jurnalga yoziladi — `logout` fe'li, `scope: 'password_change'`
   * (egasi yopgan sessiyalar yozuvi bilan bir xil shakl). Qaytadi — yopilgan
   * id lar (gateway keshi uchun); servis yo'q yoki xato — `null`.
   *
   * Xato parol almashtirishni bekor QILMAYDI (parol allaqachon saqlangan):
   * eski sessiyalar refresh'da parol izi bo'yicha baribir rad etiladi, faqat
   * ularning access tokeni ≤ ACCESS_TOKEN_TIME yashashi mumkin — ogohlantirish.
   */
  private async revokeSessionsAfterPasswordChange(
    user: User,
    input: {
      keepSessionId: string | null;
      isSelf: boolean;
      requester?: RequesterContext;
    },
  ): Promise<string[] | null> {
    if (!this.authSessions) return null;
    let result: Awaited<ReturnType<AuthSessionService['afterPasswordChange']>>;
    try {
      result = await this.authSessions.afterPasswordChange({
        user,
        keepSessionId: input.keepSessionId,
      });
    } catch (error) {
      this.logger.warn(
        `Parol almashgach sessiyalar yopilmadi (user ${user.id}): ${describeSagaError(error)} — refresh baribir parol izi bo'yicha rad etadi`,
      );
      return null;
    }
    const kept = result.kept_session_id !== null;
    await this.activityLog.log({
      entity_type: 'Auth',
      entity_id: user.id,
      action: ActivityAction.LOGOUT,
      ...(kept
        ? { user_id: user.id, user_name: user.name, user_role: user.role }
        : this.auditActor(input.requester)),
      metadata: {
        scope: 'password_change',
        by: input.isSelf ? 'self' : 'admin',
        kept_current: kept,
        sessions_revoked: result.session_ids.length,
        session_ids: result.session_ids,
      },
      description: ActivityDescribeUz.sessionsRevokedByPasswordChange(
        kept ? 'current' : 'none',
        result.session_ids.length,
      ),
    });
    return result.session_ids;
  }

  /**
   * Parol almashgan javobga: `sessions_revoked` (FE uchun soni) va ichki
   * `revoked_session_ids` (gateway o'z keshida darhol «yopilgan» deb
   * belgilaydi va javobdan OLIB TASHLAYDI).
   */
  /**
   * (NDmZMzCP, 2026-10-26) SAQLANGANDAN KEYIN: xavfsizlik hodisasi
   * (`invalidateAllSessions` — bloklash, rol / telefon almashishi,
   * o'chirish) epoch'ni oshirgan bo'lsa, ochiq sessiyalar shu zahoti
   * `security_reset` bilan yopiladi va gateway'ga e'lon qilinadi (keshda
   * «yopilgan», socketlar `auth:session_revoked` olib uziladi) — soatlik
   * tozalashni kutmaydi. `epochBefore` berilsa va epoch o'zgarmagan bo'lsa —
   * hech narsa (oddiy tahrir). Parol almashtirish yo'li o'zgarmagan
   * (`revokeSessionsAfterPasswordChange` avval yopadi — `password_changed`
   * sababi saqlanadi). Xato biznes amalini bekor QILMAYDI: gateway
   * `session_state` baribir epoch bo'yicha ≤ 30 soniyada rad etadi.
   */
  private async revokeSessionsAfterSecurityChange(
    user: Pick<User, 'id' | 'session_epoch'>,
    epochBefore?: number,
  ): Promise<void> {
    if (!this.authSessions) return;
    if (
      typeof epochBefore === 'number' &&
      (Number(user.session_epoch) || 0) === epochBefore
    ) {
      return;
    }
    try {
      await this.authSessions.revokeStaleEpoch(String(user.id));
    } catch (error) {
      this.logger.warn(
        `Xavfsizlik hodisasidan keyin sessiyalar yopilmadi (user ${user.id}): ${describeSagaError(error)} — gateway session_state baribir epoch bo'yicha rad etadi`,
      );
    }
  }

  private passwordChangeReply(revokedSessionIds: string[] | null): {
    sessions_revoked?: number;
    revoked_session_ids?: string[];
  } {
    return revokedSessionIds
      ? {
          sessions_revoked: revokedSessionIds.length,
          revoked_session_ids: revokedSessionIds,
        }
      : {};
  }

  /**
   * NFiXfmq6: `null` — global narx; aks holda 0..AI_PRICE_PER_ORDER_MAX_UZS
   * oralig'idagi son (2 xonagacha yaxlitlanadi). Boshqa qiymat — 400.
   */
  private normalizeAiPricePerOrder(value: unknown): number | null {
    if (value === null) return null;
    const n = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(n) || n < 0 || n > AI_PRICE_PER_ORDER_MAX_UZS) {
      this.badRequest(
        `ai_price_per_order: 0..${AI_PRICE_PER_ORDER_MAX_UZS} so'm yoki null`,
      );
    }
    return Math.round(n * 100) / 100;
  }

  /**
   * YEThmZBn — PATCH /users/:id `district_id`: `null` → tozalash; aks holda
   * raqamli id, logistics'da mavjud tuman (yo'q — 400) va foydalanuvchida
   * viloyat bo'lsa — AYNAN shu viloyat tumani (boshqa viloyat — 400).
   * RMQ'da ValidationPipe yo'q — format shu yerda ham tekshiriladi.
   * Logistika javob bermasa — 503 (tekshirilmagan tuman yozilmaydi).
   */
  private async resolveUserDistrictId(
    value: unknown,
    userRegionId: string | null | undefined,
  ): Promise<string | null> {
    if (value === null) {
      return null;
    }
    const districtId = primitiveText(value).trim();
    if (!GEO_ID_PATTERN.test(districtId)) {
      this.badRequest("district_id raqamli ID bo'lishi kerak");
    }

    type DistrictRow = { id?: unknown; region_id?: unknown };
    let district: DistrictRow | null;
    try {
      const res = await lastValueFrom(
        this.logisticsClient
          .send<{
            data?: DistrictRow | null;
          }>({ cmd: 'logistics.district.find_by_id' }, { id: districtId })
          .pipe(timeout(5000)),
      );
      district = res?.data ?? null;
    } catch (error) {
      const statusCode = Number(
        (error as { statusCode?: unknown } | null)?.statusCode ??
          (error as { error?: { statusCode?: unknown } } | null)?.error
            ?.statusCode,
      );
      if (statusCode === 404) {
        this.badRequest('Tuman topilmadi');
      }
      this.logger.warn(
        `user district: logistics.district.find_by_id ${districtId} failed (${describeSagaError(error)})`,
      );
      throw new RpcException(
        errorRes(
          "Tumanni tekshirib bo'lmadi — birozdan keyin qayta urinib ko'ring",
          503,
        ),
      );
    }
    if (!district) {
      this.badRequest('Tuman topilmadi');
    }

    const regionId = primitiveText(userRegionId).trim();
    if (regionId && !sameEntityId(district.region_id, regionId)) {
      this.badRequest('Tuman foydalanuvchining viloyatiga tegishli emas');
    }
    return primitiveText(district.id).trim() || districtId;
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

  /**
   * (dzyVftBx, TC4) `logistics.region.clear_logist` — logistning barcha
   * viloyatlarida `logist_id = NULL` (LOGIST_DELETE_RELEASE_FAILED ga
   * qarang). Xato, timeout yoki rad javobi → 503 (fail-closed).
   */
  private async releaseLogistRegionsOrFail(
    logistId: string,
    requester?: RequesterContext,
    failureMessage: string = LOGIST_DELETE_RELEASE_FAILED,
  ): Promise<void> {
    try {
      await rmqSend(
        this.logisticsClient,
        { cmd: 'logistics.region.clear_logist' },
        { logist_id: logistId, requester },
        {
          attachRequestId: false,
          retries: 1,
          timeoutMs: LOGIST_RELEASE_TIMEOUT_MS,
        },
      );
    } catch (error) {
      this.logger.warn(
        `deleteUser: logistics.region.clear_logist failed for logist ${logistId} (${describeSagaError(error)}) — logist NOT deleted`,
      );
      throw new RpcException(errorRes(failureMessage, 503));
    }
  }

  /**
   * K3scaE0W — GET /roles: rol katalogi (Roles enum'ining to'liq ro'yxati,
   * o'zbekcha nom, yaratish marshruti, almashtirish mumkinmi). Frontend
   * RoleSelector / UserFilters shu javobdan quriladi.
   */
  getRoleCatalog() {
    return successRes(
      {
        items: ROLE_CATALOG.map((item) => ({ ...item })),
        changeable_roles: [...CHANGEABLE_ROLES],
      },
      200,
      'Role catalog',
    );
  }

  /**
   * K3scaE0W — PATCH /users/:id/role: rolni o'zgartirish (faqat SUPERADMIN).
   *
   * Ilgari rolni o'zgartirishning umuman yo'li yo'q edi (UpdateUserDto'da
   * `role` yo'q) — ro'yxatchini menejerga ko'tarish uchun akkauntni o'chirib
   * qayta yaratish kerak bo'lardi va tarixi yangi id'ga bog'lanmasdi.
   *
   * Xavfsiz doira (yozishdan OLDIN hammasi tekshiriladi):
   *   - faqat SUPERADMIN (gateway @Roles ham; bu yerda ham — ichki
   *     chaqiruvlar uchun) → aks holda 403;
   *   - manba ham, nishon ham `CHANGEABLE_ROLES` (admin, ro'yxatchi, menejer,
   *     logist) — pul/hisob bog'langan rollar (kuryer, market, operator ...)
   *     va superadmin almashtirilmaydi → 400;
   *   - FILIAL BIRIKTIRUVI: filialga biriktirilgan foydalanuvchi (branch_users
   *     roli eski rolga mos — MANAGER/REGISTRATOR) → 409: avval filialdan
   *     chiqariladi, rol o'zgargach yangi rol bilan qayta biriktiriladi
   *     (assignUserToBranch o'zining HQ/menejer qoidalari bilan). Biriktiruvni
   *     tekshirib bo'lmasa → 503 (fail-closed);
   *   - LOGIST'dan chiqishda viloyatlari bo'shatiladi (o'chirishdagi kabi;
   *     bo'lmasa 503, rol o'zgarmaydi).
   * Rolga bog'liq maydonlar qayta hisoblanadi: `can_sell_cancel`,
   * `can_add_extra_cost`, `tariff_home`/`tariff_center` faqat menejerda
   * ma'noli — boshqa rolga o'tganda tozalanadi. Komissiya (operator) va
   * maosh tegilmaydi. Barcha sessiyalar yopiladi (`invalidateAllSessions`):
   * JWT eski rolni olib yurgani uchun foydalanuvchi qayta kiradi (access
   * token ≤ ACCESS_TOKEN_TIME).
   * Jurnal: old_value.role / new_value.role (+ tozalangan maydonlar).
   */
  async changeUserRole(
    id: string,
    role: unknown,
    requester?: RequesterContext,
  ) {
    if (!this.hasRole(requester, Roles.SUPERADMIN)) {
      this.forbidden("Rolni faqat superadmin o'zgartira oladi");
    }
    const userId = String(id ?? '').trim();
    if (!/^\d+$/.test(userId)) {
      this.notFound('User topilmadi');
    }
    const target = roleCatalogEntry(role);
    const changeableList = CHANGEABLE_ROLES.join(', ');
    if (!target || !target.changeable) {
      this.badRequest(
        `Yangi rol quyidagilardan biri bo'lishi kerak: ${changeableList}`,
      );
    }
    const user = await this.users.findOne({
      where: { id: userId, isDeleted: false },
    });
    if (!user) {
      this.notFound('User topilmadi');
    }
    if (this.isSelfRequester(requester, userId)) {
      this.badRequest("O'z rolingizni o'zgartira olmaysiz");
    }
    const source = roleCatalogEntry(user.role);
    if (!source || !source.changeable) {
      this.badRequest(
        `${source?.label ?? user.role} rolini o'zgartirib bo'lmaydi — unga kassa, buyurtma yoki boshqa yozuvlar bog'langan. O'zgartirish mumkin bo'lgan rollar: ${changeableList}`,
      );
    }
    if (user.role === target.role) {
      this.badRequest('Foydalanuvchi allaqachon shu rolda');
    }

    await this.assertNoBranchAssignmentForRoleChange(userId);

    if (user.role === Roles.LOGIST) {
      await this.releaseLogistRegionsOrFail(
        userId,
        requester,
        "Logistni viloyatlardan ajratib bo'lmadi — rol o'zgartirilmadi. Birozdan so'ng qayta urinib ko'ring.",
      );
    }

    const before = {
      role: user.role,
      can_sell_cancel: user.can_sell_cancel,
      can_add_extra_cost: user.can_add_extra_cost,
      tariff_home: user.tariff_home,
      tariff_center: user.tariff_center,
    };
    const previousRole = user.role;
    user.role = target.role;
    if (target.role !== Roles.MANAGER) {
      user.can_sell_cancel = false;
      user.can_add_extra_cost = false;
      user.tariff_home = null;
      user.tariff_center = null;
    }
    invalidateAllSessions(user);

    const saved = await this.users.save(user);
    // (NDmZMzCP) Rol almashdi — eski rol tokenlari DARHOL to'xtaydi.
    await this.revokeSessionsAfterSecurityChange(saved);
    // Qidiruv indeksi rol bo'yicha kalitlangan: eski rol yozuvi olib
    // tashlanadi, yangisi yoziladi (ikkalasi ham best-effort).
    void this.removeUserFromSearch({ ...saved, role: previousRole } as User);
    void this.syncUserToSearch(saved);

    await this.activityLog.log({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.UPDATED,
      old_value: before,
      new_value: {
        role: saved.role,
        can_sell_cancel: saved.can_sell_cancel,
        can_add_extra_cost: saved.can_add_extra_cost,
        tariff_home: saved.tariff_home,
        tariff_center: saved.tariff_center,
      },
      metadata: { change: 'role', sessions_revoked: true },
      ...this.auditActor(requester),
    });

    return successRes(
      this.sanitize(saved),
      200,
      "Foydalanuvchi roli o'zgartirildi",
    );
  }

  /**
   * K3scaE0W — rol almashtirishdan oldin: foydalanuvchi hech qaysi filialga
   * biriktirilmagan bo'lishi shart (branch_users roli eski rolga bog'langan).
   * Biriktirilgan — 409 (qaysi filial ekanini aytadi); tekshirib bo'lmasa —
   * 503 (fail-closed: rol o'zgarmaydi).
   */
  private async assertNoBranchAssignmentForRoleChange(
    userId: string,
  ): Promise<void> {
    let assignment: {
      branch_id?: string | number | null;
      branch?: { name?: string | null } | null;
    } | null;
    try {
      const response = await rmqSend<{
        data?: {
          branch_id?: string | number | null;
          branch?: { name?: string | null } | null;
        } | null;
      }>(
        this.branchClient,
        { cmd: 'branch.user.find_by_user' },
        {
          user_id: userId,
          requester: { id: userId, roles: [Roles.SUPERADMIN] },
        },
        { attachRequestId: false, retries: 1, timeoutMs: 3000 },
      );
      assignment = response?.data ?? null;
    } catch (error) {
      this.logger.warn(
        `changeUserRole: branch.user.find_by_user failed for user ${userId} (${describeSagaError(error)}) — role NOT changed`,
      );
      throw new RpcException(
        errorRes(
          "Foydalanuvchining filial biriktiruvini tekshirib bo'lmadi — rol o'zgartirilmadi. Birozdan so'ng qayta urinib ko'ring.",
          503,
        ),
      );
    }
    const branchId = String(assignment?.branch_id ?? '').trim();
    if (branchId) {
      const name = String(assignment?.branch?.name ?? '').trim();
      this.conflict(
        `Foydalanuvchi ${name ? `'${name}' filialiga` : `#${branchId} filialga`} biriktirilgan — avval filialdan chiqaring (DELETE /branches/${branchId}/users/${userId}), rol o'zgargach yangi rol bilan qayta biriktiring`,
      );
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

    // (dzyVftBx, TC4) Logistning viloyatlari soft-delete'dan OLDIN bo'shatiladi
    // (regions.logist_id = NULL; viloyatlarning o'zi o'chmaydi). Bo'shatib
    // bo'lmasa — 503, logist o'chirilmaydi.
    if (admin.role === Roles.LOGIST) {
      await this.releaseLogistRegionsOrFail(String(admin.id), requester);
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
    // (Elchi Pochta #3) O'chirilgan akkauntning sessiyalari ham yopiladi.
    invalidateAllSessions(admin);

    const saved = await this.users.save(admin);
    await this.revokeSessionsAfterSecurityChange(saved);
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

  async findUserById(
    id: string,
    options: { includeDeleted?: boolean; includeBranch?: boolean } = {},
  ) {
    // (i76gGjyq) `includeDeleted` — faqat ichki RPC (finance operator
    // komissiyasi): o'chirilgan operatorning ilgari olingan buyurtmasi keyin
    // sotilsa, 404 outbox'ni cheksiz qayta urardi. Gateway buni HECH QACHON
    // yubormaydi (GET /users/:id faqat `{ id }`).
    const user = await this.users.findOne({
      where: options.includeDeleted ? { id } : { id, isDeleted: false },
    });
    if (!user) {
      this.notFound('User topilmadi');
    }

    // (GvL6ZFAd) market_tg_token HECH QACHON qaytmaydi — hech bir rol yoki
    // flag uchun. Ko'rish: GET /markets/:id/tg-token (faqat SUPERADMIN).
    const safeUser = this.sanitize(user);
    if (!options.includeBranch) {
      const profileRegion = await this.getRegionById(safeUser.region_id);
      return successRes({
        ...safeUser,
        region: profileRegion,
      });
    }

    /**
     * YEThmZBn — GET /users/:id (gateway `include_branch`) kuryer / menejer /
     * registrator filialini ham qaytaradi: `branch: { id, name } | null`.
     * Ilgari faqat `region` bor edi — kuryer tafsilotida «Kuryer · … filiali»
     * va «Profil ma'lumotlari → Filial» chizib bo'lmasdi. Ichki
     * `identity.user.find_by_id` chaqiruvlari (finance, order, branch…) bu
     * flagni yubormaydi — ular uchun javob va filial so'rovi o'zgarmagan.
     */
    const branchLookup: Promise<unknown> = this.shouldAttachBranchRelation(
      safeUser.role,
    )
      ? this.getUserBranchAssignment(String(safeUser.id), safeUser.role)
      : Promise.resolve(null);
    // x6IO746K — market operatori: market `{ id, name }` (ro'yxat qatori bilan
    // bir xil). Faqat gateway (`include_branch`) yo'li — ichki chaqiruvlar
    // uchun so'rov ham, shakl ham o'zgarmagan.
    const isMarketOperator = user.role === Roles.MARKET_OPERATOR;
    const [profileRegion, branchAssignment, marketById] = await Promise.all([
      this.getRegionById(safeUser.region_id),
      branchLookup,
      isMarketOperator
        ? this.findMarketSummaries([user.market_id])
        : Promise.resolve(null),
    ]);
    const branch = this.toBranchSummary(branchAssignment);
    return successRes({
      ...safeUser,
      region: profileRegion,
      // kGIjOciz — `branch_id` ham (ro'yxat qatori bilan bir xil shakl):
      // `branch.id` yoki null.
      branch_id: branch?.id ?? null,
      branch,
      ...(marketById ? { market: this.marketSummaryOf(user, marketById) } : {}),
    });
  }

  /**
   * x6IO746K — market operatorlarining marketlari: BITTA `IN` so'rovi, faqat
   * tirik (o'chirilmagan) `market` rolidagi qatorlar va faqat ochiq maydonlar
   * (`id`, `name`, `add_order`) — `market_tg_token`, tariflar va boshqa
   * maxfiy maydonlar O'QILMAYDI ham (GvL6ZFAd).
   */
  private async findMarketSummaries(
    marketIds: Array<string | null | undefined>,
  ): Promise<Map<string, { id: string; name: string; add_order: boolean }>> {
    const ids = Array.from(
      new Set(
        marketIds
          .map((id) => primitiveText(id).trim())
          .filter((id) => /^\d{1,19}$/.test(id)),
      ),
    );
    if (!ids.length) {
      return new Map();
    }
    const markets = await this.users.find({
      where: { id: In(ids), role: Roles.MARKET, isDeleted: false },
      select: { id: true, name: true, add_order: true },
    });
    return new Map(
      markets.map((market) => [
        String(market.id),
        {
          id: String(market.id),
          name: market.name,
          add_order: Boolean(market.add_order),
        },
      ]),
    );
  }

  /**
   * x6IO746K — operator qatori uchun `{ id, name }`; market o'chirilgan /
   * topilmagan / biriktirilmagan — `null`.
   */
  private marketSummaryOf(
    operator: Pick<User, 'market_id'>,
    marketById: Map<string, { id: string; name: string }>,
  ): { id: string; name: string } | null {
    const market = marketById.get(primitiveText(operator.market_id).trim());
    return market ? { id: market.id, name: market.name } : null;
  }

  /**
   * YEThmZBn — `branch.user.find_by_user` javobidan (`{ ...branch_users,
   * branch }`) faqat `{ id, name }`. Biriktirish yo'q yoki filial o'chirilgan
   * (`branch: null`) — `null`.
   */
  private toBranchSummary(
    assignment: unknown,
  ): { id: string; name: string | null } | null {
    if (!assignment || typeof assignment !== 'object') {
      return null;
    }
    const branch = (assignment as { branch?: unknown }).branch;
    if (!branch || typeof branch !== 'object') {
      return null;
    }
    const { id, name } = branch as { id?: unknown; name?: unknown };
    const branchId = primitiveText(id).trim();
    if (!branchId) {
      return null;
    }
    const branchName = primitiveText(name).trim();
    return { id: branchId, name: branchName || null };
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

    // x6IO746K (N13) — market operatori o'z kabinetida marketini ko'radi:
    // `market: { id, name, add_order } | null` (o'chirilgan / topilmagan —
    // null). Boshqa rollarda kalit yo'q (avvalgi shakl).
    let operatorMarket = {};
    if (user.role === Roles.MARKET_OPERATOR) {
      const marketById = await this.findMarketSummaries([user.market_id]);
      operatorMarket = {
        market: marketById.get(primitiveText(user.market_id).trim()) ?? null,
        // XtcEyQjb — «Ombordagi qoldiq» menyusi shu kalit bilan ochiladi.
        can_view_warehouse_stock: user.can_view_warehouse_stock === true,
      };
    }

    return successRes({
      ...safeUser,
      region: profileRegion,
      branch: profileBranch,
      ...operatorMarket,
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
    const {
      search,
      role,
      status,
      region_id,
      user_ids,
      branch_scope_user_ids,
      telegram_linked,
      page,
      limit,
      skip,
    } = this.normalizeQuery(query);

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
          // zfPNDCCr: telefon formatidan qat'i nazar.
          this.orWherePhoneDigits(nested, 'admin', parseUzPhoneSearch(search));
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

    // yA31z7Rr — «Ulangan / Ulanmagan»: javobdagi `telegram_linked`
    // (`Boolean(telegram_id)`) bilan aynan bir xil — bo'sh satr ham «ulanmagan».
    // `baseQb` da: total ham, countsByRole ham filtrdan keyin.
    if (telegram_linked !== undefined) {
      baseQb.andWhere(
        telegram_linked
          ? "COALESCE(admin.telegram_id, '') <> ''"
          : "COALESCE(admin.telegram_id, '') = ''",
      );
    }

    /**
     * 2CBnPAeg — menejer ko'lami SO'ROVDA (ilgari gateway sahifadan keyin
     * filtrlardi: `meta.total` sahifadagi qatorlar soni, `countsByRole`
     * ko'lamsiz). Kuryer / filial roli — faqat menejer filialiga
     * biriktirilganlar; qolgan rollar cheklanmaydi. `baseQb` ga qo'shiladi —
     * ro'yxat, `total` va `countsByRole` bir xil doirada.
     */
    if (branch_scope_user_ids) {
      baseQb.andWhere(
        new Brackets((scoped) => {
          scoped.where('admin.role NOT IN (:...branchScopedRoles)', {
            branchScopedRoles: [Roles.COURIER, Roles.BRANCH],
          });
          if (branch_scope_user_ids.length) {
            scoped.orWhere('admin.id IN (:...branchScopeUserIds)', {
              branchScopeUserIds: branch_scope_user_ids,
            });
          }
        }),
      );
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

    // nFmup26a: "Xodimlar" avval faqat ADMIN + REGISTRATOR + COURIER ni
    // sanardi — MANAGER, OPERATOR, MARKET_OPERATOR, BRANCH, INVESTOR, LOGIST
    // hech bir kartaga tushmasdi va Marketlar + Xodimlar ≠ Barcha. Endi bitta
    // GROUP BY so'rovidan: xodim = market bo'lmagan har qanday rol (BeePost:
    // role != market). Invariant: totalMarket + totalEmployees === totalUsers.
    // `countsByRole` — Roles enum'ining HAR BIR qiymati (yo'q rol — 0; bu
    // ro'yxat superadmin/customer'ni sanamaydi, ular doim 0), shuning uchun
    // yangi rol qo'shilganda hisob jimgina buzilmaydi.
    const roleRows = await baseQb
      .clone()
      .select('admin.role', 'role')
      .addSelect('COUNT(*)', 'count')
      .groupBy('admin.role')
      .getRawMany<{ role: string | null; count: string | number }>();
    const countsByRole = Object.fromEntries(
      Object.values(Roles).map((value) => [value, 0]),
    ) as Record<string, number>;
    let totalUsers = 0;
    for (const row of roleRows) {
      const count = Number(row?.count ?? 0) || 0;
      const roleKey = String(row?.role ?? '');
      countsByRole[roleKey] = (countsByRole[roleKey] ?? 0) + count;
      totalUsers += count;
    }
    const totalMarket = countsByRole[Roles.MARKET] ?? 0;
    const totalEmployees = totalUsers - totalMarket;

    // x6IO746K — market operatori qatorlariga market `{ id, name }` (sahifa
    // bo'yicha BITTA IN so'rovi, N+1 yo'q).
    const marketById = await this.findMarketSummaries(
      rows
        .filter((row) => row.role === Roles.MARKET_OPERATOR)
        .map((row) => row.market_id),
    );

    return successRes({
      items: rows.map((row) => {
        const safe = this.sanitize(row);
        return row.role === Roles.MARKET_OPERATOR
          ? { ...safe, market: this.marketSummaryOf(row, marketById) }
          : safe;
      }),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        totalMarket,
        totalEmployees,
        totalUsers,
        countsByRole,
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
          // zfPNDCCr: telefon formatidan qat'i nazar.
          this.orWherePhoneDigits(
            nested,
            'courier',
            parseUzPhoneSearch(search),
          );
        }),
      );
    }

    if (status) {
      qb.andWhere('courier.status = :status', { status });
    }

    if (region_id) {
      // hEjjuJaT: super-kuryer o'z viloyatidan tashqari courier_regions'dagi
      // har bir viloyatda (serves_all_regions — HAMMA viloyatda) chiqadi.
      qb.andWhere(
        new Brackets((nested) => {
          nested.where('courier.region_id = :region_id', { region_id }).orWhere(
            `(courier.is_super_courier = true AND (courier.serves_all_regions = true OR EXISTS (
                SELECT 1 FROM identity_schema.courier_regions cr
                WHERE cr.courier_id = courier.id AND cr.region_id = :region_id
              )))`,
            { region_id },
          );
        }),
      );
    }

    // Gateway filial kuryerlarini (branch_users) oldindan beradi — filtr
    // SAHIFALASHDAN OLDIN qo'llanadi, shuning uchun meta.total ham to'g'ri.
    if (user_ids.length) {
      qb.andWhere('courier.id IN (:...user_ids)', { user_ids });
    }

    // Z3pUOxou — logist doirasi: kuryerning O'Z viloyati to'plamda (qat'iy).
    if (Array.isArray(query?.region_ids)) {
      const scopedRegionIds = Array.from(
        new Set(
          query.region_ids
            .map((id) => String(id ?? '').trim())
            .filter((id) => /^[0-9]{1,19}$/.test(id)),
        ),
      );
      if (scopedRegionIds.length) {
        qb.andWhere('courier.region_id IN (:...scoped_region_ids)', {
          scoped_region_ids: scopedRegionIds,
        });
      } else {
        qb.andWhere('1 = 0');
      }
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
    // w2bDrE3i: qo'shimcha xarajat sozlamasi — faqat admin/superadmin.
    this.assertCanSetMarketExtraCost(dto, requester);
    // VRyloH62: doimiy operator raqami kanonik `+998XXXXXXXXX` (yoki null).
    const defaultOperatorPhone = this.resolveDefaultOperatorPhone(
      dto.default_operator_phone,
    );

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
      created_by: this.createdByOf(requester),
      tariff_home: dto.tariff_home,
      tariff_center: dto.tariff_center,
      add_order: dto.add_order ?? false,
      cancelled_handover_qr_required:
        dto.cancelled_handover_qr_required ?? true,
      expense_proof_conditions: dto.expense_proof_conditions ?? null,
      // w2bDrE3i: YANGI market — sukut yopiq, tasdiq talab qilinadi.
      extra_cost_enabled: dto.extra_cost_enabled ?? false,
      extra_cost_requires_approval: dto.extra_cost_requires_approval ?? true,
      // VRyloH62: operator raqami sozlamasi (sukut — majburiy emas).
      require_operator_phone: dto.require_operator_phone ?? false,
      default_operator_phone: defaultOperatorPhone ?? null,
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
    // DtKKY0V8 — tuman (ixtiyoriy): PATCH /users/:id dagi qoida — mavjud va
    // kuryer viloyatiga tegishli (viloyatsiz HQ kuryeri — faqat mavjudligi);
    // aks holda 400, logistika javob bermasa 503. Hammasi user yozilishidan
    // OLDIN — xatoda kompensatsiya kerak emas.
    const districtId =
      dto.district_id === undefined ||
      dto.district_id === null ||
      dto.district_id === ''
        ? null
        : await this.resolveUserDistrictId(dto.district_id, dto.region_id);
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
      district_id: districtId,
      role: Roles.COURIER,
      status: Status.ACTIVE,
      // fix #3: created_by — manager egaligi uchun.
      created_by: this.createdByOf(requester),
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
      created_by: this.createdByOf(requester),
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

  async createCustomer(
    dto: CreateCustomerDto,
    opts: { updateExisting?: boolean } = {},
  ) {
    /**
     * TELEFON NORMALLASHTIRILADI (zfPNDCCr).
     *
     * Bu RPC — Elchi'da mijoz yaratiladigan YAGONA joy (POST /orders,
     * /orders/external, telegram bot, ai-confirm, hamkor, tashqi sayt
     * importi). Ilgari mijoz XOM satr bo'yicha qidirilib, XOM satr bilan
     * yozilardi: bitta odam formatiga qarab ("998901234567", "901234567",
     * "+998 90 123 45 67") bir nechta mijozga bo'linardi, "not-a-phone" ham
     * o'tardi. RMQ payloadi `CreateCustomerDto` bo'yicha validatsiya
     * qilinMAYDI (`{ dto }` ichida), shuning uchun tekshiruv shu yerda.
     */
    const rawPhone = primitiveText(dto?.phone_number).trim();
    const phone = normalizeUzPhone(dto?.phone_number);
    if (!phone) {
      this.badRequest(
        "Telefon raqam noto'g'ri — +998XXXXXXXXX formatidagi raqam kerak",
      );
    }

    // 1) Kanonik raqam — avvalgi xulq: boshqa roldagi egasi bo'lsa 409.
    // 2) Topilmasa — eski (normallashtirilmagan) MIJOZ yozuvi; faqat mijoz
    //    roli: xodimning eski yozuvi mijoz sifatida qaytib ketmasin.
    const existing =
      (await this.users.findOne({
        where: { phone_number: phone, isDeleted: false },
      })) ??
      (await this.users.findOne({
        where: {
          phone_number: In(legacyCustomerPhoneForms(phone, rawPhone)),
          role: Roles.CUSTOMER,
          isDeleted: false,
        },
        order: { id: 'ASC' },
      }));

    if (existing) {
      if (existing.role !== Roles.CUSTOMER) {
        this.conflict('Bu telefon raqam boshqa rolda allaqachon mavjud');
      }

      // txmkXVBa: POST /orders va ai-confirm — karta jimgina yozilmaydi
      // (ega qarori S5); yangilash faqat `identity.customer.update` orqali.
      if (opts.updateExisting === false) {
        return successRes(
          this.sanitize(existing),
          200,
          'Customer allaqachon mavjud',
        );
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
      // (C4R3YyvH) Til faqat aniq va ruxsat etilgan qiymat bo'lsa.
      const language = customerLanguage(dto?.language);
      if (language && language !== existing.language) {
        patch.language = language;
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
      // zfPNDCCr: doim kanonik +998XXXXXXXXX.
      phone_number: phone,
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
      // (C4R3YyvH) Buyurtma manbasidan kelgan til yoki sukut 'uz'.
      language: customerLanguage(dto?.language) ?? 'uz',
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

  /**
   * «KARTANI HAM YANGILASH» (txmkXVBa, ega qarori 2026-10-19 S5).
   *
   * Buyurtma formasida mavjud mijoz maydonlari o'zgartirilib «Kartani ham
   * yangilash» tanlansa gateway buyurtma yaratilgandan KEYIN chaqiradi
   * (ruxsat — gateway'da). Faqat berilgan (non-null) va FARQ QILADIGAN
   * maydonlar yoziladi — bo'sh qiymat eski ism/tuman/manzilni o'chirmaydi
   * (j70YS4zJ bilan bir xil qoida). Activity log: kim (kontekst aktyori),
   * qaysi buyurtma orqali, maydon eski → yangi.
   *
   * Qaytaradi: `{ id, changed_fields }` (o'zgarish bo'lmasa bo'sh ro'yxat).
   */
  async updateCustomerCard(
    id: string,
    dto: UpdateCustomerCardPayload['dto'],
    meta: { orderId?: string | null; marketId?: string | null } = {},
  ) {
    const customerId = primitiveText(id).trim();
    if (!/^\d+$/.test(customerId)) {
      this.badRequest("Mijoz ID noto'g'ri");
    }
    const existing = await this.users.findOne({
      where: { id: customerId, role: Roles.CUSTOMER, isDeleted: false },
    });
    if (!existing) {
      this.notFound('Customer topilmadi');
    }

    const fields = ['name', 'district_id', 'address', 'extra_number'] as const;
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const patch: Partial<User> = {};
    for (const field of fields) {
      const raw = dto?.[field];
      if (raw === null || raw === undefined) continue;
      const value = primitiveText(raw).trim();
      if (!value || value === primitiveText(existing[field]).trim()) continue;
      before[field] = existing[field] ?? null;
      after[field] = value;
      (patch as Record<string, unknown>)[field] = value;
    }
    const changed = Object.keys(patch);
    if (!changed.length) {
      return successRes(
        { id: existing.id, changed_fields: [] as string[] },
        200,
        "Mijoz kartasi o'zgarmadi",
      );
    }

    Object.assign(existing, patch);
    const updated = await this.users.save(existing);
    void this.syncUserToSearch(updated);
    await this.activityLog.log({
      entity_type: 'User',
      entity_id: updated.id,
      action: ActivityAction.UPDATED,
      old_value: before,
      new_value: after,
      metadata: {
        source: 'order_create',
        order_id: meta.orderId ?? null,
        market_id: meta.marketId ?? null,
      },
    });
    return successRes(
      { id: updated.id, changed_fields: changed },
      200,
      'Mijoz kartasi yangilandi',
    );
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
      extra_cost_enabled: market.extra_cost_enabled,
      extra_cost_requires_approval: market.extra_cost_requires_approval,
      require_operator_phone: market.require_operator_phone,
      default_operator_phone: market.default_operator_phone,
      tg_group_show_customer_pii: market.tg_group_show_customer_pii,
      can_order_from_warehouse: market.can_order_from_warehouse ?? false,
      password_changed: false,
    };

    // w2bDrE3i: tekshiruvlar HECH NARSA o'zgartirilmasdan OLDIN.
    this.assertCanSetMarketExtraCost(dto, requester);
    this.assertCanSetMarketWarehouseOrder(dto, requester);
    const defaultOperatorPhone = this.resolveDefaultOperatorPhone(
      dto.default_operator_phone,
    );
    const marketEpochBefore = Number(market.session_epoch) || 0;

    if (dto.phone_number && dto.phone_number !== market.phone_number) {
      await this.ensurePhoneUnique(dto.phone_number, id);
      market.phone_number = dto.phone_number;
      // RBAC-09: login (telefon) o'zgardi — eski sessiyalar yopiladi.
      invalidateAllSessions(market);
    }

    if (dto.password) {
      market.password = await this.bcryptEncryption.encrypt(dto.password);
      // RBAC-09: yangi parol — eski qurilmalar endi refresh qila olmaydi.
      // (Elchi Pochta #3, 2026-10-23) Bu RPC'da joriy sessiya (`sid`) yo'q —
      // HAMMASI; saqlangandan keyin ular `password_changed` bilan aniq
      // yopiladi (gateway `session_state` ham darhol `active: false`).
      invalidateAllSessions(market);
    }

    if (typeof dto.name !== 'undefined') {
      market.name = dto.name;
    }

    if (typeof dto.address !== 'undefined') {
      market.address = dto.address;
    }

    if (typeof dto.status !== 'undefined') {
      market.status = dto.status;
      // (Elchi Pochta #3) Bloklangan market — barcha sessiyalar yopiladi.
      if (dto.status !== Status.ACTIVE) {
        invalidateAllSessions(market);
      }
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

    if (typeof dto.extra_cost_enabled !== 'undefined') {
      market.extra_cost_enabled = dto.extra_cost_enabled;
    }

    if (typeof dto.extra_cost_requires_approval !== 'undefined') {
      market.extra_cost_requires_approval = dto.extra_cost_requires_approval;
    }

    if (typeof dto.require_operator_phone !== 'undefined') {
      market.require_operator_phone = dto.require_operator_phone;
    }

    // (ysBqD9Nx) RMQ'da ValidationPipe yo'q — faqat boolean.
    if (typeof dto.tg_group_show_customer_pii !== 'undefined') {
      if (typeof dto.tg_group_show_customer_pii !== 'boolean') {
        this.badRequest(
          "tg_group_show_customer_pii boolean (true/false) bo'lishi kerak",
        );
      }
      market.tg_group_show_customer_pii = dto.tg_group_show_customer_pii;
    }

    if (defaultOperatorPhone !== undefined) {
      market.default_operator_phone = defaultOperatorPhone;
    }

    if (typeof dto.can_order_from_warehouse !== 'undefined') {
      market.can_order_from_warehouse = dto.can_order_from_warehouse;
    }

    const saved = await this.users.save(market);
    const revokedSessionIds = dto.password
      ? await this.revokeSessionsAfterPasswordChange(saved, {
          keepSessionId: null,
          isSelf: this.isSelfRequester(requester, id),
          requester,
        })
      : null;
    // (NDmZMzCP) Bloklash / telefon almashishi — sessiyalar DARHOL yopiladi.
    await this.revokeSessionsAfterSecurityChange(saved, marketEpochBefore);
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
        extra_cost_enabled: saved.extra_cost_enabled,
        extra_cost_requires_approval: saved.extra_cost_requires_approval,
        require_operator_phone: saved.require_operator_phone,
        default_operator_phone: saved.default_operator_phone,
        tg_group_show_customer_pii: saved.tg_group_show_customer_pii,
        can_order_from_warehouse: saved.can_order_from_warehouse ?? false,
        password_changed: Boolean(dto.password),
      },
    });
    return {
      ...successRes(this.sanitize(saved), 200, 'Market yangilandi'),
      ...this.passwordChangeReply(revokedSessionIds),
    };
  }

  /**
   * hY7uacJu — «Ombordan buyurtma yaratish» (`can_order_from_warehouse`) ni
   * faqat SUPERADMIN/ADMIN o'zgartiradi (market o'zi yoki menejer — 403);
   * qiymat boolean bo'lmasa — 400 (RMQ'da ValidationPipe yo'q).
   */
  private assertCanSetMarketWarehouseOrder(
    dto: { can_order_from_warehouse?: unknown },
    requester?: RequesterContext,
  ): void {
    if (dto.can_order_from_warehouse === undefined) {
      return;
    }
    if (
      !this.hasRole(requester, Roles.SUPERADMIN) &&
      !this.hasRole(requester, Roles.ADMIN)
    ) {
      this.forbidden(
        "«Ombordan buyurtma yaratish» ruxsatini faqat admin yoki superadmin o'zgartira oladi",
      );
    }
    if (typeof dto.can_order_from_warehouse !== 'boolean') {
      this.badRequest(
        "can_order_from_warehouse boolean (true/false) bo'lishi kerak",
      );
    }
  }

  /**
   * w2bDrE3i — market bo'yicha qo'shimcha xarajat sozlamasini (ochish/yopish,
   * tasdiq talabi) faqat SUPERADMIN/ADMIN o'zgartiradi. `can_add_extra_cost`
   * (kuryer/menejer) bilan bir xil qoida; market o'zi yoki menejer — 403.
   * Qiymat boolean bo'lmasa — 400 (RMQ'da ValidationPipe yo'q).
   */
  private assertCanSetMarketExtraCost(
    dto: {
      extra_cost_enabled?: unknown;
      extra_cost_requires_approval?: unknown;
    },
    requester?: RequesterContext,
  ): void {
    const fields = [
      'extra_cost_enabled',
      'extra_cost_requires_approval',
    ] as const;
    const touched = fields.filter((field) => dto[field] !== undefined);
    if (touched.length === 0) {
      return;
    }
    if (
      !this.hasRole(requester, Roles.SUPERADMIN) &&
      !this.hasRole(requester, Roles.ADMIN)
    ) {
      this.forbidden(
        "Market qo'shimcha xarajat sozlamasini faqat admin yoki superadmin o'zgartira oladi",
      );
    }
    for (const field of touched) {
      if (typeof dto[field] !== 'boolean') {
        this.badRequest(`${field} boolean (true/false) bo'lishi kerak`);
      }
    }
  }

  /**
   * VRyloH62 — `default_operator_phone`: `undefined` — o'zgarmaydi;
   * `null`/bo'sh satr — o'chiriladi (`null`); aks holda kanonik
   * `+998XXXXXXXXX` (mijoz telefoni bilan AYNI `normalizeUzPhone`),
   * keltirib bo'lmasa — 400.
   */
  private resolveDefaultOperatorPhone(
    value: unknown,
  ): string | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null || (typeof value === 'string' && !value.trim())) {
      return null;
    }
    const phone = normalizeUzPhone(value);
    if (!phone) {
      this.badRequest(
        "default_operator_phone noto'g'ri — +998XXXXXXXXX formatidagi raqam kerak",
      );
    }
    return phone;
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
    // (Elchi Pochta #3) O'chirilgan marketning sessiyalari ham yopiladi.
    invalidateAllSessions(market);

    const saved = await this.users.save(market);
    await this.revokeSessionsAfterSecurityChange(saved);
    void this.removeUserFromSearch(saved);

    await this.activityLog.log({
      entity_type: 'User',
      entity_id: id,
      action: ActivityAction.DELETED,
      old_value: { name: market.name, role: Roles.MARKET },
    });

    return successRes({ id }, 200, 'Market o‘chirildi');
  }

  /**
   * oNAE3LW9 — hududni o'chirishdan OLDIN: shu tuman/viloyatga bog'langan
   * foydalanuvchilar (mijozlar, kuryerlar, marketlar) soni.
   *
   * oNAE3LW9 (prod 2-tur): `users` / `by_role` — faqat O'CHIRILMAGAN
   * (`is_deleted = false`) foydalanuvchilar; himoya faqat shularga qaraydi.
   * Ilgari o'chirilganlar ham sanalardi — ro'yxatlarda ko'rinmaydigan
   * (o'chirilgan) kuryer/market tumanni o'chirishga to'sqinlik qilardi.
   * O'chirilganlar alohida `deleted_users` da: logistics birlashtirishda
   * ularni ham ko'chiradi (`reassignDistrict` filtrsiz) va tasdiqlashda
   * hisobga oladi.
   */
  async countGeoUsage(input: { district_id?: string; region_id?: string }) {
    const districtId = String(input?.district_id ?? '').trim();
    const regionId = String(input?.region_id ?? '').trim();
    if (!districtId && !regionId) {
      throw new RpcException(
        errorRes('district_id yoki region_id majburiy', 400),
      );
    }
    const rows = await this.users
      .createQueryBuilder('u')
      .select('u.role', 'role')
      .addSelect('COUNT(*) FILTER (WHERE u.is_deleted = false)', 'count')
      .addSelect('COUNT(*) FILTER (WHERE u.is_deleted = true)', 'deleted')
      .where(
        districtId ? 'u.district_id = :districtId' : 'u.region_id = :regionId',
        districtId ? { districtId } : { regionId },
      )
      .groupBy('u.role')
      .getRawMany<{
        role: string;
        count: string | null;
        deleted?: string | null;
      }>();
    // Faqat tirik foydalanuvchisi bor rollar (o'chirilganlari faqat `deleted_users` da).
    const by_role = Object.fromEntries(
      rows
        .map((r) => [String(r.role), Number(r.count ?? 0)] as const)
        .filter(([, count]) => count > 0),
    );
    const users = rows.reduce((sum, r) => sum + Number(r.count ?? 0), 0);
    const deletedUsers = rows.reduce(
      (sum, r) => sum + Number(r.deleted ?? 0),
      0,
    );
    return successRes(
      {
        district_id: districtId || null,
        region_id: regionId || null,
        users,
        deleted_users: deletedUsers,
        by_role,
      },
      200,
      'Geo usage',
    );
  }

  /**
   * oNAE3LW9 — tumanlarni birlashtirish (logistics `mergeDistricts`):
   * foydalanuvchilar (mijoz/kuryer/market) A → B tumaniga (va B ning viloyatiga).
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
      rows = await this.users.manager.transaction(async (manager) => {
        if (req.ids && !req.ids.length) return [];
        const select = manager
          .getRepository(User)
          .createQueryBuilder('t')
          .select('t.id', 'id')
          .addSelect('t.region_id', 'region_id')
          // (vsmpTweI) tirikmi — `moved_live` uchun.
          .addSelect('(t.is_deleted = false)', 'live')
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
          .update(User)
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
            .update(User)
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
    return successRes(geoReassignResult(req, rows), 200, 'Users reassigned');
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
   * (GvL6ZFAd) Token RPC'lari faqat SUPERADMIN uchun. Gateway RolesGuard'i
   * asosiy darvoza; bu — ikkinchi qatlam: kelajakda boshqa rolga ochiq route
   * shu RPC'ga ulansa ham token chiqmaydi. requester'siz chaqiruv ham 403.
   * Rol tekshiruvi 404 dan OLDIN — boshqa rol market id mavjudligini ham
   * bilmaydi.
   */
  private assertMarketTgTokenSuperadmin(requester?: RequesterContext): void {
    const roles = (requester?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId || !roles.includes(Roles.SUPERADMIN)) {
      this.forbidden(MARKET_TG_TOKEN_FORBIDDEN);
    }
  }

  /** Faqat role = market, is_deleted = false; aks holda (yoki id raqam emas) — 404. */
  private async findActiveMarketForTgToken(id: unknown): Promise<User> {
    const marketId = primitiveText(id).trim();
    if (!/^\d+$/.test(marketId)) {
      this.notFound(MARKET_TG_TOKEN_MARKET_NOT_FOUND);
    }
    const market = await this.users.findOne({
      where: { id: marketId, role: Roles.MARKET, isDeleted: false },
    });
    if (!market) {
      this.notFound(MARKET_TG_TOKEN_MARKET_NOT_FOUND);
    }
    return market;
  }

  /**
   * identity.market.get_tg_token (GvL6ZFAd) — GET /markets/:id/tg-token.
   * market_tg_token'ni QAYTARADIGAN ikki RPC'dan biri (ikkinchisi — bitta
   * marketni rotatsiya). Har ko'rish jurnalga yoziladi (kim, qaysi market),
   * token qiymati — yo'q.
   */
  async getMarketTelegramToken(id: string, requester?: RequesterContext) {
    this.assertMarketTgTokenSuperadmin(requester);
    const market = await this.findActiveMarketForTgToken(id);

    await this.activityLog.log({
      entity_type: 'User',
      entity_id: market.id,
      action: MARKET_TG_TOKEN_AUDIT_ACTION.VIEWED,
      ...this.auditActor(requester),
      // Faqat fakt — token QIYMATI hech qachon jurnalga tushmaydi.
      metadata: {
        market_id: market.id,
        has_token: Boolean(market.market_tg_token),
      },
    });

    return successRes(
      {
        id: market.id,
        market_tg_token: market.market_tg_token ?? null,
      },
      200,
      'Market Telegram tokeni',
    );
  }

  /**
   * identity.market.rotate_tg_token — POST /markets/:id/tg-token/rotate
   * (GvL6ZFAd: endi HTTP route BOR, lekin faqat SUPERADMIN; ilgari bu RPC
   * "faqat ichki, HTTP route ochilmasin" edi — route token ochiq turgan
   * umumiy javoblar bilan birga xavfli edi, endi token faqat shu maxsus
   * marshrutlarda). fix3b: notification-service uni CHAQIRMAYDI — guruh
   * ulangandan keyin token almashtirilmaydi.
   *
   * Nuqtali UPDATE (save() emas): faqat market_tg_token ustuni yoziladi.
   * Eski token darhol yaroqsiz: identity.market.find_by_tg_token uni endi
   * topmaydi (bot orqali YANGI bog'lanish/guruh ulash faqat yangi token bilan).
   */
  async rotateMarketTelegramToken(id: string, requester?: RequesterContext) {
    this.assertMarketTgTokenSuperadmin(requester);
    const market = await this.findActiveMarketForTgToken(id);

    const nextToken = this.generateGroupToken();
    let affected: number | undefined;
    try {
      const result = await this.users.update(
        { id: market.id, role: Roles.MARKET, isDeleted: false },
        { market_tg_token: nextToken },
      );
      affected = result?.affected;
    } catch (error) {
      this.logger.error(
        `rotateMarketTelegramToken(${market.id}) failed: ${(error as Error)?.message}`,
      );
      throw new RpcException(errorRes(MARKET_TG_TOKEN_ROTATE_FAILED, 503));
    }
    if (affected === 0) {
      // O'qish va yozish orasida o'chirildi.
      this.notFound(MARKET_TG_TOKEN_MARKET_NOT_FOUND);
    }

    await this.activityLog.log({
      entity_type: 'User',
      entity_id: market.id,
      action: MARKET_TG_TOKEN_AUDIT_ACTION.ROTATED,
      ...this.auditActor(requester),
      // Credential rotation: faqat fakt, token QIYMATI (eski ham, yangi ham) — yo'q.
      metadata: { market_id: market.id, rotated: true },
    });

    return successRes(
      {
        id: market.id,
        market_tg_token: nextToken,
      },
      200,
      'Market Telegram tokeni yangilandi',
    );
  }

  /**
   * identity.market.rotate_all_tg_tokens (GvL6ZFAd) — POST
   * /markets/tg-token/rotate-all. Kartadagi "chiqarilgandan keyin barcha
   * mavjud tokenlarni majburiy rotatsiya" mexanizmi: tokenlar CRM ochgan har
   * admin/menejer brauzerida ko'ringan. Ishga tushirish — egasining qarori
   * (deploy'dan keyin, qo'lda).
   *
   * - Faqat SUPERADMIN va aniq tasdiq `confirm === 'ROTATE_ALL'` (aks holda 400).
   * - Barcha role = market, is_deleted = false qatorlar (status'dan qat'i
   *   nazar: INACTIVE market tokeni ham find_by_tg_token'da ishlaydi) BITTA
   *   tranzaksiyada; xato bo'lsa hech biri o'zgarmaydi (503, navbatga qayta
   *   qo'yilmaydi).
   * - Javobda faqat SON — tokenlar emas. Bitta jurnal qatori.
   */
  async rotateAllMarketTelegramTokens(
    confirm: unknown,
    requester?: RequesterContext,
  ) {
    this.assertMarketTgTokenSuperadmin(requester);
    if (confirm !== MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM) {
      this.badRequest(MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM_REQUIRED);
    }

    let rotatedCount: number;
    try {
      rotatedCount = await this.users.manager.transaction(async (manager) => {
        const repo = manager.getRepository(User);
        const markets = await repo.find({
          where: { role: Roles.MARKET, isDeleted: false },
          select: { id: true },
          order: { id: 'ASC' },
        });
        for (const market of markets) {
          await repo.update(
            { id: market.id },
            { market_tg_token: this.generateGroupToken() },
          );
        }
        return markets.length;
      });
    } catch (error) {
      this.logger.error(
        `rotateAllMarketTelegramTokens failed (rolled back): ${(error as Error)?.message}`,
      );
      throw new RpcException(errorRes(MARKET_TG_TOKEN_ROTATE_FAILED, 503));
    }

    await this.activityLog.log({
      entity_type: 'User',
      entity_id: MARKET_TG_TOKEN_ROTATE_ALL_ENTITY_ID,
      action: MARKET_TG_TOKEN_AUDIT_ACTION.ROTATED_ALL,
      ...this.auditActor(requester),
      // Faqat son — market id'lari ham, tokenlar ham yozilmaydi.
      metadata: { rotated_count: rotatedCount },
    });

    return successRes(
      { rotated_count: rotatedCount },
      200,
      `${rotatedCount} ta market Telegram tokeni yangilandi`,
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
          // zfPNDCCr: telefon formatidan qat'i nazar.
          this.orWherePhoneDigits(nested, 'market', parseUzPhoneSearch(search));
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
    // (Elchi Pochta #3) Bloklash — barcha sessiyalar yopiladi (AYNI save).
    if (status !== Status.ACTIVE) {
      invalidateAllSessions(user);
    }
    const saved = await this.users.save(user);
    // (NDmZMzCP) Bloklandi — access token / socket DARHOL to'xtaydi.
    if (status !== Status.ACTIVE) {
      await this.revokeSessionsAfterSecurityChange(saved);
    }
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

  /**
   * (W8aerwL6) Bildirishnoma/kampaniya auditoriyasi — ICHKI RMQ
   * `identity.audience.resolve`. Rol filtrisiz (superadmin ham, mijoz ham —
   * mijoz faqat `include_customers` + segment/tasdiq bilan). `findAllAdmins`
   * ning rol filtriga TEGILMAYDI. Mantiq: `audience/audience-resolver.ts`.
   */
  async resolveAudience(input: AudienceResolveInput) {
    return resolveAudience(this.users, this.orderClient, input);
  }

  /**
   * (2WRzdWpZ topilma, audit-actor-name) Gateway faoliyat jurnali "Kim"
   * ustuni uchun ICHKI batch. `identity.user.find_all` (GET /users ro'yxati)
   * SUPERADMIN va mijozni ataylab chiqarib tashlaydi — shu sabab superadmin
   * amallari jurnalda ism o'rniga "1" bo'lib ko'rinardi. Bu yerda rol filtri
   * YO'Q, faqat o'chirilmagan foydalanuvchilar va faqat UI'ga kerakli qisqa
   * maydonlar (parol/token/manzil qaytmaydi).
   */
  async findUsersByIds(ids: unknown) {
    const clean = cleanBigintIds(ids);
    if (!clean.length) {
      return { success: true, data: [] };
    }

    const users = await this.users.find({
      where: { id: In(clean), isDeleted: false },
      select: {
        id: true,
        name: true,
        username: true,
        phone_number: true,
        role: true,
        status: true,
      },
    });

    return {
      success: true,
      data: users.map((u) => ({
        id: u.id,
        name: u.name ?? null,
        username: u.username ?? null,
        phone_number: u.phone_number ?? null,
        role: u.role ?? null,
        status: u.status ?? null,
      })),
    };
  }

  /**
   * (y8CxCtcK / fQi6NNUL) `identity.user.summary_by_ids` — faoliyat jurnali
   * "Kim" ustuni uchun ENG TOR ichki batch: faqat `{ id, name, role }`.
   *
   * - Rol filtri YO'Q: superadmin ham, mijoz ham hal qilinadi
   *   (`findAllAdmins` dagi filtrga TEGILMAGAN — GET /users o'zgarmaydi);
   * - O'chirilgan (`isDeleted`) foydalanuvchi ham qaytadi: ishdan ketgan
   *   kuryerning eski amallari jurnalda baribir ismli ko'rinishi kerak;
   * - Telefon, username, status, parol/token QAYTMAYDI (SELECT darajasida).
   */
  async findUserSummariesByIds(ids: unknown) {
    const clean = cleanBigintIds(ids);
    if (!clean.length) {
      return { success: true, data: [] };
    }

    const users = await this.users.find({
      where: { id: In(clean) },
      select: { id: true, name: true, role: true },
    });

    return {
      success: true,
      data: users.map((u) => ({
        id: u.id,
        name: u.name ?? null,
        role: u.role ?? null,
      })),
    };
  }

  /**
   * hEjjuJaT: `regionId` berilsa (order-service sotuv/qisman sotuv/bekor/
   * rollback — buyurtma viloyati) super-kuryerning shu viloyat uchun tarifi
   * qaytadi: courier_regions.tariff_* ?? kuryerning umumiy tarifi (yassi).
   * `tariff_source` — 'region' | 'flat'. Oddiy kuryer va `regionId`siz
   * chaqiruvlar o'zgarmaydi. Natija order-service'da `orders.courier_tariff`
   * ga SNAPSHOT bo'ladi — keyingi tarif o'zgarishi eski buyurtmaga ta'sir
   * qilmaydi.
   */
  /**
   * o2j9uDtT — har viloyat uchun kuryerlar soni: `total` (o'chirilmagan
   * barcha kuryerlar) va `active` (faqat status = 'active').
   *
   * Viloyatga tegishlilik `findAllCouriers({ region_id })` (GET
   * /region/stats/:id dagi `listCouriersByRegion`) bilan AYNAN bir xil:
   * `region_id` mos kuryer YOKI super-kuryer (serves_all_regions yoki
   * courier_regions qatori bilan). Ilgari stats/all javobida bu maydon
   * umuman yo'q edi va xarita tooltipi har viloyatda "Kuryerlar: 0"
   * ko'rsatardi. BITTA so'rov (viloyatlar soniga bog'liq emas); har
   * kuryer har viloyatda ko'pi bilan bir marta sanaladi (LEFT JOIN shart
   * bitta predikat). Javob har so'ralgan viloyat uchun qator (kuryeri yo'q
   * viloyat — 0/0).
   */
  async countCouriersByRegion(regionIds: unknown) {
    const ids = Array.from(
      new Set(
        (Array.isArray(regionIds) ? regionIds : [])
          .map((id) => String(id ?? '').trim())
          .filter((id) => /^\d+$/.test(id)),
      ),
    );
    if (!ids.length) {
      return successRes([], 200, 'Courier counts by region');
    }
    const quote = (tablePath: string) =>
      tablePath
        .split('.')
        .map((part) => `"${part}"`)
        .join('.');
    const admins = quote(this.users.metadata.tablePath);
    const courierRegions = quote(
      this.users.manager.getRepository(CourierRegion).metadata.tablePath,
    );
    const rows = await this.users.manager.query<
      Array<{ region_id: string; total: number; active: number }>
    >(
      `SELECT r.region_id::text AS region_id,
              COUNT(c.id)::int AS total,
              COUNT(c.id) FILTER (WHERE c.status = $2)::int AS active
         FROM unnest($1::bigint[]) AS r(region_id)
         LEFT JOIN ${admins} c
           ON c.is_deleted = false
          AND c.role = $3
          AND (
            c.region_id = r.region_id
            OR (
              c.is_super_courier = true
              AND (
                c.serves_all_regions = true
                OR EXISTS (
                  SELECT 1 FROM ${courierRegions} cr
                   WHERE cr.courier_id = c.id AND cr.region_id = r.region_id
                )
              )
            )
          )
        GROUP BY r.region_id
        ORDER BY r.region_id`,
      [ids, Status.ACTIVE, Roles.COURIER],
    );
    return successRes(
      rows.map((row) => ({
        region_id: String(row.region_id),
        total: Number(row.total) || 0,
        active: Number(row.active) || 0,
      })),
      200,
      'Courier counts by region',
    );
  }

  async findCouriersByIds(ids: string[], regionId?: string | null) {
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

    const normalizedRegionId = String(regionId ?? '').trim();
    const superIds = normalizedRegionId
      ? couriers.filter((c) => c.is_super_courier).map((c) => String(c.id))
      : [];
    const regionRows = superIds.length
      ? await this.users.manager.getRepository(CourierRegion).find({
          where: { courier_id: In(superIds), region_id: normalizedRegionId },
        })
      : [];
    const rowByCourier = new Map(
      regionRows.map((row) => [String(row.courier_id), row]),
    );

    return {
      success: true,
      data: couriers.map((c) => {
        const safe = this.sanitize(c);
        const row = rowByCourier.get(String(c.id));
        if (!row) {
          return safe;
        }
        const tariff_home = row.tariff_home ?? c.tariff_home ?? null;
        const tariff_center = row.tariff_center ?? c.tariff_center ?? null;
        return {
          ...safe,
          tariff_home,
          tariff_center,
          tariff_source:
            row.tariff_home !== null || row.tariff_center !== null
              ? 'region'
              : 'flat',
        };
      }),
    };
  }

  /** hEjjuJaT — GET /couriers/:id/regions. */
  async getCourierRegions(courierId: string) {
    const courier = await this.findCourierOrThrow(courierId);
    const rows = await this.users.manager.getRepository(CourierRegion).find({
      where: { courier_id: String(courier.id) },
      order: { region_id: 'ASC' },
    });
    return successRes(
      this.courierRegionsView(courier, rows),
      200,
      'Courier regions',
    );
  }

  /**
   * hEjjuJaT — PUT /couriers/:id/regions: super-kuryer bayroqlari va
   * viloyatlar ro'yxati (tarif bilan) BITTA tranzaksiyada to'liq almashtiriladi.
   * - is_super_courier=false → courier_regions tozalanadi, serves_all_regions
   *   ham false (oddiy kuryer: bitta region_id, yassi tarif);
   * - serves_all_regions=true faqat super-kuryerga;
   * - viloyatlar logistics'da mavjud bo'lishi shart (tekshirib bo'lmasa — 503,
   *   fail-closed); takror viloyat — 400; tarif — butun son ≥ 0 yoki null.
   */
  async setCourierRegions(
    courierId: string,
    dto: {
      is_super_courier?: boolean;
      serves_all_regions?: boolean;
      regions?: Array<{
        region_id?: string | number | null;
        tariff_home?: number | null;
        tariff_center?: number | null;
      }>;
    },
    requester?: RequesterContext,
  ) {
    const courier = await this.findCourierOrThrow(courierId);
    const isSuper =
      typeof dto?.is_super_courier === 'boolean'
        ? dto.is_super_courier
        : Boolean(courier.is_super_courier);
    const servesAll = isSuper
      ? typeof dto?.serves_all_regions === 'boolean'
        ? dto.serves_all_regions
        : Boolean(courier.serves_all_regions)
      : false;
    if (!isSuper && dto?.serves_all_regions === true) {
      this.badRequest(
        'serves_all_regions faqat super-kuryer (is_super_courier=true) uchun',
      );
    }

    const rawRegions = Array.isArray(dto?.regions) ? dto.regions : [];
    if (!isSuper && rawRegions.length) {
      this.badRequest(
        "Viloyatlar ro'yxati faqat super-kuryer (is_super_courier=true) uchun",
      );
    }
    const normalizeTariff = (value: unknown, field: string): number | null => {
      if (value === null || typeof value === 'undefined' || value === '') {
        return null;
      }
      const num = Number(value);
      if (!Number.isInteger(num) || num < 0) {
        this.badRequest(`${field} butun son va 0 dan kichik bo'lmasligi kerak`);
      }
      return num;
    };
    const seen = new Set<string>();
    const regions = rawRegions.map((item) => {
      const regionId = String(item?.region_id ?? '').trim();
      if (!/^\d+$/.test(regionId)) {
        this.badRequest("region_id noto'g'ri");
      }
      if (seen.has(regionId)) {
        this.badRequest(`Viloyat takrorlangan: ${regionId}`);
      }
      seen.add(regionId);
      return {
        region_id: regionId,
        tariff_home: normalizeTariff(item?.tariff_home, 'tariff_home'),
        tariff_center: normalizeTariff(item?.tariff_center, 'tariff_center'),
      };
    });
    await this.assertRegionsExist(regions.map((r) => r.region_id));

    const before = await this.users.manager.getRepository(CourierRegion).find({
      where: { courier_id: String(courier.id) },
    });

    const saved = await this.users.manager.transaction(async (manager) => {
      await manager
        .getRepository(User)
        .update(
          { id: String(courier.id) },
          { is_super_courier: isSuper, serves_all_regions: servesAll },
        );
      const repo = manager.getRepository(CourierRegion);
      await repo.delete({ courier_id: String(courier.id) });
      if (regions.length) {
        await repo.insert(
          regions.map((r) => ({ ...r, courier_id: String(courier.id) })),
        );
      }
      return repo.find({
        where: { courier_id: String(courier.id) },
        order: { region_id: 'ASC' },
      });
    });

    await this.activityLog.logChange({
      entity_type: 'User',
      entity_id: String(courier.id),
      action: ActivityAction.UPDATED,
      old_value: {
        is_super_courier: Boolean(courier.is_super_courier),
        serves_all_regions: Boolean(courier.serves_all_regions),
        courier_regions: before.map((r) => ({
          region_id: String(r.region_id),
          tariff_home: r.tariff_home,
          tariff_center: r.tariff_center,
        })),
      },
      new_value: {
        is_super_courier: isSuper,
        serves_all_regions: servesAll,
        courier_regions: saved.map((r) => ({
          region_id: String(r.region_id),
          tariff_home: r.tariff_home,
          tariff_center: r.tariff_center,
        })),
      },
      metadata: { kind: 'courier_regions' },
      ...this.auditActor(requester),
    });

    return successRes(
      this.courierRegionsView(
        {
          ...courier,
          is_super_courier: isSuper,
          serves_all_regions: servesAll,
        },
        saved,
      ),
      200,
      'Courier regions saved',
    );
  }

  private async findCourierOrThrow(courierId: string): Promise<User> {
    const id = String(courierId ?? '').trim();
    if (!/^\d+$/.test(id)) {
      this.badRequest("Kuryer id noto'g'ri");
    }
    const courier = await this.users.findOne({
      where: { id, role: Roles.COURIER, isDeleted: false },
    });
    if (!courier) {
      this.notFound('Kuryer topilmadi');
    }
    return courier;
  }

  private courierRegionsView(
    courier: Pick<
      User,
      | 'id'
      | 'region_id'
      | 'tariff_home'
      | 'tariff_center'
      | 'is_super_courier'
      | 'serves_all_regions'
    >,
    rows: CourierRegion[],
  ) {
    return {
      courier_id: String(courier.id),
      home_region_id: courier.region_id ?? null,
      is_super_courier: Boolean(courier.is_super_courier),
      serves_all_regions: Boolean(courier.serves_all_regions),
      flat_tariff_home: courier.tariff_home ?? null,
      flat_tariff_center: courier.tariff_center ?? null,
      regions: rows.map((row) => ({
        region_id: String(row.region_id),
        tariff_home: row.tariff_home,
        tariff_center: row.tariff_center,
      })),
    };
  }

  /** hEjjuJaT: viloyatlar logistics'da bormi — 404 → 400, aloqa yo'q → 503. */
  private async assertRegionsExist(regionIds: string[]): Promise<void> {
    for (const id of regionIds) {
      try {
        const res = await lastValueFrom(
          this.logisticsClient
            .send({ cmd: 'logistics.region.find_by_id' }, { id })
            .pipe(timeout(5000)),
        );
        const found = (res as { data?: { id?: unknown } } | null)?.data;
        if (!found || typeof found !== 'object') {
          this.badRequest(`Viloyat topilmadi: ${id}`);
        }
      } catch (error) {
        if (error instanceof RpcException) {
          throw error;
        }
        const status = Number(
          (error as { statusCode?: unknown; status?: unknown })?.statusCode ??
            (error as { status?: unknown })?.status,
        );
        if (status === 404) {
          this.badRequest(`Viloyat topilmadi: ${id}`);
        }
        throw new RpcException(
          errorRes(
            "Viloyatlarni tekshirib bo'lmadi, keyinroq urinib ko'ring",
            503,
          ),
        );
      }
    }
  }

  async searchCustomers(
    search: string,
    limit = 1000,
    /**
     * 9444UAa8 — `matchExtraNumber`: qo'shimcha raqam (`extra_number`) ham
     * asosiy telefon kabi (normallashtirilgan raqamlar) qidiriladi. Mijoz
     * taklifi (GET /customers/suggest) va buyurtmalar ro'yxati qidiruvi
     * (order-service, FoCaUF10 — ega qarori 2026-10-25) yoqadi; almashtirish
     * qidiruvi o'zgarmagan.
     */
    options: { matchExtraNumber?: boolean } = {},
  ) {
    if (!search?.trim()) {
      return { success: true, data: [] };
    }

    // zfPNDCCr: qidiruv telefonga o'xshasa ("0901234567", "+998 90 123 45 67",
    // "998901234567", "901234567"), saqlangan telefonning FAQAT RAQAMLARI
    // ichidan milliy 9 raqam izlanadi — kanonik (+998XXXXXXXXX) ham, eski
    // "998..."/"9 xona"/"+998 90 123 45 67" yozuvlar ham topiladi. Ism
    // qidiruviga ta'sir qilmaydi (harfli matn telefon emas).
    // Buyurtmalar ro'yxati qidiruvi (order-service `search`) ham shu RPC'dan
    // o'tadi.
    const phoneSearch = parseUzPhoneSearch(search);
    const matchExtraNumber = options.matchExtraNumber === true;
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
          this.orWherePhoneDigits(q, 'u', phoneSearch);
          // 9444UAa8: qo'shimcha raqam — faqat telefon ko'rinishidagi
          // qidiruvda (7+ raqam) va o'sha normallashtirilgan raqamlar bilan.
          if (matchExtraNumber && phoneSearch) {
            q.orWhere(uzPhoneDigitsLikeSql('u.extra_number', 'extraDigits'), {
              extraDigits: `%${phoneSearch.digits}%`,
            });
          }
        }),
      )
      // Barqaror tartib: limitdan oshganda qaysi mijozlar qaytishi tasodifiy
      // bo'lmasin (eng yangilari birinchi).
      .orderBy('u.id', 'DESC')
      .take(limit);

    const rows = await qb.getMany();
    return {
      success: true,
      data: rows.map((r) => ({
        ...this.sanitize(r),
        matched_by: this.customerMatchedBy(
          r,
          search,
          phoneSearch,
          matchExtraNumber,
        ),
      })),
    };
  }

  /**
   * 9444UAa8 — qaysi maydon mos keldi (SQL shartlarining aynan o'zi, ustuvorlik:
   * asosiy telefon → qo'shimcha raqam → ism). Frontend «Qo'shimcha raqam: …»
   * belgisini taxmin bilan emas, shu maydondan chizadi.
   */
  private customerMatchedBy(
    row: Pick<User, 'phone_number' | 'extra_number'>,
    search: string,
    phoneSearch: UzPhoneSearch | null,
    matchExtraNumber: boolean,
  ): 'phone' | 'extra_number' | 'name' {
    const needle = search.trim().toLowerCase();
    const digitsOf = (value: unknown) =>
      primitiveText(value).replace(/[^0-9]/g, '');
    const phone = primitiveText(row.phone_number);
    if (
      phone.toLowerCase().includes(needle) ||
      (phoneSearch && digitsOf(phone).includes(phoneSearch.digits))
    ) {
      return 'phone';
    }
    if (
      matchExtraNumber &&
      phoneSearch &&
      digitsOf(row.extra_number).includes(phoneSearch.digits)
    ) {
      return 'extra_number';
    }
    return 'name';
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
      select: [
        'id',
        'phone_number',
        'role',
        'language',
        'settings',
        // (rCFZAmOz) shaxsiy Telegram DM uchun (bot orqali ulangan chat).
        'telegram_id',
      ],
    });
    return successRes(
      rows.map((row) => {
        const settings = row.settings as {
          appearance?: { language?: unknown };
          notifications?: { quiet_hours?: unknown };
        } | null;
        const appearance = settings?.appearance;
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
          // (mP1WGG1W) tinch soatlar — notification-service push'ni suradi.
          quiet_hours: settings?.notifications?.quiet_hours ?? null,
          telegram_id: row.telegram_id ?? null,
        };
      }),
    );
  }

  /**
   * (td89SKXQ #3-#4 / 9uNhwTZp) Telegram akkauntni xodimga bog'lash — FAQAT
   * ichki RMQ (notification-service bot: bir martalik kod band qilingandan
   * keyin; kod paneldan, JWT bilan olingan). BeePost tekshiruvlari aynan:
   *  (a) bu telegram_id boshqa (o'chirilmagan) xodimda — 409;
   *  (b) bu xodimda BOSHQA telegram_id bor — 409 (avval uzish kerak);
   *  (c) status ACTIVE emas — 403;
   *  (d) mijoz / investor — 403 (bot aktori bo'la olmaydi).
   * Solishtirish doim `String()` (Elchi'da varchar, Telegram'da son).
   * Poyga: partial unique indeks (UQ_ADMINS_TELEGRAM_ID) → 23505 → 409.
   */
  async telegramLink(payload: {
    user_id?: unknown;
    telegram_id?: unknown;
    telegram_username?: unknown;
  }) {
    const userId = primitiveText(payload?.user_id).trim();
    const telegramId = primitiveText(payload?.telegram_id).trim();
    if (!/^\d{1,19}$/.test(userId) || !/^\d{1,20}$/.test(telegramId)) {
      throw new RpcException({
        statusCode: 400,
        message: "user_id / telegram_id noto'g'ri",
      });
    }
    const user = await this.users.findOne({
      where: { id: userId, isDeleted: false },
      select: ['id', 'role', 'status', 'telegram_id'],
    });
    if (!user) {
      throw new RpcException({
        statusCode: 404,
        message: 'Foydalanuvchi topilmadi',
      });
    }
    if ([Roles.CUSTOMER, Roles.INVESTOR].includes(user.role)) {
      throw new RpcException({
        statusCode: 403,
        message: 'Bu rol Telegram botiga ulanmaydi',
      });
    }
    if (user.status !== Status.ACTIVE) {
      throw new RpcException({
        statusCode: 403,
        message: 'Akkaunt faol emas — Telegram ulanmaydi',
      });
    }
    const current = String(user.telegram_id ?? '').trim();
    if (current && current !== telegramId) {
      throw new RpcException({
        statusCode: 409,
        message:
          "Akkauntingiz boshqa Telegram'ga ulangan — avval profildan uzing",
      });
    }
    const owner = await this.users.findOne({
      where: { telegram_id: telegramId },
      select: ['id', 'isDeleted'],
    });
    if (owner && String(owner.id) !== userId) {
      if (!owner.isDeleted) {
        throw new RpcException({
          statusCode: 409,
          message: 'Bu Telegram akkaunt boshqa xodimga ulangan',
        });
      }
      // O'chirilgan akkauntda qolgan bog'lanish — bo'shatiladi.
      await this.users.update(
        { id: owner.id },
        {
          telegram_id: null,
          telegram_username: null,
          telegram_linked_at: null,
        },
      );
    }
    const username = primitiveText(payload?.telegram_username)
      .trim()
      .replace(/^@/, '')
      .slice(0, 64);
    try {
      await this.users.update(
        { id: userId, isDeleted: false, status: Status.ACTIVE },
        {
          telegram_id: telegramId,
          telegram_username: username || null,
          telegram_linked_at: new Date(),
        },
      );
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new RpcException({
          statusCode: 409,
          message: 'Bu Telegram akkaunt boshqa xodimga ulangan',
        });
      }
      throw error;
    }
    await this.activityLog
      .log({
        entity_type: 'User',
        entity_id: userId,
        action: 'notification.tg_linked',
        user_id: userId,
        user_role: String(user.role),
        metadata: { via: 'bot_link_code' },
      })
      .catch(() => undefined);
    return successRes(
      { linked: true, user_id: userId, role: user.role },
      200,
      'Telegram linked',
    );
  }

  /**
   * (rCFZAmOz) eski nom — endi `telegramLink` tekshiruvlari bilan (konflikt,
   * faollik, rol). Ichki RMQ, gateway'da HTTP marshruti yo'q.
   */
  async telegramBind(payload: { user_id?: unknown; telegram_id?: unknown }) {
    const result = await this.telegramLink(payload);
    return successRes({ bound: true, ...result.data }, 200, 'Telegram linked');
  }

  /** (rCFZAmOz) Bot `/stop` | `/uzish` — shu chat ulangan akkauntdan uziladi. */
  async telegramUnbind(payload: { telegram_id?: unknown }) {
    const telegramId = primitiveText(payload?.telegram_id).trim();
    if (!/^-?\d{1,20}$/.test(telegramId)) {
      throw new RpcException({
        statusCode: 400,
        message: "telegram_id noto'g'ri",
      });
    }
    const result = await this.users.update(
      { telegram_id: telegramId },
      { telegram_id: null, telegram_username: null, telegram_linked_at: null },
    );
    return successRes(
      { unbound: result.affected ?? 0 },
      200,
      'Telegram unlinked',
    );
  }

  /**
   * (9uNhwTZp #3) `DELETE /users/me/telegram` — o'z akkauntidan uzish
   * (user_id faqat JWT'dan). Audit izi yoziladi.
   */
  async telegramUnlinkUser(payload: { user_id?: unknown }) {
    const userId = primitiveText(payload?.user_id).trim();
    if (!/^\d{1,19}$/.test(userId)) {
      throw new RpcException({ statusCode: 401, message: 'Unauthorized' });
    }
    const result = await this.users.update(
      { id: userId },
      { telegram_id: null, telegram_username: null, telegram_linked_at: null },
    );
    const unlinked = (result.affected ?? 0) > 0;
    if (unlinked) {
      await this.activityLog
        .log({
          entity_type: 'User',
          entity_id: userId,
          action: 'notification.tg_unlinked',
          user_id: userId,
          metadata: { via: 'profile' },
        })
        .catch(() => undefined);
    }
    return successRes({ unlinked }, 200, 'Telegram unlinked');
  }

  /**
   * (3ZfiXuaW #1 / ZlpXb4Wh) Bot RBAC darvozasi: `telegram_id` → aktor.
   * FAIL-CLOSED: bog'lanmagan, faol bo'lmagan, o'chirilgan yoki bir nechta
   * akkauntga bog'langan (eski noaniqlik) id → `null` (throw emas).
   * Mijoz va investor botda aktor bo'la olmaydi.
   */
  async telegramResolve(payload: { telegram_id?: unknown }) {
    const telegramId = primitiveText(payload?.telegram_id).trim();
    if (!/^-?\d{1,20}$/.test(telegramId)) return successRes(null);
    const map = await this.resolveTelegramActors([telegramId]);
    return successRes(map.get(telegramId) ?? null);
  }

  /**
   * (td89SKXQ #3) Ko'p telegram_id bir so'rovda → { [telegram_id]: aktor | null }.
   * (TgYRqaTk #1) `user_ids` berilsa — teskari yo'nalish: bildirishnoma
   * qabul qiluvchisi → shaxsiy chat: { [user_id]: telegram_id | null }.
   * FAIL-CLOSED: faol bo'lmagan / o'chirilgan / ulanmagan / bitta chat bir
   * nechta akkauntda (eski noaniqlik) → `null` (DM yuborilmaydi).
   */
  async telegramResolveMany(payload: {
    telegram_ids?: unknown;
    user_ids?: unknown;
  }) {
    if (Array.isArray(payload?.user_ids)) {
      return successRes(await this.telegramChatsByUserIds(payload.user_ids));
    }
    const ids = [
      ...new Set(
        (Array.isArray(payload?.telegram_ids) ? payload.telegram_ids : [])
          .map((id) => primitiveText(id).trim())
          .filter((id) => /^-?\d{1,20}$/.test(id)),
      ),
    ].slice(0, 1000);
    const map = await this.resolveTelegramActors(ids);
    return successRes(
      Object.fromEntries(ids.map((id) => [id, map.get(id) ?? null])),
    );
  }

  private async telegramChatsByUserIds(
    raw: unknown[],
  ): Promise<Record<string, string | null>> {
    const ids = [
      ...new Set(
        raw
          .map((id) => primitiveText(id).trim())
          .filter((id) => /^\d{1,20}$/.test(id)),
      ),
    ].slice(0, 5000);
    const result: Record<string, string | null> = Object.fromEntries(
      ids.map((id) => [id, null]),
    );
    if (!ids.length) return result;
    const rows = await this.users.find({
      where: { id: In(ids), isDeleted: false },
      select: ['id', 'status', 'telegram_id'],
    });
    const linked = rows.filter(
      (row) => row.status === Status.ACTIVE && primitiveText(row.telegram_id),
    );
    // Bitta chat bir nechta akkauntda (UQ indeksdan oldingi meros) — hech
    // biriga yuborilmaydi: begona odamga xabar ketishidan xavfsizroq.
    const chats = linked.map((row) => primitiveText(row.telegram_id));
    const owners = new Map<string, number>();
    if (chats.length) {
      for (const row of await this.users.find({
        where: { telegram_id: In(chats), isDeleted: false },
        select: ['id', 'telegram_id'],
      })) {
        const chat = primitiveText(row.telegram_id);
        owners.set(chat, (owners.get(chat) ?? 0) + 1);
      }
    }
    const ambiguous = new Set(
      [...owners].filter(([, count]) => count > 1).map(([chat]) => chat),
    );
    for (const row of linked) {
      const chat = primitiveText(row.telegram_id);
      if (!ambiguous.has(chat)) result[String(row.id)] = chat;
    }
    return result;
  }

  private async resolveTelegramActors(telegramIds: string[]) {
    const result = new Map<
      string,
      {
        user_id: string;
        role: Roles;
        status: Status;
        market_id: string | null;
        region_id: string | null;
      }
    >();
    if (!telegramIds.length) return result;
    const rows = await this.users.find({
      where: { telegram_id: In(telegramIds), isDeleted: false },
      select: ['id', 'role', 'status', 'market_id', 'region_id', 'telegram_id'],
    });
    const byTelegram = new Map<string, User[]>();
    for (const row of rows) {
      const key = String(row.telegram_id);
      byTelegram.set(key, [...(byTelegram.get(key) ?? []), row]);
    }
    for (const [telegramId, matches] of byTelegram) {
      if (matches.length !== 1) {
        this.logger.warn(
          'identity.telegram.resolve: bitta telegram_id bir nechta akkauntda — rad etildi (fail-closed)',
        );
        continue;
      }
      const [user] = matches;
      if (
        user.status !== Status.ACTIVE ||
        [Roles.CUSTOMER, Roles.INVESTOR].includes(user.role)
      ) {
        continue;
      }
      result.set(telegramId, {
        user_id: String(user.id),
        role: user.role,
        status: user.status,
        // Market — o'zi; market operatori — biriktirilgan market.
        market_id:
          user.role === Roles.MARKET
            ? String(user.id)
            : user.market_id
              ? String(user.market_id)
              : null,
        region_id: user.region_id ? String(user.region_id) : null,
      });
    }
    return result;
  }

  /**
   * (4BirMSVp #2) Avtomatik kunlik hisobot: Telegram'ga ulangan, faol,
   * o'chirilmagan xodimlar (rol bo'yicha). Faqat ichki RMQ (notification
   * scheduler); telegram_id javobi gateway'ga chiqmaydi.
   */
  async telegramLinkedUsers(payload: { role?: unknown }) {
    const role = primitiveText(payload?.role).trim().toLowerCase();
    if (!(Object.values(Roles) as string[]).includes(role)) {
      throw new RpcException({ statusCode: 400, message: "role noto'g'ri" });
    }
    const rows = await this.users
      .createQueryBuilder('u')
      .select(['u.id AS user_id', 'u.telegram_id AS telegram_id'])
      .where('u.telegram_id IS NOT NULL')
      .andWhere('u.is_deleted = false')
      .andWhere('u.status = :active', { active: Status.ACTIVE })
      .andWhere('u.role = :role', { role })
      .orderBy('u.id', 'ASC')
      .limit(5000)
      .getRawMany<{ user_id: string; telegram_id: string }>();
    return successRes(
      rows.map((row) => ({
        user_id: String(row.user_id),
        telegram_id: String(row.telegram_id),
      })),
    );
  }

  /** (9HIaV80X #6) `bot_linked_users{role}` metrikasi uchun. */
  async telegramLinkedCounts() {
    const rows: Array<{ role: string; count: string }> = await this.users
      .createQueryBuilder('u')
      .select('u.role', 'role')
      .addSelect('COUNT(*)', 'count')
      .where('u.telegram_id IS NOT NULL')
      .andWhere('u.is_deleted = false')
      .groupBy('u.role')
      .getRawMany();
    return successRes(
      rows.map((row) => ({ role: row.role, count: Number(row.count) })),
    );
  }

  /**
   * (9uNhwTZp #6 / td89SKXQ #7) Dashboard: rol bo'yicha `ulangan / jami`
   * (faol, o'chirilmagan xodimlar). 0% — bog'lash oqimi buzilgan signali.
   */
  async telegramStats() {
    const rows: Array<{ role: string; total: string; linked: string }> =
      await this.users
        .createQueryBuilder('u')
        .select('u.role', 'role')
        .addSelect('COUNT(*)', 'total')
        .addSelect('COUNT(u.telegram_id)', 'linked')
        .where('u.is_deleted = false')
        .andWhere('u.status = :active', { active: Status.ACTIVE })
        .andWhere('u.role NOT IN (:...excluded)', {
          excluded: [Roles.CUSTOMER, Roles.INVESTOR],
        })
        .groupBy('u.role')
        .getRawMany();
    return successRes(
      rows.map((row) => {
        const total = Number(row.total) || 0;
        const linked = Number(row.linked) || 0;
        return {
          role: row.role,
          total,
          linked,
          ratio: total ? Math.round((linked / total) * 1000) / 1000 : 0,
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

  // ==================== Market operators (i76gGjyq) ====================

  /**
   * Market operatorlari ko'lami (i76gGjyq). `market_id` gateway'dan keladi
   * (market so'rovida — JWT `sub`), lekin bu yerda QAYTA tekshiriladi
   * (defense-in-depth): FAQAT market va faqat O'Z id'si bilan (karta:
   * "requester.sub = market_id majburiy" — BeePost `getMyOperators` ko'lam
   * modeli), boshqa rollar (superadmin/admin ham) — 403; admin uchun mavjud
   * `/users` yo'llari bor. requester yo'q — ishonchli ichki chaqiruv.
   * Qaytadi: kanonik market id ('01' → '1').
   */
  private resolveMarketOperatorScope(
    marketId: unknown,
    requester?: RequesterContext,
  ): string {
    const raw = primitiveText(marketId).trim();
    if (!/^\d{1,19}$/.test(raw)) {
      this.badRequest("market_id noto'g'ri");
    }
    const canonical = BigInt(raw).toString();
    if (!requester) {
      return canonical;
    }
    if (this.hasRole(requester, Roles.MARKET)) {
      if (!sameEntityId(requester.id, canonical)) {
        this.forbidden("Market faqat o'z operatorlarini boshqara oladi");
      }
      return canonical;
    }
    this.forbidden('Bu amal uchun ruxsat yoq');
  }

  /**
   * Marketga qaytadigan operator ko'rinishi (i76gGjyq): parol, refresh token,
   * maosh va UI sozlamalari YO'Q — faqat sahifa va komissiya formasi uchun
   * kerakli maydonlar.
   */
  private toMarketOperatorView(user: User) {
    return {
      id: user.id,
      name: user.name,
      phone_number: user.phone_number,
      role: user.role,
      status: user.status,
      market_id: user.market_id ?? null,
      commission_type: user.commission_type ?? null,
      commission_value: user.commission_value ?? null,
      // XtcEyQjb — «Ombordagi qoldiq»ni ko'rish kaliti (sukut false).
      can_view_warehouse_stock: user.can_view_warehouse_stock === true,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /** Shu marketning o'chirilmagan operatori; aks holda (begona/yo'q) — 404. */
  private async findOwnMarketOperator(
    id: unknown,
    marketId: string,
  ): Promise<User> {
    const operatorId = primitiveText(id).trim();
    if (!/^\d{1,19}$/.test(operatorId)) {
      this.notFound(MARKET_OPERATOR_NOT_FOUND);
    }
    const operator = await this.users.findOne({
      where: {
        id: BigInt(operatorId).toString(),
        role: Roles.MARKET_OPERATOR,
        market_id: marketId,
        isDeleted: false,
      },
    });
    if (!operator) {
      this.notFound(MARKET_OPERATOR_NOT_FOUND);
    }
    return operator;
  }

  /**
   * Operator komissiyasi kirishi (i76gGjyq; B3ZtzCCx da yaratish bilan
   * UMUMIY — ikki yo'lda qoida bir xil bo'lsin). RMQ'da ValidationPipe yo'q:
   * turi — percent | fixed | null, qiymati — manfiy bo'lmagan chekli son,
   * ko'pi bilan 2 kasr (numeric(14,2) — 3+ kasr jimgina yaxlitlanmasin) yoki
   * null. Berilmagan maydon — null.
   */
  private parseMarketOperatorCommission(dto?: {
    commission_type?: unknown;
    commission_value?: unknown;
  }): { type: Commission_type | null; value: number | null } {
    const type = (dto?.commission_type ?? null) as Commission_type | null;
    if (type !== null && !Object.values(Commission_type).includes(type)) {
      this.badRequest("commission_type noto'g'ri (percent | fixed)");
    }
    const value = (dto?.commission_value ?? null) as number | null;
    if (value !== null) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        this.badRequest("commission_value manfiy bo'lmagan son bo'lishi kerak");
      }
      if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6) {
        this.badRequest("commission_value ko'pi bilan 2 kasr xonali bo'lsin");
      }
    }
    return { type, value };
  }

  /**
   * Turi bo'yicha chegara — BIRLASHGAN holat bo'yicha: PERCENT 0..100,
   * FIXED 0..1 000 000 so'm.
   */
  private assertMarketOperatorCommissionBounds(
    type: Commission_type | null,
    value: number | string | null,
  ): void {
    if (
      type === Commission_type.PERCENT &&
      value !== null &&
      Number(value) > MARKET_OPERATOR_PERCENT_MAX
    ) {
      this.badRequest("Komissiya foizi 0 dan 100 gacha bo'lishi kerak");
    }
    if (
      type === Commission_type.FIXED &&
      value !== null &&
      Number(value) > MARKET_OPERATOR_FIXED_MAX
    ) {
      this.badRequest(
        "Belgilangan komissiya 0 dan 1 000 000 so'mgacha bo'lishi kerak",
      );
    }
  }

  /**
   * identity.market_operator.create (i76gGjyq) — market o'z operatorini
   * yaratadi. Rol DOIM market_operator, market_id — ko'lamdagi market (mijoz
   * tanasidan EMAS). Kassa YARATILMAYDI: operator pul ushlamaydi — uning
   * daromadi finance `operator_earnings` da hisoblanadi va uni market to'laydi
   * (Cashbox_type'da operator turi yo'q; BeePost'da ham operator kassasiz).
   *
   * B3ZtzCCx (ega qarori 2026-10-19, MO-S5): ixtiyoriy komissiya AYNI
   * so'rovda (bitta save — atomik; ilgari POST + alohida PATCH :id/commission,
   * ikkinchisi yiqilsa operator komissiyasiz qolardi). Qoida PATCH bilan bir
   * xil (percent 0..100, fixed 0..1 000 000, 2 kasr) va IKKALASI BIRGA:
   * faqat turi yoki faqat qiymati — 400; ikkalasi yo'q / null — komissiyasiz.
   */
  async createMarketOperator(
    marketId: string,
    dto: CreateMarketOperatorDto,
    requester?: RequesterContext,
  ) {
    const scopedMarketId = this.resolveMarketOperatorScope(marketId, requester);

    const name = primitiveText(dto?.name).trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 100) {
      this.badRequest("Operator ismi 2-100 belgi bo'lishi kerak");
    }
    const password = typeof dto?.password === 'string' ? dto.password : '';
    if (password.length < 4) {
      this.badRequest("Parol kamida 4 belgi bo'lishi kerak");
    }
    // Telefon serverda kanonik ko'rinishga keltiriladi (+998XXXXXXXXX):
    // '998901234567' va '+998901234567' — bitta odam, takroriylik tekshiruvi
    // aylanib o'tilmasin (BeePost'dagi saboq).
    const rawPhone = primitiveText(dto?.phone_number).trim();
    const phone = normalizeUzPhone(rawPhone);
    if (!phone) {
      this.badRequest("Telefon raqam noto'g'ri");
    }
    // B3ZtzCCx: komissiya — yozishdan OLDIN to'liq tekshiriladi.
    const commission = this.parseMarketOperatorCommission(dto);
    if ((commission.type === null) !== (commission.value === null)) {
      this.badRequest(
        'commission_type va commission_value birga yuborilishi kerak',
      );
    }
    this.assertMarketOperatorCommissionBounds(
      commission.type,
      commission.value,
    );

    // Market bazadan qayta o'qiladi: o'chirilgan yoki bloklangan market
    // operator qo'sha olmaydi (aks holda yangi ACTIVE operator orqali blok
    // o'z-o'zidan "erirdi").
    const market = await this.users.findOne({
      where: { id: scopedMarketId, role: Roles.MARKET, isDeleted: false },
    });
    if (!market) {
      this.notFound('Market topilmadi');
    }
    if (market.status !== Status.ACTIVE) {
      this.forbidden("Market bloklangan — operator qo'shib bo'lmaydi");
    }

    await this.ensurePhoneUnique(phone);
    if (rawPhone !== phone) {
      await this.ensurePhoneUnique(rawPhone);
    }

    const hashedPassword = await this.bcryptEncryption.encrypt(password);
    const operator = this.users.create({
      name,
      phone_number: phone,
      username: null,
      password: hashedPassword,
      salary: 0,
      payment_day: undefined,
      market_id: scopedMarketId,
      role: Roles.MARKET_OPERATOR,
      status: Status.ACTIVE,
      created_by: this.createdByOf(requester),
      tariff_home: null,
      tariff_center: null,
      add_order: false,
      can_add_extra_cost: false,
      default_tariff: null,
      commission_type: commission.type,
      commission_value: commission.value,
      isDeleted: false,
    });

    let saved: User;
    try {
      saved = await this.users.save(operator);
    } catch (error) {
      // Bir vaqtdagi ikki so'rov ensurePhoneUnique'dan birga o'tishi mumkin —
      // DB unique (phone_number) ikkinchisini 23505 bilan rad etadi: 500 emas,
      // aniq 409.
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code === '23505'
      ) {
        this.conflict('Bu telefon raqam allaqachon mavjud');
      }
      throw error;
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
        // B3ZtzCCx: yaratishda berilgan komissiya jurnalda ham ko'rinadi.
        commission_type: saved.commission_type ?? null,
        commission_value: saved.commission_value ?? null,
      },
      ...this.auditActor(requester),
      metadata: { market_id: scopedMarketId },
    });
    return successRes(
      this.toMarketOperatorView(saved),
      201,
      'Operator yaratildi',
    );
  }

  /**
   * identity.market_operator.find_by_market (i76gGjyq) — FAQAT shu marketning
   * operatorlari (role = market_operator, o'chirilmagan). Javob shakli
   * GET /users bilan bir xil (`items` + `meta`), sahifalash 100 gacha.
   */
  async findMarketOperators(
    marketId: string,
    query: MarketOperatorFilterQuery = {},
    requester?: RequesterContext,
  ) {
    const scopedMarketId = this.resolveMarketOperatorScope(marketId, requester);
    const { search, status, page, limit, skip } = this.normalizeQuery({
      search: typeof query?.search === 'string' ? query.search : undefined,
      status: typeof query?.status === 'string' ? query.status : undefined,
      page: query?.page,
      limit: query?.limit,
    });

    const base = {
      role: Roles.MARKET_OPERATOR,
      market_id: scopedMarketId,
      isDeleted: false,
      ...(status ? { status } : {}),
    };
    // zfPNDCCr: telefonga o'xshash qidiruv — raqamlar ichidan (formatsiz).
    const phoneSearch = parseUzPhoneSearch(search);
    const where = search
      ? [
          { ...base, name: ILike(`%${search}%`) },
          { ...base, phone_number: ILike(`%${search}%`) },
          ...(phoneSearch
            ? [
                {
                  ...base,
                  phone_number: Raw((column) => uzPhoneDigitsLikeSql(column), {
                    phoneDigits: `%${phoneSearch.digits}%`,
                  }),
                },
              ]
            : []),
        ]
      : base;

    const [rows, total] = await this.users.findAndCount({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      skip,
      take: limit,
    });

    return successRes({
      items: rows.map((row) => this.toMarketOperatorView(row)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  }

  /**
   * identity.market_operator.delete (i76gGjyq) — soft-delete (deleteUser
   * shakli: telefon/username bo'shatiladi, status inactive). Barcha
   * sessiyalar yopiladi: qurilma keyingi refresh'da chiqariladi (access
   * token ko'pi bilan ACCESS_TOKEN_TIME yashaydi). Buyurtmalar va daromad tarixi tegilmaydi.
   */
  async deleteMarketOperator(
    id: string,
    marketId: string,
    requester?: RequesterContext,
  ) {
    const scopedMarketId = this.resolveMarketOperatorScope(marketId, requester);
    const operator = await this.findOwnMarketOperator(id, scopedMarketId);

    const ts = Date.now();
    operator.isDeleted = true;
    operator.status = Status.INACTIVE;
    operator.phone_number = `${operator.phone_number}-d${ts % 100000}`.slice(
      0,
      20,
    );
    operator.username = operator.username?.length
      ? `${operator.username}#del#${ts % 100000}`.slice(0, 60)
      : null;
    invalidateAllSessions(operator);

    const saved = await this.users.save(operator);
    await this.revokeSessionsAfterSecurityChange(saved);
    void this.removeUserFromSearch(saved);
    await this.activityLog.log({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.DELETED,
      old_value: { name: saved.name, role: saved.role },
      ...this.auditActor(requester),
      metadata: { market_id: scopedMarketId },
    });
    return successRes({ id: saved.id }, 200, "Operator o'chirildi");
  }

  /**
   * identity.market_operator.update_commission (i76gGjyq) — market o'z
   * operatorining komissiyasini belgilaydi. Yangi qiymat faqat KEYINGI
   * sotuvlarga ta'sir qiladi: finance har sotuvda qoidani o'qib, earning
   * qatoriga snapshot qiladi. `null` — tozalash (komissiya yo'q). Tekshiruv
   * BIRLASHGAN holat bo'yicha: faqat turni almashtirish (masalan fixed 50 000
   * → percent) ham chegaradan o'tsa 400.
   */
  async updateMarketOperatorCommission(
    id: string,
    marketId: string,
    dto: UpdateMarketOperatorCommissionDto,
    requester?: RequesterContext,
  ) {
    const scopedMarketId = this.resolveMarketOperatorScope(marketId, requester);

    const hasType = typeof dto?.commission_type !== 'undefined';
    const hasValue = typeof dto?.commission_value !== 'undefined';
    if (!hasType && !hasValue) {
      this.badRequest('commission_type yoki commission_value majburiy');
    }
    const { type: nextTypeInput, value: nextValueInput } =
      this.parseMarketOperatorCommission(dto);

    const operator = await this.findOwnMarketOperator(id, scopedMarketId);
    const before = {
      commission_type: operator.commission_type ?? null,
      commission_value: operator.commission_value ?? null,
    };
    const nextType = hasType ? nextTypeInput : before.commission_type;
    const nextValue = hasValue ? nextValueInput : before.commission_value;

    this.assertMarketOperatorCommissionBounds(nextType, nextValue);

    operator.commission_type = nextType;
    operator.commission_value = nextValue;
    const saved = await this.users.save(operator);
    await this.activityLog.logChange({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.UPDATED,
      old_value: before,
      new_value: {
        commission_type: saved.commission_type ?? null,
        commission_value: saved.commission_value ?? null,
      },
      ...this.auditActor(requester),
      metadata: {
        market_id: scopedMarketId,
        reason: 'market_operator_commission',
      },
    });
    return successRes(
      this.toMarketOperatorView(saved),
      200,
      'Operator komissiyasi yangilandi',
    );
  }

  /**
   * identity.market_operator.update_warehouse_access (XtcEyQjb) — market o'z
   * operatoriga «Ombordagi qoldiq»ni ko'rishni yoqadi/o'chiradi. Ko'lam
   * komissiya bilan bir xil: faqat MARKET, faqat o'z operatori (begona/yo'q —
   * 404). RMQ'da ValidationPipe yo'q — qiymat boolean bo'lmasa 400. Qiymat
   * o'zgarmasa ham javob qaytadi, jurnal yozilmaydi.
   */
  async updateMarketOperatorWarehouseAccess(
    id: string,
    marketId: string,
    dto: { can_view_warehouse_stock?: unknown },
    requester?: RequesterContext,
  ) {
    const scopedMarketId = this.resolveMarketOperatorScope(marketId, requester);
    const next = dto?.can_view_warehouse_stock;
    if (typeof next !== 'boolean') {
      this.badRequest(
        "can_view_warehouse_stock boolean (true/false) bo'lishi kerak",
      );
    }
    const operator = await this.findOwnMarketOperator(id, scopedMarketId);
    const before = operator.can_view_warehouse_stock === true;
    if (before === next) {
      return successRes(
        this.toMarketOperatorView(operator),
        200,
        "Operatorning ombor ruxsati o'zgarmadi",
      );
    }
    operator.can_view_warehouse_stock = next;
    const saved = await this.users.save(operator);
    await this.activityLog.log({
      entity_type: 'User',
      entity_id: saved.id,
      action: 'identity.market_operator_warehouse_access_changed',
      old_value: { can_view_warehouse_stock: before },
      new_value: { can_view_warehouse_stock: next },
      ...this.auditActor(requester),
      metadata: { market_id: scopedMarketId },
      description: ActivityDescribeUz.marketOperatorWarehouseAccessChanged(
        saved.id,
        next,
      ),
    });
    return successRes(
      this.toMarketOperatorView(saved),
      200,
      next
        ? "Operatorga ombor qoldig'ini ko'rish ruxsati berildi"
        : "Operatorning ombor qoldig'ini ko'rish ruxsati o'chirildi",
    );
  }

  /**
   * identity.market_operator.set_status (mFkrqvMi, ega qarori 2026-10-19
   * MO-S4) — market o'z operatorini nofaol qiladi yoki qayta faollashtiradi.
   * Ko'lam komissiya bilan bir xil: faqat MARKET, faqat o'z operatori
   * (begona / yo'q / o'chirilgan — 404, id mavjudligi oshkor qilinmaydi).
   *
   * - `inactive`: barcha sessiyalar yopiladi (`invalidateAllSessions` —
   *   refresh token tozalanadi, `session_epoch` oshadi; AYNI save). Login,
   *   refresh va Telegram bot aktori nofaol userni allaqachon rad etadi.
   * - `active`: market o'zi faol bo'lishi shart (bloklangan market operatorni
   *   «tiriltirib» blokni chetlab o'ta olmasin — yaratishdagi qoida).
   * - Buyurtmalar, komissiya va daromad tarixi TEGILMAYDI (faqat `status`).
   * - Holat o'zgarmasa — 200, jurnal yozilmaydi.
   * RMQ'da ValidationPipe yo'q — `status` faqat 'active' | 'inactive', aks
   * holda 400.
   */
  async setMarketOperatorStatus(
    id: string,
    marketId: string,
    dto: { status?: unknown },
    requester?: RequesterContext,
  ) {
    const scopedMarketId = this.resolveMarketOperatorScope(marketId, requester);
    const rawStatus = primitiveText(dto?.status).trim().toLowerCase();
    if (rawStatus !== Status.ACTIVE && rawStatus !== Status.INACTIVE) {
      this.badRequest("status noto'g'ri (active | inactive)");
    }
    const next = rawStatus as Status;

    const operator = await this.findOwnMarketOperator(id, scopedMarketId);
    const previous = operator.status;
    if (previous === next) {
      return successRes(
        this.toMarketOperatorView(operator),
        200,
        next === Status.ACTIVE
          ? 'Operator allaqachon faol'
          : 'Operator allaqachon nofaol',
      );
    }

    if (next === Status.ACTIVE) {
      const market = await this.users.findOne({
        where: { id: scopedMarketId, role: Roles.MARKET, isDeleted: false },
      });
      if (!market) {
        this.notFound('Market topilmadi');
      }
      if (market.status !== Status.ACTIVE) {
        this.forbidden(
          "Market bloklangan — operatorni faollashtirib bo'lmaydi",
        );
      }
    }

    operator.status = next;
    if (next !== Status.ACTIVE) {
      // Qurilma keyingi refresh'da chiqariladi (setUserStatus bilan AYNI).
      invalidateAllSessions(operator);
    }
    const saved = await this.users.save(operator);
    if (next !== Status.ACTIVE) {
      await this.revokeSessionsAfterSecurityChange(saved);
    }
    void this.syncUserToSearch(saved);
    await this.activityLog.log({
      entity_type: 'User',
      entity_id: saved.id,
      action: ActivityAction.STATUS_CHANGE,
      old_value: { status: previous },
      new_value: { status: saved.status },
      ...this.auditActor(requester),
      metadata: {
        market_id: scopedMarketId,
        reason: 'market_operator_status',
      },
      description: ActivityDescribeUz.marketOperatorStatusChanged(
        saved.id,
        saved.status === Status.ACTIVE,
      ),
    });
    return successRes(
      this.toMarketOperatorView(saved),
      200,
      saved.status === Status.ACTIVE
        ? 'Operator qayta faollashtirildi'
        : 'Operator nofaol qilindi',
    );
  }
}
