import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InvestorServiceController } from './investor-service.controller';
import { InvestorServiceService } from './investor-service.service';
import { AppLoggerModule, RmqModule, DatabaseModule, ActivityLogModule, investorValidationSchema } from '@app/common';
import { Investor } from './entities/investor.entity';
import { Investment } from './entities/investment.entity';
import { ProfitShare } from './entities/profit-share.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: investorValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'investor-service' }),
    RmqModule,
    DatabaseModule,
    ActivityLogModule.forService('investor-service'),
    TypeOrmModule.forFeature([Investor, Investment, ProfitShare]),
  ],
  controllers: [InvestorServiceController],
  providers: [InvestorServiceService],
})
export class InvestorServiceModule {}
