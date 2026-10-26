import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AppLoggerModule,
  ClaudeModule,
  DatabaseModule,
  RmqModule,
  aiValidationSchema,
} from '@app/common';
import { AiServiceController } from './ai-service.controller';
import { AiBudgetService } from './budget/ai-budget.service';
import { AiDraftService } from './draft/ai-draft.service';
import { DistrictPickService } from './district-pick/district-pick.service';
import { BalanceScreenshotService } from './balance-screenshot/balance-screenshot.service';
import {
  AiOrderDraft,
  AiOrderDraftItem,
} from './entities/ai-order-draft.entity';
import { AI_IMAGE_STORE, AiImageStore } from '@app/common/ai/ai-image-store';
import { AiImageSweeper } from './order-extract/ai-image-sweeper';
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
    // vncdmXOy: AI buyurtma audit izi (ai_order_draft, ai_order_draft_item).
    TypeOrmModule.forFeature([AiOrderDraft, AiOrderDraftItem]),
    // Xarajat jurnali (sink) va global kunlik shift (budget guard) portlari.
    ClaudeModule.forRoot({
      imports: [AiUsageModule],
      usageSink: AiUsageService,
      budgetGuard: AiBudgetService,
    }),
  ],
  controllers: [AiServiceController],
  providers: [
    OrderExtractService,
    ProductDisambiguateService,
    AiDraftService,
    DistrictPickService,
    // kiZgTybn — smena yopishda karta qoldig'i skrinshoti.
    BalanceScreenshotService,
    // WHMAIqyo #3: ai-parse rasmlari vaqtinchalik saqlovi (MinIO, TTL 1 soat)
    // va uning tozalovchisi. MINIO_* yo'q bo'lsa null — base64 yo'li.
    {
      provide: AI_IMAGE_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => AiImageStore.fromConfig(config),
    },
    AiImageSweeper,
  ],
})
export class AiServiceModule {}
