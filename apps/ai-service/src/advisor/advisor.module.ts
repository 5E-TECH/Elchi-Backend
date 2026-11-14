import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RmqModule } from '@app/common';
import { AiUsageModule } from '../usage/ai-usage.module';
import { AdvisorController } from './advisor.controller';
import {
  AiAdvisorAlert,
  AiAdvisorAlertOccurrence,
  AiAdvisorRuleState,
  AiAdvisorSetting,
} from './advisor.entities';
import { AdvisorAlertsService } from './advisor-alerts.service';
import { AdvisorActivityLogController } from './advisor-activity-log.controller';
import { AdvisorEngineService } from './advisor-engine.service';
import { AdvisorNotifier } from './advisor-notify';
import { AdvisorRealtime } from './advisor-realtime';
import { AdvisorReader } from './advisor-reader';
import { AdvisorScheduler } from './advisor.scheduler';
import { AdvisorSettingsService } from './advisor-settings.service';

/**
 * BE-5 (LhTIno57) — AI maslahatchi: ogohlantirishlar R1–R8. Yangi kod shu
 * papkada (ai-service'ning boshqa qismlariga minimal tegish).
 */
@Module({
  imports: [
    RmqModule,
    TypeOrmModule.forFeature([
      AiAdvisorAlert,
      AiAdvisorAlertOccurrence,
      AiAdvisorSetting,
      AiAdvisorRuleState,
    ]),
    // AdvisorReader — FAQAT `finance.advisor.rule_inputs` (o'qish).
    RmqModule.register({ name: 'FINANCE' }),
    // §9: faol superadminlar (`identity.audience.resolve`) va dispatch;
    // §12: `realtime.notify` (emit, javobsiz).
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'NOTIFICATION' }),
    RmqModule.register({ name: 'GATEWAY' }),
    // ActivityLogService — AiUsageModule re-export qilgan YAGONA
    // ActivityLogModule nusxasidan (forService bu yerda chaqirilmaydi).
    AiUsageModule,
  ],
  controllers: [AdvisorController, AdvisorActivityLogController],
  providers: [
    AdvisorSettingsService,
    AdvisorAlertsService,
    AdvisorReader,
    AdvisorEngineService,
    AdvisorNotifier,
    AdvisorRealtime,
    AdvisorScheduler,
  ],
  exports: [AdvisorSettingsService, AdvisorEngineService],
})
export class AdvisorModule {}
