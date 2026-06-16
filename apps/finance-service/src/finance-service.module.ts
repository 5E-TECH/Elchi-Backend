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
    DatabaseModule,
    // Transactional outbox: finance publishes `order.settlement.advance` to
    // order-service inside the cashbox-move transaction (Faza 2a). Reliable,
    // retried, DLQ-backed delivery replaces the old best-effort gateway bridge.
    OutboxModule.forService({ targets: ['ORDER'] }),
    ActivityLogModule.forService('finance-service'),
    TypeOrmModule.forFeature([
      Cashbox,
      CashboxHistory,
      Shift,
      UserSalary,
      OperatorEarning,
      OperatorPayment,
      FinancialBalanceHistory,
    ]),
  ],
  controllers: [FinanceServiceController],
  providers: [FinanceServiceService],
})
export class FinanceServiceModule {}
