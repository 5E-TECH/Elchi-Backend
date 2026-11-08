import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import {
  Between,
  EntityManager,
  FindOptionsWhere,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';
import { lastValueFrom, timeout } from 'rxjs';
import { Post } from './entities/post.entity';
import { Region } from './entities/region.entity';
import { District } from './entities/district.entity';
import { DistrictCoverageExemption } from './entities/district-coverage-exemption.entity';
import {
  OPEN_CUSTODY_MAX_DISTRICT_IDS,
  OPEN_CUSTODY_PAGE_LIMIT,
  computeCoverageExemptions,
  coverageExemptionCandidateBranchIds,
  coverageExemptionDeleteQuery,
  coverageExemptionInsertQuery,
  coverageExemptionRetargetQuery,
  parseOpenCustodyPage,
  summarizeCoverageExemptions,
  type CoverageExemption,
  type CreatedCoverageExemption,
  type OpenCustodyRow,
} from './coverage/district-coverage-exemption';
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
import { findSatoRegionFor, matchDistricts } from './utils/sato-matcher';
import {
  assessHqCourierScan,
  SCAN_ASSIGN_MESSAGES,
} from './utils/scan-assign-eligibility';
import { LogisticsNotificationService } from './notification/logistics-notification.service';
import {
  ActivityAction,
  ActivityLogService,
  ActivityLogQuery,
  BranchType,
  type CoverageDistrict,
  courierPostOrdersQuery,
  COURIER_LIST_HIDDEN_STATUSES,
  effectiveDistrictRegionId,
  effectiveOrderRegionId,
  districtServingBranchId,
  isCourierScanTakenOrder,
  isHqBranch,
  isOrderServedByBranch,
  fetchScanOrderSummaries,
  Order_status,
  POST_RECEIVED_TRACKING_NOTES,
  Post_status,
  Roles,
  Status,
  Where_deliver,
  endOfTashkentDay,
  startOfTashkentDay,
  tashkentDayRange,
  type PostReceiveKind,
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
  /** initiate-return (marketga qaytarish) sababi — «kelmagan» so'rovida yo'q. */
  return_reason?: string | null;
  post_id?: string | null;
  canceled_post_id?: string | null;
  branch_id?: string | null;
  holder_type?: 'HQ' | 'BRANCH' | 'COURIER' | null;
  holder_branch_id?: string | null;
  holder_courier_id?: string | null;
  home_branch_id?: string | null;
  courier_id?: string | null;
  assigned_at?: string | Date | null;
  last_handover_by?: string | null;
  region_id?: string | null;
  district_id?: string | null;
  customer_id?: string;
  where_deliver?: Where_deliver;
  qr_code_token?: string | null;
  current_batch_id?: string | null;
  // order-service Order_source: 'internal' | 'external' | 'branch'.
  source?: string | null;
  /** T8: maxsus belgilar (order-service ustuni). */
  special_categories?: string[] | null;
}

interface CourierRow {
  id: string;
  region_id?: string | null;
  role?: string;
}

interface BranchAssignmentRow {
  branch_id?: string | null;
  role?: string | null;
  /** `branch.user.find_by_user` filial qatorini ham qaytaradi (o'chirilgan — null). */
  branch?: unknown;
}

/**
 * Tuman qamrovi tekshiruvi uchun filial qatori (`isOrderServedByBranch`):
 * id, tur (katta harf), viloyat va holat (kichik harf).
 */
interface BranchCoverageRow {
  id: string;
  type: string | null;
  region_id: string | null;
  status: string | null;
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

/**
 * order-service `RETURN_REQUEST_REVIEW_CONFLICT_REASON`: tasdiq/rad yozuvi
 * qulf ostida mos kelmadi (shu orada qabul qilingan yoki ko'rib chiqilgan) —
 * eskirgan tanlov, o'tkazib yuboriladi.
 */
const RETURN_REQUEST_REVIEW_CONFLICT_REASON = 'return_request_review_conflict';
/**
 * order-service `POST_RECEIVE_CONFLICT_REASON`: qabul yozuvi qulf ostida mos
 * kelmadi (buyurtma shu orada pochtadan chiqqan).
 */
const POST_RECEIVE_CONFLICT_REASON = 'post_receive_conflict';

/**
 * Skaner bilan qabul (2026-11-07, `PATCH post/receive/:id` `scan: true`):
 * qabul qilinadigan (yo'ldagi) holatlar. «Mijoz kutilmoqda» ham kuryer
 * qo'lida hali rasman qabul qilinmagan posilka (`releaseCourierPostAfterMove`
 * kabi yo'ldagi deb hisoblanadi).
 */
const POST_SCAN_RECEIVABLE_STATUSES: ReadonlySet<string> = new Set<string>([
  Order_status.ON_THE_ROAD,
  Order_status.WAITING_CUSTOMER,
]);

/**
 * Pochta qabulida «kutilmoqda» (WAITING) ga QAYTARILMAYDIGAN holatlar —
 * sotuvdan / bekordan keyingi hammasi. Holat mashinasi SOLD/PAID/... →
 * WAITING ga (rollback uchun) ruxsat beradi, lekin qabul pul oyoqlari qolgan
 * buyurtmani «kutilmoqda» ga qaytarmasligi kerak.
 */
const POST_RECEIVE_BLOCKED_STATUSES: ReadonlySet<string> = new Set<string>([
  Order_status.SOLD,
  Order_status.PARTLY_PAID,
  Order_status.PAID,
  Order_status.CANCELLED,
  Order_status.CANCELLED_SENT,
  Order_status.CLOSED,
  Order_status.RETURNED_TO_MARKET,
]);

/** Skan-qabul ketma-ketligi: `pg_advisory_xact_lock(hashtext('post_receive:<id>'))`. */
const POST_SCAN_RECEIVE_LOCK_PREFIX = 'post_receive:';
/** Qulf kutish chegarasi — gateway `timeout(8000)` dan oldin (`SET LOCAL lock_timeout`). */
const POST_SCAN_RECEIVE_LOCK_TIMEOUT = '7s';
/** Shu pochtaning boshqa skani 7 s dan ortiq qulfni ushlab turdi — 409. */
export const POST_SCAN_RECEIVE_BUSY_MESSAGE =
  'Pochta boshqa skan bilan band — qayta skanerlang';

/** Postgres `lock_not_available` (55P03) — `lock_timeout` tugadi. */
const isLockNotAvailableError = (err: unknown): boolean => {
  const e = err as {
    code?: unknown;
    driverError?: { code?: unknown };
  } | null;
  return e?.code === '55P03' || e?.driverError?.code === '55P03';
};

/** Skan-qabul: buyurtma shu pochtada emas — 400 `order_not_in_post`. */
export const POST_SCAN_ORDER_NOT_IN_POST_MESSAGE =
  'Bu buyurtma shu pochtada emas';
/** Skan-qabul: buyurtma yo'lda emas (sotilgan, bekor ...) — 400 `order_not_receivable`. */
export const POST_SCAN_ORDER_NOT_RECEIVABLE_MESSAGE =
  "Buyurtma yo'lda emas — qabul qilib bo'lmaydi";

/** `assertPostReceiveAccess` natijasi — bulk va skan qabul yo'llari uchun. */
interface PostReceiveAccess {
  requesterIsCourier: boolean;
  isBranchTransferPost: boolean;
  isPrivileged: boolean;
  scopedBranchId: string | null;
  belongsToScopedBranch: boolean;
}

/** `processScanReceive` natijasi (qulf ostidagi qism → javob va jurnal). */
interface ScanReceiveOutcome {
  post: Post;
  access: PostReceiveAccess;
  targetBranchId: string | undefined;
  received: string[];
  alreadyReceived: string[];
  notReceived: string[];
  failures: Array<{ order_id: string; error: string }>;
  /** Pochtada hamon yo'ldagilar; qayta o'qish yiqilsa `null`. */
  remainingCount: number | null;
  postStatusBefore: Post_status;
  /** Pochta qatori yozildimi (status / branch_id o'zgardi). */
  postWritten: boolean;
  orderCount: number;
}

/** findOrders ning odatiy order.find_all kutish vaqti. */
const FIND_ORDERS_TIMEOUT_MS = 5000;

/**
 * Pochta tarixi (`order.post_membership.find`) kutish vaqti. Joriy a'zolar
 * so'rovi bilan PARALLEL ketadi.
 */
const POST_MEMBERSHIP_TIMEOUT_MS = 3000;
/**
 * order-service `POST_MEMBERSHIP_MAX_ROWS`: shuncha qator kelsa tarix
 * kesilgan — `history_incomplete: true`.
 */
const POST_MEMBERSHIP_MAX_ROWS = 20_000;
/** Sobiq a'zolarni `order.find_all` ga bir so'rovda nechtadan berish. */
const POST_HISTORY_ORDER_CHUNK = 1000;
/**
 * Sobiq a'zolar soni chegarasi (shartnoma: 5000) — ortig'i olinmaydi,
 * `history_incomplete: true`. Ko'pi bilan 5 ta parallel `order.find_all`.
 */
const POST_HISTORY_MAX_ORDERS = 5000;
/**
 * `all` ko'rinishi: `getPostOrders` boshidan sobiq a'zolar so'rovi tugashi
 * kerak bo'lgan payt (gateway `GET /post/orders/:id` — 8 s). Sobiq a'zolar
 * `order.find_all` i qolgan vaqtni oladi (ko'pi bilan ..._MAX_TIMEOUT_MS);
 * ..._MIN_TIMEOUT_MS dan kam qolsa so'ralmaydi — `history_incomplete: true`.
 */
const POST_HISTORY_BUDGET_MS = 6500;
const POST_HISTORY_ORDERS_MAX_TIMEOUT_MS = 2500;
const POST_HISTORY_ORDERS_MIN_TIMEOUT_MS = 500;
/**
 * Ruxsat faqat pochta tarixi orqali bo'lishi mumkin edi, lekin tarix olinmadi
 * (javob kelmadi / byudjet tugadi / kesildi) — 403 emas, qayta urinsa
 * bo'ladigan 503 (ma'lumot berilmaydi — fail-closed).
 */
export const POST_HISTORY_UNAVAILABLE_MESSAGE =
  "Pochta tarixi vaqtincha olinmadi, qayta urinib ko'ring";

/**
 * Sof kuryerning o'z eski pochtasi (`all` — JSON, Excel, chek): sobiq a'zo
 * hozir BOSHQA kuryerda bo'lsa (`courier_id` / `holder_courier_id` o'zi
 * emas), qatordan o'sha kuryerning shaxsi va puli olib tashlanadi. Buyurtma
 * o'zi (id, QR, mijoz, manzil, tuman, summa, holat, a'zolik, hozirgi pochta)
 * qoladi — kuryer buyurtma qayerga ketganini ko'radi. Market tarifi / filial
 * ulushini gateway kuryer proyeksiyasi (COURIER_HIDDEN_ORDER_FIELDS) oladi.
 */
export const FOREIGN_COURIER_ORDER_FIELDS: readonly string[] = [
  // Boshqa kuryer shaxsi va unga o'tish izi.
  'courier_id',
  'holder_courier_id',
  'assigned_at',
  'last_handover_at',
  'last_handover_by',
  // Boshqa kuryer haqi, sotuv/hisob-kitob summalari va sotuv isboti.
  'courier_tariff',
  'courier_share',
  'to_be_paid',
  'paid_amount',
  'sale_collectible_amount',
  'sale_market_paid_amount',
  // Narx tushirib qisman sotuvdagi asl summa — sotuv summalari bilan bir qatorda.
  'partly_sell_original_total_price',
  'branch_cashbox_amount',
  'extra_cost',
  'proof_files',
];

/**
 * Eski pochta ko'rinishi: `current` — faqat hozir pochtada turgan buyurtmalar
 * (skan/qabul ekranlari); `all` — pochtaga HAR QACHON kirgan buyurtmalar
 * (`order_schema.post_order_memberships` ∪ joriy ko'rsatkichlar).
 */
export type PostOrdersView = 'current' | 'all';

/** `order.post_membership.find` qatori (order-service shartnomasi). */
interface PostMembershipRow {
  order_id: string;
  post_id: string;
  kind: 'DELIVERY' | 'CANCELED';
  joined_at: string | Date;
  left_at: string | Date | null;
  next_post_id: string | null;
}

/**
 * Sukut: qabul qilingan (RECEIVED / CANCELED_RECEIVED) — eski pochta, `all`;
 * qolganlari (NEW / SENT / CANCELED) — `current`.
 */
export function defaultPostOrdersView(status: Post_status): PostOrdersView {
  return status === Post_status.RECEIVED ||
    status === Post_status.CANCELED_RECEIVED
    ? 'all'
    : 'current';
}

/** Qatordagi a'zolik: birinchi kirgan, oxirgi chiqqan payt va keyingi pochta. */
interface PostMembershipSummary {
  joined_at: string | Date | null;
  left_at: string | Date | null;
  next_post_id: string | null;
}

/** Saralash uchun vaqt (ms); yaroqsiz — 0. */
function postMembershipTime(value: string | Date | null | undefined): number {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : 0;
}

const REGION_STATS_DELIVERED_STATUSES = new Set<Order_status>([
  Order_status.SOLD,
  Order_status.PAID,
  Order_status.PARTLY_PAID,
]);
const REGION_STATS_CANCELLED_STATUSES = new Set<Order_status>([
  Order_status.CANCELLED,
  Order_status.CANCELLED_SENT,
]);

/**
 * Hudud statistikasi qatori (viloyat / tuman / kuryer): jami, yetkazilgan
 * (sold / paid / partly_paid — tushum shulardan), bekor, kutilayotgan
 * (qolgani) va muvaffaqiyat foizi.
 */
function summarizeRegionOrders(rows: readonly OrderRow[]) {
  let totalOrders = 0;
  let deliveredOrders = 0;
  let cancelledOrders = 0;
  let totalRevenue = 0;

  for (const order of rows) {
    totalOrders += 1;
    const status = order.status;
    const price = Number(order.total_price ?? 0);

    if (status && REGION_STATS_DELIVERED_STATUSES.has(status)) {
      deliveredOrders += 1;
      totalRevenue += Number.isFinite(price) ? price : 0;
    }

    if (status && REGION_STATS_CANCELLED_STATUSES.has(status)) {
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
}

/**
 * X4RzXk1H — pochta QR'ini skanerlay oladigan rollar (`logistics.post.find_by_scan`):
 * gateway `GET /post/scan/:id` `@Roles` va `GET /scan/:token` (`POST-`) dagi
 * ro'yxat bilan BIR XIL. Market, mijoz, operator, investor, logist — 403
 * (ilgari market ham pochta qatorini to'liq olardi).
 */
export const POST_SCAN_ROLES: readonly string[] = [
  Roles.SUPERADMIN,
  Roles.ADMIN,
  Roles.BRANCH,
  Roles.MANAGER,
  Roles.REGISTRATOR,
  Roles.COURIER,
];
export const POST_SCAN_FORBIDDEN_MESSAGE = "Bu pochtani ko'rishga ruxsat yo'q";

/**
 * Z3pUOxou — logist o'z doirasini mavjud rol qoidasi bilan almashtirmasin:
 * shu rollardan biri bo'lsa o'sha rolning qoidasi ustun (JWT'da bitta rol).
 */
const ROLES_WITH_OWN_POST_SCOPE: readonly string[] = [
  Roles.SUPERADMIN,
  Roles.ADMIN,
  Roles.BRANCH,
  Roles.MANAGER,
  Roles.REGISTRATOR,
  Roles.COURIER,
  Roles.MARKET,
  Roles.MARKET_OPERATOR,
  Roles.CUSTOMER,
];
/**
 * Pochta buyurtmalari: shu rollardan biri bo'lsa so'rovchi "sof kuryer"
 * emas — kuryerning "faqat o'z pochtasi" qoidasi unga qo'llanmaydi.
 */
const COURIER_STAFF_ROLES: readonly string[] = [
  Roles.SUPERADMIN,
  Roles.ADMIN,
  Roles.BRANCH,
  Roles.MANAGER,
  Roles.REGISTRATOR,
];
export const LOGIST_REGION_FILTER_MESSAGE = 'Bu viloyat sizga biriktirilmagan';
export const LOGIST_POST_FORBIDDEN_MESSAGE =
  "Bu pochta sizga biriktirilgan viloyatda emas — ko'rishga ruxsat yo'q";

/**
 * anKpzwxk (ega qarori, 2026-11-03) — viloyat qamrovi, qabul va ko'rinish
 * qoidalarining rad javoblari. Mashina kodi `details.reason` da (gateway faqat
 * reason/usage/details ni o'tkazadi).
 *
 * 2-band: chiquvchi partiyadagi (`current_batch_id`) buyurtma kuryerga
 * berilmaydi — 409 `order_in_outgoing_batch`.
 */
export const ORDER_IN_OUTGOING_BATCH_MESSAGE =
  'Buyurtma chiquvchi partiyada — kuryerga berilmaydi (avval partiyadan chiqaring)';
/**
 * 4-band: HQ → filial o'tkazma pochtasini (courier_id '0') faqat manzil
 * filial MENEJERI qabul qiladi — 403 `post_receive_manager_only`.
 */
export const POST_RECEIVE_MANAGER_ONLY_MESSAGE =
  'Bu pochtani faqat manzil filial menejeri qabul qila oladi';
/**
 * «Bu buyurtma kelmagan — qaytarish so'rovi» (egasi talabi 2026-11-04): kuryer
 * — faqat o'z SENT pochtasida, filial menejeri — faqat o'z filialiga
 * jo'natilgan SENT o'tkazma pochtasida (courier_id '0'). Qolgan hamma (filial
 * registratori, filial akkaunti, boshqa filial menejeri, market...) — 403
 * `return_request_not_allowed`.
 */
export const RETURN_REQUEST_NOT_ALLOWED_MESSAGE =
  "«Bu buyurtma kelmagan» so'rovini faqat o'z pochtasidagi kuryer yoki pochta jo'natilgan filial menejeri yubora oladi";
/**
 * 5-band: sof kuryerga hali qabul qilinmagan filial o'tkazmasi (courier_id
 * '0', SENT) ko'rinmaydi — 403 `post_not_visible_to_courier`.
 */
export const POST_NOT_VISIBLE_TO_COURIER_MESSAGE =
  "Bu pochta hali filialga qabul qilinmagan — kuryerga ko'rinmaydi";
/**
 * 5-band: «Yangi pochtalar» faqat HQ uchun (SUPERADMIN, ADMIN, HQ filialiga
 * biriktirilgan REGISTRATOR / MANAGER) — 403 `new_posts_hq_only`.
 */
export const NEW_POSTS_HQ_ONLY_MESSAGE =
  "«Yangi pochtalar» faqat HQ xodimlari uchun — ko'rishga ruxsat yo'q";
/**
 * 5-band: «Yangi pochtalar» ruxsatini tekshirib bo'lmadi (branch-service
 * javob bermadi) — 503, qayta urinish (403 ruxsat xatosi EMAS).
 */
export const NEW_POSTS_ACCESS_UNAVAILABLE_MESSAGE =
  "«Yangi pochtalar» ruxsatini tekshirib bo'lmadi (filial xizmati javob bermadi) — birozdan so'ng qayta urinib ko'ring";

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
type GeoCounts = {
  orders: number;
  users: number;
  branches: number;
  /** `order_schema.branch_transfer_batches.target_region_id` — faqat viloyat. */
  transfer_batches: number;
};
/**
 * Asosiy maydonlar — faqat O'CHIRILMAGAN yozuvlar (himoya shularga qaraydi).
 *
 * oNAE3LW9 (2026-10-09 prod, 2-tur): ilgari o'chirilganlar ham sanalardi —
 * TEST buyurtma o'chirilgandan keyin ham tuman "1 ta buyurtma bor" deb 400
 * qaytarardi, foydalanuvchi esa uni ko'rmaydi (404) va ko'chira olmaydi.
 * `deleted` — o'chirilgan (`is_deleted` / `deleted_at`) yozuvlar: o'chirishni
 * TO'SMAYDI, lekin birlashtirishda ular ham ko'chadi va tasdiqlash (A bo'sh,
 * B = eski B + ko'chgan) JAMI (tirik + o'chirilgan) bo'yicha qilinadi.
 */
type GeoUsage = GeoCounts & { deleted: GeoCounts };
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
  /**
   * (vsmpTweI) Ko'chgan ID'lardan TIRIK (o'chirilmagan) lari soni — servis
   * ko'chirish qadamining o'zida sanaydi (`moved_live`). `null` — eski servis
   * qaytarmadi.
   */
  live: number | null;
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
/** (Z1c1sNPT) Xato `data.details.stranded_order_ids` dagi ID'lar soni (FE «№…» ro'yxati). */
const GEO_STRANDED_DETAILS_IDS = 10;

/**
 * (tf324cXN) Birlashtirish bekor bo'lish sababi — mashina kodi. Xato
 * `data.reason` va `data.details.reason` da (gateway `publicErrorData` orqali
 * FE'ga o'tadi), FE «Sabab» qatorini matnni parse qilmasdan quradi.
 *  - `count_mismatch`   — tekshiruv mos kelmadi (`details.mismatches`);
 *  - `remote_refused`   — servis xato qaytardi / ulanib bo'lmadi;
 *  - `timeout`          — servis `details.timeout_ms` ichida javob bermadi;
 *  - `invalid_response` — servis javobi noto'g'ri (ID'lar yo'q);
 *  - `delete_failed`    — A ni o'chirish/qayta sanash yiqildi.
 */
type GeoMergeFailureReason =
  | 'count_mismatch'
  | 'remote_refused'
  | 'timeout'
  | 'invalid_response'
  | 'delete_failed';
/**
 * (tf324cXN) Tekshiruvdagi bitta nomuvofiqlik: `source` — A da qoldiq
 * (kutilgan 0), `target` — B jami ≠ eski B + ko'chirilgan. Sonlar JAMI
 * (tirik + o'chirilgan) — tekshiruv shu bo'yicha.
 */
type GeoMergeMismatch = {
  kind: GeoMoveKind;
  district: 'source' | 'target';
  expected: number;
  actual: number;
};
/** (tf324cXN) `abortDistrictMerge` ga sabab: kod, qadam va qo'shimcha sonlar. */
type GeoMergeFailure = {
  reason: GeoMergeFailureReason;
  /** Qaysi qadam (`count_mismatch` — birinchi nomuvofiqlik turi); `null` — qadamsiz. */
  kind: GeoMoveKind | null;
  mismatches?: GeoMergeMismatch[];
  timeout_ms?: number;
};

/** oNAE3LW9 — birlashtirish tekshiruvi mos kelmadi (logistics tranzaksiyasi rollback). */
class GeoMergeCheckError extends Error {
  /** (tf324cXN) Matn shu strukturadan yasalgan. */
  constructor(
    message: string,
    readonly mismatches: GeoMergeMismatch[],
  ) {
    super(message);
  }
}

/**
 * kA70Rban — pochta ro'yxatlarining (GET /post, /post/courier/old-posts,
 * kuryerning barcha pochtalari) bitta sahifadagi qator shifti. So'ralgan
 * limit undan katta bo'lsa — JIMGINA kesilmaydi: javobda
 * `limit_capped: true` va `max_limit` qaytadi.
 */
export const POST_LIST_MAX_LIMIT = 100;

/**
 * YfrqN70i — "Eski pochtalar" filtrlari (server tomonda). Hammasi ixtiyoriy;
 * bo'sh qiymat = filtr yo'q.
 * - `region_id` / `courier_id` — bigint id. Raqam emas (masalan UUID) —
 *   hech narsaga mos kelmaydi → bo'sh sahifa (avval jimgina tashlanib, 59 ta
 *   qaytardi);
 * - `startDate` / `endDate` — Toshkent kuni bo'yicha (tashkentDayRange,
 *   SqVMuhKo bilan bitta qoida): 'YYYY-MM-DD' → 00:00:00.000 / 23:59:59.999;
 * - `has_orders` — faqat `order_quantity > 0` (frontenddagi hasOrders
 *   filtrini serverga ko'chirish uchun; sahifalash va `total` to'g'ri qoladi).
 */
export interface PostListFilters {
  branch_id?: string;
  status?: string;
  region_id?: string;
  courier_id?: string;
  startDate?: string;
  endDate?: string;
  has_orders?: boolean | string;
}

/** kA70Rban — sahifa/limit normallashuvi (NaN → standart, shiftdan oshsa belgi). */
function resolvePostListPage(page?: number, limit?: number) {
  const requestedLimit = Math.trunc(Number(limit));
  const normalizedLimit = Number.isFinite(requestedLimit) ? requestedLimit : 8;
  const take = Math.min(POST_LIST_MAX_LIMIT, Math.max(1, normalizedLimit));
  const requestedPage = Math.trunc(Number(page));
  const currentPage = Number.isFinite(requestedPage)
    ? Math.max(1, requestedPage)
    : 1;
  return {
    take,
    skip: (currentPage - 1) * take,
    page: currentPage,
    limit_capped: normalizedLimit > POST_LIST_MAX_LIMIT,
  };
}

/**
 * (tveJKICY) Pochta ro'yxati yig'indilari — JORIY FILTR bo'yicha (barcha
 * sahifalar, sahifalashsiz): `orders_total` — pochtalardagi buyurtmalar soni
 * (`order_quantity`) jami, `amount_total` — pochta summalari
 * (`post_total_price`) jami, so'm.
 */
export type PostListTotals = { orders_total: number; amount_total: number };

const EMPTY_POST_LIST_TOTALS: PostListTotals = {
  orders_total: 0,
  amount_total: 0,
};

/** kA70Rban — sahifalangan pochta ro'yxati javobi (`limit_capped` bilan). */
function postListPage(
  data: unknown[],
  total: number,
  paging: ReturnType<typeof resolvePostListPage>,
  // (tveJKICY) faqat GET /post va /post/courier/old-posts beradi.
  totals?: PostListTotals,
) {
  return {
    data,
    total,
    page: paging.page,
    totalPages: Math.max(1, Math.ceil(total / paging.take)),
    limit: paging.take,
    limit_capped: paging.limit_capped,
    max_limit: POST_LIST_MAX_LIMIT,
    ...(totals ?? {}),
  };
}

function isTruthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

/** T9 (BE-2): «Qayerdan» so'rovlari — tizim so'rovchisi (doira tekshiruvisiz). */
const SENDER_BRANCH_SYSTEM_REQUESTER = {
  id: 'system',
  roles: [Roles.SUPERADMIN],
};
const SENDER_BRANCH_TIMEOUT_MS = 5000;
const HQ_BRANCH_SUMMARY_TTL_MS = 5 * 60 * 1000;

/** Filial obyektidan faqat `{ id, name }`; yaroqsiz — `null`. */
function branchSummaryOf(value: unknown): { id: string; name: string } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const { id, name } = value as { id?: unknown; name?: unknown };
  const branchId =
    typeof id === 'string' || typeof id === 'number' ? String(id).trim() : '';
  const branchName = typeof name === 'string' ? name.trim() : '';
  return branchId && branchName ? { id: branchId, name: branchName } : null;
}

/** Filial obyektidan qamrov qatori; id yaroqsiz — `null`. */
function branchCoverageRowOf(value: unknown): BranchCoverageRow | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const row = value as {
    id?: unknown;
    type?: unknown;
    region_id?: unknown;
    status?: unknown;
  };
  const id = canonicalBigintId(row.id);
  if (!id) {
    return null;
  }
  const text = (raw: unknown) =>
    typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  return {
    id,
    type: text(row.type)?.toUpperCase() ?? null,
    region_id: canonicalBigintId(row.region_id),
    status: text(row.status)?.toLowerCase() ?? null,
  };
}

/** Qamrov rad javobidagi xabarda ko'rsatiladigan buyurtma id'lari soni. */
const COVERAGE_MESSAGE_ORDER_IDS = 10;

/** Rad xabaridagi id ro'yxati: `#12, #13` (+ «va yana N ta»). */
function coverageOrderIdList(orderIds: readonly string[]): string {
  const shown = orderIds
    .slice(0, COVERAGE_MESSAGE_ORDER_IDS)
    .map((id) => `#${id}`)
    .join(', ');
  const rest = orderIds.length - COVERAGE_MESSAGE_ORDER_IDS;
  return `${shown}${rest > 0 ? ` va yana ${rest} ta` : ''}`;
}

/**
 * anKpzwxk — rad javobining `data` si: mashina kodi `reason`, maydonlar
 * (`order_ids`, `post_id`, `branch_id`) esa `details` ichida — gateway
 * (`publicErrorData`) faqat reason/usage/details ni o'tkazadi, yuqori
 * darajadagi maydonlarni tashlab yuboradi. Yuqori darajadagi nusxalar — RPC
 * darajasidagi iste'molchilar uchun (avvalgi shakl).
 */
function rejectionData<T extends Record<string, string | string[] | null>>(
  reason: string,
  fields: T,
): T & { reason: string; details: T } {
  return { ...fields, reason, details: { ...fields } };
}

/**
 * Tuman qamrovi imtiyozlari (ega qarori, 2026-11-02): ko'chishdan oldin
 * `order.open_custody_by_district` sahifalab o'qiladi. Bir sahifa kutish
 * vaqti; jami sahifalar chegarasi (oshsa — fail-closed, 503); bitta INSERT
 * dagi qatorlar soni.
 */
const COVERAGE_CUSTODY_TIMEOUT_MS = 5000;
const COVERAGE_CUSTODY_MAX_PAGES = 100;
const COVERAGE_EXEMPTION_INSERT_CHUNK = 1000;
export const COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE =
  "Tuman buyurtmalarini tekshirib bo'lmadi — birozdan so'ng qayta urinib ko'ring";

/** Imtiyozni qaysi amal yozdi (`district_coverage_exemptions.source`). */
type CoverageExemptionSource =
  | 'district_update'
  | 'set_serving_branch'
  | 'clear_serving_branch'
  | 'district_merge';

/**
 * Bitta tuman ko'chishi: `district_id` dagi buyurtmalar uchun qamrov
 * `before` qatoridan `after` qatoriga o'tadi. `target_district_id` —
 * ko'chishdan KEYINGI buyurtma tumani (imtiyozda saqlanadi; birlashtirishda
 * B), yo'q — `district_id`. `order_ids` — faqat shu buyurtmalar
 * (birlashtirishdan keyingi qayta snapshot: A dan B ga ko'chganlar).
 */
interface CoverageDistrictMove {
  district_id: string;
  before: CoverageDistrict;
  after: CoverageDistrict;
  target_district_id?: string;
  order_ids?: ReadonlySet<string>;
}

/**
 * anKpzwxk: qamrov — viloyat qoidasi, shuning uchun imtiyoz FAQAT tumanning
 * XIZMAT viloyati (`assigned_region ?? region_id`) o'zgargan ko'chishda
 * paydo bo'ladi. Faqat `serving_branch_id` o'zgarishi (PUT
 * /branches/:id/districts, filial o'chirilganda bo'shatish) imtiyoz bermaydi
 * — custody o'qilmaydi, order-service ishlamasa ham 503 bo'lmaydi.
 */
const regionChangingCoverageMoves = (
  moves: readonly CoverageDistrictMove[],
): CoverageDistrictMove[] =>
  moves.filter(
    (move) =>
      effectiveDistrictRegionId(move.before) !==
      effectiveDistrictRegionId(move.after),
  );

/**
 * Ko'chishdan OLDIN o'qilgan custody: so'ralgan tumanlar, ularning ochiq
 * buyurtmalari va mas'ul filial qatorlari (noma'lum filial — `null`).
 */
interface CoverageCustody {
  district_ids: ReadonlySet<string>;
  rows: OpenCustodyRow[];
  branchesById: Map<string, BranchCoverageRow | null>;
}

/**
 * Ko'chishdan oldingi va keyingi (qayta) snapshot natijalari birga — javob
 * va audit soni uchun. Hech biri bajarilmagan (`null`) — `null`.
 */
function combineCoverageCreated(
  ...runs: Array<CreatedCoverageExemption[] | null>
): CreatedCoverageExemption[] | null {
  const done = runs.filter(
    (run): run is CreatedCoverageExemption[] => run !== null,
  );
  return done.length ? done.flat() : null;
}

/** `rehomeOpenDistrictOrders` javobi (`logistics.district.rehome_open_orders`). */
interface DistrictRehomeResult {
  district_id: string;
  target_region_id: string;
  moved: number;
  order_ids: string[];
  from_post_ids: string[];
  /** Asosiy maqsad pochta (bir nechta bo'lsa — birinchisi; hech narsa ko'chmasa — null). */
  to_post_id: string | null;
  /** Barcha maqsad pochtalar (manba pochtalar filial o'lchovi har xil bo'lsa — bir nechta). */
  to_post_ids: string[];
  /** Ko'chirishdan keyin bo'shab, o'chirilgan manba NEW pochtalar. */
  deleted_post_ids: string[];
  skipped: Array<{ order_id: string; reason: string }>;
}

/** `rehomeDistrictOpenOrders` — bitta buyurtma ko'chishi (kompensatsiya uchun). */
interface DistrictRehomeMove {
  id: string;
  fromPostId: string;
  toPostId: string;
}

/**
 * HQ NEW pochtasidagi buyurtmani boshqa hudud NEW pochtasiga ko'chirib
 * bo'lmasligi sababi (`null` — ko'chiriladi): faqat qabul qilingan
 * (RECEIVED), o'chirilmagan, partiyada emas va kuryerda emas. HQ ombori
 * (LC-03) sharti alohida — `LogisticsServiceService.districtRehomeOrderSkipReason`.
 */
function districtRehomeSkipReason(order: OrderRow): string | null {
  const row = order as OrderRow & {
    isDeleted?: boolean;
    is_deleted?: boolean;
    deleted_at?: unknown;
  };
  if (row.isDeleted === true || row.is_deleted === true || row.deleted_at) {
    return 'deleted';
  }
  const status = String(order.status ?? '')
    .trim()
    .toLowerCase();
  if (status !== String(Order_status.RECEIVED)) {
    return 'status_not_received';
  }
  if (String(order.current_batch_id ?? '').trim()) {
    return 'in_transfer_batch';
  }
  const hasCourierRef = (value: string | null | undefined) => {
    const id = String(value ?? '').trim();
    return !!id && id !== '0';
  };
  if (
    hasCourierRef(order.courier_id) ||
    hasCourierRef(order.holder_courier_id) ||
    String(order.holder_type ?? '')
      .trim()
      .toUpperCase() === 'COURIER'
  ) {
    return 'held_by_courier';
  }
  return null;
}

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
    // Tuman qamrovi imtiyozlari (migratsiya 1716000000203). Ixtiyoriy va
    // OXIRGI: eski spec'lar servisni 8–9 argument bilan quradi — u holda
    // imtiyoz yozilmaydi va qamrov tekshiruvi avvalgidek.
    @Optional()
    @InjectRepository(DistrictCoverageExemption)
    private readonly coverageExemptionRepo?: Repository<DistrictCoverageExemption>,
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

  private notFound(message: string, data?: unknown): never {
    throw new RpcException(errorRes(message, 404, data));
  }

  /**
   * `data` — ixtiyoriy, mashina uchun tafsilot (`errorRes` ning 3-maydoni).
   * Berilmasa — avvalgidek `data: null`.
   */
  private badRequest(message: string, data?: unknown): never {
    throw new RpcException(errorRes(message, 400, data));
  }

  private forbidden(message: string, data?: unknown): never {
    throw new RpcException(errorRes(message, 403, data));
  }

  private conflict(message: string, data?: unknown): never {
    throw new RpcException(errorRes(message, 409, data));
  }

  /** Postgres unique violation (23505) — poyga holatidagi takroriy qiymat. */
  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: unknown; driverError?: { code?: unknown } };
    return e?.code === '23505' || e?.driverError?.code === '23505';
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

  /** Z3pUOxou — sof logist (boshqa doirali rolsiz) so'rovchi. */
  /** Sof kuryer: COURIER roli bor, filial/tizim xodimi rollaridan hech biri yo'q. */
  private isPureCourierRequester(requester?: RequesterContext): boolean {
    const roles = (requester?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    return (
      roles.includes(Roles.COURIER) &&
      !roles.some((role) => COURIER_STAFF_ROLES.includes(role))
    );
  }

  /**
   * anKpzwxk (ega qarori, 5-band): sof kuryerga hali qabul qilinmagan filial
   * o'tkazmasi (courier_id '0' / bo'sh, SENT) ko'rinmaydi — to'g'ridan-to'g'ri
   * ochish (`GET /post/:id`, `GET /post/orders/:id`, pochta QR skani) ham
   * 403 `post_not_visible_to_courier`. Filial qabul qilgach (RECEIVED) —
   * avvalgi filial doirasi.
   */
  private assertPostVisibleToCourier(
    post: Pick<Post, 'id' | 'courier_id' | 'status'>,
    requester?: RequesterContext,
  ): void {
    if (!requester || !this.isPureCourierRequester(requester)) {
      return;
    }
    const courierId = String(post.courier_id ?? '').trim();
    if ((!courierId || courierId === '0') && post.status === Post_status.SENT) {
      this.forbidden(
        POST_NOT_VISIBLE_TO_COURIER_MESSAGE,
        rejectionData('post_not_visible_to_courier', {
          post_id: String(post.id),
        }),
      );
    }
  }

  private isLogistRequester(requester?: RequesterContext): boolean {
    const roles = (requester?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    return (
      roles.includes(Roles.LOGIST) &&
      !roles.some((role) => ROLES_WITH_OWN_POST_SCOPE.includes(role))
    );
  }

  /**
   * Z3pUOxou — logist pochtasi: `post.region_id` o'ziga biriktirilgan
   * viloyatlardan biri bo'lmasa 403 (viloyatsiz pochta ham — 403).
   */
  private async assertLogistPostRegion(
    post: { region_id?: string | null },
    requester: RequesterContext,
  ): Promise<void> {
    const regionIds = (await this.findLogistRegions(requester.id)).map(
      (region) => region.id,
    );
    const postRegionId = canonicalBigintId(post?.region_id ?? '');
    if (!postRegionId || !regionIds.includes(postRegionId)) {
      this.forbidden(LOGIST_POST_FORBIDDEN_MESSAGE);
    }
  }

  /** Z3pUOxou — logistga pochta qatori pulsiz (`post_total_price` yo'q). */
  private withoutPostMoney<T extends object>(post: T): T {
    const copy = { ...post } as Record<string, unknown>;
    delete copy.post_total_price;
    return copy as T;
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
      throw new RpcException(
        errorRes(`Buyurtma #${id} ma'lumotini olib bo'lmadi`, 502),
      );
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

  /**
   * Kuryer pochtasi uchun CANCELLED_SENT buyurtma egaligi: kuryer ushlagan
   * (`isCancelledOrderOwnedByCourier`), kuryer filialida turgan yoki joriy
   * qaytish pochtasi (`canceled_post_id`, holat filtrisiz) shu kuryerniki.
   */
  private async isCancelledSentOrderOwnedByCourier(
    order: OrderRow,
    courierId: string,
    branchId: string,
  ): Promise<boolean> {
    if (
      this.isCancelledOrderOwnedByCourier(order, courierId, branchId) ||
      this.getOrderBranchScope(order) === String(branchId)
    ) {
      return true;
    }
    const canceledPostId = String(order.canceled_post_id ?? '').trim();
    if (!canceledPostId) {
      return false;
    }
    const canceledPost = await this.postRepo.findOne({
      where: { id: canceledPostId },
    });
    return (
      !!canceledPost && String(canceledPost.courier_id) === String(courierId)
    );
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
      // Eski pochta tarixi: aniq buyurtma id'lari (order-service `findAll`
      // dagi `order.id IN (...)` filtri).
      search_order_ids?: string[];
      status?: Order_status | Order_status[] | string | string[];
      return_requested?: boolean;
      // order.find_all o'zi filtrlaydi (order.holder_type = :holder_type).
      holder_type?: 'HQ' | 'BRANCH' | 'COURIER';
      customer_id?: string;
      qr_code_token?: string;
      // aLx7Di99: hudud statistikasi doirasi — /orders ro'yxati filtrlari
      // (menejer: branch_id; kuryer: post_ids + exclude_statuses).
      branch_id?: string;
      exclude_statuses?: Order_status[];
      scan_taken_courier_id?: string;
      // rehomeOpenDistrictOrders: faqat shu tuman buyurtmalari.
      district_id?: string;
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
        errorRes("Buyurtmalar xizmati noto'g'ri ro'yxat qaytardi", 502),
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
      throw new RpcException(
        errorRes("Buyurtmalar ro'yxatini olib bo'lmadi", 502),
      );
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
    // Har kun — alohida pochta (egasi qarori 2026-11-03): boshqa kunning ochiq
    // bekor pochtasi shu pochta bilan qo'shilmaydi (ro'yxat soni, ochilgan
    // pochta va qabul — har kun o'zicha). Sanasi yo'q eski yozuv — avvalgidek.
    const sourceCreatedAt = sourcePost.createdAt
      ? new Date(sourcePost.createdAt)
      : null;
    const sourceDay =
      sourceCreatedAt && !Number.isNaN(sourceCreatedAt.getTime())
        ? {
            start: startOfTashkentDay(sourceCreatedAt).getTime(),
            end: endOfTashkentDay(sourceCreatedAt).getTime(),
          }
        : null;
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
      const candidateCreatedAt = candidate.createdAt
        ? new Date(candidate.createdAt).getTime()
        : Number.NaN;
      const sameDay =
        !sourceDay ||
        Number.isNaN(candidateCreatedAt) ||
        (candidateCreatedAt >= sourceDay.start &&
          candidateCreatedAt <= sourceDay.end);

      if (sameBranch && sameRegion && sameDay) {
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
   *           lekin boshqa hudud uchun (`NEW`): kuryerga berish-bermaslikni
   *           chaqiruvchidagi viloyat qoidasi hal qiladi (anKpzwxk).
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

  /**
   * vbu7Wr3o #1 — pochta qabulida `order.update` ga uzatiladigan so'rovchi:
   * qabul qilgan xodim + qabul izohi (order-service shu izoh bo'yicha
   * tracking'ni `post_received` amali bilan, xodim nomidan yozadi).
   * So'rovchi id'si bo'lmasa — `undefined` (avvalgidek tizim yozuvi).
   */
  private postReceiveTrackingActor(
    requester: RequesterContext | null | undefined,
    kind: PostReceiveKind,
  ): { id: string; roles: string[]; note: string } | undefined {
    const id = String(requester?.id ?? '').trim();
    if (!id) return undefined;
    return {
      id,
      roles: requester?.roles ?? [],
      note: POST_RECEIVED_TRACKING_NOTES[kind],
    };
  }

  private async updateOrder(
    id: string,
    dto: Record<string, unknown>,
    requester?: {
      /** Bo'sh — tizim nomidan (faqat qulf belgisi bilan yuboriladigan yozuvlar). */
      id?: string;
      roles?: string[];
      note?: string | null;
      /** o10nrbkB (BG5): bekor pochta qabulida — pochtaning haqiqiy jo'natuvchisi. */
      canceled_post_sender?: {
        user_id: string | null;
        role: string | null;
        branch_id: string | null;
      } | null;
      /** HQ bekor pochta amali: buyurtma hali shu pochtada kutayotgan bo'lsin (aks holda 409). */
      canceled_post_guard?: { post_id: string } | null;
      /** HQ «Filialga qaytarish»: tarixdagi «HQ filialga qaytardi» qatori uchun. */
      canceled_post_return?: {
        post_id: string;
        return_post_id: string;
        to_branch_id: string;
        to_branch_name: string | null;
      } | null;
      /** Kuryer «Bu buyurtma kelmagan»: qulf ostida tekshiruv va tarix qatori. */
      courier_return_request?: { post_id: string } | null;
      /** Filial menejeri «Bu buyurtma kelmagan» (o'tkazma pochtasi) — xuddi shunday. */
      branch_return_request?: { post_id: string } | null;
      /**
       * «Qaytarish» tasdig'i / radi: buyurtma hali o'qilgan so'rov holatida
       * bo'lsin (qulf ostida, aks holda 409 `return_request_review_conflict`).
       */
      return_request_review?: {
        post_id: string | null;
        status: string | null;
        source: 'courier' | 'branch_transfer';
      } | null;
      /**
       * Pochta qabuli: buyurtma hali shu pochtada va o'qilgan holatida bo'lsin
       * (qulf ostida, aks holda 409 `post_receive_conflict`).
       */
      post_receive_guard?: { post_id: string; status: string | null } | null;
    },
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
      throw new RpcException(errorRes(`Buyurtma #${id} yangilanmadi`, 502));
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
      throw new RpcException(
        errorRes("Buyurtma QR kodini tekshirib bo'lmadi", 502),
      );
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
   * `branch` — tuman qamrovi uchun filial qatori (yo'q — `null`, chaqiruvchi
   * `findBranchCoverageRow` ga o'tadi).
   */
  private async findCourierAssignment(requester: RequesterContext): Promise<{
    branchId: string;
    branchType: string | null;
    branch: BranchCoverageRow | null;
  }> {
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
              branch?: { id?: unknown; type?: string | null } | null;
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

      // Qatordagi id biriktiruvdagi filial bilan mos bo'lsagina ishlatiladi.
      const branchRow = branchCoverageRowOf(response?.data?.branch);
      const branch = branchRow?.id === branchId ? branchRow : null;

      return { branchId, branchType, branch };
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
   * Kuryer pochtasining `branch_id` si — kuryerning filiali (HQ kuryeri — HQ
   * filiali): filial menejerining eski pochtalari (`post.branch_id = filial`)
   * o'z kuryerlari pochtalarini ham ko'rsatadi. Tizim so'rovchisi bilan;
   * aniqlab bo'lmasa — `null` (pochta avvalgidek, qabul to'xtamaydi).
   */
  private async findCourierPostBranchId(
    courierId: string | null | undefined,
  ): Promise<string | null> {
    const normalizedCourierId = String(courierId ?? '').trim();
    if (!normalizedCourierId || normalizedCourierId === '0') {
      return null;
    }
    try {
      const response = (await lastValueFrom(
        this.branchClient
          .send(
            { cmd: 'branch.user.find_by_user' },
            {
              user_id: normalizedCourierId,
              requester: SENDER_BRANCH_SYSTEM_REQUESTER,
            },
          )
          .pipe(timeout(SENDER_BRANCH_TIMEOUT_MS)),
      )) as { data?: { branch_id?: unknown } | null } | null;
      const branchId = response?.data?.branch_id;
      return (typeof branchId === 'string' || typeof branchId === 'number') &&
        /^\d{1,19}$/.test(String(branchId).trim())
        ? String(branchId).trim()
        : null;
    } catch (error) {
      this.logger?.warn(
        `courier ${normalizedCourierId}: filialini aniqlab bo'lmadi — pochta filialsiz qoladi: ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
  }

  /**
   * Ega qarori 4: kuryer pochtasi QABUL QILINGANDA (RECEIVED) kuryer
   * filialiga bog'lanadi — faqat bo'sh `branch_id` to'ldiriladi. SENT
   * kuryer pochtasi esa doim filialsiz (`branch_id = null`): `branch_id` li
   * SENT pochta filial o'tkazmasi hisoblanadi (HQ → filial dispatch
   * `receiveOrdersIntoPosts` maqsadi, menejerning «Yangi» ro'yxati,
   * `receivePost` buyurtma filialini qayta yozishi) — RECEIVED pochta qayta
   * SENT ga qaytsa (qisman qabul), filial tozalanadi. Kuryersiz ('0') va
   * bekor (CANCELED / CANCELED_RECEIVED) pochtalarga tegilmaydi.
   * Chaqiruvchi `post.status` ni yangi holatga qo'yib, saqlashdan OLDIN
   * chaqiradi.
   */
  private async syncCourierPostBranch(post: Post): Promise<void> {
    const courierId = String(post?.courier_id ?? '').trim();
    if (!post || !courierId || courierId === '0') {
      return;
    }
    if (post.status === Post_status.SENT) {
      post.branch_id = null;
      return;
    }
    if (
      post.status !== Post_status.RECEIVED ||
      String(post.branch_id ?? '').trim()
    ) {
      return;
    }
    const branchId = await this.findCourierPostBranchId(courierId);
    if (branchId) {
      post.branch_id = branchId;
    }
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

  /**
   * T9 (HJ5sLHiz, BE-2) — «Pochta cheki»dagi «Qayerdan»: pochtani JO'NATGAN
   * filial `{ id, name }`. `post.branch_id` ko'p hollarda MANZIL (HQ →
   * filial o'tkazmasi, bekorlar HQ'ga) yoki bo'sh (filial kuryeri pochtasi),
   * shuning uchun jo'natuvchi pochta turidan aniqlanadi:
   *   - kuryerli pochta (`courier_id` — haqiqiy foydalanuvchi: kuryer yoki
   *     bekorlarni HQ'ga yuborgan menejer) — shu foydalanuvchining filial
   *     biriktiruvi (`branch.user.find_by_user`; qabul tracking'idagi
   *     jo'natuvchi bilan bir xil qoida, o10nrbkB);
   *   - kuryersiz NEW pochta — yig'ilayotgan joy: `branch_id` bo'lsa shu
   *     filial, bo'lmasa HQ;
   *   - kuryersiz SENT / RECEIVED (o'tkazma) — faqat HQ jo'natadi
   *     (`dispatchPostToBranch`) → HQ;
   *   - boshqa hollar yoki aniqlab bo'lmasa — `null` (noto'g'ri nom emas;
   *     FE qatorni chiqarmaydi).
   * Barcha so'rovlar TIZIM so'rovchisi bilan (nom maxfiy emas — boshqa filial
   * menejeri ham ko'radi). Xato / timeout (5 s) — `null`, javob baribir 200.
   * HQ `{ id, name }` 5 daqiqa keshlanadi.
   */
  private async findPostSenderBranch(
    post: Pick<Post, 'courier_id' | 'branch_id' | 'status'>,
  ): Promise<{ id: string; name: string } | null> {
    const courierId = String(post.courier_id ?? '').trim();
    const branchId = String(post.branch_id ?? '').trim();
    try {
      if (courierId && courierId !== '0') {
        const response = (await lastValueFrom(
          this.branchClient
            .send(
              { cmd: 'branch.user.find_by_user' },
              {
                user_id: courierId,
                requester: SENDER_BRANCH_SYSTEM_REQUESTER,
              },
            )
            .pipe(timeout(SENDER_BRANCH_TIMEOUT_MS)),
        )) as { data?: { branch?: unknown } | null } | null;
        return branchSummaryOf(response?.data?.branch);
      }
      if (post.status === Post_status.NEW && branchId) {
        const response = (await lastValueFrom(
          this.branchClient
            .send(
              { cmd: 'branch.find_by_id' },
              { id: branchId, requester: SENDER_BRANCH_SYSTEM_REQUESTER },
            )
            .pipe(timeout(SENDER_BRANCH_TIMEOUT_MS)),
        )) as { data?: unknown } | null;
        return branchSummaryOf(response?.data);
      }
      if (
        post.status === Post_status.NEW ||
        post.status === Post_status.SENT ||
        post.status === Post_status.RECEIVED
      ) {
        return await this.findHqBranchSummary();
      }
      return null;
    } catch (error) {
      // `logger?` — ba'zi spec'lar servisni prototipdan (konstruktorsiz) quradi.
      this.logger?.warn(
        `getPostOrders: sender branch lookup failed (courier ${courierId || '-'}, branch ${branchId || '-'}): ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
  }

  private hqBranchSummaryCache: {
    value: { id: string; name: string };
    expiresAt: number;
  } | null = null;

  /** HQ `{ id, name }` — 5 daqiqalik kesh (xato keshlanmaydi). */
  private async findHqBranchSummary(): Promise<{
    id: string;
    name: string;
  } | null> {
    const cached = this.hqBranchSummaryCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const response = (await lastValueFrom(
      this.branchClient
        .send({ cmd: 'branch.find_hq' }, {})
        .pipe(timeout(SENDER_BRANCH_TIMEOUT_MS)),
    )) as { data?: unknown } | null;
    const value = branchSummaryOf(response?.data);
    if (value) {
      this.hqBranchSummaryCache = {
        value,
        expiresAt: Date.now() + HQ_BRANCH_SUMMARY_TTL_MS,
      };
    }
    return value;
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

  /**
   * Tuman qamrovi uchun filial qatori — `branch.find_by_id` (tizim
   * so'rovchisi, doira tekshiruvisiz). Filial yo'q (404 yoki bo'sh javob) —
   * `null`; branch-service javob bermadi / boshqa xato — 503 (fail closed:
   * qamrovni tekshirmasdan davom etilmaydi).
   */
  private async findBranchCoverageRow(
    branchId: string,
  ): Promise<BranchCoverageRow | null> {
    let response: { data?: unknown } | null;
    try {
      response = (await lastValueFrom(
        this.branchClient
          .send(
            { cmd: 'branch.find_by_id' },
            { id: branchId, requester: SENDER_BRANCH_SYSTEM_REQUESTER },
          )
          .pipe(timeout(SENDER_BRANCH_TIMEOUT_MS)),
      )) as { data?: unknown } | null;
    } catch (error: unknown) {
      const downstreamError: unknown =
        error instanceof RpcException ? error.getError() : error;
      if (
        downstreamError &&
        typeof downstreamError === 'object' &&
        Number((downstreamError as { statusCode?: number }).statusCode) === 404
      ) {
        return null;
      }
      throw new RpcException(
        errorRes(
          "Filial ma'lumotini olib bo'lmadi (filial xizmati javob bermadi) — birozdan so'ng qayta urinib ko'ring",
          503,
        ),
      );
    }
    return branchCoverageRowOf(response?.data);
  }

  /**
   * Kuryerga berish to'sig'i (`assignOrdersToCourier`, `scanAssignOrder`) —
   * VILOYAT qoidasi (ega qarori, Trello anKpzwxk, 2026-11-03; #617 dagi
   * «tuman → filial» qoidasi o'rniga). Filial o'ziga kelgan HAR QANDAY
   * buyurtmani o'z kuryeriga beradi, faqat:
   *  1. chiquvchi partiyadagi (`current_batch_id`) buyurtma — 409
   *     `order_in_outgoing_batch` (HQ ham);
   *  2. HQ (kuryeri — HQ kuryeri): buyurtma XIZMAT viloyati
   *     (`effectiveOrderRegionId`) HQ viloyatiga teng bo'lishi shart — 403
   *     `hq_courier_region_only`; HQ viloyati yo'q — 400
   *     `branch_region_missing` (fail closed, imtiyozdan OLDIN). HQ qamrov
   *     imtiyozi bor buyurtma («eski filialda tugasin»: tuman HQ viloyatidan
   *     ko'chgan yoki deploy paytida HQ kuryerida bo'lgan — migratsiya
   *     1716000000211) ham beriladi;
   *  3. boshqa filial: `isOrderServedByBranch` (viloyat qoidasi) — boshqa
   *     viloyat (tranzit) buyurtmasi 403 `district_not_served_by_branch`
   *     («Boshqa viloyat buyurtmasi»). Qamrov imtiyozi (#619, «eski filialda
   *     tugasin») avvalgidek hisobga olinadi.
   * Filial qatori yo'q — 403 (fail closed). Hech narsa yozmaydi: chaqiruvchi
   * uni har qanday yozuvdan OLDIN chaqiradi.
   *
   * `receivedIntoBranch` — skan (P1b) posilkani shu filialga allaqachon qabul
   * qilgan: rad xabari mas'uliyat filialga o'tganini ham aytadi.
   */
  private async assertOrdersServedByBranch(
    orders: readonly OrderRow[],
    branch: BranchCoverageRow | null,
    options: { receivedIntoBranch?: boolean } = {},
  ): Promise<void> {
    if (!branch) {
      this.forbidden(
        "Filial ma'lumoti topilmadi — buyurtma tumanini filialga tekshirib bo'lmadi",
      );
    }

    const inBatchIds = orders
      .filter((order) => String(order.current_batch_id ?? '').trim())
      .map((order) => String(order.id));
    if (inBatchIds.length) {
      this.conflict(
        `${ORDER_IN_OUTGOING_BATCH_MESSAGE}: ${coverageOrderIdList(inBatchIds)}`,
        rejectionData('order_in_outgoing_batch', { order_ids: inBatchIds }),
      );
    }

    const districtOf = await this.loadOrderDistricts(orders);

    if (isHqBranch(branch)) {
      if (!branch.region_id) {
        this.badRequest(
          SCAN_ASSIGN_MESSAGES.HQ_REGION_MISSING,
          rejectionData('branch_region_missing', { branch_id: branch.id }),
        );
      }
      const outOfRegion = orders.filter(
        (order) =>
          effectiveOrderRegionId({
            district: districtOf(order),
            orderRegionId: order.region_id,
          }) !== branch.region_id,
      );
      let outOfRegionIds = outOfRegion.map((order) => String(order.id));
      // «Eski filialda tugasin» HQ uchun ham: tuman HQ viloyatidan ko'chgan
      // paytda (yoki deploy paytida — migratsiya 1716000000211) HQ / HQ
      // kuryeri qo'lida bo'lgan buyurtma HQ kuryeriga beriladi. Imtiyoz faqat
      // viloyatdan tashqari buyurtmalar uchun so'raladi; o'qib bo'lmasa — 503.
      if (outOfRegion.length) {
        const exemptIds = await this.findCoverageExemptOrderIds(
          outOfRegion,
          branch.id,
        );
        if (exemptIds.size) {
          outOfRegionIds = outOfRegionIds.filter(
            (id) => !exemptIds.has(canonicalBigintId(id) ?? id),
          );
        }
      }
      if (outOfRegionIds.length) {
        this.forbidden(
          `${SCAN_ASSIGN_MESSAGES.OUT_OF_HQ_REGION}: ${coverageOrderIdList(outOfRegionIds)}`,
          rejectionData('hq_courier_region_only', {
            order_ids: outOfRegionIds,
          }),
        );
      }
      return;
    }

    const notServed = orders.filter(
      (order) =>
        !isOrderServedByBranch(
          { district: districtOf(order), orderRegionId: order.region_id },
          branch,
        ),
    );
    let notServedIds = notServed.map((order) => String(order.id));

    // Qamrov imtiyozi (ega qarori, 2026-11-02): tuman boshqa viloyatga
    // ko'chgan paytda shu filial / uning kuryeri qo'lida bo'lgan buyurtma shu
    // filialda tugaydi. Imtiyoz ishlatilganda O'CHMAYDI (kuryer qaytarib
    // bergach ham).
    if (notServed.length) {
      const exemptIds = await this.findCoverageExemptOrderIds(
        notServed,
        branch.id,
      );
      if (exemptIds.size) {
        notServedIds = notServedIds.filter(
          (id) => !exemptIds.has(canonicalBigintId(id) ?? id),
        );
      }
    }

    if (notServedIds.length) {
      const receivedNote = options.receivedIntoBranch
        ? " — posilka filialingizga qabul qilindi, lekin kuryerga berilmaydi (uni o'z viloyatiga partiya/HQ orqali jo'nating)"
        : ' — kuryerga berilmaydi';
      this.forbidden(
        `Boshqa viloyat buyurtmasi${receivedNote}: ${coverageOrderIdList(notServedIds)}`,
        rejectionData('district_not_served_by_branch', {
          order_ids: notServedIds,
        }),
      );
    }
  }

  /**
   * Buyurtmalar tumani qatorlari — bitta lokal so'rov. Qaytgan funksiya
   * buyurtma tumani qatorini beradi (tuman yo'q yoki topilmadi — `null`:
   * qamrov buyurtma viloyati bo'yicha).
   */
  private async loadOrderDistricts(
    orders: readonly OrderRow[],
  ): Promise<(order: OrderRow) => District | null> {
    const districtIds = Array.from(
      new Set(
        orders
          .map((order) => canonicalBigintId(order.district_id))
          .filter((id): id is string => !!id),
      ),
    );
    const districts = districtIds.length
      ? await this.districtRepo.find({ where: { id: In(districtIds) } })
      : [];
    const districtById = new Map(
      districts.map((district) => [String(district.id), district]),
    );
    return (order) => {
      const districtId = canonicalBigintId(order.district_id);
      return districtId ? (districtById.get(districtId) ?? null) : null;
    };
  }

  /**
   * Shu filialning AMALDAGI (`revoked_at IS NULL`) qamrov imtiyozi bor
   * buyurtmalari (kanonik id). Imtiyoz faqat tumani buyurtmaning HOZIRGI
   * tumaniga teng bo'lsa (yoki eski qatorda tuman yo'q — NULL) hisobga
   * olinadi: ko'chishdan keyin buyurtma tumani tahrirlansa imtiyoz endi
   * yordam bermaydi. Bitta lokal so'rov. Imtiyoz repo ulanmagan (eski spec
   * simlari) — bo'sh to'plam (avvalgidek). DB xatosi — 503 (fail closed:
   * imtiyozni tekshirmasdan rad ham, ruxsat ham berilmaydi).
   */
  private async findCoverageExemptOrderIds(
    orders: ReadonlyArray<Pick<OrderRow, 'id' | 'district_id'>>,
    branchId: string,
  ): Promise<Set<string>> {
    const repo = this.coverageExemptionRepo;
    const districtByOrderId = new Map<string, string | null>();
    for (const order of orders) {
      const orderId = canonicalBigintId(order.id);
      if (orderId) {
        districtByOrderId.set(orderId, canonicalBigintId(order.district_id));
      }
    }
    if (!repo || !districtByOrderId.size) {
      return new Set();
    }
    try {
      const rows = await repo.find({
        select: { order_id: true, district_id: true },
        where: {
          order_id: In(Array.from(districtByOrderId.keys())),
          branch_id: branchId,
          revoked_at: IsNull(),
        },
      });
      const exempt = new Set<string>();
      for (const row of rows) {
        const orderId = canonicalBigintId(row.order_id);
        if (!orderId || !districtByOrderId.has(orderId)) {
          continue;
        }
        const exemptionDistrictId = canonicalBigintId(row.district_id);
        if (
          exemptionDistrictId === null ||
          exemptionDistrictId === districtByOrderId.get(orderId)
        ) {
          exempt.add(orderId);
        }
      }
      return exempt;
    } catch (error) {
      this.logger.error(
        `filial #${branchId}: tuman qamrovi imtiyozlarini o'qib bo'lmadi: ${(error as Error)?.message ?? String(error)}`,
      );
      throw new RpcException(
        errorRes(COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE, 503),
      );
    }
  }

  private async findBranchAssignmentByUserId(
    userId: string,
    requester: RequesterContext,
  ): Promise<BranchAssignmentRow | null> {
    const normalizedUserId = String(userId ?? '').trim();
    if (!normalizedUserId) {
      this.badRequest('user_id majburiy');
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

        // SlMjauWC (review 2026-10-26): `sato_code` unique (tirik tumanlar).
        // Tuman qayta nomlangan bo'lsa, seed eski nomni o'sha kod bilan qayta
        // qo'shmasin — aks holda 23505 va servis ishga tushmay qoladi.
        if (districtData.sato_code) {
          const codeTaken = await this.districtRepo.findOne({
            where: { sato_code: districtData.sato_code, isDeleted: false },
          });
          if (codeTaken) {
            continue;
          }
        }

        const district = this.districtRepo.create({
          name: districtName,
          sato_code: districtData.sato_code,
          region_id: regionEntity.id,
          assigned_region: regionEntity.id,
        });
        let savedDistrict: typeof district;
        try {
          savedDistrict = await this.districtRepo.save(district);
        } catch (error) {
          if ((error as { code?: string })?.code === '23505') {
            this.logger.warn(
              `District seed o'tkazib yuborildi (sato_code band): ${districtName} / ${districtData.sato_code}`,
            );
            continue;
          }
          throw error;
        }
        void this.syncDistrictToSearch(savedDistrict);
      }
    }
  }

  async createPost(dto: CreatePostDto) {
    if (!dto.courier_id?.trim()) {
      this.badRequest('courier_id majburiy');
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

  /**
   * YfrqN70i — viloyat/kuryer/sana/has_orders filtrlari TypeORM where
   * bo'lagiga aylanadi. `impossible` — filtr hech narsaga mos kelmaydi
   * (raqam bo'lmagan id): so'rov bazaga yuborilmaydi (bigint ga UUID 22P02
   * → 500 bo'lardi), bo'sh sahifa qaytadi. Yaroqsiz sana — 400.
   */
  private buildPostListFilterWhere(filters?: PostListFilters): {
    where: Record<string, unknown>;
    impossible: boolean;
  } {
    const where: Record<string, unknown> = {};
    let impossible = false;

    for (const key of ['region_id', 'courier_id'] as const) {
      const raw = String(filters?.[key] ?? '').trim();
      if (!raw) continue;
      const id = canonicalBigintId(raw);
      if (id) {
        where[key] = id;
      } else {
        impossible = true;
      }
    }

    const startRaw = String(filters?.startDate ?? '').trim();
    const endRaw = String(filters?.endDate ?? '').trim();
    const { start, end } = tashkentDayRange(startRaw, endRaw);
    if (start && Number.isNaN(start.getTime())) {
      this.badRequest("startDate noto'g'ri (YYYY-MM-DD kutiladi)");
    }
    if (end && Number.isNaN(end.getTime())) {
      this.badRequest("endDate noto'g'ri (YYYY-MM-DD kutiladi)");
    }
    if (start && end && start.getTime() > end.getTime()) {
      this.badRequest("startDate endDate dan keyin bo'lmasligi kerak");
    }
    if (start && end) {
      where.createdAt = Between(start, end);
    } else if (start) {
      where.createdAt = MoreThanOrEqual(start);
    } else if (end) {
      where.createdAt = LessThanOrEqual(end);
    }

    if (isTruthyFlag(filters?.has_orders)) {
      where.order_quantity = MoreThan(0);
    }

    return { where, impossible };
  }

  /**
   * (tveJKICY) Ro'yxat `where` i bo'yicha (sahifalashsiz) yig'indilar —
   * `PostListTotals`. TypeORM `sum()` naqshi (`setFindOptions` + SELECT),
   * ikkala son BITTA so'rovda.
   */
  private async postListTotals(
    where: Record<string, unknown> | Record<string, unknown>[],
  ): Promise<PostListTotals> {
    const raw = await this.postRepo
      .createQueryBuilder('post')
      .setFindOptions({
        where: where as FindOptionsWhere<Post> | FindOptionsWhere<Post>[],
      })
      .select('COALESCE(SUM(post.order_quantity), 0)', 'orders_total')
      .addSelect('COALESCE(SUM(post.post_total_price), 0)', 'amount_total')
      .getRawOne<{
        orders_total: string | number | null;
        amount_total: string | number | null;
      }>();
    return {
      orders_total: Number(raw?.orders_total ?? 0),
      amount_total: Number(raw?.amount_total ?? 0),
    };
  }

  /**
   * Sof kuryer `GET /post` sharti — OR tarmoqlari: (a) o'z pochtasi
   * (`courier_id` = o'zi); (b) filial o'tkazmasi (`courier_id` '0'), lekin
   * SENT emas (anKpzwxk, 5-band: hali qabul qilinmagan kelayotgan pochta
   * kuryerga ko'rinmaydi). `courier_id` filtri tarmoqni tanlaydi (boshqa
   * kuryer — bo'sh). Bo'sh massiv — hech narsa ko'rinmaydi.
   */
  private pureCourierPostListClauses(
    where: Record<string, unknown>,
    ownId: string | null,
  ): Record<string, unknown>[] {
    const requested = where.courier_id;
    const wants = (courierId: string) =>
      requested === undefined || requested === courierId;
    const clauses: Record<string, unknown>[] = [];
    if (ownId && wants(ownId)) {
      clauses.push({ ...where, courier_id: ownId });
    }
    if (wants('0')) {
      const status = where.status;
      if (typeof status === 'string') {
        if (status !== String(Post_status.SENT)) {
          clauses.push({ ...where, courier_id: '0' });
        }
      } else {
        // Holat filtrisiz — `Not(NEW)` o'rniga NEW ham, SENT ham emas.
        clauses.push({
          ...where,
          courier_id: '0',
          status: Not(In([Post_status.NEW, Post_status.SENT])),
        });
      }
    }
    return clauses;
  }

  async findAllPosts(
    page = 1,
    limit = 8,
    filters?: PostListFilters,
    requester?: RequesterContext,
  ) {
    // kA70Rban — shift 100 qoldi, lekin kesilgani javobda ko'rinadi.
    const paging = resolvePostListPage(page, limit);
    const { take, skip } = paging;
    // YfrqN70i — filtrlar avval tekshiriladi (yaroqsiz sana — 400).
    const filterWhere = this.buildPostListFilterWhere(filters);

    // Z3pUOxou (ega LG-S1/LG-S3): logist — faqat o'z viloyatlari, faqat o'qish.
    if (requester && this.isLogistRequester(requester)) {
      return this.findAllPostsForLogist(
        paging,
        filterWhere,
        filters,
        requester,
      );
    }

    const scopedBranchId = await this.resolveScopedBranchId(requester);
    if (filterWhere.impossible) {
      return successRes(
        postListPage([], 0, paging, EMPTY_POST_LIST_TOTALS),
        200,
        'All posts (paginated)',
      );
    }
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
    // YfrqN70i — filtrlar har bir OR tarmog'iga qo'shiladi (AND).
    const filterClause: Record<string, unknown> = { ...filterWhere.where };
    queryWhere = Array.isArray(queryWhere)
      ? queryWhere.map((clause) => ({ ...clause, ...filterClause }))
      : { ...queryWhere, ...filterClause };
    // Sof kuryer: qabul qilingan kuryer pochtasi endi kuryer filialiga
    // (`branch_id`) bog'lanadi — filial doirasi boshqa kuryerlar pochtasini
    // ro'yxatda ko'rsatmasin. Faqat o'z pochtasi va filial o'tkazmasi
    // (courier_id '0') — anKpzwxk (5-band): o'tkazma faqat filial QABUL
    // QILGANDAN keyin (SENT — hali kelayotgan pochta — kuryerga ko'rinmaydi).
    if (requester && this.isPureCourierRequester(requester)) {
      const ownId = canonicalBigintId(String(requester.id ?? '').trim());
      const clauses = (
        Array.isArray(queryWhere) ? queryWhere : [queryWhere]
      ).flatMap((clause) => this.pureCourierPostListClauses(clause, ownId));
      if (!clauses.length) {
        return successRes(
          postListPage([], 0, paging, EMPTY_POST_LIST_TOTALS),
          200,
          'All posts (paginated)',
        );
      }
      queryWhere = clauses;
    }

    const [[rows, total], totals] = await Promise.all([
      this.postRepo.findAndCount({
        where: queryWhere,
        relations: ['region'],
        order: { createdAt: 'DESC' },
        skip,
        take,
      }),
      // (tveJKICY) xuddi shu `where` — yig'indi ro'yxat bilan mos.
      this.postListTotals(queryWhere),
    ]);
    // 4YZcTTDQ: kuryer nomi (rejectedPosts naqshi) — sahifa uchun BITTA
    // identity so'rovi.
    const data = await this.attachPostCouriers(rows);

    return successRes(
      postListPage(data, total, paging, totals),
      200,
      'All posts (paginated)',
    );
  }

  /**
   * Z3pUOxou — GET /post (LOGIST): `region_id IN (o'z viloyatlari)`.
   * `region_id` filtri faqat shu to'plam ichida (boshqasi — 400); viloyat
   * biriktirilmagan logist — bo'sh sahifa. Filial filtri qo'shimcha (AND)
   * cheklov. Javob pulsiz: `post_total_price` va `amount_total` yo'q. GET —
   * hech narsa yozmaydi (filial "ta'miri" yo'q).
   */
  private async findAllPostsForLogist(
    paging: ReturnType<typeof resolvePostListPage>,
    filterWhere: { where: Record<string, unknown>; impossible: boolean },
    filters: PostListFilters | undefined,
    requester: RequesterContext,
  ) {
    const regionIds = (await this.findLogistRegions(requester.id)).map(
      (region) => region.id,
    );
    const requestedRaw = String(filters?.region_id ?? '').trim();
    const requestedRegionId = requestedRaw
      ? canonicalBigintId(requestedRaw)
      : null;
    if (
      requestedRaw &&
      (!requestedRegionId || !regionIds.includes(requestedRegionId))
    ) {
      this.badRequest(LOGIST_REGION_FILTER_MESSAGE);
    }
    const empty = () =>
      successRes(
        postListPage([], 0, paging, { orders_total: 0 } as PostListTotals),
        200,
        'All posts (paginated)',
      );
    if (!regionIds.length || filterWhere.impossible) {
      return empty();
    }

    const status = filters?.status
      ? String(filters.status).trim().toLowerCase()
      : '';
    const allowedStatuses = new Set<string>([
      Post_status.NEW,
      Post_status.SENT,
      Post_status.RECEIVED,
      Post_status.CANCELED,
      Post_status.CANCELED_RECEIVED,
    ]);
    const branchFilter = canonicalBigintId(
      String(filters?.branch_id ?? '').trim(),
    );
    if (String(filters?.branch_id ?? '').trim() && !branchFilter) {
      return empty();
    }
    const where: Record<string, unknown> = {
      status: allowedStatuses.has(status) ? status : Not(Post_status.NEW),
      ...filterWhere.where,
      ...(branchFilter ? { branch_id: branchFilter } : {}),
      // Doira OXIRIDA — hech bir filtr uni almashtira olmaydi.
      region_id: requestedRegionId ?? In(regionIds),
    };

    const [[rows, total], totals] = await Promise.all([
      this.postRepo.findAndCount({
        where,
        relations: ['region'],
        order: { createdAt: 'DESC' },
        skip: paging.skip,
        take: paging.take,
      }),
      this.postListTotals(where),
    ]);
    const data = await this.attachPostCouriers(
      rows.map((row) => this.withoutPostMoney(row)),
    );
    return successRes(
      postListPage(data, total, paging, {
        orders_total: totals.orders_total,
      } as PostListTotals),
      200,
      'All posts (paginated)',
    );
  }

  /**
   * 4YZcTTDQ — pochta kuryeri faqat `{ id, name, phone_number }` (to'liq user
   * obyekti, maosh/tarif EMAS). `courier_id` yo'q / '0' (filial o'tkazmasi)
   * yoki kuryer o'chirilgan (identity `find_by_ids` o'chirilganlarni
   * qaytarmaydi) — `null`. Identity javob bermasa ham `null` (ro'yxat
   * yiqilmaydi).
   */
  private toPostCourierRef(
    courierId: string | null | undefined,
    courierMap: Map<string, Record<string, unknown>>,
  ): { id: string; name: string | null; phone_number: string | null } | null {
    const id = String(courierId ?? '').trim();
    if (!id || id === '0') {
      return null;
    }
    const courier = courierMap.get(id);
    if (!courier) {
      return null;
    }
    const name = courier.name;
    const phone = courier.phone_number;
    return {
      id,
      name: typeof name === 'string' ? name : null,
      phone_number: typeof phone === 'string' ? phone : null,
    };
  }

  private async attachPostCouriers<T extends { courier_id?: string | null }>(
    posts: T[],
  ): Promise<
    Array<
      T & {
        courier: {
          id: string;
          name: string | null;
          phone_number: string | null;
        } | null;
      }
    >
  > {
    const courierIds = posts
      .map((post) => String(post.courier_id ?? '').trim())
      .filter((id) => Boolean(id) && id !== '0');
    const courierMap = await this.findCouriersByIds(courierIds);
    return posts.map((post) => ({
      ...post,
      courier: this.toPostCourierRef(post.courier_id, courierMap),
    }));
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

  /**
   * anKpzwxk (ega qarori, 5-band): «Yangi pochtalar» (HQ hudud pochtalari) —
   * faqat HQ: SUPERADMIN, ADMIN va HQ filialiga biriktirilgan REGISTRATOR /
   * MANAGER. Boshqa har kim (boshqa filial xodimi, filial akkaunti, kuryer,
   * so'rovchisiz chaqiruv) — 403 `new_posts_hq_only`. Biriktiruv
   * branch-service'dan (JWT emas); biriktiruv yo'q / rad javobi — 403,
   * branch-service javob bermadi — 503 (fail closed, qayta urinish).
   */
  private async assertNewPostsRequester(
    requester?: RequesterContext,
  ): Promise<void> {
    if (this.isSystemPrivileged(requester)) {
      return;
    }
    const deny: () => never = () =>
      this.forbidden(NEW_POSTS_HQ_ONLY_MESSAGE, {
        reason: 'new_posts_hq_only',
      });
    const roles = (requester?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    const requesterId = String(requester?.id ?? '').trim();
    if (
      !requester ||
      !requesterId ||
      !(roles.includes(Roles.REGISTRATOR) || roles.includes(Roles.MANAGER))
    ) {
      deny();
    }
    const assignment = (
      await this.sendNewPostsBranchLookup<BranchAssignmentRow>(
        { cmd: 'branch.user.find_by_user' },
        {
          user_id: requesterId,
          requester: {
            id: requester.id,
            roles: requester.roles ?? [Roles.BRANCH],
          },
        },
      )
    )?.data;
    const branchId = String(assignment?.branch_id ?? '').trim();
    const branchRole = String(assignment?.role ?? '')
      .trim()
      .toUpperCase();
    if (
      !branchId ||
      (branchRole !== 'MANAGER' && branchRole !== 'REGISTRATOR')
    ) {
      deny();
    }
    // Filial turi javobda bo'lsa — shu; aks holda `branch.find_hq` bilan.
    const branchRow = branchCoverageRowOf(assignment?.branch);
    let isHq: boolean;
    if (branchRow?.id === branchId && branchRow.type) {
      isHq = isHqBranch(branchRow);
    } else {
      const hq = await this.sendNewPostsBranchLookup<{
        id?: string | number | null;
      }>({ cmd: 'branch.find_hq' }, {});
      const hqBranchId = String(hq?.data?.id ?? '').trim();
      isHq = Boolean(hqBranchId) && hqBranchId === branchId;
    }
    if (!isHq) {
      deny();
    }
  }

  /**
   * «Yangi pochtalar» ruxsati uchun branch-service so'rovi. Rad javobi (4xx)
   * — `null` (aniq «yo'q» → chaqiruvchi 403 beradi); javob bermadi (timeout,
   * transport, 5xx) — 503 `NEW_POSTS_ACCESS_UNAVAILABLE_MESSAGE` (qayta
   * urinish). `findBranchAssignmentByUserId` har qanday xatoni `null`
   * qiladi — bu yerda HQ xodimi branch-service sekinlashganda «faqat HQ»
   * 403 ini olmasin.
   */
  private async sendNewPostsBranchLookup<T>(
    pattern: { cmd: string },
    payload: unknown,
  ): Promise<{ data?: T | null } | null> {
    try {
      return (await lastValueFrom(
        this.branchClient.send(pattern, payload).pipe(timeout(5000)),
      )) as { data?: T | null } | null;
    } catch (error: unknown) {
      const downstreamError: unknown =
        error instanceof RpcException ? error.getError() : error;
      const statusCode = Number(
        downstreamError && typeof downstreamError === 'object'
          ? (downstreamError as { statusCode?: unknown }).statusCode
          : undefined,
      );
      if (statusCode >= 400 && statusCode < 500) {
        return null;
      }
      this.logger?.warn(
        `newPosts: ${pattern.cmd} javob bermadi: ${(error as Error)?.message ?? String(error)}`,
      );
      throw new RpcException(
        errorRes(NEW_POSTS_ACCESS_UNAVAILABLE_MESSAGE, 503),
      );
    }
  }

  async newPosts(query?: { search?: string }, requester?: RequesterContext) {
    // Ruxsat HAR QANDAY yozuvdan (yetim buyurtmalarni pochtaga olish) OLDIN.
    await this.assertNewPostsRequester(requester);
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
      const post = await this.findOrCreateRegionNewPost(payload.regionId);

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
    filters?: Omit<PostListFilters, 'branch_id' | 'courier_id'>,
  ) {
    // kA70Rban — xuddi shu 100 shifti, kesilgani javobda ko'rinadi.
    const paging = resolvePostListPage(page, limit);
    const { take, skip } = paging;
    // YfrqN70i — kuryer ekrani ham region_id/status/sana yuboradi (avval
    // jimgina tashlanardi). courier_id — doim JWT egasi, filtrdan olinmaydi.
    const filterWhere = this.buildPostListFilterWhere({
      region_id: filters?.region_id,
      startDate: filters?.startDate,
      endDate: filters?.endDate,
      has_orders: filters?.has_orders,
    });
    const oldStatuses = new Set<string>([
      Post_status.RECEIVED,
      Post_status.CANCELED,
      Post_status.CANCELED_RECEIVED,
    ]);
    const status = String(filters?.status ?? '')
      .trim()
      .toLowerCase();
    if ((status && !oldStatuses.has(status)) || filterWhere.impossible) {
      return successRes(
        postListPage([], 0, paging, EMPTY_POST_LIST_TOTALS),
        200,
        'All old posts',
      );
    }

    const where = {
      ...filterWhere.where,
      courier_id: requester.id,
      status: status
        ? (status as Post_status)
        : Not(In([Post_status.SENT, Post_status.NEW])),
    };
    const [[data, total], totals] = await Promise.all([
      this.postRepo.findAndCount({
        where,
        relations: ['region'],
        order: { createdAt: 'DESC' },
        skip,
        take,
      }),
      // (tveJKICY) xuddi shu filtr bo'yicha yig'indi.
      this.postListTotals(where),
    ]);

    return successRes(
      postListPage(data, total, paging, totals),
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

  /**
   * aLx7Di99 — «kuryerning pochtalari» ta'rifi BITTA joyda: `myPostsForCourier`
   * (gateway GET /orders/courier/orders shu ro'yxatdan `post_ids` yig'adi) va
   * GET /region/my/district-stats (`findCourierPostIds`).
   */
  private courierPostsWhere(courierId: string) {
    return { courier_id: courierId };
  }

  /** aLx7Di99 — kuryerning BARCHA pochtalari id'lari (sahifasiz). */
  private async findCourierPostIds(courierId: string): Promise<string[]> {
    const posts = await this.postRepo.find({
      where: this.courierPostsWhere(courierId),
      select: { id: true },
    });
    return Array.from(
      new Set(
        posts.map((post) => String(post?.id ?? '').trim()).filter(Boolean),
      ),
    );
  }

  async myPostsForCourier(
    page: number,
    limit: number,
    requester: RequesterContext,
  ) {
    // kA70Rban — xuddi shu 100 shifti, kesilgani javobda ko'rinadi.
    const paging = resolvePostListPage(page, limit);
    const { take, skip } = paging;

    const [data, total] = await this.postRepo.findAndCount({
      where: this.courierPostsWhere(requester.id),
      relations: ['region'],
      order: { createdAt: 'DESC' },
      skip,
      take,
    });

    return successRes(postListPage(data, total, paging), 200, 'All my posts');
  }

  async findPostById(id: string, requester?: RequesterContext) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Pochta topilmadi');
    }
    // Z3pUOxou: logist — faqat o'z viloyati pochtasi, pulsiz, hech narsa
    // yozilmaydi.
    if (requester && this.isLogistRequester(requester)) {
      await this.assertLogistPostRegion(post, requester);
      return successRes(
        await this.withPostCourier(this.withoutPostMoney(post)),
        200,
        'Post found',
      );
    }
    this.assertPostVisibleToCourier(post, requester);
    // Sof kuryer — faqat o'z kuryerli pochtasi (getPostOrders qoidasi): qabul
    // qilingan kuryer pochtasi kuryer filialiga (`branch_id`) bog'langani
    // uchun filial doirasi boshqa kuryer pochtasini ochib qo'ymasin. O'z
    // pochtasi — filial/buyurtma doirasisiz (bo'shab qolgan eski pochta ham
    // 403 bermasin). Filial o'tkazmasi (courier_id '0') — pastdagi doira.
    const postCourierId = String(post.courier_id ?? '').trim();
    if (
      requester &&
      this.isPureCourierRequester(requester) &&
      postCourierId &&
      postCourierId !== '0'
    ) {
      if (postCourierId !== String(requester.id ?? '').trim()) {
        this.forbidden("Kuryer faqat o'z pochtasini ko'ra oladi");
      }
      return successRes(await this.withPostCourier(post), 200, 'Post found');
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
      return successRes(await this.withPostCourier(saved), 200, 'Post found');
    }
    return successRes(await this.withPostCourier(post), 200, 'Post found');
  }

  /**
   * 1mOjtOVC — pochta cheki: «haydovchi» = pochta kuryeri. `GET /post/:id`
   * javobiga `courier: { id, name, phone_number } | null` qo'shiladi (ro'yxat
   * `attachPostCouriers` bilan AYNI shakl). Filial/hudud pochtasi (kuryer
   * '0'/yo'q) yoki identity javob bermasa — `null`, javob yiqilmaydi.
   */
  private async withPostCourier<T extends { courier_id?: string | null }>(
    post: T,
  ): Promise<
    T & {
      courier: {
        id: string;
        name: string | null;
        phone_number: string | null;
      } | null;
    }
  > {
    const courierId = String(post?.courier_id ?? '').trim();
    const courierMap =
      courierId && courierId !== '0'
        ? await this.findCouriersByIds([courierId])
        : new Map<string, Record<string, unknown>>();
    return {
      ...post,
      courier: this.toPostCourierRef(courierId, courierMap),
    };
  }

  async deletePost(id: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Pochta topilmadi');
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

  /**
   * Jo'natilgan filial pochtasini boshqa filialga o'tkazish — pochta qismi
   * (`branch.post.reassign_branch` buyurtmalarni ko'chirib bo'lgach
   * chaqiradi). Shartli yozuv: faqat hali 'sent', kuryersiz va AYNAN eski
   * filialda turgan pochta o'zgaradi — shu orada filial qabul qilgan bo'lsa,
   * 409 (chaqiruvchi buyurtmalarni qaytaradi). Pochta allaqachon yangi
   * filialda bo'lsa (buyurtmalar ko'chgach `repairSentPostBranchAssignments`
   * o'zi tiklagan yoki qayta urinish) — muvaffaqiyat.
   */
  async reassignPostBranch(
    postId: string,
    fromBranchId: string,
    toBranchId: string,
    expectedOrderQuantity?: number | null,
  ) {
    const id = String(postId ?? '').trim();
    const from = String(fromBranchId ?? '').trim();
    const to = String(toBranchId ?? '').trim();
    if (![id, from, to].every((value) => /^\d+$/.test(value))) {
      this.badRequest('post_id, from_branch_id va to_branch_id majburiy');
    }
    // Buyurtmalar ko'chayotgan soniyalarda HQ shu pochtaga (eski filialga)
    // yangi buyurtma qo'shsa (`receiveOrdersIntoPosts` SENT pochtani qayta
    // ishlatadi) — soni o'zgaradi, pochta o'tkazilmaydi (409, chaqiruvchi
    // buyurtmalarni qaytaradi): yangi buyurtma eski filialda qoladi.
    const quantity = Number(expectedOrderQuantity);
    const result = await this.postRepo.update(
      {
        id,
        status: Post_status.SENT,
        courier_id: '0',
        branch_id: from,
        isDeleted: false,
        ...(expectedOrderQuantity != null && Number.isInteger(quantity)
          ? { order_quantity: quantity }
          : {}),
      },
      { branch_id: to },
    );
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post || post.isDeleted) {
      this.notFound('Pochta topilmadi');
    }
    if (
      !result.affected &&
      !(post.status === Post_status.SENT && String(post.branch_id) === to)
    ) {
      this.conflict(
        "Pochta o'zgargan (filial qabul qilgan, yangi buyurtma qo'shilgan yoki boshqa filialga o'tgan) — sahifani yangilang",
      );
    }
    void this.syncPostToSearch(post);
    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: id,
      action: 'logistics.post_reassign_branch',
      metadata: { from_branch_id: from, to_branch_id: to },
    });
    return successRes(post, 200, "Pochta boshqa filialga o'tkazildi");
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

  /**
   * X4RzXk1H + dwJX3NjT (S2) — pochta QR skani: `GET /scan/:token`
   * (`POST-…`) va `GET /post/scan/:id`.
   *
   * Ruxsat (ilgari umuman yo'q edi — market ham pochta qatorini olardi):
   *   1. rol — `POST_SCAN_ROLES`; qidiruvdan OLDIN, shuning uchun begona rol
   *      token bor-yo'qligini ham bilmaydi (doim 403);
   *   2. doira — `GET /post/orders/:id` bilan AYNI (`getPostOrders`):
   *      SA/admin — hammasi; filial xodimi — o'z filiali pochtasi yoki
   *      buyurtmalari to'liq o'z filialida turgan pochta; kuryer — o'z
   *      pochtasi. Skan faqat O'QIYDI: getPostOrders ning filial o'tkazmasi
   *      pochtasini qabul qiluvchi filialga ko'chirishi (`branch_id`) bu
   *      yo'lda yozilmaydi.
   *
   * Javob — pochta qatorining o'zi (avvalgi maydonlar o'zgarmagan) +
   * QO'SHIMCHA: `region {id, name}`, `courier {id, name, phone_number}` va
   * `orders[]` — `GET /post/orders/:id` dagi AYNI ro'yxat (kuryerga SENT
   * pochtada faqat yo'ldagilar) skaner xulosasi shaklida. Mijoz, raqam,
   * tuman/viloyat — `order.summary_by_ids` dan; u javob bermasa shu maydonlar
   * `null`, skan yiqilmaydi.
   */
  async findPostWithQr(token: string, requester?: RequesterContext) {
    const roles = (requester?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    if (
      !requester ||
      !String(requester.id ?? '').trim() ||
      !roles.some((role) => POST_SCAN_ROLES.includes(role))
    ) {
      this.forbidden(POST_SCAN_FORBIDDEN_MESSAGE);
    }

    const normalizedToken = String(token ?? '').trim();
    const post = normalizedToken
      ? await this.postRepo.findOne({
          where: { qr_code_token: normalizedToken },
        })
      : null;
    if (!post) {
      this.notFound('Pochta topilmadi');
    }
    this.assertPostVisibleToCourier(post, requester);

    // Skan — faqat hozir pochtada turganlar (eski pochta tarixi emas).
    const view = (await this.getPostOrders(String(post.id), requester, {
      readOnly: true,
      view: 'current',
    })) as {
      data: {
        allOrdersByPostId: OrderRow[];
        post: { region: unknown; courier: unknown };
      };
    };
    const orders = view.data.allOrdersByPostId ?? [];
    const summaries = await fetchScanOrderSummaries(
      this.orderClient,
      orders.map((order) => String(order.id)),
      {
        onError: (error, ids) =>
          this.logger.warn(
            `order.summary_by_ids failed (post scan ${post.id}, ids=${ids.length}): ${(error as Error)?.message ?? String(error)}`,
          ),
      },
    );

    return successRes(
      {
        ...post,
        region: view.data.post.region ?? null,
        courier: view.data.post.courier ?? null,
        orders: orders.map((order) => {
          const summary = summaries.get(String(order.id));
          const price = Number(order.total_price);
          return {
            id: String(order.id),
            order_number: summary?.order_number ?? null,
            status: order.status ?? summary?.status ?? null,
            total_price:
              order.total_price !== undefined &&
              order.total_price !== null &&
              Number.isFinite(price)
                ? price
                : (summary?.total_price ?? null),
            where_deliver: order.where_deliver ?? null,
            customer: summary?.customer ?? null,
            region: summary?.region ?? null,
            district: summary?.district ?? null,
            // CqBD8V4p: gateway `problem_contacts` shu id lar bilan aniqlaydi.
            region_id: order.region_id ?? null,
            district_id: order.district_id ?? null,
            // T8: kuryer/ombor skanida maxsus belgilar.
            special_categories: Array.isArray(order.special_categories)
              ? order.special_categories
              : (summary?.special_categories ?? []),
          };
        }),
      },
      200,
      'Post found',
    );
  }

  async findAllCouriersByPostId(id: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Pochta topilmadi');
    }

    const couriers = post.region_id
      ? await this.listCouriersByRegion(post.region_id)
      : await this.listCouriers();
    if (!couriers.length) {
      this.notFound('Bu viloyat uchun kuryer topilmadi');
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

  /**
   * Eski pochta tarixi — `order.post_membership.find` (order-service,
   * `order_schema.post_order_memberships`). `null` — javob kelmadi yoki
   * shakli noma'lum (chaqiruvchi joriy a'zolar bilan davom etadi).
   */
  private async findPostMemberships(
    postId: string,
  ): Promise<PostMembershipRow[] | null> {
    try {
      const res = (await lastValueFrom(
        this.orderClient
          .send({ cmd: 'order.post_membership.find' }, { post_ids: [postId] })
          .pipe(timeout(POST_MEMBERSHIP_TIMEOUT_MS)),
      )) as { data?: unknown } | unknown[] | null;
      const data = Array.isArray(res) ? res : res?.data;
      const rows = Array.isArray(data) ? (data as unknown[]) : null;
      if (!rows) {
        this.logger?.warn(
          `order.post_membership.find: noma'lum javob shakli (post ${postId})`,
        );
        return null;
      }
      return (rows as PostMembershipRow[]).filter(
        (row) =>
          row &&
          String(row.order_id ?? '').trim() &&
          String(row.post_id ?? '').trim() === String(postId),
      );
    } catch (error) {
      this.logger?.warn(
        `order.post_membership.find failed (post ${postId}): ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
  }

  /**
   * Buyurtma bo'yicha bitta yozuv: birinchi kirgan payt (`joined_at`) va eng
   * oxirgi bo'lishdagi chiqish (`left_at`, `next_post_id`). Bir buyurtma
   * pochtaga bir necha marta kirgan bo'lishi mumkin.
   */
  private groupPostMemberships(
    rows: PostMembershipRow[],
  ): Map<string, PostMembershipSummary> {
    const sorted = [...rows].sort(
      (left, right) =>
        postMembershipTime(left.joined_at) -
        postMembershipTime(right.joined_at),
    );
    const byOrder = new Map<string, PostMembershipSummary>();
    for (const row of sorted) {
      const orderId = String(row.order_id ?? '').trim();
      if (!orderId) continue;
      const previous = byOrder.get(orderId);
      const nextPostId = String(row.next_post_id ?? '').trim();
      byOrder.set(orderId, {
        joined_at: previous?.joined_at ?? row.joined_at ?? null,
        left_at: row.left_at ?? null,
        next_post_id: nextPostId || null,
      });
    }
    return byOrder;
  }

  /**
   * Sobiq a'zolar (hozir boshqa pochtada / pochtasiz) — `order.find_all`
   * id bo'yicha, bo'laklab (chaqiruvchining `timeoutMs` i — `all` byudjeti;
   * id'lar soni POST_HISTORY_MAX_ORDERS bilan cheklangan).
   * `null` — order-service javob bermadi.
   */
  private async findPostHistoryOrders(
    orderIds: string[],
    postId: string,
    timeoutMs: number,
  ): Promise<OrderRow[] | null> {
    const ids = [
      ...new Set(
        orderIds
          .map((orderId) => String(orderId ?? '').trim())
          .filter((orderId) => /^\d{1,19}$/.test(orderId)),
      ),
    ];
    if (!ids.length) {
      return [];
    }
    const chunks: string[][] = [];
    for (let index = 0; index < ids.length; index += POST_HISTORY_ORDER_CHUNK) {
      chunks.push(ids.slice(index, index + POST_HISTORY_ORDER_CHUNK));
    }
    try {
      const groups = await Promise.all(
        chunks.map((chunk) =>
          this.findOrders(
            {
              search_order_ids: chunk,
              fetch_all: true,
              page: 1,
              limit: 1000,
            },
            { timeoutMs },
          ),
        ),
      );
      return groups.flat();
    } catch (error) {
      this.logger?.warn(
        `post ${postId}: sobiq a'zolarni olib bo'lmadi (ids=${ids.length}): ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
  }

  /** `all` ko'rinishi qatori: buyurtma + pochtadagi o'rni («hozir qayerda»). */
  private withPostMembership(
    order: OrderRow,
    currentOrderIds: Set<string>,
    membershipByOrder: Map<string, PostMembershipSummary>,
  ): OrderRow & {
    in_post_now: boolean;
    membership: PostMembershipSummary | null;
    current_post_id: string | null;
    current_canceled_post_id: string | null;
  } {
    const orderId = String(order.id);
    const currentPostId = String(order.post_id ?? '').trim();
    const currentCanceledPostId = String(order.canceled_post_id ?? '').trim();
    return {
      ...order,
      in_post_now: currentOrderIds.has(orderId),
      membership: membershipByOrder.get(orderId) ?? null,
      current_post_id: currentPostId || null,
      current_canceled_post_id: currentCanceledPostId || null,
    };
  }

  /**
   * Sof kuryerning o'z eski pochtasi (`all`): hozir pochtada bo'lmagan
   * (`in_post_now: false`) va BOSHQA kuryerdagi (`courier_id` /
   * `holder_courier_id` so'rovchi emas) qatordan FOREIGN_COURIER_ORDER_FIELDS
   * olib tashlanadi. Joriy a'zo va hozir o'zidagi qator — o'zgarishsiz.
   */
  private withoutForeignCourierFields(
    order: OrderRow & { in_post_now?: boolean },
    requesterId: string,
  ): OrderRow {
    if (order.in_post_now !== false) {
      return order;
    }
    const isForeign = (value: string | null | undefined) => {
      const id = String(value ?? '').trim();
      return Boolean(id) && id !== requesterId;
    };
    if (!isForeign(order.courier_id) && !isForeign(order.holder_courier_id)) {
      return order;
    }
    const stripped: Record<string, unknown> = { ...order };
    for (const key of FOREIGN_COURIER_ORDER_FIELDS) {
      delete stripped[key];
    }
    return stripped as unknown as OrderRow;
  }

  /**
   * `options.readOnly` — X4RzXk1H: pochta QR skani (`findPostWithQr`) shu
   * ruxsat va ro'yxatni ishlatadi, lekin filial o'tkazmasi pochtasining
   * `branch_id` sini qabul qiluvchi filialga ko'chirmaydi (skan — o'qish).
   *
   * `options.view` — eski pochtalar: `all` — pochtaga HAR QACHON kirgan
   * buyurtmalar (`order.post_membership.find` ∪ joriy ko'rsatkichlar), har
   * qatorda `in_post_now`, `membership {joined_at, left_at, next_post_id}`,
   * `current_post_id`, `current_canceled_post_id`; `current` — faqat hozir
   * pochtadagilar (avvalgi xulq). Sukut — `defaultPostOrdersView` (qabul
   * qilingan pochta — `all`), lekin: yo'ldagi joriy a'zosi bor RECEIVED
   * pochta (hali qabul qilinadi) va sof kuryerning o'ziniki bo'lmagan pochtasi
   * — `current`. Sof kuryer o'ziniki bo'lmagan pochtada `all` so'rasa — 403.
   * Skan (`findPostWithQr`) doim `current`.
   */
  async getPostOrders(
    id: string,
    requester: RequesterContext,
    options?: {
      readOnly?: boolean;
      withSenderBranch?: boolean;
      view?: PostOrdersView;
    },
  ) {
    // `all` ko'rinishi byudjeti (POST_HISTORY_BUDGET_MS) shu paytdan sanaladi.
    const startedAt = Date.now();
    const post = await this.postRepo.findOne({
      where: { id },
      // 4YZcTTDQ: javobdagi `post.region` (detal sarlavhasi) uchun.
      relations: ['region'],
    });
    if (!post) {
      this.notFound('Pochta topilmadi');
    }
    const requesterRoles = (requester.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    const isCourier = requesterRoles.includes(Roles.COURIER);
    // Pochtani yuborgan foydalanuvchi (kuryer yoki bekorlarni HQ'ga yuborgan
    // menejer — `courier_id`) — har qanday rolda o'z pochtasini ochadi:
    // bo'shab qolgan eski pochta ham 403 bermasin.
    const requesterId = String(requester.id ?? '').trim();
    const postCourierId = String(post.courier_id ?? '').trim();
    const isOwnPost = Boolean(requesterId) && postCourierId === requesterId;
    // Sof kuryer — faqat o'z kuryerli pochtasi: qabul qilingan kuryer pochtasi
    // endi kuryer filialiga (`branch_id`) bog'langani uchun filial doirasi
    // boshqa kuryer pochtasini ochib qo'ymasin.
    const isPureCourier = this.isPureCourierRequester(requester);
    if (isPureCourier && postCourierId && postCourierId !== '0' && !isOwnPost) {
      this.forbidden("Kuryer faqat o'z pochtasini ko'ra oladi");
    }
    this.assertPostVisibleToCourier(post, requester);
    // Ega qarori 3: sof kuryer pochta TARIXINI (`all` — Excel va chek ham)
    // faqat o'z pochtasida ko'radi. Filial o'tkazmasi pochtasi (courier_id
    // '0') filial doirasidan ochilsa — avvalgidek faqat joriy a'zolar.
    const isForeignToPureCourier = isPureCourier && !isOwnPost;
    if (isForeignToPureCourier && options?.view === 'all') {
      this.forbidden("Kuryer faqat o'z pochtasi tarixini ko'ra oladi");
    }
    let view: PostOrdersView =
      options?.view ??
      (isForeignToPureCourier ? 'current' : defaultPostOrdersView(post.status));

    // Z3pUOxou: logist — faqat o'z viloyati pochtasi (aks holda 403), faqat
    // o'qish (filial doirasi yo'q — branch_id ko'chirilmaydi).
    const isLogist = this.isLogistRequester(requester);
    if (isLogist) {
      await this.assertLogistPostRegion(post, requester);
    }
    // T9 (BE-2): jo'natuvchi filial — faqat GET /post/orders/:id detali uchun,
    // buyurtmalar bilan PARALLEL (pochta holati/kuryeri bu yerdagi qiymat).
    const senderBranchLookup: Promise<{ id: string; name: string } | null> =
      options?.withSenderBranch
        ? this.findPostSenderBranch({
            courier_id: post.courier_id,
            branch_id: post.branch_id,
            status: post.status,
          })
        : Promise.resolve(null);
    const scopedBranchId = isLogist
      ? null
      : await this.resolveScopedBranchId(requester);
    const [ordersByPostId, ordersByCanceledPostId, memberships] =
      await Promise.all([
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
        // Eski pochta tarixi — joriy a'zolar bilan PARALLEL.
        view === 'all'
          ? this.findPostMemberships(id)
          : Promise.resolve<PostMembershipRow[] | null>([]),
      ]);
    const currentOrders = [...ordersByPostId, ...ordersByCanceledPostId];
    const currentOrderIds = new Set(
      currentOrders.map((order) => String(order.id)),
    );
    // Hali qabul qilinadigan RECEIVED pochta (yo'ldagi joriy a'zosi bor —
    // `receivePost` uni qabul qiladi): qabul ekrani faqat joriy a'zolarni
    // ko'rsatadi, sukut `current` (aniq `view: 'all'` — tarix).
    if (
      !options?.view &&
      view === 'all' &&
      post.status === Post_status.RECEIVED &&
      ordersByPostId.some((order) => order.status === Order_status.ON_THE_ROAD)
    ) {
      view = 'current';
    }
    // Tarix olinmadi (order-service javob bermadi) yoki kesilgan — ro'yxat
    // olinganicha qaytadi, `history_incomplete: true` (gateway/FE ogohlantiradi).
    let historyIncomplete =
      view === 'all' &&
      (memberships === null || memberships.length >= POST_MEMBERSHIP_MAX_ROWS);
    const membershipByOrder =
      view === 'all'
        ? this.groupPostMemberships(memberships ?? [])
        : new Map<string, PostMembershipSummary>();
    let formerOrders: OrderRow[] = [];
    if (view === 'all') {
      let formerIds = [...membershipByOrder.keys()].filter(
        (orderId) => !currentOrderIds.has(orderId),
      );
      if (formerIds.length > POST_HISTORY_MAX_ORDERS) {
        formerIds = formerIds.slice(0, POST_HISTORY_MAX_ORDERS);
        historyIncomplete = true;
      }
      // Gateway 8 s byudjeti: joriy a'zolar so'rovidan qolgan vaqt.
      const historyTimeoutMs = Math.min(
        POST_HISTORY_ORDERS_MAX_TIMEOUT_MS,
        POST_HISTORY_BUDGET_MS - (Date.now() - startedAt),
      );
      let fetched: OrderRow[] | null = null;
      if (
        formerIds.length &&
        historyTimeoutMs < POST_HISTORY_ORDERS_MIN_TIMEOUT_MS
      ) {
        this.logger?.warn(
          `post ${id}: sobiq a'zolar (${formerIds.length} ta) uchun vaqt qolmadi — history_incomplete`,
        );
      } else {
        fetched = await this.findPostHistoryOrders(
          formerIds,
          id,
          historyTimeoutMs,
        );
      }
      if (fetched === null) {
        historyIncomplete = true;
      } else {
        const joinedAt = (order: OrderRow) =>
          postMembershipTime(
            membershipByOrder.get(String(order.id))?.joined_at,
          );
        formerOrders = fetched
          .filter((order) => !currentOrderIds.has(String(order.id)))
          .sort((left, right) => joinedAt(left) - joinedAt(right));
      }
    }
    const isSingleScopedBranch = (rows: OrderRow[]) => {
      const branchIds = new Set(
        rows.map((order) => this.getOrderBranchScope(order)).filter(Boolean),
      );
      return (
        Boolean(scopedBranchId) &&
        branchIds.size === 1 &&
        branchIds.has(String(scopedBranchId))
      );
    };
    const belongsToScopedBranch = isSingleScopedBranch(currentOrders);
    // Bo'shab qolgan eski pochta: doira pochtaga HAR QACHON kirgan
    // buyurtmalardan ham olinadi (faqat ruxsat uchun — filial o'tkazmasi
    // `branch_id` ko'chirilishi joriy a'zolar bo'yicha qoladi).
    const historyBelongsToScopedBranch =
      view === 'all' &&
      formerOrders.length > 0 &&
      isSingleScopedBranch([...currentOrders, ...formerOrders]);

    if (
      scopedBranchId &&
      String(post.branch_id ?? '') !== scopedBranchId &&
      !belongsToScopedBranch &&
      !historyBelongsToScopedBranch &&
      !isOwnPost
    ) {
      // Tarix olinmadi (javob kelmadi / byudjet tugadi / kesildi) va olingan
      // qatorlarning hech biri boshqa filialda emas — ruxsat faqat tarix
      // orqali bo'lishi mumkin edi: 403 emas, qayta urinsa bo'ladigan 503
      // (ma'lumot berilmaydi). Olingan qator boshqa filialda — haqiqiy 403.
      const loadedRowsInScope = [...currentOrders, ...formerOrders].every(
        (order) => {
          const scope = this.getOrderBranchScope(order);
          return !scope || scope === String(scopedBranchId);
        },
      );
      if (view === 'all' && historyIncomplete && loadedRowsInScope) {
        throw new RpcException(errorRes(POST_HISTORY_UNAVAILABLE_MESSAGE, 503));
      }
      this.forbidden("Siz bu branch pochtasidagi orderlarni ko'ra olmaysiz");
    }

    const isBranchTransferPost =
      !String(post.courier_id ?? '').trim() ||
      String(post.courier_id ?? '').trim() === '0';
    if (
      !options?.readOnly &&
      belongsToScopedBranch &&
      isBranchTransferPost &&
      String(post.branch_id ?? '').trim() !== scopedBranchId
    ) {
      post.branch_id = scopedBranchId;
      const saved = await this.postRepo.save(post);
      void this.syncPostToSearch(saved);
    }

    const orderMap = new Map<string, OrderRow>();
    for (const order of currentOrders) {
      orderMap.set(String(order.id), order);
    }

    let orders = Array.from(orderMap.values());

    if (view === 'all') {
      // Joriy a'zolar avvalgi tartibda, keyin sobiqlar (kirgan vaqti bo'yicha).
      orders = [...orders, ...formerOrders].map((order) =>
        this.withPostMembership(order, currentOrderIds, membershipByOrder),
      );
      // Sof kuryer: hozir boshqa kuryerdagi sobiq a'zo — o'sha kuryerning
      // shaxsi va pulisiz (Excel va chek ham shu ro'yxatdan).
      if (isPureCourier) {
        orders = orders.map((order) =>
          this.withoutForeignCourierFields(order, requesterId),
        );
      }
    } else if (post.status === Post_status.SENT && isCourier) {
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

    // 4YZcTTDQ: pochtaning o'z ma'lumoti (sarlavha, holat rozetkasi, QR,
    // kuryer) — frontend uni router state'dan yoki buyurtmalardan taxmin
    // qilmasin. Kuryer — faqat {id, name, phone_number}, o'chirilgan → null.
    const postBranchId = post.branch_id ? String(post.branch_id) : null;
    const [[postWithCourier], senderBranch] = await Promise.all([
      this.attachPostCouriers([post]),
      senderBranchLookup,
    ]);
    const region = post.region ?? null;

    return successRes(
      {
        allOrdersByPostId: orders,
        // Z3pUOxou: logistga summalar yo'q (buyurtma qatorlari gateway'da
        // LOGIST proyeksiyasidan o'tadi).
        homeOrders: isLogist
          ? { homeOrders }
          : { homeOrders, homeOrdersTotalPrice },
        centerOrders: isLogist
          ? { centerOrders }
          : { centerOrders, centerOrdersTotalPrice },
        // Eski pochtalar (additive, faqat `all` ko'rinishida — `current`
        // javobi avvalgidek): tarix olinmagan bo'lsa `history_incomplete`.
        ...(view === 'all'
          ? { view, history_incomplete: historyIncomplete }
          : {}),
        // yokjwjXG (additive): pochtaning o'zi — frontend savatni
        // (`POST /post/delete`) faqat `status = 'new'` da ko'rsatadi.
        // 4YZcTTDQ (additive): holat bilan birga pochta meta'si.
        post: {
          id: String(post.id),
          status: post.status,
          courier_id: post.courier_id ? String(post.courier_id) : null,
          courier: postWithCourier.courier,
          qr_code_token: post.qr_code_token ?? null,
          order_quantity: Number(post.order_quantity ?? 0),
          branch_id: postBranchId,
          // T9 (BE-2): «Qayerdan» — jo'natuvchi filial `{ id, name }`; faqat
          // detal so'rovi (`withSenderBranch`) — skan va dispatch so'ramaydi.
          ...(options?.withSenderBranch ? { branch: senderBranch } : {}),
          region_id: post.region_id ? String(post.region_id) : null,
          region: region ? { id: String(region.id), name: region.name } : null,
          createdAt: post.createdAt ?? null,
        },
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
      this.notFound('Pochta topilmadi');
    }
    if (post.status !== Post_status.SENT) {
      this.badRequest("Kuryerga faqat jo'natilgan pochtalar ko'rinadi");
    }

    return this.getPostOrders(id, requester);
  }

  async getRejectedPostOrders(id: string, requester?: RequesterContext) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Pochta topilmadi');
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
      this.badRequest('Pochta topilmadi');
    }

    const orders = await this.findOrders({
      post_id: dto.postId,
      status: Order_status.RECEIVED,
      qr_code_token: qrToken,
      page: 1,
      limit: 1,
    });

    if (!orders.length) {
      this.notFound('Buyurtma topilmadi');
    }

    return successRes(
      { order: { id: orders[0].id } },
      200,
      "Order checked and it's exist",
    );
  }

  async checkCancelPost(qrToken: string, dto: PostIdDto) {
    if (!dto.postId) {
      this.badRequest('Pochta topilmadi');
    }

    const orders = await this.findOrders({
      canceled_post_id: dto.postId,
      status: Order_status.CANCELLED_SENT,
      qr_code_token: qrToken,
      page: 1,
      limit: 1,
    });

    if (!orders.length) {
      this.notFound('Buyurtma topilmadi');
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
      this.notFound('Pochta topilmadi');
    }

    const courier = await this.findCourierById(dto.courierId);
    if (!courier) {
      this.notFound('Kuryer topilmadi');
    }

    if (!dto.orderIds?.length) {
      this.badRequest("Bo'sh pochtani jo'natib bo'lmaydi");
    }

    const currentOrders = await this.findOrders({
      post_id: id,
      page: 1,
      limit: 1000,
    });
    if (!currentOrders.length) {
      this.badRequest("Pochtada buyurtma yo'q");
    }

    const currentIds = currentOrders.map((o) => o.id);
    const selectedIds = [...new Set(dto.orderIds.filter(Boolean))];
    const invalidIds = selectedIds.filter(
      (orderId) => !currentIds.includes(orderId),
    );
    if (invalidIds.length) {
      this.badRequest("Tanlangan buyurtmalarning bir qismi bu pochtada yo'q");
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

  /**
   * `PATCH post/receive/:id` ruxsat bloki — bulk va skan (`scan: true`)
   * yo'llari uchun AYNAN bir xil va shu tartibda: begona filial (umumiy,
   * ma'lumotsiz 403) → o'tkazma pochtasi (courier_id '0') faqat manzil filial
   * menejeri yoki SA/ADMIN override → kuryer faqat o'z pochtasi.
   * `allOrders` — pochtaning joriy buyurtmalari (filial doirasi uchun).
   */
  private async assertPostReceiveAccess(
    requester: RequesterContext,
    post: Post,
    allOrders: OrderRow[],
  ): Promise<PostReceiveAccess> {
    const requesterRoles = (requester?.roles ?? []).map((role) =>
      String(role ?? '').toLowerCase(),
    );
    const requesterId = String(requester?.id ?? '').trim();
    const requesterIsCourier = requesterRoles.includes(Roles.COURIER);
    const isOwnCourierPost =
      requesterIsCourier && String(post.courier_id ?? '') === requesterId;
    const isBranchTransferPost =
      !String(post.courier_id ?? '').trim() ||
      String(post.courier_id ?? '').trim() === '0';
    const isPrivileged = this.isSystemPrivileged(requester);
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
      // Begona filial (o'tkazma pochtasi ham) — ma'lumotsiz umumiy 403:
      // pochta qaysi filialga ketayotgani oshkor qilinmaydi.
      this.forbidden('Siz bu branch pochtasini qabul qila olmaysiz');
    }

    // anKpzwxk (ega qarori, 4-band): HQ → filial o'tkazma pochtasini
    // (courier_id '0') FAQAT manzil filial MENEJERI qabul qiladi; SA/ADMIN —
    // favqulodda (jurnalga `override: true` bilan yoziladi). O'z filiali
    // registratori, filial akkaunti (BRANCH) va kuryeri — 403 kod bilan
    // (yuqoridagi doiradan KEYIN: begona filial kodni ham, manzilni ham
    // olmaydi; `details` da faqat `post_id`). Kuryer pochtalari
    // (courier_id — haqiqiy kuryer) — avvalgi qoidalar.
    if (
      isBranchTransferPost &&
      !isPrivileged &&
      !requesterRoles.includes(Roles.MANAGER)
    ) {
      this.forbidden(
        POST_RECEIVE_MANAGER_ONLY_MESSAGE,
        rejectionData('post_receive_manager_only', {
          post_id: String(post.id),
        }),
      );
    }

    if (
      requesterIsCourier &&
      !isPrivileged &&
      requesterId &&
      String(post.courier_id ?? '') !== requesterId
    ) {
      this.forbidden(
        "Courier faqat o'ziga biriktirilgan pochtani qabul qilishi mumkin",
      );
    }

    return {
      requesterIsCourier,
      isBranchTransferPost,
      isPrivileged,
      scopedBranchId,
      belongsToScopedBranch,
    };
  }

  /**
   * Qabul maqsad filiali (buyurtmalar `branch_id` si). O'z filialiga kelgan
   * o'tkazma pochtasining `branch_id` si boshqa bo'lsa — shu filialga
   * to'g'rilanadi (faqat `post` obyektida; chaqiruvchi saqlaydi).
   */
  private resolvePostReceiveTargetBranch(
    post: Post,
    access: PostReceiveAccess,
  ): string | undefined {
    const { scopedBranchId, belongsToScopedBranch, isBranchTransferPost } =
      access;
    if (
      scopedBranchId &&
      belongsToScopedBranch &&
      isBranchTransferPost &&
      String(post.branch_id ?? '').trim() !== scopedBranchId
    ) {
      post.branch_id = scopedBranchId;
    }

    return (
      String(post.branch_id ?? '').trim() ||
      (belongsToScopedBranch ? String(scopedBranchId) : '') ||
      undefined
    );
  }

  async receivePost(
    requester: RequesterContext,
    id: string,
    dto: ReceivePostDto,
  ) {
    // Skaner bilan qabul (2026-11-07): faqat skanlangan buyurtma qabul
    // qilinadi, qolgan yo'ldagilarga tegilmaydi — alohida yo'l (ruxsat bloki
    // bir xil). `scan` berilmasa — avvalgi bulk qoida.
    if (dto?.scan === true) {
      return this.receivePostByScan(requester, id, dto);
    }

    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Pochta topilmadi');
    }
    const waitingOrderIds = [
      ...new Set((dto.order_ids ?? []).map((orderId) => String(orderId))),
    ];
    const waitingOrderIdSet = new Set(waitingOrderIds);
    const allOrders = await this.findOrders({
      post_id: id,
      page: 1,
      limit: 1000,
    });
    const access = await this.assertPostReceiveAccess(
      requester,
      post,
      allOrders,
    );
    const { requesterIsCourier, isBranchTransferPost, isPrivileged } = access;

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
      this.badRequest("Bu holatdagi pochtani qabul qilib bo'lmaydi");
    }

    const targetBranchId = this.resolvePostReceiveTargetBranch(post, access);

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

    // vbu7Wr3o #1: qabul tracking'i qabul qilgan xodim nomidan (ilgari
    // so'rovchisiz — «Tizim buyurtmani kutilmoqda holatiga qaytardi»).
    const receiveActor = this.postReceiveTrackingActor(
      requester,
      requesterIsCourier ? 'COURIER' : 'BRANCH',
    );
    // Ro'yxat (`allOrders`) qulfsiz surat — yozuvlar shartli: buyurtma hali
    // shu pochtada va o'sha holatda bo'lsin (order-service qulf ostida, aks
    // holda 409). Shu orada HQ «Qaytarish» tasdig'i HQ omboriga olgan
    // buyurtma filialga qayta yozilmaydi (2026-11-04).
    const receiveGuard = (order: OrderRow) => ({
      post_id: String(post.id),
      status: order.status ?? null,
    });
    for (const orderId of waitingOrderIds) {
      const target = orderById.get(orderId);
      // Bulk himoya (2026-11-07): sotilgan / to'langan / bekor / yopilgan
      // buyurtma «kutilmoqda» ga QAYTARILMAYDI (holat mashinasi SOLD → WAITING
      // ga rollback uchun ruxsat beradi — pul oyoqlari qolgan sotuv qabul
      // orqali «kutilmoqda» ga tushib qolardi).
      if (target && POST_RECEIVE_BLOCKED_STATUSES.has(String(target.status))) {
        failures.push({
          order_id: String(orderId),
          error: `${POST_SCAN_ORDER_NOT_RECEIVABLE_MESSAGE} (holati: ${String(target.status)})`,
        });
        failedSelectedOrderIds.push(String(orderId));
        continue;
      }
      if (target && target.status !== Order_status.WAITING) {
        try {
          await this.updateOrder(
            orderId,
            {
              status: Order_status.WAITING,
              return_requested: false,
              ...(targetBranchId ? { branch_id: targetBranchId } : {}),
            },
            { ...receiveActor, post_receive_guard: receiveGuard(target) },
          );
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
          await this.updateOrder(
            order.id,
            {
              status: Order_status.ON_THE_ROAD,
              return_requested: true,
              ...(targetBranchId ? { branch_id: targetBranchId } : {}),
              // Belgisiz, lekin eski initiate-return sababi qolgan — u
              // qoldiqni HQ «Qaytarish» ro'yxatidan yashirardi.
              ...(order.return_requested !== true &&
              this.hasMarketReturnReason(order)
                ? { return_reason: null }
                : {}),
            },
            { post_receive_guard: receiveGuard(order) },
          );
        } catch (err) {
          // Shu orada pochtadan chiqqan (HQ tasdiqlagan) — belgilanmaydi.
          if (this.isOrderGuardConflict(err, POST_RECEIVE_CONFLICT_REASON)) {
            continue;
          }
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
    // Ega qarori 4: to'liq qabul qilingan kuryer pochtasi — kuryer filialida
    // (buyurtmalar filiali yuqorida `targetBranchId` bilan yozilib bo'lgan);
    // yo'ldagi qolgani uchun SENT ga qaytgan kuryer pochtasi — filialsiz.
    await this.syncCourierPostBranch(post);
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

    // anKpzwxk (4-band): SA/ADMIN o'tkazma pochtasini manzil menejeri o'rniga
    // qabul qildi — favqulodda qabul alohida yozuv (kim, pochta, manzil filial).
    if (isBranchTransferPost && isPrivileged) {
      await this.activityLog.log({
        entity_type: 'Post',
        entity_id: String(savedPost.id),
        action: 'logistics.post_receive_override',
        new_value: { status: savedPost.status },
        ...this.auditActor(requester),
        metadata: {
          override: true,
          post_id: String(savedPost.id),
          branch_id: targetBranchId ?? null,
          received_order_ids: selectedOrders
            .filter((order) => !failedSelectedSet.has(String(order.id)))
            .map((order) => String(order.id))
            .slice(0, 10),
          order_count: allOrders.length,
        },
      });
    }

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
   * Skaner bilan qabul (2026-11-07, BeePost kabi: skan = darhol qabul) —
   * `PATCH post/receive/:id` `{ order_ids, scan: true }`.
   *
   *  - Ruxsat bloki bulk yo'l bilan AYNAN bir xil (`assertPostReceiveAccess`).
   *  - Tasnif (ruxsatdan KEYIN, pochta holati darvozasidan OLDIN): pochtada
   *    yo'q → 400 `order_not_in_post`; yo'lda (ON_THE_ROAD / WAITING_CUSTOMER)
   *    → qabul; WAITING → `already_received` (yozuvsiz, xato emas); boshqa
   *    holat → 400 `order_not_receivable`. Hammasi `already_received` bo'lsa
   *    darvoza qo'llanmaydi (200), LC-11 qayta hisob baribir bajariladi.
   *  - Faqat skanlangan buyurtma yoziladi: tanlanmagan yo'ldagilarga
   *    TEGILMAYDI (qaytarish so'rovi qo'yilmaydi, `return_reason`
   *    tozalanmaydi, filial qayta yozilmaydi).
   *  - Bir pochtaning skanlari ketma-ket: tranzaksiya + advisory qulf
   *    (`post_receive:<id>`) — qayta o'qish, yozuvlar, LC-11, pochta yozuvi va
   *    bildirishnoma qulf ostida (ikki qurilma / tez skanlar pochta holatini
   *    bir-birining ustidan yozmaydi).
   *  - Pochta yozuvi faqat `status` / `branch_id` ustunlari (`update`):
   *    `order_quantity` / `post_total_price` ni scanAssignOrder atomik
   *    oshiradi — ular ustidan yozilmaydi.
   */
  private async receivePostByScan(
    requester: RequesterContext,
    id: string,
    dto: ReceivePostDto,
  ) {
    const requestedIds = [
      ...new Set(
        (dto.order_ids ?? [])
          .map((orderId) => String(orderId ?? '').trim())
          .filter(Boolean),
      ),
    ];
    if (!requestedIds.length) {
      this.badRequest("Skanerlangan buyurtma ko'rsatilmagan");
    }

    let outcome: Awaited<ReturnType<typeof this.processScanReceive>>;
    try {
      outcome = await this.postRepo.manager.transaction(async (manager) => {
        // Navbatdagi skan qulfni gateway (8 s) voz kechgandan keyin ham
        // ulanishni band qilib kutib turmasin — 7 s dan keyin 409.
        await manager.query(
          `SET LOCAL lock_timeout = '${POST_SCAN_RECEIVE_LOCK_TIMEOUT}'`,
        );
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `${POST_SCAN_RECEIVE_LOCK_PREFIX}${id}`,
        ]);
        return this.processScanReceive(manager, requester, id, requestedIds);
      });
    } catch (err) {
      if (isLockNotAvailableError(err)) {
        throw new RpcException(
          errorRes(POST_SCAN_RECEIVE_BUSY_MESSAGE, 409, {
            reason: 'post_receive_busy',
            post_id: String(id),
          }),
        );
      }
      throw err;
    }
    const {
      post,
      access,
      targetBranchId,
      received,
      alreadyReceived,
      notReceived,
      failures,
      remainingCount,
      postStatusBefore,
      postWritten,
      orderCount,
    } = outcome;
    const postId = String(post.id);

    if (failures.length > 0) {
      this.logger.warn(
        `receivePost(scan) post=${postId}: ${failures.length} ta buyurtma qabul qilinmadi. Sample: ${failures
          .slice(0, 3)
          .map((f) => `${f.order_id}:${f.error}`)
          .join(' | ')}`,
      );
    }
    if (postWritten) {
      void this.syncPostToSearch(post);
    }

    // Har skan so'rovida bitta yozuv (kim, qaysi buyurtmalar, pochta holati).
    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: postId,
      action: 'logistics.post_scan_receive',
      new_value: { status: post.status },
      ...this.auditActor(requester),
      metadata: {
        scan: true,
        received_order_ids: received.slice(0, 10),
        already_received_order_ids: alreadyReceived.slice(0, 10),
        not_received_order_ids: notReceived.slice(0, 10),
        remaining_count: remainingCount,
        post_status: post.status,
        branch_id: targetBranchId ?? null,
        courier_id: post.courier_id ?? null,
        failed_order_count: failures.length,
      },
    });

    // Pochta STATUS_CHANGE — faqat holat haqiqatan o'zgarganda.
    if (post.status !== postStatusBefore) {
      await this.activityLog.log({
        entity_type: 'Post',
        entity_id: postId,
        action: ActivityAction.STATUS_CHANGE,
        new_value: { status: post.status },
        ...this.auditActor(requester),
        metadata: {
          scan: true,
          order_count: orderCount,
          branch_id: targetBranchId ?? null,
          courier_id: post.courier_id,
          failed_order_count: failures.length,
          not_received_order_ids: notReceived.slice(0, 10),
        },
      });
    }

    // anKpzwxk (4-band): SA/ADMIN o'tkazma pochtasini manzil menejeri o'rniga
    // qabul qildi — avvalgidek har so'rovda (qabul bo'lgan bo'lsa).
    if (access.isBranchTransferPost && access.isPrivileged && received.length) {
      await this.activityLog.log({
        entity_type: 'Post',
        entity_id: postId,
        action: 'logistics.post_receive_override',
        new_value: { status: post.status },
        ...this.auditActor(requester),
        metadata: {
          override: true,
          scan: true,
          post_id: postId,
          branch_id: targetBranchId ?? null,
          received_order_ids: received.slice(0, 10),
          order_count: orderCount,
        },
      });
    }

    // `data` — qabul qilingan (shu so'rovda yoki avval) buyurtmalar qatorlari.
    // Qabul allaqachon yozilgan: qator o'qilmasa javob yiqilmaydi (FE qayta
    // skanlasa `already_received` oladi).
    const acceptedIds = new Set([...received, ...alreadyReceived]);
    const rows = (
      await Promise.allSettled(
        requestedIds
          .filter((orderId) => acceptedIds.has(orderId))
          .map((orderId) => this.findOrderById(orderId)),
      )
    )
      .filter(
        (result): result is PromiseFulfilledResult<OrderRow> =>
          result.status === 'fulfilled',
      )
      .map((result) => result.value);

    const notReceivedReason = notReceived.length
      ? (failures.find((f) => f.order_id === notReceived[0])?.error ??
        'Buyurtma qabul qilinmadi — qayta skanerlang')
      : '';
    const message = notReceived.length
      ? `${notReceived.length === 1 ? `Buyurtma #${notReceived[0]}` : `${notReceived.length} ta buyurtma`} qabul qilinmadi: ${notReceivedReason}`
      : received.length
        ? post.status === Post_status.RECEIVED
          ? "Buyurtma qabul qilindi — pochta to'liq qabul qilindi"
          : 'Buyurtma qabul qilindi'
        : 'Buyurtma allaqachon qabul qilingan';

    return {
      ...successRes(rows, 200, message),
      failures,
      not_received_order_ids: notReceived,
      received_order_ids: received,
      already_received_order_ids: alreadyReceived,
      remaining_count: remainingCount,
      post_status: post.status,
    };
  }

  /**
   * `receivePostByScan` ning qulf ostidagi qismi (chaqiruvchi tranzaksiyasi
   * va `post_receive:<id>` advisory qulfi ichida): pochta va buyurtmalarni
   * qayta o'qish, ruxsat, tasnif, yozuvlar, LC-11, pochta yozuvi va
   * `logistics.batch_arrived`.
   */
  private async processScanReceive(
    manager: EntityManager,
    requester: RequesterContext,
    id: string,
    requestedIds: string[],
  ): Promise<ScanReceiveOutcome> {
    const post = await manager.getRepository(Post).findOne({ where: { id } });
    if (!post) {
      this.notFound('Pochta topilmadi');
    }
    const postId = String(post.id);
    const allOrders = await this.findOrders({
      post_id: id,
      page: 1,
      limit: 1000,
    });
    const access = await this.assertPostReceiveAccess(
      requester,
      post,
      allOrders,
    );

    // Tasnif — ruxsat blokidan KEYIN (begona so'rovchi buyurtma holatini
    // bilmaydi), pochta holati darvozasidan OLDIN.
    const orderById = new Map(
      allOrders.map((order) => [String(order.id), order]),
    );
    const toReceive: OrderRow[] = [];
    const waitingBefore = new Set<string>();
    for (const orderId of requestedIds) {
      const order = orderById.get(orderId);
      if (!order) {
        this.badRequest(
          POST_SCAN_ORDER_NOT_IN_POST_MESSAGE,
          rejectionData('order_not_in_post', {
            order_id: orderId,
            post_id: postId,
          }),
        );
      }
      const status = String(order.status ?? '');
      if (POST_SCAN_RECEIVABLE_STATUSES.has(status)) {
        toReceive.push(order);
      } else if (status === String(Order_status.WAITING)) {
        waitingBefore.add(orderId);
      } else {
        this.badRequest(
          POST_SCAN_ORDER_NOT_RECEIVABLE_MESSAGE,
          rejectionData('order_not_receivable', {
            order_id: orderId,
            status: status || null,
          }),
        );
      }
    }

    const postStatusBefore = post.status;
    const branchIdBefore = String(post.branch_id ?? '').trim() || null;
    const postIsReceivable =
      postStatusBefore === Post_status.SENT ||
      postStatusBefore === Post_status.RECEIVED;
    // Mavjud darvoza — faqat qabul qilinadigani bo'lsa: SENT, yoki RECEIVED +
    // yo'ldagi tanlangan (`toReceive` — hammasi yo'ldagi).
    if (toReceive.length && !postIsReceivable) {
      this.badRequest("Bu holatdagi pochtani qabul qilib bo'lmaydi");
    }

    const targetBranchId = this.resolvePostReceiveTargetBranch(post, access);

    // (ePpLHPX2) O'tkazma pochtasi faqat SENT → RECEIVED da filialga keladi:
    // nishon qidiruvi yozuvlar bilan parallel (kesh, hech qachon reject yo'q).
    const arrivalStaffIds: Promise<string[]> | null =
      this.logisticsNotifications &&
      access.isBranchTransferPost &&
      targetBranchId &&
      postStatusBefore === Post_status.SENT
        ? this.logisticsNotifications.resolveBranchStaffIds(
            targetBranchId,
            requester,
          )
        : null;

    const receiveActor = this.postReceiveTrackingActor(
      requester,
      access.requesterIsCourier ? 'COURIER' : 'BRANCH',
    );
    const failures: Array<{ order_id: string; error: string }> = [];
    const failedIds = new Set<string>();
    for (const order of toReceive) {
      const orderId = String(order.id);
      try {
        await this.updateOrder(
          orderId,
          {
            status: Order_status.WAITING,
            return_requested: false,
            ...(targetBranchId ? { branch_id: targetBranchId } : {}),
          },
          {
            ...receiveActor,
            post_receive_guard: {
              post_id: postId,
              status: order.status ?? null,
            },
          },
        );
      } catch (err) {
        failures.push({
          order_id: orderId,
          error: (err as Error)?.message ?? String(err),
        });
        failedIds.add(orderId);
      }
    }

    // Tanlanmagan yo'ldagilar — faqat LC-11 zaxira qoidasi uchun (yozuv yo'q).
    // Pochta holati qarori bulk LC-11 bilan BIR XIL: faqat ON_THE_ROAD pochtani
    // ochiq ushlaydi («mijoz kutilmoqda» skan bilan qabul qilinadi, lekin
    // RECEIVED pochtani qayta SENT ga ochmaydi va SENT da qotirib qo'ymaydi).
    const requestedSet = new Set(requestedIds);
    const remaining = allOrders.filter(
      (order) =>
        !requestedSet.has(String(order.id)) &&
        order.status === Order_status.ON_THE_ROAD,
    );

    // Natija ro'yxatlari — yozuvlardan KEYIN yangi o'qilgan qatorlardan.
    // Avval WAITING bo'lgan — doim `already_received` (yozuv bo'lmagan).
    const fresh = await this.findPostOrdersAfterScanReceive(postId);
    const received: string[] = [];
    const alreadyReceived: string[] = [];
    const notReceived: string[] = [];
    let stillOnTheRoadIds: Set<string> | null = null;
    if (fresh) {
      const freshById = new Map(
        fresh.map((order) => [String(order.id), order]),
      );
      stillOnTheRoadIds = new Set(
        fresh
          .filter((order) => order.status === Order_status.ON_THE_ROAD)
          .map((order) => String(order.id)),
      );
      for (const orderId of requestedIds) {
        if (waitingBefore.has(orderId)) {
          alreadyReceived.push(orderId);
          continue;
        }
        const row = freshById.get(orderId);
        if (
          row &&
          row.status === Order_status.WAITING &&
          String(row.post_id ?? postId) === postId
        ) {
          received.push(orderId);
          continue;
        }
        notReceived.push(orderId);
        if (!failedIds.has(orderId)) {
          failures.push({
            order_id: orderId,
            error: row
              ? `Buyurtma qabul qilinmadi — holati: ${String(row.status ?? '')}`
              : 'Buyurtma shu orada pochtadan chiqdi',
          });
        }
      }
    } else {
      for (const orderId of requestedIds) {
        if (waitingBefore.has(orderId)) {
          alreadyReceived.push(orderId);
        } else if (failedIds.has(orderId)) {
          notReceived.push(orderId);
        } else {
          received.push(orderId);
        }
      }
    }

    // LC-11 — yo'lda qolgani bor → SENT, yo'q → RECEIVED (qayta o'qish
    // yiqilsa — surat + yiqilgan tanlov bo'yicha, SENT tomonga). Faqat SENT /
    // RECEIVED pochta (bekor / yangi pochta holatiga tegilmaydi).
    const hasRemainingReceivableOrders = stillOnTheRoadIds
      ? stillOnTheRoadIds.size > 0
      : remaining.length > 0 ||
        notReceived.some(
          (orderId) =>
            orderById.get(orderId)?.status === Order_status.ON_THE_ROAD,
        );
    let postWritten = false;
    if (postIsReceivable) {
      post.status = hasRemainingReceivableOrders
        ? Post_status.SENT
        : Post_status.RECEIVED;
      // Ega qarori 4: RECEIVED kuryer pochtasi — kuryer filialida; SENT ga
      // qaytgani — filialsiz.
      await this.syncCourierPostBranch(post);
      const branchIdAfter = String(post.branch_id ?? '').trim() || null;
      const patch: { status?: Post_status; branch_id?: string | null } = {};
      if (post.status !== postStatusBefore) {
        patch.status = post.status;
      }
      if (branchIdAfter !== branchIdBefore) {
        patch.branch_id = branchIdAfter;
      }
      if (Object.keys(patch).length) {
        const arrivedNow =
          postStatusBefore === Post_status.SENT &&
          post.status === Post_status.RECEIVED;
        await this.updateScanReceivedPost(
          manager,
          postId,
          patch,
          arrivedNow && arrivalStaffIds
            ? {
                staffIds: arrivalStaffIds,
                branch_id: targetBranchId ?? null,
                // Pochtadagi yo'lda emas buyurtmalar (yangi qayta hisobdan).
                received_count: fresh
                  ? fresh.filter(
                      (order) => order.status !== Order_status.ON_THE_ROAD,
                    ).length
                  : allOrders.length,
                order_count: fresh ? fresh.length : allOrders.length,
                status: post.status,
              }
            : null,
        );
        postWritten = true;
      }
    }

    return {
      post,
      access,
      targetBranchId,
      received,
      alreadyReceived,
      notReceived,
      failures,
      remainingCount: stillOnTheRoadIds ? stillOnTheRoadIds.size : null,
      postStatusBefore,
      postWritten,
      orderCount: fresh ? fresh.length : allOrders.length,
    };
  }

  /**
   * Skan-qabul: pochtaning faqat `status` / `branch_id` ustunlari (`update`,
   * `save` EMAS — `order_quantity` / `post_total_price` ustidan yozilmaydi).
   * O'tkazma pochtasi shu so'rovda RECEIVED bo'lsa `logistics.batch_arrived`
   * AYNAN shu yozuv bilan bitta tranzaksiyada (ichki SAVEPOINT): bildirishnoma
   * yiqilsa faqat SAVEPOINT qaytariladi va pochta bildirishnomasiz yoziladi
   * (`savePostWithArrivalNotification` kabi FAIL-OPEN; qulf saqlanadi).
   */
  private async updateScanReceivedPost(
    manager: EntityManager,
    postId: string,
    patch: { status?: Post_status; branch_id?: string | null },
    arrival: {
      staffIds: Promise<string[]>;
      branch_id: string | null;
      received_count: number;
      order_count: number;
      status: Post_status;
    } | null,
  ): Promise<void> {
    const notifier = this.logisticsNotifications;
    const recipientIds = arrival ? await arrival.staffIds : [];
    if (
      !notifier ||
      !arrival ||
      arrival.received_count <= 0 ||
      !recipientIds.length
    ) {
      await manager.getRepository(Post).update({ id: postId }, patch);
      return;
    }

    try {
      await manager.transaction(async (inner) => {
        await inner.getRepository(Post).update({ id: postId }, patch);
        await notifier.onBatchArrived(
          {
            post_id: postId,
            branch_id: arrival.branch_id,
            received_count: arrival.received_count,
            order_count: arrival.order_count,
            status: arrival.status,
            recipient_ids: recipientIds,
          },
          inner,
        );
      });
    } catch (err) {
      this.logger.warn(
        `receivePost(scan): post=${postId} bildirishnoma bilan yozilmadi (savepoint rollback) — bildirishnomasiz qayta yoziladi: ${
          (err as Error)?.message ?? err
        }`,
      );
      await manager.getRepository(Post).update({ id: postId }, patch);
    }
  }

  /**
   * Skan-qabul: yozuvlardan keyin pochtaning hamma joriy buyurtmalari.
   * Yiqilsa `null` (chaqiruvchi surat bo'yicha zaxira qoidaga o'tadi).
   */
  private async findPostOrdersAfterScanReceive(
    postId: string,
  ): Promise<OrderRow[] | null> {
    try {
      return await this.findOrders({
        post_id: postId,
        fetch_all: true,
        page: 1,
        limit: 1000,
      });
    } catch (error) {
      this.logger.warn(
        `receivePost(scan): post=${postId} qayta o'qish yiqildi — natija surat bo'yicha: ${(error as Error)?.message ?? error}`,
      );
      return null;
    }
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
      this.notFound('Pochta topilmadi');
    }
    if (post.status !== Post_status.SENT) {
      this.badRequest(
        "Faqat jo'natilgan pochtani boshqa kuryerga berish mumkin",
      );
    }
    if (post.courier_id === courierId) {
      this.badRequest('Pochta allaqachon shu kuryerga biriktirilgan');
    }

    const courier = await this.findCourierById(courierId);
    if (!courier) {
      this.notFound('Kuryer topilmadi');
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
  // odam javon turgan joyda bo'lishi kerak. HQ → filial o'tkazmasining
  // filialga kelmagan buyurtmasi (menejer «kelmagan» degan yoki qisman
  // qabulda qolgan) — HQ dan chiqqan, shuning uchun HQ doirasida (2026-11-04).

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

  /**
   * Buyurtma turgan ombor: custody filiali (`holder_branch_id ?? branch_id`),
   * bo'sh bo'lsa HQ. Filial o'tkazmasidagi yo'ldagi buyurtma
   * (`isBranchTransferOrder`) — HQ: u filialga yetmagan, manba ombori HQ.
   */
  private resolveReturnCustodyBranchId(
    order: OrderRow,
    hqBranchId: string,
    transferPosts?: ReadonlyMap<string, Post>,
  ): string {
    if (transferPosts && this.isBranchTransferOrder(order, transferPosts)) {
      return hqBranchId;
    }
    return this.getOrderBranchScope(order) || hqBranchId;
  }

  /**
   * Ko'rib chiqilmagan KURYER qaytarish so'rovi. Kuryersiz qatorlar (HQ →
   * filial o'tkazmasi — `isPendingBranchTransferReturnRequest`, HQ/filialdagi
   * initiate-return belgisi) bu tekshiruvga kirmaydi.
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
   * Filial o'tkazmasidagi kabi qator: yo'lda, filial hisobida (`holder_type`
   * BRANCH), kuryersiz va pochtasi bor. Pochta turi (`isBranchTransferOrder`)
   * alohida tekshiriladi.
   */
  private isBranchTransferCandidate(order: OrderRow): boolean {
    const hasCourierRef = (value: string | null | undefined) => {
      const id = String(value ?? '').trim();
      return !!id && id !== '0';
    };
    return (
      order?.status === Order_status.ON_THE_ROAD &&
      String(order.holder_type ?? '')
        .trim()
        .toUpperCase() === 'BRANCH' &&
      !hasCourierRef(order.courier_id) &&
      !hasCourierRef(order.holder_courier_id) &&
      Boolean(String(order.post_id ?? '').trim())
    );
  }

  /**
   * HQ → filial o'tkazma pochtasidagi (courier_id '0' / bo'sh) hali qabul
   * qilinmagan buyurtma (`isBranchTransferCandidate` + pochta o'tkazma).
   * O'tkazmani faqat HQ jo'natadi (`dispatchPostToBranch`), shuning uchun
   * uning manba ombori — HQ.
   */
  private isBranchTransferOrder(
    order: OrderRow,
    transferPosts: ReadonlyMap<string, Post>,
  ): boolean {
    return (
      this.isBranchTransferCandidate(order) &&
      transferPosts.has(String(order.post_id ?? '').trim())
    );
  }

  /**
   * Ko'rib chiqilmagan FILIAL O'TKAZMASI qaytarish so'rovi: manzil filial
   * menejeri «Bu buyurtma kelmagan» degan (`requestCourierOrderReturn`) yoki
   * pochta qisman qabul qilinganda qolgan (`receivePost`) buyurtma. HQ
   * doirasida ko'riladi, tasdiqlansa HQ omboriga qaytadi.
   *
   * initiate-return (marketga qaytarish) belgisi — `return_reason` bilan —
   * bu emas: «kelmagan» so'rovi sababsiz yoziladi. Aks holda registrator
   * initiate-return bilan HQ «kelmagan» so'rovini yarata olardi, tasdiq esa
   * marketga qaytarish niyatini o'chirardi.
   */
  private isPendingBranchTransferReturnRequest(
    order: OrderRow,
    transferPosts: ReadonlyMap<string, Post>,
  ): boolean {
    return (
      order?.return_requested === true &&
      !this.hasMarketReturnReason(order) &&
      this.isBranchTransferOrder(order, transferPosts)
    );
  }

  /** initiate-return (marketga qaytarish) sababi bormi. */
  private hasMarketReturnReason(order: OrderRow): boolean {
    return Boolean(String(order?.return_reason ?? '').trim());
  }

  /**
   * Buyurtmalarning o'tkazma pochtalari (courier_id '0' / bo'sh), id → pochta
   * (tasdiqda hudud kerak). Pochta faqat o'tkazma bo'lishi mumkin bo'lgan
   * qatorlar (yo'lda, filial hisobida, kuryersiz) uchun o'qiladi — kuryer
   * so'rovlari uchun DB so'rovi yo'q. Xom DB xatosi 503 RpcException ga
   * o'raladi (qayta navbat yo'q).
   */
  private async findBranchTransferPosts(
    orders: OrderRow[],
  ): Promise<Map<string, Post>> {
    const candidatePostIds = [
      ...new Set(
        orders
          .filter((order) => this.isBranchTransferCandidate(order))
          .map((order) => String(order.post_id ?? '').trim())
          .filter(Boolean),
      ),
    ];
    if (!candidatePostIds.length) {
      return new Map<string, Post>();
    }
    let posts: Post[];
    try {
      posts = await this.postRepo.find({ where: { id: In(candidatePostIds) } });
    } catch (error) {
      this.logger.error(
        `findBranchTransferPosts post lookup failed: ${(error as Error)?.message ?? error}`,
      );
      throw new RpcException(
        errorRes(
          "Qaytarish so'rovlari pochtalarini o'qib bo'lmadi — birozdan so'ng qayta urinib ko'ring",
          503,
        ),
      );
    }
    const wanted = new Set(candidatePostIds);
    return new Map(
      posts
        .filter((post) => {
          const courierId = String(post?.courier_id ?? '').trim();
          return (
            wanted.has(String(post?.id)) && (!courierId || courierId === '0')
          );
        })
        .map((post) => [String(post.id), post] as const),
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
    transferPosts?: ReadonlyMap<string, Post>,
  ): void {
    const hasForeignOrder = orders.some(
      (order) =>
        this.resolveReturnCustodyBranchId(
          order,
          scope.hqBranchId,
          transferPosts,
        ) !== scope.branchId,
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
            // Ega qarori 4: qabul qilingan kuryer pochtasi — kuryer filialida.
            await this.syncCourierPostBranch(post);
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

  /**
   * Tasdiq/rad yozuvining sharti (order-service qulf ostida tekshiradi):
   * buyurtma o'qilgandagi pochta va holatda, belgi turibdi, egasi — kuryer
   * yoki kuryersiz filial o'tkazmasi.
   */
  private returnRequestReviewOf(
    order: OrderRow,
    transferPosts: ReadonlyMap<string, Post>,
  ): {
    post_id: string | null;
    status: string | null;
    source: 'courier' | 'branch_transfer';
  } {
    return {
      post_id: String(order.post_id ?? '').trim() || null,
      status: order.status ?? null,
      source: this.isBranchTransferOrder(order, transferPosts)
        ? 'branch_transfer'
        : 'courier',
    };
  }

  /**
   * Tasdiqlanadigan filial o'tkazmasi buyurtmalarining HQ hudud NEW pochtasi
   * (buyurtma id → pochta id). Hudud — o'tkazma pochtasiniki
   * (`dispatchPostToBranch` uni HQ NEW pochtasining hududidan yozgan), bo'sh
   * bo'lsa buyurtmaniki; ikkalasi ham yo'q — pochtasiz qoladi. Xom DB xatosi
   * — 503 RpcException (yozuvlardan oldin, hech narsa yozilmaydi).
   */
  private async resolveTransferReturnNewPosts(
    orders: OrderRow[],
    transferPosts: ReadonlyMap<string, Post>,
  ): Promise<Map<string, string>> {
    const postIdByOrderId = new Map<string, string>();
    const postIdByRegionId = new Map<string, string>();
    try {
      for (const order of orders) {
        if (!this.isBranchTransferOrder(order, transferPosts)) {
          continue;
        }
        const transferPost = transferPosts.get(
          String(order.post_id ?? '').trim(),
        );
        const regionId =
          String(transferPost?.region_id ?? '').trim() ||
          String(order.region_id ?? '').trim();
        if (!regionId) {
          continue;
        }
        let postId = postIdByRegionId.get(regionId);
        if (!postId) {
          postId = String((await this.findOrCreateRegionNewPost(regionId)).id);
          postIdByRegionId.set(regionId, postId);
        }
        postIdByOrderId.set(String(order.id), postId);
      }
    } catch (error) {
      this.logger.error(
        `resolveTransferReturnNewPosts failed: ${(error as Error)?.message ?? error}`,
      );
      throw new RpcException(
        errorRes(
          "HQ pochtasini tayyorlab bo'lmadi — birozdan so'ng qayta urinib ko'ring",
          503,
        ),
      );
    }
    return postIdByOrderId;
  }

  /**
   * Hududning HQ NEW pochtasi (filialsiz); yo'q bo'lsa yaratiladi. Yetim
   * RECEIVED buyurtmalar (`newPosts`) va HQ «Qaytarish» tasdig'idagi filialga
   * kelmagan o'tkazma buyurtmasi bir xil qoida bilan joylanadi.
   */
  private async findOrCreateRegionNewPost(regionId: string): Promise<Post> {
    let post = await this.postRepo.findOne({
      where: {
        region_id: regionId,
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
          region_id: regionId,
          branch_id: null,
          status: Post_status.NEW,
          post_total_price: 0,
          order_quantity: 0,
        }),
      );
      void this.syncPostToSearch(post);
    }
    return post;
  }

  /**
   * HQ «Qaytarish» tasdig'ida NEW pochtaga qaytgan buyurtmalar hisobi
   * (atomik oshirish, `newPosts` kabi). Faqat ko'rinish uchun — `newPosts`
   * sonni buyurtmalardan qayta hisoblaydi — xato log qilinadi, tasdiq
   * to'xtamaydi.
   */
  private async addOrdersToNewPosts(
    deltas: Map<string, { count: number; total: number }>,
  ): Promise<void> {
    for (const [postId, delta] of deltas) {
      try {
        const count = Number.isFinite(delta.count) ? delta.count : 0;
        const total = Number.isFinite(delta.total) ? delta.total : 0;
        await this.postRepo
          .createQueryBuilder()
          .update(Post)
          .set({
            order_quantity: () => `order_quantity + ${count}`,
            post_total_price: () => `post_total_price + ${total}`,
          })
          .where('id = :id', { id: postId })
          .execute();
        const refreshed = await this.postRepo.findOne({
          where: { id: postId },
        });
        if (refreshed) {
          void this.syncPostToSearch(refreshed);
        }
      } catch (error) {
        this.logger.warn(
          `addOrdersToNewPosts failed for post=${postId}: ${(error as Error)?.message ?? error}`,
        );
      }
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

    // Filial o'tkazmasi so'rovlari (manzil filial menejeri «kelmagan» degan
    // yoki qisman qabulda qolgan) — manba ombori HQ, shuning uchun faqat HQ
    // doirasida; filial ularni o'zi tasdiqlab o'z omboriga ololmaydi.
    const transferCandidates =
      scope.type === 'HQ'
        ? await this.findOrders({
            status: Order_status.ON_THE_ROAD,
            return_requested: true,
            holder_type: 'BRANCH',
            fetch_all: true,
            page: 1,
            limit: 1000,
          })
        : [];
    const transferPosts =
      await this.findBranchTransferPosts(transferCandidates);
    const transferOrders = transferCandidates.filter((order) =>
      this.isPendingBranchTransferReturnRequest(order, transferPosts),
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
        /** Faqat filial o'tkazmasi guruhida: `branch_transfer` + manzil filial. */
        source?: 'branch_transfer';
        branch_id?: string | null;
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

    // Filial o'tkazmasi — kuryersiz; manzil filial bo'yicha alohida guruh.
    for (const order of transferOrders) {
      const branchId = this.getOrderBranchScope(order) || null;
      const key = `branch_transfer:${branchId ?? ''}`;
      const group = groups.get(key) ?? {
        courier: null,
        courier_id: null,
        orders: [],
        source: 'branch_transfer' as const,
        branch_id: branchId,
      };
      group.orders.push(order);
      groups.set(key, group);
    }

    return successRes(
      {
        total: orders.length + transferOrders.length,
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
   * Kuryer qatori — RECEIVED EMAS: WAITING/ON_THE_ROAD dan RECEIVED ga
   * umumiy qonuniy o'tish yo'q (istisno — pastdagi filial o'tkazmasi).
   * Hudud NEW pochtasi EMAS: NEW pochtadagi WAITING buyurtma sendPost va
   * dispatchPostToBranch ni buzardi. `post_id: null` — eski kuryer nomidan
   * kutilayotgan sotuv/bekor tasdig'i keyin ishlab ketmasin.
   *
   * Filial o'tkazmasi so'rovi (`isPendingBranchTransferReturnRequest`, faqat
   * HQ doirasi) — manba ombori HQ: buyurtma filialga yetmagan, HQ omboriga
   * DISPATCH OLDIDAGI holatida qaytadi — RECEIVED + hudud NEW pochtasi
   * (o'tkazma pochtasining hududi), holder HQ. WAITING + pochtasiz bo'lsa
   * uni filialga qayta jo'natib bo'lmasdi: `dispatchPostToBranch` faqat NEW
   * pochtadagi RECEIVED ni oladi, HQ kuryeri esa boshqa viloyat buyurtmasini
   * ololmaydi. `on the road → received` faqat shu tasdiqqa ruxsat
   * (order-service `return_request_review.source: 'branch_transfer'`).
   * O'tkazma pochtasini shu tasdiq yopadi (`releaseReturnSourcePosts`).
   *
   * Har yozuv shartli (`return_request_review`): buyurtma qulfsiz o'qilgan,
   * order-service uni qulf ostida qayta tekshiradi — shu orada filial qabul
   * qilgan yoki boshqa xodim ko'rib chiqqan buyurtma yozilmaydi (409) va
   * eskirgan tanlov sifatida o'tkazib yuboriladi.
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
    const transferPosts = await this.findBranchTransferPosts(orders);
    this.assertReturnRequestsInScope(orders, scope, transferPosts);

    const isPending = (order: OrderRow) =>
      this.isPendingCourierReturnRequest(order) ||
      this.isPendingBranchTransferReturnRequest(order, transferPosts);
    const eligibleOrders = orders.filter(isPending);
    // Eskirgan tanlov (ikki marta bosish, kuryer shu orada qabul qilgan) —
    // o'tkazib yuboriladi va javobda qaytariladi.
    const skippedOrderIds = orders
      .filter((order) => !isPending(order))
      .map((order) => String(order.id));
    if (!eligibleOrders.length) {
      this.notFound(
        "Tanlangan buyurtmalarda ko'rib chiqilmagan qaytarish so'rovi topilmadi",
      );
    }
    // Filial o'tkazmasi buyurtmalarining HQ NEW pochtasi — yozuvlardan OLDIN
    // (xato bo'lsa hech narsa yozilmaydi).
    const hqNewPostIdByOrderId = await this.resolveTransferReturnNewPosts(
      eligibleOrders,
      transferPosts,
    );

    const noteOf = (order: OrderRow): string =>
      requester?.note ??
      (this.isBranchTransferOrder(order, transferPosts)
        ? "Qaytarish so'rovi tasdiqlandi — filialga kelmagan buyurtma HQ omboriga qaytarildi (qayta jo'natish mumkin)"
        : scope.type === 'HQ'
          ? "Qaytarish so'rovi tasdiqlandi — buyurtma kuryerdan HQ omboriga qaytarildi"
          : "Qaytarish so'rovi tasdiqlandi — buyurtma kuryerdan filial omboriga qaytarildi");
    const returnDtoOf = (
      order: OrderRow,
      custodyBranchId: string,
    ): Record<string, unknown> =>
      this.isBranchTransferOrder(order, transferPosts)
        ? {
            status: Order_status.RECEIVED,
            return_requested: false,
            courier_id: null,
            assigned_at: null,
            post_id: hqNewPostIdByOrderId.get(String(order.id)) ?? null,
            branch_id: custodyBranchId,
          }
        : {
            status: Order_status.WAITING,
            return_requested: false,
            courier_id: null,
            assigned_at: null,
            post_id: null,
            branch_id: custodyBranchId,
          };
    const approvedOrderIds: string[] = [];
    const destinationBranchIds = new Set<string>();
    const postDeltas = new Map<string, { count: number; total: number }>();
    const newPostDeltas = new Map<string, { count: number; total: number }>();
    let staleCount = 0;
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
        this.resolveReturnCustodyBranchId(
          order,
          scope.hqBranchId,
          transferPosts,
        ),
      );
      const results = await Promise.allSettled(
        chunk.map((order, index) =>
          this.updateOrder(
            String(order.id),
            returnDtoOf(order, custodyBranchIds[index]),
            {
              id: requester?.id ?? 'system',
              roles: requester?.roles ?? [],
              note: noteOf(order),
              return_request_review: this.returnRequestReviewOf(
                order,
                transferPosts,
              ),
            },
          ),
        ),
      );

      for (let index = 0; index < chunk.length; index += 1) {
        const order = chunk[index];
        const result = results[index];
        if (
          result.status === 'rejected' &&
          this.isOrderGuardConflict(
            result.reason,
            RETURN_REQUEST_REVIEW_CONFLICT_REASON,
          )
        ) {
          // Shu orada qabul qilingan / ko'rib chiqilgan (qulf ostida 409,
          // hech narsa yozilmagan) — eskirgan tanlov, xato emas.
          skippedOrderIds.push(String(order.id));
          staleCount += 1;
          continue;
        }
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
                    errorRes(`Buyurtma #${String(order.id)} yangilanmadi`, 502),
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
        const newPostId = this.isBranchTransferOrder(order, transferPosts)
          ? hqNewPostIdByOrderId.get(String(order.id))
          : undefined;
        if (newPostId) {
          const delta = newPostDeltas.get(newPostId) ?? { count: 0, total: 0 };
          delta.count += 1;
          delta.total += Number(order.total_price ?? 0);
          newPostDeltas.set(newPostId, delta);
        }
      }
    }

    if (!approvedOrderIds.length && !updateError && staleCount) {
      this.conflict(
        "Tanlangan buyurtmalar shu orada qabul qilingan yoki ko'rib chiqilgan — sahifani yangilang",
      );
    }

    if (approvedOrderIds.length) {
      // HQ NEW pochtasi hisobi — faqat ko'rinish (`newPosts` sonni qayta
      // hisoblaydi), shuning uchun xatosi tasdiqni to'xtatmaydi.
      await this.addOrdersToNewPosts(newPostDeltas);
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
   * va kuryer uni baribir qabul qilishi kerak. Filial o'tkazmasi so'rovi —
   * xuddi shunday: buyurtma o'tkazma pochtasida qoladi, filial qabul qiladi.
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
    const transferPosts = await this.findBranchTransferPosts(orders);
    this.assertReturnRequestsInScope(orders, scope, transferPosts);

    const isPending = (order: OrderRow) =>
      this.isPendingCourierReturnRequest(order) ||
      this.isPendingBranchTransferReturnRequest(order, transferPosts);
    const eligibleOrders = orders.filter(isPending);
    const skippedOrderIds = orders
      .filter((order) => !isPending(order))
      .map((order) => String(order.id));
    if (!eligibleOrders.length) {
      this.notFound(
        "Tanlangan buyurtmalarda ko'rib chiqilmagan qaytarish so'rovi topilmadi",
      );
    }

    const rejectedOrderIds: string[] = [];
    // CODE-10 — tasdiqlash bilan bir xil: bo'laklab parallel; birinchi xato
    // shu bo'lakdan keyin qaytadi (avvalgidek log yozilmaydi). Yozuv shartli
    // (`return_request_review`): shu orada qabul qilingan / ko'rib chiqilgan
    // buyurtma o'tkazib yuboriladi.
    let staleCount = 0;
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
                (this.isBranchTransferOrder(order, transferPosts)
                  ? "Qaytarish so'rovi rad etildi — buyurtma filial pochtasida qoldi"
                  : "Qaytarish so'rovi rad etildi — buyurtma kuryerda qoldi"),
              return_request_review: this.returnRequestReviewOf(
                order,
                transferPosts,
              ),
            },
          ),
        ),
      );
      const isStale = (result: PromiseSettledResult<void>) =>
        result.status === 'rejected' &&
        this.isOrderGuardConflict(
          result.reason,
          RETURN_REQUEST_REVIEW_CONFLICT_REASON,
        );
      const failedIndex = results.findIndex(
        (result) => result.status === 'rejected' && !isStale(result),
      );
      if (failedIndex >= 0) {
        const reason = (results[failedIndex] as PromiseRejectedResult)
          .reason as unknown;
        throw reason instanceof RpcException
          ? reason
          : new RpcException(
              errorRes(
                `Buyurtma #${String(chunk[failedIndex].id)} yangilanmadi`,
                502,
              ),
            );
      }
      chunk.forEach((order, index) => {
        if (isStale(results[index])) {
          skippedOrderIds.push(String(order.id));
          staleCount += 1;
        } else {
          rejectedOrderIds.push(String(order.id));
        }
      });
    }

    if (!rejectedOrderIds.length && staleCount) {
      this.conflict(
        "Tanlangan buyurtmalar shu orada qabul qilingan yoki ko'rib chiqilgan — sahifani yangilang",
      );
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
      "Qaytarish so'rovlari rad etildi — buyurtmalar joyida qoldi (kuryerda yoki filial pochtasida)",
    );
  }

  async receivePostWithScanner(requester: RequesterContext, token: string) {
    const post = await this.postRepo.findOne({
      where: { qr_code_token: token, courier_id: requester.id },
    });
    if (!post) {
      this.notFound('Pochta topilmadi');
    }
    if (post.status !== Post_status.SENT) {
      this.badRequest("Pochtani qabul qilib bo'lmaydi");
    }

    const orders = await this.findOrders({
      post_id: post.id,
      status: Order_status.ON_THE_ROAD,
      page: 1,
      limit: 1000,
    });

    if (!orders.length) {
      this.notFound("Bu pochtada buyurtma yo'q");
    }

    // CODE-09 / C13 — skan bilan qabul qilingan posilka kuryer qo'lida:
    // eski qaytarish so'rovi belgisi tozalanadi (receivePost bilan bir xil),
    // aks holda u menejerning "Qaytarish" ro'yxatida so'rov bo'lib chiqib,
    // tasdiqlansa custody kuryerdan filialga o'tib ketardi.
    // vbu7Wr3o #1: qabul — kuryer nomidan (tizim emas).
    const receiveActor = this.postReceiveTrackingActor(requester, 'COURIER');
    for (const order of orders) {
      await this.updateOrder(
        order.id,
        {
          status: Order_status.WAITING,
          return_requested: false,
        },
        receiveActor,
      );
    }

    post.status = Post_status.RECEIVED;
    // Ega qarori 4: qabul qilingan kuryer pochtasi — kuryer filialida.
    await this.syncCourierPostBranch(post);
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
      this.notFound('Buyurtma hech qaysi pochtada emas');
    }

    const post = await this.postRepo.findOne({
      where: { id: String(order.post_id), courier_id: requester.id },
    });
    if (!post) {
      this.notFound('Pochta topilmadi yoki bu kuryerga biriktirilmagan');
    }

    // Holat himoyasi (2026-11-07): faqat yo'ldagi buyurtma qabul qilinadi —
    // sotilgan / bekor / allaqachon «kutilmoqda» buyurtma qayta yozilmaydi
    // (holat mashinasi SOLD → WAITING ga ruxsat beradi).
    const orderStatus = String(order.status ?? '');
    if (!POST_SCAN_RECEIVABLE_STATUSES.has(orderStatus)) {
      this.badRequest(
        POST_SCAN_ORDER_NOT_RECEIVABLE_MESSAGE,
        rejectionData('order_not_receivable', {
          order_id: String(order.id),
          status: orderStatus || null,
        }),
      );
    }

    // CODE-09 / C13 — qaytarish so'rovi belgisi tozalanadi (yuqoriga qarang).
    // vbu7Wr3o #1: qabul — kuryer nomidan (tizim emas).
    await this.updateOrder(
      order.id,
      {
        status: Order_status.WAITING,
        return_requested: false,
      },
      this.postReceiveTrackingActor(requester, 'COURIER'),
    );

    const remaining = await this.findOrders({
      post_id: post.id,
      status: Order_status.ON_THE_ROAD,
      page: 1,
      limit: 1,
    });

    let postReceived = false;
    if (!remaining.length) {
      post.status = Post_status.RECEIVED;
      // Ega qarori 4: qabul qilingan kuryer pochtasi — kuryer filialida.
      await this.syncCourierPostBranch(post);
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
   * Kuryer «Bu buyurtma kelmagan — qaytarish so'rovi» (egasi qarori
   * 2026-11-03, BeePost kabi): yangi (SENT) pochtadagi hali qabul qilinmagan
   * buyurtma jismonan kelmagan. Buyurtma yo'lda qoladi va `return_requested`
   * belgisi qo'yiladi — qisman qabuldagi so'rov bilan bir xil: «Qaytarish»
   * ro'yxatiga tushadi, tasdiqlansa kelgan omboriga (HQ yoki filial) qaytadi,
   * rad etilsa kuryerda qoladi. Pochta shu yerda yopilmaydi — tasdiq yopadi
   * (`releaseReturnSourcePosts`). Kuryer o'zi skan qilib olgan posilka (u
   * qo'lida) va qabul qilingani — rad.
   *
   * Filial menejeri (egasi talabi 2026-11-04) — o'z filialiga jo'natilgan
   * o'tkazma pochtasida (courier_id '0'): `requestBranchTransferOrderReturn`.
   * Boshqa rol — 403 `return_request_not_allowed`.
   */
  async requestCourierOrderReturn(
    requester: RequesterContext,
    postId: string,
    orderId: string,
  ) {
    const requesterRoles = (requester?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    const requesterIsCourier = requesterRoles.includes(Roles.COURIER);
    if (requesterRoles.includes(Roles.MANAGER)) {
      const transferPost = await this.postRepo.findOne({
        where: { id: String(postId) },
      });
      const transferCourierId = String(transferPost?.courier_id ?? '').trim();
      if (transferPost && (!transferCourierId || transferCourierId === '0')) {
        return this.requestBranchTransferOrderReturn(
          requester,
          transferPost,
          orderId,
        );
      }
      if (!transferPost && !requesterIsCourier) {
        this.notFound('Pochta topilmadi');
      }
    }
    // Kuryer pochtasi — faqat o'sha kuryerning o'zi (quyida, avvalgidek).
    if (!requesterIsCourier) {
      this.forbidden(
        RETURN_REQUEST_NOT_ALLOWED_MESSAGE,
        rejectionData('return_request_not_allowed', {
          post_id: String(postId),
        }),
      );
    }

    const post = await this.postRepo.findOne({
      where: { id: String(postId), courier_id: requester.id },
    });
    if (!post) {
      this.notFound('Pochta topilmadi yoki bu kuryerga biriktirilmagan');
    }
    if (post.status !== Post_status.SENT) {
      this.badRequest(
        "Bu pochta allaqachon qabul qilingan — qaytarish so'rovini yuborib bo'lmaydi",
      );
    }

    const order = await this.findOrderById(orderId);
    if (String(order.post_id ?? '').trim() !== String(post.id)) {
      this.conflict(
        "Buyurtma bu pochtada emas (boshqa pochtaga o'tgan bo'lishi mumkin) — sahifani yangilang",
      );
    }
    if (order.status !== Order_status.ON_THE_ROAD) {
      this.badRequest(
        "Bu buyurtma allaqachon qabul qilingan yoki yo'lda emas — qaytarish so'rovini yuborib bo'lmaydi",
      );
    }

    const remainingReceivable = () =>
      this.countReceivableInPost(String(post.id));

    if (order.return_requested === true) {
      return successRes(
        {
          order_id: String(order.id),
          post_id: String(post.id),
          return_requested: true,
          already_requested: true,
          remaining_receivable: await remainingReceivable(),
        },
        200,
        "Qaytarish so'rovi allaqachon yuborilgan",
      );
    }
    if (String(order.holder_type ?? '').toUpperCase() !== 'COURIER') {
      this.conflict(
        "Buyurtma kuryer hisobida emas — qaytarish so'rovini yuborib bo'lmaydi, sahifani yangilang",
      );
    }
    if (isCourierScanTakenOrder(order, requester.id)) {
      this.badRequest(
        "Bu buyurtmani o'zingiz skanerlab olgansiz — u sizda, «kelmagan» deb bo'lmaydi",
      );
    }

    await this.updateOrder(
      String(order.id),
      { return_requested: true },
      {
        id: requester.id,
        roles: requester.roles ?? [Roles.COURIER],
        note: 'Courier reported the order did not arrive — return requested',
        courier_return_request: { post_id: String(post.id) },
      },
    );

    await Promise.resolve(
      this.activityLog.log({
        entity_type: 'Order',
        entity_id: String(order.id),
        action: 'logistics.return_request',
        old_value: { return_requested: false },
        new_value: { return_requested: true },
        ...this.auditActor(requester),
        metadata: {
          post_id: String(post.id),
          courier_id: String(post.courier_id ?? ''),
          source: 'courier_not_arrived',
        },
      }),
    ).catch(() => undefined);

    return successRes(
      {
        order_id: String(order.id),
        post_id: String(post.id),
        return_requested: true,
        already_requested: false,
        remaining_receivable: await remainingReceivable(),
      },
      200,
      "Qaytarish so'rovi yuborildi",
    );
  }

  /**
   * «Bu buyurtma kelmagan» javobidagi `remaining_receivable`: pochtada hali
   * qabul qilinadigan (yo'lda, qaytarish so'rovisiz) buyurtmalar soni.
   */
  private async countReceivableInPost(postId: string): Promise<number> {
    const onTheRoad = await this.findOrders({
      post_id: postId,
      status: Order_status.ON_THE_ROAD,
      fetch_all: true,
      page: 1,
      limit: 100,
    });
    return onTheRoad.filter((row) => row.return_requested !== true).length;
  }

  /**
   * Filial menejeri «Bu buyurtma kelmagan — qaytarish so'rovi» (egasi talabi
   * 2026-11-04, kuryerniki bilan bir xil): HQ → filial o'tkazma pochtasidagi
   * (courier_id '0' / bo'sh, SENT) hali qabul qilinmagan buyurtma filialga
   * jismonan kelmagan. Faqat manzil filial MENEJERI (anKpzwxk 4-band — qabul
   * ham faqat uniki); filial doirasi `receivePost` bilan bir xil: pochta shu
   * filialniki yoki undagi hamma buyurtma shu filialda. SA/ADMIN — kerak emas
   * (doirasiz, 403).
   *
   * Buyurtma yo'lda qoladi va `return_requested` qo'yiladi — qisman qabulda
   * qolgan buyurtma bilan bir xil: HQ «Qaytarish» ro'yxatiga tushadi,
   * tasdiqlansa HQ omboriga qaytadi, rad etilsa pochtada qoladi (filial qabul
   * qiladi). Pochta shu yerda yopilmaydi — tasdiq yopadi.
   */
  private async requestBranchTransferOrderReturn(
    requester: RequesterContext,
    post: Post,
    orderId: string,
  ) {
    const postId = String(post.id);
    const scopedBranchId = String(
      (await this.resolveScopedBranchId(requester)) ?? '',
    ).trim();
    const postBranchId = String(post.branch_id ?? '').trim();
    let isOwnBranchPost =
      Boolean(scopedBranchId) && postBranchId === scopedBranchId;
    if (scopedBranchId && !isOwnBranchPost) {
      const postOrders = await this.findOrders({
        post_id: postId,
        page: 1,
        limit: 1000,
      });
      const orderBranchIds = new Set(
        postOrders.map((row) => this.getOrderBranchScope(row)).filter(Boolean),
      );
      isOwnBranchPost =
        orderBranchIds.size === 1 && orderBranchIds.has(scopedBranchId);
    }
    if (!isOwnBranchPost) {
      // anKpzwxk (#621 bilan bir xil): begona filialga pochta qaysi filialga
      // ketayotgani oshkor qilinmaydi — `details` da faqat `post_id`.
      this.forbidden(
        RETURN_REQUEST_NOT_ALLOWED_MESSAGE,
        rejectionData('return_request_not_allowed', {
          post_id: postId,
        }),
      );
    }
    if (post.status !== Post_status.SENT) {
      this.badRequest(
        "Bu pochta allaqachon qabul qilingan — qaytarish so'rovini yuborib bo'lmaydi",
      );
    }

    const order = await this.findOrderById(orderId);
    if (String(order.post_id ?? '').trim() !== postId) {
      this.conflict(
        "Buyurtma bu pochtada emas (boshqa pochtaga o'tgan bo'lishi mumkin) — sahifani yangilang",
      );
    }
    if (order.status !== Order_status.ON_THE_ROAD) {
      this.badRequest(
        "Bu buyurtma allaqachon qabul qilingan yoki yo'lda emas — qaytarish so'rovini yuborib bo'lmaydi",
      );
    }

    // O'tkazmadagi buyurtma filial hisobida (dispatch: holder BRANCH, manzil
    // filial) va kuryersiz — boshqasi shu orada o'zgargan. Belgi bor-yo'qligi
    // begona buyurtma uchun oshkor bo'lmasin — idempotent javobdan OLDIN.
    if (
      !this.isBranchTransferCandidate(order) ||
      this.getOrderBranchScope(order) !== scopedBranchId
    ) {
      this.conflict(
        "Buyurtma bu filial pochtasi hisobida emas — qaytarish so'rovini yuborib bo'lmaydi, sahifani yangilang",
      );
    }

    if (order.return_requested === true) {
      // initiate-return (marketga qaytarish) belgisi «kelmagan» so'rovi EMAS
      // — jim «allaqachon yuborilgan» javobi filial xabarini yo'qotardi
      // (tarix qatori ham, jurnal ham yozilmasdi).
      if (this.hasMarketReturnReason(order)) {
        this.conflict(
          "Bu buyurtmada marketga qaytarish so'rovi turibdi — uni «kelmagan» deb belgilab bo'lmaydi, HQ bilan bog'laning",
          rejectionData('market_return_requested', {
            order_id: String(order.id),
            post_id: postId,
          }),
        );
      }
      return successRes(
        {
          order_id: String(order.id),
          post_id: postId,
          return_requested: true,
          already_requested: true,
          remaining_receivable: await this.countReceivableInPost(postId),
        },
        200,
        "Qaytarish so'rovi allaqachon yuborilgan",
      );
    }

    await this.updateOrder(
      String(order.id),
      {
        return_requested: true,
        // Belgi yo'q, lekin eski initiate-return sababi qolgan — u so'rovni
        // HQ ro'yxatidan yashirardi (`isPendingBranchTransferReturnRequest`).
        ...(this.hasMarketReturnReason(order) ? { return_reason: null } : {}),
      },
      {
        id: requester.id,
        roles: requester.roles ?? [Roles.MANAGER],
        note: 'Branch manager reported the order did not arrive — return requested',
        branch_return_request: { post_id: postId },
      },
    );

    await Promise.resolve(
      this.activityLog.log({
        entity_type: 'Order',
        entity_id: String(order.id),
        action: 'logistics.return_request',
        old_value: { return_requested: false },
        new_value: { return_requested: true },
        ...this.auditActor(requester),
        metadata: {
          post_id: postId,
          branch_id: scopedBranchId,
          source: 'branch_not_arrived',
        },
      }),
    ).catch(() => undefined);

    return successRes(
      {
        order_id: String(order.id),
        post_id: postId,
        return_requested: true,
        already_requested: false,
        remaining_receivable: await this.countReceivableInPost(postId),
      },
      200,
      "Qaytarish so'rovi yuborildi",
    );
  }

  /**
   * Har kun — alohida pochta: skan buyurtmani kuryerning kechagi ochiq (SENT)
   * pochtasidan bugungisiga ko'chirdi. Eski pochta hisobidan ayiriladi va
   * unda kuryer qo'lidagi (yo'lda yoki mijoz kutmoqda) buyurtma qolmasa
   * yopiladi (RECEIVED, kuryer filialida) — aks holda u bo'sh «yo'lda» karta
   * bo'lib abadiy qolardi. Skan allaqachon bajarilgan: xato faqat logga.
   */
  private async releaseCourierPostAfterMove(
    post: Post,
    order: OrderRow,
  ): Promise<void> {
    const postId = String(post.id);
    try {
      const total = Number(order.total_price ?? 0);
      await this.postRepo
        .createQueryBuilder()
        .update(Post)
        .set({
          order_quantity: () => 'GREATEST(order_quantity - 1, 0)',
          post_total_price: () =>
            `GREATEST(post_total_price - ${Number.isFinite(total) ? total : 0}, 0)`,
        })
        .where('id = :id', { id: postId })
        .execute();

      const fresh = await this.postRepo.findOne({ where: { id: postId } });
      if (!fresh) return;
      if (fresh.status === Post_status.SENT) {
        const held = await this.findOrders({
          post_id: postId,
          status: [Order_status.ON_THE_ROAD, Order_status.WAITING_CUSTOMER],
          page: 1,
          limit: 10,
        });
        if (!held.length) {
          fresh.status = Post_status.RECEIVED;
          await this.syncCourierPostBranch(fresh);
          const saved = await this.postRepo.save(fresh);
          void this.syncPostToSearch(saved);
          return;
        }
      }
      void this.syncPostToSearch(fresh);
    } catch (error) {
      this.logger.warn(
        `Old courier post release failed post=${postId} order=${order.id}: ${(error as Error)?.message ?? error}`,
      );
    }
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
      this.badRequest('qr_token majburiy');
    }

    let order = await this.findOrderByQrToken(qrToken);
    const courierAssignment = await this.findCourierAssignment(requester);
    const courierBranchId = courierAssignment.branchId;
    let orderBranchId = String(order.branch_id ?? '').trim();
    // P1b skan-qabuli bajarildimi (qamrov rad xabari uchun).
    let receivedIntoBranchByScan = false;

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
      // anKpzwxk (6-band): HQ kuryeri faqat HQ viloyati buyurtmasini oladi —
      // HQ viloyati (filial qatori yo'q — `null`, fail closed) va buyurtma
      // XIZMAT viloyati (tuman → `assigned_region ?? region_id`).
      const hqBranch =
        courierAssignment.branch ??
        (await this.findBranchCoverageRow(courierBranchId));
      const districtOf = await this.loadOrderDistricts([order]);
      const scanInput = {
        order,
        orderPost,
        hqBranchId: courierBranchId,
        requesterId,
        hqRegionId: hqBranch?.region_id ?? null,
        orderRegionId: effectiveOrderRegionId({
          district: districtOf(order),
          orderRegionId: order.region_id,
        }),
      };
      let rejection = assessHqCourierScan(scanInput);
      // «Eski filialda tugasin» HQ uchun ham: HQ qamrov imtiyozi bor
      // buyurtma (tuman HQ viloyatidan ko'chgan / deploy paytida HQ kuryerida
      // bo'lgan — migratsiya 1716000000211) HQ kuryeriga beriladi. Imtiyoz
      // faqat 8-qoida rad etganda so'raladi (HQ viloyati bor, buyurtma
      // viloyati boshqa; boshqa rad javoblari va qayta skan DB'ga bormaydi);
      // o'qib bo'lmasa — 503 (fail closed).
      if (
        rejection?.reason === 'OUT_OF_HQ_REGION' &&
        (await this.findCoverageExemptOrderIds([order], courierBranchId)).size
      ) {
        rejection = assessHqCourierScan({ ...scanInput, coverageExempt: true });
      }
      if (rejection) {
        const code = rejection.details?.reason;
        const fields: Record<string, string | string[]> = {
          order_ids: [String(order.id)],
        };
        if (code === 'branch_region_missing') {
          fields.branch_id = courierBranchId;
        }
        throw new RpcException(
          errorRes(
            rejection.message,
            rejection.statusCode,
            code ? rejectionData(code, fields) : undefined,
          ),
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
      // Tranzit (order-service: `order.region_id` ≠ paket viloyati) — posilka
      // filialga qabul qilingan (NEW), lekin kuryerga berish-bermaslikni
      // pastdagi viloyat qoidasi (`assertOrdersServedByBranch`: XIZMAT
      // viloyati + qamrov imtiyozi) hal qiladi (anKpzwxk, 2a-band): boshqa
      // viloyat — 403 `district_not_served_by_branch` «Boshqa viloyat
      // buyurtmasi»; tumani filial viloyatiga ko'chgan buyurtma — beriladi.
      if (!scanReceive.received && scanReceive.reason !== 'transit') {
        this.forbidden('Boshqa filial orderi — qabul qila olmaysiz');
      }
      receivedIntoBranchByScan = true;

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
    // 6qypMFeT: WAITING ochilgach ushlovchi ham tekshiriladi — boshqa kuryer
    // qo'lidagi posilkani skan bilan olib bo'lmaydi.
    const currentHolderCourierId = String(order.holder_courier_id ?? '').trim();
    if (
      (currentCourierId && currentCourierId !== requesterId) ||
      (currentHolderCourierId && currentHolderCourierId !== requesterId)
    ) {
      this.badRequest('Order allaqachon boshqa courierga biriktirilgan');
    }

    // 6qypMFeT: o'z WAITING buyurtmasini qayta skanlash ham idempotent — aks
    // holda qabul qilingan posilka ON_THE_ROAD ga qaytib, sotuvdan chiqardi.
    const currentStatus = order.status;
    const isAlreadyAssignedToCurrentCourier =
      currentCourierId === requesterId &&
      (currentStatus === Order_status.ON_THE_ROAD ||
        currentStatus === Order_status.WAITING);

    if (!isAlreadyAssignedToCurrentCourier) {
      // 6qypMFeT: WAITING — `assignOrdersToCourier` bilan bir xil (filial
      // pochtadan qabul qilgan, kuryersiz buyurtma).
      if (
        currentStatus !== Order_status.NEW &&
        currentStatus !== Order_status.RECEIVED &&
        currentStatus !== Order_status.WAITING &&
        currentStatus !== Order_status.WAITING_CUSTOMER
      ) {
        this.badRequest(
          "Buyurtma holati noto'g'ri: faqat yangi, qabul qilingan yoki kutilayotgan buyurtmani olish mumkin",
        );
      }
    }

    let targetPost: Post | null = null;
    if (order.post_id) {
      targetPost = await this.postRepo.findOne({
        where: { id: String(order.post_id), courier_id: requesterId },
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

    // Viloyat qamrovi — filial kuryeri (HQ kuryeri yuqorida, 6-band) boshqa
    // viloyat (tranzit) va chiquvchi partiyadagi buyurtmani olmaydi.
    // To'g'ridan-to'g'ri (o'z filiali) va P1b (qabul yoki tranzit qabulidan
    // keyin qayta o'qilgan) yo'llarning ikkalasi ham shu yerdan o'tadi —
    // pochta va NEW → RECEIVED yozuvidan OLDIN.
    if (!isHqCourier) {
      await this.assertOrdersServedByBranch(
        [order],
        courierAssignment.branch ??
          (await this.findBranchCoverageRow(courierBranchId)),
        { receivedIntoBranch: receivedIntoBranchByScan },
      );
    }

    // Har kun — kuryerning alohida pochtasi (Toshkent kuni): buyurtmaning
    // avvalgi pochtasi faqat bugungi ochiq (SENT) pochta bo'lsa qayta
    // ishlatiladi — kechagi yoki yopilgan (RECEIVED) pochta qayta ochilmaydi.
    const todayStart = startOfTashkentDay(new Date());
    // Buyurtmaning o'z (kechagi) kuryer pochtasi — ko'chgandan keyin yopiladi.
    const previousOwnPost = targetPost;
    if (
      targetPost &&
      !(
        targetPost.status === Post_status.SENT &&
        new Date(targetPost.createdAt).getTime() >= todayStart.getTime()
      )
    ) {
      targetPost = null;
    }
    if (!targetPost) {
      targetPost = await this.postRepo.findOne({
        where: {
          courier_id: requesterId,
          status: Post_status.SENT,
          createdAt: MoreThanOrEqual(todayStart),
        },
        order: { createdAt: 'DESC' },
      });
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
      if (
        previousOwnPost &&
        previousOwnPost.status === Post_status.SENT &&
        String(previousOwnPost.id) !== String(targetPost.id)
      ) {
        await this.releaseCourierPostAfterMove(previousOwnPost, order);
      } else {
        await this.releaseOrderFromNewRegionPost(order);
      }
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
    dto: { order_ids: string[]; courier_id: string; branch_id?: string | null },
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
      this.badRequest('courier_id majburiy');
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const resolveOrderBranchScope = (order: {
      holder_branch_id?: string | null;
      branch_id?: string | null;
    }) => String(order?.holder_branch_id ?? order?.branch_id ?? '').trim();

    const requesterRoles = (requester?.roles ?? []).map((role) =>
      String(role).trim().toLowerCase(),
    );
    // (1gxmqLj5, (a) yo'l) SUPERADMIN/ADMIN filialga biriktirilmagan — doira
    // FILIAL BIRIKTIRUVIDAN emas, BUYURTMALARDAN olinadi: barcha buyurtmalar
    // BITTA filialda bo'lishi va kuryer AYNAN o'sha filialning COURIER a'zosi
    // bo'lishi shart (menejer bilan bir xil invariant — kuryer faqat o'z filiali
    // posilkasini oladi). `branch_id` (ixtiyoriy, UI'dagi filial tanlovi)
    // berilsa — buyurtmalar filialiga mos bo'lishi kerak.
    const isSystemPrivileged =
      requesterRoles.includes(Roles.SUPERADMIN) ||
      requesterRoles.includes(Roles.ADMIN);

    let orders: OrderRow[] | null = null;
    let scopeBranchId: string;
    // Tuman qamrovi uchun doira filiali qatori (menejer — biriktiruv javobidan).
    let scopeBranchRow: BranchCoverageRow | null = null;
    if (isSystemPrivileged) {
      orders = await Promise.all(orderIds.map((id) => this.findOrderById(id)));
      scopeBranchId = resolveOrderBranchScope(orders[0]);
      if (!scopeBranchId) {
        this.badRequest('Order(lar) filialga biriktirilmagan');
      }
      const selectedBranchId = String(dto?.branch_id ?? '').trim();
      if (selectedBranchId && selectedBranchId !== scopeBranchId) {
        this.badRequest(
          'Tanlangan filial orderlar filialiga mos emas: faqat shu filial orderlarini tanlang',
        );
      }
    } else {
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
      scopeBranchId = requesterBranchId;
      const assignmentBranch = branchCoverageRowOf(requesterAssignment?.branch);
      scopeBranchRow =
        assignmentBranch?.id === requesterBranchId ? assignmentBranch : null;
    }

    const branchUsers = await this.findBranchUsersByBranchId(
      scopeBranchId,
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

    if (!orders) {
      orders = await Promise.all(orderIds.map((id) => this.findOrderById(id)));
    }

    const firstBranchId = resolveOrderBranchScope(orders[0]);
    if (!firstBranchId) {
      this.badRequest('Order(lar) filialga biriktirilmagan');
    }

    if (firstBranchId !== scopeBranchId) {
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

    // Tuman ↔ filial qamrovi — filialga biriktirilmagan tuman buyurtmasi shu
    // filial kuryeriga berilmaydi. HECH NARSA yozilmasdan oldin (pochta,
    // NEW → RECEIVED avto-qabul). SA/admin doirasi — buyurtmalar filiali.
    await this.assertOrdersServedByBranch(
      orders,
      scopeBranchRow ?? (await this.findBranchCoverageRow(scopeBranchId)),
    );

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

    // Har kun — kuryerning alohida pochtasi (Toshkent kuni): kechagi ochiq
    // pochtaga (yetkazilmay qolganlari bilan) bugungi buyurtma qo'shilmaydi.
    let targetPost = await this.postRepo.findOne({
      where: {
        courier_id: courierId,
        status: Post_status.SENT,
        createdAt: MoreThanOrEqual(startOfTashkentDay(new Date())),
      },
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
        branch_id: scopeBranchId,
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
      this.badRequest('Buyurtmalar tanlanmagan');
    }
    const courierBranchId = await this.findCourierBranchId(requester);
    // Har kun — alohida qaytarish pochtasi (Toshkent kuni): filial hali qabul
    // qilmagan kechagi pochtaga bugungi qaytarish qo'shilmaydi. Kechagi
    // pochtadagi buyurtma o'sha pochtada qoladi (`isOrderInActiveCanceledPost`).
    let canceledPost = await this.postRepo.findOne({
      where: {
        courier_id: requester.id,
        branch_id: courierBranchId,
        status: Post_status.CANCELED,
        createdAt: MoreThanOrEqual(startOfTashkentDay(new Date())),
      },
    });

    const orders: OrderRow[] = [];
    for (const orderId of orderIds) {
      const order = await this.findOrderById(orderId);
      if (!this.isCancelledPostEligibleOrder(order.status)) {
        this.badRequest(
          'Tanlangan buyurtmalarning bir qismi bekor qilingan (CANCELED) holatda emas',
        );
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
      // Jo'natilgan qaytish (CANCELLED_SENT) ham egalik tekshiruvidan o'tadi:
      // ilgari boshqa kuryer/filialning qaytishi shu kuryer pochtasiga tortib
      // olinardi. Ruxsat — o'zi ushlagan / o'z filialida turgan buyurtma yoki
      // joriy qaytish pochtasi shu kuryerniki (holat filtrisiz: o'z NOFAOL
      // pochtasidan faol pochtaga ko'chirish — qonuniy hol).
      if (
        this.isCancelledSentOrder(order.status) &&
        !(await this.isCancelledSentOrderOwnedByCourier(
          order,
          requester.id,
          courierBranchId,
        ))
      ) {
        this.forbidden("Jo'natilgan qaytish boshqa kuryer/filialga tegishli");
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
      this.badRequest('Buyurtmalar tanlanmagan');
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
        this.badRequest(
          'Tanlangan buyurtmalarning bir qismi bekor qilingan (CANCELED) holatda emas',
        );
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
    /**
     * HQ «Filialga qaytarish» tugmasi (`returnCanceledOrdersToSender`): har
     * buyurtma faqat hali shu pochtada kutayotgan bo'lsa yoziladi (409 —
     * boshqa xodim shu orada qabul qilgan yoki qaytargan) va tarixga
     * «HQ filialga qaytardi» qatori yoziladi.
     */
    explicitReturn?: boolean;
    /** Har bir qaytarilgan buyurtmadan keyin (yarim yo'lda yiqilsa ham). */
    onReturned?: (orderId: string) => void;
    /** `fallbackBranchId` filialining nomi — tarix qatori uchun. */
    fallbackBranchName?: string | null;
  }): Promise<string[]> {
    const {
      sourcePost,
      orders,
      targetBranchId,
      fallbackBranchId,
      isHqReceipt,
      returnToCourier,
      requester,
      explicitReturn = false,
      onReturned,
      fallbackBranchName,
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
          // Har kun — alohida pochta: kechagi ochiq qaytarish pochtasiga
          // qo'shilmaydi.
          createdAt: MoreThanOrEqual(startOfTashkentDay(new Date())),
        } as any,
      });
      const createdReturnPost = !returnPost;

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

      // Yarim yo'lda yiqilsa ham (masalan 409) allaqachon ko'chgan buyurtmalar
      // qaytarish pochtasining hisobida qoladi.
      let returnedCount = 0;
      let returnedTotal = 0;
      let failure: unknown = null;
      try {
        for (const order of group.orders) {
          const note = explicitReturn
            ? 'Canceled order returned to sender branch by HQ'
            : isHqReceipt
              ? returnToCourier
                ? 'Canceled order returned to courier after partial HQ receive'
                : 'Canceled order returned to branch after partial HQ receive'
              : 'Canceled order returned to courier after partial branch receive';
          const fromPostId =
            String(order.canceled_post_id ?? '').trim() ||
            String(sourcePost.id);
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
              note,
              ...(explicitReturn
                ? {
                    canceled_post_guard: { post_id: fromPostId },
                    canceled_post_return: {
                      post_id: fromPostId,
                      return_post_id: String(returnPost.id),
                      to_branch_id: group.branchId,
                      to_branch_name:
                        group.branchId === String(fallbackBranchId ?? '').trim()
                          ? (fallbackBranchName ?? null)
                          : null,
                    },
                  }
                : {}),
            },
          );
          returnedCount += 1;
          returnedTotal += Number(order.total_price ?? 0);
          onReturned?.(String(order.id));
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (returnedCount > 0) {
          returnPost.order_quantity =
            Number(returnPost.order_quantity ?? 0) + returnedCount;
          returnPost.post_total_price =
            Number(returnPost.post_total_price ?? 0) + returnedTotal;
          const savedReturnPost = await this.postRepo.save(returnPost);
          void this.syncPostToSearch(savedReturnPost);
          requeuedPostIds.add(String(savedReturnPost.id));
        } else if (
          createdReturnPost &&
          this.isDefiniteOrderRejection(failure)
        ) {
          // Birorta buyurtma ko'chmadi va order-service ANIQ rad etdi (4xx —
          // hech narsa yozilmagan): filialda bo'sh pochta qolmasin. Timeout /
          // 5xx da pochta qoladi — kechikkan yozuv shu pochtaga tushadi.
          await this.postRepo
            .delete({ id: returnPost.id })
            .catch((error: unknown) =>
              this.logger?.warn(
                `empty return post ${returnPost?.id} cleanup failed: ${
                  (error as Error)?.message ?? error
                }`,
              ),
            );
        }
      }
    }

    return Array.from(requeuedPostIds);
  }

  /** `updateOrder` xatosi order-service'ning aniq rad javobimi (4xx; timeout — 502). */
  private isDefiniteOrderRejection(error: unknown): boolean {
    const downstream = error instanceof RpcException ? error.getError() : error;
    const statusCode = Number(
      (downstream as { statusCode?: number } | null)?.statusCode,
    );
    return statusCode >= 400 && statusCode < 500;
  }

  /**
   * `updateOrder` xatosi order-service'ning qulf ostidagi shartli yozuv rad
   * javobimi (409 + `reason`) — buyurtma shu orada o'zgargan, hech narsa
   * yozilmagan.
   */
  private isOrderGuardConflict(error: unknown, reason: string): boolean {
    const downstream = (
      error instanceof RpcException ? error.getError() : error
    ) as { statusCode?: number; reason?: string } | null;
    return (
      Number(downstream?.statusCode) === 409 && downstream?.reason === reason
    );
  }

  /**
   * Bekor pochta ustidagi amal (qabul yoki HQ «Filialga qaytarish») uchun
   * pochta va doira: faqat ochiq (CANCELED) pochta; HQ xodimi faqat HQ ga
   * kelgan pochtani, filial xodimi faqat o'z filialinikini.
   */
  private async loadCanceledPostForAction(
    requester: RequesterContext,
    id: string,
    action: 'receive' | 'return',
  ): Promise<{
    post: Post;
    targetBranchId: string;
    hqBranchId: string;
    isHqReceipt: boolean;
  }> {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Pochta topilmadi');
    }
    if (post.status !== Post_status.CANCELED) {
      this.badRequest(
        action === 'return'
          ? "Bu pochta yopilgan — undagi buyurtmalarni qaytarib bo'lmaydi"
          : "Bu holatdagi pochtani qabul qilib bo'lmaydi",
      );
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
    return { post, targetBranchId, hqBranchId, isHqReceipt };
  }

  /**
   * o10nrbkB (BG5) / LC-06 — pochta jo'natuvchisi (post.courier_id) kim:
   * kuryermi yoki menejermi, qaysi filialdan (hozirgi biriktiruvi). Qabul
   * tracking'ining manbasi va custody hodisasi shundan (order-service);
   * qaytarilganlar ham shu jo'natuvchiga boradi. Qidiruv yiqilsa — null
   * (qabul to'xtamaydi).
   */
  private async resolveCanceledPostSender(post: Post): Promise<{
    role: string;
    branchName: string | null;
    sender: {
      user_id: string | null;
      role: string | null;
      branch_id: string | null;
    };
  }> {
    const senderUserId = String(post.courier_id ?? '').trim();
    const senderAssignment = senderUserId
      ? await this.findBranchAssignmentByUserId(senderUserId, {
          id: senderUserId,
          roles: [Roles.MANAGER],
        })
      : null;
    const role = String(senderAssignment?.role ?? '')
      .trim()
      .toUpperCase();
    return {
      role,
      branchName: branchSummaryOf(senderAssignment?.branch)?.name ?? null,
      sender: {
        user_id: senderUserId || null,
        role: role || null,
        branch_id: String(senderAssignment?.branch_id ?? '').trim() || null,
      },
    };
  }

  /**
   * HQ bekor pochtasi — qabul yoki «Filialga qaytarish»dan keyin guruhdagi har
   * pochtaning holati. Pochtada hali kutayotgan (CANCELLED_SENT) buyurtma
   * bo'lsa — CANCELED (HQ «Bekor qilingan pochtalar»ida qoladi), qolmasa —
   * CANCELED_RECEIVED («Eski pochtalar»). Kutayotganlar amaldan KEYIN qayta
   * o'qiladi: shu orada filial yangi buyurtma qo'shgan bo'lsa pochta
   * yopilmaydi.
   *
   * Hisoblagich: ochiq pochtada — HQ qabul qilganlar + kutayotganlar (yangi
   * jo'natma `+=` bilan qo'shiladi), yopilganda — faqat HQ qabul qilganlar
   * (eski pochtalar ro'yxati va cheki). Qaytarilganlar ayiriladi — ular
   * filialning qaytarish pochtasida hisoblanadi.
   */
  private async settleHqCanceledPostGroup(
    posts: Post[],
    ordersBefore: OrderRow[],
    processed: {
      received: ReadonlySet<string>;
      returned: ReadonlySet<string>;
    },
  ): Promise<{ posts: Post[]; remainingOrderIds: string[] }> {
    const zero = () => ({ count: 0, total: 0 });
    const receivedByPost = new Map<string, { count: number; total: number }>();
    const returnedByPost = new Map<string, { count: number; total: number }>();
    for (const order of ordersBefore) {
      const orderId = String(order.id);
      const bucket = processed.received.has(orderId)
        ? receivedByPost
        : processed.returned.has(orderId)
          ? returnedByPost
          : null;
      if (!bucket) continue;
      const postKey = String(order.canceled_post_id ?? '').trim();
      const totals = bucket.get(postKey) ?? zero();
      totals.count += 1;
      totals.total += Number(order.total_price ?? 0) || 0;
      bucket.set(postKey, totals);
    }

    const settledPosts: Post[] = [];
    const remainingOrderIds: string[] = [];
    for (const groupedPost of posts) {
      const postId = String(groupedPost.id);
      let pending: OrderRow[];
      try {
        pending = await this.findOrders({
          canceled_post_id: postId,
          status: Order_status.CANCELLED_SENT,
          fetch_all: true,
          page: 1,
          limit: 100,
        });
      } catch (error) {
        this.logger?.warn(
          `canceled post ${postId}: pending re-read failed, using snapshot: ${
            (error as Error)?.message ?? error
          }`,
        );
        pending = ordersBefore.filter(
          (order) =>
            String(order.canceled_post_id ?? '').trim() === postId &&
            !processed.received.has(String(order.id)) &&
            !processed.returned.has(String(order.id)),
        );
      }
      remainingOrderIds.push(...pending.map((order) => String(order.id)));
      const pendingTotal = pending.reduce(
        (sum, order) => sum + (Number(order.total_price ?? 0) || 0),
        0,
      );
      const fresh =
        (await this.postRepo.findOne({ where: { id: groupedPost.id } })) ??
        groupedPost;
      const received = receivedByPost.get(postId) ?? zero();
      const returned = returnedByPost.get(postId) ?? zero();
      const keptCount = Math.max(
        received.count,
        Number(fresh.order_quantity ?? 0) - returned.count - pending.length,
      );
      const keptTotal = Math.max(
        received.total,
        Number(fresh.post_total_price ?? 0) - returned.total - pendingTotal,
      );
      const closed = pending.length === 0;
      const next = {
        status: closed ? Post_status.CANCELED_RECEIVED : Post_status.CANCELED,
        order_quantity: closed ? keptCount : keptCount + pending.length,
        post_total_price: closed ? keptTotal : keptTotal + pendingTotal,
      };
      if (
        fresh.status === next.status &&
        Number(fresh.order_quantity ?? 0) === next.order_quantity &&
        Number(fresh.post_total_price ?? 0) === next.post_total_price
      ) {
        settledPosts.push(fresh);
        continue;
      }

      Object.assign(fresh, next);
      let savedPost: Post;
      try {
        savedPost = await this.postRepo.save(fresh);
      } catch (error) {
        this.logger.warn(
          `post ${postId} save failed after HQ canceled post action, retrying minimal update: ${
            (error as Error)?.message ?? error
          }`,
        );
        await this.postRepo.update(fresh.id, next);
        savedPost =
          (await this.postRepo.findOne({ where: { id: fresh.id } })) ?? fresh;
      }
      void this.syncPostToSearch(savedPost);
      settledPosts.push(savedPost);
    }

    return { posts: settledPosts, remainingOrderIds };
  }

  async receiveCanceledPost(
    requester: RequesterContext,
    id: string,
    dto: ReceivePostDto,
  ) {
    const { post, targetBranchId, isHqReceipt } =
      await this.loadCanceledPostForAction(requester, id, 'receive');

    const { posts: groupedCanceledPosts, orders: allOrders } =
      await this.findCanceledPostGroup(post);

    const canceledOrderIds = [...new Set(dto.order_ids ?? [])];
    // HQ: tanlanmagan buyurtmalar pochtada qoladi — bo'sh qabul ma'nosiz.
    if (isHqReceipt && !canceledOrderIds.length) {
      this.badRequest('Qabul qilish uchun kamida bitta buyurtma tanlang');
    }
    const allOrderIdsForPost = allOrders.map((o) => o.id);
    const invalidIds = canceledOrderIds.filter(
      (orderId) => !allOrderIdsForPost.includes(orderId),
    );

    if (invalidIds.length) {
      this.badRequest(
        `Bu buyurtmalar ushbu pochtaga tegishli emas: ${invalidIds.join(', ')}`,
      );
    }

    const { role: senderRole, sender: canceledPostSender } =
      await this.resolveCanceledPostSender(post);
    const orderById = new Map(
      allOrders.map((order) => [String(order.id), order]),
    );

    const receivedOrderIds: string[] = [];
    let receiveError: unknown = null;
    try {
      for (const orderId of canceledOrderIds) {
        const fromPostId =
          String(
            orderById.get(String(orderId))?.canceled_post_id ?? '',
          ).trim() || String(post.id);
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
            canceled_post_sender: canceledPostSender,
            // HQ: shu orada boshqa xodim qabul qilgan yoki qaytargan buyurtma
            // qayta yozilmaydi (order-service 409).
            ...(isHqReceipt
              ? { canceled_post_guard: { post_id: fromPostId } }
              : {}),
          },
        );
        receivedOrderIds.push(String(orderId));
      }
    } catch (error) {
      if (!isHqReceipt) throw error;
      receiveError = error;
    }

    if (isHqReceipt) {
      // Egasi qarori (2026-11-03): HQ da tanlanmagan buyurtmalar o'zi filialga
      // QAYTMAYDI (LC-06 avtomatik qaytarish faqat filial qabulida qoldi) —
      // pochtada kutib turadi; qaytarish — alohida «Filialga qaytarish»
      // (`returnCanceledOrdersToSender`). Pochta hammasi qabul qilinganda yoki
      // qaytarilganda yopiladi. Yarim yo'lda yiqilsa ham holat yangilanadi.
      const settled = await this.settleHqCanceledPostGroup(
        groupedCanceledPosts,
        allOrders,
        { received: new Set(receivedOrderIds), returned: new Set() },
      );
      const sourcePost =
        settled.posts.find(({ id: postId }) => String(postId) === String(id)) ??
        post;
      const postClosed = sourcePost.status === Post_status.CANCELED_RECEIVED;
      if (receivedOrderIds.length) {
        await Promise.resolve(
          this.activityLog.log({
            entity_type: 'Post',
            entity_id: String(sourcePost.id),
            action: postClosed
              ? ActivityAction.STATUS_CHANGE
              : 'logistics.canceled_post_partial_receive',
            ...(postClosed ? { new_value: { status: sourcePost.status } } : {}),
            ...this.auditActor(requester),
            metadata: {
              order_count: receivedOrderIds.length,
              order_ids: receivedOrderIds.slice(0, 10),
              remaining_order_count: settled.remainingOrderIds.length,
              grouped_post_ids: groupedCanceledPosts.map(({ id: postId }) =>
                String(postId),
              ),
              branch_id: targetBranchId,
              courier_id: sourcePost.courier_id,
            },
          }),
        ).catch(() => undefined);
      }
      if (receiveError) {
        throw receiveError;
      }

      return successRes(
        {
          order_ids: receivedOrderIds,
          remaining_order_ids: settled.remainingOrderIds,
          requeued_post_ids: [],
          grouped_post_ids: groupedCanceledPosts.map(({ id: postId }) =>
            String(postId),
          ),
          branch_id: targetBranchId,
          post_status: sourcePost.status,
          post_closed: postClosed,
        },
        200,
        postClosed
          ? 'Canceled orders received by HQ'
          : 'Canceled orders received by HQ; the rest stays in the post',
      );
    }

    const remainingOrderIds = allOrderIdsForPost.filter(
      (orderId) => !canceledOrderIds.includes(orderId),
    );
    const remainingOrders = allOrders.filter((order) =>
      remainingOrderIds.includes(String(order.id)),
    );
    // Qabul qilingan bekor pochta hisoblagichlari nolga tushirilmaydi: har
    // pochtada AYNAN qabul qilingan buyurtmalar soni/summasi qoladi (eski
    // pochtalar ro'yxati va cheki). Qabul qilinmay qayta navbatga qo'yilganlar
    // yangi qaytarish pochtasida hisoblanadi.
    const receivedOrderIdSet = new Set(canceledOrderIds.map(String));
    const receivedTotalsByPost = new Map<
      string,
      { count: number; total: number }
    >();
    for (const order of allOrders) {
      if (!receivedOrderIdSet.has(String(order.id))) continue;
      const postKey =
        String(order.canceled_post_id ?? '').trim() || String(post.id);
      const totals = receivedTotalsByPost.get(postKey) ?? {
        count: 0,
        total: 0,
      };
      totals.count += 1;
      totals.total += Number(order.total_price ?? 0) || 0;
      receivedTotalsByPost.set(postKey, totals);
    }
    let savedPost = post;
    for (const groupedPost of groupedCanceledPosts) {
      const receivedTotals = receivedTotalsByPost.get(
        String(groupedPost.id),
      ) ?? { count: 0, total: 0 };
      groupedPost.order_quantity = receivedTotals.count;
      groupedPost.post_total_price = receivedTotals.total;
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
          order_quantity: receivedTotals.count,
          post_total_price: receivedTotals.total,
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
      // LC-06 — filial qabulida qabul qilinmagan posilka jo'natuvchiga
      // (yuqorida aniqlangan) qaytadi. Qidiruv yiqilsa (null) — kuryerga.
      const returnToCourier = senderRole ? senderRole === 'COURIER' : true;
      requeuedPostIds = await this.requeueUnreceivedCanceledOrders({
        sourcePost: post,
        orders: remainingOrders,
        targetBranchId,
        fallbackBranchId: targetBranchId,
        isHqReceipt: false,
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
        post_status: savedPost.status,
        post_closed: true,
      },
      200,
      'Canceled orders received by branch',
    );
  }

  /**
   * HQ «Filialga qaytarish» (egasi qarori, 2026-11-03): filialdan kelgan bekor
   * pochtaning TANLANGAN buyurtmalari jo'natgan filialga qaytadi — filial
   * ularni «Rad etilgan pochtalar»dan qabul qiladi (LC-06 dagi qaytarish
   * pochtasi). Tanlanmaganlar pochtada qoladi; pochta hammasi qabul
   * qilinganda yoki qaytarilganda yopiladi.
   *
   * Faqat HQ ga kelgan pochta va jo'natuvchi HQ dan boshqa filial bo'lsa: HQ
   * kuryeri olib kelgan pochta qaytarilmaydi (qaytarish pochtasi yana HQ ga
   * tushib, shu pochta bilan qo'shilib ketardi), jo'natuvchi aniqlanmasa ham.
   */
  async returnCanceledOrdersToSender(
    requester: RequesterContext,
    id: string,
    dto: ReceivePostDto,
  ) {
    const { post, targetBranchId, hqBranchId, isHqReceipt } =
      await this.loadCanceledPostForAction(requester, id, 'return');
    if (!isHqReceipt) {
      this.badRequest(
        'Bekor qilingan buyurtmalarni filialga faqat HQ qaytara oladi',
      );
    }

    const orderIds = [
      ...new Set((dto.order_ids ?? []).map((orderId) => String(orderId))),
    ].filter(Boolean);
    if (!orderIds.length) {
      this.badRequest('Qaytarish uchun kamida bitta buyurtma tanlang');
    }

    const { posts: groupedCanceledPosts, orders: allOrders } =
      await this.findCanceledPostGroup(post);
    const groupOrderIds = new Set(allOrders.map((order) => String(order.id)));
    const invalidIds = orderIds.filter(
      (orderId) => !groupOrderIds.has(orderId),
    );
    if (invalidIds.length) {
      this.badRequest(
        `Bu buyurtmalar ushbu pochtada emas (qabul qilingan yoki qaytarilgan bo'lishi mumkin): ${invalidIds.join(', ')}`,
      );
    }

    const {
      role: senderRole,
      branchName: senderBranchName,
      sender,
    } = await this.resolveCanceledPostSender(post);
    const senderBranchId = sender.branch_id;
    if (!senderBranchId) {
      this.badRequest(
        "Pochtani jo'natgan filial aniqlanmadi — buyurtmalarni qaytarib bo'lmaydi",
      );
    }
    if (senderBranchId === hqBranchId) {
      this.badRequest(
        "Bu pochtani HQ kuryeri olib kelgan — uni filialga qaytarib bo'lmaydi, buyurtmalarni qabul qiling",
      );
    }

    const selectedIds = new Set(orderIds);
    const selectedOrders = allOrders.filter((order) =>
      selectedIds.has(String(order.id)),
    );
    const returnedOrderIds: string[] = [];
    let requeuedPostIds: string[] = [];
    let returnError: unknown = null;
    try {
      requeuedPostIds = await this.requeueUnreceivedCanceledOrders({
        sourcePost: post,
        orders: selectedOrders,
        targetBranchId,
        fallbackBranchId: senderBranchId,
        fallbackBranchName: senderBranchName,
        isHqReceipt: true,
        returnToCourier: senderRole === 'COURIER',
        requester,
        explicitReturn: true,
        onReturned: (orderId) => returnedOrderIds.push(orderId),
      });
    } catch (error) {
      returnError = error;
    }

    const settled = await this.settleHqCanceledPostGroup(
      groupedCanceledPosts,
      allOrders,
      { received: new Set(), returned: new Set(returnedOrderIds) },
    );
    const sourcePost =
      settled.posts.find(({ id: postId }) => String(postId) === String(id)) ??
      post;
    const postClosed = sourcePost.status === Post_status.CANCELED_RECEIVED;
    if (returnedOrderIds.length) {
      await Promise.resolve(
        this.activityLog.log({
          entity_type: 'Post',
          entity_id: String(sourcePost.id),
          action: 'logistics.canceled_post_return',
          ...this.auditActor(requester),
          metadata: {
            order_count: returnedOrderIds.length,
            order_ids: returnedOrderIds.slice(0, 10),
            remaining_order_count: settled.remainingOrderIds.length,
            requeued_post_ids: requeuedPostIds,
            return_branch_id: senderBranchId,
            post_closed: postClosed,
            courier_id: sourcePost.courier_id,
          },
        }),
      ).catch(() => undefined);
    }
    if (returnError) {
      throw returnError;
    }

    return successRes(
      {
        order_ids: returnedOrderIds,
        remaining_order_ids: settled.remainingOrderIds,
        requeued_post_ids: requeuedPostIds,
        return_branch_id: senderBranchId,
        return_branch_name: senderBranchName,
        post_status: sourcePost.status,
        post_closed: postClosed,
      },
      200,
      'Canceled orders returned to the sender branch',
    );
  }

  /**
   * Tuman SOATO kodi qoidasi (POST district va PATCH district/sato/:id):
   * majburiy, aniq 7 raqam (viloyat kodi — 4 raqam, `data/sato-codes.ts`),
   * tumanning GEOGRAFIK viloyati (`region_id`) rasmiy kodi bo'lsa — shu
   * prefiks bilan boshlanadi (`applyDistrictSatoCodes` dagi
   * `region_prefix_mismatch` kabi). Rasmiy ro'yxatda bo'lishi SHART EMAS:
   * 2022-yildan keyin tuzilgan tumanlar ham qo'shila olsin. Qaytaradi —
   * kesilgan (trim) kod.
   */
  private normalizeDistrictSatoCode(
    raw: unknown,
    region: { sato_code?: string | null } | null,
  ): string {
    const satoCode = typeof raw === 'string' ? raw.trim() : '';
    if (!satoCode) {
      this.badRequest('Tuman SOATO kodi majburiy', {
        reason: 'sato_code_required',
      });
    }
    if (!/^\d{7}$/.test(satoCode)) {
      this.badRequest(
        "Tuman SOATO kodi aniq 7 ta raqamdan iborat bo'lishi kerak (masalan, 1703206)",
        { reason: 'sato_code_format' },
      );
    }
    const regionCode = region?.sato_code?.trim();
    if (regionCode && !satoCode.startsWith(regionCode)) {
      this.badRequest(
        `Tuman SOATO kodi viloyat SOATO kodi (${regionCode}) bilan boshlanishi kerak`,
        {
          reason: 'region_prefix_mismatch',
          details: { expected_prefix: regionCode },
        },
      );
    }
    return satoCode;
  }

  /**
   * SOATO kod tizimda takrorlanmasin: boshqa tumanda ham (o'zidan tashqari),
   * viloyatda ham bo'lmasin (viloyat kodlari 4 raqamli — himoya uchun).
   */
  private async assertDistrictSatoCodeFree(
    satoCode: string,
    excludeDistrictId?: string,
  ): Promise<void> {
    const districtHolder = await this.districtRepo.findOne({
      where: excludeDistrictId
        ? { sato_code: satoCode, id: Not(excludeDistrictId) }
        : { sato_code: satoCode },
    });
    if (districtHolder) {
      this.conflict('Bunday SOATO kodli tuman allaqachon mavjud');
    }
    const regionHolder = await this.regionRepo.findOne({
      where: { sato_code: satoCode },
    });
    if (regionHolder) {
      this.conflict('Bunday SOATO kodli viloyat allaqachon mavjud');
    }
  }

  async createDistrict(dto: CreateDistrictDto) {
    const region = await this.regionRepo.findOne({
      where: { id: dto.region_id },
    });
    if (!region) {
      this.notFound('Viloyat topilmadi');
    }

    const trimmedName = dto.name.trim();
    // Yangi tuman SOATO kodisiz qo'shilmaydi (mahsulot egasi qarori).
    const satoCode = this.normalizeDistrictSatoCode(dto.sato_code, region);

    const exists = await this.districtRepo.findOne({
      where: { name: trimmedName, region_id: dto.region_id },
    });
    if (exists) {
      this.conflict('Bu viloyatda shunday tuman allaqachon mavjud');
    }

    await this.assertDistrictSatoCodeFree(satoCode);

    const district = this.districtRepo.create({
      name: trimmedName,
      sato_code: satoCode,
      region_id: dto.region_id,
      assigned_region: dto.region_id,
    });
    let saved: District;
    try {
      saved = await this.districtRepo.save(district);
    } catch (err) {
      // SlMjauWC: tekshiruv va yozish orasidagi poyga — unique indeks 23505.
      if (this.isUniqueViolation(err)) {
        this.conflict('Bunday SOATO kodli tuman allaqachon mavjud');
      }
      throw err;
    }
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
      this.notFound('Tuman topilmadi');
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

  /** Imtiyoz custody'si o'qilmadi / yozilmadi — 503 (fail closed). */
  private coverageExemptionUnavailable(reason: string): never {
    this.logger.error(`tuman qamrovi imtiyozlari: ${reason}`);
    throw new RpcException(
      errorRes(COVERAGE_EXEMPTION_UNAVAILABLE_MESSAGE, 503),
    );
  }

  /**
   * `order.open_custody_by_district` — tumanlarning ochiq buyurtmalari
   * (≤ 50 tumandan bo'lib, har bo'lak `next_after_id` bilan sahifalanadi).
   * Javob kelmasa / noto'g'ri bo'lsa / sahifa oldinga siljimasa / jami
   * sahifalar chegarasidan oshsa — 503 (to'liq bo'lmagan ro'yxat bilan
   * imtiyoz yozilmaydi).
   */
  private async fetchOpenCustodyRows(
    districtIds: readonly string[],
  ): Promise<OpenCustodyRow[]> {
    const rows: OpenCustodyRow[] = [];
    let pages = 0;
    for (
      let offset = 0;
      offset < districtIds.length;
      offset += OPEN_CUSTODY_MAX_DISTRICT_IDS
    ) {
      const chunk = districtIds.slice(
        offset,
        offset + OPEN_CUSTODY_MAX_DISTRICT_IDS,
      );
      let afterId: string | null = null;
      for (;;) {
        pages += 1;
        if (pages > COVERAGE_CUSTODY_MAX_PAGES) {
          this.coverageExemptionUnavailable(
            `ochiq buyurtmalar ${COVERAGE_CUSTODY_MAX_PAGES} sahifadan oshdi (tumanlar: ${districtIds.join(', ')})`,
          );
        }
        let response: unknown;
        try {
          response = await lastValueFrom(
            this.orderClient
              .send(
                { cmd: 'order.open_custody_by_district' },
                {
                  district_ids: chunk,
                  after_id: afterId,
                  limit: OPEN_CUSTODY_PAGE_LIMIT,
                },
              )
              .pipe(timeout(COVERAGE_CUSTODY_TIMEOUT_MS)),
          );
        } catch (error) {
          this.coverageExemptionUnavailable(
            `order.open_custody_by_district javob bermadi (tumanlar: ${chunk.join(', ')}): ${this.geoErrorText(error)}`,
          );
        }
        const page = parseOpenCustodyPage(response);
        if (!page) {
          this.coverageExemptionUnavailable(
            `order.open_custody_by_district javobi noto'g'ri (tumanlar: ${chunk.join(', ')})`,
          );
        }
        rows.push(...page.rows);
        if (!page.next_after_id) {
          break;
        }
        if (afterId !== null && BigInt(page.next_after_id) <= BigInt(afterId)) {
          this.coverageExemptionUnavailable(
            `order.open_custody_by_district sahifasi oldinga siljimadi (after_id ${afterId})`,
          );
        }
        afterId = page.next_after_id;
      }
    }
    return rows;
  }

  /**
   * Ko'chishdan OLDIN: tumanlarning ochiq buyurtmalari va ularning mas'ul
   * filial qatorlari (`findBranchCoverageRow`; 404 — noma'lum filial, imtiyoz
   * yo'q). `orderIds` berilsa — faqat shu buyurtmalar qoladi (filial qatori
   * ham faqat ularniki so'raladi: birlashtirishdan keyin B ning o'z
   * buyurtmalari filial xizmati xatosi bilan qayta snapshot'ni yiqitmasin).
   * Har qanday xato — 503.
   */
  private async loadCoverageCustody(
    districtIds: readonly string[],
    orderIds?: ReadonlySet<string>,
  ): Promise<CoverageCustody> {
    const ids = Array.from(
      new Set(
        districtIds
          .map((id) => canonicalBigintId(id))
          .filter((id): id is string => !!id),
      ),
    );
    const fetched = ids.length ? await this.fetchOpenCustodyRows(ids) : [];
    const rows = orderIds
      ? fetched.filter((row) => orderIds.has(row.id))
      : fetched;
    const branchesById = new Map<string, BranchCoverageRow | null>();
    try {
      await Promise.all(
        coverageExemptionCandidateBranchIds(rows).map(async (branchId) => {
          branchesById.set(
            branchId,
            await this.findBranchCoverageRow(branchId),
          );
        }),
      );
    } catch (error) {
      this.coverageExemptionUnavailable(
        `filial qatorini olib bo'lmadi: ${this.geoErrorText(error)}`,
      );
    }
    return { district_ids: new Set(ids), rows, branchesById };
  }

  /**
   * O'qilgan custody bo'yicha har ko'chish uchun imtiyozlar. Ko'chayotgan
   * tuman custody'da yo'q (oraliqda holat o'zgardi) — 503, qayta urinish.
   */
  private coverageExemptionsFor(
    custody: CoverageCustody,
    moves: readonly CoverageDistrictMove[],
  ): CoverageExemption[] {
    const rowsByDistrict = new Map<string, OpenCustodyRow[]>();
    for (const row of custody.rows) {
      const key = row.district_id ?? '';
      const list = rowsByDistrict.get(key) ?? [];
      list.push(row);
      rowsByDistrict.set(key, list);
    }
    const exemptions = new Map<string, CoverageExemption>();
    for (const move of moves) {
      const districtId = canonicalBigintId(move.district_id);
      if (!districtId || !custody.district_ids.has(districtId)) {
        this.coverageExemptionUnavailable(
          `tuman #${move.district_id} ochiq buyurtmalari oldindan o'qilmagan (holat o'zgardi)`,
        );
      }
      const orderIds = move.order_ids;
      const rows = rowsByDistrict.get(districtId) ?? [];
      for (const exemption of computeCoverageExemptions({
        rows: orderIds ? rows.filter((row) => orderIds.has(row.id)) : rows,
        before: move.before,
        after: move.after,
        branchesById: custody.branchesById,
        targetDistrictId: move.target_district_id ?? districtId,
      })) {
        exemptions.set(
          `${exemption.order_id}:${exemption.branch_id}`,
          exemption,
        );
      }
    }
    return Array.from(exemptions.values());
  }

  /**
   * Imtiyozlarni yozish — bo'laklab `INSERT … ON CONFLICT (order_id,
   * branch_id) DO UPDATE … RETURNING` (`manager` — chaqiruvchi
   * tranzaksiyasi). Faqat yangi yoki boshqa tumanga qayta yo'naltirilgan
   * qatorlar qaytadi (`coverageExemptionInsertQuery`). DB xatosi — 503.
   */
  private async saveCoverageExemptions(
    exemptions: readonly CoverageExemption[],
    source: CoverageExemptionSource,
    manager?: EntityManager,
  ): Promise<CreatedCoverageExemption[]> {
    const runner = manager ?? this.coverageExemptionRepo?.manager;
    if (!exemptions.length || !runner) {
      return [];
    }
    const created: CreatedCoverageExemption[] = [];
    try {
      for (
        let offset = 0;
        offset < exemptions.length;
        offset += COVERAGE_EXEMPTION_INSERT_CHUNK
      ) {
        const { sql, params } = coverageExemptionInsertQuery(
          exemptions.slice(offset, offset + COVERAGE_EXEMPTION_INSERT_CHUNK),
          source,
        );
        const inserted: unknown = await runner.query(sql, params);
        for (const row of Array.isArray(inserted) ? inserted : []) {
          const orderId = canonicalBigintId(
            (row as { order_id?: unknown })?.order_id,
          );
          const branchId = canonicalBigintId(
            (row as { branch_id?: unknown })?.branch_id,
          );
          if (orderId && branchId) {
            created.push({
              order_id: orderId,
              branch_id: branchId,
              district_id: canonicalBigintId(
                (row as { district_id?: unknown })?.district_id,
              ),
            });
          }
        }
      }
    } catch (error) {
      this.coverageExemptionUnavailable(
        `imtiyozlarni yozib bo'lmadi (${source}): ${this.geoErrorText(error)}`,
      );
    }
    return created;
  }

  /**
   * Tuman ko'chishidan OLDIN (va COMMIT'dan keyin qayta —
   * `resnapshotCoverageExemptions`) qamrov imtiyozlarini yozish (o'qish +
   * hisoblash + yozish). Imtiyoz repo ulanmagan (eski spec simlari) —
   * `null`, hech narsa qilinmaydi. Xato — 503 (fail closed); best-effort
   * chaqiruvchi (`clearDistrictServingBranch`) xatoni o'zi ushlaydi.
   */
  private async snapshotCoverageExemptions(input: {
    moves: readonly CoverageDistrictMove[];
    source: CoverageExemptionSource;
    manager?: EntityManager;
  }): Promise<CreatedCoverageExemption[] | null> {
    if (!this.coverageExemptionRepo) {
      return null;
    }
    const moves = regionChangingCoverageMoves(input.moves);
    if (!moves.length) {
      return [];
    }
    // Har ko'chish faqat o'z buyurtmalariga (`order_ids`) cheklangan bo'lsa —
    // custody ham faqat shularga (birlashtirishdan keyingi qayta snapshot).
    const orderIds = moves.every((move) => move.order_ids)
      ? new Set(moves.flatMap((move) => [...(move.order_ids ?? [])]))
      : undefined;
    const custody = await this.loadCoverageCustody(
      moves.map((move) => move.district_id),
      orderIds,
    );
    return this.saveCoverageExemptions(
      this.coverageExemptionsFor(custody, moves),
      input.source,
      input.manager,
    );
  }

  /**
   * Ko'chish COMMIT bo'lgach imtiyozlarni QAYTA yozish (shu before/after
   * bilan): oldingi snapshot va ko'chish orasida eski filial / uning kuryeri
   * custody'siga kirgan buyurtma ham imtiyozli bo'lsin. Yozish idempotent
   * (aynan bir xil qator tegilmaydi). BEST-EFFORT: xato so'rovni yiqitmaydi
   * — ERROR log (tuman id'lari bilan) va `null`.
   */
  private async resnapshotCoverageExemptions(input: {
    moves: readonly CoverageDistrictMove[];
    source: CoverageExemptionSource;
    context: string;
  }): Promise<CreatedCoverageExemption[] | null> {
    try {
      return await this.snapshotCoverageExemptions({
        moves: input.moves,
        source: input.source,
      });
    } catch (error) {
      this.logger.error(
        `${input.context}: tuman(lar) ${input.moves.map((move) => `#${move.district_id}`).join(', ')} ko'chgandan keyin qamrov imtiyozlarini qayta yozib bo'lmadi: ${this.geoErrorText(error)}`,
      );
      return null;
    }
  }

  /**
   * Birlashtirilgach (A o'chdi): A dan B ga ko'chgan buyurtmalarning OLDINGI
   * ko'chishlardan qolgan A tumanli imtiyozlari B ga qayta yo'naltiriladi
   * (`coverageExemptionRetargetQuery`) — aks holda to'siq ularni hisobga
   * olmaydi (buyurtma endi B da) va eski filial buyurtmasi qotib qoladi;
   * birlashtirishning o'z snapshot'i ularni qayta bermaydi (eski filial A ga
   * allaqachon xizmat qilmaydi). BEST-EFFORT: xato — ERROR log (tumanlar
   * bilan), so'rov yiqilmaydi.
   */
  private async retargetMergedCoverageExemptions(
    fromId: string,
    toId: string,
    movedOrderIds: ReadonlySet<string>,
  ): Promise<void> {
    const runner = this.coverageExemptionRepo?.manager;
    const fromDistrictId = canonicalBigintId(fromId);
    const toDistrictId = canonicalBigintId(toId);
    if (!runner || !fromDistrictId || !toDistrictId || !movedOrderIds.size) {
      return;
    }
    try {
      const { sql, params } = coverageExemptionRetargetQuery(
        fromDistrictId,
        toDistrictId,
        Array.from(movedOrderIds),
      );
      await runner.query(sql, params);
    } catch (error) {
      this.logger.error(
        `mergeDistricts #${fromId} → #${toId}: ko'chgan buyurtmalarning tuman #${fromId} imtiyozlarini #${toId} ga o'tkazib bo'lmadi: ${this.geoErrorText(error)}`,
      );
    }
  }

  /**
   * Birlashtirish BEKOR bo'ldi (A o'chmadi, buyurtmalar A ga qaytdi): shu
   * birlashtirishning oldingi snapshot'i yozgan (yangi yoki qayta
   * yo'naltirilgan) B tumanli imtiyozlar o'chiriladi — qolsa, buyurtma keyin
   * qo'lda B ga tahrirlanganda eski filial imtiyozi yana ishlab qolardi
   * (tahrir — imtiyoz yordam bermaydi). Har bir bunday filial A ga xizmat
   * qiladi (imtiyoz sharti), demak A dagi buyurtma uchun qator kerak emas.
   * A ga qaytmagan (B da qolgan) buyurtmalarniki qoladi; qolganlarning
   * ID'lari noma'lum bo'lsa — hech biri o'chirilmaydi (qaysi biri A da
   * ekani noma'lum). BEST-EFFORT: xato — ERROR log (tumanlar bilan).
   */
  private async dropAbortedMergeCoverageExemptions(ctx: {
    fromId: string;
    toId: string;
    created: readonly CreatedCoverageExemption[] | null | undefined;
    stranded: readonly GeoStranded[];
  }): Promise<void> {
    const { fromId, toId, created, stranded } = ctx;
    const runner = this.coverageExemptionRepo?.manager;
    const toDistrictId = canonicalBigintId(toId);
    if (!runner || !toDistrictId || !created?.length) {
      return;
    }
    const strandedOrders = stranded.filter((s) => s.kind === 'orders');
    if (strandedOrders.some((s) => s.ids === null)) {
      this.logger.warn(
        `mergeDistricts #${fromId} → #${toId} bekor qilindi: B da qolgan buyurtmalar ID'lari noma'lum — tuman #${toId} imtiyozlari o'chirilmadi`,
      );
      return;
    }
    const stillInB = new Set(
      strandedOrders.flatMap((s) =>
        (s.ids ?? []).map((orderId) => canonicalBigintId(orderId) ?? orderId),
      ),
    );
    const drop = created.filter(
      (row) => row.district_id === toDistrictId && !stillInB.has(row.order_id),
    );
    if (!drop.length) {
      return;
    }
    try {
      const { sql, params } = coverageExemptionDeleteQuery(
        drop,
        toDistrictId,
        'district_merge',
      );
      await runner.query(sql, params);
    } catch (error) {
      this.logger.error(
        `mergeDistricts #${fromId} → #${toId} bekor qilindi: tuman #${toId} imtiyozlarini (${drop.length} ta) o'chirib bo'lmadi: ${this.geoErrorText(error)}`,
      );
    }
  }

  /**
   * Tuman ↔ filial qamrovi — filialning xizmat tumanlari (ALMASHTIRISH):
   * `district_ids` dagilar shu filialga biriktiriladi, ilgari shu filialga
   * biriktirilgan, ro'yxatda yo'qlari bo'shatiladi (NULL). Boshqa filialdagi
   * tuman shu filialga KO'CHADI va javobda `moved` (from_branch_id) bilan
   * qaytadi. Bo'sh ro'yxat — filialning barcha tumanlari bo'shatiladi.
   *
   * Faqat superadmin/admin. Filial: mavjud, faol, HQ emas (HQ hamma tumanga
   * xizmat qiladi) va REGIONAL/HYBRID (PICKUP'da kuryer yo'q — 400
   * `branch_type_not_serving`). Har bir tuman mavjud; filial viloyati
   * bo'lsa tumanning xizmat viloyati (`effectiveDistrictRegionId`) unga teng
   * bo'lishi shart.
   */
  async setDistrictServingBranch(
    branchIdInput: unknown,
    districtIdsInput: unknown,
    requester?: RequesterContext,
  ) {
    if (!this.isSystemPrivileged(requester)) {
      this.forbidden(
        'Tumanlarni filialga faqat admin yoki superadmin biriktira oladi',
      );
    }

    const branchId = canonicalBigintId(branchIdInput);
    if (!branchId) {
      this.badRequest("branch_id noto'g'ri");
    }
    if (!Array.isArray(districtIdsInput)) {
      this.badRequest("district_ids massiv bo'lishi kerak");
    }
    const districtIds: string[] = [];
    const invalidDistrictIds: string[] = [];
    for (const raw of districtIdsInput as unknown[]) {
      const districtId = canonicalBigintId(raw);
      if (!districtId) {
        invalidDistrictIds.push(String(raw));
      } else if (!districtIds.includes(districtId)) {
        districtIds.push(districtId);
      }
    }
    if (invalidDistrictIds.length) {
      this.badRequest(
        `district_ids noto'g'ri: ${invalidDistrictIds.join(', ')}`,
      );
    }

    const branch = await this.findBranchCoverageRow(branchId);
    if (!branch) {
      this.notFound('Filial topilmadi');
    }
    if (branch.status !== String(Status.ACTIVE)) {
      this.badRequest("Filial faol emas — unga tuman biriktirib bo'lmaydi", {
        reason: 'branch_inactive',
      });
    }
    if (isHqBranch(branch)) {
      this.badRequest(
        'HQ filialiga tuman biriktirilmaydi — HQ barcha tumanlarga xizmat qiladi',
        { reason: 'branch_is_hq' },
      );
    }
    // Tumanga faqat kuryer saqlay oladigan filial xizmat qiladi (REGIONAL/
    // HYBRID). PICKUP'da kuryer yo'q va unga partiya jo'natilmaydi — tuman
    // unga biriktirilsa, hech bir filial kuryeri u buyurtmalarni ololmaydi.
    if (
      branch.type !== String(BranchType.REGIONAL) &&
      branch.type !== String(BranchType.HYBRID)
    ) {
      this.badRequest(
        `${branch.type ?? "Noma'lum"} turidagi filialga tuman biriktirilmaydi — faqat REGIONAL/HYBRID filial tumanga xizmat qiladi`,
        { reason: 'branch_type_not_serving' },
      );
    }

    if (districtIds.length) {
      const existing = await this.districtRepo.find({
        where: { id: In(districtIds) },
      });
      const existingById = new Map(
        existing.map((district) => [String(district.id), district]),
      );
      const missing = districtIds.filter((id) => !existingById.has(id));
      if (missing.length) {
        this.notFound(`Tuman topilmadi: ${missing.join(', ')}`, {
          reason: 'district_not_found',
          details: { district_ids: missing },
        });
      }
      if (branch.region_id) {
        const mismatched = existing
          .filter(
            (district) =>
              effectiveDistrictRegionId(district) !== branch.region_id,
          )
          .map((district) => String(district.id));
        if (mismatched.length) {
          this.badRequest(
            `Tuman(lar) filial viloyatiga tegishli emas: ${mismatched.join(', ')}`,
            {
              reason: 'district_region_mismatch',
              details: {
                district_ids: mismatched,
                branch_region_id: branch.region_id,
              },
            },
          );
        }
      }
    }

    // Tegiladigan tumanlar: tanlanganlar + filialning hozirgilari
    // (audit va javob uchun "oldin" holati).
    const touchedWhere: FindOptionsWhere<District>[] = [
      { serving_branch_id: branchId },
    ];
    if (districtIds.length) {
      touchedWhere.push({ id: In(districtIds) });
    }
    const selectedIds = new Set(districtIds);

    // Tuman qamrovi imtiyozlari (ega qarori): XIZMAT VILOYATI o'zgaradigan
    // tumanlarning ochiq buyurtmalari TRANZAKSIYADAN OLDIN o'qiladi (RMQ
    // tranzaksiya ichida kutilmasin). Xato — 503, hech narsa o'zgarmaydi.
    // anKpzwxk: `serving_branch_id` viloyatni o'zgartirmaydi — bu yerda
    // ko'chish hech qachon viloyat o'zgarishi emas, custody o'qilmaydi
    // (`regionChangingCoverageMoves`; javobda `coverage_exemptions` 0).
    let coverageCustody: CoverageCustody | null = null;
    if (this.coverageExemptionRepo) {
      const preTouched = await this.districtRepo.find({ where: touchedWhere });
      coverageCustody = await this.loadCoverageCustody(
        regionChangingCoverageMoves(
          preTouched
            .filter(
              (district) =>
                districtServingBranchId(district) !==
                (selectedIds.has(String(district.id)) ? branchId : null),
            )
            .map((district) => ({
              district_id: String(district.id),
              before: { ...district },
              after: {
                ...district,
                serving_branch_id: selectedIds.has(String(district.id))
                  ? branchId
                  : null,
              },
            })),
        ).map((move) => move.district_id),
      );
    }

    const { changes, coverageCreated, coverageMoves } =
      await this.districtRepo.manager.transaction(async (manager) => {
        const repo = manager.getRepository(District);
        const touched = await repo.find({ where: touchedWhere });
        const before = new Map(
          touched.map((district) => [
            String(district.id),
            districtServingBranchId(district),
          ]),
        );

        // Filialning tanlanmagan tumanlari — bitta UPDATE.
        await repo.update(
          districtIds.length
            ? { serving_branch_id: branchId, id: Not(In(districtIds)) }
            : { serving_branch_id: branchId },
          { serving_branch_id: null },
        );
        if (districtIds.length) {
          await repo.update(
            { id: In(districtIds) },
            { serving_branch_id: branchId },
          );
        }

        const txChanges = Array.from(before.entries())
          .map(([districtId, previous]) => ({
            district_id: districtId,
            previous_branch_id: previous,
            branch_id: selectedIds.has(districtId) ? branchId : null,
          }))
          .filter((change) => change.previous_branch_id !== change.branch_id);

        // Imtiyozlar SHU tranzaksiyada: oldin — tumanning tranzaksiyadagi
        // qatori, keyin — yangi xizmat filiali bilan. Yozish yiqilsa tuman
        // o'zgarishi ham rollback (fail closed).
        let created: CreatedCoverageExemption[] | null = null;
        let moves: CoverageDistrictMove[] = [];
        if (coverageCustody) {
          const touchedById = new Map(
            touched.map((district) => [String(district.id), district]),
          );
          moves = regionChangingCoverageMoves(
            txChanges.map((change) => {
              const row = touchedById.get(change.district_id) as District;
              return {
                district_id: change.district_id,
                before: { ...row },
                after: { ...row, serving_branch_id: change.branch_id },
              };
            }),
          );
          created = await this.saveCoverageExemptions(
            this.coverageExemptionsFor(coverageCustody, moves),
            'set_serving_branch',
            manager,
          );
        }
        return {
          changes: txChanges,
          coverageCreated: created,
          coverageMoves: moves,
        };
      });

    // COMMIT'dan keyin qayta snapshot (best-effort): tranzaksiyadan oldingi
    // o'qish va COMMIT orasida eski filial custody'siga kirganlar ham.
    const coverageAll = combineCoverageCreated(
      coverageCreated,
      coverageCreated && coverageMoves.length
        ? await this.resnapshotCoverageExemptions({
            moves: coverageMoves,
            source: 'set_serving_branch',
            context: `setDistrictServingBranch: filial #${branchId}`,
          })
        : null,
    );

    for (const change of changes) {
      await this.activityLog.logChange({
        entity_type: 'District',
        entity_id: change.district_id,
        action: change.branch_id
          ? ActivityAction.ASSIGN
          : ActivityAction.UNASSIGN,
        old_value: { serving_branch_id: change.previous_branch_id },
        new_value: {
          serving_branch_id: change.branch_id,
          ...(coverageAll
            ? {
                coverage_exemptions: summarizeCoverageExemptions(
                  coverageAll,
                  change.district_id,
                ),
              }
            : {}),
        },
        metadata: { source: 'set_serving_branch', branch_id: branchId },
        ...this.auditActor(requester),
      });
    }

    const added = changes
      .filter((change) => change.branch_id !== null)
      .map((change) => change.district_id);
    const removed = changes
      .filter((change) => change.branch_id === null)
      .map((change) => change.district_id);
    const moved = changes
      .filter(
        (change) =>
          change.branch_id !== null && change.previous_branch_id !== null,
      )
      .map((change) => ({
        district_id: change.district_id,
        from_branch_id: change.previous_branch_id as string,
      }));

    return successRes(
      {
        branch_id: branchId,
        district_ids: districtIds,
        added,
        removed,
        moved,
        ...(coverageAll
          ? {
              coverage_exemptions: summarizeCoverageExemptions(coverageAll),
            }
          : {}),
      },
      200,
      'Filial xizmat tumanlari yangilandi',
    );
  }

  /** Tuman ↔ filial qamrovi — filialga biriktirilgan tumanlar (nom bo'yicha). */
  async findDistrictsByServingBranch(branchIdInput: unknown) {
    const branchId = canonicalBigintId(branchIdInput);
    if (!branchId) {
      this.badRequest("branch_id noto'g'ri");
    }
    const districts = await this.districtRepo.find({
      where: { serving_branch_id: branchId },
      relations: ['region', 'assignedToRegion'],
      order: { name: 'ASC' },
    });
    return successRes(districts);
  }

  /**
   * Tuman ↔ filial qamrovi — filial o'chirilgach / nofaol qilingach uning
   * barcha tumanlari bo'shatiladi (branch-service chaqiradi; idempotent).
   */
  async clearDistrictServingBranch(branchIdInput: unknown) {
    const branchId = canonicalBigintId(branchIdInput);
    if (!branchId) {
      this.badRequest("branch_id noto'g'ri");
    }
    const touched = await this.districtRepo.find({
      where: { serving_branch_id: branchId },
    });
    if (!touched.length) {
      return successRes({ branch_id: branchId, cleared: 0 });
    }

    // Tuman qamrovi imtiyozlari — BEST-EFFORT (bo'shatishdan OLDIN): filial
    // allaqachon o'chirilgan / nofaol / boshqa viloyatda — o'chgan filialga
    // ishora qiluvchi tuman yangi buyurtmalarni ham qotirib qo'yardi, shuning
    // uchun imtiyoz yozilmasa ham bo'shatish bajariladi (ERROR log).
    const coverageMoves: CoverageDistrictMove[] = touched.map((district) => ({
      district_id: String(district.id),
      before: { ...district },
      after: { ...district, serving_branch_id: null },
    }));
    let coverageBefore: CreatedCoverageExemption[] | null = null;
    let coverageBeforeFailed = false;
    try {
      coverageBefore = await this.snapshotCoverageExemptions({
        moves: coverageMoves,
        source: 'clear_serving_branch',
      });
    } catch (error) {
      coverageBeforeFailed = true;
      this.logger.error(
        `clearDistrictServingBranch: filial #${branchId} tumanlari (${touched.map((district) => String(district.id)).join(', ')}) imtiyozsiz bo'shatiladi — imtiyozlarni yozib bo'lmadi: ${this.geoErrorText(error)}`,
      );
    }

    const result = await this.districtRepo.update(
      { serving_branch_id: branchId },
      { serving_branch_id: null },
    );

    // Bo'shatilgach qayta snapshot (best-effort). Oldingisi yiqilgan bo'lsa
    // ham urinadi; ikkalasi ham yiqilsa — `coverage_exemptions_failed`
    // (oldingisi yiqilgan bo'lsa repo ulangan: `null` — faqat xato).
    const coverageAfter = await this.resnapshotCoverageExemptions({
      moves: coverageMoves,
      source: 'clear_serving_branch',
      context: `clearDistrictServingBranch: filial #${branchId}`,
    });
    const coverageCreated = combineCoverageCreated(
      coverageBefore,
      coverageAfter,
    );
    const coverageFailed = coverageBeforeFailed && coverageAfter === null;

    for (const district of touched) {
      await this.activityLog.logChange({
        entity_type: 'District',
        entity_id: String(district.id),
        action: ActivityAction.UNASSIGN,
        old_value: { serving_branch_id: branchId },
        new_value: {
          serving_branch_id: null,
          ...(coverageCreated
            ? {
                coverage_exemptions: summarizeCoverageExemptions(
                  coverageCreated,
                  String(district.id),
                ),
              }
            : {}),
          ...(coverageFailed ? { coverage_exemptions_failed: true } : {}),
        },
        metadata: { source: 'clear_serving_branch', branch_id: branchId },
      });
    }

    return successRes({
      branch_id: branchId,
      cleared: Number(result?.affected ?? touched.length),
      ...(coverageCreated
        ? { coverage_exemptions: summarizeCoverageExemptions(coverageCreated) }
        : {}),
      ...(coverageFailed ? { coverage_exemptions_failed: true } : {}),
    });
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
      this.notFound('Tuman topilmadi');
    }

    const before = {
      assigned_region: district.assigned_region,
      serving_branch_id: districtServingBranchId(district),
    };
    const beforeRegionId = effectiveDistrictRegionId(district);
    // Qamrov imtiyozlari uchun ko'chishdan oldingi qator (o'zgartirishdan oldin).
    const beforeCoverage: CoverageDistrict = {
      id: district.id,
      region_id: district.region_id,
      assigned_region: district.assigned_region,
      serving_branch_id: district.serving_branch_id,
    };

    if (district.assigned_region === dto.assigned_region) {
      this.badRequest('Tuman allaqachon shu viloyatga biriktirilgan');
    }

    const assigningRegion = await this.regionRepo.findOne({
      where: { id: dto.assigned_region },
    });
    if (!assigningRegion) {
      this.notFound('Biriktirilayotgan viloyat topilmadi');
    }

    district.assigned_region = assigningRegion.id;
    district.assignedToRegion = assigningRegion;

    // Tuman ↔ filial qamrovi: xizmat viloyati o'zgarsa eski xizmat filiali
    // (eski viloyatniki) bo'shatiladi — yangi viloyatda filial qayta
    // biriktiriladi (`logistics.district.set_serving_branch`). Viloyat amalda
    // o'zgarmasa (masalan, assigned_region = region_id) filial saqlanadi.
    const servingBranchCleared =
      !!before.serving_branch_id &&
      effectiveDistrictRegionId(district) !== beforeRegionId;
    if (servingBranchCleared) {
      district.serving_branch_id = null;
    }

    // Tuman qamrovi imtiyozlari (ega qarori): xizmat viloyati o'zgarsa (xizmat
    // filiali bo'shashi ham shu holatda) — hozir eski filial / uning kuryeri
    // qo'lidagi ochiq buyurtmalar eski filialda tugaydi. Tuman SAQLANISHIDAN
    // OLDIN; xato — 503, tuman o'zgarmaydi (fail closed). Saqlash keyin
    // yiqilsa ortiqcha imtiyoz zararsiz (filial baribir xizmat qiladi).
    const coverageMoves: CoverageDistrictMove[] =
      effectiveDistrictRegionId(district) !== beforeRegionId
        ? [
            {
              district_id: String(district.id),
              before: beforeCoverage,
              after: {
                id: district.id,
                region_id: district.region_id,
                assigned_region: district.assigned_region,
                serving_branch_id: district.serving_branch_id,
              },
            },
          ]
        : [];
    const coverageCreated = coverageMoves.length
      ? await this.snapshotCoverageExemptions({
          moves: coverageMoves,
          source: 'district_update',
        })
      : null;

    const saved = await this.districtRepo.save(district);
    void this.syncDistrictToSearch(saved);

    // Saqlangach qayta snapshot (best-effort): oldingi o'qish va saqlash
    // orasida eski filial custody'siga kirganlar ham imtiyozli.
    const coverageAll = combineCoverageCreated(
      coverageCreated,
      coverageCreated
        ? await this.resnapshotCoverageExemptions({
            moves: coverageMoves,
            source: 'district_update',
            context: 'updateDistrict',
          })
        : null,
    );
    const coverageSummary = coverageAll
      ? summarizeCoverageExemptions(coverageAll)
      : null;

    await this.activityLog.logChange({
      entity_type: 'District',
      entity_id: String(saved.id),
      action: ActivityAction.UPDATED,
      old_value: before,
      new_value: {
        assigned_region: saved.assigned_region,
        serving_branch_id: districtServingBranchId(saved),
        serving_branch_cleared: servingBranchCleared,
        ...(coverageSummary ? { coverage_exemptions: coverageSummary } : {}),
      },
      ...this.auditActor(requester),
    });

    const responseData: Record<string, unknown> = {
      ...saved,
      serving_branch_cleared: servingBranchCleared,
      ...(coverageSummary ? { coverage_exemptions: coverageSummary } : {}),
    };
    // Ixtiyoriy (ega qarori): HQ NEW pochtalaridagi shu tuman ochiq
    // buyurtmalarini yangi xizmat viloyati pochtasiga ko'chirish — tuman
    // SAQLANGANDAN keyin. Ko'chirish yiqilsa ham tuman o'zgarishi saqlangan:
    // PATCH muvaffaqiyatli qaytadi, xato `rehome_error` da — admin alohida
    // `logistics.district.rehome_open_orders` bilan qayta urinadi (idempotent).
    if (dto?.rehome_open_orders === true) {
      try {
        responseData.rehome = await this.rehomeDistrictOpenOrders(
          saved,
          requester,
        );
      } catch (error) {
        const downstream: unknown =
          error instanceof RpcException ? error.getError() : error;
        const statusCode = Number(
          (downstream as { statusCode?: unknown } | null)?.statusCode ?? 500,
        );
        const rawMessage =
          (downstream as { message?: unknown } | null)?.message ??
          (error as Error | null)?.message;
        const message =
          typeof rawMessage === 'string' && rawMessage
            ? rawMessage
            : "Ochiq buyurtmalarni ko'chirib bo'lmadi";
        this.logger.warn(
          `updateDistrict: tuman #${String(saved.id)} saqlandi, lekin ochiq buyurtmalar ko'chirilmadi: ${message}`,
        );
        responseData.rehome = null;
        responseData.rehome_error = { statusCode, message };
      }
    }

    return successRes(responseData, 200, 'District assigned to new region');
  }

  /**
   * Tuman boshqa (xizmat) viloyatiga o'tkazilgach, HQ'dagi hali jo'natilmagan
   * shu tuman buyurtmalarini eski viloyat NEW pochtasidan yangi viloyat NEW
   * pochtasiga ko'chirish (`logistics.district.rehome_open_orders`; faqat
   * superadmin/admin). Aks holda ular qotib qolardi: eski viloyat filialiga
   * tuman qamrovi (`isOrderServedByBranch`), yangi viloyat filialiga LC-09
   * (pochta hududi) yo'l bermaydi, pochtadan buyurtma chiqarish yo'li esa yo'q
   * (CODE-11/CODE-12). Ega qarori: `order.region_id` O'ZGARMAYDI — faqat
   * pochta a'zoligi. Idempotent: qayta chaqirilsa hech narsa ko'chmaydi.
   */
  async rehomeOpenDistrictOrders(
    districtIdInput: unknown,
    requester?: RequesterContext,
  ) {
    if (!this.isSystemPrivileged(requester)) {
      this.forbidden(
        "Tuman buyurtmalarini boshqa viloyat pochtasiga faqat admin yoki superadmin ko'chira oladi",
      );
    }
    const districtId = canonicalBigintId(districtIdInput);
    if (!districtId) {
      this.badRequest("Tuman id'si noto'g'ri");
    }
    const district = await this.districtRepo.findOne({
      where: { id: districtId },
    });
    if (!district) {
      this.notFound('Tuman topilmadi');
    }
    const result = await this.rehomeDistrictOpenOrders(district, requester);
    return successRes(
      result,
      200,
      result.moved
        ? `${result.moved} ta buyurtma yangi viloyat pochtasiga ko'chirildi`
        : "Ko'chiriladigan buyurtma topilmadi",
    );
  }

  /**
   * `rehomeOpenDistrictOrders` yadrosi (ruxsat chaqiruvchida tekshirilgan).
   *
   * - Maqsad hudud — tumanning xizmat viloyati (`assigned_region ??
   *   region_id`); aniqlanmasa — 400.
   * - Manba — HQ NEW pochtalari (HQ qabuli `receiveOrdersIntoPosts` /
   *   `newPosts` buyurtmalarni faqat NEW pochtaga hudud bo'yicha yig'adi),
   *   hududi maqsaddan farqli.
   * - Buyurtma — shu tumanniki, `districtRehomeSkipReason` o'tkazgani va HQ
   *   omborida (LC-03 `isInHqCustody`, `newPosts` bilan bir xil; HQ
   *   aniqlanmasa — xato, hech narsa ko'chmaydi); qolganlari `skipped` da
   *   sababi bilan. Tsikl ketma-ket RMQ bo'lgani uchun har bir ko'chirishdan
   *   oldin buyurtma va maqsad pochta qayta o'qiladi — o'zgargani
   *   ko'chirilmaydi (`changed_during_rehome` / `target_post_not_new`).
   * - Maqsad pochta — `receiveOrdersIntoPosts` kaliti (hudud + NEW +
   *   `branch_id`, manba pochtaning filial o'lchovi bilan) bo'yicha topiladi
   *   yoki yaratiladi; buyurtma `order.update` (faqat `post_id`) bilan
   *   ko'chiriladi — `newPosts` / `collapseDuplicateNewPosts` yo'li.
   *
   * Yarmida yiqilsa (bulk-assign naqshi): allaqachon ko'chganlar (va javobi
   * kelmagan yangilanish) teskari tartibda eski pochtasiga qaytariladi
   * (best-effort), shu chaqiruvda yaratilgan maqsad pochta qayta o'qishda
   * unga hech kim ishora qilmasa o'chiriladi va xato qaytadi. Hisoblagichlar faqat hammasi ko'chgandan keyin yangilanadi,
   * ya'ni yiqilganda ular o'zgarmaydi. Qaytmay qolganlar — ERROR log (ular
   * maqsad pochtada turadi, jo'natish mumkin).
   */
  private async rehomeDistrictOpenOrders(
    district: District,
    requester?: RequesterContext,
  ): Promise<DistrictRehomeResult> {
    const districtId = String(district.id);
    const targetRegionId = effectiveDistrictRegionId(district);
    if (!targetRegionId) {
      this.badRequest(
        "Tumanning xizmat viloyati aniqlanmadi — buyurtmalarni ko'chirib bo'lmaydi",
        { reason: 'district_region_missing' },
      );
    }

    const result: DistrictRehomeResult = {
      district_id: districtId,
      target_region_id: targetRegionId,
      moved: 0,
      order_ids: [],
      from_post_ids: [],
      to_post_id: null,
      to_post_ids: [],
      deleted_post_ids: [],
      skipped: [],
    };

    const sourcePosts = (
      await this.postRepo.find({ where: { status: Post_status.NEW } })
    ).filter((post) => canonicalBigintId(post.region_id) !== targetRegionId);
    if (!sourcePosts.length) {
      return result;
    }
    const sourcePostById = new Map(
      sourcePosts.map((post) => [String(post.id), post]),
    );

    const districtOrders = (
      await this.findOrders({
        post_ids: Array.from(sourcePostById.keys()),
        district_id: districtId,
        fetch_all: true,
        limit: 1000,
      })
    ).filter(
      (order) =>
        canonicalBigintId(order.district_id) === districtId &&
        sourcePostById.has(String(order.post_id ?? '').trim()),
    );

    // LC-03: faqat HQ omboridagi buyurtma ko'chadi. HQ aniqlanmasa — xato
    // (fail closed, `filterHqCustodyOrphans` kabi hech narsa ko'chmaydi).
    const hqBranchId = districtOrders.length ? await this.findHqBranchId() : '';

    // Manba pochtaning filial o'lchovi ('' — branch_id yo'q) bo'yicha guruh.
    const eligibleByBranch = new Map<string, OrderRow[]>();
    for (const order of districtOrders) {
      const reason = this.districtRehomeOrderSkipReason(order, hqBranchId);
      if (reason) {
        result.skipped.push({ order_id: String(order.id), reason });
        continue;
      }
      const sourcePost = sourcePostById.get(String(order.post_id ?? '').trim());
      const branchKey = String(sourcePost?.branch_id ?? '').trim();
      const group = eligibleByBranch.get(branchKey) ?? [];
      group.push(order);
      eligibleByBranch.set(branchKey, group);
    }
    if (!eligibleByBranch.size) {
      return result;
    }

    const movedOrders: DistrictRehomeMove[] = [];
    const createdPosts: Post[] = [];
    const targetPosts: Post[] = [];
    // Javobi kelmagan `order.update` (masalan, 5 s timeout) — order-service
    // uni kechikib qo'llashi mumkin, shuning uchun kompensatsiyaga kiradi.
    let inFlight: DistrictRehomeMove | null = null;
    try {
      for (const [branchKey, orders] of eligibleByBranch) {
        let targetPost = await this.postRepo.findOne({
          where: {
            region_id: targetRegionId,
            status: Post_status.NEW,
            branch_id: branchKey || IsNull(),
          },
        });
        if (!targetPost) {
          targetPost = await this.postRepo.save(
            this.postRepo.create({
              courier_id: '0',
              qr_code_token: this.generateToken(),
              region_id: targetRegionId,
              branch_id: branchKey || null,
              status: Post_status.NEW,
              post_total_price: 0,
              order_quantity: 0,
            }),
          );
          createdPosts.push(targetPost);
          void this.syncPostToSearch(targetPost);
        }
        targetPosts.push(targetPost);

        let targetOpen = true;
        for (const order of orders) {
          const orderId = String(order.id);
          const fromPostId = String(order.post_id ?? '').trim();
          // Oldindan o'qilgan holat tsikl davomida eskiradi: maqsad pochta
          // kuryerga jo'natilgan (SENT) bo'lsa, qolganlari ko'chmaydi.
          if (targetOpen) {
            targetOpen = !!(await this.postRepo.findOne({
              where: { id: targetPost.id, status: Post_status.NEW },
            }));
          }
          if (!targetOpen) {
            result.skipped.push({
              order_id: orderId,
              reason: 'target_post_not_new',
            });
            continue;
          }
          // Buyurtma ham qayta o'qiladi: kuryerga berilgan / boshqa pochtaga
          // o'tgan / HQ omboridan chiqqan bo'lsa — ko'chirilmaydi.
          const fresh = await this.findOrderById(orderId);
          if (
            String(fresh?.post_id ?? '').trim() !== fromPostId ||
            canonicalBigintId(fresh?.district_id) !== districtId ||
            this.districtRehomeOrderSkipReason(fresh, hqBranchId)
          ) {
            result.skipped.push({
              order_id: orderId,
              reason: 'changed_during_rehome',
            });
            continue;
          }
          inFlight = {
            id: orderId,
            fromPostId,
            toPostId: String(targetPost.id),
          };
          // Faqat `post_id` — `region_id` ATAYLAB yuborilmaydi (ega qarori).
          await this.updateOrder(orderId, { post_id: targetPost.id });
          movedOrders.push(inFlight);
          inFlight = null;
        }
      }
    } catch (error) {
      await this.rollbackDistrictRehome(
        districtId,
        movedOrders,
        inFlight,
        targetPosts,
        createdPosts,
      );
      throw error;
    }

    result.moved = movedOrders.length;
    result.order_ids = movedOrders.map((moved) => moved.id);
    result.from_post_ids = Array.from(
      new Set(movedOrders.map((moved) => moved.fromPostId)),
    );
    result.to_post_ids = Array.from(
      new Set(movedOrders.map((moved) => moved.toPostId)),
    );
    result.to_post_id = result.to_post_ids[0] ?? null;

    // Hisoblagichlar buyurtmalardan qayta hisoblanadi
    // (`collapseDuplicateNewPosts` kanonik pochtasi bilan bir xil); bo'shagan
    // manba NEW pochta (va hech narsa kelmagan, shu chaqiruvda yaratilgan
    // maqsad pochta) o'chiriladi (LOG-01 / LC-02: faqat qayta o'qishda unga
    // hech bir buyurtma ishora qilmasa).
    for (const post of targetPosts) {
      await this.recountRehomedNewPost(post, createdPosts.includes(post));
    }
    for (const postId of result.from_post_ids) {
      const sourcePost = sourcePostById.get(postId);
      if (sourcePost && (await this.recountRehomedNewPost(sourcePost, true))) {
        result.deleted_post_ids.push(postId);
      }
    }
    if (!result.moved) {
      return result;
    }

    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: String(result.to_post_id),
      action: 'logistics.post_rehome_district_orders',
      ...this.auditActor(requester),
      metadata: {
        district_id: districtId,
        target_region_id: targetRegionId,
        order_count: result.moved,
        order_ids: result.order_ids.slice(0, 10),
        from_post_ids: result.from_post_ids.slice(0, 10),
        to_post_ids: result.to_post_ids,
        deleted_post_ids: result.deleted_post_ids,
        skipped_count: result.skipped.length,
      },
    });

    return result;
  }

  /**
   * `districtRehomeSkipReason` + LC-03 HQ ombori (`isInHqCustody`, `newPosts`
   * bilan bir xil): filial (masalan, viloyat filiali qabul qilgan, holder
   * BRANCH R) buyurtmasi HQ hudud pochtasiga ko'chsa, aralash doirali pochtani
   * HQ registratori ocha olmasdi (getPostOrders 403).
   */
  private districtRehomeOrderSkipReason(
    order: OrderRow,
    hqBranchId: string,
  ): string | null {
    return (
      districtRehomeSkipReason(order) ??
      (this.isInHqCustody(order, hqBranchId) ? null : 'not_in_hq_custody')
    );
  }

  /**
   * `rehomeDistrictOpenOrders` kompensatsiyasi: javobi kelmagan yangilanish
   * va ko'chganlar teskari tartibda eski pochtasiga (best-effort),
   * qaytmaganlar — ERROR log. Maqsad pochtalar buyurtmalardan qayta
   * hisoblanadi; shu chaqiruvda yaratilgani faqat qayta o'qishda unga hech
   * bir buyurtma ishora qilmasa o'chiriladi (kechikib qo'llangan yangilanish
   * yetim qolmasin — LOG-01 / LC-02 naqshi).
   */
  private async rollbackDistrictRehome(
    districtId: string,
    movedOrders: readonly DistrictRehomeMove[],
    inFlight: DistrictRehomeMove | null,
    targetPosts: readonly Post[],
    createdPosts: readonly Post[],
  ): Promise<void> {
    if (inFlight) {
      // Birinchi yangilanish qo'llanmagan bo'lsa ham zararsiz (post_id o'sha).
      try {
        await this.updateOrder(inFlight.id, { post_id: inFlight.fromPostId });
      } catch {
        this.logger.warn(
          `rehomeOpenDistrictOrders: tuman #${districtId} — buyurtma #${inFlight.id} holati noaniq (yangilanish javobi kelmadi, qaytarish ham yiqildi)`,
        );
      }
    }
    const stranded: Array<{ id: string; toPostId: string }> = [];
    for (const moved of [...movedOrders].reverse()) {
      try {
        await this.updateOrder(moved.id, { post_id: moved.fromPostId });
      } catch {
        stranded.push({ id: moved.id, toPostId: moved.toPostId });
      }
    }
    for (const post of targetPosts) {
      await this.recountRehomedNewPost(post, createdPosts.includes(post));
    }
    if (stranded.length) {
      this.logger.error(
        `rehomeOpenDistrictOrders: tuman #${districtId} — kompensatsiya to'liq emas, buyurtmalar maqsad pochtada qoldi: ${JSON.stringify(stranded)}`,
      );
    }
  }

  /**
   * NEW pochta hisoblagichlarini buyurtmalardan qayta hisoblash. `removeIfEmpty`
   * va pochtaga hech bir buyurtma ishora qilmasa — pochta o'chiriladi (natija
   * `true`). O'qib/yozib bo'lmasa — ogohlantirish (buyurtmalar allaqachon
   * ko'chgan; `newPosts` ro'yxati sanoqni baribir buyurtmalardan oladi).
   *
   * `post` — tsikldan OLDIN o'qilgan: shu orada HQ uni kuryerga jo'natgan
   * (SENT, courier_id) bo'lishi mumkin. Shuning uchun eskirgan obyekt
   * `save`/`remove` qilinmaydi — faqat hisoblagichlar va faqat pochta hali
   * NEW bo'lsa yoziladi/o'chiriladi (`newPosts` atomik naqshi).
   */
  private async recountRehomedNewPost(
    post: Post,
    removeIfEmpty: boolean,
  ): Promise<boolean> {
    try {
      const orders = await this.findOrders({
        post_ids: [String(post.id)],
        fetch_all: true,
        limit: 1000,
      });
      if (!orders.length && removeIfEmpty) {
        const deleted = await this.postRepo.delete({
          id: post.id,
          status: Post_status.NEW,
        });
        if (!deleted?.affected) {
          return false;
        }
        void this.removePostFromSearch(post);
        return true;
      }
      await this.postRepo.update(
        { id: post.id, status: Post_status.NEW },
        {
          order_quantity: orders.length,
          post_total_price: orders.reduce(
            (sum, order) => sum + Number(order.total_price ?? 0),
            0,
          ),
        },
      );
      const refreshed = await this.postRepo.findOne({
        where: { id: post.id },
      });
      if (refreshed) {
        void this.syncPostToSearch(refreshed);
      }
    } catch (error) {
      this.logger.warn(
        `rehomeOpenDistrictOrders: pochta #${String(post.id)} hisoblagichi yangilanmadi: ${(error as Error)?.message ?? String(error)}`,
      );
    }
    return false;
  }

  async updateDistrictName(id: string, dto: UpdateDistrictNameDto) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('Tuman topilmadi');
    }

    const before = { name: district.name };

    const trimmedName = dto.name.trim();
    if (!trimmedName) {
      this.badRequest('Tuman nomi majburiy');
    }

    const duplicate = await this.districtRepo.findOne({
      where: { name: trimmedName, region_id: district.region_id },
    });
    if (duplicate && duplicate.id !== district.id) {
      this.conflict('Bu viloyatda shu nomli tuman allaqachon mavjud');
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
      this.notFound('Tuman topilmadi');
    }

    const before = { sato_code: district.sato_code };

    // Prefiks — tumanning GEOGRAFIK viloyati bo'yicha (`assigned_region` emas).
    const region = await this.regionRepo.findOne({
      where: { id: district.region_id },
    });
    const satoCode = this.normalizeDistrictSatoCode(dto?.sato_code, region);
    await this.assertDistrictSatoCodeFree(satoCode, id);

    district.sato_code = satoCode;
    let savedDistrict: District;
    try {
      savedDistrict = await this.districtRepo.save(district);
    } catch (err) {
      // SlMjauWC: tekshiruv va yozish orasidagi poyga — unique indeks 23505.
      if (this.isUniqueViolation(err)) {
        this.conflict('Bunday SOATO kodli tuman allaqachon mavjud');
      }
      throw err;
    }
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
      this.notFound('Tuman topilmadi');
    }
    return successRes(district);
  }

  /**
   * «Yangi tuman qo'shish» formasi uchun: viloyatning RASMIY SOATO ro'yxati
   * (`data/sato-codes.ts`) — admin kodni yoddan bilishi shart emas, ro'yxatdan
   * tanlaydi. `taken_by` — kod tizimda band (tuman yoki viloyatda), qo'shib
   * bo'lmaydi (`assertDistrictSatoCodeFree` bilan bir xil qoida). Viloyat
   * rasmiy ro'yxatda topilmasa — bo'sh ro'yxat (kod qo'lda kiritiladi).
   */
  async listOfficialDistrictSatoCodes(regionId: string) {
    // bigint ustuni: raqam bo'lmagan id SQL xatosi (500) emas, 404 bo'lsin.
    const region = /^\d+$/.test(String(regionId ?? ''))
      ? await this.regionRepo.findOne({ where: { id: regionId } })
      : null;
    if (!region) {
      this.notFound('Viloyat topilmadi');
    }
    const official = findSatoRegionFor(region);
    if (!official) {
      return successRes({
        region_id: region.id,
        region_sato_code: region.sato_code ?? null,
        items: [],
      });
    }
    const codes = official.districts.map((district) => district.sato_code);
    const [districtHolders, regionHolders] = await Promise.all([
      this.districtRepo.find({
        where: { sato_code: In(codes) },
        select: { id: true, name: true, sato_code: true, region_id: true },
      }),
      this.regionRepo.find({
        where: { sato_code: In(codes) },
        select: { id: true, name: true, sato_code: true },
      }),
    ]);
    const holderByCode = new Map<
      string,
      { kind: 'district' | 'region'; id: string; name: string }
    >();
    for (const holder of regionHolders) {
      holderByCode.set(holder.sato_code!, {
        kind: 'region',
        id: String(holder.id),
        name: holder.name,
      });
    }
    for (const holder of districtHolders) {
      holderByCode.set(holder.sato_code!, {
        kind: 'district',
        id: String(holder.id),
        name: holder.name,
      });
    }
    return successRes({
      region_id: region.id,
      region_sato_code: official.sato_code,
      items: official.districts.map((district) => ({
        name: district.name,
        sato_code: district.sato_code,
        taken_by: holderByCode.get(district.sato_code) ?? null,
      })),
    });
  }

  async matchDistrictSatoCodes() {
    const dbDistricts = await this.districtRepo.find({
      where: { isDeleted: false },
      relations: ['region'],
    });

    return successRes(
      matchDistricts(dbDistricts),
      200,
      'SATO matching natijasi',
    );
  }

  /**
   * SlMjauWC (N5) — avtomatik moslangan kodlarni yozish. Matcher faqat
   * tumanning o'z viloyatidan va hali hech kimda yo'q kodni taklif qiladi;
   * bu yerda YOZISHDAN OLDIN yana tekshiriladi (kod boshqa o'chirilmagan
   * tumanda yo'q, viloyat prefiksi mos), unique indeks poygasi (23505) —
   * o'tkazib yuboriladi. O'tkazilganlar javobda `skipped` (sabab bilan).
   */
  async applyDistrictSatoCodes() {
    const dbDistricts = await this.districtRepo.find({
      where: { isDeleted: false },
      relations: ['region'],
    });
    const matchResult = matchDistricts(dbDistricts);
    const byId = new Map(dbDistricts.map((d) => [String(d.id), d]));

    let appliedCount = 0;
    const applied: Array<{ id: string; name: string; sato_code: string }> = [];
    const skipped: Array<{
      id: string;
      name: string;
      sato_code: string;
      reason: 'code_taken' | 'region_prefix_mismatch' | 'not_found';
    }> = [];

    for (const match of matchResult.matched) {
      if (match.satoName === '(allaqachon mavjud)') continue;
      const skip = (reason: (typeof skipped)[number]['reason']) =>
        skipped.push({
          id: match.dbId,
          name: match.dbName,
          sato_code: match.satoCode,
          reason,
        });

      const district = byId.get(String(match.dbId));
      if (!district) {
        skip('not_found');
        continue;
      }
      const regionCode = district.region?.sato_code?.trim();
      if (regionCode && !match.satoCode.startsWith(regionCode)) {
        skip('region_prefix_mismatch');
        continue;
      }
      const holder = await this.districtRepo.findOne({
        where: {
          sato_code: match.satoCode,
          isDeleted: false,
          id: Not(match.dbId),
        },
      });
      if (holder) {
        skip('code_taken');
        continue;
      }
      try {
        await this.districtRepo.update(match.dbId, {
          sato_code: match.satoCode,
        });
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          skip('code_taken');
          continue;
        }
        throw err;
      }
      applied.push({
        id: match.dbId,
        name: match.dbName,
        sato_code: match.satoCode,
      });
      appliedCount++;
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
        skipped,
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
   *
   * oNAE3LW9 (prod 2-tur): asosiy sonlar — faqat O'CHIRILMAGAN yozuvlar,
   * o'chirilganlari `deleted` da (`GeoUsage` izohi).
   */
  private async collectGeoUsage(
    where: { district_id?: string; region_id?: string },
    purpose = "o'chirish",
  ): Promise<GeoUsage> {
    type Asked = { live: Partial<GeoCounts>; deleted: Partial<GeoCounts> };
    const ask = async (
      client: ClientProxy,
      cmd: string,
      fields: Array<keyof GeoCounts>,
    ): Promise<Asked> => {
      try {
        const res = await lastValueFrom(
          client.send({ cmd }, where).pipe(timeout(8000)),
        );
        const data = (res as { data?: Record<string, unknown> })?.data ?? {};
        const out: Asked = { live: {}, deleted: {} };
        for (const field of fields) {
          const raw = data[field];
          const value = Number(raw);
          // Eski versiya maydonni qaytarmasa ham FAIL-CLOSED (0 deb olinmaydi).
          if (raw === undefined || raw === null || !Number.isFinite(value)) {
            throw new Error(`${cmd}: noto'g'ri javob (${field})`);
          }
          out.live[field] = value;
          /**
           * oNAE3LW9 (prod 2-tur): `deleted_<maydon>` — o'chirilganlar.
           * Bo'lmasa 0: eski servis o'chirilganlarni asosiy maydonda sanaydi
           * (himoya ortiqcha qattiq bo'ladi, tasdiqlash jami bo'yicha baribir
           * to'g'ri). Bor-u noto'g'ri bo'lsa — FAIL-CLOSED.
           */
          const rawDeleted = data[`deleted_${field}`];
          const deleted = Number(rawDeleted);
          if (rawDeleted === undefined || rawDeleted === null) {
            out.deleted[field] = 0;
          } else if (!Number.isFinite(deleted) || deleted < 0) {
            throw new Error(`${cmd}: noto'g'ri javob (deleted_${field})`);
          } else {
            out.deleted[field] = deleted;
          }
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
    const pick = (part: 'live' | 'deleted'): GeoCounts => ({
      orders: order[part].orders ?? 0,
      users: identity[part].users ?? 0,
      branches: branch[part].branches ?? 0,
      transfer_batches: order[part].transfer_batches ?? 0,
    });
    return { ...pick('live'), deleted: pick('deleted') };
  }

  /** Himoya uchun: faqat O'CHIRILMAGAN yozuvlar (oNAE3LW9 prod 2-tur). */
  private geoUsageTotal(usage: GeoUsage): number {
    return usage.orders + usage.users + usage.branches + usage.transfer_batches;
  }

  /** Xato javobidagi `usage` — faqat o'chirishni to'sgan (tirik) yozuvlar. */
  private liveGeoCounts(usage: GeoUsage): GeoCounts {
    return {
      orders: usage.orders,
      users: usage.users,
      branches: usage.branches,
      transfer_batches: usage.transfer_batches,
    };
  }

  /**
   * oNAE3LW9 (prod 2-tur) — birlashtirish tekshiruvi uchun JAMI (tirik +
   * o'chirilgan): ko'chirish (`reassign_district`) ikkalasini ham ko'chiradi.
   */
  private geoAllOf(usage: GeoUsage, kind: GeoMoveKind): number {
    return usage[kind] + usage.deleted[kind];
  }

  /**
   * oNAE3LW9 (prod 2-tur) — o'chirilgan hudud ostida qolgan O'CHIRILGAN
   * yozuvlar (activity log uchun); yo'q bo'lsa `null`.
   */
  private deletedGeoRefs(usage: GeoUsage): GeoCounts | null {
    const d = usage.deleted;
    return d.orders + d.users + d.branches + d.transfer_batches > 0
      ? { ...d }
      : null;
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
   * oNAE3LW9 (merge-message) — o'zbekcha sanash: ["buyurtma", "filial"] +
   * "larni" → "buyurtma va filiallarni"; qo'shimcha faqat oxirgi otga.
   */
  private joinGeoNouns(nouns: string[], suffix: string): string {
    if (!nouns.length) return '';
    const last = `${nouns[nouns.length - 1]}${suffix}`;
    const rest = nouns.slice(0, -1);
    return rest.length ? `${rest.join(', ')} va ${last}` : last;
  }

  /**
   * oNAE3LW9 (merge-message) — boshqa tumanga/viloyatga KO'CHIRSA BO'LADIGAN
   * bog'lanishlar: buyurtma (tahrirda `district_id`/`region_id`),
   * foydalanuvchi (UpdateUserDto `region_id`), filial (UpdateBranchDto).
   * Pochta va filiallararo jo'natma — tarixiy yozuv, ko'chirish amali yo'q.
   */
  private movableGeoNouns(usage: GeoUsage): string[] {
    return [
      usage.orders ? 'buyurtma' : '',
      usage.users ? 'foydalanuvchi' : '',
      usage.branches ? 'filial' : '',
    ].filter(Boolean);
  }

  /**
   * oNAE3LW9 — Soft delete EMAS: karta TC2 "buyurtmasi yo'q tuman DELETE →
   * 200 va DB dan yo'qoladi" — bog'lanishi bo'lmagan tuman qattiq o'chadi,
   * bog'langani esa umuman o'chirilmaydi (400). Bog'lanish — faqat
   * O'CHIRILMAGAN buyurtma/foydalanuvchi/filial (oNAE3LW9 prod 2-tur).
   */
  async deleteDistrict(id: string) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('Tuman topilmadi');
    }
    // oNAE3LW9: ilgari hech narsa tekshirilmasdan `remove` qilinardi.
    const usage = await this.collectGeoUsage({ district_id: String(id) });
    if (this.geoUsageTotal(usage) > 0) {
      /**
       * oNAE3LW9 (merge-message): matn foydalanuvchiga to'g'ridan-to'g'ri
       * ko'rsatiladi (frontend `showError`) — ilgari unda xom API yo'li
       * ("POST /district/187/merge") bor edi. Endi matn faqat o'zbekcha
       * tushuntirish; birlashtirish endpointi mashina uchun `data.hint` da.
       * Ikkinchi yo'l aniq nomlanadi ("buyurtma va foydalanuvchilarni") —
       * "ularni" deyilsa "tumanlarni" deb tushunilardi.
       */
      const movable = this.joinGeoNouns(this.movableGeoNouns(usage), 'larni');
      this.badRequest(
        `Bu tumanda ${this.describeGeoUsage(usage)} bor, shuning uchun uni o'chirib bo'lmaydi. Avval tumanlarni birlashtiring (bu tumanni boshqa tumanga qo'shing)` +
          (movable ? ` yoki ${movable} boshqa tumanga ko'chiring.` : '.'),
        {
          reason: 'district_in_use',
          usage: this.liveGeoCounts(usage),
          hint: {
            action: 'merge',
            method: 'POST',
            path: `/district/${id}/merge`,
          },
        },
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

    /**
     * oNAE3LW9 (prod 2-tur): faqat O'CHIRILGAN yozuvlari bor tuman o'chadi —
     * ular o'z `district_id` sini SAQLAB qoladi (endi mavjud bo'lmagan ID).
     * Ataylab: o'chirilgan yozuv hech qayerda ko'rinmaydi (404, hisobotlar
     * `is_deleted = false`), uni tiklash (restore) yo'li yo'q; tarixni
     * o'zgartirmaslik uchun ularga tegilmaydi. Qaysi tuman ekanini topish
     * uchun shu yozuv: `old_value` (nom/SATO) + `metadata.deleted_refs`.
     * Kelajakda tiklash qo'shilsa — tumanni qayta tekshirish SHART.
     * Yetim qoldirmaslik kerak bo'lsa — o'chirish o'rniga birlashtirish
     * (`mergeDistricts` o'chirilganlarni ham ko'chiradi).
     */
    const deletedRefs = this.deletedGeoRefs(usage);
    await this.activityLog.log({
      entity_type: 'District',
      entity_id: String(id),
      action: ActivityAction.DELETED,
      old_value: deletedSnapshot,
      metadata: {
        region_id: deletedSnapshot.region_id,
        ...(deletedRefs ? { deleted_refs: deletedRefs } : {}),
      },
    });

    return successRes({ id }, 200, 'District deleted');
  }

  /**
   * Is1zvHN7 — `GET /district/:id/usage`: tumanga bog'langan TIRIK
   * (o'chirilmagan) buyurtma/foydalanuvchi/filial soni. Sonlar `deleteDistrict`
   * himoyasi (400 `data.usage`) bilan AYNAN bir xil manbadan — frontend
   * o'chirish/birlashtirish oynasini oldindan ko'rsatadi. Bir servis javob
   * bermasa — 503 (0 deb ko'rsatilmaydi: "bo'sh" deb aldab qo'ymaslik uchun).
   */
  async getDistrictUsage(id: string) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('Tuman topilmadi');
    }
    const usage = await this.collectGeoUsage(
      { district_id: String(id) },
      'sanash',
    );
    return successRes({
      orders: usage.orders,
      users: usage.users,
      branches: usage.branches,
    });
  }

  async createRegion(dto: CreateRegionDto) {
    const name = dto.name.trim();
    const satoCode = dto.sato_code.trim();

    if (!name || !satoCode) {
      this.badRequest('name va sato_code majburiy');
    }

    const existingByName = await this.regionRepo.findOne({ where: { name } });
    if (existingByName) {
      this.conflict('Shu nomli viloyat allaqachon mavjud');
    }

    const existingBySato = await this.regionRepo.findOne({
      where: { sato_code: satoCode },
    });
    if (existingBySato) {
      this.conflict('Bunday SATO kodli viloyat allaqachon mavjud');
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
    return successRes(await this.withAssignedDistricts(rows));
  }

  /**
   * Tumanni boshqa viloyatga biriktirish (`PATCH /district/:id`) natijasi
   * viloyat ro'yxatida ko'rinishi uchun: `districts` — geografik (tumanning
   * O'Z viloyati, `region_id`; o'zgarmaydi), `assignedDistricts` — shu
   * viloyatga BIRIKTIRILGAN tumanlar (`assigned_region ?? region_id`;
   * PCS `GET /region` bilan bir xil maydon). Avval faqat `districts`
   * qaytardi — ko'chirilgan tuman eski viloyatda qolib ko'rinardi va
   * biriktirish «ishlamayapti» deb qabul qilinardi.
   */
  private async withAssignedDistricts<T extends Region>(
    regions: T[],
  ): Promise<Array<T & { assignedDistricts: District[] }>> {
    if (!regions.length) {
      return [];
    }
    const regionIds = regions.map((region) => String(region.id));
    const districts = await this.districtRepo.find({
      where: [
        { assigned_region: In(regionIds) },
        // Eski qatorlar: biriktirilmagan (NULL) tuman o'z viloyatiga xizmat qiladi.
        { assigned_region: IsNull(), region_id: In(regionIds) },
      ],
      relations: ['region'],
      order: { name: 'ASC' },
    });
    const byRegion = new Map<string, District[]>();
    for (const district of districts) {
      const key = String(district.assigned_region ?? district.region_id);
      const bucket = byRegion.get(key);
      if (bucket) bucket.push(district);
      else byRegion.set(key, [district]);
    }
    return regions.map((region) =>
      Object.assign(region, {
        assignedDistricts: byRegion.get(String(region.id)) ?? [],
      }),
    );
  }

  /**
   * uherIk8r — so'rovchining O'Z viloyati (hudud statistikasi doirasi uchun).
   * - COURIER → identity'dagi `users.region_id`;
   * - filial xodimi (MANAGER / REGISTRATOR va h.k.) → biriktirilgan filialning
   *   `branches.region_id` (branch_users → branches; JWT'dagi eski branch_id
   *   emas, joriy biriktiruv). `isHqStaff` — filial turi HQ.
   * Aniqlab bo'lmasa `regionId: null` (chaqiruvchi fail-closed qiladi).
   */
  private async resolveOwnStatsRegion(requester: RequesterContext): Promise<{
    regionId: string | null;
    isHqStaff: boolean;
    /** aLx7Di99: kuryer emas — filial xodimining filiali (yo'q — null). */
    branchId?: string | null;
    branchName?: string | null;
    isCourier?: boolean;
  }> {
    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Foydalanuvchi aniqlanmadi');
    }
    const roles = (requester.roles ?? []).map((role) =>
      String(role ?? '').toLowerCase(),
    );

    if (roles.includes(Roles.COURIER)) {
      const courier = await this.findCourierById(requesterId);
      const regionId = String(courier?.region_id ?? '').trim();
      return { regionId: regionId || null, isHqStaff: false, isCourier: true };
    }

    const assignment = (await this.findBranchAssignmentByUserId(requesterId, {
      id: requesterId,
      roles: requester.roles ?? [],
    })) as
      | (BranchAssignmentRow & {
          branch?: {
            type?: string | null;
            region_id?: string | null;
            name?: string | null;
          } | null;
        })
      | null;
    const branch = assignment?.branch ?? null;
    const regionId = String(branch?.region_id ?? '').trim();
    const branchId = String(assignment?.branch_id ?? '').trim();
    return {
      regionId: regionId || null,
      isHqStaff:
        String(branch?.type ?? '')
          .trim()
          .toUpperCase() === String(BranchType.HQ),
      branchId: branchId || null,
      branchName: branch?.name ? String(branch.name) : null,
      isCourier: false,
    };
  }

  /**
   * uherIk8r — hudud statistikasi SERVERDA cheklanadi (avval 14 viloyatning
   * hammasi qaytib, cheklov faqat brauzerda edi).
   * - requester yo'q (ichki RMQ chaqiruv / eski gateway) → hammasi;
   * - ADMIN / SUPERADMIN → hammasi;
   * - LOGIST (iOnGbEqi, ega LG-S3/LG-S1) → FAQAT o'ziga biriktirilgan
   *   viloyatlar (`regions.logist_id = me`, bir nechta bo'lishi mumkin) va
   *   PULSIZ (`hideMoney`: revenue / totalRevenue yo'q). Biriktirilmagan —
   *   hech biri. Ilgari logist 14 viloyatning hammasini tushumi bilan olardi;
   * - qolgan HAMMA ichki rol, jumladan HQ filial xodimi (menejer/registrator)
   *   → faqat o'z viloyati (HQ uchun — HQ filialining viloyati); aniqlab
   *   bo'lmasa — hech biri. Karta (uherIk8r, 3-band): "ADMIN/SUPERADMIN
   *   bo'lmasa faqat o'z viloyatini qaytaring". Ilgari HQ xodimi istisno edi.
   */
  private async resolveRegionStatsScope(
    requester?: RequesterContext,
  ): Promise<
    | { all: true; hideMoney: false }
    | { all: false; regionIds: string[]; hideMoney: boolean }
  > {
    if (!requester || this.isSystemPrivileged(requester)) {
      return { all: true, hideMoney: false };
    }
    const roles = (requester.roles ?? []).map((role) =>
      String(role ?? '').toLowerCase(),
    );
    if (roles.includes(Roles.LOGIST)) {
      const regions = await this.findLogistRegions(requester.id);
      return {
        all: false,
        regionIds: regions.map((region) => region.id),
        hideMoney: true,
      };
    }
    const own = await this.resolveOwnStatsRegion(requester);
    return {
      all: false,
      regionIds: own.regionId ? [own.regionId] : [],
      hideMoney: false,
    };
  }

  /**
   * o2j9uDtT — viloyatlar bo'yicha kuryerlar soni (`identity.courier.
   * region_counts`, BITTA so'rov). Xato/timeout yoki buzuq javob — null
   * (chaqiruvchi maydonni null qiladi; statistikaning qolgan qismi
   * yiqilmaydi). Viloyat yo'q — bo'sh Map, RPC yuborilmaydi.
   */
  private async countCouriersByRegions(
    regionIds: string[],
  ): Promise<Map<string, { total: number; active: number }> | null> {
    if (!regionIds.length) {
      return new Map();
    }
    try {
      const res = await lastValueFrom(
        this.identityClient
          .send<{
            data?: Array<{
              region_id?: string | number;
              total?: number;
              active?: number;
            }>;
          }>(
            { cmd: 'identity.courier.region_counts' },
            { region_ids: regionIds },
          )
          .pipe(timeout(5000)),
      );
      if (!Array.isArray(res?.data)) {
        return null;
      }
      const counts = new Map<string, { total: number; active: number }>();
      for (const row of res.data) {
        const regionId = String(row?.region_id ?? '').trim();
        if (!regionId) continue;
        counts.set(regionId, {
          total: Number(row?.total) || 0,
          active: Number(row?.active) || 0,
        });
      }
      return counts;
    } catch (error) {
      this.logger.warn(
        `region stats: identity.courier.region_counts failed — activeCouriers null: ${(error as Error)?.message ?? error}`,
      );
      return null;
    }
  }

  async getAllRegionsStats(
    startDate?: string,
    endDate?: string,
    requester?: RequesterContext,
  ) {
    const scope = await this.resolveRegionStatsScope(requester);
    const allRegions = await this.regionRepo.find({
      relations: ['districts'],
      order: { name: 'ASC' },
    });
    // uherIk8r: HQ'dan tashqari menejer/registrator faqat o'z viloyatini oladi.
    // iOnGbEqi: logist — faqat o'ziga biriktirilgan viloyatlar.
    const scopedRegionIds = scope.all ? null : new Set(scope.regionIds);
    const regions = scopedRegionIds
      ? allRegions.filter((region) => scopedRegionIds.has(String(region.id)))
      : allRegions;

    const regionIds = regions.map((region) => String(region.id));
    const regionIdSet = new Set(regionIds);

    // o2j9uDtT: kuryerlar soni buyurtmalar bilan PARALLEL, bitta RPC.
    const [orders, courierCounts] = await Promise.all([
      regionIds.length
        ? this.findOrders({
            fetch_all: true,
            start_day: startDate,
            end_day: endDate,
            limit: 100,
          })
        : Promise.resolve([] as OrderRow[]),
      this.countCouriersByRegions(regionIds),
    ]);

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
        // o2j9uDtT: xarita tooltipi "Kuryerlar: N" — stats/:id dagi
        // `activeCouriers` bilan AYNI qoida (faqat status = 'active').
        // identity javob bermasa — null (noma'lum), YOLG'ON 0 EMAS:
        // frontend null'da qatorni chizmaydi.
        activeCouriers: courierCounts
          ? (courierCounts.get(String(region.id))?.active ?? 0)
          : null,
        totalCouriers: courierCounts
          ? (courierCounts.get(String(region.id))?.total ?? 0)
          : null,
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

    // iOnGbEqi (ega LG-S1): logistga tushum (pul) qaytmaydi — `revenue` va
    // `summary.totalRevenue` kalitlari umuman yo'q.
    if (scope.hideMoney) {
      const { totalRevenue: _hiddenTotal, ...moneylessSummary } = summary;
      void _hiddenTotal;
      return successRes(
        {
          regions: rows.map(({ revenue: _hidden, ...row }) => {
            void _hidden;
            return row;
          }),
          summary: moneylessSummary,
        },
        200,
        'Region stats',
      );
    }

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
    requester?: RequesterContext,
    /**
     * aLx7Di99 — faqat ichki chaqiruv (`getMyRegionDistrictStats`): so'rovchi
     * GET /orders ro'yxatining AYNAN o'sha to'plami (oldindan olingan) —
     * qaytadan so'ralmaydi. RMQ'dan kelmaydi.
     */
    scopedOrders?: readonly OrderRow[],
  ) {
    const regionId = String(id ?? '').trim();
    if (!regionId) {
      this.badRequest('Viloyat ID majburiy');
    }

    // uherIk8r: bu javobda har bir kuryerning ismi/telefoni/daromadi bor —
    // HQ'dan tashqari filial xodimi faqat o'z viloyatini ko'radi.
    // iOnGbEqi: logist — faqat o'ziga biriktirilgan viloyat (boshqasi 403).
    const scope = await this.resolveRegionStatsScope(requester);
    if (
      !scope.all &&
      !scope.regionIds.includes(canonicalBigintId(regionId) ?? regionId)
    ) {
      this.forbidden("Bu viloyat statistikasini ko'rishga ruxsat yo'q");
    }

    const region = await this.regionRepo.findOne({
      where: { id: regionId },
      relations: ['districts'],
    });

    if (!region) {
      this.notFound('Viloyat topilmadi');
    }

    const orders =
      scopedOrders ??
      (await this.findOrders({
        fetch_all: true,
        start_day: startDate,
        end_day: endDate,
        limit: 100,
      }));

    const regionOrders = orders.filter(
      (order) => String(order.region_id ?? '').trim() === regionId,
    );

    const couriersRaw = await this.listCouriersByRegion(regionId);
    const couriers = couriersRaw.map((courier) => {
      const courierId = String(
        (courier?.id as string | number | undefined) ?? '',
      ).trim();
      const courierOrders = regionOrders.filter(
        (order) => String(order.courier_id ?? '').trim() === courierId,
      );
      const stats = summarizeRegionOrders(courierOrders);
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
      const stats = summarizeRegionOrders(districtOrders);
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

    const summary = summarizeRegionOrders(regionOrders);
    const activeCouriers = couriers.filter(
      (courier) =>
        String(
          (courier.status as string | number | undefined) ?? '',
        ).toLowerCase() === 'active',
    ).length;

    const topCourier = couriers
      .slice()
      .sort((a, b) => b.deliveredOrders - a.deliveredOrders)[0];

    // iOnGbEqi (ega LG-S1): logistga tushum yo'q — summary, kuryer va tuman
    // qatorlaridagi `totalRevenue` kalitlari olib tashlanadi.
    const withoutRevenue = <T extends { totalRevenue?: number }>(
      row: T,
    ): Omit<T, 'totalRevenue'> | T => {
      if (!scope.hideMoney) {
        return row;
      }
      const { totalRevenue: _hidden, ...rest } = row;
      void _hidden;
      return rest;
    };

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
        summary: withoutRevenue({
          totalOrders: summary.totalOrders,
          deliveredOrders: summary.deliveredOrders,
          cancelledOrders: summary.cancelledOrders,
          pendingOrders: summary.pendingOrders,
          totalRevenue: summary.totalRevenue,
          successRate: summary.successRate,
          totalCouriers: couriers.length,
          activeCouriers,
          totalDistricts: districts.length,
        }),
        couriers: couriers
          .sort((a, b) => b.deliveredOrders - a.deliveredOrders)
          .map(withoutRevenue),
        districts: districts
          .sort((a, b) => b.totalOrders - a.totalOrders)
          .map(withoutRevenue),
      },
      200,
      'Region detailed stats',
    );
  }

  /**
   * uherIk8r — GET /region/my/district-stats (kuryer / menejer): FAQAT
   * so'rovchining o'z viloyati, tumanlar kesimida (BeePost
   * `region/my/district-stats` analogi). Viloyat tokendan emas, serverda
   * aniqlanadi (kuryer — users.region_id, menejer — filial viloyati). Kuryer
   * ism/telefoni (PII) qaytmaydi. Viloyat biriktirilmagan bo'lsa — 200 va
   * bo'sh holat ("Sizga viloyat biriktirilmagan").
   *
   * aLx7Di99 — raqamlar so'rovchining /orders «Barchasi» ro'yxati bilan AYNI
   * to'plam ustida (`findOwnOrderListScope`):
   *  - `summary.*` — shu to'plamning HAMMASI (`summary.totalOrders` =
   *    ro'yxat `total`i, sana filtri ham o'sha);
   *  - `districts[]` — o'sha to'plamning viloyat tumanlariga tushgan qismi;
   *  - `summary.outsideDistrictsOrders` — tumanlarga tushmaganlari (tumani /
   *    viloyati yo'q yoki boshqa viloyat): Σ districts.totalOrders +
   *    outsideDistrictsOrders = summary.totalOrders.
   */
  async getMyRegionDistrictStats(
    startDate?: string,
    endDate?: string,
    requester?: RequesterContext,
  ) {
    if (!requester) {
      this.forbidden('Foydalanuvchi aniqlanmadi');
    }
    const empty = (message: string) =>
      successRes({ region: null, summary: null, districts: [] }, 200, message);

    const own = await this.resolveOwnStatsRegion(requester);
    const { regionId } = own;
    if (!regionId) {
      return empty('Sizga viloyat biriktirilmagan');
    }
    // aLx7Di99: raqamlar so'rovchining kesimida — kuryer: o'z buyurtmalari,
    // menejer: o'z filiali (avval butun viloyat raqamlari qaytardi).
    const courierId = String(requester?.id ?? '').trim();
    const scope = own.isCourier
      ? { type: 'courier' as const, courier_id: courierId }
      : {
          type: 'branch' as const,
          branch_id: own.branchId ?? '',
          branch_name: own.branchName ?? null,
        };
    if (scope.type === 'branch' && !scope.branch_id) {
      return empty('Sizga filial biriktirilmagan');
    }
    const exists = await this.regionRepo.findOne({ where: { id: regionId } });
    if (!exists) {
      return empty('Viloyat topilmadi');
    }

    const scopedOrders = await this.findOwnOrderListScope(
      scope.type === 'courier'
        ? { courier_id: scope.courier_id }
        : { branch_id: scope.branch_id },
      startDate,
      endDate,
    );

    // Ichki chaqiruv (requester'siz) — doira yuqorida aniqlangan.
    const detail = (await this.getRegionDetailedStats(
      regionId,
      startDate,
      endDate,
      undefined,
      scopedOrders,
    )) as {
      data: {
        region: { id: string; name: string; satoCode?: string | null };
        districts: Array<
          {
            couriers?: unknown[];
            totalOrders: number;
            deliveredOrders: number;
            cancelledOrders: number;
          } & Record<string, unknown>
        >;
      };
    };
    const { region, districts } = detail.data;
    const summary = summarizeRegionOrders(scopedOrders);
    const inDistricts = districts.reduce(
      (sum, district) => sum + Number(district.totalOrders ?? 0),
      0,
    );

    return successRes(
      {
        region: { id: region.id, name: region.name, satoCode: region.satoCode },
        // aLx7Di99: raqamlar kimning kesimida (sarlavha: filial / «sizga tegishli»).
        scope,
        summary: {
          totalOrders: summary.totalOrders,
          deliveredOrders: summary.deliveredOrders,
          cancelledOrders: summary.cancelledOrders,
          pendingOrders: summary.pendingOrders,
          totalRevenue: summary.totalRevenue,
          successRate: summary.successRate,
          districtsCount: districts.length,
          outsideDistrictsOrders: Math.max(
            0,
            summary.totalOrders - inDistricts,
          ),
        },
        districts: districts.map(({ couriers, ...district }) => ({
          ...district,
          pendingOrders: Math.max(
            0,
            district.totalOrders -
              district.deliveredOrders -
              district.cancelledOrders,
          ),
          couriersCount: Array.isArray(couriers) ? couriers.length : 0,
        })),
      },
      200,
      'Viloyat tumanlari statistikasi',
    );
  }

  /**
   * aLx7Di99 — so'rovchining /orders «Barchasi» ro'yxati to'plami (sahifasiz).
   * Doira qayta yozilmaydi — ro'yxat yuboradigan AYNI `order.find_all` so'rovi:
   *  - kuryer — GET /orders/courier/orders: kuryer pochtalari
   *    (`courierPostsWhere`, gateway `findAllCourierPostIds` bilan bir xil)
   *    + `courierPostOrdersQuery` (holatsiz «Barchasi»: created / new /
   *    received / on the road ko'rinmaydi, 6qypMFeT: skan bilan olingan
   *    posilkadan tashqari). Pochtasi yo'q — bo'sh (ro'yxat ham bo'sh);
   *  - filial xodimi — GET /orders (`resolveOrderListRequest`): faqat
   *    `branch_id` (order-service: branch_id / holder_branch_id /
   *    home_branch_id), holat filtrisiz.
   * Himoya qatlami: order-service filtrni qo'llamasa ham begona qator
   * sanalmaydi.
   */
  private async findOwnOrderListScope(
    scope: { courier_id: string } | { branch_id: string },
    startDate?: string,
    endDate?: string,
  ): Promise<OrderRow[]> {
    const dateRange = { start_day: startDate, end_day: endDate };
    const same = (value: string | null | undefined, expected: string) =>
      Boolean(expected) && String(value ?? '').trim() === expected;

    if ('courier_id' in scope) {
      const courierId = String(scope.courier_id ?? '').trim();
      const postIds = courierId ? await this.findCourierPostIds(courierId) : [];
      if (!postIds.length) {
        return [];
      }
      const query = courierPostOrdersQuery(postIds, undefined, courierId);
      const postIdSet = new Set(postIds);
      const hidden = new Set<string>(COURIER_LIST_HIDDEN_STATUSES);
      const rows = await this.findOrders({
        ...query,
        ...dateRange,
        fetch_all: true,
        limit: 100,
      });
      return rows.filter(
        (order) =>
          postIdSet.has(String(order.post_id ?? '').trim()) &&
          (!hidden.has(String(order.status ?? '')) ||
            isCourierScanTakenOrder(order, courierId)),
      );
    }

    const branchId = String(scope.branch_id ?? '').trim();
    if (!branchId) {
      return [];
    }
    const rows = await this.findOrders({
      branch_id: branchId,
      ...dateRange,
      fetch_all: true,
      limit: 100,
    });
    return rows.filter(
      (order) =>
        same(order.branch_id, branchId) ||
        same(order.holder_branch_id, branchId) ||
        same(order.home_branch_id, branchId),
    );
  }

  async findRegionById(id: string) {
    const region = await this.regionRepo.findOne({
      where: { id },
      relations: ['districts'],
    });
    if (!region) {
      this.notFound('Viloyat topilmadi');
    }
    const [withAssigned] = await this.withAssignedDistricts([region]);
    return successRes(withAssigned);
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
          // HQ → filial o'tkazmasi faqat kuryersiz ('0') SENT pochtaga
          // qo'shiladi: filial kuryerining faol pochtasi (branch_id bilan)
          // hech qachon dispatch maqsadi bo'lmasin. Har kun — alohida pochta
          // (egasi qarori 2026-11-03, BeePost kabi): kechagi qisman qabul
          // qilingan o'tkazmaga bugungi jo'natma qo'shilmaydi.
          ...(targetPostStatus === Post_status.SENT
            ? {
                courier_id: '0',
                createdAt: MoreThanOrEqual(startOfTashkentDay(new Date())),
              }
            : {}),
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

  /**
   * 4BftLLnc — LOGIST doirasining YAGONA manbasi: `regions.logist_id = me`
   * (IDX_REGION_LOGIST). Yaroqsiz/yo'q id — bo'sh ro'yxat (hech narsa
   * ko'rinmaydi). Gateway (`auth/logist-scope.ts` — buyurtmalar, paketlar,
   * kuryerlar, qidiruv), hudud statistikasi va pochta ro'yxati shundan oladi.
   */
  async findLogistRegions(
    logistIdInput: unknown,
  ): Promise<Array<{ id: string; name: string }>> {
    const logistId = canonicalBigintId(logistIdInput);
    if (!logistId) {
      return [];
    }
    const regions = await this.regionRepo.find({
      where: { logist_id: logistId },
      order: { name: 'ASC' },
    });
    return (
      regions
        // Himoya: repo filtri ishlamasa ham begona viloyat qaytmaydi.
        .filter((region) => canonicalBigintId(region.logist_id) === logistId)
        .map((region) => ({ id: String(region.id), name: region.name }))
    );
  }

  /** 4BftLLnc — `logistics.region.find_by_logist` (gateway logist doirasi). */
  async findRegionsByLogist(logistIdInput: unknown) {
    const regions = await this.findLogistRegions(logistIdInput);
    return successRes(
      {
        logist_id: canonicalBigintId(logistIdInput),
        region_ids: regions.map((region) => region.id),
        regions,
      },
      200,
      regions.length
        ? 'Logist viloyatlari'
        : 'Sizga hali viloyat biriktirilmagan',
    );
  }

  async updateRegion(id: string, dto: UpdateRegionDto) {
    const region = await this.regionRepo.findOne({ where: { id } });
    if (!region) {
      this.notFound('Viloyat topilmadi');
    }

    const before = { name: region.name, sato_code: region.sato_code };

    if (typeof dto.name !== 'undefined') {
      const nextName = dto.name.trim();
      if (!nextName) {
        this.badRequest("Nomi bo'sh bo'lmasligi kerak");
      }
      const existing = await this.regionRepo.findOne({
        where: { name: nextName },
      });
      if (existing && existing.id !== id) {
        this.conflict('Shu nomli viloyat allaqachon mavjud');
      }
      region.name = nextName;
    }

    if (typeof dto.sato_code !== 'undefined') {
      const nextSato = dto.sato_code.trim();
      if (!nextSato) {
        this.badRequest("sato_code bo'sh bo'lmasligi kerak");
      }
      const existing = await this.regionRepo.findOne({
        where: { sato_code: nextSato },
      });
      if (existing && existing.id !== id) {
        this.conflict('Bunday SATO kodli viloyat allaqachon mavjud');
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
      res as {
        data?: {
          ids?: unknown;
          previous_regions?: unknown;
          moved_live?: unknown;
        };
      } | null
    )?.data;
    if (!data || !Array.isArray(data.ids)) {
      throw new Error(`${cmd}: javobda ko'chgan ID'lar (ids) yo'q`);
    }
    const toIds = (list: unknown): string[] =>
      Array.isArray(list) ? list.map((value) => String(value)) : [];
    const groups: unknown[] = Array.isArray(data.previous_regions)
      ? (data.previous_regions as unknown[])
      : [];
    const live = Number(data.moved_live);
    return {
      ids: toIds(data.ids),
      // (vsmpTweI) servis sanagan tiriklar; eski servis — `null`.
      live:
        data.moved_live !== undefined &&
        data.moved_live !== null &&
        Number.isInteger(live) &&
        live >= 0
          ? live
          : null,
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
      // oNAE3LW9 (prod 2-tur): JAMI (tirik + o'chirilgan) — ko'chirish
      // o'chirilganlarni ham olib ketadi.
      const was = this.geoAllOf(beforeA, step.kind);
      const now = this.geoAllOf(nowA, step.kind);
      if (now >= was) return null;
      return {
        kind: step.kind,
        district_id: toId,
        ids: null,
        reason: `${step.cmd} javobi kelmadi, lekin A dagi ${step.plural} ${was} → ${now} ga kamaydi — B tumanga (#${toId}) ko'chgan bo'lishi mumkin`,
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
    failure: GeoMergeFailure;
    uncertain?: GeoMoveStep;
    /** Shu birlashtirish oldindan yozgan qamrov imtiyozlari (B tumanli). */
    coverageCreated?: CreatedCoverageExemption[] | null;
  }): Promise<never> {
    const { fromId, toId, done, status, reason, failure } = ctx;
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
    await this.dropAbortedMergeCoverageExemptions({
      fromId,
      toId,
      created: ctx.coverageCreated,
      stranded,
    });
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
    /**
     * (tf324cXN) Mashina o'qiydigan sabab. Mavjud kalitlar (`from_district_id`,
     * `to_district_id`, `rolled_back`, `stranded`) o'zgarmaydi (orqaga
     * moslik); qo'shimcha `reason` + `details` — gateway `publicErrorData`
     * faqat shularni FE'ga o'tkazadi (tekis qiymatlar, `mismatches` /
     * `stranded` — tekis obyektlar ro'yxati; `stranded[].ids` o'tmaydi).
     *
     * (Z1c1sNPT) «A ga qaytarildi: buyurtmalar N · foydalanuvchilar N ·
     * filiallar N» — `rolled_back` ichma-ich obyekt, `publicErrorData` uni
     * tashlab yuboradi; shuning uchun `details` da TEKIS sonlar
     * `rolled_back_orders/users/branches` (uchala tur doim; boshlanmagan
     * qadam — 0). Qaytmagan buyurtmalarning birinchi ≤10 ta ID'si —
     * `stranded_order_ids` (to'liq ro'yxat — activity log).
     */
    const machine = (extra: { stranded?: GeoStranded[] } = {}) => {
      const orderIds = (extra.stranded ?? [])
        .filter((s) => s.kind === 'orders')
        .flatMap((s) => s.ids ?? [])
        .slice(0, GEO_STRANDED_DETAILS_IDS);
      return {
        reason: failure.reason,
        details: {
          reason: failure.reason,
          kind: failure.kind,
          ...(failure.timeout_ms !== undefined
            ? { timeout_ms: failure.timeout_ms }
            : {}),
          ...(failure.mismatches ? { mismatches: failure.mismatches } : {}),
          from_district_id: fromId,
          to_district_id: toId,
          rolled_back_orders: rolledBack.orders ?? 0,
          rolled_back_users: rolledBack.users ?? 0,
          rolled_back_branches: rolledBack.branches ?? 0,
          manual_fix: Boolean(extra.stranded?.length),
          ...(extra.stranded?.length
            ? {
                stranded: extra.stranded.map((s) => ({
                  kind: s.kind,
                  district_id: s.district_id,
                  count: s.ids === null ? null : s.ids.length,
                })),
              }
            : {}),
          ...(orderIds.length ? { stranded_order_ids: orderIds } : {}),
        },
      };
    };

    if (!stranded.length) {
      this.logger.warn(
        `mergeDistricts ${fromId} → ${toId} bekor qilindi (${reason}); kompensatsiya OK: ${JSON.stringify(rolledBack)}`,
      );
      throw new RpcException(
        errorRes(
          `Birlashtirish bekor qilindi: ${reason}. Ko'chirilganlar A tumanga (#${fromId}) qaytarildi, tuman o'chirilmadi — qayta urinib ko'ring.`,
          status,
          { ...details, ...machine() },
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
      // (ILq3WNL1) jurnalda «Tuman birlashtirish chala qoldi».
      description: `Tuman birlashtirish chala qoldi: #${fromId} → #${toId}`,
      new_value: { target_district_id: toId },
      metadata: {
        reason,
        // (tf324cXN) mashina kodi — jurnal metadata'sida ham.
        reason_code: failure.reason,
        rolled_back: rolledBack,
        stranded,
      },
    });
    throw new RpcException(
      errorRes(
        `Birlashtirish bekor qilindi: ${reason}. DIQQAT — kompensatsiya to'liq bo'lmadi, QO'LDA TUZATING: ${where}. A tuman (#${fromId}) o'chirilmadi; to'liq ro'yxat — activity log (District #${fromId}, district.merge_compensation_failed).`,
        status,
        { ...details, stranded, ...machine({ stranded }) },
      ),
    );
  }

  /**
   * oNAE3LW9 — A bo'sh va B = eski B + ko'chirilgan (BeePost :434-446, :495-497).
   *
   * oNAE3LW9 (prod 2-tur): JAMI (tirik + o'chirilgan) bo'yicha — ko'chirish
   * o'chirilganlarni ham ko'chiradi (`moved` ularni ham o'z ichiga oladi),
   * A da o'chirilgan yozuv ham qolmasligi kerak: aks holda A o'chgach u
   * mavjud bo'lmagan `district_id` ga ishora qilib qolardi.
   */
  private districtMergeMismatches(
    beforeB: GeoUsage,
    afterA: GeoUsage,
    afterB: GeoUsage,
    moved: Record<GeoMoveKind, number>,
  ): { mismatches: GeoMergeMismatch[]; problems: string[] } {
    // (tf324cXN) Struktura (`mismatches`) — FE uchun; matn shundan yasaladi.
    const mismatches: GeoMergeMismatch[] = [];
    const problems: string[] = [];
    for (const step of this.geoMoveSteps()) {
      const kind = step.kind;
      const leftInA = this.geoAllOf(afterA, kind);
      if (leftInA > 0) {
        const m: GeoMergeMismatch = {
          kind,
          district: 'source',
          expected: 0,
          actual: leftInA,
        };
        mismatches.push(m);
        const deletedLeft = afterA.deleted[kind];
        problems.push(
          `A tumanda hali ${m.actual} ta ${step.label} qoldi` +
            (deletedLeft ? ` (shundan ${deletedLeft} tasi o'chirilgan)` : ''),
        );
      }
      const before = this.geoAllOf(beforeB, kind);
      const after = this.geoAllOf(afterB, kind);
      const expected = before + moved[kind];
      if (after !== expected) {
        const m: GeoMergeMismatch = {
          kind,
          district: 'target',
          expected,
          actual: after,
        };
        mismatches.push(m);
        problems.push(
          `B tumandagi ${step.plural} soni ${m.actual}, kutilgan ${before} + ${moved[kind]} = ${m.expected}`,
        );
      }
    }
    return { mismatches, problems };
  }

  /**
   * oNAE3LW9 TC5 — tumanlarni BIRLASHTIRISH: A (`id`) dagi buyurtma,
   * foydalanuvchi va filiallar B (`target_district_id`) ga (va B ning
   * viloyatiga) ko'chadi, so'ng A o'chadi. O'chirilgan (`is_deleted` /
   * `deleted_at`) yozuvlar HAM ko'chadi va tekshiruv jami (tirik +
   * o'chirilgan) bo'yicha — A o'chgach hech narsa unga ishora qilib
   * qolmaydi (oNAE3LW9 prod 2-tur).
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
    if (!from) this.notFound('Tuman topilmadi');
    if (!to) this.notFound('Birlashtiriladigan (maqsad) tuman topilmadi');

    // 1. OLDIN: A va B sanog'i (B ning eski soni — 3-bosqichda tasdiqlanadi).
    const [beforeA, beforeB] = await Promise.all([
      this.collectGeoUsage({ district_id: fromId }, 'birlashtirish'),
      this.collectGeoUsage({ district_id: toId }, 'birlashtirish'),
    ]);
    // Tuman qamrovi imtiyozlari (ega qarori): A buyurtmalari B ga o'tadi —
    // hozir A ga xizmat qilib, B ga xizmat qilmaydigan filial (yoki uning
    // kuryeri) qo'lidagilari o'sha filialda tugaydi. BIRINCHI ko'chirishdan
    // OLDIN; xato — 503, hech narsa ko'chmaydi (fail closed). Imtiyozda B
    // saqlanadi (buyurtmaning ko'chishdan keyingi tumani); birlashtirish
    // bekor bo'lsa A ga qaytgan buyurtmalarning shu qatorlari o'chiriladi
    // (`dropAbortedMergeCoverageExemptions`). Nusxalar —
    // `manager.remove(from)` entity id'sini o'chiradi.
    const coverageFrom: CoverageDistrict = { ...from };
    const coverageTo: CoverageDistrict = { ...to };
    const coverageCreated = await this.snapshotCoverageExemptions({
      moves: [
        {
          district_id: fromId,
          before: coverageFrom,
          after: coverageTo,
          target_district_id: toId,
        },
      ],
      source: 'district_merge',
    });

    const done: Array<{ step: GeoMoveStep; moved: GeoMoved }> = [];
    const abort = (
      status: 409 | 503,
      reason: string,
      failure: GeoMergeFailure,
      uncertain?: GeoMoveStep,
    ): Promise<never> =>
      this.abortDistrictMerge({
        fromId,
        toId,
        done,
        beforeA,
        status,
        reason,
        failure,
        uncertain,
        coverageCreated,
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
        // (tf324cXN) timeout — rxjs `TimeoutError`; qolgani (statusli xato
        // yoki ulanish xatosi) — `remote_refused`.
        const timedOut =
          error instanceof Error && error.name === 'TimeoutError';
        return abort(
          remote !== undefined && remote < 500 ? 409 : 503,
          `${step.plural} ko'chirilmadi (${this.geoErrorText(error)})`,
          timedOut
            ? {
                reason: 'timeout',
                kind: step.kind,
                timeout_ms: GEO_MOVE_TIMEOUT_MS,
              }
            : { reason: 'remote_refused', kind: step.kind },
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
          { reason: 'invalid_response', kind: step.kind },
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
    /**
     * (vsmpTweI) «Ko'chirildi» — faqat TIRIK yozuvlar: ko'chirish qadamining
     * o'zi sanagan (`moved_live`, ko'chgan ID'lardan o'chirilmaganlari), B
     * ning oldin/keyin farqidan EMAS (parallel o'zgarish buzmasin). `moved`
     * — avvalgidek jami (o'chirilganlar bilan), tekshiruv shunga tayanadi.
     * Eski servis `moved_live` qaytarmasa — ko'chgan va A dagi oldingi tirik
     * sonning kichigi.
     */
    const movedLive: Record<GeoMoveKind, number> = {
      orders: 0,
      users: 0,
      branches: 0,
    };
    const liveBeforeA = this.liveGeoCounts(beforeA);
    for (const { step, moved } of done) {
      movedCounts[step.kind] = moved.ids.length;
      movedLive[step.kind] =
        moved.live ?? Math.min(moved.ids.length, liveBeforeA[step.kind]);
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
        const { mismatches, problems } = this.districtMergeMismatches(
          beforeB,
          afterA,
          afterB,
          movedCounts,
        );
        if (problems.length) {
          throw new GeoMergeCheckError(problems.join('; '), mismatches);
        }
        return { from: afterA, to: afterB };
      });
    } catch (error) {
      if (error instanceof GeoMergeCheckError) {
        return abort(409, `tekshiruv mos kelmadi — ${error.message}`, {
          reason: 'count_mismatch',
          kind: error.mismatches[0]?.kind ?? null,
          mismatches: error.mismatches,
        });
      }
      return abort(
        503,
        `tumanni o'chirib/qayta sanab bo'lmadi (${this.geoErrorText(error)})`,
        { reason: 'delete_failed', kind: null },
      );
    }

    void this.removeDistrictFromSearch(searchRef);

    // Birlashtirilgach qayta snapshot (best-effort): A dan ko'chgan
    // buyurtmalar endi B da — B o'qiladi, lekin faqat ko'chganlari (B ning
    // o'z buyurtmalari A qamroviga tegishli emas). Oldingi o'qish va
    // ko'chirish orasida eski filial custody'siga kirganlar ham imtiyozli.
    // Undan oldin ko'chganlarning oldingi ko'chishlardagi A tumanli
    // imtiyozlari B ga o'tkaziladi (best-effort).
    const movedOrderIds = new Set(
      done
        .filter(({ step }) => step.kind === 'orders')
        .flatMap(({ moved }) => moved.ids)
        .map((orderId) => canonicalBigintId(orderId))
        .filter((orderId): orderId is string => !!orderId),
    );
    await this.retargetMergedCoverageExemptions(fromId, toId, movedOrderIds);
    const coverageAll = combineCoverageCreated(
      coverageCreated,
      coverageCreated && movedOrderIds.size
        ? await this.resnapshotCoverageExemptions({
            moves: [
              {
                district_id: toId,
                before: coverageFrom,
                after: coverageTo,
                target_district_id: toId,
                order_ids: movedOrderIds,
              },
            ],
            source: 'district_merge',
            context: `mergeDistricts #${fromId} → #${toId}`,
          })
        : null,
    );
    const coverageSummary = coverageAll
      ? summarizeCoverageExemptions(coverageAll)
      : null;

    // (ILq3WNL1) alohida amal `district.merge` («Tuman birlashtirildi») —
    // jurnalda topiladi/filtrlanadi. Eski `deleted` + `merged_into`
    // yozuvlari migratsiyasiz qoladi.
    await this.activityLog.log({
      entity_type: 'District',
      entity_id: fromId,
      action: 'district.merge',
      description: `Tuman birlashtirildi: ${from.name} (#${fromId}) → ${to.name} (#${toId})`,
      old_value: snapshot,
      new_value: {
        merged_into: toId,
        ...(coverageSummary ? { coverage_exemptions: coverageSummary } : {}),
      },
      metadata: {
        moved: movedCounts,
        moved_live: movedLive,
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
        // (vsmpTweI) natija oynasidagi «Ko'chirildi» — shu (o'chirilganlarsiz).
        moved_live: movedLive,
        target_before: beforeB,
        target_after: after.to,
        ...(coverageSummary ? { coverage_exemptions: coverageSummary } : {}),
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
      this.notFound('Viloyat topilmadi');
    }
    /**
     * oNAE3LW9: `District.region_id` `onDelete: CASCADE` — viloyat o'chsa
     * uning BARCHA tumanlari jimgina o'chardi. Endi tumani bor viloyat
     * o'chirilmaydi; viloyatga to'g'ridan-to'g'ri bog'langan BARCHA yozuvlar
     * ham tekshiriladi: buyurtma va filiallararo jo'natma
     * (`order_schema.branch_transfer_batches.target_region_id`),
     * foydalanuvchi, filial va pochta. Buyurtma/jo'natma/foydalanuvchi/
     * filial — faqat o'chirilmaganlari (oNAE3LW9 prod 2-tur).
     * Boshqa viloyatlardan shu viloyatga BIRIKTIRILGAN (xizmat ko'rsatuvchi)
     * tumanlar ham tekshiriladi: `District.assigned_region` `onDelete: SET
     * NULL` — viloyat o'chsa ular jimgina o'z geografik viloyatiga qaytardi
     * (HQ intake/jo'natish yo'nalishi o'zgarardi).
     */
    const districtCount = await this.districtRepo.count({
      where: { region_id: String(id) },
    });
    if (districtCount > 0) {
      /**
       * oNAE3LW9 (merge-message): sanoq `district.region_id` bo'yicha. Uni
       * o'zgartiradigan API YO'Q — PATCH district faqat `assigned_region`
       * (HQ intake yo'nalishi, LC-08) ni o'zgartiradi, sanoq kamaymaydi.
       * Bajarsa bo'ladigan yo'llar: bo'sh tumanni o'chirish yoki tumanni
       * boshqa viloyatdagi tumanga birlashtirish (`mergeDistricts` boshqa
       * viloyatga ruxsat beradi, A tuman o'chadi). "Ko'chiring" deyilmaydi.
       */
      this.badRequest(
        `Bu viloyatda ${districtCount} ta tuman bor, shuning uchun uni o'chirib bo'lmaydi. Avval tumanlarni o'chiring yoki boshqa viloyatdagi tumanga birlashtiring.`,
        { reason: 'region_has_districts', districts: districtCount },
      );
    }
    const assignedCount = await this.districtRepo.count({
      where: { assigned_region: String(id), region_id: Not(String(id)) },
    });
    if (assignedCount > 0) {
      this.badRequest(
        `Bu viloyatga boshqa viloyatlardan ${assignedCount} ta tuman biriktirilgan, shuning uchun uni o'chirib bo'lmaydi. Avval bu tumanlarni boshqa viloyatga biriktiring.`,
        {
          reason: 'region_has_assigned_districts',
          usage: { assigned_districts: assignedCount },
        },
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
      /**
       * oNAE3LW9 (merge-message): maslahat faqat ko'chirsa bo'ladigan
       * turlarga (buyurtma/foydalanuvchi/filial). Pochta va filiallararo
       * jo'natmani boshqa viloyatga ko'chirish amali yo'q — ular bo'lsa,
       * bajarib bo'lmaydigan "ko'chiring" taklif qilinmaydi.
       */
      const historical = this.joinGeoNouns(
        [
          posts ? 'pochta' : '',
          usage.transfer_batches ? "filiallararo jo'natma" : '',
        ].filter(Boolean),
        'lar',
      );
      const movable = this.joinGeoNouns(this.movableGeoNouns(usage), 'larni');
      const advice = historical
        ? `${historical.charAt(0).toUpperCase()}${historical.slice(1)} tarixiy yozuv bo'lgani uchun ularni boshqa viloyatga ko'chirib bo'lmaydi.`
        : `Avval ${movable} boshqa viloyatga ko'chiring.`;
      this.badRequest(
        `Bu viloyatga ${details} bog'langan, shuning uchun uni o'chirib bo'lmaydi. ${advice}`,
        {
          reason: 'region_in_use',
          usage: { ...this.liveGeoCounts(usage), posts },
        },
      );
    }

    const deletedSnapshot = { name: region.name, sato_code: region.sato_code };
    // `remove` dan keyin `id` undefined bo'ladi — qidiruv uchun nusxa oldin.
    const searchRef = { ...region };

    await this.regionRepo.remove(region);
    void this.removeRegionFromSearch(searchRef);

    // oNAE3LW9 (prod 2-tur): faqat O'CHIRILGAN yozuvlari bor viloyat o'chadi;
    // ular `region_id` sini saqlab qoladi (sabab — `deleteDistrict` dagi izoh).
    const deletedRefs = this.deletedGeoRefs(usage);
    await this.activityLog.log({
      entity_type: 'Region',
      entity_id: String(id),
      action: ActivityAction.DELETED,
      old_value: deletedSnapshot,
      ...(deletedRefs ? { metadata: { deleted_refs: deletedRefs } } : {}),
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
      this.notFound('Viloyat topilmadi');
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
