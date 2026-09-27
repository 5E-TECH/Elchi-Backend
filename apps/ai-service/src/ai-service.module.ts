import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  AppLoggerModule,
  ClaudeModule,
  DatabaseModule,
  RmqModule,
  aiValidationSchema,
} from '@app/common';
import { AiServiceController } from './ai-service.controller';
import { AiBudgetService } from './budget/ai-budget.service';
import { OrderExtractService } from './order-extract/order-extract.service';
import { ProductDisambiguateService } from './product-disambiguate/product-disambiguate.service';
import { AiUsageModule } from './usage/ai-usage.module';
import { AiUsageService } from './usage/ai-usage.service';

/**
 * ai-service — Anthropic'ni chaqiradigan YAGONA jarayon (ANTHROPIC_API_KEY
 * faqat shu konteynerda). Port 3024, navbat `ai_queue` (id `AI`), sxema
 * `ai_schema`.
 *
 * ⚠️ ConfigModule global — ClaudeModule, RmqModule va DatabaseModule
 * ConfigService'ni global deb hisoblaydi.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: aiValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'ai-service' }),
    RmqModule,
    DatabaseModule,
    AiUsageModule,
    // Xarajat jurnali (sink) va global kunlik shift (budget guard) portlari.
    ClaudeModule.forRoot({
      imports: [AiUsageModule],
      usageSink: AiUsageService,
      budgetGuard: AiBudgetService,
    }),
  ],
  controllers: [AiServiceController],
  providers: [OrderExtractService, ProductDisambiguateService],
})
export class AiServiceModule {}
