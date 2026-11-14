import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RmqModule } from '@app/common';
import { AiUsageModule } from '../usage/ai-usage.module';
import { AdvisorController } from './advisor.controller';
import {
  AiAdvisorAlert,
  AiAdvisorAlertOccurrence,
  AiAdvisorSetting,
} from './advisor.entities';
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
    ]),
    // ActivityLogService — AiUsageModule re-export qilgan YAGONA
    // ActivityLogModule nusxasidan (forService bu yerda chaqirilmaydi).
    AiUsageModule,
  ],
  controllers: [AdvisorController],
  providers: [AdvisorSettingsService],
  exports: [AdvisorSettingsService],
})
export class AdvisorModule {}
