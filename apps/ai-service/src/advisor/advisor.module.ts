import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClaudeModule, RmqModule } from '@app/common';
import { AiBudgetService } from '../budget/ai-budget.service';
import { AiConfigModule } from '../ai-config/ai-config.module';
import { AiRuntimeProvider } from '../ai-config/ai-runtime.provider';
import { AiUsageService } from '../usage/ai-usage.service';
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
import { AdvisorExplainService } from './advisor-explain.service';
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
    // §6 AI izohi: ClaudeService ildiz modulda faqat AiServiceModule'ga
    // eksport qilingan — shu yerda ayni portlar bilan (sarf `ai_usage_log`,
    // umumiy kunlik shift) ulanadi. ClaudeService holatsiz (faqat mijoz).
    // «AI kalit va modellar»: kalit manbai ildiz modul bilan bir xil —
    // AiRuntimeProvider (UI > env > yo'q). AiConfigModule yagona nusxa,
    // ya'ni provayder holati ildiz ClaudeService bilan umumiy. Flag o'chiq
    // (AI_CONFIG_UI_ENABLED=false, sukut) — faqat env kaliti, DB o'qilmaydi.
    ClaudeModule.forRoot({
      imports: [AiUsageModule, AiConfigModule],
      usageSink: AiUsageService,
      budgetGuard: AiBudgetService,
      clientProvider: AiRuntimeProvider,
    }),
  ],
  controllers: [AdvisorController, AdvisorActivityLogController],
  providers: [
    AdvisorSettingsService,
    AdvisorAlertsService,
    AdvisorReader,
    AdvisorEngineService,
    AdvisorExplainService,
    AdvisorNotifier,
    AdvisorRealtime,
    AdvisorScheduler,
  ],
  exports: [AdvisorSettingsService, AdvisorEngineService],
})
export class AdvisorModule {}
