import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinanceServiceController } from './finance-service.controller';
import { FinanceServiceService } from './finance-service.service';
import {
  AppLoggerModule,
  RmqModule,
  DatabaseModule,
  financeValidationSchema,
  ActivityLogModule,
  OutboxModule,
} from '@app/common';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift } from './entities/shift.entity';
import { UserSalary } from './entities/user-salary.entity';
import { OperatorEarning } from './entities/operator-earning.entity';
import { OperatorPayment } from './entities/operator-payment.entity';
import { FinancialBalanceHistory } from './entities/financial-balance-history.entity';
import { CourierPaymentAck } from './entities/courier-payment-ack.entity';
import { CourierPaymentAckService } from './courier-payment/courier-payment-ack.service';
import { CourierCashReminderScheduler } from './courier-payment/courier-cash-reminder.scheduler';
import { FinanceNotificationService } from './notification/finance-notification.service';
import { FinanceSettlementUnapplied } from './entities/finance-settlement-unapplied.entity';
import { SettlementUnappliedService } from './settlement/settlement-unapplied.service';
import { SettlementUnappliedController } from './settlement/settlement-unapplied.controller';
import { CashboxCard } from './entities/cashbox-card.entity';
import { CashboxCardMovement } from './entities/cashbox-card-movement.entity';
import { CashboxCardService } from './cashbox-card/cashbox-card.service';
import { CashboxCardController } from './cashbox-card/cashbox-card.controller';
import { FinanceRealtimeService } from './realtime/finance-realtime.service';
import { CashboxExpenseCategory } from './entities/cashbox-expense-category.entity';
import { ShiftAccountCheck } from './entities/shift-account-check.entity';
import { FinanceSetting } from './entities/finance-setting.entity';
import { ShiftAccountCheckService } from './shift-account-check/shift-account-check.service';
import { ShiftAccountCheckController } from './shift-account-check/shift-account-check.controller';
import { SHIFT_ACCOUNT_CHECKS } from './shift-account-check/shift-account-check.token';
import { ExpenseCategoryService } from './expense-category/expense-category.service';
import { ExpenseCategoryController } from './expense-category/expense-category.controller';
import { FinanceCashboxDaily } from './entities/finance-cashbox-daily.entity';
import { FinanceDailySnapshot } from './entities/finance-daily-snapshot.entity';
import { FinanceDailySnapshotService } from './aggregates/finance-daily-snapshot.service';
import { FinanceDailyService } from './aggregates/finance-daily.service';
import { PaymentsMetaService } from './aggregates/payments-meta.service';
import { FinanceAggregatesController } from './aggregates/finance-aggregates.controller';
import { ShiftScheduleClaim } from './entities/shift-schedule-claim.entity';
import { ShiftReportDelivery } from './entities/shift-report-delivery.entity';
import { ShiftAutoCloseScheduler } from './shift-auto-close/shift-auto-close.scheduler';
import { ShiftReportService } from './shift-report/shift-report.service';
import { ShiftReportController } from './shift-report/shift-report.controller';
import { SHIFT_REPORTS } from './shift-report/shift-report.token';
import { PaymentCorrection } from './entities/payment-correction.entity';
import { PaymentCorrectionService } from './payment-correction/payment-correction.service';
import { PaymentCorrectionController } from './payment-correction/payment-correction.controller';
import { CashboxReceipt } from './entities/cashbox-receipt.entity';
import { CashboxReceiptService } from './cashbox-receipt/cashbox-receipt.service';
import { CashboxReceiptController } from './cashbox-receipt/cashbox-receipt.controller';
import { CashboxReceiptCleanupScheduler } from './cashbox-receipt/cashbox-receipt-cleanup.scheduler';
import { CASHBOX_RECEIPTS } from './cashbox-receipt/cashbox-receipt.token';
import { PickupVisit } from './entities/pickup-visit.entity';
import { PickupFifoService } from './pickup-visit/pickup-fifo.service';
import { PICKUP_FIFO } from './pickup-visit/pickup-fifo.token';
import { PickupVisitService } from './pickup-visit/pickup-visit.service';
import { PickupVisitController } from './pickup-visit/pickup-visit.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: financeValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'finance-service' }),
    // (y8Tqm9Ap) Smena avtomatik yopish jadvali (CronJob, Asia/Tashkent).
    ScheduleModule.forRoot(),
    RmqModule,
    RmqModule.register({ name: 'ORDER' }),
    RmqModule.register({ name: 'IDENTITY' }),
    // Kargo qarzi kompaniya holati formulasiga kiradi (audit M5).
    RmqModule.register({ name: 'INTEGRATION' }),
    // (ePpLHPX2) To'lov / balans to'ldirish → bildirishnoma. FAQAT outbox
    // maqsadi sifatida (FinanceNotificationService) — to'g'ridan-to'g'ri
    // rmqSend TAQIQ (pul tranzaksiyasi rollback bo'lsa ham xabar ketardi).
    RmqModule.register({ name: 'NOTIFICATION' }),
    // (rWdLuoP3) Smena / kassa kartasi realtime hodisalari: gateway navbatiga
    // `realtime.notify` — FAQAT outbox maqsadi (FinanceRealtimeService).
    RmqModule.register({ name: 'GATEWAY' }),
    // (gWI4gYkw) Smena hisoboti fayli (PDF/XLSX) — file-service (private).
    RmqModule.register({ name: 'FILE' }),
    DatabaseModule,
    // Transactional outbox: finance publishes `order.settlement.advance` to
    // order-service inside the cashbox-move transaction (Faza 2a). Reliable,
    // retried, DLQ-backed delivery replaces the old best-effort gateway bridge.
    OutboxModule.forService({
      targets: ['ORDER', 'NOTIFICATION', 'GATEWAY'],
      // (ePpLHPX2) Bildirishnoma javobi KUTILMAYDI: publisher ketma-ket
      // ishlaydi, notification-service yiqilsa har hodisa timeout'gacha
      // osilib, ortidagi PUL hodisalari (settlement advance) kechikardi.
      // Pul/holat hodisalari bu ro'yxatda YO'Q (ularga yetkazish tasdig'i
      // va qayta urinish kerak).
      // (rWdLuoP3) `realtime.notify` ham — gateway `@EventPattern`, javob
      // qaytarmaydi; yetkazilmasa faqat sahifa o'zi yangilanmaydi.
      options: {
        fireAndForgetPatterns: ['notification.dispatch', 'realtime.notify'],
      },
    }),
    ActivityLogModule.forService('finance-service'),
    TypeOrmModule.forFeature([
      Cashbox,
      CashboxHistory,
      Shift,
      UserSalary,
      OperatorEarning,
      OperatorPayment,
      FinancialBalanceHistory,
      // znD3KaZL — FIFO qoldig'i jurnali (faqat ko'rsatkich/audit).
      FinanceSettlementUnapplied,
      // 3PE0B03q — MAIN kassa nomli kartalari (BeePost cashbox_card porti).
      CashboxCard,
      CashboxCardMovement,
      // Elchi Pochta №1 — kassa xarajatlari kategoriyalari.
      CashboxExpenseCategory,
      // kiZgTybn — smena yopishda karta qoldig'ini tasdiqlash + sozlamalar.
      ShiftAccountCheck,
      FinanceSetting,
      // y8Tqm9Ap / gWI4gYkw — slot kalitlari va hisobot yetkazish jurnali.
      ShiftScheduleClaim,
      ShiftReportDelivery,
      // (2crjWf7v) kuryer kvitansiya javobi — faqat audit.
      CourierPaymentAck,
      // qzjTMWPb — kunlik balans snapshot'i (o'qish modeli, migratsiya 176).
      FinanceCashboxDaily,
      FinanceDailySnapshot,
      // T6 — to'lovni qaytarish / summasini tuzatish jurnali (migratsiya 186).
      PaymentCorrection,
      // T3 — kassa cheki (migratsiya 188).
      CashboxReceipt,
      // B824gOu5 — pickup tashrifi va haqi (migratsiya 198).
      PickupVisit,
    ]),
  ],
  controllers: [
    FinanceServiceController,
    SettlementUnappliedController,
    CashboxCardController,
    ExpenseCategoryController,
    ShiftAccountCheckController,
    // qzjTMWPb / uzWcMR1C — kunlik agregat va /payments KPI meta (o'qish).
    FinanceAggregatesController,
    ShiftReportController,
    // T6 — to'lovni qaytarish / summasini tuzatish (superadmin).
    PaymentCorrectionController,
    // T3 — kassa cheki (sozlama, yuklash, bog'lash, AI).
    CashboxReceiptController,
    // B824gOu5 — pickup tashrifi yozuvi, ro'yxat, daromad yig'indisi.
    PickupVisitController,
  ],
  providers: [
    FinanceServiceService,
    FinanceNotificationService,
    FinanceRealtimeService,
    SettlementUnappliedService,
    CashboxCardService,
    ExpenseCategoryService,
    CourierPaymentAckService,
    CourierCashReminderScheduler,
    ShiftAccountCheckService,
    { provide: SHIFT_ACCOUNT_CHECKS, useExisting: ShiftAccountCheckService },
    FinanceDailySnapshotService,
    FinanceDailyService,
    PaymentsMetaService,
    ShiftReportService,
    { provide: SHIFT_REPORTS, useExisting: ShiftReportService },
    ShiftAutoCloseScheduler,
    PaymentCorrectionService,
    CashboxReceiptService,
    { provide: CASHBOX_RECEIPTS, useExisting: CashboxReceiptService },
    CashboxReceiptCleanupScheduler,
    PickupFifoService,
    { provide: PICKUP_FIFO, useExisting: PickupFifoService },
    PickupVisitService,
  ],
})
export class FinanceServiceModule {}
