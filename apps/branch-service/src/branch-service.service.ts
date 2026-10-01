import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ActivityAction,
  ActivityLogService,
  ActivityLogQuery,
  BranchTransferDirection,
  BranchType,
  BranchUserRole,
  Cashbox_type,
  Order_status,
  Post_status,
  Roles,
  Status,
} from '@app/common';
import { Branch } from './entities/branch.entity';
import { BranchUser } from './entities/branch-user.entity';
import { BranchConfig } from './entities/branch-config.entity';
import { errorRes, successRes } from '../../../libs/common/helpers/response';
import { lastValueFrom, timeout, TimeoutError } from 'rxjs';

type RequesterContext = {
  id?: string;
  roles?: string[];
  // Optional: JWT carries this for non-system roles. Available for callers
  // that want to skip a BranchUser lookup; resolveAccessScope below still
  // queries the DB to derive role-based scope (manager descendant tree).
  branch_id?: string | null;
};

type BranchAccessScope = {
  readableBranchIds: Set<string>;
  writableBranchIds: Set<string>;
  managerReadableBranchIds: Set<string>;
};

/**
 * Filial paneli raqamlari — order-service'da SQL bilan hisoblanadi
 * (Scale 1-bosqich). Ilgari bu yerga buyurtma QATORLARI kelardi
 * Ilgari bu yerga buyurtma QATORLARI kelardi, endi tayyor yig'indilar.
 */
type BranchDashboardStats = {
  today_orders_count: number;
  week_orders_count: number;
  selected_orders_count: number;
  active_batches_count: number;
  orders_card: {
    total: number;
    new: number;
    on_the_road: number;
    delivered: number;
    returned: number;
    /**
     * Tanlangan oraliqda BEKOR QILINGAN buyurtmalar (bekor qilingan kun
     * bo'yicha). Ixtiyoriy: eski order-service uni yubormaydi — FE u holda
     * `returned` ga qaytadi.
     */
    cancelled?: number;
  };
  markets: Array<{
    market_id: string;
    /** Market nomi (identity); topilmasa/eski order-service — null/yo'q. */
    market_name?: string | null;
    orders_count: number;
    delivered_count: number;
    total_price: number;
  }>;
  packages: { on_the_way: number; waiting_for_acceptance: number };
  active_couriers: number;
};

type BranchDashboardFilter = {
  startDate?: string;
  endDate?: string;
  period?: string;
  all?: boolean;
};

/**
 * HQ (bosh ofis) da MENEJER bo'lmaydi. HQ'ning ishlarini (qabul, pochta
 * jo'natish, HQ kuryerlaridan pul olish) superadmin, admin va HQ
 * registratorlari bajaradi.
 *
 * ⚠️ Matn identity-service `createManager` dagi bilan BIR XIL — POST /managers
 * va POST /branches/:id/users mijozga aynan bitta xabarni qaytaradi.
 */
const HQ_MANAGER_FORBIDDEN_MESSAGE =
  "HQ (bosh ofis) ga menejer biriktirib bo'lmaydi. HQ ishlarini superadmin, admin va registratorlar bajaradi.";

/**
 * C12 — boshqa servis javob bermadi (timeout, ulanish uzildi, statusCode'siz
 * javob). Mijozga o'zbekcha chiqadi (ilgari inglizcha "X service unavailable").
 */
const ORDER_SERVICE_UNAVAILABLE_MESSAGE =
  "Buyurtmalar xizmati javob bermadi — birozdan so'ng qayta urinib ko'ring";
const LOGISTICS_SERVICE_UNAVAILABLE_MESSAGE =
  "Logistika xizmati javob bermadi — birozdan so'ng qayta urinib ko'ring";
const FILE_SERVICE_UNAVAILABLE_MESSAGE =
  "Fayl xizmati javob bermadi — birozdan so'ng qayta urinib ko'ring";
const FINANCE_SERVICE_UNAVAILABLE_MESSAGE =
  "Moliya xizmati javob bermadi — birozdan so'ng qayta urinib ko'ring";
const IDENTITY_SERVICE_UNAVAILABLE_MESSAGE =
  "Foydalanuvchilar xizmati javob bermadi — birozdan so'ng qayta urinib ko'ring";
const ORDER_IDS_REQUIRED_MESSAGE =
  'order_ids majburiy — kamida bitta buyurtma tanlang';
/** FE (backendBranchErrors) "aylanma" so'zi bo'yicha ota filial maydoniga bog'laydi. */
const PARENT_CYCLE_MESSAGE =
  "Ota filiallar zanjiri aylanma bo'lib qoladi — bunday bog'lanishga ruxsat yo'q";

/**
 * Pochta bilan filialga jo'natiladigan buyurtma holatlari — faqat HQ QABUL
 * QILGANI (RECEIVED). CANCELLED/CLOSED bu ro'yxatda YO'Q: dispatchPostToBranch
 * ularni avvalgidek jimgina chetlab o'tadi (ko'chirmaydi, so'rovni rad etmaydi).
 *
 * CODE-11: NEW olib tashlandi. NEW→ON_THE_ROAD noqonuniy o'tish — NEW
 * buyurtmali jo'natma manzil hisoblagichlari oshgandan KEYIN yarmida yiqilardi,
 * HQ'ning qo'lda qabul qilishini (NEW→RECEIVED) ham chetlab o'tardi. Endi bunday
 * so'rov boshidanoq 400, id'lar xabarda, hech narsa ko'chirilmaydi.
 */
const DISPATCHABLE_ORDER_STATUSES: ReadonlySet<string> = new Set<string>([
  Order_status.RECEIVED,
]);

/** Xabarda ko'rsatiladigan buyurtma id'lari soni (qolgani "+N ta"). */
const DISPATCH_MESSAGE_ORDER_ID_LIMIT = 20;

/**
 * LC-02 — jo'natishdan keyin manba pochtani o'chirishdan OLDIN unga hali
 * buyurtma ishora qiladimi, qayta so'raladi (`order.find_all`, post_id).
 */
const DISPATCH_POST_RECHECK_TIMEOUT_MS = 5000;

/**
 * CODE-07 — jo'natish manzil filialining FAOL menejerini identity'dan
 * tekshirib bo'lmadi (fail-closed: pochta jo'natilmaydi).
 */
const DISPATCH_MANAGER_CHECK_UNAVAILABLE_MESSAGE =
  "Manzil filial menejerini tekshirib bo'lmadi (foydalanuvchilar xizmati javob bermadi) — pochta jo'natilmadi. Birozdan so'ng qayta urinib ko'ring.";

/**
 * C9 (CODE-23) — filial paneli raqamlari uchun order-service chaqiruvi.
 * analytics-service `branch.dashboard` ni 5 s kutadi (rmqSend), shuning uchun
 * bu muddat undan QISQA bo'lishi shart: aks holda sekin order-service'da
 * analytics avval uzilib, `stats_unavailable` belgisi FE'ga hech qachon
 * yetib bormaydi (va analytics qayta urinib yukni oshiradi).
 */
const BRANCH_DASHBOARD_STATS_TIMEOUT_MS = 4000;

/**
 * R3 — kuryer filialdan filialga FAQAT qo'lida pul ham, buyurtma ham
 * qolmaganda o'tkaziladi (o'tkazish, filialdan chiqarish, yetim kuryerni boshqa
 * filialga biriktirish). Gateway xato tanasida faqat `message` qoladi
 * (`data` tashlab yuboriladi), shuning uchun sabablar XABAR ICHIDA —
 * prefiks + sabablar ' ' bilan. FE ularni aynan shu ko'rinishda ko'rsatadi.
 */
const COURIER_TRANSFER_BLOCKED_PREFIX =
  "Kuryerni boshqa filialga o'tkazib bo'lmaydi: ";
const COURIER_UNASSIGN_BLOCKED_PREFIX =
  "Kuryerni filialdan chiqarib bo'lmaydi: ";
const COURIER_REHOME_BLOCKED_PREFIX =
  "Kuryerni boshqa filialga biriktirib bo'lmaydi: ";
const COURIER_TRANSFER_REVERTED_PREFIX =
  "Kuryer o'tkazilmadi — o'tkazish paytida kuryerda yangi buyurtma yoki pul paydo bo'ldi, o'zgarish bekor qilindi: ";
/** Tekshiruv manbalaridan biri javob bermadi — hech narsa ko'chirilmaydi (503). */
const COURIER_CHECK_UNAVAILABLE_MESSAGE =
  "Kuryer kassasi va qo'lidagi buyurtmalarni tekshirib bo'lmadi (xizmat javob bermadi). Birozdan so'ng qayta urinib ko'ring.";
const COURIER_CHECK_FORBIDDEN_MESSAGE =
  "Kuryer o'tkazish tekshiruvini faqat superadmin yoki admin ko'ra oladi";
const COURIER_TRANSFER_FORBIDDEN_MESSAGE =
  "Kuryerni boshqa filialga faqat superadmin yoki admin o'tkaza oladi";
const COURIER_NOT_A_COURIER_MESSAGE =
  "Bu foydalanuvchi kuryer emas — filialdan filialga faqat kuryer o'tkaziladi";
const COURIER_NOT_FOUND_MESSAGE = 'Kuryer topilmadi';
const COURIER_TARGET_NOT_FOUND_MESSAGE = 'Tanlangan filial topilmadi';
const COURIER_TARGET_INACTIVE_MESSAGE =
  "Yangi filial faol emas — nofaol filialga kuryer o'tkazib bo'lmaydi";
const COURIER_ALREADY_IN_BRANCH_MESSAGE = 'Kuryer allaqachon shu filialda';
const COURIER_ROW_CHANGED_MESSAGE =
  "Kuryerning filiali shu paytda o'zgardi — sahifani yangilab, qayta urinib ko'ring";
const COURIER_TRANSFER_TX_FAILED_MESSAGE =
  "Kuryerni o'tkazishda ma'lumotlar bazasi xatosi — o'tkazish bajarilmadi. Qayta urinib ko'ring";
const COURIER_REGION_SYNC_FAILED_MESSAGE =
  "Kuryer hududini yangilab bo'lmadi — o'tkazish bekor qilindi. Birozdan so'ng qayta urinib ko'ring";

/**
 * R3 vaqt byudjeti — har qatlam o'zidan pastdagisidan uzun bo'lishi SHART:
 * uch manba (finance, order, logistics) PARALLEL, har biri 5 s; maqsad
 * filialning FAOL menejeri (identity, 5 s) oldindan tekshiruv bilan PARALLEL;
 * hudud yangilash 5 s, qaytarish 3 s (identity `set_region` mahalliy — tashqi
 * chaqiruvsiz); qayta tekshiruvdan oldin 1,5 s kutish. Gateway: tekshiruv
 * 15 s, o'tkazish 40 s (COURIER_TRANSFER_RPC_TIMEOUT_MS).
 *
 * PATCH /couriers/:id/branch eng yomon holati: kuryer (identity) 5 s +
 * max(oldindan tekshiruv, faol menejer 5 s) + 1,5 s kutish + qayta
 * tekshiruv 5 s + hudud 5 s + tiklash 3 s. Oldindan tekshiruv odatda 5 s;
 * sof-nol PENDING holatida (C8) esa 5 s + yopish 3 s + qayta yuklash 5 s =
 * 13 s — jami ≈ 32,5 s (+ baza) < gateway 40 s. Menejer tekshiruvi oldindan
 * tekshiruv bilan PARALLEL yuboriladi (ketma-ket bo'lsa budjet yana o'sardi).
 * DELETE /branches/:id/users/:userId (kuryer qatori): 5 + 3 + 5 = 13 s
 * (+ baza) < gateway 20 s.
 */
const COURIER_HOLDINGS_RPC_TIMEOUT_MS = 5000;
const COURIER_TARGET_MANAGER_RPC_TIMEOUT_MS = 5000;
const COURIER_REGION_SYNC_TIMEOUT_MS = 5000;
const COURIER_REGION_RESTORE_TIMEOUT_MS = 3000;
/**
 * C8 (CODE-06) — `order.settlement.close_zero_courier_rows` (order-service):
 * kuryerning sof-nol PENDING qatorlarini (yig'indisi ham, qoldig'i ham aynan
 * 0 tiyin) nol summali FIFO bilan yopadi. Best-effort, qisqa muddat.
 */
const COURIER_ZERO_ROWS_CLOSE_TIMEOUT_MS = 3000;
/**
 * O'tkazish yozilgandan keyin qayta tekshiruvgacha kutish: a'zolikni swap'dan
 * sal oldin o'qigan "kuryerga biriktirish" / skan amali o'z yozuvini tugatib
 * olsin — qayta tekshiruv uni ko'rsin.
 */
const COURIER_TRANSFER_RECHECK_DELAY_MS = 1500;
/** Sabab matnidagi va javobdagi namuna id'lar soni. */
const COURIER_HOLDINGS_SAMPLE_LIMIT = 5;

/**
 * Kuryer "qo'lidagi" hamma narsa — finance (kassa), order (PENDING savdo,
 * qoldiq, qo'lidagi buyurtmalar, qo'shimcha xarajat so'rovlari) va logistics
 * (qabul qilinmagan bekor pochtalar) javoblaridan. Pul so'mda (JSON son);
 * solishtirish `tiyin` da, chunki ustunlar numeric(…,2) va JS float siljiydi.
 */
type CourierHoldings = {
  has_cashbox: boolean;
  balance: number;
  balance_cash: number;
  balance_card: number;
  pending_settlement_count: number;
  pending_settlement_amount: number;
  carry_amount: number;
  orders_in_hand: number;
  orders_sample: Array<{ id: string; status: string }>;
  open_return_posts: number;
  return_posts_sample: Array<{
    id: string;
    branch_id: string | null;
    order_quantity: number;
  }>;
  pending_extra_cost_approvals: number;
  /** Solishtirish uchun (javobga chiqmaydi): `legs` = naqd + karta. */
  tiyin: { balance: number; legs: number; pending: number; carry: number };
};

/** O'tkazish tranzaksiyasi natijasi — qaytarish (revert) shu bilan ishlaydi. */
type CourierBranchSwap = {
  fromRowId: string | null;
  fromBranchId: string | null;
  toRowId: string;
  toBranchId: string;
};

@Injectable()
export class BranchServiceService implements OnModuleInit {
  private readonly logger = new Logger(BranchServiceService.name);
  private readonly hqCode: string;
  private readonly hqName: string;
  private readonly hqAddress: string | null;

  constructor(
    @InjectRepository(Branch) private readonly branchRepo: Repository<Branch>,
    @InjectRepository(BranchUser)
    private readonly branchUserRepo: Repository<BranchUser>,
    @InjectRepository(BranchConfig)
    private readonly branchConfigRepo: Repository<BranchConfig>,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('FILE') private readonly fileClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    config: ConfigService,
    private readonly activityLog: ActivityLogService,
  ) {
    this.hqCode = config.get<string>('BRANCH_HQ_CODE', 'HQ-TSHKNT');
    this.hqName = config.get<string>('BRANCH_HQ_NAME', 'HQ Toshkent');
    const addr = config.get<string>('BRANCH_HQ_ADDRESS', 'Toshkent');
    this.hqAddress = addr === '' ? null : addr;
  }

  async onModuleInit() {
    await this.ensureHqBranch();
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

  private normalizeBranchUserRole(role?: string | null): BranchUserRole {
    const normalized = String(role ?? BranchUserRole.REGISTRATOR)
      .trim()
      .toUpperCase();
    if (normalized === BranchUserRole.MANAGER) {
      return BranchUserRole.MANAGER;
    }
    if (normalized === BranchUserRole.REGISTRATOR) {
      return BranchUserRole.REGISTRATOR;
    }
    if (normalized === BranchUserRole.COURIER) {
      return BranchUserRole.COURIER;
    }
    this.badRequest('role faqat MANAGER, REGISTRATOR, COURIER bo‘lishi mumkin');
  }

  private isSystemPrivileged(requester?: RequesterContext): boolean {
    const roles = (requester?.roles ?? []).map((role) =>
      String(role).toLowerCase(),
    );
    return roles.includes('superadmin') || roles.includes('admin');
  }

  private async collectDescendantBranchIds(
    rootBranchIds: string[],
  ): Promise<Set<string>> {
    const roots = Array.from(
      new Set(
        rootBranchIds.map((id) => String(id ?? '').trim()).filter(Boolean),
      ),
    );
    if (roots.length === 0) {
      return new Set<string>();
    }

    const tablePath = this.branchRepo.metadata.tablePath;
    const tableRef = tablePath
      .split('.')
      .map((part) => `"${part}"`)
      .join('.');

    const rows: Array<{ id: string }> = await this.branchRepo.manager.query(
      `
        WITH RECURSIVE tree AS (
          SELECT id
          FROM ${tableRef}
          WHERE id = ANY($1::bigint[]) AND is_deleted = false
          UNION ALL
          SELECT b.id
          FROM ${tableRef} b
          INNER JOIN tree t ON b.parent_id = t.id
          WHERE b.is_deleted = false
        )
        SELECT id FROM tree;
      `,
      [roots],
    );

    return new Set<string>(rows.map((row) => String(row.id)));
  }

  private async resolveAccessScope(
    requester?: RequesterContext,
  ): Promise<BranchAccessScope> {
    if (this.isSystemPrivileged(requester)) {
      return {
        readableBranchIds: new Set<string>(),
        writableBranchIds: new Set<string>(),
        managerReadableBranchIds: new Set<string>(),
      };
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const assignments = await this.branchUserRepo.find({
      where: {
        user_id: requesterId,
        isDeleted: false,
      },
      select: ['branch_id', 'role'],
    });

    const ownBranchIds = new Set(
      assignments
        .map((item) => String(item.branch_id))
        .filter((id) => Boolean(id)),
    );

    const managerRoots = assignments
      .filter(
        (item) =>
          this.normalizeBranchUserRole(item.role) === BranchUserRole.MANAGER,
      )
      .map((item) => String(item.branch_id));

    const readableBranchIds = new Set<string>(ownBranchIds);
    const managerTreeIds = await this.collectDescendantBranchIds(managerRoots);
    managerTreeIds.forEach((id) => readableBranchIds.add(id));

    return {
      readableBranchIds,
      writableBranchIds: new Set(managerRoots),
      managerReadableBranchIds: managerTreeIds,
    };
  }

  private async assertCanReadBranch(
    branchId: string,
    requester?: RequesterContext,
  ): Promise<void> {
    if (this.isSystemPrivileged(requester)) {
      return;
    }
    const scope = await this.resolveAccessScope(requester);
    if (!scope.readableBranchIds.has(String(branchId))) {
      this.forbidden('Bu filial ma’lumotini ko‘rishga ruxsat yo‘q');
    }
  }

  private async assertCanWriteBranch(
    branchId: string,
    requester?: RequesterContext,
  ): Promise<void> {
    if (this.isSystemPrivileged(requester)) {
      return;
    }
    const scope = await this.resolveAccessScope(requester);
    if (!scope.writableBranchIds.has(String(branchId))) {
      this.forbidden('Bu filialga yozish/o‘zgartirish ruxsati yo‘q');
    }
  }

  /**
   * Pochta jo'natiladigan filialda pochtani QABUL QILA OLADIGAN menejer bormi
   * (CODE-07). branch_users qatorining o'zi yetarli emas: identity `deleteUser`
   * qatorni o'chirmaydi, bloklash esa faqat statusni o'zgartiradi — o'chirilgan
   * yoki bloklangan menejerning qatori qoladi, u esa tizimga kira olmaydi va
   * pochta filialda qotib qoladi. Qator yo'q — 400; identity javob bermasa —
   * 503 (fail-closed); faol menejer yo'q — 400.
   */
  private async assertBranchHasManager(branch: Branch): Promise<void> {
    const managerUserIds = await this.findBranchManagerUserIds(
      String(branch.id),
    );
    if (!managerUserIds.length) {
      this.badRequest(
        "Avval bu filialga menejer biriktiring — menejersiz filialga pochta jo'natib bo'lmaydi",
      );
    }

    let activeManagers: number;
    try {
      activeManagers = await this.countActiveManagers(managerUserIds);
    } catch (error) {
      this.logger.warn(
        `dispatch destination manager check failed (branch=${String(branch.id)}): ${this.describeRpcFailure(error)}`,
      );
      throw new RpcException(
        errorRes(DISPATCH_MANAGER_CHECK_UNAVAILABLE_MESSAGE, 503),
      );
    }
    if (!activeManagers) {
      this.badRequest(
        `'${branch.name}' filialida faol menejer yo'q (menejer o'chirilgan yoki bloklangan) — pochtani qabul qiladigan odam bo'lmaydi. Avval filialga faol menejer biriktiring`,
      );
    }
  }

  private normalizePagination(page?: number, limit?: number) {
    const safePage = Number(page) > 0 ? Number(page) : 1;
    const safeLimit = Number(limit) > 0 ? Math.min(Number(limit), 100) : 10;
    return {
      page: safePage,
      limit: safeLimit,
      skip: (safePage - 1) * safeLimit,
    };
  }

  private parseStatus(status?: string): Status | undefined {
    if (!status) {
      return undefined;
    }

    const normalized = String(status).toLowerCase();
    if (normalized !== Status.ACTIVE && normalized !== Status.INACTIVE) {
      this.badRequest("status faqat 'active' yoki 'inactive' bo'lishi mumkin");
    }
    return normalized as Status;
  }

  private normalizeNullableBigint(value: unknown): string | null {
    if (value === null || typeof value === 'undefined' || value === '') {
      return null;
    }
    return String(value as string | number | bigint);
  }

  private parseBranchType(type?: string): BranchType {
    const normalized = String(type ?? '')
      .trim()
      .toUpperCase();
    if (
      !normalized ||
      !Object.values(BranchType).includes(normalized as BranchType)
    ) {
      this.badRequest(
        `Filial turi (type) quyidagilardan biri bo'lishi kerak: ${Object.values(BranchType).join(', ')}`,
      );
    }
    return normalized as BranchType;
  }

  private normalizeBranchCode(code?: string | null): string {
    const normalized = String(code ?? '')
      .trim()
      .toUpperCase();
    if (!normalized) {
      this.badRequest('Filial kodi (code) majburiy');
    }
    if (!/^[A-Z0-9-]{2,32}$/.test(normalized)) {
      this.badRequest(
        "Filial kodi (code) 2–32 belgidan iborat bo'lishi va faqat A–Z, 0–9 hamda '-' belgilaridan tuzilishi kerak",
      );
    }
    return normalized;
  }

  private async ensureBranchNameUnique(
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const normalized = name.trim();
    if (!normalized) return;
    const found = await this.branchRepo
      .createQueryBuilder('b')
      .where('LOWER(TRIM(b.name)) = LOWER(:name)', { name: normalized })
      .andWhere('b.is_deleted = false')
      .getOne();
    if (found && (!exceptId || found.id !== exceptId)) {
      this.conflict('Bu nomli filial allaqachon bor — boshqa nom tanlang');
    }
  }

  private async ensureBranchCodeUnique(
    code: string,
    exceptId?: string,
  ): Promise<void> {
    const exists = await this.branchRepo.findOne({
      where: { code, isDeleted: false },
    });
    if (exists && exists.id !== exceptId) {
      this.conflict(
        'Bu kodli (code) filial allaqachon mavjud — boshqa kod tanlang',
      );
    }
  }

  private async getParentBranchOrThrow(parentId: string): Promise<Branch> {
    const parent = await this.branchRepo.findOne({
      where: { id: String(parentId), isDeleted: false },
    });
    if (!parent) {
      this.notFound('Ota filial topilmadi');
    }
    return parent;
  }

  private async ensureNotCyclicParent(
    branchId: string,
    parentId: string,
  ): Promise<void> {
    if (branchId === parentId) {
      this.badRequest(
        "Filial o'ziga o'zi ota filial bo'la olmaydi (aylanma bog'lanish)",
      );
    }

    const visited = new Set<string>();
    let currentId: string | null = parentId;

    while (currentId) {
      if (currentId === branchId) {
        this.badRequest(PARENT_CYCLE_MESSAGE);
      }
      if (visited.has(currentId)) {
        this.badRequest(PARENT_CYCLE_MESSAGE);
      }
      visited.add(currentId);
      const current = await this.branchRepo.findOne({
        where: { id: currentId, isDeleted: false },
      });
      if (!current) {
        this.notFound('Ota filial topilmadi');
      }
      currentId = current.parent_id ?? null;
    }
  }

  private async hasActiveChildren(branchId: string): Promise<boolean> {
    const childrenCount = await this.branchRepo.count({
      where: { parent_id: branchId, isDeleted: false },
    });
    return childrenCount > 0;
  }

  private async rebalanceDescendantLevels(
    rootBranchId: string,
    rootLevel: number,
  ): Promise<void> {
    const queue: Array<{ branchId: string; level: number }> = [
      { branchId: rootBranchId, level: rootLevel },
    ];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = await this.branchRepo.find({
        where: { parent_id: current.branchId, isDeleted: false },
      });

      for (const child of children) {
        const expectedLevel = current.level + 1;
        if (child.level !== expectedLevel) {
          child.level = expectedLevel;
          await this.branchRepo.save(child);
        }
        queue.push({ branchId: child.id, level: expectedLevel });
      }
    }
  }

  private async getParentsByIds(ids: string[]): Promise<Map<string, Branch>> {
    if (!ids.length) {
      return new Map();
    }

    const parents = await this.branchRepo.find({
      where: { id: In(ids), isDeleted: false },
    });
    return new Map(parents.map((parent) => [parent.id, parent]));
  }

  private async ensureHqBranch(): Promise<void> {
    const hqByCode = await this.branchRepo.findOne({
      where: { code: this.hqCode, isDeleted: false },
    });
    if (hqByCode) {
      if (
        hqByCode.type !== BranchType.HQ ||
        hqByCode.level !== 0 ||
        hqByCode.parent_id !== null
      ) {
        hqByCode.type = BranchType.HQ;
        hqByCode.level = 0;
        hqByCode.parent_id = null;
        await this.branchRepo.save(hqByCode);
      }
      return;
    }

    const anyHq = await this.branchRepo.findOne({
      where: { type: BranchType.HQ, isDeleted: false },
    });
    if (anyHq) {
      if (!anyHq.code) {
        anyHq.code = this.hqCode;
      }
      if (anyHq.parent_id !== null || anyHq.level !== 0) {
        anyHq.parent_id = null;
        anyHq.level = 0;
      }
      await this.branchRepo.save(anyHq);
      return;
    }

    await this.branchRepo.save(
      this.branchRepo.create({
        name: this.hqName,
        address: this.hqAddress,
        phone_number: null,
        region_id: null,
        district_id: null,
        parent_id: null,
        type: BranchType.HQ,
        level: 0,
        code: this.hqCode,
        status: Status.ACTIVE,
        manager_id: null,
      }),
    );
  }

  private async getBranchOrThrow(id: string): Promise<Branch> {
    const branch = await this.branchRepo.findOne({
      where: { id: String(id), isDeleted: false },
    });

    if (!branch) {
      this.notFound('Filial topilmadi');
    }

    return branch;
  }

  private async ensureUserExists(
    userId: string,
  ): Promise<{ id: string; role?: string | null; region_id?: string | null }> {
    try {
      const res = await lastValueFrom(
        this.identityClient
          .send<{
            data?: {
              id?: string;
              role?: string | null;
              region_id?: string | number | null;
            };
          }>({ cmd: 'identity.user.find_by_id' }, { id: userId })
          .pipe(timeout(5000)),
      );
      if (!res?.data?.id) {
        this.notFound('Foydalanuvchi topilmadi');
      }
      return {
        id: String(res.data.id),
        role: res.data.role ?? null,
        // R3: kuryer hududi filialga ergashadi — o'tkazishda solishtiriladi.
        region_id: String(res.data.region_id ?? '').trim() || null,
      };
    } catch (error) {
      if (error instanceof RpcException) {
        const err = error.getError() as
          | string
          | {
              statusCode?: number;
              message?: string;
            };
        const statusCode =
          typeof err === 'object' && err ? Number(err.statusCode ?? 500) : 500;
        if (statusCode === 404) {
          this.notFound('Foydalanuvchi topilmadi');
        }
        throw error;
      }
      if (
        typeof error === 'object' &&
        error &&
        'statusCode' in error &&
        Number((error as { statusCode?: number }).statusCode) === 404
      ) {
        this.notFound('Foydalanuvchi topilmadi');
      }
      throw new RpcException(
        errorRes(IDENTITY_SERVICE_UNAVAILABLE_MESSAGE, 502),
      );
    }
  }

  private resolveBranchRoleFromUserRole(
    userRole?: string | null,
  ): BranchUserRole {
    const normalized = String(userRole ?? '')
      .trim()
      .toLowerCase();
    if (normalized === 'manager') {
      return BranchUserRole.MANAGER;
    }
    if (normalized === 'registrator') {
      return BranchUserRole.REGISTRATOR;
    }
    if (normalized === 'courier') {
      return BranchUserRole.COURIER;
    }
    this.badRequest(
      'User roli branchga biriktirish uchun mos emas (faqat manager/registrator/courier)',
    );
  }

  private async getRegionsByIds(
    regionIds: string[],
  ): Promise<Map<string, unknown>> {
    if (!regionIds.length) {
      return new Map();
    }

    try {
      const res = await lastValueFrom(
        this.logisticsClient
          .send<{
            data?: Array<Record<string, unknown>>;
          }>({ cmd: 'logistics.region.find_by_ids' }, { ids: regionIds })
          .pipe(timeout(5000)),
      );

      const items = Array.isArray(res?.data) ? res.data : [];
      const map = new Map<string, unknown>();
      items.forEach((region) => {
        const id = String((region?.id ?? '') as string);
        if (id) {
          map.set(id, region);
        }
      });
      return map;
    } catch (err) {
      this.logger.warn(
        `logistics.region.find_by_ids failed (ids=${regionIds.length}): ${(err as Error)?.message ?? err}`,
      );
      return new Map();
    }
  }

  private async getDistrictsByIds(
    districtIds: string[],
  ): Promise<Map<string, unknown>> {
    if (!districtIds.length) {
      return new Map();
    }

    try {
      const res = await lastValueFrom(
        this.logisticsClient
          .send<{
            data?: Array<Record<string, unknown>>;
          }>({ cmd: 'logistics.district.find_by_ids' }, { ids: districtIds })
          .pipe(timeout(5000)),
      );

      const items = Array.isArray(res?.data) ? res.data : [];
      const map = new Map<string, unknown>();
      items.forEach((district) => {
        const id = String((district?.id ?? '') as string);
        if (id) {
          map.set(id, district);
        }
      });
      return map;
    } catch (err) {
      this.logger.warn(
        `logistics.district.find_by_ids failed (ids=${districtIds.length}): ${(err as Error)?.message ?? err}`,
      );
      return new Map();
    }
  }

  private async getUsersByIds(
    userIds: string[],
  ): Promise<Map<string, unknown>> {
    if (!userIds.length) {
      return new Map();
    }

    const results = await Promise.all(
      userIds.map(async (id) => {
        try {
          const res = await lastValueFrom(
            this.identityClient
              .send<{
                data?: Record<string, unknown>;
              }>({ cmd: 'identity.user.find_by_id' }, { id })
              .pipe(timeout(5000)),
          );
          return [id, res?.data ?? null] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );

    return new Map(results);
  }

  /**
   * getUsersByIds'ning BATCH varianti: har foydalanuvchiga alohida
   * `identity.user.find_by_id` o'rniga bitta `identity.user.find_all`
   * (`user_ids` filtri; identity sahifani 100 bilan cheklaydi — shuning uchun
   * 100 talik bo'laklar). Xato/timeout/buzuq javob bo'lsa — null: chaqiruvchi
   * ism/telefonsiz davom etadi, ro'yxat yiqilmaydi, lekin "identity javob
   * bermadi"ni "foydalanuvchi yo'q"dan ajrata oladi.
   */
  private async getUsersByIdsBatch(
    userIds: string[],
  ): Promise<Map<string, Record<string, unknown>> | null> {
    const ids = Array.from(
      new Set(userIds.map((id) => String(id ?? '').trim()).filter(Boolean)),
    );
    const usersById = new Map<string, Record<string, unknown>>();
    if (!ids.length) {
      return usersById;
    }

    const chunkSize = 100;
    try {
      for (let offset = 0; offset < ids.length; offset += chunkSize) {
        const chunk = ids.slice(offset, offset + chunkSize);
        const res = await lastValueFrom(
          this.identityClient
            .send<{
              data?: { items?: Array<Record<string, unknown>> };
            }>(
              { cmd: 'identity.user.find_all' },
              { query: { user_ids: chunk, page: 1, limit: chunkSize } },
            )
            .pipe(timeout(5000)),
        );
        const items = res?.data?.items;
        if (!Array.isArray(items)) {
          throw new Error('identity.user.find_all: items massiv emas');
        }
        for (const user of items) {
          const id = String((user?.id ?? '') as string).trim();
          if (id) {
            usersById.set(id, user);
          }
        }
      }
    } catch (err) {
      this.logger.warn(
        `identity.user.find_all failed (user_ids=${ids.length}): ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
    return usersById;
  }

  private toTashkentStartOfDay(date: Date): Date {
    const tzOffsetMs = 5 * 60 * 60 * 1000;
    const shifted = new Date(date.getTime() + tzOffsetMs);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth();
    const day = shifted.getUTCDate();
    return new Date(Date.UTC(year, month, day) - tzOffsetMs);
  }

  private toTashkentStartOfWeek(date: Date): Date {
    const dayStart = this.toTashkentStartOfDay(date);
    const tzOffsetMs = 5 * 60 * 60 * 1000;
    const shifted = new Date(dayStart.getTime() + tzOffsetMs);
    const dayOfWeek = shifted.getUTCDay(); // 0=Sun ... 6=Sat
    const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    return new Date(dayStart.getTime() - diffToMonday * 24 * 60 * 60 * 1000);
  }

  private toTashkentStartOfMonth(date: Date): Date {
    const tzOffsetMs = 5 * 60 * 60 * 1000;
    const shifted = new Date(date.getTime() + tzOffsetMs);
    return new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - tzOffsetMs,
    );
  }

  private toTashkentStartOfYear(date: Date): Date {
    const tzOffsetMs = 5 * 60 * 60 * 1000;
    const shifted = new Date(date.getTime() + tzOffsetMs);
    return new Date(Date.UTC(shifted.getUTCFullYear(), 0, 1) - tzOffsetMs);
  }

  private resolveBranchDashboardRange(filter: BranchDashboardFilter = {}): {
    start: Date | null;
    end: Date;
  } {
    const now = new Date();
    if (filter.all === true) {
      return { start: null, end: now };
    }

    const start = filter.startDate ? new Date(filter.startDate) : null;
    const end = filter.endDate ? new Date(filter.endDate) : now;
    if (
      start &&
      !Number.isNaN(start.getTime()) &&
      !Number.isNaN(end.getTime())
    ) {
      return { start, end };
    }

    const period = String(filter.period ?? 'today').toLowerCase();
    if (period === 'week') {
      return { start: this.toTashkentStartOfWeek(now), end: now };
    }
    if (period === 'month') {
      return { start: this.toTashkentStartOfMonth(now), end: now };
    }
    if (period === 'year') {
      return { start: this.toTashkentStartOfYear(now), end: now };
    }
    return { start: this.toTashkentStartOfDay(now), end: now };
  }

  /**
   * Filial paneli raqamlari — order-service'da SQL bilan hisoblanadi
   * (Scale 1-bosqich).
   *
   * ⚠️ BU METOD `getOrdersByBranchIds` NING O'RNINI OLDI. Eskisi har filial
   * uchun alohida `order.find_all` ni `fetch_all: true, limit: 5000` bilan
   * chaqirib, buyurtmalarni mahsulotlari bilan tortib olardi va ularni JS'da
   * sanardi. Jamlanma hajm 5 000 dan oshgan filialda statistika jimgina kam
   * ko'rsata boshlardi — endi bunday chegara yo'q.
   */
  private async fetchBranchDashboardStats(payload: {
    branch_ids: string[];
    courier_ids: string[];
    start: string | null;
    end: string | null;
    today_start: string;
    week_start: string;
  }): Promise<{ stats: BranchDashboardStats; unavailable: boolean }> {
    const empty: BranchDashboardStats = {
      today_orders_count: 0,
      week_orders_count: 0,
      selected_orders_count: 0,
      active_batches_count: 0,
      orders_card: {
        total: 0,
        new: 0,
        on_the_road: 0,
        delivered: 0,
        returned: 0,
        cancelled: 0,
      },
      markets: [],
      packages: { on_the_way: 0, waiting_for_acceptance: 0 },
      active_couriers: 0,
    };

    if (!payload.branch_ids.length && !payload.courier_ids.length) {
      return { stats: empty, unavailable: false };
    }

    // C9 (CODE-23): xato, timeout yoki buzuq javobda ham nollar (shakl
    // saqlanadi), lekin `unavailable: true` — panel "0 ta buyurtma" deb jim
    // yolg'on ko'rsatmasin, FE "Statistika vaqtincha mavjud emas" desin.
    try {
      const response = await lastValueFrom(
        this.orderClient
          .send<
            { data?: BranchDashboardStats } | BranchDashboardStats
          >({ cmd: 'order.analytics.branch_dashboard' }, payload)
          .pipe(timeout(BRANCH_DASHBOARD_STATS_TIMEOUT_MS)),
      );
      const data =
        (response as { data?: BranchDashboardStats })?.data ??
        (response as BranchDashboardStats);
      if (
        !data ||
        typeof data !== 'object' ||
        !data.orders_card ||
        typeof data.orders_card !== 'object' ||
        !Array.isArray(data.markets) ||
        !data.packages ||
        typeof data.packages !== 'object'
      ) {
        throw new Error(
          "order.analytics.branch_dashboard: javob shakli noto'g'ri",
        );
      }
      return { stats: data, unavailable: false };
    } catch (error) {
      this.logger.warn(
        `order.analytics.branch_dashboard failed (branches=${payload.branch_ids.length}): ${this.describeRpcFailure(error)}`,
      );
      return { stats: empty, unavailable: true };
    }
  }

  private async getCourierIdsByBranchIds(
    branchIds: string[],
  ): Promise<string[]> {
    if (!branchIds.length) {
      return [];
    }

    const courierAssignments =
      (await this.branchUserRepo.find({
        where: {
          branch_id: In(branchIds),
          role: BranchUserRole.COURIER,
          isDeleted: false,
        },
        select: ['user_id'],
      })) ?? [];

    const ids = new Set(
      courierAssignments
        .map((assignment) => String(assignment.user_id ?? '').trim())
        .filter(Boolean),
    );

    try {
      const response = await lastValueFrom(
        this.identityClient
          .send<{
            data?: {
              items?: Array<{ id?: string; branch_id?: string | null }>;
            };
          }>(
            { cmd: 'identity.user.find_all' },
            { query: { role: Roles.COURIER, page: 1, limit: 1000 } },
          )
          .pipe(timeout(8000)),
      );
      const branchSet = new Set(branchIds.map((id) => String(id)));
      for (const courier of response?.data?.items ?? []) {
        const branchId = String(courier?.branch_id ?? '').trim();
        const courierId = String(courier?.id ?? '').trim();
        if (courierId && branchSet.has(branchId)) {
          ids.add(courierId);
        }
      }
    } catch {
      // BranchUser is the source of truth; identity.branch_id is a compatibility fallback.
    }

    return Array.from(ids);
  }

  private async resolveAnalyticsBranchIds(
    branchId: string,
    requester?: RequesterContext,
  ): Promise<string[]> {
    await this.getBranchOrThrow(branchId);
    await this.assertCanReadBranch(branchId, requester);

    if (this.isSystemPrivileged(requester)) {
      return Array.from(await this.collectDescendantBranchIds([branchId]));
    }

    const scope = await this.resolveAccessScope(requester);
    if (scope.managerReadableBranchIds.has(String(branchId))) {
      return Array.from(await this.collectDescendantBranchIds([branchId]));
    }

    return [String(branchId)];
  }

  private normalizeTransferDirection(value?: string): BranchTransferDirection {
    const normalized = String(value ?? '')
      .trim()
      .toUpperCase();
    if (
      normalized !== BranchTransferDirection.FORWARD &&
      normalized !== BranchTransferDirection.RETURN
    ) {
      this.badRequest(
        `direction quyidagilardan biri bo'lishi kerak: ${BranchTransferDirection.FORWARD}, ${BranchTransferDirection.RETURN}`,
      );
    }
    return normalized as BranchTransferDirection;
  }

  private normalizeTransferRequestKey(value?: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      this.badRequest('request_key majburiy');
    }
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(normalized)) {
      this.badRequest(
        "request_key 8–80 belgidan iborat bo'lishi va faqat A–Z, a–z, 0–9, '_' hamda '-' belgilaridan tuzilishi kerak",
      );
    }
    return normalized;
  }

  private async assertCanCreateTransferBatch(
    branchId: string,
    requester?: RequesterContext,
  ) {
    if (this.isSystemPrivileged(requester)) {
      return;
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const assignments = await this.branchUserRepo.find({
      where: { user_id: requesterId, isDeleted: false },
      select: ['branch_id', 'role'],
    });

    const ownAssignment = assignments.find(
      (item) =>
        String(item.branch_id) === String(branchId) &&
        (this.normalizeBranchUserRole(item.role) ===
          BranchUserRole.REGISTRATOR ||
          this.normalizeBranchUserRole(item.role) === BranchUserRole.MANAGER),
    );
    if (ownAssignment) {
      return;
    }

    const managerRoots = assignments
      .filter(
        (item) =>
          this.normalizeBranchUserRole(item.role) === BranchUserRole.MANAGER,
      )
      .map((item) => String(item.branch_id));

    if (!managerRoots.length) {
      this.forbidden('Transfer batch yaratishga ruxsat yo‘q');
    }

    const managerTree = await this.collectDescendantBranchIds(managerRoots);
    if (!managerTree.has(String(branchId))) {
      this.forbidden('Transfer batch yaratishga ruxsat yo‘q');
    }
  }

  /**
   * branch_users rolini katta harfli string sifatida solishtirish.
   * `normalizeBranchUserRole` ATAYLAB ishlatilmaydi: u noma'lum rolda 400
   * tashlaydi, ruxsat tekshiruvida esa kutilgan javob — 403.
   */
  private isBranchUserRoleOneOf(
    role: string | null | undefined,
    allowed: readonly BranchUserRole[],
  ): boolean {
    const normalized = String(role ?? '')
      .trim()
      .toUpperCase();
    return (allowed as readonly string[]).includes(normalized);
  }

  // ===== R3: kuryer qo'lidagi pul va buyurtmalar (umumiy tekshiruv) =====

  /** Xato matni log uchun (RPC xatosi oddiy obyekt bo'lib keladi). */
  private describeRpcFailure(error: unknown): string {
    const message = (error as { message?: unknown } | null | undefined)
      ?.message;
    if (typeof message === 'string' && message) {
      return message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return 'unknown error';
    }
  }

  /** RPC xatosi 404 mi — yuqori darajadagi yoki ichki (`error`) statusCode. */
  private isRpcNotFound(error: unknown): boolean {
    const source = (
      error instanceof RpcException ? error.getError() : error
    ) as
      | { statusCode?: unknown; error?: { statusCode?: unknown } }
      | null
      | undefined;
    return Number(source?.statusCode ?? source?.error?.statusCode) === 404;
  }

  /** Raqamli id (kanonik ko'rinishda: '015' → '15') yoki 400. */
  private parseCourierTransferId(value: unknown, message: string): string {
    const normalized = String((value ?? '') as string).trim();
    if (!/^\d+$/.test(normalized)) {
      this.badRequest(message);
    }
    return this.canonicalId(normalized);
  }

  /**
   * So'm → tiyin (butun son). Ustunlar numeric(…,2), JS float esa siljiydi —
   * pul faqat tiyinda solishtiriladi. Son bo'lmagan qiymat (yo'q maydon ham)
   * XATO: "noma'lum" hech qachon "nol" deb o'qilmaydi (tekshiruv → 503).
   */
  private toTiyin(value: unknown, label: string): number {
    const amount =
      typeof value === 'number' ||
      (typeof value === 'string' && value.trim() !== '')
        ? Number(value)
        : NaN;
    if (!Number.isFinite(amount)) {
      throw new Error(`${label} son emas: ${String(value as string)}`);
    }
    return Math.round(amount * 100);
  }

  /** Manfiy bo'lmagan butun son (sanoq) yoki xato (tekshiruv → 503). */
  private toHoldingsCount(value: unknown, label: string): number {
    const count =
      typeof value === 'number' ||
      (typeof value === 'string' && value.trim() !== '')
        ? Number(value)
        : NaN;
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`${label} son emas: ${String(value as string)}`);
    }
    return Math.trunc(count);
  }

  /**
   * Tiyin → xabardagi so'm: minglar bo'sh joy bilan, tiyin qismi faqat noldan
   * farq qilsa (",NN"). 15000000 → "150 000"; 12345 → "123,45".
   */
  private formatSomAmount(tiyin: number): string {
    const sign = tiyin < 0 ? '-' : '';
    const abs = Math.abs(Math.round(tiyin));
    const som = Math.floor(abs / 100);
    const rest = abs % 100;
    const grouped = String(som).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return rest
      ? `${sign}${grouped},${String(rest).padStart(2, '0')}`
      : `${sign}${grouped}`;
  }

  /** " (#101, #102 va yana K ta)"; namuna bo'sh bo'lsa — bo'sh satr. */
  private formatHoldingsSample(ids: string[], total: number): string {
    const shown = ids.slice(0, COURIER_HOLDINGS_SAMPLE_LIMIT);
    if (!shown.length) {
      return '';
    }
    const rest = total - shown.length;
    return ` (${shown.map((id) => `#${id}`).join(', ')}${rest > 0 ? ` va yana ${rest} ta` : ''})`;
  }

  /**
   * Kuryer qo'lidagi pul va buyurtmalar — uch manba PARALLEL, har biri 5 s:
   * finance (FOR_COURIER kassa), order (`order.courier_transfer_check`) va
   * logistics (`logistics.post.open_return_posts_for_courier` — kuryer
   * topshirgan, hali qabul qilinmagan bekor pochtalar).
   *
   * Logistics uchun ATAYLAB yengil RPC: `logistics.post.rejected_for_courier`
   * avval identity'ni (5 s) kutadi, keyin har pochta guruhi uchun
   * `order.find_all` (5 s) yuboradi — ichki eng yomon holat ~10 s, bu yerdagi
   * 5 s dan uzun edi (soxta 503). Yangi RPC'da identity yo'q, har pochtaga
   * bitta `order.find_all` parallel, har biri 3,5 s — 5 s ichiga sig'adi.
   *
   * ⚠️ FAIL-CLOSED. Faqat finance'ning 404'i ("kassa yo'q") nol deb olinadi.
   * Qolgan har qanday holat — timeout, 5xx, deploy paytida hali yo'q RPC,
   * `data` yo'qligi, massiv bo'lmagan logistics javobi, son bo'lmagan
   * qiymat — 503 va HECH NARSA yozilmaydi: "bilmasak — ko'chirmaymiz".
   *
   * `sendFinanceCommand` ATAYLAB ishlatilmaydi: bu yerda finance'ning 404'i
   * xato emas, "kassa yo'q" (nol) — va qolgan har qanday xato 502 emas, 503
   * bo'lishi kerak (ilgari u 500 bo'lib qolib, kassasi yo'q kuryer abadiy
   * bloklanardi).
   */
  private async loadCourierHoldings(
    courierId: string,
  ): Promise<CourierHoldings> {
    try {
      const [cashboxResponse, orderResponse, postsResponse] = await Promise.all(
        [
          lastValueFrom(
            this.financeClient
              .send<{
                data?: Record<string, unknown> | null;
              }>(
                { cmd: 'finance.cashbox.find_by_user' },
                { user_id: courierId, cashbox_type: Cashbox_type.FOR_COURIER },
              )
              .pipe(timeout(COURIER_HOLDINGS_RPC_TIMEOUT_MS)),
          ).catch((error: unknown) => {
            if (this.isRpcNotFound(error)) {
              return null;
            }
            throw error;
          }),
          lastValueFrom(
            this.orderClient
              .send<{
                data?: Record<string, unknown> | null;
              }>(
                { cmd: 'order.courier_transfer_check' },
                { courier_id: courierId },
              )
              .pipe(timeout(COURIER_HOLDINGS_RPC_TIMEOUT_MS)),
          ),
          lastValueFrom(
            this.logisticsClient
              .send<{
                data?: unknown;
              }>(
                { cmd: 'logistics.post.open_return_posts_for_courier' },
                { courier_id: courierId },
              )
              .pipe(timeout(COURIER_HOLDINGS_RPC_TIMEOUT_MS)),
          ),
        ],
      );
      return this.parseCourierHoldings(
        cashboxResponse,
        orderResponse,
        postsResponse,
      );
    } catch (error) {
      this.logger.warn(
        `courier holdings check failed (courier=${courierId}): ${this.describeRpcFailure(error)}`,
      );
      throw new RpcException(errorRes(COURIER_CHECK_UNAVAILABLE_MESSAGE, 503));
    }
  }

  /** Uch javobni tekshiradi va birlashtiradi; buzuq javob — xato (→ 503). */
  private parseCourierHoldings(
    cashboxResponse: { data?: Record<string, unknown> | null } | null,
    orderResponse: { data?: Record<string, unknown> | null } | undefined,
    postsResponse: { data?: unknown } | undefined,
  ): CourierHoldings {
    // null — finance 404: kassa yo'q, ya'ni pul ham yo'q.
    let hasCashbox = false;
    let balanceTiyin = 0;
    let cashTiyin = 0;
    let cardTiyin = 0;
    if (cashboxResponse !== null) {
      const cashbox = cashboxResponse?.data;
      if (!cashbox || typeof cashbox !== 'object') {
        throw new Error("finance.cashbox.find_by_user: data yo'q");
      }
      hasCashbox = true;
      balanceTiyin = this.toTiyin(cashbox.balance, 'balance');
      cashTiyin = this.toTiyin(cashbox.balance_cash, 'balance_cash');
      cardTiyin = this.toTiyin(cashbox.balance_card, 'balance_card');
    }

    const order = orderResponse?.data;
    if (!order || typeof order !== 'object') {
      throw new Error("order.courier_transfer_check: data yo'q");
    }
    const pendingCount = this.toHoldingsCount(
      order.pending_settlement_count,
      'pending_settlement_count',
    );
    const pendingTiyin = this.toTiyin(
      order.pending_settlement_amount,
      'pending_settlement_amount',
    );
    const carryTiyin = this.toTiyin(order.carry_amount, 'carry_amount');
    const ordersInHand = this.toHoldingsCount(
      order.orders_in_hand,
      'orders_in_hand',
    );
    const approvals = this.toHoldingsCount(
      order.pending_extra_cost_approvals,
      'pending_extra_cost_approvals',
    );
    const ordersSample = (
      Array.isArray(order.orders_sample)
        ? (order.orders_sample as Array<Record<string, unknown>>)
        : []
    )
      .map((row) => ({
        id: String((row?.id ?? '') as string).trim(),
        status: String((row?.status ?? '') as string),
      }))
      .filter((row) => row.id)
      .slice(0, COURIER_HOLDINGS_SAMPLE_LIMIT);

    // Har bekor pochtaning `order_quantity` si — uning O'Z CANCELLED_SENT
    // buyurtmalari soni (guruh soni emas). Sabab POCHTALAR bilan aytiladi:
    // `order_quantity > 0` bo'lganlar sanaladi, sonlar qo'shilmaydi; 0 li
    // (bo'sh qobiq) pochta to'siq emas.
    const posts = postsResponse?.data;
    if (!Array.isArray(posts)) {
      throw new Error(
        'logistics.post.open_return_posts_for_courier: javob massiv emas',
      );
    }
    const openPosts = (posts as Array<Record<string, unknown>>).filter(
      (post) =>
        this.toHoldingsCount(post?.order_quantity, 'order_quantity') > 0,
    );

    return {
      has_cashbox: hasCashbox,
      balance: balanceTiyin / 100,
      balance_cash: cashTiyin / 100,
      balance_card: cardTiyin / 100,
      pending_settlement_count: pendingCount,
      pending_settlement_amount: pendingTiyin / 100,
      carry_amount: carryTiyin / 100,
      orders_in_hand: ordersInHand,
      orders_sample: ordersSample,
      open_return_posts: openPosts.length,
      return_posts_sample: openPosts
        .slice(0, COURIER_HOLDINGS_SAMPLE_LIMIT)
        .map((post) => ({
          id: String((post.id ?? '') as string),
          branch_id: String((post.branch_id ?? '') as string).trim() || null,
          order_quantity: Number(post.order_quantity),
        })),
      pending_extra_cost_approvals: approvals,
      tiyin: {
        balance: balanceTiyin,
        legs: cashTiyin + cardTiyin,
        pending: pendingTiyin,
        carry: carryTiyin,
      },
    };
  }

  /**
   * To'siq sabablari (o'zbekcha, qat'iy tartibda). SOF funksiya.
   *
   * Pul: sof qoldiq (balance) YOKI naqd+karta yig'indisi noldan farq qilsa —
   * musbat ham, manfiy ham. Oyoqlar ALOHIDA nol bo'lishi shart emas: Click
   * topshirig'i naqd +X / karta −X (sof 0) holatini qoldiradi — bu yopilgan,
   * to'g'ri holat (finance ham sof qoldiq bilan ishlaydi). Musbat pulni kim
   * qabul qilishi ko'rsatiladi: HQ kuryeri — Asosiy kassa; filial kuryeri —
   * o'sha filial menejeri (superadmin EMAS); filialsiz — administrator.
   */
  private describeCourierHoldings(
    holdings: CourierHoldings,
    currentBranch: Branch | null,
  ): string[] {
    const reasons: string[] = [];
    const moneyTiyin =
      holdings.tiyin.balance !== 0
        ? holdings.tiyin.balance
        : holdings.tiyin.legs;
    if (moneyTiyin > 0) {
      const amount = this.formatSomAmount(moneyTiyin);
      if (!currentBranch) {
        reasons.push(
          `kuryer qo'lida ${amount} so'm pul bor — kuryer hech qaysi filialga biriktirilmagan, pulni qabul qilish uchun administratorga murojaat qiling.`,
        );
      } else if (currentBranch.type === BranchType.HQ) {
        reasons.push(
          `kuryer qo'lida ${amount} so'm pul bor — avval uni Asosiy kassaga qabul qiling (To'lovlar → Qabul qilinishi kerak).`,
        );
      } else {
        reasons.push(
          `kuryer qo'lida ${amount} so'm pul bor — avval uni '${currentBranch.name}' filiali menejeri qabul qilib olsin.`,
        );
      }
    } else if (moneyTiyin < 0) {
      reasons.push(
        `kuryer kassasi manfiy (-${this.formatSomAmount(-moneyTiyin)} so'm) — kuryerga to'lanishi kerak bo'lgan pul bor, avval hisob-kitobni yoping.`,
      );
    }

    if (holdings.pending_settlement_count > 0) {
      // Blok QOLADI (aks holda courier_to_branch FIFO eski filial qatorlarini
      // yangi filial puli bilan yopardi). Lekin sof-nol holatda (PENDING
      // qatorlar yig'indisi ham, kassa — sof qoldiq va naqd+karta — ham 0)
      // "kutib qayta tekshiring" hech qachon yordam bermaydi: 0 so'm topshirib
      // bo'lmaydi. C8: kuryerni filialdan chiqarish va o'tkazish bu qatorlarni
      // avval o'zi yopishga urinadi — shuning uchun haqiqiy yo'l aytiladi.
      if (
        holdings.tiyin.pending === 0 &&
        holdings.tiyin.balance === 0 &&
        holdings.tiyin.legs === 0
      ) {
        reasons.push(
          holdings.tiyin.carry === 0
            ? `kuryerning ${holdings.pending_settlement_count} ta sotuvi bo'yicha hisob-kitob ochiq qolgan, lekin ularning jami summasi 0 so'm — kuryerni filialdan chiqarganda yoki boshqa filialga o'tkazganda bu 0 so'mlik yozuvlar avtomatik yopiladi; yopilmasa, tizim administratoriga murojaat qiling.`
            : `kuryerning ${holdings.pending_settlement_count} ta sotuvi bo'yicha hisob-kitob ochiq qolgan, lekin ularning jami summasi 0 so'm — bu yozuvlar kuryerning keyingi pul topshirishida yopiladi; shoshilinch bo'lsa, tizim administratoriga murojaat qiling.`,
        );
      } else {
        const amount =
          holdings.tiyin.pending !== 0
            ? ` (${this.formatSomAmount(holdings.tiyin.pending)} so'm)`
            : '';
        reasons.push(
          `kuryerning ${holdings.pending_settlement_count} ta sotuvi bo'yicha hisob-kitob hali yopilmagan${amount}. Pul topshirilgan bo'lsa, bir necha soniyadan so'ng qayta tekshiring.`,
        );
      }
    }

    if (holdings.tiyin.carry > 0) {
      reasons.push(
        `kuryerda taqsimlanmagan qoldiq bor (${this.formatSomAmount(holdings.tiyin.carry)} so'm) — hisob-kitob yakunlanmagan.`,
      );
    }

    if (holdings.orders_in_hand > 0) {
      const sample = this.formatHoldingsSample(
        holdings.orders_sample.map((row) => row.id),
        holdings.orders_in_hand,
      );
      reasons.push(
        `kuryer qo'lida ${holdings.orders_in_hand} ta yakunlanmagan buyurtma bor${sample} — avval ularni yetkazing yoki filialga qaytaring.`,
      );
    }

    if (holdings.open_return_posts > 0) {
      const sample = this.formatHoldingsSample(
        holdings.return_posts_sample.map((row) => row.id),
        holdings.open_return_posts,
      );
      reasons.push(
        `kuryer topshirgan ${holdings.open_return_posts} ta bekor qilingan pochta hali qabul qilinmagan${sample} — avval filial ularni qabul qilsin.`,
      );
    }

    if (holdings.pending_extra_cost_approvals > 0) {
      reasons.push(
        `kuryerning ${holdings.pending_extra_cost_approvals} ta qo'shimcha xarajat so'rovi hali ko'rib chiqilmagan.`,
      );
    }

    return reasons;
  }

  /**
   * Kuryerda pul yoki buyurtma bo'lsa — 409 (prefiks + sabablar). Manba javob
   * bermasa — 503 (`loadCourierHoldings`).
   *
   * C8 (CODE-06) — `closeNetZeroRows` (faqat o'tkazish va filialdan chiqarish):
   * kassa ham (sof qoldiq va naqd+karta), PENDING yig'indisi ham, qoldiq ham
   * aynan 0 tiyin, lekin PENDING qatorlar bor bo'lsa — ularni order-service
   * nol summali FIFO bilan yopishga BEST-EFFORT urinib ko'riladi va tekshiruv
   * QAYTA bajariladi. MONEY-02: kassa 0 va PENDING yig'indisi qoldiqqa AYNAN
   * teng bo'lsa ham (`isNetZeroPendingOnly`) — qatorlar qoldiq hisobidan
   * yopiladi. Bu qatorlar faqat musbat pul topshirishda yopilardi —
   * 0 so'm topshirib bo'lmaydi, kuryer abadiy bloklanardi. Yopish
   * muvaffaqiyatsiz bo'lsa — avvalgi 409 (to'siq hech qachon zaiflashmaydi).
   */
  private async assertCourierHoldsNothing(
    courierId: string,
    currentBranch: Branch | null,
    prefix: string,
    options: { closeNetZeroRows?: boolean; requester?: RequesterContext } = {},
  ): Promise<void> {
    let holdings = await this.loadCourierHoldings(courierId);
    if (options.closeNetZeroRows && this.isNetZeroPendingOnly(holdings)) {
      const maybeClosed = await this.closeNetZeroCourierRowsBestEffort(
        courierId,
        options.requester,
      );
      if (maybeClosed) {
        holdings = await this.loadCourierHoldings(courierId);
      }
    }
    const reasons = this.describeCourierHoldings(holdings, currentBranch);
    if (reasons.length) {
      this.conflict(prefix + reasons.join(' '));
    }
  }

  /**
   * Sof-nol PENDING: hisob-kitob qatorlari bor, kuryer kassasi (sof qoldiq
   * va naqd+karta) aynan 0 tiyin, qatorlar yig'indisi esa taqsimlanmagan
   * qoldiqqa AYNAN teng (tiyin):
   *   • ikkalasi 0 (C8);
   *   • yoki qoldiq musbat va qatorlarni to'liq qoplaydi (MONEY-02 —
   *     superadmin topshirilgan sotuvni qaytargach, kuryer uni AYNI summaga
   *     qayta sotgan: kassa 0, lekin 0 so'm topshirib bo'lmaydi).
   * Yakuniy qarorni order-service qoldiq QULFI ostida qayta tekshiradi
   * (mos kelmasa hech narsa yopilmaydi). SOF funksiya.
   */
  private isNetZeroPendingOnly(holdings: CourierHoldings): boolean {
    return (
      holdings.pending_settlement_count > 0 &&
      holdings.tiyin.balance === 0 &&
      holdings.tiyin.legs === 0 &&
      holdings.tiyin.carry >= 0 &&
      holdings.tiyin.pending === holdings.tiyin.carry
    );
  }

  /**
   * `order.settlement.close_zero_courier_rows` {courier_id, requester} →
   * {closed_count}. Xato, timeout, deploy paytida RPC yo'qligi — YUTILADI (faqat
   * log): bu to'siqni olib tashlashga urinish, natijani baribir qayta tekshiruv
   * hal qiladi. false — hech narsa o'zgarmagani aniq (xato yoki closed_count
   * 0); true — qatorlar yopilgan bo'lishi mumkin, qayta tekshirish kerak.
   */
  private async closeNetZeroCourierRowsBestEffort(
    courierId: string,
    requester?: RequesterContext,
  ): Promise<boolean> {
    try {
      const response = await lastValueFrom(
        this.orderClient
          .send<{
            data?: { closed_count?: unknown } | null;
            closed_count?: unknown;
          } | null>(
            { cmd: 'order.settlement.close_zero_courier_rows' },
            {
              courier_id: courierId,
              requester: {
                id: String(requester?.id ?? ''),
                roles: requester?.roles ?? [],
              },
            },
          )
          .pipe(timeout(COURIER_ZERO_ROWS_CLOSE_TIMEOUT_MS)),
      );
      const closedValue =
        response?.data?.closed_count ?? response?.closed_count;
      const closed =
        typeof closedValue === 'number' || typeof closedValue === 'string'
          ? Number(closedValue)
          : NaN;
      if (Number.isFinite(closed) && closed <= 0) {
        return false;
      }
      this.logger.log(
        `courier ${courierId}: net-zero PENDING rows closed (closed_count=${Number.isFinite(closed) ? closed : '?'})`,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `order.settlement.close_zero_courier_rows failed (courier=${courierId}) — ignored: ${this.describeRpcFailure(error)}`,
      );
      return false;
    }
  }

  /**
   * Filialdagi o'chirilmagan (is_deleted=false) MANAGER qatorlari egalari —
   * takrorsiz. Ularning identity'dagi holati bu yerda tekshirilmaydi.
   */
  private async findBranchManagerUserIds(branchId: string): Promise<string[]> {
    const rows =
      (await this.branchUserRepo.find({
        where: {
          branch_id: branchId,
          role: BranchUserRole.MANAGER,
          isDeleted: false,
        },
        select: ['user_id'],
      })) ?? [];
    return Array.from(
      new Set(
        rows.map((row) => String(row.user_id ?? '').trim()).filter(Boolean),
      ),
    );
  }

  /**
   * Identity'dagi FAOL menejer: o'chirilmagan, roli manager, statusi active.
   * Identity filtrlari javobda ham qayta tekshiriladi.
   */
  private isActiveManagerUser(
    user: Record<string, unknown> | null | undefined,
  ) {
    return (
      Boolean(user) &&
      String((user?.role ?? '') as string)
        .trim()
        .toLowerCase() === String(Roles.MANAGER) &&
      String((user?.status ?? '') as string)
        .trim()
        .toLowerCase() === String(Status.ACTIVE) &&
      user?.isDeleted !== true
    );
  }

  /**
   * `managerUserIds` dan nechtasi identity'da FAOL menejer. Xato, timeout yoki
   * buzuq javob — throw (chaqiruvchi 503 ga o'raydi: "bilmasak — yo'q demaymiz").
   * Identity sahifani 100 bilan cheklaydi — 100 talik bo'laklar.
   */
  private async countActiveManagers(managerUserIds: string[]): Promise<number> {
    const requested = new Set(managerUserIds);
    const activeIds = new Set<string>();
    const chunkSize = 100;
    for (let offset = 0; offset < managerUserIds.length; offset += chunkSize) {
      const response = await lastValueFrom(
        this.identityClient
          .send<{ data?: { items?: unknown } | null }>(
            { cmd: 'identity.user.find_all' },
            {
              query: {
                user_ids: managerUserIds.slice(offset, offset + chunkSize),
                role: Roles.MANAGER,
                status: Status.ACTIVE,
                page: 1,
                limit: chunkSize,
              },
            },
          )
          .pipe(timeout(COURIER_TARGET_MANAGER_RPC_TIMEOUT_MS)),
      );
      const items = response?.data?.items;
      if (!Array.isArray(items)) {
        throw new Error('identity.user.find_all: items massiv emas');
      }
      for (const user of items as Array<Record<string, unknown> | null>) {
        const id = String((user?.id ?? '') as string).trim();
        if (requested.has(id) && this.isActiveManagerUser(user)) {
          activeIds.add(id);
        }
      }
    }
    return activeIds.size;
  }

  /**
   * Maqsad filialda kuryer pulini QONUNIY qabul qila oladigan FAOL menejer
   * bormi. branch_users qatorining o'zi yetarli emas: identity `deleteUser`
   * qatorni o'chirmaydi, bloklash esa faqat statusni o'zgartiradi — o'chirilgan
   * yoki bloklangan menejerning qatori qolib ketadi, u esa tizimga kira olmaydi.
   *
   * `getUsersByIdsBatch` ATAYLAB ishlatilmaydi: u ro'yxat ekranlari uchun
   * xatoni yutadi. Bu yerda (`countActiveManagers`) har qanday xato yoki
   * buzuq javob — 503 (fail-closed), aks holda identity ishlamay qolganda
   * soxta "faol menejer yo'q" (400) chiqardi. Identity filtrlari (role,
   * status, user_ids) javobda ham qayta tekshiriladi.
   */
  private async assertTransferTargetHasActiveManager(
    target: Branch,
    managerUserIds: string[],
  ): Promise<void> {
    let activeManagers: number;
    try {
      activeManagers = await this.countActiveManagers(managerUserIds);
    } catch (error) {
      this.logger.warn(
        `courier transfer target manager check failed (branch=${String(target.id)}): ${this.describeRpcFailure(error)}`,
      );
      throw new RpcException(errorRes(COURIER_CHECK_UNAVAILABLE_MESSAGE, 503));
    }
    if (!activeManagers) {
      this.badRequest(
        `'${target.name}' filialida faol menejer yo'q — kuryer pulini qabul qiladigan odam bo'lmaydi. Avval filialga menejer biriktiring`,
      );
    }
  }

  /**
   * Foydalanuvchi mavjud va KURYER. 404 → 'Kuryer topilmadi'; identity javob
   * bermasa — 503 (fail-closed); boshqa rol — 400. Identity'dagi hududi ham
   * qaytadi (kuryer hududi filialga ergashadi).
   */
  private async assertIsCourierUser(
    userId: string,
  ): Promise<{ id: string; region_id: string | null }> {
    let user: { id: string; role?: string | null; region_id?: string | null };
    try {
      user = await this.ensureUserExists(userId);
    } catch (error) {
      if (this.isRpcNotFound(error)) {
        this.notFound(COURIER_NOT_FOUND_MESSAGE);
      }
      this.logger.warn(
        `courier identity lookup failed (user=${userId}): ${this.describeRpcFailure(error)}`,
      );
      throw new RpcException(errorRes(COURIER_CHECK_UNAVAILABLE_MESSAGE, 503));
    }
    if (
      String(user.role ?? '')
        .trim()
        .toLowerCase() !== String(Roles.COURIER)
    ) {
      this.badRequest(COURIER_NOT_A_COURIER_MESSAGE);
    }
    return { id: user.id, region_id: user.region_id ?? null };
  }

  /** `findHqBranch` bilan bir xil qidiruv — lekin 404 o'rniga null. */
  private async findHqBranchRow(): Promise<Branch | null> {
    const byCode = await this.branchRepo.findOne({
      where: { code: this.hqCode, isDeleted: false },
    });
    if (byCode) {
      return byCode;
    }
    return (
      (await this.branchRepo.findOne({
        where: { type: BranchType.HQ, isDeleted: false },
      })) ?? null
    );
  }

  /** Foydalanuvchining faol branch_users qatori (qisman unique indeks: ≤1). */
  private async findActiveBranchUserRow(
    userId: string,
  ): Promise<BranchUser | null> {
    return (
      (await this.branchUserRepo.findOne({
        where: { user_id: userId, isDeleted: false },
        order: { createdAt: 'DESC' },
      })) ?? null
    );
  }

  /** Faol qator filiali (o'chirilgan filial — null, ya'ni "filialsiz"). */
  private async findBranchOfRow(
    row: BranchUser | null,
  ): Promise<Branch | null> {
    if (!row) {
      return null;
    }
    return (
      (await this.branchRepo.findOne({
        where: { id: String(row.branch_id), isDeleted: false },
      })) ?? null
    );
  }

  /**
   * FAQAT pochtani filialga jo'natish (dispatchPostToBranch) uchun ruxsat.
   *
   * - superadmin/admin — o'tadi;
   * - qolganlar — MANBA filialda (HQ) faol REGISTRATOR qatori bo'lishi shart,
   *   aks holda 403. MANAGER qatori ham 403: HQ'da menejer bo'lmaydi (C8), eski
   *   qator qolib ketgan bo'lsa ham u orqali jo'natib bo'lmaydi.
   *
   * ⚠️ resolveAccessScope / assertCanWriteBranch ATAYLAB kengaytirilmaydi: ular
   * filialni tahrirlash/o'chirish, xodim biriktirish/chiqarish va config
   * yozishni ham himoya qiladi — registratorga bular ochilib qolmasligi kerak.
   */
  private async assertCanDispatchPostFromBranch(
    sourceBranchId: string,
    requester?: RequesterContext,
  ): Promise<void> {
    if (this.isSystemPrivileged(requester)) {
      return;
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const assignments = await this.branchUserRepo.find({
      where: {
        user_id: requesterId,
        branch_id: String(sourceBranchId),
        isDeleted: false,
      },
      select: ['branch_id', 'role'],
    });

    const canDispatch = assignments.some(
      (item) =>
        String(item.branch_id) === String(sourceBranchId) &&
        this.isBranchUserRoleOneOf(item.role, [BranchUserRole.REGISTRATOR]),
    );
    if (!canDispatch) {
      this.forbidden("Bu filialdan pochta jo'natishga ruxsat yo'q");
    }
  }

  /**
   * Kuryer havolasi bormi. Bo'sh/null va '0' — kuryer yo'q: logistics
   * kuryersiz (HQ/filial) pochtani `courier_id = '0'` bilan yaratadi.
   */
  private hasCourierRef(value: unknown): boolean {
    const normalized = String((value ?? '') as string).trim();
    return normalized !== '' && !/^0+$/.test(normalized);
  }

  /** Raqamli id'ni kanonik ko'rinishga keltiradi ('0900' → '900'). */
  private canonicalId(value: unknown): string {
    const normalized = String((value ?? '') as string).trim();
    return /^\d+$/.test(normalized)
      ? BigInt(normalized).toString()
      : normalized;
  }

  /** Buyurtma id'lari xabar uchun: "#1, #2 … (+N ta)". */
  private formatOrderIdsForMessage(orderIds: string[]): string {
    const shown = orderIds
      .slice(0, DISPATCH_MESSAGE_ORDER_ID_LIMIT)
      .map((id) => `#${id}`)
      .join(', ');
    const rest = orderIds.length - DISPATCH_MESSAGE_ORDER_ID_LIMIT;
    return rest > 0 ? `${shown} (+${rest} ta)` : shown;
  }

  /**
   * Filialga faqat HQ'da yig'ilgan, hali hech kimga berilmagan pochta
   * jo'natiladi: holati 'new' va kuryer biriktirilmagan. Kuryer pochtasi yoki
   * allaqachon jo'natilgan/qabul qilingan pochta BUTUN so'rov bilan 400 —
   * superadmin/admin uchun ham (kuryerdagi pochtani filialga "ko'chirish"
   * hech qachon to'g'ri emas). Buyurtmalar o'qilishidan va hech narsa
   * ko'chirilishidan OLDIN tekshiriladi.
   *
   * `logistics.post.find_by_ids` — faqat o'qish: `find_by_id`/`orders_by_post`
   * dan farqli, pochtaning branch_id'sini qayta yozmaydi. Doira (scope)
   * tekshiruvi keyingi `orders_by_post` chaqiruvida saqlanadi.
   */
  private async assertPostCanBeDispatched(
    postId: string,
    context: { source_branch_id: string; destination_branch_id: string },
  ): Promise<Record<string, unknown>> {
    const postsResponse = await this.sendLogisticsCommand<{
      data?: Array<Record<string, unknown>>;
    }>('logistics.post.find_by_ids', { ids: [postId] });

    const posts = Array.isArray(postsResponse?.data) ? postsResponse.data : [];
    const targetPostId = this.canonicalId(postId);
    const post = posts.find(
      (row) => this.canonicalId(row?.id) === targetPostId,
    );
    if (!post) {
      this.notFound(`Pochta #${postId} topilmadi`);
    }

    const courierId = String((post.courier_id ?? '') as string).trim();
    if (this.hasCourierRef(courierId)) {
      throw new RpcException(
        errorRes(
          `Pochta #${postId} kuryerga biriktirilgan (kuryer #${courierId}) — kuryer pochtasini filialga jo'natib bo'lmaydi`,
          400,
          {
            post_id: postId,
            ...context,
            post_courier_id: courierId,
            reasons: { post_has_courier: true },
          },
        ),
      );
    }

    const postStatus = String((post.status ?? '') as string)
      .trim()
      .toLowerCase();
    if (postStatus !== Post_status.NEW) {
      throw new RpcException(
        errorRes(
          `Pochta #${postId} holati "${postStatus || "noma'lum"}" — filialga faqat yangi ('new') holatdagi HQ pochtasi jo'natiladi`,
          400,
          {
            post_id: postId,
            ...context,
            post_status: postStatus || null,
            reasons: { post_status_not_new: true },
          },
        ),
      );
    }
    return post;
  }

  /**
   * Jo'natish uchun filiallar ro'yxati (branch.dispatch_destinations) ruxsati:
   * superadmin/admin yoki HQ filialida faol REGISTRATOR qatori bor foydalanuvchi.
   * Qolganlar — 403.
   */
  private async assertCanListDispatchDestinations(
    requester?: RequesterContext,
  ): Promise<void> {
    if (this.isSystemPrivileged(requester)) {
      return;
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const assignments = await this.branchUserRepo.find({
      where: { user_id: requesterId, isDeleted: false },
      select: ['branch_id', 'role'],
    });
    const registratorBranchIds = Array.from(
      new Set(
        assignments
          .filter((item) =>
            this.isBranchUserRoleOneOf(item.role, [BranchUserRole.REGISTRATOR]),
          )
          .map((item) => String(item.branch_id ?? '').trim())
          .filter(Boolean),
      ),
    );

    const hqBranch = registratorBranchIds.length
      ? await this.branchRepo.findOne({
          where: {
            id: In(registratorBranchIds),
            type: BranchType.HQ,
            isDeleted: false,
          },
          select: ['id'],
        })
      : null;
    if (!hqBranch) {
      this.forbidden(
        "Jo'natish uchun filiallar ro'yxatini faqat superadmin, admin yoki HQ registratori ko'ra oladi",
      );
    }
  }

  /**
   * Pochta faqat FAOL REGIONAL yoki HYBRID filialga jo'natiladi:
   * - manba filialning o'ziga — yo'q;
   * - HQ'ga — yo'q (pochta HQ'dan chiqadi);
   * - PICKUP'ga — yo'q: PICKUP pochtani qabul qila olmaydi (menejerida 'mails'
   *   imkoniyati yo'q, batch ham qabul qilmaydi) — buyurtmalar u yerda qotib
   *   qoladi.
   */
  private assertValidDispatchDestination(
    sourceBranch: Branch,
    destinationBranch: Branch,
  ): void {
    if (String(destinationBranch.id) === String(sourceBranch.id)) {
      this.badRequest(
        "Pochtani manba filialning o'ziga jo'natib bo'lmaydi — boshqa filialni tanlang",
      );
    }
    if (destinationBranch.status !== Status.ACTIVE) {
      this.badRequest(
        "Manzil filial faol emas — nofaol filialga pochta jo'natib bo'lmaydi",
      );
    }
    if (
      destinationBranch.type !== BranchType.REGIONAL &&
      destinationBranch.type !== BranchType.HYBRID
    ) {
      this.badRequest(
        `Pochta faqat REGIONAL yoki HYBRID filialga jo'natiladi (manzil filial turi: ${destinationBranch.type})`,
      );
    }
  }

  private assertBranchCanCreateBatches(
    branch: Branch,
    operation: 'transfer' | 'return',
  ) {
    if (branch.type === BranchType.REGIONAL) {
      this.forbidden(
        operation === 'return'
          ? 'REGIONAL filial return batch yarata olmaydi'
          : 'REGIONAL filial transfer batch yarata olmaydi',
      );
    }
  }

  private assertBranchCanReceiveBatches(branch: Branch) {
    if (branch.type === BranchType.PICKUP) {
      this.forbidden(
        'PICKUP filial boshqa filialdan kelgan batchni qabul qila olmaydi',
      );
    }
  }

  /**
   * Boshqa servis xatosini `{statusCode, message}` ga keltiradi (C12/CODE-13).
   *
   * RabbitMQ orqali kelgan rad javobi hech qachon RpcException nusxasi emas —
   * u oddiy `{statusCode, message, data}` obyekti (YUQORI darajada). Ilgari
   * faqat ichki `error.statusCode` o'qilardi, shuning uchun boshqa servisning
   * haqiqiy 400/403/404/409 javobi mijozga 500 bo'lib borardi. Endi:
   *   - RpcException (shu servis ichida otilgan) — `getError()`;
   *   - yuqori darajadagi yoki ichki (`error`) statusCode — faqat 400..599;
   *   - timeout, mahalliy `Error` (ulanish uzildi va h.k.) va statusCode'siz
   *     javob (masalan "no matching message handler") — null: chaqiruvchi
   *     o'zining "xizmati javob bermadi" (502) xabarini beradi.
   */
  private extractRpcError(
    error: unknown,
  ): { statusCode: number; message: string } | null {
    if (error instanceof TimeoutError) {
      return null;
    }
    const source: unknown =
      error instanceof RpcException ? error.getError() : error;
    if (!source || typeof source !== 'object' || source instanceof Error) {
      return null;
    }

    const toMessage = (value: unknown): string =>
      Array.isArray(value)
        ? value
            .map((item) => String(item as string))
            .join('. ')
            .trim()
        : typeof value === 'string'
          ? value.trim()
          : '';
    const toStatus = (value: unknown): number | null => {
      const status = Number(value);
      return Number.isInteger(status) && status >= 400 && status <= 599
        ? status
        : null;
    };

    const top = source as {
      statusCode?: unknown;
      message?: unknown;
      error?: unknown;
    };
    const nested =
      top.error && typeof top.error === 'object'
        ? (top.error as { statusCode?: unknown; message?: unknown })
        : null;

    const statusCode = toStatus(nested?.statusCode) ?? toStatus(top.statusCode);
    const message = toMessage(nested?.message) || toMessage(top.message);
    if (statusCode && message) {
      return { statusCode, message };
    }
    return null;
  }

  private async sendOrderCommand<T>(
    cmd: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await lastValueFrom(
        this.orderClient.send<T>({ cmd }, payload).pipe(timeout(15000)),
      );
    } catch (error) {
      const parsed = this.extractRpcError(error);
      if (parsed) {
        throw new RpcException(errorRes(parsed.message, parsed.statusCode));
      }
      throw new RpcException(errorRes(ORDER_SERVICE_UNAVAILABLE_MESSAGE, 502));
    }
  }

  private async sendLogisticsCommand<T>(
    cmd: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await lastValueFrom(
        this.logisticsClient.send<T>({ cmd }, payload).pipe(timeout(15000)),
      );
    } catch (error) {
      const parsed = this.extractRpcError(error);
      if (parsed) {
        throw new RpcException(errorRes(parsed.message, parsed.statusCode));
      }
      throw new RpcException(
        errorRes(LOGISTICS_SERVICE_UNAVAILABLE_MESSAGE, 502),
      );
    }
  }

  private async sendFileCommand<T>(
    cmd: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await lastValueFrom(
        this.fileClient.send<T>({ cmd }, payload).pipe(timeout(15000)),
      );
    } catch {
      throw new RpcException(errorRes(FILE_SERVICE_UNAVAILABLE_MESSAGE, 502));
    }
  }

  private async sendFinanceCommand<T>(
    cmd: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await lastValueFrom(
        this.financeClient.send<T>({ cmd }, payload).pipe(timeout(15000)),
      );
    } catch (error) {
      const parsed = this.extractRpcError(error);
      if (parsed) {
        throw new RpcException(errorRes(parsed.message, parsed.statusCode));
      }
      throw new RpcException(
        errorRes(FINANCE_SERVICE_UNAVAILABLE_MESSAGE, 502),
      );
    }
  }

  private async ensureBranchCashbox(branchId: string): Promise<void> {
    try {
      await this.sendFinanceCommand('finance.cashbox.create', {
        user_id: branchId,
        cashbox_type: Cashbox_type.BRANCH,
      });
    } catch (error) {
      const parsed = this.extractRpcError(error);
      if (parsed?.message?.includes('Cashbox already exists')) {
        return;
      }
      throw error;
    }
  }

  async createTransferBatches(
    branchId: string | undefined,
    dto: {
      orderIds?: string[];
      order_ids?: string[];
    },
    requester?: RequesterContext,
  ) {
    let sourceBranchId = String(branchId ?? '').trim();
    if (!sourceBranchId) {
      sourceBranchId =
        await this.resolveRequesterBranchIdForTransfer(requester);
    }

    const sourceBranch = await this.getBranchOrThrow(sourceBranchId);
    this.assertBranchCanCreateBatches(sourceBranch, 'transfer');
    const destinationBranchId = String(sourceBranch.parent_id ?? '').trim();
    if (!destinationBranchId) {
      this.badRequest('Manba filialning ota filiali topilmadi');
    }

    await this.getBranchOrThrow(destinationBranchId);
    await this.assertCanCreateTransferBatch(sourceBranchId, requester);

    const orderIds = Array.from(
      new Set(
        (dto?.orderIds ?? dto?.order_ids ?? [])
          .map((id) => String(id ?? '').trim())
          .filter(Boolean),
      ),
    );
    if (!orderIds.length) {
      this.badRequest(ORDER_IDS_REQUIRED_MESSAGE);
    }

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const requestKey = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const createRes = await this.sendOrderCommand<{
      statusCode?: number;
      data?: { idempotent?: boolean; batches?: Array<Record<string, any>> };
      message?: string;
    }>('order.transfer_batch.create', {
      source_branch_id: sourceBranchId,
      destination_branch_id: destinationBranchId,
      direction: BranchTransferDirection.FORWARD,
      request_key: requestKey,
      requester_id: requesterId,
      order_ids: orderIds,
    });

    const createdBatches = Array.isArray(createRes?.data?.batches)
      ? createRes.data.batches
      : [];
    const batchIds = createdBatches.map((batch) => String(batch.id));

    if (createRes?.data?.idempotent) {
      return successRes(
        {
          idempotent: true,
          batches: createdBatches,
        },
        200,
        'Transfer batches already exist for this request key',
      );
    }

    const qrFiles: Array<{ batch_id: string; key: string; url: string }> = [];
    const qrErrors: Array<{ batch_id: string; message: string }> = [];
    for (const batch of createdBatches) {
      const batchId = String(batch.id);
      const token = String(batch?.qr_code_token ?? '').trim();
      if (!token) {
        qrErrors.push({
          batch_id: batchId,
          message: 'QR token missing for created batch',
        });
        continue;
      }

      try {
        const qrResponse = await this.sendFileCommand<{
          data?: { key?: string; url?: string };
        }>('file.generate_qr', {
          text: token,
          file_name: `${token}.png`,
          folder: 'branch-transfer-batches',
        });

        await this.sendOrderCommand('order.transfer_batch.history.add', {
          batch_id: batchId,
          user_id: requesterId,
          action: 'CREATED',
          notes: '[STEP] QR_GENERATED',
        });

        qrFiles.push({
          batch_id: batchId,
          key: String(qrResponse?.data?.key ?? ''),
          url: String(qrResponse?.data?.url ?? ''),
        });
      } catch (error) {
        const parsed = this.extractRpcError(error);
        const message =
          parsed?.message ??
          (error instanceof Error ? error.message : 'QR generation failed');
        qrErrors.push({ batch_id: batchId, message });
        try {
          await this.sendOrderCommand('order.transfer_batch.history.add', {
            batch_id: batchId,
            user_id: requesterId,
            action: 'CREATED',
            notes: `[WARN] QR_GENERATION_FAILED: ${message}`,
          });
        } catch {
          // Batch creation must not fail only because warning history failed.
        }
      }
    }

    const qrByBatchId = new Map(qrFiles.map((item) => [item.batch_id, item]));
    const enriched = createdBatches.map((batch) => ({
      ...batch,
      qr_file: qrByBatchId.get(String(batch.id)) ?? null,
    }));

    await this.activityLog.log({
      entity_type: 'TransferBatch',
      entity_id: String(batchIds[0] ?? sourceBranchId),
      action: 'branch.transfer_batch_create',
      metadata: {
        source_branch_id: sourceBranchId,
        destination_branch_id: destinationBranchId,
        order_count: orderIds.length,
        order_ids: orderIds.slice(0, 20),
        batch_ids: batchIds,
        qr_generation_errors: qrErrors,
      },
      ...this.auditActor(requester),
    });

    return successRes(
      {
        idempotent: false,
        batches: enriched,
        qr_generation_errors: qrErrors,
      },
      201,
      qrErrors.length
        ? 'Transfer batches created, but QR file generation failed'
        : 'Transfer batches created',
    );
  }

  private async resolveRequesterBranchIdForTransfer(
    requester?: RequesterContext,
  ): Promise<string> {
    if (this.isSystemPrivileged(requester)) {
      this.badRequest('Manba filial (id) majburiy');
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const assignment = await this.branchUserRepo.findOne({
      where: { user_id: requesterId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });

    if (!assignment?.branch_id) {
      this.forbidden('Foydalanuvchi hech qaysi filialga biriktirilmagan');
    }

    const role = this.normalizeBranchUserRole(assignment.role);
    if (
      role !== BranchUserRole.MANAGER &&
      role !== BranchUserRole.REGISTRATOR
    ) {
      this.forbidden('Transfer batch yaratishga ruxsat yo‘q');
    }

    return String(assignment.branch_id);
  }

  async createReturnBatches(
    branchId: string,
    dto: {
      order_ids?: string[];
      request_key?: string;
      notes?: string | null;
    },
    requester?: RequesterContext,
  ) {
    const sourceBranchId = String(branchId ?? '').trim();
    if (!sourceBranchId) {
      this.badRequest('Manba filial (id) majburiy');
    }

    const sourceBranch = await this.getBranchOrThrow(sourceBranchId);
    this.assertBranchCanCreateBatches(sourceBranch, 'return');
    await this.assertCanCreateTransferBatch(sourceBranchId, requester);

    const orderIds = Array.from(
      new Set(
        (dto?.order_ids ?? [])
          .map((id) => String(id ?? '').trim())
          .filter(Boolean),
      ),
    );
    if (!orderIds.length) {
      this.badRequest(ORDER_IDS_REQUIRED_MESSAGE);
    }

    const requestKey = this.normalizeTransferRequestKey(dto?.request_key);
    const requesterId = String(requester?.id ?? '').trim() || '0';

    const createRes = await this.sendOrderCommand<{
      data?: { idempotent?: boolean; batches?: Array<Record<string, any>> };
    }>('order.transfer_batch.create_return', {
      source_branch_id: sourceBranchId,
      order_ids: orderIds,
      request_key: requestKey,
      requester_id: requesterId,
      notes: dto?.notes ?? null,
    });

    const createdBatches = Array.isArray(createRes?.data?.batches)
      ? createRes.data.batches
      : [];
    const batchIds = createdBatches.map((batch) => String(batch.id));

    if (createRes?.data?.idempotent) {
      return successRes(
        {
          idempotent: true,
          batches: createdBatches,
        },
        200,
        'Return batches already exist for this request key',
      );
    }

    const qrFiles: Array<{ batch_id: string; key: string; url: string }> = [];
    const qrErrors: Array<{ batch_id: string; message: string }> = [];
    for (const batch of createdBatches) {
      const batchId = String(batch.id);
      const token = String(batch?.qr_code_token ?? '').trim();
      if (!token) {
        qrErrors.push({
          batch_id: batchId,
          message: 'QR token missing for created batch',
        });
        continue;
      }

      try {
        const qrResponse = await this.sendFileCommand<{
          data?: { key?: string; url?: string };
        }>('file.generate_qr', {
          text: token,
          file_name: `${token}.png`,
          folder: 'branch-transfer-batches',
        });

        await this.sendOrderCommand('order.transfer_batch.history.add', {
          batch_id: batchId,
          user_id: requesterId,
          action: 'CREATED',
          notes: '[STEP] QR_GENERATED',
        });

        qrFiles.push({
          batch_id: batchId,
          key: String(qrResponse?.data?.key ?? ''),
          url: String(qrResponse?.data?.url ?? ''),
        });
      } catch (error) {
        const parsed = this.extractRpcError(error);
        const message =
          parsed?.message ??
          (error instanceof Error ? error.message : 'QR generation failed');
        qrErrors.push({ batch_id: batchId, message });
        try {
          await this.sendOrderCommand('order.transfer_batch.history.add', {
            batch_id: batchId,
            user_id: requesterId,
            action: 'CREATED',
            notes: `[WARN] QR_GENERATION_FAILED: ${message}`,
          });
        } catch {
          // Batch creation must not fail only because warning history failed.
        }
      }
    }

    const qrByBatchId = new Map(qrFiles.map((item) => [item.batch_id, item]));
    const enriched = createdBatches.map((batch) => ({
      ...batch,
      qr_file: qrByBatchId.get(String(batch.id)) ?? null,
    }));

    await this.activityLog.log({
      entity_type: 'TransferBatch',
      entity_id: String(batchIds[0] ?? sourceBranchId),
      action: 'branch.return_batch_create',
      metadata: {
        source_branch_id: sourceBranchId,
        order_count: orderIds.length,
        order_ids: orderIds.slice(0, 20),
        batch_ids: batchIds,
        qr_generation_errors: qrErrors,
      },
      ...this.auditActor(requester),
    });

    return successRes(
      {
        idempotent: false,
        batches: enriched,
        qr_generation_errors: qrErrors,
      },
      201,
      qrErrors.length
        ? 'Return batches created, but QR file generation failed'
        : 'Return batches created',
    );
  }

  async sendTransferBatch(
    batchId: string,
    dto: {
      orderIds?: string[];
      order_ids?: string[];
      vehicle_plate?: string;
      driver_name?: string;
      driver_phone?: string;
    },
    requester?: RequesterContext,
  ) {
    const id = String(batchId ?? '').trim();
    if (!id) {
      this.badRequest('Partiya (batch) id majburiy');
    }

    const orderIds = Array.from(
      new Set(
        (dto?.orderIds ?? dto?.order_ids ?? [])
          .map((value) => String(value ?? '').trim())
          .filter(Boolean),
      ),
    );
    if (!orderIds.length) {
      this.badRequest(ORDER_IDS_REQUIRED_MESSAGE);
    }

    const vehiclePlate = String(dto?.vehicle_plate ?? 'N/A').trim() || 'N/A';
    const driverName = String(dto?.driver_name ?? 'N/A').trim() || 'N/A';
    const driverPhone =
      String(dto?.driver_phone ?? '+998000000000').trim() || '+998000000000';

    const batchRes = await this.sendOrderCommand<{
      data?: { source_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id });
    const sourceBranchId = String(
      batchRes?.data?.source_branch_id ?? '',
    ).trim();
    if (!sourceBranchId) {
      this.notFound('Partiya (transfer batch) topilmadi');
    }

    await this.assertCanCreateTransferBatch(sourceBranchId, requester);

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const sendResult = await this.sendOrderCommand(
      'order.transfer_batch.send',
      {
        batch_id: id,
        order_ids: orderIds,
        vehicle_plate: vehiclePlate,
        driver_name: driverName,
        driver_phone: driverPhone,
        requester_id: requesterId,
        requester_name: requesterId,
        requester_roles: requester?.roles ?? [],
      },
    );

    await this.activityLog.log({
      entity_type: 'TransferBatch',
      entity_id: String(id),
      action: ActivityAction.STATUS_CHANGE,
      metadata: {
        status: 'SENT',
        source_branch_id: sourceBranchId,
        order_count: orderIds.length,
        order_ids: orderIds.slice(0, 20),
      },
      ...this.auditActor(requester),
    });

    return sendResult;
  }

  async findRemainingTransferBatchById(
    id: string,
    requester?: RequesterContext,
  ) {
    const batchId = String(id ?? '').trim();
    if (!batchId) {
      this.badRequest('Partiya (batch) id majburiy');
    }

    const response = await this.sendOrderCommand<{
      data?: { source_branch_id?: string; destination_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id: batchId });

    const sourceBranchId = String(
      response?.data?.source_branch_id ?? '',
    ).trim();
    const destinationBranchId = String(
      response?.data?.destination_branch_id ?? '',
    ).trim();

    if (sourceBranchId && destinationBranchId) {
      try {
        await this.assertCanReadBranch(sourceBranchId, requester);
      } catch {
        await this.assertCanReadBranch(destinationBranchId, requester);
      }
    } else if (sourceBranchId) {
      await this.assertCanReadBranch(sourceBranchId, requester);
    } else if (destinationBranchId) {
      await this.assertCanReadBranch(destinationBranchId, requester);
    }

    const remainingResponse = await this.sendOrderCommand<{
      data?: Record<string, unknown>;
    }>('order.transfer_batch.find_remaining', { id: batchId });

    const batchData = (remainingResponse as { data?: Record<string, unknown> })
      ?.data;
    if (!batchData || typeof batchData !== 'object') {
      return remainingResponse;
    }

    const batchRecord = batchData;
    const regionId = String(
      (batchRecord?.target_region_id ?? '') as string,
    ).trim();
    const regionMap = await this.getRegionsByIds(regionId ? [regionId] : []);
    const rawItems = Array.isArray(batchRecord?.items)
      ? (batchRecord.items as Array<Record<string, unknown>>)
      : [];

    const enrichedItems = await Promise.all(
      rawItems.map(async (item) => {
        const orderId = String((item?.order_id ?? '') as string).trim();
        if (!orderId) {
          return { ...item, order: null };
        }

        try {
          const orderRes = await this.sendOrderCommand<{
            data?: Record<string, unknown>;
          }>('order.find_by_id_enriched', { id: orderId });
          return {
            ...item,
            order:
              (orderRes as { data?: Record<string, unknown> })?.data ??
              orderRes ??
              null,
          };
        } catch {
          return {
            ...item,
            order: null,
          };
        }
      }),
    );

    return {
      ...batchRecord,
      items: enrichedItems,
      region: regionId ? (regionMap.get(regionId) ?? null) : null,
    };
  }

  async findTransferBatches(
    query: {
      source_branch_id?: string;
      destination_branch_id?: string;
      status?: string;
      direction?: string;
      period?: string;
      date?: string;
      page?: number;
      limit?: number;
    },
    requester?: RequesterContext,
  ) {
    const sourceBranchId = String(query?.source_branch_id ?? '').trim();
    const destinationBranchId = String(
      query?.destination_branch_id ?? '',
    ).trim();

    if (sourceBranchId) {
      await this.assertCanReadBranch(sourceBranchId, requester);
    }
    if (destinationBranchId) {
      await this.assertCanReadBranch(destinationBranchId, requester);
    }

    if (
      !this.isSystemPrivileged(requester) &&
      !sourceBranchId &&
      !destinationBranchId
    ) {
      const requesterId = String(requester?.id ?? '').trim();
      if (!requesterId) {
        this.forbidden('Requester aniqlanmadi');
      }

      const assignment = await this.branchUserRepo.findOne({
        where: { user_id: requesterId, isDeleted: false },
        order: { createdAt: 'DESC' },
      });

      if (!assignment) {
        this.forbidden('Filial biriktirilmagan foydalanuvchi');
      }

      const direction = String(query?.direction ?? '')
        .trim()
        .toUpperCase();
      const assignmentBranchId = String(assignment.branch_id);
      const scopedSourceBranchId =
        direction === BranchTransferDirection.RETURN
          ? undefined
          : assignmentBranchId;
      const scopedDestinationBranchId =
        direction === BranchTransferDirection.RETURN
          ? assignmentBranchId
          : undefined;

      const response = await this.sendOrderCommand(
        'order.transfer_batch.find_all',
        {
          source_branch_id: scopedSourceBranchId,
          destination_branch_id: scopedDestinationBranchId,
          status: query?.status,
          direction: query?.direction,
          period: query?.period,
          date: query?.date,
          page: query?.page,
          limit: query?.limit,
        },
      );
      return this.attachRegionsToTransferBatches(response);
    }

    const response = await this.sendOrderCommand(
      'order.transfer_batch.find_all',
      {
        source_branch_id: sourceBranchId || undefined,
        destination_branch_id: destinationBranchId || undefined,
        status: query?.status,
        direction: query?.direction,
        period: query?.period,
        date: query?.date,
        page: query?.page,
        limit: query?.limit,
      },
    );
    return this.attachRegionsToTransferBatches(response);
  }

  async findBranchesWithSentBatches(
    query: {
      direction?: string;
      side?: string;
    },
    requester?: RequesterContext,
  ) {
    const response = await this.sendOrderCommand<{
      data?: {
        side?: 'source' | 'destination';
        direction?: string;
        items?: Array<{
          branch_id?: string;
          sent_batches_count?: number | string;
          sent_total_price?: number | string;
        }>;
      };
    }>('order.transfer_batch.find_branches_with_sent', {
      direction: query?.direction,
      side: query?.side,
    });

    const sideRaw = String(response?.data?.side ?? 'source').toLowerCase();
    const side: 'source' | 'destination' =
      sideRaw === 'destination' ? 'destination' : 'source';
    const aggregates = (response?.data?.items ?? [])
      .map((row) => ({
        branch_id: String(row?.branch_id ?? '').trim(),
        sent_batches_count: Number(row?.sent_batches_count ?? 0),
        sent_total_price: Number(row?.sent_total_price ?? 0),
      }))
      .filter((row) => Boolean(row.branch_id));
    const branchIds = Array.from(
      new Set(aggregates.map((row) => row.branch_id)),
    );

    if (!branchIds.length) {
      return successRes(
        { side, direction: response?.data?.direction, items: [] },
        200,
        'Branches with sent transfer batches found',
      );
    }

    const rows = await this.branchRepo.find({
      where: { id: In(branchIds), isDeleted: false },
      order: { name: 'ASC' },
    });
    const aggregateByBranchId = new Map(
      aggregates.map((row) => [row.branch_id, row]),
    );

    const canRead = async (branchId: string) => {
      try {
        await this.assertCanReadBranch(branchId, requester);
        return true;
      } catch {
        return false;
      }
    };

    const visible: Array<{
      id: string;
      name: string;
      phone_number: string | null;
      sent_batches_count: number;
      sent_total_price: number;
    }> = [];
    for (const row of rows) {
      if (await canRead(String(row.id))) {
        const aggregate = aggregateByBranchId.get(String(row.id));
        visible.push({
          id: String(row.id),
          name: row.name,
          phone_number: row.phone_number ?? null,
          sent_batches_count: Number(aggregate?.sent_batches_count ?? 0),
          sent_total_price: Number(aggregate?.sent_total_price ?? 0),
        });
      }
    }

    return successRes(
      {
        side,
        direction: response?.data?.direction,
        items: visible,
      },
      200,
      'Branches with sent transfer batches found',
    );
  }

  private async attachRegionsToTransferBatches(response: any) {
    const items = Array.isArray(response?.data?.items)
      ? response.data.items
      : [];
    if (!items.length) {
      return response;
    }

    const regionIds: string[] = Array.from(
      new Set(
        items
          .map((batch: Record<string, unknown>) =>
            String((batch?.target_region_id ?? '') as string).trim(),
          )
          .filter(Boolean),
      ),
    );

    const regionMap = await this.getRegionsByIds(regionIds);
    const enrichedItems = items.map((batch: Record<string, unknown>) => {
      const regionId = String((batch?.target_region_id ?? '') as string).trim();
      return {
        ...batch,
        region: regionId ? (regionMap.get(regionId) ?? null) : null,
      };
    });

    return {
      ...response,
      data: {
        ...(response?.data ?? {}),
        items: enrichedItems,
      },
    };
  }

  async findTransferBatchById(id: string, requester?: RequesterContext) {
    const batchId = String(id ?? '').trim();
    if (!batchId) {
      this.badRequest('Partiya (batch) id majburiy');
    }

    const response = await this.sendOrderCommand<{
      data?: { source_branch_id?: string; destination_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id: batchId });

    const sourceBranchId = String(
      response?.data?.source_branch_id ?? '',
    ).trim();
    const destinationBranchId = String(
      response?.data?.destination_branch_id ?? '',
    ).trim();

    if (sourceBranchId && destinationBranchId) {
      try {
        await this.assertCanReadBranch(sourceBranchId, requester);
      } catch {
        await this.assertCanReadBranch(destinationBranchId, requester);
      }
    } else if (sourceBranchId) {
      await this.assertCanReadBranch(sourceBranchId, requester);
    } else if (destinationBranchId) {
      await this.assertCanReadBranch(destinationBranchId, requester);
    }

    const batchData = (response as { data?: Record<string, unknown> })?.data;
    if (!batchData || typeof batchData !== 'object') {
      return response;
    }

    const batchRecord = batchData;
    const regionId = String(
      (batchRecord?.target_region_id ?? '') as string,
    ).trim();
    const regionMap = await this.getRegionsByIds(regionId ? [regionId] : []);
    const rawItems = Array.isArray(batchRecord?.items)
      ? (batchRecord.items as Array<Record<string, unknown>>)
      : [];

    const enrichedItems = await Promise.all(
      rawItems.map(async (item) => {
        const orderId = String((item?.order_id ?? '') as string).trim();
        if (!orderId) {
          return { ...item, order: null };
        }

        try {
          const orderRes = await this.sendOrderCommand<{
            data?: Record<string, unknown>;
          }>('order.find_by_id_enriched', { id: orderId });
          return {
            ...item,
            order:
              (orderRes as { data?: Record<string, unknown> })?.data ??
              orderRes ??
              null,
          };
        } catch {
          return {
            ...item,
            order: null,
          };
        }
      }),
    );

    return {
      ...batchRecord,
      items: enrichedItems,
      region: regionId ? (regionMap.get(regionId) ?? null) : null,
    };
  }

  private async assertRequesterWorksInBranch(
    branchId: string,
    requester?: RequesterContext,
  ) {
    if (this.isSystemPrivileged(requester)) {
      return;
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const assignment = await this.branchUserRepo.findOne({
      where: {
        user_id: requesterId,
        branch_id: String(branchId),
        isDeleted: false,
      },
      select: ['id'],
    });
    if (!assignment) {
      this.forbidden('Qabul qiluvchi xodim manzil filialga biriktirilmagan');
    }
  }

  async receiveTransferBatch(batchId: string, requester?: RequesterContext) {
    const id = String(batchId ?? '').trim();
    if (!id) {
      this.badRequest('Partiya (batch) id majburiy');
    }

    const batchRes = await this.sendOrderCommand<{
      data?: { destination_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id });
    const destinationBranchId = String(
      batchRes?.data?.destination_branch_id ?? '',
    ).trim();
    if (!destinationBranchId) {
      this.notFound('Partiya (transfer batch) topilmadi');
    }
    const destinationBranch = await this.getBranchOrThrow(destinationBranchId);
    this.assertBranchCanReceiveBatches(destinationBranch);

    await this.assertRequesterWorksInBranch(destinationBranchId, requester);

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const receiveResult = await this.sendOrderCommand(
      'order.transfer_batch.receive',
      {
        batch_id: id,
        requester_id: requesterId,
        requester_name: requesterId,
        requester_roles: requester?.roles ?? [],
      },
    );

    await this.activityLog.log({
      entity_type: 'TransferBatch',
      entity_id: String(id),
      action: ActivityAction.STATUS_CHANGE,
      metadata: {
        status: 'RECEIVED',
        destination_branch_id: destinationBranchId,
      },
      ...this.auditActor(requester),
    });

    return receiveResult;
  }

  async receiveTransferBatchOrders(
    batchId: string,
    dto: { orderIds?: string[]; order_ids?: string[] },
    requester?: RequesterContext,
  ) {
    const id = String(batchId ?? '').trim();
    if (!id) {
      this.badRequest('Partiya (batch) id majburiy');
    }

    const orderIds = Array.from(
      new Set(
        (dto?.orderIds ?? dto?.order_ids ?? [])
          .map((value) => String(value ?? '').trim())
          .filter(Boolean),
      ),
    );
    if (!orderIds.length) {
      this.badRequest("orderIds/order_ids bo'sh bo'lmasligi kerak");
    }

    const uniqueOrderIds = orderIds;

    const batchRes = await this.sendOrderCommand<{
      data?: { destination_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id });
    const destinationBranchId = String(
      batchRes?.data?.destination_branch_id ?? '',
    ).trim();
    if (!destinationBranchId) {
      this.notFound('Partiya (transfer batch) topilmadi');
    }
    const destinationBranch = await this.getBranchOrThrow(destinationBranchId);
    this.assertBranchCanReceiveBatches(destinationBranch);

    await this.assertRequesterWorksInBranch(destinationBranchId, requester);

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const receiveOrdersResult = await this.sendOrderCommand(
      'order.transfer_batch.receive_orders',
      {
        batch_id: id,
        order_ids: uniqueOrderIds,
        requester_id: requesterId,
        requester_name: requesterId,
        requester_roles: requester?.roles ?? [],
      },
    );

    await this.activityLog.log({
      entity_type: 'TransferBatch',
      entity_id: String(id),
      action: ActivityAction.STATUS_CHANGE,
      metadata: {
        status: 'RECEIVED_ORDERS',
        destination_branch_id: destinationBranchId,
        order_count: uniqueOrderIds.length,
        order_ids: uniqueOrderIds.slice(0, 20),
      },
      ...this.auditActor(requester),
    });

    return receiveOrdersResult;
  }

  async cancelTransferBatch(
    batchId: string,
    dto: {
      reason?: string;
    },
    requester?: RequesterContext,
  ) {
    const id = String(batchId ?? '').trim();
    if (!id) {
      this.badRequest('Partiya (batch) id majburiy');
    }

    const reason = String(dto?.reason ?? '').trim();
    if (!reason || reason.length < 10) {
      this.badRequest(
        "Bekor qilish sababi kamida 10 ta belgidan iborat bo'lishi kerak",
      );
    }

    const batchRes = await this.sendOrderCommand<{
      data?: { source_branch_id?: string };
    }>('order.transfer_batch.find_by_id', { id });
    const sourceBranchId = String(
      batchRes?.data?.source_branch_id ?? '',
    ).trim();
    if (!sourceBranchId) {
      this.notFound('Partiya (transfer batch) topilmadi');
    }

    await this.assertCanCreateTransferBatch(sourceBranchId, requester);

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const requesterName = requesterId;

    const cancelResult = await this.sendOrderCommand(
      'order.transfer_batch.cancel',
      {
        batch_id: id,
        reason,
        requester_id: requesterId,
        requester_name: requesterName,
        requester_roles: requester?.roles ?? [],
      },
    );

    // Keep compatibility with T13 flow: send explicit unassign command as well.
    // This is safe and idempotent even if orders were already unassigned in cancel command.
    try {
      await this.sendOrderCommand('order.bulk_remove_from_batch', {
        batch_id: id,
        message_id: `cancel_batch_${id}`,
      });
    } catch {
      // Best-effort call; main cancel transaction has already handled unassignment.
    }

    await this.activityLog.log({
      entity_type: 'TransferBatch',
      entity_id: String(id),
      action: ActivityAction.STATUS_CHANGE,
      metadata: {
        status: 'CANCELLED',
        source_branch_id: sourceBranchId,
        reason,
      },
      ...this.auditActor(requester),
    });

    return cancelResult;
  }

  async dispatchPostToBranch(
    sourceBranchIdInput: string,
    postIdInput: string,
    destinationBranchIdInput: string,
    orderIdsInput?: string[],
    requester?: RequesterContext,
  ) {
    const sourceBranchId = String(sourceBranchIdInput ?? '').trim();
    const destinationBranchId = String(destinationBranchIdInput ?? '').trim();
    const postId = String(postIdInput ?? '').trim();

    if (!sourceBranchId || !destinationBranchId || !postId) {
      this.badRequest(
        'source_branch_id, destination_branch_id va post_id majburiy',
      );
    }

    const sourceBranch = await this.getBranchOrThrow(sourceBranchId);
    const destinationBranch = await this.getBranchOrThrow(destinationBranchId);

    if (sourceBranch.type !== BranchType.HQ) {
      this.forbidden("Pochta faqat HQ filialdan jo'natiladi");
    }
    // Ruxsat manzil haqidagi 400'lardan OLDIN tekshiriladi: ruxsatsiz
    // so'rovchi manzil filial haqida hech narsa bilmasdan 403 oladi.
    // (Ilgari bu yerda assertCanWriteBranch bor edi — u faqat MANAGER'ga
    // ruxsat berardi, HQ registratori 403 olardi.)
    await this.assertCanDispatchPostFromBranch(sourceBranchId, requester);
    this.assertValidDispatchDestination(sourceBranch, destinationBranch);
    await this.assertBranchHasManager(destinationBranch);
    // Pochtaning o'zi: kuryer pochtasi yoki 'new' bo'lmagan pochta — butun
    // so'rov 400 (buyurtmalar o'qilishidan va ko'chirilishidan oldin).
    const sourcePost = await this.assertPostCanBeDispatched(postId, {
      source_branch_id: sourceBranchId,
      destination_branch_id: destinationBranchId,
    });
    // LC-09: HQ pochtasi hudud (tumanning assigned_region'i) bo'yicha
    // yig'iladi — u faqat SHU hududdagi filialga jo'natiladi. Ikkala hudud
    // ma'lum bo'lib, farq qilsa — butun so'rov 400, hech narsa ko'chirilmaydi.
    const sourcePostRegionId = this.normalizeRegionId(sourcePost?.region_id);
    const destinationRegionId = this.normalizeRegionId(
      destinationBranch.region_id,
    );
    if (
      sourcePostRegionId &&
      destinationRegionId &&
      sourcePostRegionId !== destinationRegionId
    ) {
      throw new RpcException(
        errorRes(
          `Pochta #${postId} boshqa hudud uchun yig'ilgan (hudud #${sourcePostRegionId}), manzil filial esa hudud #${destinationRegionId} da. ` +
            "Pochtani o'z hududidagi filialga jo'nating. Hech narsa jo'natilmadi",
          400,
          {
            post_id: postId,
            source_branch_id: sourceBranchId,
            destination_branch_id: destinationBranchId,
            post_region_id: sourcePostRegionId,
            destination_region_id: destinationRegionId,
            reasons: { region_mismatch: true },
          },
        ),
      );
    }

    const requesterPayload = {
      id: String(requester?.id ?? ''),
      roles: requester?.roles ?? [],
    };

    const postOrdersResponse = await this.sendLogisticsCommand<{
      data?:
        | Array<Record<string, unknown>>
        | { allOrdersByPostId?: Array<Record<string, unknown>> };
    }>('logistics.post.orders_by_post', {
      id: postId,
      requester: requesterPayload,
    });

    const rawData = postOrdersResponse?.data;
    const orders = Array.isArray(rawData)
      ? rawData
      : Array.isArray(rawData?.allOrdersByPostId)
        ? rawData.allOrdersByPostId
        : [];
    if (!orders.length) {
      throw new RpcException(
        errorRes("Post ichida jo'natishga mos order topilmadi", 400, {
          post_id: postId,
          source_branch_id: sourceBranchId,
          destination_branch_id: destinationBranchId,
          total_in_post: 0,
          eligible_orders_count: 0,
          reasons: {
            empty_post: true,
          },
        }),
      );
    }

    // Id'lar kanonik ko'rinishda solishtiriladi ('064' = '64') va takrorsiz.
    const selectedOrderIds = Array.from(
      new Set(
        (Array.isArray(orderIdsInput) ? orderIdsInput : [])
          .map((id) => this.canonicalId(id))
          .filter(Boolean),
      ),
    );
    if (!selectedOrderIds.length) {
      this.badRequest(ORDER_IDS_REQUIRED_MESSAGE);
    }

    // E2E-DISPATCH-SKIP: tanlangan, lekin shu pochtada YO'Q buyurtma jimgina
    // tashlab ketilmaydi (ilgari 201 "5 tadan 5 tasi ko'chdi" qaytib, 6-si
    // HQ'da qolib ketardi). Bittasi bo'lsa ham BUTUN so'rov 409, hech narsa
    // ko'chirilmaydi — operator sahifani yangilab, qayta tanlaydi.
    const postOrderIdSet = new Set(
      orders.map((order) => this.canonicalId(order?.id)),
    );
    const missingSelectedIds = selectedOrderIds.filter(
      (id) => !postOrderIdSet.has(id),
    );
    if (missingSelectedIds.length) {
      throw new RpcException(
        errorRes(
          `Tanlangan ${missingSelectedIds.length} ta buyurtma bu pochtada yo'q: ${this.formatOrderIdsForMessage(missingSelectedIds)}. ` +
            "Ular boshqa pochtada yoki pochtasiz bo'lishi mumkin — sahifani yangilab, buyurtmalarni qayta tanlang. Hech narsa jo'natilmadi",
          409,
          {
            post_id: postId,
            source_branch_id: sourceBranchId,
            destination_branch_id: destinationBranchId,
            selected_order_ids: selectedOrderIds,
            missing_order_ids: missingSelectedIds,
          },
        ),
      );
    }

    const selectedSet = new Set(selectedOrderIds);
    const candidateOrders = orders.filter((order) =>
      selectedSet.has(this.canonicalId(order?.id)),
    );

    const orderIds = candidateOrders
      .map((order) => this.canonicalId(order?.id))
      .filter(Boolean);
    const mismatchedOrders = candidateOrders.filter(
      (order) => String((order?.branch_id ?? '') as string) !== sourceBranchId,
    );
    const deletedOrders = candidateOrders.filter((order) =>
      Boolean(order?.isDeleted ?? order?.is_deleted),
    );
    const blockedStatusOrders = candidateOrders.filter((order) => {
      const status = String((order?.status ?? '') as string)
        .trim()
        .toLowerCase();
      return (
        status === Order_status.CANCELLED || status === Order_status.CLOSED
      );
    });

    const ineligibleOrderIds = new Set(
      [...mismatchedOrders, ...deletedOrders, ...blockedStatusOrders]
        .map((order) => this.canonicalId(order?.id))
        .filter(Boolean),
    );

    const eligibleOrderIds = orderIds.filter(
      (id) => !ineligibleOrderIds.has(id),
    );

    if (!eligibleOrderIds.length) {
      throw new RpcException(
        errorRes("Post ichida jo'natishga mos order topilmadi", 400, {
          post_id: postId,
          source_branch_id: sourceBranchId,
          destination_branch_id: destinationBranchId,
          total_in_post: orderIds.length,
          eligible_orders_count: 0,
          reasons: {
            branch_mismatch_count: mismatchedOrders.length,
            deleted_count: deletedOrders.length,
            blocked_status_count: blockedStatusOrders.length,
          },
          sample_order_ids: orderIds.slice(0, 10),
        }),
      );
    }

    if (mismatchedOrders.length) {
      // Gateway xato tanasidan `data` ni tashlab yuboradi — id'lar XABARDA.
      // CODE-11: tekshiruv TANLOV bo'yicha ishlaydi, pochtadan chiqarish
      // yo'li esa yo'q — operatorga tanlovdan olib tashlash aytiladi.
      const mismatchedIds = mismatchedOrders
        .map((order) => this.canonicalId(order?.id))
        .filter(Boolean);
      throw new RpcException(
        errorRes(
          `Tanlangan buyurtmalar orasida manba filialga (HQ) tegishli bo'lmagan ${mismatchedIds.length} ta buyurtma bor: ${this.formatOrderIdsForMessage(mismatchedIds)}. ` +
            "Ularni tanlovdan olib tashlang va qayta jo'nating. Hech narsa jo'natilmadi",
          400,
          {
            post_id: postId,
            source_branch_id: sourceBranchId,
            destination_branch_id: destinationBranchId,
            total_in_post: orderIds.length,
            eligible_orders_count: eligibleOrderIds.length,
            reasons: {
              branch_mismatch_count: mismatchedOrders.length,
              deleted_count: deletedOrders.length,
              blocked_status_count: blockedStatusOrders.length,
            },
            mismatched_order_ids: mismatchedIds.slice(0, 20),
          },
        ),
      );
    }

    // Ko'chiriladigan HAR BIR buyurtma HQ'da turgan bo'lishi shart: holati
    // 'received' (HQ qabul qilgan; CODE-11 — 'new' EMAS), kuryerda EMAS
    // (courier_id ham, holder_courier_id ham bo'sh). Kuryerdagi, sotilgan, yo'ldagi va h.k. buyurtmani filialga
    // "ko'chirish" hech qachon to'g'ri emas — superadmin/admin uchun ham.
    // Birortasi bo'lsa BUTUN so'rov rad etiladi (qolganini jimgina
    // jo'natmaymiz), hech narsa ko'chirilmaydi. CANCELLED/CLOSED va o'chirilgan
    // buyurtmalar yuqoridagidek jimgina chetlab o'tiladi (eligible emas).
    const eligibleIdSet = new Set(eligibleOrderIds);
    const nonDispatchableOrders = candidateOrders.filter((order) => {
      const orderId = this.canonicalId(order?.id);
      if (!eligibleIdSet.has(orderId)) {
        return false;
      }
      const status = String((order?.status ?? '') as string)
        .trim()
        .toLowerCase();
      return (
        !DISPATCHABLE_ORDER_STATUSES.has(status) ||
        this.hasCourierRef(order?.courier_id) ||
        this.hasCourierRef(order?.holder_courier_id)
      );
    });
    if (nonDispatchableOrders.length) {
      const offendingIds = nonDispatchableOrders
        .map((order) => this.canonicalId(order?.id))
        .filter(Boolean);
      const wrongStatusCount = nonDispatchableOrders.filter(
        (order) =>
          !DISPATCHABLE_ORDER_STATUSES.has(
            String((order?.status ?? '') as string)
              .trim()
              .toLowerCase(),
          ),
      ).length;
      const courierHeldCount = nonDispatchableOrders.filter(
        (order) =>
          this.hasCourierRef(order?.courier_id) ||
          this.hasCourierRef(order?.holder_courier_id),
      ).length;
      throw new RpcException(
        errorRes(
          `${offendingIds.length} ta buyurtmani filialga jo'natib bo'lmaydi: ${this.formatOrderIdsForMessage(offendingIds)}. ` +
            "Faqat HQ qabul qilgan (holati 'received') va kuryerga biriktirilmagan buyurtma jo'natiladi — yangi buyurtmani avval HQ qabul qilsin",
          400,
          {
            post_id: postId,
            source_branch_id: sourceBranchId,
            destination_branch_id: destinationBranchId,
            total_in_post: orderIds.length,
            eligible_orders_count: eligibleOrderIds.length,
            reasons: {
              wrong_status_count: wrongStatusCount,
              courier_held_count: courierHeldCount,
            },
            non_dispatchable_order_ids: offendingIds,
          },
        ),
      );
    }

    // LC-13/LC-09: manzil SENT pochtasi MANBA pochtaning hududi bo'yicha
    // guruhlanadi (HQ pochtasi aynan shu hudud bo'yicha yig'ilgan; buyurtmaning
    // geografik region_id'si tuman boshqa hududga o'tkazilgan bo'lsa farq
    // qiladi). Manba pochtada hudud bo'lmasa — buyurtmaning hududi. Ikkalasi
    // ham yo'q bo'lsa ('' bigint ustunga ketib 22P02/5xx berardi) — HECH NARSA
    // yozilmasdan 400, id'lar bilan.
    const eligibleOrders = candidateOrders.filter((order) =>
      eligibleIdSet.has(this.canonicalId(order?.id)),
    );
    const regionByOrderId = new Map<string, string>();
    const regionlessOrderIds: string[] = [];
    for (const order of eligibleOrders) {
      const orderId = this.canonicalId(order?.id);
      const regionId =
        sourcePostRegionId ?? this.normalizeRegionId(order?.region_id);
      if (regionId) {
        regionByOrderId.set(orderId, regionId);
      } else {
        regionlessOrderIds.push(orderId);
      }
    }
    if (regionlessOrderIds.length) {
      throw new RpcException(
        errorRes(
          `${regionlessOrderIds.length} ta buyurtmaning hududi (viloyati) aniqlanmadi: ${this.formatOrderIdsForMessage(regionlessOrderIds)}. ` +
            "Buyurtmaga hudud belgilang yoki uni tanlovdan chiqaring. Hech narsa jo'natilmadi",
          400,
          {
            post_id: postId,
            source_branch_id: sourceBranchId,
            destination_branch_id: destinationBranchId,
            regionless_order_ids: regionlessOrderIds,
          },
        ),
      );
    }

    const requesterId = String(requester?.id ?? '').trim() || '0';
    const note = `Post #${postId} HQ'dan branch #${destinationBranchId} ga dispatch qilindi`;

    const destinationPostAssignmentsRes = await this.sendLogisticsCommand<{
      data?: Array<{ order_id?: string; post_id?: string }>;
    }>('logistics.post.receive_orders', {
      orders: eligibleOrders.map((order) => {
        const orderId = this.canonicalId(order?.id);
        return {
          order_id: orderId,
          assigned_region: regionByOrderId.get(orderId) as string,
          assigned_branch: destinationBranchId,
          assigned_post_status: Post_status.SENT,
          total_price: Number(order?.total_price ?? 0),
        };
      }),
    });

    const assignmentMap = new Map<string, string>(
      (destinationPostAssignmentsRes?.data ?? [])
        .map(
          (row) =>
            [
              this.canonicalId(row?.order_id),
              String(row?.post_id ?? ''),
            ] as const,
        )
        .filter(([orderId, postId]) => Boolean(orderId) && Boolean(postId)),
    );

    for (const orderId of eligibleOrderIds) {
      const destinationPostId = assignmentMap.get(orderId) ?? null;
      await this.sendOrderCommand('order.update', {
        id: orderId,
        dto: {
          branch_id: destinationBranchId,
          holder_type: 'BRANCH',
          holder_branch_id: destinationBranchId,
          holder_courier_id: null,
          post_id: destinationPostId,
          current_batch_id: null,
          status: Order_status.ON_THE_ROAD,
        },
        requester: {
          id: requesterId,
          roles: requester?.roles ?? [],
          note,
        },
      });
    }

    // LC-02: buyurtmalar bittalab ko'chayotgan soniyalarda HQ qabuli (POST
    // /orders/receive) shu NEW pochtaga YANGI buyurtma qo'shishi mumkin.
    // Pochta snapshot bo'yicha "bo'shadi" deb o'chirilsa, u buyurtma yo'q
    // pochtaga ishora qilib qotib qolardi (hech bir kartada ko'rinmaydi,
    // jo'natib ham bo'lmaydi). Shuning uchun pochta FAQAT unga hech qanday
    // buyurtma ishora qilmay qolganda o'chiriladi; tekshirib bo'lmasa — qoladi
    // (bo'sh NEW pochta zararsiz: keyingi qabul unga tushadi).
    const shouldDeletePost =
      eligibleOrderIds.length === orders.length &&
      (await this.isPostFreeOfOrders(postId));
    if (shouldDeletePost) {
      await this.sendLogisticsCommand('logistics.post.delete', { id: postId });
    }

    await this.activityLog.log({
      entity_type: 'Post',
      entity_id: String(postId),
      action: 'branch.post_dispatch',
      metadata: {
        source_branch_id: sourceBranchId,
        destination_branch_id: destinationBranchId,
        order_count: eligibleOrderIds.length,
        order_ids: eligibleOrderIds.slice(0, 20),
        post_deleted: shouldDeletePost,
      },
      ...this.auditActor(requester),
    });

    return successRes(
      {
        source_branch_id: sourceBranchId,
        destination_branch_id: destinationBranchId,
        post_id: postId,
        selected_order_ids: selectedOrderIds,
        moved_orders_count: eligibleOrderIds.length,
        moved_order_ids: eligibleOrderIds,
        post_deleted: shouldDeletePost,
      },
      200,
      'Post HQ dan branchga muvaffaqiyatli dispatch qilindi',
    );
  }

  /** Raqamli hudud id'si (kanonik) yoki null (bo'sh, '0' emas, raqam emas). */
  private normalizeRegionId(value: unknown): string | null {
    const normalized = String((value ?? '') as string).trim();
    if (!/^\d+$/.test(normalized) || /^0+$/.test(normalized)) {
      return null;
    }
    return this.canonicalId(normalized);
  }

  /**
   * LC-02 — pochtaga hali biror (o'chirilmagan) buyurtma ishora qiladimi.
   * true FAQAT order-service "0 ta" deb aniq javob berganda; xato, timeout
   * yoki tushunarsiz javob — false (pochta o'chirilmaydi).
   */
  private async isPostFreeOfOrders(postId: string): Promise<boolean> {
    try {
      const response = await lastValueFrom(
        this.orderClient
          .send<Record<
            string,
            unknown
          > | null>({ cmd: 'order.find_all' }, { query: { post_id: postId, page: 1, limit: 1 } })
          .pipe(timeout(DISPATCH_POST_RECHECK_TIMEOUT_MS)),
      );
      // order.find_all: { data: Order[], total, ... } (ba'zan successRes ichida).
      const body: Record<string, unknown> = response ?? {};
      const inner =
        body.data && typeof body.data === 'object' && !Array.isArray(body.data)
          ? (body.data as Record<string, unknown>)
          : {};
      const totalValue = body.total ?? inner.total;
      const total =
        typeof totalValue === 'number' || typeof totalValue === 'string'
          ? Number(totalValue)
          : NaN;
      if (Number.isInteger(total) && total >= 0) {
        return total === 0;
      }
      const rows = Array.isArray(body.data)
        ? (body.data as unknown[])
        : Array.isArray(inner.data)
          ? (inner.data as unknown[])
          : null;
      if (rows) {
        return rows.length === 0;
      }
      throw new Error("order.find_all: javob shakli noto'g'ri");
    } catch (error) {
      this.logger.warn(
        `dispatch: post #${postId} bo'shligini tekshirib bo'lmadi — pochta o'chirilmaydi: ${this.describeRpcFailure(error)}`,
      );
      return false;
    }
  }

  /**
   * Pochta jo'natish oynasi uchun manzil filiallar ro'yxati.
   *
   * - Kirish: superadmin/admin yoki HQ registratori (qolganlar — 403).
   * - Faqat FAOL REGIONAL/HYBRID filiallar (HQ va PICKUP hech qachon), ixtiyoriy
   *   region_id filtri bilan — dispatchPostToBranch qabul qiladigan manzillar
   *   bilan bir xil qoida.
   * - PUL MAYDONLARI YO'Q (branch.find_all'dan farqli: u menejer oyligi,
   *   kuryer balanslari va olinishi_kerak/berilishi_kerak ni qaytaradi —
   *   registrator ularni ko'rmasligi kerak).
   * - Menejerlar bitta `In(ids)` so'rovida, ism/telefonlar bitta identity
   *   chaqiruvida olinadi (filial boshiga alohida chaqiruv yo'q).
   */
  async findDispatchDestinations(
    query?: { region_id?: string | number | null },
    requester?: RequesterContext,
  ) {
    await this.assertCanListDispatchDestinations(requester);

    const regionId = this.normalizeNullableBigint(query?.region_id)?.trim();
    if (regionId && !/^\d+$/.test(regionId)) {
      this.badRequest("region_id noto'g'ri");
    }

    const branches = await this.branchRepo.find({
      where: {
        isDeleted: false,
        status: Status.ACTIVE,
        type: In([BranchType.REGIONAL, BranchType.HYBRID]),
        ...(regionId ? { region_id: regionId } : {}),
      },
      order: { name: 'ASC' },
    });

    const branchIds = branches.map((branch) => String(branch.id));
    const managerAssignments = branchIds.length
      ? await this.branchUserRepo.find({
          where: {
            isDeleted: false,
            role: BranchUserRole.MANAGER,
            branch_id: In(branchIds),
          },
          select: ['id', 'branch_id', 'user_id', 'createdAt'],
          order: { createdAt: 'ASC' },
        })
      : [];

    // Filialning HAMMA menejer qatorlari (eng eskisi birinchi): birinchisi
    // o'chirilgan/bloklangan bo'lsa, keyingi faoli ko'rsatiladi (CODE-07).
    const managerIdsByBranchId = new Map<string, string[]>();
    for (const assignment of managerAssignments) {
      const branchId = String(assignment.branch_id ?? '').trim();
      const userId = String(assignment.user_id ?? '').trim();
      if (!branchId || !userId) {
        continue;
      }
      const list = managerIdsByBranchId.get(branchId) ?? [];
      if (!list.includes(userId)) {
        list.push(userId);
      }
      managerIdsByBranchId.set(branchId, list);
    }

    const regionIds = Array.from(
      new Set(
        branches
          .map((branch) => String(branch.region_id ?? '').trim())
          .filter(Boolean),
      ),
    );
    const [managersById, regionsById] = await Promise.all([
      this.getUsersByIdsBatch(Array.from(managerIdsByBranchId.values()).flat()),
      this.getRegionsByIds(regionIds),
    ]);

    const items = branches.map((branch) => {
      const branchRegionId = String(branch.region_id ?? '').trim() || null;
      const region = branchRegionId
        ? ((regionsById.get(branchRegionId) as
            | Record<string, unknown>
            | undefined) ?? null)
        : null;
      const candidateIds = managerIdsByBranchId.get(String(branch.id)) ?? [];
      // CODE-07: has_manager — identity'da FAOL menejer (o'chirilgan yoki
      // bloklangan menejerning qolib ketgan qatori hisoblanmaydi; jo'natish
      // ham shu qoida bilan tekshiriladi). Identity javob bermasa — avvalgidek
      // branch_users qatori bo'yicha (ism/telefonsiz): ro'yxat yiqilmaydi,
      // jo'natishning o'zi esa fail-closed tekshiriladi.
      const managerId = managersById
        ? (candidateIds.find((id) =>
            this.isActiveManagerUser(managersById.get(id)),
          ) ?? null)
        : (candidateIds[0] ?? null);
      const managerUser =
        managerId && managersById
          ? (managersById.get(managerId) ?? null)
          : null;
      const managerName = managerUser?.name;
      const managerPhone = managerUser?.phone_number;

      return {
        id: String(branch.id),
        name: branch.name,
        code: branch.code ?? null,
        type: branch.type,
        status: branch.status,
        phone_number: branch.phone_number ?? null,
        region_id: branchRegionId,
        region: region
          ? {
              id: String((region.id ?? branchRegionId) as string),
              name: typeof region.name === 'string' ? region.name : '',
            }
          : null,
        has_manager: Boolean(managerId),
        // manager faqat has_manager=false bo'lganda null. Identity javob
        // bermasa ham id qoladi (ism/telefon bo'sh) — u holda menejer
        // borligi branch_users qatoridan olinadi.
        manager: managerId
          ? {
              id: managerId,
              name: typeof managerName === 'string' ? managerName : '',
              phone_number:
                typeof managerPhone === 'string' ? managerPhone : null,
            }
          : null,
      };
    });

    return successRes(
      { items, total: items.length },
      200,
      "Jo'natish uchun filiallar",
    );
  }

  async findTransferBatchByToken(token: string, requester?: RequesterContext) {
    const normalizedToken = String(token ?? '').trim();
    if (!normalizedToken) {
      this.badRequest('token majburiy');
    }

    let response: {
      data?: Record<string, unknown>;
      statusCode?: number;
      message?: string;
    };
    try {
      response = await lastValueFrom(
        this.orderClient
          .send(
            { cmd: 'order.transfer_batch.find_by_qr' },
            { token: normalizedToken },
          )
          .pipe(timeout(15000)),
      );
    } catch (error) {
      // C12: xom xato (oddiy obyekt) qayta otilsa Nest uni 500 qiladi va RMQ
      // xabarni qayta navbatga qo'yadi — 4xx (masalan noto'g'ri QR, 404)
      // saqlanib RpcException bo'lib ketadi.
      const parsed = this.extractRpcError(error);
      if (parsed) {
        throw new RpcException(errorRes(parsed.message, parsed.statusCode));
      }
      throw new RpcException(errorRes(ORDER_SERVICE_UNAVAILABLE_MESSAGE, 502));
    }

    const payload = (response?.data ?? null) as {
      source_branch_id?: string;
      destination_branch_id?: string;
    } | null;

    const sourceBranchId = String(payload?.source_branch_id ?? '').trim();
    const destinationBranchId = String(
      payload?.destination_branch_id ?? '',
    ).trim();

    if (sourceBranchId) {
      await this.assertCanReadBranch(sourceBranchId, requester);
    } else if (destinationBranchId) {
      await this.assertCanReadBranch(destinationBranchId, requester);
    }

    return response;
  }

  async createBranch(
    dto: {
      name?: string;
      location?: string;
      address?: string;
      phone_number?: string;
      region_id?: string | null;
      district_id?: string | null;
      parent_id?: string | null;
      type?: BranchType | string;
      code?: string;
      manager_id?: string | null;
    },
    requester?: RequesterContext,
  ) {
    const name = String(dto?.name ?? '').trim();
    if (!name) {
      this.badRequest('Filial nomi majburiy');
    }

    await this.ensureBranchNameUnique(name);

    const type = this.parseBranchType(dto?.type);
    const code = this.normalizeBranchCode(dto?.code);
    await this.ensureBranchCodeUnique(code);

    const parentId = this.normalizeNullableBigint(dto?.parent_id);
    let level = 0;

    if (type === BranchType.HQ) {
      if (parentId) {
        this.badRequest("HQ filialning ota filiali (parent_id) bo'lmaydi");
      }
      const existingHq = await this.branchRepo.findOne({
        where: { type: BranchType.HQ, isDeleted: false },
      });
      if (existingHq) {
        this.conflict("Tizimda faqat bitta HQ filial bo'lishi mumkin");
      }
    } else {
      if (!parentId) {
        this.badRequest(
          "HQ bo'lmagan filial uchun ota filial (parent_id) majburiy",
        );
      }
      const parent = await this.getParentBranchOrThrow(parentId);
      level = Number(parent.level) + 1;
    }

    const saved = await this.branchRepo.save(
      this.branchRepo.create({
        name,
        address: String(dto?.address ?? dto?.location ?? '').trim() || null,
        phone_number: String(dto?.phone_number ?? '').trim() || null,
        region_id: this.normalizeNullableBigint(dto?.region_id),
        district_id: this.normalizeNullableBigint(dto?.district_id),
        parent_id: parentId,
        type,
        level,
        code,
        manager_id: this.normalizeNullableBigint(dto?.manager_id),
        status: Status.ACTIVE,
      }),
    );

    await this.activityLog.log({
      entity_type: 'Branch',
      entity_id: String(saved.id),
      action: ActivityAction.CREATED,
      new_value: saved,
      metadata: {
        parent_id: saved.parent_id ?? null,
        region_id: saved.region_id ?? null,
        district_id: saved.district_id ?? null,
        manager_id: saved.manager_id ?? null,
        type: saved.type,
      },
      ...this.auditActor(requester),
    });

    return successRes(saved, 201, 'Branch created');
  }

  async findAllBranches(
    query?: {
      search?: string;
      status?: string;
      page?: number;
      limit?: number;
    },
    requester?: RequesterContext,
  ) {
    const { page, limit, skip } = this.normalizePagination(
      query?.page,
      query?.limit,
    );
    const status = this.parseStatus(query?.status);
    const search = String(query?.search ?? '').trim();

    const qb = this.branchRepo
      .createQueryBuilder('branch')
      .where('branch.isDeleted = :isDeleted', { isDeleted: false })
      .orderBy('branch.createdAt', 'DESC');

    if (status) {
      qb.andWhere('branch.status = :status', { status });
    }

    if (search) {
      qb.andWhere(
        '(branch.name ILIKE :search OR branch.code ILIKE :search OR branch.address ILIKE :search OR branch.phone_number ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    if (!this.isSystemPrivileged(requester)) {
      const scope = await this.resolveAccessScope(requester);
      const allowedBranchIds = Array.from(scope.readableBranchIds);
      if (!allowedBranchIds.length) {
        return successRes(
          {
            items: [],
            meta: {
              page,
              limit,
              total: 0,
              totalPages: 1,
            },
          },
          200,
          'Branches list',
        );
      }
      qb.andWhere('branch.id IN (:...allowedBranchIds)', { allowedBranchIds });
    }

    const [items, total] = await qb.skip(skip).take(limit).getManyAndCount();

    const regionIds = Array.from(
      new Set(
        items
          .map((item) => item.region_id)
          .filter((regionId): regionId is string => Boolean(regionId)),
      ),
    );
    const districtIds = Array.from(
      new Set(
        items
          .map((item) => item.district_id)
          .filter((districtId): districtId is string => Boolean(districtId)),
      ),
    );
    const parentIds = Array.from(
      new Set(
        items
          .map((item) => item.parent_id)
          .filter((parentId): parentId is string => Boolean(parentId)),
      ),
    );

    const regionMap = await this.getRegionsByIds(regionIds);
    const districtMap = await this.getDistrictsByIds(districtIds);
    const parentMap = await this.getParentsByIds(parentIds);
    const branchIds = items.map((item) => String(item.id)).filter(Boolean);
    const managerAssignments = branchIds.length
      ? await this.branchUserRepo.find({
          where: {
            isDeleted: false,
            role: BranchUserRole.MANAGER,
            branch_id: In(branchIds),
          },
          select: ['branch_id', 'user_id'],
        })
      : [];
    const courierAssignments = branchIds.length
      ? await this.branchUserRepo.find({
          where: {
            isDeleted: false,
            role: BranchUserRole.COURIER,
            branch_id: In(branchIds),
          },
          select: ['branch_id', 'user_id'],
        })
      : [];

    const managerByBranchId = new Map<string, string>();
    for (const assignment of managerAssignments) {
      const branchId = String(assignment.branch_id ?? '').trim();
      const userId = String(assignment.user_id ?? '').trim();
      if (!branchId || !userId || managerByBranchId.has(branchId)) {
        continue;
      }
      managerByBranchId.set(branchId, userId);
    }

    const courierIdsByBranchId = new Map<string, string[]>();
    for (const assignment of courierAssignments) {
      const branchId = String(assignment.branch_id ?? '').trim();
      const userId = String(assignment.user_id ?? '').trim();
      if (!branchId || !userId) continue;
      const existing = courierIdsByBranchId.get(branchId) ?? [];
      if (!existing.includes(userId)) {
        existing.push(userId);
        courierIdsByBranchId.set(branchId, existing);
      }
    }

    const managerIds = Array.from(
      new Set(Array.from(managerByBranchId.values())),
    );
    const managerUsersMap = await this.getUsersByIds(managerIds);
    const paymentByManagerId = new Map<string, unknown>();
    const courierBalanceByUserId = new Map<string, number>();

    await Promise.all(
      managerIds.map(async (managerId) => {
        try {
          const salaryRes = await this.sendFinanceCommand<{ data?: unknown }>(
            'finance.salary.find_by_user',
            { user_id: managerId },
          );
          paymentByManagerId.set(managerId, salaryRes?.data ?? null);
        } catch {
          const managerUser = managerUsersMap.get(managerId) as Record<
            string,
            unknown
          > | null;
          if (managerUser) {
            paymentByManagerId.set(managerId, {
              user_id: managerId,
              salary_amount: Number(managerUser.salary ?? 0),
              payment_day:
                managerUser.payment_day !== undefined &&
                managerUser.payment_day !== null
                  ? Number(managerUser.payment_day)
                  : null,
              tariff_home:
                managerUser.tariff_home !== undefined &&
                managerUser.tariff_home !== null
                  ? Number(managerUser.tariff_home)
                  : null,
              tariff_center:
                managerUser.tariff_center !== undefined &&
                managerUser.tariff_center !== null
                  ? Number(managerUser.tariff_center)
                  : null,
              source: 'identity_fallback',
            });
            return;
          }
          paymentByManagerId.set(managerId, null);
        }
      }),
    );

    const allCourierIds = Array.from(
      new Set(
        Array.from(courierIdsByBranchId.values())
          .flat()
          .map((id) => String(id))
          .filter(Boolean),
      ),
    );

    await Promise.all(
      allCourierIds.map(async (courierId) => {
        try {
          const cashboxRes = await this.sendFinanceCommand<{
            data?: { balance?: number | string };
          }>('finance.cashbox.find_by_user', {
            user_id: courierId,
            cashbox_type: Cashbox_type.FOR_COURIER,
          });
          const rawBalance = Number(cashboxRes?.data?.balance ?? 0);
          courierBalanceByUserId.set(
            courierId,
            Number.isFinite(rawBalance) ? rawBalance : 0,
          );
        } catch {
          courierBalanceByUserId.set(courierId, 0);
        }
      }),
    );

    /**
     * ⚠️ FILIAL QARZI ENDI LEDGERDAN, BAZADA HISOBLANADI (Scale 1 — 3-joy).
     *
     * Ilgari bu yerda HAR FILIAL uchun ikkitadan `order.find_all`
     * (`fetch_all: true, limit: 5000`) chaqirilardi va summa JS'da
     * hisoblanardi. 13 filialda bu ~130 000 buyurtma qatorini RabbitMQ orqali
     * tashish demakdir. Produksiyada o'lchandi: 51 000 buyurtmali bazada
     * `/finance/cashbox/financial-balanse` 7,2 s, `/analytics/revenue` esa
     * umuman 504 bilan tugadi — IKKALASI HAM aynan shu chaqiruv tufayli
     * (ikkalasi `branch.find_all` ni ishlatadi).
     *
     * Bazadagi o'sha yig'indi SQL bilan 17 ms oladi. Endi bitta chaqiruv:
     * `order.settlement.financial_balance_summary` barcha filiallar kesimini
     * bir so'rovda qaytaradi.
     *
     * ⚠️ FORMULA HAM TO'G'RILANDI. Eski hisob "buyurtma summasi minus manager
     * tarifi" edi; ledger esa haqiqatan yozilgan `branch_amount` ni
     * (`total − courierShare − branchShare`) saqlaydi va HQ'ga yetib kelgan
     * buyurtmalar undan o'z-o'zidan chiqib ketadi. Manager paneli (C1) ham
     * shu manbaga o'tgan — ya'ni ikkala ekran endi bitta raqamni ko'rsatadi.
     */
    const payableToHqByBranchId = new Map<string, number>();
    try {
      const summary = await this.sendOrderCommand<{
        data?: { branches?: Array<{ branch_id: string; amount: number }> };
      }>('order.settlement.financial_balance_summary', {});
      for (const row of summary?.data?.branches ?? []) {
        payableToHqByBranchId.set(
          String(row.branch_id),
          Math.max(Number(row.amount) || 0, 0),
        );
      }
    } catch {
      // Yig'indi olinmasa nol qoladi — avvalgi xatti-harakat bilan bir xil.
    }

    const enrichedItems = items.map((item) => ({
      ...item,
      region: item.region_id ? (regionMap.get(item.region_id) ?? null) : null,
      district: item.district_id
        ? (districtMap.get(item.district_id) ?? null)
        : null,
      parent: item.parent_id ? (parentMap.get(item.parent_id) ?? null) : null,
      olinishi_kerak: (() => {
        if (item.type === BranchType.HQ) {
          const courierIds = courierIdsByBranchId.get(String(item.id)) ?? [];
          return courierIds.reduce((sum, courierId) => {
            const balance = Number(courierBalanceByUserId.get(courierId) ?? 0);
            return balance > 0 ? sum + balance : sum;
          }, 0);
        }
        return Number(payableToHqByBranchId.get(String(item.id)) ?? 0);
      })(),
      // Regional branch uchun bu summa branchning HQ'ga berishi kerak bo'lgan
      // qarzidir. `olinishi_kerak` legacy maydoni saqlanadi, yangi consumerlar
      // esa semantik jihatdan to'g'ri nomni ishlatadi.
      berilishi_kerak:
        item.type === BranchType.HQ
          ? 0
          : Number(payableToHqByBranchId.get(String(item.id)) ?? 0),
      payment: (() => {
        const managerId = managerByBranchId.get(String(item.id));
        if (!managerId) return null;
        return paymentByManagerId.get(managerId) ?? null;
      })(),
    }));

    return successRes(
      {
        items: enrichedItems,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
      200,
      'Branches list',
    );
  }

  async findBranchByCode(code: string) {
    const normalized = String(code ?? '')
      .trim()
      .toUpperCase();
    if (!normalized) {
      this.badRequest('Filial kodi (code) majburiy');
    }
    const branch = await this.branchRepo.findOne({
      where: { code: normalized, isDeleted: false },
    });
    if (!branch) {
      this.notFound('Bu kodli filial topilmadi');
    }
    return successRes(branch, 200, 'Branch found');
  }

  async findHqBranch() {
    const branch = await this.branchRepo.findOne({
      where: { code: this.hqCode, isDeleted: false },
    });
    if (branch) {
      return successRes(branch, 200, 'HQ branch');
    }
    const fallback = await this.branchRepo.findOne({
      where: { type: BranchType.HQ, isDeleted: false },
    });
    if (!fallback) {
      this.notFound('HQ filial topilmadi');
    }
    return successRes(fallback, 200, 'HQ branch');
  }

  async findBranchById(id: string, requester?: RequesterContext) {
    await this.assertCanReadBranch(id, requester);
    const branch = await this.getBranchOrThrow(id);
    const regionMap = await this.getRegionsByIds(
      branch.region_id ? [branch.region_id] : [],
    );
    const districtMap = await this.getDistrictsByIds(
      branch.district_id ? [branch.district_id] : [],
    );
    const parentMap = await this.getParentsByIds(
      branch.parent_id ? [branch.parent_id] : [],
    );

    return successRes(
      {
        ...branch,
        region: branch.region_id
          ? (regionMap.get(branch.region_id) ?? null)
          : null,
        district: branch.district_id
          ? (districtMap.get(branch.district_id) ?? null)
          : null,
        parent: branch.parent_id
          ? (parentMap.get(branch.parent_id) ?? null)
          : null,
      },
      200,
      'Branch found',
    );
  }

  async findBranchTree() {
    const branches = await this.branchRepo.find({
      where: { isDeleted: false },
      order: { level: 'ASC', createdAt: 'ASC' },
    });

    type BranchTreeNode = Branch & { children: BranchTreeNode[] };
    const nodeMap = new Map<string, BranchTreeNode>();
    const roots: BranchTreeNode[] = [];

    branches.forEach((branch) => {
      nodeMap.set(branch.id, { ...branch, children: [] });
    });

    branches.forEach((branch) => {
      const node = nodeMap.get(branch.id)!;
      const parentId = branch.parent_id ?? null;
      if (!parentId) {
        roots.push(node);
        return;
      }

      const parent = nodeMap.get(parentId);
      if (!parent) {
        // If parent is missing (deleted/inconsistent), treat as root.
        roots.push(node);
        return;
      }

      parent.children.push(node);
    });

    return successRes(roots, 200, 'Branch tree');
  }

  async findBranchDescendants(id: string) {
    const root = await this.getBranchOrThrow(id);
    const branches = await this.branchRepo.find({
      where: { isDeleted: false },
      order: { level: 'ASC', createdAt: 'ASC' },
    });

    const childrenByParent = new Map<string, Branch[]>();
    branches.forEach((branch) => {
      if (!branch.parent_id) {
        return;
      }
      const current = childrenByParent.get(branch.parent_id) ?? [];
      current.push(branch);
      childrenByParent.set(branch.parent_id, current);
    });

    const descendants: Branch[] = [];
    const queue: string[] = [root.id];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = childrenByParent.get(currentId) ?? [];
      for (const child of children) {
        descendants.push(child);
        queue.push(child.id);
      }
    }

    return successRes(descendants, 200, 'Branch descendants');
  }

  /**
   * ⚠️ AGREGATSIYA BAZADA (Scale 1-bosqich).
   *
   * Ilgari bu metod `getOrdersByBranchIds` orqali har filial uchun 5 000
   * tagacha buyurtmani (mahsulotlari bilan) RabbitMQ orqali tortib olib,
   * barcha hisoblarni JS'da `filter().length` bilan chiqarardi. Uch oqibati:
   * har ochilishda bir necha MB trafik, order-service event loop'ining band
   * bo'lishi (sotuv kechikadi), va 5 000 dan oshganda statistikaning jimgina
   * KAM ko'rsatishi. Endi hammasi bitta chaqiruv va bir necha o'nlab qator.
   */
  async getBranchStats(
    id: string,
    requester?: RequesterContext,
    filter: BranchDashboardFilter = {},
  ) {
    const targetBranchIds = await this.resolveAnalyticsBranchIds(id, requester);
    const courierIds = await this.getCourierIdsByBranchIds(targetBranchIds);
    const requesterBranchRole = await this.resolveRequesterBranchRole(
      targetBranchIds,
      requester,
    );

    const now = new Date();
    const selectedRange = this.resolveBranchDashboardRange(filter);
    const todayStart = this.toTashkentStartOfDay(now);
    const weekStart = this.toTashkentStartOfWeek(now);

    const { stats, unavailable: statsUnavailable } =
      await this.fetchBranchDashboardStats({
        branch_ids: targetBranchIds,
        courier_ids: courierIds,
        start: selectedRange.start?.toISOString() ?? null,
        end: selectedRange.end.toISOString(),
        today_start: todayStart.toISOString(),
        week_start: weekStart.toISOString(),
      });

    const couriersCount = courierIds.length;
    const canSeeAll =
      requesterBranchRole === 'SUPER' ||
      requesterBranchRole === BranchUserRole.MANAGER;
    const canSeeMarkets = canSeeAll;

    const marketsCard = stats.markets.map((row) => ({
      market_id: row.market_id,
      market_name: row.market_name ?? null,
      orders_count: row.orders_count,
      total_price: row.total_price,
    }));

    return successRes(
      {
        // C9: true — order-service javob bermadi, quyidagi nollar HAQIQIY
        // EMAS (FE ularni ko'rsatmaydi, "sahifani yangilang" deydi).
        stats_unavailable: statsUnavailable,
        today_orders_count: stats.today_orders_count,
        week_orders_count: stats.week_orders_count,
        selected_orders_count: stats.selected_orders_count,
        selected_range: {
          startDate: selectedRange.start?.toISOString() ?? null,
          endDate: selectedRange.end.toISOString(),
        },
        active_batches_count: stats.active_batches_count,
        couriers_count: couriersCount,
        role: requesterBranchRole,
        cards: {
          orders: stats.orders_card,
          markets: canSeeMarkets ? marketsCard : null,
          packages: stats.packages,
          couriers: canSeeAll
            ? {
                branch_couriers: couriersCount,
                active_today: stats.active_couriers,
              }
            : null,
        },
        visibility: {
          orders: true,
          markets: canSeeMarkets,
          packages: true,
          couriers: canSeeAll,
        },
      },
      200,
      'Branch stats',
    );
  }

  /** Market kesimi — bazadagi `GROUP BY market_id` (Scale 1-bosqich). */
  async getBranchMarketsAnalytics(id: string, requester?: RequesterContext) {
    const targetBranchIds = await this.resolveAnalyticsBranchIds(id, requester);
    const courierIds = await this.getCourierIdsByBranchIds(targetBranchIds);

    const { stats } = await this.fetchBranchDashboardStats({
      branch_ids: targetBranchIds,
      courier_ids: courierIds,
      start: null,
      end: null,
      today_start: new Date().toISOString(),
      week_start: new Date().toISOString(),
    });

    return successRes(stats.markets, 200, 'Branch market analytics');
  }

  async getBranchesWithNewOrders(requester?: RequesterContext) {
    const scope = await this.resolveAccessScope(requester);

    const where: Record<string, unknown> = { isDeleted: false };
    if (!this.isSystemPrivileged(requester)) {
      const ids = Array.from(scope.readableBranchIds);
      if (!ids.length) {
        return successRes([], 200, 'Branches with NEW orders');
      }
      where.id = In(ids);
    }

    const branches = await this.branchRepo.find({
      where,
      order: { level: 'ASC', createdAt: 'ASC' },
      select: ['id', 'name', 'type', 'level', 'parent_id', 'code', 'status'],
    });

    /**
     * ⚠️ BITTA SO'ROV, FILIAL BOSHIGA EMAS (Scale 1-bosqich).
     *
     * Ilgari bu yerda har filial uchun alohida `order.find_all` chaqirilardi
     * (`fetch_all: true, limit: 5000`) va natijadagi QATORLAR sanalardi —
     * ya'ni faqat "nechta yangi buyurtma bor" degan raqam uchun minglab
     * qator tashilardi. 20 filialda bu 20 ta RMQ chaqiruvi va o'n minglab
     * qator demakdir. Endi bitta `GROUP BY` so'rovi.
     */
    const branchIds = branches.map((branch) => String(branch.id));
    const countsByBranch = new Map<string, number>();
    if (branchIds.length) {
      try {
        const response = await lastValueFrom(
          this.orderClient
            .send<{
              data?: Array<{ branch_id: string; count: number }>;
            }>(
              { cmd: 'order.analytics.count_by_branch' },
              { branch_ids: branchIds, status: Order_status.NEW },
            )
            .pipe(timeout(10000)),
        );
        for (const row of response?.data ?? []) {
          countsByBranch.set(String(row.branch_id), Number(row.count) || 0);
        }
      } catch {
        // Hisob olinmasa ro'yxat bo'sh qaytadi — avvalgi xatti-harakat.
      }
    }

    const items = branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      type: branch.type,
      level: branch.level,
      parent_id: branch.parent_id,
      code: branch.code,
      status: branch.status,
      new_orders_count: countsByBranch.get(String(branch.id)) ?? 0,
    }));

    return successRes(
      items.filter((item) => item.new_orders_count > 0),
      200,
      'Branches with NEW orders',
    );
  }

  private async resolveRequesterBranchRole(
    targetBranchIds: string[],
    requester?: RequesterContext,
  ): Promise<'SUPER' | BranchUserRole | null> {
    if (this.isSystemPrivileged(requester)) {
      return 'SUPER';
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      return null;
    }

    const assignments = await this.branchUserRepo.find({
      where: {
        user_id: requesterId,
        branch_id: In(targetBranchIds),
        isDeleted: false,
      },
      select: ['role'],
    });

    const roles = assignments.map((assignment) =>
      this.normalizeBranchUserRole(assignment.role),
    );

    if (roles.includes(BranchUserRole.MANAGER)) {
      return BranchUserRole.MANAGER;
    }
    if (roles.includes(BranchUserRole.REGISTRATOR)) {
      return BranchUserRole.REGISTRATOR;
    }
    if (roles.includes(BranchUserRole.COURIER)) {
      return BranchUserRole.COURIER;
    }

    return null;
  }

  async updateBranch(
    id: string,
    dto: {
      name?: string;
      location?: string;
      address?: string;
      phone_number?: string;
      region_id?: string | null;
      district_id?: string | null;
      parent_id?: string | null;
      type?: BranchType | string;
      code?: string;
      status?: string;
      manager_id?: string | null;
    },
    requester?: RequesterContext,
  ) {
    await this.assertCanWriteBranch(id, requester);
    const branch = await this.getBranchOrThrow(id);

    const beforeSnapshot = {
      name: branch.name,
      parent_id: branch.parent_id,
      region_id: branch.region_id,
      district_id: branch.district_id,
      manager_id: branch.manager_id,
      status: branch.status,
      type: branch.type,
    };

    if (typeof dto?.name !== 'undefined') {
      const nextName = String(dto.name).trim();
      if (!nextName) {
        this.badRequest("Filial nomi bo'sh bo'lishi mumkin emas");
      }
      if (nextName.toLowerCase() !== (branch.name ?? '').toLowerCase()) {
        await this.ensureBranchNameUnique(nextName, branch.id);
      }
      branch.name = nextName;
    }

    if (
      typeof dto?.address !== 'undefined' ||
      typeof dto?.location !== 'undefined'
    ) {
      branch.address =
        String(dto?.address ?? dto?.location ?? '').trim() || null;
    }

    if (typeof dto?.phone_number !== 'undefined') {
      branch.phone_number = String(dto.phone_number ?? '').trim() || null;
    }

    if (typeof dto?.region_id !== 'undefined') {
      branch.region_id = this.normalizeNullableBigint(dto.region_id);
    }

    if (typeof dto?.district_id !== 'undefined') {
      branch.district_id = this.normalizeNullableBigint(dto.district_id);
    }

    const nextType =
      typeof dto?.type !== 'undefined'
        ? this.parseBranchType(dto.type)
        : branch.type;
    const nextParentId =
      typeof dto?.parent_id !== 'undefined'
        ? this.normalizeNullableBigint(dto.parent_id)
        : branch.parent_id;

    // HQ qulfi. HQ oddiy filialga aylansa, "HQ'da menejer yo'q" qoidasi
    // (assignUserToBranch) chetlab o'tilardi — tahrirlash oynasida tur tanlovi
    // bor. HQ'ning legacy `manager_id` ko'rsatkichiga ham faqat null yozish
    // mumkin (eski qiymatni tozalash uchun).
    if (branch.type === BranchType.HQ && nextType !== BranchType.HQ) {
      this.badRequest("HQ filial turini o'zgartirib bo'lmaydi");
    }
    if (
      nextType === BranchType.HQ &&
      typeof dto?.manager_id !== 'undefined' &&
      this.normalizeNullableBigint(dto.manager_id) !== null
    ) {
      this.badRequest(HQ_MANAGER_FORBIDDEN_MESSAGE);
    }

    if (typeof dto?.code !== 'undefined') {
      const nextCode = this.normalizeBranchCode(dto.code);
      await this.ensureBranchCodeUnique(nextCode, branch.id);
      branch.code = nextCode;
    }

    if (nextType === BranchType.HQ) {
      if (nextParentId) {
        this.badRequest("HQ filialning ota filiali (parent_id) bo'lmaydi");
      }

      const existingHq = await this.branchRepo.findOne({
        where: { type: BranchType.HQ, isDeleted: false },
      });
      if (existingHq && existingHq.id !== branch.id) {
        this.conflict("Tizimda faqat bitta HQ filial bo'lishi mumkin");
      }

      branch.parent_id = null;
      branch.level = 0;
    } else {
      if (!nextParentId) {
        this.badRequest(
          "HQ bo'lmagan filial uchun ota filial (parent_id) majburiy",
        );
      }

      await this.ensureNotCyclicParent(branch.id, nextParentId);
      const parent = await this.getParentBranchOrThrow(nextParentId);

      branch.parent_id = parent.id;
      branch.level = Number(parent.level) + 1;
    }

    branch.type = nextType;
    if (typeof dto?.manager_id !== 'undefined') {
      branch.manager_id = this.normalizeNullableBigint(dto.manager_id);
    }

    if (typeof dto?.status !== 'undefined') {
      branch.status = this.parseStatus(dto.status) ?? branch.status;
    }

    // CODE-20: kuryerlar (va ochiq ishlar) turgan filialning turi, holati
    // yoki hududi ularni "osilib" qoldiradigan tarzda o'zgarmaydi. Hech narsa
    // yozilishidan OLDIN.
    await this.assertBranchUpdateKeepsCouriersAndWork(String(branch.id), {
      before: beforeSnapshot,
      after: branch,
    });

    const saved = await this.branchRepo.save(branch);
    await this.rebalanceDescendantLevels(saved.id, saved.level);

    await this.activityLog.logChange({
      entity_type: 'Branch',
      entity_id: String(saved.id),
      action: ActivityAction.UPDATED,
      old_value: beforeSnapshot,
      new_value: {
        name: saved.name,
        parent_id: saved.parent_id,
        region_id: saved.region_id,
        district_id: saved.district_id,
        manager_id: saved.manager_id,
        status: saved.status,
        type: saved.type,
      },
      ...this.auditActor(requester),
    });

    return successRes(saved, 200, 'Branch updated');
  }

  /**
   * CODE-20 — updateBranch to'sig'i. Faqat filialda ishlayotganlarni osilib
   * qoldiradigan o'zgarishlar tekshiriladi:
   *   - tur kuryer saqlay olmaydigan turga (PICKUP) o'zgarsa — PICKUP pochta
   *     ham, partiya ham qabul qilmaydi, unga kuryer biriktirilmaydi;
   *   - filial nofaol qilinsa — nofaol filialga pochta jo'natilmaydi, kuryer
   *     o'tkazilmaydi;
   *   - hudud o'zgarsa — kuryerning identity'dagi hududi filialniki bilan
   *     bir xil bo'lishi kerak (R3), aks holda eskirib qoladi.
   * Kuryer qatori bor — 409. Tur/holat uchun yakunlanmagan buyurtma yoki faol
   * partiya bor — 409; buni tekshirib bo'lmasa — 503 (fail-closed). REGIONAL ↔
   * HYBRID va boshqa maydonlar (nom, telefon, ota filial...) tekshirilmaydi.
   */
  private async assertBranchUpdateKeepsCouriersAndWork(
    branchId: string,
    change: {
      before: { type: BranchType; status: Status; region_id: string | null };
      after: { type: BranchType; status: Status; region_id: string | null };
    },
  ): Promise<void> {
    const { before, after } = change;
    const courierHostTypes: ReadonlySet<string> = new Set<string>([
      BranchType.HQ,
      BranchType.REGIONAL,
      BranchType.HYBRID,
    ]);
    const losesCourierHosting =
      before.type !== after.type && !courierHostTypes.has(after.type);
    const deactivates =
      before.status !== Status.INACTIVE && after.status === Status.INACTIVE;
    const regionChanges =
      String(before.region_id ?? '').trim() !==
      String(after.region_id ?? '').trim();
    if (!losesCourierHosting && !deactivates && !regionChanges) {
      return;
    }

    const action = losesCourierHosting
      ? `filial turini ${after.type} ga o'zgartirib bo'lmaydi`
      : deactivates
        ? "filialni nofaol qilib bo'lmaydi"
        : "filial hududini o'zgartirib bo'lmaydi (kuryer hududi filialga ergashadi)";

    const couriers = await this.branchUserRepo.count({
      where: {
        branch_id: branchId,
        role: BranchUserRole.COURIER,
        isDeleted: false,
      },
    });
    if (couriers > 0) {
      this.conflict(
        `Filialga ${couriers} ta kuryer biriktirilgan — ${action}. Avval kuryerlarni boshqa filialga o'tkazing yoki filialdan chiqaring`,
      );
    }

    if (!losesCourierHosting && !deactivates) {
      return;
    }
    let work: { orders: number; batches: number };
    try {
      work = await this.loadBranchOpenWork(branchId);
    } catch (error) {
      this.logger.warn(
        `updateBranch: order.branch_can_delete failed (branch=${branchId}): ${this.describeRpcFailure(error)}`,
      );
      throw new RpcException(
        errorRes(
          "Filialdagi yakunlanmagan buyurtmalarni tekshirib bo'lmadi (buyurtmalar xizmati javob bermadi) — o'zgarish saqlanmadi. Birozdan so'ng qayta urinib ko'ring",
          503,
        ),
      );
    }
    if (work.orders > 0 || work.batches > 0) {
      this.conflict(
        `Filialda ${work.orders} ta yakunlanmagan buyurtma va ${work.batches} ta faol partiya bor — ${action}. Avval ularni yakunlang`,
      );
    }
  }

  /**
   * Filialga bog'langan yakunlanmagan buyurtmalar va faol partiyalar
   * (`order.branch_can_delete`). Xato yoki buzuq javob — throw.
   */
  private async loadBranchOpenWork(
    branchId: string,
  ): Promise<{ orders: number; batches: number }> {
    const response = await lastValueFrom(
      this.orderClient
        .send<{
          data?: { active_orders?: unknown; active_batches?: unknown } | null;
        }>({ cmd: 'order.branch_can_delete' }, { branch_id: branchId })
        .pipe(timeout(5000)),
    );
    const data = response?.data;
    const orders = Number(data?.active_orders);
    const batches = Number(data?.active_batches);
    if (
      !data ||
      !Number.isFinite(orders) ||
      orders < 0 ||
      !Number.isFinite(batches) ||
      batches < 0
    ) {
      throw new Error("order.branch_can_delete: javob shakli noto'g'ri");
    }
    return { orders, batches };
  }

  async deleteBranch(id: string, requester?: RequesterContext) {
    await this.assertCanWriteBranch(id, requester);
    const branch = await this.getBranchOrThrow(id);

    if (await this.hasActiveChildren(branch.id)) {
      this.badRequest(
        "Ichki (bola) filiallari bor filialni o'chirib bo'lmaydi — avval ularni o'chiring yoki boshqa filialga ko'chiring",
      );
    }

    const activeUsers = await this.branchUserRepo.count({
      where: { branch_id: branch.id, isDeleted: false },
    });
    if (activeUsers > 0) {
      this.badRequest(
        `Filialni o'chirib bo'lmaydi — unga ${activeUsers} ta faol xodim biriktirilgan. Avval ularni boshqa filialga o'tkazing yoki filialdan chiqaring.`,
      );
    }

    type CanDeleteShape = {
      active_orders?: number;
      active_batches?: number;
    };
    let canDelete: CanDeleteShape | null = null;
    try {
      const response = await lastValueFrom(
        this.orderClient
          .send<{
            data?: CanDeleteShape;
          }>({ cmd: 'order.branch_can_delete' }, { branch_id: branch.id })
          .pipe(timeout(5000)),
      );
      canDelete = response?.data ?? null;
    } catch (error) {
      this.logger.warn(
        `deleteBranch: order.branch_can_delete failed (branch=${String(branch.id)}): ${this.describeRpcFailure(error)}`,
      );
      this.badRequest(
        "Filialni o'chirib bo'lmaydi — buyurtmalar xizmati javob bermadi, filialdagi faol buyurtmalarni tekshirib bo'lmadi. Birozdan so'ng qayta urinib ko'ring",
      );
    }

    if (canDelete) {
      const orders = Number(canDelete.active_orders ?? 0);
      const batches = Number(canDelete.active_batches ?? 0);
      if (orders > 0 || batches > 0) {
        this.badRequest(
          `Filialni o'chirib bo'lmaydi — unga ${orders} ta yakunlanmagan buyurtma va ${batches} ta faol partiya bog'langan.`,
        );
      }
    }

    const deletedName = branch.name;
    const deletedCode = branch.code;

    branch.isDeleted = true;
    branch.status = Status.INACTIVE;
    await this.branchRepo.save(branch);

    await this.activityLog.log({
      entity_type: 'Branch',
      entity_id: String(branch.id),
      action: ActivityAction.DELETED,
      old_value: { name: deletedName, code: deletedCode },
      ...this.auditActor(requester),
    });

    return successRes({ id }, 200, 'Branch deleted');
  }

  async assignUserToBranch(
    data: { branch_id?: string; user_id?: string; role?: string },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const userId = String(data?.user_id ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id majburiy');
    }
    if (!userId) {
      this.badRequest('user_id majburiy');
    }

    await this.assertCanWriteBranch(branchId, requester);

    const branch = await this.getBranchOrThrow(branchId);
    const user = await this.ensureUserExists(userId);
    const derivedRole = this.resolveBranchRoleFromUserRole(user.role);
    const requestedRole = String(data?.role ?? '').trim()
      ? this.normalizeBranchUserRole(data?.role)
      : null;
    if (requestedRole && requestedRole !== derivedRole) {
      this.badRequest(
        `Berilgan role user roli bilan mos emas. User roli: ${derivedRole}`,
      );
    }
    const role = derivedRole;

    // HQ'da menejer bo'lmaydi. Tekshiruv so'rovchiga bog'liq EMAS (ichki saga
    // chaqiruvlari ham) va o'chirilgan qatorni tiklash hamda
    // ensureBranchCashbox'dan OLDIN turadi — HQ uchun 'branch' kassasi hech
    // qachon yaratilmaydi. HQ REGISTRATOR va COURIER ruxsati saqlanadi.
    if (role === BranchUserRole.MANAGER && branch.type === BranchType.HQ) {
      this.badRequest(HQ_MANAGER_FORBIDDEN_MESSAGE);
    }

    if (role === BranchUserRole.COURIER) {
      const requesterRoles = (requester?.roles ?? []).map((item) =>
        String(item ?? '')
          .trim()
          .toLowerCase(),
      );
      const isSystemPrivileged =
        requesterRoles.includes('superadmin') ||
        requesterRoles.includes('admin');

      if (
        branch.type !== BranchType.HQ &&
        branch.type !== BranchType.REGIONAL &&
        branch.type !== BranchType.HYBRID
      ) {
        this.forbidden(
          'Courier faqat HQ, REGIONAL yoki HYBRID branchga biriktirilishi mumkin',
        );
      }

      if (!isSystemPrivileged) {
        const managerAssignment = await this.branchUserRepo.findOne({
          where: {
            user_id: String(requester?.id ?? '').trim(),
            branch_id: branchId,
            isDeleted: false,
          },
          select: ['id', 'role'],
        });

        if (
          !managerAssignment ||
          this.normalizeBranchUserRole(managerAssignment.role) !==
            BranchUserRole.MANAGER
        ) {
          this.forbidden(
            'Courier biriktirish uchun ushbu branchda MANAGER bo‘lish kerak',
          );
        }
      }
    }

    const anotherBranch = await this.branchUserRepo.findOne({
      where: {
        user_id: userId,
        isDeleted: false,
      },
    });
    if (anotherBranch && anotherBranch.branch_id !== branchId) {
      this.conflict(
        "Foydalanuvchi boshqa filialga biriktirilgan — avval uni o'sha filialdan chiqaring",
      );
    }

    const existing = await this.branchUserRepo.findOne({
      where: { branch_id: branchId, user_id: userId },
    });

    if (existing && !existing.isDeleted) {
      this.conflict('Foydalanuvchi bu filialga allaqachon biriktirilgan');
    }

    // R3: filialsiz (yetim) kuryerni BOSHQA filialga biriktirish — amalda
    // o'tkazish (bugungi yagona yo'l: chiqarish + biriktirish). Oldin boshqa
    // filialda bo'lgan bo'lsa, qo'lida pul ham, buyurtma ham qolmagan bo'lishi
    // SHART. Qatori umuman yo'q kuryer (yaratish saga'si — kassasi hali
    // yaratilmagan) yoki faqat shu filialda bo'lgan kuryer uchun tashqi
    // chaqiruv yo'q: yaratish sekinlashmaydi va 503 rejimini olmaydi.
    if (role === BranchUserRole.COURIER) {
      const priorRows =
        (await this.branchUserRepo.find({
          where: { user_id: userId, isDeleted: true },
          select: ['id', 'branch_id'],
        })) ?? [];
      if (
        priorRows.some((row) => String(row.branch_id) !== String(branch.id))
      ) {
        await this.assertCourierHoldsNothing(
          userId,
          null,
          COURIER_REHOME_BLOCKED_PREFIX,
        );
      }
    }

    if (existing) {
      existing.isDeleted = false;
      existing.role = role;
      const revived = await this.branchUserRepo.save(existing);
      if (role === BranchUserRole.MANAGER) {
        await this.ensureBranchCashbox(branchId);
      }
      await this.activityLog.log({
        entity_type: 'BranchUser',
        entity_id: String(branchId),
        action: ActivityAction.ASSIGN,
        metadata: { user_id: userId, role },
        ...this.auditActor(requester),
      });
      return successRes(revived, 200, 'Branch user assigned');
    }

    const saved = await this.branchUserRepo.save(
      this.branchUserRepo.create({
        branch_id: branchId,
        user_id: userId,
        role,
      }),
    );

    if (role === BranchUserRole.MANAGER) {
      await this.ensureBranchCashbox(branchId);
    }
    await this.activityLog.log({
      entity_type: 'BranchUser',
      entity_id: String(branchId),
      action: ActivityAction.ASSIGN,
      metadata: { user_id: userId, role },
      ...this.auditActor(requester),
    });

    return successRes(saved, 201, 'Branch user assigned');
  }

  async removeUserFromBranch(
    data: { branch_id?: string; user_id?: string },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const userId = String(data?.user_id ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id majburiy');
    }
    if (!userId) {
      this.badRequest('user_id majburiy');
    }

    await this.assertCanWriteBranch(branchId, requester);

    const row = await this.branchUserRepo.findOne({
      where: { branch_id: branchId, user_id: userId, isDeleted: false },
    });
    if (!row) {
      this.notFound('Foydalanuvchi bu filialga biriktirilmagan');
    }

    // R3: kuryerni filialdan chiqarish — faqat qo'lida pul ham, buyurtma ham
    // qolmaganda (aks holda uning pulini qabul qiladigan menejer qolmaydi,
    // posilkalari esa qotib qoladi). Menejer/registrator qatorlari o'zgarmagan.
    if (this.isBranchUserRoleOneOf(row.role, [BranchUserRole.COURIER])) {
      const branch = await this.branchRepo.findOne({
        where: { id: branchId, isDeleted: false },
      });
      await this.assertCourierHoldsNothing(
        userId,
        branch ?? null,
        COURIER_UNASSIGN_BLOCKED_PREFIX,
        { closeNetZeroRows: true, requester },
      );
    }

    row.isDeleted = true;
    await this.branchUserRepo.save(row);

    await this.activityLog.log({
      entity_type: 'BranchUser',
      entity_id: String(branchId),
      action: ActivityAction.UNASSIGN,
      metadata: { user_id: userId },
      ...this.auditActor(requester),
    });

    return successRes(
      { branch_id: branchId, user_id: userId },
      200,
      'Branch user removed',
    );
  }

  /**
   * R3 — kuryerni o'tkazish tekshiruvi (FAQAT O'QIYDI). Faqat superadmin/admin:
   * javobda kuryerning pul raqamlari bor (filiallar kesimida). To'siqlar xato
   * EMAS — 200 + `reasons` + `can_transfer` (FE oynasi ko'rsatadi); manba
   * javob bermasa — 503. identity `deleteUser` ham shu RPC'ni chaqiradi.
   */
  async courierTransferCheck(
    data: { user_id?: string },
    requester?: RequesterContext,
  ) {
    try {
      return await this.buildCourierTransferCheck(data, requester);
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }
      // Xom (baza) xato RMQ'da qayta navbatga qo'yilardi — RpcException'ga.
      this.logger.error(
        `courier transfer check failed (user=${String(data?.user_id ?? '')}): ${this.describeRpcFailure(error)}`,
      );
      throw new RpcException(errorRes(COURIER_CHECK_UNAVAILABLE_MESSAGE, 503));
    }
  }

  private async buildCourierTransferCheck(
    data: { user_id?: string },
    requester?: RequesterContext,
  ) {
    if (!this.isSystemPrivileged(requester)) {
      this.forbidden(COURIER_CHECK_FORBIDDEN_MESSAGE);
    }
    const userId = this.parseCourierTransferId(
      data?.user_id,
      "user_id noto'g'ri",
    );
    await this.assertIsCourierUser(userId);

    const [currentBranch, hqBranch, holdings] = await Promise.all([
      this.findActiveBranchUserRow(userId).then((row) =>
        this.findBranchOfRow(row),
      ),
      this.findHqBranchRow(),
      this.loadCourierHoldings(userId),
    ]);
    const reasons = this.describeCourierHoldings(holdings, currentBranch);

    return successRes(
      {
        user_id: userId,
        current_branch: currentBranch
          ? {
              id: String(currentBranch.id),
              name: currentBranch.name,
              type: currentBranch.type,
            }
          : null,
        hq_branch: hqBranch
          ? { id: String(hqBranch.id), name: hqBranch.name }
          : null,
        has_cashbox: holdings.has_cashbox,
        balance: holdings.balance,
        balance_cash: holdings.balance_cash,
        balance_card: holdings.balance_card,
        pending_settlement_count: holdings.pending_settlement_count,
        pending_settlement_amount: holdings.pending_settlement_amount,
        carry_amount: holdings.carry_amount,
        orders_in_hand: holdings.orders_in_hand,
        orders_sample: holdings.orders_sample,
        open_return_posts: holdings.open_return_posts,
        return_posts_sample: holdings.return_posts_sample,
        pending_extra_cost_approvals: holdings.pending_extra_cost_approvals,
        reasons,
        can_transfer: reasons.length === 0,
      },
      200,
      "Kuryer o'tkazish tekshiruvi",
    );
  }

  /**
   * R3 — kuryerni boshqa filialga o'tkazish (faqat superadmin/admin). Kuryer
   * qo'lida pul ham, buyurtma ham qolmagan bo'lishi SHART.
   *
   * Tartib:
   *   1. oldindan tekshiruv (to'siq → 409, manba javob bermasa → 503; hech
   *      narsa yozilmaydi) — HQ bo'lmagan maqsadda u bilan PARALLEL maqsad
   *      filialning FAOL menejeri tekshiriladi (yo'q → 400, identity javob
   *      bermasa → 503);
   *   2. qator almashtirish — bitta tranzaksiya, qulf bilan (swap);
   *   3. 1,5 s kutib QAYTA tekshiruv: swap'dan sal oldin a'zolikni o'qigan
   *      biriktirish/skan o'z yozuvini tugatgan bo'lsa, shu yerda ko'rinadi →
   *      o'zgarish qaytariladi (409 REVERTED / 503);
   *   4. identity'da hudud — yangi filialniki (HQ'da odatda null), `deadline_at`
   *      bilan; yiqilsa — qaytariladi, eski hudud tiklashga urinib ko'riladi
   *      (muddatsiz), 503;
   *   5. audit.
   * Qaytarishning o'zi yiqilsa — 500 (administrator tekshirishi kerak).
   *
   * ⚠️ RpcException bo'lmagan HAR QANDAY xato (swap'dan oldingi baza o'qishi
   * ham) 503'ga o'raladi: xom xatoda RMQ xabarni qayta navbatga qo'yadi va
   * ikkinchi urinish mijoz allaqachon xato olganidan keyin kuryerni jimgina
   * o'tkazib yuborishi mumkin edi.
   */
  async transferCourierToBranch(
    data: { user_id?: string; branch_id?: string },
    requester?: RequesterContext,
  ) {
    try {
      return await this.performCourierTransfer(data, requester);
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }
      this.logger.error(
        `courier transfer failed (user=${String(data?.user_id ?? '')}, to=${String(data?.branch_id ?? '')}): ${this.describeRpcFailure(error)}`,
      );
      throw new RpcException(errorRes(COURIER_TRANSFER_TX_FAILED_MESSAGE, 503));
    }
  }

  private async performCourierTransfer(
    data: { user_id?: string; branch_id?: string },
    requester?: RequesterContext,
  ) {
    if (!this.isSystemPrivileged(requester)) {
      this.forbidden(COURIER_TRANSFER_FORBIDDEN_MESSAGE);
    }
    const userId = this.parseCourierTransferId(
      data?.user_id,
      "user_id noto'g'ri",
    );
    const targetId = this.parseCourierTransferId(
      data?.branch_id,
      "branch_id noto'g'ri",
    );
    const courier = await this.assertIsCourierUser(userId);

    // getBranchOrThrow ATAYLAB ishlatilmaydi — uning 404 matni inglizcha.
    const target = await this.branchRepo.findOne({
      where: { id: targetId, isDeleted: false },
    });
    if (!target) {
      this.notFound(COURIER_TARGET_NOT_FOUND_MESSAGE);
    }
    if (target.status !== Status.ACTIVE) {
      this.badRequest(COURIER_TARGET_INACTIVE_MESSAGE);
    }
    if (
      target.type !== BranchType.HQ &&
      target.type !== BranchType.REGIONAL &&
      target.type !== BranchType.HYBRID
    ) {
      this.badRequest(
        `Kuryer faqat HQ, REGIONAL yoki HYBRID filialga o'tkaziladi (tanlangan filial turi: ${target.type})`,
      );
    }
    // Menejersiz filialda kuryerning keyingi pulini qonuniy qabul qiladigan
    // odam yo'q (superadmin filial kuryeridan pul olmaydi). HQ'da menejer
    // bo'lmaydi — u yerda pulni superadmin/admin Asosiy kassaga oladi.
    // Qator yo'qligi — darhol 400 (tashqi chaqiruvsiz); qatori borlarning
    // identity'dagi holati (faol, o'chirilmagan) quyida, oldindan tekshiruv
    // bilan PARALLEL tekshiriladi.
    const needsActiveManager = target.type !== BranchType.HQ;
    const managerUserIds = needsActiveManager
      ? await this.findBranchManagerUserIds(String(target.id))
      : [];
    if (needsActiveManager && !managerUserIds.length) {
      this.badRequest(
        `'${target.name}' filialida menejer yo'q — kuryer pulini qabul qiladigan odam bo'lmaydi. Avval filialga menejer biriktiring`,
      );
    }

    const targetBranchId = String(target.id);
    const targetRegionId = String(target.region_id ?? '').trim() || null;
    const currentRow = await this.findActiveBranchUserRow(userId);
    if (currentRow && String(currentRow.branch_id) === targetBranchId) {
      // Kuryer allaqachon shu filialda, lekin hududi farq qiladi — masalan,
      // swap yozilib, servis `set_region` dan oldin qulagan va RMQ xabarni
      // qayta yetkazgan. Hudud best-effort moslanadi, javob baribir 409.
      if (courier.region_id !== targetRegionId) {
        await this.setCourierRegionBestEffort(
          userId,
          targetRegionId,
          requester,
          COURIER_REGION_SYNC_TIMEOUT_MS,
          'same_branch_resync',
        );
      }
      this.conflict(COURIER_ALREADY_IN_BRANCH_MESSAGE);
    }
    const currentBranch = await this.findBranchOfRow(currentRow);

    // Faol menejer va oldindan tekshiruv PARALLEL — eng yomon holat o'smaydi
    // (vaqt byudjeti: COURIER_HOLDINGS_RPC_TIMEOUT_MS izohi). Xato ustuvorligi
    // ketma-ket tartibdagidek: avval maqsad filial (400/503), keyin kuryer
    // qo'lidagilar (503/409).
    const [targetManagerCheck, holdingsCheck] = await Promise.allSettled([
      needsActiveManager
        ? this.assertTransferTargetHasActiveManager(target, managerUserIds)
        : Promise.resolve(),
      this.assertCourierHoldsNothing(
        userId,
        currentBranch,
        COURIER_TRANSFER_BLOCKED_PREFIX,
        { closeNetZeroRows: true, requester },
      ),
    ]);
    for (const outcome of [targetManagerCheck, holdingsCheck]) {
      if (outcome.status === 'rejected') {
        throw outcome.reason;
      }
    }

    const swap = await this.swapCourierBranchRow(
      userId,
      currentRow ? String(currentRow.id) : null,
      targetBranchId,
    );

    await this.waitBeforeCourierTransferRecheck();

    // Sabab matnlari ESKI filial bo'yicha: o'zgarish qaytariladi, pulni eski
    // filial (yoki HQ) qabul qiladi.
    let recheckReasons: string[];
    try {
      recheckReasons = this.describeCourierHoldings(
        await this.loadCourierHoldings(userId),
        currentBranch,
      );
    } catch (error) {
      await this.revertCourierBranchSwap(
        userId,
        swap,
        requester,
        'recheck_unavailable',
      );
      throw error;
    }
    if (recheckReasons.length) {
      await this.revertCourierBranchSwap(
        userId,
        swap,
        requester,
        'recheck_blocked',
      );
      this.conflict(
        COURIER_TRANSFER_REVERTED_PREFIX + recheckReasons.join(' '),
      );
    }

    try {
      // `timeout` RMQ xabarini bekor qilmaydi: identity navbati orqada qolsa,
      // set_region(yangi) bu yerda vaqt tugab, o'tkazish qaytarilganidan KEYIN
      // ham bajarilishi mumkin edi. `deadline_at` (yuborish vaqti + shu
      // timeout) dan keyin identity — qator qulfini olgach — hududni YOZMAYDI
      // (409). Servislar bitta xost soatida.
      const deadlineAt = Date.now() + COURIER_REGION_SYNC_TIMEOUT_MS;
      await lastValueFrom(
        this.identityClient
          .send(
            { cmd: 'identity.courier.set_region' },
            {
              id: userId,
              region_id: targetRegionId,
              requester,
              deadline_at: deadlineAt,
            },
          )
          .pipe(timeout(COURIER_REGION_SYNC_TIMEOUT_MS)),
      );
    } catch (error) {
      this.logger.warn(
        `identity.courier.set_region failed (courier=${userId}, region=${targetRegionId ?? 'null'}): ${this.describeRpcFailure(error)}`,
      );
      await this.revertCourierBranchSwap(
        userId,
        swap,
        requester,
        'region_sync_failed',
      );
      // Tiklash: filiali bor kuryer — eski filial hududi (hudud filialga
      // ergashadi); filialsiz kuryer — o'tkazishdan OLDIN identity'dan
      // o'qilgan hududi. Tiklash MUDDATSIZ yuboriladi: identity qulfi tufayli
      // u yo yarim yo'lda qolgan set_region(yangi) tugashini kutib uni ustidan
      // yozadi, yo undan oldin bajariladi — u holda kech kelgan set_region
      // muddati o'tganini ko'rib hech narsa yozmaydi.
      await this.setCourierRegionBestEffort(
        userId,
        currentBranch
          ? String(currentBranch.region_id ?? '').trim() || null
          : courier.region_id,
        requester,
        COURIER_REGION_RESTORE_TIMEOUT_MS,
        'restore',
      );
      throw new RpcException(errorRes(COURIER_REGION_SYNC_FAILED_MESSAGE, 503));
    }

    if (swap.fromBranchId) {
      await this.activityLog.log({
        entity_type: 'BranchUser',
        entity_id: swap.fromBranchId,
        action: ActivityAction.UNASSIGN,
        metadata: {
          user_id: userId,
          role: BranchUserRole.COURIER,
          reason: 'courier_transfer',
          to_branch_id: targetBranchId,
        },
        ...this.auditActor(requester),
      });
    }
    await this.activityLog.log({
      entity_type: 'BranchUser',
      entity_id: targetBranchId,
      action: ActivityAction.ASSIGN,
      metadata: {
        user_id: userId,
        role: BranchUserRole.COURIER,
        reason: 'courier_transfer',
        from_branch_id: swap.fromBranchId,
      },
      ...this.auditActor(requester),
    });
    await this.activityLog.log({
      entity_type: 'User',
      entity_id: userId,
      action: 'courier_transfer',
      old_value: { branch_id: swap.fromBranchId },
      new_value: { branch_id: targetBranchId, region_id: targetRegionId },
      ...this.auditActor(requester),
    });

    return successRes(
      {
        user_id: userId,
        from_branch_id: swap.fromBranchId,
        to_branch_id: targetBranchId,
        region_id: targetRegionId,
      },
      200,
      `Kuryer '${target.name}' filialiga o'tkazildi`,
    );
  }

  /**
   * Kuryer qatorini BITTA tranzaksiyada almashtiradi. Foydalanuvchining HAMMA
   * qatorlari `FOR UPDATE` bilan qulflanadi: ikki marta bosish va parallel
   * o'tkazishlar ketma-ket bajariladi — ikkinchisi o'zgargan faol qatorni
   * ko'rib 409 oladi. Faol qator oldindan tekshiruvdagi bilan bir xil
   * bo'lishi SHART.
   *
   * ⚠️ TARTIB MUHIM: eski faol qator AVVAL o'chiriladi — `user_id` bo'yicha
   * qisman unique indeks (is_deleted = false) aks holda yangi/tiklangan
   * qatorni rad etadi. Keyin maqsad filialdagi eng oxirgi o'chirilgan qator
   * tiklanadi (rol — COURIER), bo'lmasa yangisi yoziladi.
   *
   * RpcException bo'lmagan har qanday xato (23505 ham) — 503: xom xato RMQ'da
   * qayta navbatga qo'yilib, o'tkazish ikki marta ishga tushardi.
   */
  private async swapCourierBranchRow(
    userId: string,
    expectedActiveRowId: string | null,
    targetBranchId: string,
  ): Promise<CourierBranchSwap> {
    try {
      return await this.branchUserRepo.manager.transaction(async (manager) => {
        const repo = manager.getRepository(BranchUser);
        const rows =
          (await repo.find({
            where: { user_id: userId },
            order: { updatedAt: 'DESC' },
            lock: { mode: 'pessimistic_write' },
          })) ?? [];
        const activeRows = rows.filter((row) => !row.isDeleted);
        const active = activeRows[0] ?? null;
        if (
          activeRows.length > 1 ||
          String(active?.id ?? '') !== String(expectedActiveRowId ?? '')
        ) {
          this.conflict(COURIER_ROW_CHANGED_MESSAGE);
        }

        if (active) {
          active.isDeleted = true;
          await repo.save(active);
        }

        const revivable = rows.find(
          (row) =>
            row !== active &&
            row.isDeleted &&
            String(row.branch_id) === targetBranchId,
        );
        let saved: BranchUser;
        if (revivable) {
          revivable.isDeleted = false;
          revivable.role = BranchUserRole.COURIER;
          saved = await repo.save(revivable);
        } else {
          saved = await repo.save(
            repo.create({
              branch_id: targetBranchId,
              user_id: userId,
              role: BranchUserRole.COURIER,
            }),
          );
        }

        return {
          fromRowId: active ? String(active.id) : null,
          fromBranchId: active ? String(active.branch_id) : null,
          toRowId: String(saved.id),
          toBranchId: targetBranchId,
        };
      });
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }
      this.logger.error(
        `courier transfer swap failed (courier=${userId}, to=${targetBranchId}): ${this.describeRpcFailure(error)}`,
      );
      throw new RpcException(errorRes(COURIER_TRANSFER_TX_FAILED_MESSAGE, 503));
    }
  }

  /**
   * O'tkazishni QAYTARADI — xuddi shu qulf bilan: AVVAL yangi qator o'chiriladi,
   * keyin eski qator (faqat boshqa faol qator bo'lmasa) tiklanadi. Filialsiz
   * kuryerda faqat yangi qator o'chiriladi. Qaytarishning o'zi yiqilsa — 500:
   * kuryer holatini administrator qo'lda tekshirishi kerak.
   */
  private async revertCourierBranchSwap(
    userId: string,
    swap: CourierBranchSwap,
    requester: RequesterContext | undefined,
    reason: string,
  ): Promise<void> {
    let fromRowRestored = false;
    try {
      await this.branchUserRepo.manager.transaction(async (manager) => {
        const repo = manager.getRepository(BranchUser);
        const rows =
          (await repo.find({
            where: { user_id: userId },
            order: { updatedAt: 'DESC' },
            lock: { mode: 'pessimistic_write' },
          })) ?? [];

        const toRow = rows.find((row) => String(row.id) === swap.toRowId);
        if (toRow && !toRow.isDeleted) {
          toRow.isDeleted = true;
          await repo.save(toRow);
        }

        if (!swap.fromRowId) {
          return;
        }
        const fromRow = rows.find((row) => String(row.id) === swap.fromRowId);
        const anotherActive = rows.some(
          (row) => row !== fromRow && !row.isDeleted,
        );
        if (fromRow && fromRow.isDeleted && !anotherActive) {
          fromRow.isDeleted = false;
          await repo.save(fromRow);
          fromRowRestored = true;
        }
      });
    } catch (error) {
      this.logger.error(
        `courier transfer revert FAILED (courier=${userId}, reason=${reason}): ${this.describeRpcFailure(error)}`,
      );
      await this.activityLog.log({
        entity_type: 'User',
        entity_id: userId,
        action: 'courier_transfer_revert_failed',
        metadata: {
          reason,
          from_branch_id: swap.fromBranchId,
          to_branch_id: swap.toBranchId,
        },
        ...this.auditActor(requester),
      });
      throw new RpcException(
        errorRes(
          `Kuryerni oldingi filialiga qaytarib bo'lmadi — administrator tekshirishi kerak (kuryer #${userId})`,
          500,
        ),
      );
    }

    await this.activityLog.log({
      entity_type: 'User',
      entity_id: userId,
      action: 'courier_transfer_reverted',
      metadata: {
        reason,
        from_branch_id: swap.fromBranchId,
        to_branch_id: swap.toBranchId,
        from_row_restored: fromRowRestored,
      },
      ...this.auditActor(requester),
    });
  }

  /**
   * Qayta tekshiruvdan oldingi kutish (COURIER_TRANSFER_RECHECK_DELAY_MS).
   * `protected` — testlarda stub qilinadi. RMQ prefetch har consumer uchun 20,
   * shuning uchun bu kutish navbatni to'sib qo'ymaydi.
   */
  protected async waitBeforeCourierTransferRecheck(): Promise<void> {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, COURIER_TRANSFER_RECHECK_DELAY_MS),
    );
  }

  /**
   * `identity.courier.set_region` — xatosi FAQAT log qilinadi (eski hududni
   * tiklash va "allaqachon shu filialda" yo'lidagi qayta moslash uchun).
   * ATAYLAB `deadline_at` siz: ikkala holatda ham yoziladigan qiymat to'g'ri
   * yakuniy holat, kech bajarilsa ham zarari yo'q.
   */
  private async setCourierRegionBestEffort(
    userId: string,
    regionId: string | null,
    requester: RequesterContext | undefined,
    timeoutMs: number,
    context: string,
  ): Promise<void> {
    try {
      await lastValueFrom(
        this.identityClient
          .send(
            { cmd: 'identity.courier.set_region' },
            { id: userId, region_id: regionId, requester },
          )
          .pipe(timeout(timeoutMs)),
      );
    } catch (error) {
      this.logger.warn(
        `identity.courier.set_region (${context}) failed (courier=${userId}, region=${regionId ?? 'null'}): ${this.describeRpcFailure(error)}`,
      );
    }
  }

  async findUsersByBranch(branch_id: string, requester?: RequesterContext) {
    const branchId = String(branch_id ?? '').trim();
    if (!branchId) {
      this.badRequest('branch_id majburiy');
    }

    await this.assertCanReadBranch(branchId, requester);

    await this.getBranchOrThrow(branchId);

    const users = await this.branchUserRepo.find({
      where: { branch_id: branchId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });

    const userIds = Array.from(
      new Set(
        users
          .map((item) => item.user_id)
          .filter((userId): userId is string => Boolean(userId)),
      ),
    );
    const userMap = await this.getUsersByIds(userIds);

    const enrichedUsers = users.map((item) => {
      const user = userMap.get(item.user_id) as Record<string, unknown> | null;
      return {
        ...item,
        role: item.role ?? (typeof user?.role === 'string' ? user.role : null),
        user,
      };
    });

    return successRes(enrichedUsers, 200, 'Branch users');
  }

  async findUserBranch(user_id: string, requester?: RequesterContext) {
    const userId = String(user_id ?? '').trim();
    if (!userId) {
      this.badRequest('user_id majburiy');
    }

    if (!this.isSystemPrivileged(requester)) {
      const requesterId = String(requester?.id ?? '').trim();
      if (!requesterId) {
        this.forbidden('Requester aniqlanmadi');
      }
      if (requesterId !== userId) {
        this.forbidden(
          'Boshqa foydalanuvchining filialini ko‘rishga ruxsat yo‘q',
        );
      }
    }

    const assignment = await this.branchUserRepo.findOne({
      where: { user_id: userId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });

    if (!assignment) {
      return successRes(null, 200, 'User branch assignment');
    }

    await this.assertCanReadBranch(String(assignment.branch_id), requester);

    const branch = await this.branchRepo.findOne({
      where: { id: String(assignment.branch_id), isDeleted: false },
    });

    return successRes(
      {
        ...assignment,
        branch: branch ?? null,
      },
      200,
      'User branch assignment',
    );
  }

  /**
   * Menejerning kassa doirasi — finance-gateway kassa ko'rish va kuryerdan
   * pul qabul qilish (POST /finance/cashbox/payment/courier) ruxsati uchun.
   *
   * C3 (M7/RBAC-07) — FAQAT menejerning O'Z filiali. Ilgari ota filiallar
   * zanjiri ham ruxsat etilgan hisoblanardi (u doim HQ'ga yetadi): viloyat
   * menejeri HQ kuryeri yoki ota filial kuryeri naqdini o'z filial kassasiga
   * "qabul qila" olardi, FIFO esa HQ qatorlarini BRANCH_SETTLED ("naqd HQ'da")
   * qilardi — pul HQ hisobidan yo'qolardi. Endi:
   *   - so'rovchining o'zi → o'z filiali;
   *   - faol branch_users qatori bor foydalanuvchi → qatori AYNAN menejer
   *     filialida bo'lsagina (HQ, ota va bola filiallar — yo'q);
   *   - foydalanuvchi bo'lmagan id menejer filialining o'z id'siga teng →
   *     o'z filiali;
   *   - qolgan hammasi → null (ruxsat yo'q).
   * Foydalanuvchi id'si filial id'lari bilan solishtirilmaydi: id'lar har xil
   * jadvallardan, raqamlar to'qnashadi (kuryer #15 va filial #15) — shuning
   * uchun foydalanuvchi qatori birinchi tekshiriladi.
   */
  async resolveCashboxBranchForManager(
    requested_id: string,
    requester?: RequesterContext,
  ) {
    const requesterId = String(requester?.id ?? '').trim();
    const requestedId = String(requested_id ?? '').trim();
    if (!requesterId || !requestedId) {
      this.badRequest('requester_id va requested_id majburiy');
    }

    const requesterRoles = (requester?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
    if (!requesterRoles.includes('manager')) {
      this.forbidden("So'rovchi filial menejeri emas");
    }

    const managerAssignment = await this.branchUserRepo.findOne({
      where: {
        user_id: requesterId,
        isDeleted: false,
      },
      order: { createdAt: 'DESC' },
    });
    const managerBranchId = String(
      requester?.branch_id ?? managerAssignment?.branch_id ?? '',
    ).trim();
    if (!managerBranchId) {
      return successRes(null, 200, 'Manager branch assignment not found');
    }

    const managerBranch = await this.getBranchOrThrow(managerBranchId);
    const ownBranchId = String(managerBranch.id);
    const resolved = (message: string) =>
      successRes({ branch_id: ownBranchId }, 200, message);
    const notResolved = () =>
      successRes(null, 200, 'Manager cashbox branch not resolved');

    if (requestedId === requesterId) {
      return resolved('Manager cashbox branch resolved');
    }

    const requestedUserAssignment = await this.branchUserRepo.findOne({
      where: {
        user_id: requestedId,
        isDeleted: false,
      },
      order: { createdAt: 'DESC' },
    });
    if (requestedUserAssignment) {
      return String(requestedUserAssignment.branch_id ?? '').trim() ===
        ownBranchId
        ? resolved('Manager branch user cashbox branch resolved')
        : notResolved();
    }

    if (requestedId === ownBranchId) {
      return resolved('Manager cashbox branch resolved');
    }

    return notResolved();
  }

  async setBranchConfig(
    data: {
      branch_id?: string;
      config_key?: string;
      config_value?: Record<string, unknown> | null;
    },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const configKey = String(data?.config_key ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id majburiy');
    }
    if (!configKey) {
      this.badRequest('config_key majburiy');
    }

    await this.assertCanWriteBranch(branchId, requester);

    await this.getBranchOrThrow(branchId);

    const existing = await this.branchConfigRepo.findOne({
      where: { branch_id: branchId, config_key: configKey },
    });

    const configValue =
      typeof data?.config_value === 'undefined'
        ? null
        : (data.config_value ?? null);

    if (existing) {
      existing.isDeleted = false;
      existing.config_value = configValue;
      const saved = await this.branchConfigRepo.save(existing);
      await this.activityLog.log({
        entity_type: 'BranchConfig',
        entity_id: String(branchId),
        action: 'branch.config_set',
        new_value: saved,
        metadata: { config_key: configKey },
        ...this.auditActor(requester),
      });
      return successRes(saved, 200, 'Branch config saved');
    }

    const saved = await this.branchConfigRepo.save(
      this.branchConfigRepo.create({
        branch_id: branchId,
        config_key: configKey,
        config_value: configValue,
      }),
    );

    await this.activityLog.log({
      entity_type: 'BranchConfig',
      entity_id: String(branchId),
      action: 'branch.config_set',
      new_value: saved,
      metadata: { config_key: configKey },
      ...this.auditActor(requester),
    });

    return successRes(saved, 201, 'Branch config saved');
  }

  async getBranchConfig(branch_id: string, requester?: RequesterContext) {
    const branchId = String(branch_id ?? '').trim();
    if (!branchId) {
      this.badRequest('branch_id majburiy');
    }

    await this.assertCanReadBranch(branchId, requester);

    await this.getBranchOrThrow(branchId);

    const items = await this.branchConfigRepo.find({
      where: { branch_id: branchId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });

    return successRes(items, 200, 'Branch config list');
  }

  async getBranchConfigByKey(
    data: { branch_id?: string; config_key?: string },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const configKey = String(data?.config_key ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id majburiy');
    }
    if (!configKey) {
      this.badRequest('config_key majburiy');
    }

    await this.assertCanReadBranch(branchId, requester);

    await this.getBranchOrThrow(branchId);

    const item = await this.branchConfigRepo.findOne({
      where: { branch_id: branchId, config_key: configKey, isDeleted: false },
    });

    if (!item) {
      this.notFound('Filial sozlamasi topilmadi');
    }

    return successRes(item, 200, 'Branch config found');
  }

  async updateBranchConfig(
    data: {
      branch_id?: string;
      config_key?: string;
      config_value?: Record<string, unknown> | null;
    },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const configKey = String(data?.config_key ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id majburiy');
    }
    if (!configKey) {
      this.badRequest('config_key majburiy');
    }

    await this.assertCanWriteBranch(branchId, requester);

    await this.getBranchOrThrow(branchId);

    const item = await this.branchConfigRepo.findOne({
      where: { branch_id: branchId, config_key: configKey, isDeleted: false },
    });
    if (!item) {
      this.notFound('Filial sozlamasi topilmadi');
    }

    const beforeConfig = { config_value: item.config_value };

    item.config_value =
      typeof data?.config_value === 'undefined'
        ? null
        : (data.config_value ?? null);
    const saved = await this.branchConfigRepo.save(item);

    await this.activityLog.logChange({
      entity_type: 'BranchConfig',
      entity_id: String(branchId),
      action: ActivityAction.UPDATED,
      old_value: beforeConfig,
      new_value: { config_value: saved.config_value },
      metadata: { config_key: configKey },
      ...this.auditActor(requester),
    });

    return successRes(saved, 200, 'Branch config updated');
  }

  async deleteBranchConfig(
    data: { branch_id?: string; config_key?: string },
    requester?: RequesterContext,
  ) {
    const branchId = String(data?.branch_id ?? '').trim();
    const configKey = String(data?.config_key ?? '').trim();

    if (!branchId) {
      this.badRequest('branch_id majburiy');
    }
    if (!configKey) {
      this.badRequest('config_key majburiy');
    }

    await this.assertCanWriteBranch(branchId, requester);

    await this.getBranchOrThrow(branchId);

    const item = await this.branchConfigRepo.findOne({
      where: { branch_id: branchId, config_key: configKey, isDeleted: false },
    });
    if (!item) {
      this.notFound('Filial sozlamasi topilmadi');
    }

    item.isDeleted = true;
    await this.branchConfigRepo.save(item);

    await this.activityLog.log({
      entity_type: 'BranchConfig',
      entity_id: String(branchId),
      action: ActivityAction.DELETED,
      old_value: { config_key: configKey, config_value: item.config_value },
      metadata: { config_key: configKey },
      ...this.auditActor(requester),
    });

    return successRes(
      { branch_id: branchId, config_key: configKey },
      200,
      'Branch config deleted',
    );
  }
}
