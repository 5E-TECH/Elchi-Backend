import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationServiceController } from './integration-service.controller';
import { IntegrationServiceService } from './integration-service.service';
import {
  AppLoggerModule,
  RmqModule,
  DatabaseModule,
  integrationValidationSchema,
  ActivityLogModule,
} from '@app/common';
import { ExternalIntegration } from './entities/external-integration.entity';
import { SyncQueue } from './entities/sync-queue.entity';
import { SyncHistory } from './entities/sync-history.entity';
import { ProviderWebhookLog } from './entities/provider-webhook-log.entity';
import { ProviderShipment } from './entities/provider-shipment.entity';
import { ProviderReceivable } from './entities/provider-receivable.entity';
import { ProviderRemittance } from './entities/provider-remittance.entity';
import { SyncQueueScheduler } from './sync-queue.scheduler';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: integrationValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'integration-service' }),
    RmqModule,
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'CATALOG' }),
    RmqModule.register({ name: 'ORDER' }),
    RmqModule.register({ name: 'NOTIFICATION' }),
    DatabaseModule,
    ScheduleModule.forRoot(),
    ActivityLogModule.forService('integration-service'),
    TypeOrmModule.forFeature([
      ExternalIntegration,
      SyncQueue,
      SyncHistory,
      ProviderWebhookLog,
      ProviderShipment,
      ProviderReceivable,
      ProviderRemittance,
    ]),
  ],
  controllers: [IntegrationServiceController],
  providers: [IntegrationServiceService, SyncQueueScheduler],
})
export class IntegrationServiceModule {}
