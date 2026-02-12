import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationServiceController } from './integration-service.controller';
import { IntegrationServiceService } from './integration-service.service';
import { RmqModule, DatabaseModule, integrationValidationSchema } from '@app/common';
import { ExternalIntegration } from './entities/external-integration.entity';
import { SyncQueue } from './entities/sync-queue.entity';
import { SyncHistory } from './entities/sync-history.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: integrationValidationSchema,
    }),
    RmqModule,
    DatabaseModule,
    TypeOrmModule.forFeature([ExternalIntegration, SyncQueue, SyncHistory]),
  ],
  controllers: [IntegrationServiceController],
  providers: [IntegrationServiceService],
})
export class IntegrationServiceModule {}
