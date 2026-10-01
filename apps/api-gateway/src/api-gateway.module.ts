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
import { SearchGatewayController } from './search-gateway.controller';
import { LogisticsGatewayController } from './logistics-gateway.controller';
import { OrderGatewayController } from './order-gateway.controller';
import { FinanceGatewayController } from './finance-gateway.controller';
import { AnalyticsGatewayController } from './analytics-gateway.controller';
import { NotificationGatewayController } from './notification-gateway.controller';
import { IntegrationGatewayController } from './integration-gateway.controller';
import { WebhookGatewayController } from './webhook-gateway.controller';
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
import { AiStatusPoller } from './ai/ai-status.poller';
import type { StringValue } from 'ms';

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
            '15m') as StringValue,
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
    NotificationGatewayController,
    IntegrationGatewayController,
    WebhookGatewayController,
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
    HealthController,
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
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    SelfGuard,
    PartnerApiKeyGuard,
    PartnerThrottlerGuard,
    // ai-parse: foydalanuvchi (JWT sub) bo'yicha alohida 'ai-user' limiti —
    // faqat @UseGuards orqali, global APP_GUARD EMAS.
    UserThrottlerGuard,
    // /health va ai-availability uchun AI holati keshi (30s so'rov, RMQ kutilmaydi).
    AiStatusPoller,
    RealtimeGateway,
    AuditEnrichmentService,
    // Rate limit kaliti soxtalashtirib bo'lmaydigan mijoz IP'si bo'yicha
    // olinadi (audit S3) — standart guard `req.ip` ni ishlatadi, u esa
    // `trust proxy` yoqilganda mijozning o'z `X-Forwarded-For` qiymati bo'lib
    // chiqadi va chegarani aylanib o'tish imkonini beradi.
    { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
    // Default-deny authentication: every HTTP route requires a valid JWT unless
    // explicitly marked @Public() (health, login/refresh, HMAC webhooks, public
    // file view, Partner API which uses its own key guard). (Audit authz P1.)
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class ApiGatewayModule {}
