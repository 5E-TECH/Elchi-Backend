import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  DataSource,
  EntityManager,
  FindOptionsOrder,
  FindOptionsWhere,
  In,
  IsNull,
  LessThanOrEqual,
  MoreThanOrEqual,
  Not,
  QueryFailedError,
  Raw,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift, ShiftStatus } from './entities/shift.entity';
import { applyCashboxCardSelection } from './cashbox-card/cashbox-card.service';
import { resolveSpendExpenseCategory } from './expense-category/expense-category.service';
import {
  BRANCH_SHIFT_REQUIRED_MESSAGE,
  SHIFT_REQUIRED_MESSAGE,
  isShiftRequiredFor,
  shiftGateBlockedLogLine,
  shiftGateScope,
} from './shift-gate';
import {
  CardMovementType,
  CashboxCardMovement,
} from './entities/cashbox-card-movement.entity';
import { UserSalary } from './entities/user-salary.entity';
import { OperatorEarning } from './entities/operator-earning.entity';
import { OperatorPayment } from './entities/operator-payment.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import {
  ActivityAction,
  ActivityDescribeUz,
  ActivityLogQuery,
  ActivityLogService,
  Cashbox_type,
  Commission_type,
  FinancialSource_type,
  Operation_type,
  Order_status,
  PaymentMethod,
  Source_type,
  rmqSend,
  OutboxService,
  tashkentDayRange,
  toPublicUserSummary,
  type PublicUserSummary,
} from '@app/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { CreateCashboxDto } from './dto/cashbox/create-cashbox.dto';
import { FindCashboxByUserDto } from './dto/cashbox/find-cashbox-by-user.dto';
import { UpdateCashboxBalanceDto } from './dto/cashbox/update-cashbox-balance.dto';
import { FindHistoryDto } from './dto/history/find-history.dto';
import { OpenShiftDto } from './dto/shift/open-shift.dto';
import { CloseShiftDto } from './dto/shift/close-shift.dto';
import { FindShiftsDto } from './dto/shift/find-shifts.dto';
import { CreateSalaryDto } from './dto/salary/create-salary.dto';
import { UpdateSalaryDto } from './dto/salary/update-salary.dto';
import { FindSalaryByUserDto } from './dto/salary/find-salary-by-user.dto';
import { FinanceNotificationService } from './notification/finance-notification.service';
import { SettlementUnappliedService } from './settlement/settlement-unapplied.service';
import { CourierPaymentAckService } from './courier-payment/courier-payment-ack.service';
import { FinanceRealtimeService } from './realtime/finance-realtime.service';
import type { ShiftAccountCheckService } from './shift-account-check/shift-account-check.service';
import { SHIFT_ACCOUNT_CHECKS } from './shift-account-check/shift-account-check.token';
import {
  CASHBOX_RECEIPTS,
  type LinkedReceiptRef,
  type ReceiptLinkRequest,
} from './cashbox-receipt/cashbox-receipt.token';
import type { CashboxReceiptService } from './cashbox-receipt/cashbox-receipt.service';
import {
  briefReceipt,
  fullReceipt,
  isReceiptFilterStatus,
  loadReceiptsForHistory,
  receiptStatusIdCondition,
  type ReceiptTables,
} from './cashbox-receipt/cashbox-receipt.views';
import type { CashboxReceipt } from './entities/cashbox-receipt.entity';

/**
 * T3 — entity NOMI bo'yicha (sinf importi emas): eski spec'lar `@app/common`
 * ni mock qiladi, `BaseEntity` li entity'ni yuklash ularni yiqitardi.
 */
const CASHBOX_RECEIPT_ENTITY = 'CashboxReceipt';
import {
  SHIFT_REPORTS,
  type ShiftReportTrigger,
} from './shift-report/shift-report.token';
import { ShiftScheduleClaim } from './entities/shift-schedule-claim.entity';
import {
  autoCloseClaimKey,
  autoClosedLabel,
} from './shift-auto-close/shift-schedule.rules';
import {
  attachCorrectionViews,
  evaluateCorrectable,
  readWindowSetting,
  type HistoryWithCashbox,
} from './payment-correction/payment-correction.rules';

/**
 * `order.find_all` qatoridan market to'lovi sinxroni o'qiydigan maydonlar
 * (audit M9). Pul maydonlari numeric ustunlar — matn bo'lib ham kelishi
 * mumkin, shu bois `Number(...)` bilan o'qiladi.
 */
interface MarketPayableOrder {
  id: string;
  status?: Order_status | string | null;
  to_be_paid?: number | string | null;
  paid_amount?: number | string | null;
  extra_cost?: number | string | null;
  createdAt?: string | Date | null;
}

/** `paymentsFromCourier` / `applyCourierPaymentInTx` kirishi. */
export interface CourierPaymentInput {
  courier_id: string;
  amount: number;
  payment_method: PaymentMethod;
  payment_date?: string;
  comment?: string;
  market_id?: string;
  created_by?: string;
  receiver_user_id?: string;
  receiver_cashbox_type?: Cashbox_type;
  // Per-request idempotency token from the gateway; dedupes RMQ redelivery /
  // double-submit so the cash is never moved twice. (Audit P0-3.)
  dedup_epoch?: string;
  /**
   * Zv3MLn0a — CLICK pul QABUL QILUVCHI kassaning (HQ MAIN yoki menejer
   * yo'lida filial kassasi) qaysi kartasiga tushdi. Yo'q — Asosiy karta.
   */
  card_id?: string;
  /** T3 — gateway: faqat superadmin/admin'ning HQ'ga qabul yo'li. */
  receipt_policy?: { kind?: unknown };
  receipt_id?: unknown;
}

/** `paymentsToMarket` / `applyMarketPaymentInTx` kirishi. */
export interface MarketPaymentInput {
  market_id: string;
  amount: number;
  payment_method: PaymentMethod;
  payment_date?: string;
  comment?: string;
  created_by?: string;
  // Per-request idempotency token from the gateway. (Audit P0-3.)
  dedup_epoch?: string;
  // (3PE0B03q) "O'tkazma manbasi" — faqat audit.
  transfer_source_user_id?: string;
  // 3PE0B03q — CLICK to'lov MAIN kassaning qaysi nomli kartasidan.
  card_id?: string;
}

/** (8OYPuz7J) Smena qatori + ochgan / yopgan xodim ismi (identity'dan). */
export type ShiftWithNames = Shift & {
  opened_by_name: string | null;
  closed_by_name: string | null;
};

@Injectable()
export class FinanceServiceService implements OnModuleInit, OnModuleDestroy {
  private static readonly MAIN_CASHBOX_USER_ID = '0';
  private readonly logger = new Logger(FinanceServiceService.name);

  /**
   * Market bo'yicha to'lovdan KEYINGI buyurtma sinxronlari navbati (audit M2).
   * Sinxron javobni kutdirmaydi (fonda ishlaydi), lekin bitta marketning
   * sinxronlari KETMA-KET bajariladi: ikki to'lov bir xil SOLD buyurtmalarni
   * parallel o'qib, ularga to'lovni ikki marta yozmasligi uchun.
   */
  private readonly marketOrderSyncChains = new Map<string, Promise<void>>();

  /**
   * Fondagi ishlar (buyurtma sinxroni, hamkor xabari) — servis to'xtaganda
   * (deploy) ular yarmida uzilmasligi uchun `onModuleDestroy` biroz kutadi.
   */
  private readonly pendingFollowUps = new Set<Promise<void>>();
  private static readonly FOLLOW_UP_DRAIN_TIMEOUT_MS = 5_000;

  constructor(
    @InjectRepository(Cashbox)
    private readonly cashboxRepo: Repository<Cashbox>,
    @InjectRepository(CashboxHistory)
    private readonly historyRepo: Repository<CashboxHistory>,
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(UserSalary)
    private readonly salaryRepo: Repository<UserSalary>,
    @InjectRepository(OperatorEarning)
    private readonly earningRepo: Repository<OperatorEarning>,
    @InjectRepository(OperatorPayment)
    private readonly paymentRepo: Repository<OperatorPayment>,
    @InjectRepository(FinancialBalanceHistory)
    private readonly financialHistoryRepo: Repository<FinancialBalanceHistory>,
    private readonly dataSource: DataSource,
    private readonly activityLog: ActivityLogService,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    private readonly outbox: OutboxService,
    // (ePpLHPX2) To'lov / balans to'ldirish → bildirishnoma (FAQAT outbox,
    // pul tranzaksiyasi ichida). Ixtiyoriy: eski spec'lar servisni
    // 13 argument bilan quradi — u holda bildirishnoma yo'q.
    @Optional()
    private readonly financeNotifications?: FinanceNotificationService,
    // znD3KaZL — advance javobidagi FIFO qoldig'ini `finance_settlement_
    // unapplied` ga yozish (tezkor yo'l). Ixtiyoriy: eski spec'lar
    // servisni 13/14 argument bilan quradi — u holda faqat WARN log.
    @Optional()
    private readonly settlementUnapplied?: SettlementUnappliedService,
    // (2crjWf7v #4) kuryer kvitansiya javobi — hisobot ro'yxatida flag.
    @Optional()
    private readonly courierAcks?: CourierPaymentAckService,
    // (rWdLuoP3) Smena yopildi → realtime (outbox → gateway → socket).
    // Ixtiyoriy: eski spec'lar servisni usiz quradi — u holda hodisa yo'q.
    @Optional()
    private readonly financeRealtime?: FinanceRealtimeService,
    // (kiZgTybn) Yopishda har karta qoldig'ini tasdiqlash + hisobot.
    // Ixtiyoriy: eski spec'lar usiz quradi — u holda `accounts[]` e'tiborsiz.
    @Optional()
    @Inject(SHIFT_ACCOUNT_CHECKS)
    private readonly shiftAccountChecks?: ShiftAccountCheckService,
    // (gWI4gYkw) Yopilgandan keyin smena hisobotini yuborish (fon).
    // Ixtiyoriy: eski spec'lar usiz quradi — u holda navbat `pending`
    // qoladi (scheduler oladi) yoki umuman ishlatilmaydi.
    @Optional()
    @Inject(SHIFT_REPORTS)
    private readonly shiftReports?: ShiftReportTrigger,
    // T3 — kassa chekini pul tranzaksiyasida bog'lash. Ixtiyoriy: eski
    // spec'lar usiz quradi — u holda `receipt_policy` e'tiborsiz.
    @Optional()
    @Inject(CASHBOX_RECEIPTS)
    private readonly receipts?: CashboxReceiptService,
  ) {}

  /**
   * T3 — gateway'ning `receipt_policy` si (faqat 3 HTTP yo'li: qo'lda
   * chiqim, kuryer → HQ, filial → HQ). Ichki RMQ chaqiruvlarida yo'q —
   * chek talab qilinmaydi.
   */
  private receiptRequest(
    data: {
      receipt_policy?: { kind?: unknown };
      receipt_id?: unknown;
      created_by?: unknown;
    },
    kind: ReceiptLinkRequest['kind'],
  ): ReceiptLinkRequest | null {
    if (!this.receipts || data?.receipt_policy?.kind !== kind) return null;
    return {
      kind,
      receipt_id: data.receipt_id,
      requester_id: data.created_by,
    };
  }

  /**
   * T3 — HQ'ga o'tkazma cheki: `history_id` — MAIN INCOME, `counter` —
   * kuryer EXPENSE; ikkalasi `transfer_id` (T6) bo'yicha topiladi (vaqt
   * taxminiga tayanmaydi).
   */
  private async linkTransferReceipt(
    manager: EntityManager,
    request: ReceiptLinkRequest,
    ctx: {
      transfer_id: string;
      receiver_cashbox_id: string;
      counter_cashbox_id: string;
      amount: number;
      payment_method: PaymentMethod | string;
      courier_id?: string | null;
    },
  ): Promise<LinkedReceiptRef | null> {
    if (!this.receipts) return null;
    const legs = await manager.find(CashboxHistory, {
      where: { transfer_id: ctx.transfer_id },
    });
    const income = legs.find(
      (leg) =>
        String(leg.cashbox_id) === ctx.receiver_cashbox_id &&
        leg.operation_type === Operation_type.INCOME,
    );
    const expense = legs.find(
      (leg) =>
        String(leg.cashbox_id) === ctx.counter_cashbox_id &&
        leg.operation_type === Operation_type.EXPENSE,
    );
    const applicable =
      ctx.payment_method === PaymentMethod.CLICK && Boolean(income);
    return this.receipts.linkInTx(manager, request, {
      applicable,
      history_id: String(income?.id ?? ''),
      counter_history_id: expense ? String(expense.id) : null,
      entered_amount: ctx.amount,
      payment_method: String(ctx.payment_method),
      card_id: income?.card_id ? String(income.card_id) : null,
      courier_id: ctx.courier_id ?? null,
    });
  }

  private async findCourierReplayReceipt(
    manager: EntityManager,
    data: CourierPaymentInput,
  ): Promise<LinkedReceiptRef | null> {
    if (!this.receipts) return null;
    const courierCashbox = await manager.findOne(Cashbox, {
      where: {
        user_id: String(data.courier_id),
        cashbox_type: Cashbox_type.FOR_COURIER,
      },
    });
    if (!courierCashbox) return null;
    const leg = await this.findDedupLeg(manager, {
      cashbox_id: String(courierCashbox.id),
      source_type: Source_type.COURIER_PAYMENT,
      source_id: String(data.courier_id),
      dedup_epoch: String(data.dedup_epoch ?? '').trim(),
    });
    return leg
      ? this.receipts.findForReplay(manager, {
          counter_history_id: String(leg.id),
        })
      : null;
  }

  /** O'tkazmaning manba (kuryer / filial) EXPENSE oyog'i — takror uchun. */
  private findDedupLeg(
    manager: EntityManager,
    params: {
      cashbox_id: string;
      source_type: Source_type;
      source_id: string;
      dedup_epoch: string;
    },
  ) {
    if (!params.dedup_epoch) return Promise.resolve(null);
    return manager.findOne(CashboxHistory, {
      where: {
        cashbox_id: String(params.cashbox_id),
        source_type: params.source_type,
        source_id: String(params.source_id),
        operation_type: Operation_type.EXPENSE,
        dedup_epoch: params.dedup_epoch,
      },
    });
  }

  async onModuleInit() {
    const main = await this.cashboxRepo.findOne({
      where: {
        user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
        isDeleted: false,
      },
    });

    if (!main) {
      const entity = this.cashboxRepo.create({
        user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
        balance: 0,
        balance_cash: 0,
        balance_card: 0,
      });
      await this.cashboxRepo.save(entity);
    }
  }

  /**
   * Deploy/to'xtatishda fondagi to'lov ishlarini (buyurtma sinxroni, hamkor
   * xabari) qisqa muddat kutadi. Ular best-effort: muddat tugasa yoki xato
   * bo'lsa — faqat kutish to'xtaydi, pul harakati allaqachon commit bo'lgan.
   */
  async onModuleDestroy() {
    if (!this.pendingFollowUps.size) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.pendingFollowUps]),
      new Promise<void>((resolve) => {
        timer = setTimeout(
          resolve,
          FinanceServiceService.FOLLOW_UP_DRAIN_TIMEOUT_MS,
        );
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
  }

  private successRes(data: any, code = 200, message = 'success') {
    return {
      statusCode: code,
      message,
      data,
    };
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

  private toRpcError(error: unknown): never {
    if (error instanceof RpcException) {
      throw error;
    }

    if (error instanceof NotFoundException) {
      throw new RpcException({ statusCode: 404, message: error.message });
    }

    if (error instanceof BadRequestException) {
      throw new RpcException({ statusCode: 400, message: error.message });
    }

    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }

  private assertBigIntId(value: string | undefined, fieldName: string) {
    if (!value || !/^\d+$/.test(String(value))) {
      throw new BadRequestException(
        `${fieldName} must be a bigint-like numeric string`,
      );
    }
  }

  private assertPositiveAmount(value: number, fieldName = 'amount') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(`${fieldName} must be greater than 0`);
    }
  }

  private parseDate(value?: string | null): Date | undefined {
    if (!value) {
      return undefined;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`Invalid date format: ${value}`);
    }

    return date;
  }

  private parseSourceTypes(value?: string | null): Source_type[] | undefined {
    const raw = String(value ?? '').trim();
    if (!raw) {
      return undefined;
    }

    const allowed = new Set(Object.values(Source_type));
    const sourceTypes = raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    for (const sourceType of sourceTypes) {
      if (!allowed.has(sourceType as Source_type)) {
        throw new BadRequestException(`Invalid source_type: ${sourceType}`);
      }
    }

    return sourceTypes as Source_type[];
  }

  private normalizeBalance(cashbox: Cashbox) {
    cashbox.balance =
      Number(cashbox.balance_cash) + Number(cashbox.balance_card);
  }

  private async ensureMainCashbox() {
    const main = await this.cashboxRepo.findOne({
      where: {
        user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
        isDeleted: false,
      },
    });
    if (!main) {
      const created = this.cashboxRepo.create({
        user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
        balance: 0,
        balance_cash: 0,
        balance_card: 0,
      });
      return this.cashboxRepo.save(created);
    }
    return main;
  }

  /**
   * Sum the balances of all active cashboxes of a given type, in SQL.
   *
   * Perf (audit P2): callers used to `cashboxRepo.find({ where: { cashbox_type } })`
   * and `.reduce()` in JS purely to obtain a total — materialising every row
   * (courier/market cashboxes grow unbounded) just to add up one column. This
   * pushes the aggregation down to `SUM(balance)` so only the scalar crosses the
   * wire. `balance` is a numeric column, so pg returns the SUM as a string.
   */
  /**
   * Filial kassasi qoldig'i > daftardagi "berilishi kerak" bo'lgan filiallar
   * (03avx8hG). Filial kassalari soni filiallar soniga teng — ro'yxat
   * chegaralangan. Bu yordamchi nazorat: xato bo'lsa kompaniya holati
   * hisoboti to'xtamaydi, bo'sh ro'yxat qaytadi (kargo qarzi bilan bir xil).
   */
  private async findBranchCashExceedingPayable(
    payables: Array<{ branch_id: string; amount: number }>,
  ): Promise<
    Array<{
      branch_id: string;
      cashbox_balance: number;
      payable: number;
      excess: number;
    }>
  > {
    try {
      const payableByBranch = new Map(
        payables.map((row) => [String(row.branch_id), Number(row.amount) || 0]),
      );
      const cashboxes = await this.cashboxRepo.find({
        where: { cashbox_type: Cashbox_type.BRANCH, isDeleted: false },
        select: { user_id: true, balance: true },
      });
      return cashboxes
        .map((cashbox) => {
          const branchId = String(cashbox.user_id);
          const cashboxBalance = Number(cashbox.balance) || 0;
          const payable = payableByBranch.get(branchId) ?? 0;
          return {
            branch_id: branchId,
            cashbox_balance: cashboxBalance,
            payable,
            excess: cashboxBalance - payable,
          };
        })
        .filter((row) => row.cashbox_balance > 0 && row.excess > 0)
        .sort((a, b) => b.excess - a.excess);
    } catch (error) {
      this.logger.warn(
        `Filial kassasi nazorati hisoblanmadi: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /**
   * Moliyaviy hisobot jami summalari (QGxC7v1E). Ilgari analytics ularni
   * paginatsiyalangan SAHIFA (default 20 qator) ustidan yig'ardi — kirim
   * 30 barobar kam, sof foyda ishorasi teskari chiqardi. Endi AYNI filtrli
   * so'rov sahifasiz, SQL SUM bilan; oylar Toshkent vaqti bo'yicha.
   */
  private async sumHistoryTotals(qb: SelectQueryBuilder<CashboxHistory>) {
    const income = `COALESCE(SUM(CASE WHEN h.operation_type = 'income' THEN h.amount ELSE 0 END), 0)`;
    const outcome = `COALESCE(SUM(CASE WHEN h.operation_type = 'expense' THEN h.amount ELSE 0 END), 0)`;
    const unpaged = () => qb.clone().skip(undefined).take(undefined).orderBy();

    const totalsRow = await unpaged()
      .select(income, 'income')
      .addSelect(outcome, 'outcome')
      .getRawOne<{ income: string; outcome: string }>();
    const monthlyRows = await unpaged()
      .select(
        `to_char(h."createdAt" AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM')`,
        'month',
      )
      .addSelect(income, 'income')
      .addSelect(outcome, 'outcome')
      .groupBy('month')
      .orderBy('month', 'ASC')
      .getRawMany<{ month: string; income: string; outcome: string }>();

    const totalIncome = Number(totalsRow?.income ?? 0);
    const totalOutcome = Number(totalsRow?.outcome ?? 0);
    return {
      periodTotals: {
        income: totalIncome,
        outcome: totalOutcome,
        net: totalIncome - totalOutcome,
      },
      periodMonthly: monthlyRows.map((row) => ({
        month: row.month,
        income: Number(row.income ?? 0),
        outcome: Number(row.outcome ?? 0),
        amount: Number(row.income ?? 0) - Number(row.outcome ?? 0),
      })),
    };
  }

  private async sumCashboxBalanceByType(
    cashboxType: Cashbox_type,
  ): Promise<number> {
    const row = await this.cashboxRepo
      .createQueryBuilder('c')
      .select('COALESCE(SUM(c.balance), 0)', 'total')
      .where('c.cashbox_type = :cashboxType', { cashboxType })
      .andWhere('c.isDeleted = :active', { active: false })
      .getRawOne<{ total: string }>();
    return Number(row?.total ?? 0);
  }

  /**
   * Faqat MUSBAT balanslar yig'indisi (audit M16) — "berilishi kerak": HQ
   * marketlarga haqiqatan to'lashi kerak bo'lgan summa.
   *
   * Imzoli SUM (`sumCashboxBalanceByType`) manfiy kassalarni (market bizga
   * qarzdor: onlayn to'lov, 0 so'mlik buyurtma, qo'shimcha xarajat) boshqa
   * marketlarga qarzdan AYIRARDI — A marketga 1 000 000, B market −200 000
   * bo'lsa karta 800 000 ko'rsatardi, holbuki A ga to'liq 1 000 000 to'lanadi.
   * Imzoli yig'indi kompaniya holati (`financialBalance`) uchun qoladi.
   */
  private async sumPositiveCashboxBalanceByType(
    cashboxType: Cashbox_type,
  ): Promise<number> {
    const row = await this.cashboxRepo
      .createQueryBuilder('c')
      .select('COALESCE(SUM(GREATEST(c.balance, 0)), 0)', 'total')
      .where('c.cashbox_type = :cashboxType', { cashboxType })
      .andWhere('c.isDeleted = :active', { active: false })
      .getRawOne<{ total: string }>();
    return Number(row?.total ?? 0);
  }

  private calcIncomeOutcome(histories: CashboxHistory[]) {
    let income = 0;
    let outcome = 0;
    for (const history of histories) {
      if (history.operation_type === Operation_type.INCOME) {
        income += Number(history.amount);
      } else {
        outcome += Number(history.amount);
      }
    }
    return { income, outcome };
  }

  /**
   * Kassa tarixi sana filtri — Toshkent kuni, dashboard va GET /orders bilan
   * AYNI qoida (SqVMuhKo). Ilgari 'YYYY-MM-DD' UTC yarim tuni, oxiri esa
   * server TZ'idagi setHours edi (prod UTC → kun Toshkentda 05:00-04:59).
   * To'liq ISO qiymat o'zgarishsiz ishlatiladi. Yaroqsiz qiymat avvalgidek
   * 400 'Invalid date format: <v>'.
   */
  private parseDateRange(fromDate?: string, toDate?: string) {
    this.parseDate(fromDate ?? null);
    this.parseDate(toDate ?? null);
    return tashkentDayRange(fromDate, toDate);
  }

  /** `order.find_all` sahifasi — order-service `MAX_LIMIT` (100) bilan bir xil. */
  private static readonly MARKET_SYNC_PAGE_SIZE = 100;
  /**
   * Bitta to'lov sinxronida o'qiladigan sahifalar chegarasi (50 × 100 = 5 000
   * buyurtma) — cheksiz aylanishdan himoya.
   */
  private static readonly MARKET_SYNC_MAX_PAGES = 50;

  /** RPC xatosining matni (mikroservis xatosi oddiy obyekt bo'lib keladi). */
  private rpcErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message) {
        return message;
      }
    }
    return fallback;
  }

  /** RPC xatosining HTTP holat kodi. Aniqlanmasa — null. */
  private rpcErrorStatus(error: unknown): number | null {
    if (error instanceof RpcException) {
      const inner = error.getError();
      const code =
        inner && typeof inner === 'object'
          ? (inner as { statusCode?: unknown }).statusCode
          : undefined;
      return typeof code === 'number' ? code : null;
    }
    if (error && typeof error === 'object') {
      const code = (error as { statusCode?: unknown }).statusCode;
      if (typeof code === 'number' && Number.isInteger(code)) {
        return code;
      }
    }
    return null;
  }

  /**
   * Buyurtmaning marketga hali to'lanmagan SOF qismi (audit M9).
   *
   * `to_be_paid` = yig'ilgan naqd − market tarifi. Sotuvda market kassasidan
   * qo'shimcha xarajat (`extra_cost`) ALOHIDA yechiladi, ya'ni market bu
   * buyurtma uchun `to_be_paid − extra_cost` oladi — settlement ledger'idagi
   * `market_amount` (collectible − tarif − extra_cost) bilan bir xil. Ilgari
   * to'liq `to_be_paid` talab qilinardi: market kassasi 0 ga tushsa ham
   * qo'shimcha xarajatli buyurtmalar SOLD bo'lib qolardi. Allaqachon
   * to'langan qism (`paid_amount`) ham ayriladi.
   */
  /**
   * Buyurtma bo'yicha marketga QANCHA qoldi — ISHORALI (BeePost namunasi).
   *
   * ⚠️ `Math.max(..., 0)` ATAYLAB OLIB TASHLANDI. Sof summa `to_be_paid −
   * extra_cost − paid` MANFIY bo'lishi mumkin: extra_cost (kuryer haqqi) market
   * daromadidan (to_be_paid) oshsa, market BIZGA qarzdor bo'ladi. Ilgari qisish
   * tufayli bu qarz hovuzga qaytmasdi va «marketga hamma pulni to'lasam ham
   * oxirgi buyurtmalar yopilmaydi» nuqsoni chiqardi (qisilgan qoldiqlar
   * yig'indisi kassa balansidan katta bo'lardi). Endi ishorali — yig'indi aynan
   * kassa balansiga teng.
   *   musbat — marketga qarzdormiz;  manfiy — market bizga qarzdor.
   */
  private marketOrderRemaining(order: MarketPayableOrder): number {
    const toBePaid = Math.max(Number(order?.to_be_paid ?? 0) || 0, 0);
    const extraCost = Math.max(Number(order?.extra_cost ?? 0) || 0, 0);
    const paid = Math.max(Number(order?.paid_amount ?? 0) || 0, 0);
    return toBePaid - extraCost - paid;
  }

  /**
   * Marketga to'lanadigan buyurtmalar (SOLD + PARTLY_PAID), ENG ESKISI
   * BIRINCHI (`sort_by=created_at`, `sort_dir=asc`), sahifama-sahifa.
   *
   * ⚠️ AUDIT M9. Ilgari ikkita `order.find_all` `limit: 1000` bilan
   * chaqirilardi, lekin order-service `limit` ni 100 ga qisadi va sukut
   * tartibi `createdAt DESC` — ya'ni faqat ENG YANGI 100 ta buyurtma
   * ko'rilardi, eskilari abadiy SOLD qolardi (7AWmSQ1p shu 100 tani qayta
   * saralagan, xolos). Endi tartib bazada, sahifalar to'lovni qoplaguncha
   * o'qiladi.
   *
   * O'qish YOZISHDAN OLDIN tugaydi: yozish holatni o'zgartiradi (PAID filtrdan
   * chiqadi) va keyingi sahifalarni siljitardi.
   */
  private async findMarketPayableOrders(
    marketId: string,
    amount: number,
  ): Promise<MarketPayableOrder[]> {
    const pageSize = FinanceServiceService.MARKET_SYNC_PAGE_SIZE;
    const orders: MarketPayableOrder[] = [];
    let covered = 0;
    for (
      let page = 1;
      page <= FinanceServiceService.MARKET_SYNC_MAX_PAGES;
      page += 1
    ) {
      const response = await rmqSend<{ data?: MarketPayableOrder[] }>(
        this.orderClient,
        { cmd: 'order.find_all' },
        {
          query: {
            market_id: marketId,
            status: [Order_status.PARTLY_PAID, Order_status.SOLD],
            sort_by: 'created_at',
            sort_dir: 'asc',
            page,
            limit: pageSize,
          },
        },
      );
      const rows = Array.isArray(response?.data) ? response.data : [];
      for (const row of rows) {
        orders.push(row);
        covered += this.marketOrderRemaining(row);
      }
      if (rows.length < pageSize || covered >= amount) {
        break;
      }
    }
    return orders;
  }

  /**
   * Buyurtmaga to'lov holatini yozadi.
   *
   * SOLD → PARTLY_PAID o'tishi order-service holat mashinasida hali yo'q
   * bo'lishi mumkin — rad etilsa (4xx) faqat `paid_amount` yoziladi: qisman
   * to'langan summa yo'qolmaydi (ilgari butun yozuv tashlab yuborilardi),
   * holat esa SOLD bo'lib qoladi.
   */
  private async writeOrderPayment(
    order: MarketPayableOrder,
    dto: { paid_amount: number; status: Order_status },
    // T6 — to'lov tuzatishi sinxroni: hamkorga holat yuborilmaydi.
    opts: { suppressExternalSync?: boolean } = {},
  ): Promise<void> {
    const extra = opts.suppressExternalSync
      ? { suppress_external_sync: true }
      : {};
    try {
      await rmqSend(
        this.orderClient,
        { cmd: 'order.update_normalized' },
        { id: order.id, dto, ...extra },
      );
    } catch (error) {
      const status = this.rpcErrorStatus(error);
      const isRejectedPartial =
        dto.status === Order_status.PARTLY_PAID &&
        order.status !== Order_status.PARTLY_PAID &&
        status !== null &&
        status >= 400 &&
        status < 500;
      if (!isRejectedPartial) {
        throw error;
      }
      await rmqSend(
        this.orderClient,
        { cmd: 'order.update_normalized' },
        { id: order.id, dto: { paid_amount: dto.paid_amount }, ...extra },
      );
    }
  }

  /**
   * Market to'lovini buyurtmalarga FIFO bo'yicha yozadi (eng eskisi birinchi):
   * qoplangan buyurtma — PAID (`paid_amount = to_be_paid`), chegaradagisi —
   * PARTLY_PAID. Har bir buyurtmadan uning SOF qoldig'i
   * (`marketOrderRemaining`) olinadi. Birinchi xatoda to'xtaydi — FIFO
   * ketma-ketligida "teshik" qolmasin.
   */
  private async applyPaymentToOrders(
    marketId: string,
    amount: number,
    opts: { suppressExternalSync?: boolean } = {},
  ) {
    let paymentInProcess = Number(amount);
    if (!(paymentInProcess > 0)) {
      return;
    }

    const orders = await this.findMarketPayableOrders(
      marketId,
      paymentInProcess,
    );

    for (const order of orders) {
      const remaining = this.marketOrderRemaining(order);
      const fullPaid = Math.max(Number(order.to_be_paid ?? 0) || 0, 0);

      if (remaining < 0) {
        // Market BIZGA qarzdor (extra_cost > daromad) — pul SARFLANMAYDI, aksincha
        // hovuz OSHADI (qarzni keyingi buyurtmalarга qo'llaymiz), order yopiladi.
        // ⚠️ `break` EMAS: hovuz bo'sh bo'lsa ham manfiy qator uni to'ldirishi
        // mumkin — shu bois davom etamiz (BeePost namunasi).
        paymentInProcess -= remaining; // remaining manfiy → pool oshadi
        await this.writeOrderPayment(
          order,
          {
            paid_amount: fullPaid,
            status: Order_status.PAID,
          },
          opts,
        );
      } else if (remaining === 0) {
        // Hisob teng — statusни yopamiz (pulga tegmaymiz).
        await this.writeOrderPayment(
          order,
          {
            paid_amount: fullPaid,
            status: Order_status.PAID,
          },
          opts,
        );
      } else if (paymentInProcess <= 0) {
        // Pul tugadi — musbat qatorni o'tkazib yuboramiz (oldinda manfiy qator
        // hovuzni to'ldirib keyingisini yopishi mumkin, shuning uchun break emas).
        continue;
      } else if (paymentInProcess >= remaining) {
        paymentInProcess -= remaining;
        await this.writeOrderPayment(
          order,
          {
            paid_amount: fullPaid,
            status: Order_status.PAID,
          },
          opts,
        );
      } else {
        const paidBefore = Math.max(Number(order.paid_amount ?? 0) || 0, 0);
        await this.writeOrderPayment(
          order,
          {
            paid_amount: paidBefore + paymentInProcess,
            status: Order_status.PARTLY_PAID,
          },
          opts,
        );
        paymentInProcess = 0;
      }
    }
  }

  /**
   * T6 — marketga to'lov QAYTARILGANDA buyurtmalardagi to'langan qismni
   * kamaytirish: ENG YANGI PAID / PARTLY_PAID buyurtmadan boshlab (to'lov
   * oxirgi yopganlarini birinchi ochadi), `order.payment_reversal.apply`.
   *
   * Buyurtmaning to'lovdan olgan qismi: PAID — `paid_amount − extra_cost`
   * (`applyPaymentToOrders` PAID da `paid_amount = to_be_paid` yozadi, market
   * esa `to_be_paid − extra_cost` olgan), PARTLY_PAID — `paid_amount`. Shu
   * qism kamayadi: qolsa PARTLY_PAID, qolmasa SOLD. Market bizga qarzdor
   * bo'lgan (qismi ≤ 0) PAID buyurtma va CLOSED — tegilmaydi. Birinchi xatoda
   * to'xtaydi (best-effort, fonda — pul allaqachon commit bo'lgan).
   */
  private async revertPaymentFromOrders(marketId: string, amount: number) {
    let left = Math.round(Number(amount) * 100) / 100;
    if (!(left > 0)) {
      return;
    }
    const pageSize = FinanceServiceService.MARKET_SYNC_PAGE_SIZE;
    const orders: MarketPayableOrder[] = [];
    let covered = 0;
    for (
      let page = 1;
      page <= FinanceServiceService.MARKET_SYNC_MAX_PAGES;
      page += 1
    ) {
      const response = await rmqSend<{ data?: MarketPayableOrder[] }>(
        this.orderClient,
        { cmd: 'order.find_all' },
        {
          query: {
            market_id: marketId,
            status: [Order_status.PAID, Order_status.PARTLY_PAID],
            sort_by: 'created_at',
            sort_dir: 'desc',
            page,
            limit: pageSize,
          },
        },
      );
      const rows = Array.isArray(response?.data) ? response.data : [];
      for (const row of rows) {
        orders.push(row);
        covered += this.orderPaidPortion(row);
      }
      if (rows.length < pageSize || covered >= left) {
        break;
      }
    }

    for (const order of orders) {
      if (!(left > 0)) break;
      const portion = this.orderPaidPortion(order);
      if (!(portion > 0)) continue;
      const take = Math.min(portion, left);
      const rest = Math.round((portion - take) * 100) / 100;
      await rmqSend(
        this.orderClient,
        { cmd: 'order.payment_reversal.apply' },
        {
          order_id: String(order.id),
          paid_amount: rest,
          status: rest > 0 ? Order_status.PARTLY_PAID : Order_status.SOLD,
        },
      );
      left = Math.round((left - take) * 100) / 100;
    }
  }

  /** Buyurtmaning market to'lovidan olgan qismi (`revertPaymentFromOrders`). */
  private orderPaidPortion(order: MarketPayableOrder): number {
    const paid = Math.max(Number(order?.paid_amount ?? 0) || 0, 0);
    if (order?.status === Order_status.PAID) {
      const extraCost = Math.max(Number(order?.extra_cost ?? 0) || 0, 0);
      return Math.max(paid - extraCost, 0);
    }
    return order?.status === Order_status.PARTLY_PAID ? paid : 0;
  }

  /**
   * T6 — to'lov qaytarilgan / tuzatilgan market buyurtmalari sinxroni
   * (commit'dan keyin, FONDA, oddiy to'lov sinxroni bilan BIR navbatda —
   * `marketOrderSyncChains`). Avval `reverted` qaytariladi, keyin (tahrirda)
   * `applied` qo'llanadi. Hamkorga xabar YO'Q (ega qarori: jurnalda
   * `partner_notified: false`). Promise hech qachon reject bo'lmaydi.
   */
  scheduleMarketPaymentCorrectionSync(input: {
    market_id: string;
    reverted: number;
    applied?: number | null;
  }): Promise<void> {
    const marketId = String(input.market_id);
    const run = async () => {
      try {
        await this.revertPaymentFromOrders(marketId, Number(input.reverted));
        if (Number(input.applied) > 0) {
          await this.applyPaymentToOrders(marketId, Number(input.applied), {
            suppressExternalSync: true,
          });
        }
      } catch (error) {
        this.logger.warn(
          `payment correction committed, but order sync failed (market_id=${marketId}, reverted=${input.reverted}, applied=${input.applied ?? 0}): ${this.rpcErrorMessage(error, 'unknown sync error')}`,
        );
      }
    };
    const previous = this.marketOrderSyncChains.get(marketId);
    const sync = (previous ?? Promise.resolve())
      .then(run)
      .catch(() => undefined);
    this.marketOrderSyncChains.set(marketId, sync);
    void sync.then(() => {
      if (this.marketOrderSyncChains.get(marketId) === sync) {
        this.marketOrderSyncChains.delete(marketId);
      }
    });
    this.pendingFollowUps.add(sync);
    void sync.then(() => {
      this.pendingFollowUps.delete(sync);
    });
    return sync;
  }

  /** T6 — xodim ismlari (`created_by_name`); identity javob bermasa — null. */
  async userNames(ids: string[]): Promise<Map<string, string | null>> {
    const users = await this.loadUsersByIds(ids);
    return new Map(
      [...users.entries()].map(([id, user]) => [id, user?.name ?? null]),
    );
  }

  private async syncMarketPaymentsSafely(marketId: string, amount: number) {
    try {
      await this.applyPaymentToOrders(marketId, amount);
    } catch (error) {
      const message = this.rpcErrorMessage(error, 'unknown sync error');
      this.logger.warn(
        `transfer committed, but order sync failed (market_id=${marketId}, amount=${amount}): ${message}`,
      );
    }
  }

  /**
   * To'lovdan KEYINGI ishlar — buyurtma holati sinxroni va hamkorga xabar
   * (audit M2). Ular endi javobni KUTDIRMAYDI: commit'dan keyin fonda
   * bajariladi.
   *
   * ⚠️ NEGA. Ilgari javob shu ishlar tugashini kutardi: sinxron har bir
   * buyurtma uchun alohida `order.update_normalized` (to'liq updateFull)
   * yuborardi, hamkor xabari esa 5 s × 3 urinish. ~100 buyurtmali marketda bu
   * gateway'ning 8 s chegarasidan oshib, admin pul KO'CHGAN bo'lsa ham 504
   * ko'rardi va qayta bosardi. Endi javob commit (va 2 s bilan cheklangan
   * ledger publish) dan keyin darhol qaytadi.
   *
   * Bitta marketning sinxronlari navbat bilan (`marketOrderSyncChains`) —
   * ikki to'lov bir xil buyurtmalarni parallel o'qib ikki marta yozmasin.
   * Hamkor xabari navbatni kutmaydi. Xatolar ichkarida yutiladi (log);
   * qaytgan promise HECH QACHON reject bo'lmaydi.
   */
  private scheduleMarketPaymentFollowUp(input: {
    market_id: string;
    amount: number;
    payment_date?: number | string | null;
    dedup_key?: string | null;
  }): Promise<void> {
    const marketId = String(input.market_id);
    const amount = Number(input.amount);

    const previous = this.marketOrderSyncChains.get(marketId);
    const sync = (previous ?? Promise.resolve())
      .then(() => this.syncMarketPaymentsSafely(marketId, amount))
      .catch(() => undefined);
    this.marketOrderSyncChains.set(marketId, sync);
    void sync.then(() => {
      if (this.marketOrderSyncChains.get(marketId) === sync) {
        this.marketOrderSyncChains.delete(marketId);
      }
    });

    const emit = this.emitSettlementPaymentSafely({
      market_id: marketId,
      amount,
      payment_date: input.payment_date,
      dedup_key: input.dedup_key,
    }).catch(() => undefined);

    const followUp = Promise.all([sync, emit]).then(() => undefined);
    this.pendingFollowUps.add(followUp);
    void followUp.then(() => {
      this.pendingFollowUps.delete(followUp);
    });
    return followUp;
  }

  /**
   * HAMKORGA HISOB-KITOB TO'LOVI XABARI — best-effort.
   *
   * MARKET_PAYMENT durable yozilgandan KEYIN chaqiriladi. integration-service
   * marketning hamkorniki ekanini tekshiradi; hamkorniki bo'lmasa no-op
   * (marketlarning aksariyati shunday). Xato bo'lsa faqat `warn` — pul
   * harakati allaqachon commit bo'lgan, uni QAYTA URISH kerak emas; hamkor
   * daftari solishtirishda (reconcile) baribir tuziladi.
   *
   * `payment_key` — hamkor daftarida DEDUP kaliti: bir to'lov ikki marta
   * yuborilsa (outbox retry / RMQ redelivery) ikkinchisi yozilmaydi. Barqaror
   * bo'lishi shart, shuning uchun to'lovning idempotentlik tokeniga (dedup)
   * tayanadi; u bo'lmasa to'lov sanasiga.
   */
  private async emitSettlementPaymentSafely(input: {
    market_id: string;
    amount: number;
    payment_date?: number | string | null;
    dedup_key?: string | null;
  }) {
    try {
      const pd = Number(input.payment_date);
      const paidAt =
        Number.isFinite(pd) && pd > 0
          ? pd
          : input.payment_date
            ? Date.parse(String(input.payment_date)) || Date.now()
            : Date.now();
      const dedup = String(input.dedup_key ?? '').trim();
      const paymentKey = `${input.market_id}:${dedup || paidAt}`;

      await rmqSend(
        this.integrationClient,
        { cmd: 'integration.partner.settlement.enqueue' },
        {
          market_id: input.market_id,
          amount: input.amount,
          paid_at: paidAt,
          payment_key: paymentKey,
        },
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'unknown settlement emit error';
      this.logger.warn(
        `MARKET_PAYMENT committed, but partner settlement emit failed (market_id=${input.market_id}, amount=${input.amount}): ${message}`,
      );
    }
  }

  private extractResponseData<T>(response: any): T | null {
    if (response && typeof response === 'object' && 'data' in response) {
      return (response.data ?? null) as T | null;
    }
    return (response ?? null) as T | null;
  }

  /**
   * Kassa tarixi/egasi uchun foydalanuvchilar — (vf4513Zn) faqat
   * `PublicUserSummary` (`{id, name, role, phone_number}`): identity'ning
   * to'liq yozuvi (tarif, maosh, komissiya, AI narxi...) javobga CHIQMAYDI —
   * kuryer/market o'z kassasida bir-birining moliyasini ko'rmasin.
   */
  private async loadUsersByIds(ids: string[]) {
    const uniqueIds = Array.from(
      new Set(
        ids
          .map((id) => String(id ?? '').trim())
          .filter((id) => /^\d+$/.test(id)),
      ),
    );

    if (!uniqueIds.length) {
      return new Map<string, PublicUserSummary | null>();
    }

    const pairs = await Promise.all(
      uniqueIds.map(async (id) => {
        try {
          const response = await rmqSend<any>(
            this.identityClient,
            { cmd: 'identity.user.find_by_id' },
            { id },
          );
          return [
            id,
            toPublicUserSummary(
              this.extractResponseData<unknown>(response),
              id,
            ),
          ] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );

    return new Map<string, PublicUserSummary | null>(pairs);
  }

  /**
   * (2crjWf7v #3) Xodim ismi kvitansiya uchun: 800 ms, qayta urinishsiz,
   * xato — `null` (fail-open, pul amali to'xtamaydi).
   */
  private async userDisplayName(
    userId: string | null | undefined,
  ): Promise<string | null> {
    const id = String(userId ?? '').trim();
    if (!/^\d+$/.test(id) || !this.financeNotifications) return null;
    try {
      const response = await rmqSend<{ data?: { name?: unknown } }>(
        this.identityClient,
        { cmd: 'identity.user.find_by_id' },
        { id },
        { timeoutMs: 800, retries: 0 },
      );
      const name = response?.data?.name;
      return typeof name === 'string' && name.trim() ? name.trim() : null;
    } catch {
      return null;
    }
  }

  private async enrichHistoryWithUsers<T extends CashboxHistory>(
    histories: T[],
    // (vf4513Zn) `getCashboxByUserId` kvitansiya javobini allaqachon
    // `withPaymentAcks` (`payment_ack`) bilan beradi — qayta so'ralmasin.
    options: { courierAck?: boolean } = {},
  ) {
    if (!Array.isArray(histories) || !histories.length) {
      return histories;
    }

    const ids: string[] = [];
    const userBackedSources = new Set<Source_type>([
      Source_type.COURIER_PAYMENT,
      Source_type.MARKET_PAYMENT,
      // T6: teskari qatorning `source_user_id` si — asl oyoqniki (kuryer / market).
      Source_type.PAYMENT_REVERSAL,
    ]);
    /**
     * Kassa egasi FOYDALANUVCHI bo'lgan turlar (audit CODE-08). BRANCH
     * kassasining `user_id` si — FILIAL id si, MAIN niki — '0'. Ilgari ular
     * ham identity'dan foydalanuvchi sifatida so'ralardi va id raqami mos
     * kelgan BEGONA odamning ismi/telefoni kassa egasi bo'lib ko'rinardi.
     */
    const isUserOwnedCashbox = (cashbox?: Cashbox | null) =>
      cashbox?.cashbox_type === Cashbox_type.FOR_COURIER ||
      cashbox?.cashbox_type === Cashbox_type.FOR_MARKET;

    for (const history of histories) {
      if (history?.created_by) {
        ids.push(String(history.created_by));
      }
      if (
        history?.source_user_id &&
        userBackedSources.has(history.source_type)
      ) {
        ids.push(String(history.source_user_id));
      }
      if (history?.cashbox?.user_id && isUserOwnedCashbox(history.cashbox)) {
        ids.push(String(history.cashbox.user_id));
      }
    }

    const usersMap = await this.loadUsersByIds(ids);
    // (2crjWf7v #4) Kuryer kassasidagi to'lov qatori — kuryer javobi
    // (`courier_ack`: confirmed | disputed | null). Xato — flagsiz ro'yxat.
    const courierPaymentIds = histories
      .filter(
        (history) =>
          history?.source_type === Source_type.COURIER_PAYMENT &&
          history.operation_type === Operation_type.EXPENSE,
      )
      .map((history) => String(history.id));
    const acks =
      options.courierAck !== false &&
      this.courierAcks &&
      courierPaymentIds.length
        ? await this.courierAcks.flags(courierPaymentIds).catch(() => null)
        : null;
    const ackOf = (history: CashboxHistory) =>
      acks &&
      history.source_type === Source_type.COURIER_PAYMENT &&
      history.operation_type === Operation_type.EXPENSE
        ? { courier_ack: acks.get(String(history.id)) ?? null }
        : {};

    return histories.map((history) => {
      const createdByUser =
        history.created_by != null
          ? (usersMap.get(String(history.created_by)) ?? null)
          : null;
      const sourceUser =
        history.source_user_id != null &&
        userBackedSources.has(history.source_type)
          ? (usersMap.get(String(history.source_user_id)) ?? null)
          : null;

      if (!history.cashbox) {
        return {
          ...history,
          ...ackOf(history),
          createdByUser,
          created_by_user: createdByUser,
          sourceUser,
          source_user: sourceUser,
        };
      }

      const cashboxUser = isUserOwnedCashbox(history.cashbox)
        ? (usersMap.get(String(history.cashbox.user_id)) ?? null)
        : null;

      return {
        ...history,
        ...ackOf(history),
        createdByUser,
        created_by_user: createdByUser,
        sourceUser,
        source_user: sourceUser,
        cashbox: {
          ...history.cashbox,
          user: cashboxUser,
        },
      };
    });
  }

  private async getCashboxBySelector(selector: {
    cashbox_id?: string;
    user_id?: string;
    cashbox_type?: Cashbox_type;
  }) {
    if (selector.cashbox_id) {
      this.assertBigIntId(selector.cashbox_id, 'cashbox_id');
      const byId = await this.cashboxRepo.findOne({
        where: { id: selector.cashbox_id, isDeleted: false },
      });
      if (!byId) {
        throw new NotFoundException('Cashbox not found');
      }
      return byId;
    }

    if (!selector.user_id || !selector.cashbox_type) {
      throw new BadRequestException(
        'Either cashbox_id OR (user_id + cashbox_type) is required',
      );
    }

    this.assertBigIntId(selector.user_id, 'user_id');
    const byUserType = await this.cashboxRepo.findOne({
      where: {
        user_id: selector.user_id,
        cashbox_type: selector.cashbox_type,
        isDeleted: false,
      },
    });

    if (!byUserType) {
      throw new NotFoundException('Cashbox not found');
    }

    return byUserType;
  }

  private async getCashboxBySelectorWithManager(
    manager: EntityManager,
    selector: {
      cashbox_id?: string;
      user_id?: string;
      cashbox_type?: Cashbox_type;
    },
    options: { lock?: boolean } = {},
  ) {
    // `lock: true` acquires a row-level FOR UPDATE so concurrent updateBalance
    // calls for the same cashbox serialize instead of clobbering each other's
    // in-memory recomputed balance. Only safe inside an active transaction.
    const lock = options.lock
      ? { mode: 'pessimistic_write' as const }
      : undefined;

    if (selector.cashbox_id) {
      this.assertBigIntId(selector.cashbox_id, 'cashbox_id');
      const byId = await manager.findOne(Cashbox, {
        where: { id: selector.cashbox_id, isDeleted: false },
        lock,
      });
      if (!byId) {
        throw new NotFoundException('Cashbox not found');
      }
      return byId;
    }

    if (!selector.user_id || !selector.cashbox_type) {
      throw new BadRequestException(
        'Either cashbox_id OR (user_id + cashbox_type) is required',
      );
    }

    this.assertBigIntId(selector.user_id, 'user_id');
    const byUserType = await manager.findOne(Cashbox, {
      where: {
        user_id: selector.user_id,
        cashbox_type: selector.cashbox_type,
        isDeleted: false,
      },
      lock,
    });

    if (!byUserType) {
      throw new NotFoundException('Cashbox not found');
    }

    return byUserType;
  }

  /**
   * BRANCH kassasini manfiyga tushirishi mumkin bo'lgan TIZIM oyoqlari —
   * order-service outbox'i (`finance.cashbox.update_balance`) yozadigan sotuv,
   * qo'shimcha xarajat, tuzatish va bekor qilish oyoqlari (audit I13).
   *
   * ⚠️ AUDIT M12. Ilgari ruxsat BARCHA BRANCH yozuvlariga berilardi: menejer
   * kassada 100 000 turganda PATCH /finance/cashbox/spend bilan 500 000
   * "sarflasa" qabul qilinardi va filial kassasi −400 000 bo'lardi (yo'q pul
   * sarflangan, filial → HQ topshirish bloklanardi). Qo'lda chiqim
   * (MANUAL_EXPENSE) bu ro'yxatda YO'Q — u MAIN kabi qat'iy tekshiriladi.
   */
  private static isBranchNegativeAllowedSource(
    sourceType: Source_type | undefined,
  ): boolean {
    if (!sourceType) {
      return false;
    }
    return (
      sourceType === Source_type.SELL ||
      sourceType === Source_type.EXTRA_COST ||
      sourceType === Source_type.CORRECTION ||
      sourceType === Source_type.CANCEL
    );
  }

  /**
   * (i75GDixP) BRANCH kassasi uchun manfiy balans ruxsati — ANIQ bayroq
   * (`allow_negative`) bo'yicha, source_type ro'yxati bo'yicha emas.
   *
   * Ro'yxat (yuqoridagi `isBranchNegativeAllowedSource`) kelajakda yangi
   * source_type qo'shilganda jimgina eskiradi va admin PATCH
   * /finance/cashbox/balance da `source_type: correction` yuborib filial
   * kassasini manfiyga tushira olardi. Endi:
   *  - qo'lda oyoq (MANUAL_EXPENSE / MANUAL_INCOME) — HECH QACHON ruxsat yo'q;
   *  - `allow_negative` boolean kelgan bo'lsa — aynan shu (order-service
   *    outbox'i `true`, gateway va spend/fill `false` yuboradi);
   *  - maydon umuman yo'q — faqat deploydan oldin navbatga tushgan eski
   *    outbox qatorlari: ular poison-drop bo'lmasligi uchun eski ro'yxat.
   */
  private static resolveBranchNegativeOverride(dto: {
    source_type?: Source_type;
    allow_negative?: boolean;
  }): boolean {
    if (
      dto.source_type === Source_type.MANUAL_EXPENSE ||
      dto.source_type === Source_type.MANUAL_INCOME
    ) {
      return false;
    }
    if (typeof dto.allow_negative === 'boolean') {
      return dto.allow_negative;
    }
    return FinanceServiceService.isBranchNegativeAllowedSource(dto.source_type);
  }

  updateBalancesByMethod(
    cashbox: Cashbox,
    amount: number,
    operation: Operation_type,
    method: PaymentMethod,
    // System-generated sale/settlement legs (via the outbox `update_balance`
    // path) may drive a BRANCH cashbox negative — a sub-share sale legitimately
    // leaves the branch owing negative (HQ tops up). Without this the branch
    // EXPENSE leg threw, the outbox retried 10x and silently dropped, so HQ's
    // view of branch debt was understated. Manual remittances keep the strict
    // check (override stays false). (Audit I13.)
    allowNegativeOverride = false,
  ) {
    const sign = operation === Operation_type.INCOME ? 1 : -1;
    const allowNegativeBalance =
      cashbox.cashbox_type === Cashbox_type.FOR_MARKET ||
      cashbox.cashbox_type === Cashbox_type.FOR_COURIER ||
      allowNegativeOverride;

    /**
     * 1bz6tOle — to'lov usuli ANIQ tarmoqlanadi: CASH → naqd, CLICK va
     * CLICK_TO_MARKET → karta. Ilgari "CASH bo'lmasa — karta" edi: noma'lum
     * qiymat ham jimgina `balance_card` ga tushardi. Usul berilmagan bo'lsa —
     * CASH (updateBalance sukuti bilan bir xil).
     */
    const resolvedMethod = method ?? PaymentMethod.CASH;
    const isCardMethod =
      resolvedMethod === PaymentMethod.CLICK ||
      resolvedMethod === PaymentMethod.CLICK_TO_MARKET;
    if (resolvedMethod !== PaymentMethod.CASH && !isCardMethod) {
      throw new BadRequestException(
        `Noma'lum to'lov usuli: ${String(resolvedMethod)}`,
      );
    }

    /**
     * 1bz6tOle — FOR_COURIER / FOR_MARKET kassalari fizik kassa EMAS, qarz
     * hisobi: ularda naqd/karta ajratmasi YURITILMAYDI. Ilgari sotuv oyoqlari
     * (usulsiz → CASH) `balance_cash` ga yozardi, CLICK bilan hisob-kitob esa
     * `balance_card` dan yechardi — kuryer kassasi `cash = +X, card = −X`
     * bo'lib qotib qolardi (jami 0, ilovada esa "naqd qarzingiz X").
     *
     * Endi qarz hisobida butun summa bitta "qarz" chelagida (`balance_cash`)
     * turadi, `balance_card` doim 0: usuldan qat'i nazar `balance` o'zgaradi.
     * Eski (usul bo'yicha bo'lingan) qoldiq keyingi harakatda jami saqlangan
     * holda shu chelakka yig'iladi — `balance` o'zgarmaydi.
     */
    if (
      cashbox.cashbox_type === Cashbox_type.FOR_MARKET ||
      cashbox.cashbox_type === Cashbox_type.FOR_COURIER
    ) {
      cashbox.balance_cash =
        Number(cashbox.balance_cash) +
        Number(cashbox.balance_card) +
        sign * amount;
      cashbox.balance_card = 0;
      this.normalizeBalance(cashbox);
      return;
    }

    if (resolvedMethod === PaymentMethod.CASH) {
      const nextCash = Number(cashbox.balance_cash) + sign * amount;
      if (!allowNegativeBalance && nextCash < 0) {
        throw new BadRequestException('Insufficient cash balance');
      }
      cashbox.balance_cash = nextCash;
    } else {
      // isCardMethod — CLICK / CLICK_TO_MARKET (boshqasi yuqorida 400).
      const nextCard = Number(cashbox.balance_card) + sign * amount;
      if (!allowNegativeBalance && nextCard < 0) {
        throw new BadRequestException('Insufficient card balance');
      }
      cashbox.balance_card = nextCard;
    }

    this.normalizeBalance(cashbox);
  }

  async createCashbox(dto: CreateCashboxDto) {
    try {
      this.assertBigIntId(dto.user_id, 'user_id');

      const exists = await this.cashboxRepo.findOne({
        where: {
          user_id: dto.user_id,
          cashbox_type: dto.cashbox_type,
          isDeleted: false,
        },
      });

      if (exists) {
        // Idempotent: a cashbox for this (user, type) already exists. Return it
        // instead of throwing — an RMQ redelivery/retry of a create (e.g. the
        // manager-create flow whose branch cashbox was already provisioned when
        // the branch was created) must NOT 500. Callers that want create-if-
        // absent semantics (ensureUserCashbox) rely on this. (Live-E2E fix.)
        return this.successRes(exists, 200, 'Cashbox already exists');
      }

      const balanceCash = Number(dto.balance_cash ?? 0);
      const balanceCard = Number(dto.balance_card ?? 0);
      const balance =
        dto.balance !== undefined
          ? Number(dto.balance)
          : Number(balanceCash) + Number(balanceCard);

      const entity = this.cashboxRepo.create({
        user_id: dto.user_id,
        cashbox_type: dto.cashbox_type,
        balance_cash: balanceCash,
        balance_card: balanceCard,
        balance,
      });

      const saved = await this.cashboxRepo.save(entity);
      await this.activityLog.log({
        entity_type: 'Cashbox',
        entity_id: saved.id,
        action: ActivityAction.CREATED,
        new_value: {
          cashbox_type: saved.cashbox_type,
          balance: saved.balance,
        },
        user_id: dto.user_id ? String(dto.user_id) : null,
        metadata: { user_id: dto.user_id, cashbox_type: saved.cashbox_type },
      });
      return this.successRes(saved, 201, 'Cashbox created');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findCashboxByUser(dto: FindCashboxByUserDto) {
    try {
      this.assertBigIntId(dto.user_id, 'user_id');

      const page = dto.page && dto.page > 0 ? dto.page : 1;
      const limit = dto.limit && dto.limit > 0 ? dto.limit : 20;
      const historySourceTypes = this.parseSourceTypes(
        dto.history_source_types ?? dto.sourceTypes ?? dto.source_types,
      );

      if (dto.cashbox_type) {
        const cashbox = await this.cashboxRepo.findOne({
          where: {
            user_id: dto.user_id,
            cashbox_type: dto.cashbox_type,
            isDeleted: false,
          },
        });

        if (!cashbox) {
          throw new NotFoundException('Cashbox not found');
        }

        if (!dto.with_history) {
          return this.successRes(cashbox, 200, 'Cashbox found');
        }

        const historyWhere: FindOptionsWhere<CashboxHistory> = {
          cashbox_id: cashbox.id,
          isDeleted: false,
        };
        const { start, end } = this.parseDateRange(dto.fromDate, dto.toDate);
        if (dto.history_source_type) {
          historyWhere.source_type = dto.history_source_type;
        }
        if (historySourceTypes?.length) {
          historyWhere.source_type = In(historySourceTypes);
        }
        if (start && end) historyWhere.createdAt = Between(start, end);
        else if (start) historyWhere.createdAt = MoreThanOrEqual(start);
        else if (end) historyWhere.createdAt = LessThanOrEqual(end);

        const [rows, total] = await this.historyRepo.findAndCount({
          where: historyWhere,
          order: { createdAt: 'DESC' },
          skip: (page - 1) * limit,
          take: limit,
        });
        // (2crjWf7v) menejer kuryer kassasi tafsilotida ham «Noto'g'ri» belgisini ko'rsin.
        const history = await this.withCorrections(
          cashbox.cashbox_type === Cashbox_type.FOR_COURIER
            ? await this.withPaymentAcks(rows)
            : rows,
        );

        return this.successRes(
          {
            cashbox,
            history,
            pagination: {
              total,
              page,
              limit,
              totalPages: Math.ceil(total / limit),
            },
          },
          200,
          'Cashbox found',
        );
      }

      const all = await this.cashboxRepo.find({
        where: { user_id: dto.user_id, isDeleted: false },
        order: { createdAt: 'DESC' },
      });

      if (!dto.with_history) {
        return this.successRes(all, 200, 'Cashboxes found');
      }

      const historyQuery = this.historyRepo
        .createQueryBuilder('history')
        .innerJoinAndSelect('history.cashbox', 'cashbox')
        .where('cashbox.user_id = :userId', { userId: dto.user_id })
        .andWhere('cashbox.isDeleted = :cashboxActive', {
          cashboxActive: false,
        })
        .andWhere('history.isDeleted = :historyActive', {
          historyActive: false,
        })
        .orderBy('history.createdAt', 'DESC')
        .skip((page - 1) * limit)
        .take(limit);

      if (dto.history_source_type) {
        historyQuery.andWhere('history.source_type = :historySourceType', {
          historySourceType: dto.history_source_type,
        });
      }
      if (historySourceTypes?.length) {
        historyQuery.andWhere(
          'history.source_type IN (:...historySourceTypes)',
          {
            historySourceTypes,
          },
        );
      }
      // Sana filtri (FE-PAY-04) — turi berilgan yo'l bilan bir xil Toshkent
      // kuni. Ilgari bu yo'l sanani umuman e'tiborsiz qoldirardi.
      const { start: historyFrom, end: historyTo } = this.parseDateRange(
        dto.fromDate,
        dto.toDate,
      );
      if (historyFrom) {
        historyQuery.andWhere('history.createdAt >= :historyFrom', {
          historyFrom,
        });
      }
      if (historyTo) {
        historyQuery.andWhere('history.createdAt <= :historyTo', {
          historyTo,
        });
      }

      const [rows, total] = await historyQuery.getManyAndCount();
      const history = await this.withCorrections(
        await this.withPaymentAcks(
          rows,
          (row) => row.cashbox?.cashbox_type === Cashbox_type.FOR_COURIER,
        ),
      );

      return this.successRes(
        {
          cashboxes: all,
          history,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
        200,
        'Cashboxes found',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async updateBalance(
    dto: UpdateCashboxBalanceDto,
    /**
     * IgR4FVsR — faqat servis ICHIDAN (spendMoney / fillTheCashbox) beriladi,
     * RMQ payload'idan EMAS: qo'lda kirim/chiqim kassa harakati bilan AYNI
     * tranzaksiyada P&L daftariga (`financial_balance_history`) yoziladi.
     */
    options?: {
      financialLedger?: {
        amount: number;
        source_type: FinancialSource_type;
        comment?: string | null;
      };
      /** T3 — qo'lda chiqim cheki (gateway `receipt_policy`), AYNI tranzaksiyada. */
      receipt?: ReceiptLinkRequest;
    },
  ) {
    // Captured after a successful (non-idempotent) commit so we can write the
    // audit row only once the transaction is durable and the runner released.
    // Declared at method scope so the outer `finally` (a sibling of the inner
    // try) can read it.
    let auditedCashbox: Cashbox | null = null;
    let auditedLedger: FinancialBalanceHistory | null = null;
    try {
      this.assertPositiveAmount(Number(dto.amount));
      const paymentMethod = dto.payment_method ?? PaymentMethod.CASH;
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        const cashbox = await this.getCashboxBySelectorWithManager(
          queryRunner.manager,
          {
            cashbox_id: dto.cashbox_id,
            user_id: dto.user_id,
            cashbox_type: dto.cashbox_type,
          },
          { lock: true },
        );

        // Idempotency: if a history row already exists for the same business
        // event (cashbox + source_type + operation_type + source_id +
        // dedup_epoch), this is a duplicate delivery — skip the balance mutation
        // and return the already-applied state. The pessimistic lock above
        // guarantees we see committed history from earlier deliveries.
        //
        // Two shapes:
        //  - system legs (sale/settlement/transfer): a real NUMERIC source_id
        //    (+ optional dedup_epoch). The DB unique index backstops this.
        //  - manual spend/fill: no business id — source_id stays NULL (it's a
        //    bigint column; the gateway's free-form dedup_epoch token cannot be
        //    written there) and we dedupe on the token alone. There is no DB
        //    index backstop for NULL source_id (the index is partial, WHERE
        //    source_id IS NOT NULL), so the cashbox row lock is what makes this
        //    pre-check safe against a concurrent same-cashbox double-submit.
        const dedupToken = String(dto.dedup_epoch ?? '');
        if (dto.source_id != null || dedupToken.length > 0) {
          const existingHistory = await queryRunner.manager.findOne(
            CashboxHistory,
            {
              where: {
                cashbox_id: String(cashbox.id),
                source_type: dto.source_type,
                operation_type: dto.operation_type,
                source_id:
                  dto.source_id != null ? String(dto.source_id) : IsNull(),
                dedup_epoch: dedupToken,
              },
            },
          );
          if (existingHistory) {
            // T3 — takror: asl operatsiyaning cheki (yangi chek bog'lanmaydi).
            const replayReceipt =
              options?.receipt && this.receipts
                ? await this.receipts.findForReplay(queryRunner.manager, {
                    history_id: String(existingHistory.id),
                  })
                : undefined;
            await queryRunner.commitTransaction();
            return this.successRes(
              {
                cashbox,
                history: existingHistory,
                idempotent: true,
                ...(replayReceipt !== undefined
                  ? { receipt: replayReceipt }
                  : {}),
              },
              200,
              'Cashbox balance already applied (idempotent replay)',
            );
          }
        }

        // (QTCUUgjA) Qo'lda kirim/chiqim — kassada ochiq smena bo'lishi shart
        // (darvoza yoqilgan bo'lsa). Idempotentlik tekshiruvidan KEYIN: haqiqiy
        // takroriy so'rov smena yopilgan bo'lsa ham `idempotent` javob oladi.
        if (dto.require_open_shift === true) {
          await this.requireOpenShift(queryRunner.manager, cashbox);
        }

        // Elchi Pochta №1 — qo'lda chiqim kategoriyasi (faqat MANUAL_EXPENSE;
        // mavjud va o'chirilmagan bo'lishi shart, aks holda 400 → rollback).
        // Idempotentlik tekshiruvidan KEYIN: takroriy so'rov kategoriya
        // o'chirilgan bo'lsa ham avvalgi natijani oladi.
        const expenseCategory = await resolveSpendExpenseCategory(
          queryRunner.manager,
          {
            expense_category_id: dto.expense_category_id,
            operation_type: dto.operation_type,
            source_type: dto.source_type,
          },
        );

        // System sale/settlement leg: a BRANCH cashbox may go negative here
        // (sub-share sale; HQ tops up) so the leg is never poison-dropped.
        // Faqat TIZIM oyoqlari (audit M12, i75GDixP): ruxsat — order-service
        // outbox'ining aniq `allow_negative` bayrog'i; menejer/adminning
        // qo'lda chiqimi filial kassasini manfiyga tushira olmaydi.
        const allowBranchNegative =
          cashbox.cashbox_type === Cashbox_type.BRANCH &&
          FinanceServiceService.resolveBranchNegativeOverride(dto);
        this.updateBalancesByMethod(
          cashbox,
          Number(dto.amount),
          dto.operation_type,
          paymentMethod,
          allowBranchNegative,
        );
        if (
          allowBranchNegative &&
          (Number(cashbox.balance_cash) < 0 || Number(cashbox.balance_card) < 0)
        ) {
          // (i75GDixP 3-band) Monitoring: tizim oyog'i filial kassasini
          // manfiyga tushirdi — qonuniy (HQ to'ldiradi), lekin ko'rinsin.
          this.logger.warn(
            `BRANCH kassasi manfiy: cashbox=${String(cashbox.id)} user_id=${String(
              cashbox.user_id,
            )} source_type=${String(dto.source_type)} source_id=${String(
              dto.source_id ?? '',
            )} cash=${Number(cashbox.balance_cash)} card=${Number(
              cashbox.balance_card,
            )}`,
          );
        }

        // 3PE0B03q / Zv3MLn0a — CLICK kirim/chiqim tanlangan NOMLI kartaga
        // (MAIN yoki filial kassasi qulfi ostida). `card_id` yo'q — Asosiy
        // karta (avvalgidek).
        const historyCardId = await applyCashboxCardSelection(
          queryRunner.manager,
          cashbox,
          {
            card_id: dto.card_id ?? null,
            operation: dto.operation_type,
            amount: Number(dto.amount),
            payment_method: paymentMethod,
          },
        );

        const savedCashbox = await queryRunner.manager.save(cashbox);

        const history = queryRunner.manager.create(CashboxHistory, {
          operation_type: dto.operation_type,
          cashbox_id: savedCashbox.id,
          card_id: historyCardId,
          expense_category_id: expenseCategory?.id ?? null,
          expense_category_name: expenseCategory?.name ?? null,
          source_type: dto.source_type,
          source_id: dto.source_id ?? null,
          dedup_epoch: String(dto.dedup_epoch ?? ''),
          source_user_id: dto.source_user_id ?? null,
          amount: Number(dto.amount),
          balance_after: savedCashbox.balance,
          balance_cash_after: savedCashbox.balance_cash,
          balance_card_after: savedCashbox.balance_card,
          payment_method: paymentMethod,
          comment: dto.comment ?? null,
          created_by: dto.created_by ?? null,
          proof_files:
            Array.isArray(dto.proof_files) && dto.proof_files.length
              ? dto.proof_files
              : null,
          payment_date:
            dto.payment_date != null
              ? (this.parseDate(String(dto.payment_date)) ?? null)
              : null,
        });

        const savedHistory = await queryRunner.manager.save(history);

        // T3 — qo'lda chiqim cheki: AYNI tranzaksiyada bog'lanadi (xato —
        // pul ham rollback). Chek talab qilinsa-yu yo'q bo'lsa — 400.
        const linkedReceipt =
          options?.receipt && this.receipts
            ? await this.receipts.linkInTx(
                queryRunner.manager,
                options.receipt,
                {
                  applicable: true,
                  history_id: String(savedHistory.id),
                  entered_amount: Number(dto.amount),
                  payment_method: paymentMethod,
                  card_id: historyCardId,
                  branch_id:
                    savedCashbox.cashbox_type === Cashbox_type.BRANCH
                      ? String(savedCashbox.user_id)
                      : null,
                },
              )
            : undefined;

        /**
         * IgR4FVsR — qo'lda kirim/chiqim P&L daftariga AYNI tranzaksiyada.
         * Ilgari faqat kassa + cashbox_history o'zgarardi, `financial_balance
         * _history` ga hech narsa tushmasdi: ijara/yoqilg'i chiqib ketsa ham
         * "Moliyaviy balans" foydani ortiqcha ko'rsatardi. Daftar yozuvi
         * yiqilsa kassa harakati ham rollback bo'ladi (bitta commit). Kalit —
         * yaratilgan cashbox_history ID'si: takroriy so'rov yuqoridagi
         * idempotentlik qisqa tutashuvida to'xtaydi, daftar ham ikki marta
         * yozilmaydi.
         */
        let savedLedger: FinancialBalanceHistory | null = null;
        if (
          options?.financialLedger &&
          (savedCashbox.cashbox_type === Cashbox_type.MAIN ||
            savedCashbox.cashbox_type === Cashbox_type.BRANCH)
        ) {
          savedLedger = await this.appendFinancialBalanceInTx(
            queryRunner.manager,
            {
              amount: Number(options.financialLedger.amount),
              source_type: options.financialLedger.source_type,
              dedup_key: `cashbox-history:${String(savedHistory.id)}`,
              comment: options.financialLedger.comment ?? null,
              created_by: dto.created_by ?? null,
            },
          );
        }

        // (ePpLHPX2) Market/kuryer kassasiga qo'lda kirim (MANUAL_INCOME) —
        // `finance.balance_topup` (BeePost notifyBalanceTopup analogi). Faqat
        // outbox, AYNAN shu tranzaksiyada: rollback bo'lsa xabar ham yo'q.
        // Boshqa oyoqlar (sotuv, bekor qilish, MAIN/BRANCH to'ldirish) —
        // servis ichida filtrlanadi. Takroriy (idempotent) yetkazishda bu
        // nuqtaga yetilmaydi — bildirishnoma ham takrorlanmaydi.
        await this.financeNotifications?.balanceTopup(
          {
            cashbox_type: savedCashbox.cashbox_type,
            operation_type: dto.operation_type,
            source_type: dto.source_type,
            recipient_id: savedCashbox.user_id,
            history_id: savedHistory?.id,
            amount: Number(dto.amount),
            balance_after: savedCashbox.balance,
          },
          queryRunner.manager,
        );

        await queryRunner.commitTransaction();
        auditedCashbox = savedCashbox;
        auditedLedger = savedLedger;

        return this.successRes(
          {
            cashbox: savedCashbox,
            history: savedHistory,
            // IgR4FVsR — qo'lda operatsiyada P&L yozuvi (aks holda kalit yo'q).
            ...(savedLedger ? { financial_balance_entry: savedLedger } : {}),
            // T3 — `receipt_policy` bo'lsa: chek yoki null.
            ...(linkedReceipt !== undefined ? { receipt: linkedReceipt } : {}),
          },
          200,
          'Cashbox balance updated',
        );
      } catch (error) {
        await queryRunner.rollbackTransaction();
        throw error;
      } finally {
        await queryRunner.release();
      }
    } catch (error) {
      this.toRpcError(error);
    } finally {
      if (auditedCashbox) {
        await this.activityLog.log({
          entity_type: 'Cashbox',
          entity_id: auditedCashbox.id,
          action: 'finance.balance_update',
          new_value: {
            balance: auditedCashbox.balance,
            operation_type: dto.operation_type,
            amount: Number(dto.amount),
          },
          user_id: dto.created_by ? String(dto.created_by) : null,
          metadata: {
            user_id: dto.user_id ?? null,
            source_id: dto.source_id ?? null,
            source_user_id: dto.source_user_id ?? null,
            amount: Number(dto.amount),
            created_by: dto.created_by ?? null,
            direction: dto.operation_type,
          },
        });
      }
      if (auditedLedger) {
        // IgR4FVsR — recordFinancialBalance bilan bir xil audit yozuvi.
        await this.activityLog.log({
          entity_type: 'FinancialBalanceHistory',
          entity_id: auditedLedger.id,
          action: ActivityAction.CREATED,
          new_value: {
            amount: Number(auditedLedger.amount),
            balance_after: Number(auditedLedger.balance_after),
            source_type: auditedLedger.source_type,
          },
          user_id: dto.created_by ? String(dto.created_by) : null,
          metadata: { order_id: null },
        });
      }
    }
  }

  /**
   * IgR4FVsR — `updateBalance` + (ixtiyoriy) shu tranzaksiyadagi P&L yozuvi.
   * Faqat servis ichidagi qo'lda kirim/chiqim yo'llari uchun.
   */
  private updateBalanceWithLedger(
    ledger:
      | {
          amount: number;
          source_type: FinancialSource_type;
          comment?: string | null;
        }
      | undefined,
    dto: UpdateCashboxBalanceDto,
    receipt?: ReceiptLinkRequest | null,
  ) {
    const options = {
      ...(ledger ? { financialLedger: ledger } : {}),
      ...(receipt ? { receipt } : {}),
    };
    return Object.keys(options).length
      ? this.updateBalance(dto, options)
      : this.updateBalance(dto);
  }

  /**
   * T6 — tarix qatorlariga `correction` bloki (qaytarilgan / tuzatilgan
   * to'lov). FAIL-OPEN: o'qish xatosi ro'yxatni yiqitmaydi (`correction:
   * null`, WARN).
   */
  private async withCorrections<
    T extends {
      id: string;
      cashbox_id: string;
      transfer_id?: string | null;
      reverses_history_id?: string | null;
    },
  >(
    rows: T[],
    receiptMode: 'brief' | 'full' = 'brief',
  ): Promise<Array<T & { correction: unknown; receipt?: unknown }>> {
    if (!Array.isArray(rows) || !rows.length) {
      return (rows ?? []) as Array<T & { correction: unknown }>;
    }
    let corrected: Array<T & { correction: unknown }>;
    try {
      corrected = await attachCorrectionViews(
        this.dataSource.manager,
        rows,
        (ids) => this.userNames(ids),
      );
    } catch (error) {
      this.logger.warn(
        `tarixga tuzatish ma'lumoti qo'shilmadi (T6): ${error instanceof Error ? error.message : String(error)}`,
      );
      corrected = rows.map((row) => ({ ...row, correction: null }));
    }
    return this.withReceipts(corrected, receiptMode);
  }

  /** T3 — chek jadvali / tarix / kassa yo'llari (TypeORM metadata). */
  private receiptTables(): ReceiptTables | null {
    try {
      return {
        receipts: this.dataSource.getMetadata(CASHBOX_RECEIPT_ENTITY).tablePath,
        history: this.dataSource.getMetadata(CashboxHistory).tablePath,
        cashbox: this.dataSource.getMetadata(Cashbox).tablePath,
      };
    } catch {
      // Eski spec'lar DataSource'siz / entity ro'yxatisiz.
      return null;
    }
  }

  /**
   * T3 — tarix qatorlariga `receipt` (bitta batch so'rov, N+1 yo'q):
   * ro'yxatda `{ id, ai_status } | null`, tafsilotda to'liq (gateway
   * `file_key` ni havolaga almashtiradi, rolga qarab olib tashlaydi).
   * FAIL-OPEN: o'qish xatosi ro'yxatni yiqitmaydi (`receipt: null`).
   */
  private async withReceipts<T extends { id: string }>(
    rows: T[],
    mode: 'brief' | 'full',
  ): Promise<Array<T & { receipt?: unknown }>> {
    const tables = this.receiptTables();
    if (!tables || !this.receipts) return rows;
    try {
      const map = await loadReceiptsForHistory(
        this.dataSource.manager,
        tables.receipts,
        rows.map((row) => String(row.id)),
      );
      if (mode === 'brief') {
        return rows.map((row) => ({
          ...row,
          receipt: briefReceipt(map.get(String(row.id))),
        }));
      }
      const settings = await this.receipts.loadSettings();
      const names = await this.userNames(
        [...map.values()].map((row) => String(row.uploaded_by)),
      ).catch(() => new Map<string, string | null>());
      return rows.map((row) => {
        const found = map.get(String(row.id));
        return {
          ...row,
          receipt: found ? fullReceipt(found, settings, names) : null,
        };
      });
    } catch (error) {
      this.logger.warn(
        `tarixga chek ma'lumoti qo'shilmadi (T3): ${error instanceof Error ? error.message : String(error)}`,
      );
      return rows.map((row) => ({ ...row, receipt: null }));
    }
  }

  /** T3 — `GET /finance/receipts/:id` (to'liq ko'rinish; doira — gateway). */
  async getReceipt(input: { id?: unknown }) {
    try {
      const raw = input?.id;
      const id =
        typeof raw === 'string' || typeof raw === 'number'
          ? String(raw).trim()
          : '';
      if (!/^\d{1,18}$/.test(id) || !this.receipts) {
        throw new NotFoundException('Chek topilmadi');
      }
      const row = await this.dataSource
        .getRepository<CashboxReceipt>(CASHBOX_RECEIPT_ENTITY)
        .findOne({ where: { id, isDeleted: false } });
      if (!row) throw new NotFoundException('Chek topilmadi');
      const settings = await this.receipts.loadSettings();
      const names = await this.userNames([String(row.uploaded_by)]).catch(
        () => new Map<string, string | null>(),
      );
      return this.successRes(fullReceipt(row, settings, names), 200, 'Receipt');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findAllHistory(dto: FindHistoryDto) {
    try {
      const noPagination = dto.page === 0 || dto.limit === 0;
      const page = noPagination ? 0 : dto.page && dto.page > 0 ? dto.page : 1;
      const limit = noPagination
        ? 0
        : dto.limit && dto.limit > 0
          ? dto.limit
          : 20;
      const historyCashboxType = dto.cashbox_type ?? dto.cashboxType;

      const where: FindOptionsWhere<CashboxHistory> = { isDeleted: false };

      if (dto.cashbox_id) {
        this.assertBigIntId(dto.cashbox_id, 'cashbox_id');
        where.cashbox_id = dto.cashbox_id;
      }
      if (dto.operation_type) {
        where.operation_type = dto.operation_type;
      }
      if (dto.source_type) {
        where.source_type = dto.source_type;
      }
      const sourceTypes = this.parseSourceTypes(
        dto.sourceTypes ?? dto.source_types,
      );
      if (sourceTypes?.length) {
        where.source_type = In(sourceTypes);
      }
      if (dto.source_id) {
        this.assertBigIntId(dto.source_id, 'source_id');
        where.source_id = dto.source_id;
      }
      if (dto.source_user_id) {
        this.assertBigIntId(dto.source_user_id, 'source_user_id');
        where.source_user_id = dto.source_user_id;
      }
      if (dto.created_by) {
        this.assertBigIntId(dto.created_by, 'created_by');
        where.created_by = dto.created_by;
      }
      // T3 — «Chek holati» filtri (counts ham shu filtr bilan).
      if (dto.receipt_status !== undefined && dto.receipt_status !== '') {
        const tables = this.receiptTables();
        if (!isReceiptFilterStatus(dto.receipt_status) || !tables) {
          throw new BadRequestException("receipt_status noto'g'ri");
        }
        const status = dto.receipt_status;
        where.id = Raw(
          (alias) => receiptStatusIdCondition(alias, status, tables).sql,
          receiptStatusIdCondition('x', status, tables).params,
        );
      }
      if (historyCashboxType) {
        const cashboxesByType = await this.cashboxRepo.find({
          where: {
            cashbox_type: historyCashboxType,
            isDeleted: false,
          },
          select: ['id'],
        });
        if (!cashboxesByType.length) {
          return this.successRes(
            {
              items: [],
              counts: { all: 0, income: 0, expense: 0 },
              pagination: {
                total: 0,
                page,
                limit,
                totalPages: 0,
              },
            },
            200,
            'Cashbox histories',
          );
        }
        const typedIds = cashboxesByType.map((cashbox) => cashbox.id);
        if (dto.cashbox_id) {
          if (!typedIds.includes(dto.cashbox_id)) {
            return this.successRes(
              {
                items: [],
                counts: { all: 0, income: 0, expense: 0 },
                pagination: {
                  total: 0,
                  page,
                  limit,
                  totalPages: 0,
                },
              },
              200,
              'Cashbox histories',
            );
          }
        } else {
          where.cashbox_id = In(typedIds);
        }
      }

      // Toshkent kuni (SqVMuhKo) — asosiy kassa sahifasidagi xulosa
      // (getMainCashbox) bilan bir xil. Ilgari bitta kun tanlansa
      // Between(x, x) bo'lib, jadval bo'sh qaytardi.
      const { start: from, end: to } = this.parseDateRange(
        dto.from_date,
        dto.to_date,
      );

      if (from && to) {
        where.createdAt = Between(from, to);
      } else if (from) {
        where.createdAt = MoreThanOrEqual(from);
      } else if (to) {
        where.createdAt = LessThanOrEqual(to);
      }

      if (dto.user_id) {
        this.assertBigIntId(dto.user_id, 'user_id');
        const userCashboxes = await this.cashboxRepo.find({
          where: {
            user_id: dto.user_id,
            isDeleted: false,
            ...(historyCashboxType ? { cashbox_type: historyCashboxType } : {}),
          },
          select: ['id'],
        });

        if (!userCashboxes.length) {
          return this.successRes(
            {
              items: [],
              counts: { all: 0, income: 0, expense: 0 },
              pagination: {
                total: 0,
                page,
                limit,
                totalPages: 0,
              },
            },
            200,
            'Cashbox histories',
          );
        }

        const userCashboxIds = userCashboxes.map((cashbox) => cashbox.id);
        if (dto.cashbox_id) {
          if (!userCashboxIds.includes(dto.cashbox_id)) {
            return this.successRes(
              {
                items: [],
                counts: { all: 0, income: 0, expense: 0 },
                pagination: {
                  total: 0,
                  page,
                  limit,
                  totalPages: 0,
                },
              },
              200,
              'Cashbox histories',
            );
          }
        } else {
          where.cashbox_id = In(userCashboxIds);
        }
      }

      // GaBIPi3Z (2-band): «Barchasi / Kirim / Chiqim» tab sonlari — AYNI
      // filtrlar, faqat `operation_type` siz (tanlangan tabdan qat'i nazar).
      const countWhere: FindOptionsWhere<CashboxHistory> = { ...where };
      delete countWhere.operation_type;
      const [[items, total], income, expense] = await Promise.all([
        this.historyRepo.findAndCount({
          where,
          relations: ['cashbox'],
          order: { createdAt: 'DESC' },
          ...(noPagination
            ? {}
            : {
                skip: (page - 1) * limit,
                take: limit,
              }),
        }),
        this.historyRepo.count({
          where: { ...countWhere, operation_type: Operation_type.INCOME },
        }),
        this.historyRepo.count({
          where: { ...countWhere, operation_type: Operation_type.EXPENSE },
        }),
      ]);
      const enrichedItems = await this.withCorrections(
        await this.enrichHistoryWithUsers(items),
      );

      return this.successRes(
        {
          items: enrichedItems,
          // operation_type majburiy (income | expense) — all = income + expense.
          counts: { all: income + expense, income, expense },
          pagination: {
            total,
            page,
            limit,
            totalPages: noPagination
              ? total > 0
                ? 1
                : 0
              : Math.ceil(total / limit),
          },
        },
        200,
        'Cashbox histories',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findHistoryById(
    id: string,
    options: { include_correctable?: boolean } = {},
  ) {
    try {
      this.assertBigIntId(id, 'id');

      const history = await this.historyRepo.findOne({
        where: { id, isDeleted: false },
        relations: ['cashbox'],
      });

      if (!history) {
        throw new NotFoundException('Cashbox history not found');
      }

      const sourceTypesWithOrder = new Set<Source_type>([
        Source_type.SELL,
        Source_type.CANCEL,
        Source_type.EXTRA_COST,
        Source_type.CORRECTION,
      ]);

      let order: any = null;

      if (history.source_id && sourceTypesWithOrder.has(history.source_type)) {
        const orderResponse = await rmqSend<any>(
          this.orderClient,
          { cmd: 'order.find_by_id_enriched' },
          { id: history.source_id },
        ).catch(() => null);

        order = orderResponse?.data ?? orderResponse ?? null;
      }
      const [enrichedHistory] = await this.withCorrections(
        await this.enrichHistoryWithUsers([history]),
        'full',
      );
      // T6 — superadmin uchun: shu to'lovni qaytarish / tuzatish mumkinmi.
      const correctable = options.include_correctable
        ? await this.correctableBlock(history)
        : undefined;

      return this.successRes(
        {
          ...enrichedHistory,
          order,
          ...(correctable ? { correctable } : {}),
        },
        200,
        'Cashbox history detail',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * T6 — `/history/:id` dagi `correctable: { allowed, code?, deadline,
   * window_days }`. Smena / balans / karta amal paytida tekshiriladi.
   */
  private async correctableBlock(history: HistoryWithCashbox) {
    try {
      const { window_days } = await readWindowSetting(this.dataSource.manager);
      const verdict = await evaluateCorrectable(
        this.dataSource.manager,
        history,
        { windowDays: window_days },
      );
      return {
        allowed: verdict.allowed,
        ...(verdict.code ? { code: verdict.code } : {}),
        deadline: verdict.deadline,
        window_days: verdict.window_days,
      };
    } catch (error) {
      this.logger.warn(
        `correctable hisoblanmadi (T6, history=${String(history.id)}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // ==================== SMENA (kfdfYDik / QTCUUgjA) ====================

  static readonly SHIFT_REQUIRED_MESSAGE = SHIFT_REQUIRED_MESSAGE;

  static readonly BRANCH_SHIFT_REQUIRED_MESSAGE = BRANCH_SHIFT_REQUIRED_MESSAGE;

  /**
   * (QTCUUgjA) Smena darvozasi qamrovi — env `FINANCE_REQUIRE_OPEN_SHIFT`
   * (`shift-gate.ts`): `off` (SUKUT) | `main` (`true`/`1`/`on`/`yes`/`main` —
   * faqat MAIN, 2026-10-14 xatti-harakati) | `all` (MAIN + filial, R6).
   *
   * SUKUT — O'CHIQ: prod'da hozir birorta ham smena ochilmagan va barcha
   * kassalar smenasiz ishlaydi; darvoza to'satdan yoqilsa kuryerdan qabul,
   * marketga to'lov, qo'lda kirim/chiqim — hammasi birdan 400 bo'lardi.
   * Frontend "Smenani ochish" oqimi chiqib, operatorlar o'rgangach yoqiladi
   * (`all` — menejer sahifasida ham smena tugmasi chiqqandan keyin).
   */
  static shiftGateScope(): 'off' | 'main' | 'all' {
    return shiftGateScope();
  }

  /** Darvoza yoqilganmi (har qanday qamrov). */
  static isShiftRequired(): boolean {
    return shiftGateScope() !== 'off';
  }

  /** Shu turdagi kassa darvozalanadimi (MAIN — main/all, BRANCH — all). */
  static isShiftRequiredFor(
    cashboxType: Cashbox_type | null | undefined,
  ): boolean {
    return isShiftRequiredFor(cashboxType);
  }

  /** Smena kassasi turi: '0' — markaziy MAIN, aks holda filial (BRANCH). */
  private static shiftCashboxType(cashboxUserId: string): Cashbox_type {
    return cashboxUserId === FinanceServiceService.MAIN_CASHBOX_USER_ID
      ? Cashbox_type.MAIN
      : Cashbox_type.BRANCH;
  }

  private static roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private findOpenShiftForCashbox(
    manager: EntityManager,
    cashboxUserId: string,
    lockMode?: 'pessimistic_read' | 'pessimistic_write',
  ): Promise<Shift | null> {
    return manager.findOne(Shift, {
      where: {
        cashbox_user_id: cashboxUserId,
        status: ShiftStatus.OPEN,
        isDeleted: false,
      },
      order: { opened_at: 'DESC' },
      ...(lockMode ? { lock: { mode: lockMode } } : {}),
    });
  }

  /**
   * (QTCUUgjA) Pul operatsiyasi oldidan: shu kassada OCHIQ smena bormi.
   *
   * BeePost'dagi `requireOpenShift()` ARGUMENTSIZ — u yerda butun tizimda
   * bitta global smena. Elchi'da esa smena KASSAGA biriktirilgan
   * (`shifts.cashbox_user_id`, audit M7), shu bois tekshiruv aniq kassa
   * bo'yicha: `requireOpenShift(manager, kassa)`.
   *
   * Qamrov (`shiftGateScope`): `main` — faqat MAIN kassa; `all` — filial
   * (BRANCH) kassasi ham (R6: menejer o'z filiali smenasini gateway orqali
   * ochadi/yopadi). Kuryer/market kassalari darvozalanmaydi.
   *
   * Qulf: smena qatori FOR SHARE bilan o'qiladi. `closeShift` (FOR UPDATE)
   * jarayondagi operatsiyalar commit bo'lishini kutadi, yopilishdan keyin
   * kelgan operatsiya esa yangilangan qatorni (status = closed) ko'rib rad
   * etiladi — birorta pul harakati smena hisobotidan tashqarida qolmaydi.
   *
   * ⚠️ `updateBalance` ning RMQ yo'liga (order-service outbox — sotuv,
   * bekor qilish) QO'YILMAYDI: aks holda sotuvlar smenaga bog'liq bo'lib
   * qolardi va outbox oyoqlari poison-drop bo'lardi.
   */
  async requireOpenShift(
    manager: EntityManager,
    target: { user_id: string; cashbox_type?: Cashbox_type | null },
  ): Promise<void> {
    const cashboxType = target.cashbox_type ?? Cashbox_type.MAIN;
    if (!FinanceServiceService.isShiftRequiredFor(cashboxType)) {
      return;
    }
    const isMain = cashboxType === Cashbox_type.MAIN;
    // Filial smenasi — filial kassasining `user_id` si (= filial ID) bo'yicha.
    const shift = await this.findOpenShiftForCashbox(
      manager,
      String(target.user_id ?? FinanceServiceService.MAIN_CASHBOX_USER_ID),
      'pessimistic_read',
    );
    if (!shift) {
      // (32Sw3DfC) Kuzatuv — `all` yoqilgandan keyin rad etilgan amallar soni.
      this.logger.warn(
        shiftGateBlockedLogLine(
          isMain ? 'SHIFT_REQUIRED' : 'BRANCH_SHIFT_REQUIRED',
          { cashbox_type: cashboxType, user_id: target.user_id },
        ),
      );
      throw new BadRequestException(
        isMain
          ? FinanceServiceService.SHIFT_REQUIRED_MESSAGE
          : FinanceServiceService.BRANCH_SHIFT_REQUIRED_MESSAGE,
      );
    }
  }

  /**
   * (kfdfYDik) GET /finance/shift/current — kassaning (sukut MAIN) joriy ochiq
   * smenasi + darvoza yoqilganmi (`required`). Frontend "Smena ochiq" banneri
   * va "Smenani oching" holati shundan quriladi.
   *
   * (8OYPuz7J, ega S2) `last_closed` — SHU kassaning eng oxirgi yopilgan
   * smenasi (closed_at DESC) yoki null: «Smena yopildi · … · Natija» bloki
   * sahifa qayta yuklangandan keyin ham chiziladi. Smena qatorlarida
   * `opened_by_name` / `closed_by_name` (identity'ga bitta batch so'rov).
   */
  async currentShift(dto?: { cashbox_user_id?: string }) {
    try {
      const cashboxUserId = String(
        dto?.cashbox_user_id ?? FinanceServiceService.MAIN_CASHBOX_USER_ID,
      );
      this.assertBigIntId(cashboxUserId, 'cashbox_user_id');
      const [shift, lastClosed] = await Promise.all([
        this.shiftRepo.findOne({
          where: {
            cashbox_user_id: cashboxUserId,
            status: ShiftStatus.OPEN,
            isDeleted: false,
          },
          order: { opened_at: 'DESC' },
        }),
        this.shiftRepo.findOne({
          where: {
            cashbox_user_id: cashboxUserId,
            status: ShiftStatus.CLOSED,
            isDeleted: false,
          },
          order: {
            closed_at: { direction: 'DESC', nulls: 'LAST' },
            id: 'DESC',
          },
        }),
      ]);
      const [namedShift, namedLastClosed] = await this.withShiftUserNames([
        shift ?? null,
        lastClosed ?? null,
      ]);
      return this.successRes(
        {
          shift: namedShift ?? null,
          // R6: shu kassa TURI uchun (MAIN — main/all, filial — faqat all).
          required: FinanceServiceService.isShiftRequiredFor(
            FinanceServiceService.shiftCashboxType(cashboxUserId),
          ),
          cashbox_user_id: cashboxUserId,
          last_closed: namedLastClosed ?? null,
        },
        200,
        shift ? 'Current shift' : "Ochiq smena yo'q",
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * (8OYPuz7J) Smena qatorlariga `opened_by_name` / `closed_by_name` —
   * identity'ga BITTA `identity.user.find_by_ids` so'rovi (har smena uchun
   * GET users/:id shart emas). Fail-open: identity javob bermasa yoki
   * foydalanuvchi topilmasa — `null` (ro'yxat baribir qaytadi).
   */
  private async withShiftUserNames(
    shifts: Array<Shift | null>,
  ): Promise<Array<ShiftWithNames | null>> {
    const ids = Array.from(
      new Set(
        shifts
          .flatMap((shift) => (shift ? [shift.opened_by, shift.closed_by] : []))
          .map((id) => String(id ?? '').trim())
          .filter((id) => /^\d+$/.test(id)),
      ),
    );
    const names = new Map<string, string>();
    if (ids.length) {
      try {
        const response = await rmqSend<unknown>(
          this.identityClient,
          { cmd: 'identity.user.find_by_ids' },
          { ids },
          { timeoutMs: 3000, retries: 1 },
        );
        const rows = this.extractResponseData<unknown>(response);
        for (const row of Array.isArray(rows) ? rows : []) {
          const user = row as { id?: unknown; name?: unknown } | null;
          const id =
            typeof user?.id === 'string' || typeof user?.id === 'number'
              ? String(user.id)
              : '';
          const name = typeof user?.name === 'string' ? user.name.trim() : '';
          if (id && name) names.set(id, name);
        }
      } catch (error) {
        this.logger.warn(
          `smena xodimlari ismlari olinmadi: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const nameOf = (id: string | null | undefined) =>
      id != null ? (names.get(String(id)) ?? null) : null;
    return shifts.map((shift) =>
      shift
        ? {
            ...shift,
            opened_by_name: nameOf(shift.opened_by),
            closed_by_name: nameOf(shift.closed_by),
          }
        : null,
    );
  }

  async openShift(dto: OpenShiftDto) {
    try {
      this.assertBigIntId(dto.opened_by, 'opened_by');
      const cashboxUserId = String(
        dto.cashbox_user_id ?? FinanceServiceService.MAIN_CASHBOX_USER_ID,
      );
      this.assertBigIntId(cashboxUserId, 'cashbox_user_id');

      // Optimistic pre-check produces a friendlier error message, but is racy.
      // The partial unique index `IDX_SHIFT_OPENED_BY_OPEN_UNIQUE` is the
      // authoritative guard: two concurrent inserts both pass the check but
      // exactly one wins at the DB level; the loser hits 23505 below.
      const openShift = await this.shiftRepo.findOne({
        where: { opened_by: dto.opened_by, status: ShiftStatus.OPEN },
      });

      if (openShift) {
        throw new BadRequestException(
          'Sizda allaqachon ochiq smena bor — avval uni yoping',
        );
      }

      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      let saved: Shift;
      try {
        /**
         * (QTCUUgjA) Kassa qatori qulflanadi (FOR UPDATE):
         *  1) bitta kassada bir vaqtda IKKI smena ochilmasin — aks holda ikki
         *     smena oynasi bir xil operatsiyalarni hisoblab, kamomad nazorati
         *     ma'nosiz bo'lardi (BeePost: global yagona ochiq smena);
         *  2) ochilish qoldig'i aynan shu lahzadagi JONLI qoldiq bo'lsin
         *     (BeePost naqshi) — operator qiymat yubormasa avval 0 yozilardi va
         *     yopishdagi "kutilgan qoldiq" noto'g'ri chiqardi.
         */
        const cashbox = await queryRunner.manager.findOne(Cashbox, {
          where: {
            user_id: cashboxUserId,
            cashbox_type: FinanceServiceService.shiftCashboxType(cashboxUserId),
            isDeleted: false,
          },
          lock: { mode: 'pessimistic_write' },
        });
        const openForCashbox = await this.findOpenShiftForCashbox(
          queryRunner.manager,
          cashboxUserId,
        );
        if (openForCashbox) {
          throw new BadRequestException(
            `Bu kassada allaqachon ochiq smena bor (smena #${String(
              openForCashbox.id,
            )}) — avval uni yoping`,
          );
        }

        const shift = queryRunner.manager.create(Shift, {
          opened_by: dto.opened_by,
          opened_at: new Date(),
          status: ShiftStatus.OPEN,
          opening_balance_cash:
            dto.opening_balance_cash != null
              ? Number(dto.opening_balance_cash)
              : Number(cashbox?.balance_cash ?? 0),
          opening_balance_card:
            dto.opening_balance_card != null
              ? Number(dto.opening_balance_card)
              : Number(cashbox?.balance_card ?? 0),
          comment: dto.comment ?? null,
          // Smena qaysi kassaga tegishli (audit M7). Berilmasa — markaziy MAIN
          // kassa: smena ochish huquqi bor rollar (superadmin/admin/registrator)
          // aynan shu kassani boshqaradi.
          cashbox_user_id: cashboxUserId,
        });
        saved = await queryRunner.manager.save(shift);
        await queryRunner.commitTransaction();
      } catch (txError) {
        await queryRunner.rollbackTransaction();
        if (
          txError instanceof QueryFailedError &&
          (txError as QueryFailedError & { code?: string }).code === '23505'
        ) {
          throw new BadRequestException(
            'Sizda allaqachon ochiq smena bor — avval uni yoping',
          );
        }
        throw txError;
      } finally {
        await queryRunner.release();
      }

      await this.activityLog.log({
        entity_type: 'Shift',
        entity_id: saved.id,
        action: ActivityAction.CREATED,
        new_value: {
          opened_by: saved.opened_by,
          opened_at: saved.opened_at,
          opening_balance_cash: saved.opening_balance_cash,
          opening_balance_card: saved.opening_balance_card,
        },
        user_id: dto.opened_by ? String(dto.opened_by) : null,
        metadata: { opened_by: dto.opened_by, cashbox_user_id: cashboxUserId },
      });
      return this.successRes(saved, 201, 'Shift opened');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async closeShift(dto: CloseShiftDto) {
    try {
      this.assertBigIntId(dto.closed_by, 'closed_by');

      const countedCash =
        dto.closing_balance_cash != null
          ? Number(dto.closing_balance_cash)
          : null;
      const countedCard =
        dto.closing_balance_card != null
          ? Number(dto.closing_balance_card)
          : null;
      for (const [field, value] of [
        ['closing_balance_cash', countedCash],
        ['closing_balance_card', countedCard],
      ] as const) {
        if (value != null && (!Number.isFinite(value) || value < 0)) {
          throw new BadRequestException(
            `${field} manfiy bo'lmagan son bo'lishi kerak`,
          );
        }
      }

      /**
       * R6 — kassa doirasi: menejer faqat O'Z filiali kassasining smenasini
       * yopadi (gateway `cashbox_user_id` = filial ID ni majburlaydi).
       * Berilmasa (admin) — avvalgi xatti-harakat.
       */
      const cashboxScope =
        dto.cashbox_user_id != null && String(dto.cashbox_user_id) !== ''
          ? String(dto.cashbox_user_id)
          : null;
      if (cashboxScope) {
        this.assertBigIntId(cashboxScope, 'cashbox_user_id');
      }

      // Pre-locate the shift's id without lock so we can then re-fetch with a
      // row-level lock inside the transaction. Without the lock, two parallel
      // closeShift calls can both pass the status==='open' check and double-write.
      let shiftId: string | null = null;

      if (dto.shift_id) {
        this.assertBigIntId(dto.shift_id, 'shift_id');
        shiftId = String(dto.shift_id);
      } else {
        /**
         * (kfdfYDik) Frontend faqat `{ comment }` yuborsa ham yopiladi:
         * `closed_by` gateway'da JWT'dan olinadi. Qidiruv tartibi —
         * `opened_by` berilgan bo'lsa faqat o'sha; aks holda yopayotgan
         * foydalanuvchining o'z ochiq smenasi, u ham bo'lmasa markaziy MAIN
         * kassaning ochiq smenasi (smena kassaga tegishli — QTCUUgjA).
         */
        if (dto.opened_by) {
          this.assertBigIntId(dto.opened_by, 'opened_by');
        }
        let candidate = await this.shiftRepo.findOne({
          where: {
            opened_by: dto.opened_by ?? dto.closed_by,
            status: ShiftStatus.OPEN,
            isDeleted: false,
            ...(cashboxScope ? { cashbox_user_id: cashboxScope } : {}),
          },
          order: { opened_at: 'DESC' },
        });
        if (!candidate && !dto.opened_by) {
          // R6: menejer (kassa doirasi berilgan) — o'z filiali kassasining
          // ochiq smenasi; doira yo'q (admin) — avvalgidek MAIN.
          candidate = await this.shiftRepo.findOne({
            where: {
              cashbox_user_id:
                cashboxScope ?? FinanceServiceService.MAIN_CASHBOX_USER_ID,
              status: ShiftStatus.OPEN,
              isDeleted: false,
            },
            order: { opened_at: 'DESC' },
          });
        }
        shiftId = candidate ? String(candidate.id) : null;
      }

      if (!shiftId) {
        throw new NotFoundException('Ochiq smena topilmadi');
      }

      // (kiZgTybn) Yaqinda yuklangan rasmlarning AI natijasi hali `pending`
      // bo'lsa — 30 s gacha kutiladi (smena qulfidan TASHQARIDA), keyin
      // yopishga ruxsat: AI sekin / ishlamasa kassir bloklanmaydi.
      if (this.shiftAccountChecks) {
        await this.shiftAccountChecks.waitForPending(shiftId);
      }

      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      // Captured after a durable commit so the audit row is written once the
      // transaction is committed and the runner released (never inside the tx).
      let auditedShift: Shift | null = null;
      let accountsSummary: Record<string, unknown> | null = null;

      try {
        const shift = await queryRunner.manager.findOne(Shift, {
          where: { id: shiftId },
          lock: { mode: 'pessimistic_write' },
        });

        if (!shift) {
          throw new NotFoundException('Ochiq smena topilmadi');
        }

        // R6: boshqa kassaning smenasi (masalan menejer `shift_id` bilan MAIN
        // yoki boshqa filial smenasini yopmoqchi) — topilmadi.
        if (
          cashboxScope &&
          String(
            shift.cashbox_user_id ?? FinanceServiceService.MAIN_CASHBOX_USER_ID,
          ) !== cashboxScope
        ) {
          throw new NotFoundException('Ochiq smena topilmadi');
        }

        if (shift.status !== ShiftStatus.OPEN) {
          throw new BadRequestException('Smena allaqachon yopilgan');
        }

        const closeTime = new Date();
        await this.fillShiftCloseTotals(
          queryRunner.manager,
          shift,
          closeTime,
          countedCash,
          countedCard,
        );
        shift.closed_by = dto.closed_by;
        shift.close_reason = 'manual';
        shift.closed_by_system = false;
        // (gWI4gYkw) Hisobot yuborish navbati — shu tranzaksiyada.
        shift.report_status = 'pending';
        shift.report_round = 1;
        shift.comment = dto.comment ?? shift.comment;

        // (kiZgTybn) Har karta / hisob qoldig'i: snapshot + validatsiya
        // (majburiy rasm, izoh). Shu tranzaksiyada — 400 bo'lsa smena ochiq
        // qoladi. PUL HARAKATI YO'Q (faqat shift_account_checks).
        if (this.shiftAccountChecks) {
          accountsSummary = await this.shiftAccountChecks.confirmAtClose(
            queryRunner.manager,
            shift,
            dto.accounts,
            String(dto.closed_by),
          );
        } else if (Array.isArray(dto.accounts) && dto.accounts.length) {
          throw new BadRequestException(
            'Karta qoldiqlarini tasdiqlash hozircha mavjud emas',
          );
        }

        const saved = await queryRunner.manager.save(shift);
        // (rWdLuoP3) Ochiq kassa sahifalari darhol «Smena yopiq» — outbox
        // qatori shu tranzaksiyada (rollback bo'lsa hodisa ham yo'q).
        await this.financeRealtime?.shiftClosed(
          saved,
          'manual',
          queryRunner.manager,
        );
        await queryRunner.commitTransaction();
        auditedShift = saved;
        return this.successRes(
          accountsSummary
            ? { ...saved, accounts_check: accountsSummary }
            : saved,
          200,
          'Shift closed',
        );
      } catch (error) {
        await queryRunner.rollbackTransaction();
        throw error;
      } finally {
        await queryRunner.release();
        if (auditedShift) {
          await this.activityLog.log({
            entity_type: 'Shift',
            entity_id: auditedShift.id,
            action: ActivityAction.STATUS_CHANGE,
            new_value: {
              status: auditedShift.status,
              closed_at: auditedShift.closed_at,
              expected_balance_cash: auditedShift.expected_balance_cash,
              discrepancy_cash: auditedShift.discrepancy_cash,
              discrepancy_card: auditedShift.discrepancy_card,
            },
            user_id: dto.closed_by ? String(dto.closed_by) : null,
            metadata: {
              closed_by: dto.closed_by,
              opened_by: auditedShift.opened_by,
              close_reason: 'manual',
              ...(accountsSummary ? { accounts: accountsSummary } : {}),
            },
          });
          // (gWI4gYkw) Hisobot — fonda (javob kutilmaydi).
          this.shiftReports?.deliverSoon(String(auditedShift.id));
        }
      }
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * (y8Tqm9Ap) Jadval bo'yicha AVTOMATIK yopish — scheduler chaqiradi.
   *
   * Bir martalik: smena qatori FOR UPDATE + `status = open` tekshiruvi VA
   * `shift_schedule_claims` ga `auto_close:<shift_id>:<slot>` kaliti (PRIMARY
   * KEY, ON CONFLICT DO NOTHING) — ikkala replika bir vaqtda kelsa ham
   * smena bitta marta yopiladi, ikkinchisi `not_open` / `claimed` oladi.
   *
   * Hisob — qo'lda yopish bilan AYNAN bir xil (`fillShiftCloseTotals`), faqat
   * sanalgan qiymat yo'q: `closing_balance_* = 0`, `discrepancy_* = NULL`.
   * `closed_by = NULL`, `closed_by_system = true`, `close_reason = 'auto'`.
   * Kartalar — `recordAtAutoClose` (tasdiqlanmagan snapshot). Keyingi smena
   * avtomatik OCHILMAYDI. Pul harakati YO'Q.
   */
  async autoCloseShift(input: {
    shift_id: string;
    slot_key: string;
    slot_at: Date;
  }): Promise<{ closed: boolean; reason: string; shift_id: string }> {
    const shiftId = String(input.shift_id);
    this.assertBigIntId(shiftId, 'shift_id');
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    let saved: Shift | null = null;
    let accounts: Record<string, unknown> | null = null;
    try {
      const manager = queryRunner.manager;
      const shift = await manager.findOne(Shift, {
        where: { id: shiftId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!shift || shift.status !== ShiftStatus.OPEN) {
        await queryRunner.rollbackTransaction();
        return { closed: false, reason: 'not_open', shift_id: shiftId };
      }
      // Slotdan KEYIN ochilgan smena shu slotda yopilmaydi.
      if (new Date(shift.opened_at).getTime() >= input.slot_at.getTime()) {
        await queryRunner.rollbackTransaction();
        return {
          closed: false,
          reason: 'opened_after_slot',
          shift_id: shiftId,
        };
      }
      const claim = await manager
        .createQueryBuilder()
        .insert()
        .into(ShiftScheduleClaim)
        .values({
          key: autoCloseClaimKey(shiftId, input.slot_key),
          shift_id: shiftId,
          kind: 'auto_close',
          slot: input.slot_key,
        })
        .orIgnore()
        .returning(['key'])
        .execute();
      if (!Array.isArray(claim.raw) || !claim.raw.length) {
        await queryRunner.rollbackTransaction();
        return { closed: false, reason: 'claimed', shift_id: shiftId };
      }

      const closeTime = new Date();
      await this.fillShiftCloseTotals(manager, shift, closeTime, null, null);
      shift.closed_by = null;
      shift.closed_by_system = true;
      shift.close_reason = 'auto';
      shift.report_status = 'pending';
      shift.report_round = 1;
      if (this.shiftAccountChecks) {
        accounts = await this.shiftAccountChecks.recordAtAutoClose(
          manager,
          shift,
        );
      }
      saved = await manager.save(shift);
      // (rWdLuoP3) `finance.shift.auto_closed` (payload'da `closed_at`).
      await this.financeRealtime?.shiftClosed(saved, 'auto', manager);
      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
    if (!saved) return { closed: false, reason: 'not_open', shift_id: shiftId };

    await this.activityLog.log({
      entity_type: 'Shift',
      entity_id: saved.id,
      action: 'finance.shift_auto_closed',
      old_value: { status: ShiftStatus.OPEN },
      new_value: {
        status: saved.status,
        closed_at: saved.closed_at,
        close_reason: 'auto',
        closed_by_system: true,
        expected_balance_cash: saved.expected_balance_cash,
        expected_balance_card: saved.expected_balance_card,
        discrepancy_cash: null,
        discrepancy_card: null,
      },
      user_id: null,
      metadata: {
        description: 'Smena tizim tomonidan avtomatik yopildi',
        label: autoClosedLabel(saved.closed_at),
        slot: input.slot_key,
        opened_by: saved.opened_by,
        cashbox_user_id: saved.cashbox_user_id,
        ...(accounts ? { accounts } : {}),
      },
    });
    this.shiftReports?.deliverSoon(String(saved.id));
    return { closed: true, reason: 'auto_closed', shift_id: shiftId };
  }

  /**
   * (y8Tqm9Ap) Smenani yopish HISOBI — qo'lda (`closeShift`) va avtomatik
   * (`autoCloseShift`) yopishda AYNAN bir xil: oyna `opened_at → closeTime`,
   * faqat smena kassasi bo'yicha kirim/chiqim, konvertatsiya, kutilgan qoldiq
   * va farq (`counted` NULL — farq NULL). Smena qatori chaqiruvchida
   * FOR UPDATE bilan qulflangan bo'lishi SHART. Pul harakati YO'Q — faqat
   * smena qatoriga yig'indilar yoziladi.
   */
  private async fillShiftCloseTotals(
    manager: EntityManager,
    shift: Shift,
    closeTime: Date,
    countedCash: number | null,
    countedCard: number | null,
  ): Promise<void> {
    /**
     * ⚠️ SMENA YIG'INDISI FAQAT O'Z KASSASI BO'YICHA (audit M7).
     *
     * Ilgari bu yerda oraliqdagi BARCHA `cashbox_history` qatorlari
     * yuklanardi — kassa filtri ham, `is_deleted` filtri ham yo'q edi.
     * Ya'ni bitta operator smenasining "kirim/chiqim" raqami butun
     * kompaniyaning (barcha kuryer, market, filial va MAIN kassalari)
     * yig'indisi bo'lardi. Natijada sanab topshirilgan naqdni tizim
     * raqami bilan solishtirib bo'lmasdi — kassadagi kamomadni
     * aniqlaydigan yagona nazorat ishlamasdi. Yon ta'siri: uzoq turgan
     * smena yuz minglab qatorni xotiraga yuklardi.
     *
     * Endi yig'indi SQL'da, faqat smenaga biriktirilgan kassa bo'yicha
     * olinadi (sukut — markaziy MAIN kassa). (QTCUUgjA) Kassa TURI ham
     * filtrlanadi: filial id si bir xil raqamli kuryer/market user_id si
     * bilan to'qnashib, begona kassa harakatlari filial smenasiga
     * qo'shilmasin.
     */
    const shiftCashboxUserId = String(
      shift.cashbox_user_id ?? FinanceServiceService.MAIN_CASHBOX_USER_ID,
    );
    const totalsRows = await manager
      .createQueryBuilder(CashboxHistory, 'h')
      .innerJoin(Cashbox, 'cb', 'cb.id = h.cashbox_id')
      .select('h.operation_type', 'operation_type')
      .addSelect('h.payment_method', 'payment_method')
      .addSelect('COALESCE(SUM(h.amount), 0)', 'total')
      .where('h.isDeleted = :active', { active: false })
      .andWhere('cb.isDeleted = :active', { active: false })
      .andWhere('cb.user_id = :ownerId', { ownerId: shiftCashboxUserId })
      .andWhere('cb.cashbox_type = :cbType', {
        cbType: FinanceServiceService.shiftCashboxType(shiftCashboxUserId),
      })
      .andWhere('h.createdAt BETWEEN :from AND :to', {
        from: shift.opened_at,
        to: closeTime,
      })
      .groupBy('h.operation_type')
      .addGroupBy('h.payment_method')
      .getRawMany<{
        operation_type: string;
        payment_method: string | null;
        total: string;
      }>();

    let totalIncomeCash = 0;
    let totalIncomeCard = 0;
    let totalExpenseCash = 0;
    let totalExpenseCard = 0;

    for (const row of totalsRows) {
      const total = Number(row.total) || 0;
      // Eski xatti-harakat bilan bir xil: CASH bo'lmagani — karta.
      const isCash = row.payment_method === PaymentMethod.CASH;
      if (row.operation_type === Operation_type.INCOME) {
        if (isCash) totalIncomeCash += total;
        else totalIncomeCard += total;
      } else if (row.operation_type === Operation_type.EXPENSE) {
        if (isCash) totalExpenseCash += total;
        else totalExpenseCard += total;
      }
    }

    /**
     * 3PE0B03q — MAIN kassada karta↔naqd KONVERTATSIYA (kirim/chiqim
     * emas, `cashbox_history` da yo'q) naqd/karta ajratmasini o'zgartiradi:
     * kutilgan qoldiqqa qo'shilmasa har konvertatsiya soxta kamomad /
     * ortiqcha bo'lib chiqardi (BeePost buni `netConversion` deb alohida
     * ko'rsatadi). Kartalararo o'tkazma `balance_card` ni o'zgartirmaydi.
     */
    // Zv3MLn0a — filial kassalarida ham kartalar (konvertatsiya) bor:
    // smena kassasining turi bo'yicha (MAIN yoki filial).
    let cardToCash = 0;
    let cashToCard = 0;
    {
      const conversionRows = await manager
        .createQueryBuilder(CashboxCardMovement, 'm')
        .innerJoin(Cashbox, 'cb', 'cb.id = m.cashbox_id')
        .select('m.type', 'type')
        .addSelect('COALESCE(SUM(m.amount), 0)', 'total')
        .where('m.is_deleted = false')
        .andWhere('cb.user_id = :ownerId', { ownerId: shiftCashboxUserId })
        .andWhere('cb.cashbox_type = :mainType', {
          mainType: FinanceServiceService.shiftCashboxType(shiftCashboxUserId),
        })
        .andWhere('m.type IN (:...conversionTypes)', {
          conversionTypes: [
            CardMovementType.CARD_TO_CASH,
            CardMovementType.CASH_TO_CARD,
          ],
        })
        .andWhere('m.createdAt BETWEEN :from AND :to', {
          from: shift.opened_at,
          to: closeTime,
        })
        .groupBy('m.type')
        .getRawMany<{ type?: string; total?: string }>();
      for (const row of conversionRows ?? []) {
        const total = Number(row?.total) || 0;
        if (row?.type === CardMovementType.CARD_TO_CASH) {
          cardToCash += total;
        } else if (row?.type === CardMovementType.CASH_TO_CARD) {
          cashToCard += total;
        }
      }
    }

    /**
     * (QTCUUgjA) Kamomad hisobi:
     *   expected    = opening_balance + total_income − total_expense
     *                 (+ naqd↔karta konvertatsiyasi, 3PE0B03q)
     *   discrepancy = closing_balance (sanab topshirilgan) − expected
     * Manfiy — kamomad, musbat — ortiqcha. Sanalgan summa yuborilmasa
     * discrepancy NULL: "sanalmadi" holati soxta kamomad bo'lib
     * ko'rinmasin (closing_balance avvalgidek 0 yoziladi).
     */
    const round = (value: number) => FinanceServiceService.roundMoney(value);
    const expectedCash = round(
      Number(shift.opening_balance_cash ?? 0) +
        totalIncomeCash -
        totalExpenseCash +
        cardToCash -
        cashToCard,
    );
    const expectedCard = round(
      Number(shift.opening_balance_card ?? 0) +
        totalIncomeCard -
        totalExpenseCard -
        cardToCash +
        cashToCard,
    );

    shift.closed_at = closeTime;
    shift.status = ShiftStatus.CLOSED;
    shift.total_income_cash = round(totalIncomeCash);
    shift.total_income_card = round(totalIncomeCard);
    shift.total_expense_cash = round(totalExpenseCash);
    shift.total_expense_card = round(totalExpenseCard);
    shift.closing_balance_cash = countedCash ?? 0;
    shift.closing_balance_card = countedCard ?? 0;
    shift.expected_balance_cash = expectedCash;
    shift.expected_balance_card = expectedCard;
    shift.discrepancy_cash =
      countedCash == null ? null : round(countedCash - expectedCash);
    shift.discrepancy_card =
      countedCard == null ? null : round(countedCard - expectedCard);
  }

  /**
   * (kiZgTybn) `GET finance/shift/:id/report` — naqd + kartalar bo'yicha
   * natijalar (AI holati, rasm kaliti — gateway imzolangan havolaga
   * aylantiradi) va operatsiyalar xulosasi. `cashbox_user_id` — doira
   * (menejer — o'z filiali, registrator — MAIN): boshqa kassa smenasi 404.
   * Ochiq smenada oyna `opened_at → hozir`.
   */
  async getShiftReport(input: {
    shift_id?: string | number;
    cashbox_user_id?: string | number;
  }) {
    try {
      const shiftId = String(input?.shift_id ?? '').trim();
      this.assertBigIntId(shiftId, 'shift_id');
      const rawScope = String(input?.cashbox_user_id ?? '').trim();
      const scope = rawScope !== '' ? rawScope : null;
      if (scope) this.assertBigIntId(scope, 'cashbox_user_id');
      const shift = await this.shiftRepo.findOne({
        where: { id: shiftId, isDeleted: false },
      });
      const cashboxUserId = String(
        shift?.cashbox_user_id ?? FinanceServiceService.MAIN_CASHBOX_USER_ID,
      );
      if (!shift || (scope && scope !== cashboxUserId)) {
        throw new NotFoundException('Smena topilmadi');
      }
      const to = shift.closed_at ?? new Date();
      const operations = await this.dataSource.manager
        .createQueryBuilder(CashboxHistory, 'h')
        .innerJoin(Cashbox, 'cb', 'cb.id = h.cashbox_id')
        .select('h.operation_type', 'operation_type')
        .addSelect('h.payment_method', 'payment_method')
        .addSelect('COUNT(*)', 'count')
        .addSelect('COALESCE(SUM(h.amount), 0)', 'total')
        .where('h.isDeleted = :active', { active: false })
        .andWhere('cb.isDeleted = :active', { active: false })
        .andWhere('cb.user_id = :ownerId', { ownerId: cashboxUserId })
        .andWhere('cb.cashbox_type = :cbType', {
          cbType: FinanceServiceService.shiftCashboxType(cashboxUserId),
        })
        .andWhere('h.createdAt BETWEEN :from AND :to', {
          from: shift.opened_at,
          to,
        })
        .groupBy('h.operation_type')
        .addGroupBy('h.payment_method')
        .getRawMany<{
          operation_type: string;
          payment_method: string | null;
          count: string;
          total: string;
        }>();
      const [named] = await this.withShiftUserNames([shift]);
      const accounts = this.shiftAccountChecks
        ? await this.shiftAccountChecks.listForShift(shiftId)
        : [];
      // (y8Tqm9Ap) Yopilish turi; eski (167 dan oldingi) yopilgan smena — manual.
      const closeReason =
        shift.status === ShiftStatus.CLOSED
          ? (shift.close_reason ?? 'manual')
          : null;
      return this.successRes(
        {
          shift: named,
          close_reason: closeReason,
          closed_by_system: Boolean(shift.closed_by_system),
          // Sariq banner: «Avtomatik yopildi — HH:MM, kassir yopmagan».
          auto_close:
            closeReason === 'auto'
              ? {
                  closed_at: shift.closed_at,
                  label: autoClosedLabel(shift.closed_at),
                }
              : null,
          // (gWI4gYkw) Hisobot yuborish holati + «Hisobot kimlarga yuborildi».
          report: {
            status: shift.report_status ?? null,
            round: shift.report_round ?? 0,
            file_key: shift.report_file_key ?? null,
            file_format: shift.report_file_format ?? null,
          },
          deliveries: this.shiftReports
            ? await this.shiftReports
                .listDeliveries(shiftId)
                .catch((error: unknown) => {
                  this.logger.warn(
                    `smena #${shiftId} yetkazish ro'yxati: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                  return [];
                })
            : [],
          cashbox_user_id: cashboxUserId,
          cashbox_type:
            cashboxUserId === FinanceServiceService.MAIN_CASHBOX_USER_ID
              ? 'main'
              : 'branch',
          cash: {
            opening_balance: shift.opening_balance_cash,
            total_income: shift.total_income_cash,
            total_expense: shift.total_expense_cash,
            expected_balance: shift.expected_balance_cash,
            closing_balance: shift.closing_balance_cash,
            discrepancy: shift.discrepancy_cash,
          },
          card: {
            opening_balance: shift.opening_balance_card,
            total_income: shift.total_income_card,
            total_expense: shift.total_expense_card,
            expected_balance: shift.expected_balance_card,
            closing_balance: shift.closing_balance_card,
            discrepancy: shift.discrepancy_card,
          },
          accounts,
          accounts_summary: this.shiftAccountChecks
            ? this.shiftAccountChecks.summarize(accounts)
            : null,
          operations: operations.map((row) => ({
            operation_type: row.operation_type,
            payment_method: row.payment_method,
            count: Number(row.count) || 0,
            total: FinanceServiceService.roundMoney(Number(row.total) || 0),
          })),
          operations_window: { from: shift.opened_at, to },
        },
        200,
        'Shift report',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findAllShifts(dto: FindShiftsDto) {
    try {
      const page = dto.page && dto.page > 0 ? dto.page : 1;
      const limit = dto.limit && dto.limit > 0 ? dto.limit : 20;

      const where: FindOptionsWhere<Shift> = {};

      if (dto.opened_by) {
        this.assertBigIntId(dto.opened_by, 'opened_by');
        where.opened_by = dto.opened_by;
      }
      if (dto.status) {
        where.status = dto.status;
      }
      // (8OYPuz7J, ega S3) Kassa bo'yicha: '0' — MAIN, aks holda filial ID si.
      // Ilgari frontend MAIN smenasini 20 talik sahifadan klientda qidirardi.
      if (dto.cashbox_user_id != null && String(dto.cashbox_user_id) !== '') {
        this.assertBigIntId(String(dto.cashbox_user_id), 'cashbox_user_id');
        where.cashbox_user_id = String(dto.cashbox_user_id);
      }

      const from = this.parseDate(dto.from_date);
      const to = this.parseDate(dto.to_date);
      if (from && to) {
        where.opened_at = Between(from, to);
      } else if (from) {
        where.opened_at = MoreThanOrEqual(from);
      } else if (to) {
        where.opened_at = LessThanOrEqual(to);
      }

      // (8OYPuz7J) Saralash oq ro'yxati: opened_at (sukut) | closed_at.
      // closed_at bo'yicha ochiq smenalar (NULL) har doim oxirida.
      const sortBy = dto.sort_by === 'closed_at' ? 'closed_at' : 'opened_at';
      const sortDir = dto.sort_dir === 'asc' ? 'ASC' : 'DESC';
      const order: FindOptionsOrder<Shift> =
        sortBy === 'closed_at'
          ? { closed_at: { direction: sortDir, nulls: 'LAST' }, id: sortDir }
          : { opened_at: sortDir, id: sortDir };

      const [rows, total] = await this.shiftRepo.findAndCount({
        where,
        order,
        skip: (page - 1) * limit,
        take: limit,
      });
      const items = await this.withShiftUserNames(rows);

      return this.successRes(
        {
          items,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
        200,
        'Shifts list',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async createSalary(dto: CreateSalaryDto) {
    try {
      this.assertBigIntId(dto.user_id, 'user_id');
      this.assertPositiveAmount(Number(dto.salary_amount), 'salary_amount');

      const existing = await this.salaryRepo.findOne({
        where: { user_id: dto.user_id },
      });
      if (existing) {
        throw new BadRequestException(
          'Salary row already exists for this user',
        );
      }

      const paymentDay = Number(dto.payment_day ?? 1);
      if (paymentDay < 1 || paymentDay > 31) {
        throw new BadRequestException('payment_day must be between 1 and 31');
      }

      const salary = this.salaryRepo.create({
        user_id: dto.user_id,
        salary_amount: Number(dto.salary_amount),
        have_to_pay:
          dto.have_to_pay !== undefined
            ? Number(dto.have_to_pay)
            : Number(dto.salary_amount),
        payment_day: paymentDay,
      });

      const saved = await this.salaryRepo.save(salary);
      await this.activityLog.log({
        entity_type: 'UserSalary',
        entity_id: saved.id,
        action: ActivityAction.CREATED,
        new_value: {
          salary_amount: saved.salary_amount,
          payment_day: saved.payment_day,
        },
        user_id: dto.user_id ? String(dto.user_id) : null,
        metadata: { user_id: dto.user_id },
      });
      return this.successRes(saved, 201, 'Salary created');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async updateSalary(dto: UpdateSalaryDto) {
    try {
      this.assertBigIntId(dto.user_id, 'user_id');

      const salary = await this.salaryRepo.findOne({
        where: { user_id: dto.user_id },
      });
      if (!salary) {
        throw new NotFoundException('Salary not found for this user');
      }

      // Snapshot BEFORE mutating so logChange can diff only the changed fields.
      const before = {
        salary_amount: Number(salary.salary_amount),
        have_to_pay: Number(salary.have_to_pay),
        payment_day: Number(salary.payment_day),
      };

      if (dto.salary_amount !== undefined) {
        this.assertPositiveAmount(Number(dto.salary_amount), 'salary_amount');
        salary.salary_amount = Number(dto.salary_amount);
      }
      if (dto.have_to_pay !== undefined) {
        salary.have_to_pay = Number(dto.have_to_pay);
      }
      if (dto.increase_have_to_pay_by !== undefined) {
        salary.have_to_pay += Number(dto.increase_have_to_pay_by);
      }
      if (dto.payment_day !== undefined) {
        const paymentDay = Number(dto.payment_day);
        if (paymentDay < 1 || paymentDay > 31) {
          throw new BadRequestException('payment_day must be between 1 and 31');
        }
        salary.payment_day = paymentDay;
      }

      const saved = await this.salaryRepo.save(salary);
      await this.activityLog.logChange({
        entity_type: 'UserSalary',
        entity_id: saved.id,
        old_value: before,
        new_value: {
          salary_amount: Number(saved.salary_amount),
          have_to_pay: Number(saved.have_to_pay),
          payment_day: Number(saved.payment_day),
        },
        action: ActivityAction.UPDATED,
        user_id: dto.user_id ? String(dto.user_id) : null,
        metadata: { user_id: dto.user_id },
      });
      return this.successRes(saved, 200, 'Salary updated');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findSalaryByUser(data: FindSalaryByUserDto) {
    try {
      this.assertBigIntId(data.user_id, 'user_id');

      const salary = await this.salaryRepo.findOne({
        where: { user_id: data.user_id },
      });

      if (!salary) {
        throw new NotFoundException('Salary not found for this user');
      }

      return this.successRes(salary, 200, 'Salary found');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async getMainCashbox(filters?: {
    fromDate?: string;
    toDate?: string;
    sourceTypes?: string;
    source_types?: string;
  }) {
    try {
      const mainCashbox = await this.ensureMainCashbox();
      const { start, end } = this.parseDateRange(
        filters?.fromDate,
        filters?.toDate,
      );
      const where: FindOptionsWhere<CashboxHistory> = {
        cashbox_id: mainCashbox.id,
        isDeleted: false,
      };
      if (start && end) where.createdAt = Between(start, end);
      else if (start) where.createdAt = MoreThanOrEqual(start);
      else if (end) where.createdAt = LessThanOrEqual(end);
      const sourceTypes = this.parseSourceTypes(
        filters?.sourceTypes ?? filters?.source_types,
      );
      if (sourceTypes?.length) {
        where.source_type = In(sourceTypes);
      }

      const rows = await this.historyRepo.find({
        where,
        order: { createdAt: 'DESC' },
      });
      const { income, outcome } = this.calcIncomeOutcome(rows);
      const cashboxHistory = await this.withCorrections(rows);
      return this.successRes(
        { cashbox: mainCashbox, cashboxHistory, income, outcome },
        200,
        'Main cashbox details',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async getCashboxByUserId(data: {
    id: string;
    fromDate?: string;
    toDate?: string;
    cashbox_type?: Cashbox_type;
    history_source_type?: Source_type;
    history_source_types?: string;
    sourceTypes?: string;
    source_types?: string;
  }) {
    try {
      this.assertBigIntId(data.id, 'id');
      const where: FindOptionsWhere<Cashbox> = {
        user_id: data.id,
        isDeleted: false,
      };
      // This is a USER-scoped lookup (id = user_id). A BRANCH cashbox is keyed
      // by branch_id, so when a market's user_id numerically collides with a
      // branch_id, an untyped lookup could return the wrong (branch) cashbox.
      // A user's "main" cashbox is never a branch cashbox — exclude BRANCH when
      // no explicit type is requested. (Every branch caller passes BRANCH
      // explicitly.) (Live-E2E fix.)
      if (data.cashbox_type) where.cashbox_type = data.cashbox_type;
      else where.cashbox_type = Not(Cashbox_type.BRANCH);

      const cashbox = await this.cashboxRepo.findOne({
        where,
        order: { createdAt: 'DESC' },
      });
      if (!cashbox) throw new NotFoundException('Cashbox not found');

      const { start, end } = this.parseDateRange(data.fromDate, data.toDate);
      const historyWhere: FindOptionsWhere<CashboxHistory> = {
        cashbox_id: cashbox.id,
        isDeleted: false,
      };
      if (data.history_source_type) {
        historyWhere.source_type = data.history_source_type;
      }
      const historySourceTypes = this.parseSourceTypes(
        data.history_source_types ?? data.sourceTypes ?? data.source_types,
      );
      if (historySourceTypes?.length) {
        historyWhere.source_type = In(historySourceTypes);
      }
      if (start && end) historyWhere.createdAt = Between(start, end);
      else if (start) historyWhere.createdAt = MoreThanOrEqual(start);
      else if (end) historyWhere.createdAt = LessThanOrEqual(end);

      const rawHistory = await this.historyRepo.find({
        where: historyWhere,
        order: { createdAt: 'DESC' },
      });
      const { income, outcome } = this.calcIncomeOutcome(rawHistory);
      const ackedHistory =
        cashbox.cashbox_type === Cashbox_type.FOR_COURIER
          ? await this.withPaymentAcks(rawHistory)
          : rawHistory;

      /**
       * (vf4513Zn) my-cashbox / kassa sahifasi tarixida KONTRAGENT ismi:
       * `source_user` (COURIER_PAYMENT / MARKET_PAYMENT — masalan menejer
       * filial kassasidagi «Kuryerdan filialga o'tkazma» qatorida kuryer),
       * `created_by_user` va kassa EGASI `cashbox.user` — faqat kuryer/market
       * kassasida (CODE-08: BRANCH/MAIN `user_id` si odam emas — null).
       * Identity javob bermasa — null (tarix baribir qaytadi). Hammasi faqat
       * `{id, name, role, phone_number}` (loadUsersByIds) — to'liq yozuv
       * kuryerga market tarifini, marketga kuryer maoshini sizdirardi.
       */
      const ownerIsUser =
        cashbox.cashbox_type === Cashbox_type.FOR_COURIER ||
        cashbox.cashbox_type === Cashbox_type.FOR_MARKET;
      const [cashboxHistory, owners] = await Promise.all([
        this.enrichHistoryWithUsers(ackedHistory, { courierAck: false }).then(
          (rows) => this.withCorrections(rows),
        ),
        ownerIsUser
          ? this.loadUsersByIds([String(cashbox.user_id)])
          : Promise.resolve(new Map<string, PublicUserSummary | null>()),
      ]);
      const cashboxWithOwner = {
        ...cashbox,
        user: owners.get(String(cashbox.user_id)) ?? null,
      };

      return this.successRes(
        { cashbox: cashboxWithOwner, cashboxHistory, income, outcome },
        200,
        'Cashbox details',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * (2crjWf7v) Kuryer kassasi tarixida pul topshirish qatorlariga kuryerning
   * bot kvitansiyasiga javobi: `payment_ack` = `confirmed` | `disputed` |
   * `null` (javob yo'q). Kvitansiya `payment_id` = shu qatorning id'si.
   * Faqat ko'rsatish uchun — xato bo'lsa tarix javobsiz qaytadi.
   */
  private async withPaymentAcks(
    history: CashboxHistory[],
    isCourierRow: (row: CashboxHistory) => boolean = () => true,
  ): Promise<Array<CashboxHistory & { payment_ack?: string | null }>> {
    const isAckRow = (row: CashboxHistory) =>
      row.source_type === Source_type.COURIER_PAYMENT && isCourierRow(row);
    const ids = history.filter(isAckRow).map((row) => String(row.id));
    if (!ids.length) return history;
    try {
      const rows: Array<{ payment_id: string; ack: string }> =
        await this.historyRepo.query(
          `SELECT "payment_id"::text AS payment_id, "ack"
             FROM "finance_schema"."courier_payment_acks"
            WHERE "payment_id" = ANY($1::bigint[])`,
          [ids],
        );
      const acks = new Map(rows.map((row) => [row.payment_id, row.ack]));
      return history.map((row) =>
        isAckRow(row)
          ? { ...row, payment_ack: acks.get(String(row.id)) ?? null }
          : row,
      );
    } catch (error) {
      this.logger.warn(
        `kvitansiya javoblari olinmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
      return history;
    }
  }

  async myCashbox(data: {
    user_id: string;
    branch_id?: string | null;
    roles?: string[];
    cashbox_type?: Cashbox_type;
    fromDate?: string;
    toDate?: string;
    sourceTypes?: string;
    source_types?: string;
  }) {
    try {
      this.assertBigIntId(data.user_id, 'user_id');
      const roles = (data.roles ?? []).map((r) => r.toLowerCase());
      const isManager =
        roles.includes('manager') &&
        !roles.includes('superadmin') &&
        !roles.includes('admin');
      const cashboxType =
        data.cashbox_type ??
        (roles.includes('market')
          ? Cashbox_type.FOR_MARKET
          : isManager
            ? Cashbox_type.BRANCH
            : Cashbox_type.FOR_COURIER);
      const targetUserId =
        cashboxType === Cashbox_type.BRANCH
          ? String(data.branch_id ?? '').trim()
          : data.user_id;
      if (cashboxType === Cashbox_type.BRANCH && !targetUserId) {
        throw new BadRequestException('Manager uchun branch_id majburiy');
      }
      let cashbox = await this.cashboxRepo.findOne({
        where: {
          user_id: targetUserId,
          cashbox_type: cashboxType,
          isDeleted: false,
        },
        order: { createdAt: 'DESC' },
      });

      if (!cashbox) {
        const created = this.cashboxRepo.create({
          user_id: targetUserId,
          cashbox_type: cashboxType,
          balance: 0,
          balance_cash: 0,
          balance_card: 0,
        });
        cashbox = await this.cashboxRepo.save(created);
      }

      return this.getCashboxByUserId({
        id: targetUserId,
        cashbox_type: cashboxType,
        history_source_types: data.sourceTypes ?? data.source_types,
        fromDate: data.fromDate,
        toDate: data.toDate,
      });
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async spendMoney(data: {
    user_id: string;
    amount: number;
    type?: PaymentMethod;
    comment?: string;
    cashbox_type?: Cashbox_type;
    created_by?: string;
    dedup_epoch?: string;
    /** 3PE0B03q / Zv3MLn0a — MAIN yoki filial, `type=click`: qaysi kartadan. */
    card_id?: string;
    /**
     * Elchi Pochta №1 — kassa xarajati kategoriyasi (RMQ darajasida
     * ixtiyoriy: investor foyda to'lovi kabi ichki chiqimlar kategoriyasiz;
     * HTTP `PATCH /finance/cashbox/spend` DTO'sida 2026-10-22 dan MAJBURIY).
     * Berilsa mavjud va o'chirilmagan bo'lishi shart (aks holda 400); tarix
     * qatoriga id + nom snapshot'i yoziladi.
     */
    expense_category_id?: string;
    /**
     * IgR4FVsR — `true` bo'lsa chiqim P&L daftariga ham (−amount,
     * MANUAL_EXPENSE) AYNI tranzaksiyada yoziladi. Faqat gateway'ning qo'lda
     * chiqim marshruti yuboradi; investor to'lovi (o'zi FBH yozadi) va boshqa
     * tizim chaqiruvchilari yubormaydi — ikki marta yozilmaydi.
     */
    financial_ledger?: boolean;
    /** T3 — faqat gateway'ning qo'lda chiqimi: `{ kind: 'manual_expense' }`. */
    receipt_policy?: { kind?: unknown };
    receipt_id?: unknown;
  }) {
    try {
      const targetCashboxType = data.cashbox_type ?? Cashbox_type.MAIN;
      const targetUserId =
        targetCashboxType === Cashbox_type.MAIN
          ? FinanceServiceService.MAIN_CASHBOX_USER_ID
          : data.user_id;
      const receiptRequest = this.receiptRequest(data, 'manual_expense');
      // IgR4FVsR — P&L yozuvi faqat gateway'ning qo'lda marshrutidan.
      const ledger =
        data.financial_ledger === true
          ? {
              amount: -Number(data.amount),
              source_type: FinancialSource_type.MANUAL_EXPENSE,
              comment: data.comment ?? null,
            }
          : undefined;
      const update = await this.updateBalanceWithLedger(
        ledger,
        {
          user_id: targetUserId,
          amount: data.amount,
          operation_type: Operation_type.EXPENSE,
          source_type: Source_type.MANUAL_EXPENSE,
          payment_method: data.type ?? PaymentMethod.CASH,
          comment: data.comment,
          created_by: data.created_by ?? data.user_id,
          cashbox_type: targetCashboxType,
          // (i75GDixP) Qo'lda chiqim — manfiyga hech qachon ruxsat yo'q.
          allow_negative: false,
          // Idempotency for a manual expense is keyed on the gateway's dedup_epoch
          // token ONLY. source_id stays NULL — it is a bigint column and the token
          // is a free-form hex/idempotency-key string, so writing it there throws.
          // updateBalance's pre-check dedupes on the token (serialised by the
          // cashbox row lock). Absent token → no dedup (prior behaviour).
          dedup_epoch: data.dedup_epoch,
          // (QTCUUgjA) qo'lda operatsiya — kassada ochiq smena talab qilinadi.
          require_open_shift: true,
          // 3PE0B03q / Zv3MLn0a — karta (MAIN / filial + click; aks holda 400).
          ...(data.card_id ? { card_id: String(data.card_id) } : {}),
          // Elchi Pochta №1 — xarajat kategoriyasi (updateBalance tekshiradi).
          ...(data.expense_category_id
            ? { expense_category_id: String(data.expense_category_id) }
            : {}),
        },
        receiptRequest,
      );
      if (update?.data?.idempotent) {
        // (TMgL1zvq) Takroriy so'rov pul ham, audit ham qayta yozmaydi.
        return this.successRes(
          update.data,
          200,
          "Kassa chiqimi allaqachon bajarilgan (takroriy so'rov)",
        );
      }
      const linkedReceipt = (
        update?.data as { receipt?: LinkedReceiptRef | null } | undefined
      )?.receipt;
      const savedHistory = (
        update?.data as
          | {
              history?: Pick<
                CashboxHistory,
                'expense_category_id' | 'expense_category_name'
              >;
            }
          | undefined
      )?.history;
      const expenseCategory = savedHistory?.expense_category_id
        ? {
            id: String(savedHistory.expense_category_id),
            name: savedHistory.expense_category_name ?? null,
          }
        : null;
      await this.activityLog.log({
        entity_type: 'Cashbox',
        entity_id: String(update?.data?.cashbox?.id ?? targetUserId),
        action: 'finance.manual_expense',
        new_value: {
          amount: Number(data.amount),
          payment_method: data.type,
          ...(expenseCategory ? { expense_category: expenseCategory } : {}),
        },
        user_id: data.user_id ? String(data.user_id) : null,
        metadata: {
          user_id: data.user_id,
          amount: Number(data.amount),
          cashbox_type: targetCashboxType,
          ...(expenseCategory
            ? { expense_category_id: expenseCategory.id }
            : {}),
          // T3 — biriktirilgan chek (rasm/PII yo'q, faqat ID).
          ...(linkedReceipt ? { receipt_id: linkedReceipt.id } : {}),
        },
        // 2WRzdWpZ: izoh (comment) gapga KIRMAYDI — erkin matn. Kategoriya
        // nomi — superadmin boshqaradigan ro'yxatdan (PII emas).
        description: ActivityDescribeUz.cashboxExpense(
          data.amount,
          targetCashboxType,
          data.type ?? PaymentMethod.CASH,
          expenseCategory?.name,
        ),
      });
      return this.successRes(update?.data ?? {}, 200, 'Manual expense created');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async fillTheCashbox(data: {
    user_id: string;
    amount: number;
    type?: PaymentMethod;
    comment?: string;
    cashbox_type?: Cashbox_type;
    created_by?: string;
    dedup_epoch?: string;
    /** 3PE0B03q / Zv3MLn0a — MAIN yoki filial, `type=click`: qaysi kartaga. */
    card_id?: string;
    /**
     * IgR4FVsR — `true` bo'lsa kirim P&L daftariga ham (+amount,
     * MANUAL_INCOME) AYNI tranzaksiyada yoziladi. Faqat gateway'ning qo'lda
     * kirim marshruti yuboradi; kargo remittance'i (debitor qarz yig'imi —
     * foyda sotuvda allaqachon yozilgan) yubormaydi.
     */
    financial_ledger?: boolean;
  }) {
    try {
      const targetCashboxType = data.cashbox_type ?? Cashbox_type.MAIN;
      const targetUserId =
        targetCashboxType === Cashbox_type.MAIN
          ? FinanceServiceService.MAIN_CASHBOX_USER_ID
          : data.user_id;
      // IgR4FVsR — P&L yozuvi faqat gateway'ning qo'lda marshrutidan.
      const ledger =
        data.financial_ledger === true
          ? {
              amount: Number(data.amount),
              source_type: FinancialSource_type.MANUAL_INCOME,
              comment: data.comment ?? null,
            }
          : undefined;
      const update = await this.updateBalanceWithLedger(ledger, {
        user_id: targetUserId,
        amount: data.amount,
        operation_type: Operation_type.INCOME,
        source_type: Source_type.MANUAL_INCOME,
        payment_method: data.type ?? PaymentMethod.CASH,
        comment: data.comment,
        created_by: data.created_by ?? data.user_id,
        cashbox_type: targetCashboxType,
        // (i75GDixP) Qo'lda kirim — manfiy ruxsat yo'q.
        allow_negative: false,
        // Idempotency keyed on the dedup_epoch token only (see spendMoney) —
        // source_id stays NULL (bigint column can't hold the free-form token).
        dedup_epoch: data.dedup_epoch,
        // (QTCUUgjA) qo'lda operatsiya — kassada ochiq smena talab qilinadi.
        require_open_shift: true,
        // 3PE0B03q / Zv3MLn0a — karta (MAIN / filial + click; aks holda 400).
        ...(data.card_id ? { card_id: String(data.card_id) } : {}),
      });
      if (update?.data?.idempotent) {
        // (TMgL1zvq) Takroriy so'rov pul ham, audit ham qayta yozmaydi.
        return this.successRes(
          update.data,
          200,
          "Kassa kirimi allaqachon bajarilgan (takroriy so'rov)",
        );
      }
      await this.activityLog.log({
        entity_type: 'Cashbox',
        entity_id: String(update?.data?.cashbox?.id ?? targetUserId),
        action: 'finance.manual_income',
        new_value: { amount: Number(data.amount), payment_method: data.type },
        user_id: data.user_id ? String(data.user_id) : null,
        metadata: {
          user_id: data.user_id,
          amount: Number(data.amount),
          cashbox_type: targetCashboxType,
        },
        description: ActivityDescribeUz.cashboxIncome(
          data.amount,
          targetCashboxType,
          data.type ?? PaymentMethod.CASH,
        ),
      });
      return this.successRes(update?.data ?? {}, 200, 'Cashbox filled');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * Idempotency pre-check for a manual lump-sum transfer (courier/branch/market
   * payment). Returns true when this exact payment — keyed by the gateway's
   * per-request `dedup_epoch` token on the source-cashbox leg — has already been
   * applied (duplicate RMQ delivery or operator double-submit). The caller must
   * already hold the source cashbox row lock so it sees committed prior rows.
   * (Audit P0-3.) When no token is supplied the transfer is not deduped
   * (backward-compatible with callers that don't send one).
   */
  private async isDuplicateTransfer(
    manager: EntityManager,
    params: {
      cashbox_id: string;
      source_type: Source_type;
      source_id: string;
      operation_type: Operation_type;
      dedup_epoch: string;
    },
  ): Promise<boolean> {
    if (!params.dedup_epoch) {
      return false;
    }
    const existing = await manager.findOne(CashboxHistory, {
      where: {
        cashbox_id: String(params.cashbox_id),
        source_type: params.source_type,
        source_id: String(params.source_id),
        operation_type: params.operation_type,
        dedup_epoch: params.dedup_epoch,
      },
    });
    return !!existing;
  }

  /**
   * Enqueue the per-order FIFO settlement advance for a committed cash handover,
   * INSIDE the caller's cashbox transaction (Faza 2a). The transactional outbox
   * gives at-least-once, retried, DLQ-backed delivery to order-service, so the
   * order_settlement ledger always catches up with the cashbox movement —
   * replacing the old best-effort gateway call that silently swallowed any
   * failure (re-opening the cashbox↔settlement split-brain and blinding the
   * rollback guard). Idempotent: the shared per-payment `token` becomes the
   * request_id, so a redelivered outbox event is deduped by order-service's
   * runIdempotent and order_settlement is never advanced twice. (Audit I1/I2.)
   */
  private async enqueueSettlementAdvance(
    manager: EntityManager,
    level: 'courier_to_branch' | 'branch_to_hq' | 'hq_to_market',
    matchValue: string,
    amount: number,
    requesterId: string | null | undefined,
    token: string,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      level,
      match_value: String(matchValue ?? ''),
      amount: Number(amount ?? 0),
      requester_id: requesterId ? String(requesterId) : undefined,
    };
    // Bake the shared idempotency key into the payload so the in-tx outbox row
    // AND the post-commit immediate publish (Faza 2c) carry the SAME request_id
    // and order-service dedupes them — the advance runs exactly once.
    if (token) {
      payload.request_id = token;
    }
    await this.outbox.enqueue('ORDER', 'order.settlement.advance', payload, {
      manager,
      requestId: token || undefined,
    });
    return payload;
  }

  /**
   * Best-effort IMMEDIATE publish of the settlement advance, right after the
   * cashbox transaction commits (Faza 2c). Closes the ~1s outbox-poll lag window
   * during which order_settlement would otherwise be stale and the rollback
   * guard inaccurate (cash already moved up-chain, status not yet advanced). It
   * is purely a latency optimization: the outbox row enqueued in the committed
   * transaction is the durability guarantee, so a failure here is swallowed and
   * the relay delivers the same (idempotent, same request_id) event. Only fires
   * when an idempotency key is present, so the immediate send and the relay can
   * never double-advance.
   */
  private async tryPublishAdvanceNow(
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!payload?.request_id) {
      return;
    }
    try {
      const reply = await firstValueFrom(
        this.orderClient
          .send({ cmd: 'order.settlement.advance' }, payload)
          .pipe(timeout(2000)),
      );
      this.warnOnAdvanceLeftover(payload, reply);
      await this.recordAdvanceLeftover(payload, reply);
    } catch {
      // Swallowed — the transactional outbox relay guarantees eventual delivery.
    }
  }

  /**
   * znD3KaZL — tezkor yo'l: javobdagi qoldiq > 0 bo'lsa
   * `finance_settlement_unapplied` ga idempotent yozuv (`dedup_epoch` = to'lov
   * tokeni, ya'ni advance `request_id`).
   *
   * Sekin yo'l — order-service FIFO tranzaksiyasi ichida outbox orqali
   * yuboradigan `finance.settlement.unapplied_recorded` hodisasi
   * (`SettlementUnappliedService`): tezkor yo'l timeout bo'lsa yoki finance
   * shu yerda yiqilsa ham yozuv baribir paydo bo'ladi. Ikkalasi bitta kalit
   * bilan (`ON CONFLICT DO NOTHING`) — dublikat yo'q. Xato YUTILADI (pul
   * allaqachon commit bo'lgan, yozuvni sekin yo'l kafolatlaydi).
   */
  private async recordAdvanceLeftover(
    payload: Record<string, unknown>,
    reply: unknown,
  ): Promise<void> {
    if (!this.settlementUnapplied) {
      return;
    }
    const data = (reply as { data?: Record<string, unknown> } | null)?.data;
    const leftover = Number(data?.leftover ?? 0) || 0;
    if (!(leftover > 0)) {
      return;
    }
    try {
      await this.settlementUnapplied.record({
        level: payload.level,
        actor_id: payload.match_value,
        amount: leftover,
        dedup_epoch: payload.request_id,
      });
    } catch (error) {
      this.logger.warn(
        `finance_settlement_unapplied ga tezkor yo'lda yozib bo'lmadi (znD3KaZL) level=${String(payload.level)} match=${String(payload.match_value)} — order-service outbox hodisasi yozadi: ${(error as Error)?.message ?? error}`,
      );
    }
  }

  /**
   * znD3KaZL — advance javobidagi FIFO qoldig'i (`leftover`) endi o'qiladi.
   *
   * Ilgari javob butunlay tashlab yuborilardi: kassa 550 000 ni ko'chirsa,
   * daftar esa 300 000 ni yopsa, 250 000 lik farq finance logida hech
   * qachon ko'rinmasdi. Qoldiqning o'zi order-service'da, FIFO bilan bitta
   * tranzaksiyada `order_settlement_carry` ga yoziladi va keyingi to'lovga
   * qo'shiladi. Finance'dagi audit yozuvi (`finance_settlement_unapplied`)
   * — `recordAdvanceLeftover` (tezkor yo'l) va order-service outbox hodisasi
   * (sekin yo'l). Bu — kassa to'lovi bilan yonma-yon turadigan ko'rinish;
   * to'liq tafsilot (saqlandi / saqlanmadi) order-service logida. Hech
   * qachon xato otmaydi.
   */
  private warnOnAdvanceLeftover(
    payload: Record<string, unknown>,
    reply: unknown,
  ): void {
    const data = (reply as { data?: Record<string, unknown> } | null)?.data;
    const leftover = Number(data?.leftover ?? 0) || 0;
    if (!(leftover > 0)) {
      return;
    }
    const allocated = Number(data?.allocated ?? 0) || 0;
    this.logger.warn(
      `Settlement advance FIFO qoldig'i (znD3KaZL): level=${String(payload.level)} match=${String(payload.match_value)} amount=${Number(payload.amount ?? 0)} allocated=${allocated} leftover=${leftover} — butun buyurtmaga sig'magan naqd taqsimlanmagan qoldiqda (order_settlement_carry)`,
    );
  }

  /**
   * znD3KaZL — order-service yig'indisidagi `unapplied_carry` ni javob
   * shakliga keltiradi. Kalit yo'q (qoldiq yo'q yoki order-service eski
   * versiyada) — nollar.
   */
  private normalizeUnappliedCarry(raw: unknown) {
    const src = (raw ?? {}) as {
      total?: unknown;
      courier_to_branch?: unknown;
      branch_to_hq?: unknown;
      hq_to_market?: unknown;
      count?: unknown;
      items?: unknown;
    };
    const num = (value: unknown) => Number(value ?? 0) || 0;
    type RawItem = {
      level?: string | null;
      party_id?: string | number | null;
      branch_id?: string | number | null;
      amount?: unknown;
    } | null;
    const items = Array.isArray(src.items)
      ? (src.items as RawItem[]).map((item) => ({
          level: String(item?.level ?? ''),
          party_id: String(item?.party_id ?? ''),
          branch_id:
            item?.branch_id === null || item?.branch_id === undefined
              ? null
              : String(item.branch_id),
          amount: num(item?.amount),
        }))
      : [];
    return {
      total: num(src.total),
      courierToBranch: num(src.courier_to_branch),
      branchToHq: num(src.branch_to_hq),
      hqToMarket: num(src.hq_to_market),
      count: num(src.count) || items.length,
      items,
    };
  }

  async paymentsFromCourier(data: CourierPaymentInput) {
    // (2crjWf7v #3) Kvitansiyadagi "Qabul qildi: <xodim>" — tranzaksiyadan
    // OLDIN, qisqa muddat bilan; xato/timeout — umumiy so'z (pul amali kutmaydi).
    const acceptedByName = await this.userDisplayName(data.created_by);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    // Captured after a durable commit so the audit row is written once the
    // transaction is committed and the runner released (never inside the tx).
    let auditedCourierCashboxId: string | null = null;
    let auditedReceiptId: string | null = null;
    try {
      const receiptRequest = this.receiptRequest(data, 'courier_to_hq');
      const applied = await this.applyCourierPaymentInTx(
        queryRunner.manager,
        data,
        { notify: true, acceptedByName },
      );
      if (applied.idempotent) {
        // T3 — takror: asl to'lovning cheki (kuryer EXPENSE oyog'i orqali).
        const replayReceipt = receiptRequest
          ? await this.findCourierReplayReceipt(queryRunner.manager, data)
          : undefined;
        await queryRunner.commitTransaction();
        return this.successRes(
          {
            idempotent: true,
            ...(replayReceipt !== undefined ? { receipt: replayReceipt } : {}),
          },
          200,
          "To'lov allaqachon qabul qilingan (takroriy so'rov)",
        );
      }
      const {
        courierCashbox,
        receiverCashbox,
        clickMarketCashbox,
        advancePayload,
        marketAdvancePayload,
        dedupKey,
      } = applied;

      // T3 — chek: HQ (MAIN) INCOME + kuryer EXPENSE oyoqlari (`transfer_id`).
      // Faqat `click` da; naqd / click_to_market + chek → 400. Xato — rollback.
      const linkedReceipt = receiptRequest
        ? await this.linkTransferReceipt(queryRunner.manager, receiptRequest, {
            transfer_id: applied.transferId,
            receiver_cashbox_id: String(receiverCashbox.id),
            counter_cashbox_id: String(courierCashbox.id),
            amount: Number(data.amount),
            payment_method: data.payment_method,
            courier_id: String(data.courier_id),
          })
        : undefined;

      await queryRunner.commitTransaction();
      // Immediate best-effort publish to close the outbox-poll lag (Faza 2c).
      await this.tryPublishAdvanceNow(advancePayload);
      if (marketAdvancePayload) {
        await this.tryPublishAdvanceNow(marketAdvancePayload);
      }
      auditedCourierCashboxId = String(courierCashbox.id);
      auditedReceiptId = linkedReceipt?.id ?? null;

      if (clickMarketCashbox) {
        // Buyurtma holati sinxroni va hamkor xabari javobni KUTDIRMAYDI —
        // fonda (audit M2). Hamkor marketga bevosita o'tkazma ham hisob-kitob
        // to'lovi.
        void this.scheduleMarketPaymentFollowUp({
          market_id: String(data.market_id),
          amount: Number(data.amount),
          payment_date: data.payment_date,
          dedup_key: dedupKey,
        });
      }

      return this.successRes(
        {
          courier_cashbox: {
            id: courierCashbox.id,
            user_id: courierCashbox.user_id,
            cashbox_type: courierCashbox.cashbox_type,
            balance: courierCashbox.balance,
            balance_cash: courierCashbox.balance_cash,
            balance_card: courierCashbox.balance_card,
            updated_at: courierCashbox.updatedAt,
          },
          main_cashbox: {
            id: receiverCashbox.id,
            cashbox_type: receiverCashbox.cashbox_type,
            balance: receiverCashbox.balance,
            balance_cash: receiverCashbox.balance_cash,
            balance_card: receiverCashbox.balance_card,
            updated_at: receiverCashbox.updatedAt,
          },
          receiver_cashbox: {
            id: receiverCashbox.id,
            user_id: receiverCashbox.user_id,
            cashbox_type: receiverCashbox.cashbox_type,
            balance: receiverCashbox.balance,
            balance_cash: receiverCashbox.balance_cash,
            balance_card: receiverCashbox.balance_card,
            updated_at: receiverCashbox.updatedAt,
          },
          // T6 — to'lov oyoqlari kaliti (qaytarish / tahrirlash shu bilan).
          transfer_id: applied.transferId,
          // T3 — `receipt_policy` bo'lsa: chek yoki null.
          ...(linkedReceipt !== undefined ? { receipt: linkedReceipt } : {}),
        },
        201,
        "To'lov qabul qilindi !!! ",
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.toRpcError(error);
    } finally {
      await queryRunner.release();
      if (auditedCourierCashboxId) {
        await this.activityLog.log({
          entity_type: 'Cashbox',
          entity_id: auditedCourierCashboxId,
          action: ActivityAction.PAYMENT,
          new_value: {
            amount: Number(data.amount),
            payment_method: data.payment_method,
          },
          user_id: data.created_by ? String(data.created_by) : null,
          metadata: {
            courier_id: data.courier_id,
            market_id: data.market_id ?? null,
            amount: Number(data.amount),
            created_by: data.created_by ?? null,
            receiver_user_id:
              data.receiver_user_id ??
              FinanceServiceService.MAIN_CASHBOX_USER_ID,
            ...(auditedReceiptId ? { receipt_id: auditedReceiptId } : {}),
          },
          description: ActivityDescribeUz.courierPayment(
            data.courier_id,
            data.amount,
            data.payment_method,
          ),
        });
      }
    }
  }

  /**
   * T6 — kuryerdan pul qabul qilishning PUL QISMI chaqiruvchining
   * tranzaksiyasida (`manager`). `paymentsFromCourier` (oddiy to'lov) va
   * to'lov summasini tuzatish (`PaymentCorrectionService`: teskari qatorlardan
   * keyin yangi summa bilan, AYNI tranzaksiyada) ishlatadi.
   *
   * Barcha oyoqlar bitta `transfer_id` bilan yoziladi. Commit, tezkor
   * publish, fon ishlari va audit — chaqiruvchida.
   *
   * `opts.notify` — `finance.payment_received` (kvitansiya). Tuzatishda YO'Q
   * (tomonlarga `finance.payment_corrected` boradi).
   * `opts.skipShiftGate` — smena tekshiruvini chaqiruvchi o'zi (kod bilan)
   * qilgan bo'lsa.
   */
  async applyCourierPaymentInTx(
    manager: EntityManager,
    data: CourierPaymentInput,
    opts: {
      notify: boolean;
      acceptedByName?: string | null;
      transferId?: string;
      skipShiftGate?: boolean;
    },
  ): Promise<
    | { idempotent: true }
    | {
        idempotent: false;
        transferId: string;
        dedupKey: string;
        courierCashbox: Cashbox;
        receiverCashbox: Cashbox;
        clickMarketCashbox: Cashbox | null;
        courierHistory: CashboxHistory;
        advancePayload: Record<string, unknown>;
        marketAdvancePayload: Record<string, unknown> | null;
      }
  > {
    this.assertBigIntId(data.courier_id, 'courier_id');
    this.assertPositiveAmount(Number(data.amount));
    const isClickToMarket =
      data.payment_method === PaymentMethod.CLICK_TO_MARKET;
    if (isClickToMarket && !data.market_id) {
      throw new BadRequestException(
        "Click_to_market usulida market_id bo'lishi shart va majburiy !!!",
      );
    }
    /**
     * ⚠️ AUDIT M4. "Marketga o'tkazma" filial kassasi orqali TAQIQLANADI.
     *
     * Menejer yo'lida qabul qiluvchi — filial kassasi: unga +X, darhol −X
     * (MARKET_PAYMENT) yozilardi, market kassasi esa −X. Ledger'da faqat
     * `courier_to_branch` siljirdi — kuryer qatorlari COURIER_SETTLED
     * ("pul filialda, HQ'ga qarz") bo'lardi, filial kassasi esa 0. Natijada
     * abadiy soxta filial qarzi paydo bo'lardi (filial → HQ "Insufficient
     * cash balance" bilan to'xtardi) va kompaniya holati X ga oshib
     * ko'rinardi. Bu usul faqat HQ (MAIN) kassasi orqali qoladi.
     */
    if (
      isClickToMarket &&
      (data.receiver_cashbox_type ?? Cashbox_type.MAIN) === Cashbox_type.BRANCH
    ) {
      throw new BadRequestException(
        "Marketga o'tkazma (click_to_market) faqat HQ kassasi orqali qabul qilinadi — filial kassasi bu usulda qabul qila olmaydi",
      );
    }

    // Lock order: courier → main → market. Same order in paymentsToMarket
    // and updateBalance to avoid deadlocks across concurrent payments.
    const courierCashbox = await manager.findOne(Cashbox, {
      where: {
        user_id: data.courier_id,
        cashbox_type: Cashbox_type.FOR_COURIER,
        isDeleted: false,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!courierCashbox)
      throw new NotFoundException('Courier cashbox not found');

    // Idempotency: under the courier-cashbox lock, bail out if this exact
    // payment was already applied (duplicate delivery / double-submit).
    const dedupKey = String(data.dedup_epoch ?? '').trim();
    const paymentSourceId = dedupKey ? String(data.courier_id) : null;
    if (
      await this.isDuplicateTransfer(manager, {
        cashbox_id: String(courierCashbox.id),
        source_type: Source_type.COURIER_PAYMENT,
        source_id: String(data.courier_id),
        operation_type: Operation_type.EXPENSE,
        dedup_epoch: dedupKey,
      })
    ) {
      return { idempotent: true };
    }

    // (QTCUUgjA) Qabul qiluvchi kassada ochiq smena (darvoza yoqilgan
    // bo'lsa; MAIN — `main`/`all`, menejer yo'lida filial kassasi — faqat
    // `all`, R6). Idempotentlikdan KEYIN — haqiqiy takroriy so'rov baribir
    // `idempotent` javob oladi.
    if (!opts.skipShiftGate) {
      await this.requireOpenShift(manager, {
        user_id: String(
          data.receiver_user_id ?? FinanceServiceService.MAIN_CASHBOX_USER_ID,
        ),
        cashbox_type: data.receiver_cashbox_type ?? Cashbox_type.MAIN,
      });
    }

    // Over-remit guard (Faza 1c / Audit I1): a courier cannot remit more cash
    // than their cashbox holds. FOR_COURIER allows a negative balance (so
    // sale-time COD legs work), which means a duplicate-key-evading double
    // submit, or a wrong amount, would otherwise silently drive the courier
    // cashbox negative — cash that never physically existed. We check AFTER the
    // idempotency short-circuit so a genuine retry still returns idempotent.
    // 1bz6tOle: kuryer kassasi qarz hisobi (naqd/karta ajratmasi yo'q) —
    // shuning uchun qo'riqchi usuldan qat'i nazar JAMI `balance` bilan;
    // qabul qiluvchi MAIN/BRANCH kassasi esa updateBalancesByMethod'da usul
    // bo'yicha tekshiriladi.
    if (Number(data.amount) > Number(courierCashbox.balance)) {
      throw new BadRequestException(
        `To'lov miqdori courier qoldig'idan oshib ketdi (qoldiq: ${Number(
          courierCashbox.balance,
        )})`,
      );
    }

    const receiverUserId = String(
      data.receiver_user_id ?? FinanceServiceService.MAIN_CASHBOX_USER_ID,
    );
    const receiverCashboxType = data.receiver_cashbox_type ?? Cashbox_type.MAIN;

    let receiverCashbox = await manager.findOne(Cashbox, {
      where: {
        user_id: receiverUserId,
        cashbox_type: receiverCashboxType,
        isDeleted: false,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!receiverCashbox) {
      receiverCashbox = await manager.save(
        manager.create(Cashbox, {
          user_id: receiverUserId,
          cashbox_type: receiverCashboxType,
          balance: 0,
          balance_cash: 0,
          balance_card: 0,
        }),
      );
    }

    /**
     * Marketga o'tkazmada market kassasi ham shu yerda qulflanadi (tartib:
     * courier → main → market) va pul ko'chishidan OLDIN tekshiriladi
     * (audit M4): to'lov marketga qarzdan oshmasin — `paymentsToMarket`
     * dagi qo'riqchi bilan bir xil. Ilgari tekshiruv yo'q edi va noto'g'ri
     * tanlangan market kassasi jimgina manfiyga ketardi.
     */
    let clickMarketCashbox: Cashbox | null = null;
    if (isClickToMarket) {
      clickMarketCashbox = await manager.findOne(Cashbox, {
        where: {
          user_id: data.market_id,
          cashbox_type: Cashbox_type.FOR_MARKET,
          // gEdrZxMz — o'chirilgan (soft-delete) market kassasi tanlanmasin.
          isDeleted: false,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!clickMarketCashbox)
        throw new NotFoundException('Market cashbox topilmadi');
      const marketPayable = Number(clickMarketCashbox.balance ?? 0);
      if (Number(data.amount) > marketPayable) {
        throw new BadRequestException(
          `To'lov miqdori marketga qarzdan oshib ketdi (qarz: ${marketPayable})`,
        );
      }
    }

    const transferId = opts.transferId ?? randomUUID();

    this.updateBalancesByMethod(
      courierCashbox,
      Number(data.amount),
      Operation_type.EXPENSE,
      data.payment_method ?? PaymentMethod.CASH,
    );
    await manager.save(courierCashbox);

    const courierHistory = manager.create(CashboxHistory, {
      operation_type: Operation_type.EXPENSE,
      cashbox_id: courierCashbox.id,
      source_type: Source_type.COURIER_PAYMENT,
      source_id: paymentSourceId,
      dedup_epoch: dedupKey,
      transfer_id: transferId,
      amount: Number(data.amount),
      balance_after: courierCashbox.balance,
      balance_cash_after: courierCashbox.balance_cash,
      balance_card_after: courierCashbox.balance_card,
      comment: data.comment ?? null,
      created_by: data.created_by ?? null,
      payment_date: this.parseDate(data.payment_date ?? null) ?? null,
      payment_method: data.payment_method,
      source_user_id: data.courier_id,
    });
    const savedCourierHistory = await manager.save(courierHistory);

    this.updateBalancesByMethod(
      receiverCashbox,
      Number(data.amount),
      Operation_type.INCOME,
      data.payment_method ?? PaymentMethod.CASH,
    );
    // Zv3MLn0a — qabul qiluvchi kassaning tanlangan kartasi (kassa qulfi
    // ostida; faqat click; boshqa kassa kartasi 403).
    const receiverCardId = await applyCashboxCardSelection(
      manager,
      receiverCashbox,
      {
        card_id: data.card_id ?? null,
        operation: Operation_type.INCOME,
        amount: Number(data.amount),
        payment_method: data.payment_method ?? PaymentMethod.CASH,
      },
    );
    await manager.save(receiverCashbox);

    const receiverHistory = manager.create(CashboxHistory, {
      operation_type: Operation_type.INCOME,
      cashbox_id: receiverCashbox.id,
      card_id: receiverCardId,
      source_type: Source_type.COURIER_PAYMENT,
      transfer_id: transferId,
      amount: Number(data.amount),
      balance_after: receiverCashbox.balance,
      balance_cash_after: receiverCashbox.balance_cash,
      balance_card_after: receiverCashbox.balance_card,
      comment: data.comment ?? null,
      created_by: data.created_by ?? null,
      payment_date: this.parseDate(data.payment_date ?? null) ?? null,
      payment_method: data.payment_method,
      source_user_id: data.courier_id,
    });
    await manager.save(receiverHistory);

    // (ePpLHPX2) Marketga o'tkazmada market kassasi tarix qatori — market
    // bildirishnomasidagi to'lov raqami.
    let clickMarketHistory: CashboxHistory | null = null;
    if (clickMarketCashbox) {
      const marketCashbox = clickMarketCashbox;

      this.updateBalancesByMethod(
        receiverCashbox,
        Number(data.amount),
        Operation_type.EXPENSE,
        data.payment_method,
      );
      await manager.save(receiverCashbox);
      await manager.save(
        manager.create(CashboxHistory, {
          operation_type: Operation_type.EXPENSE,
          cashbox_id: receiverCashbox.id,
          source_type: Source_type.MARKET_PAYMENT,
          transfer_id: transferId,
          amount: Number(data.amount),
          balance_after: receiverCashbox.balance,
          balance_cash_after: receiverCashbox.balance_cash,
          balance_card_after: receiverCashbox.balance_card,
          comment: data.comment ?? null,
          created_by: data.created_by ?? null,
          payment_date: this.parseDate(data.payment_date ?? null) ?? null,
          payment_method: data.payment_method,
          source_user_id: data.market_id,
        }),
      );

      this.updateBalancesByMethod(
        marketCashbox,
        Number(data.amount),
        Operation_type.EXPENSE,
        data.payment_method,
      );
      await manager.save(marketCashbox);
      clickMarketHistory = await manager.save(
        manager.create(CashboxHistory, {
          operation_type: Operation_type.EXPENSE,
          cashbox_id: marketCashbox.id,
          source_type: Source_type.MARKET_PAYMENT,
          transfer_id: transferId,
          amount: Number(data.amount),
          balance_after: marketCashbox.balance,
          balance_cash_after: marketCashbox.balance_cash,
          balance_card_after: marketCashbox.balance_card,
          comment: data.comment ?? null,
          created_by: data.created_by ?? null,
          payment_date: this.parseDate(data.payment_date ?? null) ?? null,
          payment_method: data.payment_method,
          source_user_id: data.market_id,
        }),
      );
    }

    // Advance the per-order FIFO settlement ledger (courier → branch) in the
    // SAME transaction as the cashbox move (Faza 2a). Reliable outbox delivery
    // to order-service replaces the old best-effort gateway bridge.
    const advancePayload = await this.enqueueSettlementAdvance(
      manager,
      'courier_to_branch',
      String(data.courier_id),
      Number(data.amount),
      data.created_by,
      dedupKey,
    );
    /**
     * Marketga o'tkazma — market bo'g'ini ham yopiladi (audit M4): ayni
     * tranzaksiyada `hq_to_market` siljishi navbatga qo'yiladi. Ilgari
     * faqat `courier_to_branch` siljirdi va market qatorlari hech qachon
     * MARKET_SETTLED bo'lmasdi (db-reconcile marketni −X deb ko'rsatardi).
     * Token alohida (`:m`) — order-service ikki siljishni bir-biridan
     * farqlab dedup qiladi; token bo'lmasa dedup ham yo'q (avvalgidek).
     */
    const marketAdvancePayload = clickMarketCashbox
      ? await this.enqueueSettlementAdvance(
          manager,
          'hq_to_market',
          String(data.market_id),
          Number(data.amount),
          data.created_by,
          dedupKey ? `${dedupKey}:m` : '',
        )
      : null;

    if (opts.notify) {
      // (ePpLHPX2) `finance.payment_received` — puli ketgan tomon (kuryer:
      // topshirgani qabul qilindi) va o'tkazmada puli kelgan tomon (market).
      // Faqat outbox, AYNAN shu tranzaksiyada (oxirgi qadam — oldingi har
      // qanday xato bildirishnomani ham yozdirmaydi).
      await this.financeNotifications?.paymentReceived(
        {
          kind: 'courier_payment',
          recipient_id: data.courier_id,
          payment_id: savedCourierHistory?.id,
          amount: Number(data.amount),
          payment_method: data.payment_method,
          // (2crjWf7v #3) kvitansiya: kim qabul qildi, kuryerda qolgan naqd.
          balance_after: savedCourierHistory?.balance_after ?? null,
          payment_date: data.payment_date ?? null,
          accepted_by_name: opts.acceptedByName ?? null,
        },
        manager,
      );
      if (clickMarketCashbox) {
        await this.financeNotifications?.paymentReceived(
          {
            kind: 'market_payment',
            recipient_id: data.market_id,
            payment_id: clickMarketHistory?.id,
            amount: Number(data.amount),
            payment_method: data.payment_method,
            balance_after: clickMarketHistory?.balance_after ?? null,
            payment_date: data.payment_date ?? null,
          },
          manager,
        );
      }
    }

    return {
      idempotent: false,
      transferId,
      dedupKey,
      courierCashbox,
      receiverCashbox,
      clickMarketCashbox,
      courierHistory: savedCourierHistory,
      advancePayload,
      marketAdvancePayload,
    };
  }

  /**
   * (3PE0B03q) "O'tkazma manbasi" (`transfer_source_user_id`) — faqat audit.
   * Naqd to'lovda ma'nosi yo'q (o'tkazma emas) — yozilmaydi. Shaxs bo'yicha
   * karta qoldig'i tushunchasi YO'Q: pul baribir kassaning yagona
   * `balance_card` idan harakatlanadi.
   */
  private resolveTransferSourceUserId(data: {
    payment_method?: PaymentMethod;
    transfer_source_user_id?: string | null;
  }): string | null {
    const raw = data.transfer_source_user_id;
    if (raw == null || String(raw).trim() === '') {
      return null;
    }
    this.assertBigIntId(String(raw), 'source_user_id');
    if ((data.payment_method ?? PaymentMethod.CASH) === PaymentMethod.CASH) {
      return null;
    }
    return String(raw);
  }

  async paymentFromBranchToMain(data: {
    branch_id: string;
    amount: number;
    payment_method: PaymentMethod;
    payment_date?: string;
    comment?: string;
    created_by?: string;
    // Per-request idempotency token from the gateway. (Audit P0-3.)
    dedup_epoch?: string;
    // (3PE0B03q) "O'tkazma manbasi" — faqat audit.
    transfer_source_user_id?: string;
    // 3PE0B03q — CLICK pul MAIN kassaning qaysi nomli kartasiga tushdi.
    card_id?: string;
    // Zv3MLn0a — CLICK pul FILIAL kassasining qaysi kartasidan chiqdi.
    branch_card_id?: string;
    /** T3 — gateway: `{ kind: 'branch_to_hq' }`. */
    receipt_policy?: { kind?: unknown };
    receipt_id?: unknown;
  }) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    // Captured after a durable commit so the audit row is written once the
    // transaction is committed and the runner released (never inside the tx).
    let auditedBranchCashboxId: string | null = null;
    let auditedReceiptId: string | null = null;
    const receiptRequest = this.receiptRequest(data, 'branch_to_hq');
    try {
      this.assertBigIntId(data.branch_id, 'branch_id');
      this.assertPositiveAmount(Number(data.amount));
      const transferSourceUserId = this.resolveTransferSourceUserId(data);

      const branchCashbox = await queryRunner.manager.findOne(Cashbox, {
        where: { user_id: data.branch_id, cashbox_type: Cashbox_type.BRANCH },
        lock: { mode: 'pessimistic_write' },
      });
      if (!branchCashbox)
        throw new NotFoundException('Branch cashbox not found');

      // Idempotency: under the branch-cashbox lock, bail out if already applied.
      const dedupKey = String(data.dedup_epoch ?? '').trim();
      const paymentSourceId = dedupKey ? String(data.branch_id) : null;
      if (
        await this.isDuplicateTransfer(queryRunner.manager, {
          cashbox_id: String(branchCashbox.id),
          source_type: Source_type.BRANCH_TO_MAIN,
          source_id: String(data.branch_id),
          operation_type: Operation_type.EXPENSE,
          dedup_epoch: dedupKey,
        })
      ) {
        // T3 — takror: asl to'lovning cheki (filial EXPENSE oyog'i orqali).
        let replayReceipt: LinkedReceiptRef | null | undefined;
        if (receiptRequest && this.receipts) {
          const leg = await this.findDedupLeg(queryRunner.manager, {
            cashbox_id: String(branchCashbox.id),
            source_type: Source_type.BRANCH_TO_MAIN,
            source_id: String(data.branch_id),
            dedup_epoch: dedupKey,
          });
          replayReceipt = leg
            ? await this.receipts.findForReplay(queryRunner.manager, {
                counter_history_id: String(leg.id),
              })
            : null;
        }
        await queryRunner.commitTransaction();
        return this.successRes(
          {
            idempotent: true,
            ...(replayReceipt !== undefined ? { receipt: replayReceipt } : {}),
          },
          200,
          "To'lov allaqachon qabul qilingan (takroriy so'rov)",
        );
      }

      // (QTCUUgjA) Pul filial kassasidan CHIQADI (R6: `all` qamrovida filial
      // smenasi shart — chiqim filial smenasi hisobotidan tashqarida
      // qolmasin) va HQ (MAIN) kassasiga tushadi — u yerda ham ochiq smena
      // bo'lishi shart (darvoza yoqilgan bo'lsa).
      await this.requireOpenShift(queryRunner.manager, {
        user_id: String(data.branch_id),
        cashbox_type: Cashbox_type.BRANCH,
      });
      await this.requireOpenShift(queryRunner.manager, {
        user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
      });

      let mainCashbox = await queryRunner.manager.findOne(Cashbox, {
        where: {
          user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
          cashbox_type: Cashbox_type.MAIN,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!mainCashbox) {
        mainCashbox = await queryRunner.manager.save(
          queryRunner.manager.create(Cashbox, {
            user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
            cashbox_type: Cashbox_type.MAIN,
            balance: 0,
            balance_cash: 0,
            balance_card: 0,
          }),
        );
      }

      this.updateBalancesByMethod(
        branchCashbox,
        Number(data.amount),
        Operation_type.EXPENSE,
        data.payment_method ?? PaymentMethod.CASH,
      );
      // Zv3MLn0a — filial oyog'i: tanlangan filial kartasidan (yo'q — Asosiy).
      const branchCardId = await applyCashboxCardSelection(
        queryRunner.manager,
        branchCashbox,
        {
          card_id: data.branch_card_id ?? null,
          operation: Operation_type.EXPENSE,
          amount: Number(data.amount),
          payment_method: data.payment_method ?? PaymentMethod.CASH,
        },
      );
      await queryRunner.manager.save(branchCashbox);

      const branchHistory = queryRunner.manager.create(CashboxHistory, {
        operation_type: Operation_type.EXPENSE,
        cashbox_id: branchCashbox.id,
        card_id: branchCardId,
        source_type: Source_type.BRANCH_TO_MAIN,
        source_id: paymentSourceId,
        dedup_epoch: dedupKey,
        amount: Number(data.amount),
        balance_after: branchCashbox.balance,
        balance_cash_after: branchCashbox.balance_cash,
        balance_card_after: branchCashbox.balance_card,
        payment_method: data.payment_method ?? PaymentMethod.CASH,
        comment: data.comment ?? null,
        created_by: data.created_by ?? null,
        source_user_id: data.branch_id,
        transfer_source_user_id: transferSourceUserId,
        payment_date: this.parseDate(data.payment_date ?? null) ?? null,
      });
      await queryRunner.manager.save(branchHistory);

      this.updateBalancesByMethod(
        mainCashbox,
        Number(data.amount),
        Operation_type.INCOME,
        data.payment_method ?? PaymentMethod.CASH,
      );
      const mainCardId = await applyCashboxCardSelection(
        queryRunner.manager,
        mainCashbox,
        {
          card_id: data.card_id ?? null,
          operation: Operation_type.INCOME,
          amount: Number(data.amount),
          payment_method: data.payment_method ?? PaymentMethod.CASH,
        },
      );
      await queryRunner.manager.save(mainCashbox);

      const mainHistory = queryRunner.manager.create(CashboxHistory, {
        operation_type: Operation_type.INCOME,
        cashbox_id: mainCashbox.id,
        card_id: mainCardId,
        source_type: Source_type.BRANCH_TO_MAIN,
        amount: Number(data.amount),
        balance_after: mainCashbox.balance,
        balance_cash_after: mainCashbox.balance_cash,
        balance_card_after: mainCashbox.balance_card,
        payment_method: data.payment_method ?? PaymentMethod.CASH,
        comment: data.comment ?? null,
        created_by: data.created_by ?? null,
        source_user_id: data.branch_id,
        transfer_source_user_id: transferSourceUserId,
        payment_date: this.parseDate(data.payment_date ?? null) ?? null,
      });
      await queryRunner.manager.save(mainHistory);

      // T3 — chek: MAIN INCOME + filial EXPENSE (ikkalasi qo'lda — shu yerda).
      // Faqat `click` da; naqd + chek → 400. Xato — butun to'lov rollback.
      const linkedReceipt =
        receiptRequest && this.receipts
          ? await this.receipts.linkInTx(queryRunner.manager, receiptRequest, {
              applicable:
                (data.payment_method ?? PaymentMethod.CASH) ===
                PaymentMethod.CLICK,
              history_id: String(mainHistory.id),
              counter_history_id: String(branchHistory.id),
              entered_amount: Number(data.amount),
              payment_method: String(data.payment_method ?? PaymentMethod.CASH),
              card_id: mainCardId ? String(mainCardId) : null,
              branch_id: String(data.branch_id),
            })
          : undefined;

      // Advance the per-order FIFO settlement ledger (branch → HQ) in the SAME
      // transaction as the cashbox move (Faza 2a). Reliable outbox delivery to
      // order-service replaces the old best-effort gateway bridge.
      const advancePayload = await this.enqueueSettlementAdvance(
        queryRunner.manager,
        'branch_to_hq',
        String(data.branch_id),
        Number(data.amount),
        data.created_by,
        dedupKey,
      );

      await queryRunner.commitTransaction();
      // Immediate best-effort publish to close the outbox-poll lag (Faza 2c).
      await this.tryPublishAdvanceNow(advancePayload);
      auditedBranchCashboxId = String(branchCashbox.id);
      auditedReceiptId = linkedReceipt?.id ?? null;
      return this.successRes(
        {
          branch_cashbox: branchCashbox,
          main_cashbox: mainCashbox,
          // T3 — `receipt_policy` bo'lsa: chek yoki null.
          ...(linkedReceipt !== undefined ? { receipt: linkedReceipt } : {}),
        },
        200,
        'Branch to main payment successful',
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.toRpcError(error);
    } finally {
      await queryRunner.release();
      if (auditedBranchCashboxId) {
        await this.activityLog.log({
          entity_type: 'Cashbox',
          entity_id: auditedBranchCashboxId,
          action: ActivityAction.PAYMENT,
          new_value: {
            amount: Number(data.amount),
            payment_method: data.payment_method,
          },
          user_id: data.created_by ? String(data.created_by) : null,
          metadata: {
            branch_id: data.branch_id,
            amount: Number(data.amount),
            created_by: data.created_by ?? null,
            ...(auditedReceiptId ? { receipt_id: auditedReceiptId } : {}),
          },
          description: ActivityDescribeUz.branchToMainPayment(
            data.branch_id,
            data.amount,
            data.payment_method,
          ),
        });
      }
    }
  }

  async paymentsToMarket(data: MarketPaymentInput) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    // Captured after a durable commit so the audit row is written once the
    // transaction is committed and the runner released (never inside the tx).
    let auditedMarketCashboxId: string | null = null;
    try {
      const applied = await this.applyMarketPaymentInTx(
        queryRunner.manager,
        data,
        { notify: true },
      );
      if (applied.idempotent) {
        await queryRunner.commitTransaction();
        return this.successRes(
          { idempotent: true },
          200,
          "To'lov allaqachon bajarilgan (takroriy so'rov)",
        );
      }
      const { marketCashbox, advancePayload, dedupKey } = applied;

      await queryRunner.commitTransaction();
      // Immediate best-effort publish to close the outbox-poll lag (Faza 2c).
      // 2 s bilan cheklangan — gateway'ning 8 s chegarasidan ancha kichik.
      await this.tryPublishAdvanceNow(advancePayload);
      auditedMarketCashboxId = String(marketCashbox.id);
      /**
       * ⚠️ AUDIT M2. Buyurtma holati sinxroni va hamkor webhooki (agar market
       * hamkorniki bo'lsa) endi FONDA — javob ularni kutmaydi. Ilgari ~100
       * buyurtmali marketda javob gateway'ning 8 s chegarasidan oshardi: pul
       * ko'chgan bo'lsa ham admin 504 ko'rib, qayta bosardi. Ikkalasi ham
       * best-effort (pul harakati allaqachon commit bo'lgan).
       */
      void this.scheduleMarketPaymentFollowUp({
        market_id: String(data.market_id),
        amount: Number(data.amount),
        payment_date: data.payment_date,
        dedup_key: dedupKey,
      });

      return this.successRes(
        { transfer_id: applied.transferId },
        200,
        `Marketga ${data.amount} so'm to'landi`,
      );
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.toRpcError(error);
    } finally {
      await queryRunner.release();
      if (auditedMarketCashboxId) {
        await this.activityLog.log({
          entity_type: 'Cashbox',
          entity_id: auditedMarketCashboxId,
          action: ActivityAction.PAYMENT,
          new_value: {
            amount: Number(data.amount),
            payment_method: data.payment_method,
          },
          user_id: data.created_by ? String(data.created_by) : null,
          metadata: {
            market_id: data.market_id,
            amount: Number(data.amount),
            created_by: data.created_by ?? null,
          },
          description: ActivityDescribeUz.marketPayment(
            data.market_id,
            data.amount,
            data.payment_method,
          ),
        });
      }
    }
  }

  /**
   * T6 — marketga to'lovning PUL QISMI chaqiruvchining tranzaksiyasida
   * (`applyCourierPaymentInTx` bilan bir xil naqsh). Ikkala oyoq bitta
   * `transfer_id` bilan. `opts.notify` — `finance.payment_received`
   * (tuzatishda yo'q).
   */
  async applyMarketPaymentInTx(
    manager: EntityManager,
    data: MarketPaymentInput,
    opts: { notify: boolean; transferId?: string; skipShiftGate?: boolean },
  ): Promise<
    | { idempotent: true }
    | {
        idempotent: false;
        transferId: string;
        dedupKey: string;
        mainCashbox: Cashbox;
        marketCashbox: Cashbox;
        marketHistory: CashboxHistory;
        advancePayload: Record<string, unknown>;
      }
  > {
    this.assertBigIntId(data.market_id, 'market_id');
    this.assertPositiveAmount(Number(data.amount));
    const transferSourceUserId = this.resolveTransferSourceUserId(data);

    // Lock order: main → market (same order as paymentsFromCourier to avoid
    // cross-method deadlocks).
    const mainCashbox = await manager.findOne(Cashbox, {
      where: {
        user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!mainCashbox) throw new NotFoundException('Main cashbox not found');

    const marketCashbox = await manager.findOne(Cashbox, {
      where: {
        user_id: data.market_id,
        cashbox_type: Cashbox_type.FOR_MARKET,
      },
      lock: { mode: 'pessimistic_write' },
    });
    if (!marketCashbox) throw new NotFoundException('Market cashbox not found');

    // Idempotency: under the main+market cashbox locks, bail out if already
    // applied (duplicate delivery / double-submit). (Audit P0-3.)
    const dedupKey = String(data.dedup_epoch ?? '').trim();
    const paymentSourceId = dedupKey ? String(data.market_id) : null;
    if (
      await this.isDuplicateTransfer(manager, {
        cashbox_id: String(mainCashbox.id),
        source_type: Source_type.MARKET_PAYMENT,
        source_id: String(data.market_id),
        operation_type: Operation_type.EXPENSE,
        dedup_epoch: dedupKey,
      })
    ) {
      return { idempotent: true };
    }

    // (QTCUUgjA) Pul MAIN kassadan chiqadi — ochiq smena shart (darvoza
    // yoqilgan bo'lsa). Idempotentlikdan KEYIN.
    if (!opts.skipShiftGate) {
      await this.requireOpenShift(manager, {
        user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
        cashbox_type: Cashbox_type.MAIN,
      });
    }

    /**
     * ORTIQCHA TO'LOV QO'RIQCHISI (audit M9).
     *
     * Kuryerdan pul qabul qilishda bunday tekshiruv bor edi
     * (`paymentsFromCourier`), marketga to'lashda esa yo'q: operator xato
     * raqam kiritsa market kassasi jimgina manfiyga ketardi (FOR_MARKET
     * manfiy balansga ruxsat beradi), ya'ni "market bizga qarzdor" degan
     * soxta holat paydo bo'lardi va uni hech narsa ko'rsatmasdi.
     *
     * Tekshiruv idempotentlik qisqa tutashuvidan KEYIN turadi, shunda
     * haqiqiy takroriy so'rov baribir `idempotent` javobini oladi.
     */
    const marketPayable = Number(marketCashbox.balance ?? 0);
    if (Number(data.amount) > marketPayable) {
      throw new BadRequestException(
        `To'lov miqdori marketga qarzdan oshib ketdi (qarz: ${marketPayable})`,
      );
    }

    const transferId = opts.transferId ?? randomUUID();

    this.updateBalancesByMethod(
      mainCashbox,
      Number(data.amount),
      Operation_type.EXPENSE,
      data.payment_method ?? PaymentMethod.CASH,
    );
    const mainCardId = await applyCashboxCardSelection(manager, mainCashbox, {
      card_id: data.card_id ?? null,
      operation: Operation_type.EXPENSE,
      amount: Number(data.amount),
      payment_method: data.payment_method ?? PaymentMethod.CASH,
    });
    await manager.save(mainCashbox);
    await manager.save(
      manager.create(CashboxHistory, {
        operation_type: Operation_type.EXPENSE,
        cashbox_id: mainCashbox.id,
        card_id: mainCardId,
        source_type: Source_type.MARKET_PAYMENT,
        source_id: paymentSourceId,
        dedup_epoch: dedupKey,
        transfer_id: transferId,
        amount: Number(data.amount),
        balance_after: mainCashbox.balance,
        balance_cash_after: mainCashbox.balance_cash,
        balance_card_after: mainCashbox.balance_card,
        comment: data.comment ?? null,
        created_by: data.created_by ?? null,
        payment_date: this.parseDate(data.payment_date ?? null) ?? null,
        payment_method: data.payment_method,
        source_user_id: data.market_id,
        transfer_source_user_id: transferSourceUserId,
      }),
    );

    // The FOR_MARKET cashbox balance is HQ's PAYABLE to the market (money HQ
    // owes them): a sale ACCRUES it (+income, order-lifecycle sell) and
    // financialBalance() reads it as `market_payable` and SUBTRACTS it. Paying
    // the market must CLEAR that payable (-expense), mirroring the courier
    // cashbox (sale income → payment expense → nets to 0). Crediting it here
    // double-counted the payable, so a fully-paid market showed 2× owed and
    // financial-balanse went negative on every settled order.
    // (Live-E2E money audit 2026-08-13.)
    this.updateBalancesByMethod(
      marketCashbox,
      Number(data.amount),
      Operation_type.EXPENSE,
      data.payment_method ?? PaymentMethod.CASH,
    );
    await manager.save(marketCashbox);
    const marketHistory = await manager.save(
      manager.create(CashboxHistory, {
        operation_type: Operation_type.EXPENSE,
        cashbox_id: marketCashbox.id,
        source_type: Source_type.MARKET_PAYMENT,
        transfer_id: transferId,
        amount: Number(data.amount),
        balance_after: marketCashbox.balance,
        balance_cash_after: marketCashbox.balance_cash,
        balance_card_after: marketCashbox.balance_card,
        comment: data.comment ?? null,
        created_by: data.created_by ?? null,
        payment_date: this.parseDate(data.payment_date ?? null) ?? null,
        payment_method: data.payment_method,
        source_user_id: data.market_id,
        transfer_source_user_id: transferSourceUserId,
      }),
    );

    // Advance the per-order FIFO settlement ledger (HQ → market) in the SAME
    // transaction as the cashbox move (Faza 2a). Reliable outbox delivery to
    // order-service replaces the old best-effort gateway bridge.
    const advancePayload = await this.enqueueSettlementAdvance(
      manager,
      'hq_to_market',
      String(data.market_id),
      Number(data.amount),
      data.created_by,
      dedupKey,
    );

    if (opts.notify) {
      // (ePpLHPX2) `finance.payment_received` — puli kelgan tomon (market).
      // Faqat outbox, AYNAN shu tranzaksiyada: rollback bo'lsa xabar ham
      // yo'q; notification-service o'chiq bo'lsa ham to'lov o'tadi.
      await this.financeNotifications?.paymentReceived(
        {
          kind: 'market_payment',
          recipient_id: data.market_id,
          payment_id: marketHistory?.id,
          amount: Number(data.amount),
          payment_method: data.payment_method,
          // (VICfJuoi #3) summa, sana, qoldiq (oldin → keyin) xabarda.
          balance_after: marketHistory?.balance_after ?? null,
          payment_date: data.payment_date ?? null,
        },
        manager,
      );
    }

    return {
      idempotent: false,
      transferId,
      dedupKey,
      mainCashbox,
      marketCashbox,
      marketHistory,
      advancePayload,
    };
  }

  async allCashboxesTotal(filters?: {
    operationType?: Operation_type;
    operation_type?: Operation_type;
    sourceType?: Source_type;
    source_type?: Source_type;
    sourceTypes?: string;
    source_types?: string;
    createdBy?: string;
    created_by?: string;
    cashboxType?: Cashbox_type;
    cashbox_type?: Cashbox_type;
    fromDate?: string;
    from_date?: string;
    toDate?: string;
    to_date?: string;
    page?: number;
    limit?: number;
    /** Hisobot uchun: jami va oylik summalar BUTUN oraliq bo'yicha (QGxC7v1E). */
    withTotals?: boolean;
  }) {
    try {
      const mainCashbox = await this.ensureMainCashbox();

      const noPagination = filters?.page === 0 || filters?.limit === 0;
      const page = noPagination
        ? 0
        : filters?.page && filters.page > 0
          ? filters.page
          : 1;
      const limit = noPagination
        ? 0
        : filters?.limit && filters.limit > 0
          ? filters.limit
          : 20;
      const qb = this.historyRepo
        .createQueryBuilder('h')
        .leftJoinAndSelect('h.cashbox', 'cashbox')
        .where('h.isDeleted = :historyActive', { historyActive: false })
        .andWhere('cashbox.isDeleted = :cashboxActive', {
          cashboxActive: false,
        })
        .orderBy('h.createdAt', 'DESC');

      if (!noPagination) {
        qb.skip((page - 1) * limit).take(limit);
      }

      const operationType = filters?.operationType ?? filters?.operation_type;
      const sourceType = filters?.sourceType ?? filters?.source_type;
      const sourceTypes = this.parseSourceTypes(
        filters?.sourceTypes ?? filters?.source_types,
      );
      const createdBy = filters?.createdBy ?? filters?.created_by;
      const cashboxType = filters?.cashboxType ?? filters?.cashbox_type;
      const fromDate = filters?.fromDate ?? filters?.from_date;
      const toDate = filters?.toDate ?? filters?.to_date;

      if (operationType)
        qb.andWhere('h.operation_type = :operationType', {
          operationType,
        });
      if (sourceType)
        qb.andWhere('h.source_type = :sourceType', {
          sourceType,
        });
      if (sourceTypes?.length)
        qb.andWhere('h.source_type IN (:...sourceTypes)', {
          sourceTypes,
        });
      if (createdBy)
        qb.andWhere('h.created_by = :createdBy', {
          createdBy,
        });
      if (cashboxType)
        qb.andWhere('cashbox.cashbox_type = :cashboxType', {
          cashboxType,
        });
      // Toshkent kuni (SqVMuhKo / CODE-22) — boshqa kassa ro'yxatlari bilan
      // bir xil: 'YYYY-MM-DD' butun kun, to'liq ISO o'zgarishsiz.
      const { start: fromBound, end: toBound } = this.parseDateRange(
        fromDate,
        toDate,
      );
      if (fromBound)
        qb.andWhere('h.createdAt >= :fromDate', {
          fromDate: fromBound,
        });
      if (toBound)
        qb.andWhere('h.createdAt <= :toDate', {
          toDate: toBound,
        });

      const [allCashboxHistories, total] = await qb.getManyAndCount();
      const [courierCashboxTotal, marketCashboxTotal, marketPayableTotal] =
        await Promise.all([
          this.sumCashboxBalanceByType(Cashbox_type.FOR_COURIER),
          this.sumCashboxBalanceByType(Cashbox_type.FOR_MARKET),
          this.sumPositiveCashboxBalanceByType(Cashbox_type.FOR_MARKET),
        ]);
      const periodTotals = filters?.withTotals
        ? await this.sumHistoryTotals(qb)
        : undefined;

      return this.successRes(
        {
          mainCashboxTotal: Number(mainCashbox.balance),
          courierCashboxTotal,
          // Imzoli yig'indi (sof holat) — avvalgidek.
          marketCashboxTotal,
          // Faqat musbat kassalar — HQ marketlarga to'lashi kerak (audit M16).
          marketPayableTotal,
          ...(periodTotals ?? {}),
          allCashboxHistories,
          pagination: {
            total,
            page,
            limit,
            totalPages: noPagination
              ? total > 0
                ? 1
                : 0
              : Math.ceil(total / limit),
          },
        },
        200,
        'All cashbox histories',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * G1 / financial-balance-lists (2026-10-09 prod UI testi) — /financial-balance
   * "Marketlar" va "Kuryerlar" ro'yxatlari uchun bitta ro'yxatdagi qatorlar
   * chegarasi. Ro'yxat faqat balansi NOL BO'LMAGAN kassalardan iborat
   * (kassa = bitta foydalanuvchi), shu bois amalda bu chegaraga yetilmaydi;
   * yetilsa eng katta |balans| lar qaytadi va `truncated: true`.
   */
  private static readonly FINANCIAL_BALANCE_PARTY_LIST_LIMIT = 500;

  /**
   * G1 / financial-balance-lists — kuryer/market kassalari ro'yxati (balans ≠ 0)
   * egasining nomi bilan. Elchi-Frontend `normalizeFinancialBalance` qatordan
   * `id`, `user.name` va `balance` ni o'qiydi (BeePost'dagi
   * `relations: ['user']` shakli bilan bir xil).
   *
   * • Faqat SQL'da filtrlangan, chegaralangan so'rov — d3c83af6 perf
   *   tuzatishidagi "har bir kassani yuklash" qaytmaydi.
   * • `user` — identity'dan BITTA batch chaqiruv (`*.find_by_ids`), faqat
   *   id/name/phone_number/region_id; maosh, tarif, sozlamalar sizmaydi.
   * • Yordamchi ro'yxat: identity yiqilsa qatorlar `user: null` bilan,
   *   so'rov yiqilsa bo'sh ro'yxat qaytadi — kompaniya holati hisoboti
   *   to'xtamaydi (`findBranchCashExceedingPayable` bilan bir xil).
   */
  private async listNonZeroCashboxesWithOwners(
    cashboxType: Cashbox_type.FOR_COURIER | Cashbox_type.FOR_MARKET,
  ): Promise<{
    items: Array<{
      id: string;
      user_id: string;
      cashbox_type: Cashbox_type;
      balance: number;
      balance_cash: number;
      balance_card: number;
      user: {
        id: string;
        name: string | null;
        phone_number: string | null;
        region_id: string | null;
      } | null;
    }>;
    nonZeroCount: number;
    truncated: boolean;
  }> {
    const limit = FinanceServiceService.FINANCIAL_BALANCE_PARTY_LIST_LIMIT;
    let rows: Cashbox[] = [];
    let nonZeroCount = 0;
    try {
      [rows, nonZeroCount] = await this.cashboxRepo
        .createQueryBuilder('c')
        .where('c.cashbox_type = :cashboxType', { cashboxType })
        .andWhere('c.isDeleted = :active', { active: false })
        .andWhere('c.balance <> 0')
        .orderBy('ABS(c.balance)', 'DESC')
        .addOrderBy('c.id', 'ASC')
        .limit(limit)
        .getManyAndCount();
    } catch (error) {
      this.logger.warn(
        `Moliyaviy balans ro'yxati (${cashboxType}) olinmadi: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { items: [], nonZeroCount: 0, truncated: false };
    }

    const ownerIds = Array.from(
      new Set(rows.map((row) => String(row.user_id))),
    );
    const owners = new Map<
      string,
      {
        id: string;
        name: string | null;
        phone_number: string | null;
        region_id: string | null;
      }
    >();
    if (ownerIds.length) {
      try {
        const response = await rmqSend<{
          data?: Array<{
            id?: string | number | null;
            name?: string | null;
            phone_number?: string | null;
            region_id?: string | number | null;
          }>;
        }>(
          this.identityClient,
          {
            cmd:
              cashboxType === Cashbox_type.FOR_COURIER
                ? 'identity.courier.find_by_ids'
                : 'identity.market.find_by_ids',
          },
          { ids: ownerIds },
        );
        const users = Array.isArray(response?.data) ? response.data : [];
        for (const user of users) {
          if (user?.id === undefined || user?.id === null) continue;
          const id = String(user.id);
          owners.set(id, {
            id,
            name: user.name ?? null,
            phone_number: user.phone_number ?? null,
            region_id:
              user.region_id === undefined || user.region_id === null
                ? null
                : String(user.region_id),
          });
        }
      } catch (error) {
        this.logger.warn(
          `Moliyaviy balans ro'yxati (${cashboxType}) egalari nomlanmadi: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      items: rows.map((row) => ({
        id: String(row.id),
        user_id: String(row.user_id),
        cashbox_type: row.cashbox_type,
        balance: Number(row.balance) || 0,
        balance_cash: Number(row.balance_cash) || 0,
        balance_card: Number(row.balance_card) || 0,
        user: owners.get(String(row.user_id)) ?? null,
      })),
      nonZeroCount,
      truncated: nonZeroCount > rows.length,
    };
  }

  /**
   * @param options.include_party_lists — G1 / financial-balance-lists: faqat
   *   /financial-balance sahifasi (gateway) so'raydi. Analytics (dashboard,
   *   moliya hisoboti) flag'siz chaqiradi — unga ro'yxat kerak emas, javobi
   *   va narxi avvalgidek qoladi.
   */
  async financialBalance(options?: { include_party_lists?: boolean }) {
    try {
      const includePartyLists = options?.include_party_lists === true;
      const mainCashbox = await this.ensureMainCashbox();
      // Perf/unbounded (audit): this used to `find()` EVERY market cashbox row
      // and return the whole array (+ a per-row `items` map) purely to derive
      // one total — an unbounded load and payload as markets grow. The total is
      // all this summary needs, so push it down to SQL SUM.
      // ⚠️ G1 / financial-balance-lists: "ro'yxatni hech bir klient o'qimaydi"
      // degan taxmin NOTO'G'RI edi — /financial-balance sahifasi uni o'qiydi.
      // Ro'yxat endi faqat `include_party_lists` bilan, chegaralangan va
      // nol balanslarsiz qaytadi (`listNonZeroCashboxesWithOwners`).
      const marketCashboxTotal = await this.sumCashboxBalanceByType(
        Cashbox_type.FOR_MARKET,
      );
      const settlementResponse = await rmqSend<{
        data?: {
          chain_receivable?: number;
          branch_receivable?: number;
          hq_receivable?: number;
          market_payable?: number;
          branches?: Array<{ branch_id: string; amount: number }>;
          markets?: Array<{ market_id: string; amount: number }>;
          // znD3KaZL — taqsimlanmagan qoldiq (faqat ko'rsatkich).
          unapplied_carry?: unknown;
        };
      }>(
        this.orderClient,
        { cmd: 'order.settlement.financial_balance_summary' },
        {},
      );
      const settlement = settlementResponse?.data ?? {};

      /**
       * ⚠️ AUDIT M1 — KOMPANIYA HOLATI FORMULASI.
       *
       * Eski formula: `main + branch_receivable − market_payable`. Ikki xato
       * bor edi: (1) `branch_receivable` faqat filialga bog'langan
       * buyurtmalarni hisoblardi, HQ kuryerlaridagi pul esa umuman
       * ko'rinmasdi; (2) `couriersTotalBalanse` javobda 0 deb qotib qolgan
       * edi. Marketga qarz esa sotuv paytida darhol yozilgani uchun, natija
       * har bir "yo'ldagi" buyurtma qiymatiga manfiyga og'ardi — ya'ni
       * kompaniya o'zini yo'q qarz bilan ko'rsatardi.
       *
       * Yangi formula har somni AYNAN BIR MARTA sanaydi:
       *
       *   holat = MAIN + zanjirdagi qarz − marketga qarz
       *
       * `zanjirdagi qarz` (`chain_receivable`) — sotilgan, lekin hali HQ'ga
       * yetib kelmagan pul: kuryerda ham, filialda ham bo'lishi mumkin, lekin
       * buyurtma boshiga bir marta hisoblanadi (`order_settlement.branch_amount`,
       * holati PENDING yoki COURIER_SETTLED). Shu bois kassa yig'indilari
       * (kuryer/filial) bu yerga QO'SHILMAYDI — ular ayni pulning ikkinchi
       * ko'rinishi.
       *
       * Kassa yig'indilari operatsion ko'rinish sifatida javobda qoladi.
       */
      const chainReceivable = Number(
        settlement.chain_receivable ?? settlement.branch_receivable ?? 0,
      );

      /**
       * Kargolarning qarzi (audit M5). Kargo orqali sotilgan buyurtmada
       * marketga qarz darhol yoziladi, naqd esa kargoda qoladi — uning
       * qarama-qarshi tomoni aynan shu qarz. Hisobga olinmasa balans o'sha
       * summaga manfiyga og'ib turardi. Integration servisi javob bermasa 0
       * olinadi: bu ko'rsatkich hisobotni to'xtatib qo'ymasligi kerak.
       */
      const providerReceivable = await rmqSend<{
        data?: { outstanding_amount?: number };
      }>(
        this.integrationClient,
        { cmd: 'integration.receivable.outstanding_total' },
        {},
      )
        .then((res) => Number(res?.data?.outstanding_amount ?? 0) || 0)
        .catch(() => 0);
      const branchReceivable = Number(settlement.branch_receivable ?? 0);
      const hqReceivable = Number(settlement.hq_receivable ?? 0);
      const [courierCashboxTotal, branchCashboxTotal] = await Promise.all([
        this.sumCashboxBalanceByType(Cashbox_type.FOR_COURIER),
        this.sumCashboxBalanceByType(Cashbox_type.BRANCH),
      ]);
      // G1 / financial-balance-lists — jami bilan BIR XIL filtr (faol kassa,
      // turi bo'yicha), nol balanslar tashlanadi: Σ ro'yxat == jami.
      const [courierList, marketList] = includePartyLists
        ? await Promise.all([
            this.listNonZeroCashboxesWithOwners(Cashbox_type.FOR_COURIER),
            this.listNonZeroCashboxesWithOwners(Cashbox_type.FOR_MARKET),
          ])
        : [null, null];
      const marketPayable = marketCashboxTotal;
      const difference = chainReceivable + providerReceivable - marketPayable;
      const currentSituation = Number(mainCashbox.balance) + difference;
      const branchCashExceedingPayable =
        await this.findBranchCashExceedingPayable(settlement.branches ?? []);

      return this.successRes(
        {
          currentSituation,
          main: mainCashbox,
          chain: {
            chainReceivable,
            branchReceivable,
            hqReceivable,
            // Kargolar qo'lidagi, hali hisob-kitob qilinmagan naqd.
            providerReceivable,
          },
          branches: {
            branchReceivable,
            // Filiallar JISMONAN ushlab turgan naqd (kuryerdan qabul qilingan,
            // HQ'ga hali topshirilmagan). Holat formulasiga kirmaydi —
            // u allaqachon `chainReceivable` ichida.
            branchCashboxTotal,
            items: settlement.branches ?? [],
            /**
             * NAZORAT (Andijon E2E, 03avx8hG): kassasidagi naqd "berilishi
             * kerak" dan KO'P filiallar. Daftar to'g'ri bo'lsa filial HQ'ga
             * qarzidan ortiq naqd ushlab turmaydi — ortiqcha qism daftarda
             * yo'q pul (jonli: filial 13 kassasida 280 000, qarzi 0, bu summa
             * holat raqamlarining hech birida ko'rinmasdi).
             */
            cashExceedingPayable: branchCashExceedingPayable,
          },
          markets: {
            marketPayable,
            marketsTotalBalans: -marketPayable,
            /**
             * G1 / financial-balance-lists — prod'da "Marketlar 0 ta", lekin
             * "jami -240 000": d3c83af6 bu ro'yxatni "hech bir klient
             * o'qimaydi" deb olib tashlagan, holbuki frontend aynan
             * `allMarketCashboxes` dan ro'yxat chizadi. `balance` — kassaning
             * IMZOLI balansi (musbat = marketga qarzmiz, manfiy = market
             * bizga qarzdor); Σ balance == `marketPayable`.
             */
            ...(marketList
              ? {
                  allMarketCashboxes: marketList.items,
                  nonZeroCount: marketList.nonZeroCount,
                  truncated: marketList.truncated,
                }
              : {}),
          },
          couriers: {
            // G1 / financial-balance-lists — ilgari doim `[]` deb qotirilgan
            // edi ("Kuryerlar 0 ta", lekin "jami 90 000"). Flag'siz
            // chaqiruvda shakl avvalgidek (`[]`) qoladi.
            allCourierCashboxes: courierList?.items ?? [],
            // Kuryerlar qo'lidagi yig'indi qarz — ma'lumot uchun (ilgari
            // 0 deb qotib qolgan edi).
            couriersTotalBalanse: courierCashboxTotal,
            ...(courierList
              ? {
                  nonZeroCount: courierList.nonZeroCount,
                  truncated: courierList.truncated,
                }
              : {}),
          },
          /**
           * znD3KaZL — "Taqsimlanmagan qoldiq": kassada yuqoriga ko'chgan,
           * lekin FIFO hali hech bir BUTUN buyurtmani yopmagan naqd
           * (`order_settlement_carry`, bo'g'in bo'yicha). Keyingi to'lovga
           * qo'shiladi. ⚠️ Holat formulasiga KIRMAYDI — `chainReceivable` uni
           * allaqachon ayirgan, marketga qarz esa kassadan olinadi (to'lov u
           * yerda aks etgan); qo'shish ayni pulni ikki marta sanash bo'lardi.
           */
          unappliedCarry: this.normalizeUnappliedCarry(
            settlement.unapplied_carry,
          ),
          difference,
          formula:
            'main_cashbox + chain_receivable + provider_receivable - market_cashbox_payable',
        },
        200,
        'Financial balance infos',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  // ===========================================================================
  // Operator earnings & payments
  // ===========================================================================

  /**
   * Record the commission an operator earned for a sold order. Triggered by
   * order-service via outbox when an order transitions into a sold state.
   *
   * Idempotent: keyed on order_id (UNIQUE). Re-delivery, or an order bouncing
   * SOLD↔PARTLY_PAID, updates the existing row instead of inserting a duplicate.
   * The commission rule is read from the operator's identity profile and
   * snapshotted onto the row so later config changes don't rewrite history.
   *
   * No commission config (or zero value) → no-op. The operator simply earns
   * nothing on this order; that is not an error.
   */
  async recordOperatorEarning(input: {
    order_id: string;
    operator_id?: string | null;
    market_id?: string | null;
    total_price?: number | null;
  }) {
    try {
      this.assertBigIntId(input.order_id, 'order_id');
      const operatorId = input.operator_id ? String(input.operator_id) : null;
      if (!operatorId || !/^\d+$/.test(operatorId)) {
        // Orders without an operator (e.g. admin-created) earn no commission.
        return this.successRes(null, 200, 'no operator — earning skipped');
      }

      const operator = await this.fetchOperatorCommission(operatorId);
      const totalPrice = Number(input.total_price ?? 0);
      const amount = this.computeCommission(
        operator?.commission_type ?? null,
        Number(operator?.commission_value ?? 0),
        totalPrice,
      );

      if (amount <= 0) {
        // Operator has no/zero commission for this order — nothing to record.
        // If a prior earning somehow exists (commission later zeroed), leave it;
        // recompute only happens on explicit re-sale with a real amount.
        return this.successRes(null, 200, 'zero commission — earning skipped');
      }

      const existing = await this.earningRepo.findOne({
        where: { order_id: String(input.order_id) },
      });

      if (existing) {
        const before = { amount: existing.amount };
        existing.amount = amount;
        existing.operator_id = operatorId;
        existing.market_id = input.market_id
          ? String(input.market_id)
          : existing.market_id;
        existing.commission_type = operator?.commission_type ?? null;
        existing.commission_value = Number(operator?.commission_value ?? 0);
        existing.order_total_price = totalPrice;
        const saved = await this.earningRepo.save(existing);
        await this.activityLog.logChange({
          entity_type: 'OperatorEarning',
          entity_id: saved.id,
          old_value: before,
          new_value: { amount: saved.amount },
          metadata: { order_id: input.order_id, operator_id: operatorId },
        });
        return this.successRes(saved, 200, 'operator earning updated');
      }

      const entity = this.earningRepo.create({
        operator_id: operatorId,
        order_id: String(input.order_id),
        market_id: input.market_id ? String(input.market_id) : null,
        amount,
        commission_type: operator?.commission_type ?? null,
        commission_value: Number(operator?.commission_value ?? 0),
        order_total_price: totalPrice,
      });
      const saved = await this.earningRepo.save(entity);
      await this.activityLog.log({
        entity_type: 'OperatorEarning',
        entity_id: saved.id,
        action: ActivityAction.CREATED,
        new_value: {
          amount,
          operator_id: operatorId,
          order_id: input.order_id,
        },
        metadata: { commission_type: saved.commission_type },
      });
      return this.successRes(saved, 201, 'operator earning recorded');
    } catch (error) {
      // Unique violation = a concurrent delivery already inserted this order's
      // earning. That's the idempotency guarantee working — treat as success.
      if (
        error instanceof QueryFailedError &&
        (error as QueryFailedError & { code?: string }).code === '23505'
      ) {
        const existing = await this.earningRepo.findOne({
          where: { order_id: String(input.order_id) },
        });
        return this.successRes(
          existing,
          200,
          'operator earning already recorded',
        );
      }
      this.toRpcError(error);
    }
  }

  /**
   * Remove an operator earning when its order is rolled back out of a sold
   * state (e.g. WAITING again). Soft-deletes so the audit trail is preserved.
   */
  async removeOperatorEarning(input: { order_id: string }) {
    try {
      this.assertBigIntId(input.order_id, 'order_id');
      const existing = await this.earningRepo.findOne({
        where: { order_id: String(input.order_id) },
      });
      if (!existing) {
        return this.successRes(null, 200, 'no earning to remove');
      }
      // Soft delete via the BaseEntity flag (Elchi convention — entities use
      // `is_deleted` rather than a DeleteDateColumn). Balance queries below
      // already filter is_deleted=false, so this drops it from the total.
      existing.isDeleted = true;
      await this.earningRepo.save(existing);
      await this.activityLog.log({
        entity_type: 'OperatorEarning',
        entity_id: existing.id,
        action: ActivityAction.DELETED,
        old_value: { amount: existing.amount },
        metadata: { order_id: input.order_id, reason: 'order rolled back' },
      });
      return this.successRes(null, 200, 'operator earning removed');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /** Record a payout against an operator's accrued earnings. */
  async createOperatorPayment(input: {
    operator_id: string;
    market_id?: string | null;
    paid_by_id?: string | null;
    amount: number;
    note?: string | null;
    idempotency_key?: string | null;
  }) {
    try {
      this.assertBigIntId(input.operator_id, 'operator_id');
      const amount = Number(input.amount);
      this.assertPositiveAmount(amount, 'amount');
      const operatorId = String(input.operator_id);
      const paidById = input.paid_by_id ? String(input.paid_by_id) : null;
      // (FJVqcUTv) Kalit MAIN kassa tarixining `dedup_epoch` ida saqlanadi
      // (migratsiyasiz): prefiks boshqa SALARY yozuvlari bilan to'qnashmasin.
      const idempotencyKey = String(input.idempotency_key ?? '').trim();
      if (idempotencyKey.length > 255) {
        throw new BadRequestException(
          'Idempotency-Key 255 belgidan oshmasligi kerak',
        );
      }
      const dedupEpoch = idempotencyKey
        ? `operator-payment:${idempotencyKey}`
        : '';
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      let committed = false;
      try {
        // (FJVqcUTv) Bir operatorning parallel to'lovlari bir xil qarzni sarflamasin.
        await queryRunner.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          [`operator-payment:${operatorId}`],
        );

        // (FJVqcUTv) Takroriy so'rov (ikki marta bosish / javobi yo'qolgan
        // retry) — qulf ostida, qarz tekshiruvidan OLDIN: muvaffaqiyatli
        // to'lovning retry'i "qarzdan oshib ketdi" 400 olmasin.
        if (dedupEpoch) {
          const replayHistory = await queryRunner.manager.findOne(
            CashboxHistory,
            {
              where: {
                source_type: Source_type.SALARY,
                operation_type: Operation_type.EXPENSE,
                source_user_id: operatorId,
                dedup_epoch: dedupEpoch,
                isDeleted: false,
              },
            },
          );
          const replayPayment = replayHistory?.source_id
            ? await queryRunner.manager.findOne(OperatorPayment, {
                where: { id: String(replayHistory.source_id) },
              })
            : null;
          if (replayPayment) {
            await queryRunner.commitTransaction();
            committed = true;
            return this.successRes(
              { ...replayPayment, idempotent: true },
              200,
              "Operator to'lovi allaqachon qayd qilingan (takroriy so'rov)",
            );
          }
        }

        // (FJVqcUTv) Qarz shu tranzaksiya ulanishida o'qiladi (pool'dan
        // ikkinchi ulanish olinmaydi; qulf ostida oldingi to'lov ko'rinadi).
        const operatorBalance = await this.findOperatorBalance(
          { operator_id: operatorId },
          queryRunner.manager,
        );
        if (amount > Number(operatorBalance.data.balance)) {
          throw new BadRequestException(
            "To'lov miqdori operatorga qarzdan oshib ketdi",
          );
        }

        const mainCashbox = await this.getCashboxBySelectorWithManager(
          queryRunner.manager,
          {
            user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
            cashbox_type: Cashbox_type.MAIN,
          },
          { lock: true },
        );
        this.updateBalancesByMethod(
          mainCashbox,
          amount,
          Operation_type.EXPENSE,
          PaymentMethod.CASH,
        );

        const saved = await queryRunner.manager.save(
          this.paymentRepo.create({
            operator_id: operatorId,
            market_id: input.market_id ? String(input.market_id) : null,
            paid_by_id: paidById,
            amount,
            note: input.note ?? null,
          }),
        );
        const savedCashbox = await queryRunner.manager.save(mainCashbox);
        await queryRunner.manager.save(
          queryRunner.manager.create(CashboxHistory, {
            operation_type: Operation_type.EXPENSE,
            cashbox_id: savedCashbox.id,
            source_type: Source_type.SALARY,
            source_id: String(saved.id),
            dedup_epoch: dedupEpoch,
            source_user_id: operatorId,
            amount,
            balance_after: savedCashbox.balance,
            balance_cash_after: savedCashbox.balance_cash,
            balance_card_after: savedCashbox.balance_card,
            payment_method: PaymentMethod.CASH,
            comment: input.note ?? `Operator #${operatorId} to'lovi`,
            created_by: paidById,
          }),
        );

        await queryRunner.query('SELECT pg_advisory_xact_lock($1::bigint)', [
          FinanceServiceService.FBH_ADVISORY_LOCK_KEY.toString(),
        ]);
        const balanceBefore = await this.lastLiveFinancialBalance(
          queryRunner.manager,
        );
        const savedLedger = await queryRunner.manager.save(
          queryRunner.manager.create(FinancialBalanceHistory, {
            amount: -amount,
            balance_before: balanceBefore,
            balance_after: balanceBefore - amount,
            source_type: FinancialSource_type.SALARY,
            dedup_key: `operator-payment:${String(saved.id)}`,
            order_id: null,
            related_user_id: operatorId,
            comment: `Operator #${operatorId} komissiya to'lovi`,
            created_by: paidById,
          }),
        );

        await queryRunner.commitTransaction();
        committed = true;
        const auditResults = await Promise.allSettled([
          this.activityLog.log({
            entity_type: 'Cashbox',
            entity_id: savedCashbox.id,
            action: 'finance.balance_update',
            new_value: {
              balance: savedCashbox.balance,
              operation_type: Operation_type.EXPENSE,
              amount,
            },
            user_id: paidById,
            metadata: {
              user_id: FinanceServiceService.MAIN_CASHBOX_USER_ID,
              source_id: String(saved.id),
              source_user_id: operatorId,
              amount,
              created_by: paidById,
              direction: Operation_type.EXPENSE,
            },
          }),
          this.activityLog.log({
            entity_type: 'FinancialBalanceHistory',
            entity_id: savedLedger.id,
            action: ActivityAction.CREATED,
            new_value: {
              amount: -amount,
              balance_after: balanceBefore - amount,
              source_type: FinancialSource_type.SALARY,
            },
            user_id: paidById,
            metadata: { order_id: null },
          }),
          this.activityLog.log({
            entity_type: 'OperatorPayment',
            entity_id: saved.id,
            action: ActivityAction.PAYMENT,
            new_value: { amount, operator_id: operatorId },
            user_id: paidById,
            metadata: { note: input.note ?? null },
            description: ActivityDescribeUz.operatorPayment(operatorId, amount),
          }),
        ]);
        for (const result of auditResults) {
          if (result.status === 'rejected') {
            this.logger.error(
              "Operator to'lovi audit jurnaliga yozilmadi",
              result.reason,
            );
          }
        }
        return this.successRes(saved, 201, 'operator payment recorded');
      } catch (error) {
        if (!committed) {
          await queryRunner.rollbackTransaction();
        }
        throw error;
      } finally {
        await queryRunner.release();
      }
    } catch (error) {
      this.toRpcError(error);
    }
  }

  /**
   * Operator balance = SUM(non-deleted earnings) - SUM(non-deleted payments).
   * Positive balance means we owe the operator.
   */
  async findOperatorBalance(
    input: { operator_id: string },
    // (FJVqcUTv) createOperatorPayment tranzaksiyasi ichidan chaqirilganda —
    // o'sha ulanish (qulf ostidagi izchil o'qish).
    manager?: EntityManager,
  ) {
    try {
      this.assertBigIntId(input.operator_id, 'operator_id');
      const operatorId = String(input.operator_id);
      const earningRepo = manager
        ? manager.getRepository(OperatorEarning)
        : this.earningRepo;
      const paymentRepo = manager
        ? manager.getRepository(OperatorPayment)
        : this.paymentRepo;

      const earnedRow = await earningRepo
        .createQueryBuilder('e')
        .select('COALESCE(SUM(e.amount), 0)', 'total')
        .where('e.operator_id = :operatorId', { operatorId })
        .andWhere('e.is_deleted = false')
        .getRawOne<{ total: string }>();

      const paidRow = await paymentRepo
        .createQueryBuilder('p')
        .select('COALESCE(SUM(p.amount), 0)', 'total')
        .where('p.operator_id = :operatorId', { operatorId })
        .andWhere('p.is_deleted = false')
        .getRawOne<{ total: string }>();

      const earned = Number(earnedRow?.total ?? 0);
      const paid = Number(paidRow?.total ?? 0);

      return this.successRes(
        {
          operator_id: operatorId,
          earned,
          paid,
          balance: earned - paid,
        },
        200,
        'operator balance',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async listOperatorEarnings(input: {
    operator_id: string;
    limit?: number;
    offset?: number;
  }) {
    try {
      this.assertBigIntId(input.operator_id, 'operator_id');
      const take = Math.min(Math.max(Number(input.limit ?? 50), 1), 200);
      const skip = Math.max(Number(input.offset ?? 0), 0);
      const [rows, total] = await this.earningRepo.findAndCount({
        where: { operator_id: String(input.operator_id), isDeleted: false },
        order: { createdAt: 'DESC' },
        take,
        skip,
      });
      return this.successRes(
        { rows, total, limit: take, offset: skip },
        200,
        'operator earnings',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async listOperatorPayments(input: {
    operator_id: string;
    limit?: number;
    offset?: number;
  }) {
    try {
      this.assertBigIntId(input.operator_id, 'operator_id');
      const take = Math.min(Math.max(Number(input.limit ?? 50), 1), 200);
      const skip = Math.max(Number(input.offset ?? 0), 0);
      const [rows, total] = await this.paymentRepo.findAndCount({
        where: { operator_id: String(input.operator_id), isDeleted: false },
        order: { createdAt: 'DESC' },
        take,
        skip,
      });
      return this.successRes(
        { rows, total, limit: take, offset: skip },
        200,
        'operator payments',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  private computeCommission(
    type: string | null,
    value: number,
    totalPrice: number,
  ): number {
    if (!type || !Number.isFinite(value) || value <= 0) {
      return 0;
    }
    // `type` arrives as a raw string from identity; narrow to the enum for a
    // type-safe comparison.
    const commissionType = type as Commission_type;
    if (commissionType === Commission_type.PERCENT) {
      const price = Number.isFinite(totalPrice) ? Math.max(totalPrice, 0) : 0;
      return Math.max((price * value) / 100, 0);
    }
    if (commissionType === Commission_type.FIXED) {
      return Math.max(value, 0);
    }
    return 0;
  }

  private async fetchOperatorCommission(operatorId: string): Promise<{
    commission_type: string | null;
    commission_value: number;
  } | null> {
    try {
      const res = await rmqSend<{
        data?: {
          commission_type?: string | null;
          commission_value?: number | null;
        };
      }>(
        this.identityClient,
        { cmd: 'identity.user.find_by_id' },
        // (i76gGjyq) Operator buyurtmani olgandan keyin o'chirilgan bo'lishi
        // mumkin — komissiya baribir yoziladi (aks holda 404 outbox'ni
        // cheksiz qayta urardi).
        { id: operatorId, include_deleted: true },
      );
      const user = res?.data;
      if (!user) {
        return null;
      }
      return {
        commission_type: user.commission_type ?? null,
        commission_value: Number(user.commission_value ?? 0),
      };
    } catch (err) {
      // If identity is unreachable we can't compute commission. Log and skip —
      // the earning event will be retried by the outbox publisher.
      this.logger.warn(
        `fetchOperatorCommission failed for operator ${operatorId}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  // ===========================================================================
  // Financial balance ledger (company-wide P&L)
  // ===========================================================================

  // Advisory lock key — serialises ledger appends so balance_before/after of
  // concurrent writers can't interleave and corrupt the running total.
  private static readonly FBH_ADVISORY_LOCK_KEY = 947_310_021;

  /**
   * zTYaGWui — daftar zanjirining davomi: oxirgi TIRIK (`is_deleted = false`)
   * qatorning `balance_after`i. O'quvchilar (`findFinancialBalanceHistory`,
   * `getCurrentFinancialBalance`) aynan shu filtr bilan "oxirgi" qatorni
   * oladi — yozuvchi ham shunday qilmasa, oxirgi qator soft-delete qilinganda
   * yangi yozuv o'chirilgan qatordan davom etib, zanjir ikkiga bo'linardi.
   * ⚠️ FAQAT FBH advisory qulfi ostida chaqiriladi (ketma-ketlik).
   */
  private async lastLiveFinancialBalance(
    manager: EntityManager,
  ): Promise<number> {
    const last = await manager.findOne(FinancialBalanceHistory, {
      where: { isDeleted: false },
      order: { id: 'DESC' },
    });
    return Number(last?.balance_after ?? 0);
  }

  /**
   * IgR4FVsR — chaqiruvchining tranzaksiyasi ICHIDA P&L daftariga yozuv
   * qo'shish (commit/rollback chaqiruvchida). `recordFinancialBalance` bilan
   * bir xil qoida: advisory qulf ostida oxirgi qatordan `balance_after`
   * olinadi. Qulf tartibi: avval kassa qatori (chaqiruvchi), keyin FBH qulfi
   * — operator to'lovi bilan bir xil, teskari tartib yo'q.
   */
  private async appendFinancialBalanceInTx(
    manager: EntityManager,
    input: {
      amount: number;
      source_type: FinancialSource_type;
      dedup_key: string;
      related_user_id?: string | null;
      comment?: string | null;
      created_by?: string | null;
    },
  ): Promise<FinancialBalanceHistory> {
    await manager.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      FinanceServiceService.FBH_ADVISORY_LOCK_KEY.toString(),
    ]);
    const balanceBefore = await this.lastLiveFinancialBalance(manager);
    const amount = Number(input.amount);
    return manager.save(
      manager.create(FinancialBalanceHistory, {
        amount,
        balance_before: balanceBefore,
        balance_after: balanceBefore + amount,
        source_type: input.source_type,
        dedup_key: input.dedup_key,
        order_id: null,
        related_user_id: input.related_user_id
          ? String(input.related_user_id)
          : null,
        comment: input.comment ?? null,
        created_by: input.created_by ? String(input.created_by) : null,
      }),
    );
  }

  /**
   * Append an entry to the financial-balance ledger. The running balance is
   * derived from the previous row, so writes MUST be serialised — a pg
   * advisory lock pins the critical section to one writer at a time.
   *
   * Idempotent for order-sourced entries: SELL_PROFIT/CORRECTION carry an
   * order_id, and a (source_type, order_id) pair is recorded at most once.
   * Re-delivery of the outbox event returns the existing row.
   */
  async recordFinancialBalance(input: {
    amount: number;
    source_type: FinancialSource_type;
    order_id?: string | null;
    related_user_id?: string | null;
    comment?: string | null;
    created_by?: string | null;
    /**
     * Urinish tokeni (audit M4). Bo'sh bo'lsa — eski xatti-harakat: buyurtma
     * boshiga bitta yozuv. To'lgan bo'lsa — ayni token bilan kelgan takroriy
     * so'rov bir marta yoziladi, boshqa token esa yangi yozuv ochadi (sotuv →
     * rollback → qayta sotuv zanjiri uchun).
     */
    dedup_key?: string | null;
  }) {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      // A zero-impact event has nothing to ledger.
      return this.successRes(null, 200, 'zero amount — ledger entry skipped');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.query('SELECT pg_advisory_xact_lock($1::bigint)', [
        FinanceServiceService.FBH_ADVISORY_LOCK_KEY.toString(),
      ]);

      /**
       * Idempotentlik. Buyurtmaga bog'langan yozuvlar (source_type, order_id,
       * dedup_key) bo'yicha; buyurtmasiz yozuvlar (investor foydasi, operator
       * to'lovi kabi) esa (source_type, dedup_key) bo'yicha — ilgari ular
       * umuman dedup qilinmasdi va ikki marta bosilgan tugma daftarga ikkita
       * chiqim yozib qo'yishi mumkin edi. Yuqoridagi advisory qulf barcha FBH
       * yozuvlarini ketma-ketlashtirgani uchun bu tekshiruv poygaga chidamli.
       */
      const dedupKey = String(input.dedup_key ?? '');
      if (!dedupKey && !input.order_id) {
        this.logger.warn('financial balance entry without dedup_key');
      }
      if (input.order_id || dedupKey) {
        const existing = await queryRunner.manager.findOne(
          FinancialBalanceHistory,
          {
            where: {
              order_id: input.order_id ? String(input.order_id) : IsNull(),
              source_type: input.source_type,
              dedup_key: dedupKey,
            },
          },
        );
        if (existing) {
          // (cSNJN7GP) Kalit boshqa summa/izoh bilan qayta ishlatilsa — 409.
          // Faqat BUYURTMASIZ (qo'lda/to'lov) yozuvlarda: buyurtma
          // yozuvlari outbox'dan keladi va ularning takroriy yetkazilishi
          // avvalgidek jim 200 (409 outbox'ni 10 marta qayta urib DLQ'ga
          // tashlardi).
          if (
            dedupKey &&
            !input.order_id &&
            (Math.round(Number(existing.amount) * 100) !==
              Math.round(amount * 100) ||
              String(existing.created_by ?? '') !==
                String(input.created_by ?? '') ||
              String(existing.related_user_id ?? '') !==
                String(input.related_user_id ?? '') ||
              String(existing.comment ?? '') !== String(input.comment ?? ''))
          ) {
            throw new RpcException({
              statusCode: 409,
              message: 'Idempotency-Key was already used for another entry',
            });
          }
          await queryRunner.commitTransaction();
          return this.successRes(
            // (cSNJN7GP) Takroriy so'rov aniq farqlansin (TMgL1zvq naqshi).
            { ...existing, idempotent: true },
            200,
            'ledger entry already recorded',
          );
        }
      }

      const balanceBefore = await this.lastLiveFinancialBalance(
        queryRunner.manager,
      );
      const balanceAfter = balanceBefore + amount;

      const entity = queryRunner.manager.create(FinancialBalanceHistory, {
        amount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        source_type: input.source_type,
        dedup_key: dedupKey,
        order_id: input.order_id ? String(input.order_id) : null,
        related_user_id: input.related_user_id
          ? String(input.related_user_id)
          : null,
        comment: input.comment ?? null,
        created_by: input.created_by ? String(input.created_by) : null,
      });
      const saved = await queryRunner.manager.save(entity);
      await queryRunner.commitTransaction();

      await this.activityLog.log({
        entity_type: 'FinancialBalanceHistory',
        entity_id: saved.id,
        action: ActivityAction.CREATED,
        new_value: {
          amount,
          balance_after: balanceAfter,
          source_type: input.source_type,
        },
        user_id: input.created_by ? String(input.created_by) : null,
        metadata: { order_id: input.order_id ?? null },
      });

      return this.successRes(saved, 201, 'financial balance entry recorded');
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.toRpcError(error);
    } finally {
      await queryRunner.release();
    }
  }

  async findFinancialBalanceHistory(input: {
    source_type?: FinancialSource_type;
    from_date?: string;
    to_date?: string;
    limit?: number;
    offset?: number;
  }) {
    try {
      const take = Math.min(Math.max(Number(input.limit ?? 50), 1), 200);
      const skip = Math.max(Number(input.offset ?? 0), 0);

      const where: FindOptionsWhere<FinancialBalanceHistory> = {
        isDeleted: false,
      };
      if (input.source_type) {
        // (b1QxU3qa) Gateway ParseEnumPipe'dan tashqari RMQ chaqiruvchisi ham
        // enumga kirmagan qiymat bilan Postgres 500'ini olmasin — 400.
        if (
          !(Object.values(FinancialSource_type) as string[]).includes(
            String(input.source_type),
          )
        ) {
          throw new BadRequestException(
            `source_type noto'g'ri: ${String(input.source_type)}`,
          );
        }
        where.source_type = input.source_type;
      }
      // Toshkent kuni (C2 / CODE-22): 'YYYY-MM-DD' — butun kun (ilgari UTC
      // yarim tuni, oxirgi kun esa umuman kirmasdi); to'liq ISO o'zgarishsiz.
      const { start: from, end: to } = this.parseDateRange(
        input.from_date,
        input.to_date,
      );
      if (from && to) {
        where.createdAt = Between(from, to);
      } else if (from) {
        where.createdAt = MoreThanOrEqual(from);
      } else if (to) {
        where.createdAt = LessThanOrEqual(to);
      }

      const [rows, total] = await this.financialHistoryRepo.findAndCount({
        where,
        order: { createdAt: 'DESC', id: 'DESC' },
        take,
        skip,
      });

      const latest = await this.financialHistoryRepo.findOne({
        where: { isDeleted: false },
        order: { id: 'DESC' },
      });
      const currentBalance = Number(latest?.balance_after ?? 0);
      const page = Math.floor(skip / take) + 1;

      return this.successRes(
        {
          rows,
          items: rows,
          history: rows,
          total,
          currentBalance,
          limit: take,
          offset: skip,
          pagination: {
            total,
            page,
            limit: take,
            totalPages: Math.ceil(total / take),
          },
        },
        200,
        'financial balance history',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  private applyFinancialBalanceDateRange(
    qb: ReturnType<Repository<FinancialBalanceHistory>['createQueryBuilder']>,
    input: { from_date?: string; to_date?: string },
  ) {
    // Toshkent kuni (C2 / CODE-22) — tarix ro'yxati bilan bir xil qoida.
    const { start: from, end: to } = this.parseDateRange(
      input.from_date,
      input.to_date,
    );

    if (from) {
      qb.andWhere('h.createdAt >= :from', { from });
    }
    if (to) {
      qb.andWhere('h.createdAt <= :to', { to });
    }

    return qb;
  }

  private async getCurrentFinancialBalance(): Promise<number> {
    const latest = await this.financialHistoryRepo.findOne({
      where: { isDeleted: false },
      order: { id: 'DESC' },
    });

    return Number(latest?.balance_after ?? 0);
  }

  private mapFinancialBalanceHistoryRow(history: FinancialBalanceHistory) {
    return {
      id: history.id,
      created_at: history.createdAt,
      createdAt: history.createdAt,
      source_type: history.source_type,
      amount: Number(history.amount ?? 0),
      balance_before: Number(history.balance_before ?? 0),
      balance_after: Number(history.balance_after ?? 0),
      comment: history.comment,
      created_by: history.created_by,
      related_user_id: history.related_user_id,
      order_id: history.order_id,
    };
  }

  async financialBalanceAnalytics(input: {
    from_date?: string;
    to_date?: string;
  }) {
    try {
      const currentBalance = await this.getCurrentFinancialBalance();

      const sourceQb = this.financialHistoryRepo
        .createQueryBuilder('h')
        .select('h.source_type', 'source_type')
        .addSelect(
          'SUM(CASE WHEN h.amount > 0 THEN h.amount ELSE 0 END)',
          'positive_total',
        )
        .addSelect(
          'SUM(CASE WHEN h.amount < 0 THEN (-1 * h.amount) ELSE 0 END)',
          'negative_total',
        )
        .addSelect('SUM(h.amount)', 'net_total')
        .addSelect('COUNT(h.id)', 'transaction_count')
        .where('h.isDeleted = false')
        .groupBy('h.source_type')
        .orderBy('net_total', 'DESC');
      this.applyFinancialBalanceDateRange(sourceQb, input);

      const totalsQb = this.financialHistoryRepo
        .createQueryBuilder('h')
        .select(
          'SUM(CASE WHEN h.amount > 0 THEN h.amount ELSE 0 END)',
          'total_positive',
        )
        .addSelect(
          'SUM(CASE WHEN h.amount < 0 THEN (-1 * h.amount) ELSE 0 END)',
          'total_negative',
        )
        .addSelect('SUM(h.amount)', 'net_change')
        .addSelect('COUNT(h.id)', 'total_count')
        .where('h.isDeleted = false');
      this.applyFinancialBalanceDateRange(totalsQb, input);

      const topQb = this.financialHistoryRepo
        .createQueryBuilder('h')
        .addSelect(
          'CASE WHEN h.amount >= 0 THEN h.amount ELSE (-1 * h.amount) END',
          'abs_amount',
        )
        .where('h.isDeleted = false')
        .orderBy('abs_amount', 'DESC')
        .addOrderBy('h.createdAt', 'DESC')
        .take(10);
      this.applyFinancialBalanceDateRange(topQb, input);

      const [sourceBreakdown, totalsRaw, topTransactions] = await Promise.all([
        sourceQb.getRawMany(),
        totalsQb.getRawOne(),
        topQb.getMany(),
      ]);

      const totalPositive = Number(totalsRaw?.total_positive ?? 0);
      const totalNegative = Number(totalsRaw?.total_negative ?? 0);
      const netChange = Number(totalsRaw?.net_change ?? 0);
      const totalCount = Number(totalsRaw?.total_count ?? 0);

      const positiveImpact = sourceBreakdown
        .filter((source) => Number(source.positive_total) > 0)
        .map((source) => ({
          source_type: source.source_type,
          total_amount: Number(source.positive_total),
          transaction_count: Number(source.transaction_count),
          percentage:
            totalPositive > 0
              ? Math.round(
                  (Number(source.positive_total) / totalPositive) * 10000,
                ) / 100
              : 0,
        }))
        .sort((a, b) => b.total_amount - a.total_amount);

      const negativeImpact = sourceBreakdown
        .filter((source) => Number(source.negative_total) > 0)
        .map((source) => ({
          source_type: source.source_type,
          total_amount: Number(source.negative_total),
          transaction_count: Number(source.transaction_count),
          percentage:
            totalNegative > 0
              ? Math.round(
                  (Number(source.negative_total) / totalNegative) * 10000,
                ) / 100
              : 0,
        }))
        .sort((a, b) => b.total_amount - a.total_amount);

      return this.successRes(
        {
          currentBalance,
          summary: {
            totalPositive,
            totalNegative,
            netChange,
            totalCount,
          },
          positiveImpact,
          negativeImpact,
          topTransactions: topTransactions.map((history) =>
            this.mapFinancialBalanceHistoryRow(history),
          ),
        },
        200,
        'Financial balance analytics',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async financialBalanceTopImpacts(input: {
    from_date?: string;
    to_date?: string;
    page?: number;
    limit?: number;
  }) {
    try {
      // (vmLTsAok) Server sahifalashi: `limit` 1..100 ga qisiladi (10 000
      // so'ralsa ham 100), javobdagi `pagination.limit/totalPages` — haqiqiy
      // qo'llangan qiymatlar. Son bo'lmagan page/limit (`?page=abc`) ilgari
      // NaN bo'lib OFFSET'ga tushardi — endi sukut qiymati.
      const rawPage = Math.floor(Number(input.page ?? 1));
      const rawLimit = Math.floor(Number(input.limit ?? 20));
      const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 100)
        : 20;

      const qb = this.financialHistoryRepo
        .createQueryBuilder('h')
        .addSelect(
          'CASE WHEN h.amount >= 0 THEN h.amount ELSE (-1 * h.amount) END',
          'abs_amount',
        )
        .where('h.isDeleted = false')
        .orderBy('abs_amount', 'DESC')
        .addOrderBy('h.createdAt', 'DESC');
      this.applyFinancialBalanceDateRange(qb, input);

      const [items, total] = await qb
        .skip((page - 1) * limit)
        .take(limit)
        .getManyAndCount();

      return this.successRes(
        {
          items: items.map((history) =>
            this.mapFinancialBalanceHistoryRow(history),
          ),
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
        200,
        'Top impact transactions',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }
}
