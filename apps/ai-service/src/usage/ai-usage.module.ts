import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLogModule, RmqModule } from '@app/common';
import { AiBudgetNotifier } from '../budget/ai-budget.notifier';
import { AiBudgetService } from '../budget/ai-budget.service';
import { AiSpendCounter } from '../entities/ai-spend-counter.entity';
import { AiUsageLog } from '../entities/ai-usage-log.entity';
import { AiMarginService } from './ai-margin.service';
import { AiSpendCounterService } from './ai-spend-counter.service';
import { AiUsageService } from './ai-usage.service';

/**
 * AI xarajat jurnali + global kunlik shift (lYVuADRE, wFSMEIIy).
 *
 * `ClaudeModule.forRoot({ imports: [AiUsageModule], usageSink:
 * AiUsageService, budgetGuard: AiBudgetService })` shu modulni ulaydi.
 *
 * - NOTIFICATION mijozi — shift 80%/100% bildirishnomalari
 *   (RABBITMQ_NOTIFICATION_QUEUE, aiValidationSchema'da required).
 * - ActivityLogModule — "shiftni ko'tarish" auditi `ai_schema.activity_logs`
 *   ga (DB_SCHEMA=ai_schema).
 * - ConfigService global (ai-service `ConfigModule.forRoot({isGlobal:true})`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AiUsageLog, AiSpendCounter]),
    RmqModule.register({ name: 'NOTIFICATION' }),
    ActivityLogModule.forService('ai-service'),
  ],
  providers: [
    AiUsageService,
    AiSpendCounterService,
    AiBudgetService,
    AiBudgetNotifier,
    // NFiXfmq6: "AI xarajat va marja" hisoboti (ai.usage.margin).
    AiMarginService,
  ],
  exports: [
    // BE-5: AdvisorModule audit uchun AYNI ActivityLogModule nusxasini
    // oladi — `forService` ikkinchi marta chaqirilmasin (Nest 11 dinamik
    // modullarni reference bo'yicha ajratadi → ikkinchi retention cron).
    ActivityLogModule,
    AiUsageService,
    AiSpendCounterService,
    AiBudgetService,
    AiMarginService,
  ],
})
export class AiUsageModule {}
