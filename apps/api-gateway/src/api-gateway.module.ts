import { Module } from '@nestjs/common';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  AppLoggerModule,
  BusinessDayModule,
  RmqModule,
  gatewayValidationSchema,
} from '@app/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { JwtStrategy } from './auth/jwt.strategy';
import { PasswordChangeGuard } from './auth/password-change.guard';
import { SessionRevocationService } from './auth/session-revocation.service';
import { TelegramTokenStateService } from './auth/telegram-token-state.service';
import { TelegramScanScopeGuard } from './auth/telegram-scan-scope.guard';
import { LogistRegionScopeService } from './auth/logist-scope';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { SelfGuard } from './auth/self.guard';
import { PartnerApiKeyGuard } from './auth/partner-api-key.guard';
import { PartnerThrottlerGuard } from './auth/partner-throttler.guard';
import { GlobalThrottlerGuard } from './auth/global-throttler.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { PartnerGatewayController } from './partner-gateway.controller';
import { PartnerAdminGatewayController } from './partner-admin-gateway.controller';
import { CarrierApiKeyGuard } from './auth/carrier-api-key.guard';
import { CarrierThrottlerGuard } from './auth/carrier-throttler.guard';
import { CarrierGatewayController } from './carrier-gateway.controller';
import { CarrierAdminGatewayController } from './carrier-admin-gateway.controller';
import { CarrierAuthGatewayController } from './carrier-auth-gateway.controller';
import { CarrierTokenService } from './auth/carrier-token.service';
import { AuthGatewayController } from './auth-gateway.controller';
import { CatalogGatewayController } from './catalog-gateway.controller';
import { HealthController } from './health.controller';
import { NotificationBotHealthController } from './notification-bot-health.controller';
import { ClientErrorGatewayController } from './client-error-gateway.controller';
import { SearchGatewayController } from './search-gateway.controller';
import { LogisticsGatewayController } from './logistics-gateway.controller';
import { OrderGatewayController } from './order-gateway.controller';
import { FinanceGatewayController } from './finance-gateway.controller';
import { AnalyticsGatewayController } from './analytics-gateway.controller';
import { NotificationGatewayController } from './notification-gateway.controller';
import { NotificationCampaignGatewayController } from './notification-campaign-gateway.controller';
import {
  SmsGatewayController,
  SmsPublicGatewayController,
} from './sms-gateway.controller';
import { IntegrationGatewayController } from './integration-gateway.controller';
import { WebhookGatewayController } from './webhook-gateway.controller';
// (uCrzrElu) Telegram bot webhook'i — secret_token bilan, RMQ'ga o'tkazgich.
import { TelegramWebhookController } from './telegram-webhook.controller';
// (6jXw0DDr / 9uNhwTZp) Telegram bog'lash kodlari va statistikasi.
import { TelegramGatewayController } from './telegram-gateway.controller';
import { BranchTelegramGatewayController } from './branch-telegram-gateway.controller';
import { TelegramIdThrottlerGuard } from './auth/telegram-id-throttler.guard';
import { InvestorGatewayController } from './investor-gateway.controller';
import { BranchGatewayController } from './branch-gateway.controller';
import { FileGatewayController } from './file-gateway.controller';
import { ScanGatewayController } from './scan-gateway.controller';
import { PrinterGatewayController } from './printer-gateway.controller';
import { ExcelGatewayController } from './excel-gateway.controller';
import { OldMailsExportController } from './old-mails-export.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { RealtimeController } from './realtime/realtime.controller';
import { PresenceActivityPublisher } from './realtime/presence-activity.publisher';
import { AuditGatewayController } from './audit-gateway.controller';
import { AuditEnrichmentService } from './audit/audit-enrichment.service';
import { AiGatewayController } from './ai-gateway.controller';
import { AiUsageGatewayController } from './ai-usage-gateway.controller';
import { AiAssistantGatewayController } from './ai-assistant-gateway.controller';
import { AiAdvisorGatewayController } from './ai-advisor-gateway.controller';
import { MarketOperatorGatewayController } from './market-operator-gateway.controller';
import { MarketOperatorOrdersGatewayController } from './market-operator-orders-gateway.controller';
import { CustomerGatewayController } from './customer-gateway.controller';
import { DeliveryPricingGatewayController } from './delivery-pricing-gateway.controller';
import { PickupVisitGatewayController } from './pickup-visit-gateway.controller';
import { OperatorPaymentGatewayController } from './operator-payment-gateway.controller';
import { OperatorEarningBackfillGatewayController } from './operator-earning-backfill-gateway.controller';
// mSkzzNBJ: ochiq kalkulyator — POST /public/delivery-quote, GET /public/delivery-tariffs.
import { PublicDeliveryPricingController } from './public-delivery-pricing/public-delivery-pricing.controller';
import { WarehouseGatewayController } from './warehouse-gateway.controller';
// T7 (QPq2C1co) aloqa raqamlari: /settings/contacts, market mas'ullari, /users/me/contacts.
import { ContactsGatewayController } from './contacts-gateway.controller';
import { ProblemContactsService } from './contacts/problem-contacts.service';
import { AiStatusPoller } from './ai/ai-status.poller';
import { AiConfigGatewayController } from './ai-config-gateway.controller';
import { AiConfigKeyThrottlerGuard } from './auth/ai-config-key-throttler.guard';
// (KwodkKWY) POST /csp-report — brauzer CSP buzilish hisobotlari (@Public).
import { CspReportController } from './csp-report/csp-report.controller';
import type { StringValue } from 'ms';
import { AI_IMAGE_STORE, AiImageStore } from '@app/common/ai/ai-image-store';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: gatewayValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'api-gateway' }),
    // xhiXv3w3 — ish kuni jadvali (kun almashish soati), bazasiz: order-service
    // `order.intake.state` orqali daqiqada bir.
    BusinessDayModule.forRoot({ source: { rmqClient: 'ORDER' } }),
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('ACCESS_TOKEN_KEY'),
        signOptions: {
          expiresIn: (configService.get<string>('ACCESS_TOKEN_TIME') ??
            '1h') as StringValue,
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        // Global rate limit (har route o'z hisoblagichi bilan): kirgan
        // foydalanuvchi — JWT `sub`, qolganlari — IP (GlobalThrottlerGuard).
        // Auth endpointlari @Throttle({ default: { ... } }) bilan o'z
        // qiymatini oladi: login — AUTH_THROTTLE_LIMIT (sukut 30/min),
        // refresh — AUTH_REFRESH_THROTTLE_LIMIT (sukut 60/min) (fix3 C10).
        // Health endpoints are exempted via @SkipThrottle().
        throttlers: [
          {
            name: 'default',
            ttl: configService.get<number>('THROTTLE_TTL_MS', 60_000),
            limit: configService.get<number>('THROTTLE_LIMIT', 60),
          },
        ],
      }),
    }),
    // Core services
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'ORDER' }),
    RmqModule.register({ name: 'CATALOG' }),
    RmqModule.register({ name: 'LOGISTICS' }),
    RmqModule.register({ name: 'FINANCE' }),
    RmqModule.register({ name: 'NOTIFICATION' }),
    // (BOT-3a) Telegram webhook update'lari — alohida bot navbati.
    RmqModule.register({ name: 'NOTIFICATION_BOT' }),
    RmqModule.register({ name: 'INTEGRATION' }),
    RmqModule.register({ name: 'ANALYTICS' }),
    // New services
    RmqModule.register({ name: 'BRANCH' }),
    RmqModule.register({ name: 'INVESTOR' }),
    RmqModule.register({ name: 'FILE' }),
    RmqModule.register({ name: 'C2C' }),
    RmqModule.register({ name: 'SEARCH' }),
    // AI buyurtma (ai-service): ai-parse/ai-confirm, /ai/* admin va /health
    // holati. Navbat nomi RABBITMQ_AI_QUEUE (sukut 'ai_queue').
    RmqModule.register({ name: 'AI' }),
    // «AI kalit va modellar»: `ai_config_queue` (DLX'siz, saqlanmaydi, TTL
    // 8 s; RABBITMQ_AI_CONFIG_QUEUE, sukut 'ai_config_queue'). ai.config.*
    // va ai.status shu navbat orqali.
    RmqModule.register({ name: 'AI_CONFIG' }),
    // (AI ack B1) ai-service TEZ navbati (RABBITMQ_AI_FAST_QUEUE, sukut
    // 'ai_fast_queue'): ai-confirm yo'lidagi arzon DB amallari
    // (confirm_context, attach_preview, link_orders) Claude chaqiruvlari
    // ortida kutmasin.
    RmqModule.register({ name: 'AI_FAST' }),
  ],
  controllers: [
    ApiGatewayController,
    ContactsGatewayController,
    AuthGatewayController,
    CatalogGatewayController,
    OrderGatewayController,
    LogisticsGatewayController,
    SearchGatewayController,
    FinanceGatewayController,
    // (W8aerwL6/xHPdpj0W) `notifications/campaigns` — `notifications/:id` dan OLDIN.
    NotificationCampaignGatewayController,
    NotificationGatewayController,
    SmsGatewayController,
    SmsPublicGatewayController,
    IntegrationGatewayController,
    WebhookGatewayController,
    TelegramWebhookController,
    TelegramGatewayController,
    BranchTelegramGatewayController,
    InvestorGatewayController,
    BranchGatewayController,
    FileGatewayController,
    ScanGatewayController,
    AnalyticsGatewayController,
    PrinterGatewayController,
    ExcelGatewayController,
    OldMailsExportController,
    RealtimeController,
    AuditGatewayController,
    PartnerGatewayController,
    PartnerAdminGatewayController,
    // Carrier API — tashqi yetkazuvchi = bitta kurier (X-Api-Key, /carrier/*).
    CarrierGatewayController,
    CarrierAdminGatewayController,
    // Olcha uslubidagi kirish: POST /carrier/auth/token (JWT, ega 2026-11-27).
    CarrierAuthGatewayController,
    AiGatewayController,
    // «AI kalit va modellar» — /ai/config* (faqat superadmin).
    AiConfigGatewayController,
    // Celz3rKJ: "Moliyaviy balans → AI xarajat" paneli (/ai-usage/*).
    AiUsageGatewayController,
    // F7PWp6cK — AI moliyaviy yordamchi (SSE).
    AiAssistantGatewayController,
    // BE-5 LhTIno57 — AI maslahatchi: ogohlantirishlar R1–R8 (superadmin).
    AiAdvisorGatewayController,
    // i76gGjyq: market o'z operatorlarini boshqaradi (/market-operators).
    MarketOperatorGatewayController,
    MarketOperatorOrdersGatewayController,
    // hiqRNhkI: GET /customers/suggest — telefon bo'yicha mijoz taklifi.
    CustomerGatewayController,
    // DAqXPeSy: yetkazish narxi dvigateli (/delivery/quote, /delivery/tariffs,
    // /delivery/pricing-settings) — logistics-service.
    DeliveryPricingGatewayController,
    PickupVisitGatewayController,
    // F2qp6FtE — market o'z operatoriga to'lov yozuvi (Elchi kassasiz).
    OperatorPaymentGatewayController,
    OperatorEarningBackfillGatewayController,
    // mSkzzNBJ: o'sha dvigatelning ochiq (tokensiz) yo'li — /public/delivery-*.
    PublicDeliveryPricingController,
    // hY7uacJu: vaqtinchalik ombor moduli (/warehouses, /market/warehouse-stock,
    // /markets/:id/warehouse-order) — catalog-service.
    WarehouseGatewayController,
    // KwodkKWY: CSP Report-Only kuzatuvi — `POST /csp-report` (log, 204).
    CspReportController,
    HealthController,
    // BOT-DIAG-BE: /health/notification-bot (+ /recheck) — faqat superadmin.
    NotificationBotHealthController,
    // QKCeGZ3N — frontend xato chegarasi hisobotlari (jurnalga, bazaga emas).
    ClientErrorGatewayController,
    // TODO: Qolgan gateway controllerlarni qo'shish
    // FinanceGatewayController,
    // NotificationGatewayController,
    // IntegrationGatewayController,
    // AnalyticsGatewayController,
    // BranchGatewayController,
    // InvestorGatewayController,
    // FileGatewayController,
    // C2cGatewayController,
  ],
  providers: [
    ApiGatewayService,
    // (Elchi Pochta #3) yopilgan sessiya tokenini darhol rad etish keshi —
    // JwtStrategy va auth revoke/logout endpointlari ishlatadi.
    SessionRevocationService,
    TelegramTokenStateService,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    SelfGuard,
    PartnerApiKeyGuard,
    PartnerThrottlerGuard,
    CarrierApiKeyGuard,
    CarrierThrottlerGuard,
    // Carrier JWT (`/carrier/auth/token`) — alohida kalit bilan imzolanadi.
    CarrierTokenService,
    // ai-parse: foydalanuvchi (JWT sub) bo'yicha alohida 'ai-user' limiti —
    // faqat @UseGuards orqali, global APP_GUARD EMAS.
    UserThrottlerGuard,
    TelegramIdThrottlerGuard,
    // /health va ai-availability uchun AI holati keshi (30s so'rov, RMQ kutilmaydi).
    AiStatusPoller,
    AiConfigKeyThrottlerGuard,
    // WHMAIqyo #3: ai-parse rasmlari uchun vaqtinchalik saqlov (MinIO, TTL
    // 1 soat); MINIO_* yo'q bo'lsa null — base64 yo'li.
    {
      provide: AI_IMAGE_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => AiImageStore.fromConfig(config),
    },
    RealtimeGateway,
    // (pe71yf8L) socket online/offline → identity `user_activity.last_seen_at`.
    PresenceActivityPublisher,
    AuditEnrichmentService,
    // 4BftLLnc — logistning o'z viloyatlari (regions.logist_id = me), qisqa
    // kesh: buyurtmalar, paketlar, kuryerlar va qidiruv doirasi.
    LogistRegionScopeService,
    ProblemContactsService,
    // Rate limit kaliti: kirgan foydalanuvchi — JWT `sub` (bitta NAT/CGNAT
    // ortidagi operatorlar bitta limitni bo'lishmasin); anonim, login va
    // public route'lar — soxtalashtirib bo'lmaydigan mijoz IP'si (audit S3:
    // standart guard `req.ip` ni ishlatadi, u esa `trust proxy` yoqilganda
    // mijozning o'z `X-Forwarded-For` qiymati bo'lib chiqadi).
    // JwtAuthGuard'dan OLDIN — token imzosini o'zi tekshiradi.
    { provide: APP_GUARD, useClass: GlobalThrottlerGuard },
    // Default-deny authentication: every HTTP route requires a valid JWT unless
    // explicitly marked @Public() (health, login/refresh, HMAC webhooks, public
    // file view, Partner API which uses its own key guard). (Audit authz P1.)
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // (NDmZMzCP) `pwd_change` claim'li token — faqat parol almashtirish
    // oqimi (`PASSWORD_CHANGE_GATE=on` bo'lganda). JwtAuthGuard'dan KEYIN.
    { provide: APP_GUARD, useClass: PasswordChangeGuard },
    // (BOT-2 #2b) `scope: 'tg_scan'` (Telegram Mini App) tokeni — faqat skan
    // oqimi. JwtAuthGuard'dan KEYIN.
    { provide: APP_GUARD, useClass: TelegramScanScopeGuard },
  ],
})
export class ApiGatewayModule {}
