import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExternalIntegration } from './entities/external-integration.entity';
import { SyncQueue } from './entities/sync-queue.entity';
import { SyncHistory } from './entities/sync-history.entity';

@Injectable()
export class IntegrationServiceService {
  constructor(
    @InjectRepository(ExternalIntegration) private readonly integrationRepo: Repository<ExternalIntegration>,
    @InjectRepository(SyncQueue) private readonly syncQueueRepo: Repository<SyncQueue>,
    @InjectRepository(SyncHistory) private readonly syncHistoryRepo: Repository<SyncHistory>,
  ) {}

  // TODO: ExternalIntegration CRUD
  // TODO: SyncQueue processing logic
  // TODO: SyncHistory recording
  // TODO: Retry mechanism
}
