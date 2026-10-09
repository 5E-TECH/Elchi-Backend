import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LogisticsServiceController } from './logistics-service.controller';
import { LogisticsServiceService } from './logistics-service.service';
import {
  AppLoggerModule,
  RmqModule,
  DatabaseModule,
  logisticsValidationSchema,
  ActivityLogModule,
  OutboxModule,
} from '@app/common';
import { Post } from './entities/post.entity';
import { Region } from './entities/region.entity';
import { District } from './entities/district.entity';
import { DistrictResolverService } from './district-resolver/district-resolver.service';
import { LogisticsNotificationService } from './notification/logistics-notification.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: logisticsValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'logistics-service' }),
    RmqModule,
    RmqModule.register({ name: 'ORDER' }),
    RmqModule.register({ name: 'BRANCH' }),
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'SEARCH' }),
    // (ePpLHPX2) Pochta filialga keldi → bildirishnoma. FAQAT outbox maqsadi
    // sifatida (LogisticsNotificationService) — to'g'ridan-to'g'ri rmqSend
    // TAQIQ (pochta yozuvi rollback bo'lsa ham xabar ketardi).
    RmqModule.register({ name: 'NOTIFICATION' }),
    DatabaseModule,
    // (ePpLHPX2) Transactional outbox — `logistics_schema.outbox_events`
    // (migrations/1716000000064). Bildirishnoma javobi KUTILMAYDI
    // (fire-and-forget): notification-service yiqilsa publisher osilmaydi.
    OutboxModule.forService({
      targets: ['NOTIFICATION'],
      options: { fireAndForgetPatterns: ['notification.dispatch'] },
    }),
    TypeOrmModule.forFeature([Post, Region, District]),
    ActivityLogModule.forService('logistics-service'),
  ],
  controllers: [LogisticsServiceController],
  providers: [
    LogisticsServiceService,
    DistrictResolverService,
    LogisticsNotificationService,
  ],
})
export class LogisticsServiceModule {}
