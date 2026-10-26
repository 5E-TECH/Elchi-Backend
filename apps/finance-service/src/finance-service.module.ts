import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: financeValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'finance-service' }),
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
      // (2crjWf7v) kuryer kvitansiya javobi — faqat audit.
      CourierPaymentAck,
      // qzjTMWPb — kunlik balans snapshot'i (o'qish modeli, migratsiya 176).
      FinanceCashboxDaily,
      FinanceDailySnapshot,
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
  ],
})
export class FinanceServiceModule {}
