import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import {
  Brackets,
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { Order, OrderHolderType } from '../entities/order.entity';
import { OrderExtraCostApproval } from '../entities/order-extra-cost-approval.entity';
import { OrderSettlement } from '../entities/order-settlement.entity';
import { OrderSettlementCarry } from '../entities/order-settlement-carry.entity';
import { OrderLookupService } from '../lookup/order-lookup.service';
import {
  Cashbox_type,
  Order_status,
  SettlementStatus,
  rmqSend,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';

/**
 * Per-order COD settlement: the transaction-OWNING advance path + read surface,
 * extracted from the OrderServiceService god object (Audit decomposition).
 *
 * IMPORTANT boundary: the settlement WRITE helpers that participate in the
 * LIFECYCLE's transaction (recordSaleSettlement / resetSettlementOnRollback /
 * resolveSettlementBranchId / resolveBranchShare, plus the isSettledToHq guard)
 * deliberately STAY in OrderServiceService — they are called inside sellOrder /
 * partlySellOrder / rollback with the caller's own EntityManager, so moving them
 * would break money-mutation atomicity. This service owns only the paths that
 * open their OWN queryRunner (runFifoSettlement via advanceSettlement) or are
 * read-only (getSettlementByOrderId / financial-balance summary), plus the
 * retired settle* stubs. badRequest/handleDbError are duplicated leaf helpers.
 */
type SettlementLevel = 'courier_to_branch' | 'branch_to_hq' | 'hq_to_market';

/**
 * HQ id sini kutishning yuqori chegarasi. Kesh odatda issiq (OrderLookupService
 * modul ishga tushganda to'ldiradi); sovuq kesh + branch-service ishlamayotgan
 * holatda yig'indilar va advance 2×5 s RPC timeout'ini kutib qolmasligi uchun.
 */
const HQ_BRANCH_LOOKUP_MAX_WAIT_MS = 3000;

/**
 * R3 — kuryer qo'lidagi buyurtma: ushlovchisi (holder) KURYER bo'lib, shu
 * holatlardan birida BO'LMAGANI. Bu holatlardagi buyurtma yakunlangan —
 * `holder_type` hali COURIER bo'lsa ham kuryerni o'tkazishga to'sqinlik
 * qilmaydi.
 */
const COURIER_DONE_ORDER_STATUSES: Order_status[] = [
  Order_status.SOLD,
  Order_status.PAID,
  Order_status.PARTLY_PAID,
  Order_status.CLOSED,
  Order_status.RETURNED_TO_MARKET,
];

/**
 * R3 — `courier_id` shu kuryer bo'lsa (ushlovchi boshqa bo'lsa ham) u hali
 * amal bajara oladigan holatlar: sotuv yo'li eski `courier_id` ni ham qabul
 * qiladi. SENT pochta ichidagilar ham shu yerga tushadi (yo'lda + courier_id).
 */
const COURIER_ACTIONABLE_ORDER_STATUSES: Order_status[] = [
  Order_status.ON_THE_ROAD,
  Order_status.WAITING,
  Order_status.WAITING_CUSTOMER,
];

/** Tekshiruv javobidagi namuna buyurtmalar soni (id bo'yicha o'sib borish). */
const COURIER_TRANSFER_SAMPLE_LIMIT = 5;

@Injectable()
export class OrderSettlementService {
  private readonly logger = new Logger(OrderSettlementService.name);
  /** `order_settlement_carry` jadvali bormi (migratsiya ishlaganmi) — kesh. */
  private carryTableReady: boolean | null = null;
  private carryCheckedAt = 0;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(OrderSettlement)
    private readonly orderSettlementRepo: Repository<OrderSettlement>,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    /**
     * HQ filial id si — `resolveSettlementBranchId` ishlatadigan AYNAN o'sha
     * issiq kesh (sotuv qatoriga `branch_id` NULL yozilishini hal qiladigan
     * manba). Ixtiyoriy: berilmasa HQ "noma'lum" deb qaraladi va qoldiq
     * mexanizmi avvalgidek ishlaydi (C10 izohiga qarang).
     */
    @Optional() private readonly lookup?: OrderLookupService,
  ) {}

  // ===== leaf helpers duplicated from OrderServiceService =====

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

  // ===== settlement advance + read surface (moved verbatim) =====
  /**
   * Path A retired (Faza 2b). The legacy `order.settlement.{courier_to_branch,
   * branch_to_hq,hq_to_market}` handlers used to MOVE cashbox money themselves
   * (posting legs keyed by source_id = order_id, no dedup_epoch). That
   * duplicated the production `finance.cashbox.payment_*` path (which posts legs
   * keyed by source_id = actor_id + a dedup token) — different keys, so finance's
   * idempotency index could NOT collapse them and one physical handover posted
   * twice (double-debit). Cash now moves ONLY through the finance payment
   * endpoints, which advance the per-order settlement ledger via the
   * transactional outbox (Faza 2a). These endpoints are disabled so the two
   * money-movers can never both run for the same handover.
   */
  private deprecatedSettlementPath(level: string): never {
    this.badRequest(
      `order.settlement.${level} endi qo'llab-quvvatlanmaydi (Faza 2b): ` +
        `pul faqat cashbox to'lov endpointlari orqali ko'chiriladi, ular ` +
        `settlement'ni outbox orqali avtomatik advance qiladi.`,
    );
  }

  /**
   * `order_settlement_carry` jadvali mavjudmi. Migratsiya ishlamagan muhitda
   * (yoki test mockida) qoldiq mexanizmi o'chadi va FIFO avvalgidek ishlaydi —
   * to'lov oqimi jadval yo'qligi sababli hech qachon to'xtamasligi kerak.
   * Yo'q bo'lsa har 60 soniyada qayta tekshiriladi.
   */
  private async isCarryEnabled(): Promise<boolean> {
    if (this.carryTableReady) {
      return true;
    }
    if (
      this.carryTableReady === false &&
      Date.now() - this.carryCheckedAt < 60_000
    ) {
      return false;
    }
    try {
      const schema =
        (this.dataSource.options as { schema?: string } | undefined)?.schema ||
        'public';
      const rows: Array<{ t: string | null }> = await this.dataSource.query(
        'SELECT to_regclass($1) AS t',
        [`${schema}.order_settlement_carry`],
      );
      this.carryTableReady = Boolean(rows?.[0]?.t);
    } catch {
      this.carryTableReady = false;
    }
    this.carryCheckedAt = Date.now();
    return this.carryTableReady;
  }

  /**
   * HQ filial id si yoki `null` (aniqlab bo'lmadi). Xato YUTILADI: chaqiruvchi
   * `null` da avvalgi (C10 dan oldingi) xatti-harakatni tanlaydi.
   *
   * ⚠️ C10 — NEGA KERAK. HQ "filial → HQ" bo'g'inining tomoni EMAS: HQ
   * sotuvlarida `resolveSettlementBranchId` ataylab `null` yozadi, ya'ni
   * `branch_id` = HQ bo'lgan COURIER_SETTLED qator deyarli yo'q. HQ'ning
   * 'branch' kassasidan (eski HQ menejerlari) branch-to-main qilinsa FIFO
   * hech narsani yopmaydi va BUTUN summa `branch_to_hq` qoldig'i bo'lib HQ
   * nomiga yozilardi (2026-09-30 regressiyasi). Yig'indilar esa uni filial
   * qarzidan ayirib, moliyaviy balansni sun'iy og'dirardi — o'sha naqd
   * aslida HQ kuryerlari topshirganda allaqachon hisobga olingan.
   */
  private async resolveHqBranchId(): Promise<string | null> {
    if (!this.lookup) {
      return null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const hqId = await Promise.race([
        this.lookup.getHqBranchId(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), HQ_BRANCH_LOOKUP_MAX_WAIT_MS);
        }),
      ]);
      return String(hqId ?? '').trim() || null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Musbat qoldiqlar (bo'g'in bo'yicha). Jadval bo'lmasa — bo'sh ro'yxat. */
  private async loadCarries(
    level?: SettlementLevel,
  ): Promise<OrderSettlementCarry[]> {
    if (!(await this.isCarryEnabled())) {
      return [];
    }
    try {
      const rows = await this.dataSource
        .getRepository(OrderSettlementCarry)
        .find({
          where: level ? { level, isDeleted: false } : { isDeleted: false },
        });
      return rows.filter((row) => (Number(row.amount) || 0) > 0);
    } catch {
      return [];
    }
  }

  /**
   * Bitta kuryerning `courier_to_branch` qoldig'i — QAT'IY o'qish (R3).
   *
   * ⚠️ `loadCarries` dan farqi: xato YUTILMAYDI. U yerda xato `[]` bo'lib
   * qaytadi (fail-open) — pul oqimi to'xtamasligi uchun to'g'ri, lekin kuryerni
   * o'tkazish tekshiruvida "qoldiq yo'q" deb adashib o'tkazib yuborardi. Jadval
   * mavjudligi keshdan faqat `true` bo'lsagina olinadi: `false` keshni
   * `isCarryEnabled` yutilgan xatodan ham yozadi. Jadval haqiqatan yo'q
   * (migratsiya ishlamagan) — 0: bunday muhitda qoldiq mexanizmi o'chiq.
   */
  private async loadCourierCarryStrict(courierId: string): Promise<number> {
    if (this.carryTableReady !== true) {
      const schema =
        (this.dataSource.options as { schema?: string } | undefined)?.schema ||
        'public';
      const tables: Array<{ t: string | null }> = await this.dataSource.query(
        'SELECT to_regclass($1) AS t',
        [`${schema}.order_settlement_carry`],
      );
      if (!tables?.[0]?.t) {
        return 0;
      }
      this.carryTableReady = true;
      this.carryCheckedAt = Date.now();
    }

    const rows = await this.dataSource
      .getRepository(OrderSettlementCarry)
      .find({
        where: {
          level: 'courier_to_branch',
          party_id: courierId,
          isDeleted: false,
        },
      });
    return (rows ?? []).reduce((sum, row) => {
      const amount = Number(row.amount) || 0;
      return amount > 0 ? sum + amount : sum;
    }, 0);
  }

  /** Return the per-order settlement row (status + leg stamps) for one order. */
  async getSettlementByOrderId(orderId: string) {
    const id = String(orderId ?? '').trim();
    if (!id) {
      this.badRequest('order id is required');
    }
    const settlement = await this.orderSettlementRepo.findOne({
      where: { order_id: id },
    });
    return successRes(settlement ?? null, 200, 'Order settlement');
  }

  /**
   * Kompaniya holati uchun zanjir qarzi + marketga qarz yig'indisi.
   *
   * ⚠️ AUDIT M1 — `branch_id IS NOT NULL` FILTRI OLIB TASHLANDI.
   * Ilgari bu yig'indi faqat filialga bog'langan qatorlarni hisoblardi. HQ
   * sotuvlarida esa `resolveSettlementBranchId` ataylab `null` qaytaradi (HQ
   * alohida filial sifatida qaralmaydi) — ya'ni HQ kuryerlari ushlab turgan
   * pul zanjir qarzidan butunlay tushib qolardi. Marketga qarz esa sotuv
   * paytida DARHOL yoziladi, natijada moliyaviy balans har bir "yo'ldagi"
   * buyurtma uchun manfiyga og'ib turardi: kuniga 1 000 buyurtma × 450 000
   * so'm ≈ 450 mln so'mlik soxta qarz.
   *
   * Endi `chain_receivable` — buyurtma boshiga BIR MARTA, qaysi bo'g'inda
   * turganidan (kuryer/filial) va filialga bog'langan-bog'lanmaganidan qat'i
   * nazar hisoblanadi. Filiallar kesimi (`branches`) operatsion ko'rinish
   * uchun qoladi; HQ qatorlari `hq` bandiga yig'iladi.
   */
  async getFinancialBalanceSettlementSummary() {
    const activeStatuses = [
      SettlementStatus.PENDING,
      SettlementStatus.COURIER_SETTLED,
      SettlementStatus.BRANCH_SETTLED,
    ];
    const branchReceivableStatuses = [
      SettlementStatus.PENDING,
      SettlementStatus.COURIER_SETTLED,
    ];

    const [branchRows, marketRows] = await Promise.all([
      this.orderSettlementRepo
        .createQueryBuilder('settlement')
        .select('settlement.branch_id', 'branch_id')
        .addSelect('COALESCE(SUM(settlement.branch_amount), 0)', 'amount')
        .where('settlement.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('settlement.status IN (:...statuses)', {
          statuses: branchReceivableStatuses,
        })
        .groupBy('settlement.branch_id')
        .getRawMany<{ branch_id: string | null; amount: string }>(),
      this.orderSettlementRepo
        .createQueryBuilder('settlement')
        .select('settlement.market_id', 'market_id')
        .addSelect('COALESCE(SUM(settlement.market_amount), 0)', 'amount')
        .where('settlement.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('settlement.market_id IS NOT NULL')
        .andWhere('settlement.status IN (:...statuses)', {
          statuses: activeStatuses,
        })
        .groupBy('settlement.market_id')
        .getRawMany<{ market_id: string; amount: string }>(),
    ]);

    // Qirqish YO'Q: manfiy qoldiq ham haqiqiy ma'lumot (HQ o'sha bo'g'inga
    // ustama to'lagan). Ilgari `Math.max(x, 0)` uni jimgina yo'qotardi.
    let hqAmount = branchRows
      .filter((row) => !row.branch_id)
      .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const branches = branchRows
      .filter((row) => Boolean(row.branch_id))
      .map((row) => ({
        branch_id: String(row.branch_id),
        amount: Number(row.amount) || 0,
      }));
    const markets = marketRows.map((row) => ({
      market_id: String(row.market_id),
      amount: Number(row.amount) || 0,
    }));

    /**
     * TAQSIMLANMAGAN QOLDIQ AYIRILADI (`order_settlement_carry`). Bu naqd
     * kassada allaqachon yuqoriga ko'chgan, lekin hali hech bir butun
     * buyurtmani yopmagan. Ayirilmasa o'sha summa ham MAIN'da, ham zanjir
     * qarzida sanalardi (E2E 30-09: +95 000 soxta balans).
     *   • filial → HQ qoldig'i: filial qarzidan;
     *   • HQ kuryeri → HQ qoldig'i (`branch_id` NULL): HQ bandidan. Filial
     *     kuryerining qoldig'i zanjirga ta'sir qilmaydi — naqd hali filialda;
     *   • HQ → market qoldig'i: marketga qarzdan (oldindan to'langan).
     *
     * C10: tomoni HQ'ning o'zi bo'lgan `branch_to_hq` qoldig'i HISOBGA
     * OLINMAYDI (`resolveHqBranchId` izohi). HQ aniqlanmasa — avvalgidek.
     */
    const carries = await this.loadCarries();
    const hqBranchId = carries.some((carry) => carry.level === 'branch_to_hq')
      ? await this.resolveHqBranchId()
      : null;
    for (const carry of carries) {
      const amount = Number(carry.amount) || 0;
      const partyId = String(carry.party_id);
      if (carry.level === 'branch_to_hq') {
        if (hqBranchId && partyId === hqBranchId) {
          continue;
        }
        const row = branches.find((item) => item.branch_id === partyId);
        if (row) {
          row.amount -= amount;
        } else {
          branches.push({ branch_id: partyId, amount: -amount });
        }
      } else if (carry.level === 'courier_to_branch' && !carry.branch_id) {
        hqAmount -= amount;
      } else if (carry.level === 'hq_to_market') {
        const row = markets.find((item) => item.market_id === partyId);
        if (row) {
          row.amount -= amount;
        } else {
          markets.push({ market_id: partyId, amount: -amount });
        }
      }
    }

    const branchReceivable = branches.reduce((sum, row) => sum + row.amount, 0);

    return successRes(
      {
        // Zanjirda (kuryer yoki filial qo'lida) turgan va HQ'ga tegishli pul.
        chain_receivable: branchReceivable + hqAmount,
        // Filiallarga bog'langan qismi — operatsion kesim uchun.
        branch_receivable: branchReceivable,
        // HQ kuryerlari ushlab turgan qism.
        hq_receivable: hqAmount,
        market_payable: markets.reduce((sum, row) => sum + row.amount, 0),
        branches,
        markets,
      },
      200,
      'Financial balance settlement summary',
    );
  }

  /**
   * Bitta filial uchun hisob-kitob yig'indisi — SQL `SUM` bilan (audit C1).
   *
   * ⚠️ NEGA KERAK BO'LDI. Manager paneli bu raqamlarni gateway'da hisoblardi:
   * `order.find_all` ni IKKI marta chaqirib (filial bo'yicha va kuryerlar
   * bo'yicha), har birida 5 000 tagacha buyurtmani (mahsulotlari bilan)
   * RabbitMQ orqali tortib olib, JS'da qo'shib chiqardi. Sana filtri esa
   * majburiy emas edi — ya'ni filialning jamlanma buyurtmalari 5 000 dan
   * oshgan kuni summa JIMGINA qirqilib, KAM ko'rsata boshlardi. Hech qanday
   * xato ham, log ham yo'q: pul raqami shunchaki noto'g'ri bo'lardi.
   *
   * Endi yig'indi ledgerdan, bazada hisoblanadi:
   *   • `branch_payable` — filial HQ'ga qancha qarz (PENDING + COURIER_SETTLED;
   *     HQ'ga topshirilgan buyurtmalar allaqachon BRANCH_SETTLED bo'lgani
   *     uchun o'z-o'zidan chiqib ketadi — ilgari to'langan summani alohida
   *     ayirish kerak edi va u sana oynasiga bog'liq edi);
   *   • `courier_receivable` — kuryerlar filialga qancha qarz (PENDING).
   */
  async getBranchSettlementSummary(data: {
    branch_id?: string | null;
    courier_ids?: string[];
  }) {
    const branchId = String(data?.branch_id ?? '').trim();
    const courierIds = (data?.courier_ids ?? [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean);

    const sumOf = async (
      column: 'branch_amount' | 'courier_amount',
      apply: (
        qb: ReturnType<Repository<OrderSettlement>['createQueryBuilder']>,
      ) => void,
      statuses: SettlementStatus[],
    ): Promise<number> => {
      const qb = this.orderSettlementRepo
        .createQueryBuilder('settlement')
        .select(`COALESCE(SUM(settlement.${column}), 0)`, 'amount')
        .where('settlement.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('settlement.status IN (:...statuses)', { statuses });
      apply(qb);
      const row = await qb.getRawOne<{ amount: string }>();
      return Number(row?.amount ?? 0) || 0;
    };

    const [branchPayable, courierReceivable] = await Promise.all([
      branchId
        ? sumOf(
            'branch_amount',
            (qb) =>
              qb.andWhere('settlement.branch_id = :branchId', { branchId }),
            [SettlementStatus.PENDING, SettlementStatus.COURIER_SETTLED],
          )
        : Promise.resolve(0),
      courierIds.length
        ? sumOf(
            'courier_amount',
            (qb) =>
              qb.andWhere('settlement.courier_id IN (:...courierIds)', {
                courierIds,
              }),
            [SettlementStatus.PENDING],
          )
        : Promise.resolve(0),
    ]);

    // Taqsimlanmagan qoldiqlar (`order_settlement_carry`) — o'sha naqd
    // allaqachon topshirilgan, menejer uni qayta so'ramasligi kerak.
    const carries = await this.loadCarries();
    const ownBranchCarries = branchId
      ? carries.filter(
          (row) =>
            row.level === 'branch_to_hq' && String(row.party_id) === branchId,
        )
      : [];
    // C10: HQ'ning o'z `branch_to_hq` qoldig'i hisobga olinmaydi.
    const isHqBranch =
      ownBranchCarries.length > 0 &&
      (await this.resolveHqBranchId()) === branchId;
    const branchCarry = isHqBranch
      ? 0
      : ownBranchCarries.reduce(
          (sum, row) => sum + (Number(row.amount) || 0),
          0,
        );
    const courierCarry = carries
      .filter(
        (row) =>
          row.level === 'courier_to_branch' &&
          courierIds.includes(String(row.party_id)),
      )
      .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

    return successRes(
      {
        branch_id: branchId || null,
        branch_payable: branchPayable - branchCarry,
        courier_receivable: courierReceivable - courierCarry,
      },
      200,
      'Branch settlement summary',
    );
  }

  /**
   * Bitta kuryerning topshirilmagan savdosi (PENDING) — HQ va filial
   * qismlariga ajratilgan (B4). FAQAT O'QIYDI.
   *
   * ⚠️ NEGA KERAK. Superadmin/admin kuryerdan pulni to'g'ridan-to'g'ri MAIN'ga
   * oladi, FIFO esa kuryerning BARCHA PENDING qatorlarini (filialidan qat'i
   * nazar) `createdAt` bo'yicha yopadi va holatni har qatorning `branch_id`
   * sidan hisoblaydi. Kuryerda filialga bog'langan qator bo'lsa, u
   * COURIER_SETTLED bo'lib qoladi — naqd esa MAIN'da (jonli tasdiqlangan:
   * soxta filial qarzi). Shu sabab gateway `branch_pending_count > 0` da pul
   * olishni rad etadi; u pul kuryer → filial → HQ yo'lidan keladi.
   *
   * Bitta GROUP BY: `settlement.branch_id` bo'yicha (NULL guruhi — HQ qismi),
   * shu bilan `branch_ids` ham ARRAY_AGG'siz olinadi. Summalar ishorali va
   * qirqilmaydi (kredit qatorlari ham kiradi) — boshqa yig'indilar kabi.
   * `carry_amount` — kuryerning taqsimlanmagan qoldig'i (`courier_to_branch`).
   * Bo'sh id → nollar, so'rov yuborilmaydi.
   */
  async getCourierSettlementScope(data: { courier_id?: string | null }) {
    const courierId = String(data?.courier_id ?? '').trim();
    const scope = {
      hq_pending_count: 0,
      hq_pending_amount: 0,
      branch_pending_count: 0,
      branch_pending_amount: 0,
      branch_ids: [] as string[],
      carry_amount: 0,
    };
    if (!courierId) {
      return successRes(scope, 200, 'Courier settlement scope');
    }
    if (!/^\d+$/.test(courierId)) {
      this.badRequest("courier_id raqam ko'rinishida bo'lishi kerak");
    }

    const rows = await this.orderSettlementRepo
      .createQueryBuilder('settlement')
      .select('settlement.branch_id', 'branch_id')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(settlement.courier_amount), 0)', 'amount')
      .where('settlement.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('settlement.status = :status', {
        status: SettlementStatus.PENDING,
      })
      .andWhere('settlement.courier_id = :courierId', { courierId })
      .groupBy('settlement.branch_id')
      .getRawMany<{ branch_id: string | null; count: string; amount: string }>()
      .catch((error: unknown) => this.handleDbError(error));

    const branchIds = new Set<string>();
    for (const row of rows ?? []) {
      const count = Number(row.count) || 0;
      const amount = Number(row.amount) || 0;
      if (row.branch_id) {
        scope.branch_pending_count += count;
        scope.branch_pending_amount += amount;
        branchIds.add(String(row.branch_id));
      } else {
        scope.hq_pending_count += count;
        scope.hq_pending_amount += amount;
      }
    }
    scope.branch_ids = [...branchIds];
    scope.carry_amount = (await this.loadCarries('courier_to_branch'))
      .filter((row) => String(row.party_id) === courierId)
      .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);

    return successRes(scope, 200, 'Courier settlement scope');
  }

  /**
   * R3 — kuryerni filialdan filialga o'tkazish tekshiruvi (order qismi).
   * FAQAT O'QIYDI; bloklash qarorini branch-service chiqaradi.
   *
   *   • PENDING savdo — `getCourierSettlementScope` (o'zgarishsiz qayta
   *     ishlatiladi);
   *   • `carry_amount` — `loadCourierCarryStrict` (xato yutilmaydi);
   *   • qo'lidagi buyurtmalar — ushlovchi KURYER va yakunlanmagan, YOKI
   *     `courier_id` shu kuryer va yo'lda/kutilmoqda (qisman sotuvning bekor
   *     qoldig'i ham, qaytarilmagan bekorlar ham birinchi shartga tushadi);
   *   • ko'rib chiqilmagan qo'shimcha xarajat so'rovlari — tasdiqlansa sotuv
   *     yoki bekor KURYER nomidan qayta o'ynaladi, ya'ni kuryer puli o'zgaradi.
   *
   * ⚠️ Baza xatosi hech qachon yutilmaydi va RpcException'ga o'raladi — xom
   * xato RMQ'da qayta navbatga qo'yilib, handler ikki marta ishlardi.
   * `getCourierSettlementScope` ning `handleDbError` i ham tanimagan
   * QueryFailedError'ni xom holda qayta otadi — u ham shu yerda o'raladi.
   */
  async getCourierTransferCheck(data: { courier_id?: string | null }) {
    const courierId = String(data?.courier_id ?? '').trim();
    if (!/^\d+$/.test(courierId)) {
      this.badRequest("courier_id raqam ko'rinishida bo'lishi kerak");
    }

    const ordersInHandQuery = () =>
      this.dataSource
        .getRepository(Order)
        .createQueryBuilder('o')
        .where('o.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere(
          new Brackets((w) => {
            w.where(
              'o.holder_type = :courierHolder AND o.holder_courier_id = :courierId AND o.status NOT IN (:...doneStatuses)',
              {
                courierHolder: OrderHolderType.COURIER,
                courierId,
                doneStatuses: COURIER_DONE_ORDER_STATUSES,
              },
            ).orWhere(
              'o.courier_id = :courierId AND o.status IN (:...actionableStatuses)',
              {
                courierId,
                actionableStatuses: COURIER_ACTIONABLE_ORDER_STATUSES,
              },
            );
          }),
        );

    try {
      const [scopeResponse, carryAmount, ordersInHand, sampleRows, approvals] =
        await Promise.all([
          this.getCourierSettlementScope({ courier_id: courierId }),
          this.loadCourierCarryStrict(courierId),
          ordersInHandQuery().getCount(),
          ordersInHandQuery()
            .select('o.id', 'id')
            .addSelect('o.status', 'status')
            .orderBy('o.id', 'ASC')
            .limit(COURIER_TRANSFER_SAMPLE_LIMIT)
            .getRawMany<{ id: string; status: string }>(),
          this.dataSource.getRepository(OrderExtraCostApproval).count({
            where: {
              requested_by_user_id: courierId,
              status: 'pending',
              isDeleted: false,
            },
          }),
        ]);
      const scope = scopeResponse.data as {
        hq_pending_count: number;
        hq_pending_amount: number;
        branch_pending_count: number;
        branch_pending_amount: number;
        branch_ids: string[];
        carry_amount: number;
      };

      return successRes(
        {
          ...scope,
          courier_id: courierId,
          pending_settlement_count:
            scope.hq_pending_count + scope.branch_pending_count,
          pending_settlement_amount:
            scope.hq_pending_amount + scope.branch_pending_amount,
          carry_amount: carryAmount,
          orders_in_hand: Number(ordersInHand) || 0,
          orders_sample: (sampleRows ?? []).map((row) => ({
            id: String(row.id),
            status: String(row.status),
          })),
          pending_extra_cost_approvals: Number(approvals) || 0,
        },
        200,
        'Courier transfer check',
      );
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }
      this.logger.warn(
        `order.courier_transfer_check failed (courier=${courierId}): ${(error as Error)?.message ?? error}`,
      );
      throw new RpcException({
        statusCode: 500,
        message:
          "Kuryer o'tkazish tekshiruvini bajarib bo'lmadi (ma'lumotlar bazasi xatosi)",
      });
    }
  }

  /**
   * Kargo hisob-kitob qilganda uning buyurtmalarini "HQ'ga yetib keldi"
   * holatiga o'tkazadi (audit M5).
   *
   * FIFO emas, ANIQ RO'YXAT bo'yicha: remittance qaysi buyurtmalarni
   * yopganini `provider_receivables` allaqachon biladi, shuning uchun taxmin
   * qilishning keragi yo'q. Faqat kuryersiz va filialsiz (ya'ni haqiqatan
   * kargo yo'lidan kelgan) PENDING qatorlar o'zgaradi — ichki sotuvga
   * tegib ketmasligi uchun.
   */
  async markProviderSettledToHq(data: {
    order_ids?: string[];
    requester_id?: string;
  }) {
    const orderIds = (data?.order_ids ?? [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean);
    if (!orderIds.length) {
      return successRes({ settled_order_ids: [] }, 200, 'Nothing to settle');
    }

    const now = new Date();
    const result = await this.orderSettlementRepo
      .createQueryBuilder()
      .update(OrderSettlement)
      .set({
        status: SettlementStatus.BRANCH_SETTLED,
        courier_to_branch_at: now,
        branch_to_hq_at: now,
        branch_to_hq_by: String(data?.requester_id ?? 'system'),
      })
      .where('order_id IN (:...orderIds)', { orderIds })
      .andWhere('status = :status', { status: SettlementStatus.PENDING })
      .andWhere('courier_id IS NULL')
      .andWhere('branch_id IS NULL')
      .andWhere('is_deleted = :isDeleted', { isDeleted: false })
      .execute();

    return successRes(
      { settled_order_ids: orderIds, affected: result.affected ?? 0 },
      200,
      'Provider settlement advanced',
    );
  }

  private static readonly MAIN_CASHBOX_USER_ID = '0';

  /** Ensure the singleton MAIN (HQ) cashbox exists before posting to it. */
  private async ensureMainCashbox(): Promise<void> {
    await rmqSend(
      this.financeClient,
      { cmd: 'finance.cashbox.create' },
      {
        user_id: OrderSettlementService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
      },
    ).catch(() => undefined);
  }

  /**
   * FIFO-allocate a lump-sum settlement payment to the oldest unsettled orders
   * for one participant, advancing each fully-covered order to the next leg and
   * posting its cashbox movements (atomic with the status update via outbox).
   * Whole-order allocation: an order is only settled when the remaining lump-sum
   * covers its full leg amount; the unallocated remainder is reported back.
   * Manfiy (kredit) oyoqlar lump-sum'ni OSHIRADI — naqd u bo'g'indan allaqachon
   * chiqib ketgan (qo'shimcha xarajat / onlayn to'lov) — va faqat kerak
   * bo'lganda tortiladi (pastdagi izohga qarang).
   */
  private async runFifoSettlement(params: {
    /**
     * Qoldiq kaliti. Berilsa, avvalgi taqsimlanmagan qoldiq lump-sum'ga
     * qo'shiladi va yangi qoldiq saqlanadi (`order_settlement_carry`).
     */
    carryLevel?: SettlementLevel;
    matchColumn: 'courier_id' | 'branch_id' | 'market_id';
    matchValue: string;
    fromStatus: SettlementStatus;
    /**
     * Keyingi holat QATOR BO'YICHA hisoblanadi. Sabab (audit M1): HQ sotuvida
     * filial bo'g'ini umuman yo'q — kuryer naqdni to'g'ridan-to'g'ri HQ'ga
     * topshiradi. Ilgari bu qatorlar `COURIER_SETTLED` da qotib qolardi va
     * `hq_to_market` (u `BRANCH_SETTLED` dan boshlanadi) ularni hech qachon
     * ko'rmasdi, ya'ni HQ sotuvlari uchun marketga hisob-kitob ledgeri abadiy
     * ochiq turardi.
     */
    toStatus: (settlement: OrderSettlement) => SettlementStatus;
    amountField: 'courier_amount' | 'branch_amount' | 'market_amount';
    lumpSum: number;
    requesterId: string;
    postLeg: (
      manager: EntityManager,
      settlement: OrderSettlement,
      amount: number,
    ) => Promise<void>;
    stamp: (now: Date) => Partial<OrderSettlement>;
  }): Promise<{
    settled_order_ids: string[];
    allocated: number;
    leftover: number;
    /** Yopilgan qatorlarning filial/market id lari — kaskad uchun. */
    touched: { branch_ids: string[]; market_ids: string[] };
  }> {
    const lumpSum = Math.max(Number(params.lumpSum) || 0, 0);
    const carryEnabled = params.carryLevel
      ? await this.isCarryEnabled()
      : false;
    // lump-sum 0 bilan faqat qoldiqni qo'llash uchun chaqiriladi (kaskad).
    if (!params.matchValue || (lumpSum <= 0 && !carryEnabled)) {
      return {
        settled_order_ids: [],
        allocated: 0,
        leftover: lumpSum,
        touched: { branch_ids: [], market_ids: [] },
      };
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    const settledOrderIds: string[] = [];
    const touchedBranches = new Set<string>();
    const touchedMarkets = new Set<string>();
    let allocated = 0;
    let carryBefore = 0;
    let newCarry = lumpSum;
    try {
      const tx = queryRunner.manager;
      const repo = tx.getRepository(OrderSettlement);

      /**
       * Avvalgi taqsimlanmagan qoldiq — qator QULFLANADI (bir tomonga ikki
       * to'lov parallel kelsa, ikkalasi bir qoldiqni ikki marta sarflamasin).
       */
      let carryRow: OrderSettlementCarry | null = null;
      const carryRepo = carryEnabled
        ? tx.getRepository(OrderSettlementCarry)
        : null;
      if (carryRepo && params.carryLevel) {
        await carryRepo
          .createQueryBuilder()
          .insert()
          .values({
            level: params.carryLevel,
            party_id: params.matchValue,
            branch_id: null,
            amount: 0,
          })
          .orIgnore()
          .execute();
        carryRow = await carryRepo.findOne({
          where: { level: params.carryLevel, party_id: params.matchValue },
          lock: { mode: 'pessimistic_write' },
        });
        carryBefore = Math.max(Number(carryRow?.amount ?? 0) || 0, 0);
      }

      const candidates = await repo.find({
        where: {
          [params.matchColumn]: params.matchValue,
          status: params.fromStatus,
          isDeleted: false,
        } as Record<string, unknown>,
        order: { createdAt: 'ASC' },
      });

      let remaining = lumpSum + carryBefore;
      const now = new Date();
      const advanceRow = async (row: OrderSettlement): Promise<void> => {
        await repo.update(
          { id: row.id },
          { status: params.toStatus(row), ...params.stamp(now) },
        );
        settledOrderIds.push(String(row.order_id));
        if (row.branch_id) touchedBranches.add(String(row.branch_id));
        if (row.market_id) touchedMarkets.add(String(row.market_id));
      };
      /**
       * MANFIY OYOQ = KREDIT, "qarz yo'q" EMAS (audit: qo'shimcha xarajat).
       *
       * Manfiy oyoq bu bo'g'indan naqd ALLAQACHON chiqib ketganini bildiradi:
       * bekor qilingan buyurtmaga yozilgan qo'shimcha xarajat, yoki onlayn
       * to'langan buyurtmada HQ qoplagan kuryer ulushi. Ya'ni topshiriladigan
       * lump-sum aynan shuncha KAM bo'ladi, daftar esa to'liq summani talab
       * qiladi. Ilgari bunday qator bepul o'tkazilar, lekin lump-sum'ga
       * QO'SHILMASDI — natijada eng eski to'lanmagan buyurtma ayni shu farq
       * tufayli abadiy PENDING bo'lib qotib qolardi (jonli misol: kuryer
       * kassasi 205 000, daftar 210 000 talab qildi, uchinchi buyurtmaga
       * AYNAN 5 000 so'm yetmadi).
       *
       * Kredit KECHIKTIRIB qo'llanadi: faqat eng eski to'lanmagan buyurtma
       * sig'masa, eng eskisidan boshlab tortiladi. Shu bois qisman to'lovda
       * kerak bo'lmagan kredit `leftover` ichida yonib ketmaydi — u keyingi
       * to'lovgacha o'z holicha turadi.
       *
       * ⚠️ Kreditlar yurishdan OLDIN ajratiladi. Xarajat odatda sotuvlardan
       * KEYIN yoziladi, ya'ni kredit qatori eng oxirgi bo'ladi — agar u faqat
       * navbat kelganda ko'rilsa, uni to'sib turgan buyurtmaga hech qachon
       * yetib bormasdi (jonli holat aynan shunday edi).
       */
      const legOf = (row: OrderSettlement): number =>
        Number(row[params.amountField] ?? 0) || 0;
      const credits = candidates.filter((row) => legOf(row) < 0);
      const payables = candidates.filter((row) => legOf(row) >= 0);
      for (const settlement of payables) {
        const legAmount = legOf(settlement);
        // Strict FIFO (Faza 4 / Audit I16): if the OLDEST still-unsettled order's
        // leg does not fully fit in the remaining lump-sum, STOP — never skip
        // ahead to settle a newer, smaller order before an older one. Skipping
        // violates oldest-first accounting and lets a deliberate resubmit
        // over-allocate to the next orders. Zero-amount legs (nothing owed at
        // this hop) still advance for free without consuming the lump-sum.
        const pulled: OrderSettlement[] = [];
        while (legAmount > remaining && credits.length) {
          const credit = credits.shift() as OrderSettlement;
          pulled.push(credit);
          remaining -= legOf(credit);
        }
        if (legAmount > remaining && legAmount > 0) {
          // Tortilgan kreditlar YOZILMAYDI: bu qator baribir sig'madi, demak
          // kredit sarflanmagan holicha qolishi kerak.
          break;
        }
        for (const credit of pulled) {
          await advanceRow(credit);
          allocated += legOf(credit);
        }
        await advanceRow(settlement);
        if (legAmount > 0) {
          await params.postLeg(tx, settlement, legAmount);
          remaining -= legAmount;
          allocated += legAmount;
        }
      }

      /**
       * Yangi qoldiq = (lump-sum + eski qoldiq) − haqiqatan yopilgan summa.
       * `remaining` EMAS: tortilib, lekin yozilmay qolgan kreditlar uni
       * sun'iy oshirgan bo'lishi mumkin.
       */
      newCarry = Math.max(lumpSum + carryBefore - allocated, 0);
      if (carryRepo && carryRow) {
        // Kuryer bo'g'ini: naqd HQ'ga to'g'ridan-to'g'ri yetganmi (HQ kuryeri,
        // `branch_id` NULL) — balans shunga qarab ayiradi.
        let carryBranchId = carryRow.branch_id ?? null;
        if (params.carryLevel === 'courier_to_branch') {
          const sample =
            candidates[0] ??
            (await repo.findOne({
              where: { courier_id: params.matchValue } as Record<
                string,
                unknown
              >,
              order: { createdAt: 'DESC' },
            }));
          if (sample) {
            carryBranchId = sample.branch_id ? String(sample.branch_id) : null;
          }
        }
        await carryRepo.update(
          { id: carryRow.id },
          { amount: newCarry, branch_id: carryBranchId },
        );
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof RpcException) {
        throw error;
      }
      this.handleDbError(error);
      throw new RpcException({
        statusCode: 500,
        message:
          error instanceof Error ? error.message : 'Internal server error',
      });
    } finally {
      await queryRunner.release();
    }

    return {
      settled_order_ids: settledOrderIds,
      allocated,
      // Qoldiq mexanizmi yoqilgan bo'lsa — saqlangan qoldiq (keyingi to'lovga
      // o'tadi); aks holda avvalgidek taqsimlanmagan summa.
      leftover: carryEnabled ? newCarry : Math.max(lumpSum - allocated, 0),
      touched: {
        branch_ids: [...touchedBranches],
        market_ids: [...touchedMarkets],
      },
    };
  }

  /**
   * KASKAD: bir bo'g'inda buyurtmalar yopilgach, keyingi bo'g'inda shu
   * tomonlar uchun kutib turgan qoldiq bo'lsa, u darhol qo'llanadi
   * (lump-sum 0). Masalan filial HQ'ga oldinroq ortiqcha topshirgan bo'lsa,
   * kuryer qolgan pulni topshirgan zahoti o'sha buyurtmalar BRANCH_SETTLED
   * bo'ladi — keyingi to'lovni kutmasdan. Best-effort: xato asosiy to'lovni
   * buzmaydi, qoldiq keyingi to'lovda baribir qo'llanadi.
   */
  private async applyPendingCarries(
    level: SettlementLevel,
    partyIds: string[],
    configs: Record<
      SettlementLevel,
      Omit<
        Parameters<OrderSettlementService['runFifoSettlement']>[0],
        'matchValue' | 'lumpSum' | 'requesterId' | 'postLeg'
      >
    >,
    requesterId: string,
  ): Promise<void> {
    if (!partyIds.length) {
      return;
    }
    const carries = await this.loadCarries(level);
    const withCarry = partyIds.filter((id) =>
      carries.some((row) => String(row.party_id) === id),
    );
    for (const partyId of withCarry) {
      try {
        const result = await this.runFifoSettlement({
          ...configs[level],
          matchValue: partyId,
          lumpSum: 0,
          requesterId,
          postLeg: async () => {},
        });
        if (level === 'branch_to_hq') {
          await this.applyPendingCarries(
            'hq_to_market',
            result.touched.market_ids,
            configs,
            requesterId,
          );
        }
      } catch {
        // Best-effort — qoldiq keyingi to'lovda qo'llanadi.
      }
    }
  }

  /**
   * Advance the per-order FIFO settlement ledger WITHOUT posting any cashbox leg.
   * The production cash path (finance.cashbox.payment_courier/branch_to_main/
   * market) already moves the cashbox balances; this keeps order_settlement in
   * lock-step so that (a) the settlement-aware rollback guard (isSettledToHq)
   * actually reflects real-world cash position in production, and (b) the legacy
   * order.settlement.* cashbox path becomes a no-op for already-advanced rows
   * (its candidates are filtered by fromStatus), so the two paths can never
   * double-post the same handover. (Audit I1/I2.)
   */
  async advanceSettlement(data: {
    level: 'courier_to_branch' | 'branch_to_hq' | 'hq_to_market';
    match_value: string;
    amount: number;
    requester_id?: string;
  }) {
    const requesterId = String(data?.requester_id ?? 'system');
    const matchValue = String(data?.match_value ?? '').trim();
    const amount = Number(data?.amount ?? 0);
    if (!matchValue || !(amount > 0)) {
      return successRes(
        { settled_order_ids: [], allocated: 0, leftover: amount },
        200,
        'No settlement to advance',
      );
    }

    // State-only: the cashbox was already moved by the finance payment path.
    const noPost = async (): Promise<void> => {};

    const configs = {
      courier_to_branch: {
        carryLevel: 'courier_to_branch' as const,
        matchColumn: 'courier_id' as const,
        fromStatus: SettlementStatus.PENDING,
        // Filial bo'lsa — filialda; bo'lmasa (HQ sotuvi) naqd allaqachon
        // HQ'da, shuning uchun darhol BRANCH_SETTLED.
        toStatus: (settlement: OrderSettlement) =>
          settlement.branch_id
            ? SettlementStatus.COURIER_SETTLED
            : SettlementStatus.BRANCH_SETTLED,
        amountField: 'courier_amount' as const,
        stamp: (now: Date) => ({
          courier_to_branch_at: now,
          courier_to_branch_by: requesterId,
        }),
      },
      branch_to_hq: {
        carryLevel: 'branch_to_hq' as const,
        matchColumn: 'branch_id' as const,
        fromStatus: SettlementStatus.COURIER_SETTLED,
        toStatus: () => SettlementStatus.BRANCH_SETTLED,
        amountField: 'branch_amount' as const,
        stamp: (now: Date) => ({
          branch_to_hq_at: now,
          branch_to_hq_by: requesterId,
        }),
      },
      hq_to_market: {
        carryLevel: 'hq_to_market' as const,
        matchColumn: 'market_id' as const,
        fromStatus: SettlementStatus.BRANCH_SETTLED,
        toStatus: () => SettlementStatus.MARKET_SETTLED,
        amountField: 'market_amount' as const,
        stamp: (now: Date) => ({
          hq_to_market_at: now,
          hq_to_market_by: requesterId,
        }),
      },
    };
    const cfg = configs[data.level];
    if (!cfg) {
      this.badRequest(`Invalid settlement level: ${String(data?.level)}`);
    }

    /**
     * C10: tomoni HQ'ning o'zi bo'lgan "filial → HQ" to'lovi qoldiq
     * mexanizmisiz ishlaydi — qoldiq SAQLANMAYDI va eski qoldiq qo'shilmaydi,
     * ya'ni qoldiq paydo bo'lishidan oldingidek (FIFO butun qatorlarni yopadi,
     * ortgani `leftover` da qaytadi, xolos). Sabab — `resolveHqBranchId`
     * izohida. HQ aniqlanmasa (`null`) tomon HQ deb taxmin QILINMAYDI:
     * qoldiq avvalgidek saqlanadi — oddiy filialning qoldig'ini yo'qotish
     * (E2E 30-09 dagi +95 000 xatosi) HQ nomidagi ortiqcha qatordan
     * xavfliroq, u qator esa yig'indilarda baribir e'tiborsiz qoladi.
     */
    const isHqBranchParty =
      data.level === 'branch_to_hq' &&
      (await this.resolveHqBranchId()) === matchValue;

    const result = await this.runFifoSettlement({
      carryLevel: isHqBranchParty ? undefined : cfg.carryLevel,
      matchColumn: cfg.matchColumn,
      matchValue,
      fromStatus: cfg.fromStatus,
      toStatus: cfg.toStatus,
      amountField: cfg.amountField,
      lumpSum: amount,
      requesterId,
      postLeg: noPost,
      stamp: cfg.stamp,
    });

    // Keyingi bo'g'inda kutib turgan qoldiqlarni darhol qo'llash (kaskad).
    if (data.level === 'courier_to_branch') {
      // C10: HQ nomidagi (eski) `branch_to_hq` qoldig'i kaskadda ham
      // qo'llanmaydi — u haqiqiy naqd emas (yuqoridagi izoh).
      const hqBranchId = result.touched.branch_ids.length
        ? await this.resolveHqBranchId()
        : null;
      await this.applyPendingCarries(
        'branch_to_hq',
        result.touched.branch_ids.filter((id) => id !== hqBranchId),
        configs,
        requesterId,
      );
      // HQ kuryeri: qatorlar to'g'ridan-to'g'ri BRANCH_SETTLED bo'ldi.
      await this.applyPendingCarries(
        'hq_to_market',
        result.touched.market_ids,
        configs,
        requesterId,
      );
    } else if (data.level === 'branch_to_hq') {
      await this.applyPendingCarries(
        'hq_to_market',
        result.touched.market_ids,
        configs,
        requesterId,
      );
    }

    // `touched` — faqat kaskad uchun ichki ma'lumot, javobga chiqmaydi.
    const publicResult: Partial<typeof result> = { ...result };
    delete publicResult.touched;
    return successRes(publicResult, 200, 'Settlement advanced');
  }

  /**
   * Courier hands a lump sum to the branch — FIFO-settles the courier's oldest
   * PENDING orders (courier → branch). Only reduces the courier's owed balance;
   * the branch was already credited at sale time.
   */
  settleCourierToBranch(): never {
    return this.deprecatedSettlementPath('courier_to_branch');
  }

  /**
   * Branch remits a lump sum to HQ — FIFO-settles the branch's oldest
   * COURIER_SETTLED orders (branch → HQ): branch owed-balance down, MAIN up.
   */
  settleBranchToHq(): never {
    return this.deprecatedSettlementPath('branch_to_hq');
  }

  /**
   * HQ pays a market a lump sum — FIFO-settles the market's oldest
   * BRANCH_SETTLED orders (HQ → market): MAIN down, market owed-balance down.
   */
  settleHqToMarket(): never {
    return this.deprecatedSettlementPath('hq_to_market');
  }
}
