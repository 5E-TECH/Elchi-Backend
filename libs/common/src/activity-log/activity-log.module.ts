import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLog } from './activity-log.entity';
import { ActivityLogService } from './activity-log.service';
import { ActivityLogMaintenanceService } from './activity-log-maintenance.service';
import { ActivityLogRetentionScheduler } from './activity-log-retention.scheduler';
import { ACTIVITY_LOG_SERVICE_NAME } from './types';

@Module({})
export class ActivityLogModule {
  /**
   * Wire the activity-log entity + service into a microservice.
   * `serviceName` is stored on every row so a centralized audit dashboard
   * can tell which service produced an event (order/finance/identity/...).
   */
  static forService(serviceName?: string): DynamicModule {
    return {
      module: ActivityLogModule,
      imports: [TypeOrmModule.forFeature([ActivityLog])],
      providers: [
        {
          provide: ACTIVITY_LOG_SERVICE_NAME,
          useValue: serviceName ?? null,
        },
        ActivityLogService,
        // i6Nyedea — saqlash muddati (dry-run sukut) va login birlashtirish;
        // har servisda o'z vaqtidagi kunlik cron.
        ActivityLogMaintenanceService,
        ActivityLogRetentionScheduler,
      ],
      exports: [
        ActivityLogService,
        ActivityLogMaintenanceService,
        TypeOrmModule,
      ],
    };
  }
}
