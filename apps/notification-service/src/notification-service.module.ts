import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationServiceController } from './notification-service.controller';
import { NotificationServiceService } from './notification-service.service';
import {
  AppLoggerModule,
  RmqModule,
  DatabaseModule,
  notificationValidationSchema,
  ActivityLogModule,
  OutboxModule,
} from '@app/common';
import { TelegramMarket } from './entities/telegram-market.entity';
import { Notification } from './entities/notification.entity';
import { PushSubscription } from './entities/push-subscription.entity';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationBotUpdateService } from './notification-bot.update';
import { OrderBotUpdateService } from './order-bot.update';
import { WebPushService } from './push/web-push.service';
import { PushSubscriptionService } from './push/push-subscription.service';
import { PushDeliveryService } from './push/push-delivery.service';
import { SmsOutbox } from './entities/sms-outbox.entity';
import { SmsProviderAccount } from './entities/sms-provider-account.entity';
import { SmsTemplate } from './entities/sms-template.entity';
import { CustomerConsent } from './entities/customer-consent.entity';
import { SmsCampaign } from './entities/sms-campaign.entity';
import { SmsController } from './sms/sms.controller';
import { SmsConfigService } from './sms/sms-config.service';
import { SmsGateService } from './sms/sms-gate.service';
import { SmsConsentService } from './sms/sms-consent.service';
import { SmsOutboxService } from './sms/sms-outbox.service';
import { SmsProviderAccountsService } from './sms/sms-provider-accounts.service';
import { SmsProviderRegistry } from './sms/sms-provider.registry';
import { SmsOutboxScheduler } from './sms/sms-outbox.scheduler';
import { SmsTemplateService } from './sms/sms-template.service';
import { SmsDispatchService } from './sms/sms-dispatch.service';
import { SmsCampaignService } from './sms/sms-campaign.service';
import { SmsDlrService } from './sms/sms-dlr.service';
import { SmsBalanceMonitor } from './sms/sms-balance.monitor';
import { SmsOtpService } from './sms/sms-otp.service';
// (W8aerwL6 / xHPdpj0W) auditoriya ko'rinishi va kampaniya navbati.
import { NotificationCampaign } from './campaign/notification-campaign.entity';
import { CampaignController } from './campaign/campaign.controller';
import { CampaignService } from './campaign/campaign.service';
import { AudiencePreviewService } from './audience/audience-preview.service';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationPreferencesService } from './preferences/notification-preferences.service';
import { ChannelPlannerService } from './channels/channel-planner.service';
import { NotificationEscalationService } from './escalation/notification-escalation.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: notificationValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'notification-service' }),
    RmqModule,
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'ORDER' }),
    // Realtime push: emits `realtime.notify` to the gateway's RMQ queue so
    // connected socket.io clients receive new notifications live.
    RmqModule.register({ name: 'GATEWAY' }),
    // Web push yetkazish: outbox o'z navbatimizga `notification.push.deliver`
    // yuboradi (dispatch javobni kutmaydi, qayta urinish/backoff outbox'da).
    RmqModule.register({ name: 'NOTIFICATION' }),
    DatabaseModule,
    // SMS navbati va balans monitori cron'lari (3fRbyadQ #4, 8auPBa1O #7).
    ScheduleModule.forRoot(),
    ActivityLogModule.forService('notification-service'),
    TypeOrmModule.forFeature([
      TelegramMarket,
      Notification,
      PushSubscription,
      SmsOutbox,
      SmsProviderAccount,
      SmsTemplate,
      CustomerConsent,
      SmsCampaign,
      NotificationCampaign,
      // (mP1WGG1W) foydalanuvchi sozlamalari (migratsiya 1716000000075).
      NotificationPreference,
    ]),
    // Push yetkazish bir partiyada 100 tagacha bildirishnomani parallel
    // yuboradi — 5 s lik standart javob muddati qisqa: muddat o'tsa outbox
    // qayta urinardi. Qayta urinish xavfsiz (deliver idempotent), lekin keraksiz.
    OutboxModule.forService({
      targets: ['NOTIFICATION'],
      options: { publishTimeoutMs: 20_000 },
    }),
  ],
  controllers: [
    NotificationServiceController,
    SmsController,
    CampaignController,
  ],
  providers: [
    NotificationServiceService,
    NotificationInboxService,
    NotificationBotUpdateService,
    OrderBotUpdateService,
    WebPushService,
    PushSubscriptionService,
    PushDeliveryService,
    SmsConfigService,
    SmsGateService,
    SmsConsentService,
    SmsOutboxService,
    SmsProviderAccountsService,
    SmsProviderRegistry,
    SmsOutboxScheduler,
    SmsTemplateService,
    SmsDispatchService,
    SmsCampaignService,
    SmsDlrService,
    SmsBalanceMonitor,
    SmsOtpService,
    AudiencePreviewService,
    CampaignService,
    // (mP1WGG1W / 7Ec56EIw) sozlamalar, kanal rejasi, CRITICAL eskalatsiya.
    NotificationPreferencesService,
    ChannelPlannerService,
    NotificationEscalationService,
  ],
})
export class NotificationServiceModule {}
