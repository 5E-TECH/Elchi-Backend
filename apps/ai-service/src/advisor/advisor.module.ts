import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLogModule, RmqModule } from '@app/common';
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
    // Ayni argument — Nest AiUsageModule'dagi bilan bitta modul nusxasini
    // ishlatadi (ikkinchi retention scheduler yo'q).
    ActivityLogModule.forService('ai-service'),
  ],
  controllers: [AdvisorController],
  providers: [AdvisorSettingsService],
  exports: [AdvisorSettingsService],
})
export class AdvisorModule {}
