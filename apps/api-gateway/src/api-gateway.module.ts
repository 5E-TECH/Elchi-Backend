import { Module } from '@nestjs/common';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  AppLoggerModule,
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
import { LogistRegionScopeService } from './auth/logist-scope';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { SelfGuard } from './auth/self.guard';
import { PartnerApiKeyGuard } from './auth/partner-api-key.guard';
import { PartnerThrottlerGuard } from './auth/partner-throttler.guard';
import { ClientIpThrottlerGuard } from './auth/client-ip-throttler.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { PartnerGatewayController } from './partner-gateway.controller';
import { PartnerAdminGatewayController } from './partner-admin-gateway.controller';
import { AuthGatewayController } from './auth-gateway.controller';
import { CatalogGatewayController } from './catalog-gateway.controller';
import { HealthController } from './health.controller';
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
import { TelegramIdThrottlerGuard } from './auth/telegram-id-throttler.guard';
import { InvestorGatewayController } from './investor-gateway.controller';
import { BranchGatewayController } from './branch-gateway.controller';
import { FileGatewayController } from './file-gateway.controller';
import { ScanGatewayController } from './scan-gateway.controller';
import { PrinterGatewayController } from './printer-gateway.controller';
import { ExcelGatewayController } from './excel-gateway.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { RealtimeController } from './realtime/realtime.controller';
import { AuditGatewayController } from './audit-gateway.controller';
import { AuditEnrichmentService } from './audit/audit-enrichment.service';
import { AiGatewayController } from './ai-gateway.controller';
import { AiUsageGatewayController } from './ai-usage-gateway.controller';
import { AiAssistantGatewayController } from './ai-assistant-gateway.controller';
import { MarketOperatorGatewayController } from './market-operator-gateway.controller';
import { CustomerGatewayController } from './customer-gateway.controller';
import { DeliveryPricingGatewayController } from './delivery-pricing-gateway.controller';
// mSkzzNBJ: ochiq kalkulyator — POST /public/delivery-quote, GET /public/delivery-tariffs.
import { PublicDeliveryPricingController } from './public-delivery-pricing/public-delivery-pricing.controller';
import { WarehouseGatewayController } from './warehouse-gateway.controller';
import { AiStatusPoller } from './ai/ai-status.poller';
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
        // Global per-IP rate limit (har route o'z hisoblagichi bilan).
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
  ],
  controllers: [
    ApiGatewayController,
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
    InvestorGatewayController,
    BranchGatewayController,
    FileGatewayController,
    ScanGatewayController,
    AnalyticsGatewayController,
    PrinterGatewayController,
    ExcelGatewayController,
    RealtimeController,
    AuditGatewayController,
    PartnerGatewayController,
    PartnerAdminGatewayController,
    AiGatewayController,
    // Celz3rKJ: "Moliyaviy balans → AI xarajat" paneli (/ai-usage/*).
    AiUsageGatewayController,
    // F7PWp6cK — AI moliyaviy yordamchi (SSE).
    AiAssistantGatewayController,
    // i76gGjyq: market o'z operatorlarini boshqaradi (/market-operators).
    MarketOperatorGatewayController,
    // hiqRNhkI: GET /customers/suggest — telefon bo'yicha mijoz taklifi.
    CustomerGatewayController,
    // DAqXPeSy: yetkazish narxi dvigateli (/delivery/quote, /delivery/tariffs,
    // /delivery/pricing-settings) — logistics-service.
    DeliveryPricingGatewayController,
    // mSkzzNBJ: o'sha dvigatelning ochiq (tokensiz) yo'li — /public/delivery-*.
    PublicDeliveryPricingController,
    // hY7uacJu: vaqtinchalik ombor moduli (/warehouses, /market/warehouse-stock,
    // /markets/:id/warehouse-order) — catalog-service.
    WarehouseGatewayController,
    // KwodkKWY: CSP Report-Only kuzatuvi — `POST /csp-report` (log, 204).
    CspReportController,
    HealthController,
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
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    SelfGuard,
    PartnerApiKeyGuard,
    PartnerThrottlerGuard,
    // ai-parse: foydalanuvchi (JWT sub) bo'yicha alohida 'ai-user' limiti —
    // faqat @UseGuards orqali, global APP_GUARD EMAS.
    UserThrottlerGuard,
    TelegramIdThrottlerGuard,
    // /health va ai-availability uchun AI holati keshi (30s so'rov, RMQ kutilmaydi).
    AiStatusPoller,
    // WHMAIqyo #3: ai-parse rasmlari uchun vaqtinchalik saqlov (MinIO, TTL
    // 1 soat); MINIO_* yo'q bo'lsa null — base64 yo'li.
    {
      provide: AI_IMAGE_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => AiImageStore.fromConfig(config),
    },
    RealtimeGateway,
    AuditEnrichmentService,
    // 4BftLLnc — logistning o'z viloyatlari (regions.logist_id = me), qisqa
    // kesh: buyurtmalar, paketlar, kuryerlar va qidiruv doirasi.
    LogistRegionScopeService,
    // Rate limit kaliti soxtalashtirib bo'lmaydigan mijoz IP'si bo'yicha
    // olinadi (audit S3) — standart guard `req.ip` ni ishlatadi, u esa
    // `trust proxy` yoqilganda mijozning o'z `X-Forwarded-For` qiymati bo'lib
    // chiqadi va chegarani aylanib o'tish imkonini beradi.
    { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
    // Default-deny authentication: every HTTP route requires a valid JWT unless
    // explicitly marked @Public() (health, login/refresh, HMAC webhooks, public
    // file view, Partner API which uses its own key guard). (Audit authz P1.)
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // (NDmZMzCP) `pwd_change` claim'li token — faqat parol almashtirish
    // oqimi (`PASSWORD_CHANGE_GATE=on` bo'lganda). JwtAuthGuard'dan KEYIN.
    { provide: APP_GUARD, useClass: PasswordChangeGuard },
  ],
})
export class ApiGatewayModule {}
