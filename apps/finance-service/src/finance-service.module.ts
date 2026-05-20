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
} from '@app/common';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift } from './entities/shift.entity';
import { UserSalary } from './entities/user-salary.entity';

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
    ActivityLogModule.forService('finance-service'),
    TypeOrmModule.forFeature([Cashbox, CashboxHistory, Shift, UserSalary]),
  ],
  controllers: [FinanceServiceController],
  providers: [FinanceServiceService],
})
export class FinanceServiceModule {}
