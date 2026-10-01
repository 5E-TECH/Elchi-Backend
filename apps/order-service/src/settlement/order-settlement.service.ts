import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { createHash } from 'crypto';
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
  IdempotencyKey,
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

/**
 * M8 — `order.settlement.advance` tokeni QO'LLANGANINI bildiruvchi belgi
 * (`idempotency_keys` jadvalida, alohida pattern bilan).
 *
 * ⚠️ NEGA KERAK. Controller endi yiqilgan advance kalitini qayta egallaydi
 * (`reclaimFailed`): outbox'ning keyingi urinishi handlerni qayta ishga
 * tushiradi. Lekin `executeIdempotent` kalitni FIFO commit'idan KEYIN
 * (`markCompleted`) yozadi: commit o'tib, `markCompleted` yiqilsa kalit
 * `failed` bo'lib qolardi va qayta ishga tushgan handler AYNAN o'sha to'lovni
 * ikkinchi marta qo'llardi — keyingi qatorlar naqdsiz yopilar yoki qoldiq
 * ikki marta qo'shilardi. Belgi FIFO tranzaksiyasining birinchi yozuvi
 * sifatida kiritiladi, ya'ni commit bilan ATOMIK: qayta ishga tushgan handler
 * uni ko'radi va hech narsa qilmaydi. Parallel ikki ishga tushish UNIQUE
 * indeksda navbatga turadi.
 */
const ADVANCE_APPLIED_PATTERN = 'order.settlement.advance.applied';
const PG_UNIQUE_VIOLATION = '23505';

/** Advance tokeni boshqa (commit bo'lgan) tranzaksiyada qo'llanib bo'lgan. */
class AdvanceAlreadyAppliedError extends Error {
  constructor(readonly key: string) {
    super(`Settlement advance already applied (${key})`);
  }
}

/**
 * C8 — sof-nol yopish rad etilgan sabab (javobdagi `skipped_reason`).
 * Hech biri xato emas: shart bajarilmasa hech narsa o'zgarmaydi.
 *
 * `carry_not_zero` — qoldiq 0 emas va PENDING yig'indisiga ham teng emas
 * (yoki manfiy). `carry_branch_mismatch` (MONEY-02) — yig'indi qoldiqqa teng,
 * lekin qaysidir qator qoldiq turgan filialga tegishli emas.
 */
type ZeroNetRejection =
  | 'no_pending_rows'
  | 'carry_not_zero'
  | 'carry_branch_mismatch'
  | 'pending_amount_not_zero'
  | 'not_fully_closed';

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
    // 410 Gone (400 EMAS) — bu endpoint MAVJUD EMAS, validatsiya xatosi emas.
    // Integrator Swaggerdagi `deprecated` belgini ko'radi va 410 ni "olib
    // tashlangan" deb aniq tushunadi, jimgina 400 validatsiya xatosidan ko'ra
    // (uEPILERk).
    throw new RpcException({
      statusCode: 410,
      message:
        `order.settlement.${level} OLIB TASHLANDI (Faza 2b): pul faqat cashbox ` +
        `to'lov endpointlari orqali ko'chiriladi, ular settlement'ni outbox ` +
        `orqali avtomatik advance qiladi.`,
    });
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

  /**
   * `order_settlement_carry` jadvali bormi — QAT'IY (xato yutilmaydi).
   * `isCarryEnabled` dan farqi: uning `false` keshi yutilgan xatodan ham
   * yozilishi mumkin, shuning uchun bu yerda keshdan faqat `true` olinadi.
   */
  private async isCarryTableStrict(): Promise<boolean> {
    if (this.carryTableReady === true) {
      return true;
    }
    const schema =
      (this.dataSource.options as { schema?: string } | undefined)?.schema ||
      'public';
    const tables: Array<{ t: string | null }> = await this.dataSource.query(
      'SELECT to_regclass($1) AS t',
      [`${schema}.order_settlement_carry`],
    );
    if (!tables?.[0]?.t) {
      return false;
    }
    this.carryTableReady = true;
    this.carryCheckedAt = Date.now();
    return true;
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
    if (!(await this.isCarryTableStrict())) {
      return 0;
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
   *
   * ⚠️ CODE-28: qoldiq QAT'IY o'qiladi (`loadCourierCarryStrict`). Ilgari
   * `loadCarries` xatoni yutib `[]` qaytarardi — baza xatosida HQ kuryerining
   * "olinishi kerak" ko'rinishi qoldiqni jimgina tashlab yuborardi. Endi baza
   * xatosi RpcException 500 bo'lib chiqadi (gateway uni "tekshirib bo'lmadi"
   * deb ko'rsatadi), RMQ'da qayta navbatga qo'yilmaydi.
   */
  async getCourierSettlementScope(data: { courier_id?: string | null }) {
    const courierId = String(data?.courier_id ?? '').trim();
    if (!courierId) {
      return successRes(
        this.emptyCourierScope(),
        200,
        'Courier settlement scope',
      );
    }
    if (!/^\d+$/.test(courierId)) {
      this.badRequest("courier_id raqam ko'rinishida bo'lishi kerak");
    }

    try {
      return successRes(
        await this.computeCourierSettlementScope(courierId),
        200,
        'Courier settlement scope',
      );
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }
      this.logger.warn(
        `order.settlement.courier_scope failed (courier=${courierId}): ${(error as Error)?.message ?? error}`,
      );
      throw new RpcException({
        statusCode: 500,
        message:
          "Kuryer hisob-kitob holatini o'qib bo'lmadi (ma'lumotlar bazasi xatosi)",
      });
    }
  }

  private emptyCourierScope() {
    return {
      hq_pending_count: 0,
      hq_pending_amount: 0,
      branch_pending_count: 0,
      branch_pending_amount: 0,
      branch_ids: [] as string[],
      carry_amount: 0,
    };
  }

  /**
   * `getCourierSettlementScope` ning hisob qismi — `courierId` tekshirilgan
   * (raqam). Baza xatolari O'RALMAYDI: chaqiruvchi o'z xabari bilan o'raydi
   * (`getCourierTransferCheck` ham shuni ishlatadi). `handleDbError` tanigan
   * xatolar avvalgidek RpcException bo'lib chiqadi.
   */
  private async computeCourierSettlementScope(courierId: string) {
    const scope = this.emptyCourierScope();
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
    // CODE-28: qat'iy o'qish — xato yutilmaydi (yuqoridagi izoh).
    scope.carry_amount = await this.loadCourierCarryStrict(courierId);

    return scope;
  }

  /**
   * R3 — kuryerni filialdan filialga o'tkazish tekshiruvi (order qismi).
   * FAQAT O'QIYDI; bloklash qarorini branch-service chiqaradi.
   *
   *   • PENDING savdo — `computeCourierSettlementScope` (`getCourierSettlementScope`
   *     ning hisob qismi, o'zgarishsiz qayta ishlatiladi);
   *   • `carry_amount` — o'sha hisobning `loadCourierCarryStrict` i (xato
   *     yutilmaydi);
   *   • qo'lidagi buyurtmalar — ushlovchi KURYER va yakunlanmagan, YOKI
   *     `courier_id` shu kuryer va yo'lda/kutilmoqda (qisman sotuvning bekor
   *     qoldig'i ham, qaytarilmagan bekorlar ham birinchi shartga tushadi);
   *   • ko'rib chiqilmagan qo'shimcha xarajat so'rovlari — tasdiqlansa sotuv
   *     yoki bekor KURYER nomidan qayta o'ynaladi, ya'ni kuryer puli o'zgaradi.
   *
   * ⚠️ Baza xatosi hech qachon yutilmaydi va RpcException'ga o'raladi — xom
   * xato RMQ'da qayta navbatga qo'yilib, handler ikki marta ishlardi.
   * `computeCourierSettlementScope` ning `handleDbError` i ham tanimagan
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
      // `scope.carry_amount` — `loadCourierCarryStrict` (CODE-28: scope ham
      // endi qat'iy o'qiydi, alohida ikkinchi o'qish kerak emas).
      const [scope, ordersInHand, sampleRows, approvals] = await Promise.all([
        this.computeCourierSettlementScope(courierId),
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

      return successRes(
        {
          ...scope,
          courier_id: courierId,
          pending_settlement_count:
            scope.hq_pending_count + scope.branch_pending_count,
          pending_settlement_amount:
            scope.hq_pending_amount + scope.branch_pending_amount,
          carry_amount: scope.carry_amount,
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
    /**
     * fix3b (A4 ochiq masalasi): `branch_to_hq_by` — `bigint`. Integratsiya
     * `created_by` bo'lmasa `'system'` yuboradi; u Postgres'da 22P02 bilan
     * BUTUN update'ni yiqitardi (chaqiruvchi xatoni faqat ogohlantirish bilan
     * yutadi — qatorlar PENDING da qolib, rollback qo'riqchisi naqd HQ'ga
     * yetganini ko'rmasdi). `buildSettlementConfigs` dagi kabi: raqam
     * bo'lmasa `NULL` (ustun nullable).
     */
    const requesterId = String(data?.requester_id ?? '').trim();
    const settledBy = /^\d+$/.test(requesterId) ? requesterId : null;
    const result = await this.orderSettlementRepo
      .createQueryBuilder()
      .update(OrderSettlement)
      .set({
        status: SettlementStatus.BRANCH_SETTLED,
        courier_to_branch_at: now,
        branch_to_hq_at: now,
        branch_to_hq_by: settledBy,
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
    /**
     * M8 — advance tokenining "qo'llandi" belgisi (`ADVANCE_APPLIED_PATTERN`
     * izohi). Berilsa tranzaksiyaning BIRINCHI yozuvi sifatida kiritiladi va
     * commit bilan atomik bo'ladi; belgi allaqachon bo'lsa (boshqa commit
     * bo'lgan tranzaksiya) `AdvanceAlreadyAppliedError` otiladi va hech narsa
     * o'zgarmaydi. Kaskad chaqiruvlari bermaydi.
     */
    claimKey?: string;
    /**
     * C8 — FAQAT sof-nol yopish (`closeZeroCourierRows`). Lump-sum 0 bo'lishi
     * shart. Tranzaksiya ichida, qoldiq qatori QULFLANGANDAN keyin
     * tekshiriladi: qoldiq aynan 0 va `fromStatus` qatorlari yig'indisi aynan
     * 0 tiyin bo'lsagina FIFO ishlaydi va BARCHA qatorlar yopilishi shart.
     * MONEY-02: qoldiq musbat va yig'indiga AYNAN teng (butun tiyin) bo'lsa
     * ham — bunda oddiy FIFO sikli qoldiq bilan ishlaydi, qoldiq 0 bo'ladi.
     * Aks holda tranzaksiya qaytariladi va `rejected` da sabab qaytadi.
     */
    requireZeroNet?: boolean;
  }): Promise<{
    settled_order_ids: string[];
    allocated: number;
    leftover: number;
    /** Yopilgan qatorlarning filial/market id lari — kaskad uchun. */
    touched: { branch_ids: string[]; market_ids: string[] };
    /** Faqat `requireZeroNet`: nega hech narsa yopilmadi. */
    rejected?: ZeroNetRejection;
  }> {
    const lumpSum = Math.max(Number(params.lumpSum) || 0, 0);
    // C8: sof-nol yopishda qoldiq jadvali QAT'IY aniqlanadi — yutilgan
    // xatodan qolgan `false` kesh qoldiqni "yo'q" deb ko'rsatmasin.
    const carryEnabled = params.carryLevel
      ? params.requireZeroNet
        ? await this.isCarryTableStrict()
        : await this.isCarryEnabled()
      : false;
    // lump-sum 0 bilan faqat qoldiqni qo'llash uchun chaqiriladi (kaskad).
    // Sof-nol yopish qoldiq jadvali bo'lmasa ham tranzaksiyaga kiradi.
    if (
      !params.matchValue ||
      (lumpSum <= 0 && !carryEnabled && !params.requireZeroNet)
    ) {
      return {
        settled_order_ids: [],
        allocated: 0,
        leftover: lumpSum,
        touched: { branch_ids: [], market_ids: [] },
      };
    }
    if (params.requireZeroNet && lumpSum !== 0) {
      this.badRequest("Sof-nol yopishda lump-sum 0 bo'lishi kerak");
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
    let zeroNetRejection: ZeroNetRejection | null = null;
    try {
      const tx = queryRunner.manager;
      const repo = tx.getRepository(OrderSettlement);

      // M8: token birinchi bo'lib "egallanadi" — parallel ikkinchi ishga
      // tushish UNIQUE indeksda shu tranzaksiya tugashini kutadi.
      if (params.claimKey) {
        await this.claimAdvanceToken(tx, params.claimKey);
      }

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
      /**
       * C8 — sof-nol yopish sharti. Qoldiq qatori yuqorida QULFLANGAN, ya'ni
       * parallel to'lov uni o'zgartira olmaydi. Summalar butun tiyinda —
       * suzuvchi nuqta qoldig'i "deyarli 0" ni 0 deb o'tkazib yubormasin.
       * Qoldiq xom qiymati tekshiriladi (`carryBefore` manfiyni 0 ga qirqadi).
       *
       * MONEY-02 — QOLDIQ QOPLAGAN holat (`carryCoveredTiyin`). Superadmin
       * topshirilgan sotuvni qaytarsa, kuryer topshirgan summa uning
       * qoldig'iga kredit bo'ladi. O'sha kuryer buyurtmani AYNI summaga qayta
       * sotsa kassasi 0 (Σ PENDING − qoldiq), lekin qatorni hech narsa yopa
       * olmasdi: 0 so'm topshirib bo'lmaydi, sof-nol yopish esa qoldiq 0
       * bo'lishini talab qilardi — kuryerni o'tkazish/chiqarish uning keyingi
       * to'lovigacha 409. Endi qoldiq musbat va yig'indiga AYNAN teng bo'lsa
       * (butun tiyin), qatorlar ODDIY FIFO sikli bilan yopiladi (pastda):
       * lump-sum 0, `remaining` = qoldiq. Natija kuryer to'lovi kelib, eski
       * qoldiq qatorlarni qoplagandagi bilan AYNAN bir xil (holatlar, `postLeg`
       * chaqiruvlari, kaskad), qoldiq esa 0. Qo'shimcha shart: har qator
       * qoldiq turgan filialniki (`branch_id`; HQ kuryerida NULL). Aks holda
       * bir filial kassasidagi naqd boshqa filial qatorini yopib, ikkala
       * filial daftarini buzardi (`carry_branch_mismatch`, hech narsa
       * o'zgarmaydi).
       */
      let carryCoveredTiyin: number | null = null;
      if (params.requireZeroNet) {
        const toTiyin = (value: number) => Math.round(value * 100);
        const netTiyin = candidates.reduce(
          (sum, row) => sum + toTiyin(legOf(row)),
          0,
        );
        const carryTiyin = toTiyin(Number(carryRow?.amount ?? 0) || 0);
        if (!candidates.length) {
          zeroNetRejection = 'no_pending_rows';
        } else if (carryTiyin > 0 && carryTiyin === netTiyin) {
          const carryBranch = String(carryRow?.branch_id ?? '').trim();
          if (
            candidates.some(
              (row) => String(row.branch_id ?? '').trim() !== carryBranch,
            )
          ) {
            zeroNetRejection = 'carry_branch_mismatch';
          } else {
            carryCoveredTiyin = carryTiyin;
          }
        } else if (carryTiyin !== 0) {
          zeroNetRejection = 'carry_not_zero';
        } else if (netTiyin !== 0) {
          zeroNetRejection = 'pending_amount_not_zero';
        }
        /**
         * Lump-sum 0, qoldiq 0, yig'indi 0 bo'lganda nol FIFO (pastdagi
         * sikl) aniq arifmetikada BARCHA qatorlarni yopadi: har musbat qator
         * uchun kreditlar yetadi, kreditlar esa oxirigacha tortiladi. Shu
         * natija bu yerda to'g'ridan-to'g'ri, `createdAt` tartibida, butun
         * tiyinda qo'llanadi — suzuvchi nuqta (masalan 0,1 + 0,2 − 0,3)
         * siklni yarim yo'lda to'xtatib qo'ymasin. `allocated` = 0 aniq.
         */
        if (!zeroNetRejection && carryCoveredTiyin === null) {
          for (const row of candidates) {
            await advanceRow(row);
          }
        }
      }
      // Sof-nol (C8) yo'lida sikl ishlamaydi — qatorlar yuqorida yopildi.
      // Qoldiq qoplagan holatda (MONEY-02) — oddiy FIFO bilan AYNAN bir xil.
      const fifoRows =
        params.requireZeroNet && carryCoveredTiyin === null ? [] : payables;
      for (const settlement of fifoRows) {
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

      // C8: hammasi yoki hech narsa — yopilmay qolgan qator bo'lsa, yopilgan
      // qism sof-nol emas edi (naqdsiz yopilgan bo'lardi).
      if (
        params.requireZeroNet &&
        !zeroNetRejection &&
        settledOrderIds.length !== candidates.length
      ) {
        zeroNetRejection = 'not_fully_closed';
      }

      /**
       * Yangi qoldiq = (lump-sum + eski qoldiq) − haqiqatan yopilgan summa.
       * `remaining` EMAS: tortilib, lekin yozilmay qolgan kreditlar uni
       * sun'iy oshirgan bo'lishi mumkin.
       */
      newCarry = Math.max(lumpSum + carryBefore - allocated, 0);
      // MONEY-02: hammasi yopildi, yig'indi qoldiqqa butun tiyinda teng —
      // qoldiq to'liq sarflandi (suzuvchi nuqta qoldig'i yozilmasin).
      if (carryCoveredTiyin !== null && !zeroNetRejection) {
        allocated = carryCoveredTiyin / 100;
        newCarry = 0;
      }
      if (carryRepo && carryRow && !zeroNetRejection) {
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

      if (params.claimKey && !zeroNetRejection) {
        // Belgiga natija yoziladi — qayta ishga tushgan handler AYNAN shuni
        // qaytaradi (tashxis uchun).
        await tx.getRepository(IdempotencyKey).update(
          { key: params.claimKey },
          {
            response: {
              settled_order_ids: settledOrderIds,
              allocated,
              leftover: carryEnabled
                ? newCarry
                : Math.max(lumpSum - allocated, 0),
            },
          },
        );
      }

      if (zeroNetRejection) {
        // C8: shart bajarilmadi — hech narsa o'zgarmaydi.
        await queryRunner.rollbackTransaction();
      } else {
        await queryRunner.commitTransaction();
      }
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

    if (zeroNetRejection) {
      return {
        settled_order_ids: [],
        allocated: 0,
        leftover: 0,
        touched: { branch_ids: [], market_ids: [] },
        rejected: zeroNetRejection,
      };
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
   * M8 — advance tokenini FIFO tranzaksiyasi ichida "egallash". UNIQUE
   * buzilishi (23505) = token boshqa, commit bo'lgan tranzaksiyada
   * qo'llangan → `AdvanceAlreadyAppliedError`.
   */
  private async claimAdvanceToken(
    tx: EntityManager,
    key: string,
  ): Promise<void> {
    try {
      await tx.getRepository(IdempotencyKey).insert({
        key,
        pattern: ADVANCE_APPLIED_PATTERN,
        status: 'completed',
        completed_at: new Date(),
      });
    } catch (error) {
      const code =
        (error as { code?: string })?.code ??
        (error as { driverError?: { code?: string } })?.driverError?.code;
      if (error instanceof QueryFailedError && code === PG_UNIQUE_VIOLATION) {
        throw new AdvanceAlreadyAppliedError(key);
      }
      throw error;
    }
  }

  /** M8 — token belgisi kaliti (token uzunligidan qat'i nazar 97 belgi). */
  private advanceAppliedKey(token: string): string {
    return `${ADVANCE_APPLIED_PATTERN}:${createHash('sha256')
      .update(token)
      .digest('hex')}`;
  }

  /**
   * M8 — token allaqachon qo'llanganmi. Ha bo'lsa o'sha natija (`replayed:
   * true` bilan) qaytadi, aks holda `null`. Baza xatosi YUTILMAYDI — handler
   * yiqiladi va keyingi urinish (reclaimFailed) qayta tekshiradi.
   */
  private async findAppliedAdvance(key: string) {
    const row = await this.dataSource
      .getRepository(IdempotencyKey)
      .findOne({ where: { key } });
    if (!row) {
      return null;
    }
    const stored =
      row.response && typeof row.response === 'object'
        ? (row.response as Record<string, unknown>)
        : {};
    return successRes(
      { ...stored, replayed: true },
      200,
      'Settlement already advanced',
    );
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
    request_id?: string;
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

    const configs = this.buildSettlementConfigs(requesterId);
    const cfg = configs[data.level];
    if (!cfg) {
      this.badRequest(`Invalid settlement level: ${String(data?.level)}`);
    }

    /**
     * M8 — token allaqachon qo'llangan bo'lsa (commit o'tgan, lekin javob /
     * `markCompleted` yo'qolgan va handler qayta ishga tushgan) hech narsa
     * qilinmaydi: o'sha natija qaytadi. Token bo'lmasa (eski chaqiruvchi)
     * xatti-harakat avvalgidek.
     */
    const token = String(data?.request_id ?? '').trim();
    const appliedKey = token ? this.advanceAppliedKey(token) : undefined;
    if (appliedKey) {
      const applied = await this.findAppliedAdvance(appliedKey);
      if (applied) {
        this.logger.warn(
          `order.settlement.advance replay ignored (already applied): level=${data.level} match=${matchValue}`,
        );
        return applied;
      }
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

    let result: Awaited<
      ReturnType<OrderSettlementService['runFifoSettlement']>
    >;
    try {
      result = await this.runFifoSettlement({
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
        claimKey: appliedKey,
      });
    } catch (error) {
      // M8: parallel ishga tushgan ikkinchi nusxa — birinchisi commit bo'ldi.
      if (error instanceof AdvanceAlreadyAppliedError && appliedKey) {
        this.logger.warn(
          `order.settlement.advance concurrent replay ignored: level=${data.level} match=${matchValue}`,
        );
        return (
          (await this.findAppliedAdvance(appliedKey)) ??
          successRes(
            {
              settled_order_ids: [],
              allocated: 0,
              leftover: 0,
              replayed: true,
            },
            200,
            'Settlement already advanced',
          )
        );
      }
      throw error;
    }

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
   * Bo'g'inlar konfiguratsiyasi — advance, kaskad va sof-nol yopish uchun
   * BITTA manba (`advanceSettlement` dan o'zgarishsiz ko'chirilgan).
   *
   * `*_by` ustunlari `bigint`: raqam bo'lmagan qiymat (masalan `'system'`)
   * Postgres'da 22P02 bilan butun FIFO tranzaksiyasini yiqitardi — outbox
   * esa endi pul hodisasini to'xtovsiz qayta urinadi (M8), ya'ni bunday
   * hodisa hech qachon o'tmasdi. Shuning uchun raqam bo'lmagan qiymat `null`
   * yoziladi (ustun nullable).
   */
  private buildSettlementConfigs(requesterId: string | null) {
    const stampBy =
      requesterId && /^\d+$/.test(requesterId) ? requesterId : null;
    return {
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
          courier_to_branch_by: stampBy,
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
          branch_to_hq_by: stampBy,
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
          hq_to_market_by: stampBy,
        }),
      },
    };
  }

  /**
   * C8 (CODE-06) — kuryerning SOF-NOL PENDING `courier_to_branch` qatorlarini
   * yopish (`order.settlement.close_zero_courier_rows`).
   *
   * ⚠️ NEGA KERAK. Qatorlar faqat MUSBAT topshiriq ichidagi FIFO bilan
   * yopiladi (finance 0 so'mni qabul qilmaydi). Kuryerning oxirgi sotuvi
   * aynan uning ulushiga teng bo'lsa qator 0, kassa ham 0 — menejer 0 so'm
   * qabul qila olmaydi, kuryerni o'tkazish / filialdan chiqarish esa PENDING
   * qator tufayli abadiy 409 qaytaradi. Pul ko'chmaydi, faqat daftar yopiladi.
   *
   * Shartlar (hammasi bitta tranzaksiyada, qoldiq qatori QULFLANGAN holda,
   * `runFifoSettlement({ requireZeroNet })`):
   *   • kuryerning BARCHA PENDING qatorlari `courier_amount` yig'indisi
   *     AYNAN 0 tiyin VA `courier_to_branch` qoldig'i AYNAN 0;
   *   • YOKI (MONEY-02) qoldiq musbat va o'sha yig'indiga AYNAN teng (butun
   *     tiyin), har qator qoldiq turgan filialniki — qatorlar oddiy FIFO
   *     bilan qoldiq hisobidan yopiladi, qoldiq 0 bo'ladi (superadmin
   *     kreditidan keyin AYNI summaga qayta sotuv);
   *   • nol lump-sum FIFO BARCHA qatorlarni yopadi (hammasi yoki hech narsa).
   * Biror shart bajarilmasa hech narsa o'zgarmaydi: `closed_count: 0`,
   * sabab `skipped_reason` da. Keyin kaskad — `advanceSettlement` dagi kabi
   * (best-effort). Xatolar har doim RpcException (RMQ qayta navbatga
   * qo'ymasin). Javob: `successRes({closed_count, ...})` + yuqori darajadagi
   * `closed_count`.
   */
  async closeZeroCourierRows(data: {
    courier_id?: string | null;
    requester?: { id?: string | null; roles?: string[] } | null;
  }) {
    const courierId = String(data?.courier_id ?? '').trim();
    if (!/^\d+$/.test(courierId)) {
      this.badRequest("courier_id raqam ko'rinishida bo'lishi kerak");
    }
    const requesterId = String(data?.requester?.id ?? '').trim() || null;
    const configs = this.buildSettlementConfigs(requesterId);
    const cascadeRequesterId = requesterId ?? 'system';

    try {
      const result = await this.runFifoSettlement({
        ...configs.courier_to_branch,
        matchValue: courierId,
        lumpSum: 0,
        requesterId: cascadeRequesterId,
        postLeg: async () => {},
        requireZeroNet: true,
      });

      if (!result.rejected && result.settled_order_ids.length) {
        // Kaskad — advance'dagi kabi; C10: HQ nomidagi qoldiq qo'llanmaydi.
        const hqBranchId = result.touched.branch_ids.length
          ? await this.resolveHqBranchId()
          : null;
        await this.applyPendingCarries(
          'branch_to_hq',
          result.touched.branch_ids.filter((id) => id !== hqBranchId),
          configs,
          cascadeRequesterId,
        );
        await this.applyPendingCarries(
          'hq_to_market',
          result.touched.market_ids,
          configs,
          cascadeRequesterId,
        );
        // MONEY-02: qoldiq hisobidan yopilgan bo'lsa — sarflangan qoldiq ham.
        this.logger.log(
          `Net-zero courier rows closed: courier=${courierId} count=${result.settled_order_ids.length}${result.allocated ? ` carry_used=${result.allocated}` : ''} by=${requesterId ?? 'unknown'}`,
        );
      }

      const closedCount = result.rejected ? 0 : result.settled_order_ids.length;
      return {
        ...successRes(
          {
            courier_id: courierId,
            closed_count: closedCount,
            closed_order_ids: result.rejected ? [] : result.settled_order_ids,
            skipped_reason: result.rejected ?? null,
          },
          200,
          closedCount
            ? 'Net-zero courier settlement rows closed'
            : 'Nothing to close',
        ),
        closed_count: closedCount,
      };
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }
      this.logger.warn(
        `order.settlement.close_zero_courier_rows failed (courier=${courierId}): ${(error as Error)?.message ?? error}`,
      );
      throw new RpcException({
        statusCode: 500,
        message:
          "Kuryerning sof-nol hisob-kitob qatorlarini yopib bo'lmadi (ma'lumotlar bazasi xatosi)",
      });
    }
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
