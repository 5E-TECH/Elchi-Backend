import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RmqModule } from '@app/common';
import { AiUsageModule } from '../usage/ai-usage.module';
import { AiConfigController } from './ai-config.controller';
import { AiConfigEnv } from './ai-config-env';
import { AiConfigNotifier } from './ai-config.notifier';
import { AiConfigHistoryService } from './ai-config-history.service';
import { AiConfigViewService } from './ai-config-view.service';
import {
  AiConfigAttempt,
  AiProviderKey,
  AiRuntimeSetting,
} from './ai-config.entities';
import { AiKeyEnvelopeService } from './ai-key-envelope.service';
import { AiKeyStoreService } from './ai-key-store.service';
import { AiKeyVerifierService } from './ai-key-verifier.service';

/**
 * «AI kalit va modellar» (be-brief v0.2) — kalit saqlash, tekshirish va
 * `ai.config.*` handler'lari. RMQ: `ai_config_queue` (main.ts).
 */
@Module({
  imports: [
    RmqModule,
    // Inbox xabari (notification.dispatch).
    RmqModule.register({ name: 'NOTIFICATION' }),
    TypeOrmModule.forFeature([
      AiProviderKey,
      AiRuntimeSetting,
      AiConfigAttempt,
    ]),
    // ActivityLogService — AiUsageModule re-export qilgan yagona nusxa.
    AiUsageModule,
  ],
  controllers: [AiConfigController],
  providers: [
    AiConfigEnv,
    AiKeyEnvelopeService,
    AiKeyVerifierService,
    AiKeyStoreService,
    AiConfigViewService,
    AiConfigHistoryService,
    AiConfigNotifier,
  ],
  exports: [
    AiConfigEnv,
    AiKeyStoreService,
    AiConfigViewService,
    AiConfigNotifier,
  ],
})
export class AiConfigModule {}
