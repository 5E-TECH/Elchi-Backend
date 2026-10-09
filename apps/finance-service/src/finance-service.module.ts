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
import { FinanceNotificationService } from './notification/finance-notification.service';
import { FinanceSettlementUnapplied } from './entities/finance-settlement-unapplied.entity';
import { SettlementUnappliedService } from './settlement/settlement-unapplied.service';
import { SettlementUnappliedController } from './settlement/settlement-unapplied.controller';

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
    DatabaseModule,
    // Transactional outbox: finance publishes `order.settlement.advance` to
    // order-service inside the cashbox-move transaction (Faza 2a). Reliable,
    // retried, DLQ-backed delivery replaces the old best-effort gateway bridge.
    OutboxModule.forService({
      targets: ['ORDER', 'NOTIFICATION'],
      // (ePpLHPX2) Bildirishnoma javobi KUTILMAYDI: publisher ketma-ket
      // ishlaydi, notification-service yiqilsa har hodisa timeout'gacha
      // osilib, ortidagi PUL hodisalari (settlement advance) kechikardi.
      // Pul/holat hodisalari bu ro'yxatda YO'Q (ularga yetkazish tasdig'i
      // va qayta urinish kerak).
      options: { fireAndForgetPatterns: ['notification.dispatch'] },
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
    ]),
  ],
  controllers: [FinanceServiceController, SettlementUnappliedController],
  providers: [
    FinanceServiceService,
    FinanceNotificationService,
    SettlementUnappliedService,
  ],
})
export class FinanceServiceModule {}
