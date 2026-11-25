import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnalyticsServiceController } from './analytics-service.controller';
import { AnalyticsServiceService } from './analytics-service.service';
import {
  AppLoggerModule,
  BusinessDayModule,
  RmqModule,
  analyticsValidationSchema,
} from '@app/common';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: analyticsValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'analytics-service' }),
    // xhiXv3w3 — ish kuni jadvali (kun almashish soati), bazasiz: order-service
    // `order.intake.state` orqali daqiqada bir.
    BusinessDayModule.forRoot({ source: { rmqClient: 'ORDER' } }),
    RmqModule,
    RmqModule.register({ name: 'ORDER' }),
    RmqModule.register({ name: 'FINANCE' }),
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'BRANCH' }),
    // Note: Analytics service may connect to read-replica or other data sources
    // DatabaseModule can be added when needed
  ],
  controllers: [AnalyticsServiceController],
  providers: [AnalyticsServiceService],
})
export class AnalyticsServiceModule {}
