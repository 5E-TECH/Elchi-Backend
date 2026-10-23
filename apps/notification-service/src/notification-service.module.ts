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
// (ZlpXb4Wh, ega qarori) eski notification-bot.update.ts va order-bot.update.ts
// O'CHIRILDI — o'rniga yagona `bot/` yadrosi (bitta bot, bitta token).
import { BotTransportService } from './bot/bot-transport.service';
import { BotSessionService } from './bot/bot-session.service';
import { BotActionsService } from './bot/bot-actions.service';
import { BotRateLimiterService } from './bot/bot-rate-limiter.service';
import { BotChannelService } from './bot/bot-channel.service';
import { BotOutboxService } from './bot/bot-outbox.service';
import { BotActorService } from './bot/bot-actor.service';
import { BotRouterService } from './bot/bot-router.service';
import { BotRuntimeService } from './bot/bot-runtime.service';
import { BotMaintenanceService } from './bot/bot-maintenance.service';
import { BotController } from './bot/bot.controller';
import { StartHandler } from './bot/handlers/start.handler';
import { GroupHandler } from './bot/handlers/group.handler';
import { MarketHandler } from './bot/handlers/market.handler';
import { MembershipHandler } from './bot/handlers/membership.handler';
import { CommandGateHandler } from './bot/handlers/command-gate.handler';
import { TelegramLinkService } from './bot/telegram-link.service';
import { BotGatewayClient } from './bot/bot-gateway.client';
import { CourierService } from './bot/courier/courier.service';
import { CourierReportScheduler } from './bot/courier/courier-report.scheduler';
import { CourierActions, CourierHandler } from './bot/courier/courier.handler';
import { CourierScanController } from './bot/courier/courier-scan.controller';
import { CourierScanSummaryService } from './bot/courier/courier-scan-summary.service';
import { BOT_ACTION_HANDLERS } from './bot/handlers/bot-context';
import { ExtraCostActions } from './bot/extra-cost/extra-cost.actions';
import { PaymentAckActions } from './bot/finance/payment-ack.actions';
import { DispatchDedupService } from './dedup/dispatch-dedup.service';
import { TelegramOrderCard } from './entities/telegram-order-card.entity';
import { TelegramChat } from './entities/telegram-chat.entity';
import { TelegramAiDraft } from './entities/telegram-ai-draft.entity';
import { AiOrderService } from './bot/ai-order/ai-order.service';
import {
  AiOrderActions,
  AiOrderHandler,
} from './bot/ai-order/ai-order.handler';
import { OrderCardSyncService } from './bot/cards/order-card-sync.service';
import { OrderCardSyncController } from './bot/cards/order-card-sync.controller';
import { TelegramLinkToken } from './entities/telegram-link-token.entity';
import { TelegramSession } from './entities/telegram-session.entity';
import { TelegramBotAction } from './entities/telegram-bot-action.entity';
import { TelegramRateLimit } from './entities/telegram-rate-limit.entity';
import { TelegramOutbox } from './entities/telegram-outbox.entity';
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
// (H7kpCman) kampaniya natijasi hisoboti va CSV eksport (migratsiya 1716000000107).
import { CampaignReportExport } from './campaign/campaign-report-export.entity';
import { CampaignReportController } from './campaign/campaign-report.controller';
import { CampaignReportService } from './campaign/campaign-report.service';
import { AudiencePreviewService } from './audience/audience-preview.service';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationPreferencesService } from './preferences/notification-preferences.service';
import { ChannelPlannerService } from './channels/channel-planner.service';
import { NotificationEscalationService } from './escalation/notification-escalation.service';
// (7Vozou5x) yuborilgan xabarlar tarixi.
import { NotificationDispatch } from './history/notification-dispatch.entity';
import { DispatchHistoryService } from './history/dispatch-history.service';
import { DispatchHistoryController } from './history/dispatch-history.controller';
// (rCFZAmOz) shaxsiy Telegram xabari (users.telegram_id).
import { TelegramDmService } from './telegram/telegram-dm.service';
import { TelegramDmController } from './telegram/telegram-dm.controller';
// (2crjWf7v) DM yetkazish hisoboti (GET /telegram/dm-delivery).
import { TelegramDmDeliveryReportService } from './telegram/telegram-dm-delivery-report.service';
// (C4R3YyvH) bildirishnoma shablonlari (uch til).
import { NotificationTemplate } from './templates/notification-template.entity';
import { NotificationTemplateService } from './templates/notification-template.service';
import { NotificationTemplateController } from './templates/notification-template.controller';
// (ebSV5oyP) saqlangan auditoriya segmentlari.
import { NotificationAudienceSegment } from './audience/audience-segment.entity';
import { AudienceSegmentService } from './audience/audience-segment.service';
import { AudienceSegmentController } from './audience/audience-segment.controller';
// (A1HzKEby) inbox siyosati: bo'ron chegarasi va retention cron'i.
import { InboxPolicyService } from './retention/inbox-policy.service';
import { NotificationRetentionService } from './retention/notification-retention.service';
// (3SeRYFqx) aniq qabul qiluvchi identity'da bormi (yetim qator yo'q).
import { RecipientDirectoryService } from './recipients/recipient-directory.service';

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
    // (DuST9k8j) isbot fayllarini Telegram DM'ga biriktirish (file.read).
    RmqModule.register({ name: 'FILE' }),
    DatabaseModule,
    // SMS navbati va balans monitori cron'lari (3fRbyadQ #4, 8auPBa1O #7),
    // inbox retention (A1HzKEby #3, sukut o'chiq).
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
      // (7Vozou5x) migratsiya 1716000000084.
      NotificationDispatch,
      // (C4R3YyvH) migratsiya 1716000000086.
      NotificationTemplate,
      NotificationAudienceSegment,
      CampaignReportExport,
      // Telegram bot yadrosi (migratsiya 1716000000120).
      TelegramSession,
      TelegramBotAction,
      TelegramRateLimit,
      TelegramOutbox,
      // (6jXw0DDr / 4TfLyTrL) bir martalik bog'lash kodlari (migratsiya 121).
      TelegramLinkToken,
      // (h9newLsd) chatdagi buyurtma kartalari (migratsiya 122).
      TelegramOrderCard,
      // (ysBqD9Nx #5) umumlashtirilgan chat sxemasi (migratsiya 126).
      TelegramChat,
      // (e7KhaeOO) AI buyurtma qoralamalari (migratsiya 128).
      TelegramAiDraft,
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
    CampaignReportController,
    DispatchHistoryController,
    TelegramDmController,
    CourierScanController,
    NotificationTemplateController,
    AudienceSegmentController,
    BotController,
    OrderCardSyncController,
  ],
  providers: [
    NotificationServiceService,
    NotificationInboxService,
    // (rzGKtE9N TC5) qayta yetkazilgan dispatch dedup'i.
    DispatchDedupService,
    // Telegram bot yadrosi (ZlpXb4Wh): transport → router → handlerlar.
    BotTransportService,
    BotSessionService,
    BotActionsService,
    BotRateLimiterService,
    BotChannelService,
    BotOutboxService,
    BotActorService,
    StartHandler,
    GroupHandler,
    MarketHandler,
    MembershipHandler,
    CommandGateHandler,
    TelegramLinkService,
    BotGatewayClient,
    CourierService,
    CourierHandler,
    CourierActions,
    CourierReportScheduler,
    CourierScanSummaryService,
    ExtraCostActions,
    PaymentAckActions,
    OrderCardSyncService,
    AiOrderService,
    AiOrderHandler,
    AiOrderActions,
    {
      provide: BOT_ACTION_HANDLERS,
      useFactory: (
        courier: CourierActions,
        extraCost: ExtraCostActions,
        paymentAck: PaymentAckActions,
        aiOrder: AiOrderActions,
      ) => [
        ...courier.handlers,
        ...extraCost.handlers,
        ...paymentAck.handlers,
        ...aiOrder.handlers,
      ],
      inject: [
        CourierActions,
        ExtraCostActions,
        PaymentAckActions,
        AiOrderActions,
      ],
    },
    BotRouterService,
    BotRuntimeService,
    BotMaintenanceService,
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
    CampaignReportService,
    // (mP1WGG1W / 7Ec56EIw) sozlamalar, kanal rejasi, CRITICAL eskalatsiya.
    NotificationPreferencesService,
    ChannelPlannerService,
    NotificationEscalationService,
    DispatchHistoryService,
    TelegramDmService,
    TelegramDmDeliveryReportService,
    NotificationTemplateService,
    AudienceSegmentService,
    InboxPolicyService,
    NotificationRetentionService,
    RecipientDirectoryService,
  ],
})
export class NotificationServiceModule {}
