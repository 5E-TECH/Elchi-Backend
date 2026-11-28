import { Controller, Optional } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
  RpcException,
} from '@nestjs/microservices';
import {
  ActivityLogQuery,
  Cashbox_type,
  FinancialSource_type,
  RmqService,
  executeAndAck,
} from '@app/common';
import { FinanceServiceService } from './finance-service.service';
import { CourierPaymentAckService } from './courier-payment/courier-payment-ack.service';
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
import { RecordFinancialBalanceDto } from './dto/financial/record-financial-balance.dto';

@Controller()
export class FinanceServiceController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly financeService: FinanceServiceService,
    @Optional() private readonly courierAcks?: CourierPaymentAckService,
  ) {}

  private executeAndAck<T>(
    context: RmqContext,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    return executeAndAck(this.rmqService, context, handler);
  }

  @MessagePattern({ cmd: 'finance.health' })
  health(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => ({
      service: 'finance-service',
      status: 'ok',
      timestamp: new Date().toISOString(),
    }));
  }

  @MessagePattern({ cmd: 'finance.cashbox.create' })
  createCashbox(@Payload() data: CreateCashboxDto, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.financeService.createCashbox(data),
    );
  }

  /** 63HO6cBU (PR-C) — market kassalari qoldig'i (menejer `payable` uchun). */
  @MessagePattern({ cmd: 'finance.cashbox.market_balances' })
  marketBalances(
    @Payload() data: { market_ids?: unknown },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.marketBalances(data ?? {}),
    );
  }

  /** Ko'p foydalanuvchining bitta turdagi kassasi (gateway markets/couriers ro'yxati, N+1 o'rniga). */
  @MessagePattern({ cmd: 'finance.cashbox.find_by_users' })
  findCashboxesByUsers(
    @Payload() data: { user_ids?: unknown; cashbox_type?: unknown },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.findCashboxesByUsers(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.find_by_user' })
  findCashboxByUser(
    @Payload() data: FindCashboxByUserDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.findCashboxByUser(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.main' })
  getMainCashbox(
    @Payload()
    data: {
      fromDate?: string;
      toDate?: string;
      sourceTypes?: string;
      source_types?: string;
      include_receipts?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.getMainCashbox({
        fromDate: data?.fromDate,
        toDate: data?.toDate,
        sourceTypes: data?.sourceTypes,
        source_types: data?.source_types,
        include_receipts: data?.include_receipts === true,
      }),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.user_by_id' })
  getCashboxByUserId(
    @Payload()
    data: {
      id: string;
      fromDate?: string;
      toDate?: string;
      cashbox_type?: any;
      history_source_type?: any;
      history_source_types?: string;
      sourceTypes?: string;
      source_types?: string;
      include_receipts?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.getCashboxByUserId(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.my' })
  myCashbox(
    @Payload()
    data: {
      user_id: string;
      branch_id?: string | null;
      roles?: string[];
      fromDate?: string;
      toDate?: string;
      sourceTypes?: string;
      source_types?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.myCashbox(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.update_balance' })
  updateBalance(
    @Payload() data: UpdateCashboxBalanceDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.updateBalance(data),
    );
  }

  @MessagePattern({ cmd: 'finance.history.find_all' })
  findAllHistory(@Payload() data: FindHistoryDto, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.financeService.findAllHistory(data),
    );
  }

  @MessagePattern({ cmd: 'finance.history.find_by_id' })
  findHistoryById(
    @Payload()
    data: {
      id: string;
      include_correctable?: boolean;
      include_receipts?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.findHistoryById(data.id, {
        include_correctable: data.include_correctable === true,
        include_receipts: data.include_receipts === true,
      }),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.payment_courier' })
  paymentFromCourier(
    @Payload()
    data: {
      courier_id: string;
      amount: number;
      payment_method: any;
      payment_date?: string;
      comment?: string;
      market_id?: string;
      created_by?: string;
      receiver_user_id?: string;
      receiver_cashbox_type?: Cashbox_type;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.paymentsFromCourier(data),
    );
  }

  /**
   * (2crjWf7v #4) Kuryerning kvitansiyaga javobi — FAQAT audit
   * (`courier_payment_acks`), kassaga ta'sir YO'Q. Gateway `courier_id` ni
   * JWT'dan qo'yadi (kuryer faqat o'z kvitansiyasiga javob beradi).
   */
  @MessagePattern({ cmd: 'finance.cashbox.courier_payment_ack' })
  courierPaymentAck(
    @Payload()
    data: {
      payment_id?: string;
      courier_id?: string;
      ack?: string;
      comment?: string;
      notify_user_ids?: string[];
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () => {
      if (!this.courierAcks) {
        throw new RpcException({
          statusCode: 503,
          message: 'Kvitansiya javobi xizmati ulanmagan',
        });
      }
      return this.courierAcks.ack(data);
    });
  }

  @MessagePattern({ cmd: 'finance.cashbox.payment_market' })
  paymentToMarket(
    @Payload()
    data: {
      market_id: string;
      amount: number;
      payment_method: any;
      payment_date?: string;
      comment?: string;
      created_by?: string;
      // Audit M4 — menejer: o'z filial kassasidan (gateway JWT'dan qo'yadi).
      payer_cashbox_type?: Cashbox_type;
      payer_user_id?: string;
      // 63HO6cBU (PR-C) — filial ulushi (gateway order-service'dan oladi).
      branch_share?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.paymentsToMarket(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.payment_branch_main' })
  paymentBranchToMain(
    @Payload()
    data: {
      branch_id: string;
      amount: number;
      payment_method: any;
      payment_date?: string;
      comment?: string;
      created_by?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.paymentFromBranchToMain(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.all_info' })
  allCashboxesInfo(
    @Payload()
    data: {
      operationType?: any;
      operation_type?: any;
      sourceType?: any;
      source_type?: any;
      sourceTypes?: string;
      source_types?: string;
      createdBy?: string;
      created_by?: string;
      cashboxType?: any;
      cashbox_type?: any;
      fromDate?: string;
      from_date?: string;
      toDate?: string;
      to_date?: string;
      page?: number;
      limit?: number;
      withTotals?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.allCashboxesTotal(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.financial_balance' })
  financialBalance(
    // G1 / financial-balance-lists — gateway /financial-balance uchun
    // `include_party_lists: true` yuboradi; analytics payload'siz chaqiradi.
    @Payload() data: { include_party_lists?: boolean } | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.financialBalance({
        include_party_lists: data?.include_party_lists === true,
      }),
    );
  }

  /** T3 — chek tafsiloti (doira — gateway: menejer o'z filiali). */
  @MessagePattern({ cmd: 'finance.receipt.get' })
  getReceipt(@Payload() data: { id?: string }, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.financeService.getReceipt(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.spend' })
  spendMoney(
    @Payload()
    data: {
      user_id: string;
      amount: number;
      type?: any;
      comment?: string;
      cashbox_type?: Cashbox_type;
      created_by?: string;
      dedup_epoch?: string;
      // Elchi Pochta №1 — kassa xarajati kategoriyasi (ixtiyoriy).
      expense_category_id?: string;
      // IgR4FVsR — gateway'ning qo'lda chiqimi: P&L daftariga ham yoziladi.
      financial_ledger?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.spendMoney(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.fill' })
  fillCashbox(
    @Payload()
    data: {
      user_id: string;
      amount: number;
      type?: any;
      comment?: string;
      cashbox_type?: Cashbox_type;
      created_by?: string;
      dedup_epoch?: string;
      // IgR4FVsR — gateway'ning qo'lda kirimi: P&L daftariga ham yoziladi.
      financial_ledger?: boolean;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.fillTheCashbox(data),
    );
  }

  @MessagePattern({ cmd: 'finance.shift.open' })
  openShift(@Payload() data: OpenShiftDto, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.financeService.openShift(data),
    );
  }

  @MessagePattern({ cmd: 'finance.shift.close' })
  closeShift(@Payload() data: CloseShiftDto, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.financeService.closeShift(data),
    );
  }

  // (kfdfYDik) Kassaning (sukut MAIN) joriy ochiq smenasi + darvoza holati.
  @MessagePattern({ cmd: 'finance.shift.current' })
  currentShift(
    @Payload() data: { cashbox_user_id?: string } | undefined,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.currentShift(data ?? {}),
    );
  }

  // (kiZgTybn) Smena hisoboti: naqd + kartalar bo'yicha natijalar.
  @MessagePattern({ cmd: 'finance.shift.report' })
  shiftReport(
    @Payload() data: { shift_id?: string; cashbox_user_id?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.getShiftReport(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.shift.find_all' })
  findAllShifts(@Payload() data: FindShiftsDto, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.financeService.findAllShifts(data),
    );
  }

  @MessagePattern({ cmd: 'finance.salary.create' })
  createSalary(@Payload() data: CreateSalaryDto, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.financeService.createSalary(data),
    );
  }

  @MessagePattern({ cmd: 'finance.salary.update' })
  updateSalary(@Payload() data: UpdateSalaryDto, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.financeService.updateSalary(data),
    );
  }

  @MessagePattern({ cmd: 'finance.salary.find_by_user' })
  findSalaryByUser(
    @Payload() data: FindSalaryByUserDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.findSalaryByUser(data),
    );
  }

  // --- Operator earnings & payments ---

  @MessagePattern({ cmd: 'finance.operator.earning.record' })
  recordOperatorEarning(
    @Payload()
    data: {
      order_id: string;
      operator_id?: string | null;
      market_id?: string | null;
      total_price?: number | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.recordOperatorEarning(data),
    );
  }

  /**
   * 2026-11-20 — komissiya sotuvda belgilanmagan bo'lgan o'tgan sotuvlarga
   * joriy stavka bo'yicha ulush (faqat qatori umuman yo'q buyurtmalar;
   * `dry_run` — oldindan ko'rish). Gateway (market) chaqiradi.
   */
  @MessagePattern({ cmd: 'finance.operator.earning.backfill' })
  backfillOperatorEarnings(
    @Payload()
    data: {
      operator_id: string;
      orders?: Array<{
        order_id?: unknown;
        total_price?: unknown;
        market_id?: unknown;
      }>;
      dry_run?: boolean;
      requested_by?: { id?: string | null; role?: string | null };
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.backfillOperatorEarnings(data),
    );
  }

  @MessagePattern({ cmd: 'finance.operator.earning.remove' })
  removeOperatorEarning(
    @Payload() data: { order_id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.removeOperatorEarning(data),
    );
  }

  // F2qp6FtE: eski superadmin yo'li (Asosiy kassadan to'lov) — faqat deploy
  // oynasidagi eski gateway uchun; pulga tegmasdan 410. Yangi yozuv —
  // `finance.operator.market_payment.*` (OperatorPaymentController).
  @MessagePattern({ cmd: 'finance.operator.payment.create' })
  createOperatorPayment(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () =>
      this.financeService.createOperatorPayment(),
    );
  }

  @MessagePattern({ cmd: 'finance.operator.balance.find' })
  findOperatorBalance(
    @Payload() data: { operator_id: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.findOperatorBalance(data),
    );
  }

  @MessagePattern({ cmd: 'finance.operator.earning.list' })
  listOperatorEarnings(
    @Payload() data: { operator_id: string; limit?: number; offset?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.listOperatorEarnings(data),
    );
  }

  @MessagePattern({ cmd: 'finance.operator.payment.list' })
  listOperatorPayments(
    @Payload() data: { operator_id: string; limit?: number; offset?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.listOperatorPayments(data),
    );
  }

  // --- Financial balance ledger ---

  @MessagePattern({ cmd: 'finance.financial_balance.record' })
  recordFinancialBalance(
    @Payload() data: RecordFinancialBalanceDto,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.recordFinancialBalance(data),
    );
  }

  /**
   * (SPEC v2) Kechiktirilgan qo'shimcha xarajat tasdig'idan keyingi
   * ortiqcha — market buyurtmalari FIFO'siga (pul ko'chmaydi), keyin
   * FOR_MARKET −E (`market_leg`). Faqat order-service outbox'i yuboradi;
   * gateway'da marshrut yo'q.
   */
  @MessagePattern({ cmd: 'finance.market.extra_cost_overage' })
  applyExtraCostOverage(
    @Payload()
    data: {
      market_id?: string;
      amount?: number;
      approval_id?: string;
      order_id?: string;
      dedup_key?: string;
      market_leg?: UpdateCashboxBalanceDto | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.scheduleExtraCostOverageSync(data),
    );
  }

  @MessagePattern({ cmd: 'finance.financial_balance.history' })
  findFinancialBalanceHistory(
    @Payload()
    data: {
      source_type?: FinancialSource_type;
      expense_category?: string;
      from_date?: string;
      to_date?: string;
      limit?: number;
      offset?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.findFinancialBalanceHistory(data),
    );
  }

  @MessagePattern({ cmd: 'finance.financial_balance.expense_report' })
  financialBalanceExpenseReport(
    @Payload()
    data: {
      from_date?: string;
      to_date?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.financialBalanceExpenseReport(data),
    );
  }

  @MessagePattern({ cmd: 'finance.financial_balance.analytics' })
  financialBalanceAnalytics(
    @Payload()
    data: {
      from_date?: string;
      to_date?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.financialBalanceAnalytics(data),
    );
  }

  /**
   * Kompaniya P&L seriyasi (daromad / xarajat / sof foyda) — investor ulushi
   * (investor-service) va tizim grafigi uchun. Gateway: `GET /finance/pnl`
   * (superadmin/admin; bo'sh oylarni 0 bilan to'ldiradi).
   */
  @MessagePattern({ cmd: 'finance.pnl.series' })
  financialPnlSeries(
    @Payload()
    data: { from_day?: string; to_day?: string; granularity?: string },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.financialPnlSeries(data),
    );
  }

  @MessagePattern({ cmd: 'finance.financial_balance.top_impacts' })
  financialBalanceTopImpacts(
    @Payload()
    data: {
      from_date?: string;
      to_date?: string;
      page?: number;
      limit?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.financialBalanceTopImpacts(data),
    );
  }

  // --- Audit log (read-only fan-in for the gateway) ---

  @MessagePattern({ cmd: 'finance.activity_log.find_all' })
  findActivityLogs(
    @Payload() data: { query?: ActivityLogQuery },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.auditLogQuery(data?.query ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.activity_log.find_by_entity' })
  findActivityLogsByEntity(
    @Payload()
    data: { entity_type: string; entity_id: string; limit?: number },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.financeService.auditLogByEntity(
        data.entity_type,
        data.entity_id,
        data.limit,
      ),
    );
  }
}
